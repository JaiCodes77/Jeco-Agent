import type { SiteGrant } from "../types.ts";

export function normalizeHost(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  try {
    const withProto = raw.includes("://") ? raw : `https://${raw}`;
    const url = new URL(withProto);
    if (url.username || url.password) return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    let host = url.hostname;
    if (!host || host === "localhost" || !host.includes(".")) return null;
    if (host.startsWith("www.")) host = host.slice(4);
    return host;
  } catch {
    return null;
  }
}

export function grantForUrl(url: string, sites: SiteGrant[]): SiteGrant | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  return sites.find((site) => host === site.host || host.endsWith(`.${site.host}`)) ?? null;
}
