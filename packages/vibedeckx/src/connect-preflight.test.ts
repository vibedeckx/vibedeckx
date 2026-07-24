import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage } from "./storage/types.js";
import {
  canonicalizeHubUrl,
  preflightIdentityCheck,
  CONNECT_IDENTITY_HEADER,
  PINNED_IDENTITY_SETTING_PREFIX,
} from "./connect-preflight.js";

describe("canonicalizeHubUrl", () => {
  it("maps equivalent spellings to one canonical form", () => {
    const canonical = canonicalizeHubUrl("https://hub.example");
    expect(canonicalizeHubUrl("https://hub.example/")).toBe(canonical);
    expect(canonicalizeHubUrl("https://hub.example//")).toBe(canonical);
    expect(canonicalizeHubUrl("https://HUB.example")).toBe(canonical);
    expect(canonicalizeHubUrl("https://hub.example:443")).toBe(canonical);
    expect(canonicalizeHubUrl("https://HUB.example:443/")).toBe(canonical);
  });

  it("drops default ports but keeps explicit non-default ones", () => {
    expect(canonicalizeHubUrl("http://hub.example:80")).toBe("http://hub.example");
    expect(canonicalizeHubUrl("https://hub.example:8443")).toBe("https://hub.example:8443");
  });

  it("preserves a path prefix while stripping trailing slashes", () => {
    expect(canonicalizeHubUrl("https://hub.example/vibedeckx/")).toBe("https://hub.example/vibedeckx");
    expect(canonicalizeHubUrl("https://hub.example/vibedeckx")).toBe("https://hub.example/vibedeckx");
  });

  it("rejects unparseable and non-http URLs", () => {
    expect(() => canonicalizeHubUrl("not a url")).toThrow(/Invalid --connect-to/);
    expect(() => canonicalizeHubUrl("ftp://hub.example")).toThrow(/http\(s\)/);
  });
});

