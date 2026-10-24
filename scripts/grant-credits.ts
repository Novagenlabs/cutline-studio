/**
 * Grant credits to an account by hand.
 *
 *   npx tsx scripts/grant-credits.ts <email> <credits> [--apply] [--note "why"]
 *
 * Without --apply it only looks: which database, whether the account exists,
 * its balance and its last few ledger entries. That is the whole point of
 * running it twice — the first run is where "wrong database" or "no such
 * account" gets caught, before anything is written.
 *
 * The grant goes through grantCredits() as an ADMIN_ADJUSTMENT entry, never a
 * raw update: the balance IS the sum of the ledger, so a manual change that
 * bypassed the ledger would be invisible to every reconciliation and to the
 * account page. A negative adjustment is deliberately not offered here; use a
 * REFUND/DOWNLOAD-aware path for that.
 *
 * Reads DATABASE_URL from the environment, or from .env if it is not set —
 * tsx does not load .env the way Next does.
 */
import { readFileSync } from 'node:fs';

function loadEnvFile(): void {
  if (process.env.DATABASE_URL) return;
  let text = '';
  try {
    text = readFileSync('.env', 'utf8');
  } catch {
    return;
  }
  const m = /^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m.exec(text);
  if (m) process.env.DATABASE_URL = m[1].trim();
}

function maskedHost(url: string | undefined): string {
  if (!url) return '(unset)';
  const m = /@([^/?]+)/.exec(url);
  return m ? m[1] : '(unparseable)';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const noteIdx = args.indexOf('--note');
  const note = noteIdx >= 0 ? args[noteIdx + 1] : undefined;
  const positional = args.filter((a, i) => !a.startsWith('--') && (noteIdx < 0 || i !== noteIdx + 1));
  const [email, creditsArg] = positional;
  const credits = Number(creditsArg);

  if (!email || !email.includes('@') || !Number.isInteger(credits) || credits <= 0 || credits > 1_000_000) {
    console.error('usage: npx tsx scripts/grant-credits.ts <email> <credits 1..1000000> [--apply] [--note "why"]');
    process.exit(2);
  }

  loadEnvFile();
  console.log(`database: ${maskedHost(process.env.DATABASE_URL)}`);

  // Imported after the environment is settled: db.ts reads DATABASE_URL when
  // it builds the client.
  const { db } = await import('../src/lib/db');
  const { getBalance, grantCredits } = await import('../src/lib/credits');

  try {
    const user = await db.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, createdAt: true },
    });
    if (!user) {
      console.error(`no account with the email ${email} — nothing written`);
      // The size of the database says whether this is the production one
      // at all: a handful of accounts is a dev branch, and a well-known
      // account missing here means DATABASE_URL points somewhere else.
      const total = await db.user.count();
      console.error(`accounts on this database: ${total}`);
      // Accounts only exist after a first sign-in, and the lookup above is
      // exact. Show what is close, so a capitalisation or a typo is obvious
      // rather than a guess.
      const stem = email.split('@')[0].slice(0, 8);
      const near = await db.user.findMany({
        where: { email: { contains: stem, mode: 'insensitive' } },
        select: { email: true, createdAt: true },
        take: 5,
      });
      if (near.length) {
        console.error('similar accounts:');
        for (const n of near) console.error(`  ${n.email}  (created ${n.createdAt.toISOString().slice(0, 10)})`);
      } else {
        console.error('no similar accounts either — the user may not have signed in yet');
      }
      process.exit(1);
    }
    const before = await getBalance(db, user.id);
    const recent = await db.creditEntry.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { createdAt: true, amount: true, reason: true, note: true },
    });
    console.log(`account:  ${user.email}${user.name ? ` (${user.name})` : ''}, created ${user.createdAt.toISOString().slice(0, 10)}`);
    console.log(`balance:  ${before} credit${before === 1 ? '' : 's'}`);
    for (const e of recent) {
      console.log(
        `  ${e.createdAt.toISOString().slice(0, 16).replace('T', ' ')}  ${e.amount >= 0 ? '+' : ''}${e.amount}  ${e.reason}${e.note ? `  "${e.note}"` : ''}`
      );
    }

    if (!apply) {
      console.log(`\ndry run — re-run with --apply to grant ${credits} credits to this account`);
      return;
    }

    await grantCredits(db, user.id, credits, 'ADMIN_ADJUSTMENT', {
      note: note ?? `manual grant via scripts/grant-credits.ts`,
    });
    const after = await getBalance(db, user.id);
    console.log(`\ngranted ${credits} credits as ADMIN_ADJUSTMENT`);
    console.log(`balance:  ${before} -> ${after}`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
