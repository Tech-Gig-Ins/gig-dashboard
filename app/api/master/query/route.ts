// Located at: app/api/master/query/route.ts
//
// One page of one Master table, searched, filtered and sorted on the server.
// Body: { fp, table, search, filters, sort, page, pageSize }
//   fp      the fingerprint from /api/master?view=summary, so every page is
//           cut from the same data the summary described
//   table   'active' | 'terminated' | 'new'
// Returns { rows, matched, total, page, pageSize }.
// 409 means that version is no longer cached: reload the summary.

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getMasterByFingerprint } from '@/lib/masterCache';
import { getPreparedTables, queryPage, normalizeFilterState, type SortState, type TableKind } from '@/lib/masterQuery';

export async function POST(req: Request) {
  const gate = await requireAuth(req);
  if (gate instanceof NextResponse) return gate;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const table = body?.table as TableKind;
  if (table !== 'active' && table !== 'terminated' && table !== 'new') {
    return NextResponse.json({ error: 'table must be active, terminated or new' }, { status: 400 });
  }
  const fp = String(body?.fp || '');
  const t0 = Date.now();
  const data = await getMasterByFingerprint(fp);
  if (!data) return NextResponse.json({ error: 'stale', reload: true }, { status: 409 });

  const s = body?.sort;
  const sort: SortState = s && typeof s.column === 'string' && (s.direction === 'asc' || s.direction === 'desc')
    ? { column: s.column, direction: s.direction } : null;

  const tables = getPreparedTables(fp, data as any);
  const page = queryPage(tables[table], String(body?.search || ''), normalizeFilterState(body?.filters), sort,
    Number(body?.page) || 1, Number(body?.pageSize) || 100);

  console.log('[master-query]', JSON.stringify({ table, matched: page.matched, ms: Date.now() - t0 }));
  return NextResponse.json(page, { headers: { 'Cache-Control': 'private, no-store' } });
}