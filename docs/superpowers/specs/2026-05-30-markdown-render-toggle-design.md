# Markdown render/source toggle in Files preview

## Goal

When a markdown file is opened in the Files tab, the user can toggle between a
rendered view of the markdown and its raw source. Rendered is the default.

## Scope

Frontend only — `apps/vibedeckx-ui/components/files/file-preview.tsx`. No backend
or API changes. Non-markdown files are unaffected.

## Detection

A file is markdown when `getLanguage(filePath)` returns `"markdown"` or `"mdx"`
(`.md` / `.mdx`). Reusing the existing language map keeps detection consistent
with the rest of the component.

## State

- Local `viewMode` state: `"rendered" | "source"`, default `"rendered"`.
- Resets to `"rendered"` whenever `filePath` changes (a `useEffect` keyed on
  `filePath`), so every newly opened markdown file starts rendered.

## Toggle control

- A small ghost icon button in the existing header action row, left of
  Copy/Download.
- Shown only for non-binary, non-too-large, non-empty markdown files.
- Rendered mode → `Code` icon, tooltip "View source".
- Source mode → `Eye` icon, tooltip "View rendered".

## Content rendering

For markdown files with content:

- `viewMode === "rendered"` → render `fileContent.content` via `MessageResponse`
  (the existing `Streamdown` wrapper from `@/components/ai-elements/message`),
  inside a padded, scrollable, prose-styled container.
- `viewMode === "source"` → existing `CodeBlock` path, unchanged.

Non-markdown files always use `CodeBlock`; no toggle is shown.

## Edge cases

- Empty markdown file → no toggle; falls through to the existing "Empty file."
  message.
- Too-large / binary markdown → no toggle; existing warnings shown.
