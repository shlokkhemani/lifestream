import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  addDays, civilDay, dayBounds, daysOf, digest, sourceName,
  type DaySettings, type EnrichmentRow, type ExtractRow, type Json, type SourceRow,
} from "@lifestreamprotocol/core";
import {
  checkDayFile, DAY_FILE_SHAPE, dayHead, DayLineError, DayReadError, RENDERER_VERSION, renderDay,
  type DayAtom, type DayDocument, type DayReader, type RenderedDay, tableUnits,
} from "./days.js";
import { linesOnly, type DayLine, type Family } from "./family.js";
import { chatTitle, nameParty, printed } from "./shared/cast.js";
import { buildLabels, type DayLabels } from "./shared/labels.js";
import { cardParts, readCard, type RecordState } from "./shared/people.js";
import { bySourceOrder, chooseReplicas } from "./shared/replicas.js";
import { SYNTHETIC_VENDOR } from "./test/drive.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, "test");
const UPDATE = process.env.LIFESTREAM_UPDATE_GOLDEN === "1"
const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const FIRST = "2026-10-20";
const DAYS = Array.from({ length: 30 }, (_, index) => addDays(FIRST, index));
const GOLDEN_DAYS = ["2026-10-25", "2026-10-31", "2026-11-10"];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SOURCE_ORDER = ["whatsapp:15550000000:phone-aa01", "whatsapp:15550000000:mac-0001"];


interface Message { source: string; key: string; at_ms: number; from: string; text: string; image?: string }
interface ChatContent { chat: string; group: boolean; name: string | null; messages: Message[] }
interface Sample { key: string; metric: "rate" | "sleep"; start_ms: number; end_ms: number | null; value: number }
interface Entry { key: string; date: string | null; days: number; since_ms: number; text: string }

const notUsed = { touched: () => [], extract: () => null };

const chat: Family = {
  name: "chat",
  type: "messages",
  code: "1",
  inputs: [
    { sources: { product: ["whatsapp"] }, kinds: ["msg"], role: "evidence" },
    { sources: { product: ["apple-contacts"] }, kinds: ["contact"], role: "labels" },
    { sources: { product: ["people"] }, kinds: ["person"], role: "labels" },
  ],
  ...notUsed,
  days: (extract, settings) => daysOf({ start_ms: extract.start_ms!, end_ms: extract.end_ms! + 1, precision: "ms" }, settings),
  items: (extract) => (extract.content as unknown as ChatContent).messages
    .flatMap((message) => message.image === undefined ? [] : [{ item: message.image, prompt: "caption-v1" }]),
  day: linesOnly((input) => {
    return input.extracts.flatMap((extract) => {
      const content = extract.content as unknown as ChatContent;
      const party = (from: string) => nameParty({ id: from, kind: from === "me" ? "me" : "phone" }, input.labels);
      const title = chatTitle({ id: content.chat, group: content.group, name: content.name },
        content.group ? content.messages.map((message) => party(message.from)) : [party(content.chat)]);
      return content.messages.map((message): DayLine => {
        const caption = message.image === undefined ? undefined : input.enrichments.get(message.image);
        const photo = message.image === undefined ? ""
          : caption?.state === "done" ? ` [photo: ${(caption.content as { caption: string }).caption}]` : " [photo, caption pending]";
        return {
          family: "chat", unit: extract.unit, units: [extract.unit], start_ms: message.at_ms, end_ms: null,
          ...printed`${party(message.from)}: ${message.text}${photo}`,
          record: { source: message.source, kind: "msg", key: message.key },
          block: { key: content.chat, title: title.text, names: title.names },
        };
      });
    });
  }),
};

const LOOKBACK = 3;

function vitalsFamily(lookback: number): Family {
  return {
    name: "vitals",
    type: "health",
    code: "1",
    inputs: [{ sources: { product: ["apple-health"] }, kinds: ["sample"], role: "evidence" }],
    ...notUsed,
    days: (extract, settings) => [...new Set(daysOf({ start_ms: extract.start_ms!, end_ms: extract.end_ms! + 1, precision: "ms" }, settings)
      .flatMap((day) => Array.from({ length: lookback + 1 }, (_, after) => addDays(day, after))))].sort(),
    day: linesOnly((input) => {
      const samples = input.extracts.flatMap((extract) => (extract.content as unknown as { samples: Sample[] }).samples
        .map((sample) => ({ sample, unit: extract.unit })));
      const lines = samples.map(({ sample, unit }): DayLine => ({
        family: "vitals", unit, units: [unit], start_ms: sample.start_ms, end_ms: sample.end_ms,
        text: sample.metric === "sleep" ? "Asleep" : `Heart rate ${sample.value}`,
        record: { source: "apple-health:person-a@example.com:watch-aa07", kind: "sample", key: sample.key },
      }));
      const today = dayBounds(input.day, input.settings);
      const from = dayBounds(addDays(input.day, -LOOKBACK), input.settings).start_ms;
      const rates = (start: number, end: number) => samples.map(({ sample }) => sample)
        .filter((sample) => sample.metric === "rate" && sample.start_ms >= start && sample.start_ms < end).map((sample) => sample.value);
      const now = rates(today.start_ms, today.end_ms);
      const before = rates(from, today.start_ms);
      if (now.length > 0) {
        lines.push({
          family: "vitals", unit: `vitals/${input.day}`, units: [...new Set(samples.filter(({ sample }) => sample.metric === "rate" && sample.start_ms >= today.start_ms && sample.start_ms < today.end_ms)
            .map(({ unit }) => unit))], start_ms: null, end_ms: null, heading: true,
          text: `Heart rate ${mean(now)} today against ${before.length === 0 ? "no earlier days" : `${mean(before)} over the ${LOOKBACK} days before`}`,
        });
      }
      return lines;
    }),
  };
}
const vitals = vitalsFamily(LOOKBACK);

