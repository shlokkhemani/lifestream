import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { instantIn, openHome, openHomeFolder, type OpenView } from "@lifestreamprotocol/core";
import { startHome, type Home } from "./home.js";
import { screenFileOf } from "./screen-index.js";
import { SEARCH_STATE_ROUTE, screenReads } from "./screen-reads.js";
import { searchFileOf } from "./search-index.js";
import type { Settings } from "./settings.js";
import { Refusal } from "./refusal.js";
import { askHome } from "./socket.js";
import { ChildHome, FAKES, LOOK_MS, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { testSocket } from "./test/folder.js";


const NOTES = "apple-notes:local:device-a";
const SCREEN = "screen:local:mac-0001";
const MACHINE = "mac-0001";
const MINUTE = 60_000;
const T0 = Date.parse("2026-09-28T06:00:00Z");

const note = (key: string, text: string, at: number) => ({ kind: "note", key, content: { text, at, photo: false }, at });

const frame = (key: string, at: number, ...lines: string[]) => ({
  kind: "frame", key, at,
  content: {
    at, status: "captured", displayID: 1,
    application: { name: "Example Editor", bundleID: "com.example.editor" },
    frontWindow: { windowID: 11 }, windows: [{ windowID: 11, title: "Notes" }],
    accessibility: { nodes: lines.map((value) => ({ depth: 1, role: "AXStaticText", value })) },
    ocr: [],
  },
});

interface Held {
  file: number;
  seq: number;
  held: string[];
}

function readFile(path: string, held: string): Held | undefined {
  if (!existsSync(path)) return undefined;
  const db = new Database(path, { readonly: true, timeout: 10_000 });
  try {
    const position = JSON.parse(db.prepare("SELECT value FROM meta WHERE " + (basename(path).startsWith("screen") ? "name" : "key") + " = 'position'").pluck().get() as string) as { seq: number } | null;
    return { file: statSync(path).ino, seq: position?.seq ?? 0, held: db.prepare(held).pluck().all() as string[] };
  } finally {
    db.close();
  }
}

function digestOf(path: string): string {
  const db = new Database(path, { fileMustExist: true });
  try {
    expect(db.pragma("wal_checkpoint(TRUNCATE)")).toEqual([expect.objectContaining({ busy: 0 })]);
  } finally {
    db.close();
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("the index job", () => {
  let root: string;
  let home: Home | undefined;
  let shipped = 0;

  const sock = () => testSocket(root);
  const recordFile = () => searchFileOf(root, process.env.LIFESTREAM_MACHINE_DIR!);
  const screenFile = () => screenFileOf(recordFile());
  const record = () => readFile(recordFile(), "SELECT key FROM records ORDER BY key");
  const screen = () => readFile(screenFile(), `SELECT DISTINCT s.machine || '/' || s.start_ms FROM screen_segment s ORDER BY 1`);
  const top = () => readHome(root, (db) => db.prepare("SELECT coalesce(max(seq), 0) FROM statements").pluck().get() as number);
  const cursor = (name: string) => readHome(root, (db) => db.prepare("SELECT seq FROM cursors WHERE name = ?").pluck().get(name) as number | undefined);
  const pending = (key: string) => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE kind = 'index' AND key = ? AND state <> 'done' AND NOT (state = 'queued' AND not_before_ms > ?)").pluck().get(key, Date.now()) as number);
  const send = async (source: string, rows: Record<string, unknown>[]) => {
    await ship(root, { source, fetched_ms: Date.now() + shipped, rows: rows as never });
    shipped++;
  };
  const imported = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get()) === shipped;
  const caughtUp = (name: "search" | "screen") => {
    const held = name === "search" ? record() : screen();
    return held !== undefined && held.seq === top() && cursor(name) === top() && pending(name) === 0;
  };
  const asked = async (settings: () => void = () => {}) => {
    const routes = screenReads({
      folder: openHomeFolder(root),
      settings: () => {
        settings();
        return { defaults: { search: null }, search: { power: "plugged-idle" } } as unknown as Settings;
      },
      blobs: undefined as never,
      families: [], file: () => screenFile(), record: () => recordFile(), waitMs: 50,
      viewed: (work) => work({ through: top(), tables: { statements: { statedAt: stated } } } as unknown as OpenView),
    });
    return await routes.get(SEARCH_STATE_ROUTE)!({ url: SEARCH_STATE_ROUTE, now_ms: Date.now(), held: { machine: MACHINE, sites: [], present: [], refused: [], stated: {} as never } } as never);
  };
  const state = async (): Promise<{ record: Record<string, unknown>; screen: Record<string, unknown> }> => {
    const reply = await asked();
    expect(reply.status).toBe(200);
    return JSON.parse(reply.body as string);
  };
  const settled = () => {
    const home = readHome(root, (db) => ({
      waiting: db.prepare("SELECT (SELECT count(*) FROM dirty_days WHERE error IS NULL) + (SELECT count(*) FROM dirty_units)").pluck().get() as number,
      listed: db.prepare("SELECT day || ' ' || inputs FROM days ORDER BY day").pluck().all() as string[],
    }));
    return home.waiting === 0 && JSON.stringify(readFile(recordFile(), "SELECT day || ' ' || inputs FROM days WHERE inputs <> '' ORDER BY day")?.held) === JSON.stringify(home.listed);
  };
  const dayOf = (day: string, building = false) => readFile(building ? join(recordFile(), "..", `${buildName()}`) : recordFile(), `SELECT inputs || ' ' || mtime_us FROM days WHERE day = '${day}'`)?.held[0];
  const buildName = () => readdirSync(join(recordFile(), "..")).find((name) => /^index\.\d+\.building\.db$/u.test(name))!;
  const screenWords = (word: string, building = false) => readFile(building ? join(screenFile(), "..", "screen.building.db") : screenFile(), `SELECT rowid FROM screen_fts WHERE screen_fts MATCH '${word}'`)?.held.length;
  const stated = (seq: number) => readHome(root, (db) => db.prepare("SELECT stated_ms FROM statements WHERE seq <= ? ORDER BY seq DESC LIMIT 1").pluck().get(seq) as number | undefined);
  const named = (seq: number) => instantIn(stated(seq)!, "UTC");

  beforeAll(async () => {
    root = makeRoot("lifestream-index-job-", { sources: { [NOTES]: "fake-rows", [SCREEN]: "fake-rows" }, settings: { "families.notes": { text: "1" }, "families.screen": { index: true } } });
    home = await startHome(root, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined });
  });

  afterAll(async () => {
    await home?.stop().catch(() => undefined);
    if (root !== undefined) removeRoot(root);
  });

  it("follows one batch into both indexes, each by its own key of the one job kind", async () => {
    await send(NOTES, [note("n1", "the harbor lighthouse", T0)]);
    await send(SCREEN, [frame("f1", T0, "the lighthouse keeper"), frame("f2", T0 + 5 * MINUTE, "alpha line")]);
    await until("both indexes read every statement", () => imported() && caughtUp("search") && caughtUp("screen"));
    expect(record()!.held).toEqual(["n1"]);
    expect(screen()!.held).toEqual([`${MACHINE}/${T0}`, `${MACHINE}/${T0 + 5 * MINUTE}`]);
    expect(readHome(root, (db) => db.prepare("SELECT DISTINCT kind || ' ' || key FROM jobs WHERE kind IN ('index', 'search', 'screen') ORDER BY 1").pluck().all())).toEqual(["index screen", "index search"]);
    expect(readHome(root, (db) => db.prepare("SELECT DISTINCT kind || ' ' || subject FROM runs WHERE kind IN ('index', 'search', 'screen') ORDER BY 1").pluck().all())).toEqual(["index screen", "index search"]);
    const now = await state();
    expect(now.record).toEqual({ as_of: named(record()!.seq), building: null });
    expect(now.screen).toMatchObject({ as_of: named(screen()!.seq), building: null, waits: null, embedded: 0, named: 0, bytes: expect.any(Number) });
  });

  it("takes up the files the two jobs before it wrote, writing neither when nothing is new", async () => {
    const stated = () => readFile(screenFile(), "SELECT value FROM meta WHERE name = 'meaning_settings'")?.held.length === 1;
    await home!.stop();
    home = await startHome(root, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined });
    await until("screen.db took search by meaning's settings and the home settled", () => stated() && settled());
    await home.stop();
    home = undefined;
    const before = { record: record()!, screen: screen()!, bytes: [digestOf(recordFile()), digestOf(screenFile())] };
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => {
      for (const kind of ["search", "screen"]) tx.tables.jobs.enqueue({ kind, key: "index", lane: 1, not_before_ms: 0, now_ms: Date.now() });
    });
    db.close();
    home = await startHome(root, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined });
    const started = Date.now();
    const done = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE kind = 'index' AND state = 'done' AND ended_ms >= ?").pluck().get(started) as number);
    await askHome(sock(), "run", ["index", "search"]);
    await askHome(sock(), "run", ["index", "screen"]);
    await until("both indexes ran", () => done() === 2);
    expect(readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE kind IN ('search', 'screen')").pluck().get())).toBe(0);
    await home!.stop();
    const after = { record: record(), screen: screen(), bytes: [digestOf(recordFile()), digestOf(screenFile())] };
    home = await startHome(root, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined });
    expect(after).toEqual(before);
  });

  it("builds one index again beside its file while the other serves and keeps up, and rebuilds either alone", async () => {
    const recordBefore = record()!;
    const screenBefore = screen()!;
    await home!.stop();
    home = undefined;
    const child = new ChildHome(root);
    child.start("screen.indexed");
    await child.ready();
    await askHome(sock(), "rebuild", ["screen"]);
    expect(await child.exited()).toEqual({ code: null, signal: "SIGKILL" });
    rmSync(sock().path, { force: true });
    expect(existsSync(join(screenFile(), "..", "screen.building.db"))).toBe(true);
    expect([record(), screen()]).toEqual([recordBefore, screenBefore]);
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => tx.tables.controls.set({ target: "index:screen", reason: "a test holds the screen's build", at_ms: Date.now(), by: "terminal" }));
    db.close();
    home = await startHome(root, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined });

    await send(NOTES, [note("n2", "the brass compass", T0 + MINUTE)]);
    await send(SCREEN, [frame("f3", T0 + 10 * MINUTE, "bravo line")]);
    await until("the record's index read the batch", () => imported() && caughtUp("search"));
    expect(record()).toEqual({ ...recordBefore, seq: top(), held: ["n1", "n2"] });
    expect(screen()).toEqual(screenBefore);
    const behind = await state();
    expect(behind.record).toEqual({ as_of: named(top()), building: null });
    expect(behind.screen).toMatchObject({ as_of: named(screenBefore.seq), building: { done: expect.any(Number), of: top() } });
    expect((behind.screen.building as { done: number }).done).toBeLessThan(top());

    await askHome(sock(), "resume", ["index:screen"]);
    await until("the screen's build became screen.db and read every statement", () => screen()?.file !== screenBefore.file && caughtUp("screen"));
    expect(existsSync(join(screenFile(), "..", "screen.building.db"))).toBe(false);
    expect(screen()!.held).toEqual([`${MACHINE}/${T0}`, `${MACHINE}/${T0 + 5 * MINUTE}`, `${MACHINE}/${T0 + 10 * MINUTE}`]);
    expect(record()!.file).toBe(recordBefore.file);
    expect((await state()).screen).toMatchObject({ as_of: named(top()), building: null });

    const screenNow = screen()!;
    await askHome(sock(), "rebuild", ["search"]);
    await until("the record's build became index.db and read every statement", () => record()?.file !== recordBefore.file && caughtUp("search"));
    expect(record()!.held).toEqual(["n1", "n2"]);
    expect(screen()).toEqual(screenNow);
    expect(await state()).toMatchObject({ record: { as_of: named(top()), building: null }, screen: { as_of: named(top()), building: null } });
  });

  it("forgets what an erasure names in both indexes and a build beside each, finished from its intent by a home stopped between the two", async () => {
    const day = "2026-09-28";
    const control = (target: string, paused: boolean) => {
      const db = openHome(openHomeFolder(root), "migrate");
      db.commit((tx) => paused ? tx.tables.controls.set({ target, reason: "a test holds this index's build", at_ms: Date.now(), by: "terminal" }) : tx.tables.controls.clear(target));
      db.close();
    };
    const killedBuild = async (name: "search" | "screen") => {
      const child = new ChildHome(root);
      child.start(`${name}.indexed`);
      await child.ready();
      await askHome(sock(), "rebuild", [name]);
      expect(await child.exited()).toEqual({ code: null, signal: "SIGKILL" });
      rmSync(sock().path, { force: true });
    };
    await until("both indexes read every statement and the home settled", () => caughtUp("search") && caughtUp("screen") && settled());
    await home!.stop();
    home = undefined;
    control("index:search", true);
    await killedBuild("screen");
    control("index:screen", true);
    control("index:search", false);
    await killedBuild("search");
    control("index:search", true);
    expect(screenWords("lighthouse")).toBe(1);
    expect(screenWords("lighthouse", true)).toBe(1);
    expect(dayOf(day)).not.toMatch(/ -1$/u);

    const dying = new ChildHome(root);
    dying.start("erase.forgot.search");
    await dying.ready();
    await expect(askHome(sock(), "erase", ["screen", "f1", "--apply"])).rejects.toThrow();
    expect(await dying.exited()).toEqual({ code: null, signal: "SIGKILL" });
    rmSync(sock().path, { force: true });
    const intent = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM meta WHERE key = 'erasure'").pluck().get());
    expect(intent()).toBe(1);
    expect([dayOf(day), dayOf(day, true)]).toEqual([" -1", " -1"]);
    expect([screenWords("lighthouse"), screenWords("lighthouse", true)]).toEqual([1, 1]);

    home = await startHome(root, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined });
    await until("the erasure finished", () => intent() === 0);
    expect([screenWords("lighthouse"), screenWords("lighthouse", true)]).toEqual([0, 0]);
    expect([screenWords("alpha"), screenWords("alpha", true)]).toEqual([1, 1]);
    expect(readHome(root, (db) => db.prepare("SELECT count(*) FROM heads WHERE key = 'f1'").pluck().get())).toBe(0);

    await askHome(sock(), "resume", ["index:search"]);
    await askHome(sock(), "resume", ["index:screen"]);
    await until("both builds published and read every statement", () => !existsSync(join(screenFile(), "..", "screen.building.db")) && buildName() === undefined && caughtUp("search") && caughtUp("screen"));
    expect(screen()!.held).toEqual([`${MACHINE}/${T0 + 5 * MINUTE}`, `${MACHINE}/${T0 + 10 * MINUTE}`]);
    expect(screenWords("lighthouse")).toBe(0);
    expect(record()!.held).toEqual(["n1", "n2"]);
  });

  it("answers a screen file a writer takes mid-read 503 NOT_NOW, never a failure", async () => {
    await home!.stop();
    home = undefined;
    const lock = (): Database.Database | undefined => {
      const held = new Database(screenFile(), { fileMustExist: true, timeout: 0 });
      try {
        held.pragma("locking_mode = EXCLUSIVE");
        if (held.pragma("journal_mode = MEMORY", { simple: true }) !== "memory") throw new Error("another connection holds screen.db");
        held.exec("UPDATE meta SET value = value WHERE name = 'format'");
        return held;
      } catch {
        held.close();
        return undefined;
      }
    };
    const outcome = (settings?: () => void) => asked(settings).then(
      (reply) => ({ status: reply.status, code: null as string | null }),
      (error: unknown) => {
        if (error instanceof Refusal) return { status: error.status, code: error.code };
        throw error;
      },
    );
    let mid: Database.Database | undefined;
    try {
      const during = await outcome(() => { mid ??= lock(); });
      expect([{ status: 200, code: null }, { status: 503, code: "NOT_NOW" }]).toContainEqual(during);
    } finally {
      mid?.close();
    }
    const held = lock();
    expect(held).toBeDefined();
    try {
      expect(await outcome()).toEqual({ status: 503, code: "NOT_NOW" });
    } finally {
      held!.close();
    }
    expect(await outcome()).toEqual({ status: 200, code: null });
  });
});
