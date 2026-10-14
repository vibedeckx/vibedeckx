import { wrapLanguageModel } from "ai";
import { reportTrace } from "evalite/traces";

/** Preserve provider messages verbatim: Evalite's built-in tracer rejects
 * reasoning and approval content in multi-turn prompts in beta.16. */
export function traceCommanderModel(model: Parameters<typeof wrapLanguageModel>[0]["model"]) {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      wrapStream: async ({ params, doStream }) => {
        const start = performance.now();
        const result = await doStream();
        const output: unknown[] = [];
        let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
        return {
          ...result,
          stream: result.stream.pipeThrough(new TransformStream({
            transform(part, controller) {
              output.push(part);
              if (part.type === "finish") {
                const inputTokens = part.usage.inputTokens.total ?? 0;
                const outputTokens = part.usage.outputTokens.total ?? 0;
                usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
              }
              controller.enqueue(part);
            },
            flush() {
              reportTrace({ input: params.prompt, output, start, end: performance.now(), usage });
            },
          })),
        };
      },
    },
  });
}
