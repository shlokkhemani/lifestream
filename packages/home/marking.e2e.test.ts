import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { emptyTable, openHomeFolder, sha256, type DaySettings, type DetailType, type Json, type RecordRef } from "@lifestreamprotocol/core";
import { openHider, openMarks, passagesOf, type Detector, type DetectorModel, type DetectorState, type MarksStore, type PassageMark } from "@lifestreamprotocol/privacy";
import type { DayFileFact } from "@lifestreamprotocol/families";
import { startHome } from "./home.js";
import { forgetMarks, markingProgress, marksFileOf, openMarking, searchQueue, valueMarks } from "./marking.js";
import { checkoutProgram } from "./programs.js";
import { SearchIndex, searchFileOf, type AtomEntry, type RecordEntry } from "./search-index.js";
import { askHome } from "./socket.js";
import { editSettings, TEST_UNIT, testSocket } from "./test/folder.js";
import { FAKES, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { doorHere } from "./test/harness-door.js";
import { REPO } from "./test/support.js";

const UTC: DaySettings = { zone: "UTC", day_start_hour: 0 };
const scratch = mkdtempSync(join(tmpdir(), "lifestream-marking-"));
const artifact: Record<string, unknown> = {};
const roots: string[] = [];
afterAll(() => {
  mkdirSync(join(REPO, "packages", "home", ".build", "e2e"), { recursive: true });
  writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "marking.json"), `${JSON.stringify(artifact, null, 2)}\n`);
  rmSync(scratch, { recursive: true, force: true });
  for (const root of roots) removeRoot(root);
});

const MODEL: DetectorModel = { id: "privacy-filter", file: "sha256:0f0f", decode: "1" };
const T0 = Date.parse("2026-09-28T06:00:00Z");
const MINUTE = 60_000;
const A = "apple-notes:local:device-a";

function played(words: Readonly<Record<string, DetailType>>) {
  let state: DetectorState = { state: "ready", model: MODEL };
  let held: Promise<void> | null = null;
  let failing = false;
  const unread: string[] = [];
  const calls: string[][] = [];
  const detector: Detector = {
    state: () => state,
    async find(passages) {
      const model = state.state === "ready" ? state.model : MODEL;
      calls.push([...passages]);
      const holding = held;
      held = null;
      if (holding !== null) await holding;
      if (failing) {
        failing = false;
        throw new Error("the played detector failed, as scripted");
      }
      return {
        model,
        marks: passages.map((passage): PassageMark[] | null => unread.some((text) => passage.includes(text)) ? null
          : Object.entries(words).flatMap(([word, type]) => (passage.includes(word) ? [{ start: passage.indexOf(word), end: passage.indexOf(word) + word.length, type }] : []))),
      };
    },
  };
  return {
    detector, calls,
    set(next: DetectorState) {
      state = next;
    },
    hold(): (lost?: Error) => void {
      let release!: (lost?: Error) => void;
      held = new Promise<void>((resolve, reject) => {
        release = (lost) => (lost === undefined ? resolve() : reject(lost));
      });
      held.catch(() => undefined);
      return release;
    },
    fail() {
      failing = true;
    },
    unread(text: string) {
      unread.push(text);
    },
  };
}

const record = (key: string, text: string, minutes: number): RecordEntry => ({
  record: { source: A, kind: "note", key }, family: "notes", version: `v-${key}-${text.length}`, start_ms: T0 + minutes * MINUTE, end_ms: null, title: "", text, who: [], link: null,
});
const atom = (n: number, text: string, minutes: number, extra: Partial<AtomEntry> = {}): AtomEntry => ({ n, family: "notes", unit: `u${n}`, start_ms: T0 + minutes * MINUTE, end_ms: null, text, ...extra });

