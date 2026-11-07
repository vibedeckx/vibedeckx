import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import { ReverseConnectManager } from "../reverse-connect-manager.js";
import { PreviewAuth } from "./preview-auth.js";
import { createPreviewDispatch, createPreviewProxy } from "./preview-proxy.js";

/**
 * docs/preview-links-design.md: the preview origin end to end against a local
 * dev server (the "local" target), with the dispatcher mounted on a Node
 * server the way server.ts mounts it.
 */
describe("preview proxy", () => {
  let dir: string;
  let storage: Storage;
  let devServer: http.Server;
  let devPort: number;
  let hub: http.Server;
  let hubPort: number;
  let slug: string;
  let auth: PreviewAuth;
  let fallthrough: string[];
  const config = { hostname: "preview.localhost", port: null, scheme: "http" as const };

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255, 254, 253]);

  const startHub = async (authEnabled: boolean) => {
    const dispatch = createPreviewDispatch(config);
    hub = http.createServer();
    dispatch.attachUpgrade(hub);
    fallthrough = [];
    hub.on("request", (req, res) => {
      if (dispatch.matches(req)) return dispatch.handleRequest(req, res);
      fallthrough.push(`${req.headers.host} ${req.url}`);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("app");
    });
    // An "app" upgrade listener registered after attachUpgrade, like @fastify/websocket's.
    const appWss = new WebSocketServer({ noServer: true });
    hub.on("upgrade", (req, socket, head) => {
      fallthrough.push(`upgrade ${req.headers.host} ${req.url}`);
      appWss.handleUpgrade(req, socket, head, (ws) => ws.send("app-ws"));
    });
    hub.listen(0, "127.0.0.1");
    await once(hub, "listening");
    hubPort = (hub.address() as { port: number }).port;
    dispatch.setProxy(createPreviewProxy({
      config,
      storage,
      reverseConnectManager: new ReverseConnectManager(),
      auth,
      authEnabled,
      publicUrl: "https://app.example.com",
    }));
  };

  const request = (opts: { path: string; host?: string; method?: string; headers?: Record<string, string>; body?: Buffer }) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: hubPort,
        method: opts.method ?? "GET",
        path: opts.path,
        headers: { host: opts.host ?? `${slug}.preview.localhost`, ...opts.headers },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end(opts.body);
    });

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-preview-proxy-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "One", path: dir }, "user-1");
    auth = new PreviewAuth(async () => "secret");

    // The "dev server": echoes what it saw, serves a binary, redirects, and speaks WebSocket.
    devServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (req.url === "/logo.png") {
          res.writeHead(200, { "content-type": "image/png" });
          return res.end(png);
        }
        if (req.url === "/old") {
          res.writeHead(302, { location: "/new" });
          return res.end();
        }
        res.writeHead(200, { "content-type": "application/json", "set-cookie": ["sid=1; Path=/", "csrf=2; Path=/; HttpOnly"] });
        res.end(JSON.stringify({
          url: req.url,
          method: req.method,
          host: req.headers.host,
          cookie: req.headers.cookie ?? null,
          forwardedHost: req.headers["x-forwarded-host"],
          bodyLength: Buffer.concat(chunks).length,
        }));
      });
    });
    const devWss = new WebSocketServer({ server: devServer, handleProtocols: (p) => p.values().next().value ?? false });
    devWss.on("connection", (ws, req) => {
      ws.send(JSON.stringify({ hello: req.url, origin: req.headers.origin, protocol: ws.protocol }));
      ws.on("message", (data) => ws.send(`echo:${data.toString()}`));
    });
    devServer.listen(0, "127.0.0.1");
    await once(devServer, "listening");
    devPort = (devServer.address() as { port: number }).port;

    const link = await storage.previewLinks.upsert({ projectId: "p1", targetId: "local", port: devPort, userId: "user-1" });
    slug = link.slug;
  });

  afterEach(async () => {
    hub?.close();
    devServer.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves the dev server at the slug's host, untouched paths and cookies stripped of ours", async () => {
    await startHub(false);
    const res = await request({ path: "/api/items?x=1", headers: { cookie: "vdx_preview=abc; theme=dark" } });
    expect(res.status).toBe(200);
    expect(res.headers["x-vibedeckx-preview"]).toBe(slug);
    expect(res.headers["set-cookie"]).toEqual(["sid=1; Path=/", "csrf=2; Path=/; HttpOnly"]);
    expect(JSON.parse(res.body.toString())).toMatchObject({
      url: "/api/items?x=1",
      method: "GET",
      host: `127.0.0.1:${devPort}`,
      cookie: "theme=dark",
      forwardedHost: `${slug}.preview.localhost`,
    });
    expect(fallthrough).toEqual([]);
  });

  it("passes binary bodies, redirects and request bodies through unchanged", async () => {
    await startHub(false);
    const image = await request({ path: "/logo.png" });
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.body.equals(png)).toBe(true);
    expect(image.headers["content-length"]).toBe(String(png.length));

    const redirect = await request({ path: "/old" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe("/new");

    const posted = await request({ path: "/submit", method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.alloc(1000, 7) });
    expect(JSON.parse(posted.body.toString())).toMatchObject({ method: "POST", bodyLength: 1000 });
  });

  it("leaves non-preview hosts to the app and answers unknown slugs with 404", async () => {
    await startHub(false);
    const app = await request({ path: "/api/config", host: "localhost" });
    expect(app.body.toString()).toBe("app");
    expect(fallthrough).toEqual(["localhost /api/config"]);
    const unknown = await request({ path: "/", host: "zzzzzzzzzz.preview.localhost" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.toString()).toContain("Preview link not found");
  });

  it("in hosted mode requires the ticket→cookie exchange and binds the cookie to the owner", async () => {
    await startHub(true);
    const anonymous = await request({ path: "/" });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.toString()).toContain(`https://app.example.com/?preview=${slug}`);

    const ticket = auth.mintTicket(slug, "user-1");
    const exchanged = await request({ path: `/__vdx/auth?t=${ticket}&next=/dashboard` });
    expect(exchanged.status).toBe(302);
    expect(exchanged.headers.location).toBe("/dashboard");
    const cookie = (exchanged.headers["set-cookie"] as string[])[0];
    expect(cookie).toMatch(/^vdx_preview=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
    expect((await request({ path: `/__vdx/auth?t=${ticket}` })).status).toBe(403);

    const withCookie = await request({ path: "/dashboard", headers: { cookie: cookie.split(";")[0] } });
    expect(withCookie.status).toBe(200);
    expect(JSON.parse(withCookie.body.toString()).cookie).toBeNull();

    // A cookie for the same slug but another user is refused.
    const other = await auth.issueCookieValue(slug, "user-2");
    expect((await request({ path: "/", headers: { cookie: `vdx_preview=${other}` } })).status).toBe(401);
  });

  it("tunnels WebSocket upgrades on preview hosts (with subprotocol) and leaves app upgrades alone", async () => {
    await startHub(false);
    const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/_hmr?token=1`, ["vite-hmr"], {
      headers: { host: `${slug}.preview.localhost`, origin: `http://${slug}.preview.localhost` },
    });
    const [first] = await once(ws, "message");
    expect(JSON.parse(first.toString())).toEqual({ hello: "/_hmr?token=1", origin: `http://localhost:${devPort}`, protocol: "vite-hmr" });
    expect(ws.protocol).toBe("vite-hmr");
    ws.send("ping");
    const [echo] = await once(ws, "message");
    expect(echo.toString()).toBe("echo:ping");
    ws.close();

    const appWs = new WebSocket(`ws://127.0.0.1:${hubPort}/ws`, { headers: { host: "localhost" } });
    const [msg] = await once(appWs, "message");
    expect(msg.toString()).toBe("app-ws");
    expect(fallthrough).toEqual(["upgrade localhost /ws"]);
    appWs.close();
  });

  it("refuses a WebSocket handshake whose Origin is another preview (same-site, cookie attached)", async () => {
    await startHub(true);
    const cookie = await auth.issueCookieValue(slug, "user-1");
    const attempt = (origin: string | undefined) => new Promise<number | "open">((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/_hmr`, {
        headers: { host: `${slug}.preview.localhost`, cookie: `vdx_preview=${cookie}`, ...(origin ? { origin } : {}) },
      });
      ws.on("unexpected-response", (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
      ws.on("error", () => { /* reported via unexpected-response */ });
      ws.on("open", () => { resolve("open"); ws.close(); });
    });
    expect(await attempt(`http://zzzzzzzzzz.preview.localhost`)).toBe(403);
    expect(await attempt(undefined)).toBe(403);
    expect(await attempt(`http://${slug}.preview.localhost`)).toBe("open");
  });

  it("forwards the remote branch's bytes and separate Set-Cookie headers from the tunnel", async () => {
    await startHub(false);
    const remoteLink = await storage.previewLinks.upsert({ projectId: "p1", targetId: "box-1", port: 3000, userId: "user-1" });
    const calls: unknown[][] = [];
    // Duck-typed tunnel manager standing in for a connected worker.
    const fakeRcm = {
      isConnected: () => true,
      sendRawHttpRequest: async (...args: unknown[]) => {
        calls.push(args);
        return {
          ok: true,
          status: 200,
          headers: { "content-type": "image/png", "set-cookie": "folded=by-old-worker", "content-encoding": "gzip" },
          body: png.toString("base64"),
          encoding: "base64" as const,
          setCookies: ["a=1; Path=/", "b=2; Path=/"],
        };
      },
    };
    const dispatch = createPreviewDispatch(config);
    dispatch.setProxy(createPreviewProxy({
      config, storage, auth, authEnabled: false, publicUrl: null,
      reverseConnectManager: fakeRcm as unknown as ReverseConnectManager,
    }));
    hub.removeAllListeners("request");
    hub.on("request", (req, res) => dispatch.handleRequest(req, res));

    const res = await request({ path: "/logo.png", host: `${remoteLink.slug}.preview.localhost`, method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.from([1, 2, 3]) });
    expect(res.status).toBe(200);
    expect(res.body.equals(png)).toBe(true);
    expect(res.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(res.headers["content-encoding"]).toBeUndefined();
    // method, path, port and base64 body encoding reached the tunnel call.
    expect(calls[0][1]).toBe("POST");
    expect(calls[0][2]).toBe("/logo.png");
    expect(calls[0][6]).toBe(3000);
    expect(calls[0][7]).toBe("base64");
    expect(calls[0][4]).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  });
});
