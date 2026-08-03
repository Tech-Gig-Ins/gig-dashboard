// app/api/consultant/download-sheet/route.ts
//
// GET ?month=August%202026&consultant=GWU
//
// Returns an .xlsx containing ONLY that consultant's tab, extracted from the
// month's GWU_Consultant_Report. Shared tabs (Summary, Unassigned, New/Dropped
// Companies, Notes, comparisons) are deliberately excluded - those belong to
// the full report only.
//
// Implemented by loading the generated workbook with ExcelJS and removing every
// other worksheet, which preserves the original fills, fonts, number formats
// and column widths. Rebuilding the sheet from parsed values would lose all of
// that styling.

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

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
                     'July', 'August', 'September', 'October', 'November', 'December'];

function monthToPrefix(label: string): string | null {
  const parts = String(label || '').trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const mi = MONTH_NAMES.findIndex(m => m.toLowerCase() === parts[0].toLowerCase());
  const yr = parseInt(parts[1], 10);
  if (mi < 0 || !Number.isFinite(yr) || yr < 2020 || yr > 2099) return null;
  return `${yr}-${String(mi + 1).padStart(2, '0')}`;
}

async function findReportKey(prefix: string): Promise<string | null> {
  const res = await s3.send(new ListObjectsV2Command({
    Bucket: BUCKET, Prefix: `consultant-outputs/${prefix}/`,
  }));
  for (const obj of res.Contents || []) {
    const name = (obj.Key || '').split('/').pop() || '';
    if (/GWU_Consultant_Report/i.test(name)) return obj.Key!;
  }
  return null;
}

async function toBuffer(body: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Tab titles carry a leading emoji (e.g. "\u{1F464} GWU", "\u{1F464} FNA - HUND").
// Compare on the alphanumeric remainder so the client can pass a plain name.
function tabKey(title: string): string {
  return String(title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Windows forbids \ / : * ? " < > | in filenames.
function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const month = searchParams.get('month') || '';
  const consultant = searchParams.get('consultant') || '';

  if (!month || !consultant) {
    return NextResponse.json(
      { error: 'month and consultant are both required' }, { status: 400 }
    );
  }
  const prefix = monthToPrefix(month);
  if (!prefix) {
    return NextResponse.json({ error: `Could not parse month "${month}"` }, { status: 400 });
  }

  try {
    const reportKey = await findReportKey(prefix);
    if (!reportKey) {
      return NextResponse.json(
        { error: `No generated report for ${month}. Generate it first.` },
        { status: 404 }
      );
    }

    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: reportKey }));
    const buf = await toBuffer(obj.Body as any);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);

    const want = tabKey(consultant);
    const target = wb.worksheets.find(ws => tabKey(ws.name) === want)
                || wb.worksheets.find(ws => tabKey(ws.name).endsWith(want));
    if (!target) {
      return NextResponse.json({
        error: `No tab for "${consultant}" in the ${month} report.`,
        available: wb.worksheets.map(w => w.name),
      }, { status: 404 });
    }

    // Remove every other sheet. Collect ids first: removing while iterating
    // mutates the worksheets array underneath us.
    const doomed = wb.worksheets.filter(ws => ws.id !== target.id).map(ws => ws.id);
    for (const id of doomed) wb.removeWorksheet(id);

    const out = await wb.xlsx.writeBuffer();
    const filename = safeFilename(`${consultant} Report ${month}.xlsx`);

    return new NextResponse(out as any, {
      status: 200,
      headers: {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String((out as ArrayBuffer).byteLength),
        'Cache-Control': 'no-store',
      },
    });
  } catch (err: any) {
    console.error('consultant/download-sheet error:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to build the consultant workbook' },
      { status: 500 }
    );
  }
}

export const runtime = 'nodejs';
export const maxDuration = 60;