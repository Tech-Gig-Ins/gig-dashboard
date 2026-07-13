// Located at: app/api/master/upload/route.ts
//
// Uploads a file to S3 with a plain rename ("{Canonical Label} {Month} {Year}.{ext}").
// If any files match the canonical label + month + year across all carrier folders,
// the upload is REJECTED (409) unless the caller passes overrideKey identifying
// the specific existing file to delete. Only that one file is deleted; other
// matching files (with different descriptors like Dental / Medical) stay untouched.

import { NextRequest, NextResponse } from 'next/server';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

const REGION = process.env.MY_AWS_REGION || 'us-east-1';
const BUCKET = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';
const MAX_FILE_SIZE = 25 * 1024 * 1024;

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  },
});

const UPLOAD_FOLDERS: Record<string, string> = {
  'Cassena Remittance': 'carrier=gig/',
  'Cassena Credits': 'carrier=gig/',
  'EP6 Remittance': 'carrier=enrollconfidently/',
  'NYP Remittance': 'carrier=refresh/',
  'BDSB Remittance': 'carrier=tpa/',
  'BDSB Credits': 'carrier=tpa/',
  'Corechoice T1': 'carrier=decisely/',
  'Corechoice T3': 'carrier=decisely/',
  'Gig Remittance': 'carrier=gig/',
  'Gig Credits': 'carrier=gig/',
  'Delta Dental': 'carrier=deltadental/',
  'GWU3 Remittance': 'carrier=tpa/',
  'GWU3 Credits': 'carrier=tpa/',
  'Northstead Remittance': 'carrier=northstead/',
  'Northstead Credits': 'carrier=northstead/',
  'Refresh': 'carrier=refresh/',
  'Enroll Confidently or PIOPAC': 'carrier=enrollconfidently/',
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const MONTH_LOOKUP: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

function detectMonthYear(filename: string): { year: number; month: number } | null {
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

function classifyFile(filename: string): string {
  const lower = filename.toLowerCase();
  const hasRemittance = lower.includes('remittance');
  const hasCredits = lower.includes('credits');

  if (lower.includes('corechoice')) {
    if (lower.includes('t1')) return 'Corechoice T1';
    if (lower.includes('t3')) return 'Corechoice T3';
  }
  if (lower.includes('delta') && lower.includes('dental')) return 'Delta Dental';
  if (lower.includes('nyp') || lower.includes('ny-practice') || lower.includes('ny practice')) return 'NYP Remittance';
  if (lower.includes('enroll confidently') || lower.includes('piopac')) return 'Enroll Confidently or PIOPAC';

  if (lower.includes('cassena')) {
    if (hasCredits) return 'Cassena Credits';
    if (hasRemittance) return 'Cassena Remittance';
  }
  if (lower.includes('bdsb')) {
    if (hasCredits) return 'BDSB Credits';
    if (hasRemittance) return 'BDSB Remittance';
  }
  if (lower.includes('gwu3')) {
    if (hasCredits) return 'GWU3 Credits';
    if (hasRemittance) return 'GWU3 Remittance';
  }
  if (lower.includes('northstead')) {
    if (hasCredits) return 'Northstead Credits';
    if (hasRemittance) return 'Northstead Remittance';
  }
  if (lower.includes('ep6')) return 'EP6 Remittance';
  if (/\bgig\b/i.test(filename) || lower.includes('_gig_') || lower.startsWith('gig')) {
    if (hasCredits) return 'Gig Credits';
    if (hasRemittance) return 'Gig Remittance';
  }
  if (lower.includes('refresh')) return 'Refresh';
  return 'unknown';
}

async function findAllMatches(canonicalLabel: string, month: number, year: number): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined = undefined;
  do {
    const res: any = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: 'carrier=',
      ContinuationToken: token,
    }));
    for (const obj of res.Contents || []) {
      if (!obj.Key || obj.Key.endsWith('/')) continue;
      const lower = obj.Key.toLowerCase();
      if (!lower.endsWith('.xlsx') && !lower.endsWith('.xls') && !lower.endsWith('.csv')) continue;
      const filename = obj.Key.split('/').pop() || obj.Key;
      const detected = detectMonthYear(filename);
      if (!detected) continue;
      if (detected.year !== year || detected.month !== month) continue;
      if (classifyFile(filename) !== canonicalLabel) continue;
      keys.push(obj.Key);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

function contentTypeFor(ext: string): string {
  if (ext === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (ext === '.xls') return 'application/vnd.ms-excel';
  if (ext === '.csv') return 'text/csv';
  return 'application/octet-stream';
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file');
    const canonicalLabel = formData.get('canonicalLabel');
    const monthStr = formData.get('month');
    const yearStr = formData.get('year');
    const overrideStr = formData.get('override');
    const overrideKeyRaw = formData.get('overrideKey');

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }
    if (typeof canonicalLabel !== 'string' || !UPLOAD_FOLDERS[canonicalLabel]) {
      return NextResponse.json({ error: 'Invalid file type' }, { status: 400 });
    }
    const month = parseInt(String(monthStr || ''), 10);
    const year = parseInt(String(yearStr || ''), 10);
    if (isNaN(month) || month < 0 || month > 11) {
      return NextResponse.json({ error: 'Invalid month' }, { status: 400 });
    }
    if (isNaN(year) || year < 2024 || year > 2099) {
      return NextResponse.json({ error: 'Invalid year' }, { status: 400 });
    }
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024} MB)` }, { status: 400 });
    }

    const lastDot = file.name.lastIndexOf('.');
    const ext = lastDot >= 0 ? file.name.slice(lastDot).toLowerCase() : '';
    if (!['.xlsx', '.xls', '.csv'].includes(ext)) {
      return NextResponse.json({ error: `Unsupported extension: ${ext}. Use .xlsx, .xls, or .csv.` }, { status: 400 });
    }

    const folder = UPLOAD_FOLDERS[canonicalLabel];
    const targetKey = `${folder}${canonicalLabel} ${MONTH_NAMES[month]} ${year}${ext}`;
    const override = String(overrideStr || '').toLowerCase() === 'true';
    const overrideKey = typeof overrideKeyRaw === 'string' && overrideKeyRaw.trim() ? overrideKeyRaw.trim() : null;

    // Validate overrideKey (defence-in-depth: only allow keys under carrier=)
    if (overrideKey && (!overrideKey.startsWith('carrier=') || overrideKey.includes('..'))) {
      return NextResponse.json({ error: 'Invalid override key' }, { status: 400 });
    }

    // Scan all matches
    const existingMatches = await findAllMatches(canonicalLabel, month, year);

    // If there ARE matches and the caller didn't ask to override, reject
    if (existingMatches.length > 0 && !override) {
      return NextResponse.json({
        error: 'File already exists',
        needsOverride: true,
        existingKeys: existingMatches,
      }, { status: 409 });
    }

    // Upload the new file first (so if a subsequent delete fails, target still exists)
    const buffer = Buffer.from(await file.arrayBuffer());
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: targetKey,
      Body: buffer,
      ContentType: contentTypeFor(ext),
    }));

    // On override: delete ONLY the specific key requested (other variants stay).
    // Skip if the override key equals target key (we already overwrote it).
    let deletedKey: string | null = null;
    if (override && overrideKey && overrideKey !== targetKey) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: overrideKey }));
        deletedKey = overrideKey;
      } catch (err: any) {
        console.warn(`Failed to delete overrideKey ${overrideKey}:`, err.message || err);
      }
    }

    return NextResponse.json({
      success: true,
      key: targetKey,
      renamedTo: targetKey.split('/').pop(),
      overridden: existingMatches.length > 0,
      deletedKey,
    });
  } catch (err: any) {
    console.error('upload error:', err);
    return NextResponse.json({ error: err.message || 'Upload failed' }, { status: 500 });
  }
}

export const runtime = 'nodejs';
export const maxDuration = 30;