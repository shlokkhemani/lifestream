import {
  accountOf, addDays, dayBounds, digest, instant, parse, render, selects, wellFormedJson,
  type DaySettings, type DayUnit, type EnrichmentRow, type ExtractRow, type Json, type RecordRef, type SourceRow, type Type, type View,
} from "@lifestreamprotocol/core";
import { restsAlone, type Collection, type DayFact, type DayInput, type DayLine, type DayProjection, type FactFrom, type Family, type NameSpan, type Role } from "./family.js";
import { WHERE_VERSION } from "./physical/where.js";
import { GEOGRAPHY_VERSION } from "./shared/geography.js";
import { LABELS_CODE, LABELS_FAMILY, labelsFrom, type DayLabels } from "./shared/labels.js";

export const RENDERER_VERSION = `14/${GEOGRAPHY_VERSION}/${WHERE_VERSION}`;

export type DayReader = Pick<View, "extractsOn" | "enrichment" | "sources" | "since">;

export interface RenderedDay {
  json: string;
  txt: string;
  lines: string;
  inputs: string;
  units: DayUnit[];
  devices: [string, string][];
}

export interface LabelUnit {
  reading: string;
  code: string;
  content: Json;
}

export type LabelUnits = (unit: string) => LabelUnit | undefined;

export function tableUnits(labels: DayLabels): LabelUnits {
  const contents = labels.contents;
  return (unit) => {
    const content = contents.get(unit);
    return content === undefined ? undefined : { reading: digest(content), code: LABELS_CODE, content };
  };
}

export class DayReadError extends Error {
  override name = "DayReadError";
}

export class DayLineError extends Error {
  override name = "DayLineError";
}

export class DayFactError extends Error {
  override name = "DayFactError";
}

export const ATOM_FLAGS = [
  "heading", "date_only", "no_time", "continues_from_previous_day", "continues_into_next_day",
] as const;
export type AtomFlag = (typeof ATOM_FLAGS)[number];

export interface DayAtom {
  n: number;
  family: string;
  unit: string;
  units: string[];
  accounts?: string[];
  start_ms: number | null;
  end_ms: number | null;
  local_start: string | null;
  local_end: string | null;
  flags: AtomFlag[];
  text: string;
  names?: NameSpan[];
  record?: RecordRef;
  item?: string;
  block?: { key: string; title: string; names?: NameSpan[] };
  chat?: string;
  pictures?: number;
  type?: Type;
  video?: { duration_ms: number | null };
  live?: true;
  joins?: RecordRef;
}

export interface DayFileFact {
  id: string;
  family: string;
  of: string;
  time_ms: number;
  start_ms: number;
  end_ms: number;
  date_only?: true;
  keys: Record<string, string>;
  measures: Record<string, number | string>;
  who: { handle: string; role: Role }[];
  from: FactFrom;
  lines: number[];
}

export interface DayDocument {
  day: string;
  zone: string;
  day_start_hour: number;
  window: { start_ms: number; end_ms: number };
  renderer: string;
  inputs: string;
  counts: { total: number; per_family: Record<string, number> };
  coverage: { family: string; sources: { source: string; read: Read }[] }[];
  atoms: DayAtom[];
  facts: DayFileFact[];
}

export const READS = ["none", "into", "through"] as const;
export type Read = typeof READS[number];

const READ_WORDS: Record<Read, string> = { none: "not read into the day", into: "read into the day", through: "read through the day" };

export const DAY_FILE_SHAPE = {
  day: "day",
  zone: "string",
  day_start_hour: "integer",
  window: { start_ms: "integer", end_ms: "integer" },
  renderer: "string",
  inputs: "digest",
  counts: { total: "integer", per_family: { "*": "integer" } },
  coverage: [{ family: "string", sources: [{ source: "string", read: "read" }] }],
  atoms: [{
    n: "integer",
    family: "string",
    unit: "string",
    units: ["string"],
    "accounts?": ["string"],
    start_ms: "integer|null",
    end_ms: "integer|null",
    local_start: "string|null",
    local_end: "string|null",
    flags: ["flag"],
    text: "string",
    "names?": [{ start: "integer", end: "integer", who: "string" }],
    "record?": { source: "string", kind: "string", key: "string" },
    "item?": "string",
    "block?": { key: "string", title: "string", "names?": [{ start: "integer", end: "integer", who: "string" }] },
    "chat?": "string",
    "pictures?": "integer",
    "type?": "string",
    "video?": { duration_ms: "integer|null" },
    "live?": "true",
    "joins?": { source: "string", kind: "string", key: "string" },
  }],
  facts: [{
    id: "string",
    family: "string",
    of: "string",
    time_ms: "integer",
    start_ms: "integer",
    end_ms: "integer",
    "date_only?": "true",
    keys: { "*": "string" },
    measures: { "*": "measure" },
    who: [{ handle: "string", role: "role" }],
    from: { units: ["string"], "accounts?": ["string"], "record?": { source: "string", kind: "string", key: "string" }, "alone?": "true", "item?": "string", "instrument?": "string" },
    lines: ["integer"],
  }],
} as const;

