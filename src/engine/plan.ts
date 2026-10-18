import type { ChatClient, Plan } from "../types.ts";
import { normalizeHost } from "../safety/hosts.ts";
import { planPrompt } from "./prompt.ts";
import { jsonCandidates } from "./toolcalls.ts";

export async function planFor(input: {
  task: string;
  allowed: string[];
  currentHost: string | null;
  chat: ChatClient;
  signal: AbortSignal;
}): Promise<Plan> {
  try {
    const turn = await input.chat({
      messages: [
        { role: "system", content: planPrompt(input.allowed) },
        { role: "user", content: input.task },
      ],
      tools: false,
      purpose: "plan",
      signal: input.signal,
    });
    return parsePlan(turn.content, input.task, input.allowed, input.currentHost);
  } catch (error) {
    if (isAbort(error)) throw error;
    return backup(input.task);
  }
}

export function parsePlan(content: string | null, task: string, allowed: string[], currentHost: string | null): Plan {
  for (const value of jsonCandidates(content ?? "")) {
    const parsed = planFromJson(value, allowed);
    if (parsed) return parsed;
  }
  return planFromLines(content, task, allowed, currentHost);
}

export function sitesLine(sites: string[]): string {
  return `Sites: ${sites.length > 0 ? sites.join(", ") : "any you allowed"}`;
}

export function taskWithPlan(task: string, plan: Plan): string {
  const steps = plan.lines.map((line, index) => `${index + 1}. ${line}`).join("\n");
  return `${task}\n\nApproved plan:\n${steps}\n${sitesLine(plan.sites)}`;
}

export function backupPlan(task: string): Plan["lines"] {
  const brief = task.trim().replace(/\s+/g, " ").slice(0, 72);
  const subject = brief || "the task";
  return [
    clip(`Read the request: ${subject}`),
    "Carry out that request in the browser",
    "Finish with a short answer",
  ];
}

function planFromJson(value: unknown, allowed: string[]): Plan | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.steps) || !record.steps.every((step) => typeof step === "string")) return null;
  if (!Array.isArray(record.sites) || !record.sites.every((site) => typeof site === "string")) return null;
  const lines = threeLines(
    record.steps.map((step) => clip(stripBullet(step))),
    "the task",
  );
  if (record.steps.length === 0) return null;
  return finishPlan(lines, record.sites, "model", allowed);
}

function planFromLines(content: string | null, task: string, allowed: string[], currentHost: string | null): Plan {
  const spoken = (content ?? "")
    .split(/\r?\n/)
    .map((line) => clip(stripBullet(line.trim())))
    .filter((line) => line.length > 0);
  const named = [...hostsIn(`${content ?? ""}\n${task}`)];
  if (currentHost && allowed.includes(currentHost) && !named.includes(currentHost)) named.push(currentHost);
  return finishPlan(threeLines(spoken, task), named, "fallback", allowed);
}

function finishPlan(lines: Plan["lines"], rawSites: string[], source: Plan["source"], allowed: string[]): Plan {
  const sites: string[] = [];
  const missing: string[] = [];
  for (const raw of rawSites) {
    const host = normalizeHost(raw);
    if (!host) continue;
    const grant = allowed.find((site) => host === site || host.endsWith(`.${site}`));
    const bucket = grant ? sites : missing;
    const stored = grant ?? host;
    if (!bucket.includes(stored)) bucket.push(stored);
  }
  return { lines, sites, missing, scope: sites.length > 0 ? sites : null, source };
}

function threeLines(lines: string[], task: string): Plan["lines"] {
  const backup = backupPlan(task);
  const next = lines.slice(0, 3);
  while (next.length < 3) next.push(backup[next.length]);
  return [next[0], next[1], next[2]];
}

function backup(task: string): Plan {
  return { lines: backupPlan(task), sites: [], missing: [], scope: null, source: "fallback" };
}

function hostsIn(text: string): string[] {
  const found: string[] = [];
  const matches = text.match(/https?:\/\/[^\s]+|[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
  for (const match of matches) {
    const host = normalizeHost(match.replace(/[),.;]+$/g, ""));
    if (host && !found.includes(host)) found.push(host);
  }
  return found;
}

function stripBullet(line: string): string {
  return line.replace(/^(?:\d+[.)]|[-*])\s*/, "").trim();
}

function clip(line: string): string {
  const clean = line.replace(/\s+/g, " ").trim();
  return clean.length > 90 ? `${clean.slice(0, 89)}…` : clean;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
