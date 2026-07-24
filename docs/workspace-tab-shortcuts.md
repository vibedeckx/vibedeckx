# Workspace Tab Keyboard Shortcuts

Jump to any right-panel tab from the keyboard, including while typing in a
chat input. Shipped in `f665ded`; this doc records the binding design, why the
modifiers look the way they do, the xterm passthrough, and two agreed
follow-ups (iframe key bridge, custom bindings).

Code lives in `apps/vibedeckx-ui/lib/tab-shortcuts.ts` (single source of
truth for the combos), consumed by
`components/right-panel/right-panel.tsx` (window keydown → switch tab,
per-platform tooltips) and `components/executor/executor-output.tsx`
(xterm passthrough).

---

## 1. Bindings

Each tab is addressed by its label's first letter:

| Tab | macOS | Windows / Linux |
|-----|-------|-----------------|
| Agent | ⌃⇧A | Ctrl+Alt+A |
| Executors | ⌃⇧E | Ctrl+Alt+E |
| Diff | ⌃⇧D | Ctrl+Alt+D |
| Terminal | ⌃⇧T | Ctrl+Alt+T |
| Browser | ⌃⇧B | Ctrl+Alt+B |
| Files | ⌃⇧F | Ctrl+Alt+F |

Matching uses `event.code` (physical key), so IMEs and non-latin layouts
don't affect it. The shortcuts fire even while an input/textarea is focused —
the combos produce no text, and jumping mid-typing is the point. They are
gated to the workspace view (`active` prop; the panel stays mounted on other
views).

## 2. Why these modifiers (and why they differ per platform)

Hard requirement from design review: **do not shadow any browser or system
shortcut.** That killed every simpler scheme:

- Plain `⌘/Ctrl + first letter`: T (new tab, non-interceptable), A (select
  all), D (bookmark), F (find), B (already our sidebar toggle).
- `⌘⇧ + letter` on macOS: Chrome owns ⌘⇧A (tab search), ⌘⇧B (bookmarks bar),
  ⌘⇧D (bookmark all); ⌘⇧T (reopen tab) can't be intercepted at all.
- `⌘⌥ + letter` on macOS: ⌘⌥D is the system Dock toggle (non-interceptable).
- Digits (`⌘1-6`): browser tab switching; `⌘⇧3/4/5` are macOS screenshots.
  Also rejected ergonomically — the digit row is far from the modifiers.

What's left is a per-platform split, because each clean namespace is only
clean on its own platform:

- **macOS ⌃⇧**: the real Control key is nearly unused by macOS browsers
  (their shortcuts are ⌘-based), so ⌃⇧+letter is free — including D and T.
- **Windows/Linux Ctrl+Alt**: Ctrl+Shift is the browser's own namespace there
  (Ctrl+Shift+T reopen-tab is reserved and non-interceptable), while
  Ctrl+Alt+letter is free in all major browsers.

Accepted known exceptions (documented, not fixable):

- Ctrl+Alt+T opens a terminal on many Linux desktops (system-level).
- AltGr (= Ctrl+Alt) types symbols on some European layouts.
- Some IMEs bind ⌃⇧+letter (e.g. Sogou's ⌃⇧F simplified/traditional toggle).
- Cocoa text fields lose the (very obscure) ⌃⇧A/E select-to-paragraph chords.
- Window managers like Rectangle default to ⌃⌥+letter — adjacent but not
  overlapping; users who rebound them to ⌃⇧ will collide.

## 3. xterm passthrough

xterm.js consumes keydown events (they never bubble to `window`) and encodes
modifier combos into control bytes for the PTY. Without special handling a
focused terminal both **swallowed** the shortcut and **leaked bytes into the
shell** — observed via `cat -v` as `^[^T` etc.; on macOS ⌃⇧D would arrive as
`^D` and EOF the shell.

Fix: `executor-output.tsx` registers
`terminal.attachCustomKeyEventHandler((e) => matchTabShortcut(e) === null)`.
Returning `false` makes xterm skip the key entirely (nothing reaches the
PTY) **without** calling preventDefault/stopPropagation, so the event bubbles
to the window listener and the tab switch happens. This covers both the
Terminal tab and Executors log views (same component).

## 4. Follow-up: Browser-preview iframe key bridge (not built)

While focus is inside the Browser tab's preview iframe, **no** global
shortcut fires — keyboard events don't cross document boundaries. This
pre-dates the tab shortcuts (⌘K quick switcher, ⌘J notifications, ⌘B sidebar
have always had the same hole) and is therefore a separate task, not a tab-
shortcut bug.

Agreed design, if/when built:

1. **Forward from inside the proxy.** The browser-preview proxy already
   injects a script into proxied pages (see
   `browser-proxy-routes.ts` / `browser-frames-provider.tsx`). Add a keydown
   listener there that forwards **only an allowlist** of combos (the six tab
   combos + ⌘K/⌘J/⌘B/⌘⇧O) via the existing postMessage channel. No full
   keystroke forwarding — keep the injection surface minimal.
2. **Keep the gating.** The parent-side message handler must retain the
   existing origin + source + projectId checks. Page content has previously
   been used for injection attacks here; an ungated channel would let a
   hostile page fabricate keystrokes and drive the UI.
3. **Re-dispatch once, centrally.** After validation, re-dispatch a synthetic
   `KeyboardEvent` on `window`. Every existing global-shortcut listener picks
   it up unchanged (none check `isTrusted`), so all shortcuts gain iframe
   coverage from one integration point. Do **not** special-case tab
   shortcuts only — that would make tab keys work inside the preview while
   ⌘K doesn't, which reads as broken.

Limitation to document when built: the bridge only covers proxied previews.
A direct cross-origin iframe can't be injected into; focus loss there is a
platform constraint.

## 5. Follow-up: alternative / user-defined bindings (not built)

The combos are hardcoded, but deliberately in one place:
`matchTabShortcut()` in `lib/tab-shortcuts.ts` is the only decision point,
and both consumers (window listener, xterm passthrough) share it. Changing
the scheme — or making it dynamic — touches nothing else.

Sketch for making it configurable:

- Represent a scheme as `{ ctrl, shift, alt, meta }` required-modifier mask;
  `matchTabShortcut` reads the active scheme instead of the platform
  ternary. Persist the choice in per-user settings (`storage.userSettings`,
  keyed like the existing `terminal`/`conversation` UI prefs — e.g. a
  `keybindings` key) so it follows the user across browsers; mirror it into
  `localStorage` so the first paint after login doesn't flash default
  tooltips.
- Offer **vetted presets** rather than free-form capture first: e.g.
  macOS `⌃⇧` (default) / `⌃⌥` (also clean, minus the Rectangle caveat);
  Windows `Ctrl+Alt` (default) / `Alt+Shift` (caveat: bare Alt+Shift is the
  Windows input-language toggle). Free-form recording needs a
  reserved-combo warning list (⌘⇧T, Ctrl+Shift+N, ⌘⇧3/4/5, …) to stop users
  from binding dead keys, which is most of the work.
- `Option+letter` on macOS specifically: interceptable (match on
  `event.code`, preventDefault stops the char), but ⌥E/U/I/N are dead keys
  for accents (⌥E then e = é) and ⌥+letter types symbols on European
  layouts — hijacking ⌥A/⌥E breaks real text entry in chat inputs, which is
  why it isn't the default. As an opt-in preset it's acceptable.
- The tooltip already renders from the scheme (`tabShortcutHint`), so a
  scheme switch updates the UI hints for free.
