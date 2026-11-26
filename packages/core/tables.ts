import type Database from "better-sqlite3";
import { countAsks, fillLeft, leftMark, leftOf } from "./asks-left.js";
import { canonical } from "./format.js";
import { readText, storedText } from "./records.js";
import { sourceName } from "./sources.js";
import { importedOf, isStopped, isWaiting, moveDelivery, sealHeld, SETTLED, STOPPED, unreadAgain, UNREAD, WAITING, type DeliveryMove, type DeliveryState } from "./deliveries.js";
import { COLUMNS, marks, Sql } from "./sql.js";
import { NEWEST, type AskRow, type DayUnit, type EnrichmentRow, type ExtractRow, type ItemRoute, type Json, type JsonObject, type SourceRow } from "./types.js";

export type JobState = "queued" | "running" | "done" | "dead";

export interface DeviceRow {
  unit: string;
  model: string;
  added_ms: number;
  retired_ms: number | null;
}

export interface PollRow {
  acquirer: string;
  next_ms: number;
  paged_ms: number | null;
  page_next_ms: number | null;
  held_ms: number | null;
  pages: boolean;
}

export type PollWrite = Pick<PollRow, "acquirer" | "next_ms"> & Partial<Omit<PollRow, "acquirer" | "next_ms">>;

export const CURSOR_BYTES = 16_384;

export interface PollCursor {
  source: string;
  state: string;
  start_ms: number | null;
}

export type MemoryEntry = readonly [part: string, key: string, value: string | null];

export interface MemoryChanges {
  cleared: readonly string[];
  entries: readonly MemoryEntry[];
}

export interface BackfillRow {
  source: string;
  acquirer: string;
  left: number | null;
  unit: [string, string] | null;
  start_ms: number | null;
  recent: { at_ms: number; left: number | null }[];
  last: string | null;
}

export interface DeliveryRow {
  id: string;
  source: string;
  sealed_ms: number;
  stated_ms: number;
  facts: JsonObject;
  state: DeliveryState;
  run: number | null;
  failures: number;
  error: string | null;
  pass: string | null;
  seal: number | null;
  lost: Json | null;
  refused: number;
  read_by: string | null;
}

export interface RunRow {
  id: number;
  kind: string;
  subject: string;
  started_ms: number;
  ended_ms: number | null;
  outcome: "ok" | "failed" | "interrupted" | null;
  counts: Json | null;
  changed_paths: Json | null;
  error: string | null;
}

export interface JobRow {
  id: number;
  kind: string;
  key: string;
  connector: string | null;
  lane: number;
  state: JobState;
  not_before_ms: number;
  attempts: number;
  requeue: boolean;
  progress: Json | null;
  created_ms: number;
  started_ms: number | null;
  ended_ms: number | null;
  error: string | null;
}

export interface CursorRow {
  name: string;
  seq: number;
  reread: number;
  at_ms: number;
  fingerprint: string | null;
  generation: number;
}

export interface AttemptRow {
  target: string;
  source: string;
  outcome: string;
  reason: string | null;
  facts: Readonly<Record<string, unknown>>;
  detail: string | null;
  since_ms: number;
  at_ms: number;
  contact_ms: number | null;
  fails: number;
}

export interface ControlRow {
  target: string;
  reason: string;
  at_ms: number;
  by: string;
}

export interface ReadTables {
  sources: { get(id: string): SourceRow | undefined; list(): SourceRow[] };
  devices: { get(unit: string): DeviceRow | undefined };
  polls: {
    get(acquirer: string): PollRow | undefined;
    list(): PollRow[];
    cursor(acquirer: string): PollCursor | undefined;
    holding(): string[];
    remembered(acquirer: string, part: string, key: string): string | undefined;
    rememberedAfter(acquirer: string, part: string, after: string | null, limit: number): [key: string, value: string][];
  };
  backfills: {
    get(source: string): BackfillRow | undefined;
    of(acquirer: string): BackfillRow[];
  };
  deliveries: {
    get(id: string, source: string): DeliveryRow | undefined;
    shipment(id: string): DeliveryRow[];
    shipped(source: string): { id: string; sources: string[]; waiting: boolean } | undefined;
    next(source: string): DeliveryRow | undefined;
    ahead(source: string, count: number): DeliveryRow[];
    waitingAfter(source: string, after: Pick<DeliveryRow, "pass" | "stated_ms" | "sealed_ms" | "id"> | null, count: number): DeliveryRow[];
    newestLeft(after: string): { source: string; row: DeliveryRow | undefined; rows: number } | undefined;
    walk(after: string, count: number): DeliveryRow[];
    waiting(source: string): { live: boolean; since_ms: number } | undefined;
    stopped(): string[];
    blockedAt(source: string): DeliveryRow | undefined;
    sealedBy(pass: string): { first_ms: number; newest_ms: number } | undefined;
    held(pass: string, source: string, seal: number): boolean;
    fedBy(lane: string): string[];
    list(): DeliveryRow[];
    imported(source: string): { id: string; run: number }[];
    unread(source: string, code: string): DeliveryRow | undefined;
  };
  runs: {
    get(id: number): RunRow | undefined;
    running(): RunRow[];
    unfinished(kind: string, subject: string, except: number | null): RunRow | undefined;
    ended(kind: string, subject: string): boolean;
    failed(kind: string, prefix: string, limit: number): RunRow[];
  };
  cursors: { get(name: string): CursorRow | undefined };
  statements: {
    after(source: string, kind: string, seq: number): boolean;
    statedAt(seq: number): number | undefined;
  };
  jobs: {
    get(kind: string, key: string): JobRow | undefined;
    next(now_ms: number, lanes?: readonly number[], skip?: readonly string[]): JobRow | undefined;
    open(): JobRow[];
  };
  controls: { list(): ControlRow[] };
  attempts: {
    get(target: string, source: string): AttemptRow | undefined;
    of(target: string): AttemptRow[];
    targets(): string[];
  };
  asks: {
    get(family: string, item: string, prompt: string): AskRow | undefined;
    ofItem(family: string, item: string): AskRow[];
    ofUnit(family: string, unit: string): AskRow[];
    next(work_id: string, after: AskRow | null, limit: number): AskRow[];
    pending(): Pick<AskRow, "family" | "item" | "unit" | "waits">[];
    woken(input_hash: string, key: string): { family: string; unit: string }[];
    givenUp(work_id: string): AskRow[];
    unhideables(work_id: string): { why: string; count: number }[];
    left(work_id: string, starts: readonly number[]): { prompt: string; total: number; from: number[] }[] | null;
    filling(): boolean;
  };
  itemRoutes: {
    get(family: string, item: string, prompt: string): ItemRoute | undefined;
    list(): ItemRoute[];
  };
  meta: {
    get(key: string): string | undefined;
    under(prefix: string): string[];
  };
  custody: { imported(pass: string, source: string): number };
  inbox: { since(day: number): InboxDay[] };
  dirty: {
    marks(family: string, unit: string): number | undefined;
    newestOwed(family: string): number | undefined;
    between(from: string, to: string): { day: string; aside: boolean }[];
  };
}

export interface Tables extends ReadTables {
  sources: ReadTables["sources"] & {
    add(row: { id: string; vendor: string; connector: string; options?: JsonObject; added_ms: number }): void;
    restate(id: string, options: JsonObject): void;
    advance(id: string, read_through_ms: number): void;
  };
  devices: ReadTables["devices"] & {
    add(row: { unit: string; model: string; added_ms: number }): void;
    retire(unit: string, at_ms: number): void;
    remodel(unit: string, model: string): void;
  };
  polls: ReadTables["polls"] & {
    put(row: PollWrite): void;
    delete(acquirer: string): void;
    leave(acquirer: string, left: PollCursor & { changes: MemoryChanges }): number;
    forget(acquirer: string): void;
  };
  backfills: ReadTables["backfills"] & {
    paged(row: { source: string; acquirer: string; left: number | null; unit: [string, string] | null; start_ms: number | null; at_ms: number; delivery: string }): void;
    restart(acquirer: string): void;
  };
  deliveries: ReadTables["deliveries"] & {
    add(row: { id: string; source: string; sealed_ms: number; stated_ms: number; facts: JsonObject; pass?: string | null; seal?: number | null; lost?: Json | null }): boolean;
    move(id: string, source: string, move: DeliveryMove): void;
    unreadAgain(source: string): number;
    remove(id: string, source: string): boolean;
  };
  runs: ReadTables["runs"] & {
    start(row: { kind: string; subject: string; started_ms: number }): number;
    end(id: number, row: { ended_ms: number; outcome: "ok" | "failed"; counts?: Json; changed_paths?: Json; error?: string }): void;
    interrupt(now_ms: number): number;
    resume(id: number): void;
    count(id: number, row: { counts: Json; changed_paths: Json }): void;
  };
  cursors: ReadTables["cursors"] & {
    move(name: string, patch: { seq?: number; reread?: number; at_ms: number; fingerprint?: string }): void;
    reset(name: string, fingerprint: string | null, at_ms: number): number;
    turn(name: string, at_ms: number): number;
    list(prefix: string): CursorRow[];
  };
  dirty: ReadTables["dirty"] & {
    days(days: Iterable<string>): void;
    newestDay(through: string): string | undefined;
    nextDays(limit: number, through: string, since?: string): { day: string; marks: number }[];
    rendered(day: string, marks: number, changed: boolean): boolean;
    setAsideDay(day: string, marks: number, error: string): boolean;
    retryDays(): number;
    units(family: string, units: Iterable<string>): void;
    wake(family: string, unit: string): void;
    urgent(): { family: string; woken: boolean; end_ms: number | null }[];
    next(family: string, limit: number, floor?: { woken: true } | { since_ms: number }): { unit: string; marks: number }[];
    planned(family: string, unit: string, marks: number, read: ExtractRead | null): boolean;
    setAside(family: string, unit: string, marks: number, error: string, read: ExtractRead | null): boolean;
    sendFailed(family: string, unit: string, error: string): void;
    retry(family: string): number;
    clear(family: string): number;
  };
  jobs: ReadTables["jobs"] & {
    enqueue(job: { kind: string; key: string; connector?: string | null; lane: number; not_before_ms: number; now_ms: number }): "queued" | "requeued" | "already" | "dead";
    revive(now_ms: number, job?: { kind: string; key: string }): string[];
    take(now_ms: number, lanes?: readonly number[], skip?: readonly string[]): JobRow | undefined;
    finish(id: number, now_ms: number): JobState;
    fail(id: number, error: string, now_ms: number): JobState;
    urgent(id: number, lane: number): void;
    progress(id: number, progress: Json): void;
    recover(): number;
    stop(id: number, not_before_ms: number): void;
    prune(now_ms: number): number;
    delete(id: number): void;
  };
  controls: ReadTables["controls"] & {
    set(row: ControlRow): void;
    clear(target: string): void;
  };
  attempts: ReadTables["attempts"] & {
    put(row: AttemptRow): void;
    delete(target: string, source?: string): void;
  };
  asks: ReadTables["asks"] & {
    put(row: AskRow): boolean;
    delete(family: string, item: string, prompt?: string): number;
    backoff(family: string, item: string, prompt: string, retry_ms: number): void;
    giveUp(family: string, item: string, prompt: string, route: string): void;
    reopen(family: string, item: string, prompt: string): boolean;
    unhideable(family: string, item: string, prompt: string, why: string): void;
    hideable(work_id: string | null): { family: string; unit: string }[];
    fill(): boolean;
  };
  itemRoutes: ReadTables["itemRoutes"] & {
    set(row: ItemRoute): void;
  };
  events: {
    append(event: { at_ms: number; kind: string; key: string; detail?: Json }): number;
    prune(now_ms: number): number;
  };
  meta: ReadTables["meta"] & { set(key: string, value: string): void; delete(key: string): void };
  inbox: ReadTables["inbox"] & {
    grew(lane: string, sealed_ms: number, bytes: number): void;
  };
}

