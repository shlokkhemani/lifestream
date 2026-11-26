import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formOf, ROUTE, routeId, type Connector, type Field } from "@lifestreamprotocol/connect";
import { canonical, duration, instant, isObject, KeyError, makeUnder, plainFolder, TimeError, writeDurably, type DaySettings, type FileKind, type HomeFolder, type Json, type JsonObject, type KeptFile } from "@lifestreamprotocol/core";
import { SCREEN_CUTOVER_MS } from "@lifestreamprotocol/families";
import { OWN_BLOCKS, readModelSettings, unfit, USE_IDS, workNeed, type ModelSettings, type UseId } from "@lifestreamprotocol/model";
import { PRIVACY_MEMBER, PRIVACY_SETTINGS, privacySetting, readPrivacySettings, type PrivacySettings } from "@lifestreamprotocol/privacy";
import { catalogOf } from "./catalog.js";
import { RANGE_MEMBER, ROUTE_ID, WORK_MEMBER, type ModelRoute } from "./models.js";
import { refuse } from "./refusal.js";
import type { HomeSettings } from "./streams-report.js";
import { CLI } from "./cli-name.js";
import { startRule, startSetRule } from "./start.js";

export interface Settings {
  day: DaySettings;
  history: { start: string };
  helpers: number | "auto";
  clocks: boolean;
  connectors: Record<string, JsonObject>;
  clients: Record<string, string>;
  screen_cutover_ms: number;
  families: Record<string, JsonObject>;
  unit: string;
  model: ModelSettings;
  defaults: UseDefaults;
  thinking: { chat: string | null };
  door: DoorAddress;
  sources: { off: string[] };
  sites: { chosen: string[] };
  runners: Record<string, { files?: string[]; save_battery?: boolean }>;
  privacy: PrivacySettings;
  search: SearchSettings;
  devices: Record<string, { mobile_data: MobileData }>;
}

export const MOBILE_DATA = ["now", "everything", "small"] as const;
export type MobileData = (typeof MOBILE_DATA)[number];
const MOBILE_DATA_DEFAULT: MobileData = "now";

export function mobileDataOf(settings: Pick<Settings, "devices">, unit: string): MobileData {
  return settings.devices[unit]?.mobile_data ?? MOBILE_DATA_DEFAULT;
}

export type UseDefaults = Readonly<Record<UseId, string | null>>;

export function chosenFor<Use extends UseId>(settings: { readonly defaults: Readonly<Record<Use, string | null>> }, use: Use): string | null {
  return settings.defaults[use];
}

export interface SearchSettings {
  power: "plugged-idle";
}

const PRIVACY_ROWS = PRIVACY_SETTINGS.filter((row) => row.where === "home");

export function chosenWith(sites: readonly string[], listed: readonly string[], on: readonly string[], off: readonly string[]): string[] {
  return [...new Set([...listed, ...on])].filter((id) => sites.includes(id) && !off.includes(id)).sort();
}

export interface DoorAddress {
  port: number;
  lan_port?: number;
  max_bundle_bytes: number;
}

export interface Shown {
  key: string;
  value: Json | null;
  from: "release" | "person" | "unset";
  written?: Json;
}

export interface SettingsNotice {
  key: string;
  what: string;
}

export interface Effective {
  settings: Settings;
  shown: Shown[];
  notices: SettingsNotice[];
}

export class SettingsError extends Error {
  override name = "SettingsError";
}

export class SettingRefused extends SettingsError {
  override name = "SettingRefused";
}

interface Setting {
  key: string;
  default?: Json;
  rule(value: Json): string | null;
  atSet?(value: Json): string | null;
  limit?: { min?: number; max?: number };
  beforeKey?: true;
  device?: true;
}

const GIB = 1024 ** 3;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const FILE_ID = /^[a-z0-9][a-z0-9.-]*$/u;
export const UNIT = /^[a-z0-9][a-z0-9-]*$/u;
const THINKING = /^[a-z][a-z0-9-]*$/u;
const SECRET = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SOURCE = /^[^:/\\]+:[^:/\\]+:[^:/\\]+$/u;

const is = (test: (value: Json) => boolean, rule: string) => (value: Json) => (test(value) ? null : rule);
const whole = (value: Json): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const anObject = is((value) => isObject(value), "is an object");

