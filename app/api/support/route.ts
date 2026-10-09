// Located at: app/api/support/route.ts
//
//   GET /api/support                    days with summaries (newest first), the
//                                       latest date, and this person's dots
//   GET /api/support?date=YYYY-MM-DD    that day's summaries
//
// Read live from the Google Doc logs (cached). Visible to every signed-in role.

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { listDays, getReport, dotsFor, isDate } from '@/lib/support';

export async function GET(req: Request) {
  const gate = await requireAuth(req);
  if (gate instanceof NextResponse) return gate;
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    const date = new URL(req.url).searchParams.get('date');
    if (date !== null) {
      if (!isDate(date)) return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
      const report = await getReport(date);
      if (!report) return NextResponse.json({ error: `No support summary for ${date}` }, { status: 404, headers });
      return NextResponse.json(report, { headers });
    }
    const days = await listDays();
    // The dot belongs to the real person, also while using View as.
    const dots = await dotsFor(gate.actualEmail || gate.email, days);
    return NextResponse.json({ days, ...dots }, { headers });
  } catch (err: any) {
    console.error('[support]', err?.message);
    return NextResponse.json({ error: err?.message || 'Could not read the support log' }, { status: 502, headers });
  }
}