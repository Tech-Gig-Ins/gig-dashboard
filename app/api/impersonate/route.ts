// app/api/impersonate/route.ts
//
// POST   { email }  - start acting as another account
// DELETE            - stop
//
// A testing aid, not a security control. Anyone who can impersonate an admin
// gains that admin's powers, Welfare grants included. It exists so one person
// can check how every role sees the dashboard without maintaining several
// logins.
//
// The cookie is read by getSession() in lib/auth.ts, which only honours it when
// the REAL signed-in account is an admin or platform admin. Setting the cookie
// by hand therefore achieves nothing.

import { NextRequest, NextResponse } from 'next/server';
import { getSession, IMPERSONATE_COOKIE } from '@/lib/auth';

const ALLOWED_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || '')
  .trim().toLowerCase().replace(/^@/, '');

// Capped well below the id token's lifetime so a forgotten session cannot
// quietly persist for days.
const MAX_AGE_SECONDS = 60 * 60;

export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  // Judge on the REAL identity: an impersonated session must not be able to
  // hop onwards to a third account.
  const realIsPrivileged = session.isImpersonating
    ? false
    : (session.isAdmin || session.isPlatformAdmin);

  if (!realIsPrivileged) {
    return NextResponse.json(
      { error: 'Only an administrator or platform administrator can impersonate.' },
      { status: 403 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();

  if (!email || !email.includes('@')) {
    return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
  }
  if (ALLOWED_DOMAIN && email.split('@').pop() !== ALLOWED_DOMAIN) {
    return NextResponse.json(
      { error: `Only @${ALLOWED_DOMAIN} accounts can be impersonated.` },
      { status: 400 }
    );
  }
  if (email === session.email) {
    return NextResponse.json({ error: 'That is already your account.' }, { status: 400 });
  }

  console.warn(`[impersonate] ${session.email} is now acting as ${email}`);

  const res = NextResponse.json({ ok: true, actingAs: email, expiresInSeconds: MAX_AGE_SECONDS });
  res.cookies.set(IMPERSONATE_COOKIE, email, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
  return res;
}

export async function DELETE(req: NextRequest) {
  const session = await getSession(req);
  const who = session?.actualEmail || session?.email || 'unknown';
  console.warn(`[impersonate] ${who} stopped impersonating`);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(IMPERSONATE_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';