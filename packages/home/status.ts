import { folderFindings, handed } from "./folders.js";
import { readImports } from "./imports-report.js";
import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Connector, RefusedStation } from "@lifestreamprotocol/connect";
import { addDays, civilDay, dayBounds, diskSpace, homeSecrets, readTables, RELEASE, roomOf, spare, UNREAD, UTC_DAY_MS, WAITING, type DaySettings, type Form, type HomeFolder, type JsonObject, type Room } from "@lifestreamprotocol/core";
import { coming, type Coming } from "@lifestreamprotocol/families";
import { ledgerFileOf, openLedger, priced, type Ledger, type Spent } from "@lifestreamprotocol/model";
import { homeNetwork, pauses, type Pause } from "./jobs.js";
import { screenStanding } from "./screen-index.js";
import { SCREEN_INDEX, screenState } from "./screen-job.js";
import { RECORD_INDEX } from "./search.js";
import { SearchIndex } from "./search-index.js";
import { LOCKED_SINCE, OTHER_MAC_KEY, readVault, recoverySaved, REFUSED_AT, UNSEALED, vaultPath, type VaultFile } from "./vault.js";
import { KNOCK_MS, KNOCKS } from "./knocks.js";
import { nameKey } from "./devices.js";
import { machine } from "./machine.js";
import { oldCopy } from "./move.js";
import { HELD_META } from "./prompts.js";
import { HIDING_META, type HidingWaits } from "./copies.js";
import { reachNeed } from "./funnel.js";
import { AT_REST_META, restConditions, type AtRest } from "./at-rest.js";
import { driveOf, LOOSE_META, type LooseFolder } from "./lifecycle.js";
import { phonePasses, readPrincipals, type Principal } from "./principals.js";
import { effective } from "./settings.js";
import { switchOf, type Held } from "./catalog.js";
import { listed, photoUnits, readConnectors, shownNeeds, streamActs, streamFold, type ConnectorsInput, type FoldInput } from "./connectors.js";
import { readProcessing, worksOn, type ProcessingInput, type WorkState } from "./processing.js";
import type { Stated } from "./stated.js";
import { readRest, REST_ENTRIES, STORED_REST } from "./stored.js";
import { gapOf, waitingKey, type Waiting } from "./through.js";
import type { Act, History, Need, Raised, StreamsReport } from "./streams-report.js";
import { amount, CAP, filesWords, sizeWords, when } from "./stream-words.js";
import type { OpsSettings } from "./verbs/context.js";
import { INTENT_META, intentOf } from "./verbs/erase.js";
import { CLI } from "./cli-name.js";
import { startOf, type StartSettings } from "./start.js";

export type { Act, Need, Raised } from "./streams-report.js";
export { offeredSource } from "./catalog.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const HANDOVER_MS = 24 * HOUR;
const NOISE_FLOOR = 50;
const EXAMPLES = 5;
const OPERATIONS = ["repair", "undo", "erase", "rebuild-extracts", "rebuild-enrichments", "rebuild-source"];

export const RETRY_MS = 5 * 60_000;
export const retryOf = (refresh_ms: number): number => Math.min(refresh_ms, RETRY_MS);
const SEAL_WAIT_MS = 10 * 60_000;
const DAYS_LEFT_NOTICE = 30;

export const FREE_BYTES = "disk:free";
export const CATCH_UP = "disk:catch-up";
export const LOG_BEHIND = "log-behind";
export interface LogBehind {
  since_ms: number;
}
const FREE_DAYS = 7;

export interface DiskReading {
  disk: string;
  at_ms: number;
  bytes: number;
}

export interface FreeDay {
  day: string;
  disk: string;
  at_ms: number;
  bytes: number;
  catch_up: number;
}

export function readDisk(root: string, at_ms: number, space = diskSpace(root)): DiskReading {
  return { disk: `${realpathSync(root)} ${space.total_bytes}`, at_ms, bytes: space.free_bytes };
}

export function keepDay(days: readonly FreeDay[], today: FreeDay): FreeDay[] {
  return [...days.filter((each) => each.disk === today.disk && each.day !== today.day), today].slice(-FREE_DAYS);
}

export interface Forecast {
  free_bytes: number;
  coming: number;
  steady_bytes_a_day: number | null;
  days_left: number | null;
}

export function daysLeft(days: readonly FreeDay[], now: DiskReading, caught: number, coming: number): { steady_bytes_a_day: number | null; days_left: number | null } {
  const kept = days.filter((each) => each.disk === now.disk);
  const first = kept[0];
  const span = first === undefined ? 0 : (now.at_ms - first.at_ms) / UTC_DAY_MS;
  if (first === undefined || span < 1) return { steady_bytes_a_day: null, days_left: null };
  const catchUp = kept.slice(1).reduce((sum, each) => sum + each.catch_up, caught);
  const steady = (first.bytes - now.bytes - catchUp) / span;
  if (!(steady > 0)) return { steady_bytes_a_day: null, days_left: null };
  return { steady_bytes_a_day: Math.round(steady), days_left: Math.floor(spare(now.bytes - coming) / steady) };
}

export function forecast(db: Database.Database, now: DiskReading, coming: number): Forecast {
  const meta = db.prepare("SELECT value FROM meta WHERE key = ?").pluck();
  const kept = meta.get(FREE_BYTES) as string | undefined;
  const fall = daysLeft(kept === undefined ? [] : (JSON.parse(kept) as FreeDay[]), now, Number(meta.get(CATCH_UP) ?? 0), coming);
  return { free_bytes: now.bytes, coming, ...fall };
}

export function photosStart(settings: StartSettings, connectors: readonly Connector[], now_ms: number): number | null {
  const photos = connectors.find((connector) => connector.phone?.library === true || connector.mac?.library === true);
  return photos === undefined ? null : startOf(settings, photos, now_ms).ms;
}

export function photosComing(db: Database.Database, start_ms: number | null): Coming {
  return coming(photoUnits(db), start_ms);
}

export type DiskSpace = typeof diskSpace;

export interface DiskRead {
  disk: DiskReading;
  total_bytes: number;
  photos: Coming;
}

export function readDiskOf(db: Database.Database, root: string, now_ms: number, start_ms: number | null, measure: DiskSpace = diskSpace): DiskRead {
  const space = measure(root);
  return { disk: readDisk(root, now_ms, space), total_bytes: space.total_bytes, photos: photosComing(db, start_ms) };
}

const diskOf = (db: Database.Database, options: { folder: HomeFolder; now_ms: number; settings: StartSettings; connectors: readonly Connector[]; space?: DiskSpace }): DiskRead =>
  readDiskOf(db, options.folder.root, options.now_ms, photosStart(options.settings, options.connectors, options.now_ms), options.space);
const INBOX_WEEKS = 4;

export interface Notice {
  id: string;
  what: string;
  since_ms: number | null;
}

export const POLL_STARTED = "poll-started:";

export const DROPPED = "drop:";

export interface Dropped {
  readonly reason: string;
  readonly at_ms: number;
}

function prefixed(db: Database.Database, prefix: string): { key: string; value: string }[] {
  return db.prepare("SELECT key, value FROM meta WHERE key >= ? AND key < ? ORDER BY key").all(prefix, `${prefix.slice(0, -1)};`) as { key: string; value: string }[];
}

