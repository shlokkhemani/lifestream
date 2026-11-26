import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type Database from "better-sqlite3";
import { civilDay, dayBounds, isSqliteError, type DaySettings, type HomeFolder, type StoreKind } from "@lifestreamprotocol/core";
import { documentLike, keyOf, plainLine, proseChars } from "./screen-keys.js";
import type { Against, Unmarked } from "./search-index.js";
import type { MeaningModel } from "./search-route.js";
import { failpoint } from "./failpoint.js";
import { changeVectorModel, compactVectors, createVectorTables, landVectors, purgeVectors, sweepVectorFiles, type VectorAsked, type VectorReply } from "./screen-vectors.js";

export interface ScreenFrame {
  t: number;
  app: string;
  title: string | null;
  site: string | null;
  display?: string;
  lines: readonly string[];
  ocr?: readonly string[];
}

export interface ScreenSegment {
  machine: string;
  version: string;
  start_ms: number;
  end_ms?: number;
  frames: readonly ScreenFrame[];
}

export interface ScreenSource {
  segments(machine: string, day: string): Iterable<ScreenSegment>;
}

export interface ScreenOptions {
  days: DaySettings;
  meaning: false | string;
  settings?: string;
}

export function meaningSettingsOf(chosen: MeaningModel | null): string {
  return JSON.stringify(chosen === null ? ["off"] : [chosen.unit, chosen.file, chosen.power]);
}

export interface Applied {
  appended: number;
  rebuilt: string[];
  held: number;
}

const FORMAT = "screen-4";
const RETIRED = "retired";
export const SEGMENT_MS = 300_000;
export const FRAME_CAP_MS = 10_000;
const UNCHANGED_MS = 300_000;
export const BLOCK_MIN_CHARS = 60;
export const BLOCK_MIN_WORDS = 8;
export const BLOCK_GAP_MS = 10_000;
export const CHUNK_BYTES = 6_000;
const AX_BIT = 0x8000;
const ZSTD_LEVEL = 9;
const BUSY_MS = 5_000;
const OPEN_TRIES = 3;
const MARK_WAIT_MS = 100;

const WORDS = `
CREATE TABLE meta(name TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE screen_key(id INTEGER PRIMARY KEY, machine TEXT NOT NULL, app TEXT NOT NULL, site TEXT NOT NULL, name TEXT NOT NULL, UNIQUE(machine, app, site, name));
CREATE TABLE screen_segment(id INTEGER PRIMARY KEY, machine TEXT NOT NULL, day TEXT NOT NULL, version TEXT NOT NULL, start_ms INTEGER NOT NULL, UNIQUE(machine, start_ms));
CREATE INDEX screen_segment_day ON screen_segment(machine, day, start_ms);
CREATE TABLE screen_row(slot INTEGER PRIMARY KEY, key INTEGER NOT NULL, day TEXT NOT NULL, end_ms INTEGER NOT NULL, seg_ms INTEGER NOT NULL, tenths INTEGER NOT NULL, prose INTEGER NOT NULL, segment INTEGER NOT NULL);
CREATE INDEX screen_row_segment ON screen_row(segment);
CREATE INDEX screen_row_key ON screen_row(key, day);
CREATE TABLE screen_text(slot INTEGER PRIMARY KEY, times BLOB NOT NULL, body BLOB NOT NULL);
CREATE TABLE screen_span(slot INTEGER NOT NULL, display TEXT NOT NULL, from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL);
CREATE INDEX screen_span_slot ON screen_span(slot);
CREATE VIRTUAL TABLE screen_fts USING fts5(title, body, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE screen_vocab USING fts5vocab(screen_fts, 'row');
CREATE TABLE screen_block(id INTEGER PRIMARY KEY, machine TEXT NOT NULL, day TEXT NOT NULL, hash TEXT NOT NULL, key INTEGER NOT NULL, UNIQUE(machine, day, hash));
CREATE VIRTUAL TABLE screen_block_fts USING fts5(body, tokenize='unicode61 remove_diacritics 2');
CREATE TABLE screen_block_run(block INTEGER NOT NULL, display TEXT NOT NULL, from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL);
CREATE INDEX screen_block_run_block ON screen_block_run(block, display, to_ms);
CREATE TABLE screen_tail(machine TEXT NOT NULL, day TEXT NOT NULL, frame TEXT NOT NULL, since_ms INTEGER NOT NULL, PRIMARY KEY(machine, day)) WITHOUT ROWID;
CREATE TABLE unmarked(n INTEGER PRIMARY KEY AUTOINCREMENT, slot INTEGER NOT NULL UNIQUE) STRICT;
`;

const MEANING = `
CREATE TABLE screen_unit(unit INTEGER PRIMARY KEY, kind TEXT NOT NULL, key INTEGER NOT NULL, day TEXT NOT NULL, text_hash TEXT NOT NULL, runs TEXT, members TEXT, vmonth TEXT, vrow INTEGER);
CREATE INDEX screen_unit_hash ON screen_unit(text_hash);
CREATE INDEX screen_unit_day ON screen_unit(day, key, vmonth, vrow);
CREATE TABLE screen_embed_queue(text_hash TEXT PRIMARY KEY, day TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX screen_embed_queue_day ON screen_embed_queue(day);
CREATE TABLE screen_embed_skipped(text_hash TEXT PRIMARY KEY) WITHOUT ROWID;
`;

export const SCREEN_STORE: StoreKind = { role: "screen", remade: true };

export function screenFileOf(searchFile: string): string {
  return join(dirname(searchFile), "screen.db");
}

function vectorsRootOf(file: string): string {
  return join(dirname(file), "screen-vectors");
}

export function vectorsDirOf(file: string, generation: string): string {
  return join(vectorsRootOf(file), generation);
}

export interface ScreenStanding {
  position: unknown;
  indexed_through: number | null;
  bytes: number;
  vectors_bytes: number;
}

export function screenStanding(folder: HomeFolder, file: string): ScreenStanding | undefined {
  const db = readScreen(folder, file);
  if (db === undefined) return undefined;
  try {
    return standingOf(db, file);
  } finally {
    db.close();
  }
}

export function standingOf(db: Database.Database, file: string): ScreenStanding {
  return { position: screenPositionOf(db), indexed_through: wordsThrough(db), ...screenBytes(file) };
}

export function screenPositionOf(db: Database.Database): { seq: number } | null {
  return JSON.parse(metaOf(db, "position") ?? "null") as { seq: number } | null;
}

export function screenProgress(folder: HomeFolder, file: string, waitMs?: number): { read: number } | undefined {
  const db = readScreen(folder, buildingFile(file), waitMs);
  if (db === undefined) return undefined;
  try {
    return { read: screenPositionOf(db)?.seq ?? 0 };
  } finally {
    db.close();
  }
}

export function screenBytes(file: string): { bytes: number; vectors_bytes: number } {
  return { bytes: fileBytes(file) + fileBytes(`${file}-wal`), vectors_bytes: treeBytes(vectorsRootOf(file)) };
}

