import http from "node:http";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus, type GlobalEvent } from "../event-bus.js";

vi.mock("@clerk/backend", () => ({
  verifyToken: async (token: string) => ({ sub: token }),
}));

const { default: eventRoutes } = await import("./event-routes.js");

interface Stream {
  events: Array<Record<string, unknown>>;
  close: () => void;
}

function openStream(base: string, token?: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const url = `${base}/api/events${token ? `?token=${token}` : ""}`;
    const req = http.get(url, (res) => {
      const stream: Stream = { events: [], close: () => req.destroy() };
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (frame.startsWith("data: ")) stream.events.push(JSON.parse(frame.slice(6)));
          if (frame.includes("hello")) resolve(stream);
        }
      });
    });
    req.on("error", reject);
  });
}

function titleEvent(projectId: string): GlobalEvent {
  return { type: "session:title", projectId, branch: null, sessionId: "s", title: projectId };
}

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe("GET /api/events", () => {
  let app: FastifyInstance | undefined;
  const streams: Stream[] = [];

  afterEach(async () => {
    for (const s of streams.splice(0)) s.close();
    await app?.close();
    app = undefined;
  });

  async function start(authEnabled: boolean, owners: Record<string, string>) {
    const getOwnerId = vi.fn(async (id: string) => owners[id]);
    const bus = new EventBus();
    app = Fastify();
    app.decorate("authEnabled", authEnabled);
    app.decorate("eventBus", bus);
    app.decorate("storage", { projects: { getOwnerId } } as never);
    await app.register(eventRoutes);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    return { bus, base, getOwnerId };
  }

  it("routes each event only to its project owner's streams", async () => {
    const { bus, base, getOwnerId } = await start(true, { pa: "alice", pb: "bob" });
    const alice1 = await openStream(base, "alice");
    const alice2 = await openStream(base, "alice");
    const bob = await openStream(base, "bob");
    streams.push(alice1, alice2, bob);

    bus.emit(titleEvent("pa"));
    bus.emit(titleEvent("pb"));
    bus.emit(titleEvent("pa"));

    const titles = (s: Stream) => s.events.filter((e) => e.type === "session:title").map((e) => e.title);
    await waitFor(() => titles(alice1).length === 2 && titles(alice2).length === 2 && titles(bob).length === 1);

    expect(titles(alice1)).toEqual(["pa", "pa"]);
    expect(titles(alice2)).toEqual(["pa", "pa"]);
    expect(titles(bob)).toEqual(["pb"]);
    // One lookup per project, not per stream × event.
    expect(getOwnerId).toHaveBeenCalledTimes(2);
  });

  it("gives a solo-mode stream every event", async () => {
    const { bus, base, getOwnerId } = await start(false, {});
    const solo = await openStream(base);
    streams.push(solo);

    bus.emit(titleEvent("pa"));
    bus.emit(titleEvent("pb"));
    await waitFor(() => solo.events.filter((e) => e.type === "session:title").length === 2);

    expect(solo.events.filter((e) => e.type === "session:title").map((e) => e.title)).toEqual(["pa", "pb"]);
    expect(getOwnerId).not.toHaveBeenCalled();
  });

  it("rejects a Clerk-mode stream without a token", async () => {
    const { base } = await start(true, {});
    const status = await new Promise<number>((resolve) => {
      http.get(`${base}/api/events`, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    });
    expect(status).toBe(401);
  });
});
