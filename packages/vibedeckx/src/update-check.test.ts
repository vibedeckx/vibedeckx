import { describe, expect, it, vi } from "vitest";
import {
  compareUpdateStatus,
  fetchLatestPublishedVersion,
} from "./update-check.js";

describe("compareUpdateStatus", () => {
  it.each([
    ["patch bump", "0.5.2", "0.5.4"],
    ["minor bump", "0.5.9", "0.6.0"],
    ["major bump", "0.9.9", "1.0.0"],
    ["release over its prerelease", "0.5.4-beta", "0.5.4"],
    ["later prerelease of same release", "1.0.0-alpha.1", "1.0.0-alpha.2"],
    ["alphanumeric over numeric prerelease", "1.0.0-1", "1.0.0-alpha"],
    ["longer prerelease with equal prefix", "1.0.0-alpha", "1.0.0-alpha.1"],
    ["longer numeric prerelease identifier", "1.0.0-alpha.9", "1.0.0-alpha.10"],
    [
      "majors past MAX_SAFE_INTEGER",
      "9007199254740992.0.0",
      "9007199254740993.0.0",
    ],
    ["bump with build metadata on both sides", "1.2.3+build.1", "1.2.4+build.1"],
  ])("reports update-available for %s", (_, current, latest) => {
    expect(compareUpdateStatus(current, latest)).toBe("update-available");
  });

  it.each([
    ["equal versions", "0.5.4", "0.5.4"],
    ["current ahead of registry", "0.5.5", "0.5.4"],
    ["current release ahead of latest prerelease", "0.5.4", "0.5.4-beta"],
    ["equal prereleases", "1.0.0-alpha.1", "1.0.0-alpha.1"],
    [
      "current ahead past MAX_SAFE_INTEGER",
      "9007199254740993.0.0",
      "9007199254740992.0.0",
    ],
    [
      "equal versions with differing build metadata",
      "1.2.3+build.1",
      "1.2.3+other.2",
    ],
  ])("reports up-to-date for %s", (_, current, latest) => {
    expect(compareUpdateStatus(current, latest)).toBe("up-to-date");
  });

  it.each([
    ["failed fetch", "0.5.4", undefined],
    ["malformed latest", "0.5.4", "not-a-version"],
    ["malformed current", "not-a-version", "0.5.4"],
    ["readPackageVersion fallback literal", "unknown", "0.5.4"],
    ["empty current", "", "0.5.4"],
    ["dot-separated suffix outside strict semver", "1.2.3.4", "0.5.4"],
    ["leading zero in major", "01.2.3", "0.5.4"],
    ["leading zero in minor of latest", "0.5.2", "1.02.3"],
    ["leading zero in numeric prerelease identifier", "1.0.0-01", "1.0.1"],
    ["empty prerelease identifier", "1.0.0-alpha..1", "1.0.1"],
    ["trailing dot in prerelease", "1.0.0-alpha.", "1.0.1"],
    ["empty build metadata", "1.2.3+", "1.2.4"],
  ])("reports unknown for %s", (_, current, latest) => {
    expect(compareUpdateStatus(current, latest)).toBe("unknown");
  });
});

describe("fetchLatestPublishedVersion", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("returns the version from the registry latest dist-tag", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ version: "0.5.4" }));
    await expect(
      fetchLatestPublishedVersion("vibedeckx", fetchImpl),
    ).resolves.toBe("0.5.4");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://registry.npmjs.org/vibedeckx/latest",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("resolves undefined on network errors", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      fetchLatestPublishedVersion("vibedeckx", fetchImpl),
    ).resolves.toBeUndefined();
  });

  // Node's AbortSignal.timeout uses internal timers that vitest fake timers
  // cannot advance, so the 4000ms constant is asserted via a spy and the
  // abort path is driven through a substituted controllable signal.
  it("arms a 4s timeout signal that aborts a hanging request", async () => {
    const controller = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("This operation was aborted", "AbortError")),
          );
        }),
    );

    const pending = fetchLatestPublishedVersion("vibedeckx", fetchImpl);
    expect(timeoutSpy).toHaveBeenCalledWith(4000);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(controller.signal);

    controller.abort();
    await expect(pending).resolves.toBeUndefined();
    timeoutSpy.mockRestore();
  });

  it("resolves undefined on non-2xx responses", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Not Found", { status: 404 }),
    );
    await expect(
      fetchLatestPublishedVersion("vibedeckx", fetchImpl),
    ).resolves.toBeUndefined();
  });

  it("resolves undefined on malformed JSON", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("{not json", { status: 200 }),
    );
    await expect(
      fetchLatestPublishedVersion("vibedeckx", fetchImpl),
    ).resolves.toBeUndefined();
  });

  it("accepts a published version carrying build metadata", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ version: "1.2.3+build.1" }));
    await expect(
      fetchLatestPublishedVersion("vibedeckx", fetchImpl),
    ).resolves.toBe("1.2.3+build.1");
  });

  it.each([
    ["missing version field", {}],
    ["non-string version", { version: 42 }],
    ["non-semver version", { version: "latest" }],
    ["leading-zero version", { version: "01.2.3" }],
    ["null body", null],
  ])("resolves undefined for %s", async (_, body) => {
    const fetchImpl = vi.fn(async () => jsonResponse(body));
    await expect(
      fetchLatestPublishedVersion("vibedeckx", fetchImpl),
    ).resolves.toBeUndefined();
  });
});
