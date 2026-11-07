import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import type { ReverseConnectManager } from "../reverse-connect-manager.js";
import type { Storage } from "../storage/types.js";
import { VirtualWsAdapter } from "../virtual-ws-adapter.js";
import { LOCAL_PREVIEW_TARGET } from "../storage/repositories/preview-links.js";
import { PREVIEW_COOKIE_NAME, parseCookieHeader, stripPreviewCookies, type PreviewAuth } from "./preview-auth.js";
import { previewOrigin, previewSlugFromHost, type PreviewHostConfig } from "./preview-host.js";

/**
 * The preview origin's request handler (docs/preview-links-design.md).
 *
 * Runs at the Node http layer, in front of Fastify: a request whose Host is
 * `<slug>.<preview-host>` never enters the app's router, hooks or Clerk
 * middleware, so a previewed app's `/api/config` or `/favicon.ico` cannot
 * collide with the hub's own routes and no app credential is ever evaluated
 * on a preview host. Everything here is plain HTTP in, tunnel out.
 */

export interface PreviewProxyDeps {
  config: PreviewHostConfig;
  storage: Storage;
  reverseConnectManager: ReverseConnectManager;
  auth: PreviewAuth;
  /** Hosted mode: the cookie must match the link's owner. Solo: anyone on the loopback hub. */
  authEnabled: boolean;
  /** App base URL for the "sign in to open this preview" bounce; null = no link offered. */
  publicUrl: string | null;
  /** Hub-side bound on bodies read into memory before forwarding. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
/** Dev-server fetches through the tunnel; a cold Next compile can take a while. */
const TUNNEL_TIMEOUT_MS = 60_000;
/** `last_used_at` writes per slug are throttled to this. */
const TOUCH_INTERVAL_MS = 60_000;

/** Headers that describe the hop, not the message: never forwarded either way. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
/** Request headers the hub rewrites or that must not reach the dev server. */
const DROPPED_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP,
  "host",
  "content-length",
  // Let the worker's fetch negotiate what it can decode; the body comes back
  // decoded and the hub re-measures it.
  "accept-encoding",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "cf-connecting-ip",
]);
/** Response headers that no longer describe the body the hub writes. */
const DROPPED_RESPONSE_HEADERS = new Set([...HOP_BY_HOP, "content-encoding", "content-length"]);

const TEXTUAL_BODY_RE = /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded)|.*\+(json|xml))/i;

interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  /** Each Set-Cookie header separately; `headers` never carries them. */
  setCookies?: string[];
}

export interface PreviewProxy {
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void;
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void;
}

