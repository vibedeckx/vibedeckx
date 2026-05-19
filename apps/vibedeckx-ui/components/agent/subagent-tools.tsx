"use client";

import { Badge } from "@/components/ui/badge";

interface SubagentInput {
  description: string;
  subagent_type: string;
  prompt: string;
  model?: string;
  max_turns?: number;
  resume?: string;
  run_in_background?: boolean;
}

function parseSubagentInput(input: unknown): SubagentInput | null {
  try {
    const obj = (typeof input === "string" ? JSON.parse(input) : input) as Record<string, unknown>;
    if (
      obj &&
      typeof obj === "object" &&
      typeof obj.description === "string" &&
      typeof obj.subagent_type === "string"
    ) {
      return obj as unknown as SubagentInput;
    }
    return null;
  } catch {
    return null;
  }
}

const agentTypeLabels: Record<string, string> = {
  Explore: "Explore",
  Bash: "Bash",
  Plan: "Plan",
  "general-purpose": "General",
  "code-simplifier": "Simplify",
  "superpowers:code-reviewer": "Review",
  "memory-leak-detector": "Memory",
  "directory-structure-validator": "Structure",
  "tech-docs-finder": "Docs",
  "claude-code-guide": "Guide",
  "statusline-setup": "Status",
};

function getAgentLabel(type: string): string {
  return agentTypeLabels[type] || type;
}

export function SubagentToolUseUI({ input }: { input: unknown }) {
  const parsed = parseSubagentInput(input);
  if (!parsed) {
    return (
      <pre
        className="bg-muted/50 p-2 rounded overflow-x-auto max-w-full whitespace-pre-wrap break-all"
        style={{ fontSize: "var(--conv-font-size, 12px)" }}
      >
        {typeof input === "string" ? input : JSON.stringify(input, null, 2)}
      </pre>
    );
  }

  const { description, subagent_type, prompt, model, max_turns, resume, run_in_background } = parsed;

  const badges: { label: string }[] = [];
  badges.push({ label: getAgentLabel(subagent_type) });
  if (model) badges.push({ label: model });
  if (max_turns != null) badges.push({ label: `${max_turns} turns` });
  if (run_in_background) badges.push({ label: "background" });
  if (resume) badges.push({ label: "resume" });

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm">{description}</span>
        {badges.map((b, i) => (
          <Badge key={i} variant="outline" className="text-xs shrink-0">
            {b.label}
          </Badge>
        ))}
      </div>
      {prompt && (
        <details>
          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
            Prompt ({prompt.length > 1000 ? `${Math.round(prompt.length / 1000)}k chars` : `${prompt.length} chars`})
          </summary>
          <pre
            className="mt-1 bg-muted/50 p-2 rounded overflow-x-auto max-h-48 overflow-y-auto max-w-full whitespace-pre-wrap break-all"
            style={{ fontSize: "var(--conv-font-size, 12px)" }}
          >
            {prompt.length > 1000 ? prompt.substring(0, 1000) + "..." : prompt}
          </pre>
        </details>
      )}
    </div>
  );
}

export function SubagentToolResultUI({ output }: { output: string }) {
  if (!output || output.trim() === "") {
    return (
      <p className="text-xs text-muted-foreground italic">No output</p>
    );
  }

  const lineCount = output.split("\n").length;

  return (
    <details>
      <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
        Agent result ({lineCount} {lineCount === 1 ? "line" : "lines"})
      </summary>
      <pre
        className="mt-1 bg-muted/50 p-2 rounded overflow-x-auto max-h-48 overflow-y-auto max-w-full whitespace-pre-wrap break-all"
        style={{ fontSize: "var(--conv-font-size, 12px)" }}
      >
        {output.length > 1000 ? output.substring(0, 1000) + "..." : output}
      </pre>
    </details>
  );
}
