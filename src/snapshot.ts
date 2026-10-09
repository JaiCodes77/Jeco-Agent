import type { PageElement } from "./types.ts";
import { TEXT_CAP } from "./types.ts";

export function formatSnapshot(input: {
  url: string;
  title: string;
  text: string;
  elements: PageElement[];
}): string {
  const text = input.text.replace(/\s+\n/g, "\n").trim().slice(0, TEXT_CAP);
  const controls = input.elements
    .map((item) => `${item.ref} ${item.role} ${item.name}${item.href ? ` -> ${item.href}` : ""}`.trim())
    .join("\n");
  return [`URL: ${input.url}`, `Title: ${input.title}`, "Text:", text || "(empty)", "Controls:", controls || "(none)"].join(
    "\n",
  );
}
