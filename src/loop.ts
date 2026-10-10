import { decide, grantForUrl, parseToolCall } from "./gate.ts";
import { formatSnapshot } from "./snapshot.ts";
import type {
  BrowserPort,
  ChatClient,
  ChatMessage,
  PageElement,
  Settings,
  ToolCall,
} from "./types.ts";
import { STEP_CAP } from "./types.ts";
import { packHint } from "./packs.ts";

const SYSTEM = [
  "You are Jeco. You act in the user's Brave browser by calling tools. You do not invent what a page says.",
  "Call one tool, then wait for the result.",
  "Call read_page before click or type when you do not already have control numbers.",
  "Open or navigate only to https pages. If a tool result says a site is not allowed, stop that approach and call finish with what the user should add.",
  "To publish, call ask_to_post with the exact text. Never click Post, Tweet, Reply, Send, Submit, or Publish yourself.",
  "To play a video, open it. If a control is named Play, click it once. Never click Pause.",
  "Never type into a password or payment field.",
  "When the task is done, call finish with a short answer for the user.",
].join("\n");

export type StepUpdate = {
  n: number;
  label: string;
  state: "run" | "ok" | "no" | "wait";
};

const PLAN_SYSTEM = "Reply with exactly 3 short lines of the plan. Do not call tools.";

