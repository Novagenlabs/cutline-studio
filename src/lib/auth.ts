import NextAuth, { type NextAuthConfig } from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import Google from 'next-auth/providers/google';
import { db } from './db';
import { SIGNUP_GRANT, grantCredits } from './credits';

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
  },
});
