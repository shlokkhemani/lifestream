import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type Database from "better-sqlite3";
import { openSqlite, type Reader } from "@lifestreamprotocol/connect";
import { LEDGER_STORE, ledgerFileOf, ledgerSchema } from "@lifestreamprotocol/model";
import { civilDay, emptyTable, HOME_STORE, homeSchema, RELEASE, render, UNREAD, type BlobStore, type HomeFolder, type Schema, type DaySettings, type Json, type JsonObject, type StoreKind } from "@lifestreamprotocol/core";
import { openHider, type NameTable, type PrivacySettings } from "@lifestreamprotocol/privacy";
import { deliveredFile, deliveryDirectory, inboxLane, readDelivery } from "./inbox.js";
import { prefixOf } from "./import.js";
import { machine } from "./machine.js";
import { peopleFileOf, readNameTable } from "./people.js";
import { readPrincipals } from "./principals.js";
import { homeRegistryModule } from "./programs.js";
import { readerFor, homeOf, loadRegistry, type Registry } from "./registry.js";
import { screenFileOf, screenStanding } from "./screen-index.js";
import { searchFileOf } from "./search-index.js";
import { RECORD_INDEX } from "./search.js";
import { effective, SettingsError } from "./settings.js";
import { forecast, LOG_BEHIND, photosComing, photosStart, readDisk, type Forecast } from "./status.js";
import { LOG_DRAIN, type DrainEnd } from "./write-log.js";

const DOOR_LOG = join(homedir(), "Library", "Logs", "lifestream", "door.log");

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const FAMILY_RUNS = ["extract", "walk", "plan", "render", "index"] as const;
const CASES = ["new", "changed", "restated", "gone", "late", "duplicated", "replayed", "erased", "refused", "reread"] as const;

export interface Window {
  from_ms: number;
  to_ms: number;
  door_log?: string;
  machine?: string;
}

export interface Spread {
  p50: number;
  p90: number;
  p99?: number;
  max: number;
}

export interface Report {
  window: { from_ms: number; to_ms: number };
  home: {
    release: string;
    sqlite: string;
    node: string;
    tz: string | null;
    databases: Record<string, { version: number; pages: number; page_bytes: number; free_pages: number } | null>;
    statements: number;
    versions: number;
    sources: Record<string, number>;
  };
  imports: Record<string, {
    deliveries: number;
    failed: number;
    rows: Record<string, number>;
    busy_seconds: number;
    rows_a_second: number | null;
    seal_to_import_seconds: Spread | null;
  }>;
  live: Record<string, { imports: number; shown: number; import_to_render_seconds: Spread | null }>;
  families: {
    by_family: Record<string, {
      extract?: { runs: number; statements: number; units: number; busy_seconds: number; statements_a_second: number | null; ms_a_unit: number | null };
      walk?: { runs: number; units: number; busy_seconds: number };
      plan?: { runs: number; units: number; busy_seconds: number; units_a_second: number | null };
    }>;
    render: { runs: number; days: number; busy_seconds: number; days_a_second: number | null };
    search: { runs: number; busy_seconds: number };
  };
  reads: { log: string | null; routes: Record<string, { requests: number; ms: Spread; refusals: Record<string, number> }> };
  log: {
    wal_bytes: number; largest_bytes: number;
    drains: number; emptied: number; outlasted: number; outside: number; drained_ms: number; longest_drain_ms: number;
    behind: number; behind_ms: number; longest_behind_ms: number; behind_now: boolean;
  };
  disk: Forecast & { bytes: Record<string, number> };
  health: {
    starts: number;
    dead_jobs: Record<string, number>;
    dead_deliveries: Record<string, number>;
    unread_deliveries: Record<string, number>;
    failed_deliveries: Record<string, number>;
    set_aside_units: Record<string, number>;
    set_aside_extracts: Record<string, number>;
    set_aside_days: number;
    pauses: { target: string; since_ms: number }[];
  };
  sweep: { at_ms: number; seconds: number | null; removed: Record<string, number> } | null;
  columns: Record<string, Record<string, string[]>> | null;
  columns_error?: string;
  phones: {
    units: Record<string, PhoneReport>;
    days: Record<string, { import_runs: number; render_runs: number; door_starts_ms: number[] }>;
  };
}

export interface PhoneReport {
  latency: { moving_fixes: Latency; visits: Latency; geofence_exits: Latency; moves: Latency };
  import_seconds: Spread | null;
  newest_fix: { moving_minutes: number; quiet: number | null; without: number; age_seconds: Spread | null };
  quiet_minutes: Record<string, number> | null;
  sends: Record<string, Sends> | null;
}

export interface Latency {
  entries: number;
  seconds: Spread | null;
  under: Record<string, number> | null;
}

export type Sends = Record<`${keyof typeof SENDS}${"" | "_battery"}`, number>;

interface RunRow {
  id: number;
  kind: string;
  subject: string;
  started_ms: number;
  ended_ms: number | null;
  outcome: string | null;
  counts: string | null;
}

