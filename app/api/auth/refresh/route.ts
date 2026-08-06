// app/api/auth/refresh/route.ts
//
// Silently renews the session.
//
// The id/access tokens last 60 minutes; the refresh token lasts 7 days. When
// the short tokens expire, the browser calls here instead of bouncing the user
// through Google again. As long as the refresh token is valid, the user stays
// signed in for a full 7 days without seeing a login screen.
//
// Before this route existed the refresh token was stored and never used, so a
// 7-day refresh window had no effect: every 60 minutes the id token expired and
// the user was redirected to re-authenticate.

import { NextRequest, NextResponse } from 'next/server';
import { ID_COOKIE, ACCESS_COOKIE, REFRESH_COOKIE, sessionCookieOptions } from '@/lib/auth';

const COGNITO_DOMAIN = process.env.COGNITO_DOMAIN!;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID!;

// Must match --refresh-token-validity on the app client.
const REFRESH_TTL_SECONDS = 7 * 24 * 3600;

export async function POST(req: NextRequest) {
  const refreshToken = req.cookies.get(REFRESH_COOKIE)?.value;

  if (!refreshToken) {
    return NextResponse.json(
      { ok: false, reason: 'no_refresh_token' },
      { status: 401 }
    );
  }
  if (!COGNITO_DOMAIN || !CLIENT_ID) {
    return NextResponse.json(
      { ok: false, reason: 'not_configured' },
      { status: 500 }
    );
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    });

    const tokenRes = await fetch(`${COGNITO_DOMAIN}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      cache: 'no-store',
    });

    if (!tokenRes.ok) {
      // Expired or revoked refresh token. Clear the cookies so the client stops
      // retrying and sends the user to sign in instead.
      const res = NextResponse.json(
        { ok: false, reason: 'refresh_rejected' },
        { status: 401 }
      );
      for (const name of [ID_COOKIE, ACCESS_COOKIE, REFRESH_COOKIE]) {
        res.cookies.set(name, '', { path: '/', maxAge: 0 });
      }
      return res;
    }

    const tokens = await tokenRes.json();
    const ttl = Number(tokens.expires_in) || 3600;

    const res = NextResponse.json({ ok: true });
    res.cookies.set(ID_COOKIE, tokens.id_token, sessionCookieOptions(ttl));
    res.cookies.set(ACCESS_COOKIE, tokens.access_token, sessionCookieOptions(ttl));
    // A refresh_token grant usually does not return a new refresh token; the
    // original stays valid for its full window. Re-set it only if one comes
    // back, so the 7-day clock is not restarted by accident.
    if (tokens.refresh_token) {
      res.cookies.set(REFRESH_COOKIE, tokens.refresh_token,
                      sessionCookieOptions(REFRESH_TTL_SECONDS));
    }
    return res;
  } catch (err: any) {
    console.error('[auth/refresh] error:', err?.message);
    return NextResponse.json({ ok: false, reason: 'error' }, { status: 401 });
  }
}

export const runtime = 'nodejs';