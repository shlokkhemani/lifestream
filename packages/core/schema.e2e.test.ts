import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { homeSchema, openHome, SETTINGS_MOVE } from "./home-db.js";
import { openHomeFolder } from "./home-folder.js";
import { normalised, RELEASE, Schema, type Migration, type SchemaSpec } from "./schema.js";
import { STORED_MARK } from "./stored.js";
import type { JsonObject } from "./types.js";

const FIXTURE = JSON.parse(readFileSync(new URL("./test/home-v22.json", import.meta.url), "utf8")) as {
  meta: { key: string; value: string }[];
  objects: { type: string; name: string; sql: string }[];
};
const LATEST = homeSchema.latest;
const BASE = homeSchema.base;

const dir = mkdtempSync(join(tmpdir(), "core-schema-"));
const found: Record<string, unknown> = {};
afterAll(() => {
  writeFileSync(join(tmpdir(), "core-schema.json"), `${JSON.stringify(found, null, 2)}\n`);
  rmSync(dir, { recursive: true, force: true });
});

let files = 0;
const fresh = (): string => join(mkdtempSync(join(dir, `home-${files++}-`)), "home.db");
function raw<T>(path: string, work: (db: Database.Database) => T): T {
  const db = new Database(path);
  try {
    return work(db);
  } finally {
    db.close();
  }
}

function oldScheme(steps = BASE, rows = true): string {
  const path = fresh();
  raw(path, (db) => {
    db.pragma("journal_mode = WAL");
    db.exec(FIXTURE.objects.map((object) => `${object.sql};`).join("\n"));
    const meta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    meta.run("steps", String(steps));
    meta.run("writer", JSON.stringify({ release: "a839c1e83", steps }));
    meta.run("floor", "3963");
    if (rows) seed(db);
  });
  return path;
}

const VALUES: Record<string, Record<string, unknown>> = {
  statements: { origin: "source", late: 0 },
  deliveries: { state: "sealed", facts: '{"left":1}' },
  jobs: { state: "queued" },
  grants: { newest: 1, measure: "calls", state: "active" },
  extracts: { days: '["2026-09-20"]', items: '["item-a"]' },
  extracts_next: { days: "[]", items: "[]" },
  day_units: { shown: 1 },
  dirty_units: { woken: 0 },
  enrichments: { state: "done", started: 0 },
  asks: { started: 0, state: "done" },
  rereads: { family: null, unit: null },
  meta: { key: "synthetic", value: "a synthetic value" },
};

