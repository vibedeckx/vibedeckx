# Clickable File References in Agent Output — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn file references in agent chat output (markdown links, bare `path:line`, bare `filename`) into links that open the existing Files panel at the referenced file/line — but only when the reference matches a real project file.

**Architecture:** A rehype plugin appended after Streamdown's defaults rewrites text nodes and existing `<a>` tags into `file-ref` anchors, resolved against a file index built from `api.listProjectFiles`. A `components.a` override renders the click (single match → open; multiple → choice menu). A `RightPanel`-level context exposes `openFile(path, line)`, which switches to the Files tab and drives the existing `useFileBrowser.jumpTo`.

**Tech Stack:** Next.js 16 / React 19, TypeScript, `streamdown` (markdown), `unist`/`hast` tree shape (manual walk, no new deps), vitest, shadcn `DropdownMenu` (radix).

## Global Constraints

- Frontend lives in `apps/vibedeckx-ui/`; path alias `@/*` → app root.
- Frontend typecheck: `cd apps/vibedeckx-ui && npx tsc --noEmit`.
- Tests: vitest, config at `apps/vibedeckx-ui/vitest.config.ts` (`include: ["**/*.test.ts"]`, node env, `@` alias). Run a file: `cd apps/vibedeckx-ui && npx vitest run <relative-path>`.
- Test style: `import { describe, it, expect } from "vitest";`.
- No fenced code blocks are ever linkified.
- Only references resolving in the file index become links; 1 match → direct, many → choice menu, 0 → plain text.
- Agent session always shares the Files tab's branch/target — no cross-branch handling.
- Suffix forms: `:18`, `:18:5` (keep 18), `#L18`, `#L18-L25`/`#L18-25` (keep 18). No-suffix → open at top.

## File Structure

New:
- `apps/vibedeckx-ui/lib/file-ref/parse-file-ref.ts` — token scanning + href parsing (pure).
- `apps/vibedeckx-ui/lib/file-ref/parse-file-ref.test.ts`
- `apps/vibedeckx-ui/lib/file-ref/file-ref-index.ts` — index builder + `resolve` (pure).
- `apps/vibedeckx-ui/lib/file-ref/file-ref-index.test.ts`
- `apps/vibedeckx-ui/lib/file-ref/rehype-file-refs.ts` — rehype plugin (pure tree transform).
- `apps/vibedeckx-ui/lib/file-ref/rehype-file-refs.test.ts`
- `apps/vibedeckx-ui/hooks/use-file-ref-index.ts` — load file list, build index.
- `apps/vibedeckx-ui/components/agent/file-navigation-context.tsx` — context (`openFile`, `index`).
- `apps/vibedeckx-ui/components/agent/file-ref-link.tsx` — the `a` override.
- `apps/vibedeckx-ui/components/agent/agent-markdown.tsx` — Streamdown wrapper for assistant messages.

Modify:
- `apps/vibedeckx-ui/components/agent/agent-message.tsx` — `AssistantMessage` uses `AgentMarkdown`.
- `apps/vibedeckx-ui/components/right-panel/right-panel.tsx` — provide context, hold nav request, build index.
- `apps/vibedeckx-ui/components/files/files-view.tsx` — accept `navRequest`, drive `jumpTo`/`navigate`.

---

### Task 1: `parse-file-ref` util

**Files:**
- Create: `apps/vibedeckx-ui/lib/file-ref/parse-file-ref.ts`
- Test: `apps/vibedeckx-ui/lib/file-ref/parse-file-ref.test.ts`

**Interfaces:**
- Produces:
  - `interface ScannedRef { start: number; end: number; rawPath: string; line: number | null; }`
  - `function scanFileRefs(text: string): ScannedRef[]`
  - `function parseFileHref(href: string): { rawPath: string; line: number | null } | null`

- [ ] **Step 1: Write the failing test**

