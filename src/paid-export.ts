import type { CutlineResult } from './pipeline/types';

/**
 * Paid export: ask the server for the file.
 *
 * The browser deliberately does NOT build the deliverable any more. It can
 * compute the cutline — that is the preview, and it stays local and instant —
 * but the file a customer pays for is generated server-side after a credit is
 * charged. Building it here and then checking a balance would be theatre: the
 * artifact would already exist in the page, one DevTools breakpoint away.
 *
 * Artwork is sent only for the formats that must embed it (PDF, PNG). SVG and
 * DXF carry geometry alone, so for those the customer's image never leaves
 * their machine at all.
 */

export type PaidFormat = 'SVG' | 'PDF' | 'DXF' | 'PNG';

/**
 * Make a filename the export route will accept.
 *
 * The name comes from whatever file the user opened, and the server validates
 * it against /^[\w. -]+$/ — so "logo (1).png", "Müller.png" or "design#2.png"
 * all produced a flat "Malformed export request." with nothing to say which
 * field was wrong. The paid path failing on a perfectly ordinary filename is
 * as bad as a bug gets: the user has already decided to pay.
 *
 * Sanitised here rather than loosening the server's rule, because that rule is
 * what keeps a filename out of a Content-Disposition header it could break.
 * Runs of rejected characters collapse to a single dash so "a (1)" does not
 * become "a---1-".
 */
export function safeFilenameBase(base: string): string {
  const cleaned = base
    .normalize('NFKD')
    // Strip combining marks, so accented letters degrade to their base form
    // rather than to a dash: "Müller" reads better as "Muller" than "M-ller".
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w. -]+/g, '-')
    // Spaces are legal, but a space that ends up beside a substituted dash
    // reads as a typo: "logo (1)" would otherwise become "logo -1". Collapse
    // any run of spaces and dashes into the single dash it stands for.
    .replace(/[-\s]{2,}/g, '-')
    .replace(/^[-.\s]+|[-.\s]+$/g, '')
    .slice(0, 100);
  return `${cleaned || 'cutline'}-cut`;
}

export interface ExportContext {
  result: CutlineResult;
  srcW: number;
  srcH: number;
  dpi: number;
  spotName: string;
  halo: boolean;
  fileBase: string;
  imageDataUrl?: string;
}

export class ExportError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'credits' | 'rate' | 'server',
    readonly balance?: number
  ) {
    super(message);
    this.name = 'ExportError';
  }
}

// One app, one origin: the API is served by the same server as this page.
const API = '';

const EXT: Record<PaidFormat, string> = { SVG: 'svg', PDF: 'pdf', DXF: 'dxf', PNG: 'png' };

export async function requestExport(
  format: PaidFormat,
  ctx: ExportContext
): Promise<{ filename: string; creditsRemaining: number | null }> {
  // SVG carries the artwork too. A print-and-cut SVG is an artwork layer
  // plus a stroke-only cut layer; sending only the geometry produced files
  // containing a magenta outline around nothing. DXF is the sole vector
  // format that genuinely needs no raster — it is cut-only by design, which
  // is why it alone keeps the artwork on the user's machine.
  const needsArtwork = format !== 'DXF';

  const res = await fetch(`${API}/api/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // The session cookie is what identifies the account; without this the
    // request is anonymous and the server rightly refuses it.
    credentials: 'include',
    body: JSON.stringify({
      format,
      rings: ctx.result.rings,
      beziers: ctx.result.beziers,
      svgPath: ctx.result.svgPath,
      cutBbox: ctx.result.bbox,
      srcW: ctx.srcW,
      srcH: ctx.srcH,
      dpi: ctx.dpi,
      spotName: ctx.spotName,
      halo: ctx.halo,
      filenameBase: safeFilenameBase(ctx.fileBase),
      // The name as the user knows it. The server puts this in the RFC 6266
      // `filename*=` parameter so the download keeps its accents and spaces,
      // with filenameBase above as the ASCII fallback.
      filenameDisplay: `${ctx.fileBase}-cut`.slice(0, 200),
      imageDataUrl: needsArtwork ? ctx.imageDataUrl : undefined,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    const msg = typeof body.error === 'string' ? body.error : 'Export failed.';
    if (res.status === 401) throw new ExportError(msg, 'auth');
    if (res.status === 402) {
      throw new ExportError(msg, 'credits', typeof body.balance === 'number' ? body.balance : 0);
    }
    if (res.status === 429) throw new ExportError(msg, 'rate');
    // A 400 is never the user's fault: the browser builds this body itself,
    // so a rejected one means the client sent something the server's schema
    // does not allow — which is a bug here, not a problem with their file.
    // Saying "malformed request" to someone who just clicked Export tells
    // them nothing they can act on, and nothing was charged either way.
    if (res.status === 400) {
      console.error('Export request rejected by the server schema', body);
      throw new ExportError(
        'Something went wrong preparing that export. Nothing was charged — please try again.',
        'server'
      );
    }
    throw new ExportError(msg, 'server');
  }

  const blob = await res.blob();
  const filename = filenameFrom(res.headers.get('content-disposition')) ??
    `${ctx.fileBase}-cut.${EXT[format]}`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);

  const remaining = res.headers.get('x-credits-remaining');
  return { filename, creditsRemaining: remaining === null ? null : Number(remaining) };
}

/**
 * Read the filename the server chose, preferring the UTF-8 form.
 *
 * RFC 6266 sends both: `filename=` for old clients and `filename*=UTF-8''…`
 * with the real name percent-encoded. Reading only the first would throw away
 * the accents the second exists to carry — the browser itself prefers
 * `filename*`, so parsing only `filename=` here would also mean the name in
 * the download bar and the name this function reports disagree.
 */
function filenameFrom(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // A malformed encoding is not worth failing a paid download over; fall
      // through to the ASCII parameter.
    }
  }
  const plain = /filename="([^"]+)"/.exec(header);
  return plain ? plain[1] : null;
}

/** Credits a new account is given, as reported by the server. */
export let signupGrant = 0;

/** Current balance, or null when signed out. */
export async function fetchBalance(): Promise<number | null> {
  try {
    const res = await fetch(`${API}/api/me`, { credentials: 'include' });
    if (!res.ok) return null;
    const body = await res.json();
    if (typeof body.signupGrant === 'number') signupGrant = body.signupGrant;
    return typeof body.balance === 'number' ? body.balance : null;
  } catch {
    return null;
  }
}
