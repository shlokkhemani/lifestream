import { baseOf, DETAIL_TYPES, hides, LINKS, type DetailType, type Json, type JsonObject, type Level, type Links } from "@lifestreamprotocol/core";

export type NamedLevel = "all" | "names" | "none";

export interface PrivacySettings {
  level: "all" | "none";
  chat: NamedLevel;
  links: Links;
  always: readonly string[];
  never: readonly string[];
}

export interface PrivacySetting {
  key: string;
  where: "home" | "connector";
  default?: Json;
  rule(value: Json): string | null;
}

export class PrivacySettingError extends Error {
  override name = "PrivacySettingError";
}

const NAMED: readonly NamedLevel[] = ["all", "names", "none"];
const FOLLOWS = "default";

const oneOf = (values: readonly string[], rule: string) => (value: Json) => (typeof value === "string" && values.includes(value) ? null : rule);
const words = (value: Json): string | null => {
  const rule = "is a list of distinct words, none empty";
  if (!Array.isArray(value) || !value.every((word) => typeof word === "string" && word.trim() !== "" && word === word.trim() && !/\n/u.test(word))) return rule;
  return new Set(value.map((word) => (word as string).toLowerCase())).size === value.length ? null : rule;
};

export const PRIVACY_SETTINGS: readonly PrivacySetting[] = [
  { key: "privacy.level", where: "home", default: "all", rule: oneOf(["all", "none"], "is all or none") },
  { key: "privacy.chat", where: "home", default: FOLLOWS, rule: oneOf([...NAMED, FOLLOWS], "is all, names, none or default (privacy.level)") },
  { key: "privacy.links", where: "home", default: "tokens", rule: oneOf(LINKS, `is ${LINKS.slice(0, -1).join(", ")} or ${LINKS.at(-1)}`) },
  { key: "privacy.always", where: "home", default: [], rule: words },
  { key: "privacy.never", where: "home", default: [], rule: words },
  { key: "privacy.*", where: "connector", default: FOLLOWS, rule: oneOf([...NAMED, FOLLOWS], "is all, names, none or default (privacy.level)") },
];

export function privacySetting(where: PrivacySetting["where"], key: string): PrivacySetting | undefined {
  return PRIVACY_SETTINGS.find((row) => row.where === where && (row.key === key || (row.key.endsWith(".*") && key.startsWith(row.key.slice(0, -1)) && /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(key.slice(row.key.length - 1)))));
}

export function readPrivacySettings(held: Readonly<Record<string, Json | undefined>>): PrivacySettings {
  const value = (key: string): Json => {
    const row = privacySetting("home", key)!;
    const written = held[key];
    if (written === undefined) return row.default ?? null;
    checked(row, key, written);
    return written;
  };
  const level = value("privacy.level") as PrivacySettings["level"];
  const chat = value("privacy.chat") as NamedLevel | typeof FOLLOWS;
  return {
    level,
    chat: chat === FOLLOWS ? level : chat,
    links: value("privacy.links") as Links,
    always: value("privacy.always") as string[],
    never: value("privacy.never") as string[],
  };
}

export const PRIVACY_MEMBER = "privacy.";

export function workLevel(settings: PrivacySettings, work: string, member: Json | undefined): NamedLevel {
  const key = `${PRIVACY_MEMBER}${work}`;
  if (member === undefined) return settings.level;
  checked(privacySetting("connector", key) ?? fail(`${key} is no work's level`), key, member);
  return member === FOLLOWS ? settings.level : (member as NamedLevel);
}

export function levelOf(settings: { privacy: PrivacySettings; connectors: Readonly<Record<string, JsonObject>> }, work_id: string | null): NamedLevel {
  if (work_id === null) return settings.privacy.level;
  const at = work_id.indexOf("/");
  const work = work_id.slice(at + 1);
  const key = `${PRIVACY_MEMBER}${work}`;
  const member = settings.connectors[work_id.slice(0, at)]?.[key];
  return workLevel(settings.privacy, work, member === undefined || privacySetting("connector", key)?.rule(member) !== null ? undefined : member);
}

export type Shown =
  | { detail: string; until_ms: number | null }
  | { type: DetailType; until_ms: number }
  | { level: Level; until_ms: number };

export function shownLevel(hide: Level, shown: readonly Shown[], now_ms: number): Level {
  const live = shown.filter((entry) => entry.until_ms === null || entry.until_ms > now_ms);
  const types = live.flatMap((entry) => ("type" in entry ? [entry.type] : []));
  const levels = live.flatMap((entry) => ("level" in entry ? [entry.level] : []));
  if (types.length === 0 && levels.length === 0) return hide;
  const hidden = DETAIL_TYPES.filter((type) => hides(hide, type) && levels.every((level) => hides(level, type)) && !types.some((each) => each === type || each === baseOf(type)));
  const kept = hidden.filter((type) => type.includes(".") || DETAIL_TYPES.every((sub) => !sub.startsWith(`${type}.`) || hidden.includes(sub)));
  return kept.length === 0 ? "none" : kept;
}

function checked(row: PrivacySetting, key: string, value: Json): void {
  const broken = row.rule(value);
  if (broken !== null) fail(`${key} ${broken}`);
}

function fail(message: string): never {
  throw new PrivacySettingError(message);
}
