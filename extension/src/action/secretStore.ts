/**
 * In-memory, session-scoped local Secret Store.
 *
 * Enforces the core privacy guarantee: real credentials (passwords, tokens,
 * PII) are registered locally against opaque references (e.g. "[PASSWORD_01]").
 * The server reasoning engine only ever sees the reference token; the real
 * credential never leaves the extension memory space.
 *
 * See PS26171 Structured Action Protocol: "Secret-safe typing".
 */

const secretRegistry = new Map<string, string>();

/**
 * Registers a local credential against an opaque reference token.
 */
export function setLocalSecret(ref: string, value: string): void {
  if (!ref || typeof ref !== "string") return;
  secretRegistry.set(ref, value);
}

/**
 * Resolves an opaque reference token to its underlying credential.
 * Returns null if the reference is unregistered or empty.
 */
export async function resolveLocalSecret(ref: string): Promise<string | null> {
  if (!ref || typeof ref !== "string") {
    return null;
  }
  const secret = secretRegistry.get(ref);
  return secret !== undefined ? secret : null;
}

/**
 * Clears all registered credentials from session memory.
 */
export function clearLocalSecrets(): void {
  secretRegistry.clear();
}