export async function report(folder: HomeFolder, window: Window): Promise<Report> {
  const { root } = folder;
  const { from_ms, to_ms } = window;
  withDb(folder, HOME_STORE, join(root, "home.db"), (db) => homeSchema.open(db, "read"));
  const ledger = ledgerFileOf(root);
  if (existsSync(ledger)) withDb(folder, LEDGER_STORE, ledger, (db) => ledgerSchema.open(db, "read"));
  const settings = effective(folder).settings;
  const day = settings.day;
  let registry: Registry | undefined;
  let columns_error: string | undefined;
  try {
    registry = await loadRegistry(homeRegistryModule().href, settings, homeOf(folder));
  } catch (error) {
    columns_error = error instanceof SettingsError ? `${error.message}: registry settings were refused.` : "The release registry could not be loaded.";
  }
  const columns = registry === undefined ? null : await unreadColumns(folder, folder.blobs(join(root, "blobs"), { reading: true }), (source) => readerFor(registry, source));
  const db = folder.store(HOME_STORE, join(root, "home.db"), { mode: "read", mustExist: true, timeout: 5_000 });
  let read: Report;
  try {
    homeSchema.open(db, "read");
    const product = productsOf(db);
    const runs = (kind: string) => db.prepare(`SELECT id, kind, subject, started_ms, ended_ms, outcome, counts FROM runs
      WHERE kind = ? AND started_ms >= ? AND started_ms < ? ORDER BY started_ms`).all(kind, from_ms, to_ms) as RunRow[];
    const events = (kind: string, from: number, to: number) => db.prepare("SELECT at_ms, key, detail FROM events WHERE at_ms >= ? AND at_ms < ? AND kind = ? ORDER BY at_ms, seq")
      .all(from, to, kind) as { at_ms: number; key: string; detail: string | null }[];
    const wal = size(join(root, "home.db-wal"));
    const prior = db.prepare("SELECT at_ms, key, detail FROM events WHERE kind = ? AND at_ms < ? ORDER BY at_ms DESC, seq DESC LIMIT 1")
      .get(LOG_BEHIND, from_ms) as { at_ms: number; key: string; detail: string | null } | undefined;
    read = {
      window: { from_ms, to_ms },
      home: homeSection(folder, db, product),
      ...importSections(db, runs("import"), product, day, to_ms),
      families: familiesSection(runs),
      reads: readsSection(window.door_log ?? DOOR_LOG, from_ms, to_ms),
      log: logSection([...(prior === undefined ? [] : [prior]), ...events(LOG_BEHIND, from_ms, to_ms)], events(LOG_DRAIN, from_ms, to_ms), wal, from_ms, to_ms),
      disk: diskSection(folder, db, searchFileOf(root, window.machine ?? machine().dir), to_ms, photosStart(settings, registry?.connectors ?? [], to_ms)),
      health: healthSection(db, events, product, from_ms, to_ms),
      sweep: sweepSection(db, to_ms),
      columns,
      ...(columns_error === undefined ? {} : { columns_error }),
      phones: phonesSection(folder, db, runs, window.door_log ?? DOOR_LOG, from_ms, to_ms, day),
    };
  } finally {
    db.close();
  }
  return await hidden(read as unknown as Json, readNameTable(folder, peopleFileOf(root, window.machine ?? machine().dir)) ?? NO_NAMES, settings.privacy) as unknown as Report;
}

const NO_NAMES: NameTable = { version: "none", owner: null, people: [] };

async function hidden(value: Json, people: NameTable, privacy: PrivacySettings): Promise<Json> {
  const hider = openHider({
    people: () => people,
    settings: () => ({ ...privacy, detector: "off" }),
    detector: { find: () => Promise.reject(new Error("a report asks no detector")), state: () => ({ state: "absent", why: "a report asks no detector" }) },
    pictures: { read: async () => ({ cannot: "a report holds no picture" }), make: async () => ({ cannot: "a report holds no picture" }) },
    marks: { id: "", epoch: "", read: () => new Map(), write: () => false, dropOthers: async () => 0, forget: () => 0, close: () => undefined },
  });
  const strings: string[] = [];
  const walk = (each: Json): void => {
    if (typeof each === "string") strings.push(each);
    else if (Array.isArray(each)) each.forEach(walk);
    else if (each !== null && typeof each === "object") for (const [key, member] of Object.entries(each)) {
      strings.push(key);
      walk(member);
    }
  };
  walk(value);
  const answer = await hider.hide(strings.map((text) => [{ text, free: true }]), "all", emptyTable("report"));
  if (!("texts" in answer)) throw new Error(`the report could not be hidden: ${answer.wait}`);
  let at = 0;
  const next = (): string => {
    const text = answer.texts[at++];
    if (typeof text !== "string") throw new Error("the report could not be hidden: a text of it could not be read");
    return text;
  };
  const rebuild = (each: Json): Json => {
    if (typeof each === "string") return next();
    if (Array.isArray(each)) return each.map(rebuild);
    if (each !== null && typeof each === "object") {
      const out: Record<string, Json> = {};
      for (const member of Object.values(each)) {
        const key = next();
        let unique = key;
        for (let n = 2; Object.hasOwn(out, unique); n++) unique = `${key} (${n})`;
        out[unique] = rebuild(member as Json);
      }
      return out;
    }
    return each;
  };
  return rebuild(value);
}


