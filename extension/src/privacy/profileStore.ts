import type { SensitiveCategory } from "./types";

/**
 * The user's own details, stored locally by the extension and never
 * sent anywhere.
 *
 * Phase 4 — WebCrypto AES-GCM Authenticated Encryption:
 * Profiles saved with a user PIN/password are encrypted at rest using
 * 256-bit AES-GCM with a PBKDF2-derived key (100,000 SHA-256 iterations)
 * and a cryptographically random 16-byte salt + 12-byte IV.
 *
 * Passwords are NEVER persisted — they remain session-only in secretStore.ts.
 */
export type ProfileField = Extract<
  SensitiveCategory,
  "person_name" | "email" | "phone" | "address" | "financial" | "government_id"
>;

export type Profile = Partial<Record<ProfileField, string>>;

export interface EncryptedProfileEnvelope {
  version: 1;
  format: "aes-gcm-pbkdf2";
  salt: string;       // Base64-encoded 16-byte random salt
  iv: string;         // Base64-encoded 12-byte random IV
  ciphertext: string; // Base64-encoded ciphertext + authentication tag
}

const STORAGE_KEY = "userProfile";
const PBKDF2_ITERATIONS = 100000;

const ALLOWED_FIELDS = new Set<ProfileField>([
  "person_name",
  "email",
  "phone",
  "address",
  "financial",
  "government_id",
]);

/** In-memory session cache for unlocked profile to protect hot-path performance */
let cachedUnlockedProfile: Profile | null = null;

function sanitizeProfileData(raw: unknown): Profile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const sanitized: Profile = {};
  for (const [key, val] of Object.entries(raw)) {
    if (ALLOWED_FIELDS.has(key as ProfileField) && typeof val === "string") {
      // Bound string length to 1000 characters to prevent memory/storage abuse
      sanitized[key as ProfileField] = val.slice(0, 1000);
    }
  }
  return sanitized;
}

function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBuffer(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deriveAesKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(pin),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as unknown as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypts a profile object using WebCrypto AES-GCM 256-bit with PBKDF2 key derivation.
 */
export async function encryptProfile(
  profile: Profile,
  pin: string
): Promise<EncryptedProfileEnvelope> {
  if (!pin || typeof pin !== "string") {
    throw new Error("A non-empty PIN string is required for profile encryption");
  }

  const sanitized = sanitizeProfileData(profile);
  const enc = new TextEncoder();
  const plaintext = enc.encode(JSON.stringify(sanitized));

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(pin, salt);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    plaintext as unknown as BufferSource
  );

  return {
    version: 1,
    format: "aes-gcm-pbkdf2",
    salt: bufferToBase64(salt),
    iv: bufferToBase64(iv),
    ciphertext: bufferToBase64(ciphertext),
  };
}

/**
 * Decrypts an EncryptedProfileEnvelope using the user's PIN.
 * Returns null if the PIN is incorrect or data is corrupted (safe failure).
 */
export async function decryptProfile(
  envelope: EncryptedProfileEnvelope,
  pin: string
): Promise<Profile | null> {
  if (
    !envelope ||
    envelope.version !== 1 ||
    envelope.format !== "aes-gcm-pbkdf2" ||
    !envelope.salt ||
    !envelope.iv ||
    !envelope.ciphertext ||
    !pin ||
    typeof pin !== "string"
  ) {
    return null;
  }

  try {
    const salt = base64ToBuffer(envelope.salt);
    const iv = base64ToBuffer(envelope.iv);
    const ciphertext = base64ToBuffer(envelope.ciphertext);

    if (salt.length !== 16 || iv.length !== 12 || ciphertext.length === 0) {
      return null;
    }

    const key = await deriveAesKey(pin, salt);
    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      key,
      ciphertext as unknown as BufferSource
    );

    const dec = new TextDecoder();
    const jsonStr = dec.decode(decryptedBuffer);
    const parsed = JSON.parse(jsonStr);
    return sanitizeProfileData(parsed);
  } catch {
    // Decryption failure (authentication tag mismatch on wrong PIN or corrupted ciphertext)
    return null;
  }
}

/**
 * Saves profile data to persistent storage.
 * If a PIN is supplied, encrypts with AES-GCM before writing to storage.
 */
