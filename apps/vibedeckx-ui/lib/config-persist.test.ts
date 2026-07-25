// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("config persistence", () => {
  it("does not write discordInviteUrl to the persisted cache", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({
          authEnabled: true,
          localProjectsEnabled: true,
          discordInviteUrl: "https://discord.gg/secret",
        }),
      }),
    );

    await api.getConfig();

    const raw = window.localStorage.getItem("vibedeckx:app-config");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed.discordInviteUrl).toBeUndefined();
    expect(parsed.authEnabled).toBe(true);
    expect(parsed.localProjectsEnabled).toBe(true);
    // The stored string must not carry the invite anywhere.
    expect(raw).not.toContain("discord.gg");
  });
});
