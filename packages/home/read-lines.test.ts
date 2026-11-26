import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DaySettings } from "@lifestreamprotocol/core";
import type { DayDocument } from "@lifestreamprotocol/families";
import { ANSWER_CHARS, type Call, type Reader } from "./call.js";
import { CITES_MOST, describedOf, MODEL_READ_CHARS, readAnswerOf, readSize, type ReadSources } from "./read.js";
import { lineRefAt, makeRef, readRef } from "./refs.js";
import { Refusal } from "./refusal.js";
import { answerOf, describeParams, paramsOf, readParams, type Citation, type ReadAnswer } from "./search-contract.js";
import { SearchIndex, type AtomEntry, type IndexedDay } from "./search-index.js";
import { callOf, type CallOf } from "./test/calls.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

const UTC: DaySettings = { zone: "UTC", day_start_hour: 0 };
const D = "2026-11-02";
const E = "2026-11-03";
const F = "2026-11-04";
const T0 = Date.parse(`${D}T08:00:00Z`);
const MINUTE = 60_000;
const NOTES = "notes:local:mac-0001";
const scratch = mkdtempSync(join(tmpdir(), "lifestream-read-lines-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let seq = 0;
function fresh(name: string): SearchIndex {
  const file = join(scratch, name, "index.db");
  mkdirSync(join(scratch, name), { recursive: true });
  const built = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, UTC);
  built.records([], [], { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } });
  built.finish();
  return SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, UTC);
}

const note = (n: number, text: string, at: number, extra: Partial<AtomEntry> = {}): AtomEntry => ({ n, family: "notes", unit: `notes/${D}`, start_ms: at, end_ms: null, text, ...extra });

function documentOf(day: string, inputs: string, atoms: readonly AtomEntry[], facts: DayDocument["facts"] = []): DayDocument {
  return {
    day, zone: "UTC", day_start_hour: 0, inputs, facts,
    atoms: atoms.map((atom) => ({
      n: atom.n, family: atom.family, unit: atom.unit, start_ms: atom.start_ms, end_ms: atom.end_ms, text: atom.text, local_start: null, local_end: null, flags: [],
      ...(atom.item === undefined ? {} : { item: atom.item }), ...(atom.record === undefined ? {} : { record: atom.record }),
      ...(atom.title === undefined ? {} : { block: { key: atom.unit, title: atom.title } }),
    })),
  } as unknown as DayDocument;
}

function write(index: SearchIndex, files: Map<string, DayDocument>, day: string, inputs: string, atoms: readonly AtomEntry[], facts: DayDocument["facts"] = []): void {
  const indexed: IndexedDay = { inputs, mtime_us: ++seq, atoms, facts: { window: { start_ms: Date.parse(`${day}T00:00:00Z`), end_ms: Date.parse(`${day}T00:00:00Z`) + 86_400_000 }, facts } };
  index.day(day, indexed);
  files.set(day, documentOf(day, inputs, atoms, facts));
}

interface Case {
  index: SearchIndex;
  files: Map<string, DayDocument>;
  pending?: string[];
  records?: Map<string, string>;
  unheld?: (of: unknown) => string | null;
}

function call(held: Case, params: Record<string, string | string[]>, reader: Reader = "person"): ReadAnswer {
  return onRoute(held, reader, (sources) => {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) for (const each of [value].flat()) query.append(name, each);
    return answerOf("/v1/read", 200, JSON.parse(JSON.stringify(readAnswerOf(paramsOf(readParams, query), sources)))) as ReadAnswer;
  });
}

function described(held: Case, refs: string[]): Citation[] {
  return onRoute(held, "person", (sources) => {
    const answer = describedOf(paramsOf(describeParams, new URLSearchParams(refs.map((ref): [string, string] => ["ref", ref]))), sources);
    return (answerOf("/v1/describe", 200, JSON.parse(JSON.stringify(answer))) as { described: Citation[] }).described;
  });
}

