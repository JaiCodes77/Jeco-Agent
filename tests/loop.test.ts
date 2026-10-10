import assert from "node:assert/strict";
import test from "node:test";
import { runTask } from "../src/loop.ts";
import type { BrowserPort, ChatClient, ModelTurn, PageCommand, Settings } from "../src/types.ts";

const settings: Settings = {
  apiKey: "test",
  model: "google/gemma-4-26b-a4b-it:free",
  backupModel: "",
  baseUrl: "",
  savedTasks: [],
  sites: [{ host: "youtube.com", interact: true, post: false }],
};

test("finish ends the task without touching the page", async () => {
  const browser = fakeBrowser("https://www.youtube.com");
  const result = await runTask({
    task: "What is open?",
    settings,
    browser,
    chat: scripted([{ content: null, toolCalls: [{ id: "1", name: "finish", args: { answer: "A video page." } }] }]),
    signal: new AbortController().signal,
    onStep: () => {},
    onConfirm: async () => false,
  });
  assert.equal(result.status, "done");
  assert.equal(result.text, "A video page.");
  assert.equal(browser.actions.length, 0);
});

test("an off-allowlist open is refused and reported back to the model", async () => {
  const browser = fakeBrowser(null);
  const seen: string[] = [];
  const result = await runTask({
    task: "Open example.org",
    settings,
    browser,
    chat: scripted([
      { content: null, toolCalls: [{ id: "1", name: "open_tab", args: { url: "https://example.org" } }] },
      { content: null, toolCalls: [{ id: "2", name: "finish", args: { answer: "Add example.org first." } }] },
    ], seen),
    signal: new AbortController().signal,
    onStep: () => {},
    onConfirm: async () => false,
  });
  assert.equal(browser.opened.length, 0);
  assert.match(seen.join("\n"), /not on the allowlist/);
  assert.equal(result.text, "Add example.org first.");
});

test("onPlan false means openTab is not called", async () => {
  const browser = fakeBrowser(null);
  let opens = 0;
  let navigations = 0;
  let acts = 0;
  const seen: string[] = [];
  const result = await runTask({
    task: "Open the video",
    settings,
    browser: {
      ...browser,
      async openTab(url) {
        opens += 1;
        return browser.openTab(url);
      },
      async navigate(tabId, url) {
        navigations += 1;
        return browser.navigate(tabId, url);
      },
      async act(tabId, cmd) {
        acts += 1;
        return browser.act(tabId, cmd);
      },
    },
    chat: scripted(
      [{ content: null, toolCalls: [{ id: "1", name: "open_tab", args: { url: "https://www.youtube.com" } }] }],
      seen,
    ),
    signal: new AbortController().signal,
    onStep: () => {},
    onConfirm: async () => true,
    onPlan: async (lines) => {
      assert.equal(lines.length, 3);
      assert.ok(lines.every((line) => line.trim().length > 0));
      return false;
    },
  });
  assert.match(seen.join("\n"), /exactly 3 short lines of the plan/);
  assert.equal(result.status, "stopped");
  assert.equal(result.text, "Stopped.");
  assert.equal(opens, 0);
  assert.equal(navigations, 0);
  assert.equal(acts, 0);
  assert.equal(browser.opened.length, 0);
});

test("onPlan true still allows a later finish tool", async () => {
  const browser = fakeBrowser("https://www.youtube.com");
  const result = await runTask({
    task: "What is open?",
    settings,
    browser,
    chat: scripted([{ content: null, toolCalls: [{ id: "1", name: "finish", args: { answer: "A video page." } }] }]),
    signal: new AbortController().signal,
    onStep: () => {},
    onConfirm: async () => false,
    onPlan: async (lines) => {
      assert.equal(lines.length, 3);
      assert.ok(lines.every((line) => line.trim().length > 0));
      return true;
    },
  });
  assert.equal(result.status, "done");
  assert.equal(result.text, "A video page.");
  assert.equal(browser.actions.length, 0);
  assert.equal(browser.opened.length, 0);
});

test("a declined post is not clicked", async () => {
  const browser = fakeBrowser("https://www.youtube.com/feed");
  const result = await runTask({
    task: "Post hello",
    settings: { ...settings, sites: [{ host: "youtube.com", interact: true, post: true }] },
    browser,
    chat: scripted([
      { content: null, toolCalls: [{ id: "1", name: "ask_to_post", args: { text: "Hello" } }] },
      { content: null, toolCalls: [{ id: "2", name: "finish", args: { answer: "Left it unposted." } }] },
    ]),
    signal: new AbortController().signal,
    onStep: () => {},
    onConfirm: async () => false,
  });
  assert.equal(browser.actions.length, 0);
  assert.equal(result.text, "Left it unposted.");
});

function scripted(turns: ModelTurn[], seen: string[] = []): ChatClient {
  const queue = [...turns];
  return async (messages) => {
    const transcript = messages.map((message) => message.content ?? "").join("\n");
    seen.push(transcript);
    if (transcript.includes("exactly 3 short lines of the plan")) {
      return {
        content: "Check the page\n\nDo the task\nFinish with the answer\nIgnored extra",
        toolCalls: [{ id: "ignored", name: "open_tab", args: { url: "https://www.youtube.com" } }],
      };
    }
    const next = queue.shift();
    if (!next) throw new Error("The test model ran out of turns.");
    return next;
  };
}

function fakeBrowser(pageUrl: string | null): BrowserPort & { opened: string[]; actions: PageCommand[] } {
  const state = {
    opened: [] as string[],
    actions: [] as PageCommand[],
    url: pageUrl,
    id: 7,
  };
  return {
    opened: state.opened,
    actions: state.actions,
    async activeTab() {
      return state.url ? { id: state.id, url: state.url } : null;
    },
    async openTab(url) {
      state.opened.push(url);
      state.url = url;
      return { id: state.id, url };
    },
    async navigate(_tabId, url) {
      state.url = url;
      return { id: state.id, url };
    },
    async act(_tabId, cmd) {
      state.actions.push(cmd);
      if (cmd.op === "read") {
        return { ok: true, op: "read", url: state.url ?? "", title: "Page", text: "Hello", elements: [] };
      }
      return { ok: true, op: cmd.op, detail: "ok" };
    },
    async urlOf() {
      return state.url;
    },
    async close() {
      state.url = null;
    },
    async back() {
      state.url = "https://www.youtube.com";
    },
    async capture() {
      return null;
    },
  };
}
