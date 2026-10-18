import assert from "node:assert/strict";
import test from "node:test";
import { toolCallFromText } from "../src/engine/toolcalls.ts";

test("a tool_call tag is read", () => {
  const call = toolCallFromText('Sure.\n<tool_call>{"name":"finish","arguments":{"answer":"Done."}}</tool_call>', 4);
  assert.deepEqual(call, { id: "text_call_4", name: "finish", args: { answer: "Done." } });
});

test("a fenced block is read", () => {
  const call = toolCallFromText('```json\n{"tool":"scroll","args":{"dy":200}}\n```', 2);
  assert.deepEqual(call, { id: "text_call_2", name: "scroll", args: { dy: 200 } });
});

test("a bare object is read", () => {
  const call = toolCallFromText('I should {"name":"read_page","parameters":{}} now.', 1);
  assert.equal(call?.name, "read_page");
});

test("arguments may be a JSON string", () => {
  const call = toolCallFromText('{"function":{"name":"click","arguments":"{\\"ref\\":3}"}}', 1);
  assert.deepEqual(call?.args, { ref: 3 });
});

test("an unknown tool name is ignored", () => {
  assert.equal(toolCallFromText('{"name":"eval","arguments":{}}', 1), null);
});

test("two objects use the first valid one", () => {
  const call = toolCallFromText('{"name":"go_back","arguments":{}} then {"name":"finish","arguments":{"answer":"no"}}', 1);
  assert.equal(call?.name, "go_back");
});

test("plain prose has no tool call", () => {
  assert.equal(toolCallFromText("The video is about training.", 1), null);
});
