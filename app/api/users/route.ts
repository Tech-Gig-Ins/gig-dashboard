// app/api/users/route.ts
//
// Lists the registered dashboard users, for the "view as" and Welfare grant
// pickers. Without this both were free-text boxes, which meant guessing at
// addresses.
//
// Source is the Cognito user pool, so the list is whoever has actually signed
// in - users are created on first Google sign-in, not provisioned ahead of time.
//
// Also feeds the Users & Roles tab, so each user carries the date they first
// signed in, when they were last active, and their current Welfare access.

import { NextRequest, NextResponse } from 'next/server';
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { getSession, readGrants, activeGrantFor, type WelfareGrant } from '@/lib/auth';
import { readLastActive } from '@/lib/activity';

const REGION = process.env.COGNITO_REGION || process.env.MY_AWS_REGION || 'us-east-1';
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID!;

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const PLATFORM_ADMIN_EMAILS = (process.env.PLATFORM_ADMIN_EMAILS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const cognito = new CognitoIdentityProviderClient({
  region: REGION,
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  },
});

function attr(user: any, name: string): string {
  const found = (user.Attributes || []).find((a: any) => a.Name === name);
  return String(found?.Value || '').trim();
}

type WelfareStatus = {
  status: 'always' | 'active' | 'expired' | 'revoked' | 'none';
  // active: when it ends. expired: when it ended. revoked: when it was revoked.
  at?: string;
};

// One user's Welfare access, read from the same grants file the Welfare tab
// uses, so both views always agree.
function welfareStatusFor(role: string, email: string, grants: WelfareGrant[]): WelfareStatus {
  if (role === 'Admin') return { status: 'always' };
  const live = activeGrantFor(grants, email);
  if (live) return { status: 'active', at: live.expiresAt };
  const latest = grants
    .filter(g => String(g.email || '').toLowerCase() === email)
    .sort((a, b) => Date.parse(b.grantedAt) - Date.parse(a.grantedAt))[0];
  if (!latest) return { status: 'none' };
  return latest.revokedAt
    ? { status: 'revoked', at: latest.revokedAt }
    : { status: 'expired', at: latest.expiresAt };
}

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  // Both roles need the list: admins to grant Welfare, platform admins to
  // choose an account to view as.
  if (!session.isAdmin && !session.isPlatformAdmin) {
    return NextResponse.json({ error: 'Not permitted' }, { status: 403 });
  }
  if (!USER_POOL_ID) {
    return NextResponse.json({ error: 'COGNITO_USER_POOL_ID is not set' }, { status: 500 });
  }

  try {
    const users: Array<{
      email: string; name: string; role: string; enabled: boolean;
      createdAt: string | null; welfare: WelfareStatus; lastActive: string | null;
    }> = [];
    let token: string | undefined;
    // readGrants returns an empty list if the file is missing or unreadable,
    // so a grants problem never breaks the user list.
    const grants = await readGrants();

    do {
      const page = await cognito.send(new ListUsersCommand({
        UserPoolId: USER_POOL_ID,
        Limit: 60,
        PaginationToken: token,
      }));
      for (const u of page.Users || []) {
        const email = attr(u, 'email').toLowerCase();
        if (!email) continue;
        const given = attr(u, 'given_name');
        const family = attr(u, 'family_name');
        const role = ADMIN_EMAILS.includes(email)
          ? 'Admin'
          : PLATFORM_ADMIN_EMAILS.includes(email)
            ? 'Platform Admin'
            : 'Member';
        users.push({
          email,
          name: [given, family].filter(Boolean).join(' ') || email,
          role,
          enabled: u.Enabled !== false,
          // Cognito creates the user on their first Google sign-in.
          createdAt: u.UserCreateDate ? new Date(u.UserCreateDate).toISOString() : null,
          welfare: welfareStatusFor(role, email, grants),
          lastActive: null,
        });
      }
      token = page.PaginationToken;
    } while (token);

    // Read after the list is built, in parallel. A missing file just means
    // no activity has been recorded for that user yet.
    const lastActive = await readLastActive(users.map(u => u.email));
    for (const u of users) u.lastActive = lastActive[u.email] ?? null;

    users.sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ users });
  } catch (err: any) {
    // The usual cause is a missing cognito-idp:ListUsers grant on the
    // dashboard's IAM user. Say so rather than returning an empty list, which
    // would look like "nobody has signed in yet".
    console.error('[users] error:', err?.name, err?.message);
    const denied = /AccessDenied|NotAuthorized/i.test(err?.name || '');
    return NextResponse.json({
      error: denied
        ? 'The dashboard is not allowed to list Cognito users. Grant cognito-idp:ListUsers on the user pool.'
        : (err.message || 'Could not list users'),
    }, { status: denied ? 403 : 500 });
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';