// Located at: app/api/master/route.ts
//
// Aggregates rows from all May 2026 files into the Master Dashboard format.
// Each row has fixed columns: Member Name, Plan Name, Anthem ID, Payment,
// City, State, Address 1, Address 2, Email, Phone, Effective Date, Term Date,
// File, Source System, Coverage Tier.

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

// ========== Date detection for filter ==========
const MONTH_LOOKUP: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

function detectMonthYearForFilter(filename: string): { year: number; month: number } | null {
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
    if (month !== undefined && yy >= 20 && yy <= 99) return { year: 2000 + yy, month };
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

// ========== File-to-display-name mapping ==========
// Order matters: most specific patterns first.
type FileClassification = { fileLabel: string; sourceSystem: string };

function classifyFile(filename: string): FileClassification {
  const lower = filename.toLowerCase();

  // Check most specific patterns first (T1 vs T3 before generic Corechoice)
  if (lower.includes('corechoice direct t1') || lower.includes('corechoice_direct_t1')) {
    return { fileLabel: 'GWU2', sourceSystem: 'Decisely' };
  }
  if (lower.includes('corechoice direct t3') || lower.includes('corechoice_direct_t3')) {
    return { fileLabel: 'GWU', sourceSystem: 'Decisely' };
  }
  if (lower.includes('ny-practice') || lower.includes('nyp')) {
    return { fileLabel: 'Enroll Confidently', sourceSystem: 'EP6' };
  }
  if (lower.includes('gwu3')) {
    return { fileLabel: 'GWU3', sourceSystem: 'TPA' };
  }
  if (lower.includes('cassena')) {
    return { fileLabel: 'Cassena', sourceSystem: 'TPA' };
  }
  if (lower.includes('ep6')) {
    return { fileLabel: 'EP6', sourceSystem: 'EP6' };
  }
  if (lower.includes('bdsb')) {
    return { fileLabel: 'BDSB', sourceSystem: 'TPA' };
  }
  if (lower.includes('northstead')) {
    return { fileLabel: 'Northstead', sourceSystem: 'Northstead' };
  }
  if (lower.includes('refresh')) {
    return { fileLabel: 'Refresh', sourceSystem: 'Refresh' };
  }
  // GIG matched last because "gig" is short and could appear elsewhere
  if (/\bgig\b/i.test(filename) || lower.includes('_gig_') || lower.startsWith('gig')) {
    return { fileLabel: 'GIG', sourceSystem: 'TPA' };
  }

  return { fileLabel: 'unknown', sourceSystem: 'unknown' };
}

// ========== Column matching ==========
function normalizeHeader(h: string): string {
  return String(h || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function findCol(headers: string[], candidates: string[], strict: boolean = false): number {
  const normalizedHeaders = headers.map(normalizeHeader);
  // First try exact match (preferred)
  for (const cand of candidates) {
    const candNorm = cand.toLowerCase();
    const idx = normalizedHeaders.findIndex(h => h === candNorm);
    if (idx !== -1) return idx;
  }
  // For non-strict columns, fall back to substring contains match
  if (!strict) {
    for (const cand of candidates) {
      const candNorm = cand.toLowerCase();
      const idx = normalizedHeaders.findIndex(h => h.includes(candNorm));
      if (idx !== -1) return idx;
    }
  }
  return -1;
}

function getCell(row: string[], idx: number): string {
  if (idx < 0) return '';
  return String(row[idx] || '').trim();
}

// ========== Member name construction ==========
function buildMemberName(
  row: string[],
  subscriberIdx: number,
  firstIdx: number,
  lastIdx: number,
  memberFirstIdx: number,
  memberLastIdx: number,
): string {
  const subscriber = getCell(row, subscriberIdx);
  const first = getCell(row, firstIdx);
  const last = getCell(row, lastIdx);
  const memFirst = getCell(row, memberFirstIdx);
  const memLast = getCell(row, memberLastIdx);

  // Priority 1: SUBSCRIBER NAME if populated (already a full name)
  if (subscriber) return subscriber;

  // Priority 2: FIRST NAME + LAST NAME both populated
  if (first && last) return `${first} ${last}`;

  // Priority 3: MEMBER FIRST + MEMBER LAST both populated
  if (memFirst && memLast) return `${memFirst} ${memLast}`;

  // Priority 4: any single populated field
  if (first) return first;
  if (last) return last;
  if (memFirst) return memFirst;
  if (memLast) return memLast;

  return '';
}

// ========== Date and amount formatting ==========
function formatDate(value: string): string {
  if (!value) return '-';
  const s = String(value).trim();
  if (!s) return '-';

  // Try parsing as Excel serial number (number of days since 1900-01-01)
  // Excel dates are typically 4-digit to 5-digit numbers
  const num = Number(s);
  if (!isNaN(num) && num > 1 && num < 100000 && Number.isFinite(num)) {
    // Excel: serial 1 = 1900-01-01, with a known 1900 leap year bug.
    // Use the standard formula adopted by SheetJS and most libraries:
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const ms = excelEpoch.getTime() + num * 86400000;
    const d = new Date(ms);
    if (!isNaN(d.getTime()) && d.getFullYear() > 1900 && d.getFullYear() < 2100) {
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      return `${mm}/${dd}/${d.getUTCFullYear()}`;
    }
  }

  // Try parsing as a date string
  const d = new Date(s);
  if (!isNaN(d.getTime()) && d.getFullYear() > 1900 && d.getFullYear() < 2100) {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mm}/${dd}/${d.getFullYear()}`;
  }

  // Return as-is if can't parse
  return s;
}

function formatPayment(value: string): string {
  if (!value) return '-';
  const s = String(value).trim().replace(/[$,]/g, '');
  if (!s) return '-';
  const num = Number(s);
  if (isNaN(num)) return '-';
  return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ========== Buffer streaming ==========
async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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

// ========== Master row type ==========
type MasterRow = {
  memberName: string;
  planName: string;
  anthemId: string;
  payment: string;
  city: string;
  state: string;
  address1: string;
  address2: string;
  email: string;
  phone: string;
  effectiveDate: string;
  termDate: string;
  file: string;
  sourceSystem: string;
  coverageTier: string;
};

// ========== Per-file extraction ==========
async function extractFromFile(key: string): Promise<MasterRow[]> {
  try {
    const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const res = await s3.send(cmd);
    if (!res.Body) return [];

    const buffer = await streamToBuffer(res.Body as any);
    const filename = key.split('/').pop() || key;
    const lowerKey = key.toLowerCase();
    const classification = classifyFile(filename);

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
      if (allData.length === 0) return [];

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
      return [];
    }

    // Name columns use STRICT matching (exact header match only).
    // Without strict, "Subscriber Key" would falsely match "subscriber".
    const subscriberIdx = findCol(headers, ['subscriber name', 'member name'], true);
    const firstIdx = findCol(headers, ['first name'], true);
    const lastIdx = findCol(headers, ['last name'], true);
    const memberFirstIdx = findCol(headers, ['member first', 'member first name'], true);
    const memberLastIdx = findCol(headers, ['member last', 'member last name'], true);

    const planNameIdx = findCol(headers, ['plan name', 'class/plan', 'class plan']);
    const anthemIdIdx = findCol(headers, ['anthem id']);
    const welfareIdx = findCol(headers, ['welfare amount', '426 hbf welfare due', 'welfare due']);
    const cityIdx = findCol(headers, ['city']);
    const stateIdx = findCol(headers, ['state']);
    const address1Idx = findCol(headers, ['address 1', 'address1', 'address line 1']);
    const address2Idx = findCol(headers, ['address 2', 'address2', 'address line 2']);
    const emailIdx = findCol(headers, ['email address', 'email']);
    const phoneIdx = findCol(headers, ['phone number', 'phone']);
    const effectiveDateIdx = findCol(headers, ['effective date']);
    const termDateIdx = findCol(headers, ['term date', 'termination date']);
    const coverageIdx = findCol(headers, ['coverage tier', 'coverage type']);

    const masterRows: MasterRow[] = [];

    for (const row of allRows) {
      const memberName = buildMemberName(
        row, subscriberIdx, firstIdx, lastIdx, memberFirstIdx, memberLastIdx
      );
      if (!memberName) continue; // Skip rows without a name

      masterRows.push({
        memberName,
        planName: getCell(row, planNameIdx) || '-',
        anthemId: getCell(row, anthemIdIdx) || '-',
        payment: formatPayment(getCell(row, welfareIdx)),
        city: getCell(row, cityIdx) || '-',
        state: getCell(row, stateIdx) || '-',
        address1: getCell(row, address1Idx) || '-',
        address2: getCell(row, address2Idx) || '-',
        email: getCell(row, emailIdx) || '-',
        phone: getCell(row, phoneIdx) || '-',
        effectiveDate: formatDate(getCell(row, effectiveDateIdx)),
        termDate: formatDate(getCell(row, termDateIdx)),
        file: classification.fileLabel,
        sourceSystem: classification.sourceSystem,
        coverageTier: getCell(row, coverageIdx) || '-',
      });
    }

    return masterRows;
  } catch (err) {
    console.error(`Error extracting from ${key}:`, err);
    return [];
  }
}

// ========== Main handler ==========
export async function GET() {
  try {
    // List all S3 objects in May 2026
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

        // Filter: only files from May 2026 onwards
        const filename = obj.Key.split('/').pop() || obj.Key;
        const detected = detectMonthYearForFilter(filename);
        if (!detected) continue;
        if (detected.year < 2026) continue;
        if (detected.year === 2026 && detected.month < 4) continue; // 4 = May

        fileKeys.push(obj.Key);
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);

    // Extract rows from all files in parallel
    const perFileRows = await Promise.all(fileKeys.map(extractFromFile));
    const allRows = perFileRows.flat();

    return NextResponse.json({
      totalRows: allRows.length,
      filesProcessed: fileKeys.length,
      rows: allRows,
    });
  } catch (err: any) {
    console.error('Master dashboard error:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to build master dashboard' },
      { status: 500 }
    );
  }
}