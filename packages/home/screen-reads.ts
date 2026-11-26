import type Database from "better-sqlite3";
import { accountOf, civilDay, render, type BlobReader, type DaySettings, type HomeFolder, type OpenView, type View } from "@lifestreamprotocol/core";
import { ScreenFrameReader, segmentsSpanning, type Family, type LazyFrame, type ScreenText } from "@lifestreamprotocol/families";
import type { Ask, Reply } from "./reads.js";
import { refuse } from "./refusal.js";
import { blockEvidence, busy, chunkLines, FRAME_CAP_MS, meaningCounts, metaOf, screenBytes, SEGMENT_MS, unpackText, vectorsDirOf, waitsOf, wordsThrough, type EmbedWaits } from "./screen-index.js";
import { keyOfFrame, plainLine, siteOf, type ProductWindows } from "./screen-keys.js";
import { daysOf, excerptOf, merged, windowOf, type Stated } from "./screen-query.js";
import { asOfIn, indexAnswer, recordRead, screenRead, type IndexState, type ScreenRead } from "./index-file.js";
import { screenBuilding } from "./screen-job.js";
import { machineSources, screenRoles, type MachineSources } from "./screen-source.js";
import { recordBuilding } from "./search.js";
import { DIM } from "./screen-scan-wasm.js";
import { nearest, ScanError, scopeOf, VectorScan } from "./screen-vectors.js";
import { meaningModel, type MeaningModel } from "./search-route.js";
import type { Settings } from "./settings.js";

export const SEARCH_STATE_ROUTE = "/v1/search/state";

export const ASK_CHARS = 500;
export const STRETCH_MS = 30 * 60_000;
export const CONTROL_WORDS = 4;
export const FOLD_CHARS = 60;
const MAX_RUNS = 20;
const SCAN_TRIES = 3;

export interface AskedMeaning {
  readonly model: string;
  readonly vector: string;
}

export type HeldMeaning = AskedMeaning | { readonly waits: string };

export function askedOf(model: string, vector: Float32Array): AskedMeaning {
  return { model, vector: Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64") };
}

export function vectorOf(asked: AskedMeaning): Float32Array | undefined {
  const bytes = Buffer.from(asked.vector, "base64");
  if (bytes.length !== DIM * 4) return undefined;
  const vector = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) vector[i] = bytes.readFloatLE(i * 4);
  return vector;
}

export interface MeaningStanding {
  available: boolean;
  words_indexed_through: number | null;
  waits: EmbedWaits | null;
}

export function statedStanding(standing: MeaningStanding, days: DaySettings): { available: boolean; words_indexed_through: string | null; waits: string | null; waits_line: string | null } {
  return {
    available: standing.available,
    words_indexed_through: standing.words_indexed_through === null ? null : render(standing.words_indexed_through, days.zone, "minute"),
    waits: standing.waits?.waits ?? null, waits_line: standing.waits?.line ?? null,
  };
}

export function meaningStanding(db: Database.Database, chosen: Pick<MeaningModel, "file"> | null): MeaningStanding {
  const words = wordsThrough(db);
  if (chosen === null || metaOf(db, "meaning") !== "true" || metaOf(db, "vector_model") !== chosen.file) return { available: false, words_indexed_through: words, waits: null };
  const waiting = metaOf(db, "meaning_walk") !== undefined || db.prepare("SELECT 1 FROM screen_embed_queue LIMIT 1").get() !== undefined;
  return { available: true, words_indexed_through: words, waits: waiting ? waitsOf(db) : null };
}

export interface MeaningMatch {
  rank: number;
  ref: string;
  evidence: string;
  excerpt: string;
  source?: string;
  app: string;
  site: string;
  window: string;
  name: string;
  key: number;
  machine: string;
  day: string;
  runs: Stated[];
  time: string;
  time_precision: "minute" | "range";
  spans?: [number, number][];
}

