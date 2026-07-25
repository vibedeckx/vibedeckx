# Discord Support Entry Point Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an env-var-driven "Join our Discord" icon button to the logged-in app's top-right header.

**Architecture:** The backend `/api/config` endpoint surfaces a `discordInviteUrl` read from `process.env.VIBEDECKX_DISCORD_URL`. The frontend renders a header icon button only when that URL is present in a *live* config response — the URL is deliberately kept out of the persisted localStorage cache so unsetting the env var reliably removes the button and a stale URL can never resurrect a dead link.

**Tech Stack:** Fastify (backend, ESM/NodeNext), Next.js 16 / React 19 (frontend), vitest (both), Tailwind v4 + shadcn `Button`, lucide-react (no Discord icon → hand-rolled SVG).

## Global Constraints

- Env var name: **`VIBEDECKX_DISCORD_URL`** (exact).
- Button copy / tooltip / accessible name: **"Join our Discord"** (exact).
- Button is **NOT** gated on `authEnabled` — it shows in both solo and hosted modes when the URL is set.
- `discordInviteUrl` is **ephemeral / network-only**: it must never be written to the persisted config cache.
- Backend is ESM with NodeNext resolution — all local imports use `.js` extensions.
- The `/api/config` response is an inline object literal with an inferred type; there is **no** backend `AppConfig` type to edit. The only explicit `AppConfig` type is in `apps/vibedeckx-ui/lib/api.ts`.

---

## File Structure

- Modify `packages/vibedeckx/src/server.ts` — add `discordInviteUrl` to the `/api/config` literal (one line).
- Create `packages/vibedeckx/src/server.config-discord.test.ts` — integration test for the config field.
- Modify `apps/vibedeckx-ui/lib/api.ts` — add `discordInviteUrl?` to `AppConfig`; strip it in `persistConfig`.
- Create `apps/vibedeckx-ui/lib/config-persist.test.ts` — jsdom test proving the URL is not persisted.
- Create `apps/vibedeckx-ui/components/brand/discord-icon.tsx` — hand-rolled Discord SVG.
- Create `apps/vibedeckx-ui/components/layout/discord-button.tsx` — the header button (`inviteUrl` prop; renders null when absent).
- Create `apps/vibedeckx-ui/components/layout/discord-button.test.tsx` — render test.
- Modify `apps/vibedeckx-ui/app/page.tsx` — read `useAppConfig()` and mount `<DiscordButton>` in the header cluster.

---

### Task 1: Backend — surface `discordInviteUrl` on `/api/config`

**Files:**
- Modify: `packages/vibedeckx/src/server.ts:281-290`
- Test: `packages/vibedeckx/src/server.config-discord.test.ts`

**Interfaces:**
- Consumes: existing `createServer({ storage, uiRoot })` and `server.startLocal(0)` (see `server.identity-preflight.integration.test.ts`).
- Produces: `/api/config` JSON now includes `discordInviteUrl: string | undefined` — the field the frontend `AppConfig` (Task 2) reads.

- [ ] **Step 1: Write the failing test**

Create `packages/vibedeckx/src/server.config-discord.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/**
 * server.ts reads env at module load, and the /api/config handler reads
 * process.env.VIBEDECKX_DISCORD_URL per request. We build a fresh server with
 * the var set, assert the field is surfaced, then clear it and assert it drops.
 */
describe("/api/config discordInviteUrl", () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  let dir: string;

  beforeAll(async () => {
    vi.resetModules();
    const { createServer } = await import("./server.js");
    const { createSqliteStorage } = await import("./storage/sqlite.js");

    dir = mkdtempSync(path.join(tmpdir(), "vdx-discord-"));
    const storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    const server = await createServer({ storage, uiRoot: null });
    const started = await server.startLocal(0);
    baseUrl = started.url;
    close = async () => {
      await server.close();
      await storage.close();
    };
  }, 30_000);

  afterAll(async () => {
    delete process.env.VIBEDECKX_DISCORD_URL;
    await close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it("includes the URL when VIBEDECKX_DISCORD_URL is set", async () => {
    process.env.VIBEDECKX_DISCORD_URL = "https://discord.gg/testinvite";
    const res = await fetch(`${baseUrl}/api/config`);
    const body = (await res.json()) as { discordInviteUrl?: string };
    expect(body.discordInviteUrl).toBe("https://discord.gg/testinvite");
  });

  it("omits the URL when VIBEDECKX_DISCORD_URL is unset", async () => {
    delete process.env.VIBEDECKX_DISCORD_URL;
    const res = await fetch(`${baseUrl}/api/config`);
    const body = (await res.json()) as { discordInviteUrl?: string };
    expect(body.discordInviteUrl).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/vibedeckx && npx vitest run src/server.config-discord.test.ts`
