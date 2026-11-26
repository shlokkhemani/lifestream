import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { civilDay, dayBounds, type DaySettings, type ExtractRow, type Json, type RecordRef } from "@lifestreamprotocol/core";
import { AI_FAMILY, CALLAUDIO_FAMILY, type CallContent, type CallPart, type DayAtom, type DayDocument, type DayFileFact } from "@lifestreamprotocol/families";
import { ANSWER_CHARS, type Call, type Reader } from "./call.js";
import type { CountAsk } from "./counting.js";
import { nameKey } from "./devices.js";
import type { FreshSource } from "./freshness.js";
import { describedOf, readAnswerOf, readRoom, readSize, type ReadSources } from "./read.js";
import { lineRef, makeRef, readRef } from "./refs.js";
import { Refusal } from "./refusal.js";
import {
  answerOf, ContractError, describeParams, paramsOf, readParams, REFS_CHARS, searchParams, type Citation, type DescribeAnswer, type ReadAnswer, type RowAsk, type SearchAnswer,
} from "./search-contract.js";
import { atomsOf } from "./search.js";
import { recordPartOf, searchAnswerOf, searchAskedOf } from "./search-route.js";
import { atomSame, SearchIndex, type AtomEntry, type IndexedDay } from "./search-index.js";
import type { RowOpened } from "./count.js";
import type { ScreenWindow } from "./screen-reads.js";
import { callOf, onCall, type CallOf } from "./test/calls.js";
import { Work } from "./work.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

const fakes = vi.hoisted(() => ({ row: undefined as ((place: unknown) => RowOpened) | undefined }));
vi.mock("./count.js", async (original) => {
  const real = await original<typeof import("./count.js")>();
  return {
    ...real,
    openRow: (call: Call, ask: never, kept: never, scope: never, place: never) => (fakes.row === undefined ? real.openRow(call, ask, kept, scope, place) : fakes.row(place)),
    countAskOf: (asked: RowAsk, collections: never) => (fakes.row === undefined ? real.countAskOf(asked, collections) : ({ of: asked.of!, by: [], person: [], match: {}, op: "count", limit: 50 }) as unknown as CountAsk),
  };
});

const UTC: DaySettings = { zone: "UTC", day_start_hour: 0 };
const D = "2026-11-02";
const F = "2026-11-04";
const T0 = Date.parse(`${D}T08:00:00Z`);
const NOTES = "notes:local:mac-0001";
const scratch = mkdtempSync(join(tmpdir(), "lifestream-read-pager-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Lines = Extract<ReadAnswer, { what: "lines" }>;

function held<T>(route: "/v1/read" | "/v1/describe", reader: Reader, answer: unknown): T {
  expect(readSize(reader)(answer), `a ${reader}'s ${route} page`).toBeLessThanOrEqual(readRoom(reader, ANSWER_CHARS[reader]));
  return answerOf(route, 200, JSON.parse(JSON.stringify(answer))) as T;
}

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof Refusal) return error.code;
    if (error instanceof ContractError) return "BAD_PARAMETER";
    throw error;
  }
  return "answered";
};


let seq = 0;
function index(name: string, clock: DaySettings = UTC): SearchIndex {
  const file = join(scratch, name, "index.db");
  mkdirSync(join(scratch, name), { recursive: true });
  const built = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, clock);
  built.records([], [], { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } });
  built.finish();
  return SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, clock);
}

const note = (n: number, text: string, at: number | null, extra: Partial<AtomEntry> = {}): AtomEntry => ({ n, family: "notes", unit: `notes/${D}`, start_ms: at, end_ms: null, text, ...extra });

function documentOf(day: string, inputs: string, atoms: readonly AtomEntry[]): DayDocument {
  return {
    day, zone: "UTC", day_start_hour: 0, inputs, facts: [],
    atoms: atoms.map((atom) => ({
      n: atom.n, family: atom.family, unit: atom.unit, units: [atom.unit], start_ms: atom.start_ms, end_ms: atom.end_ms, text: atom.text, local_start: null, local_end: null, flags: [],
      ...(atom.item === undefined ? {} : { item: atom.item }), ...(atom.record === undefined ? {} : { record: atom.record }),
      ...(atom.accounts === undefined ? {} : { accounts: atom.accounts }),
      ...(atom.title === undefined ? {} : { block: { key: atom.unit, title: atom.title } }),
    })),
  } as unknown as DayDocument;
}

interface Home {
  index: SearchIndex | "busy";
  files: Map<string, DayDocument>;
  records?: Map<string, { text: string; start_ms: number | null; dated?: boolean; family?: string }>;
  clock?: DaySettings;
  budget?: number;
  now_ms?: number;
  screen?: Screen | "busy";
  fresh?: FreshSource[];
  products?: readonly string[];
  macs?: ReadonlyMap<string, string>;
  extracts?: ReadonlyMap<string, ExtractRow>;
}

interface Screen {
  sittings: { unit: string; start_ms: number; end_ms: number; summarised: boolean }[];
  windows: ScreenWindow[];
}

function write(home: Home, day: string, inputs: string, atoms: readonly AtomEntry[]): void {
  const start = Date.parse(`${day}T00:00:00Z`);
  const indexed: IndexedDay = { inputs, mtime_us: ++seq, atoms, facts: { window: { start_ms: start, end_ms: start + 86_400_000 }, facts: [] } };
  (home.index as SearchIndex).day(day, indexed);
  home.files.set(day, documentOf(day, inputs, atoms));
}

function onHome<T>(home: Home, reader: Reader, work: (sources: ReadSources) => T): T {
  const over: CallOf = {
    index: home.index, now_ms: home.now_ms ?? Date.parse(`${F}T12:00:00Z`), reader, ...(home.budget === undefined ? {} : { budget: home.budget }),
    ...(home.clock === undefined ? {} : { settings: home.clock }),
    fresh: () => ({ as_of: "2026-11-04T12:00+00:00", pending: [] }),
  };
  const made = callOf(over);
  const view = {
    head: (record: { key: string }) => {
      const kept = home.records?.get(record.key);
      return kept === undefined ? undefined : { version: `v-${record.key}`, start_ms: kept.start_ms, stated_ms: kept.start_ms ?? T0 };
    },
    source: () => undefined, blobsOf: () => [], history: () => [],
    extract: (family: string, unit: string) => home.extracts?.get(`${family}\0${unit}`),
    extractPage: (_family: string, select: { day: string }) => (home.screen === undefined || home.screen === "busy" ? [] : home.screen.sittings)
      .filter((sitting) => [sitting.start_ms, sitting.end_ms].some((ms) => new Date(ms).toISOString().slice(0, 10) === select.day))
      .map((sitting) => ({ unit: sitting.unit, start_ms: sitting.start_ms, end_ms: sitting.end_ms })),
    tables: { meta: { get: (key: string) => [...home.macs ?? []].find(([unit]) => key === nameKey(unit))?.[1] }, devices: { get: () => undefined } },
    enrichment: (_family: string, item: string) => (home.screen === undefined || home.screen === "busy" ? undefined : home.screen.sittings.find((sitting) => sitting.unit === item)?.summarised === true ? { state: "done" } : undefined),
  };
  Object.assign(made, { view: () => view });
  const screen = home.screen;
  const sources = {
    screenIfReady: () => (screen === undefined || screen === "busy" ? screen : {
      file: "screen-1", clock: UTC, as_of: null, sources: { of: (machine: string) => [`screen:local:${machine}`], machines: () => (home.macs === undefined ? [MAC] : [...home.macs.keys()]) },
      windowsIn: (machine: string, from_ms: number, to_ms: number) => screen.windows.filter((window) => window.machine === machine && window.end_ms >= from_ms && window.start_ms < to_ms)
        .map((window) => ({ ...window, start_ms: Math.max(window.start_ms, from_ms), end_ms: Math.min(window.end_ms, to_ms) })),
    }),
    call: made as Call,
    freshness: () => home.fresh ?? [], isProduct: (product: string) => home.products?.includes(product) === true, dayDocument: (day: string) => home.files.get(day),
    recordOf: (record: { key: string }) => {
      const kept = home.records?.get(record.key);
      return { family: kept?.family ?? "notes", read: kept === undefined ? null : { text: kept.text }, product: undefined, dated: kept?.dated === true };
    },
    aiChatOf: () => undefined,
    isAiChat: () => false,
    photo: () => undefined,
    held: () => true,
    name: (id: string) => id,
  } as unknown as ReadSources;
  try {
    return work(sources);
  } finally {
    made.end();
  }
}