export interface InboxDay {
  lane: string;
  day: number;
  deliveries: number;
  bytes: number;
}

export const UTC_DAY_MS = 86_400_000;
export interface DayCounts {
  total: number;
  per_family: Record<string, number>;
}

export interface DayRow {
  day: string;
  inputs: string;
  counts: DayCounts;
}

export const DAYS_MARK = "days:listed";

export interface PublishLists {
  changed: string[];
  gone: string[];
}

export interface Published {
  written: string[];
  deleted: string[];
  copy_ms: number;
  gone_ms: number;
}

export interface AsideRow {
  family: string;
  unit: string;
  error: string;
  at_ms: number;
}

export interface ReadDerived {
  days: Pick<Derived["days"], "page">;
  extracts: Pick<Derived["extracts"], "compare">;
  next: Pick<Derived["next"], "units">;
}

export interface Derived {
  extracts: {
    get(family: string, unit: string): ExtractRow | undefined;
    put(row: ExtractRow): boolean;
    units(family: string): { unit: string; days: string[] }[];
    unitsOn(family: string, from: string, to: string): string[];
    days(): string[];
    delete(family: string, unit: string): string[] | undefined;
    compare(family: string): PublishLists;
    publish(family: string, lists: PublishLists): Published;
    aside: {
      put(family: string, unit: string, error: string, at_ms: number): void;
      built(family: string, unit: string): void;
      list(family?: string): AsideRow[];
      clear(family: string): void;
    };
  };
  next: {
    put(row: ExtractRow): void;
    delete(family: string, unit: string): void;
    any(family: string): boolean;
    units(family: string, after: string | null, limit: number): string[];
    empty(family: string, limit: number): number;
    clear(family: string): number;
  };
  dayUnits: {
    put(day: string, units: readonly DayUnit[]): boolean;
    stale(day: string): boolean;
    days(family: string, unit: string): string[];
  };
  days: {
    put(day: string, inputs: string, counts: DayCounts): boolean;
    delete(day: string): boolean;
    page(from: string | undefined, to: string | undefined, after: string | undefined, limit: number): DayRow[];
    dates(from: string | undefined, to: string | undefined, after: string | undefined, limit: number): string[];
  };
  enrichments: {
    get(family: string, item: string, prompt: string): EnrichmentRow | undefined;
    list(family: string, filter?: { state?: EnrichmentRow["state"]; item?: string }): EnrichmentRow[];
    put(row: EnrichmentRow): boolean;
    delete(family: string, item: string, prompt?: string): number;
  };
}

const MAX_ATTEMPTS = 5;
export const REST = "delivery";
export const DELIVERY_ORDER = "CASE WHEN pass IS NULL THEN stated_ms ELSE sealed_ms END, sealed_ms, id";
const URGENCY = "woken DESC, coalesce(end_ms, 9007199254740991) DESC, unit DESC";
type ExtractRead = Pick<ExtractRow, "reading" | "code">;
function standing(family: string, unit: string, read: ExtractRead | null): [string, unknown[]] {
  return read === null
    ? [" AND NOT EXISTS (SELECT 1 FROM extracts WHERE family = ? AND unit = ?)", [family, unit]]
    : [" AND EXISTS (SELECT 1 FROM extracts WHERE family = ? AND unit = ? AND reading = ? AND code = ?)", [family, unit, read.reading, read.code]];
}
const EVENT_DAYS_MS = 30 * 24 * 3_600_000;
const DONE_JOB_DAYS_MS = 7 * 24 * 3_600_000;

export function backoff(attempts: number): number {
  return Math.min(30_000 * 4 ** (attempts - 1), 1_800_000);
}

const json = (text: string | null): Json | null => (text === null ? null : (JSON.parse(text) as Json));

type Raw<T> = { [K in keyof T]: unknown };

function source(row: Raw<SourceRow>): SourceRow {
  return { ...(row as SourceRow), options: JSON.parse(row.options as string) as JsonObject };
}
function attempt(row: Raw<AttemptRow>): AttemptRow {
  return { ...(row as AttemptRow), facts: JSON.parse(row.facts as string) as AttemptRow["facts"] };
}

function poll(row: Raw<PollRow>): PollRow {
  return { ...(row as PollRow), pages: row.pages === 1 };
}

function backfill(row: Raw<BackfillRow>): BackfillRow {
  return {
    ...(row as BackfillRow), unit: row.unit === null ? null : JSON.parse(row.unit as string) as [string, string],
    recent: JSON.parse(row.recent as string) as BackfillRow["recent"],
  };
}

const RECENT_PAGES = 5;
function delivery(row: Raw<DeliveryRow>): DeliveryRow {
  return { ...(row as DeliveryRow), facts: JSON.parse(row.facts as string) as JsonObject, lost: json(row.lost as string | null) };
}
function runRow(row: Raw<RunRow>): RunRow {
  return { ...(row as RunRow), counts: json(row.counts as string | null), changed_paths: json(row.changed_paths as string | null) };
}
function job(row: Raw<JobRow>): JobRow {
  return { ...(row as JobRow), requeue: row.requeue === 1, progress: json(row.progress as string | null) };
}
export function extract(row: Raw<ExtractRow>): ExtractRow {
  const { items: _items, ...rest } = row;
  return { ...(rest as ExtractRow), content: JSON.parse(readText(row.content as string | Buffer)) as Json, days: JSON.parse(row.days as string) as string[] };
}
export function enrichment(row: Record<string, unknown>): EnrichmentRow {
  return { ...(row as unknown as EnrichmentRow), content: JSON.parse(row.content as string) as Json };
}

function askRow(row: Record<string, unknown>): AskRow {
  return { ...(row as unknown as AskRow), started: row.started === 1 };
}

const UNHIDEABLE = "(SELECT u.why FROM asks_unhideable u WHERE u.family = asks.family AND u.item = asks.item AND u.prompt = asks.prompt)";
const ASKS = `family, item, prompt, prompt_version AS version, input_hash, unit, work_id, at_key, started, waits, retry_ms, given_up, ${UNHIDEABLE} AS unhideable, state`;
const UNHIDEABLE_AT = 9;
const ASK_COLUMNS = "family, item, prompt, prompt_hash, prompt_version, input_hash, unit, work_id, at_key, started, waits, retry_ms, given_up, state";
const ONE_ASK = "family = ? AND item = ? AND prompt = ?";
const UNITS = "asks INDEXED BY asks_units";
const UNIT_ASKS = "family = ? AND unit = ?";

function unitAsksAt(sql: Sql, at_key: number, family: string, unit: string): void {
  countAsks(sql, -1, UNITS, UNIT_ASKS, family, unit);
  sql.run(`UPDATE ${UNITS} SET at_key = ? WHERE ${UNIT_ASKS}`, at_key, family, unit);
  countAsks(sql, 1, UNITS, UNIT_ASKS, family, unit);
}

function unitAsksGo(sql: Sql, family: string, unit: string): void {
  countAsks(sql, -1, UNITS, UNIT_ASKS, family, unit);
  sql.run(`DELETE FROM ${UNITS} WHERE ${UNIT_ASKS}`, family, unit);
}

export function readTables(db: Database.Database): ReadTables {
  return tables(new Sql(db));
}

function dayRange(columns: string, from: string | undefined, to: string | undefined, after: string | undefined, limit: number): [string, string, string, number] {
  const low = after !== undefined && (from === undefined || after >= from) ? { op: ">", day: after } : { op: ">=", day: from ?? "" };
  return [`SELECT ${columns} FROM days WHERE day ${low.op} ? AND day <= ? ORDER BY day LIMIT ?`, low.day, to ?? "9999-12-31", limit];
}