export interface MeaningAsk {
  vector: Float32Array;
  model: string;
  from_ms: number;
  to_ms: number;
  limit: number;
  windows?: ProductWindows;
  floor?: (machine: string) => number | null | undefined;
}

export async function meaningMatches(db: Database.Database, file: string, scan: VectorScan, ask: MeaningAsk): Promise<MeaningMatch[]> {
  const days = daysOf(db);
  const range = { from: ask.from_ms, to: ask.to_ms };
  const { limit } = ask;
  if (range.to <= range.from) return [];
  const firstDay = civilDay(range.from, days);
  const lastDay = civilDay(range.to - 1, days);
  for (let tries = 1; ; tries++) {
    db.exec("BEGIN");
    try {
      if (metaOf(db, "vector_model") !== ask.model) return [];
      const scope = scopeOf(db, vectorsDirOf(file, metaOf(db, "generation")!), ask.model, { from: firstDay, to: lastDay });
      for (let k = limit; ; k *= 4) {
        const hits = await nearest(db, scan, ask.model, scope, ask.vector, k);
        const out = named(db, hits, firstDay, lastDay, range, days, limit, ask.windows, ask.floor);
        if (out.length >= limit || hits.length < k) return out;
      }
    } catch (error) {
      if (error instanceof ScanError && error.moved && tries < SCAN_TRIES) continue;
      throw error;
    } finally {
      db.exec("COMMIT");
    }
  }
}

function named(
  db: Database.Database, hits: readonly { textHash: string }[], firstDay: string, lastDay: string, range: { from: number; to: number }, days: DaySettings, limit: number,
  windows?: ProductWindows, floor?: MeaningAsk["floor"],
): MeaningMatch[] {
  const kept = windows === undefined ? "" : " AND (k.site IN (SELECT value FROM json_each(?)) OR k.app IN (SELECT value FROM json_each(?)))";
  const units = db.prepare<unknown[], UnitRow>(`SELECT u.unit, u.kind, u.day, u.runs, u.members, k.machine, k.app, k.site, k.name, u.key
    FROM screen_unit u JOIN screen_key k ON k.id = u.key WHERE u.text_hash = ? AND u.day BETWEEN ? AND ?${kept} ORDER BY u.day DESC, u.unit DESC`);
  const of = windows === undefined ? [] : [JSON.stringify(windows.sites), JSON.stringify(windows.apps)];
  const out: MeaningMatch[] = [];
  for (const hit of hits) {
    if (out.length === limit) break;
    for (const unit of units.all(hit.textHash, firstDay, lastDay, ...of)) {
      const since = floor === undefined ? null : floor(unit.machine);
      if (since === undefined) continue;
      const within = { ...range, since: since ?? -Infinity };
      const match = unit.kind === "block" ? blockMatch(db, unit, hit.textHash, within, days) : chunkMatch(db, unit, within, days);
      if (match === undefined) continue;
      out.push({ rank: out.length + 1, ...match });
      break;
    }
  }
  return out;
}

interface UnitRow {
  unit: number;
  kind: "block" | "chunk";
  day: string;
  runs: string | null;
  members: string | null;
  machine: string;
  app: string;
  site: string;
  name: string;
  key: number;
}

type Unranked = Omit<MeaningMatch, "rank">;

function common(unit: UnitRow): Pick<MeaningMatch, "app" | "site" | "window" | "name" | "machine" | "day" | "key"> {
  return { app: unit.app, site: unit.site, window: windowOf(unit), name: unit.name, machine: unit.machine, day: unit.day, key: unit.key };
}

