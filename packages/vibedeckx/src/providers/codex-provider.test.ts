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

  it("renders image views as tool activity with the image path", () => {
    const provider = new CodexProvider();
    provider.onSessionCreated("session-1", "edit");

    const events = provider.parseStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            type: "imageView",
            id: "image-1",
            path: "/tmp/screenshot.png",
          },
        },
      }),
      "session-1",
    );

    expect(events).toEqual([
      {
        type: "tool_use",
        tool: "ImageView",
        input: { path: "/tmp/screenshot.png" },
        toolUseId: "image-1",
      },
    ]);
  });

  it("surfaces thread/start's thread.id as native_session_id, before any buffered-turn flush", () => {
    const provider = new CodexProvider();
    provider.onSessionCreated("session-1", "edit");

    // First user input arrives before thread/start responds — it gets buffered.
    provider.getInitializationMessages("session-1");
    provider.formatUserInput("hello", "session-1");

    const events = provider.parseStdoutLine(
      JSON.stringify({ jsonrpc: "2.0", id: 2, result: { thread: { id: "019fe07f-9454-77f1-8551-32618b50f2b2" } } }),
      "session-1",
    );

    expect(events[0]).toEqual({ type: "native_session_id", id: "019fe07f-9454-77f1-8551-32618b50f2b2" });
    // The buffered first turn still flushes, after the identity event.
    expect(events[1]).toMatchObject({ type: "stdin_write" });
    expect(events).toHaveLength(2);
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

  // ============ Collab subagents (fixture lines are real codex 0.144.3 output) ============
  //
  // Codex runs collab subagents as sibling THREADS inside the same app-server
  // process: their turn/started, item/*, and turn/completed notifications are
  // multiplexed into the main session's stdout, distinguished only by
  // params.threadId. Verified live: the main thread's turn/completed fires
  // while the subagent is still running, and codex never auto-resumes the
  // main thread when the subagent finishes.

  const MAIN_THREAD = "019f5bfb-a05d-71c2-96d8-f2b45e56ea49";
  const SUB_THREAD = "019f5bfb-d05a-7541-8a6a-b8507b398782";

  function subagentProvider(): CodexProvider {
    const provider = new CodexProvider();
    provider.onSessionCreated("session-1", "edit");
    provider.getSessionState("session-1").threadId = MAIN_THREAD;
    return provider;
  }

  it("parses subAgentActivity kind=started into task_started keyed by agentThreadId", () => {
    const provider = subagentProvider();
    const line = JSON.stringify({
      method: "item/completed",
      params: {
        item: { type: "subAgentActivity", id: "call_CwKEj5c9uRF2MQ1LgIWyrKqY", kind: "started", agentThreadId: SUB_THREAD, agentPath: "/root/ok_reply" },
        threadId: MAIN_THREAD,
        turnId: "019f5bfb-a7e8-7012-9476-c40c616eb6ff",
        completedAtMs: 1783954659013,
      },
    });
    expect(provider.parseStdoutLine(line, "session-1")).toEqual([
      { type: "task_started", taskId: SUB_THREAD, taskType: "codex_subagent", description: "/root/ok_reply" },
    ]);
  });

  it("parses a subagent thread's turn/started into task_started (belt for subAgentActivity)", () => {
    const provider = subagentProvider();
    const line = JSON.stringify({
      method: "turn/started",
      params: { threadId: SUB_THREAD, turn: { id: "019f5bfb-d6c5-7653-8455-266cc5ac3e15", status: "inProgress" } },
    });
    expect(provider.parseStdoutLine(line, "session-1")).toEqual([
      { type: "task_started", taskId: SUB_THREAD, taskType: "codex_subagent" },
    ]);
  });

  it("parses a subagent thread's turn/completed into task_finished, NOT a result", () => {
    const provider = subagentProvider();
    const line = JSON.stringify({
      method: "turn/completed",
      params: { threadId: SUB_THREAD, turn: { id: "019f5bfb-d6c5-7653-8455-266cc5ac3e15", status: "completed", error: null } },
    });
    expect(provider.parseStdoutLine(line, "session-1")).toEqual([
      { type: "task_finished", taskId: SUB_THREAD, status: "completed" },
    ]);
  });

  it("does not render a subagent thread's agentMessage into the main conversation", () => {
    const provider = subagentProvider();
    const line = JSON.stringify({
      method: "item/completed",
      params: {
        item: { type: "agentMessage", id: "msg_sub", text: "OK", phase: "final_answer" },
        threadId: SUB_THREAD,
        turnId: "019f5bfb-d6c5-7653-8455-266cc5ac3e15",
      },
    });
    expect(provider.parseStdoutLine(line, "session-1")).toEqual([]);
  });

  it("a subagent's final message must not mark the MAIN turn as having a final answer", () => {
    const provider = subagentProvider();
    // Subagent's final answer arrives first (foreign thread)...
    provider.parseStdoutLine(JSON.stringify({
      method: "item/completed",
      params: { item: { type: "agentMessage", id: "m1", text: "OK", phase: "final_answer" }, threadId: SUB_THREAD, turnId: "sub-turn" },
    }), "session-1");
    // ...then the subagent's turn completes: without thread filtering this
    // produced a spurious `result` for the main session (second chime).
    const events = provider.parseStdoutLine(JSON.stringify({
      method: "turn/completed",
      params: { threadId: SUB_THREAD, turn: { id: "sub-turn", status: "completed" } },
    }), "session-1");
    expect(events).toEqual([{ type: "task_finished", taskId: SUB_THREAD, status: "completed" }]);
  });

  it("does not let subagent token usage pollute the main session's usage", () => {
    const provider = subagentProvider();
    provider.parseStdoutLine(JSON.stringify({
      method: "thread/tokenUsage/updated",
      params: { threadId: SUB_THREAD, tokenUsage: { last: { inputTokens: 999, outputTokens: 999 } } },
    }), "session-1");
    provider.parseStdoutLine(JSON.stringify({
      method: "item/completed",
      params: { item: { type: "agentMessage", id: "m2", text: "done", phase: "final_answer" }, threadId: MAIN_THREAD, turnId: "main-turn" },
    }), "session-1");
    const events = provider.parseStdoutLine(JSON.stringify({
      method: "turn/completed",
      params: { threadId: MAIN_THREAD, turn: { id: "main-turn", status: "completed" } },
    }), "session-1");
    expect(events).toEqual([{ type: "result", subtype: "success" }]);
  });

  it("does not clobber the main turn's interrupt target with subagent turn ids", () => {
    const provider = subagentProvider();
    const state = provider.getSessionState("session-1");
    state.currentTurnId = "main-turn-uuid";
    provider.parseStdoutLine(JSON.stringify({
      method: "item/completed",
      params: { item: { type: "commandExecution", id: "e1", command: "ls", aggregatedOutput: "" }, threadId: SUB_THREAD, turnId: "sub-turn-uuid" },
    }), "session-1");
    expect(state.currentTurnId).toBe("main-turn-uuid");
  });

  it("parses the MAIN thread's turn/started into turn_started (cancels a grace-held completion)", () => {
    const provider = subagentProvider();
    const line = JSON.stringify({
      method: "turn/started",
      params: { threadId: MAIN_THREAD, turn: { id: "019f5bfb-a7e8-7012-9476-c40c616eb6ff", status: "inProgress" } },
    });
    expect(provider.parseStdoutLine(line, "session-1")).toEqual([{ type: "turn_started" }]);
  });

  it("treats notifications without a known main threadId as main-thread (pre-thread/start safety)", () => {
    const provider = new CodexProvider();
    provider.onSessionCreated("session-1", "edit");
    // threadId still null — legacy shape without params.threadId keeps working
    provider.parseStdoutLine(JSON.stringify({
      method: "item/completed",
      params: { item: { type: "agentMessage", id: "m", text: "hi", phase: "final_answer" }, turnId: "t1" },
    }), "session-1");
    const events = provider.parseStdoutLine(JSON.stringify({
      method: "turn/completed",
      params: { turn: { id: "t1", status: "completed" } },
    }), "session-1");
    expect(events).toEqual([{ type: "result", subtype: "success" }]);
  });
});

