import { randomUUID } from "crypto";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import WsWebSocket from "ws";
import type { ReverseConnectManager, RawHttpResponse } from "../reverse-connect-manager.js";
import { VirtualWsAdapter } from "../virtual-ws-adapter.js";
import { requireAuth } from "../server.js";
import { authenticateWs } from "./ws-authz.js";
import {
  assertSchemeAllowed,
  assertHostAllowed,
  guardedLookup,
  guardedDispatcher,
  findSsrfCause,
  SsrfBlockedError,
} from "../utils/ssrf-guard.js";
import "../server-types.js";

/**
 * Extra trusted embedder (parent-frame) origin for the postMessage command
 * channel, for custom split-origin deployments where the UI is served from a
 * different origin than the proxy. Same-origin (bundled) and the standard dev
 * setup (:3000 → :5173) are handled by the injected script's built-in defaults.
 */
const EXTRA_UI_ORIGIN = process.env.VIBEDECKX_UI_ORIGIN?.trim() || null;

export interface ResolvedTarget {
  /** The remote server ID if routed via reverse-connect, null for direct fetch */
  remoteServerId: string | null;
  /** The URL to fetch — for reverse-connect this is http://localhost:{port}{path} on the remote */
  fetchUrl: string;
  /** The origin as the user typed it (used for URL rewriting in HTML) */
  userOrigin: string;
}

/**
 * Resolve a target URL to either a reverse-connected remote server or a direct URL.
 *
 * URL format for reverse-connect: http://{remote-server-name}:{port}/{path}
 * The hostname is matched against project remote server names (case-insensitive).
 * If matched, the request is routed through the reverse-connect tunnel as
 * http://localhost:{port}/{path} on the remote side.
 */
export function resolveTarget(
  targetUrl: string,
  projectRemotes: Array<{ remote_server_id: string; server_name: string }>,
  reverseConnectManager: ReverseConnectManager | null,
): ResolvedTarget {
  const parsed = new URL(targetUrl);
  const hostname = parsed.hostname;

  // Try to match hostname against project remote server names
  for (const remote of projectRemotes) {
    if (remote.server_name.toLowerCase() === hostname.toLowerCase()) {
      const serverId = remote.remote_server_id;
      if (reverseConnectManager?.isConnected(serverId)) {
        // Rewrite to localhost on the remote side, preserving port and path
        const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
        const localUrl = `http://localhost:${port}${parsed.pathname}${parsed.search}`;
        return {
          remoteServerId: serverId,
          fetchUrl: localUrl,
          userOrigin: parsed.origin,
        };
      }
    }
  }

  // No match or not connected — direct fetch
  return { remoteServerId: null, fetchUrl: targetUrl, userOrigin: parsed.origin };
}

/**
 * Fetch a URL either directly or via reverse-connect tunnel.
 */
async function proxyFetch(
  resolved: ResolvedTarget,
  requestHeaders: Record<string, string>,
  reverseConnectManager: ReverseConnectManager | null,
  enforceSsrf: boolean,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  if (resolved.remoteServerId && reverseConnectManager?.isConnected(resolved.remoteServerId)) {
    const parsed = new URL(resolved.fetchUrl);
    const port = parsed.port ? parseInt(parsed.port, 10) : undefined;
    const path = parsed.pathname + parsed.search;
    const raw = await reverseConnectManager.sendRawHttpRequest(
      resolved.remoteServerId,
      "GET",
      path,
      requestHeaders,
      undefined,
      undefined,
      port,
    );
    return { status: raw.status, headers: raw.headers, body: raw.body };
  }

  // Direct fetch — the control plane connects to the target itself.
  // In hosted mode, enforce SSRF egress filtering. The initial host is pre-checked
  // here for a clean error; the guarded dispatcher then re-validates and pins every
  // connection, including redirect hops and IP-literal targets.
  if (enforceSsrf) {
    assertSchemeAllowed(resolved.fetchUrl, "http");
    await assertHostAllowed(new URL(resolved.fetchUrl).hostname);
  }
  const response = await fetch(resolved.fetchUrl, {
    headers: requestHeaders,
    redirect: "follow",
    ...(enforceSsrf ? { dispatcher: guardedDispatcher } : {}),
  } as RequestInit & { dispatcher?: unknown });

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  const body = await response.text();
  return { status: response.status, headers: responseHeaders, body };
}

