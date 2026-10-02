// app/api/auth/me/route.ts
//
// Who is signed in. The UI uses this for the name, the role badge, and to
// decide which controls to render.
//
// Hiding a button is presentation, not security: every guarded route runs its
// own check server-side regardless of what the UI chooses to show.

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  return NextResponse.json({
    authenticated: true,
    email: session.email,
    firstName: session.firstName,
    lastName: session.lastName,
    fullName: session.fullName,
    isAdmin: session.isAdmin,
    // Full technical access, but the Welfare tab still needs an admin's
    // time-boxed grant. Without this field the UI treats the user as a
    // viewer and hides Upload, Move and the billing controls.
    isPlatformAdmin: session.isPlatformAdmin,
  });
}

export const runtime = 'nodejs';