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
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';

const cognito = new CognitoIdentityProviderClient({
  region: process.env.MY_AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  },
});
const nameCache = new Map<string, { name: string; at: number }>();

// While viewing as someone, the session only knows their email. Look up their
// name in Cognito (cached 10 minutes); fall back to the email.
async function nameFor(email: string): Promise<string> {
  const hit = nameCache.get(email);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.name;
  let name = email;
  try {
    const res = await cognito.send(new ListUsersCommand({
      UserPoolId: process.env.COGNITO_USER_POOL_ID!,
      Filter: `email = "${email.replace(/"/g, '')}"`,
      Limit: 1,
    }));
    const attrs = res.Users?.[0]?.Attributes || [];
    const get = (n: string) => String(attrs.find(a => a.Name === n)?.Value || '').trim();
    name = [get('given_name'), get('family_name')].filter(Boolean).join(' ') || email;
  } catch (err: any) {
    console.warn('[auth/me] name lookup failed:', err?.name);
  }
  nameCache.set(email, { name, at: Date.now() });
  return name;
}

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
    fullName: session.isImpersonating ? await nameFor(session.email) : session.fullName,
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