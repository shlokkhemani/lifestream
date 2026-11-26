import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { LEFT_MARK, type LeftMark } from "./asks-left.js";
import type { HomeFolder, StoreKind } from "./home-folder.js";
import { Records } from "./records.js";
import { HOME_DB, homeError, Sql, type Moved } from "./sql.js";
import { Schema, type Migrated, type Migration, type OpenMode, type SchemaLog } from "./schema.js";
import { STORED_MARK, Stored, upgradeMark } from "./stored.js";
import { derived, tables, type Derived, type Tables } from "./tables.js";
import { tallyOf, type Tally } from "./tally.js";
import { civilDay } from "./time.js";
import type { DaySettings } from "./types.js";
import { ReadView, type OpenView } from "./view.js";

const VOICE_ID = "openrouter-voice:";
const KIND_INPUTS: Readonly<Record<string, readonly string[]>> = { pictures: ["text", "image"], audio: ["audio"], text: ["text"] };

const voiceMoved = (id: unknown): unknown => typeof id === "string" && id.startsWith(VOICE_ID) ? `openrouter:${id.slice(VOICE_ID.length)}` : id;

const MIGRATIONS: readonly Migration[] = [
  (db) => db.exec(`DROP TABLE claims;
    DROP TABLE landed;
    DROP TABLE landed_minutes;
    DROP INDEX deliveries_custody;
    ALTER TABLE spans DROP COLUMN max_ms;
    DELETE FROM meta WHERE key IN ('steps', 'writer');
    INSERT INTO meta (key, value) VALUES ('floor', '2147483647') ON CONFLICT (key) DO UPDATE SET value = excluded.value`),
  (db) => db.exec(`    DROP TRIGGER enrichments_insert;
    CREATE TRIGGER enrichments_insert AFTER INSERT ON enrichments BEGIN
      INSERT INTO dirty_days (day) SELECT d.day FROM extract_items i CROSS JOIN extract_days d ON d.family = i.family AND d.unit = i.unit
        WHERE i.family = new.family AND i.item = new.item ON CONFLICT DO UPDATE SET marks = marks + 1, error = NULL;
    END;
    DROP TRIGGER enrichments_update;
    CREATE TRIGGER enrichments_update AFTER UPDATE ON enrichments BEGIN
      INSERT INTO dirty_days (day) SELECT d.day FROM extract_items i CROSS JOIN extract_days d ON d.family = i.family AND d.unit = i.unit
        WHERE i.family = new.family AND i.item = new.item ON CONFLICT DO UPDATE SET marks = marks + 1, error = NULL;
    END;
    DROP TRIGGER enrichments_delete;
    CREATE TRIGGER enrichments_delete AFTER DELETE ON enrichments BEGIN
      INSERT INTO dirty_days (day) SELECT d.day FROM extract_items i CROSS JOIN extract_days d ON d.family = i.family AND d.unit = i.unit
        WHERE i.family = old.family AND i.item = old.item ON CONFLICT DO UPDATE SET marks = marks + 1, error = NULL;
      INSERT INTO dirty_units (family, unit, end_ms) SELECT e.family, e.unit, e.end_ms FROM extract_items i
        CROSS JOIN extracts e ON e.family = i.family AND e.unit = i.unit WHERE i.family = old.family AND i.item = old.item
        ON CONFLICT DO UPDATE SET end_ms = excluded.end_ms, marks = marks + 1, error = NULL;
    END;`),
  (db) => {
    db.exec("CREATE TABLE asks_left (work_id TEXT NOT NULL, prompt TEXT NOT NULL, day INTEGER NOT NULL, pending INTEGER NOT NULL, PRIMARY KEY (work_id, prompt, day)) STRICT, WITHOUT ROWID");
    if (db.prepare("SELECT 1 FROM asks INDEXED BY asks_pick WHERE state = 'pending' AND work_id IS NOT NULL LIMIT 1").get() !== undefined) {
      db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(LEFT_MARK, JSON.stringify({ at: null } satisfies LeftMark));
    }
  },
  () => undefined,
  (db) => db.exec("DELETE FROM cursors WHERE name IN ('extracted:labels', 'extracted:physical')"),
  (db) => db.exec(`ALTER TABLE spans ADD COLUMN oldest_ms INTEGER;
    ALTER TABLE spans ADD COLUMN newest_ms INTEGER;
    ALTER TABLE spans ADD COLUMN newest_dated INTEGER;
    UPDATE spans SET
      oldest_ms = (SELECT start_ms FROM heads INDEXED BY heads_time
        WHERE source = spans.source AND kind = spans.kind AND version <> 'gone' AND start_ms IS NOT NULL ORDER BY start_ms LIMIT 1),
      newest_ms = (SELECT start_ms FROM heads INDEXED BY heads_time
        WHERE source = spans.source AND kind = spans.kind AND version <> 'gone' AND start_ms IS NOT NULL ORDER BY start_ms DESC LIMIT 1),
      newest_dated = (SELECT v.precision IS 'day' FROM heads h INDEXED BY heads_time JOIN versions v ON v.id = h.version
        WHERE h.source = spans.source AND h.kind = spans.kind AND h.version <> 'gone' AND h.start_ms IS NOT NULL ORDER BY h.start_ms DESC LIMIT 1);
    CREATE TABLE lost_files (source TEXT NOT NULL, blob TEXT NOT NULL, claim TEXT NOT NULL, sealed_ms INTEGER NOT NULL, PRIMARY KEY (source, blob)) STRICT, WITHOUT ROWID;
    CREATE INDEX lost_files_sealed ON lost_files(source, sealed_ms);
    CREATE INDEX lost_files_claim ON lost_files(claim, source);
    INSERT OR IGNORE INTO lost_files (source, blob, claim, sealed_ms)
      SELECT w.source, w.blob, d.id, d.sealed_ms FROM deliveries d INDEXED BY deliveries_lost
        CROSS JOIN statements s INDEXED BY statements_run ON s.run = d.run AND s.source = d.source
        CROSS JOIN version_blobs vb ON vb.version = s.version
        CROSS JOIN wanted_blobs w ON w.blob = vb.blob AND w.source = s.source AND w.kind = s.kind AND w.key = s.key
      WHERE d.lost IS NOT NULL AND d.run IS NOT NULL ORDER BY d.sealed_ms, d.id`),
  (db) => db.exec(`UPDATE cursors SET seq = (SELECT coalesce(max(seq), 0) FROM statements),
      reread = coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'rereads'), 0)
    WHERE seq = 0 AND name IN (SELECT 'extract:' || substr(name, 9) FROM cursors WHERE name LIKE 'rebuild:%' AND seq > 0)`),
  (db) => db.exec(`CREATE TABLE asks_unhideable (family TEXT NOT NULL, item TEXT NOT NULL, prompt TEXT NOT NULL, work_id TEXT, unit TEXT NOT NULL,
      why TEXT NOT NULL, PRIMARY KEY (family, item, prompt)) STRICT, WITHOUT ROWID;
    CREATE INDEX asks_unhideable_work ON asks_unhideable(work_id);
    CREATE TRIGGER asks_unhideable_go AFTER DELETE ON asks BEGIN
      DELETE FROM asks_unhideable WHERE family = old.family AND item = old.item AND prompt = old.prompt;
    END`),
  (db) => db.exec(`INSERT INTO meta (key, value)
      SELECT 'poll-move:' || acquirer, json_object('source', source, 'state', state) FROM polls WHERE source IS NOT NULL OR state <> '{}';
    INSERT INTO meta (key, value)
      SELECT 'poll-move:' || acquirer, CASE WHEN json_type(parked, '$.state') IS 'object'
          THEN json_object('source', parked ->> '$.source', 'state', parked ->> '$.state') ELSE json_object('source', NULL, 'state', value) END
        FROM (SELECT substr(key, 13) AS acquirer, value, CASE WHEN json_valid(value) THEN value END AS parked
          FROM meta WHERE key >= 'poll-parked:' AND key < 'poll-parked;')
        WHERE NOT (json_type(parked, '$.state') IS 'object' AND parked ->> '$.state' = '{}' AND parked ->> '$.source' IS NULL)
      ON CONFLICT (key) DO NOTHING;
    UPDATE meta SET value = json_object('paged_ms', (SELECT CASE WHEN json_type(parked, '$.paged_ms') IS 'integer' THEN parked ->> '$.paged_ms' END
        FROM (SELECT CASE WHEN json_valid(value) THEN value END AS parked)))
      WHERE key >= 'poll-parked:' AND key < 'poll-parked;';
    ALTER TABLE polls DROP COLUMN state;
    ALTER TABLE polls DROP COLUMN source;
    ALTER TABLE polls DROP COLUMN last_ok_ms;
    ALTER TABLE polls DROP COLUMN error;
    ALTER TABLE polls DROP COLUMN page_error;
    CREATE TABLE poll_cursors (acquirer TEXT PRIMARY KEY, source TEXT NOT NULL, state TEXT NOT NULL,
      CHECK (length(CAST(state AS BLOB)) <= 16384)) STRICT, WITHOUT ROWID;
    CREATE TABLE poll_memory (acquirer TEXT NOT NULL, part TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY (acquirer, part, key)) STRICT, WITHOUT ROWID`),
  (db) => db.exec(`UPDATE backfills SET left = NULL, recent = '[]', last = NULL
      WHERE acquirer IN (SELECT substr(key, 11) FROM meta WHERE key >= 'poll-move:' AND key < 'poll-move;');
    DELETE FROM meta WHERE (key >= 'poll-move:' AND key < 'poll-move;') OR (key >= 'poll-moved:' AND key < 'poll-moved;')`),
  () => {},
  (db) => {
    db.exec(`CREATE TABLE stored_days (day TEXT NOT NULL, source TEXT NOT NULL, text INTEGER NOT NULL, files INTEGER NOT NULL,
        PRIMARY KEY (day, source)) STRICT, WITHOUT ROWID;
      CREATE TABLE stored_files (blob TEXT PRIMARY KEY, source TEXT NOT NULL, version INTEGER NOT NULL, bytes INTEGER NOT NULL) STRICT, WITHOUT ROWID;
      CREATE TABLE own_days (day TEXT PRIMARY KEY, bytes INTEGER NOT NULL) STRICT, WITHOUT ROWID`);
    const M = db.prepare("SELECT coalesce(max(rowid), 0) AS rowid FROM versions").pluck().get() as number;
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(STORED_MARK, JSON.stringify(upgradeMark(M)));
  },
  (db) => db.exec(`CREATE INDEX runs_subject ON runs(kind, subject);
    CREATE INDEX runs_open ON runs(id) WHERE outcome IS NULL`),
  (db) => db.exec(`ALTER TABLE backfills ADD COLUMN start_ms INTEGER;
    UPDATE backfills SET left = NULL, recent = '[]', last = NULL WHERE reach <> 'all';
    ALTER TABLE backfills DROP COLUMN reach;
    ALTER TABLE poll_cursors ADD COLUMN start_ms INTEGER`),
  (db) => db.exec("DELETE FROM meta WHERE key >= 'people:request:' AND key < 'people:request;'"),
  modelsMove,
];

