# Preview Links (Design + Implementation)

Status: **Implemented** (hub + worker; worker half ships with the next worker
release). Supersedes [browser-preview-origin-isolation.md](browser-preview-origin-isolation.md)
and retires [browser-preview-ssrf.md](browser-preview-ssrf.md).

## Problem

The Browser tab used to embed a dev server through a same-origin proxy
(`/api/projects/:id/browser/proxy/<url>`) in an `allow-same-origin` iframe, and
the Main Chat agent drove a Playwright Chrome on the hub. Three security
findings came out of that design (app-origin script execution, SSRF on the
direct-fetch branch, browser events as privileged prompts) and the origin
isolation it needed was never built. Meanwhile the agents that do the work
(Claude Code, Codex) run on the worker and already bring their own browser
tooling, so hub-side Playwright served nobody.

What is genuinely ours is the tunnel: a dev server on any connected machine,
reachable from any browser the user is holding, including a phone. That is the
only part kept.

## Model

A **preview link** binds `(project, target machine, port)` to a short slug and
serves `http://localhost:<port>` of that machine at its own origin:

```
https://<slug>.<preview-host>/
```

- `target machine` is a remote server linked to the project, or `local` for the
  hub's own machine (solo deployments only; refused under `--no-local-projects`).
- The page is served **top-level in a new tab**, never inside the app. The app
  origin and every preview origin are mutually foreign, so previewed script
  reaches neither the app DOM/token nor another preview's storage.
- Paths are passed through untouched: `/assets/x.js`, `/_next/webpack-hmr`,
  service workers all resolve against the preview host. No HTML rewriting, no
  injected script.

Flow (`packages/vibedeckx/src/preview/`):

```
browser  GET https://k7f2qa.vdxpreview.dev/dashboard   Cookie: vdx_preview=…
  │
  ▼
hub   preview-proxy.ts (Node-level dispatcher, before Fastify)
      slug → preview_links row → cookie must belong to row.user_id
      strip hop-by-hop + vdx_* cookies, forward the rest
  │  reverse-connect tunnel: http_request{port} / ws_open{port}
  ▼
worker  fetch http://localhost:3000/dashboard  (redirect: manual, binary as base64)
```

### Why a Node-level dispatcher

Preview hosts are dispatched in the `serverFactory` request handler, before
Fastify routing. Inside Fastify a previewed app's `/api/config` or
`/favicon.ico` would hit the hub's own unconstrained routes, the Clerk
preHandler would run on every asset, and the CORS `*` hook would apply. Keeping
preview traffic out of Fastify removes all of that by construction. WebSocket
upgrades are handled the same way: the factory wraps `upgrade` listeners so
`@fastify/websocket` never sees preview-host upgrades.

### Auth

The new tab cannot carry the app's in-memory Bearer token, so:

1. `POST /api/projects/:id/preview-links` (Bearer, project ownership, remote
   linked to the project, worker capability check) upserts the link and mints
   a **one-time ticket** (60 s, single use, in memory). Response carries
   `authUrl = https://<slug>.<host>/__vdx/auth?t=<ticket>`.
2. The tab opens `authUrl`. The hub consumes the ticket, sets
   `vdx_preview=<payload>.<hmac>` (`HttpOnly; Secure; SameSite=Lax; Path=/`,
   12 h, scoped to that one host, signed with a per-hub secret persisted in
   `global_settings`) and `302`s to `/`.
3. Every later request, including HMR upgrades, authenticates by that cookie.
   The page's JS can read neither the cookie nor any token in the URL.
4. No/expired cookie → a small HTML page linking to
   `<VIBEDECKX_PUBLIC_URL>/?preview=<slug>`. The app, if signed in, calls
   `POST /api/preview-links/:slug/open` and redirects back with a fresh ticket,
   so preview URLs are bookmarkable.

The cookie authorizes exactly one slug's proxy; leaking it does not leak the
account.

All previews of one user are **same-site** with each other (`a.<host>` and
`b.<host>` share a registrable domain), so SameSite cookies cannot keep a
hostile page on slug b from opening a WebSocket to slug a with a's cookie
attached, and WebSocket has no CORS. Upgrades therefore also require the
browser's `Origin` header to equal the slug's own origin before the upstream
`Origin` is rewritten to `localhost`. In solo (no `--auth`) mode the cookie is still issued but not
required — there is no second party on a loopback-bound hub.

### Host configuration

- `--preview-host <host[:port]>` / `VIBEDECKX_PREVIEW_HOST`. Production uses a
  **separate registrable domain** (e.g. `vdxpreview.dev`, wildcard DNS →
  hub, wildcard TLS). Not a subdomain of the app domain: Clerk cookies may be
  set on the app's parent domain and would otherwise ride along to previews.
- Scheme: `VIBEDECKX_PUBLIC_URL`'s scheme if set, else `https` under TLS, else
  `http`.
- No flag/env: solo mode defaults to `preview.localhost:<port>` (browsers
  resolve `*.localhost` to loopback); `--auth` mode **disables** the feature
  (fail closed, `/api/config.previewLinks = false`, UI shows how to enable).

### Tunnel contract (additive)

- `HttpRequestFrame.encoding?: "base64"` — request body carried as base64.
- `HttpResponseFrame.encoding` now also set on the `port` branch for
  non-textual bodies (images, fonts, wasm); hub decodes to bytes.
- `port` branch uses `redirect: "manual"` so 3xx reach the browser.
- `HttpResponseFrame.setCookies?: string[]` — each `Set-Cookie` separately;
  the flat header map would fold several into one unparseable value.
- `WsOpenFrame.port?: number` — open the local WebSocket against
  `localhost:<port>` with `Origin: http://localhost:<port>` (what Vite's
  `allowedHosts` / Next's `allowedDevOrigins` expect) instead of the worker's
  own Fastify.
- Capability `passthrough:preview-proxy` (replaces `passthrough:browser-proxy`,
  removed with its only call site). The mint route refuses with
  `409 worker-upgrade-required` when the target worker lacks it.

### Removed

- `browser-manager.ts`, `routes/browser-routes.ts`, `routes/browser-proxy-routes.ts`,
  `utils/ssrf-guard.ts`, the `playwright-core` optional dependency.
- Main Chat browser tools (`openPreview`, `clickElement`, `fillInput`,
  `selectOption`, `pressKey`, `screenshot`, `getPageContent`, `waitForElement`),
  `[Browser Event]` turns and the `toolless` turn flag, the `browserCommand` /
  `openPreviewFrame` / `browser_result` WS messages.
- Frontend `BrowserFramesProvider`, `web-preview.tsx`, the iframe panel.

### Storage

```sql
CREATE TABLE preview_links (
  slug TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,          -- "local" or remote_servers.id
  port INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  UNIQUE (project_id, target_id, port)
);
```

Rows for a remote are removed when the remote server is deleted
(`remoteServers.delete`), in repository code, not by trigger.

## Limitations / follow-ups

- Bodies ride the JSON control channel whole (base64 for binary): fine for dev
  bundles, not for very large downloads. Streaming/binary frames are a later
  tunnel change.
- WebSocket payloads are text only on the virtual channel (HMR is text).
- A worker older than the capability shows "update the worker" instead of a
  preview; there is no fallback to the old same-origin proxy by design.
- Embedding the preview back into the Browser tab as an iframe is possible
  now that the origin is foreign, but needs `SameSite=None` cookies, which
  Safari blocks in iframes — new tab stays the default.
