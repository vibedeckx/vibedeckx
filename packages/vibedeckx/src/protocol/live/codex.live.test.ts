// packages/vibedeckx/src/protocol/live/codex.live.test.ts
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import type { CodexIncoming } from "../codex/codec.js";
import { buildApprovalResponse } from "../codex/codec.js";
import { buildCodexExecCommand } from "../codex/cli.js";
import { detectBinary } from "../shared/binary.js";
import { codexBinaryAvailable, compatRequired, runCodexAppServer, runOneShot } from "./runner.js";

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

describe.skipIf(!available)("codex live probes (items & exec)", () => {
  it("CX-3: commandExecution item carries command and aggregatedOutput", async () => {
    const r = await runCodexAppServer({
      turns: ["Run exactly this shell command and nothing else: echo vibedeckx-probe. Then reply DONE."],
      recordAs: "cx3-command",
    });
    expect(r.outcome).toBe("ok");
    expect(r.contractFailures).toEqual([]);
    const cmds = items(r.incoming, "commandExecution");
    expect(cmds.length, "no commandExecution item").toBeGreaterThan(0);
    expect(typeof cmds[0].command).toBe("string");
    expect(String(cmds[0].command)).toContain("vibedeckx-probe");
  });

  it("CX-4: fileChange item carries changes[].path", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "vibedeckx-compat-cx4-"));
    const r = await runCodexAppServer({
      turns: ["Create a file named probe.txt containing the single word hello. Then reply DONE."],
      cwd,
      recordAs: "cx4-filechange",
    });
    expect(r.outcome).toBe("ok");
    expect(r.contractFailures).toEqual([]);
    const changes = items(r.incoming, "fileChange");
    expect(changes.length, "no fileChange item — codex may have used commandExecution; strengthen the prompt (e.g. 'use your file editing capability, not shell commands')").toBeGreaterThan(0);
    const first = (changes[0].changes as Array<{ path?: unknown }> | undefined)?.[0];
    expect(typeof first?.path).toBe("string");
  });

  it("CX-5: cancelling an in-flight turn (turn/interrupt) terminates it before completion", async () => {
    let cancelled = false;
    const r = await runCodexAppServer({
      turns: ["Run this shell command: sleep 60. Then reply DONE."],
      timeoutMs: 60_000,
      recordAs: "cx5-cancel",
      onIncoming: (inc, ctl) => {
        // Cancel as soon as the turn shows activity (first item/completed
        // event). cancelTurn() sends the production interrupt mechanism —
        // `turn/interrupt { threadId, turnId }` via buildTurnInterrupt, the
        // same builder codex-provider.ts's formatInterrupt uses. (The
        // original LSP-style `$/cancelRequest { id: <turn/start rpc id> }`
        // was verified inert against real codex 0.144.1 on two independent
        // live attempts — sleep 60 ran to the full timeout both times; see
        // the turn/interrupt discovery notes in protocol/codex/codec.ts.)
        if (!cancelled && inc.kind === "notification" && inc.method === "item/completed") {
          cancelled = true;
          ctl.cancelTurn();
        }
      },
    });
    // Outcome must not be a 60s timeout: the cancel must terminate the turn,
    // via error response for the turn id or a non-completed turn/completed
    // (real codex reports turn.status "interrupted" — see TurnStatus enum).
    expect(r.outcome, `cancel did not terminate the turn (stderr: ${r.stderr.slice(0, 300)})`).toBe("ok");
    const finals = items(r.incoming, "agentMessage").filter((i) => i.phase === "final_answer");
    const turnErrors = r.incoming.filter((i) => i.kind === "error_response");
    const completions = notifications(r.incoming, "turn/completed")
      .map((n) => (n.params as { turn?: { status?: string } })?.turn?.status);
    const terminatedAbnormally = turnErrors.length > 0 || completions.some((s) => s !== "completed") || finals.length === 0;
    expect(terminatedAbnormally, `expected interrupted turn; statuses=${completions.join(",")}`).toBe(true);
  });

  it("CX-7: exec mode writes --output-last-message file", async () => {
    const outFile = path.join(mkdtempSync(path.join(tmpdir(), "vibedeckx-compat-cx7-")), "last.txt");
    // `codex exec <prompt>` also reads-until-EOF from stdin when stdin isn't
    // a TTY ("Reading additional input from stdin...", appended as a
    // <stdin> block per `codex exec --help`). runOneShot's child stdin is a
    // pipe that is never written to or closed, so without `< /dev/null`
    // codex blocks forever waiting for input that will never arrive —
    // verified live: identical hang to the internal 180s timeout on two
    // consecutive attempts (vitest retry: 1) before this redirect was
    // added. Production is unaffected (process-manager.ts's exec path
    // writes the prompt then explicitly `.end()`s stdin); this is purely a
    // gap in the compat harness's runOneShot, worked around here in-file
    // rather than touching runner.ts (out of this task's scope).
    const cmd = buildCodexExecCommand(detectBinary("codex"), "Reply with the word PONG and nothing else. Do not run any commands.", outFile) + " < /dev/null";
    const r = await runOneShot(cmd, { timeoutMs: 180_000 });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    const lastMessage = readFileSync(outFile, "utf-8").trim();
    expect(lastMessage.length, "--output-last-message file empty or missing").toBeGreaterThan(0);
  }, 200_000); // vitest.live.config.ts's default testTimeout (120s) is shorter than runOneShot's own 180s internal timeout above — without this the test framework kills the test at 120s before the internal timeout can ever fire, misreporting a real ~150s exec run as a vitest-level timeout rather than the runOneShot outcome under test.
});

