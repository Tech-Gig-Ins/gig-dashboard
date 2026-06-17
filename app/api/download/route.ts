// Located at: app/api/download/route.ts
//
// Returns a short-lived presigned URL for downloading a specific file from S3.
// The browser then redirects to that URL and downloads directly from S3.
// URL expires after 5 minutes for security.

import { NextResponse } from 'next/server';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const REGION = process.env.MY_AWS_REGION || 'us-east-1';
const BUCKET = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  },
});

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key');

  if (!key) {
    return NextResponse.json({ error: 'Missing key parameter' }, { status: 400 });
  }

  try {
    const filename = key.split('/').pop() || 'download';

    const cmd = new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
      // Tell the browser to download (rather than open inline) and suggest the filename
      ResponseContentDisposition: `attachment; filename="${filename}"`,
    });

    // URL is valid for 5 minutes (300 seconds)
    const url = await getSignedUrl(s3, cmd, { expiresIn: 300 });

    return NextResponse.json({ url, filename });
  } catch (err: any) {
    console.error('Presigned URL error:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to generate download URL' },
      { status: 500 }
    );
  }
}