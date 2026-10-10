import type { GateContext, GateDecision, PageElement, SiteGrant, ToolCall } from "./types.ts";

const PUBLISH_NAMES = new Set([
  "post",
  "tweet",
  "reply",
  "repost",
  "send",
  "submit",
  "publish",
]);

const MAX_TEXT = 4000;

export function normalizeHost(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  try {
    const withProto = raw.includes("://") ? raw : `https://${raw}`;
    const url = new URL(withProto);
    if (url.username || url.password) return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    let host = url.hostname;
    if (!host || host === "localhost" || !host.includes(".")) return null;
    if (host.startsWith("www.")) host = host.slice(4);
    return host;
  } catch {
    return null;
  }
}

export function grantForUrl(url: string, sites: SiteGrant[]): SiteGrant | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  return (
    sites.find((site) => host === site.host || host.endsWith(`.${site.host}`)) ??
    null
  );
}

export function isPublishName(name: string): boolean {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return false;
  if (PUBLISH_NAMES.has(normalized)) return true;
  const first = normalized.split(" ")[0]?.replace(/[^a-z]/g, "") ?? "";
  return PUBLISH_NAMES.has(first);
}

export function isPauseName(name: string): boolean {
  const first = name.trim().toLowerCase().split(/\s+/)[0]?.replace(/[^a-z]/g, "") ?? "";
  return first === "pause";
}

export function isPlayName(name: string): boolean {
  const first = name.trim().toLowerCase().split(/\s+/)[0]?.replace(/[^a-z]/g, "") ?? "";
  return first === "play";
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
      const ref = record.ref == null ? undefined : refField(record.ref);
      if (record.ref != null && ref == null) return { error: "ask_to_post ref must be a control number." };
      return { name, args: ref == null ? { text } : { text, ref } };
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
    return { allow: false, kind: "deny", reason: `Stopped after ${ctx.stepCap} steps.` };
  }

  if (call.name === "open_tab" || call.name === "navigate") {
    const grant = grantForUrl(call.args.url, ctx.sites);
    if (!grant) {
      return {
        allow: false,
        kind: "deny",
        reason: "That address is not on the allowlist. Add the site in Settings, or finish.",
      };
    }
    return { allow: true, kind: "browser" };
  }

  const pageGrant = ctx.pageUrl ? grantForUrl(ctx.pageUrl, ctx.sites) : null;
  if (!pageGrant) {
    return {
      allow: false,
      kind: "deny",
      reason: "The current tab is not an allowed site. Open an allowed https page first.",
    };
  }

  if (call.name === "read_page" || call.name === "scroll") {
    return { allow: true, kind: "browser" };
  }

  if (!pageGrant.interact) {
    return {
      allow: false,
      kind: "deny",
      reason: `${pageGrant.host} is read-only. Turn on interaction in Settings, or finish.`,
    };
  }

  if (call.name === "ask_to_post") {
    if (!pageGrant.post) {
      return {
        allow: false,
        kind: "deny",
        reason: `Posting is off for ${pageGrant.host}. Turn it on in Settings, or finish.`,
      };
    }
    if (call.args.ref != null) {
      const target = ctx.elements.find((item) => item.ref === call.args.ref);
      if (!target) {
        return {
          allow: false,
          kind: "deny",
          reason: "That control number is not on the page. Call read_page again.",
        };
      }
      if (target.kind !== "text" && !isPublishName(target.name)) {
        return {
          allow: false,
          kind: "deny",
          reason: "That control cannot be used to post.",
        };
      }
    }
    return {
      allow: false,
      kind: "confirm",
      summary: `Post this on ${pageGrant.host}?\n\n${call.args.text}`,
    };
  }

  const element = ctx.elements.find((item) => item.ref === call.args.ref);
  if (!element) {
    return {
      allow: false,
      kind: "deny",
      reason: "That control number is not on the page. Call read_page again.",
    };
  }

  if (call.name === "type" && (element.kind === "password" || element.kind === "payment")) {
    return {
      allow: false,
      kind: "deny",
      reason: "Password and payment fields are blocked.",
    };
  }

  if (call.name === "click" && isPauseName(element.name)) {
    return {
      allow: false,
      kind: "deny",
      reason: "Do not click Pause. If a control is named Play, click that once. Otherwise call finish.",
    };
  }

  if (call.name === "click" && element.href && !grantForUrl(element.href, ctx.sites)) {
    return {
      allow: false,
      kind: "deny",
      reason: "That control leaves the allowlist.",
    };
  }

  if (call.name === "click" && isPublishName(element.name)) {
    if (!pageGrant.post) {
      return {
        allow: false,
        kind: "deny",
        reason: `Posting is off for ${pageGrant.host}. Use ask_to_post after posting is enabled, or finish.`,
      };
    }
    return {
      allow: false,
      kind: "confirm",
      summary: `Click "${element.name}" on ${pageGrant.host}?`,
    };
  }

  if (call.name === "click" && isPlayName(element.name)) {
    return {
      allow: false,
      kind: "confirm",
      summary: `Play "${element.name}" on ${pageGrant.host}?`,
    };
  }

  return { allow: true, kind: "browser" };
}

export function elementByRef(elements: PageElement[], ref: number): PageElement | undefined {
  return elements.find((item) => item.ref === ref);
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function refField(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return null;
  return value;
}
