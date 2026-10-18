import assert from "node:assert/strict";
import test from "node:test";
import { compact, type MessageMeta } from "../src/engine/context.ts";
import type { ChatMessage } from "../src/types.ts";

function tool(id: string, content: string): ChatMessage {
  return { role: "tool", tool_call_id: id, content };
}

test("only the latest read stays in full", () => {
  const messages: ChatMessage[] = [tool("a", "read one"), tool("b", "read two"), tool("c", "read three"), tool("d", "read four")];
  const meta: MessageMeta[] = [
    { kind: "snapshot", url: "https://a.example", title: "A" },
    { kind: "snapshot", url: "https://b.example", title: "B" },
    { kind: "snapshot", url: "https://c.example", title: "C" },
    { kind: "snapshot", url: "https://d.example", title: "D" },
  ];
  const compacted = compact(messages, meta, 100000);
  assert.match(compacted[0].content ?? "", /Earlier read of "A"/);
  assert.match(compacted[2].content ?? "", /Earlier read of "C"/);
  assert.equal(compacted[3].content, "read four");
  assert.equal(messages[0].content, "read one");
});

test("every tool call keeps its tool message", () => {
  const messages: ChatMessage[] = [
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read_page", arguments: "{}" } }],
    },
    tool("call_1", "x".repeat(500)),
  ];
  const compacted = compact(messages, [null, null], 100);
  assert.equal(compacted[0].tool_calls?.[0].id, "call_1");
  assert.equal(compacted[1].tool_call_id, "call_1");
});

test("over budget trims the oldest tool text and keeps the task, system, and latest read", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "system " + "s".repeat(400) },
    { role: "user", content: "task " + "u".repeat(400) },
    tool("old", "old " + "o".repeat(400)),
    tool("read", "latest " + "l".repeat(400)),
  ];
  const meta: MessageMeta[] = [null, null, null, { kind: "snapshot", url: "https://yt.example", title: "Watch" }];
  const compacted = compact(messages, meta, 900);
  assert.equal(compacted[0].content, messages[0].content);
  assert.equal(compacted[1].content, messages[1].content);
  assert.match(compacted[2].content ?? "", / …\[trimmed\]$/);
  assert.equal((compacted[2].content ?? "").length, 300 + " …[trimmed]".length);
  assert.equal(compacted[3].content, messages[3].content);
});
