"use client";

import { createContext, useContext, type ComponentProps } from "react";
import type React from "react";
import { defaultRehypePlugins, type Streamdown } from "streamdown";
import { rehypeFileLinks } from "@/lib/file-ref/rehype-file-links";
import { cn } from "@/lib/utils";

/** Opens a repo-relative file of the task's workspace in the Files tab. */
export type OpenTaskFile = (path: string, line: number | null) => void;

const TaskFileOpenContext = createContext<OpenTaskFile | null>(null);
export const TaskFileOpenProvider = TaskFileOpenContext.Provider;

// Same chain as AgentMarkdown, with the links-only plugin: after sanitize so
// the injected data-* survive, before harden so it never sees relative hrefs.
const { harden, ...beforeHarden } = defaultRehypePlugins as Record<string, unknown>;
export const TASK_REHYPE_PLUGINS = [
  ...Object.values(beforeHarden),
  rehypeFileLinks,
  ...(harden ? [harden] : []),
] as unknown as React.ComponentProps<typeof Streamdown>["rehypePlugins"];

type AnchorProps = ComponentProps<"a"> & { node?: { properties?: Record<string, unknown> } };

const LINK_CLASS =
  "wrap-anywhere font-medium text-primary underline decoration-primary/60 underline-offset-2 transition-colors hover:text-primary/80 hover:decoration-primary";

/**
 * The `a` renderer for Task descriptions. A file link (from rehypeFileLinks)
 * opens without checking the file exists — a missing one shows in the Files
 * tab's preview. Anything else renders as an ordinary link.
 */
export function TaskFileLink({ node, children, href, className, ...rest }: AnchorProps) {
  const openFile = useContext(TaskFileOpenContext);
  const raw = node?.properties?.dataFileRaw as string | undefined;

  if (!raw) {
    const isHash = typeof href === "string" && href.startsWith("#");
    return (
      <a
        href={href}
        className={cn(LINK_CLASS, className)}
        {...(isHash ? {} : { target: "_blank", rel: "noreferrer noopener" })}
        {...rest}
      >
        {children}
      </a>
    );
  }

  const lineStr = node?.properties?.dataFileLine as string | undefined;
  const line = lineStr != null ? Number(lineStr) : null;
  if (!openFile) return <>{children}</>;
  return (
    <a
      href="#file-ref"
      className={cn(LINK_CLASS, "cursor-pointer")}
      title={line != null ? `${raw}:${line}` : raw}
      onClick={(e) => {
        // `#file-ref` must not land in the address bar.
        e.preventDefault();
        openFile(raw, line);
      }}
    >
      {children}
    </a>
  );
}

export const TASK_MARKDOWN_COMPONENTS = { a: TaskFileLink };
