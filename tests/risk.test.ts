import assert from "node:assert/strict";
import test from "node:test";
import { classifyControl, normalizeLabel } from "../src/safety/risk.ts";

test("normalizeLabel drops key hints, counts, and punctuation", () => {
  assert.equal(normalizeLabel("Play (k)"), "play");
  assert.equal(normalizeLabel("Like 1.2K"), "like");
  assert.equal(normalizeLabel("12 Replies. Reply"), "replies reply");
  assert.equal(normalizeLabel("  Don't   stop! "), "don't stop");
  assert.equal(normalizeLabel("Comment · 3,402"), "comment");
});

test("controls get the tier from the plan", () => {
  const cases: [string, string][] = [
    ["Play (k)", "play"],
    ["Pause (k)", "blocked"],
    ["Post", "publish"],
    ["Repost", "publish"],
    ["Send", "publish"],
    ["Reply to Ada", "publish"],
    ["Schedule post", "publish"],
    ["Like 1.2K", "risky"],
    ["Delete", "risky"],
    ["Subscribe", "risky"],
    ["Follow", "risky"],
    ["Sign out", "risky"],
    ["Delete account", "blocked"],
    ["Buy now", "blocked"],
    ["Place order", "blocked"],
    ["Checkout", "blocked"],
    ["Start a post", "safe"],
    ["Posts", "safe"],
    ["Replies", "safe"],
    ["Search", "safe"],
    ["Playback speed", "safe"],
    ["", "safe"],
  ];
  for (const [name, tier] of cases) {
    assert.equal(classifyControl(name, "button"), tier, name);
  }
});

test("text fields are never classified as risky", () => {
  assert.equal(classifyControl("Post", "text"), "safe");
  assert.equal(classifyControl("Delete account", "password"), "safe");
});

test("links use the same tiers as buttons", () => {
  assert.equal(classifyControl("Unsubscribe", "link"), "risky");
  assert.equal(classifyControl("Home", "link"), "safe");
});
