import { createBrowser } from "../browser.ts";
import { normalizeHost } from "../gate.ts";
import { runTask, type StepUpdate } from "../loop.ts";
import { createOpenRouterClient } from "../openrouter.ts";
import { loadSettings, saveSettings } from "../storage.ts";
import type { Settings } from "../types.ts";
import { DEFAULT_MODEL } from "../types.ts";

const settingsToggle = document.querySelector<HTMLButtonElement>("#settings-toggle")!;
const settingsPanel = document.querySelector<HTMLElement>("#settings")!;
const apiKeyInput = document.querySelector<HTMLInputElement>("#api-key")!;
const modelInput = document.querySelector<HTMLInputElement>("#model")!;
const saveKeyButton = document.querySelector<HTMLButtonElement>("#save-key")!;
const keyNote = document.querySelector<HTMLElement>("#key-note")!;
const addSiteForm = document.querySelector<HTMLFormElement>("#add-site")!;
const siteHostInput = document.querySelector<HTMLInputElement>("#site-host")!;
const siteNote = document.querySelector<HTMLElement>("#site-note")!;
const sitesList = document.querySelector<HTMLElement>("#sites")!;
const stepsList = document.querySelector<HTMLOListElement>("#steps")!;
const log = document.querySelector<HTMLElement>("#log")!;
const confirmBox = document.querySelector<HTMLElement>("#confirm")!;
const confirmText = document.querySelector<HTMLElement>("#confirm-text")!;
const confirmYes = document.querySelector<HTMLButtonElement>("#confirm-yes")!;
const confirmNo = document.querySelector<HTMLButtonElement>("#confirm-no")!;
const composer = document.querySelector<HTMLFormElement>("#composer")!;
const taskInput = document.querySelector<HTMLTextAreaElement>("#task")!;
const runButton = document.querySelector<HTMLButtonElement>("#run")!;
const stopButton = document.querySelector<HTMLButtonElement>("#stop")!;

let settings: Settings = { apiKey: "", model: DEFAULT_MODEL, sites: [] };
let abort: AbortController | null = null;
let resolveConfirm: ((approved: boolean) => void) | null = null;

settingsToggle.addEventListener("click", () => {
  settingsPanel.hidden = !settingsPanel.hidden;
});

saveKeyButton.addEventListener("click", () => {
  settings.apiKey = apiKeyInput.value.trim() || settings.apiKey;
  settings.model = modelInput.value.trim() || DEFAULT_MODEL;
  apiKeyInput.value = "";
  void saveSettings(settings).then(() => {
    keyNote.textContent = settings.apiKey ? "Key saved on this Mac." : "Add a key before running a task.";
  });
});

addSiteForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const host = normalizeHost(siteHostInput.value);
  if (!host) {
    siteNote.textContent = "Enter a site like youtube.com.";
    return;
  }
  if (settings.sites.some((site) => site.host === host)) {
    siteNote.textContent = `${host} is already allowed.`;
    return;
  }
  void chrome.permissions
    .request({ origins: [`https://${host}/*`, `https://*.${host}/*`] })
    .then(async (granted) => {
      if (!granted) {
        siteNote.textContent = "Brave did not grant access to that site.";
        return;
      }
      settings.sites.push({ host, interact: true, post: false });
      await saveSettings(settings);
      siteHostInput.value = "";
      siteNote.textContent = "";
      renderSites();
    });
});

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const task = taskInput.value.trim();
  if (!task || abort) return;
  if (!settings.apiKey) {
    settingsPanel.hidden = false;
    keyNote.textContent = "Add an OpenRouter key first.";
    return;
  }
  taskInput.value = "";
  void startTask(task);
});

stopButton.addEventListener("click", () => {
  abort?.abort();
  resolveConfirm?.(false);
  resolveConfirm = null;
});

confirmYes.addEventListener("click", () => settleConfirm(true));
confirmNo.addEventListener("click", () => settleConfirm(false));

void loadSettings().then((loaded) => {
  settings = loaded;
  modelInput.value = settings.model;
  keyNote.textContent = settings.apiKey ? "A key is saved on this Mac." : "Add a key before running a task.";
  renderSites();
  if (settings.sites.length === 0) {
    addMessage("jeco", "Add a site in Settings. Jeco acts only on sites you allow.");
  }
});

function renderSites(): void {
  sitesList.replaceChildren();
  for (const site of settings.sites) {
    const item = document.createElement("li");
    const host = document.createElement("span");
    host.className = "host";
    host.textContent = site.host;
    item.append(host, toggle("Interact", site.interact, (on) => updateSite(site.host, { interact: on })), toggle("Post", site.post, (on) => updateSite(site.host, { post: on })));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      settings.sites = settings.sites.filter((item) => item.host !== site.host);
      void chrome.permissions.remove({ origins: [`https://${site.host}/*`, `https://*.${site.host}/*`] });
      void saveSettings(settings);
      renderSites();
    });
    item.append(remove);
    sitesList.append(item);
  }
}

function toggle(label: string, checked: boolean, onChange: (on: boolean) => void): HTMLLabelElement {
  const wrap = document.createElement("label");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  wrap.append(input, document.createTextNode(label));
  return wrap;
}

function updateSite(host: string, patch: { interact?: boolean; post?: boolean }): void {
  settings.sites = settings.sites.map((site) => (site.host === host ? { ...site, ...patch } : site));
  void saveSettings(settings);
}

async function startTask(task: string): Promise<void> {
  abort = new AbortController();
  const signal = abort.signal;
  setBusy(true);
  stepsList.replaceChildren();
  addMessage("you", task);
  const browser = createBrowser(() => signal);
  const chat = createOpenRouterClient(settings.apiKey, settings.model || DEFAULT_MODEL);
  const result = await runTask({
    task,
    settings,
    browser,
    chat,
    signal,
    onStep: upsertStep,
    onConfirm: (summary) => {
      confirmText.textContent = summary;
      confirmBox.hidden = false;
      return new Promise((resolve) => {
        resolveConfirm = resolve;
      });
    },
  });
  confirmBox.hidden = true;
  resolveConfirm = null;
  addMessage("jeco", result.text);
  abort = null;
  setBusy(false);
}

function settleConfirm(approved: boolean): void {
  confirmBox.hidden = true;
  resolveConfirm?.(approved);
  resolveConfirm = null;
}

function setBusy(busy: boolean): void {
  runButton.disabled = busy;
  taskInput.disabled = busy;
  stopButton.hidden = !busy;
}

function upsertStep(step: StepUpdate): void {
  let item = stepsList.querySelector<HTMLLIElement>(`[data-step="${step.n}"]`);
  if (!item) {
    item = document.createElement("li");
    item.dataset.step = String(step.n);
    const number = document.createElement("span");
    number.className = "n";
    number.textContent = String(step.n).padStart(2, "0");
    const label = document.createElement("span");
    label.className = "label";
    item.append(number, label);
    stepsList.append(item);
  }
  item.className = step.state;
  const label = item.querySelector(".label");
  if (label) label.textContent = step.label;
  item.scrollIntoView({ block: "nearest" });
}

function addMessage(role: "you" | "jeco", text: string): void {
  const bubble = document.createElement("div");
  bubble.className = `bubble ${role}`;
  bubble.textContent = text;
  log.append(bubble);
}