Expected: FAIL — first test gets `undefined` (field not yet added).

- [ ] **Step 3: Add the field**

In `packages/vibedeckx/src/server.ts`, in the `/api/config` handler, add the line after `localProjectsEnabled`:

```ts
  server.get("/api/config", async () => ({
    authEnabled,
    clerkPublishableKey: authEnabled ? process.env.CLERK_PUBLISHABLE_KEY : undefined,
    localProjectsEnabled: !noLocalProjects,
    discordInviteUrl: process.env.VIBEDECKX_DISCORD_URL || undefined,
    // Capability flag for the reverse-connect identity preflight. Workers
    // check this before calling /api/reverse-connect/identity so an auth
    // middleware 401 from an older hub (which lacks the endpoint AND its
    // exemptions) is never confused with a genuinely rejected token.
    reverseConnectIdentity: true,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/vibedeckx && npx vitest run src/server.config-discord.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add packages/vibedeckx/src/server.ts packages/vibedeckx/src/server.config-discord.test.ts
git commit -m "feat: surface discordInviteUrl on /api/config from VIBEDECKX_DISCORD_URL"
```

---

### Task 2: Frontend — `AppConfig` type + non-persisted `discordInviteUrl`

**Files:**
- Modify: `apps/vibedeckx-ui/lib/api.ts:89-94` (interface) and `:105-112` (`persistConfig`)
- Test: `apps/vibedeckx-ui/lib/config-persist.test.ts`

**Interfaces:**
- Consumes: existing `api.getConfig()`, `getPersistedConfig()`, `persistConfig()`, and `CONFIG_STORAGE_KEY = "vibedeckx:app-config"` in `lib/api.ts`.
- Produces: `AppConfig.discordInviteUrl?: string`, read by `DiscordButton` (Task 4) via `useAppConfig()`; guaranteed absent from persisted storage.

- [ ] **Step 1: Write the failing test**

Create `apps/vibedeckx-ui/lib/config-persist.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("config persistence", () => {
  it("does not write discordInviteUrl to the persisted cache", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({
          authEnabled: true,
          localProjectsEnabled: true,
          discordInviteUrl: "https://discord.gg/secret",
        }),
      }),
    );

    await api.getConfig();

    const raw = window.localStorage.getItem("vibedeckx:app-config");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed.discordInviteUrl).toBeUndefined();
    expect(parsed.authEnabled).toBe(true);
    expect(parsed.localProjectsEnabled).toBe(true);
    // The stored string must not carry the invite anywhere.
    expect(raw).not.toContain("discord.gg");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/vibedeckx-ui && npx vitest run lib/config-persist.test.ts`
Expected: FAIL — `parsed.discordInviteUrl` is `"https://discord.gg/secret"` (currently persisted verbatim).

- [ ] **Step 3: Add the type field**

In `apps/vibedeckx-ui/lib/api.ts`, extend the `AppConfig` interface:

```ts
export interface AppConfig {
  authEnabled: boolean;
  clerkPublishableKey?: string;
  // Absent on older servers / persisted configs — treat missing as enabled.
  localProjectsEnabled?: boolean;
  // Ephemeral / network-only — NEVER persisted (see persistConfig). Drives the
  // header Discord button; unsetting the server env var must reliably hide it.
  discordInviteUrl?: string;
}
```

