import type { Storage } from "./storage/types.js";

/** Header carrying the reverse-connect token on the identity preflight request. */
export const CONNECT_IDENTITY_HEADER = "x-vibedeckx-connect-token";

/**
 * Settings key prefix for the per-hub pinned remote identity. Full key is
 * `reverse_pinned_identity:<canonical hub URL>` so one machine can serve
 * different remotes on different hubs without the pins colliding.
 */
export const PINNED_IDENTITY_SETTING_PREFIX = "reverse_pinned_identity:";

export interface RemoteIdentity {
  serverId: string;
  name: string;
}

export interface PreflightResult {
  /** false = old hub without the identity endpoint; nothing was verified. */
  checked: boolean;
  identity?: RemoteIdentity;
}

/**
 * Canonicalize a hub URL so equivalent spellings (`https://HUB.example:443/`,
 * `https://hub.example`) map to the same pin key. URL parsing lowercases the
 * hostname and drops default ports; trailing slashes are stripped while an
 * explicit path prefix is preserved (the WS client appends
 * `/api/reverse-connect` to the same base, so path-mounted hubs stay
 * addressable).
 */
export function canonicalizeHubUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid --connect-to URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`--connect-to must be an http(s) URL, got: ${raw}`);
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

function parsePin(raw: string): Partial<RemoteIdentity> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Partial<RemoteIdentity>;
  } catch {
    // fall through — treat a corrupt pin as absent so it gets repaired
  }
  return {};
}

/**
 * Pre-connect guard against running the wrong remote's token on this machine.
 * Connecting first and checking afterwards is too late: registering under the
 * wrong server ID kicks the legitimate worker off (last-writer-wins) and the
 * executor-recovery hook that fires on `online` can plant a server alias. So
 * this runs — and must be awaited — before the WS client is even constructed.
 *
 * Flow: capability discovery via the public `/api/config` (old hubs lack the
 * `reverseConnectIdentity` field, or hide config behind API-key auth — both
 * skip the check entirely, preserving status-quo behavior), then resolve the
 * token's identity, then compare against the pin stored in this data-dir's
 * settings. First connect pins atomically via `settings.getOrCreate`, so two
 * concurrent first connects with different tokens can't both pass.
 */
export async function preflightIdentityCheck(opts: {
  connectTo: string;
  token: string;
  settings: Storage["settings"];
  force?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<PreflightResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const hubUrl = canonicalizeHubUrl(opts.connectTo);

  let config: { reverseConnectIdentity?: boolean } | undefined;
  try {
    const res = await fetchImpl(`${hubUrl}/api/config`);
    if (res.ok) config = (await res.json()) as { reverseConnectIdentity?: boolean };
  } catch {
    // Hub unreachable — let the WS connect path surface the real error.
  }
  if (config?.reverseConnectIdentity !== true) return { checked: false };

  // Capability confirmed: from here every failure is a real error, never
  // "maybe an old hub".
  const res = await fetchImpl(`${hubUrl}/api/reverse-connect/identity`, {
    headers: { [CONNECT_IDENTITY_HEADER]: opts.token },
  });
  if (res.status === 401) {
    throw new Error("Connect token was rejected by the server (invalid or revoked)");
  }
  if (res.status === 403) {
    throw new Error("This token's remote is not configured for inbound connections");
  }
  if (!res.ok) {
    throw new Error(`Identity preflight failed with status ${res.status}`);
  }
  const body = (await res.json()) as Partial<RemoteIdentity>;
  if (!body || typeof body.serverId !== "string" || body.serverId.length === 0) {
    throw new Error("Malformed identity response from server");
  }
  const identity: RemoteIdentity = { serverId: body.serverId, name: body.name ?? "" };

  const key = `${PINNED_IDENTITY_SETTING_PREFIX}${hubUrl}`;
  const desired = JSON.stringify(identity);

  if (opts.force) {
    await opts.settings.set(key, desired);
    return { checked: true, identity };
  }

  const persisted = await opts.settings.getOrCreate(key, () => desired);
  const pinned = parsePin(persisted);
  if (pinned.serverId && pinned.serverId !== identity.serverId) {
    const pinnedLabel = pinned.name || pinned.serverId;
    const tokenLabel = identity.name || identity.serverId;
    throw new Error(
      `This machine previously served remote "${pinnedLabel}" on ${hubUrl}, ` +
        `but the provided token belongs to "${tokenLabel}". ` +
        `If this is intentional, re-run with --force to re-pin.`,
    );
  }
  if (!pinned.serverId || pinned.name !== identity.name) {
    // Repair a corrupt pin, or refresh the stored name after a rename so a
    // future mismatch error names the right remote.
    await opts.settings.set(key, desired);
  }
  return { checked: true, identity };
}
