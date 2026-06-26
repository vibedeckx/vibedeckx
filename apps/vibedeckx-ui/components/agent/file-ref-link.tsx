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

export function FileRefLink({ node, children, href, ...rest }: AnchorProps) {
  const { openFile } = useFileNavigation();
  const raw = node?.properties?.dataFilePaths as string | undefined;

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

  let paths: string[] = [];
  try {
    paths = JSON.parse(raw) as string[];
  } catch {
    paths = [];
  }
  const lineStr = node?.properties?.dataFileLine as string | undefined;
  const line = lineStr != null ? Number(lineStr) : null;

  if (paths.length <= 1) {
    return (
      <a
        href="#"
        className={REF_CLASS}
        onClick={(e) => {
          e.preventDefault();
          if (paths[0]) openFile(paths[0], line);
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
