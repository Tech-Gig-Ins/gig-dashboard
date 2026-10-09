// Located at: lib/paMonitor.ts
//
// PA Monitor: a record of what the Platform Admin does while using View as.
// getSession() calls logProxyRequest() for every request made from a View as
// tab, and the View as start and stop are recorded by /api/impersonate.
// Each event names the real person, the account being viewed as, the time and
// the action. Shown on Activity > PA Monitor.
//
// Stored in S3, one small file per event, under
//   user-activity/pa-monitor/<YYYY-MM-DD>/<time>-<random>.json
// (the existing user-activity/ permission covers it). Searches and chat text
// are recorded as entered, so the log can contain member names; it is stored
// in the encrypted bucket and only Admin can see it.
//
// Like the Welfare lock, this makes actions visible and deliberate. It is not
// tamper-proof against someone who holds the AWS keys.

import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { randomBytes } from 'crypto';

const BUCKET = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';
const PREFIX = 'user-activity/pa-monitor/';
const TIMEZONE = 'America/New_York';
const s3 = new S3Client({
  region: process.env.MY_AWS_REGION || 'us-east-1',
  credentials: process.env.MY_AWS_ACCESS_KEY_ID ? {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  } : undefined,
});

export type PaEvent = {
  at: string;        // ISO time
  actor: string;     // the real person (the Platform Admin)
  actingAs: string;  // the account being viewed as
  action: string;    // e.g. "Granted Welfare access"
  detail: string;    // e.g. "andrew@... for 3 day(s)"
  inferred?: boolean; // added by the monitor, not sent by the browser
};

const VIEW_AS_MS = 60 * 60 * 1000; // View as lasts at most 1 hour

/**
 * A crash, power cut or killed browser sends nothing, so some View as starts
 * have no end. For each start (or resume) not followed by an end for the same
 * person and account, add an inferred end at its 1-hour expiry, once that time
 * has passed. Inferred rows are marked so the page can show them differently.
 */
export function withInferredEnds(events: PaEvent[], now = Date.now()): PaEvent[] {
  const open = new Map<string, PaEvent>(); // actor|account -> the start that is still open
  const added: PaEvent[] = [];
  const close = (k: string) => {
    const start = open.get(k);
    if (!start) return;
    const end = Date.parse(start.at) + VIEW_AS_MS;
    if (end <= now) {
      added.push({ at: new Date(end).toISOString(), actor: start.actor, actingAs: start.actingAs,
        action: 'Ended View as', detail: 'No exit was received (for example the browser crashed), so this is when the 1 hour limit ended it', inferred: true });
    }
    open.delete(k);
  };
  for (const e of events) {
    const k = `${e.actor}|${e.actingAs}`;
    if (e.action === 'Started View as' || e.action === 'Resumed View as') {
      // A new start for the same account while one is open: the earlier one
      // still ends at its own expiry (both tabs may have been open together).
      if (e.action === 'Started View as') close(k);
      open.set(k, e);
    } else if (e.action === 'Ended View as') {
      open.delete(k);
    }
  }
  for (const k of [...open.keys()]) close(k);
  return [...events, ...added].sort((a, b) => a.at.localeCompare(b.at));
}

const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const cut = (s: unknown, n = 300) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '...' : t;
};
const fileName = (key: unknown) => String(key || '').split('/').pop() || '';
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
// "2026-10" -> "October 2026"; other text is returned as is.
const monthText = (v: unknown) => {
  const m = String(v || '').match(/^(\d{4})-(\d{2})$/);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(v || '');
};
// "2026-10-09" -> "Friday, October 9, 2026"
const dayText = (v: unknown) => {
  const s = String(v || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(s)
    ? new Date(s + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    : s;
};
const plural = (n: unknown, word: string) => `${n} ${word}${Number(n) === 1 ? '' : 's'}`;

// A per-server counter keeps events from the same millisecond in order.
let seq = 0;

export async function recordEvent(e: Omit<PaEvent, 'at'>): Promise<void> {
  const now = new Date();
  const event: PaEvent = { at: now.toISOString(), ...e, detail: cut(e.detail, 600) };
  const order = String(seq++ % 1e6).padStart(6, '0');
  const key = `${PREFIX}${ymd(now)}/${now.toISOString()}-${order}-${randomBytes(4).toString('hex')}.json`;
  try {
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: JSON.stringify(event), ContentType: 'application/json' }));
  } catch (err: any) {
    console.warn('[pa-monitor] could not record event:', err?.name);
  }
}

