import {
  daysOf, digest, GONE,
  type Ask, type BlobReader, type CallAudioAdapter, type CallsAdapter, type DaySettings, type ExtractRow, type Json, type Prompt, type RecordRef, type Reply,
  type SourceRow, type Version, type View,
} from "@lifestreamprotocol/core";
import { OPS, type Change, type Collection, type DayInput, type DayProjection, type Extracted, type Family, type FamilyInput, type Given, type Plan, type ReadThroughMove, type Touched } from "../family.js";
import { callHandles, callRecord, callsReading, type Call, type CallReading } from "../calls/family.js";
import { labelInputs, type Books } from "../shared/labels.js";
import { statedPrompt } from "../shared/prompts.js";
import { Stretches } from "../shared/stretches.js";
import { callRule, closesAt, isOpen, joinerOf, joins, loudSeconds, isQuiet, stoppedAt, stretchesOf, THRESHOLDS, unitOf, type Part, type Recording, type Span, type Stretch } from "./rule.js";
import { readTranscript, speakerSpans, type KeptSegment } from "./turns.js";
import { callDay, holderName, summaryInput } from "./lines.js";
import { askedParts, CALLAUDIO_FAMILY, partItem, stretchItem, type CallAudioContent, type CallContent, type CallPart, type CallSummary, type JoinedCall } from "./content.js";

export { CALLAUDIO_FAMILY, stretchUnit } from "./content.js";
export { NOT_JOINED } from "./lines.js";
export type { CallAudioContent, CallContent, CallPart, CallSummary, JoinedCall, ShortUse } from "./content.js";

export const CALL_TRANSCRIPT = "call-transcript";
export const CALL_SUMMARY = "call-summary";
export const CALL_TRANSCRIPTS_WORK = "transcripts";
export const CALL_SUMMARIES_WORK = "summaries";
const PROMPTS = new URL("./prompts/", import.meta.url);
export const CALL_PROMPTS: Readonly<Record<string, Prompt>> = {
  [CALL_TRANSCRIPT]: statedPrompt(PROMPTS, CALL_TRANSCRIPT),
  [CALL_SUMMARY]: statedPrompt(PROMPTS, CALL_SUMMARY),
};
const SENT_MEDIA = new Set(["audio/mp4", "audio/x-m4a", "audio/mpeg", "audio/wav"]);
const TITLE_CHARS = 80;
const STEP_MS = 30 * 60_000;

export interface CallAudioSettings extends Books {
  readonly zone: string;
  readonly calls: readonly Given<CallsAdapter>[];
}

export function callaudioFamily(settings: CallAudioSettings): (given: readonly Given<CallAudioAdapter>[]) => Family {
  return (given) => callAudioOver(settings, given);
}