function homeSection(folder: HomeFolder, db: Database.Database, product: (source: string) => string): Report["home"] {
  const sources: Record<string, number> = {};
  for (const id of db.prepare("SELECT id FROM sources").pluck().all() as string[]) add(sources, product(id), 1);
  const ledger = ledgerFileOf(folder.root);
  return {
    release: RELEASE,
    sqlite: (db.prepare("SELECT sqlite_version()").pluck().get() as string),
    node: process.versions.node,
    tz: process.versions.tz ?? null,
    databases: { "home.db": layout(db, homeSchema), "replies.db": existsSync(ledger) ? withDb(folder, LEDGER_STORE, ledger, (read) => layout(read, ledgerSchema)) : null },
    statements: (db.prepare("SELECT coalesce(max(seq), 0) FROM statements").pluck().get() as number),
    versions: (db.prepare("SELECT coalesce(max(rowid), 0) FROM versions").pluck().get() as number),
    sources: sorted(sources),
  };
}

function layout(db: Database.Database, schema: Schema): Report["home"]["databases"][string] {
  return {
    version: schema.version(db),
    pages: db.pragma("page_count", { simple: true }) as number,
    page_bytes: db.pragma("page_size", { simple: true }) as number,
    free_pages: db.pragma("freelist_count", { simple: true }) as number,
  };
}


function importSections(db: Database.Database, runs: RunRow[], product: (source: string) => string, day: DaySettings, to_ms: number): Pick<Report, "imports" | "live"> {
  const delivery = db.prepare("SELECT sealed_ms, stated_ms, facts FROM deliveries WHERE id = ? AND source = ?");
  const rendered = db.prepare("SELECT at_ms FROM events WHERE at_ms >= ? AND at_ms < ? AND kind = 'day' AND key = ? ORDER BY at_ms LIMIT 1").pluck();
  const imports = new Map<string, { deliveries: number; failed: number; rows: Record<string, number>; busy_ms: number; waits: number[] }>();
  const live = new Map<string, { imports: number; shown: number; waits: number[] }>();
  for (const run of runs) {
    const space = run.subject.indexOf(" ");
    const source = run.subject.slice(0, space);
    const named = product(source);
    const entry = imports.get(named) ?? { deliveries: 0, failed: 0, rows: {}, busy_ms: 0, waits: [] };
    imports.set(named, entry);
    if (run.outcome !== "ok" || run.ended_ms === null) {
      if (run.outcome !== null) entry.failed++;
      continue;
    }
    entry.deliveries++;
    entry.busy_ms += run.ended_ms - run.started_ms;
    const counts = run.counts === null ? {} : (JSON.parse(run.counts) as Record<string, unknown>);
    for (const name of CASES) if (typeof counts[name] === "number" && counts[name] > 0) add(entry.rows, name, counts[name]);
    const row = delivery.get(run.subject.slice(space + 1), source) as { sealed_ms: number; stated_ms: number; facts: string } | undefined;
    if (row === undefined) continue;
    entry.waits.push((run.ended_ms - row.sealed_ms) / 1000);
    if ((JSON.parse(row.facts) as { history?: unknown }).history === true) continue;
    const shown = live.get(named) ?? { imports: 0, shown: 0, waits: [] };
    live.set(named, shown);
    shown.imports++;
    const at = rendered.get(run.ended_ms, Math.min(to_ms, run.ended_ms + HOUR_MS), civilDay(row.stated_ms, day)) as number | undefined;
    if (at === undefined) continue;
    shown.shown++;
    shown.waits.push((at - run.ended_ms) / 1000);
  }
  return {
    imports: Object.fromEntries([...imports].sort(byKey).map(([named, entry]) => {
      const rows = Object.values(entry.rows).reduce((sum, n) => sum + n, 0);
      return [named, {
        deliveries: entry.deliveries, failed: entry.failed, rows: entry.rows, busy_seconds: entry.busy_ms / 1000,
        rows_a_second: rate(rows, entry.busy_ms), seal_to_import_seconds: spread(entry.waits),
      }];
    })),
    live: Object.fromEntries([...live].sort(byKey).map(([named, entry]) => [named, { imports: entry.imports, shown: entry.shown, import_to_render_seconds: spread(entry.waits) }])),
  };
}


