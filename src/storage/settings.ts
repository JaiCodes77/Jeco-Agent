import type { Settings } from "../types.ts";
import { migrateSettings } from "./migrate.ts";

const KEY = "settings";

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY);
  const { settings, changed } = migrateSettings(stored[KEY], Date.now(), () => crypto.randomUUID());
  if (changed) await saveSettings(settings);
  return settings;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: settings });
}

export function onSettingsChanged(cb: (settings: Settings) => void): () => void {
  const listener = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
    if (area !== "local" || !changes[KEY]) return;
    cb(migrateSettings(changes[KEY].newValue, Date.now(), () => crypto.randomUUID()).settings);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
