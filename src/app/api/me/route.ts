import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { getBalance, getDownloadCount, SIGNUP_GRANT } from '@/lib/credits';

/**
 * Who am I, and what can I spend?
 *
 * Read-only and advisory: the cutter UI uses it to show a balance and to say
 * "out of credits" before a click rather than after. Nothing is authorised
 * here — the export route re-checks the balance inside the transaction that
 * charges it, so a stale or tampered answer from this endpoint cannot buy
 * anything.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    // The grant is reported so the sign-in prompt can state the real offer
    // without the browser bundle importing server code to learn it.
    return NextResponse.json({ signedIn: false, signupGrant: SIGNUP_GRANT }, { headers: NO_STORE });
  }

  const [balance, downloads] = await Promise.all([
    getBalance(db, session.user.id),
    getDownloadCount(db, session.user.id),
  ]);

  return NextResponse.json(
    { signedIn: true, email: session.user.email, balance, downloads },
    { headers: NO_STORE }
  );
}

// A cached balance is a wrong balance the moment a credit is spent.
const NO_STORE = { 'Cache-Control': 'no-store' };