function onRoute<T>(held: Case, reader: Reader, work: (sources: ReadSources) => T): T {
  const over: CallOf = {
    index: held.index, now_ms: Date.parse(`${F}T12:00:00Z`), reader,
    fresh: () => ({ as_of: "2026-11-04T12:00+00:00", pending: (held.pending ?? []).map((day) => ({ day, why: "new" as const })) }),
  };
  const made = callOf(over);
  const view = {
    head: (record: { key: string }) => (held.records?.has(record.key) === true ? { version: `v-${record.key}`, start_ms: T0, stated_ms: T0 } : undefined),
    source: () => undefined, blobsOf: () => [], history: () => [],
  };
  Object.assign(made, { view: () => view });
  const sources = {
    call: made as Call,
    dayDocument: (day: string) => held.files.get(day),
    recordOf: (record: { key: string }) => ({ family: "notes", read: held.records?.has(record.key) === true ? { text: held.records.get(record.key)! } : null, product: undefined, dated: false }),
    name: (id: string) => id,
    screenIfReady: () => undefined,
    unheld: (of: unknown) => held.unheld?.(of) ?? null,
  } as unknown as ReadSources;
  try {
    return work(sources);
  } finally {
    made.end();
  }
}
const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof Refusal) return error.code;
    throw error;
  }
  return "answered";
};
type Lines = Extract<ReadAnswer, { what: "lines" }>;
type LineAnswer = Extract<ReadAnswer, { what: "line" }>;
const own = (answer: ReadAnswer, ref: string) => {
  const line = answer as LineAnswer;
  return { text: line.lines.find((each) => each.ref === ref)?.text, before: line.lines.findIndex((each) => each.ref === ref) };
};

describe("a photo with no picture", () => {
  it("reads why in a passage of its own; a photo whose picture is held, and a line of another family, are never asked", () => {
    const asked: unknown[] = [];
    const held: Case = { index: fresh("photo-unheld"), files: new Map(), unheld: (of) => (asked.push(of), "no picture yet: on its way from Example Phone") };
    const shown = `photo:${"a".repeat(64)}`;
    write(held.index, held.files, D, "in-1", [
      note(0, "Photo", T0, { family: "photos", unit: "photos/burst/1", item: shown }),
      note(1, "Photo", T0 + MINUTE, { family: "photos", unit: "photos/burst/1", item: "photo:apple:CLOUD-0001" }),
      note(2, "synthetic note", T0 + 2 * MINUTE),
    ]);
    const day = call(held, { from: D }) as Lines;
    expect(day.lines.map((line) => line.text)).toEqual(["Photo", "a picture: `read` it to see it", "Photo\n\nno picture yet: on its way from Example Phone", "synthetic note"]);
    expect(asked).toEqual([{ burst: "photos/burst/1", item: "photo:apple:CLOUD-0001" }]);
  });
});

