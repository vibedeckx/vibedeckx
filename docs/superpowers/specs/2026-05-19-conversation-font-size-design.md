# Conversation Font Size Setting — Design

**Status:** Approved — ready for planning
**Date:** 2026-05-19
**Owner:** J

## Goal

Let the user adjust font size, independently, for two scopes:

- **Agent conversation** — the streamed Claude / Codex session view (`components/agent/agent-conversation.tsx`).
- **Chat session** — the orchestrator chat (`components/conversation/main-conversation.tsx`).

The setting affects message body text *and* the code/output text inside tool cards (Bash output, Edit diff bodies, Read excerpts, Grep results, etc.). It does **not** affect chrome — tool titles, badges, buttons, timestamps, chevrons, status pills.

## Non-goals

- Global "apply to all conversations" toggle. (Two scopes are independent by design.)
- Per-project or per-session overrides. The setting is a global personal preference.
- Keyboard shortcuts (Ctrl-+ / Ctrl--). Possible future addition.
- Saving locally in `localStorage`. The product has authenticated users; preferences live on the backend so they follow the account.
- A "Save" button or save status indicator. Auto-save is debounced.

## Data model

```ts
interface ConversationSettings {
  agentFontSize: number; // 12–22, default 14
  chatFontSize:  number; // 12–22, default 14
}
```

- Default `14` matches the current visual size (Tailwind `text-sm`).
- Range `12–22`, step `1`. Below 12 is unreadable; above 22 wastes space.
- Storage key in `storage.settings`: `"conversation"` (parallels existing `"terminal"` and `"proxy"` keys).

## Architecture

Four layers, mirroring the existing Terminal-settings pattern.

### 1. Backend route — `packages/vibedeckx/src/routes/settings-routes.ts`

Add two endpoints alongside the existing Terminal routes.

`GET /api/settings/conversation` → returns `ConversationSettings`. If the key is missing or JSON-corrupt, returns `DEFAULT_CONVERSATION_SETTINGS` (no error).

`PUT /api/settings/conversation` → accepts `Partial<ConversationSettings>`. Validates each provided field is a finite number within `[FONT_SIZE_MIN, FONT_SIZE_MAX] = [12, 22]`; returns 400 with a clear message on out-of-range. Merges with existing stored values (so a PUT with only `agentFontSize` does not clobber `chatFontSize`). Writes JSON to `storage.settings.set("conversation", …)` and returns the merged result.

Constants and validation copy the structure of the existing Terminal block (lines 202–250) — no new abstraction; just a parallel implementation.

### 2. API client — `apps/vibedeckx-ui/lib/api.ts`

Export:

```ts
export interface ConversationSettings { … }
export const DEFAULT_CONVERSATION_SETTINGS: ConversationSettings = {
  agentFontSize: 14,
  chatFontSize: 14,
};
export const CONVERSATION_SETTINGS_LIMITS = {
  fontSizeMin: 12,
  fontSizeMax: 22,
} as const;
```

Plus `api.getConversationSettings()` and `api.updateConversationSettings(partial)` — same shape as the existing terminal API methods.

### 3. Hook + Context — `apps/vibedeckx-ui/hooks/use-conversation-settings.tsx`

New file. Provider pattern mirrors `use-terminal-settings.tsx`, but adds optimistic local update + debounced persistence.

```ts
interface ConversationSettingsContextValue {
  settings: ConversationSettings;       // current effective value (incl. unsaved)
  loaded: boolean;                      // initial fetch complete
  setAgentFontSize: (px: number) => void;
  setChatFontSize:  (px: number) => void;
  refresh: () => Promise<void>;
}
```

**Behavior of the setters:**

1. Update React state synchronously → drives instant preview in both conversation views.
2. `clearTimeout` any pending save, then `setTimeout(saveToBackend, 500)` — debounces network writes.
3. The Provider holds the timer ref. On unmount, `useEffect` cleanup must flush any pending save immediately (avoid losing a change when the user closes the tab right after dragging).
4. If the PUT fails (network / 5xx), surface `toast.error("Failed to save font size")`. Do **not** roll back the local value — the user already committed visually; a subsequent `refresh` on next mount will reconcile.

**Mount point:** wrap inside `ClientProviders` alongside `TerminalSettingsProvider`.

### 4. Consumers