const ledger: Family = {
  name: "ledger",
  type: "money",
  code: "1",
  inputs: [{ sources: { product: ["example-bank"] }, kinds: ["line"], role: "evidence" }, { sources: { product: ["apple-notes"] }, kinds: ["note"], role: "evidence" }],
  ...notUsed,
  days: (extract, settings) => extract.start_ms === null
    ? [civilDay((extract.content as unknown as Entry).since_ms, settings)]
    : daysOf({ start_ms: extract.start_ms, end_ms: extract.end_ms!, precision: "day" }, settings),
  day: linesOnly((input) => input.extracts.map((extract): DayLine => {
    const entry = extract.content as unknown as Entry;
    return {
      family: "ledger", unit: extract.unit, units: [extract.unit], start_ms: extract.start_ms, end_ms: extract.end_ms,
      ...(entry.date === null ? {} : { date_only: true }),
      text: entry.text, record: { source: entry.date === null ? "apple-notes:local:mac-0001" : "example-bank:acct-aa11:export", kind: entry.date === null ? "note" : "line", key: entry.key },
    };
  })),
};

const FAMILIES = [chat, vitals, ledger];


type Fact =
  | { kind: "message"; at: number; chat: string; group: boolean; name: string | null; message: Message }
  | { kind: "sample"; at: number; sample: Sample }
  | { kind: "entry"; at: number; entry: Entry }
  | { kind: "caption"; at: number; item: string; caption: string }
  | { kind: "read"; at: number; source: string; read_through_ms: number };

function facts(seed: number): Fact[] {
  const random = mulberry32(seed);
  const pick = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
  const out: Fact[] = [];
  let serial = 0;
  for (const day of [addDays(FIRST, -1), ...DAYS, addDays(DAYS.at(-1)!, 1)]) {
    const { start_ms, end_ms } = dayBounds(day, SETTINGS);
    for (const [chatId, group, name, people] of [
      ["+15550000001", false, null, ["+15550000001", "me"]],
      ["group-alpha", true, "Group Alpha", ["+15550000002", "+15550000003", "me"]],
    ] as const) {
      for (let count = pick(3, 6); count > 0; count--) {
        const at = start_ms + pick(0, Math.floor((end_ms - start_ms) / MINUTE) - 1) * MINUTE;
        const key = `m${++serial}`;
        const image = random() < 0.3 ? `sha256:${digest(key).slice(7, 71)}` : undefined;
        const message: Message = { source: "", key, at_ms: at, from: people[pick(0, people.length - 1)]!, text: `message ${serial}`, ...(image === undefined ? {} : { image }) };
        const replicas = random() < 0.4 ? SOURCE_ORDER : [SOURCE_ORDER[pick(0, 1)]!];
        for (const source of replicas) out.push({ kind: "message", at: at + pick(0, 20) * MINUTE, chat: chatId, group, name, message: { ...message, source } });
        if (image !== undefined) {
          out.push({ kind: "caption", at: at + pick(3, 600) * MINUTE, item: image, caption: `a synthetic picture ${serial}` });
        }
        out.push({ kind: "read", at: at + 21 * MINUTE, source: replicas[0]!, read_through_ms: at + 20 * MINUTE });
      }
    }
    for (let count = 4; count > 0; count--) {
      const at = start_ms + pick(0, 23 * 60) * MINUTE;
      const landed = at + pick(0, 90) * MINUTE;
      out.push({ kind: "sample", at: landed, sample: { key: `s${++serial}`, metric: "rate", start_ms: at, end_ms: null, value: pick(52, 80) } });
      out.push({ kind: "read", at: landed, source: "apple-health:person-a@example.com:watch-aa07", read_through_ms: landed });
    }
    if (DAYS.indexOf(day) % 3 === 0) {
      out.push({ kind: "entry", at: end_ms + pick(1, 48) * HOUR, entry: { key: `b${++serial}`, date: day, days: 1, since_ms: end_ms, text: `-${pick(1, 900)}.00 USD to shop ${serial}` } });
    }
  }
  const sleepStart = dayBounds("2026-10-25", SETTINGS).start_ms - 2 * HOUR;
  out.push({ kind: "sample", at: sleepStart + 9 * HOUR, sample: { key: "sleep-1", metric: "sleep", start_ms: sleepStart, end_ms: sleepStart + 270 * MINUTE, value: 0 } });
  out.push({ kind: "entry", at: Date.parse("2026-11-08T12:00:00Z"), entry: { key: "stay-1", date: "2026-11-05", days: 3, since_ms: Date.parse("2026-11-08T12:00:00Z"), text: "Hotel stay, 3 nights" } });
  out.push({ kind: "entry", at: Date.parse("2026-11-10T15:00:00Z"), entry: { key: "note-1", date: null, days: 0, since_ms: Date.parse("2026-11-10T15:00:00Z"), text: "A note that states no time" } });
  for (const fact of out) if (random() < 0.1) fact.at += pick(1, 72) * HOUR;
  return out.sort((left, right) => left.at - right.at);
}


