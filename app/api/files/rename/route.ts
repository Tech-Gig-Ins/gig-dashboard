// app/api/files/rename/route.ts
//
// POST { sourceKey, canonicalLabel, month, year, overwrite? }
//
// Reclassifies a file to a different carrier and/or month. Admin only.
//
// Why this is just a rename: nothing in the system reads file contents to
// decide what a file is. classifyFile() and detectMonthYear() both parse the
// FILENAME, and Master, Consultant and Welfare all follow from that. So moving
// a file between carriers or months is renaming it, nothing more.
//
// The new name uses exactly the convention app/api/master/upload/route.ts
// produces:  "<Label> <Month> <Year><ext>"  e.g. "Cassena Remittance August 2026.xlsx"
//
// S3 has no rename. This is copy -> verify -> delete, in that order, so a
// failure can never lose the file: worst case a copy exists alongside the
// original and nothing is destroyed.

import { NextRequest, NextResponse } from 'next/server';
import {
  S3Client,
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
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

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
                     'July', 'August', 'September', 'October', 'November', 'December'];

// Same map as app/api/master/upload/route.ts.
const UPLOAD_FOLDERS: Record<string, string> = {
  'Cassena Remittance': 'carrier=gig/',
  'Cassena Credits': 'carrier=gig/',
  'EP6 Remittance': 'carrier=enrollconfidently/',
  'Enroll Confidently or PIOPAC': 'carrier=enrollconfidently/',
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
};

async function bodyToString(body: any): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep inclusion state with the file. The manifest stores S3 keys, so a rename
 * would otherwise orphan the entry and silently drop the file out of the
 * Master and Consultant calculations.
 *
 * Removes sourceKey from every manifest it appears in. If it was included
 * anywhere, adds targetKey to the manifest for the file's NEW month, so the
 * operator's intent survives a month change.
 */
