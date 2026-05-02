// packages/vibedeckx/src/instrumentation.ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

const enabled =
  !!process.env.LANGFUSE_PUBLIC_KEY && !!process.env.LANGFUSE_SECRET_KEY;

export const langfuseSpanProcessor = enabled
  ? new LangfuseSpanProcessor()
  : null;

if (enabled && langfuseSpanProcessor) {
  const sdk = new NodeSDK({ spanProcessors: [langfuseSpanProcessor] });
  sdk.start();
  console.log("[Langfuse] tracing enabled");

  const shutdown = async (): Promise<void> => {
    try {
      await sdk.shutdown();
    } catch {
      // best-effort
    }
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
} else {
  console.log("[Langfuse] tracing disabled (LANGFUSE_PUBLIC_KEY not set)");
}
