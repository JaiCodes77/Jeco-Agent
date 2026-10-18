import assert from "node:assert/strict";
import test from "node:test";
import { packHint } from "../src/packs.ts";

test("youtube pack searches the words left after filler", () => {
  const hint = packHint("open youtube and play a david laid video");
  assert.match(hint, /https:\/\/www\.youtube\.com\/results\?search_query=david%20laid(?:\.|\n|$)/);
  assert.match(hint, /read_page/);
  assert.match(hint, /click the video title link/);
  assert.match(hint, /starts with Play/);
  assert.match(hint, /Never click Pause/);
  assert.equal(hint.includes("linkedin.com"), false);
});

test("play or watch plus a video uses the youtube pack without the word youtube", () => {
  const hint = packHint("watch a video of bach");
  assert.match(hint, /search_query=of%20bach(?:\.|\n|$)/);
  assert.match(hint, /Never click Pause/);
});

test("linkedin pack opens the composer and stops on ask_to_post", () => {
  const hint = packHint("Write a LinkedIn draft: We shipped the pack.");
  assert.match(hint, /https:\/\/www\.linkedin\.com\//);
  assert.match(hint, /click the control that starts a new post/);
  assert.match(hint, /call ask_to_post with the exact text and the composer field's number/i);
  assert.equal(hint.includes("type the draft"), false);
  assert.match(hint, /Never click Post, Tweet, Reply, Send, Submit, or Publish yourself/);
  assert.equal(hint.includes("youtube.com"), false);
  assert.equal(hint.includes("https://x.com/"), false);
});

test("a tweet opens x.com", () => {
  const hint = packHint("tweet good morning");
  assert.match(hint, /https:\/\/x\.com\//);
  assert.match(hint, /ask_to_post/);
  assert.equal(hint.includes("linkedin.com"), false);
});

test("when both sites are named, the earlier name is the one opened", () => {
  const twitterFirst = packHint("post this to twitter and linkedin");
  assert.match(twitterFirst, /https:\/\/x\.com\//);
  assert.equal(twitterFirst.includes("linkedin.com"), false);

  const linkedinFirst = packHint("post this to linkedin and twitter");
  assert.match(linkedinFirst, /https:\/\/www\.linkedin\.com\//);
  assert.equal(linkedinFirst.includes("https://x.com/"), false);
});

test("a named site beats a bare tweet", () => {
  const hint = packHint("tweet this on linkedin");
  assert.match(hint, /https:\/\/www\.linkedin\.com\//);
  assert.equal(hint.includes("https://x.com/"), false);
});

test("tasks that match neither pack get an empty hint", () => {
  assert.equal(packHint("What is open?"), "");
  assert.equal(packHint("Post hello"), "");
});
