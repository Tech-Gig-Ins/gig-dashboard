// Located at: app/api/consultant/report/route.ts
//
// GET ?month=July%202026
//
// Reads both output artifacts from s3://.../consultant-outputs/YYYY-MM/:
//   - GWU_Consultant_Report_<Month>_<Year>.xlsx  (main report, many sheets)
//   - consultant_directory.xlsx                  (standing directory, 1 sheet)
//
// Parses both with ExcelJS applying numFmt-aware cell rendering (same logic
// as the Billing tab), so currency, decimals, dates come through as displayed
// in Excel rather than raw floats. Returns them under separate keys so the
// UI can render two stacked Excel viewers.

import { NextRequest, NextResponse } from 'next/server';
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import ExcelJS from 'exceljs';

const REGION = process.env.MY_AWS_REGION || 'us-east-1';
const BUCKET = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';

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

function monthToPrefix(label: string): string | null {
  const months = ['january','february','march','april','may','june','july',
                  'august','september','october','november','december'];
  const parts = label.trim().toLowerCase().split(/\s+/);
  if (parts.length !== 2) return null;
  const mi = months.indexOf(parts[0]);
  const yr = parseInt(parts[1], 10);
  if (mi < 0 || !Number.isFinite(yr) || yr < 2020 || yr > 2099) return null;
  return `${yr}-${String(mi + 1).padStart(2, '0')}`;
}

// -------------------- Formatting helpers (mirrors billing/report-file) --------------------

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

