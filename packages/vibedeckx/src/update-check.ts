// Lightweight npm update check for the CLI (`connect status`). Deliberately
// dependency-free: the published package must stay lean and never fail a
// status command because the registry is unreachable.

// Strict SemVer 2.0.0 grammar (semver.org): no leading zeros in numeric
// fields, no empty prerelease identifiers. Build metadata is accepted but
// ignored for precedence.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

export type UpdateStatus = "update-available" | "up-to-date" | "unknown";

/**
 * Fetches the latest published version of a package from the npm registry.
 *
 * Never throws. Network errors, the 4s timeout, non-2xx responses, malformed
 * JSON, and missing/invalid `version` fields all resolve to `undefined`
 * (= "check failed").
 */
export async function fetchLatestPublishedVersion(
  pkg = "vibedeckx",
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(
      `https://registry.npmjs.org/${pkg}/latest`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (!response.ok) return undefined;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" && parseSemver(body.version)
      ? body.version
      : undefined;
  } catch {
    return undefined;
  }
}

interface ParsedSemver {
  core: [string, string, string];
  prerelease: string[] | undefined;
}

function parseSemver(version: string): ParsedSemver | undefined {
  const match = SEMVER_RE.exec(version);
  if (!match) return undefined;
  return {
    core: [match[1]!, match[2]!, match[3]!],
    prerelease: match[4]?.split("."),
  };
}

// The grammar forbids leading zeros, so shorter digit strings are always
// smaller — this stays exact past Number.MAX_SAFE_INTEGER.
function compareNumericStrings(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrereleaseIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return compareNumericStrings(a, b);
  // Numeric identifiers sort below alphanumeric ones (semver spec).
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Returns >0 if a is newer than b, <0 if older, 0 if equal. */
function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  for (let i = 0; i < 3; i += 1) {
    const compared = compareNumericStrings(a.core[i]!, b.core[i]!);
    if (compared !== 0) return compared;
  }
  // A prerelease sorts below its release: 0.5.4-beta < 0.5.4.
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const aId = a.prerelease[i];
    const bId = b.prerelease[i];
    // A longer prerelease with an equal prefix is newer: 1.0.0-a < 1.0.0-a.1.
    if (aId === undefined) return -1;
    if (bId === undefined) return 1;
    const compared = comparePrereleaseIdentifiers(aId, bId);
    if (compared !== 0) return compared;
  }
  return 0;
}

/**
 * Tri-state comparison: "can't compare" must be distinguishable from "no
 * update". Returns "unknown" when `latest` is undefined (fetch failed) or when
 * either version doesn't parse as strict semver — e.g. the daemon state's
 * version can be the literal "unknown" readPackageVersion() fallback.
 */
export function compareUpdateStatus(
  current: string,
  latest: string | undefined,
): UpdateStatus {
  if (latest === undefined) return "unknown";
  const currentParsed = parseSemver(current);
  const latestParsed = parseSemver(latest);
  if (!currentParsed || !latestParsed) return "unknown";
  return compareSemver(latestParsed, currentParsed) > 0
    ? "update-available"
    : "up-to-date";
}
