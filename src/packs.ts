const FILLER = new Set([
  "open",
  "youtube",
  "play",
  "watch",
  "a",
  "an",
  "the",
  "video",
  "videos",
  "and",
  "in",
  "it",
  "me",
  "any",
]);

const LINKEDIN_URL = "https://www.linkedin.com/";
const X_URL = "https://x.com/";

export function packHint(task: string): string {
  return [youtubeHint(task), socialHint(task)].filter(Boolean).join("\n\n");
}

function youtubeHint(task: string): string {
  if (!isYoutubeTask(task)) return "";
  const query = encodeURIComponent(searchWords(task).join(" "));
  return [
    `Open https://www.youtube.com/results?search_query=${query}.`,
    "Then read_page, click the video title link, and if a control's name starts with Play, click it once. Never click Pause.",
  ].join("\n");
}

function isYoutubeTask(task: string): boolean {
  const text = task.toLowerCase();
  if (/\byoutube\b/.test(text)) return true;
  return /\b(?:play(?:ing|ed|s)?|watch(?:ing|ed|es)?)\b/.test(text) && /\bvideos?\b/.test(text);
}

function searchWords(task: string): string[] {
  return task
    .toLowerCase()
    .replace(/\byoutube(?:\.com)?\b/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0 && !FILLER.has(word));
}

function socialHint(task: string): string {
  const url = socialUrl(task);
  if (!url) return "";
  return [
    `Open ${url}.`,
    "Find the composer, type the draft, then call ask_to_post with the exact text. Never click Post, Tweet, Reply, Send, Submit, or Publish yourself.",
  ].join("\n");
}

function socialUrl(task: string): string | null {
  const text = task.toLowerCase();
  const named = earliestNamedSite(text);
  if (named) return named;
  if (/\btweet/.test(text) || /\bpost\s+(?:to|on)\s+x\b/.test(text)) return X_URL;
  return null;
}

function earliestNamedSite(text: string): string | null {
  const hits = [
    { url: LINKEDIN_URL, at: text.search(/\blinkedin\b/) },
    { url: X_URL, at: text.search(/\btwitter\b/) },
    { url: X_URL, at: text.search(/(?<![a-z0-9])x\.com\b/) },
  ].filter((hit) => hit.at >= 0);
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.at - b.at);
  return hits[0].url;
}
