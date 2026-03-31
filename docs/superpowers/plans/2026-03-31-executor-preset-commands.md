# Executor Preset Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a preset selection view to the Add Executor dialog so users can quickly populate the form with common commands.

**Architecture:** Single-file change to `executor-form.tsx`. A `showPresets` boolean toggles between the existing form view and a new preset list view. Selecting a preset populates the form fields and returns to the form view.

**Tech Stack:** React, TypeScript, Tailwind CSS, shadcn/ui (Dialog, Button)

**Spec:** `docs/superpowers/specs/2026-03-31-executor-preset-commands-design.md`

---

### Task 1: Add preset data and state

**Files:**
- Modify: `apps/vibedeckx-ui/components/executor/executor-form.tsx:23-42`

- [ ] **Step 1: Add the ExecutorPreset interface and EXECUTOR_PRESETS array**

Add above the `ExecutorFormProps` interface (line 23):

```tsx
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

- [ ] **Step 2: Add showPresets and selectedPreset state**

Add after the existing `useState` calls (after line 42):

```tsx
const [showPresets, setShowPresets] = useState(false);
const [selectedPreset, setSelectedPreset] = useState<ExecutorPreset | null>(null);
```

- [ ] **Step 3: Reset preset state when dialog opens**

In the existing `useEffect` that syncs form values when the dialog opens (line 47-56), add at the start of the `if (open)` block:

```tsx
setShowPresets(false);
setSelectedPreset(null);
```

---

### Task 2: Add "Select from presets" link to dialog header

**Files:**
- Modify: `apps/vibedeckx-ui/components/executor/executor-form.tsx:88-91`

- [ ] **Step 1: Replace the DialogHeader to include the preset link**

Replace the current `DialogHeader` block (lines 89-91):

```tsx
<DialogHeader>
  <DialogTitle>{isEdit ? "Edit Executor" : "Add Executor"}</DialogTitle>
</DialogHeader>
```

With:

```tsx
<DialogHeader>
  <div className="flex items-center justify-between">
    <DialogTitle>{showPresets ? "Select Preset" : isEdit ? "Edit Executor" : "Add Executor"}</DialogTitle>
    {!isEdit && !showPresets && (
      <button
        type="button"
        className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setShowPresets(true)}
      >
        Select from presets
      </button>
    )}
  </div>
</DialogHeader>
```

---

### Task 3: Add preset selection view with conditional rendering

**Files:**
- Modify: `apps/vibedeckx-ui/components/executor/executor-form.tsx:92-234`

- [ ] **Step 1: Wrap the existing form in a conditional**

After the `</DialogHeader>`, wrap the existing `<form>` element in `{!showPresets && (...)}`.

- [ ] **Step 2: Add the preset list view**

Add after the conditionally-rendered form, before the closing `</DialogContent>`:

```tsx
{showPresets && (
  <div className="space-y-4">
    <div className="space-y-1">
      {EXECUTOR_PRESETS.map((preset) => (
        <button
          key={preset.command}
          type="button"
          className={cn(
            "w-full flex items-center justify-between px-3 py-2 rounded-md text-sm transition-colors",
            selectedPreset?.command === preset.command
              ? "bg-primary/10 text-primary"
              : "hover:bg-muted"
          )}
          onClick={() => setSelectedPreset(preset)}
        >
          <span className="font-medium">{preset.name}</span>
          <code className="text-xs text-muted-foreground">{preset.command}</code>
        </button>
      ))}
    </div>
    <DialogFooter>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          setShowPresets(false);
          setSelectedPreset(null);
        }}
      >
        Cancel
      </Button>
      <Button
        type="button"
        disabled={!selectedPreset}
        onClick={() => {
          if (selectedPreset) {
            setName(selectedPreset.name);
            setCommand(selectedPreset.command);
            setExecutorType(selectedPreset.executor_type);
            setPty(selectedPreset.pty);
            setShowPresets(false);
            setSelectedPreset(null);
          }
        }}
      >
        Add
      </Button>
    </DialogFooter>
  </div>
)}
```

- [ ] **Step 3: Verify type-check passes**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Verify lint passes**

Run: `pnpm --filter vibedeckx-ui lint`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/components/executor/executor-form.tsx
git commit -m "feat: add preset command selection to Add Executor dialog"
```