const SETTINGS: readonly Setting[] = [
  { key: "day.zone", beforeKey: true, rule: is((value) => typeof value === "string" && isZone(value), "is an IANA time zone") },
  { key: "day.day_start_hour", beforeKey: true, default: 4, rule: is((value) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 23, "is a whole hour, 0 to 23") },
  { key: "history.start", device: true, default: "all", rule: startRule, atSet: (value) => startSetRule(value, Date.now()) },
  { key: "helpers", default: "auto", rule: is((value) => value === "auto" || Number.isInteger(value), 'is "auto" or a whole number'), limit: { min: 2, max: 64 } },
  { key: "clocks", default: true, rule: is((value) => typeof value === "boolean", "is true or false") },
  { key: "connectors.*", rule: anObject },
  { key: "clients.*", rule: is((value) => typeof value === "string" && SECRET.test(value), "names a secret") },
  { key: "screen_cutover", default: new Date(SCREEN_CUTOVER_MS).toISOString(), rule: (value) => {
    try {
      if (typeof value !== "string") throw new TimeError("spelling", "not a string");
      instant(value, "rfc3339");
      return null;
    } catch (error) {
      if (!(error instanceof TimeError)) throw error;
      return `is an RFC 3339 instant: ${error.message}`;
    }
  } },
  { key: "families.*", rule: anObject },
  { key: "unit", beforeKey: true, rule: is((value) => typeof value === "string" && UNIT.test(value), "is a unit id") },
  ...USE_IDS.map((use): Setting => ({ key: `model.defaults.${use}`, rule: is((value) => value === null || (typeof value === "string" && ROUTE_ID.test(value)), "is a model id (<connection>:<model>) or null") })),
  { key: "model.thinking.chat", rule: is((value) => value === null || (typeof value === "string" && THINKING.test(value)), "is a thinking level or null") },
  { key: "devices.*.mobile_data", device: true, default: MOBILE_DATA_DEFAULT, rule: is((value) => (MOBILE_DATA as readonly Json[]).includes(value), `is ${MOBILE_DATA.join(", ")}`) },
  { key: "model.cap", device: true, default: 8, rule: is((value) => Number.isInteger(value), "is a whole number of calls"), limit: { min: 1, max: 256 } },
  { key: "model.transports.*.concurrency", rule: is((value) => Number.isSafeInteger(value) && (value as number) > 0, "is a positive whole number of calls") },
  ...OWN_BLOCKS.map((name): Setting => ({ key: `model.transports.${name}`, rule: anObject })),
  { key: "model.runners.*.files", rule: is((value) => Array.isArray(value) && value.every((id) => typeof id === "string" && FILE_ID.test(id)) && new Set(value).size === value.length,
    "is a list of distinct model file ids") },
  { key: "model.runners.*.save_battery", rule: is((value) => typeof value === "boolean", "is true or false") },
  { key: "door.port", beforeKey: true, default: 4680, rule: is((value) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 65_535, "is a port, 0 to 65535") },
  { key: "door.lan_port", beforeKey: true, default: 4682, rule: is((value) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 65_535, "is a port, 0 to 65535") },
  { key: "door.max_bundle_bytes", beforeKey: true, default: 64 * GIB, rule: is(whole, "is a whole number of bytes") },
  { key: "sources.off", default: [], rule: is((value) => Array.isArray(value) && value.every((id) => typeof id === "string" && (SOURCE.test(id) || UNIT.test(id))) && new Set(value).size === value.length,
    "is a list of distinct ids, each a source's <product>:<account>:<copy>, a connector's id or a device's unit") },
  { key: "sites.chosen", default: [], rule: is((value) => Array.isArray(value) && value.every((id) => typeof id === "string" && NAME.test(id)) && new Set(value).size === value.length,
    "is a list of distinct site ids") },
  ...PRIVACY_ROWS.map((row): Setting => ({ key: row.key, ...(row.default === undefined ? {} : { default: row.default }), rule: row.rule })),
  { key: "search.meaning.power", default: "plugged-idle", rule: is((value) => value === "plugged-idle", 'is "plugged-idle"') },
];

export type SettingsFolder = HomeFolder | string;

export function lastGood(folder: SettingsFolder, first: Settings = effective(folder).settings): () => Settings {
  let good = first;
  return () => {
    try {
      const now = effective(folder).settings;
      good = { ...good, sources: now.sources, sites: now.sites, connectors: now.connectors, clients: now.clients, defaults: now.defaults, thinking: now.thinking, model: now.model, runners: now.runners, privacy: now.privacy, search: now.search, history: now.history, devices: now.devices };
    } catch (error) {
      if (!(error instanceof SettingsError)) throw error;
    }
    return good;
  };
}

export function runningSettings(settings: Pick<Settings, "day" | "door" | "helpers" | "model">, auto: number): HomeSettings {
  return {
    zone: settings.day.zone, day_start_hour: settings.day.day_start_hour,
    helpers: settings.helpers, helpers_resolved: settings.helpers === "auto" ? auto : settings.helpers,
    model_cap: settings.model.cap, model_cap_default: runsAt(null, "model.cap") as number,
    port: settings.door.port, lan_port: settings.door.lan_port!,
  };
}

