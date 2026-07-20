// app/api/billing/upload-sources/route.ts
//
// POST multipart/form-data:
//   month:       "July 2026"
//   cardconnect: File  (required)
//   refresh:     File  (required)
//
// Uploads both files to s3://.../billing-sources/{YYYY-MM}/ with slot-prefixed
// names so the reconcile-billing Lambda can find them:
//   billing-sources/2026-07/cardconnect_<original-name>
//   billing-sources/2026-07/refresh_<original-name>
//
// Overwrites any existing file with the same slot for that month.

import { NextRequest, NextResponse } from 'next/server';
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';

const REGION = process.env.MY_AWS_REGION || 'us-east-1';
const BUCKET = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  },
});

const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB - source files can be large

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

function safeFilename(name: string): string {
  return name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 200);
}

// Delete any existing file for the given slot in the given month prefix, so
// we don't leave stale copies with different names.
async function clearExistingSlot(monthPrefix: string, slotPrefix: string): Promise<number> {
  const listPrefix = `billing-sources/${monthPrefix}/${slotPrefix}_`;
  let deleted = 0;
  let token: string | undefined;
  do {
    const res: any = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: listPrefix,
      ContinuationToken: token,
    }));
    for (const obj of res.Contents || []) {
      if (!obj.Key) continue;
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
      deleted++;
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}

async function uploadSlot(monthPrefix: string, slotPrefix: string, file: File): Promise<string> {
  const safe = safeFilename(file.name || `${slotPrefix}.file`);
  const key = `billing-sources/${monthPrefix}/${slotPrefix}_${safe}`;
  const buf = new Uint8Array(await file.arrayBuffer());
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buf,
    ContentType: file.type || 'application/octet-stream',
  }));
  return key;
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

    const cardconnect = form.get('cardconnect');
    const refresh = form.get('refresh');
    const ccFile = cardconnect instanceof File && cardconnect.size > 0 ? cardconnect : null;
    const rfFile = refresh instanceof File && refresh.size > 0 ? refresh : null;

    if (!ccFile && !rfFile) {
      return NextResponse.json(
        { error: 'Provide at least one of: cardconnect, refresh' },
        { status: 400 }
      );
    }

    for (const [name, f] of [['cardconnect', ccFile], ['refresh', rfFile]] as const) {
      if (f && f.size > MAX_FILE_BYTES) {
        return NextResponse.json(
          { error: `${name} file too large. Max ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))} MB.` },
          { status: 400 }
        );
      }
    }

    const results: { slot: string; s3Key: string; filename: string; size: number }[] = [];
    if (ccFile) {
      await clearExistingSlot(prefix, 'cardconnect');
      const key = await uploadSlot(prefix, 'cardconnect', ccFile);
      results.push({ slot: 'cardconnect', s3Key: key, filename: ccFile.name, size: ccFile.size });
    }
    if (rfFile) {
      await clearExistingSlot(prefix, 'refresh');
      const key = await uploadSlot(prefix, 'refresh', rfFile);
      results.push({ slot: 'refresh', s3Key: key, filename: rfFile.name, size: rfFile.size });
    }

    return NextResponse.json({
      ok: true,
      month,
      monthPrefix: prefix,
      uploaded: results,
    });
  } catch (err: any) {
    console.error('billing/upload-sources error:', err);
    return NextResponse.json({ error: err.message || 'Upload failed' }, { status: 500 });
  }
}

export const runtime = 'nodejs';