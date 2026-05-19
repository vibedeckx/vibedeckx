# Conversation Font Size Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Settings → Appearance control that lets users independently adjust font size for the Agent conversation view and the Chat session view, persisted to the backend with debounced auto-save.

**Architecture:** Backend stores `{ agentFontSize, chatFontSize }` in `storage.settings` under key `"conversation"`. A React Context Provider holds the values, applies them locally for instant preview, and debounce-saves to the backend on each change. Each conversation view sets a `--conv-font-size` CSS variable on its root; message bodies and tool-card code blocks consume the variable via inline style. Chrome elements (titles, badges, buttons) keep their hard-coded text-xs/text-sm classes.

**Tech Stack:** Fastify + better-sqlite3 (backend), Next.js 16 + React 19 + Tailwind v4 (frontend), `@radix-ui/react-slider` (new dependency), Sonner toasts.

**Note on testing:** This repo has no test framework configured (per `CLAUDE.md`). Verification steps use typecheck + manual browser observation instead of automated tests. Type checks are: backend `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`, frontend `cd apps/vibedeckx-ui && npx tsc --noEmit`.

**Reference spec:** `docs/superpowers/specs/2026-05-19-conversation-font-size-design.md`.

---

## File Structure

**New files:**
- `apps/vibedeckx-ui/hooks/use-conversation-settings.tsx` — Provider + hook with debounced auto-save (~85 lines)
- `apps/vibedeckx-ui/components/ui/slider.tsx` — shadcn-style wrapper over `@radix-ui/react-slider` (~30 lines)

**Modified files:**
- `packages/vibedeckx/src/routes/settings-routes.ts` — add `ConversationSettings` block (types, constants, GET/PUT)
- `apps/vibedeckx-ui/lib/api.ts` — add types, defaults, limits, two api methods
- `apps/vibedeckx-ui/components/auth/client-providers.tsx` — nest the new Provider
- `apps/vibedeckx-ui/components/settings/appearance-settings.tsx` — append two sliders + Reset button
- `apps/vibedeckx-ui/components/agent/agent-conversation.tsx` — read hook, set `--conv-font-size` on the root wrapper
- `apps/vibedeckx-ui/components/conversation/main-conversation.tsx` — same, with `chatFontSize`
- `apps/vibedeckx-ui/components/agent/agent-message.tsx` — make message body wrappers consume the variable
- `apps/vibedeckx-ui/components/agent/bash-tools.tsx` — code/output `<pre>` blocks consume the variable
- All other `apps/vibedeckx-ui/components/agent/*-tools.tsx` and the interactive tool UIs (`exit-plan-mode.tsx`, `ask-user-question.tsx`, `approval-request.tsx`) — sweep audit: every `<pre>` and multi-line `<code>` currently using `text-xs`/`text-[Npx]` adopts the variable (Task 12)

**Package change:**
- Add `@radix-ui/react-slider` to `apps/vibedeckx-ui/package.json`.

---

## Task 1: Backend — add ConversationSettings GET/PUT routes

**Files:**
- Modify: `packages/vibedeckx/src/routes/settings-routes.ts` (append after existing Terminal block, before the closing of the routes plugin)

- [ ] **Step 1: Add types and constants near top of file**

In `packages/vibedeckx/src/routes/settings-routes.ts`, immediately after the `FONT_SIZE_MAX = 32;` line (the Terminal constants block, around line 24), add:

```ts
export interface ConversationSettings {
  agentFontSize: number;
  chatFontSize: number;
}

const DEFAULT_CONVERSATION_SETTINGS: ConversationSettings = {
  agentFontSize: 14,
  chatFontSize: 14,
};

const CONV_FONT_SIZE_MIN = 12;
const CONV_FONT_SIZE_MAX = 22;

function readStoredConversationSettings(saved: string | undefined): ConversationSettings {
  if (!saved) return DEFAULT_CONVERSATION_SETTINGS;
  try {
    const parsed = JSON.parse(saved) as Partial<ConversationSettings>;
    return {
      agentFontSize:
        typeof parsed.agentFontSize === "number"
          ? parsed.agentFontSize
          : DEFAULT_CONVERSATION_SETTINGS.agentFontSize,
      chatFontSize:
        typeof parsed.chatFontSize === "number"
          ? parsed.chatFontSize
          : DEFAULT_CONVERSATION_SETTINGS.chatFontSize,
    };
  } catch {
    return DEFAULT_CONVERSATION_SETTINGS;
  }
}

function validateConvFontSize(value: unknown, field: string): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `${field} must be a finite number`;
  }
  if (value < CONV_FONT_SIZE_MIN || value > CONV_FONT_SIZE_MAX) {
    return `${field} must be between ${CONV_FONT_SIZE_MIN} and ${CONV_FONT_SIZE_MAX}`;
  }
  return null;
}
```

