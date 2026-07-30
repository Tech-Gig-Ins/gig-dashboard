// Located at: app/api/manifest/route.ts
//
// Per-month inclusion manifest. Single source of truth for which files count
// toward Master Dashboard and Consultant Report calculations.
// Storage: s3://<bucket>/manifests/{YYYY-MM}.json

import { NextResponse } from 'next/server';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const REGION = process.env.MY_AWS_REGION || 'us-east-1';
const BUCKET = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  },
});

type Manifest = { month: string; updatedAt: string; included: string[] };

async function streamToString(stream: any): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function manifestKey(month: string): string {
  return `manifests/${month}.json`;
}

function validMonth(month: string | null): month is string {
  return !!month && /^\d{4}-\d{2}$/.test(month);
}

async function loadManifest(month: string): Promise<Manifest> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: manifestKey(month) }));
    if (!res.Body) return { month, updatedAt: '', included: [] };
    const parsed = JSON.parse(await streamToString(res.Body));
    return {
      month,
      updatedAt: parsed.updatedAt || '',
      included: Array.isArray(parsed.included) ? parsed.included : [],
    };
  } catch (err: any) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
      return { month, updatedAt: '', included: [] };
    }
    throw err;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const month = searchParams.get('month');
  if (!validMonth(month)) {
    return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 });
  }
  try {
    return NextResponse.json(await loadManifest(month));
  } catch (err: any) {
    console.error('Manifest GET error:', err);
    return NextResponse.json({ error: err.message || 'Failed to load manifest' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { month, key, included } = body || {};
    if (!validMonth(month)) {
      return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 });
    }
    if (!key || typeof key !== 'string') {
      return NextResponse.json({ error: 'key is required' }, { status: 400 });
    }
    if (typeof included !== 'boolean') {
      return NextResponse.json({ error: 'included must be boolean' }, { status: 400 });
    }

    const manifest = await loadManifest(month);
    const set = new Set(manifest.included);
    if (included) set.add(key);
    else set.delete(key);

    const updated: Manifest = {
      month,
      updatedAt: new Date().toISOString(),
      included: Array.from(set).sort(),
    };

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: manifestKey(month),
      Body: JSON.stringify(updated, null, 2),
      ContentType: 'application/json',
    }));

    return NextResponse.json(updated);
  } catch (err: any) {
    console.error('Manifest POST error:', err);
    return NextResponse.json({ error: err.message || 'Failed to update manifest' }, { status: 500 });
  }
}