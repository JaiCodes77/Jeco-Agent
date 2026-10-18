import { CONTROL_CAP, TEXT_CAP } from "../limits.ts";
import type { PageElement } from "../types.ts";

export function formatSnapshot(input: {
  url: string;
  title: string;
  text: string;
  elements: PageElement[];
  total?: number;
}): string {
  const text = input.text.replace(/\s+\n/g, "\n").trim().slice(0, TEXT_CAP);
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
