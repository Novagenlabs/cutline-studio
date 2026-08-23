import { NextResponse, type NextRequest } from 'next/server';

/**
 * CORS for the cutter front-end.
 *
 * The cutter and the account server are separate origins in development
 * (Vite on 5173, Next on 3000) and may stay separate in production if the
 * app is served from its own domain. Credentialed requests are what carry
 * the session cookie, and the spec forbids `Access-Control-Allow-Origin: *`
 * with credentials — so the origin is echoed back, but ONLY when it is on
 * the allow-list. Echoing an arbitrary Origin would let any website on the
 * internet spend a signed-in user's credits.
 */
const ALLOWED = new Set(
  (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

export function middleware(req: NextRequest) {
  const origin = req.headers.get('origin');

  // Same-origin requests carry no Origin header and need no CORS handling.
  if (!origin) return NextResponse.next();

  if (!ALLOWED.has(origin)) {
    // Not an error for ordinary navigation; the browser simply will not hand
    // the response to a disallowed origin's script.
    return NextResponse.next();
  }

  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    // The client reads these off a successful export.
    'Access-Control-Expose-Headers': 'x-credits-remaining, x-download-id, content-disposition',
    Vary: 'Origin',
  };

  if (req.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers });
  }

  const res = NextResponse.next();
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

export const config = { matcher: '/api/:path*' };
