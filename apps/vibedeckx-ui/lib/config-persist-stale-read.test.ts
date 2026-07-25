// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { getPersistedConfig } from "@/lib/api";

afterEach(() => {
  window.localStorage.clear();
});

describe("getPersistedConfig — stale cache read", () => {
  // Regression: an older build (or any other writer) may have persisted a config
  // that still carries discordInviteUrl. On read it must be stripped, otherwise a
  // removed/dead invite would resurrect the button synchronously on first render
  // and persist through a failed background refresh. This file is kept separate
  // so no prior getConfig() call populates the module's in-memory cache, forcing
  // the actual localStorage read path.
  it("strips discordInviteUrl from a pre-seeded stale cache", () => {
    window.localStorage.setItem(
      "vibedeckx:app-config",
      JSON.stringify({
        authEnabled: true,
        localProjectsEnabled: true,
        discordInviteUrl: "https://discord.gg/staleinvite",
      }),
    );

    const config = getPersistedConfig();

    expect(config).not.toBeNull();
    expect(config!.discordInviteUrl).toBeUndefined();
    // The non-ephemeral fields must still come through.
    expect(config!.authEnabled).toBe(true);
    expect(config!.localProjectsEnabled).toBe(true);
  });
});
