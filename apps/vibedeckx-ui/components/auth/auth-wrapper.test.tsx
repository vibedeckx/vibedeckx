// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ isSignedIn: false }));
const clerkState = vi.hoisted(() => ({
  listener: null as null | ((state: { session: { expireAt: Date } | null }) => void),
}));

vi.mock("@clerk/clerk-react", () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => children,
  SignIn: ({
    appearance,
  }: {
    appearance: { elements: { rootBox: string } };
  }) => (
    <div data-testid="clerk-sign-in" className={appearance.elements.rootBox}>
      Clerk sign in
    </div>
  ),
  useAuth: () => ({
    getToken: vi.fn(),
    isLoaded: true,
    isSignedIn: authState.isSignedIn,
    userId: authState.isSignedIn ? "user-1" : null,
  }),
  useClerk: () => ({
    addListener: (
      listener: (state: { session: { expireAt: Date } | null }) => void,
    ) => {
      clerkState.listener = listener;
      return vi.fn();
    },
  }),
}));

vi.mock("@/hooks/use-app-config", () => ({
  useAppConfig: () => ({
    config: { authEnabled: true, clerkPublishableKey: "pk_test" },
    loading: false,
  }),
}));

vi.mock("@/lib/api", () => ({
  getFreshToken: vi.fn(),
  setAuthToken: vi.fn(),
  setTokenGetter: vi.fn(),
}));

vi.mock("@/lib/quick-switcher-cache", () => ({
  setQuickSwitcherCacheUser: vi.fn(),
}));

vi.mock("./landing-page", () => ({
  LandingPage: ({ onSignIn }: { onSignIn: () => void }) => (
    <button onClick={onSignIn}>Open sign in</button>
  ),
}));

import { AuthWrapper } from "./auth-wrapper";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === label,
  );
}

beforeEach(() => {
  authState.isSignedIn = false;
  clerkState.listener = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<AuthWrapper><div>Workspace</div></AuthWrapper>));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("AuthWrapper sign-in navigation", () => {
  it("places Back to home below deliberate sign-in and returns to the landing page", () => {
    act(() => findButton("Open sign in")!.click());

    const signIn = container.querySelector('[data-testid="clerk-sign-in"]')!;
    const back = findButton("Back to home");
    expect(back).toBeTruthy();
    expect(signIn.compareDocumentPosition(back!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    act(() => back!.click());

    expect(findButton("Open sign in")).toBeTruthy();
  });

  it("does not offer back navigation when recovering an expired session", () => {
    authState.isSignedIn = true;
    act(() => root.render(<AuthWrapper><div>Workspace</div></AuthWrapper>));
    act(() => clerkState.listener!({ session: { expireAt: new Date(Date.now() - 1) } }));

    authState.isSignedIn = false;
    act(() => clerkState.listener!({ session: null }));

    const alertCopy = Array.from(container.querySelectorAll("span")).find(
      (element) =>
        element.textContent?.trim() ===
        "Session expired. Sign in again to continue.",
    );
    expect(alertCopy).toBeTruthy();

    const alert = alertCopy!.parentElement!;
    const signIn = container.querySelector('[data-testid="clerk-sign-in"]')!;

    // Alert and Clerk card must take their width from one shared wrapper,
    // otherwise the alert can drift wider than the card it labels.
    expect(alert.parentElement).toBe(signIn.parentElement);
    const widthOwner = alert.parentElement!;
    for (const element of [alert, signIn]) {
      expect(element.classList.contains("w-full")).toBe(true);
    }
    // Clerk sizes its card in rem (25rem, capped at calc(100vw - 2.5rem)) and
    // this app pins the root font-size to 14px, so a px max-width renders
    // ~50px wider than the card. The wrapper must restate Clerk's own rule.
    expect(widthOwner.className).toMatch(
      /max-w-\[min\(25rem,calc\(100vw_-_2\.5rem\)\)\]/,
    );
    for (const element of [alert, signIn, widthOwner]) {
      expect(element.className).not.toMatch(/max-w-\[\d+px\]/);
    }
    expect(
      Array.from(container.querySelectorAll("button")).some((button) =>
        button.textContent?.includes("Back"),
      ),
    ).toBe(false);
  });
});