export function settingsPath(folder: string): string {
  return join(folder, "config", "settings.json");
}

export function isReadBeforeKey(key: string): boolean {
  return settingOf(key)?.beforeKey === true;
}

export function deviceSets(key: string): boolean {
  return settingOf(key)?.device === true;
}

export function unitOfSetting(key: string): string | null {
  return settingOf(key)?.key.startsWith("devices.*.") === true ? key.split(".")[1]! : null;
}

export function effective(folder: SettingsFolder): Effective {
  return effectiveOf(keptOf(folder, null).held, settingsPath(rootOf(folder)));
}

export function change(folder: SettingsFolder, key: string, value: Json): Shown {
  return planned(folder, { [key]: value }).write()[0]!;
}

export function planned(folder: SettingsFolder, members: JsonObject): { write(): Shown[] } {
  for (const [key, value] of Object.entries(members)) checked(key, value);
  const kept = keptOf(folder, Object.keys(members));
  const next = { ...kept.held, ...members };
  effectiveOf(next, kept.where);
  return { write: () => written(kept, next, Object.keys(members)) };
}

export function firstSettings(root: string, members: JsonObject): void {
  for (const [key, value] of Object.entries(members)) checked(key, value);
  const next = { ...plainMembers(root), ...members };
  effectiveOf(next, settingsPath(root));
  writePlain(root, next);
}

export function changeAll(folder: SettingsFolder, members: JsonObject): Shown[] {
  const keys = Object.keys(members);
  if (keys.length === 0) fail("a change", "names at least one setting");
  for (const [key, value] of Object.entries(members)) {
    if (value === null) settingOf(key) ?? fail(key, `is not a setting: ${CLI} settings lists every one`);
    else checked(key, value);
  }
  const kept = keptOf(folder, keys);
  const held = Object.entries(kept.held).filter(([key]) => !(Object.hasOwn(members, key) && members[key] === null));
  const next = { ...Object.fromEntries(held), ...Object.fromEntries(Object.entries(members).filter(([, value]) => value !== null)) };
  effectiveOf(next, kept.where);
  return written(kept, next, keys);
}

function checked(key: string, value: Json): void {
  const setting = settingOf(key) ?? refusedAt(key, `is not a setting: ${CLI} settings lists every one`);
  const broken = (setting.atSet ?? setting.rule)(value);
  if (broken !== null) refusedAt(key, broken);
  const limit = setting.limit;
  if (limit !== undefined && typeof value === "number" && ((limit.min !== undefined && value < limit.min) || (limit.max !== undefined && value > limit.max))) {
    refusedAt(key, `runs ${limit.min === undefined ? "" : `from ${limit.min} `}${limit.max === undefined ? "up" : `to ${limit.max}`}`);
  }
}

export function reset(folder: SettingsFolder, key: string): Shown {
  const kept = keptOf(folder, [key]);
  if (!Object.hasOwn(kept.held, key) && settingOf(key) === undefined) fail(key, "is not a setting, and settings.json holds no member by that name");
  const { [key]: _removed, ...rest } = kept.held;
  return written(kept, rest, [key])[0]!;
}

function written(kept: Kept, next: JsonObject, keys: readonly string[]): Shown[] {
  const resolved = effectiveOf(next, kept.where);
  kept.write(next);
  return keys.map((key) => resolved.shown.find((shown) => shown.key === key) ?? { key, value: null, from: "unset" });
}

export function replaced(folder: SettingsFolder, members: JsonObject): void {
  const kept = keptOf(folder, null);
  effectiveOf(members, kept.where);
  kept.write(members);
}

export function personal(folder: SettingsFolder): JsonObject {
  return keptOf(folder, null).held;
}

export function runsAt(folder: SettingsFolder | null, key: string): Json | null {
  if (folder === null) return valuesOf({}, "").values.get(key)?.value ?? null;
  const kept = keptOf(folder, [key]);
  return valuesOf(kept.held, kept.where).values.get(key)?.value ?? null;
}

const SEALED_SETTINGS: FileKind = { role: "settings" };

interface Kept {
  readonly where: string;
  readonly held: JsonObject;
  write(next: JsonObject): void;
}

function rootOf(folder: SettingsFolder): string {
  return typeof folder === "string" ? folder : folder.root;
}