function blockMatch(db: Database.Database, unit: UnitRow, hash: string, range: Within, days: DaySettings): Unranked | undefined {
  const block = db.prepare("SELECT id FROM screen_block WHERE machine = ? AND day = ? AND hash = ?").get(unit.machine, unit.day, hash) as { id: number } | undefined;
  if (block === undefined) return undefined;
  const runs = (db.prepare("SELECT display, from_ms, to_ms FROM screen_block_run WHERE block = ?").all(block.id) as { display: string; from_ms: number; to_ms: number }[])
    .filter((run) => run.to_ms > range.from && run.from_ms < range.to && run.from_ms >= range.since);
  if (runs.length === 0) return undefined;
  const spans = merged(runs);
  const ms = spans[0]!.from;
  const body = (db.prepare("SELECT body FROM screen_block_fts WHERE rowid = ?").get(block.id) as { body: string } | undefined)?.body ?? windowOf(unit);
  return {
    ref: `screen:${unit.machine}/${ms}`, evidence: blockEvidence(unit.machine, unit.day, block.id), excerpt: excerptOf(body, []), source: body, ...common(unit),
    runs: spans.slice(0, MAX_RUNS).map((run) => statedOf(run.from, run.to, days)), time: render(ms, days.zone, "minute"), time_precision: "minute",
    spans: spans.map((run) => [run.from, run.to]),
  };
}

interface Within {
  from: number;
  to: number;
  since: number;
}

function chunkMatch(db: Database.Database, unit: UnitRow, range: Within, days: DaySettings): Unranked | undefined {
  const runs = (JSON.parse(unit.runs ?? "[]") as [number, number][])
    .filter(([from, to]) => to > range.from && from < range.to && from >= range.since)
    .map(([from_ms, to_ms]) => ({ from_ms, to_ms }));
  if (runs.length === 0) return undefined;
  const spans = merged(runs);
  const from = spans[0]!.from;
  const to = spans.at(-1)!.to;
  const members = chunkLines(db, unit.members ?? "[]");
  const row = members.find((member) => member.slot >= from * 8) ?? members[0];
  const lines = row?.lines ?? [];
  const longest = lines.reduce<string | undefined>((best, line) => best === undefined || line.length > best.length ? line : best, undefined);
  const first = render(from, days.zone, "minute");
  return {
    ref: `screen:${unit.machine}/${from}`, evidence: row === undefined ? `chunk:${unit.unit}` : `row:${row.slot}`, excerpt: excerptOf(longest ?? windowOf(unit), []), source: longest ?? windowOf(unit), ...common(unit),
    runs: spans.slice(0, MAX_RUNS).map((run) => statedOf(run.from, run.to, days)), time: `${first} – ${render(to, days.zone, "minute", first.slice(0, 10))}`, time_precision: "range",
    spans: spans.map((run) => [run.from, run.to]),
  };
}

function statedOf(from: number, to: number, days: DaySettings): Stated {
  return { from: render(from, days.zone, "minute"), to: render(to, days.zone, "minute") };
}


export interface ScreenGroup {
  machine: string;
  from_ms: number;
  to_ms: number;
  app: string;
  window: string;
  lines: { t_ms: number; text: string }[];
}

export type IsNew = (machine: string, key: { app: string; site: string; name: string }, line: string, t: number) => boolean | undefined;

const ROLE_TAG = /^\[\w+\] /u;
const CURSOR_TAG = /^▶ cursor here: /u;

export function controlLabel(line: string): boolean {
  const bare = line.replace(CURSOR_TAG, "");
  if (bare !== line && bare.startsWith("empty ")) return true;
  if (!ROLE_TAG.test(bare)) return false;
  const label = bare.replace(ROLE_TAG, "").replace(/ <[^>]*>$/u, "").trim();
  return label.split(/\s+/u).filter((word) => word !== "").length < CONTROL_WORDS;
}

export function frameLines(frame: ScreenText): string[] {
  const ax = frame.lines.filter((line) => !controlLabel(line)).map(plainLine).filter((line) => line !== "");
  return ax.length > 0 || frame.lines.length > 0 ? ax : frame.ocr.map(plainLine).filter((line) => line !== "");
}

