"use client";

import { useEffect, useState, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { ImageOff, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useFileNavigation, type FileReadScope } from "./file-navigation-context";

type AnchorProps = ComponentProps<"a"> & { node?: { properties?: Record<string, unknown> } };

const REF_CLASS =
  "text-primary underline decoration-dotted underline-offset-2 cursor-pointer hover:decoration-solid";
const LINK_CLASS =
  "wrap-anywhere font-medium text-primary underline decoration-primary/60 underline-offset-2 transition-colors hover:text-primary/80 hover:decoration-primary";
// A file the repo index doesn't know — a temp artifact, a gitignored build
// output. Same affordance, muted so it reads as "outside the tree".
const EXTERNAL_CLASS =
  "text-primary/80 underline decoration-dotted underline-offset-2 cursor-pointer hover:decoration-solid";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"]);
// Hover previews stop here; the Files tab (click) applies its own cap.
const HOVER_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

function extensionOf(rawPath: string): string {
  const base = rawPath.slice(rawPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

// What to make of a path-shaped reference the repo index could NOT resolve.
// The index only lists tracked/untracked-not-ignored files at session open, so
// anything the agent produced during the session — `/tmp/screenshot.png`, an
// ignored `out/report.png` — is unresolvable by construction. Those are the
// refs worth linking: click opens them in the Files tab (the backend reads
// absolute paths verbatim on the agent's machine), and images get a hover
// preview. To keep noise down, a relative path needs an image extension and an
// absolute one needs some extension; everything else stays plain text — an
// API route like `/api/projects` is not a file, and nothing verifies existence
// until the user hovers or clicks, so streaming never fans out requests.
export function classifyExternalRef(rawPath: string): "image" | "file" | null {
  const ext = extensionOf(rawPath);
  if (!ext) return null;
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  const absolute = rawPath.startsWith("/") || rawPath.startsWith("~/");
  return absolute ? "file" : null;
}

// Resolution happens HERE, at render time, against the index from context —
// not in the rehype plugin. A late-arriving index therefore upgrades refs from
// plain text to links via an in-place re-render; the Streamdown tree is never
// remounted (see rehype-file-refs.ts for the jump this avoids). Until the
// index resolves a ref, it renders as its plain children — no element, no
// link affordance.
export function FileRefLink({ node, children, href, className, ...rest }: AnchorProps) {
  const { openFile, index, scope } = useFileNavigation();
  const raw = node?.properties?.dataFileRaw as string | undefined;

  // Not one of our file refs — render a normal link.
  if (!raw) {
    const isHash = typeof href === "string" && href.startsWith("#");
    if (isHash) {
      return (
        <a href={href} className={cn(LINK_CLASS, className)} {...rest}>
          {children}
        </a>
      );
    }
    return (
      <a
        href={href}
        className={cn(LINK_CLASS, className)}
        target="_blank"
        rel="noreferrer noopener"
        {...rest}
      >
        {children}
      </a>
    );
  }

  const lineStr = node?.properties?.dataFileLine as string | undefined;
  const line = lineStr != null ? Number(lineStr) : null;
  const paths = index ? index.resolve(raw) : [];

  if (paths.length === 0) {
    // Only once the index has spoken: while it is still loading we cannot tell
    // a repo file from an outside one, and a link that later changes target
    // would be the same flicker the deferred resolution exists to avoid.
    const kind = index && scope ? classifyExternalRef(raw) : null;
    if (!kind || !scope) return <>{children}</>;
    const open = (e: MouseEvent) => {
      e.preventDefault();
      openFile(raw, line);
    };
    if (kind === "file") {
      return (
        <a href="#" className={EXTERNAL_CLASS} onClick={open}>
          {children}
        </a>
      );
    }
    return (
      <HoverCard openDelay={300} closeDelay={100}>
        <HoverCardTrigger asChild>
          <a href="#" className={EXTERNAL_CLASS} onClick={open}>
            {children}
          </a>
        </HoverCardTrigger>
        <HoverCardContent side="top" align="start" className="w-auto max-w-sm p-1.5">
          <ExternalImagePreview scope={scope} filePath={raw} />
        </HoverCardContent>
      </HoverCard>
    );
  }

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

  return (
    <FileRefChoice paths={paths} line={line}>
      {children}
    </FileRefChoice>
  );
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

// Mounted only while the hover card is open (Radix unmounts closed content), so
// the fetch happens on hover, never during streaming render. Bytes come via
// authFetch → object URL, same as the Files tab's ImagePreview; a plain
// <img src=url> could not carry the Authorization header under --auth.
function ExternalImagePreview({ scope, filePath }: { scope: FileReadScope; filePath: string }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    api
      .getFileBlob(scope.projectId, filePath, scope.branch, scope.target)
      .then((blob) => {
        if (cancelled) return;
        if (blob.size > HOVER_PREVIEW_MAX_BYTES) {
          setError("Too large to preview — click to open");
          return;
        }
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "";
        setError(/not found/i.test(msg) ? "File not found" : "Couldn't load image");
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [scope.projectId, scope.branch, scope.target, filePath]);

  if (error) {
    return (
      <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
        <ImageOff className="h-3.5 w-3.5" />
        {error}
      </div>
    );
  }
  if (!objectUrl) {
    return (
      <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading preview…
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={objectUrl}
      alt={filePath}
      className="block max-h-64 max-w-[22rem] rounded object-contain"
    />
  );
}