function familiesSection(runs: (kind: string) => RunRow[]): Report["families"] {
  const by: Report["families"]["by_family"] = {};
  const totals = (kind: (typeof FAMILY_RUNS)[number]) => {
    const per = new Map<string, { runs: number; busy_ms: number; counts: Record<string, number> }>();
    for (const run of runs(kind)) {
      if (run.ended_ms === null) continue;
      const entry = per.get(run.subject) ?? { runs: 0, busy_ms: 0, counts: {} };
      per.set(run.subject, entry);
      entry.runs++;
      entry.busy_ms += run.ended_ms - run.started_ms;
      for (const [name, value] of Object.entries(run.counts === null ? {} : (JSON.parse(run.counts) as Record<string, unknown>))) {
        if (typeof value === "number") add(entry.counts, name, value);
      }
    }
    return per;
  };
  for (const [family, entry] of totals("extract")) {
    const statements = entry.counts.statements ?? 0, units = entry.counts.units ?? 0;
    (by[family] ??= {}).extract = {
      runs: entry.runs, statements, units, busy_seconds: entry.busy_ms / 1000,
      statements_a_second: rate(statements, entry.busy_ms), ms_a_unit: units === 0 ? null : entry.busy_ms / units,
    };
  }
  for (const [family, entry] of totals("walk")) {
    (by[family] ??= {}).walk = { runs: entry.runs, units: entry.counts.units ?? 0, busy_seconds: entry.busy_ms / 1000 };
  }
  for (const [family, entry] of totals("plan")) {
    const units = entry.counts.units ?? 0;
    (by[family] ??= {}).plan = { runs: entry.runs, units, busy_seconds: entry.busy_ms / 1000, units_a_second: rate(units, entry.busy_ms) };
  }
  const render = [...totals("render").values()][0];
  const search = totals("index").get(RECORD_INDEX.name);
  return {
    by_family: Object.fromEntries(Object.entries(by).sort(byKey)),
    render: { runs: render?.runs ?? 0, days: render?.counts.days ?? 0, busy_seconds: (render?.busy_ms ?? 0) / 1000, days_a_second: rate(render?.counts.days ?? 0, render?.busy_ms ?? 0) },
    search: { runs: search?.runs ?? 0, busy_seconds: (search?.busy_ms ?? 0) / 1000 },
  };
}


function readsSection(path: string, from_ms: number, to_ms: number): Report["reads"] {
  if (!existsSync(path)) return { log: null, routes: {} };
  const routes = new Map<string, { ms: number[]; refusals: Record<string, number> }>();
  for (const line of linesFrom(path, from_ms)) {
    if (line.at_ms >= to_ms) break;
    const { method, path: requested, status, milliseconds, code } = line.entry as { method?: unknown; path?: unknown; status?: unknown; milliseconds?: unknown; code?: unknown };
    if (typeof method !== "string" || typeof requested !== "string" || typeof status !== "number" || typeof milliseconds !== "number") continue;
    const name = `${method} ${route(requested)}`;
    const entry = routes.get(name) ?? { ms: [], refusals: {} };
    routes.set(name, entry);
    entry.ms.push(milliseconds);
    if (status >= 400) add(entry.refusals, typeof code === "string" ? code : String(status), 1);
  }
  return {
    log: "door.log",
    routes: Object.fromEntries([...routes].sort(byKey).map(([name, entry]) => [name, { requests: entry.ms.length, ms: spread(entry.ms, true)!, refusals: entry.refusals }])),
  };
}

function route(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  if (parts[0] !== "v1" || parts.length < 2) return "other";
  return `/v1/${parts[1]}${parts.length > 2 ? "/*" : ""}`;
}

function* linesFrom(path: string, from_ms: number): Generator<{ at_ms: number; entry: Record<string, unknown> }> {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    let low = 0, high = size;
    while (high - low > 64 * 1024) {
      const middle = Math.floor((low + high) / 2);
      const line = lineAfter(fd, middle, size);
      if (line === null || line.at_ms >= from_ms) high = middle;
      else low = middle;
    }
    let at = low;
    let carry = "";
    const chunk = Buffer.alloc(1024 * 1024);
    let first = low > 0;
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, at);
      if (read === 0) break;
      at += read;
      const lines = (carry + chunk.toString("utf8", 0, read)).split("\n");
      carry = lines.pop()!;
      for (const text of lines) {
        if (first) { first = false; continue; }
        const parsed = parseLine(text);
        if (parsed !== null && parsed.at_ms >= from_ms) yield parsed;
      }
    }
  } finally {
    closeSync(fd);
  }
}

function lineAfter(fd: number, offset: number, size: number): { at_ms: number } | null {
  const chunk = Buffer.alloc(64 * 1024);
  let at = offset;
  let text = "";
  while (at < size) {
    const read = readSync(fd, chunk, 0, chunk.length, at);
    at += read;
    text += chunk.toString("utf8", 0, read);
    const lines = text.split("\n");
    for (const line of lines.slice(1, -1)) {
      const parsed = parseLine(line);
      if (parsed !== null) return parsed;
    }
    text = `\n${lines.at(-1)!}`;
  }
  return null;
}

function parseLine(text: string): { at_ms: number; entry: Record<string, unknown> } | null {
  if (!text.startsWith("{")) return null;
  try {
    const entry = JSON.parse(text) as Record<string, unknown>;
    const at_ms = typeof entry.at === "string" ? Date.parse(entry.at) : Number.NaN;
    return Number.isFinite(at_ms) ? { at_ms, entry } : null;
  } catch {
    return null;
  }
}


type LogEvent = { at_ms: number; key: string; detail: string | null };

