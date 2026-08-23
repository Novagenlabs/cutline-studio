/**
 * Fixed-window limiter, in-process.
 *
 * Adequate for a single instance. If the app is ever run on more than one
 * node this must move to Redis, since per-process counters let a user get
 * `limit x instances` requests through. Noted here rather than discovered in
 * production. This bounds abuse; it is not what enforces payment.
 */
const windows = new Map<string, { count: number; resetAt: number }>();

export async function rateLimit(
  key: string,
  opts: { max: number; windowMs: number }
): Promise<{ ok: boolean; resetMs: number }> {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || now >= w.resetAt) {
    windows.set(key, { count: 1, resetAt: now + opts.windowMs });
    return { ok: true, resetMs: opts.windowMs };
  }
  w.count++;
  return { ok: w.count <= opts.max, resetMs: w.resetAt - now };
}

// Keep the map from growing without bound in a long-lived process.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of windows) if (now >= v.resetAt) windows.delete(k);
}, 60_000).unref?.();