const own = (id: string, state: Need["state"], words: string, since_ms: number | null = null, acts: Act[] = []): Raised =>
  ({ id, state, reason: null, words, since_ms, next_ms: null, acts, detail: null, connector: null, copy: null, unit: null, at: null });

const STORAGE: Act[] = [{ do: "storage", label: "Free up space" }];

interface Found {
  needs: Raised[];
  notices: Notice[];
}

export interface SourceToday {
  source: string;
  deliveries: number;
  imports: number;
  counts: Record<string, number>;
  changed_paths: Record<string, number>;
  likely_noise: { path: string; count: number; of: number }[];
  read_through_ms: number | null;
}

export interface FamilyToday {
  family: string;
  runs: Record<string, { runs: number; counts: Record<string, number> }>;
  spend: Spent;
}

export interface OperationToday {
  run: number;
  kind: string;
  subject: string;
  started_ms: number;
  counts: Record<string, unknown>;
}

export interface RenderToday {
  runs: number;
  days: number;
  written: number;
  current: number;
  set_aside: number;
}

export interface StatusReport {
  release: string;
  generation: string | null;
  at_ms: number;
  day: string;
  needs: Need[];
  notices: Notice[];
  today: { sources: SourceToday[]; families: FamilyToday[]; render: RenderToday; operations: OperationToday[] };
  works: WorkState[];
  running: {
    lanes: { lane: number; queued: number; running: number; due_ms: number | null }[];
    jobs: { kind: string; key: string; lane: number; started_ms: number | null; progress: unknown }[];
    repairs: { run: number; kind: string; subject: string; state: string; counts: Record<string, unknown> }[];
    rebuilds: string[];
  };
  paused: Pause[];
  inbox: { lanes: { lane: string; weeks: number[] }[]; since: string | null };
  search: { seq: number; of: number; bytes: number; building: { done: number; of: number } | null; unresolved: number | null } | null;
  screen: { seq: number; of: number; indexed_through: number | null; bytes: number; vectors_bytes: number; building: { done: number; of: number } | null } | null;
  disk: { [K in keyof Forecast]: Forecast[K] | null };
  old_copy: { path: string; bytes: number } | null;
  imports: { kind: string; id: string; state: string; line: string }[];
  privacy: { ready: boolean; line: string | null };
}

export interface StatusOptions {
  folder: HomeFolder;
  now_ms: number;
  settings: OpsSettings;
  connectors: readonly Connector[];
  families: ProcessingInput["families"];
  ledger: Ledger | null;
  door?: string | null;
  stated?: Stated | null;
  refused?: readonly RefusedStation[];
  space?: DiskSpace;
}

export function needs(db: Database.Database | null, options: StatusOptions, read?: DiskRead): Need[] {
  if (db === null) return listed(null, homeOwn(null, options).needs);
  return db.transaction(() => {
    const disk = read ?? diskOf(db, options);
    return listed(db, streamFold(db, foldOf(options, disk)).needs, importsOf(db, options, disk).needs, homeOwn(db, options, disk).needs);
  })();
}

export function offered(db: Database.Database | null, options: StatusOptions): Act[] {
  if (db === null) return homeOwn(null, options).needs.flatMap((need) => need.acts);
  return db.transaction(() => {
    const disk = diskOf(db, options);
    return [...streamActs(db, foldOf(options, disk)), ...[...importsOf(db, options, disk).needs, ...homeOwn(db, options, disk).needs].flatMap((need) => need.acts)];
  })();
}

const importsOf = (db: Database.Database, options: StatusOptions, read: DiskRead) => readImports(db, {
  folder: options.folder, now_ms: options.now_ms, connectors: options.connectors, free_bytes: read.disk.bytes,
  max_bundle_bytes: options.settings.door.max_bundle_bytes, day: options.settings.day, stated: options.stated ?? null,
});

const foldOf = (options: StatusOptions, read: DiskRead): FoldInput => ({
  folder: options.folder, now_ms: options.now_ms, settings: options.settings, registry: { connectors: options.connectors }, stated: options.stated ?? null, refused: options.refused ?? [],
  free_bytes: read.disk.bytes, photos: read.photos,
});

function homeOwn(db: Database.Database | null, options: StatusOptions, read?: DiskRead): Found {
  const { folder: { root }, now_ms, settings } = options;
  const found: Found = { needs: [], notices: [] };
  if (options.door !== undefined && options.door !== null) {
    found.needs.push(own("door", "broken", "Can't reach Lifestream"));
    found.notices.push({ id: "door", what: `nothing answers at ${options.door}`, since_ms: null });
  }
  try {
    for (const notice of effective(options.folder).notices) found.notices.push({ id: `settings:${notice.key}`, what: notice.what, since_ms: null });
  } catch (error) {
    found.notices.push({ id: "settings", what: `settings.json does not read: ${(error as Error).message}. The running home goes on with what it read before; the next start stops on it`, since_ms: null });
  }
  if (db === null) {
    found.needs.push(own("storage", "broken", "Lifestream's database is missing"));
    found.notices.push({ id: "storage", what: `home.db cannot be opened: no home database at ${join(root, "home.db")}`, since_ms: null });
    return found;
  }
  const folders = folderFindings(root);
  found.needs.push(...folders.needs);
  found.notices.push(...folders.notices);
  db.transaction(() => {
    const disk = read ?? diskOf(db, options);
    const passes = readPrincipals(options.folder).principals;
    homeChecks(db, found, root, passes, settings, options.connectors, now_ms, disk);
    limitNeeds(db, found, root, passes, options.stated ?? null, roomOf(disk.disk.bytes));
    reachNeeds(db, found);
    restNeeds(db, found, options.folder.form);
    if (options.ledger !== null) ledgerNotices(options.ledger, found, now_ms);
  })();
  return found;
}

export function readStreams(db: Database.Database, input: Omit<ConnectorsInput, "needs" | "free_bytes" | "photos"> & Omit<StatusOptions, "connectors" | "families">): StreamsReport {
  return db.transaction((): StreamsReport => {
    const read = diskOf(db, { ...input, connectors: input.registry.connectors });
    return readConnectors(db, { ...input, needs: homeOwn(db, { ...input, connectors: input.registry.connectors, families: input.registry.families }, read).needs, free_bytes: read.disk.bytes, photos: read.photos });
  })();
}

export function readHistories(db: Database.Database, options: StatusOptions): ReadonlyMap<string, History> {
  return streamFold(db, foldOf(options, diskOf(db, options))).histories;
}

export function withLedger<T>(folder: HomeFolder, read: (ledger: Ledger | null) => T): T {
  if (!existsSync(ledgerFileOf(folder.root))) return read(null);
  const ledger = openLedger(folder, { mode: "read" });
  try {
    return read(ledger);
  } finally {
    ledger.close();
  }
}

