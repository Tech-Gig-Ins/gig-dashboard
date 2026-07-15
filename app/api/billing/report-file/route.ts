// Located at: app/api/billing/report-file/route.ts
//
// Loads an Excel file from S3 and returns all its sheets WITH FORMATTING
// (cell background/text colors, bold, italic, alignment, merged cells,
// column widths, AND Excel number-format-code applied to numeric values so
// currency like $1,234.56 renders as displayed in Excel, not as raw 1234.56).
//
// File selection priority:
//   1. Approved key stored at s3://.../billing-updates/billing-test-approved.json
//   2. Latest Reconciliation_Output_*.xlsx from billing-reports/

import { NextResponse } from 'next/server';
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import ExcelJS from 'exceljs';

const REGION = process.env.MY_AWS_REGION || 'us-east-1';
const BUCKET = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';
const APPROVED_JSON_KEY = 'billing-updates/billing-test-approved.json';

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  },
});

async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readApprovedKey(): Promise<string | null> {
  try {
    const res: any = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: APPROVED_JSON_KEY }));
    const buf = await streamToBuffer(res.Body);
    const obj = JSON.parse(buf.toString('utf-8'));
    return typeof obj.approvedKey === 'string' && obj.approvedKey ? obj.approvedKey : null;
  } catch (err: any) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
    console.warn('readApprovedKey error:', err.message || err);
    return null;
  }
}

async function findLatestReconciliation(): Promise<string | null> {
  let token: string | undefined;
  let latestKey: string | null = null;
  let latestMod = 0;
  do {
    const res: any = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: 'billing-reports/',
      ContinuationToken: token,
    }));
    for (const obj of res.Contents || []) {
      if (!obj.Key) continue;
      const fname = obj.Key.split('/').pop() || '';
      if (!/Reconciliation_Output_.*\.xlsx$/i.test(fname)) continue;
      const mod = obj.LastModified ? new Date(obj.LastModified).getTime() : 0;
      if (mod > latestMod) {
        latestMod = mod;
        latestKey = obj.Key;
      }
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return latestKey;
}

function argbToCss(argb: string | undefined | null): string | undefined {
  if (!argb || typeof argb !== 'string') return undefined;
  const s = argb.toUpperCase().replace(/[^0-9A-F]/g, '');
  if (s.length === 8) return `#${s.substring(2)}`;
  if (s.length === 6) return `#${s}`;
  return undefined;
}

function borderStyleToCss(style: string | undefined): string {
  if (!style) return 'none';
  if (style === 'thin' || style === 'hair') return 'solid 1px';
  if (style === 'medium') return 'solid 2px';
  if (style === 'thick') return 'solid 3px';
  if (style === 'double') return 'double 3px';
  if (style === 'dotted') return 'dotted 1px';
  if (style === 'dashed') return 'dashed 1px';
  if (style === 'dashDot' || style === 'dashDotDot') return 'dashed 1px';
  return 'solid 1px';
}

// -------------------- Excel number-format handling --------------------
// ExcelJS exposes the format code via `cell.numFmt` (e.g. '$#,##0.00',
// '#,##0.00_);($#,##0.00)', '0.00%', 'mm/dd/yyyy'). ExcelJS does NOT
// apply this code when returning cell.text - we have to do it ourselves.
//
// This formatter handles the common cases the reconciliation output uses:
// currency, thousands separators, decimals, percentages, accounting-style
// negatives, and simple dates. It's not a full Excel-format engine, but
// covers what appears in these workbooks.

function countDecimals(fmt: string): number {
  const m = fmt.match(/\.(0+)/);
  return m ? m[1].length : 0;
}

