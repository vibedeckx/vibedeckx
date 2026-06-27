"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CheckIcon, CopyIcon } from "lucide-react";
import {
  type ComponentProps,
  createContext,
  forwardRef,
  type HTMLAttributes,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { type BundledLanguage, codeToHtml, type ShikiTransformer } from "shiki";
import { computeFoldRanges, type FoldRange } from "@/lib/files/fold-ranges";

type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: BundledLanguage;
  showLineNumbers?: boolean;
  // 1-based line to scroll into view and briefly highlight once highlighting
  // renders. `scrollKey` lets the same line (or a repeat jump) re-trigger.
  scrollToLine?: number | null;
  scrollKey?: number;
  // Render a fold gutter (indentation-based) with collapsible regions. Opt-in so
  // chat code blocks stay untouched; the Files preview turns it on.
  foldable?: boolean;
};

type CodeBlockContextType = {
  code: string;
};

const CodeBlockContext = createContext<CodeBlockContextType>({
  code: "",
});

// Tag every line with its 1-based number so a jump can address it by selector.
const lineDataTransformer: ShikiTransformer = {
  name: "line-data",
  line(node, line) {
    node.properties["data-line"] = String(line);
  },
};

const lineNumberTransformer: ShikiTransformer = {
  name: "line-numbers",
  line(node, line) {
    node.children.unshift({
      type: "element",
      tagName: "span",
      properties: {
        className: [
          "inline-block",
          "min-w-10",
          "mr-2",
          "text-right",
          "select-none",
          "text-muted-foreground",
        ],
      },
      children: [{ type: "text", value: String(line) }],
    });
  },
};

// Prepend a fixed-width gutter cell to every line: a clickable chevron on lines
// that open a fold region, an empty spacer elsewhere (so line numbers stay
// aligned). The cell holds no text — the chevron/placeholder glyphs are drawn by
// CSS `::before`/`::after` so they never perturb the symbol-click column math or
// the selection highlight, both of which count DOM text only.
function makeFoldGutterTransformer(foldStartLines: Set<number>): ShikiTransformer {
  return {
    name: "fold-gutter",
    line(node, line) {
      node.children.unshift({
        type: "element",
        tagName: "span",
        properties: foldStartLines.has(line)
          ? { className: ["code-fold-toggle"], "data-fold-start": String(line) }
          : { className: ["code-fold-spacer"] },
        children: [],
      });
    },
  };
}

export async function highlightCode(
  code: string,
  language: BundledLanguage,
  showLineNumbers = false,
  foldStartLines?: Set<number>
) {
  // Each transformer unshifts its cell to the front, so the LAST one added ends
  // up leftmost. Order the result [line number][fold chevron][code] (VSCode-like,
  // chevron between the gutter number and the code) by adding the fold gutter
  // BEFORE the line number.
  const transformers: ShikiTransformer[] = [lineDataTransformer];
  if (foldStartLines && foldStartLines.size > 0) {
    transformers.push(makeFoldGutterTransformer(foldStartLines));
  }
  if (showLineNumbers) transformers.push(lineNumberTransformer);

  return await Promise.all([
    codeToHtml(code, {
      lang: language,
      theme: "one-light",
      transformers,
    }),
    codeToHtml(code, {
      lang: language,
      theme: "one-dark-pro",
      transformers,
    }),
  ]);
}

// Imperative controls for the fold gutter, so a sibling (the Files header's
// Fold/Expand-all buttons) can drive collapse state that lives in here.
export interface CodeBlockHandle {
  foldAll: () => void;
  expandAll: () => void;
}

