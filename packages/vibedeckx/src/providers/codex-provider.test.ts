import { describe, expect, it } from "vitest";
import { CodexProvider } from "./codex-provider.js";

describe("CodexProvider", () => {
  it("does not treat token usage updates as turn completion", () => {
    const provider = new CodexProvider();
    provider.onSessionCreated("session-1", "edit");

    const events = provider.parseStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: {
          tokenUsage: {
            last: {
              inputTokens: 12,
              outputTokens: 34,
            },
          },
        },
      }),
      "session-1",
    );

    expect(events).toEqual([]);
  });

  it("attaches latest token usage to turn completion", () => {
    const provider = new CodexProvider();
    provider.onSessionCreated("session-1", "edit");

    provider.parseStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: {
          tokenUsage: {
            last: {
              inputTokens: 12,
              outputTokens: 34,
            },
          },
        },
      }),
      "session-1",
    );

    const events = provider.parseStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            status: "completed",
          },
        },
      }),
      "session-1",
    );

    expect(events).toEqual([
      {
        type: "result",
        subtype: "success",
        input_tokens: 12,
        output_tokens: 34,
      },
    ]);
  });
});
