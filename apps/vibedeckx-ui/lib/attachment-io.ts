/**
 * Reading composer attachments out of the browser. The composer holds files as
 * blob URLs (cheap to preview) and needs their bytes as base64 twice over: to
 * sniff the real format, and to put them in a JSON upload body.
 */

const DATA_URL_BASE64_RE = /^data:[^;,]*(?:;[^;,]*)*;base64,(.+)$/;

/** The base64 payload of a data URL, or null when the URL is not one. */
export function base64FromDataUrl(url: string | undefined): string | null {
  return url?.match(DATA_URL_BASE64_RE)?.[1] ?? null;
}

/**
 * Read a `blob:` URL into a base64 data URL. Returns null instead of throwing:
 * a revoked or unreadable blob is a normal outcome (the user removed the file,
 * the page was restored) and callers decide what a missing body means.
 */
export async function readBlobUrlAsDataUrl(url: string | undefined): Promise<string | null> {
  if (!url) return null;
  if (url.startsWith("data:")) return url;
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}
