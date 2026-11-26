import type {
  Adapter,
  Adapters,
  Ask,
  BlobReader,
  DaySettings,
  EnrichmentRow,
  InputRecord,
  ExtractRow,
  Json,
  MessagesAdapter,
  Prompt,
  RecordRef,
  Reply,
  SourceRow,
  SourceSelector,
  Type,
  Version,
  View,
} from "@lifestreamprotocol/core";
import { accountOf, digest } from "@lifestreamprotocol/core";

export interface FamilyInput {
  sources: SourceSelector;
  kinds: string[];
  role: "evidence" | "labels";
}

export interface Change {
  record: RecordRef;
  before?: Version;
  after?: Version;
}

export interface Touched {
  unit: string;
  previous?: string;
}

export interface ReadThroughMove {
  source: string;
  before_ms: number | null;
  after_ms: number;
}

export interface Extracted {
  content: Json;
  start_ms: number | null;
  end_ms: number | null;
  reading: string;
}

export interface Plan {
  asks: Ask[];
  answers?: { item: string; content: Json }[];
  refusals?: { item: string; reason: string }[];
}

export interface Labels {
  person(id: string): PersonLabel | undefined;
  place(lat: number, lon: number, id?: string): PlaceLabel | undefined;
  nearest(lat: number, lon: number): { name: string; distance_m: number } | undefined;
  hidden?(lat: number, lon: number): boolean;
  provider?(id: string, network?: string): ProviderLabel | undefined;
  mine(camera: string, at_ms: number): boolean;
  quiet(network: string, chat: string, day: string): boolean;
}

export interface PlaceLabel { slug: string; name: string; latitude: number; longitude: number; radius_m: number }

export interface PersonLabel {
  id: string;
  name: string;
  by: "registry" | "contact" | "provider" | "push-name" | "none";
  slug: string | null;
  me: boolean;
}

export interface ProviderLabel {
  name?: string;
  archived?: true;
  pushName?: string;
  aliases?: string[];
  business?: number;
  businessName?: string;
}

export interface DayInput {
  day: string;
  settings: DaySettings;
  extracts: ExtractRow[];
  enrichments: ReadonlyMap<string, EnrichmentRow>;
  labels: Labels;
  sources: ReadonlyMap<string, SourceRow>;
  device(unit: string): string;
}

export function deviceWords(input: DayInput, units: Iterable<string>): (unit: string) => string | null {
  const several = new Set(units).size > 1;
  return (unit) => several ? input.device(unit) : null;
}

export interface NameSpan {
  start: number;
  end: number;
  who: string;
}

export interface DayLine {
  family: string;
  unit: string;
  units: string[];
  accounts?: string[];
  start_ms: number | null;
  end_ms: number | null;
  date_only?: boolean;
  text: string;
  names?: NameSpan[];
  record?: RecordRef;
  item?: string;
  block?: { key: string; title: string; names?: NameSpan[] };
  chat?: string;
  pictures?: number;
  type?: Type;
  heading?: true;
  video?: { duration_ms: number | null };
  live?: true;
  joins?: RecordRef;
}


export const OPS = ["sum", "avg", "min", "max", "first", "last"] as const;
export type Op = (typeof OPS)[number];

export interface Measure {
  unit: string;
  ops: readonly Op[];
  time: "start" | "end";
  split: "clock" | "whole";
  copies?: string;
  readings?: readonly string[];
  from: "stated" | "derived" | "model";
}

export interface Collection {
  keys: readonly string[];
  measures: Readonly<Record<string, Measure>>;
  about?: string;
}

export type Role = "sender" | "receiver" | "attendee";

export interface DayFact {
  of: string;
  id: string;
  time_ms: number;
  start_ms: number;
  end_ms: number;
  date_only?: true;
  keys: Readonly<Record<string, string>>;
  measures: Readonly<Record<string, number | string>>;
  who: readonly { handle: string; role: Role }[];
  from: FactFrom;
  lines: readonly number[];
}

export interface FactFrom {
  units: string[];
  accounts?: string[];
  record?: RecordRef;
  alone?: true;
  item?: string;
  instrument?: string;
}

export interface DayProjection {
  lines: DayLine[];
  facts: DayFact[];
}

export function factId(of: string, what: string): string {
  return `${of}:${digest(what).slice(7, 31)}`;
}

export function collectionsFault(families: readonly Family[]): string[] {
  const faults: string[] = [];
  const owner = new Map<string, string>();
  const declared = new Map<string, Measure>();
  for (const family of families) {
    for (const [of, collection] of Object.entries(family.collections ?? {})) {
      if (new Set(collection.keys).size !== collection.keys.length) faults.push(`${family.name}'s ${of} names a key twice`);
      for (const [name, measure] of Object.entries(collection.measures)) {
        const path = `${of}.${name}`;
        const other = owner.get(path);
        if (other !== undefined) faults.push(`${path} is stated by ${other} and ${family.name}`);
        owner.set(path, family.name);
        declared.set(path, measure);
        if (measure.ops.some((op) => !OPS.includes(op)) || new Set(measure.ops).size !== measure.ops.length) faults.push(`${path} permits an op not in OPS, or one twice`);
        if (measure.unit === "currency" && measure.split !== "whole") faults.push(`${path} is a currency split by the clock`);
      }
    }
  }
  for (const [path, measure] of declared) {
    for (const reading of measure.readings ?? []) {
      if (reading === path) faults.push(`${path} names itself a reading`);
      else if (!declared.has(reading)) faults.push(`${path} names ${reading}, which no family declares`);
      else if (!(declared.get(reading)!.readings ?? []).includes(path)) faults.push(`${reading} does not name ${path} back as a reading`);
    }
  }
  return faults;
}

