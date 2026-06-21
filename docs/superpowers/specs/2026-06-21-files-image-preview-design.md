# Files Image Preview — Design

## Problem

In the Files view, clicking an image file (e.g. a PNG) shows only a "Binary file"
card with a Download button. There is no inline preview.

## Goal

Render raster images inline in the file preview pane, reusing the existing
authenticated download route. Keep the current "Binary file" / "too large" cards
for everything else.

## Scope

**In scope:** raster image preview for these extensions —
`png, jpg, jpeg, gif, webp, bmp, ico, avif, svg`.

**Out of scope:** PDF, audio, video; zoom/pan; any backend change (the download
route already streams the bytes).

## Behavior

When the backend flags a file `binary: true`:

- If the extension is a raster image **and** `size <= 10MB` → render the image
  inline (`ImagePreview`).
- If it's an image **over** the cap → show a "too large to preview" card
  (mirrors the existing `tooLarge` UX) with a Download button.
- Otherwise (non-image binary) → keep the existing "Binary file" card.

The header (path, size, copy-path, download) is unchanged in all cases.

### SVG note

SVGs are included in the list, but the backend classifies many SVGs as
*non-binary* and returns them as text — those render as source code, consistent
with current behavior. Only SVGs the backend flags binary take the image path.
This is acceptable; no special-casing.

## How the image loads

A plain `<img src={downloadUrl}>` would not send the `Authorization` header the
download route requires under `--auth`. Instead reuse the same `authFetch` path
`api.downloadFile` already uses, but return the blob instead of triggering a
download:

```
api.getFileBlob(projectId, filePath, branch?, target?): Promise<Blob>
```

The component turns the blob into an object URL via `URL.createObjectURL` and
renders it in an `<img>`. The download route serves `application/octet-stream`;
the browser sniffs the image from the bytes, so no Content-Type change is needed.

## Components

### `api.getFileBlob` (lib/api.ts)

Mirrors `downloadFile`'s fetch (`getFileDownloadUrl` + `authFetch`, throwing on
non-OK), but returns `res.blob()` rather than wiring up an `<a download>`.

### `components/files/image-preview.tsx` (new)

Keeps `file-preview.tsx` (already ~580 lines) focused.

Props: `projectId, filePath, branch?, target?, onDownload`.

Responsibilities:

- On mount / when `filePath` (or project/branch/target) changes: fetch the blob,
  create an object URL. Revoke the previous object URL on cleanup to avoid leaks.
- States:
  - **loading** — spinner/skeleton.
  - **error** — fetch failure or `<img onError>` → a small "Couldn't load image"
    message plus a Download button.
  - **loaded** — `<img>` centered, `object-contain`, constrained to the pane
    (`max-w-full max-h-full`), on a neutral background so transparency reads.

### `file-preview.tsx` (wiring)

- Add `isImage(filePath): boolean` (extension set) and
  `IMAGE_PREVIEW_MAX_SIZE = 10 * 1024 * 1024`.
- In the `fileContent.binary` branch, split:
  - `isImage(filePath) && fileContent.size <= IMAGE_PREVIEW_MAX_SIZE` →
    `<ImagePreview … />`.
  - else → existing card, with the message switched to "Image too large to
    preview" when it's an oversized image.

## Testing

No test framework is configured. Verify manually: open a PNG (renders), a large
image (over-cap card), a non-image binary (unchanged "Binary file" card), and a
text/markdown file (unchanged). Confirm under `--auth` the image still loads
(auth header carried by `authFetch`).
