// app/api/welfare/route.ts
//
// GET ?month=August%202026
//
// Builds the "Wire Payments to NY Practice" table from the files included for
// that month in the All Info tab. Admin only.
//
// Column formulas, taken from GIG_NYP_Payments_TEMPLATE.xlsx Sheet1 rows 4-11:
//     GIG Cap Fee = Enrolled     x fee rate
//     Credit Fees = Credit Count x fee rate
//     NYP Wire    = Remittance Amount - GIG Cap Fee - Credit Amount + Credit Fees
//
// Fee rates come from the reference block at Sheet1 K20:L29 only. The Source
// Detail tab is deliberately ignored: it documents a different Cassena rate
// (131 vs 94) and the operator confirmed the K-block is authoritative. Refresh
// uses 142 for BOTH cap fee and credit fee; the template's 141 in column H is
// the error its own notes flag.

import { NextRequest, NextResponse } from 'next/server';
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import * as XLSX from 'xlsx';
import { requireAdmin } from '@/lib/auth';

const REGION = process.env.MY_AWS_REGION || 'us-east-1';
const BUCKET = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  },
});

const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];

// --- the eight table rows -------------------------------------------------
// `label`       exactly as it appears in the template's column B
// `remittance`  fileLabel to match, or null for rows with no associated file
//               (the operator asked that those rows render with empty figures)
// `credits`     fileLabel of the matching credits file, or null
// `rate`        fee rate from Sheet1 K20:L29
// `groupFilter` Hartford is not its own file: it is the rows of the Corechoice
//               T3 remittance whose Group is HARTFORD FUNDING, LTD.
type RowSpec = {
  label: string;
  remittance: string | null;
  credits: string | null;
  rate: number;
  groupFilter?: string;
};

const ROWS: RowSpec[] = [
  { label: 'Cassena',          remittance: 'Cassena Remittance',    credits: 'Cassena Credits',    rate: 94 },
  { label: 'Tpa.com',          remittance: 'Gig Remittance',        credits: 'Gig Credits',        rate: 131 },
  { label: 'GIG Credit Cards', remittance: null,                    credits: null,                 rate: 120 },
  { label: 'Hartford',         remittance: 'Corechoice T3',         credits: null,                 rate: 54,
    groupFilter: 'HARTFORD FUNDING, LTD.' },
  { label: 'GWU3',             remittance: 'GWU3 Remittance',       credits: 'GWU3 Credits',       rate: 131 },
  { label: 'BDSB',             remittance: 'BDSB Remittance',       credits: 'BDSB Credits',       rate: 131 },
  { label: 'Northstead',       remittance: 'Northstead Remittance', credits: 'Northstead Credits', rate: 142 },
  { label: 'Refresh',          remittance: 'Refresh',               credits: null,                 rate: 142 },
  { label: 'EP6',              remittance: 'EP6 Remittance',        credits: null,                 rate: 142 },
  { label: 'PIOPAC',           remittance: 'Enroll Confidently or PIOPAC', credits: null,           rate: 142 },
];

// ---------- shared helpers (mirrors app/api/master/route.ts) ----------------
const norm = (h: string) => String(h || '').toLowerCase().replace(/\s+/g, ' ').trim();
const normName = (n: string) => String(n || '').toLowerCase().replace(/[^a-z]/g, '');

function findCol(headers: string[], candidates: string[], strict = false): number {
  const nh = headers.map(norm);
  for (const c of candidates) {
    const i = nh.findIndex(h => h === c.toLowerCase());
    if (i !== -1) return i;
  }
  if (!strict) {
    for (const c of candidates) {
      const i = nh.findIndex(h => h.includes(c.toLowerCase()));
      if (i !== -1) return i;
    }
  }
  return -1;
}
const cell = (row: any[], i: number) => (i < 0 ? '' : String(row[i] ?? '').trim());

// Amount column. Strict pass first so 'price' cannot be matched by a stray
// header like 'Price Tier' before the real column is considered.
const AMOUNT_COLS = ['426 hbf welfare due', 'welfare amount', 'welfare due', 'price', 'premium amount'];

