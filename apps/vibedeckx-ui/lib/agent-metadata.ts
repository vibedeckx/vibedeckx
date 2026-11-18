import { Bot, type LucideIcon } from "lucide-react";
import type { AgentProviderInfo, AgentType } from "./api";

export const DEFAULT_AGENT_TYPE: AgentType = "claude-code";

interface AgentMetadata {
  displayName: string;
  messageName: string;
  Icon: LucideIcon;
  accentText: string;
  avatarBackground: string;
  branchAccent: string;
}

const AGENT_METADATA: Record<string, AgentMetadata> = {
  "claude-code": {
    displayName: "Claude Code", messageName: "Claude", Icon: Bot,
    accentText: "text-violet-500", avatarBackground: "bg-violet-500/10",
    branchAccent: "bg-violet-500/10 text-violet-600",
  },
  codex: {
    displayName: "Codex", messageName: "Codex", Icon: Bot,
    accentText: "text-green-500", avatarBackground: "bg-green-500/10",
    branchAccent: "bg-emerald-500/10 text-emerald-600",
  },
};

/** Unknown providers keep their server name and never inherit another agent's identity. */
export function getAgentMetadata(type: string, providers: readonly AgentProviderInfo[] = []): AgentMetadata {
  const known = Object.hasOwn(AGENT_METADATA, type) ? AGENT_METADATA[type] : undefined;
  const displayName = providers.find((p) => p.type === type)?.displayName ?? known?.displayName ?? type;
  return known ? { ...known, displayName } : {
    displayName, messageName: displayName, Icon: Bot,
    accentText: "text-muted-foreground", avatarBackground: "bg-muted",
    branchAccent: "bg-muted text-muted-foreground",
  };
}
