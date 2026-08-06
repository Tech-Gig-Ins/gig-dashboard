// app/api/auth/callback/route.ts
//
// Cognito redirects here after Google sign-in. Two possible shapes:
//   ?error=...&error_description=...   the PreSignUp gate rejected them
//   ?code=...&state=...                success; exchange for tokens
//
// The code exchange happens server-side and tokens land in httpOnly cookies.
// They are never exposed to client JavaScript, which matters because these
// tokens gate access to PHI.

import { NextRequest, NextResponse } from 'next/server';
import { ID_COOKIE, ACCESS_COOKIE, REFRESH_COOKIE, sessionCookieOptions } from '@/lib/auth';

const COGNITO_DOMAIN = process.env.COGNITO_DOMAIN!;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID!;
const APP_URL = process.env.APP_URL || '';

function clearFlowCookies(res: NextResponse) {
  for (const name of ['gwu_pkce', 'gwu_state', 'gwu_next']) {
    res.cookies.set(name, '', { path: '/', maxAge: 0 });
  }
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const origin = APP_URL || req.nextUrl.origin;

  // --- the PreSignUp gate rejected this account -----------------------------
  const oauthError = params.get('error');
  if (oauthError) {
    const detail = params.get('error_description') || '';
    console.warn(`[auth] sign-in refused: ${oauthError} ${detail}`);
    const denied = new URL('/access-denied', origin);
    // The Lambda's message is user-facing copy; pass it through so the page can
    // show exactly why, rather than a generic failure.
    denied.searchParams.set('reason', detail.slice(0, 300));
    const res = NextResponse.redirect(denied);
    clearFlowCookies(res);
    return res;
  }

  const code = params.get('code');
  const state = params.get('state');
  const expectedState = req.cookies.get('gwu_state')?.value;
  const verifier = req.cookies.get('gwu_pkce')?.value;
  const next = req.cookies.get('gwu_next')?.value || '/';

  if (!code || !verifier) {
    return NextResponse.redirect(new URL('/api/auth/login', origin));
  }

  // CSRF: the state we get back must match the one we issued.
  if (!state || !expectedState || state !== expectedState) {
    console.warn('[auth] state mismatch on callback');
    const denied = new URL('/access-denied', origin);
    denied.searchParams.set('reason', 'Sign-in could not be verified. Please try again.');
    const res = NextResponse.redirect(denied);
    clearFlowCookies(res);
    return res;
  }

  try {
    const redirectUri = `${origin.replace(/\/$/, '')}/api/auth/callback`;
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });

    const tokenRes = await fetch(`${COGNITO_DOMAIN}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      cache: 'no-store',
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error('[auth] token exchange failed:', tokenRes.status, text);
      const denied = new URL('/access-denied', origin);
      denied.searchParams.set('reason', 'Sign-in failed while completing authentication.');
      const res = NextResponse.redirect(denied);
      clearFlowCookies(res);
      return res;
    }

    const tokens = await tokenRes.json();

    // Only accept a relative path, so the cookie cannot become an open redirect.
    const dest = next.startsWith('/') && !next.startsWith('//') ? next : '/';
    const res = NextResponse.redirect(new URL(dest, origin));

    // expires_in is seconds; Cognito issues 60-minute access/id tokens here.
    const ttl = Number(tokens.expires_in) || 3600;
    res.cookies.set(ID_COOKIE, tokens.id_token, sessionCookieOptions(ttl));
    res.cookies.set(ACCESS_COOKIE, tokens.access_token, sessionCookieOptions(ttl));
    if (tokens.refresh_token) {
      // Refresh token validity is set to 8 hours on the app client.
      res.cookies.set(REFRESH_COOKIE, tokens.refresh_token, sessionCookieOptions(8 * 3600));
    }
    clearFlowCookies(res);
    return res;
  } catch (err: any) {
    console.error('[auth] callback error:', err);
    const denied = new URL('/access-denied', origin);
    denied.searchParams.set('reason', 'Unexpected error during sign-in.');
    const res = NextResponse.redirect(denied);
    clearFlowCookies(res);
    return res;
  }
}

export const runtime = 'nodejs';