class Home {
  readonly extracts = new Map<string, ExtractRow>();
  readonly enrichments = new Map<string, EnrichmentRow>();
  readonly sources = new Map<string, SourceRow>();
  readonly files = new Map<string, RenderedDay>();
  readonly messages = new Map<string, Fact & { kind: "message" }>();
  readonly samples = new Map<string, Sample>();
  readonly entries = new Map<string, Entry>();
  renders = 0;
  writes = 0;
  #seq = 0;

  constructor(readonly families: readonly Family[], public labels: DayLabels, readonly out: string | null = null) {
    for (const id of ["whatsapp:15550000000:mac-0001", "whatsapp:15550000000:phone-aa01", "apple-health:person-a@example.com:watch-aa07", "example-bank:acct-aa11:export", "apple-notes:local:mac-0001", "apple-contacts:local:mac-0001", "people:local:mac-0001"]) {
      this.sources.set(id, { id, ...sourceName(id), vendor: SYNTHETIC_VENDOR, connector: "synthetic", options: {}, read_through_ms: null, added_ms: 0 });
    }
  }

  reader(): DayReader {
    return {
      extractsOn: (family, day) => [...this.extracts.values()].filter((row) => row.family === family && row.days.includes(day)),
      enrichment: (family, item, prompt) => this.enrichments.get(`${family}\0${item}\0${prompt}`),
      sources: () => [...this.sources.values()],
      since: () => Number.MIN_SAFE_INTEGER,
    };
  }

  land(fact: Fact): void {
    if (fact.kind === "read") {
      const source = this.sources.get(fact.source)!;
      const before = source.read_through_ms;
      if (before !== null && before >= fact.read_through_ms) return;
      source.read_through_ms = fact.read_through_ms;
      this.render(daysOf({ start_ms: before ?? fact.read_through_ms, end_ms: fact.read_through_ms + 1, precision: "ms" }, SETTINGS));
      return;
    }
    if (fact.kind === "caption") {
      const key = `chat\0${fact.item}\0caption-v1`;
      if (this.enrichments.has(key)) return;
      this.enrichments.set(key, {
        family: "chat", item: fact.item, prompt: "caption-v1", input_hash: digest(fact.item), reply_key: null, reused_from: null,
        content: { caption: fact.caption }, state: "done",
      });
      this.render([...this.extracts.values()].filter((row) => row.family === "chat" && chat.items!(row).some((entry) => entry.item === fact.item)).flatMap((row) => row.days));
      return;
    }
    if (fact.kind === "message") {
      this.messages.set(`${fact.message.source}\0${fact.message.key}`, fact);
      this.rebuild(chat, `${fact.chat}/${new Date(fact.message.at_ms).toISOString().slice(0, 10)}`);
    } else if (fact.kind === "sample") {
      this.samples.set(fact.sample.key, fact.sample);
      this.rebuild(vitals, `vitals/${new Date(fact.sample.start_ms).toISOString().slice(0, 10)}`);
    } else {
      this.entries.set(fact.entry.key, fact.entry);
      this.rebuild(ledger, `ledger/${fact.entry.key}`);
    }
  }

  relabel(labels: DayLabels): void {
    this.labels = labels;
    this.render(DAYS);
  }

  touch(days: readonly string[]): void {
    this.render(days);
  }

  renderAll(families: readonly Family[] = this.families): Map<string, RenderedDay> {
    return new Map(DAYS.map((day) => [day, renderDay(day, families, this.reader(), SETTINGS, tableUnits(this.labels))]));
  }