function toNumber(v: string): number {
  if (!v) return 0;
  const s = String(v).replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function monthToPrefix(label: string): string | null {
  const p = String(label || '').trim().split(/\s+/);
  if (p.length !== 2) return null;
  const mi = MONTH_NAMES.findIndex(m => m.toLowerCase() === p[0].toLowerCase());
  const yr = parseInt(p[1], 10);
  if (mi < 0 || !Number.isFinite(yr)) return null;
  return `${yr}-${String(mi + 1).padStart(2, '0')}`;
}

// Same classification rules as the master dashboard, so a file lands in the
// same bucket in both places.
function classify(filename: string): string {
  const l = filename.toLowerCase();
  const rem = l.includes('remittance'), cred = l.includes('credits');
  if (l.includes('corechoice')) {
    if (l.includes('t1')) return 'Corechoice T1';
    if (l.includes('t3')) return 'Corechoice T3';
  }
  if (l.includes('delta') && l.includes('dental')) return 'Delta Dental';
  if (l.includes('nyp') || l.includes('ny practice')) return 'NYP Remittance';
  if (l.includes('enroll confidently') || l.includes('piopac')) return 'Enroll Confidently or PIOPAC';
  if (l.includes('cassena')) { if (cred) return 'Cassena Credits'; if (rem) return 'Cassena Remittance'; }
  if (l.includes('bdsb')) { if (cred) return 'BDSB Credits'; if (rem) return 'BDSB Remittance'; }
  if (l.includes('gwu3')) { if (cred) return 'GWU3 Credits'; if (rem) return 'GWU3 Remittance'; }
  if (l.includes('northstead')) { if (cred) return 'Northstead Credits'; if (rem) return 'Northstead Remittance'; }
  if (l.includes('ep6')) return 'EP6 Remittance';
  if (/\bgig\b/i.test(filename) || l.includes('_gig_') || l.startsWith('gig')) {
    if (cred) return 'Gig Credits'; if (rem) return 'Gig Remittance';
  }
  if (l.includes('refresh')) return 'Refresh';
  return 'unknown';
}

const MONTH_LOOKUP: Record<string, number> = {
  jan:0,january:0,feb:1,february:1,mar:2,march:2,apr:3,april:3,may:4,jun:5,june:5,
  jul:6,july:6,aug:7,august:7,sep:8,sept:8,september:8,oct:9,october:9,
  nov:10,november:10,dec:11,december:11,
};

// Which month a filename belongs to. Same patterns the All Info grouping uses.
function detectMonthYear(filename: string): { year: number; month: number } | null {
  const lower = filename.toLowerCase();
  const m1 = lower.match(/(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s_\-]*(\d{4})/);
  if (m1) {
    const mi = MONTH_LOOKUP[m1[1]];
    const yr = parseInt(m1[2], 10);
    if (mi !== undefined && yr >= 2020 && yr <= 2099) return { year: yr, month: mi };
  }
  const m2 = lower.match(/(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})/);
  if (m2) {
    const mo = parseInt(m2[1], 10) - 1;
    let yr = parseInt(m2[3], 10);
    if (yr < 100) yr += 2000;
    if (mo >= 0 && mo <= 11 && yr >= 2020 && yr <= 2099) return { year: yr, month: mo };
  }
  const m3 = lower.match(/(\d{4})[-_](\d{1,2})/);
  if (m3) {
    const yr = parseInt(m3[1], 10);
    const mo = parseInt(m3[2], 10) - 1;
    if (mo >= 0 && mo <= 11 && yr >= 2020 && yr <= 2099) return { year: yr, month: mo };
  }
  return null;
}

