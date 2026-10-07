// Located at: lib/searchIndex.ts
//
// Indexed All Info search. Returns exactly what the original search returns
// (lib/searchLegacy.ts), but without downloading and parsing every Excel file
// on every search.
//
// How it works
//   1. Parsed-file cache. Each file is parsed once, with the original parsing
//      code, and saved to S3 under cache/search/v1/parsed/, named by the
//      file's ETag. A changed file gets a new ETag, so it is re-parsed; an
//      unchanged file is never parsed again.
//   2. Suffix array. Every normalized name cell is joined into one string,
//      with \x01 between cells, and every suffix is sorted. All occurrences
//      of a query sit in one block of the sorted list, found with two binary
//      searches. Because the query is a-z only and \x01 is not, a match can
//      never cross from one cell into the next, so the cells found are
//      exactly the cells where the original `cell.includes(query)` is true.
//   3. Hybrid fallback. If a query would hit more than 10% of all positions
//      (for example a single common letter), a plain scan is faster than
//      listing every hit, so that query uses indexOf instead. Same results.
//   4. Caches. The index lives in server memory and in S3
//      (cache/search/v1/index/), named by a fingerprint of every file's
//      ETag. Recent identical searches are answered from memory.
//
// Nothing here writes or deletes outside cache/.

import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { gzipSync, gunzipSync } from 'zlib';
import { createHash } from 'crypto';
import {
  listSearchableFiles, downloadFile, parseSearchFile, normalize,
  type SearchableFile, type ParsedSearchFile, type MatchResult, type SearchResponse,
} from '@/lib/searchLegacy';

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

// Bump when the index format or parsing changes, so old cache entries are ignored.
const ENGINE_VERSION = 'v1';
const CACHE_PREFIX = `cache/search/${ENGINE_VERSION}`;
const LISTING_TTL_MS = 60 * 1000;          // new files appear in search within a minute
const PARSED_MEMORY_CAP = 120 * 1024 * 1024; // parsed files kept in memory, approx bytes
const QUERY_CACHE_SIZE = 200;              // recent searches answered from memory
const ROWS_PER_FILE = 50;                  // same cap as the original search
const SCAN_FALLBACK_RATIO = 0.1;           // hybrid switch point
const PARSE_CONCURRENCY = 8;

const ROLE_FIRST = 0, ROLE_LAST = 1, ROLE_SUBSCRIBER = 2, ROLE_OTHER = 3;
const SEP = 1; // \x01

// ---------------------------------------------------------------------------
// S3 cache helpers (gzip JSON or binary). Missing or unreadable means "miss".
// ---------------------------------------------------------------------------

async function cacheGet(key: string): Promise<Buffer | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    if (!res.Body) return null;
    const bytes = await res.Body.transformToByteArray();
    return gunzipSync(Buffer.from(bytes));
  } catch {
    return null;
  }
}

async function cachePut(key: string, body: Buffer): Promise<void> {
  try {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: key, Body: gzipSync(body), ContentType: 'application/gzip',
    }));
  } catch (err: any) {
    // Usually a missing s3:PutObject grant on cache/*. Search still works,
    // it just rebuilds instead of reusing the saved copy.
    console.warn('[search-index] cache write failed:', err?.name, err?.message);
  }
}

async function cacheExists(key: string): Promise<boolean> {
  try { await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })); return true; }
  catch { return false; }
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

// ---------------------------------------------------------------------------
// 1. File listing, cached for a minute
// ---------------------------------------------------------------------------

let listing: { at: number; files: SearchableFile[] } | null = null;
let listingInFlight: Promise<SearchableFile[]> | null = null;

async function getListing(): Promise<SearchableFile[]> {
  if (listing && Date.now() - listing.at < LISTING_TTL_MS) return listing.files;
  if (!listingInFlight) {
    listingInFlight = listSearchableFiles()
      .then(files => { listing = { at: Date.now(), files }; return files; })
      .finally(() => { listingInFlight = null; });
  }
  return listingInFlight;
}

// ---------------------------------------------------------------------------
// 2. Parsed-file cache: memory (LRU by size) -> S3 -> download and parse
// ---------------------------------------------------------------------------

type ParsedEntry = { etag: string; parsed: ParsedSearchFile | null; bytes: number };
const parsedMemory = new Map<string, ParsedEntry>(); // insertion order = LRU order
let parsedMemoryBytes = 0;

