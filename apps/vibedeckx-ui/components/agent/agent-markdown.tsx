"use client";

import { memo } from "react";
import type React from "react";
import { Streamdown, defaultRehypePlugins } from "streamdown";
import { rehypeFileRefs } from "@/lib/file-ref/rehype-file-refs";
import { FileRefLink } from "./file-ref-link";
import { useFileNavigation } from "./file-navigation-context";

// Assistant markdown renderer. Mirrors MessageResponse's wrapper class, but
// injects the file-ref rehype plugin (appended AFTER streamdown's defaults so
// it runs post-sanitize) and overrides the <a> renderer. `index` comes from
// context, so this re-renders when the index loads even though memo only
// compares `children`.
export const AgentMarkdown = memo(function AgentMarkdown({ children }: { children: string }) {
  const { index } = useFileNavigation();
  const rehypePlugins = [
    ...Object.values(defaultRehypePlugins),
    [rehypeFileRefs, { index }],
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
