# vgpu `nextjs-flare`, vendored

Pulled verbatim with:

```sh
npx vgpu examples pull nextjs-flare --out ./nextjs-flare
```

    revision        03c90029dab29b1b7ab20338ee715337454515e4df7006b96b863941c45eb6aa
    aggregateSha256 76bc941f6fb8252833f25c000814193c71be3f6c307b1ffccb68e4059013293f
    vgpu            0.4.1

## What this is

A rim-lit glyph with volumetric scattering: a 48-step ray walk jittered by
blue noise, over a separable Gaussian blur chain, composited back over the
logo. `renderer.ts` owns the frame loop, the resize handling and the teardown;
`pipeline.ts` owns the GPU resources and the four WGSL passes.

## What was changed, and why

Kept byte-for-byte: `blur.wgsl`, `composite.wgsl`, `logo.wgsl`, `rim.wgsl`,
`blue-noise-128.ts`, `renderer.ts`, `pipeline.ts`. The rendering behaviour and
the disposal contract are the example's, unmodified — `renderer.dispose()`
still runs the same cleanup list (abort the raster, cancel the frame,
disconnect the observer, drop the listeners, dispose the GPU).

Two files differ:

- **`logo-raster.ts`** — rasterises our artwork instead of the Next.js "N".
  This is the one file that is *supposed* to change: it exists to turn a logo
  into a canvas, and ours is a different logo. The exported signature
  (`rasterizeLogo(size, signal)`) and the abort handling are unchanged.
- **`index.tsx`** — not vendored. It is a React `useEffect` wrapper, and the
  splash mounts the renderer imperatively from plain TypeScript, so the
  wrapper would only add an indirection. The lifecycle it encodes (create on
  mount, `dispose()` on unmount) is honoured by `src/ui/splash.ts`.

`pipeline.ts` has one small addition. It carried three constants derived from
the old SVG's viewBox — `GLYPH_CENTER_IN_BOX`, `LOGO_HEIGHT_RATIO`, and the
`514 / 624` aspect inside `logoPixelSize`. They are consumed by
`centeredPlacement`, which `FlarePipeline.replace` calls internally, so they
cannot be supplied from outside; they are now `let` bindings with a
`setLogoGeometry()` setter. That is the only change to the module's API, and
nothing else in the file was touched.

Ours is a wide lockup (aspect ≈ 5.4) rather than a tall glyph, and the height
ratio drops from 0.62 to 0.16 — at the example's value the wordmark runs off
both edges of the canvas.

## Updating

Re-pull to `./nextjs-flare` (gitignored) and diff against this directory.
Expect conflicts in exactly two places: `logo-raster.ts`, which is ours by
design, and the geometry block at the top of `pipeline.ts`.
