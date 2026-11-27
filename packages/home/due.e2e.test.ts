import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, civilDay, dayBounds, NEWEST, openHome, openHomeFolder, walkPlace, type AskRow, type Guard, type HomeDb, type JsonObject, type Tx } from "@lifestreamprotocol/core";
import { callsFamily, LABELS_FAMILY, labelsFamily, messagesFamily } from "@lifestreamprotocol/families";
import { openLedger } from "@lifestreamprotocol/model";
import { extractCursor, keptFingerprint, readDays, rebuildCursor, rebuildExtracts, renderKind } from "./derive.js";
import { Due, fingerprintParts, LEDGER_CURSOR } from "./due.js";
import { startHome } from "./home.js";
import { importKind } from "./import.js";
import { LANE } from "./jobs.js";
import { RECORD_INDEX } from "./search.js";
import { peopleProducts } from "./people.js";
import { effective } from "./settings.js";
import { fakeRows, notesFamily, screen, screenFamily } from "./test/fakes.js";
import { RELEASE_FED } from "./test/fed.js";
import { answered, land } from "./test/ops-support.js";
import { artifact, FAKES, makeRoot, readHome, removeRoot, until, TICK_MS } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { declarations, vendorOf, type Labeler } from "@lifestreamprotocol/connect";
import type { PhotosAdapter } from "@lifestreamprotocol/core";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DAYS = { zone: "UTC", day_start_hour: 4 };
const GUARDS: Record<string, Guard> = { note: () => [], frame: () => [], contact: () => [] };
const BLOB = `sha256:${"ab".repeat(32)}`;

describe("a start keeps each family's fingerprint parts, and why a rebuild began", () => {
  const now = Date.UTC(2026, 9, 6, 12);
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) removeRoot(root);
  });

  function opened() {
    const root = makeRoot("lifestream-due-fingerprint-", { sources: { "apple-notes:local:device-a": "fake-rows" } });
    roots.push(root);
    const db = openHome(openHomeFolder(root), "migrate");
    openLedger(openHomeFolder(root), { mode: "migrate" }).close();
    const start = (code: string, day = DAYS) => {
      const families = [notesFamily({ code })];
      const due = new Due({
        folder: openHomeFolder(root), settings: { ...effective(root).settings, day: { ...effective(root).settings.day, ...day } }, registry: { connectors: [], readers: [], families, code: "test" },
        families: new Map(families.map((family) => [family.name, family])), now: () => now, running: () => undefined,
      });
      try {
        db.commit((tx) => due.start(tx, readDays(openHomeFolder(root))));
      } finally {
        due.close();
      }
    };
    start("1");
    land(db, { source: "apple-notes:local:device-a", stated_ms: now, rows: [{ kind: "msg", key: "m1", time: { start_ms: now - HOUR, precision: "ms" }, content: { text: "a message" } }] });
    const state = () => db.commit((tx) => ({
      kept: keptFingerprint(tx, "notes"), owed: tx.tables.cursors.get(rebuildCursor("notes"))!.seq, generation: tx.tables.cursors.get(rebuildCursor("notes"))!.generation,
    }));
    return { db, start, state, forget: () => db.commit((tx) => tx.tables.meta.delete("fingerprint:notes")), close: () => db.close() };
  }

  it("a start with nothing kept and nothing moved writes the parts and starts no walk", () => {
    const home = opened();
    try {
      expect(home.state()).toEqual({ kept: { parts: fingerprintParts(notesFamily({ code: "1" }), DAYS) }, owed: 0, generation: expect.any(Number) as number });
      home.forget();
      home.start("1");
      expect(home.state()).toEqual({ kept: { parts: fingerprintParts(notesFamily({ code: "1" }), DAYS) }, owed: 0, generation: expect.any(Number) as number });
    } finally {
      home.close();
    }
  });

  it("a bumped code with no kept parts starts the walk with `unknown`; with parts kept, it names the part, and a start that finds the fingerprint as it was keeps the reason and its generation", () => {
    const home = opened();
    try {
      home.forget();
      home.start("2");
      const unknown = home.state();
      expect(unknown).toEqual({ kept: { parts: fingerprintParts(notesFamily({ code: "2" }), DAYS), reason: ["unknown"], generation: unknown.generation }, owed: 1, generation: unknown.generation });
      home.start("3");
      const code = home.state();
      expect(code).toEqual({ kept: { parts: fingerprintParts(notesFamily({ code: "3" }), DAYS), reason: ["code"], generation: code.generation }, owed: 1, generation: code.generation });
      expect(code.generation).not.toBe(unknown.generation);
      home.start("3");
      expect(home.state()).toEqual(code);
      home.start("3", { zone: "Asia/Kolkata", day_start_hour: 6 });
      expect(home.state().kept?.reason).toEqual(["zone", "day_start"]);
    } finally {
      home.close();
    }
  });
});

