import assert from "node:assert/strict";
import test from "node:test";
import { decide, grantForUrl, normalizeHost, parseToolCall } from "../src/gate.ts";
import type { GateContext, PageElement, SiteGrant } from "../src/types.ts";

const youtube: SiteGrant = { host: "youtube.com", interact: true, post: false };
const linkedin: SiteGrant = { host: "linkedin.com", interact: true, post: true };
const readOnly: SiteGrant = { host: "example.com", interact: false, post: false };

function ctx(partial: Partial<GateContext> = {}): GateContext {
  return {
    sites: [youtube, linkedin],
    pageUrl: "https://www.youtube.com/feed",
    elements: [button(4, "Search"), button(9, "Post"), field(3, "text", "Say something")],
    stepsUsed: 1,
    stepCap: 12,
    ...partial,
  };
}

function button(ref: number, name: string): PageElement {
  return { ref, role: "button", name, kind: "button" };
}

function field(ref: number, kind: PageElement["kind"], name: string): PageElement {
  return { ref, role: kind === "password" ? "password" : "textbox", name, kind };
}

test("normalizeHost strips www, path, and scheme", () => {
  assert.equal(normalizeHost("https://www.YouTube.com/feed"), "youtube.com");
  assert.equal(normalizeHost("x.com"), "x.com");
  assert.equal(normalizeHost("localhost"), null);
  assert.equal(normalizeHost("https://user:pass@youtube.com"), null);
  assert.equal(normalizeHost("javascript:alert(1)"), null);
});

test("grantForUrl allows the site and its subdomains only over https", () => {
  assert.equal(grantForUrl("https://m.youtube.com/watch", [youtube])?.host, "youtube.com");
  assert.equal(grantForUrl("https://youtube.com.evil.com/", [youtube]), null);
  assert.equal(grantForUrl("https://notyoutube.com/", [youtube]), null);
  assert.equal(grantForUrl("http://youtube.com/", [youtube]), null);
  assert.equal(grantForUrl("https://evil.com@youtube.com/", [youtube]), null);
});

test("navigation to an allowlisted https url is allowed", () => {
  const call = parseToolCall("open_tab", { url: "https://www.youtube.com/results?search_query=bach" });
  assert.ok(!("error" in call));
  if ("error" in call) return;
  assert.deepEqual(decide(call, ctx({ pageUrl: "chrome://newtab" })), { allow: true, kind: "browser" });
});

test("navigation off the allowlist is denied", () => {
  const call = parseToolCall("navigate", { url: "https://example.org/secret" });
  assert.ok(!("error" in call));
  if ("error" in call) return;
  const decision = decide(call, ctx());
  assert.equal(decision.kind, "deny");
});

test("reading and scrolling need only an allowlisted page", () => {
  const read = parseToolCall("read_page", {});
  const scroll = parseToolCall("scroll", { dy: 9000 });
  assert.ok(!("error" in read) && !("error" in scroll));
  if ("error" in read || "error" in scroll || scroll.name !== "scroll") return;
  assert.equal(scroll.args.dy, 2000);
  assert.equal(decide(read, ctx({ sites: [readOnly], pageUrl: "https://example.com" })).kind, "browser");
  assert.equal(decide(scroll, ctx({ sites: [readOnly], pageUrl: "https://news.example.com" })).kind, "browser");
});

test("interaction is refused on a read-only site", () => {
  const call = parseToolCall("click", { ref: 4 });
  assert.ok(!("error" in call));
  if ("error" in call) return;
  const decision = decide(call, ctx({ sites: [readOnly], pageUrl: "https://example.com", elements: [button(4, "Search")] }));
  assert.equal(decision.kind, "deny");
});

test("password and payment typing is denied", () => {
  for (const kind of ["password", "payment"] as const) {
    const call = parseToolCall("type", { ref: 2, text: "secret" });
    assert.ok(!("error" in call));
    if ("error" in call) return;
    const decision = decide(call, ctx({ elements: [field(2, kind, "Password")] }));
    assert.equal(decision.kind, "deny");
    if (decision.kind === "deny") assert.match(decision.reason, /Password and payment/);
  }
});

test("a publish click confirms when posting is on and denies when it is off", () => {
  const call = parseToolCall("click", { ref: 9 });
  assert.ok(!("error" in call));
  if ("error" in call) return;
  assert.equal(decide(call, ctx({ pageUrl: "https://www.linkedin.com/feed" })).kind, "confirm");
  const denied = decide(call, ctx());
  assert.equal(denied.kind, "deny");
});

test("ask_to_post confirms with the exact text only when posting is on", () => {
  const call = parseToolCall("ask_to_post", { text: "Hello from Jeco" });
  assert.ok(!("error" in call));
  if ("error" in call) return;
  const confirmed = decide(call, ctx({ pageUrl: "https://www.linkedin.com/feed" }));
  assert.equal(confirmed.kind, "confirm");
  if (confirmed.kind === "confirm") assert.match(confirmed.summary, /Hello from Jeco/);
  assert.equal(decide(call, ctx()).kind, "deny");
});

test("a missing control and an unknown tool are denied", () => {
  const click = parseToolCall("click", { ref: 99 });
  assert.ok(!("error" in click));
  if ("error" in click) return;
  assert.equal(decide(click, ctx()).kind, "deny");
  const unknown = parseToolCall("eval", { code: "alert(1)" });
  assert.ok("error" in unknown);
});

test("a publish-like name confirms, and a link off the allowlist is denied", () => {
  const reply = parseToolCall("click", { ref: 8 });
  assert.ok(!("error" in reply));
  if ("error" in reply) return;
  const elements = [
    button(8, "Reply to Ada"),
    { ref: 5, role: "link", name: "Elsewhere", kind: "link" as const, href: "https://evil.example/out" },
  ];
  assert.equal(decide(reply, ctx({ pageUrl: "https://www.linkedin.com/feed", elements })).kind, "confirm");
  const leave = parseToolCall("click", { ref: 5 });
  assert.ok(!("error" in leave));
  if ("error" in leave) return;
  const decision = decide(leave, ctx({ pageUrl: "https://www.linkedin.com/feed", elements }));
  assert.equal(decision.kind, "deny");
  if (decision.kind === "deny") assert.match(decision.reason, /allowlist/);
});

test("a pause control is refused", () => {
  const call = parseToolCall("click", { ref: 8 });
  assert.ok(!("error" in call));
  if ("error" in call) return;
  const decision = decide(call, ctx({ elements: [button(8, "Pause (k)")] }));
  assert.equal(decision.kind, "deny");
  if (decision.kind === "deny") assert.match(decision.reason, /Pause/);
});

test("finish is allowed and the step cap blocks further actions", () => {
  const finish = parseToolCall("finish", { answer: "Done" });
  assert.ok(!("error" in finish));
  if ("error" in finish) return;
  assert.deepEqual(decide(finish, ctx({ stepsUsed: 40 })), { allow: true, kind: "finish", answer: "Done" });
  const read = parseToolCall("read_page", {});
  assert.ok(!("error" in read));
  if ("error" in read) return;
  assert.equal(decide(read, ctx({ stepsUsed: 13 })).kind, "deny");
});
