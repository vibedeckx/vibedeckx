// packages/vibedeckx/src/protocol/live/codex.live.test.ts
import { describe, expect, it } from "vitest";
import type { CodexIncoming } from "../codex/codec.js";
import { codexBinaryAvailable, compatRequired, runCodexAppServer } from "./runner.js";

const available = codexBinaryAvailable();
if (!available && compatRequired()) {
  throw new Error("VIBEDECKX_COMPAT_REQUIRED=1 but no codex binary available");
}

function notifications(incoming: CodexIncoming[], method: string) {
  return incoming.filter((i) => i.kind === "notification" && i.method === method) as Array<{ method: string; params: unknown }>;
}
function items(incoming: CodexIncoming[], type: string) {
  return notifications(incoming, "item/completed")
    .map((n) => (n.params as { item?: { type?: string } })?.item)
    .filter((it): it is Record<string, unknown> & { type: string } => !!it && it.type === type);
}

describe.skipIf(!available)("codex live probes (core)", () => {
  it("CX-1+CX-2: handshake yields thread id; turn yields final agentMessage and turn/completed", async () => {
    const r = await runCodexAppServer({
      turns: ["Reply with the word PONG and nothing else. Do not run any commands."],
      recordAs: "cx1-2-handshake-turn",
    });
    expect(r.outcome).toBe("ok");
    expect(r.contractFailures).toEqual([]);
    expect(r.threadId, "thread/start response no longer carries result.thread.id").toBeTruthy();
    const finals = items(r.incoming, "agentMessage");
    expect(finals.length, "no agentMessage item/completed").toBeGreaterThan(0);
    expect(notifications(r.incoming, "turn/completed").length).toBeGreaterThan(0);
  });

  it("CX-6: thread/tokenUsage/updated carries last.inputTokens/outputTokens", async () => {
    const r = await runCodexAppServer({
      turns: ["Reply with the word HI and nothing else."],
      recordAs: "cx6-tokenusage",
    });
    expect(r.outcome).toBe("ok");
    const usages = notifications(r.incoming, "thread/tokenUsage/updated");
    expect(usages.length, "no tokenUsage notification").toBeGreaterThan(0);
    const last = (usages[usages.length - 1].params as { tokenUsage?: { last?: { inputTokens?: unknown; outputTokens?: unknown } } })?.tokenUsage?.last;
    expect(typeof last?.inputTokens).toBe("number");
    expect(typeof last?.outputTokens).toBe("number");
  });
});