describe("a commit queues exactly the work what it moved makes due", () => {
  let root: string;
  let db: HomeDb;
  let due: Due;
  let run = 0;
  const now = Date.UTC(2026, 9, 6, 12);
  const families = [notesFamily(), screen, labelsFamily({ home: null, messages: RELEASE_FED.messages, mail: RELEASE_FED.mail })(RELEASE_FED.labels)];
  const seen: Record<string, unknown> = {};

  const commit = <T>(work: (tx: Tx) => T): T => db.commit((tx) => {
    const done = work(tx);
    due.after(tx);
    return done;
  });
  const land = (source: string, stated_ms: number, rows: { kind: string; key: string; content: JsonObject; at?: number; blobs?: string[] }[], history = false) => commit((tx) => {
    const id = tx.tables.runs.start({ kind: "import", subject: source, started_ms: now });
    run++;
    return tx.records.land(id, { id: `d${run}`, source, stated_ms, history }, rows.map((row) => ({
      kind: row.kind, key: row.key, content: row.content, ...(row.blobs === undefined ? {} : { blobs: row.blobs }),
      ...(row.at === undefined ? {} : { time: { start_ms: row.at, precision: "ms" as const } }),
    })), GUARDS, { has: () => false });
  });
  const queued = (name: string): { kind: string; key: string; lane: number }[] => {
    const jobs = readHome(root, (home) => home.prepare("SELECT kind, key, lane FROM jobs WHERE state = 'queued' ORDER BY kind, key").all()) as { kind: string; key: string; lane: number }[];
    const writer = new Database(join(root, "home.db"));
    writer.exec("DELETE FROM jobs; DELETE FROM dirty_days;");
    writer.close();
    seen[name] = jobs;
    return jobs;
  };
  const marked = (): string[] => readHome(root, (home) => home.prepare("SELECT day FROM dirty_days ORDER BY day").pluck().all()) as string[];
  const marks = (): Record<string, number> => Object.fromEntries((readHome(root, (home) => home.prepare("SELECT day, marks FROM dirty_days ORDER BY day").all()) as { day: string; marks: number }[]).map((row) => [row.day, row.marks]));
  const dayRow = (day: string) => db.commit((tx) => tx.derived.days.put(day, `inputs of ${day}`, { total: 0, per_family: {} }));
  const dayRows = (): string[] => readHome(root, (home) => home.prepare("SELECT day FROM days ORDER BY day").pluck().all()) as string[];

  beforeAll(() => {
    root = makeRoot("lifestream-due-moved-", { sources: { "apple-notes:local:device-a": "fake-rows", "apple-contacts:local:phone": "fake-rows", "screen:local:mac-0001": "fake-rows" } });
    db = openHome(openHomeFolder(root), "migrate");
    openLedger(openHomeFolder(root), { mode: "migrate" }).close();
    due = new Due({
      folder: openHomeFolder(root), settings: effective(root).settings, registry: { connectors: [], readers: [], families, code: "test" },
      families: new Map(families.map((family) => [family.name, family])), now: () => now, running: () => undefined,
    });
    db.commit((tx) => due.start(tx, readDays(openHomeFolder(root))));
    expect(db.commit((tx) => families.map((family) => tx.tables.cursors.get(rebuildCursor(family.name))?.seq ?? 0))).toEqual(families.map(() => 0));
    queued("start");
  });

  beforeEach(() => {
    queued("before");
  });

  afterAll(() => {
    artifact(root, "due-moved", seen);
    due.close();
    db.close();
    removeRoot(root);
  });

  it("today: the first read into a home that has no day file of it marks today, to render live before any family has a line of it", () => {
    const today = civilDay(now, DAYS);
    expect(dayRows()).not.toContain(today);
    commit((tx) => tx.tables.sources.advance("apple-contacts:local:phone", now - 3 * MINUTE));
    expect({ marked: marked(), jobs: queued("today first read") }).toEqual({ marked: [today], jobs: [{ kind: "render", key: "days", lane: LANE.live }] });
  });

  it("statements: a family that reads them, live when stated within the hour by no history page; a replay states nothing", () => {
    land("apple-notes:local:device-a", now - MINUTE, [{ kind: "note", key: "n1", content: { text: "a live note" }, at: now - 2 * MINUTE }]);
    expect(queued("live note")).toEqual([{ kind: "extract", key: "notes", lane: LANE.live }, { kind: "render", key: "days", lane: LANE.live }]);
    land("apple-notes:local:device-a", now - MINUTE, [{ kind: "note", key: "n1", content: { text: "a live note" }, at: now - 2 * MINUTE }]);
    expect(queued("replay")).toEqual([]);
    land("apple-notes:local:device-a", now - 3 * DAY, [{ kind: "note", key: "n0", content: { text: "an old note" }, at: now - 3 * DAY }]);
    expect(queued("old note")).toEqual([{ kind: "extract", key: "notes", lane: LANE.backfill }, { kind: "render", key: "days", lane: LANE.live }]);
    land("apple-notes:local:device-a", now - MINUTE, [{ kind: "note", key: "n-page", content: { text: "a note of last year" }, at: now - 300 * DAY }], true);
    expect(queued("history page")).toEqual([{ kind: "extract", key: "notes", lane: LANE.backfill }]);
    land("apple-contacts:local:phone", now - MINUTE, [{ kind: "contact", key: "c1", content: { card: "synthetic" } }]);
    expect(queued("contact")).toEqual([{ kind: "extract", key: "labels", lane: LANE.live }, { kind: "extract", key: "notes", lane: LANE.live }, { kind: "people", key: "people", lane: LANE.live }]);
  });

  it("rereads: a record whose blob arrives, or a unit an erasure empties, makes its family due live, and a contact's People; a blob no record wanted moves nothing", () => {
    land("apple-notes:local:device-a", now - 3 * DAY, [{ kind: "note", key: "n-blob", content: { text: "a note naming a file" }, at: now - 3 * DAY, blobs: [BLOB] }]);
    queued("the note");
    commit((tx) => tx.records.blobsArrived([`sha256:${"cd".repeat(32)}`], {}));
    expect(queued("unwanted blob")).toEqual([]);
    commit((tx) => tx.records.blobsArrived([BLOB], {}));
    expect(queued("wanted blob")).toEqual([{ kind: "extract", key: "notes", lane: LANE.live }]);
    const photo = `sha256:${"ef".repeat(32)}`;
    land("apple-contacts:local:phone", now - MINUTE, [{ kind: "contact", key: "c-photo", content: { card: "synthetic", photo: { hash: photo } }, blobs: [photo] }]);
    queued("the contact");
    commit((tx) => tx.records.blobsArrived([photo], {}));
    expect(queued("contact's photo")).toEqual([
      { kind: "extract", key: "labels", lane: LANE.live }, { kind: "extract", key: "notes", lane: LANE.live }, { kind: "people", key: "people", lane: LANE.live },
    ]);
    commit((tx) => tx.records.erase({ records: [], units: [{ family: "screen", unit: "mac-0001/0" }], reason: "a test", at_ms: now }));
    expect(queued("erased unit")).toEqual([{ kind: "extract", key: "screen", lane: LANE.live }]);
  });

  it("rereads go once every consumer has passed them: one with nothing to read passes them at once", () => {
    const rereads = () => readHome(root, (home) => home.prepare("SELECT count(*) FROM rereads").pluck().get()) as number;
    land("apple-notes:local:device-a", now - 3 * DAY, [{ kind: "note", key: "n-blob-2", content: { text: "another note naming a file" }, at: now - 3 * DAY, blobs: [BLOB] }]);
    commit((tx) => tx.records.blobsArrived([BLOB], {}));
    queued("the reread");
    const kept = rereads();
    expect(kept).toBeGreaterThan(0);
    commit((tx) => tx.tables.meta.set("a test", "1"));
    expect(rereads()).toBe(kept);
    commit((tx) => tx.tables.cursors.move("extract:notes", { reread: Number.MAX_SAFE_INTEGER, at_ms: now }));
    expect(rereads()).toBe(0);
  });

  it("read-through: a family that closes units on it, live when read within the hour; its first read marks today, a read further within the day marks none; a read-through that does not move moves nothing", () => {
    const today = civilDay(now, DAYS);
    dayRow(today);
    const screenExtract = { kind: "extract", key: "screen", lane: LANE.live };
    commit((tx) => tx.tables.sources.advance("screen:local:mac-0001", now - 30 * MINUTE));
    const first = marked();
    expect(queued("first read")).toEqual([screenExtract, { kind: "render", key: "days", lane: LANE.live }]);
    commit((tx) => tx.tables.sources.advance("screen:local:mac-0001", now - 20 * MINUTE));
    const further = marked();
    expect(queued("read further")).toEqual([screenExtract]);
    commit((tx) => tx.tables.sources.advance("screen:local:mac-0001", now - 25 * MINUTE));
    const back = marked();
    expect(queued("read back")).toEqual([]);
    expect({ first, further, back }).toEqual({ first: [today], further: [], back: [] });
    const source = "screen:local:mac-0001";
    const main = {
      folder: openHomeFolder(root), settings: effective(root).settings, registry: { connectors: [], readers: [fakeRows], families, code: "test" },
      families: new Map(families.map((family) => [family.name, family])), now: () => now,
      blobs: { has: () => false, stored: () => undefined }, calls: { take: () => [], sent: () => undefined, release: () => undefined }, facesTurned: () => undefined, polled: () => undefined,
      routing: () => ({ routes: {}, works: {}, needs: {}, floors: {} }), log: () => undefined, ending: 0, room: "ok" as const, stated: {}, copies: { level: () => "none" as const, drop: () => undefined },
    };
    const job = db.commit((tx) => {
      tx.tables.deliveries.add({ id: `${source}/read-page`, source, stated_ms: now, sealed_ms: now, facts: { history: true } });
      tx.tables.jobs.enqueue({ kind: "import", key: source, lane: LANE.history, now_ms: now, not_before_ms: now });
      return tx.tables.jobs.get("import", source)!;
    });
    const begun = db.commit((tx) => importKind.begin!(main, tx, job))!;
    queued("history begun");
    commit((tx) => importKind.done(main, tx, { job, state: begun.state }, { read_through_ms: now - 20 * MINUTE + 1, held: [], caught_up: 0 }));
    expect(queued("history read-through")).toEqual([{ kind: "extract", key: "screen", lane: LANE.backfill }]);
    commit((tx) => tx.tables.sources.advance("apple-notes:local:device-a", now - 3 * DAY));
    expect(queued("notes read")).toEqual([]);
  });

  it("starts: a first record of a kind earlier than any before marks the days with files from it; a later one marks none, nor an earlier one within its day", () => {
    const source = "screen:local:mac-0001";
    const days = [5, 3, 1].map((back) => addDays(civilDay(now, DAYS), -back));
    for (const day of [...days, civilDay(now, DAYS)]) dayRow(day);
    land(source, now - MINUTE, [{ kind: "frame", key: "f4", content: { at: 4 }, at: now - 4 * DAY }]);
    const first = marked();
    queued("first frame");
    land(source, now - MINUTE, [{ kind: "frame", key: "f2", content: { at: 2 }, at: now - 2 * DAY }]);
    const later = marked();
    queued("later frame");
    land(source, now - MINUTE, [{ kind: "frame", key: "f6", content: { at: 6 }, at: now - 6 * DAY }]);
    const earlier = marked();
    queued("earlier frame");
    dayRow(addDays(civilDay(now, DAYS), -6));
    land(source, now - MINUTE, [{ kind: "frame", key: "f6-earlier", content: { at: 6 }, at: now - 6 * DAY - HOUR }]);
    const within = marked();
    queued("earlier frame within its day");
    expect({ first, later, earlier, within }).toEqual({ first: days.slice(1).concat(civilDay(now, DAYS)), later: [], earlier: [days[0]!], within: [] });
  });

  it("an edge decades old marks the days with a row in the day list, and today, and no date without one: the writer opens no file", () => {
    const today = civilDay(now, DAYS);
    for (const back of [400, 40, 4]) dayRow(addDays(today, -back));
    mkdirSync(join(root, "days"), { recursive: true });
    writeFileSync(join(root, "days", `${addDays(today, -41)}.day.json`), "{}");
    land("apple-contacts:local:phone", now - MINUTE, [{ kind: "contact", key: "c-old", content: { name: "synthetic" }, at: Date.UTC(1995, 0, 1) }]);
    const edge = marked();
    queued("decades-old start");
    expect(edge).toEqual([...new Set([...dayRows(), today])].sort());
    expect(edge).not.toContain(addDays(today, -41));
    seen.decades_old = { rows: dayRows(), marked: edge };
  });

  it("a source's first read marks every day with a row from its first record through the day it reads into, and today; a date with none in that range is not", () => {
    const source = "apple-notes:local:device-c";
    const today = civilDay(now, DAYS);
    commit((tx) => tx.tables.sources.add({ id: source, vendor: vendorOf(declarations(), source), connector: "fake-rows", options: {}, added_ms: now }));
    const days = [30, 20, 10].map((back) => addDays(today, -back));
    land(source, now - MINUTE, days.map((day, at) => ({ kind: "note", key: `c${at}`, content: { text: "synthetic" }, at: Date.parse(`${day}T12:00:00Z`) })));
    for (const day of days) dayRow(day);
    queued("the source's records");
    commit((tx) => tx.tables.sources.advance(source, now - MINUTE));
    const first = marked();
    queued("first read");
    expect(first).toEqual([...new Set([...dayRows().filter((day) => day >= days[0]!), today])].sort());
    expect(first).toEqual(expect.arrayContaining([...days, today]));
    expect(first).not.toContain(addDays(today, -15));
    commit((tx) => tx.tables.sources.advance(source, now));
    expect(marked()).toEqual([]);
    queued("read further");
    seen.first_read = { days, marked: first };
  });

  it("a read-through moved within a day marks no day; one across the day's start marks both days, with files or none for today", () => {
    const source = "apple-notes:local:device-d";
    const today = civilDay(now, DAYS);
    const yesterday = addDays(today, -1);
    const { start_ms } = dayBounds(today, DAYS);
    commit((tx) => tx.tables.sources.add({ id: source, vendor: vendorOf(declarations(), source), connector: "fake-rows", options: {}, added_ms: now }));
    dayRow(yesterday);
    queued("the source added");
    commit((tx) => tx.tables.sources.advance(source, start_ms - 30 * MINUTE));
    const first = marked();
    queued("first read yesterday");
    commit((tx) => tx.tables.sources.advance(source, start_ms - 10 * MINUTE));
    const within = marked();
    expect(queued("read further yesterday")).toEqual([]);
    commit((tx) => tx.tables.sources.advance(source, start_ms + 10 * MINUTE));
    const across = marked();
    expect(queued("read across midnight")).toEqual([{ kind: "render", key: "days", lane: LANE.live }]);
    commit((tx) => tx.tables.sources.advance(source, now - MINUTE));
    const today_within = marked();
    expect(queued("read further today")).toEqual([]);
    expect({ first, within, across, today_within }).toEqual({ first: [yesterday], within: [], across: [yesterday, today], today_within: [] });
  });

  it("a read-through into a day the home's clock has not reached marks that day too, to render when it begins; a read further within it marks none", () => {
    const source = "apple-notes:local:device-e";
    const today = civilDay(now, DAYS);
    const tomorrow = addDays(today, 1);
    const { end_ms } = dayBounds(today, DAYS);
    commit((tx) => tx.tables.sources.add({ id: source, vendor: vendorOf(declarations(), source), connector: "fake-rows", options: {}, added_ms: now }));
    commit((tx) => tx.tables.sources.advance(source, now - MINUTE));
    queued("first read today");
    commit((tx) => tx.tables.sources.advance(source, end_ms + 2_000));
    const ahead = marked();
    expect(queued("read into tomorrow")).toEqual([{ kind: "render", key: "days", lane: LANE.live }]);
    commit((tx) => tx.tables.sources.advance(source, end_ms + MINUTE));
    const within = marked();
    expect(queued("read further tomorrow")).toEqual([]);
    const other = "apple-notes:local:device-f";
    commit((tx) => tx.tables.sources.add({ id: other, vendor: vendorOf(declarations(), other), connector: "fake-rows", options: {}, added_ms: now }));
    queued("the other source added");
    commit((tx) => tx.tables.sources.advance(other, end_ms + 2_000));
    const first = marked();
    queued("first read into tomorrow");
    dayRow(tomorrow);
    const third = "apple-notes:local:device-g";
    commit((tx) => tx.tables.sources.add({ id: third, vendor: vendorOf(declarations(), third), connector: "fake-rows", options: {}, added_ms: now }));
    commit((tx) => tx.tables.sources.advance(third, now - MINUTE));
    queued("the third source's first read today");
    commit((tx) => tx.tables.sources.advance(third, end_ms + 2_000));
    const filed = marks();
    queued("read into tomorrow, which has a file");
    expect({ ahead, within, first, filed }).toEqual({ ahead: [today, tomorrow], within: [], first: [tomorrow], filed: { [today]: 1, [tomorrow]: 1 } });
  });

  it("search: a render that found its files current, or threw, wakes no search; one that wrote them, or found them current with no row, wakes it", () => {
    const texted = { ...notesFamily(), text: { version: "1", kinds: ["note"], of: () => null } };
    const searching = new Due({
      folder: openHomeFolder(root), settings: effective(root).settings, registry: { connectors: [], readers: [], families: [texted], code: "test" },
      families: new Map([[texted.name, texted]]), now: () => now, running: () => undefined,
    });
    const day = addDays(civilDay(now, DAYS), -60);
    const render = (files: boolean | "threw") => {
      db.commit((tx) => tx.tables.dirty.days([day]));
      db.commit((tx) => {
        const { marks } = tx.tables.dirty.nextDays(1, day, day)[0]!;
        const running = { job: {}, state: { written: 0, current: 0, set_aside: 0 } } as never;
        const outcome = files === "threw" ? { day, marks, error: "threw" }
          : { day, marks, head: { inputs: "inputs-a", counts: { total: 0, per_family: {} } }, units: [], devices: [], ...(files ? { staged: [] } : {}) };
        renderKind.chunk!(main, running, outcome as never)[0]!.work(tx);
        searching.after(tx);
      });
      return queued(`render ${files === "threw" ? "threw" : files ? "wrote" : "current"}`).filter((job) => job.kind === "index" && job.key === "search");
    };
    const main = { now: () => now } as never;
    const search = [{ kind: "index", key: "search", lane: LANE.backfill }];
    try {
      expect({ no_row: render(false), current: render(false), wrote: render(true), threw: render("threw") }).toEqual({ no_row: search, current: [], wrote: search, threw: [] });
    } finally {
      searching.close();
    }
  });

  it("deliveries: a source with one waiting imports, live unless every one waiting is history, however long ago it was stated; a delivery known already adds nothing; one of who is who imported makes People due, one arriving does not", () => {
    commit((tx) => tx.tables.deliveries.add({ id: "apple-notes:local:device-a/fresh", source: "apple-notes:local:device-a", sealed_ms: now, stated_ms: now - MINUTE, facts: {} }));
    expect(queued("fresh")).toEqual([{ kind: "import", key: "apple-notes:local:device-a", lane: LANE.live }]);
    commit((tx) => tx.tables.deliveries.add({ id: "apple-contacts:local:phone/old", source: "apple-contacts:local:phone", sealed_ms: now, stated_ms: now - 3 * HOUR, facts: {} }));
    expect(queued("old")).toEqual([{ kind: "import", key: "apple-contacts:local:phone", lane: LANE.live }]);
    commit((tx) => tx.tables.deliveries.add({ id: "apple-contacts:local:phone/old", source: "apple-contacts:local:phone", sealed_ms: now, stated_ms: now - 3 * HOUR, facts: {} }));
    expect(queued("known")).toEqual([]);
    commit((tx) => tx.tables.deliveries.move("apple-notes:local:device-a/fresh", "apple-notes:local:device-a", { move: "pass" }));
    expect(queued("imported")).toEqual([]);
    commit((tx) => tx.tables.deliveries.move("apple-contacts:local:phone/old", "apple-contacts:local:phone", { move: "pass" }));
    expect(queued("who is who imported")).toEqual([{ kind: "people", key: "people", lane: LANE.live }]);
  });

  it("live first: a history page alone imports live, or a live delivery waits in history behind the pages ahead of it", () => {
    const source = "screen:local:mac-0001";
    commit((tx) => tx.tables.deliveries.add({ id: `${source}/page-1`, source, sealed_ms: now - MINUTE, stated_ms: now - MINUTE, facts: { history: true } }));
    expect(queued("history page")).toEqual([{ kind: "import", key: source, lane: LANE.history }]);
    commit((tx) => tx.tables.deliveries.add({ id: `${source}/page-2`, source, sealed_ms: now, stated_ms: now, facts: { history: true } }));
    expect(queued("another page")).toEqual([{ kind: "import", key: source, lane: LANE.history }]);
    commit((tx) => tx.tables.deliveries.add({ id: `${source}/live`, source, sealed_ms: now + 1, stated_ms: now - MINUTE, facts: {} }));
    expect(queued("live behind pages")).toEqual([{ kind: "import", key: source, lane: LANE.live }]);
    commit((tx) => tx.tables.deliveries.move(`${source}/live`, source, { move: "pass" }));
    expect(queued("pages left")).toEqual([{ kind: "import", key: source, lane: LANE.history }]);
    commit((tx) => {
      for (const page of ["page-1", "page-2"]) tx.tables.deliveries.move(`${source}/${page}`, source, { move: "pass" });
    });
    expect(queued("all imported")).toEqual([]);
  });

  it("a dead history import keeps a live delivery's lane for its next revival; no delivery revives it early", () => {
    const source = "screen:local:mac-0001";
    commit((tx) => tx.tables.deliveries.add({ id: `${source}/dead-page`, source, sealed_ms: now, stated_ms: now, facts: { history: true } }));
    const dead = db.commit((tx) => {
      const job = tx.tables.jobs.get("import", source)!;
      expect(job.lane).toBe(LANE.history);
      for (let attempt = 0; attempt < 5; attempt++) tx.tables.jobs.fail(job.id, "synthetic failure", now);
      return tx.tables.jobs.get("import", source)!;
    });
    expect(dead).toMatchObject({ state: "dead", attempts: 5 });
    commit((tx) => tx.tables.deliveries.add({ id: `${source}/dead-live`, source, sealed_ms: now + 1, stated_ms: now, facts: {} }));
    const urgent = db.commit((tx) => tx.tables.jobs.get("import", source));
    expect(urgent).toEqual({ ...dead, lane: LANE.live });
    db.commit((tx) => {
      expect(tx.tables.jobs.enqueue({ kind: "import", key: source, lane: LANE.history, not_before_ms: now, now_ms: now })).toBe("dead");
      expect(tx.tables.jobs.get("import", source)).toEqual(urgent);
      expect(tx.tables.jobs.revive(now + DAY)).toEqual([`import ${source}`]);
      expect(tx.tables.jobs.take(now + DAY, [LANE.live])).toMatchObject({ id: dead.id, lane: LANE.live, state: "running", attempts: 0 });
      for (const name of ["dead-page", "dead-live"]) tx.tables.deliveries.move(`${source}/${name}`, source, { move: "pass" });
    });
    seen.dead_live = { dead, urgent, revived: db.commit((tx) => tx.tables.jobs.get("import", source)) };
  });

  it("history is only boolean true: a numeric, false, null or absent fact stays live", () => {
    const source = "apple-contacts:local:phone";
    const facts: JsonObject[] = [{ history: true }, { history: 1 }, { history: false }, { history: null }, {}, { history: "true" }];
    for (const [index, fact] of facts.entries()) {
      const id = `${source}/history-type-${index}`;
      commit((tx) => tx.tables.deliveries.add({ id, source, sealed_ms: now, stated_ms: now, facts: fact }));
      expect(queued(`history fact ${index}`)).toEqual([{ kind: "import", key: source, lane: fact.history === true ? LANE.history : LANE.live }]);
      commit((tx) => tx.tables.deliveries.move(id, source, { move: "pass" }));
      expect(queued(`history fact ${index} imported`)).toEqual([{ kind: "people", key: "people", lane: LANE.live }]);
    }
  });

  it("the products People reads are its who-is-who's, every address book's and every product the messages and calls families are made over, none it is not", () => {
    const books = labelsFamily({ home: null, messages: [], mail: [] })(RELEASE_FED.labels);
    const without = peopleProducts([notesFamily(), books]);
    const made = peopleProducts([messagesFamily({ books: RELEASE_FED.labels })(RELEASE_FED.messages), books]);
    const withCalls = peopleProducts([callsFamily({ books: RELEASE_FED.labels, messages: RELEASE_FED.messages })(RELEASE_FED.calls), books]);
    expect([...made].filter((product) => !without.has(product)).sort()).toEqual(RELEASE_FED.messages.map((given) => given.product).sort());
    expect([...withCalls].filter((product) => !without.has(product)).sort()).toEqual(RELEASE_FED.calls.map((given) => given.product).sort());
    expect(without.has("whatsapp")).toBe(false);
    expect(without.has("apple-calls")).toBe(false);
    expect([without.has("apple-contacts"), peopleProducts([notesFamily()]).has("apple-contacts")]).toEqual([true, false]);
  });

  it("sources: one added has the inbox looked at whole, for a shipment its lane holds, and People prepared for one of a product it reads; a commit that adds none looks at nothing", () => {
    commit((tx) => tx.tables.sources.add({ id: "apple-notes:local:device-b", vendor: vendorOf(declarations(), "apple-notes:local:device-b"), connector: "fake-rows", options: { lane: "apple-notes:local:device-a" }, added_ms: now }));
    expect(queued("source added")).toEqual([{ kind: "index-inbox", key: "inbox", lane: LANE.polls }]);
    commit((tx) => tx.tables.sources.add({ id: "apple-contacts:local:device-b", vendor: vendorOf(declarations(), "apple-contacts:local:device-b"), connector: "fake-rows", options: {}, added_ms: now }));
    expect(queued("people's source added")).toEqual([{ kind: "index-inbox", key: "inbox", lane: LANE.polls }, { kind: "people", key: "people", lane: LANE.live }]);
    commit((tx) => tx.tables.meta.set("no source", String(now)));
    expect(queued("no source")).toEqual([]);
  });

  it("pending: a row whose reply the ledger already holds wakes its unit, to plan live; a row written again unchanged wakes nothing", () => {
    const ledger = openLedger(openHomeFolder(root), { mode: "migrate" });
    answered(ledger, { key: "req-early", family: "notes", unit: "photo:early", at_ms: now });
    ledger.close();
    const row: AskRow = {
      family: "notes", item: "photo:early", prompt: "fake-caption", version: 1, input_hash: "h", unit: "apple-notes:local:device-a/early", work_id: null,
      at_key: NEWEST, started: false, waits: "req-early", retry_ms: null, given_up: null, unhideable: null, state: "pending",
    };
    commit((tx) => tx.tables.asks.put(row));
    expect(queued("answered row")).toEqual([{ kind: "plan", key: "notes", lane: LANE.live }]);
    commit((tx) => tx.tables.dirty.clear("notes"));
    commit((tx) => tx.tables.asks.put(row));
    expect(queued("row unchanged")).toEqual([]);
  });

  it("a rebuild queues its walk in backfill, and a live statement during it queues the extract live", () => {
    commit((tx) => rebuildExtracts(tx, "notes", now));
    expect(queued("rebuild")).toEqual([{ kind: "walk", key: "notes", lane: LANE.backfill }]);
    land("apple-notes:local:device-a", now - MINUTE, [{ kind: "note", key: "n9", content: { text: "live during the rebuild" }, at: now - MINUTE }]);
    expect(queued("live during rebuild")).toEqual([{ kind: "extract", key: "notes", lane: LANE.live }]);
  });

  it("a reread a walk has still to read is pruned, or one its publish or a deleted place hands back is kept", () => {
    const left = () => readHome(root, (home) => home.prepare("SELECT seq FROM rereads ORDER BY seq").pluck().all()) as number[];
    const top = commit((tx) => {
      tx.records.rereadUnits("notes", ["u1", "u2", "u3"]);
      return tx.records.newestReread();
    });
    commit((tx) => tx.tables.meta.set(walkPlace("notes"), JSON.stringify({ seq: 0, reread: top - 2, reads: [], aside: [] })));
    const readers = [...families.map((family) => `extract:${family.name}`), RECORD_INDEX.name];
    commit((tx) => {
      for (const name of readers) tx.tables.cursors.move(name, { reread: top, at_ms: now });
    });
    expect(left()).toEqual([top - 1, top]);
    commit((tx) => {
      tx.tables.meta.delete(walkPlace("notes"));
      tx.tables.cursors.move("extract:notes", { reread: top, at_ms: now });
    });
    expect(left()).toEqual([]);
    queued("floor");
  });

  it("a commit that moves nothing queues nothing", () => {
    commit((tx) => tx.tables.meta.set("a quiet commit", String(now)));
    expect(queued("quiet")).toEqual([]);
  });
});