export function accountsOf(sources: Iterable<string>): string[] {
  return [...new Set([...sources].map(accountOf))].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function restsAlone(units: readonly string[], onRecord: boolean): boolean {
  return onRecord && units.length === 1;
}

export function drawnFrom(units: readonly string[], records: readonly RecordRef[], alsoFrom: readonly string[] = []): { accounts?: string[] } {
  const one = alsoFrom.length === 0 && new Set(records.map(({ source, kind, key }) => `${source}\0${kind}\0${key}`)).size === 1;
  return restsAlone(units, one) ? {} : { accounts: accountsOf([...records.map(({ source }) => source), ...alsoFrom]) };
}

export function statingAccounts(projection: DayProjection, sourcesOf: (unit: string) => Iterable<string>): DayProjection {
  const of = (units: readonly string[]) => accountsOf(units.flatMap((unit) => [...sourcesOf(unit)]));
  const stated = (accounts: string[]) => (accounts.length === 0 ? {} : { accounts });
  return {
    lines: projection.lines.map((line) => line.accounts !== undefined || restsAlone(line.units, line.record !== undefined) ? line : { ...line, ...stated(of(line.units)) }),
    facts: projection.facts.map((fact) => fact.from.accounts !== undefined || restsAlone(fact.from.units, fact.from.alone === true) ? fact : { ...fact, from: { ...fact.from, ...stated(of(fact.from.units)) } }),
  };
}

export function linesOnly(lines: (input: DayInput) => DayLine[]): (input: DayInput) => DayProjection {
  return (input) => ({ lines: lines(input), facts: [] });
}

export interface RecordText {
  title?: string;
  text: string;
  who?: string[];
  link?: string;
}

export interface RecordRead {
  title?: string;
  text: string;
  from?: string | null;
  to?: string[];
  who?: string[];
  link?: string;
}

export interface FamilyRead {
  of(record: RecordRef, version: Version, files: BlobReader, view: View): RecordRead | null;
}

export interface FamilyText {
  version: string;
  kinds: readonly string[];
  of(record: RecordRef, version: Version, files: BlobReader, view: View): RecordText | null;
  follows?: readonly {
    readonly sources: SourceSelector;
    readonly kinds: readonly string[];
    moved(changes: readonly Change[], view: View): RecordRef[];
  }[];
}

export interface Given<A extends Adapter = Adapter> {
  product: string;
  name: string;
  vendor: string;
  type: Type | null;
  adapter: A;
  digest?: string;
}

export function kindsRead(adapter: Adapter): readonly string[] {
  return [...adapter.kinds, ...((adapter as Partial<MessagesAdapter>).labels?.kinds ?? [])];
}

export type Fed = { readonly [K in keyof Adapters]-?: readonly Given<NonNullable<Adapters[K]>>[] };

export type Maker<A extends Adapter> = (given: readonly Given<A>[]) => Family;

export type Makers = { readonly [K in keyof Adapters]-?: Maker<NonNullable<Adapters[K]>> };

export function made(makers: Makers, fed: Fed): Family[] {
  return (Object.keys(makers) as (keyof Adapters)[]).map((key) => {
    const given = fed[key] as readonly Given[];
    const family = (makers[key] as Maker<Adapter>)(given);
    if (family.name !== (key === "line" ? "plain" : key)) throw new TypeError(`the family listed for ${key}'s adapters is named ${family.name}`);
    return { ...family, adapters: given };
  });
}

export function fedNone(): Fed {
  return {
    messages: [], mail: [], ai: [], calls: [], callaudio: [], calendar: [], notes: [], listening: [], health: [], money: [], photos: [], physical: [],
    web: [], voice: [], phone: [], screen: [], labels: [], line: [],
  };
}

export interface Family {
  name: string;
  type: Type | null;
  code: string;
  inputs: FamilyInput[];
  touched(changes: readonly Change[], view: View): Touched[];
  extract(unit: string, view: View, files: BlobReader): Extracted | null;
  days(extract: ExtractRow, settings: DaySettings): string[];
  plan?(extract: ExtractRow, answered: ReadonlyMap<string, Reply>, given_up?: ReadonlySet<string>): Plan;
  prompts?: Readonly<Record<string, Prompt>>;
  readers?: Readonly<Record<string, (value: Json) => string | null>>;
  works?: Readonly<Record<string, SourceSelector>>;
  readThrough?(move: ReadThroughMove, view: View): string[];
  items?(extract: ExtractRow): { item: string; prompt: string }[];
  day(input: DayInput): DayProjection;
  collections?: Readonly<Record<string, Collection>>;
  replicas?(thing: string, view: View, labels: Labels): { records: RecordRef[]; items: string[] };
  adapters?: readonly Given[];
  borrowed?: Partial<Fed>;
  text?: FamilyText;
  read?: FamilyRead;
}

export interface Stated<A extends Adapter = Adapter> {
  readonly adapter: A;
  readonly member: string;
  readonly record: InputRecord | null;
  readonly value: unknown;
}

export type StatedFaults<A extends Adapter = Adapter> = (stated: Stated<A>) => string[];

export function quoted(value: unknown): string {
  return `\`${typeof value === "string" ? value : JSON.stringify(value) ?? String(value)}\``;
}
