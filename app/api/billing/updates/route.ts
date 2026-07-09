// app/api/billing/updates/route.ts
//
// Report Updates for the Billing tab.
//
// GET  -> returns the list of updates from billing-updates/manifest.json in S3.
// POST -> accepts multipart form data: name (required), comments (required), file (optional).
//         Uploads the file (if present) to billing-updates/files/{uuid}-{filename},
//         appends a new entry to manifest.json.
//
// S3 layout:
//   {S3_RAW_BUCKET}/billing-updates/manifest.json
//   {S3_RAW_BUCKET}/billing-updates/files/{uuid}-{original-filename}

import { NextResponse } from 'next/server';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

const s3 = new S3Client({
  region: process.env.MY_AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY || '',
  },
});

const BUCKET = process.env.S3_RAW_BUCKET || '';
const MANIFEST_KEY = 'billing-updates/manifest.json';
const FILES_PREFIX = 'billing-updates/files/';

// Cap file size to avoid stuffing very large uploads through the API route.
// 25 MB is generous for most attachments.
const MAX_FILE_BYTES = 25 * 1024 * 1024;

type BillingUpdate = {
  id: string;
  name: string;
  comments: string;
  date: string;              // ISO timestamp
  filename: string | null;   // original filename, null if no file attached
  s3Key: string | null;      // full S3 key, null if no file attached
  size: number | null;       // bytes, null if no file
};

async function loadManifest(): Promise<BillingUpdate[]> {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: MANIFEST_KEY }));
    const stream = obj.Body as any;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf-8');
    if (!text.trim()) return [];
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed as BillingUpdate[];
  } catch (e: any) {
    // Manifest doesn't exist yet - return empty list
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
      return [];
    }
    throw e;
  }
}

async function saveManifest(updates: BillingUpdate[]): Promise<void> {
  const body = JSON.stringify(updates, null, 2);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: MANIFEST_KEY,
    Body: body,
    ContentType: 'application/json',
  }));
}

// Sanitize filename to something safe for S3 keys (spaces + odd chars allowed but stripped of control chars)
function safeFilename(name: string): string {
  return name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 200);
}

export async function GET() {
  try {
    if (!BUCKET) {
      return NextResponse.json({ error: 'S3_RAW_BUCKET not configured' }, { status: 500 });
    }
    const updates = await loadManifest();
    // Sort newest first
    updates.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return NextResponse.json({ updates });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Failed to load updates' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    if (!BUCKET) {
      return NextResponse.json({ error: 'S3_RAW_BUCKET not configured' }, { status: 500 });
    }
    const formData = await request.formData();
    const nameRaw = formData.get('name');
    const commentsRaw = formData.get('comments');
    const fileRaw = formData.get('file');

    // Validate required fields
    const name = (typeof nameRaw === 'string' ? nameRaw : '').trim();
    const comments = (typeof commentsRaw === 'string' ? commentsRaw : '').trim();
    if (!name || !comments) {
      return NextResponse.json(
        { error: 'Both name and comments are required' },
        { status: 400 },
      );
    }

    let filename: string | null = null;
    let s3Key: string | null = null;
    let size: number | null = null;

    // File is optional
    const file = fileRaw && typeof fileRaw !== 'string' ? (fileRaw as File) : null;
    if (file && file.size > 0) {
      if (file.size > MAX_FILE_BYTES) {
        return NextResponse.json(
          { error: `File too large. Max ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))} MB.` },
          { status: 400 },
        );
      }
      filename = safeFilename(file.name || 'upload');
      const id = randomUUID();
      s3Key = `${FILES_PREFIX}${id}-${filename}`;
      size = file.size;
      const arrayBuffer = await file.arrayBuffer();
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: s3Key,
        Body: Buffer.from(arrayBuffer),
        ContentType: file.type || 'application/octet-stream',
      }));
    }

    const newUpdate: BillingUpdate = {
      id: randomUUID(),
      name,
      comments,
      date: new Date().toISOString(),
      filename,
      s3Key,
      size,
    };

    // Load, append, save. This is last-write-wins - fine for our low concurrency.
    const updates = await loadManifest();
    updates.push(newUpdate);
    await saveManifest(updates);

    return NextResponse.json({ update: newUpdate });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Failed to save update' }, { status: 500 });
  }
}