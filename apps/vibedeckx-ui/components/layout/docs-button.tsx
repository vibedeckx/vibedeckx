import { BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";

export const DOCS_URL = "https://docs.vibedeckx.dev";

// Header entry point to the public docs site (apps/docs). Unlike the Discord
// button this is unconditional: the docs are public and cover both solo and
// hosted modes, so there is no deployment where the link would be dead.
export function DocsButton() {
  return (
    <Button asChild variant="ghost" size="icon-sm" title="Documentation">
      <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" aria-label="Open documentation">
        <BookOpen className="h-4 w-4" />
      </a>
    </Button>
  );
}