async function toBuffer(body: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

type Parsed = { rowCount: number; distinct: number; amount: number; amountColumn: string };

// Reads one file and returns its figures.
//   amount   sum over EVERY data row - this is real money, and a member on two
//            plans genuinely pays twice
//   distinct unique people, via the master dashboard's identityKey
//   rowCount raw data rows, which is what credit files use
async function parseFile(key: string, groupFilter?: string): Promise<Parsed> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const buf = await toBuffer(obj.Body as any);

  let rows: any[][];
  if (key.toLowerCase().endsWith('.csv')) {
    const text = buf.toString('utf8').replace(/^\uFEFF/, '');
    const wb = XLSX.read(text, { type: 'string' });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false });
  } else {
    const wb = XLSX.read(buf, { type: 'buffer' });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false });
  }

  // Header row = first row containing a recognisable name column. TPA files
  // carry ~15 rows of metadata above the header.
  let hIdx = -1, headers: string[] = [];
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const h = (rows[i] || []).map((c: any) => String(c ?? '').trim());
    if (findCol(h, ['member last', 'last name', 'last'], true) !== -1 ||
        findCol(h, ['subscriber name', 'member name'], true) !== -1) {
      hIdx = i; headers = h; break;
    }
  }
  if (hIdx === -1) return { rowCount: 0, distinct: 0, amount: 0, amountColumn: '(no header found)' };

  let amtIdx = findCol(headers, AMOUNT_COLS, true);
  if (amtIdx === -1) amtIdx = findCol(headers, AMOUNT_COLS, false);

  const subIdx = findCol(headers, ['subscriber name', 'member name'], true);
  const firstIdx = findCol(headers, ['first name', 'first'], true);
  const lastIdx = findCol(headers, ['last name', 'last'], true);
  const mFirst = findCol(headers, ['member first'], true);
  const mLast = findCol(headers, ['member last'], true);
  const empName = findCol(headers, ['employer name'], true);
  const emp = findCol(headers, ['employer'], true);
  const shop = findCol(headers, ['l426 shop'], true);
  const clientGroup = findCol(headers, ['client group', 'group name'], true);

  const seen = new Set<string>();
  let rowCount = 0, amount = 0;

  for (let i = hIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (r.every((c: any) => String(c ?? '').trim() === '')) continue;

    const sub = cell(r, subIdx), f = cell(r, firstIdx), l = cell(r, lastIdx);
    const mf = cell(r, mFirst), ml = cell(r, mLast);
    const name = sub || (f && l ? `${f} ${l}` : (mf && ml ? `${mf} ${ml}` : (f || l || mf || ml)));
    if (!name) continue;

    const group = cell(r, empName) || cell(r, emp) || cell(r, shop) || cell(r, clientGroup);

    // Hartford is a slice of the Corechoice T3 file, not a file of its own.
    if (groupFilter && normName(group) !== normName(groupFilter)) continue;

    rowCount++;
    amount += toNumber(cell(r, amtIdx));
    seen.add(`${normName(name)}|${normName(group)}`);
  }

  return {
    rowCount,
    distinct: seen.size,
    amount,
    amountColumn: amtIdx >= 0 ? headers[amtIdx] : '(none found)',
  };
}

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if (gate instanceof NextResponse) return gate;

  const month = req.nextUrl.searchParams.get('month') || '';
  const prefix = monthToPrefix(month);
  if (!prefix) {
    return NextResponse.json({ error: `Invalid month "${month}"` }, { status: 400 });
  }

  try {
    // Every file All Info shows for this month, NOT just the manifest.
    // Credits files are routinely left un-included so they don't disturb the
    // consultant report, and this table still needs them.
    const [, mm] = prefix.split('-');
    const targetMonth = parseInt(mm, 10) - 1;
    const targetYear = parseInt(prefix.split('-')[0], 10);

    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET, Prefix: 'carrier=', ContinuationToken: token,
      }));
      for (const o of page.Contents || []) {
        const k = o.Key || '';
        if (!k || k.endsWith('/')) continue;
        const lower = k.toLowerCase();
        if (!lower.endsWith('.csv') && !lower.endsWith('.xlsx') && !lower.endsWith('.xls')) continue;
        keys.push(k);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);

    const monthFiles = keys.filter(k => {
      const d = detectMonthYear(k.split('/').pop() || '');
      return d && d.year === targetYear && d.month === targetMonth;
    });

    if (monthFiles.length === 0) {
      return NextResponse.json({
        error: `No files found for ${month}. Check the All Info tab.`,
      }, { status: 404 });
    }

    // fileLabel -> S3 key
    const byLabel = new Map<string, string>();
    for (const key of monthFiles) {
      const label = classify(key.split('/').pop() || '');
      if (label !== 'unknown' && !byLabel.has(label)) byLabel.set(label, key);
    }

    const out = [];
    for (const spec of ROWS) {
      // Rows with no associated file render blank, as requested.
      if (!spec.remittance) {
        out.push({
          label: spec.label, rate: spec.rate, mapped: false,
          remittanceFile: null, creditFile: null,
          amount: null, enrolled: null, capFee: null,
          creditAmount: null, creditCount: null, creditFees: null, nypWire: null,
        });
        continue;
      }

      const remKey = byLabel.get(spec.remittance) || null;
      const credKey = spec.credits ? (byLabel.get(spec.credits) || null) : null;

      const rem = remKey ? await parseFile(remKey, spec.groupFilter) : null;
      // Credits are counted raw: no dedup, per the operator's instruction.
      const cred = credKey ? await parseFile(credKey) : null;

      const amount = rem?.amount ?? 0;
      const enrolled = rem?.distinct ?? 0;
      const capFee = enrolled * spec.rate;
      const creditAmount = cred?.amount ?? 0;
      const creditCount = cred?.rowCount ?? 0;
      const creditFees = creditCount * spec.rate;

      out.push({
        label: spec.label,
        rate: spec.rate,
        mapped: true,
        remittanceFile: remKey ? remKey.split('/').pop() : null,
        creditFile: credKey ? credKey.split('/').pop() : null,
        amountColumn: rem?.amountColumn ?? null,
        rawRows: rem?.rowCount ?? 0,
        amount, enrolled, capFee,
        creditAmount, creditCount, creditFees,
        nypWire: amount - capFee - creditAmount + creditFees,
      });
    }

    const num = (v: number | null) => (typeof v === 'number' ? v : 0);
    const totals = {
      amount: out.reduce((s, r) => s + num(r.amount), 0),
      enrolled: out.reduce((s, r) => s + num(r.enrolled), 0),
      capFee: out.reduce((s, r) => s + num(r.capFee), 0),
      creditAmount: out.reduce((s, r) => s + num(r.creditAmount), 0),
      creditCount: out.reduce((s, r) => s + num(r.creditCount), 0),
      creditFees: out.reduce((s, r) => s + num(r.creditFees), 0),
      nypWire: out.reduce((s, r) => s + num(r.nypWire), 0),
    };

    // Included files that matched no table row, so nothing is silently dropped.
    const usedLabels = new Set(out.flatMap(r => [r.remittanceFile, r.creditFile].filter(Boolean)));
    const unmapped = monthFiles
      .map(k => k.split('/').pop() || '')
      .filter(n => n && !usedLabels.has(n));

    return NextResponse.json({ month, monthPrefix: prefix, rows: out, totals, unmapped });
  } catch (err: any) {
    console.error('[welfare] error:', err);
    return NextResponse.json({ error: err.message || 'Failed to build the welfare table' }, { status: 500 });
  }
}

export const runtime = 'nodejs';
export const maxDuration = 60;