# Executor Preset Commands

**Date:** 2026-03-31
**Status:** Approved

## Overview

Add a "Select from presets" link to the Add Executor dialog. Clicking it swaps the form for a preset selection list. Selecting a preset and clicking Add populates the form fields and returns to the form view. Cancel returns without changes.

## Data Model

Hardcoded array in the frontend. No backend changes.

```ts
interface ExecutorPreset {
  name: string;
  command: string;
  executor_type: "command";
  pty: boolean;
}

const EXECUTOR_PRESETS: ExecutorPreset[] = [
  { name: "Dev Server", command: "pnpm dev", executor_type: "command", pty: true },
  { name: "Build", command: "pnpm build", executor_type: "command", pty: true },
  { name: "Lint", command: "pnpm lint", executor_type: "command", pty: true },
  { name: "Type Check", command: "npx tsc --noEmit", executor_type: "command", pty: true },
  { name: "Test", command: "pnpm test", executor_type: "command", pty: true },
];
```

The list is intentionally small — more presets can be added later.

## Interaction Flow

### State A: Form view (default)

```
┌──────────────────────────────────────┐
│  Add Executor     Select from presets│
│                   ↑ link style       │
├──────────────────────────────────────┤
│  Name:    [___________________]      │
│  Type:    [Command▪] [Prompt]        │
│  Command: [___________________]      │
│  CWD:     [___________________]      │
│           [Cancel]  [Add]            │
└──────────────────────────────────────┘
```

### State B: Preset selection view

```
┌──────────────────────────────────────┐
│  Select Preset                       │
├──────────────────────────────────────┤
│  ○ Dev Server          pnpm dev      │
│  ○ Build               pnpm build    │
│  ● Lint                pnpm lint     │
│  ○ Type Check      npx tsc --noEmit  │
│  ○ Test                pnpm test     │
│                                      │
│           [Cancel]  [Add]            │
└──────────────────────────────────────┘
```

### Transitions

- **Form → Presets:** Click "Select from presets" link
- **Presets → Form (with data):** Select a preset, click Add — populates name, command, executor_type, pty on the form, returns to State A
- **Presets → Form (no change):** Click Cancel — returns to State A, form fields unchanged
- In edit mode (`isEdit`), the "Select from presets" link is hidden

## UI Details

- "Select from presets" is a text link (not a button), right-aligned on the same line as the dialog title
- Preset list items are radio-style — single selection
- Each row shows name on the left, command in monospace on the right
- Add button is disabled until a preset is selected
- Dialog size stays the same between both views

## Files Changed

Only `apps/vibedeckx-ui/components/executor/executor-form.tsx`:
- Add `showPresets` boolean state and `selectedPreset` state
- Add `EXECUTOR_PRESETS` constant array
- Conditional rendering: form view vs preset list view
- On preset Add: populate form fields from selected preset, switch back to form view
- On preset Cancel: switch back to form view without changes
- Hide "Select from presets" link when `isEdit` is true
