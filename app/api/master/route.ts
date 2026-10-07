// Located at: app/api/master/route.ts
//
// Master Dashboard data. The computation is the original one, now in
// lib/masterLegacy.ts, and its result is cached (lib/masterCache.ts) so it is
// only rebuilt when a carrier file or a manifest actually changes.
//
//   GET /api/master                 full result, unchanged shape (Consultant tab)
//   GET /api/master?view=summary    everything except the three member lists,
//                                   plus counts, filter options and the
//                                   fingerprint that /api/master/query uses
//
// Responses carry an ETag (the fingerprint). If the browser already holds the
// current version it gets a 304 and nothing is resent.

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getMaster } from '@/lib/masterCache';

function uniqueValues(data: { activeMembers: any[]; terminatedMembers: any[]; newMembers: any[] }, key: 'file' | 'sourceSystem'): string[] {
  const set = new Set<string>();
  for (const r of data.activeMembers) if (r[key]) set.add(r[key]);
  for (const r of data.terminatedMembers) if (r[key]) set.add(r[key]);
  for (const r of data.newMembers) if (r[key]) set.add(r[key]);
  return Array.from(set).sort();
}

export async function GET(req: Request) {
  // Auth boundary. proxy.ts only does an optimistic cookie check;
  // this is what actually verifies the token and role.
  const gate = await requireAuth(req);
  if (gate instanceof NextResponse) return gate;

  try {
    const summary = new URL(req.url).searchParams.get('view') === 'summary';
    const { fingerprint, result, source, ms } = await getMaster();
    console.log('[master]', JSON.stringify({ view: summary ? 'summary' : 'full', source, ms }));

    const etag = `"${fingerprint}${summary ? '-s' : ''}"`;
    const headers = { 'Cache-Control': 'private, no-cache', ETag: etag };
    if (req.headers.get('if-none-match') === etag) return new NextResponse(null, { status: 304, headers });

    if (!summary) return NextResponse.json(result, { headers });

    const { activeMembers, terminatedMembers, newMembers, ...rest } = result;
    return NextResponse.json({
      ...rest,
      fingerprint,
      fileOptions: uniqueValues(result, 'file'),
      sourceSystemOptions: uniqueValues(result, 'sourceSystem'),
    }, { headers });
  } catch (err: any) {
    console.error('Master dashboard error:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to build master dashboard' },
      { status: 500 }
    );
  }
}