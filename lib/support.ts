// Located at: lib/support.ts
//
// Support pages: the daily AI support summaries, read directly from the Google
// Doc logs ("AI Support Summary Log yyyy-MM") in the shared Drive folder. Read
// only: the Docs and the Apps Script that writes them are not changed.
//
// Refreshed once a day: the summary script writes the Docs just after
// midnight, so the folder is checked again only on the first request after
// 1 AM New York time. Each Doc is parsed once per version (its Drive
// modifiedTime) and kept in server memory and in S3 under cache/support/v1/,
// so a restarted server reads the small parsed copies instead of Google.
//
// Open or closed comes from the colour the script gave each case heading
// (yellow #fff3a0 = open, green #c8f7c8 = closed), exactly as in the Doc.
//
// The notification dot's "seen" state is per person, in S3 at
// user-activity/<email>.support-seen.json (existing permission).

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { gzipSync, gunzipSync } from 'zlib';
import { createHash } from 'crypto';
import { listDocs, getDoc, type DriveFile } from '@/lib/googleDocs';

export const SUPPORT_FOLDER_ID = '1PEYUBaEpM12jlXvMa2rpFPrnGS1C2H4L';
const LOG_NAME = 'AI Support Summary Log';
const TIMEZONE = 'America/New_York';
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export type SupportPage = 'pending' | 'resolved';
export type SupportItem = { subject: string; msgCount: number; summary: string; isOpen: boolean };
export type SupportReport = { date: string; dayLabel: string; emails: number; totalMessages: number; busiest: string; items: SupportItem[] };
export type SupportDay = { date: string; pending: number; resolved: number; emails: number; totalMessages: number };

export const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// ---------- parsing one Doc (same rules as the log's own layout) ----------

type Para = { text: string; heading: string; hr: boolean; bold: boolean; rgb: { red?: number; green?: number; blue?: number } | null };

function paragraphs(doc: any): Para[] {
  const out: Para[] = [];
  for (const el of doc?.body?.content || []) {
    const p = el.paragraph;
    if (!p) continue;
    const els = p.elements || [];
    const first = els.find((e: any) => e.textRun && e.textRun.content.replace(/\n$/, '') !== '')?.textRun;
    out.push({
      text: els.map((e: any) => e.textRun?.content || '').join('').replace(/\n$/, ''),
      heading: p.paragraphStyle?.namedStyleType || 'NORMAL_TEXT',
      hr: els.some((e: any) => e.horizontalRule),
      bold: !!first?.textStyle?.bold,
      rgb: first?.textStyle?.backgroundColor?.color?.rgbColor || null,
    });
  }
  return out;
}

// Yellow (#fff3a0, red 1.0) = open; green (#c8f7c8, red 0.78) = closed.
const isOpenColour = (rgb: Para['rgb']) => !!rgb && (rgb.red ?? 0) > 0.95 && (rgb.blue ?? 0) < 0.8;

export function parseLogDoc(doc: any): Map<string, SupportReport> {
  const days = new Map<string, SupportReport>();
  let day: SupportReport | null = null;
  let item: { subject: string; msgCount: number; isOpen: boolean; lines: string[] } | null = null;
  const finishItem = () => {
    if (item && day) day.items.push({ subject: item.subject, msgCount: item.msgCount, summary: item.lines.join('\n').trim(), isOpen: item.isOpen });
    item = null;
  };
  const finishDay = () => { finishItem(); if (day) days.set(day.date, day); day = null; };

  for (const p of paragraphs(doc)) {
    if (p.hr) { finishItem(); continue; }
    if (p.heading === 'HEADING_2' && p.text.startsWith('AI Support Summary for ')) {
      finishDay();
      const label = p.text.replace(/^AI Support Summary for /, '').trim();
      const m = label.match(/([A-Za-z]+) (\d{1,2}), (\d{4})$/);
      const mi = m ? MONTHS.indexOf(m[1]) : -1;
      if (!m || mi < 0) continue;
      day = { date: `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`, dayLabel: label,
              emails: 0, totalMessages: 0, busiest: 'n/a', items: [] };
      continue;
    }
    if (!day) continue;
    const d: SupportReport = day;
    if (!item) {
      let m: RegExpMatchArray | null;
      if ((m = p.text.match(/^EMAILS: (\d+)$/))) { d.emails = Number(m[1]); continue; }
      if ((m = p.text.match(/^Total messages: (\d+)$/))) { d.totalMessages = Number(m[1]); continue; }
      if ((m = p.text.match(/^Busiest hour: (.+)$/))) { d.busiest = m[1]; continue; }
      const h = p.text.match(/^(\d+)\. ([\s\S]*) \(msg:(\d+)\)$/);
      if (h && p.bold) item = { subject: h[2], msgCount: Number(h[3]), isOpen: isOpenColour(p.rgb), lines: [] };
      continue;
    }
    item.lines.push(p.text);
  }
  finishDay();
  return days;
}

// ---------- reading the folder, cached ----------

// The "day" for caching starts at 1 AM New York time: the date of (now - 1 hour).
function cacheDay(): string {
  return ymd(new Date(Date.now() - 60 * 60 * 1000));
}

let listing: { day: string; files: DriveFile[] } | null = null;
let listingInFlight: Promise<DriveFile[]> | null = null;
const parsed = new Map<string, { modifiedTime: string; days: Map<string, SupportReport> }>();

