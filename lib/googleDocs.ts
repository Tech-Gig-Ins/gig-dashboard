// Located at: lib/googleDocs.ts
//
// Read-only access to Google Drive and Google Docs, as a Google service
// account. The account's JSON key is stored base64-encoded in the
// GOOGLE_SERVICE_ACCOUNT_KEY environment variable. The account can only see
// what has been shared with it (the support log folder, as Viewer).
//
// No Google libraries needed: it signs a short-lived token request itself.

import { createSign } from 'crypto';

const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
let token: { value: string; expires: number } | null = null;

function serviceAccount(): { client_email: string; private_key: string } {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error('Support is not connected to Google Drive yet (GOOGLE_SERVICE_ACCOUNT_KEY is not set).');
  const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const key = JSON.parse(json);
  if (!key.client_email || !key.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not a service account key.');
  return key;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function signJwt(email: string, privateKey: string, now = Math.floor(Date.now() / 1000)): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${claim}`);
  return `${head}.${claim}.${b64url(signer.sign(privateKey))}`;
}

async function accessToken(): Promise<string> {
  if (token && Date.now() < token.expires - 60_000) return token.value;
  const sa = serviceAccount();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signJwt(sa.client_email, sa.private_key),
    }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`Google sign-in failed: ${body.error_description || body.error || res.status}`);
  token = { value: body.access_token, expires: Date.now() + Number(body.expires_in || 3600) * 1000 };
  return token.value;
}

async function google(url: string): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google API ${res.status}: ${body?.error?.message || 'request failed'}`);
  return body;
}

export type DriveFile = { id: string; name: string; modifiedTime: string };

/** Google Docs in a folder whose name contains the given text. */
export async function listDocs(folderId: string, nameContains: string): Promise<DriveFile[]> {
  const q = `'${folderId}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.document' and name contains '${nameContains.replace(/'/g, "\\'")}'`;
  const files: DriveFile[] = [];
  let pageToken = '';
  do {
    const url = 'https://www.googleapis.com/drive/v3/files?' + new URLSearchParams({
      q, fields: 'nextPageToken, files(id, name, modifiedTime)', pageSize: '100',
      supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
      ...(pageToken ? { pageToken } : {}),
    });
    const body = await google(url);
    files.push(...(body.files || []));
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return files;
}

/** A Google Doc's full structure (text, headings, bold, colours). */
export async function getDoc(id: string): Promise<any> {
  return google(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(id)}`);
}