"use client";

import { useState, type ReactNode } from "react";
import { Pencil, Plus, Zap } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command as CommandRoot,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Hint } from "@/components/ui/hint";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { CommandDialog } from "./command-dialog";
import type { Command } from "@/lib/api";

interface CommandsMenuProps {
  commands: Command[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Sending is blocked (chat still connecting, or a reply is streaming). */
  disabled?: boolean;
  onExecute: (content: string) => void;
  onCreate: (opts: { name: string; content: string }) => Promise<Command | null>;
  onUpdate: (id: string, opts: { name?: string; content?: string }) => Promise<Command | null>;
  onDelete: (id: string) => Promise<void>;
  /** Where focus goes when the menu closes — the composer, so typing resumes there. */
  onCloseFocus?: () => void;
}

/**
 * The composer's saved-prompt picker: a ⚡ button at the composer's left edge
 * opening a searchable list where one click sends the command. The label
 * shows only when the composer is wide enough (container query on the row
 * that holds it); narrow, it is the icon plus a tooltip. The composer also
 * opens it on "/" in an empty draft.
 */
export function CommandsMenu({
  commands,
  open,
  onOpenChange,
  disabled,
  onExecute,
  onCreate,
  onUpdate,
  onDelete,
  onCloseFocus,
}: CommandsMenuProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCommand, setEditingCommand] = useState<Command | null>(null);
  const [query, setQuery] = useState("");

  const openDialog = (command: Command | null) => {
    onOpenChange(false);
    setEditingCommand(command);
    setDialogOpen(true);
  };

  const handleSave = async (data: { name: string; content: string }) => {
    if (editingCommand) {
      await onUpdate(editingCommand.id, data);
    } else {
      await onCreate(data);
    }
  };

  let trigger: ReactNode = (
    <PromptInputButton
      className="ml-1 gap-1.5"
      size="sm"
      aria-label="Commands"
      disabled={disabled}
    >
      <Zap className="size-4" />
      <span className="hidden @md:inline">Commands</span>
    </PromptInputButton>
  );
  // A disabled button gets no hover events — the tooltip needs a wrapper.
  if (disabled) trigger = <span className="inline-flex">{trigger}</span>;

  return (
    <>
      <Popover
        open={open && !disabled}
        onOpenChange={(next) => {
          if (!next) setQuery("");
          onOpenChange(next);
        }}
      >
        <Hint label="Commands (/)" side="top">
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        </Hint>
        <PopoverContent
          side="top"
          align="start"
          className="w-72"
          onCloseAutoFocus={(e) => {
            if (!onCloseFocus || dialogOpen) return;
            e.preventDefault();
            onCloseFocus();
          }}
        >
          <CommandRoot>
            <CommandInput placeholder="Search commands…" value={query} onValueChange={setQuery} />
            <CommandList className="max-h-64">
              <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">
                {commands.length === 0 ? "No commands yet." : "No matching commands."}
              </CommandEmpty>
              {commands.length > 0 && (
                // A CommandGroup, not a plain div: cmdk re-sorts matches by
                // moving item nodes within their group as the query changes.
                <CommandGroup>
                  {commands.map((command) => (
                    <CommandItem
                      key={command.id}
                      // cmdk filters on value; the id keeps same-named commands distinct.
                      value={`${command.name} ${command.id}`}
                      keywords={[command.content]}
                      onSelect={() => {
                        onOpenChange(false);
                        onExecute(command.content);
                      }}
                      className="group gap-2"
                    >
                      <span className="flex-1 truncate">{command.name}</span>
                      <button
                        type="button"
                        aria-label={`Edit ${command.name}`}
                        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 group-data-[selected=true]:opacity-100"
                        // The row sends on click; editing must not.
                        onClick={(e) => {
                          e.stopPropagation();
                          openDialog(command);
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                      >
                        <Pencil className="size-3.5" />
                      </button>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </CommandRoot>
          <div className="flex items-center justify-between gap-2 border-t px-2 py-1.5">
            <button
              type="button"
              onClick={() => openDialog(null)}
              className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Plus className="size-3.5" />
              New command
            </button>
            <span className="text-[11px] text-muted-foreground">
              Type <kbd className="rounded border px-1 font-mono">/</kbd> to open
            </span>
          </div>
        </PopoverContent>
      </Popover>
      <CommandDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        command={editingCommand}
        onSave={handleSave}
        onDelete={async (id) => { await onDelete(id); }}
      />
    </>
  );
}
