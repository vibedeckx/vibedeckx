/**
 * SSRF egress guard for the browser-preview proxy.
 *
 * The preview proxy's "direct" branch makes the control-plane server connect to
 * an attacker-influenceable URL and returns the body (full-read SSRF). In hosted
 * (`--auth`) mode this guard blocks the server from reaching private / loopback /
 * link-local / cloud-metadata addresses while still allowing public targets.
 *
 * Design notes: see docs/browser-preview-ssrf.md
 *
 * Key properties:
 * - validates ALL resolved A/AAAA records (rejects if any is blocked);
 * - pins the validated IP for the actual connection (DNS-rebinding defense) via
 *   an undici Agent whose connect.lookup does the resolution + check;
 * - re-validates every redirect hop (undici calls the lookup per connection).
 */

import dns from "dns";
import net from "net";
import { Agent, buildConnector } from "undici";
import type { LookupFunction } from "net";

export class SsrfBlockedError extends Error {
  constructor(
    public readonly hostname: string,
    public readonly address: string,
  ) {
    super(`SSRF blocked: ${hostname} resolves to disallowed address ${address}`);
    this.name = "SsrfBlockedError";
  }
}

/** Walk an error's `cause` chain and return the SsrfBlockedError if present. */
export function findSsrfCause(err: unknown): SsrfBlockedError | null {
  for (let cur: unknown = err, i = 0; cur != null && i < 5; i++) {
    if (cur instanceof SsrfBlockedError) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

const ALLOWED_HTTP_SCHEMES = new Set(["http:", "https:"]);
const ALLOWED_WS_SCHEMES = new Set(["ws:", "wss:"]);

/** IPv4 blocked ranges as [networkInt, prefixLength]. */
const BLOCKED_V4: Array<[number, number]> = [
  [ipv4ToInt("0.0.0.0"), 8],
  [ipv4ToInt("10.0.0.0"), 8],
  [ipv4ToInt("100.64.0.0"), 10],
  [ipv4ToInt("127.0.0.0"), 8],
  [ipv4ToInt("169.254.0.0"), 16], // link-local — covers 169.254.169.254 metadata
  [ipv4ToInt("172.16.0.0"), 12],
  [ipv4ToInt("192.0.0.0"), 24],
  [ipv4ToInt("192.168.0.0"), 16],
  [ipv4ToInt("198.18.0.0"), 15],
  [ipv4ToInt("224.0.0.0"), 4], // multicast
  [ipv4ToInt("240.0.0.0"), 4], // reserved (incl. 255.255.255.255)
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) return -1;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return -1;
    n = (n << 8) | o;
  }
  return n >>> 0;
}

function isBlockedV4(ip: string): boolean {
  const addr = ipv4ToInt(ip);
  if (addr < 0) return true; // unparseable — fail closed
  for (const [net4, prefix] of BLOCKED_V4) {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if ((addr & mask) === (net4 & mask)) return true;
  }
  return false;
}

/** First 16-bit hextet of an IPv6 string (0 for `::`-leading / compressed). */
function firstHextet(ip: string): number {
  if (ip.startsWith("::")) return 0;
  const first = ip.split(":")[0];
  const n = parseInt(first, 16);
  return Number.isNaN(n) ? 0 : n;
}

function isBlockedV6(ipRaw: string): boolean {
  const ip = ipRaw.toLowerCase();
  if (ip === "::1" || ip === "::") return true;

  // IPv4-mapped (::ffff:a.b.c.d) — unwrap and check as IPv4.
  if (ip.includes(".")) {
    const v4 = ip.slice(ip.lastIndexOf(":") + 1);
    if (net.isIPv4(v4)) return isBlockedV4(v4);
  }

  const h = firstHextet(ip);
  if (h >= 0xfc00 && h <= 0xfdff) return true; // fc00::/7 ULA
  if (h >= 0xfe80 && h <= 0xfebf) return true; // fe80::/10 link-local
  if (h >= 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** True if the given IP literal is in a blocked (non-public) range. */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedV4(ip);
  if (net.isIPv6(ip)) return isBlockedV6(ip);
  return true; // not a recognizable IP — fail closed
}

/** Throws if the URL scheme is not in the allowed set for the given protocol. */
export function assertSchemeAllowed(url: string, kind: "http" | "ws"): void {
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    throw new SsrfBlockedError(url, "(unparseable URL)");
  }
  const allowed = kind === "http" ? ALLOWED_HTTP_SCHEMES : ALLOWED_WS_SCHEMES;
  if (!allowed.has(scheme)) {
    throw new SsrfBlockedError(url, `(disallowed scheme ${scheme})`);
  }
}

/**
 * Resolve a hostname and throw SsrfBlockedError if any resolved IP is blocked.
 * Returns the list of validated addresses. Used as a pre-connect check (WS).
 */
export function assertHostAllowed(hostname: string): Promise<string[]> {
  // An IP literal needs no DNS resolution.
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) throw new SsrfBlockedError(hostname, hostname);
    return Promise.resolve([hostname]);
  }
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return reject(err);
      for (const a of addresses) {
        if (isBlockedIp(a.address)) {
          return reject(new SsrfBlockedError(hostname, a.address));
        }
      }
      resolve(addresses.map((a) => a.address));
    });
  });
}

/**
 * A dns.lookup-compatible function that resolves, range-checks every resolved IP,
 * and hands back the validated address(es). Errors with SsrfBlockedError if any
 * is blocked. Passing this to undici/ws as the connect lookup both validates and
 * pins the IP (no second resolution), and runs per redirect hop.
 */
export const guardedLookup: LookupFunction = ((
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void,
) => {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, undefined);
    const list = addresses as dns.LookupAddress[];
    for (const a of list) {
      if (isBlockedIp(a.address)) {
        return callback(new SsrfBlockedError(hostname, a.address), undefined);
      }
    }
    if (options && options.all) {
      callback(null, list);
    } else {
      callback(null, list[0].address, list[0].family);
    }
  });
}) as unknown as LookupFunction;

/**
 * Shared undici dispatcher that validates + pins every outbound connection,
 * including redirect hops (undici invokes the connector per connection).
 *
 * Two layers are needed because undici skips `lookup` for IP-literal hosts:
 * - the connector validates IP-literal hosts (e.g. http://169.254.169.254/) directly;
 * - `guardedLookup` validates + pins DNS-name hosts after resolution.
 */
const baseConnector = buildConnector({ lookup: guardedLookup });

export const guardedDispatcher = new Agent({
  connect: (opts, callback) => {
    const host = opts.hostname;
    if (net.isIP(host) && isBlockedIp(host)) {
      callback(new SsrfBlockedError(host, host), null);
      return;
    }
    baseConnector(opts, callback);
  },
});
