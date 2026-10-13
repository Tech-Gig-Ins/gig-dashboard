// Located at: app/api/assistant-log/route.ts
//
//   GET  /api/assistant-log                 days with entries (Platform Admin only)
//   GET  /api/assistant-log?date=YYYY-MM-DD that day's entries (Platform Admin only)
//   POST { convId, change, result, detail } records the outcome of a change the
//        assistant proposed (confirmed, cancelled or failed). Any signed-in
//        person, for their own chat; the person is taken from the session.

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { listAiDays, listAiEntries, recordAiEntry } from '@/lib/aiLog';

export async function GET(req: Request) {
  const gate = await requireAuth(req);
  if (gate instanceof NextResponse) return gate;
  // Only the real Platform Admin. In a View as tab the session is the viewed
  // account, so this is refused there too.
  if (!gate.isPlatformAdmin || gate.isImpersonating) {
    return NextResponse.json({ error: 'Platform Admin only' }, { status: 403 });
  }
  const headers = { 'Cache-Control': 'private, no-store' };
  const date = new URL(req.url).searchParams.get('date');
  if (date) return NextResponse.json({ date, entries: await listAiEntries(date) }, { headers });
  return NextResponse.json({ days: await listAiDays() }, { headers });
}

export async function POST(req: Request) {
  const gate = await requireAuth(req);
  if (gate instanceof NextResponse) return gate;
  let b: any;
  try { b = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const result = b?.result === 'confirmed' || b?.result === 'cancelled' || b?.result === 'failed' ? b.result : null;
  if (!result) return NextResponse.json({ error: 'result is required' }, { status: 400 });
  await recordAiEntry({
    kind: 'outcome',
    user: gate.actualEmail || gate.email,
    actingAs: gate.isImpersonating ? gate.email : null,
    convId: String(b?.convId || '').slice(0, 64),
    change: String(b?.change || '').slice(0, 1000),
    result,
    detail: String(b?.detail || '').slice(0, 1000),
  });
  return NextResponse.json({ ok: true });
}