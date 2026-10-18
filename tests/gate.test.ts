import assert from "node:assert/strict";
import test from "node:test";
import { decide, fingerprint, grantForUrl, normalizeHost, parseToolCall } from "../src/gate.ts";
import type { GateContext, GateDecision, PageElement, SiteGrant, ToolCall } from "../src/types.ts";

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
    posted: false,
    ...partial,
  };
}

function button(ref: number, name: string, extra: Partial<PageElement> = {}): PageElement {
  return { ref, role: "button", name, kind: "button", ...extra };
}

function field(ref: number, kind: PageElement["kind"], name: string): PageElement {
  return { ref, role: kind === "password" ? "password" : "textbox", name, kind };
}

function call(name: string, args: unknown): ToolCall {
  const parsed = parseToolCall(name, args);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

function reason(decision: GateDecision): string {
  return decision.kind === "deny" ? decision.reason : "";
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
  const open = call("open_tab", { url: "https://www.youtube.com/results?search_query=bach" });
  assert.deepEqual(decide(open, ctx({ pageUrl: "chrome://newtab" })), { allow: true, kind: "browser" });
});

test("navigation off the allowlist is denied", () => {
  assert.equal(decide(call("navigate", { url: "https://example.org/secret" }), ctx()).kind, "deny");
});

test("reading and scrolling need only an allowlisted page", () => {
  const scroll = call("scroll", { dy: 9000 });
  assert.ok(scroll.name === "scroll");
  assert.equal(scroll.args.dy, 2000);
  assert.equal(decide(call("read_page", {}), ctx({ sites: [readOnly], pageUrl: "https://example.com" })).kind, "browser");
  assert.equal(decide(scroll, ctx({ sites: [readOnly], pageUrl: "https://news.example.com" })).kind, "browser");
});

test("interaction is refused on a read-only site", () => {
  const decision = decide(
    call("click", { ref: 4 }),
    ctx({ sites: [readOnly], pageUrl: "https://example.com", elements: [button(4, "Search")] }),
  );
  assert.equal(decision.kind, "deny");
});

test("password and payment typing is denied", () => {
  for (const kind of ["password", "payment"] as const) {
    const decision = decide(call("type", { ref: 2, text: "secret" }), ctx({ elements: [field(2, kind, "Password")] }));
    assert.match(reason(decision), /Password and payment/);
  }
});

test("a disabled control is denied", () => {
  const elements = [button(4, "Search", { state: ["disabled"] })];
  assert.match(reason(decide(call("click", { ref: 4 }), ctx({ elements }))), /disabled/);
});

test("a publish click confirms when posting is on and denies when it is off", () => {
  const click = call("click", { ref: 9 });
  assert.deepEqual(decide(click, ctx({ pageUrl: "https://www.linkedin.com/feed" })), {
    allow: false,
    kind: "confirm",
    confirm: { kind: "publish", host: "linkedin.com", control: "Post" },
  });
  assert.equal(decide(click, ctx()).kind, "deny");
});

test("ask_to_post needs a text field and confirms with the exact text", () => {
  const post = call("ask_to_post", { text: "Hello from Jeco", field: 3 });
  assert.deepEqual(decide(post, ctx({ pageUrl: "https://www.linkedin.com/feed" })), {
    allow: false,
    kind: "confirm",
    confirm: {
      kind: "publish",
      host: "linkedin.com",
      control: "Post",
      field: "Say something",
      text: "Hello from Jeco",
      chars: 15,
    },
  });
  assert.equal(decide(post, ctx()).kind, "deny");
});

test("ask_to_post refuses a field that is not text and a button that cannot post", () => {
  const onLinkedin = ctx({ pageUrl: "https://www.linkedin.com/feed" });
  assert.match(reason(decide(call("ask_to_post", { text: "Hi", field: 4 }), onLinkedin)), /text field/);
  assert.match(
    reason(decide(call("ask_to_post", { text: "Hi", field: 3, button: 4 }), onLinkedin)),
    /cannot be used to post/,
  );
  const named = decide(call("ask_to_post", { text: "Hi", field: 3, button: 9 }), onLinkedin);
  assert.equal(named.kind === "confirm" && named.confirm.kind === "publish" ? named.confirm.control : "", "Post");
});

