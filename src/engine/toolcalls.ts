import type { ChatMessage } from "../types.ts";
import type { ModelToolCall, ToolName } from "../types.ts";

const TOOLS = new Set<ToolName>([
  "open_tab",
  "navigate",
  "read_page",
  "find",
  "click",
  "type",
  "press_enter",
  "scroll",
  "go_back",
  "ask_to_post",
  "finish",
]);

export function toolCallFromText(content: string | null, step: number): ModelToolCall | null {
  for (const value of jsonCandidates(content ?? "")) {
    const call = asToolCall(value, step);
    if (call) return call;
  }
  return null;
}

export function jsonCandidates(text: string): unknown[] {
  const found: unknown[] = [];
  const tagged = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/i);
  pushParsed(found, tagged?.[1]);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  pushParsed(found, fenced?.[1]);
  for (const block of balancedObjects(text)) pushParsed(found, block);
  return found;
}

function asToolCall(value: unknown, step: number): ModelToolCall | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const nested = record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>) : null;
  const name = stringValue(record.name) || stringValue(record.tool) || stringValue(nested?.name);
  if (!name || !TOOLS.has(name as ToolName)) return null;
  const args = argsValue(record.arguments ?? record.args ?? record.parameters ?? nested?.arguments ?? {});
  return { id: `text_call_${step}`, name, args };
}

function argsValue(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" ? value : {};
}

function pushParsed(found: unknown[], raw: string | undefined): void {
  if (!raw) return;
  try {
    found.push(JSON.parse(raw) as unknown);
  } catch {
    // The next candidate may still be valid JSON.
  }
}

function balancedObjects(text: string): string[] {
  const blocks: string[] = [];
  let start = -1;
  let depth = 0;
  let quote = false;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') quote = true;
    else if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) blocks.push(text.slice(start, i + 1));
    }
  }
  return blocks;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
