// What the log says when a sign-in fails.
//
// The production log showed "InvalidCheck: pkceCodeVerifier value could not
// be parsed" and a stack, and nothing else — because Auth.js attaches the
// real error as `cause` and its default logger only prints a cause that has
// an `err` property. One message, three possible problems, no way to tell.
// These pin down that the cause chain and a usable hint reach the log, and
// that nothing secret does.
import { describe, it, expect } from 'vitest';
import { describeAuthError, authErrorHint } from '../src/lib/auth-log';

// Shaped like the real thing: Auth.js's InvalidCheck (an AuthError with
// `type`) wrapping a jose error (with a stable `code`).
function invalidCheck(cause: Error): Error {
  const e = new Error('pkceCodeVerifier value could not be parsed', { cause });
  e.name = 'InvalidCheck';
  (e as { type?: string }).type = 'InvalidCheck';
  return e;
}
function jose(code: string, message: string): Error {
  const e = new Error(message);
  e.name = code === 'ERR_JWT_EXPIRED' ? 'JWTExpired' : 'JWEDecryptionFailed';
  (e as { code?: string }).code = code;
  return e;
}

describe('naming the real cause of an auth error', () => {
  it('prints the cause chain, not just the wrapper', () => {
    const lines = describeAuthError(
      invalidCheck(jose('ERR_JWT_EXPIRED', '"exp" claim timestamp check failed')),
    );
    expect(lines[0]).toBe('InvalidCheck: pkceCodeVerifier value could not be parsed');
    expect(lines[1]).toBe(
      'caused by JWTExpired [ERR_JWT_EXPIRED]: "exp" claim timestamp check failed',
    );
  });

  it('tells an expired cookie from a wrong secret', () => {
    // The two most likely reasons behind the reported failure, with opposite
    // fixes: one is the user's timing, the other is the deployment.
    const expired = authErrorHint(
      describeAuthError(invalidCheck(jose('ERR_JWT_EXPIRED', '"exp" claim timestamp check failed'))),
    );
    const wrongSecret = authErrorHint(
      describeAuthError(invalidCheck(new Error('no matching decryption secret'))),
    );
    expect(expired).toMatch(/15 minutes/);
    expect(wrongSecret).toMatch(/AUTH_SECRET/);
    expect(expired).not.toEqual(wrongSecret);
  });

  it('names the rotation escape hatch in the wrong-secret hint', () => {
    const hint = authErrorHint(
      describeAuthError(invalidCheck(jose('ERR_JWE_DECRYPTION_FAILED', 'decryption operation failed'))),
    );
    expect(hint).toContain('AUTH_SECRET_PREVIOUS');
  });

  it('steps into the { err, ...details } wrapper the callback route uses', () => {
    // Seen live: a failed callback is wrapped as CallbackRouteError with
    // cause { err, provider: 'google' } — an object, not an error — and the
    // first version of this printed "caused by Error: [object Object]".
    const inner = invalidCheck(jose('ERR_JWT_EXPIRED', '"exp" claim timestamp check failed'));
    const outer = new Error('Read more at https://errors.authjs.dev#callbackrouteerror', {
      cause: { err: inner, provider: 'google', code: 'MUST-NOT-APPEAR' },
    });
    outer.name = 'CallbackRouteError';
    (outer as { type?: string }).type = 'CallbackRouteError';

    const lines = describeAuthError(outer);
    const text = lines.join('\n');
    expect(text).not.toContain('[object Object]');
    expect(text).toContain('with provider=google');
    expect(text).toContain('InvalidCheck: pkceCodeVerifier value could not be parsed');
    expect(text).toContain('ERR_JWT_EXPIRED');
    // Context keys that look like secrets are dropped, whatever they hold.
    expect(text).not.toContain('MUST-NOT-APPEAR');
    // And the hint still finds the root cause through the wrapper.
    expect(authErrorHint(lines)).toMatch(/15 minutes/);
  });

  it('does not print a parameter bag as [object Object], nor its contents', () => {
    // oauth4webapi attaches the callback parameters it rejected as `cause`
    // — a plain object holding the authorization code and state, neither of
    // which belongs in a log.
    const inner = new Error('response parameter "iss" (issuer) missing', {
      cause: { code: 'AUTHCODE-MUST-NOT-APPEAR', state: 'STATE-MUST-NOT-APPEAR' },
    });
    inner.name = 'OperationProcessingError';
    const text = describeAuthError(inner).join('\n');
    expect(text).toContain('response parameter "iss" (issuer) missing');
    expect(text).not.toContain('[object Object]');
    expect(text).not.toContain('MUST-NOT-APPEAR');
  });

  it('stays quiet when it has nothing specific to say', () => {
    expect(authErrorHint(describeAuthError(new Error('something else entirely')))).toBeNull();
  });

  it('survives cycles and non-errors', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(describeAuthError(b).length).toBeLessThanOrEqual(6);
    expect(describeAuthError('just a string')).toEqual(['just a string']);
    expect(describeAuthError(undefined)).toEqual(['undefined']);
  });

  it('never includes a token that happens to be on the error object', () => {
    // jose messages describe the failure, not the material; make sure the
    // formatter does not go looking for more than name, code and message.
    const e = jose('ERR_JWT_EXPIRED', '"exp" claim timestamp check failed');
    (e as { token?: string }).token = 'eyJhbGciOi.SECRETMATERIAL.xyz';
    const text = describeAuthError(invalidCheck(e)).join('\n');
    expect(text).not.toContain('SECRETMATERIAL');
  });
});
