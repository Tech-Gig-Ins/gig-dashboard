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

const MONTH_LOOKUP: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

function detectMonthYearForSearch(filename: string): { year: number; month: number } | null {
  const lower = filename.toLowerCase();

  const monthNamePattern = /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s_\-]*(\d{4})/i;
  const m1 = lower.match(monthNamePattern);
  if (m1) {
    const month = MONTH_LOOKUP[m1[1].toLowerCase()];
    const year = parseInt(m1[2], 10);
    if (month !== undefined && year >= 2020 && year <= 2099) return { year, month };
  }

  const monthShortYearPattern = /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s_\-]*(\d{2})(?!\d)/i;
  const m1b = lower.match(monthShortYearPattern);
  if (m1b) {
    const month = MONTH_LOOKUP[m1b[1].toLowerCase()];
    const yy = parseInt(m1b[2], 10);
    const year = 2000 + yy;
    if (month !== undefined && yy >= 20 && yy <= 99) return { year, month };
  }

  const usDatePattern = /(\d{1,2})[\-_\/](\d{1,2})[\-_\/](\d{4})/;
  const m2 = filename.match(usDatePattern);
  if (m2) {
    const month = parseInt(m2[1], 10) - 1;
    const year = parseInt(m2[3], 10);
    if (month >= 0 && month <= 11 && year >= 2020 && year <= 2099) return { year, month };
  }

  const isoPattern = /(\d{8})/;
  const m3 = filename.match(isoPattern);
  if (m3) {
    const s = m3[1];
    const year = parseInt(s.slice(0, 4), 10);
    const month = parseInt(s.slice(4, 6), 10) - 1;
    if (year >= 2020 && year <= 2099 && month >= 0 && month <= 11) return { year, month };
  }

  const isoDashPattern = /(\d{4})-(\d{1,2})-(\d{1,2})/;
  const m4 = filename.match(isoDashPattern);
  if (m4) {
    const year = parseInt(m4[1], 10);
    const month = parseInt(m4[2], 10) - 1;
    if (year >= 2020 && year <= 2099 && month >= 0 && month <= 11) return { year, month };
  }

  return null;
}

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
  matchedColumnIndices: number[]; // indices of name columns (for highlighting on frontend)
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

    // Classify each name column by its semantic role
    type ColRole = 'first' | 'last' | 'subscriber' | 'generic';
    type ClassifiedCol = { index: number; name: string; role: ColRole };

    const classifyColumn = (header: string): ColRole | null => {
      const norm = normalizeHeader(header);
      // Check most specific patterns first
      if (norm.includes('subscriber name') || norm === 'subscriber') return 'subscriber';
      if (norm.includes('member name')) return 'subscriber';
      if (norm.includes('first name') || norm.includes('member first')) return 'first';
      if (norm.includes('last name') || norm.includes('member last')) return 'last';
      return null;
    };

    const classifiedCols: ClassifiedCol[] = [];
    headers.forEach((h, i) => {
      const role = classifyColumn(h);
      if (role) {
        classifiedCols.push({ index: i, name: h, role });
      }
    });

    if (classifiedCols.length === 0) return null;

    const matchedColumnIndices = classifiedCols.map(c => c.index);
    const matchedColumnNames = classifiedCols.map(c => c.name);
    const firstCols = classifiedCols.filter(c => c.role === 'first');
    const lastCols = classifiedCols.filter(c => c.role === 'last');
    const subscriberCols = classifiedCols.filter(c => c.role === 'subscriber');

    // Normalize: lowercase and strip non-alphabetic characters
    // So "BEENE, ALICE" -> "beenealice", "Alice Beene" -> "alicebeene"
    const normalize = (s: string): string =>
      String(s || '').toLowerCase().replace(/[^a-z]/g, '');

    const rawQuery = query.trim();
    if (rawQuery.length === 0) return null;

    const words = rawQuery.split(/\s+/).filter(w => w.length > 0);

    // For each row, determine which terms matched
    type MatchedRow = { row: string[]; matchedTerms: string[] };
    const matchedRows: MatchedRow[] = [];

    if (words.length === 2) {
      // AND logic: both words must appear together in a name pattern
      const w1 = normalize(words[0]);
      const w2 = normalize(words[1]);
      const combinedLabel = words.join(' ');
      if (w1.length === 0 || w2.length === 0) return null;

      allRows.forEach((row) => {
        // Get normalized values for each role
        const firstVals = firstCols.map(c => normalize(String(row[c.index] || '')));
        const lastVals = lastCols.map(c => normalize(String(row[c.index] || '')));
        const subscriberVals = subscriberCols.map(c => normalize(String(row[c.index] || '')));

        // Condition 1: w1 in first AND w2 in last
        const cond1 =
          firstVals.some(v => v.includes(w1)) &&
          lastVals.some(v => v.includes(w2));

        // Condition 2 (reverse): w2 in first AND w1 in last
        const cond2 =
          firstVals.some(v => v.includes(w2)) &&
          lastVals.some(v => v.includes(w1));

        // Condition 3: both words in subscriber name (any order)
        const cond3 = subscriberVals.some(v => v.includes(w1) && v.includes(w2));

        if (cond1 || cond2 || cond3) {
          matchedRows.push({ row, matchedTerms: [words[0], words[1], combinedLabel] });
        }
      });
    } else {
      // Single word OR 3+ words: OR logic across all name columns (treat each word separately)
      const wordNormals = words.map(w => ({ label: w, normalized: normalize(w) }))
        .filter(w => w.normalized.length > 0);
      if (wordNormals.length === 0) return null;

      allRows.forEach((row) => {
        const cellBlobs = matchedColumnIndices.map((idx) => normalize(String(row[idx] || '')));
        const termsHit: string[] = [];

        for (const w of wordNormals) {
          if (cellBlobs.some(blob => blob.includes(w.normalized))) {
            termsHit.push(w.label);
          }
        }

        if (termsHit.length > 0) {
          matchedRows.push({ row, matchedTerms: termsHit });
        }
      });
    }

    if (matchedRows.length === 0) return null;

    return {
      fileKey: key,
      filename,
      system,
      headers,
      rows: matchedRows.slice(0, 50).map(m => m.row),
      matchedTermsPerRow: matchedRows.slice(0, 50).map(m => m.matchedTerms),
      matchedColumns: matchedColumnNames,
      matchedColumnIndices, // NEW: indices of name columns in this file (for highlighting)
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
        if (!lower.endsWith('.csv') && !lower.endsWith('.xlsx') && !lower.endsWith('.xls')) continue;

        // Hardcoded: only search May 2026 files (change this when filter changes in page.tsx)
        // Filter: only files from May 2026 onwards
        const filename = obj.Key.split('/').pop() || obj.Key;
        const detected = detectMonthYearForSearch(filename);
        if (!detected) continue;
        if (detected.year < 2026) continue;
        if (detected.year === 2026 && detected.month < 4) continue; // 4 = May
        // (month 4 = May, since JS months are 0-indexed: January=0, May=4)

        fileKeys.push(obj.Key);
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