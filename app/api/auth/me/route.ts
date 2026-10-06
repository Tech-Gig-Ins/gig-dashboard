// app/api/auth/me/route.ts
//
// Who is signed in. The UI uses this for the name, the role badge, and to
// decide which controls to render.
//
// Hiding a button is presentation, not security: every guarded route runs its
// own check server-side regardless of what the UI chooses to show.

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { recordActivity } from '@/lib/activity';

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  // The dashboard calls this on every page load, so it is where "Last active"
  // is recorded. While using "View as", the real person is recorded, not the
  // account being viewed.
  await recordActivity(session.actualEmail || session.email);
  return NextResponse.json({
    authenticated: true,
    email: session.email,
    firstName: session.firstName,
    lastName: session.lastName,
    fullName: session.fullName,
    isAdmin: session.isAdmin,
    // Full technical access, but the Welfare tab still needs an admin's
    // time-boxed grant. Without this field the UI treats the user as a
    // member and hides Upload, Move and the billing controls.
    isPlatformAdmin: session.isPlatformAdmin,
    // Present only while impersonating, so the UI can show the banner and the
    // header can name who is really signed in.
    isImpersonating: Boolean(session.isImpersonating),
    actualEmail: session.actualEmail,
  });
}

export const runtime = 'nodejs';