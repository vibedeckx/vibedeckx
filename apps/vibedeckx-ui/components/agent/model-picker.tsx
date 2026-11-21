"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Info, RefreshCw } from "lucide-react";
import { useCommandState } from "cmdk";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Hint } from "@/components/ui/hint";
import { ReservedWidthLabel } from "@/components/ui/reserved-width-label";
import { cn } from "@/lib/utils";

interface ModelPickerProps {
  /** Suggestions only — free text is always allowed. */
  models: string[];
  /**
   * Labels to hold the chip open for — every agent's suggestions, not just this
   * agent's. Reserving only the active agent's names would keep the chip steady
   * while picking a model but still resize it on every agent switch, which is
   * the shift that actually shows up in the header row.
   */
  widthCandidates?: string[];
  /** null = no choice here; the CLI keeps its own. See DEFAULT_HINT. */
  value: string | null;
  onChange: (model: string | null) => void;
  /**
   * true while a turn is in flight on a session that has history. The model is
   * a spawn argument, so it cannot reach a process that is already running —
   * the chip becomes static text rather than a disabled control, which would
   * still look clickable. Everywhere else (no session yet, a branch, a stopped
   * session) the next turn spawns a fresh process, so the pick is live.
   */
  locked: boolean;
  /** Fired each time the panel opens, so the caller can revalidate `models`. */
  onOpen?: () => void;
  /**
   * Re-reads the list from the machine's CLI. The list is cached and rarely
   * changes, so this is the user's way to pick up a CLI upgrade or a login
   * switch. No button without it.
   */
  onRefresh?: () => void;
  /** A refresh is in flight: the button spins and is disabled. */
  refreshing?: boolean;
}

const DEFAULT_LABEL = "Default";

/**
 * "Default" is the easiest entry to misread: it looks like it names a model the
 * CLI falls back to, when in fact it names the absence of a choice here — the
 * CLI keeps whatever model it is already set to, which may be one the user
 * picked there and not the CLI's built-in one. The hint says what happens, not
 * how: the reader is choosing a model, not reading about the spawn arguments.
 */
const DEFAULT_HINT =
  "Runs whatever model the CLI is currently set to, which may not be its built-in default.";

/**
 * Shared by the live and locked forms so their geometry cannot drift. Locking is
 * a change of state, not of control: the box, padding and reserved label width
 * stay put, and only the colour and the click behaviour differ.
 */
const CHIP_CLASS =
  "inline-flex items-center gap-1 rounded-md border bg-muted/50 px-2 py-0.5 text-xs font-medium";

/**
 * The chip always shows something, even with no model chosen — a blank slot
 * would read as "this build has no model feature" rather than "this session
 * uses the CLI default".
 */
export function modelLabel(value: string | null): string {
  return value ?? DEFAULT_LABEL;
}

/**
 * Query-driven widening: at the collapsed chip's width the panel reads as that
 * chip expanding, and widens only once the typed name no longer fits the search
 * field. Only the query is measured here; a list of long suggestion names opens
 * the panel wider on its own (needsRoomyPanel), and this does not apply then.
 *
 * Both measurements are independent of the panel's current width — the mirrored
 * text width and the field width recorded while narrow — so the decision cannot
 * oscillate the way `input.scrollWidth > input.clientWidth` would once widening
 * has removed the overflow it was reacting to.
 *
 * A CSS `w-fit` cannot express this: an `<input>` carries an intrinsic width of
 * about twenty characters, so fit-content would always resolve wide and the
 * default would never match the chip.
 */
export function shouldWidenPanel(m: {
  /** Rendered width of the query in the field's own font. */
  textWidth: number;
  /** Field width while the panel sits at chip width; 0 until measured. */
  narrowFieldWidth: number;
  /** Current state, kept when there is nothing to measure yet. */
  wide: boolean;
}): boolean {
  if (m.narrowFieldWidth <= 0) return m.wide;
  return m.textWidth > m.narrowFieldWidth;
}

/**
 * Suggestions are not a whitelist, so any string the user types is offerable —
 * except one that is blank or already in the list.
 */
export function shouldOfferCustom(query: string, models: string[]): boolean {
  const trimmed = query.trim();
  return trimmed.length > 0 && !models.includes(trimmed);
}

/**
 * Suggestions this long don't fit a chip-width panel on one line — a machine
 * catalog like fx's (`anthropic/claude-opus-5.5-fast`). The panel then opens
 * at ROOMY_PANEL instead: ~35 characters, which fits ~96% of fx's catalog
 * whole (median 21, max 43). Wider would only add blank space to every row
 * for the last few names, which keep their full name in a tooltip.
 */
