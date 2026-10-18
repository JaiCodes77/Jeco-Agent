import assert from "node:assert/strict";
import test from "node:test";
import { classifyKind, isMultiline, type ControlRecord } from "../src/page/classify.ts";

function control(patch: Partial<ControlRecord> & Pick<ControlRecord, "tag">): ControlRecord {
  return { type: "", role: null, autocomplete: "", name: "", id: "", placeholder: "", ariaLabel: "", ...patch };
}

test("fields are classified from their attributes", () => {
  assert.equal(classifyKind(control({ tag: "input", type: "password" })), "password");
  assert.equal(classifyKind(control({ tag: "input", autocomplete: "one-time-code" })), "password");
  assert.equal(classifyKind(control({ tag: "input", placeholder: "Verification code" })), "password");
  assert.equal(classifyKind(control({ tag: "input", name: "cardnumber" })), "payment");
  assert.equal(classifyKind(control({ tag: "input", id: "iban" })), "payment");
  assert.equal(classifyKind(control({ tag: "input", type: "search" })), "search");
  assert.equal(classifyKind(control({ tag: "input", placeholder: "Search" })), "search");
  assert.equal(classifyKind(control({ tag: "input", type: "text", placeholder: "Your name" })), "text");
  assert.equal(classifyKind(control({ tag: "textarea" })), "text");
  assert.equal(isMultiline(control({ tag: "textarea" })), true);
  assert.equal(isMultiline(control({ tag: "input" })), false);
  assert.equal(isMultiline(control({ tag: "div", contentEditable: true })), true);
});

test("buttons, links, selects, and everything else stay distinct", () => {
  assert.equal(classifyKind(control({ tag: "button", ariaLabel: "Search" })), "button");
  assert.equal(classifyKind(control({ tag: "a", role: "link" })), "link");
  assert.equal(classifyKind(control({ tag: "select" })), "select");
  assert.equal(classifyKind(control({ tag: "input", role: "combobox" })), "select");
  assert.equal(classifyKind(control({ tag: "div", role: "combobox", contentEditable: true })), "text");
  assert.equal(classifyKind(control({ tag: "div" })), "other");
});