function read(home: Home, params: Record<string, string | string[]>, reader: Reader = "person"): ReadAnswer {
  return onHome(home, reader, (sources) => {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) for (const each of [value].flat()) query.append(name, each);
    return held<ReadAnswer>("/v1/read", reader, readAnswerOf(paramsOf(readParams, query), sources));
  });
}

function describeOf(home: Home, refs: string[]): DescribeAnswer {
  return onHome(home, "person", (sources) => held<DescribeAnswer>("/v1/describe", "person",
    describedOf(paramsOf(describeParams, new URLSearchParams(refs.map((ref): [string, string] => ["ref", ref]))), sources)));
}

function follow(home: Home, first: Lines, reader: Reader = "person", most = 200, between?: (page: Lines) => void): Lines[] {
  const pages = [first];
  while (pages.at(-1)!.next !== null && pages.at(-1)!.next !== undefined) {
    if (pages.length >= most) throw new Error(`no end after ${most} pages: the cursor does not progress`);
    between?.(pages.at(-1)!);
    pages.push(read(home, { cursor: pages.at(-1)!.next! }, reader) as Lines);
  }
  return pages;
}

describe("a stretch's continuations progress (Sol 2, 6)", () => {
  it("a dense day, its call's meter near its end: each page seeks its anchor and walks on from it, the day followed to its end, each line once", () => {
    const home: Home = { index: index("dense"), files: new Map(), budget: 700 };
    const atoms = Array.from({ length: 1_500 }, (_, n) => note(n, `synthetic dense line ${n}`, T0 + n * 1_000));
    write(home, D, "in-1", atoms);
    const pages = follow(home, read(home, { from: D }) as Lines);
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.flatMap((page) => page.lines.map((line) => line.text))).toEqual(atoms.map((atom) => atom.text));
  });

  it("its anchor erased at each page, beside lines of the same time and of no time: none of them passed over, none given twice", () => {
    const home: Home = { index: index("erased-ties"), files: new Map() };
    let atoms = [
      ...Array.from({ length: 120 }, (_, n) => note(n, `synthetic same-time line ${n} ${"w".repeat(500)}`, T0)),
      ...Array.from({ length: 80 }, (_, n) => note(120 + n, `synthetic untimed line ${n} ${"w".repeat(500)}`, null)),
    ];
    write(home, D, "in-1", atoms);
    const erased = new Set<string>();
    let revision = 1;
    const pages = follow(home, read(home, { from: D }, "model") as Lines, "model", 200, (page) => {
      const last = page.lines.at(-1)!.text;
      const at = atoms.findIndex((atom) => atom.text === last);
      const anchor = atoms[at + 1];
      if (anchor === undefined) return;
      erased.add(anchor.text);
      atoms = atoms.filter((atom) => atom !== anchor).map((atom, n) => ({ ...atom, n }));
      write(home, D, `in-${++revision}`, atoms);
    });
    expect(erased.size).toBeGreaterThan(3);
    const texts = pages.flatMap((page) => page.lines.map((line) => line.text));
    expect(new Set(texts).size).toBe(texts.length);
    expect(texts).toEqual(atoms.map((atom) => atom.text));
  });
});

describe("a lookup tells found, absent, two and unread apart (Sol 12)", () => {
  const event = (n: number, text: string, item: string) => note(n, text, T0 + n * 1_000, { family: "calendar", unit: `calendar/${item}`, item });
  const refOf = (atom: AtomEntry) => lineRef({ day: D, same: atomSame(D, atom), unit: atom.unit, item: atom.item ?? null }, 0);

  it("its meter spent before the target it would find by its unit and item: TOO_BROAD, never LINE_MOVED; read alone, found", () => {
    const home: Home = { index: index("unread-target"), files: new Map() };
    const atoms = Array.from({ length: 1_000 }, (_, n) => event(n, `Synthetic event ${n}`, `e${n}`));
    write(home, D, "in-1", atoms);
    const cited = refOf(atoms[900]!);
    write(home, D, "in-2", atoms.map((atom, n) => (n === 900 ? { ...atom, text: "Synthetic event 900, moved" } : atom)));
    expect(codeOf(() => read({ ...home, budget: 300 }, { ref: cited }))).toBe("TOO_BROAD");
    const found = read(home, { ref: cited }) as Extract<ReadAnswer, { what: "line" }>;
    expect(found.lines.find((line) => line.ref === cited)?.text).toBe("Synthetic event 900, moved");
  });

  it("its meter spent before a second candidate: TOO_BROAD, never the first taken as the one; read alone, two: LINE_MOVED", () => {
    const home: Home = { index: index("unread-second"), files: new Map() };
    const atoms = Array.from({ length: 1_000 }, (_, n) => event(n, `Synthetic event ${n}`, `e${n}`));
    write(home, D, "in-1", atoms);
    const cited = refOf(atoms[5]!);
    write(home, D, "in-2", atoms.map((atom, n) => (n === 5 ? { ...atom, text: "Synthetic event 5, part one" } : n === 950 ? { ...atom, unit: "calendar/e5", item: "e5", text: "Synthetic event 5, part two" } : atom)));
    expect(codeOf(() => read({ ...home, budget: 300 }, { ref: cited }))).toBe("TOO_BROAD");
    expect(codeOf(() => read(home, { ref: cited }))).toBe("LINE_MOVED");
  });
});

describe("one rule for a ref's failure among several (Sol 10, Fable 2, 6, 8)", () => {
  const record = makeRef("record", { source: NOTES, kind: "note", key: "n1" });
  const line = lineRef({ day: D, same: "00aa00aa00aa00aa", unit: `notes/${D}`, item: null }, 0);
  const picture = makeRef("picture", { image: `sha256:${"0a".repeat(32)}` });
  const busy = (): Home => ({ index: "busy", files: new Map(), records: new Map([["n1", { text: "synthetic note", start_ms: T0 }]]) });

  it("read while the index is written: a ref before it opens and the rest are unopened; first, the call is NOT_NOW", () => {
    const some = read(busy(), { ref: [record, line, picture] }) as Extract<ReadAnswer, { what: "refs" }>;
    expect(some.opened.map((each) => each.what)).toEqual(["record"]);
    expect(some.unopened).toEqual([line, picture]);
    expect(codeOf(() => read(busy(), { ref: [line, record] }))).toBe("NOT_NOW");
  });

  it("describe while the index is written: a record refuses as a line does (never a guess); after one described, the rest unopened; a ref no door made is gone, never the call's", () => {
    expect(codeOf(() => describeOf(busy(), [record]))).toBe("NOT_NOW");
    expect(describeOf(busy(), [picture, record, line])).toEqual({ described: [{ ref: picture, kind: "gone", why: expect.any(String) }], unopened: [record, line] });
    const forged = "record.e30";
    const ready: Home = { index: index("describe-forged"), files: new Map(), records: busy().records! };
    expect(describeOf(ready, [forged, record]).described.map((each) => each.kind)).toEqual(["gone", "record"]);
  });
});