function keptOf(folder: SettingsFolder, touched: readonly string[] | null): Kept {
  const root = rootOf(folder);
  const where = settingsPath(root);
  const whole = plainMembers(root);
  const [beforeKey, rest] = byKey(whole);
  const keep = (next: JsonObject): void => writePlain(root, { ...rest, ...byKey(next)[0] });
  if (touched !== null && touched.every(isReadBeforeKey)) return { where, held: beforeKey, write: keep };
  const opened = typeof folder === "string" ? plainFolder(folder) : folder;
  const sealed = opened === null ? null : sealedSettings(opened);
  if (sealed === undefined) return { where, held: whole, write: (next) => writePlain(root, next) };
  if (sealed === null) return locked(root);
  return {
    where,
    held: { ...sealedMembers(sealed), ...beforeKey },
    write: (next) => {
      writeSealed(sealed, byKey(next)[1]);
      keep(next);
    },
  };
}

export function sealStrays(folder: HomeFolder): string[] {
  const sealed = sealedSettings(folder);
  if (sealed === undefined) return [];
  const [beforeKey, strays] = byKey(plainMembers(folder.root));
  const moved = Object.keys(strays).sort();
  if (moved.length === 0) return moved;
  writeSealed(sealed, { ...sealedMembers(sealed), ...strays });
  writePlain(folder.root, beforeKey);
  return moved;
}

function sealedSettings(folder: HomeFolder): KeptFile | undefined {
  return folder.sealedFile(SEALED_SETTINGS, join(folder.root, "config", "settings-sealed.json"));
}

function byKey(members: JsonObject): [beforeKey: JsonObject, sealed: JsonObject] {
  const entries = Object.entries(members);
  return [Object.fromEntries(entries.filter(([key]) => isReadBeforeKey(key))), Object.fromEntries(entries.filter(([key]) => !isReadBeforeKey(key)))];
}

function writeSealed(sealed: KeptFile, members: JsonObject): void {
  sealed.write(Buffer.from(membersText(Object.entries(members))));
}

function locked(root: string): never {
  throw new KeyError("LOCKED", `${root} is an encrypted home: its settings past the door's address, the day and the unit are sealed, and only a program that holds its keys reads them`);
}

const BEFORE_KEY = SETTINGS.filter((setting) => setting.beforeKey === true).map((setting) => setting.key);

export function membersBeforeKey(root: string): JsonObject {
  return keptOf(root, BEFORE_KEY).held;
}

function plainMembers(root: string): JsonObject {
  const path = settingsPath(root);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new SettingsError(`${path}: ${(error as Error).message}`);
  }
  return membersOf(text, path);
}

function sealedMembers(file: KeptFile): JsonObject {
  const bytes = file.read();
  return bytes === undefined ? {} : membersOf(bytes.toString("utf8"), file.path);
}

function membersOf(text: string, path: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new SettingsError(`${path}: ${(error as Error).message}`);
  }
  if (!isObject(value)) throw new SettingsError(`${path} is an object of settings by key`);
  return value as JsonObject;
}

function writePlain(root: string, members: JsonObject): void {
  makeUnder(root, join(root, "config"));
  writeDurably(settingsPath(root), membersText(Object.entries(members)));
}

function membersText(members: readonly [string, Json][]): string {
  return `${JSON.stringify(Object.fromEntries([...members].sort(([left], [right]) => left.localeCompare(right))), null, 2)}\n`;
}

export function effectiveOf(held: JsonObject, where: string): Effective {
  const { values, notices } = valuesOf(held, where);
  const shown = [...values.values()].sort((left, right) => left.key.localeCompare(right.key));
  return { settings: assemble(values, where), shown, notices };
}

function valuesOf(held: JsonObject, where: string): { values: Map<string, Shown>; notices: SettingsNotice[] } {
  const values = new Map<string, Shown>();
  for (const setting of SETTINGS) {
    if (setting.default !== undefined && !setting.key.includes("*")) values.set(setting.key, { key: setting.key, value: setting.default, from: "release" });
  }
  const notices: SettingsNotice[] = [];
  for (const [key, value] of Object.entries(held)) {
    const setting = settingOf(key);
    if (setting === undefined) {
      notices.push({ key, what: `settings.json holds ${key}, which this release does not know: it is kept and ignored (${CLI} settings reset ${key} removes it)` });
      continue;
    }
    const broken = setting.rule(value);
    if (broken !== null) throw new SettingsError(`${where}: ${key} ${broken}`);
    const runs = limited(value, setting.limit);
    if (runs === value) values.set(key, { key, value, from: "person" });
    else {
      values.set(key, { key, value: runs, from: "person", written: value });
      notices.push({ key, what: `${key} is ${String(value)}, past this release's limit: it runs at ${String(runs)}, and stays written for a release whose limit allows it` });
    }
  }
  for (const setting of SETTINGS) {
    if (setting.default === undefined && !setting.key.includes("*") && !values.has(setting.key)) values.set(setting.key, { key: setting.key, value: null, from: "unset" });
  }
  return { values, notices };
}