export function tables(sql: Sql): Tables {
  const write = () => sql.writing();
  const ahead = (src: string, count: number): DeliveryRow[] => {
    const rows = sql.all<Raw<DeliveryRow>>(`SELECT ${COLUMNS.deliveries} FROM deliveries WHERE source = ? AND state IN ${WAITING} ORDER BY ${DELIVERY_ORDER} LIMIT ?`, src, count).map(delivery);
    const unheld = rows.findIndex((row) => row.pass !== null && row.seal !== null && row.seal > 1
      && !sealHeld(sql, row.pass, src, row.seal - 1));
    return unheld < 0 ? rows : rows.slice(0, unheld);
  };
  const nextJob = (now: number, lanes?: readonly number[], skip: readonly string[] = []): JobRow | undefined => {
    const filter = (lanes === undefined ? "" : ` AND lane IN (${marks(lanes.length)})`) +
      (skip.length === 0 ? "" : ` AND 'kind:' || kind NOT IN (${marks(skip.length)}) AND kind || ':' || key NOT IN (${marks(skip.length)})
        AND (connector IS NULL OR 'pause:' || connector NOT IN (${marks(skip.length)}))`);
    const row = sql.get<Raw<JobRow>>(
      `SELECT ${COLUMNS.jobs} FROM jobs WHERE state = 'queued' AND not_before_ms <= ?${filter} ORDER BY lane, not_before_ms, id LIMIT 1`,
      now, ...(lanes ?? []), ...skip, ...skip, ...skip,
    );
    return row && job(row);
  };
  return {
    sources: {
      get: (id) => {
        const row = sql.get<Raw<SourceRow>>(`SELECT ${COLUMNS.sources} FROM sources WHERE id = ?`, id);
        return row && source(row);
      },
      list: () => sql.all<Raw<SourceRow>>(`SELECT ${COLUMNS.sources} FROM sources ORDER BY id`).map(source),
      add: (row) => {
        write();
        const { product, account, copy } = sourceName(row.id);
        sql.run(
          "INSERT INTO sources (id, product, vendor, account, copy, connector, options, read_through_ms, added_ms) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
          row.id, product, row.vendor, account, copy, row.connector, canonical(row.options ?? {}), row.added_ms,
        );
        sql.moved.sources.add(row.id);
      },
      restate: (id, options) => {
        write();
        sql.run("UPDATE sources SET options = ? WHERE id = ?", canonical(options), id);
      },
      advance: (id, ms) => {
        write();
        const before = sql.get<{ read_through_ms: number | null }>("SELECT read_through_ms FROM sources WHERE id = ?", id);
        if (before === undefined || (before.read_through_ms !== null && before.read_through_ms >= ms)) return;
        sql.run("UPDATE sources SET read_through_ms = ? WHERE id = ?", ms, id);
        const noted = sql.moved.read.get(id);
        sql.moved.read.set(id, { before: noted === undefined ? before.read_through_ms : noted.before, after: ms });
      },
    },
    devices: {
      get: (unit) => sql.get<DeviceRow>(`SELECT ${COLUMNS.devices} FROM devices WHERE unit = ?`, unit),
      add: (row) => {
        write();
        sql.run("INSERT INTO devices (unit, model, added_ms) VALUES (?, ?, ?)", row.unit, row.model, row.added_ms);
      },
      retire: (unit, at_ms) => {
        write();
        sql.run("UPDATE devices SET retired_ms = ? WHERE unit = ?", at_ms, unit);
      },
      remodel: (unit, model) => {
        write();
        sql.run("UPDATE devices SET model = ? WHERE unit = ?", model, unit);
      },
    },
    polls: {
      get: (acquirer) => {
        const row = sql.get<Raw<PollRow>>(`SELECT ${COLUMNS.polls} FROM polls WHERE acquirer = ?`, acquirer);
        return row && poll(row);
      },
      list: () => sql.all<Raw<PollRow>>(`SELECT ${COLUMNS.polls} FROM polls ORDER BY acquirer`).map(poll),
      cursor: (acquirer) => sql.get<PollCursor>("SELECT source, state, start_ms FROM poll_cursors WHERE acquirer = ?", acquirer),
      holding: () => sql.all<{ acquirer: string }>("SELECT acquirer FROM poll_cursors ORDER BY acquirer").map((row) => row.acquirer),
      remembered: (acquirer, part, key) =>
        sql.get<{ value: string }>("SELECT value FROM poll_memory WHERE acquirer = ? AND part = ? AND key = ?", acquirer, part, key)?.value,
      rememberedAfter: (acquirer, part, after, limit) =>
        (after === null
          ? sql.all<{ key: string; value: string }>("SELECT key, value FROM poll_memory WHERE acquirer = ? AND part = ? ORDER BY key LIMIT ?", acquirer, part, limit)
          : sql.all<{ key: string; value: string }>("SELECT key, value FROM poll_memory WHERE acquirer = ? AND part = ? AND key > ? ORDER BY key LIMIT ?", acquirer, part, after, limit))
          .map((row) => [row.key, row.value]),
      put: (row) => {
        write();
        sql.run(
          `INSERT INTO polls (acquirer, next_ms, paged_ms, page_next_ms, held_ms, pages) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (acquirer) DO UPDATE SET next_ms = excluded.next_ms, paged_ms = excluded.paged_ms,
             page_next_ms = excluded.page_next_ms, held_ms = excluded.held_ms, pages = excluded.pages`,
          row.acquirer, row.next_ms, row.paged_ms ?? null, row.page_next_ms ?? null, row.held_ms ?? null,
          row.pages === true ? 1 : 0,
        );
      },
      delete: (acquirer) => {
        write();
        sql.run("DELETE FROM polls WHERE acquirer = ?", acquirer);
      },
      leave: (acquirer, { source, state, start_ms, changes }) => {
        write();
        const held = sql.get<{ source: string }>("SELECT source FROM poll_cursors WHERE acquirer = ?", acquirer);
        let rows = held?.source === source ? 0 : sql.run("DELETE FROM poll_memory WHERE acquirer = ?", acquirer).changes;
        sql.run(
          `INSERT INTO poll_cursors (acquirer, source, state, start_ms) VALUES (?, ?, ?, ?)
           ON CONFLICT (acquirer) DO UPDATE SET source = excluded.source, state = excluded.state, start_ms = excluded.start_ms`,
          acquirer, source, state, start_ms,
        );
        for (const part of changes.cleared) rows += sql.run("DELETE FROM poll_memory WHERE acquirer = ? AND part = ?", acquirer, part).changes;
        for (const [part, key, value] of changes.entries) {
          rows += value === null
            ? sql.run("DELETE FROM poll_memory WHERE acquirer = ? AND part = ? AND key = ?", acquirer, part, key).changes
            : sql.run(
              "INSERT INTO poll_memory (acquirer, part, key, value) VALUES (?, ?, ?, ?) ON CONFLICT (acquirer, part, key) DO UPDATE SET value = excluded.value",
              acquirer, part, key, value,
            ).changes;
        }
        return rows;
      },
      forget: (acquirer) => {
        write();
        sql.run("DELETE FROM polls WHERE acquirer = ?", acquirer);
        sql.run("DELETE FROM poll_cursors WHERE acquirer = ?", acquirer);
        sql.run("DELETE FROM poll_memory WHERE acquirer = ?", acquirer);
      },
    },
    backfills: {
      get: (src) => {
        const row = sql.get<Raw<BackfillRow>>(`SELECT ${COLUMNS.backfills} FROM backfills WHERE source = ?`, src);
        return row && backfill(row);
      },
      of: (acquirer) => sql.all<Raw<BackfillRow>>(`SELECT ${COLUMNS.backfills} FROM backfills WHERE acquirer = ? ORDER BY source`, acquirer).map(backfill),
      paged: (row) => {
        write();
        const before = sql.get<{ start_ms: number | null; recent: string }>("SELECT start_ms, recent FROM backfills WHERE source = ?", row.source);
        const kept = before === undefined || before.start_ms !== row.start_ms ? [] : JSON.parse(before.recent) as BackfillRow["recent"];
        const recent = [...kept, { at_ms: row.at_ms, left: row.left }].slice(-RECENT_PAGES);
        sql.run(
          `INSERT INTO backfills (source, acquirer, left, unit, start_ms, recent, last) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (source) DO UPDATE SET acquirer = excluded.acquirer, left = excluded.left, unit = excluded.unit, start_ms = excluded.start_ms,
             recent = excluded.recent, last = excluded.last`,
          row.source, row.acquirer, row.left, row.unit === null ? null : canonical(row.unit), row.start_ms, canonical(recent), row.left === 0 ? row.delivery : null,
        );
      },
      restart: (acquirer) => {
        write();
        sql.run("UPDATE backfills SET left = NULL, recent = '[]', last = NULL WHERE acquirer = ?", acquirer);
      },
    },
    deliveries: {
      get: (id, src) => {
        const row = sql.get<Raw<DeliveryRow>>(`SELECT ${COLUMNS.deliveries} FROM deliveries WHERE id = ? AND source = ?`, id, src);
        return row && delivery(row);
      },
      shipment: (id) => sql.all<Raw<DeliveryRow>>(`SELECT ${COLUMNS.deliveries} FROM deliveries WHERE id = ? ORDER BY source`, id).map(delivery),
      shipped: (src) => {
        const newest = sql.get<{ id: string }>("SELECT id FROM deliveries INDEXED BY deliveries_lane WHERE source = ? ORDER BY id DESC LIMIT 1", src);
        if (newest === undefined) return undefined;
        const rows = sql.all<{ source: string; state: DeliveryState }>("SELECT source, state FROM deliveries WHERE id = ? ORDER BY source", newest.id);
        return { id: newest.id, sources: rows.map((row) => row.source), waiting: rows.some(isWaiting) };
      },
      next: (src) => ahead(src, 1)[0],
      ahead,
      waitingAfter: (src, after, count) => {
        const from = after === null ? "" : " AND (CASE WHEN pass IS NULL THEN stated_ms ELSE sealed_ms END, sealed_ms, id) > (?, ?, ?)";
        const marks = after === null ? [] : [after.pass === null ? after.stated_ms : after.sealed_ms, after.sealed_ms, after.id];
        return sql.all<Raw<DeliveryRow>>(
          `SELECT ${COLUMNS.deliveries} FROM deliveries INDEXED BY deliveries_waiting WHERE source = ? AND state IN ${WAITING}${from} ORDER BY ${DELIVERY_ORDER} LIMIT ?`,
          src, ...marks, count,
        ).map(delivery);
      },
      newestLeft: (after) => {
        const next = sql.get<{ source: string }>(
          "SELECT source FROM deliveries INDEXED BY deliveries_left WHERE source > ? AND json_extract(facts, '$.left') IS NOT NULL ORDER BY source LIMIT 1", after,
        );
        if (next === undefined) return undefined;
        const row = sql.get<Raw<DeliveryRow> & { rows: number }>(
          `SELECT ${COLUMNS.deliveries}, count(*) OVER () AS rows FROM deliveries INDEXED BY deliveries_left WHERE source = ? AND json_extract(facts, '$.left') IS NOT NULL AND pass IS NOT NULL
           ORDER BY stated_ms DESC, sealed_ms DESC, id DESC LIMIT 1`, next.source,
        );
        if (row === undefined) return { source: next.source, row: undefined, rows: 0 };
        const { rows, ...of } = row;
        return { source: next.source, row: delivery(of), rows };
      },
      walk: (after, count) => {
        const rows = sql.all<Raw<DeliveryRow>>(`SELECT ${COLUMNS.deliveries} FROM deliveries WHERE id > ? ORDER BY id, source LIMIT ?`, after, count);
        const last = rows.at(-1);
        if (rows.length === count) rows.push(...sql.all<Raw<DeliveryRow>>(`SELECT ${COLUMNS.deliveries} FROM deliveries WHERE id = ? AND source > ? ORDER BY source`, last!.id, last!.source));
        return rows.map(delivery);
      },
      waiting: (src) => {
        const first = sql.get<{ sealed_ms: number }>(
          `SELECT sealed_ms FROM deliveries INDEXED BY deliveries_waiting WHERE source = ? AND state IN ${WAITING} ORDER BY ${DELIVERY_ORDER} LIMIT 1`, src,
        );
        if (first === undefined) return undefined;
        const live = sql.get(
          `SELECT 1 FROM deliveries INDEXED BY deliveries_waiting WHERE source = ? AND state IN ${WAITING} AND json_type(facts, '$.history') IS NOT 'true' ORDER BY ${DELIVERY_ORDER} LIMIT 1`, src,
        ) !== undefined;
        return { live, since_ms: first.sealed_ms };
      },
      stopped: () => sql.all<{ source: string }>(
        `SELECT DISTINCT source FROM deliveries INDEXED BY deliveries_state WHERE ${STOPPED} ORDER BY source`,
      ).map((row) => row.source),
      blockedAt: (src) => {
        const row = sql.get<Raw<DeliveryRow>>(`SELECT ${COLUMNS.deliveries} FROM deliveries INDEXED BY deliveries_waiting WHERE source = ? AND state IN ${WAITING} ORDER BY ${DELIVERY_ORDER} LIMIT 1`, src);
        const first = row && delivery(row);
        return first !== undefined && isStopped(first) ? first : undefined;
      },
      held: (pass, src, seal) => sealHeld(sql, pass, src, seal),
      sealedBy: (pass) => {
        const row = sql.get<{ first_ms: number | null; newest_ms: number | null }>(`SELECT
          (SELECT sealed_ms FROM deliveries WHERE pass = @pass ORDER BY sealed_ms LIMIT 1) AS first_ms,
          (SELECT sealed_ms FROM deliveries WHERE pass = @pass ORDER BY sealed_ms DESC LIMIT 1) AS newest_ms`, { pass })!;
        return row.first_ms === null ? undefined : { first_ms: row.first_ms, newest_ms: row.newest_ms! };
      },
      fedBy: (lane) => sql.all<{ id: string }>(
        "SELECT id FROM sources s WHERE EXISTS (SELECT 1 FROM deliveries d INDEXED BY deliveries_lane WHERE d.source = s.id AND d.id > ? AND d.id < ?) ORDER BY id",
        `${lane}/`, `${lane}0`,
      ).map((row) => row.id),
      list: () => sql.all<Raw<DeliveryRow>>(`SELECT ${COLUMNS.deliveries} FROM deliveries ORDER BY sealed_ms, id, source`).map(delivery),
      imported: (src) => sql.all<{ id: string; run: number }>(
        "SELECT id, run FROM deliveries INDEXED BY deliveries_lane WHERE source = ? AND state = 'imported' AND run IS NOT NULL ORDER BY id", src,
      ),
      unread: (src, code) => {
        const row = sql.get<Raw<DeliveryRow>>(
          `SELECT ${COLUMNS.deliveries} FROM deliveries INDEXED BY deliveries_unread WHERE source = ? AND ${UNREAD} AND read_by IS NOT ? ORDER BY ${DELIVERY_ORDER} LIMIT 1`, src, code,
        );
        return row && delivery(row);
      },
      add: (row) => {
        write();
        const added = sql.run(
          "INSERT INTO deliveries (id, source, sealed_ms, stated_ms, facts, state, pass, seal, lost) VALUES (?, ?, ?, ?, ?, 'sealed', ?, ?, ?) ON CONFLICT DO NOTHING",
          row.id, row.source, row.sealed_ms, row.stated_ms, canonical(row.facts), row.pass ?? null, row.seal ?? null,
          row.lost === undefined || row.lost === null ? null : canonical(row.lost),
        ).changes > 0;
        if (!added) return false;
        sql.moved.deliveries.add(row.source);
        return true;
      },
      move: (id, src, move) => moveDelivery(sql, id, src, move),
      unreadAgain: (src) => unreadAgain(sql, src),
      remove: (id, src) => {
        write();
        return sql.run(`DELETE FROM deliveries WHERE id = ? AND source = ? AND seal IS NULL AND state IN ${SETTLED}`, id, src).changes > 0;
      },
    },
    runs: {
      get: (id) => {
        const row = sql.get<Raw<RunRow>>(`SELECT ${COLUMNS.runs} FROM runs WHERE id = ?`, id);
        return row && runRow(row);
      },
      running: () => sql.all<Raw<RunRow>>(`SELECT ${COLUMNS.runs} FROM runs WHERE outcome IS NULL ORDER BY id`).map(runRow),
      unfinished: (kind, subject, except) => {
        const row = sql.get<Raw<RunRow>>(
          `SELECT ${COLUMNS.runs} FROM runs WHERE kind = ? AND subject = ? AND outcome IS NOT 'ok' AND id IS NOT ? ORDER BY id DESC LIMIT 1`,
          kind, subject, except,
        );
        return row && runRow(row);
      },
      ended: (kind, subject) => sql.get("SELECT 1 FROM runs WHERE kind = ? AND subject = ? AND outcome = 'ok' LIMIT 1", kind, subject) !== undefined,
      failed: (kind, prefix, limit) => sql.all<Raw<RunRow>>(
        `SELECT ${COLUMNS.runs} FROM runs INDEXED BY runs_started WHERE kind = ? AND outcome = 'failed' AND substr(subject, 1, ?) = ? ORDER BY started_ms DESC LIMIT ?`,
        kind, prefix.length, prefix, limit,
      ).map(runRow),
      start: (row) => {
        write();
        return Number(sql.run("INSERT INTO runs (kind, subject, started_ms) VALUES (?, ?, ?)", row.kind, row.subject, row.started_ms).lastInsertRowid);
      },
      end: (id, row) => {
        write();
        sql.run(
          "UPDATE runs SET ended_ms = ?, outcome = ?, counts = ?, changed_paths = ?, error = ? WHERE id = ?",
          row.ended_ms, row.outcome,
          row.counts === undefined ? null : canonical(row.counts),
          row.changed_paths === undefined ? null : canonical(row.changed_paths),
          row.error ?? null, id,
        );
      },
      interrupt: (now) => {
        write();
        return sql.run("UPDATE runs SET outcome = 'interrupted', ended_ms = ? WHERE outcome IS NULL", now).changes;
      },
      resume: (id) => {
        write();
        sql.run("UPDATE runs SET outcome = NULL, ended_ms = NULL, error = NULL WHERE id = ?", id);
      },
      count: (id, row) => {
        write();
        sql.run("UPDATE runs SET counts = ?, changed_paths = ? WHERE id = ?", canonical(row.counts), canonical(row.changed_paths), id);
      },
    },
    cursors: {
      get: (name) => sql.get<CursorRow>(`SELECT ${COLUMNS.cursors} FROM cursors WHERE name = ?`, name),
      move: (name, patch) => {
        write();
        sql.run(
          `INSERT INTO cursors (name, seq, reread, at_ms, fingerprint) VALUES (?, coalesce(?, 0), coalesce(?, 0), ?, ?)
           ON CONFLICT (name) DO UPDATE SET seq = coalesce(?, seq), reread = coalesce(?, reread), at_ms = excluded.at_ms,
             fingerprint = coalesce(?, fingerprint)`,
          name, patch.seq ?? null, patch.reread ?? null, patch.at_ms, patch.fingerprint ?? null,
          patch.seq ?? null, patch.reread ?? null, patch.fingerprint ?? null,
        );
        if (patch.seq !== undefined) sql.moved.cursors.add(name);
        if (patch.reread !== undefined) sql.moved.rereadsRead = true;
      },
      reset: (name, fingerprint, at) => {
        write();
        sql.moved.cursors.add(name);
        const reread = sql.get<{ seq: number }>("SELECT coalesce(max(seq), 0) AS seq FROM rereads")!.seq;
        sql.moved.resets.add(name);
        sql.moved.rereadsRead = true;
        return sql.get<{ generation: number }>(
          `INSERT INTO cursors (name, seq, reread, at_ms, fingerprint, generation) VALUES (?, 0, ?, ?, ?, 1)
           ON CONFLICT (name) DO UPDATE SET seq = 0, reread = excluded.reread, at_ms = excluded.at_ms, fingerprint = excluded.fingerprint,
             generation = generation + 1
           RETURNING generation`,
          name, reread, at, fingerprint,
        )!.generation;
      },
      turn: (name, at) => {
        write();
        sql.moved.resets.add(name);
        return sql.get<{ generation: number }>(
          `INSERT INTO cursors (name, seq, reread, at_ms, fingerprint, generation) VALUES (?, 0, 0, ?, NULL, 1)
           ON CONFLICT (name) DO UPDATE SET generation = generation + 1
           RETURNING generation`,
          name, at,
        )!.generation;
      },
      list: (prefix) => sql.all<CursorRow>(`SELECT ${COLUMNS.cursors} FROM cursors WHERE substr(name, 1, ?) = ? ORDER BY name`, prefix.length, prefix),
    },
    statements: {
      after: (source, kind, seq) => sql.get("SELECT 1 AS stated FROM statements INDEXED BY statements_source WHERE source = ? AND kind = ? AND seq > ? LIMIT 1", source, kind, seq) !== undefined,
      statedAt: (seq) => sql.get<{ stated_ms: number }>("SELECT stated_ms FROM statements WHERE seq <= ? ORDER BY seq DESC LIMIT 1", seq)?.stated_ms,
    },
    dirty: {
      marks: (family, unit) => sql.get<{ marks: number }>("SELECT marks FROM dirty_units WHERE family = ? AND unit = ?", family, unit)?.marks,
      newestOwed: (family) => sql.get<{ end_ms: number }>(
        `SELECT coalesce(end_ms, 9007199254740991) AS end_ms FROM dirty_units INDEXED BY dirty_units_urgency
         WHERE family = ? AND woken = 0 AND error IS NULL ORDER BY coalesce(end_ms, 9007199254740991) DESC LIMIT 1`, family,
      )?.end_ms,
      between: (from, to) =>
        sql.all<{ day: string; aside: number }>("SELECT day, error IS NOT NULL AS aside FROM dirty_days WHERE day >= ? AND day <= ? ORDER BY day", from, to)
          .map(({ day, aside }) => ({ day, aside: aside === 1 })),
      days: (days) => {
        write();
        for (const day of days) sql.run("INSERT INTO dirty_days (day) VALUES (?) ON CONFLICT DO UPDATE SET marks = marks + 1, error = NULL", day);
      },
      newestDay: (through) =>
        sql.get<{ day: string }>("SELECT day FROM dirty_days WHERE error IS NULL AND day <= ? ORDER BY day DESC LIMIT 1", through)?.day,
      nextDays: (limit, through, since) =>
        sql.all<{ day: string; marks: number }>(
          `SELECT day, marks FROM dirty_days WHERE error IS NULL AND day <= ?${since === undefined ? "" : " AND day >= ?"} ORDER BY day DESC LIMIT ?`,
          through, ...(since === undefined ? [] : [since]), limit,
        ),
      rendered: (day, marks, changed) => {
        write();
        if (changed) sql.moved.rendered.add(day);
        return sql.run("DELETE FROM dirty_days WHERE day = ? AND marks = ?", day, marks).changes === 1;
      },
      setAsideDay: (day, marks, error) => {
        write();
        return sql.run("UPDATE dirty_days SET error = ? WHERE day = ? AND marks = ?", error, day, marks).changes === 1;
      },
      retryDays: () => {
        write();
        return sql.run("UPDATE dirty_days SET error = NULL, marks = marks + 1 WHERE error IS NOT NULL").changes;
      },
      units: (family, units) => {
        write();
        for (const unit of units) {
          sql.run(
            `INSERT INTO dirty_units (family, unit, end_ms) SELECT family, unit, end_ms FROM extracts WHERE family = ? AND unit = ?
             ON CONFLICT DO UPDATE SET end_ms = excluded.end_ms, marks = marks + 1, error = NULL`,
            family, unit,
          );
        }
      },
      wake: (family, unit) => {
        write();
        sql.run(
          `INSERT INTO dirty_units (family, unit, end_ms, woken) VALUES (?, ?, (SELECT end_ms FROM extracts WHERE family = ? AND unit = ?), 1)
           ON CONFLICT DO UPDATE SET woken = 1, marks = marks + 1, error = NULL`,
          family, unit, family, unit,
        );
      },
      urgent: () => {
        const found: { family: string; woken: boolean; end_ms: number | null }[] = [];
        for (let after = ""; ;) {
          const family = sql.get<{ family: string }>("SELECT family FROM dirty_units INDEXED BY dirty_units_urgency WHERE family > ? AND error IS NULL ORDER BY family LIMIT 1", after)?.family;
          if (family === undefined) return found;
          const top = sql.get<{ woken: number; end_ms: number | null }>(`SELECT woken, end_ms FROM dirty_units WHERE family = ? AND error IS NULL ORDER BY ${URGENCY} LIMIT 1`, family)!;
          found.push({ family, woken: top.woken === 1, end_ms: top.end_ms });
          after = family;
        }
      },
      next: (family, limit, floor) => {
        const due = floor === undefined ? "" : "woken" in floor ? " AND woken = 1" : " AND (woken = 1 OR end_ms IS NULL OR end_ms >= ?)";
        const params = floor !== undefined && "since_ms" in floor ? [floor.since_ms] : [];
        return sql.all<{ unit: string; marks: number }>(
          `SELECT unit, marks FROM dirty_units WHERE family = ? AND error IS NULL${due} ORDER BY ${URGENCY} LIMIT ?`, family, ...params, limit,
        );
      },
      planned: (family, unit, marks, read) => {
        write();
        const [stands, params] = standing(family, unit, read);
        return sql.run(`DELETE FROM dirty_units WHERE family = ? AND unit = ? AND marks = ?${stands}`, family, unit, marks, ...params).changes === 1;
      },
      setAside: (family, unit, marks, error, read) => {
        write();
        const [stands, params] = standing(family, unit, read);
        return sql.run(`UPDATE dirty_units SET error = ? WHERE family = ? AND unit = ? AND marks = ?${stands}`, error, family, unit, marks, ...params).changes === 1;
      },
      sendFailed: (family, unit, error) => {
        write();
        sql.run(
          `INSERT INTO dirty_units (family, unit, end_ms, error) VALUES (?, ?, (SELECT end_ms FROM extracts WHERE family = ? AND unit = ?), ?)
           ON CONFLICT DO UPDATE SET error = excluded.error`,
          family, unit, family, unit, error,
        );
      },
      retry: (family) => {
        write();
        return sql.run("UPDATE dirty_units SET error = NULL, marks = marks + 1 WHERE family = ? AND error IS NOT NULL", family).changes;
      },
      clear: (family) => {
        write();
        return sql.run("DELETE FROM dirty_units WHERE family = ?", family).changes;
      },
    },
    jobs: {
      get: (kind, key) => {
        const row = sql.get<Raw<JobRow>>(`SELECT ${COLUMNS.jobs} FROM jobs WHERE kind = ? AND key = ?`, kind, key);
        return row && job(row);
      },
      enqueue: ({ kind, key, connector = null, lane, not_before_ms, now_ms }) => {
        write();
        const existing = sql.get<{ state: JobState }>("SELECT state FROM jobs WHERE kind = ? AND key = ?", kind, key);
        if (existing === undefined) {
          sql.run(
            "INSERT INTO jobs (kind, key, connector, lane, state, not_before_ms, created_ms) VALUES (?, ?, ?, ?, 'queued', ?, ?)",
            kind, key, connector, lane, not_before_ms, now_ms,
          );
          return "queued";
        }
        if (existing.state === "running") {
          sql.run("UPDATE jobs SET requeue = 1, lane = min(lane, ?), connector = coalesce(?, connector) WHERE kind = ? AND key = ?", lane, connector, kind, key);
          return "requeued";
        }
        if (existing.state === "dead") {
          sql.run("UPDATE jobs SET lane = min(lane, ?), connector = coalesce(?, connector) WHERE kind = ? AND key = ?", lane, connector, kind, key);
          return "dead";
        }
        if (existing.state === "queued") {
          sql.run(
            "UPDATE jobs SET lane = min(lane, ?), not_before_ms = min(not_before_ms, ?), connector = coalesce(?, connector) WHERE kind = ? AND key = ?",
            lane, not_before_ms, connector, kind, key,
          );
          return "already";
        }
        sql.run(
          `UPDATE jobs SET state = 'queued', connector = coalesce(?, connector), lane = ?, not_before_ms = ?, attempts = 0, requeue = 0, progress = NULL,
             created_ms = ?, started_ms = NULL, ended_ms = NULL, error = NULL WHERE kind = ? AND key = ?`,
          connector, lane, not_before_ms, now_ms, kind, key,
        );
        return "queued";
      },
      revive: (now, one) => {
        write();
        return sql.all<{ job: string }>(
          `UPDATE jobs SET state = 'queued', not_before_ms = ?, attempts = 0, requeue = 0, started_ms = NULL, ended_ms = NULL, error = NULL
           WHERE state = 'dead'${one === undefined ? "" : " AND kind = ? AND key = ?"} RETURNING kind || ' ' || key AS job`,
          now, ...(one === undefined ? [] : [one.kind, one.key]),
        ).map((row) => row.job).sort();
      },
      next: nextJob,
      open: () => sql.all<Raw<JobRow>>(`SELECT ${COLUMNS.jobs} FROM jobs WHERE state <> 'done' ORDER BY id`).map(job),
      take: (now, lanes, skip) => {
        write();
        const found = nextJob(now, lanes, skip);
        if (found === undefined) return undefined;
        sql.run("UPDATE jobs SET state = 'running', started_ms = ?, ended_ms = NULL WHERE id = ?", now, found.id);
        return { ...found, state: "running", started_ms: now, ended_ms: null };
      },
      finish: (id, now) => {
        write();
        const row = sql.get<{ requeue: number }>("SELECT requeue FROM jobs WHERE id = ?", id);
        if (row?.requeue === 1) {
          sql.run(
            "UPDATE jobs SET state = 'queued', requeue = 0, attempts = 0, not_before_ms = ?, progress = NULL, ended_ms = ?, error = NULL WHERE id = ?",
            now, now, id,
          );
          return "queued";
        }
        sql.run("UPDATE jobs SET state = 'done', ended_ms = ?, progress = NULL, error = NULL WHERE id = ?", now, id);
        return "done";
      },
      urgent: (id, lane) => {
        write();
        sql.run("UPDATE jobs SET lane = min(lane, ?) WHERE id = ? AND state = 'running'", lane, id);
      },
      fail: (id, error, now) => {
        write();
        const attempts = sql.get<{ attempts: number }>("SELECT attempts FROM jobs WHERE id = ?", id)!.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          sql.run("UPDATE jobs SET state = 'dead', attempts = ?, requeue = 0, ended_ms = ?, error = ? WHERE id = ?", attempts, now, error, id);
          return "dead";
        }
        sql.run(
          "UPDATE jobs SET state = 'queued', attempts = ?, requeue = 0, not_before_ms = ?, ended_ms = ?, error = ? WHERE id = ?",
          attempts, now + backoff(attempts), now, error, id,
        );
        return "queued";
      },
      progress: (id, progress) => {
        write();
        sql.run("UPDATE jobs SET progress = ? WHERE id = ?", canonical(progress), id);
      },
      recover: () => {
        write();
        return sql.run("UPDATE jobs SET state = 'queued' WHERE state = 'running'").changes;
      },
      stop: (id, not_before_ms) => {
        write();
        sql.run("UPDATE jobs SET state = 'queued', requeue = 0, not_before_ms = ? WHERE id = ? AND state = 'running'", not_before_ms, id);
      },
      prune: (now) => {
        write();
        return sql.run("DELETE FROM jobs WHERE state = 'done' AND ended_ms < ?", now - DONE_JOB_DAYS_MS).changes;
      },
      delete: (id) => {
        write();
        sql.run("DELETE FROM jobs WHERE id = ?", id);
      },
    },
    attempts: {
      get: (target, src) => {
        const row = sql.get<Raw<AttemptRow>>(`SELECT ${COLUMNS.attempts} FROM attempts WHERE target = ? AND source = ?`, target, src);
        return row && attempt(row);
      },
      of: (target) => sql.all<Raw<AttemptRow>>(`SELECT ${COLUMNS.attempts} FROM attempts WHERE target = ? ORDER BY source`, target).map(attempt),
      targets: () => sql.all<{ target: string }>("SELECT DISTINCT target FROM attempts ORDER BY target").map((row) => row.target),
      put: (row) => {
        write();
        sql.run(
          `INSERT INTO attempts (target, source, outcome, reason, facts, detail, since_ms, at_ms, contact_ms, fails) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (target, source) DO UPDATE SET outcome = excluded.outcome, reason = excluded.reason, facts = excluded.facts, detail = excluded.detail,
             since_ms = excluded.since_ms, at_ms = excluded.at_ms, contact_ms = excluded.contact_ms, fails = excluded.fails`,
          row.target, row.source, row.outcome, row.reason, canonical(row.facts as Json), row.detail, row.since_ms, row.at_ms, row.contact_ms, row.fails,
        );
      },
      delete: (target, src) => {
        write();
        if (src === undefined) sql.run("DELETE FROM attempts WHERE target = ?", target);
        else sql.run("DELETE FROM attempts WHERE target = ? AND source = ?", target, src);
      },
    },
    asks: {
      get: (family, item, prompt) => {
        const row = sql.get<Record<string, unknown>>(`SELECT ${ASKS} FROM asks WHERE family = ? AND item = ? AND prompt = ?`, family, item, prompt);
        return row && askRow(row);
      },
      ofItem: (family, item) => sql.all<Record<string, unknown>>(`SELECT ${ASKS} FROM asks WHERE family = ? AND item = ? ORDER BY prompt`, family, item).map(askRow),
      ofUnit: (family, unit) => sql.all<Record<string, unknown>>(`SELECT ${ASKS} FROM asks INDEXED BY asks_units WHERE family = ? AND unit = ? ORDER BY item, prompt`, family, unit).map(askRow),
      next: (work_id, after, limit) => {
        const resume = after === null ? "" : " AND (started, at_key, unit, item, prompt, family) < (?, ?, ?, ?, ?, ?)";
        return sql.all<Record<string, unknown>>(
          `SELECT ${ASKS} FROM asks INDEXED BY asks_pick
           WHERE work_id = ? AND state = 'pending' AND ${UNHIDEABLE} IS NULL${resume} ORDER BY started DESC, at_key DESC, unit DESC, item DESC, prompt DESC, family DESC LIMIT ?`,
          work_id, ...(after === null ? [] : [after.started ? 1 : 0, after.at_key, after.unit, after.item, after.prompt, after.family]), limit,
        ).map(askRow);
      },
      pending: () => sql.all<Pick<AskRow, "family" | "item" | "unit" | "waits">>("SELECT family, item, unit, waits FROM asks INDEXED BY asks_hashes WHERE state = 'pending'"),
      woken: (input_hash, key) => sql.all<{ family: string; unit: string }>(
        `SELECT family, unit FROM asks INDEXED BY asks_hashes WHERE input_hash = ? AND state = 'pending'
         UNION SELECT family, unit FROM asks INDEXED BY asks_waits WHERE waits = ?`, input_hash, key,
      ),
      givenUp: (work_id) => sql.all<Record<string, unknown>>(`SELECT ${ASKS} FROM asks INDEXED BY asks_given_up WHERE work_id = ? AND state = 'given-up' ORDER BY family, item, prompt`, work_id).map(askRow),
      unhideables: (work_id) => sql.all<{ why: string; count: number }>(
        "SELECT why, COUNT(*) AS count FROM asks_unhideable INDEXED BY asks_unhideable_work WHERE work_id = ? GROUP BY why ORDER BY why", work_id),
      left: (work_id, starts) => {
        const all = leftOf(sql, work_id, starts);
        if (all === null) return null;
        const off = sql.all<{ prompt: string; at_key: number }>(
          `SELECT a.prompt, a.at_key FROM asks_unhideable u INDEXED BY asks_unhideable_work JOIN asks a ON a.family = u.family AND a.item = u.item AND a.prompt = u.prompt
           WHERE u.work_id = ? AND a.state = 'pending'`, work_id,
        );
        if (off.length === 0) return all;
        return all.map((row) => {
          const mine = off.filter((each) => each.prompt === row.prompt);
          return { prompt: row.prompt, total: row.total - mine.length, from: starts.map((start, index) => row.from[index]! - mine.filter((each) => each.at_key >= start).length) };
        }).filter((row) => row.total > 0);
      },
      filling: () => leftMark(sql) !== null,
      fill: () => fillLeft(sql),
      put: (row) => {
        write();
        const columns = [
          row.version, row.input_hash, row.unit, row.work_id, row.at_key, row.started ? 1 : 0, row.waits, row.retry_ms, row.given_up, row.unhideable, row.state,
        ];
        const stored = sql.get<Record<string, unknown>>(
          `SELECT prompt_version, input_hash, unit, work_id, at_key, started, waits, retry_ms, given_up, ${UNHIDEABLE} AS unhideable, state FROM asks WHERE family = ? AND item = ? AND prompt = ?`,
          row.family, row.item, row.prompt,
        );
        if (stored !== undefined && Object.values(stored).every((value, index) => value === columns[index])) return false;
        if (stored?.state === "pending") countAsks(sql, -1, "asks", ONE_ASK, row.family, row.item, row.prompt);
        sql.run(
          `INSERT INTO asks (${ASK_COLUMNS}) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (family, item, prompt) DO UPDATE SET prompt_version = excluded.prompt_version, input_hash = excluded.input_hash, unit = excluded.unit,
             work_id = excluded.work_id, at_key = excluded.at_key, started = excluded.started, waits = excluded.waits, retry_ms = excluded.retry_ms,
             given_up = excluded.given_up, state = excluded.state`,
          row.family, row.item, row.prompt, ...columns.filter((_, index) => index !== UNHIDEABLE_AT),
        );
        if (row.unhideable === null) sql.run(`DELETE FROM asks_unhideable WHERE ${ONE_ASK}`, row.family, row.item, row.prompt);
        else {
          sql.run(
            `INSERT INTO asks_unhideable (family, item, prompt, work_id, unit, why) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (family, item, prompt) DO UPDATE SET work_id = excluded.work_id, unit = excluded.unit, why = excluded.why`,
            row.family, row.item, row.prompt, row.work_id, row.unit, row.unhideable,
          );
        }
        if (row.state === "pending") {
          countAsks(sql, 1, "asks", ONE_ASK, row.family, row.item, row.prompt);
          sql.moved.pending.push({ family: row.family, item: row.item, reply_key: row.waits, unit: row.unit });
        }
        return true;
      },
      delete: (family, item, prompt) => {
        write();
        if (prompt === undefined) {
          countAsks(sql, -1, "asks", "family = ? AND item = ?", family, item);
          return sql.run("DELETE FROM asks WHERE family = ? AND item = ?", family, item).changes;
        }
        countAsks(sql, -1, "asks", ONE_ASK, family, item, prompt);
        return sql.run(`DELETE FROM asks WHERE ${ONE_ASK}`, family, item, prompt).changes;
      },
      backoff: (family, item, prompt, retry_ms) => {
        write();
        sql.run("UPDATE asks SET retry_ms = ? WHERE family = ? AND item = ? AND prompt = ? AND state = 'pending'", retry_ms, family, item, prompt);
      },
      giveUp: (family, item, prompt, route) => {
        write();
        countAsks(sql, -1, "asks", ONE_ASK, family, item, prompt);
        sql.run(`UPDATE asks SET state = 'given-up', given_up = ?, retry_ms = NULL WHERE ${ONE_ASK} AND state = 'pending'`, route, family, item, prompt);
      },
      unhideable: (family, item, prompt, why) => {
        write();
        sql.run(
          `INSERT INTO asks_unhideable (family, item, prompt, work_id, unit, why) SELECT family, item, prompt, work_id, unit, ? FROM asks WHERE ${ONE_ASK} AND state = 'pending'
           ON CONFLICT (family, item, prompt) DO UPDATE SET why = excluded.why`,
          why, family, item, prompt,
        );
      },
      hideable: (work_id) => {
        write();
        const rows = sql.all<{ family: string; unit: string }>(
          `SELECT DISTINCT family, unit FROM asks_unhideable${work_id === null ? "" : " INDEXED BY asks_unhideable_work WHERE work_id = ?"}`, ...(work_id === null ? [] : [work_id]),
        );
        sql.run(`DELETE FROM asks_unhideable${work_id === null ? "" : " INDEXED BY asks_unhideable_work WHERE work_id = ?"}`, ...(work_id === null ? [] : [work_id]));
        return rows;
      },
      reopen: (family, item, prompt) => {
        write();
        if (sql.run(`UPDATE asks SET state = 'pending', given_up = NULL WHERE ${ONE_ASK} AND state = 'given-up'`, family, item, prompt).changes === 0) return false;
        countAsks(sql, 1, "asks", ONE_ASK, family, item, prompt);
        return true;
      },
    },
    itemRoutes: {
      get: (family, item, prompt) => sql.get<ItemRoute>("SELECT family, item, prompt, route, model FROM item_routes WHERE family = ? AND item = ? AND prompt = ?", family, item, prompt),
      list: () => sql.all<ItemRoute>("SELECT family, item, prompt, route, model FROM item_routes ORDER BY family, item"),
      set: (row) => {
        write();
        sql.run(
          `INSERT INTO item_routes (family, item, prompt, route, model) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (family, item) DO UPDATE SET prompt = excluded.prompt, route = excluded.route, model = excluded.model`,
          row.family, row.item, row.prompt, row.route, row.model,
        );
        if (sql.run(`UPDATE asks SET state = 'pending', given_up = NULL WHERE ${ONE_ASK} AND state = 'given-up'`, row.family, row.item, row.prompt).changes === 1) {
          countAsks(sql, 1, "asks", ONE_ASK, row.family, row.item, row.prompt);
        }
        sql.run(`DELETE FROM asks_unhideable WHERE ${ONE_ASK}`, row.family, row.item, row.prompt);
        sql.run(
          `INSERT INTO dirty_units (family, unit, end_ms, woken) SELECT e.family, e.unit, e.end_ms, 1 FROM extract_items i
             JOIN extracts e ON e.family = i.family AND e.unit = i.unit WHERE i.family = ? AND i.item = ?
           ON CONFLICT DO UPDATE SET woken = 1, marks = marks + 1, error = NULL`,
          row.family, row.item,
        );
      },
    },
    controls: {
      list: () => sql.all<ControlRow>(`SELECT ${COLUMNS.controls} FROM controls ORDER BY target`),
      set: (row) => {
        write();
        sql.run(
          "INSERT INTO controls (target, reason, at_ms, by) VALUES (?, ?, ?, ?) ON CONFLICT (target) DO UPDATE SET reason = excluded.reason, at_ms = excluded.at_ms, by = excluded.by",
          row.target, row.reason, row.at_ms, row.by,
        );
      },
      clear: (target) => {
        write();
        sql.run("DELETE FROM controls WHERE target = ?", target);
      },
    },
    events: {
      append: (row) => {
        write();
        sql.moved.events.add(row.kind);
        return Number(
          sql.run(
            "INSERT INTO events (at_ms, kind, key, detail) VALUES (?, ?, ?, ?)",
            row.at_ms, row.kind, row.key, row.detail === undefined ? null : canonical(row.detail),
          ).lastInsertRowid,
        );
      },
      prune: (now) => {
        write();
        return sql.run("DELETE FROM events WHERE at_ms < ?", now - EVENT_DAYS_MS).changes;
      },
    },
    inbox: {
      since: (day) => sql.all<InboxDay>("SELECT lane, day, deliveries, bytes FROM inbox_days WHERE day >= ? ORDER BY lane, day", day),
      grew: (lane, sealed_ms, bytes) => {
        write();
        sql.run(
          `INSERT INTO inbox_days (lane, day, deliveries, bytes) VALUES (?, ?, 1, ?)
           ON CONFLICT (lane, day) DO UPDATE SET deliveries = deliveries + 1, bytes = bytes + excluded.bytes`,
          lane, Math.floor(sealed_ms / UTC_DAY_MS), bytes,
        );
      },
    },
    custody: { imported: (pass, src) => importedOf(sql, pass, src) },
    meta: {
      get: (key) => sql.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value,
      under: (prefix) =>
        sql.all<{ key: string }>("SELECT key FROM meta WHERE substr(key, 1, length(?)) = ? ORDER BY key", prefix, prefix).map((row) => row.key.slice(prefix.length)),
      set: (key, value) => {
        write();
        sql.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
      },
      delete: (key) => {
        write();
        sql.run("DELETE FROM meta WHERE key = ?", key);
      },
    },
  };
}

