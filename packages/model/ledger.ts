import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type Database from "better-sqlite3";
import { BlobError, canonical, flush, homeError, instant, LEDGER_DB, makeUnder, Schema, tryLock, wantedOf, type AnswerType, type BlobStore, type Drawn, type FileLock, type HomeFolder, type Mark, type Migration, type OpenMode, type PlaceholderTable, type SchemaLog, type StoreKind } from "@lifestreamprotocol/core";
import { bare } from "./answer-types.js";
import { promptHash, type Sampling } from "./digest.js";
import { accessLogOver, type AccessErased, type AccessLog, type Scrub } from "./access-log.js";
import { outboundOver, type NewOutbound, type OutboundLog } from "./outbound.js";
import { placeholdersOver, type PlaceholderTables, type Saved } from "./placeholders.js";
import { sentOver, type SentCopies } from "./sent.js";
import { bounded } from "./transport.js";


const CALLS = "calls";

export function callsLock(ledger: string): string {
  return join(dirname(ledger), "calls.lock");
}

const HOLD_LOOK_MS = 500;

export async function holdCalls(ledger: string, options: { limit_ms?: number; signal?: AbortSignal; waiting: () => void }): Promise<FileLock> {
  const { signal } = options;
  const start = performance.now();
  for (let looks = 0; ; looks++) {
    signal?.throwIfAborted();
    const lock = tryLock(callsLock(ledger));
    if (lock !== null) return lock;
    if (looks === 0) options.waiting();
    const left = options.limit_ms === undefined ? HOLD_LOOK_MS : options.limit_ms - (performance.now() - start);
    if (left <= 0) throw new Error("a model call did not end");
    try {
      await delay(Math.min(HOLD_LOOK_MS, left), undefined, signal === undefined ? {} : { signal });
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    }
  }
}

export function callLock(folder: HomeFolder, key: string): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(key)) throw new TypeError(`no request key: ${key}`);
  return `${folder.blobFile(join(dirname(ledgerFileOf(folder.root)), CALLS), key).path}.lock`;
}

export function callCopiesOf(machine: string, home: string): string {
  return join(machine, CALLS, home);
}

const DIED = "the call process died with no outcome";
export const RETRY_AFTER_MS = 30 * 60_000;
export const TRIES = 3;

const BASELINE = `
  CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE replies(
    key TEXT PRIMARY KEY, model TEXT, prompt_hash TEXT, input_hash TEXT, effort TEXT,
    sampling TEXT, output_schema TEXT, text TEXT NOT NULL, reply_model TEXT,
    invocation TEXT, runtime TEXT, input_tokens INTEGER, output_tokens INTEGER,
    cost_usd REAL, validation TEXT CHECK(validation IN ('accepted','refused')),
    validated_at TEXT, created TEXT NOT NULL, source TEXT, feeder TEXT, unit TEXT,
    prompt TEXT, prompt_version INTEGER
  );
  CREATE TABLE prompts(hash TEXT PRIMARY KEY, version TEXT NOT NULL, text TEXT NOT NULL);
  CREATE TABLE requests(
    key TEXT PRIMARY KEY, family TEXT, feeder TEXT, unit TEXT NOT NULL, revision TEXT,
    model TEXT NOT NULL, effort TEXT NOT NULL, sampling TEXT, transport TEXT NOT NULL,
    prompt_hash TEXT NOT NULL REFERENCES prompts(hash), input_hash TEXT NOT NULL,
    body TEXT NOT NULL, attachments TEXT NOT NULL, requested TEXT NOT NULL,
    open INTEGER NOT NULL DEFAULT 0,
    prompt TEXT, prompt_version INTEGER
  );
  CREATE INDEX requests_unit ON requests(unit);
  CREATE INDEX requests_open ON requests(requested) WHERE open = 1;
  CREATE TABLE attempts(
    id INTEGER PRIMARY KEY, key TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('sending','replied','failed','unknown','settled')),
    started TEXT NOT NULL, finished TEXT, error TEXT,
    input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL,
    validation TEXT CHECK(validation IN ('accepted','refused')), settled TEXT,
    transport TEXT
  );
  CREATE INDEX attempts_key ON attempts(key, id);
  CREATE INDEX attempts_started ON attempts(started);
  CREATE INDEX attempts_finished ON attempts(finished);
  CREATE TABLE unit_failures(
    id INTEGER PRIMARY KEY, revision TEXT NOT NULL, family TEXT, unit TEXT NOT NULL,
    at TEXT NOT NULL, reason TEXT NOT NULL
  );
  CREATE INDEX unit_failures_revision ON unit_failures(revision);
  CREATE INDEX replies_lookup ON replies(prompt_hash, input_hash);
  CREATE INDEX replies_carried ON replies(invocation);
  CREATE INDEX requests_revision ON requests(revision);
  CREATE TABLE outcomes(seq INTEGER PRIMARY KEY AUTOINCREMENT, attempt INTEGER NOT NULL, key TEXT NOT NULL, state TEXT NOT NULL);
  CREATE TABLE paid(attempt INTEGER PRIMARY KEY, grant_id INTEGER NOT NULL, started TEXT NOT NULL);
  CREATE INDEX paid_grant ON paid(grant_id, started);
  CREATE TABLE request_schemas(key TEXT PRIMARY KEY, schema TEXT NOT NULL);
  CREATE INDEX requests_hashes ON requests(prompt_hash, input_hash);
  CREATE INDEX replies_versions ON replies(prompt, input_hash, prompt_version);
  CREATE INDEX requests_versions ON requests(prompt, input_hash, prompt_version);
  CREATE TABLE prompt_types(name TEXT NOT NULL, version INTEGER NOT NULL, type TEXT NOT NULL, first_ms INTEGER NOT NULL, PRIMARY KEY(name, version, type));
`;

