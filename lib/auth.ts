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
export const IMPERSONATE_COOKIE = 'gwu_imp'; // legacy: no longer read, only cleared
/** Sent by a "View as" tab on each request. Per tab, so other tabs are unaffected. */
export const VIEW_AS_HEADER = 'x-view-as';

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID!;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID!;
const ALLOWED_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || '')
  .trim().toLowerCase().replace(/^@/, '');

// Comma-separated. Compared case-insensitively against the verified email claim.
// Platform admins hold every technical permission - uploads, Move, Generate,
// Include toggles, billing approval - but NOT the Welfare tab. Welfare is
// authoritative rather than technical, so it needs an admin's time-boxed grant.
const PLATFORM_ADMIN_EMAILS = (process.env.PLATFORM_ADMIN_EMAILS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

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
  /** Full technical access, but Welfare still needs a grant. */
  isPlatformAdmin: boolean;
  sub: string;
  /** Set while impersonating. The signed-in account doing the impersonating. */
  actualEmail?: string;
  isImpersonating?: boolean;
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

    const real: Session = {
      email,
      firstName,
      lastName,
      fullName: [firstName, lastName].filter(Boolean).join(' ') || email,
      isAdmin: ADMIN_EMAILS.includes(email),
      isPlatformAdmin: PLATFORM_ADMIN_EMAILS.includes(email),
      sub: String(payload.sub || ''),
    };

    // ---- Impersonation (testing aid) --------------------------------------
    //
    // A platform admin or admin can act as another account so roles can be
    // checked without juggling logins. The target arrives in the x-view-as
    // header, which only a "View as" browser tab sends, so other tabs keep the
    // real identity. It is honoured only when the REAL signed-in account is an
    // admin or platform admin, so sending the header by hand achieves nothing.
    //
    // This is NOT a security boundary: anyone who can impersonate an admin can
    // do anything that admin can, including granting themselves Welfare. It
    // exists so one person can test every role. Every mutating route logs both
    // identities so the trail still shows who really acted.
    const impersonating = req.headers.get(VIEW_AS_HEADER) || '';
    if (impersonating && (real.isAdmin || real.isPlatformAdmin)) {
      const target = impersonating.trim().toLowerCase();
      if (target && target !== real.email && emailDomain(target) === ALLOWED_DOMAIN) {
        return {
          email: target,
          firstName: target.split('@')[0],
          lastName: '',
          fullName: target,
          isAdmin: ADMIN_EMAILS.includes(target),
          isPlatformAdmin: PLATFORM_ADMIN_EMAILS.includes(target),
          sub: real.sub,
          actualEmail: real.email,
          isImpersonating: true,
        };
      }
    }

    return real;
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
  // Platform admins count as admins for technical actions. Welfare is the one
  // exception and uses requireWelfareAccess() instead.
  if (!session.isAdmin && !session.isPlatformAdmin) {
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


// =====================================================================
// WELFARE ACCESS GRANTS
// =====================================================================
//
// Welfare is admin-only by default. An admin can grant another signed-in user
// access for 1 to 7 days. Grants live in S3 at access-grants/welfare.json and
// are checked on every request, so expiry needs no scheduled job.
//
// Expired grants are KEPT, not deleted, so the file doubles as an audit trail.

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

export type WelfareGrant = {
  email: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt: string;
  days: number;
  revokedAt?: string;
  revokedBy?: string;
};

export const GRANTS_KEY = 'access-grants/welfare.json';

const grantsS3 = new S3Client({
  region: process.env.MY_AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  },
});

export async function readGrants(): Promise<WelfareGrant[]> {
  const bucket = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';
  try {
    const obj = await grantsS3.send(new GetObjectCommand({ Bucket: bucket, Key: GRANTS_KEY }));
    const chunks: Buffer[] = [];
    for await (const c of obj.Body as any) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return Array.isArray(parsed.grants) ? parsed.grants : [];
  } catch {
    // No grants file yet. Nobody has been granted anything, which is the
    // correct starting state.
    return [];
  }
}

/** The live grant for an email, or null. Revoked and expired ones are ignored. */
export function activeGrantFor(grants: WelfareGrant[], email: string): WelfareGrant | null {
  const now = Date.now();
  const mine = grants.filter(g =>
    String(g.email || '').toLowerCase() === email.toLowerCase() &&
    !g.revokedAt &&
    Date.parse(g.expiresAt) > now
  );
  if (mine.length === 0) return null;
  // If several overlap, the one lasting longest wins.
  return mine.sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt))[0];
}

export type WelfareAccess = {
  allowed: boolean;
  reason: 'admin' | 'granted' | 'denied';
  expiresAt?: string;
  msRemaining?: number;
  grantedBy?: string;
};

export async function checkWelfareAccess(session: Session): Promise<WelfareAccess> {
  if (session.isAdmin) return { allowed: true, reason: 'admin' };
  const grant = activeGrantFor(await readGrants(), session.email);
  if (!grant) return { allowed: false, reason: 'denied' };
  return {
    allowed: true,
    reason: 'granted',
    expiresAt: grant.expiresAt,
    msRemaining: Date.parse(grant.expiresAt) - Date.now(),
    grantedBy: grant.grantedBy,
  };
}

/** Gate for Welfare routes. Returns the session or a response to return. */
export async function requireWelfareAccess(
  req: AnyRequest
): Promise<Session | NextResponse> {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json(
      { error: 'Not authenticated', code: 'UNAUTHENTICATED' }, { status: 401 }
    );
  }
  const access = await checkWelfareAccess(session);
  if (!access.allowed) {
    console.warn(`[auth] ${session.email} attempted Welfare without a grant`);
    return NextResponse.json({
      error: 'Welfare access requires an administrator grant.',
      code: 'WELFARE_LOCKED',
    }, { status: 403 });
  }
  console.log(`[welfare] ${session.email} access via ${access.reason}`);
  return session;
}