test("ask_to_post parsing needs a field and still accepts the V2 ref", () => {
  assert.ok("error" in parseToolCall("ask_to_post", { text: "Hi" }));
  assert.deepEqual(parseToolCall("ask_to_post", { text: "Hi", ref: 3 }), {
    name: "ask_to_post",
    args: { text: "Hi", field: 3 },
  });
  assert.ok("error" in parseToolCall("ask_to_post", { text: "Hi", field: 3, button: "Post" }));
});

test("only one post is allowed per run", () => {
  const onLinkedin = ctx({ pageUrl: "https://www.linkedin.com/feed", posted: true });
  assert.match(reason(decide(call("ask_to_post", { text: "Again", field: 3 }), onLinkedin)), /already posted/);
  assert.match(reason(decide(call("click", { ref: 9 }), onLinkedin)), /already posted/);
});

test("a missing control and an unknown tool are denied", () => {
  assert.equal(decide(call("click", { ref: 99 }), ctx()).kind, "deny");
  assert.ok("error" in parseToolCall("eval", { code: "alert(1)" }));
});

test("a publish-like name confirms, and a link off the allowlist is denied", () => {
  const elements = [
    button(8, "Reply to Ada"),
    { ref: 5, role: "link", name: "Elsewhere", kind: "link" as const, href: "https://evil.example/out" },
  ];
  const page = ctx({ pageUrl: "https://www.linkedin.com/feed", elements });
  assert.equal(decide(call("click", { ref: 8 }), page).kind, "confirm");
  assert.match(reason(decide(call("click", { ref: 5 }), page)), /allowlist/);
});

test("Play (k) confirms and Pause stays denied", () => {
  assert.deepEqual(decide(call("click", { ref: 7 }), ctx({ elements: [button(7, "Play (k)")] })), {
    allow: false,
    kind: "confirm",
    confirm: { kind: "play", host: "youtube.com", control: "Play (k)" },
  });
  assert.match(reason(decide(call("click", { ref: 8 }), ctx({ elements: [button(8, "Pause (k)")] }))), /Pause/);
});

test("risky clicks confirm and blocked clicks are refused even with posting on", () => {
  const risky = decide(call("click", { ref: 6 }), ctx({ elements: [button(6, "Unsubscribe")] }));
  assert.deepEqual(risky, {
    allow: false,
    kind: "confirm",
    confirm: { kind: "risky", host: "youtube.com", control: "Unsubscribe", reason: "This changes something on youtube.com." },
  });
  for (const name of ["Buy now", "Delete account", "Checkout"]) {
    const decision = decide(
      call("click", { ref: 6 }),
      ctx({ pageUrl: "https://www.linkedin.com/feed", elements: [button(6, name)] }),
    );
    assert.match(reason(decision), /never buys, pays, or changes account security/, name);
  }
});

test("finish is allowed and the step cap blocks further actions", () => {
  assert.deepEqual(decide(call("finish", { answer: "Done" }), ctx({ stepsUsed: 40 })), {
    allow: true,
    kind: "finish",
    answer: "Done",
  });
  assert.equal(decide(call("read_page", {}), ctx({ stepsUsed: 13 })).kind, "deny");
});

test("fingerprint keeps the name, kind, and link", () => {
  assert.deepEqual(fingerprint(button(1, "Post")), { name: "Post", kind: "button" });
  assert.deepEqual(fingerprint({ ref: 2, role: "link", name: "Home", kind: "link", href: "https://x.com/home" }), {
    name: "Home",
    kind: "link",
    href: "https://x.com/home",
  });
});
