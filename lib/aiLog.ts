// Located at: lib/aiLog.ts
//
// AI Assistant log, shown on Monitor > AI Assistant (Platform Admin only).
// Every question asked to the assistant is recorded with its answer, by whom,
// when, on which page, what it looked up and which changes it proposed. When a
// proposed change is confirmed, cancelled or fails, that outcome is recorded too.
//
// Stored in S3, one small file per entry, under
//   user-activity/ai-assistant/<YYYY-MM-DD>/<time>-<order>-<random>.json
// (the existing user-activity/ permission covers it; the bucket's guardrails
// stop deletion). Entries can contain member details, as the answers do. Users
// never see this log; only the Platform Admin can read it.

import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { randomBytes } from 'crypto';

const BUCKET = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';
const PREFIX = 'user-activity/ai-assistant/';
const TIMEZONE = 'America/New_York';
const s3 = new S3Client({
  region: process.env.MY_AWS_REGION || 'us-east-1',
  credentials: process.env.MY_AWS_ACCESS_KEY_ID ? {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  } : undefined,
});

export type AiLogEntry = {
  kind: 'exchange' | 'outcome';
  at: string;              // ISO time
  user: string;            // the real person
  actingAs: string | null; // account viewed as, when in a View as tab
  convId: string;          // one chat panel session
  // exchange
  page?: string;
  question?: string;
  answer?: string;
  lookups?: string[];
  proposed?: string[];     // summaries of changes proposed (need Confirm)
  opened?: string[];       // pages opened, downloads started
  ms?: number;
  error?: string | null;
  // outcome
  change?: string;
  result?: 'confirmed' | 'cancelled' | 'failed';
  detail?: string;
};

const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
let seq = 0;

export async function recordAiEntry(e: Omit<AiLogEntry, 'at'>): Promise<void> {
  const now = new Date();
  const order = String(seq++ % 1e6).padStart(6, '0');
  const key = `${PREFIX}${ymd(now)}/${now.toISOString()}-${order}-${randomBytes(4).toString('hex')}.json`;
  try {
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: 'application/json',
      Body: JSON.stringify({ ...e, at: now.toISOString() }) }));
  } catch (err: any) {
    console.warn('[ai-log] could not record entry:', err?.name);
  }
}

/** Days with entries, newest first (up to 120). */
export async function listAiDays(): Promise<string[]> {
  const days: string[] = [];
  let token: string | undefined;
  do {
    const res: any = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, Delimiter: '/', ContinuationToken: token }));
    for (const p of res.CommonPrefixes || []) {
      const m = String(p.Prefix || '').match(/(\d{4}-\d{2}-\d{2})\/$/);
      if (m) days.push(m[1]);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return days.sort().reverse().slice(0, 120);
}

/** Every entry on a day (New York time), oldest first. */
export async function listAiEntries(day: string): Promise<AiLogEntry[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res: any = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${PREFIX}${day}/`, ContinuationToken: token }));
    for (const o of res.Contents || []) if (o.Key) keys.push(o.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  keys.sort();
  const out = await Promise.all(keys.map(async k => {
    try {
      const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: k }));
      return JSON.parse(await r.Body!.transformToString('utf-8')) as AiLogEntry;
    } catch { return null; }
  }));
  return out.filter((e): e is AiLogEntry => !!e);
}