import { Button } from "@/components/ui/button";
import { DiscordIcon } from "@/components/brand/discord-icon";

// Header entry point to the community/support Discord. Renders only when an
// invite URL is provided (driven by the server's VIBEDECKX_DISCORD_URL via
// /api/config); absent config means no button — no dead links pre-launch.
// Shown in both solo and hosted modes (not gated on authEnabled).
export function DiscordButton({ inviteUrl }: { inviteUrl?: string }) {
  if (!inviteUrl) return null;
  return (
    <Button asChild variant="ghost" size="icon-sm" title="Join our Discord">
      <a href={inviteUrl} target="_blank" rel="noopener noreferrer" aria-label="Join our Discord">
        <DiscordIcon />
      </a>
    </Button>
  );
}
