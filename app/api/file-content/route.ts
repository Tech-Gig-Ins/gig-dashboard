// Located at: app/api/file-content/route.ts
//
// Downloads a single file from S3 and returns parsed contents.
// Handles CSV and XLSX. Returns first N rows to keep responses small.
//
// Cached: each preview is parsed once per file version (its S3 ETag) and kept
// in server memory and in S3 under cache/file-content/v1/. Opening the same
// file again skips the download and parse. The response carries an ETag, so a
// browser that already has this version gets a 304 and nothing is resent.
// The parsing code itself (buildPreview) is the original, unchanged.

import { NextResponse } from 'next/server';
import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import * as XLSX from 'xlsx';
import { gzipSync, gunzipSync } from 'zlib';
import { createHash } from 'crypto';

import { requireAuth } from '@/lib/auth';
const REGION = process.env.MY_AWS_REGION || 'us-east-1';
const BUCKET = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';
const MAX_ROWS = 500;

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  },
});

async function streamToBuffer(stream: ReadableStream<Uint8Array> | any): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader ? stream.getReader() : null;

  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } else {
    // Node stream fallback
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines: string[] = [];
  let current = '';
  let inQuotes = false;

  // Handle CSV with possible quoted fields containing newlines
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && text[i - 1] !== '\\') {
      inQuotes = !inQuotes;
      current += c;
    } else if (c === '\n' && !inQuotes) {
      lines.push(current);
      current = '';
    } else if (c === '\r' && !inQuotes) {
      // skip
    } else {
      current += c;
    }
  }
  if (current) lines.push(current);

  if (lines.length === 0) return { headers: [], rows: [] };

  const parseLine = (line: string): string[] => {
    const fields: string[] = [];
    let field = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQ = !inQ;
        }
      } else if (c === ',' && !inQ) {
        fields.push(field);
        field = '';
      } else {
        field += c;
      }
    }
    fields.push(field);
    return fields;
  };

  const headers = parseLine(lines[0]);
  const rows: string[][] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    rows.push(parseLine(lines[i]));
  }

  return { headers, rows };
}

// Original parsing code, unchanged. Returns the original response body and status.
function buildPreview(key: string, buffer: Buffer): { status: number; body: any } {
    const lowerKey = key.toLowerCase();

    // CSV
    if (lowerKey.endsWith('.csv')) {
      const text = buffer.toString('utf8');
      const parsed = parseCSV(text);
      const totalRows = parsed.rows.length;
      const rows = parsed.rows.slice(0, MAX_ROWS);
      return { status: 200, body: {
        headers: parsed.headers,
        rows,
        totalRows,
      } };
    }

    // XLSX (Excel)
    if (lowerKey.endsWith('.xlsx') || lowerKey.endsWith('.xls')) {
      const wb = XLSX.read(buffer, { type: 'buffer' });

      let sheetName = wb.SheetNames[0];
      // Corechoice Direct T1/T3, Decisely GWU1/GWU2, and any GWU1/GWU2 file:
      // read ONLY the Anthem Medical sheet. Falls back to the first sheet if
      // no Anthem Medical sheet exists in the workbook.
      const normKey = lowerKey.replace(/[^a-z0-9]/g, '');
      const anthemMedicalOnly =
        (normKey.includes('corechoice') && (normKey.includes('t1') || normKey.includes('t3'))) ||
        normKey.includes('gwu1') ||
        normKey.includes('gwu2');
      if (anthemMedicalOnly) {
        const anthemSheet = wb.SheetNames.find(
          (n) => n.toLowerCase().replace(/[^a-z0-9]/g, '').includes('anthemmedical')
        );
        if (anthemSheet) sheetName = anthemSheet;
      }

      const ws = wb.Sheets[sheetName];
      const allData: any[][] = XLSX.utils.sheet_to_json(ws, {
        header: 1,
        raw: false,
        defval: '',
      });

      if (allData.length === 0) {
        return { status: 200, body: { headers: [], rows: [], totalRows: 0, sheetName } };
      }

      // Cassena-style files have a preamble. Detect: find first row with 5+ non-empty cells
      let headerRowIdx = 0;
      const filenameLower = key.split('/').pop()?.toLowerCase() || '';
      const isCassenaStyle =
        !lowerKey.includes('nyp') &&
        !lowerKey.includes('corechoice') &&
        allData[0] &&
        allData[0].filter((v: any) => v !== '' && v != null).length < 3;

      if (isCassenaStyle) {
        for (let i = 0; i < Math.min(25, allData.length); i++) {
          const nonEmpty = allData[i].filter((v: any) => v !== '' && v != null).length;
          if (nonEmpty >= 5) {
            headerRowIdx = i;
            break;
          }
        }
      }

      const headers = (allData[headerRowIdx] || []).map((v: any) => String(v ?? ''));
      const dataRows = allData.slice(headerRowIdx + 1).filter((r) =>
        r.some((v: any) => v !== '' && v != null)
      );
      const totalRows = dataRows.length;
      const rows = dataRows.slice(0, MAX_ROWS).map((r) =>
        headers.map((_h: string, idx: number) => String(r[idx] ?? ''))
      );

      return { status: 200, body: { headers, rows, totalRows, sheetName } };
    }

    // Unknown file type
    return {
      status: 400,
      body: { error: `Unsupported file type. Only CSV and Excel files can be previewed.` },
    };
}