describe("one day rule (Sol 13, Fable 1)", () => {
  it("a payment with only a date, under America/New_York from 04:00: read and described on its own date, with no clock time", () => {
    const clock: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
    const home: Home = {
      index: index("dated", clock), files: new Map(), clock,
      records: new Map([["pay", { text: "synthetic payment to Example Shop", start_ms: Date.parse("2026-10-04T00:00:00Z"), dated: true, family: "money" }]]),
    };
    const ref = makeRef("record", { source: "money:local:bank-aa01", kind: "txn", key: "pay" });
    const opened = read(home, { ref }) as Extract<ReadAnswer, { what: "record" }>;
    expect(opened).toMatchObject({ what: "record", day: "2026-10-04" });
    expect(opened.at).toBeUndefined();
    const [cited] = describeOf(home, [ref]).described;
    expect(cited).toMatchObject({ kind: "record", day: "2026-10-04", opens: { page: "days", day: "2026-10-04" } });
    expect((cited as { at?: string }).at).toBeUndefined();
  });

  it("a record with no time that no day prints: no day, described as opened through read, never today", () => {
    const home: Home = { index: index("untimed"), files: new Map(), records: new Map([["n0", { text: "synthetic timeless note", start_ms: null }]]) };
    const ref = makeRef("record", { source: NOTES, kind: "note", key: "n0" });
    expect((read(home, { ref }) as Extract<ReadAnswer, { what: "record" }>).day).toBeUndefined();
    expect(describeOf(home, [ref]).described[0]).toMatchObject({ kind: "record", opens: { page: "read" } });
    expect((describeOf(home, [ref]).described[0] as { day?: string }).day).toBeUndefined();
  });
});

describe("a brief's line past the room (Sol 5)", () => {
  it("goes on inside itself: rebuilt whole from its pages, each within a model's size", () => {
    const home: Home = { index: index("brief-long"), files: new Map() };
    const title = `Synthetic chat ${"t".repeat(30_000)}`;
    write(home, D, "in-1", [note(0, "synthetic message", T0, { family: "messages", unit: "messages/whatsapp/chat-a", title })]);
    const pages: Extract<ReadAnswer, { what: "brief" }>[] = [read(home, { from: D, to: F, detail: "brief" }, "model") as Extract<ReadAnswer, { what: "brief" }>];
    while (pages.at(-1)!.next !== null && pages.at(-1)!.next !== undefined && pages.length < 20) pages.push(read(home, { cursor: pages.at(-1)!.next! }, "model") as Extract<ReadAnswer, { what: "brief" }>);
    expect(pages.length).toBeGreaterThan(1);
    const words = pages.flatMap((page) => page.days.filter((day) => day.day === D).flatMap((day) => day.lines.map((line) => line.text))).join("");
    expect(words).toBe(`${title}: 1 message`);
  });
});

describe("a `last` stretch's pages", () => {
  const HOUR = 3_600_000;
  const NOW = Date.parse(`${F}T12:00:00Z`);
  const chats = Array.from({ length: 10 }, (_, n) => note(n, `synthetic message ${n}`, NOW - HOUR + n * 60_000, { family: "messages", unit: `messages/chat-${n}`, title: `Synthetic chat ${n} ${"t".repeat(3_000)}` }));
  type Brief = Extract<ReadAnswer, { what: "brief" }>;

  it("page 2, read hours later, reads the instants the first page sealed, never a newer stretch", () => {
    const home: Home = { index: index("last-later"), files: new Map(), now_ms: NOW };
    write(home, F, "in-1", chats);
    const first = read(home, { last: "3h" }, "model") as Brief;
    expect(first).toMatchObject({ what: "brief", span: { from: `${F}T09:00+00:00` } });
    expect(first.next).toEqual(expect.any(String));
    const pages = [first];
    while (pages.at(-1)!.next !== null && pages.at(-1)!.next !== undefined && pages.length < 10) {
      pages.push(read({ ...home, now_ms: NOW + 2 * HOUR }, { cursor: pages.at(-1)!.next! }, "model") as Brief);
    }
    expect(pages.at(-1)!.span.to).toBe(`${F}T12:00+00:00`);
    expect(pages.flatMap((page) => page.days.flatMap((day) => day.lines.map((line) => line.text.slice(0, 18)))).filter((text) => text.startsWith("Synthetic chat"))).toHaveLength(7);
  });

  it("page 2 after its day was written again: expired, telling the agent to read the same instants again", () => {
    const home: Home = { index: index("last-rewritten"), files: new Map(), now_ms: NOW };
    write(home, F, "in-1", chats);
    const first = read(home, { last: "3h" }, "model") as Brief;
    write(home, F, "in-2", chats.slice(1));
    let said = "";
    try {
      read({ ...home, now_ms: NOW + HOUR }, { cursor: first.next! }, "model");
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      said = `${error.code}: ${error.words}`;
    }
    expect(said).toBe(`CURSOR_EXPIRED: that day was written again since this page was given: read again with \`from\` ${F}T09:00+00:00, \`to\` ${F}T12:00+00:00 and \`detail\` brief`);
  });

  it("only the first page says how fresh each source is: a lagging one with both times, never the home's own Ask; never a next page or a plain read", () => {
    const PHONE = "whatsapp:local:phone-0001";
    const source = (id: string, name: string, family: string, synced_ms: number, item_ms: number, road: FreshSource["road"] = "phone"): FreshSource => ({
      id, product: id.split(":")[0]!, name, device: null, families: [family], road, heard_ms: synced_ms, synced_ms, item_ms, item_dated: false,
    });
    const home: Home = {
      index: index("last-fresh"), files: new Map(), now_ms: NOW,
      fresh: [source(NOTES, "Notes, Mac", "notes", NOW - 60_000, NOW - 2 * HOUR), source(PHONE, "WhatsApp, Phone", "messages", NOW - 2 * HOUR, NOW - 30 * 60_000),
        source("ask:local:home-0001", "Ask", "ai", NOW - 2 * HOUR, NOW - 2 * HOUR, "owner")],
    };
    write(home, F, "in-1", [
      ...chats,
      note(20, "synthetic note", NOW - 2 * HOUR, { record: { source: NOTES, kind: "note", key: "n-1" } }),
      note(21, "synthetic message", NOW - 40 * 60_000, { family: "messages", unit: "messages/chat-x", record: { source: PHONE, kind: "message", key: "m-1" } }),
    ]);
    const first = read(home, { last: "3h" }, "model") as Brief;
    expect(first.freshness).toBe("Synced in the last 15 min: 1 source. Not since: WhatsApp, Phone (last synced 10:00, last item 11:30).");
    expect(first.next).toEqual(expect.any(String));
    expect(read(home, { cursor: first.next! }, "model")).not.toHaveProperty("freshness");
    expect(read(home, { from: `${F}T09:00+00:00`, to: `${F}T12:00+00:00` })).not.toHaveProperty("freshness");
    expect(read(home, { last: "3h", families: "notes" })).toHaveProperty("freshness", "The one source synced in the last 15 min.");
    expect(read({ ...home, fresh: [] }, { last: "3h" })).not.toHaveProperty("freshness");
  });
});

interface Held {
  view?: Record<string, unknown>;
  recordOf?: ReadSources["recordOf"];
  places?: Record<string, unknown>;
  people?: { idOf(handle: string): string | undefined; person(id: string): { name: string } | undefined };
  isAiChat?: (key: string) => boolean;
}