function logSection(behind: LogEvent[], drained: LogEvent[], wal: number, from_ms: number, to_ms: number): Report["log"] {
  const ends: Record<DrainEnd, number> = { emptied: 0, outlasted: 0, outside: 0 };
  let drained_ms = 0, longest_drain_ms = 0;
  for (const event of drained) {
    if (Object.hasOwn(ends, event.key)) ends[event.key as DrainEnd]++;
    const { ms } = event.detail === null ? {} : (JSON.parse(event.detail) as { ms?: unknown });
    if (typeof ms !== "number") continue;
    drained_ms += ms;
    longest_drain_ms = Math.max(longest_drain_ms, ms);
  }
  let largest = wal, count = 0, stood = 0, longest = 0;
  let since: number | null = null;
  for (const event of behind) {
    const detail = event.detail === null ? {} : (JSON.parse(event.detail) as { bytes?: unknown });
    if (typeof detail.bytes === "number") largest = Math.max(largest, detail.bytes);
    if (event.key === "start" && since === null) {
      since = Math.max(from_ms, event.at_ms);
      count++;
    } else if (event.key === "end" && since !== null) {
      stood += event.at_ms - since;
      longest = Math.max(longest, event.at_ms - since);
      since = null;
    }
  }
  if (since !== null) {
    stood += to_ms - since;
    longest = Math.max(longest, to_ms - since);
  }
  return {
    wal_bytes: wal, largest_bytes: largest, drains: drained.length, ...ends, drained_ms, longest_drain_ms,
    behind: count, behind_ms: stood, longest_behind_ms: longest, behind_now: since !== null,
  };
}

function diskSection(folder: HomeFolder, db: Database.Database, search: string, to_ms: number, start_ms: number | null): Report["disk"] {
  const { root } = folder;
  let screen;
  try {
    screen = screenStanding(folder, screenFileOf(search));
  } catch {
    screen = undefined;
  }
  return {
    ...forecast(db, readDisk(root, to_ms), photosComing(db, start_ms).bytes),
    bytes: {
      "home.db": size(join(root, "home.db")),
      "home.db-wal": size(join(root, "home.db-wal")),
      "replies.db": size(join(root, "replies", "replies.db")) + size(join(root, "replies", "replies.db-wal")),
      search: size(search) + size(`${search}-wal`),
      screen: screen?.bytes ?? 0,
      screen_vectors: screen?.vectors_bytes ?? 0,
    },
  };
}


function healthSection(
  db: Database.Database, events: (kind: string, from: number, to: number) => { key: string }[], product: (source: string) => string, from_ms: number, to_ms: number,
): Report["health"] {
  const home = events("home", from_ms, to_ms);
  const byProduct = (sql: string, ...params: string[]) => {
    const counts: Record<string, number> = {};
    for (const source of db.prepare(sql).pluck().all(...params) as string[]) add(counts, product(source), 1);
    return sorted(counts);
  };
  const deadJobs: Record<string, number> = {};
  for (const row of db.prepare("SELECT kind, count(*) AS n FROM jobs WHERE state = 'dead' GROUP BY kind").all() as { kind: string; n: number }[]) deadJobs[row.kind] = row.n;
  const aside: Record<string, number> = {};
  for (const row of db.prepare("SELECT family, count(*) AS n FROM dirty_units WHERE error IS NOT NULL GROUP BY family").all() as { family: string; n: number }[]) aside[row.family] = row.n;
  const extracts: Record<string, number> = {};
  for (const row of db.prepare("SELECT family, count(*) AS n FROM extracts_aside GROUP BY family").all() as { family: string; n: number }[]) extracts[row.family] = row.n;
  return {
    starts: home.filter((event) => event.key === "start").length,
    dead_jobs: sorted(deadJobs),
    dead_deliveries: byProduct("SELECT source FROM deliveries WHERE state = ?", "dead"),
    unread_deliveries: byProduct(`SELECT source FROM deliveries INDEXED BY deliveries_unread WHERE ${UNREAD}`),
    failed_deliveries: byProduct("SELECT source FROM deliveries WHERE state = ?", "failed"),
    set_aside_units: sorted(aside),
    set_aside_extracts: sorted(extracts),
    set_aside_days: db.prepare("SELECT count(*) FROM dirty_days WHERE error IS NOT NULL").pluck().get() as number,
    pauses: (db.prepare("SELECT target, at_ms FROM controls ORDER BY target").all() as { target: string; at_ms: number }[])
      .map((row) => ({ target: /^(home|kind:[a-z-]+)$/u.test(row.target) ? row.target : `${row.target.split(":")[0]}:*`, since_ms: row.at_ms })),
  };
}

function sweepSection(db: Database.Database, to_ms: number): Report["sweep"] {
  const last = db.prepare("SELECT at_ms, key, detail FROM events WHERE at_ms >= ? AND at_ms < ? AND kind = 'sweep' ORDER BY at_ms DESC LIMIT 1")
    .get(to_ms - 2 * DAY_MS, to_ms) as { at_ms: number; key: string; detail: string | null } | undefined;
  if (last === undefined) return null;
  const job = db.prepare("SELECT started_ms, ended_ms FROM jobs WHERE kind = 'sweep' AND key = ?").get(last.key) as { started_ms: number | null; ended_ms: number | null } | undefined;
  const removed: Record<string, number> = {};
  for (const [name, value] of Object.entries(last.detail === null ? {} : (JSON.parse(last.detail) as Record<string, unknown>))) {
    if (typeof value === "number") removed[name] = value;
    else if (Array.isArray(value)) removed[name] = value.length;
  }
  return {
    at_ms: last.at_ms,
    seconds: job?.started_ms == null || job.ended_ms == null ? null : (job.ended_ms - job.started_ms) / 1000,
    removed,
  };
}