function callAudioOver(settings: CallAudioSettings, given: readonly Given<CallAudioAdapter>[]): Family {
  const byProduct = new Map(given.map((each) => [each.product, each.adapter]));
  const products = given.map((each) => each.product);
  const calls = callsReading(settings.calls);
  const kept = new WeakMap<View, Map<string, SourceParts>>();
  const audioOf = (view: View, source: string): { row: SourceRow; adapter: CallAudioAdapter } | null => {
    const row = view.source(source);
    const adapter = row === undefined ? undefined : byProduct.get(row.product);
    return adapter === undefined ? null : { row: row!, adapter };
  };
  const partsOf = (view: View, row: SourceRow, adapter: CallAudioAdapter): SourceParts => {
    let bySource = kept.get(view);
    if (bySource === undefined) kept.set(view, bySource = new Map());
    let parts = bySource.get(row.id);
    if (parts === undefined) bySource.set(row.id, parts = new SourceParts(view, row, adapter));
    return parts;
  };
  const recordingsOver = (view: View, span: Span): Recording[] => view.sources({ product: products }).flatMap((row) =>
    partsOf(view, row, byProduct.get(row.product)!).around(span.start_ms, span.end_ms).stretches
      .filter((stretch) => stretch.start_ms < span.end_ms && stretch.end_ms > span.start_ms)
      .map((stretch) => ({ unit: unitOf(row.id, stretch), span: stretch })));
  const inputs: FamilyInput[] = given.length === 0 ? [] : [
    ...given.map((each): FamilyInput => ({ sources: { product: [each.product] }, kinds: [...each.adapter.kinds], role: "evidence" })),
    ...settings.calls.map((each): FamilyInput => ({ sources: { product: [each.product] }, kinds: [...each.adapter.kinds], role: "evidence" })),
    ...labelInputs(settings),
  ];

  return {
    name: CALLAUDIO_FAMILY,
    type: "calls",
    code: "1",
    inputs,
    borrowed: { calls: settings.calls },
    prompts: CALL_PROMPTS,
    readers: {
      [CALL_TRANSCRIPT]: (value) => readTranscript(value, Number.MAX_VALUE).refused,
      [CALL_SUMMARY]: (value) => readSummary(value).refused,
    },
    works: { [CALL_TRANSCRIPTS_WORK]: { product: products }, [CALL_SUMMARIES_WORK]: { product: products } },

    touched(changes: readonly Change[], view: View): Touched[] {
      const audio = new Map<string, [number, number][]>();
      const called: [number, number][] = [];
      for (const change of changes) {
        const spans = [change.before, change.after].flatMap((version) => spanOf(version));
        if (audioOf(view, change.record.source)?.adapter.kinds.includes(change.record.kind) === true) {
          audio.set(change.record.source, [...audio.get(change.record.source) ?? [], ...spans]);
        } else if (calls.unitOf(view, change.record) !== null) called.push(...spans);
      }
      const touched: Touched[] = [];
      for (const [source, spans] of audio) {
        const { row, adapter } = audioOf(view, source)!;
        for (const [lo, hi] of merged(spans, 2 * THRESHOLDS.JOIN_GAP)) {
          const parts = partsOf(view, row, adapter);
          touched.push(...touchedAround(view, parts, lo, hi));
          const { from_ms, to_ms } = parts.around(lo, hi);
          for (const { call } of calls.overlapping(view, from_ms, to_ms)) if (call.end_ms !== null) called.push([call.start_ms, call.end_ms]);
        }
      }
      for (const [lo, hi] of merged(called, 0)) {
        for (const row of view.sources({ product: products })) {
          const parts = partsOf(view, row, byProduct.get(row.product)!);
          for (const stretch of parts.around(lo, hi).stretches) if (stretch.start_ms <= hi && stretch.end_ms >= lo) touched.push({ unit: unitOf(row.id, stretch) });
        }
      }
      return touched;
    },

    extract(unit: string, view: View, files: BlobReader): Extracted | null {
      const named = unitPart(unit);
      const found = named === null ? null : audioOf(view, named.source);
      if (named === null || found === null || !found.adapter.kinds.includes(named.kind)) return null;
      const head = view.head({ source: named.source, kind: named.kind, key: named.key });
      if (head === undefined || head.version === GONE) return null;
      const first = found.adapter.part({ source: found.row, version: view.version(head.version) });
      if (first === null) return null;
      const stretch = partsOf(view, found.row, found.adapter).around(first.start_ms, first.end_ms).stretches.find((each) => unitOf(named.source, each) === unit);
      if (stretch === undefined) return null;
      const joined = joinedOf(view, calls, unit, stretch, (span) => recordingsOver(view, span));
      const verdict = callRule(stretch, joined !== null);
      const content: CallAudioContent = verdict.call
        ? callContent(named.source, stretch, verdict.span, joined, files, found.row.read_through_ms)
        : { short: true, source: named.source };
      const json = content as unknown as Json;
      return { content: json, start_ms: stretch.start_ms, end_ms: stretch.end_ms, reading: digest(json) };
    },

    days(extract: ExtractRow, daySettings: DaySettings): string[] {
      if ((extract.content as unknown as CallAudioContent).short) return [];
      return daysOf({ start_ms: extract.start_ms!, end_ms: extract.end_ms! + 1, precision: "ms" }, daySettings);
    },

    items(extract: ExtractRow): { item: string; prompt: string }[] {
      const content = extract.content as unknown as CallAudioContent;
      if (content.short) return [];
      return [...askedParts(content).map((part) => ({ item: partItem(part), prompt: CALL_TRANSCRIPT })), { item: stretchItem(extract.unit), prompt: CALL_SUMMARY }];
    },

    plan(extract: ExtractRow, answered: ReadonlyMap<string, Reply>, given_up: ReadonlySet<string> = new Set()): Plan {
      const content = extract.content as unknown as CallAudioContent;
      if (content.short) return { asks: [] };
      const plan: Required<Plan> = { asks: [], answers: [], refusals: [] };
      const heard = new Map<string, readonly KeptSegment[]>();
      for (const part of askedParts(content)) {
        const item = partItem(part);
        const reply = answered.get(item);
        if (reply === undefined) {
          plan.asks.push(transcriptAsk(part, content.source));
          continue;
        }
        const read = readTranscript(reply.value, part.ms / 1_000);
        if (read.refused !== null) {
          plan.refusals.push({ item, reason: read.refused });
          continue;
        }
        heard.set(item, read.segments);
        plan.answers.push({ item, content: { segments: read.segments } as unknown as Json });
      }
      const settled = askedParts(content).every((part) => heard.has(partItem(part)) || given_up.has(partItem(part)));
      if (content.open || !settled || ![...heard.values()].some((segments) => segments.length > 0)) return plan;
      const item = stretchItem(extract.unit);
      const reply = answered.get(item);
      if (reply === undefined) {
        plan.asks.push({
          family: CALLAUDIO_FAMILY, item, prompt: CALL_SUMMARY, input: summaryInput(content, (each) => heard.get(each) ?? null, settings.zone),
          work: CALL_SUMMARIES_WORK, source: content.source,
        });
        return plan;
      }
      const read = readSummary(reply.value);
      if (read.refused !== null) plan.refusals.push({ item, reason: read.refused });
      else plan.answers.push({ item, content: read.summary as unknown as Json });
      return plan;
    },

    readThrough(move: ReadThroughMove, view: View): string[] {
      const found = audioOf(view, move.source);
      if (found === null) return [];
      if (move.before_ms === null) {
        return [...view.extractsUnder(CALLAUDIO_FAMILY, `${move.source}/`)].filter((row) => {
          const content = row.content as unknown as CallAudioContent;
          return !content.short && content.open && move.after_ms > closesAt(row.end_ms!, content.stopped_ms !== null);
        }).map((row) => row.unit);
      }
      const before_ms = move.before_ms;
      return partsOf(view, found.row, found.adapter).around(before_ms - THRESHOLDS.JOIN_GAP, move.after_ms).stretches
        .filter((stretch) => isOpen(stretch, before_ms) && !isOpen(stretch, move.after_ms)).map((stretch) => unitOf(move.source, stretch));
    },

    day(input: DayInput): DayProjection {
      return callDay(input);
    },
    collections: CALLAUDIO_COLLECTIONS,
  };
}

