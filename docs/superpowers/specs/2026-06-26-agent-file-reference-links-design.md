# Clickable file references in agent output

**Date:** 2026-06-26
**Status:** Design approved, pending spec review

## Problem

Coding agents reference source locations in their chat output, but in several
inconsistent formats:

1. **Markdown links** authored by the agent: `[compaction.ts](packages/eve/src/execution/compaction.ts:18)`
   or `[getTodoCompactionMessage](packages/eve/src/runtime/framework-tools/todo.ts:56)`.
2. **Bare paths in prose**: `最后在 packages/eve/src/execution/compaction.ts:18 里`.
3. **Bare filenames**: `compaction.ts`.

Today these render badly. The markdown-link form produces an `<a>` with a
*relative* href, which the browser resolves against the current page origin —
e.g. `https://vibedeckx.dev/src/eve/packages/eve/src/execution/compaction.ts:18` —
a broken link. The display text also varies (filename vs. the symbol at that
line) purely because the agent chose it; vibedeckx does no transformation today.
Bare paths/filenames in prose are not linked at all.

## Goal

Turn file references in agent output into reliable links that open our existing
Files panel at the referenced file (and line, when present). Only references that
**actually match a file in the project** become links; everything else stays as
plain text. This both adds the feature and fixes the broken-relative-link bug.

## Non-goals

- No linkifying inside fenced code blocks (literal code/diffs/terminal output).
- No inline/overlay file preview — reuse the existing Files tab.
- No directory links (directories are not in the file list).
- No cross-branch resolution — the agent session always runs on the same
  branch/target as the Files tab, so there is no mismatch to handle.

## Rendering pipeline

Agent messages render via `MessageResponse` → `streamdown`'s `Streamdown`
(`components/ai-elements/message.tsx:309`). `Streamdown` accepts `rehypePlugins`,
`remarkPlugins`, and `components` overrides. Passing `rehypePlugins` **replaces**
the defaults, so we follow the existing pattern used for user messages
(`agent-message.tsx:146`) and pass:

```
rehypePlugins={[...Object.values(defaultRehypePlugins), rehypeFileRefs(ctx)]}
```

Appending **after** the defaults is important: Streamdown's built-in
`rehype-harden` sanitization is one of the defaults, so our plugin runs *after*
sanitization and the nodes it injects are not stripped.

The override is applied only to the **assistant** message renderer
(`AssistantMessage`, `agent-message.tsx:213`). User messages keep their current
plugins.

### `rehypeFileRefs` plugin

Walks the hast tree:

- **Skips** any subtree under a `<pre>` element (fenced code blocks).
- **Processes** text nodes in prose and inside inline `<code>`.
- For each text node, scans for candidate tokens (regex below). Each token is
  resolved against the file index. A resolved token is replaced by an `<a>`
  element carrying:
  - `className` including `file-ref`
  - `data-file-paths` — JSON array of matching full paths (1 or many)
  - `data-file-line` — the parsed start line, or absent
  - `href="#"` (real navigation is intercepted by the component)

  Unresolved tokens are left as plain text.
- **Existing `<a>` elements** whose href is a relative file-ref (not
  `http(s):`, `mailto:`, or a `#anchor`): the href is parsed as a file token and
  resolved. If it resolves, the element is converted to a `file-ref` anchor
  (display text preserved). If it does **not** resolve, the element is unwrapped
  to plain text — this kills the current broken `https://vibedeckx.dev/...`
  navigation.

### Candidate token shape

A token is considered only if it looks path-like — it contains a `/` **or** ends
in a recognized code/text extension. This is a cheap pre-filter; the file index
is the final authority, so a prose word like `config` never links unless it
exactly resolves.

Grammar (suffix optional):

```
<pathish>( :<line>(:<col>)? | #L<start>(-L?<end>)? )?
```

- `<pathish>`: a slash path (`packages/eve/src/execution/compaction.ts`) or a
  bare `name.ext`.
- Suffix forms recognized: `:18`, `:18:5`, `#L18`, `#L18-L25` (and `#L18-25`).
- We keep `<line>` / `<start>`; column and range-end are discarded.

## Resolution rules

