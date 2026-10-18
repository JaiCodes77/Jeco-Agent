import assert from "node:assert/strict";
import test from "node:test";
import { baseUrlTarget, chatEndpoint, createClient } from "../src/model/client.ts";
import { testSettings } from "./fakes.ts";

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

async function capture(run: () => Promise<unknown>, status = 200): Promise<Sent[]> {
  const sent: Sent[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    const payload = status === 200 ? { choices: [{ message: { content: "ok" } }] } : { error: { message: "nope" } };
    return new Response(JSON.stringify(payload), { status });
  }) as typeof fetch;
  try {
    await run();
  } catch {
    // Failures are asserted by the caller through the captured requests.
  } finally {
    globalThis.fetch = original;
  }
  return sent;
}

const signal = new AbortController().signal;
const messages = [{ role: "user" as const, content: "Hi" }];

test("a plan request sends no tools", async () => {
  const chat = createClient(testSettings({ openrouter: { apiKey: "key", model: "model-a" } }));
  const [sent] = await capture(() => chat({ messages, tools: false, purpose: "plan", signal }));
  assert.equal("tools" in sent.body, false);
  assert.equal("tool_choice" in sent.body, false);
  const [step] = await capture(() => chat({ messages, tools: true, purpose: "step", signal }));
  assert.ok(Array.isArray(step.body.tools));
});

test("OpenRouter gets the key, reasoning off, and the app title", async () => {
  const chat = createClient(testSettings({ openrouter: { apiKey: "key", model: "model-a" } }));
  const [sent] = await capture(() => chat({ messages, tools: true, purpose: "step", signal }));
  assert.equal(sent.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(sent.headers.Authorization, "Bearer key");
  assert.equal(sent.headers["X-Title"], "Jeco Agent");
  assert.deepEqual(sent.body.reasoning, { enabled: false });
});

test("a local server gets no key header and no OpenRouter extras", async () => {
  const chat = createClient(
    testSettings({
      provider: "local",
      local: { model: "llama3.2", baseUrl: "http://localhost:11434/v1/" },
    }),
  );
  const [sent] = await capture(() => chat({ messages, tools: true, purpose: "step", signal }));
  assert.equal(sent.url, "http://localhost:11434/v1/chat/completions");
  assert.equal("Authorization" in sent.headers, false);
  assert.equal("X-Title" in sent.headers, false);
  assert.equal("reasoning" in sent.body, false);
});

test("a local server does not fall back to OpenRouter free models", async () => {
  const chat = createClient(
    testSettings({ provider: "local", local: { model: "llama3.2", baseUrl: "http://localhost:11434/v1" } }),
  );
  const sent = await capture(() => chat({ messages, tools: true, purpose: "step", signal }), 404);
  assert.deepEqual(
    sent.map((item) => item.body.model),
    ["llama3.2"],
  );
});

test("baseUrlTarget allows https anywhere and http only on this Mac", () => {
  assert.deepEqual(baseUrlTarget("http://localhost:11434/v1"), {
    pattern: "http://localhost/*",
    label: "localhost:11434",
    local: true,
  });
  assert.deepEqual(baseUrlTarget("http://127.0.0.1:1234/v1"), {
    pattern: "http://127.0.0.1/*",
    label: "127.0.0.1:1234",
    local: true,
  });
  assert.deepEqual(baseUrlTarget("https://api.example.com/v1"), {
    pattern: "https://api.example.com/*",
    label: "api.example.com",
    local: false,
  });
  assert.ok("error" in baseUrlTarget("http://192.168.1.5:11434/v1"));
  assert.ok("error" in baseUrlTarget("localhost:11434"));
  assert.ok("error" in baseUrlTarget("ftp://example.com"));
});

test("chatEndpoint appends the completions path once", () => {
  assert.equal(chatEndpoint(""), "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(chatEndpoint("http://localhost:11434/v1"), "http://localhost:11434/v1/chat/completions");
  assert.equal(chatEndpoint("http://localhost:11434/v1/chat/completions/"), "http://localhost:11434/v1/chat/completions");
});