export function derived(sql: Sql): Derived {
  const write = () => sql.writing();
  return {
    extracts: {
      get: (family, unit) => {
        const row = sql.get<Raw<ExtractRow>>(`SELECT ${COLUMNS.extracts} FROM extracts WHERE family = ? AND unit = ?`, family, unit);
        return row && extract(row);
      },
      put: (row) => {
        write();
        const days = canonical(row.days);
        const stored = sql.get<{ reading: string; code: string; days: string; end_ms: number | null }>(
          "SELECT reading, code, days, end_ms FROM extracts WHERE family = ? AND unit = ?", row.family, row.unit,
        );
        if (stored !== undefined && stored.reading === row.reading && stored.code === row.code && stored.days === days) return false;
        sql.run(
          `INSERT INTO extracts (family, unit, reading, code, content, start_ms, end_ms, days, items, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (family, unit) DO UPDATE SET reading = excluded.reading, code = excluded.code, content = excluded.content,
             start_ms = excluded.start_ms, end_ms = excluded.end_ms, days = excluded.days, items = excluded.items, seq = excluded.seq`,
          row.family, row.unit, row.reading, row.code, storedText(canonical(row.content)), row.start_ms, row.end_ms, days,
          canonical([...new Set(row.items ?? [])].sort()), row.seq,
        );
        if (stored !== undefined && stored.end_ms !== row.end_ms) unitAsksAt(sql, row.end_ms ?? NEWEST, row.family, row.unit);
        sql.moved.extracts.add(row.family);
        return true;
      },
      delete: (family, unit) => {
        write();
        const row = sql.get<{ days: string; end_ms: number | null }>("DELETE FROM extracts WHERE family = ? AND unit = ? RETURNING days, end_ms", family, unit);
        if (row === undefined) return undefined;
        unitAsksGo(sql, family, unit);
        sql.run("DELETE FROM dirty_units WHERE family = ? AND unit = ?", family, unit);
        sql.moved.extracts.add(family);
        return JSON.parse(row.days) as string[];
      },
      compare: (family) => ({
        changed: sql.all<{ unit: string }>(
          `SELECT n.unit FROM extracts_next n LEFT JOIN extracts e ON e.family = n.family AND e.unit = n.unit
           WHERE n.family = ? AND (e.unit IS NULL OR e.reading <> n.reading OR e.code <> n.code OR e.days <> n.days) ORDER BY n.unit`, family,
        ).map((row) => row.unit),
        gone: sql.all<{ unit: string }>(
          `SELECT e.unit FROM extracts e WHERE e.family = ?
             AND NOT EXISTS (SELECT 1 FROM extracts_next n WHERE n.family = e.family AND n.unit = e.unit) ORDER BY e.unit`, family,
        ).map((row) => row.unit),
      }),
      publish: (family, lists) => {
        write();
        const began = performance.now();
        const written: string[] = [];
        for (const unit of lists.changed) {
          const was = sql.get<{ end_ms: number | null }>("SELECT end_ms FROM extracts WHERE family = ? AND unit = ?", family, unit);
          const row = sql.get<{ end_ms: number | null }>(
            `INSERT INTO extracts (${COLUMNS.extracts}) SELECT ${COLUMNS.extracts} FROM extracts_next n WHERE n.family = ? AND n.unit = ?
               AND NOT EXISTS (SELECT 1 FROM extracts e WHERE e.family = n.family AND e.unit = n.unit AND e.reading = n.reading AND e.code = n.code AND e.days = n.days)
             ON CONFLICT (family, unit) DO UPDATE SET reading = excluded.reading, code = excluded.code, content = excluded.content,
               start_ms = excluded.start_ms, end_ms = excluded.end_ms, days = excluded.days, items = excluded.items, seq = excluded.seq
             RETURNING end_ms`,
            family, unit,
          );
          if (row === undefined) continue;
          written.push(unit);
          if (was !== undefined && was.end_ms !== row.end_ms) unitAsksAt(sql, row.end_ms ?? NEWEST, family, unit);
        }
        const copied = performance.now();
        const deleted: string[] = [];
        for (const unit of lists.gone) {
          const row = sql.get<{ unit: string }>(
            `DELETE FROM extracts WHERE family = ? AND unit = ?
               AND NOT EXISTS (SELECT 1 FROM extracts_next WHERE family = ? AND unit = ?)
               AND NOT EXISTS (SELECT 1 FROM extracts_aside WHERE family = ? AND unit = ?) RETURNING unit`,
            family, unit, family, unit, family, unit,
          );
          if (row === undefined) continue;
          deleted.push(unit);
          unitAsksGo(sql, family, unit);
          sql.run("DELETE FROM dirty_units WHERE family = ? AND unit = ?", family, unit);
        }
        sql.moved.extracts.add(family);
        return { written, deleted, copy_ms: Math.round(copied - began), gone_ms: Math.round(performance.now() - copied) };
      },
      units: (family) => sql.all<{ unit: string; days: string }>("SELECT unit, days FROM extracts WHERE family = ? ORDER BY unit", family)
        .map((row) => ({ unit: row.unit, days: JSON.parse(row.days) as string[] })),
      unitsOn: (family, from, to) => sql.all<{ unit: string }>(
        "SELECT DISTINCT unit FROM extract_days INDEXED BY extract_days_day WHERE family = ? AND day >= ? AND day <= ? ORDER BY unit", family, from, to,
      ).map((row) => row.unit),
      days: () => sql.all<{ day: string }>("SELECT DISTINCT day FROM extract_days ORDER BY day").map((row) => row.day),
      aside: {
        put: (family, unit, error, at_ms) => {
          write();
          sql.run(
            "INSERT INTO extracts_aside (family, unit, error, at_ms) VALUES (?, ?, ?, ?) ON CONFLICT (family, unit) DO UPDATE SET error = excluded.error, at_ms = excluded.at_ms",
            family, unit, error, at_ms,
          );
        },
        built: (family, unit) => {
          write();
          sql.run("DELETE FROM extracts_aside WHERE family = ? AND unit = ?", family, unit);
        },
        list: (family) => family === undefined
          ? sql.all<AsideRow>("SELECT family, unit, error, at_ms FROM extracts_aside ORDER BY family, unit")
          : sql.all<AsideRow>("SELECT family, unit, error, at_ms FROM extracts_aside WHERE family = ? ORDER BY unit", family),
        clear: (family) => {
          write();
          sql.run("DELETE FROM extracts_aside WHERE family = ?", family);
        },
      },
    },
    next: {
      put: (row) => {
        write();
        sql.run(
          `INSERT INTO extracts_next (${COLUMNS.extracts}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (family, unit) DO UPDATE SET reading = excluded.reading, code = excluded.code, content = excluded.content,
             start_ms = excluded.start_ms, end_ms = excluded.end_ms, days = excluded.days, items = excluded.items, seq = excluded.seq`,
          row.family, row.unit, row.reading, row.code, storedText(canonical(row.content)), row.start_ms, row.end_ms, canonical(row.days),
          canonical([...new Set(row.items ?? [])].sort()), row.seq,
        );
      },
      delete: (family, unit) => {
        write();
        sql.run("DELETE FROM extracts_next WHERE family = ? AND unit = ?", family, unit);
      },
      any: (family) => sql.get("SELECT 1 FROM extracts_next WHERE family = ? LIMIT 1", family) !== undefined,
      units: (family, after, limit) => (after === null
        ? sql.all<{ unit: string }>("SELECT unit FROM extracts_next WHERE family = ? ORDER BY unit LIMIT ?", family, limit)
        : sql.all<{ unit: string }>("SELECT unit FROM extracts_next WHERE family = ? AND unit > ? ORDER BY unit LIMIT ?", family, after, limit)
      ).map((row) => row.unit),
      empty: (family, limit) => {
        write();
        const units = sql.all<{ unit: string }>("SELECT unit FROM extracts_next WHERE family = ? ORDER BY unit LIMIT ?", family, limit);
        for (const { unit } of units) sql.run("DELETE FROM extracts_next WHERE family = ? AND unit = ?", family, unit);
        return units.length;
      },
      clear: (family) => {
        write();
        return Number(sql.run("DELETE FROM extracts_next WHERE family = ?", family).changes);
      },
    },
    dayUnits: {
      put: (day, units) => {
        write();
        const stored = new Map(sql.all<{ family: string; unit: string; reading: string; code: string; shown: number }>(
          "SELECT family, unit, reading, code, shown FROM day_units WHERE day = ?", day,
        ).map((row) => [`${row.family}\0${row.unit}`, row]));
        let wrote = false;
        for (const unit of units) {
          const name = `${unit.family}\0${unit.unit}`;
          const found = stored.get(name);
          stored.delete(name);
          const shown = unit.shown ? 1 : 0;
          if (found !== undefined && found.reading === unit.reading && found.code === unit.code && found.shown === shown) continue;
          sql.run(
            `INSERT INTO day_units (family, unit, day, reading, code, shown) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (family, unit, day) DO UPDATE SET reading = excluded.reading, code = excluded.code, shown = excluded.shown`,
            unit.family, unit.unit, day, unit.reading, unit.code, shown,
          );
          wrote = true;
        }
        for (const gone of stored.values()) sql.run("DELETE FROM day_units WHERE family = ? AND unit = ? AND day = ?", gone.family, gone.unit, day);
        return wrote || stored.size > 0;
      },
      stale: (day) => sql.get(
        `SELECT 1 FROM day_units d LEFT JOIN extracts e ON e.family = d.family AND e.unit = d.unit
         WHERE d.day = ? AND (coalesce(e.reading, '') <> d.reading OR coalesce(e.code, '') <> d.code) LIMIT 1`, day,
      ) !== undefined,
      days: (family, unit) => sql.all<{ day: string }>("SELECT day FROM day_units WHERE family = ? AND unit = ? ORDER BY day", family, unit).map((row) => row.day),
    },
    days: {
      put: (day, inputs, counts) => {
        write();
        const text = canonical(counts as unknown as Json);
        const stored = sql.get<{ inputs: string; counts: string }>("SELECT inputs, counts FROM days WHERE day = ?", day);
        if (stored !== undefined && stored.inputs === inputs && stored.counts === text) return false;
        sql.run("INSERT INTO days (day, inputs, counts) VALUES (?, ?, ?) ON CONFLICT (day) DO UPDATE SET inputs = excluded.inputs, counts = excluded.counts", day, inputs, text);
        return true;
      },
      delete: (day) => {
        write();
        return sql.run("DELETE FROM days WHERE day = ?", day).changes > 0;
      },
      page: (from, to, after, limit) => sql.all<{ day: string; inputs: string; counts: string }>(...dayRange("day, inputs, counts", from, to, after, limit))
        .map((row) => ({ day: row.day, inputs: row.inputs, counts: JSON.parse(row.counts) as DayCounts })),
      dates: (from, to, after, limit) => sql.all<{ day: string }>(...dayRange("day", from, to, after, limit)).map((row) => row.day),
    },
    enrichments: {
      get: (family, item, prompt) => {
        const row = sql.get<Record<string, unknown>>(`SELECT ${COLUMNS.enrichments} FROM enrichments WHERE family = ? AND item = ? AND prompt = ?`, family, item, prompt);
        return row && enrichment(row);
      },
      list: (family, filter = {}) => {
        const where = ["family = ?"];
        const params: string[] = [family];
        if (filter.state !== undefined) {
          where.push("state = ?");
          params.push(filter.state);
        }
        if (filter.item !== undefined) {
          where.push("item = ?");
          params.push(filter.item);
        }
        return sql.all<Record<string, unknown>>(`SELECT ${COLUMNS.enrichments} FROM enrichments WHERE ${where.join(" AND ")} ORDER BY item, prompt`, ...params).map(enrichment);
      },
      put: (row) => {
        write();
        const content = canonical(row.content);
        const columns = [row.input_hash, row.reply_key, row.reused_from, content, row.state];
        const stored = sql.get<Record<string, unknown>>(
          "SELECT input_hash, reply_key, reused_from, content, state FROM enrichments WHERE family = ? AND item = ? AND prompt = ?",
          row.family, row.item, row.prompt,
        );
        if (stored !== undefined && Object.values(stored).every((value, index) => value === columns[index])) return false;
        sql.run(
          `INSERT INTO enrichments (family, item, prompt, input_hash, reply_key, reused_from, content, state, unit, at_ms, started, model)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL)
           ON CONFLICT (family, item, prompt) DO UPDATE SET input_hash = excluded.input_hash, reply_key = excluded.reply_key,
             reused_from = excluded.reused_from, content = excluded.content, state = excluded.state`,
          row.family, row.item, row.prompt, ...columns,
        );
        return true;
      },
      delete: (family, item, prompt) => {
        write();
        return prompt === undefined
          ? sql.run("DELETE FROM enrichments WHERE family = ? AND item = ?", family, item).changes
          : sql.run("DELETE FROM enrichments WHERE family = ? AND item = ? AND prompt = ?", family, item, prompt).changes;
      },
    },
  };
}
