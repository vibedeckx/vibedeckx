"use client";

import { memo } from "react";
import type React from "react";
import { Streamdown, defaultRehypePlugins } from "streamdown";
import { rehypeFileRefs } from "@/lib/file-ref/rehype-file-refs";
import { FileRefLink } from "./file-ref-link";

// Assistant markdown renderer. Mirrors MessageResponse's wrapper class, but
// injects the file-ref rehype plugin and overrides the <a> renderer.
//
// Plugin order matters: rehypeFileRefs must run AFTER streamdown's `sanitize`
// (so the file-ref anchors and data-* it injects survive sanitization) but
// BEFORE `harden`. harden rewrites/blocks relative hrefs, so an agent's
// `[text](path:line)` markdown link must be converted into an in-app
// `#file-ref` anchor before harden ever sees it.
//
// The chain is a module constant: rehypeFileRefs no longer takes the file-ref
// index (FileRefLink resolves from context at render time), so nothing here
// varies with the index and no remount `key` is needed. The previous
// key=index.version remount collapsed every message to placeholder height for
// a frame when the index arrived late — the field-captured content jump.
const { harden, ...beforeHarden } = defaultRehypePlugins as Record<string, unknown>;
const REHYPE_PLUGINS = [
  ...Object.values(beforeHarden),
  rehypeFileRefs,
  ...(harden ? [harden] : []),
] as unknown as React.ComponentProps<typeof Streamdown>["rehypePlugins"];

const COMPONENTS = { a: FileRefLink };

// `mode` is the difference between "the markdown is on screen in the first
// painted frame" and "the message paints as an empty 46px stub and fills in
// ~100ms later". Streamdown's default (`streaming`) holds the parsed blocks in
// state and commits them from an effect wrapped in startTransition, so the very
// first paint of every instance renders zero blocks — on a session switch that
// is 28+ messages all collapsing to header height and then growing back, which
// reads as a flash even though no data moved. `static` derives the blocks in a
// useMemo instead, so they are there on the first paint.
//
// Only the message a turn is actively streaming into wants `streaming`, where
// deferring the re-parse of an ever-growing string keeps typing responsive.
export const AgentMarkdown = memo(function AgentMarkdown({
  children,
  streaming = false,
}: {
  children: string;
  streaming?: boolean;
}) {
  return (
    <Streamdown
      className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      mode={streaming ? "streaming" : "static"}
      rehypePlugins={REHYPE_PLUGINS}
      components={COMPONENTS}
    >
      {children}
    </Streamdown>
  );
});
