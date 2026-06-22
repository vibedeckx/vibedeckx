"use client";

import { useEffect, useState } from "react";
import { Download, ImageOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

interface ImagePreviewProps {
  projectId: string;
  filePath: string;
  branch?: string | null;
  target?: "local" | "remote";
  onDownload: () => void;
}

// Inline preview for raster image files flagged binary by the backend. The bytes
// are fetched via authFetch (api.getFileBlob) rather than a plain <img src=url>,
// because the download route needs the Authorization header under --auth. The
// blob becomes an object URL for the <img>, revoked on cleanup to avoid leaks.
export function ImagePreview({
  projectId,
  filePath,
  branch,
  target,
  onDownload,
}: ImagePreviewProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  // The parent keys this component on filePath, so it remounts per file and the
  // initial null/false state is always correct — no synchronous reset needed here.
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;

    api
      .getFileBlob(projectId, filePath, branch, target)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });

    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [projectId, filePath, branch, target]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <ImageOff className="h-10 w-10" />
        <p className="text-sm">Couldn&apos;t load image</p>
        <Button variant="outline" size="sm" onClick={onDownload}>
          <Download className="h-4 w-4 mr-2" />
          Download
        </Button>
      </div>
    );
  }

  if (!objectUrl) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full p-4 bg-muted/30">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={objectUrl}
        alt={filePath.split("/").pop() ?? "image"}
        className="max-w-full max-h-full object-contain"
        onError={() => setError(true)}
      />
    </div>
  );
}