export const CALLAUDIO_COLLECTIONS: Readonly<Record<string, Collection>> = {
  callaudio: {
    keys: ["app", "call"],
    about: "calls the Mac heard; call is the service of the call record joined to one, or none; a joined call's minutes are in calls.minutes too, so the minutes of every call are calls.minutes plus callaudio.minutes where call is none",
    measures: { minutes: { unit: "min", ops: OPS, time: "start", split: "clock", readings: ["calls.minutes", "meetings.minutes"], from: "derived" } },
  },
};

function transcriptAsk(part: CallPart, source: string): Ask {
  return {
    family: CALLAUDIO_FAMILY, item: partItem(part), prompt: CALL_TRANSCRIPT,
    input: [{ text: `${part.track === "mic" ? "microphone" : "the other side"}, ${part.ms / 1_000} s` }],
    attachments: [{ blob: `sha256:${part.sha256}`, media_type: part.media_type }], identity: `sha256:${part.sha256}`,
    work: CALL_TRANSCRIPTS_WORK, source,
  };
}

export function readSummary(value: Json): { summary: CallSummary; refused: null } | { summary: null; refused: string } {
  const stated = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
  const title = typeof stated.title === "string" ? stated.title.trim() : "";
  const summary = typeof stated.summary === "string" ? stated.summary.trim() : "";
  if (title === "") return { summary: null, refused: "the title is empty" };
  if (title.length > TITLE_CHARS) return { summary: null, refused: `the title is over ${TITLE_CHARS} characters` };
  return { summary: { title, summary }, refused: null };
}

function callContent(source: string, stretch: Stretch, span: Span, joined: JoinedCall | null, files: BlobReader, read_through_ms: number | null): CallContent {
  const partOf = (part: Part): CallPart => {
    const quiet = isQuiet(part);
    return {
      kind: part.kind, key: part.key, track: part.track, sha256: part.sha256, media_type: part.media_type, start_ms: part.start_ms, ms: part.ms,
      loud_s: loudSeconds(part), quiet, asked: !quiet && SENT_MEDIA.has(part.media_type) && files.has(`sha256:${part.sha256}`),
    };
  };
  const stopped_ms = stoppedAt(stretch);
  return {
    short: false, source, span,
    mic: stretch.parts.filter((part) => part.track === "mic").map(partOf),
    sound: stretch.parts.filter((part) => part.track === "sound").map(partOf),
    holder: longestHolder(stretch),
    camera: stretch.parts.some((part) => part.camera),
    speakers: speakerSpans(stretch.parts),
    stopped_ms,
    open: read_through_ms === null || read_through_ms <= closesAt(stretch.end_ms, stopped_ms !== null),
    joined,
  };
}