export function createPreviewProxy(deps: PreviewProxyDeps): PreviewProxy {
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const lastTouched = new Map<string, number>();
  const wss = new WebSocketServer({
    noServer: true,
    // Echo the first subprotocol the page asked for (Vite's HMR client sends
    // "vite-hmr" and the dev server insists on it); the same value is
    // forwarded to the dev server so both ends agree.
    handleProtocols: (protocols) => protocols.values().next().value ?? false,
  });

  async function resolve(req: http.IncomingMessage): Promise<
    | { kind: "no-slug" }
    | { kind: "not-found"; slug: string }
    | { kind: "unauthorized"; slug: string }
    | { kind: "ok"; slug: string; link: NonNullable<Awaited<ReturnType<Storage["previewLinks"]["getBySlug"]>>> }
  > {
    const slug = previewSlugFromHost(req.headers.host, deps.config);
    if (!slug) return { kind: "no-slug" };
    const link = await deps.storage.previewLinks.getBySlug(slug);
    if (!link) return { kind: "not-found", slug };
    if (deps.authEnabled) {
      const cookie = parseCookieHeader(req.headers.cookie).get(PREVIEW_COOKIE_NAME);
      const userId = await deps.auth.verifyCookieValue(cookie, slug);
      if (!userId || userId !== link.user_id) return { kind: "unauthorized", slug };
    }
    return { kind: "ok", slug, link };
  }

  function touch(slug: string): void {
    const now = Date.now();
    if ((lastTouched.get(slug) ?? 0) + TOUCH_INTERVAL_MS > now) return;
    lastTouched.set(slug, now);
    deps.storage.previewLinks.touch(slug).catch(() => { /* bookkeeping only */ });
  }

  function signInUrl(slug: string): string | null {
    if (!deps.publicUrl) return null;
    return `${deps.publicUrl.replace(/\/+$/, "")}/?preview=${encodeURIComponent(slug)}`;
  }

  async function handleAuth(req: http.IncomingMessage, res: http.ServerResponse, slug: string, url: URL): Promise<void> {
    const ticket = url.searchParams.get("t") ?? "";
    const consumed = deps.auth.consumeTicket(ticket, slug);
    if (!consumed) {
      sendPage(res, 403, "Preview link expired", "This link was already used or has expired. Open the preview from Vibedeckx again.", signInUrl(slug));
      return;
    }
    const value = await deps.auth.issueCookieValue(slug, consumed.userId);
    const attrs = [
      `${PREVIEW_COOKIE_NAME}=${value}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${deps.auth.cookieMaxAgeSeconds()}`,
    ];
    if (deps.config.scheme === "https") attrs.push("Secure");
    const next = url.searchParams.get("next");
    const location = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
    res.writeHead(302, { "set-cookie": attrs.join("; "), location, "cache-control": "no-store" });
    res.end();
  }

  async function forward(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://preview.invalid");
    if (url.pathname === "/__vdx/auth") {
      const slug = previewSlugFromHost(req.headers.host, deps.config);
      if (!slug) return sendPage(res, 404, "Not found", "This is not a preview host.");
      return handleAuth(req, res, slug, url);
    }

    const resolved = await resolve(req);
    if (resolved.kind === "no-slug") return sendPage(res, 404, "Not found", "This is not a preview host.");
    if (resolved.kind === "not-found") {
      return sendPage(res, 404, "Preview link not found", "This preview link no longer exists. Create a new one from the project's Browser tab.");
    }
    if (resolved.kind === "unauthorized") {
      return sendPage(res, 401, "Sign in to open this preview", "This preview belongs to a Vibedeckx project. Open it from Vibedeckx so your browser can prove who you are.", signInUrl(resolved.slug));
    }
    const { slug, link } = resolved;

    const body = await readBody(req, maxBodyBytes);
    if (body === null) return sendPage(res, 413, "Request too large", "Bodies over 16 MB cannot be forwarded through the preview.");

    const headers = forwardedRequestHeaders(req, deps.config.scheme);
    const path = url.pathname + url.search;
    const method = req.method ?? "GET";

    let upstream: UpstreamResponse | null;
    try {
      upstream = link.target_id === LOCAL_PREVIEW_TARGET
        ? await fetchLocal(method, link.port, path, headers, body)
        : await fetchRemote(deps.reverseConnectManager, link.target_id, method, link.port, path, headers, body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return sendPage(res, 502, "Preview unavailable", `Nothing answered on port ${link.port}: ${escapeHtml(message)}`);
    }
    if (!upstream) {
      return sendPage(res, 502, "Machine offline", "The machine this preview points at is not connected to Vibedeckx right now.");
    }
    if (upstream.status === 0) {
      return sendPage(res, 504, "Preview timed out", `The dev server on port ${link.port} did not answer in time.`);
    }

    touch(slug);
    const responseHeaders: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
      responseHeaders[name] = value;
    }
    // Several Set-Cookie headers stay several: folded into one value they are
    // unparseable to the browser, and a newline-joined one is an invalid header.
    if (upstream.setCookies && upstream.setCookies.length > 0) responseHeaders["set-cookie"] = upstream.setCookies;
    responseHeaders["content-length"] = String(upstream.body.length);
    responseHeaders["x-vibedeckx-preview"] = slug;
    res.writeHead(upstream.status, responseHeaders);
    res.end(method === "HEAD" ? undefined : upstream.body);
  }

  function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    forward(req, res).catch((err) => {
      console.error("[Preview] request failed:", err);
      if (!res.headersSent) sendPage(res, 500, "Preview error", "Something went wrong forwarding this request.");
      else res.end();
    });
  }

  async function upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (req.headers.upgrade?.toLowerCase() !== "websocket") {
      return rejectUpgrade(socket, 400, "Bad Request");
    }
    const resolved = await resolve(req);
    if (resolved.kind !== "ok") {
      return rejectUpgrade(socket, resolved.kind === "unauthorized" ? 401 : 404, resolved.kind === "unauthorized" ? "Unauthorized" : "Not Found");
    }
    const { slug, link } = resolved;
    // Every preview of one user is same-site with every other (`a.<host>` and
    // `b.<host>` share a registrable domain), so SameSite cookies do not keep
    // a hostile page on slug b from opening a socket to slug a with a's
    // cookie attached — and WebSocket has no CORS. The browser's Origin is the
    // one thing b cannot forge: require it to be a's own origin before the
    // upstream Origin is rewritten to localhost.
    const origin = typeof req.headers.origin === "string" ? req.headers.origin.toLowerCase() : null;
    if (origin !== previewOrigin(slug, deps.config)) {
      return rejectUpgrade(socket, 403, "Forbidden");
    }
    const url = new URL(req.url ?? "/", "http://preview.invalid");
    const query = url.search ? url.search.slice(1) : undefined;
    const protocols = req.headers["sec-websocket-protocol"];
    touch(slug);

    wss.handleUpgrade(req, socket, head, (client) => {
      if (link.target_id === LOCAL_PREVIEW_TARGET) {
        pipeToLocalWebSocket(client, link.port, url.pathname, url.search, client.protocol || undefined);
        return;
      }
      const rcm = deps.reverseConnectManager;
      if (!rcm.isConnected(link.target_id)) {
        client.close(1013, "Machine offline");
        return;
      }
      const channelId = randomUUID();
      const adapter = new VirtualWsAdapter(
        (data) => rcm.sendChannelData(link.target_id, channelId, data),
        () => rcm.closeChannel(link.target_id, channelId),
      );
      rcm.setChannelAdapter(link.target_id, channelId, adapter);
      rcm.openVirtualChannel(link.target_id, channelId, url.pathname, query, link.port, typeof protocols === "string" ? protocols : undefined);

      client.on("message", (data) => adapter.send(data.toString()));
      adapter.on("message", (data: string) => {
        try { client.send(data); } catch { /* client gone */ }
      });
      client.on("close", () => adapter.close());
      adapter.on("close", () => {
        try { client.close(); } catch { /* already closed */ }
      });
    });
  }

  function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    upgrade(req, socket, head).catch((err) => {
      console.error("[Preview] upgrade failed:", err);
      socket.destroy();
    });
  }

  return { handleRequest, handleUpgrade };
}

