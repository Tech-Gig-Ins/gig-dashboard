// Located at: app/api/billing/report-file/route.ts
//
// Loads an Excel file from S3 and returns all its sheets WITH FORMATTING
// (cell background/text colors, bold, italic, alignment, merged cells,
// column widths). Used by the Billing Test tab to render an Excel-like view.
//
// File selection priority:
//   1. Approved key stored at s3://.../billing-updates/billing-test-approved.json
//   2. Latest Reconciliation_Output_*.xlsx from billing-reports/
//
// The approved key is written by POST /api/billing/approve after passcode
// verification. Delete the approved.json object (via AWS console or CLI) to
// revert to the default reconciliation file.

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

// Convert an ARGB or RGB hex string from ExcelJS to a CSS hex color.
// ExcelJS gives colors like "FFFFFF00" (opaque yellow) - AARRGGBB.
function argbToCss(argb: string | undefined | null): string | undefined {
  if (!argb || typeof argb !== 'string') return undefined;
  const s = argb.toUpperCase().replace(/[^0-9A-F]/g, '');
  if (s.length === 8) return `#${s.substring(2)}`;
  if (s.length === 6) return `#${s}`;
  return undefined;
}

// Cell value can be a rich text object, formula, hyperlink, date, or primitive.
// Normalize to a string for display.
function cellValueToString(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().split('T')[0];
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((rt: any) => rt.text || '').join('');
    if ('formula' in v) return v.result !== undefined && v.result !== null ? String(v.result) : '';
    if ('text' in v) return String(v.text);
    if ('hyperlink' in v) return String(v.text || v.hyperlink);
  }
  return String(v);
}

// ExcelJS border style -> CSS border-style value
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

type ParsedCell = {
  v: string;                // display value
  bg?: string;              // background hex (e.g. "#FFEE00")
  fg?: string;              // font color hex
  b?: boolean;              // bold
  i?: boolean;              // italic
  a?: 'left' | 'center' | 'right';
  bl?: string;              // border-left css (e.g. "solid 1px #000000")
  br?: string;              // border-right
  bt?: string;              // border-top
  bb?: string;              // border-bottom
  rs?: number;              // rowspan (for merged cells master)
  cs?: number;              // colspan (for merged cells master)
  hidden?: boolean;         // slave cell in a merge - don't render
};

type ParsedSheet = {
  name: string;
  cells: ParsedCell[][];
  columnWidths: number[];   // in pixels
};

async function parseWorkbook(buffer: Buffer): Promise<ParsedSheet[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);

  return wb.worksheets.map((ws) => {
    const maxCol = ws.columnCount || 0;
    const maxRow = ws.rowCount || 0;

    // Column widths - ExcelJS gives width in character units, convert to pixels (~7px per unit)
    const columnWidths: number[] = [];
    for (let c = 1; c <= maxCol; c++) {
      const col = ws.getColumn(c);
      const w = col.width;
      columnWidths.push(w ? Math.round(w * 7.5) : 96);
    }

    // Track merged ranges as a lookup: "row,col" -> { rs, cs } for masters,
    // and "row,col" -> { hidden: true } for slaves.
    const mergeMap = new Map<string, { rs?: number; cs?: number; hidden?: boolean }>();
    const merges: any = (ws as any).model?.merges || (ws as any)._merges || [];
    const mergeList: Array<{ top: number; left: number; bottom: number; right: number }> = [];
    if (Array.isArray(merges)) {
      for (const rng of merges) {
        // rng like "A1:B3" - parse it
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

        // Border colors default to black if not specified
        const borderCss = (side: any) => {
          if (!side || !side.style) return undefined;
          const color = argbToCss(side.color?.argb) || '#666666';
          const style = borderStyleToCss(side.style);
          return `${style} ${color}`;
        };

        rowCells.push({
          v: cellValueToString(cell.value),
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
    // Resolve which file to load
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

    // Download and parse
    let objRes: any;
    try {
      objRes = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    } catch (err: any) {
      // If the approved file was deleted, fall back to default
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