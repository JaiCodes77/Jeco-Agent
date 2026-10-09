import assert from "node:assert/strict";
import test from "node:test";
import { formatSnapshot } from "../src/snapshot.ts";

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
