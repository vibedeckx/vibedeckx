"use client";

import { useCallback, useState } from "react";
import { Loader2, Server, X } from "lucide-react";
import {
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import { api, type RemoteServer, type SessionRemoteGrant } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * "Allow remote access": the composer's entry to per-session cross-remote
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
      .then(setServers)
      .catch(() => setLoadError(true));
  }, []);

  // The session's own machine is refused by the grant API (and by the gateway
  // before it), so offering it would only turn a tick into a failed send.
  const eligible = (servers ?? [])
    .filter((s) => s.cross_remote_access !== "off")
    .filter((s) => s.id !== sourceRemoteId);

  return (
    <DropdownMenuSub onOpenChange={(open) => { if (open) load(); }}>
      <DropdownMenuSubTrigger disabled={disabled}>
        <Server className="mr-2 size-4" />
        Allow remote access
        {granted.length > 0 && (
          <span className="ml-2 text-xs text-muted-foreground">{granted.length}</span>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-72 w-64 overflow-y-auto">
        {servers === null && !loadError && (
          <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Loading machines…
          </div>
        )}
        {loadError && (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">
            Could not load remote machines.
          </div>
        )}
        {servers !== null && !loadError && eligible.length === 0 && (
          // The entry stays even with nothing to offer: it is where a user
          // learns the capability exists, and it names the missing step.
          <div className="px-2 py-1.5 text-sm text-muted-foreground">
            No machine has cross-remote access enabled. Turn it on for a machine
            in Settings → Remote Servers.
          </div>
        )}
        {eligible.map((server) => {
          const isGranted = granted.some((g) => g.id === server.id);
          return (
            <DropdownMenuCheckboxItem
              key={server.id}
              checked={isGranted}
              // Keep the menu open: granting two machines should take two
              // clicks, not two trips through the menu.
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(checked) => onToggle({
                id: server.id,
                name: server.name,
                access: server.cross_remote_access,
                online: server.status === "online",
              }, checked === true)}
            >
              <span className="truncate">{server.name}</span>
              <span className="ml-auto flex items-center gap-1.5 pl-2">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {server.cross_remote_access}
                </span>
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    server.status === "online" ? "bg-emerald-500" : "bg-muted-foreground/40",
                  )}
                  title={server.status === "online" ? "Online" : "Offline"}
                />
              </span>
            </DropdownMenuCheckboxItem>
          );
        })}
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
          title={`Cross-remote ${server.access} access${server.online ? "" : " — machine is offline"}`}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
            "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20",
          )}
        >
          <Server className="size-3" />
          {server.name}
          <span className="opacity-70">{server.access}</span>
          {/* Offline is shown, but never revokes: the machine coming back
              should not require the user to grant it again. */}
          {!server.online && <span className="opacity-70">offline</span>}
          <X className="size-3" />
        </button>
      ))}
    </div>
  );
}