export function screenGroups(machine: string, frames: readonly LazyFrame[], stretch: { from_ms: number; to_ms: number; isNew?: IsNew }): ScreenGroup[] {
  const out: (ScreenGroup & { identity: string; seen: Map<string, number> })[] = [];
  for (const [i, frame] of frames.entries()) {
    if (frame.t < stretch.from_ms || frame.t >= stretch.to_ms) continue;
    const key = keyOfFrame(frame.app, frame.site, frame.title, () => frame.text().lines);
    const identity = `${key.app}\0${key.site}\0${key.name}`;
    const end = Math.min(stretch.to_ms, frame.t + FRAME_CAP_MS, frames[i + 1]?.t ?? Infinity);
    let group = out.at(-1);
    if (group === undefined || group.identity !== identity) {
      group = { machine, from_ms: frame.t, to_ms: end, app: key.app, window: windowOf(key), lines: [], identity, seen: new Map() };
      out.push(group);
    }
    group.to_ms = Math.max(group.to_ms, end);
    for (const line of frameLines(frame.text())) {
      if (group.seen.has(line)) continue;
      group.seen.set(line, frame.t);
      if (stretch.isNew?.(machine, { app: key.app, site: siteOf(frame.site), name: key.name }, line, frame.t) === false) continue;
      group.lines.push({ t_ms: frame.t, text: line });
    }
  }
  return out
    .map(({ identity: _identity, seen: _seen, ...group }) => ({ ...group, lines: folded(group.lines) }))
    .filter((group) => stretch.isNew === undefined || group.lines.length > 0);
}

function folded(lines: readonly { t_ms: number; text: string }[]): { t_ms: number; text: string }[] {
  const latest = new Map<string, number>();
  lines.forEach((line, i) => latest.set(line.text.slice(0, FOLD_CHARS), i));
  const kept = lines.filter((line, i) => line.text.length < FOLD_CHARS || latest.get(line.text.slice(0, FOLD_CHARS)) === i);
  const longer = [...kept].sort((left, right) => right.text.length - left.text.length);
  return kept.filter((line) => !longer.some((other) => other.text.length > line.text.length && other.text.includes(line.text)));
}

function newLines(db: Database.Database, from_ms: number, to_ms: number): Set<string> {
  const out = new Set<string>();
  const rows = db.prepare(`SELECT r.seg_ms, t.times, t.body, k.machine, k.app, k.site, k.name FROM screen_row r
    JOIN screen_text t ON t.slot = r.slot JOIN screen_key k ON k.id = r.key WHERE r.slot BETWEEN ? AND ?`)
    .all((from_ms - SEGMENT_MS) * 8, to_ms * 8 - 1) as { seg_ms: number; times: Buffer; body: Buffer; machine: string; app: string; site: string; name: string }[];
  for (const row of rows) {
    for (const { line, tenths } of unpackText(row.times, row.body)) {
      const t = row.seg_ms + tenths * 100;
      if (t >= from_ms && t < to_ms) out.add(`${row.machine}\0${row.app}\0${row.site}\0${row.name}\0${line}`);
    }
  }
  return out;
}

export function stretchGroups(db: Database.Database, reader: ScreenFrameReader | undefined, sources: MachineSources, from_ms: number, to_ms: number,
  options: { newOnly: boolean }): ScreenGroup[] {
  if (reader === undefined) return [];
  const through = wordsThrough(db);
  const known = options.newOnly ? newLines(db, from_ms, to_ms) : undefined;
  const isNew: IsNew | undefined = known === undefined ? undefined
    : (machine, key, line, t) => through === null || t >= through ? undefined : known.has(`${machine}\0${key.app}\0${key.site}\0${key.name}\0${line}`);
  const machines = [...sources.machines()].sort();
  return machines.flatMap((machine) => screenGroups(machine, reader.frames(machine, from_ms, to_ms), {
    from_ms, to_ms, ...(isNew === undefined ? {} : { isNew }),
  })).sort((left, right) => left.from_ms - right.from_ms || left.machine.localeCompare(right.machine));
}