- [ ] **Step 4: Strip the field in `persistConfig`**

Replace the body of `persistConfig` in `apps/vibedeckx-ui/lib/api.ts`:

```ts
function persistConfig(config: AppConfig): void {
  if (typeof window === "undefined") return;
  try {
    // discordInviteUrl is intentionally omitted: it must never survive in the
    // synchronously-read cache, so a removed env var can't leave a stale button.
    const { discordInviteUrl: _drop, ...persistable } = config;
    window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(persistable));
  } catch {
    // ignore storage failures (private mode / quota) — we still have it in memory
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/vibedeckx-ui && npx vitest run lib/config-persist.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: no errors. (The `_drop` unused-binding is fine — it is a rest-omit, not an unused local.)

- [ ] **Step 7: Commit**

```bash
git add apps/vibedeckx-ui/lib/api.ts apps/vibedeckx-ui/lib/config-persist.test.ts
git commit -m "feat: add discordInviteUrl to AppConfig, keep it out of persisted cache"
```

---

### Task 3: Frontend — `DiscordIcon` SVG

**Files:**
- Create: `apps/vibedeckx-ui/components/brand/discord-icon.tsx`

**Interfaces:**
- Produces: `DiscordIcon({ className }: { className?: string })` — a themed SVG (fills `currentColor`), consumed by `DiscordButton` (Task 4).

- [ ] **Step 1: Create the component**

Create `apps/vibedeckx-ui/components/brand/discord-icon.tsx`:

```tsx
import { cn } from "@/lib/utils";

// Discord wordmark glyph (official mark path, simple-icons geometry). Uses
// currentColor so it inherits the ghost button's foreground color and follows
// the theme. lucide-react ships no Discord icon, hence this hand-rolled SVG.
export function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cn("h-4 w-4", className)}
      aria-hidden="true"
    >
      <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189z" />
    </svg>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/vibedeckx-ui/components/brand/discord-icon.tsx
git commit -m "feat: add hand-rolled Discord icon SVG"
```

---

### Task 4: Frontend — `DiscordButton` component + render tests

**Files:**
- Create: `apps/vibedeckx-ui/components/layout/discord-button.tsx`
- Test: `apps/vibedeckx-ui/components/layout/discord-button.test.tsx`

**Interfaces:**
- Consumes: `DiscordIcon` (Task 3), shadcn `Button` (`@/components/ui/button`).
- Produces: `DiscordButton({ inviteUrl }: { inviteUrl?: string })` — renders an external-link icon button, or `null` when `inviteUrl` is falsy. Mounted by `page.tsx` (Task 5).

- [ ] **Step 1: Write the failing test**

Create `apps/vibedeckx-ui/components/layout/discord-button.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DiscordButton } from "./discord-button";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function render(ui: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  return act(async () => {
    root!.render(ui);
  });
}