export type DeviceNames = (unit: string) => string | undefined;

export const DEVICE_NAMES = "device-names";

export function renderDay(
  day: string,
  families: readonly Family[],
  reader: DayReader,
  settings: DaySettings,
  labelUnits: LabelUnits,
  devices: DeviceNames = () => undefined,
): RenderedDay {
  if (addDays(day, 0) !== day) throw new TypeError(`not a day: ${JSON.stringify(day)}`);
  const daySettings: DaySettings = { zone: settings.zone, day_start_hour: settings.day_start_hour };
  const window = dayBounds(day, daySettings);
  const ordered = families.filter((family) => !(family.inputs.length > 0 && family.inputs.every((input) => input.role === "labels")))
    .sort((left, right) => compare(left.name, right.name));
  ordered.forEach((family, index) => {
    if (ordered[index + 1]?.name === family.name) throw new TypeError(`two families are named ${family.name}`);
  });
  const sources = reader.sources();
  const byId = new Map(sources.map((source) => [source.id, source]));
  const asked = new Map<string, LabelUnit | undefined>();
  const labels = labelsFrom((unit) => {
    if (!asked.has(unit)) asked.set(unit, labelUnits(unit));
    return asked.get(unit);
  }, daySettings);
  const namedDevices = new Map<string, string>();
  const device = (unit: string): string => {
    if (!namedDevices.has(unit)) namedDevices.set(unit, devices(unit) ?? unit);
    return namedDevices.get(unit)!;
  };

  const drafts: Draft[] = [];
  const stated: { family: Family; projection: DayProjection; drafts: (Draft | null)[] }[] = [];
  const units: DayUnit[] = [];
  const perFamily: Json[] = [];
  const coverage: DayDocument["coverage"] = [];
  for (const family of ordered) {
    const got = readFamily(family, day, reader, daySettings);
    const input: DayInput = { day, settings: daySettings, extracts: got.extracts, enrichments: got.enrichments, labels, sources: byId, device };
    const printed = new Set<string>();
    const projection = family.day(input);
    const placed = projection.lines.map((line, index) => {
      checkLine(family.name, line);
      const draft = place(line, index, day, window, settings.zone);
      if (draft === null) return null;
      drafts.push(draft);
      for (const unit of line.units) printed.add(unit);
      return draft;
    });
    stated.push({ family, projection, drafts: placed });
    for (const row of got.extracts) units.push({ family: family.name, unit: row.unit, reading: row.reading, code: row.code, shown: printed.has(row.unit) });
    const covered = familyCoverage(family, sources, reader, window);
    coverage.push({ family: family.name, sources: covered });
    perFamily.push({
      family: family.name, code: family.code, coverage: covered,
      extracts: got.extracts.map((row) => [row.unit, row.reading, row.code]),
      enrichments: [...got.enrichments.values()].map((row) => digest({ item: row.item, prompt: row.prompt, state: row.state, content: row.content })),
    });
  }
  const named = [...asked].sort(([left], [right]) => compare(left, right));
  for (const [unit, row] of named) units.push({ family: LABELS_FAMILY, unit, reading: row?.reading ?? "", code: row?.code ?? "", shown: false });
  for (const unit of [...namedDevices.keys()].sort(compare)) units.push({ family: DEVICE_NAMES, unit, reading: "", code: "", shown: false });
  const devicesNamed = [...namedDevices].sort(([left], [right]) => compare(left, right));
  const inputs = digest({
    renderer: RENDERER_VERSION, day, zone: settings.zone, day_start_hour: settings.day_start_hour,
    labels: named.map(([unit, row]) => [unit, row?.reading ?? null, row?.code ?? null]), families: perFamily,
    ...(devicesNamed.length === 0 ? {} : { devices: devicesNamed }),
  });

  const atoms = numbered(drafts);
  const atomOf = new Map(drafts.map((draft, index) => [draft, index + 1]));
  const facts = stated.flatMap(({ family, projection, drafts: placed }) => dayFacts(family, projection, day, daySettings, (index) => {
    const draft = placed[index];
    return draft === null || draft === undefined ? undefined : atomOf.get(draft);
  })).sort(byFactOrder);
  const document: DayDocument = {
    day, zone: settings.zone, day_start_hour: settings.day_start_hour,
    window: { start_ms: window.start_ms, end_ms: window.end_ms },
    renderer: RENDERER_VERSION, inputs,
    counts: {
      total: atoms.length,
      per_family: Object.fromEntries(ordered.map((family) => [family.name, atoms.filter((atom) => atom.family === family.name).length])),
    },
    coverage,
    atoms,
    facts,
  };
  const printed = transcript(document);
  return {
    json: documentText(document),
    txt: `${printed.map((line) => line.text).join("\n")}\n`.toWellFormed(),
    lines: `${JSON.stringify(printed.map((line) => line.atoms))}\n`,
    inputs,
    units,
    devices: devicesNamed,
  };
}

