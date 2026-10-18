export const DEFAULT_MODEL = "google/gemma-4-26b-a4b-it:free";
export const RETIRED_MODELS = ["qwen/qwen3.8-27b:free"];
export const STEP_CAP = 12;
export const TEXT_CAP = 6000;
export const CONTROL_CAP = 80;
export const NAV_TIMEOUT_MS = 15000;
export const SETTLE_QUIET_MS = 400;
export const SETTLE_MAX_MS = 2500;

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

export type ElementKind = "button" | "link" | "text" | "password" | "payment" | "other";

export type ElementState = "disabled" | "checked" | "expanded" | "pressed" | "selected";

export type PageElement = {
  ref: number;
  role: string;
  name: string;
  kind: ElementKind;
  href?: string;
  state?: ElementState[];
  multiline?: boolean;
};

export type Fingerprint = { name: string; kind: ElementKind; href?: string };

export type FrameRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  dpr: number;
  viewportWidth: number;
};

export type PageCommand =
  | { op: "read" }
  | { op: "click"; ref: number; expect: Fingerprint }
  | { op: "type"; ref: number; text: string; expect: Fingerprint }
  | { op: "scroll"; dy: number }
  | { op: "frame"; ref: number; label: string }
  | { op: "unframe" }
  | { op: "fieldText"; ref: number }
  | { op: "pairPost"; field: number; button?: number };

export type PageResult =
  | {
      ok: true;
      op: "read";
      url: string;
      title: string;
      text: string;
      elements: PageElement[];
    }
  | { ok: true; op: "click" | "type" | "scroll" | "unframe"; detail: string }
  | { ok: true; op: "frame"; rect: FrameRect }
  | { ok: true; op: "fieldText"; text: string; gone: boolean }
  | {
      ok: true;
      op: "pairPost";
      field: PageElement;
      button: PageElement;
      container: "dialog" | "form" | "ancestor";
    }
  | { ok: false; error: string; stale?: boolean };

export type ToolCall =
  | { name: "open_tab"; args: { url: string } }
  | { name: "navigate"; args: { url: string } }
  | { name: "read_page"; args: Record<string, never> }
  | { name: "click"; args: { ref: number } }
  | { name: "type"; args: { ref: number; text: string } }
  | { name: "scroll"; args: { dy: number } }
  | { name: "ask_to_post"; args: { text: string; field: number; button?: number } }
  | { name: "finish"; args: { answer: string } };

export type Risk = "safe" | "play" | "publish" | "risky" | "blocked";

export type ConfirmSpec =
  | { kind: "play"; host: string; control: string }
  | {
      kind: "publish";
      host: string;
      control: string;
      field?: string;
      text?: string;
      chars?: number;
      warn?: string;
    }
  | { kind: "risky"; host: string; control: string; reason: string };

export type ConfirmRequest = ConfirmSpec & { image?: string | null; outlined?: boolean };

export type GateContext = {
  sites: SiteGrant[];
  pageUrl: string | null;
  elements: PageElement[];
  stepsUsed: number;
  stepCap: number;
  posted: boolean;
};

export type GateDecision =
  | { allow: true; kind: "browser" }
  | { allow: true; kind: "finish"; answer: string }
  | { allow: false; kind: "confirm"; confirm: ConfirmSpec }
  | { allow: false; kind: "deny"; reason: string };

export interface BrowserPort {
  activeTab(): Promise<{ id: number; url: string } | null>;
  openTab(url: string): Promise<{ id: number; url: string }>;
  navigate(tabId: number, url: string): Promise<{ id: number; url: string }>;
  act(tabId: number, cmd: PageCommand): Promise<PageResult>;
  settle(tabId: number, opts?: { quietMs?: number; maxMs?: number }): Promise<void>;
  focusTab(tabId: number): Promise<void>;
  urlOf(tabId: number): Promise<string | null>;
  close(tabId: number): Promise<void>;
  back(tabId: number): Promise<void>;
  capture(tabId: number, rect?: FrameRect): Promise<string | null>;
}

export type RunStatus = "done" | "stopped" | "error" | "capped";

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

export type ChatRequest = {
  messages: ChatMessage[];
  tools: boolean;
  signal: AbortSignal;
};

export type ChatClient = (request: ChatRequest) => Promise<ModelTurn>;
