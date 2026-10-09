import type { BrowserPort, PageCommand, PageResult } from "./types.ts";

export function createBrowser(getSignal: () => AbortSignal): BrowserPort {
  return {
    async activeTab() {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id == null || !tab.url) return null;
      return { id: tab.id, url: tab.url };
    },

    async openTab(url) {
      const tab = await chrome.tabs.create({ url, active: true });
      if (tab.id == null) throw new Error("Brave did not open a tab.");
      await waitForNavigation(tab.id, null, getSignal());
      const fresh = await chrome.tabs.get(tab.id);
      return { id: tab.id, url: fresh.url || "" };
    },

    async navigate(tabId, url) {
      const previous = (await chrome.tabs.get(tabId)).url ?? null;
      await chrome.tabs.update(tabId, { url, active: true });
      await waitForNavigation(tabId, previous, getSignal());
      const fresh = await chrome.tabs.get(tabId);
      return { id: tabId, url: fresh.url || "" };
    },

    async act(tabId, cmd) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (command: PageCommand) => {
          (globalThis as unknown as { __jecoCmd?: PageCommand }).__jecoCmd = command;
        },
        args: [cmd],
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["page-hands.js"],
      });
      const [got] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => (globalThis as unknown as { __jecoResult?: PageResult }).__jecoResult,
      });
      const result = got?.result;
      if (!result || typeof result !== "object") {
        return { ok: false, error: "The page did not return a result." };
      }
      return result as PageResult;
    },

    async urlOf(tabId) {
      const tab = await chrome.tabs.get(tabId);
      return tab.url ?? null;
    },

    async close(tabId) {
      await chrome.tabs.remove(tabId);
    },

    async back(tabId) {
      await chrome.tabs.goBack(tabId);
    },
  };
}

function waitForNavigation(tabId: number, previousUrl: string | null, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const ready = (url: string | undefined, status: string | undefined) => {
      if (status !== "complete" || !url || url === previousUrl) return false;
      return /^https?:/i.test(url);
    };
    const timer = setTimeout(() => finish(new Error("The page took too long to load.")), 15000);
    const onAbort = () => finish(new DOMException("Stopped.", "AbortError"));
    const onUpdated = (id: number, _info: { status?: string }, tab: chrome.tabs.Tab) => {
      if (id === tabId && ready(tab.url, tab.status)) finish();
    };
    if (signal.aborted) {
      finish(new DOMException("Stopped.", "AbortError"));
      return;
    }
    signal.addEventListener("abort", onAbort);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then(
      (tab) => {
        if (ready(tab.url, tab.status)) finish();
      },
      () => finish(new Error("That tab is gone.")),
    );
  });
}