function modelsMove(db: Database.Database): void {
  db.exec(`UPDATE item_routes SET route = 'openrouter:' || substr(route, ${VOICE_ID.length + 1}) WHERE substr(route, 1, ${VOICE_ID.length}) = '${VOICE_ID}';
    UPDATE asks SET given_up = 'openrouter:' || substr(given_up, ${VOICE_ID.length + 1}) WHERE substr(given_up, 1, ${VOICE_ID.length}) = '${VOICE_ID}'`);
  const read = db.prepare("SELECT value FROM meta WHERE key = ?").pluck();
  const write = db.prepare("UPDATE meta SET value = ? WHERE key = ?");
  for (const [key, moved] of [["llm:models", modelsMoved], ["llm:hiding", hidingMoved]] as const) {
    const value = read.get(key);
    if (typeof value === "string") write.run(JSON.stringify(moved(JSON.parse(value))), key);
  }
  db.prepare("INSERT INTO meta (key, value) VALUES (?, '{}') ON CONFLICT (key) DO NOTHING").run(SETTINGS_MOVE.key);
}

function modelsMoved(stored: { routes?: Record<string, unknown>[]; runners?: Record<string, unknown>[] }): object {
  return { routes: (stored.routes ?? []).map(routeMoved), runners: (stored.runners ?? []).map((runner) => ({ ...runner, below: runner.below ?? null })), connections: {} };
}

