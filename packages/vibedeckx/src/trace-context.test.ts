import { describe, it, expect } from "vitest";
import {
  formatTraceparent,
  getTraceContext,
  newTraceContext,
  outboundTraceparent,
  parseTraceparent,
  runWithTraceContext,
} from "./trace-context.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const VALID = `00-${TRACE_ID}-${SPAN_ID}-01`;

describe("parseTraceparent", () => {
  const valid: Array<[string, string]> = [
    ["sampled flag", VALID],
    ["unsampled flag", `00-${TRACE_ID}-${SPAN_ID}-00`],
    ["unknown flag bits are not our business", `00-${TRACE_ID}-${SPAN_ID}-ff`],
    // The spec says a future version whose prefix still parses should be
    // honoured, not discarded — dropping it would silently break the trace.
    ["future version with extra fields", `01-${TRACE_ID}-${SPAN_ID}-01-extra`],
  ];

  it.each(valid)("accepts %s", (_label, header) => {
    const parsed = parseTraceparent(header);
    expect(parsed).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID, flags: expect.any(String) });
  });

  const invalid: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["non-string", 42],
    ["empty", ""],
    ["too few fields", `00-${TRACE_ID}-${SPAN_ID}`],
    ["version 00 with extra fields", `00-${TRACE_ID}-${SPAN_ID}-01-extra`],
    ["reserved version ff", `ff-${TRACE_ID}-${SPAN_ID}-01`],
    ["non-hex version", `zz-${TRACE_ID}-${SPAN_ID}-01`],
    ["uppercase trace id", `00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01`],
    ["uppercase span id", `00-${TRACE_ID}-${SPAN_ID.toUpperCase()}-01`],
    ["all-zero trace id", `00-${"0".repeat(32)}-${SPAN_ID}-01`],
    ["all-zero span id", `00-${TRACE_ID}-${"0".repeat(16)}-01`],
    ["short trace id", `00-${TRACE_ID.slice(0, 31)}-${SPAN_ID}-01`],
    ["long span id", `00-${TRACE_ID}-${SPAN_ID}0-01`],
    ["non-hex flags", `00-${TRACE_ID}-${SPAN_ID}-zz`],
  ];

  it.each(invalid)("rejects %s", (_label, header) => {
    expect(parseTraceparent(header)).toBeNull();
  });

  it("takes the first value when a header arrives repeated", () => {
    expect(parseTraceparent([VALID, "garbage"])?.traceId).toBe(TRACE_ID);
  });
});

describe("newTraceContext", () => {
  it("continues a valid inbound trace with a fresh span", () => {
    const ctx = newTraceContext(VALID);
    expect(ctx.traceId).toBe(TRACE_ID);
    expect(ctx.parentSpanId).toBe(SPAN_ID);
    expect(ctx.spanId).not.toBe(SPAN_ID);
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(ctx.continued).toBe(true);
    expect(ctx.sampled).toBe(true);
  });

  it("mints a fresh trace when the inbound header is malformed", () => {
    const ctx = newTraceContext(`00-${"0".repeat(32)}-${SPAN_ID}-01`);
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.traceId).not.toBe("0".repeat(32));
    expect(ctx.parentSpanId).toBeUndefined();
    expect(ctx.continued).toBe(false);
  });

  it("mints a fresh trace when no header arrives", () => {
    const a = newTraceContext(undefined);
    const b = newTraceContext(undefined);
    expect(a.traceId).not.toBe(b.traceId);
    expect(a.continued).toBe(false);
  });

  it("round-trips through format/parse", () => {
    const ctx = newTraceContext(undefined);
    const parsed = parseTraceparent(formatTraceparent(ctx));
    expect(parsed).toEqual({ traceId: ctx.traceId, spanId: ctx.spanId, flags: "01" });
  });
});

describe("ambient context", () => {
  it("is undefined outside a run", () => {
    expect(getTraceContext()).toBeUndefined();
    expect(outboundTraceparent()).toBeUndefined();
  });

  it("survives await boundaries", async () => {
    const ctx = newTraceContext(VALID);
    await runWithTraceContext(ctx, async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(getTraceContext()?.traceId).toBe(TRACE_ID);
      expect(outboundTraceparent()).toBe(`00-${TRACE_ID}-${ctx.spanId}-01`);
    });
    expect(getTraceContext()).toBeUndefined();
  });

  it("keeps concurrent contexts separate", async () => {
    const seen = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const ctx = newTraceContext(undefined);
        return runWithTraceContext(ctx, async () => {
          await new Promise((r) => setTimeout(r, i % 5));
          return { expected: ctx.traceId, actual: getTraceContext()?.traceId };
        });
      }),
    );
    for (const { expected, actual } of seen) expect(actual).toBe(expected);
    expect(new Set(seen.map((s) => s.actual)).size).toBe(20);
  });
});
