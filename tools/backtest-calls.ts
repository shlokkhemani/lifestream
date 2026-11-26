import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { holderName } from "../packages/families/callaudio/lines.js";
import { callRule, holderOf, isQuiet, joins, loudSeconds, silentShare, stretchesOf, THRESHOLDS, type Part, type Stretch, type Verdict } from "../packages/families/callaudio/rule.js";
import { readLive, type Live, type LiveCall, type LivePart } from "../packages/families/callaudio/test/live.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(REPO, ".build/calls-rule");
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;
const BUSY_SHARE = 0.8;
const LONG_HOLD_MS = 60 * MINUTE;
const LOUD_SWEEP = [-55, -50, -45, -40, -35];
const TWO_WAY_SWEEP_S = [60, 90, 120, 180, 240];
const SILENT_SWEEP = [0.5, 0.7, 0.8, 0.9, 0.95, 1.01];
const LISTED = 25;

const BROWSERS: ReadonlySet<string> = new Set([
  "com.google.Chrome", "com.apple.Safari", "company.thebrowser.Browser", "com.brave.Browser", "org.mozilla.firefox", "com.microsoft.edgemac",
]);

interface Track {
  parts: number;
  quiet: number;
  unknown: number;
  loud_s: number;
}

interface Row {
  unit: string;
  start: string;
  start_ms: number;
  length_s: number;
  holder: string | null;
  holders: string[];
  players: string[];
  mic: Track;
  sound: Track;
  mic_alone_s: number;
  sound_busy: number;
  two_way_s: number;
  two_way_share: number | null;
  silent_share: number;
  longest_gap_s: number;
  gap_sound_busy: number;
  speakers: boolean;
  camera: boolean;
  joined: string | null;
  call: boolean;
  call_s: number | null;
  why: string;
  turns: Turns;
  margins: Record<string, Turns>;
  levels: Levels;
}

const shown = (bundle: string): string => holderName(bundle);

function clock(zone: string): (ms: number) => string {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return (ms) => format.format(ms).replace(",", "");
}

function track(parts: readonly Part[]): Track {
  return {
    parts: parts.length,
    quiet: parts.filter(isQuiet).length,
    unknown: parts.filter((part) => part.loudness === null).length,
    loud_s: parts.reduce((sum, part) => sum + (loudSeconds(part) ?? 0), 0),
  };
}

function levelGrid(stretch: Stretch, track: "mic" | "sound"): Float64Array {
  const grid = new Float64Array(Math.ceil((stretch.end_ms - stretch.start_ms) / SECOND)).fill(-Infinity);
  for (const part of stretch.parts) {
    if (part.track !== track || part.loudness === null) continue;
    const { every_ms, rms_dbfs } = part.loudness;
    rms_dbfs.forEach((level, index) => {
      const from = Math.max(0, Math.floor((part.start_ms + index * every_ms - stretch.start_ms) / SECOND));
      const to = Math.min(grid.length, Math.ceil((part.start_ms + (index + 1) * every_ms - stretch.start_ms) / SECOND));
      for (let second = from; second < to; second++) grid[second] = Math.max(grid[second]!, level);
    });
  }
  return grid;
}

const MARGINS_DB = [0, 6, 12];
const TURN_S = 2;
const TURN_TABLE_S = 30;

interface Sides {
  mic_only_s: number;
  sound_only_s: number;
  both_s: number;
}

interface Turns {
  stretch: Sides;
  windows: Sides;
  both_share: number | null;
  switches_per_min: number | null;
  turns_per_min: number | null;
  two_way_s: number;
}

interface Levels {
  mic_alone_db: number | null;
  mic_under_sound_db: number | null;
  sound_over_mic_db: number | null;
}

const MIC = 1;
const SOUND = 2;
const BOTH = MIC | SOUND;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function sidesOf(mic: Float64Array, sound: Float64Array, margin: number | null): Uint8Array {
  return Uint8Array.from(mic, (level, second) => {
    const other = sound[second]!;
    const soundLoud = other >= THRESHOLDS.LOUD_DBFS;
    const micLoud = level >= THRESHOLDS.LOUD_DBFS && (margin === null || level >= other + margin);
    return (micLoud ? MIC : 0) | (soundLoud ? SOUND : 0);
  });
}

function count(sides: Uint8Array, seconds: Iterable<number>): Sides {
  const each: Sides = { mic_only_s: 0, sound_only_s: 0, both_s: 0 };
  for (const second of seconds) {
    const side = sides[second]!;
    if (side === MIC) each.mic_only_s++;
    else if (side === SOUND) each.sound_only_s++;
    else if (side === BOTH) each.both_s++;
  }
  return each;
}

function windowSeconds(stretch: Stretch, seconds: number): number[][] {
  return stretch.windows.map((window) => {
    const from = Math.max(0, Math.floor((window.start_ms - stretch.start_ms) / SECOND));
    const to = Math.min(seconds, from + THRESHOLDS.WINDOW_MS / SECOND);
    return Array.from({ length: Math.max(0, to - from) }, (_, index) => from + index);
  });
}

