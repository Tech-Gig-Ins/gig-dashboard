// Located at: app/api/master/route.ts
//
// Builds the Master Dashboard data with three sections:
// - activeMembers: unique members in May 2026 files
// - terminatedMembers: members in older month but missing from next month (term date = end of older month)
// - newMembers: members in newer month but missing from previous month (effective date = first of newer month)
//
// Fetches ALL files (no month filter) so we can do month-over-month comparisons.
// Member identity: normalized name + file classification.

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

// ========== Date detection ==========
const MONTH_LOOKUP: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

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

// ========== File classification ==========
type FileClassification = { fileLabel: string; sourceSystem: string };

function classifyFile(filename: string): FileClassification {
  const lower = filename.toLowerCase();
  if (lower.includes('corechoice direct t1') || lower.includes('corechoice_direct_t1')) return { fileLabel: 'GWU2', sourceSystem: 'Decisely' };
  if (lower.includes('corechoice direct t3') || lower.includes('corechoice_direct_t3')) return { fileLabel: 'GWU', sourceSystem: 'Decisely' };
  if (lower.includes('ny-practice') || lower.includes('nyp')) return { fileLabel: 'Enroll Confidently', sourceSystem: 'EP6' };
  if (lower.includes('gwu3')) return { fileLabel: 'GWU3', sourceSystem: 'TPA' };
  if (lower.includes('cassena')) return { fileLabel: 'Cassena', sourceSystem: 'TPA' };
  if (lower.includes('ep6')) return { fileLabel: 'EP6', sourceSystem: 'EP6' };
  if (lower.includes('bdsb')) return { fileLabel: 'BDSB', sourceSystem: 'TPA' };
  if (lower.includes('northstead')) return { fileLabel: 'Northstead', sourceSystem: 'Northstead' };
  if (lower.includes('refresh')) return { fileLabel: 'Refresh', sourceSystem: 'Refresh' };
  if (/\bgig\b/i.test(filename) || lower.includes('_gig_') || lower.startsWith('gig')) return { fileLabel: 'GIG', sourceSystem: 'TPA' };
  return { fileLabel: 'unknown', sourceSystem: 'unknown' };
}