async function moveManifestEntry(sourceKey: string, targetKey: string, newPrefix: string) {
  const touched: string[] = [];
  let wasIncluded = false;

  const listed = await s3.send(new ListObjectsV2Command({
    Bucket: BUCKET, Prefix: 'manifests/',
  }));

  for (const obj of listed.Contents || []) {
    const mKey = obj.Key || '';
    if (!mKey.endsWith('.json')) continue;

    let parsed: any;
    try {
      const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: mKey }));
      parsed = JSON.parse(await bodyToString(got.Body as any));
    } catch {
      continue;
    }
    const included: string[] = Array.isArray(parsed.included) ? parsed.included : [];
    if (!included.includes(sourceKey)) continue;

    wasIncluded = true;
    const next = included.filter(k => k !== sourceKey);
    // If the file is staying in this same month, keep it included here.
    if (mKey === `manifests/${newPrefix}.json` && !next.includes(targetKey)) {
      next.push(targetKey);
    }
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: mKey,
      Body: JSON.stringify({ ...parsed, included: next.sort() }, null, 2),
      ContentType: 'application/json',
    }));
    touched.push(mKey);
  }

  // Moved to a different month and was included: carry that across.
  const destManifest = `manifests/${newPrefix}.json`;
  if (wasIncluded && !touched.includes(destManifest)) {
    let parsed: any = { month: newPrefix, included: [] };
    try {
      const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: destManifest }));
      parsed = JSON.parse(await bodyToString(got.Body as any));
    } catch {
      // No manifest for that month yet; the shape above is what the app writes.
    }
    const included: string[] = Array.isArray(parsed.included) ? parsed.included : [];
    if (!included.includes(targetKey)) included.push(targetKey);
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: destManifest,
      Body: JSON.stringify({ ...parsed, month: newPrefix, included: included.sort() }, null, 2),
      ContentType: 'application/json',
    }));
    touched.push(destManifest);
  }

  return { wasIncluded, manifestsUpdated: touched };
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if (gate instanceof NextResponse) return gate;

  try {
    const body = await req.json().catch(() => ({}));
    const sourceKey = String(body.sourceKey || '').trim();
    const canonicalLabel = String(body.canonicalLabel || '').trim();
    const month = Number(body.month);
    const year = Number(body.year);
    const overwrite = body.overwrite === true;

    if (!sourceKey || !sourceKey.startsWith('carrier=') || sourceKey.includes('..')) {
      return NextResponse.json(
        { error: 'sourceKey must be an existing key under carrier=' },
        { status: 400 }
      );
    }
    if (!UPLOAD_FOLDERS[canonicalLabel]) {
      return NextResponse.json(
        { error: `Unknown file type "${canonicalLabel}"`, allowed: Object.keys(UPLOAD_FOLDERS) },
        { status: 400 }
      );
    }
    if (!Number.isInteger(month) || month < 0 || month > 11) {
      return NextResponse.json({ error: 'month must be 0-11' }, { status: 400 });
    }
    if (!Number.isInteger(year) || year < 2020 || year > 2099) {
      return NextResponse.json({ error: 'year must be 2020-2099' }, { status: 400 });
    }
    if (!(await objectExists(sourceKey))) {
      return NextResponse.json({ error: `Source file not found: ${sourceKey}` }, { status: 404 });
    }

    const sourceName = sourceKey.split('/').pop() || '';
    const dot = sourceName.lastIndexOf('.');
    const ext = dot >= 0 ? sourceName.slice(dot).toLowerCase() : '';

    const folder = UPLOAD_FOLDERS[canonicalLabel];
    const targetKey = `${folder}${canonicalLabel} ${MONTH_NAMES[month]} ${year}${ext}`;
    const newPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;

    if (targetKey === sourceKey) {
      return NextResponse.json(
        { ok: true, unchanged: true, message: 'The file already has this name.', key: sourceKey }
      );
    }

    if (!overwrite && (await objectExists(targetKey))) {
      return NextResponse.json({
        error: 'A file with that name already exists.',
        conflictKey: targetKey,
        hint: 'Resend with overwrite: true to replace it.',
      }, { status: 409 });
    }

    // 1. Copy. The bucket applies SSE-KMS by default, so the copy stays encrypted.
    await s3.send(new CopyObjectCommand({
      Bucket: BUCKET,
      CopySource: encodeURIComponent(`${BUCKET}/${sourceKey}`),
      Key: targetKey,
    }));

    // 2. Verify BEFORE deleting. Never destroy the original on an unconfirmed copy.
    if (!(await objectExists(targetKey))) {
      return NextResponse.json({
        error: 'Copy could not be verified; the original was left untouched.',
        sourceKey,
      }, { status: 500 });
    }

    // 3. Delete the original. The bucket is versioned, so this writes a delete
    //    marker and the previous version remains recoverable.
    let deleted = false;
    let deleteError: string | null = null;
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: sourceKey }));
      deleted = true;
    } catch (err: any) {
      // Most likely a missing s3:DeleteObject grant on carrier=*. The copy is
      // already in place, so report it rather than failing the whole move.
      deleteError = err?.name || err?.message || 'delete failed';
      console.warn(`[files/rename] copy succeeded but delete failed for ${sourceKey}: ${deleteError}`);
    }

    const manifest = await moveManifestEntry(sourceKey, targetKey, newPrefix);

    console.log(
      `[files/rename] ${gate.email} moved ${sourceKey} -> ${targetKey} ` +
      `(deleted=${deleted}, included=${manifest.wasIncluded})`
    );

    return NextResponse.json({
      ok: true,
      sourceKey,
      targetKey,
      newFilename: targetKey.split('/').pop(),
      canonicalLabel,
      month: `${MONTH_NAMES[month]} ${year}`,
      originalDeleted: deleted,
      deleteError,
      ...manifest,
      movedBy: gate.email,
    });
  } catch (err: any) {
    console.error('[files/rename] error:', err);
    return NextResponse.json({ error: err.message || 'Rename failed' }, { status: 500 });
  }
}

export const runtime = 'nodejs';