function switchesIn(sides: Uint8Array, runs: readonly (readonly number[])[], least: number): number {
  let switches = 0;
  let last = 0;
  let previous = -2;
  for (const run of runs) {
    if (run[0] !== previous + 1) last = 0;
    let side = 0;
    let held = 0;
    for (const second of run) {
      const now = sides[second] === MIC || sides[second] === SOUND ? sides[second]! : 0;
      held = now !== 0 && now === side ? held + 1 : now === 0 ? 0 : 1;
      side = now;
      if (side !== 0 && held === least) {
        if (last !== 0 && last !== side) switches++;
        last = side;
      }
    }
    previous = run.at(-1) ?? previous;
  }
  return switches;
}

function turnsOf(stretch: Stretch, mic: Float64Array, sound: Float64Array, margin: number | null): Turns {
  const sides = sidesOf(mic, sound, margin);
  const runs = windowSeconds(stretch, sides.length);
  const windows = count(sides, runs.flat());
  const minutes = (stretch.windows.length * THRESHOLDS.WINDOW_MS) / MINUTE;
  const kept = runs.filter((run) => {
    const each = count(sides, run);
    return each.mic_only_s >= THRESHOLDS.WINDOW_LOUD_S && each.sound_only_s + each.both_s >= THRESHOLDS.WINDOW_LOUD_S;
  }).length;
  const rate = (switches: number): number | null => (minutes === 0 ? null : Math.round((switches / minutes) * 10) / 10);
  const micLoud = windows.mic_only_s + windows.both_s;
  return {
    stretch: count(sides, sides.keys()),
    windows,
    both_share: micLoud === 0 ? null : Math.round((windows.both_s / micLoud) * 100) / 100,
    switches_per_min: rate(switchesIn(sides, runs, 1)),
    turns_per_min: rate(switchesIn(sides, runs, TURN_S)),
    two_way_s: (kept * THRESHOLDS.WINDOW_MS) / SECOND,
  };
}

function levelsOf(stretch: Stretch, mic: Float64Array, sound: Float64Array): Levels {
  const alone: number[] = [];
  const under: number[] = [];
  const over: number[] = [];
  for (const second of windowSeconds(stretch, mic.length).flat()) {
    const [m, s] = [mic[second]!, sound[second]!];
    const soundLoud = s >= THRESHOLDS.LOUD_DBFS;
    if (!soundLoud && m >= THRESHOLDS.LOUD_DBFS) alone.push(m);
    if (soundLoud && m > -Infinity) under.push(m);
    if (soundLoud && m >= THRESHOLDS.LOUD_DBFS) over.push(s - m);
  }
  return { mic_alone_db: median(alone), mic_under_sound_db: median(under), sound_over_mic_db: median(over) };
}

function longestGap(windows: readonly number[]): { from_ms: number; to_ms: number } | null {
  let gap: { from_ms: number; to_ms: number } | null = null;
  for (let index = 1; index < windows.length; index++) {
    const from_ms = windows[index - 1]! + THRESHOLDS.WINDOW_MS;
    const to_ms = windows[index]!;
    if (to_ms > from_ms && (gap === null || to_ms - from_ms > gap.to_ms - gap.from_ms)) gap = { from_ms, to_ms };
  }
  return gap;
}

function share(grid: Uint8Array, from: number, to: number): number {
  let loud = 0;
  for (let second = from; second < to; second++) loud += grid[second]!;
  return to > from ? Math.round((loud / (to - from)) * 100) / 100 : 0;
}

function heldLongest(stretch: Stretch): string[] {
  const held = new Map<string, number>();
  for (const part of stretch.parts) for (const holder of part.holders) held.set(holder, (held.get(holder) ?? 0) + part.end_ms - part.start_ms);
  return [...held].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([holder]) => holder);
}

function playersOf(parts: readonly LivePart[]): string[] {
  const players = new Set<string>();
  for (const part of parts) {
    const content = part.record.content as { room?: { players?: unknown }[] };
    for (const entry of content.room ?? []) for (const player of Array.isArray(entry.players) ? entry.players : []) if (typeof player === "string") players.add(player);
  }
  return [...players].sort();
}

