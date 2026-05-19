"use client";

import { Badge } from "@/components/ui/badge";
import { FileText } from "lucide-react";

interface FileChange {
  path: string;
  diff?: string;
  kind: string;
}

function kindBadgeColor(kind: string): string {
  switch (kind) {
    case "added": case "add": return "bg-green-500/10 text-green-600";
    case "deleted": case "delete": return "bg-red-500/10 text-red-600";
    default: return "bg-blue-500/10 text-blue-600";
  }
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "added": case "add": return "added";
    case "deleted": case "delete": return "deleted";
    default: return "modified";
  }
}

export function FileChangeToolUseUI({ input }: { input: unknown }) {
  const parsed = typeof input === "string" ? tryParse(input) : input;
  const changes: FileChange[] = (parsed as { changes?: FileChange[] })?.changes ?? [];

  if (changes.length === 0) {
    return <p className="text-xs text-muted-foreground">No file changes</p>;
  }

  return (
    <div className="space-y-2 mt-1">
      {changes.map((change, i) => (
        <div key={i}>
          <div className="flex items-center gap-2">
            <FileText className="h-3 w-3 text-muted-foreground flex-shrink-0" />
            <code className="text-xs break-all">{change.path}</code>
            <Badge variant="secondary" className={`text-[10px] ${kindBadgeColor(change.kind)}`}>
              {kindLabel(change.kind)}
            </Badge>
          </div>
          {change.diff && (
            <details className="mt-1">
              <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                View diff
              </summary>
              <pre
                className="mt-1 p-2 rounded overflow-x-auto max-h-48 overflow-y-auto max-w-full whitespace-pre-wrap break-all"
                style={{ fontSize: "var(--conv-font-size, 12px)" }}
              >
                {change.diff.split("\n").map((line, li) => {
                  let className = "";
                  if (line.startsWith("+")) className = "bg-green-500/10 text-green-700 dark:text-green-400";
                  else if (line.startsWith("-")) className = "bg-red-500/10 text-red-700 dark:text-red-400";
                  return <div key={li} className={className}>{line}</div>;
                })}
              </pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

export function FileChangeToolResultUI({ output }: { output: string }) {
  const lower = output.toLowerCase();
  let color = "text-muted-foreground";
  if (lower.includes("completed") || lower.includes("success")) color = "text-green-600 dark:text-green-400";
  else if (lower.includes("failed") || lower.includes("error")) color = "text-red-600 dark:text-red-400";
  else if (lower.includes("declined") || lower.includes("denied")) color = "text-amber-600 dark:text-amber-400";

  return (
    <p className={`text-xs ${color}`}>{output}</p>
  );
}

function tryParse(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