function hasCurrencySign(fmt: string): boolean {
  // Matches literal $, "$", [$USD], [$$-409-en-US], etc.
  return /\$|"\$"|\[\$/.test(fmt);
}

function formatNumberWithFmt(n: number, fmt: string | undefined): string {
  if (!fmt || fmt === 'General' || fmt === '@') {
    // No explicit format on the cell. Excel silently rounds these on display,
    // which is why "4681.1" looks like 4681.1 in the source file even though
    // the underlying double reads back as 4681.0999999999985. Do the same:
    // integers stay integers, everything else renders with 2 decimals.
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(2);
  }

  // Excel format codes can have multiple sections separated by ; -
  //   positive;negative;zero;text
  // We only strip that here for a very common accounting subset - the
  // negative section is used to render (parens) etc.
  const sections = fmt.split(';');
  const positiveFmt = sections[0] || fmt;
  const negativeFmt = sections[1];

  // Percentage
  if (positiveFmt.includes('%')) {
    const decimals = countDecimals(positiveFmt);
    return (n * 100).toFixed(decimals) + '%';
  }

  const isNeg = n < 0;
  const absN = Math.abs(n);
  const decimals = countDecimals(positiveFmt);
  const useThousands = /#,##0|#,#/.test(positiveFmt);
  const useCurrency = hasCurrencySign(positiveFmt);

  // Accounting format: exact zero rendered as "-" (with currency sign kept)
  // pattern used by openpyxl / Excel accounting: '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)'
  const isAccountingZero = n === 0 && (fmt.includes('"-"') || /_\(/.test(fmt));
  if (isAccountingZero) {
    return useCurrency ? '$ -' : '-';
  }

  let body: string;
  if (useThousands) {
    body = absN.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  } else {
    body = absN.toFixed(decimals);
  }

  const prefix = useCurrency ? '$' : '';

  if (isNeg) {
    // If the negative section wraps in parens, use parens
    const negWantsParens = negativeFmt ? /\(.*\)/.test(negativeFmt) : /\(.*\)/.test(positiveFmt);
    if (negWantsParens) return `(${prefix}${body})`;
    return `-${prefix}${body}`;
  }
  return `${prefix}${body}`;
}

// Excel serial date -> JS Date. Excel counts from 1900-01-01 as day 1,
// but has a bug pretending 1900 was a leap year - hence the -25569 offset
// and 86400 seconds per day. This maps to the same instant JS represents.
function excelSerialToDate(serial: number): Date {
  const ms = (serial - 25569) * 86400 * 1000;
  return new Date(ms);
}

function formatDateWithFmt(d: Date, fmt: string | undefined): string {
  if (!fmt) return d.toLocaleDateString('en-US');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  const yy = yyyy.slice(2);
  const m = String(d.getMonth() + 1);
  const day = String(d.getDate());
  const lower = fmt.toLowerCase();
  // Order matters: check longer patterns first
  if (lower.includes('yyyy')) {
    if (lower.includes('mm/dd')) return `${mm}/${dd}/${yyyy}`;
    if (lower.includes('mm-dd')) return `${mm}-${dd}-${yyyy}`;
    if (lower.includes('m/d')) return `${m}/${day}/${yyyy}`;
    return `${m}/${day}/${yyyy}`;
  }
  if (lower.includes('yy')) {
    return `${m}/${day}/${yy}`;
  }
  // Fall back to locale
  return d.toLocaleDateString('en-US');
}

// Detect whether a format code represents a date/time
function isDateFmt(fmt: string | undefined): boolean {
  if (!fmt) return false;
  return /[ymdhs]/i.test(fmt) && !/^[@#0.,]+$/.test(fmt);
}

// Turn any cell value + numFmt into the display string that Excel would show.
function renderCell(value: any, numFmt: string | undefined): string {
  if (value === null || value === undefined) return '';

  // Rich text -> concatenate segments
  if (typeof value === 'object' && !(value instanceof Date)) {
    if (Array.isArray(value.richText)) {
      return value.richText.map((rt: any) => rt.text || '').join('');
    }
    // Formula cell: use the computed result and format it if numeric
    if ('formula' in value) {
      const result = value.result;
      if (result === undefined || result === null) return '';
      if (typeof result === 'number') {
        if (isDateFmt(numFmt) && result > 25569) {
          return formatDateWithFmt(excelSerialToDate(result), numFmt);
        }
        return formatNumberWithFmt(result, numFmt);
      }
      if (result instanceof Date) return formatDateWithFmt(result, numFmt);
      return String(result);
    }
    // Hyperlink cell: use display text
    if ('hyperlink' in value) return String(value.text || value.hyperlink);
    if ('text' in value) return String(value.text);
    if (value instanceof Date) return formatDateWithFmt(value, numFmt);
  }

  if (typeof value === 'number') {
    // If the format code is a date format, treat the number as an Excel serial
    if (isDateFmt(numFmt) && value > 25569) {
      return formatDateWithFmt(excelSerialToDate(value), numFmt);
    }
    return formatNumberWithFmt(value, numFmt);
  }
  if (value instanceof Date) return formatDateWithFmt(value, numFmt);
  if (typeof value === 'boolean') return String(value);
  return String(value);
}

// ---------------------- Sheet parsing ----------------------

type ParsedCell = {
  v: string;
  bg?: string;
  fg?: string;
  b?: boolean;
  i?: boolean;
  a?: 'left' | 'center' | 'right';
  bl?: string;
  br?: string;
  bt?: string;
  bb?: string;
  rs?: number;
  cs?: number;
  hidden?: boolean;
};

type ParsedSheet = {
  name: string;
  cells: ParsedCell[][];
  columnWidths: number[];
};

async function parseWorkbook(buffer: Buffer): Promise<ParsedSheet[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);

  return wb.worksheets.map((ws) => {
    const maxCol = ws.columnCount || 0;
    const maxRow = ws.rowCount || 0;

    // Column widths in Excel character units -> approximate pixels
    const columnWidths: number[] = [];
    for (let c = 1; c <= maxCol; c++) {
      const col = ws.getColumn(c);
      const w = col.width;
      columnWidths.push(w ? Math.round(w * 7.5) : 96);
    }

    // Build merged-cell lookup: master coordinates get rowspan/colspan,
    // slave coordinates get { hidden: true } so we drop them on render.
    const mergeMap = new Map<string, { rs?: number; cs?: number; hidden?: boolean }>();
    const merges: any = (ws as any).model?.merges || (ws as any)._merges || [];
    const mergeList: Array<{ top: number; left: number; bottom: number; right: number }> = [];
    if (Array.isArray(merges)) {
      for (const rng of merges) {
        if (typeof rng === 'string') {
          const m = rng.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
          if (m) {
            const colLetterToNum = (letters: string) => {
              let n = 0;
              for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
              return n;
            };
            mergeList.push({
              left: colLetterToNum(m[1]),
              top: parseInt(m[2], 10),
              right: colLetterToNum(m[3]),
              bottom: parseInt(m[4], 10),
            });
          }
        }
      }
    } else if (typeof merges === 'object' && merges !== null) {
      for (const key of Object.keys(merges)) {
        const rng = merges[key];
        if (rng && typeof rng === 'object' && 'top' in rng) {
          mergeList.push({ top: rng.top, left: rng.left, bottom: rng.bottom, right: rng.right });
        }
      }
    }
    for (const m of mergeList) {
      mergeMap.set(`${m.top},${m.left}`, { rs: m.bottom - m.top + 1, cs: m.right - m.left + 1 });
      for (let r = m.top; r <= m.bottom; r++) {
        for (let c = m.left; c <= m.right; c++) {
          if (r === m.top && c === m.left) continue;
          mergeMap.set(`${r},${c}`, { hidden: true });
        }
      }
    }

    const cells: ParsedCell[][] = [];
    for (let r = 1; r <= maxRow; r++) {
      const row = ws.getRow(r);
      const rowCells: ParsedCell[] = [];
      for (let c = 1; c <= maxCol; c++) {
        const cell = row.getCell(c);
        const key = `${r},${c}`;
        const mInfo = mergeMap.get(key);

        if (mInfo?.hidden) {
          rowCells.push({ v: '', hidden: true });
          continue;
        }

        const style = (cell.style || {}) as any;
        const fill = style.fill;
        const font = style.font;
        const align = style.alignment;
        const border = style.border || {};

        // ExcelJS surfaces numFmt in a couple places depending on how the
        // workbook was authored. Check both.
        const numFmt: string | undefined =
          (cell as any).numFmt || style.numFmt || undefined;

        let bg: string | undefined;
        if (fill?.type === 'pattern' && fill.pattern !== 'none') {
          bg = argbToCss(fill.fgColor?.argb) || argbToCss(fill.bgColor?.argb);
        }
        const fg = argbToCss(font?.color?.argb);
        const h = align?.horizontal;
        const a: 'left' | 'center' | 'right' | undefined =
          h === 'center' || h === 'centerContinuous' ? 'center' :
          h === 'right' || h === 'end' ? 'right' :
          h === 'left' || h === 'start' ? 'left' : undefined;

        const borderCss = (side: any) => {
          if (!side || !side.style) return undefined;
          const color = argbToCss(side.color?.argb) || '#666666';
          const style = borderStyleToCss(side.style);
          return `${style} ${color}`;
        };

        rowCells.push({
          v: renderCell(cell.value, numFmt),
          bg,
          fg,
          b: font?.bold ? true : undefined,
          i: font?.italic ? true : undefined,
          a,
          bl: borderCss(border.left),
          br: borderCss(border.right),
          bt: borderCss(border.top),
          bb: borderCss(border.bottom),
          rs: mInfo?.rs && mInfo.rs > 1 ? mInfo.rs : undefined,
          cs: mInfo?.cs && mInfo.cs > 1 ? mInfo.cs : undefined,
        });
      }
      cells.push(rowCells);
    }

    return { name: ws.name, cells, columnWidths };
  });
}

export async function GET() {
  try {
    const approvedKey = await readApprovedKey();
    const key = approvedKey || (await findLatestReconciliation());

    if (!key) {
      return NextResponse.json({
        sourceFile: null,
        approvedKey: null,
        lastModified: null,
        sheets: [],
        message: 'No reconciliation output found. Run the reconcile-billing Lambda or approve a chat file.',
      });
    }

    let objRes: any;
    try {
      objRes = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    } catch (err: any) {
      if ((err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) && approvedKey) {
        const fallback = await findLatestReconciliation();
        if (!fallback) {
          return NextResponse.json({
            sourceFile: null,
            approvedKey: null,
            lastModified: null,
            sheets: [],
            message: 'Approved file was removed and no default reconciliation exists.',
          });
        }
        objRes = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: fallback }));
      } else {
        throw err;
      }
    }

    const buffer = await streamToBuffer(objRes.Body);
    const sheets = await parseWorkbook(buffer);
    const filename = key.split('/').pop() || key;

    return NextResponse.json({
      sourceFile: key,
      filename,
      approvedKey,
      lastModified: objRes.LastModified ? new Date(objRes.LastModified).toISOString() : null,
      sheets,
    });
  } catch (err: any) {
    console.error('report-file error:', err);
    return NextResponse.json({ error: err.message || 'Failed to load file' }, { status: 500 });
  }
}

export const runtime = 'nodejs';