// Codex does NOT emit a commandExecution item for a command whose sandbox
// failed to start — verified live on a host with unprivileged user namespaces
// restricted: an `ls` that returned exit 1 with "bwrap: loopback: Failed
// RTM_NEWADDR: Operation not permitted" produced only userMessage /
// agentMessage / reasoning items, with Code Mode both enabled and disabled.
// A real reviewer session lost 10 of its 21 tool calls that way and its record
// showed only the successes, so nothing explained why it gave up. These
// out-of-band notifications are the only trace of such faults that reaches us.
describe("CodexProvider environment-fault notifications", () => {
  const THREAD = "019f5bfb-a05d-71c2-96d8-f2b45e56ea49";

  function provider(): CodexProvider {
    const p = new CodexProvider();
    p.onSessionCreated("session-1", "plan");
    return p;
  }

  function parse(p: CodexProvider, notification: Record<string, unknown>) {
    return p.parseStdoutLine(JSON.stringify(notification), "session-1");
  }

  it("records the sandbox configWarning that would otherwise be the only trace of a broken session", () => {
    // Payload verbatim from a live codex 0.145.0 run.
    expect(parse(provider(), {
      method: "configWarning",
      params: { summary: "Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces.", details: null },
    })).toEqual([{
      type: "system",
      content: "Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces.",
    }]);
  });

  it("appends warning details when present", () => {
    expect(parse(provider(), {
      method: "configWarning",
      params: { summary: "Sandbox degraded.", details: "Falling back." },
    })).toEqual([{ type: "system", content: "Sandbox degraded. Falling back." }]);
  });

  it("keeps a warning whose payload shape is unknown rather than dropping it", () => {
    const events = parse(provider(), { method: "warning", params: { unexpectedField: "sandbox is on fire" } });
    expect(events).toHaveLength(1);
    expect((events[0] as { content: string }).content).toContain("sandbox is on fire");
  });

  it("records a failed MCP server with its reason", () => {
    // Verbatim from the same live run — the reviewer's GitHub fallback was
    // crippled by this and the session record never showed it.
    expect(parse(provider(), {
      method: "mcpServer/startupStatus/updated",
      params: { threadId: THREAD, name: "github", status: "failed", error: "The github MCP server is not logged in. Run `codex mcp login github`.", failureReason: null },
    })).toEqual([{
      type: "system",
      content: 'MCP server "github" failed to start. The github MCP server is not logged in. Run `codex mcp login github`.',
    }]);
  });

  it("ignores non-terminal MCP server status updates", () => {
    const p = provider();
    for (const status of ["starting", "ready"]) {
      expect(parse(p, {
        method: "mcpServer/startupStatus/updated",
        params: { threadId: THREAD, name: "context7", status, error: null },
      })).toEqual([]);
    }
  });

  it("still drops a subagent thread's MCP failure from the main conversation", () => {
    const p = provider();
    p.getSessionState("session-1").threadId = THREAD;
    expect(parse(p, {
      method: "mcpServer/startupStatus/updated",
      params: { threadId: "019f5bfb-d05a-7541-8a6a-b8507b398782", name: "github", status: "failed", error: "nope" },
    })).toEqual([]);
  });

  it("keeps the payload of an item type this provider does not model", () => {
    const events = parse(provider(), {
      method: "item/completed",
      params: { turnId: "t1", item: { type: "dynamicToolCall", id: "d1", tool: "exec", arguments: { cmd: "ls" } } },
    });
    const content = (events[0] as { content: string }).content;
    expect(content).toContain("[dynamicToolCall]");
    expect(content).toContain("exec");
    expect(content).toContain("ls");
    expect(content).not.toContain("d1"); // id is noise, and is already the toolUseId elsewhere
  });

  it("bounds an unmodelled item's payload so a huge one cannot flood the record", () => {
    const events = parse(provider(), {
      method: "item/completed",
      params: { turnId: "t1", item: { type: "contextCompaction", id: "c1", blob: "x".repeat(5000) } },
    });
    const content = (events[0] as { content: string }).content;
    expect(content.length).toBeLessThan(600);
    expect(content.endsWith("…")).toBe(true);
  });

  it("emits a bare marker when an unmodelled item carries no payload", () => {
    expect(parse(provider(), {
      method: "item/completed",
      params: { turnId: "t1", item: { type: "enteredReviewMode", id: "r1" } },
    })).toEqual([{ type: "system", content: "[enteredReviewMode]" }]);
  });
});