// ========== Column matching ==========
function normalizeHeader(h: string): string {
  return String(h || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function findCol(headers: string[], candidates: string[], strict: boolean = false): number {
  const normalizedHeaders = headers.map(normalizeHeader);
  for (const cand of candidates) {
    const candNorm = cand.toLowerCase();
    const idx = normalizedHeaders.findIndex(h => h === candNorm);
    if (idx !== -1) return idx;
  }
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
  if (subscriber) return subscriber;
  if (first && last) return `${first} ${last}`;
  if (memFirst && memLast) return `${memFirst} ${memLast}`;
  if (first) return first;
  if (last) return last;
  if (memFirst) return memFirst;
  if (memLast) return memLast;
  return '';
}

function normalizeName(name: string): string {
  return String(name || '').toLowerCase().replace(/[^a-z]/g, '');
}

function formatPayment(value: string): string {
  if (!value) return '-';
  const s = String(value).trim().replace(/[$,]/g, '');
  if (!s) return '-';
  const num = Number(s);
  if (isNaN(num)) return '-';
  return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && text[i - 1] !== '\\') { inQuotes = !inQuotes; current += c; }
    else if (c === '\n' && !inQuotes) { lines.push(current); current = ''; }
    else if (c === '\r' && !inQuotes) { /* skip */ }
    else { current += c; }
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
      } else if (c === ',' && !inQ) { fields.push(field); field = ''; }
      else field += c;
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

// ========== Data structures ==========
type MemberRecord = {
  memberName: string;
  normalizedName: string;
  planName: string;
  anthemId: string;
  payment: string;
  city: string;
  state: string;
  address1: string;
  address2: string;
  email: string;
  phone: string;
  file: string;
  sourceSystem: string;
  coverageTier: string;
};

type MasterActiveRow = MemberRecord;
type MasterTerminatedRow = MemberRecord & { terminationDate: string };
type MasterNewRow = MemberRecord & { effectiveDate: string };

// monthKey: "2026-04" for May 2026 (month is 0-indexed)
function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month]} ${year}`;
}

function lastDayOfMonth(year: number, month: number): string {
  // month 0-indexed. JavaScript trick: day 0 of next month = last day of current month
  const d = new Date(year, month + 1, 0);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function firstDayOfMonth(year: number, month: number): string {
  const mm = String(month + 1).padStart(2, '0');
  return `${mm}/01/${year}`;
}

// ========== Per-file extraction ==========
async function extractFromFile(key: string): Promise<MemberRecord[]> {
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

      let headerRowIdx = 0;
      const isCassenaStyle =
        !lowerKey.includes('nyp') &&
        !lowerKey.includes('corechoice') &&
        allData[0] &&
        allData[0].filter((v: any) => v !== '' && v != null).length < 3;
      if (isCassenaStyle) {
        for (let i = 0; i < Math.min(25, allData.length); i++) {
          const nonEmpty = allData[i].filter((v: any) => v !== '' && v != null).length;
          if (nonEmpty >= 5) { headerRowIdx = i; break; }
        }
      }

      headers = (allData[headerRowIdx] || []).map((v: any) => String(v ?? ''));
      allRows = allData.slice(headerRowIdx + 1).filter((r) =>
        r.some((v: any) => v !== '' && v != null)
      ).map((r) => headers.map((_h, i) => String(r[i] ?? '')));
    } else {
      return [];
    }

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
    const coverageIdx = findCol(headers, ['coverage tier', 'coverage type']);

    const records: MemberRecord[] = [];

    for (const row of allRows) {
      const memberName = buildMemberName(row, subscriberIdx, firstIdx, lastIdx, memberFirstIdx, memberLastIdx);
      if (!memberName) continue;
      const normalizedName = normalizeName(memberName);
      if (!normalizedName) continue;

      records.push({
        memberName,
        normalizedName,
        planName: getCell(row, planNameIdx) || '-',
        anthemId: getCell(row, anthemIdIdx) || '-',
        payment: formatPayment(getCell(row, welfareIdx)),
        city: getCell(row, cityIdx) || '-',
        state: getCell(row, stateIdx) || '-',
        address1: getCell(row, address1Idx) || '-',
        address2: getCell(row, address2Idx) || '-',
        email: getCell(row, emailIdx) || '-',
        phone: getCell(row, phoneIdx) || '-',
        file: classification.fileLabel,
        sourceSystem: classification.sourceSystem,
        coverageTier: getCell(row, coverageIdx) || '-',
      });
    }

    return records;
  } catch (err) {
    console.error(`Error extracting from ${key}:`, err);
    return [];
  }
}

// Identity key: normalized name + file classification
function identityKey(record: { normalizedName: string; file: string }): string {
  return `${record.normalizedName}|${record.file}`;
}

// ========== Main handler ==========
export async function GET() {
  try {
    // List ALL S3 objects (no month filter, we need history for comparisons)
    type FileInfo = { key: string; year: number; month: number };
    const files: FileInfo[] = [];
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
        const filename = obj.Key.split('/').pop() || obj.Key;
        const detected = detectMonthYearForFilter(filename);
        if (!detected) continue;
        // Include all files on or before May 2026
        if (detected.year > 2026) continue;
        if (detected.year === 2026 && detected.month > 4) continue; // 4 = May, skip June onwards
        files.push({ key: obj.Key, year: detected.year, month: detected.month });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);

    // Group files by month
    const filesByMonth: Map<string, FileInfo[]> = new Map();
    for (const f of files) {
      const mk = monthKey(f.year, f.month);
      if (!filesByMonth.has(mk)) filesByMonth.set(mk, []);
      filesByMonth.get(mk)!.push(f);
    }

    // Get sorted list of month keys (oldest to newest)
    const sortedMonths = Array.from(filesByMonth.keys()).sort();

    // Extract records for each month
    type MonthData = {
      mk: string;
      year: number;
      month: number;
      label: string;
      records: MemberRecord[];
      identityMap: Map<string, MemberRecord>; // identityKey -> record
    };

    const monthData: MonthData[] = [];
    for (const mk of sortedMonths) {
      const filesForMonth = filesByMonth.get(mk)!;
      const allRecordsArrays = await Promise.all(filesForMonth.map(f => extractFromFile(f.key)));
      const records = allRecordsArrays.flat();

      // Build identity map (dedupe within month: keep first occurrence)
      const identityMap = new Map<string, MemberRecord>();
      for (const r of records) {
        const id = identityKey(r);
        if (!identityMap.has(id)) {
          identityMap.set(id, r);
        }
      }

      const [yearStr, monthStr] = mk.split('-');
      const year = parseInt(yearStr, 10);
      const month = parseInt(monthStr, 10);
      monthData.push({
        mk,
        year,
        month,
        label: monthLabel(year, month),
        records,
        identityMap,
      });
    }

    // ========== Active Members: members in May 2026 ==========
    const mayKey = monthKey(2026, 4);
    const mayData = monthData.find(m => m.mk === mayKey);
    const activeMembers: MasterActiveRow[] = mayData
      ? Array.from(mayData.identityMap.values())
      : [];

    // ========== Terminated Members ==========
    // For each consecutive pair (older, newer), find identities in older NOT in newer.
    // Their termination date = last day of older month.
    const terminatedMembers: MasterTerminatedRow[] = [];
    for (let i = 0; i < monthData.length - 1; i++) {
      const older = monthData[i];
      const newer = monthData[i + 1];
      for (const [id, record] of older.identityMap) {
        if (!newer.identityMap.has(id)) {
          terminatedMembers.push({
            ...record,
            terminationDate: lastDayOfMonth(older.year, older.month),
          });
        }
      }
    }

    // ========== New Members ==========
    // For each consecutive pair (older, newer), find identities in newer NOT in older.
    // Their effective date = first day of newer month.
    // Skip the oldest month (everyone in oldest is considered baseline, not new).
    const newMembers: MasterNewRow[] = [];
    for (let i = 1; i < monthData.length; i++) {
      const older = monthData[i - 1];
      const newer = monthData[i];
      for (const [id, record] of newer.identityMap) {
        if (!older.identityMap.has(id)) {
          newMembers.push({
            ...record,
            effectiveDate: firstDayOfMonth(newer.year, newer.month),
          });
        }
      }
    }

    return NextResponse.json({
      monthsProcessed: sortedMonths.map(mk => {
        const [yStr, mStr] = mk.split('-');
        return monthLabel(parseInt(yStr, 10), parseInt(mStr, 10));
      }),
      activeCount: activeMembers.length,
      terminatedCount: terminatedMembers.length,
      newCount: newMembers.length,
      activeMembers,
      terminatedMembers,
      newMembers,
    });
  } catch (err: any) {
    console.error('Master dashboard error:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to build master dashboard' },
      { status: 500 }
    );
  }
}