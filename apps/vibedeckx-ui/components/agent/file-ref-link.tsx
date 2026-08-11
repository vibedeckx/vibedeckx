"use client";

import type { ComponentProps, ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useFileNavigation } from "./file-navigation-context";

type AnchorProps = ComponentProps<"a"> & { node?: { properties?: Record<string, unknown> } };

const REF_CLASS =
  "text-primary underline decoration-dotted underline-offset-2 cursor-pointer hover:decoration-solid";

// Resolution happens HERE, at render time, against the index from context —
// not in the rehype plugin. A late-arriving index therefore upgrades refs from
// plain text to links via an in-place re-render; the Streamdown tree is never
// remounted (see rehype-file-refs.ts for the jump this avoids). Until the
// index resolves a ref, it renders as its plain children — no element, no
// link affordance.
export function FileRefLink({ node, children, href, ...rest }: AnchorProps) {
  const { openFile, index } = useFileNavigation();
  const raw = node?.properties?.dataFileRaw as string | undefined;

  // Not one of our file refs — render a normal link.
  if (!raw) {
    const isHash = typeof href === "string" && href.startsWith("#");
    if (isHash) {
      return (
        <a href={href} {...rest}>
          {children}
        </a>
      );
    }
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" {...rest}>
        {children}
      </a>
    );
  }

  const lineStr = node?.properties?.dataFileLine as string | undefined;
  const line = lineStr != null ? Number(lineStr) : null;
  const paths = index ? index.resolve(raw) : [];

  if (paths.length === 0) return <>{children}</>;

  if (paths.length === 1) {
    return (
      <a
        href="#"
        className={REF_CLASS}
        onClick={(e) => {
          e.preventDefault();
          openFile(paths[0], line);
        }}
      >
        {children}
      </a>
    );
  }

  return <FileRefChoice paths={paths} line={line} children={children} />;
}

function FileRefChoice({
  paths,
  line,
  children,
}: {
  paths: string[];
  line: number | null;
  children: ReactNode;
}) {
  const { openFile } = useFileNavigation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <a href="#" className={REF_CLASS} onClick={(e) => e.preventDefault()}>
          {children}
        </a>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-md">
        <DropdownMenuLabel>{paths.length} matching files</DropdownMenuLabel>
        {paths.map((p) => (
          <DropdownMenuItem
            key={p}
            className="font-mono text-xs"
            onSelect={() => openFile(p, line)}
          >
            {p}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