const MIGRATIONS: readonly Migration[] = [
  (db) => db.exec(`DROP TABLE paid;
    DELETE FROM meta WHERE key IN ('steps', 'writer')`),
  (db) => db.exec(`CREATE TABLE prices(day TEXT NOT NULL, prompt TEXT NOT NULL, model TEXT NOT NULL, usd REAL NOT NULL, replies INTEGER NOT NULL,
      PRIMARY KEY(day, prompt, model));
    INSERT INTO prices(day, prompt, model, usd, replies)
      SELECT substr(a.finished, 1, 10), r.prompt, r.model, sum(a.cost_usd), count(*)
      FROM attempts a INDEXED BY attempts_finished JOIN requests r ON r.key = a.key
      WHERE a.finished >= strftime('%Y-%m-%d', 'now', '-${PRICE_DAYS} days') AND a.state = 'replied' AND a.cost_usd IS NOT NULL AND r.prompt IS NOT NULL
      GROUP BY 1, 2, 3`),
  (db) => db.exec(`CREATE TABLE placeholder_tables(scope TEXT PRIMARY KEY, next TEXT NOT NULL, version INTEGER NOT NULL);
    CREATE TABLE placeholder_entries(scope TEXT NOT NULL, placeholder TEXT NOT NULL, type TEXT NOT NULL, detail TEXT NOT NULL, key TEXT NOT NULL,
      word TEXT, who TEXT, shown TEXT, face TEXT, PRIMARY KEY (scope, placeholder));
    CREATE INDEX placeholder_entries_key ON placeholder_entries(scope, key);
    CREATE INDEX placeholder_entries_word ON placeholder_entries(scope, word) WHERE word IS NOT NULL;
    CREATE INDEX placeholder_entries_who ON placeholder_entries(scope, who) WHERE who IS NOT NULL;
    CREATE TABLE outbound(seq INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, receiver TEXT NOT NULL, route TEXT, by TEXT,
      what TEXT NOT NULL CHECK(what IN ('ask','read','text','link','lookup')), tool TEXT, level TEXT NOT NULL, counts TEXT NOT NULL,
      chars INTEGER NOT NULL, pictures INTEGER NOT NULL, detector TEXT, key TEXT, attempt INTEGER);
    CREATE INDEX outbound_at ON outbound(at_ms);
    CREATE INDEX outbound_key ON outbound(key) WHERE key IS NOT NULL;
    CREATE TABLE outbound_refs(outbound INTEGER NOT NULL, source TEXT, kind TEXT, key TEXT, day TEXT);
    CREATE INDEX outbound_refs_of ON outbound_refs(outbound);
    CREATE INDEX outbound_refs_record ON outbound_refs(source, kind, key) WHERE source IS NOT NULL;
    CREATE INDEX outbound_refs_day ON outbound_refs(day) WHERE day IS NOT NULL;
    CREATE TABLE sent_copies(id INTEGER PRIMARY KEY, key TEXT NOT NULL, receiver TEXT NOT NULL, route TEXT NOT NULL, level TEXT NOT NULL,
      body TEXT, pictures TEXT NOT NULL, counts TEXT NOT NULL, detector TEXT, written TEXT, at_ms INTEGER NOT NULL);
    CREATE INDEX sent_copies_key ON sent_copies(key);
    CREATE TABLE attempt_copies(attempt INTEGER PRIMARY KEY, copy INTEGER NOT NULL);
    CREATE INDEX attempt_copies_copy ON attempt_copies(copy);
    CREATE TRIGGER attempt_copies_go AFTER DELETE ON attempts BEGIN DELETE FROM attempt_copies WHERE attempt = old.id; END;
    CREATE TABLE reply_marks(key TEXT PRIMARY KEY, marks TEXT NOT NULL);
    CREATE TRIGGER reply_marks_go AFTER DELETE ON replies BEGIN DELETE FROM reply_marks WHERE key = old.key; END`),
  (db) => db.exec(`CREATE TABLE access(reader TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version >= 1), lines TEXT NOT NULL, covers TEXT NOT NULL, at_ms INTEGER NOT NULL);
    CREATE TABLE access_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, reader TEXT NOT NULL, version INTEGER NOT NULL,
      what TEXT NOT NULL CHECK(what IN ('granted','widened','narrowed','requested','allowed','declined','replaced','dropped','lapsed','joined','erased','removed')),
      by TEXT NOT NULL CHECK(by IN ('person','home','chat','agent')), device TEXT, request TEXT, lines TEXT, about TEXT);
    CREATE INDEX access_changes_reader ON access_changes(reader, seq);
    CREATE TABLE access_requests(id TEXT PRIMARY KEY, reader TEXT NOT NULL, at_ms INTEGER NOT NULL, want TEXT, want_key TEXT, reason TEXT NOT NULL, for_ms INTEGER,
      state TEXT NOT NULL CHECK(state IN ('open','allowed','declined','replaced','dropped','lapsed')), answered_ms INTEGER, device TEXT, told_ms INTEGER);
    CREATE INDEX access_requests_reader ON access_requests(reader, at_ms);
    CREATE UNIQUE INDEX access_requests_open ON access_requests(reader) WHERE state = 'open';
    CREATE TABLE access_moved(at_ms INTEGER NOT NULL);
    CREATE TRIGGER access_moved_once BEFORE INSERT ON access_moved WHEN EXISTS (SELECT 1 FROM access_moved) BEGIN SELECT RAISE(ABORT, 'the move is marked once'); END;
    CREATE TABLE calls(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, at_ms INTEGER NOT NULL, reader TEXT NOT NULL, session INTEGER NOT NULL,
      access_version INTEGER, tool TEXT NOT NULL, sent TEXT NOT NULL, read TEXT NOT NULL,
      result TEXT NOT NULL CHECK(result IN ('running','answered','refused','failed')), words TEXT, ms INTEGER, epoch INTEGER NOT NULL);
    CREATE INDEX calls_reader ON calls(reader, seq);
    CREATE TABLE call_withheld(call INTEGER NOT NULL, line TEXT NOT NULL, n INTEGER NOT NULL CHECK(n > 0), least INTEGER NOT NULL CHECK(least IN (0, 1)), PRIMARY KEY(call, line));
    CREATE TABLE outbound_calls(outbound INTEGER PRIMARY KEY, call INTEGER NOT NULL);
    CREATE INDEX outbound_calls_call ON outbound_calls(call)`),
  (db) => db.exec(`CREATE TABLE placeholder_levels(scope TEXT PRIMARY KEY, level TEXT NOT NULL CHECK(level IN ('all','names','none')))`),
  (db) => db.exec(`ALTER TABLE access_requests ADD COLUMN by TEXT NOT NULL DEFAULT 'agent' CHECK(by IN ('agent','chat'));
    UPDATE access_requests SET by = 'chat' WHERE id IN (SELECT request FROM access_changes WHERE what = 'requested' AND by != 'agent');
    DROP INDEX access_requests_open;
    CREATE UNIQUE INDEX access_requests_open ON access_requests(reader, by) WHERE state = 'open'`),
  (db) => db.exec(`CREATE TABLE call_came(call INTEGER PRIMARY KEY, came TEXT NOT NULL);
    CREATE TABLE unlisted(reader TEXT PRIMARY KEY, at_ms INTEGER NOT NULL);
    CREATE TABLE reader_reads(reader TEXT PRIMARY KEY, n INTEGER NOT NULL CHECK(n > 0), first_ms INTEGER NOT NULL, last_ms INTEGER NOT NULL);
    INSERT INTO reader_reads (reader, n, first_ms, last_ms) SELECT reader, count(*), min(at_ms), max(at_ms) FROM calls WHERE result = 'answered' AND tool NOT IN ('access', 'feedback') GROUP BY reader`),
  (db) => db.exec("CREATE INDEX calls_read ON calls(reader, at_ms) WHERE result = 'answered' AND tool NOT IN ('access', 'feedback')"),
  (db) => db.exec("CREATE TABLE call_code(call INTEGER PRIMARY KEY, code TEXT NOT NULL)"),
  (db) => db.exec(`CREATE TABLE reader_kinds(reader TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL CHECK(n > 0), PRIMARY KEY(reader, kind));
    INSERT INTO reader_kinds (reader, kind, n) SELECT c.reader, j.key, count(*) FROM calls c JOIN call_came k ON k.call = c.seq, json_each(k.came) j
      WHERE c.result = 'answered' AND c.tool NOT IN ('access', 'feedback') GROUP BY c.reader, j.key`),
  (db) => db.exec("CREATE TABLE call_opened(call INTEGER PRIMARY KEY)"),
  (db) => db.exec(`CREATE TABLE call_items(call INTEGER NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL,
      source TEXT, rkind TEXT, key TEXT, day TEXT, PRIMARY KEY(call, at)) WITHOUT ROWID;
    CREATE INDEX call_items_record ON call_items(source, rkind, key) WHERE source IS NOT NULL;
    CREATE INDEX call_items_day ON call_items(day) WHERE day IS NOT NULL;
    CREATE TRIGGER call_items_go AFTER DELETE ON calls BEGIN DELETE FROM call_items WHERE call = old.seq; END`),
  (db) => widenCheck(db, "outbound", "CHECK(what IN ('ask','read','text','link','lookup'))", "CHECK(what IN ('ask','read','text','link','lookup','feedback'))"),
  (db) => db.exec(`UPDATE requests SET transport = 'openrouter' WHERE transport = 'openrouter-voice';
    UPDATE attempts SET transport = 'openrouter' WHERE transport = 'openrouter-voice';
    UPDATE outbound SET route = 'openrouter:' || substr(route, 18) WHERE substr(route, 1, 17) = 'openrouter-voice:';
    UPDATE sent_copies SET route = 'openrouter:' || substr(route, 18) WHERE substr(route, 1, 17) = 'openrouter-voice:';
    DELETE FROM meta WHERE key = 'rest:openrouter-voice'`),
];

