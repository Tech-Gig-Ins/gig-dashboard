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
// View as runs in its own browser tab: that tab sends the x-view-as header on
// each request (see getSession in lib/auth.ts), so the original tab keeps the
// real identity. This route checks permission and records who started and
// stopped it. getSession only honours the header when the REAL signed-in
// account is an admin or platform admin, so sending it by hand achieves nothing.

import { NextRequest, NextResponse } from 'next/server';
import { getSession, IMPERSONATE_COOKIE } from '@/lib/auth';
import { recordEvent } from '@/lib/paMonitor';

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

  // Platform admins only. Admins do not get this: it is a technical testing
  // aid, and an admin using it would blur who actually approved something.
  // Judged on the REAL identity, so an impersonated session cannot hop onwards
  // to a third account.
  const realIsPlatformAdmin = session.isImpersonating ? false : session.isPlatformAdmin;

  if (!realIsPlatformAdmin) {
    return NextResponse.json(
      { error: 'Only a platform administrator can view the dashboard as another account.' },
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
  await recordEvent({ actor: session.email, actingAs: email, action: 'Started View as', detail: `Opened a new tab as ${email}; the session auto-ends after 1 hour` });

  const res = NextResponse.json({ ok: true, actingAs: email, expiresInSeconds: MAX_AGE_SECONDS });
  // Clear the cookie the old version used, so it can never apply to every tab.
  res.cookies.set(IMPERSONATE_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}

export async function DELETE(req: NextRequest) {
  const session = await getSession(req);
  const who = session?.actualEmail || session?.email || 'unknown';
  console.warn(`[impersonate] ${who} stopped impersonating`);
  if (session?.isImpersonating) {
    const closed = req.nextUrl.searchParams.get('reason') === 'closed';
    await recordEvent({
      actor: who, actingAs: session.email, action: 'Ended View as',
      detail: closed ? 'Closed, reloaded or left the View as tab' : 'Clicked Exit in the View as banner',
    });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(IMPERSONATE_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}

// A View as tab that was reloaded or reopened (PA Monitor only).
export async function PATCH(req: NextRequest) {
  const session = await getSession(req);
  if (!session?.isImpersonating) return NextResponse.json({ ok: false });
  await recordEvent({
    actor: session.actualEmail || 'unknown', actingAs: session.email,
    action: 'Resumed View as', detail: 'Reloaded or reopened the same View as tab',
  });
  return NextResponse.json({ ok: true });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';