  private rebuild(family: Family, unit: string): void {
    const built = this.extract(family, unit);
    const key = `${family.name}\0${unit}`;
    const before = this.extracts.get(key);
    if (before !== undefined && before.reading === built.reading && before.code === family.code) return;
    const row: ExtractRow = { family: family.name, unit, code: family.code, seq: ++this.#seq, days: [], ...built };
    row.days = family.days(row, SETTINGS);
    this.extracts.set(key, row);
    this.render([...(before?.days ?? []), ...row.days]);
  }

  private extract(family: Family, unit: string): Pick<ExtractRow, "content" | "start_ms" | "end_ms" | "reading"> {
    let content: Json;
    let start_ms: number | null;
    let end_ms: number | null;
    if (family.name === "chat") {
      const [chatId, date] = unit.split("/") as [string, string];
      const copies = [...this.messages.values()].filter((fact) => fact.chat === chatId && new Date(fact.message.at_ms).toISOString().slice(0, 10) === date);
      const chosen = chooseReplicas(copies.map((fact) => fact.message), {
        same: (message) => message.key, prefer: bySourceOrder(SOURCE_ORDER), id: (message) => `${message.source}\0${message.key}`,
      }).map((group) => group.chosen).sort((left, right) => left.at_ms - right.at_ms || compare(left.key, right.key));
      const first = copies[0]!;
      content = { chat: chatId, group: first.group, name: first.name, messages: chosen } as unknown as Json;
      start_ms = chosen[0]!.at_ms;
      end_ms = chosen.at(-1)!.at_ms;
    } else if (family.name === "vitals") {
      const date = unit.slice("vitals/".length);
      const samples = [...this.samples.values()].filter((sample) => new Date(sample.start_ms).toISOString().slice(0, 10) === date)
        .sort((left, right) => left.start_ms - right.start_ms || compare(left.key, right.key));
      content = { samples } as unknown as Json;
      start_ms = samples[0]!.start_ms;
      end_ms = Math.max(...samples.map((sample) => sample.end_ms ?? sample.start_ms));
    } else {
      const entry = this.entries.get(unit.slice("ledger/".length))!;
      content = entry as unknown as Json;
      start_ms = entry.date === null ? null : Date.parse(`${entry.date}T00:00:00Z`);
      end_ms = start_ms === null ? null : start_ms + entry.days * DAY;
    }
    return { content, start_ms, end_ms, reading: digest(content) };
  }

  private render(days: readonly string[]): void {
    for (const day of new Set(days)) {
      if (!DAYS.includes(day)) continue;
      const rendered = renderDay(day, this.families, this.reader(), SETTINGS, tableUnits(this.labels));
      this.renders++;
      if (this.files.get(day)?.inputs === rendered.inputs) continue;
      this.files.set(day, rendered);
      this.writes++;
      if (this.out !== null) writeDay(this.out, day, rendered);
    }
  }
}

const person = (slug: string, name: string, phone: string): RecordState => ({
  record: {
    slug, name, full_name: null, show: "name", entity: "person", relationship: null, hidden: false, me: false,
    anchor: { kind: "phone", value: phone }, handles: [], excluded: [], dismissed: [], merged_into: null, also_called: [],
  },
  since: new Map(), me_since: null, merged_since: null,
});

function labels(personA = "Person A", extra = "", more: RecordState[] = []): DayLabels {
  const card = readCard({ source: "apple-contacts:local:iphone-aa01", key: "card-a" }, 0,
    cardParts({ type: "contacts.card", card: `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${personA}\r\nTEL;TYPE=CELL:+1 (555) 000-0001\r\n${extra}END:VCARD\r\n` })!);
  return buildLabels({
    people: [person("person-b", "Person B", "+15550000002"), ...more],
    contacts: [card],
    places: [],
  });
}

function namesSaid(atoms: readonly DayAtom[]): [string, string][][] {
  return atoms.map((atom) => [...(atom.names ?? []).map(({ start, end, who }): [string, string] => [atom.text.slice(start, end), who]),
    ...(atom.block?.names ?? []).map(({ start, end, who }): [string, string] => [atom.block!.title.slice(start, end), who])]);
}

function withoutNames(atoms: readonly DayAtom[]): DayAtom[] {
  return atoms.map(({ names: _names, ...atom }) => atom.block === undefined ? atom : { ...atom, block: { key: atom.block.key, title: atom.block.title } });
}

function landAll(home: Home, list: readonly Fact[]): Home {
  for (const fact of list) home.land(fact);
  return home;
}


const FILES = [["day.json", "json"], ["day.txt", "txt"], ["day.lines.json", "lines"]] as const;

function writeDay(out: string, day: string, rendered: RenderedDay): void {
  for (const [suffix, member] of FILES) writeFileSync(join(out, `${day}.${suffix}`), rendered[member]);
}

function readDay(out: string, day: string): Record<"json" | "txt" | "lines", string> {
  return Object.fromEntries(FILES.map(([suffix, member]) => [member, readFileSync(join(out, `${day}.${suffix}`), "utf8")])) as Record<"json" | "txt" | "lines", string>;
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    if (process.env.LIFESTREAM_KEEP_ARTIFACTS === "1") console.log(`days artifact kept: ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
  }
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "families-days-"));
  temps.push(dir);
  return dir;
}

function golden(name: string, text: string): void {
  const path = join(GOLDEN, name);
  if (UPDATE) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  expect(existsSync(path), `${path} is missing; run with LIFESTREAM_UPDATE_GOLDEN=1`).toBe(true);
  expect(text).toBe(readFileSync(path, "utf8"));
}


describe("days: what must be impossible", () => {
  it("a day file differs byte for byte from renderDay of its inputs", () => {
    const out = temp();
    const home = landAll(new Home(FAMILIES, labels(), out), facts(7));
    const now = home.renderAll();
    for (const day of DAYS) {
      const written = readDay(out, day);
      const fresh = now.get(day)!;
      expect(written.json, `${day}.day.json`).toBe(fresh.json);
      expect(written.txt, `${day}.day.txt`).toBe(fresh.txt);
      expect(written.lines, `${day}.day.lines.json`).toBe(fresh.lines);
      expect(JSON.parse(written.json).inputs).toBe(fresh.inputs);
    }
    expect(home.renderAll()).toEqual(now);
    const writes = home.writes;
    home.touch(DAYS);
    expect(home.writes).toBe(writes);
    writeFileSync(join(out, "loop.json"), `${JSON.stringify({ renders: home.renders, writes: home.writes, days: DAYS.length })}\n`);
  });

  it("a timeless record lands on 1970-01-01", () => {
    const out = temp();
    const home = landAll(new Home(FAMILIES, labels(), out), facts(7));
    const listed = new Set([...home.extracts.values()].flatMap((row) => row.days));
    expect(listed.has("1970-01-01")).toBe(false);
    expect([...listed].every((day) => day >= "2026-01-01")).toBe(true);
    expect(readdirSync(out).some((name) => name.startsWith("1970"))).toBe(false);
    const day = civilDay(Date.parse("2026-11-10T15:00:00Z"), SETTINGS);
    const document = JSON.parse(readDay(out, day).json) as DayDocument;
    const note = document.atoms.find((atom) => atom.unit === "ledger/note-1")!;
    expect(note).toMatchObject({ start_ms: null, end_ms: null, local_start: null, flags: ["no_time"] });
    const txt = readDay(out, day).txt.split("\n");
    expect(txt.indexOf("A note that states no time")).toBeGreaterThan(txt.indexOf("No time stated"));
    const stay = ["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"].map((date) =>
      readDay(out, date).txt.split("\n").find((line) => line.startsWith("Hotel stay")) ?? null);
    expect(stay).toEqual([null, "Hotel stay, 3 nights (continues into 6 Nov)",
      "Hotel stay, 3 nights (continues from 5 Nov) (continues into 7 Nov)", "Hotel stay, 3 nights (continues from 6 Nov)", null]);
    for (const name of readdirSync(out).filter((file) => file.endsWith(".day.json"))) {
      for (const atom of (JSON.parse(readFileSync(join(out, name), "utf8")) as DayDocument).atoms) {
        expect(atom.start_ms === null || atom.start_ms > Date.parse("2000-01-01T00:00:00Z")).toBe(true);
        expect(atom.local_start?.startsWith("1970") ?? false).toBe(false);
      }
    }
    const unix = JSON.parse(renderDay("1970-01-01", FAMILIES, home.reader(), SETTINGS, tableUnits(home.labels)).json) as DayDocument;
    expect(unix.atoms).toEqual([]);
    const broken: Family = { ...ledger, day: (input) => ({ ...ledger.day(input), lines: ledger.day(input).lines.map((line) => ({ ...line, date_only: true as const, start_ms: null, end_ms: null })) }) };
    expect(() => renderDay(day, [chat, vitals, broken], home.reader(), SETTINGS, tableUnits(home.labels))).toThrow(DayLineError);
  });

  it("no family states a line with an empty list of accounts: the render refuses it", () => {
    const home = landAll(new Home(FAMILIES, labels(), temp()), facts(7));
    const day = civilDay(Date.parse("2026-11-10T15:00:00Z"), SETTINGS);
    const unstated: Family = { ...ledger, day: (input) => ({ ...ledger.day(input), lines: ledger.day(input).lines.map((line) => ({ ...line, accounts: [] })) }) };
    expect(() => renderDay(day, [chat, vitals, unstated], home.reader(), SETTINGS, tableUnits(home.labels))).toThrow(/states accounts that are no list of accounts/u);
  });

  it("the day-file shape changes under a renderer version already pinned to another", () => {
    const SHAPES: Record<string, string> = {
      "9": "sha256:c6df479c1d18596b73fd121c1a9ebdec1e1797aad1b6533807f6c1155769b8da",
      "10": "sha256:51af375348f4e67f11909c45a0253e9586a6544145a10b1b3efdca785ef15eca",
      "11": "sha256:1a085e9ac0e2a74ccb4f21694daf37f5e09d65b0172beb77fea02863fbb902ad",
      "12": "sha256:b97e09b76041834cce7522f8801cfb4700c099b54895d3829bf6a5ac451ff289",
      "13": "sha256:8a5edeb87c468da007af35eaeac7b10d99fb81450892b3343bfbed45eb22c424",
      "14": "sha256:33056fff9127a44a0c94b7a3653e88ee8ab6e6aa74bb7c603a83f841d3c11ca0",
    };
    const version = RENDERER_VERSION.split("/")[0]!;
    expect(digest(DAY_FILE_SHAPE as unknown as Json), `renderer ${version}'s day-file shape`).toBe(SHAPES[version]);
  });

