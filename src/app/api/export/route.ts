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

const Pt = z.object({ x: z.number().finite(), y: z.number().finite() });

const Body = z.object({
  format: z.enum(['SVG', 'PDF', 'DXF', 'PNG']),
  /**
   * Cut geometry in SOURCE PIXELS — the same units the shared builders use,
   * so the server renders from exactly what the preview drew.
   */
  rings: z.array(z.array(Pt).min(3)).min(1).max(20_000),
  beziers: z.array(z.array(z.tuple([Pt, Pt, Pt, Pt]))).min(1).max(20_000),
  svgPath: z.string().min(1).max(20_000_000),
  cutBbox: z.object({
    x: z.number().finite(), y: z.number().finite(),
    w: z.number().positive(), h: z.number().positive(),
  }),
  srcW: z.number().int().positive().max(30_000),
  srcH: z.number().int().positive().max(30_000),
  dpi: z.number().int().min(72).max(2400),
  spotName: z.string().min(1).max(64).regex(/^[\w -]+$/),
  halo: z.boolean(),
  /**
   * ASCII-safe name, used verbatim in the `filename=` parameter of
   * Content-Disposition. The regex is what keeps a quote or a newline out of
   * a response header, so it stays strict; the client sanitises to match.
   */
  filenameBase: z.string().min(1).max(120).regex(/^[\w. -]+$/),
  /**
   * The name as the user actually knows it, accents and all.
   *
   * RFC 6266 exists for exactly this: `filename*=UTF-8''…` carries the real
   * name while `filename=` stays ASCII for clients too old to read it. Every
   * character is percent-encoded on the way into the header, so this does not
   * need — and must not have — the strict regex above.
   */
  filenameDisplay: z.string().min(1).max(200).optional(),
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
  // Every field that changes the delivered file is in the hash. The artwork
  // is deliberately excluded: it can be tens of megabytes, hashing it twice
  // per export is real cost, and swapping it cannot turn one paid download
  // into two — the credit is charged either way.
  const authRequest = {
    format: body.format,
    svgPath: body.svgPath,
    rings: body.rings,
    beziers: body.beziers,
    cutBbox: body.cutBbox,
    srcW: body.srcW,
    srcH: body.srcH,
    dpi: body.dpi,
    spotName: body.spotName,
    halo: body.halo,
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

  const filename = `${body.filenameBase}.${file.ext}`;

  /**
   * Content-Disposition, per RFC 6266.
   *
   * Two parameters, deliberately: `filename=` is the ASCII fallback and
   * `filename*=` is the real name, percent-encoded as UTF-8. Browsers that
   * understand the second prefer it, which is how "Müller.svg" arrives in the
   * Downloads folder spelled the way its owner spells it rather than as
   * "M-ller.svg".
   *
   * encodeURIComponent leaves !'()* alone and those are not valid in the
   * ext-value grammar, so they are escaped too. Everything reaching the
   * header is therefore percent-encoded or an unreserved ASCII character —
   * there is no input that can close the quote or inject a newline.
   */
  const displayName = body.filenameDisplay
    ? `${body.filenameDisplay}.${file.ext}`
    : filename;
  const encoded = encodeURIComponent(displayName).replace(
    /['()!*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
  const disposition =
    `attachment; filename="${filename}"; filename*=UTF-8''${encoded}`;

  let downloadId: string;
  let balance: number;
  try {
    ({ downloadId, balance } = await redeemExportToken(db, {
      token,
      userId,
      request: authRequest,
      file: { bytes: file.bytes.byteLength, sha256: shaOf(file.bytes), filename },
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

  // The provenance marker names the download, which only exists once the
  // credit is charged. SVG and DXF carry it in a comment, so they are rebuilt
  // now that the id is known — cheap for text formats, and it keeps the
  // render-before-charge order that makes a failed export free. PDF and PNG
  // are delivered as first rendered rather than paying to rasterise twice.
  let delivered = file.bytes;
  if (body.format === 'SVG' || body.format === 'DXF') {
    try {
      delivered = (await renderExport(body, downloadId)).bytes;
      // The Download row must record what the user actually received.
      await db.download.update({
        where: { id: downloadId },
        data: { bytes: delivered.byteLength, sha256: shaOf(delivered) },
      });
    } catch {
      // Stamping is a nice-to-have; never fail a paid download over it.
      delivered = file.bytes;
    }
  }

  return new NextResponse(delivered as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': file.mime,
      'Content-Disposition': disposition,
      'Content-Length': String(delivered.byteLength),
      'Cache-Control': 'no-store',
      'X-Credits-Remaining': String(balance),
      'X-Download-Id': downloadId,
    },
  });
}

const shaOf = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
