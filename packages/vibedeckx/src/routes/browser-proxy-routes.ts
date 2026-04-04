import { randomUUID } from "crypto";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import WsWebSocket from "ws";
import type { ReverseConnectManager, RawHttpResponse } from "../reverse-connect-manager.js";
import { VirtualWsAdapter } from "../virtual-ws-adapter.js";
import "../server-types.js";

/**
 * Fetch a URL either directly or via reverse-connect tunnel.
 * Tries reverse-connect first if the project has a remote server connected.
 */
async function proxyFetch(
  targetUrl: string,
  requestHeaders: Record<string, string>,
  reverseConnectManager: ReverseConnectManager | null,
  remoteServerId: string | null,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  // Try reverse-connect if available
  if (remoteServerId && reverseConnectManager?.isConnected(remoteServerId)) {
    const parsed = new URL(targetUrl);
    const path = parsed.pathname + parsed.search;
    const raw = await reverseConnectManager.sendRawHttpRequest(
      remoteServerId,
      "GET",
      path,
      requestHeaders,
    );
    return { status: raw.status, headers: raw.headers, body: raw.body };
  }

  // Direct fetch
  const response = await fetch(targetUrl, {
    headers: requestHeaders,
    redirect: "follow",
  });

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

  // --- Command Receiver (from parent frame via postMessage) ---
  window.addEventListener("message", function(e) {
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
    try {
      window.parent.postMessage(result, "*");
    } catch(e) { /* ignore */ }
  });

  // --- Report to Parent Frame ---
  function report(type, data) {
    try {
      window.parent.postMessage({
        type: "vibedeckx-browser-error",
        projectId: PROJECT_ID,
        error: { type: type, data: data, timestamp: Date.now(), url: location.href }
      }, "*");
    } catch(e) { /* ignore */ }
  }
})();
</script>`;
}

const routes: FastifyPluginAsync = async (fastify) => {
  // --- HTTP Reverse Proxy ---
  fastify.get<{
    Params: { id: string; "*": string };
  }>("/api/projects/:id/browser/proxy/*", async (req, reply) => {
    const { id: projectId } = req.params;
    const targetUrl = extractTargetUrl(req.url, projectId);

    if (!targetUrl) {
      return reply.code(400).send({ error: "Invalid proxy URL" });
    }

    try {
      const parsedTarget = new URL(targetUrl);
      const targetOrigin = parsedTarget.origin;
      const proxyPrefix = `/api/projects/${projectId}/browser/proxy/`;
      const proxyWsPrefix = `/api/projects/${projectId}/browser/proxy-ws/`;

      // Look up remote server for this project (for reverse-connect routing)
      const projectRemotes = fastify.storage.projectRemotes.getByProject(projectId);
      const remoteServerId = projectRemotes.length > 0 ? projectRemotes[0].remote_server_id : null;

      // Fetch from the remote server (via reverse-connect or direct)
      const response = await proxyFetch(
        targetUrl,
        {
          "User-Agent": (req.headers["user-agent"] as string) || "Vibedeckx-Proxy/1.0",
          "Accept": (req.headers.accept as string) || "*/*",
          "Accept-Language": (req.headers["accept-language"] as string) || "en",
          "Cookie": (req.headers.cookie as string) || "",
        },
        fastify.reverseConnectManager,
        remoteServerId,
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
      const msg = err instanceof Error ? err.message : "Proxy request failed";
      console.error(`[BrowserProxy] Error proxying ${targetUrl}:`, msg);
      return reply.code(502).send({ error: `Proxy error: ${msg}` });
    }
  });

  // --- WebSocket Reverse Proxy (for HMR) ---
  fastify.get<{
    Params: { id: string; "*": string };
  }>("/api/projects/:id/browser/proxy-ws/*", { websocket: true }, (socket, req) => {
    const { id: projectId } = req.params;
    const rawPath = req.url;
    const prefix = `/api/projects/${projectId}/browser/proxy-ws/`;
    const idx = rawPath.indexOf(prefix);
    if (idx === -1) {
      socket.close(4000, "Invalid proxy-ws URL");
      return;
    }
    const targetWsUrl = decodeURIComponent(rawPath.slice(idx + prefix.length));

    console.log(`[BrowserProxy] WS proxy: ${targetWsUrl}`);

    // Check if we should route through reverse-connect
    const projectRemotes = fastify.storage.projectRemotes.getByProject(projectId);
    const remoteServerId = projectRemotes.length > 0 ? projectRemotes[0].remote_server_id : null;
    const rcm = fastify.reverseConnectManager;

    if (remoteServerId && rcm.isConnected(remoteServerId)) {
      // Route via reverse-connect virtual channel
      const channelId = randomUUID();
      const parsed = new URL(targetWsUrl);
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

    // Direct WebSocket connection
    const remote = new WsWebSocket(targetWsUrl);

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
