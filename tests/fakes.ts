import type {
  BrowserPort,
  ChatClient,
  ChatRequest,
  FrameRect,
  ModelTurn,
  PageCommand,
  PageElement,
  PageResult,
} from "../src/types.ts";

export const IMAGE = "data:image/png;base64,AAAA";

const RECT: FrameRect = { x: 10, y: 20, width: 80, height: 30, dpr: 2, viewportWidth: 1280 };

export type FakePage = {
  url: string | null;
  elements: PageElement[];
  field: PageElement;
  button: PageElement;
  text: string;
  fieldGone: boolean;
  stale: Set<number>;
  rewrite?: (typed: string) => string;
  clearOnPost: boolean;
};

export type FakeBrowser = BrowserPort & {
  page: FakePage;
  log: string[];
  commands: PageCommand[];
  opened: string[];
};

export function control(ref: number, name: string, extra: Partial<PageElement> = {}): PageElement {
  return { ref, role: "button", name, kind: "button", ...extra };
}

export function fakeBrowser(url: string | null, patch: Partial<FakePage> = {}): FakeBrowser {
  const field: PageElement = { ref: 3, role: "textbox", name: "What do you want to talk about?", kind: "text" };
  const button = control(9, "Post");
  const page: FakePage = {
    url,
    elements: [field, button, control(4, "Search")],
    field,
    button,
    text: "",
    fieldGone: false,
    stale: new Set(),
    clearOnPost: true,
    ...patch,
  };
  const log: string[] = [];
  const commands: PageCommand[] = [];
  const opened: string[] = [];
  const id = 7;

  return {
    page,
    log,
    commands,
    opened,
    async activeTab() {
      return page.url ? { id, url: page.url } : null;
    },
    async openTab(target) {
      opened.push(target);
      page.url = target;
      log.push("open");
      return { id, url: target };
    },
    async navigate(_tabId, target) {
      page.url = target;
      log.push("navigate");
      return { id, url: target };
    },
    async act(_tabId, cmd) {
      commands.push(cmd);
      log.push("ref" in cmd ? `${cmd.op} ${cmd.ref}` : cmd.op);
      return run(cmd);
    },
    async settle() {
      log.push("settle");
    },
    async focusTab() {
      log.push("focus");
    },
    async urlOf() {
      return page.url;
    },
    async close() {
      page.url = null;
    },
    async back() {
      log.push("back");
    },
    async capture(_tabId, rect) {
      log.push("capture");
      return rect ? IMAGE : null;
    },
  };

  function run(cmd: PageCommand): PageResult {
    switch (cmd.op) {
      case "read":
        return { ok: true, op: "read", url: page.url ?? "", title: "Page", text: "Hello", elements: page.elements };
      case "click":
      case "type": {
        if (page.stale.has(cmd.ref)) {
          return { ok: false, stale: true, error: `Control ${cmd.ref} changed. Read the page again.` };
        }
        const element = page.elements.find((item) => item.ref === cmd.ref);
        if (!element) return { ok: false, stale: true, error: `Control ${cmd.ref} is gone. Read the page again.` };
        if (cmd.op === "type") {
          page.text = page.rewrite ? page.rewrite(cmd.text) : cmd.text;
          return { ok: true, op: "type", detail: "Typed." };
        }
        if (element.ref === page.button.ref && page.clearOnPost) page.text = "";
        return { ok: true, op: "click", detail: `Clicked ${element.name}.` };
      }
      case "scroll":
        return { ok: true, op: "scroll", detail: "Scrolled." };
      case "frame":
        return { ok: true, op: "frame", rect: RECT };
      case "unframe":
        return { ok: true, op: "unframe", detail: "Cleared." };
      case "fieldText":
        return { ok: true, op: "fieldText", text: page.fieldGone ? "" : page.text, gone: page.fieldGone };
      case "pairPost":
        return { ok: true, op: "pairPost", field: page.field, button: page.button, container: "dialog" };
    }
  }
}

export function scripted(
  turns: ModelTurn[],
  seen: ChatRequest[] = [],
  plan: string | Error = "Check the page\nDo the task\nFinish with the answer",
): ChatClient {
  const queue = [...turns];
  return async (request) => {
    seen.push({ ...request, messages: [...request.messages] });
    if (!request.tools) {
      if (plan instanceof Error) throw plan;
      return { content: plan, toolCalls: [] };
    }
    const next = queue.shift();
    if (!next) throw new Error("The test model ran out of turns.");
    return next;
  };
}

export function turn(name: string, args: unknown = {}, id = name): ModelTurn {
  return { content: null, toolCalls: [{ id, name, args }] };
}

export function toolReplies(seen: ChatRequest[]): string[] {
  const last = seen.filter((request) => request.tools).at(-1);
  return (last?.messages ?? []).filter((message) => message.role === "tool").map((message) => message.content ?? "");
}
