import { fingerprint } from "./gate.ts";
import type { BrowserPort, ConfirmRequest, PageElement, PageResult } from "./types.ts";

export type PostFlowInput = {
  browser: BrowserPort;
  tabId: number;
  host: string;
  text: string;
  field: number;
  button?: number;
  warn?: string;
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  onWaiting?: () => void;
};

export type PostFlowResult = {
  status: "posted" | "declined" | "failed";
  verified: boolean;
  message: string;
  elements: PageElement[];
};

export async function postFlow(input: PostFlowInput): Promise<PostFlowResult> {
  const { browser, tabId, host, text } = input;
  const elements: PageElement[] = [];
  const failed = (message: string): PostFlowResult => ({ status: "failed", verified: false, message, elements });
  const declined = (): PostFlowResult => ({
    status: "declined",
    verified: false,
    message: "The user did not post. The draft is still in the field.",
    elements,
  });

  const paired = await browser.act(tabId, { op: "pairPost", field: input.field, button: input.button });
  if (!paired.ok) return failed(`${paired.error} Nothing was typed.`);
  if (paired.op !== "pairPost") return failed("The page returned an unexpected result. Nothing was typed.");
  const field = paired.field;
  let button = paired.button;
  elements.push(field, button);

  const typed = await browser.act(tabId, { op: "type", ref: field.ref, text, expect: fingerprint(field) });
  if (!typed.ok) return failed(`${typed.error} Nothing was posted.`);
  await browser.settle(tabId, { quietMs: 300, maxMs: 1000 });

  const afterTyping = await readField(browser, tabId, field.ref);
  if (afterTyping == null || !sameText(afterTyping, text)) {
    return failed("The site changed the text while typing. Nothing was posted.");
  }

  const refreshed = await browser.act(tabId, { op: "pairPost", field: field.ref, button: button.ref });
  if (!refreshed.ok) return failed(`${refreshed.error} Nothing was posted.`);
  if (refreshed.op !== "pairPost") return failed("The page returned an unexpected result. Nothing was posted.");
  button = refreshed.button;
  if (button.state?.includes("disabled")) return failed("The post button is still disabled. Nothing was posted.");

  const ask = async (shown: string, warn?: string): Promise<boolean> => {
    input.onWaiting?.();
    const preview = await previewControl(browser, tabId, button.ref, "Jeco will press this");
    try {
      return await input.confirm({
        kind: "publish",
        host,
        control: button.name,
        field: field.name,
        text: shown,
        chars: shown.length,
        ...(warn ? { warn } : {}),
        ...preview,
      });
    } finally {
      await clearPreview(browser, tabId);
    }
  };

  if (!(await ask(text, input.warn))) return declined();

  const current = await readField(browser, tabId, field.ref);
  if (current == null) return failed("The text field is gone. Nothing was posted.");
  if (!sameText(current, text)) {
    const edited = current.trim();
    if (!(await ask(edited, "The text in the page changed."))) return declined();
    const latest = await readField(browser, tabId, field.ref);
    if (latest == null || !sameText(latest, edited)) return failed("The text changed again. Nothing was posted.");
  }

  const clicked = await browser.act(tabId, { op: "click", ref: button.ref, expect: fingerprint(button) });
  if (!clicked.ok) return failed(`${clicked.error} Nothing was posted.`);
  await browser.settle(tabId);
  let verified = await fieldCleared(browser, tabId, field.ref);
  if (!verified) {
    await browser.settle(tabId);
    verified = await fieldCleared(browser, tabId, field.ref);
  }
  return {
    status: "posted",
    verified,
    message: verified
      ? `Posted on ${host}.`
      : `Pressed ${button.name} on ${host}. Jeco could not confirm the post went out. Check the tab.`,
    elements,
  };
}

export async function previewControl(
  browser: BrowserPort,
  tabId: number,
  ref: number,
  label: string,
): Promise<{ image: string | null; outlined: boolean }> {
  try {
    await browser.focusTab(tabId);
    const framed = await browser.act(tabId, { op: "frame", ref, label });
    if (!framed.ok || framed.op !== "frame") return { image: null, outlined: false };
    return { image: await browser.capture(tabId, framed.rect), outlined: true };
  } catch {
    return { image: null, outlined: false };
  }
}

export async function clearPreview(browser: BrowserPort, tabId: number): Promise<void> {
  try {
    await browser.act(tabId, { op: "unframe" });
  } catch {
    // The tab may be gone; there is nothing left to clear.
  }
}

export function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function sameText(a: string, b: string): boolean {
  return normalizeText(a) === normalizeText(b);
}

async function readField(browser: BrowserPort, tabId: number, ref: number): Promise<string | null> {
  const result: PageResult = await browser.act(tabId, { op: "fieldText", ref });
  if (!result.ok || result.op !== "fieldText" || result.gone) return null;
  return result.text;
}

async function fieldCleared(browser: BrowserPort, tabId: number, ref: number): Promise<boolean> {
  const result = await browser.act(tabId, { op: "fieldText", ref });
  if (!result.ok || result.op !== "fieldText") return false;
  return result.gone || normalizeText(result.text) === "";
}
