import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { homeSchema, KEEP_BYTES, openHomeFolder } from "@lifestreamprotocol/core";
import { ledgerSchema } from "@lifestreamprotocol/model";
import { mintPrincipal } from "./principals.js";
import type { Stated, Statement } from "./stated.js";
import { HomeFile } from "./home-file.js";
import { machine } from "./machine.js";
import { SearchIndex, searchFileOf } from "./search-index.js";
import { CATCH_UP, daysLeft, keepDay, needs, readDisk, readStreams, FREE_BYTES, type DiskReading, type FreeDay } from "./status.js";
import { fakeDeclarations } from "./test/fakes.js";
import { freeSpace } from "./test/harness-root.js";
import { statusOf } from "./test/harness-status.js";
import { DAY, HOUR, land, openTestHome, removeDir, SETTINGS, T0, tempDir, writeArtifact, writeFolder } from "./test/ops-support.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()!();
});

const RARE = ["deliveries_lost", "deliveries_unread", "extracts_aside_since", "dirty_units_set_aside", "dirty_days_set_aside", "enrichments_given_up"];
const WALKS: { of: RegExp; why: string }[] = [
  { of: /^SELECT coalesce\(max\(seq\), 0\) AS seq FROM statements$/u, why: "max(seq): one entry, the newest" },
  { of: /^SELECT min\(day\) FROM inbox_days$/u, why: "min(day), the key's second column: every row of `inbox_days`, as the next" },
  { of: /^SELECT kind FROM runs WHERE kind > \? ORDER BY kind LIMIT 1$/u, why: "the next kind after one: one entry of `runs_started`, once a kind" },
  { of: /^SELECT lane, day, bytes FROM inbox_days WHERE day >= \? ORDER BY lane, day$/u, why: "a row per lane a day: 1,108 rows on the live home, 8 ms (12 Nov)" },
  { of: /^SELECT family, item, prompt, route, model FROM item_routes ORDER BY family, item$/u, why: "a row per item the person chose a model for by hand: none on the live home (12 Nov)" },
  { of: /FROM attempts a JOIN requests r ON r\.key = a\.key WHERE a\.started >= \? AND r\.family IS NOT NULL GROUP BY r\.family$/u, why: "today's calls (`spend`)" },
  { of: /FROM attempts a INDEXED BY attempts_finished JOIN requests r ON r\.key = a\.key WHERE a\.finished >= \? AND a\.state = 'replied' GROUP BY a\.transport, r\.model$/u, why: "the last ten minutes' replies (`rates`' pace)" },
];
const BOUNDED = [
  "SELECT s.id, (SELECT count(*) FROM (SELECT 1 FROM wanted_blobs INDEXED BY wanted_blobs_record WHERE source = s.id LIMIT 1001)) AS n FROM sources s",
  "SELECT s.id, (SELECT sealed_ms FROM lost_files INDEXED BY lost_files_sealed WHERE source = s.id ORDER BY sealed_ms LIMIT 1) AS since_ms FROM sources s",
  "SELECT s.id FROM sources s WHERE EXISTS (SELECT 1 FROM wanted_blobs INDEXED BY wanted_blobs_record WHERE source = s.id)",
  "SELECT state FROM deliveries WHERE id = 'a' AND source = 'b'",
];
const UNBOUNDED = [
  "SELECT s.id, (SELECT count(*) FROM (SELECT DISTINCT blob FROM wanted_blobs INDEXED BY wanted_blobs_record WHERE source = s.id LIMIT 1001)) AS n FROM sources s",
  `SELECT s.id, (SELECT count(*) FROM (SELECT DISTINCT w.blob FROM wanted_blobs w INDEXED BY wanted_blobs_record
      JOIN statements st INDEXED BY statements_record ON st.kind = w.kind AND st.key = w.key AND st.source = w.source
      JOIN version_blobs vb ON vb.version = st.version AND vb.blob = w.blob
      JOIN deliveries d INDEXED BY deliveries_sealed ON d.source = w.source AND d.run = st.run AND d.lost IS NOT NULL
      WHERE w.source = s.id LIMIT 1001)) AS files FROM sources s`,
  `SELECT count(*) FROM (SELECT DISTINCT w.blob FROM wanted_blobs w INDEXED BY wanted_blobs_record WHERE w.source = 'a'
    AND EXISTS (SELECT 1 FROM statements s INDEXED BY statements_record JOIN version_blobs vb ON vb.version = s.version AND vb.blob = w.blob
      WHERE s.kind = w.kind AND s.key = w.key AND s.source = w.source AND s.run = 1) LIMIT 1001)`,
  "SELECT s.id, (SELECT count(*) FROM (SELECT 1 FROM wanted_blobs w INDEXED BY wanted_blobs_record JOIN version_blobs vb ON vb.blob = w.blob WHERE w.source = s.id LIMIT 1001)) AS n FROM sources s",
  "SELECT count(*) FROM wanted_blobs INDEXED BY wanted_blobs_record WHERE source = 'a' LIMIT 1",
  "SELECT blob FROM wanted_blobs INDEXED BY wanted_blobs_record WHERE source = 'a'",
  "SELECT count(*) FROM (SELECT DISTINCT blob FROM wanted_blobs LIMIT 1001)",
];
const NOT_ALIAS = new Set(["as", "indexed", "not", "where", "join", "cross", "left", "inner", "natural", "on", "using", "group", "order", "limit", "union", "set", "values"]);

