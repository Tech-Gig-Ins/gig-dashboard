// Located at: lib/masterCache.ts
//
// Caches the Master Dashboard result so it is not rebuilt from Excel on every
// load. Uses the original computation (lib/masterLegacy.ts) unchanged.
//
// Two levels, both in server memory and in S3 under cache/master/v1/:
//   records/<file>-<etag>   one file's parsed members. A changed file has a new
//                           ETag, so only that file is parsed again.
//   result/<fingerprint>    the full Master result. The fingerprint covers the
//                           ETag of every manifest and every carrier= file, so
//                           an upload, move, rename or include toggle produces
//                           a new fingerprint and a fresh result.
//
// Queries for a table page name the fingerprint they were built from, so a
// page is always cut from the same result its summary came from.

import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { gzipSync, gunzipSync } from 'zlib';
import { createHash } from 'crypto';
import {
  computeMaster, downloadMasterFile, parseMasterFile,
  type MasterResponse, type MemberRecord,
} from '@/lib/masterLegacy';

const BUCKET = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';
const s3 = new S3Client({
  region: process.env.MY_AWS_REGION || 'us-east-1',
  // The website passes its access keys. The search-indexer Lambda has none
  // set and uses its own IAM role instead.
  credentials: process.env.MY_AWS_ACCESS_KEY_ID ? {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  } : undefined,
});

const VERSION = 'v1';
const PREFIX = `cache/master/${VERSION}`;
const RECORDS_MEMORY_CAP = 80 * 1024 * 1024; // approx bytes of parsed files kept in memory
const RESULTS_IN_MEMORY = 3;                 // recent full results kept in memory

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

async function cacheGet(key: string): Promise<Buffer | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    if (!res.Body) return null;
    return gunzipSync(Buffer.from(await res.Body.transformToByteArray()));
  } catch {
    return null;
  }
}

async function cachePut(key: string, body: Buffer): Promise<void> {
  try {
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: gzipSync(body), ContentType: 'application/gzip' }));
  } catch (err: any) {
    console.warn('[master-cache] cache write failed:', err?.name, err?.message);
  }
}

// ---------------------------------------------------------------------------
// Fingerprint: every manifest and every carrier= object, with its ETag
// ---------------------------------------------------------------------------

