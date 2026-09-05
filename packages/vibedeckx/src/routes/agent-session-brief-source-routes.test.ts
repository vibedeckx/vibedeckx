import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { AgentMessage } from "../agent-types.js";

vi.mock("../utils/remote-proxy.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, proxyToRemoteAuto: vi.fn(), proxyStatus: (r: { status: number }) => r.status };
});

import agentSessionRoutes from "./agent-session-routes.js";

const SESSION_ID = "s-1";

function makeApp(messages: AgentMessage[], sessionExists = true) {
  const app = Fastify();
  app.decorate("authEnabled", false);
  app.decorate("storage", {});
  app.decorate("agentSessionManager", {
    getSession: () => (sessionExists ? { id: SESSION_ID } : undefined),
    loadMessages: async () => messages,
    getSessionProcessAlive: () => true,
  });
  app.decorate("remoteSessionMap", new Map());
  app.decorate("remotePatchCache", {});
  app.decorate("reverseConnectManager", null);
  return app;
}

/**
 * The route exists to keep a session's bulk off the tunnel: distillation reads
 * user and assistant text only, and a real session's tool traffic is ~70x that.
 */
describe("GET /api/agent-sessions/:id/brief-source", () => {
  let app: FastifyInstance;
  afterEach(async () => { await app?.close(); });

  it("returns conversation text and drops everything distillation ignores", async () => {
    app = makeApp([
      { type: "user", content: "build the exporter", timestamp: 1 },
      { type: "thinking", content: "considering options".repeat(500), timestamp: 2 },
      { type: "tool_use", tool: "Write", input: { content: "x".repeat(200_000) }, timestamp: 3 },
      { type: "tool_result", tool: "Write", output: "y".repeat(200_000), timestamp: 4 },
      { type: "assistant", content: "done, sorted by primary key", timestamp: 5 },
      { type: "turn_end", timestamp: 6 },
    ]);
    await app.register(agentSessionRoutes);

    const res = await app.inject({ method: "GET", url: `/api/agent-sessions/${SESSION_ID}/brief-source` });

    expect(res.statusCode).toBe(200);
    // Timestamps are zeroed — nothing in the distillation pipeline reads them.
    expect(res.json().messages).toEqual([
      { type: "user", content: "build the exporter", timestamp: 0 },
      { type: "assistant", content: "done, sorted by primary key", timestamp: 0 },
    ]);
    // The point of the route: the 400KB of tool payload never crosses the wire.
    expect(res.payload.length).toBeLessThan(1_000);
  });

  // Harness-injected notifications are user-typed but not user-written, so the
  // distiller skips them — the projection must skip them for the same reason.
  it("skips event-carrying user entries", async () => {
    app = makeApp([
      {
        type: "user",
        content: "background task finished",
        timestamp: 1,
        event: { kind: "agent_task_completed", sessionId: "other", turnEndEntryIndex: 3 },
      },
      { type: "user", content: "real question", timestamp: 2 },
    ]);
    await app.register(agentSessionRoutes);

    const res = await app.inject({ method: "GET", url: `/api/agent-sessions/${SESSION_ID}/brief-source` });

    expect(res.json().messages).toEqual([{ type: "user", content: "real question", timestamp: 0 }]);
  });

  it("404s an unknown session", async () => {
    app = makeApp([], false);
    await app.register(agentSessionRoutes);

    const res = await app.inject({ method: "GET", url: `/api/agent-sessions/${SESSION_ID}/brief-source` });

    expect(res.statusCode).toBe(404);
  });
});