function why(stretch: Stretch, verdict: Verdict, camera: boolean, joined: string | null): string {
  const unknown = stretch.parts.some((part) => part.loudness === null);
  const mic = stretch.parts.some((part) => part.track === "mic");
  const sound = stretch.parts.some((part) => part.track === "sound");
  const need = THRESHOLDS.TWO_WAY_MS / SECOND;
  if (!sound) return "no sound part: without the other side it cannot be told from dictation";
  const silent = silentShare(stretch.parts.filter((part) => part.track === "sound"));
  const floor = `the sound at the -96 dBFS floor in ${Math.round(silent * 100)}% of its quiet seconds, at least ${THRESHOLDS.SILENT_SHARE * 100}%: nothing played between its sounds, no line`;
  if (!mic) {
    if (!verdict.call && silent >= THRESHOLDS.SILENT_SHARE && (camera || joined !== null)) return `no mic part; ${floor}`;
    if (verdict.call) return `no mic part; ${camera ? "the camera was on" : `a ${joined} call record joins it`}; the other side loud over ${need} s`;
    return camera || joined !== null ? `no mic part; the other side loud under ${need} s` : "no mic part, no camera and no call record";
  }
  if (verdict.call && verdict.two_way_ms >= THRESHOLDS.TWO_WAY_MS) return `two-way ${verdict.two_way_ms / SECOND} s, at least ${need} s`;
  if (verdict.call) return `known seconds under ${need} s, both tracks held ${need} s or more, and ${stretch.windows.length > 0 ? "a heard two-way window" : `a ${joined} call record`}: its unknown parts are asked`;
  if (silent >= THRESHOLDS.SILENT_SHARE && (stretch.windows.length > 0 || joined !== null)) return floor;
  if (stretch.windows.length === 0) return unknown ? "no heard two-way window and no call record: its unknown parts are not asked" : "no two-way window";
  return `two-way ${verdict.two_way_ms / SECOND} s, under ${need} s`;
}

function rowOf(stretch: Stretch, calls: readonly LiveCall[], at: (ms: number) => string): Row {
  const parts = stretch.parts as readonly LivePart[];
  const camera = stretch.parts.some((part) => part.camera);
  const joined = calls.find((call) => joins(stretch, call))?.service ?? null;
  const verdict = callRule(stretch, joined !== null);
  const windows = stretch.windows.map((window) => window.start_ms);
  const micLevels = levelGrid(stretch, "mic");
  const soundLevels = levelGrid(stretch, "sound");
  const mic = Uint8Array.from(micLevels, (level) => (level >= THRESHOLDS.LOUD_DBFS ? 1 : 0));
  const sound = Uint8Array.from(soundLevels, (level) => (level >= THRESHOLDS.LOUD_DBFS ? 1 : 0));
  let alone = 0;
  let busy = 0;
  for (let second = 0; second < mic.length; second++) {
    if (sound[second] === 1) busy++;
    else if (mic[second] === 1) alone++;
  }
  const holders = heldLongest(stretch);
  const first = stretch.parts[0]!;
  const gap = longestGap(windows);
  const offset = (ms: number) => Math.floor((ms - stretch.start_ms) / SECOND);
  const call_s = verdict.call ? Math.round((verdict.span.end_ms - verdict.span.start_ms) / SECOND) : null;
  return {
    unit: `${first.kind}/${first.key}`,
    start: at(stretch.start_ms),
    start_ms: stretch.start_ms,
    length_s: Math.round((stretch.end_ms - stretch.start_ms) / SECOND),
    holder: holderOf(stretch),
    holders,
    players: playersOf(parts),
    mic: track(stretch.parts.filter((part) => part.track === "mic")),
    sound: track(stretch.parts.filter((part) => part.track === "sound")),
    mic_alone_s: alone,
    sound_busy: mic.length === 0 ? 0 : Math.round((busy / mic.length) * 100) / 100,
    two_way_s: verdict.two_way_ms / SECOND,
    two_way_share: call_s === null || call_s === 0 ? null : Math.round((verdict.two_way_ms / SECOND / call_s) * 100) / 100,
    silent_share: Math.round(silentShare(stretch.parts.filter((part) => part.track === "sound")) * 1000) / 1000,
    longest_gap_s: gap === null ? 0 : (gap.to_ms - gap.from_ms) / SECOND,
    gap_sound_busy: gap === null ? 0 : share(sound, offset(gap.from_ms), offset(gap.to_ms)),
    speakers: stretch.parts.some((part) => part.outputs.some((output) => output.transport === "built_in")),
    camera,
    joined,
    call: verdict.call,
    call_s,
    why: why(stretch, verdict, camera, joined),
    turns: turnsOf(stretch, micLevels, soundLevels, null),
    margins: Object.fromEntries(MARGINS_DB.map((margin) => [String(margin), turnsOf(stretch, micLevels, soundLevels, margin)])),
    levels: levelsOf(stretch, micLevels, soundLevels),
  };
}

type Swept = { LOUD_DBFS: number; TWO_WAY_MS: number; SILENT_SHARE: number };

function under<T>(change: Partial<Swept>, run: () => T): T {
  const table = THRESHOLDS as Swept;
  const before = { LOUD_DBFS: table.LOUD_DBFS, TWO_WAY_MS: table.TWO_WAY_MS, SILENT_SHARE: table.SILENT_SHARE };
  Object.assign(table, change);
  try {
    return run();
  } finally {
    Object.assign(table, before);
  }
}

