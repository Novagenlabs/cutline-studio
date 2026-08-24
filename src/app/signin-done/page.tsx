/**
 * Where the sign-in popup lands.
 *
 * Google returns here after the consent screen. The popup's only remaining
 * job is to close, which tells the studio window the round trip is over so it
 * can re-read the balance. If it was not opened as a popup — someone
 * bookmarked this, or the browser blocked window.open and fell back to a
 * same-tab redirect — it sends them to the studio instead of stranding them
 * on a blank page.
 */
export default function SignInDone() {
  return (
    <main
      style={{
        display: 'grid',
        placeItems: 'center',
        minHeight: '100vh',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        color: '#e8e8ea',
      }}
    >
      <p style={{ opacity: 0.6, fontSize: 13 }}>Signed in — returning to the studio…</p>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            try {
              if (window.opener && window.opener !== window) window.close();
              else window.location.replace('/');
            } catch (e) {
              window.location.replace('/');
            }
          `,
        }}
      />
    </main>
  );
}
