// app/api/auth/logout/route.ts
//
// Clears the local session cookies AND ends the Cognito session. Clearing
// cookies alone is not enough: the Cognito session would still be live, so the
// next sign-in would silently succeed without re-authenticating. On a shared
// machine that is a real problem.

import { NextRequest, NextResponse } from 'next/server';
import { ID_COOKIE, ACCESS_COOKIE, REFRESH_COOKIE } from '@/lib/auth';

const COGNITO_DOMAIN = process.env.COGNITO_DOMAIN!;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID!;
const APP_URL = process.env.APP_URL || '';

export async function GET(req: NextRequest) {
  const origin = APP_URL || req.nextUrl.origin;

  const logout = new URL(`${COGNITO_DOMAIN}/logout`);
  logout.searchParams.set('client_id', CLIENT_ID);
  // Land on /signed-out, NOT '/'. proxy.ts treats '/' as protected, so
  // returning there would immediately redirect to login, and because Cognito
  // logout does not end the Google session Google would silently sign the user
  // straight back in. /signed-out is public, so the user stays signed out.
  // This URL must be registered in the app client's --logout-urls.
  logout.searchParams.set('logout_uri', `${origin.replace(/\/$/, '')}/signed-out`);

  const res = NextResponse.redirect(logout.toString());
  for (const name of [ID_COOKIE, ACCESS_COOKIE, REFRESH_COOKIE, 'gwu_pkce', 'gwu_state', 'gwu_next']) {
    res.cookies.set(name, '', { path: '/', maxAge: 0 });
  }
  return res;
}

export const runtime = 'nodejs';
