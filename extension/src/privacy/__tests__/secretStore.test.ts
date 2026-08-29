/**
 * Tests for shared/privacy/secretStore.js
 *
 * Covers Phase 4: Local-only storage for secrets/profile data.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  saveSecret,
  resolveSecret,
  deleteSecret,
  listSecretKeys,
  clearSecrets,
  createInMemoryStorageBackend,
  createChromeStorageBackend,
  setStorageBackend,
} from "../../../../shared/privacy/secretStore.js";

describe("secretStore — basic CRUD operations", () => {
  beforeEach(async () => {
    // Reset to a clean in-memory backend before each test
    setStorageBackend(createInMemoryStorageBackend());
  });

  it("saves and resolves a secret correctly", async () => {
    await saveSecret("login_password", "SuperSecretPass123!");
    const resolved = await resolveSecret("login_password");
    expect(resolved).toBe("SuperSecretPass123!");
  });

  it("deletes a secret correctly", async () => {
    await saveSecret("otp_token", "998877");
    await deleteSecret("otp_token");
    const resolved = await resolveSecret("otp_token");
    expect(resolved).toBeNull();
  });

  it("clears all secrets", async () => {
    await saveSecret("key1", "val1");
    await saveSecret("key2", "val2");
    await clearSecrets();
    const keys = await listSecretKeys();
    expect(keys).toEqual([]);
    expect(await resolveSecret("key1")).toBeNull();
  });

  it("fails safely when resolving a non-existent key", async () => {
    const resolved = await resolveSecret("non_existent_key");
    expect(resolved).toBeNull();
  });

  it("handles invalid key inputs safely", async () => {
    // @ts-expect-error — intentional invalid type
    expect(await resolveSecret(null)).toBeNull();
    // @ts-expect-error — intentional invalid type
    expect(await resolveSecret(undefined)).toBeNull();
    // @ts-expect-error — intentional invalid type
    await expect(saveSecret(null, "val")).rejects.toThrow(TypeError);
    // @ts-expect-error — intentional invalid type
    await expect(saveSecret("key", null)).rejects.toThrow(TypeError);
  });
});

describe("secretStore — non-leakage guarantee", () => {
  beforeEach(async () => {
    setStorageBackend(createInMemoryStorageBackend());
  });

  it("listSecretKeys() returns ONLY key names and never exposes secret values", async () => {
    const sensitiveValue = "super_confidential_bank_pin_1234";
    await saveSecret("bank_pin", sensitiveValue);
    await saveSecret("user_email", "user@example.com");

    const keys = await listSecretKeys();

    // 1. Structure check: must be an array of primitive strings
    expect(Array.isArray(keys)).toBe(true);
    expect(keys.length).toBe(2);
    for (const key of keys) {
      expect(typeof key).toBe("string");
    }

    // 2. Value leak check: serialized output must not contain sensitive values
    const serialized = JSON.stringify(keys);
    expect(serialized).not.toContain(sensitiveValue);
    expect(serialized).not.toContain("user@example.com");
    expect(keys).toContain("bank_pin");
    expect(keys).toContain("user_email");
  });

  it("resolveSecret() returns direct primitive value and never wraps it in a payload structure", async () => {
    const secret = "my_api_key_abc_xyz";
    await saveSecret("api_key", secret);

    const result = await resolveSecret("api_key");

    // Must be a primitive string, not an object resembling a network payload (e.g. { key, value } or { payload: ... })
    expect(typeof result).toBe("string");
    expect(result).toBe(secret);
    expect(result).not.toHaveProperty("payload");
    expect(result).not.toHaveProperty("value");
  });
});

describe("secretStore — swappable storage backend", () => {
  it("allows plugging in a custom storage backend", async () => {
    const customStorage = new Map();
    const mockBackend = {
      async get(key: string) {
        return customStorage.get(key) ?? null;
      },
      async set(key: string, value: string) {
        customStorage.set(key, value);
      },
      async remove(key: string) {
        customStorage.delete(key);
      },
      async keys() {
        return Array.from(customStorage.keys());
      }
    };

    setStorageBackend(mockBackend);

    await saveSecret("custom_key", "custom_val");
    expect(await resolveSecret("custom_key")).toBe("custom_val");
    expect(await listSecretKeys()).toEqual(["custom_key"]);
    expect(customStorage.get("custom_key")).toBe("custom_val");
  });

  it("supports chrome.storage.local mock adapter", async () => {
    const mockStorageData: Record<string, string> = {};
    const mockChromeStorage = {
      async get(key: string | null) {
        if (key === null) return { ...mockStorageData };
        return { [key]: mockStorageData[key] };
      },
      async set(items: Record<string, string>) {
        Object.assign(mockStorageData, items);
      },
      async remove(keys: string | string[]) {
        const keyList = Array.isArray(keys) ? keys : [keys];
        for (const k of keyList) {
          delete mockStorageData[k];
        }
      }
    };

    const chromeBackend = createChromeStorageBackend(mockChromeStorage);
    setStorageBackend(chromeBackend);

    await saveSecret("chrome_secret", "chrome_value_123");
    expect(mockStorageData["sec_store:chrome_secret"]).toBe("chrome_value_123");

    const resolved = await resolveSecret("chrome_secret");
    expect(resolved).toBe("chrome_value_123");

    const keys = await listSecretKeys();
    expect(keys).toEqual(["chrome_secret"]);

    await deleteSecret("chrome_secret");
    expect(await resolveSecret("chrome_secret")).toBeNull();
  });
});
