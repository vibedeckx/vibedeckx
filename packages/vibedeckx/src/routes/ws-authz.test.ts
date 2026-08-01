import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticateWs } from "./ws-authz.js";

describe("authenticateWs principal kind", () => {
  const originalApiKey = process.env.VIBEDECKX_API_KEY;

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.VIBEDECKX_API_KEY;
    else process.env.VIBEDECKX_API_KEY = originalApiKey;
  });

  it("identifies no-auth mode as the local solo principal", async () => {
    const socket = { send: vi.fn(), close: vi.fn() };

    await expect(authenticateWs(false, {}, socket)).resolves.toEqual({
      userId: null,
      kind: "solo",
    });
  });

  it("keeps a prevalidated server API key distinguishable from solo mode", async () => {
    process.env.VIBEDECKX_API_KEY = "server-key";
    const socket = { send: vi.fn(), close: vi.fn() };

    await expect(authenticateWs(true, { apiKey: "server-key" }, socket)).resolves.toEqual({
      userId: null,
      kind: "api_key",
    });
  });
});