const ROOMY_NAME_CHARS = 18;
const ROOMY_PANEL = "w-60";

export function needsRoomyPanel(models: string[]): boolean {
  return models.some((m) => m.length > ROOMY_NAME_CHARS);
}

/**
 * One suggestion, on one line. Model names share long prefixes and differ at
 * the end, so a clipped row shows its full name in a tooltip while it is the
 * highlighted row. Highlight, not hover: cmdk keeps focus in the search field
 * and moves the highlight with the arrow keys (and with the pointer), so this
 * is the one state both keyboard and mouse users reach.
 */
function ModelRow({ model, onPick }: { model: string; onPick: () => void }) {
  const highlighted = useCommandState((state) => state.value === model);
  const textRef = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  // Measured when the row becomes the highlighted one, so rows that fit never
  // get a tooltip and an idle list of 265 rows measures nothing.
  useLayoutEffect(() => {
    const text = textRef.current;
    if (highlighted && text) setClipped(text.scrollWidth > text.clientWidth);
  }, [highlighted, model]);
  return (
    <CommandItem value={model} onSelect={onPick} className="text-xs">
      {/* Around the text, not the row: a tooltip trigger would take over the
          row's own data-slot. A clipped span fills the row's width anyway. */}
      <Hint label={clipped ? model : null} side="right" identifier open={highlighted && clipped}>
        <span ref={textRef} className="min-w-0 truncate">
          {model}
        </span>
      </Hint>
    </CommandItem>
  );
}

/** Whether the chip's visible label (ReservedWidthLabel's truncating span) is cut off. */
function isClipped(chip: HTMLElement): boolean {
  const text = chip.querySelector<HTMLElement>(".truncate");
  return !!text && text.scrollWidth > text.clientWidth;
}