describe("a day line's one identity", () => {
  it("a notes day, its lines one unit with no item: each line's ref opens that line, each once", () => {
    const held: Case = { index: fresh("notes-day"), files: new Map() };
    write(held.index, held.files, D, "in-1", [note(0, "synthetic first note", T0), note(1, "synthetic second note", T0 + MINUTE), note(2, "synthetic third note", T0 + 2 * MINUTE)]);
    const day = call(held, { from: D }) as Lines;
    expect(day.lines.map((line) => line.text)).toEqual(["synthetic first note", "synthetic second note", "synthetic third note"]);
    expect(new Set(day.lines.map((line) => line.ref)).size).toBe(3);
    for (const line of day.lines) expect(own(call(held, { ref: line.ref! }), line.ref!).text).toBe(line.text);
  });

  it("two equal lines: each ref opens its own, by its ordinal among the day's atoms of one `same`", () => {
    const held: Case = { index: fresh("equal-lines"), files: new Map() };
    write(held.index, held.files, D, "in-1", [note(0, "synthetic repeated words", T0), note(1, "synthetic repeated words", T0), note(2, "synthetic last words", T0 + MINUTE)]);
    const day = call(held, { from: D }) as Lines;
    const [first, second] = day.lines;
    expect(first!.ref).not.toBe(second!.ref);
    expect(own(call(held, { ref: first!.ref! }), first!.ref!).before).toBe(0);
    expect(own(call(held, { ref: second!.ref! }), second!.ref!).before).toBe(1);
  });

  it("a line inserted before the cited one, every number moved: the ref opens the line it named, at the revision now", () => {
    const held: Case = { index: fresh("inserted"), files: new Map() };
    write(held.index, held.files, D, "in-1", [note(0, "synthetic morning note", T0), note(1, "synthetic noon note", T0 + 4 * 60 * MINUTE)]);
    const cited = (call(held, { from: D }) as Lines).lines[1]!;
    write(held.index, held.files, D, "in-2", [note(0, "synthetic early note", T0 - 60 * MINUTE), note(1, "synthetic morning note", T0), note(2, "synthetic noon note", T0 + 4 * 60 * MINUTE)]);
    const opened = call(held, { ref: cited.ref! }) as LineAnswer;
    expect(own(opened, cited.ref!).text).toBe("synthetic noon note");
    expect(opened.rev).toBe("in-2");
  });

  it("a line printed again in new words: found again by its unit and item when they name one line; never a guess between two", () => {
    const held: Case = { index: fresh("new-words"), files: new Map() };
    const event = (n: number, text: string, item: string) => note(n, text, T0 + n * MINUTE, { family: "calendar", unit: `calendar/${item}`, item });
    write(held.index, held.files, D, "in-1", [event(0, "Synthetic standup", "e1"), event(1, "Synthetic review", "e2")]);
    const cited = (call(held, { from: D }) as Lines).lines[0]!;
    write(held.index, held.files, D, "in-2", [event(0, "Synthetic standup, moved", "e1"), event(1, "Synthetic review", "e2")]);
    expect(own(call(held, { ref: cited.ref! }), cited.ref!).text).toBe("Synthetic standup, moved");
    write(held.index, held.files, D, "in-3", [event(0, "Synthetic standup, part one", "e1"), event(1, "Synthetic standup, part two", "e1")]);
    expect(refusal(() => call(held, { ref: cited.ref! }))).toBe("LINE_MOVED");
    write(held.index, held.files, E, "in-1", [note(0, "synthetic draft", Date.parse(`${E}T08:00:00Z`), { unit: `notes/${E}` })]);
    const draft = (call(held, { from: E }) as Lines).lines[0]!;
    write(held.index, held.files, E, "in-2", [note(0, "synthetic draft, edited", Date.parse(`${E}T08:00:00Z`), { unit: `notes/${E}` })]);
    expect(refusal(() => call(held, { ref: draft.ref! }))).toBe("LINE_MOVED");
  });

  it("the search hit's ref, a stretch's line, a brief's cite and a count's fact are one: made by one function, they open alike", () => {
    const held: Case = { index: fresh("one-function"), files: new Map() };
    const atoms = [note(0, "synthetic note one", T0), note(1, "synthetic note one", T0), note(2, "synthetic note two", T0 + MINUTE)];
    write(held.index, held.files, D, "in-1", atoms);
    const lines = (call(held, { from: D }) as Lines).lines.map((line) => line.ref!);
    const hold = held.index.hold({});
    let atIndex: (string | null)[];
    try {
      atIndex = hold.read.facts((read) => atoms.map((atom) => lineRefAt(read, D, atom.n)));
    } finally {
      hold.end();
    }
    expect(atIndex).toEqual(lines);
    const brief = call(held, { from: D, to: F, detail: "brief" }) as Extract<ReadAnswer, { what: "brief" }>;
    const cited = brief.days[0]!.lines.flatMap((line) => line.cites ?? []);
    expect(cited.length).toBeGreaterThan(0);
    for (const cite of cited) expect(lines).toContain(cite);
  });
});

describe("a day the index still reads", () => {
  it("a brief states as_of and pending; its cite of a line the index has not read opens from the same day.json; a line that left it is LINE_MOVED", () => {
    const held: Case = { index: fresh("pending"), files: new Map() };
    write(held.index, held.files, D, "in-1", [note(0, "synthetic note held", T0)]);
    held.files.set(D, documentOf(D, "in-2", [note(0, "synthetic note held", T0), note(1, "synthetic note the index lacks", T0 + MINUTE)]));
    held.pending = [D];
    const brief = call(held, { from: D, to: F, detail: "brief" }) as Extract<ReadAnswer, { what: "brief" }>;
    expect(brief).toMatchObject({ as_of: "2026-11-04T12:00+00:00", pending: [{ day: D, why: "new" }] });
    const cites = brief.days[0]!.lines.flatMap((line) => line.cites ?? []);
    const lacking = cites.find((cite) => refusal(() => call({ ...held, pending: [] }, { ref: cite })) === "LINE_MOVED");
    expect(lacking).toBeDefined();
    const opened = call(held, { ref: lacking! }) as LineAnswer;
    expect(own(opened, lacking!).text).toBe("synthetic note the index lacks");
    expect(opened).toMatchObject({ rev: "in-2", pending: [{ day: D, why: "new" }] });
    const left = makeRef("line", { ...readRef(lacking!, "ref", ["line"]).parts, same: "0000000000000000" });
    expect(refusal(() => call(held, { ref: left }))).toBe("LINE_MOVED");
  });
});

