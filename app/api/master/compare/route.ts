// Located at: app/api/master/compare/route.ts
//
// Admin and Platform Admin only. Proves the new Master code against the
// original on live data, and returns counts only, never member data.
//   1. Builds Master the original way (no cache) and compares it with the
//      cached result.
//   2. For each table, runs a battery of searches, filters and sorts through
//      the original browser logic and through the server engine, and checks
//      that the full ordered result is identical.
// Optional: ?q=smith adds your own search to the battery.

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { computeMaster } from '@/lib/masterLegacy';
import { getMaster } from '@/lib/masterCache';
import {
  prepareTable, indexedQueryIndices, legacyQuery, EMPTY_FILTER, COLUMN_TYPES,
  type FilterState, type SortState, type TableKind, type MasterRow,
} from '@/lib/masterQuery';

export async function GET(req: Request) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (!session.isAdmin && !session.isPlatformAdmin) {
    return NextResponse.json({ error: 'Admin or Platform Admin only' }, { status: 403 });
  }
  const extra = new URL(req.url).searchParams.get('q') || '';

  const t0 = Date.now();
  const original = await computeMaster();
  const originalMs = Date.now() - t0;
  const t1 = Date.now();
  const { result: cached, source } = await getMaster();
  const cachedMs = Date.now() - t1;
  const dataIdentical = JSON.stringify(original) === JSON.stringify(cached);

  // Query battery, built from the data itself.
  const tables: [TableKind, MasterRow[]][] = [
    ['active', cached.activeMembers as MasterRow[]],
    ['terminated', cached.terminatedMembers as MasterRow[]],
    ['new', cached.newMembers as MasterRow[]],
  ];
  const sorts: SortState[] = [null, ...Object.keys(COLUMN_TYPES).flatMap(c => [
    { column: c, direction: 'asc' as const }, { column: c, direction: 'desc' as const }])];
  let checked = 0, identical = 0;
  const mismatches: string[] = [];

  for (const [kind, rows] of tables) {
    const t = prepareTable(rows, kind);
    const sample = (i: number) => rows.length ? rows[(i * 7919) % rows.length] : null;
    const searches = ['', extra, 'a', 'zz', 'smith'];
    const filters: FilterState[] = [EMPTY_FILTER];
    for (let i = 0; i < 12; i++) {
      const r = sample(i);
      if (!r) break;
      searches.push(r.normalizedName.slice(1, 4), r.memberName.split(' ')[0] || '', r.file.slice(0, 4));
      filters.push(
        { ...EMPTY_FILTER, file: r.file },
        { ...EMPTY_FILTER, group: r.group.slice(0, 3), state: r.state },
        { ...EMPTY_FILTER, sourceSystem: r.sourceSystem, payment: { lt: '500', gt: '50', eq: '' } },
        { ...EMPTY_FILTER, phone: r.phone.slice(-4), city: r.city.slice(0, 2) },
        { ...EMPTY_FILTER, terminationDate: '2026-08-31', effectiveDate: '2026-10-01' },
      );
    }
    for (let i = 0; i < searches.length; i++) {
      for (let j = 0; j < filters.length; j += 3) {
        const sort = sorts[(i * 5 + j) % sorts.length];
        const a = legacyQuery(rows, kind, searches[i], filters[j], sort);
        const b = indexedQueryIndices(t, searches[i], filters[j], sort).map(k => rows[k]);
        checked++;
        if (a.length === b.length && a.every((x, k) => x === b[k])) identical++;
        else if (mismatches.length < 5) mismatches.push(`${kind}: search #${i}, filter #${j}, sort ${sort ? sort.column + ' ' + sort.direction : 'none'}: ${a.length} vs ${b.length} rows`);
      }
    }
  }

  return NextResponse.json({
    dataIdentical,
    queriesChecked: checked,
    queriesIdentical: identical,
    allIdentical: dataIdentical && checked === identical,
    mismatches,
    counts: { active: cached.activeCount, terminated: cached.terminatedCount, new: cached.newCount },
    ms: { originalBuild: originalMs, cached: cachedMs, cacheSource: source },
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}