import { CONTROL_CAP, TEXT_CAP } from "../limits.ts";
import { classifyControl, normalizeLabel } from "../safety/risk.ts";
import type { ElementState, Fingerprint, FrameRect, PageCommand, PageElement, PageResult } from "../types.ts";

type Found = {
  el: Element;
  element: PageElement;
};

const g = globalThis as unknown as {
  __jecoCmd?: PageCommand;
  __jecoResult?: PageResult;
};

const CONTROLS = [
  "a[href]",
  "button",
  "input:not([type='hidden'])",
  "textarea",
  "select",
  "[role='button']",
  "[role='link']",
  "[role='textbox']",
  "[contenteditable='true']",
].join(",");

const BUTTONS = "button, [role='button'], input[type='submit'], input[type='button']";

const EXACT_PUBLISH = new Set([
  "post",
  "tweet",
  "reply",
  "repost",
  "retweet",
  "quote",
  "send",
  "submit",
  "publish",
  "comment",
]);

const ANCESTOR_LIMIT = 8;
const TEAL = "#0f6e6b";
const PREV_OUTLINE = "data-jeco-prev-outline";
const BADGE = "data-jeco-badge";

try {
  g.__jecoResult = run(g.__jecoCmd);
} catch (error) {
  g.__jecoResult = {
    ok: false,
    error: error instanceof Error ? error.message : "The page script failed.",
  };
}

function run(cmd: PageCommand | undefined): PageResult {
  if (!cmd) return { ok: false, error: "No command was sent to the page." };
  switch (cmd.op) {
    case "read":
      return readPage();
    case "scroll":
      window.scrollBy(0, cmd.dy);
      return { ok: true, op: "scroll", detail: `Scrolled ${cmd.dy}px.` };
    case "unframe":
      unframe();
      return { ok: true, op: "unframe", detail: "Cleared the outline." };
    case "fieldText":
      return fieldText(cmd.ref);
    case "pairPost":
      return pairPost(cmd.field, cmd.button);
    case "frame": {
      const target = byRef(cmd.ref);
      if (!target) return gone(cmd.ref);
      return { ok: true, op: "frame", rect: frame(target, cmd.label) };
    }
    case "click": {
      const target = verify(cmd.ref, cmd.expect);
      if (!(target instanceof Element)) return target;
      activate(target);
      return { ok: true, op: "click", detail: `Clicked control ${cmd.ref}.` };
    }
    case "type": {
      const target = verify(cmd.ref, cmd.expect);
      if (!(target instanceof Element)) return target;
      const kind = kindOf(target);
      if (kind === "password" || kind === "payment") {
        return { ok: false, error: "Password and payment fields are blocked." };
      }
      writeText(target, cmd.text);
      return { ok: true, op: "type", detail: `Typed into control ${cmd.ref}.` };
    }
  }
}

function readPage(): PageResult {
  document.querySelectorAll("[data-jeco-ref]").forEach((el) => el.removeAttribute("data-jeco-ref"));
  const found = collect().slice(0, CONTROL_CAP);
  found.forEach((item, index) => {
    item.element.ref = index + 1;
    item.el.setAttribute("data-jeco-ref", String(item.element.ref));
  });
  const root = document.querySelector("main") ?? document.body;
  const text = (root?.innerText ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, TEXT_CAP);
  return {
    ok: true,
    op: "read",
    url: publicLocation(),
    title: document.title,
    text,
    elements: found.map((item) => item.element),
  };
}

function collect(): Found[] {
  const found: Found[] = [];
  document.querySelectorAll(CONTROLS).forEach((el) => {
    if (!visible(el)) return;
    const element = describe(el, found.length + 1);
    const { kind, name } = element;
    if (!name && kind !== "text" && kind !== "password" && kind !== "payment") return;
    found.push({ el, element });
  });
  return found;
}

function describe(el: Element, ref: number): PageElement {
  const kind = kindOf(el);
  const element: PageElement = { ref, role: roleOf(kind), name: label(el), kind };
  const href = publicHref(el);
  if (href) element.href = href;
  const state = stateOf(el);
  if (state.length > 0) element.state = state;
  if (kind === "text" && (el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable)) {
    element.multiline = true;
  }
  return element;
}

function verify(ref: number, expect: Fingerprint): Element | PageResult {
  const el = byRef(ref);
  if (!el) return gone(ref);
  const now = describe(el, ref);
  const same =
    normalizeLabel(now.name) === normalizeLabel(expect.name) &&
    now.kind === expect.kind &&
    hrefKey(now.href) === hrefKey(expect.href);
  if (!same) {
    return {
      ok: false,
      stale: true,
      error: `Control ${ref} changed from "${expect.name}" to "${now.name}". Read the page again.`,
    };
  }
  if (isDisabled(el)) return { ok: false, error: `Control ${ref} is disabled.` };
  return el;
}

