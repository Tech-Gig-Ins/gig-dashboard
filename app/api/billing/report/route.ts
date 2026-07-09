// app/api/billing/report/route.ts
//
// Reads the most recently modified .xlsx file from S3 at billing-reports/
// and returns it parsed as JSON. Each sheet is returned as a title + raw cell grid,
// and the frontend does the per-sheet structured rendering.
//
// S3 layout expected:
//   {S3_RAW_BUCKET}/billing-reports/Reconciliation_Output_*.xlsx
//
// You (Kowshik) upload a new reconciliation .xlsx to this prefix each month after
// running RECONCILE.PY locally. The dashboard picks up the newest file automatically.

import { NextResponse } from 'next/server';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import * as XLSX from 'xlsx';

const s3 = new S3Client({
  region: process.env.MY_AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY || '',
  },
});

const BUCKET = process.env.S3_RAW_BUCKET || '';
const REPORTS_PREFIX = 'billing-reports/';

type CellValue = string | number | null;

type SheetData = {
  name: string;
  title: string | null;
  cells: CellValue[][];
};

type BillingReport = {
  sourceFile: string;
  lastModified: string | null;
  reportMonth: string | null;
  sheets: SheetData[];
};

// Attempt to pull a "Month Year" out of the filename e.g. "Reconciliation_Output_July_2025.xlsx"
function extractReportMonth(key: string): string | null {
  const filename = key.split('/').pop() || key;
  const monthPattern = /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s_\-]*(\d{4})/i;
  const m = filename.match(monthPattern);
  if (m) {
    const month = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    return `${month} ${m[2]}`;
  }
  return null;
}

async function findLatestReportKey(): Promise<{ key: string; lastModified: Date | null } | null> {
  const list = await s3.send(new ListObjectsV2Command({
    Bucket: BUCKET,
    Prefix: REPORTS_PREFIX,
  }));
  const objects = list.Contents || [];
  const xlsxOnly = objects.filter(o => o.Key && o.Key.toLowerCase().endsWith('.xlsx'));
  if (xlsxOnly.length === 0) return null;
  xlsxOnly.sort((a, b) => {
    const ta = a.LastModified?.getTime() || 0;
    const tb = b.LastModified?.getTime() || 0;
    return tb - ta;
  });
  const latest = xlsxOnly[0];
  return { key: latest.Key || '', lastModified: latest.LastModified || null };
}

async function fetchExcelBuffer(key: string): Promise<Buffer> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const stream = obj.Body as any;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function extractSheets(buffer: Buffer): SheetData[] {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheets: SheetData[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const rawRows = XLSX.utils.sheet_to_json<CellValue[]>(ws, {
      header: 1,
      defval: null,
      blankrows: true,
    });
    // Normalize: convert undefined/null/empty strings to null for cleaner JSON.
    // (Previously null values were falling through to String(null) = "null" which
    // was polluting the frontend with literal "null" text everywhere.)
    const cells = rawRows.map(row => {
      if (!Array.isArray(row)) return [];
      return row.map(v => {
        if (v === undefined || v === null) return null;
        if (typeof v === 'string' && v.trim() === '') return null;
        if (typeof v === 'number') return v;
        return String(v);
      });
    });
    // Title is typically in row 0, cell 0
    const title = cells.length > 0 && cells[0].length > 0 && typeof cells[0][0] === 'string'
      ? cells[0][0]
      : null;
    sheets.push({ name, title, cells });
  }
  return sheets;
}

export async function GET() {
  try {
    if (!BUCKET) {
      return NextResponse.json({ error: 'S3_RAW_BUCKET not configured' }, { status: 500 });
    }
    const latest = await findLatestReportKey();
    if (!latest) {
      return NextResponse.json({
        sourceFile: null,
        lastModified: null,
        reportMonth: null,
        sheets: [],
        message: `No reconciliation report found. Upload an .xlsx to s3://${BUCKET}/${REPORTS_PREFIX}`,
      });
    }
    const buffer = await fetchExcelBuffer(latest.key);
    const sheets = extractSheets(buffer);
    const response: BillingReport = {
      sourceFile: latest.key,
      lastModified: latest.lastModified ? latest.lastModified.toISOString() : null,
      reportMonth: extractReportMonth(latest.key),
      sheets,
    };
    return NextResponse.json(response);
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message || 'Failed to load billing report' },
      { status: 500 },
    );
  }
}