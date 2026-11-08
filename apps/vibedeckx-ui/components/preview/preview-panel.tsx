"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Cloud, ExternalLink, Globe, Monitor, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Hint } from "@/components/ui/hint";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppConfig } from "@/hooks/use-app-config";
import { useProjectRemotesContext } from "@/hooks/project-remotes-context";
import { api, PreviewLinkError, type PreviewLink, type Project } from "@/lib/api";

interface PreviewPanelProps {
  projectId: string | null;
  selectedBranch?: string | null;
  project?: Project | null;
}

const LOCAL_TARGET = "local";

/**
 * Open a preview in a new tab with a fresh one-time sign-in URL.
 *
 * The tab is opened synchronously, inside the click, because the user
 * activation that lets `window.open` through expires while a request is in
 * flight (WebKit: a few seconds, consumed by the first popup). Only then is the
 * ticket minted and the already-open tab navigated to it. `window.open`
 * returns null only when blocked — the `noopener` feature would make it return
 * null always — so the opener is cut by hand. A blocked tab offers a retry
 * that repeats the whole sequence, minting again: tickets are single-use.
 * Must be called synchronously from the user's gesture handler.
 */
function openPreviewTab(mint: () => Promise<string>): Promise<void> {
  const tab = window.open("about:blank", "_blank");
  if (tab) {
    tab.opener = null;
    try {
      tab.document.title = "Opening preview…";
      tab.document.body.textContent = "Opening preview…";
    } catch {
      // Some browsers hand back an opaque window; the blank page is fine.
    }
  }
  return mint().then(
    (url) => {
      if (tab) {
        tab.location.href = url;
        return;
      }
      toast.message("Preview ready", {
        description: "Your browser blocked the new tab.",
        action: {
          label: "Open",
          onClick: () => {
            void openPreviewTab(mint).catch((err) => toast.error(err instanceof Error ? err.message : "Failed to open preview"));
          },
        },
      });
    },
    (err: unknown) => {
      tab?.close();
      throw err;
    },
  );
}

/**
 * The Preview tab (docs/preview-links-design.md): a dev server running on one
 * of the project's machines, opened at its own origin in a new tab. Nothing is
 * embedded here — the preview origin and the app origin are deliberately
 * foreign to each other.
 */