export function readStatus(db: Database.Database | null, options: StatusOptions): StatusReport {
  const { folder, now_ms, settings } = options;
  const { root } = folder;
  const day = civilDay(now_ms, settings.day);
  const since = dayBounds(day, settings.day).start_ms;
  const report: StatusReport = {
    release: RELEASE, generation: handed(root)?.start ?? null, at_ms: now_ms, day, needs: [], notices: [], today: { sources: [], families: [], render: { runs: 0, days: 0, written: 0, current: 0, set_aside: 0 }, operations: [] },
    works: [], running: { lanes: [], jobs: [], repairs: [], rebuilds: [] }, paused: [], inbox: { lanes: [], since: null }, search: null, screen: null,
    disk: { free_bytes: null, coming: null, steady_bytes_a_day: null, days_left: null }, old_copy: oldCopy(machine(), root), imports: [],
    privacy: { ready: true, line: null },
  };
  if (db === null) return { ...report, ...((found) => ({ needs: shownNeeds(listed(null, found.needs)), notices: found.notices }))(homeOwn(null, options)) };
  const top = db.transaction(() => {
    const read = diskOf(db, options);
    const found = homeOwn(db, options, read);
    const imports = importsOf(db, options, read);
    const streams = streamFold(db, foldOf(options, read));
    report.needs = shownNeeds(listed(db, streams.needs, imports.needs, found.needs));
    report.notices = found.notices;
    report.paused = pauses(db);
    report.today.sources = sourcesToday(db, since);
    report.today.render = renderToday(db, since);
    report.today.operations = (db.prepare(`SELECT id AS run, kind, subject, started_ms, counts FROM runs
      WHERE started_ms >= ? AND kind IN (${OPERATIONS.map(() => "?").join(", ")}) ORDER BY id`).all(since, ...OPERATIONS) as
      (Omit<OperationToday, "counts"> & { counts: string | null })[]).map((row) => ({ ...row, counts: row.counts === null ? {} : JSON.parse(row.counts) }));
    const families = familiesToday(db, since);
    if (options.ledger !== null) ledgerReads(options.ledger, families, since, priced(settings.model.transports));
    report.today.families = [...families.values()].sort((left, right) => left.family.localeCompare(right.family));
    const waits = JSON.parse(readTables(db).meta.get(HIDING_META) ?? "{}") as HidingWaits;
    const waiting = waits.all ?? waits.names ?? null;
    report.privacy = { ready: waiting === null, line: waiting };
    report.works = worksOn(readProcessing(readTables(db), options.ledger?.rates(now_ms) ?? null,
      { connectors: options.connectors, families: options.families, histories: streams.histories, blocks: settings.connectors, defaults: settings.defaults, runners: settings.runners, day: settings.day, now_ms, privacy: settings.privacy }));
    running(db, report);
    report.inbox = inboxGrowth(db, now_ms);
    report.disk = forecast(db, read.disk, read.photos.bytes);
    report.imports = imports.imports
      .flatMap((kind) => kind.held.map((held) => ({ kind: kind.kind, id: held.id, state: held.health.state, line: held.line })));
    return (db.prepare("SELECT coalesce(max(seq), 0) AS seq FROM statements").get() as { seq: number }).seq;
  })();
  report.search = searchStatus(folder, top);
  report.screen = screenStatus(folder, top);
  return report;
}

const ROOM_WORDS: Readonly<Record<"mac" | "phone", Readonly<Record<Exclude<Room, "ok">, readonly [Need["state"], string, string]>>>> = {
  mac: {
    low: ["needs-you", "'s disk is almost full", "Photos and dropped files wait for room"],
    full: ["broken", "'s disk is full", "It stopped recording · free space on it"],
  },
  phone: {
    low: ["needs-you", "'s disk is almost full", "Older photos wait for 5 GB free"],
    full: ["broken", "'s disk is full", "Location and Health aren't saved · free some space on it"],
  },
};

function limitNeeds(db: Database.Database, found: Found, root: string, passes: readonly Principal[], stated: Stated | null, home: Room): void {
  if (stated === null) return;
  const devices = readTables(db).devices;
  const network = homeNetwork({ devices }, stated);
  if (network.pastWaits) {
    found.needs.push({ ...own("metered", "needs-you", "Lifestream is on a hotspot", network.since_ms), line: "History waits for Wi-Fi" });
  }
  const kinds = new Map(passes.map((pass) => [pass.id, pass.kind]));
  const named = db.prepare("SELECT value FROM meta WHERE key = ?").pluck();
  const sharing = home !== "ok" && network.unit !== null && onMacDisk(root) ? network.unit : null;
  for (const [unit, statement] of Object.entries(stated)) {
    const kind = kinds.get(statement.pass);
    const device = devices.get(unit);
    if (statement.room === null || statement.room.value === "ok" || (kind !== "mac" && kind !== "phone") || (device?.retired_ms ?? null) !== null || unit === sharing) continue;
    const [state, words, line] = ROOM_WORDS[kind][statement.room.value];
    const name = (named.get(nameKey(unit)) ?? device?.model ?? unit) as string;
    found.needs.push({ ...own(`room:${unit}`, state, `${name}${words}`, statement.room.since_ms), unit, line });
  }
}

const TAKEN_LINE = "Tailscale serves something else at its address";

function reachNeeds(db: Database.Database, found: Found): void {
  const need = reachNeed(readTables(db).meta);
  if (need === null) return;
  const acts: Act[] = need.open === null ? [] : [{ do: "open", label: "Open Tailscale", url: need.open }];
  found.needs.push({ ...own("reach", "needs-you", "Agents can't reach Lifestream from the internet", need.since_ms, acts), line: need.state === "taken" ? TAKEN_LINE : need.why });
}

function restNeeds(db: Database.Database, found: Found, form: Form): void {
  const meta = readTables(db).meta;
  const kept = meta.get(AT_REST_META);
  const rest = restFound(kept === undefined ? null : JSON.parse(kept) as AtRest, form);
  found.needs.push(...rest.needs);
  found.notices.push(...rest.notices);
  const loose = meta.get(LOOSE_META);
  if (loose !== undefined) found.needs.push(...looseFound(JSON.parse(loose) as LooseFolder[], process.platform === "darwin"));
}

const NO_MODES: Record<string, string> = { exfat: "ExFAT", msdos: "FAT", vfat: "FAT", fat: "FAT", fat32: "FAT", ntfs: "NTFS", fuseblk: "NTFS" };

const UNCOVERED = "Lifestream doesn't encrypt its working copies, temp files, your ChatGPT or Claude sign-in or its logs";

export function restFound(rest: AtRest | null, form: Form): { needs: Raised[]; notices: Notice[] } {
  const found: { needs: Raised[]; notices: Notice[] } = { needs: [], notices: [] };
  if (rest === null) return found;
  const mac = rest.platform === "darwin";
  const computer = mac ? "Mac" : "computer";
  const keyed = form === "keyed";
  const ownership = (volume: AtRest["home"], move: string): string => {
    const named = NO_MODES[volume.filesystem ?? ""];
    return named !== undefined ? `Its ${named} disk keeps no permissions: ${move}` : "In the disk's Get Info, turn off Ignore ownership";
  };
  for (const condition of restConditions(rest).keys()) {
    const since_ms = rest.occurrences[condition]?.since_ms ?? null;
    if (condition === "rest:machine") {
      found.needs.push({ ...own(condition, "needs-you", `This ${computer}'s disk isn't encrypted`, since_ms), line: keyed
        ? `${mac ? "Turn on FileVault" : "Keep your user folder on an encrypted disk"}: ${UNCOVERED}`
        : mac ? "Turn on FileVault" : "Keep your user folder on an encrypted disk" });
    } else if (condition === "rest:home") {
      found.needs.push(keyed
        ? { ...own(condition, "needs-you", "Lifestream encrypts its files itself", since_ms), line: mac ? "Move Lifestream to an APFS (Encrypted) disk to cover what was on it before" : "Move Lifestream to an encrypted disk to cover what was on it before" }
        : { ...own(condition, "needs-you", "Lifestream's disk isn't encrypted", since_ms), line: mac ? "Move Lifestream to an APFS (Encrypted) disk" : "Move Lifestream to an encrypted disk" });
    } else if (condition === "rest:owners") {
      found.needs.push({ ...own(condition, "needs-you", keyed ? "Other accounts can delete or replace Lifestream's files" : "Other accounts can read Lifestream", since_ms), line: ownership(rest.home, `move Lifestream to ${mac ? "an APFS" : "a Linux"} disk`) });
    } else {
      found.needs.push({ ...own(condition, "needs-you", "Other accounts can read Lifestream's app folder", since_ms), line: ownership(rest.machine, mac
        ? "keep your user folder on an APFS disk"
        : "set XDG_DATA_HOME to a folder on a Linux disk, then start Lifestream again") });
    }
  }
  for (const [which, volume] of [["home", rest.home], ["machine", rest.machine]] as const) {
    if (volume.why !== null) found.notices.push({ id: `rest:${which}:unread`, what: `the ${which === "home" ? "home folder's" : "machine directory's"} disk: ${volume.why}`, since_ms: null });
  }
  return found;
}