- [ ] **Step 2: Add GET/PUT routes inside the routes plugin**

Inside the `routes: FastifyPluginAsync = async (fastify) => { … }` function, append before the closing `};` (i.e., after the Terminal PUT handler ends around line 250):

```ts
  // ---- Conversation Settings ----

  fastify.get("/api/settings/conversation", async (_req, reply) => {
    const saved = fastify.storage.settings.get("conversation");
    return reply.code(200).send(readStoredConversationSettings(saved));
  });

  fastify.put<{
    Body: Partial<ConversationSettings>;
  }>("/api/settings/conversation", async (req, reply) => {
    const { agentFontSize, chatFontSize } = req.body;

    if (agentFontSize !== undefined) {
      const err = validateConvFontSize(agentFontSize, "agentFontSize");
      if (err) return reply.code(400).send({ error: err });
    }
    if (chatFontSize !== undefined) {
      const err = validateConvFontSize(chatFontSize, "chatFontSize");
      if (err) return reply.code(400).send({ error: err });
    }

    const existing = readStoredConversationSettings(fastify.storage.settings.get("conversation"));
    const updated: ConversationSettings = {
      agentFontSize: agentFontSize ?? existing.agentFontSize,
      chatFontSize: chatFontSize ?? existing.chatFontSize,
    };

    fastify.storage.settings.set("conversation", JSON.stringify(updated));
    console.log(
      `[Settings] Conversation updated: agentFontSize=${updated.agentFontSize}, chatFontSize=${updated.chatFontSize}`,
    );

    return reply.code(200).send(updated);
  });
```

- [ ] **Step 3: Run backend typecheck**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json`
Expected: No errors.

- [ ] **Step 4: Smoke test the routes**

Run (in one shell): `pnpm dev:server`
Run (in another shell, once server is listening on 5173):

```bash
curl -s http://localhost:5173/api/settings/conversation | jq
```

Expected: `{"agentFontSize": 14, "chatFontSize": 14}`

Then:

```bash
curl -s -X PUT http://localhost:5173/api/settings/conversation \
  -H 'Content-Type: application/json' \
  -d '{"agentFontSize": 16}' | jq
```

Expected: `{"agentFontSize": 16, "chatFontSize": 14}` (only `agentFontSize` changed; `chatFontSize` preserved).

Then verify range guard:

```bash
curl -s -X PUT http://localhost:5173/api/settings/conversation \
  -H 'Content-Type: application/json' \
  -d '{"agentFontSize": 99}' | jq
```

Expected: `{"error": "agentFontSize must be between 12 and 22"}` with HTTP 400.

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/routes/settings-routes.ts
git commit -m "feat(server): add conversation font size settings route"
```

---

## Task 2: Add @radix-ui/react-slider dependency

**Files:**
- Modify: `apps/vibedeckx-ui/package.json` (via pnpm command, not direct edit)

- [ ] **Step 1: Install the package**

Run from repo root:

```bash
pnpm add @radix-ui/react-slider --filter vibedeckx-ui
```

Expected: `package.json` and `pnpm-lock.yaml` updated; the package now appears under `apps/vibedeckx-ui/package.json` `dependencies`.

- [ ] **Step 2: Verify install**

Run:

```bash
ls apps/vibedeckx-ui/node_modules/@radix-ui/react-slider/package.json
```

Expected: file exists.

- [ ] **Step 3: Commit**

```bash
git add apps/vibedeckx-ui/package.json pnpm-lock.yaml
git commit -m "build(ui): add @radix-ui/react-slider"
```

---

## Task 3: Create Slider UI component

**Files:**
- Create: `apps/vibedeckx-ui/components/ui/slider.tsx`

- [ ] **Step 1: Look at the shadcn pattern already used by other ui/ components for class conventions**

