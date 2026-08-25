import { describe, it, expect } from "vitest";
import { parseReviewContextMode, parseReviewSpan } from "./workflow-run-routes.js";

describe("parseReviewSpan", () => {
  it("accepts the two valid spans, defaults undefined to this_turn, rejects junk", () => {
    expect(parseReviewSpan("this_turn")).toBe("this_turn");
    expect(parseReviewSpan("session_start")).toBe("session_start");
    expect(parseReviewSpan(undefined)).toBe("this_turn");
    expect(parseReviewSpan("nonsense")).toBeNull();
    expect(parseReviewSpan(5)).toBeNull();
  });
});

describe("parseReviewContextMode", () => {
  it("accepts the two valid modes, defaults undefined to briefed, rejects junk", () => {
    expect(parseReviewContextMode("briefed")).toBe("briefed");
    expect(parseReviewContextMode("blind")).toBe("blind");
    expect(parseReviewContextMode(undefined)).toBe("briefed");
    expect(parseReviewContextMode("nonsense")).toBeNull();
    expect(parseReviewContextMode(5)).toBeNull();
  });
});