function sourcesOf(over: Held, reader: Reader): ReadSources {
  const call = {
    now_ms: T0 + 86_400_000, epoch: null, meter: new Work(110_000), families: [], networks: { of: () => undefined, products: [] },
    answerChars: ANSWER_CHARS[reader], reader,
    view: () => over.view, clock: () => UTC, whereIfReady: () => undefined, labels: () => ({}), chat: (asked: string) => asked,
    index: () => ({ clock: UTC, seq: 0, file: "file-1", factsBuild: "build-1", held: (from: string, to: string) => ({ from, to, days: new Map() }), facts: () => undefined }),
    indexIfReady: () => undefined,
    fresh: () => ({ as_of: null, pending: [] }),
    placesIfReady: () => (over.places === undefined ? undefined : { value: (table: string, slug: string) => (table === "place" ? (over.places![slug] === undefined ? undefined : { place: over.places![slug] }) : undefined) }),
    people: () => over.people,
    peopleFileIfReady: () => undefined,
  } as unknown as Call;
  return {
    call, recordOf: over.recordOf ?? (() => ({ family: "notes", read: null, product: undefined, dated: false })), aiChatOf: () => undefined,
    isAiChat: over.isAiChat ?? (() => false), productName: () => "Assistant", name: (id: string) => id, photo: () => undefined, screenIfReady: () => undefined,
  } as unknown as ReadSources;
}

function readHeld(over: Held, params: Record<string, string>, reader: Reader = "person"): ReadAnswer {
  return held<ReadAnswer>("/v1/read", reader, readAnswerOf(paramsOf(readParams, new URLSearchParams(params)), sourcesOf(over, reader)));
}

function pagesOf<T extends { next?: string | null }>(over: Held, first: T, reader: Reader, most = 100): T[] {
  const pages = [first];
  while (pages.at(-1)!.next !== null && pages.at(-1)!.next !== undefined) {
    if (pages.length >= most) throw new Error(`no end after ${most} pages`);
    pages.push(readHeld(over, { cursor: pages.at(-1)!.next! }, reader) as unknown as T);
  }
  return pages;
}

describe("one lossless pager (Sol 3, 5; Fable 5)", () => {
  it("a record's one historical version over the person's room: continued by its statement and inside it, followed to its end", () => {
    const record = { source: NOTES, kind: "note", key: "big" };
    const words = { v0: "short head", v1: "h".repeat(90_000), v2: "last version" };
    const over: Held = {
      view: {
        head: () => ({ version: "v2", start_ms: T0, stated_ms: T0 }), source: () => undefined, blobsOf: () => [],
        history: () => [{ seq: 1, version: "v0", stated_ms: T0 }, { seq: 2, version: "v1", stated_ms: T0 + 1 }, { seq: 3, version: "v2", stated_ms: T0 + 2 }],
      },
      recordOf: (_record, version) => ({ family: "notes", read: { text: words[(version ?? "v2") as keyof typeof words] }, product: undefined, dated: false }),
    };
    type Whole = Extract<ReadAnswer, { what: "record" }>;
    const pages = pagesOf(over, readHeld(over, { ref: makeRef("record", record), history: "1" }) as Whole, "person");
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.flatMap((page) => (page.history ?? []).map((version) => version.text)).join("")).toBe(words.v0 + words.v1 + words.v2);
    for (const page of pages) expect(page).toMatchObject({ what: "record", ref: makeRef("record", record) });
  });

  it("a place over 64,000 characters: its visits newest first across pages, each page within the person's size, its slug and name on each", () => {
    const visits = Array.from({ length: 3_000 }, (_, n) => ({ unit: `physical/visit-${3_000 - n}`, start_ms: T0 - n * 3_600_000, end_ms: T0 - n * 3_600_000 + 1_800_000, day: D, people: ["person-a"], centre: { latitude: 1.5, longitude: 2.5 } }));
    const place = {
      slug: "example-cafe", name: "Example Cafe", latitude: 1.5, longitude: 2.5, radius_m: 40, also: [], ids: ["place-1"], area: { city: "Example City", region: null, country: null },
      days: 3_000, hours: 1_500, first_ms: T0 - 3_000 * 3_600_000, last_ms: T0, visits_count: 3_000, nights: 0, here: false, part_of: null, inside: [], ask_home: null, rhythm: null,
      visits, photos: [], photos_count: 0, people: [{ id: "person-a", name: "Person A", days: 3_000 }],
    };
    const over: Held = { places: { "example-cafe": place } };
    type Spot = Extract<ReadAnswer, { what: "place" }>;
    const pages = pagesOf(over, readHeld(over, { ref: makeRef("place", { id: "example-cafe" }) }) as Spot, "person");
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((page) => page.place.visits ?? [])).toEqual(visits);
    for (const page of pages) expect(page.place).toMatchObject({ slug: "example-cafe", name: "Example Cafe" });
    expect(pages.at(-1)!.place.people).toEqual(place.people);
  });

  it("a row whose first cell is over a model's 20,000 characters: the cell given whole across pages, every cell in its column, then the next fact", () => {
    const facts = [["c".repeat(45_000), "second cell"], ["next fact", "its cell"]];
    fakes.row = (place) => {
      const from = (place as { after?: number } | undefined)?.after ?? -1;
      const rows = facts.slice(from + 1);
      return {
        answer: {
          asked: { is: "plain", value: "messages" }, columns: ["words", "more"], rows: rows.map((row) => row.map((value) => ({ is: "plain", value }))),
          places: rows.map((_, k) => ({ after: from + 1 + k })), next: null,
        },
      } as unknown as RowOpened;
    };
    try {
      const ref = makeRef("row", { ask: { of: "messages" } as RowAsk, kept: {}, scope: { t: null }, n: 2 });
      type Row = Extract<ReadAnswer, { what: "row" }>;
      const pages = pagesOf({}, readHeld({}, { ref }, "model") as Row, "model");
      expect(pages.length).toBeGreaterThan(2);
      const rows = pages.flatMap((page) => page.rows);
      const first = rows.filter((row) => row[0] !== "next fact");
      expect(first.map((row) => row[0] ?? "").join("")).toBe(facts[0]![0]);
      expect(first.at(-1)![1]).toBe("second cell");
      expect(rows.at(-1)).toEqual(facts[1]);
    } finally {
      fakes.row = undefined;
    }
  });
});

describe("an in-field offset bound to its field (Sol 7)", () => {
  const chat = "claude:org-0001:cloud/00000000-0000-4000-8000-0000000000c2";
  const turnsOf = (words: string) => [{ key: "t0", at_ms: T0, role: "assistant", words, attachments: [], images: 0, source: "claude:org-0001:cloud" }];
  const overOf = (words: () => string): Held => ({
    isAiChat: () => true,
    view: {
      extractReadings: (family: string) => (family === AI_FAMILY ? [{ unit: `${chat}/${D}` }] : []),
      extract: () => ({ content: { provider: "claude", title: "A synthetic chat", turns: turnsOf(words()) } }),
    },
  });

  it("a long AI turn edited between its pages: CURSOR_EXPIRED, never the old offset in the new words; unedited, given back whole", () => {
    let words = "a".repeat(50_000);
    const over = overOf(() => words);
    type ChatPage = Extract<ReadAnswer, { what: "chat" }>;
    const first = readHeld(over, { chat: makeRef("chat", { key: chat }) }, "model") as ChatPage;
    expect(first.next).toEqual(expect.any(String));
    const whole = pagesOf(over, first, "model").flatMap((page) => page.lines.map((line) => line.text)).join("");
    expect(whole).toBe(words);
    words = `${"b".repeat(10)}${words}`;
    expect(codeOf(() => readHeld(over, { cursor: first.next! }, "model"))).toBe("CURSOR_EXPIRED");
  });
  it("a chat over a `last` stretch states the stretch's first instant as its span's start, so the window it read can be written again", () => {
    const over = overOf(() => "a synthetic turn");
    const page = readHeld(over, { chat: makeRef("chat", { key: chat }), last: "24h" }, "model") as Extract<ReadAnswer, { what: "chat" }>;
    expect([page.span.from, page.lines.length]).toEqual([`${D}T08:00+00:00`, 1]);
    const whole = readHeld(over, { chat: makeRef("chat", { key: chat }), from: D, to: D }, "model") as Extract<ReadAnswer, { what: "chat" }>;
    expect(whole.span.from).toBe(D);
  });
});