function widenCheck(db: Database.Database, table: string, was: string, now: string): void {
  const stored = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").pluck().get(table) as string | undefined;
  if (stored?.split(was).length !== 2) throw new Error(`${table} states ${was} not once, so it cannot be widened in place`);
  const version = db.pragma("schema_version", { simple: true }) as number;
  db.unsafeMode(true);
  try {
    db.pragma("writable_schema = ON");
    db.prepare("UPDATE sqlite_schema SET sql = ? WHERE type = 'table' AND name = ?").run(stored.replace(was, () => now), table);
    db.pragma(`schema_version = ${version + 1}`);
  } finally {
    db.pragma("writable_schema = OFF");
    db.unsafeMode(false);
  }
}

export const ledgerSchema = new Schema({
  name: "the ledger", file: "replies.db", base: 3, baseline: BASELINE, migrations: MIGRATIONS, small: ["meta", "prompts", "prompt_types", "prices", "access", "access_changes", "access_requests", "access_moved", "unlisted", "reader_reads", "reader_kinds"], indexed: [6, 7, 11, 15],
  foreignKeys: true,
});

const FIRST = "LEFT JOIN requests f ON f.key = r.revision LEFT JOIN replies c ON c.key = r.revision AND f.key IS NULL";
const REVISION = "coalesce(f.key, c.key, r.key)";
const began = (input: string) =>
  `coalesce(f.prompt, c.prompt, r.prompt) AS prompt, coalesce(f.prompt_version, c.prompt_version, r.prompt_version) AS version, coalesce(f.input_hash, c.input_hash, r.input_hash) AS ${input}`;
const CARRIED_ROOT = "NOT EXISTS (SELECT 1 FROM requests h WHERE h.key = c.key)";

const REQUEST = "key, family, unit, revision, model, effort, sampling, prompt_hash, input_hash, body, attachments, requested";
const replyOf = (as: string) => `${["key", "model", "prompt", "prompt_version", "prompt_hash", "input_hash", "effort", "sampling", "text", "validation", "cost_usd", "created"]
  .map((column) => `${as}.${column}`).join(", ")}, (SELECT m.marks FROM reply_marks m WHERE m.key = ${as}.key) AS marks`;
const REPLY = replyOf("replies");
const ATTEMPT = "id, key, state, started, finished, error";

export interface Conn {
  sql<R = unknown>(text: string): {
    get(...values: unknown[]): R | undefined;
    all(...values: unknown[]): R[];
    iterate(...values: unknown[]): IterableIterator<R>;
    run(...values: unknown[]): Database.RunResult;
  };
  write<T>(work: () => T): T;
}

export interface LedgerAttachment {
  kind: "image" | "audio";
  sha256: string;
  extension: string;
}

export interface NewRequest {
  key: string;
  family: string;
  unit: string;
  revision: string;
  model: string;
  effort: string;
  sampling?: Sampling;
  prompt: { name: string; version: number; text: string; type: AnswerType };
  input_hash: string;
  body: string;
  attachments: LedgerAttachment[];
  faces?: readonly Drawn[];
}

export interface RequestRow {
  key: string;
  family: string | null;
  unit: string;
  revision: string | null;
  model: string;
  effort: string;
  sampling: Sampling | null;
  prompt_hash: string;
  input_hash: string;
  body: string;
  attachments: LedgerAttachment[];
  requested_ms: number;
}

export interface StoredReply {
  key: string;
  model: string;
  prompt: string | null;
  version: number | null;
  prompt_hash: string;
  input_hash: string;
  effort: string | null;
  sampling: Sampling | null;
  text: string;
  validation: "accepted" | "refused" | null;
  cost_usd: number | null;
  created_ms: number;
  marks: Mark[];
  unknown: string[];
}

export type AttemptState = "sending" | "replied" | "failed" | "unknown" | "settled";

export interface AttemptRef {
  id: number;
  key: string;
}

interface AttemptRow {
  id: number;
  key: string;
  state: AttemptState;
  started_ms: number;
  finished_ms: number | null;
  error: string | null;
}

export type Readiness =
  | { ready: true }
  | { ready: false; why: "in-flight" }
  | { ready: false; why: "failed"; retry_ms: number; error: string };

export type Next =
  | { answered: string }
  | { givenUp: number }
  | { wait: Exclude<Readiness, { ready: true }> }
  | { send: string | null };

export interface InFlight {
  family: string | null;
  revision: string;
  transport: string | null;
  prompt: string | null;
  version: number | null;
  input_hash: string;
}

export interface Rates {
  pace(transport: string, model: string): number | null;
  price(prompt: string, model: string): number | null;
}

const PACE_MS = 10 * 60_000;
const PRICE_DAYS = 30;
const priceFrom = (now: number): string => iso(now - PRICE_DAYS * 86_400_000).slice(0, 10);

export interface Spent {
  calls: number;
  usd: number;
  unpriced: number;
}

export type RestCause = "limit" | "unavailable" | "provider";

export interface Rest {
  until_ms: number;
  resets_ms: number | null;
  cause: RestCause;
  reason: string;
}

export const LONGEST_REST_MS = 60 * 60_000;

export type Begun =
  | { attempt: AttemptRef; request: RequestRow }
  | { standing: StoredReply }
  | { refused: "unrequested" | "given-up" | "in-flight" | "failed" | "unsent"; detail: string };

export interface Usage {
  cost?: number;
  input_tokens?: number;
  output_tokens?: number;
}

export interface Landing extends Usage {
  text: string;
  model: string;
  transport: string;
  marks?: Mark[];
  written?: string;
  refused?: { unknown: string[]; reason: string };
  table?: { scope: string; next: PlaceholderTable["next"] };
}

export interface Outgoing {
  copy: number;
  outbound: Omit<NewOutbound, "key" | "attempt" | "refs">;
}