function longestHolder(stretch: Stretch): string | null {
  const held = new Map<string, number>();
  for (const part of stretch.parts) for (const holder of part.holders) held.set(holder, (held.get(holder) ?? 0) + part.end_ms - part.start_ms);
  const [longest] = [...held].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return longest === undefined ? null : holderName(longest[0]);
}

function joinedOf(view: View, calls: CallReading, own: string, stretch: Stretch, recordings: (span: Span) => Recording[]): JoinedCall | null {
  const overlap = (call: Call) => Math.min(stretch.end_ms, call.end_ms!) - Math.max(stretch.start_ms, call.start_ms);
  const [best] = calls.overlapping(view, stretch.start_ms, stretch.end_ms)
    .filter(({ call }) => {
      if (call.outcome !== "connected" || call.end_ms === null) return false;
      const span = { start_ms: call.start_ms, end_ms: call.end_ms };
      return joins(stretch, span) && joinerOf(span, recordings(span)) === own;
    })
    .sort((left, right) => overlap(right.call) - overlap(left.call) || (left.unit < right.unit ? -1 : 1));
  if (best === undefined) return null;
  const { unit, call } = best;
  return {
    record: callRecord(unit, call), unit, service: call.service, span: { start_ms: call.start_ms, end_ms: call.end_ms! }, handles: callHandles(call), parties: call.parties,
    other: call.parties.length === 1 ? call.parties[0]! : null,
  };
}

function touchedAround(view: View, parts: SourceParts, lo: number, hi: number): Touched[] {
  const around = parts.around(lo, hi);
  const now = new Map(around.stretches.map((stretch) => [unitOf(parts.source, stretch), stretch]));
  const touched: Touched[] = [...now.keys()].map((unit) => ({ unit }));
  for (const stored of view.extracts(CALLAUDIO_FAMILY, { start_ms: around.from_ms, end_ms: around.to_ms + 1 })) {
    if (now.has(stored.unit) || unitPart(stored.unit)?.source !== parts.source) continue;
    const into = [...now].find(([, stretch]) => stretch.start_ms <= stored.end_ms! && stretch.end_ms >= stored.start_ms!);
    touched.push(into === undefined ? { unit: stored.unit } : { unit: into[0], previous: stored.unit });
  }
  return touched;
}

class SourceParts {
  readonly #parts = new Stretches<{ key: string; part: Part }>((each) => each.part.start_ms);
  #longest = 0;

  constructor(private readonly view: View, private readonly row: SourceRow, private readonly adapter: CallAudioAdapter) {}

  get source(): string {
    return this.row.id;
  }

  around(lo: number, hi: number): { stretches: Stretch[]; from_ms: number; to_ms: number } {
    let a = lo - THRESHOLDS.JOIN_GAP;
    let b = hi + THRESHOLDS.JOIN_GAP;
    let step = STEP_MS;
    for (;;) {
      this.#parts.cover(a, b, (from, to) => this.#read(from, to));
      const parts = this.#parts.within(a - this.#longest, b).map((each) => each.part).filter((part) => part.end_ms > a);
      if (parts.some((part) => part.start_ms <= a + THRESHOLDS.JOIN_GAP)) {
        a -= step;
        step *= 2;
        continue;
      }
      if (parts.some((part) => part.end_ms >= b - THRESHOLDS.JOIN_GAP)) {
        b += step;
        step *= 2;
        continue;
      }
      return { stretches: stretchesOf(parts), from_ms: a, to_ms: b };
    }
  }

  #read(from: number, to: number): { key: string; part: Part }[] {
    const found: { key: string; part: Part }[] = [];
    for (const kind of this.adapter.kinds) {
      for (const { head, version } of this.view.records(this.row.id, kind, { start_ms: from, end_ms: to })) {
        const part = this.adapter.part({ source: this.row, version });
        if (part === null) continue;
        this.#longest = Math.max(this.#longest, part.end_ms - part.start_ms);
        found.push({ key: `${kind}\0${head.key}`, part: { ...part, kind, key: head.key } });
      }
    }
    return found;
  }
}

export function unitPart(unit: string): RecordRef | null {
  const pieces = unit.split("/");
  return pieces.length === 3 && pieces.every((piece) => piece !== "") ? { source: pieces[0]!, kind: pieces[1]!, key: pieces[2]! } : null;
}

function spanOf(version: Version | undefined): [number, number][] {
  if (version?.time === undefined) return [];
  return [[version.time.start_ms, Math.max(version.time.start_ms, version.time.end_ms ?? version.time.start_ms)]];
}

function merged(spans: readonly [number, number][], reach: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [lo, hi] of [...spans].sort((left, right) => left[0] - right[0])) {
    const last = out.at(-1);
    if (last !== undefined && lo - last[1] <= reach) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}