interface Hold {
  holder: string;
  browser: boolean;
  track: string;
  session: string;
  start: string;
  hours: number;
  parts: number;
  quiet: number;
  stretches: number;
  calls: number;
  asked: number;
}

function holds(parts: readonly LivePart[], stretches: readonly Stretch[], rows: readonly Row[], at: (ms: number) => string): Hold[] {
  const sessions = new Map<string, LivePart[]>();
  for (const part of parts) {
    const session = `${part.track} ${part.session ?? `${part.kind}/${part.key}`}`;
    sessions.set(session, [...(sessions.get(session) ?? []), part]);
  }
  const home = new Map<string, number>();
  stretches.forEach((stretch, index) => {
    for (const part of stretch.parts) home.set(`${part.kind}/${part.key}`, index);
  });
  return [...sessions].flatMap(([session, held]): Hold[] => {
    const start_ms = Math.min(...held.map((part) => part.start_ms));
    const end_ms = Math.max(...held.map((part) => part.end_ms));
    if (end_ms - start_ms < LONG_HOLD_MS) return [];
    const touched = new Set(held.flatMap((part) => home.get(`${part.kind}/${part.key}`) ?? []));
    const asked = held.filter((part) => {
      const index = home.get(`${part.kind}/${part.key}`);
      return index !== undefined && rows[index]!.call && !isQuiet(part);
    }).length;
    return [{
      holder: [...new Set(held.flatMap((part) => part.holders).map(shown))].join(", "),
      browser: held.some((part) => part.holders.some((holder) => BROWSERS.has(holder))),
      track: held[0]!.track,
      session: session.split(" ")[1]!,
      start: at(start_ms),
      hours: Math.round(((end_ms - start_ms) / (60 * MINUTE)) * 10) / 10,
      parts: held.length,
      quiet: held.filter(isQuiet).length,
      stretches: touched.size,
      calls: [...touched].filter((index) => rows[index]!.call).length,
      asked,
    }];
  }).sort((a, b) => b.hours - a.hours);
}

interface Holding {
  app: string;
  stretches: number;
  calls: number;
  short: number;
  call_min: number;
  two_way_s: number;
  short_two_way_max_s: number;
  call_two_way_min_s: number | null;
  sound_only: number;
  players: string[];
}

function holdings(rows: readonly Row[]): Holding[] {
  const by = new Map<string, Row[]>();
  for (const row of rows) by.set(row.holder ?? "(none)", [...(by.get(row.holder ?? "(none)") ?? []), row]);
  const list = [...by].map(([holder, held]): Holding => {
    const calls = held.filter((row) => row.call);
    const short = held.filter((row) => !row.call);
    return {
      app: holder === "(none)" ? holder : `${shown(holder)}${shown(holder) === holder ? "" : ` (${holder})`}`,
      stretches: held.length,
      calls: calls.length,
      short: short.length,
      call_min: Math.round(calls.reduce((sum, row) => sum + row.call_s!, 0) / 60),
      two_way_s: held.reduce((sum, row) => sum + row.two_way_s, 0),
      short_two_way_max_s: Math.max(0, ...short.map((row) => row.two_way_s)),
      call_two_way_min_s: calls.length === 0 ? null : Math.min(...calls.map((row) => row.two_way_s)),
      sound_only: held.filter((row) => row.mic.parts === 0).length,
      players: [...new Set(held.flatMap((row) => row.players.filter((player) => player !== holder)).map(shown))].sort(),
    };
  });
  const never = list.filter((each) => each.calls === 0).sort((a, b) => b.short_two_way_max_s - a.short_two_way_max_s || b.stretches - a.stretches);
  const ever = list.filter((each) => each.calls > 0).sort((a, b) => b.two_way_s - a.two_way_s);
  return [...never, ...ever];
}

interface SoundOnly {
  app: string;
  stretches: number;
  calls: number;
  minutes: number;
  camera: number;
  joined: number;
}

function soundOnly(rows: readonly Row[]): SoundOnly[] {
  const by = new Map<string, Row[]>();
  for (const row of rows.filter((each) => each.mic.parts === 0)) by.set(row.holder ?? "(none)", [...(by.get(row.holder ?? "(none)") ?? []), row]);
  return [...by].map(([holder, held]) => ({
    app: holder === "(none)" ? holder : shown(holder),
    stretches: held.length,
    calls: held.filter((row) => row.call).length,
    minutes: Math.round(held.reduce((sum, row) => sum + row.length_s, 0) / 60),
    camera: held.filter((row) => row.camera).length,
    joined: held.filter((row) => row.joined !== null).length,
  })).sort((a, b) => b.stretches - a.stretches);
}

interface Sweep {
  loud_dbfs: number;
  two_way_s: number;
  silent_share: number;
  stretches: number;
  calls: number;
  call_min: number;
  joined: number;
  apps: Record<string, number>;
}