export function checkDayFile(value: unknown): string[] {
  const violations: string[] = [];
  checkShape(value, DAY_FILE_SHAPE, "$", violations);
  if (violations.length > 0) return violations;
  const document = value as DayDocument;
  document.atoms.forEach((atom, index) => {
    if (atom.n !== index + 1) violations.push(`$.atoms[${index}].n is ${atom.n}, not ${index + 1}`);
  });
  if (document.counts.total !== document.atoms.length) violations.push("$.counts.total is not the number of atoms");
  const summed = Object.values(document.counts.per_family).reduce((sum, count) => sum + count, 0);
  if (summed !== document.counts.total) violations.push("$.counts.per_family does not add up to the total");
  const seen = new Set<string>();
  document.facts.forEach((fact, index) => {
    const path = `$.facts[${index}]`;
    if (seen.has(`${fact.family} ${fact.id}`)) violations.push(`${path} states ${fact.family}'s ${fact.id} twice`);
    seen.add(`${fact.family} ${fact.id}`);
    if (fact.end_ms < fact.start_ms || (fact.time_ms !== fact.start_ms && fact.time_ms !== fact.end_ms)) violations.push(`${path}'s time is neither end of its span`);
    if (fact.date_only === true ? render(fact.time_ms, document.zone, "day") !== document.day
      : fact.time_ms < document.window.start_ms || fact.time_ms >= document.window.end_ms) violations.push(`${path}'s time is not in the day: another day states it`);
    fact.lines.forEach((n, at) => {
      if (n < 1 || n > document.atoms.length || (at > 0 && n <= fact.lines[at - 1]!)) violations.push(`${path}.lines[${at}] is not an atom of the day in order`);
    });
  });
  return violations;
}

interface FamilyRead {
  extracts: ExtractRow[];
  enrichments: Map<string, EnrichmentRow>;
}

function readFamily(family: Family, day: string, reader: DayReader, settings: DaySettings): FamilyRead {
  const byUnit = new Map<string, ExtractRow>();
  for (const extract of reader.extractsOn(family.name, day)) {
    const where = `${family.name} extract ${JSON.stringify(extract.unit)}`;
    if (extract.family !== family.name) throw new DayReadError(`${where} belongs to ${extract.family}`);
    if (!extract.days.includes(day)) throw new DayReadError(`${where} was read for ${day}, outside its days [${extract.days.join(", ")}]`);
    if (!family.days(extract, settings).includes(day)) continue;
    if (byUnit.has(extract.unit)) throw new DayReadError(`${where} was read twice`);
    byUnit.set(extract.unit, extract);
  }
  const extracts = [...byUnit.values()].sort((left, right) => compare(left.unit, right.unit));
  const enrichments = new Map<string, EnrichmentRow>();
  const prompts = new Map<string, string>();
  for (const extract of extracts) {
    for (const { item, prompt } of family.items?.(extract) ?? []) {
      const known = prompts.get(item);
      if (known !== undefined && known !== prompt) {
        throw new DayReadError(`${family.name} item ${JSON.stringify(item)} is printed under two prompts, ${known} and ${prompt}`);
      }
      prompts.set(item, prompt);
      if (enrichments.has(item)) continue;
      const row = reader.enrichment(family.name, item, prompt);
      if (row !== undefined) enrichments.set(item, row);
    }
  }
  return { extracts, enrichments };
}

function checkLine(family: string, line: DayLine): void {
  const fail = (why: string): never => {
    throw new DayLineError(`${family} line ${JSON.stringify(line.text)}: ${why}`);
  };
  if (line.family !== family) fail(`names family ${line.family}`);
  if (typeof line.text !== "string") fail("has no text");
  if (typeof line.unit !== "string" || line.unit === "") fail("names no unit it is printed under");
  if (!Array.isArray(line.units) || line.units.length === 0 || line.units.some((unit) => typeof unit !== "string" || unit === "")) fail("names no unit it rests on");
  if (new Set(line.units).size !== line.units.length) fail("names a unit twice");
  const accounts = accountsFault(line.accounts);
  if (accounts !== null) fail(accounts);
  for (const value of [line.start_ms, line.end_ms]) {
    if (value !== null && !Number.isSafeInteger(value)) fail("has a time that is not integer milliseconds");
  }
  if (line.start_ms === null && line.end_ms !== null) fail("has an end without a start");
  if (line.start_ms !== null && line.end_ms !== null && line.end_ms < line.start_ms) fail("ends before it starts");
  if (line.date_only === true && line.start_ms === null) fail("is date-only with no date");
  if (line.chat !== undefined && (typeof line.chat !== "string" || line.chat === "")) fail("names an empty chat");
  if (line.pictures !== undefined && !(Number.isSafeInteger(line.pictures) && line.pictures > 0)) fail("holds pictures that are not a whole number above 0");
  if (line.video !== undefined && line.video.duration_ms !== null && !(Number.isSafeInteger(line.video.duration_ms) && line.video.duration_ms > 0)) fail("has a video length that is not whole milliseconds");
  if (line.live !== undefined && (line.live !== true || line.video !== undefined)) fail("is a Live Photo's but not `live: true` on a photo's line");
  const why = spansFault(line.text, line.names) ?? (line.block === undefined ? null : spansFault(line.block.title, line.block.names));
  if (why !== null) fail(why);
}