export interface Ledger {
  readonly path: string;
  request(request: NewRequest, now_ms: number): void;
  keep(bytes: Buffer): string;
  attachment(sha256: string): Buffer;
  row(key: string): RequestRow | undefined;
  text(prompt_hash: string): string | undefined;
  schema(key: string): string | null;
  chain(revision: string): RequestRow[];
  reply(key: string): StoredReply | undefined;
  standing(key: string): StoredReply | undefined;
  found(prompt: string, input_hash: string, versions: readonly number[], model?: string): StoredReply[];
  flying(prompt: string, versions: readonly number[], input_hash: string): string | undefined;
  tries(revision: string): number;
  lastFailure(revision: string): string | undefined;
  next(revision: string, now_ms: number, line?: "chat"): Next;
  inFlight(): InFlight[];
  beginAttempt(key: string, now_ms: number, transport: string, sending?: Outgoing, line?: "chat"): Begun;
  land(attempt: AttemptRef, landing: Landing, now_ms: number): boolean;
  fail(attempt: AttemptRef, error: string, now_ms: number, usage?: Usage): boolean;
  end(attempt: AttemptRef, on: string, rest: Rest, now_ms: number): boolean;
  yielded(attempt: AttemptRef, reason: string, now_ms: number): boolean;
  reap(now_ms: number): number;
  reapQuiet(now_ms: number, copies?: string): number | null;
  refuse(key: string, item: { family: string; unit: string }, reason: string, now_ms: number): boolean;
  accept(key: string, now_ms: number): void;
  promptTypes(): { name: string; version: number; type: AnswerType; first_ms: number }[];
  spend(since_ms: number, priced: readonly string[]): Map<string, Spent & { seconds: number; replied: number }>;
  rates(now_ms: number): Rates;
  rest(on: string, rest: Rest, now_ms: number): void;
  alone(on: string, key: string): boolean;
  resting(now_ms: number): Map<string, Rest>;
  forget(
    items: readonly string[], records?: readonly { source: string; kind: string; key: string }[], access?: { scrub: Scrub; at_ms: number }, days?: readonly string[],
  ): { requests: number; replies: number; attempts: number; attachments: number; access?: AccessErased };
  truncateLog(wait_ms: number): boolean;
  together<T>(work: () => T): T;
  readonly outbound: OutboundLog;
  readonly access: AccessLog;
  readonly placeholders: PlaceholderTables;
  readonly sent: SentCopies;
  dataVersion(): number;
  lastOutcome(): number;
  outcomesAfter(seq: number, limit: number): Outcome[];
  answered(family: string, item: string, key: string | null): boolean;
  close(): void;
}

export interface Outcome {
  seq: number;
  attempt: number;
  key: string;
  state: AttemptState;
  family: string | null;
  item: string;
  revision: string;
  prompt: string | null;
  version: number | null;
  input_hash: string;
}

export const LEDGER_MIGRATED = "LEDGER_MIGRATED";

export const LEDGER_STORE: StoreKind = { role: "ledger", remade: false };

export function ledgerFileOf(root: string): string {
  return join(root, "replies", LEDGER_DB);
}

export function openLedger(folder: HomeFolder, options: { mode: OpenMode; log?: SchemaLog }): Ledger {
  const { mode } = options;
  const path = ledgerFileOf(folder.root);
  if (mode === "migrate") makeUnder(folder.root, dirname(path));
  let db: Database.Database | undefined;
  try {
    db = folder.store(LEDGER_STORE, path, mode === "read" ? { mode: "read", mustExist: true, timeout: 5_000 } : { mustExist: mode === "write" });
    ledgerSchema.open(db, mode, options.log);
    return ledgerOver(db, path, folder);
  } catch (error) {
    db?.close();
    throw homeError(error, LEDGER_DB);
  }
}

function on<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw homeError(error, LEDGER_DB);
  }
}

