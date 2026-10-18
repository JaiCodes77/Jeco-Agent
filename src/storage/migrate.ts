import { DEFAULT_MODEL, RETIRED_MODELS } from "../limits.ts";
import type { ProviderConfig, ProviderId, RunStatus, SavedTask, Settings, SiteGrant } from "../types.ts";

const PROVIDERS: ProviderId[] = ["openrouter", "openai", "xai", "local"];
const RUN_STATUSES: RunStatus[] = ["done", "stopped", "error", "capped", "interrupted", "needs-setup"];

export function emptySettings(): Settings {
  return {
    schemaVersion: 3,
    provider: "openrouter",
    providers: {
      openrouter: blankProvider("openrouter"),
      openai: blankProvider("openai"),
      xai: blankProvider("xai"),
      local: blankProvider("local"),
    },
    sites: [],
    savedTasks: [],
    privacy: { redactNumbers: true },
  };
}

export function migrateSettings(
  raw: unknown,
  now: number,
  newId: () => string,
): { settings: Settings; changed: boolean } {
  if (!isRecord(raw)) return { settings: emptySettings(), changed: true };
  if (raw.schemaVersion === 3) return sanitizeV3(raw, now, newId);
  return { settings: fromLegacy(raw, now, newId), changed: true };
}

function fromLegacy(raw: Record<string, unknown>, now: number, newId: () => string): Settings {
  const settings = emptySettings();
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey : "";
  const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : DEFAULT_MODEL;
  const backupModel = typeof raw.backupModel === "string" ? raw.backupModel.trim() : "";
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "";
  if (baseUrl) {
    settings.provider = "local";
    settings.providers.local = { apiKey: "", model, backupModel, baseUrl };
    settings.providers.openrouter = { apiKey, model: DEFAULT_MODEL, backupModel: "", baseUrl: "" };
  } else {
    settings.provider = "openrouter";
    settings.providers.openrouter = {
      apiKey,
      model: RETIRED_MODELS.includes(model) ? DEFAULT_MODEL : model,
      backupModel,
      baseUrl: "",
    };
  }
  settings.sites = sanitizeSites(raw.sites).sites;
  settings.savedTasks = legacyTasks(raw.savedTasks, now, newId);
  return settings;
}

function sanitizeV3(
  raw: Record<string, unknown>,
  now: number,
  newId: () => string,
): { settings: Settings; changed: boolean } {
  let changed = Object.keys(raw).some((key) => !["schemaVersion", "provider", "providers", "sites", "savedTasks", "privacy"].includes(key));
  const provider = isProvider(raw.provider) ? raw.provider : "openrouter";
  if (provider !== raw.provider) changed = true;

  const rawProviders = isRecord(raw.providers) ? raw.providers : {};
  if (!isRecord(raw.providers) || Object.keys(rawProviders).some((key) => !isProvider(key))) changed = true;
  const providers = {} as Record<ProviderId, ProviderConfig>;
  for (const id of PROVIDERS) {
    const result = sanitizeProvider(rawProviders[id], id);
    providers[id] = result.config;
    if (result.changed || !(id in rawProviders)) changed = true;
  }
  if (RETIRED_MODELS.includes(providers.openrouter.model)) {
    providers.openrouter = { ...providers.openrouter, model: DEFAULT_MODEL };
    changed = true;
  }

  const sites = sanitizeSites(raw.sites);
  const savedTasks = sanitizeTasks(raw.savedTasks, now, newId);
  const privacy = sanitizePrivacy(raw.privacy);
  if (sites.changed || savedTasks.changed || privacy.changed) changed = true;

  return {
    settings: { schemaVersion: 3, provider, providers, sites: sites.sites, savedTasks: savedTasks.tasks, privacy: privacy.privacy },
    changed,
  };
}

function sanitizeProvider(value: unknown, id: ProviderId): { config: ProviderConfig; changed: boolean } {
  const fallback = blankProvider(id);
  if (!isRecord(value)) return { config: fallback, changed: true };
  const config: ProviderConfig = {
    apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
    model: typeof value.model === "string" && value.model.trim() ? value.model.trim() : fallback.model,
    backupModel: typeof value.backupModel === "string" ? value.backupModel.trim() : "",
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl.trim() : "",
  };
  const known = ["apiKey", "model", "backupModel", "baseUrl"];
  const changed =
    Object.keys(value).some((key) => !known.includes(key)) ||
    config.apiKey !== value.apiKey ||
    config.model !== value.model ||
    config.backupModel !== value.backupModel ||
    config.baseUrl !== value.baseUrl;
  return { config, changed };
}