function rememberParsed(key: string, entry: ParsedEntry) {
  const old = parsedMemory.get(key);
  if (old) { parsedMemoryBytes -= old.bytes; parsedMemory.delete(key); }
  parsedMemory.set(key, entry);
  parsedMemoryBytes += entry.bytes;
  for (const [k, v] of parsedMemory) {
    if (parsedMemoryBytes <= PARSED_MEMORY_CAP) break;
    parsedMemory.delete(k);
    parsedMemoryBytes -= v.bytes;
  }
}

async function getParsed(file: SearchableFile): Promise<ParsedSearchFile | null> {
  const hit = parsedMemory.get(file.key);
  if (hit && hit.etag === file.etag) {
    parsedMemory.delete(file.key); parsedMemory.set(file.key, hit); // mark recently used
    return hit.parsed;
  }

  const cacheKey = `${CACHE_PREFIX}/parsed/${sha1(file.key)}-${file.etag}.json.gz`;
  const cached = await cacheGet(cacheKey);
  if (cached) {
    const body = JSON.parse(cached.toString('utf8'));
    const parsed: ParsedSearchFile | null = body.skip ? null : body.parsed;
    rememberParsed(file.key, { etag: file.etag, parsed, bytes: cached.length });
    return parsed;
  }

  // Miss: the original code path. A file that fails to parse is skipped,
  // exactly as the original search skipped it.
  let parsed: ParsedSearchFile | null = null;
  try {
    const buffer = await downloadFile(file.key);
    parsed = buffer ? parseSearchFile(file.key, buffer) : null;
  } catch (err) {
    console.error(`[search-index] could not parse ${file.key}:`, err);
    return null; // not cached, so it is retried next time
  }
  const json = Buffer.from(JSON.stringify(parsed ? { parsed } : { skip: true }), 'utf8');
  await cachePut(cacheKey, json);
  rememberParsed(file.key, { etag: file.etag, parsed, bytes: json.length });
  return parsed;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// 3. The index
// ---------------------------------------------------------------------------

type IndexFile = {
  key: string; etag: string;
  filename: string; system: string;
  headers: string[];
  matchedColumns: string[];
  matchedColumnIndices: number[];
  firstRow: number; // global id of this file's first row
  rowCount: number;
};

type SearchIndex = {
  fingerprint: string;
  scannedCount: number;     // files listed, including ones without name columns
  files: IndexFile[];       // only files with name columns, in listing order
  text: string;             // all cells, normalized, each followed by \x01
  bytes: Uint8Array;        // same as text, as bytes
  cellStart: Int32Array;    // start position of each cell in text
  cellRow: Int32Array;      // global row id of each cell
  cellRole: Uint8Array;     // first / last / subscriber
  rowFile: Int32Array;      // file index of each global row
  sa: Int32Array;           // suffix array: sorted start positions of letters
};

function fingerprintOf(files: SearchableFile[]): string {
  return sha1(ENGINE_VERSION + '\n' + files.map(f => `${f.key}\t${f.etag}`).join('\n'));
}

function roleCode(role: string): number {
  return role === 'first' ? ROLE_FIRST : role === 'last' ? ROLE_LAST
    : role === 'subscriber' ? ROLE_SUBSCRIBER : ROLE_OTHER;
}

async function buildIndex(listed: SearchableFile[], fingerprint: string): Promise<SearchIndex> {
  const t0 = Date.now();
  const parsedAll = await mapLimit(listed, PARSE_CONCURRENCY, getParsed);

  const files: IndexFile[] = [];
  const parts: string[] = [];
  const cellStartArr: number[] = [];
  const cellRowArr: number[] = [];
  const cellRoleArr: number[] = [];
  const rowFileArr: number[] = [];
  let pos = 0, rowId = 0;

  parsedAll.forEach((p, i) => {
    if (!p) return;
    const fileIdx = files.length;
    files.push({
      key: p.key, etag: listed[i].etag, filename: p.filename, system: p.system,
      headers: p.headers,
      matchedColumns: p.classifiedCols.map(c => c.name),
      matchedColumnIndices: p.classifiedCols.map(c => c.index),
      firstRow: rowId, rowCount: p.allRows.length,
    });
    for (const row of p.allRows) {
      for (const col of p.classifiedCols) {
        const v = normalize(String(row[col.index] || ''));
        cellStartArr.push(pos);
        cellRowArr.push(rowId);
        cellRoleArr.push(roleCode(col.role));
        parts.push(v);
        pos += v.length + 1;
      }
      rowFileArr.push(fileIdx);
      rowId++;
    }
  });

  const text = parts.join('\x01') + (parts.length ? '\x01' : '');
  const bytes = Buffer.from(text, 'latin1');

  // Suffix array over letter positions. Comparisons stop at the separator,
  // so each comparison is bounded by the length of one cell.
  let letters = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== SEP) letters++;
  const sa = new Int32Array(letters);
  for (let i = 0, j = 0; i < bytes.length; i++) if (bytes[i] !== SEP) sa[j++] = i;
  sa.sort((a, b) => {
    for (;;) {
      const x = bytes[a], y = bytes[b];
      if (x !== y) return x - y;
      if (x === SEP) return 0;
      a++; b++;
    }
  });

  console.log(`[search-index] built: ${files.length}/${listed.length} files, ${rowId} rows, ` +
    `${cellStartArr.length} cells, ${text.length} chars in ${Date.now() - t0} ms`);

  return {
    fingerprint, scannedCount: listed.length, files, text, bytes,
    cellStart: Int32Array.from(cellStartArr),
    cellRow: Int32Array.from(cellRowArr),
    cellRole: Uint8Array.from(cellRoleArr),
    rowFile: Int32Array.from(rowFileArr),
    sa,
  };
}