function byRef(ref: number): Element | null {
  const el = document.querySelector(`[data-jeco-ref="${ref}"]`);
  return el instanceof Element && el.isConnected ? el : null;
}

function gone(ref: number): PageResult {
  return { ok: false, stale: true, error: `Control ${ref} is gone. Read the page again.` };
}

function refOf(el: Element): number {
  const existing = Number(el.getAttribute("data-jeco-ref"));
  if (Number.isInteger(existing) && existing > 0) return existing;
  let next = 1;
  document.querySelectorAll("[data-jeco-ref]").forEach((item) => {
    next = Math.max(next, Number(item.getAttribute("data-jeco-ref")) + 1);
  });
  el.setAttribute("data-jeco-ref", String(next));
  return next;
}

function hrefKey(href: string | undefined): string {
  if (!href) return "";
  try {
    const url = new URL(href);
    return `${url.origin}${url.pathname}`;
  } catch {
    return href;
  }
}

function visible(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function label(el: Element): string {
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) return clip(aria);
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.innerText ?? "")
      .join(" ")
      .trim();
    if (text) return clip(text);
  }
  if (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button" || el.type === "image")) {
    return clip(el.value || el.alt || el.type);
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return clip(el.getAttribute("placeholder") || el.getAttribute("name") || el.type || "field");
  }
  if ((el as HTMLElement).isContentEditable) {
    return clip(
      el.getAttribute("aria-placeholder") ||
        el.getAttribute("data-placeholder") ||
        el.getAttribute("placeholder") ||
        el.getAttribute("title") ||
        "text field",
    );
  }
  const text = (el as HTMLElement).innerText || el.textContent || "";
  return clip(text.replace(/\s+/g, " ").trim() || el.getAttribute("title") || "");
}

function clip(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

function kindOf(el: Element): PageElement["kind"] {
  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase();
    const hint = fieldHint(el);
    if (type === "password" || /current-password|new-password|\bpassword\b/.test(hint)) return "password";
    if (/cc-|card[-_ ]?number|\bcardnumber\b|\bcvv\b|\bcvc\b/.test(hint)) return "payment";
    if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
    return "text";
  }
  if (el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable) return "text";
  if (el instanceof HTMLAnchorElement || el.getAttribute("role") === "link") return "link";
  if (el instanceof HTMLButtonElement || el.getAttribute("role") === "button") return "button";
  return "other";
}

function stateOf(el: Element): ElementState[] {
  const state: ElementState[] = [];
  if (isDisabled(el)) state.push("disabled");
  const checkable = el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio");
  if ((checkable && el.checked) || el.getAttribute("aria-checked") === "true") state.push("checked");
  if (el.getAttribute("aria-expanded") === "true") state.push("expanded");
  if (el.getAttribute("aria-pressed") === "true") state.push("pressed");
  if (el.getAttribute("aria-selected") === "true") state.push("selected");
  return state;
}

function isDisabled(el: Element): boolean {
  const native =
    (el instanceof HTMLButtonElement ||
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement) &&
    el.disabled;
  return native || el.getAttribute("aria-disabled") === "true";
}

function roleOf(kind: PageElement["kind"]): string {
  if (kind === "text") return "textbox";
  if (kind === "other") return "control";
  return kind;
}

function fieldHint(el: HTMLInputElement): string {
  return `${el.autocomplete} ${el.name} ${el.id} ${el.placeholder} ${el.getAttribute("aria-label") ?? ""}`.toLowerCase();
}

function publicLocation(): string {
  const url = new URL(location.href);
  url.username = "";
  url.password = "";
  return url.href;
}

