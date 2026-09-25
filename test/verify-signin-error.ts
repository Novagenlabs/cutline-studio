// The page a failed sign-in lands on.
//
// Auth.js's default is "Server error — there is a problem with the server
// configuration", with no way to try again. Ours names what happened and
// retries in place. This checks the page is wired as Auth.js's error page,
// says the right thing for each error code, tells a popup from a tab by the
// cookie Auth.js set when the sign-in started, and carries the retry.
const BASE = process.env.APP_URL ?? 'http://localhost:3000';

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? 'ok ' : 'FAIL'}  ${msg}`);
  if (!ok) fails++;
};

(async () => {
  console.log('--- the page exists and offers a way forward ---');
  const conf = await fetch(`${BASE}/signin-error?error=Configuration`);
  const html = await conf.text();
  check(conf.status === 200, `answers 200 (got ${conf.status})`);
  check(html.includes('Sign-in did not complete'), 'says the sign-in did not complete');
  check(html.includes('15 minutes'), 'names the 15-minute window as the usual reason');
  check(html.includes('id="retry"'), 'has a Try again control');
  check(html.includes("form.action = '/api/auth/signin/google'"), 'the retry is a real sign-in POST');
  check(html.includes('/api/auth/csrf'), 'and fetches a CSRF token first');
  check(!/server configuration/i.test(html), 'and never blames the server configuration');

  console.log('\n--- each error code gets its own words ---');
  const denied = await (await fetch(`${BASE}/signin-error?error=AccessDenied`)).text();
  check(denied.includes('cancelled'), 'AccessDenied reads as a cancellation');
  const verify = await (await fetch(`${BASE}/signin-error?error=Verification`)).text();
  check(verify.includes('expired'), 'Verification reads as an expired link');
  const none = await (await fetch(`${BASE}/signin-error`)).text();
  check(none.includes('Sign-in did not complete'), 'no code still gets a sensible page');

  console.log('\n--- it knows whether it is in the popup ---');
  // Auth.js records the requested callbackUrl in a cookie when a sign-in
  // starts; the popup flow asks for /signin-done. That cookie, not
  // window.opener or window.name, is what the page reads.
  check(html.includes('data-popup="0"'), 'a plain tab is not treated as the popup');
  check(html.includes('Back to the studio'), 'and is offered the studio');
  const inPopup = await (
    await fetch(`${BASE}/signin-error?error=Configuration`, {
      headers: { cookie: `authjs.callback-url=${encodeURIComponent(`${BASE}/signin-done`)}` },
    })
  ).text();
  check(inPopup.includes('data-popup="1"'), 'a sign-in that started in the popup is recognised');
  check(inPopup.includes('Close this window'), 'and is offered a close instead of the studio');
  check(!inPopup.includes('Back to the studio'), 'never a link that would load the studio inside the popup');

  console.log("\n--- Auth.js sends failures here, not to its own page ---");
  // A callback with no cookies fails its state/PKCE check with exactly the
  // error class seen in production (InvalidCheck), which Auth.js reports to
  // the user as "Configuration". Where it redirects is what matters.
  const cb = await fetch(`${BASE}/api/auth/callback/google?code=x&state=y`, {
    redirect: 'manual',
  });
  const location = cb.headers.get('location') ?? '';
  check(cb.status >= 300 && cb.status < 400, `the callback redirects on failure (got ${cb.status})`);
  check(location.includes('/signin-error'), `to /signin-error (got ${location || '(none)'})`);
  check(location.includes('error=Configuration'), 'carrying the code the page has words for');
  check(!location.includes('/api/auth/error'), 'and not to the Auth.js default page');

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
