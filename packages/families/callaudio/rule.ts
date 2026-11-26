import type { CallAudioPart } from "@lifestreamprotocol/core";

export const THRESHOLDS = {
  LOUD_DBFS: -45,
  QUIET_S: 5,
  JOIN_GAP: 120_000,
  SPLIT_GAP: 600_000,
  WINDOW_MS: 30_000,
  WINDOW_LOUD_S: 3,
  TWO_WAY_MS: 120_000,
  ECHO_WORDS: 4,
  ECHO_S: 3,
  BAD_SHARE: 0.5,
  PAST_END_S: 2,
  TURN_GAP_MS: 2_000,
  TURN_MS: 60_000,
} as const;

export interface Part extends CallAudioPart {
  readonly kind: string;
  readonly key: string;
}

export interface Span {
  readonly start_ms: number;
  readonly end_ms: number;
}

export interface Stretch extends Span {
  readonly parts: readonly Part[];
}

export type Verdict =
  | { readonly call: true; readonly span: Span; readonly two_way_ms: number }
  | { readonly call: false; readonly two_way_ms: number };

const SECOND = 1_000;

export const STOPPED = "stopped";

const earlier = (a: Part, b: Part): number =>
  a.start_ms - b.start_ms || (a.track === b.track ? 0 : a.track === "mic" ? -1 : 1) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

export function loudSeconds(part: CallAudioPart): number | null {
  if (part.loudness === null) return null;
  const loud = part.loudness.rms_dbfs.filter((level) => level >= THRESHOLDS.LOUD_DBFS).length;
  return (loud * part.loudness.every_ms) / SECOND;
}

export function isQuiet(part: CallAudioPart): boolean {
  const loud = loudSeconds(part);
  return loud !== null && loud < THRESHOLDS.QUIET_S;
}

function loudRuns(part: CallAudioPart): Span[] {
  if (part.loudness === null) return [{ start_ms: part.start_ms, end_ms: part.end_ms }];
  const { every_ms, rms_dbfs } = part.loudness;
  const runs: Span[] = [];
  rms_dbfs.forEach((level, index) => {
    if (level < THRESHOLDS.LOUD_DBFS) return;
    const start_ms = part.start_ms + index * every_ms;
    const last = runs.at(-1);
    if (last !== undefined && last.end_ms === start_ms) runs[runs.length - 1] = { start_ms: last.start_ms, end_ms: start_ms + every_ms };
    else runs.push({ start_ms, end_ms: start_ms + every_ms });
  });
  return runs;
}

function hullOf(spans: readonly Span[]): Span | null {
  if (spans.length === 0) return null;
  return { start_ms: Math.min(...spans.map((span) => span.start_ms)), end_ms: Math.max(...spans.map((span) => span.end_ms)) };
}

const loudHull = (part: CallAudioPart): Span | null => hullOf(loudRuns(part));

const sessionOf = (part: Part): string => part.session ?? `${part.kind}/${part.key}`;

export function stretchesOf(parts: readonly Part[]): Stretch[] {
  return chainsOf(parts).flatMap(cut).sort((a, b) => earlier(a.parts[0]!, b.parts[0]!));
}

