// Located at: app/api/billing/approve/route.ts
//
// Persists the currently-approved Billing Test file to S3.
// Body: { key: string, passcode: string }
// Passcode must equal 'AndrewGig' (server-side check).
//
// On success, writes s3://<bucket>/billing-updates/billing-test-approved.json
// which is then picked up by GET /api/billing/report-file.
//
// To reset the display back to the default reconciliation output, delete the
// billing-test-approved.json object via the AWS console or:
//   aws s3 rm s3://gig-remittance-raw-prod/billing-updates/billing-test-approved.json --profile tech-admin

import { NextResponse } from 'next/server';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const REGION = process.env.MY_AWS_REGION || 'us-east-1';
const BUCKET = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';
const APPROVED_JSON_KEY = 'billing-updates/billing-test-approved.json';
const REQUIRED_PASSCODE = 'AndrewGig';

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  },
});

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const key: string | undefined = body?.key;
    const passcode: string | undefined = body?.passcode;

    if (!key || typeof key !== 'string') {
      return NextResponse.json({ error: 'Missing key' }, { status: 400 });
    }
    if (passcode !== REQUIRED_PASSCODE) {
      return NextResponse.json({ error: 'Incorrect passcode' }, { status: 401 });
    }

    // Verify the S3 object exists before pinning it as approved
    try {
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    } catch (err: any) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        return NextResponse.json({ error: 'File not found in S3' }, { status: 404 });
      }
      throw err;
    }

    const payload = JSON.stringify({
      approvedKey: key,
      approvedAt: new Date().toISOString(),
    }, null, 2);

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: APPROVED_JSON_KEY,
      Body: payload,
      ContentType: 'application/json',
    }));

    return NextResponse.json({ ok: true, approvedKey: key });
  } catch (err: any) {
    console.error('approve error:', err);
    return NextResponse.json({ error: err.message || 'Failed to save approval' }, { status: 500 });
  }
}

export const runtime = 'nodejs';