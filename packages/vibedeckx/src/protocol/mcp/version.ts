/** Versions supported by our stateless tools-only JSON-RPC endpoints. */
const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export function negotiateMcpVersion(requested: unknown): string {
  return typeof requested === "string" && versions.includes(requested) ? requested : versions[0];
}