export function looseFound(loose: readonly LooseFolder[], mac: boolean, mode: (path: string) => number = (path) => statSync(path).mode): Raised[] {
  return loose.filter((folder) => {
    try {
      return (mode(folder.path) & 0o077) !== 0;
    } catch {
      return false;
    }
  }).map((folder) => {
    const words = folder.which === "home" ? "Other accounts can open Lifestream's folder" : `Other accounts can open Lifestream's folder on this ${mac ? "Mac" : "computer"}`;
    const fix = folder.why === "owner" ? `sudo chown "$USER" "${folder.path}" && chmod 700 "${folder.path}"` : `chmod 700 "${folder.path}"`;
    return { ...own(`loose:${folder.which}`, "needs-you", words, null, [{ do: "copy", label: "Copy fix", text: fix }]), line: "Run the fix in Terminal", detail: fix };
  });
}

const macDisks = new Map<string, boolean>();

function onMacDisk(root: string): boolean {
  let on = macDisks.get(root);
  if (on === undefined) {
    try {
      on = statSync(root).dev === statSync(machine().dir).dev;
    } catch {
      on = false;
    }
    macDisks.set(root, on);
  }
  return on;
}

function homeChecks(db: Database.Database, found: Found, root: string, principals: readonly Principal[], settings: StatusOptions["settings"], connectors: readonly Connector[], now_ms: number, read: DiskRead): void {
  const dropped = new Set(prefixed(db, DROPPED).map(({ key }) => key.slice(DROPPED.length)));
  const erasure = intentOf((db.prepare("SELECT value FROM meta WHERE key = ?").get(INTENT_META) as { value: string } | undefined)?.value);
  if (erasure?.error !== undefined) {
    found.notices.push({ id: "erasure", since_ms: erasure.failed_ms ?? null,
      what: `erase ${erasure.family} stopped at ${erasure.step ?? "plan"}; what it erases still shows until it finishes (${CLI} act erasure try runs it again, and its answer says why)` });
  }
  for (const job of db.prepare("SELECT kind, key, attempts, error, ended_ms FROM jobs WHERE state = 'dead' AND kind <> 'import' ORDER BY ended_ms, id").all() as
    { kind: string; key: string; attempts: number; error: string | null; ended_ms: number | null }[]) {
    found.notices.push({ id: `job:${job.kind}:${job.key}`, what: `${job.kind} ${job.key} is dead after ${job.attempts} tries: ${job.error ?? "no error stated"} (run ${job.kind} ${job.key} runs it again)`, since_ms: job.ended_ms });
  }
  const sourceOff = switchOf(connectors, settings.sources.off).source;
  importNotices(db, found, sourceOff);
  unreadableSources(db, found, connectors);
  const extractsAside = db.prepare("SELECT unit, error FROM extracts_aside WHERE family = ? ORDER BY unit LIMIT ?");
  for (const { family, count, since_ms } of db.prepare("SELECT family, count(*) AS count, min(at_ms) AS since_ms FROM extracts_aside GROUP BY family ORDER BY family").all() as
    { family: string; count: number; since_ms: number }[]) {
    const units = extractsAside.all(family, EXAMPLES) as { unit: string; error: string }[];
    found.notices.push({ id: `extract:${family}`, since_ms, what: `${family}: ${count} unit${count === 1 ? "" : "s"} set aside, the extract threw; each keeps its last build where it has one (run extract ${family} builds them again, as new evidence and the next start do): ${
      units.map((each) => `${each.unit}: ${each.error}`).join("; ")}` });
  }
  const setAside = db.prepare("SELECT unit, error FROM dirty_units WHERE family = ? AND error IS NOT NULL ORDER BY unit LIMIT ?");
  for (const { family, count } of db.prepare("SELECT family, count(*) AS count FROM dirty_units WHERE error IS NOT NULL GROUP BY family ORDER BY family").all() as
    { family: string; count: number }[]) {
    const units = setAside.all(family, EXAMPLES) as { unit: string; error: string }[];
    found.notices.push({ id: `unit:${family}`, since_ms: null, what: `${family}: ${count} unit${count === 1 ? "" : "s"} set aside, the plan threw (run plan ${family} plans them again, as new evidence does): ${
      units.map((each) => `${each.unit}: ${each.error}`).join("; ")}` });
  }
  const holding = db.prepare("SELECT value FROM meta WHERE key = ?").get(HELD_META) as { value: string } | undefined;
  for (const [name, { family, faults }] of Object.entries(holding === undefined ? {} : JSON.parse(holding.value) as Record<string, { family: string; faults: string[] }>)) {
    found.notices.push({ id: `prompt:${name}`, since_ms: null, what: `${faults.map((fault) => `${name} ${fault}`).join("; ")}; ${family} plans and sends nothing until a release fixes it` });
  }
  const daysAside = db.prepare("SELECT count(*) AS count FROM dirty_days WHERE error IS NOT NULL").get() as { count: number };
  if (daysAside.count > 0) {
    const days = db.prepare("SELECT day, error FROM dirty_days WHERE error IS NOT NULL ORDER BY day LIMIT ?").all(EXAMPLES) as { day: string; error: string }[];
    found.notices.push({ id: "day:render", since_ms: null, what: `render: ${daysAside.count} day${daysAside.count === 1 ? "" : "s"} set aside, the render threw (run render days renders them again, as new evidence does): ${
      days.map((each) => `${each.day}: ${each.error}`).join("; ")}` });
  }
  vaultChecks(db, found, root);
  knockNeeds(db, found, settings.day, now_ms);
  logBehind(db, found);
  restCapped(db, found);
  const fall = forecast(db, read.disk, read.photos.bytes);
  const room = spare(read.disk.bytes);
  const level = roomOf(read.disk.bytes);
  if (level === "full") {
    found.needs.push({ ...own("disk:full", "broken", "Lifestream's disk is full", null, STORAGE), line: "Nothing new is saved" });
  } else if (level === "low") {
    found.needs.push({ ...own("disk:low", "needs-you", "Lifestream's disk is almost full", null, STORAGE), line: "History, photos and imports wait for 5 GB free" });
  } else if (fall.coming > room) {
    found.needs.push({ ...own("photos:room", "needs-you", `Photos need ${sizeWords(fall.coming)} more`, null, STORAGE), line: `Lifestream's disk has ${sizeWords(room)} free` });
  } else if (fall.days_left !== null && fall.days_left < DAYS_LEFT_NOTICE) {
    const drive = driveOf(root);
    found.needs.push({ ...own("disk", "needs-you", `Lifestream's disk fills in about ${amount(fall.days_left, ["day", "days"])}`, null, STORAGE),
      line: `${sizeWords(room)} left${drive === null ? "" : ` on ${drive}`}` });
  }
  const givenUp = new Map<string, string[]>();
  for (const row of db.prepare("SELECT family, item FROM enrichments WHERE state = 'given-up' ORDER BY family, item").all() as { family: string; item: string }[]) {
    if (dropped.has(`${row.family}/${row.item}`)) continue;
    givenUp.set(row.family, [...givenUp.get(row.family) ?? [], row.item]);
  }
  for (const [family, items] of givenUp) {
    found.notices.push({ id: `given-up:${family}`, since_ms: null,
      what: `${family}: ${items.length} item${items.length === 1 ? "" : "s"} given up (drop item ${family} <item> accepts one without its enrichment; it is asked again only when its input or its prompt's version changes, or another route serves it): ${items.slice(0, EXAMPLES).join(", ")}` });
  }
  for (const { pass, state, replaced_ms: at, newest_ms: last } of phonePasses(db, principals)) {
    if (state !== "replaced" || now_ms - at! < HANDOVER_MS) continue;
    found.notices.push({ id: `handing-over:${pass.id}`, since_ms: at,
      what: `the replaced install of ${pass.unit} (pass ${pass.id}) ${last === null ? "never shipped" : `last shipped at ${new Date(last).toISOString()}`}, and has not finished handing over; if that phone is gone, principals revoke ${pass.id}` });
  }
  const passes = new Map(principals.map((row) => [row.id, row]));
  const claims = db.prepare(`SELECT id, source, pass, seal, lost, sealed_ms,
      (SELECT count(*) FROM (SELECT 1 FROM lost_files INDEXED BY lost_files_claim WHERE claim = d.id AND source = d.source LIMIT ${CAP + 1})) AS files
    FROM deliveries d INDEXED BY deliveries_lost WHERE lost IS NOT NULL AND run IS NOT NULL ORDER BY sealed_ms, id, source`)
    .all() as { id: string; source: string; pass: string | null; seal: number | null; lost: string; files: number; sealed_ms: number }[];
  for (const { files, ...row } of claims) {
    if (files === 0) continue;
    const pass = row.pass === null ? undefined : passes.get(row.pass);
    const said = (JSON.parse(row.lost) as { items: number; what: string }[]).map((entry) => `${entry.items} ${entry.what}`).join("; ");
    const [are, them, come] = files === 1 ? ["is", "it", "it comes"] : ["are", "them", "they come"];
    found.notices.push({ id: `lost:${row.id}:${row.source}`, since_ms: row.sealed_ms,
      what: `${filesWords(files)} of ${row.source} ${are} missing; ${pass?.unit ?? row.pass ?? "a device"} said it cleared ${them} (seal ${row.seal ?? "none"}); ${come} back only if a device carries ${them} again: ${said}` });
  }
  const waiting = db.prepare(`SELECT d.source, d.pass, d.seal, d.sealed_ms FROM deliveries d INDEXED BY deliveries_state
    WHERE d.state IN ${WAITING} AND d.pass IS NOT NULL AND d.seal > 1 AND d.sealed_ms < ?
      AND NOT EXISTS (SELECT 1 FROM deliveries p INDEXED BY deliveries_seal WHERE p.pass = d.pass AND p.source = d.source AND p.seal = d.seal - 1)
    ORDER BY d.sealed_ms, d.source`).all(now_ms - SEAL_WAIT_MS) as { source: string; pass: string; seal: number; sealed_ms: number }[];
  const held = new Set<string>();
  for (const row of waiting) {
    if (held.has(row.source)) continue;
    held.add(row.source);
    const unit = passes.get(row.pass)?.unit ?? row.pass;
    found.notices.push({ id: `seal:${row.source}:${row.pass}`, since_ms: row.sealed_ms,
      what: `${row.source} waits at ${unit}'s seal ${row.seal} for seal ${row.seal - 1}, which the door sealed and the inbox index has not found: look in inbox/ for its delivery, unreadable or moved` });
  }
  const tables = readTables(db);
  const values = db.prepare("SELECT key, value FROM meta WHERE key > ? AND key < ? ORDER BY key").all(waitingKey(""), waitingKey("￿")) as { key: string; value: string }[];
  for (const { key, value } of values) {
    const source = key.slice(waitingKey("").length);
    const { lost, received, since_ms } = JSON.parse(value) as Waiting;
    const gap = lost === undefined ? undefined : gapOf(tables, source, received);
    if (gap === undefined || gap.pass !== lost!.pass || gap.seal !== lost!.seal) continue;
    const unit = passes.get(gap.pass)?.unit ?? "a device";
    found.notices.push({ id: `through:${source}`, since_ms,
      what: `${source} has a stated read-through held back on ${unit}'s pass ${gap.pass}, seal ${gap.seal}, which the door sealed and the home holds no delivery of: look in inbox/ for its delivery, unreadable or moved; put back, the next inbox look reads it` });
  }
}