type WindowLine = { t_ms: number; text: string };

const ofApp = (window: Pick<WindowNamed, "app" | "site">) => (frame: LazyFrame): boolean => frame.app === window.app && siteOf(frame.site) === window.site;

const nameOf = (frame: LazyFrame): string => keyOfFrame(frame.app, frame.site, frame.title, () => frame.text().lines).name;

function linesOfFrames(frames: readonly LazyFrame[]): WindowLine[] {
  const seen = new Set<string>();
  const out: WindowLine[] = [];
  for (const frame of [...frames].sort((left, right) => left.t - right.t)) {
    for (const line of frameLines(frame.text())) {
      if (seen.has(line)) continue;
      seen.add(line);
      out.push({ t_ms: frame.t, text: line });
    }
  }
  return out;
}

export function windowLinesOf(frames: readonly LazyFrame[], window: Pick<WindowNamed, "app" | "site" | "name">, from_ms: number, to_ms: number): WindowLine[] {
  return linesOfFrames(frames.filter((frame) => frame.t >= from_ms && frame.t < to_ms && ofApp(window)(frame) && nameOf(frame) === window.name));
}

function linesAt(frames: readonly LazyFrame[], window: Pick<WindowNamed, "app" | "site" | "name">, instants: readonly number[]): WindowLine[] {
  const at = new Set(instants);
  return linesOfFrames(frames.filter((frame) => at.has(frame.t) && ofApp(window)(frame) && nameOf(frame) === window.name));
}

export const NEAR_FRAMES = 5;
export const NAMING_FRAMES = 2 * NEAR_FRAMES;

export interface WindowNear {
  at: number[];
  whole: boolean;
  lines: WindowLine[];
}

export interface WindowRead {
  near: WindowLine[];
  all(): WindowLine[];
}

export function windowNearOf(frames: readonly LazyFrame[], window: Pick<WindowNamed, "app" | "site" | "name">, from_ms: number, to_ms: number, at_ms: number): WindowNear | null {
  const looks = frames.filter((frame) => frame.t >= from_ms && frame.t < to_ms && ofApp(window)(frame)).sort((left, right) => left.t - right.t);
  let after = looks.findIndex((frame) => frame.t >= at_ms);
  if (after < 0) after = looks.length;
  let before = after - 1;
  const own = new Set<number>();
  let found = 0, named = 0;
  while (found < NEAR_FRAMES && named < NAMING_FRAMES && (before >= 0 || after < looks.length)) {
    const earlier = after >= looks.length || (before >= 0 && at_ms - looks[before]!.t <= looks[after]!.t - at_ms);
    const frame = earlier ? looks[before--]! : looks[after++]!;
    let parsed = false;
    const key = keyOfFrame(frame.app, frame.site, frame.title, () => {
      parsed = true;
      return frame.text().lines;
    });
    if (key.name === window.name) {
      found++;
      own.add(frame.t);
    } else if (parsed) named++;
  }
  const whole = before < 0 && after >= looks.length;
  if (found === 0 && whole) return null;
  const at = [...own].sort((left, right) => left - right);
  return { at, whole, lines: linesAt(looks, window, at) };
}

export function windowReadOf(frames: readonly LazyFrame[], window: Pick<WindowNamed, "app" | "site" | "name">, from_ms: number, to_ms: number, near: readonly number[]): WindowRead {
  return { near: linesAt(frames, window, near), all: () => windowLinesOf(frames, window, from_ms, to_ms) };
}

export interface WindowNamed {
  machine: string;
  day: string;
  app: string;
  site: string;
  name: string;
}

export interface ScreenWindow extends WindowNamed {
  start_ms: number;
  end_ms: number;
  tenths: number;
}