function spansFault(text: string, names: readonly NameSpan[] | undefined): string | null {
  let after = 0;
  for (const name of names ?? []) {
    const span = `names ${JSON.stringify(name)}`;
    if (!Number.isSafeInteger(name.start) || !Number.isSafeInteger(name.end) || name.start < after || name.end <= name.start || name.end > text.length) {
      return `${span}, which is no span of its words after the last`;
    }
    if (isSpace(text.charCodeAt(name.start)) || isSpace(text.charCodeAt(name.end - 1))) return `${span}, which starts or ends on whitespace`;
    if (typeof name.who !== "string" || name.who === "") return `${span} of no one`;
    after = name.end;
  }
  return null;
}

export function dayFacts(
  family: Family, projection: DayProjection, day: string, settings: DaySettings, atomOf: (line: number) => number | undefined,
): DayFileFact[] {
  checkFacts(family, projection.facts, projection.lines.length);
  const window = dayBounds(day, settings);
  return projection.facts.flatMap((fact) => {
    const at = factOn(fact, family, day, window, settings.zone);
    if (at === null) return [];
    const lines = [...new Set(fact.lines.flatMap((index) => atomOf(index) ?? []))].sort((left, right) => left - right);
    return [{ ...at, lines }];
  }).sort(byFactOrder);
}

function byFactOrder(left: DayFileFact, right: DayFileFact): number {
  return left.time_ms - right.time_ms || compare(left.family, right.family) || compare(left.id, right.id);
}

export function checkFacts(family: Family, facts: readonly DayFact[], lineCount: number): void {
  const ids = new Set<string>();
  for (const fact of facts) {
    const fail = (why: string): never => {
      throw new DayFactError(`${family.name} fact ${JSON.stringify(fact.id)} of ${JSON.stringify(fact.of)}: ${why}`);
    };
    const collection: Collection | undefined = Object.hasOwn(family.collections ?? {}, fact.of) ? family.collections![fact.of] : undefined;
    if (collection === undefined) fail("is of no collection its family declares");
    if (typeof fact.id !== "string" || !fact.id.startsWith(`${fact.of}:`)) fail("has no id of its collection (factId)");
    if (ids.has(fact.id)) fail("is stated twice");
    ids.add(fact.id);
    for (const value of [fact.time_ms, fact.start_ms, fact.end_ms]) if (!Number.isSafeInteger(value)) fail("has a time that is not integer milliseconds");
    if (fact.end_ms < fact.start_ms) fail("ends before it starts");
    if (fact.date_only === true && (fact.start_ms !== fact.time_ms || fact.end_ms !== fact.time_ms || fact.time_ms % 86_400_000 !== 0)) {
      fail("is date-only but not one date at midnight UTC");
    }
    const ends = new Set(Object.keys(fact.measures).map((name) => collection!.measures[name]?.time));
    if (ends.size > 1) fail("states measures timed at both ends of its span");
    const end = [...ends][0];
    if (end === undefined ? fact.time_ms !== fact.start_ms && fact.time_ms !== fact.end_ms
      : fact.time_ms !== (end === "start" ? fact.start_ms : fact.end_ms)) fail(`has a time that is not its span's ${end ?? "start or end"}`);
    for (const [key, value] of Object.entries(fact.keys)) {
      if (!collection!.keys.includes(key)) fail(`states key ${key}, which its collection does not declare`);
      if (typeof value !== "string") fail(`states key ${key} as no string`);
    }
    for (const [name, value] of Object.entries(fact.measures)) {
      const measure = Object.hasOwn(collection!.measures, name) ? collection!.measures[name] : undefined;
      if (measure === undefined) fail(`states measure ${name}, which its collection does not declare`);
      if (measure!.unit === "currency") {
        if (typeof value !== "string" || !DECIMAL.test(value)) fail(`states ${name}, a currency, as no decimal string`);
        if (typeof fact.keys["currency"] !== "string") fail(`states ${name}, a currency, with no currency key`);
        if (measure!.split !== "whole") fail(`states ${name}, a currency, split by the clock`);
        const held = minorUnitsOf(value as string, fact.keys["currency"]!);
        if (typeof held === "string") fail(`states ${name} ${held}`);
      } else if (typeof value !== "number" || !Number.isFinite(value)) fail(`states ${name} as no number`);
    }
    for (const { handle, role } of fact.who) {
      if (typeof handle !== "string" || handle === "") fail("holds a person with no handle");
      if (!ROLES.includes(role)) fail(`holds a person as ${JSON.stringify(role)}`);
    }
    const units = fact.from?.units;
    if (!Array.isArray(units) || units.length === 0 || units.some((unit) => typeof unit !== "string" || unit === "")) fail("names no unit it was read from");
    if (new Set(units).size !== units.length) fail("names a unit twice");
    if (fact.from.alone !== undefined && (fact.from.alone !== true || fact.from.record === undefined)) fail("rests on its record alone with no record");
    const accounts = accountsFault(fact.from.accounts);
    if (accounts !== null) fail(accounts);
    if (new Set(fact.lines).size !== fact.lines.length || fact.lines.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= lineCount)) {
      fail("cites a line its projection does not hold, or one line twice");
    }
  }
}