const LOOKBACK_MS = DAY_MS;
const MINUTE_MS = 60_000;
const UNDER = [2, 5, 15, 30] as const;
const SENDS = { requests: "requests", bundles: "bundles_sent", files: "files_sent", bytes: "send_bytes", unanswered: "send_unanswered", cut: "send_cut" } as const;

interface Entry {
  kind: string;
  recorded_ms: number;
  sealed_ms: number;
  event: string | null;
  move: boolean | null;
  exit: boolean;
}

function phonesSection(
  folder: HomeFolder, db: Database.Database, runs: (kind: string) => RunRow[], log: string, from_ms: number, to_ms: number, day: DaySettings,
): Report["phones"] {
  const passes = readPrincipals(folder).principals.filter((pass) => pass.kind === "phone");
  const units = [...new Set(passes.filter((pass) => pass.revoked_at === null).map((pass) => pass.unit))].sort();
  const sealedOf = db.prepare("SELECT sealed_ms FROM deliveries WHERE id = ? AND source = ?").pluck();
  const imports = (db.prepare(`SELECT id, kind, subject, started_ms, ended_ms, outcome, counts FROM runs
    WHERE kind = 'import' AND started_ms >= ? AND started_ms < ? ORDER BY started_ms`).all(from_ms - LOOKBACK_MS, to_ms) as RunRow[]).flatMap((run) => {
    const space = run.subject.indexOf(" ");
    const source = run.subject.slice(0, space), id = run.subject.slice(space + 1);
    const sealed_ms = sealedOf.get(id, source) as number | undefined;
    return sealed_ms === undefined ? [] : [{ run, source, id, sealed_ms }];
  });
  const heard = existsSync(log) ? heardOf(log, from_ms, to_ms) : null;
  const minutes: number[] = [];
  for (let at = Math.ceil(from_ms / MINUTE_MS) * MINUTE_MS; at < to_ms; at += MINUTE_MS) minutes.push(at);
  const hourOf = (ms: number) => render(ms, day.zone, "minute").slice(0, 13);

  const holding = db.prepare(`SELECT s.id FROM sources s WHERE s.account = 'local' AND s.copy = ?
    AND EXISTS (SELECT 1 FROM heads h WHERE h.source = s.id AND h.kind = ?) ORDER BY s.id LIMIT 1`).pluck();
  const unitsReport: Record<string, PhoneReport> = {};
  for (const unit of units) {
    const lane = `phone:${unit}/`;
    const location = holding.get(unit, "fix") as string | undefined;
    const own = imports.filter((each) => each.id.startsWith(lane));
    const entries = locationEntries(db, own.filter((each) => each.source === location));
    const moving = movingAt(entries);
    const recorded = entries.filter((entry) => entry.recorded_ms >= from_ms && entry.recorded_ms < to_ms);
    const ids = passes.filter((pass) => pass.unit === unit).map((pass) => pass.id);
    const quiet = heard === null ? null : new Set(minutes.filter((at) => !ids.some((id) => heard.minutes.get(id)?.has(at))));
    const quietByHour: Record<string, number> = {};
    for (const at of quiet ?? []) add(quietByHour, hourOf(at), 1);
    unitsReport[unit] = {
      latency: {
        moving_fixes: latency(recorded.filter((entry) => entry.kind === "fix" && moving(entry.recorded_ms))),
        visits: latency(recorded.filter((entry) => entry.event === "visit")),
        geofence_exits: latency(recorded.filter((entry) => entry.exit)),
        moves: latency(recorded.filter(entries.some((entry) => entry.event === "moving" || entry.event === "settled")
          ? (entry) => entry.event === "moving" || entry.event === "settled" : (entry) => entry.move !== null)),
      },
      import_seconds: spread(own.filter(({ run, sealed_ms }) => sealed_ms >= from_ms && sealed_ms < to_ms && run.outcome === "ok" && run.ended_ms !== null)
        .map(({ run, sealed_ms }) => (run.ended_ms! - sealed_ms) / 1000)),
      newest_fix: newestFix(entries.filter((entry) => entry.kind === "fix"), minutes.filter(moving), quiet),
      quiet_minutes: quiet === null ? null : sorted(quietByHour),
      sends: sendsOf(db, holding.get(unit, "energy") as string | undefined, from_ms, to_ms, hourOf),
    };
  }

  const days: Report["phones"]["days"] = {};
  const dayOf = (ms: number) => (days[civilDay(ms, day)] ??= { import_runs: 0, render_runs: 0, door_starts_ms: [] });
  for (const run of runs("import")) dayOf(run.started_ms).import_runs++;
  for (const run of runs("render")) dayOf(run.started_ms).render_runs++;
  for (const at of heard?.starts ?? []) dayOf(at).door_starts_ms.push(at);
  return { units: unitsReport, days: Object.fromEntries(Object.entries(days).sort(byKey)) };
}

