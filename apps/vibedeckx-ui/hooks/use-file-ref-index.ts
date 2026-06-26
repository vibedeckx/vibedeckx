"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { buildFileRefIndex, type FileRefIndex } from "@/lib/file-ref/file-ref-index";

interface Args {
  projectId: string | null;
  branch?: string | null;
  target?: "local" | "remote";
}

// Loads the project's flat file list once per project/branch/target and builds
// a resolution index. Returns null while loading or on error (refs stay plain
// text and upgrade to links when the index arrives).
export function useFileRefIndex({ projectId, branch, target }: Args): FileRefIndex | null {
  const [index, setIndex] = useState<FileRefIndex | null>(null);
  const keyRef = useRef(0);

  useEffect(() => {
    setIndex(null);
    if (!projectId) return;
    const key = ++keyRef.current;
    api
      .listProjectFiles(projectId, branch, target)
      .then((res) => {
        if (key === keyRef.current) setIndex(buildFileRefIndex(res.files));
      })
      .catch(() => {
        /* leave null — graceful degradation */
      });
  }, [projectId, branch, target]);

  return index;
}