export function PreviewPanel({ projectId, project }: PreviewPanelProps) {
  const { config } = useAppConfig();
  const remotesCtx = useProjectRemotesContext();
  const remotes = remotesCtx?.remotes;
  const enabledOnServer = config?.previewLinks === true;
  const hasLocal = !!project?.path && config?.localProjectsEnabled !== false;

  const [links, setLinks] = useState<PreviewLink[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [targetId, setTargetId] = useState<string>("");
  const [port, setPort] = useState("3000");
  const [busy, setBusy] = useState(false);

  const targets = useMemo(() => {
    const list: Array<{ id: string; name: string; online: boolean | null; local: boolean }> = [];
    if (hasLocal) list.push({ id: LOCAL_TARGET, name: "This machine", online: null, local: true });
    for (const r of remotes ?? []) {
      list.push({ id: r.remote_server_id, name: r.server_name, online: r.status ? r.status === "online" : null, local: false });
    }
    return list;
  }, [hasLocal, remotes]);

  // Default to the first machine; follow the list when the chosen one goes away.
  useEffect(() => {
    if (targets.length === 0) return;
    if (!targets.some((t) => t.id === targetId)) setTargetId(targets[0].id);
  }, [targets, targetId]);

  // The panel stays mounted across project switches, so a slow answer for the
  // previous project can land after the current one's. Every fetch is tagged
  // with the project it was issued for and a generation; only the newest
  // fetch for the project on screen may touch the list.
  const currentProject = useRef(projectId);
  currentProject.current = projectId;
  const requestGen = useRef(0);

  const refresh = useCallback(async () => {
    // A refresh issued for a project that is no longer on screen (a create
    // that finished after a switch) must not fetch, let alone apply.
    if (currentProject.current !== projectId) return;
    const gen = ++requestGen.current;
    const stale = () => gen !== requestGen.current || currentProject.current !== projectId;
    if (!projectId || !enabledOnServer) {
      setLinks([]);
      setLoaded(true);
      return;
    }
    try {
      const result = await api.getPreviewLinks(projectId);
      if (stale()) return;
      setLinks(result.links);
    } catch (err) {
      if (stale()) return;
      console.error("Failed to load preview links:", err);
    } finally {
      if (!stale()) setLoaded(true);
    }
  }, [projectId, enabledOnServer]);

  useEffect(() => {
    // Project switch: the previous project's links are never shown as this one's.
    setLinks([]);
    setLoaded(false);
    void refresh();
  }, [refresh]);

  const handleCreate = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!projectId || !targetId || busy) return;
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      toast.error("Enter a port between 1 and 65535");
      return;
    }
    setBusy(true);
    try {
      // Synchronous up to here: the tab must open inside the submit gesture.
      // Creating is an idempotent upsert, so a retry simply mints again.
      await openPreviewTab(() => api.createPreviewLink(projectId, targetId, portNumber).then((r) => r.authUrl));
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to open preview";
      if (err instanceof PreviewLinkError && err.errorCode === "worker-upgrade-required") {
        toast.error("Worker update needed", { description: message });
      } else {
        toast.error(message);
      }
    } finally {
      setBusy(false);
    }
  }, [projectId, targetId, port, busy, refresh]);

  const handleOpen = useCallback(async (link: PreviewLink) => {
    try {
      await openPreviewTab(() => api.openPreviewLink(link.slug).then((r) => r.authUrl));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to open preview");
    }
  }, []);

  const handleDelete = useCallback(async (link: PreviewLink) => {
    if (!projectId) return;
    try {
      await api.deletePreviewLink(projectId, link.slug);
      setLinks((prev) => prev.filter((l) => l.slug !== link.slug));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove preview link");
    }
  }, [projectId]);

  if (!projectId) {
    return (
      <EmptyState title="Select a project to preview its dev server" />
    );
  }

  if (config && !enabledOnServer) {
    return (
      <EmptyState
        title="Preview links are not set up on this server"
        detail="Start the server with --preview-host (or VIBEDECKX_PREVIEW_HOST) pointing at a wildcard domain that resolves to it. Each preview then opens at its own origin in a new tab."
      />
    );
  }

  return (
    <div className="h-full flex flex-col">
      <form onSubmit={handleCreate} className="flex items-center gap-1.5 border-b px-2 h-10 shrink-0">
        <Select value={targetId} onValueChange={setTargetId} disabled={targets.length === 0}>
          <SelectTrigger size="sm" className="w-[11rem] text-xs" aria-label="Machine">
            <SelectValue placeholder={targets.length === 0 ? "No machines" : "Machine"} />
          </SelectTrigger>
          <SelectContent>
            {targets.map((t) => (
              <SelectItem key={t.id} value={t.id} className="text-xs">
                <span className="flex items-center gap-1.5">
                  {t.local ? <Monitor className="h-3 w-3" /> : <Cloud className="h-3 w-3" />}
                  {t.name}
                  {t.online === false && <span className="text-muted-foreground">(offline)</span>}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">localhost:</span>
        <Input
          value={port}
          onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, ""))}
          inputMode="numeric"
          className="h-8 w-20 text-xs"
          aria-label="Port"
          placeholder="3000"
        />
        <Button type="submit" size="sm" className="text-xs" disabled={busy || !targetId}>
          <ExternalLink className="h-3.5 w-3.5" />
          Open
        </Button>
      </form>

      <div className="flex-1 overflow-y-auto">
        {loaded && links.length === 0 ? (
          <EmptyState
            title="Open a dev server from any of this project's machines"
            detail="Pick the machine the server runs on and its port. The page opens in a new tab at its own address, which you can keep and reopen later, also from your phone."
          />
        ) : (
          <ul className="divide-y">
            {links.map((link) => {
              const target = targets.find((t) => t.id === link.targetId);
              const offline = target?.online === false;
              return (
                <li key={link.slug} className="flex items-center gap-2 px-3 py-2 text-sm">
                  {link.targetId === LOCAL_TARGET
                    ? <Monitor className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    : <Cloud className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate">
                      <span className="font-medium">{link.targetName}</span>
                      <span className="text-muted-foreground"> · localhost:{link.port}</span>
                      {offline && <span className="ml-1.5 text-xs text-muted-foreground">offline</span>}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{link.url}</div>
                  </div>
                  <Hint label="Open in a new tab">
                    <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Open preview" onClick={() => void handleOpen(link)}>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                  </Hint>
                  <Hint label="Remove this preview link">
                    <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Remove preview link" onClick={() => void handleDelete(link)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </Hint>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="h-full flex items-center justify-center text-muted-foreground p-6">
      <div className="flex flex-col items-center gap-2 text-center max-w-sm">
        <Globe className="h-8 w-8 opacity-40" />
        <p className="text-sm">{title}</p>
        {detail && <p className="text-xs leading-relaxed">{detail}</p>}
      </div>
    </div>
  );
}