  it("the day-file shape drifts from its pinned schema", () => {
    const out = temp();
    const home = landAll(new Home(FAMILIES, labels(), out), facts(7));
    golden("day-file.shape.json", `${JSON.stringify(DAY_FILE_SHAPE, null, 2)}\n`);
    for (const day of DAYS) {
      const files = readDay(out, day);
      const document = JSON.parse(files.json) as DayDocument;
      expect(checkDayFile(document), day).toEqual([]);
      const printed = files.txt.split("\n");
      expect(printed.pop()).toBe("");
      const index = JSON.parse(files.lines) as number[][];
      expect(index.length).toBe(printed.length);
      const cited = new Set(index.flat());
      expect([...cited].every((n) => n >= 1 && n <= document.atoms.length)).toBe(true);
      expect(cited.size).toBe(document.atoms.length);
      expect(printed[0]).toMatch(new RegExp(`^Day ${day} \\(\\w+day\\) in America/New_York, `));
      expect(printed[1]).toMatch(/^\d+ atoms: chat \d+, ledger \d+, vitals \d+$/u);
      expect(printed.slice(-4)).toEqual([
        "Coverage",
        expect.stringMatching(/^chat: whatsapp:15550000000:mac-0001 (?:read through the day|read into the day|not read into the day); whatsapp:15550000000:phone-aa01 /u),
        expect.stringMatching(/^ledger: apple-notes:local:mac-0001 .*; example-bank:acct-aa11:export /u),
        expect.stringMatching(/^vitals: apple-health:person-a@example.com:watch-aa07 /u),
      ]);
    }
    const document = JSON.parse(readDay(out, DAYS[3]!).json) as Record<string, unknown> & DayDocument;
    expect(checkDayFile({ ...document, extra: 1 })).toEqual(["$.extra is not in the shape"]);
    const { coverage: _coverage, ...missing } = document;
    expect(checkDayFile(missing)).toEqual(["$.coverage is missing"]);
    const flagged = { ...document, atoms: document.atoms.map((atom, index) => index === 0 ? { ...atom, flags: ["split"] } : atom) };
    expect(checkDayFile(flagged)).toEqual(["$.atoms[0].flags[0] is not flag"]);
    const unread = { ...document, coverage: document.coverage.map((family) => ({ ...family, sources: family.sources.map(({ source }) => ({ source })) })) };
    expect(checkDayFile(unread)[0]).toBe("$.coverage[0].sources[0].read is missing");
    const json = readDay(out, DAYS[3]!).json;
    const old = json.replace(/"read":"(?:none|into|through)"/gu, '"read_ms":1');
    expect(old).not.toBe(json);
    expect(dayHead(old)?.coverage).toEqual(document.coverage.map((family) => ({ ...family, sources: family.sources.map(({ source }) => ({ source, read_ms: 1 })) })));
    expect(dayHead(json)?.coverage).toEqual(document.coverage);
    expect(dayHead(json.replace(/"read":"(?:none|into|through)"/u, '"read":"half"'))).toBeNull();
    for (const day of GOLDEN_DAYS) {
      const files = home.files.get(day)!;
      golden(`days/${day}.day.json`, files.json);
      golden(`days/${day}.day.txt`, files.txt);
      golden(`days/${day}.day.lines.json`, files.lines);
    }
  });