A file **index** is built once per file list from `api.listProjectFiles`
(`lib/api.ts:1422`), which returns flat repo-relative paths:

- `fullPaths: Set<string>`
- `byBasename: Map<string, string[]>` (basename → full paths)

`resolve(rawPath) -> string[]`:

1. If `rawPath` contains `/`:
   - exact hit in `fullPaths` → `[that]`
   - else paths that **end with** `/rawPath` (unique-suffix match) → 0/1/many
     (computed via `byBasename` then suffix-filtered, to avoid scanning all
     paths)
2. If `rawPath` is bare: `byBasename.get(rawPath)` → 0/1/many.

Outcome:

- **0 matches** → not a link (plain text).
- **1 match** → direct link.
- **many matches** → link that opens a choice panel on click.

## Click → open (reuse Files tab)

A new `FileNavigationContext` provided at the `RightPanel` level
(`components/right-panel/right-panel.tsx`) exposes:

```ts
openFile(path: string, line?: number | null): void
```

It (a) switches the active right-panel tab to **Files**, and (b) sets a
`{ path, line, nonce }` target. `FilesView` consumes this target and calls the
existing `useFileBrowser.jumpTo(path, line)` (`hooks/use-file-browser.ts:182`),
which already does file selection + scroll-to-line + highlight. The chat side
never imports `useFileBrowser` — clean decoupling through the context.

The `file-ref` anchor is rendered by a `components.a` override (passed to
`MessageResponse` from `AssistantMessage`):

- Reads `data-file-paths` / `data-file-line`.
- **Single path:** `onClick` → `openFile(path, line)`.
- **Multiple paths:** `onClick` opens a small popover (shadcn `Popover`) listing
  the candidate full paths; selecting one calls `openFile(path, line)`.
- Styled as an inline link; `onClick` calls `preventDefault()` so the `href="#"`
  never navigates.

## File index loading & scope

The index is loaded with the existing `useFileSearch` hook
(`hooks/use-file-search.ts`), keyed to the **agent session's** project / branch /
target, with `ensureLoaded()` triggered when the conversation mounts. The built
index (`fullPaths`, `byBasename`) plus `openFile` are provided to the message
renderers via context.

- Until the index is loaded, references render as plain text and **upgrade** to
  links once the index arrives (the plugin re-runs on re-render when the index
  reference changes).
- Respects `truncated` from `listProjectFiles` (50k cap): unmatched tokens simply
  stay plain text — graceful degradation, no errors.

## Components & boundaries

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `file-ref-index.ts` (util) | Build index from `string[]`; `resolve(rawPath)` | none |
| `parse-file-ref.ts` (util) | Token regex + suffix parsing → `{ rawPath, line }` | none |
| `rehypeFileRefs` (rehype plugin) | Walk hast, skip `<pre>`, rewrite text + existing `<a>` into `file-ref` anchors | index, parse util |
| `FileRefLink` (`components.a` override) | Render anchor; single → `openFile`, many → choice popover | `FileNavigationContext` |
| `FileNavigationContext` | `openFile(path, line)`: switch tab + set jump target | RightPanel tab state |
| `FilesView` wiring | Consume jump target → `useFileBrowser.jumpTo` | existing hook |
| index provider | Load via `useFileSearch`, expose index to renderers | `useFileSearch` |

## Testing

- **Unit (utils):** `parse-file-ref` across all suffix forms and non-matches;
  `file-ref-index.resolve` for exact / unique-suffix / bare-unique / bare-many /
  zero cases. (No test framework is configured today; add a minimal runner or
  inline script per repo convention.)
- **Manual / integration:** render a message containing each of the three input
  forms plus an unresolved markdown link and a fenced code block; verify
  linkification, line jump, multi-match popover, plain-text fallthrough, and that
  fenced code is untouched.

## Risks / unknowns

- **Plugin order vs. `rehype-harden`:** confirmed via `defaultRehypePlugins`
  being a spreadable record; verify at implementation time that appended plugins
  run last and injected `data-*` attributes survive to the DOM.
- **Performance:** index build is O(n) over ≤50k paths, done once per load;
  per-message scanning is over visible text only. Should be negligible; confirm
  on a large repo.