export function wordsThrough(db: Database.Database): number | null {
  return db.prepare("SELECT max(end_ms) FROM screen_row WHERE segment = (SELECT segment FROM screen_row ORDER BY slot DESC LIMIT 1)").pluck().get() as number | null;
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function treeBytes(folder: string): number {
  let entries;
  try {
    entries = readdirSync(folder, { withFileTypes: true, recursive: true });
  } catch {
    return 0;
  }
  return entries.reduce((sum, entry) => sum + (entry.isFile() ? fileBytes(join(entry.parentPath, entry.name)) : 0), 0);
}

function buildingFile(file: string): string {
  return join(dirname(file), "screen.building.db");
}

export function unpackText(times: Buffer, body: Buffer): { line: string; tenths: number; ax: boolean }[] {
  const lines = zstdDecompressSync(body).toString("utf8").split("\n");
  return lines.map((line, i) => {
    const time = times.readUInt16LE(i * 2);
    return { line, tenths: time & ~AX_BIT, ax: (time & AX_BIT) !== 0 };
  });
}

export function blockEvidence(machine: string, day: string, id: number): string {
  return `block:${machine}/${day}/${id}`;
}

export interface EmbedWaits {
  readonly waits: "downloading" | "battery" | "in_use" | "warm" | "no_runner" | "busy" | "failing";
  readonly line: string;
}

export function waitsOf(db: Database.Database): EmbedWaits | null {
  const value = metaOf(db, "embed_waits");
  return value === undefined ? null : JSON.parse(value) as EmbedWaits;
}

export function meaningCounts(db: Database.Database): { embedded: number; queued: number; named: number; skipped: number } {
  const embedded = db.prepare("SELECT coalesce(sum(named), 0) FROM screen_vector_file").pluck().get() as number;
  const queued = db.prepare("SELECT count(*) FROM screen_embed_queue").pluck().get() as number;
  const skipped = db.prepare("SELECT count(*) FROM screen_embed_skipped").pluck().get() as number;
  return { embedded, queued, named: embedded + queued + skipped, skipped };
}

export function chunkLines(db: Database.Database, members: string): { slot: number; lines: string[] }[] {
  const text = db.prepare<[number], { times: Buffer; body: Buffer }>("SELECT times, body FROM screen_text WHERE slot = ?");
  return (JSON.parse(members) as [number, number, number][]).map(([slot, first, last]) => {
    const row = text.get(slot);
    const lines = row === undefined ? [] : unpackText(row.times, row.body).slice(first, last + 1).filter((each) => each.ax).map((each) => each.line);
    return { slot, lines };
  });
}

export function meaningWalk(db: Database.Database): string | null {
  return metaOf(db, "meaning_walk") ?? null;
}

export function readScreen(folder: HomeFolder, file: string, waitMs = BUSY_MS): Database.Database | undefined {
  for (let tries = 0; tries < OPEN_TRIES; tries++) {
    let db: Database.Database;
    try {
      db = folder.store(SCREEN_STORE, file, { mode: "read", mustExist: true, timeout: waitMs });
    } catch (error) {
      if (absent(error)) return undefined;
      throw error;
    }
    let format: string | undefined;
    try {
      format = metaOf(db, "format");
    } catch (error) {
      db.close();
      throw error;
    }
    if (format === FORMAT) return db;
    db.close();
    if (format !== RETIRED) return undefined;
  }
  return undefined;
}

function absent(error: unknown): boolean {
  if (isSqliteError(error) && (error.code === "SQLITE_CANTOPEN" || error.code === "SQLITE_NOTADB")) return true;
  return error instanceof TypeError && error.message.includes("directory does not exist");
}

function inodeOf(path: string): number | undefined {
  try {
    return statSync(path).ino;
  } catch {
    return undefined;
  }
}

function openWriter(folder: HomeFolder, path: string, waitMs: number): Database.Database | undefined {
  for (let tries = 0; tries < OPEN_TRIES; tries++) {
    const before = inodeOf(path);
    if (before === undefined) return undefined;
    let db: Database.Database;
    let format: string | undefined;
    try {
      db = folder.store(SCREEN_STORE, path, { mustExist: true, timeout: waitMs, keepJournal: true });
    } catch (error) {
      if (absent(error)) return undefined;
      throw error;
    }
    try {
      format = db.transaction(() => (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'meta'").get() === undefined ? undefined : metaOf(db, "format")))();
    } catch (error) {
      db.close();
      if (absent(error)) return undefined;
      throw error;
    }
    if (format === RETIRED || inodeOf(path) !== before) {
      db.close();
      continue;
    }
    try {
      db.pragma("journal_mode = WAL");
    } catch (error) {
      db.close();
      if (absent(error)) return undefined;
      throw error;
    }
    return db;
  }
  return undefined;
}

function outOfLog(db: Database.Database, path: string, retire: boolean): void {
  db.pragma("locking_mode = EXCLUSIVE");
  const until = Date.now() + BUSY_MS;
  for (;;) {
    try {
      if (db.pragma("journal_mode = MEMORY", { simple: true }) === "memory") break;
    } catch (error) {
      if (!(isSqliteError(error) && error.code === "SQLITE_BUSY") || Date.now() > until) throw error;
    }
    if (Date.now() > until) throw new Error(`${path} stayed in its log: another connection holds it`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  if (retire) db.exec(`CREATE TABLE IF NOT EXISTS meta(name TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID; INSERT OR REPLACE INTO meta(name, value) VALUES ('format', '${RETIRED}')`);
  else db.exec("UPDATE meta SET value = value WHERE name = 'format'");
  for (const suffix of ["-wal", "-shm", "-journal"]) rmSync(`${path}${suffix}`, { force: true });
}

function flushFolder(folder: string): void {
  const directory = openSync(folder, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function metaOf(db: Database.Database, name: string): string | undefined {
  try {
    return (db.prepare("SELECT value FROM meta WHERE name = ?").get(name) as { value: string } | undefined)?.value;
  } catch (error) {
    if (busy(error)) throw error;
    return undefined;
  }
}

export function busy(error: unknown): boolean {
  return isSqliteError(error) && error.code.startsWith("SQLITE_BUSY");
}

export function machineDays(machine: string, from_ms: number, to_ms: number, days: DaySettings): { machine: string; day: string }[] {
  const out: { machine: string; day: string }[] = [];
  let day = civilDay(from_ms, days);
  const last = civilDay(Math.max(from_ms, to_ms - 1), days);
  for (;;) {
    out.push({ machine, day });
    if (day >= last) return out;
    day = civilDay(dayBounds(day, days).end_ms, days);
  }
}

interface RowBuild {
  key: number;
  identity: string;
  start: number;
  end: number;
  ms: number;
  titles: Set<string>;
  name: string;
  app: string;
  firstTitle: string | null;
  lines: string[];
  ax: boolean[];
  times: number[];
  spans: { display: string; from: number; to: number }[];
  local: Set<string>;
}

interface OpenChunk {
  unit: number;
  text: string;
  members: [number, number, number][];
}

const WALK_DAYS = 7;

export class ScreenIndex {
  readonly #statements = new Map<string, Database.Statement>();
  readonly #seen = new Map<string, Set<number>>();
  readonly #chunks = new Map<string, OpenChunk | null>();
  #erasing = false;
  #settings: string | undefined;
  #meaning: boolean;
  readonly #days: DaySettings;

  private constructor(
    private readonly folder: HomeFolder,
    private readonly db: Database.Database,
    private readonly path: string,
    private readonly whole?: string,
  ) {
    this.#meaning = metaOf(db, "meaning") === "true";
    this.#days = JSON.parse(metaOf(db, "days") ?? "null") as DaySettings;
  }

  static write(folder: HomeFolder, file: string, options: ScreenOptions, fits: (position: unknown, building: boolean) => boolean): ScreenIndex {
    mkdirSync(dirname(file), { recursive: true });
    const building = buildingFile(file);
    for (const [path, whole] of [[file, undefined], [building, file]] as const) ScreenIndex.#finishPurge(folder, path, whole);
    const resumed = ScreenIndex.#fitting(folder, building, options, fits, file);
    if (resumed !== undefined) {
      resumed.#settings = options.settings;
      if (options.meaning === false) ScreenIndex.#withoutMeaning(folder, file);
      resumed.#meaningAs(options.meaning);
      sweepGenerations(file, [...resumed.#kept(), ...(meaningGeneration(folder, file) ?? [])]);
      return resumed;
    }
    const whole = ScreenIndex.#fitting(folder, file, options, fits);
    removeFile(building);
    if (whole !== undefined) {
      whole.#settings = options.settings;
      whole.#meaningAs(options.meaning);
      sweepGenerations(file, whole.#kept());
      return whole;
    }
    const db = folder.store(SCREEN_STORE, building, { timeout: BUSY_MS });
    db.exec(WORDS);
    const set = db.prepare("INSERT INTO meta(name, value) VALUES (?, ?)");
    const generation = randomUUID();
    db.transaction(() => {
      set.run("format", FORMAT);
      set.run("generation", generation);
      set.run("meaning", "false");
      set.run("days", JSON.stringify({ zone: options.days.zone, day_start_hour: options.days.day_start_hour }));
      set.run("position", "null");
      set.run("texts", "0");
    })();
    const index = new ScreenIndex(folder, db, building, file);
    index.#settings = options.settings;
    index.#meaningAs(options.meaning);
    if (options.meaning === false) ScreenIndex.#withoutMeaning(folder, file);
    sweepGenerations(file, [...index.#kept(), ...(meaningGeneration(folder, file) ?? [])]);
    return index;
  }

  static #finishPurge(folder: HomeFolder, path: string, whole?: string): void {
    const index = ScreenIndex.#open(folder, path, whole);
    if (index === undefined) return;
    try {
      if (metaOf(index.db, "purge_pending") !== undefined) index.#purge();
    } finally {
      index.close();
    }
  }

  #purge(): void {
    const model = this.vectorModel();
    if (model !== null) purgeVectors(this.db, this.folder, this.vectors, model);
    this.#run("DELETE FROM meta WHERE name = 'purge_pending'");
  }

  #owePurge(): void {
    if (this.#get("SELECT 1 FROM screen_vector_file WHERE rows > named LIMIT 1") !== undefined) this.#run("INSERT OR REPLACE INTO meta(name, value) VALUES ('purge_pending', 'true')");
  }

  static #fitting(folder: HomeFolder, path: string, options: ScreenOptions, fits: (position: unknown, building: boolean) => boolean, whole?: string): ScreenIndex | undefined {
    const index = ScreenIndex.#open(folder, path, whole);
    if (index === undefined) return undefined;
    const days = index.#days;
    if (days.zone === options.days.zone && days.day_start_hour === options.days.day_start_hour && fits(index.position(), whole !== undefined)) return index;
    index.close();
    return undefined;
  }

  #meaningAs(meaning: false | string): void {
    if (meaning === false) {
      if (this.#meaning) this.#dropMeaning();
    } else if (!this.#meaning) this.#addMeaning(meaning);
    else if (this.vectorModel() !== meaning) this.#changeModel(meaning);
  }

  #kept(): string[] {
    return this.#meaning ? [this.generation()] : [];
  }

  static #withoutMeaning(folder: HomeFolder, path: string): void {
    const index = ScreenIndex.#open(folder, path);
    if (index === undefined) return;
    try {
      if (index.#meaning) index.#dropMeaning();
    } finally {
      index.close();
    }
  }

  #addMeaning(model: string): void {
    rmSync(this.vectors, { recursive: true, force: true });
    this.#write(() => {
      this.db.exec(MEANING);
      createVectorTables(this.db);
      this.#run("UPDATE meta SET value = 'true' WHERE name = 'meaning'");
      this.#run("INSERT OR REPLACE INTO meta(name, value) VALUES ('vector_model', ?)", model);
      const newest = this.#get<{ day: string | null }>("SELECT max(day) AS day FROM screen_segment")!.day;
      if (newest !== null) this.#run("INSERT OR REPLACE INTO meta(name, value) VALUES ('meaning_walk', ?)", newest);
    });
    this.#statements.clear();
    this.#meaning = true;
  }

  #changeModel(model: string): void {
    changeVectorModel(this.db, this.vectors, model, () => {
      this.#run("UPDATE screen_unit SET vmonth = NULL, vrow = NULL WHERE vrow IS NOT NULL");
      this.#run("DELETE FROM screen_embed_queue");
      this.#run("DELETE FROM screen_embed_skipped");
      this.#run("DELETE FROM meta WHERE name = 'embed_waits'");
      this.#run("INSERT INTO screen_embed_queue(text_hash, day) SELECT text_hash, max(day) FROM screen_unit GROUP BY text_hash");
    });
  }

  #dropMeaning(): void {
    const vectors = this.vectors;
    this.#write(() => {
      for (const table of ["screen_unit", "screen_embed_queue", "screen_embed_skipped", "screen_vector", "screen_vector_file"]) this.#run(`DROP TABLE IF EXISTS ${table}`);
      this.#run("UPDATE meta SET value = 'false' WHERE name = 'meaning'");
      this.#run("DELETE FROM meta WHERE name IN ('vector_model', 'meaning_walk', 'embed_waits')");
    });
    this.#statements.clear();
    this.#chunks.clear();
    this.#meaning = false;
    rmSync(vectors, { recursive: true, force: true });
  }

  walkMeaning(may: () => boolean = () => true): number {
    let walked = 0;
    while (this.#meaning && walked < WALK_DAYS && may()) {
      const day = metaOf(this.db, "meaning_walk");
      if (day === undefined) break;
      this.#write(() => {
        const machines = this.#all<{ machine: string }>("SELECT DISTINCT machine FROM screen_segment WHERE day = ? ORDER BY machine", day);
        for (const { machine } of machines) this.#meaningOfDay(machine, day);
        const older = this.#get<{ day: string | null }>("SELECT max(day) AS day FROM screen_segment WHERE day < ?", day)!.day;
        if (older === null) this.#run("DELETE FROM meta WHERE name = 'meaning_walk'");
        else this.#run("UPDATE meta SET value = ? WHERE name = 'meaning_walk'", older);
      });
      walked++;
    }
    return walked;
  }

  get walking(): boolean {
    return this.#meaning && metaOf(this.db, "meaning_walk") !== undefined;
  }

  #meaningOfDay(machine: string, day: string): void {
    const keys = "SELECT id FROM screen_key WHERE machine = ?";
    const gone = this.#all<{ text_hash: string }>(`SELECT text_hash FROM screen_unit WHERE day = ? AND key IN (${keys})`, day, machine).map((row) => row.text_hash);
    this.#run(`DELETE FROM screen_unit WHERE day = ? AND key IN (${keys})`, day, machine);
    for (const name of this.#chunks.keys()) if (name.endsWith(`\0${day}`)) this.#chunks.delete(name);
    const rows = this.#all<{ slot: number; key: number; end_ms: number; start: number; times: Buffer; body: Buffer }>(
      `SELECT r.slot, r.key, r.end_ms, (SELECT min(from_ms) FROM screen_span s WHERE s.slot = r.slot) AS start, t.times, t.body
        FROM screen_row r JOIN screen_text t ON t.slot = r.slot WHERE r.day = ? AND r.key IN (${keys}) ORDER BY r.slot`, day, machine,
    );
    for (const row of rows) {
      const lines = unpackText(row.times, row.body).map((each, at) => ({ at, line: each.line, ax: each.ax })).filter((each) => each.ax);
      if (lines.length > 0) this.#chunk(row.key, day, row.slot, row.start, row.end_ms, lines);
    }
    const blocks = this.#all<{ key: number; hash: string }>("SELECT key, hash FROM screen_block WHERE machine = ? AND day = ? ORDER BY id", machine, day);
    for (const block of blocks) this.#unit("block", block.key, day, block.hash, null, null);
    this.#prune(gone);
  }

  static existing(folder: HomeFolder, file: string): ScreenIndex[] {
    return ([[file, undefined], [buildingFile(file), file]] as const).flatMap(([path, whole]) => {
      const index = ScreenIndex.#open(folder, path, whole);
      if (index !== undefined) return [index];
      removeFile(path);
      return [];
    });
  }

  static erase(folder: HomeFolder, file: string, ranges: readonly { machine: string; from_ms: number; to_ms: number }[], source: ScreenSource, forget: (texts: string[]) => void = () => {}, logWaitMs = 0): string[] {
    const indexes = ScreenIndex.existing(folder, file);
    const kept: string[] = [];
    try {
      forget([...new Set(indexes.flatMap((index) => index.textsOf(ranges)))]);
      for (const index of indexes) {
        const touched = new Set<string>();
        for (const range of ranges) {
          for (const { machine, day } of machineDays(range.machine, range.from_ms, range.to_ms, index.#days)) touched.add(`${machine}\0${day}`);
        }
        index.db.pragma("secure_delete = ON");
        try {
          index.#erasing = true;
          for (const both of [...touched].sort()) {
            const [machine, day] = both.split("\0") as [string, string];
            index.rebuild(machine, day, source);
          }
          index.#erasing = false;
          index.#purge();
        } finally {
          index.#erasing = false;
          index.db.pragma("secure_delete = FAST");
        }
      }
      sweepGenerations(file, indexes.flatMap((index) => index.#kept()));
      for (const index of indexes) if (!index.truncateLog(logWaitMs)) kept.push(index.building ? "screen.building.db" : "screen.db");
    } finally {
      for (const index of indexes) index.close();
    }
    return kept;
  }

  truncateLog(wait_ms: number): boolean {
    const before = this.db.pragma("busy_timeout", { simple: true }) as number;
    this.db.pragma(`busy_timeout = ${Math.max(0, Math.floor(wait_ms))}`);
    try {
      const [row] = this.db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
      return row!.busy === 0;
    } finally {
      this.db.pragma(`busy_timeout = ${before}`);
    }
  }

  static marking(folder: HomeFolder, file: string): ScreenIndex | undefined {
    return ScreenIndex.#open(folder, file, undefined, MARK_WAIT_MS);
  }

  static read(folder: HomeFolder, file: string, waitMs?: number): ScreenIndex | undefined {
    const db = readScreen(folder, file, waitMs);
    return db === undefined ? undefined : new ScreenIndex(folder, db, file);
  }

  static #open(folder: HomeFolder, path: string, whole?: string, waitMs = BUSY_MS): ScreenIndex | undefined {
    const db = openWriter(folder, path, waitMs);
    if (db === undefined) return undefined;
    let format: string | undefined;
    try {
      format = metaOf(db, "format");
    } catch (error) {
      db.close();
      throw error;
    }
    if (format === FORMAT) return new ScreenIndex(folder, db, path, whole);
    db.close();
    return undefined;
  }

  get building(): boolean {
    return this.whole !== undefined;
  }

  get meaning(): boolean {
    return this.#meaning;
  }

  vectorModel(): string | null {
    return this.#meaning ? metaOf(this.db, "vector_model") ?? null : null;
  }

  get vectors(): string {
    return vectorsDirOf(this.whole ?? this.path, this.generation());
  }

  queued(limit: number): { textHash: string; text: string }[] {
    if (!this.#meaning) return [];
    return this.db.transaction(() => this.#all<{ text_hash: string; unit: number; kind: "block" | "chunk"; key: number; day: string; members: string | null }>(
      `SELECT q.text_hash, u.unit, u.kind, u.key, u.day, u.members FROM screen_embed_queue q
        JOIN screen_unit u ON u.unit = (SELECT min(unit) FROM screen_unit WHERE text_hash = q.text_hash)
        ORDER BY q.day DESC, q.text_hash LIMIT ?`, limit,
    ).map((row) => ({ textHash: row.text_hash, text: this.#unitText(row) })))();
  }

  #unitText(unit: { kind: "block" | "chunk"; key: number; day: string; text_hash: string; members: string | null }): string {
    if (unit.kind === "chunk") return chunkLines(this.db, unit.members!).flatMap((member) => member.lines).join("\n");
    return this.#get<{ body: string }>(
      "SELECT f.body FROM screen_block b JOIN screen_block_fts f ON f.rowid = b.id WHERE b.machine = (SELECT machine FROM screen_key WHERE id = ?) AND b.day = ? AND b.hash = ?",
      unit.key, unit.day, unit.text_hash,
    )!.body;
  }

  queueLength(): number {
    return this.#meaning ? this.#get<{ n: number }>("SELECT count(*) AS n FROM screen_embed_queue")!.n : 0;
  }

  land(asked: VectorAsked, replies: readonly VectorReply[]): { landed: number; dropped: number } {
    if (!this.#meaning) return { landed: 0, dropped: replies.length };
    return landVectors(this.db, this.folder, this.vectors, asked, replies, this.#settings);
  }

  static stateMeaning(folder: HomeFolder, file: string, settings: string, waitMs: number): boolean {
    let took = true;
    for (const [path, whole] of [[file, undefined], [buildingFile(file), file]] as const) {
      const index = ScreenIndex.#open(folder, path, whole, waitMs);
      if (index === undefined) continue;
      try {
        if (metaOf(index.db, "meaning_settings") !== settings) index.#run("INSERT OR REPLACE INTO meta(name, value) VALUES ('meaning_settings', ?)", settings);
      } catch (error) {
        if (!(isSqliteError(error) && error.code === "SQLITE_BUSY")) throw error;
        took = false;
      } finally {
        index.close();
      }
    }
    return took;
  }

  skip(textHashes: readonly string[]): void {
    if (!this.#meaning || textHashes.length === 0) return;
    this.#write(() => {
      for (const hash of textHashes) {
        this.#run("DELETE FROM screen_embed_queue WHERE text_hash = ?", hash);
        this.#run("INSERT OR IGNORE INTO screen_embed_skipped(text_hash) VALUES (?)", hash);
      }
    });
  }

  setWaits(waits: EmbedWaits | null): void {
    if (!this.#meaning) return;
    const value = waits === null ? undefined : JSON.stringify(waits);
    if (metaOf(this.db, "embed_waits") === value) return;
    this.#write(() => {
      if (value === undefined) this.#run("DELETE FROM meta WHERE name = 'embed_waits'");
      else this.#run("INSERT OR REPLACE INTO meta(name, value) VALUES ('embed_waits', ?)", value);
    });
  }

  compact(): string[] {
    const model = this.vectorModel();
    if (model === null) return [];
    const compacted = compactVectors(this.db, this.folder, this.vectors, model);
    sweepVectorFiles(this.db, this.folder, this.vectors);
    return compacted;
  }

  generation(): string {
    return metaOf(this.db, "generation")!;
  }

  position(): unknown {
    return screenPositionOf(this.db);
  }

  close(): void {
    if (this.db.open) this.db.close();
  }


  unmarked(against: Against & { model: string }, most: number): Unmarked[] {
    if (!sameAgainst(metaOf(this.db, "marks"), against)) {
      this.db.transaction(() => {
        this.#run("INSERT INTO unmarked(slot) SELECT slot FROM screen_row WHERE slot NOT IN (SELECT slot FROM unmarked) ORDER BY slot");
        this.#run("INSERT OR REPLACE INTO meta(name, value) VALUES ('marks', ?)", JSON.stringify(against));
      }).immediate();
    }
    return this.db.transaction(() => this.#all<{ n: number; slot: number }>("SELECT n, slot FROM unmarked ORDER BY slot DESC LIMIT ?", most)
      .map(({ n, slot }): Unmarked => ({ of: "entry", n, texts: this.#textsOfRow(slot) })))();
  }

  marked(rows: readonly Pick<Unmarked, "of" | "n">[]): void {
    if (rows.length > 0) this.#run("DELETE FROM unmarked WHERE n IN (SELECT value FROM json_each(?))", JSON.stringify(rows.map((row) => row.n)));
  }

  markCounts(against: Against): { entries: number; unmarked: number } {
    return this.db.transaction(() => {
      const entries = this.#get<{ n: number }>("SELECT count(*) AS n FROM screen_row")!.n;
      if (!sameAgainst(metaOf(this.db, "marks"), against)) return { entries, unmarked: entries };
      return { entries, unmarked: this.#get<{ n: number }>("SELECT count(*) AS n FROM unmarked")!.n };
    })();
  }

  textsOf(ranges: readonly { machine: string; from_ms: number; to_ms: number }[]): string[] {
    return this.db.transaction(() => {
      const texts = new Set<string>();
      for (const range of ranges) {
        const slots = this.#all<{ slot: number }>(
          "SELECT slot FROM screen_row WHERE slot BETWEEN ? AND ? AND end_ms > ? AND key IN (SELECT id FROM screen_key WHERE machine = ?)",
          (range.from_ms - SEGMENT_MS) * 8, range.to_ms * 8 - 1, range.from_ms, range.machine,
        );
        for (const { slot } of slots) for (const text of this.#textsOfRow(slot)) texts.add(text);
      }
      return [...texts];
    })();
  }

  #textsOfRow(slot: number): string[] {
    const row = this.#get<{ name: string; times: Buffer | null; body: Buffer | null }>(
      "SELECT k.name, t.times, t.body FROM screen_row r JOIN screen_key k ON k.id = r.key LEFT JOIN screen_text t ON t.slot = r.slot WHERE r.slot = ?", slot,
    );
    if (row === undefined) return [];
    const lines = row.body === null ? [] : unpackText(row.times!, row.body).map((each) => each.line);
    return [...new Set([row.name, ...lines])].filter((text) => text.trim() !== "");
  }

  finish(): void {
    if (this.whole === undefined) return;
    const built = buildingFile(this.whole);
    let old: Database.Database | undefined;
    try {
      outOfLog(this.db, built, false);
      try {
        old = this.folder.store(SCREEN_STORE, this.whole, { mustExist: true, timeout: BUSY_MS, keepJournal: true });
        outOfLog(old, this.whole, true);
      } catch (error) {
        old?.close();
        old = undefined;
        if (!absent(error)) throw error;
        removeFile(this.whole);
      }
      failpoint("screen.retired");
      renameSync(built, this.whole);
      flushFolder(dirname(this.whole));
    } finally {
      old?.close();
      this.close();
    }
  }

  apply(segments: Iterable<ScreenSegment>, source: ScreenSource, position?: unknown, emptied: Iterable<string> = []): Applied {
    const applied: Applied = { appended: 0, rebuilt: [], held: 0 };
    const ordered = [...segments].sort((left, right) => compare(left.machine, right.machine) || left.start_ms - right.start_ms);
    const days = [...new Set(emptied)].sort();
    const writes = ordered.length + days.length;
    let done = 0;
    for (const segment of ordered) {
      const last = ++done === writes ? position : undefined;
      const day = civilDay(segment.start_ms, this.#days);
      const held = this.#get<{ version: string }>("SELECT version FROM screen_segment WHERE machine = ? AND start_ms = ?", segment.machine, segment.start_ms);
      if (held?.version === segment.version) {
        applied.held++;
        if (last !== undefined) this.#setPosition(last);
        continue;
      }
      const newest = this.#get<{ newest: number | null }>("SELECT max(start_ms) AS newest FROM screen_segment WHERE machine = ? AND day = ?", segment.machine, day)!.newest;
      if (held === undefined && (newest === null || segment.start_ms > newest)) {
        this.#write(() => {
          this.#append(segment, day);
          if (last !== undefined) this.#setPosition(last);
        });
        applied.appended++;
      } else {
        this.rebuild(segment.machine, day, source, last);
        applied.rebuilt.push(`${segment.machine}\0${day}`);
      }
    }
    for (const both of days) {
      const last = ++done === writes ? position : undefined;
      if (applied.rebuilt.includes(both)) {
        if (last !== undefined) this.#write(() => this.#setPosition(last));
        continue;
      }
      const [machine, day] = both.split("\0") as [string, string];
      this.rebuild(machine, day, source, last);
      applied.rebuilt.push(both);
    }
    if (writes === 0 && position !== undefined) this.#write(() => this.#setPosition(position));
    return applied;
  }

  rebuild(machine: string, day: string, source: ScreenSource, position?: unknown): void {
    const segments = [...source.segments(machine, day)]
      .filter((segment) => segment.machine === machine && civilDay(segment.start_ms, this.#days) === day)
      .sort((left, right) => left.start_ms - right.start_ms);
    this.#write(() => {
      const gone = this.#meaning ? this.#all<{ text_hash: string }>(
        "SELECT text_hash FROM screen_unit WHERE day = ? AND key IN (SELECT id FROM screen_key WHERE machine = ?)", day, machine,
      ).map((row) => row.text_hash) : [];
      this.#deleteDay(machine, day);
      for (const segment of segments) this.#append(segment, day);
      this.#run("DELETE FROM screen_key WHERE machine = ? AND NOT EXISTS (SELECT 1 FROM screen_row WHERE screen_row.key = screen_key.id)", machine);
      if (this.#meaning) this.#prune(gone);
      if (this.#erasing && this.#meaning) this.#owePurge();
      if (position !== undefined) this.#setPosition(position);
    });
  }

  #deleteDay(machine: string, day: string): void {
    const keys = "SELECT id FROM screen_key WHERE machine = ?";
    const slots = `SELECT slot FROM screen_row WHERE day = ? AND key IN (${keys})`;
    this.#run(`DELETE FROM unmarked WHERE slot IN (${slots})`, day, machine);
    this.#run(`DELETE FROM screen_fts WHERE rowid IN (${slots})`, day, machine);
    const texts = this.#run(`DELETE FROM screen_text WHERE slot IN (${slots})`, day, machine).changes;
    this.#counted(-texts);
    this.#run(`DELETE FROM screen_span WHERE slot IN (${slots})`, day, machine);
    this.#run(`DELETE FROM screen_row WHERE day = ? AND key IN (${keys})`, day, machine);
    const blocks = "SELECT id FROM screen_block WHERE machine = ? AND day = ?";
    this.#run(`DELETE FROM screen_block_fts WHERE rowid IN (${blocks})`, machine, day);
    this.#run(`DELETE FROM screen_block_run WHERE block IN (${blocks})`, machine, day);
    this.#run("DELETE FROM screen_block WHERE machine = ? AND day = ?", machine, day);
    this.#run("DELETE FROM screen_tail WHERE machine = ? AND day = ?", machine, day);
    this.#run("DELETE FROM screen_segment WHERE machine = ? AND day = ?", machine, day);
    if (this.#meaning) this.#run(`DELETE FROM screen_unit WHERE day = ? AND key IN (${keys})`, day, machine);
    for (const cache of [this.#seen, this.#chunks]) for (const name of cache.keys()) if (name.endsWith(`\0${day}`)) cache.delete(name);
  }

  #counted(by: number): void {
    if (by !== 0) this.#run("UPDATE meta SET value = CAST(value AS INTEGER) + ? WHERE name = 'texts'", by);
  }

  #prune(hashes: readonly string[]): void {
    if (hashes.length === 0) return;
    const list = JSON.stringify([...new Set(hashes)]);
    const unnamed = "text_hash IN (SELECT value FROM json_each(?)) AND NOT EXISTS (SELECT 1 FROM screen_unit u WHERE u.text_hash = %t.text_hash)";
    this.#run(`DELETE FROM screen_embed_queue WHERE ${unnamed.replace("%t", "screen_embed_queue")}`, list);
    this.#run(`DELETE FROM screen_embed_skipped WHERE ${unnamed.replace("%t", "screen_embed_skipped")}`, list);
    const left = new Map<string, number>();
    for (const { model, month } of this.#all<{ model: string; month: string }>(`DELETE FROM screen_vector WHERE ${unnamed.replace("%t", "screen_vector")} RETURNING model, month`, list)) {
      left.set(`${model}\0${month}`, (left.get(`${model}\0${month}`) ?? 0) + 1);
    }
    for (const [both, n] of left) {
      const [model, month] = both.split("\0") as [string, string];
      this.#run("UPDATE screen_vector_file SET named = named - ? WHERE model = ? AND month = ?", n, model, month);
    }
    this.#run(`UPDATE screen_embed_queue SET day = (SELECT max(day) FROM screen_unit u WHERE u.text_hash = screen_embed_queue.text_hash)
      WHERE text_hash IN (SELECT value FROM json_each(?))`, list);
  }

  #append(segment: ScreenSegment, day: string): void {
    const segmentId = Number(this.#run(
      "INSERT INTO screen_segment(machine, day, version, start_ms) VALUES (?, ?, ?, ?)",
      segment.machine, day, segment.version, segment.start_ms,
    ).lastInsertRowid);
    const frames = [...segment.frames].sort((left, right) => left.t - right.t);
    if (frames.length === 0) return;
    const segEnd = Math.max(segment.end_ms ?? segment.start_ms + SEGMENT_MS, frames.at(-1)!.t);
    const tail = this.#get<{ frame: string; since_ms: number }>("SELECT frame, since_ms FROM screen_tail WHERE machine = ? AND day = ?", segment.machine, day);
    let previous = tail?.frame ?? null;
    let since = tail?.since_ms ?? 0;
    const read = new Map<string, string>();
    const plainLines = (lines: readonly string[]) => lines.map((line) => {
      let plain = read.get(line);
      if (plain === undefined) read.set(line, plain = plainLine(line));
      return plain;
    }).filter((line) => line !== "");
    const blocks = new Map<string, boolean>();
    const isBlock = (line: string) => {
      let block = blocks.get(line);
      if (block === undefined) blocks.set(line, block = line.length >= BLOCK_MIN_CHARS && line.split(" ").length >= BLOCK_MIN_WORDS);
      return block;
    };
    const rows = new Map<string, RowBuild>();
    const sightings = new Map<string, { key: number; display: string; from: number; to: number }[]>();
    const open = new Map<string, { identity: string; span: { display: string; from: number; to: number } }>();
    for (const [i, frame] of frames.entries()) {
      const display = frame.display ?? "";
      const next = frames[i + 1]?.t ?? segEnd;
      const dur = Math.max(0, Math.min(next - frame.t, FRAME_CAP_MS));
      const key = keyOf(frame.app, frame.site, frame.title, frame.lines);
      const identity = `${key.app}\0${key.site}\0${key.name}`;
      const plain = plainLines(frame.lines);
      const ocr = plainLines(frame.ocr ?? []);
      const fingerprint = digest(`${display}\0${identity}\0${plain.join("\n")}\0${ocr.join("\n")}`);
      if (fingerprint !== previous) {
        previous = fingerprint;
        since = frame.t;
      }
      const counted = Math.max(0, Math.min(frame.t + dur, since + UNCHANGED_MS) - frame.t);
      let row = rows.get(identity);
      if (row === undefined) {
        const id = this.#key(segment.machine, key.app, key.site, key.name);
        row = {
          key: id, identity, start: frame.t, end: frame.t + dur, ms: 0, titles: new Set(), name: key.name, app: key.app,
          firstTitle: frame.title, lines: [], ax: [], times: [], spans: [], local: new Set(),
        };
        rows.set(identity, row);
      }
      row.end = Math.max(row.end, frame.t + dur);
      row.ms += counted;
      if (frame.title !== null && frame.title !== "") row.titles.add(frame.title);
      const current = open.get(display);
      if (current !== undefined && current.identity === identity) current.span.to = frame.t + dur;
      else {
        const span = { display, from: frame.t, to: frame.t + dur };
        row.spans.push(span);
        open.set(display, { identity, span });
      }
      const seen = this.#seenOf(row.key, day);
      const tenths = Math.min(AX_BIT - 1, Math.max(0, Math.round((frame.t - segment.start_ms) / 100)));
      for (const [ax, lines] of [[true, plain], [false, ocr]] as const) {
        for (const line of lines) {
          if (row.local.has(line)) continue;
          row.local.add(line);
          const hash = lineDigest(line);
          if (seen.has(hash)) continue;
          seen.add(hash);
          row.lines.push(line);
          row.ax.push(ax);
          row.times.push(tenths);
        }
      }
      for (const line of new Set(plain)) {
        if (!isBlock(line)) continue;
        const list = sightings.get(line) ?? [];
        list.push({ key: row.key, display, from: frame.t, to: frame.t + dur });
        sightings.set(line, list);
      }
    }
    this.#run("INSERT OR REPLACE INTO screen_tail(machine, day, frame, since_ms) VALUES (?, ?, ?, ?)", segment.machine, day, previous!, since);
    const ordered = [...rows.values()].sort((left, right) => left.start - right.start || compare(left.identity, right.identity));
    let texts = 0;
    for (const row of ordered) if (this.#row(row, day, segment, segmentId)) texts++;
    this.#counted(texts);
    for (const [text, seen] of sightings) this.#block(segment.machine, day, text, seen);
  }

  #row(row: RowBuild, day: string, segment: ScreenSegment, segmentId: number): boolean {
    const slot = this.#slot(row.start);
    const prose = proseChars(row.lines, documentLike(row.app, row.firstTitle));
    this.#statement("INSERT INTO screen_row(slot, key, day, end_ms, seg_ms, tenths, prose, segment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(slot, row.key, day, row.end, segment.start_ms, Math.round(row.ms / 100), prose, segmentId);
    this.#statement("INSERT INTO unmarked(slot) VALUES (?)").run(slot);
    for (const span of row.spans) this.#statement("INSERT INTO screen_span(slot, display, from_ms, to_ms) VALUES (?, ?, ?, ?)").run(slot, span.display, span.from, span.to);
    if (row.lines.length === 0) return false;
    const times = Buffer.alloc(row.times.length * 2);
    row.times.forEach((tenths, i) => times.writeUInt16LE(tenths | (row.ax[i] ? AX_BIT : 0), i * 2));
    const body = row.lines.join("\n");
    const packed = zstdCompressSync(Buffer.from(body, "utf8"), { params: { [constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } });
    this.#statement("INSERT INTO screen_text(slot, times, body) VALUES (?, ?, ?)").run(slot, times, packed);
    const title = [...row.titles, row.name].filter((value, i, all) => value !== "" && all.indexOf(value) === i).join("\n");
    this.#statement("INSERT INTO screen_fts(rowid, title, body) VALUES (?, ?, ?)").run(slot, title, body);
    if (this.#meaning) {
      const lines = row.lines.map((line, at) => ({ at, line, ax: row.ax[at]! })).filter((each) => each.ax);
      if (lines.length > 0) this.#chunk(row.key, day, slot, row.start, row.end, lines);
    }
    return true;
  }

  #slot(start: number): number {
    for (let ms = start; ; ms++) {
      const taken = new Set(this.#all<{ slot: number }>("SELECT slot FROM screen_row WHERE slot BETWEEN ? AND ?", ms * 8, ms * 8 + 7).map((row) => row.slot));
      for (let n = 0; n < 8; n++) if (!taken.has(ms * 8 + n)) return ms * 8 + n;
    }
  }

  #key(machine: string, app: string, site: string, name: string): number {
    this.#statement("INSERT OR IGNORE INTO screen_key(machine, app, site, name) VALUES (?, ?, ?, ?)").run(machine, app, site, name);
    return this.#get<{ id: number }>("SELECT id FROM screen_key WHERE machine = ? AND app = ? AND site = ? AND name = ?", machine, app, site, name)!.id;
  }

  #seenOf(key: number, day: string): Set<number> {
    const name = `${key}\0${day}`;
    let seen = this.#seen.get(name);
    if (seen === undefined) {
      seen = new Set();
      const texts = this.#all<{ times: Buffer; body: Buffer }>("SELECT t.times, t.body FROM screen_row r JOIN screen_text t ON t.slot = r.slot WHERE r.key = ? AND r.day = ?", key, day);
      for (const text of texts) for (const { line } of unpackText(text.times, text.body)) seen.add(lineDigest(line));
      this.#seen.set(name, seen);
    }
    return seen;
  }

  #block(machine: string, day: string, text: string, seen: { key: number; display: string; from: number; to: number }[]): void {
    const hash = digest(text);
    let block = this.#get<{ id: number }>("SELECT id FROM screen_block WHERE machine = ? AND day = ? AND hash = ?", machine, day, hash);
    if (block === undefined) {
      const id = Number(this.#statement("INSERT INTO screen_block(machine, day, hash, key) VALUES (?, ?, ?, ?)").run(machine, day, hash, seen[0]!.key).lastInsertRowid);
      this.#statement("INSERT INTO screen_block_fts(rowid, body) VALUES (?, ?)").run(id, text);
      block = { id };
      if (this.#meaning) this.#unit("block", seen[0]!.key, day, hash, null, null);
    }
    const byDisplay = new Map<string, { from: number; to: number }[]>();
    for (const sight of seen) {
      const runs = byDisplay.get(sight.display) ?? [];
      const last = runs.at(-1);
      if (last !== undefined && sight.from - last.to < BLOCK_GAP_MS) last.to = Math.max(last.to, sight.to);
      else runs.push({ from: sight.from, to: sight.to });
      byDisplay.set(sight.display, runs);
    }
    for (const [display, runs] of [...byDisplay].sort((left, right) => compare(left[0], right[0]))) {
      const held = this.#get<{ rowid: number; to_ms: number }>(
        "SELECT rowid, to_ms FROM screen_block_run WHERE block = ? AND display = ? ORDER BY to_ms DESC LIMIT 1", block.id, display,
      );
      for (const [i, run] of runs.entries()) {
        if (i === 0 && held !== undefined && run.from - held.to_ms < BLOCK_GAP_MS) {
          this.#statement("UPDATE screen_block_run SET to_ms = ? WHERE rowid = ?").run(Math.max(held.to_ms, run.to), held.rowid);
        } else {
          this.#statement("INSERT INTO screen_block_run(block, display, from_ms, to_ms) VALUES (?, ?, ?, ?)").run(block.id, display, run.from, run.to);
        }
      }
    }
  }

  #openChunk(key: number, day: string): OpenChunk | undefined {
    const name = `${key}\0${day}`;
    if (!this.#chunks.has(name)) {
      const unit = this.#get<{ unit: number; members: string }>("SELECT unit, members FROM screen_unit WHERE key = ? AND day = ? AND kind = 'chunk' ORDER BY unit DESC LIMIT 1", key, day);
      this.#chunks.set(name, unit === undefined ? null : {
        unit: unit.unit,
        members: JSON.parse(unit.members) as [number, number, number][],
        text: chunkLines(this.db, unit.members).flatMap((member) => member.lines).join("\n"),
      });
    }
    return this.#chunks.get(name) ?? undefined;
  }

  #chunk(key: number, day: string, slot: number, start: number, end: number, lines: readonly { at: number; line: string }[]): void {
    let open = this.#openChunk(key, day);
    let text = open?.text ?? "";
    let members: [number, number, number][] = open?.members.map((member) => [...member] as [number, number, number]) ?? [];
    const gone: string[] = [];
    const flush = () => {
      if (text === "" || text === open?.text) return;
      const hash = digest(text);
      if (open === undefined) {
        const unit = this.#unit("chunk", key, day, hash, JSON.stringify([[start, end]]), JSON.stringify(members));
        open = { unit, text, members };
      } else {
        const held = this.#get<{ text_hash: string; runs: string }>("SELECT text_hash, runs FROM screen_unit WHERE unit = ?", open.unit)!;
        const runs = JSON.parse(held.runs) as [number, number][];
        const last = runs.at(-1)!;
        if (start - last[1] < BLOCK_GAP_MS) last[1] = Math.max(last[1], end);
        else runs.push([start, end]);
        if (held.text_hash !== hash) {
          gone.push(held.text_hash);
          this.#statement("UPDATE screen_unit SET text_hash = ?, vmonth = ?, vrow = ? WHERE unit = ?").run(hash, ...this.#placed(hash, day), open.unit);
        }
        this.#statement("UPDATE screen_unit SET runs = ?, members = ? WHERE unit = ?").run(JSON.stringify(runs), JSON.stringify(members), open.unit);
        open = { unit: open.unit, text, members };
      }
    };
    for (const { at, line } of lines) {
      if (text !== "" && Buffer.byteLength(text, "utf8") + 1 + Buffer.byteLength(line, "utf8") > CHUNK_BYTES) {
        flush();
        open = undefined;
        text = "";
        members = [];
      }
      text = text === "" ? line : `${text}\n${line}`;
      const last = members.at(-1);
      if (last !== undefined && last[0] === slot) last[2] = at;
      else members.push([slot, at, at]);
    }
    flush();
    this.#chunks.set(`${key}\0${day}`, open ?? null);
    this.#prune(gone);
  }

  #unit(kind: "block" | "chunk", key: number, day: string, hash: string, runs: string | null, members: string | null): number {
    return Number(this.#statement("INSERT INTO screen_unit(kind, key, day, text_hash, runs, members, vmonth, vrow) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(kind, key, day, hash, runs, members, ...this.#placed(hash, day)).lastInsertRowid);
  }

  #placed(hash: string, day: string): [string | null, number | null] {
    const vector = this.#statement("SELECT month, row FROM screen_vector WHERE model = (SELECT value FROM meta WHERE name = 'vector_model') AND text_hash = ?").get(hash) as { month: string; row: number } | undefined;
    if (vector !== undefined) return [vector.month, vector.row];
    if (this.#get("SELECT 1 FROM screen_embed_skipped WHERE text_hash = ?", hash) === undefined) {
      this.#statement("INSERT INTO screen_embed_queue(text_hash, day) VALUES (?, ?) ON CONFLICT(text_hash) DO UPDATE SET day = max(day, excluded.day)").run(hash, day);
    }
    return [null, null];
  }

  #setPosition(position: unknown): void {
    this.#statement("INSERT OR REPLACE INTO meta(name, value) VALUES ('position', ?)").run(JSON.stringify(position));
  }

  #write(body: () => void): void {
    try {
      this.db.transaction(body)();
    } catch (error) {
      this.#seen.clear();
      this.#chunks.clear();
      throw error;
    }
  }

  #statement(sql: string): Database.Statement {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  #run(sql: string, ...values: unknown[]): Database.RunResult {
    return this.#statement(sql).run(...values);
  }

  #get<T>(sql: string, ...values: unknown[]): T | undefined {
    return this.#statement(sql).get(...values) as T | undefined;
  }

  #all<T>(sql: string, ...values: unknown[]): T[] {
    return this.#statement(sql).all(...values) as T[];
  }
}

function sameAgainst(held: string | undefined, asked: Against): boolean {
  if (held === undefined) return false;
  const against = JSON.parse(held) as Against;
  return against.store === asked.store && (asked.model === null || against.model === asked.model);
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function lineDigest(line: string): number {
  return createHash("sha256").update(line).digest().readUIntBE(0, 6);
}

function meaningGeneration(folder: HomeFolder, path: string): string[] | undefined {
  const db = readScreen(folder, path);
  if (db === undefined) return undefined;
  try {
    const generation = metaOf(db, "generation");
    return generation === undefined || metaOf(db, "meaning") !== "true" ? [] : [generation];
  } finally {
    db.close();
  }
}

function sweepGenerations(file: string, kept: readonly string[]): void {
  let folders;
  try {
    folders = readdirSync(vectorsRootOf(file));
  } catch {
    return;
  }
  for (const name of folders) if (!kept.includes(name)) rmSync(join(vectorsRootOf(file), name), { recursive: true, force: true });
}

function removeFile(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