export async function runTask(options: {
  task: string;
  settings: Settings;
  browser: BrowserPort;
  chat: ChatClient;
  signal: AbortSignal;
  onStep: (step: StepUpdate) => void;
  onConfirm: (summary: string, image?: string | null) => Promise<boolean>;
  onPlan?: (lines: string[]) => Promise<boolean>;
}): Promise<{ status: "done" | "stopped" | "error"; text: string }> {
  const { browser, chat, signal, settings, onStep, onPlan = async () => true } = options;
  if (signal.aborted) return { status: "stopped", text: "Stopped." };

  let lines: string[];
  try {
    lines = await planWith(chat, options.task, signal);
  } catch (error) {
    if (signal.aborted || isAbort(error)) return { status: "stopped", text: "Stopped." };
    const text = error instanceof Error ? error.message : "The model request failed.";
    return { status: "error", text };
  }

  if (signal.aborted) return { status: "stopped", text: "Stopped." };
  const accepted = await confirmOrAbort(onPlan(lines), signal);
  if (!accepted || signal.aborted) return { status: "stopped", text: "Stopped." };

  let current = await browser.activeTab();
  let elements: PageElement[] = [];
  let nudged = false;
  const messages: ChatMessage[] = [
    { role: "system", content: [SYSTEM, packHint(options.task)].filter(Boolean).join("\n\n") },
    { role: "user", content: options.task },
  ];

  for (let step = 1; step <= STEP_CAP; step += 1) {
    if (signal.aborted) return { status: "stopped", text: "Stopped." };
    onStep({ n: step, label: "Thinking", state: "run" });

    let turn;
    try {
      turn = await chat(messages, signal);
    } catch (error) {
      if (signal.aborted || isAbort(error)) return { status: "stopped", text: "Stopped." };
      const text = error instanceof Error ? error.message : "The model request failed.";
      onStep({ n: step, label: "Stopped", state: "no" });
      return { status: "error", text };
    }

    if (turn.toolCalls.length === 0) {
      const text = turn.content?.trim() || "Jeco finished without an answer.";
      if (!nudged && step < STEP_CAP) {
        nudged = true;
        messages.push({ role: "assistant", content: text });
        messages.push({
          role: "user",
          content: "Use a tool. When the task is done, call finish with the answer.",
        });
        onStep({ n: step, label: "Asked for an action", state: "no" });
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
      onStep({ n: step, label: parsed.error, state: "no" });
      continue;
    }

    const decision = decide(parsed, {
      sites: settings.sites,
      pageUrl: current?.url ?? null,
      elements,
      stepsUsed: step,
      stepCap: STEP_CAP,
    });

    if (decision.kind === "deny") {
      messages.push({ role: "tool", tool_call_id: first.id, content: decision.reason });
      onStep({ n: step, label: decision.reason, state: "no" });
      continue;
    }

    if (decision.kind === "finish") {
      onStep({ n: step, label: "Finished", state: "ok" });
      return { status: "done", text: decision.answer.trim() || "Done." };
    }

    if (decision.kind === "confirm") {
      onStep({ n: step, label: "Waiting for you", state: "wait" });
      const image = await previewImage(parsed);
      const approved = await confirmOrAbort(options.onConfirm(decision.summary, image), signal);
      if (!approved) {
        messages.push({
          role: "tool",
          tool_call_id: first.id,
          content: "The user did not confirm. Do not continue that click.",
        });
        onStep({ n: step, label: "Not confirmed", state: "no" });
        continue;
      }
    }

    try {
      const outcome = await perform(parsed, step);
      messages.push({ role: "tool", tool_call_id: first.id, content: outcome });
    } catch (error) {
      if (signal.aborted || isAbort(error)) return { status: "stopped", text: "Stopped." };
      const message = friendlyBrowserError(error);
      messages.push({ role: "tool", tool_call_id: first.id, content: message });
      onStep({ n: step, label: message, state: "no" });
    }
  }

  return { status: "done", text: `Stopped after ${STEP_CAP} steps.` };

  async function perform(call: ToolCall, step: number): Promise<string> {
    if (call.name === "finish") return call.args.answer;
    if (call.name === "open_tab") {
      onStep({ n: step, label: `Open ${shortUrl(call.args.url)}`, state: "run" });
      current = await browser.openTab(call.args.url);
      elements = [];
      if (!keptOnAllowlist(current.url)) {
        await browser.close(current.id);
        current = await browser.activeTab();
        onStep({ n: step, label: "Closed a page outside the allowlist", state: "no" });
        return "That page left the allowlist. The tab was closed.";
      }
      onStep({ n: step, label: `Opened ${shortUrl(current.url)}`, state: "ok" });
      return `Opened ${current.url}`;
    }
    if (call.name === "navigate") {
      if (!current) return "No tab is open. Use open_tab.";
      onStep({ n: step, label: `Go to ${shortUrl(call.args.url)}`, state: "run" });
      const tabId = current.id;
      current = await browser.navigate(tabId, call.args.url);
      elements = [];
      if (!keptOnAllowlist(current.url)) {
        await browser.back(tabId);
        const restored = await browser.urlOf(tabId);
        current = restored ? { id: tabId, url: restored } : null;
        onStep({ n: step, label: "Went back", state: "no" });
        return "That page redirected off the allowlist. Jeco went back.";
      }
      onStep({ n: step, label: `At ${shortUrl(current.url)}`, state: "ok" });
      return `Now at ${current.url}`;
    }
    if (!current) return "No tab is open. Use open_tab.";

    if (call.name === "read_page") {
      const result = await browser.act(current.id, { op: "read" });
      if (!result.ok) {
        onStep({ n: step, label: result.error, state: "no" });
        return result.error;
      }
      if (result.op !== "read") return "The page returned an unexpected result.";
      elements = result.elements;
      current = { id: current.id, url: result.url };
      onStep({ n: step, label: `Read ${result.title || shortUrl(result.url)}`, state: "ok" });
      return formatSnapshot(result);
    }

    if (call.name === "click") {
      const name = elements.find((item) => item.ref === call.args.ref)?.name || String(call.args.ref);
      onStep({ n: step, label: `Click ${name}`, state: "run" });
      const result = await browser.act(current.id, { op: "click", ref: call.args.ref });
      if (!result.ok) {
        onStep({ n: step, label: result.error, state: "no" });
        return result.error;
      }
      onStep({ n: step, label: `Clicked ${name}`, state: "ok" });
      return (await leftAllowlist(step)) ?? (result.op === "click" ? result.detail : "Clicked.");
    }

    if (call.name === "type") {
      onStep({ n: step, label: "Type", state: "run" });
      const result = await browser.act(current.id, { op: "type", ref: call.args.ref, text: call.args.text });
      if (!result.ok) {
        onStep({ n: step, label: result.error, state: "no" });
        return result.error;
      }
      onStep({ n: step, label: "Typed", state: "ok" });
      return (await leftAllowlist(step)) ?? (result.op === "type" ? result.detail : "Typed.");
    }

    if (call.name === "scroll") {
      onStep({ n: step, label: "Scroll", state: "run" });
      const result = await browser.act(current.id, { op: "scroll", dy: call.args.dy });
      if (!result.ok) {
        onStep({ n: step, label: result.error, state: "no" });
        return result.error;
      }
      onStep({ n: step, label: "Scrolled", state: "ok" });
      return (await leftAllowlist(step)) ?? (result.op === "scroll" ? result.detail : "Scrolled.");
    }

    if (call.name !== "ask_to_post") return "Nothing to do.";
    onStep({ n: step, label: "Post", state: "run" });
    const result = await browser.act(current.id, {
      op: "commitPost",
      text: call.args.text,
      ref: call.args.ref,
    });
    if (!result.ok) {
      onStep({ n: step, label: result.error, state: "no" });
      return result.error;
    }
    const drifted = await leftAllowlist(step);
    if (drifted) return drifted;
    onStep({ n: step, label: "Posted", state: "ok" });
    return `The user confirmed. ${"detail" in result ? result.detail : "The post control was activated."}`;
  }

  async function previewImage(call: ToolCall): Promise<string | null> {
    const ref = call.name === "click" ? call.args.ref : call.name === "ask_to_post" ? call.args.ref : undefined;
    if (!current || ref == null) return null;
    try {
      const framed = await browser.act(current.id, { op: "frame", ref });
      if (!framed.ok) return null;
      return await browser.capture(current.id);
    } catch {
      return null;
    }
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
    onStep({ n: step, label: "Went back", state: "no" });
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

async function planWith(chat: ChatClient, task: string, signal: AbortSignal): Promise<string[]> {
  const turn = await chat(
    [
      { role: "system", content: PLAN_SYSTEM },
      { role: "user", content: task },
    ],
    signal,
  );
  return planLines(turn.content, task);
}

function planLines(content: string | null, task: string): string[] {
  const spoken = (content ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const backup = backupPlan(task);
  const lines = spoken.slice(0, 3);
  for (let i = lines.length; i < 3; i += 1) lines.push(backup[i]);
  return lines;
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
