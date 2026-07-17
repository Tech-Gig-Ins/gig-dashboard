// Located at: app/api/consultant/upload/route.ts
//
// POST multipart/form-data:
//   month:  "July 2026"
//   files:  10 file uploads (all required source files for the report)
//
// Validates each uploaded file against the 10 required filename patterns
// (using the same normalized-substring match the Python Lambda uses). Files
// that don't match any pattern are rejected. Uploads accepted files to
// s3://.../consultant-inputs/YYYY-MM/<original-filename>, overwriting any
// existing file with the same key.

import { NextRequest, NextResponse } from 'next/server';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const REGION = process.env.MY_AWS_REGION || 'us-east-1';
const BUCKET = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  },
});

// Kept in sync with SOURCES in consultant_report.py. Each entry is
// [filename substring, display label]. Order matters for the UI checklist.
const REQUIRED_FILES: Array<[string, string]> = [
  ['TPA_Cassena',           'Cassena (TPA)'],
  ['TPA_Northstead',        'Northstead (TPA)'],
  ['TPA_GWU3',              'GWU3 (TPA)'],
  ['TPA_GIG',               'GIG TPA.com'],
  ['TPA_BDSB',              'BDSB (TPA)'],
  ['426_EP6',               'EP6IX (426)'],
  ['PIOPAC',                'PIOPAC'],
  ['CoreChoice_Direct_T1',  'Decisely GWU2 (CoreChoice T1)'],
  ['CoreChoice_Direct_T3',  'Decisely GWU1 (CoreChoice T3)'],
  ['Gig_Workers',           'Refresh (Gig Workers)'],
];

// Same normalization as the Python find_file: strip everything that isn't
// [a-z0-9], case-insensitive. Guarantees dashboard and Lambda match the same
// filenames identically.
function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function matchSlot(filename: string): string | null {
  const target = normKey(filename);
  for (const [substr] of REQUIRED_FILES) {
    if (target.includes(normKey(substr))) return substr;
  }
  return null;
}

// "July 2026" -> "2026-07" (S3 prefix format, matches _month_prefix in Lambda)
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

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const month = (form.get('month') as string) || '';
    const prefix = monthToPrefix(month);
    if (!prefix) {
      return NextResponse.json(
        { error: `Invalid month "${month}". Expected format: "July 2026".` },
        { status: 400 }
      );
    }

    const files = form.getAll('files').filter((v): v is File => v instanceof File);
    if (files.length === 0) {
      return NextResponse.json({ error: 'No files uploaded' }, { status: 400 });
    }

    type UploadResult = {
      filename: string;
      matchedSlot: string | null;
      s3Key: string | null;
      size: number;
      status: 'uploaded' | 'rejected';
      reason?: string;
    };

    const results: UploadResult[] = [];
    for (const file of files) {
      const slot = matchSlot(file.name);
      if (!slot) {
        results.push({
          filename: file.name,
          matchedSlot: null,
          s3Key: null,
          size: file.size,
          status: 'rejected',
          reason: 'Filename does not match any of the 10 required source patterns',
        });
        continue;
      }

      const key = `consultant-inputs/${prefix}/${file.name}`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: bytes,
        ContentType: file.type || 'application/octet-stream',
      }));

      results.push({
        filename: file.name,
        matchedSlot: slot,
        s3Key: key,
        size: file.size,
        status: 'uploaded',
      });
    }

    const uploadedSlots = new Set(
      results.filter(r => r.status === 'uploaded').map(r => r.matchedSlot!)
    );
    const stillMissing = REQUIRED_FILES
      .filter(([slot]) => !uploadedSlots.has(slot))
      .map(([slot, label]) => ({ slot, label }));

    return NextResponse.json({
      month,
      monthPrefix: prefix,
      uploaded: results.filter(r => r.status === 'uploaded').length,
      rejected: results.filter(r => r.status === 'rejected').length,
      stillMissingCount: stillMissing.length,
      stillMissing,
      results,
    });
  } catch (err: any) {
    console.error('consultant/upload error:', err);
    return NextResponse.json(
      { error: err.message || 'Upload failed' },
      { status: 500 }
    );
  }
}

export const runtime = 'nodejs';