describe.skipIf(!available)("codex live probes (approval round-trip)", () => {
  it("CX-8: on-request approval — server request arrives, accept reply lets the command run", async () => {
    const approvalsSeen: Array<{ method: string; id: string | number }> = [];
    const r = await runCodexAppServer({
      turns: ["Run exactly this shell command: echo approval-probe. Then reply DONE."],
      threadStartParams: { sandbox: "workspace-write", approvalPolicy: "on-request" },
      timeoutMs: 120_000,
      recordAs: "cx8-approval",
      onIncoming: (inc, ctl) => {
        if (inc.kind === "server_request" && inc.method.endsWith("requestApproval")) {
          approvalsSeen.push({ method: inc.method, id: inc.id });
          ctl.reply(buildApprovalResponse(String(inc.id), "accept"));
        }
      },
    });
    expect(r.outcome).toBe("ok");
    expect(r.contractFailures).toEqual([]);
    expect(approvalsSeen.length, "no requestApproval server request under approvalPolicy=on-request").toBeGreaterThan(0);
    expect(approvalsSeen[0].method).toBe("item/commandExecution/requestApproval");
    // accept reply must unblock the command: expect the commandExecution item afterwards
    const cmds = items(r.incoming, "commandExecution");
    expect(cmds.length, "approval accepted but command never executed — decision format drifted?").toBeGreaterThan(0);
  });

  it("CX-8b: decline reply prevents execution", async () => {
    const r = await runCodexAppServer({
      turns: ["Run exactly this shell command: echo should-not-run. Then reply DONE."],
      threadStartParams: { sandbox: "workspace-write", approvalPolicy: "on-request" },
      timeoutMs: 120_000,
      recordAs: "cx8b-decline",
      onIncoming: (inc, ctl) => {
        if (inc.kind === "server_request" && inc.method.endsWith("requestApproval")) {
          ctl.reply(buildApprovalResponse(String(inc.id), "decline"));
        }
      },
    });
    expect(r.outcome).toBe("ok");
    const cmds = items(r.incoming, "commandExecution").filter((c) => String(c.aggregatedOutput ?? "").includes("should-not-run"));
    expect(cmds.length, "declined command still produced output").toBe(0);
  });
});