describe("Places is due on a head of what its table and its cameras read, never on the labels' cursor", () => {
  const now = Date.UTC(2026, 9, 6, 12);
  const UNIT = "macbook-pro-0001";
  const OWNER = `places:local:${UNIT}`;
  const LOOKUP = "google-maps:person-a@example.com:lookup";
  const COUNTS = `cameras:local:${UNIT}`;
  const WORDS = `devices:local:${UNIT}`;
  const OLD_PHONE = "places:local:iphone-old-aa01";
  const guards: Record<string, Guard> = { place: () => [], hidden: () => [], camera: () => [] };
  const families = [labelsFamily({ home: UNIT, messages: RELEASE_FED.messages, mail: RELEASE_FED.mail })(RELEASE_FED.labels)];
  let root: string;
  let db: HomeDb;
  let due: Due;
  let run = 0;
  const seen: Record<string, unknown> = {};

  const commit = <T>(work: (tx: Tx) => T): T => db.commit((tx) => {
    const done = work(tx);
    due.after(tx);
    return done;
  });
  const land = (source: string, kind: string, key: string, content: JsonObject) => commit((tx) => {
    const id = tx.tables.runs.start({ kind: "import", subject: source, started_ms: now });
    run++;
    return tx.records.land(id, { id: `p${run}`, source, stated_ms: now - MINUTE }, [{ kind, key, content }], guards, { has: () => false });
  });
  const places = (name: string): { kind: string; key: string; lane: number }[] => {
    const jobs = readHome(root, (home) => home.prepare("SELECT kind, key, lane FROM jobs WHERE state = 'queued' AND kind = 'places' ORDER BY key").all()) as { kind: string; key: string; lane: number }[];
    const writer = new Database(join(root, "home.db"));
    writer.exec("DELETE FROM jobs; DELETE FROM dirty_days;");
    writer.close();
    seen[name] = jobs;
    return jobs;
  };
  const DUE = [{ kind: "places", key: "places", lane: LANE.live }];

  beforeAll(() => {
    root = makeRoot("lifestream-due-places-", { sources: Object.fromEntries([OWNER, LOOKUP, COUNTS, WORDS, OLD_PHONE].map((source) => [source, "fake-rows"])), settings: { unit: UNIT } });
    db = openHome(openHomeFolder(root), "migrate");
    openLedger(openHomeFolder(root), { mode: "migrate" }).close();
    const settings = effective(root).settings;
    expect(settings.unit).toBe(UNIT);
    due = new Due({
      folder: openHomeFolder(root), settings, registry: { connectors: [], readers: [], families, code: "test" },
      families: new Map(families.map((family) => [family.name, family])), now: () => now, running: () => undefined,
    });
    db.commit((tx) => due.start(tx, readDays(openHomeFolder(root))));
    places("start");
  });

  afterAll(() => {
    artifact(root, "due-places", seen);
    due.close();
    db.close();
    removeRoot(root);
  });

  it("an owner place, a hidden spot, a Google name, a camera's count and a camera's word each make it due live in the commit that lands them", () => {
    land(OWNER, "place", "home-0a0a0a", { type: "places.place", name: "Synthetic Home", centre: { latitude: 0, longitude: 0 }, radius_m: 120, ids: [] });
    expect(places("owner place")).toEqual(DUE);
    land(OWNER, "hidden", "hidden-0b0b0b", { type: "places.hidden", centre: { latitude: 0.01, longitude: 0.01 }, radius_m: 80 });
    expect(places("hidden spot")).toEqual(DUE);
    land(LOOKUP, "place", "google:synthetic-place-a", { type: "google.place", id: "synthetic-place-a", name: "Synthetic Annex", centre: { latitude: 0, longitude: 0.01 } });
    expect(places("Google name")).toEqual(DUE);
    land(COUNTS, "camera", "apple/iphone-17-pro", { type: "cameras.camera", photos: 60 });
    expect(places("camera count")).toEqual(DUE);
    land(WORDS, "camera", "apple/iphone-17-pro", { type: "devices.camera", mine: false });
    expect(places("camera word")).toEqual(DUE);
  });

  it("an old phone's places source, a restated head and the labels family's cursor moving make it due never", () => {
    land(OLD_PHONE, "place", "home-0c0c0c", { type: "places.place", name: "Old Phone Home", centre: { latitude: 0, longitude: 0 }, radius_m: 120, ids: [] });
    expect(places("old phone")).toEqual([]);
    land(OWNER, "place", "home-0a0a0a", { type: "places.place", name: "Synthetic Home", centre: { latitude: 0, longitude: 0 }, radius_m: 120, ids: [] });
    expect(places("restated")).toEqual([]);
    commit((tx) => tx.tables.cursors.move(extractCursor(LABELS_FAMILY), { seq: 5, at_ms: now }));
    expect(places("labels cursor")).toEqual([]);
  });
});

