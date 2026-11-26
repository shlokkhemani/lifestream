import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { civilDay, instantIn, openHomeFolder, type DaySettings } from "@lifestreamprotocol/core";
import { argumentsWritten, ARGUMENTS_BYTES, NEXT_CHARS } from "./cursor-text.js";
import { makeRef, readRef } from "./refs.js";
import { Refusal } from "./refusal.js";
import { ScreenIndex, type ScreenFrame, type ScreenSegment } from "./screen-index.js";
import { cursorText, type ScreenCursor } from "./screen-query.js";
import { askedOf, closeVectorScan, type HeldMeaning } from "./screen-reads.js";
import { DIM } from "./screen-scan-wasm.js";
import { answerOf, paramsOf, searchParams, type ScreenList, type SearchAnswer } from "./search-contract.js";
import { SearchIndex, type RecordEntry } from "./search-index.js";
import { meaningAsked, recordPartOf, screenAnswerOf, screenNextOf, screenRoom, searchAnswerOf, searchAskedOf, type Lent, type ScreenOptions } from "./search-route.js";
import { onCall, type CallOf } from "./test/calls.js";
import type { Call } from "./call.js";
import type { Presence } from "./presence.js";


const DAYS: DaySettings = { zone: "UTC", day_start_hour: 0 };
const DAY = 86_400_000;
const MIN = 60_000;
const NOW = Date.parse("2026-11-14T12:00:00Z");
const D0 = Date.parse("2026-11-10T09:00:00Z");
const MODEL = "embeddinggemma-2-q8-512";
const ON = { unit: "runner-macbook-pro-0001", file: MODEL, power: "plugged-idle" } as const;
const OFF = null;
const scratch = mkdtempSync(join(tmpdir(), "lifestream-search-screen-"));
afterAll(async () => {
  await closeVectorScan();
  rmSync(scratch, { recursive: true, force: true });
});
let files = 0;

const WORDS = ["amber", "basil", "cobalt", "delta", "ember", "fjord", "garnet", "harbor", "indigo", "juniper", "kelp", "lumen", "meadow", "nectar", "onyx", "pepper"];
const sentence = (seed: number, word = "") => `${word} Example post ${seed}: ${Array.from({ length: 12 }, (_, i) => WORDS[(seed * 5 + i * 3) % WORDS.length]).join(" ")}.`.trim();

interface Window {
  from: number;
  app: string;
  site?: string | null;
  title: string;
  lines: string[];
}

function segmentsOf(windows: readonly Window[]): ScreenSegment[] {
  return windows.map((window) => {
    const frames: ScreenFrame[] = Array.from({ length: 5 }, (_, f) => ({
      t: window.from + f * 4_000, app: window.app, site: window.site ?? null, title: window.title, display: "1", lines: window.lines,
    }));
    return { machine: "mac-0001", version: "v1", start_ms: window.from, frames };
  });
}

function vectorFor(text: string): Float32Array {
  const vector = new Float32Array(DIM);
  let seed = createHash("sha256").update(text).digest();
  for (let i = 0; i < DIM; i++) {
    if (i % 32 === 0 && i > 0) seed = createHash("sha256").update(seed).digest();
    vector[i] = seed[i % 32]! / 127.5 - 1;
  }
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
}

function screenFile(windows: readonly Window[], options: { meaning?: boolean; seq?: number } = {}): string {
  const file = join(scratch, `s${++files}`, "screen.db");
  mkdirSync(join(scratch, `s${files}`), { recursive: true });
  const meaning = options.meaning === true ? MODEL : false;
  const held = segmentsOf(windows);
  const source = { segments: (machine: string, day: string) => held.filter((each) => each.machine === machine && civilDay(each.start_ms, DAYS) === day) };
  const build = ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: DAYS, meaning }, () => true);
  build.apply(held, source, { seq: options.seq ?? 7 });
  build.finish();
  const index = ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: DAYS, meaning }, () => true);
  if (options.meaning === true) {
    const queued = index.queued(10_000);
    index.land({ model: MODEL, generation: index.generation() }, queued.map((each) => ({ textHash: each.textHash, vector: vectorFor(each.text) })));
  }
  index.close();
  return file;
}

