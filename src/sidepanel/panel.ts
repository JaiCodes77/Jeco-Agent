import { createBrowser } from "../browser/browser.ts";
import { runTask } from "../engine/loop.ts";
import { DEFAULT_MODEL } from "../limits.ts";
import { baseUrlTarget, createClient } from "../model/client.ts";
import { normalizeHost } from "../safety/hosts.ts";
import { emptySettings } from "../storage/migrate.ts";
import { loadSettings, onSettingsChanged, saveSettings } from "../storage/settings.ts";
import type { ConfirmRequest, Settings, StepUpdate } from "../types.ts";

const CONFIRM_COPY: Record<ConfirmRequest["kind"], { title: string; yes: string; no: string }> = {
  play: { title: "Play", yes: "Play it", no: "Don't play" },
  publish: { title: "Post", yes: "Post it", no: "Don't post" },
  risky: { title: "Check this", yes: "Do it", no: "Don't do it" },
  scope: { title: "Another site", yes: "Allow for this run", no: "No" },
  "more-steps": { title: "More steps", yes: "More steps", no: "Stop here" },
};

const settingsToggle = document.querySelector<HTMLButtonElement>("#settings-toggle")!;
const settingsPanel = document.querySelector<HTMLElement>("#settings")!;
const apiKeyInput = document.querySelector<HTMLInputElement>("#api-key")!;
const modelInput = document.querySelector<HTMLInputElement>("#model")!;
const backupModelInput = document.querySelector<HTMLInputElement>("#backup-model")!;
const baseUrlInput = document.querySelector<HTMLInputElement>("#base-url")!;
const saveKeyButton = document.querySelector<HTMLButtonElement>("#save-key")!;
const keyNote = document.querySelector<HTMLElement>("#key-note")!;
const addSiteForm = document.querySelector<HTMLFormElement>("#add-site")!;
const siteHostInput = document.querySelector<HTMLInputElement>("#site-host")!;
const siteNote = document.querySelector<HTMLElement>("#site-note")!;
const sitesList = document.querySelector<HTMLElement>("#sites")!;
const stepsList = document.querySelector<HTMLOListElement>("#steps")!;
const log = document.querySelector<HTMLElement>("#log")!;
const planBox = document.querySelector<HTMLElement>("#plan")!;
const planLines = document.querySelector<HTMLOListElement>("#plan-lines")!;
const planStart = document.querySelector<HTMLButtonElement>("#plan-start")!;
const planCancel = document.querySelector<HTMLButtonElement>("#plan-cancel")!;
const confirmBox = document.querySelector<HTMLElement>("#confirm")!;
const confirmTitle = document.querySelector<HTMLElement>("#confirm-title")!;
const confirmImage = document.querySelector<HTMLImageElement>("#confirm-image")!;
const confirmText = document.querySelector<HTMLElement>("#confirm-text")!;
const confirmYes = document.querySelector<HTMLButtonElement>("#confirm-yes")!;
const confirmNo = document.querySelector<HTMLButtonElement>("#confirm-no")!;
const composer = document.querySelector<HTMLFormElement>("#composer")!;
const taskInput = document.querySelector<HTMLTextAreaElement>("#task")!;
const taskNameField = document.querySelector<HTMLElement>("#task-name-field")!;
const taskNameInput = document.querySelector<HTMLInputElement>("#task-name")!;
const saveTaskButton = document.querySelector<HTMLButtonElement>("#save-task")!;
const savedTasksList = document.querySelector<HTMLElement>("#saved-tasks")!;
const runButton = document.querySelector<HTMLButtonElement>("#run")!;
const stopButton = document.querySelector<HTMLButtonElement>("#stop")!;
const foot = document.querySelector<HTMLElement>("#foot")!;

let settings: Settings = emptySettings();
let abort: AbortController | null = null;
let resolveConfirm: ((approved: boolean) => void) | null = null;
let resolvePlan: ((approved: boolean) => void) | null = null;
let finishedTask = "";

settingsToggle.addEventListener("click", () => {
  settingsPanel.hidden = !settingsPanel.hidden;
});

