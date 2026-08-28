"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isMacPlatform } from "@/lib/tab-shortcuts";
import { shortcutGroups } from "@/lib/shortcut-registry";
import { isEditableTarget } from "@/lib/editable-target";

const noopSubscribe = () => () => {};

// GitHub-style keyboard shortcut reference: `?` toggles it (outside inputs),
// ⌘/ (Ctrl+/) toggles it from anywhere, Esc closes via the Dialog. Content
// comes from lib/shortcut-registry.ts. Also renders its own header icon
// button — `?` needs a discoverable entry point too.
export function KeyboardShortcutsOverlay() {
  const [open, setOpen] = useState(false);
  const isMac = useSyncExternalStore(noopSubscribe, isMacPlatform, () => false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const slashCombo =
        event.key === "/" &&
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey;
      const question =
        event.key === "?" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isEditableTarget(event.target);
      if (!slashCombo && !question) return;
      event.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts (?)"
        onClick={() => setOpen(true)}
      >
        <Keyboard className="h-4 w-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
          </DialogHeader>
          <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            {shortcutGroups(isMac).map((group) => (
              <section key={group.title}>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.title}
                </h3>
                <ul className="space-y-1.5">
                  {group.entries.map((entry) => (
                    <li
                      key={entry.description}
                      className="flex items-center justify-between gap-3 text-[13px]"
                    >
                      <span className="text-foreground/90">{entry.description}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        {entry.hints.map((hint) => (
                          <kbd
                            key={hint}
                            className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] leading-none text-foreground/80"
                          >
                            {hint}
                          </kbd>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