async function currentFiles(): Promise<DriveFile[]> {
  const day = cacheDay();
  if (listing && listing.day === day) return listing.files;
  if (!listingInFlight) {
    listingInFlight = listDocs(SUPPORT_FOLDER_ID, LOG_NAME)
      .then(files => { listing = { day, files }; return files; })
      .finally(() => { listingInFlight = null; });
  }
  return listingInFlight;
}

const docCacheKey = (f: DriveFile) =>
  `cache/support/v1/${f.id}-${createHash('sha1').update(f.modifiedTime).digest('hex').slice(0, 12)}.json.gz`;

// One Doc's reports: memory, then the S3 copy, then Google (saved for next time).
async function docReports(f: DriveFile): Promise<Map<string, SupportReport>> {
  const hit = parsed.get(f.id);
  if (hit && hit.modifiedTime === f.modifiedTime) return hit.days;
  let days: Map<string, SupportReport> | null = null;
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: docCacheKey(f) }));
    const list: SupportReport[] = JSON.parse(gunzipSync(Buffer.from(await res.Body!.transformToByteArray())).toString('utf8'));
    days = new Map(list.map(r => [r.date, r]));
  } catch { /* not cached yet */ }
  if (!days) {
    days = parseLogDoc(await getDoc(f.id));
    s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: docCacheKey(f), ContentType: 'application/gzip',
      Body: gzipSync(Buffer.from(JSON.stringify([...days.values()]), 'utf8')),
    })).catch(err => console.warn('[support] cache write failed:', err?.name));
  }
  parsed.set(f.id, { modifiedTime: f.modifiedTime, days });
  return days;
}

async function allReports(): Promise<Map<string, SupportReport>> {
  const files = (await currentFiles())
    .filter(f => /^AI Support Summary Log \d{4}-\d{2}$/.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  await Promise.all(files.map(docReports));
  const all = new Map<string, SupportReport>();
  for (const f of files) for (const [date, r] of parsed.get(f.id)!.days) all.set(date, r);
  return all;
}

export async function listDays(): Promise<SupportDay[]> {
  const days = [...(await allReports()).values()].map(r => ({
    date: r.date,
    pending: r.items.filter(i => i.isOpen).length,
    resolved: r.items.filter(i => !i.isOpen).length,
    emails: r.emails,
    totalMessages: r.totalMessages,
  }));
  return days.sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** The day's report, plus the calendar day before's figures (null if that day has no summary). */
export async function getReport(date: string): Promise<(SupportReport & {
  previous: { emails: number; totalMessages: number; pending: number; resolved: number } | null;
}) | null> {
  if (!isDate(date)) return null;
  const all = await allReports();
  const report = all.get(date);
  if (!report) return null;
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  const before = all.get(d.toISOString().slice(0, 10));
  return { ...report, previous: before ? {
    emails: before.emails, totalMessages: before.totalMessages,
    pending: before.items.filter(i => i.isOpen).length,
    resolved: before.items.filter(i => !i.isOpen).length,
  } : null };
}

// ---------- notification dot (per person) ----------

const BUCKET = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';
const s3 = new S3Client({
  region: process.env.MY_AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  },
});
const seenKey = (email: string) => `user-activity/${email.trim().toLowerCase()}.support-seen.json`;

// Per person: which days they have opened on each page, and "since", the
// newest day when they first used Support. Days before "since" count as seen,
// so the first visit does not mark the whole history as new.
type Seen = { since?: string; viewed?: { pending?: string[]; resolved?: string[] }; pending?: string; resolved?: string };

async function readSeen(email: string): Promise<Seen> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: seenKey(email) }));
    return JSON.parse(await res.Body!.transformToString('utf-8'));
  } catch {
    return {};
  }
}
async function writeSeen(email: string, seen: Seen) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: seenKey(email), Body: JSON.stringify(seen), ContentType: 'application/json',
  }));
}
function viewedList(seen: Seen, page: SupportPage): string[] {
  const list = [...(seen.viewed?.[page] || [])];
  if (seen[page]) list.push(seen[page]!); // older format: the latest day opened
  return list;
}

const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/**
 * Sidebar dot: the newest summary is "fresh" only on the day it is written
 * (day D's summary is written just after midnight on D+1). A page shows a dot
 * when that fresh summary has entries for it and this person has not opened
 * that day on that page. Nothing carries over to the next day.
 *
 * Calendar marks: a day with entries that this person has not opened on that
 * page yet, from "since" onward.
 */
export async function dotsFor(email: string, days: SupportDay[]) {
  const latest = days[0];
  const seen = await readSeen(email);
  if (!seen.since && latest) {
    seen.since = latest.date;
    await writeSeen(email, seen).catch(() => {});
  }
  const fresh = !!latest && (latest.date === ymd(new Date(Date.now() - 864e5)) || latest.date === ymd(new Date()));
  const viewed = { pending: viewedList(seen, 'pending'), resolved: viewedList(seen, 'resolved') };
  return {
    latestDate: latest?.date || null,
    since: seen.since || null,
    viewed,
    pending: fresh && latest.pending > 0 && !viewed.pending.includes(latest.date),
    resolved: fresh && latest.resolved > 0 && !viewed.resolved.includes(latest.date),
  };
}

/** Records that this person opened `date` on `page` (kept for the last 400 days). */
export async function markSeen(email: string, page: SupportPage, date: string) {
  const seen = await readSeen(email);
  const list = seen.viewed?.[page] || [];
  if (list.includes(date)) return;
  seen.viewed = { ...(seen.viewed || {}), [page]: [...list, date].sort().slice(-400) };
  await writeSeen(email, seen);
}