describe("DiscordButton", () => {
  it("renders an external invite link when inviteUrl is set", async () => {
    await render(<DiscordButton inviteUrl="https://discord.gg/testinvite" />);
    const link = container!.querySelector('a[aria-label="Join our Discord"]') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("https://discord.gg/testinvite");
    expect(link!.getAttribute("target")).toBe("_blank");
    expect(link!.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders nothing when inviteUrl is undefined", async () => {
    await render(<DiscordButton />);
    expect(container!.querySelector("a")).toBeNull();
    expect(container!.textContent).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/vibedeckx-ui && npx vitest run components/layout/discord-button.test.tsx`
Expected: FAIL — module `./discord-button` not found.

- [ ] **Step 3: Implement the component**

Create `apps/vibedeckx-ui/components/layout/discord-button.tsx`:

```tsx
import { Button } from "@/components/ui/button";
import { DiscordIcon } from "@/components/brand/discord-icon";

// Header entry point to the community/support Discord. Renders only when an
// invite URL is provided (driven by the server's VIBEDECKX_DISCORD_URL via
// /api/config); absent config means no button — no dead links pre-launch.
// Shown in both solo and hosted modes (not gated on authEnabled).
export function DiscordButton({ inviteUrl }: { inviteUrl?: string }) {
  if (!inviteUrl) return null;
  return (
    <Button asChild variant="ghost" size="icon-sm" title="Join our Discord">
      <a href={inviteUrl} target="_blank" rel="noopener noreferrer" aria-label="Join our Discord">
        <DiscordIcon />
      </a>
    </Button>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/vibedeckx-ui && npx vitest run components/layout/discord-button.test.tsx`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/components/layout/discord-button.tsx apps/vibedeckx-ui/components/layout/discord-button.test.tsx
git commit -m "feat: add DiscordButton header component with render tests"
```

---

### Task 5: Wire `DiscordButton` into the header

**Files:**
- Modify: `apps/vibedeckx-ui/app/page.tsx` (imports; header cluster at `:720-743`)

**Interfaces:**
- Consumes: `useAppConfig()` (`@/hooks/use-app-config`), `DiscordButton` (Task 4).

- [ ] **Step 1: Add imports**

In `apps/vibedeckx-ui/app/page.tsx`, add near the existing imports (alongside `import { Button } from '@/components/ui/button';` at line 18):

```tsx
import { useAppConfig } from "@/hooks/use-app-config";
import { DiscordButton } from "@/components/layout/discord-button";
```

- [ ] **Step 2: Read the config in the component**

Inside the `page.tsx` component body (near the other hooks, before the `return`), add:

```tsx
const { config } = useAppConfig();
```

(If a `config`/`useAppConfig` binding already exists in this component, reuse it instead of adding a duplicate.)

- [ ] **Step 3: Mount the button in the header cluster**

In the right-hand icon cluster (the `<div className="flex items-center gap-2.5">` at line 720), add `<DiscordButton>` right after `<KeyboardShortcutsOverlay />`:

```tsx
            <KeyboardShortcutsOverlay />
            <DiscordButton inviteUrl={config?.discordInviteUrl} />
            <ConnectionStatusIndicator />
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/vibedeckx-ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/vibedeckx-ui/app/page.tsx
git commit -m "feat: mount Discord entry button in logged-in header"
```

---

### Task 6: Full verification (build + drive both states)

**Files:** none (verification only).

- [ ] **Step 1: Run the full frontend test + typecheck suite**

Run: `cd apps/vibedeckx-ui && npx vitest run && npx tsc --noEmit`
Expected: all tests pass, no type errors.

- [ ] **Step 2: Run the backend test + typecheck**

Run: `npx tsc --noEmit -p packages/vibedeckx/tsconfig.json && cd packages/vibedeckx && npx vitest run src/server.config-discord.test.ts`
Expected: no type errors, config test passes.

- [ ] **Step 3: Build the frontend**

Run: `pnpm build:ui`
Expected: static export completes without errors.

- [ ] **Step 4: Drive the app in both states (per the worker local UI verify recipe)**

Start the server on an isolated data-dir with the env var set, e.g.
`VIBEDECKX_DISCORD_URL=https://discord.gg/testinvite node packages/vibedeckx/dist/bin.js --data-dir /tmp/vdx-discord-verify --port <free-port>`
(do NOT run `connect stop`; use a throwaway `--data-dir`, per memory).

Confirm and screenshot:
- **Env set:** the Discord icon appears in the top-right header between the "?" and the connection-status indicator; clicking opens `https://discord.gg/testinvite` in a new tab.
- **Env unset** (restart without `VIBEDECKX_DISCORD_URL`): the Discord icon is absent.

- [ ] **Step 5: Final confirmation**

Report both screenshots and the passing test/build output. No commit (verification only).

---

## Notes for the implementer

- Do not gate the button on `authEnabled` — solo users should see it too. This differs from `UserMenu`, which returns null in solo mode.
- The `_drop` binding in `persistConfig` is an intentional rest-omit to strip a field; do not "fix" it into a delete on the original object (that would mutate the caller's config, which is also `_cachedConfig`).
- If `page.tsx` already consumes `useAppConfig`, reuse the existing binding rather than calling the hook twice.