// What a request from a View as tab did, in plain words. null = not worth
// recording (page loads, polling, lists).
async function describe(req: Request): Promise<{ action: string; detail: string } | null> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const m = req.method.toUpperCase();
  const q = (k: string) => url.searchParams.get(k) || '';
  const json = async () => { try { return await req.clone().json(); } catch { return {}; } };

  if (path === '/api/impersonate' || path.startsWith('/api/auth/') || path === '/api/version') return null;

  if (m === 'GET') {
    if (path === '/api/search') return { action: 'Searched All Records', detail: `Searched for "${cut(q('q'), 120)}"` };
    if (path === '/api/file-content') return { action: 'Opened a file', detail: `Opened ${fileName(q('key'))}` };
    if (path === '/api/download' || path === '/api/master/download-existing') return { action: 'Downloaded a file', detail: `Downloaded ${fileName(q('key'))}` };
    if (path === '/api/consultant/download-sheet') return { action: 'Downloaded a consultant sheet', detail: cut([q('month'), q('sheet')].filter(Boolean).join(', ') || url.search.slice(1), 200) };
    if (path === '/api/welfare') return { action: 'Viewed Welfare', detail: `Looked at Welfare for ${monthText(q('month'))}` };
    if (path === '/api/pa-monitor' && q('date')) return { action: 'Viewed PA Monitor', detail: `Read the PA Monitor log for ${dayText(q('date'))}` };
    return null;
  }

  if (path === '/api/master/query') {
    const b = await json();
    const search = String(b?.search || '').trim();
    const filters = Object.entries(b?.filters || {}).filter(([, v]) =>
      typeof v === 'string' ? v.trim() !== '' : v && typeof v === 'object' && Object.values(v).some(x => String(x || '').trim() !== ''));
    // One record per search, not one per table or page.
    if (b?.table !== 'active' || Number(b?.page || 1) !== 1 || (!search && filters.length === 0)) return null;
    const names = filters.map(([k]) => k).join(', ');
    const detail = search
      ? `Searched for "${cut(search, 120)}"${names ? `, with filters on ${names}` : ''}`
      : `Filtered on ${names}`;
    return { action: search ? 'Searched Master' : 'Filtered Master', detail };
  }
  if (path === '/api/access-grants') {
    if (m === 'DELETE') return { action: 'Revoked Welfare access', detail: `Removed Welfare access for ${q('email')}` };
    const b = await json();
    return { action: 'Granted Welfare access', detail: `Gave ${b?.email || 'someone'} Welfare access for ${plural(b?.days ?? '?', 'day')}` };
  }
  if (path === '/api/billing/updates') {
    let detail = '';
    try {
      const f = await req.clone().formData();
      const file = f.get('file');
      const parts = [
        f.get('comments') ? `Wrote "${cut(f.get('comments'), 300)}"` : 'Posted without a message',
        f.get('month') ? `in the ${f.get('month')} chat` : '',
        f.get('name') ? `as "${cut(f.get('name'), 80)}"` : '',
        file && typeof file !== 'string' ? `and attached ${(file as File).name}` : '',
      ].filter(Boolean);
      detail = parts.join(' ');
    } catch { /* not form data */ }
    return { action: 'Posted in billing chat', detail };
  }
  if (path === '/api/billing/approve') {
    if (m === 'DELETE') return { action: 'Removed a billing approval', detail: `Removed the approval for ${monthText(q('month'))}` };
    const b = await json();
    return { action: 'Approved a billing file', detail: `Approved ${fileName(b?.key)} for ${monthText(b?.month)}` };
  }
  if (path === '/api/manifest') {
    const b = await json();
    return { action: b?.included ? 'Included a file' : 'Excluded a file',
      detail: `${b?.included ? 'Included' : 'Excluded'} ${fileName(b?.key)} ${b?.included ? 'in' : 'from'} ${monthText(b?.month)}` };
  }
  if (path === '/api/files/rename') {
    const b = await json();
    const when = b?.month && b?.year ? ` for ${MONTHS[Number(b.month) - 1] || b.month} ${b.year}` : '';
    return { action: 'Moved or renamed a file', detail: `Moved ${fileName(b?.sourceKey)} to ${b?.canonicalLabel || 'a new name'}${when}` };
  }
  if (path === '/api/consultant/generate') {
    const b = await json();
    return { action: 'Generated the consultant report', detail: `Generated the report for ${b?.curr_month || 'a month'}` };
  }
  if (path === '/api/billing/generate') return { action: 'Generated the billing report', detail: 'Ran the billing reconciliation' };
  if (path === '/api/master/upload') return { action: 'Uploaded files to All Records', detail: 'Uploaded carrier files' };
  if (path === '/api/consultant/upload') return { action: 'Uploaded a consultant file', detail: 'Uploaded a consultant report file' };
  if (path === '/api/billing/upload-sources') return { action: 'Uploaded billing source files', detail: 'Uploaded CardConnect or Refresh files' };
  if (path === '/api/support/seen' || path === '/api/master/upload-check') return null;
  return { action: 'Other action', detail: `Used ${path.replace('/api/', '')} (${m})` };
}

// getSession() may run more than once for one request; record it once.
const seen = new WeakSet<object>();

export async function logProxyRequest(req: Request, actor: string, actingAs: string): Promise<void> {
  try {
    if (seen.has(req)) return;
    seen.add(req);
    const d = await describe(req);
    if (d) await recordEvent({ actor, actingAs, ...d });
  } catch (err: any) {
    console.warn('[pa-monitor] could not describe request:', err?.message);
  }
}

/** Days that have events, newest first (up to 120). */
export async function listDays(): Promise<string[]> {
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

/** Every event on a day (New York time), oldest first. */
export async function listEvents(day: string): Promise<PaEvent[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res: any = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${PREFIX}${day}/`, ContinuationToken: token }));
    for (const o of res.Contents || []) if (o.Key) keys.push(o.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  keys.sort(); // file names start with the time, then the order counter
  const events = await Promise.all(keys.map(async k => {
    try {
      const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: k }));
      return JSON.parse(await r.Body!.transformToString('utf-8')) as PaEvent;
    } catch { return null; }
  }));
  return events.filter((e): e is PaEvent => !!e);
}