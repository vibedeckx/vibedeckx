"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";

/**
 * A bookmarked preview URL whose cookie has expired lands on the preview host's
 * sign-in page, which links back here as `/?preview=<slug>`. Once the app is
 * signed in (we are inside the auth gate), mint a fresh ticket and send the
 * browser straight back to the preview — the user sees a brief hop, not a form.
 */
export function PreviewLinkBounce() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const slug = params.get("preview");
    if (!slug) return;
    // Drop the parameter first so a failed bounce does not loop on reload.
    params.delete("preview");
    const clean = `${window.location.pathname}${params.size ? `?${params}` : ""}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", clean);
    api.openPreviewLink(slug)
      .then((result) => {
        window.location.assign(result.authUrl);
      })
      .catch((err) => {
        toast.error("Could not open that preview", {
          description: err instanceof Error ? err.message : "The link may have been removed.",
        });
      });
  }, []);
  return null;
}
