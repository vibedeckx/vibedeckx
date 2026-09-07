/**
 * Largest single composer attachment, in raw bytes (temporarily raised from
 * 8 MB to 20 MB). Mirrors the server's `MAX_ATTACHMENT_BYTES`
 * (packages/vibedeckx/src/utils/attachment-file.ts); the two must move
 * together. Enforced at pick time so an oversize file is never read into
 * memory only to be refused by the server.
 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export function formatMegabytes(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))}MB`;
}
