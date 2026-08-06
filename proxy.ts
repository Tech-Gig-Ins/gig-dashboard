// proxy.ts
//
// Next.js 16 renamed Middleware to Proxy. The file must be named proxy.ts and
// live at the project root, alongside app/. A file called middleware.ts is
// simply ignored by Next 16, which for an auth gate would mean the app looks
// protected while being wide open.
//
// Per the Next 16 docs, Proxy is for OPTIMISTIC checks only: it runs on every
// request including prefetches, so it must stay cheap and must not be relied on
// as the authorization boundary. All it does here is notice that no session
// cookie is present and bounce the browser to sign-in.
//
// The real verification (JWT signature, expiry, email domain, admin role)
// happens in lib/auth.ts, called by every API route and server component.
// Do not remove those checks on the assumption that this file covers them.
//
// Note: the `runtime` config option is not available in Proxy files and setting
// it throws. Proxy defaults to the Node.js runtime in Next 16.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const ID_COOKIE = 'gwu_id';

// Paths reachable without a session. Everything else requires one.
const PUBLIC_PREFIXES = [
  '/api/auth/',      // login, callback, logout
  '/signed-out',     // post-logout landing
  '/access-denied',  // wrong-domain message
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(p => pathname.startsWith(p));
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const hasSession = Boolean(request.cookies.get(ID_COOKIE)?.value);
  if (hasSession) return NextResponse.next();

  // API calls get a 401 rather than an HTML redirect, so fetch() callers can
  // detect the expired session and reload instead of parsing a login page.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: 'Not authenticated', code: 'UNAUTHENTICATED' },
      { status: 401 }
    );
  }

  // Remember where they were headed so the callback can return them there.
  const loginUrl = new URL('/api/auth/login', request.url);
  loginUrl.searchParams.set('next', pathname + search);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Skip Next internals and static assets; those never need a session and
  // matching them would add latency to every asset request.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