function unreadableSources(db: Database.Database, found: Found, connectors: readonly Connector[]): void {
  const read = new Set(connectors.flatMap((connector) => connector.sources.flatMap((source) => [source.read, ...source.feeders ?? []])));
  for (const { id, connector, added_ms } of db.prepare("SELECT id, connector, added_ms FROM sources ORDER BY id").all() as { id: string; connector: string; added_ms: number }[]) {
    if (read.has(connector)) continue;
    found.notices.push({ id: `unreadable:${id}`, since_ms: added_ms,
      what: `${id}: this version of Lifestream has no connector for ${connector}. What Lifestream holds of it is kept, and it is read again once a connector for ${connector} is installed` });
  }
}

function importNotices(db: Database.Database, found: Found, off: (source: Held) => boolean): void {
  const { deliveries } = readTables(db);
  const runStarted = db.prepare("SELECT started_ms FROM runs WHERE id = ?").pluck();
  const sources = new Map((db.prepare("SELECT id, connector, options FROM sources").all() as { id: string; connector: string; options: string }[]).map((row) => [row.id, row]));
  const isOff = (source: string) => {
    const row = sources.get(source);
    return off(row === undefined ? { id: source } : { ...row, options: JSON.parse(row.options) as JsonObject });
  };
  const jobOf = db.prepare("SELECT state, attempts, error, ended_ms FROM jobs WHERE kind = 'import' AND key = ?");
  const dead = db.prepare("SELECT key FROM jobs WHERE state = 'dead' AND kind = 'import'").pluck().all() as string[];
  for (const source of [...new Set([...deliveries.stopped(), ...dead])].sort()) {
    if (isOff(source)) continue;
    const stopped = deliveries.blockedAt(source);
    const job = jobOf.get(source) as { state: string; attempts: number; error: string | null; ended_ms: number | null } | undefined;
    if (stopped === undefined && job?.state !== "dead") continue;
    const started = stopped?.run == null ? undefined : runStarted.get(stopped.run) as number | undefined;
    found.notices.push({ id: `job:import:${source}`, since_ms: started ?? job?.ended_ms ?? null, what: stopped === undefined
      ? `import ${source} is dead after ${job!.attempts} tries: ${job!.error ?? "no error stated"} (run import ${source} runs it again)`
      : `${source} is blocked at ${stopped.id} after ${stopped.failures} tries (run import ${source} to retry, drop job import ${source} to give it up): ${stopped.error ?? job?.error ?? "no error stated"}` });
  }
  const unread = new Map<string, { id: string; state: string; refused: number; error: string | null; sealed_ms: number }[]>();
  for (const row of db.prepare(`SELECT source, id, state, refused, error, sealed_ms FROM deliveries INDEXED BY deliveries_unread WHERE ${UNREAD}`)
    .all() as { source: string; id: string; state: string; refused: number; error: string | null; sealed_ms: number }[]) {
    unread.set(row.source, [...unread.get(row.source) ?? [], row]);
  }
  for (const [source, rows] of [...unread].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (isOff(source)) continue;
    const held = rows.reduce((newest, row) => (row.sealed_ms > newest.sealed_ms || (row.sealed_ms === newest.sealed_ms && row.id > newest.id) ? row : newest));
    const [n, newest_ms] = [rows.length, held.sealed_ms];
    const why = held.state === "dead" ? `given up${held.error === null ? "" : `: ${held.error}`}` : held.error ?? `${amount(held.refused, ["row or file", "rows or files"])} refused`;
    found.notices.push({ id: `unread:${source}`, since_ms: newest_ms,
      what: `${source}: ${amount(n, ["delivery holds", "deliveries hold"])} input this code could not read; newest ${held.id}: ${why} (the next release reads them again; run import ${source} now)` });
  }
}