function assemble(values: ReadonlyMap<string, Shown>, where: string): Settings {
  const get = (key: string): Json | undefined => values.get(key)?.value ?? undefined;
  const named = (prefix: string): [string, Json][] => [...values.values()].flatMap((shown): [string, Json][] => {
    if (shown.value === null || !shown.key.startsWith(`${prefix}.`)) return [];
    const name = shown.key.slice(prefix.length + 1);
    return NAME.test(name) ? [[name, shown.value]] : [];
  });
  const zone = get("day.zone");
  if (zone === undefined) throw new SettingsError(`${where}: day.zone is not set: it is the person's (${CLI} settings set day.zone <IANA zone>)`);
  const unit = get("unit");
  if (unit === undefined) throw new SettingsError(`${where}: unit is not set: it is the machine's, which ${CLI} adopt writes and every start writes first (${CLI} settings set unit <this Mac's unit>)`);
  const day: DaySettings = { zone: zone as string, day_start_hour: get("day.day_start_hour") as number };
  let model: ModelSettings;
  try {
    const transports: Record<string, JsonObject> = {};
    for (const name of OWN_BLOCKS) {
      const block = get(`model.transports.${name}`);
      if (block !== undefined) transports[name] = block as JsonObject;
    }
    for (const { key, value } of values.values()) {
      const narrowed = /^model\.transports\.([^.]+)\.concurrency$/u.exec(key)?.[1];
      if (narrowed !== undefined && value !== null) transports[narrowed] = { ...transports[narrowed], concurrency: value };
    }
    model = readModelSettings({ cap: get("model.cap")!, day: { ...day }, transports });
  } catch (error) {
    throw new SettingsError(`${where}: the model settings are refused: ${(error as Error).message}`);
  }
  return {
    day,
    history: { start: get("history.start") as string },
    helpers: get("helpers") as number | "auto",
    clocks: get("clocks") as boolean,
    connectors: Object.fromEntries(named("connectors")) as Record<string, JsonObject>,
    clients: Object.fromEntries(named("clients")) as Record<string, string>,
    screen_cutover_ms: instant(get("screen_cutover") as string, "rfc3339").start_ms,
    families: Object.fromEntries(named("families")) as Settings["families"],
    unit: unit as string,
    model,
    defaults: Object.fromEntries(USE_IDS.map((use) => [use, (get(`model.defaults.${use}`) ?? null) as string | null])) as Record<UseId, string | null>,
    thinking: { chat: (get("model.thinking.chat") ?? null) as string | null },
    door: {
      port: get("door.port") as number, lan_port: get("door.lan_port") as number,
      max_bundle_bytes: get("door.max_bundle_bytes") as number,
    },
    sources: { off: get("sources.off") as string[] },
    sites: { chosen: get("sites.chosen") as string[] },
    runners: [...values.values()].reduce<Settings["runners"]>((runners, shown) => {
      const [, unit, member] = /^model\.runners\.([^.]+)\.(files|save_battery)$/u.exec(shown.key) ?? [];
      if (unit !== undefined && member !== undefined && shown.value !== null) runners[unit] = { ...runners[unit], [member]: shown.value };
      return runners;
    }, {}),
    privacy: readPrivacySettings(Object.fromEntries(PRIVACY_ROWS.map((row) => [row.key, get(row.key)]))),
    search: { power: get("search.meaning.power") as SearchSettings["power"] },
    devices: [...values.values()].reduce<Settings["devices"]>((devices, shown) => {
      const [, unit] = /^devices\.([^.]+)\.mobile_data$/u.exec(shown.key) ?? [];
      if (unit !== undefined && shown.value !== null) devices[unit] = { mobile_data: shown.value as MobileData };
      return devices;
    }, {}),
  };
}

function settingOf(key: string): Setting | undefined {
  const parts = key.split(".");
  return SETTINGS.find((setting) => {
    const pattern = setting.key.split(".");
    return pattern.length === parts.length && pattern.every((part, at) => part === "*" ? NAME.test(parts[at]!) : part === parts[at]);
  });
}

function limited(value: Json, limit: Setting["limit"]): Json {
  if (limit === undefined || typeof value !== "number") return value;
  if (limit.min !== undefined && value < limit.min) return limit.min;
  if (limit.max !== undefined && value > limit.max) return limit.max;
  return value;
}

