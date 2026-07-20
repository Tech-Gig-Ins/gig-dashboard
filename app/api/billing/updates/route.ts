// app/api/billing/updates/route.ts
//
// Per-month Report Updates for the Billing tab.
//
// GET  ?month=July%202026 -> returns updates for that month
// POST FormData: month, name, comments, optional file
//       -> uploads file (if any), appends entry to that month's manifest
//
// S3 layout (per-month):
//   {S3_RAW_BUCKET}/billing-updates/{YYYY-MM}/manifest.json
//   {S3_RAW_BUCKET}/billing-updates/{YYYY-MM}/files/{uuid}-{original-filename}
//
// Existing entries from the old flat layout can be migrated by copying
//   billing-updates/manifest.json -> billing-updates/2026-07/manifest.json
// (files/ contents can stay where they are; the s3Key strings still resolve.)

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
const MAX_FILE_BYTES = 25 * 1024 * 1024;

type BillingUpdate = {
  id: string;
  name: string;
  comments: string;
  date: string;
  filename: string | null;
  s3Key: string | null;
  size: number | null;
};

// "July 2026" -> "2026-07"
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

function manifestKey(prefix: string): string {
  return `billing-updates/${prefix}/manifest.json`;
}
function filesPrefix(prefix: string): string {
  return `billing-updates/${prefix}/files/`;
}

async function loadManifest(key: string): Promise<BillingUpdate[]> {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
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
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return [];
    throw e;
  }
}

async function saveManifest(key: string, updates: BillingUpdate[]): Promise<void> {
  const body = JSON.stringify(updates, null, 2);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: 'application/json',
  }));
}

function safeFilename(name: string): string {
  return name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 200);
}

export async function GET(request: Request) {
  try {
    if (!BUCKET) {
      return NextResponse.json({ error: 'S3_RAW_BUCKET not configured' }, { status: 500 });
    }
    const { searchParams } = new URL(request.url);
    const month = searchParams.get('month') || '';
    const prefix = monthToPrefix(month);
    if (!prefix) {
      return NextResponse.json(
        { error: `Invalid month "${month}". Expected format: "July 2026".` },
        { status: 400 }
      );
    }
    const updates = await loadManifest(manifestKey(prefix));
    updates.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return NextResponse.json({ month, monthPrefix: prefix, updates });
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
    const monthRaw = formData.get('month');
    const nameRaw = formData.get('name');
    const commentsRaw = formData.get('comments');
    const fileRaw = formData.get('file');

    const monthStr = typeof monthRaw === 'string' ? monthRaw : '';
    const prefix = monthToPrefix(monthStr);
    if (!prefix) {
      return NextResponse.json(
        { error: `Invalid month "${monthStr}". Expected format: "July 2026".` },
        { status: 400 }
      );
    }

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
      s3Key = `${filesPrefix(prefix)}${id}-${filename}`;
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

    const key = manifestKey(prefix);
    const updates = await loadManifest(key);
    updates.push(newUpdate);
    await saveManifest(key, updates);

    return NextResponse.json({ update: newUpdate, month: monthStr, monthPrefix: prefix });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Failed to save update' }, { status: 500 });
  }
}