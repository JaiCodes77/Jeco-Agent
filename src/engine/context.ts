import { TEXT_CAP } from "../limits.ts";
import type { PageElement } from "../types.ts";

export function formatSnapshot(input: {
  url: string;
  title: string;
  text: string;
  elements: PageElement[];
}): string {
  const text = input.text.replace(/\s+\n/g, "\n").trim().slice(0, TEXT_CAP);
  const controls = input.elements.map(controlLine).join("\n");
  return [`URL: ${input.url}`, `Title: ${input.title}`, "Text:", text || "(empty)", "Controls:", controls || "(none)"].join(
    "\n",
  );
}

function controlLine(item: PageElement): string {
  const href = item.href ? ` -> ${item.href}` : "";
  const state = (item.state ?? []).map((value) => ` [${value}]`).join("");
  return `${item.ref} ${item.role} ${item.name}${href}${state}`.trim();
}
