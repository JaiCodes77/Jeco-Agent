import type { ElementKind } from "../types.ts";

export type ControlRecord = {
  tag: string;
  type?: string;
  role?: string | null;
  autocomplete?: string;
  name?: string;
  id?: string;
  placeholder?: string;
  ariaLabel?: string;
  contentEditable?: boolean;
};

const PASSWORD = /\bpassword\b|\botp\b|one[- ]?time|verification code|security code|2fa|passcode/;
const PASSWORD_AUTO = /^(current-password|new-password|one-time-code)$/;
const PAYMENT = /cc-|card[-_ ]?number|\bcardnumber\b|\bcvv\b|\bcvc\b|\biban\b|routing number|account number/;

export function classifyKind(record: ControlRecord): ElementKind {
  const tag = record.tag.toLowerCase();
  const type = (record.type ?? "").toLowerCase();
  const role = (record.role ?? "").toLowerCase();
  const hint = hintOf(record);
  const field = tag === "input" || tag === "textarea" || record.contentEditable === true;

  if (field && (type === "password" || PASSWORD_AUTO.test((record.autocomplete ?? "").toLowerCase()) || PASSWORD.test(hint))) {
    return "password";
  }
  if (field && PAYMENT.test(hint)) return "payment";
  if (type === "search" || role === "searchbox" || (tag === "input" && hint.includes("search"))) return "search";
  if (tag === "select" || (role === "combobox" && record.contentEditable !== true)) return "select";
  if (tag === "textarea" || record.contentEditable === true) return "text";
  if (tag === "a" || role === "link") return "link";
  if (tag === "button" || role === "button" || role === "switch" || role === "checkbox" || role === "tab" || role === "menuitem") {
    return "button";
  }
  if (tag === "input" && (type === "submit" || type === "button" || type === "reset" || type === "image")) return "button";
  if (tag === "input") return "text";
  return "other";
}

export function isMultiline(record: ControlRecord): boolean {
  return record.tag.toLowerCase() === "textarea" || record.contentEditable === true;
}

function hintOf(record: ControlRecord): string {
  return `${record.autocomplete ?? ""} ${record.name ?? ""} ${record.id ?? ""} ${record.placeholder ?? ""} ${record.ariaLabel ?? ""}`.toLowerCase();
}
