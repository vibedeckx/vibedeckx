import type { AgentType } from "../agent-types.js";
import type { AgentProvider } from "../agent-provider.js";
import { ClaudeCodeProvider } from "./claude-code-provider.js";
import { CodexProvider } from "./codex-provider.js";

const providers = new Map<AgentType, AgentProvider>();

// Register built-in providers at module scope
registerProvider(new ClaudeCodeProvider());
registerProvider(new CodexProvider());

export function registerProvider(provider: AgentProvider): void {
  providers.set(provider.getAgentType(), provider);
}

export function getProvider(agentType: AgentType): AgentProvider {
  const provider = providers.get(agentType);
  if (!provider) {
    throw new Error(`No provider registered for agent type: ${agentType}`);
  }
  return provider;
}

export function getAllProviders(): AgentProvider[] {
  return Array.from(providers.values());
}