/**
 * Extracts the target URL from the proxy route path.
 * Route: /api/projects/:id/browser/proxy/https://remote:3000/page
 * Returns: https://remote:3000/page
 */
function extractTargetUrl(requestUrl: string, projectId: string): string | null {
  const prefix = `/api/projects/${projectId}/browser/proxy/`;
  const idx = requestUrl.indexOf(prefix);
  if (idx === -1) return null;
  let target = requestUrl.slice(idx + prefix.length);
  return decodeURIComponent(target);
}

/**
 * Strips security headers that would block iframe embedding or script injection.
 */
function stripSecurityHeaders(headers: Record<string, string>): Record<string, string> {
  const stripped = { ...headers };
  const blockedHeaders = [
    "content-security-policy",
    "content-security-policy-report-only",
    "x-frame-options",
    "x-content-type-options",
  ];
  for (const key of blockedHeaders) {
    delete stripped[key];
  }
  return stripped;
}

/**
 * Rewrites URLs in HTML content so relative/absolute paths go through the proxy.
 */
function rewriteHtml(
  html: string,
  targetOrigin: string,
  proxyPrefix: string,
): string {
  // Rewrite absolute paths (href="/...", src="/...")
  // Match: href="/ or src="/ or action="/ (but not href="//")
  const attrPattern = /((?:href|src|action|data-src|poster)=["'])\/(?!\/)/gi;
  let result = html.replace(attrPattern, `$1${proxyPrefix}${targetOrigin}/`);

  // Rewrite absolute URLs pointing to the target origin
  const originEscaped = targetOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const originPattern = new RegExp(
    `((?:href|src|action|data-src|poster)=["'])${originEscaped}`,
    "gi",
  );
  result = result.replace(originPattern, `$1${proxyPrefix}${targetOrigin}`);

  return result;
}

/**
 * Generates the error capture + WebSocket rewriting script to inject into HTML pages.
 */
function generateInjectedScript(projectId: string, targetOrigin: string, proxyWsPrefix: string): string {
  return `
<script data-vibedeckx-injected>
(function() {
  var PROJECT_ID = ${JSON.stringify(projectId)};
  var TARGET_ORIGIN = ${JSON.stringify(targetOrigin)};
  var WS_PROXY_PREFIX = ${JSON.stringify(proxyWsPrefix)};

  // --- JS Error Capture ---
  window.addEventListener("error", function(e) {
    report("js_error", {
      message: e.message,
      source: e.filename,
      line: e.lineno,
      col: e.colno,
      stack: e.error ? e.error.stack : null
    });
  });

  window.addEventListener("unhandledrejection", function(e) {
    var reason = e.reason || {};
    report("promise_rejection", {
      message: reason.message || String(reason),
      stack: reason.stack || null
    });
  });

  // --- Console Error Capture ---
  var origError = console.error;
  console.error = function() {
    var args = Array.from(arguments);
    origError.apply(console, args);
    report("console_error", {
      message: args.map(function(a) {
        return typeof a === "object" ? JSON.stringify(a) : String(a);
      }).join(" ")
    });
  };

  // --- Network Error Capture ---
  var origFetch = window.fetch;
  window.fetch = function() {
    var args = arguments;
    var url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url ? args[0].url : "");
    return origFetch.apply(this, args).then(function(res) {
      if (!res.ok) {
        report("network_error", { url: url, status: res.status, statusText: res.statusText });
      }
      return res;
    }).catch(function(err) {
      report("network_error", { url: url, message: err.message });
      throw err;
    });
  };

  // --- WebSocket Rewriting for HMR ---
  var OrigWebSocket = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    var rewritten = url;
    try {
      var parsed = new URL(url, location.href);
      if (parsed.origin === TARGET_ORIGIN || parsed.hostname === new URL(TARGET_ORIGIN).hostname) {
        var wsScheme = location.protocol === "https:" ? "wss:" : "ws:";
        rewritten = wsScheme + "//" + location.host + WS_PROXY_PREFIX + parsed.protocol + "//" + parsed.host + parsed.pathname + parsed.search;
      }
    } catch(e) { /* keep original URL */ }
    return protocols !== undefined
      ? new OrigWebSocket(rewritten, protocols)
      : new OrigWebSocket(rewritten);
  };
  window.WebSocket.prototype = OrigWebSocket.prototype;
  Object.defineProperty(window.WebSocket, "CONNECTING", { value: OrigWebSocket.CONNECTING });
  Object.defineProperty(window.WebSocket, "OPEN", { value: OrigWebSocket.OPEN });
  Object.defineProperty(window.WebSocket, "CLOSING", { value: OrigWebSocket.CLOSING });
  Object.defineProperty(window.WebSocket, "CLOSED", { value: OrigWebSocket.CLOSED });

  // --- Trusted embedder (parent-frame) origins ---
  // The command channel only honors messages from, and only returns DOM data to,
  // the Vibedeckx UI. A malicious site that iframes this proxy is a different
  // origin, so its commands are ignored and no proxied DOM is posted back to it.
  // Bundled production serves the UI same-origin (location.origin); the dev setup
  // runs the UI on :3000 against the proxy on :5173 (cross-origin).
  var TRUSTED_PARENT_ORIGINS = [location.origin, "http://localhost:3000", "http://127.0.0.1:3000"];
  ${EXTRA_UI_ORIGIN ? `TRUSTED_PARENT_ORIGINS.push(${JSON.stringify(EXTRA_UI_ORIGIN)});` : ""}
  function isTrustedParent(origin) {
    return TRUSTED_PARENT_ORIGINS.indexOf(origin) !== -1;
  }

  // --- Command Receiver (from parent frame via postMessage) ---
  window.addEventListener("message", function(e) {
    if (e.source !== window.parent || !isTrustedParent(e.origin)) return;
    if (!e.data || e.data.type !== "vibedeckx-command") return;
    var cmd = e.data;
    var result = { type: "vibedeckx-result", id: cmd.id, projectId: PROJECT_ID, success: false };
    try {
      switch (cmd.action) {
        case "click": {
          var clickEl = document.querySelector(cmd.selector);
          if (!clickEl) { result.error = "Element not found: " + cmd.selector; break; }
          clickEl.click();
          result.success = true;
          break;
        }
        case "fill": {
          var fillEl = document.querySelector(cmd.selector);
          if (!fillEl) { result.error = "Element not found: " + cmd.selector; break; }
          var nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, "value"
          ) || Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, "value"
          );
          if (nativeSetter && nativeSetter.set) {
            nativeSetter.set.call(fillEl, cmd.value);
          } else {
            fillEl.value = cmd.value;
          }
          fillEl.dispatchEvent(new Event("input", { bubbles: true }));
          fillEl.dispatchEvent(new Event("change", { bubbles: true }));
          result.success = true;
          break;
        }
        case "select": {
          var selectEl = document.querySelector(cmd.selector);
          if (!selectEl) { result.error = "Element not found: " + cmd.selector; break; }
          selectEl.value = cmd.value;
          selectEl.dispatchEvent(new Event("change", { bubbles: true }));
          result.success = true;
          break;
        }
        case "pressKey": {
          var target = document.activeElement || document.body;
          target.dispatchEvent(new KeyboardEvent("keydown", { key: cmd.key, bubbles: true }));
          target.dispatchEvent(new KeyboardEvent("keypress", { key: cmd.key, bubbles: true }));
          target.dispatchEvent(new KeyboardEvent("keyup", { key: cmd.key, bubbles: true }));
          result.success = true;
          break;
        }
        case "getText": {
          var textEl = cmd.selector ? document.querySelector(cmd.selector) : document.body;
          if (!textEl) { result.error = "Element not found: " + cmd.selector; break; }
          result.content = textEl.innerText || textEl.textContent || "";
          result.success = true;
          break;
        }
        case "getHTML": {
          var htmlEl = cmd.selector ? document.querySelector(cmd.selector) : document.documentElement;
          if (!htmlEl) { result.error = "Element not found: " + cmd.selector; break; }
          result.content = htmlEl.outerHTML;
          result.success = true;
          break;
        }
        case "querySelector": {
          var found = document.querySelector(cmd.selector);
          result.success = true;
          result.found = !!found;
          if (found) {
            result.tag = found.tagName.toLowerCase();
            result.text = (found.innerText || found.textContent || "").slice(0, 200);
          }
          break;
        }
        default:
          result.error = "Unknown action: " + cmd.action;
      }
    } catch(err) {
      result.error = err.message || "Command execution failed";
    }
    // Reply only to the validated embedder origin (never "*"), so a malicious
    // parent can't receive proxied DOM even if it somehow triggered a command.
    try {
      window.parent.postMessage(result, e.origin);
    } catch(e) { /* ignore */ }
  });

  // --- Report to Parent Frame ---
  function report(type, data) {
    var msg = {
      type: "vibedeckx-browser-error",
      projectId: PROJECT_ID,
      error: { type: type, data: data, timestamp: Date.now(), url: location.href }
    };
    // No event origin to echo here, so post to each trusted origin; only the
    // real parent's origin delivers, the rest are dropped by the browser.
    for (var i = 0; i < TRUSTED_PARENT_ORIGINS.length; i++) {
      try { window.parent.postMessage(msg, TRUSTED_PARENT_ORIGINS[i]); } catch(e) { /* ignore */ }
    }
  }
})();
</script>`;
}

const routes: FastifyPluginAsync = async (fastify) => {
  // --- HTTP Reverse Proxy ---
  fastify.get<{
    Params: { id: string; "*": string };
  }>("/api/projects/:id/browser/proxy/*", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (userId === null) return;

    const { id: projectId } = req.params;
    // Ownership: the proxy tunnels into the project's reverse-connected remote
    // (reaching 127.0.0.1:<port> on that host), so a caller must own the project.
    // In solo no-auth mode userId is undefined and getById resolves unscoped.
    if (!fastify.storage.projects.getById(projectId, userId)) {
      return reply.code(404).send({ error: "Project not found" });
    }
    const targetUrl = extractTargetUrl(req.url, projectId);

    if (!targetUrl) {
      return reply.code(400).send({ error: "Invalid proxy URL" });
    }

    try {
      const projectRemotes = fastify.storage.projectRemotes.getByProject(projectId);
      const resolved = resolveTarget(targetUrl, projectRemotes, fastify.reverseConnectManager);
      const targetOrigin = resolved.userOrigin;
      const proxyPrefix = `/api/projects/${projectId}/browser/proxy/`;
      const proxyWsPrefix = `/api/projects/${projectId}/browser/proxy-ws/`;

      // Fetch from the remote server (via reverse-connect or direct)
      const response = await proxyFetch(
        resolved,
        {
          "User-Agent": (req.headers["user-agent"] as string) || "Vibedeckx-Proxy/1.0",
          "Accept": (req.headers.accept as string) || "*/*",
          "Accept-Language": (req.headers["accept-language"] as string) || "en",
          "Cookie": (req.headers.cookie as string) || "",
        },
        fastify.reverseConnectManager,
        fastify.authEnabled,
      );

      const contentType = response.headers["content-type"] || "";

      // Strip security headers
      const safeHeaders = stripSecurityHeaders(response.headers);

      // Add proxy identifier
      safeHeaders["x-vibedeckx-proxy"] = "true";

      // Remove content-encoding since we may modify the body
      delete safeHeaders["content-encoding"];
      delete safeHeaders["content-length"];

      // Set headers on reply
      for (const [key, value] of Object.entries(safeHeaders)) {
        reply.header(key, value);
      }

      if (contentType.includes("text/html")) {
        // HTML response — rewrite URLs and inject script
        let html = response.body;
        html = rewriteHtml(html, targetOrigin, proxyPrefix);

        // Inject error capture script before </body> or at end
        const script = generateInjectedScript(projectId, targetOrigin, proxyWsPrefix);
        if (html.includes("</body>")) {
          html = html.replace("</body>", script + "</body>");
        } else {
          html += script;
        }

        return reply.code(response.status).type("text/html").send(html);
      }

      if (contentType.includes("text/css")) {
        // CSS response — rewrite url() references
        let css = response.body;
        css = css.replace(/url\(\s*['"]?\//g, `url(${proxyPrefix}${targetOrigin}/`);
        return reply.code(response.status).type("text/css").send(css);
      }

      // Non-HTML/CSS — pass through as-is
      return reply.code(response.status).send(response.body);
    } catch (err) {
      // SSRF rejections (scheme or blocked IP) — surface as 403, not a 502.
      // undici may nest the connector error a few levels deep under `.cause`.
      const ssrf = findSsrfCause(err);
      if (ssrf) {
        console.warn(`[BrowserProxy] SSRF blocked for ${targetUrl}: ${ssrf.message}`);
        return reply.code(403).send({ error: "Target address is not allowed" });
      }
      const msg = err instanceof Error ? err.message : "Proxy request failed";
      console.error(`[BrowserProxy] Error proxying ${targetUrl}:`, msg);
      return reply.code(502).send({ error: `Proxy error: ${msg}` });
    }
  });

  // --- WebSocket Reverse Proxy (for HMR) ---
  fastify.get<{
    Params: { id: string; "*": string };
    Querystring: { apiKey?: string; token?: string };
  }>("/api/projects/:id/browser/proxy-ws/*", { websocket: true }, async (socket, req) => {
    const { id: projectId } = req.params;

    // WS upgrades carry no Authorization header (global Clerk preHandler skips
    // them), so auth rides on query params. Then enforce project ownership —
    // the channel pipes into the project's reverse-connected remote.
    const principal = await authenticateWs(fastify.authEnabled, req.query, socket);
    if (!principal) return;
    if (principal.userId !== null && !fastify.storage.projects.getById(projectId, principal.userId)) {
      try { socket.send(JSON.stringify({ error: "Forbidden" })); } catch { /* closed */ }
      try { socket.close(); } catch { /* already closed */ }
      return;
    }

    const rawPath = req.url;
    const prefix = `/api/projects/${projectId}/browser/proxy-ws/`;
    const idx = rawPath.indexOf(prefix);
    if (idx === -1) {
      socket.close(4000, "Invalid proxy-ws URL");
      return;
    }
    const targetWsUrl = decodeURIComponent(rawPath.slice(idx + prefix.length));

    console.log(`[BrowserProxy] WS proxy: ${targetWsUrl}`);

    // Resolve hostname to remote server
    const projectRemotes = fastify.storage.projectRemotes.getByProject(projectId);
    const resolved = resolveTarget(targetWsUrl, projectRemotes, fastify.reverseConnectManager);
    const rcm = fastify.reverseConnectManager;

    if (resolved.remoteServerId && rcm.isConnected(resolved.remoteServerId)) {
      // Route via reverse-connect virtual channel
      const remoteServerId = resolved.remoteServerId;
      const channelId = randomUUID();
      const parsed = new URL(resolved.fetchUrl);
      const wsPath = parsed.pathname;
      const wsQuery = parsed.search ? parsed.search.slice(1) : undefined;

      const adapter = new VirtualWsAdapter(
        (data) => rcm.sendChannelData(remoteServerId, channelId, data),
        () => rcm.closeChannel(remoteServerId, channelId),
      );
      rcm.setChannelAdapter(remoteServerId, channelId, adapter);
      rcm.openVirtualChannel(remoteServerId, channelId, wsPath, wsQuery);

      // Bidirectional pipe via virtual channel
      socket.on("message", (data) => {
        adapter.send(data.toString());
      });

      adapter.on("message", (data: string) => {
        try { socket.send(data); } catch { /* client gone */ }
      });

      socket.on("close", () => {
        adapter.close();
      });

      adapter.on("close", () => {
        try { socket.close(); } catch { /* ignore */ }
      });

      return;
    }

    // Direct WebSocket connection — control plane connects to the target itself.
    // In hosted mode, enforce SSRF egress filtering before/while connecting.
    let remote: WsWebSocket;
    if (fastify.authEnabled) {
      try {
        assertSchemeAllowed(targetWsUrl, "ws");
        await assertHostAllowed(new URL(targetWsUrl).hostname);
      } catch (err) {
        const msg = err instanceof SsrfBlockedError ? err.message : "Invalid target";
        console.warn(`[BrowserProxy] WS SSRF blocked for ${targetWsUrl}: ${msg}`);
        socket.close(4403, "Target address is not allowed");
        return;
      }
      // Pin the validated IP for the connection (DNS-rebinding defense).
      remote = new WsWebSocket(targetWsUrl, { lookup: guardedLookup });
    } else {
      remote = new WsWebSocket(targetWsUrl);
    }

    remote.on("open", () => {
      console.log(`[BrowserProxy] WS proxy connected to ${targetWsUrl}`);
    });

    // Bidirectional pipe
    socket.on("message", (data) => {
      if (remote.readyState === WsWebSocket.OPEN) {
        remote.send(data);
      }
    });

    remote.on("message", (data) => {
      try {
        socket.send(data);
      } catch { /* client gone */ }
    });

    socket.on("close", () => {
      remote.close();
    });

    remote.on("close", () => {
      try { socket.close(); } catch { /* ignore */ }
    });

    remote.on("error", (err) => {
      console.error(`[BrowserProxy] WS proxy error for ${targetWsUrl}:`, err.message);
      try { socket.close(4002, "Remote WS error"); } catch { /* ignore */ }
    });
  });
};

export default fp(routes, { name: "browser-proxy-routes" });
