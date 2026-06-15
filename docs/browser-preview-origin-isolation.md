# Browser Preview Origin Isolation (Design)

Status: **Planned** — not needed for current deployment, required before hosted multi-tenant `--auth`.

## Background

The Preview panel embeds a user-supplied dev-server URL through the same-origin
browser proxy. The flow:

- `browser-frames-provider.tsx` renders an `<iframe>` whose `src` is
  `api.getBrowserProxyUrl(projectId, url)` → `/api/projects/:id/browser/proxy/<encoded-url>`
  (`apps/vibedeckx-ui/lib/api.ts`).
- In production `getApiBase()` returns `""`, so that proxy URL is **same-origin**
  with the main UI (`apps/vibedeckx-ui/lib/api.ts`).
- The iframe sandbox is `allow-scripts allow-same-origin ...`
  (`apps/vibedeckx-ui/components/preview/browser-frames-provider.tsx`,
  `apps/vibedeckx-ui/components/ai-elements/web-preview.tsx`).
- The backend proxy (`packages/vibedeckx/src/routes/browser-proxy-routes.ts`)
  fetches the arbitrary target, strips `Content-Security-Policy` /
  `X-Frame-Options` / `X-Content-Type-Options`, forwards the browser `Cookie`
  header, and returns the remote HTML as `text/html` with scripts preserved.

Net effect: **the proxied page executes JavaScript with the Vibedeckx
application origin.** `allow-same-origin` is deliberate — it is what makes the
previewed dev server actually work (its own `localStorage` / cookies / HMR /
login state depend on having a real, stable origin).

## Why this is acceptable today, and when it is not

Frontend auth uses an in-memory `Authorization: Bearer` token, not a cookie
(`apps/vibedeckx-ui/lib/api.ts`).

- **Current deployment — solo, self-hosted, no-auth:** users preview only their
  own trusted dev server. There is no third party. Residual risk is limited to
  "user is tricked into previewing hostile content," which is out of scope for a
  single-operator local tool. **No change required.**
- **Future deployment — hosted, multi-tenant, `--auth`:** users log into a
  shared server and preview their own remote dev servers (via reverse-connect).
  Here the same-origin design has teeth. If any user is induced to preview
  hostile content (or their dev server is compromised / has XSS / pulls in
  third-party scripts), that content runs on the *shared* app origin and can:
  - read `window.parent` and exfiltrate that user's in-memory Bearer token →
    impersonate the user against the per-tenant APIs;
  - drive privileged sinks (agent sessions, `execute-sync`); where these execute
    on the shared host, one hijacked session can become host / cross-tenant
    command execution.

  This is the deployment the original finding rated critical, and it is correct
  for that context.

## Rejected alternative: drop `allow-same-origin`

Removing `allow-same-origin` gives the iframe an opaque origin. This blocks the
parent-DOM/token-theft path, but it also **destroys the feature**: the previewed
dev server loses `localStorage` / `sessionStorage` / cookies / Service Workers /
IndexedDB, so any app with login state or persistence breaks. Since previewing a
working dev server is the whole point of the panel, this is not a viable fix in
either deployment.

## Chosen design: serve the proxy from a separate origin

Run the proxied content on an origin that is **unrelated to the main app
origin**. Then `allow-same-origin` can stay (preview functionality intact, now
scoped to the isolated preview origin), while the previewed content cannot reach
the main app's DOM, token, or per-tenant APIs.

### 1. Separate origin for `/browser/proxy/*`

- **Dev / local:** dedicated loopback host or port for the proxy, e.g.
  `preview.localhost` (resolves to 127.0.0.1) or a separate preview port. The
  iframe `src` points at that origin.
- **Production / tunnel:** a distinct hostname — a wildcard subdomain
  (`*-preview.<host>`) or a dedicated preview domain, configured via e.g.
  `--preview-origin`.