function recordIndex(name: string, entries: RecordEntry[]): SearchIndex {
  const file = join(scratch, name, "index.db");
  mkdirSync(join(scratch, name), { recursive: true });
  const built = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, DAYS);
  built.records(entries, [], { position: { seq: 1, statement: "s-1", reread: 0 } });
  built.finish();
  return SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, DAYS);
}
const note = (key: string, words: string, start_ms: number): RecordEntry => ({
  record: { source: "notes:local:mac-0001", kind: "item", key }, family: "notes", version: `v-${key}`, start_ms, end_ms: null, title: "", text: words, who: [], link: null,
});

const stated = (seq: number) => instantIn(NOW - seq * MIN, "UTC");

interface Asking {
  screen: string | "none" | "busy";
  record?: SearchIndex;
  meaning?: HeldMeaning;
  search?: ScreenOptions["meaningModel"];
  epoch?: number;
  where?: Presence;
  lent?: Lent;
}

async function ask(params: Record<string, string | string[]>, how: Asking): Promise<SearchAnswer> {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) for (const each of Array.isArray(value) ? value : [value]) query.append(name, each);
  const asked = searchAskedOf(paramsOf(searchParams, query));
  const epoch = how.epoch ?? 1;
  const file = how.screen;
  const over: CallOf = { epoch, now_ms: NOW, screen: file, asOf: (seq) => (seq === 0 ? null : stated(seq)), ...(how.record === undefined ? {} : { index: how.record }) };
  const placed = (call: Call): Call => (how.where === undefined ? call : Object.assign(call, { whereIfReady: () => how.where }));
  const answer = await onCall(over, async (call) => {
    const on = placed(call);
    const record = asked.lists.includes("record") && how.record !== undefined ? recordPartOf(asked, on) : undefined;
    const screen = asked.lists.includes("screen") ? await screenAnswerOf(asked, on, {
      meaningModel: how.search ?? OFF, file: typeof file === "string" ? file : "",
      ...(how.meaning === undefined ? {} : { meaning: how.meaning }), ...(record?.copies === undefined ? {} : { copies: record.copies }),
      ...(how.lent === undefined ? {} : { lent: how.lent }),
    }) : undefined;
    return searchAnswerOf(asked, on, record?.answer, screen);
  });
  return answerOf("/v1/search", 200, JSON.parse(JSON.stringify(answer))) as SearchAnswer;
}
async function refused(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    if (error instanceof Refusal) return error.code;
    throw error;
  }
  return "answered";
}
const listOf = (answer: SearchAnswer): ScreenList => {
  expect(answer.screen).not.toHaveProperty("unread");
  return answer.screen as ScreenList;
};
const titles = (list: ScreenList) => list.hits.map((hit) => hit.title);

function ospreys(): Window[] {
  return [
    ...Array.from({ length: 15 }, (_, n): Window => ({ from: D0 - n * DAY + n * MIN, app: "Example Browser", site: "example.com", title: `Osprey ${n}`, lines: [`osprey sighting number ${n} on the shore`] })),
    { from: D0 + 30 * MIN, app: "WhatsApp", title: "Person A", lines: ["the osprey came back"] },
    { from: D0 + 40 * MIN, app: "Example Notes", title: "Grocery list", lines: ["bread and milk"] },
  ];
}

