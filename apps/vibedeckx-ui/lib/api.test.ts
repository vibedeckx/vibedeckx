import { afterEach, describe, expect, it, vi } from "vitest";
import { createNewAgentSession, getFreshToken, ResidentLimitError, setAuthToken, setTokenGetter } from "@/lib/api";

// Build a JWT whose `exp` is `secondsFromNow` away (negative = already expired).
function makeJwt(secondsFromNow: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + secondsFromNow;
  const payload = Buffer.from(JSON.stringify({ sub: "u", exp })).toString("base64url");
  return `${header}.${payload}.sig`;
}

afterEach(() => {
  setTokenGetter(null);
  setAuthToken(null);
});

describe("getFreshToken", () => {
  it("forces a network mint (skipCache) when the warm cache is expired", async () => {
    // Regression: after a server restart the warm cache held an already-expired
    // Clerk JWT; reconnects re-sent it and the server rejected with "Invalid
    // token". getFreshToken must force a refresh instead of trusting the cache.
    setAuthToken(makeJwt(-15)); // expired 15s ago
    const getter = vi.fn().mockResolvedValue(makeJwt(60));
    setTokenGetter(getter);

    const token = await getFreshToken();

    expect(getter).toHaveBeenCalledWith({ skipCache: true });
    expect(token).toBe(makeJwt(60));
  });

  it("forces a refresh when the cached token is near expiry", async () => {
    setAuthToken(makeJwt(5)); // 5s of life left — under the 10s threshold
    const getter = vi.fn().mockResolvedValue(makeJwt(60));
    setTokenGetter(getter);

    await getFreshToken();

    expect(getter).toHaveBeenCalledWith({ skipCache: true });
  });

  it("uses the cache (no forced mint) when the token is comfortably valid", async () => {
    setAuthToken(makeJwt(60)); // full life
    const getter = vi.fn().mockResolvedValue(makeJwt(60));
    setTokenGetter(getter);

    await getFreshToken();

    expect(getter).toHaveBeenCalledWith({ skipCache: false });
  });

  it("honors an explicit skipCache override", async () => {
    setAuthToken(makeJwt(60));
    const getter = vi.fn().mockResolvedValue(makeJwt(60));
    setTokenGetter(getter);

    await getFreshToken({ skipCache: true });

    expect(getter).toHaveBeenCalledWith({ skipCache: true });
  });

  it("drops an expired cached token when getToken() throws (no doomed reuse)", async () => {
    setAuthToken(makeJwt(-15)); // expired
    setTokenGetter(vi.fn().mockRejectedValue(new Error("network")));

    expect(await getFreshToken()).toBeNull();
  });

  it("falls back to the cached token on a transient getToken() failure while it is still valid", async () => {
    const valid = makeJwt(40); // still has real life left
    setAuthToken(valid);
    setTokenGetter(vi.fn().mockRejectedValue(new Error("network")));

    expect(await getFreshToken()).toBe(valid);
  });
});

describe("createNewAgentSession", () => {
  it("throws ResidentLimitError with running session details when backend returns resident_limit_reached", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      status: 409,
      ok: false,
      json: async () => ({
        errorCode: "resident_limit_reached",
        error: "Resident agent process limit reached",
        maxResidentAgentProcesses: 3,
        runningSessions: [{ id: "s1", title: "Still running", projectId: "p1", branch: null }],
      }),
    } as Response);

    await expect(createNewAgentSession("p1", null, "edit", "claude-code")).rejects.toMatchObject({
      name: "ResidentLimitError",
      maxResidentAgentProcesses: 3,
      runningSessions: [{ id: "s1", title: "Still running", projectId: "p1", branch: null }],
    });

    global.fetch = originalFetch;
  });
});