export const CodeBlock = forwardRef<CodeBlockHandle, CodeBlockProps>(
  function CodeBlock(
    {
      code,
      language,
      showLineNumbers = false,
      scrollToLine,
      scrollKey,
      foldable = false,
      className,
      children,
      ...props
    },
    ref
  ) {
  const [html, setHtml] = useState<string>("");
  const [darkHtml, setDarkHtml] = useState<string>("");
  const mounted = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Foldable regions for this file and the set of collapsed header lines. Both
  // are no-ops unless `foldable`.
  const foldRanges = useMemo<FoldRange[]>(
    () => (foldable ? computeFoldRanges(code) : []),
    [foldable, code]
  );
  const foldStartLines = useMemo(
    () => new Set(foldRanges.map((r) => r.startLine)),
    [foldRanges]
  );
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  // Props whose changes adjust collapse state. Handled in the render phase below
  // (React's "adjust state on prop change" pattern) rather than in effects, to
  // avoid cascading effect renders.
  const [prevCode, setPrevCode] = useState(code);
  const [prevScroll, setPrevScroll] = useState<{
    line: number | null | undefined;
    key: number | undefined;
  }>({ line: scrollToLine, key: scrollKey });

  // Fold all = collapse every region header (nested ones hide inside their
  // parents, leaving the file's top-level structure). Expand all = clear.
  useImperativeHandle(
    ref,
    () => ({
      foldAll: () => setCollapsed(new Set(foldRanges.map((r) => r.startLine))),
      expandAll: () => setCollapsed(new Set()),
    }),
    [foldRanges]
  );

  useEffect(() => {
    highlightCode(code, language, showLineNumbers, foldStartLines).then(
      ([light, dark]) => {
        if (!mounted.current) {
          setHtml(light);
          setDarkHtml(dark);
          mounted.current = true;
        }
      }
    );

    return () => {
      mounted.current = false;
    };
  }, [code, language, showLineNumbers, foldStartLines]);

  // Apply the collapse state to the live DOM: hide the lines inside each
  // collapsed region and tag the header line so CSS can flip its chevron and
  // append a "⋯" placeholder. Re-runs after every re-highlight (the HTML string
  // is rebuilt) and on every toggle. Both light/dark copies are addressed.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const rangeByStart = new Map(foldRanges.map((r) => [r.startLine, r]));
    const hidden = new Set<number>();
    for (const start of collapsed) {
      const range = rangeByStart.get(start);
      if (!range) continue;
      for (let ln = range.startLine + 1; ln <= range.endLine; ln++) hidden.add(ln);
    }
    for (const el of root.querySelectorAll<HTMLElement>("[data-line]")) {
      const ln = Number(el.getAttribute("data-line"));
      el.style.display = hidden.has(ln) ? "none" : "";
      el.classList.toggle("code-line-collapsed", collapsed.has(ln));
    }
  }, [collapsed, foldRanges, html, darkHtml]);

  // Toggle a region when its chevron is clicked. A native (capture-free) listener
  // on the root lets us stopPropagation before the symbol-nav onClick on an
  // ancestor sees it, so folding never opens the definition popover. Delegated,
  // so it survives the HTML being rebuilt on re-highlight.
  useEffect(() => {
    if (!foldable) return;
    const root = rootRef.current;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      const toggle = (e.target as HTMLElement)?.closest?.("[data-fold-start]");
      if (!toggle) return;
      e.stopPropagation();
      e.preventDefault();
      const start = Number(toggle.getAttribute("data-fold-start"));
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(start)) next.delete(start);
        else next.add(start);
        return next;
      });
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [foldable]);

  // Scroll the target line into view and briefly highlight it, once the
  // highlighted HTML is in the DOM. CodeBlock renders two copies (light/dark);
  // only one is visible, so scroll that one but tag both for theme toggles.
  useEffect(() => {
    if (scrollToLine == null) return;
    const root = rootRef.current;
    if (!root || (!html && !darkHtml)) return;

    const nodes = Array.from(
      root.querySelectorAll<HTMLElement>(`[data-line="${scrollToLine}"]`)
    );
    if (nodes.length === 0) return;
    const visible = nodes.find((n) => n.offsetParent !== null) ?? nodes[0];

    const raf = requestAnimationFrame(() => {
      visible.scrollIntoView({ block: "center", behavior: "auto" });
      nodes.forEach((n) => n.classList.add("code-line-highlight"));
    });
    const timer = window.setTimeout(
      () => nodes.forEach((n) => n.classList.remove("code-line-highlight")),
      1600
    );
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      nodes.forEach((n) => n.classList.remove("code-line-highlight"));
    };
  }, [scrollToLine, scrollKey, html, darkHtml]);

  // Reset collapse state when a different file's code loads.
  if (code !== prevCode) {
    setPrevCode(code);
    setCollapsed(new Set());
  }

  // On a new jump request, expand any collapsed region containing the target so
  // the scroll effect lands on a visible line rather than a display:none one.
  if (prevScroll.line !== scrollToLine || prevScroll.key !== scrollKey) {
    setPrevScroll({ line: scrollToLine, key: scrollKey });
    if (scrollToLine != null && collapsed.size > 0) {
      let changed = false;
      const next = new Set(collapsed);
      for (const range of foldRanges) {
        if (
          next.has(range.startLine) &&
          scrollToLine > range.startLine &&
          scrollToLine <= range.endLine
        ) {
          next.delete(range.startLine);
          changed = true;
        }
      }
      if (changed) setCollapsed(next);
    }
  }

  return (
    <CodeBlockContext.Provider value={{ code }}>
      <div
        ref={rootRef}
        className={cn(
          "group relative w-full overflow-hidden rounded-md border bg-background text-foreground",
          className
        )}
        {...props}
      >
        <div className="relative">
          <div
            className="overflow-auto dark:hidden [&>pre]:m-0 [&>pre]:bg-background! [&>pre]:p-4 [&>pre]:text-foreground! [&>pre]:text-sm [&_code]:grid [&_code]:font-mono [&_code]:text-sm"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: "this is needed."
            dangerouslySetInnerHTML={{ __html: html }}
          />
          <div
            className="hidden overflow-auto dark:block [&>pre]:m-0 [&>pre]:bg-background! [&>pre]:p-4 [&>pre]:text-foreground! [&>pre]:text-sm [&_code]:grid [&_code]:font-mono [&_code]:text-sm"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: "this is needed."
            dangerouslySetInnerHTML={{ __html: darkHtml }}
          />
          {children && (
            <div className="absolute top-2 right-2 flex items-center gap-2">
              {children}
            </div>
          )}
        </div>
      </div>
    </CodeBlockContext.Provider>
  );
  }
);

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
};

export const CodeBlockCopyButton = ({
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  ...props
}: CodeBlockCopyButtonProps) => {
  const [isCopied, setIsCopied] = useState(false);
  const { code } = useContext(CodeBlockContext);

  const copyToClipboard = async () => {
    if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
      onError?.(new Error("Clipboard API not available"));
      return;
    }

    try {
      await navigator.clipboard.writeText(code);
      setIsCopied(true);
      onCopy?.();
      setTimeout(() => setIsCopied(false), timeout);
    } catch (error) {
      onError?.(error as Error);
    }
  };

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <Button
      className={cn("shrink-0", className)}
      onClick={copyToClipboard}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? <Icon size={14} />}
    </Button>
  );
};