describe("preflightIdentityCheck", () => {
  let storage: Storage;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-preflight-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const HUB = "https://hub.example";

  /**
   * Fetch stub for a "new hub": /api/config advertises the capability and
   * /api/reverse-connect/identity resolves tokens from the given map.
   */
  const newHubFetch = (tokens: Record<string, { serverId: string; name: string }>) => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/api/config")) {
        return new Response(JSON.stringify({ reverseConnectIdentity: true }), { status: 200 });
      }
      if (url.endsWith("/api/reverse-connect/identity")) {
        const token = new Headers(init?.headers).get(CONNECT_IDENTITY_HEADER) ?? "";
        const identity = tokens[token];
        if (!identity) return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 });
        return new Response(JSON.stringify(identity), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    return { fetchImpl, calls };
  };

  const run = (opts: { token: string; fetchImpl: typeof fetch; force?: boolean; connectTo?: string }) =>
    preflightIdentityCheck({
      connectTo: opts.connectTo ?? HUB,
      token: opts.token,
      settings: storage.settings,
      force: opts.force,
      fetchImpl: opts.fetchImpl,
    });

  it("skips the check when config lacks the capability flag (old hub)", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ authEnabled: false }), { status: 200 });
    }) as typeof fetch;
    const result = await run({ token: "t", fetchImpl });
    expect(result.checked).toBe(false);
    expect(calls.some((u) => u.includes("/identity"))).toBe(false);
  });

  it("skips the check when config is unreachable or unauthorized (old API-key hub)", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    expect((await run({ token: "t", fetchImpl: failing })).checked).toBe(false);

    const unauthorized = (async () =>
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })) as typeof fetch;
    expect((await run({ token: "t", fetchImpl: unauthorized })).checked).toBe(false);
  });

  it("treats identity-endpoint failures as fatal once the capability is confirmed", async () => {
    const { fetchImpl } = newHubFetch({});
    await expect(run({ token: "bad", fetchImpl })).rejects.toThrow(/rejected/);

    const forbidden = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/config")) {
        return new Response(JSON.stringify({ reverseConnectIdentity: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "Not inbound" }), { status: 403 });
    }) as typeof fetch;
    await expect(run({ token: "t", fetchImpl: forbidden })).rejects.toThrow(/inbound/);

    const broken = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/config")) {
        return new Response(JSON.stringify({ reverseConnectIdentity: true }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;
    await expect(run({ token: "t", fetchImpl: broken })).rejects.toThrow(/Malformed/);
  });

  it("pins on first connect and passes on subsequent matching connects", async () => {
    const { fetchImpl } = newHubFetch({ "tok-a": { serverId: "srv-a", name: "remote-a" } });
    const first = await run({ token: "tok-a", fetchImpl });
    expect(first.checked).toBe(true);
    expect(first.identity).toEqual({ serverId: "srv-a", name: "remote-a" });

    const pinned = await storage.settings.get(`${PINNED_IDENTITY_SETTING_PREFIX}${HUB}`);
    expect(JSON.parse(pinned!)).toEqual({ serverId: "srv-a", name: "remote-a" });

    const second = await run({ token: "tok-a", fetchImpl });
    expect(second.checked).toBe(true);
  });

  it("rejects a token for a different remote, naming both sides", async () => {
    const { fetchImpl } = newHubFetch({
      "tok-a": { serverId: "srv-a", name: "remote-a" },
      "tok-b": { serverId: "srv-b", name: "remote-b" },
    });
    await run({ token: "tok-a", fetchImpl });
    await expect(run({ token: "tok-b", fetchImpl })).rejects.toThrow(
      /previously served remote "remote-a".*belongs to "remote-b".*--force/s,
    );
  });

  it("detects the mismatch across equivalent hub URL spellings", async () => {
    const { fetchImpl } = newHubFetch({
      "tok-a": { serverId: "srv-a", name: "remote-a" },
      "tok-b": { serverId: "srv-b", name: "remote-b" },
    });
    await run({ token: "tok-a", fetchImpl, connectTo: "https://hub.example" });
    await expect(
      run({ token: "tok-b", fetchImpl, connectTo: "https://HUB.example:443/" }),
    ).rejects.toThrow(/--force/);
  });

  it("--force re-pins to the new remote", async () => {
    const { fetchImpl } = newHubFetch({
      "tok-a": { serverId: "srv-a", name: "remote-a" },
      "tok-b": { serverId: "srv-b", name: "remote-b" },
    });
    await run({ token: "tok-a", fetchImpl });
    const forced = await run({ token: "tok-b", fetchImpl, force: true });
    expect(forced.identity?.serverId).toBe("srv-b");
    // The new pin holds: tok-b now passes without force, tok-a mismatches.
    await expect(run({ token: "tok-b", fetchImpl })).resolves.toMatchObject({ checked: true });
    await expect(run({ token: "tok-a", fetchImpl })).rejects.toThrow(/--force/);
  });

  it("repairs a corrupt pin and refreshes a renamed remote's name", async () => {
    const key = `${PINNED_IDENTITY_SETTING_PREFIX}${HUB}`;
    await storage.settings.set(key, "not-json");
    const { fetchImpl } = newHubFetch({ "tok-a": { serverId: "srv-a", name: "remote-a" } });
    await run({ token: "tok-a", fetchImpl });
    expect(JSON.parse((await storage.settings.get(key))!)).toEqual({ serverId: "srv-a", name: "remote-a" });

    await storage.settings.set(key, JSON.stringify({ serverId: "srv-a", name: "old-name" }));
    await run({ token: "tok-a", fetchImpl });
    expect(JSON.parse((await storage.settings.get(key))!).name).toBe("remote-a");
  });

  it("lets exactly one of two concurrent first connects with different tokens win", async () => {
    const { fetchImpl } = newHubFetch({
      "tok-a": { serverId: "srv-a", name: "remote-a" },
      "tok-b": { serverId: "srv-b", name: "remote-b" },
    });
    const results = await Promise.allSettled([
      run({ token: "tok-a", fetchImpl }),
      run({ token: "tok-b", fetchImpl }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});