```ts
// apps/vibedeckx-ui/lib/file-ref/parse-file-ref.test.ts
import { describe, it, expect } from "vitest";
import { scanFileRefs, parseFileHref } from "./parse-file-ref";

describe("scanFileRefs", () => {
  it("finds a bare path with a line suffix in prose", () => {
    const text = "最后在 packages/eve/src/execution/compaction.ts:18 里";
    const refs = scanFileRefs(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].rawPath).toBe("packages/eve/src/execution/compaction.ts");
    expect(refs[0].line).toBe(18);
    expect(text.slice(refs[0].start, refs[0].end)).toBe(
      "packages/eve/src/execution/compaction.ts:18",
    );
  });

  it("finds a bare filename with no line", () => {
    const refs = scanFileRefs("see compaction.ts here");
    expect(refs).toHaveLength(1);
    expect(refs[0].rawPath).toBe("compaction.ts");
    expect(refs[0].line).toBeNull();
  });

  it("keeps the line from a col suffix and from #L forms", () => {
    expect(scanFileRefs("a/b.ts:18:5")[0].line).toBe(18);
    expect(scanFileRefs("a/b.ts#L20")[0].line).toBe(20);
    expect(scanFileRefs("a/b.ts#L20-L25")[0].line).toBe(20);
  });

  it("does not match a bare word without an extension or slash", () => {
    expect(scanFileRefs("update the config now")).toHaveLength(0);
  });

  it("does not include trailing sentence punctuation", () => {
    const refs = scanFileRefs("在 todo.ts:56。");
    expect(refs[0].rawPath).toBe("todo.ts");
    expect(refs[0].line).toBe(56);
  });
});

describe("parseFileHref", () => {
  it("parses a relative file href with a line", () => {
    expect(parseFileHref("packages/eve/x/todo.ts:56")).toEqual({
      rawPath: "packages/eve/x/todo.ts",
      line: 56,
    });
  });

  it("rejects http(s), mailto, and pure anchors", () => {
    expect(parseFileHref("https://vibedeckx.dev/x")).toBeNull();
    expect(parseFileHref("mailto:a@b.com")).toBeNull();
    expect(parseFileHref("#section")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/vibedeckx-ui && npx vitest run lib/file-ref/parse-file-ref.test.ts`
Expected: FAIL — cannot find module `./parse-file-ref`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/vibedeckx-ui/lib/file-ref/parse-file-ref.ts

export interface ScannedRef {
  start: number;
  end: number;
  rawPath: string;
  line: number | null;
}

// A "pathish" core must contain at least one separator (`.` or `/`) so bare
// words never match. Optional suffix: `:line(:col)?` or `#Lstart(-L?end)?`.
const FILE_REF =
  /(?<![\w./-])([\w-]+(?:[./][\w-]+)+)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)?/g;

function hasExtensionOrSlash(rawPath: string): boolean {
  return rawPath.includes("/") || /\.[A-Za-z0-9]+$/.test(rawPath);
}

export function scanFileRefs(text: string): ScannedRef[] {
  const out: ScannedRef[] = [];
  FILE_REF.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_REF.exec(text)) !== null) {
    const rawPath = m[1];
    if (!hasExtensionOrSlash(rawPath)) continue;
    const line = m[2] ? Number(m[2]) : m[3] ? Number(m[3]) : null;
    out.push({ start: m.index, end: m.index + m[0].length, rawPath, line });
  }
  return out;
}

