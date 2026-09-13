import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { grantsAccess, mapStatus, verifyWebhook, WebhookError } from '../src/lib/whop';

/**
 * The two places a Whop bug costs real money.
 *
 * Signature verification decides whether a stranger can grant themselves a
 * subscription by POSTing JSON. The access rules decide whether a paying
 * customer is cut off early, or a departed one keeps using the product.
 * Neither is visible in the UI until it has already gone wrong.
 */

const SECRET = 'whsec_' + Buffer.from('test-signing-key').toString('base64');

function sign(id: string, timestamp: string, body: string, secret = SECRET) {
  const key = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice(6), 'base64')
    : Buffer.from(secret, 'utf8');
  return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
}

function headers(id: string, timestamp: string, signature: string): Headers {
  return new Headers({
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${signature}`,
  });
}

const now = () => String(Math.floor(Date.now() / 1000));

describe('webhook signatures', () => {
  const body = JSON.stringify({ type: 'membership.activated', data: { id: 'mem_1' } });

  it('accepts a correctly signed payload', () => {
    const ts = now();
    const result = verifyWebhook(body, headers('msg_1', ts, sign('msg_1', ts, body)), SECRET);
    expect(result.id).toBe('msg_1');
    expect(result.type).toBe('membership.activated');
  });

  it('REJECTS A FORGED PAYLOAD: the whole point of the endpoint', () => {
    const ts = now();
    expect(() =>
      verifyWebhook(body, headers('msg_1', ts, 'not-a-real-signature'), SECRET)
    ).toThrow(WebhookError);
  });

  it('rejects a payload signed with the wrong secret', () => {
    const ts = now();
    const wrong = sign('msg_1', ts, body, 'whsec_' + Buffer.from('other').toString('base64'));
    expect(() => verifyWebhook(body, headers('msg_1', ts, wrong), SECRET)).toThrow(
      /did not match/
    );
  });

  it('rejects a body altered after signing', () => {
    const ts = now();
    const signature = sign('msg_1', ts, body);
    const tampered = JSON.stringify({ type: 'membership.activated', data: { id: 'mem_EVIL' } });
    expect(() => verifyWebhook(tampered, headers('msg_1', ts, signature), SECRET)).toThrow(
      /did not match/
    );
  });

  it('rejects a replay from outside the timestamp tolerance', () => {
    // A captured request stays validly signed forever; the timestamp is what
    // stops it being replayed a week later.
    const old = String(Math.floor(Date.now() / 1000) - 60 * 60);
    expect(() =>
      verifyWebhook(body, headers('msg_1', old, sign('msg_1', old, body)), SECRET)
    ).toThrow(/tolerance/);
  });

  it('accepts one of several signatures during a secret rotation', () => {
    const ts = now();
    const good = sign('msg_1', ts, body);
    const h = new Headers({
      'webhook-id': 'msg_1',
      'webhook-timestamp': ts,
      'webhook-signature': `v1,an-old-secrets-signature v1,${good}`,
    });
    expect(verifyWebhook(body, h, SECRET).id).toBe('msg_1');
  });

  it('rejects a request with no signature headers at all', () => {
    expect(() => verifyWebhook(body, new Headers(), SECRET)).toThrow(/Missing/);
  });
});

describe('status mapping', () => {
  it('maps every status Whop documents', () => {
    expect(mapStatus('trialing')).toBe('TRIALING');
    expect(mapStatus('active')).toBe('ACTIVE');
    expect(mapStatus('past_due')).toBe('PAST_DUE');
    expect(mapStatus('canceled')).toBe('CANCELED');
    expect(mapStatus('canceling')).toBe('CANCELING');
    expect(mapStatus('expired')).toBe('EXPIRED');
    expect(mapStatus('completed')).toBe('COMPLETED');
    expect(mapStatus('unresolved')).toBe('UNRESOLVED');
    expect(mapStatus('drafted')).toBe('DRAFTED');
  });

  it('does not throw on a status Whop adds later', () => {
    // A 500 here would make Whop retry for three days over a word we simply
    // have not seen before.
    expect(mapStatus('some_future_status')).toBe('UNKNOWN');
    expect(mapStatus(undefined)).toBe('UNKNOWN');
  });
});

describe('who gets access', () => {
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000);

  it('grants on an active paid period', () => {
    expect(grantsAccess('ACTIVE', future)).toBe(true);
  });

  it('grants during the 3-day trial', () => {
    // The Starter plan sells with a trial; refusing it would break the
    // product's own funnel on day one.
    expect(grantsAccess('TRIALING', future)).toBe(true);
  });

  it('KEEPS ACCESS AFTER CANCELLING, until the period ends', () => {
    // They have paid for this month. Cutting them off the moment they turn
    // off renewal is taking money for access not given.
    expect(grantsAccess('CANCELING', future)).toBe(true);
  });

  it('keeps access while a card is being retried', () => {
    // past_due is Whop still trying. A transient decline is not a departure.
    expect(grantsAccess('PAST_DUE', future)).toBe(true);
  });

  it('REVOKES when the paid period has passed, even if status says active', () => {
    // This is the missed-webhook case: the period is the fact, the status is
    // a cached opinion about it. Trusting the status here is free access.
    expect(grantsAccess('ACTIVE', past)).toBe(false);
    expect(grantsAccess('CANCELING', past)).toBe(false);
  });

  it('revokes on the terminal statuses', () => {
    expect(grantsAccess('EXPIRED', future)).toBe(false);
    expect(grantsAccess('CANCELED', future)).toBe(false);
    expect(grantsAccess('COMPLETED', future)).toBe(false);
    expect(grantsAccess('DRAFTED', future)).toBe(false);
    expect(grantsAccess('UNKNOWN', future)).toBe(false);
  });
});