Run: `head -40 apps/vibedeckx-ui/components/ui/button.tsx`

Note the import of `cn` from `@/lib/utils` and `"use client"` directive — the new file follows the same conventions.

- [ ] **Step 2: Create the component**

Create `apps/vibedeckx-ui/components/ui/slider.tsx`:

```tsx
"use client";

import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";

export const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn(
      "relative flex w-full touch-none select-none items-center",
      "data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  >
    <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted">
      <SliderPrimitive.Range className="absolute h-full bg-primary" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb
      className={cn(
        "block h-4 w-4 rounded-full border border-primary/60 bg-card shadow-[var(--shadow-sm-app)]",
        "transition-colors hover:border-primary",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
      )}
      aria-label="Value"
    />
  </SliderPrimitive.Root>
));
Slider.displayName = "Slider";
```

- [ ] **Step 3: Run frontend typecheck**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add apps/vibedeckx-ui/components/ui/slider.tsx
git commit -m "feat(ui): add Slider primitive based on @radix-ui/react-slider"
```

---

## Task 4: Frontend API — types and methods for conversation settings

**Files:**
- Modify: `apps/vibedeckx-ui/lib/api.ts`

- [ ] **Step 1: Add types and constants near the existing terminal settings block**

Open `apps/vibedeckx-ui/lib/api.ts`. After the `TERMINAL_SETTINGS_LIMITS` block (ends around line 374), append:

```ts
export interface ConversationSettings {
  agentFontSize: number;
  chatFontSize: number;
}

export const DEFAULT_CONVERSATION_SETTINGS: ConversationSettings = {
  agentFontSize: 14,
  chatFontSize: 14,
};

export const CONVERSATION_SETTINGS_LIMITS = {
  fontSizeMin: 12,
  fontSizeMax: 22,
} as const;
```

- [ ] **Step 2: Add API methods inside the `api` object**

Locate the `api.updateTerminalSettings` method (around line 1298). Immediately after it (still inside the `api = { … }` object), add:

```ts
  async getConversationSettings(): Promise<ConversationSettings> {
    const res = await authFetch(`${getApiBase()}/api/settings/conversation`);
    if (!res.ok) {
      return { ...DEFAULT_CONVERSATION_SETTINGS };
    }
    return res.json();
  },

  async updateConversationSettings(
    config: Partial<ConversationSettings>,
  ): Promise<ConversationSettings> {
    const res = await authFetch(`${getApiBase()}/api/settings/conversation`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed to update conversation settings" }));
      throw new Error(err.error || "Failed to update conversation settings");
    }
    return res.json();
  },
```

- [ ] **Step 3: Run frontend typecheck**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add apps/vibedeckx-ui/lib/api.ts
git commit -m "feat(api): add conversation settings types and methods"
```

---

## Task 5: Provider hook with debounced auto-save

**Files:**
- Create: `apps/vibedeckx-ui/hooks/use-conversation-settings.tsx`

- [ ] **Step 1: Create the file**

Create `apps/vibedeckx-ui/hooks/use-conversation-settings.tsx`:

