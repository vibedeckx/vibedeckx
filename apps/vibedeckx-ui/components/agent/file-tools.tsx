"use client";

import { Badge } from "@/components/ui/badge";

interface ReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

function parseReadInput(input: unknown): ReadInput | null {
  try {
    const obj = (typeof input === "string" ? JSON.parse(input) : input) as Record<string, unknown>;
    if (obj && typeof obj === "object" && typeof obj.file_path === "string") {
      return obj as unknown as ReadInput;
    }
    return null;
  } catch {
    return null;
  }
}

export function ReadToolUseUI({ input }: { input: unknown }) {
  const parsed = parseReadInput(input);
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

  const { file_path, offset, limit } = parsed;
  const parts = file_path.split("/");
  const basename = parts.pop() || file_path;
  const directory = parts.join("/");

  const hasRange = offset != null || limit != null;
  let rangeLabel = "";
  if (hasRange) {
    const start = (offset ?? 1);
    if (limit != null) {
      rangeLabel = `Lines ${start}\u2013${start + limit - 1}`;
    } else {
      rangeLabel = `From line ${start}`;
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="min-w-0">
        <span className="text-sm font-medium break-all">{basename}</span>
        {directory && (
          <p className="text-xs text-muted-foreground truncate" title={file_path}>
            {directory}
          </p>
        )}
      </div>
      {hasRange && (
        <Badge variant="outline" className="text-xs shrink-0">
          {rangeLabel}
        </Badge>
      )}
    </div>
  );
}

export function ReadToolResultUI({ output }: { output: string }) {
  const lineCount = output.split("\n").length;

  return (
    <details>
      <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
        File contents ({lineCount} {lineCount === 1 ? "line" : "lines"})
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

// --- Write tool ---

interface WriteInput {
  file_path: string;
  content: string;
}

function parseWriteInput(input: unknown): WriteInput | null {
  try {
    const obj = (typeof input === "string" ? JSON.parse(input) : input) as Record<string, unknown>;
    if (obj && typeof obj === "object" && typeof obj.file_path === "string") {
      return obj as unknown as WriteInput;
    }
    return null;
  } catch {
    return null;
  }
}

export function WriteToolUseUI({ input }: { input: unknown }) {
  const parsed = parseWriteInput(input);
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

  const { file_path, content } = parsed;
  const parts = file_path.split("/");
  const basename = parts.pop() || file_path;
  const directory = parts.join("/");
  const lineCount = content.split("\n").length;

  return (
    <div className="space-y-1">
      <div className="min-w-0">
        <span className="text-sm font-medium break-all">{basename}</span>
        {directory && (
          <p className="text-xs text-muted-foreground truncate" title={file_path}>
            {directory}
          </p>
        )}
      </div>
      <details>
        <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
          Content ({lineCount} {lineCount === 1 ? "line" : "lines"})
        </summary>
        <pre
          className="mt-1 bg-muted/50 p-2 rounded overflow-x-auto max-h-48 overflow-y-auto max-w-full whitespace-pre-wrap break-all"
          style={{ fontSize: "var(--conv-font-size, 12px)" }}
        >
          {content.length > 1000 ? content.substring(0, 1000) + "..." : content}
        </pre>
      </details>
    </div>
  );
}

export function WriteToolResultUI({ output }: { output: string }) {
  if (!output || output.trim() === "") {
    return (
      <p className="text-xs text-muted-foreground italic">File written</p>
    );
  }

  return (
    <details>
      <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
        Result
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