function sweep(parts: readonly Part[], calls: readonly LiveCall[]): Sweep[] {
  const cells = [
    ...LOUD_SWEEP.flatMap((loud) => TWO_WAY_SWEEP_S.map((two_way_s) => ({ LOUD_DBFS: loud, TWO_WAY_MS: two_way_s * SECOND, SILENT_SHARE: THRESHOLDS.SILENT_SHARE }))),
    ...SILENT_SWEEP.map((silent) => ({ LOUD_DBFS: THRESHOLDS.LOUD_DBFS, TWO_WAY_MS: THRESHOLDS.TWO_WAY_MS, SILENT_SHARE: silent })),
  ];
  return cells.map((cell) => under(cell, () => {
    const judged = stretchesOf(parts).map((stretch) => {
      const joined = calls.some((call) => joins(stretch, call));
      return { stretch, joined, verdict: callRule(stretch, joined) };
    });
    const called = judged.filter((each): each is typeof each & { verdict: Extract<Verdict, { call: true }> } => each.verdict.call);
    const apps: Record<string, number> = {};
    for (const { stretch } of called) {
      const app = shown(holderOf(stretch) ?? "(none)");
      apps[app] = (apps[app] ?? 0) + 1;
    }
    return {
      loud_dbfs: cell.LOUD_DBFS,
      two_way_s: cell.TWO_WAY_MS / SECOND,
      silent_share: cell.SILENT_SHARE,
      stretches: judged.length,
      calls: called.length,
      call_min: Math.round(called.reduce((sum, each) => sum + each.verdict.span.end_ms - each.verdict.span.start_ms, 0) / MINUTE),
      joined: called.filter((each) => each.joined).length,
      apps,
    };
  }));
}

const minutes = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

function table(head: readonly string[], rows: readonly (readonly (string | number | null)[])[]): string {
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((row) => `| ${row.map((cell) => (cell === null ? "" : String(cell))).join(" | ")} |`)].join("\n");
}

const appOf = (row: Row): string => {
  if (row.holder === null) return "(none)";
  const others = [...new Set(row.holders.filter((holder) => holder !== row.holder).map(shown))];
  return others.length === 0 ? shown(row.holder) : `${shown(row.holder)} (also ${others.join(", ")})`;
};
const appsOf = (apps: Record<string, number>): string => Object.entries(apps).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([app, count]) => `${app} ${count}`).join(", ");

interface Earlier {
  start: string;
  app: string;
  call: string;
  two_way_s: number;
  now: string;
}

function earlierCalls(file: string, rows: readonly Row[]): Earlier[] {
  const before = JSON.parse(readFileSync(file, "utf8")) as { stretches: Row[] };
  return before.stretches.filter((row) => row.call).map((old) => {
    const end_ms = old.start_ms + old.length_s * SECOND;
    const now = rows.filter((row) => row.start_ms < end_ms && row.start_ms + row.length_s * SECOND > old.start_ms);
    const calls = now.filter((row) => row.call);
    return {
      start: old.start, app: appOf(old), call: minutes(old.call_s!), two_way_s: old.two_way_s,
      now: calls.length === 0 ? `gone: ${now.length} short ${now.length === 1 ? "use" : "uses"}` :
        `${calls.map((row) => `call ${minutes(row.call_s!)} on ${shown(row.holder ?? "(none)")}, two-way ${row.two_way_s} s`).join("; ")}${now.length > calls.length ? `, ${now.length - calls.length} short` : ""}`,
    };
  });
}
const loudOf = (track: Track): string | number => (track.parts === 0 ? "no part" : track.unknown === 0 ? track.loud_s : `${track.loud_s} (${track.unknown} unknown)`);
const verdictOf = (row: Row): string => (row.call ? `call ${minutes(row.call_s!)}` : "short use");

function stretchTable(rows: readonly Row[]): string {
  return table(
    ["start", "app", "length", "mic loud s", "sound loud s", "mic alone s", "sound busy", "two-way s", "two-way share", "sound at the floor", "speakers", "camera", "call record", "verdict", "why"],
    rows.map((row) => [
      row.start, appOf(row), minutes(row.length_s), loudOf(row.mic), loudOf(row.sound),
      row.mic_alone_s, row.sound_busy, row.two_way_s, row.two_way_share, row.silent_share, row.speakers ? "yes" : "", row.camera ? "yes" : "", row.joined, verdictOf(row), row.why,
    ]),
  );
}

function gapTable(rows: readonly Row[]): string {
  return table(["start", "app", "length", "call", "two-way s", "two-way share", "longest gap", "sound busy in the gap", "sound busy"],
    rows.map((row) => [row.start, appOf(row), minutes(row.length_s), minutes(row.call_s!), row.two_way_s, row.two_way_share, minutes(row.longest_gap_s), row.gap_sound_busy, row.sound_busy]));
}

const sidesCell = (sides: Sides): string => `${sides.mic_only_s} / ${sides.sound_only_s} / ${sides.both_s}`;
const db = (value: number | null): string => (value === null ? "" : String(value));