- **Partition per project (or session), not one shared preview origin.** A
  single `preview.localhost` / single preview port is *one* origin shared by
  every project's preview, so tenant A's compromised dev-server content sits on
  the same origin as tenant B's preview and can read its `localStorage` /
  DOM / preview cookie. Bind the preview origin to the project (or session):
  `<projectId>-preview.<host>` in production, a per-project port or
  `p-<id>.preview.localhost` in dev. Isolating preview from the *main app*
  (below) does not isolate previews from *each other* — both matter under
  multi-tenant `--auth`. Production wildcard subdomains need a wildcard TLS cert
  (operational note).
- **Fallback — fail closed, do NOT keep today's behavior.** Today's behavior is
  the same-origin proxy, which is exactly the insecure path. When `--auth` is
  on and no preview origin is configured, **refuse to start** (boot error, same
  shape as the `--accept-remote` → `VIBEDECKX_API_KEY` boot guard) or **disable
  the preview feature entirely**. Never silently serve previews same-origin
  under multi-tenant exposure. (Solo no-auth may keep same-origin — there is no
  third party to isolate from.)

`getBrowserProxyUrl()` builds the iframe URL against the configured preview
origin instead of `getApiBase()`.

### 2. Auth + ownership on the proxy routes (with token passing)

The proxy routes currently have no `requireAuth` / project-ownership check. Add
them — but the iframe `src` is a plain navigation that **cannot carry the
`Authorization: Bearer` header**, so the token has to ride along some other way.
The WebSocket routes pass it in the URL query
(`packages/vibedeckx/src/routes/websocket-routes.ts` — `verifyWsToken`,
`authenticateLogsWs`), but **that pattern is unsafe here**:

> ⚠️ **A token in the iframe URL leaks straight to the hostile previewed page.**
> The iframe's document *is* the proxied (potentially attacker-controlled) page,
> and its JS can read its own `location`. The injected script already reads
> `location.href` in several places (`browser-proxy-routes.ts` ~L227, ~L332,
> the latter even `postMessage`-ing `url: location.href` to the parent). So a
> `?token=` would be readable via `location.search` by the very content we are
> trying to contain — handing the session token to the attacker. It also leaks
> into server access logs, browser history, and the upstream `Referer`.

Safer token handling (pick / combine):

- **Consume-then-redirect:** the proxy validates the query token on the *first*
  request, sets a short-lived `HttpOnly; SameSite` cookie **scoped to the
  preview origin**, then `302`s to a token-less URL. Subsequent requests carry
  the cookie; the previewed page's JS can read neither the clean URL nor the
  `HttpOnly` cookie. The HMR `proxy-ws` URL rewriting authenticates off the same
  cookie rather than embedding the token in a page-readable string.
- **One-time token** (single-use, burned on first request) + injected
  `Referrer-Policy: no-referrer` as a backstop if a query token is unavoidable.
- **Use a preview-scoped capability token, not the full Bearer.** The proxy
  should not accept the main app's full-power Bearer (which authorizes every
  `userId`-scoped API). Mint a narrow, short-TTL capability that authorizes only
  *proxy GET / proxy-ws for this project*. If it ever leaks despite the above,
  the blast radius is "read this project's preview," not "full account
  takeover."

In all cases the proxy GET and `proxy-ws` handlers verify the credential, then
check `storage.projects.getById(projectId, userId)` for ownership. Strip the
token from the URL before forwarding the request upstream to the target.

Without auth on these routes, enabling `--auth` would either 401 the iframe
navigation (broken preview) or, worse, leave the proxy unauthenticated.

### 3. CORS allowlist that excludes the preview origin

`server.ts` currently returns `access-control-allow-origin: *` for all requests.
Replace with a reflected allowlist (UI origin + any configured client origins).
The preview origin must **not** be on this list, so even if previewed scripts
run, they cannot read main-API responses cross-origin. Pair with an `Origin`
check on state-changing routes (CORS response headers do not block the *sending*
of simple requests, only reading responses).

### 4. postMessage hardening

**Both directions of the bridge currently use `"*"` and validate no origin** —
harden both, not just iframe→parent:

- **iframe → parent:** the injected script posts results/errors with
  `window.parent.postMessage(result, "*")`
  (`packages/vibedeckx/src/routes/browser-proxy-routes.ts` ~L322, L329), and the
  parent handler (`apps/vibedeckx-ui/components/preview/browser-frames-provider.tsx`
  ~L181-194) acts on `vibedeckx-result` / `vibedeckx-browser-error` **without
  validating `event.origin`**.
