import type { LanguageModelMiddleware } from "ai";
import type { Storage } from "../storage/types.js";
import { buildUsageEntry, type RawCallUsage } from "./metering.js";
import { getUsagePolicy } from "./policy-registry.js";
import { UsageLimitError, type LlmCallMeta } from "./types.js";

type StreamResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware["wrapStream"]>>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;
type ProviderMetadata = Parameters<typeof buildUsageEntry>[2];

/**
 * Ask the active policy before the call. A denial throws UsageLimitError; a
 * policy that itself fails lets the call through — a bug in a guard must not
 * take every model call down with it.
 */
async function guard(meta: LlmCallMeta, storage: Storage): Promise<void> {
  const policy = getUsagePolicy();
  let decision;
  try {
    decision = await policy.check({ ...meta, ledger: storage.llmUsage, now: new Date() });
  } catch (error) {
    console.warn(`[Usage] policy "${policy.name}" failed, allowing call:`, error);
    return;
  }
  if (!decision.allow) {
    console.warn(`[Usage] denied ${meta.feature} for ${meta.userId}: ${decision.reason}`);
    throw new UsageLimitError(decision.reason, decision.message, decision.retryAfterMs);
  }
}

/** Write the ledger row. Never throws: metering must not fail a call that already succeeded. */
async function record(
  meta: LlmCallMeta,
  storage: Storage,
  usage: RawCallUsage | undefined,
  providerMetadata: ProviderMetadata,
): Promise<void> {
  try {
    const entry = buildUsageEntry(meta, usage, providerMetadata);
    await storage.llmUsage.insert(entry);
    await getUsagePolicy().onUsage?.(entry);
  } catch (error) {
    console.warn(`[Usage] failed to record ${meta.feature} usage for ${meta.userId}:`, error);
  }
}

/**
 * Meters one resolved model: checks the usage policy before each provider
 * call and records the call's tokens and cost when it finishes. Works at the
 * provider-call level, so a multi-step streamText run records one row per step.
 * A stream that is aborted before its finish part reports nothing, so its
 * (partial) usage goes unrecorded.
 */
export function usageMiddleware(meta: LlmCallMeta, storage: Storage): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",

    wrapGenerate: async ({ doGenerate }) => {
      await guard(meta, storage);
      const result = await doGenerate();
      void record(meta, storage, result.usage, result.providerMetadata);
      return result;
    },

    wrapStream: async ({ doStream }) => {
      await guard(meta, storage);
      const result = await doStream();
      let finish: Extract<StreamPart, { type: "finish" }> | undefined;
      const stream = result.stream.pipeThrough(
        new TransformStream<StreamPart, StreamPart>({
          transform(part, controller) {
            if (part.type === "finish") finish = part;
            controller.enqueue(part);
          },
          flush() {
            if (finish) void record(meta, storage, finish.usage, finish.providerMetadata);
          },
        }),
      );
      return { ...result, stream };
    },
  };
}
