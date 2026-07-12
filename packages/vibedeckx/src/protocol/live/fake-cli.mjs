// Replays canned protocol lines for offline runner tests. Mode = argv[2].
const mode = process.argv[2];
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

const CLAUDE_TURN = (n) => {
  out({ type: "assistant", message: { content: [{ type: "text", text: `reply ${n}` }, { type: "tool_use", id: `t${n}`, name: "Bash", input: { command: "echo hi" } }] }, session_id: "fake" });
  out({ type: "result", subtype: "success", duration_ms: 5, cost_usd: 0.0001, session_id: "fake" });
};

if (mode === "auth-fail") {
  process.stderr.write("Invalid API key. Please run /login\n");
  process.exit(1);
}
if (mode === "hang") {
  setInterval(() => {}, 1000); // never speak, never exit
}

let turns = 0;
let codexTurnCounter = 0;
let buffered = "";
process.stdin.on("data", (d) => {
  buffered += d.toString();
  let idx;
  while ((idx = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, idx);
    buffered = buffered.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);

    if (mode === "claude-basic" || mode === "claude-multiturn") {
      turns++;
      CLAUDE_TURN(turns);
    } else if (mode === "claude-drift") {
      out({ type: "assistant", message: { content: [{ type: "text", text: 42 }] }, session_id: "fake" }); // text is a number: consumed-field type change
      out({ type: "result", subtype: "success" });
    } else if (mode === "codex-basic") {
      if (msg.method === "initialize") out({ jsonrpc: "2.0", id: msg.id, result: {} });
      if (msg.method === "thread/start") out({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "t-fake" } } });
      if (msg.method === "turn/start") {
        // Per-turn counter: each turn/start gets its own turnId so a
        // multi-turn run produces distinguishable item/completed +
        // turn/completed pairs (pins the runner's count-based turn-loop fix).
        codexTurnCounter++;
        const turnId = `turn-${codexTurnCounter}`;
        out({ jsonrpc: "2.0", method: "item/completed", params: { turnId, item: { type: "agentMessage", id: `m${codexTurnCounter}`, text: "done", phase: "final_answer" } } });
        out({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { tokenUsage: { last: { inputTokens: 1, outputTokens: 2 } } } });
        out({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: turnId, status: "completed" } } });
      }
    } else if (mode === "codex-duplicate-line") {
      if (msg.method === "initialize") out({ jsonrpc: "2.0", id: msg.id, result: {} });
      if (msg.method === "thread/start") out({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "t-fake" } } });
      if (msg.method === "turn/start") {
        codexTurnCounter++;
        const turnId = `turn-${codexTurnCounter}`;
        const dup = { jsonrpc: "2.0", method: "item/completed", params: { turnId, item: { type: "agentMessage", id: `m${codexTurnCounter}`, text: "done", phase: "final_answer" } } };
        out(dup);
        out(dup); // byte-identical duplicate line — must not be dropped from `incoming`
        out({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: turnId, status: "completed" } } });
      }
    }
  }
});
process.stdin.on("end", () => process.exit(0));
