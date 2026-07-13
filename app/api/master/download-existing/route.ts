// Located at: app/api/master/download-existing/route.ts
//
// Streams an existing file from S3 back to the browser as a download.
// Used by the upload modal so the user can inspect an existing file before
// deciding to override it.

import { NextRequest, NextResponse } from 'next/server';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const REGION = process.env.MY_AWS_REGION || 'us-east-1';
const BUCKET = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  },
});

async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const key = searchParams.get('key');

    if (!key) {
      return NextResponse.json({ error: 'Missing key' }, { status: 400 });
    }
    // Safety: only allow keys under carrier= folders (prevents someone probing
    // credentials, secrets, or billing data through this endpoint).
    if (!key.startsWith('carrier=')) {
      return NextResponse.json({ error: 'Invalid key path' }, { status: 400 });
    }
    // No path traversal
    if (key.includes('..')) {
      return NextResponse.json({ error: 'Invalid key' }, { status: 400 });
    }

    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    if (!res.Body) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    const buffer = await streamToBuffer(res.Body as any);
    const filename = key.split('/').pop() || 'download';

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': res.ContentType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(buffer.length),
        'Cache-Control': 'no-store',
      },
    });
  } catch (err: any) {
    console.error('download-existing error:', err);
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    return NextResponse.json({ error: err.message || 'Download failed' }, { status: 500 });
  }
}

export const runtime = 'nodejs';