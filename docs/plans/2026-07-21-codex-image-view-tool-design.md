# Codex Image View Tool Design

## Goal

Render Codex `imageView` thread items as ordinary tool activity instead of the generic `[imageView]` system message.

## Scope

- Show one tool row labeled `View Image`.
- Show the image path as plain text.
- Do not load, serve, thumbnail, or otherwise expose the image contents.
- Do not add an image-output message type or change Claude Code handling.
- Do not add a separate tool-result row because `imageView` is an informational completed item with no meaningful textual result.

## Data flow

When `CodexProvider` receives an `item/completed` notification whose item type is `imageView`, it emits one `tool_use` event with tool name `ImageView`, the item path in `{ path }`, and the item id as `toolUseId`. The existing agent session manager persists and broadcasts that event as a normal tool message.

The Agent UI recognizes `ImageView` and renders a dedicated tool row using the existing tool-message layout, with an image/eye icon, the label `View Image`, and a compact, wrapping path value. Missing paths render an empty path safely rather than falling back to a raw JSON block.

## Testing

- Provider test: an `imageView` notification produces exactly one `ImageView` tool-use event and no system or result event.
- UI test: an `ImageView` tool message renders `View Image` and its path without the generic `Tool: ImageView`/`Input` presentation.

