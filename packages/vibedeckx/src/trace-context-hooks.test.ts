import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { registerTraceContext } from "./trace-context-hooks.js";
import { parseTraceparent } from "./trace-context.js";
import { setupLogging, restoreConsole, shutdownLogging } from "./logger.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const VALID = `00-${TRACE_ID}-${SPAN_ID}-01`;

/**
 * Mirrors the shape of createServer: trace hook first, then a gate that can
 * reject before routing, then routes. The point of the ordering is that the
 * gate's 404 still carries a trace ID.
 */
function buildServer(): FastifyInstance {
  const server = fastify();
  registerTraceContext(server);

  server.addHook("onRequest", (req, reply, done) => {
    if (req.url.startsWith("/gated")) {
      return reply.code(404).send({ error: "Not found" });
    }
    done();
  });

  server.get("/ok", async () => ({ ok: true }));
  server.get("/boom", async () => {
    throw new Error("kaput");
  });
  // Returned, not thrown — the common shape for validation failures, and the
  // one that fires no onError hook.
  server.get("/bad", async (_req, reply) => reply.code(400).send({ error: "nope" }));
  server.get("/log", async (req) => {
    console.error(`handler-log ${(req.query as { tag?: string }).tag}`);
    return { ok: true };
  });
  return server;
}

async function readLogLines(dataDir: string): Promise<Array<Record<string, unknown>>> {
  const file = path.join(dataDir, "logs", "vibedeckx.log");
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, "utf8");
      if (content.length > 0) {
        return content.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return [];
}

describe("registerTraceContext", () => {
  let server: FastifyInstance | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    restoreConsole();
    await shutdownLogging();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  const cases: Array<[string, string, number]> = [
    ["a normal response", "/ok", 200],
    ["a gate rejection that never reaches a route", "/gated/whatever", 404],
    ["an unmatched route", "/nope", 404],
    ["a handler that throws", "/boom", 500],
  ];

  it.each(cases)("sets a valid server traceparent on %s", async (_label, url, status) => {
    server = buildServer();
    const res = await server.inject({ method: "GET", url });
    expect(res.statusCode).toBe(status);
    const header = res.headers.traceparent as string | undefined;
    expect(header, `no traceparent on ${url}`).toBeDefined();
    expect(parseTraceparent(header)).not.toBeNull();
  });

  it("continues a valid inbound trace with its own span", async () => {
    server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/ok",
      headers: { traceparent: VALID },
    });
    const parsed = parseTraceparent(res.headers.traceparent as string);
    expect(parsed?.traceId).toBe(TRACE_ID);
    expect(parsed?.spanId).not.toBe(SPAN_ID);
  });

  it("ignores a malformed inbound trace instead of propagating it", async () => {
    server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/ok",
      headers: { traceparent: `00-${"0".repeat(32)}-${SPAN_ID}-01` },
    });
    const parsed = parseTraceparent(res.headers.traceparent as string);
    expect(parsed).not.toBeNull();
    expect(parsed?.traceId).not.toBe("0".repeat(32));
  });

  it("gives each request a distinct trace", async () => {
    server = buildServer();
    const ids = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const res = await server!.inject({ method: "GET", url: "/ok" });
        return parseTraceparent(res.headers.traceparent as string)?.traceId;
      }),
    );
    expect(new Set(ids).size).toBe(10);
  });

  it("stamps console.* output inside a handler with that request's trace", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vdx-trace-"));
    setupLogging({ dataDir: tmpDir, level: "info", crashHandlers: false });
    server = buildServer();

    const res = await server.inject({ method: "GET", url: "/log?tag=solo" });
    const traceId = parseTraceparent(res.headers.traceparent as string)?.traceId;

    const line = (await readLogLines(tmpDir)).find((l) => l.msg === "handler-log solo");
    expect(line).toBeDefined();
    expect(line?.traceId).toBe(traceId);
  });

  it("does not cross trace IDs between concurrent requests", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vdx-trace-"));
    setupLogging({ dataDir: tmpDir, level: "info", crashHandlers: false });
    server = buildServer();

    const expected = await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const res = await server!.inject({ method: "GET", url: `/log?tag=t${i}` });
        return { tag: `t${i}`, traceId: parseTraceparent(res.headers.traceparent as string)?.traceId };
      }),
    );

    const lines = await readLogLines(tmpDir);
    for (const { tag, traceId } of expected) {
      const line = lines.find((l) => l.msg === `handler-log ${tag}`);
      expect(line, `no log line for ${tag}`).toBeDefined();
      expect(line?.traceId, `${tag} logged under the wrong trace`).toBe(traceId);
    }
    expect(new Set(expected.map((e) => e.traceId)).size).toBe(12);
  });

  it("logs a findable completion line for a normally-returned 400 at the default level", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vdx-trace-"));
    // Default level, not debug — this is the case that matters: a trace ID
    // copied out of devtools has to hit something in the shipped log file.
    setupLogging({ dataDir: tmpDir, level: "info", crashHandlers: false });
    server = buildServer();

    const res = await server.inject({ method: "GET", url: "/bad" });
    expect(res.statusCode).toBe(400);
    const traceId = parseTraceparent(res.headers.traceparent as string)?.traceId;

    const line = (await readLogLines(tmpDir)).find(
      (l) => l.msg === "request completed" && l.traceId === traceId,
    );
    expect(line, "no completion line for the 400 at info level").toBeDefined();
    expect(line?.statusCode).toBe(400);
    expect(line?.level).toBe(40); // warn
  });

  it("logs a completion line for a 500 at the default level", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vdx-trace-"));
    setupLogging({ dataDir: tmpDir, level: "info", crashHandlers: false });
    server = buildServer();

    const res = await server.inject({ method: "GET", url: "/boom" });
    const traceId = parseTraceparent(res.headers.traceparent as string)?.traceId;

    const line = (await readLogLines(tmpDir)).find(
      (l) => l.msg === "request completed" && l.traceId === traceId,
    );
    expect(line).toBeDefined();
    expect(line?.level).toBe(50); // error
  });

  it("keeps successful requests out of the default log", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vdx-trace-"));
    setupLogging({ dataDir: tmpDir, level: "info", crashHandlers: false });
    server = buildServer();

    await server.inject({ method: "GET", url: "/ok" });
    // Force a line so readLogLines has something to return rather than
    // polling for two seconds against an empty file.
    console.error("marker");

    const lines = await readLogLines(tmpDir);
    expect(lines.find((l) => l.msg === "marker")).toBeDefined();
    expect(lines.find((l) => l.msg === "request completed")).toBeUndefined();
  });

  it("leaves logs outside a request unlabeled rather than inventing a trace", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vdx-trace-"));
    setupLogging({ dataDir: tmpDir, level: "info", crashHandlers: false });

    console.error("no-request-here");

    const line = (await readLogLines(tmpDir)).find((l) => l.msg === "no-request-here");
    expect(line).toBeDefined();
    expect(line?.traceId).toBeUndefined();
  });
});