  it("renderDay reads outside days()", () => {
    const home = landAll(new Home(FAMILIES, labels(), temp()), facts(7));
    const day = "2026-10-26";
    const reads: string[] = [];
    const base = home.reader();
    const recording: DayReader = {
      extractsOn: (family, asked) => {
        reads.push(`extracts ${family} ${asked}`);
        return [...base.extractsOn(family, asked)];
      },
      enrichment: (family, item, prompt) => {
        reads.push(`enrichment ${family} ${item} ${prompt}`);
        return base.enrichment(family, item, prompt);
      },
      sources: base.sources,
      since: base.since,
    };
    renderDay(day, FAMILIES, recording, SETTINGS, tableUnits(home.labels));
    expect(reads.filter((read) => read.startsWith("extracts"))).toEqual([`extracts chat ${day}`, `extracts ledger ${day}`, `extracts vitals ${day}`]);
    const items = new Set([...base.extractsOn("chat", day)].flatMap((row) => chat.items!(row).map((entry) => entry.item)));
    for (const read of reads.filter((entry) => entry.startsWith("enrichment"))) expect(items.has(read.split(" ")[2]!)).toBe(true);
    const stray = [...home.extracts.values()].find((row) => row.family === "chat" && !row.days.includes(day))!;
    const leaky: DayReader = { ...base, extractsOn: (family, asked) => [...base.extractsOn(family, asked), ...(family === "chat" ? [stray] : [])] };
    expect(() => renderDay(day, FAMILIES, leaky, SETTINGS, tableUnits(home.labels))).toThrow(DayReadError);
    const stale = [...base.extractsOn("vitals", day)].filter((row) => !vitalsFamily(1).days(row, SETTINGS).includes(day)).map((row) => row.unit);
    expect(stale.length).toBeGreaterThan(0);
    const narrowed = JSON.parse(renderDay(day, [chat, vitalsFamily(1), ledger], base, SETTINGS, tableUnits(home.labels)).json) as DayDocument;
    expect(narrowed.atoms.filter((atom) => atom.units.some((unit) => stale.includes(unit)))).toEqual([]);
    writeFileSync(join(temps.at(-1)!, "reads.json"), `${JSON.stringify(reads, null, 2)}\n`);
  });

