# Cutline Studio

A web app that auto-generates **cutlines / cut contours** from artwork —
the job you'd otherwise do by hand in Adobe Illustrator (Image Trace → Offset Path →
Simplify → spot-color stroke) or CorelDRAW (Boundary → Contour → Break Apart).
Built for print-and-cut workflows: stickers, vinyl decals, kiss-cut sheets, DTF transfers.

## Run it

```sh
npm install
cp .env.example .env   # DATABASE_URL, AUTH_SECRET, Google + Stripe keys
npx prisma db push
npm run dev            # http://localhost:3000
npm run smoke          # headless pipeline test (node, no browser)
npm test               # server suites (needs DATABASE_URL)
```

One app. Next serves the cutter at `/`, the account at `/account`, and the
API at `/api/*`.

**Tracing runs in your browser** — artwork is not uploaded to preview a
cutline, and the preview is instant because nothing round-trips. **Cut files
are generated on the server** after a credit is charged: a file the browser
can build is a file the browser already has, so the only way to actually gate
a download is to not build it there. SVG and DXF need geometry alone, so for
those the artwork still never leaves your machine; PDF and PNG must embed the
raster, so it is sent at that moment and held only in memory.

See BACKEND.md for the credit ledger and payment design.

## What it does

Drop in a PNG (transparent) or JPG (flat or gradient background) and it:

1. **Extracts a mask** — alpha threshold, or edge flood-fill background removal for
   opaque images (modal border-color estimate, tunable global tolerance, plus a
   local-continuity rule so gradients, vignettes, and JPEG mottle fill cleanly)
2. **Cleans it** — 3×3 morphological open/close, drops sub-1mm² islands and pinholes
3. **Offsets it** — exact euclidean distance transform (Felzenszwalb–Huttenlocher),
   thresholded at the offset distance. This is dilation by a true disk, so disjoint
   elements **merge automatically** when their offset bands touch, small holes fill
   themselves, and convex corners come out perfectly round. The EDT is cached, so
   dragging the offset slider re-renders in tens of ms
4. **Traces it** — marching squares (d3-contour) with subpixel interpolation on the
   distance field
5. **Enforces a minimum concave corner radius** — polygon closing (offset +r/−r, round
   joins) via Clipper, because drag-knife blades can't articulate sharp inside corners
6. **Smooths it** — Ramer–Douglas–Peucker → Chaikin corner cutting → Schneider
   cubic-bezier fitting (fit-curve), so plotters get a few dozen smooth curves instead
   of thousands of polyline vertices

Alternative die shapes (rectangle / rounded / circle) are derived from the contour's
extent. Interior holes are dropped by default (sticker behavior) or kept for decals.

## Exports

| Format | For | Notes |
|---|---|---|
| **PDF** | Roland VersaWorks, ONYX, Flexi, Caldera | Cutline stroked in a *true* `/Separation` spot color (default name `CutContour`, exact-match as RIPs require), 0.25pt, overprint on, magenta alternate. Hand-rolled colorspace — no JS PDF lib supports spot colors natively |
| **SVG** | Cricut Design Space, laser cutters, editing | Artwork layer + stroke-only cutline layer, physical mm dimensions |
| **DXF** | Silhouette Studio (free edition), plotters | Cut path only, R12 polylines, mm, named layer |
| **PNG** | Print-then-cut | Flattened artwork with the white halo baked in, transparent outside |
| **JPG** | Print-shop proofs | Same, composited on white (JPEG has no alpha) |

Kiss cut vs die cut switches the spot name (`CutContour` / `PerfCutContour`); the name
is editable for other RIP conventions (`CutPath`, `Thru-cut`, …).

## Defaults (from print-industry practice)

- Offset 3 mm (typical sticker white border is 1.5–3 mm)
- Min corner radius 1 mm (blade swivel offset ~0.25–0.5 mm)
- Alpha threshold 128, background tolerance 32 RGB-euclidean
- 300 DPI px↔mm mapping, work resolution capped at 1600 px (cut precision beyond that
  is below blade tolerance)

## Stack

Vite + TypeScript, no framework. `d3-contour` (trace), `clipper-lib` (corner-radius
closing — pure JS, no WASM), `simplify-js` + `fit-curve` (smoothing), `pdf-lib`
(spot-color PDF), `dxf-writer`. All permissive licenses (potrace/imgly were rejected
as GPL/AGPL). ~220 KB gzipped total.
