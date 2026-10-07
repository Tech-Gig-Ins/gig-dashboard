// Located at: lib/responseCache.ts
//
// Caches the JSON a route returns, keyed by a fingerprint of the S3 objects it
// is built from. Before computing, the route lists its input prefixes (keys and
// ETags only, no downloads). If that exact set of inputs was seen before, the
// saved response is returned; any changed, added or removed input produces a
// new fingerprint, so a stale response can never be served.
//
// Layers: server memory (always) and S3 under cache/responses/<name>/<version>/
// (only when persist is true). Only successful (200) responses are cached.
// The caller checks access before calling this, every time.
//
// Bump a route's `version` whenever its parsing or calculation code changes,
// so responses saved by the old code are ignored.

import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { gzipSync, gunzipSync } from 'zlib';
import { createHash } from 'crypto';

const BUCKET = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';
const s3 = new S3Client({
  region: process.env.MY_AWS_REGION || 'us-east-1',
  // The website passes its access keys; a Lambda would use its own role.
  credentials: process.env.MY_AWS_ACCESS_KEY_ID ? {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  } : undefined,
});

const MEMORY_CAP_BYTES = 80 * 1024 * 1024;

type Entry = { body: any; bytes: number };
const memory = new Map<string, Entry>(); // fingerprint -> response, LRU order
let memoryBytes = 0;
const inFlight = new Map<string, Promise<{ status: number; body: any }>>();

function remember(fp: string, body: any, bytes: number) {
  const old = memory.get(fp);
  if (old) { memoryBytes -= old.bytes; memory.delete(fp); }
  memory.set(fp, { body, bytes });
  memoryBytes += bytes;
  for (const [k, v] of memory) {
    if (memoryBytes <= MEMORY_CAP_BYTES) break;
    memory.delete(k); memoryBytes -= v.bytes;
  }
}

async function listInputs(prefixes: string[]): Promise<string[]> {
  const lines: string[] = [];
  for (const prefix of prefixes) {
    let token: string | undefined = undefined;
    do {
      const cmd: ListObjectsV2Command = new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token });
      const res = await s3.send(cmd);
      for (const o of res.Contents || []) {
        if (o.Key) lines.push(`${o.Key}\t${String(o.ETag || '').replace(/"/g, '')}`);
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
  }
  return lines.sort();
}

export type CachedResult = { status: number; body: any; source: 'memory' | 's3' | 'computed' };

export async function cachedJson(opts: {
  name: string;                 // route identity, e.g. 'consultant-report'
  version: string;              // bump when the route's parsing/calculation changes
  params: string;               // request parameters that change the answer, e.g. the month
  prefixes: string[];           // every S3 prefix the answer is read from
  persist: boolean;             // also keep a copy in S3 (survives restarts and deploys)
  compute: () => Promise<{ status: number; body: any }>; // the original route logic
}): Promise<CachedResult> {
  const inputs = await listInputs(opts.prefixes);
  const fp = createHash('sha1')
    .update([opts.name, opts.version, opts.params, ...inputs].join('\n'))
    .digest('hex');

  const hit = memory.get(fp);
  if (hit) { memory.delete(fp); memory.set(fp, hit); return { status: 200, body: hit.body, source: 'memory' }; }

  const s3Key = `cache/responses/${opts.name}/${opts.version}/${fp}.json.gz`;
  if (opts.persist) {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: s3Key }));
      if (res.Body) {
        const raw = gunzipSync(Buffer.from(await res.Body.transformToByteArray()));
        const body = JSON.parse(raw.toString('utf8'));
        remember(fp, body, raw.length);
        return { status: 200, body, source: 's3' };
      }
    } catch { /* not saved yet */ }
  }

  let p = inFlight.get(fp);
  if (!p) {
    p = (async () => {
      const result = await opts.compute();
      if (result.status === 200) {
        const raw = Buffer.from(JSON.stringify(result.body), 'utf8');
        remember(fp, result.body, raw.length);
        if (opts.persist) {
          try {
            await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: s3Key, Body: gzipSync(raw), ContentType: 'application/gzip' }));
          } catch (err: any) {
            console.warn(`[response-cache] ${opts.name}: cache write failed:`, err?.name, err?.message);
          }
        }
      }
      return result;
    })();
    inFlight.set(fp, p);
    p.finally(() => inFlight.delete(fp)).catch(() => {});
  }
  const result = await p;
  return { ...result, source: 'computed' };
}