// ---------------------------------------------------------------------------
// Forwarding
// ---------------------------------------------------------------------------

function forwardedRequestHeaders(req: http.IncomingMessage, scheme: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(name)) continue;
    if (name === "cookie") {
      const kept = stripPreviewCookies(Array.isArray(value) ? value.join("; ") : value);
      if (kept) out.cookie = kept;
      continue;
    }
    out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  // The dev server sees a request for localhost:<port> (the worker's fetch sets
  // Host from the URL); tell it where the browser really is for apps that care.
  if (req.headers.host) out["x-forwarded-host"] = req.headers.host;
  out["x-forwarded-proto"] = scheme;
  return out;
}

async function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  if (req.method === "GET" || req.method === "HEAD") {
    req.resume();
    return Buffer.alloc(0);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      req.destroy();
      return null;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function encodeBody(headers: Record<string, string>, body: Buffer): { body: string | undefined; encoding: "base64" | undefined } {
  if (body.length === 0) return { body: undefined, encoding: undefined };
  const contentType = headers["content-type"] ?? "";
  if (TEXTUAL_BODY_RE.test(contentType)) return { body: body.toString("utf8"), encoding: undefined };
  return { body: body.toString("base64"), encoding: "base64" };
}

async function fetchRemote(
  rcm: ReverseConnectManager,
  remoteServerId: string,
  method: string,
  port: number,
  path: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<UpstreamResponse | null> {
  if (!rcm.isConnected(remoteServerId)) return null;
  const encoded = encodeBody(headers, body);
  const raw = await rcm.sendRawHttpRequest(remoteServerId, method, path, headers, encoded.body, TUNNEL_TIMEOUT_MS, port, encoded.encoding);
  // A worker that predates `setCookies` folds cookies into `headers`; drop
  // that unparseable value rather than forward it (it is capability-gated anyway).
  const { "set-cookie": folded, ...rest } = raw.headers;
  void folded;
  return {
    status: raw.status,
    headers: rest,
    body: raw.encoding === "base64" ? Buffer.from(raw.body, "base64") : Buffer.from(raw.body, "utf8"),
    setCookies: raw.setCookies,
  };
}

/** Solo mode: the dev server runs on the hub's own machine. */
async function fetchLocal(
  method: string,
  port: number,
  path: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<UpstreamResponse> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" || body.length === 0 ? undefined : new Uint8Array(body),
    redirect: "manual",
    signal: AbortSignal.timeout(TUNNEL_TIMEOUT_MS),
  });
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") responseHeaders[key] = value;
  });
  return {
    status: response.status,
    headers: responseHeaders,
    body: Buffer.from(await response.arrayBuffer()),
    setCookies: response.headers.getSetCookie(),
  };
}

