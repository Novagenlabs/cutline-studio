import { PrismaClient } from '@prisma/client';

// Next reloads modules in dev; without the global cache each reload opens a
// new pool and eventually exhausts Postgres connections.
const g = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Give a cold database room to wake up.
 *
 * Neon scales compute to zero when idle, and at this traffic level nearly
 * every request arrives cold: measured against production, the first query
 * takes ~2.6s where a warm one takes ~220ms. Prisma's default connect_timeout
 * is 5s, which usually covers that and sometimes does not — and when it does
 * not during an OAuth callback, Auth.js reports the adapter failure as
 * `error=Configuration`, which reads like a broken deployment rather than a
 * slow connection. That is what a user hit on Safari, and why retrying
 * worked: by then the compute was awake.
 *
 * So the timeout is raised rather than left to chance. A sign-in that takes
 * four seconds is a worse experience than one that takes one, but it is a far
 * better one than an error page that blames the configuration.
 */
function url(): string | undefined {
  const base = process.env.DATABASE_URL;
  if (!base) return undefined;
  // Respect an explicit setting if the environment already carries one.
  if (base.includes('connect_timeout=')) return base;
  return `${base}${base.includes('?') ? '&' : '?'}connect_timeout=15`;
}

const client = () => {
  const u = url();
  return u ? new PrismaClient({ datasources: { db: { url: u } } }) : new PrismaClient();
};

export const db = g.prisma ?? client();
if (process.env.NODE_ENV !== 'production') g.prisma = db;
