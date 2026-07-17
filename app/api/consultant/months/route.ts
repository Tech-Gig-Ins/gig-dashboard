// Located at: app/api/consultant/months/route.ts
//
// GET
//
// Returns every month (YYYY-MM) present under consultant-outputs/ that has
// both a report and a directory. Used by the frontend month selector.

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

const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];

function prefixToLabel(prefix: string): string | null {
  const m = prefix.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const yr = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10) - 1;
  if (mi < 0 || mi > 11) return null;
  return `${MONTH_NAMES[mi]} ${yr}`;
}

export async function GET() {
  try {
    // Aggregate per YYYY-MM prefix
    type MonthInfo = { prefix: string; hasReport: boolean; hasDirectory: boolean; latestMod: number };
    const byPrefix = new Map<string, MonthInfo>();

    let token: string | undefined;
    do {
      const res = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: 'consultant-outputs/',
        ContinuationToken: token,
      }));
      for (const obj of res.Contents || []) {
        if (!obj.Key || obj.Key.endsWith('/')) continue;
        // consultant-outputs/2026-07/GWU_Consultant_Report_July_2026.xlsx
        const parts = obj.Key.split('/');
        if (parts.length < 3) continue;
        const prefix = parts[1];
        if (!/^\d{4}-\d{2}$/.test(prefix)) continue;
        const filename = parts[parts.length - 1];
        const mod = obj.LastModified ? new Date(obj.LastModified).getTime() : 0;

        const cur = byPrefix.get(prefix) || { prefix, hasReport: false, hasDirectory: false, latestMod: 0 };
        if (/GWU_Consultant_Report/i.test(filename)) cur.hasReport = true;
        if (/consultant_directory/i.test(filename)) cur.hasDirectory = true;
        if (mod > cur.latestMod) cur.latestMod = mod;
        byPrefix.set(prefix, cur);
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);

    // Newest first
    const months = Array.from(byPrefix.values())
      .sort((a, b) => b.prefix.localeCompare(a.prefix))
      .map(m => ({
        prefix: m.prefix,
        label: prefixToLabel(m.prefix) || m.prefix,
        hasReport: m.hasReport,
        hasDirectory: m.hasDirectory,
        complete: m.hasReport && m.hasDirectory,
        generatedAt: m.latestMod > 0 ? new Date(m.latestMod).toISOString() : null,
      }));

    return NextResponse.json({ months });
  } catch (err: any) {
    console.error('consultant/months error:', err);
    return NextResponse.json({ error: err.message || 'Failed to list months' }, { status: 500 });
  }
}

export const runtime = 'nodejs';