function routeMoved({ kinds, text_chars, ...route }: Record<string, unknown>): Record<string, unknown> {
  const moved = { ...route, id: voiceMoved(route.id), transport: route.transport === "openrouter-voice" ? "openrouter" : route.transport, suggested: route.suggested ?? [] };
  if (!Array.isArray(kinds)) return moved;
  const input = ["text", "image", "audio"].filter((each) => kinds.some((kind) => KIND_INPUTS[String(kind)]?.includes(each) === true));
  return { ...moved, input, output: "text", tools: false, context_tokens: typeof text_chars === "number" ? Math.floor(text_chars / 4) : null, thinking: [], chat: route.chat ?? null };
}

function hidingMoved(stored: Record<string, unknown[]>): object {
  return Object.fromEntries(Object.entries(stored).map(([work, [route, ...rest]]) => [work, [voiceMoved(route), ...rest]]));
}

export function metaAsItLies(folder: HomeFolder, keys: readonly string[]): { version: number; values: ReadonlyMap<string, string> } | null {
  const path = join(folder.root, HOME_DB);
  if (!existsSync(path)) return null;
  let db: Database.Database | undefined;
  try {
    db = folder.store(HOME_STORE, path, { mode: "read", mustExist: true, timeout: BUSY_TIMEOUT_MS });
    const version = homeSchema.version(db);
    const read = version === 0 ? undefined : db.prepare("SELECT value FROM meta WHERE key = ?").pluck();
    return { version, values: new Map(keys.flatMap((key) => { const value = read?.get(key); return typeof value === "string" ? [[key, value] as const] : []; })) };
  } catch (error) {
    throw homeError(error);
  } finally {
    db?.close();
  }
}

