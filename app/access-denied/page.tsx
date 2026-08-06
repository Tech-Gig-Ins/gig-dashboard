// app/access-denied/page.tsx
//
// Where the callback sends someone whose sign-in was refused. The usual reason
// is the PreSignUp domain gate rejecting a non-organisation Google account.
//
// This route is listed in PUBLIC_PREFIXES in proxy.ts; it must stay reachable
// without a session or a refused user would bounce between here and login.

type Props = { searchParams: Promise<{ reason?: string }> };

export default async function AccessDenied({ searchParams }: Props) {
  // searchParams is a promise in Next 16 and must be awaited.
  const { reason } = await searchParams;

  const message =
    reason && reason.trim()
      ? reason
      : 'You are not logging in via an authorized organization.';

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0a1628',
        fontFamily: "'Inter', system-ui, sans-serif",
        padding: 24,
      }}
    >
      <div
        style={{
          maxWidth: 520,
          width: '100%',
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,136,136,0.35)',
          borderRadius: 12,
          padding: '32px 36px',
          color: '#ffffff',
        }}
      >
        <div style={{ fontSize: 12, letterSpacing: '0.18em', textTransform: 'uppercase', color: '#ff8888', marginBottom: 14 }}>
          Sign-in refused
        </div>

        <h1 style={{ fontSize: 24, margin: '0 0 14px', fontWeight: 600 }}>
          Access denied
        </h1>

        <p style={{ margin: '0 0 22px', lineHeight: 1.6, color: 'rgba(255,255,255,0.78)', fontSize: 15 }}>
          {message}
        </p>

        <p style={{ margin: '0 0 26px', lineHeight: 1.6, color: 'rgba(255,255,255,0.5)', fontSize: 13 }}>
          This dashboard is restricted to Gig Workers Universe accounts. If you
          believe you should have access, contact your administrator.
        </p>

        <a
          href="/api/auth/logout"
          style={{
            display: 'inline-block',
            padding: '10px 20px',
            background: 'rgba(107,164,255,0.14)',
            border: '1px solid rgba(107,164,255,0.4)',
            borderRadius: 8,
            color: '#6ba4ff',
            textDecoration: 'none',
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          Sign in with a different account
        </a>
      </div>
    </main>
  );
}
