"use client";

import { useCallback, useState } from "react";
import { Eye, Loader2, Server, Settings2, SquareTerminal, X } from "lucide-react";
import {
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { api, type RemoteServer, type SessionRemoteGrant } from "@/lib/api";
import { buildUrl } from "@/lib/url-state";
import { cn } from "@/lib/utils";

/**
 * "Remote access": the composer's entry to per-session cross-remote
 * grants (docs/cross-remote-session-grants-design.md §8). It is also how the
 * feature is discovered at all — an agent reaches no other machine until a
 * user ticks one here.
 */
export function RemoteAccessMenuItem({
  granted,
  onToggle,
  sourceRemoteId,
  disabled,
}: {
  granted: SessionRemoteGrant[];
  onToggle: (server: SessionRemoteGrant, grant: boolean) => void;
  /** The machine this session runs on, when it runs on one. Never a target. */
  sourceRemoteId?: string;
  disabled?: boolean;
}) {
  const [servers, setServers] = useState<RemoteServer[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  // Fetched when the submenu opens, and refetched on each open so a tier the
  // user just changed in Settings shows up. The composer mounts on every
  // workspace switch; loading eagerly would spend a request per mount on a
  // menu most users never open.
  const load = useCallback(() => {
    setLoadError(false);
    api.getRemoteServers()
      // Online machines first, sorted once per open: rows that moved while
      // the user toggles them would read as the click landing elsewhere.
      .then((list) => setServers(
        [...list].sort((a, b) => Number(b.status === "online") - Number(a.status === "online")),
      ))
      .catch(() => setLoadError(true));
  }, []);

  // The session's own machine is refused by the grant API (and by the gateway
  // before it), so offering it would only turn a tick into a failed send.
  const eligible = (servers ?? [])
    .filter((s) => s.cross_remote_access !== "off")
    .filter((s) => s.id !== sourceRemoteId);

  const openRemoteServers = () => {
    window.history.pushState(null, "", buildUrl({ tab: "remote-servers" }));
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  return (
    <DropdownMenuSub onOpenChange={(open) => { if (open) load(); }}>
      <DropdownMenuSubTrigger disabled={disabled}>
        <Server className="mr-2 size-4" />
        Remote access
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64 p-1">
        <div className="px-2 pt-1.5 pb-2">
          <div className="text-sm font-medium">Remote access</div>
          <div className="text-xs text-muted-foreground">
            Machines this agent can reach
          </div>
        </div>
        <DropdownMenuSeparator />
        <div className="max-h-72 overflow-y-auto">
          {servers === null && !loadError && (
            <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Loading machines…
            </div>
          )}
          {loadError && (
            <div className="px-2 py-3 text-sm text-muted-foreground">
              Could not load remote machines.
            </div>
          )}
          {servers !== null && !loadError && eligible.length === 0 && (
            // The entry stays even with nothing to offer: it is where a user
            // learns the capability exists, and it names the missing step.
            <div className="flex flex-col items-center gap-2 px-4 py-5 text-center">
              <div className="flex size-9 items-center justify-center rounded-full bg-muted">
                <Server className="size-4 text-muted-foreground" />
              </div>
              <div className="text-sm font-medium">No machines available</div>
              <div className="text-xs text-muted-foreground">
                Enable cross-remote access for a machine in Remote Servers.
              </div>
            </div>
          )}
          {eligible.map((server) => {
            const isGranted = granted.some((g) => g.id === server.id);
            const online = server.status === "online";
            const exec = server.cross_remote_access === "exec";
            return (
              <DropdownMenuItem
                key={server.id}
                role="menuitemcheckbox"
                aria-checked={isGranted}
                // Keep the menu open: granting two machines should take two
                // clicks, not two trips through the menu.
                onSelect={(e) => {
                  e.preventDefault();
                  onToggle({
                    id: server.id,
                    name: server.name,
                    access: server.cross_remote_access,
                    online,
                  }, !isGranted);
                }}
                className="gap-3 py-2"
              >
                <span className="relative flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/40">
                  <Server className="size-4" />
                  <span
                    className={cn(
                      "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-popover",
                      online ? "bg-emerald-500" : "bg-muted-foreground/50",
                    )}
                    title={online ? "Online" : "Offline"}
                  />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{server.name}</span>
                  {/* One line, always: a wrapped tier label turns every row
                      into three and the list stops scanning as a list. */}
                  <span className="flex min-w-0 items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
                    {exec ? (
                      <span className="flex min-w-0 items-center gap-1 text-amber-600 dark:text-amber-400">
                        <SquareTerminal className="size-3" />
                        <span className="truncate">Run commands</span>
                      </span>
                    ) : (
                      <span className="flex min-w-0 items-center gap-1">
                        <Eye className="size-3" />
                        <span className="truncate">Read only</span>
                      </span>
                    )}
                  </span>
                </span>
                {/* A switch, not a check: this row grants something, it does
                    not pick an option. Purely visual — the row is the control. */}
                <span
                  aria-hidden
                  className={cn(
                    "relative inline-flex h-4.5 w-8 shrink-0 items-center rounded-full transition-colors",
                    isGranted ? "bg-emerald-500" : "bg-muted-foreground/25",
                  )}
                >
                  <span
                    className={cn(
                      "size-3.5 rounded-full bg-white shadow-sm transition-transform",
                      isGranted ? "translate-x-4" : "translate-x-0.5",
                    )}
                  />
                </span>
              </DropdownMenuItem>
            );
          })}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={openRemoteServers} className="text-muted-foreground">
          <Settings2 className="size-4" />
          Manage machines…
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * What the next turn may reach, each revocable by its own ✕.
 *
 * A declaration, not a status: taking one off while a turn is running says
 * how the turn AFTER it should run, and does not touch the one in flight.
 * What a turn actually ran under is on its own message, in the transcript.
 */
export function RemoteAccessChips({
  granted,
  onRevoke,
}: {
  granted: SessionRemoteGrant[];
  onRevoke: (server: SessionRemoteGrant) => void;
}) {
  if (granted.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 pl-12 pr-2 pt-1.5 pb-0.5">
      {granted.map((server) => (
        <button
          key={server.id}
          type="button"
          onClick={() => onRevoke(server)}
          title={`Cross-remote ${server.access} access · ${server.online ? "online" : "offline"}`}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
            "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20",
          )}
        >
          {/* Offline is shown, but never revokes: the machine coming back
              should not require the user to grant it again. */}
          <span className="relative flex">
            <Server className="size-3" />
            <span
              className={cn(
                "absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-1 ring-background",
                server.online ? "bg-emerald-500" : "bg-muted-foreground/60",
              )}
            />
          </span>
          {server.name}
          <X className="size-3" />
        </button>
      ))}
    </div>
  );
}
