import type Database from "better-sqlite3";
import { damaged, hostFault, outOfRoom, type Room, type BlobStore, type HomeDb, type HomeFolder, type JobRow, type Json, type ReadTables, type Secrets, type StorageOrigin, type Tx } from "@lifestreamprotocol/core";
import { errorText, jobError, type JobError } from "./job-error.js";
import type { Family } from "@lifestreamprotocol/families";
import type { Asker } from "@lifestreamprotocol/model";
import type { NamedLevel } from "@lifestreamprotocol/privacy";
import type { CopyAnswer, CopyAsked } from "./copies.js";
import type { DriveHalf } from "./detector.js";
import type { Calls } from "./pick.js";
import type { Routing } from "./models.js";
import { catalogOf } from "./catalog.js";
import type { Reach } from "./principals.js";
import type { Loaded, Registry } from "./registry.js";
import type { Settings } from "./settings.js";
import type { Network, Since, Stated } from "./stated.js";


export const LANE = { live: 0, polls: 1, planning: 2, history: 3, backfill: 5 } as const;

export const POLL_PARKED = "poll-parked:";

export const pauseTarget = (connector: string, history = false): string => `pause:${connector}${history ? ":history" : ""}`;

export function covers(targets: ReadonlySet<string>, job: { kind: string; key: string; connector: string | null }): string | null {
  for (const target of ["home", `kind:${job.kind}`, `${job.kind}:${job.key}`, ...(job.connector === null ? [] : [pauseTarget(job.connector)])]) {
    if (targets.has(target)) return target;
  }
  return null;
}

export function jobPaused(read: { tables: Pick<ReadTables, "controls"> }, kind: "people" | "places"): boolean {
  return covers(new Set(read.tables.controls.list().map((control) => control.target)), { kind, key: kind, connector: null }) !== null;
}

export type Crossing = "home" | Reach;

export function homeNetwork(read: Pick<ReadTables, "devices"> | null, stated: Stated | null): HomeNetwork {
  if (stated === null) return { unit: null, metered: true, since_ms: null };
  let newest: { unit: string; network: Since<Network> } | null = null;
  for (const [unit, each] of Object.entries(stated)) {
    if (each.network === null || (read?.devices.get(unit)?.retired_ms ?? null) !== null) continue;
    if (newest === null || each.network.since_ms > newest.network.since_ms) newest = { unit, network: each.network };
  }
  return { unit: newest?.unit ?? null, metered: newest !== null && newest.network.value !== "all", since_ms: newest?.network.since_ms ?? null };
}

export interface HomeNetwork {
  readonly unit: string | null;
  readonly metered: boolean;
  readonly since_ms: number | null;
}

export function historyGate(read: Pick<ReadTables, "controls" | "devices"> | null, stated: Stated | null, room: Room): HistoryGate {
  const paused = new Set(read?.controls.list().map((control) => control.target) ?? []);
  const disk = room !== "ok";
  const { metered } = homeNetwork(read, stated);
  return {
    disk,
    metered,
    may: (connector, crossing) => !disk && !(metered && crossing !== "loopback") && !paused.has("home")
      && (connector === null || !historyPaused(paused, connector)),
  };
}

export interface HistoryGate {
  readonly disk: boolean;
  readonly metered: boolean;
  may(connector: string | null, crossing: Crossing): boolean;
}

export function historyPaused(paused: ReadonlySet<string>, connector: string): boolean {
  return paused.has(pauseTarget(connector)) || paused.has(pauseTarget(connector, true));
}

export function connectorOfJob(registry: Pick<Registry, "connectors" | "labelers">, read: Pick<ReadTables, "sources">, kind: string, key: string): string | null {
  const catalog = catalogOf(registry.connectors);
  if (kind === "poll") return catalog.ofAcquirer(key)?.id ?? null;
  if (kind === "import") return catalog.of(read.sources.get(key) ?? { id: key })?.id ?? null;
  if (kind === "label" || kind === "install") {
    const source = registry.labelers?.find((labeler) => labeler.name === key)?.source;
    return source === undefined ? null : catalog.of(read.sources.get(source) ?? { id: source })?.id ?? null;
  }
  return null;
}

export interface Pause {
  target: string;
  by: string;
  reason: string;
  at_ms: number;
  holds?: string[];
}