function knockNeeds(db: Database.Database, found: Found, day: DaySettings, now_ms: number): void {
  const kept = db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(KNOCKS) as string | undefined;
  for (const [browser, knock] of Object.entries(kept === undefined ? {} : (JSON.parse(kept) as Record<string, { first_ms?: unknown; last_ms?: unknown }>))) {
    if (typeof knock?.first_ms !== "number" || typeof knock.last_ms !== "number" || now_ms - knock.last_ms > KNOCK_MS) continue;
    found.needs.push({ ...own(`connect:${browser}`, "needs-you", `${browser} is asking to connect`, knock.first_ms,
      [{ do: "browser", label: "Connect", of: browser }]), line: `Since ${when(knock.first_ms, now_ms, day)}` });
  }
}

function logBehind(db: Database.Database, found: Found): void {
  const kept = db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(LOG_BEHIND) as string | undefined;
  if (kept === undefined) return;
  const { since_ms } = JSON.parse(kept) as LogBehind;
  found.needs.push({ ...own(LOG_BEHIND, "needs-you", "Another app holds Lifestream's database open", since_ms), line: "Close it and Lifestream catches up" });
  found.notices.push({ id: LOG_BEHIND, since_ms, what: "home.db's write log has not been emptied: its drains failed with no job of the home's running, so a read from outside the home holds the file" });
}

function restCapped(db: Database.Database, found: Found): void {
  const rest = readRest(db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(STORED_REST) as string | undefined);
  if (rest === null || !rest.capped) return;
  found.notices.push({ id: STORED_REST, since_ms: rest.at_ms, what: `Storage's walk of the home's folder stopped at ${REST_ENTRIES.toLocaleString("en-US")} entries outside blobs/ and inbox/: the home's own bytes count the ${
    (rest.bytes / 1e9).toFixed(1)} GB it walked, and are low` });
}

function vaultChecks(db: Database.Database, found: Found, root: string): void {
  const meta = (key: string) => db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(key) as string | undefined;
  const notice = (id: string, what: string, since_ms: number | null = null) => found.notices.push({ id, what, since_ms });
  let vault: VaultFile | null = null;
  try {
    vault = readVault(root);
  } catch {
  }
  const items = homeSecrets(join(root, "config", "secrets")).list();
  const exists = existsSync(vaultPath(root));
  if (!exists) found.needs.push({ ...own("vault:none", "needs-you", "Passwords aren't set up", null, [{ do: "vault", label: "Make key" }]), line: "Make a recovery key to keep them" });
  const keyed = vault?.version === 2;
  const locked = meta(LOCKED_SINCE);
  if (locked !== undefined && exists) {
    found.needs.push({ ...own("vault:locked", "needs-you", keyed ? "Lifestream is locked on this Mac" : "Passwords are locked on this Mac", Number(locked), [{ do: "vault", label: "Unlock" }]),
      line: keyed ? "Unlock it with your recovery key" : "Unlock them with your recovery key" });
  }
  if (vault !== null && recoverySaved(vault) !== "confirmed") {
    const unsaved = vault.slots.filter((slot) => slot.kind === "recovery");
    found.needs.push({ ...own("vault:unsaved", "needs-you", "Recovery key not saved", Math.max(0, ...unsaved.map((slot) => slot.made_ms)) || null,
      [{ do: "vault", label: "Save key" }]), line: keyed ? "Without it, a lost Mac loses everything in Lifestream" : "Without it, a lost Mac loses your passwords" });
  }
  const unreadable = items.flatMap((item) => item.unreadable === undefined ? [] : [item.name]);
  if (unreadable.length > 0) notice("vault:unreadable", `Passwords cannot be read: ${unreadable.join(", ")}`);
  const plain = items.filter((item) => item.sealed === null).map((item) => item.name);
  if (plain.length > 0) {
    const stayed = (JSON.parse(meta(UNSEALED) ?? "[]") as string[]).some((name) => plain.includes(name));
    notice("vault:plain", stayed ? (plain.length === 1 ? "1 password stays unsealed: a start that held the key could not seal it" : `${plain.length} passwords stay unsealed: a start that held the key could not seal them`)
      : plain.length === 1 ? "1 password is stored unsealed: it is sealed at the next start" : `${plain.length} passwords are stored unsealed: they are sealed at the next start`);
  }
  const machines = vault?.slots.filter((slot) => slot.kind === "machine") ?? [];
  if (vault !== null && machines.length === 0) notice("vault:no-tpm", "This machine has no TPM: unlock it with your recovery key after each restart");
  const refused = meta(REFUSED_AT);
  if (refused !== undefined) notice("vault:refused", OTHER_MAC_KEY, Number(refused));
}

function inboxGrowth(db: Database.Database, now_ms: number): StatusReport["inbox"] {
  const today = Math.floor(now_ms / UTC_DAY_MS);
  const from = today - 7 * INBOX_WEEKS + 1;
  const lanes = new Map<string, number[]>();
  for (const row of db.prepare("SELECT lane, day, bytes FROM inbox_days WHERE day >= ? ORDER BY lane, day").all(from) as { lane: string; day: number; bytes: number }[]) {
    const weeks = lanes.get(row.lane) ?? new Array<number>(INBOX_WEEKS).fill(0);
    weeks[Math.floor((today - row.day) / 7)]! += row.bytes;
    lanes.set(row.lane, weeks);
  }
  const first = db.prepare("SELECT min(day) FROM inbox_days").pluck().get() as number | null;
  return {
    lanes: [...lanes].map(([lane, weeks]) => ({ lane, weeks })),
    since: first !== null && first > from ? new Date(first * UTC_DAY_MS).toISOString().slice(0, 10) : null,
  };
}

