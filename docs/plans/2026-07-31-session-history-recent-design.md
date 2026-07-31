# Session History Recent Design

## Goal

When a user explicitly switches sessions from the workspace Session History
dropdown, treat the selected session as recently opened so it rises to the top
of the empty-query Cmd+K Recent group.

## Design

Keep the quick-switcher cache owned by the page layer. Add an
`onSessionSelected` callback to `AgentConversation`, pass
`touchRecentSessionOpen` from `app/page.tsx`, and invoke the callback only from
the dropdown's user-driven `onSwitch` handler.

Do not record automatic session resolution, URL restoration, commander
surfacing, or the fallback navigation that follows deletion. Those are not
explicit user selections and should not perturb the user's MRU ordering.

## Alternatives

- Import the quick-switcher cache directly into `AgentConversation`. This is
  smaller, but couples the reusable conversation component to global
  navigation storage.
- Record every resolved active session through `onActiveSessionChange`. This
  centralizes the behavior, but incorrectly counts automatic restoration and
  background-driven session changes.

The callback approach preserves ownership and expresses the product boundary
directly.

## Verification

Add a focused component regression test that selects a dropdown session and
asserts both the URL selection and MRU callback fire. Also assert deletion
fallback only changes the URL. Run the focused test, related quick-switcher
tests, and the UI TypeScript check.
