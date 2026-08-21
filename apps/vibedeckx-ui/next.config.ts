import type { NextConfig } from "next";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Build fingerprint for version-skew detection. Minted here — the one point
// every build path (local `pnpm build`, deploy/build.sh → pack.sh, release CI)
// funnels through — and landed in two places that must stay in lockstep:
//   - NEXT_PUBLIC_UI_BUILD_ID, inlined into the bundle (the tab knows the
//     build it was born from);
//   - public/build-id.json, exported with the static assets so it travels the
//     whole distribution chain (platform tarball, Docker, @vibedeckx/ui-dist,
//     ~/.vibedeckx/ui cache) and tells the server which build it is serving.
// The npm package version is NOT part of the fingerprint: the repo version is
// a placeholder stamped only at release time, so git is the only identity
// that changes on every deploy.
function computeBuildId(): string {
  if (process.env.VIBEDECKX_UI_BUILD_ID) return process.env.VIBEDECKX_UI_BUILD_ID;
  try {
    const sha = execSync("git rev-parse --short=12 HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    // deploy/build.sh may run on an uncommitted tree; without the marker two
    // different dirty builds would share a fingerprint and skew detection
    // would go blind between them.
    const dirty = execSync("git status --porcelain", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
      ? "-dirty"
      : "";
    return `${sha}${dirty}`;
  } catch {
    // Not a git checkout (e.g. building from a source tarball).
    return `ts-${Date.now()}`;
  }
}

const buildId = computeBuildId();
// `next build`/`next dev` always run with cwd = the app directory.
writeFileSync(join(process.cwd(), "public", "build-id.json"), JSON.stringify({ buildId }) + "\n");

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  env: {
    NEXT_PUBLIC_UI_BUILD_ID: buildId,
  },
};

export default nextConfig;
