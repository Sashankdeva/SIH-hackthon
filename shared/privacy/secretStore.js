/**
 * shared/privacy/secretStore.js
 *
 * Local-only storage for secrets and autofill profile data (e.g. saved credentials).
 *
 * DESIGN NOTE — Non-leakage Guarantee:
 * Secrets stored in this module are intended strictly for client-side local resolution
 * during action execution. They MUST NEVER leave the client or be sent to the LLM Host.
 * To enforce this:
 * 1. `listSecretKeys()` returns ONLY an array of string keys, never returning values or key-value tuples.
 * 2. `resolveSecret(key)` returns ONLY the direct string value (or null), never wrapping it in an object
 *    or structure that resembles a network payload (e.g. `{ key, value }` or `{ payload: ... }`).
 * 3. All storage operations are isolated behind a swappable storage backend interface.
 */

/**
 * Creates an in-memory storage adapter.
 * Useful for Node.js test runners and ephemeral per-session storage.
 */
export function createInMemoryStorageBackend() {
  const map = new Map();
  return {
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async set(key, value) {
      map.set(key, String(value));
    },
    async remove(key) {
      map.delete(key);
    },
    async keys() {
      return Array.from(map.keys());
    },
    async clear() {
      map.clear();
    }
  };
}

/**
 * Creates a chrome.storage.local adapter.
 * Wraps Chrome's extension storage API for persistent client-side storage.
 *
 * @param {object} [storageArea] - Defaults to chrome.storage.local if available.
 */
export function createChromeStorageBackend(storageArea = globalThis.chrome?.storage?.local) {
  const prefix = "sec_store:";
  return {
    async get(key) {
      if (!storageArea) throw new Error("chrome.storage.local is not available in this environment");
      const storageKey = `${prefix}${key}`;
      const res = await storageArea.get(storageKey);
      return res && res[storageKey] !== undefined ? res[storageKey] : null;
    },
    async set(key, value) {
      if (!storageArea) throw new Error("chrome.storage.local is not available in this environment");
      const storageKey = `${prefix}${key}`;
      await storageArea.set({ [storageKey]: String(value) });
    },
    async remove(key) {
      if (!storageArea) throw new Error("chrome.storage.local is not available in this environment");
      const storageKey = `${prefix}${key}`;
      await storageArea.remove(storageKey);
    },
    async keys() {
      if (!storageArea) throw new Error("chrome.storage.local is not available in this environment");
      const all = await storageArea.get(null);
      return Object.keys(all || {})
        .filter(k => k.startsWith(prefix))
        .map(k => k.slice(prefix.length));
    },
    async clear() {
      if (!storageArea) throw new Error("chrome.storage.local is not available in this environment");
      const all = await storageArea.get(null);
      const toRemove = Object.keys(all || {}).filter(k => k.startsWith(prefix));
      if (toRemove.length > 0) {
        await storageArea.remove(toRemove);
      }
    }
  };
}

// Default active backend: in-memory for testing/safety or chrome.storage if available
let activeBackend = (typeof globalThis.chrome !== "undefined" && globalThis.chrome?.storage?.local)
  ? createChromeStorageBackend()
  : createInMemoryStorageBackend();

/**
 * Sets the active storage backend.
 *
 * @param {{ get: Function, set: Function, remove: Function, keys: Function, clear?: Function }} backend
 */
export function setStorageBackend(backend) {
  if (!backend || typeof backend.get !== "function" || typeof backend.set !== "function" || typeof backend.keys !== "function") {
    throw new TypeError("setStorageBackend: backend must implement get, set, remove, and keys methods");
  }
  activeBackend = backend;
}

/**
 * Retrieves the currently active storage backend.
 */
export function getStorageBackend() {
  return activeBackend;
}

/**
 * Saves a secret or profile value under the given key.
 *
 * @param {string} key
 * @param {string} value
 * @returns {Promise<void>}
 */
export async function saveSecret(key, value) {
  if (!key || typeof key !== "string") {
    throw new TypeError("saveSecret: key must be a non-empty string");
  }
  if (value === undefined || value === null) {
    throw new TypeError("saveSecret: value must be provided");
  }
  await activeBackend.set(key, String(value));
}

/**
 * Resolves a secret by key for client-side local action execution.
 * If the key does not exist, returns null safely without throwing.
 *
 * Non-leakage: Returns the raw string directly, never wrapped in a payload object.
 *
 * @param {string} key
 * @returns {Promise<string | null>}
 */
export async function resolveSecret(key) {
  if (!key || typeof key !== "string") {
    return null;
  }
  const val = await activeBackend.get(key);
  return val !== undefined && val !== null ? String(val) : null;
}

/**
 * Deletes a stored secret by key.
 *
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function deleteSecret(key) {
  if (!key || typeof key !== "string") {
    return;
  }
  if (typeof activeBackend.remove === "function") {
    await activeBackend.remove(key);
  }
}

/**
 * Lists all stored secret keys without exposing their values.
 * Strictly returns an array of string identifiers.
 *
 * Non-leakage: Under no circumstances are stored secret values included.
 *
 * @returns {Promise<string[]>}
 */
export async function listSecretKeys() {
  const keys = await activeBackend.keys();
  if (!Array.isArray(keys)) return [];
  // Ensure elements are strictly strings to prevent any object/value leaks
  return keys.map(k => String(k));
}

/**
 * Clears all secrets in the active store.
 *
 * @returns {Promise<void>}
 */
export async function clearSecrets() {
  if (typeof activeBackend.clear === "function") {
    await activeBackend.clear();
  }
}