export function windowsIn(db: Database.Database, machine: string, from_ms: number, to_ms: number): ScreenWindow[] {
  const rows = db.prepare(`SELECT k.app, k.site, k.name, r.day, min(r.seg_ms) AS start_ms, max(r.end_ms) AS end_ms, sum(r.tenths) AS tenths
    FROM screen_segment s JOIN screen_row r ON r.segment = s.id JOIN screen_key k ON k.id = r.key
    WHERE s.machine = ? AND s.start_ms > ? AND s.start_ms < ? AND r.end_ms >= ? GROUP BY r.key, r.day`)
    .all(machine, from_ms - SEGMENT_MS, to_ms, from_ms) as { app: string; site: string; name: string; day: string; start_ms: number; end_ms: number; tenths: number }[];
  return rows.map((row) => ({ ...row, machine, start_ms: Math.max(row.start_ms, from_ms), end_ms: Math.min(row.end_ms, to_ms) }))
    .sort((left, right) => left.start_ms - right.start_ms || right.tenths - left.tenths || left.app.localeCompare(right.app) || left.name.localeCompare(right.name));
}

export function screenSource(read: ScreenRead, view: View, families: readonly Family[], blobs: BlobReader, cutover_ms: number): {
  segments(window: WindowNamed): number[];
  windowsIn(machine: string, from_ms: number, to_ms: number): ScreenWindow[];
  windowRead(window: WindowNamed, from_ms: number, to_ms: number, near: readonly number[]): WindowRead;
  windowNear(window: WindowNamed, from_ms: number, to_ms: number, at_ms: number | null): WindowNear | null;
  stretchLines(from_ms: number, to_ms: number): { t_ms: number; app: string; title: string; text: string }[];
  sources: MachineSources;
} {
  const roles = screenRoles(families);
  const sources = machineSources(view, roles);
  const reader = roles === undefined ? undefined : new ScreenFrameReader(view, roles, blobs, cutover_ms, segmentsSpanning(STRETCH_MS));
  const { db } = read;
  const firstSeen = (window: WindowNamed, from_ms: number, to_ms: number) => db.prepare(`SELECT min(s.from_ms) FROM screen_key k JOIN screen_row r ON r.key = k.id
    JOIN screen_span s ON s.slot = r.slot WHERE k.machine = ? AND k.app = ? AND k.site = ? AND k.name = ? AND r.day = ? AND s.from_ms >= ? AND s.from_ms < ?`).pluck()
    .get(window.machine, window.app, window.site, window.name, window.day, from_ms, to_ms) as number | null;
  return {
    segments: (window) => db.prepare(`SELECT DISTINCT r.seg_ms FROM screen_key k JOIN screen_row r ON r.key = k.id
      WHERE k.machine = ? AND k.app = ? AND k.site = ? AND k.name = ? AND r.day = ? ORDER BY r.seg_ms`).pluck()
      .all(window.machine, window.app, window.site, window.name, window.day) as number[],
    windowsIn: (machine, from_ms, to_ms) => windowsIn(db, machine, from_ms, to_ms),
    windowRead: (window, from_ms, to_ms, near) => reader === undefined ? { near: [], all: () => [] } : windowReadOf(reader.frames(window.machine, from_ms, to_ms), window, from_ms, to_ms, near),
    windowNear: (window, from_ms, to_ms, at_ms) => reader === undefined ? null
      : windowNearOf(reader.frames(window.machine, from_ms, to_ms), window, from_ms, to_ms, at_ms ?? firstSeen(window, from_ms, to_ms) ?? from_ms),
    sources,
    stretchLines: (from_ms, to_ms) => stretchGroups(db, reader, sources, from_ms, to_ms, { newOnly: true })
      .flatMap((group) => group.lines.map((line) => ({ t_ms: line.t_ms, app: group.app, title: group.window, text: line.text }))),
  };
}


export function screenAccounts(view: View, families: readonly Family[]): Map<string, string[]> {
  const sources = machineSources(view, screenRoles(families));
  return new Map(sources.machines().map((machine) => [machine, [...new Set(sources.of(machine).map(accountOf))].sort()]));
}

