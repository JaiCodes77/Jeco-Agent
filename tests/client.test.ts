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

test("a busy model is skipped and a daily cap stops", async () => {
  const local = { model: "model-a", backupModel: "model-b", baseUrl: "http://localhost:11434/v1" };
  const busy = createClient(testSettings({ provider: "local", local }));
  const sent = await capture(() => busy({ messages, tools: true, purpose: "step", signal }), 429);
  assert.deepEqual(
    sent.map((item) => item.body.model),
    ["model-a", "model-b"],
  );
  const daily = createClient(testSettings({ openrouter: { apiKey: "key", model: "model-a", backupModel: "model-b" } }));
  const original = globalThis.fetch;
  const dailySent: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    dailySent.push(JSON.parse(String(init.body)).model as string);
    return new Response(JSON.stringify({ error: { message: "daily limit" } }), { status: 429 });
  }) as typeof fetch;
  await daily({ messages, tools: true, purpose: "step", signal }).catch(() => {});
  globalThis.fetch = original;
  assert.deepEqual(dailySent, ["model-a"]);
});

test("a rejected key stops and a server error tries the next model", async () => {
  const denied = createClient(testSettings({ openrouter: { apiKey: "key", model: "model-a", backupModel: "model-b" } }));
  const sent = await capture(() => denied({ messages, tools: true, purpose: "step", signal }), 401);
  assert.equal(sent.length, 1);
  const flaky = createClient(testSettings({ openrouter: { apiKey: "key", model: "model-a", backupModel: "model-b" } }));
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) return new Response("down", { status: 502 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as typeof fetch;
  const turn = await flaky({ messages, tools: true, purpose: "step", signal });
  globalThis.fetch = original;
  assert.deepEqual(turn.skipped, ["model-a"]);
  assert.equal(turn.model, "model-b");
});

test("a timeout tries the next model and a user stop does not", async () => {
  const slow = createClient(testSettings({ openrouter: { apiKey: "key", model: "model-a", backupModel: "model-b" } }), {
    timeoutMs: 20,
  });
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = ((async (_url: string, init: RequestInit) => {
    calls += 1;
    if (calls === 1) {
      return new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new DOMException("timed out", "AbortError")), 1000);
        if (init.signal?.aborted) {
          clearTimeout(timer);
          reject(new DOMException("timed out", "AbortError"));
          return;
        }
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("timed out", "AbortError"));
        });
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as typeof fetch);
  const turn = await slow({ messages, tools: true, purpose: "step", signal });
  globalThis.fetch = original;
  assert.deepEqual(turn.skipped, ["model-a"]);
  const stopped = new AbortController();
  stopped.abort();
  const chat = createClient(testSettings({ openrouter: { apiKey: "key", model: "model-a" } }));
  await assert.rejects(() => chat({ messages, tools: true, purpose: "step", signal: stopped.signal }), (error: Error) => error.name === "AbortError");
});

test("a 400 that names temperature is retried without it", async () => {
  const chat = createClient(testSettings({ openrouter: { apiKey: "key", model: "model-a" } }));
  const bodies: Record<string, unknown>[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push(body);
    if ("temperature" in body) return new Response(JSON.stringify({ error: { message: "temperature unsupported" } }), { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as typeof fetch;
  await chat({ messages, tools: false, purpose: "plan", signal });
  globalThis.fetch = original;
  assert.equal("temperature" in bodies[0], true);
  assert.equal("temperature" in bodies[1], false);
});
