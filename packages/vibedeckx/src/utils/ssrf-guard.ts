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

/** Expand a (net.isIPv6-validated) IPv6 string to its 16 bytes, or null. */
function ipv6ToBytes(input: string): number[] | null {
  let s = input.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);

  // Fold a trailing dotted-IPv4 (e.g. ::ffff:1.2.3.4) into two hex groups so the
  // dotted and hex forms expand to identical bytes.
  const lastColon = s.lastIndexOf(":");
  const tail = lastColon >= 0 ? s.slice(lastColon + 1) : s;
  if (tail.includes(".")) {
    if (!net.isIPv4(tail)) return null;
    const o = tail.split(".").map((x) => Number(x));
    const hi = ((o[0] << 8) | o[1]).toString(16);
    const lo = ((o[2] << 8) | o[3]).toString(16);
    s = s.slice(0, lastColon + 1) + hi + ":" + lo;
  }

  const dbl = s.split("::");
  if (dbl.length > 2) return null;
  const head = dbl[0] === "" ? [] : dbl[0].split(":");
  const rest = dbl.length === 2 ? (dbl[1] === "" ? [] : dbl[1].split(":")) : [];
  let groups: string[];
  if (dbl.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 0) return null;
    groups = [...head, ...new Array(missing).fill("0"), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const g of groups) {
    if (g.length === 0 || g.length > 4 || !/^[0-9a-f]+$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

function isBlockedV6(ipRaw: string): boolean {
  const b = ipv6ToBytes(ipRaw);
  if (!b) return true; // unparseable — fail closed

  // IPv4-mapped (::ffff:a.b.c.d, any textual form) — check the embedded IPv4.
  const first10Zero = b.slice(0, 10).every((x) => x === 0);
  if (first10Zero && b[10] === 0xff && b[11] === 0xff) {
    return isBlockedV4(b.slice(12).join("."));
  }
  // ::, ::1, and ::a.b.c.d (deprecated IPv4-compatible) — all non-public.
  if (b.slice(0, 12).every((x) => x === 0)) return true;

  if (b[0] >= 0xfc && b[0] <= 0xfd) return true; // fc00::/7 ULA
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  return false;
}

/** True if the given IP literal is in a blocked (non-public) range. */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedV4(ip);
  if (net.isIPv6(ip)) return isBlockedV6(ip);
  return true; // not a recognizable IP — fail closed
}

/** Parse one inet_aton octet/word in decimal, octal (leading 0), or hex (0x). */
function parseAtonPart(s: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
  if (/^0[0-7]*$/.test(s)) return parseInt(s, 8); // octal, incl. "0"
  if (/^[1-9][0-9]*$/.test(s)) return parseInt(s, 10);
  return null;
}

/**
 * Normalize an inet_aton-style numeric host (decimal/octal/hex, and the
 * 1/2/3/4-part short forms — e.g. `2130706433`, `0x7f.1`, `0177.0.0.1`,
 * `127.1`) to canonical dotted IPv4. Returns null if not such a literal.
 * This makes range checks independent of libc getaddrinfo normalization.
 */
function inetAton(host: string): string | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const vals: number[] = [];
  for (const p of parts) {
    const v = parseAtonPart(p);
    if (v === null || v < 0) return null;
    vals.push(v);
  }
  let n: number;
  // Per inet_aton, the final part absorbs the remaining low-order bytes.
  if (vals.length === 1) {
    n = vals[0];
    if (n > 0xffffffff) return null;
  } else if (vals.length === 2) {
    if (vals[0] > 0xff || vals[1] > 0xffffff) return null;
    n = vals[0] * 0x1000000 + vals[1];
  } else if (vals.length === 3) {
    if (vals[0] > 0xff || vals[1] > 0xff || vals[2] > 0xffff) return null;
    n = vals[0] * 0x1000000 + vals[1] * 0x10000 + vals[2];
  } else {
    if (vals.some((x) => x > 0xff)) return null;
    n = vals[0] * 0x1000000 + vals[1] * 0x10000 + vals[2] * 0x100 + vals[3];
  }
  n = n >>> 0;
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
}

/**
 * If `host` denotes an IP address in any form (standard IPv4/IPv6, bracketed
 * IPv6, or an inet_aton numeric encoding), return it canonicalized; otherwise
 * null (treat as a DNS name to be resolved). Lets us range-check literals
 * directly instead of trusting getaddrinfo to normalize them.
 */
export function parseIpHost(host: string): string | null {
  if (net.isIPv4(host) || net.isIPv6(host)) return host;
  if (host.startsWith("[") && host.endsWith("]")) {
    const inner = host.slice(1, -1);
    return net.isIPv6(inner) ? inner : null;
  }
  return inetAton(host);
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
  // An IP literal (any encoding) needs no DNS resolution.
  const literal = parseIpHost(hostname);
  if (literal) {
    if (isBlockedIp(literal)) throw new SsrfBlockedError(hostname, literal);
    return Promise.resolve([literal]);
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
  // An IP literal (incl. numeric encodings) is validated and pinned directly,
  // without DNS resolution — undici/ws connect to exactly this address.
  const literal = parseIpHost(hostname);
  if (literal) {
    if (isBlockedIp(literal)) {
      return callback(new SsrfBlockedError(hostname, literal), undefined);
    }
    const family = net.isIPv6(literal) ? 6 : 4;
    if (options && options.all) callback(null, [{ address: literal, family }]);
    else callback(null, literal, family);
    return;
  }
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
    // Validate IP-literal hosts (any encoding) here, since undici only calls
    // `lookup` for hosts it does not recognize as IPs. DNS names fall through to
    // baseConnector → guardedLookup.
    const literal = parseIpHost(opts.hostname);
    if (literal && isBlockedIp(literal)) {
      callback(new SsrfBlockedError(opts.hostname, literal), null);
      return;
    }
    baseConnector(opts, callback);
  },
});
