/**
 * Local secret resolution for the `type_secret` action — see
 * PS26171_Sprint_Plan.pdf, Extension Day 3, and the "Secret-safe typing"
 * pattern in docs/planning/PS26171_Research_Dossier.docx.
 *
 * A plain in-memory Map, not chrome.storage: this content script gets a
 * fresh JS context on every page load, so the store is already scoped
 * to exactly one page visit and disappears on navigation — no explicit
 * clearing needed, and nothing is ever written to disk. The server only
 * ever sees the token (e.g. "[PASSWORD_01]"); the real value referenced
 * by that token never leaves this module.
 */
const secretStore = new Map<string, string>();

export function storeSecret(ref: string, value: string): void {
  secretStore.set(ref, value);
}

export function resolveSecret(ref: string): string | null {
  return secretStore.get(ref) ?? null;
}

export function clearSecrets(): void {
  secretStore.clear();
}
