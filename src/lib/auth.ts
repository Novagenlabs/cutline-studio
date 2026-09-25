import NextAuth, { type NextAuthConfig } from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import Google from 'next-auth/providers/google';
import { db } from './db';
import { SIGNUP_GRANT, grantCredits } from './credits';
import { claimSubscriptions } from './subscription';
import { describeAuthError, authErrorHint } from './auth-log';

/**
 * Providers are assembled from what is actually configured.
 *
 * The email provider pulls in `nodemailer`, which is an optional peer of
 * Auth.js — importing it unconditionally makes the whole app fail to compile
 * on any deployment that only wants Google sign-in, which is exactly what
 * happened the first time this was run. Requiring an SMTP dependency to use
 * OAuth is the wrong coupling.
 */
const providers: NextAuthConfig['providers'] = [Google];

if (process.env.EMAIL_SERVER && process.env.EMAIL_FROM) {
  // Loaded lazily so `nodemailer` is only resolved when email sign-in is
  // actually configured.
  const { default: Nodemailer } = await import('next-auth/providers/nodemailer');
  providers.push(
    Nodemailer({ server: process.env.EMAIL_SERVER, from: process.env.EMAIL_FROM })
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  /**
   * Behind a reverse proxy (Dokploy, Vercel, anything terminating TLS) the
   * request Auth.js sees carries the internal host, so it cannot infer the
   * public origin and would build callback URLs pointing at localhost —
   * which Google then rejects. Trusting the forwarded host is what makes the
   * deployed callback match the one registered with the provider.
   *
   * Set here rather than relying on AUTH_TRUST_HOST being remembered at
   * deploy time: a forgotten variable would break sign-in in production only,
   * which is the worst place to discover it.
   */
  trustHost: true,
  /**
   * Both secrets, explicitly, so AUTH_SECRET can be rotated.
   *
   * Every sign-in cookie — session, CSRF, and the 15-minute PKCE/state
   * cookies of an OAuth round trip — is encrypted with the secret. Change
   * it and every existing cookie stops decrypting: users are signed out, and
   * anyone mid-sign-in lands on the error page with "pkceCodeVerifier value
   * could not be parsed". Auth.js can decrypt with several secrets (the
   * first one encodes), which makes a rotation painless — but under
   * next-auth the AUTH_SECRET_1..3 environment convention is dead: next-auth
   * sets `secret` to the bare AUTH_SECRET string before @auth/core ever looks
   * for the numbered ones. So the array is built here.
   *
   * Empty when AUTH_SECRET is unset, which hands the decision back to the
   * environment defaults exactly as before.
   */
  secret: [process.env.AUTH_SECRET, process.env.AUTH_SECRET_PREVIOUS].filter(
    (s): s is string => typeof s === 'string' && s.length > 0
  ),
  /**
   * Our own error page. Auth.js's default reads "Server error — there is a
   * problem with the server configuration", which is what users reported,
   * and it offers no way to try again. Ours does, in place, and says what
   * actually happened (see app/signin-error/page.tsx).
   */
  pages: { error: '/signin-error' },
  /**
   * Log the cause, not just the wrapper.
   *
   * Auth.js attaches the underlying error as `cause` but its default logger
   * only prints a cause that carries an `err` property — which the OAuth
   * checks do not set. The production log therefore showed one line,
   * "InvalidCheck: pkceCodeVerifier value could not be parsed", for what is
   * at least three different problems with three different fixes. This
   * prints the chain and, where the cause is one seen before, what to do.
   */
  logger: {
    error(error) {
      const lines = describeAuthError(error);
      console.error(`[auth][error] ${lines[0]}`);
      for (const line of lines.slice(1)) console.error(`[auth][cause] ${line}`);
      const hint = authErrorHint(lines);
      if (hint) console.error(`[auth][hint] ${hint}`);
      if (error instanceof Error && error.stack) console.error(error.stack);
    },
  },
  session: { strategy: 'database' },
  providers,
  callbacks: {
    session({ session, user }) {
      if (session.user) session.user.id = user.id;
      return session;
    },
  },
  events: {
    /**
     * The free trial credits, granted once at account creation.
     *
     * `createUser` fires exactly once per User row, so this cannot double-
     * grant on repeat sign-ins. It is deliberately not tied to email address
     * or IP: someone determined to farm free credits can make new accounts
     * either way, and blocking that costs real users (shared offices, phone
     * networks) more than it saves. Two credits is a sample, priced so abuse
     * is not worth the effort.
     */
    async createUser({ user }) {
      if (!user.id) return;
      await grantCredits(db, user.id, SIGNUP_GRANT, 'SIGNUP_GRANT', {
        note: 'welcome grant',
      });
    },

    /**
     * Attach Whop memberships bought before this account existed.
     *
     * A Whop checkout can complete before the buyer has ever signed in here,
     * so the webhook records the membership with no user attached. This is
     * where it finds its owner — matched on the email they paid with.
     *
     * On every sign-in rather than only on createUser: someone can buy on
     * Whop weeks after making a Cutline account, and that purchase should
     * attach on their next visit rather than never.
     *
     * Deliberately non-fatal. A failure here must not block sign-in — the
     * subscription is still recorded and will attach on the next attempt,
     * whereas a thrown error locks a paying customer out of the app.
     */
    async signIn({ user }) {
      if (!user.id || !user.email) return;
      try {
        await claimSubscriptions(user.id, user.email);
      } catch (error) {
        console.error('Could not claim Whop subscriptions', error);
      }
    },
  },
});
