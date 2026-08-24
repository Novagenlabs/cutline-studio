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
  const needsArtwork = format === 'PDF' || format === 'PNG';

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
      filenameBase: `${ctx.fileBase}-cut`,
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

function filenameFrom(header: string | null): string | null {
  if (!header) return null;
  const m = /filename="([^"]+)"/.exec(header);
  return m ? m[1] : null;
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