// ---- Preview cache: memory (recent files) -> S3 -> download and parse ----
const PREVIEW_VERSION = 'v1';
const PREVIEW_PREFIX = `cache/file-content/${PREVIEW_VERSION}`;
const PREVIEW_MEMORY_ENTRIES = 50;
const previewMemory = new Map<string, any>(); // `${key}\u0000${etag}` -> body, LRU

const sha1 = (v: string) => createHash('sha1').update(v).digest('hex');

async function readPreviewCache(key: string, etag: string): Promise<any | null> {
  const memKey = `${key}\u0000${etag}`;
  const hit = previewMemory.get(memKey);
  if (hit) { previewMemory.delete(memKey); previewMemory.set(memKey, hit); return hit; }
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${PREVIEW_PREFIX}/${sha1(key)}-${etag}.json.gz` }));
    if (!res.Body) return null;
    const body = JSON.parse(gunzipSync(Buffer.from(await res.Body.transformToByteArray())).toString('utf8'));
    rememberPreview(memKey, body);
    return body;
  } catch {
    return null;
  }
}

function rememberPreview(memKey: string, body: any) {
  previewMemory.delete(memKey);
  previewMemory.set(memKey, body);
  while (previewMemory.size > PREVIEW_MEMORY_ENTRIES) previewMemory.delete(previewMemory.keys().next().value as string);
}

async function writePreviewCache(key: string, etag: string, body: any): Promise<void> {
  rememberPreview(`${key}\u0000${etag}`, body);
  try {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: `${PREVIEW_PREFIX}/${sha1(key)}-${etag}.json.gz`,
      Body: gzipSync(Buffer.from(JSON.stringify(body), 'utf8')),
      ContentType: 'application/gzip',
    }));
  } catch (err: any) {
    console.warn('[file-content] cache write failed:', err?.name, err?.message);
  }
}

export async function GET(request: Request) {
  // Auth boundary. proxy.ts only does an optimistic cookie check;
  // this is what actually verifies the token and role.
  const gate = await requireAuth(request);
  if (gate instanceof NextResponse) return gate;

  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key');

  if (!key) {
    return NextResponse.json({ error: 'Missing key parameter' }, { status: 400 });
  }

  try {
    // The file's current version, from a cheap HEAD request (no download).
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    const etag = String(head.ETag || '').replace(/"/g, '');
    const httpEtag = `"fc-${PREVIEW_VERSION}-${etag}"`;
    const cacheHeaders = { 'Cache-Control': 'private, no-cache', ETag: httpEtag };

    if (etag) {
      if (request.headers.get('if-none-match') === httpEtag) {
        return new NextResponse(null, { status: 304, headers: cacheHeaders });
      }
      const cached = await readPreviewCache(key, etag);
      if (cached) return NextResponse.json(cached, { headers: cacheHeaders });
    }

    // Miss: the original path.
    const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const res = await s3.send(cmd);

    if (!res.Body) {
      return NextResponse.json({ error: 'Empty file body' }, { status: 500 });
    }

    const buffer = await streamToBuffer(res.Body as any);
    const { status, body } = buildPreview(key, buffer);
    if (status !== 200) return NextResponse.json(body, { status });

    // Cache under the ETag of the bytes actually downloaded, so a file
    // replaced between the HEAD and the download is never mislabelled.
    const downloadedEtag = String(res.ETag || '').replace(/"/g, '');
    if (downloadedEtag) await writePreviewCache(key, downloadedEtag, body);
    const headers = downloadedEtag === etag ? cacheHeaders : { 'Cache-Control': 'private, no-cache' };
    return NextResponse.json(body, { headers });
  } catch (err: any) {
    console.error('File content error:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to load file' },
      { status: 500 }
    );
  }
}