describe("the screen's list", () => {
  it("SC1 reads each filter as section 2.4's table says", async () => {
    const file = screenFile(ospreys());
    const plain = listOf(await ask({ query: "osprey", lists: "screen" }, { screen: file }));
    expect(plain.total).toBe(16);
    expect(listOf(await ask({ query: "osprey", lists: "screen", families: ["screen", "notes"] }, { screen: file })).total).toBe(16);
    expect(await ask({ query: "osprey", lists: "screen", families: "notes" }, { screen: file })).not.toHaveProperty("screen");
    expect(titles(listOf(await ask({ query: "osprey", lists: "screen", products: "whatsapp" }, { screen: file })))).toEqual(["Person A"]);
    expect((await ask({ query: "osprey", lists: "screen", products: ["whatsapp", "example-bank"] }, { screen: file })).screen).toEqual({ unread: "the screen keeps no table of the windows of example-bank" });
    expect((await ask({ query: "osprey", lists: "screen", person: "Person A" }, { screen: file })).screen).toEqual({ unread: "the screen records no person" });
    expect((await ask({ query: "osprey", lists: "screen", chat: makeRef("chat", { key: "whatsapp:a" }) }, { screen: file })).screen).toEqual({ unread: "the screen records no chat" });
    expect((await ask({ query: "osprey", lists: "screen", place: "Example City" }, { screen: file })).screen).toEqual({ unread: "the screen records no place" });
    expect((await ask({ lists: "screen", order: "newest" }, { screen: file })).screen).toEqual({ unread: "the screen is searched by its words, and none were asked" });
    const dated = listOf(await ask({ query: "osprey", lists: "screen", from: civilDay(D0 - 3 * DAY, DAYS), to: civilDay(D0 - 2 * DAY, DAYS) }, { screen: file }));
    expect(titles(dated).sort()).toEqual(["Osprey 2", "Osprey 3"]);
    expect((await ask({ query: "osprey", lists: "screen" }, { screen: "none" })).screen).toEqual({ unread: "the screen index is being built" });
    expect((await ask({ query: "osprey", lists: "screen" }, { screen: "busy" })).screen).toEqual({ unread: "the screen index is being written" });
  });

  it("SC2 states each hit as the contract's: a window ref, its minute or span as instants, also, as_of of its own read", async () => {
    const twins = [
      { from: D0, app: "Example Browser", site: "example.com", title: "Twin One", lines: ["a heron stood in the reeds"] },
      { from: D0 + 10 * MIN, app: "Example Browser", site: "example.com", title: "Twin Two", lines: ["a heron stood in the reeds"] },
      { from: D0 - DAY, app: "Example Mail", title: "Heron watch", lines: ["unrelated text"] },
    ];
    const file = screenFile(twins, { seq: 42 });
    const list = listOf(await ask({ query: "heron", lists: "screen" }, { screen: file }));
    expect(list.as_of).toBe(stated(42));
    expect(list.total).toBe(3);
    const folded = list.hits.find((hit) => hit.also !== undefined)!;
    expect(folded.also).toBe(1);
    expect(["Twin One", "Twin Two"]).toContain(folded.title);
    const ref = readRef(folded.ref, "ref", ["window"]);
    expect(ref).toMatchObject({ kind: "window", parts: { machine: "mac-0001", day: "2026-11-10", app: "Example Browser", site: "example.com", name: folded.title } });
    expect(folded.at).toMatch(/^2026-11-10T09:\d{2}\+00:00$/u);
    expect(folded.until).toBeUndefined();
    expect(instantIn(ref.parts.at_ms!, "UTC")).toBe(folded.at);
    const titled = list.hits.find((hit) => hit.title === "Heron watch")!;
    expect(titled).toMatchObject({ app: "Example Mail", day: "2026-11-09", reason: "words", time_precision: "range", snippet: "«Heron» watch" });
    expect(titled.until).toEqual(expect.stringMatching(/\+00:00$/u));
    expect(readRef(titled.ref, "ref", ["window"]).parts.at_ms).toBeNull();
    expect(JSON.stringify(list)).not.toMatch(/"(?:score|rank|runs|time|evidence)"/u);
  });

  it("SC3 adds the hits by meaning where it is on, once each, and says meaning's state", async () => {
    const shared = sentence(1, "osprey");
    const other = sentence(3);
    const file = screenFile([
      { from: D0, app: "Example Browser", site: "example.com", title: "Osprey Post", lines: [shared, sentence(2)] },
      { from: D0 - DAY, app: "Example Reader", title: "Quiet Page", lines: [other, sentence(4)] },
    ], { meaning: true });
    const asked = (text: string) => askedOf(MODEL, vectorFor(text));
    const on = listOf(await ask({ query: "osprey", lists: "screen" }, { screen: file, search: ON, meaning: asked(other) }));
    expect(on.meaning).toBe("on");
    expect(on.hits[0]).toMatchObject({ title: "Osprey Post", reason: "words" });
    expect(on.hits.slice(1).every((hit) => hit.reason === "meaning")).toBe(true);
    expect(on.hits[1]).toMatchObject({ title: "Quiet Page", reason: "meaning", day: "2026-11-09" });
    const byBlock = (list: ScreenList) => list.hits.filter((hit) => hit.reason === "meaning" && hit.until === undefined).map((hit) => hit.snippet);
    expect(byBlock(on)).not.toContain(shared);
    const elsewhere = listOf(await ask({ query: "quiet", lists: "screen" }, { screen: file, search: ON, meaning: asked(shared) }));
    expect(elsewhere.hits[0]).toMatchObject({ title: "Quiet Page", reason: "words" });
    expect(byBlock(elsewhere)).toContain(shared);
    const same = listOf(await ask({ query: "osprey", lists: "screen" }, { screen: file, search: ON, meaning: asked(shared) }));
    expect(same.hits[0]).toMatchObject({ title: "Osprey Post", reason: "words" });
    expect(same.hits[0]!.until).toBeUndefined();
    expect(byBlock(same)).not.toContain(shared);
    expect(byBlock(same).length).toBeGreaterThan(0);
    expect(listOf(await ask({ query: "osprey", lists: "screen" }, { screen: file, search: OFF })).meaning).toBe("off");
    expect(listOf(await ask({ query: '"osprey"', lists: "screen" }, { screen: file, search: ON, meaning: asked(other) })).meaning).toBe("not_asked");
    const away = listOf(await ask({ query: "osprey", lists: "screen" }, { screen: file, search: ON, meaning: { waits: "Search by meaning waits for its runner." } }));
    expect([away.meaning, away.waits, away.hits.map((hit) => hit.reason)]).toEqual(["waits", "Search by meaning waits for its runner.", ["words"]]);
    const plain = screenFile([{ from: D0, app: "Example Browser", title: "Osprey Post", lines: [shared] }]);
    const notYet = listOf(await ask({ query: "osprey", lists: "screen" }, { screen: plain, search: ON, meaning: asked(other) }));
    expect(notYet.meaning).toBe("waits");
    expect(notYet.waits).toEqual(expect.any(String));
  });

  it("SC3 reads meaning on a call's first page alone", async () => {
    const other = sentence(3);
    const file = screenFile([...ospreys(), { from: D0 - 2 * DAY, app: "Example Reader", title: "Quiet Page", lines: [other] }], { meaning: true });
    const meaning = askedOf(MODEL, vectorFor(other));
    const first = listOf(await ask({ query: "osprey", lists: "screen" }, { screen: file, search: ON, meaning }));
    expect(first.hits.filter((hit) => hit.reason === "meaning").map((hit) => hit.title)).toContain("Quiet Page");
    const second = listOf(await ask({ cursor: first.next! }, { screen: file, search: ON, meaning }));
    expect(second.meaning).toBe("on");
    expect(second.hits.every((hit) => hit.reason !== "meaning")).toBe(true);
  });

  it("SC3 an older stretch a `next` starts reads meaning: the door embeds the cursor's query, and a match by meaning alone is given there", async () => {
    const other = sentence(3);
    const file = screenFile([
      { from: D0, app: "Example Browser", title: "Osprey Post", lines: [sentence(1, "osprey")] },
      { from: D0 - 400 * DAY, app: "Example Reader", title: "Old Quiet Page", lines: [other] },
    ], { meaning: true });
    const meaning = askedOf(MODEL, vectorFor(other));
    const first = listOf(await ask({ query: "osprey", lists: "screen" }, { screen: file, search: ON, meaning }));
    expect(first.hits.map((hit) => hit.title)).not.toContain("Old Quiet Page");
    expect(first.next_gives).toBe("days");
    expect(meaningAsked(new URLSearchParams({ cursor: first.next! }))).toBe("osprey");
    const older = listOf(await ask({ cursor: first.next! }, { screen: file, search: ON, meaning }));
    expect(older.meaning).toBe("on");
    expect(older.hits.map((hit) => [hit.title, hit.reason])).toContainEqual(["Old Quiet Page", "meaning"]);
    expect(listOf(await ask({ cursor: first.next! }, { screen: file, search: ON })).meaning).toBe("waits");
    const within = listOf(await ask({ query: "osprey", lists: "screen" }, { screen: screenFile(ospreys(), { meaning: true }), search: ON, meaning }));
    expect(within.next_gives).toBe("windows");
    expect(meaningAsked(new URLSearchParams({ cursor: within.next! }))).toBeUndefined();
  });

  it("SC8 meaning keeps the products asked: a window of another product is never given by meaning; the product's own come past nearer others", async () => {
    const other = sentence(3);
    const file = screenFile([
      { from: D0, app: "WhatsApp", title: "Person A", lines: ["the osprey came back", sentence(5)] },
      { from: D0 - DAY, app: "Example Reader", title: "Quiet Page", lines: [other] },
      { from: D0 - 2 * DAY, app: "WhatsApp", title: "Person B", lines: [sentence(6)] },
    ], { meaning: true });
    const meaning = askedOf(MODEL, vectorFor(other));
    const byMeaning = (list: ScreenList) => list.hits.filter((hit) => hit.reason === "meaning");
    const every = listOf(await ask({ query: "osprey", lists: "screen" }, { screen: file, search: ON, meaning }));
    expect(byMeaning(every).map((hit) => hit.title)).toContain("Quiet Page");
    const kept = listOf(await ask({ query: "osprey", lists: "screen", products: "whatsapp" }, { screen: file, search: ON, meaning }));
    expect(kept.meaning).toBe("on");
    expect(titles({ ...kept, hits: kept.hits.filter((hit) => hit.reason !== "meaning") })).toEqual(["Person A"]);
    expect(byMeaning(kept).length).toBeGreaterThan(0);
    expect(byMeaning(kept).every((hit) => hit.app === "WhatsApp")).toBe(true);
    expect(byMeaning(kept).map((hit) => hit.title)).toContain("Person B");
  });

  it("SC4 one call, two lists, two cursors: each cursor answers its list alone, whichever ends first", async () => {
    const file = screenFile(ospreys());
    const few = recordIndex("sc4a", [note("a", "osprey on the lake", D0), note("b", "osprey again", D0 - DAY)]);
    const both = await ask({ query: "osprey", lists: ["record", "screen"] }, { screen: file, record: few });
    expect(both.record!.next).toBeNull();
    const screen = listOf(both);
    expect([screen.hits.length, screen.capped, screen.next]).toEqual([10, true, expect.any(String)]);
    const on = await ask({ cursor: screen.next! }, { screen: file, record: few });
    expect(on).not.toHaveProperty("record");
    const rest = listOf(on);
    expect(rest.hits).toHaveLength(6);
    expect(rest.next).toBeNull();
    expect(new Set([...titles(screen), ...titles(rest)]).size).toBe(16);
    const many = recordIndex("sc4b", Array.from({ length: 30 }, (_, n) => note(`m${n}`, "osprey notes", D0 - n * DAY)));
    const small = screenFile(ospreys().slice(0, 3));
    const again = await ask({ query: "osprey", lists: ["record", "screen"], limit: "10" }, { screen: small, record: many });
    expect(listOf(again).next).toBeNull();
    expect(again.record!.next).toEqual(expect.any(String));
    const records = await ask({ cursor: again.record!.next! }, { screen: small, record: many });
    expect(records).not.toHaveProperty("screen");
    expect(records.record!.hits).toHaveLength(10);
  });

  it("SC5 a screen cursor holding windows given expires with the epoch and the file; with other arguments it is refused", async () => {
    const file = screenFile(ospreys());
    const first = listOf(await ask({ query: "osprey", lists: "screen" }, { screen: file }));
    const next = first.next!;
    expect(await refused(() => ask({ cursor: next }, { screen: file }))).toBe("answered");
    expect(await refused(() => ask({ cursor: next, query: "osprey" }, { screen: file }))).toBe("answered");
    expect(await refused(() => ask({ cursor: next, query: "heron" }, { screen: file }))).toBe("BAD_PARAMETER");
    expect(await refused(() => ask({ cursor: next }, { screen: file, epoch: 2 }))).toBe("CURSOR_EXPIRED");
    expect(await refused(() => ask({ cursor: next }, { screen: screenFile(ospreys()) }))).toBe("CURSOR_EXPIRED");
  });

  it("SC7 a screen.db that has read no statement states no as_of, never one invented, and the contract takes it", async () => {
    const file = screenFile([{ from: D0, app: "Example Browser", site: "example.com", title: "Egret", lines: ["an egret on the mudflat"] }], { seq: 0 });
    const list = listOf(await ask({ query: "egret", lists: "screen" }, { screen: file }));
    expect(list.hits).toHaveLength(1);
    expect(list).not.toHaveProperty("as_of");
  });

  it("SC6 the largest screen next, its arguments at their bound as a cursor holds them, is under 6,000 characters", () => {
    const products = Array.from({ length: 40 }, (_, n) => `product-${n}`);
    const filled = (query: string) => argumentsWritten("screen", { query, products }).length;
    const args = { query: "x".repeat(ARGUMENTS_BYTES - filled("")), products };
    expect(filled(args.query)).toBe(ARGUMENTS_BYTES);
    const room = screenRoom(args);
    const at: ScreenCursor = { newest: "2026-11-14", oldest: "2025-11-14", upto_ms: NOW, by_day: true, place: { key: 2n ** 62n, day: "2025-11-15" }, given: [] };
    for (let n = 0n; ; n++) {
      const grown = { ...at, given: [...at.given, { key: -(2n ** 63n) + n * (2n ** 55n), day: "2025-11-15" }] };
      if (cursorText(grown).length > room) break;
      at.given = grown.given;
    }
    expect(cursorText(at).length).toBeGreaterThan(room - 20);
    const text = screenNextOf(at, true, args, "a-generation", 1);
    expect(text.length).toBeLessThanOrEqual(NEXT_CHARS);
    expect(screenRoom({ query: "osprey" })).toBeGreaterThan(room);
    expect(() => searchAskedOf({ ...args, query: `${args.query}x`, lists: ["screen"] })).toThrow(expect.objectContaining({ code: "BAD_PARAMETER" }));
  });
});