describe("the screen index is due for a frame of a source its family's adapters name its frames, and for an erasure", () => {
  let root: string;
  let db: HomeDb;
  let due: Due;
  const now = Date.UTC(2026, 9, 6, 12);
  const families = [notesFamily(), screenFamily({ index: true })];

  const commit = <T>(work: (tx: Tx) => T): T => db.commit((tx) => {
    const done = work(tx);
    due.after(tx);
    return done;
  });
  const land = (source: string, kind: string, key: string, at: number) => commit((tx) => {
    const id = tx.tables.runs.start({ kind: "import", subject: source, started_ms: now });
    return tx.records.land(id, { id: `${source}/${key}`, source, stated_ms: now - MINUTE }, [
      { kind, key, content: kind === "note" ? { text: "a note" } : { at }, time: { start_ms: at, precision: "ms" as const } },
    ], GUARDS, { has: () => false });
  });
  const screenQueued = (): number | undefined => {
    const lane = readHome(root, (home) => home.prepare("SELECT lane FROM jobs WHERE kind = 'index' AND key = 'screen' AND state = 'queued'").pluck().get()) as number | undefined;
    const writer = new Database(join(root, "home.db"));
    writer.exec("DELETE FROM jobs; DELETE FROM dirty_days;");
    writer.close();
    return lane;
  };

  beforeAll(() => {
    root = makeRoot("lifestream-due-screen-", { sources: { "apple-notes:local:device-a": "fake-rows", "screen:local:mac-0001": "fake-rows" } });
    db = openHome(openHomeFolder(root), "migrate");
    openLedger(openHomeFolder(root), { mode: "migrate" }).close();
    due = new Due({
      folder: openHomeFolder(root), settings: effective(root).settings, registry: { connectors: [], readers: [], families, code: "test" },
      families: new Map(families.map((family) => [family.name, family])), now: () => now, running: () => undefined,
    });
    db.commit((tx) => due.start(tx, readDays(openHomeFolder(root))));
    expect(screenQueued()).toBe(LANE.backfill);
  });

  afterAll(() => {
    due.close();
    db.close();
    removeRoot(root);
  });

  it("a frame makes it due, live when stated within the hour; a note does not; an erasure's event does", () => {
    land("screen:local:mac-0001", "frame", "f1", now - 2 * MINUTE);
    expect(screenQueued()).toBe(LANE.live);
    land("apple-notes:local:device-a", "note", "n1", now - 2 * MINUTE);
    expect(screenQueued()).toBeUndefined();
    commit((tx) => tx.tables.events.append({ at_ms: now, kind: "erase", key: "a test", detail: {} }));
    expect(screenQueued()).toBe(LANE.live);
  });
});

