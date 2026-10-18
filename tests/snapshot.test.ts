import assert from "node:assert/strict";
import test from "node:test";
import { formatSnapshot } from "../src/engine/context.ts";

test("formatSnapshot lists controls and caps nothing small", () => {
  const text = formatSnapshot({
    url: "https://www.youtube.com",
    title: "YouTube",
    text: "Home",
    elements: [{ ref: 2, role: "textbox", name: "Search", kind: "text" }],
  });
  assert.match(text, /URL: https:\/\/www.youtube.com/);
  assert.match(text, /2 textbox Search/);
  assert.doesNotMatch(text, /cookie/i);
});

test("formatSnapshot tags control state so the model sees disabled buttons", () => {
  const text = formatSnapshot({
    url: "https://www.linkedin.com/feed",
    title: "Feed",
    text: "",
    elements: [
      { ref: 9, role: "button", name: "Post", kind: "button", state: ["disabled"] },
      { ref: 4, role: "button", name: "Notifications", kind: "button", state: ["expanded", "pressed"] },
    ],
  });
  assert.match(text, /^9 button Post \[disabled\]$/m);
  assert.match(text, /^4 button Notifications \[expanded\] \[pressed\]$/m);
});