function countDecimals(fmt: string): number {
  const m = fmt.match(/\.(0+)/);
  return m ? m[1].length : 0;
}
function hasCurrencySign(fmt: string): boolean {
  return /\$|"\$"|\[\$/.test(fmt);
}
function formatNumberWithFmt(n: number, fmt: string | undefined): string {
  if (!fmt || fmt === 'General' || fmt === '@') {
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(2);
  }
  const sections = fmt.split(';');
  const positiveFmt = sections[0] || fmt;
  const negativeFmt = sections[1];

  if (positiveFmt.includes('%')) {
    const decimals = countDecimals(positiveFmt);
    return (n * 100).toFixed(decimals) + '%';
  }

  const isNeg = n < 0;
  const absN = Math.abs(n);
  const decimals = countDecimals(positiveFmt);
  const useThousands = /#,##0|#,#/.test(positiveFmt);
  const useCurrency = hasCurrencySign(positiveFmt);

  const isAccountingZero = n === 0 && (fmt.includes('"-"') || /_\(/.test(fmt));
  if (isAccountingZero) return useCurrency ? '$ -' : '-';

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
    const negWantsParens = negativeFmt ? /\(.*\)/.test(negativeFmt) : /\(.*\)/.test(positiveFmt);
    if (negWantsParens) return `(${prefix}${body})`;
    return `-${prefix}${body}`;
  }
  return `${prefix}${body}`;
}
function excelSerialToDate(serial: number): Date {
  return new Date((serial - 25569) * 86400 * 1000);
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
  if (lower.includes('yyyy')) {
    if (lower.includes('mm/dd')) return `${mm}/${dd}/${yyyy}`;
    if (lower.includes('mm-dd')) return `${mm}-${dd}-${yyyy}`;
    if (lower.includes('m/d')) return `${m}/${day}/${yyyy}`;
    return `${m}/${day}/${yyyy}`;
  }
  if (lower.includes('yy')) return `${m}/${day}/${yy}`;
  return d.toLocaleDateString('en-US');
}
function isDateFmt(fmt: string | undefined): boolean {
  if (!fmt) return false;
  return /[ymdhs]/i.test(fmt) && !/^[@#0.,]+$/.test(fmt);
}

function renderCell(value: any, numFmt: string | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && !(value instanceof Date)) {
    if (Array.isArray(value.richText)) {
      return value.richText.map((rt: any) => rt.text || '').join('');
    }
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
    if ('hyperlink' in value) return String(value.text || value.hyperlink);
    if ('text' in value) return String(value.text);
    if (value instanceof Date) return formatDateWithFmt(value, numFmt);
  }
  if (typeof value === 'number') {
    if (isDateFmt(numFmt) && value > 25569) {
      return formatDateWithFmt(excelSerialToDate(value), numFmt);
    }
    return formatNumberWithFmt(value, numFmt);
  }
  if (value instanceof Date) return formatDateWithFmt(value, numFmt);
  if (typeof value === 'boolean') return String(value);
  return String(value);
}

// -------------------- Sheet parsing --------------------

type ParsedCell = {
  v: string;
  bg?: string; fg?: string;
  b?: boolean; i?: boolean;
  a?: 'left' | 'center' | 'right';
  bl?: string; br?: string; bt?: string; bb?: string;
  rs?: number; cs?: number;
  hidden?: boolean;
};

type ParsedSheet = {
  name: string;
  cells: ParsedCell[][];
  columnWidths: number[];
};

async function parseWorkbookBuffer(buffer: Buffer): Promise<ParsedSheet[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);

  return wb.worksheets.map((ws) => {
    const maxCol = ws.columnCount || 0;
    const maxRow = ws.rowCount || 0;

    const columnWidths: number[] = [];
    for (let c = 1; c <= maxCol; c++) {
      const col = ws.getColumn(c);
      const w = col.width;
      columnWidths.push(w ? Math.round(w * 7.5) : 96);
    }

    const mergeMap = new Map<string, { rs?: number; cs?: number; hidden?: boolean }>();
    const merges: any = (ws as any).model?.merges || (ws as any)._merges || [];
    const mergeList: Array<{ top: number; left: number; bottom: number; right: number }> = [];
    if (Array.isArray(merges)) {
      for (const rng of merges) {
        if (typeof rng === 'string') {
          const m = rng.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
          if (m) {
            const letters2num = (letters: string) => {
              let n = 0;
              for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
              return n;
            };
            mergeList.push({
              left: letters2num(m[1]),
              top: parseInt(m[2], 10),
              right: letters2num(m[3]),
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
        const numFmt: string | undefined = (cell as any).numFmt || style.numFmt || undefined;

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
          bg, fg,
          b: font?.bold ? true : undefined,
          i: font?.italic ? true : undefined,
          a,
          bl: borderCss(border.left), br: borderCss(border.right),
          bt: borderCss(border.top),  bb: borderCss(border.bottom),
          rs: mInfo?.rs && mInfo.rs > 1 ? mInfo.rs : undefined,
          cs: mInfo?.cs && mInfo.cs > 1 ? mInfo.cs : undefined,
        });
      }
      cells.push(rowCells);
    }
    return { name: ws.name, cells, columnWidths };
  });
}

// -------------------- Main handler --------------------

async function loadFileFromS3(key: string): Promise<{ buffer: Buffer; lastModified: string | null; filename: string }> {
  const res: any = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const buffer = await streamToBuffer(res.Body);
  return {
    buffer,
    lastModified: res.LastModified ? new Date(res.LastModified).toISOString() : null,
    filename: key.split('/').pop() || key,
  };
}

async function findFileInPrefix(prefix: string, filenameSubstr: RegExp): Promise<string | null> {
  const res = await s3.send(new ListObjectsV2Command({
    Bucket: BUCKET,
    Prefix: prefix,
  }));
  for (const obj of res.Contents || []) {
    if (!obj.Key) continue;
    const fname = obj.Key.split('/').pop() || '';
    if (filenameSubstr.test(fname)) return obj.Key;
  }
  return null;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const month = searchParams.get('month') || '';
    const prefix = monthToPrefix(month);
    if (!prefix) {
      return NextResponse.json(
        { error: `Invalid month "${month}". Expected "July 2026".` },
        { status: 400 }
      );
    }

    const outPrefix = `consultant-outputs/${prefix}/`;
    const reportKey = await findFileInPrefix(outPrefix, /GWU_Consultant_Report/i);
    const directoryKey = await findFileInPrefix(outPrefix, /consultant_directory/i);

    if (!reportKey && !directoryKey) {
      return NextResponse.json({
        month,
        monthPrefix: prefix,
        report: null,
        directory: null,
        message: `No generated report found for ${month}. Upload the 10 source files and click Generate.`,
      });
    }

    const [reportData, directoryData] = await Promise.all([
      reportKey ? loadFileFromS3(reportKey) : Promise.resolve(null),
      directoryKey ? loadFileFromS3(directoryKey) : Promise.resolve(null),
    ]);

    const [reportSheets, directorySheets] = await Promise.all([
      reportData ? parseWorkbookBuffer(reportData.buffer) : Promise.resolve([]),
      directoryData ? parseWorkbookBuffer(directoryData.buffer) : Promise.resolve([]),
    ]);

    return NextResponse.json({
      month,
      monthPrefix: prefix,
      report: reportData ? {
        s3Key: reportKey!,
        filename: reportData.filename,
        lastModified: reportData.lastModified,
        sheets: reportSheets,
      } : null,
      directory: directoryData ? {
        s3Key: directoryKey!,
        filename: directoryData.filename,
        lastModified: directoryData.lastModified,
        sheets: directorySheets,
      } : null,
    });
  } catch (err: any) {
    console.error('consultant/report error:', err);
    return NextResponse.json({ error: err.message || 'Failed to load consultant report' }, { status: 500 });
  }
}

export const runtime = 'nodejs';