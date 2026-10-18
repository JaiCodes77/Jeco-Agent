export type SiteGrant = {
  host: string;
  interact: boolean;
  post: boolean;
};

export type ProviderId = "openrouter" | "openai" | "xai" | "local";

export type ProviderConfig = {
  apiKey: string;
  model: string;
  backupModel: string;
  baseUrl: string;
};

export type SavedTask = {
  id: string;
  name: string;
  task: string;
  createdAt: number;
  lastRun?: { at: number; status: RunStatus };
};

export type Settings = {
  schemaVersion: 3;
  provider: ProviderId;
  providers: Record<ProviderId, ProviderConfig>;
  sites: SiteGrant[];
  savedTasks: SavedTask[];
  privacy: { redactNumbers: boolean };
};

export type ElementKind = "button" | "link" | "text" | "search" | "select" | "password" | "payment" | "other";

export type ElementState = "disabled" | "checked" | "expanded" | "pressed" | "selected";

export type PageElement = {
  ref: number;
  role: string;
  name: string;
  kind: ElementKind;
  href?: string;
  state?: ElementState[];
  multiline?: boolean;
  inView?: boolean;
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

export type ToolName =
  | "open_tab"
  | "navigate"
  | "read_page"
  | "find"
  | "click"
  | "type"
  | "press_enter"
  | "scroll"
  | "go_back"
  | "ask_to_post"
  | "finish";

export type ToolCall =
  | { name: "open_tab"; args: { url: string } }
  | { name: "navigate"; args: { url: string } }
  | { name: "read_page"; args: Record<string, never> }
  | { name: "find"; args: { text: string } }
  | { name: "click"; args: { ref: number } }
  | { name: "type"; args: { ref: number; text: string } }
  | { name: "press_enter"; args: { ref: number } }
  | { name: "scroll"; args: { dy: number } }
  | { name: "go_back"; args: Record<string, never> }
  | { name: "ask_to_post"; args: { text: string; field: number; button?: number } }
  | { name: "finish"; args: { answer: string } };

export type Risk = "safe" | "play" | "publish" | "risky" | "blocked";

export type ConfirmSpec =
  | { kind: "play"; host: string; control: string; context?: string }
  | {
      kind: "publish";
      host: string;
      control: string;
      field?: string;
      text?: string;
      chars?: number;
      warn?: string;
    }
  | { kind: "risky"; host: string; control: string; reason: string }
  | { kind: "scope"; host: string }
  | { kind: "more-steps"; used: number; extra: number };

export type ConfirmRequest = ConfirmSpec & { image?: string | null; outlined?: boolean };

export type GateContext = {
  sites: SiteGrant[];
  pageUrl: string | null;
  elements: PageElement[];
  stepsUsed: number;
  stepCap: number;
  scope: string[] | null;
  posted: boolean;
  wary: boolean;
};

export type GateDecision =
  | { allow: true; kind: "browser" }
  | { allow: true; kind: "finish"; answer: string }
  | { allow: false; kind: "confirm"; confirm: ConfirmSpec }
  | { allow: false; kind: "deny"; reason: string };

export type RecipeId = "youtube.play" | "linkedin.post" | "x.post";

export type Plan = {
  lines: [string, string, string];
  sites: string[];
  missing: string[];
  scope: string[] | null;
  source: "recipe" | "model" | "fallback";
  recipe?: RecipeId;
  recipeTitle?: string;
  draft?: string;
};

export type RunStatus = "done" | "stopped" | "error" | "capped" | "interrupted" | "needs-setup";

export type RunResult = {
  status: RunStatus;
  text: string;
  verified?: boolean;
  setup?: { host: string; need: "site" | "post" };
};

export type StepUpdate = {
  n: number;
  label: string;
  state: "run" | "ok" | "no" | "wait";
};

export type RunEvent =
  | { t: "start"; id: string; task: string; at: number; provider: ProviderId; version: string }
  | { t: "plan"; plan: Plan; approved: boolean }
  | { t: "model"; step: number; model: string; ms: number; skipped: string[] }
  | {
      t: "tool";
      step: number;
      tool: ToolName;
      args: Record<string, unknown>;
      decision: "allow" | "deny" | "confirm" | "finish";
      reason?: string;
    }
  | { t: "confirm"; step: number; kind: ConfirmSpec["kind"]; approved: boolean }
  | { t: "result"; step: number; ok: boolean; summary: string; ms: number }
  | { t: "recipe"; recipe: RecipeId; stage: string; ok: boolean; note?: string }
  | { t: "note"; step: number; text: string }
  | { t: "end"; status: RunStatus; text: string; verified?: boolean; at: number };

export type RunHooks = {
  onStep(step: StepUpdate): void;
  onPlan(plan: Plan): Promise<boolean>;
  onConfirm(request: ConfirmRequest): Promise<boolean>;
  onEvent(event: RunEvent): void;
};

export interface BrowserPort {
  activeTab(): Promise<{ id: number; url: string } | null>;
  openTab(url: string): Promise<{ id: number; url: string }>;
  navigate(tabId: number, url: string): Promise<{ id: number; url: string }>;
  back(tabId: number): Promise<void>;
  urlOf(tabId: number): Promise<string | null>;
  close(tabId: number): Promise<void>;
  act(tabId: number, cmd: PageCommand): Promise<PageResult>;
  settle(tabId: number, opts?: { quietMs?: number; maxMs?: number }): Promise<void>;
  focusTab(tabId: number): Promise<void>;
  capture(tabId: number, rect?: FrameRect): Promise<string | null>;
}

export type ModelToolCall = {
  id: string;
  name: string;
  args: unknown;
};

export type ChatPurpose = "plan" | "step" | "pick" | "draft" | "check";

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
  purpose: ChatPurpose;
  signal: AbortSignal;
  onAttempt?: (model: string, index: number) => void;
};

export type ModelTurn = {
  content: string | null;
  toolCalls: ModelToolCall[];
  model: string;
  provider: ProviderId;
  ms: number;
  skipped: string[];
};

export type ChatClient = (request: ChatRequest) => Promise<ModelTurn>;