function locationEntries(db: Database.Database, delivered: { run: RunRow; source: string; sealed_ms: number }[]): Entry[] {
  const statements = db.prepare(`SELECT s.kind, s.key, v.start_ms, CASE WHEN s.kind = 'recorder' THEN v.text END AS text
    FROM statements s INDEXED BY statements_run JOIN versions v ON v.id = s.version
    WHERE s.run = ? AND s.source = ? AND s.kind IN ('fix', 'recorder') AND v.start_ms IS NOT NULL`);
  const first = new Map<string, Entry>();
  for (const { run, source, sealed_ms } of delivered) {
    for (const row of statements.all(run.id, source) as { kind: string; key: string; start_ms: number; text: string | Buffer | null }[]) {
      const named = `${row.kind} ${row.key}`;
      const known = first.get(named);
      if (known !== undefined && known.sealed_ms <= sealed_ms) continue;
      const payload = row.text === null ? undefined : (JSON.parse(textOf(row.text)) as { content?: { content?: { payload?: { event?: unknown; detail?: Record<string, unknown> } } } })
        .content?.content?.payload;
      const event = typeof payload?.event === "string" ? payload.event : null;
      const detail = payload?.detail ?? {};
      first.set(named, { kind: row.kind, recorded_ms: row.start_ms, sealed_ms, event, move: event === null ? null : movement(event, detail), exit: exits(event, detail) });
    }
  }
  return [...first.values()].sort((a, b) => a.recorded_ms - b.recorded_ms);
}

function movement(event: string, detail: Record<string, unknown>): boolean | null {
  if (event === "moving" || event === "settled") return event === "moving";
  if (event !== "coverage_transition") return null;
  return detail.to === "high_rate_expected" ? true : detail.to === "stationary_auto_paused" ? false : null;
}

function exits(event: string | null, detail: Record<string, unknown>): boolean {
  return event === "catch_geofence_event" && typeof detail.state === "string" && detail.state.includes("unsatisfied");
}

function movingAt(entries: Entry[]): (ms: number) => boolean {
  const own = entries.filter((entry) => entry.event === "moving" || entry.event === "settled");
  const moves = own.length > 0 ? own : entries.filter((entry) => entry.move !== null);
  return (ms) => {
    let low = 0, high = moves.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (moves[middle]!.recorded_ms <= ms) low = middle + 1;
      else high = middle;
    }
    return low > 0 && moves[low - 1]!.move === true;
  };
}

function latency(entries: Entry[]): Latency {
  const seconds = entries.map((entry) => (entry.sealed_ms - entry.recorded_ms) / 1000);
  return {
    entries: entries.length,
    seconds: spread(seconds),
    under: seconds.length === 0 ? null : Object.fromEntries(UNDER.map((minutes) => [`${minutes}m`, seconds.filter((each) => each < minutes * 60).length / seconds.length])),
  };
}

function newestFix(fixes: Entry[], moving: number[], quiet: Set<number> | null): PhoneReport["newest_fix"] {
  const bySeal = [...fixes].sort((a, b) => a.sealed_ms - b.sealed_ms);
  const ages: number[] = [];
  let newest = -Infinity, next = 0, without = 0, quieted = 0;
  for (const at of moving) {
    for (; next < bySeal.length && bySeal[next]!.sealed_ms <= at; next++) newest = Math.max(newest, bySeal[next]!.recorded_ms);
    if (quiet?.has(at) === true) quieted++;
    else if (newest === -Infinity) without++;
    else ages.push((at - newest) / 1000);
  }
  return { moving_minutes: moving.length, quiet: quiet === null ? null : quieted, without, age_seconds: spread(ages) };
}

function sendsOf(db: Database.Database, source: string | undefined, from_ms: number, to_ms: number, hourOf: (ms: number) => string): Record<string, Sends> | null {
  if (source === undefined) return null;
  const windows = db.prepare(`SELECT h.start_ms, v.text FROM heads h INDEXED BY heads_time JOIN versions v ON v.id = h.version
    WHERE h.source = ? AND h.kind = 'energy' AND h.start_ms >= ? AND h.start_ms < ? AND h.version <> 'gone'`).all(source, from_ms, to_ms) as { start_ms: number; text: string | Buffer }[];
  const hours: Record<string, Sends> = {};
  let stated = false;
  for (const window of windows) {
    const content = (JSON.parse(textOf(window.text)) as { content?: { type?: unknown; content?: { payload?: { counts?: Record<string, unknown> } } } }).content;
    if (content?.type !== "energy.parts") continue;
    const counts = content.content?.payload?.counts ?? {};
    const count = (name: string) => (typeof counts[name] === "number" ? counts[name] : 0);
    for (const [field, name] of Object.entries(SENDS) as [keyof typeof SENDS, string][]) {
      if (counts[`${name}_battery`] === undefined && counts[`${name}_power`] === undefined) continue;
      stated = true;
      const hour = (hours[hourOf(window.start_ms)] ??= Object.fromEntries(Object.keys(SENDS).flatMap((each) => [[each, 0], [`${each}_battery`, 0]])) as Sends);
      hour[field] += count(`${name}_battery`) + count(`${name}_power`);
      hour[`${field}_battery`] += count(`${name}_battery`);
    }
  }
  return stated ? Object.fromEntries(Object.entries(hours).sort(byKey)) : null;
}

function sending(method: string, path: string): boolean {
  return (method === "POST" && path === "/v1/exchange") || (method === "PUT" && (path.startsWith("/v1/bundles/") || path.startsWith("/v1/files/")));
}

