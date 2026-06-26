"use client";

import { createContext, useContext } from "react";
import type { FileRefIndex } from "@/lib/file-ref/file-ref-index";

export interface FileNavigationValue {
  openFile: (path: string, line?: number | null) => void;
  index: FileRefIndex | null;
}

const FileNavigationContext = createContext<FileNavigationValue | null>(null);

const NOOP: FileNavigationValue = { openFile: () => {}, index: null };

export function useFileNavigation(): FileNavigationValue {
  return useContext(FileNavigationContext) ?? NOOP;
}

export const FileNavigationProvider = FileNavigationContext.Provider;
