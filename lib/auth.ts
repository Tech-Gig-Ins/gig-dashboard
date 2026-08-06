// lib/auth.ts
//
// Single source of truth for "who is this request". Everything else (proxy.ts,
// route handlers) calls in here.
//
// Layering, deliberately:
//   proxy.ts   - optimistic check only: is a session cookie present? Per the
//                Next 16 docs, Proxy runs on every request including prefetches
//                and must not be treated as the authorization boundary.
//   lib/auth.ts - the real boundary. Verifies the JWT signature against the
//                pool's JWKS, checks expiry/audience/issuer, re-checks the
//                email domain, and resolves admin status.
//
// The domain is re-checked on EVERY request, not just at sign-up. PreSignUp
// fires once per user and PreAuthentication does not fire for federated logins,
// so if someone's Google account is later moved off the org domain this is the
// only thing that stops them.

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

// Route handlers in this app use three different signatures: (req: NextRequest),
// (request: Request), and a few with no parameter at all. Accepting the union
// and reading the cookie from the raw header where needed means every handler
// can call these helpers without changing its signature style.
type AnyRequest = Request | NextRequest;

function readCookie(req: AnyRequest, name: string): string | undefined {
  const maybeNext = req as any;
  if (typeof maybeNext?.cookies?.get === 'function') {
    return maybeNext.cookies.get(name)?.value;
  }
  const header = req.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

export const ID_COOKIE = 'gwu_id';
export const ACCESS_COOKIE = 'gwu_at';
export const REFRESH_COOKIE = 'gwu_rt';

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID!;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID!;
const ALLOWED_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || '')
  .trim().toLowerCase().replace(/^@/, '');

// Comma-separated. Compared case-insensitively against the verified email claim.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

export type Session = {
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  isAdmin: boolean;
  sub: string;
};

// Created once per process. The library caches the JWKS internally, so this
// does not hit Cognito on every request.
let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;
function getVerifier() {
  if (!verifier) {
    if (!USER_POOL_ID || !CLIENT_ID) {
      throw new Error(
        'COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID must be set.'
      );
    }
    verifier = CognitoJwtVerifier.create({
      userPoolId: USER_POOL_ID,
      tokenUse: 'id',
      clientId: CLIENT_ID,
    });
  }
  return verifier;
}

function emailDomain(email: string): string {
  // Split on the LAST '@' so a crafted local part cannot smuggle a foreign
  // domain past the check.
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1);
}

/**
 * Verify the id token on a request and return the session, or null.
 * Never throws for ordinary "not logged in" cases.
 */
export async function getSession(req: AnyRequest): Promise<Session | null> {
  const token = readCookie(req, ID_COOKIE);
  if (!token) return null;

  // Fail closed: an unset domain must never mean "allow everyone".
  if (!ALLOWED_DOMAIN) {
    console.error('[auth] ALLOWED_EMAIL_DOMAIN is not set; refusing all sessions.');
    return null;
  }

  try {
    // Verifies signature against the pool JWKS, plus exp, aud and iss.
    const payload: any = await getVerifier().verify(token);

    const email = String(payload.email || '').trim().toLowerCase();
    if (!email) return null;

    if (emailDomain(email) !== ALLOWED_DOMAIN) {
      console.warn(`[auth] rejecting ${email}: domain is not ${ALLOWED_DOMAIN}`);
      return null;
    }

    const firstName = String(payload.given_name || '').trim();
    const lastName = String(payload.family_name || '').trim();

    return {
      email,
      firstName,
      lastName,
      fullName: [firstName, lastName].filter(Boolean).join(' ') || email,
      isAdmin: ADMIN_EMAILS.includes(email),
      sub: String(payload.sub || ''),
    };
  } catch (err: any) {
    // Expired or tampered token. Expiry is the common case and is not an error
    // worth logging loudly.
    if (!/expired/i.test(err?.message || '')) {
      console.warn('[auth] token verification failed:', err?.message);
    }
    return null;
  }
}

/**
 * For API routes. Returns either the session or a NextResponse to return
 * immediately.
 *
 *   const gate = await requireAuth(req);
 *   if (gate instanceof NextResponse) return gate;
 *   // gate is a Session from here on
 */
export async function requireAuth(
  req: AnyRequest
): Promise<Session | NextResponse> {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json(
      { error: 'Not authenticated', code: 'UNAUTHENTICATED' },
      { status: 401 }
    );
  }
  return session;
}

/** As requireAuth, but also requires the email to be in ADMIN_EMAILS. */
export async function requireAdmin(
  req: AnyRequest
): Promise<Session | NextResponse> {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json(
      { error: 'Not authenticated', code: 'UNAUTHENTICATED' },
      { status: 401 }
    );
  }
  if (!session.isAdmin) {
    console.warn(`[auth] ${session.email} attempted an admin action`);
    return NextResponse.json(
      { error: 'Administrator access required', code: 'FORBIDDEN' },
      { status: 403 }
    );
  }
  return session;
}

/** Cookie options for the session cookies. */
export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,          // unreadable from JavaScript, so XSS cannot steal it
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const, // survives the OAuth redirect, blocks cross-site POSTs
    path: '/',
    maxAge: maxAgeSeconds,
  };
}
