import { MODEL_TIMEOUT_MS } from "../limits.ts";
import type { ChatClient, ChatMessage, ChatRequest, ModelTurn, Settings } from "../types.ts";
import { TOOLS } from "./tools.ts";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const FALLBACKS = [
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3.5-lightning:free",
];

export type BaseUrlTarget = { pattern: string; label: string; local: boolean };

export function createClient(settings: Settings, options?: { timeoutMs?: number }): ChatClient {
  return (request) => complete(settings, request, options?.timeoutMs ?? MODEL_TIMEOUT_MS);
}

export function baseUrlTarget(raw: string): BaseUrlTarget | { error: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: "Start the base URL with http:// or https://." };
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "http:" && !local) {
    return { error: "Use https, or a local address like http://localhost:11434/v1." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "Start the base URL with http:// or https://." };
  }
  return { pattern: `${url.protocol}//${url.hostname}/*`, label: url.host, local };
}

async function complete(settings: Settings, request: ChatRequest, timeoutMs: number): Promise<ModelTurn> {
  const config = settings.providers[settings.provider];
  const openRouter = settings.provider === "openrouter";
  const local = settings.provider === "local";
  const baseUrl = local ? config.baseUrl.trim() : "";
  const { messages, signal, tools } = request;
  const models = candidateModels(config.model, config.backupModel, openRouter);
  const endpoint = chatEndpoint(baseUrl);
  const server = local ? "The model server" : "OpenRouter";
  const started = Date.now();
  const skipped: string[] = [];
  let lastError = "The free models are busy. Wait a minute and run the task again.";
  for (let index = 0; index < models.length; index += 1) {
    const candidate = models[index];
    if (signal.aborted) throw new DOMException("Stopped.", "AbortError");
    request.onAttempt?.(candidate, index);
    const attempt = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let response: Response;
    try {
      response = await requestModel(config.apiKey, candidate, messages, attempt, tools, endpoint, openRouter);
    } catch (error) {
      if (signal.aborted) throw new DOMException("Stopped.", "AbortError");
      if (isAbort(error)) {
        lastError = "The model took too long to answer.";
        skipped.push(candidate);
        continue;
      }
      if (error instanceof TypeError) {
        lastError = networkMessage(openRouter, endpoint);
        skipped.push(candidate);
        continue;
      }
      throw error;
    }
    if (response.ok) {
      const turn = await readTurn(response);
      return { ...turn, model: candidate, provider: settings.provider, ms: Date.now() - started, skipped };
    }
    const failure = await failureMessage(response, server, local);
    lastError = failure;
    if (stopNow(response.status, failure)) throw new Error(failure);
    skipped.push(candidate);
  }
  throw new Error(lastError);
}

function stopNow(status: number, failure: string): boolean {
  if (status === 429 && /daily|per day/i.test(failure)) return true;
  return ![408, 429, 404, 500, 502, 503, 504].includes(status);
}

function networkMessage(openRouter: boolean, endpoint: string): string {
  if (!openRouter) {
    return `Jeco could not reach the model server at ${new URL(endpoint).host}. Check that it is running, then press Save in Settings so Brave allows it.`;
  }
  return "Jeco could not reach OpenRouter. Check your connection.";
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function candidateModels(model: string, backupModel: string, openRouter: boolean): string[] {
  const backup = backupModel.trim();
  const models = [model];
  if (backup && backup !== model) models.push(backup);
  if (!openRouter) return models;
  for (const item of FALLBACKS) {
    if (!models.includes(item)) models.push(item);
  }
  return models;
}

export function chatEndpoint(baseUrl?: string): string {
  const raw = baseUrl?.trim() ?? "";
  if (!raw) return ENDPOINT;
  const trimmed = raw.replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

async function requestModel(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  signal: AbortSignal,
  includeTools: boolean,
  endpoint: string,
  openRouter: boolean,
): Promise<Response> {
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0.2,
  };
  if (openRouter) body.reasoning = { enabled: false };
  if (includeTools) {
    body.tools = TOOLS;
    body.tool_choice = "auto";
    body.parallel_tool_calls = false;
  }

  let response = await post(apiKey, body, signal, endpoint, openRouter);
  for (let round = 0; round < 2 && response.status === 400; round += 1) {
    const detail = await response.clone().text();
    const removable = ["reasoning", "parallel_tool_calls", "temperature", "tool_choice"].filter(
      (name) => name in body && new RegExp(name, "i").test(detail),
    );
    if (removable.length === 0) break;
    for (const name of removable) delete body[name];
    response = await post(apiKey, body, signal, endpoint, openRouter);
  }
  return response;
}

async function readTurn(response: Response): Promise<Pick<ModelTurn, "content" | "toolCalls">> {
  const payload = (await response.json()) as {
    choices?: { message?: { content?: unknown; tool_calls?: RawToolCall[] } }[];
  };
  const message = payload.choices?.[0]?.message;
  return {
    content: textContent(message?.content),
    toolCalls: (message?.tool_calls ?? []).map((call, index) => ({
      id: call.id || `call_${index + 1}`,
      name: call.function?.name ?? "",
      args: parseArgs(call.function?.arguments),
    })),
  };
}

async function post(
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  endpoint: string,
  openRouter: boolean,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (openRouter) headers["X-Title"] = "Jeco Agent";
  return await fetch(endpoint, { method: "POST", signal, headers, body: JSON.stringify(body) });
}

async function failureMessage(response: Response, server: string, local: boolean): Promise<string> {
  const detail = await response.text();
  const message = errorText(detail);
  if (response.status === 401) return `${server} rejected the key. Check it in Settings.`;
  if (response.status === 402) return `This model needs credits on ${server}.`;
  if (response.status === 403 && local) {
    return `${server} refused Jeco. If you use Ollama, start it with OLLAMA_ORIGINS=chrome-extension://* so it accepts the extension.`;
  }
  if (response.status === 429) {
    if (/daily|per day/i.test(message)) return "The free daily cap is used up. It resets tomorrow.";
    return "This free model is busy. Wait a minute and run the task again.";
  }
  if (response.status === 404) return `That model is unavailable. ${message}`;
  return `${server} returned ${response.status}. ${message}`;
}

function errorText(detail: string): string {
  try {
    const parsed = JSON.parse(detail) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // The body was not JSON.
  }
  return detail.slice(0, 180);
}

function textContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((part) => {
      if (typeof part === "object" && part && "text" in part) return String((part as { text: unknown }).text);
      return "";
    })
    .join("");
  return text || null;
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

type RawToolCall = {
  id?: string;
  function?: { name?: string; arguments?: string };
};
