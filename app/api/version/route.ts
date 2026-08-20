// app/api/version/route.ts
//
// Returns the build identity of the running deployment.
//
// BUILD_ID is written into .env.production by amplify.yml at build time, so it
// changes on every deploy. The browser polls this and compares it with the value
// it loaded with; a difference means the user is looking at stale code.
//
// Deliberately public: a signed-out or expired session must still be able to
// check, and it leaks nothing beyond a timestamp.

import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json(
    { buildId: process.env.BUILD_ID || 'dev' },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } }
  );
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';