```tsx
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  api,
  DEFAULT_CONVERSATION_SETTINGS,
  type ConversationSettings,
} from "@/lib/api";

const SAVE_DEBOUNCE_MS = 500;

interface ConversationSettingsContextValue {
  settings: ConversationSettings;
  loaded: boolean;
  setAgentFontSize: (px: number) => void;
  setChatFontSize: (px: number) => void;
  refresh: () => Promise<void>;
}

const ConversationSettingsContext = createContext<ConversationSettingsContextValue | null>(null);

export function ConversationSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<ConversationSettings>(DEFAULT_CONVERSATION_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  // Track the next-to-save value and the timer so debouncing works correctly
  // across rapid setter calls and flushes on unmount.
  const pendingRef = useRef<Partial<ConversationSettings>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.getConversationSettings();
      setSettings(next);
    } catch {
      // Keep prior/default settings on failure
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const flush = useCallback(async () => {
    const payload = pendingRef.current;
    pendingRef.current = {};
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (Object.keys(payload).length === 0) return;
    try {
      // Intentionally do not `setSettings(response)` — local state already
      // reflects the desired value; applying the server echo here would race
      // an in-flight save against a later drag and visually rubber-band.
      await api.updateConversationSettings(payload);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save font size");
    }
  }, []);

  const scheduleSave = useCallback(
    (partial: Partial<ConversationSettings>) => {
      pendingRef.current = { ...pendingRef.current, ...partial };
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void flush();
      }, SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  const setAgentFontSize = useCallback(
    (px: number) => {
      setSettings((prev) => ({ ...prev, agentFontSize: px }));
      scheduleSave({ agentFontSize: px });
    },
    [scheduleSave],
  );

  const setChatFontSize = useCallback(
    (px: number) => {
      setSettings((prev) => ({ ...prev, chatFontSize: px }));
      scheduleSave({ chatFontSize: px });
    },
    [scheduleSave],
  );

  // Flush any pending save on unmount so a drag-then-navigate doesn't drop the write.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        // Fire-and-forget; best effort.
        const payload = pendingRef.current;
        pendingRef.current = {};
        if (Object.keys(payload).length > 0) {
          api.updateConversationSettings(payload).catch(() => {
            // Swallow — we are unmounting and cannot show toast reliably.
          });
        }
      }
    };
  }, []);

  const value = useMemo(
    () => ({ settings, loaded, setAgentFontSize, setChatFontSize, refresh }),
    [settings, loaded, setAgentFontSize, setChatFontSize, refresh],
  );

  return (
    <ConversationSettingsContext.Provider value={value}>
      {children}
    </ConversationSettingsContext.Provider>
  );
}

export function useConversationSettings(): ConversationSettingsContextValue {
  const ctx = useContext(ConversationSettingsContext);
  if (!ctx) {
    return {
      settings: DEFAULT_CONVERSATION_SETTINGS,
      loaded: false,
      setAgentFontSize: () => {},
      setChatFontSize: () => {},
      refresh: async () => {},
    };
  }
  return ctx;
}
```

- [ ] **Step 2: Run frontend typecheck**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/vibedeckx-ui/hooks/use-conversation-settings.tsx
git commit -m "feat(ui): add ConversationSettings provider with debounced save"
```

---

## Task 6: Wire Provider into ClientProviders

**Files:**
- Modify: `apps/vibedeckx-ui/components/auth/client-providers.tsx`

- [ ] **Step 1: Add the import and wrap**

Open `apps/vibedeckx-ui/components/auth/client-providers.tsx` and edit it to read:

```tsx
"use client";

import { AuthWrapper } from "./auth-wrapper";
import { BrowserFramesProvider } from "@/components/preview/browser-frames-provider";
import { TerminalSettingsProvider } from "@/hooks/use-terminal-settings";
import { ConversationSettingsProvider } from "@/hooks/use-conversation-settings";
import { ThemeProvider } from "@/hooks/use-theme";

export function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <AuthWrapper>
        <TerminalSettingsProvider>
          <ConversationSettingsProvider>
            <BrowserFramesProvider>{children}</BrowserFramesProvider>
          </ConversationSettingsProvider>
        </TerminalSettingsProvider>
      </AuthWrapper>
    </ThemeProvider>
  );
}
```

- [ ] **Step 2: Run frontend typecheck**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/vibedeckx-ui/components/auth/client-providers.tsx
git commit -m "feat(ui): mount ConversationSettingsProvider in ClientProviders"
```

---

## Task 7: Extend Appearance settings with two sliders + Reset

**Files:**
- Modify: `apps/vibedeckx-ui/components/settings/appearance-settings.tsx`

- [ ] **Step 1: Replace the component body with the extended version**

Open `apps/vibedeckx-ui/components/settings/appearance-settings.tsx` and replace its contents with:

