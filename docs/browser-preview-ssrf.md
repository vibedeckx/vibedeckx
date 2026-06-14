# Browser Preview SSRF Egress Filtering (Design + Implementation)

Status: **Implemented** for hosted (`--auth`) mode. Orthogonal to, and required
alongside, [browser-preview-origin-isolation.md](browser-preview-origin-isolation.md).

## Background

The browser-preview proxy lets the server fetch a target URL and stream the
response back to the preview iframe. Two routes in
`packages/vibedeckx/src/routes/browser-proxy-routes.ts` make outbound requests:

- **HTTP** `GET /api/projects/:id/browser/proxy/*` → `proxyFetch()` →
  `fetch(targetUrl, { redirect: "follow" })`.
- **WebSocket** `GET /api/projects/:id/browser/proxy-ws/*` →
  `new WsWebSocket(targetWsUrl)`.

Both first call `resolveTarget()`:

- If the target hostname matches a **connected reverse-connect remote**, the
  request is tunneled and executed **on the user's own remote machine** — the
  control plane makes no outbound connection. Any SSRF there is self-SSRF against
  the user's own box; out of scope.
- Otherwise (**direct branch**), the **shared control-plane server** itself
  connects to the target.

The direct branch is the SSRF surface. The server fetches an
attacker-influenceable URL and returns the response body, i.e. a **full-read
SSRF**: an attacker who can supply the URL (via the AI `openPreview` tool under
prompt injection, or any path that reaches the proxy) can make the control plane
read:

- **cloud metadata** — `http://169.254.169.254/...` (AWS/GCP/Azure) returns
  unauthenticated IAM credentials / instance identity;
