// Located at: app/api/billing/report-file/route.ts
//
// Loads an arbitrary Excel file from S3 and returns all its sheets as JSON.
// Used by the Billing Test tab, where an approved chat-file replaces the
// default reconciliation display.
//
// Behavior:
//   GET (no query params)     -> loads the latest Reconciliation_Output_*.xlsx
//                                from billing-reports/ (same source as
//                                /api/billing/report).
//   GET ?key=<s3-key>         -> loads that specific S3 object.

import { NextResponse } from 'next/server';
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
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

async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function findLatestReconciliation(): Promise<string | null> {
  // Scan billing-reports/ for the newest Reconciliation_Output_*.xlsx
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

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    let key = url.searchParams.get('key');
    if (!key) {
      key = await findLatestReconciliation();
      if (!key) {
        return NextResponse.json({
          sourceFile: null,
          lastModified: null,
          reportMonth: null,
          sheets: [],
          message: 'No reconciliation output found in billing-reports/. Run the reconcile-billing Lambda first.',
        });
      }
    }

    // Download the object
    const res: any = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const buffer = await streamToBuffer(res.Body);

    // Parse with SheetJS - read every sheet, extract cells as 2D arrays
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    const sheets = workbook.SheetNames.map((sheetName) => {
      const ws = workbook.Sheets[sheetName];
      // sheet_to_json with header: 1 gives a 2D array of raw cell values
      const cells: Array<Array<string | number | null>> = XLSX.utils.sheet_to_json(ws, {
        header: 1,
        defval: null,
        raw: true,
        blankrows: false,
      }) as any;
      // First non-empty cell of row 0 (if present) acts as a "title" for display
      let title: string | null = null;
      if (cells.length > 0) {
        for (const c of cells[0]) {
          if (c !== null && c !== undefined && String(c).trim() !== '') {
            title = String(c);
            break;
          }
        }
      }
      return { name: sheetName, title, cells };
    });

    const filename = key.split('/').pop() || key;

    return NextResponse.json({
      sourceFile: key,
      filename,
      lastModified: res.LastModified ? new Date(res.LastModified).toISOString() : null,
      reportMonth: null,
      sheets,
    });
  } catch (err: any) {
    console.error('report-file error:', err);
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return NextResponse.json({ error: 'File not found in S3' }, { status: 404 });
    }
    return NextResponse.json({ error: err.message || 'Failed to load file' }, { status: 500 });
  }
}

export const runtime = 'nodejs';