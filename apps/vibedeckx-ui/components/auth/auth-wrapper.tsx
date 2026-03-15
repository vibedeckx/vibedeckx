"use client";

import { useEffect, useState } from "react";
import { ClerkProvider, SignIn, useAuth } from "@clerk/clerk-react";
import { ArrowLeft } from "lucide-react";
import { setAuthToken } from "@/lib/api";
import { useAppConfig } from "@/hooks/use-app-config";
import { Button } from "@/components/ui/button";
import { LandingPage } from "./landing-page";

function AuthTokenSync({ children }: { children: React.ReactNode }) {
  const { getToken, isSignedIn } = useAuth();

  useEffect(() => {
    if (!isSignedIn) {
      setAuthToken(null);
      return;
    }

    // Get initial token
    getToken().then((token) => setAuthToken(token));

    // Refresh token periodically (Clerk tokens expire ~60s)
    const interval = setInterval(async () => {
      const token = await getToken();
      setAuthToken(token);
    }, 50000);

    return () => clearInterval(interval);
  }, [isSignedIn, getToken]);

  return <>{children}</>;
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { isSignedIn, isLoaded } = useAuth();
  const [showSignIn, setShowSignIn] = useState(false);

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
      <div className="h-screen flex flex-col items-center justify-center bg-muted/40">
        <div className="w-full max-w-md">
          <Button
            variant="ghost"
            className="mb-4"
            onClick={() => setShowSignIn(false)}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
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

  // Auth mode — wrap with ClerkProvider
  return (
    <ClerkProvider publishableKey={config.clerkPublishableKey}>
      <AuthTokenSync>
        <AuthGate>{children}</AuthGate>
      </AuthTokenSync>
    </ClerkProvider>
  );
}
