"use client";

import { useMemo } from "react";

interface HtmlPreviewProps {
  html: string;
  title: string;
  // Bumped by the parent's Reload button — a new key remounts the iframe so the
  // page's scripts start over from a clean state.
  reloadKey: number;
}

// Scripts, forms, alert/confirm dialogs and target=_blank links work; the page
// can't navigate the app away. Deliberately NO allow-same-origin: the document
// then runs in an opaque origin, so its scripts can't read the app's DOM,
// cookies, localStorage (Clerk token) or call the API as the user — an HTML
// file an agent wrote is untrusted content.
const SANDBOX =
  "allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";

const SRCDOC_BASE = '<base href="about:srcdoc">';

// A srcdoc document's URL is about:srcdoc, but its relative URLs resolve
// against the PARENT page's URL. An in-page link (href="#claim-2") then points
// at the app's own page + #claim-2 — a cross-document navigation that loads
// Vibedeckx inside the sandboxed iframe (where it dies on localStorage) instead
// of scrolling. Pinning the base to about:srcdoc makes "#x" a same-document
// jump. It goes first in <head> so it beats any <base> the page declares (the
// first one with an href wins), and after a leading doctype so the page doesn't
// drop into quirks mode.
export function withSrcdocBase(html: string): string {
  const head = /<head\b[^>]*>/i.exec(html);
  const anchor = head ?? /^\s*<!doctype[^>]*>/i.exec(html);
  if (!anchor) return SRCDOC_BASE + html;
  const at = anchor.index + anchor[0].length;
  return html.slice(0, at) + SRCDOC_BASE + html.slice(at);
}

// Live, interactive render of an .html file. The content goes in via srcdoc
// rather than a blob URL: a blob: URL inherits the app's origin, which would
// defeat the sandbox if the page were ever opened outside the iframe. Relative
// assets (./style.css, ./app.js) don't resolve — the base is about:srcdoc, and
// the file routes need an Authorization header a sub-resource load can't carry.
// Absolute URLs (CDN scripts, remote images) load normally.
export function HtmlPreview({ html, title, reloadKey }: HtmlPreviewProps) {
  const srcDoc = useMemo(() => withSrcdocBase(html), [html]);
  return (
    <iframe
      key={reloadKey}
      title={title}
      srcDoc={srcDoc}
      sandbox={SANDBOX}
      referrerPolicy="no-referrer"
      // Most pages assume a white canvas; without it a page with no background
      // shows the app's dark theme through and its text becomes unreadable.
      className="block w-full h-full border-0 bg-white"
    />
  );
}
