// app/api/users/route.ts
//
// Lists the registered dashboard users, for the "view as" and Welfare grant
// pickers. Without this both were free-text boxes, which meant guessing at
// addresses.
//
// Source is the Cognito user pool, so the list is whoever has actually signed
// in - users are created on first Google sign-in, not provisioned ahead of time.

import { NextRequest, NextResponse } from 'next/server';
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { getSession } from '@/lib/auth';

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
    const users: Array<{ email: string; name: string; role: string; enabled: boolean }> = [];
    let token: string | undefined;

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
        users.push({
          email,
          name: [given, family].filter(Boolean).join(' ') || email,
          role: ADMIN_EMAILS.includes(email)
            ? 'Admin'
            : PLATFORM_ADMIN_EMAILS.includes(email)
              ? 'Platform Admin'
              : 'Member',
          enabled: u.Enabled !== false,
        });
      }
      token = page.PaginationToken;
    } while (token);

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