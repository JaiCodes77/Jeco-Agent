import { STEP_CAP } from "../limits.ts";
import { packHint } from "../recipes/hints.ts";
import { decide, fingerprint, parseToolCall } from "../safety/gate.ts";
import { grantForUrl } from "../safety/hosts.ts";
import { classifyControl } from "../safety/risk.ts";
import type {
  BrowserPort,
  ChatClient,
  ChatMessage,
  ConfirmRequest,
  ConfirmSpec,
  PageElement,
  Plan,
  RunHooks,
  RunResult,
  Settings,
  ToolCall,
} from "../types.ts";
import { formatSnapshot } from "./context.ts";
import { clearPreview, postFlow, previewControl } from "./post-flow.ts";
import { NUDGE, PLAN_SYSTEM, SYSTEM } from "./prompt.ts";

const STOPPED: RunResult = { status: "stopped", text: "Stopped." };

export async function runTask(options: {
  task: string;
  settings: Settings;
  browser: BrowserPort;
  chat: ChatClient;
  signal: AbortSignal;
  hooks: RunHooks;
}): Promise<RunResult> {
  const { browser, chat, signal, settings, hooks } = options;
  if (signal.aborted) return STOPPED;

  let lines: Plan["lines"];
  let source: Plan["source"] = "model";
  try {
    lines = await planWith(chat, options.task, signal);
  } catch (error) {
    if (signal.aborted || isAbort(error)) return STOPPED;
    lines = backupPlan(options.task);
    source = "fallback";
  }

  if (signal.aborted) return STOPPED;
  const plan: Plan = { lines, sites: [], missing: [], scope: null, source };
  const accepted = await confirmOrAbort(hooks.onPlan(plan), signal);
  if (!accepted || signal.aborted) return STOPPED;

  let current = await browser.activeTab();
  let elements: PageElement[] = [];
  let nudged = false;
  let posted = false;
  const scope: string[] | null = null;
  const wary = false;
  const messages: ChatMessage[] = [
    { role: "system", content: [SYSTEM, packHint(options.task)].filter(Boolean).join("\n\n") },
    { role: "user", content: withPlan(options.task, lines) },
  ];

  for (let step = 1; step <= STEP_CAP; step += 1) {
    if (signal.aborted) return STOPPED;
    hooks.onStep({ n: step, label: "Thinking", state: "run" });

    let turn;
    try {
      turn = await chat({ messages, tools: true, purpose: "step", signal });
    } catch (error) {
      if (signal.aborted || isAbort(error)) return STOPPED;
      const text = error instanceof Error ? error.message : "The model request failed.";
      hooks.onStep({ n: step, label: "Stopped", state: "no" });
      return { status: "error", text };
    }

    if (turn.toolCalls.length === 0) {
      const text = turn.content?.trim() || "Jeco finished without an answer.";
      if (!nudged && step < STEP_CAP) {
        nudged = true;
        messages.push({ role: "assistant", content: text });
        messages.push({ role: "user", content: NUDGE });
        hooks.onStep({ n: step, label: "Asked for an action", state: "no" });
        continue;
      }
      return { status: "done", text };
    }

    const [first, ...rest] = turn.toolCalls;
    messages.push({
      role: "assistant",
      content: turn.content,
      tool_calls: turn.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      })),
    });
    for (const extra of rest) {
      messages.push({
        role: "tool",
        tool_call_id: extra.id,
        content: "Ignored. One action at a time.",
      });
    }

    const parsed = parseToolCall(first.name, first.args);
    if ("error" in parsed) {
      messages.push({ role: "tool", tool_call_id: first.id, content: parsed.error });
      hooks.onStep({ n: step, label: parsed.error, state: "no" });
      continue;
    }

    const decision = decide(parsed, {
      sites: settings.sites,
      pageUrl: current?.url ?? null,
      elements,
      stepsUsed: step,
      stepCap: STEP_CAP,
      scope,
      posted,
      wary,
    });

    if (decision.kind === "deny") {
      messages.push({ role: "tool", tool_call_id: first.id, content: decision.reason });
      hooks.onStep({ n: step, label: decision.reason, state: "no" });
      continue;
    }

    if (decision.kind === "finish") {
      hooks.onStep({ n: step, label: "Finished", state: "ok" });
      return { status: "done", text: decision.answer.trim() || "Done." };
    }

    if (decision.kind === "confirm" && parsed.name !== "ask_to_post") {
      hooks.onStep({ n: step, label: "Waiting for you", state: "wait" });
      const ref = parsed.name === "click" ? parsed.args.ref : undefined;
      const approved = await askUser(decision.confirm, ref);
      if (!approved) {
        if (signal.aborted) return STOPPED;
        messages.push({
          role: "tool",
          tool_call_id: first.id,
          content: "The user did not confirm. Do not continue that click.",
        });
        hooks.onStep({ n: step, label: "Not confirmed", state: "no" });
        continue;
      }
    }

    try {
      const outcome = await perform(parsed, step);
      messages.push({ role: "tool", tool_call_id: first.id, content: outcome });
    } catch (error) {
      if (signal.aborted || isAbort(error)) return STOPPED;
      const message = friendlyBrowserError(error);
      messages.push({ role: "tool", tool_call_id: first.id, content: message });
      hooks.onStep({ n: step, label: message, state: "no" });
    }
  }

  return { status: "capped", text: `Stopped after ${STEP_CAP} steps without finishing.` };

  async function askUser(spec: ConfirmSpec, ref?: number): Promise<boolean> {
    const tabId = current?.id;
    if (tabId == null || ref == null) {
      return confirmOrAbort(hooks.onConfirm({ ...spec, image: null, outlined: false }), signal);
    }
    const label = spec.kind === "play" ? "Jeco will press Play" : "Jeco will press this";
    const preview = await previewControl(browser, tabId, ref, label);
    try {
      return await confirmOrAbort(hooks.onConfirm({ ...spec, ...preview }), signal);
    } finally {
      await clearPreview(browser, tabId);
    }
  }

  async function perform(call: ToolCall, step: number): Promise<string> {
    if (call.name === "finish") return call.args.answer;
    if (call.name === "open_tab") {
      hooks.onStep({ n: step, label: `Open ${shortUrl(call.args.url)}`, state: "run" });
      current = await browser.openTab(call.args.url);
      elements = [];
      if (!keptOnAllowlist(current.url)) {
        await browser.close(current.id);
        current = await browser.activeTab();
        hooks.onStep({ n: step, label: "Closed a page outside the allowlist", state: "no" });
        return "That page left the allowlist. The tab was closed.";
      }
      await browser.settle(current.id);
      hooks.onStep({ n: step, label: `Opened ${shortUrl(current.url)}`, state: "ok" });
      return `Opened ${current.url}`;
    }
    if (call.name === "navigate") {
      if (!current) return "No tab is open. Use open_tab.";
      hooks.onStep({ n: step, label: `Go to ${shortUrl(call.args.url)}`, state: "run" });
      const tabId = current.id;
      current = await browser.navigate(tabId, call.args.url);
      elements = [];
      if (!keptOnAllowlist(current.url)) {
        await browser.back(tabId);
        const restored = await browser.urlOf(tabId);
        current = restored ? { id: tabId, url: restored } : null;
        hooks.onStep({ n: step, label: "Went back", state: "no" });
        return "That page redirected off the allowlist. Jeco went back.";
      }
      await browser.settle(tabId);
      hooks.onStep({ n: step, label: `At ${shortUrl(current.url)}`, state: "ok" });
      return `Now at ${current.url}`;
    }
    if (!current) return "No tab is open. Use open_tab.";

    if (call.name === "read_page") {
      const result = await browser.act(current.id, { op: "read" });
      if (!result.ok) {
        hooks.onStep({ n: step, label: result.error, state: "no" });
        return result.error;
      }
      if (result.op !== "read") return "The page returned an unexpected result.";
      elements = result.elements;
      current = { id: current.id, url: result.url };
      hooks.onStep({ n: step, label: `Read ${result.title || shortUrl(result.url)}`, state: "ok" });
      return formatSnapshot(result);
    }

    if (call.name === "scroll") {
      hooks.onStep({ n: step, label: "Scroll", state: "run" });
      const result = await browser.act(current.id, { op: "scroll", dy: call.args.dy });
      if (!result.ok) {
        hooks.onStep({ n: step, label: result.error, state: "no" });
        return result.error;
      }
      hooks.onStep({ n: step, label: "Scrolled", state: "ok" });
      return (await leftAllowlist(step)) ?? (result.op === "scroll" ? result.detail : "Scrolled.");
    }

    if (call.name === "ask_to_post") return post(call.args, step);
    if (call.name === "find" || call.name === "press_enter" || call.name === "go_back") {
      return "That action is not available yet.";
    }

    const element = elements.find((item) => item.ref === call.args.ref);
    if (!element) return "That control number is not on the page. Call read_page again.";
    const name = element.name || String(element.ref);

    if (call.name === "click") {
      hooks.onStep({ n: step, label: `Click ${name}`, state: "run" });
      const result = await browser.act(current.id, { op: "click", ref: element.ref, expect: fingerprint(element) });
      if (!result.ok) return failedAction(result.error, result.stale, step);
      if (classifyControl(element.name, element.kind) === "publish") posted = true;
      await browser.settle(current.id);
      hooks.onStep({ n: step, label: `Clicked ${name}`, state: "ok" });
      return (await leftAllowlist(step)) ?? (result.op === "click" ? result.detail : "Clicked.");
    }

    hooks.onStep({ n: step, label: `Type into "${name}"`, state: "run" });
    const result = await browser.act(current.id, {
      op: "type",
      ref: element.ref,
      text: call.args.text,
      expect: fingerprint(element),
    });
    if (!result.ok) return failedAction(result.error, result.stale, step);
    await browser.settle(current.id, { quietMs: 200, maxMs: 1000 });
    hooks.onStep({ n: step, label: `Typed into "${name}"`, state: "ok" });
    return (await leftAllowlist(step)) ?? (result.op === "type" ? result.detail : "Typed.");
  }

  async function post(args: { text: string; field: number; button?: number }, step: number): Promise<string> {
    if (!current) return "No tab is open. Use open_tab.";
    const host = grantForUrl(current.url, settings.sites)?.host ?? shortUrl(current.url);
    hooks.onStep({ n: step, label: "Preparing the post", state: "run" });
    const outcome = await postFlow({
      browser,
      tabId: current.id,
      host,
      text: args.text,
      field: args.field,
      button: args.button,
      confirm: (request) => confirmOrAbort(hooks.onConfirm(request), signal),
      onWaiting: () => hooks.onStep({ n: step, label: "Waiting for you", state: "wait" }),
    });
    const fresh = new Set(outcome.elements.map((item) => item.ref));
    elements = [...elements.filter((item) => !fresh.has(item.ref)), ...outcome.elements];

    if (outcome.status === "failed") {
      elements = [];
      hooks.onStep({ n: step, label: outcome.message, state: "no" });
      return outcome.message;
    }
    if (outcome.status === "declined") {
      hooks.onStep({ n: step, label: "Not posted", state: "no" });
      return outcome.message;
    }
    posted = true;
    hooks.onStep({ n: step, label: outcome.verified ? "Posted" : "Pressed post", state: "ok" });
    const drifted = await leftAllowlist(step);
    return drifted ? `${outcome.message} ${drifted}` : outcome.message;
  }

  function failedAction(error: string, stale: boolean | undefined, step: number): string {
    if (stale) elements = [];
    hooks.onStep({ n: step, label: error, state: "no" });
    return error;
  }

  async function leftAllowlist(step: number): Promise<string | null> {
    if (!current) return "No tab is open.";
    const live = await browser.urlOf(current.id);
    if (live && keptOnAllowlist(live)) {
      current = { id: current.id, url: live };
      return null;
    }
    await browser.back(current.id);
    const restored = await browser.urlOf(current.id);
    current = restored ? { id: current.id, url: restored } : current;
    elements = [];
    hooks.onStep({ n: step, label: "Went back", state: "no" });
    return "That action left the allowlist. Jeco went back.";
  }

  function keptOnAllowlist(url: string): boolean {
    return grantForUrl(url, settings.sites) != null;
  }
}

