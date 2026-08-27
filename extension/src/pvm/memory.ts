import type { PvmRecord } from "./types";

/**
 * Bounded local memory for verified state -> action transitions.
 * Full PVM predict/hit logic is deferred past Sept 1 — this sprint only
 * lays down the storage shape so it isn't a blocker later. See
 * docs/ARCHITECTURE.md and PS26171_Role5_Pvm.pdf.
 */
const DB_NAME = "pvm-store";
const STORE_NAME = "transitions";
const MAX_ENTRIES = 500;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "stateHash" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putRecord(record: PvmRecord): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  await evictIfOverBound();
}

export async function getRecord(stateHash: string): Promise<PvmRecord | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(stateHash);
    req.onsuccess = () => resolve(req.result as PvmRecord | undefined);
    req.onerror = () => reject(req.error);
  });
}

/** Never store raw screenshots, secrets, or unverified transitions here — see docs/ARCHITECTURE.md. */
async function evictIfOverBound(): Promise<void> {
  const db = await openDb();
  const all: PvmRecord[] = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result as PvmRecord[]);
    req.onerror = () => reject(req.error);
  });
  if (all.length <= MAX_ENTRIES) return;

  const sorted = [...all].sort((a, b) => a.lastUsed - b.lastUsed);
  const toEvict = sorted.slice(0, all.length - MAX_ENTRIES);
  const tx = db.transaction(STORE_NAME, "readwrite");
  for (const rec of toEvict) tx.objectStore(STORE_NAME).delete(rec.stateHash);
}