export function accountFaults(document: DayDocument): string[] {
  const covered = new Set(document.coverage.flatMap(({ sources }) => sources.map(({ source }) => accountOf(source))));
  const faults: string[] = [];
  const stated = (what: string, accounts: readonly string[] | undefined, alone: boolean) => {
    if (accounts === undefined) {
      if (!alone) faults.push(`${document.day} ${what} states neither one record nor its accounts`);
      return;
    }
    for (const account of accounts) {
      if (!covered.has(account)) faults.push(`${document.day} ${what} states account ${account}, which no evidence source of the day has`);
    }
  };
  for (const atom of document.atoms) stated(`atom ${atom.n} (${atom.family})`, atom.accounts, restsAlone(atom.units, atom.record !== undefined));
  for (const fact of document.facts) stated(`fact ${fact.id} (${fact.family})`, fact.from.accounts, restsAlone(fact.from.units, fact.from.alone === true));
  return faults;
}

function accountsFault(accounts: readonly string[] | undefined): string | null {
  if (accounts === undefined) return null;
  if (!Array.isArray(accounts) || accounts.length === 0 || accounts.some((account) => typeof account !== "string" || account === "")) return "states accounts that are no list of accounts";
  return accounts.every((account, index) => index === 0 || compare(accounts[index - 1]!, account) < 0) ? null : "states its accounts out of order or twice";
}

const ROLES: readonly Role[] = ["sender", "receiver", "attendee"];
const DECIMAL = /^-?\d+(\.\d+)?$/u;

export function digitsOf(currency: string): number | undefined {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return undefined;
  }
}

export function minorUnitsOf(decimal: string, currency: string): number | string {
  const digits = digitsOf(currency);
  if (digits === undefined) return `in ${JSON.stringify(currency)}, which is no currency code`;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(decimal);
  if (match === null) return `as ${JSON.stringify(decimal)}, no decimal`;
  const places = match[3] ?? "";
  if (places.length > digits && !/^0*$/u.test(places.slice(digits))) return `as ${decimal} ${currency}, finer than its minor unit`;
  const value = Number(`${match[2]}${places.slice(0, digits).padEnd(digits, "0")}`);
  if (!Number.isSafeInteger(value)) return `as ${decimal} ${currency}, past what is held exactly`;
  return match[1] === "-" ? -value : value;
}

function factOn(fact: DayFact, family: Family, day: string, window: { start_ms: number; end_ms: number }, zone: string): Omit<DayFileFact, "lines"> | null {
  const owns = fact.date_only === true ? render(fact.time_ms, zone, "day") === day : fact.time_ms >= window.start_ms && fact.time_ms < window.end_ms;
  if (!owns) return null;
  return {
    id: fact.id, family: family.name, of: fact.of, time_ms: fact.time_ms, start_ms: fact.start_ms, end_ms: fact.end_ms,
    ...(fact.date_only === true ? { date_only: true as const } : {}),
    keys: { ...fact.keys },
    measures: { ...fact.measures },
    who: fact.who.map(({ handle, role }) => ({ handle, role })),
    from: {
      units: [...fact.from.units],
      ...(fact.from.accounts === undefined ? {} : { accounts: [...fact.from.accounts] }),
      ...(fact.from.record === undefined ? {} : { record: { source: fact.from.record.source, kind: fact.from.record.kind, key: fact.from.record.key } }),
      ...(fact.from.alone === true ? { alone: true as const } : {}),
      ...(fact.from.item === undefined ? {} : { item: fact.from.item }),
      ...(fact.from.instrument === undefined ? {} : { instrument: fact.from.instrument }),
    },
  };
}

interface Draft {
  line: DayLine;
  index: number;
  section: 0 | 1 | 2 | 3;
  start_ms: number | null;
  end_ms: number | null;
  local_start: string | null;
  local_end: string | null;
  flags: AtomFlag[];
}

