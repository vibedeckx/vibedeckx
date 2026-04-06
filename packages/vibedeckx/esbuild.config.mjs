import { build } from "esbuild";

await build({
  entryPoints: ["src/bin.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  outfile: "dist/bin.js",
  sourcemap: true,
  external: ["node-pty", "better-sqlite3", "playwright-core"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