```tsx
"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type Theme } from "@/hooks/use-theme";
import { useConversationSettings } from "@/hooks/use-conversation-settings";
import { CONVERSATION_SETTINGS_LIMITS, DEFAULT_CONVERSATION_SETTINGS } from "@/lib/api";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import {
  RadioOption,
  SettingsField,
  SettingsRadioCards,
  SettingsActions,
} from "./settings-shell";

const THEME_OPTIONS: ReadonlyArray<RadioOption<Theme>> = [
  { value: "light", label: "Light", description: "Bright surface, true-white cards", Icon: Sun },
  { value: "dark", label: "Dark", description: "Low-light surfaces with deep neutrals", Icon: Moon },
  { value: "system", label: "System", description: "Match your OS preference", Icon: Monitor },
];

const { fontSizeMin, fontSizeMax } = CONVERSATION_SETTINGS_LIMITS;

export function AppearanceSettings() {
  const { theme, setTheme } = useTheme();
  const { settings, setAgentFontSize, setChatFontSize } = useConversationSettings();

  const handleReset = () => {
    setAgentFontSize(DEFAULT_CONVERSATION_SETTINGS.agentFontSize);
    setChatFontSize(DEFAULT_CONVERSATION_SETTINGS.chatFontSize);
  };

  return (
    <div className="space-y-6">
      <SettingsField label="Theme" hint="Sets the surface palette across the app. Switching is instant.">
        <SettingsRadioCards
          name="theme"
          value={theme}
          options={THEME_OPTIONS}
          onChange={setTheme}
          columns={3}
        />
      </SettingsField>

      <SettingsField
        label="Conversation font size"
        hint="Independent typography for agent and chat views. Affects message body and tool output; chrome elements stay fixed."
      >
        <div className="space-y-5">
          <FontSizeRow
            label="Agent conversation"
            value={settings.agentFontSize}
            onChange={setAgentFontSize}
          />
          <FontSizeRow
            label="Chat session"
            value={settings.chatFontSize}
            onChange={setChatFontSize}
          />
        </div>
      </SettingsField>

      <SettingsActions>
        <Button variant="ghost" size="sm" onClick={handleReset}>
          Reset to defaults
        </Button>
      </SettingsActions>
    </div>
  );
}

function FontSizeRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (px: number) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[12px] font-medium text-foreground/90">{label}</span>
        <span className="font-mono text-[11.5px] text-foreground/80 tabular-nums">{value} px</span>
      </div>
      <Slider
        min={fontSizeMin}
        max={fontSizeMax}
        step={1}
        value={[value]}
        onValueChange={(v) => onChange(v[0])}
      />
      <div className="flex justify-between mt-1 text-[10.5px] text-muted-foreground/80 font-mono">
        <span>{fontSizeMin}</span>
        <span>{fontSizeMax}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run frontend typecheck**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Visually verify in browser**

Run: `pnpm dev:all`

Open `http://localhost:3000`, navigate to Settings → Appearance. Confirm:
- Theme cards still render correctly.
- Below them: a "Conversation font size" group containing two sliders labeled "Agent conversation" and "Chat session".
- Each slider shows the current value (e.g., "14 px") top-right, and `12` / `22` endpoint labels.
- Dragging the slider updates the value live.
- Reset button is at the bottom-right of the section.

Open the network panel; drag a slider; ~500ms after releasing, observe a `PUT /api/settings/conversation` call. Refresh the page and confirm the new value persists.

Stop the dev servers.

- [ ] **Step 4: Commit**

```bash
git add apps/vibedeckx-ui/components/settings/appearance-settings.tsx
git commit -m "feat(settings): add conversation font size sliders"
```

---

## Task 8: Inject CSS variable into AgentConversation root

**Files:**
- Modify: `apps/vibedeckx-ui/components/agent/agent-conversation.tsx`

- [ ] **Step 1: Import the hook**

Near the top of the file (where other `@/hooks/*` imports live), add:

```tsx
import { useConversationSettings } from "@/hooks/use-conversation-settings";
```

- [ ] **Step 2: Use it inside the component and inject the variable on the outer wrapper**

Locate the `return (` at line 538 with `<div className="h-full flex flex-col min-h-0">`. Just above the `return (` (anywhere after the existing hook calls in the function body), add:

```tsx
  const { settings: convSettings } = useConversationSettings();
```

Then change the outer `<div>` to apply the variable:

```tsx
    <div
      className="h-full flex flex-col min-h-0"
      style={{ "--conv-font-size": `${convSettings.agentFontSize}px` } as React.CSSProperties}
    >
```

(Note: the early-return branch at line 526–535 is for a "no project" empty state and does not render messages, so the variable is not needed there.)

- [ ] **Step 3: Run frontend typecheck**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Smoke check the CSS variable in DevTools**

Run: `pnpm dev:all` and open the app. Open an Agent conversation, inspect the outer `<div>` in DevTools, and confirm it has `style="--conv-font-size: 14px"`. Change the Agent slider in Settings to 18 and verify the variable updates live on the inspected element.

