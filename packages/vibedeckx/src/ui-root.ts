import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { VIBEDECKX_HOME } from "./constants.js";

const execFileAsync = promisify(execFile);

// The npm platform packages (@vibedeckx/<platform>) ship without dist/ui to keep
// remote-worker installs small; the UI lives in the separately published
// @vibedeckx/ui-dist package (same version, lockstep). The Docker/GitHub-release
// platform archives still bake dist/ui in, so those deployments never download.
//
// Resolution order:
//   1. --no-ui                          -> null (API-only)
//   2. --ui-dir / VIBEDECKX_UI_DIR      -> must be valid, else fail loudly
//   3. dist/ui next to the bundle       -> baked-in UI (archives, Docker, monorepo dev)
//   4. installed @vibedeckx/ui-dist     -> npm i -g @vibedeckx/ui-dist
//   5. ~/.vibedeckx/ui/<version>        -> previously downloaded cache
//   6. npm download of @vibedeckx/ui-dist@<version> into the cache
//   7. null (API-only, with guidance logged)

export interface ResolveUiRootOptions {
  uiDir?: string;
  noUi?: boolean;
  /** Skip the network download step (steps 1-5 still apply). */
  allowDownload?: boolean;
  /** Override the download implementation (tests). */
  download?: (version: string, cacheDir: string) => Promise<void>;
  /** Test seams — override the built-in locations. */
  bakedDir?: string;
  installedDir?: string | null;
  cacheRoot?: string;
  version?: string;
}

function hasIndexHtml(dir: string): boolean {
  return fs.existsSync(path.join(dir, "index.html"));
}

function ownPackageJson(): { version: string } {
  // Bundled: import.meta.url is <pkg>/dist/bin.js, so ../package.json is the
  // package root (works for the monorepo package and the platform packages,
  // which share the same dist/ layout). Running from src/ in tests resolves to
  // packages/vibedeckx/package.json the same way.
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return JSON.parse(fs.readFileSync(pkgPath, "utf8"));
}

function bakedUiDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "ui");
}

function installedUiDistDir(): string | null {
  try {
    // createRequire anchors resolution at the bundle's location, so a globally
    // installed @vibedeckx/ui-dist sibling package resolves from a global install.
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve("@vibedeckx/ui-dist/package.json");
    return path.join(path.dirname(pkgJsonPath), "ui");
  } catch {
    return null;
  }
}

async function defaultDownload(version: string, cacheDir: string): Promise<void> {
  const stagingDir = `${cacheDir}.staging-${process.pid}`;
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    const isWindows = process.platform === "win32";
    // npm verifies registry integrity (shasum/sha512) itself, so no manual
    // checksum step is needed. --ignore-scripts: the package is static assets.
    await execFileAsync(
      isWindows ? "npm.cmd" : "npm",
      [
        "install",
        `@vibedeckx/ui-dist@${version}`,
        "--prefix",
        stagingDir,
        "--no-save",
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
        "--loglevel=error",
      ],
      { shell: isWindows, timeout: 120_000 }
    );
    const uiSrc = path.join(stagingDir, "node_modules", "@vibedeckx", "ui-dist", "ui");
    if (!hasIndexHtml(uiSrc)) {
      throw new Error(`downloaded package is missing ui/index.html (${uiSrc})`);
    }
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
    fs.renameSync(uiSrc, cacheDir);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

export async function resolveUiRoot(opts: ResolveUiRootOptions = {}): Promise<string | null> {
  if (opts.noUi) {
    console.log("[UI] --no-ui set, serving API only");
    return null;
  }

  const explicit = opts.uiDir ?? process.env.VIBEDECKX_UI_DIR;
  if (explicit) {
    const dir = path.resolve(explicit);
    if (!hasIndexHtml(dir)) {
      // Explicit configuration that doesn't work should fail loudly, not fall
      // through to a different UI than the operator asked for.
      throw new Error(`UI directory ${dir} does not contain index.html (from --ui-dir/VIBEDECKX_UI_DIR)`);
    }
    console.log(`[UI] Serving from configured directory: ${dir}`);
    return dir;
  }

  const baked = opts.bakedDir ?? bakedUiDir();
  if (hasIndexHtml(baked)) {
    return baked;
  }

  const installed = opts.installedDir !== undefined ? opts.installedDir : installedUiDistDir();
  if (installed && hasIndexHtml(installed)) {
    console.log(`[UI] Serving from installed @vibedeckx/ui-dist: ${installed}`);
    return installed;
  }

  const version = opts.version ?? ownPackageJson().version;
  // The version is interpolated into an npm argv (shell:true on Windows) and a
  // filesystem path — accept plain semver-ish strings only.
  if (!/^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$/.test(version)) {
    console.error(`[UI] Refusing to download UI for unexpected version string: ${version}`);
    return null;
  }

  const cacheDir = path.join(opts.cacheRoot ?? path.join(VIBEDECKX_HOME, "ui"), version);
  if (hasIndexHtml(cacheDir)) {
    console.log(`[UI] Serving from cache: ${cacheDir}`);
    return cacheDir;
  }

  if (opts.allowDownload === false) {
    return null;
  }

  console.log(`[UI] UI assets not bundled; downloading @vibedeckx/ui-dist@${version} (one-time, cached in ${cacheDir})...`);
  try {
    await (opts.download ?? defaultDownload)(version, cacheDir);
    console.log(`[UI] Download complete: ${cacheDir}`);
    return cacheDir;
  } catch (err) {
    console.error(
      `[UI] Failed to download @vibedeckx/ui-dist@${version}: ${err instanceof Error ? err.message : err}\n` +
        "The server will run API-only. To serve the web UI, either:\n" +
        `  - retry when the npm registry is reachable, or\n` +
        `  - npm install -g @vibedeckx/ui-dist@${version}, or\n` +
        "  - point --ui-dir (or VIBEDECKX_UI_DIR) at a UI build directory."
    );
    return null;
  }
}
