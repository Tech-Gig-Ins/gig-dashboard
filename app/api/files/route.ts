// Next.js App Router API route
// Located at: app/api/files/route.ts
//
// Returns a JSON array of all files in the raw S3 bucket.
// Reads AWS credentials from environment variables.

import { NextResponse } from 'next/server';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const REGION = process.env.MY_AWS_REGION || 'us-east-1';
const BUCKET = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  },
});

console.log('REGION:', process.env.MY_AWS_REGION);
console.log('KEY_ID present:', !!process.env.MY_AWS_ACCESS_KEY_ID);
console.log('KEY_ID length:', (process.env.MY_AWS_ACCESS_KEY_ID || '').length);
console.log('SECRET present:', !!process.env.MY_AWS_SECRET_ACCESS_KEY);
console.log('SECRET length:', (process.env.MY_AWS_SECRET_ACCESS_KEY || '').length);
console.log('BUCKET:', process.env.S3_RAW_BUCKET);

export async function GET() {
  try {
    const files: Array<{
      key: string;
      filename: string;
      size: number;
      lastModified: string;
    }> = [];

    // Paginate in case there are more than 1000 files
    let continuationToken: string | undefined = undefined;

    do {
      const cmd: ListObjectsV2Command = new ListObjectsV2Command({
        Bucket: BUCKET,
        ContinuationToken: continuationToken,
      });
      const res = await s3.send(cmd);

      for (const obj of res.Contents || []) {
        if (!obj.Key) continue;
        // Skip folder markers (keys ending with /)
        if (obj.Key.endsWith('/')) continue;

        const parts = obj.Key.split('/');
        const filename = parts[parts.length - 1];

        files.push({
          key: obj.Key,
          filename,
          size: obj.Size ?? 0,
          lastModified: obj.LastModified?.toISOString() ?? new Date().toISOString(),
        });
      }

      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);

    // Sort newest first
    files.sort((a, b) => b.lastModified.localeCompare(a.lastModified));

    return NextResponse.json(files);
  } catch (err: any) {
    console.error('S3 list error:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to list S3 files' },
      { status: 500 }
    );
  }
}