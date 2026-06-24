"use client";

import { useEffect, useState } from "react";
import { useConnectionStatus } from "@/hooks/global-event-stream";

function formatAgo(ts: number | null): string {
  if (ts === null) return "尚未连接";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  return `${Math.floor(m / 60)} 小时前`;
}

/**
 * Header indicator for the shared `/api/events` live stream. Quiet by design:
 * a small emerald dot when live (or a muted pulsing dot while connecting), and
 * an amber, clickable "disconnected" pill when the stream goes stale (a
 * silently-dead socket the watchdog caught) — clicking it forces a reconnect.
 *
 * The point is to turn a *silent* failure (no completion notifications arrive,
 * user assumes nothing finished) into a *visible* one with a one-click remedy.
 */
export function ConnectionStatusIndicator() {
  const { state, lastEventAt, reconnect } = useConnectionStatus();

  // Keep the relative "last update" label current without depending on new
  // events (a stale stream sends nothing, so it wouldn't re-render otherwise).
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, []);

  if (state === "stale") {
    return (
      <button
        type="button"
        onClick={reconnect}
        title={`实时更新已断开 · 上次更新 ${formatAgo(lastEventAt)} · 点击重新连接`}
        className="flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 transition-colors hover:bg-amber-500/20"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
        实时更新已断开
      </button>
    );
  }

  const isLive = state === "live";
  return (
    <span
      title={
        isLive
          ? `实时更新正常 · 上次更新 ${formatAgo(lastEventAt)}`
          : "正在连接实时更新…"
      }
      className="flex items-center px-1"
      aria-label={isLive ? "实时更新正常" : "正在连接实时更新"}
    >
      <span
        className={
          isLive
            ? "h-1.5 w-1.5 rounded-full bg-emerald-500"
            : "h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/40"
        }
      />
    </span>
  );
}