function place(line: DayLine, index: number, day: string, window: { start_ms: number; end_ms: number }, zone: string): Draft | null {
  const base = { line, index, local_start: null, local_end: null };
  if (line.heading === true) return { ...base, section: 0, start_ms: null, end_ms: null, flags: ["heading"] };
  if (line.date_only === true) {
    const first = render(line.start_ms!, zone, "day");
    const last = render(line.end_ms === null ? line.start_ms! : Math.max(line.start_ms!, line.end_ms - 1), zone, "day");
    if (day < first || day > last) return null;
    const flags: AtomFlag[] = ["date_only"];
    if (first < day) flags.push("continues_from_previous_day");
    if (last > day) flags.push("continues_into_next_day");
    return { ...base, section: 2, start_ms: line.start_ms, end_ms: line.end_ms, flags };
  }
  if (line.start_ms === null) return { ...base, section: 3, start_ms: null, end_ms: null, flags: ["no_time"] };
  const start = line.start_ms;
  const end = line.end_ms ?? start;
  const inside = end === start
    ? start >= window.start_ms && start < window.end_ms
    : start < window.end_ms && end > window.start_ms;
  if (!inside) return null;
  const flags: AtomFlag[] = [];
  if (start < window.start_ms) flags.push("continues_from_previous_day");
  if (end > window.end_ms) flags.push("continues_into_next_day");
  const clippedStart = Math.max(start, window.start_ms);
  const clippedEnd = line.end_ms === null ? null : Math.min(end, window.end_ms);
  return {
    ...base, section: 1, start_ms: clippedStart, end_ms: clippedEnd, flags,
    local_start: render(clippedStart, zone, "minute", day),
    local_end: clippedEnd === null ? null : render(clippedEnd, zone, "minute", day),
  };
}

export function dayAtoms(day: string, settings: DaySettings, family: string, lines: readonly DayLine[]): DayAtom[] {
  const window = dayBounds(day, settings);
  return numbered(lines.flatMap((line, index) => {
    checkLine(family, line);
    const draft = place(line, index, day, window, settings.zone);
    return draft === null ? [] : [draft];
  }));
}

function numbered(drafts: Draft[]): DayAtom[] {
  return drafts.sort(byPrintOrder).map((draft, index): DayAtom => {
    const { line } = draft;
    const text = laid(line.text, line.names, "lines");
    const block = line.block === undefined ? undefined : { key: line.block.key, ...laid(line.block.title, line.block.names, "one") };
    return {
      n: index + 1,
      family: line.family,
      unit: line.unit,
      units: [...line.units],
      ...(line.accounts === undefined ? {} : { accounts: [...line.accounts] }),
      start_ms: draft.start_ms,
      end_ms: draft.end_ms,
      local_start: draft.local_start,
      local_end: draft.local_end,
      flags: draft.flags,
      text: text.text,
      ...(text.names.length === 0 ? {} : { names: text.names }),
      ...(line.record === undefined ? {} : { record: { source: line.record.source, kind: line.record.kind, key: line.record.key } }),
      ...(line.item === undefined ? {} : { item: line.item }),
      ...(block === undefined || (draft.section !== 1 && draft.section !== 3) ? {} : {
        block: { key: block.key, title: block.text, ...(block.names.length === 0 ? {} : { names: block.names }) },
      }),
      ...(line.chat === undefined ? {} : { chat: line.chat }),
      ...(line.pictures === undefined ? {} : { pictures: line.pictures }),
      ...(line.type === undefined ? {} : { type: line.type }),
      ...(line.video === undefined ? {} : { video: { duration_ms: line.video.duration_ms } }),
      ...(line.live === true ? { live: true as const } : {}),
      ...(line.joins === undefined ? {} : { joins: { source: line.joins.source, kind: line.joins.kind, key: line.joins.key } }),
    };
  });
}

function byPrintOrder(left: Draft, right: Draft): number {
  if (left.section !== right.section) return left.section - right.section;
  if (left.section === 1) {
    const order = left.start_ms! - right.start_ms! || (right.end_ms ?? right.start_ms!) - (left.end_ms ?? left.start_ms!);
    if (order !== 0) return order;
  }
  if (left.section === 2) {
    const order = left.line.start_ms! - right.line.start_ms!;
    if (order !== 0) return order;
  }
  return compare(left.line.family, right.line.family) || compare(left.line.unit, right.line.unit) || left.index - right.index;
}

interface Printed {
  text: string;
  atoms: number[];
}

