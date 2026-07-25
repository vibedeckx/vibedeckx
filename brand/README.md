# Vibedeckx brand icons

The **Stacked Deck** mark — two offset rounded squares (graphite back card, indigo
front card) with an optional green "live session" dot. Rendered here as 512×512
OAuth application icons.

The mark's geometry is the single source of truth in
[`apps/vibedeckx-ui/components/brand/logo.tsx`](../apps/vibedeckx-ui/components/brand/logo.tsx)
(`viewBox="0 0 64 64"`). These icons re-use those exact coordinates, centred in a
512 canvas at scale 6 (~22% clear space), on an optional rounded-square tile.

## Files

- `build-icons.mjs` — regenerates everything (`node brand/build-icons.mjs`).
- `svg/*.svg` — dependency-free design source, emitted by the script.
- `icons/*.png` — 512×512 rasters. The committed PNGs are the original renders
  first produced in June 2026; the script reproduces visually identical output
  (mean per-channel Δ ≈ 7/255 vs the originals — antialiasing only).

## Colour matrix

`back` = `fill-foreground`, `front` = `fill-primary` (Tailwind tokens), resolved to
the per-theme hex each variant was rendered with. Stripes are white @ 22% over the
front card; the dot is `#10b981` (emerald-500) with a 25% glow.

| Variant            | tile background | back card | front card |
| ------------------ | --------------- | --------- | ---------- |
| `logo-transparent` | — (transparent) | `#0e1117` | `#3d5ccf`  |
| `logo-light-tile`  | `#fbfcfe`       | `#0e1117` | `#3d5ccf`  |
| `logo-dark-tile`   | `#090c11`       | `#f0f2f6` | `#5b83ff`  |
| `logo-indigo-tile` | `#3d5ccf`       | `#fbfcfe` | `#f0f2f6`  |

## Regenerating

```bash
node brand/build-icons.mjs
```

`sharp` (a transitive monorepo dependency) is resolved from the pnpm store at
runtime to rasterize the PNGs. If it is unavailable the SVGs are still written and
you can rasterize with any SVG tool, e.g.:

```bash
rsvg-convert -w 512 -h 512 brand/svg/logo-dark-tile.svg -o brand/icons/logo-dark-tile.png
```