describe("a kept person citation (Fable 3)", () => {
  it("opens People by the ref's handle, so it names the same person once People was prepared again from cold", () => {
    const handle = "phone:+15550000001";
    const before = { idOf: (each: string) => (each === handle ? "p-1" : undefined), person: (id: string) => (id === "p-1" ? { name: "Person A" } : undefined) };
    const answer = describedOf({ ref: makeRef("person", { handle }) }, sourcesOf({ people: before }, "person"));
    const [kept] = held<DescribeAnswer>("/v1/describe", "person", answer).described;
    expect(kept).toMatchObject({ kind: "person", name: "Person A", opens: { page: "people", id: handle } });
    const after = { idOf: (each: string) => (each === handle ? "p-77" : undefined), person: (id: string) => (id === "p-77" ? { name: "Person A" } : id === "p-1" ? { name: "Person B" } : undefined) };
    const opened = (kept as Extract<Citation, { kind: "person" }>).opens as { id: string };
    expect(after.person(after.idOf(opened.id)!)?.name).toBe("Person A");
  });
});

describe("the refs of one call, bounded in the parameters (Fable 12b)", () => {
  it("twenty large refs are the door's BAD_PARAMETER, naming the fix, for read and describe alike", () => {
    const large = Array.from({ length: 20 }, (_, n) => makeRef("record", { source: NOTES, kind: "note", key: `${String(n).padStart(2, "0")}${"k".repeat(500)}` }));
    expect(large.join("").length).toBeGreaterThan(REFS_CHARS);
    const query = new URLSearchParams(large.map((ref): [string, string] => ["ref", ref]));
    for (const shape of [readParams, describeParams]) {
      let words = "";
      try {
        paramsOf(shape as typeof readParams, query);
      } catch (error) {
        words = error instanceof ContractError ? error.why : String(error);
      }
      expect(words).toContain("fewer at once");
    }
    expect(readRef(large[0]!, "ref").kind).toBe("record");
  });
});

const MAC = "mac-0001";
const MINUTE_MS = 60_000;
const atMinute = (minutes: number) => T0 + minutes * MINUTE_MS;
const sittingAtom = (n: number, from: number, to: number, text: string): AtomEntry => ({ n, family: "screen", unit: `${MAC}/${atMinute(from)}`, item: `${MAC}/${atMinute(from)}`, start_ms: atMinute(from), end_ms: atMinute(to), text });
const shownOn = (day: string, app: string, name: string, from_ms: number, to_ms: number, tenths: number): ScreenWindow => ({ machine: MAC, day, app, site: "", name, start_ms: from_ms, end_ms: to_ms, tenths });
const shown = (app: string, name: string, from: number, to: number, tenths: number) => shownOn(D, app, name, atMinute(from), atMinute(to), tenths);
const clockAt = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const spanAt = (window: ScreenWindow) => (clockAt(window.start_ms) === clockAt(window.end_ms) ? clockAt(window.start_ms) : `${clockAt(window.start_ms)}–${clockAt(window.end_ms)}`);
const windowText = (window: ScreenWindow, mac?: string) =>
  `${spanAt(window)}${mac === undefined ? "" : ` on ${mac}`}, not summarised yet: ${window.name === "" ? window.app : `${window.app}, ${window.name}`}, ${Math.round(window.tenths / 600)} min on screen`;
const windowRefOf = (window: ScreenWindow) => makeRef("window", { machine: MAC, day: window.day, app: window.app, site: window.site, name: window.name, at_ms: window.start_ms });

describe("the screen with no finished summary, in lines", () => {
  const sittings = [
    { unit: `${MAC}/${atMinute(10)}`, start_ms: atMinute(10), end_ms: atMinute(30), summarised: true },
    { unit: `${MAC}/${atMinute(40)}`, start_ms: atMinute(40), end_ms: atMinute(60), summarised: false },
  ];
  const safari = shown("Safari", "Example Air", 40, 55, 9_000), chrome = shown("Google Chrome", "Example Inbox", 80, 90, 6_000);
  const short = [shown("Finder", "", 55, 60, 300), shown("Notes", "", 58, 60, 200)];

  it("a sitting not summarised gives its windows in its place, those under a minute as one line; the minutes past the newest sitting follow the day's last line", () => {
    const home: Home = { index: index("screen-lines"), files: new Map(), screen: { sittings, windows: [shown("Example Editor", "Plan", 10, 30, 12_000), safari, ...short, chrome] } };
    write(home, D, "in-1", [note(0, "synthetic morning note", T0), sittingAtom(1, 10, 30, "Summary: synthetic planning"), sittingAtom(2, 40, 60, "20 min at the Mac (account pending)"), note(3, "synthetic later note", atMinute(70))]);
    const lines = read(home, { from: D }) as Lines;
    expect(lines.lines.map((line) => line.text)).toEqual([
      "synthetic morning note", "Summary: synthetic planning", windowText(safari), "2 more windows, under a minute each", "synthetic later note", windowText(chrome),
    ]);
    expect(lines.lines[2]).toMatchObject({ ref: windowRefOf(safari), day: D, family: "screen" });
    expect(lines.lines[3]!.cites).toEqual(short.map(windowRefOf));
    expect(JSON.stringify(lines)).not.toContain("account pending");
    expect((read(home, { from: D, products: "chrome" }) as Lines).lines.map((line) => line.text)).toEqual([windowText(chrome)]);
    expect((read({ ...home, products: ["whoop"] }, { from: D, products: ["chrome", "whoop"] }) as Lines).lines.map((line) => line.text)).toEqual([windowText(chrome)]);
    expect((read({ ...home, products: ["screen"] }, { from: D, products: "screen" }) as Lines).lines.map((line) => line.text))
      .toEqual([windowText(safari), "2 more windows, under a minute each", windowText(chrome)]);
    expect((read(home, { from: D, families: "notes" }) as Lines).lines.map((line) => line.text)).toEqual(["synthetic morning note", "synthetic later note"]);
  });

  it("a window names its Mac only when the day has several, by the Mac's name, never its unit", () => {
    const OTHER = "mac-0002";
    const other = shownOn(D, "Notes", "Example List", atMinute(42), atMinute(52), 6_000);
    const home: Home = {
      index: index("screen-macs"), files: new Map(), macs: new Map([[MAC, "Work Mac"], [OTHER, "Home Mac"]]),
      screen: { sittings, windows: [safari, { ...other, machine: OTHER }] },
    };
    write(home, D, "in-1", [sittingAtom(2, 40, 60, "20 min at the Mac (account pending)")]);
    expect((read(home, { from: D }) as Lines).lines.map((line) => line.text)).toEqual([windowText(safari, "Work Mac"), windowText(other, "Home Mac")]);
  });

  it("a sitting the index still holds a stale account of, step by step: its windows once, at its first line, none of the stale lines", () => {
    const home: Home = { index: index("screen-stale"), files: new Map(), screen: { sittings, windows: [safari, ...short, chrome] } };
    const stale = [sittingAtom(2, 40, 60, "Summary: a stale account"), { ...sittingAtom(3, 40, 60, "a stale step"), start_ms: atMinute(45), end_ms: atMinute(50) }, { ...sittingAtom(4, 40, 60, "Did: a stale act"), start_ms: atMinute(52), end_ms: null }];
    write(home, D, "in-1", [...stale, note(5, "synthetic later note", atMinute(70))]);
    expect((read(home, { from: D }) as Lines).lines.map((line) => line.text)).toEqual([windowText(safari), "2 more windows, under a minute each", "synthetic later note", windowText(chrome)]);
  });

  it("while the screen index is written: the day said as still being read, beside the lines it holds", () => {
    const home: Home = { index: index("screen-busy"), files: new Map(), screen: "busy" };
    write(home, D, "in-1", [note(0, "synthetic morning note", T0), sittingAtom(2, 40, 60, "20 min at the Mac (account pending)")]);
    const lines = read(home, { from: D }) as Lines;
    expect(lines.pending).toEqual([{ day: D, why: "new" }]);
    expect((read(home, { from: D, detail: "brief" }) as Extract<ReadAnswer, { what: "brief" }>).pending).toEqual([{ day: D, why: "new" }]);
    expect((read(home, { from: D, families: "notes" }) as Lines).pending).toBeUndefined();
  });

  it("a stretch with no day in the index yet: the windows of its minutes", () => {
    const now_ms = Date.parse(`${F}T12:00:00Z`);
    const late = shownOn(F, "Google Chrome", "Example Inbox", now_ms - 40 * MINUTE_MS, now_ms - 30 * MINUTE_MS, 6_000);
    const home: Home = { index: index("screen-unindexed"), files: new Map(), now_ms, screen: { sittings: [], windows: [late] } };
    expect((read(home, { last: "1h", detail: "lines" }) as Lines).lines.map((line) => line.text)).toEqual([windowText(late)]);
  });

  it("a sitting's windows across pages each once; a late frame that moves its window lines between pages: CURSOR_EXPIRED", () => {
    const many = Array.from({ length: 450 }, (_, n) => shownOn(D, `Example App ${n}`, "", atMinute(40) + n * 1_000, atMinute(40) + n * 1_000 + 900, 600));
    const home: Home = { index: index("screen-paged"), files: new Map(), screen: { sittings, windows: many } };
    write(home, D, "in-1", [sittingAtom(2, 40, 60, "20 min at the Mac (account pending)"), note(3, "synthetic later note", atMinute(70))]);
    const pages = follow(home, read(home, { from: D }) as Lines);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((page) => page.lines.map((line) => line.text))).toEqual([...many.map((window) => windowText(window)), "synthetic later note"]);
    const first = read(home, { from: D }) as Lines;
    home.screen = { sittings, windows: [shownOn(D, "Example App late", "", atMinute(40), atMinute(41), 600), ...many] };
    expect(codeOf(() => read(home, { cursor: first.next! }))).toBe("CURSOR_EXPIRED");
  });
});