function transcript(document: DayDocument): Printed[] {
  const { day, window, zone } = document;
  const plain = (text: string): Printed => ({ text, atoms: [] });
  const hours = Math.round((window.end_ms - window.start_ms) / 360_000) / 10;
  const families = Object.entries(document.counts.per_family).map(([family, count]) => `${family} ${count}`).join(", ");
  const out: Printed[] = [
    plain(`Day ${day} (${weekday(day)}) in ${zone}, ${render(window.start_ms, zone, "minute", day)} to ${render(window.end_ms, zone, "minute", day)} (${hours} h)`),
    plain(`${document.atoms.length} atoms: ${families}`),
  ];
  const section = (flag: AtomFlag | null) => document.atoms.filter((atom) => flag === null
    ? !atom.flags.some((value) => value === "heading" || value === "date_only" || value === "no_time")
    : atom.flags.includes(flag));
  for (const atom of section("heading")) out.push({ text: oneLine(atom.text), atoms: [atom.n] });
  const timed = section(null);
  if (timed.length > 0) out.push(plain(""), ...timedLines(timed, day));
  const dated = section("date_only");
  if (dated.length > 0) {
    out.push(plain(""), plain(`On ${day}, time unknown`));
    for (const atom of dated) out.push({ text: `${oneLine(atom.text)}${flagWords(atom.flags, day)}`, atoms: [atom.n] });
  }
  const timeless = section("no_time");
  if (timeless.length > 0) {
    out.push(plain(""), plain("No time stated"));
    for (let index = 0; index < timeless.length;) {
      const first = timeless[index]!;
      const title = first.block?.title;
      let end = index + 1;
      while (title !== undefined && timeless[end]?.block?.title === title) end++;
      const run = timeless.slice(index, end);
      index = end;
      if (title !== undefined) out.push({ text: title, atoms: run.map((atom) => atom.n) });
      for (const atom of run) out.push({ text: `${title === undefined ? "" : "  "}${oneLine(atom.text)}`, atoms: [atom.n] });
    }
  }
  out.push(plain(""), plain("Coverage"));
  for (const { family, sources } of document.coverage) {
    const words = sources.map(({ source, read }) => `${source} ${READ_WORDS[read]}`);
    out.push(plain(`${family}: ${words.length === 0 ? "no sources" : words.join("; ")}`));
  }
  return out;
}

function timedLines(atoms: DayAtom[], day: string): Printed[] {
  const out: Printed[] = [];
  for (let index = 0; index < atoms.length;) {
    const first = atoms[index]!;
    let end = index + 1;
    while (first.block !== undefined && atoms[end]?.block?.key === first.block.key) end++;
    const run = atoms.slice(index, end);
    index = end;
    if (run.length === 1) {
      const text = first.block === undefined ? oneLine(first.text) : `${first.block.title} · ${oneLine(first.text)}`;
      out.push({ text: `${clock(first)} ${text}${flagWords(first.flags, day)}`, atoms: [first.n] });
      continue;
    }
    const last = run.reduce((latest, atom) => (atom.end_ms ?? atom.start_ms!) > (latest.end_ms ?? latest.start_ms!) ? atom : latest);
    out.push({ text: `${span(first.local_start!, last.local_end ?? last.local_start!)} ${first.block!.title} (${run.length})`, atoms: run.map((atom) => atom.n) });
    let shown: string | null = null;
    for (const atom of run) {
      const stamp = clock(atom);
      out.push({ text: `  ${stamp === shown ? "" : `${stamp} `}${oneLine(atom.text)}${flagWords(atom.flags, day)}`, atoms: [atom.n] });
      shown = stamp;
    }
  }
  return out;
}

function clock(atom: DayAtom): string {
  return span(atom.local_start!, atom.local_end ?? atom.local_start!);
}

function span(start: string, end: string): string {
  if (end === start) return start;
  const date = start.length > 5 ? start.slice(0, 11) : "";
  return `${start}–${date !== "" && end.startsWith(date) ? end.slice(11) : end}`;
}

function flagWords(flags: readonly AtomFlag[], day: string): string {
  return (flags.includes("continues_from_previous_day") ? ` (continues from ${shortDay(addDays(day, -1))})` : "") +
    (flags.includes("continues_into_next_day") ? ` (continues into ${shortDay(addDays(day, 1))})` : "");
}

function familyCoverage(family: Family, sources: readonly SourceRow[], reader: DayReader, window: { start_ms: number; end_ms: number }): DayDocument["coverage"][number]["sources"] {
  const evidence = family.inputs.filter((input) => input.role === "evidence");
  return sources
    .filter((source) => {
      const kinds = evidence.filter((input) => selects(input.sources, source)).flatMap((input) => input.kinds);
      if (kinds.length === 0) return false;
      const since = reader.since(source.id, [...new Set(kinds)]);
      return since !== undefined && since < window.end_ms;
    })
    .sort((left, right) => compare(left.id, right.id))
    .map((source) => {
      const through = source.read_through_ms;
      const read: Read = through === null || through < window.start_ms ? "none" : through >= window.end_ms ? "through" : "into";
      return { source: source.id, read };
    });
}

const ATOMS = ',\n  "atoms": ';

export function documentText(document: DayDocument): string {
  const { atoms, facts, ...head } = document;
  const members = Object.entries(head).map(([name, value]) => `  ${JSON.stringify(name)}: ${wellFormedJson(value)}`);
  const list = (items: readonly unknown[]) => items.length === 0 ? "[]" : `[\n${items.map((item) => `    ${wellFormedJson(item)}`).join(",\n")}\n  ]`;
  return `{\n${members.join(",\n")}${ATOMS}${list(atoms)},\n  "facts": ${list(facts)}\n}\n`;
}

