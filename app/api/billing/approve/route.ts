// app/api/billing/approve/route.ts
//
// POST body: { month: "July 2026", key: "billing-updates/2026-07/files/...", passcode: "AndrewGig" }
//
// Validates the passcode server-side and, on success, writes an approved.json
// pointer for the given month to s3://.../billing-updates/{YYYY-MM}/approved.json.
// The next GET on /api/billing/report-file?month=<same month> will surface
// that file as the displayed one for that month.

import { NextRequest, NextResponse } from 'next/server';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const REGION = process.env.MY_AWS_REGION || 'us-east-1';
const BUCKET = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';
const REQUIRED_PASSCODE = 'AndrewGig';

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  },
});

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
    const body = await req.json().catch(() => ({}));
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    const passcode = typeof body.passcode === 'string' ? body.passcode : '';
    const month = typeof body.month === 'string' ? body.month : '';

    if (!key) return NextResponse.json({ error: 'key is required' }, { status: 400 });
    if (passcode !== REQUIRED_PASSCODE) {
      return NextResponse.json({ error: 'Incorrect passcode' }, { status: 403 });
    }
    const prefix = monthToPrefix(month);
    if (!prefix) {
      return NextResponse.json(
        { error: `Invalid month "${month}". Expected format: "July 2026".` },
        { status: 400 }
      );
    }

    const jsonKey = `billing-updates/${prefix}/approved.json`;
    const bodyStr = JSON.stringify({ approvedKey: key, approvedAt: new Date().toISOString() }, null, 2);
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: jsonKey,
      Body: bodyStr,
      ContentType: 'application/json',
    }));

    return NextResponse.json({ ok: true, month, monthPrefix: prefix, approvedKey: key });
  } catch (err: any) {
    console.error('approve error:', err);
    return NextResponse.json({ error: err.message || 'Approval failed' }, { status: 500 });
  }
}

export const runtime = 'nodejs';