  it("a read-through moving within the day changes the day's inputs", () => {
    const home = landAll(new Home(FAMILIES, labels(), temp()), facts(7));
    const day = "2026-10-26";
    const { start_ms, end_ms } = dayBounds(day, SETTINGS);
    const source = home.sources.get("whatsapp:15550000000:mac-0001")!;
    const at = (read_through_ms: number) => {
      source.read_through_ms = read_through_ms;
      const document = JSON.parse(renderDay(day, FAMILIES, home.reader(), SETTINGS, tableUnits(home.labels)).json) as DayDocument;
      const read = document.coverage.find((each) => each.family === "chat")!.sources.find((each) => each.source === source.id)!.read;
      return { inputs: document.inputs, read };
    };
    const into = at(start_ms + 10 * HOUR);
    expect(into.read).toBe("into");
    expect(at(start_ms + 10 * HOUR + MINUTE)).toEqual(into);
    expect(at(end_ms - 1)).toEqual(into);
    expect(at(start_ms)).toEqual(into);
    const before = at(start_ms - 1);
    expect(before.read).toBe("none");
    expect(before.inputs).not.toBe(into.inputs);
    const through = at(end_ms);
    expect(through.read).toBe("through");
    expect(through.inputs).not.toBe(into.inputs);
    expect(through.inputs).not.toBe(before.inputs);
  });

  it("a renamed contact changes anything but the label text and the spans of its name", () => {
    const out = temp();
    const home = landAll(new Home(FAMILIES, labels(), out), facts(7));
    const before = home.renderAll();
    expect(labels("Person A", "BDAY:2000-01-01\r\n").version).toBe(home.labels.version);
    home.relabel(labels("Person Renamed"));
    const after = home.renderAll();
    let renamed = 0;
    for (const day of DAYS) {
      const old = before.get(day)!;
      const now = after.get(day)!;
      expect(readDay(out, day).txt).toBe(now.txt);
      expect(now.txt).toBe(old.txt.replaceAll("Person A", "Person Renamed"));
      expect(now.lines).toBe(old.lines);
      const { inputs: _inputs, ...rest } = JSON.parse(now.json) as DayDocument;
      const { inputs: _oldInputs, ...oldRest } = JSON.parse(old.json.replaceAll("Person A", "Person Renamed")) as DayDocument;
      expect(namesSaid(rest.atoms)).toEqual(namesSaid((JSON.parse(old.json) as DayDocument).atoms).map((names) => names.map(([text, who]) => [text === "Person A" ? "Person Renamed" : text, who])));
      expect(withoutNames(rest.atoms)).toEqual(withoutNames(oldRest.atoms));
      if (old.txt.includes("Person A")) {
        renamed++;
        expect(now.inputs).not.toBe(old.inputs);
      }
    }
    expect(renamed).toBe(DAYS.length);
    const nobody = person("person-z", "Person Z", "+15550000009");
    home.relabel(labels("Person Renamed", "", [nobody]));
    expect(home.labels.version).not.toBe(labels("Person Renamed").version);
    const unmoved = home.renderAll();
    for (const day of DAYS) expect(unmoved.get(day)!.inputs, day).toBe(after.get(day)!.inputs);
  });

  it("the same inputs in another order render different bytes", () => {
    const list = facts(7);
    const shuffled = [...list];
    const random = mulberry32(99);
    for (let index = shuffled.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
    }
    const first = landAll(new Home(FAMILIES, labels(), temp()), list);
    const second = landAll(new Home([...FAMILIES].reverse(), labels(), temp()), shuffled);
    const reversed: DayReader = {
      extractsOn: (family, day) => [...second.reader().extractsOn(family, day)].reverse(),
      enrichment: second.reader().enrichment,
      sources: () => [...second.reader().sources()].reverse(),
      since: second.reader().since,
    };
    for (const day of DAYS) {
      const one = first.files.get(day)!;
      expect(second.files.get(day), day).toEqual(one);
      expect(renderDay(day, [ledger, vitals, chat], reversed, SETTINGS, tableUnits(second.labels))).toEqual(one);
    }
  });

