import { dayBounds, digest, type DaySettings, type Json } from "@lifestreamprotocol/core";
import type { AnswerOf, Body, PageAsk, PageHandler, Phrase, Row, SettingsEnd, SettingsRow } from "./pages.js";
import type { StreamsRead } from "./page-streams.js";
import { refuse } from "./refusal.js";
import { deviceSets } from "./settings.js";
import type { DeviceRow, HomeSettings, StreamsReport } from "./streams-report.js";
import { spaceWords } from "./page-storage.js";
import { number } from "./stream-words.js";

export const SETTINGS_ANSWERS = ["settingsPage", "storage", "modelDefaults", "modelProviders", "own"] as const;
export type SettingsAnswer = (typeof SETTINGS_ANSWERS)[number];
export type SettingsKind = "phone" | "mac";

export interface SettingsEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly host: boolean;
  readonly answer: SettingsAnswer;
}

export interface SettingsGroup {
  readonly label: string;
  readonly entries: readonly SettingsEntry[];
}

const entry = (id: string, label: string, icon: string, answer: SettingsAnswer = "own", host = false): SettingsEntry => ({ id, label, icon, host, answer });

export const SETTINGS_INDEX: Readonly<Record<SettingsKind, readonly SettingsGroup[]>> = {
  phone: [
    { label: "Devices", entries: [entry("lifestream", "Lifestream", "home"), entry("this-phone", "This iPhone", "phone-screen")] },
    { label: "Lifestream", entries: [entry("storage", "Storage", "drive", "storage"), entry("time", "Day and time", "time", "settingsPage")] },
    { label: "App", entries: [entry("appearance", "Appearance", "settings"), entry("advanced", "Advanced", "filter", "settingsPage")] },
    { label: "About", entries: [entry("version", "Version", "info"), entry("privacy-policy", "Privacy policy", "private")] },
  ],
  mac: [
    { label: "Lifestream", entries: [
      entry("home", "General", "home"),
      entry("storage", "Storage", "drive", "storage"),
      entry("time", "Day and time", "time", "settingsPage"),
      entry("recovery", "Recovery key", "private", "own", true),
    ] },
    { label: "Devices", entries: [entry("mac", "This Mac", "work-mac"), entry("iphone", "iPhone", "phone-screen"), entry("chrome", "Chrome extension", "web")] },
    { label: "Models", entries: [
      entry("defaults", "Default models", "ai", "modelDefaults"),
      entry("providers", "Providers", "ai-apps", "modelProviders"),
      entry("privacy", "Privacy", "hidden"),
      entry("meaning", "Search by meaning", "search"),
    ] },
    { label: "App", entries: [
      entry("appearance", "Appearance", "settings"),
      entry("updates", "Updates", "update", "own", true),
      entry("advanced", "Advanced", "filter", "settingsPage"),
    ] },
  ],
};

export const kindOf = (ask: Pick<PageAsk, "device">): SettingsKind => (ask.device === "phone" ? "phone" : "mac");

export const entryOf = (kind: SettingsKind, id: string): SettingsEntry | undefined =>
  SETTINGS_INDEX[kind].flatMap((group) => group.entries).find((each) => each.id === id);

export interface Running {
  readonly position: string;
  readonly settings: HomeSettings;
  readonly max_bundle_bytes: number;
}

export interface SettingsReads {
  report(ask: PageAsk): StreamsRead;
  you(machine: string): Row | null;
  running(): Running;
}

type Live = Body<AnswerOf<"settings">>;
type Page = Body<AnswerOf<"settingsPage">>;
type Value = Live["values"][number];
type Device = Live["devices"][number];

export const CAPS: readonly number[] = [1, 2, 4, 8, 16, 32];
const MODEL_CAP = "model.cap";
const SOME: Readonly<Record<"mac" | "phone", string>> = { mac: "Macs", phone: "iPhones" };

const words = (text: string): Phrase => [{ kind: "words", words: text }];
const dayOf = (settings: HomeSettings): DaySettings => ({ zone: settings.zone, day_start_hour: settings.day_start_hour });
const startOf = (today: string, settings: HomeSettings): number => dayBounds(today, dayOf(settings)).start_ms;
const startsAt = (today: string, settings: HomeSettings): Phrase => [{ kind: "words", words: "Starts " }, { kind: "time", time: { kind: "clock", at_ms: startOf(today, settings) } }];

export function settingsHandler(reads: SettingsReads): PageHandler<AnswerOf<"settings">> {
  return {
    params: [],
    open(ask, use) {
      const { position, report } = reads.report(ask);
      const body = settingsAnswer(report, reads.you(ask.machine), ask);
      return use({ position, inputs: [digest(body as unknown as Json)], counting: false, build: () => body });
    },
  };
}

export function settingsAnswer(report: StreamsReport, you: Row | null, ask: Pick<PageAsk, "device" | "unit" | "today">): Live {
  const kind = kindOf(ask);
  const others = kind === "phone" ? report.devices.filter((each) => each.unit !== ask.unit) : [];
  const removed = others.filter((each) => each.retired).length;
  return {
    you,
    values: kind === "phone" ? phoneValues(report, ask.today) : macValues(report.devices),
    devices: kind === "phone" ? [...others.filter((each) => !each.retired).map(deviceOf), extensionOf(report), ...others.filter((each) => each.retired).map(deviceOf)] : [],
    removed: `${number(removed)} removed`,
  };
}