function publicHref(el: Element): string | undefined {
  if (!(el instanceof HTMLAnchorElement) || !el.href) return undefined;
  try {
    const url = new URL(el.href);
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function fieldText(ref: number): PageResult {
  const el = byRef(ref);
  if (!el) return { ok: true, op: "fieldText", text: "", gone: true };
  const text =
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      ? el.value
      : (el as HTMLElement).innerText ?? el.textContent ?? "";
  return { ok: true, op: "fieldText", text, gone: false };
}

function pairPost(fieldRef: number, buttonRef?: number): PageResult {
  const field = byRef(fieldRef);
  if (!field) return gone(fieldRef);
  if (kindOf(field) !== "text") return { ok: false, error: "That control is not a text field." };
  const chosen = buttonRef == null ? null : byRef(buttonRef);
  if (buttonRef != null && !chosen) return gone(buttonRef);

  const container = containerOf(field, chosen);
  if (!container) return { ok: false, error: "No post button next to that field." };
  if (chosen && !container.el.contains(chosen)) {
    return { ok: false, error: "That post button is not next to the field." };
  }
  const button = chosen ?? pickButton(container.el, field);
  if (!button) return { ok: false, error: "No post button next to that field." };
  if (classifyControl(label(button), kindOf(button)) !== "publish") {
    return { ok: false, error: "That control cannot be used to post." };
  }
  return {
    ok: true,
    op: "pairPost",
    field: describe(field, refOf(field)),
    button: describe(button, refOf(button)),
    container: container.kind,
  };
}

function containerOf(
  field: Element,
  button: Element | null,
): { el: Element; kind: "dialog" | "form" | "ancestor" } | null {
  const dialog = field.closest("[role='dialog'], dialog");
  if (dialog) return { el: dialog, kind: "dialog" };
  const form = field.closest("form");
  if (form) return { el: form, kind: "form" };
  let node = field.parentElement;
  for (let depth = 0; node && depth < ANCESTOR_LIMIT; depth += 1) {
    if (button ? node.contains(button) : publishButtons(node).length > 0) return { el: node, kind: "ancestor" };
    node = node.parentElement;
  }
  return null;
}

function pickButton(container: Element, field: Element): Element | null {
  const buttons = publishButtons(container);
  if (buttons.length === 0) return null;
  const exact = buttons.filter((button) => EXACT_PUBLISH.has(normalizeLabel(label(button))));
  const pool = exact.length > 0 ? exact : buttons;
  const after = pool.find((button) => field.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING);
  return after ?? pool[pool.length - 1];
}

function publishButtons(root: Element): Element[] {
  return Array.from(root.querySelectorAll(BUTTONS)).filter(
    (el) => visible(el) && classifyControl(label(el), kindOf(el)) === "publish",
  );
}

function frame(el: Element, text: string): FrameRect {
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  if (el instanceof HTMLElement) {
    if (!el.hasAttribute(PREV_OUTLINE)) {
      el.setAttribute(PREV_OUTLINE, JSON.stringify([el.style.outline, el.style.outlineOffset]));
    }
    el.style.outline = `2px solid ${TEAL}`;
    el.style.outlineOffset = "2px";
  }
  const box = el.getBoundingClientRect();
  const badge = document.createElement("div");
  badge.setAttribute(BADGE, "");
  badge.textContent = text;
  Object.assign(badge.style, {
    position: "fixed",
    left: `${Math.max(4, box.left)}px`,
    top: `${box.top > 30 ? box.top - 26 : box.bottom + 6}px`,
    zIndex: "2147483647",
    background: TEAL,
    color: "#fff",
    font: "600 12px/1.6 system-ui, sans-serif",
    padding: "1px 6px",
    borderRadius: "3px",
    pointerEvents: "none",
  });
  document.body.append(badge);
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    dpr: window.devicePixelRatio || 1,
    viewportWidth: window.innerWidth,
  };
}

function unframe(): void {
  document.querySelectorAll(`[${PREV_OUTLINE}]`).forEach((el) => {
    if (el instanceof HTMLElement) {
      const [outline, offset] = parsePrevious(el.getAttribute(PREV_OUTLINE));
      el.style.outline = outline;
      el.style.outlineOffset = offset;
    }
    el.removeAttribute(PREV_OUTLINE);
  });
  document.querySelectorAll(`[${BADGE}]`).forEach((el) => el.remove());
}

function parsePrevious(raw: string | null): [string, string] {
  try {
    const value = JSON.parse(raw ?? "") as unknown;
    if (Array.isArray(value)) return [String(value[0] ?? ""), String(value[1] ?? "")];
  } catch {
    // An old or foreign value; fall back to clearing the outline.
  }
  return ["", ""];
}

function activate(el: Element): void {
  if (el instanceof HTMLElement) {
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const previous = [el.style.outline, el.style.outlineOffset];
    el.style.outline = `2px solid ${TEAL}`;
    el.style.outlineOffset = "2px";
    setTimeout(() => {
      [el.style.outline, el.style.outlineOffset] = previous;
    }, 1200);
    el.click();
  }
}

function writeText(el: Element, text: string): void {
  if (!(el instanceof HTMLElement)) return;
  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if (el.isContentEditable) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand("insertText", false, text);
  }
}
