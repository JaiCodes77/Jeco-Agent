import { NAV_TIMEOUT_MS, SETTLE_MAX_MS, SETTLE_QUIET_MS } from "../limits.ts";
import type { BrowserPort, FrameRect, PageCommand, PageResult } from "../types.ts";

const LOAD_START_MS = 300;
const CROP_PAD = 24;
const CROP_MIN_WIDTH = 360;
const CROP_MIN_HEIGHT = 200;

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
      const loaded = waitForNavigation(tabId, previous, getSignal());
      try {
        await chrome.tabs.update(tabId, { url, active: true });
      } catch (error) {
        loaded.catch(() => {});
        throw error;
      }
      await loaded;
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

    async settle(tabId, opts = {}) {
      const signal = getSignal();
      await waitForLoadIfStarted(tabId, signal);
      throwIfAborted(signal);
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: domQuiet,
          args: [opts.quietMs ?? SETTLE_QUIET_MS, opts.maxMs ?? SETTLE_MAX_MS],
        });
      } catch {
        // Settling is best effort; the page may have navigated or refused scripts.
      }
      throwIfAborted(signal);
    },

    async focusTab(tabId) {
      await chrome.tabs.update(tabId, { active: true });
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

    async capture(tabId, rect) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab.active || tab.windowId == null) return null;
        const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        return rect ? await crop(shot, rect) : shot;
      } catch {
        return null;
      }
    },
  };
}

function waitForNavigation(tabId: number, previousUrl: string | null, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sawLoading = false;
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
      if (status !== "complete" || !url || !/^https?:/i.test(url)) return false;
      return url !== previousUrl || sawLoading;
    };
    const timer = setTimeout(() => finish(new Error("The page took too long to load.")), NAV_TIMEOUT_MS);
    const onAbort = () => finish(new DOMException("Stopped.", "AbortError"));
    const onUpdated = (id: number, info: { status?: string }, tab: chrome.tabs.Tab) => {
      if (id !== tabId) return;
      if (info.status === "loading") sawLoading = true;
      if (ready(tab.url, tab.status)) finish();
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

function waitForLoadIfStarted(tabId: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let loading = false;
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(startTimer);
      clearTimeout(loadTimer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const startLoading = () => {
      if (loading) return;
      loading = true;
      loadTimer = setTimeout(() => finish(), NAV_TIMEOUT_MS);
    };
    const startTimer = setTimeout(() => {
      if (!loading) finish();
    }, LOAD_START_MS);
    const onAbort = () => finish(new DOMException("Stopped.", "AbortError"));
    const onUpdated = (id: number, info: { status?: string }, tab: chrome.tabs.Tab) => {
      if (id !== tabId) return;
      if (info.status === "loading") startLoading();
      if (loading && tab.status === "complete") finish();
    };
    if (signal.aborted) {
      finish(new DOMException("Stopped.", "AbortError"));
      return;
    }
    signal.addEventListener("abort", onAbort);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab.status === "loading") startLoading();
      },
      () => finish(),
    );
  });
}

function domQuiet(quietMs: number, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    let quietTimer = setTimeout(done, quietMs);
    const maxTimer = setTimeout(done, maxMs);
    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(done, quietMs);
    });
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    function done() {
      observer.disconnect();
      clearTimeout(quietTimer);
      clearTimeout(maxTimer);
      resolve();
    }
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Stopped.", "AbortError");
}

async function crop(dataUrl: string, rect: FrameRect): Promise<string> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = rect.viewportWidth > 0 ? bitmap.width / rect.viewportWidth : rect.dpr;
  const width = Math.max(rect.width + CROP_PAD * 2, CROP_MIN_WIDTH);
  const height = Math.max(rect.height + CROP_PAD * 2, CROP_MIN_HEIGHT);
  const left = rect.x + rect.width / 2 - width / 2;
  const top = rect.y + rect.height / 2 - height / 2;
  const sx = clamp(left * scale, 0, bitmap.width);
  const sy = clamp(top * scale, 0, bitmap.height);
  const sw = Math.min(bitmap.width - sx, width * scale);
  const sh = Math.min(bitmap.height - sy, height * scale);
  if (sw < 1 || sh < 1) {
    bitmap.close();
    return dataUrl;
  }
  const canvas = new OffscreenCanvas(Math.round(sw), Math.round(sh));
  canvas.getContext("2d")?.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return blobToDataUrl(await canvas.convertToBlob({ type: "image/png" }));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the picture."));
    reader.readAsDataURL(blob);
  });
}
