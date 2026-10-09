// Located at: app/api/pa-monitor/route.ts
//
//   GET /api/pa-monitor              days that have View as activity
//   GET /api/pa-monitor?date=YYYY-MM-DD   that day's events, oldest first
//
// Admin only. The Platform Admin, whose activity this is, cannot read it
// (except by using View as on an Admin account, which is itself recorded).

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { listDays, listEvents, withInferredEnds } from '@/lib/paMonitor';

export async function GET(req: Request) {
  const gate = await requireAuth(req);
  if (gate instanceof NextResponse) return gate;
  if (!gate.isAdmin) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 });
  }
  const headers = { 'Cache-Control': 'private, no-store' };
  const date = new URL(req.url).searchParams.get('date');
  if (date) return NextResponse.json({ date, events: withInferredEnds(await listEvents(date)) }, { headers });
  return NextResponse.json({ days: await listDays() }, { headers });
}