- New `Slider` primitive at `apps/vibedeckx-ui/components/ui/slider.tsx` — thin shadcn-style wrapper over `@radix-ui/react-slider` (~30 lines, matching the project's existing Radix wrappers in `components/ui/`).
- `AppearanceSettings` adds two sliders + a Reset button (see UI section below).
- `AgentConversation` consumes the hook and sets a CSS variable on its root wrapper:

  ```tsx
  <div style={{ "--conv-font-size": `${agentFontSize}px` } as React.CSSProperties}>
    …existing markup…
  </div>
  ```

  Same for `MainConversation` with `chatFontSize`.
- Inside `agent-message.tsx` and each `*-tools.tsx` file, identify the elements that should scale (message-body markdown wrapper; `<pre>`/`<code>` blocks rendering command output, diffs, file contents, grep results) and set `style={{ fontSize: "var(--conv-font-size, inherit)" }}` on them. Chrome elements (titles, badges, action buttons, timestamps) keep their explicit `text-xs` / `text-[11px]` / `text-[12.5px]` classes and are unaffected.

## Settings page UI

Lives inside the existing **Appearance** section (`apps/vibedeckx-ui/components/settings/appearance-settings.tsx`) — immediately under the Theme field. The Settings nav (`settings-view.tsx`) is unchanged; this is just additional content in the Appearance section.

Inline mock:

```
┌─ Appearance ──────────────────────────────────────┐
│                                                   │
│  Theme                                            │
│  [ Light ] [ Dark ] [ System ]                    │
│                                                   │
│  Conversation font size                           │
│  Independent typography for agent and chat views. │
│                                                   │
│  Agent conversation                       14 px   │
│  ●──────○────────────────────                     │
│  12                                          22   │
│                                                   │
│  Chat session                             14 px   │
│  ●──────○────────────────────                     │
│  12                                          22   │
│                                                   │
│                          [ Reset to defaults ]    │
│                                                   │
└───────────────────────────────────────────────────┘
```

Details:

- Per-row label on the left, current value (mono) on the right.
- Endpoint labels `12` / `22` under the slider in muted foreground at ~10.5–11 px — matches the small-text style already used in Settings (see `SettingsField` hint typography).
- Reset button: ghost variant, right-aligned, "Reset to defaults". Sets both sliders to 14 (which then debounce-saves like any drag).
- No Save button, no inline save status row. Auto-save is implicit; errors surface via toast.

### Slider component choice

`@radix-ui/react-slider` + shadcn-style wrapper. Rationale:

- Project already uses Radix throughout (`DropdownMenu`, `Dialog`, `Tabs`, etc.) — this is continuity, not a new dependency family.
- Keyboard accessibility (Arrow / Home / End / PageUp/Down) is built in.
- shadcn wrapper file lives at `components/ui/slider.tsx`, ~30 lines.

Native `<input type="range">` was considered and rejected: cross-browser thumb/track styling requires duplicate `::-webkit-slider-thumb` / `::-moz-range-thumb` rules and never feels native to the shadcn surface.

## Edge cases

| Case | Behavior |
| --- | --- |
| First boot, no saved value | GET returns `DEFAULT_CONVERSATION_SETTINGS`; UI shows 14/14. |
| Corrupt JSON in storage | Backend `try/catch` falls back to defaults; no error surfaced to client. |
| Out-of-range value in PUT body | Backend returns 400. UI sliders are min/max-bounded so this is only reachable via direct API misuse. |
| Network failure on debounced save | Local state stays at user's chosen value; `toast.error` notifies. Next `refresh` (component remount) reconciles with backend. |
| Multiple tabs of the app open | Each tab is independent. Last PUT wins. Acceptable — this is personal display preference, not collaborative data. |
| Component unmounts during drag (route change, dialog close) | Provider `useEffect` cleanup flushes pending timeout to a synchronous PUT (best-effort `keepalive: true` if possible). |
| Provider missing in tree | `useConversationSettings` returns `{ settings: DEFAULT_CONVERSATION_SETTINGS, loaded: false, … no-op setters }` — same defensive pattern as `useTerminalSettings`. |
| Hard-coded font sizes inside tool cards (e.g. `text-[12px]` on a code block) | Audited and replaced with the CSS variable as part of this change. Chrome classes (titles, badges) are left alone. |

## Files changed

**Backend**
- `packages/vibedeckx/src/routes/settings-routes.ts` — add `ConversationSettings` type, default, limits, GET/PUT routes (~60 lines).

**Frontend types / API**
- `apps/vibedeckx-ui/lib/api.ts` — add interface, default, limits, two API methods (~20 lines).

**Frontend hook**
- `apps/vibedeckx-ui/hooks/use-conversation-settings.tsx` — new file (~80 lines).

**Frontend UI**
- `apps/vibedeckx-ui/components/ui/slider.tsx` — new file (~30 lines).
- `apps/vibedeckx-ui/components/settings/appearance-settings.tsx` — extend with two sliders + reset (~60 lines added).
- `apps/vibedeckx-ui/components/auth/client-providers.tsx` — wrap children in `ConversationSettingsProvider` (~2 lines).
- `apps/vibedeckx-ui/components/agent/agent-conversation.tsx` — consume hook, set CSS variable (~5 lines).
- `apps/vibedeckx-ui/components/conversation/main-conversation.tsx` — same (~5 lines).
- `apps/vibedeckx-ui/components/agent/agent-message.tsx` and `components/agent/*-tools.tsx` — audit and adopt CSS variable on body/code/output elements (incremental, file-by-file).

**Dependency**
- `pnpm add @radix-ui/react-slider --filter vibedeckx-ui`.

## Open questions

None outstanding — all design decisions resolved during brainstorming.
