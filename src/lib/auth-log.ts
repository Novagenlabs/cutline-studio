/**
 * Name the real reason an Auth.js error happened.
 *
 * Auth.js wraps most failures in one of its own error types and attaches the
 * underlying error as `cause`. Its default logger only prints that cause when
 * it has an `err` property — which the OAuth checks do not set — so a
 * production log showed "InvalidCheck: pkceCodeVerifier value could not be
 * parsed" and nothing else. That one message covers at least three different
 * problems (an expired cookie, a cookie encrypted under a different secret,
 * a malformed payload) with three different fixes, and the log could not say
 * which. This walks the cause chain so it can.
 *
 * Nothing here echoes cookie or token values: jose's messages describe the
 * failure ("exp" claim timestamp check failed), not the material.
 */

interface ErrorLike {
  name?: unknown;
  type?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: unknown;
}

/**
 * Auth.js has two conventions for `cause`: the error itself, or an object
 * `{ err, ...details }` where `err` is the error and the rest is context
 * such as the provider id (CallbackRouteError does this). The details are
 * worth a line, minus anything that looks like a secret — the convention
 * puts whatever the call site had to hand in there.
 */
const SENSITIVE = /secret|token|code|cookie|password|key|verifier|state/i;

function detailsOf(obj: Record<string, unknown>): string | null {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'err' || SENSITIVE.test(k)) continue;
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      parts.push(`${k}=${String(v).slice(0, 80)}`);
    }
  }
  return parts.length ? parts.join(' ') : null;
}

/** One line per link in the cause chain, outermost first. */
export function describeAuthError(error: unknown): string[] {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current) && lines.length < 6) {
    seen.add(current);
    // A plain object rather than an error: either Auth.js's `{ err, ...details }`
    // wrapper, or (from oauth4webapi) the bag of parameters that failed
    // validation. Print what is safe to print and follow whichever link it
    // has, rather than stringifying it to "[object Object]".
    if (!(current instanceof Error) && typeof (current as ErrorLike).message !== 'string') {
      const obj = current as Record<string, unknown>;
      const details = detailsOf(obj);
      if (details) lines.push(`with ${details}`);
      current = obj.err ?? obj.cause;
      continue;
    }
    const e = current as ErrorLike;
    // Auth.js errors carry their kind in `type`; jose errors carry a stable
    // `code` such as ERR_JWT_EXPIRED that survives message rewording.
    const name =
      typeof e.type === 'string' ? e.type : typeof e.name === 'string' ? e.name : 'Error';
    const code = typeof e.code === 'string' ? ` [${e.code}]` : '';
    const message = typeof e.message === 'string' ? e.message : String(current);
    lines.push(`${lines.length === 0 ? '' : 'caused by '}${name}${code}: ${message}`);
    current = e.cause;
  }
  if (lines.length === 0) lines.push(String(error));
  return lines;
}

/**
 * What an operator should do about it, for the causes seen in practice.
 *
 * Kept deliberately specific: a hint that could apply to anything is noise
 * next to the stack trace. Returns null when there is nothing useful to add.
 */
export function authErrorHint(lines: string[]): string | null {
  const text = lines.join('\n');
  if (/ERR_JWT_EXPIRED|"exp" claim/i.test(text)) {
    return (
      'The sign-in cookie had expired: Auth.js gives the OAuth round trip 15 minutes. ' +
      'The user most likely left the Google window open longer than that. Trying again works.'
    );
  }
  if (/no matching decryption secret|ERR_JWE_DECRYPTION_FAILED|decryption operation failed/i.test(text)) {
    return (
      'The cookie was encrypted with a different AUTH_SECRET than this process has. ' +
      'Either the secret was changed while sign-ins were in flight (set the old value as ' +
      'AUTH_SECRET_PREVIOUS so both decrypt), or more than one instance is running with ' +
      'different environment.'
    );
  }
  if (/different provider/i.test(text)) {
    return 'Sign-in was started with one provider and finished with another — two sign-ins overlapped.';
  }
  if (/cookie was missing/i.test(text)) {
    return (
      'The browser did not send the sign-in cookie back. Usually a cookie attribute mismatch ' +
      'behind the proxy (secure/host), or the callback was hit twice — the first hit clears it.'
    );
  }
  return null;
}
