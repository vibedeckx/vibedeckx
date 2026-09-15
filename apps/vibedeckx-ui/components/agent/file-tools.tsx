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

// --- Image tool results ---

export interface ImageBlock {
  mediaType: string;
  data: string;
}

// A Read/ImageView on an image comes back as a JSON content array with
// `{type:"image",source:{type:"base64",media_type,data}}` blocks (the backend
// only forwards image-bearing results — see extractImageToolResults). Returns
// null for ordinary text output so callers fall through to their usual UI.
export function parseImageBlocks(output: string): ImageBlock[] | null {
  if (!output.startsWith("[") || !output.includes('"type":"image"')) return null;
  try {
    const blocks = JSON.parse(output) as unknown;
    if (!Array.isArray(blocks)) return null;
    const images: ImageBlock[] = [];
    for (const b of blocks as Array<Record<string, unknown>>) {
      if (!b || b.type !== "image") continue;
      const source = b.source as { type?: string; media_type?: string; data?: string } | undefined;
      if (source?.type !== "base64" || typeof source.data !== "string") continue;
      images.push({ mediaType: source.media_type ?? "image/png", data: source.data });
    }
    return images.length > 0 ? images : null;
  } catch {
    return null;
  }
}

export function ImageToolResultUI({ images }: { images: ImageBlock[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {images.map((img, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={i}
          src={`data:${img.mediaType};base64,${img.data}`}
          alt="Image viewed by the agent"
          className="max-w-sm max-h-80 rounded-lg border border-border object-contain"
        />
      ))}
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
