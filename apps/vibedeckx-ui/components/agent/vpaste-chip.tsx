"use client";

import { FileText, Paperclip } from "lucide-react";

interface VPasteChipProps {
  path: string;
  size: number;
  /** Set for `<vfile/>` (uploaded attachment); absent for `<vpaste/>` (long paste). */
  name?: string;
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

export function VPasteChip({ path, size, name }: VPasteChipProps) {
  const Icon = name === undefined ? FileText : Paperclip;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/60 px-1.5 py-0.5 text-xs font-mono align-baseline"
      title={path}
    >
      <Icon className="w-3 h-3 text-muted-foreground shrink-0" />
      <span className="truncate max-w-[18ch]">{name ?? basename(path)}</span>
      <span className="text-muted-foreground">{formatSize(size)}</span>
    </span>
  );
}

export const VPASTE_MARKER_RE = /<vpaste path="([^"]+)" size="(\d+)" \/>/g;
/** Uploaded non-image attachment: file on the agent's machine, referenced by path. */
export const VFILE_MARKER_RE = /<vfile path="([^"]+)" name="([^"]*)" size="(\d+)" \/>/g;
const ANY_MARKER_RE = new RegExp(`${VPASTE_MARKER_RE.source}|${VFILE_MARKER_RE.source}`, "g");

export function vfileMarker(file: { path: string; name: string; size: number }): string {
  return `<vfile path="${file.path}" name="${file.name}" size="${file.size}" />`;
}

/**
 * Split a string into an array of literal-text segments and chip descriptors.
 * Consumers render each segment in order.
 */
export type VPasteSegment =
  | { kind: "text"; text: string }
  | { kind: "chip"; path: string; size: number; name?: string };

export function splitVPasteMarkers(text: string): VPasteSegment[] {
  const segments: VPasteSegment[] = [];
  let lastIndex = 0;
  const re = new RegExp(ANY_MARKER_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: "text", text: text.slice(lastIndex, match.index) });
    }
    if (match[1] !== undefined) {
      segments.push({ kind: "chip", path: match[1], size: Number(match[2]) });
    } else {
      segments.push({ kind: "chip", path: match[3], name: match[4], size: Number(match[5]) });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: "text", text: text.slice(lastIndex) });
  }
  return segments;
}
