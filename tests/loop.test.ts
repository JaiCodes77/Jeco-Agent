import assert from "node:assert/strict";
import test from "node:test";
import { runTask } from "../src/loop.ts";
import type { BrowserPort, ChatClient, ModelTurn, PageCommand, Settings } from "../src/types.ts";

const settings: Settings = {
  apiKey: "test",
  model: "google/gemma-4-26b-a4b-it:free",
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
    seen.push(messages.map((message) => message.content ?? "").join("\n"));
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
  };
}
