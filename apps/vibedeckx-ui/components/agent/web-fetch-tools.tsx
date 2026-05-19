"use client";

interface WebFetchInput {
  url: string;
  prompt: string;
}

function parseWebFetchInput(input: unknown): WebFetchInput | null {
  try {
    const obj = (typeof input === "string" ? JSON.parse(input) : input) as Record<string, unknown>;
    if (obj && typeof obj === "object" && typeof obj.url === "string" && typeof obj.prompt === "string") {
      return obj as unknown as WebFetchInput;
    }
    return null;
  } catch {
    return null;
  }
}

function formatUrl(url: string): { display: string; href: string } {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    const display = parsed.hostname + path;
    return { display: display.length > 80 ? display.substring(0, 77) + "..." : display, href: url };
  } catch {
    return { display: url.length > 80 ? url.substring(0, 77) + "..." : url, href: url };
  }
}

export function WebFetchToolUseUI({ input }: { input: unknown }) {
  const parsed = parseWebFetchInput(input);
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

  const { display, href } = formatUrl(parsed.url);
  const promptPreview = parsed.prompt.length > 150
    ? parsed.prompt.substring(0, 147) + "..."
    : parsed.prompt;

  return (
    <div className="space-y-1">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="block text-xs font-mono text-blue-500 hover:underline truncate"
      >
        {display}
      </a>
      <p className="text-xs text-muted-foreground">
        &quot;{promptPreview}&quot;
      </p>
    </div>
  );
}

export function WebFetchToolResultUI({ output }: { output: string }) {
  if (!output || output.trim() === "") {
    return (
      <p className="text-xs text-muted-foreground italic">No content fetched</p>
    );
  }

  const lineCount = output.split("\n").length;

  return (
    <details>
      <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
        Response ({lineCount} {lineCount === 1 ? "line" : "lines"})
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