// Binary layout: [4-byte header length][header JSON][arrays...], gzipped.
function serializeIndex(ix: SearchIndex): Buffer {
  const header = Buffer.from(JSON.stringify({
    fingerprint: ix.fingerprint, scannedCount: ix.scannedCount, files: ix.files,
    sizes: {
      bytes: ix.bytes.length, cells: ix.cellStart.length,
      rows: ix.rowFile.length, sa: ix.sa.length,
    },
  }), 'utf8');
  const len = Buffer.alloc(4); len.writeUInt32LE(header.length, 0);
  const pad = (b: Buffer) => { const r = (4 - (b.length % 4)) % 4; return r ? Buffer.concat([b, Buffer.alloc(r)]) : b; };
  return Buffer.concat([
    len, pad(header),
    pad(Buffer.from(ix.bytes)),
    Buffer.from(ix.cellStart.buffer, ix.cellStart.byteOffset, ix.cellStart.byteLength),
    Buffer.from(ix.cellRow.buffer, ix.cellRow.byteOffset, ix.cellRow.byteLength),
    Buffer.from(ix.rowFile.buffer, ix.rowFile.byteOffset, ix.rowFile.byteLength),
    Buffer.from(ix.sa.buffer, ix.sa.byteOffset, ix.sa.byteLength),
    pad(Buffer.from(ix.cellRole)),
  ]);
}

function deserializeIndex(buf: Buffer): SearchIndex {
  // Copy into a fresh, aligned buffer so typed arrays can view it directly.
  const ab = new ArrayBuffer(buf.length);
  const all = new Uint8Array(ab); all.set(buf);
  const headerLen = buf.readUInt32LE(0);
  const meta = JSON.parse(buf.subarray(4, 4 + headerLen).toString('utf8'));
  const up4 = (n: number) => n + ((4 - (n % 4)) % 4);
  let off = 4 + up4(headerLen);
  const s = meta.sizes;
  const bytes = new Uint8Array(ab, off, s.bytes); off += up4(s.bytes);
  const cellStart = new Int32Array(ab, off, s.cells); off += s.cells * 4;
  const cellRow = new Int32Array(ab, off, s.cells); off += s.cells * 4;
  const rowFile = new Int32Array(ab, off, s.rows); off += s.rows * 4;
  const sa = new Int32Array(ab, off, s.sa); off += s.sa * 4;
  const cellRole = new Uint8Array(ab, off, s.cells);
  return {
    fingerprint: meta.fingerprint, scannedCount: meta.scannedCount, files: meta.files,
    text: Buffer.from(bytes).toString('latin1'), bytes, cellStart, cellRow, cellRole, rowFile, sa,
  };
}

let current: SearchIndex | null = null;
let building: { fingerprint: string; promise: Promise<SearchIndex> } | null = null;
let lastSource = '';

