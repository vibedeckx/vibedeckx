import type { PipedRunSpec } from "../shared/piped-run.js";
import { buildClaudeStreamExecutorSpawn } from "./cli.js";
import { serializeUserInput } from "./codec.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";

/**
 * A single-turn Claude Code executor run in stream-json mode. The prompt goes
 * in over stdin; stdout events are rendered into terminal text as they arrive
 * and the `result` event's text becomes the run's report. stderr is progress /
 * debug noise and is not shown.
 */
export function buildClaudeStreamExecutorRun(binary: string | null, prompt: string): PipedRunSpec {
  const { command, args } = buildClaudeStreamExecutorSpawn(binary);
  let buffer = "";
  const prevTextByIndex = new Map<number, string>();
  const seenToolUseIds = new Set<string>();
  let finalResult: string | undefined;

  const renderLine = (line: string): string => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      return line + "\n";
    }

    if (parsed.type === "assistant") {
      const message = parsed.message as Record<string, unknown> | undefined;
      const content = message?.content as Array<Record<string, unknown>> | undefined;
      if (!content || !Array.isArray(content)) return "";

      let output = "";
      for (let i = 0; i < content.length; i++) {
        const block = content[i];
        if (block.type === "text") {
          const fullText = (block.text as string) || "";
          const prev = prevTextByIndex.get(i) || "";
          if (fullText.length > prev.length && fullText.startsWith(prev)) {
            output += fullText.slice(prev.length);
          } else if (fullText !== prev) {
            output += fullText;
          }
          prevTextByIndex.set(i, fullText);
        } else if (block.type === "tool_use" && block.id && !seenToolUseIds.has(block.id as string)) {
          seenToolUseIds.add(block.id as string);
          output += `\n${CYAN}${BOLD}> ${block.name}${RESET}\n`;
          const input = block.input as Record<string, unknown> | undefined;
          if (input && Object.keys(input).length > 0) {
            const inputStr = JSON.stringify(input, null, 2);
            const truncated = inputStr.length > 500 ? inputStr.slice(0, 500) + "..." : inputStr;
            output += `${DIM}${truncated}${RESET}\n`;
          }
        }
      }
      return output;
    }

    if (parsed.type === "user") {
      const message = parsed.message as Record<string, unknown> | undefined;
      const content = message?.content as Array<Record<string, unknown>> | undefined;
      if (!content || !Array.isArray(content)) return "";
      let output = "";
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const resultStr = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        if (resultStr && resultStr.length > 0) {
          const truncated = resultStr.length > 2000 ? resultStr.slice(0, 2000) + "..." : resultStr;
          output += `${DIM}${truncated}${RESET}\n`;
        }
      }
      return output;
    }

    if (parsed.type === "system") {
      const msg = parsed.message || parsed.subtype;
      return msg ? `${DIM}${msg}${RESET}\n` : "";
    }

    if (parsed.type === "result") {
      if (parsed.subtype === "error") {
        return `\n${RED}Error: ${parsed.error || "Unknown error"}${RESET}\n`;
      }
      if (typeof parsed.result === "string" && parsed.result.trim()) {
        finalResult = parsed.result;
      }
      const parts: string[] = [];
      if (parsed.duration_ms) parts.push(`${((parsed.duration_ms as number) / 1000).toFixed(1)}s`);
      if (parsed.cost_usd) parts.push(`$${(parsed.cost_usd as number).toFixed(4)}`);
      const info = parts.length > 0 ? ` (${parts.join(", ")})` : "";
      return `\n${GREEN}Done${info}${RESET}\n`;
    }

    return "";
  };

  return {
    command,
    args,
    shell: false,
    stdin: serializeUserInput(prompt),
    decoder: {
      stdout: (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        let output = "";
        for (const line of lines) {
          if (line.trim()) output += renderLine(line);
        }
        return output || undefined;
      },
      stderr: () => undefined,
      finish: ({ code }) => ({ exitCode: code ?? 0, finalResult }),
    },
  };
}
