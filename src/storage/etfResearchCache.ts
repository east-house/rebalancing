const DATABASE_NAME = "balance-etf-research";
const STORE_NAME = "bundles";
const DATABASE_VERSION = 1;

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getResearchCache<T>(key: string): Promise<T | null> {
  try {
    const database = await openDatabase();
    if (!database) return null;
    return await new Promise<T | null>((resolve, reject) => {
      const request = database.transaction(STORE_NAME).objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

export async function setResearchCache<T>(key: string, value: T): Promise<void> {
  try {
    const database = await openDatabase();
    if (!database) return;
    await new Promise<void>((resolve, reject) => {
      const request = database
        .transaction(STORE_NAME, "readwrite")
        .objectStore(STORE_NAME)
        .put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // Cache failure must never prevent research features from loading.
  }
}