saveKeyButton.addEventListener("click", () => {
  const baseUrl = baseUrlInput.value.trim();
  const target = baseUrl ? baseUrlTarget(baseUrl) : null;
  if (target && "error" in target) {
    keyNote.textContent = target.error;
    return;
  }
  const allowed = target ? chrome.permissions.request({ origins: [target.pattern] }) : Promise.resolve(true);
  const typedKey = apiKeyInput.value.trim();
  const model = modelInput.value.trim() || DEFAULT_MODEL;
  const backupModel = backupModelInput.value.trim();
  apiKeyInput.value = "";
  if (typedKey) settings.providers.openrouter.apiKey = typedKey;
  if (baseUrl) {
    settings.provider = "local";
    settings.providers.local = { apiKey: "", model, backupModel, baseUrl };
  } else {
    settings.provider = "openrouter";
    settings.providers.openrouter = {
      apiKey: typedKey || settings.providers.openrouter.apiKey,
      model,
      backupModel,
      baseUrl: "",
    };
  }
  void allowed
    .catch(() => false)
    .then(async (granted) => {
      await saveSettings(settings);
      renderFoot();
      if (target && !granted) {
        keyNote.textContent = `Saved, but Brave did not allow Jeco to reach ${target.label}. Press Save again to allow it.`;
      } else {
        keyNote.textContent = readyNote();
      }
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
  if (!task || abort || !readyToRun()) return;
  taskInput.value = "";
  void startTask(task);
});

taskNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") event.preventDefault();
});

saveTaskButton.addEventListener("click", () => {
  const name = taskNameInput.value.trim();
  if (!name || !finishedTask) {
    taskNameInput.focus();
    return;
  }
  settings.savedTasks = [
    ...settings.savedTasks,
    { id: crypto.randomUUID(), name, task: finishedTask, createdAt: Date.now() },
  ];
  taskNameInput.value = "";
  void saveSettings(settings);
  renderSavedTasks();
});

stopButton.addEventListener("click", () => {
  abort?.abort();
  resolveConfirm?.(false);
  resolveConfirm = null;
  resolvePlan?.(false);
  resolvePlan = null;
});

confirmYes.addEventListener("click", () => settleConfirm(true));
confirmNo.addEventListener("click", () => settleConfirm(false));
planStart.addEventListener("click", () => settlePlan(true));
planCancel.addEventListener("click", () => settlePlan(false));

void loadSettings().then((loaded) => {
  showSettings(loaded);
  if (settings.sites.length === 0) {
    addMessage("jeco", "Add a site in Settings. Jeco acts only on sites you allow.");
  }
  onSettingsChanged((next) => {
    if (abort || JSON.stringify(next) === JSON.stringify(settings)) return;
    showSettings(next);
  });
});

function showSettings(next: Settings): void {
  settings = next;
  const active = settings.providers[settings.provider];
  modelInput.value = active.model;
  backupModelInput.value = active.backupModel;
  baseUrlInput.value = settings.provider === "local" ? active.baseUrl : "";
  keyNote.textContent = readyNote();
  renderFoot();
  renderSites();
  renderSavedTasks();
}

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

function renderSavedTasks(): void {
  savedTasksList.replaceChildren();
  for (const saved of settings.savedTasks) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.className = "host";
    name.textContent = saved.name;
    const run = document.createElement("button");
    run.type = "button";
    run.className = "button";
    run.textContent = "Run";
    run.addEventListener("click", () => {
      if (!saved.task || abort || !readyToRun()) return;
      void startTask(saved.task);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      settings.savedTasks = settings.savedTasks.filter((item) => item.id !== saved.id);
      void saveSettings(settings);
      renderSavedTasks();
    });
    item.append(name, run, remove);
    savedTasksList.append(item);
  }
}

function updateSite(host: string, patch: { interact?: boolean; post?: boolean }): void {
  settings.sites = settings.sites.map((site) => (site.host === host ? { ...site, ...patch } : site));
  void saveSettings(settings);
}

function readyToRun(): boolean {
  const active = settings.providers[settings.provider];
  if (settings.provider === "local" ? active.baseUrl : active.apiKey) return true;
  settingsPanel.hidden = false;
  keyNote.textContent = "Add an OpenRouter key first, or a local base URL.";
  return false;
}

function readyNote(): string {
  if (settings.provider === "local" && settings.providers.local.baseUrl) {
    return "Jeco will use the model server at the base URL.";
  }
  return settings.providers.openrouter.apiKey ? "A key is saved on this Mac." : "Add a key before running a task.";
}

function renderFoot(): void {
  const baseUrl = settings.provider === "local" ? settings.providers.local.baseUrl : "";
  const target = baseUrl ? baseUrlTarget(baseUrl) : null;
  let where = "Page text from each step is sent to OpenRouter.";
  if (target && "error" in target) where = `Page text from each step is sent to ${baseUrl}.`;
  else if (target?.local) where = `Page text stays on this Mac (local model at ${target.label}).`;
  else if (target) where = `Page text from each step is sent to ${target.label}.`;
  foot.textContent = `${where} Logins stay in Brave.`;
}

