import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { getBinaryVersion } from "../shared/binary.js";
import { compatRequired } from "./runner.js";
import { checkContract } from "../contract-check.js";
import { FX_CONTRACTS, FxEnvelopeSchema, FxInitializeResultSchema, FxNewResultSchema, FxPromptResultSchema, FxUpdateParamsSchema, FxPermissionParamsSchema } from "../fx/schema.js";

import { FxProvider } from "../../providers/fx-provider.js";
import type { ParsedAgentEvent } from "../../agent-provider.js";

const available = new FxProvider().detectBinary();
if (!available && compatRequired()) throw new Error("VIBEDECKX_COMPAT_REQUIRED=1 but no fx binary available");

/** Real binary + real model smoke test, excluded from the offline suite. */
describe.skipIf(!available)("fx live provider lifecycle", () => {
  it("streams, queues, cancels, restarts with replay and honors a new spawn model without changing user settings", async () => {
    const p = new FxProvider();
    if (!p.detectBinary()) throw new Error("Install and sign in to fx before running this live test.");
    const cwd = mkdtempSync(join(tmpdir(), "fx-live-"));
    const settings = join(homedir(), ".fx/settings.json");
    const before = existsSync(settings) ? readFileSync(settings) : null;
    const processes: Array<ReturnType<typeof spawn>> = [];
    const stopped = new Set<ReturnType<typeof spawn>>();
    const stop = async (child: ReturnType<typeof spawn>) => {
      stopped.add(child);
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, "close");
      child.kill();
      const force = setTimeout(() => child.kill("SIGKILL"), 3000);
      try { await closed; } finally { clearTimeout(force); }
    };
    const transcripts: string[][] = [];
    const writers = new Map<ReturnType<typeof spawn>, (line: string) => void>();
    const version = getBinaryVersion(available!, { FX_AUTO_UPGRADE: "0" });
    let failure: Error | undefined;
    const write = (child: ReturnType<typeof spawn>, line: string) => writers.get(child)!(line);
    const events: ParsedAgentEvent[] = [];
    let selectedModel: string | undefined;
    let cancelOnTool = false;
    let toolWasCancelled = false;
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 90_000;
      while (!predicate()) {
        if (failure) throw failure;
        // The deliberate cancel below ends its prompt as a non-end_turn result.
        const error = events.find(e => e.type === "result" && e.subtype === "error" && e.error !== "fx stopped: cancelled");
        if (error?.type === "result") throw new Error(error.error);
        if (Date.now() > deadline) throw new Error("Timed out waiting for fx lifecycle event");
        await new Promise(r => setTimeout(r, 20));
      }
      if (failure) throw failure;
    };
    const launch = (model: string) => {
      p.onSessionDestroyed("live"); p.onSessionCreated("live", "edit");
      const config = p.buildSpawnConfig(cwd, "edit", undefined, model);
      expect(config.args).toContain("full-access");
      const child = spawn(config.command, config.args, { cwd, env: { ...process.env, ...config.env }, stdio: ["pipe", "pipe", "pipe"] }); processes.push(child);
      child.stderr.resume();
      child.on("error", error => { failure = error; });
      child.stdin.on("error", error => { failure = error; });
      child.on("exit", () => {
        if (!stopped.has(child)) {
          failure ??= new Error("fx exited before the expected lifecycle result");
        }
      });
      const transcript: string[] = []; transcripts.push(transcript);
      const requests = new Map<string | number, string>();
      const record = (direction: string, message: unknown) => transcript.push(
        JSON.stringify({ direction, message }).replaceAll(cwd, "<WORKSPACE>").replaceAll(homedir(), "<HOME>"),
      );
      writers.set(child, line => {
        if (!line.trim()) return;
        for (const part of line.trim().split("\n")) {
          const message = JSON.parse(part);
          if (message.method && message.id != null) requests.set(message.id, message.method);
          record("stdin", message);
        }
        child.stdin.write(line);
      });
      const lines = createInterface({ input: child.stdout });
      lines.on("line", line => {
        try {
          const raw = JSON.parse(line);
          record("stdout", raw);
          const method = raw.method ?? requests.get(raw.id);
          const schema = raw.method === "session/update" ? FxUpdateParamsSchema
            : raw.method === "session/request_permission" ? FxPermissionParamsSchema
            : method === "initialize" ? FxInitializeResultSchema
            : method === "session/new" ? FxNewResultSchema
            : method === "session/prompt" ? FxPromptResultSchema : undefined;
          for (const [shape, value] of [[FxEnvelopeSchema, raw], ...(!raw.error && schema ? [[schema, raw.method ? raw.params : raw.result]] : [])] as const) {
            const contract = FX_CONTRACTS.find(c => c.schema === shape)!;
            const report = checkContract(contract, value);
            if (!report.ok) throw new Error(`${contract.id}: ${report.issues.join("; ")}`);
          }
          if (raw.result?.configOptions) selectedModel = raw.result.configOptions.find((c: { id: string }) => c.id === "model")?.currentValue;
          for (const event of p.parseStdoutLine(line, "live")) {
            events.push(event);
            if (event.type === "stdin_write") write(child, event.content);
            if (cancelOnTool && event.type === "tool_use") {
              cancelOnTool = false; toolWasCancelled = true;
              write(child, p.formatInterrupt("live")!);
            }
          }
        } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
      });
      write(child, p.getInitializationMessages("live", { cwd, systemPrompt: "Be concise. Follow the user's exact output instructions." })!);
      return child;
    };
    const results = () => events.filter(e => e.type === "result");
    try {
      let child = launch(process.env.FX_COMPAT_MODEL ?? "spacexai/grok-4.7");
      write(child, p.formatUserInput("Remember the marker LIFECYCLE731. Reply only with LIFECYCLE731. Do not use tools.", "live"));
      write(child, p.formatUserInput("What marker did I just give you? Reply only with that marker.", "live"));
      await waitFor(() => results().length === 2);
      expect(results().every(e => e.subtype === "success")).toBe(true);
      const firstEnd = events.findIndex(e => e.type === "result");
      for (const turn of [events.slice(0, firstEnd), events.slice(firstEnd + 1)]) {
        expect(turn.filter(e => e.type === "text").map(e => e.content).join("")).toContain("LIFECYCLE731");
      }
      const oldNative = events.find(e => e.type === "native_session_id");
      cancelOnTool = true;
      write(child, p.formatUserInput("Use the shell tool to run: sleep 20; printf CANCEL_ME. Do not run any other commands.", "live"));
      await waitFor(() => results().length === 3);
      expect(toolWasCancelled).toBe(true);
      expect(results()[2]).toMatchObject({ subtype: "error", error: "fx stopped: cancelled" });
      write(child, p.formatUserInput("Reply only AFTER_CANCEL LIFECYCLE731.", "live"));
      await waitFor(() => results().length === 4);
      expect(results()[3].subtype).toBe("success");
      write(child, p.formatUserInput("Use the shell tool to run exactly printf FX_TOOL_OK. Then reply with its output. Do not run any other commands.", "live"));
      await waitFor(() => results().length === 5);
      expect(results()[4].subtype).toBe("success");
      expect(events.some(e => e.type === "tool_result" && e.output.includes("FX_TOOL_OK"))).toBe(true);
      expect(events.some(e => e.type === "thinking")).toBe(true);
      expect(events.some(e => e.type === "approval_request")).toBe(false);
      await stop(child);
      events.length = 0;
      child = launch(process.env.FX_COMPAT_REPLAY_MODEL ?? "openai/gpt-5.4-mini");
      write(child, p.formatUserInput("<conversation_summary><user_message>Remember the marker LIFECYCLE731.</user_message><assistant_message>LIFECYCLE731</assistant_message></conversation_summary>\nWhat marker did I give you previously? Reply only with the marker.", "live"));
      await waitFor(() => results().length === 1);
      expect(selectedModel).toBe(process.env.FX_COMPAT_REPLAY_MODEL ?? "openai/gpt-5.4-mini");
      expect(events.find(e => e.type === "native_session_id")).not.toEqual(oldNative);
      expect(events.filter(e => e.type === "text").map(e => e.content).join("")).toContain("LIFECYCLE731");
    } finally {
      for (const child of processes) await stop(child);
      p.onSessionDestroyed("live");
      const recordings = new URL("./recordings/", import.meta.url);
      mkdirSync(recordings, { recursive: true });
      transcripts.forEach((lines, i) => writeFileSync(new URL(`fx-lifecycle-${i + 1}.jsonl`, recordings), lines.join("\n") + "\n"));
      writeFileSync(new URL("fx-lifecycle.meta.json", recordings), JSON.stringify({ version, platform: process.platform, arch: process.arch, models: [process.env.FX_COMPAT_MODEL ?? "spacexai/grok-4.7", process.env.FX_COMPAT_REPLAY_MODEL ?? "openai/gpt-5.4-mini"] }, null, 2) + "\n");
      rmSync(cwd, { recursive: true, force: true });
      expect(existsSync(settings) ? readFileSync(settings) : null).toEqual(before);
    }
  }, 180_000);
});
