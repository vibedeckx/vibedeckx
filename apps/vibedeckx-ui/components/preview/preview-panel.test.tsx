// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PreviewPanel } from "./preview-panel";
import type { PreviewLink } from "@/lib/api";

const apiMock = vi.hoisted(() => ({
  getPreviewLinks: vi.fn<(projectId: string) => Promise<{ enabled: boolean; links: PreviewLink[] }>>(),
}));
vi.mock("@/lib/api", () => ({
  api: apiMock,
  PreviewLinkError: class extends Error {},
}));
vi.mock("@/hooks/use-app-config", () => ({
  useAppConfig: () => ({ config: { authEnabled: false, previewLinks: true, localProjectsEnabled: true }, loading: false }),
}));
vi.mock("@/hooks/project-remotes-context", () => ({
  useProjectRemotesContext: () => ({ remotes: [], loading: false, loaded: true, refresh: async () => {} }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), message: vi.fn() } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const link = (slug: string): PreviewLink => ({
  slug, targetId: "local", targetName: "This machine", port: 3000,
  url: `http://${slug}.preview.localhost:5173`, createdAt: "2026-11-07T00:00:00Z", lastUsedAt: null,
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  apiMock.getPreviewLinks.mockReset();
});

function render(projectId: string) {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root!.render(<PreviewPanel projectId={projectId} project={{ id: projectId, name: projectId, path: "/x", is_remote: false, agent_mode: "local", executor_mode: "local", created_at: "" }} />));
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("PreviewPanel project switching", () => {
  it("drops the previous project's links on switch and ignores its late answer", async () => {
    const a = deferred<{ enabled: boolean; links: PreviewLink[] }>();
    const b = deferred<{ enabled: boolean; links: PreviewLink[] }>();
    apiMock.getPreviewLinks.mockImplementation((id) => (id === "A" ? a.promise : b.promise));

    render("A");
    render("B");
    // B answers first: its list shows.
    b.resolve({ enabled: true, links: [link("bbbbbbbbbb")] });
    await flush();
    expect(container!.textContent).toContain("bbbbbbbbbb");

    // A's slow answer arrives after the switch and must not replace B's list.
    a.resolve({ enabled: true, links: [link("aaaaaaaaaa")] });
    await flush();
    expect(container!.textContent).toContain("bbbbbbbbbb");
    expect(container!.textContent).not.toContain("aaaaaaaaaa");
  });

  it("never shows the old project's list while the new one is loading", async () => {
    const b = deferred<{ enabled: boolean; links: PreviewLink[] }>();
    apiMock.getPreviewLinks.mockImplementation((id) =>
      id === "A" ? Promise.resolve({ enabled: true, links: [link("aaaaaaaaaa")] }) : b.promise);

    render("A");
    await flush();
    expect(container!.textContent).toContain("aaaaaaaaaa");

    render("B");
    await flush();
    expect(container!.textContent).not.toContain("aaaaaaaaaa");
    b.resolve({ enabled: true, links: [] });
    await flush();
    expect(container!.textContent).toContain("Open a dev server");
  });
});
