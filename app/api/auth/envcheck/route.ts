// app/api/auth/envcheck/route.ts
//
// TEMPORARY DIAGNOSTIC - DELETE THIS FILE ONCE SIGN-IN WORKS.
//
// Reports which environment variables the SSR runtime can actually see.
// Reports presence and length only, never values, so nothing sensitive leaks
// if it is hit before you remove it.
//
// It sits under /api/auth/ which proxy.ts treats as public, because you need to
// reach it while sign-in is broken.

import { NextResponse } from 'next/server';

function describe(name: string) {
  const v = process.env[name];
  if (v === undefined) return { set: false, note: 'undefined - not reaching the runtime' };
  if (v === '') return { set: false, note: 'empty string - defined but blank' };
  return {
    set: true,
    length: v.length,
    // Enough to spot a bad paste (missing https://, stray quote, trailing space)
    // without printing anything secret.
    startsWith: v.slice(0, 8),
    endsWith: v.slice(-4),
    hasWhitespaceEdges: v !== v.trim(),
    hasQuotes: /^["']|["']$/.test(v),
  };
}

export async function GET() {
  const names = [
    'COGNITO_REGION',
    'COGNITO_USER_POOL_ID',
    'COGNITO_CLIENT_ID',
    'COGNITO_DOMAIN',
    'APP_URL',
    'ALLOWED_EMAIL_DOMAIN',
    'ADMIN_EMAILS',
    // A known-good control: this one already works in your S3 routes, so if it
    // is visible and the COGNITO_* ones are not, the difference is the variable
    // config rather than how Amplify passes environment variables.
    'MY_AWS_ACCESS_KEY_ID',
  ];

  const result: Record<string, unknown> = {};
  for (const n of names) result[n] = describe(n);

  return NextResponse.json({
    note: 'Temporary diagnostic. Delete app/api/auth/envcheck/ once sign-in works.',
    nodeEnv: process.env.NODE_ENV,
    vars: result,
  });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
