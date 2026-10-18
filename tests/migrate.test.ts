import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MODEL, RETIRED_MODELS } from "../src/limits.ts";
import { emptySettings, migrateSettings } from "../src/storage/migrate.ts";
import type { Settings } from "../src/types.ts";

const NOW = 1_700_000_000_000;

function ids(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `id-${n}`;
  };
}

test("garbage input becomes empty v3 settings", () => {
  for (const raw of [null, undefined, "settings", 3, []]) {
    const { settings, changed } = migrateSettings(raw, NOW, ids());
    assert.equal(changed, true);
    assert.equal(settings.schemaVersion, 3);
    assert.equal(settings.provider, "openrouter");
    assert.equal(settings.providers.openrouter.model, DEFAULT_MODEL);
    assert.equal(settings.providers.openrouter.apiKey, "");
    assert.equal(settings.providers.openai.model, "");
    assert.equal(settings.providers.xai.model, "");
    assert.equal(settings.providers.local.baseUrl, "");
    assert.deepEqual(settings.sites, []);
    assert.deepEqual(settings.savedTasks, []);
    assert.equal(settings.privacy.redactNumbers, true);
  }
});

test("a v1 shape keeps the key, model, and sites", () => {
  const { settings, changed } = migrateSettings(
    {
      apiKey: "sk-test",
      model: "google/gemma-4-26b-a4b-it:free",
      sites: [{ host: "youtube.com", interact: true, post: false }],
    },
    NOW,
    ids(),
  );
  assert.equal(changed, true);
  assert.equal(settings.provider, "openrouter");
  assert.equal(settings.providers.openrouter.apiKey, "sk-test");
  assert.equal(settings.providers.openrouter.model, "google/gemma-4-26b-a4b-it:free");
  assert.equal(settings.providers.openrouter.backupModel, "");
  assert.equal(settings.providers.local.baseUrl, "");
  assert.deepEqual(settings.sites, [{ host: "youtube.com", interact: true, post: false }]);
  assert.deepEqual(settings.savedTasks, []);
});

test("a v2 shape keeps the backup model and saved tasks", () => {
  const { settings } = migrateSettings(
    {
      apiKey: "sk-test",
      model: "google/gemma-4-26b-a4b-it:free",
      backupModel: "backup-model",
      savedTasks: [{ name: "Morning", task: "Read the news" }],
      sites: [{ host: "youtube.com", interact: true, post: false }, { host: "nope" }],
    },
    NOW,
    ids(),
  );
  assert.equal(settings.provider, "openrouter");
  assert.equal(settings.providers.openrouter.backupModel, "backup-model");
  assert.deepEqual(settings.savedTasks, [{ id: "id-1", name: "Morning", task: "Read the news", createdAt: NOW }]);
  assert.deepEqual(settings.sites, [{ host: "youtube.com", interact: true, post: false }]);
});

test("a v2 base URL becomes the local provider and keeps the OpenRouter key", () => {
  const { settings } = migrateSettings(
    {
      apiKey: "sk-test",
      model: "llama3.2",
      backupModel: "llama3.1",
      baseUrl: " http://localhost:11434/v1 ",
      sites: [],
    },
    NOW,
    ids(),
  );
  assert.equal(settings.provider, "local");
  assert.deepEqual(settings.providers.local, {
    apiKey: "",
    model: "llama3.2",
    backupModel: "llama3.1",
    baseUrl: "http://localhost:11434/v1",
  });
  assert.deepEqual(settings.providers.openrouter, {
    apiKey: "sk-test",
    model: DEFAULT_MODEL,
    backupModel: "",
    baseUrl: "",
  });
});

test("a retired OpenRouter model becomes the default", () => {
  const { settings } = migrateSettings(
    { apiKey: "sk-test", model: RETIRED_MODELS[0], backupModel: "", sites: [] },
    NOW,
    ids(),
  );
  assert.equal(settings.providers.openrouter.model, DEFAULT_MODEL);
});

test("saved tasks get ids, and empty or duplicate names are dropped", () => {
  const { settings } = migrateSettings(
    {
      apiKey: "",
      model: DEFAULT_MODEL,
      savedTasks: [
        { name: "Morning", task: "Read the news" },
        { name: "  ", task: "nothing" },
        { name: "morning", task: "A second copy" },
        { name: "Evening", task: "" },
        { name: "Evening", task: "Read mail" },
        "nope",
      ],
    },
    NOW,
    ids(),
  );
  assert.deepEqual(
    settings.savedTasks.map((task) => task.name),
    ["Morning", "Evening"],
  );
  assert.deepEqual(
    settings.savedTasks.map((task) => task.id),
    ["id-1", "id-2"],
  );
});

test("clean v3 settings are left alone", () => {
  const settings: Settings = emptySettings();
  settings.providers.openrouter.apiKey = "sk-test";
  settings.sites = [{ host: "youtube.com", interact: true, post: false }];
  settings.savedTasks = [{ id: "kept", name: "Morning", task: "Read the news", createdAt: NOW }];
  const first = migrateSettings(settings, NOW, () => {
    throw new Error("newId");
  });
  assert.equal(first.changed, false);
  assert.deepEqual(first.settings, settings);
  const second = migrateSettings(first.settings, NOW + 10, () => {
    throw new Error("newId");
  });
  assert.equal(second.changed, false);
  assert.deepEqual(second.settings, first.settings);
});

test("a v3 task missing an id is repaired once", () => {
  const raw = emptySettings();
  const broken = {
    ...raw,
    savedTasks: [{ name: "Morning", task: "Read the news" }],
  };
  const { settings, changed } = migrateSettings(broken, NOW, ids());
  assert.equal(changed, true);
  assert.equal(settings.savedTasks[0].id, "id-1");
  assert.equal(settings.savedTasks[0].createdAt, NOW);
  const again = migrateSettings(settings, NOW + 5, () => {
    throw new Error("newId");
  });
  assert.equal(again.changed, false);
});