export async function saveProfile(profile: Profile, pin?: string): Promise<void> {
  const sanitized = sanitizeProfileData(profile);
  cachedUnlockedProfile = sanitized;

  let storagePayload: unknown = sanitized;
  if (pin && typeof pin === "string" && pin.trim().length > 0) {
    storagePayload = await encryptProfile(sanitized, pin);
  }

  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      resolve();
      return;
    }
    chrome.storage.local.set({ [STORAGE_KEY]: storagePayload }, () => resolve());
  });
}

/**
 * Loads profile data from persistent storage.
 * If storage contains encrypted data, decrypts using the provided PIN (or cached session profile).
 */
export async function loadProfile(pin?: string): Promise<Profile> {
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      resolve(cachedUnlockedProfile ?? {});
      return;
    }

    chrome.storage.local.get([STORAGE_KEY], async (result) => {
      const raw = result?.[STORAGE_KEY];
      if (!raw) {
        resolve(cachedUnlockedProfile ?? {});
        return;
      }

      // Check if stored data is an encrypted envelope
      if (
        typeof raw === "object" &&
        raw !== null &&
        "format" in raw &&
        (raw as EncryptedProfileEnvelope).format === "aes-gcm-pbkdf2"
      ) {
        const envelope = raw as EncryptedProfileEnvelope;
        if (pin && typeof pin === "string" && pin.trim().length > 0) {
          const decrypted = await decryptProfile(envelope, pin);
          if (decrypted) {
            cachedUnlockedProfile = decrypted;
            resolve(decrypted);
            return;
          }
          // Wrong PIN -> safe failure
          resolve({});
          return;
        }

        // No PIN provided: return cached unlocked session profile if present, else empty locked state
        resolve(cachedUnlockedProfile ?? {});
        return;
      }

      // Unencrypted legacy or plain profile
      const sanitized = sanitizeProfileData(raw);
      cachedUnlockedProfile = sanitized;
      resolve(sanitized);
    });
  });
}

/**
 * Unlocks an encrypted profile using the PIN and caches it for the active session.
 */
export async function unlockProfile(pin: string): Promise<boolean> {
  if (!pin || typeof pin !== "string") return false;
  const profile = await loadProfile(pin);
  if (Object.keys(profile).length > 0) {
    cachedUnlockedProfile = profile;
    return true;
  }
  return false;
}

/**
 * Purges the in-memory session profile cache.
 */
export function lockProfile(): void {
  cachedUnlockedProfile = null;
}

/**
 * Returns whether an encrypted profile exists in storage that is currently locked.
 */
export async function isProfileLocked(): Promise<boolean> {
  if (cachedUnlockedProfile !== null && Object.keys(cachedUnlockedProfile).length > 0) {
    return false;
  }

  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      resolve(false);
      return;
    }
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      const raw = result?.[STORAGE_KEY];
      const isEncrypted =
        typeof raw === "object" &&
        raw !== null &&
        "format" in raw &&
        (raw as EncryptedProfileEnvelope).format === "aes-gcm-pbkdf2";
      resolve(isEncrypted && cachedUnlockedProfile === null);
    });
  });
}

/**
 * Deletes persistent profile storage and clears in-memory session cache.
 */
export async function clearProfile(): Promise<void> {
  cachedUnlockedProfile = null;
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      resolve();
      return;
    }
    chrome.storage.local.remove([STORAGE_KEY], () => resolve());
  });
}

/**
 * Maps a redaction token back to the category it was minted from —
 * "[PERSON_NAME_01]" -> "person_name", "[GOVERNMENT_ID_01]" -> "government_id".
 * Mirrors the token format built in redact.ts (`[CATEGORY_NN]`).
 */
export function categoryFromToken(token: string): ProfileField | null {
  if (!token || typeof token !== "string") return null;
  const match = /^\[([A-Z_]+)_\d+\]$/.exec(token.trim());
  if (!match) return null;
  const category = match[1].toLowerCase();
  return ALLOWED_FIELDS.has(category as ProfileField) ? (category as ProfileField) : null;
}

/**
 * The real value for a token, resolved locally from the loaded profile,
 * or null if unmapped or locked.
 */
export async function resolveFromProfile(token: string): Promise<string | null> {
  const category = categoryFromToken(token);
  if (!category) return null;
  const profile = await loadProfile();
  return profile[category] ?? null;
}
