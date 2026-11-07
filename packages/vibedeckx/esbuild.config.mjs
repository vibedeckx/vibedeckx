import { build } from "esbuild";

await build({
  entryPoints: ["src/bin.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  outfile: "dist/bin.js",
  sourcemap: true,
  external: ["node-pty", "better-sqlite3"],
  banner: {
    js: "import { createRequire as __bundleRequire } from 'module';const require = __bundleRequire(import.meta.url);",
  },
});
