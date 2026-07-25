// Regenerate the Vibedeckx "Stacked Deck" brand icons (OAuth app icons).
//
// Geometry mirrors apps/vibedeckx-ui/components/brand/logo.tsx (viewBox 0 0 64 64),
// centred in a 512×512 canvas at scale 6 (~22% clear space). Colours below are the
// theme tokens sampled from the original dev5 renders — see README.md for the matrix.
//
// Run:  node brand/build-icons.mjs
// Out:  brand/svg/*.svg  (dependency-free design source)
//       brand/icons/*.png (512×512, via sharp if available)
//
// sharp is a transitive dep in this monorepo (not hoisted); it is resolved from the
// pnpm store at runtime. If unavailable, SVGs are still written — rasterize them with
// any SVG tool (e.g. `rsvg-convert -w 512 -h 512 in.svg -o out.png`).

import { writeFile, mkdir } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const OUT_SVG = join(HERE, "svg");
const OUT_PNG = process.env.ICON_OUT || join(HERE, "icons");
const SIZE = 512;
const TILE_RADIUS = 112; // rounded-square corner, iOS-style superellipse approximation

const DOT = "#10b981"; // emerald-500 — "live session" indicator

// back = fill-foreground, front = fill-primary (Tailwind tokens in logo.tsx),
// resolved to the per-theme hex the original icons were rendered with.
const VARIANTS = {
  "logo-transparent": { tile: null, back: "#0e1117", front: "#3d5ccf" },
  "logo-light-tile": { tile: "#fbfcfe", back: "#0e1117", front: "#3d5ccf" },
  "logo-dark-tile": { tile: "#090c11", back: "#f0f2f6", front: "#5b83ff" },
  "logo-indigo-tile": { tile: "#3d5ccf", back: "#fbfcfe", front: "#f0f2f6" },
};

function svg({ tile, back, front }) {
  const bg = tile
    ? `  <rect width="${SIZE}" height="${SIZE}" rx="${TILE_RADIUS}" fill="${tile}"/>\n`
    : "";
  // The <g> reuses the exact 64-unit coordinates from logo.tsx.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
${bg}  <g transform="translate(58 52) scale(6)">
    <rect x="10" y="22" width="36" height="36" rx="8" fill="${back}"/>
    <rect x="20" y="10" width="36" height="36" rx="8" fill="${front}"/>
    <rect x="26" y="20" width="22" height="3" rx="1.5" fill="#fff" fill-opacity="0.22"/>
    <rect x="26" y="26" width="14" height="3" rx="1.5" fill="#fff" fill-opacity="0.22"/>
    <circle cx="50" cy="14" r="5" fill="${DOT}" fill-opacity="0.25"/>
    <circle cx="50" cy="14" r="3" fill="${DOT}"/>
  </g>
</svg>
`;
}

function loadSharp() {
  const require = createRequire(import.meta.url);
  try {
    return require("sharp");
  } catch {}
  try {
    const store = join(REPO, "node_modules/.pnpm");
    const pkg = readdirSync(store).find((d) => d.startsWith("sharp@"));
    if (pkg) return require(join(store, pkg, "node_modules/sharp"));
  } catch {}
  return null;
}

await mkdir(OUT_SVG, { recursive: true });
await mkdir(OUT_PNG, { recursive: true });
const sharp = loadSharp();

for (const [name, v] of Object.entries(VARIANTS)) {
  const markup = svg(v);
  await writeFile(join(OUT_SVG, `${name}.svg`), markup);
  if (sharp) {
    await sharp(Buffer.from(markup)).png().toFile(join(OUT_PNG, `${name}.png`));
    console.log(`✓ ${name}  (svg + png)`);
  } else {
    console.log(`✓ ${name}  (svg only)`);
  }
}

if (!sharp) {
  console.log(
    "\n! sharp not found — SVGs written, PNGs skipped.\n" +
      "  Rasterize with e.g.: rsvg-convert -w 512 -h 512 brand/svg/NAME.svg -o brand/icons/NAME.png",
  );
}
