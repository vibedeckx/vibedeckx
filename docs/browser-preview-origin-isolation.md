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
- **Fallback:** if no separate preview origin is configured, keep today's
  behavior (do not silently downgrade to an insecure default). Operators opting
  into multi-tenant exposure must configure a preview origin.

`getBrowserProxyUrl()` builds the iframe URL against the configured preview
origin instead of `getApiBase()`.

### 2. Auth + ownership on the proxy routes (with token passing)

The proxy routes currently have no `requireAuth` / project-ownership check. Add
them — but note the iframe `src` is a plain navigation that **cannot carry the
`Authorization: Bearer` header**. Pass the session token in the URL query, the
same pattern the WebSocket routes already use
(`packages/vibedeckx/src/routes/websocket-routes.ts` — `verifyWsToken`,
`authenticateLogsWs`):

- `getBrowserProxyUrl()` appends `?token=<sessionToken>` (and the HMR
  `proxy-ws` URL rewriting in the injected script must do the same).
- The proxy GET and `proxy-ws` handlers verify the token, then check
  `storage.projects.getById(projectId, userId)` for ownership.

Without this, enabling `--auth` would 401 the iframe navigation and break
preview entirely.

### 3. CORS allowlist that excludes the preview origin

`server.ts` currently returns `access-control-allow-origin: *` for all requests.
Replace with a reflected allowlist (UI origin + any configured client origins).
The preview origin must **not** be on this list, so even if previewed scripts
run, they cannot read main-API responses cross-origin. Pair with an `Origin`
check on state-changing routes (CORS response headers do not block the *sending*
of simple requests, only reading responses).

### 4. postMessage hardening

The injected script posts results to the parent with `postMessage(result, "*")`
(`packages/vibedeckx/src/routes/browser-proxy-routes.ts`), and the parent handler
(`apps/vibedeckx-ui/components/preview/browser-frames-provider.tsx`) acts on
`vibedeckx-result` / `vibedeckx-browser-error` **without validating
`event.origin`**. Once the preview is on a known separate origin:

- tighten the injected `postMessage` `targetOrigin` to the known parent origin;
- validate `event.origin` against the known preview origin in the parent handler
  before processing messages.

## Implementation checklist

- [ ] Configurable preview origin (`--preview-origin`; dev default `preview.localhost`/dedicated port).
- [ ] `getBrowserProxyUrl()` builds against the preview origin + appends session token.
- [ ] Proxy GET + `proxy-ws`: verify token, check project ownership.
- [ ] Injected HMR WS rewriting carries the token.
- [ ] CORS: reflected allowlist (excludes preview origin) + `Origin` check on mutating routes.
- [ ] postMessage: scoped `targetOrigin` + parent-side `event.origin` validation.
- [ ] Optional: default bind `127.0.0.1` unless explicitly exposed (`server.ts` `start` binds `0.0.0.0`).
