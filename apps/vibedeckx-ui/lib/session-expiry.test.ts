import { describe, expect, it } from "vitest";
import { isSessionExpirySignOut } from "./session-expiry";

describe("isSessionExpirySignOut", () => {
  const now = 1_800_000_000_000;

  it("returns false when no expireAt was ever observed", () => {
    expect(isSessionExpirySignOut(null, now)).toBe(false);
  });

  it("returns false when the session had plenty of life left (intentional sign-out)", () => {
    expect(isSessionExpirySignOut(now + 2 * 60 * 60 * 1000, now)).toBe(false);
  });

  it("returns true when now is past expireAt", () => {
    expect(isSessionExpirySignOut(now - 1000, now)).toBe(true);
  });

  it("returns true just before expireAt, within the clock-slack window", () => {
    expect(isSessionExpirySignOut(now + 59_000, now)).toBe(true);
  });

  it("returns false just outside the clock-slack window", () => {
    expect(isSessionExpirySignOut(now + 61_000, now)).toBe(false);
  });
});