function seed(db: Database.Database): void {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all() as string[];
  for (const table of tables) {
    if ((db.prepare(`SELECT count(*) FROM "${table}"`).pluck().get() as number) > 0 && table !== "meta") continue;
    const columns = db.prepare("SELECT name, type FROM pragma_table_info(?)").all(table) as { name: string; type: string }[];
    const value = (column: { name: string; type: string }) => {
      const stated = VALUES[table]?.[column.name];
      if (stated !== undefined) return stated;
      return /INT/iu.test(column.type) ? 7 : /REAL/iu.test(column.type) ? 1.5 : `synthetic ${table}.${column.name}`;
    };
    db.prepare(`INSERT INTO "${table}" (${columns.map((column) => `"${column.name}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...columns.map(value));
  }
}

function shapeOf(db: Database.Database): Record<string, string> {
  const rows = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name").all() as { type: string; name: string; sql: string }[];
  return Object.fromEntries(rows.map((row) => [`${row.type} ${row.name}`, normalised(row.sql)]));
}

function everything(path: string): JsonObject {
  return raw(path, (db) => {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all() as string[];
    return {
      version: db.pragma("user_version", { simple: true }) as number,
      schema: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all() as JsonObject[],
      rows: Object.fromEntries(tables.map((table) => [table, inOrder(db.prepare(`SELECT * FROM "${table}"`).all() as JsonObject[])])),
    } as JsonObject;
  });
}

function inOrder<T>(rows: T[]): T[] {
  return rows.map((row) => [JSON.stringify(row), row] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row);
}

const specOf = (schema: Schema): SchemaSpec => ({
  name: schema.name, file: schema.file, base: schema.base, baseline: schema.baseline, migrations: [...schema.migrations], small: [...schema.small],
});

function withMore(...more: Migration[]): Schema {
  const spec: SchemaSpec = {
    name: homeSchema.name, file: homeSchema.file, base: BASE, baseline: homeSchema.baseline, migrations: [...homeSchema.migrations, ...more], small: [...homeSchema.small],
  };
  return new Schema(spec);
}

function openWith(path: string, schema: Schema, mode: "migrate" | "write" | "read", log: JsonObject[] = []) {
  const db = new Database(path, mode === "read" ? { readonly: true, fileMustExist: true } : {});
  try {
    if (mode !== "read") db.pragma("journal_mode = WAL");
    return schema.open(db, mode, (line) => log.push(line));
  } finally {
    db.close();
  }
}

describe("home.db's version", () => {
  it("the baseline is not the file the scheme of numbered steps left at 22", () => {
    const fixture = Object.fromEntries(FIXTURE.objects.map((object) => [`${object.type} ${object.name}`, normalised(object.sql)]));
    expect(Object.fromEntries(homeSchema.expected(BASE))).toEqual(fixture);
    expect(FIXTURE.meta).toEqual([{ key: "steps", value: String(BASE) }, { key: "writer", value: `{"release":"checkout","steps":${BASE}}` }]);
  });

  it("a new file is not at the latest version, or not the expected shape", () => {
    const path = fresh();
    const log: JsonObject[] = [];
    const home = openHome(openHomeFolder(dirname(path)), "migrate", { log: (line) => log.push(line) });
    expect(home.migrated).toMatchObject({ from: 0, to: LATEST });
    home.close();
    raw(path, (db) => {
      expect(db.pragma("user_version", { simple: true })).toBe(LATEST);
      expect(shapeOf(db)).toEqual(Object.fromEntries(homeSchema.expected(LATEST)));
    });
    expect(log.map((line) => line.home)).toEqual(["migrating", "migrated"]);
    const again = openHome(openHomeFolder(dirname(path)), "migrate", { log: (line) => log.push(line) });
    expect(again.migrated).toBeNull();
    again.close();
    expect(log).toHaveLength(2);
  });

  it("the ends of a kind, or the files a loss claim left missing, are wrong on a file made at the version before them", () => {
    const path = fresh();
    const ENDS_AT = 28;
    const before = new Schema({ ...specOf(homeSchema), migrations: homeSchema.migrations.slice(0, ENDS_AT - BASE - 1) });
    openWith(path, before, "migrate");
    raw(path, (db) => {
      expect(db.pragma("user_version", { simple: true })).toBe(ENDS_AT - 1);
      const version = db.prepare("INSERT INTO versions (id, text, kind, key, start_ms, precision) VALUES (?, '{}', 'msg', ?, ?, ?)");
      const head = db.prepare("INSERT INTO heads (source, kind, key, version, stated_ms, since_ms, start_ms) VALUES (?, ?, ?, ?, 1, 1, ?)");
      const span = db.prepare("INSERT INTO spans (source, kind, day_ms, live) VALUES (?, ?, 0, ?)");
      for (const [key, start_ms, precision] of [["m1", 300, "ms"], ["m2", 100, "ms"], ["m3", 500, "day"], ["m4", null, null]] as const) {
        version.run(`sha256:${key}`, key, start_ms, precision);
        head.run("a", "msg", key, `sha256:${key}`, start_ms);
      }
      head.run("a", "msg", "m5", "gone", 50);
      head.run("a", "msg", "m6", "gone", 900);
      version.run("sha256:n1", "n1", 700, "ms");
      head.run("a", "note", "n1", "sha256:n1", 700);
      head.run("b", "msg", "b1", "gone", 400);
      version.run("sha256:c1", "c1", null, null);
      head.run("c", "chat", "c1", "sha256:c1", null);
      for (const [source, kind, live] of [["a", "msg", 4], ["a", "note", 1], ["b", "msg", 0], ["c", "chat", 1]] as const) span.run(source, kind, live);
      const file = (n: number) => `sha256:${String(n).padStart(64, "0")}`;
      const claim = db.prepare("INSERT INTO deliveries (id, source, sealed_ms, stated_ms, facts, state, run, lost) VALUES (?, 'c', ?, ?, '{}', ?, ?, '[]')");
      const stated = db.prepare("INSERT INTO statements (source, kind, key, version, stated_ms, run, origin, late) VALUES ('c', 'file', ?, ?, 1, ?, 'source', 0)");
      const link = db.prepare("INSERT INTO version_blobs (version, blob) VALUES (?, ?)");
      const want = db.prepare("INSERT INTO wanted_blobs (blob, source, kind, key) VALUES (?, 'c', 'file', ?)");
      for (const [key, run, files, wanted] of [["x1", 7, [1, 2], [1]], ["x2", 7, [3], [3]], ["x3", 8, [1, 4], [1, 4]], ["x4", 9, [5], [5]]] as const) {
        stated.run(key, `sha256:${key}`, run);
        for (const n of files) link.run(`sha256:${key}`, file(n));
        for (const n of wanted) want.run(file(n), key);
      }
      claim.run("c/restore", 20, 20, "imported", 7);
      claim.run("c/reinstall", 30, 30, "imported", 8);
      claim.run("c/skipped", 40, 40, "dead", 9);
    });
    openHome(openHomeFolder(dirname(path)), "migrate").close();
    raw(path, (db) => {
      expect(db.pragma("user_version", { simple: true })).toBe(LATEST);
      expect(db.prepare("SELECT source, kind, live, oldest_ms, newest_ms, newest_dated FROM spans ORDER BY source, kind").raw().all()).toEqual([
        ["a", "msg", 4, 100, 500, 1],
        ["a", "note", 1, 700, 700, 0],
        ["b", "msg", 0, null, null, null],
        ["c", "chat", 1, null, null, null],
      ]);
      expect(db.prepare("SELECT source, blob, claim, sealed_ms FROM lost_files ORDER BY blob").raw().all()).toEqual([
        ["c", `sha256:${"0".repeat(63)}1`, "c/restore", 20],
        ["c", `sha256:${"0".repeat(63)}3`, "c/restore", 20],
        ["c", `sha256:${"0".repeat(63)}4`, "c/reinstall", 30],
        ["c", `sha256:${"0".repeat(63)}5`, "c/skipped", 40],
      ]);
    });
  });

  it("an old file does not reach a new file's shape, loses a row, or the move leaves a dead object, steps, a writer or a low floor", () => {
    const path = oldScheme();
    raw(path, (db) => db.prepare("INSERT INTO claims (source, kind, key, at_ms, reason) VALUES ('apple-notes:local:device-a', 'note', 'n2', 1, 'the owner''s')").run());
    const before = everything(path);
    const log: JsonObject[] = [];
    const home = openHome(openHomeFolder(dirname(path)), "migrate", { log: (line) => log.push(line) });
    home.close();
    const after = everything(path);
    const newFile = fresh();
    openHome(openHomeFolder(dirname(newFile)), "migrate").close();
    raw(path, (db) => expect(shapeOf(db)).toEqual(raw(newFile, shapeOf)));
    expect(after.version).toBe(LATEST);
    const tables = (state: JsonObject) => state.rows as Record<string, JsonObject[]>;
    expect(Object.keys(tables(before)).filter((table) => !(table in tables(after)))).toEqual(["claims", "landed", "landed_minutes"]);
    raw(path, (db) => expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'deliveries_custody'").get()).toBeUndefined());
    expect(tables(after).meta).toEqual([
      { key: "floor", value: "2147483647" }, { key: SETTINGS_MOVE.key, value: "{}" }, { key: STORED_MARK, value: JSON.stringify({ M: 1, blocks: 0, after: null, erasures: 0, slab_ms: 0 }) },
      { key: "synthetic", value: "a synthetic value" },
    ]);
    expect(tables(after).polls).toEqual(tables(before).polls!.map(({ state: _s, source: _o, last_ok_ms: _l, error: _e, page_error: _p, ...clocks }) => clocks));
    expect(tables(after).spans).toEqual(tables(before).spans!.map(({ max_ms: _, ...rest }) => ({ ...rest, oldest_ms: null, newest_ms: null, newest_dated: null })));
    expect(tables(after).backfills).toEqual(tables(before).backfills!.map(({ reach, ...rest }) => ({ ...rest, ...(reach === "all" ? {} : { left: null, recent: "[]", last: null }), start_ms: null })));
    for (const table of Object.keys(tables(after)).filter((name) => !["meta", "spans", "polls", "backfills"].includes(name))) expect(tables(after)[table], table).toEqual(tables(before)[table] ?? []);
    expect(log).toEqual([
      { home: "migrating", file: "home.db", from: BASE, to: LATEST },
      { home: "migrated", file: "home.db", from: BASE, to: LATEST, ms: Object.fromEntries(Array.from({ length: LATEST - BASE }, (_, at) => [String(BASE + 1 + at), expect.any(Number)])) },
    ]);
    found.moved = { before: Object.keys(tables(before)).length, after: Object.keys(tables(after)).length, log };
  });

  it("27 leaves a `cursors` row no consumer reads, or deletes one a consumer reads", () => {
    const at26 = new Schema({ name: homeSchema.name, file: homeSchema.file, base: BASE, baseline: homeSchema.baseline, migrations: homeSchema.migrations.slice(0, 26 - BASE), small: [...homeSchema.small] });
    const path = fresh();
    openWith(path, at26, "migrate");
    const insert = "INSERT INTO cursors (name, seq, reread, at_ms) VALUES (?, 7, 0, 1)";
    raw(path, (db) => {
      for (const name of ["extracted:labels", "extracted:physical", "extract:labels", "label:faces"]) db.prepare(insert).run(name);
    });
    openWith(path, homeSchema, "migrate");
    raw(path, (db) => {
      expect(db.pragma("user_version", { simple: true })).toBe(LATEST);
      expect(db.prepare("SELECT name FROM cursors ORDER BY name").pluck().all()).toEqual(["extract:labels", "label:faces"]);
    });
  });

  it("29 places a cursor no rebuild left at 0, leaves one a rebuild did unplaced, or changes a walk's saved place", () => {
    const at28 = new Schema({ name: homeSchema.name, file: homeSchema.file, base: BASE, baseline: homeSchema.baseline, migrations: homeSchema.migrations.slice(0, 28 - BASE), small: [...homeSchema.small] });
    const path = fresh();
    openWith(path, at28, "migrate");
    const place = '{"seq":3,"reread":2,"reads":[],"next_ms":1788393600123,"aside":["unit-a"]}';
    raw(path, (db) => {
      const statement = db.prepare("INSERT INTO statements (seq, source, kind, key, version, stated_ms, run, origin, late) VALUES (?, 'apple-notes:local:device-a', 'note', ?, 'v', 1, 1, 'source', 0)");
      for (const seq of [1, 40]) statement.run(seq, `n${seq}`);
      for (let at = 0; at < 9; at++) db.prepare("INSERT INTO rereads (family, unit) VALUES ('notes', ?)").run(`unit-${at}`);
      db.prepare("DELETE FROM rereads").run();
      const insert = db.prepare("INSERT INTO cursors (name, seq, reread, at_ms) VALUES (?, ?, ?, 1)");
      for (const [name, seq, reread] of [["rebuild:notes", 1, 0], ["extract:notes", 0, 2], ["rebuild:screen", 1, 0], ["extract:screen", 12, 3], ["rebuild:labels", 0, 0], ["extract:labels", 0, 0]] as const) insert.run(name, seq, reread);
      db.prepare("INSERT INTO meta (key, value) VALUES ('walk:notes', ?)").run(place);
    });
    openWith(path, homeSchema, "migrate");
    raw(path, (db) => {
      expect(db.pragma("user_version", { simple: true })).toBe(LATEST);
      expect(db.prepare("SELECT name, seq, reread FROM cursors WHERE name LIKE 'extract:%' ORDER BY name").all()).toEqual([
        { name: "extract:labels", seq: 0, reread: 0 }, { name: "extract:notes", seq: 40, reread: 9 }, { name: "extract:screen", seq: 12, reread: 3 },
      ]);
      expect(db.prepare("SELECT value FROM meta WHERE key = 'walk:notes'").pluck().get()).toBe(place);
    });
  });

  it("31 loses or alters a cursor on its way to `meta`, sets aside one a row does not hold, leaves a parked row its cursor, or reaches another shape than a new file's; 32 leaves a row set aside or a cursor", () => {
    const at30 = new Schema({ ...specOf(homeSchema), migrations: homeSchema.migrations.slice(0, 30 - BASE) });
    const at31 = new Schema({ ...specOf(homeSchema), migrations: homeSchema.migrations.slice(0, 31 - BASE) });
    const path = fresh();
    openWith(path, at30, "migrate");
    const big = `{"seen":${JSON.stringify("x".repeat(40_000))}}`;
    const polls: [string, string, string | null][] = [
      ["poll-a", '{"accounts":{"acct-a":{"since_ms":5}},"page":"t\u00e9"}', "source-a"],
      ["poll-new", "{}", null],
      ["poll-poisoned", "not json {", "source-c"],
      ["poll-big", big, "source-d"],
    ];
    const parked: [string, string][] = [
      ["poll-parked:route-e", JSON.stringify({ state: { b: [1, 2], a: "é" }, paged_ms: 42, source: "source-e" })],
      ["poll-parked:route-f", JSON.stringify({ state: {}, paged_ms: null, source: null })],
      ["poll-parked:route-g", "?"],
      ["poll-parked:route-h", "[1]"],
    ];
    raw(path, (db) => {
      const poll = db.prepare("INSERT INTO polls (acquirer, state, next_ms, last_ok_ms, error, paged_ms, page_error, page_next_ms, held_ms, source, pages, hand) VALUES (?, ?, 11, 12, 'e', 13, 'p', 14, 15, ?, 1, 0)");
      for (const row of polls) poll.run(...row);
      const meta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
      for (const row of parked) meta.run(...row);
      meta.run("poll-refresh:poll-a", "1");
      const backfill = db.prepare("INSERT INTO backfills (source, acquirer, left, unit, reach, recent, last) VALUES (?, ?, 0, NULL, 'all', '[{\"at_ms\":5,\"left\":0}]', ?)");
      for (const [source, acquirer] of [["source-a", "poll-a"], ["source-a2", "poll-a"], ["source-n", "poll-new"]]) backfill.run(source, acquirer, `${source}/page-1`);
    });
    openWith(path, at31, "migrate");
    raw(path, (db) => {
      expect(db.pragma("user_version", { simple: true })).toBe(31);
      const meta = Object.fromEntries(db.prepare("SELECT key, value FROM meta").raw().all() as [string, string][]);
      const aside = (key: string) => (meta[key] === undefined ? undefined : JSON.parse(meta[key]!) as { source: string | null; state: string });
      for (const [acquirer, state, source] of polls.filter(([acquirer]) => acquirer !== "poll-new")) expect(aside(`poll-move:${acquirer}`), acquirer).toEqual({ source, state });
      expect(aside("poll-move:poll-new")).toBeUndefined();
      expect(aside("poll-move:route-e")).toEqual({ source: "source-e", state: '{"b":[1,2],"a":"é"}' });
      expect(aside("poll-move:route-f")).toBeUndefined();
      expect(aside("poll-move:route-g")).toEqual({ source: null, state: "?" });
      expect(aside("poll-move:route-h")).toEqual({ source: null, state: "[1]" });
      expect(meta["poll-parked:route-e"]).toBe('{"paged_ms":42}');
      expect(meta["poll-parked:route-f"]).toBe('{"paged_ms":null}');
      expect(meta["poll-parked:route-g"]).toBe('{"paged_ms":null}');
      expect(meta["poll-parked:route-h"]).toBe('{"paged_ms":null}');
      expect(meta["poll-refresh:poll-a"]).toBe("1");
      expect(Object.keys(meta).filter((key) => key !== "floor").sort()).toEqual([
        "poll-move:poll-a", "poll-move:poll-big", "poll-move:poll-poisoned", "poll-move:route-e", "poll-move:route-g", "poll-move:route-h",
        "poll-parked:route-e", "poll-parked:route-f", "poll-parked:route-g", "poll-parked:route-h", "poll-refresh:poll-a",
      ]);
      expect(db.prepare("SELECT * FROM polls ORDER BY acquirer").all()).toEqual(polls.map(([acquirer]) => ({ acquirer, next_ms: 11, paged_ms: 13, page_next_ms: 14, held_ms: 15, pages: 1, hand: 0 })).sort((a, b) => (a.acquirer < b.acquirer ? -1 : 1)));
      expect(db.prepare("SELECT count(*) FROM poll_cursors").pluck().get()).toBe(0);
      expect(db.prepare("SELECT count(*) FROM poll_memory").pluck().get()).toBe(0);
    });
    const newFile = fresh();
    openWith(newFile, at31, "migrate");
    raw(path, (db) => expect(shapeOf(db)).toEqual(raw(newFile, shapeOf)));
    openWith(path, homeSchema, "migrate");
    raw(path, (db) => {
      expect(db.pragma("user_version", { simple: true })).toBe(LATEST);
      expect(db.prepare("SELECT key FROM meta WHERE key <> 'floor' ORDER BY key").pluck().all()).toEqual([
        SETTINGS_MOVE.key, "poll-parked:route-e", "poll-parked:route-f", "poll-parked:route-g", "poll-parked:route-h", "poll-refresh:poll-a", STORED_MARK,
      ]);
      expect(db.prepare("SELECT count(*) FROM polls").pluck().get()).toBe(polls.length);
      expect(db.prepare("SELECT count(*) FROM poll_cursors").pluck().get()).toBe(0);
      expect(db.prepare("SELECT count(*) FROM poll_memory").pluck().get()).toBe(0);
      expect(db.prepare("SELECT source, acquirer, left, unit, start_ms, recent, last FROM backfills ORDER BY source").all()).toEqual([
        { source: "source-a", acquirer: "poll-a", left: null, unit: null, start_ms: null, recent: "[]", last: null },
        { source: "source-a2", acquirer: "poll-a", left: null, unit: null, start_ms: null, recent: "[]", last: null },
        { source: "source-n", acquirer: "poll-new", left: 0, unit: null, start_ms: null, recent: '[{"at_ms":5,"left":0}]', last: "source-n/page-1" },
      ]);
    });
    found.pollsMoved = { polls: polls.length, parked: parked.length };
  });

  it("32 leaves a row 31 set aside or one a start kept, deletes another `meta` row, or restarts the history of a poll a start kept", () => {
    const at31 = new Schema({ ...specOf(homeSchema), migrations: homeSchema.migrations.slice(0, 31 - BASE) });
    const path = fresh();
    openWith(path, at31, "migrate");
    const gone = ["poll-move:poll-a", "poll-move:route-b", "poll-moved:poll-c", "poll-moved:poll-d"];
    const kept = ["poll-mov", "poll-move", "poll-move;", "poll-moved", "poll-moved;", "poll-movez:poll-a", "poll-parked:poll-a", "poll-refresh:poll-c", "poll-started:poll-d", "synthetic"];
    raw(path, (db) => {
      const meta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
      for (const key of [...gone, ...kept]) meta.run(key, JSON.stringify({ source: "source-a", state: "{}" }));
      db.prepare("INSERT INTO poll_cursors (acquirer, source, state) VALUES ('poll-c', 'source-c', '{\"since_ms\":5}')").run();
      db.prepare("INSERT INTO poll_memory (acquirer, part, key, value) VALUES ('poll-c', 'seen', 'item-a', '1')").run();
      db.prepare("INSERT INTO backfills (source, acquirer, left, unit, reach, recent, last) VALUES ('source-c', 'poll-c', 0, '[\"chat\",\"chats\"]', 'all', '[{\"at_ms\":5,\"left\":0}]', 'source-c/page-1')").run();
    });
    openWith(path, homeSchema, "migrate");
    raw(path, (db) => {
      expect(db.pragma("user_version", { simple: true })).toBe(LATEST);
      expect(db.prepare("SELECT key FROM meta WHERE key <> 'floor' ORDER BY key").pluck().all()).toEqual([...kept, SETTINGS_MOVE.key, STORED_MARK].sort());
      expect(db.prepare("SELECT acquirer, source, state, start_ms FROM poll_cursors").all()).toEqual([{ acquirer: "poll-c", source: "source-c", state: '{"since_ms":5}', start_ms: null }]);
      expect(db.prepare("SELECT count(*) FROM poll_memory").pluck().get()).toBe(1);
      expect(db.prepare("SELECT source, acquirer, left, unit, start_ms, recent, last FROM backfills").all()).toEqual([
        { source: "source-c", acquirer: "poll-c", left: 0, unit: '["chat","chats"]', start_ms: null, recent: '[{"at_ms":5,"left":0}]', last: "source-c/page-1" },
      ]);
    });
    found.pollMoveRows = { gone: gone.length, kept: kept.length };
  });

  it("34 sets Storage's fill below a rowid a version holds, or above one none does, or leaves a file of no version to a fill", () => {
    const at33 = new Schema({ ...specOf(homeSchema), migrations: homeSchema.migrations.slice(0, 33 - BASE) });
    const mark = (path: string) => raw(path, (db) => JSON.parse(db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(STORED_MARK) as string) as unknown);
    const path = fresh();
    openWith(path, at33, "migrate");
    raw(path, (db) => {
      const version = db.prepare("INSERT INTO versions (rowid, id, text, kind, key) VALUES (?, ?, '{}', 'note', ?)");
      for (const rowid of [1, 2, 3]) version.run(rowid, `sha256:${String(rowid).padStart(64, "0")}`, `n${rowid}`);
      db.prepare("DELETE FROM versions WHERE rowid = 3").run();
    });
    openWith(path, homeSchema, "migrate");
    expect(mark(path)).toEqual({ M: 2, blocks: 0, after: null, erasures: 0, slab_ms: 0 });
    raw(path, (db) => {
      for (const table of ["stored_days", "stored_files", "own_days"]) expect(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get(), table).toBe(0);
    });
    const empty = fresh();
    openHome(openHomeFolder(dirname(empty)), "migrate").close();
    expect(mark(empty)).toEqual({ complete: RELEASE });
  });

  it("35 indexes the runs by what they ran on and the open runs alone, and writes no run", () => {
    const at34 = new Schema({ ...specOf(homeSchema), migrations: homeSchema.migrations.slice(0, 34 - BASE) });
    const path = fresh();
    openWith(path, at34, "migrate");
    const runs = (db: Database.Database) => db.prepare("SELECT id, kind, subject, outcome FROM runs ORDER BY id").all();
    const before = raw(path, (db) => {
      const run = db.prepare("INSERT INTO runs (id, kind, subject, started_ms, outcome) VALUES (?, ?, ?, 1, ?)");
      run.run(1, "import", "source-a delivery-1", "ok");
      run.run(2, "import", "source-a delivery-2", null);
      run.run(3, "extract", "messages", "interrupted");
      run.run(4, "render", "2026-11-16", null);
      return runs(db);
    });
    openWith(path, homeSchema, "migrate");
    raw(path, (db) => {
      expect(runs(db)).toEqual(before);
      expect(db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'runs_open'").pluck().get()).toMatch(/ WHERE outcome IS NULL$/u);
      expect(db.prepare("SELECT count(*) FROM runs INDEXED BY runs_open WHERE outcome IS NULL").pluck().get()).toBe(2);
      expect(db.prepare("SELECT id FROM runs INDEXED BY runs_open WHERE outcome IS NULL ORDER BY id").pluck().all()).toEqual([2, 4]);
      expect(db.prepare("SELECT id FROM runs INDEXED BY runs_subject WHERE kind = 'import' AND subject = 'source-a delivery-1'").pluck().all()).toEqual([1]);
    });
  });

  it("36 keeps a history walk under all as standing under no start, resets one under any other reach, and keeps every cursor as left under all", () => {
    const at35 = new Schema({ ...specOf(homeSchema), migrations: homeSchema.migrations.slice(0, 35 - BASE) });
    const path = fresh();
    openWith(path, at35, "migrate");
    raw(path, (db) => {
      const backfill = db.prepare("INSERT INTO backfills (source, acquirer, left, unit, reach, recent, last) VALUES (?, 'poll-a', 0, '[\"note\",\"notes\"]', ?, '[{\"at_ms\":5,\"left\":0}]', ?)");
      for (const [source, reach] of [["source-all", "all"], ["source-date", "2026-01-01"], ["source-none", "none"], ["source-days", "90d"]]) backfill.run(source, reach, `${source}/page-1`);
      db.prepare("INSERT INTO poll_cursors (acquirer, source, state) VALUES ('poll-a', 'source-all', '{\"since_ms\":5}')").run();
    });
    openWith(path, homeSchema, "migrate");
    raw(path, (db) => {
      expect(db.pragma("user_version", { simple: true })).toBe(LATEST);
      expect(db.prepare("SELECT source, left, unit, start_ms, recent, last FROM backfills ORDER BY source").all()).toEqual([
        { source: "source-all", left: 0, unit: '["note","notes"]', start_ms: null, recent: '[{"at_ms":5,"left":0}]', last: "source-all/page-1" },
        ...["source-date", "source-days", "source-none"].map((source) => ({ source, left: null, unit: '["note","notes"]', start_ms: null, recent: "[]", last: null })),
      ]);
      expect(db.prepare("SELECT acquirer, source, state, start_ms FROM poll_cursors").all()).toEqual([{ acquirer: "poll-a", source: "source-all", state: '{"since_ms":5}', start_ms: null }]);
    });
  });

  it("37 leaves a request the People writer kept, or deletes another `meta` row", () => {
    const at36 = new Schema({ ...specOf(homeSchema), migrations: homeSchema.migrations.slice(0, 36 - BASE) });
    const path = fresh();
    openWith(path, at36, "migrate");
    const gone = ["people:request:request-a", "people:request:request-b"];
    const kept = ["owner:request:request-c", "people:request", "people:request;", "people:undo", "people:undone", "synthetic"];
    raw(path, (db) => {
      const meta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
      for (const key of [...gone, ...kept]) meta.run(key, JSON.stringify({ act: null, position: "1:1" }));
    });
    openWith(path, homeSchema, "migrate");
    raw(path, (db) => {
      expect(db.pragma("user_version", { simple: true })).toBe(LATEST);
      expect(db.prepare("SELECT key FROM meta WHERE key NOT IN ('floor', ?) ORDER BY key").pluck().all(STORED_MARK)).toEqual([...kept, SETTINGS_MOVE.key].sort());
    });
  });

  it("a failed migration leaves its version, its schema, a row or meta changed, and says nothing", () => {
    const path = oldScheme();
    const before = everything(path);
    const failing = withMore((db) => {
      db.exec("CREATE TABLE synthetic_half (id INTEGER PRIMARY KEY); DELETE FROM meta; DELETE FROM statements");
      throw new Error("a synthetic migration that fails halfway");
    });
    const log: JsonObject[] = [];
    expect(() => openWith(path, failing, "migrate", log)).toThrow("a synthetic migration that fails halfway");
    expect(everything(path)).toEqual(before);
    expect(log).toEqual([
      { home: "migrating", file: "home.db", from: BASE, to: LATEST + 1 },
      { home: "migration_failed", file: "home.db", from: BASE, to: LATEST + 1, error: "a synthetic migration that fails halfway" },
    ]);
    expect(openWith(path, homeSchema, "migrate")).toMatchObject({ from: BASE, to: LATEST });
  });

  it("a refused open changes the file", () => {
    const path = fresh();
    openHome(openHomeFolder(dirname(path)), "migrate").close();
    raw(path, (db) => db.exec("DROP INDEX dirty_days_set_aside"));
    const before = everything(path);
    expect(() => openHome(openHomeFolder(dirname(path)), "migrate")).toThrow(`home.db is not this release's at version ${LATEST} (index dirty_days_set_aside is missing): this release cannot read it`);
    const reading = new Database(path, { readonly: true });
    try {
      expect(() => homeSchema.check(reading)).toThrow(`home.db is not this release's at version ${LATEST} (index dirty_days_set_aside is missing): this release cannot read it`);
    } finally {
      reading.close();
    }
    const old = oldScheme();
    raw(old, (db) => db.exec("DROP INDEX deliveries_seal"));
    const oldBefore = everything(old);
    const log: JsonObject[] = [];
    expect(() => openHome(openHomeFolder(dirname(old)), "migrate", { log: (line) => log.push(line) })).toThrow(`home.db is not this release's at version ${BASE} (index deliveries_seal is missing)`);
    expect(everything(path)).toEqual(before);
    expect(everything(old)).toEqual(oldBefore);
    expect(log.map((line) => line.home)).toEqual(["migrating", "migration_failed"]);
  });

  it("a file a newer release migrated, or one older than the baseline, is opened in any mode", () => {
    const newer = fresh();
    openHome(openHomeFolder(dirname(newer)), "migrate").close();
    raw(newer, (db) => db.pragma(`user_version = ${LATEST + 1}`));
    const older = oldScheme(BASE - 1);
    const before = { newer: everything(newer), older: everything(older) };
    for (const mode of ["migrate", "write", "read"] as const) {
      expect(() => openHome(openHomeFolder(dirname(newer)), mode), mode).toThrow(`home.db is at version ${LATEST + 1}; this release reads ${LATEST}: a newer release wrote it`);
    }
    expect(() => openHome(openHomeFolder(dirname(older)), "migrate")).toThrow(`home.db is at version ${BASE - 1}; this release reads ${LATEST} and moves a file forward from ${BASE} at the oldest`);
    for (const mode of ["write", "read"] as const) {
      expect(() => openHome(openHomeFolder(dirname(older)), mode), mode).toThrow(`home.db is at version ${BASE - 1}; this release reads ${LATEST}: the home has not started this release yet`);
    }
    expect({ newer: everything(newer), older: everything(older) }).toEqual(before);
  });

  it("a writer or a reader migrates", () => {
    const path = oldScheme();
    const before = everything(path);
    for (const mode of ["write", "read"] as const) {
      expect(() => openHome(openHomeFolder(dirname(path)), mode), mode).toThrow(`home.db is at version ${BASE}; this release reads ${LATEST}: the home has not started this release yet`);
    }
    expect(everything(path)).toEqual(before);
    openHome(openHomeFolder(dirname(path)), "migrate").close();
    for (const mode of ["write", "read"] as const) openHome(openHomeFolder(dirname(path)), mode).close();
    const none = fresh();
    raw(none, () => undefined);
    expect(() => openHome(openHomeFolder(dirname(none)), "read")).toThrow("home.db holds no schema yet: the home has not started this release yet");
    const unknown = oldScheme();
    raw(unknown, (db) => db.exec("DELETE FROM meta WHERE key = 'steps'"));
    const unknownBefore = everything(unknown);
    for (const mode of ["migrate", "write", "read"] as const) {
      expect(() => openHome(openHomeFolder(dirname(unknown)), mode), mode).toThrow("home.db holds tables but records no version, so no release can tell what it holds");
    }
    expect(everything(unknown)).toEqual(unknownBefore);
  });

  it("a second opener migrates again, or reads the version before it holds the write lock", () => {
    const path = oldScheme();
    let second: unknown = null;
    const watched = withMore((db) => {
      if (db.name !== path) return void db.exec("CREATE TABLE synthetic_more (id INTEGER PRIMARY KEY)");
      const other = new Database(path, { timeout: 0 });
      try {
        withMore(() => undefined).open(other, "migrate");
        second = "migrated";
      } catch (error) {
        second = (error as { code?: string }).code;
      } finally {
        other.close();
      }
      db.exec("CREATE TABLE synthetic_more (id INTEGER PRIMARY KEY)");
    });
    expect(openWith(path, watched, "migrate")).toMatchObject({ from: BASE, to: LATEST + 1 });
    expect(second).toBe("SQLITE_BUSY");
    const log: JsonObject[] = [];
    expect(openWith(path, watched, "migrate", log)).toBeNull();
    expect(log).toEqual([]);
    const statements: string[] = [];
    const db = new Database(oldScheme());
    try {
      homeSchema.open(new Proxy(db, {
        get(target, key) {
          const value = Reflect.get(target, key, target) as unknown;
          if (typeof value !== "function") return value;
          if (key !== "exec" && key !== "prepare" && key !== "pragma") return value.bind(target);
          return (text: string, ...rest: unknown[]) => {
            statements.push(text);
            return (value as (...args: unknown[]) => unknown).call(target, text, ...rest);
          };
        },
      }), "migrate");
    } finally {
      db.close();
    }
    const locked = statements.indexOf("BEGIN IMMEDIATE");
    const read = statements.findIndex((text) => /user_version/u.test(text));
    expect(locked, statements.join("\n")).toBeGreaterThanOrEqual(0);
    expect(read, statements.join("\n")).toBeGreaterThan(locked);
    found.order = statements.slice(0, read + 1);
  });
});
