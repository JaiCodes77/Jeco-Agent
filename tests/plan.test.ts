import assert from "node:assert/strict";
import test from "node:test";
import { parsePlan, taskWithPlan } from "../src/engine/plan.ts";

const allowed = ["youtube.com", "wikipedia.org"];

test("clean JSON becomes a model plan", () => {
  const plan = parsePlan(
    '{"steps":["Open YouTube","Play the video","Finish"],"sites":["www.youtube.com","example.org"]}',
    "play a video",
    allowed,
    null,
  );
  assert.equal(plan.source, "model");
  assert.deepEqual([...plan.lines], ["Open YouTube", "Play the video", "Finish"]);
  assert.deepEqual(plan.sites, ["youtube.com"]);
  assert.deepEqual(plan.missing, ["example.org"]);
  assert.deepEqual(plan.scope, ["youtube.com"]);
});

test("fenced JSON is read", () => {
  const plan = parsePlan(
    'Plan:\n```json\n{"steps":["One","Two","Three"],"sites":[]}\n```',
    "look around",
    allowed,
    null,
  );
  assert.equal(plan.source, "model");
  assert.deepEqual(plan.scope, null);
});

test("JSON with extra prose is read", () => {
  const plan = parsePlan(
    'Here is the plan {"steps":["One","Two","Three"],"sites":["wikipedia.org"]} thanks',
    "read wikipedia",
    allowed,
    null,
  );
  assert.equal(plan.source, "model");
  assert.deepEqual(plan.sites, ["wikipedia.org"]);
});

test("malformed text falls back to lines and infers sites", () => {
  const plan = parsePlan("1. Open the page\n- Read it\n* Finish up", "visit youtube.com please", allowed, "wikipedia.org");
  assert.equal(plan.source, "fallback");
  assert.deepEqual([...plan.lines], ["Open the page", "Read it", "Finish up"]);
  assert.deepEqual(plan.sites, ["youtube.com", "wikipedia.org"]);
  assert.equal(plan.scope?.[0], "youtube.com");
});

test("fewer than 3 steps are padded and numbering is stripped", () => {
  const plan = parsePlan('{"steps":["2. Only one"],"sites":[]}', "Do a long thing", allowed, null);
  assert.equal(plan.lines[0], "Only one");
  assert.equal(plan.lines.length, 3);
  assert.match(plan.lines[1], /Carry out/);
});

test("more than 3 steps keep the first 3, clipped to 90 characters", () => {
  const long = "x".repeat(120);
  const plan = parsePlan(`{"steps":["${long}","two","three","four"],"sites":[]}`, "task", allowed, null);
  assert.equal(plan.lines[0].length, 90);
  assert.equal(plan.lines[2], "three");
});

test("an empty reply uses the backup plan and an open scope", () => {
  const plan = parsePlan("", "Do the thing", allowed, null);
  assert.equal(plan.source, "fallback");
  assert.equal(plan.scope, null);
  assert.match(plan.lines[0], /Read the request: Do the thing/);
});

test("a subdomain of an allowed site stays on the plan", () => {
  const plan = parsePlan(
    '{"steps":["Open the article","Read it","Finish"],"sites":["en.wikipedia.org"]}',
    "read",
    allowed,
    null,
  );
  assert.deepEqual(plan.sites, ["wikipedia.org"]);
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.scope, ["wikipedia.org"]);
});

test("the approved plan names the sites", () => {
  const plan = parsePlan('{"steps":["One","Two","Three"],"sites":["youtube.com"]}', "play", allowed, null);
  assert.equal(
    taskWithPlan("play", plan),
    "play\n\nApproved plan:\n1. One\n2. Two\n3. Three\nSites: youtube.com",
  );
});