function phoneValues(report: StreamsReport, today: string): Value[] {
  return [
    { id: "storage", label: null, value: words(`${spaceWords(report.disk.free_bytes)} left`), signal: null },
    { id: "time", label: null, value: startsAt(today, report.home.settings), signal: null },
  ];
}

function macValues(devices: readonly DeviceRow[]): Value[] {
  const held = (kind: "mac" | "phone") => devices.filter((each) => each.kind === kind && !each.retired);
  const labelled = (kind: "mac" | "phone") => (held(kind).length > 1 ? SOME[kind] : null);
  const needs = held("phone").some((phone) => phone.health.state === "needs-you");
  const values: Value[] = [
    { id: "mac", label: labelled("mac"), value: null, signal: null },
    { id: "iphone", label: labelled("phone"), value: null, signal: needs ? "needs-you" : null },
  ];
  return values.filter((each) => each.label !== null || each.signal !== null);
}

const deviceOf = (device: DeviceRow): Device => ({
  id: device.unit, name: device.name, icon: device.kind === "mac" ? "work-mac" : "phone-screen", line: device.health.words, signal: device.health.state, removed: device.retired,
});

const extensionOf = ({ extension }: StreamsReport): Device => ({
  id: "extension", name: extension.name, icon: "web", line: extension.health.words, signal: extension.health.state, removed: false,
});

export function settingsPageHandler(reads: SettingsReads): PageHandler<AnswerOf<"settingsPage">> {
  return {
    params: ["id"],
    open(ask, use) {
      const asked = ask.query.get("id") ?? refuse(422, "BAD_PARAMETER", "id names a page of Settings");
      const kind = kindOf(ask);
      if (entryOf(kind, asked)?.answer !== "settingsPage") refuse(404, "NOT_FOUND", `Settings on a ${kind === "phone" ? "phone" : "Mac"} has no page ${asked} of rows`);
      const running = reads.running();
      const body = pageOf(asked, running, ask);
      return use({ position: running.position, inputs: [digest(body as unknown as Json)], counting: false, build: () => body });
    },
  };
}

export function pageOf(id: string, running: Running, ask: Pick<PageAsk, "device" | "today" | "now_ms">): Page {
  const title = entryOf(kindOf(ask), id)!.label;
  switch (id) {
    case "time":
      return { id, title, line: null, parts: [{ label: null, line: null, rows: timeRows(running.settings, ask) }] };
    case "advanced":
      return { id, title, line: null, parts: advancedParts(running, ask) };
    default:
      return refuse(404, "NOT_FOUND", `Settings has no page ${id} of rows`);
  }
}

const row = (id: string, label: string, line: string | null, end: SettingsEnd | null): SettingsRow => ({ id, label, line, end });
const shown = (value: Phrase): SettingsEnd => ({ kind: "value", value, signal: null });

function timeRows(settings: HomeSettings, ask: Pick<PageAsk, "today" | "now_ms">): SettingsRow[] {
  return [
    row("zone", "Time zone", "Days, times and the Timeline follow this zone.", shown(words([settings.zone, offsetOf(settings.zone, ask.now_ms)].filter((each) => each !== "").join(" · ")))),
    row("day-start", "A day starts at", "Anything before this counts as the night before, so a late night stays one day.",
      shown([{ kind: "time", time: { kind: "clock", at_ms: startOf(ask.today, settings) } }])),
  ];
}

function offsetOf(zone: string, now_ms: number): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" }).formatToParts(now_ms).find((each) => each.type === "timeZoneName")?.value ?? "";
  } catch (error) {
    if (error instanceof RangeError) return "";
    throw error;
  }
}

export const writes = (ask: Pick<PageAsk, "device">, key: string): boolean => ask.device === "mac" || (ask.device === "phone" && deviceSets(key));

function capEnd(settings: HomeSettings, ask: Pick<PageAsk, "device">): SettingsEnd {
  const cap = settings.model_cap;
  if (!writes(ask, MODEL_CAP)) return shown(words(number(cap)));
  const offered = [...new Set([...CAPS, cap, settings.model_cap_default])].sort((left, right) => left - right);
  return {
    kind: "choice",
    key: MODEL_CAP,
    choices: offered.map((value) => ({ words: number(value), value, chosen: value === cap, default: value === settings.model_cap_default })),
  };
}

function advancedParts({ settings, max_bundle_bytes }: Running, ask: Pick<PageAsk, "device">): Page["parts"] {
  const helpers = settings.helpers === "auto" ? `Automatic · ${number(settings.helpers_resolved)}` : number(settings.helpers_resolved);
  return [
    { label: null, line: null, rows: [
      row("model-cap", "Model calls at once", "The most model calls Lifestream makes at the same time.", capEnd(settings, ask)),
      row("helpers", "Background work", "How many jobs Lifestream runs side by side, each on a thread of its own.", shown(words(helpers))),
      row("max-bundle", "Largest upload", "A device’s single upload above this is refused.", shown(words(spaceWords(max_bundle_bytes)))),
    ] },
    { label: "Network", line: null, rows: [
      row("port", "Port", "Where apps and agents on this Mac and on Tailscale reach Lifestream.", shown(words(String(settings.port)))),
      row("lan-port", "Local network port", "Where your iPhone reaches Lifestream on the same Wi-Fi.", shown(words(String(settings.lan_port)))),
    ] },
  ];
}
