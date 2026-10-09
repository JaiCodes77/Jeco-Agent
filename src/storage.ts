import { DEFAULT_MODEL, EMPTY_SETTINGS, RETIRED_MODELS, type Settings, type SiteGrant } from "./types.ts";

const KEY = "settings";

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY);
  const settings = sanitize(stored[KEY]);
  if (RETIRED_MODELS.includes(settings.model)) {
    settings.model = DEFAULT_MODEL;
    await saveSettings(settings);
  }
  return settings;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: settings });
}

function sanitize(value: unknown): Settings {
  if (!value || typeof value !== "object") return { ...EMPTY_SETTINGS, sites: [] };
  const record = value as Partial<Settings>;
  const sites = Array.isArray(record.sites) ? record.sites.map(sanitizeSite).filter((site) => site != null) : [];
  return {
    apiKey: typeof record.apiKey === "string" ? record.apiKey : "",
    model: typeof record.model === "string" && record.model.trim() ? record.model.trim() : DEFAULT_MODEL,
    sites,
  };
}

function sanitizeSite(value: unknown): SiteGrant | null {
  if (!value || typeof value !== "object") return null;
  const site = value as Partial<SiteGrant>;
  if (typeof site.host !== "string" || !site.host.includes(".")) return null;
  return {
    host: site.host,
    interact: Boolean(site.interact),
    post: Boolean(site.post),
  };
}
