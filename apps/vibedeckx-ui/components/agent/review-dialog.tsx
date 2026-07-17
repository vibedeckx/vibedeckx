"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import { SearchCheck } from "lucide-react";

export function ReviewDialog({
  projectId,
  branch,
  sessionId,
}: {
  projectId: string;
  branch: string | null;
  sessionId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!sessionId) return null;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createWorkflowRun({
        projectId,
        branch,
        sourceSessionId: sessionId,
        reviewFocus: focus.trim() || undefined,
      });
      setOpen(false);
      setFocus("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" title="让另一个 agent review 这个 session 的最新成果">
          <SearchCheck className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>发起 Review</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          将创建一个 reviewer session 审查本 session 最近完成的工作。反馈会先经你确认，再发回本 session。
        </p>
        <input
          className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
          placeholder="Review focus（可选）：本次审查重点…"
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button onClick={start} disabled={busy}>开始 Review</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