interface Planned {
  file: string;
  sql: string;
  plan: string[];
  lines: readonly { id: number; parent: number; detail: string }[];
  tables: readonly string[];
  growing: readonly string[];
}

const STREAM = new Set(["source", "kind", "family"]);

const GATHERS = /\b(?:count|sum|total|avg|min|max|group_concat)\s*\(|\bGROUP\s+BY\b|\bDISTINCT\b/iu;

function queriesOf(sql: string): { own: string; exists: boolean }[] {
  const found: { start: number; end: number; exists: boolean }[] = [{ start: 0, end: sql.length, exists: false }];
  const open: number[] = [];
  const starts: (number | null)[] = [];
  for (let at = 0; at < sql.length; at++) {
    if (sql[at] === "(") {
      open.push(at);
      starts.push(/^\(\s*SELECT\b/iu.test(sql.slice(at, at + 16)) ? at : null);
    } else if (sql[at] === ")") {
      open.pop();
      const start = starts.pop();
      if (start !== null && start !== undefined) found.push({ start, end: at + 1, exists: /\bEXISTS\s*$/iu.test(sql.slice(0, start)) });
    }
  }
  return found.map(({ start, end, exists }) => {
    let own = sql.slice(start, end);
    for (const inner of found) if (inner.start > start && inner.end <= end) own = own.replace(sql.slice(inner.start, inner.end), "()");
    return { own, exists };
  });
}

function walks({ sql, lines, tables, growing }: Planned): boolean {
  const named = new Map(tables.map((table) => [table, table]));
  for (const table of tables) {
    for (const match of sql.matchAll(new RegExp(`\\b${table}\\s+(?:AS\\s+)?(\\w+)`, "giu"))) {
      if (!NOT_ALIAS.has(match[1]!.toLowerCase())) named.set(match[1]!, table);
    }
  }
  const subqueries = new Set(lines.flatMap(({ detail }) => /^(?:CO-ROUTINE|MATERIALIZE) (.+)$/u.exec(detail)?.[1] ?? []));
  const reads = lines.flatMap((line) => {
    const read = /^(SCAN|SEARCH) (\S+)(?: AS (\S+))?(?: USING (.*?))?(?: \((.*)\))?$/u.exec(line.detail);
    if (read === null || line.detail === "SCAN CONSTANT ROW" || / VIRTUAL TABLE\b/u.test(line.detail) || subqueries.has(read[2]!)) return [];
    return [{ ...line, how: read[1]!, name: read[3] ?? read[2]!, using: read[4] ?? "", bound: read[5] ?? "" }];
  });
  const queries = queriesOf(sql.replace(/\s+/gu, " "));
  return reads.some((read) => {
    const table = named.get(read.name);
    if (table === undefined) return true;
    if (!growing.includes(table) || RARE.some((index) => read.detail.endsWith(`INDEX ${index}`))) return false;
    if (read.how === "SCAN" || !/=/u.test(read.bound)) return true;
    if ([...read.bound.matchAll(/(\w+)[=<>]/gu)].some((match) => !STREAM.has(match[1]!))) return false;
    const alone = !lines.some((other) => other.parent === read.parent && other.id !== read.id && /^(?:SCAN|SEARCH|USE TEMP B-TREE)\b/u.test(other.detail)
      && !subqueries.has(/^(?:SCAN|SEARCH) (\S+)/u.exec(other.detail)?.[1] ?? ""));
    const reading = read.name === table ? new RegExp(`\\b(?:FROM|JOIN)\\s+${table}\\b`, "iu") : new RegExp(`\\b${table}\\s+(?:AS\\s+)?${read.name}\\b`, "iu");
    const own = queries.filter((query) => reading.test(query.own));
    const limited = own.length > 0 && own.every((query) => (query.exists || /\bLIMIT\b/iu.test(query.own)) && !GATHERS.test(query.own));
    return !(alone && limited);
  });
}

function walksOf(plans: readonly Planned[]): { walking: { file: string; text: string; plan: string[] }[]; unlisted: string[] } {
  const walking = plans.filter(walks).map(({ file, sql, plan }) => ({ file, text: sql.replace(/\s+/gu, " ").trim(), plan }));
  return { walking, unlisted: walking.filter(({ text }) => !WALKS.some((walk) => walk.of.test(text))).map(({ file, text, plan }) => `${file}: ${text}\n  ${plan.join("\n  ")}`) };
}

function planned(root: string, file: "home.db" | "replies.db", seen: readonly { sql: string; file: string; args: unknown[] }[]): Planned[] {
  const reader = new Database(join(root, ...(file === "home.db" ? [] : ["replies"]), file), { readonly: true });
  try {
    const small = file === "home.db" ? homeSchema.small : ledgerSchema.small;
    const tables = reader.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").pluck().all() as string[];
    const growing = tables.filter((table) => !small.has(table));
    return seen.filter((each) => each.file.endsWith(file) && /^\s*SELECT/iu.test(each.sql)).map(({ sql, args }) => {
      const lines = reader.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { id: number; parent: number; detail: string }[];
      return { file, sql, tables, growing, lines, plan: lines.map((row) => row.detail) };
    });
  } finally {
    reader.close();
  }
}
const NOW = T0 + 10 * DAY;
const NO_FAMILIES = [] as const;
const ACCOUNT = "person-a@example.com";

function recorded(work: () => void): { sql: string; file: string; args: unknown[]; connection: object }[] {
  const probe = new Database(":memory:");
  const statement = Object.getPrototypeOf(probe.prepare("SELECT 1")) as Record<string, (...args: unknown[]) => unknown>;
  probe.close();
  const seen: { sql: string; file: string; args: unknown[]; connection: object }[] = [];
  const originals = Object.fromEntries(["get", "all", "iterate", "run"].map((name) => [name, statement[name]!]));
  for (const [name, original] of Object.entries(originals)) {
    statement[name] = function (this: { source: string; database: { name: string } }, ...args: unknown[]) {
      seen.push({ sql: this.source, file: this.database.name, args, connection: this.database });
      return original.apply(this, args);
    };
  }
  try {
    work();
  } finally {
    Object.assign(statement, originals);
  }
  return seen;
}

describe("status reads by seek", () => {
  it("a status query walks a table that grows with the home", () => {
    const root = tempDir("status-plans");
    const test = openTestHome(root);
    cleanup.push(() => removeDir(root), () => test.close());
    const source = "imessage:local:mac-0001";
    for (let n = 0; n < 3; n++) land(test.db, { source, stated_ms: NOW - n * HOUR, rows: [{ kind: "msg", key: `m${n}`, content: { text: `synthetic ${n}` } }] });
    test.db.commit((tx) => {
      for (const kind of ["extract", "plan", "render", "repair"]) {
        const run = tx.tables.runs.start({ kind, subject: kind === "repair" ? source : "messages/1", started_ms: NOW - HOUR });
        tx.tables.runs.end(run, { ended_ms: NOW - HOUR, outcome: "ok", counts: { written: 1 } });
      }
      tx.tables.jobs.enqueue({ kind: "repair", key: "1", lane: 5, not_before_ms: NOW, now_ms: NOW });
      tx.tables.deliveries.add({ id: `${source}/blocked`, source, sealed_ms: NOW, stated_ms: NOW, facts: {}, lost: [{ items: 2, what: "synthetic rows" }] });
      tx.tables.deliveries.move(`${source}/blocked`, source, { move: "begin", run: tx.tables.runs.start({ kind: "import", subject: `${source} ${source}/blocked`, started_ms: NOW }) });
      tx.tables.deliveries.move(`${source}/blocked`, source, { move: "fail", error: "synthetic failure" });
      tx.tables.jobs.enqueue({ kind: "import", key: source, lane: 0, not_before_ms: NOW, now_ms: NOW });
      const job = tx.tables.jobs.take(NOW)!;
      for (let tries = 0; tries < 5; tries++) tx.tables.jobs.fail(job.id, "synthetic failure", NOW);
      tx.tables.devices.add({ unit: "iphone-aa01", model: "Synthetic iPhone", added_ms: T0 });
      tx.derived.extracts.aside.put("messages", "messages/2", "synthetic throw", NOW);
    });
    const seen = recorded(() => statusOf(root, { now_ms: NOW, settings: SETTINGS, families: NO_FAMILIES }));
    const connections = (file: string) => new Set(seen.filter((each) => each.file.endsWith(file)).map((each) => each.connection)).size;
    expect([connections("home.db"), connections("replies.db")]).toEqual([1, 1]);
    const plans = [...planned(root, "home.db", seen), ...planned(root, "replies.db", seen)];
    expect(new Set(plans.map((each) => each.file))).toEqual(new Set(["home.db", "replies.db"]));
    const { walking, unlisted } = walksOf(plans);
    const stale = WALKS.filter((walk) => !walking.some(({ text }) => walk.of.test(text))).map((walk) => `${walk.of} (${walk.why})`);
    writeArtifact("status-plans", plans);
    expect(unlisted).toEqual([]);
    expect(stale, "a listed walk no longer runs or walks").toEqual([]);
    expect(plans.filter(({ sql }) => sql.includes("extracts_aside")).flatMap(({ plan }) => plan)).toEqual([
      "SCAN extracts_aside USING COVERING INDEX extracts_aside_since",
      "SEARCH extracts_aside USING INDEX sqlite_autoindex_extracts_aside_1 (family=?)",
    ]);
  });

  it("the census passes a walk: an aggregate a LIMIT ends, a subquery, a table under a long alias, a capped count of no source, a capped DISTINCT or join, or a range no LIMIT ends", () => {
    const root = tempDir("status-census");
    const test = openTestHome(root);
    cleanup.push(() => removeDir(root), () => test.close());
    statusOf(root, { now_ms: NOW, settings: SETTINGS, families: NO_FAMILIES });
    const ran = (file: string, sql: string, ...args: unknown[]) => ({ file, sql, args });
    const judged = (file: "home.db" | "replies.db", ...statements: [string, ...unknown[]][]) =>
      planned(root, file, statements.map(([sql, ...args]) => ran(file, sql, ...args))).map((each) => [each.sql, walks(each)]);
    expect(judged("home.db",
      ["SELECT family, count(*) AS n FROM asks INDEXED BY asks_hashes WHERE state = 'pending' GROUP BY family"],
      ["SELECT count(*) AS n FROM asks AS backlog WHERE state = 'pending'"],
      ["SELECT count(*) AS n FROM asks backlog WHERE state = 'pending'"],
      ["SELECT (SELECT count(*) FROM heads) AS n"],
      ["SELECT value FROM meta WHERE key = ?", "asks:left"],
      ...BOUNDED.map((sql) => [sql] as [string]),
      ...UNBOUNDED.map((sql) => [sql] as [string]),
    )).toEqual([
      ["SELECT family, count(*) AS n FROM asks INDEXED BY asks_hashes WHERE state = 'pending' GROUP BY family", true],
      ["SELECT count(*) AS n FROM asks AS backlog WHERE state = 'pending'", true],
      ["SELECT count(*) AS n FROM asks backlog WHERE state = 'pending'", true],
      ["SELECT (SELECT count(*) FROM heads) AS n", true],
      ["SELECT value FROM meta WHERE key = ?", false],
      ...BOUNDED.map((sql) => [sql, false]),
      ...UNBOUNDED.map((sql) => [sql, true]),
    ]);
    const price = `SELECT r.prompt AS prompt, r.model AS model, avg(a.cost_usd) AS usd FROM attempts a INDEXED BY attempts_finished JOIN requests r ON r.key = a.key
      WHERE a.finished >= ? AND a.state = 'replied' AND a.cost_usd IS NOT NULL AND r.prompt IS NOT NULL GROUP BY r.prompt, r.model`;
    expect(judged("replies.db", ["SELECT sum(cost_usd) FROM attempts LIMIT 1"], [price, "2026-10-01"], ["SELECT text FROM replies WHERE key = ?", "a-key"]).map(([, walked]) => walked))
      .toEqual([true, true, false]);
  });
});

describe("the record index's unresolved entries", () => {
  it("status states the count its index keeps in one row, and reads no entry to say it", () => {
    const root = tempDir("status-unresolved");
    writeFolder(root);
    const test = openTestHome(root);
    cleanup.push(() => removeDir(root), () => test.close());
    const file = searchFileOf(root, machine().dir);
    const at = { position: { seq: 1, statement: "s-1", reread: 0 } };
    const built = SearchIndex.write(openHomeFolder(root), file, () => true, 0, SETTINGS.day);
    built.records([], [], at);
    built.finish();
    const index = SearchIndex.write(openHomeFolder(root), file, () => true, 0, SETTINGS.day);
    try {
      index.records(["n1", "n2"].map((key) => ({
        record: { source: "imessage:local:mac-0001", kind: "msg", key }, family: "messages", version: `v-${key}`, start_ms: NOW, end_ms: null, title: "", text: `synthetic ${key}`, who: [], link: null,
      })), [], { position: { seq: 2, statement: "s-2", reread: 0 } });
    } finally {
      index.close();
    }
    const db = new Database(file);
    try {
      db.prepare("UPDATE meta SET value = '41' WHERE key = 'unstated'").run();
    } finally {
      db.close();
    }
    let unresolved: number | null | undefined;
    const seen = recorded(() => {
      unresolved = statusOf(root, { now_ms: NOW, settings: SETTINGS, families: NO_FAMILIES }).search?.unresolved;
    });
    expect(unresolved).toBe(41);
    const read = seen.filter((each) => each.file === file).map((each) => each.sql);
    expect(read).toContain("SELECT value FROM meta WHERE key = ?");
    expect(read.filter((sql) => /\bentries\b/u.test(sql))).toEqual([]);
  });
});

describe("a report's cost", () => {
  function homeOf(accounts: number, kinds: readonly string[]): string {
    const root = tempDir("status-cost");
    const test = openTestHome(root);
    cleanup.push(() => removeDir(root));
    try {
      for (let at = 0; at < accounts; at++) {
        for (const product of ["gmail", "youtube"]) {
          const source = `${product}:person-${at}@example.com:cloud`;
          land(test.db, { source, stated_ms: NOW - HOUR, rows: kinds.map((kind, n) => ({ kind, key: `${kind}-${n}`, content: { text: `synthetic ${n}` }, time: { start_ms: NOW - (n + 1) * HOUR, precision: "ms" as const } })) });
          test.db.commit((tx) => {
            tx.tables.deliveries.add({ id: `${source}/lost`, source, sealed_ms: NOW, stated_ms: NOW, facts: { left: 3 }, lost: [{ items: 1, what: "synthetic rows" }] });
            tx.tables.backfills.paged({ source, acquirer: product, left: 0, unit: null, start_ms: null, at_ms: NOW, delivery: `${source}/lost` });
          });
        }
      }
      test.db.commit((tx) => tx.tally.prune(SETTINGS.day, NOW));
      for (const chunk of test.db.commit((tx) => tx.tally.chunks(SETTINGS.day))) test.db.commit((tx) => tx.tally.rebuild(chunk));
      test.db.commit((tx) => tx.tally.complete());
    } finally {
      test.close();
    }
    return root;
  }

  function ran(root: string): Record<"status" | "connectors" | "needs", { sql: string; file: string; args: unknown[] }[]> {
    const options = { folder: openHomeFolder(root), now_ms: NOW, settings: SETTINGS, connectors: fakeDeclarations(), families: [], ledger: null };
    const machine = tempDir("status-cost-machine");
    cleanup.push(() => removeDir(machine));
    const read = <T>(work: (db: Database.Database) => T) => new HomeFile(openHomeFolder(root), 5_000).read(work);
    const ungrouped = fakeDeclarations().filter((connector) => !Object.values(connector.fields ?? {}).some((field) => field.home === true));
    return {
      status: recorded(() => statusOf(root, { now_ms: NOW, settings: SETTINGS, families: NO_FAMILIES })),
      connectors: recorded(() => read((db) => readStreams(db, { ...options, registry: { connectors: ungrouped, families: [] }, machine, sites: null, present: [] }))),
      needs: recorded(() => read((db) => needs(db, options))),
    };
  }

  it("a report runs a statement per stream, or reads heads or versions, or walks", () => {
    const manyRoot = homeOf(4, ["msg", "sample"]);
    const [few, many] = [ran(homeOf(1, ["msg"])), ran(manyRoot)];
    const counts = (reports: ReturnType<typeof ran>) => Object.fromEntries(Object.entries(reports).map(([name, seen]) => [name, seen.length]));
    writeArtifact("status-cost", { few: counts(few), many: counts(many), statements: Object.fromEntries(Object.entries(many).map(([name, seen]) => [name, seen.map((each) => each.sql.replace(/\s+/gu, " "))])) });
    expect(counts(many)).toEqual(counts(few));
    expect(many.connectors.filter(({ sql }) => /\bstart_minutes\b/u.test(sql))).toHaveLength(1);
    for (const seen of Object.values(many)) expect(seen.filter(({ sql }) => /\b(heads|versions)\b/u.test(sql)).map(({ sql }) => sql)).toEqual([]);
    for (const [name, seen] of Object.entries(many)) expect(walksOf(planned(manyRoot, "home.db", seen)).unlisted, name).toEqual([]);
  });
});

describe("a unit set aside", () => {
  it("status names the plan for the extract, or leaves out a unit with no served row", () => {
    const root = tempDir("status-aside");
    const test = openTestHome(root);
    cleanup.push(() => removeDir(root), () => test.close());
    test.db.commit((tx) => {
      tx.derived.extracts.put({ family: "messages", unit: "messages/1", reading: "r", code: "1", content: {}, start_ms: T0, end_ms: T0, days: [], seq: 0 });
      tx.derived.extracts.aside.put("messages", "messages/1", "a build that threw", NOW);
      tx.derived.extracts.aside.put("messages", "messages/2", "a first build that threw", NOW - DAY);
    });
    const report = statusOf(root, { now_ms: NOW, settings: SETTINGS, families: NO_FAMILIES });
    expect(report.notices.filter((each) => each.id.startsWith("extract:")).map(({ id, since_ms, what }) => ({ id, since_ms, what }))).toEqual([{
      id: "extract:messages",
      since_ms: NOW - DAY,
      what: "messages: 2 units set aside, the extract threw; each keeps its last build where it has one (run extract messages builds them again, as new evidence and the next start do): messages/1: a build that threw; messages/2: a first build that threw",
    }]);
  });
});

describe("the days left", () => {
  const day = (n: number, gb: number, disk = "disk-a"): FreeDay => ({ day: `2026-09-${String(n).padStart(2, "0")}`, at_ms: T0 + n * DAY, bytes: gb * 1e9, disk, catch_up: 0 });
  const now = (gb: number, disk = "disk-a"): DiskReading => ({ disk, at_ms: NOW, bytes: gb * 1e9 });
  const left = (days: readonly FreeDay[], reading: DiskReading) => daysLeft(days, reading, 0, 0).days_left;

  it("a disk filling at a steady rate goes unnoticed, or one not filling, or with under a day of records, raises a notice, or counts its days to zero", () => {
    expect(left([day(1, 200), day(3, 180), day(8, 130)], now(110))).toBe(10);
    expect(left([day(1, 200), day(8, 190)], now(189))).toBe(150);
    expect(left([day(1, 14)], now(5))).toBe(0);
    const today: FreeDay = { day: "2026-09-10", at_ms: NOW - HOUR, bytes: 100e9, disk: "disk-a", catch_up: 0 };
    expect(left([day(1, 100), day(8, 120)], now(120)), "freeing").toBeNull();
    expect(daysLeft([day(1, 100), day(8, 120)], now(120), 0, 0), "freeing").toEqual({ steady_bytes_a_day: null, days_left: null });
    expect(left([today], now(90)), "under a day").toBeNull();
    expect(left([], now(90)), "none").toBeNull();
  });

  it("the forecast mixes disks, or keeps another disk's days, or waits a day to see room freed", () => {
    const drive = [day(6, 438.9, "disk-b"), day(7, 452.2, "disk-b"), day(8, 457.5, "disk-b")];
    expect(left([...drive, day(9, 43)], now(42))).toBe(37);
    expect(left(drive, now(43))).toBeNull();
    expect(left([day(1, 200), day(8, 130)], now(220))).toBeNull();
    expect(keepDay([...drive, day(9, 43, "disk-c")], day(10, 42)).map((each) => each.day)).toEqual(["2026-09-10"]);
    const week = [1, 2, 3, 4, 5, 6, 7].map((n) => day(n, 300 - n));
    expect(keepDay([...week, day(8, 290)], day(8, 270)).map((each) => [each.day, each.bytes / 1e9])).toEqual([
      ["2026-09-02", 298], ["2026-09-03", 297], ["2026-09-04", 296], ["2026-09-05", 295], ["2026-09-06", 294], ["2026-09-07", 293], ["2026-09-08", 270],
    ]);
  });

  it("status reads another forecast than the disk now, or a disk named by another folder as this one", () => {
    const root = tempDir("status-disk");
    const test = openTestHome(root);
    cleanup.push(() => removeDir(root), () => test.close());
    const status = (days: FreeDay[]) => {
      test.db.commit((tx) => tx.tables.meta.set(FREE_BYTES, JSON.stringify(days)));
      return statusOf(root, { now_ms: NOW, settings: SETTINGS, families: NO_FAMILIES });
    };
    const disk = readDisk(root, NOW);
    const kept = (name: string): FreeDay[] => [{ day: "2026-09-01", at_ms: T0 + DAY, bytes: Math.round(disk.bytes + 9 * (disk.bytes - KEEP_BYTES) / 9.5), disk: name, catch_up: 0 }];
    const filling = status(kept(disk.disk));
    expect(filling.disk.days_left).toBe(9);
    expect(filling.disk.free_bytes).toBeGreaterThan(0);
    expect(filling.needs.filter((need) => need.id === "disk")).toEqual([expect.objectContaining({ id: "disk", state: "needs-you", words: "Lifestream's disk fills in about 9\u00a0days", line: expect.stringMatching(/^[\d,.]+\u00a0[GM]B left/u) })]);
    const moved = status(kept(`${root}-elsewhere ${disk.disk.split(" ").at(-1)}`));
    expect(moved.disk.days_left).toBeNull();
    expect(moved.needs.filter((need) => need.id === "disk")).toEqual([]);
    writeArtifact("status-disk", { filling: filling.disk, moved: moved.disk });
  });

  it("a catch-up reads as steady growth, or what is coming is left out of the days, or photos that do not fit raise the days notice", () => {
    const root = tempDir("status-catch-up");
    const test = openTestHome(root);
    cleanup.push(() => removeDir(root), () => test.close());
    const disk = readDisk(root, NOW);
    const steady = Math.floor((disk.bytes - KEEP_BYTES) / 40.5);
    const caught = 50e9;
    const readings: FreeDay[] = [3, 4, 5, 6, 7, 8, 9].map((n) => ({
      day: `2026-09-${String(n).padStart(2, "0")}`, at_ms: T0 + n * DAY, disk: disk.disk, bytes: disk.bytes + (10 - n) * steady + (n <= 5 ? caught : 0), catch_up: n === 6 ? caught : 0,
    }));
    const wanting = (n: number, size: number) => test.db.commit((tx) => tx.derived.extracts.put({
      family: "photos", unit: `wanted/apple-photos:${ACCOUNT}:iphone-aa01/PHOTO-${n}/L0/001`, reading: `r${n}`, code: "10", start_ms: null, end_ms: null, days: [], seq: 0,
      content: { at_ms: null, missing: [{ type: "video", name: `IMG_${n}.MOV`, size }], routes: [{ source: `apple-photos:${ACCOUNT}:iphone-aa01`, asset: `PHOTO-${n}/L0/001`, files: ["video"], refused: false }] },
    }));
    test.db.commit((tx) => {
      tx.tables.meta.set(FREE_BYTES, JSON.stringify(readings));
      tx.tables.meta.set(CATCH_UP, "0");
    });
    const status = () => statusOf(root, { now_ms: NOW, settings: SETTINGS, families: NO_FAMILIES });
    const diskNeeds = (report: ReturnType<typeof status>) => report.needs.filter((need) => need.id === "disk" || need.id === "photos:room")
      .map(({ id, words, acts }) => ({ id, what: words, acts }));
    const storage = [{ do: "storage", label: "Free up space" }];
    const near = (measured: number | null, expected: number) => measured !== null && Math.abs(measured - expected) <= expected / 1000;
    const shape = ({ free_bytes, coming, steady_bytes_a_day, days_left }: ReturnType<typeof status>["disk"]) =>
      ({ free_bytes: near(free_bytes, disk.bytes), coming, steady_bytes_a_day: near(steady_bytes_a_day, steady), days_left });
    const quiet = status();
    expect(shape(quiet.disk)).toEqual({ free_bytes: true, coming: 0, steady_bytes_a_day: true, days_left: 40 });
    expect(diskNeeds(quiet)).toEqual([]);
    const coming = Math.round(disk.bytes - KEEP_BYTES - 20.5 * steady);
    wanting(1, coming);
    const filling = status();
    expect(shape(filling.disk)).toEqual({ free_bytes: true, coming, steady_bytes_a_day: true, days_left: 20 });
    expect(diskNeeds(filling)).toEqual([{ id: "disk", what: "Lifestream's disk fills in about 20\u00a0days", acts: storage }]);
    test.db.commit((tx) => tx.tables.meta.set(CATCH_UP, String(steady)));
    const counted = status();
    expect(near(counted.disk.steady_bytes_a_day, 6 * steady / 7)).toBe(true);
    test.db.commit((tx) => tx.tables.meta.set(CATCH_UP, "0"));
    wanting(2, 21 * steady);
    const short = status();
    expect(short.disk.coming).toBe(coming + 21 * steady);
    expect(diskNeeds(short)).toEqual([{ id: "photos:room", what: expect.stringMatching(/^Photos need [\d,.]+\u00a0[GM]B more$/u), acts: storage }]);
    writeArtifact("status-catch-up", { steady_bytes_a_day: steady, caught_up: caught, quiet: quiet.disk, filling: filling.disk, counted: counted.disk, short: { disk: short.disk, needs: diskNeeds(short) } });
  });

  it("a home's disk low or full raises no need, or both, or another's words, or the days or photos beside it; full is the banner's, low is advice", () => {
    const root = tempDir("status-room");
    const test = openTestHome(root);
    cleanup.push(() => removeDir(root), () => test.close());
    const storage = [{ do: "storage", label: "Free up space" }];
    test.db.commit((tx) => tx.derived.extracts.put({
      family: "photos", unit: `wanted/apple-photos:${ACCOUNT}:iphone-aa01/PHOTO-1/L0/001`, reading: "r1", code: "10", start_ms: null, end_ms: null, days: [], seq: 0,
      content: { at_ms: null, missing: [{ type: "video", name: "IMG_1.MOV", size: 2e12 }], routes: [{ source: `apple-photos:${ACCOUNT}:iphone-aa01`, asset: "PHOTO-1/L0/001", files: ["video"], refused: false }] },
    }));
    const free = freeSpace(6e9);
    const needs = () => statusOf(root, { now_ms: NOW, settings: SETTINGS, families: NO_FAMILIES }).needs
      .filter((need) => need.id.startsWith("disk") || need.id === "photos:room").map(({ id, state, words, line, acts, weight, banner }) => ({ id, state, words, line, acts, weight, banner }));
    const ok = needs();
    free.set(4e9);
    const low = needs();
    free.set(0.5e9);
    const full = needs();
    expect(ok.map((need) => need.id)).toEqual(["photos:room"]);
    expect(low).toEqual([{ id: "disk:low", state: "needs-you", words: "Lifestream's disk is almost full", line: "History, photos and imports wait for 5 GB free", acts: storage, weight: "advice", banner: false }]);
    expect(full).toEqual([{ id: "disk:full", state: "broken", words: "Lifestream's disk is full", line: "Nothing new is saved", acts: storage, weight: "stopped", banner: true }]);
    writeArtifact("status-room", { ok, low, full });
  });

  it("raises the home's own Mac's disk beside the home's disk need on the Mac's own disk, or drops it on another, or drops a former home Mac's", () => {
    const word = (pass: string, since_ms: number): Statement => ({
      pass, grants: null, found: null, imports: null, settings: null, sending: {}, room: { value: "low", since_ms: NOW },
      network: { value: { allows: "all", loopback: true }, since_ms }, recorder: null, stores: null, heard_ms: NOW, waiting_since_ms: null,
    });
    const roomNeeds = (name: string, machine: string): string[] => {
      const root = tempDir(name);
      const test = openTestHome(root);
      cleanup.push(() => removeDir(root), () => test.close());
      mkdirSync(join(root, "config"));
      const pass = (unit: string) => mintPrincipal(openHomeFolder(root), { unit, kind: "mac", scopes: ["deliver"], sources: [`apple-notes:local:${unit}`], now_ms: NOW }).principal.id;
      const stated: Stated = { "macbook-pro-aa41": word(pass("macbook-pro-aa41"), NOW - DAY), "macbook-pro-0001": word(pass("macbook-pro-0001"), NOW - HOUR) };
      const before = process.env.LIFESTREAM_MACHINE_DIR;
      process.env.LIFESTREAM_MACHINE_DIR = machine;
      try {
        return statusOf(root, { now_ms: NOW, settings: SETTINGS, families: NO_FAMILIES, stated }).needs.map((need) => need.id).filter((id) => id.startsWith("disk") || id.startsWith("room:")).sort();
      } finally {
        process.env.LIFESTREAM_MACHINE_DIR = before;
      }
    };
    freeSpace(4e9);
    const machine = tempDir("status-machine");
    cleanup.push(() => removeDir(machine));
    const shared = roomNeeds("status-one-disk", machine);
    const apart = roomNeeds("status-two-disks", "/dev");
    expect(shared).toEqual(["disk:low", "room:macbook-pro-aa41"]);
    expect(apart).toEqual(["disk:low", "room:macbook-pro-0001", "room:macbook-pro-aa41"]);
    writeArtifact("status-one-disk", { shared, apart });
  });

  it("a report that does not name its release, or leaves out a family rebuilding, or keeps one done", () => {
    const root = tempDir("status-release");
    const test = openTestHome(root);
    cleanup.push(() => removeDir(root), () => test.close());
    test.db.commit((tx) => {
      tx.tables.cursors.move("rebuild:screen", { seq: 40, at_ms: NOW });
      tx.tables.cursors.move("rebuild:messages", { seq: 0, at_ms: NOW });
    });
    const report = statusOf(root, { now_ms: NOW, settings: SETTINGS, families: NO_FAMILIES });
    expect(report.release).toBe("checkout");
    expect(report.running.rebuilds).toEqual(["screen"]);
    writeArtifact("status-release", { release: report.release, rebuilds: report.running.rebuilds });
  });

  it("status names a source whose connector the release lacks before any delivery for it, and not a source the release reads", () => {
    const root = tempDir("status-unreadable");
    const test = openTestHome(root);
    cleanup.push(() => removeDir(root), () => test.close());
    test.db.commit((tx) => {
      tx.tables.sources.add({ id: "apple-notes:local:poll", vendor: "apple", connector: "fake-rows", added_ms: T0 });
      tx.tables.sources.add({ id: "bank:person-a:statement", vendor: "bank", connector: "bank-statement", added_ms: T0 + HOUR });
    });
    const report = statusOf(root, { now_ms: NOW, settings: SETTINGS, families: NO_FAMILIES });
    const unreadable = report.notices.filter((notice) => notice.id.startsWith("unreadable:"));
    expect(unreadable).toEqual([{ id: "unreadable:bank:person-a:statement", since_ms: T0 + HOUR,
      what: "bank:person-a:statement: this version of Lifestream has no connector for bank-statement. What Lifestream holds of it is kept, and it is read again once a connector for bank-statement is installed" }]);
    expect(report.notices.some((notice) => notice.id.startsWith("job:import:") || notice.id.startsWith("unread:"))).toBe(false);
    writeArtifact("status-unreadable", { unreadable });
  });
});