export type DayHead = Omit<DayDocument, "atoms" | "facts" | "coverage"> & {
  coverage: { family: string; sources: { source: string; read?: Read }[] }[];
};

const { atoms: _atoms, facts: _facts, coverage: _coverage, ...HEAD_MEMBERS } = DAY_FILE_SHAPE;
const HEAD_SHAPE = { ...HEAD_MEMBERS, coverage: [{ family: "string", sources: [{ source: "string", "read?": "read" }] }] };

export function dayHead(prefix: string): DayHead | null {
  const end = prefix.indexOf(ATOMS);
  if (!prefix.startsWith("{\n") || end < 0) return null;
  let value: Json;
  try {
    value = parse(`${prefix.slice(0, end)}\n}`);
  } catch {
    return null;
  }
  const violations: string[] = [];
  checkShape(value, HEAD_SHAPE, "$", violations, true);
  return violations.length === 0 ? value as unknown as DayHead : null;
}

function checkShape(value: unknown, shape: unknown, path: string, violations: string[], open = false): void {
  if (typeof shape === "string") {
    const ok = shape === "string" ? typeof value === "string"
      : shape === "integer" ? Number.isSafeInteger(value)
      : shape === "string|null" ? value === null || typeof value === "string"
      : shape === "integer|null" ? value === null || Number.isSafeInteger(value)
      : shape === "true" ? value === true
      : shape === "day" ? typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) && addDays(value, 0) === value
      : shape === "digest" ? typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value)
      : shape === "flag" ? (ATOM_FLAGS as readonly unknown[]).includes(value)
      : shape === "read" ? (READS as readonly unknown[]).includes(value)
      : shape === "true" ? value === true
      : shape === "role" ? (ROLES as readonly unknown[]).includes(value)
      : shape === "measure" ? (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && DECIMAL.test(value))
      : false;
    if (!ok) violations.push(`${path} is not ${shape}`);
    return;
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) {
      violations.push(`${path} is not a list`);
      return;
    }
    value.forEach((element, index) => checkShape(element, shape[0], `${path}[${index}]`, violations, open));
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    violations.push(`${path} is not an object`);
    return;
  }
  const members = shape as Record<string, unknown>;
  const object = value as Record<string, unknown>;
  if ("*" in members) {
    for (const [name, member] of Object.entries(object)) checkShape(member, members["*"], `${path}.${name}`, violations, open);
    return;
  }
  const allowed = new Set(Object.keys(members).map((name) => name.replace(/\?$/u, "")));
  if (!open) for (const name of Object.keys(object)) if (!allowed.has(name)) violations.push(`${path}.${name} is not in the shape`);
  for (const [spelled, member] of Object.entries(members)) {
    const name = spelled.replace(/\?$/u, "");
    if (!(name in object)) {
      if (!spelled.endsWith("?")) violations.push(`${path}.${name} is missing`);
      continue;
    }
    checkShape(object[name], member, `${path}.${name}`, violations, open);
  }
}

function weekday(day: string): string {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(instant(day, "date").start_ms).getUTCDay()]!;
}

function shortDay(day: string): string {
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(day.slice(5, 7)) - 1]!;
  return `${Number(day.slice(8, 10))} ${month}`;
}

function oneLine(text: string): string {
  return laid(text, undefined, "one").text;
}

function isSpace(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

function laid(text: string, names: readonly NameSpan[] | undefined, how: "lines" | "one"): { text: string; names: NameSpan[] } {
  const ends = [...new Set((names ?? []).flatMap((name) => [name.start, name.end - 1]))].sort((left, right) => left - right);
  const landed = new Map<number, number>();
  let next = 0;
  let out = "";
  let breaks = 0;
  let tail = 0;
  for (let index = 0; index < text.length;) {
    const code = text.charCodeAt(index);
    if (isSpace(code)) {
      if (how === "lines" && (code === 0x0d || code === 0x0a)) {
        if (code === 0x0d || text.charCodeAt(index - 1) !== 0x0d) breaks++;
        tail = index + 1;
      }
      index++;
      continue;
    }
    let end = index + 1;
    while (end < text.length && !isSpace(text.charCodeAt(end))) end++;
    if (out !== "") out += how === "one" ? " " : "\n".repeat(breaks) + text.slice(tail, index);
    for (; next < ends.length && ends[next]! < end; next++) if (ends[next]! >= index) landed.set(ends[next]!, out.length + ends[next]! - index);
    out += text.slice(index, end);
    index = end;
    breaks = 0;
    tail = end;
  }
  return { text: out, names: (names ?? []).map((name) => ({ start: landed.get(name.start)!, end: landed.get(name.end - 1)! + 1, who: name.who })) };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
