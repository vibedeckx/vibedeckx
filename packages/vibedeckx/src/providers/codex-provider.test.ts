import { describe, expect, it } from "vitest";
import { CodexProvider } from "./codex-provider.js";

describe("CodexProvider", () => {
  it("forwards cross-remote MCP configuration to the app-server process", () => {
    const provider = new CodexProvider();
    const config = provider.buildSpawnConfig("/tmp", "edit", {
      url: "https://app.example.com/api/cross-remote-mcp",
      token: "secret-token",
    });

    expect(config.args).toContain("-c");
    expect(config.args.join(" ")).toContain("mcp_servers.cross-remote");
    expect(config.args.join(" ")).not.toContain("secret-token");
    expect(config.env).toEqual({ VIBEDECKX_CROSS_REMOTE_MCP_TOKEN: "secret-token" });
  });

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

  it("formatInterrupt sends turn/interrupt for the tracked in-flight turn, null when unknown", () => {
    const provider = new CodexProvider();
    provider.onSessionCreated("session-1", "edit");

    // Nothing known yet — caller must fall back to killing the process.
    expect(provider.formatInterrupt("session-1")).toBeNull();

    // initialize (id 1) + thread/start (id 2) sent at spawn
    provider.getInitializationMessages("session-1");
    provider.parseStdoutLine(
      JSON.stringify({ jsonrpc: "2.0", id: 2, result: { thread: { id: "thread-1" } } }),
      "session-1",
    );

    // threadId known but no turn in flight yet — still null.
    expect(provider.formatInterrupt("session-1")).toBeNull();

    // An item notification carries the in-flight turn's UUID (params.turnId).
    provider.parseStdoutLine(JSON.stringify(commandExecutionCompleted()), "session-1");

    const line = provider.formatInterrupt("session-1");
    expect(line).not.toBeNull();
    expect(JSON.parse(line!)).toEqual({
      jsonrpc: "2.0",
      id: 3,
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });

    // turn/completed clears the in-flight turn — nothing left to interrupt.
    provider.parseStdoutLine(JSON.stringify(turnCompleted()), "session-1");
    expect(provider.formatInterrupt("session-1")).toBeNull();

    // The turn/start JSON-RPC response is the earliest turn-UUID carrier —
    // formatInterrupt must work from it alone (turn with zero items so far).
    provider.formatUserInput("hello again", "session-1"); // turn/start, id 4
    provider.parseStdoutLine(
      JSON.stringify({ jsonrpc: "2.0", id: 4, result: { turn: { id: "019f-turn-uuid-2", status: "inProgress" } } }),
      "session-1",
    );
    const line2 = provider.formatInterrupt("session-1");
    expect(JSON.parse(line2!)).toEqual({
      jsonrpc: "2.0",
      id: 5,
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "019f-turn-uuid-2" },
    });
  });
});
