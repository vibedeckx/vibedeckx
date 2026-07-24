# Quick Switcher Fixed Input Position — Design

## Problem

The Cmd+K quick switcher uses the shared `DialogContent` positioning rule:
`top: 50%` plus `translateY(-50%)`. Because the translation is based on the
dialog's current height, filtering the results to fewer rows makes the whole
dialog recenter and moves the search input downward.

## Desired behavior

The search input should stay at the vertical position it occupies when the
quick switcher's result list is at its 300px maximum height. As filtering
reduces the result count, only the result area and the bottom edge should move
upward. Other dialogs, including the model selector, should retain their
current centering behavior.

## Design

Apply a Quick Switcher-specific positioning class through the existing
`CommandDialog` `className` prop. Anchor the dialog at the full-state position:

- 48px command input
- 300px maximum command list
- 2px dialog border
- 350px total full-state height, yielding a 175px half-height offset

The quick switcher top edge is therefore `50% - 175px`, with no
content-height-relative Y translation. Clamp the top edge to at least 16px so
the input remains reachable on short viewports.

Do not change the shared `DialogContent`, `CommandDialog`, or `CommandList`
defaults. This keeps the behavior scoped to Cmd+K.

## Testing

Add a component-level regression test that renders `QuickSwitcher` and checks
that its dialog content receives the fixed-anchor positioning classes. The
test should fail against the current centered implementation and pass after
the scoped class is added. Run the focused test, frontend type checking, and
frontend linting.