const SMALL = ["sources", "devices", "polls", "poll_cursors", "cursors", "jobs", "controls", "grants", "meta", "spans", "backfills", "custody", "attempts", "lost_files"];
export const homeSchema = new Schema({
  name: "home.db", file: "home.db", base: 22, baseline: readFileSync(new URL("./schema.sql", import.meta.url), "utf8"), migrations: MIGRATIONS, small: SMALL, indexed: [30, 35],
});
export const SETTINGS_MOVE = { key: "move:settings", version: homeSchema.base + MIGRATIONS.indexOf(modelsMove) + 1 } as const;
export const MIN_SQLITE = "3.51.3";
const BUSY_TIMEOUT_MS = 5_000;
const UTC_DAYS: DaySettings = { zone: "UTC", day_start_hour: 0 };
export const CHECKPOINT_PAGES = 16_384;

export interface Tx {
  readonly records: Records;
  readonly tables: Tables;
  readonly derived: Derived;
  readonly tally: Tally;
  readonly stored: Stored;
  readonly moved: Moved;
}

export interface HomeDb {
  readonly path: string;
  readonly mode: OpenMode;
  readonly migrated: Migrated | null;
  commit<T>(work: (tx: Tx) => T, options?: { secure?: boolean }): T;
  view(): OpenView;
  checkpoint(mode: "noop" | "passive" | "truncate", wait_ms?: number): { busy: number; log: number; checkpointed: number };
  close(): void;
}

export interface OpenOptions {
  busy_timeout_ms?: number;
  log?: SchemaLog;
  ownCheckpoints?: boolean;
  clock?: () => number;
  day?: () => DaySettings;
}

export const HOME_STORE: StoreKind = { role: "home", remade: false };

