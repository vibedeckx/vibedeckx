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
import { useRemoteServerName } from "@/hooks/use-remote-server-names";
import { remoteServerIdOf } from "@/lib/remote-session-id";

type AnchorProps = ComponentProps<"a"> & { node?: { properties?: Record<string, unknown> } };

const REF_CLASS =
  "text-primary underline decoration-dotted underline-offset-2 cursor-pointer hover:decoration-solid";
const LINK_CLASS =
  "wrap-anywhere font-medium text-primary underline decoration-primary/60 underline-offset-2 transition-colors hover:text-primary/80 hover:decoration-primary";
// A file the repo index doesn't know — a temp artifact outside the checkout.
// Same affordance, muted so it reads as "outside the tree".
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
// Only an absolute (or `~/`) path with an extension is linked: click opens it
// in the Files tab (the backend reads absolute paths verbatim on the agent's
// machine), images get a hover preview. Nothing verifies existence until the
// user hovers or clicks, so streaming never fans out requests.
//
// Relative paths the index does not know stay plain text. The index lists
// tracked and untracked-not-ignored files and is refreshed when an agent on
// the branch finishes a turn (useFileRefIndex), so a file the agent just
// created resolves normally once the turn ends. What that leaves out is a
// gitignored relative artifact (`out/shot.png`) — linking it would mean
// guessing that "relative" means "relative to the checkout", and the guess
// fails silently on hover. The system prompt asks the agent to give such
// artifacts as absolute paths instead. An extension-less `/api/projects` is
// not a file and stays text as well.
export function classifyExternalRef(rawPath: string): "image" | "file" | null {
  const absolute = rawPath.startsWith("/") || rawPath.startsWith("~/");
  if (!absolute) return null;
  const ext = extensionOf(rawPath);
  if (!ext) return null;
  return IMAGE_EXTENSIONS.has(ext) ? "image" : "file";
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
  // Which machine served it, when that is not the one the agent runs on — a
  // cross-remote screenshot lives on the machine the tool call targeted, and
  // saying so is the difference between "an image" and "an image from zk200".
  const [sourceServerId, setSourceServerId] = useState<string | null>(null);
  const foreign = sourceServerId !== null && sourceServerId !== remoteServerIdOf(scope.sessionId);
  const { label } = useRemoteServerName(foreign ? sourceServerId : null);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    api
      .getFileBlob(scope.projectId, filePath, scope.branch, scope.target, scope.sessionId)
      .then(({ blob, serverId }) => {
        if (cancelled) return;
        if (blob.size > HOVER_PREVIEW_MAX_BYTES) {
          setError("Too large to preview — click to open");
          return;
        }
        setSourceServerId(serverId);
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
  }, [scope.projectId, scope.branch, scope.target, scope.sessionId, filePath]);

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
    <div className="flex flex-col gap-1">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={objectUrl}
        alt={filePath}
        className="block max-h-64 max-w-[22rem] rounded object-contain"
      />
      {label && (
        <p className="px-0.5 text-xs text-muted-foreground">
          on <span className="text-foreground">{label}</span>
        </p>
      )}
    </div>
  );
}