describe("a brief", () => {
  it("is of any stretch: part of a day asked as a brief sums only the lines inside its instants, never past them (Sol R4-9)", () => {
    const held: Case = { index: fresh("brief-part"), files: new Map() };
    const atoms = [note(0, "synthetic note before", T0), note(1, "synthetic note inside", T0 + 90 * MINUTE, { unit: "notes/inside" }), note(2, "synthetic note after", T0 + 180 * MINUTE, { unit: "notes/after" })];
    write(held.index, held.files, D, "in-1", atoms);
    const part = { from: `${D}T09:00:00Z`, to: `${D}T10:00:00Z` };
    const cites = (answer: ReadAnswer) => (answer as Extract<ReadAnswer, { what: "brief" }>).days.flatMap((day) => day.lines.flatMap((line) => line.cites ?? [])).sort();
    const inside = (call(held, part) as Lines).lines.map((line) => line.ref!);
    expect(inside).toHaveLength(1);
    expect(cites(call(held, { ...part, detail: "brief" }))).toEqual(inside);
    expect(cites(call(held, { from: D, detail: "brief" }))).toEqual((call(held, { from: D }) as Lines).lines.map((line) => line.ref!).sort());
  });

  it("under `families`, sums only the families it keeps (its counts and its overflow of them); each line cites CITES_MOST at most and counts the rest", () => {
    const held: Case = { index: fresh("brief-filter"), files: new Map() };
    const chats = Array.from({ length: 8 }, (_, at) => note(at, `message ${at}`, T0 + at * MINUTE, { family: "messages", unit: `messages/chat-${at}`, title: `Chat ${at}` }));
    const calls = Array.from({ length: 20 }, (_, at) => note(8 + at, `Call ${at}`, T0 + (8 + at) * MINUTE, { family: "calls", unit: `calls/c${at}`, item: `c${at}` }));
    const many = Array.from({ length: 30 }, (_, at) => note(28 + at, `synthetic photo ${at}`, T0 + (28 + at) * MINUTE, { family: "photos", unit: `photos/p${at}`, item: `p${at}` }));
    write(held.index, held.files, D, "in-1", [...chats, ...calls, ...many]);
    const all = call(held, { from: D, to: F, detail: "brief" }) as Extract<ReadAnswer, { what: "brief" }>;
    expect(all.days[0]!.lines.map((line) => line.text)).toContain("and 21 more");
    const messages = call(held, { from: D, to: F, detail: "brief", families: "messages" }) as Extract<ReadAnswer, { what: "brief" }>;
    expect(messages.days[0]!.lines.map((line) => line.text)).toEqual(chats.map((atom) => `${atom.title}: 1 message`));
    const photos = all.days[0]!.lines.find((line) => line.text === "30 photos")!;
    expect(photos.cites).toHaveLength(CITES_MOST);
    expect(photos.cites_more).toBe(30 - CITES_MOST);
  });
});

describe("raw", () => {
  it("a record printed on two days, across a page's boundary: given once, at the first line of the stretch that prints it", () => {
    const held: Case = { index: fresh("raw-once"), files: new Map(), records: new Map() };
    const record = (key: string) => ({ source: NOTES, kind: "note", key });
    const onD = Array.from({ length: 60 }, (_, at) => note(at, `synthetic record ${at}`, T0 + at * MINUTE, { unit: `notes/r${at}`, record: record(`r${at}`) }));
    for (let at = 0; at < 60; at++) held.records!.set(`r${at}`, `synthetic record ${at} whole`);
    write(held.index, held.files, D, "in-1", onD);
    write(held.index, held.files, E, "in-1", [note(0, "synthetic record 0, again", Date.parse(`${E}T08:00:00Z`), { unit: "notes/r0", record: record("r0") }), note(1, "synthetic record 59, again", Date.parse(`${E}T09:00:00Z`), { unit: "notes/r59", record: record("r59") })]);
    const keys: string[] = [];
    let page = call(held, { from: D, to: E, detail: "raw" }) as Extract<ReadAnswer, { what: "raw" }>;
    for (let n = 0; ; n++) {
      keys.push(...page.records.map((each) => readRef(each.ref, "ref", ["record"]).parts.key));
      if (page.next === null || page.next === undefined || n > 5) break;
      page = call(held, { cursor: page.next }) as Extract<ReadAnswer, { what: "raw" }>;
    }
    expect(keys).toEqual(Array.from({ length: 60 }, (_, at) => `r${at}`));
    const alone = call(held, { from: E, detail: "raw" }) as Extract<ReadAnswer, { what: "raw" }>;
    expect(alone.records.map((each) => readRef(each.ref, "ref", ["record"]).parts.key)).toEqual(["r0", "r59"]);
  });
});

