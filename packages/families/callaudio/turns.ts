import { isObject, type CallAudioPart, type CallTrack, type Json } from "@lifestreamprotocol/core";
import { THRESHOLDS, type Span } from "./rule.js";

export interface KeptSegment {
  readonly start_s: number;
  readonly end_s: number;
  readonly text: string;
}

export interface ReadTranscript {
  readonly segments: readonly KeptSegment[];
  readonly dropped: number;
  readonly refused: string | null;
}

export interface Heard {
  readonly key: string;
  readonly track: CallTrack;
  readonly start_ms: number;
  readonly segments: readonly KeptSegment[];
}

export interface Turn {
  readonly track: CallTrack;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly text: string;
  readonly key: string;
  readonly from_s: number;
}

const spoken = (text: string): string => text.trim().replace(/\s+/gu, " ");

function whole(segment: Json, length_s: number): KeptSegment | null {
  if (!isObject(segment)) return null;
  const { start_s, end_s, text } = segment;
  if (typeof start_s !== "number" || typeof end_s !== "number" || typeof text !== "string") return null;
  if (!Number.isFinite(start_s) || !Number.isFinite(end_s) || start_s < 0 || end_s < start_s || end_s > length_s + THRESHOLDS.PAST_END_S) return null;
  return spoken(text) === "" ? null : { start_s, end_s, text: spoken(text) };
}

const overlaps = (later: KeptSegment, earlier: KeptSegment): boolean => later.start_s === earlier.start_s || later.start_s < earlier.end_s;

export function readTranscript(answer: Json, length_s: number): ReadTranscript {
  const stated = isObject(answer) && Array.isArray(answer.segments) ? answer.segments : null;
  if (stated === null) return { segments: [], dropped: 0, refused: "the answer states no segments" };
  const valid = stated.map((segment) => whole(segment, length_s)).filter((segment): segment is KeptSegment => segment !== null)
    .sort((left, right) => left.start_s - right.start_s || left.end_s - right.end_s);
  const segments: KeptSegment[] = [];
  for (const segment of valid) {
    if (segments.some((earlier) => overlaps(segment, earlier) && earlier.text === segment.text)) continue;
    segments.push(segment);
  }
  const dropped = stated.length - segments.length;
  const refused = dropped > THRESHOLDS.BAD_SHARE * stated.length ? `${dropped} of ${stated.length} segments are unreadable` : null;
  return { segments, dropped, refused };
}

export function speakerSpans(parts: readonly CallAudioPart[]): Span[] {
  const spans = parts.flatMap((part) => {
    const outputs = [...part.outputs].sort((a, b) => a.at_ms - b.at_ms);
    return outputs.flatMap((output, index): Span[] => {
      if (output.transport !== "built_in") return [];
      const start_ms = Math.max(part.start_ms, output.at_ms);
      const end_ms = Math.min(part.end_ms, outputs[index + 1]?.at_ms ?? part.end_ms);
      return end_ms > start_ms ? [{ start_ms, end_ms }] : [];
    });
  }).sort((a, b) => a.start_ms - b.start_ms);
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last !== undefined && span.start_ms <= last.end_ms) merged[merged.length - 1] = { start_ms: last.start_ms, end_ms: Math.max(last.end_ms, span.end_ms) };
    else merged.push(span);
  }
  return merged;
}

interface Said extends Span {
  readonly track: CallTrack;
  readonly text: string;
  readonly key: string;
  readonly from_s: number;
}

const word = (token: string): string => token.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

const touches = (a: Span, b: Span, slack_ms = 0): boolean => a.start_ms < b.end_ms + slack_ms && b.start_ms < a.end_ms + slack_ms;

function echoed(mic: Said, sound: readonly Said[]): Said | null {
  const tokens = mic.text.split(" ");
  const words = tokens.map(word);
  const heard = new Array<boolean>(tokens.length).fill(false);
  for (const other of sound) {
    if (!touches(mic, other, THRESHOLDS.ECHO_S * 1_000)) continue;
    const played = other.text.split(" ").map(word).filter((each) => each !== "");
    const indices = words.flatMap((each, index) => (each === "" ? [] : [index]));
    let run = new Array<number>(played.length + 1).fill(0);
    for (let i = 1; i <= indices.length; i++) {
      const next = new Array<number>(played.length + 1).fill(0);
      for (let j = 1; j <= played.length; j++) {
        if (words[indices[i - 1]!] !== played[j - 1]) continue;
        next[j] = run[j - 1]! + 1;
        if (next[j]! >= THRESHOLDS.ECHO_WORDS) for (let back = i - next[j]!; back < i; back++) heard[indices[back]!] = true;
      }
      run = next;
    }
  }
  const kept = tokens.filter((_, index) => !heard[index]);
  if (!kept.some((token) => word(token) !== "")) return null;
  return kept.length === tokens.length ? mic : { ...mic, text: kept.join(" ") };
}

function joined(said: readonly Said[]): Turn[] {
  const turns: Turn[] = [];
  for (const each of said) {
    const last = turns.at(-1);
    if (last !== undefined && each.start_ms - last.end_ms < THRESHOLDS.TURN_GAP_MS && each.end_ms - last.start_ms <= THRESHOLDS.TURN_MS) {
      turns[turns.length - 1] = { ...last, end_ms: Math.max(last.end_ms, each.end_ms), text: `${last.text} ${each.text}` };
    } else turns.push({ track: each.track, start_ms: each.start_ms, end_ms: each.end_ms, text: each.text, key: each.key, from_s: each.from_s });
  }
  return turns;
}

export function turnsOf(heard: readonly Heard[], speakers: readonly Span[]): Turn[] {
  const said = heard.flatMap((part) => part.segments.map((segment): Said => ({
    track: part.track,
    start_ms: part.start_ms + Math.round(segment.start_s * 1_000),
    end_ms: part.start_ms + Math.round(segment.end_s * 1_000),
    text: segment.text,
    key: part.key,
    from_s: segment.start_s,
  }))).sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  const sound = said.filter((each) => each.track === "sound");
  const mic = said.filter((each) => each.track === "mic")
    .map((each) => (speakers.some((span) => touches(each, span)) ? echoed(each, sound) : each))
    .filter((each): each is Said => each !== null);
  return [...joined(mic), ...joined(sound)]
    .sort((a, b) => a.start_ms - b.start_ms || (a.track === b.track ? 0 : a.track === "mic" ? -1 : 1));
}

export interface Other {
  readonly name: string;
  readonly span: Span;
}

export function namesOther(turn: Pick<Turn, "track" | "start_ms" | "end_ms">, other: Other | null): other is Other {
  const middle = (turn.start_ms + turn.end_ms) / 2;
  return turn.track === "sound" && other !== null && middle >= other.span.start_ms && middle <= other.span.end_ms;
}

export function whoOf(turn: Pick<Turn, "track" | "start_ms" | "end_ms">, other: Other | null): string {
  if (turn.track === "mic") return "You";
  return namesOther(turn, other) ? other.name : "Them";
}