- **internal services** reachable from the server but not the public internet
  (databases, admin panels, other tenants' infra);
- **loopback services** on the host, including Vibedeckx's own APIs.

In the **hosted multi-tenant** model this server is the crown-jewel control plane
(holds DB credentials, all tenants' config, all reverse-connect tunnels), so a
full-read SSRF here is a serious cross-tenant / infrastructure escalation.

## Why this is independent of the origin-isolation fix

`browser-preview-origin-isolation.md` is a **browser-side** control — it governs
what the *loaded page* can do (reach parent DOM / token / per-tenant APIs). SSRF
damage happens **server-side at fetch time**, before any browser/origin is
involved. The two are orthogonal layers; doing one does not address the other.
Cookie forwarding (the proxy forwarding the browser `Cookie` header to the
target) is the origin-isolation fix's concern, **not** this document's.

## Why filtering the direct branch does not affect the preview feature

`rewriteHtml()` only rewrites **relative** URLs and URLs **pointing at the target
origin** back through the proxy; third-party absolute URLs (CDNs, fonts,
analytics) are left as-is and fetched by the browser directly, never touching our
proxy. For a legitimate hosted preview the target origin is the reverse-connect
remote, so the top-level page **and** its same-origin sub-resources all travel
the reverse-connect tunnel, not the direct branch. Therefore:

- legitimate hosted preview (reverse-connect): **unaffected** — never uses the
  direct branch;
- previewing a **public** website via the address bar: **still works** — public
  IPs pass the filter;
- previewing `localhost` in hosted mode: meaningless (it would be the control
  plane itself) and correctly blocked;
- the only thing blocked is the control plane connecting to private / loopback /
  link-local / metadata addresses, which no legitimate hosted flow needs.

**Solo mode must keep working.** Solo's primary use case is previewing
`http://localhost:3000` / LAN dev servers via the direct branch. A blanket
private/loopback block would destroy that. The filter is therefore **gated on
`fastify.authEnabled`**: enforced only in hosted (`--auth`) mode, off in solo.

## The fix

A single choke point, `packages/vibedeckx/src/utils/ssrf-guard.ts`, used by both
proxy routes, enforced only when `authEnabled`:

1. **Scheme allowlist** — only `http`/`https` (HTTP route) and `ws`/`wss` (WS
   route). Rejects `file:` etc.
2. **Normalize + range check** — filtering is by **IP**, never by hostname string
   matching (which encoding tricks defeat). A host that already denotes an IP —
   standard IPv4/IPv6, bracketed IPv6, or an inet_aton numeric encoding
   (decimal/octal/hex and 1–4 part short forms, e.g. `2130706433`, `0x7f.1`,
   `0177.0.0.1`) — is normalized by `parseIpHost()` and range-checked **directly,
   without DNS** (independent of libc `getaddrinfo`). A DNS name is resolved to
   **all** A/AAAA records and rejected if **any** resolved IP is blocked
   (conservative: a partially-private result is rejected). Blocked ranges:
   - IPv4: `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, **`169.254/16`** (covers
     `169.254.169.254`), `172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`,
     `224/4`, `240/4`.
   - IPv6: `::1`, `::`, `fc00::/7` (ULA — also covers AWS `fd00:ec2::254`),
     `fe80::/10` (link-local), `ff00::/8` (multicast). The address is
     **byte-expanded**, so IPv4-mapped (`::ffff:a.b.c.d` in dotted **or** hex
     form, e.g. `::ffff:a9fe:a9fe` = `169.254.169.254`) and IPv4-compatible
     (`::/96`) addresses have their embedded IPv4 range-checked — string-form
     tricks cannot bypass it.
3. **IP pinning (DNS-rebinding defense)** — validation and connection use the
   **same** resolved IP, via an undici `Agent` with two layers (undici skips
   `lookup` for IP-literal hosts, so a lookup-only guard would miss
   `http://169.254.169.254/`):
   - a custom **connector** that rejects IP-literal hosts that are in a blocked
     range, before connecting;
   - a custom **`lookup`** that resolves DNS-name hosts, range-checks every
     resolved IP, and hands undici the validated address (no second resolution).
4. **Per-redirect re-validation** — because undici invokes the connector (and,
   for names, the lookup) for **every** new connection, `redirect: "follow"` is
   safe: each redirect hop's host is range-checked again, whether it is a name or
   an IP literal. (A public site that 302s to `169.254.169.254` is blocked at the
   hop.) The initial host is additionally pre-checked in `proxyFetch` so a blocked
   top-level target returns a clean `403` without a fetch attempt.
5. **WS route** — pre-checks the host with `assertHostAllowed()` and also passes
   the guarded `lookup` to the `ws` client, so the connect target is pinned too.

A blocked target surfaces as HTTP `403` (HTTP route) / close code `4403` (WS
route) with a clear message, distinct from a generic `502` proxy error.

## Impact summary

- **Security:** closes full-read SSRF from the control plane to cloud
  metadata / internal / loopback targets — the main hosted-mode escalation path
  through the preview proxy.
- **Functionality:** no change to reverse-connect preview, no change to public
  URL preview, no change to solo (filter off when `authEnabled` is false).
- **Performance:** one extra DNS resolution + range check per direct-branch
  request; negligible, OS-cached.
- **Blocked-but-acceptable:** hosted control plane can no longer directly reach a
  private-IP dev server not exposed via reverse-connect — which is exactly the
  unsupported/dangerous path; users use reverse-connect instead.

## Outbound proxy (Settings proxy) interaction

The browser-preview proxy **always egresses directly** — it has never used the
Settings outbound proxy (`utils/proxy-manager.ts`; that proxy is applied only by
`remote-proxy.ts` and a few WS routes, never by this path). The guard pins and
range-checks those direct connections. Crucially, the high-value SSRF targets —
cloud metadata `169.254.169.254` (link-local), RFC1918, and loopback — are
direct-reachable regardless of any forward-proxy config, so they are filtered
either way.

In the hosted (`--auth`) deployment the Settings proxy is **not used**. As
defense against misconfiguration, if `--auth` is on **and** a Settings proxy is
configured, the server logs a startup warning that preview egress is direct +
filtered and does not route through that proxy (so it is not mistaken for the
egress-control point). If a deployment ever required all egress through a forward
proxy, IP pinning could not see the post-proxy address and egress filtering would
have to be enforced at the proxy — but that is not the hosted model here.

## Known limitations

- The guard is **hosted-only by design**. Solo deployments keep current behavior
  (so `localhost` / LAN dev-server preview keeps working).
- Filtering is destination-IP based. It is **not** a domain allowlist: a *public*
  attacker-controlled URL is still fetched (that is the intended "preview a public
  site" capability). Preventing the previewed page from acting as app-origin
  script, and cookie forwarding, are the separate-origin fix's concern
  ([browser-preview-origin-isolation.md](browser-preview-origin-isolation.md)).
