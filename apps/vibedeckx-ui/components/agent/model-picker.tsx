"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ReservedWidthLabel } from "@/components/ui/reserved-width-label";
import { cn } from "@/lib/utils";
import type { AgentType } from "@/lib/api";

interface ModelPickerProps {
  agentType: AgentType;
  /** Suggestions only — free text is always allowed. */
  models: string[];
  /**
   * Labels to hold the chip open for — every agent's suggestions, not just this
   * agent's. Reserving only the active agent's names would keep the chip steady
   * while picking a model but still resize it on every agent switch, which is
   * the shift that actually shows up in the header row.
   */
  widthCandidates?: string[];
  /** null = use the agent CLI's own default. */
  value: string | null;
  onChange: (model: string | null) => void;
  /**
   * true once the session exists. The model is a spawn argument, so it cannot
   * change for a live session — the chip becomes static text rather than a
   * disabled control, which would still look clickable.
   */
  locked: boolean;
}

const DEFAULT_LABEL = "Default";

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
 * Suggestions are not a whitelist, so any string the user types is offerable —
 * except one that is blank or already in the list.
 */
export function shouldOfferCustom(query: string, models: string[]): boolean {
  const trimmed = query.trim();
  return trimmed.length > 0 && !models.includes(trimmed);
}

export function ModelPicker({
  agentType,
  models,
  widthCandidates,
  value,
  onChange,
  locked,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
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
      <span
        className={cn(CHIP_CLASS, "text-muted-foreground cursor-default")}
        // Not "branch to change": branching is the one action that cannot
        // change the model. branchSession copies the parent's model and takes
        // no override, and the branch is locked the moment it exists. A new
        // conversation is the only place the picker is live.
        title={`${label} — fixed for this session, start a new conversation to change`}
      >
        <ReservedWidthLabel candidates={slot} className="max-w-40">
          {label}
        </ReservedWidthLabel>
        <ChevronDown className="h-3 w-3" />
      </span>
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(CHIP_CLASS, "transition-colors hover:bg-muted")}
          // Only useful once the label clips; harmless otherwise.
          title={label}
        >
          <ReservedWidthLabel candidates={slot} className="max-w-40">
            {label}
          </ReservedWidthLabel>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56">
        <Command shouldFilter>
          <CommandInput
            placeholder={`Model for ${agentType === "codex" ? "Codex" : "Claude Code"}…`}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>No suggestion matches.</CommandEmpty>
            <CommandGroup>
              <CommandItem value={DEFAULT_LABEL} onSelect={() => pick(null)} className="text-xs">
                {DEFAULT_LABEL}
              </CommandItem>
              {models.map((m) => (
                <CommandItem key={m} value={m} onSelect={() => pick(m)} className="text-xs">
                  {m}
                </CommandItem>
              ))}
            </CommandGroup>
            {showCustom && (
              // Suggestions are not a whitelist: whether a name works depends
              // on the CLI version and account tier of the machine that spawns
              // the session, so any string is allowed through.
              <CommandGroup heading="Custom">
                <CommandItem value={trimmed} onSelect={() => pick(trimmed)} className="text-xs">
                  Use &quot;{trimmed}&quot;
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
