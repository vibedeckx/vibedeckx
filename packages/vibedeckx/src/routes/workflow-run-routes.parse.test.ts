import { describe, it, expect } from "vitest";
import { parseLoop, parseReviewContextMode, parseReviewSpan } from "./workflow-run-routes.js";

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

describe("parseLoop", () => {
  it("absent = single-pass; an object without a cap takes the default; the cap is a bounded integer", () => {
    expect(parseLoop(undefined)).toBeUndefined();
    expect(parseLoop(null)).toBeUndefined();
    expect(parseLoop({})).toEqual({ maxRounds: 3 });
    expect(parseLoop({ maxRounds: 1 })).toEqual({ maxRounds: 1 });
    expect(parseLoop({ maxRounds: 10 })).toEqual({ maxRounds: 10 });
    expect(parseLoop({ maxRounds: 0 })).toBeNull();
    expect(parseLoop({ maxRounds: 11 })).toBeNull();
    expect(parseLoop({ maxRounds: 2.5 })).toBeNull();
    expect(parseLoop({ maxRounds: "3" })).toBeNull();
    expect(parseLoop(true)).toBeNull();
  });
});