export function pauses(db: Database.Database): Pause[] {
  return (db.prepare("SELECT target, by, reason, at_ms FROM controls ORDER BY target").all() as Pause[]).map((pause) => {
    const holds = pause.target === "kind:poll" ? "SELECT acquirer FROM polls ORDER BY acquirer"
      : pause.target === "kind:import" ? "SELECT id FROM sources ORDER BY id" : null;
    return holds === null ? pause : { ...pause, holds: db.prepare(holds).pluck().all() as string[] };
  });
}

export const LIVE_MS = 3_600_000;
export const RECENT_MS = 2 * 86_400_000;

export interface Task<Data = unknown> {
  job: number;
  kind: string;
  key: string;
  lane: number;
  now_ms: number;
  data: Data;
}

export interface Driving {
  readonly door: string;
  readonly pass: string;
}

export interface RunnerDriving {
  readonly door: string;
  readonly call: string;
  readonly drive: string;
}

export interface HelperEnv {
  folder: HomeFolder;
  machine: string;
  settings: Settings;
  registry: Registry;
  stations: Driving;
  drive(): DriveHalf;
  db: HomeDb;
  blobs: BlobStore;
  asker(): Asker;
  secrets(): Secrets;
  readonly signal: AbortSignal;
  committed(): Promise<void>;
  copy(asked: CopyAsked): Promise<CopyAnswer>;
  epoch(): number;
  reading(rows: number | null): void;
}

export interface Running<State = unknown> {
  job: JobRow;
  state: State;
  stale?: true;
  holds?: readonly string[];
  again?: { at_ms: number; lane: number };
  refused?: true;
  due?: number;
}

export function heldBy(runs: Iterable<Running>): string[] {
  return [...runs].flatMap((run) => run.holds ?? []);
}

export function servedLane(running: Running): number {
  return Math.min(running.job.lane, running.due ?? Infinity);
}

export function nextRun(running: Running): { lane: number; at_ms?: number } | null {
  const lane = Math.min(running.again?.lane ?? Infinity, running.due ?? Infinity);
  if (lane === Infinity) return null;
  return running.again === undefined ? { lane } : { lane, at_ms: running.again.at_ms };
}

export interface Main {
  readonly folder: HomeFolder;
  readonly settings: Settings;
  readonly families: ReadonlyMap<string, Family>;
  readonly registry: Loaded;
  readonly blobs: Pick<BlobStore, "has" | "stored">;
  readonly calls: Pick<Calls, "take" | "sent" | "release">;
  readonly copies: { level(work_id: string | null): NamedLevel; drop(id: number): void };
  routing(tx: Tx): Routing;
  now(): number;
  readonly ending: number;
  readonly room: Room;
  readonly stated: Stated | null;
  log(line: Record<string, Json>): void;
  facesTurned(tx: Tx): void;
  polled(left: { bytes: number; rows: number } | null): void;
}

export interface Slice {
  settle?(): void;
  work(tx: Tx): void;
  after?(): void;
}

export interface Kind<Data = unknown, Chunk = unknown, Result = unknown, State = unknown> {
  readonly dies: boolean;
  begin?(main: Main, tx: Tx, job: JobRow): { data: Data; state: State; holds?: readonly string[] } | null;
  helper(env: HelperEnv, task: Task<Data>): AsyncGenerator<Chunk, Result, undefined>;
  chunk?(main: Main, running: Running<State>, chunk: Chunk): Slice[];
  done(main: Main, tx: Tx, running: Running<State>, result: Result): void;
  failed?(main: Main, tx: Tx, job: JobRow, state: State | undefined, error: string): void;
  quiet?(running: Running<State>, rows: number): Result | null;
  stopped?(main: Main, tx: Tx, running: Running<State>): void;
}

export function storageError(error: unknown): error is { code: string; database?: StorageOrigin } {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && (/^SQLITE_(?:IOERR|FULL|CANTOPEN)/u.test(code) || damaged(error));
}

export function homeFault(error: unknown): boolean {
  return storageError(error) || hostFault(error) || outOfRoom(error);
}

export { errorText, jobError, type JobError };

export function restRefusal(rows: number, error: unknown): string {
  return `after ${rows.toLocaleString("en-US")} rows: ${error instanceof Error ? `${error.name}: ${errorText(error)}` : String(error)}`;
}

export function readerWords(refusal: string): string | null {
  return /^after [\d,]+ rows: Refused: ([\s\S]+)$/u.exec(refusal)?.[1]?.trim() || null;
}
