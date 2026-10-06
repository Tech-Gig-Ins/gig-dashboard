// lib/activity.ts
//
// "Last active" for the Users & Roles tab. Cognito does not record sign-in
// times on our tier, so the dashboard records them itself.
//
// One small file per user at user-activity/<email>.json, holding only the
// latest time. Every page load updates it (through /api/auth/me), at most once
// every 5 minutes so quick reloads do not cause a write each time.
//
// History is still kept: the bucket is versioned, so each update leaves the
// previous one behind as an older version.

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const BUCKET = process.env.S3_RAW_BUCKET || 'gig-remittance-raw-prod';
const PREFIX = 'user-activity/';
const MIN_GAP_MS = 5 * 60 * 1000;

const s3 = new S3Client({
  region: process.env.MY_AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.MY_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY!,
  },
});

function keyFor(email: string): string {
  return `${PREFIX}${email.trim().toLowerCase()}.json`;
}

async function readOne(email: string): Promise<string | null> {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: keyFor(email) }));
    const text = await obj.Body!.transformToString('utf-8');
    const parsed = JSON.parse(text);
    return typeof parsed.lastActive === 'string' ? parsed.lastActive : null;
  } catch {
    // No file yet means the user has not been active since this was deployed.
    return null;
  }
}

/** Record that this user is active now. Never throws: it must not block sign-in. */
export async function recordActivity(email: string): Promise<void> {
  if (!email) return;
  try {
    const previous = await readOne(email);
    if (previous && Date.now() - Date.parse(previous) < MIN_GAP_MS) return;
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: keyFor(email),
      Body: JSON.stringify({ email: email.toLowerCase(), lastActive: new Date().toISOString() }),
      ContentType: 'application/json',
    }));
  } catch (err: any) {
    // The usual cause is a missing s3:PutObject grant on user-activity/*.
    console.warn('[activity] could not record activity:', err?.name, err?.message);
  }
}

/** Latest activity time for each email, or null where none is recorded. */
export async function readLastActive(emails: string[]): Promise<Record<string, string | null>> {
  const times = await Promise.all(emails.map(readOne));
  const out: Record<string, string | null> = {};
  emails.forEach((e, i) => { out[e] = times[i]; });
  return out;
}