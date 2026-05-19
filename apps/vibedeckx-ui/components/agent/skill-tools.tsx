"use client";

interface SkillInput {
  skill: string;
  args?: string;
}

function parseSkillInput(input: unknown): SkillInput | null {
  try {
    const obj = (typeof input === "string" ? JSON.parse(input) : input) as Record<string, unknown>;
    if (obj && typeof obj === "object" && typeof obj.skill === "string") {
      return obj as unknown as SkillInput;
    }
    return null;
  } catch {
    return null;
  }
}

export function SkillToolUseUI({ input }: { input: unknown }) {
  const parsed = parseSkillInput(input);
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
    <div className="space-y-1">
      <p className="text-xs font-mono text-pink-500">{parsed.skill}</p>
      {parsed.args && (
        <p className="text-xs text-muted-foreground truncate">
          args: {parsed.args}
        </p>
      )}
    </div>
  );
}

export function SkillToolResultUI({ output }: { output: string }) {
  if (!output || output.trim() === "") {
    return (
      <p className="text-xs text-muted-foreground italic">No output</p>
    );
  }

  const lineCount = output.split("\n").length;

  return (
    <details>
      <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
        Loaded ({lineCount} {lineCount === 1 ? "line" : "lines"})
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
