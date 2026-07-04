import { describe, expect, it } from "vitest";
import { CodexProvider } from "./codex-provider.js";

describe("CodexProvider", () => {
  function commandExecutionCompleted(id = "cmd-1") {
    return {
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id,
          command: "/bin/bash -lc \"echo hi\"",
          aggregatedOutput: "hi\n",
          status: "completed",
        },
      },
    };
  }

  function finalAgentMessageCompleted() {
    return {
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "msg-1",
          text: "Done.",
          phase: "final_answer",
        },
      },
    };
  }

  function tokenUsageUpdated(inputTokens = 12, outputTokens = 34) {
    return {
      jsonrpc: "2.0",
      method: "thread/tokenUsage/updated",
      params: {
        turnId: "turn-1",
        tokenUsage: {
          last: {
            inputTokens,
            outputTokens,
          },
        },
      },
    };
  }

  function turnCompleted(status = "completed") {
    return {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        turn: {
          id: "turn-1",
          status,
        },
      },
    };
  }

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

    provider.parseStdoutLine(JSON.stringify(tokenUsageUpdated()), "session-1");
    provider.parseStdoutLine(JSON.stringify(finalAgentMessageCompleted()), "session-1");

    const events = provider.parseStdoutLine(JSON.stringify(turnCompleted()), "session-1");

    expect(events).toEqual([
      {
        type: "result",
        subtype: "success",
        input_tokens: 12,
        output_tokens: 34,
      },
    ]);
  });

  it("does not report task completion for a command-only Codex turn", () => {
    const provider = new CodexProvider();
    provider.onSessionCreated("session-1", "edit");

    provider.parseStdoutLine(JSON.stringify(commandExecutionCompleted()), "session-1");
    provider.parseStdoutLine(JSON.stringify(tokenUsageUpdated()), "session-1");

    const events = provider.parseStdoutLine(JSON.stringify(turnCompleted()), "session-1");

    expect(events).toEqual([]);
  });

  it("surfaces JSON-RPC error responses as error results", () => {
    const provider = new CodexProvider();
    provider.onSessionCreated("session-1", "edit");

    // initialize (id 1) + thread/start (id 2) sent at spawn
    provider.getInitializationMessages("session-1");
    provider.parseStdoutLine(
      JSON.stringify({ jsonrpc: "2.0", id: 2, result: { thread: { id: "thread-1" } } }),
      "session-1",
    );

    // turn/start (id 3) rejected — e.g. "Not initialized" from a respawned app-server
    provider.formatUserInput("hello", "session-1");
    const events = provider.parseStdoutLine(
      JSON.stringify({ jsonrpc: "2.0", id: 3, error: { code: -32600, message: "Not initialized" } }),
      "session-1",
    );

    expect(events).toEqual([
      {
        type: "result",
        subtype: "error",
        error: "Codex turn/start failed: Not initialized",
      },
    ]);
  });

  it("does not report completion between consecutive command executions", () => {
    const provider = new CodexProvider();
    provider.onSessionCreated("session-1", "edit");

    expect(provider.parseStdoutLine(JSON.stringify(commandExecutionCompleted("cmd-1")), "session-1"))
      .toEqual([
        { type: "tool_use", tool: "Bash", input: { command: "/bin/bash -lc \"echo hi\"" }, toolUseId: "cmd-1" },
        { type: "tool_result", tool: "Bash", output: "hi\n", toolUseId: "cmd-1" },
      ]);
    expect(provider.parseStdoutLine(JSON.stringify(tokenUsageUpdated(20, 5)), "session-1")).toEqual([]);

    expect(provider.parseStdoutLine(JSON.stringify(commandExecutionCompleted("cmd-2")), "session-1"))
      .toEqual([
        { type: "tool_use", tool: "Bash", input: { command: "/bin/bash -lc \"echo hi\"" }, toolUseId: "cmd-2" },
        { type: "tool_result", tool: "Bash", output: "hi\n", toolUseId: "cmd-2" },
      ]);
    expect(provider.parseStdoutLine(JSON.stringify(tokenUsageUpdated(30, 7)), "session-1")).toEqual([]);
    provider.parseStdoutLine(JSON.stringify(finalAgentMessageCompleted()), "session-1");

    expect(provider.parseStdoutLine(JSON.stringify(turnCompleted()), "session-1")).toEqual([
      {
        type: "result",
        subtype: "success",
        input_tokens: 30,
        output_tokens: 7,
      },
    ]);
  });
});
