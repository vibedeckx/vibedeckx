"use client";

import { Badge } from "@/components/ui/badge";

interface WebSearchInput {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

function parseWebSearchInput(input: unknown): WebSearchInput | null {
  try {
    const obj = (typeof input === "string" ? JSON.parse(input) : input) as Record<string, unknown>;
    if (obj && typeof obj === "object" && typeof obj.query === "string") {
      return obj as unknown as WebSearchInput;
    }
    return null;
  } catch {
    return null;
  }
}

export function WebSearchToolUseUI({ input }: { input: unknown }) {
  const parsed = parseWebSearchInput(input);
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

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-mono bg-muted/50 px-2 py-1 rounded break-words">
        {parsed.query}
      </p>
      {parsed.allowed_domains && parsed.allowed_domains.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-xs text-muted-foreground">only:</span>
          {parsed.allowed_domains.map((d) => (
            <Badge key={d} variant="secondary" className="text-[10px] px-1.5 py-0">
              {d}
            </Badge>
          ))}
        </div>
      )}
      {parsed.blocked_domains && parsed.blocked_domains.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-xs text-muted-foreground">exclude:</span>
          {parsed.blocked_domains.map((d) => (
            <Badge key={d} variant="outline" className="text-[10px] px-1.5 py-0">
              {d}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

export function WebSearchToolResultUI({ output }: { output: string }) {
  if (!output || output.trim() === "") {
    return (
      <p className="text-xs text-muted-foreground italic">No search results</p>
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
