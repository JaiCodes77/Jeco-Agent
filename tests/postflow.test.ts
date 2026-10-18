import assert from "node:assert/strict";
import test from "node:test";
import { postFlow, type PostFlowInput } from "../src/engine/post-flow.ts";
import type { ConfirmRequest } from "../src/types.ts";
import { control, fakeBrowser, IMAGE, type FakeBrowser } from "./fakes.ts";

function flow(browser: FakeBrowser, confirm: PostFlowInput["confirm"], text = "Hello from Jeco") {
  return postFlow({ browser, tabId: 7, host: "linkedin.com", text, field: 3, confirm });
}

function clicks(browser: FakeBrowser): number[] {
  return browser.commands.flatMap((cmd) => (cmd.op === "click" ? [cmd.ref] : []));
}

test("an approved post types, shows the exact text, then presses the paired button", async () => {
  const browser = fakeBrowser("https://www.linkedin.com/feed");
  const requests: ConfirmRequest[] = [];
  const result = await flow(browser, async (request) => {
    requests.push(request);
    assert.equal(clicks(browser).length, 0);
    assert.equal(browser.page.text, "Hello from Jeco");
    return true;
  });

  assert.deepEqual(result.status, "posted");
  assert.equal(result.verified, true);
  assert.equal(result.message, "Posted on linkedin.com.");
  assert.deepEqual(requests, [
    {
      kind: "publish",
      host: "linkedin.com",
      control: "Post",
      field: "What do you want to talk about?",
      text: "Hello from Jeco",
      chars: 15,
      image: IMAGE,
      outlined: true,
    },
  ]);
  assert.deepEqual(clicks(browser), [9]);
  assert.deepEqual(browser.log.slice(0, 9), [
    "pairPost",
    "type 3",
    "settle",
    "fieldText 3",
    "pairPost",
    "focus",
    "frame 9",
    "capture",
    "unframe",
  ]);
  const click = browser.commands.find((cmd) => cmd.op === "click");
  assert.deepEqual(click, { op: "click", ref: 9, expect: { name: "Post", kind: "button" } });
});

test("a declined post leaves the draft and never clicks", async () => {
  const browser = fakeBrowser("https://www.linkedin.com/feed");
  const result = await flow(browser, async () => false);
  assert.equal(result.status, "declined");
  assert.equal(result.message, "The user did not post. The draft is still in the field.");
  assert.deepEqual(clicks(browser), []);
  assert.equal(browser.page.text, "Hello from Jeco");
  assert.ok(browser.log.includes("unframe"));
});

test("text changed by the site while typing is never posted", async () => {
  const browser = fakeBrowser("https://www.linkedin.com/feed", { rewrite: (typed) => `${typed} #ad` });
  let asked = false;
  const result = await flow(browser, async () => {
    asked = true;
    return true;
  });
  assert.equal(result.status, "failed");
  assert.equal(result.message, "The site changed the text while typing. Nothing was posted.");
  assert.equal(asked, false);
  assert.deepEqual(clicks(browser), []);
});

test("spacing differences from the editor still count as the same text", async () => {
  const browser = fakeBrowser("https://www.linkedin.com/feed", { rewrite: (typed) => ` ${typed.replace(" ", "\u00a0")}\n` });
  const result = await flow(browser, async () => true);
  assert.equal(result.status, "posted");
});

test("a button that stays disabled is never confirmed or pressed", async () => {
  const browser = fakeBrowser("https://www.linkedin.com/feed", { button: control(9, "Post", { state: ["disabled"] }) });
  let asked = false;
  const result = await flow(browser, async () => {
    asked = true;
    return true;
  });
  assert.equal(result.message, "The post button is still disabled. Nothing was posted.");
  assert.equal(asked, false);
  assert.deepEqual(clicks(browser), []);
});

test("text edited by the user during the card is confirmed again before posting", async () => {
  const browser = fakeBrowser("https://www.linkedin.com/feed");
  const requests: ConfirmRequest[] = [];
  const result = await flow(browser, async (request) => {
    requests.push(request);
    if (requests.length === 1) browser.page.text = "Hello from Jai";
    return true;
  });
  assert.equal(result.status, "posted");
  assert.equal(requests.length, 2);
  const second = requests[1];
  assert.ok(second.kind === "publish");
  assert.equal(second.text, "Hello from Jai");
  assert.equal(second.warn, "The text in the page changed.");
  assert.deepEqual(clicks(browser), [9]);
});

test("declining the second card after an edit does not post", async () => {
  const browser = fakeBrowser("https://www.linkedin.com/feed");
  let count = 0;
  const result = await flow(browser, async () => {
    count += 1;
    if (count === 1) browser.page.text = "Edited";
    return count === 1;
  });
  assert.equal(result.status, "declined");
  assert.deepEqual(clicks(browser), []);
});

test("a field that does not clear after the click is reported as unverified", async () => {
  const browser = fakeBrowser("https://www.linkedin.com/feed", { clearOnPost: false });
  const result = await flow(browser, async () => true);
  assert.equal(result.status, "posted");
  assert.equal(result.verified, false);
  assert.match(result.message, /Pressed Post on linkedin\.com\. Jeco could not confirm the post went out/);
});

test("a field that cannot be paired types nothing", async () => {
  const browser = fakeBrowser("https://www.linkedin.com/feed");
  browser.act = async (_tabId, cmd) => {
    browser.commands.push(cmd);
    return { ok: false, error: "No post button sits next to that field." };
  };
  const result = await flow(browser, async () => true);
  assert.equal(result.status, "failed");
  assert.equal(result.message, "No post button sits next to that field. Nothing was typed.");
  assert.deepEqual(
    browser.commands.map((cmd) => cmd.op),
    ["pairPost"],
  );
});

test("the outline is cleared even when the card throws", async () => {
  const browser = fakeBrowser("https://www.linkedin.com/feed");
  await assert.rejects(
    flow(browser, async () => {
      throw new Error("Panel closed");
    }),
  );
  assert.ok(browser.log.includes("unframe"));
  assert.deepEqual(clicks(browser), []);
});
