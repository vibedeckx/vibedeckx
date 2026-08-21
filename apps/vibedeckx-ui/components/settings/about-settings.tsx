'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { UI_BUILD_ID, useConnectionStatus } from '@/hooks/global-event-stream';

// Diagnostic surface for version skew: shows the build this tab was born from
// next to the build the server currently serves (from the SSE hello frame).
// When they diverge the mismatch is visible right here — a bug-report
// screenshot answers "which build are you on?" without asking.
function BuildRow({ label, value }: { label: string; value: string | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      <span className="flex items-center gap-1 min-w-0">
        <code className="text-xs font-mono truncate">{value ?? '—'}</code>
        {value && (
          <button
            type="button"
            title="复制"
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            onClick={() => {
              void navigator.clipboard.writeText(value).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
          </button>
        )}
      </span>
    </div>
  );
}

export function AboutSettings() {
  const { serverBuildId, updateAvailable } = useConnectionStatus();
  const inSync = UI_BUILD_ID !== null && serverBuildId !== null && UI_BUILD_ID === serverBuildId;

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border divide-y divide-border px-3">
        <BuildRow label="UI build" value={UI_BUILD_ID} />
        <BuildRow label="Server build" value={serverBuildId} />
      </div>

      {inSync && (
        <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
          <Check className="h-4 w-4 shrink-0" />
          当前已是最新版本
        </div>
      )}

      {updateAvailable && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-sky-500/40 bg-sky-500/10 p-3">
          <span className="text-sm text-sky-700 dark:text-sky-400">
            服务器已更新到新版本，刷新页面即可加载。
          </span>
          <Button size="sm" onClick={() => window.location.reload()}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            刷新
          </Button>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        构建指纹在构建时取自 git 提交号，用于检测浏览器中的 UI 与服务器提供的 UI 是否为同一次构建。报告问题时请附上以上信息。
      </p>
    </div>
  );
}
