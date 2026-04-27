import localforage from "localforage";

const store = localforage.createInstance({
  name: "mingshi-reader-ai",
  storeName: "reader_state",
});

export async function readPersistedState<T>(key: string, fallback: T): Promise<T> {
  const value = await store.getItem<T>(key);
  return value ?? fallback;
}

export async function writePersistedState<T>(key: string, value: T): Promise<void> {
  await store.setItem(key, value);
}