  it("a line holding half of a character writes it as an escape the phone's decoder refuses, or a whole one otherwise than as it is", () => {
    const at = Date.parse("2026-10-25T16:00:00Z");
    const halves: Family = {
      name: "halves", type: null, code: "1", inputs: [], ...notUsed,
      days: (extract, settings) => daysOf({ start_ms: extract.start_ms!, precision: "ms" }, settings),
      day: linesOnly((input) => input.extracts.map((extract, index): DayLine => ({
        family: "halves", unit: extract.unit, units: [extract.unit], start_ms: extract.start_ms! + index, end_ms: null, text: (extract.content as string).slice(0, -1),
        block: { key: "cut", title: "A title cut \u{1F389}".slice(0, -1) },
      }))),
    };
    const rows = ["A party \u{1F389}, then a cut \u{1F389}", "A flag \u{1F1EE}\u{1F1F3} whole."].map((text, index): ExtractRow => {
      const row: ExtractRow = { family: "halves", unit: `line-${index}`, reading: digest(text), code: "1", content: text, start_ms: at, end_ms: at, days: [], seq: index };
      return { ...row, days: halves.days(row, SETTINGS) };
    });
    const reader: DayReader = { extractsOn: (_family, day) => rows.filter((row) => row.days.includes(day)), enrichment: () => undefined, sources: () => [], since: () => undefined };
    const files = renderDay("2026-10-25", [halves], reader, SETTINGS, tableUnits(labels()));
    expect(files.json.match(/\\u[dD][89abAB][0-9a-fA-F]{2}/gu)).toBeNull();
    expect(files.json).toContain("A flag \u{1F1EE}\u{1F1F3} whole");
    const document = JSON.parse(files.json) as DayDocument;
    expect(document.atoms.map((atom) => [atom.text, atom.block?.title])).toEqual([
      ["A party \u{1F389}, then a cut \ufffd", "A title cut \ufffd"],
      ["A flag \u{1F1EE}\u{1F1F3} whole", "A title cut \ufffd"],
    ]);
    expect(checkDayFile(document)).toEqual([]);
    expect(files.txt.isWellFormed()).toBe(true);
    expect(files.txt).toContain("A party \u{1F389}, then a cut \ufffd");
  });

  it("a DST day mis-cut", () => {
    const at = (iso: string) => Date.parse(iso);
    const marks: [string, string][] = [
      ["2026-10-31T08:00:00Z", "04:00 on the 31st, EDT"],
      ["2026-11-01T05:30:00Z", "the first 01:30 of 1 Nov, EDT"],
      ["2026-11-01T06:30:00Z", "the second 01:30 of 1 Nov, EST"],
      ["2026-11-01T08:59:00Z", "03:59 EST on 1 Nov"],
      ["2026-11-01T09:00:00Z", "04:00 EST on 1 Nov"],
    ];
    const clock: Family = {
      name: "clock", type: null, code: "1", inputs: [], ...notUsed,
      days: (extract, settings) => daysOf({ start_ms: extract.start_ms!, precision: "ms" }, settings),
      day: linesOnly((input) => input.extracts.map((extract) => ({
        family: "clock", unit: extract.unit, units: [extract.unit], start_ms: extract.start_ms, end_ms: null, text: extract.content as string,
        record: { source: "clock:test", kind: "mark", key: extract.unit },
      }))),
    };
    const rows = marks.map(([iso, text], index): ExtractRow => {
      const row: ExtractRow = { family: "clock", unit: `mark-${index}`, reading: digest(text), code: "1", content: text, start_ms: at(iso), end_ms: at(iso), days: [], seq: index };
      return { ...row, days: clock.days(row, SETTINGS) };
    });
    const reader: DayReader = { extractsOn: (_family, day) => rows.filter((row) => row.days.includes(day)), enrichment: () => undefined, sources: () => [], since: () => undefined };
    const render = (day: string) => JSON.parse(renderDay(day, [clock], reader, SETTINGS, tableUnits(labels())).json) as DayDocument;
    const halloween = render("2026-10-31");
    expect(halloween.window.end_ms - halloween.window.start_ms).toBe(25 * HOUR);
    expect(halloween.atoms.map((atom) => [atom.text, atom.local_start])).toEqual([
      ["04:00 on the 31st, EDT", "04:00"],
      ["the first 01:30 of 1 Nov, EDT", "2026-11-01 01:30"],
      ["the second 01:30 of 1 Nov, EST", "2026-11-01 01:30"],
      ["03:59 EST on 1 Nov", "2026-11-01 03:59"],
    ]);
    expect(render("2026-11-01").atoms.map((atom) => [atom.text, atom.local_start])).toEqual([["04:00 EST on 1 Nov", "04:00"]]);
    const txt = renderDay("2026-10-31", [clock], reader, SETTINGS, tableUnits(labels())).txt;
    expect(txt.split("\n")[0]).toBe("Day 2026-10-31 (Saturday) in America/New_York, 04:00 to 2026-11-01 04:00 (25 h)");
    const spring = renderDay("2026-03-08", [clock], reader, { zone: "America/New_York", day_start_hour: 2 }, tableUnits(labels())).json;
    expect((JSON.parse(spring) as DayDocument).window.start_ms).toBe(at("2026-03-08T07:00:00Z"));
    const home = landAll(new Home(FAMILIES, labels(), temp()), facts(7));
    const day = JSON.parse(home.files.get("2026-10-31")!.json) as DayDocument;
    expect(day.window.end_ms - day.window.start_ms).toBe(25 * HOUR);
    for (const atom of day.atoms.filter((entry) => entry.start_ms !== null && !entry.flags.includes("date_only"))) {
      expect(civilDay(atom.start_ms!, SETTINGS)).toBe("2026-10-31");
    }
    writeFileSync(join(temps.at(-1)!, "dst.json"), `${JSON.stringify({ halloween, settings: SETTINGS satisfies DaySettings }, null, 2)}\n`);
  });
});

function mean(values: readonly number[]): number {
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
