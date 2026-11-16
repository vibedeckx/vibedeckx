import { qualifiedMcpToolName } from "../mcp/tool-names.js";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Keep the raw fields for fallback rendering; adapt only the existing card contract. */
export function normalizeFxTool(name: string, input: unknown, meta?: unknown): { name: string; input: unknown } {
  const mcp = object(object(object(meta).fx).toolCall).mcp;
  const { server, tool } = object(mcp);
  if (typeof server === "string" && server.trim() && typeof tool === "string" && tool) {
    return { name: qualifiedMcpToolName(tool, server), input };
  }
  for (const server of ["vibedeckx", "cross-remote"]) {
    const prefix = `mcp_${server}_`;
    if (name.startsWith(prefix)) return { name: qualifiedMcpToolName(name.slice(prefix.length), server), input };
  }
  const names: Record<string, string> = {
    read_file: "Read", edit_file: "Edit", write_file: "Write", shell: "Bash",
    glob_files: "Glob", grep_files: "Grep", web_search: "WebSearch", web_fetch: "WebFetch",
    subagent: "Agent", ask_user_question: "AskUserQuestion",
  };
  if (!Object.hasOwn(names, name)) return { name, input };
  const raw = object(input);
  let adapted = input;
  if (["read_file", "edit_file", "write_file"].includes(name) && typeof raw.path === "string") {
    // old_string/new_string describe a local edit, never a full-file diff.
    adapted = { ...raw, file_path: raw.path,
      ...(name === "read_file" && typeof raw.start_line === "number" ? { offset: raw.start_line } : {}),
      ...(name === "read_file" && typeof raw.line_count === "number" ? { limit: raw.line_count } : {}),
    };
  } else if (name === "grep_files" && typeof raw.include === "string") {
    adapted = { ...raw, glob: raw.include };
  } else if (name === "web_fetch" && typeof raw.url === "string") {
    adapted = { ...raw, prompt: raw.prompt ?? "" };
  } else if (name === "subagent") {
    adapted = { ...raw, description: raw.agent ?? raw.action ?? "subagent", subagent_type: "general-purpose", prompt: raw.message ?? "" };
  } else if (name === "ask_user_question" && Array.isArray(raw.questions)) {
    adapted = { ...raw, questions: raw.questions.map((q, i) => ({ ...object(q), header: object(q).header ?? `Question ${i + 1}` })) };
  }
  return { name: names[name], input: adapted };
}
