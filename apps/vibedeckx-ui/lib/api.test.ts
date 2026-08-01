import { afterEach, describe, expect, it, vi } from "vitest";
import { api, createNewAgentSession, getFreshToken, setAuthToken, setTokenGetter } from "@/lib/api";

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
    // Minted once and compared to itself: makeJwt stamps `exp` from Date.now(),
    // so calling it again for the assertion fails whenever the two calls land on
    // either side of a second boundary.
    const minted = makeJwt(60);
    const getter = vi.fn().mockResolvedValue(minted);
    setTokenGetter(getter);

    const token = await getFreshToken();

    expect(getter).toHaveBeenCalledWith({ skipCache: true });
    expect(token).toBe(minted);
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
  // The only seam the model crosses that neither side covers: the hook test
  // mocks this function out, the route test injects a payload directly.
  // Deleting `model` from the JSON.stringify below would leave every other
  // test green and typecheck clean while the whole feature went inert.
  it("puts the chosen model in the request body", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ session: { id: "s1" }, messages: [] }),
    } as Response);
    global.fetch = fetchMock;

    await createNewAgentSession("p1", "dev1", "edit", "claude-code", false, "opus");

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      branch: "dev1",
      permissionMode: "edit",
      agentType: "claude-code",
      model: "opus",
    });

    global.fetch = originalFetch;
  });

  it("sends an unvalidated model string verbatim", async () => {
    // No whitelist anywhere: a name the CLI will reject must still reach it.
    const originalFetch = global.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ session: { id: "s1" }, messages: [] }),
    } as Response);
    global.fetch = fetchMock;

    await createNewAgentSession("p1", null, "edit", "codex", false, "totally-made-up");

    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).model).toBe(
      "totally-made-up",
    );

    global.fetch = originalFetch;
  });

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

describe("Project Chat create", () => {
  it("sends the caller's explicit create request id", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 201,
      json: async () => ({ thread: { id: "thread" } }),
    } as Response);
    global.fetch = fetchMock;
    try {
      await api.createProjectChatThread("p1", "hello", "stable-create-key");
      expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
        message: "hello", createRequestId: "stable-create-key",
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("preserves the HTTP status on create conflicts", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 409,
      json: async () => ({ error: "payload mismatch" }),
    } as Response);
    try {
      await expect(api.createProjectChatThread("p1", "hello", "stable-create-key"))
        .rejects.toMatchObject({ message: "payload mismatch", status: 409 });
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("Project Chat stop", () => {
  it("sends the active turn identity observed over the stream", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ stopped: true }),
    } as Response);
    global.fetch = fetchMock;
    try {
      await expect(api.stopProjectChatTurn("thread-1", "turn-7")).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/project-chat/threads/thread-1/stop",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ expectedActiveTurnId: "turn-7" }),
        }),
      );
      expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get("Content-Type"))
        .toBe("application/json");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("single task read", () => {
  it("uses the bounded project-scoped task endpoint", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ task: { id: "task-1", project_id: "project-1" } }),
    } as Response);
    global.fetch = fetchMock;
    try {
      await expect(api.getTask("project-1", "task-1")).resolves.toMatchObject({ id: "task-1" });
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/project-1/tasks/task-1",
        expect.objectContaining({ headers: expect.any(Headers) }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("manual schedule run", () => {
  it("sends the stable request, run, and source identities", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ runId: "run-1" }),
    } as Response);
    global.fetch = fetchMock;
    try {
      await api.runScheduleNow("schedule-1", {
        requestId: "request-1", runId: "run-1", sourceRunId: "source-1",
      });
      expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
        requestId: "request-1", runId: "run-1", sourceRunId: "source-1",
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("preserves a conflict status so the retry identity can be rotated", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 409, json: async () => ({ error: "payload mismatch" }),
    } as Response);
    try {
      await expect(api.runScheduleNow("schedule-1", { requestId: "request-1", runId: "run-1" }))
        .rejects.toMatchObject({ message: "payload mismatch", status: 409 });
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("setMergeTarget", () => {
  it("PUTs an explicit target and returns true when the response is ok", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    global.fetch = fetchMock;

    await expect(api.setMergeTarget("p1", "dev1", "release")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/p1/branches/merge-target",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ branch: "dev1", target: "release" }),
      }),
    );
    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(requestInit.headers).get("Content-Type")).toBe("application/json");

    global.fetch = originalFetch;
  });

  it("keeps target null in reset requests", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    global.fetch = fetchMock;

    await api.setMergeTarget("p1", "dev1", null);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/p1/branches/merge-target",
      expect.objectContaining({ body: JSON.stringify({ branch: "dev1", target: null }) }),
    );

    global.fetch = originalFetch;
  });

  it("sends ifAbsent only when it is true", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    global.fetch = fetchMock;

    await api.setMergeTarget("p1", "dev1", "release", { ifAbsent: true });
    await api.setMergeTarget("p1", "dev2", "main", { ifAbsent: false });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      branch: "dev1",
      target: "release",
      ifAbsent: true,
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ branch: "dev2", target: "main" });

    global.fetch = originalFetch;
  });

  it("returns false for non-ok responses and rejected requests", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockRejectedValueOnce(new Error("network"));

    await expect(api.setMergeTarget("p1", "dev1", "release")).resolves.toBe(false);
    await expect(api.setMergeTarget("p1", "dev1", "release")).resolves.toBe(false);

    global.fetch = originalFetch;
  });
});