describe("the home's place in the ledger is a row of `cursors`: a start reads what is new, never every pending ask", () => {
  let root: string;
  let db: HomeDb;
  const now = Date.UTC(2026, 9, 6, 12);
  const family = notesFamily();
  const processes: Due[] = [];
  const seen: Record<string, unknown> = {};

  const fresh = (): Due => {
    const due = new Due({
      folder: openHomeFolder(root), settings: effective(root).settings, registry: { connectors: [], readers: [], families: [family], code: "test" },
      families: new Map([[family.name, family]]), now: () => now, running: () => undefined,
    });
    processes.push(due);
    return due;
  };
  const start = (due: Due) => {
    const parts: Record<string, number> = {};
    db.commit((tx) => due.start(tx, readDays(openHomeFolder(root)), parts));
    return parts;
  };
  const tick = (due: Due) => db.commit((tx) => {
    due.watch(tx);
    due.after(tx);
  });
  const ask = (name: string) => db.commit((tx) => tx.tables.asks.put({
    family: "notes", item: `photo:${name}`, prompt: "fake-caption", version: 1, input_hash: `h-${name}`, unit: `unit-${name}`, work_id: null,
    at_key: NEWEST, started: false, waits: `req-${name}`, retry_ms: null, given_up: null, unhideable: null, state: "pending",
  }));
  const reply = (name: string) => {
    const ledger = openLedger(openHomeFolder(root), { mode: "migrate" });
    try {
      answered(ledger, { key: `req-${name}`, family: "notes", unit: `photo:${name}`, at_ms: now });
    } finally {
      ledger.close();
    }
  };
  const woken = (): string[] => {
    const units = readHome(root, (home) => home.prepare("SELECT unit FROM dirty_units WHERE family = 'notes' AND woken = 1 ORDER BY unit").pluck().all()) as string[];
    db.commit((tx) => tx.tables.dirty.clear("notes"));
    return units;
  };
  const place = () => readHome(root, (home) => home.prepare("SELECT seq FROM cursors WHERE name = ?").pluck().get(LEDGER_CURSOR) ?? null);
  const newest = () => {
    const ledger = openLedger(openHomeFolder(root), { mode: "read" });
    try {
      return ledger.lastOutcome();
    } finally {
      ledger.close();
    }
  };

  beforeAll(() => {
    root = makeRoot("lifestream-due-ledger-", { sources: {} });
    db = openHome(openHomeFolder(root), "migrate");
    openLedger(openHomeFolder(root), { mode: "migrate" }).close();
  });

  afterAll(() => {
    artifact(root, "due-ledger", seen);
    for (const due of processes) due.close();
    db.close();
    removeRoot(root);
  });

  it("no row: the start walks the pending asks once and sets the place to the newest outcome; the next start walks none", () => {
    reply("early");
    ask("early");
    const first = start(fresh());
    expect(["asks_ms" in first, woken(), place()]).toEqual([true, ["unit-early"], newest()]);
    const second = fresh();
    const again = start(second);
    tick(second);
    expect(["asks_ms" in again, woken(), place()]).toEqual([false, [], newest()]);
    seen.first = { first, again };
  });

  it("an outcome noted while the home was stopped: the next start reads no pending ask, and its first tick wakes the unit", () => {
    ask("stopped");
    reply("stopped");
    const due = fresh();
    const parts = start(due);
    expect(["asks_ms" in parts, woken()]).toEqual([false, []]);
    tick(due);
    expect([woken(), place()]).toEqual([["unit-stopped"], newest()]);
    seen.stopped = parts;
  });

  it("a tick whose commit rolls back leaves the place behind it: the next tick wakes the unit, and one after it looks at nothing", () => {
    const due = processes.at(-1)!;
    ask("rolled");
    reply("rolled");
    const before = place();
    expect(() => db.commit((tx) => {
      due.watch(tx);
      due.after(tx);
      throw new Error("the tick's commit failed");
    })).toThrow("the tick's commit failed");
    expect([woken(), place()]).toEqual([[], before]);
    tick(due);
    expect([woken(), place()]).toEqual([["unit-rolled"], newest()]);
    tick(due);
    expect(woken()).toEqual([]);
  });

  it("an erasure of the item the newest reply answered leaves the place in the ledger: the next start walks no pending ask", () => {
    const due = processes.at(-1)!;
    reply("erased");
    tick(due);
    const before = place();
    expect(before).toBe(newest());
    const ledger = openLedger(openHomeFolder(root), { mode: "migrate" });
    try {
      expect(ledger.forget(["photo:erased"]).requests).toBe(1);
    } finally {
      ledger.close();
    }
    const parts = start(fresh());
    expect(["asks_ms" in parts, woken(), place()]).toEqual([false, [], before]);
    seen.erased = parts;
  });

  it("a place past the ledger's newest outcome (a ledger put back from a copy): the start walks once and sets the place down", () => {
    db.commit((tx) => tx.tables.cursors.move(LEDGER_CURSOR, { seq: newest() + 1_000, at_ms: now }));
    const walked = start(fresh());
    expect(["asks_ms" in walked, woken(), place()]).toEqual([true, ["unit-early", "unit-rolled", "unit-stopped"], newest()]);
    expect("asks_ms" in start(fresh())).toBe(false);
    expect(woken()).toEqual([]);
    seen.put_back = walked;
  });
});

