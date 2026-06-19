# Files tab font-size settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two independent font-size sliders (File tree, File content) to Settings → Appearance that resize the Files tab's tree and preview/code text.

**Architecture:** Extend the existing `ConversationSettings` (the app's "view font sizes" container, served at `/api/settings/conversation`) with two new fields, surface them as two more `FontSizeRow` sliders in the Appearance section, and apply them to the Files tab via two CSS custom properties (`--files-tree-font-size`, `--files-content-font-size`) set on the FilesView root and consumed by the tree and preview leaf elements.

**Tech Stack:** Next.js 16 / React 19, Tailwind CSS v4, Fastify backend (`settings-routes.ts`), SQLite-backed `storage.settings`.

## Global Constraints

- Font-size range: **12–22 px** (matches existing conversation sliders; `CONV_FONT_SIZE_MIN`/`CONV_FONT_SIZE_MAX` backend, `CONVERSATION_SETTINGS_LIMITS` frontend).
- Default for both new fields: **14 px**.
- Backend ESM: all local imports use `.js` extensions; values must be integers, clamped/validated like the existing `agentFontSize`/`chatFontSize`.
- No test framework exists in this repo — verification is type-check + manual UI check. Type-check commands:
  - Backend: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
  - Frontend: `cd apps/vibedeckx-ui && npx tsc --noEmit`
- Do NOT edit the shared `components/ai-elements/code-block.tsx` (used by agent/chat views); override its font size locally in `file-preview.tsx`.
- Keep tree metadata text (`text-[11px]` size/mtime) static — it is not controlled by the slider.

---

### Task 1: Backend — add two fields to conversation settings

**Files:**
- Modify: `packages/vibedeckx/src/routes/settings-routes.ts:36-83` (interface, default, reader) and `:361-388` (PUT handler)

**Interfaces:**
- Consumes: nothing new.
- Produces: persisted `ConversationSettings` JSON now includes `filesTreeFontSize: number` and `filesContentFontSize: number` (both 12–22, default 14), returned by `GET /api/settings/conversation` and accepted by `PUT /api/settings/conversation`.

- [ ] **Step 1: Extend the interface and defaults**

In `packages/vibedeckx/src/routes/settings-routes.ts`, replace the interface + default (lines 36-44):

```ts
export interface ConversationSettings {
  agentFontSize: number;
  chatFontSize: number;
  filesTreeFontSize: number;
  filesContentFontSize: number;
}

const DEFAULT_CONVERSATION_SETTINGS: ConversationSettings = {
  agentFontSize: 15,
  chatFontSize: 15,
  filesTreeFontSize: 14,
  filesContentFontSize: 14,
};
```

- [ ] **Step 2: Validate the two new fields in the stored-settings reader**

Replace the body of `readStoredConversationSettings` (the `return { ... }` block, lines 72-79) so it also reads and validates the new fields:

```ts
    const filesTreeValid =
      typeof parsed.filesTreeFontSize === "number" &&
      validateConvFontSize(parsed.filesTreeFontSize, "filesTreeFontSize") === null;
    const filesContentValid =
      typeof parsed.filesContentFontSize === "number" &&
      validateConvFontSize(parsed.filesContentFontSize, "filesContentFontSize") === null;
    return {
      agentFontSize: agentValid
        ? (parsed.agentFontSize as number)
        : DEFAULT_CONVERSATION_SETTINGS.agentFontSize,
      chatFontSize: chatValid
        ? (parsed.chatFontSize as number)
        : DEFAULT_CONVERSATION_SETTINGS.chatFontSize,
      filesTreeFontSize: filesTreeValid
        ? (parsed.filesTreeFontSize as number)
        : DEFAULT_CONVERSATION_SETTINGS.filesTreeFontSize,
      filesContentFontSize: filesContentValid
        ? (parsed.filesContentFontSize as number)
        : DEFAULT_CONVERSATION_SETTINGS.filesContentFontSize,
    };
```

(Keep the existing `agentValid`/`chatValid` lines above this block unchanged.)

- [ ] **Step 3: Validate + merge the two new fields in the PUT handler**

In the PUT handler, replace the destructure (line 365) and add validation + merge. Change:

```ts
    const { agentFontSize, chatFontSize } = req.body;
```

to:

```ts
    const { agentFontSize, chatFontSize, filesTreeFontSize, filesContentFontSize } = req.body;
```

After the existing `chatFontSize` validation block (after line 374), add:

```ts
    if (filesTreeFontSize !== undefined) {
      const err = validateConvFontSize(filesTreeFontSize, "filesTreeFontSize");
      if (err) return reply.code(400).send({ error: err });
    }
    if (filesContentFontSize !== undefined) {
      const err = validateConvFontSize(filesContentFontSize, "filesContentFontSize");
      if (err) return reply.code(400).send({ error: err });
    }
```

Replace the `updated` object (lines 377-380) with:

```ts
    const updated: ConversationSettings = {
      agentFontSize: agentFontSize ?? existing.agentFontSize,
      chatFontSize: chatFontSize ?? existing.chatFontSize,
      filesTreeFontSize: filesTreeFontSize ?? existing.filesTreeFontSize,
      filesContentFontSize: filesContentFontSize ?? existing.filesContentFontSize,
    };
```

Update the log line (lines 383-385) to include the new fields:

```ts
    console.log(
      `[Settings] Conversation updated: agentFontSize=${updated.agentFontSize}, chatFontSize=${updated.chatFontSize}, filesTreeFontSize=${updated.filesTreeFontSize}, filesContentFontSize=${updated.filesContentFontSize}`,
    );
```

- [ ] **Step 4: Type-check the backend**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/routes/settings-routes.ts
git commit -m "feat: persist files tree/content font sizes in conversation settings"
```

---

### Task 2: Frontend — extend type, defaults, and hook setters

**Files:**
- Modify: `apps/vibedeckx-ui/lib/api.ts:437-450` (interface + defaults)
- Modify: `apps/vibedeckx-ui/hooks/use-conversation-settings.tsx` (context value, setters, fallback)

**Interfaces:**
- Consumes: `ConversationSettings` now carries `filesTreeFontSize`/`filesContentFontSize` from the backend (Task 1).
- Produces: `useConversationSettings()` returns `setFilesTreeFontSize(px: number) => void` and `setFilesContentFontSize(px: number) => void`, plus `settings.filesTreeFontSize` / `settings.filesContentFontSize`. `DEFAULT_CONVERSATION_SETTINGS` exports the two new defaults (14).

- [ ] **Step 1: Extend the interface and defaults in api.ts**

In `apps/vibedeckx-ui/lib/api.ts`, replace lines 437-445:

```ts
export interface ConversationSettings {
  agentFontSize: number;
  chatFontSize: number;
  filesTreeFontSize: number;
  filesContentFontSize: number;
}

export const DEFAULT_CONVERSATION_SETTINGS: ConversationSettings = {
  agentFontSize: 15,
  chatFontSize: 15,
  filesTreeFontSize: 14,
  filesContentFontSize: 14,
};
```

(`CONVERSATION_SETTINGS_LIMITS` at lines 447-450 stays unchanged — 12/22 already covers the new sliders.)

- [ ] **Step 2: Add the two setters to the hook**

In `apps/vibedeckx-ui/hooks/use-conversation-settings.tsx`:

Add to the context value interface (after line 26, `setChatFontSize`):

```ts
  setFilesTreeFontSize: (px: number) => void;
  setFilesContentFontSize: (px: number) => void;
```

After the `setChatFontSize` definition (after line 100), add:

```ts
  const setFilesTreeFontSize = useCallback(
    (px: number) => {
      setSettings((prev) => ({ ...prev, filesTreeFontSize: px }));
      scheduleSave({ filesTreeFontSize: px });
    },
    [scheduleSave],
  );

  const setFilesContentFontSize = useCallback(
    (px: number) => {
      setSettings((prev) => ({ ...prev, filesContentFontSize: px }));
      scheduleSave({ filesContentFontSize: px });
    },
    [scheduleSave],
  );
```

Update the `useMemo` value + deps (lines 120-123):

```ts
  const value = useMemo(
    () => ({
      settings,
      loaded,
      setAgentFontSize,
      setChatFontSize,
      setFilesTreeFontSize,
      setFilesContentFontSize,
      refresh,
    }),
    [
      settings,
      loaded,
      setAgentFontSize,
      setChatFontSize,
      setFilesTreeFontSize,
      setFilesContentFontSize,
      refresh,
    ],
  );
```

Update the no-provider fallback object (lines 135-142) to include the two new no-ops:

```ts
    return {
      settings: DEFAULT_CONVERSATION_SETTINGS,
      loaded: false,
      setAgentFontSize: () => {},
      setChatFontSize: () => {},
      setFilesTreeFontSize: () => {},
      setFilesContentFontSize: () => {},
      refresh: async () => {},
    };
```

- [ ] **Step 3: Type-check the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/vibedeckx-ui/lib/api.ts apps/vibedeckx-ui/hooks/use-conversation-settings.tsx
git commit -m "feat: expose files tree/content font-size setters in conversation settings hook"
```

---

### Task 3: Appearance UI — two new sliders + reset

**Files:**
- Modify: `apps/vibedeckx-ui/components/settings/appearance-settings.tsx`

**Interfaces:**
- Consumes: `setFilesTreeFontSize`/`setFilesContentFontSize` and `settings.filesTreeFontSize`/`settings.filesContentFontSize` from Task 2; existing `FontSizeRow` (same file), `DEFAULT_CONVERSATION_SETTINGS`.
- Produces: UI only.

- [ ] **Step 1: Pull the new setters from the hook**

In `appearance-settings.tsx`, replace line 26:

```ts
  const {
    settings,
    setAgentFontSize,
    setChatFontSize,
    setFilesTreeFontSize,
    setFilesContentFontSize,
  } = useConversationSettings();
```

- [ ] **Step 2: Reset the new fields too**

Replace `handleReset` (lines 28-31):

```ts
  const handleReset = () => {
    setAgentFontSize(DEFAULT_CONVERSATION_SETTINGS.agentFontSize);
    setChatFontSize(DEFAULT_CONVERSATION_SETTINGS.chatFontSize);
    setFilesTreeFontSize(DEFAULT_CONVERSATION_SETTINGS.filesTreeFontSize);
    setFilesContentFontSize(DEFAULT_CONVERSATION_SETTINGS.filesContentFontSize);
  };
```

- [ ] **Step 3: Add a second `SettingsField` with the two Files sliders**

Insert a new `SettingsField` immediately after the existing "Conversation font size" `SettingsField` (after line 61, before `<SettingsActions>`):

```tsx
      <SettingsField
        label="Files font size"
        hint="Independent typography for the Files tab. Tree controls the file list; content controls the file preview and code."
      >
        <div className="space-y-5">
          <FontSizeRow
            label="File tree"
            value={settings.filesTreeFontSize}
            onChange={setFilesTreeFontSize}
          />
          <FontSizeRow
            label="File content"
            value={settings.filesContentFontSize}
            onChange={setFilesContentFontSize}
          />
        </div>
      </SettingsField>
```

- [ ] **Step 4: Type-check the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/components/settings/appearance-settings.tsx
git commit -m "feat: add files tree/content font-size sliders to Appearance settings"
```

---

### Task 4: Wire CSS variables onto the FilesView root

**Files:**
- Modify: `apps/vibedeckx-ui/components/files/files-view.tsx`

**Interfaces:**
- Consumes: `useConversationSettings()` (Task 2).
- Produces: CSS custom properties `--files-tree-font-size` and `--files-content-font-size` (e.g. `"14px"`) available to the entire FilesView subtree, consumed by Tasks 5 and 6.

- [ ] **Step 1: Import the hook**

In `files-view.tsx`, add to the imports (after line 13's `useFileBrowser` import group):

```ts
import { useConversationSettings } from "@/hooks/use-conversation-settings";
```

- [ ] **Step 2: Read the settings inside the component**

After line 27 (`const [showHidden, setShowHidden] = useState(false);`), add:

```ts
  const { settings } = useConversationSettings();
```

- [ ] **Step 3: Set the CSS variables on the root container**

Replace the root return container (line 99):

```tsx
    <div
      className="flex flex-col h-full"
      style={
        {
          "--files-tree-font-size": `${settings.filesTreeFontSize}px`,
          "--files-content-font-size": `${settings.filesContentFontSize}px`,
        } as React.CSSProperties
      }
    >
```

(Leave the matching closing `</div>` at line 245 unchanged.)

- [ ] **Step 4: Type-check the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/components/files/files-view.tsx
git commit -m "feat: expose files font-size CSS variables on FilesView root"
```

---

### Task 5: Apply the tree font size

**Files:**
- Modify: `apps/vibedeckx-ui/components/files/file-tree.tsx:185-189` (directory row), `:258-262` (file row), `:344-349` (tree wrapper)

**Interfaces:**
- Consumes: `--files-tree-font-size` from Task 4.
- Produces: tree node text scales with the slider; `text-[11px]` metadata stays fixed.

- [ ] **Step 1: Set the font size on the tree wrapper**

In `file-tree.tsx`, the outer wrapper `<div>` returned by `FileTree` (starts line 345) has a `cn(...)` className and drag handlers but no `style`. Add a `style` prop to it (place it right after the `className={cn(...)}` prop, before `onDragOver`):

```tsx
      style={{ fontSize: "var(--files-tree-font-size, 14px)" }}
```

- [ ] **Step 2: Remove the hardcoded `text-sm` from the directory row**

In the directory-row `cn(...)` (line 186), change:

```tsx
            "group flex items-center w-full px-2 py-2 text-sm rounded-sm transition-colors cursor-pointer",
```

to (drop `text-sm`):

```tsx
            "group flex items-center w-full px-2 py-2 rounded-sm transition-colors cursor-pointer",
```

- [ ] **Step 3: Remove the hardcoded `text-sm` from the file row**

In the file-row `cn(...)` (line 259), change:

```tsx
        "group flex items-center w-full px-2 py-2 text-sm rounded-sm transition-colors cursor-pointer",
```

to:

```tsx
        "group flex items-center w-full px-2 py-2 rounded-sm transition-colors cursor-pointer",
```

- [ ] **Step 4: Type-check the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/components/files/file-tree.tsx
git commit -m "feat: apply files-tree font-size variable to tree nodes"
```

---

### Task 6: Apply the content font size (markdown + code)

**Files:**
- Modify: `apps/vibedeckx-ui/components/files/file-preview.tsx:302-319` (markdown branch + CodeBlock branch)

**Interfaces:**
- Consumes: `--files-content-font-size` from Task 4.
- Produces: markdown content and syntax-highlighted code scale with the slider. The shared `CodeBlock` is NOT modified; its `[&>pre]:text-sm`/`[&_code]:text-sm` are overridden locally via an important arbitrary-value wrapper class.

- [ ] **Step 1: Apply the variable to the rendered-markdown branch**

In `file-preview.tsx`, replace the markdown `<div>` (line 303):

```tsx
          <div
            className="p-4"
            style={{ fontSize: "var(--files-content-font-size, 14px)" }}
            ref={markdownRef}
          >
```

(Drop `text-sm` from the className; the inline style now governs the base font size.)

- [ ] **Step 2: Wrap CodeBlock to override its hardcoded `text-sm`**

Replace the CodeBlock branch (lines 311-319) — wrap the existing `<CodeBlock>` in a div that forces `pre`/`code` font size via the variable. The shared CodeBlock hardcodes `[&>pre]:text-sm [&_code]:text-sm`, so the override uses Tailwind's trailing-`!` important (the same important style the codebase uses at `code-block.tsx:112`):

```tsx
        ) : fileContent.content !== null ? (
          <div className="h-full [&_pre]:text-[length:var(--files-content-font-size,14px)]! [&_code]:text-[length:var(--files-content-font-size,14px)]!">
            <CodeBlock
              code={fileContent.content}
              language={getLanguage(filePath)}
              showLineNumbers
              className="border-0 rounded-none"
            >
              <CodeBlockCopyButton />
            </CodeBlock>
          </div>
```

- [ ] **Step 3: Type-check the frontend**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual verification (full feature)**

Run `pnpm dev:all`, open the app, then:
1. Settings → Appearance shows "Files font size" with "File tree" and "File content" sliders below the conversation sliders.
2. Open the Files tab. Drag "File tree" → tree node text resizes live; the size/mtime metadata stays small. Drag "File content" → markdown preview and code (open a `.md` and a code file) resize live.
3. Reload the page → both sizes persist.
4. Settings → Appearance → Reset → all four font sizes return to defaults (15/15/14/14).

Expected: all behaviors hold.

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/components/files/file-preview.tsx
git commit -m "feat: apply files-content font-size variable to preview and code"
```

---

## Notes for the implementer

- **Why CSS variables and not props:** the tree and preview leaf elements are several components deep and the shared `CodeBlock` sets its own `text-sm`. A variable set once on the FilesView root reaches everything; the only place needing an explicit override is `CodeBlock`'s `<pre>`/`<code>` (Task 6 Step 2).
- **Why not edit `CodeBlock`:** it is shared by agent and chat conversations; changing its base size there would leak into unrelated views. Keep the override local to the Files preview.
- **`React.CSSProperties` cast (Task 4):** TypeScript rejects unknown `--*` custom properties on `style` without the cast; this matches how custom properties are typically set in React+TS.
