import { describe, expect, it } from "vitest";
import { resolveRemoteReplayCursor } from "./websocket-routes.js";

describe("remote frontend replay cursor", () => {
  it("does not filter when the hub does not know the worker epoch", () => {
    expect(resolveRemoteReplayCursor(3, null, 40)).toEqual({
      epochMatches: false,
      replayAfter: -1,
    });
  });

  it("filters through the sealed boundary only for an equal known epoch", () => {
    expect(resolveRemoteReplayCursor(3, 3, 40)).toEqual({
      epochMatches: true,
      replayAfter: 40,
    });
  });
});