async function modelAllowed(): Promise<boolean> {
  const baseUrl = settings.provider === "local" ? settings.providers.local.baseUrl : "";
  if (!baseUrl) return true;
  const target = baseUrlTarget(baseUrl);
  if ("error" in target) {
    addMessage("jeco", `${target.error} Fix the base URL in Settings.`);
    return false;
  }
  const granted = await chrome.permissions.contains({ origins: [target.pattern] }).catch(() => false);
  if (!granted) {
    settingsPanel.hidden = false;
    addMessage("jeco", `Allow Jeco to reach ${target.label}: press Save in Settings.`);
  }
  return granted;
}

function showConfirm(request: ConfirmRequest): Promise<boolean> {
  const copy = CONFIRM_COPY[request.kind];
  confirmTitle.textContent = copy.title;
  confirmYes.textContent = request.kind === "more-steps" ? `${request.extra} more steps` : copy.yes;
  confirmNo.textContent = copy.no;
  const lines = [confirmSummary(request)];
  if (!request.image && request.outlined) lines.push("The control is outlined in the tab.");
  confirmText.textContent = lines.join("\n\n");
  if (request.image) {
    confirmImage.src = request.image;
    confirmImage.hidden = false;
  } else {
    confirmImage.removeAttribute("src");
    confirmImage.hidden = true;
  }
  confirmBox.hidden = false;
  confirmNo.focus();
  return new Promise((resolve) => {
    resolveConfirm = resolve;
  });
}

function confirmSummary(request: ConfirmRequest): string {
  switch (request.kind) {
    case "play": {
      const lines = [`Play on ${request.host}?`, `Control: ${request.control}`];
      if (request.context) lines.push(request.context);
      return lines.join("\n\n");
    }
    case "risky":
      return `${request.reason}\n\nClick "${request.control}" on ${request.host}?`;
    case "scope":
      return `Jeco wants to use ${request.host} too. It was not in the plan.`;
    case "more-steps":
      return `Jeco used ${request.used} steps without finishing. Give it ${request.extra} more?`;
    case "publish": {
      if (request.text == null) {
        return `Click "${request.control}" on ${request.host}?\n\nThis publishes on ${request.host}. Jeco cannot show text for this click.`;
      }
      const detail = `${request.chars ?? request.text.length} characters, typed into "${request.field ?? "the field"}". Jeco will press "${request.control}".`;
      return [`Post this on ${request.host}?`, request.text, detail, request.warn].filter(Boolean).join("\n\n");
    }
  }
}

async function startTask(task: string): Promise<void> {
  if (!(await modelAllowed())) {
    if (!taskInput.value) taskInput.value = task;
    return;
  }
  abort = new AbortController();
  const signal = abort.signal;
  setBusy(true);
  setSaveOffer(false);
  stepsList.replaceChildren();
  addMessage("you", task);
  const browser = createBrowser(() => signal);
  const chat = createClient(settings);
  const result = await runTask({
    task,
    settings,
    browser,
    chat,
    signal,
    hooks: {
      onStep: upsertStep,
      onPlan: (plan) => {
        planLines.replaceChildren();
        for (const line of plan.lines) {
          const item = document.createElement("li");
          item.textContent = line;
          planLines.append(item);
        }
        planBox.hidden = false;
        return new Promise((resolve) => {
          resolvePlan = resolve;
        });
      },
      onConfirm: showConfirm,
      onEvent: () => {},
    },
  });
  planBox.hidden = true;
  confirmBox.hidden = true;
  resolveConfirm = null;
  addMessage("jeco", result.text);
  abort = null;
  setBusy(false);
  if (result.status === "done") {
    finishedTask = task;
    setSaveOffer(true);
  }
}

function setSaveOffer(show: boolean): void {
  taskNameField.hidden = !show;
  saveTaskButton.hidden = !show;
  if (!show) taskNameInput.value = "";
}

function settleConfirm(approved: boolean): void {
  confirmBox.hidden = true;
  confirmImage.hidden = true;
  resolveConfirm?.(approved);
  resolveConfirm = null;
}

function settlePlan(approved: boolean): void {
  planBox.hidden = true;
  resolvePlan?.(approved);
  resolvePlan = null;
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