function fail(key: string, rule: string): never {
  throw new SettingsError(`${key} ${rule}`);
}

function refusedAt(key: string, rule: string): never {
  throw new SettingRefused(`${key} ${rule}`);
}

export function isZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}


export interface Member {
  member: string;
  kind: "refresh" | "start" | "pace" | "route" | Field["kind"];
  label?: string;
  value: Json | null;
  from: "person" | "declaration" | "unset";
  default?: Json;
  min?: string | number;
  max?: string | number;
  written?: Json;
}

export interface Running {
  refresh_ms: number | null;
  backfill: { pace_ms: number | null } | null;
  fields: JsonObject;
  members: Member[];
  built: JsonObject;
  unset: string[];
  notices: SettingsNotice[];
}

export function connectorSettings(connector: Connector, block: JsonObject | undefined): Running {
  const held = block ?? {};
  const key = `connectors.${connector.id}`;
  const members: Member[] = [];
  const notices: SettingsNotice[] = [];
  const fields: JsonObject = {};
  const runs = (member: string): Json | undefined => {
    const shape = shapeOf(connector, member);
    const written = held[member];
    if (shape === null) return undefined;
    const declared = shape.default;
    const shown: Member = { member, kind: shape.kind, ...(shape.label === undefined ? {} : { label: shape.label }), value: declared ?? null, from: declared === undefined ? "unset" : "declaration",
      ...(declared === undefined ? {} : { default: declared }), ...(shape.min === undefined ? {} : { min: shape.min }), ...(shape.max === undefined ? {} : { max: shape.max }) };
    let value = declared;
    if (written !== undefined) {
      const rule = shape.keep(written);
      if (rule !== null) {
        notices.push({ key: `${key}.${member}`, what: `settings.json holds ${key}.${member} as ${JSON.stringify(written)}, and it ${rule}: it is kept and ignored, and runs at its default (${CLI} connectors set ${connector.id} ${member} <value> replaces it)` });
        members.push({ ...shown, written });
        return declared;
      }
      const bounded = bound(written, shape);
      value = bounded;
      Object.assign(shown, { value: bounded, from: "person" }, bounded === written ? {} : { written });
      if (bounded !== written) notices.push({ key: `${key}.${member}`, what: `${key}.${member} is ${String(written)}, past its bound: it runs at ${String(bounded)}, and stays written` });
    }
    members.push(shown);
    return value;
  };
  for (const member of Object.keys(held)) {
    if (shapeOf(connector, member) === null) notices.push({ key: `${key}.${member}`, what: `settings.json holds ${key}.${member}, which ${connector.id} does not declare: it is kept and ignored (${CLI} connectors reset ${connector.id} ${member} removes it)` });
  }
  const refresh = runs("refresh");
  runs("start");
  const pace = runs("pace");
  runs(ROUTE);
  for (const [name, field] of Object.entries(connector.fields ?? {})) {
    const value = runs(name);
    if (value !== undefined) fields[name] = field.kind === "duration" ? duration(value as string) : value;
  }
  for (const member of processingMembers(connector)) runs(member);
  const words: JsonObject = {};
  for (const [member, value] of [["refresh", refresh], ["pace", pace]] as const) if (value !== undefined) words[member] = value;
  return {
    refresh_ms: refresh === undefined ? null : duration(refresh as string),
    backfill: connector.backfill === undefined ? null : { pace_ms: pace === undefined ? null : duration(pace as string) },
    fields, members, built: { ...words, ...fields }, unset: formOf(connector).filter((name) => fields[name] === undefined), notices,
  };
}

export function checkConnectors(registry: { connectors: readonly Connector[]; acquirers?: readonly { name: string }[] | undefined }, settings: Pick<Settings, "connectors">): SettingsNotice[] {
  const { connectors } = registry;
  for (const acquirer of registry.acquirers ?? []) connectorOf(connectors, acquirer.name);
  const notices = connectors.flatMap((connector) => connectorSettings(connector, settings.connectors[connector.id]).notices);
  for (const id of Object.keys(settings.connectors)) {
    if (!connectors.some((connector) => connector.id === id)) notices.push({ key: `connectors.${id}`, what: `settings.json holds connectors.${id}, and this release declares no connector ${id}: it is kept and ignored (${CLI} settings reset connectors.${id} removes it)` });
  }
  return notices;
}

