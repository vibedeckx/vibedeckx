# Agent header chip width stability

Date: 2026-07-27
Status: approved, ready to implement

## Problem

The agent conversation header is a row of chips:

```
[ Claude Code ▾ ][ Default ▾ ][ Plan | Edit ][ Local | Remote ]
```

Both dropdown chips size to their text, so switching agent shifts the whole row:

| chip | Claude Code | Codex | shift |
| --- | --- | --- | --- |
| agent | `Claude Code` | `Codex` | ~30px |
| model | `Default` | `gpt-5.6-codex` | ~37px |

Picking a model inside one agent moves things too (`Default` → `opus`).

## Principle

A control's box should not resize when its content changes. Reserve the width of
the widest label the control can hold; let the text change inside a fixed box.
That is what a native `<select>` does, and it is why nobody reads the empty right
side of a short `<option>` as a defect.

Left-align the label with the chevron at a fixed offset. Centering the
icon+label+chevron group does *not* remove the movement — it converts one box
edge shift into two internal shifts (text moves right, chevron moves left), and
the eye tracks element displacement far more readily than whitespace.

## Design

### 1. `ReservedWidthLabel` (new, `components/ui/reserved-width-label.tsx`)

Renders every candidate label stacked in a single CSS grid cell; the
`aria-hidden`/`invisible` copies hold the cell open at the widest one while the
visible label paints on top.

```tsx
<span className="grid overflow-hidden text-left">
  {unique(candidates).map((c) => (
    <span key={c} aria-hidden className="col-start-1 row-start-1 invisible whitespace-nowrap">{c}</span>
  ))}
  <span className="col-start-1 row-start-1 min-w-0 truncate">{children}</span>
</span>
```

Why this over `min-w-[4.5rem]`:

- adapts when a third provider or model suggestion appears — no number to update
- follows the header's `--conv-font-size` automatically
- no JS measurement, so no first-paint reflow
- `truncate` on the visible layer caps the open-ended case (see model chip)

`aria-hidden` keeps screen readers from reading the label set N+1 times.
Candidates are deduped so React keys stay unique.

### 2. Agent chip (`agent-conversation.tsx`, multi-provider branch)

- wrap the label in `ReservedWidthLabel` with `candidates = providers.map(p => p.displayName)`
- restore the colored `Bot` icon (violet = Claude Code, green = Codex) that today
  only the single-provider branch renders. It anchors the left edge, so the
  varying text length is absorbed between two fixed points, and it restores the
  fastest "who am I talking to" cue for multi-provider users.

```
┌────────────────┐   ┌────────────────┐
│ ● Claude Code ▾│   │ ● Codex       ▾│
└────────────────┘   └────────────────┘
```

Chevron position is constant because the label width is constant — no `ml-auto`
needed.

### 3. Model chip (`model-picker.tsx`)

The model is free text, so there is no closed set to measure. Compose:

- `candidates` = `["Default", ...union of every provider's suggestions]`, passed
  down from `agent-conversation.tsx` as `widthCandidates`. The union (not just
  the active agent's list) is what makes the chip stable *across* agents, which
  is the shift the user actually noticed.
- `max-w-[10rem]` cap + `truncate` + `title` for a long custom model name. A
  typed name is a deliberate one-off; clipping it with the full value on hover
  beats letting one chip stretch the header.

The locked (session-exists) form keeps the chip. Turning it into borderless text
was the third width jump in this row — the box collapsed the moment a session
started. Locking is a change of state, not of control:

- same `CHIP_CLASS` (shared constant, so the two forms cannot drift), same
  reserved slot, same chevron — identical geometry
- greyed to `text-muted-foreground` with `cursor-default` and no `hover:`, which
  is how the header's other chips already signal "not available right now"
  (`agent-conversation.tsx:680`, both mode toggles)
- rendered as a `<span>`, not a `<button disabled>`: disabled controls do not
  dispatch mouse events in most browsers, which would swallow the tooltip — the
  only place the "start a new conversation to change" explanation lives
- not dimmed with `opacity-50`. The other chips' disabled state is temporary and
  their labels stop mattering while it lasts; this one is permanent for the
  session and its label is exactly what you keep glancing at, so it stays
  readable.

## Out of scope

`ExecutionModeToggle`'s >2-target dropdown has the same shape and the same jitter
across remotes. Not touched here; noted as a follow-up.

## Testing

- `reserved-width-label.test.tsx`: one `aria-hidden` sizer per unique candidate,
  duplicates collapsed, visible child rendered once.
- extend `model-picker.test.tsx`: trigger and locked forms both carry a
  `title` with the full model name when it can clip.
- jsdom does not lay out, so width is verified by inspection in the running app,
  not asserted.
