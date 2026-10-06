// Located at: app/api/search/route.ts
//
// All Info search. Uses the indexed engine (lib/searchIndex.ts), which returns
// exactly what the original search returned, without parsing every file on
// every search. The original engine is kept in lib/searchLegacy.ts, and
// /api/search/compare runs both side by side.
//
// Response shape is unchanged, so page.tsx needs no changes.

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { indexedSearch } from '@/lib/searchIndex';

export async function GET(request: Request) {
  // Auth boundary. proxy.ts only does an optimistic cookie check;
  // this is what actually verifies the token and role.
  const gate = await requireAuth(request);
  if (gate instanceof NextResponse) return gate;

  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');

  if (!query || query.trim().length < 2) {
    return NextResponse.json({ error: 'Query must be at least 2 characters' }, { status: 400 });
  }

  try {
    const { response, timing } = await indexedSearch(query);
    // Timings only, never the query text: member names are PHI.
    console.log('[search]', JSON.stringify({ chars: query.length, ...timing, files: response.filesWithMatches }));
    return NextResponse.json(response, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Server-Timing': `total;dur=${timing.totalMs}`,
      },
    });
  } catch (err: any) {
    console.error('Search error:', err);
    return NextResponse.json(
      { error: err.message || 'Search failed' },
      { status: 500 }
    );
  }
}