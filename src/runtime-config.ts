import { createStore } from './store.js';

// Runtime-writable config, persisted in the shared KV store. Intended to grow
// into the home for settings that migrate off env vars over time.
const configStore = createStore<unknown>('runtime-config');

// Keyv reports failed reads as missing keys; use this where that must not look like "unset".
export const strictConfigStore = createStore<unknown>('runtime-config', { throwOnErrors: true });

export async function readConfigKey<T>(key: string): Promise<T | undefined> {
  return configStore.get(key) as T | undefined;
}

export async function writeConfigKey(key: string, value: unknown): Promise<void> {
  await configStore.set(key, value);
}

export async function deleteConfigKey(key: string): Promise<void> {
  await configStore.delete(key);
}