export function plannedBlock(
  folder: SettingsFolder, connector: Connector, block: JsonObject, sets: readonly string[], was: Readonly<Record<string, Json>> = {}, routes: readonly ModelRoute[] = [], also: JsonObject = {},
): { write(): Running } {
  const key = `connectors.${connector.id}`;
  const now = Object.keys(was).length === 0 ? [] : connectorSettings(connector, blockOf(folder, connector.id)).members;
  for (const [member, expected] of Object.entries(was)) {
    const value = now.find((each) => each.member === member)?.value ?? null;
    const asked = sets.includes(member) ? block[member] ?? null : null;
    if (canonical(value) !== canonical(expected) && canonical(value) !== canonical(asked)) {
      refuse(409, "CHANGED", `${key}.${member} is ${JSON.stringify(value)} now, not ${JSON.stringify(expected)}: it was changed elsewhere`, undefined, { value });
    }
  }
  for (const member of sets) {
    const value = block[member];
    if (value !== undefined) checkMember(connector, member, value, routes);
  }
  const plan = planned(folder, { ...also, [key]: ownStartOf(folder, block, also) });
  return {
    write: () => {
      plan.write();
      return connectorSettings(connector, block);
    },
  };
}

function ownStartOf(folder: SettingsFolder, block: JsonObject, also: JsonObject): JsonObject {
  if (block.start === undefined) return block;
  const home = also["history.start"] ?? runsAt(folder, "history.start");
  const { start, ...rest } = block;
  return start === home ? rest : { ...rest, start };
}

export function checkMember(connector: Connector, member: string, value: Json, routes: readonly ModelRoute[]): void {
  const key = `connectors.${connector.id}.${member}`;
  const shape = shapeOf(connector, member) ?? fail(key, `is not a member of ${connector.id}: it holds ${members(connector).join(", ") || "none"}`);
  const rule = (shape.atSet ?? shape.keep)(value);
  if (rule !== null) fail(key, rule);
  if (bound(value, shape) !== value) fail(key, `runs ${shape.min === undefined ? "" : `from ${shape.min} `}${shape.max === undefined ? "up" : `to ${shape.max}`}`);
  if (member.startsWith(WORK_MEMBER) && member !== RANGE_MEMBER && value !== "default" && value !== "off") {
    const work = connector.processing![member.slice(WORK_MEMBER.length)]!;
    const serving = routes.filter((route) => unfit(route, workNeed(work)) === null).map((route) => route.id);
    if (!serving.includes(value as string)) {
      const known = routes.some((route) => route.id === value);
      fail(key, `${known ? `names a model route that cannot serve ${work.label.toLowerCase()}` : "names no model route the home knows"}: it is default, off${serving.length === 0 ? "" : ` or one of ${serving.join(", ")}`}`);
    }
  }
}

export function blockOf(folder: SettingsFolder, id: string): JsonObject {
  const block = keptOf(folder, [`connectors.${id}`]).held[`connectors.${id}`];
  return isObject(block) ? block : {};
}

export function connectorOf(connectors: readonly Connector[], acquirer: string): Connector {
  const catalog = catalogOf(connectors);
  const twice = catalog.twice.get(acquirer);
  if (twice !== undefined) fail(`acquirer ${acquirer}`, `is declared by ${twice.map((each) => each.id).join(" and ")}: one connector declares it`);
  return catalog.ofAcquirer(acquirer) ?? fail(`acquirer ${acquirer}`, "is declared by no connector: a connector's acquirers name it");
}

function members(connector: Connector): string[] {
  return ["refresh", "start", "pace", ROUTE, ...Object.keys(connector.fields ?? {}), ...processingMembers(connector)].filter((member) => shapeOf(connector, member) !== null);
}

export function processingMembers(connector: Connector): string[] {
  const works = Object.keys(connector.processing ?? {});
  return works.length === 0 ? [] : [...works.map((work) => `${WORK_MEMBER}${work}`), RANGE_MEMBER, ...works.map((work) => `${PRIVACY_MEMBER}${work}`)];
}

interface Shape extends Pick<Member, "kind" | "label" | "default" | "min" | "max"> {
  keep(value: Json): string | null;
  atSet?(value: Json): string | null;
}

