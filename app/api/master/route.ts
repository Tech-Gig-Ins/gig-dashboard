// Located at: app/api/master/route.ts
//
// Builds the Master Dashboard data with three sections:
// - activeMembers: unique members in the LATEST month available
// - terminatedMembers: members in older month but missing from next month (term date = end of older month)
// - newMembers: members in newer month but missing from previous month (effective date = first of newer month)
//
// Fetches all files from June 2026 onwards (no upper bound, so future months auto-appear
// when their files land in S3). Member identity: normalized name + file classification + normalized group.

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

// Canonical list of the 16 files expected in each month.
// Used both for classification labels and for detecting missing files per month.
const CANONICAL_FILES = [
  'Cassena Remittance',
  'Cassena Credits',
  'EP6 Remittance',
  'NYP Remittance',
  'BDSB Remittance',
  'BDSB Credits',
  'Corechoice T1',
  'Corechoice T3',
  'Gig Remittance',
  'Gig Credits',
  'Delta Dental',
  'GWU3 Remittance',
  'GWU3 Credits',
  'Northstead Remittance',
  'Northstead Credits',
  'Refresh',
  'Enroll Confidently or PIOPAC',
] as const;

// Order matters: first match wins. More specific rules go before less specific ones.
// For carriers with Remittance/Credits variants (Cassena, BDSB, GWU3, Northstead, Gig)
// the filename MUST contain either "remittance" or "credits" to classify - files
// with just the carrier name (no variant keyword) fall through to "unknown" so they
// don't get silently misclassified as Remittance.
function classifyFile(filename: string): FileClassification {
  const lower = filename.toLowerCase();
  const hasRemittance = lower.includes('remittance');
  const hasCredits = lower.includes('credits');

  // Corechoice T1 / T3 (check before other rules)
  if (lower.includes('corechoice')) {
    if (lower.includes('t1')) return { fileLabel: 'Corechoice T1', sourceSystem: 'Decisely' };
    if (lower.includes('t3')) return { fileLabel: 'Corechoice T3', sourceSystem: 'Decisely' };
  }

  // Delta Dental: both "delta" and "dental" present in any order
  if (lower.includes('delta') && lower.includes('dental')) {
    return { fileLabel: 'Delta Dental', sourceSystem: 'Delta Dental' };
  }

  // NYP: filename contains "nyp" or "ny-practice" / "ny practice"
  if (lower.includes('nyp') || lower.includes('ny-practice') || lower.includes('ny practice')) {
    return { fileLabel: 'NYP Remittance', sourceSystem: 'EP6' };
  }

  // Enroll Confidently OR PIOPAC (case-insensitive; filename already lowercased)
  if (lower.includes('enroll confidently') || lower.includes('piopac')) {
    return { fileLabel: 'Enroll Confidently or PIOPAC', sourceSystem: 'EP6' };
  }

  // Cassena (strict: must have remittance OR credits keyword)
  if (lower.includes('cassena')) {
    if (hasCredits) return { fileLabel: 'Cassena Credits', sourceSystem: 'TPA' };
    if (hasRemittance) return { fileLabel: 'Cassena Remittance', sourceSystem: 'TPA' };
    // Falls through to unknown - file has "cassena" but no variant keyword
  }

  // BDSB (strict: must have remittance OR credits keyword)
  if (lower.includes('bdsb')) {
    if (hasCredits) return { fileLabel: 'BDSB Credits', sourceSystem: 'TPA' };
    if (hasRemittance) return { fileLabel: 'BDSB Remittance', sourceSystem: 'TPA' };
  }

  // GWU3 (strict: must have remittance OR credits keyword)
  if (lower.includes('gwu3')) {
    if (hasCredits) return { fileLabel: 'GWU3 Credits', sourceSystem: 'TPA' };
    if (hasRemittance) return { fileLabel: 'GWU3 Remittance', sourceSystem: 'TPA' };
  }

  // Northstead (strict: must have remittance OR credits keyword) - source is TPA
  if (lower.includes('northstead')) {
    if (hasCredits) return { fileLabel: 'Northstead Credits', sourceSystem: 'TPA' };
    if (hasRemittance) return { fileLabel: 'Northstead Remittance', sourceSystem: 'TPA' };
  }

  // EP6
  if (lower.includes('ep6')) {
    return { fileLabel: 'EP6 Remittance', sourceSystem: 'EP6' };
  }

  // Gig (Remittance / Credits) - stricter whole-word check to avoid false positives
  // AND must have remittance or credits keyword
  if (/\bgig\b/i.test(filename) || lower.includes('_gig_') || lower.startsWith('gig')) {
    if (hasCredits) return { fileLabel: 'Gig Credits', sourceSystem: 'TPA' };
    if (hasRemittance) return { fileLabel: 'Gig Remittance', sourceSystem: 'TPA' };
  }

  // Refresh
  if (lower.includes('refresh')) {
    return { fileLabel: 'Refresh', sourceSystem: 'Refresh' };
  }

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

// Build the "Group" value from one of three possible columns.
// Priority: Employer Name > Employer > L426 Shop. Returns '' if none populated.
function buildGroup(
  row: string[],
  employerNameIdx: number,
  employerIdx: number,
  l426ShopIdx: number,
): string {
  const employerName = getCell(row, employerNameIdx);
  if (employerName) return employerName;
  const employer = getCell(row, employerIdx);
  if (employer) return employer;
  const l426Shop = getCell(row, l426ShopIdx);
  if (l426Shop) return l426Shop;
  return '';
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
  group: string;
  normalizedGroup: string;
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

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month]} ${year}`;
}

function lastDayOfMonth(year: number, month: number): string {
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

    const employerNameIdx = findCol(headers, ['employer name'], true);
    const employerIdx = findCol(headers, ['employer'], true);
    const l426ShopIdx = findCol(headers, ['l426 shop', 'local 426 shop'], true);

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

      const group = buildGroup(row, employerNameIdx, employerIdx, l426ShopIdx);
      const normalizedGroup = normalizeName(group);

      records.push({
        memberName,
        normalizedName,
        group: group || '-',
        normalizedGroup,
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

function identityKey(record: { normalizedName: string; file: string; normalizedGroup: string }): string {
  return `${record.normalizedName}|${record.file}|${record.normalizedGroup}`;
}

// ========== Main handler ==========
export async function GET() {
  try {
    // List S3 objects under the "carrier=" prefix only. This skips billing-sources/,
    // billing-reports/, billing-updates/, and any other non-carrier folder - which is
    // why files like Reconciliation_Output_<month>.xlsx don't show up as "unknown".
    type FileInfo = { key: string; year: number; month: number; fileLabel: string };
    const files: FileInfo[] = [];
    let token: string | undefined = undefined;
    do {
      const cmd: ListObjectsV2Command = new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: 'carrier=',
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
        // Include only files from June 2026 onwards. Anything earlier is excluded.
        if (detected.year < 2026) continue;
        if (detected.year === 2026 && detected.month < 5) continue; // 5 = June
        const classification = classifyFile(filename);
        files.push({
          key: obj.Key,
          year: detected.year,
          month: detected.month,
          fileLabel: classification.fileLabel,
        });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);

    // Group files by month AND track which canonical file labels are present each month
    const filesByMonth: Map<string, FileInfo[]> = new Map();
    const labelsByMonth: Map<string, Set<string>> = new Map();
    for (const f of files) {
      const mk = monthKey(f.year, f.month);
      if (!filesByMonth.has(mk)) filesByMonth.set(mk, []);
      if (!labelsByMonth.has(mk)) labelsByMonth.set(mk, new Set<string>());
      filesByMonth.get(mk)!.push(f);
      labelsByMonth.get(mk)!.add(f.fileLabel);
    }

    // Sort months oldest -> newest
    const sortedMonths = Array.from(filesByMonth.keys()).sort();

    // Extract records for each month
    type MonthData = {
      mk: string;
      year: number;
      month: number;
      label: string;
      records: MemberRecord[];
      identityMap: Map<string, MemberRecord>;
    };

    const monthData: MonthData[] = [];
    for (const mk of sortedMonths) {
      const filesForMonth = filesByMonth.get(mk)!;
      const allRecordsArrays = await Promise.all(filesForMonth.map(f => extractFromFile(f.key)));
      const records = allRecordsArrays.flat();

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

    // Active members = whoever is in the LATEST month with data.
    // monthData is sorted oldest -> newest, so last element is the newest month.
    const latestMonth = monthData.length > 0 ? monthData[monthData.length - 1] : null;
    const activeMembers: MasterActiveRow[] = latestMonth
      ? Array.from(latestMonth.identityMap.values())
      : [];

    // Terminated: for each consecutive pair (older, newer), members in older NOT in newer.
    // Termination date = last day of older month.
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

    // New: for each consecutive pair (older, newer), members in newer NOT in older.
    // Effective date = first day of newer month. Skip the oldest month entirely (baseline, not "new").
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

    // Compute missing files for latest and previous months.
    // Latest month drives the Active Members table; previous drives Terminated + New.
    const previousMonth = monthData.length > 1 ? monthData[monthData.length - 2] : null;

    const latestMonthKey = latestMonth?.mk;
    const previousMonthKey = previousMonth?.mk;
    const latestLabels = latestMonthKey ? (labelsByMonth.get(latestMonthKey) || new Set<string>()) : new Set<string>();
    const previousLabels = previousMonthKey ? (labelsByMonth.get(previousMonthKey) || new Set<string>()) : new Set<string>();
    const latestMonthMissingFiles: string[] = CANONICAL_FILES.filter(f => !latestLabels.has(f));
    const previousMonthMissingFiles: string[] = previousMonth
      ? CANONICAL_FILES.filter(f => !previousLabels.has(f))
      : [];

    // Per-file timeline across all processed months. Consumed by the Terminated
    // and New Members tables to show, for each currently-missing file, which
    // months it was present or missing in.
    type FileTimelineEntry = { month: string; present: boolean };
    type FileTimeline = { file: string; lastUpdatedMonth: string | null; history: FileTimelineEntry[] };
    const fileTimelines: FileTimeline[] = CANONICAL_FILES.map(f => {
      const history: FileTimelineEntry[] = monthData.map(m => ({
        month: m.label,
        present: (labelsByMonth.get(m.mk) || new Set<string>()).has(f),
      }));
      // Walk history from newest to oldest to find the last month the file was present
      let lastUpdatedMonth: string | null = null;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].present) { lastUpdatedMonth = history[i].month; break; }
      }
      return { file: f, lastUpdatedMonth, history };
    });

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
      latestMonthLabel: latestMonth?.label || null,
      previousMonthLabel: previousMonth?.label || null,
      latestMonthMissingFiles,
      previousMonthMissingFiles,
      fileTimelines,
    });
  } catch (err: any) {
    console.error('Master dashboard error:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to build master dashboard' },
      { status: 500 }
    );
  }
}