export function sourcesToday(db: Database.Database, since: number): SourceToday[] {
  const sources = new Map<string, SourceToday>();
  const of = (source: string): SourceToday => {
    let row = sources.get(source);
    if (row === undefined) {
      row = { source, deliveries: 0, imports: 0, counts: {}, changed_paths: {}, likely_noise: [], read_through_ms: null };
      sources.set(source, row);
    }
    return row;
  };
  const readThrough = new Map<string, number | null>();
  for (const row of db.prepare(`SELECT s.id AS source, s.read_through_ms, (SELECT count(*) FROM deliveries d WHERE d.source = s.id AND d.sealed_ms >= ?) AS n
    FROM sources s ORDER BY s.id`).all(since) as { source: string; read_through_ms: number | null; n: number }[]) {
    readThrough.set(row.source, row.read_through_ms);
    if (row.n > 0) of(row.source).deliveries = row.n;
  }
  const imports = db.prepare("SELECT id, subject, counts, changed_paths AS paths FROM runs WHERE kind = 'import' AND started_ms >= ? ORDER BY started_ms, id")
    .all(since) as { id: number; subject: string; counts: string | null; paths: string | null }[];
  for (const row of imports) {
    const today = of(row.subject.split(" ", 1)[0]!);
    today.imports++;
    const counts = row.counts === null ? {} : (JSON.parse(row.counts) as Record<string, unknown>);
    for (const [name, value] of Object.entries(counts)) if (typeof value === "number") today.counts[name] = (today.counts[name] ?? 0) + value;
    const paths = (row.paths === null ? counts.changedPaths : JSON.parse(row.paths)) as Record<string, number> | undefined;
    for (const [path, count] of Object.entries(paths ?? {})) today.changed_paths[path] = (today.changed_paths[path] ?? 0) + count;
  }
  for (const today of sources.values()) {
    today.read_through_ms = readThrough.get(today.source) ?? null;
    const stated = ["new", "restated", "changed", "late", "gone"].reduce((sum, name) => sum + (today.counts[name] ?? 0), 0);
    for (const [path, count] of Object.entries(today.changed_paths)) {
      if (count >= NOISE_FLOOR && count * 2 > stated) today.likely_noise.push({ path, count, of: stated });
    }
    today.likely_noise.sort((left, right) => right.count - left.count || left.path.localeCompare(right.path));
  }
  return [...sources.values()].sort((left, right) => left.source.localeCompare(right.source));
}

function renderToday(db: Database.Database, since: number): RenderToday {
  const today: RenderToday = { runs: 0, days: 0, written: 0, current: 0, set_aside: 0 };
  for (const row of db.prepare("SELECT counts FROM runs WHERE started_ms >= ? AND kind = 'render'").all(since) as { counts: string | null }[]) {
    today.runs++;
    const counts = row.counts === null ? {} : (JSON.parse(row.counts) as Record<string, unknown>);
    for (const name of ["days", "written", "current", "set_aside"] as const) if (typeof counts[name] === "number") today[name] += counts[name];
  }
  return today;
}

function familiesToday(db: Database.Database, since: number): Map<string, FamilyToday> {
  const families = new Map<string, FamilyToday>();
  const after = db.prepare("SELECT kind FROM runs WHERE kind > ? ORDER BY kind LIMIT 1").pluck();
  const ofKind = db.prepare("SELECT kind, subject, counts FROM runs WHERE kind = ? AND started_ms >= ? ORDER BY id");
  const rows: { kind: string; subject: string; counts: string | null }[] = [];
  for (let kind = after.get("") as string | undefined; kind !== undefined; kind = after.get(kind) as string | undefined) {
    if (kind === "import" || kind === "render" || OPERATIONS.includes(kind)) continue;
    rows.push(...ofKind.all(kind, since) as typeof rows);
  }
  for (const row of rows) {
    const family = familyRow(families, row.subject.split("/")[0]!);
    const runs = (family.runs[row.kind] ??= { runs: 0, counts: {} });
    runs.runs++;
    const counts = row.counts === null ? {} : (JSON.parse(row.counts) as Record<string, unknown>);
    for (const [name, value] of Object.entries(counts)) if (typeof value === "number") runs.counts[name] = (runs.counts[name] ?? 0) + value;
  }
  return families;
}

function familyRow(families: Map<string, FamilyToday>, family: string): FamilyToday {
  let row = families.get(family);
  if (row === undefined) {
    row = { family, runs: {}, spend: { usd: 0, calls: 0, unpriced: 0 } };
    families.set(family, row);
  }
  return row;
}

function ledgerNotices(ledger: Ledger, found: Found, now_ms: number): void {
  for (const [on, rest] of ledger.resting(now_ms)) {
    found.notices.push({ id: `transport:${on}`, what: `${on} rests until ${new Date(rest.until_ms).toISOString()}: ${rest.reason}`, since_ms: null });
  }
}

function ledgerReads(ledger: Ledger, families: Map<string, FamilyToday>, since: number, priced: readonly string[]): void {
  for (const [family, { calls, usd, unpriced }] of ledger.spend(since, priced)) familyRow(families, family).spend = { calls, usd, unpriced };
}

function running(db: Database.Database, report: StatusReport): void {
  report.running.lanes = db.prepare(
    `SELECT lane, sum(state = 'queued') AS queued, sum(state = 'running') AS running,
       min(CASE WHEN state = 'queued' THEN not_before_ms END) AS due_ms
     FROM jobs WHERE state IN ('queued', 'running') GROUP BY lane ORDER BY lane`,
  ).all() as StatusReport["running"]["lanes"];
  report.running.jobs = (db.prepare("SELECT kind, key, lane, started_ms, progress FROM jobs WHERE state = 'running' ORDER BY lane, started_ms, id").all() as
    { kind: string; key: string; lane: number; started_ms: number | null; progress: string | null }[])
    .map((job) => ({ ...job, progress: job.progress === null ? null : JSON.parse(job.progress) }));
  report.running.repairs = (db.prepare(`SELECT r.id AS run, r.kind, r.subject, j.state, r.counts FROM jobs j JOIN runs r ON r.id = CAST(j.key AS INTEGER)
    WHERE j.kind = 'repair' AND j.state <> 'done' ORDER BY r.id`).all() as { run: number; kind: string; subject: string; state: string; counts: string | null }[])
    .map((row) => ({ ...row, counts: row.counts === null ? {} : JSON.parse(row.counts) as Record<string, unknown> }));
  report.running.rebuilds = (db.prepare("SELECT substr(name, 9) FROM cursors WHERE name LIKE 'rebuild:%' AND seq > 0 ORDER BY name").pluck().all() as string[]);
}