describe("a record's own copy on the screen", () => {
  const at = D0 + 20 * MIN;
  const LOG = "Workout plan\nBench press 3 x 5 at 60 kg\nSquat 3 x 5 at 80 kg\nBench press 5 x 3 at 65 kg";
  const log = (): Window[] => [
    { from: at, app: "Example Notes", title: "Training log", lines: ["Workout plan", "Bench press 3 x 5 at 60 kg", "Squat 3 x 5 at 80 kg"] },
    { from: at + DAY, app: "Example Notes", title: "Training log", lines: ["Workout plan", "Bench press 5 x 3 at 65 kg"] },
    { from: at + 10 * MIN, app: "Example Browser", site: "example.com", title: "Form guide", lines: ["Bench press form guide for beginners"] },
  ];

  it("SC11 a window whose matched lines all lie in a record the answer's words find is left out, whatever its day; a window with words the record lacks stays; total counts every window matched; the screen list alone and the screen's own family list every sighting", async () => {
    const file = screenFile(log());
    const record = recordIndex("sc11", [note("w", LOG, at)]);
    const both = await ask({ query: "bench press" }, { screen: file, record });
    expect(both.record!.hits).toHaveLength(1);
    const left = listOf(both);
    expect(titles(left)).toEqual(["Form guide"]);
    expect(left.total).toBe(3);
    const alone = listOf(await ask({ query: "bench press", lists: "screen" }, { screen: file, record }));
    expect([titles(alone).sort(), alone.total]).toEqual([["Form guide", "Training log", "Training log"], 3]);
    const sightings = listOf(await ask({ query: "bench press", families: "screen" }, { screen: file, record }));
    expect(titles(sightings).sort()).toEqual(["Form guide", "Training log", "Training log"]);
  });

  it("SC12 a window stays when its matched lines prove no copy: only the query's own words, a record of the screen family, a word whose lines reach what a hit names", async () => {
    const nine = Array.from({ length: 9 }, (_, n) => `Bench press set ${n + 1} at ${60 + n} kg`);
    const seven = Array.from({ length: 7 }, (_, n) => `Bench press warmup ${n + 1} at ${20 + n} kg`);
    const file = screenFile([
      { from: at, app: "Example Notes", title: "Exercise list", lines: ["Bench press", "Deadlift"] },
      { from: at + 5 * MIN, app: "Example Notes", title: "Nine sets", lines: nine },
      { from: at + 10 * MIN, app: "Example Notes", title: "Seven warmups", lines: seven },
    ]);
    const record = recordIndex("sc12a", [note("n", ["Bench press", ...nine, ...seven].join("\n"), at)]);
    expect(titles(listOf(await ask({ query: "bench press" }, { screen: file, record }))).sort()).toEqual(["Exercise list", "Nine sets"]);
    const summary: RecordEntry = { ...note("s", "Summary: Bench press set 1 at 60 kg", at), record: { source: "screen:local:mac-0001", kind: "summary", key: "s" }, family: "screen" };
    const one = screenFile([{ from: at, app: "Example Notes", title: "Training log", lines: ["Bench press set 1 at 60 kg"] }]);
    const answer = await ask({ query: "bench press" }, { screen: one, record: recordIndex("sc12b", [summary]) });
    expect(answer.record!.hits.map((hit) => hit.family)).toEqual(["screen"]);
    expect(titles(listOf(answer))).toEqual(["Training log"]);
  });

  it("SC13 the screen list alone leaves out the copies of the records it is lent, as way-out's rounds lend them", async () => {
    const file = screenFile(log());
    expect(titles(listOf(await ask({ query: "bench press", lists: "screen" }, { screen: file }))).sort()).toEqual(["Form guide", "Training log", "Training log"]);
    expect(titles(listOf(await ask({ query: "bench press", lists: "screen" }, { screen: file, lent: { copies: [[LOG]] } })))).toEqual(["Form guide"]);
  });

  it("SC14 a later page read by its cursor leaves out the copies when its ask held the record list, and lists every sighting when it asked the screen list alone; both say the first page's total", async () => {
    const sets = Array.from({ length: 16 }, (_, n) => `Bench press set ${n + 1} at ${60 + n} kg`);
    const file = screenFile(Array.from({ length: 16 }, (_, n): Window => ({
      from: D0 - n * DAY + n * MIN, app: n % 2 === 0 ? "Example Notes" : "Example Browser", site: n % 2 === 0 ? null : "example.com", title: `Bench ${n}`,
      lines: [n % 2 === 0 ? sets[n]! : `Bench press video ${n} about ${WORDS[n]}`],
    })));
    const record = recordIndex("sc14", [note("p", sets.join("\n"), D0)]);
    const all = listOf(await ask({ query: "bench press", families: "screen" }, { screen: file, record }));
    expect([all.hits.length, all.next]).toEqual([10, expect.any(String)]);
    const first = listOf(await ask({ query: "bench press" }, { screen: file, record }));
    expect(first.next).toEqual(expect.any(String));
    const second = listOf(await ask({ cursor: first.next! }, { screen: file, record }));
    expect([...titles(first), ...titles(second)].sort()).toEqual(Array.from({ length: 8 }, (_, n) => `Bench ${2 * n + 1}`).sort());
    expect([first.total, second.total]).toEqual([16, 16]);
    const alone = listOf(await ask({ query: "bench press", lists: "screen" }, { screen: file, record }));
    expect(alone.next).toEqual(expect.any(String));
    const rest = listOf(await ask({ cursor: alone.next! }, { screen: file, record }));
    expect([...titles(alone), ...titles(rest)].sort()).toEqual(Array.from({ length: 16 }, (_, n) => `Bench ${n}`).sort());
    expect([alone.total, rest.total]).toEqual([16, 16]);
  });
});

