import { describe, it, expect } from "vitest";
import { formatDuration } from "./format-duration";

describe("formatDuration", () => {
  it("formats seconds", () => expect(formatDuration(9_000)).toBe("9s"));
  it("formats zero", () => expect(formatDuration(300)).toBe("0s"));
  it("formats minutes+seconds", () => expect(formatDuration(134_000)).toBe("2m 14s"));
  it("drops zero seconds", () => expect(formatDuration(120_000)).toBe("2m"));
  it("formats hours+minutes", () => expect(formatDuration(3_900_000)).toBe("1h 5m"));
  it("drops zero minutes", () => expect(formatDuration(7_200_000)).toBe("2h"));
});
