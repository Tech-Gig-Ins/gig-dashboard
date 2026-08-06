// app/api/auth/me/route.ts
//
// Who is signed in. The UI uses this to show the name and to decide whether to
// render admin controls.
//
// Hiding a button is presentation, not security: every admin-only route
// enforces requireAdmin() server-side regardless of what the UI renders.

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
  });
}

export const runtime = 'nodejs';