describe("one clock, and what a next gives", () => {
  it("SC9 one moment abroad has one clock time in both lists of an answer; the screen hit's day is the file's", async () => {
    const at = D0 + 20 * MIN;
    const file = screenFile([{ from: at, app: "Example Browser", site: "example.com", title: "Kestrel tickets", lines: ["kestrel tickets booked for the coast"] }]);
    const record = recordIndex("sc9", [note("k", "kestrel tickets for the coast", at)]);
    const abroad = { zoneAt: () => "Asia/Kolkata", pieceAt: () => undefined, placedOn: () => [] } as unknown as Presence;
    const both = await ask({ query: "kestrel", lists: ["record", "screen"] }, { screen: file, record, where: abroad });
    const [seen] = listOf(both).hits;
    const [said] = both.record!.hits;
    expect([said!.at, seen!.at]).toEqual([instantIn(at, "Asia/Kolkata"), instantIn(at, "Asia/Kolkata")]);
    expect(seen!.day).toBe(civilDay(at, DAYS));
    const home = await ask({ query: "kestrel", lists: ["record", "screen"] }, { screen: file, record });
    expect([home.record!.hits[0]!.at, listOf(home).hits[0]!.at]).toEqual([instantIn(at, "UTC"), instantIn(at, "UTC")]);
  });

  it("SC10 the screen's next says what it gives: more windows of this stretch, then older days", async () => {
    const file = screenFile(ospreys());
    const first = listOf(await ask({ query: "osprey", lists: "screen" }, { screen: file }));
    expect([first.next, first.next_gives]).toEqual([expect.any(String), "windows"]);
    const dated = listOf(await ask({ query: "osprey", lists: "screen", from: "2020-01-01", to: civilDay(D0, DAYS) }, { screen: file }));
    const pages = [dated];
    for (let n = 0; pages.at(-1)!.next_gives === "windows" && n < 5; n++) pages.push(listOf(await ask({ cursor: pages.at(-1)!.next! }, { screen: file })));
    expect(pages.at(-1)!.next_gives).toBe("days");
    const last = pages.at(-1)!;
    expect(last.next).toEqual(expect.any(String));
    const older = listOf(await ask({ cursor: last.next! }, { screen: file }));
    expect(older.reached?.whole === undefined || older.reached.whole < last.reached!.whole).toBe(true);
    for (const page of [first, ...pages, older]) expect(typeof page.next === "string").toBe(page.next_gives !== undefined);
  });
});