describe("a labeler: woken when its newest shipment has landed, started over when what it reads through changed", () => {
  const now = Date.UTC(2026, 9, 6, 12);
  const OWN = "google-places:macbook-pro-0001:nearby";
  const LOOKUP = "google-maps:person-a@example.com:lookup";
  const names: Labeler = { name: "google-places", source: OWN, inputs: [], events: ["places"], label: async () => null };
  const photosOf = (version: string): PhotosAdapter => ({ version, kinds: ["img"], rank: () => 10, copy: () => null, files: () => [], image: () => null, placedBy: () => null, position: () => null });
  const photos = (version: string) => ({ ...notesFamily(), name: "photos", adapters: [{ product: "example-photos", name: "Example photos", vendor: "example", type: "photos" as const, adapter: photosOf(version) }] });
  const cameras = (reading?: Labeler["reading"]): Labeler => ({ name: "cameras", source: "cameras:local:macbook-pro-0001", inputs: [], ...(reading === undefined ? {} : { reading }), label: async () => null });
  let root: string;
  let db: HomeDb;
  let due: Due;
  let shipments = 0;
  let reads = 0;
  const seen: Record<string, unknown> = {};

  const dueOf = (labelers: readonly Labeler[], version = "1") => {
    const families = [photos(version)];
    return new Due({
      folder: openHomeFolder(root), settings: effective(root).settings, registry: { connectors: [], readers: [], families, labelers, code: "test" },
      families: new Map(families.map((family) => [family.name, family])), now: () => now, running: () => undefined,
    });
  };
  const commit = (work: (tx: Tx) => void): number => db.commit((tx) => {
    const deliveries = tx.tables.deliveries;
    const shipped = deliveries.shipped;
    const before = reads;
    deliveries.shipped = (source) => {
      reads++;
      return shipped(source);
    };
    try {
      work(tx);
      due.after(tx);
    } finally {
      deliveries.shipped = shipped;
    }
    return reads - before;
  });
  const labels = (name: string): { key: string; lane: number }[] => {
    const jobs = readHome(root, (home) => home.prepare("SELECT key, lane FROM jobs WHERE state = 'queued' AND kind = 'label' ORDER BY key").all()) as { key: string; lane: number }[];
    const writer = new Database(join(root, "home.db"));
    writer.exec("DELETE FROM jobs;");
    writer.close();
    seen[name] = jobs;
    return jobs;
  };
  const run = (tx: Tx, source: string) => tx.tables.runs.start({ kind: "import", subject: source, started_ms: now });
  const land = (id: string, source: string) => commit((tx) => {
    const started = run(tx, source);
    tx.tables.deliveries.move(id, source, { move: "begin", run: started });
    tx.tables.deliveries.move(id, source, { move: "land", run: started, refused: 0, error: null, code: "test" });
  });
  const ship = (waits?: "own"): string => {
    const id = `${OWN}/2026100${++shipments}T120000Z`;
    const added = commit((tx) => {
      for (const source of [OWN, LOOKUP]) tx.tables.deliveries.add({ id, source, sealed_ms: now, stated_ms: now, facts: {} });
    });
    expect([added > 0, labels("sealed")]).toEqual([true, []]);
    if (waits === undefined) expect([land(id, OWN), labels("own landed")]).toEqual([1, []]);
    return id;
  };

  beforeAll(() => {
    root = makeRoot("lifestream-due-labeler-", { sources: {} });
    db = openHome(openHomeFolder(root), "migrate");
    openLedger(openHomeFolder(root), { mode: "migrate" }).close();
    due = dueOf([names]);
    db.commit((tx) => due.start(tx, readDays(openHomeFolder(root))));
    labels("start");
  });

  afterAll(() => {
    artifact(root, "due-labeler", seen);
    due.close();
    db.close();
    removeRoot(root);
  });

  it("the lookup's row imported: the commit that lands it wakes the labeler, live; its begin did not", () => {
    const id = ship();
    commit((tx) => tx.tables.deliveries.move(id, LOOKUP, { move: "begin", run: run(tx, LOOKUP) }));
    expect(labels("lookup importing")).toEqual([]);
    land(id, LOOKUP);
    expect(labels("lookup imported")).toEqual([{ key: "google-places", lane: LANE.live }]);
  });

  it("held by a pause, then resumed: the resumed import's landing wakes it", () => {
    const id = ship();
    commit((tx) => tx.tables.deliveries.move(id, LOOKUP, { move: "begin", run: run(tx, LOOKUP) }));
    commit((tx) => tx.tables.deliveries.move(id, LOOKUP, { move: "begin", run: run(tx, LOOKUP) }));
    expect(labels("resumed, importing")).toEqual([]);
    land(id, LOOKUP);
    expect(labels("resumed")).toEqual([{ key: "google-places", lane: LANE.live }]);
  });

  it("failed, then imported at a later try with no new statement: the landing wakes it, the failure did not", () => {
    const id = ship();
    commit((tx) => {
      tx.tables.deliveries.move(id, LOOKUP, { move: "begin", run: run(tx, LOOKUP) });
      tx.tables.deliveries.move(id, LOOKUP, { move: "fail", error: "a synthetic failure" });
    });
    expect(labels("lookup failed")).toEqual([]);
    land(id, LOOKUP);
    expect(labels("lookup imported at a retry")).toEqual([{ key: "google-places", lane: LANE.live }]);
  });

  it("given up (Skip it), or superseded: the move out of the waiting states wakes it", () => {
    const skipped = ship();
    commit((tx) => {
      tx.tables.deliveries.move(skipped, LOOKUP, { move: "begin", run: run(tx, LOOKUP) });
      tx.tables.deliveries.move(skipped, LOOKUP, { move: "fail", error: "a synthetic failure" });
    });
    expect(labels("failing")).toEqual([]);
    commit((tx) => tx.tables.deliveries.move(skipped, LOOKUP, { move: "give-up", code: "test" }));
    expect(labels("given up")).toEqual([{ key: "google-places", lane: LANE.live }]);
    const superseded = ship();
    commit((tx) => tx.tables.deliveries.move(superseded, LOOKUP, { move: "supersede" }));
    expect(labels("superseded")).toEqual([{ key: "google-places", lane: LANE.live }]);
  });

  it("its own row given up (Skip it), or superseded, after the lookup's landed: the move out of the waiting states wakes it", () => {
    const skipped = ship("own");
    land(skipped, LOOKUP);
    expect(labels("lookup landed, own waiting")).toEqual([]);
    commit((tx) => {
      tx.tables.deliveries.move(skipped, OWN, { move: "begin", run: run(tx, OWN) });
      tx.tables.deliveries.move(skipped, OWN, { move: "fail", error: "a synthetic failure" });
    });
    expect(labels("own failing")).toEqual([]);
    commit((tx) => tx.tables.deliveries.move(skipped, OWN, { move: "give-up", code: "test" }));
    expect(labels("own given up")).toEqual([{ key: "google-places", lane: LANE.live }]);
    const superseded = ship("own");
    land(superseded, LOOKUP);
    expect(labels("lookup landed, own waiting again")).toEqual([]);
    commit((tx) => tx.tables.deliveries.move(superseded, OWN, { move: "supersede" }));
    expect(labels("own superseded")).toEqual([{ key: "google-places", lane: LANE.live }]);
  });

  it("a delivery of the lookup that is not the shipment's wakes it once its shipment has landed; one while the shipment waits does not", () => {
    const id = ship();
    const other = `${LOOKUP}/other-1`;
    commit((tx) => tx.tables.deliveries.add({ id: other, source: LOOKUP, sealed_ms: now, stated_ms: now, facts: {} }));
    expect(labels("another lookup delivery, the shipment waiting")).toEqual([]);
    land(id, LOOKUP);
    expect(labels("the shipment landed")).toEqual([{ key: "google-places", lane: LANE.live }]);
    land(other, LOOKUP);
    expect(labels("another lookup delivery landed")).toEqual([{ key: "google-places", lane: LANE.live }]);
  });

  it("a start: a labeler whose adapters moved starts over; the same adapters, or a labeler that borrows none, keep their cursors", () => {
    const reading = { code: "1", borrows: ["photos"] };
    const started = (labelers: readonly Labeler[], version: string) => {
      due.close();
      due = dueOf(labelers, version);
      db.commit((tx) => due.start(tx, readDays(openHomeFolder(root))));
      labels(`start ${version}`);
      return readHome(root, (home) => home.prepare("SELECT name, seq, fingerprint IS NOT NULL AS printed FROM cursors WHERE name LIKE 'label:%' ORDER BY name").all());
    };
    started([names, cameras(reading)], "1");
    db.commit((tx) => {
      tx.tables.cursors.move("label:cameras", { seq: 7, at_ms: now });
      tx.tables.cursors.move("label:google-places", { seq: 7, at_ms: now });
    });
    expect(started([names, cameras(reading)], "1")).toEqual([{ name: "label:cameras", seq: 7, printed: 1 }, { name: "label:google-places", seq: 7, printed: 0 }]);
    expect(started([names, cameras(reading)], "2")).toEqual([{ name: "label:cameras", seq: 0, printed: 1 }, { name: "label:google-places", seq: 7, printed: 0 }]);
  });
});

