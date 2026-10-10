import { isPublishName } from "./gate.ts";
import type { PageCommand, PageElement, PageResult } from "./types.ts";
import { CONTROL_CAP, TEXT_CAP } from "./types.ts";

type Found = {
  el: Element;
  element: PageElement;
};

const g = globalThis as unknown as {
  __jecoCmd?: PageCommand;
  __jecoResult?: PageResult;
};

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
  if (cmd.op === "read") return readPage();
  if (cmd.op === "scroll") {
    window.scrollBy(0, cmd.dy);
    return { ok: true, op: "scroll", detail: `Scrolled ${cmd.dy}px.` };
  }
  if (cmd.op === "clickNamed") {
    const found = collect().find((item) => isPublishName(item.element.name));
    if (!found) return { ok: false, error: "No matching post control is on the page." };
    activate(found.el);
    return { ok: true, op: "clickNamed", detail: `Clicked ${found.element.name}.` };
  }
  if (cmd.op === "commitPost") return commitPost(cmd.text, cmd.ref);

  const target = document.querySelector(`[data-jeco-ref="${cmd.ref}"]`);
  if (!(target instanceof Element)) {
    return { ok: false, error: `Control ${cmd.ref} is gone. Read the page again.` };
  }

  if (cmd.op === "click") {
    activate(target);
    return { ok: true, op: "click", detail: `Clicked control ${cmd.ref}.` };
  }

  if (cmd.op === "frame") {
    return { ok: true, op: "frame", detail: `Framed control ${cmd.ref}.`, rect: outline(target) };
  }

  const kind = kindOf(target);
  if (kind === "password" || kind === "payment") {
    return { ok: false, error: "Password and payment fields are blocked." };
  }
  writeText(target, cmd.text);
  return { ok: true, op: "type", detail: `Typed into control ${cmd.ref}.` };
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
  const selector = [
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
  const found: Found[] = [];
  document.querySelectorAll(selector).forEach((el) => {
    if (!visible(el)) return;
    const kind = kindOf(el);
    const name = label(el);
    if (!name && kind !== "text" && kind !== "password" && kind !== "payment") return;
    found.push({
      el,
      element: { ref: found.length + 1, role: roleOf(kind), name, kind, href: publicHref(el) },
    });
  });
  return found;
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

function commitPost(text: string, ref?: number): PageResult {
  const items = collect();
  const referenced = ref == null ? null : document.querySelector(`[data-jeco-ref="${ref}"]`);
  const field =
    referenced && kindOf(referenced) === "text"
      ? referenced
      : items
          .filter((item) => item.element.kind === "text")
          .sort((a, b) => area(b.el) - area(a.el))[0]?.el;
  if (!field) return { ok: false, error: "No text field is on the page to hold the post." };
  writeText(field, text);
  const button =
    referenced && referenced !== field && isPublishName(label(referenced))
      ? referenced
      : items.find((item) => isPublishName(item.element.name))?.el;
  if (!button) {
    return { ok: true, op: "commitPost", detail: "Typed the confirmed text. No post button was on the page." };
  }
  activate(button);
  return { ok: true, op: "commitPost", detail: "Typed the confirmed text and activated the post control." };
}

function area(el: Element): number {
  const rect = el.getBoundingClientRect();
  return rect.width * rect.height;
}

function outline(el: Element): { x: number; y: number; width: number; height: number } {
  el.scrollIntoView({ block: "center", inline: "nearest" });
  if (el instanceof HTMLElement) {
    el.style.outline = "2px solid #0f6e6b";
    el.style.outlineOffset = "2px";
  }
  const box = el.getBoundingClientRect();
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

function activate(el: Element): void {
  if (el instanceof HTMLElement) {
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const previous = el.style.outline;
    el.style.outline = "2px solid #0f6e6b";
    el.style.outlineOffset = "2px";
    setTimeout(() => {
      el.style.outline = previous;
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