function chainsOf(parts: readonly Part[]): Part[][] {
  const sorted = [...parts].sort(earlier);
  const holders = new Map<string, Set<string>>();
  for (const part of sorted) {
    const held = holders.get(sessionOf(part)) ?? new Set<string>();
    for (const holder of part.holders) held.add(holder);
    holders.set(sessionOf(part), held);
  }
  const shareHolder = (a: Part, b: Part): boolean => {
    const others = holders.get(sessionOf(b))!;
    return [...holders.get(sessionOf(a))!].some((holder) => others.has(holder));
  };
  const root = sorted.map((_, index) => index);
  const find = (index: number): number => {
    while (root[index] !== index) index = root[index] = root[root[index]!]!;
    return index;
  };
  const stopped = sorted.map((part) => (part.ended_by === STOPPED ? part.end_ms : Infinity));
  const latest = sorted.map((part) => part.start_ms);
  const union = (a: number, b: number): void => {
    const [x, y] = [find(a), find(b)];
    if (x === y || stopped[x]! <= latest[y]! || stopped[y]! <= latest[x]!) return;
    root[x] = y;
    stopped[y] = Math.min(stopped[x]!, stopped[y]!);
    latest[y] = Math.max(latest[x]!, latest[y]!);
  };
  sorted.forEach((part, index) => {
    for (let before = 0; before < index; before++) {
      const prior = sorted[before]!;
      const gap = part.start_ms - prior.end_ms;
      if (gap < 0 || (gap <= THRESHOLDS.JOIN_GAP && shareHolder(prior, part))) union(index, before);
    }
  });
  const chains = new Map<number, Part[]>();
  sorted.forEach((part, index) => {
    const chain = chains.get(find(index)) ?? [];
    chain.push(part);
    chains.set(find(index), chain);
  });
  return [...chains.values()];
}

function cut(chain: readonly Part[]): Stretch[] {
  const held = chain.filter((part) => !isQuiet(part)).map((part) => ({ part, hull: loudHull(part) }))
    .filter((each): each is { part: Part; hull: Span } => each.hull !== null)
    .sort((a, b) => a.hull.start_ms - b.hull.start_ms);
  const pieces: { span: Span; parts: Part[] }[] = [];
  for (const { part, hull } of held) {
    const last = pieces.at(-1);
    if (last !== undefined && hull.start_ms - last.span.end_ms < THRESHOLDS.SPLIT_GAP) {
      last.span = { start_ms: last.span.start_ms, end_ms: Math.max(last.span.end_ms, hull.end_ms) };
      last.parts.push(part);
    } else pieces.push({ span: hull, parts: [part] });
  }
  for (const part of chain) {
    if (!isQuiet(part)) continue;
    const middle_ms = (part.start_ms + part.end_ms) / 2;
    pieces.find((piece) => piece.span.start_ms <= middle_ms && middle_ms < piece.span.end_ms)?.parts.push(part);
  }
  return pieces.map((piece) => {
    const parts = piece.parts.sort(earlier);
    return { parts, start_ms: Math.min(...parts.map((part) => part.start_ms)), end_ms: Math.max(...parts.map((part) => part.end_ms)) };
  });
}

export function firstOf(stretch: Stretch): Part {
  return stretch.parts[0]!;
}

export function unitOf(source: string, stretch: Stretch): string {
  const first = firstOf(stretch);
  return `${source}/${first.kind}/${first.key}`;
}

export function stoppedAt(stretch: Stretch): number | null {
  const ends = stretch.parts.filter((part) => part.ended_by === STOPPED).map((part) => part.end_ms);
  return ends.length === 0 ? null : Math.min(...ends);
}

export function closesAt(end_ms: number, stopped: boolean): number {
  return end_ms + (stopped ? 0 : THRESHOLDS.JOIN_GAP);
}

export function isOpen(stretch: Stretch, read_through_ms: number | null): boolean {
  return read_through_ms === null || read_through_ms <= closesAt(stretch.end_ms, stoppedAt(stretch) !== null);
}

const overlapOf = (left: Span, right: Span): number => Math.min(left.end_ms, right.end_ms) - Math.max(left.start_ms, right.start_ms);

export function joins(stretch: Span, call: Span): boolean {
  const overlap = overlapOf(stretch, call);
  return overlap > 0 && overlap * 2 >= stretch.end_ms - stretch.start_ms && overlap * 2 >= call.end_ms - call.start_ms;
}

export interface Recording {
  readonly unit: string;
  readonly span: Span;
}

export function joinerOf(call: Span, recordings: readonly Recording[]): string | null {
  const [most] = recordings.filter((recording) => joins(recording.span, call))
    .sort((left, right) => overlapOf(right.span, call) - overlapOf(left.span, call) || left.span.start_ms - right.span.start_ms || (left.unit < right.unit ? -1 : left.unit > right.unit ? 1 : 0));
  return most?.unit ?? null;
}

