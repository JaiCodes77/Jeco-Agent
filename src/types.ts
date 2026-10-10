export const DEFAULT_MODEL = "google/gemma-4-26b-a4b-it:free";
export const RETIRED_MODELS = ["qwen/qwen3.8-27b:free"];
export const STEP_CAP = 12;
export const TEXT_CAP = 6000;
export const CONTROL_CAP = 80;

export type SiteGrant = {
  host: string;
  interact: boolean;
  post: boolean;
};

export type SavedTask = {
  name: string;
  task: string;
};

export type Settings = {
  apiKey: string;
  model: string;
  backupModel: string;
  baseUrl: string;
  savedTasks: SavedTask[];
  sites: SiteGrant[];
};

export const EMPTY_SETTINGS: Settings = {
  apiKey: "",
  model: DEFAULT_MODEL,
  backupModel: "",
  baseUrl: "",
  savedTasks: [],
  sites: [],
};

export type PageElement = {
  ref: number;
  role: string;
  name: string;
  kind: "button" | "link" | "text" | "password" | "payment" | "other";
  href?: string;
};

export type PageCommand =
  | { op: "read" }
  | { op: "click"; ref: number }
  | { op: "type"; ref: number; text: string }
  | { op: "scroll"; dy: number }
  | { op: "clickNamed"; names: string[] }
  | { op: "commitPost"; text: string; ref?: number }
  | { op: "frame"; ref: number };

export type PageResult =
  | {
      ok: true;
      op: "read";
      url: string;
      title: string;
      text: string;
      elements: PageElement[];
    }
  | { ok: true; op: "click" | "type" | "scroll" | "clickNamed" | "commitPost"; detail: string }
  | {
      ok: true;
      op: "frame";
      detail: string;
      rect: { x: number; y: number; width: number; height: number };
    }
  | { ok: false; error: string };

export type ToolCall =
  | { name: "open_tab"; args: { url: string } }
  | { name: "navigate"; args: { url: string } }
  | { name: "read_page"; args: Record<string, never> }
  | { name: "click"; args: { ref: number } }
  | { name: "type"; args: { ref: number; text: string } }
  | { name: "scroll"; args: { dy: number } }
  | { name: "ask_to_post"; args: { text: string; ref?: number } }
  | { name: "finish"; args: { answer: string } };

export type GateContext = {
  sites: SiteGrant[];
  pageUrl: string | null;
  elements: PageElement[];
  stepsUsed: number;
  stepCap: number;
};

export type GateDecision =
  | { allow: true; kind: "browser" }
  | { allow: true; kind: "finish"; answer: string }
  | { allow: false; kind: "confirm"; summary: string }
  | { allow: false; kind: "deny"; reason: string };

export interface BrowserPort {
  activeTab(): Promise<{ id: number; url: string } | null>;
  openTab(url: string): Promise<{ id: number; url: string }>;
  navigate(tabId: number, url: string): Promise<{ id: number; url: string }>;
  act(tabId: number, cmd: PageCommand): Promise<PageResult>;
  urlOf(tabId: number): Promise<string | null>;
  close(tabId: number): Promise<void>;
  back(tabId: number): Promise<void>;
  capture(tabId: number): Promise<string | null>;
}

export type ModelToolCall = {
  id: string;
  name: string;
  args: unknown;
};

export type ModelTurn = {
  content: string | null;
  toolCalls: ModelToolCall[];
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
};

export type ChatClient = (
  messages: ChatMessage[],
  signal: AbortSignal,
) => Promise<ModelTurn>;