- **parent → iframe:** `sendCommandToIframe()` posts click/fill commands with
  `iframe.contentWindow.postMessage(command, "*")`
  (`browser-frames-provider.tsx` ~L50), and the iframe-side command receiver
  (`browser-proxy-routes.ts` ~L243) likewise does not check `event.origin`, so
  any frame that obtains a handle could inject commands.

Once the preview is on a known separate origin, for **each** direction:

- set the `postMessage` `targetOrigin` to the known peer origin (parent origin
  for iframe→parent; preview origin for parent→iframe) instead of `"*"`;
- validate `event.origin` in **both** handlers before acting (parent handler
  against the preview origin; iframe receiver against the main app origin).

## Relationship to the SSRF egress guard

A separate egress control already shipped after this design was first written:
the SSRF guard (`packages/vibedeckx/src/utils/ssrf-guard.ts`, added in commits
`48d2dd5` / `f9797c4`) blocks the proxy from *fetching* private / metadata IPs
in hosted mode. **It is orthogonal to origin isolation and does not mitigate
this finding**: the SSRF guard governs *where the proxy may fetch from*, while
origin isolation governs *what the fetched HTML can touch once it runs*. A
public attacker host passes the SSRF guard and still executes same-origin today.
The two are complementary — keep both. Confirm `enforceSsrf` is actually enabled
on the deployment paths that turn on preview/hosted mode (it is currently gated
on hosted mode). The "default bind `127.0.0.1`" checklist item below overlaps
with the SSRF guard's threat model and can be reasoned about together.

## What origin isolation does NOT depend on (defense in depth)

The security boundary is the *origin separation*, not the completeness of HTML
rewriting. `rewriteHtml` (`browser-proxy-routes.ts`) cannot catch every URL —
JS-constructed URLs, `<base>` tags, `srcset`, etc. — so some requests escape the
proxy and hit the upstream target directly. After isolation those land on the
preview origin and are already contained, so this is acceptable. Do **not** rely
on rewrite completeness for safety; rely on the origin boundary.

## Verification

No test framework is configured, so at minimum a manual verification checklist
(ideally a small harness later):

- [ ] Assert at startup that the resolved preview origin ≠ main app origin (and,
      under partitioning, that two different projects resolve to different
      origins).
- [ ] Fixture: a hostile preview page that attempts `window.parent.document`
      access, `fetch('/api/projects')` against the main API, and reading the
      session token — confirm all are blocked cross-origin.
- [ ] Confirm the token never appears in the previewed page's `location` /
      `document.URL`, in server access logs, or in the upstream `Referer`.
- [ ] Confirm `--auth` without a configured preview origin fails closed (boot
      error or preview disabled), not same-origin fallback.

## Implementation checklist

- [ ] Configurable preview origin (`--preview-origin`; dev default `preview.localhost`/dedicated port).
- [ ] **Partition the preview origin per project/session** (not one shared preview origin).
- [ ] **Fail closed:** `--auth` without a preview origin → boot error or preview disabled (never same-origin fallback).
- [ ] `getBrowserProxyUrl()` builds against the preview origin.
- [ ] **Token handling that does not leak to the previewed page:** consume-then-redirect + preview-origin `HttpOnly` cookie (or one-time token), never a persistent `?token=` in the iframe URL.
- [ ] **Preview-scoped capability token**, not the full Bearer; strip the token before forwarding upstream.
- [ ] Proxy GET + `proxy-ws`: verify credential, check project ownership.
- [ ] Injected HMR WS rewriting authenticates without embedding a page-readable token.
- [ ] CORS: reflected allowlist (excludes preview origin) + `Origin` check on mutating routes.
- [ ] postMessage **both directions**: scoped `targetOrigin` + `event.origin` validation in both the parent handler and the iframe command receiver.
- [ ] Confirm the SSRF egress guard (`utils/ssrf-guard.ts`) is enabled on preview/hosted paths.
- [ ] Optional: default bind `127.0.0.1` unless explicitly exposed (`server.ts` `start` binds `0.0.0.0`).
