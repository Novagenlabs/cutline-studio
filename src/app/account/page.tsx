import { redirect } from 'next/navigation';
import { auth, signIn, signOut } from '@/lib/auth';
import { db } from '@/lib/db';
import { getBalance, getDownloadCount, SIGNUP_GRANT } from '@/lib/credits';
import { PACKS } from '../api/stripe/checkout/route';

export const dynamic = 'force-dynamic';

/**
 * Minimal account page. Enough to sign in, see a balance, buy credits, and
 * read the download history — the states that need to be real before the
 * cutter UI is wired to the paid export.
 */
export default async function Page() {
  const session = await auth();

  if (!session?.user?.id) {
    return (
      <main style={S.main}>
        <a href="/" style={S.back}>← Back to the studio</a>
        <h1 style={S.h1}>
          <a href="/" style={S.titleLink}>Cutline Studio</a>
        </h1>
        <p style={S.dim}>
          Sign in to get {SIGNUP_GRANT} free credits. One credit per download.
        </p>
        <form
          action={async () => {
            'use server';
            await signIn('google', { redirectTo: '/' });
          }}
        >
          <button type="submit" style={S.btn}>Sign in with Google</button>
        </form>
      </main>
    );
  }

  const [balance, downloads, history] = await Promise.all([
    getBalance(db, session.user.id),
    getDownloadCount(db, session.user.id),
    db.download.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);

  return (
    <main style={S.main}>
      <a href="/" style={S.back}>← Back to the studio</a>
      <h1 style={S.h1}>
        <a href="/" style={S.titleLink}>Cutline Studio</a>
      </h1>
      <p style={S.dim}>{session.user.email}</p>

      <section style={S.card}>
        <div style={S.balance}>{balance}</div>
        <div style={S.dim}>credits · {downloads} download{downloads === 1 ? '' : 's'}</div>
      </section>

      <h2 style={S.h2}>Buy credits</h2>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {Object.entries(PACKS).map(([id, p]) => (
          <form
            key={id}
            action={async () => {
              'use server';
              const res = await fetch(`${process.env.APP_URL}/api/stripe/checkout`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ pack: id }),
              });
              const { url } = await res.json();
              if (url) redirect(url);
            }}
          >
            <button type="submit" style={S.pack}>
              <div style={{ fontSize: 18 }}>{p.label}</div>
              <div style={S.dim}>${(p.amount / 100).toFixed(2)} CAD</div>
            </button>
          </form>
        ))}
      </div>

      <h2 style={S.h2}>Recent downloads</h2>
      {history.length === 0 ? (
        <p style={S.dim}>Nothing yet.</p>
      ) : (
        <ul style={{ padding: 0, listStyle: 'none' }}>
          {history.map((d) => (
            <li key={d.id} style={S.row}>
              <span>{d.filename}</span>
              <span style={S.dim}>
                {d.format} · {(d.bytes / 1024).toFixed(0)} KB ·{' '}
                {d.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div style={S.returnRow}>
        <a href="/" style={S.returnBtn}>← Back to the studio</a>
      </div>

      <form
        action={async () => {
          'use server';
          await signOut({ redirectTo: '/' });
        }}
      >
        <button type="submit" style={{ ...S.btn, marginTop: 32, opacity: 0.6 }}>
          Sign out
        </button>
      </form>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  main: { maxWidth: 720, margin: '0 auto', padding: '48px 24px' },
  // The account is a detour from the studio, not a destination, so the way
  // back is the first thing on the page and again at the end — where someone
  // lands after buying credits and wants to get on with cutting.
  back: {
    display: 'inline-block',
    marginBottom: 20,
    fontSize: 12,
    letterSpacing: '0.06em',
    color: 'inherit',
    opacity: 0.55,
    textDecoration: 'none',
  },
  titleLink: { color: 'inherit', textDecoration: 'none' },
  returnRow: { marginTop: 40 },
  returnBtn: {
    display: 'inline-block',
    padding: '10px 18px',
    borderRadius: 8,
    border: '1px solid #26262c',
    color: 'inherit',
    textDecoration: 'none',
    fontSize: 14,
  },
  h1: { fontSize: 22, letterSpacing: '0.04em', margin: '0 0 4px' },
  h2: { fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.12em', opacity: 0.5, marginTop: 40 },
  dim: { opacity: 0.55, fontSize: 13, margin: '4px 0' },
  card: { border: '1px solid #26262c', borderRadius: 10, padding: 24, marginTop: 24 },
  balance: { fontSize: 44, lineHeight: 1 },
  btn: {
    background: '#e6007e', color: '#fff', border: 0, borderRadius: 8,
    padding: '10px 18px', fontSize: 14, cursor: 'pointer', fontFamily: 'inherit',
  },
  pack: {
    background: '#17171c', color: '#e8e8ea', border: '1px solid #26262c',
    borderRadius: 10, padding: '16px 20px', cursor: 'pointer',
    fontFamily: 'inherit', textAlign: 'left', minWidth: 130,
  },
  row: {
    display: 'flex', justifyContent: 'space-between', gap: 16,
    padding: '10px 0', borderBottom: '1px solid #1c1c22', fontSize: 13,
  },
};