export function renderStatus(report: StatusReport, day: DaySettings): string {
  const at = (ms: number | null | undefined) => (ms === null || ms === undefined ? "never" : new Date(ms).toISOString());
  const lines = [`Status at ${at(report.at_ms)} (day ${report.day}, ${day.zone})`, "", "Needs you"];
  if (report.needs.length === 0) lines.push("  nothing");
  for (const need of report.needs) {
    lines.push(`  - ${need.state === "broken" ? "(broken) " : ""}${need.words}${need.line === undefined ? "" : ` · ${need.line}`}${need.acts.length === 0 ? "" : ` [${need.acts.map((act) => act.label).join(", ")}]`}`);
    const notices = report.notices.filter((each) => each.id === need.id).map((each) => each.what);
    for (const what of notices.length > 0 ? notices : need.detail === null ? [] : [need.detail]) for (const each of what.split("\n")) lines.push(`      ${each}`);
  }
  const told = new Set(report.needs.map((need) => need.id));
  const notices = report.notices.filter((notice) => !told.has(notice.id));
  if (notices.length > 0) {
    lines.push("", "For whoever runs Lifestream");
    for (const notice of notices) lines.push(`  - ${notice.what}`);
  }
  lines.push("", "Today");
  for (const source of report.today.sources) {
    const counts = Object.entries(source.counts).filter(([, value]) => value > 0).map(([name, value]) => `${value} ${name}`).join(", ");
    lines.push(`  ${source.source}: ${source.deliveries} deliveries, ${source.imports} imports${counts === "" ? "" : `: ${counts}`}; read through ${at(source.read_through_ms)}`);
    for (const noise of source.likely_noise) lines.push(`    likely noise: ${noise.path} changed on ${noise.count} of ${noise.of} rows (for the connector's maintainer)`);
  }
  for (const family of report.today.families) {
    const runs = Object.entries(family.runs).map(([kind, row]) => `${row.runs} ${kind}`).join(", ");
    const cost = family.spend.calls === 0 ? "" : family.spend.unpriced === family.spend.calls ? ", cost not stated" : `, $${family.spend.usd.toFixed(2)}`;
    lines.push(`  ${family.family}: ${runs || "no runs"}; ${family.spend.calls} calls${cost}`);
  }
  const { render } = report.today;
  if (render.runs > 0) lines.push(`  render: ${render.runs} run${render.runs === 1 ? "" : "s"}, ${render.days} days: ${render.written} written, ${render.current} current, ${render.set_aside} set aside`);
  for (const operation of report.today.operations) lines.push(`  ${operation.kind} ${operation.subject}: run ${operation.run}`);
  lines.push("", "LLM processing");
  if (report.works.length === 0) lines.push("  nothing is on");
  for (const work of report.works) lines.push(`  ${work.label} (${work.connector}): ${work.line}`);
  lines.push("", "Running and queued");
  if (report.running.lanes.length === 0) lines.push("  nothing");
  for (const lane of report.running.lanes) lines.push(`  lane ${lane.lane}: ${lane.running} running, ${lane.queued} queued`);
  for (const job of report.running.jobs) lines.push(`    ${job.kind} ${job.key} since ${at(job.started_ms)}`);
  for (const repair of report.running.repairs) {
    const count = (name: string) => Number(repair.counts[name] ?? 0);
    lines.push(`  ${repair.kind} ${repair.subject}, run ${repair.run} (${repair.state}): ${count("heads")} heads read, ${count("changed")} changed, ${count("gone")} gone, ${count("refused")} refused`);
  }
  if (report.running.rebuilds.length > 0) lines.push(`  rebuilding: ${report.running.rebuilds.join(", ")} (new data shows meanwhile; the rebuilt rows replace the old at its end)`);
  if (report.paused.length > 0) {
    lines.push("", "Paused");
    for (const pause of report.paused) {
      lines.push(`  ${pause.target}: ${pause.reason} (since ${civilDay(pause.at_ms, day)}${pause.holds === undefined ? "" : `; holds ${pause.holds.join(", ") || "nothing"}`})`);
    }
  }
  if (report.inbox.lanes.length > 0) {
    lines.push("", `Inbox, bytes added a week: the last four weeks, this one first${report.inbox.since === null ? "" : ` (counted since ${report.inbox.since})`}`);
    for (const lane of report.inbox.lanes) lines.push(`  ${lane.lane}: ${lane.weeks.map(gb).join(", ")}`);
  }
  if (report.imports.length > 0) {
    lines.push("", "Imports");
    for (const held of report.imports) lines.push(`  ${held.kind} ${held.id}: ${held.state}, ${held.line}`);
  }
  if (report.privacy.line !== null) lines.push("", "Hiding", `  ${report.privacy.line}: what goes hidden waits until it is ready`);
  if (report.old_copy !== null) {
    lines.push("", "Old copy");
    lines.push(`  ${report.old_copy.path}: ${gb(report.old_copy.bytes)}, the folder Lifestream moved from. It is Lifestream's only second copy until a backup exists; delete it when you no longer want it`);
  }
  if (report.search !== null) {
    lines.push("", "Search");
    lines.push(`  ${report.search.bytes === 0 ? "no index yet" : `read through statement ${report.search.seq} of ${report.search.of}; ${gb(report.search.bytes)}`}${building(report.search.building)}`);
    if (report.search.unresolved !== null && report.search.unresolved > 0) {
      lines.push(`  ${report.search.unresolved} entr${report.search.unresolved === 1 ? "y does" : "ies do"} not yet say what accounts they rest on: an agent with a limited access is not served them`);
    }
  }
  if (report.screen !== null) {
    const through = report.screen.indexed_through === null ? "no screen yet" : `words through ${new Date(report.screen.indexed_through).toISOString()}`;
    lines.push("", "Screen search");
    lines.push(`  read through statement ${report.screen.seq} of ${report.screen.of}; ${through}; ${gb(report.screen.bytes)}, meaning vectors ${gb(report.screen.vectors_bytes)}${building(report.screen.building)}`);
  }
  lines.push("", SHARE_LINE);
  return `${lines.join("\n")}\n`;
}

export const SHARE_LINE = `This status names your accounts and folders: to share how Lifestream runs, send \`${CLI} report\`, which holds neither.`;

function building(build: { done: number; of: number } | null): string {
  return build === null ? "" : `; building a whole index beside it: statement ${build.done} of ${build.of}`;
}

function searchStatus(folder: HomeFolder, of: number): StatusReport["search"] {
  let state;
  try {
    state = RECORD_INDEX.state(folder, RECORD_INDEX.fileOf(folder.root, machine().dir), of);
  } catch {
    return null;
  }
  if (state === null || (state.bytes === 0 && state.building === null)) return null;
  return { seq: state.seq, of, bytes: state.bytes, building: state.building, unresolved: unresolvedIn(folder, RECORD_INDEX.fileOf(folder.root, machine().dir)) };
}

function unresolvedIn(folder: HomeFolder, file: string): number | null {
  let index: SearchIndex | undefined;
  try {
    index = SearchIndex.read(folder, file);
    return index === undefined ? null : index.unresolved();
  } catch {
    return null;
  } finally {
    index?.close();
  }
}

function screenStatus(folder: HomeFolder, of: number): StatusReport["screen"] {
  let state;
  let standing;
  try {
    const file = SCREEN_INDEX.fileOf(folder.root, machine().dir);
    standing = screenStanding(folder, file);
    state = screenState(folder, standing, file, of);
  } catch {
    return null;
  }
  if (standing === undefined && state.building === null) return null;
  return { seq: state.seq, of, indexed_through: standing?.indexed_through ?? null, bytes: standing?.bytes ?? 0, vectors_bytes: standing?.vectors_bytes ?? 0, building: state.building };
}

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(bytes < 1e9 ? 3 : 1)} GB`;
}
