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
import { cn } from "@/lib/utils";
import type { AgentType } from "@/lib/api";

interface ModelPickerProps {
  agentType: AgentType;
  /** Suggestions only — free text is always allowed. */
  models: string[];
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

export function ModelPicker({ agentType, models, value, onChange, locked }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const label = modelLabel(value);

  if (locked) {
    return (
      <span
        className="text-xs text-muted-foreground px-1"
        title="Fixed for this session — branch to change"
      >
        {label}
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
          className={cn(
            "inline-flex items-center gap-1 rounded-md border bg-muted/50 px-2 py-0.5",
            "text-xs font-medium transition-colors hover:bg-muted",
          )}
        >
          {label}
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
