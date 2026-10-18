import type { ChatClient, ChatMessage, ChatRequest, ModelTurn } from "./types.ts";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const FALLBACKS = [
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3.5-lightning:free",
];

const TOOLS = [
  {
    type: "function",
    function: {
      name: "open_tab",
      description: "Open an https URL in a new tab. The host must already be allowlisted.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "navigate",
      description: "Go to an https URL in the current tab. The host must already be allowlisted.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_page",
      description: "Read the current page: title, visible text, and numbered controls.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "click",
      description: "Click one numbered control from the latest read_page result.",
      parameters: {
        type: "object",
        properties: { ref: { type: "integer" } },
        required: ["ref"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "type",
      description: "Type text into one numbered text control. Password and payment fields are blocked.",
      parameters: {
        type: "object",
        properties: { ref: { type: "integer" }, text: { type: "string" } },
        required: ["ref", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scroll",
      description: "Scroll the current page vertically by dy pixels.",
      parameters: {
        type: "object",
        properties: { dy: { type: "integer" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_to_post",
      description:
        "Ask the user to approve a post. Jeco types the exact text into the numbered text field, shows it, and presses the post button next to that field only after the user approves.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          field: { type: "integer", description: "The text field from read_page." },
          button: { type: "integer", description: "Optional post button from read_page." },
        },
        required: ["text", "field"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "End the task and tell the user the result.",
      parameters: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
    },
  },
];

type ClientOptions = { backupModel?: string; baseUrl?: string };

export type BaseUrlTarget = { pattern: string; label: string; local: boolean };

export function createOpenRouterClient(apiKey: string, model: string, options?: ClientOptions): ChatClient {
  return (request) => complete(apiKey, model, request, options);
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

async function complete(
  apiKey: string,
  model: string,
  request: ChatRequest,
  options?: ClientOptions,
): Promise<ModelTurn> {
  const { messages, signal, tools } = request;
  const baseUrl = options?.baseUrl?.trim() ?? "";
  const models = candidateModels(model, options);
  const endpoint = chatEndpoint(baseUrl);
  const server = baseUrl ? "The model server" : "OpenRouter";
  let lastError = "The free models are busy. Wait a minute and run the task again.";
  for (const candidate of models) {
    if (signal.aborted) throw new DOMException("Stopped.", "AbortError");
    const response = await requestModel(apiKey, candidate, messages, signal, tools, endpoint, !baseUrl);
    if (response.ok) return readTurn(response);
    const failure = await failureMessage(response, server, Boolean(baseUrl));
    lastError = failure;
    const busy = response.status === 429 || response.status === 404;
    if (!busy || /daily|per day/i.test(failure)) throw new Error(failure);
  }
  throw new Error(lastError);
}

function candidateModels(model: string, options?: ClientOptions): string[] {
  const backup = options?.backupModel?.trim() ?? "";
  const local = Boolean(options?.baseUrl?.trim());
  const models = [model];
  if (backup && backup !== model) models.push(backup);
  if (local) return models;
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
  if (response.status === 400) {
    const detail = await response.clone().text();
    if (/reasoning/i.test(detail) && "reasoning" in body) {
      delete body.reasoning;
      response = await post(apiKey, body, signal, endpoint, openRouter);
    }
    if (includeTools && response.status === 400) {
      const again = await response.clone().text();
      if (/parallel_tool_calls/i.test(again)) {
        delete body.parallel_tool_calls;
        response = await post(apiKey, body, signal, endpoint, openRouter);
      }
    }
  }
  return response;
}

async function readTurn(response: Response): Promise<ModelTurn> {
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
  try {
    return await fetch(endpoint, { method: "POST", signal, headers, body: JSON.stringify(body) });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    if (!openRouter) {
      throw new Error(
        `Jeco could not reach the model server at ${new URL(endpoint).host}. Check that it is running, then press Save in Settings so Brave allows it.`,
      );
    }
    throw new Error("Jeco could not reach OpenRouter. Check your connection.");
  }
}

async function failureMessage(response: Response, server: string, local: boolean): Promise<string> {
  const detail = await response.text();
  const message = errorText(detail);
  if (response.status === 401) return `${server} rejected the key. Check it in Settings.`;
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
