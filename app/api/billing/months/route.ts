// app/api/billing/months/route.ts
//
// GET -> list of months that have EITHER a reconciliation file OR a chat manifest
//        in S3. Sorted newest first.
//
// Reconciliation files: filenames like "Reconciliation_Output_July_2026.xlsx"
// Chat manifests:       "billing-updates/{YYYY-MM}/manifest.json"

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

const MONTH_NAMES_LONG = ['January','February','March','April','May','June',
                          'July','August','September','October','November','December'];
const MONTH_NAMES_LOWER = MONTH_NAMES_LONG.map(m => m.toLowerCase());

function prefixToLabel(prefix: string): string | null {
  const m = prefix.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const yr = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10) - 1;
  if (mi < 0 || mi > 11) return null;
  return `${MONTH_NAMES_LONG[mi]} ${yr}`;
}

// Parse "Reconciliation_Output_July_2026.xlsx" -> "2026-07"
function reconFilenameToPrefix(filename: string): string | null {
  const lower = filename.toLowerCase();
  for (let i = 0; i < MONTH_NAMES_LOWER.length; i++) {
    if (lower.includes(MONTH_NAMES_LOWER[i])) {
      const yrMatch = lower.match(/(20\d{2})/);
      if (yrMatch) return `${yrMatch[1]}-${String(i + 1).padStart(2, '0')}`;
    }
  }
  return null;
}

export async function GET() {
  try {
    // Aggregate per YYYY-MM prefix
    type MonthInfo = { prefix: string; hasReport: boolean; hasChat: boolean; latestMod: number };
    const byPrefix = new Map<string, MonthInfo>();

    // 1. Scan billing-reports/ for Reconciliation_Output_*.xlsx
    let token: string | undefined;
    do {
      const res: any = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: 'billing-reports/',
        ContinuationToken: token,
      }));
      for (const obj of res.Contents || []) {
        if (!obj.Key) continue;
        const fname = obj.Key.split('/').pop() || '';
        if (!/Reconciliation_Output_.*\.xlsx$/i.test(fname)) continue;
        const prefix = reconFilenameToPrefix(fname);
        if (!prefix) continue;
        const mod = obj.LastModified ? new Date(obj.LastModified).getTime() : 0;
        const cur = byPrefix.get(prefix) || { prefix, hasReport: false, hasChat: false, latestMod: 0 };
        cur.hasReport = true;
        if (mod > cur.latestMod) cur.latestMod = mod;
        byPrefix.set(prefix, cur);
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);

    // 2. Scan billing-updates/ for {YYYY-MM}/manifest.json and {YYYY-MM}/approved.json
    token = undefined;
    do {
      const res: any = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: 'billing-updates/',
        ContinuationToken: token,
      }));
      for (const obj of res.Contents || []) {
        if (!obj.Key) continue;
        const parts = obj.Key.split('/');
        // billing-updates / {YYYY-MM} / ...
        if (parts.length < 3) continue;
        const prefix = parts[1];
        if (!/^\d{4}-\d{2}$/.test(prefix)) continue;
        const last = parts[parts.length - 1];
        if (last !== 'manifest.json' && last !== 'approved.json') continue;
        const mod = obj.LastModified ? new Date(obj.LastModified).getTime() : 0;
        const cur = byPrefix.get(prefix) || { prefix, hasReport: false, hasChat: false, latestMod: 0 };
        if (last === 'manifest.json') cur.hasChat = true;
        if (mod > cur.latestMod) cur.latestMod = mod;
        byPrefix.set(prefix, cur);
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);

    const months = Array.from(byPrefix.values())
      .sort((a, b) => b.prefix.localeCompare(a.prefix))
      .map(m => ({
        prefix: m.prefix,
        label: prefixToLabel(m.prefix) || m.prefix,
        hasReport: m.hasReport,
        hasChat: m.hasChat,
        lastActivity: m.latestMod > 0 ? new Date(m.latestMod).toISOString() : null,
      }));

    return NextResponse.json({ months });
  } catch (err: any) {
    console.error('billing/months error:', err);
    return NextResponse.json({ error: err.message || 'Failed to list months' }, { status: 500 });
  }
}

export const runtime = 'nodejs';