"use client";

import { Badge } from "@/components/ui/badge";

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: string;
  context?: number;
  "-C"?: number;
  "-B"?: number;
  "-A"?: number;
  "-i"?: boolean;
  multiline?: boolean;
  head_limit?: number;
  offset?: number;
}

function parseGrepInput(input: unknown): GrepInput | null {
  try {
    const obj = (typeof input === "string" ? JSON.parse(input) : input) as Record<string, unknown>;
    if (obj && typeof obj === "object" && typeof obj.pattern === "string") {
      return obj as unknown as GrepInput;
    }
    return null;
  } catch {
    return null;
  }
}

export function GrepToolUseUI({ input }: { input: unknown }) {
  const parsed = parseGrepInput(input);
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

  const badges: { label: string }[] = [];

  if (parsed.path) badges.push({ label: parsed.path });
  if (parsed.glob) badges.push({ label: parsed.glob });
  if (parsed.type) badges.push({ label: `.${parsed.type}` });
  if (parsed.output_mode && parsed.output_mode !== "files_with_matches")
    badges.push({ label: parsed.output_mode });
  if (parsed.context != null) badges.push({ label: `context: ${parsed.context}` });
  if (parsed["-C"] != null) badges.push({ label: `context: ${parsed["-C"]}` });
  if (parsed["-B"] != null) badges.push({ label: `before: ${parsed["-B"]}` });
  if (parsed["-A"] != null) badges.push({ label: `after: ${parsed["-A"]}` });
  if (parsed["-i"]) badges.push({ label: "case-insensitive" });
  if (parsed.multiline) badges.push({ label: "multiline" });
  if (parsed.head_limit != null) badges.push({ label: `limit: ${parsed.head_limit}` });
  if (parsed.offset != null) badges.push({ label: `offset: ${parsed.offset}` });

  return (
    <div className="space-y-1">
      <div className="flex items-start gap-2">
        <pre
          className="flex-1 min-w-0 bg-muted/50 p-2 rounded overflow-x-auto max-w-full whitespace-pre-wrap break-all"
          style={{ fontSize: "var(--conv-font-size, 12px)" }}
        >
          <span className="text-muted-foreground select-none">/ </span>{parsed.pattern}
        </pre>
      </div>
      {badges.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {badges.map((b, i) => (
            <Badge key={i} variant="outline" className="text-xs">
              {b.label}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

export function GrepToolResultUI({ output }: { output: string }) {
  if (!output || output.trim() === "") {
    return (
      <p className="text-xs text-muted-foreground italic">No matches</p>
    );
  }

  const lineCount = output.split("\n").length;

  return (
    <details>
      <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
        Results ({lineCount} {lineCount === 1 ? "line" : "lines"})
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
