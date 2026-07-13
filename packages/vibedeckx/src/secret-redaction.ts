export function redactSecretForms(message: string, secret: string): string {
  if (secret.length === 0) return message;

  const encodedSecret = encodeURIComponent(secret);
  let redacted = message;
  if (encodedSecret !== secret) {
    redacted = redacted.replaceAll(encodedSecret, "[redacted]");
  }
  return redacted.replaceAll(secret, "[redacted]");
}

export function redactErrorSecret(error: unknown, secret: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecretForms(message, secret);
}
