// Located at: app/api/support/seen/route.ts
//
// POST { page: 'pending' | 'resolved', date } marks that page of that day's
// report as seen for the signed-in person, which turns its dot off on every
// device. Stored in user-activity/<email>.support-seen.json.

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { markSeen, isDate } from '@/lib/support';

export async function POST(req: Request) {
  const gate = await requireAuth(req);
  if (gate instanceof NextResponse) return gate;
  let b: any;
  try { b = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  if ((b?.page !== 'pending' && b?.page !== 'resolved') || !isDate(b?.date)) {
    return NextResponse.json({ error: 'page and date are required' }, { status: 400 });
  }
  await markSeen(gate.actualEmail || gate.email, b.page, b.date);
  return NextResponse.json({ ok: true });
}