export function openHome(folder: HomeFolder, mode: OpenMode, options: OpenOptions = {}): HomeDb {
  const path = join(folder.root, HOME_DB);
  if (mode !== "migrate" && !existsSync(path)) throw new Error(`no home database at ${path}`);
  const timeout = options.busy_timeout_ms ?? BUSY_TIMEOUT_MS;
  let db: Database.Database | undefined;
  try {
    db = folder.store(HOME_STORE, path, mode === "read" ? { mode: "read", mustExist: true, timeout } : { timeout });
    const version = (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
    if (compareVersions(version, MIN_SQLITE) < 0) throw new Error(`SQLite ${version} is older than ${MIN_SQLITE}`);
    if (mode !== "read") db.pragma(`wal_autocheckpoint = ${CHECKPOINT_PAGES}`);
    const migrated = homeSchema.open(db, mode, options.log);
    if (mode !== "read" && options.ownCheckpoints === true) db.pragma("wal_autocheckpoint = 0");
    const clock = options.clock ?? Date.now;
    const day = options.day ?? (() => UTC_DAYS);
    return new Home(path, mode, db, migrated, () => civilDay(clock(), day()));
  } catch (error) {
    db?.close();
    throw homeError(error);
  }
}

class Home implements HomeDb {
  readonly #sql: Sql;
  readonly #tx: Tx;

  constructor(
    readonly path: string,
    readonly mode: OpenMode,
    private readonly db: Database.Database,
    readonly migrated: Migrated | null,
    today: () => string,
  ) {
    this.#sql = new Sql(db);
    const stored = new Stored(this.#sql, today);
    this.#tx = { records: new Records(this.#sql, stored), tables: tables(this.#sql), derived: derived(this.#sql), tally: tallyOf(this.#sql), stored, moved: this.#sql.moved };
  }

  commit<T>(work: (tx: Tx) => T, options: { secure?: boolean } = {}): T {
    if (this.mode === "read") throw new Error("a read-mode home database cannot commit");
    this.#idle();
    const secure = options.secure === true;
    if (secure) this.#sql.on(() => this.db.pragma("secure_delete = ON"));
    try {
      this.#exec("BEGIN IMMEDIATE");
      this.#sql.state = "commit";
      this.#sql.moved.clear();
      try {
        const result = work(this.#tx);
        if (result instanceof Promise) throw new Error("a commit's work is synchronous: it cannot await");
        this.#exec("COMMIT");
        return result;
      } catch (error) {
        if (this.db.inTransaction) this.#exec("ROLLBACK");
        throw error;
      } finally {
        this.#sql.state = "idle";
      }
    } finally {
      if (secure) this.#sql.on(() => this.db.pragma("secure_delete = FAST"));
    }
  }

  view(): OpenView {
    this.#idle();
    this.#exec("BEGIN");
    this.#sql.state = "view";
    try {
      return new ReadView(this.#sql, this.#tx.records.top(), () => {
        this.#sql.state = "idle";
        if (this.db.inTransaction) this.#exec("COMMIT");
      });
    } catch (error) {
      this.#sql.state = "idle";
      if (this.db.inTransaction) this.#exec("ROLLBACK");
      throw error;
    }
  }

  checkpoint(mode: "noop" | "passive" | "truncate", wait_ms = 0): { busy: number; log: number; checkpointed: number } {
    this.#idle();
    return this.#sql.on(() => {
      const wait = this.db.pragma("busy_timeout", { simple: true }) as number;
      if (mode === "truncate") this.db.pragma(`busy_timeout = ${Math.max(0, Math.floor(wait_ms))}`);
      try {
        const [row] = this.db.pragma(`wal_checkpoint(${mode.toUpperCase()})`) as { busy: number; log: number; checkpointed: number }[];
        return row!;
      } finally {
        this.db.pragma(`busy_timeout = ${wait}`);
      }
    });
  }

  close(): void {
    if (this.#sql.state === "view" && this.db.inTransaction) this.#exec("COMMIT");
    this.#sql.state = "idle";
    this.db.close();
  }

  #exec(text: string): void {
    this.#sql.on(() => this.db.exec(text));
  }

  #idle(): void {
    if (this.#sql.state !== "idle") throw new Error(`this connection is inside a ${this.#sql.state}; close it first`);
  }
}

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
