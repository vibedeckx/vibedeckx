"use client";

import { Badge } from "@/components/ui/badge";

interface TaskOutputInput {
  task_id: string;
  block?: boolean;
  timeout?: number;
}

function parseInput(input: unknown): TaskOutputInput | null {
  try {
    const obj = (typeof input === "string" ? JSON.parse(input) : input) as Record<string, unknown>;
    if (obj && typeof obj === "object" && typeof obj.task_id === "string") {
      return obj as unknown as TaskOutputInput;
    }
    return null;
  } catch {
    return null;
  }
}

export function TaskOutputToolUseUI({ input }: { input: unknown }) {
  const parsed = parseInput(input);
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

  const { task_id, block, timeout } = parsed;

  const badges: { label: string }[] = [];
  badges.push({ label: block === false ? "non-blocking" : "blocking" });
  if (timeout != null) badges.push({ label: `${Math.round(timeout / 1000)}s` });

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <code className="text-sm bg-muted/50 px-1.5 py-0.5 rounded">{task_id}</code>
      {badges.map((b, i) => (
        <Badge key={i} variant="outline" className="text-xs shrink-0">
          {b.label}
        </Badge>
      ))}
    </div>
  );
}

export function TaskOutputToolResultUI({ output }: { output: string }) {
  if (!output || output.trim() === "") {
    return (
      <p className="text-xs text-muted-foreground italic">No output</p>
    );
  }

  const lineCount = output.split("\n").length;

  return (
    <details>
      <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
        Task output ({lineCount} {lineCount === 1 ? "line" : "lines"})
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
