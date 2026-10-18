import type { ElementKind, Risk } from "../types.ts";

const PHRASES: [string, Risk][] = [
  ["delete account", "blocked"],
  ["deactivate", "blocked"],
  ["close account", "blocked"],
  ["change password", "blocked"],
  ["reset password", "blocked"],
  ["buy now", "blocked"],
  ["place order", "blocked"],
  ["complete purchase", "blocked"],
  ["confirm purchase", "blocked"],
  ["send money", "blocked"],
  ["add card", "blocked"],
  ["start free trial", "blocked"],
  ["start trial", "blocked"],
  ["upgrade now", "blocked"],
  ["post now", "publish"],
  ["send now", "publish"],
  ["reply all", "publish"],
  ["sign out", "risky"],
  ["log out", "risky"],
  ["mark as spam", "risky"],
];

const FIRST_WORDS = new Map<string, Risk>([
  ...words("blocked", "pause buy pay checkout purchase donate transfer"),
  ...words("publish", "post tweet reply repost retweet quote send submit publish comment schedule"),
  ...words("play", "play"),
  ...words(
    "risky",
    "delete remove discard archive unsubscribe subscribe unfollow follow connect block unblock report mute leave withdraw accept decline ignore like unlike react celebrate support love insightful funny share",
  ),
]);

const TEXT_KINDS = new Set<ElementKind>(["text", "password", "payment"]);

export function normalizeLabel(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\d+(?:[.,]\d+)*\s*[km]?\b/g, " ")
    .replace(/[^\p{L}\p{N}'\s]+/gu, " ")
    .replace(/(^|\s)'+|'+(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyControl(name: string, kind: ElementKind): Risk {
  if (TEXT_KINDS.has(kind)) return "safe";
  const label = normalizeLabel(name);
  if (!label) return "safe";
  for (const [phrase, risk] of PHRASES) {
    if (label === phrase || label.startsWith(`${phrase} `)) return risk;
  }
  return FIRST_WORDS.get(label.split(" ")[0]) ?? "safe";
}

function words(risk: Risk, list: string): [string, Risk][] {
  return list.split(" ").map((word) => [word, risk]);
}