async function getIndex(): Promise<{ index: SearchIndex; source: string }> {
  const listed = await getListing();
  const fingerprint = fingerprintOf(listed);
  if (current && current.fingerprint === fingerprint) return { index: current, source: 'memory' };

  if (!building || building.fingerprint !== fingerprint) {
    const promise = (async () => {
      const key = `${CACHE_PREFIX}/index/${fingerprint}.bin.gz`;
      const saved = await cacheGet(key);
      if (saved) {
        try { const ix = deserializeIndex(saved); lastSource = 's3'; return ix; }
        catch (err) { console.warn('[search-index] saved index unreadable, rebuilding:', err); }
      }
      const built = await buildIndex(listed, fingerprint);
      await cachePut(key, serializeIndex(built));
      lastSource = 'built';
      return built;
    })();
    building = { fingerprint, promise };
    promise
      .finally(() => { if (building?.promise === promise) building = null; })
      .catch(() => { /* the awaiting request reports the error */ });
  }
  const index = await building.promise;
  current = index;
  queryCache.clear(); // results from an older index are no longer valid
  return { index, source: lastSource || 's3' };
}

// ---------------------------------------------------------------------------
// 4. Query: which cells contain a word
// ---------------------------------------------------------------------------

function cellOf(ix: SearchIndex, pos: number): number {
  let lo = 0, hi = ix.cellStart.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ix.cellStart[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// Compares the suffix at p with q, looking only at q.length characters.
function cmpPrefix(ix: SearchIndex, p: number, q: string): number {
  const b = ix.bytes;
  for (let j = 0; j < q.length; j++) {
    const x = p + j < b.length ? b[p + j] : 0;
    const y = q.charCodeAt(j);
    if (x !== y) return x - y;
  }
  return 0;
}

// Distinct cells whose normalized value contains w (w is a-z, non-empty).
function cellsContaining(ix: SearchIndex, w: string): Int32Array {
  const sa = ix.sa;
  let lo = 0, hi = sa.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cmpPrefix(ix, sa[m], w) < 0) lo = m + 1; else hi = m; }
  const first = lo;
  hi = sa.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cmpPrefix(ix, sa[m], w) <= 0) lo = m + 1; else hi = m; }
  const count = lo - first;
  if (count === 0) return new Int32Array(0);

  const cells: number[] = [];
  if (count > sa.length * SCAN_FALLBACK_RATIO) {
    // Hybrid: very common query, scan instead. One hit per cell, then jump
    // to the next cell.
    let from = 0;
    for (;;) {
      const at = ix.text.indexOf(w, from);
      if (at < 0) break;
      const c = cellOf(ix, at);
      cells.push(c);
      from = c + 1 < ix.cellStart.length ? ix.cellStart[c + 1] : ix.text.length;
    }
    return Int32Array.from(cells);
  }
  const seen = new Set<number>();
  for (let i = first; i < lo; i++) seen.add(cellOf(ix, sa[i]));
  return Int32Array.from(seen);
}

// ---------------------------------------------------------------------------
// 5. Query: the original matching rules, on cell sets
// ---------------------------------------------------------------------------

type RowHit = { row: number; terms: string[] };

function matchRows(ix: SearchIndex, query: string): RowHit[] {
  const rawQuery = query.trim();
  if (rawQuery.length === 0) return [];
  const words = rawQuery.split(/\s+/).filter(w => w.length > 0);

  if (words.length === 2) {
    // Original: (w1 in first AND w2 in last) OR (w2 in first AND w1 in last)
    //           OR (both in the same subscriber cell)
    const w1 = normalize(words[0]);
    const w2 = normalize(words[1]);
    if (w1.length === 0 || w2.length === 0) return [];
    const label = [words[0], words[1], words.join(' ')];

    const c1 = cellsContaining(ix, w1);
    const c2 = cellsContaining(ix, w2);
    const flags = new Map<number, number>(); // row -> bits
    const add = (row: number, bit: number) => flags.set(row, (flags.get(row) || 0) | bit);
    const inC1 = new Set<number>();
    for (const c of c1) {
      inC1.add(c);
      const role = ix.cellRole[c], row = ix.cellRow[c];
      if (role === ROLE_FIRST) add(row, 1);       // w1 in first
      else if (role === ROLE_LAST) add(row, 8);   // w1 in last
    }
    for (const c of c2) {
      const role = ix.cellRole[c], row = ix.cellRow[c];
      if (role === ROLE_FIRST) add(row, 4);       // w2 in first
      else if (role === ROLE_LAST) add(row, 2);   // w2 in last
      else if (role === ROLE_SUBSCRIBER && inC1.has(c)) add(row, 16); // same cell
    }
    const hits: RowHit[] = [];
    for (const [row, f] of flags) {
      if ((f & 3) === 3 || (f & 12) === 12 || (f & 16)) hits.push({ row, terms: label });
    }
    return hits.sort((a, b) => a.row - b.row);
  }

  // Original: single word or 3+ words, OR across all name columns.
  const wordNormals = words.map(w => ({ label: w, normalized: normalize(w) }))
    .filter(w => w.normalized.length > 0);
  if (wordNormals.length === 0) return [];
  const terms = new Map<number, string[]>();
  wordNormals.forEach((w) => {
    const seenRow = new Set<number>(); // one entry per word per row, as originally
    for (const c of cellsContaining(ix, w.normalized)) {
      const row = ix.cellRow[c];
      if (seenRow.has(row)) continue;
      seenRow.add(row);
      const list = terms.get(row);
      if (list) list.push(w.label); else terms.set(row, [w.label]);
    }
  });
  const hits: RowHit[] = [];
  for (const [row, t] of terms) hits.push({ row, terms: t });
  return hits.sort((a, b) => a.row - b.row);
}