/**
 * Late items from completed turns. A backgrounded exec (unified exec with
 * yield_time_ms, polled via `wait`) can finish after codex already sent
 * turn/completed: the CLI then emits a lone item/completed carrying the old
 * turnId — no turn/started before it, no turn/completed after (observed live,
 * codex 0.147). Classification is by turnId attribution, NOT arrival time: a
 * temporal "between turns" window would misclassify a live item whose
 * turn/started was lost, and miss a late item landing mid-next-turn.
 */
describe("CodexProvider late items from completed turns", () => {
  function feed(provider: CodexProvider, obj: unknown) {
    return provider.parseStdoutLine(JSON.stringify(obj), "session-1");
  }

  function execItem(turnId: string) {
    return {
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        turnId,
        item: { type: "commandExecution", id: "exec-late-1", command: "npm test", aggregatedOutput: "ok\n", status: "completed" },
      },
    };
  }

  function completedTurn(provider: CodexProvider, turnId: string) {
    feed(provider, {
      jsonrpc: "2.0",
      method: "item/completed",
      params: { turnId, item: { type: "agentMessage", id: "m1", text: "done", phase: "final_answer" } },
    });
    feed(provider, {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { turn: { id: turnId, status: "completed" } },
    });
  }

  it("flags an exec item arriving after its turn completed as outOfTurn, without re-arming the interrupt target", () => {
    const provider = new CodexProvider();
    provider.onSessionCreated("session-1", "edit");
    completedTurn(provider, "turn-1");
    expect(provider.getSessionState("session-1").currentTurnId).toBeNull(); // cleared by turn/completed

    const events = feed(provider, execItem("turn-1"));

    expect(events).toEqual([
      { type: "tool_use", tool: "Bash", input: { command: "npm test" }, toolUseId: "exec-late-1", outOfTurn: true },
      { type: "tool_result", tool: "Bash", output: "ok\n", toolUseId: "exec-late-1", outOfTurn: true },
    ]);
    // The dead turn must not become the interrupt target again.
    expect(provider.getSessionState("session-1").currentTurnId).toBeNull();
  });

  it("treats an item of an unknown turn as live activity (a lost turn/started must not be misclassified)", () => {
    const provider = new CodexProvider();
    provider.onSessionCreated("session-1", "edit");
    completedTurn(provider, "turn-1");

    const events = feed(provider, execItem("turn-2"));

    expect(events).toEqual([
      { type: "tool_use", tool: "Bash", input: { command: "npm test" }, toolUseId: "exec-late-1" },
      { type: "tool_result", tool: "Bash", output: "ok\n", toolUseId: "exec-late-1" },
    ]);
    expect(provider.getSessionState("session-1").currentTurnId).toBe("turn-2");
  });

  it("a late final message does not re-add its completed turn to turnsWithFinalMessage", () => {
    const provider = new CodexProvider();
    provider.onSessionCreated("session-1", "edit");
    completedTurn(provider, "turn-1");

    feed(provider, {
      jsonrpc: "2.0",
      method: "item/completed",
      params: { turnId: "turn-1", item: { type: "agentMessage", id: "m2", text: "late", phase: "final_answer" } },
    });

    expect(provider.getSessionState("session-1").turnsWithFinalMessage.has("turn-1")).toBe(false);
  });

  it("bounds the completed-turn memory with FIFO eviction", () => {
    const provider = new CodexProvider();
    provider.onSessionCreated("session-1", "edit");
    for (let i = 0; i < 40; i++) {
      completedTurn(provider, `t${i}`);
    }
    const ids = provider.getSessionState("session-1").completedTurnIds;
    expect(ids.size).toBe(32);
    expect(ids.has("t7")).toBe(false); // 40 completed, oldest 8 evicted
    expect(ids.has("t8")).toBe(true);
    expect(ids.has("t39")).toBe(true);
  });
});
