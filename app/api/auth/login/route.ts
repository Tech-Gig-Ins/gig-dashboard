// app/api/auth/login/route.ts
//
// Starts the sign-in flow. Redirects straight to Google via Cognito, so the
// user never sees a Cognito username/password form. Two things make that true:
//   - identity_provider=Google on the authorize URL
//   - the app client lists Google as its ONLY supported identity provider
//
// Uses the authorization code flow with PKCE and no client secret, which is
// the correct choice for a browser-facing app.

import { NextRequest, NextResponse } from 'next/server';

const COGNITO_DOMAIN = process.env.COGNITO_DOMAIN!;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID!;
const APP_URL = process.env.APP_URL || '';

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(byteLength = 48): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier)
  );
  return base64url(new Uint8Array(digest));
}

export async function GET(req: NextRequest) {
  if (!COGNITO_DOMAIN || !CLIENT_ID) {
    return NextResponse.json(
      { error: 'Auth is not configured: COGNITO_DOMAIN / COGNITO_CLIENT_ID missing.' },
      { status: 500 }
    );
  }

  // Prefer the configured APP_URL so the redirect_uri exactly matches what the
  // app client was registered with. Falls back to the request origin locally.
  const origin = APP_URL || req.nextUrl.origin;
  const redirectUri = `${origin.replace(/\/$/, '')}/api/auth/callback`;

  const verifier = randomString();
  const challenge = await challengeFor(verifier);
  const state = randomString(16);

  // Only accept relative paths, so ?next= cannot be used as an open redirect
  // to an attacker-controlled site.
  const rawNext = req.nextUrl.searchParams.get('next') || '/';
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';

  const authorize = new URL(`${COGNITO_DOMAIN}/oauth2/authorize`);
  authorize.searchParams.set('client_id', CLIENT_ID);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', 'openid email profile');
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('identity_provider', 'Google');
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('state', state);

  const res = NextResponse.redirect(authorize.toString());

  // Short-lived, httpOnly. The verifier must never reach client JavaScript.
  const opts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 600,
  };
  res.cookies.set('gwu_pkce', verifier, opts);
  res.cookies.set('gwu_state', state, opts);
  res.cookies.set('gwu_next', next, opts);

  return res;
}

export const runtime = 'nodejs';