const length = (span: Span): number => span.end_ms - span.start_ms;

export function callRule(stretch: Stretch, joined = false): Verdict {
  const mic = stretch.parts.filter((part) => part.track === "mic");
  const sound = stretch.parts.filter((part) => part.track === "sound");
  if (sound.length === 0) return { call: false, two_way_ms: 0 };
  if (mic.length === 0) {
    const span = hullOf(sound.flatMap(loudRuns));
    const shown = joined || stretch.parts.some((part) => part.camera);
    return span !== null && shown && length(span) >= THRESHOLDS.TWO_WAY_MS ? { call: true, span, two_way_ms: 0 } : { call: false, two_way_ms: 0 };
  }
  const grid = new Grid(stretch);
  const windows = grid.twoWayWindows();
  const two_way_ms = windows.length * THRESHOLDS.WINDOW_MS;
  const held = (parts: readonly Part[]): number => parts.reduce((sum, part) => sum + length(part), 0);
  const unheard = grid.knownMs() < THRESHOLDS.TWO_WAY_MS && held(mic) >= THRESHOLDS.TWO_WAY_MS && held(sound) >= THRESHOLDS.TWO_WAY_MS;
  const span = hullOf([...windows, ...stretch.parts.filter((part) => part.loudness === null)]);
  if (span === null || (two_way_ms < THRESHOLDS.TWO_WAY_MS && !unheard)) return { call: false, two_way_ms };
  return { call: true, span: { start_ms: span.start_ms, end_ms: Math.min(span.end_ms, stretch.end_ms) }, two_way_ms };
}

const LOUD = 1;
const UNKNOWN = 2;

class Grid {
  readonly #start_ms: number;
  readonly #mic: Uint8Array;
  readonly #sound: Uint8Array;

  constructor(stretch: Stretch) {
    this.#start_ms = stretch.start_ms;
    const seconds = Math.ceil(length(stretch) / SECOND);
    this.#mic = new Uint8Array(seconds);
    this.#sound = new Uint8Array(seconds);
    for (const part of stretch.parts) {
      const track = part.track === "mic" ? this.#mic : this.#sound;
      if (part.loudness === null) this.#mark(track, part, UNKNOWN);
      else for (const run of loudRuns(part)) this.#mark(track, run, LOUD);
    }
  }

  #mark(track: Uint8Array, span: Span, flag: number): void {
    const from = Math.max(0, Math.floor((span.start_ms - this.#start_ms) / SECOND));
    const to = Math.min(track.length, Math.ceil((span.end_ms - this.#start_ms) / SECOND));
    for (let second = from; second < to; second++) track[second]! |= flag;
  }

  #unknown(second: number): boolean {
    return ((this.#mic[second]! | this.#sound[second]!) & UNKNOWN) !== 0;
  }

  knownMs(): number {
    let known = 0;
    for (let second = 0; second < this.#mic.length; second++) if (!this.#unknown(second)) known++;
    return known * SECOND;
  }

  twoWayWindows(): Span[] {
    const per = THRESHOLDS.WINDOW_MS / SECOND;
    const windows: Span[] = [];
    for (let from = 0; from < this.#mic.length; from += per) {
      let alone = 0;
      let other = 0;
      for (let second = from; second < Math.min(from + per, this.#mic.length); second++) {
        if (this.#unknown(second)) continue;
        const soundLoud = (this.#sound[second]! & LOUD) !== 0;
        if (soundLoud) other++;
        else if ((this.#mic[second]! & LOUD) !== 0) alone++;
      }
      if (alone >= THRESHOLDS.WINDOW_LOUD_S && other >= THRESHOLDS.WINDOW_LOUD_S) {
        const start_ms = this.#start_ms + from * SECOND;
        windows.push({ start_ms, end_ms: start_ms + THRESHOLDS.WINDOW_MS });
      }
    }
    return windows;
  }
}