function ledgerOver(db: Database.Database, path: string, folder: HomeFolder): Ledger {
  const attachments = join(dirname(path), "blobs");
  let writing: BlobStore | undefined;
  let reading: BlobStore | undefined;
  const blobs = (write: boolean): BlobStore => (write ? (writing ??= folder.blobs(attachments)) : (writing ?? (reading ??= folder.blobs(attachments, { reading: true }))));
  const sql = <R>(text: string) => {
    const statement = on(() => db.prepare(text));
    return {
      get: (...values: unknown[]) => on(() => statement.get(...values) as R | undefined),
      all: (...values: unknown[]) => on(() => statement.all(...values) as R[]),
      iterate: (...values: unknown[]) => marked(on(() => statement.iterate(...values) as IterableIterator<R>)),
      run: (...values: unknown[]) => on(() => statement.run(...values)),
    };
  };
  const version = on(() => db.prepare("SELECT user_version FROM pragma_user_version").pluck());
  const write = <T>(work: () => T): T => on(() => db.transaction(() => {
    const now = version.get() as number;
    if (now !== ledgerSchema.latest) {
      throw Object.assign(new Error(`the ledger is at version ${now} since this connection opened it at ${ledgerSchema.latest}: a newer release's home migrated it`), { code: LEDGER_MIGRATED });
    }
    return work();
  }).immediate());
  const conn: Conn = { sql: <R>(text: string) => sql<R>(text), write };
  const hidings = outboundOver(conn);
  const placeholders = placeholdersOver(conn, hidings.insert);
  const sent = sentOver(conn, folder, join(dirname(path), "sent"), {
    save: (read, answered) => placeholders.tables.save(read, answered), epoch: () => placeholders.tables.epoch(),
  });
  const access = accessLogOver(conn, () => placeholders.tables.epoch().epoch);
  const counters = (scope: string, next: PlaceholderTable["next"]): Saved => {
    const part = placeholders.tables.part(scope, wantedOf([]));
    const moved: Record<string, number> = { ...part.table.next };
    for (const [type, at] of Object.entries(next)) moved[type] = Math.max(moved[type] ?? 0, at ?? 0);
    return placeholders.tables.save(part, { ...part.table, next: moved });
  };

  const requestRow = (row: Record<string, unknown> | undefined): RequestRow | undefined => row === undefined ? undefined : {
    key: String(row.key), family: nullable(row.family), unit: String(row.unit), revision: nullable(row.revision),
    model: String(row.model), effort: String(row.effort),
    sampling: row.sampling === null ? null : JSON.parse(String(row.sampling)) as Sampling,
    prompt_hash: String(row.prompt_hash), input_hash: String(row.input_hash),
    body: String(row.body), attachments: JSON.parse(String(row.attachments)) as LedgerAttachment[],
    requested_ms: ms(row.requested),
  };
  const replyRow = (row: Record<string, unknown> | undefined): StoredReply | undefined => row === undefined ? undefined : {
    key: String(row.key), model: String(row.model), prompt: nullable(row.prompt),
    version: row.prompt_version === null || row.prompt_version === undefined ? null : Number(row.prompt_version),
    prompt_hash: String(row.prompt_hash), input_hash: String(row.input_hash),
    effort: nullable(row.effort), sampling: row.sampling === null || row.sampling === undefined ? null : JSON.parse(String(row.sampling)) as Sampling,
    text: String(row.text), validation: row.validation as StoredReply["validation"],
    cost_usd: row.cost_usd === null ? null : Number(row.cost_usd), created_ms: ms(row.created),
    ...kept(row.marks),
  };
  const attemptRow = (row: Record<string, unknown> | undefined): AttemptRow | undefined => row === undefined ? undefined : {
    id: Number(row.id), key: String(row.key), state: row.state as AttemptState, started_ms: ms(row.started),
    finished_ms: row.finished === null ? null : ms(row.finished), error: nullable(row.error),
  };

  const selectRequest = sql<Record<string, unknown>>(`SELECT ${REQUEST} FROM requests WHERE key = ?`);
  const selectChain = sql<Record<string, unknown>>(`SELECT ${REQUEST} FROM requests WHERE revision = ? ORDER BY rowid`);
  const selectReply = sql<Record<string, unknown>>(`SELECT ${REPLY} FROM replies WHERE key = ?`);
  const selectStanding = sql<Record<string, unknown>>(`SELECT ${REPLY} FROM replies WHERE key = ? AND (validation IS NULL OR validation = 'accepted')`);
  const replied = replyOf("p");
  const selectFound = sql<Record<string, unknown>>(`
    SELECT ${REPLY} FROM replies
      WHERE prompt = @prompt AND input_hash = @input AND prompt_version IN (SELECT value FROM json_each(@versions))
        AND (validation IS NULL OR validation = 'accepted') AND (@model IS NULL OR model = @model)
    UNION ALL
    SELECT ${replied}
      FROM requests f JOIN requests r ON r.revision = f.key AND r.key <> f.key JOIN replies p ON p.key = r.key
      WHERE f.prompt = @prompt AND f.input_hash = @input AND f.prompt_version IN (SELECT value FROM json_each(@versions))
        AND (p.validation IS NULL OR p.validation = 'accepted') AND (@model IS NULL OR p.model = @model)
    UNION ALL
    SELECT ${replied}
      FROM replies c JOIN requests r ON r.revision = c.key AND r.key <> c.key JOIN replies p ON p.key = r.key
      WHERE c.prompt = @prompt AND c.input_hash = @input AND c.prompt_version IN (SELECT value FROM json_each(@versions)) AND ${CARRIED_ROOT}
        AND (p.validation IS NULL OR p.validation = 'accepted') AND (@model IS NULL OR p.model = @model)
    ORDER BY prompt_version DESC, created DESC`);
  const selectFlying = sql<{ revision: string }>(`
    SELECT f.key AS revision FROM requests f JOIN attempts a ON a.key = f.key
      WHERE f.prompt = @prompt AND f.input_hash = @input AND f.prompt_version IN (SELECT value FROM json_each(@versions)) AND a.state = 'sending'
    UNION ALL
    SELECT f.key FROM requests f JOIN requests r ON r.revision = f.key AND r.key <> f.key JOIN attempts a ON a.key = r.key
      WHERE f.prompt = @prompt AND f.input_hash = @input AND f.prompt_version IN (SELECT value FROM json_each(@versions)) AND a.state = 'sending'
    UNION ALL
    SELECT c.key FROM replies c JOIN requests r ON r.revision = c.key AND r.key <> c.key JOIN attempts a ON a.key = r.key
      WHERE c.prompt = @prompt AND c.input_hash = @input AND c.prompt_version IN (SELECT value FROM json_each(@versions)) AND ${CARRIED_ROOT}
        AND a.state = 'sending'
    LIMIT 1`);
  const selectFirst = sql<{ prompt: string | null; version: number | null; input: string }>(`
    SELECT ${began("input")} FROM requests r ${FIRST} WHERE r.key = ?`);
  const selectNewestAttempt = sql<Record<string, unknown>>(`SELECT ${ATTEMPT} FROM attempts WHERE key = ? ORDER BY id DESC LIMIT 1`);
  const countTries = sql<{ tries: number }>("SELECT count(*) AS tries FROM unit_failures WHERE revision = ?");
  const readiness = (key: string, now: number, line?: "chat"): Readiness => ready(attemptRow(selectNewestAttempt.get(key)), now, line);

  const tries = (revision: string | null) => revision === null ? 0 : countTries.get(revision)!.tries;
  const selectLastFailure = sql<{ reason: string }>("SELECT reason FROM unit_failures WHERE revision = ? ORDER BY id DESC LIMIT 1");

  const insertPrompt = sql("INSERT OR IGNORE INTO prompts(hash, version, text) VALUES (?, ?, ?)");
  const insertRequest = sql(`INSERT INTO requests(key, family, feeder, unit, revision, model, effort, sampling, transport,
      prompt_hash, input_hash, body, attachments, requested, prompt, prompt_version) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO NOTHING`);
  const insertType = sql("INSERT OR IGNORE INTO prompt_types(name, version, type, first_ms) VALUES (?, ?, ?, ?)");
  const writeRequest = (request: NewRequest, now: number) => {
    const { prompt } = request;
    const hash = promptHash(prompt.text);
    insertPrompt.run(hash, prompt.name, prompt.text);
    const written = insertRequest.run(request.key, request.family, request.unit, request.revision, request.model, request.effort,
      request.sampling === undefined ? null : JSON.stringify(request.sampling), hash,
      request.input_hash, request.body, JSON.stringify(request.attachments), iso(now), prompt.name, prompt.version);
    if (written.changes === 0) return;
    if (request.faces !== undefined && request.faces.length > 0) placeholders.startFaces(`ask:${request.revision}`, request.faces);
    if (prompt.type !== "text") insertSchema.run(request.key, canonical(prompt.type));
    insertType.run(prompt.name, prompt.version, canonical(bare(prompt.type)), now);
  };
  const insertFailure = sql("INSERT INTO unit_failures(revision, family, unit, at, reason) VALUES (?, ?, ?, ?, ?)");
  const selectRevision = sql<{ revision: string }>(`SELECT coalesce((SELECT ${REVISION} FROM requests r ${FIRST} WHERE r.key = ?), ?) AS revision`);
  const revisionOf = (key: string): string => selectRevision.get(key, key)!.revision;
  const finish = sql(`UPDATE attempts SET state = ?, finished = ?, error = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?
    WHERE id = ? AND key = ?`);

  const nextAttemptId = sql<{ id: number }>(`SELECT max(coalesce((SELECT max(id) FROM attempts), 0),
    coalesce((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'attempts_issued'), 0)) + 1 AS id`);
  const noteAttemptId = sql("INSERT OR REPLACE INTO meta(key, value) VALUES ('attempts_issued', ?)");
  const insertAttempt = sql("INSERT INTO attempts(id, key, state, started, transport) VALUES (?, ?, 'sending', ?, ?)");
  const insertAttemptCopy = sql("INSERT INTO attempt_copies(attempt, copy) VALUES (?, ?)");
  const putMarks = sql("INSERT OR REPLACE INTO reply_marks(key, marks) VALUES (?, ?)");
  const dropMarks = sql("DELETE FROM reply_marks WHERE key = ?");
  const copyOfAttempt = sql<{ sent_copy: number | null }>("SELECT c.copy AS sent_copy FROM attempts a JOIN attempt_copies c ON c.attempt = a.id WHERE a.id = ? AND a.key = ?");
  const noteOutcome = sql("INSERT INTO outcomes(attempt, key, state) VALUES (?, ?, ?)");
  const insertSchema = sql("INSERT OR IGNORE INTO request_schemas(key, schema) VALUES (?, ?)");
  const selectAttempt = sql<Record<string, unknown>>(`SELECT ${ATTEMPT} FROM attempts WHERE id = ? AND key = ?`);
  const addPrice = sql(`INSERT INTO prices(day, prompt, model, usd, replies) SELECT ?, prompt, model, ?, 1 FROM requests WHERE key = ? AND prompt IS NOT NULL
    ON CONFLICT(day, prompt, model) DO UPDATE SET usd = usd + excluded.usd, replies = replies + 1`);
  const prunePrices = sql("DELETE FROM prices WHERE day < ?");
  const selectRest = sql<{ value: string }>("SELECT value FROM meta WHERE key = ?");
  const writeRest = sql("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)");
  const restAt = (on: string, now: number): Rest | undefined => {
    const stored = storedRest(selectRest.get(`rest:${on}`)?.value);
    if (stored === undefined) return undefined;
    const { until_ms, resets_ms, cause, reason } = stored;
    return { until_ms, resets_ms: resets_ms === null || resets_ms > now ? resets_ms : null, cause, reason };
  };
  const clearReset = sql(`UPDATE meta SET value = json_set(value, '$.resets_ms', NULL)
    WHERE key = ? AND json_extract(value, '$.resets_ms') IS NOT NULL`);
  const selectSending = sql<{ id: number; key: string }>("SELECT id, key FROM attempts INDEXED BY attempts_finished WHERE finished IS NULL AND state = 'sending' ORDER BY id");
  const stillSending = (attempt: AttemptRef) => selectAttempt.get(attempt.id, attempt.key)?.state === "sending";
  const ended = (attempt: AttemptRef, state: "failed" | "unknown", error: string, now: number, usage: Usage) => {
    finish.run(state, iso(now), error, usage.input_tokens ?? null, usage.output_tokens ?? null, usage.cost ?? null, attempt.id, attempt.key);
    noteOutcome.run(attempt.id, attempt.key, state);
    const copy = copyOfAttempt.get(attempt.id, attempt.key)?.sent_copy ?? null;
    if (copy !== null) sent.ended(copy);
  };
  const failed = (attempt: AttemptRef, error: string, now: number, usage: Usage) => {
    const reason = bounded(error);
    ended(attempt, "failed", reason, now, usage);
    const request = requestRow(selectRequest.get(attempt.key));
    if (request !== undefined) insertFailure.run(revisionOf(attempt.key), request.family, request.unit, iso(now), reason);
  };
  const endDead = (attempts: readonly AttemptRef[], now: number): number => write(() => {
    let count = 0;
    for (const attempt of attempts) {
      if (!stillSending(attempt)) continue;
      failed(attempt, DIED, now, {});
      count++;
    }
    return count;
  });
  const repliedSince = (transport: string, since: number) => sql(`SELECT 1 FROM attempts
    WHERE transport = ? AND state = 'replied' AND finished >= ? LIMIT 1`).get(transport, iso(since)) !== undefined;
  const putRest = (on: string, rest: Rest, now: number, by?: string, limited = false) => {
    const asked = { ...rest, reason: bounded(rest.reason), until_ms: Math.min(rest.until_ms, now + LONGEST_REST_MS) };
    const standing = storedRest(selectRest.get(`rest:${on}`)?.value);
    const kept = standing !== undefined && standing.until_ms > asked.until_ms ? standing : { ...asked, length_ms: asked.until_ms - now, limited };
    const ahead = standing?.resets_ms !== null && standing?.resets_ms !== undefined && standing.resets_ms > now ? standing.resets_ms : null;
    const resets_ms = (rest.resets_ms !== null && rest.resets_ms > now ? rest.resets_ms : null) ?? ahead;
    writeRest.run(`rest:${on}`, JSON.stringify({
      until_ms: kept.until_ms, resets_ms, cause: kept.cause, reason: kept.reason, at_ms: now, length_ms: kept.length_ms, limited: kept.limited,
      ...(by === undefined ? {} : { key: by }),
    }));
  };

  return {
    path,

    request(request, now) {
      write(() => writeRequest(request, now));
    },

    keep(bytes) {
      return blobs(true).put(bytes).slice("sha256:".length);
    },

    attachment(sha256) {
      const kept = blobs(false);
      try {
        return kept.bytes(`sha256:${sha256}`);
      } catch (error) {
        if (!(error instanceof BlobError) || error.code !== "BLOB_CORRUPT") throw error;
        kept.remove(`sha256:${sha256}`);
        throw new Error(`attachment ${sha256} was torn and is removed`, { cause: error });
      }
    },

    row: (key) => requestRow(selectRequest.get(key)),
    text: (hash) => sql<{ text: string }>("SELECT text FROM prompts WHERE hash = ?").get(hash)?.text,
    schema: (key) => (sql<{ schema: string }>("SELECT schema FROM request_schemas WHERE key = ?").get(key))?.schema ?? null,
    chain: (revision) => selectChain.all(revision).map((row) => requestRow(row)!),
    reply: (key) => replyRow(selectReply.get(key)),
    standing: (key) => replyRow(selectStanding.get(key)),

    found: (prompt, input, versions, model) => selectFound.all({ prompt, input, versions: JSON.stringify(versions), model: model ?? null }).map((row) => replyRow(row)!),

    flying: (prompt, versions, input) => selectFlying.get({ prompt, versions: JSON.stringify(versions), input })?.revision,

    tries,

    lastFailure: (revision) => selectLastFailure.get(revision)?.reason,

    next(revision, now, line) {
      const chain = selectChain.all(revision).map((row) => requestRow(row)!);
      for (const key of [revision, ...chain.map((row) => row.key)]) if (selectStanding.get(key) !== undefined) return { answered: key };
      const tried = tries(revision);
      if (tried >= TRIES) return { givenUp: tried };
      const current = chain.at(-1) ?? requestRow(selectRequest.get(revision));
      if (current === undefined || replyRow(selectReply.get(current.key))?.validation === "refused") return { send: null };
      const ready = readiness(current.key, now, line);
      return ready.ready ? { send: current.key } : { wait: ready };
    },

    inFlight() {
      return sql<InFlight>(`SELECT r.family, ${REVISION} AS revision, a.transport,
          ${began("input_hash")}
          FROM attempts a INDEXED BY attempts_finished JOIN requests r ON r.key = a.key ${FIRST}
          WHERE a.finished IS NULL AND a.state = 'sending'`).all();
    },

    beginAttempt(key, now, transport, sending, line) {
      return write((): Begun => {
        const request = requestRow(selectRequest.get(key));
        if (request === undefined) return { refused: "unrequested", detail: `no request under ${key}` };
        const standing = replyRow(selectStanding.get(key));
        if (standing !== undefined) return { standing };
        const ready = readiness(key, now, line);
        if (!ready.ready) {
          const detail = ready.why === "in-flight" ? `request ${key} has an attempt in flight` : `request ${key} failed; it is sent again at ${iso(ready.retry_ms)}`;
          return { refused: ready.why, detail };
        }
        const first = selectFirst.get(key)!;
        const flying = selectFlying.get({ prompt: first.prompt, versions: JSON.stringify([first.version]), input: first.input });
        if (flying !== undefined) return { refused: "in-flight", detail: `request ${key} asks what the call of ${flying.revision} in flight asks` };
        if (tries(revisionOf(key)) >= TRIES) return { refused: "given-up", detail: `request ${key} is for a revision that failed ${TRIES} tries` };
        if (sending !== undefined && sent.copies.get(sending.copy)?.key !== key) return { refused: "unsent", detail: `request ${key} has no sent copy ${sending.copy}` };
        const { id } = nextAttemptId.get()!;
        insertAttempt.run(id, key, iso(now), transport);
        if (sending !== undefined) insertAttemptCopy.run(id, sending.copy);
        noteAttemptId.run(id);
        if (sending !== undefined) hidings.insert({ ...sending.outbound, key, attempt: id });
        return { attempt: { id, key }, request };
      });
    },

    land(attempt, landing, now) {
      return write(() => {
        const before = selectAttempt.get(attempt.id, attempt.key)?.state;
        if (before !== "sending" && before !== "failed") return false;
        if (landing.table !== undefined && !("saved" in counters(landing.table.scope, landing.table.next))) return false;
        const request = requestRow(selectRequest.get(attempt.key))!;
        const standing = selectStanding.get(attempt.key) !== undefined;
        if (!standing) {
          const marks = (landing.marks?.length ?? 0) === 0 && landing.refused === undefined ? null
            : JSON.stringify({ marks: landing.marks ?? [], ...(landing.refused === undefined ? {} : { unknown: landing.refused.unknown }) });
          sql(`INSERT OR REPLACE INTO replies(key, model, prompt, prompt_version, prompt_hash, input_hash, effort, sampling, output_schema, text,
              reply_model, invocation, runtime, input_tokens, output_tokens, cost_usd, validation, validated_at, created,
              source, feeder, unit) SELECT ?, ?, prompt, prompt_version, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?
              FROM requests WHERE key = ?`)
            .run(attempt.key, request.model, request.prompt_hash, request.input_hash, request.effort,
              request.sampling === null ? null : JSON.stringify(request.sampling), landing.text, landing.model,
              `${landing.transport} send`, landing.transport, landing.input_tokens ?? null, landing.output_tokens ?? null,
              landing.cost ?? null, iso(now), request.unit, attempt.key);
          if (marks === null) dropMarks.run(attempt.key);
          else putMarks.run(attempt.key, marks);
        }
        finish.run("replied", iso(now), null, landing.input_tokens ?? null, landing.output_tokens ?? null, landing.cost ?? null, attempt.id, attempt.key);
        if (landing.cost !== undefined) {
          addPrice.run(iso(now).slice(0, 10), landing.cost, attempt.key);
          prunePrices.run(priceFrom(now));
        }
        noteOutcome.run(attempt.id, attempt.key, "replied");
        const copy = copyOfAttempt.get(attempt.id, attempt.key)?.sent_copy ?? null;
        if (copy !== null) sent.landed(copy, landing.written ?? landing.text);
        if (landing.refused !== undefined && !standing) {
          sql("UPDATE replies SET validation = 'refused', validated_at = ? WHERE key = ?").run(iso(now), attempt.key);
          sql("UPDATE attempts SET validation = 'refused' WHERE id = ? AND key = ?").run(attempt.id, attempt.key);
          insertFailure.run(revisionOf(attempt.key), request.family, request.unit, iso(now), bounded(landing.refused.reason));
        }
        clearReset.run(`rest:${landing.transport}`);
        return true;
      });
    },

    fail(attempt, error, now, usage = {}) {
      return write(() => {
        if (!stillSending(attempt)) return false;
        failed(attempt, error, now, usage);
        return true;
      });
    },

    end(attempt, on, rest, now) {
      return write(() => {
        if (!stillSending(attempt)) return false;
        ended(attempt, "unknown", bounded(rest.reason), now, {});
        if (rest.cause !== "limit" || rest.resets_ms !== null) {
          putRest(on, rest, now, attempt.key);
          return true;
        }
        const standing = storedRest(selectRest.get(`rest:${on}`)?.value);
        if (standing?.limited === true && standing.until_ms > now) return true;
        const twice = standing?.limited === true && !repliedSince(on.split(":", 1)[0]!, standing.until_ms - standing.length_ms);
        const length = twice ? Math.min(2 * standing.length_ms, LONGEST_REST_MS) : rest.until_ms - now;
        putRest(on, { ...rest, until_ms: now + length }, now, attempt.key, true);
        return true;
      });
    },

    yielded(attempt, reason, now) {
      return write(() => {
        if (!stillSending(attempt)) return false;
        ended(attempt, "unknown", bounded(reason), now, {});
        return true;
      });
    },

    reap(now) {
      let count = 0;
      for (const attempt of selectSending.all()) {
        const file = callLock(folder, attempt.key);
        const lock = existsSync(file) ? tryLock(file) : undefined;
        if (lock === null) continue;
        try {
          count += endDead([attempt], now);
        } finally {
          lock?.release();
        }
      }
      return count;
    },

    reapQuiet(now, copies) {
      const calls = tryLock(callsLock(path));
      if (calls === null) return null;
      try {
        const count = endDead(selectSending.all(), now);
        rmSync(join(dirname(path), CALLS), { recursive: true, force: true });
        folder.emptyWork({ program: "call", plain: copies });
        return count;
      } finally {
        calls.release();
      }
    },

    refuse(key, item, reason, now) {
      return write(() => {
        const reply = replyRow(selectReply.get(key));
        if (reply === undefined) throw new Error(`no reply under ${key}`);
        if (reply.validation === "refused") return false;
        sql("UPDATE replies SET validation = 'refused', validated_at = ? WHERE key = ?").run(iso(now), key);
        sql("UPDATE attempts SET validation = 'refused' WHERE id = (SELECT max(id) FROM attempts WHERE key = ? AND state = 'replied')").run(key);
        insertFailure.run(revisionOf(key), item.family, item.unit, iso(now), bounded(reason));
        return true;
      });
    },

    accept(key, now) {
      write(() => {
        sql("UPDATE replies SET validation = 'accepted', validated_at = ? WHERE key = ? AND validation IS NULL").run(iso(now), key);
        sql(`UPDATE attempts SET validation = 'accepted' WHERE validation IS NULL
            AND id = (SELECT max(id) FROM attempts WHERE key = ? AND state = 'replied')`).run(key);
      });
    },

    promptTypes: () => sql<{ name: string; version: number; type: string; first_ms: number }>("SELECT name, version, type, first_ms FROM prompt_types ORDER BY name, version, first_ms")
      .all().map((row) => ({ ...row, type: JSON.parse(row.type) as AnswerType })),

    spend(since, priced) {
      const spend = new Map<string, Spent & { seconds: number; replied: number }>();
      for (const row of sql<{ family: string } & Spent & { seconds: number; replied: number }>(`SELECT r.family AS family,
          coalesce(sum(a.cost_usd), 0) AS usd, count(*) AS calls,
          coalesce(sum(a.cost_usd IS NULL AND (a.state = 'replied'
            OR (a.state IN ('failed', 'unknown') AND a.transport IN (${priced.map(() => "?").join(", ")})))), 0) AS unpriced,
          coalesce(sum(CASE WHEN a.state = 'replied' THEN (julianday(a.finished) - julianday(a.started)) * 86400 END), 0) AS seconds,
          coalesce(sum(a.state = 'replied'), 0) AS replied
          FROM attempts a JOIN requests r ON r.key = a.key WHERE a.started >= ? AND r.family IS NOT NULL GROUP BY r.family`).iterate(...priced, iso(since))) {
        const { family, ...spent } = row;
        spend.set(family, spent);
      }
      return spend;
    },

    rates(now) {
      const paces = new Map<string, number>();
      for (const row of sql<{ transport: string | null; model: string; replies: number }>(`SELECT a.transport AS transport, r.model AS model, count(*) AS replies
          FROM attempts a INDEXED BY attempts_finished JOIN requests r ON r.key = a.key
          WHERE a.finished >= ? AND a.state = 'replied' GROUP BY a.transport, r.model`).iterate(iso(now - PACE_MS))) {
        paces.set(`${row.transport}\0${row.model}`, row.replies / (PACE_MS / 60_000));
      }
      const prices = new Map<string, number>();
      for (const row of sql<{ prompt: string; model: string; usd: number }>(`SELECT prompt, model, sum(usd) / sum(replies) AS usd
          FROM prices WHERE day >= ? GROUP BY prompt, model`).iterate(priceFrom(now))) {
        prices.set(`${row.prompt}\0${row.model}`, row.usd);
      }
      return {
        pace: (transport, model) => paces.get(`${transport}\0${model}`) ?? null,
        price: (prompt, model) => prices.get(`${prompt}\0${model}`) ?? null,
      };
    },

    rest(on, rest, now) {
      write(() => putRest(on, rest, now));
    },

    alone(on, key) {
      const rest = selectRest.get(`rest:${on}`);
      const by = rest === undefined ? undefined : JSON.parse(rest.value) as { key?: string; at_ms?: number };
      const transport = on.split(":", 1)[0]!;
      return by?.key === key && sql(`SELECT 1 FROM attempts
        WHERE transport = ? AND state = 'replied' AND key <> ? AND finished >= ? LIMIT 1`).get(transport, key, iso(by.at_ms!)) !== undefined;
    },

    resting(now) {
      const resting = new Map<string, Rest>();
      for (const { key } of sql<{ key: string }>("SELECT key FROM meta WHERE key LIKE 'rest:%'").all()) {
        const on = key.slice("rest:".length);
        const rest = restAt(on, now);
        if (rest !== undefined && rest.until_ms > now) resting.set(on, rest);
      }
      return resting;
    },

    outbound: hidings.log,
    together: (work) => write(work),
    access: access.log,
    placeholders: placeholders.tables,
    sent: sent.copies,

    forget(items, records = [], erasure, days = []) {
      const counts: { requests: number; replies: number; attempts: number; attachments: number; access?: AccessErased } = { requests: 0, replies: 0, attempts: 0, attachments: 0 };
      on(() => db.pragma("secure_delete = ON"));
      try {
        write(() => {
          const files = new Set<string>();
          const keys = new Set<string>();
          const dropReply = sql("DELETE FROM replies WHERE key = ?");
          const carriedTo = sql<{ key: string }>("SELECT key FROM replies WHERE invocation = ?");
          const drop = (key: string) => {
            for (const carried of carriedTo.all(`carry ${key}`)) counts.replies += dropReply.run(carried.key).changes;
            counts.replies += dropReply.run(key).changes;
          };
          const attachmentsOf = sql<{ attachments: string }>("SELECT attachments FROM requests WHERE key = ?");
          const dropAttempts = sql("DELETE FROM attempts WHERE key = ?");
          const dropSchema = sql("DELETE FROM request_schemas WHERE key = ?");
          const dropRow = sql("DELETE FROM requests WHERE key = ?");
          const requestsOf = sql<{ key: string }>("SELECT key FROM requests WHERE unit = ?");
          const dropFailures = sql("DELETE FROM unit_failures WHERE unit = ?");
          const dropRequest = (key: string) => {
            const request = attachmentsOf.get(key);
            counts.attempts += dropAttempts.run(key).changes;
            dropSchema.run(key);
            drop(key);
            counts.requests += dropRow.run(key).changes;
            keys.add(key);
            for (const file of request === undefined ? [] : JSON.parse(request.attachments) as LedgerAttachment[]) files.add(file.sha256);
          };
          const wanted = new Set(items);
          const repliesOf = new Map<string, { key: string; invocation: string | null }[]>();
          for (const { key, invocation, unit } of sql<{ key: string; invocation: string | null; unit: string }>("SELECT key, invocation, unit FROM replies WHERE unit IS NOT NULL").iterate()) {
            if (!wanted.has(unit)) continue;
            const replies = repliesOf.get(unit) ?? [];
            replies.push({ key, invocation });
            repliesOf.set(unit, replies);
          }
          for (const item of wanted) {
            const replies = repliesOf.get(item) ?? [];
            const origins = replies.flatMap(({ invocation }) => (invocation?.startsWith("carry ") === true ? [invocation.slice("carry ".length)] : []));
            for (const { key } of requestsOf.all(item)) dropRequest(key);
            for (const key of origins) dropRequest(key);
            for (const { key } of replies) drop(key);
            dropFailures.run(item);
          }
          sql("DELETE FROM outcomes WHERE key IN (SELECT value FROM json_each(?))").run(JSON.stringify([...keys]));
          if (erasure !== undefined) counts.access = access.forgetIn(erasure.scrub, erasure.at_ms);
          hidings.forgetKeys(keys);
          hidings.forgetRecords(records);
          access.forgetItems(records, days);
          placeholders.forget(keys);
          sent.forget(keys);
          const named = sql("SELECT 1 FROM requests WHERE instr(attachments, ?) > 0 LIMIT 1");
          const unnamed = [...files].filter((sha256) => named.get(sha256) === undefined);
          const removed = new Set<string>();
          const kept = blobs(false);
          for (const sha256 of unnamed) {
            removed.add(kept.directory(`sha256:${sha256}`));
            if (kept.remove(`sha256:${sha256}`)) counts.attachments++;
          }
          for (const directory of removed) if (existsSync(directory)) flush(directory);
        });
      } finally {
        on(() => db.pragma("secure_delete = FAST"));
      }
      return counts;
    },

    truncateLog(wait) {
      return on(() => {
        const before = db.pragma("busy_timeout", { simple: true }) as number;
        db.pragma(`busy_timeout = ${Math.max(0, Math.floor(wait))}`);
        try {
          const [row] = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
          return row!.busy === 0;
        } finally {
          db.pragma(`busy_timeout = ${before}`);
        }
      });
    },

    dataVersion: () => on(() => db.pragma("data_version", { simple: true }) as number),

    lastOutcome: () => sql<{ seq: number }>("SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'outcomes'), 0) AS seq").get()!.seq,

    outcomesAfter(seq, limit) {
      return sql<Outcome>(`SELECT o.seq, o.attempt, o.key, o.state, r.family, r.unit AS item, ${REVISION} AS revision,
          ${began("input_hash")}
          FROM outcomes o JOIN requests r ON r.key = o.key ${FIRST}
          WHERE o.seq > ? ORDER BY o.seq LIMIT ?`).all(seq, limit);
    },

    answered(family, item, key) {
      if (key !== null && (sql("SELECT 1 FROM attempts WHERE key = ? AND finished IS NOT NULL LIMIT 1").get(key) !== undefined || selectReply.get(key) !== undefined)) return true;
      return sql(`SELECT 1 FROM requests r JOIN attempts a ON a.key = r.key
          WHERE r.unit = ? AND r.family = ? AND a.finished IS NOT NULL LIMIT 1`).get(item, family) !== undefined;
    },

    close: () => on(() => db.close()),
  };
}

