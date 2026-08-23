// Does Google accept our redirect URI? Follows the same sign-in start the
// browser performs, then fetches Google's consent URL and reports what it says.
const BASE = 'http://localhost:3000';

const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
const setCookie = csrfRes.headers.getSetCookie?.() ?? [];
const { csrfToken } = await csrfRes.json();
const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');

const signin = await fetch(`${BASE}/api/auth/signin/google`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
  body: new URLSearchParams({ csrfToken, callbackUrl: `${BASE}/` }),
  redirect: 'manual',
});

const url = signin.headers.get('location');
if (!url || !url.startsWith('https://accounts.google.com')) {
  console.log('FAIL: did not reach Google. location =', url);
  process.exit(1);
}
const redirectUri = new URL(url).searchParams.get('redirect_uri');
console.log('redirect_uri sent to Google:', redirectUri);

const g = await fetch(url, { redirect: 'follow' });
const html = await g.text();
console.log('Google responded HTTP', g.status);

const problems = [
  ['redirect_uri_mismatch', 'REDIRECT URI NOT AUTHORISED — add it in Cloud Console'],
  ['invalid_client', 'CLIENT ID/SECRET wrong'],
  ['access_blocked', 'App blocked — check consent screen / test users'],
  ['deleted_client', 'OAuth client was deleted'],
];
const found = problems.filter(([needle]) => html.toLowerCase().includes(needle));

if (found.length) {
  for (const [, msg] of found) console.log('PROBLEM:', msg);
  process.exit(1);
}
// A working consent screen asks you to pick or sign in to an account.
const ok = /choose an account|sign in|accounts\.google\.com\/v3\/signin|passkey/i.test(html);
console.log(ok
  ? 'OK: Google presented the sign-in/consent screen — redirect URI is accepted.'
  : 'UNCLEAR: no known error, but no recognisable consent screen either.');
