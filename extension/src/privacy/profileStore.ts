import type { SensitiveCategory } from "./types";

/**
 * The user's own details, stored locally by the extension and never
 * sent anywhere.
 *
 * Chrome deliberately exposes NO API for reading its saved autofill
 * profiles, addresses, cards or passwords — `chrome.privacy` reports
 * only whether autofill is switched on, never the data. That's the
 * exact hole that would let any extension harvest saved cards, so it
 * is not a gap to work around. We keep our own copy instead.
 *
 * This is the same trade the whole project rests on: the real value
 * lives on this machine, the server only ever sees the token
 * ("[EMAIL_01]"). Auto-fill therefore demonstrates the privacy
 * boundary rather than punching through it.
 */
export type ProfileField = Extract<
  SensitiveCategory,
  "person_name" | "email" | "phone" | "address" | "financial"
>;

export type Profile = Partial<Record<ProfileField, string>>;

const STORAGE_KEY = "userProfile";

export async function loadProfile(): Promise<Profile> {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      resolve((result[STORAGE_KEY] as Profile | undefined) ?? {});
    });
  });
}

export async function saveProfile(profile: Profile): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: profile }, () => resolve());
  });
}

/**
 * Maps a redaction token back to the category it was minted from —
 * "[PERSON_NAME_01]" -> "person_name". Mirrors the token format built
 * in redact.ts (`[CATEGORY_NN]`); if that format changes, this must
 * change with it.
 */
export function categoryFromToken(token: string): ProfileField | null {
  const match = /^\[([A-Z_]+)_\d+\]$/.exec(token);
  if (!match) return null;
  const category = match[1].toLowerCase();
  const known: ProfileField[] = ["person_name", "email", "phone", "address", "financial"];
  return (known as string[]).includes(category) ? (category as ProfileField) : null;
}

/** The real value for a token, or null if the user hasn't saved one. */
export async function resolveFromProfile(token: string): Promise<string | null> {
  const category = categoryFromToken(token);
  if (!category) return null;
  const profile = await loadProfile();
  return profile[category] ?? null;
}
