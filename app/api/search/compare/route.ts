// Located at: app/api/search/compare/route.ts
//
// Admin and Platform Admin only. Runs the original search and the indexed
// search for the same query and reports whether the results are identical.
// Used to prove the new engine before and after deploy:
//   /api/search/compare?q=john
//
// Returns counts and timings only, never member data.

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { legacySearch } from '@/lib/searchLegacy';
import { indexedSearch } from '@/lib/searchIndex';

export async function GET(request: Request) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (!session.isAdmin && !session.isPlatformAdmin) {
    return NextResponse.json({ error: 'Admin or Platform Admin only' }, { status: 403 });
  }

  const query = new URL(request.url).searchParams.get('q') || '';
  if (query.trim().length < 2) {
    return NextResponse.json({ error: 'Query must be at least 2 characters' }, { status: 400 });
  }

  const t0 = Date.now();
  const legacy = await legacySearch(query);
  const legacyMs = Date.now() - t0;
  const t1 = Date.now();
  const { response: indexed, timing } = await indexedSearch(query);
  const indexedMs = Date.now() - t1;

  const a = JSON.stringify(legacy);
  const b = JSON.stringify(indexed);
  let firstDifference: string | null = null;
  if (a !== b) {
    if (legacy.filesScanned !== indexed.filesScanned) firstDifference = 'filesScanned';
    else if (legacy.results.length !== indexed.results.length) firstDifference = 'number of files with matches';
    else {
      for (let i = 0; i < legacy.results.length; i++) {
        const x = legacy.results[i], y = indexed.results[i];
        if (JSON.stringify(x) !== JSON.stringify(y)) {
          firstDifference = `file ${i + 1}: ${x.fileKey === y.fileKey ? x.fileKey : `${x.fileKey} vs ${y.fileKey}`}` +
            ` (rows ${x.rows.length} vs ${y.rows.length})`;
          break;
        }
      }
    }
  }

  return NextResponse.json({
    identical: a === b,
    firstDifference,
    filesScanned: { legacy: legacy.filesScanned, indexed: indexed.filesScanned },
    filesWithMatches: { legacy: legacy.filesWithMatches, indexed: indexed.filesWithMatches },
    totalMatches: { legacy: legacy.totalMatches, indexed: indexed.totalMatches },
    ms: { legacy: legacyMs, indexed: indexedMs },
    indexedTiming: timing,
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}