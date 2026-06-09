// Located at: app/api/search/route.ts
//
// Searches across all S3 files for matching member names.
// Returns rows from files where name fields contain the search query.

import { NextResponse } from 'next/server';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import * as XLSX from 'xlsx';

const REGION = process.env.MY_AWS_REGION || 'us-east-1';
const BUCKET = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  },
});

// Columns to search across (case-insensitive, will normalize header names)
const NAME_COLUMNS = [
  'subscriber name',
  'first name',
  'last name',
  'member first',
  'member last',
  'member name',
];

async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function normalizeHeader(h: string): string {
  return String(h || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines: string[] = [];
  let current = '';
  let inQuotes = false;
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
        if (inQ && line[i + 1] === '"') { field += '"'; i++; }
        else inQ = !inQ;
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

type MatchResult = {
  fileKey: string;
  filename: string;
  system: string;
  headers: string[];
  rows: string[][]; // matching rows only
  matchedTermsPerRow: string[][]; // for each row, which terms matched (e.g., ["Alice"], ["Alice", "Beene"])
  matchedColumns: string[]; // which name columns this file has
};

async function searchFile(key: string, query: string): Promise<MatchResult | null> {
  try {
    const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const res = await s3.send(cmd);
    if (!res.Body) return null;

    const buffer = await streamToBuffer(res.Body as any);
    const filename = key.split('/').pop() || key;
    const lowerKey = key.toLowerCase();
    const sysMatch = key.match(/^carrier=([^/]+)\//);
    const system = sysMatch ? sysMatch[1] : 'unknown';

    let headers: string[] = [];
    let allRows: string[][] = [];

    if (lowerKey.endsWith('.csv')) {
      const text = buffer.toString('utf8');
      const parsed = parseCSV(text);
      headers = parsed.headers;
      allRows = parsed.rows;
    } else if (lowerKey.endsWith('.xlsx') || lowerKey.endsWith('.xls')) {
      const wb = XLSX.read(buffer, { type: 'buffer' });
      let sheetName = wb.SheetNames[0];
      if (lowerKey.includes('corechoice') && wb.SheetNames.includes('Empire BCBS')) {
        sheetName = 'Empire BCBS';
      }
      const ws = wb.Sheets[sheetName];
      const allData: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
      if (allData.length === 0) return null;

      // Detect Cassena-style preamble
      let headerRowIdx = 0;
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

      headers = (allData[headerRowIdx] || []).map((v: any) => String(v ?? ''));
      allRows = allData.slice(headerRowIdx + 1).filter((r) =>
        r.some((v: any) => v !== '' && v != null)
      ).map((r) => headers.map((_h, i) => String(r[i] ?? '')));
    } else {
      return null; // unsupported file type
    }

    // Find which columns in this file are name-related
    const matchedColumnIndices: number[] = [];
    const matchedColumnNames: string[] = [];
    headers.forEach((h, i) => {
      const norm = normalizeHeader(h);
      if (NAME_COLUMNS.some(nc => norm.includes(nc))) {
        matchedColumnIndices.push(i);
        matchedColumnNames.push(h);
      }
    });

    if (matchedColumnIndices.length === 0) return null;

    // Normalize: lowercase and strip non-alphabetic characters
    // So "BEENE, ALICE" → "beenealice", "Alice Beene" → "alicebeene"
    const normalize = (s: string): string =>
      String(s || '').toLowerCase().replace(/[^a-z]/g, '');

    const rawQuery = query.trim();
    if (rawQuery.length === 0) return null;

    // Build search terms from the query
    // If multi-word, search each word separately + both as combined (in both orders)
    const words = rawQuery.split(/\s+/).filter(w => w.length > 0);
    const searchTerms: { label: string; normalized: string }[] = [];

    if (words.length === 1) {
      searchTerms.push({ label: words[0], normalized: normalize(words[0]) });
    } else {
      // Each individual word
      for (const w of words) {
        searchTerms.push({ label: w, normalized: normalize(w) });
      }
      // Combined: "Alice Beene" and reverse "Beene Alice"
      const combinedForward = normalize(words.join(''));
      const combinedReverse = normalize([...words].reverse().join(''));
      searchTerms.push({ label: words.join(' '), normalized: combinedForward });
      if (combinedReverse !== combinedForward) {
        // Also try the reverse so "Alice Beene" matches "BEENE, ALICE"
        // We track this under the same combined label so dedup works naturally
      }
      // We will check BOTH directions in matching logic below; the label stays "Alice Beene"
    }

    // For each row, determine which terms it matched (one or more)
    // Dedup by row index automatically (we iterate once per row)
    type MatchedRow = { row: string[]; matchedTerms: string[] };
    const matchedRows: MatchedRow[] = [];

    allRows.forEach((row) => {
      // Build a single normalized blob of all name-column cells for this row
      const cellBlobs = matchedColumnIndices.map((idx) => normalize(String(row[idx] || '')));

      const termsHit: string[] = [];
      for (const term of searchTerms) {
        if (term.normalized.length === 0) continue;
        const hits = cellBlobs.some((blob) => blob.includes(term.normalized));
        if (hits) {
          termsHit.push(term.label);
        }
      }

      // For multi-word queries, also check the reverse-combined form
      if (words.length > 1) {
        const reverseCombined = normalize([...words].reverse().join(''));
        const combinedLabel = words.join(' ');
        const alreadyHasCombined = termsHit.includes(combinedLabel);
        if (!alreadyHasCombined) {
          const hits = cellBlobs.some((blob) => blob.includes(reverseCombined));
          if (hits) termsHit.push(combinedLabel);
        }
      }

      if (termsHit.length > 0) {
        matchedRows.push({ row, matchedTerms: termsHit });
      }
    });

    if (matchedRows.length === 0) return null;

    return {
      fileKey: key,
      filename,
      system,
      headers,
      rows: matchedRows.slice(0, 50).map(m => m.row),
      matchedTermsPerRow: matchedRows.slice(0, 50).map(m => m.matchedTerms),
      matchedColumns: matchedColumnNames,
    };
  } catch (err) {
    console.error(`Error searching file ${key}:`, err);
    return null;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');

  if (!query || query.trim().length < 2) {
    return NextResponse.json({ error: 'Query must be at least 2 characters' }, { status: 400 });
  }

  try {
    // List all S3 objects
    const fileKeys: string[] = [];
    let token: string | undefined = undefined;
    do {
      const cmd: ListObjectsV2Command = new ListObjectsV2Command({
        Bucket: BUCKET,
        ContinuationToken: token,
      });
      const res = await s3.send(cmd);
      for (const obj of res.Contents || []) {
        if (!obj.Key || obj.Key.endsWith('/')) continue;
        const lower = obj.Key.toLowerCase();
        if (lower.endsWith('.csv') || lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
          fileKeys.push(obj.Key);
        }
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);

    // Search each file in parallel
    const allResults = await Promise.all(fileKeys.map((k) => searchFile(k, query)));
    const results = allResults.filter((r): r is MatchResult => r !== null);

    const totalMatches = results.reduce((sum, r) => sum + r.rows.length, 0);

    return NextResponse.json({
      query,
      filesScanned: fileKeys.length,
      filesWithMatches: results.length,
      totalMatches,
      results,
    });
  } catch (err: any) {
    console.error('Search error:', err);
    return NextResponse.json(
      { error: err.message || 'Search failed' },
      { status: 500 }
    );
  }
}