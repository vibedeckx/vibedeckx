"use client";

import { FileText, Paperclip, Server } from "lucide-react";

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

/**
 * The hub's `<vremotes>` block, shown as quiet metadata on the message header.
 * It records what the turn was allowed to reach — context about the message,
 * not part of what the user typed — so it stays out of the body. The block's
 * prose is written for the agent; `names` carries the same list for the UI.
 */
export function RemoteGrantMeta({ names }: { names: string }) {
  return (
    <span
      className="flex min-w-0 items-baseline gap-1 text-xs font-normal text-muted-foreground"
      title={`Remote access: ${names}`}
    >
      <Server className="w-3 h-3 shrink-0 self-center" />
      <span className="truncate">{names}</span>
    </span>
  );
}

/**
 * Pull the `<vremotes>` block out of message text. Returns the text without it
 * (and without the blank lines the hub put in front of it), plus its names.
 */
export function takeRemotesMarker(text: string): { text: string; names: string | null } {
  const found = { names: null as string | null };
  const stripped = text.replace(new RegExp(VREMOTES_MARKER_RE.source, "g"), (_m, names: string) => {
    found.names = names;
    return "";
  });
  return found.names === null ? { text, names: null } : { text: stripped.trimEnd(), names: found.names };
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
/** Hub-injected cross-remote grant context; `names` is the display list. */
export const VREMOTES_MARKER_RE = /<vremotes names="([^"]*)">[\s\S]*?<\/vremotes>/g;
const ANY_MARKER_RE = new RegExp(
  `${VPASTE_MARKER_RE.source}|${VFILE_MARKER_RE.source}|${VREMOTES_MARKER_RE.source}`,
  "g",
);

export function vfileMarker(file: { path: string; name: string; size: number }): string {
  return `<vfile path="${file.path}" name="${file.name}" size="${file.size}" />`;
}

/**
 * Split a string into an array of literal-text segments and chip descriptors.
 * Consumers render each segment in order.
 */
export type VPasteSegment =
  | { kind: "text"; text: string }
  | { kind: "chip"; path: string; size: number; name?: string }
  | { kind: "remotes"; names: string };

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
    } else if (match[3] !== undefined) {
      segments.push({ kind: "chip", path: match[3], name: match[4], size: Number(match[5]) });
    } else {
      segments.push({ kind: "remotes", names: match[6] });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: "text", text: text.slice(lastIndex) });
  }
  return segments;
}