async function listWithEtags(prefix: string): Promise<{ key: string; etag: string }[]> {
  const out: { key: string; etag: string }[] = [];
  let token: string | undefined = undefined;
  do {
    const cmd: ListObjectsV2Command = new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token });
    const res = await s3.send(cmd);
    for (const o of res.Contents || []) {
      if (o.Key) out.push({ key: o.Key, etag: String(o.ETag || '').replace(/"/g, '') });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

async function currentState(): Promise<{ fingerprint: string; etags: Map<string, string> }> {
  const [manifests, carrier] = await Promise.all([listWithEtags('manifests/'), listWithEtags('carrier=')]);
  const lines = [...manifests, ...carrier].map(o => `${o.key}\t${o.etag}`).sort();
  return {
    fingerprint: sha1(VERSION + '\n' + lines.join('\n')),
    etags: new Map(carrier.map(o => [o.key, o.etag])),
  };
}

// ---------------------------------------------------------------------------
// Per-file records cache
// ---------------------------------------------------------------------------

type RecordsEntry = { etag: string; records: MemberRecord[]; bytes: number };
const recordsMemory = new Map<string, RecordsEntry>(); // insertion order = LRU
let recordsBytes = 0;

function rememberRecords(key: string, e: RecordsEntry) {
  const old = recordsMemory.get(key);
  if (old) { recordsBytes -= old.bytes; recordsMemory.delete(key); }
  recordsMemory.set(key, e);
  recordsBytes += e.bytes;
  for (const [k, v] of recordsMemory) {
    if (recordsBytes <= RECORDS_MEMORY_CAP) break;
    recordsMemory.delete(k); recordsBytes -= v.bytes;
  }
}

function cachedExtractor(etags: Map<string, string>) {
  return async (key: string): Promise<MemberRecord[]> => {
    const etag = etags.get(key) || '';
    const hit = recordsMemory.get(key);
    if (hit && hit.etag === etag) return hit.records;

    const cacheKey = `${PREFIX}/records/${sha1(key)}-${etag}.json.gz`;
    const cached = etag ? await cacheGet(cacheKey) : null;
    if (cached) {
      const records: MemberRecord[] = JSON.parse(cached.toString('utf8'));
      rememberRecords(key, { etag, records, bytes: cached.length });
      return records;
    }

    // Miss: the original path. A failed download is not cached, so it is
    // retried next time; a file that downloads but fails to parse gives []
    // exactly as before, and that result is cached for this ETag.
    let buffer: Buffer | null;
    try {
      buffer = await downloadMasterFile(key);
    } catch (err) {
      console.error(`Error extracting from ${key}:`, err);
      return [];
    }
    if (!buffer) return [];
    const records = parseMasterFile(key, buffer);
    if (etag) {
      const json = Buffer.from(JSON.stringify(records), 'utf8');
      await cachePut(cacheKey, json);
      rememberRecords(key, { etag, records, bytes: json.length });
    }
    return records;
  };
}

// ---------------------------------------------------------------------------
// Full result cache
// ---------------------------------------------------------------------------

const results = new Map<string, MasterResponse>(); // fingerprint -> result, LRU
const inFlight = new Map<string, Promise<MasterResponse>>();

function rememberResult(fp: string, r: MasterResponse) {
  results.delete(fp);
  results.set(fp, r);
  while (results.size > RESULTS_IN_MEMORY) results.delete(results.keys().next().value as string);
}

/** Result for a known fingerprint, from memory or S3. Null if not cached. */
export async function getMasterByFingerprint(fp: string): Promise<MasterResponse | null> {
  if (!/^[0-9a-f]{40}$/.test(fp)) return null;
  const mem = results.get(fp);
  if (mem) { rememberResult(fp, mem); return mem; }
  const saved = await cacheGet(`${PREFIX}/result/${fp}.json.gz`);
  if (!saved) return null;
  const r: MasterResponse = JSON.parse(saved.toString('utf8'));
  rememberResult(fp, r);
  return r;
}

/**
 * Used by the search-indexer Lambda after an upload or include toggle: makes
 * sure the Master result for the current files exists in S3, building it if
 * not, so the next person to open Master does not wait for the build.
 */
export async function warmMaster(): Promise<{ fingerprint: string; action: 'exists' | 'built'; ms: number }> {
  const t0 = Date.now();
  const { fingerprint } = await currentState();
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}/result/${fingerprint}.json.gz` }));
    return { fingerprint, action: 'exists', ms: Date.now() - t0 };
  } catch { /* not saved yet */ }
  await getMaster();
  return { fingerprint, action: 'built', ms: Date.now() - t0 };
}

/** The current Master result and its fingerprint. Rebuilt only when inputs changed. */
export async function getMaster(): Promise<{ fingerprint: string; result: MasterResponse; source: string; ms: number }> {
  const t0 = Date.now();
  const { fingerprint, etags } = await currentState();

  const known = await getMasterByFingerprint(fingerprint);
  if (known) return { fingerprint, result: known, source: 'cache', ms: Date.now() - t0 };

  let p = inFlight.get(fingerprint);
  if (!p) {
    p = (async () => {
      const result = await computeMaster(cachedExtractor(etags));
      await cachePut(`${PREFIX}/result/${fingerprint}.json.gz`, Buffer.from(JSON.stringify(result), 'utf8'));
      rememberResult(fingerprint, result);
      return result;
    })();
    inFlight.set(fingerprint, p);
    p.finally(() => inFlight.delete(fingerprint)).catch(() => {});
  }
  const result = await p;
  return { fingerprint, result, source: 'built', ms: Date.now() - t0 };
}