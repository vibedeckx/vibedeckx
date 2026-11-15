import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { FxProvider } from "../../providers/fx-provider.js";
import type { ParsedAgentEvent } from "../../agent-provider.js";

/** Real binary + real model smoke test, excluded from the offline suite. */
describe("fx live provider lifecycle", () => {
  it("streams, queues, cancels, restarts with replay and honors a new spawn model without changing user settings", async () => {
    const p = new FxProvider();
    if (!p.detectBinary()) throw new Error("Install and sign in to fx before running this live test.");
    const cwd = mkdtempSync(join(tmpdir(), "fx-live-"));
    const settings = join(homedir(), ".fx/settings.json");
    const before = existsSync(settings) ? readFileSync(settings) : null;
    const processes: Array<ReturnType<typeof spawn>> = [];
    const configs: Array<ReturnType<FxProvider["buildSpawnConfig"]>> = [];
    const events: ParsedAgentEvent[] = [];
    let selectedModel: string | undefined;
    let cancelOnTool = false;
    let toolWasCancelled = false;
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 90_000;
      while (!predicate()) {
        const error = events.find(e => e.type === "result" && e.subtype === "error");
        if (error?.type === "result") throw new Error(error.error);
        if (Date.now() > deadline) throw new Error("Timed out waiting for fx lifecycle event");
        await new Promise(r => setTimeout(r, 20));
      }
    };
    const launch = (model: string) => {
      p.onSessionDestroyed("live"); p.onSessionCreated("live", "edit");
      const config = p.buildSpawnConfig(cwd, "edit", undefined, model); configs.push(config);
      const child = spawn(config.command, config.args, { cwd, env: { ...process.env, ...config.env }, stdio: ["pipe", "pipe", "pipe"] }); processes.push(child);
      child.stderr.resume();
      const lines = createInterface({ input: child.stdout });
      lines.on("line", line => {
        const raw = JSON.parse(line);
        if (raw.result?.configOptions) selectedModel = raw.result.configOptions.find((c: { id: string }) => c.id === "model")?.currentValue;
        for (const event of p.parseStdoutLine(line, "live")) {
          events.push(event);
          if (event.type === "stdin_write") child.stdin.write(event.content);
          if (cancelOnTool && event.type === "tool_use") {
            cancelOnTool = false; toolWasCancelled = true;
            child.stdin.write(p.formatInterrupt("live")!);
          }
        }
      });
      child.stdin.write(p.getInitializationMessages("live", { cwd, systemPrompt: "Be concise. Follow the user's exact output instructions." })!);
      return child;
    };
    const results = () => events.filter(e => e.type === "result");
    try {
      let child = launch("spacexai/grok-4.7");
      child.stdin.write(p.formatUserInput("Remember the marker LIFECYCLE731. Reply only with LIFECYCLE731. Do not use tools.", "live"));
      child.stdin.write(p.formatUserInput("What marker did I just give you? Reply only with that marker.", "live"));
      await waitFor(() => results().length === 2);
      expect(results().every(e => e.subtype === "success")).toBe(true);
      expect(events.filter(e => e.type === "text").map(e => e.content).join("")).toContain("LIFECYCLE731");
      const oldNative = events.find(e => e.type === "native_session_id");
      cancelOnTool = true;
      child.stdin.write(p.formatUserInput("Use the shell tool to run: sleep 20; printf CANCEL_ME. Do not run any other commands.", "live"));
      await waitFor(() => results().length === 3);
      expect(toolWasCancelled).toBe(true);
      expect(results()[2]).toMatchObject({ subtype: "cancelled" });
      child.stdin.write(p.formatUserInput("Reply only AFTER_CANCEL LIFECYCLE731.", "live"));
      await waitFor(() => results().length === 4);
      expect(results()[3].subtype).toBe("success");
      child.stdin.write(p.formatUserInput("Use the shell tool to run exactly printf FX_TOOL_OK. Then reply with its output. Do not run any other commands.", "live"));
      await waitFor(() => results().length === 5);
      expect(results()[4].subtype).toBe("success");
      expect(events.some(e => e.type === "tool_result" && e.output.includes("FX_TOOL_OK"))).toBe(true);
      expect(events.some(e => e.type === "thinking")).toBe(true);
      child.kill(); await once(child, "close");
      events.length = 0;
      child = launch("openai/gpt-5.4-mini");
      child.stdin.write(p.formatUserInput("<conversation_summary><user_message>Remember the marker LIFECYCLE731.</user_message><assistant_message>LIFECYCLE731</assistant_message></conversation_summary>\nWhat marker did I give you previously? Reply only with the marker.", "live"));
      await waitFor(() => results().length === 1);
      expect(selectedModel).toBe("openai/gpt-5.4-mini");
      expect(events.find(e => e.type === "native_session_id")).not.toEqual(oldNative);
      expect(events.filter(e => e.type === "text").map(e => e.content).join("")).toContain("LIFECYCLE731");
    } finally {
      for (const child of processes) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "close"); }
      rmSync(cwd, { recursive: true, force: true });
      expect(existsSync(settings) ? readFileSync(settings) : null).toEqual(before);
    }
  }, 180_000);
});