function sanitizeSites(value: unknown): { sites: SiteGrant[]; changed: boolean } {
  if (!Array.isArray(value)) return { sites: [], changed: true };
  let changed = false;
  const sites: SiteGrant[] = [];
  for (const item of value) {
    const site = sanitizeSite(item);
    if (!site || !sameSite(item, site)) changed = true;
    if (site) sites.push(site);
  }
  return { sites, changed };
}

function sanitizeSite(value: unknown): SiteGrant | null {
  if (!isRecord(value) || typeof value.host !== "string" || !value.host.includes(".")) return null;
  return { host: value.host, interact: Boolean(value.interact), post: Boolean(value.post) };
}

function sameSite(value: unknown, site: SiteGrant): boolean {
  if (!isRecord(value)) return false;
  const known = ["host", "interact", "post"];
  return (
    Object.keys(value).every((key) => known.includes(key)) &&
    value.host === site.host &&
    value.interact === site.interact &&
    value.post === site.post
  );
}

function legacyTasks(value: unknown, now: number, newId: () => string): SavedTask[] {
  if (!Array.isArray(value)) return [];
  const tasks: SavedTask[] = [];
  const names = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.task !== "string") continue;
    const name = item.name.trim();
    const task = item.task.trim();
    const key = name.toLowerCase();
    if (!name || !task || names.has(key)) continue;
    names.add(key);
    tasks.push({ id: newId(), name, task, createdAt: now });
  }
  return tasks;
}

function sanitizeTasks(
  value: unknown,
  now: number,
  newId: () => string,
): { tasks: SavedTask[]; changed: boolean } {
  if (!Array.isArray(value)) return { tasks: [], changed: true };
  let changed = false;
  const tasks: SavedTask[] = [];
  const names = new Set<string>();
  for (const item of value) {
    const saved = sanitizeTask(item, now, newId);
    if (!saved) {
      changed = true;
      continue;
    }
    const key = saved.task.name.toLowerCase();
    if (names.has(key)) {
      changed = true;
      continue;
    }
    names.add(key);
    if (saved.changed) changed = true;
    tasks.push(saved.task);
  }
  return { tasks, changed };
}

function sanitizeTask(
  value: unknown,
  now: number,
  newId: () => string,
): { task: SavedTask; changed: boolean } | null {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.task !== "string") return null;
  const name = value.name.trim();
  const task = value.task.trim();
  if (!name || !task) return null;
  let changed = name !== value.name || task !== value.task;
  let id = typeof value.id === "string" && value.id ? value.id : "";
  if (!id) {
    id = newId();
    changed = true;
  }
  const createdAt = typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : now;
  if (createdAt !== value.createdAt) changed = true;
  const saved: SavedTask = { id, name, task, createdAt };
  const lastRun = sanitizeLastRun(value.lastRun);
  if (lastRun === "invalid") changed = true;
  else if (lastRun) saved.lastRun = lastRun;
  const known = ["id", "name", "task", "createdAt", "lastRun"];
  if (Object.keys(value).some((key) => !known.includes(key))) changed = true;
  return { task: saved, changed };
}

function sanitizeLastRun(value: unknown): { at: number; status: RunStatus } | null | "invalid" {
  if (value == null) return null;
  if (!isRecord(value) || typeof value.at !== "number" || !RUN_STATUSES.includes(value.status as RunStatus)) return "invalid";
  if (Object.keys(value).some((key) => key !== "at" && key !== "status")) return "invalid";
  return { at: value.at, status: value.status as RunStatus };
}

function sanitizePrivacy(value: unknown): { privacy: { redactNumbers: boolean }; changed: boolean } {
  if (!isRecord(value) || typeof value.redactNumbers !== "boolean") return { privacy: { redactNumbers: true }, changed: true };
  const changed = Object.keys(value).some((key) => key !== "redactNumbers");
  return { privacy: { redactNumbers: value.redactNumbers }, changed };
}

function blankProvider(id: ProviderId): ProviderConfig {
  return { apiKey: "", model: id === "openrouter" ? DEFAULT_MODEL : "", backupModel: "", baseUrl: "" };
}

function isProvider(value: unknown): value is ProviderId {
  return PROVIDERS.includes(value as ProviderId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