export type ScreenRoute = (ask: Ask) => Promise<Reply>;

export interface ScreenReadsInput {
  folder: HomeFolder;
  settings: () => Settings;
  blobs: BlobReader;
  families: readonly Family[];
  viewed: <T>(work: (view: OpenView) => T) => T;
  file: (machine: string) => string;
  record: (machine: string) => string;
  waitMs?: number;
}

let scanHeld: VectorScan | undefined;
export function vectorScan(folder: HomeFolder): VectorScan {
  if (scanHeld?.root === folder.root) return scanHeld;
  void scanHeld?.close();
  scanHeld = new VectorScan(folder);
  return scanHeld;
}

export async function closeVectorScan(): Promise<void> {
  const held = scanHeld;
  scanHeld = undefined;
  await held?.close();
}

export function screenReads(input: ScreenReadsInput): Map<string, ScreenRoute> {
  const answer = (members: Record<string, unknown>): Reply => ({ status: 200, headers: { "content-type": "application/json", "cache-control": "no-cache" }, body: JSON.stringify(members) });

  const stateRead = async <T>(file: string, work: (read: ScreenRead | undefined) => T): Promise<T> => {
    const answer = await screenRead(input.folder, file, work, input.waitMs);
    return answer === "none" ? work(undefined) : indexAnswer(answer, "screen");
  };

  const screenMembers = (read: ScreenRead | undefined, file: string): Record<string, unknown> => {
    const settings = input.settings();
    const chosen = meaningModel(settings);
    const stated = { power: settings.search.power };
    const none = { embedded: 0, queued: 0, named: 0, skipped: 0 };
    if (read === undefined) return { ...stated, words_indexed_through: null, bytes: 0, vectors_bytes: 0, waits: null, waits_line: null, ...none };
    const { db, clock: days } = read;
    const standing = meaningStanding(db, chosen);
    const counts = standing.available ? meaningCounts(db) : none;
    const { words_indexed_through, waits, waits_line } = statedStanding(standing, days);
    return { ...stated, words_indexed_through, ...screenBytes(file), waits, waits_line, ...counts };
  };

  const asOf = (seq: number | undefined, days: DaySettings | undefined): string | null =>
    seq === undefined || days === undefined ? null : input.viewed((view) => asOfIn(seq, view, days.zone));

  const buildingOf = (file: string, of: number): IndexState["building"] => {
    try {
      return screenBuilding(input.folder, file, of, input.waitMs);
    } catch (error) {
      if (busy(error)) return indexAnswer<never>("busy", "screen");
      throw error;
    }
  };

  const searchState: ScreenRoute = async (ask) => {
    noParams(ask.url);
    const of = input.viewed((view) => view.through);
    const recordFile = input.record(ask.held.machine);
    const file = input.file(ask.held.machine);
    const opened = recordRead(input.folder, recordFile, {}, (read) => ({ seq: read.seq, clock: read.clock }), input.waitMs);
    const record = opened === "none" ? undefined : indexAnswer(opened, "search");
    const screen = await stateRead(file, (read) => ({ seq: read?.seq, clock: read?.clock, members: screenMembers(read, file) }));
    return answer({
      record: { as_of: asOf(record?.seq, record?.clock), building: recordBuilding(input.folder, recordFile, of) },
      screen: { as_of: asOf(screen.seq, screen.clock), building: buildingOf(file, of), ...screen.members },
    });
  };

  return new Map<string, ScreenRoute>([[SEARCH_STATE_ROUTE, searchState]]);
}

function noParams(url: string): void {
  for (const name of new URL(url, "http://door").searchParams.keys()) bad(name, "is not a parameter of this route");
}

function bad(name: string, rule: string): never {
  return refuse(422, "BAD_PARAMETER", `${name} ${rule}`);
}
