"use client";

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

// Live, interactive render of an .html file. The content goes in via srcdoc
// rather than a blob URL: a blob: URL inherits the app's origin, which would
// defeat the sandbox if the page were ever opened outside the iframe. Relative
// assets (./style.css, ./app.js) don't resolve — srcdoc has no base URL, and the
// file routes need an Authorization header a sub-resource load can't carry.
// Absolute URLs (CDN scripts, remote images) load normally.
export function HtmlPreview({ html, title, reloadKey }: HtmlPreviewProps) {
  return (
    <iframe
      key={reloadKey}
      title={title}
      srcDoc={html}
      sandbox={SANDBOX}
      referrerPolicy="no-referrer"
      // Most pages assume a white canvas; without it a page with no background
      // shows the app's dark theme through and its text becomes unreadable.
      className="block w-full h-full border-0 bg-white"
    />
  );
}