function shapeOf(connector: Connector, member: string): Shape | null {
  const { refresh, backfill } = connector;
  if (member === "refresh") return refresh === undefined ? null : { kind: "refresh", ...refresh, keep: aDuration };
  if (member === "pace") return backfill?.pace === undefined ? null : { kind: "pace", ...backfill.pace, keep: aDuration };
  if (member === "start") return backfill === undefined ? null : { kind: "start", label: "Starts from", keep: startRule, atSet: (value) => startSetRule(value, Date.now()) };
  if (member === RANGE_MEMBER) {
    return connector.processing === undefined ? null : { kind: "choice", label: "Range", keep: is((value) => value === "all" || (typeof value === "string" && aDay(value)), "is all or a day (2026-10-11)") };
  }
  if (member.startsWith(WORK_MEMBER)) {
    const work = connector.processing?.[member.slice(WORK_MEMBER.length)];
    return work === undefined ? null : {
      kind: "choice", label: work.label, default: "default",
      keep: is((value) => value === "default" || value === "off" || (typeof value === "string" && ROUTE_ID.test(value)), "is default, off or a model route (<transport>:<model>)"),
    };
  }
  if (member.startsWith(PRIVACY_MEMBER)) {
    const work = connector.processing?.[member.slice(PRIVACY_MEMBER.length)];
    const row = privacySetting("connector", member);
    return work === undefined || row === undefined ? null : { kind: "choice", label: `${work.label}: personal details`, default: "default", keep: row.rule };
  }
  if (member === ROUTE) {
    const routes = (connector.signin ?? []).map(routeId);
    return routes.length === 0 ? null : { kind: "route", keep: is((value) => typeof value === "string" && routes.includes(value), `is one of ${routes.join(", ")}`) };
  }
  if (!Object.hasOwn(connector.fields ?? {}, member)) return null;
  const field = connector.fields![member]!;
  switch (field.kind) {
    case "secret":
      return { kind: "secret", label: field.label, default: field.secret, keep: is((value) => typeof value === "string" && SECRET.test(value), "names a secret") };
    case "choice": {
      const options = Object.keys(field.options);
      return { kind: "choice", label: field.label, default: field.default, keep: is((value) => typeof value === "string" && options.includes(value), `is one of ${options.join(", ")}`) };
    }
    default:
      return {
        kind: field.kind, label: field.label, ...(field.default === undefined ? {} : { default: field.default }),
        ...("min" in field && field.min !== undefined ? { min: field.min } : {}), ...("max" in field && field.max !== undefined ? { max: field.max } : {}),
        keep: field.kind === "list" && field.items === "modes" ? aModes : RULES[field.kind],
      };
  }
}

function aDuration(value: Json): string | null {
  try {
    if (typeof value !== "string") throw new TimeError("duration", "not a word");
    duration(value);
    return null;
  } catch (error) {
    if (!(error instanceof TimeError)) throw error;
    return "is a duration: a whole number and one unit, s, m, h or d (30s, 10m, 1h, 2d)";
  }
}

function aDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

function aModes(value: Json): string | null {
  const rule = "is a list of recording modes: each { app, mode } or { site, mode }, its mode activity or exclude, none named twice";
  if (!Array.isArray(value)) return rule;
  const named = new Set<string>();
  for (const item of value) {
    if (!isObject(item) || !["activity", "exclude"].includes(item.mode as string)) return rule;
    const keys = Object.keys(item).filter((key) => key !== "mode");
    const [key] = keys;
    if (keys.length !== 1 || (key !== "app" && key !== "site") || typeof item[key] !== "string" || item[key] === "") return rule;
    if (named.has(`${key} ${item[key] as string}`)) return rule;
    named.add(`${key} ${item[key] as string}`);
  }
  return null;
}

const RULES: Record<Exclude<Field["kind"], "secret" | "choice">, (value: Json) => string | null> = {
  duration: aDuration,
  email: is((value) => typeof value === "string" && /^[^\s@]+@[^\s@]+$/u.test(value), "is an email address"),
  text: is((value) => typeof value === "string" && value !== "", "is text"),
  path: is((value) => typeof value === "string" && value.startsWith("/"), "is an absolute path"),
  zone: is((value) => typeof value === "string" && isZone(value), "is an IANA time zone"),
  list: is((value) => Array.isArray(value), "is a list"),
  number: is((value) => typeof value === "number" && Number.isFinite(value), "is a number"),
  toggle: is((value) => typeof value === "boolean", "is true or false"),
  date: is((value) => typeof value === "string" && aDay(value), "is a date (2019-03-01)"),
};

function bound(value: Json, shape: Shape): Json {
  const { min, max } = shape;
  if (min === undefined && max === undefined) return value;
  if (shape.kind === "date") {
    if (typeof value !== "string" || !aDay(value)) return value;
    if (typeof min === "string" && value < min) return min;
    if (typeof max === "string" && value > max) return max;
    return value;
  }
  if (typeof value === "number") {
    if (typeof min === "number" && value < min) return min;
    if (typeof max === "number" && value > max) return max;
    return value;
  }
  if (typeof value !== "string" || aDuration(value) !== null) return value;
  const ms = duration(value);
  if (typeof min === "string" && ms < duration(min)) return min;
  if (typeof max === "string" && ms > duration(max)) return max;
  return value;
}