function turnTable(rows: readonly Row[], earlier: ReadonlySet<number>): string {
  const margins = MARGINS_DB.map(String);
  return table(
    ["start", "app", "verdict", "earlier call", "speakers", "two-way s", "sound at the floor", "stretch mic / sound / both s", "windows mic / sound / both s", "both share", "switches / min", `turns of ${TURN_S} s / min`,
      "mic alone dB", "mic under sound dB", "sound over mic dB",
      ...margins.flatMap((margin) => [`+${margin} dB two-way s`, `+${margin} dB windows mic / sound / both s`, `+${margin} dB both share`, `+${margin} dB turns / min`])],
    rows.map((row) => [
      row.start, appOf(row), verdictOf(row), earlier.has(row.start_ms) ? "yes" : "", row.speakers ? "yes" : "", row.two_way_s, row.silent_share, sidesCell(row.turns.stretch), sidesCell(row.turns.windows),
      row.turns.both_share, row.turns.switches_per_min, row.turns.turns_per_min, db(row.levels.mic_alone_db), db(row.levels.mic_under_sound_db), db(row.levels.sound_over_mic_db),
      ...margins.flatMap((margin) => {
        const turns = row.margins[margin]!;
        return [turns.two_way_s, sidesCell(turns.windows), turns.both_share, turns.turns_per_min];
      }),
    ]),
  );
}

