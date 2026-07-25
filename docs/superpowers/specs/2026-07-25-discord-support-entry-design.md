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
2. `packages/vibedeckx/src/server-types.ts` — add `discordInviteUrl?: string` to
   the `AppConfig` type.

### Frontend

3. `apps/vibedeckx-ui/lib/api.ts` — add `discordInviteUrl?: string` to the
   `AppConfig` interface.
4. `apps/vibedeckx-ui/components/brand/discord-icon.tsx` — new component: a
   hand-rolled Discord mark SVG following the `components/brand/logo.tsx`
   pattern (`currentColor` fill so it follows the theme; accepts a `size` prop).
   lucide-react has no Discord icon, so a small custom SVG is required.
5. `apps/vibedeckx-ui/app/page.tsx` — in the right icon cluster, render
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

Small UI addition — verify by building the frontend and driving it locally
(per the worker local UI verify recipe): with `VIBEDECKX_DISCORD_URL` unset the
button is absent; with it set the button appears in the header, and clicking it
opens the invite URL in a new tab. Screenshot both states.

## Out of Scope (YAGNI)

- **Landing-page entry** — deferred until the Discord has real activity.
- **Discord channel structure** (`#support` / `#general` / `#showcase`) — an
  operational decision, not code.
- **Generic multi-social-link config** — only Discord for now; no abstraction
  over an arbitrary set of social links until a second link actually exists.
- **"Coming soon" / disabled state** — unnecessary because the unset env var
  already hides the button.