export function parseFileHref(
  href: string,
): { rawPath: string; line: number | null } | null {
  const h = href.trim();
  if (!h || /^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("//") || h.startsWith("#")) {
    return null;
  }
  const m = /^(.*?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)?$/.exec(h);
  if (!m || !m[1]) return null;
  const line = m[2] ? Number(m[2]) : m[3] ? Number(m[3]) : null;
  return { rawPath: m[1], line };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/vibedeckx-ui && npx vitest run lib/file-ref/parse-file-ref.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/lib/file-ref/parse-file-ref.ts apps/vibedeckx-ui/lib/file-ref/parse-file-ref.test.ts
git commit -m "feat: file-ref token + href parsing util"
```

---

### Task 2: `file-ref-index` util

**Files:**
- Create: `apps/vibedeckx-ui/lib/file-ref/file-ref-index.ts`
- Test: `apps/vibedeckx-ui/lib/file-ref/file-ref-index.test.ts`

**Interfaces:**
- Produces:
  - `interface FileRefIndex { resolve(rawPath: string): string[]; }`
  - `function buildFileRefIndex(files: string[]): FileRefIndex`
- Resolution: full path with `/` → exact hit, else unique-suffix (paths ending `/rawPath`); bare → all paths with that basename.

- [ ] **Step 1: Write the failing test**

```ts
// apps/vibedeckx-ui/lib/file-ref/file-ref-index.test.ts
import { describe, it, expect } from "vitest";
import { buildFileRefIndex } from "./file-ref-index";

const files = [
  "packages/eve/src/execution/compaction.ts",
  "packages/eve/src/runtime/framework-tools/todo.ts",
  "apps/ui/todo.ts",
];

describe("buildFileRefIndex.resolve", () => {
  const idx = buildFileRefIndex(files);

  it("matches an exact full path", () => {
    expect(idx.resolve("packages/eve/src/execution/compaction.ts")).toEqual([
      "packages/eve/src/execution/compaction.ts",
    ]);
  });

  it("matches a unique path suffix", () => {
    expect(idx.resolve("execution/compaction.ts")).toEqual([
      "packages/eve/src/execution/compaction.ts",
    ]);
  });

  it("matches a bare filename that is unique", () => {
    expect(idx.resolve("compaction.ts")).toEqual([
      "packages/eve/src/execution/compaction.ts",
    ]);
  });

  it("returns all matches for an ambiguous bare filename", () => {
    expect(idx.resolve("todo.ts").sort()).toEqual(
      ["apps/ui/todo.ts", "packages/eve/src/runtime/framework-tools/todo.ts"].sort(),
    );
  });

  it("returns empty for an unknown reference", () => {
    expect(idx.resolve("nope.ts")).toEqual([]);
    expect(idx.resolve("")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/vibedeckx-ui && npx vitest run lib/file-ref/file-ref-index.test.ts`
Expected: FAIL — cannot find module `./file-ref-index`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/vibedeckx-ui/lib/file-ref/file-ref-index.ts

export interface FileRefIndex {
  resolve(rawPath: string): string[];
}

function basenameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

export function buildFileRefIndex(files: string[]): FileRefIndex {
  const fullPaths = new Set(files);
  const byBasename = new Map<string, string[]>();
  for (const f of files) {
    const base = basenameOf(f);
    const arr = byBasename.get(base);
    if (arr) arr.push(f);
    else byBasename.set(base, [f]);
  }

  return {
    resolve(rawPath: string): string[] {
      if (!rawPath) return [];
      if (rawPath.includes("/")) {
        if (fullPaths.has(rawPath)) return [rawPath];
        const base = basenameOf(rawPath);
        return (byBasename.get(base) ?? []).filter(
          (p) => p === rawPath || p.endsWith("/" + rawPath),
        );
      }
      return byBasename.get(rawPath) ?? [];
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/vibedeckx-ui && npx vitest run lib/file-ref/file-ref-index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/lib/file-ref/file-ref-index.ts apps/vibedeckx-ui/lib/file-ref/file-ref-index.test.ts
git commit -m "feat: file-ref index with exact/suffix/basename resolution"
```

---

### Task 3: `rehype-file-refs` plugin

**Files:**
- Create: `apps/vibedeckx-ui/lib/file-ref/rehype-file-refs.ts`
- Test: `apps/vibedeckx-ui/lib/file-ref/rehype-file-refs.test.ts`

**Interfaces:**
- Consumes: `FileRefIndex` (Task 2), `scanFileRefs`/`parseFileHref` (Task 1).
- Produces: `function rehypeFileRefs(opts: { index: FileRefIndex | null }): (tree: HastNode) => void`
- Anchors it emits carry `properties.className = ["file-ref"]`, `properties.href = "#"`, `properties.dataFilePaths = JSON.stringify(string[])`, and (when a line is known) `properties.dataFileLine = String(line)`. Task 5 reads these off the hast `node`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/vibedeckx-ui/lib/file-ref/rehype-file-refs.test.ts
import { describe, it, expect } from "vitest";
import { rehypeFileRefs } from "./rehype-file-refs";
import type { FileRefIndex } from "./file-ref-index";

// Stub index: src/a.ts is unique; a.ts is ambiguous; everything else unknown.
const index: FileRefIndex = {
  resolve: (p) =>
    p === "src/a.ts"
      ? ["src/a.ts"]
      : p === "a.ts"
        ? ["src/a.ts", "lib/a.ts"]
        : [],
};

function el(tagName: string, properties: any, children: any[]) {
  return { type: "element", tagName, properties, children };
}
function txt(value: string) {
  return { type: "text", value };
}

describe("rehypeFileRefs", () => {
  it("splits a resolvable ref out of a text node into a file-ref anchor", () => {
    const tree = el("p", {}, [txt("open src/a.ts:18 now")]);
    rehypeFileRefs({ index })(tree as any);
    const kids = (tree as any).children;
    expect(kids).toHaveLength(3);
    expect(kids[0]).toEqual(txt("open "));
    expect(kids[1].tagName).toBe("a");
    expect(kids[1].properties.className).toEqual(["file-ref"]);
    expect(JSON.parse(kids[1].properties.dataFilePaths)).toEqual(["src/a.ts"]);
    expect(kids[1].properties.dataFileLine).toBe("18");
    expect(kids[2]).toEqual(txt(" now"));
  });

  it("leaves unresolved tokens as plain text", () => {
    const tree = el("p", {}, [txt("open zzz.ts here")]);
    rehypeFileRefs({ index })(tree as any);
    expect((tree as any).children).toEqual([txt("open zzz.ts here")]);
  });

  it("never touches text inside <pre>", () => {
    const tree = el("pre", {}, [el("code", {}, [txt("src/a.ts:1")])]);
    rehypeFileRefs({ index })(tree as any);
    const codeKids = (tree as any).children[0].children;
    expect(codeKids).toEqual([txt("src/a.ts:1")]);
  });

  it("converts a resolving relative <a> into a file-ref, preserving text", () => {
    const tree = el("p", {}, [
      el("a", { href: "src/a.ts:18" }, [txt("compaction")]),
    ]);
    rehypeFileRefs({ index })(tree as any);
    const a = (tree as any).children[0];
    expect(a.tagName).toBe("a");
    expect(JSON.parse(a.properties.dataFilePaths)).toEqual(["src/a.ts"]);
    expect(a.properties.dataFileLine).toBe("18");
    expect(a.children).toEqual([txt("compaction")]);
  });

  it("unwraps a non-resolving relative <a> to plain text", () => {
    const tree = el("p", {}, [el("a", { href: "gone.ts:9" }, [txt("gone")])]);
    rehypeFileRefs({ index })(tree as any);
    expect((tree as any).children).toEqual([txt("gone")]);
  });

  it("leaves http links untouched", () => {
    const tree = el("p", {}, [
      el("a", { href: "https://x.dev" }, [txt("x")]),
    ]);
    rehypeFileRefs({ index })(tree as any);
    const a = (tree as any).children[0];
    expect(a.properties.href).toBe("https://x.dev");
    expect(a.properties.dataFilePaths).toBeUndefined();
  });

  it("emits an anchor with all matches for an ambiguous bare filename", () => {
    const tree = el("p", {}, [txt("see a.ts")]);
    rehypeFileRefs({ index })(tree as any);
    const a = (tree as any).children[1];
    expect(JSON.parse(a.properties.dataFilePaths)).toEqual(["src/a.ts", "lib/a.ts"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/vibedeckx-ui && npx vitest run lib/file-ref/rehype-file-refs.test.ts`
Expected: FAIL — cannot find module `./rehype-file-refs`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/vibedeckx-ui/lib/file-ref/rehype-file-refs.ts
import type { FileRefIndex } from "./file-ref-index";
import { scanFileRefs, parseFileHref } from "./parse-file-ref";

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export function rehypeFileRefs(opts: { index: FileRefIndex | null }) {
  const resolve = (p: string): string[] => (opts.index ? opts.index.resolve(p) : []);

  function makeAnchor(
    paths: string[],
    line: number | null,
    children: HastNode[],
  ): HastNode {
    return {
      type: "element",
      tagName: "a",
      properties: {
        className: ["file-ref"],
        href: "#",
        dataFilePaths: JSON.stringify(paths),
        ...(line != null ? { dataFileLine: String(line) } : {}),
      },
      children,
    };
  }

  function expandText(value: string): HastNode[] {
    const refs = scanFileRefs(value);
    if (refs.length === 0) return [{ type: "text", value }];
    const out: HastNode[] = [];
    let pos = 0;
    let linked = false;
    for (const r of refs) {
      const matches = resolve(r.rawPath);
      if (matches.length === 0) continue;
      if (r.start > pos) out.push({ type: "text", value: value.slice(pos, r.start) });
      out.push(
        makeAnchor(matches, r.line, [{ type: "text", value: value.slice(r.start, r.end) }]),
      );
      pos = r.end;
      linked = true;
    }
    if (!linked) return [{ type: "text", value }];
    if (pos < value.length) out.push({ type: "text", value: value.slice(pos) });
    return out;
  }

  function transformAnchor(node: HastNode): HastNode[] {
    const href = String(node.properties?.href ?? "");
    const parsed = parseFileHref(href);
    if (!parsed) return [node]; // external / anchor link — leave as-is
    const matches = resolve(parsed.rawPath);
    if (matches.length === 0) return node.children ?? []; // unwrap broken file link
    return [makeAnchor(matches, parsed.line, node.children ?? [])];
  }

  function processChildren(parent: HastNode): void {
    if (!parent.children) return;
    const out: HastNode[] = [];
    for (const child of parent.children) {
      if (child.type === "text") {
        out.push(...expandText(child.value ?? ""));
      } else if (child.type === "element" && child.tagName === "pre") {
        out.push(child); // never descend into fenced code
      } else if (child.type === "element" && child.tagName === "a") {
        out.push(...transformAnchor(child));
      } else {
        processChildren(child);
        out.push(child);
      }
    }
    parent.children = out;
  }

  return (tree: HastNode): void => {
    processChildren(tree);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/vibedeckx-ui && npx vitest run lib/file-ref/rehype-file-refs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/lib/file-ref/rehype-file-refs.ts apps/vibedeckx-ui/lib/file-ref/rehype-file-refs.test.ts
git commit -m "feat: rehype plugin rewriting file refs into anchors"
```

---

### Task 4: File-navigation context + index hook

**Files:**
- Create: `apps/vibedeckx-ui/components/agent/file-navigation-context.tsx`
- Create: `apps/vibedeckx-ui/hooks/use-file-ref-index.ts`

**Interfaces:**
- Consumes: `buildFileRefIndex`/`FileRefIndex` (Task 2), `api.listProjectFiles` (`lib/api.ts:1422`).
- Produces:
  - `interface FileNavigationValue { openFile: (path: string, line?: number | null) => void; index: FileRefIndex | null; }`
  - `function useFileNavigation(): FileNavigationValue` (safe no-op default when no provider)
  - `const FileNavigationProvider` (the context Provider)
  - `function useFileRefIndex(args: { projectId: string | null; branch?: string | null; target?: "local" | "remote" }): FileRefIndex | null`

- [ ] **Step 1: Create the context**

```tsx
// apps/vibedeckx-ui/components/agent/file-navigation-context.tsx
"use client";

import { createContext, useContext } from "react";
import type { FileRefIndex } from "@/lib/file-ref/file-ref-index";

export interface FileNavigationValue {
  openFile: (path: string, line?: number | null) => void;
  index: FileRefIndex | null;
}

const FileNavigationContext = createContext<FileNavigationValue | null>(null);

const NOOP: FileNavigationValue = { openFile: () => {}, index: null };

export function useFileNavigation(): FileNavigationValue {
  return useContext(FileNavigationContext) ?? NOOP;
}

export const FileNavigationProvider = FileNavigationContext.Provider;
```

- [ ] **Step 2: Create the index hook**

```ts
// apps/vibedeckx-ui/hooks/use-file-ref-index.ts
"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { buildFileRefIndex, type FileRefIndex } from "@/lib/file-ref/file-ref-index";

interface Args {
  projectId: string | null;
  branch?: string | null;
  target?: "local" | "remote";
}

// Loads the project's flat file list once per project/branch/target and builds
// a resolution index. Returns null while loading or on error (refs stay plain
// text and upgrade to links when the index arrives).
export function useFileRefIndex({ projectId, branch, target }: Args): FileRefIndex | null {
  const [index, setIndex] = useState<FileRefIndex | null>(null);
  const keyRef = useRef(0);

  useEffect(() => {
    setIndex(null);
    if (!projectId) return;
    const key = ++keyRef.current;
    api
      .listProjectFiles(projectId, branch, target)
      .then((res) => {
        if (key === keyRef.current) setIndex(buildFileRefIndex(res.files));
      })
      .catch(() => {
        /* leave null — graceful degradation */
      });
  }, [projectId, branch, target]);

  return index;
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: PASS (no errors in the two new files).

- [ ] **Step 4: Commit**

```bash
git add apps/vibedeckx-ui/components/agent/file-navigation-context.tsx apps/vibedeckx-ui/hooks/use-file-ref-index.ts
git commit -m "feat: file-navigation context and file-ref index hook"
```

---

### Task 5: `FileRefLink` override + `AgentMarkdown` wrapper

**Files:**
- Create: `apps/vibedeckx-ui/components/agent/file-ref-link.tsx`
- Create: `apps/vibedeckx-ui/components/agent/agent-markdown.tsx`

**Interfaces:**
- Consumes: `useFileNavigation` (Task 4), `rehypeFileRefs` (Task 3), `defaultRehypePlugins` from `streamdown`, `DropdownMenu` (`@/components/ui/dropdown-menu`).
- Produces: `function FileRefLink(props)` (an `a` override) and `const AgentMarkdown` (memoized Streamdown wrapper, default props comparator — re-renders on context change because it consumes `useFileNavigation`).

- [ ] **Step 1: Create `FileRefLink`**

```tsx
// apps/vibedeckx-ui/components/agent/file-ref-link.tsx
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
```

- [ ] **Step 2: Create `AgentMarkdown`**

```tsx
// apps/vibedeckx-ui/components/agent/agent-markdown.tsx
"use client";

import { memo } from "react";
import type { PluggableList } from "unified";
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
  ] as PluggableList;

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
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: PASS. If `unified` is not directly resolvable for the `PluggableList` type, replace the import + cast with `as unknown as React.ComponentProps<typeof Streamdown>["rehypePlugins"]` (no runtime change).

- [ ] **Step 4: Commit**

```bash
git add apps/vibedeckx-ui/components/agent/file-ref-link.tsx apps/vibedeckx-ui/components/agent/agent-markdown.tsx
git commit -m "feat: FileRefLink override and AgentMarkdown wrapper"
```

---

### Task 6: Render assistant messages through `AgentMarkdown`

**Files:**
- Modify: `apps/vibedeckx-ui/components/agent/agent-message.tsx` (import + `AssistantMessage`, ~line 232)

**Interfaces:**
- Consumes: `AgentMarkdown` (Task 5).

- [ ] **Step 1: Add the import**

Add near the other component imports (after the `MessageResponse` import line, `agent-message.tsx:6`):

```tsx
import { AgentMarkdown } from "./agent-markdown";
```

- [ ] **Step 2: Swap the renderer in `AssistantMessage`**

Replace (`agent-message.tsx:232`):

```tsx
          <MessageResponse>{content ?? ""}</MessageResponse>
```

with:

```tsx
          <AgentMarkdown>{content ?? ""}</AgentMarkdown>
```

Leave `UserMessage` and the VPaste path on `MessageResponse` unchanged.

- [ ] **Step 3: Typecheck**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/vibedeckx-ui/components/agent/agent-message.tsx
git commit -m "feat: render assistant markdown via AgentMarkdown"
```

---

### Task 7: Wire `RightPanel` provider + `FilesView` navigation

**Files:**
- Modify: `apps/vibedeckx-ui/components/right-panel/right-panel.tsx`
- Modify: `apps/vibedeckx-ui/components/files/files-view.tsx`

**Interfaces:**
- Consumes: `useFileRefIndex`, `FileNavigationProvider` (Task 4); `FilesView`'s existing `jumpTo`/`navigate` (`use-file-browser.ts:182`, `files-view.tsx:58-59`).
- Produces: `FilesView` gains prop `navRequest?: { path: string; line: number | null; nonce: number } | null`.

- [ ] **Step 1: Add `navRequest` to `FilesView`**

In `files-view.tsx`, extend the props interface (`files-view.tsx:18`):

```tsx
interface FilesViewProps {
  projectId: string | null;
  project?: Project | null;
  selectedBranch?: string | null;
  navRequest?: { path: string; line: number | null; nonce: number } | null;
}
```

Update the signature (`files-view.tsx:24`):

```tsx
export function FilesView({ projectId, project, selectedBranch, navRequest }: FilesViewProps) {
```

After the existing `useEffect(() => { fetchRoot(); }, [fetchRoot]);` block (`files-view.tsx:73-75`), add:

```tsx
  // Drive jump-to-file requests coming from agent-message file links.
  useEffect(() => {
    if (!navRequest) return;
    if (navRequest.line != null) jumpTo(navRequest.path, navRequest.line);
    else navigate(navRequest.path);
    // Only react to a new request (nonce), not to identity churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navRequest?.nonce]);
```

- [ ] **Step 2: Provide the context in `RightPanel`**

In `right-panel.tsx`, add imports (after line 11):

```tsx
import { useMemo, useRef } from 'react';
import { FileNavigationProvider } from '@/components/agent/file-navigation-context';
import { useFileRefIndex } from '@/hooks/use-file-ref-index';
```

(Note: `useState`, `useEffect`, `useCallback` are already imported on line 3 — add `useMemo`/`useRef` there instead if you prefer a single import line.)

Inside `RightPanel`, after `const [activeTab, setActiveTab] = usePersistedTab(...)` (line 45), add:

```tsx
  const target = project && !project.path ? ("remote" as const) : undefined;
  const index = useFileRefIndex({ projectId, branch: selectedBranch, target });

  const navNonce = useRef(0);
  const [navRequest, setNavRequest] = useState<
    { path: string; line: number | null; nonce: number } | null
  >(null);

  const openFile = useCallback(
    (path: string, line: number | null = null) => {
      setActiveTab("files");
      setNavRequest({ path, line, nonce: ++navNonce.current });
    },
    [setActiveTab],
  );

  const navValue = useMemo(() => ({ openFile, index }), [openFile, index]);
```

Wrap the returned `<div className="h-full flex flex-col">…</div>` in the provider:

```tsx
  return (
    <FileNavigationProvider value={navValue}>
      <div className="h-full flex flex-col">
        {/* …existing tab bar + content unchanged… */}
      </div>
    </FileNavigationProvider>
  );
```

Pass `navRequest` to the Files panel (`right-panel.tsx:121-125`):

```tsx
          <FilesView
            projectId={projectId}
            project={project}
            selectedBranch={selectedBranch}
            navRequest={navRequest}
          />
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Manual integration verification**

Run the app (`pnpm dev:all`), open a project with an agent session, and confirm:
- A bare path with a line in prose (e.g. an agent message containing `packages/.../compaction.ts:18`) renders as a link; clicking switches to the Files tab and scrolls/highlights line 18.
- A bare unique filename (`compaction.ts`) links; an ambiguous one (`todo.ts` with multiple matches) opens a dropdown listing the full paths, each opening the right file.
- An agent markdown link `[name](path:line)` whose path resolves opens the file at the line; one whose path does NOT resolve renders as plain text (no navigation to `https://vibedeckx.dev/...`).
- Text inside a fenced code block is left untouched (no links, syntax highlighting intact).
- A real external link (`https://…`) in agent output still opens in a new tab.

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/components/right-panel/right-panel.tsx apps/vibedeckx-ui/components/files/files-view.tsx
git commit -m "feat: wire agent file-ref links to Files panel navigation"
```

---

## Self-Review

**Spec coverage:**
- Three input formats — markdown link / bare `path:line` / bare filename → Tasks 1+3 (scan + anchor transform), exercised in Task 3 tests and Task 7 manual checks. ✓
- Match-against-file-list, only matches link → Task 2 (`resolve`) + Task 3 (filter by resolve). ✓
- 0/1/many outcomes (plain / link / choice panel) → Task 3 emits all matches; Task 5 `FileRefLink` branches on `paths.length`. ✓
- Scan prose + inline code, never fenced blocks → Task 3 `processChildren` skips `<pre>`, descends elsewhere (inline `<code>` text is processed). ✓
- Suffix forms `:18` / `:18:5` / `#L18` / range → Task 1 regex + tests. ✓
- Unresolved existing markdown links → plain text → Task 3 `transformAnchor` unwrap + test. ✓
- Open in Files tab at line, reuse `jumpTo` → Tasks 4+7. ✓
- Index from `listProjectFiles`, lazy/graceful, re-render on load → Task 4 hook (null until loaded) + Task 5 context-driven re-render. ✓
- Same-branch assumption (no branch switching) → Task 7 uses the panel's own branch/target. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✓

**Type consistency:** `FileRefIndex.resolve` (Task 2) used identically in Tasks 3/4. `ScannedRef`/`parseFileHref` (Task 1) used in Task 3. Anchor property names (`dataFilePaths`, `dataFileLine`, `className:["file-ref"]`, `href:"#"`) written in Task 3, read in Task 5. `navRequest` shape identical in Tasks 7-step-1 and 7-step-2. `openFile(path, line?)` signature identical across context (Task 4), Task 5 consumers, Task 7 producer. ✓

## Risks / Notes

- **Sanitize order:** plan relies on appended rehype plugins running after streamdown's built-in `rehype-harden`. Verified `defaultRehypePlugins` is a spreadable export; if injected `data-*`/`href="#"` are ever stripped, confirm by inspecting rendered DOM in Task 7 and, if needed, move detection into a `components`-level transform.
- **Eager index load:** Task 4 loads the flat file list (≤50k, truncated) once per project/branch/target when `RightPanel` mounts with a project. Acceptable for v1; a lazy "load on first agent file-ref" trigger is a possible later optimization.
- **CLAUDE.md staleness:** CLAUDE.md says "No test framework is configured," but vitest is configured in `apps/vibedeckx-ui`. Tasks 1-3 use it. (Out of scope to fix the doc here.)
