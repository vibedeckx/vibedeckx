import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import http from "http";
import type { AddressInfo } from "net";

const auth = vi.hoisted(() => ({ currentUserId: "user-1" as string | null }));
vi.mock("@clerk/fastify", () => ({
  getAuth: () => ({ userId: auth.currentUserId }),
  clerkClient: {},
}));

import ttsRoutes from "./tts-routes.js";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";

const AUDIO = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);

describe("tts routes", () => {
  let dir: string;
  let storage: Storage;
  let app: FastifyInstance;
  let fetchMock: ReturnType<typeof vi.fn>;

  async function configure(userId = "user-1") {
    auth.currentUserId = userId;
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/tts",
      payload: { credentials: { azure: { apiKey: "secret-key-1234", region: "eastasia" } } },
    });
    expect(res.statusCode).toBe(200);
  }

  beforeEach(async () => {
    auth.currentUserId = "user-1";
    vi.stubEnv("AZURE_SPEECH_KEY", "");
    vi.stubEnv("AZURE_SPEECH_REGION", "");
    fetchMock = vi.fn().mockImplementation(async () => new Response(AUDIO, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    dir = mkdtempSync(path.join(tmpdir(), "vdx-tts-routes-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    app = Fastify();
    app.decorate("authEnabled", true);
    app.decorate("storage", storage);
    await app.register(ttsRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe("settings", () => {
    it("serves defaults with provider metadata when unset", async () => {
      const res = await app.inject({ method: "GET", url: "/api/settings/tts" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ provider: "azure", configured: false, rate: 1 });
      expect(body.providers[0].credentialFields.map((f: { key: string }) => f.key)).toEqual(["apiKey", "region"]);
    });

    it("masks the key, keeps it when the mask is echoed back, isolates users", async () => {
      await configure();
      const get = await app.inject({ method: "GET", url: "/api/settings/tts" });
      expect(get.json().credentials.azure).toEqual({ apiKey: "****1234", region: "eastasia" });
      expect(get.json().configured).toBe(true);

      const echo = await app.inject({
        method: "PUT",
        url: "/api/settings/tts",
        payload: { credentials: { azure: { apiKey: "****1234", region: "westus" } } },
      });
      expect(echo.json().credentials.azure).toEqual({ apiKey: "****1234", region: "westus" });
      const stored = JSON.parse((await storage.userSettings.get("user-1", "tts"))!);
      expect(stored.credentials.azure.apiKey).toBe("secret-key-1234");

      auth.currentUserId = "user-2";
      const other = await app.inject({ method: "GET", url: "/api/settings/tts" });
      expect(other.json().credentials.azure).toEqual({ apiKey: "", region: "" });
    });

    it("rejects invalid voice and rate", async () => {
      const badVoice = await app.inject({ method: "PUT", url: "/api/settings/tts", payload: { voice: "<x>" } });
      expect(badVoice.statusCode).toBe(400);
      const badRate = await app.inject({ method: "PUT", url: "/api/settings/tts", payload: { rate: 3 } });
      expect(badRate.statusCode).toBe(400);
      const ok = await app.inject({ method: "PUT", url: "/api/settings/tts", payload: { voice: "en-US-AvaNeural", rate: 1.25 } });
      expect(ok.json()).toMatchObject({ voice: "en-US-AvaNeural", rate: 1.25 });
    });

    it("401s without a user", async () => {
      auth.currentUserId = null;
      const res = await app.inject({ method: "GET", url: "/api/settings/tts" });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("synthesize", () => {
    it("409s when not configured", async () => {
      const res = await app.inject({ method: "POST", url: "/api/tts/synthesize", payload: { text: "hi" } });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("tts_not_configured");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("validates text", async () => {
      await configure();
      const empty = await app.inject({ method: "POST", url: "/api/tts/synthesize", payload: { text: "   " } });
      expect(empty.statusCode).toBe(400);
      const long = await app.inject({ method: "POST", url: "/api/tts/synthesize", payload: { text: "x".repeat(1501) } });
      expect(long.statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("streams audio from the provider", async () => {
      await configure();
      // A saved rate must not reach the provider: speed is a playback concern.
      await app.inject({ method: "PUT", url: "/api/settings/tts", payload: { rate: 1.5 } });
      const res = await app.inject({ method: "POST", url: "/api/tts/synthesize", payload: { text: "a < b" } });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("audio/mpeg");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(new Uint8Array(res.rawPayload)).toEqual(AUDIO);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain("eastasia.tts.speech.microsoft.com");
      expect(init.body).toContain(">a &lt; b</voice>");
      expect(init.body).not.toContain("prosody");
    });

    it("maps a rejected key to 502, not 401", async () => {
      await configure();
      fetchMock.mockResolvedValueOnce(new Response("denied", { status: 401 }));
      const res = await app.inject({ method: "POST", url: "/api/tts/synthesize", payload: { text: "hi" } });
      expect(res.statusCode).toBe(502);
      expect(res.json().code).toBe("tts_auth_failed");
    });

    it("answers 504 when the provider times out", async () => {
      await configure();
      fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      const res = await app.inject({ method: "POST", url: "/api/tts/synthesize", payload: { text: "hi" } });
      expect(res.statusCode).toBe(504);
      expect(res.json().code).toBe("tts_upstream");
    });

    it("caps concurrent requests per user and frees the slot afterwards", async () => {
      await configure();
      const pending: Array<() => void> = [];
      fetchMock.mockImplementation(
        () => new Promise<Response>((resolve) => pending.push(() => resolve(new Response(AUDIO, { status: 200 })))),
      );
      const send = () => app.inject({ method: "POST", url: "/api/tts/synthesize", payload: { text: "hi" } });

      const first = send();
      const second = send();
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      const third = await send();
      expect(third.statusCode).toBe(429);

      // Another user is unaffected.
      auth.currentUserId = "user-2";
      await configure("user-2");
      const otherUser = send();
      await vi.waitFor(() => expect(pending).toHaveLength(3));

      pending.forEach((resolve) => resolve());
      expect((await first).statusCode).toBe(200);
      expect((await second).statusCode).toBe(200);
      expect((await otherUser).statusCode).toBe(200);

      auth.currentUserId = "user-1";
      fetchMock.mockImplementation(async () => new Response(AUDIO, { status: 200 }));
      await vi.waitFor(async () => {
        const again = await send();
        expect(again.statusCode).toBe(200);
      });
    });
  });

  describe("client disconnect", () => {
    it("aborts the upstream call and frees the slot", async () => {
      await configure();
      let upstreamSignal: AbortSignal | undefined;
      fetchMock.mockImplementation((_url: string, init: RequestInit) => {
        upstreamSignal = init.signal!;
        // An audio body that never finishes on its own.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(AUDIO);
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      });

      await app.listen({ port: 0, host: "127.0.0.1" });
      const { port } = app.server.address() as AddressInfo;
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port, method: "POST", path: "/api/tts/synthesize", headers: { "content-type": "application/json" } },
          (res) => {
            expect(res.statusCode).toBe(200);
            res.once("data", () => {
              req.destroy(); // the player's stop()
              resolve();
            });
          },
        );
        req.on("error", (err) => {
          if (!req.destroyed) reject(err);
        });
        req.end(JSON.stringify({ text: "hi" }));
      });

      await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));
      // Both slots are free again.
      fetchMock.mockImplementation(async () => new Response(AUDIO, { status: 200 }));
      const send = () => app.inject({ method: "POST", url: "/api/tts/synthesize", payload: { text: "hi" } });
      const [a, b] = await Promise.all([send(), send()]);
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    });
  });

  describe("voices", () => {
    it("409s when not configured", async () => {
      const res = await app.inject({ method: "GET", url: "/api/tts/voices" });
      expect(res.statusCode).toBe(409);
    });

    it("answers 504 when the voice list times out", async () => {
      await configure();
      fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      const res = await app.inject({ method: "GET", url: "/api/tts/voices" });
      expect(res.statusCode).toBe(504);
    });

    it("lists and caches per credentials", async () => {
      await configure();
      fetchMock.mockImplementation(
        async () =>
          new Response(JSON.stringify([{ ShortName: "en-US-AvaMultilingualNeural", Locale: "en-US", VoiceType: "Neural" }]), {
            status: 200,
          }),
      );
      const a = await app.inject({ method: "GET", url: "/api/tts/voices" });
      const b = await app.inject({ method: "GET", url: "/api/tts/voices" });
      expect(a.json().voices[0].id).toBe("en-US-AvaMultilingualNeural");
      expect(b.json()).toEqual(a.json());
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await app.inject({ method: "PUT", url: "/api/settings/tts", payload: { credentials: { azure: { apiKey: "another-key-9999" } } } });
      await app.inject({ method: "GET", url: "/api/tts/voices" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