describe("a home started on a file whose cursors are behind catches up with no other signal", () => {
  let root: string;
  afterAll(() => removeRoot(root));

  it("its records are extracted and rendered, and its sealed delivery imported", async () => {
    root = makeRoot("lifestream-due-start-", { sources: { "screen:local:mac-0001": "fake-rows", "apple-notes:local:device-a": "fake-rows" } });
    let home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, log: () => undefined });
    try {
      await until("the first home quiet", () => readHome(root, (read) => read.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get()) === 0);
      await home.stop();
      const old = Date.UTC(2026, 0, 15, 12, 0);
      const fresh = Date.now() - 10 * MINUTE;
      const delivery = await ship(root, { source: "apple-notes:local:device-a", fetched_ms: fresh, rows: [{ kind: "note", key: "d1", content: { text: "a sealed note", at: fresh }, at: fresh }] }, false);
      const db = openHome(openHomeFolder(root), "migrate");
      db.commit((tx) => {
        const run = tx.tables.runs.start({ kind: "import", subject: "screen:local:mac-0001", started_ms: old });
        tx.records.land(run, { id: "screen:local:mac-0001/old", source: "screen:local:mac-0001", stated_ms: old }, [
          { kind: "frame", key: "f1", content: { at: old }, time: { start_ms: old, precision: "ms" } },
        ], GUARDS, { has: () => true });
        tx.tables.runs.end(run, { ended_ms: old, outcome: "ok" });
        tx.tables.deliveries.add({ id: delivery, source: "apple-notes:local:device-a", sealed_ms: fresh, stated_ms: fresh, facts: {} });
      });
      db.close();
      const before = readHome(root, (read) => ({
        queued: read.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get(),
        behind: read.prepare("SELECT count(*) FROM cursors WHERE name = 'extract:screen' AND seq < (SELECT max(seq) FROM statements)").pluck().get(),
      }));
      expect(before).toEqual({ queued: 0, behind: 1 });
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, log: () => undefined });
      const text = (at: number): string => {
        const path = join(root, "days", `${civilDay(at, DAYS)}.day.txt`);
        return existsSync(path) ? readFileSync(path, "utf8") : "";
      };
      await until("both days rendered, the delivery imported", () => text(old).includes("1 frames") && text(fresh).includes("a sealed note") &&
        readHome(root, (read) => read.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(delivery)) === "imported");
      const jobs = readHome(root, (read) => read.prepare("SELECT kind, key, state FROM jobs ORDER BY kind, key").all());
      artifact(root, "due-start", { before, jobs, days: { [civilDay(old, DAYS)]: text(old), [civilDay(fresh, DAYS)]: text(fresh) } });
    } finally {
      await home.stop();
    }
  });
});
