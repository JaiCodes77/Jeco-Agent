import { MAX_TEXT } from "../limits.ts";
import type { ConfirmSpec, Fingerprint, GateContext, GateDecision, PageElement, ToolCall } from "../types.ts";
import { grantForUrl } from "./hosts.ts";
import { classifyControl, normalizeLabel } from "./risk.ts";

export function fingerprint(element: PageElement): Fingerprint {
  return element.href
    ? { name: element.name, kind: element.kind, href: element.href }
    : { name: element.name, kind: element.kind };
}

export function parseToolCall(name: string, args: unknown): ToolCall | { error: string } {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  switch (name) {
    case "open_tab":
    case "navigate": {
      const url = stringField(record.url);
      if (!url) return { error: `${name} needs a url string.` };
      if (url.length > 2000) return { error: "That URL is too long." };
      return { name, args: { url } };
    }
    case "read_page":
      return { name, args: {} };
    case "click": {
      const ref = refField(record.ref);
      if (ref == null) return { error: "click needs a control number." };
      return { name, args: { ref } };
    }
    case "type": {
      const ref = refField(record.ref);
      const text = stringField(record.text);
      if (ref == null || text == null) return { error: "type needs a control number and text." };
      if (text.length > MAX_TEXT) return { error: "That text is too long to type." };
      return { name, args: { ref, text } };
    }
    case "scroll": {
      const dy = typeof record.dy === "number" && Number.isFinite(record.dy) ? record.dy : 640;
      return { name, args: { dy: Math.max(-2000, Math.min(2000, Math.round(dy))) } };
    }
    case "ask_to_post": {
      const text = stringField(record.text);
      if (!text) return { error: "ask_to_post needs the exact text to post." };
      if (text.length > MAX_TEXT) return { error: "That post is too long." };
      const field = refField(record.field ?? record.ref);
      if (field == null) return { error: "ask_to_post needs the number of the text field from read_page." };
      if (record.button == null) return { name, args: { text, field } };
      const button = refField(record.button);
      if (button == null) return { error: "ask_to_post button must be a control number." };
      return { name, args: { text, field, button } };
    }
    case "finish": {
      const answer = stringField(record.answer) ?? "";
      return { name, args: { answer } };
    }
    default:
      return { error: `Unknown tool ${name}.` };
  }
}

export function decide(call: ToolCall, ctx: GateContext): GateDecision {
  if (call.name === "finish") {
    return { allow: true, kind: "finish", answer: call.args.answer };
  }

  if (ctx.stepsUsed > ctx.stepCap) {
    return deny(`Stopped after ${ctx.stepCap} steps.`);
  }

  if (call.name === "open_tab" || call.name === "navigate") {
    if (!grantForUrl(call.args.url, ctx.sites)) {
      return deny("That address is not on the allowlist. Add the site in Settings, or finish.");
    }
    return { allow: true, kind: "browser" };
  }

  const pageGrant = ctx.pageUrl ? grantForUrl(ctx.pageUrl, ctx.sites) : null;
  if (!pageGrant) {
    return deny("The current tab is not an allowed site. Open an allowed https page first.");
  }
  const host = pageGrant.host;

  if (call.name === "read_page" || call.name === "scroll") {
    return { allow: true, kind: "browser" };
  }

  if (!pageGrant.interact) {
    return deny(`${host} is read-only. Turn on interaction in Settings, or finish.`);
  }

  if (call.name === "find" || call.name === "press_enter" || call.name === "go_back") {
    return deny("That action is not available yet.");
  }

  if (call.name === "ask_to_post") {
    if (!pageGrant.post) return deny(`Posting is off for ${host}. Turn it on in Settings, or finish.`);
    if (ctx.posted) return deny("This run already posted once. Call finish.");
    const field = ctx.elements.find((item) => item.ref === call.args.field);
    if (!field || field.kind !== "text") return deny("ask_to_post needs a text field number from read_page.");
    let control = "Post";
    if (call.args.button != null) {
      const button = ctx.elements.find((item) => item.ref === call.args.button);
      if (!button || classifyControl(button.name, button.kind) !== "publish") {
        return deny("That control cannot be used to post.");
      }
      control = button.name;
    }
    return confirm({
      kind: "publish",
      host,
      control,
      field: field.name,
      text: call.args.text,
      chars: call.args.text.length,
    });
  }

  const element = ctx.elements.find((item) => item.ref === call.args.ref);
  if (!element) {
    return deny("That control number is not on the page. Call read_page again.");
  }
  if (element.state?.includes("disabled")) {
    return deny("That control is disabled.");
  }

  if (call.name === "type") {
    if (element.kind === "password" || element.kind === "payment") {
      return deny("Password and payment fields are blocked.");
    }
    return { allow: true, kind: "browser" };
  }

  if (element.href && !grantForUrl(element.href, ctx.sites)) {
    return deny("That control leaves the allowlist.");
  }

  switch (classifyControl(element.name, element.kind)) {
    case "blocked":
      return deny(
        normalizeLabel(element.name).split(" ")[0] === "pause"
          ? "Do not click Pause. If a control is named Play, click that once. Otherwise call finish."
          : "Jeco never buys, pays, or changes account security. The user can do that themselves. Call finish.",
      );
    case "publish":
      if (!pageGrant.post) {
        return deny(`Posting is off for ${host}. Use ask_to_post after posting is enabled, or finish.`);
      }
      if (ctx.posted) return deny("This run already posted once. Call finish.");
      return confirm({ kind: "publish", host, control: element.name });
    case "play":
      return confirm({ kind: "play", host, control: element.name });
    case "risky":
      return confirm({ kind: "risky", host, control: element.name, reason: `This changes something on ${host}.` });
    default:
      return { allow: true, kind: "browser" };
  }
}

function deny(reason: string): GateDecision {
  return { allow: false, kind: "deny", reason };
}

function confirm(spec: ConfirmSpec): GateDecision {
  return { allow: false, kind: "confirm", confirm: spec };
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function refField(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return null;
  return value;
}