function loadLive(file: string): Live {
  return JSON.parse(readFileSync(file, "utf8")) as Live;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { days: { type: "string", default: "7" }, against: { type: "string" }, live: { type: "string" } } });
  const live = values.live === undefined ? await readLive(Date.now() - Number(values.days) * DAY, Date.now()) : loadLive(resolve(values.live));
  const { from_ms, to_ms } = live;
  mkdirSync(OUT, { recursive: true });
  if (values.live === undefined) writeFileSync(join(OUT, "live.json"), `${JSON.stringify(live)}\n`);
  const at = clock(live.zone);
  const rows: Row[] = [];
  const allHolds: Hold[] = [];
  const sweeps: Sweep[][] = [];
  for (const recorder of live.recorders) {
    const stretches = stretchesOf(recorder.parts);
    const own = stretches.map((stretch) => rowOf(stretch, live.calls, at));
    rows.push(...own);
    allHolds.push(...holds(recorder.parts, stretches, own, at));
    sweeps.push(sweep(recorder.parts, live.calls));
  }
  rows.sort((a, b) => a.start_ms - b.start_ms);
  const swept = sweeps[0]?.map((each, index) => sweeps.slice(1).reduce((sum, other) => ({
    ...sum, stretches: sum.stretches + other[index]!.stretches, calls: sum.calls + other[index]!.calls, call_min: sum.call_min + other[index]!.call_min,
    joined: sum.joined + other[index]!.joined,
    apps: Object.fromEntries([...new Set([...Object.keys(sum.apps), ...Object.keys(other[index]!.apps)])].map((app) => [app, (sum.apps[app] ?? 0) + (other[index]!.apps[app] ?? 0)])),
  }), each)) ?? [];
  const calls = rows.filter((row) => row.call);
  const short = rows.filter((row) => !row.call);
  const both = short.filter((row) => row.mic.parts > 0 && row.sound.parts > 0);
  const summary = {
    stretches: rows.length,
    calls: calls.length,
    call_min: Math.round(calls.reduce((sum, row) => sum + row.call_s!, 0) / 60),
    short_uses: short.length,
    mic_only: rows.filter((row) => row.sound.parts === 0).length,
    sound_only: rows.filter((row) => row.mic.parts === 0).length,
    parts: live.recorders.reduce((sum, recorder) => sum + recorder.parts.length, 0),
    unknown_parts: live.recorders.reduce((sum, recorder) => sum + recorder.parts.filter((part) => part.loudness === null).length, 0),
    call_records: live.calls.length,
    joined: rows.filter((row) => row.joined !== null).length,
    short_two_way_max_s: Math.max(0, ...short.map((row) => row.two_way_s)),
    short_two_way_60_s: short.filter((row) => row.two_way_s >= 60).length,
    call_two_way_under_180_s: calls.filter((row) => row.two_way_s < 180).length,
    call_two_way_share_min: Math.min(1, ...calls.flatMap((row) => row.two_way_share ?? [])),
  };
  const cases = {
    dictation: short.filter((row) => row.length_s >= 4 * 60 && row.length_s <= 8 * 60 && row.mic.loud_s >= 60)
      .sort((a, b) => Math.abs(a.length_s - 360) - Math.abs(b.length_s - 360)),
    long_holds: allHolds,
    music_under_call: rows.filter((row) => row.mic.parts > 0 && row.sound.parts > 0 && row.sound_busy >= BUSY_SHARE && row.mic.loud_s >= 120)
      .sort((a, b) => b.mic.loud_s - a.mic.loud_s),
    music_between_meetings: short.filter((row) => {
      const end_ms = row.start_ms + row.length_s * SECOND;
      const before = calls.some((call) => call.start_ms < row.start_ms && call.start_ms + call.length_s * SECOND >= row.start_ms - THRESHOLDS.JOIN_GAP);
      const after = calls.some((call) => call.start_ms > row.start_ms && call.start_ms <= end_ms + THRESHOLDS.JOIN_GAP);
      return before && after;
    }).sort((a, b) => b.sound_busy - a.sound_busy),
    sparse_calls: calls.filter((row) => row.longest_gap_s * SECOND >= THRESHOLDS.SPLIT_GAP).sort((a, b) => (a.two_way_share ?? 0) - (b.two_way_share ?? 0)),
    browser_with_sound: both.filter((row) => row.holder !== null && BROWSERS.has(row.holder) && row.sound.loud_s >= 120).sort((a, b) => b.two_way_s - a.two_way_s),
    short_most_two_way: [...both].sort((a, b) => b.two_way_s - a.two_way_s),
  };
  const against = values.against === undefined ? null : resolve(values.against);
  if (against !== null && !existsSync(against)) throw new Error(`no earlier report at ${against}`);
  const earlier = against === null ? [] : earlierCalls(against, rows);
  const oldCalls = against === null ? [] : (JSON.parse(readFileSync(against, "utf8")) as { stretches: Row[] }).stretches.filter((old) => old.call);
  const earlierStarts = rows.filter((row) => oldCalls.some((old) => row.start_ms < old.start_ms + old.length_s * SECOND && row.start_ms + row.length_s * SECOND > old.start_ms))
    .map((row) => row.start_ms);
  const turning = rows.filter((row) => row.call || row.two_way_s >= TURN_TABLE_S);
  const report = {
    window: { from: at(from_ms), to: at(to_ms), zone: live.zone, days: Math.round((to_ms - from_ms) / DAY) },
    thresholds: THRESHOLDS,
    recorders: live.recorders.map((recorder) => ({
      connector: recorder.source.connector, copy: recorder.source.copy,
      mic: recorder.parts.filter((part) => part.track === "mic").length, sound: recorder.parts.filter((part) => part.track === "sound").length,
    })),
    summary, sweep: swept, turning: turning.map((row) => ({ start: row.start, app: appOf(row), call: row.call, speakers: row.speakers, two_way_s: row.two_way_s, silent_share: row.silent_share, turns: row.turns, margins: row.margins, levels: row.levels })), holders: holdings(rows), sound_only: soundOnly(rows), cases, earlier, stretches: rows,
  };
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    "# Calls rule backtest",
    "",
    `The live home's recordings from ${report.window.from} to ${report.window.to} (${live.zone}), sidecars only, through the audio adapter, \`stretchesOf\` and \`callRule\` at main's thresholds (\`LOUD_DBFS\` ${THRESHOLDS.LOUD_DBFS}, \`TWO_WAY_MS\` ${THRESHOLDS.TWO_WAY_MS / SECOND} s, \`SILENT_SHARE\` ${THRESHOLDS.SILENT_SHARE}, \`SPLIT_GAP\` ${THRESHOLDS.SPLIT_GAP / MINUTE} min, \`JOIN_GAP\` ${THRESHOLDS.JOIN_GAP / MINUTE} min, window ${THRESHOLDS.WINDOW_MS / SECOND} s holding ${THRESHOLDS.WINDOW_LOUD_S} s). A call record joins a stretch here when \`joins\` holds for any connected call; the family also asks that the record joins no other recording more.`,
    "",
    "## Summary",
    "",
    table(["what", "count"], Object.entries(summary)),
    "",
    "## Threshold sweep",
    "",
    "Each cell runs the family's own rule again with those thresholds in the table, the rest as main has them; its calls by app, and those a call record joins. The last rows sweep `SILENT_SHARE` alone (off: no stretch is left out for a silent sound side).",
    "",
    table(["LOUD_DBFS", "TWO_WAY_MS s", "SILENT_SHARE", "stretches", "calls", "call min", "joined", "calls by app"],
      swept.map((each) => [each.loud_dbfs, each.two_way_s, each.silent_share > 1 ? "off" : each.silent_share, each.stretches, each.calls, each.call_min, each.joined, appsOf(each.apps)])),
    ...(against === null ? [] : [
      "",
      `## The earlier report's calls, now (${earlier.length})`,
      "",
      `Each call of \`${relative(REPO, against)}\` and what the stretches overlapping it are now.`,
      "",
      earlier.length === 0 ? "None." : table(["start", "app", "call then", "two-way s then", "now"], earlier.map((each) => [each.start, each.app, each.call, each.two_way_s, each.now])),
    ]),
    "",
    "## Turn-taking",
    "",
    `Every call and every short use with ${TURN_TABLE_S} s or more two-way, per second (a second is loud on a track when any of its levels is at \`LOUD_DBFS\` or above). Mic / sound / both: the seconds only the mic is loud, only the sound, both, over the whole stretch and inside its two-way windows. Both share: of the mic's loud seconds in the windows, those with the sound loud too. Switches per minute of two-way windows: how often the one side loud alone changes (both or neither loud carries the last side on); turns: the same, a side counted once it holds ${TURN_S} s alone. Sound at the floor: of the sound's quiet seconds over the whole stretch, the share at -96 dBFS, digital silence, where nothing played (a call's line carries the other side's room between words; a dictation app mutes what plays while it listens); at \`SILENT_SHARE\` or more the stretch is a short use. Levels (inside the windows, medians): the mic when it is loud alone, the mic while the sound is loud, and the sound over the mic when both are loud. The +N dB columns count the mic loud only when it is also N dB or more louder than the sound in that second, so an echo of the other side from speakers is no turn of the person's; their two-way seconds are the rule's windows still two-way so.`,
    "",
    turnTable(turning, new Set(earlierStarts)),
    "",
    "## Two-way seconds per holder app",
    "",
    "The call's app in each stretch (`holderOf`: the holder that also played sound in its two-way windows, else the one that held the microphone longest). Apps never in a call first (dictation and the like), by their largest two-way seconds, the margin under `TWO_WAY_MS`; then the apps of calls.",
    "",
    table(["app", "stretches", "calls", "short uses", "call min", "two-way s", "largest two-way s in a short use", "smallest two-way s in a call", "sound only", "other players"],
      report.holders.map((each) => [each.app, each.stretches, each.calls, each.short, each.call_min, each.two_way_s, each.short_two_way_max_s, each.call_two_way_min_s, each.sound_only, each.players.join(", ")])),
    "",
    "## Sound-only stretches by holder",
    "",
    report.sound_only.length === 0 ? "None." : table(["app", "stretches", "calls", "minutes", "camera on", "call record"], report.sound_only.map((each) => [each.app, each.stretches, each.calls, each.minutes, each.camera, each.joined])),
    "",
    "## Cases",
    "",
    `### A dictation of about 6 minutes (short uses of 4 to 8 min with a minute or more loud on the mic): ${cases.dictation.length}`,
    "",
    cases.dictation.length === 0 ? "None in the window." : stretchTable(cases.dictation.slice(0, LISTED)),
    "",
    `### A session held an hour or more (a Meet tab left open among them): ${cases.long_holds.length}, ${cases.long_holds.filter((each) => each.browser).length} by a browser`,
    "",
    cases.long_holds.length === 0 ? "None in the window." : table(["start", "app", "browser", "track", "hours", "parts", "quiet", "stretches", "calls", "parts a call asks"],
      cases.long_holds.slice(0, LISTED).map((each) => [each.start, each.holder, each.browser ? "yes" : "", each.track, each.hours, each.parts, each.quiet, each.stretches, each.calls, each.asked])),
    "",
    `### Music under a call (the sound loud ${BUSY_SHARE * 100}% of the stretch or more, two minutes or more loud on the mic): ${cases.music_under_call.length}`,
    "",
    cases.music_under_call.length === 0 ? "None in the window." : stretchTable(cases.music_under_call.slice(0, LISTED)),
    "",
    `### Between two calls (a short use with a call ending within \`JOIN_GAP\` before it and one starting within \`JOIN_GAP\` after it, music between two meetings among them), the sound busiest first: ${cases.music_between_meetings.length}`,
    "",
    cases.music_between_meetings.length === 0 ? "None in the window." : stretchTable(cases.music_between_meetings.slice(0, LISTED)),
    "",
    `### Calls whose two-way windows leave a gap of \`SPLIT_GAP\` or more, whatever the sound: ${cases.sparse_calls.length}`,
    "",
    "The rule cuts a stretch wherever no two-way window falls for `SPLIT_GAP`, so none should be listed.",
    "",
    cases.sparse_calls.length === 0 ? "None in the window." : gapTable(cases.sparse_calls.slice(0, LISTED)),
    "",
    `### A browser holding the mic while sound plays (two minutes or more loud on the sound, any verdict): ${cases.browser_with_sound.length}`,
    "",
    cases.browser_with_sound.length === 0 ? "None in the window." : stretchTable(cases.browser_with_sound.slice(0, LISTED)),
    "",
    `### Every call (${calls.length})`,
    "",
    calls.length === 0 ? "None in the window." : stretchTable(calls),
    "",
    "### Short uses with both tracks, the most two-way first",
    "",
    cases.short_most_two_way.length === 0 ? "None in the window." : stretchTable(cases.short_most_two_way.slice(0, LISTED)),
    "",
    `## Every stretch (${rows.length})`,
    "",
    stretchTable(rows),
    "",
  ];
  writeFileSync(join(OUT, "report.md"), lines.join("\n"));
  process.stdout.write(`${JSON.stringify({ window: report.window, recorders: report.recorders, summary }, null, 2)}\n${join(OUT, "report.md")}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