function pipeToLocalWebSocket(client: WsWebSocket, port: number, pathname: string, search: string, protocol: string | undefined): void {
  const target = new WsWebSocket(`ws://127.0.0.1:${port}${pathname}${search}`, protocol ? [protocol] : [], {
    headers: { origin: `http://localhost:${port}` },
  });
  const pending: Array<Buffer | string> = [];
  client.on("message", (data, isBinary) => {
    const payload = isBinary ? (data as Buffer) : data.toString();
    if (target.readyState === WsWebSocket.OPEN) target.send(payload);
    else pending.push(payload);
  });
  target.on("open", () => {
    for (const payload of pending) target.send(payload);
    pending.length = 0;
  });
  target.on("message", (data, isBinary) => {
    try { client.send(data, { binary: isBinary }); } catch { /* client gone */ }
  });
  client.on("close", () => target.close());
  target.on("close", (code, reason) => {
    try { client.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, reason.toString()); } catch { /* ignore */ }
  });
  target.on("error", () => {
    try { client.close(1011, "Local WebSocket error"); } catch { /* ignore */ }
  });
}

// ---------------------------------------------------------------------------
// Plumbing: attach the preview dispatcher to a Node server
// ---------------------------------------------------------------------------

export interface PreviewDispatch {
  /** Whether this request is addressed to a preview host. */
  matches(req: http.IncomingMessage): boolean;
  /** Installed once the hub's services exist; before that preview hosts get a 503. */
  setProxy(proxy: PreviewProxy): void;
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void;
  /**
   * Route `upgrade` events: preview hosts go to the proxy, everything else to
   * the listeners the app (and @fastify/websocket) register afterwards. Must
   * run before those registrations — it wraps the server's `on`.
   */
  attachUpgrade(server: http.Server | https.Server): void;
}

export function createPreviewDispatch(config: PreviewHostConfig): PreviewDispatch {
  let proxy: PreviewProxy | null = null;
  const matches = (req: http.IncomingMessage) => previewSlugFromHost(req.headers.host, config) !== null;
  return {
    matches,
    setProxy(next) {
      proxy = next;
    },
    handleRequest(req, res) {
      if (!proxy) return sendPage(res, 503, "Starting up", "The preview service is still starting. Retry in a moment.");
      proxy.handleRequest(req, res);
    },
    attachUpgrade(server) {
      type UpgradeListener = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
      const addListener = server.on.bind(server);
      const wrap = (listener: UpgradeListener): UpgradeListener => (req, socket, head) => {
        if (matches(req)) return;
        listener(req, socket, head);
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const patched = function (this: http.Server, event: string | symbol, listener: (...args: any[]) => void) {
        if (event === "upgrade") return addListener("upgrade", wrap(listener as unknown as UpgradeListener));
        return addListener(event as string, listener);
      } as typeof server.on;
      server.on = patched;
      server.addListener = patched;
      addListener("upgrade", (req, socket, head) => {
        if (!matches(req)) return;
        if (!proxy) return rejectUpgrade(socket, 503, "Service Unavailable");
        proxy.handleUpgrade(req, socket, head);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function sendPage(res: http.ServerResponse, status: number, title: string, message: string, link: string | null = null): void {
  const action = link
    ? `<p><a href="${escapeHtml(link)}">Open in Vibedeckx</a></p>`
    : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0d;color:#e6e6e8}main{max-width:28rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#a1a1aa;line-height:1.5}a{color:#8ab4ff}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${message}</p>${action}</main></body></html>`;
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(Buffer.byteLength(html)),
    "cache-control": "no-store",
  });
  res.end(html);
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    // Socket already gone.
  }
  socket.destroy();
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
