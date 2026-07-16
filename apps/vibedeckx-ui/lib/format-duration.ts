// Compact human duration for the turn_end divider: "9s", "2m 14s", "1h 5m".
export function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) return sec ? `${totalMin}m ${sec}s` : `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min ? `${h}h ${min}m` : `${h}h`;
}
