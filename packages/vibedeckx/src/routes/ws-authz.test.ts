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

  // The server API key is a door gate, not an identity: a reverse proxy that
  // injects it to origin-lock a Clerk deployment must not thereby collapse every
  // request into one unscoped principal.
  it("does not let a matching server API key stand in for a Clerk session", async () => {
    process.env.VIBEDECKX_API_KEY = "server-key";
    const socket = { send: vi.fn(), close: vi.fn() };

    await expect(
      authenticateWs(true, { apiKey: "server-key" } as { token?: string }, socket),
    ).resolves.toBeNull();
    expect(socket.close).toHaveBeenCalled();
  });
});