async function confirmOrAbort(pending: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  return new Promise((resolve) => {
    const onAbort = () => resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      () => resolve(false),
    );
  });
}

function friendlyBrowserError(error: unknown): string {
  const message = error instanceof Error ? error.message : "The browser action failed.";
  if (/cannot access|the specified tab|host permission|extensions gallery/i.test(message)) {
    return "Jeco cannot access that tab. Add the site in Settings.";
  }
  return message;
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`.slice(0, 48);
  } catch {
    return url.slice(0, 48);
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function withPlan(task: string, lines: string[]): string {
  const steps = lines.map((line, index) => `${index + 1}. ${line}`).join("\n");
  return `${task}\n\nApproved plan:\n${steps}`;
}

async function planWith(chat: ChatClient, task: string, signal: AbortSignal): Promise<Plan["lines"]> {
  const turn = await chat({
    messages: [
      { role: "system", content: PLAN_SYSTEM },
      { role: "user", content: task },
    ],
    tools: false,
    purpose: "plan",
    signal,
  });
  return planLines(turn.content, task);
}

function planLines(content: string | null, task: string): Plan["lines"] {
  const spoken = (content ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const backup = backupPlan(task);
  const lines = spoken.slice(0, 3);
  for (let i = lines.length; i < 3; i += 1) lines.push(backup[i]);
  return [lines[0], lines[1], lines[2]];
}

function backupPlan(task: string): [string, string, string] {
  const brief = task.trim().replace(/\s+/g, " ").slice(0, 72);
  const subject = brief || "the task";
  return [
    `Read the request: ${subject}`,
    "Carry out that request in the browser",
    "Finish with a short answer",
  ];
}