describe("`products` in a brief and in lines", () => {
  type Brief = Extract<ReadAnswer, { what: "brief" }>;

  it("both keep a line by the accounts it states, else by its own record's source", () => {
    const home: Home = { index: index("products-one-rule"), files: new Map(), products: ["whatsapp", "notes"] };
    write(home, D, "in-1", [
      note(0, "synthetic stated line", T0, { accounts: ["whatsapp:+15550000001"] }),
      note(1, "synthetic own note", T0 + MINUTE_MS, { record: { source: NOTES, kind: "note", key: "n-1" } }),
    ]);
    const lines = read(home, { from: D, products: "whatsapp", detail: "lines" }) as Lines;
    const brief = read(home, { from: D, products: "whatsapp", detail: "brief" }) as Brief;
    expect(lines.lines.map((line) => line.text)).toEqual(["synthetic stated line"]);
    expect(brief.days.flatMap((day) => day.lines.flatMap((line) => line.cites))).toEqual(lines.lines.map((line) => line.ref));
  });
});

describe("a recorded call reads as a chat, its turns cited from their own place in their part", () => {
  const KOLKATA: DaySettings = { zone: "Asia/Kolkata", day_start_hour: 4 };
  const MIC_SOURCE = "audio:local:macbook-pro-0001";
  const CALL_DAY = JSON.parse(readFileSync(new URL("../families/callaudio/test/2026-10-05.day.json", import.meta.url), "utf8")) as DayDocument;
  type Chat = Extract<ReadAnswer, { what: "chat" }>;
  const keyMs = (key: string) => Date.parse(key.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/u, "$1-$2-$3T$4:$5:$6"));

  function callExtract(unit: string, parts: readonly CallPart[], span: { start_ms: number; end_ms: number }): [string, ExtractRow] {
    const content: CallContent = {
      short: false, source: MIC_SOURCE, span, mic: parts.filter((part) => part.track === "mic"), sound: parts.filter((part) => part.track === "sound"),
      holder: "Zoom", camera: false, speakers: [], stopped_ms: null, open: false, joined: null,
    };
    return [`${CALLAUDIO_FAMILY}\0${unit}`, { family: CALLAUDIO_FAMILY, unit, reading: "r", code: "1", content: content as unknown as Json, ...span, days: [], seq: 1 }];
  }

  function partsOf(atoms: readonly DayAtom[], unit: string): CallPart[] {
    const parts = new Map<string, CallPart>();
    for (const atom of atoms) {
      if (atom.unit !== unit || atom.record === undefined || atom.item?.startsWith("recording:") !== true) continue;
      const { kind, key } = atom.record;
      parts.set(`${kind}/${key}`, {
        kind, key, track: kind === "mic-recording" ? "mic" : "sound", sha256: atom.item.slice("recording:".length), media_type: "audio/mp4",
        start_ms: keyMs(key), ms: 600_000, loud_s: 300, quiet: false, asked: true,
      });
    }
    return [...parts.values()];
  }

  function fixtureHome(): Home {
    const home: Home = { index: index(`call-fixture-${++seq}`, KOLKATA), files: new Map(), clock: KOLKATA, now_ms: Date.parse("2026-10-06T12:00:00Z") };
    (home.index as SearchIndex).day(CALL_DAY.day, { inputs: CALL_DAY.inputs, mtime_us: ++seq, atoms: atomsOf(CALL_DAY) });
    home.files.set(CALL_DAY.day, CALL_DAY);
    const heads = CALL_DAY.atoms.filter((atom) => atom.family === CALLAUDIO_FAMILY && atom.item?.startsWith("stretch:") === true);
    home.extracts = new Map(heads.map((head) => callExtract(head.unit, partsOf(CALL_DAY.atoms, head.unit), { start_ms: head.start_ms!, end_ms: head.end_ms! })));
    return home;
  }

  const chatOf = (atom: DayAtom) => makeRef("chat", { key: atom.chat! });
  const said = (page: Chat) => page.lines.map((line) => ({ ...(line.from === undefined ? {} : { from: line.from }), text: line.text }));

  it("a call's key reads its head line and then its turns, each speaker as the day file named them; a joined call names the other side", () => {
    const home = fixtureHome();
    const [zoom, joined] = CALL_DAY.atoms.filter((atom) => atom.item?.startsWith("stretch:") === true);
    const page = read(home, { chat: chatOf(zoom!) }) as Chat;
    expect(page).toMatchObject({ what: "chat", chat: chatOf(zoom!), title: "Call on Zoom, 20 min: Lease renewal", span: { from: "2026-10-05", to: "2026-10-05" }, next: null });
    expect(said(page)).toEqual([
      { text: "Call on Zoom, 20 min: Lease renewal. You and they went over the lease renewal; you will send the signed copy." },
      { from: "You", text: "Hello, can you hear me?" }, { from: "Them", text: "Yes, I can hear you." },
      { from: "You", text: "Good. Shall we go over the lease?" }, { from: "Them", text: "Sure, the renewal is due next month." },
      { from: "You", text: "I will send the signed copy tonight." }, { from: "Them", text: "Great, thanks." },
    ]);
    expect(page.lines.every((line) => readRef(line.ref!, "ref").kind === "line" && line.at !== undefined)).toBe(true);
    expect(new Set(page.lines.map((line) => line.ref)).size).toBe(page.lines.length);
    expect(read(home, { ref: chatOf(zoom!) })).toEqual(page);
    const other = read(home, { chat: chatOf(joined!) }) as Chat;
    expect([other.title, said(other).slice(1)]).toEqual(["Call transcript: Weekend plans", [
      { from: "You", text: "Are we still on for Saturday?" }, { from: "Person B", text: "Yes, Saturday works for me." }, { from: "You", text: "I will book the table." },
    ]]);
  });

  it("a cited turn plays its own track from the turn's offset in its part: two turns of one part, two places; the person's own as mine, the other side by its name; the head line plays nothing", () => {
    const home = fixtureHome();
    const [zoom, joined] = CALL_DAY.atoms.filter((atom) => atom.item?.startsWith("stretch:") === true);
    const lines = (read(home, { chat: chatOf(zoom!) }) as Chat).lines;
    const [head, hello, hear, lease] = lines;
    const described = describeOf(home, [hello!.ref!, hear!.ref!, lease!.ref!]).described;
    const summary = describeOf(home, [head!.ref!]).described[0]!;
    expect(summary).toMatchObject({ kind: "line", chat: chatOf(zoom!), title: "Call on Zoom, 20 min: Lease renewal" });
    expect(summary).not.toHaveProperty("voice");
    const mic = makeRef("record", { source: MIC_SOURCE, kind: "mic-recording", key: "20261005T083000.000Z" });
    const sound = makeRef("record", { source: MIC_SOURCE, kind: "sound-recording", key: "20261005T083000.000Z" });
    expect(described.map((each) => [each.kind, (each as { voice?: unknown }).voice])).toEqual([
      ["line", { audio: `sha256:${CALL_DAY.atoms[1]!.item!.slice("recording:".length)}`, record: mic, seconds: 600, from_s: 1, mine: true }],
      ["line", { audio: `sha256:${CALL_DAY.atoms[2]!.item!.slice("recording:".length)}`, record: sound, seconds: 600, from_s: 11, from: "Them" }],
      ["line", { audio: `sha256:${CALL_DAY.atoms[1]!.item!.slice("recording:".length)}`, record: mic, seconds: 600, from_s: 21, mine: true }],
    ]);
    expect(described[1]).toMatchObject({ chat: chatOf(zoom!), chat_title: "Call on Zoom, 20 min: Lease renewal", day: "2026-10-05" });
    const person = (read(home, { chat: chatOf(joined!) }) as Chat).lines[2]!;
    expect((describeOf(home, [person.ref!]).described[0] as { voice?: unknown }).voice).toMatchObject({ from_s: 11, from: "Person B" });
  });

  it("a turn's ref, from the chat or from search, reads the call around that turn", () => {
    const home = fixtureHome();
    const [zoom] = CALL_DAY.atoms.filter((atom) => atom.item?.startsWith("stretch:") === true);
    const turn = (read(home, { chat: chatOf(zoom!) }) as Chat).lines[5]!;
    const around = read(home, { ref: turn.ref! }) as Chat;
    expect(around).toMatchObject({ what: "chat", chat: chatOf(zoom!), around: turn.ref });
    expect(around.lines.map((line) => line.ref)).toContain(turn.ref);
  });

  it("search finds a turn's words in the call family, the speaker leading its words under the call's title; another family's filter finds none", () => {
    const home = fixtureHome();
    const search = (params: Record<string, string>): SearchAnswer => onCall({ index: home.index, now_ms: home.now_ms!, settings: KOLKATA, epoch: 1 }, (call) => {
      const asked = searchAskedOf(paramsOf(searchParams, new URLSearchParams(params)));
      return answerOf("/v1/search", 200, JSON.parse(JSON.stringify(searchAnswerOf(asked, call, recordPartOf(asked, call).answer, undefined)))) as SearchAnswer;
    });
    const hits = search({ lists: "record", query: "works", families: "callaudio" }).record!.hits;
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ family: "callaudio", day: "2026-10-05", title: "Call transcript: Weekend plans", chat_title: "Call transcript: Weekend plans", chat: chatOf(CALL_DAY.atoms[8]!) });
    expect(JSON.stringify(hits[0]!.snippet)).toContain("Person B: Yes, Saturday");
    expect(readRef(hits[0]!.ref, "ref").kind).toBe("line");
    expect((read(home, { ref: hits[0]!.ref }) as Chat)).toMatchObject({ what: "chat", around: hits[0]!.ref });
    expect(search({ lists: "record", query: "works", families: "calls" }).record!.hits).toEqual([]);
  });

  it("a long call across the day's start pages through both days, each line once; its part's record ref reads the call around that part's first turn; a call with no words says so by its head", () => {
    const start = Date.parse("2026-10-06T20:00:00Z");
    const TURNS = 900;
    const partOf = (track: "mic" | "sound", i: number): CallPart => ({
      kind: `${track}-recording`, key: `${track}-${String(i).padStart(2, "0")}`, track, sha256: `${track === "mic" ? "a" : "b"}`.repeat(62) + String(i).padStart(2, "0"),
      media_type: "audio/mp4", start_ms: start + i * 600_000, ms: 600_000, loud_s: 300, quiet: false, asked: true,
    });
    const span = { start_ms: start, end_ms: start + TURNS * 15_000 };
    const pieces = Math.ceil((span.end_ms - start) / 600_000);
    const parts = (["mic", "sound"] as const).flatMap((track) => Array.from({ length: pieces }, (_, i) => partOf(track, i)));
    const unit = `${MIC_SOURCE}/mic-recording/mic-00`;
    const key = `${CALLAUDIO_FAMILY}:${unit}`;
    const record = (part: CallPart): RecordRef => ({ source: MIC_SOURCE, kind: part.kind, key: part.key });
    const title = "Call on Zoom, 3 h 45 min: Long review";
    const block = { title, chat: key };
    const head: Omit<AtomEntry, "n"> = { family: CALLAUDIO_FAMILY, unit, item: `stretch:${unit}`, record: record(parts[0]!), start_ms: start, end_ms: span.end_ms, text: `${title}. You and they went over a long review.`, ...block };
    const turns = Array.from({ length: TURNS }, (_, i): Omit<AtomEntry, "n"> => {
      const at = start + i * 15_000;
      const part = partOf(i % 2 === 0 ? "mic" : "sound", Math.floor((at - start) / 600_000));
      return {
        family: CALLAUDIO_FAMILY, unit, item: `recording:${part.sha256}`, record: record(part), start_ms: at, end_ms: at + 10_000,
        text: `${i % 2 === 0 ? "You" : "Them"}: synthetic turn ${i} ${"w".repeat(300)}`, ...block,
      };
    });
    const quiet = `${MIC_SOURCE}/mic-recording/mic-90`;
    const unheard: Omit<AtomEntry, "n"> = {
      family: CALLAUDIO_FAMILY, unit: quiet, item: `stretch:${quiet}`, record: { source: MIC_SOURCE, kind: "mic-recording", key: "mic-90" }, start_ms: span.end_ms + 3_600_000,
      end_ms: span.end_ms + 4_320_000, text: "Call on Zoom, 12 min (not transcribed)", title: "Call on Zoom, 12 min", chat: `${CALLAUDIO_FAMILY}:${quiet}`,
    };
    const home: Home = { index: index("call-long", KOLKATA), files: new Map(), clock: KOLKATA, now_ms: Date.parse("2026-10-08T12:00:00Z"), records: new Map() };
    const days = new Map<string, AtomEntry[]>();
    for (const atom of [head, ...turns, unheard]) {
      const day = civilDay(atom.start_ms!, KOLKATA);
      days.set(day, [...days.get(day) ?? [], { ...atom, n: days.get(day)?.length ?? 0 }]);
    }
    expect([...days.keys()]).toEqual(["2026-10-06", "2026-10-07"]);
    for (const [day, atoms] of days) (home.index as SearchIndex).day(day, { inputs: `in-${day}`, mtime_us: ++seq, atoms });
    for (const part of parts) home.records!.set(part.key, { text: "", start_ms: part.start_ms, family: CALLAUDIO_FAMILY });
    home.extracts = new Map([
      callExtract(unit, parts, span),
      callExtract(quiet, [{ ...partOf("mic", 90), start_ms: unheard.start_ms! }], { start_ms: unheard.start_ms!, end_ms: unheard.end_ms! }),
    ]);

    const pages: Chat[] = [read(home, { chat: makeRef("chat", { key }) }, "model") as Chat];
    while (pages.at(-1)!.next !== null && pages.at(-1)!.next !== undefined) {
      if (pages.length > 200) throw new Error("no end after 200 pages: the cursor does not progress");
      pages.push(read(home, { cursor: pages.at(-1)!.next! }, "model") as Chat);
    }
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.flatMap((page) => page.lines.map((line) => (line.from === undefined ? line.text : `${line.from}: ${line.text}`)))).toEqual([head, ...turns].map((atom) => atom.text));
    expect([pages[0]!.span.from, pages.at(-1)!.span.to]).toEqual(["2026-10-06", "2026-10-07"]);

    const late = parts.find((part) => part.track === "sound" && part.key === "sound-05")!;
    const given = makeRef("record", record(late));
    const around = read(home, { ref: given }) as Chat;
    expect(around).toMatchObject({ what: "chat", chat: makeRef("chat", { key }), around: given });
    const first = turns.find((turn) => turn.record!.key === late.key)!;
    expect(around.lines.map((line) => `${line.from}: ${line.text}`)).toContain(first.text);

    const none = read(home, { chat: makeRef("chat", { key: unheard.chat! }) }) as Chat;
    expect([none.title, said(none)]).toEqual(["Call on Zoom, 12 min", [{ text: "Call on Zoom, 12 min (not transcribed)" }]]);
    expect(codeOf(() => read(home, { chat: makeRef("chat", { key: `${CALLAUDIO_FAMILY}:${MIC_SOURCE}/mic-recording/mic-99` }) }))).toBe("BAD_PARAMETER");
  });

  it("a call's key and cursor from before a re-key read on under the key it has now: the old key names a part the call still holds", () => {
    const DAY = "2026-10-06";
    const start = Date.parse("2026-10-06T04:00:00Z");
    const TURNS = 600;
    const pieces = (TURNS * 15_000) / 600_000;
    const pad = (i: number) => String(i).padStart(2, "0");
    const partOf = (track: "mic" | "sound", i: number): CallPart => ({
      kind: `${track}-recording`, key: `${track}-${pad(i)}`, track, sha256: `${track === "mic" ? "c" : "d"}`.repeat(62) + pad(i),
      media_type: "audio/mp4", start_ms: start + i * 600_000, ms: 600_000, loud_s: 300, quiet: false, asked: true,
    });
    const record = (part: CallPart): RecordRef => ({ source: MIC_SOURCE, kind: part.kind, key: part.key });
    const title = "Call on Zoom, 2 h 30 min: Quarterly review";
    const callFrom = (from: number) => {
      const unit = `${MIC_SOURCE}/mic-recording/mic-${pad(from)}`;
      const key = `${CALLAUDIO_FAMILY}:${unit}`;
      const span = { start_ms: start + from * 600_000, end_ms: start + TURNS * 15_000 };
      const parts = (["mic", "sound"] as const).flatMap((track) => Array.from({ length: pieces - from }, (_, i) => partOf(track, from + i)));
      const head: Omit<AtomEntry, "n"> = {
        family: CALLAUDIO_FAMILY, unit, item: `stretch:${unit}`, record: record(parts[0]!), ...span, text: `${title}. You and they went over the quarter.`, title, chat: key,
      };
      const turns = Array.from({ length: TURNS }, (_, i) => i).filter((i) => start + i * 15_000 >= span.start_ms).map((i): Omit<AtomEntry, "n"> => {
        const at = start + i * 15_000;
        const part = partOf(i % 2 === 0 ? "mic" : "sound", Math.floor((at - start) / 600_000));
        return {
          family: CALLAUDIO_FAMILY, unit, item: `recording:${part.sha256}`, record: record(part), start_ms: at, end_ms: at + 10_000,
          text: `${i % 2 === 0 ? "You" : "Them"}: synthetic turn ${i} ${"w".repeat(300)}`, title, chat: key,
        };
      });
      const fact: DayFileFact = {
        id: `${CALLAUDIO_FAMILY}:${unit}`, family: CALLAUDIO_FAMILY, of: CALLAUDIO_FAMILY, time_ms: span.start_ms, ...span, keys: { app: "Zoom", call: "none" },
        measures: { minutes: (span.end_ms - span.start_ms) / 60_000 }, who: [], from: { units: [unit], record: record(parts[0]!), item: `stretch:${unit}` }, lines: [0],
      };
      return { key, atoms: [head, ...turns].map((atom, n): AtomEntry => ({ ...atom, n })), fact, extract: callExtract(unit, parts, span) };
    };
    const home: Home = { index: index("call-rekey", KOLKATA), files: new Map(), clock: KOLKATA, now_ms: Date.parse("2026-10-08T12:00:00Z"), records: new Map() };
    for (let i = 0; i < pieces; i++) for (const part of [partOf("mic", i), partOf("sound", i)]) home.records!.set(part.key, { text: "", start_ms: part.start_ms, family: CALLAUDIO_FAMILY });
    const hold = (call: ReturnType<typeof callFrom>) => {
      (home.index as SearchIndex).day(DAY, { inputs: `in-${call.key}`, mtime_us: ++seq, atoms: call.atoms, facts: { window: dayBounds(DAY, KOLKATA), facts: [call.fact] } });
      home.extracts = new Map([call.extract]);
    };
    const words = (page: Chat) => page.lines.map((line) => (line.from === undefined ? line.text : `${line.from}: ${line.text}`));
    const before = callFrom(2), after = callFrom(0);
    hold(before);
    const first = read(home, { chat: makeRef("chat", { key: before.key }) }, "model") as Chat;
    expect(first.next).toBeTypeOf("string");

    hold(after);
    const now = read(home, { chat: makeRef("chat", { key: before.key }) }, "model") as Chat;
    expect(now).toMatchObject({ what: "chat", chat: makeRef("chat", { key: after.key }), title });
    const pageOf = ({ next: _next, ...page }: Chat) => page;
    expect(pageOf(now)).toEqual(pageOf(read(home, { chat: makeRef("chat", { key: after.key }) }, "model") as Chat));
    expect(pageOf(read(home, { ref: makeRef("chat", { key: before.key }) }, "model") as Chat)).toEqual(pageOf(now));

    const rest: Chat[] = [read(home, { cursor: first.next! }, "model") as Chat];
    while (rest.at(-1)!.next !== null && rest.at(-1)!.next !== undefined) {
      if (rest.length > 200) throw new Error("no end after 200 pages: the cursor does not progress");
      rest.push(read(home, { cursor: rest.at(-1)!.next! }, "model") as Chat);
    }
    expect(rest[0]!.chat).toBe(makeRef("chat", { key: after.key }));
    expect([...words(first), ...rest.flatMap(words)]).toEqual(before.atoms.map((atom) => atom.text));
    expect(codeOf(() => read(home, { chat: makeRef("chat", { key: `${CALLAUDIO_FAMILY}:${MIC_SOURCE}/mic-recording/mic-${pad(pieces)}` }) }))).toBe("BAD_PARAMETER");
  });
});
