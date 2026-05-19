"use client";

import { Badge } from "@/components/ui/badge";

interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

function parseEditInput(input: unknown): EditInput | null {
  try {
    const obj = (typeof input === "string" ? JSON.parse(input) : input) as Record<string, unknown>;
    if (
      obj &&
      typeof obj === "object" &&
      typeof obj.file_path === "string" &&
      typeof obj.old_string === "string" &&
      typeof obj.new_string === "string"
    ) {
      return obj as unknown as EditInput;
    }
    return null;
  } catch {
    return null;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max) + "..." : s;
}

export function EditToolUseUI({ input }: { input: unknown }) {
  const parsed = parseEditInput(input);
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

  const { file_path, old_string, new_string, replace_all } = parsed;
  const parts = file_path.split("/");
  const basename = parts.pop() || file_path;
  const directory = parts.join("/");

  const oldLines = old_string.split("\n").length;
  const newLines = new_string.split("\n").length;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="min-w-0">
          <span className="text-sm font-medium break-all">{basename}</span>
          {directory && (
            <p className="text-xs text-muted-foreground truncate" title={file_path}>
              {directory}
            </p>
          )}
        </div>
        <Badge variant="outline" className="text-xs shrink-0">
          {oldLines === newLines
            ? `${oldLines} ${oldLines === 1 ? "line" : "lines"}`
            : `${oldLines}\u2192${newLines} lines`}
        </Badge>
        {replace_all && (
          <Badge variant="outline" className="text-xs shrink-0">
            replace all
          </Badge>
        )}
      </div>
      <details>
        <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
          Diff
        </summary>
        <div className="mt-1 text-xs rounded overflow-x-auto max-h-48 overflow-y-auto max-w-full">
          <pre
            className="bg-red-500/10 p-1.5 rounded-t whitespace-pre-wrap break-all"
            style={{ fontSize: "var(--conv-font-size, 12px)" }}
          >
            <span className="text-red-500 select-none">- </span>{truncate(old_string, 500)}
          </pre>
          <pre
            className="bg-green-500/10 p-1.5 rounded-b whitespace-pre-wrap break-all"
            style={{ fontSize: "var(--conv-font-size, 12px)" }}
          >
            <span className="text-green-500 select-none">+ </span>{truncate(new_string, 500)}
          </pre>
        </div>
      </details>
    </div>
  );
}

export function EditToolResultUI({ output }: { output: string }) {
  if (!output || output.trim() === "") {
    return (
      <p className="text-xs text-muted-foreground italic">No output</p>
    );
  }

  // Edit results are typically short success messages
  if (output.length <= 200) {
    return (
      <p className="text-xs text-muted-foreground">{output}</p>
    );
  }

  const lineCount = output.split("\n").length;

  return (
    <details>
      <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
        Result ({lineCount} {lineCount === 1 ? "line" : "lines"})
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