function* marked<R>(rows: IterableIterator<R>): IterableIterator<R> {
  try {
    for (;;) {
      const next = on(() => rows.next());
      if (next.done === true) return;
      yield next.value;
    }
  } finally { rows.return?.(); }
}

function ready(newest: AttemptRow | undefined, now: number, line?: "chat"): Readiness {
  if (newest?.state === "sending") return { ready: false, why: "in-flight" };
  if (newest?.state === "failed" && line !== "chat") {
    const retry_ms = newest.finished_ms! + RETRY_AFTER_MS;
    if (now < retry_ms) return { ready: false, why: "failed", retry_ms, error: newest.error ?? "the send failed" };
  }
  return { ready: true };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function ms(text: unknown): number {
  return instant(String(text), "rfc3339").start_ms;
}

interface StoredRest extends Rest {
  length_ms: number;
  limited: boolean;
}

function storedRest(value: string | undefined): StoredRest | undefined {
  if (value === undefined) return undefined;
  const rest = JSON.parse(value) as { until_ms: number; resets_ms?: number | null; cause?: Rest["cause"]; reason: string; at_ms?: number; length_ms?: number; limited?: boolean };
  if (rest.cause === undefined) return undefined;
  const at_ms = rest.at_ms ?? rest.until_ms;
  return {
    until_ms: rest.until_ms, resets_ms: rest.resets_ms ?? null, cause: rest.cause, reason: bounded(rest.reason),
    length_ms: rest.length_ms ?? rest.until_ms - at_ms, limited: rest.limited === true,
  };
}

function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function kept(value: unknown): { marks: Mark[]; unknown: string[] } {
  if (value === null || value === undefined) return { marks: [], unknown: [] };
  const read = JSON.parse(String(value)) as { marks?: Mark[]; unknown?: string[] };
  return { marks: read.marks ?? [], unknown: read.unknown ?? [] };
}
