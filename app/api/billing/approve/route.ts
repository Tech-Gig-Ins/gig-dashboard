// app/api/billing/approve/route.ts
//
// POST body: { month: "July 2026", key: "billing-updates/2026-07/files/..." }
//
// Requires an authenticated admin (see lib/auth.ts), then writes
// pointer for the given month to s3://.../billing-updates/{YYYY-MM}/approved.json.
// The next GET on /api/billing/report-file?month=<same month> will surface
// that file as the displayed one for that month.
//
// DELETE ?month=July%202026
//   Clears the override so the month falls back to the algorithm-generated
//   Reconciliation_Output_<Month>_<Year>.xlsx.
//
//   It writes { approvedKey: null } rather than deleting approved.json. The
//   dashboard IAM user has s3:DeleteObject on billing-sources/* only, not on
//   billing-updates/*, so an actual delete would 403. report-file already
//   treats a non-string approvedKey as "no override", so this is equivalent
//   and needs no extra permission.

import { NextRequest, NextResponse } from 'next/server';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

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
  // Auth boundary. proxy.ts only does an optimistic cookie check;
  // this is what actually verifies the token and role.
  const gate = await requireAdmin(req);
  if (gate instanceof NextResponse) return gate;

  try {
    const body = await req.json().catch(() => ({}));
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    const month = typeof body.month === 'string' ? body.month : '';

    if (!key) return NextResponse.json({ error: 'key is required' }, { status: 400 });
    // The shared passcode is gone: requireAdmin() above already proved this
    // is a named admin, which is also what makes the CloudTrail and app logs
    // meaningful. `gate` is the verified Session here.
    console.log(`[billing/approve] ${gate.email} approving ${key} for ${month}`);
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

// Reset the month back to the generated reconciliation output.
export async function DELETE(req: NextRequest) {
  const gate = await requireAdmin(req);
  if (gate instanceof NextResponse) return gate;

  try {
    const month = req.nextUrl.searchParams.get('month') || '';
    const prefix = monthToPrefix(month);
    if (!prefix) {
      return NextResponse.json(
        { error: `Invalid month "${month}". Expected format: "July 2026".` },
        { status: 400 }
      );
    }

    const jsonKey = `billing-updates/${prefix}/approved.json`;
    const bodyStr = JSON.stringify(
      { approvedKey: null, clearedAt: new Date().toISOString(), clearedBy: gate.email },
      null, 2
    );
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: jsonKey,
      Body: bodyStr,
      ContentType: 'application/json',
    }));

    console.log(`[billing/approve] ${gate.email} reset ${month} to the generated report`);
    return NextResponse.json({ ok: true, month, monthPrefix: prefix, approvedKey: null });
  } catch (err: any) {
    console.error('approve reset error:', err);
    return NextResponse.json({ error: err.message || 'Reset failed' }, { status: 500 });
  }
}

export const runtime = 'nodejs';