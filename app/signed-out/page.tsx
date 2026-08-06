// app/signed-out/page.tsx
//
// Where Cognito sends the browser after logout.
//
// Previously logout returned to '/', which proxy.ts treats as protected: no
// session cookie meant an immediate redirect to /api/auth/login, which goes
// straight to Google with identity_provider=Google. Because Cognito logout does
// NOT end the Google session, Google silently re-authenticated and the user was
// signed back in before they saw anything. It looked like sign-out did nothing.
//
// This route is listed in PUBLIC_PREFIXES in proxy.ts, so the user lands here
// and stays here.

export default function SignedOut() {
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
          maxWidth: 460,
          width: '100%',
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 12,
          padding: '32px 36px',
          color: '#ffffff',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'rgba(128,208,144,0.9)', marginBottom: 14 }}>
          Signed out
        </div>

        <h1 style={{ fontSize: 22, margin: '0 0 12px', fontWeight: 600 }}>
          You have been signed out
        </h1>

        <p style={{ margin: '0 0 24px', lineHeight: 1.6, color: 'rgba(255,255,255,0.55)', fontSize: 14 }}>
          Your dashboard session has ended.
        </p>

        <a
          href="/api/auth/login"
          style={{
            display: 'inline-block',
            padding: '10px 22px',
            background: 'rgba(107,164,255,0.16)',
            border: '1px solid rgba(107,164,255,0.45)',
            borderRadius: 8,
            color: '#6ba4ff',
            textDecoration: 'none',
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          Sign in again
        </a>

        <p style={{ margin: '22px 0 0', lineHeight: 1.6, color: 'rgba(255,255,255,0.35)', fontSize: 12 }}>
          You are still signed in to Google. To sign in as someone else, sign out
          of your Google account or use a private window.
        </p>
      </div>
    </main>
  );
}
