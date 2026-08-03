import fs from "fs";

/**
 * Version of the vibedeckx package this process is running from. Tries both
 * runtime layouts: the esbuild bundle (everything in dist/bin.js → package.json
 * one level up) and unbundled src/tsc execution (this file under utils/ → two
 * levels up). "unknown" when neither resolves — callers treat that the same as
 * a worker too old to report a version at all.
 */
export function readPackageVersion(): string {
  for (const candidate of ["../package.json", "../../package.json"]) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(new URL(candidate, import.meta.url), "utf8"),
      ) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.length > 0) return parsed.version;
    } catch {
      // try the next layout
    }
  }
  return "unknown";
}
