import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import WsWebSocket from "ws";
import "../server-types.js";

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

      // Fetch from the remote server
      const response = await fetch(targetUrl, {
        headers: {
          "User-Agent": req.headers["user-agent"] || "Vibedeckx-Proxy/1.0",
          "Accept": req.headers.accept || "*/*",
          "Accept-Language": req.headers["accept-language"] || "en",
          "Cookie": req.headers.cookie || "",
        },
        redirect: "follow",
      });

      const contentType = response.headers.get("content-type") || "";

      // Copy response headers (strip security headers)
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      const safeHeaders = stripSecurityHeaders(responseHeaders);

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
        let html = await response.text();
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
        let css = await response.text();
        css = css.replace(/url\(\s*['"]?\//g, `url(${proxyPrefix}${targetOrigin}/`);
        return reply.code(response.status).type("text/css").send(css);
      }

      // Non-HTML/CSS — pass through as-is
      const body = response.body;
      if (body) {
        return reply.code(response.status).send(Buffer.from(await response.arrayBuffer()));
      }
      return reply.code(response.status).send("");
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
