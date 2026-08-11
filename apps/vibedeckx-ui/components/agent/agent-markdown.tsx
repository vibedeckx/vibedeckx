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

export const AgentMarkdown = memo(function AgentMarkdown({ children }: { children: string }) {
  return (
    <Streamdown
      className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      rehypePlugins={REHYPE_PLUGINS}
      components={COMPONENTS}
    >
      {children}
    </Streamdown>
  );
});
