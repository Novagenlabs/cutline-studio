import NextAuth from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import EmailProvider from 'next-auth/providers/nodemailer';
import Google from 'next-auth/providers/google';
import { db } from './db';
import { SIGNUP_GRANT, grantCredits } from './credits';

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  session: { strategy: 'database' },
  providers: [
    Google,
    EmailProvider({
      server: process.env.EMAIL_SERVER,
      from: process.env.EMAIL_FROM,
    }),
  ],
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