// ---------------------------------------------------------------------------
// 6. Public entry points
// ---------------------------------------------------------------------------

/**
 * Used by the search-indexer Lambda after an upload: makes sure the index for
 * the bucket as it is right now exists in S3, building it if not. The website
 * computes the same fingerprint, so it simply loads this saved index.
 */
export async function warmSearchIndex(): Promise<{ fingerprint: string; action: 'exists' | 'built'; ms: number }> {
  const t0 = Date.now();
  listing = null; // always list fresh here; the 60 s cache is for the website
  const listed = await getListing();
  const fingerprint = fingerprintOf(listed);
  const key = `${CACHE_PREFIX}/index/${fingerprint}.bin.gz`;
  if (await cacheExists(key)) return { fingerprint, action: 'exists', ms: Date.now() - t0 };
  const built = await buildIndex(listed, fingerprint);
  await cachePut(key, serializeIndex(built));
  return { fingerprint, action: 'built', ms: Date.now() - t0 };
}

const queryCache = new Map<string, SearchResponse>();

export async function indexedSearch(query: string): Promise<{ response: SearchResponse; timing: Record<string, number | string> }> {
  const t0 = Date.now();
  const { index, source } = await getIndex();
  const tIndex = Date.now();

  const cacheKey = `${index.fingerprint}\u0000${query}`;
  const cached = queryCache.get(cacheKey);
  if (cached) {
    queryCache.delete(cacheKey); queryCache.set(cacheKey, cached);
    return { response: cached, timing: { indexMs: tIndex - t0, indexSource: source, queryCache: 'hit', totalMs: Date.now() - t0 } };
  }

  const hits = matchRows(index, query);
  const tMatch = Date.now();

  // Group by file in listing order, first 50 rows per file, as originally.
  const perFile = new Map<number, RowHit[]>();
  for (const h of hits) {
    const f = index.rowFile[h.row];
    const list = perFile.get(f);
    if (!list) perFile.set(f, [h]);
    else if (list.length < ROWS_PER_FILE) list.push(h);
  }
  const fileIdxs = [...perFile.keys()].sort((a, b) => a - b);
  const results = await mapLimit(fileIdxs, PARSE_CONCURRENCY, async (fi): Promise<MatchResult | null> => {
    const f = index.files[fi];
    const parsed = await getParsed({ key: f.key, etag: f.etag });
    if (!parsed) return null;
    const rows = perFile.get(fi)!;
    return {
      fileKey: f.key,
      filename: f.filename,
      system: f.system,
      headers: f.headers,
      rows: rows.map(h => parsed.allRows[h.row - f.firstRow]),
      matchedTermsPerRow: rows.map(h => h.terms),
      matchedColumns: f.matchedColumns,
      matchedColumnIndices: f.matchedColumnIndices,
    };
  });
  const finalResults = results.filter((r): r is MatchResult => r !== null);
  const response: SearchResponse = {
    query,
    filesScanned: index.scannedCount,
    filesWithMatches: finalResults.length,
    totalMatches: finalResults.reduce((sum, r) => sum + r.rows.length, 0),
    results: finalResults,
  };

  queryCache.set(cacheKey, response);
  while (queryCache.size > QUERY_CACHE_SIZE) queryCache.delete(queryCache.keys().next().value as string);

  return {
    response,
    timing: {
      indexMs: tIndex - t0, indexSource: source, queryCache: 'miss',
      matchMs: tMatch - tIndex, rowsMs: Date.now() - tMatch, totalMs: Date.now() - t0,
    },
  };
}