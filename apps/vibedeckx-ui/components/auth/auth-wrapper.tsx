"use client";

import { useEffect, useRef, useState } from "react";
import { ClerkProvider, SignIn, useAuth, useClerk } from "@clerk/clerk-react";
import { ArrowLeft, Clock } from "lucide-react";
import { setAuthToken, setTokenGetter, getFreshToken } from "@/lib/api";
import { isSessionExpirySignOut } from "@/lib/session-expiry";
import { setQuickSwitcherCacheUser } from "@/lib/quick-switcher-cache";
import { useAppConfig } from "@/hooks/use-app-config";
import { Button } from "@/components/ui/button";
import { LandingPage } from "./landing-page";

function AuthTokenSync({ children }: { children: React.ReactNode }) {
  const { getToken, isSignedIn, userId } = useAuth();

  // Scope the quick-switcher cache/MRU to the signed-in user: on sign-out or
  // account switch the previous user's cached session titles must never seed
  // the palette. No-auth (solo) deployments never mount this component and
  // keep the module's default "solo" scope.
  useEffect(() => {
    setQuickSwitcherCacheUser(isSignedIn ? (userId ?? null) : null);
  }, [isSignedIn, userId]);

  useEffect(() => {
    if (!isSignedIn) {
      setTokenGetter(null);
      setAuthToken(null);
      return;
    }

    // Register Clerk's getToken as the source of truth. Each request fetches a
    // guaranteed-valid token on demand (cache-hit = no network), so we no longer
    // rely on a setInterval — which background tabs throttle, leaving a stale
    // cached token that produced intermittent 401s.
    setTokenGetter((opts) => getToken(opts));

    // Warm the cache once so synchronous WS/SSE URL builders have a token before
    // the first request.
    void getFreshToken();

    return () => setTokenGetter(null);
  }, [isSignedIn, getToken]);

  return <>{children}</>;
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { isSignedIn, isLoaded } = useAuth();
  const clerk = useClerk();
  const [showSignIn, setShowSignIn] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  // Last expireAt observed while signed in — by the time the sign-out reaches
  // us the session object is already gone, so this is the only way to tell
  // lifetime expiry apart from an intentional sign-out.
  const expireAtRef = useRef<number | null>(null);
  const wasSignedInRef = useRef(false);

  // On a mid-use sign-out caused by session lifetime expiry (Clerk's hard
  // maximum counted from sign-in, 7 days by default), go straight to the
  // sign-in form with an explanation instead of silently dumping the user on
  // the landing page. The URL (and its ?session= etc. params) is left
  // untouched, so signing back in restores the exact workspace they were on.
  useEffect(() => {
    return clerk.addListener(({ session }) => {
      if (session) {
        expireAtRef.current = session.expireAt ? session.expireAt.getTime() : null;
        wasSignedInRef.current = true;
        setSessionExpired(false);
      } else if (wasSignedInRef.current) {
        wasSignedInRef.current = false;
        if (isSessionExpirySignOut(expireAtRef.current, Date.now())) {
          setSessionExpired(true);
          setShowSignIn(true);
        }
      }
    });
  }, [clerk]);

  // Auto-detect Clerk OAuth callback hash fragments to skip landing page
  useEffect(() => {
    const hash = window.location.hash;
    if (hash.includes("/sso-callback") || hash.includes("/factor")) {
      setShowSignIn(true);
    }
  }, []);

  if (!isLoaded) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!isSignedIn) {
    if (!showSignIn) {
      return <LandingPage onSignIn={() => setShowSignIn(true)} />;
    }

    return (
      <div className="h-screen flex flex-col items-center justify-center bg-background">
        <div className="w-full max-w-md">
          <Button
            variant="ghost"
            className="mb-4 text-muted-foreground hover:text-foreground"
            onClick={() => {
              setShowSignIn(false);
              setSessionExpired(false);
            }}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
          {sessionExpired && (
            <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-600 dark:text-amber-400">
              <Clock className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Your session expired. Sign in again to pick up where you left
                off.
              </span>
            </div>
          )}
          <SignIn
            routing="hash"
            appearance={{
              elements: {
                rootBox: "mx-auto",
                card: "shadow-lg",
              },
            }}
          />
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

export function AuthWrapper({ children }: { children: React.ReactNode }) {
  const { config, loading } = useAppConfig();

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  // No auth mode — render children directly
  if (!config?.authEnabled || !config.clerkPublishableKey) {
    return <>{children}</>;
  }

  // Auth mode — wrap with ClerkProvider.
  // clerkJSVersion is pinned to an exact patch so clerk.browser.js is requested
  // by its canonical (immutable, cacheable) URL. Without it, clerk-react asks
  // for the `@5` major alias, which is served with `no-store` and costs a 307
  // redirect round-trip on every refresh. Keep this in sync with the installed
  // @clerk/clerk-react when upgrading.
  return (
    <ClerkProvider
      publishableKey={config.clerkPublishableKey}
      clerkJSVersion="5.125.13"
    >
      <AuthTokenSync>
        <AuthGate>{children}</AuthGate>
      </AuthTokenSync>
    </ClerkProvider>
  );
}
