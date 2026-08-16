import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/**
 * W3C Trace Context (https://www.w3.org/TR/trace-context/) plumbing.
 *
 * One trace ID follows a request from the browser through the hub and, over
 * the reverse-connect tunnel, into the worker — so a `traceparent` read off a
 * response in devtools is an exact-match key for every log line that request
 * produced, on either machine. No timestamp-and-URL guessing.
 *
 * Deliberately dependency-free but OTel-shaped: adopting the OpenTelemetry SDK
 * later means swapping the ID generator for real spans, not re-plumbing call
 * sites or changing the wire format.
 */

const VERSION = "00";
/** The spec reserves `ff`; a traceparent carrying it is invalid by definition. */
const INVALID_VERSION = "ff";
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

// Lowercase-only character classes: the spec requires lowercase hex, and
// implementations that accept uppercase produce IDs other tools then reject.
const HEX_2 = /^[0-9a-f]{2}$/;
const HEX_16 = /^[0-9a-f]{16}$/;
const HEX_32 = /^[0-9a-f]{32}$/;

export interface TraceContext {
  /** 32 lowercase hex — stable across every hop of one logical request. */
  traceId: string;
  /** 16 lowercase hex — identifies this hop. Freshly minted per process. */
  spanId: string;
  /** The caller's span, when this trace was continued from an inbound header. */
  parentSpanId?: string;
  sampled: boolean;
  /** False when no valid inbound header arrived and we minted the trace ID. */
  continued: boolean;
}

export interface ParsedTraceparent {
  traceId: string;
  spanId: string;
  flags: string;
}

/**
 * Strict W3C `traceparent` parse. Returns null for anything malformed rather
 * than throwing — an unparseable inbound header must degrade to "start a new
 * trace", never to a failed request.
 */
export function parseTraceparent(value: unknown): ParsedTraceparent | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;

  const parts = raw.split("-");
  if (parts.length < 4) return null;
  const [version, traceId, spanId, flags] = parts;

  if (!HEX_2.test(version) || version === INVALID_VERSION) return null;
  // Version 00 is exactly four fields. Later versions may append more, and the
  // spec says to keep parsing the known prefix rather than drop the trace.
  if (version === VERSION && parts.length !== 4) return null;
  // All-zero IDs are the spec's explicit "invalid" sentinel.
  if (!HEX_32.test(traceId) || traceId === ZERO_TRACE_ID) return null;
  if (!HEX_16.test(spanId) || spanId === ZERO_SPAN_ID) return null;
  if (!HEX_2.test(flags)) return null;

  return { traceId, spanId, flags };
}

/** Serialize for the next hop. Always emits version 00. */
export function formatTraceparent(ctx: TraceContext): string {
  return `${VERSION}-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? "01" : "00"}`;
}

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Build the context for one inbound request.
 *
 * A valid inbound traceparent is *continued* — same trace ID, new span. The
 * frontend is first-party and the reverse-connect tunnel is authenticated and
 * key-pinned, so joining the caller's trace is the entire point; re-minting
 * here would sever the browser↔hub↔worker chain this exists to join. A trace
 * ID confers no authority and is never a lookup key for anything
 * security-relevant, so a caller choosing its own can only affect its own
 * traces. Malformed input is ignored, not propagated.
 */
export function newTraceContext(incoming?: unknown): TraceContext {
  const parsed = parseTraceparent(incoming);
  if (parsed) {
    return {
      traceId: parsed.traceId,
      spanId: newSpanId(),
      parentSpanId: parsed.spanId,
      sampled: (parseInt(parsed.flags, 16) & 0x01) === 1,
      continued: true,
    };
  }
  return {
    traceId: newTraceId(),
    spanId: newSpanId(),
    sampled: true,
    continued: false,
  };
}

const storage = new AsyncLocalStorage<TraceContext>();

/** Run `fn` (and everything it awaits) with `ctx` as the ambient trace. */
export function runWithTraceContext<T>(ctx: TraceContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The ambient trace, or undefined outside a request (startup, timers, CLI). */
export function getTraceContext(): TraceContext | undefined {
  return storage.getStore();
}

/**
 * Header value for an outbound call made while serving a request. Undefined
 * outside a request so callers can omit the header rather than invent a trace.
 */
export function outboundTraceparent(): string | undefined {
  const ctx = storage.getStore();
  return ctx ? formatTraceparent(ctx) : undefined;
}
