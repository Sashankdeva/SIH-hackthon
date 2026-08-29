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

import { storeSecret, resolveSecret, clearSecrets } from "../privacy/secretStore";

/**
 * Registers a local credential against an opaque reference token.
 * Forwards directly to the authoritative privacy/secretStore.
 */
export function setLocalSecret(ref: string, value: string): void {
  if (!ref || typeof ref !== "string") return;
  storeSecret(ref, value);
}

/**
 * Resolves an opaque reference token to its underlying credential.
 * Returns null if the reference is unregistered or empty.
 */
export async function resolveLocalSecret(ref: string): Promise<string | null> {
  if (!ref || typeof ref !== "string") {
    return null;
  }
  return resolveSecret(ref);
}

/**
 * Clears all registered credentials from session memory.
 */
export function clearLocalSecrets(): void {
  clearSecrets();
}
