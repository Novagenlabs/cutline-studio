import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyWebhook, WebhookError } from '@/lib/whop';
import { applyMembershipEvent } from '@/lib/subscription';

/**
 * Whop webhook: the only place a subscription becomes real.
 *
 * Never grant access because a browser landed on a success URL — that URL is
 * a redirect anyone can visit directly. This endpoint is trusted because the
 * payload is signature-verified against the raw bytes with a shared secret.
 *
 * Whop retries for ~71 hours and expects a 2xx within 5 seconds, which shapes
 * two decisions:
 *
 * - The event is recorded BEFORE it is handled. If handling throws, the row
 *   survives with its error, so a bug is visible and replayable rather than
 *   lost in a log.
 * - A duplicate returns 200 immediately. Whop's at-least-once delivery makes
 *   replays routine, and a replay that re-ran the handler would be a second
 *   grant for one payment.
 */
export async function POST(req: Request) {
  const secret = process.env.WHOP_WEBHOOK_SECRET;
  if (!secret) {
    // 503, not 500: the endpoint is unconfigured rather than broken, and
    // Whop should keep retrying while that is fixed.
    return NextResponse.json(
      { error: 'Whop webhooks are not configured.' },
      { status: 503 }
    );
  }

  // The raw text, not a parsed body: the signature covers the exact bytes
  // sent, and re-serialising would reorder keys and change whitespace.
  const raw = await req.text();

  let event;
  try {
    event = verifyWebhook(raw, req.headers, secret);
  } catch (err) {
    const status = err instanceof WebhookError ? err.status : 400;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid webhook.' },
      { status }
    );
  }

  // Idempotency. `create` rather than `upsert` so the unique violation IS the
  // duplicate check — two concurrent deliveries of the same id cannot both
  // pass, which a read-then-write could.
  try {
    await db.whopEvent.create({
      data: {
        id: event.id,
        type: event.type,
        payload: event.payload as object,
      },
    });
  } catch {
    // Already seen — but "seen" is not "handled". A first attempt that threw
    // left the row with an error and no processedAt, and Whop's retry is the
    // second chance: answering 200 there would discard the only delivery
    // that could still succeed. Only a completed event short-circuits.
    const seen = await db.whopEvent.findUnique({
      where: { id: event.id },
      select: { processedAt: true },
    });
    if (seen?.processedAt) {
      return NextResponse.json({ received: true, duplicate: true });
    }
    // Fall through and handle it: applyMembershipEvent is idempotent, so a
    // retry of a partially applied event converges rather than duplicating.
  }

  try {
    const { subscriptionId } = await applyMembershipEvent(event.payload);
    await db.whopEvent.update({
      where: { id: event.id },
      // Clears any error from a previous failed attempt, so the row reads as
      // what finally happened rather than keeping a stale complaint.
      data: { processedAt: new Date(), subscriptionId, error: null },
    });
  } catch (err) {
    // Recorded, not swallowed: the row keeps the payload and the error, and
    // the 500 asks Whop to retry — which is safe, because the retry will be
    // handled by the same idempotent upsert.
    await db.whopEvent.update({
      where: { id: event.id },
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return NextResponse.json({ error: 'Handler failed.' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
