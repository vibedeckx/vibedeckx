// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@/lib/api";
import type { SettingsNavItem } from "./settings-shell";

// Mutable config the mocked useAppConfig() reports. `null` reproduces the
// null first frame every fresh useAppConfig() instance renders before its
// effect runs.
const appConfigState = vi.hoisted(() => ({ config: null as AppConfig | null }));
// What the synchronous seed (AuthWrapper's already-resolved, persisted config)
// returns. SettingsView only mounts after AuthWrapper resolved, so this is the
// authoritative first-frame value.
const persistedState = vi.hoisted(() => ({ config: null as AppConfig | null }));

vi.mock("@/hooks/use-app-config", () => ({
  useAppConfig: () => ({ config: appConfigState.config, loading: false }),
}));

vi.mock("@/lib/api", () => ({
  getPersistedConfig: () => persistedState.config,
}));

vi.mock("@/components/layout", () => ({
  PageHeader: () => <div data-testid="page-header" />,
}));

// Stub the shell so the test asserts SettingsView's own nav/section wiring
// without the real scrollspy layout (CSS.escape / getBoundingClientRect) in
// jsdom. The stub renders each nav item and each section with a stable marker.
vi.mock("./settings-shell", () => ({
  SettingsLayout: ({
    nav,
    children,
  }: {
    nav: SettingsNavItem[];
    children: React.ReactNode;
  }) => (
    <div>
      <nav>
        {nav.map((item) => (
          <span key={item.id} data-nav={item.id}>
            {item.label}
          </span>
        ))}
      </nav>
      {children}
    </div>
  ),
  SettingsSection: ({
    id,
    children,
  }: {
    id: string;
    children: React.ReactNode;
  }) => <section data-section={id}>{children}</section>,
}));

vi.mock("./appearance-settings", () => ({ AppearanceSettings: () => <div /> }));
vi.mock("./chat-provider-settings", () => ({ ChatProviderSettings: () => <div /> }));
vi.mock("./agent-process-settings", () => ({ AgentProcessSettingsSection: () => <div /> }));
vi.mock("./session-retention-settings", () => ({ SessionRetentionSettingsSection: () => <div /> }));
vi.mock("./terminal-settings", () => ({ TerminalSettingsSection: () => <div /> }));
vi.mock("./proxy-settings", () => ({
  ProxySettings: () => <div data-testid="proxy-settings" />,
}));

import { SettingsView } from "./settings-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  appConfigState.config = null;
  persistedState.config = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function proxyMounted(): boolean {
  return (
    container.querySelector('[data-nav="proxy"]') !== null ||
    container.querySelector('[data-section="proxy"]') !== null ||
    container.querySelector('[data-testid="proxy-settings"]') !== null
  );
}

describe("SettingsView proxy visibility", () => {
  it("never mounts Proxy in SaaS mode, even on the empty first frame", () => {
    // Empty first frame: neither the hook nor the seed have resolved yet.
    // Defaulting to hidden means Proxy must not appear.
    appConfigState.config = null;
    persistedState.config = null;
    act(() => root.render(<SettingsView />));
    expect(proxyMounted()).toBe(false);

    // Config resolves to auth-enabled (SaaS). Proxy stays hidden.
    appConfigState.config = { authEnabled: true, clerkPublishableKey: "pk_test" };
    act(() => root.render(<SettingsView />));
    expect(proxyMounted()).toBe(false);
    expect(container.querySelector('[data-testid="proxy-settings"]')).toBeNull();
  });

  it("keeps Proxy hidden when the seeded config is already SaaS", () => {
    // AuthWrapper already resolved SaaS before SettingsView mounts: the seed is
    // populated, so Proxy is hidden on the very first frame with no flash.
    persistedState.config = { authEnabled: true, clerkPublishableKey: "pk_test" };
    act(() => root.render(<SettingsView />));
    expect(proxyMounted()).toBe(false);
  });

  it("shows Proxy in local/no-auth mode", () => {
    persistedState.config = { authEnabled: false, localProjectsEnabled: true };
    appConfigState.config = { authEnabled: false, localProjectsEnabled: true };
    act(() => root.render(<SettingsView />));
    expect(container.querySelector('[data-nav="proxy"]')).not.toBeNull();
    expect(container.querySelector('[data-section="proxy"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="proxy-settings"]')).not.toBeNull();
  });
});
