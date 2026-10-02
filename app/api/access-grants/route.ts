// app/api/access-grants/route.ts
//
// GET    - the caller's own Welfare access, plus (for admins) every grant
// POST   - admin grants a user Welfare access for 1-7 days
// DELETE - admin revokes a grant early
//
// Grants live in S3 at access-grants/welfare.json. Expired entries are kept
// rather than removed: the file is the audit trail.

import { NextRequest, NextResponse } from 'next/server';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  requireAuth, requireAdmin, getSession,
  readGrants, activeGrantFor, checkWelfareAccess,
  GRANTS_KEY, type WelfareGrant,
} from '@/lib/auth';

const REGION = process.env.MY_AWS_REGION || 'us-east-1';
const BUCKET = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  },
});

const ALLOWED_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || '')
  .trim().toLowerCase().replace(/^@/, '');

async function writeGrants(grants: WelfareGrant[]) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: GRANTS_KEY,
    Body: JSON.stringify({ grants }, null, 2),
    ContentType: 'application/json',
  }));
}

// ---------------------------------------------------------------- GET
export async function GET(req: NextRequest) {
  const gate = await requireAuth(req);
  if (gate instanceof NextResponse) return gate;

  const access = await checkWelfareAccess(gate);

  // Everyone learns their own status; only an admin sees the full list.
  if (!gate.isAdmin) {
    return NextResponse.json({ access, grants: null });
  }

  const grants = await readGrants();
  const now = Date.now();
  const decorated = grants.map(g => ({
    ...g,
    active: !g.revokedAt && Date.parse(g.expiresAt) > now,
    msRemaining: Math.max(0, Date.parse(g.expiresAt) - now),
  }));
  // Live grants first, then most recently granted.
  decorated.sort((a, b) =>
    Number(b.active) - Number(a.active) ||
    Date.parse(b.grantedAt) - Date.parse(a.grantedAt));

  return NextResponse.json({ access, grants: decorated });
}

// --------------------------------------------------------------- POST
export async function POST(req: NextRequest) {
  // Only a true admin grants access. A platform admin must not be able to
  // grant it to themselves, which is the whole point of the separation.
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  if (!session.isAdmin) {
    return NextResponse.json(
      { error: 'Only an administrator can grant Welfare access.' },
      { status: 403 }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const days = Number(body.days);

    if (!email || !email.includes('@')) {
      return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
    }
    if (ALLOWED_DOMAIN && email.split('@').pop() !== ALLOWED_DOMAIN) {
      return NextResponse.json(
        { error: `Only @${ALLOWED_DOMAIN} accounts can be granted access.` },
        { status: 400 }
      );
    }
    // Clamped server-side: a crafted request cannot ask for 400 days.
    if (!Number.isInteger(days) || days < 1 || days > 7) {
      return NextResponse.json(
        { error: 'Access must be between 1 and 7 days.' }, { status: 400 }
      );
    }

    const grants = await readGrants();

    // Replacing an existing live grant: revoke it so the history shows both.
    const existing = activeGrantFor(grants, email);
    if (existing) {
      existing.revokedAt = new Date().toISOString();
      existing.revokedBy = session.email;
    }

    const now = new Date();
    const grant: WelfareGrant = {
      email,
      grantedBy: session.email,
      grantedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + days * 24 * 3600 * 1000).toISOString(),
      days,
    };
    grants.push(grant);
    await writeGrants(grants);

    console.log(`[access-grants] ${session.email} granted ${email} Welfare for ${days} day(s)`);
    return NextResponse.json({ ok: true, grant, replaced: Boolean(existing) });
  } catch (err: any) {
    console.error('[access-grants] POST error:', err);
    return NextResponse.json({ error: err.message || 'Failed to grant access' }, { status: 500 });
  }
}

// ------------------------------------------------------------- DELETE
export async function DELETE(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  if (!session.isAdmin) {
    return NextResponse.json(
      { error: 'Only an administrator can revoke Welfare access.' },
      { status: 403 }
    );
  }

  try {
    const email = (req.nextUrl.searchParams.get('email') || '').trim().toLowerCase();
    if (!email) {
      return NextResponse.json({ error: 'email is required' }, { status: 400 });
    }

    const grants = await readGrants();
    const live = activeGrantFor(grants, email);
    if (!live) {
      return NextResponse.json(
        { error: `${email} has no active grant.` }, { status: 404 }
      );
    }
    live.revokedAt = new Date().toISOString();
    live.revokedBy = session.email;
    await writeGrants(grants);

    console.log(`[access-grants] ${session.email} revoked Welfare access for ${email}`);
    return NextResponse.json({ ok: true, email });
  } catch (err: any) {
    console.error('[access-grants] DELETE error:', err);
    return NextResponse.json({ error: err.message || 'Failed to revoke access' }, { status: 500 });
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';