describe("what a day line is (describe)", () => {
  it("names its day, its words and where Days opens it; found again as `read` finds it once its day is printed again; gone once it left", () => {
    const held: Case = { index: fresh("described"), files: new Map() };
    const event = (n: number, text: string, item: string, at: number) => note(n, text, at, { family: "calendar", unit: `calendar/${item}`, item, title: "" });
    write(held.index, held.files, D, "in-1", [event(0, "Synthetic standup", "e1", T0), event(1, "Synthetic review", "e2", T0 + 60 * MINUTE)]);
    const [standup, review] = (call(held, { from: D }) as Lines).lines.map((line) => line.ref!);
    const plain = described(held, [standup!, review!]);
    expect(plain).toEqual([
      { ref: standup, kind: "line", day: D, at: "2026-11-02T08:00+00:00", title: "Synthetic standup", opens: { page: "days", day: D, focus: "u:calendar/e1" } },
      { ref: review, kind: "line", day: D, at: "2026-11-02T09:00+00:00", title: "Synthetic review", opens: { page: "days", day: D, focus: "u:calendar/e2" } },
    ]);
    write(held.index, held.files, D, "in-2", [event(0, "Synthetic early call", "e0", T0 - 60 * MINUTE), event(1, "Synthetic standup, moved", "e1", T0), event(2, "Synthetic review", "e2", T0 + 60 * MINUTE)]);
    expect(described(held, [standup!, review!]).map((each) => (each.kind === "line" ? each.title : each.kind))).toEqual(["Synthetic standup, moved", "Synthetic review"]);
    write(held.index, held.files, D, "in-3", [event(0, "Synthetic early call", "e0", T0 - 60 * MINUTE)]);
    expect(refusal(() => call(held, { ref: review! }))).toBe("LINE_MOVED");
    expect(described(held, [review!])).toEqual([{ ref: review, kind: "gone", why: expect.stringContaining("no longer in its day") }]);
  });

  it("a line of a day the index still reads is described from the day.json its brief cites from", () => {
    const held: Case = { index: fresh("described-pending"), files: new Map() };
    write(held.index, held.files, D, "in-1", [note(0, "synthetic note held", T0)]);
    held.files.set(D, documentOf(D, "in-2", [note(0, "synthetic note held", T0), note(1, "synthetic note the index lacks", T0 + MINUTE)]));
    held.pending = [D];
    const brief = call(held, { from: D, to: F, detail: "brief" }) as Extract<ReadAnswer, { what: "brief" }>;
    const cites = brief.days[0]!.lines.flatMap((line) => line.cites ?? []);
    const titles = described(held, cites).map((each) => (each.kind === "line" ? each.title : each.kind));
    expect(titles).toContain("synthetic note the index lacks");
  });
});

describe("one answer size, the call's reader's", () => {
  it("a model reader's page is never over 20,000 characters as it reads them, each ref a handle, and gives every line once; the person's goes past it", () => {
    const held: Case = { index: fresh("sizes"), files: new Map() };
    const words = (n: number) => `synthetic line ${n}: ${"word ".repeat(60).trim()}`;
    write(held.index, held.files, D, "in-1", Array.from({ length: 240 }, (_, n) => note(n, words(n), T0 + n * MINUTE)));
    const person = call(held, { from: D }) as Lines;
    expect(JSON.stringify(person).length).toBeGreaterThan(ANSWER_CHARS.model);
    expect(JSON.stringify(person).length).toBeLessThanOrEqual(ANSWER_CHARS.person);
    const pages: Lines[] = [call(held, { from: D }, "model") as Lines];
    for (let n = 0; pages.at(-1)!.next !== null && pages.at(-1)!.next !== undefined && n < 40; n++) pages.push(call(held, { cursor: pages.at(-1)!.next! }, "model") as Lines);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(readSize("model")(page)).toBeLessThanOrEqual(MODEL_READ_CHARS);
    expect(pages.flatMap((page) => page.lines.map((line) => line.text))).toEqual(Array.from({ length: 240 }, (_, n) => words(n)));
  });
});