export function ModelPicker({
  models,
  widthCandidates,
  value,
  onChange,
  locked,
  onOpen,
  onRefresh,
  refreshing = false,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [wide, setWide] = useState(false);
  const [clipped, setClipped] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const mirrorRef = useRef<HTMLSpanElement>(null);
  /**
   * The search field's width while the panel is at chip width. Read from the DOM
   * rather than derived from a character count: the chip's own width comes from
   * whatever `widthCandidates` holds at runtime, in whatever font the header is
   * rendering, and "iiiiiiiiii" is not "WWWWWWWWWW".
   */
  const narrowFieldWidth = useRef(0);
  const roomy = needsRoomyPanel(models);

  useLayoutEffect(() => {
    const input = inputRef.current;
    const mirror = mirrorRef.current;
    if (!input || !mirror) return;
    // Only meaningful while narrow — re-read on every pass so a resize or a
    // font-size change is picked up instead of cached from first open. A roomy
    // panel's field is not the narrow field: recording it would let a later
    // switch back to chip width (a refresh that returns only short names) keep
    // a query that no longer fits. This effect re-runs when `roomy` flips, and
    // then records the real narrow field before deciding.
    if (!wide && !roomy) narrowFieldWidth.current = input.clientWidth;
    setWide(
      shouldWidenPanel({
        textWidth: mirror.offsetWidth,
        narrowFieldWidth: narrowFieldWidth.current,
        wide,
      }),
    );
  }, [open, query, wide, roomy]);

  const label = modelLabel(value);
  // A hand-typed name can be arbitrarily long, so the reserved slot is capped
  // and clips rather than letting one chip stretch the whole header row. The
  // tooltip carries the full value in that case.
  const slot = [DEFAULT_LABEL, ...(widthCandidates ?? models)];

  if (locked) {
    return (
      // A <span>, not a disabled <button>: disabled controls do not dispatch
      // mouse events in most browsers, which would swallow the tooltip — the
      // only place the "start a new conversation" explanation lives. Greying it
      // out is the affordance; there is nothing to click.
      // Names the one condition that has to clear, not an action to take:
      // the turn ending is enough, and telling the user to stop the agent
      // would trade their in-flight work for a change they can make a moment
      // later for free.
      <Hint label={`${label} — fixed while the agent is running, changeable once the turn ends`}>
        <span
          data-model-chip="locked"
          className={cn(CHIP_CLASS, "text-muted-foreground cursor-default")}
        >
          <ReservedWidthLabel candidates={slot} className="max-w-40">
            {label}
          </ReservedWidthLabel>
          <ChevronDown className="h-3 w-3" />
        </span>
      </Hint>
    );
  }

  const trimmed = query.trim();
  const showCustom = shouldOfferCustom(query, models);

  const pick = (model: string | null) => {
    onChange(model);
    setQuery("");
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) onOpen?.();
      }}
    >
      {/* Only once the label clips: otherwise the bubble just repeats the chip. */}
      <Hint label={clipped ? label : null}>
        <PopoverTrigger asChild>
          <button
            className={cn(CHIP_CLASS, "transition-colors hover:bg-muted")}
            // Measured on the way in, ahead of the tooltip's delay: whether
            // the name fits depends on the reserved slot, not on its length.
            onPointerEnter={(e) => setClipped(isClipped(e.currentTarget))}
            onFocus={(e) => setClipped(isClipped(e.currentTarget))}
          >
            <ReservedWidthLabel candidates={slot} className="max-w-40">
              {label}
            </ReservedWidthLabel>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
      </Hint>
      {/* Same width as the collapsed chip, so the panel reads as that chip
          opening rather than as a separate surface. The reserved label slot makes
          that width constant, so it does not move with the choice — it only
          widens when a typed name needs the room, or when the suggestions
          themselves are long names (a machine catalog; see needsRoomyPanel). */}
      {/* No width transition: the measurement below reads the field's width, and
          an animating width would be caught mid-flight. */}
      <PopoverContent
        className={
          roomy ? ROOMY_PANEL : wide ? "w-56" : "w-[var(--radix-popover-trigger-width)]"
        }
      >
        {/* Renders the query in the field's own font, out of flow, so its width
            can be compared against the field's without the panel's current width
            feeding back into the comparison. */}
        <span
          ref={mirrorRef}
          aria-hidden
          className="pointer-events-none invisible absolute whitespace-pre text-sm"
        >
          {query}
        </span>
        <Command shouldFilter>
          <CommandInput
            ref={inputRef}
            // An <input> is intrinsically ~20 characters wide; without this it
            // would push the fixed-width panel wider from the inside.
            className="min-w-0"
            value={query}
            onValueChange={setQuery}
          />
          {/* Lower than the default 300px: a long catalog would otherwise
              hang the panel far down over the conversation. ~8 one-line rows. */}
          <CommandList className="max-h-52">
            {/* Short enough not to wrap at this width. */}
            <CommandEmpty>No match.</CommandEmpty>
            <CommandGroup>
              <CommandItem value={DEFAULT_LABEL} onSelect={() => pick(null)} className="text-xs">
                {DEFAULT_LABEL}
                {/* Mouse-only by design: cmdk keeps focus in the search field,
                    so the icon can never be tabbed to. The sr-only copy below
                    carries the same sentence for anyone not hovering. It does
                    not disturb filtering — this item matches on its `value`,
                    not on its text. */}
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        // A <span>, since a nested <button> inside the row would
                        // be a second focus stop cmdk cannot reach anyway.
                        // Stopping the click keeps "read the note" from also
                        // meaning "choose this and close the panel".
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                        className="ml-auto flex cursor-help items-center text-muted-foreground"
                      >
                        {/* `size-3`, not `h-3 w-3`: CommandItem force-sizes
                            any icon whose class list has no `size-` in it. */}
                        <Info aria-hidden className="size-3" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-56">
                      {DEFAULT_HINT}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <span className="sr-only">{DEFAULT_HINT}</span>
              </CommandItem>
              {models.map((m) => (
                <ModelRow key={m} model={m} onPick={() => pick(m)} />
              ))}
            </CommandGroup>
            {showCustom && (
              // Suggestions are not a whitelist: whether a name works depends
              // on the CLI version and account tier of the machine that spawns
              // the session, so any string is allowed through.
              <CommandGroup heading="Custom">
                {/* Truncated rather than wrapped: the full string is in the
                    search field directly above, where the user just typed it. */}
                <CommandItem
                  value={trimmed}
                  onSelect={() => pick(trimmed)}
                  className="text-xs [&>span]:truncate"
                  title={trimmed}
                >
                  <span>Use &quot;{trimmed}&quot;</span>
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
        {onRefresh && (
          // Outside the Command: a CommandItem would be filtered by the query
          // and picked by Enter, and this is neither a model nor a choice.
          <div className="border-t p-1">
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-60"
            >
              <RefreshCw aria-hidden className={cn("h-3 w-3", refreshing && "animate-spin")} />
              {refreshing ? "Refreshing…" : "Refresh list"}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