function scenario(name: string, words: Readonly<Record<string, DetailType>> = { "Ada Example": "person" }, chosen = () => true) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "index.db");
  const marksFile = join(dir, "privacy", "marks.db");
  let seq = 0;
  const play = played(words);
  const logs: Record<string, Json>[] = [];
  const open = (marks: MarksStore) => {
    const hider = openHider({
      people: () => ({ version: "people-1", owner: null, people: [] }),
      settings: () => ({ level: "all", chat: "all", detector: `runner-${TEST_UNIT}`, links: "tokens", always: [], never: [] }),
      detector: play.detector, pictures: { read: () => Promise.reject(new Error("no picture here")), make: () => Promise.reject(new Error("no picture here")) }, marks,
    });
    return { hider, job: openMarking({ queues: [searchQueue(openHomeFolder(dirname(file)), file)], hider, detector: play.detector, marks, chosen, log: (line) => logs.push(line), look_ms: 0, rest_ms: 0 }) };
  };
  let marks = openMarks(openHomeFolder(dirname(marksFile)), marksFile);
  let opened = open(marks);
  return {
    file, marksFile, play, logs,
    get marks() {
      return marks;
    },
    get job() {
      return opened.job;
    },
    get hider() {
      return opened.hider;
    },
    write(work: (index: SearchIndex) => void) {
      const index = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, UTC);
      try {
        work(index);
        index.finish();
      } finally {
        index.close();
      }
    },
    put(index: SearchIndex, entries: RecordEntry[], removes: RecordRef[] = []) {
      index.records(entries, removes, { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } });
    },
    day(index: SearchIndex, day: string, atoms: AtomEntry[]) {
      index.day(day, { inputs: `inputs-${++seq}`, mtime_us: seq, atoms });
    },
    progress: () => markingProgress([searchQueue(openHomeFolder(dirname(file)), file)], marks, play.detector.state().state === "ready" ? (play.detector.state() as { model: DetectorModel }).model : null)!,
    lose() {
      marks.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${marksFile}${suffix}`, { force: true });
      marks = openMarks(openHomeFolder(dirname(marksFile)), marksFile);
      opened = open(marks);
    },
    passages: (texts: readonly string[]) => texts.flatMap((text) => passagesOf(text).map((passage) => text.slice(passage.start, passage.end))),
  };
}

function allTexts(file: string): string[] {
  const db = new Database(file, { readonly: true });
  try {
    const records = db.prepare("SELECT source, kind, key FROM records").all() as RecordRef[];
    const days = db.prepare("SELECT day FROM days").pluck().all() as string[];
    db.close();
    const index = SearchIndex.read(openHomeFolder(dirname(file)), file)!;
    try {
      return index.textsOf(records, days);
    } finally {
      index.close();
    }
  } finally {
    if (db.open) db.close();
  }
}

describe("the marking job", () => {
  it("marks every entry the search job wrote, records and atoms, newest first, at most 32 passages a find, and reaches 100% once", async () => {
    const run = scenario("fresh");
    run.write((index) => {
      run.put(index, Array.from({ length: 50 }, (_, at) => record(`r${at}`, `Note ${at}: lunch with Ada Example.\n\nSecond paragraph ${at}.`, at)));
      run.day(index, "2026-09-28", [atom(1, "Ada Example: note 49 printed", 49, { record: { source: A, kind: "note", key: "r49" }, title: "Notes" }), atom(2, "A line that prints no note", 55)]);
    });
    const texts = allTexts(run.file);
    expect(run.progress()).toEqual({ marked: 0, total: 51, line: "Marked 0% of your record" });
    await run.job.poke();
    artifact.fresh = { finds: run.play.calls.map((call) => call.length), logs: run.logs, progress: run.progress() };
    expect(run.play.calls.every((call) => call.length <= 32)).toBe(true);
    expect(run.play.calls[0]!.slice(0, 2)).toEqual(["A line that prints no note", "Ada Example: note 49 printed"]);
    expect(new Set(run.play.calls.flat())).toEqual(new Set(run.passages(texts)));
    expect(run.progress()).toEqual({ marked: 51, total: 51, line: "Marked 100% of your record" });
    const kept = run.marks.read(run.passages(texts).map(sha256), MODEL);
    expect(kept.size).toBe(new Set(run.passages(texts)).size);
    expect(kept.get(sha256("Note 7: lunch with Ada Example."))).toEqual({ marks: [{ start: 19, end: 30, type: "person" }], current: true });
    const finds = run.play.calls.length;
    await run.job.poke();
    expect(run.play.calls).toHaveLength(finds);
  });

  it("marks a changed entry again, and keeps the row of an entry written again while its old texts were being marked", async () => {
    const run = scenario("changed");
    run.write((index) => run.put(index, [record("r1", "First words.", 1), record("r2", "Other words.", 2)]));
    await run.job.poke();
    expect(run.progress().line).toBe("Marked 100% of your record");
    run.write((index) => run.put(index, [record("r1", "Second words of Ada Example.", 1)]));
    expect(run.progress()).toEqual({ marked: 1, total: 2, line: "Marked 50% of your record" });
    const release = run.play.hold();
    const running = run.job.poke();
    await until("the run holds the changed note's find", () => run.play.calls.length === 2);
    run.write((index) => run.put(index, [record("r1", "Third words.", 1)]));
    release();
    await running;
    artifact.changed = { finds: run.play.calls, logs: run.logs };
    expect(run.play.calls.slice(1)).toEqual([["Second words of Ada Example."], ["Third words."]]);
    expect(run.progress().line).toBe("Marked 100% of your record");
  });

  it("makes every entry unmarked once under a new model, reads the old marks meanwhile, and drops the old model's rows once none is left", async () => {
    const run = scenario("model");
    run.write((index) => run.put(index, [record("r1", "Ada Example wrote.", 1), record("r2", "Nothing here.", 2)]));
    await run.job.poke();
    const next = { ...MODEL, decode: "2" };
    run.play.set({ state: "ready", model: next });
    expect(run.progress()).toEqual({ marked: 0, total: 2, line: "Marked 0% of your record" });
    const read = await run.hider.hide([[{ text: "Ada Example wrote.", free: true }]], "all", emptyTable("ask:test"));
    expect("texts" in read && read.texts).toEqual(["[[Person 1]] wrote."]);
    expect(run.play.calls).toHaveLength(1);
    await run.job.poke();
    expect(run.play.calls.slice(1)).toEqual([["Nothing here.", "Ada Example wrote."]]);
    expect(run.progress().line).toBe("Marked 100% of your record");
    expect(run.logs).toContainEqual({ marks: "old model's rows dropped", rows: 2 });
    expect(run.marks.read([sha256("Ada Example wrote.")], MODEL).get(sha256("Ada Example wrote."))?.current).toBe(false);
    await run.job.poke();
    expect(run.play.calls).toHaveLength(2);
  });

  it("makes every entry unmarked once over a marks store under a new id, and sends no kept passage when the index is built again", async () => {
    const run = scenario("store");
    run.write((index) => run.put(index, [record("r1", "Ada Example wrote.", 1), record("r2", "Nothing here.", 2)]));
    await run.job.poke();
    expect(run.play.calls).toHaveLength(1);
    const before = run.marks.id;
    run.lose();
    expect(run.marks.id).not.toBe(before);
    expect(run.progress().line).toBe("Marked 0% of your record");
    await run.job.poke();
    expect(run.play.calls).toHaveLength(2);
    expect(run.progress().line).toBe("Marked 100% of your record");
    await run.job.poke();
    expect(run.play.calls).toHaveLength(2);
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${run.file}${suffix}`, { force: true });
    run.write((index) => run.put(index, [record("r1", "Ada Example wrote.", 1), record("r2", "Nothing here.", 2)]));
    expect(run.progress().line).toBe("Marked 0% of your record");
    await run.job.poke();
    expect(run.play.calls).toHaveLength(2);
    expect(run.progress().line).toBe("Marked 100% of your record");
  });

  it("marks nothing with no detector chosen or ready, and counts done a passage the detector cannot read, so it reaches 100%", async () => {
    let chosen = false;
    const run = scenario("ready", { "Ada Example": "person" }, () => chosen);
    run.write((index) => run.put(index, [record("r1", "Ada Example wrote.", 1), record("r2", "Garbled words.", 2)]));
    await run.job.poke();
    chosen = true;
    run.play.set({ state: "downloading", bytes: 340_000_000, total: 900_000_000 });
    await run.job.poke();
    expect(run.play.calls).toEqual([]);
    expect(run.progress().line).toBe("Marked 0% of your record");
    run.play.set({ state: "ready", model: MODEL });
    run.play.unread("Garbled");
    await run.job.poke();
    expect(run.progress()).toEqual({ marked: 2, total: 2, line: "Marked 100% of your record" });
    expect(run.marks.read([sha256("Garbled words.")], MODEL).size).toBe(0);
    await run.job.poke();
    expect(run.play.calls).toHaveLength(1);
  });

  it("ends a run whose find rejects, or whose index a search slice holds, with its rows standing, and marks them at the next", async () => {
    const run = scenario("fails");
    run.write((index) => run.put(index, [record("r1", "Ada Example wrote.", 1)]));
    run.play.fail();
    await run.job.poke();
    expect(run.logs.at(-1)).toEqual({ marks: "failed", error: "the played detector failed, as scripted" });
    expect(run.progress().line).toBe("Marked 0% of your record");
    const slice = new Database(run.file);
    slice.exec("BEGIN IMMEDIATE");
    await run.job.poke();
    expect(run.logs.at(-1)).toMatchObject({ marks: "failed" });
    expect(run.progress().line).toBe("Marked 0% of your record");
    slice.exec("ROLLBACK");
    slice.close();
    await run.job.poke();
    expect(run.progress().line).toBe("Marked 100% of your record");
    expect(run.play.calls).toHaveLength(2);
    artifact.fails = run.logs;
  });

  it("keeps none of an erased note's marks when the erasure lands while its batch is in flight, and marks the rest", async () => {
    const run = scenario("erasure");
    const erased = record("r1", "Ada Example said the erased thing.", 1);
    run.write((index) => run.put(index, [erased, record("r2", "Nothing here.", 2)]));
    const release = run.play.hold();
    const running = run.job.poke();
    await until("the run holds its find", () => run.play.calls.length === 1);
    const index = SearchIndex.write(openHomeFolder(dirname(run.file)), run.file, () => true, 0, UTC);
    try {
      forgetMarks(openHomeFolder(dirname(run.marksFile)), run.marksFile, index.textsOf([erased.record], []));
      index.forget([erased.record], []);
    } finally {
      index.close();
    }
    release();
    await running;
    expect(run.logs.at(-1)).toMatchObject({ marks: "again" });
    expect(run.marks.read([sha256("Ada Example said the erased thing."), sha256("Nothing here.")], MODEL).size).toBe(0);
    await run.job.poke();
    expect(run.play.calls.at(-1)).toEqual(["Nothing here."]);
    expect(run.marks.read([sha256("Ada Example said the erased thing.")], MODEL).size).toBe(0);
    expect(run.progress()).toEqual({ marked: 1, total: 1, line: "Marked 100% of your record" });
  });

  it("moves the marks store's epoch at an erasure of texts the index holds none of yet, so a find in flight keeps nothing", async () => {
    const run = scenario("erasure-unindexed");
    run.write((index) => run.put(index, [record("r1", "Nothing here.", 1)]));
    const before = run.marks.epoch;
    expect(forgetMarks(openHomeFolder(dirname(run.marksFile)), run.marksFile, [])).toBe(0);
    expect(run.marks.epoch).not.toBe(before);
  });

  it("yields to the event loop between batches whose passages the store already holds, and marks the index a build put under its run", async () => {
    const run = scenario("kept");
    const notes = Array.from({ length: 200 }, (_, at) => record(`r${at}`, `Kept note ${at}.`, at));
    run.write((index) => run.put(index, notes));
    await run.job.poke();
    expect(run.progress().line).toBe("Marked 100% of your record");
    const finds = run.play.calls.length;
    const rebuild = (more: RecordEntry[] = []) => {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${run.file}${suffix}`, { force: true });
      run.write((index) => run.put(index, [...notes, ...more]));
    };
    rebuild();
    expect(run.progress()).toEqual({ marked: 0, total: 200, line: "Marked 0% of your record" });
    let between: { marked: number; total: number } | undefined;
    const running = run.job.poke();
    setImmediate(() => {
      between = run.progress();
    });
    await running;
    artifact.kept = { between, finds: run.play.calls.length - finds };
    expect(between!.marked).toBeGreaterThan(0);
    expect(between!.marked).toBeLessThan(between!.total);
    expect(run.play.calls).toHaveLength(finds);
    expect(run.progress().line).toBe("Marked 100% of your record");
    const fresh = record("r-new", "A note written with Ada Example after the build.", 300);
    rebuild([fresh]);
    const release = run.play.hold();
    const held = run.job.poke();
    await until("the run holds the new note's find", () => run.play.calls.length === finds + 1);
    rebuild([fresh]);
    release();
    await held;
    expect(run.play.calls.slice(finds)).toEqual([["A note written with Ada Example after the build."]]);
    expect(run.progress()).toEqual({ marked: 201, total: 201, line: "Marked 100% of your record" });
  });
});

describe("key values marked ahead", () => {
  const DAY = 86_400_000;
  const payments = (index: SearchIndex, day: string, paid: [string, string][]) => {
    const start = Date.parse(`${day}T00:00:00Z`);
    const facts: DayFileFact[] = paid.map(([key, payee], at) => ({
      id: `payments:${key}`, family: "money", of: "payments", time_ms: start, start_ms: start, end_ms: start, date_only: true,
      keys: { payee, direction: "out", currency: "USD" }, measures: { amount: "-1.00" }, who: [], from: { units: [`money/${key}`] }, lines: [at + 1],
    }));
    index.day(day, { inputs: `inputs-${day}-${paid.map(([key]) => key).join("")}`, mtime_us: 1, atoms: [], facts: { window: { start_ms: start, end_ms: start + DAY }, facts } });
  };
  const queued = (file: string): string[] => {
    const db = new Database(file, { readonly: true });
    try {
      return db.prepare("SELECT v.name FROM unmarked_values u JOIN names v ON v.id = u.name ORDER BY v.name").pluck().all() as string[];
    } finally {
      db.close();
    }
  };
  const marksOf = (run: ReturnType<typeof scenario>, values: string[], model = MODEL) => Object.fromEntries(valueMarks(run.marks, model, values));
  const writeIndex = (run: ReturnType<typeof scenario>, work: (index: SearchIndex) => void) => {
    const index = SearchIndex.write(openHomeFolder(dirname(run.file)), run.file, () => true, 0, UTC);
    try {
      work(index);
    } finally {
      index.close();
    }
  };

  it("queues a value stated as a detail when first written, never a structure key's, marks it through the hider, and dequeues it", async () => {
    const run = scenario("values");
    run.write((index) => payments(index, "2026-09-28", [["p1", "Uxley Ltd"], ["p2", "Ada Example Bakery"], ["p3", "Uxley Ltd"]]));
    expect(queued(run.file)).toEqual(["Ada Example Bakery", "Uxley Ltd"]);
    expect(marksOf(run, ["Uxley Ltd", "Ada Example Bakery"])).toEqual({ "Uxley Ltd": "unmarked", "Ada Example Bakery": "unmarked" });
    expect(run.progress()).toEqual({ marked: 0, total: 2, line: "Marked 0% of your record" });
    await run.job.poke();
    expect(run.play.calls.flat().sort()).toEqual(["Ada Example Bakery", "Uxley Ltd"]);
    expect(queued(run.file)).toEqual([]);
    expect(run.progress()).toEqual({ marked: 2, total: 2, line: "Marked 100% of your record" });
    expect(marksOf(run, ["Ada Example Bakery", "Uxley Ltd", "Never Written"])).toEqual({
      "Ada Example Bakery": { marks: [{ start: 0, end: 11, type: "person" }], current: true },
      "Uxley Ltd": { marks: [], current: true },
      "Never Written": "unmarked",
    });
    run.write((index) => payments(index, "2026-09-29", [["p4", "Uxley Ltd"]]));
    expect(queued(run.file)).toEqual([]);
    run.write((index) => payments(index, "2026-09-30", [["p5", "USD"]]));
    expect(queued(run.file)).toEqual(["USD"]);
    await run.job.poke();
    expect(run.play.calls.at(-1)).toEqual(["USD"]);
    artifact.values = run.logs;
  });

  it("makes every value unmarked again under a new model, or a store under a new id, reading the old model's marks meanwhile", async () => {
    const run = scenario("values-model");
    run.write((index) => payments(index, "2026-09-28", [["p1", "Ada Example Bakery"]]));
    await run.job.poke();
    const next: DetectorModel = { ...MODEL, id: "privacy-filter-2" };
    run.play.set({ state: "ready", model: next });
    writeIndex(run, (index) => {
      expect(index.unmarked({ store: run.marks.id, model: JSON.stringify([next.id, next.file, next.decode]) }, 10)).toEqual([{ of: "value", n: expect.any(Number), texts: ["Ada Example Bakery"] }]);
    });
    expect(queued(run.file)).toEqual(["Ada Example Bakery"]);
    expect(marksOf(run, ["Ada Example Bakery"], next)).toEqual({ "Ada Example Bakery": { marks: [{ start: 0, end: 11, type: "person" }], current: false } });
    await run.job.poke();
    expect(queued(run.file)).toEqual([]);
    expect(marksOf(run, ["Ada Example Bakery"], next)).toEqual({ "Ada Example Bakery": { marks: [{ start: 0, end: 11, type: "person" }], current: true } });
    run.lose();
    expect(marksOf(run, ["Ada Example Bakery"], next)).toEqual({ "Ada Example Bakery": "unmarked" });
    expect(run.progress().marked).toBe(0);
    await run.job.poke();
    expect(queued(run.file)).toEqual([]);
    expect(run.progress()).toEqual({ marked: 1, total: 1, line: "Marked 100% of your record" });
  });

  it("an erasure forgets the marks of a value only the erased days state, and its queue row, and keeps a value another day states", async () => {
    const run = scenario("values-erased");
    run.write((index) => {
      payments(index, "2026-09-28", [["p1", "Uxley Ltd"], ["p2", "Shared Co"]]);
      payments(index, "2026-09-29", [["p3", "Shared Co"]]);
    });
    await run.job.poke();
    run.write((index) => payments(index, "2026-09-30", [["p4", "Queued Only"]]));
    expect(queued(run.file)).toEqual(["Queued Only"]);
    writeIndex(run, (index) => {
      const texts = index.textsOf([], ["2026-09-28", "2026-09-30"]);
      expect(texts.sort()).toEqual(["Queued Only", "Uxley Ltd"]);
      forgetMarks(openHomeFolder(dirname(run.marksFile)), run.marksFile, texts);
      index.forget([], ["2026-09-28", "2026-09-30"]);
    });
    expect(queued(run.file)).toEqual([]);
    expect(marksOf(run, ["Uxley Ltd", "Shared Co"])).toEqual({ "Uxley Ltd": "unmarked", "Shared Co": { marks: [], current: true } });
    const db = new Database(run.file, { readonly: true });
    try {
      expect(db.prepare("SELECT name, n, detail FROM names WHERE role = 'value' ORDER BY name").all()).toEqual([
        { name: "Shared Co", n: 1, detail: 1 }, { name: "USD", n: 1, detail: 0 }, { name: "out", n: 1, detail: 0 },
      ]);
    } finally {
      db.close();
    }
    expect(run.progress()).toEqual({ marked: 1, total: 1, line: "Marked 100% of your record" });
  });

  it("looks up values in one read of the store, bounded by the values asked: a value of several passages is marked only when each is kept", () => {
    const run = scenario("values-lookup");
    const reads: number[] = [];
    const store = { read: (digests: readonly string[], model: DetectorModel) => (reads.push(digests.length), run.marks.read(digests, model)) };
    run.marks.write(MODEL, new Map([[sha256("Ada Example"), [{ start: 0, end: 11, type: "person" as const }]], [sha256("Cafe"), []]]), run.marks.epoch);
    const answer = valueMarks(store, MODEL, ["Ada Example\n\nCafe", "Cafe", "Cafe", "Ada Example\n\nNot kept"]);
    expect(reads).toEqual([3]);
    expect(Object.fromEntries(answer)).toEqual({
      "Ada Example\n\nCafe": { marks: [{ start: 0, end: 11, type: "person" }], current: true },
      Cafe: { marks: [], current: true },
      "Ada Example\n\nNot kept": "unmarked",
    });
    run.marks.write(MODEL, new Map([[sha256("Bob Example"), [{ start: 4, end: 11, type: "person" as const }]]]), run.marks.epoch);
    expect(Object.fromEntries(valueMarks(run.marks, MODEL, ["Cafe\n\nBob Example"]))).toEqual({ "Cafe\n\nBob Example": { marks: [{ start: 10, end: 17, type: "person" }], current: true } });
  });
});

describe("the marking job in a home", () => {
  it("marks a fresh home's synthetic record to 100% on the fake runner once the hiding model is chosen, the store holding each passage's marks, and follows the Hiding details default as it is set", async () => {
    const RUNNER = `runner-${TEST_UNIT}`;
    const root = makeRoot("lifestream-marking-home-", { sources: { [A]: "fake-rows" }, settings: { "families.notes": { text: "1" } }, defaults: false });
    roots.push(root);
    editSettings(root, { [`model.runners.${RUNNER}.files`]: ["privacy-filter"], "model.defaults.hiding": `runner:${RUNNER}/privacy-filter` });
    const door = await doorHere(root);
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    const machine = process.env.LIFESTREAM_MACHINE_DIR!;
    const dir = mkdtempSync(join(tmpdir(), "marking-runner-"));
    writeFileSync(join(dir, "script.json"), JSON.stringify({ words: { "Ada Example": "person", "person-a@example.com": "email" } }));
    const program = spawn(process.execPath, [...checkoutProgram(join(REPO, "packages", "runner", "test", "fake-runner.ts")), "--door", door.url, "--pass", join(machine, "runner", "door-token"), "--script", join(dir, "script.json")], { cwd: REPO, stdio: ["ignore", "ignore", "pipe"] });
    const said: string[] = [];
    program.stderr!.on("data", (chunk: Buffer) => said.push(chunk.toString("utf8")));
    const exited = new Promise<void>((resolve) => program.once("exit", () => resolve()));
    const marks = openMarks(openHomeFolder(root), marksFileOf(root, machine));
    try {
      const at = Date.now() - 30 * MINUTE;
      const notes = ["Lunch with Ada Example on the pier.", "Write to person-a@example.com about the plan.", "A note that names nobody."];
      await ship(root, { source: A, fetched_ms: at, rows: notes.map((text, n) => ({ kind: "note", key: `n${n}`, content: { text, at: at + n * MINUTE, photo: false }, at: at + n * MINUTE })) });
      const index = searchFileOf(root, machine);
      const progress = () => markingProgress([searchQueue(openHomeFolder(dirname(index)), index)], marks, null)!;
      await until("the job marks every entry the index holds", () => {
        const held = readHome(root, (db) => db.prepare("SELECT count(*) FROM statements").pluck().get() as number) === notes.length;
        const now = progress();
        return held && now.total >= notes.length && now.marked === now.total;
      }).catch((error: Error) => { throw new Error(`${error.message}; progress ${JSON.stringify(progress())}; the runner said ${said.join("")}`); });
      artifact.home = progress();
      expect(progress().line).toBe("Marked 100% of your record");
      const kept = marks.read(notes.map(sha256), { id: "", file: "", decode: "" });
      expect(notes.map((note) => kept.get(sha256(note))?.marks)).toEqual([
        [{ start: notes[0]!.indexOf("Ada Example"), end: notes[0]!.indexOf("Ada Example") + 11, type: "person" }], [{ start: 9, end: 29, type: "email" }], [],
      ]);
      const set = async (value: string | null) => {
        editSettings(root, { "model.defaults.hiding": value });
        await askHome(testSocket(root), "settings", ["set", "privacy.links", "tokens"]);
      };
      const ticks = async (what: string) => {
        const at = home.stats().ticks.count;
        await until(what, () => home.stats().ticks.count >= at + 30);
      };
      await set(null);
      const late = "A note for Ada Example written while hiding is off.";
      await ship(root, { source: A, fetched_ms: Date.now(), rows: [{ kind: "note", key: "n9", content: { text: late, at: at + 9 * MINUTE, photo: false }, at: at + 9 * MINUTE }] });
      await until("the index holds the note written while hiding is off", () => progress().total === notes.length + 1);
      await ticks("30 ticks with Hiding details off");
      expect(progress().marked).toBe(notes.length);
      await set("runner:runner-elsewhere-bb01/privacy-filter");
      await ticks("30 ticks with Hiding details on a runner never heard from");
      expect(progress().marked).toBe(notes.length);
      await set(`runner:${RUNNER}/privacy-filter`);
      await until("the job marks the late note on the home's own runner", () => progress().marked === notes.length + 1);
      artifact.settings = progress();
      expect(marks.read([sha256(late)], { id: "", file: "", decode: "" }).get(sha256(late))?.marks).toEqual([{ start: late.indexOf("Ada Example"), end: late.indexOf("Ada Example") + 11, type: "person" }]);
    } finally {
      marks.close();
      program.kill("SIGTERM");
      await exited;
      rmSync(dir, { recursive: true, force: true });
      await home.stop();
      await door.stop();
    }
  });
});
