"use client";

import { memo } from "react";
import type React from "react";
import { Streamdown, defaultRehypePlugins } from "streamdown";
import { rehypeFileRefs } from "@/lib/file-ref/rehype-file-refs";
import { FileRefLink } from "./file-ref-link";
import { useFileNavigation } from "./file-navigation-context";

// Assistant markdown renderer. Mirrors MessageResponse's wrapper class, but
// injects the file-ref rehype plugin and overrides the <a> renderer. `index`
// comes from context, so this re-renders when the index loads even though memo
// only compares `children`.
//
// Plugin order matters: rehypeFileRefs must run AFTER streamdown's `sanitize`
// (so the file-ref anchors and data-* it injects survive sanitization) but
// BEFORE `harden`. harden rewrites/blocks relative hrefs, so an agent's
// `[text](path:line)` markdown link must be converted into an in-app
// `#file-ref` anchor before harden ever sees it.
export const AgentMarkdown = memo(function AgentMarkdown({ children }: { children: string }) {
  const { index } = useFileNavigation();
  const { harden, ...beforeHarden } = defaultRehypePlugins as Record<string, unknown>;
  const rehypePlugins = [
    ...Object.values(beforeHarden),
    [rehypeFileRefs, { index }],
    ...(harden ? [harden] : []),
  ] as unknown as React.ComponentProps<typeof Streamdown>["rehypePlugins"];

  return (
    <Streamdown
      className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      rehypePlugins={rehypePlugins}
      components={{ a: FileRefLink }}
    >
      {children}
    </Streamdown>
  );
});
