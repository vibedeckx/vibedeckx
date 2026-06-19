# Files tab font-size settings

## Summary

Let users adjust the text size of the **file tree** and the **file content viewer** in the Files tab, with two independent sliders added to the existing **Appearance** section of Settings. Reuses the existing conversation-font-size infrastructure (component, endpoint, hook) rather than introducing a new settings section.

## Motivation

The Files tab hardcodes `text-sm` (14 px) for both the file tree nodes and the file preview content. Users with different displays or visual preferences cannot adjust it. The app already exposes view-font-size controls for the agent and chat conversations in Settings → Appearance, so file tree/content sizing is the same class of control and belongs in the same place.

## Design

### Placement

Two new `FontSizeRow` sliders in the **Appearance** section (`appearance-settings.tsx`), directly below the existing agent/chat sliders:

- **File tree** — controls file tree node text size.
- **File content** — controls file preview/content text size (markdown + code).

Both reuse the existing `FontSizeRow` component and join the section's existing batch **Reset** button.

- Range: **12–22 px** (matches the conversation sliders).
- Default: **14 px** (matches today's hardcoded `text-sm`).

### Persistence

Extend the existing `ConversationSettings` rather than adding a new endpoint/hook — it is already the "view font sizes" container served at `/api/settings/conversation`.

New fields:

```ts
interface ConversationSettings {
  agentFontSize: number;        // existing
  chatFontSize: number;         // existing
  filesTreeFontSize: number;    // new — default 14, clamped 12–22
  filesContentFontSize: number; // new — default 14, clamped 12–22
}
```

- **Backend** (`packages/vibedeckx/src/routes/settings-routes.ts`): add the two fields to the conversation settings defaults, validation (clamp 12–22), and merge logic in the GET/PUT handlers.
- **API layer** (`apps/vibedeckx-ui/lib/api.ts`): extend the `ConversationSettings` interface.
- **Hook** (`apps/vibedeckx-ui/hooks/use-conversation-settings.tsx`): add `setFilesTreeFontSize` and `setFilesContentFontSize` setters and defaults, following the existing debounced-save flow used by `setAgentFontSize` / `setChatFontSize`.

### Wiring into the Files tab (CSS variables)

- **`files-view.tsx`**: read settings from `useConversationSettings()`; set `--files-tree-font-size` on the left (tree) panel and `--files-content-font-size` on the right (preview) panel via inline `style`.
- **`file-tree.tsx`**: replace the hardcoded `text-sm` on tree nodes with `fontSize: var(--files-tree-font-size, 14px)`. The 11 px metadata (file size / mtime) stays static — it is secondary chrome, not the content the slider targets.
- **`file-preview.tsx`**: replace `text-sm` on the content area with `var(--files-content-font-size, 14px)`; wrap the `CodeBlock` so the variable cascades into syntax-highlighted code.

## Components and responsibilities

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `settings-routes.ts` (conversation handlers) | Validate, default, persist the two new fields | `storage` |
| `ConversationSettings` interface (`api.ts`) | Shared type with two new fields | — |
| `use-conversation-settings.tsx` | Expose state + two new debounced setters | `api.ts` |
| `appearance-settings.tsx` | Render two `FontSizeRow` sliders + include in Reset | hook, `FontSizeRow` |
| `files-view.tsx` | Inject CSS vars onto the two panels | hook |
| `file-tree.tsx` | Apply `--files-tree-font-size` to node text | CSS var |
| `file-preview.tsx` | Apply `--files-content-font-size` to content + code | CSS var |

## Error handling

- Backend clamps out-of-range / non-numeric values to the 12–22 range and falls back to the 14 default for missing fields, consistent with existing conversation-font handling.
- CSS variables include a `14px` fallback so the Files tab renders correctly before settings load or if a value is absent.

## Testing

No test framework is configured. Manual verification:

1. Settings → Appearance shows two new sliders ("File tree", "File content") below the existing ones.
2. Dragging each slider live-updates the corresponding Files-tab area (tree vs. content/code) and persists across reload.
3. Reset returns all four font sizes to defaults.
4. Both backend (`tsc -p packages/vibedeckx/tsconfig.json`) and frontend (`cd apps/vibedeckx-ui && tsc --noEmit`) type-check clean.

## Scope / non-goals

- Font **size** only. No line-height, font-family, or monospace toggle (would justify a dedicated "Files" section later; YAGNI now).
- Tree metadata text remains static.
