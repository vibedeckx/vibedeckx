"use client";

import { FileText } from "lucide-react";

interface VPasteChipProps {
  path: string;
  size: number;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 10) return `${kb.toFixed(1)} KB`;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function VPasteChip({ path, size }: VPasteChipProps) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/60 px-1.5 py-0.5 text-xs font-mono align-baseline"
      title={path}
    >
      <FileText className="w-3 h-3 text-muted-foreground shrink-0" />
      <span className="truncate max-w-[18ch]">{basename(path)}</span>
      <span className="text-muted-foreground">{formatSize(size)}</span>
    </span>
  );
}

export const VPASTE_MARKER_RE = /<vpaste path="([^"]+)" size="(\d+)" \/>/g;

/**
 * Split a string into an array of literal-text segments and chip descriptors.
 * Consumers render each segment in order.
 */
export type VPasteSegment =
  | { kind: "text"; text: string }
  | { kind: "chip"; path: string; size: number };

export function splitVPasteMarkers(text: string): VPasteSegment[] {
  const segments: VPasteSegment[] = [];
  let lastIndex = 0;
  const re = new RegExp(VPASTE_MARKER_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: "text", text: text.slice(lastIndex, match.index) });
    }
    segments.push({ kind: "chip", path: match[1], size: Number(match[2]) });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: "text", text: text.slice(lastIndex) });
  }
  return segments;
}
