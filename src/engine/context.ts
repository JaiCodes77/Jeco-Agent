import { CONTROL_CAP, MODEL_CHAR_BUDGET, TEXT_CAP } from "../limits.ts";
import { wrapPageText } from "../safety/untrusted.ts";
import type { ChatMessage, PageElement } from "../types.ts";

export type MessageMeta = { kind: "snapshot"; url: string; title: string } | null;

const TRIMMED = " …[trimmed]";

export function compact(messages: ChatMessage[], meta: MessageMeta[], budget = MODEL_CHAR_BUDGET): ChatMessage[] {
  const copy = messages.map((message) => ({ ...message }));
  let latest = -1;
  meta.forEach((item, index) => {
    if (item?.kind === "snapshot") latest = index;
  });
  meta.forEach((item, index) => {
    if (item?.kind === "snapshot" && index !== latest) {
      copy[index] = {
        ...copy[index],
        content: `[Earlier read of "${item.title}" at ${item.url}. A newer read replaced it.]`,
      };
    }
  });
  for (let index = 0; index < copy.length && weight(copy) > budget; index += 1) {
    const message = copy[index];
    if (!message || message.role !== "tool" || index === latest) continue;
    const content = message.content ?? "";
    if (content.length <= 300 || content.endsWith(TRIMMED)) continue;
    copy[index] = { ...message, content: `${content.slice(0, 300)}${TRIMMED}` };
  }
  return copy;
}

function weight(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + (message.content?.length ?? 0), 0);
}

export function formatSnapshot(input: {
  url: string;
  title: string;
  text: string;
  elements: PageElement[];
  total?: number;
}): string {
  const raw = input.text.replace(/\s+\n/g, "\n").trim().slice(0, TEXT_CAP);
  const text = raw ? wrapPageText(raw) : "";
  const total = input.total ?? input.elements.length;
  const shown = input.elements.slice(0, CONTROL_CAP);
  const more =
    total > CONTROL_CAP
      ? `Showing ${CONTROL_CAP} of ${total} controls. Use find to search the rest, or scroll and read again.`
      : "";
  const controls = [shown.map(formatControl).join("\n"), more].filter(Boolean).join("\n");
  return [`URL: ${input.url}`, `Title: ${input.title}`, "Text:", text || "(empty)", "Controls:", controls || "(none)"].join(
    "\n",
  );
}

export function formatControl(item: PageElement): string {
  const href = item.href ? ` -> ${item.href}` : "";
  const state = (item.state ?? []).map((value) => ` [${value}]`).join("");
  return `${item.ref} ${item.role} ${item.name}${href}${state}`.trim();
}
