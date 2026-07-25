# Discord Support Entry Point (Post-Login Header)

**Date:** 2026-07-25
**Status:** Approved, ready for implementation plan

## Goal

Give early/seed users a low-friction way to reach us for community and support
by adding a "Join our Discord" entry point in the logged-in app's top-right
header. The landing-page entry is deliberately deferred until the Discord has
enough activity to be worth showing to cold visitors; the post-login entry
carries near-zero risk because the only people who see it are converted seed
users we actively want to pull into the channel.

## Core Decision: Environment-Variable Driven

The invite URL is not hard-coded. It comes from a backend environment variable
surfaced through the existing `/api/config` endpoint. Consequences:

- **Unset** → the button does not render at all. This eliminates any 404 risk
  during the pre-launch period when the Discord server may not exist yet.
- **Set** → the button appears in **both** solo (local) and hosted (SaaS auth)
  modes. It is not gated on `authEnabled`, unlike the Clerk `UserMenu`.

| `VIBEDECKX_DISCORD_URL` | solo mode | hosted mode |
|---|---|---|
| unset | hidden | hidden |
| `https://discord.gg/xxxx` | shown | shown |

### The invite URL must NOT be persisted (network-confirmed only)

`useAppConfig()` reads a localStorage-persisted `AppConfig` **synchronously**
(`getPersistedConfig()` in `lib/api.ts`) and shows it on first render *before*
the background `/api/config` revalidation returns; on a network failure it
keeps the persisted value indefinitely (`use-app-config.ts:17-33`,
`lib/api.ts:105-127`). If `discordInviteUrl` were persisted like the other
fields, removing the env var would **not** reliably hide the button: a
previously-cached URL would flash in on load, and would persist forever behind
a failed refresh — resurrecting a potentially-dead invite link and breaking the
"unset → hidden" guarantee that is the whole point of the env-var gate.

Therefore `discordInviteUrl` is treated as **ephemeral, network-only**:

- `persistConfig()` strips `discordInviteUrl` before writing to localStorage, so
  it never enters the persisted cache.
- The button is therefore driven **only** by a config object that came from a
  live `/api/config` response. On the persisted-only first render (and on a
  failed refresh) the field is absent → button hidden — the safe direction.
- Net effect: setting the env var makes the button appear after the next live
  config fetch; unsetting it makes the button disappear after the next live
  fetch and it can never be resurrected from stale cache.

## Placement

A standalone ghost icon button in the header's right-hand icon cluster
(`app/page.tsx`, ~line 730), next to `KeyboardShortcutsOverlay` (the "?"
button). Chosen over tucking it into the Clerk avatar menu because:

- Discoverability is the priority for seed users, and
- the avatar menu only exists in hosted mode, so solo users would never see it.

Current right cluster (left→right): Search (⌘K) · "?" shortcuts · connection
status · notification bell · user avatar. The Discord button slots in near the
"?" button.

## Components & Changes

### Backend

1. `packages/vibedeckx/src/server.ts` — in the `/api/config` handler (~line 281),
   add:
   ```ts
   discordInviteUrl: process.env.VIBEDECKX_DISCORD_URL || undefined,
   ```
   The `/api/config` response object is an inline literal with an inferred type;
   there is **no** explicit backend `AppConfig` type to update. (`server-types.ts`
   only declares the Fastify `FastifyInstance` decoration, not this response.)
   This is the only backend change.

### Frontend

2. `apps/vibedeckx-ui/lib/api.ts` — two changes:
   - add `discordInviteUrl?: string` to the `AppConfig` interface (the only
     explicit `AppConfig` type in the codebase);
   - in `persistConfig()` (~line 105), strip `discordInviteUrl` before writing
     to localStorage so it never enters the persisted cache (see "must NOT be
     persisted" above). e.g. persist an explicit
     `{ authEnabled, clerkPublishableKey, localProjectsEnabled }` subset, or
     `delete` the field from a shallow copy.
3. `apps/vibedeckx-ui/components/brand/discord-icon.tsx` — new component: a
   hand-rolled Discord mark SVG following the `components/brand/logo.tsx`
   pattern (`currentColor` fill so it follows the theme; accepts a `size` prop).
   lucide-react has no Discord icon, so a small custom SVG is required.
4. `apps/vibedeckx-ui/app/page.tsx` — in the right icon cluster, render
   conditionally on `config?.discordInviteUrl`:
   ```tsx
   {config?.discordInviteUrl && (
     <Button asChild variant="ghost" size="icon-sm" title="Join our Discord">
       <a
         href={config.discordInviteUrl}
         target="_blank"
         rel="noopener noreferrer"
         aria-label="Join our Discord"
       >
         <DiscordIcon />
       </a>
     </Button>
   )}
   ```
   Add `useAppConfig()` to `page.tsx` if it does not already consume it. The
   config object is shared with `UserMenu`, which already uses the hook.

## Copy

Tooltip / aria-label: **"Join our Discord"** (framed as a direct reach/support
channel rather than "Community", which reads empty while the group is small).
Easy to change later once the community grows.

## Testing / Verification

Automated tests guard the conditional logic (which is the only place a
regression could hide); a manual pass confirms the end-to-end wiring.

**Automated (required):**

1. **Backend — `/api/config` response** (vitest, follow the existing
   `server.identity-preflight.integration.test.ts` pattern): with
   `process.env.VIBEDECKX_DISCORD_URL` set, the response includes that
   `discordInviteUrl`; unset, the field is absent/undefined.
2. **Frontend — persist strip** (`lib/api.test.ts`, unit): `persistConfig()`
   given a config containing `discordInviteUrl` writes a localStorage value with
   the other fields but **without** `discordInviteUrl`; `getPersistedConfig()`
   round-trips without it. This is the regression guard for the "must NOT be
   persisted" rule.
3. **Frontend — button render** (jsdom + `createRoot`, per
   `components/agent/turn-end-divider.test.tsx`): rendered with a config that has
   `discordInviteUrl` → exactly one link with that `href`, `target="_blank"`,
   `rel="noopener noreferrer"`, and accessible name "Join our Discord"; rendered
   with the field absent → no such link.
4. **Frontend — stale-cache regression**: a config sourced from the persisted
   path (no `discordInviteUrl`, simulating "env var since removed / never in
   cache") renders no button — proving a stale cached URL cannot resurrect it.
   Covered by tests 2 + 3; call it out explicitly so the plan includes the case.

**Manual (confirmation):** build the frontend and drive it locally (per the
worker local UI verify recipe) — with `VIBEDECKX_DISCORD_URL` unset the button is
absent; with it set the button appears in the header and clicking it opens the
invite URL in a new tab. Screenshot both states.

## Out of Scope (YAGNI)

- **Landing-page entry** — deferred until the Discord has real activity.
- **Discord channel structure** (`#support` / `#general` / `#showcase`) — an
  operational decision, not code.
- **Generic multi-social-link config** — only Discord for now; no abstraction
  over an arbitrary set of social links until a second link actually exists.
- **"Coming soon" / disabled state** — unnecessary because the unset env var
  already hides the button.
