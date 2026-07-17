// Located at: app/api/consultant/check-uploads/route.ts
//
// GET ?month=July%202026
//
// Lists s3://.../consultant-inputs/YYYY-MM/ and returns which of the 10
// required source-file slots are filled. Used by the frontend to render the
// upload checklist. Also flags whether the month is a fresh upload or an
// overwrite (any files already present triggers the override warning).

import { NextRequest, NextResponse } from 'next/server';
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

const REQUIRED_FILES: Array<[string, string]> = [
  ['TPA_Cassena',           'Cassena (TPA)'],
  ['TPA_Northstead',        'Northstead (TPA)'],
  ['TPA_GWU3',              'GWU3 (TPA)'],
  ['TPA_GIG',               'GIG TPA.com'],
  ['TPA_BDSB',              'BDSB (TPA)'],
  ['426_EP6',               'EP6IX (426)'],
  ['PIOPAC',                'PIOPAC'],
  ['CoreChoice_Direct_T1',  'Decisely GWU2 (CoreChoice T1)'],
  ['CoreChoice_Direct_T3',  'Decisely GWU1 (CoreChoice T3)'],
  ['Gig_Workers',           'Refresh (Gig Workers)'],
];

function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

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

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const month = searchParams.get('month') || '';
    const prefix = monthToPrefix(month);
    if (!prefix) {
      return NextResponse.json(
        { error: `Invalid month "${month}". Expected "July 2026".` },
        { status: 400 }
      );
    }

    const s3prefix = `consultant-inputs/${prefix}/`;
    const uploaded: Array<{ filename: string; key: string; size: number; lastModified: string | null }> = [];
    let token: string | undefined;
    do {
      const res = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: s3prefix,
        ContinuationToken: token,
      }));
      for (const obj of res.Contents || []) {
        if (!obj.Key || obj.Key.endsWith('/')) continue;
        const filename = obj.Key.split('/').pop() || obj.Key;
        uploaded.push({
          filename,
          key: obj.Key,
          size: obj.Size || 0,
          lastModified: obj.LastModified ? new Date(obj.LastModified).toISOString() : null,
        });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);

    // For each required slot, find the first matching uploaded file
    const slots = REQUIRED_FILES.map(([slot, label]) => {
      const target = normKey(slot);
      const match = uploaded.find(u => normKey(u.filename).includes(target));
      return {
        slot,
        label,
        uploaded: !!match,
        filename: match?.filename || null,
        s3Key: match?.key || null,
        size: match?.size || null,
        lastModified: match?.lastModified || null,
      };
    });

    const uploadedCount = slots.filter(s => s.uploaded).length;
    return NextResponse.json({
      month,
      monthPrefix: prefix,
      slots,
      uploadedCount,
      requiredCount: REQUIRED_FILES.length,
      complete: uploadedCount === REQUIRED_FILES.length,
      // Any file at all present -> re-uploading counts as an override
      hasExistingUpload: uploaded.length > 0,
      totalFilesInPrefix: uploaded.length,
    });
  } catch (err: any) {
    console.error('consultant/check-uploads error:', err);
    return NextResponse.json({ error: err.message || 'Failed to check uploads' }, { status: 500 });
  }
}

export const runtime = 'nodejs';