Stop the dev servers.

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/components/agent/agent-conversation.tsx
git commit -m "feat(agent): publish --conv-font-size CSS variable on AgentConversation"
```

---

## Task 9: Inject CSS variable into MainConversation root

**Files:**
- Modify: `apps/vibedeckx-ui/components/conversation/main-conversation.tsx`

- [ ] **Step 1: Import the hook**

Near the existing `@/hooks/*` imports (where `useChatSession` is imported), add:

```tsx
import { useConversationSettings } from "@/hooks/use-conversation-settings";
```

- [ ] **Step 2: Use it inside `MainConversation`**

After the existing `useChatSession(…)` call in the `MainConversation` component body (around line 191), add:

```tsx
  const { settings: convSettings } = useConversationSettings();
```

- [ ] **Step 3: Apply the variable to the outer wrapper**

Locate the `return (` at line 236 with `<div className="h-full flex flex-col min-h-0">`. Change it to:

```tsx
    <div
      className="h-full flex flex-col min-h-0"
      style={{ "--conv-font-size": `${convSettings.chatFontSize}px` } as React.CSSProperties}
    >
```

- [ ] **Step 4: Run frontend typecheck**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Smoke check in DevTools**

Run: `pnpm dev:all`. Open the Main Chat panel, inspect the outer `<div>`, confirm `--conv-font-size: 14px`. Change the Chat slider in Settings → confirm the variable updates live.

Stop the dev servers.

- [ ] **Step 6: Commit**

```bash
git add apps/vibedeckx-ui/components/conversation/main-conversation.tsx
git commit -m "feat(chat): publish --conv-font-size CSS variable on MainConversation"
```

---

## Task 10: Make agent-message bodies consume the variable

**Files:**
- Modify: `apps/vibedeckx-ui/components/agent/agent-message.tsx`

**Background:** The current message bodies use Tailwind class `text-sm` (= 14px) on the `<div>` wrapping markdown content. We replace `text-sm` with an inline `fontSize` set to the CSS variable. Other classes (`prose prose-sm`, color, break-words) stay. Chrome (`text-sm font-medium text-foreground mb-1` on the "You" / "Claude" / "Codex" labels) stays at 14px regardless of the variable.

- [ ] **Step 1: Update the `UserMessage` body**

In `UserMessage` (around line 168), the wrapping `<div>` currently reads:

```tsx
<div className="text-sm text-foreground prose prose-sm dark:prose-invert max-w-none break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:break-all [&_p]:break-words">
```

Change it to:

```tsx
<div
  className="text-foreground prose prose-sm dark:prose-invert max-w-none break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:break-all [&_p]:break-words"
  style={{ fontSize: "var(--conv-font-size, 14px)" }}
>
```

- [ ] **Step 2: Update the same wrapper inside `renderTextWithVPaste`**

In `renderTextWithVPaste` (around line 154), the multi-segment branch also has the same outer `<div>`. Apply the same change there:

```tsx
<div
  className="text-foreground prose prose-sm dark:prose-invert max-w-none break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:break-all [&_p]:break-words"
  style={{ fontSize: "var(--conv-font-size, 14px)" }}
>
```

- [ ] **Step 3: Update the `AssistantMessage` body**

In `AssistantMessage` (around line 222), the wrapping `<div>` is the same pattern. Apply the same change:

```tsx
<div
  className="text-foreground prose prose-sm dark:prose-invert max-w-none break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:break-all [&_p]:break-words"
  style={{ fontSize: "var(--conv-font-size, 14px)" }}
>
```

- [ ] **Step 4: Run frontend typecheck**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Visually verify**

Run: `pnpm dev:all`. Open an Agent conversation that already has messages. Change the Agent slider to 18 — message text should grow. Set it to 12 — message text should shrink. Labels "You" / "Claude" / "Codex" must stay at the same fixed size.

Stop the dev servers.

- [ ] **Step 6: Commit**

```bash
git add apps/vibedeckx-ui/components/agent/agent-message.tsx
git commit -m "feat(agent): scale message body text via --conv-font-size"
```

---

## Task 11: Scale Bash tool `<pre>` blocks

**Files:**
- Modify: `apps/vibedeckx-ui/components/agent/bash-tools.tsx`

- [ ] **Step 1: Update each `<pre>` in the file**

There are three `<pre>` elements in `bash-tools.tsx`:
1. Line 35 (the unparseable-input fallback inside `BashToolUseUI`).
2. Line 49 (the command line `$ command` inside `BashToolUseUI`).
3. Line 76 (the output inside `BashToolResultUI`).

For each `<pre>`, remove the `text-xs` class and add `style={{ fontSize: "var(--conv-font-size, 12px)" }}`. Example for the line 49 case:

```tsx
<pre
  className="flex-1 min-w-0 bg-muted/50 p-2 rounded overflow-x-auto max-w-full whitespace-pre-wrap break-all"
  style={{ fontSize: "var(--conv-font-size, 12px)" }}
>
  <span className="text-muted-foreground select-none">$ </span>{command}
</pre>
```

Apply the same shape (remove `text-xs`, add `style`) to the other two `<pre>` elements. The fallback for line 35 (which has no parsed input) keeps the same class set minus `text-xs`:

```tsx
<pre
  className="bg-muted/50 p-2 rounded overflow-x-auto max-w-full whitespace-pre-wrap break-all"
  style={{ fontSize: "var(--conv-font-size, 12px)" }}
>
```

And the result `<pre>` at line 76:

```tsx
<pre
  className="mt-1 bg-muted/50 p-2 rounded overflow-x-auto max-h-48 overflow-y-auto max-w-full whitespace-pre-wrap break-all"
  style={{ fontSize: "var(--conv-font-size, 12px)" }}
>
```

**Note**: the surrounding chrome (`<summary>` "Output (N lines)" line 73, the `description` `<p>` line 46, the timeout `Badge` line 53) keep their `text-xs` classes — they are chrome, not body content.

- [ ] **Step 2: Run frontend typecheck**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Visually verify**

Run: `pnpm dev:all`. Open an Agent conversation containing a Bash tool call. Change the Agent slider — the `$ command` line and output `<pre>` should scale; the "Output (N lines)" summary and the timeout badge should NOT scale.

Stop the dev servers.

- [ ] **Step 4: Commit**

```bash
git add apps/vibedeckx-ui/components/agent/bash-tools.tsx
git commit -m "feat(agent): scale bash tool code/output via --conv-font-size"
```

---

## Task 12: Sweep remaining `*-tools.tsx` files for scalable `<pre>` blocks

**Files:** every `apps/vibedeckx-ui/components/agent/*-tools.tsx` other than `bash-tools.tsx` (covered in Task 11). At minimum: `grep-tools.tsx`, `glob-tools.tsx`, `edit-tools.tsx`, `file-tools.tsx`, `web-fetch-tools.tsx`, `web-search-tools.tsx`, `subagent-tools.tsx`, `task-tools.tsx`, `task-output-tools.tsx`, `file-change-tools.tsx`, `skill-tools.tsx`. Plus the interactive tool UIs: `approval-request.tsx`, `exit-plan-mode.tsx`, `ask-user-question.tsx` (only the latter two are likely to contain `<pre>`).

**The transformation pattern across all files:** find every `<pre>` (and `<code>` that wraps multi-line output) that currently has a class like `text-xs`, `text-[11px]`, `text-[12px]`, `text-[12.5px]`. Remove the size class and add `style={{ fontSize: "var(--conv-font-size, 12px)" }}` as a sibling attribute. Do NOT touch:
- Summary/label `<p>` and `<span>` chrome ("Output (N lines)", filename pills, "Read N lines", etc.)
- Badges, action buttons, chevrons, ChevronDown labels
- The `<summary>` element of a `<details>` block
- Per-line `<span>` inside a `<pre>` (those inherit from the `<pre>`'s style)

Example transformation:

Before:
```tsx
<pre className="text-xs bg-muted/50 p-2 rounded overflow-x-auto ...">
```
After:
```tsx
<pre
  className="bg-muted/50 p-2 rounded overflow-x-auto ..."
  style={{ fontSize: "var(--conv-font-size, 12px)" }}
>
```

- [ ] **Step 1: Enumerate every `<pre>` in the agent folder (excluding bash-tools.tsx already handled)**

Run:

```bash
grep -rn '<pre' apps/vibedeckx-ui/components/agent/ \
  | grep -v 'bash-tools.tsx' \
  | grep -v 'agent-message.tsx'
```

Note the output — every line listed is a transformation target.

- [ ] **Step 2: Apply the transformation to each match**

For each file in the grep output, edit each `<pre>` element following the transformation pattern above. The class to remove is whichever `text-xs` / `text-[Npx]` is present; everything else in `className` stays. If a file has no `<pre>` matches, leave it untouched.

- [ ] **Step 3: Check for `<code>` blocks that wrap multi-line content**

Run:

```bash
grep -rn 'whitespace-pre' apps/vibedeckx-ui/components/agent/ \
  | grep -v '<pre' \
  | grep -E 'text-xs|text-\['
```

For each `<code>` (or other element) that wraps multi-line content with explicit small text — typically `<code className="text-xs whitespace-pre-wrap ...">` — apply the same transformation (remove the text class, add `style={{ fontSize: "var(--conv-font-size, 12px)" }}`).

- [ ] **Step 4: Sanity grep — no remaining hard-coded small font on scalable elements**

Run:

```bash
grep -rn '<pre' apps/vibedeckx-ui/components/agent/ \
  | grep -E 'text-xs|text-\['
```

Expected: empty output.

- [ ] **Step 5: Run frontend typecheck**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Visually verify**

Run: `pnpm dev:all`. Open an Agent conversation with a mix of tool calls. Run a Grep, an Edit, a Read, a WebFetch, a subagent task. Drag the Agent slider. All tool code/output text must scale together; tool titles, file-name chips, line counts, badges must not. Plan-mode markdown (ExitPlanMode) and approval request command text should also scale.

Stop the dev servers.

- [ ] **Step 7: Commit**

```bash
git add apps/vibedeckx-ui/components/agent/
git commit -m "feat(agent): scale tool code blocks via --conv-font-size"
```

---

## Task 13: End-to-end manual verification

- [ ] **Step 1: Fresh start**

Stop all dev servers. From repo root: `pnpm dev:all`. Open `http://localhost:3000`.

- [ ] **Step 2: Settings UI checks**

Go to Settings → Appearance:
- Sliders render with current values (default 14/14 if first run; or persisted values otherwise).
- Drag the **Agent conversation** slider to 18. Open an Agent conversation in another tab/route — messages and tool code should already be at 18px.
- Drag the **Chat session** slider to 20. Open Main Chat — text should grow.
- Click **Reset to defaults** — both sliders return to 14, both views shrink back.

- [ ] **Step 3: Persistence checks**

Set Agent to 17, Chat to 19. Refresh the browser (full reload). Open Settings — both sliders should still read 17 and 19.

- [ ] **Step 4: Debounced save check**

Open DevTools → Network. Drag the Agent slider quickly from 12 to 22. Expected: at most one or two `PUT /api/settings/conversation` calls fire, ~500 ms after you stop moving the slider (not one per pixel).

- [ ] **Step 5: Error path**

In DevTools → Network, set "Offline" then drag a slider. Expected: a Sonner toast appears reading "Failed to save font size" (or the underlying network error). The slider value stays at the dragged-to position locally; refresh while still offline will revert to whatever the backend last persisted (defaults if first run).

Re-enable network.

- [ ] **Step 6: Chrome-immunity check**

Pick the largest font size (22) and the smallest (12). At both extremes, verify the following remain readable and at their original size:
- "Main Chat" header label
- Tool titles ("Bash", "Read", "Edit", etc.)
- File-name chips, "Output (N lines)" summary lines
- Timestamps in the message header hover state
- Send button, attachment buttons

If any of these change size with the slider, that element accidentally inherited from the variable — track it down and replace its style with an explicit size class.

- [ ] **Step 7: Final typecheck of both packages**

Run:

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
cd apps/vibedeckx-ui && npx tsc --noEmit && cd -
```

Expected: zero errors from both.

- [ ] **Step 8: Stop the dev servers.**

No commit for this task — verification only.

---

## Done criteria

- Settings → Appearance shows two sliders + Reset that change font size live.
- Values persist across page reloads via `PUT /api/settings/conversation` (debounced ~500ms).
- Both conversation views scale message bodies and tool code/output text in step with their slider.
- Chrome (titles, badges, buttons, timestamps) does not scale.
- Both typechecks pass.
