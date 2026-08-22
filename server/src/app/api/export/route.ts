import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import {
  COST_PER_DOWNLOAD,
  InsufficientCredits,
  InvalidExportToken,
  issueExportToken,
  redeemExportToken,
} from '@/lib/credits';
import { renderExport } from '@/lib/render';
import { rateLimit } from '@/lib/rate-limit';

/**
 * Paid export.
 *
 * This route is the entire enforcement boundary. The browser can preview a
 * cutline all day for free, but the deliverable file is produced here and
 * only after a credit is charged, because anything the client can generate
 * the client already has. Moving generation here is what makes the paywall
 * real rather than advisory.
 */

const Body = z.object({
  format: z.enum(['SVG', 'PDF', 'DXF', 'PNG']),
  /** Cut geometry in mm, computed client-side and sent for rendering. */
  beziers: z.array(z.array(z.tuple([
    z.tuple([z.number(), z.number()]), z.tuple([z.number(), z.number()]),
    z.tuple([z.number(), z.number()]), z.tuple([z.number(), z.number()]),
  ]))).min(1).max(20_000),
  widthMm: z.number().positive().max(5000),
  heightMm: z.number().positive().max(5000),
  dpi: z.number().int().min(72).max(2400),
  filenameBase: z.string().min(1).max(120).regex(/^[\w. -]+$/),
  /**
   * Source artwork, needed only by the formats that embed a raster (PDF, PNG).
   * Held in memory for the render and never written to disk or logged, so the
   * "artwork stays on your machine" promise only relaxes at the moment of a
   * paid download, and only for the formats that cannot be built without it.
   */
  imageDataUrl: z.string().startsWith('data:image/').max(48_000_000).optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Sign in to download.' }, { status: 401 });
  }
  const userId = session.user.id;

  // Bound how fast one account can burn credits or hammer the renderer. This
  // is abuse control, not the paywall — the ledger is what stops overspending.
  const limited = await rateLimit(`export:${userId}`, { max: 30, windowMs: 60_000 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: 'Too many exports, try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(limited.resetMs / 1000)) } }
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Malformed export request.' }, { status: 400 });
  }
  const body = parsed.data;

  if ((body.format === 'PDF' || body.format === 'PNG') && !body.imageDataUrl) {
    return NextResponse.json(
      { error: `${body.format} needs the artwork to embed.` },
      { status: 400 }
    );
  }

  // The token binds this authorisation to this exact request, so it cannot be
  // spent on a different (larger) job than the one that was checked.
  const authRequest = {
    format: body.format,
    beziers: body.beziers,
    widthMm: body.widthMm,
    heightMm: body.heightMm,
    dpi: body.dpi,
  };

  let token: string;
  try {
    ({ token } = await issueExportToken(db, userId, body.format, authRequest));
  } catch (e) {
    if (e instanceof InsufficientCredits) {
      return NextResponse.json(
        { error: 'Out of credits.', balance: e.balance, needed: COST_PER_DOWNLOAD },
        { status: 402 }
      );
    }
    throw e;
  }

  // Render before charging: a failure here leaves the token unredeemed and
  // the user's balance untouched, so a broken export never costs a credit.
  let file: { bytes: Uint8Array; mime: string; ext: string };
  try {
    file = await renderExport(body);
  } catch {
    return NextResponse.json({ error: 'Could not generate that file.' }, { status: 500 });
  }

  const sha256 = createHash('sha256').update(file.bytes).digest('hex');
  const filename = `${body.filenameBase}.${file.ext}`;

  let downloadId: string;
  let balance: number;
  try {
    ({ downloadId, balance } = await redeemExportToken(db, {
      token,
      userId,
      request: authRequest,
      file: { bytes: file.bytes.byteLength, sha256, filename },
      ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
      userAgent: req.headers.get('user-agent') ?? undefined,
    }));
  } catch (e) {
    if (e instanceof InsufficientCredits) {
      return NextResponse.json({ error: 'Out of credits.', balance: e.balance }, { status: 402 });
    }
    if (e instanceof InvalidExportToken) {
      return NextResponse.json({ error: 'Export authorisation expired.' }, { status: 409 });
    }
    throw e;
  }

  return new NextResponse(file.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': file.mime,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(file.bytes.byteLength),
      'Cache-Control': 'no-store',
      'X-Credits-Remaining': String(balance),
      'X-Download-Id': downloadId,
    },
  });
}