function heardOf(path: string, from_ms: number, to_ms: number): { minutes: Map<string, Set<number>>; starts: number[] } {
  const minutes = new Map<string, Set<number>>();
  const starts: number[] = [];
  for (const { at_ms, entry } of linesFrom(path, from_ms)) {
    if (at_ms >= to_ms) break;
    if (entry.door === "open") starts.push(at_ms);
    if (typeof entry.principal !== "string" || typeof entry.method !== "string" || typeof entry.path !== "string" || !sending(entry.method, entry.path)) continue;
    let heard = minutes.get(entry.principal);
    if (heard === undefined) minutes.set(entry.principal, heard = new Set());
    heard.add(Math.floor(at_ms / MINUTE_MS) * MINUTE_MS);
  }
  return { minutes, starts };
}

function textOf(stored: string | Buffer): string {
  return typeof stored === "string" ? stored : zstdDecompressSync(stored).toString("utf8");
}


function productsOf(db: Database.Database): (source: string) => string {
  const products = new Map((db.prepare("SELECT id, product FROM sources").all() as { id: string; product: string }[]).map((row) => [row.id, row.product]));
  return (source) => products.get(source) ?? source.split(":")[0]!;
}

export function withDb<T>(folder: HomeFolder, kind: StoreKind, path: string, read: (db: Database.Database) => T): T {
  const db = folder.store(kind, path, { mode: "read", mustExist: true, timeout: 5_000 });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

export function size(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function spread(values: number[], p99 = false): Spread | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const at = (share: number) => ordered[Math.min(ordered.length - 1, Math.ceil(share * ordered.length) - 1)]!;
  return { p50: at(0.5), p90: at(0.9), ...(p99 ? { p99: at(0.99) } : {}), max: ordered.at(-1)! };
}

function rate(count: number, ms: number): number | null {
  return ms <= 0 ? null : count / (ms / 1000);
}

function add(counts: Record<string, number>, name: string, n: number): void {
  counts[name] = (counts[name] ?? 0) + n;
}

function sorted(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort(byKey));
}

function byKey<T>(a: [string, T], b: [string, T]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

const SQLITE_HEADER = "SQLite format 3\0";
const NEWEST = 5;
const LARGEST_BYTES = 1 << 30;

export async function unreadColumns(
  folder: HomeFolder, blobs: BlobStore, connector: (source: { connector: string; options: JsonObject }) => Reader | undefined,
): Promise<Record<string, Record<string, string[]>>> {
  const found: Record<string, Record<string, string[]>> = {};
  const sources = withDb(folder, HOME_STORE, join(folder.root, "home.db"), (db) => (db.prepare("SELECT id, product, connector, options FROM sources ORDER BY id").all() as
    { id: string; product: string; connector: string; options: string }[]).flatMap((source) => {
    let known: Reader["columns"];
    try {
      known = connector({ connector: source.connector, options: JSON.parse(source.options) as JsonObject })?.columns;
    } catch {
      return [];
    }
    if (known === undefined) return [];
    const ids = db.prepare("SELECT id FROM deliveries WHERE source = ? ORDER BY sealed_ms DESC LIMIT ?").pluck().all(source.id, NEWEST) as string[];
    return [{ ...source, known, deliveries: ids.map((id) => ({ lane: id.slice(0, id.lastIndexOf("/")), name: id.slice(id.lastIndexOf("/") + 1) })) }];
  }));
  for (const source of sources) {
    for (const { lane, name } of source.deliveries) {
      const files = readDelivery(folder, lane, name)?.files ?? [];
      let read = false;
      for (const file of files) {
        try {
          read = (await readColumns(folder, lane, name, file, blobs, source.known, (table, unread) => {
            const product = (found[source.product] ??= {});
            product[table] = [...new Set([...(product[table] ?? []), ...unread])].sort();
          })) || read;
        } catch {
        }
      }
      if (read) break;
    }
  }
  return found;
}

async function readColumns(
  folder: HomeFolder, lane: string, name: string, file: { path: string; blob: string; size: number }, blobs: BlobStore,
  known: Readonly<Record<string, readonly string[]>>, unread: (table: string, columns: string[]) => void,
): Promise<boolean> {
  if (file.size > LARGEST_BYTES) return false;
  const kept = blobs.has(file.blob) ? null : [deliveredFile(folder, deliveryDirectory(folder, lane, name), file.path), inboxLane(folder, lane).blob(file.blob)].find((each) => each.exists());
  if (kept === undefined) return false;
  const prefix = kept === null ? blobs.prefix(file.blob, SQLITE_HEADER.length) : prefixOf(kept, SQLITE_HEADER.length);
  if (prefix.toString("latin1") !== SQLITE_HEADER) return false;
  const held = kept === null ? await blobs.materialise(file.blob) : kept.materialise();
  try {
    const db = openSqlite(held.path);
    try {
      for (const [table, columns] of Object.entries(known)) {
        const extra = db.columns(table).filter((column) => !columns.includes(column));
        if (extra.length > 0) unread(table, extra);
      }
    } finally {
      db.close();
    }
    return true;
  } finally {
    held.dispose();
  }
}
