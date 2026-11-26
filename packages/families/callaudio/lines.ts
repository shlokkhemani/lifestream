import { isObject, render, type EnrichmentRow, type Piece, type RecordRef } from "@lifestreamprotocol/core";
import { drawnFrom, factId, type DayFact, type DayInput, type DayLine, type DayProjection, type Labels, type NameSpan } from "../family.js";
import { partyName } from "../calls/family.js";
import { free, said } from "../shared/said.js";
import { namesOther, turnsOf, whoOf, type KeptSegment, type Other, type Turn } from "./turns.js";
import {
  askedParts, CALLAUDIO_FAMILY, partItem, partRecord, stretchItem,
  type CallAudioContent, type CallContent, type CallPart, type CallSummary,
} from "./content.js";

const SUMMARY_CHARS = 300_000;
export const NOT_JOINED = "none";

const HOLDER_NAMES: Readonly<Record<string, string>> = {
  "us.zoom.xos": "Zoom",
  "com.google.Chrome": "Chrome",
  "com.apple.Safari": "Safari",
  "company.thebrowser.Browser": "Arc",
  "com.brave.Browser": "Brave",
  "org.mozilla.firefox": "Firefox",
  "com.microsoft.edgemac": "Edge",
  "com.microsoft.teams2": "Microsoft Teams",
  "com.microsoft.teams": "Microsoft Teams",
  "com.tinyspeck.slackmacgap": "Slack",
  "net.whatsapp.WhatsApp": "WhatsApp",
  "com.apple.FaceTime": "FaceTime",
  "com.hnc.Discord": "Discord",
  "ru.keepcoder.Telegram": "Telegram",
  "com.cisco.webexmeetingsapp": "Webex",
};

export function holderName(holder: string): string {
  return HOLDER_NAMES[holder] ?? holder;
}

export interface PartsState {
  asked: number;
  done: number;
  given_up: number;
  waiting: number;
}

export type Enriched = (item: string) => EnrichmentRow | undefined;

export function heardOf(enriched: Enriched): (item: string) => readonly KeptSegment[] | null {
  return (item) => {
    const row = enriched(item);
    return row?.state === "done" && isObject(row.content) && Array.isArray(row.content.segments) ? row.content.segments as unknown as KeptSegment[] : null;
  };
}

export function summaryOf(unit: string, enriched: Enriched): CallSummary | null {
  const row = enriched(stretchItem(unit));
  return row?.state === "done" && isObject(row.content) && typeof row.content.title === "string" ? row.content as unknown as CallSummary : null;
}

export function partsState(content: CallContent, enriched: Enriched): PartsState {
  const asked = askedParts(content);
  const states = asked.map((part) => enriched(partItem(part))?.state);
  const done = states.filter((state) => state === "done").length;
  const given_up = states.filter((state) => state === "given-up").length;
  return { asked: asked.length, done, given_up, waiting: asked.length - done - given_up };
}

export interface CallTurn extends Turn {
  part: CallPart;
}

export function callTurns(content: CallContent, heard: (item: string) => readonly KeptSegment[] | null): CallTurn[] {
  const byKey = new Map(askedParts(content).map((part) => [`${part.track}\0${part.key}`, part]));
  const parts = askedParts(content).flatMap((part) => {
    const segments = heard(partItem(part));
    return segments === null ? [] : [{ key: part.key, track: part.track, start_ms: part.start_ms, segments }];
  });
  return turnsOf(parts, content.speakers).filter((turn) => turn.start_ms >= content.span.start_ms)
    .map((turn) => ({ ...turn, part: byKey.get(`${turn.track}\0${turn.key}`)! }));
}

export function bracketOf(state: PartsState): string | null {
  if (state.asked === 0) return "(not transcribed)";
  if (state.waiting > 0) return `(transcribing, ${state.done} of ${state.asked} parts)`;
  if (state.given_up > 0) return `(${state.given_up} ${state.given_up === 1 ? "part" : "parts"} couldn't be read)`;
  return null;
}

export function lengthWords(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function sentence(title: string): string {
  return /[.!?…]$/u.test(title) ? title : `${title}.`;
}

export function headWords(content: CallContent, state: PartsState, summary: CallSummary | null): { text: string; title: string } {
  const base = content.joined !== null ? "Call transcript" : `Call${content.holder === null ? "" : ` on ${content.holder}`}, ${lengthWords(content.span.end_ms - content.span.start_ms)}`;
  const bracket = bracketOf(state);
  const said_ = summary === null ? "" : `: ${[sentence(summary.title), summary.summary].filter((each) => each !== "").join(" ")}`;
  return { text: `${base}${bracket === null ? "" : ` ${bracket}`}${said_}`, title: summary === null ? base : `${base}: ${summary.title}` };
}

export function otherName(content: CallContent, labels: Labels): (Other & { who: string | null }) | null {
  const other = content.joined?.other ?? null;
  if (other === null) return null;
  const named = partyName(other, labels);
  return { name: named.name, who: named.who, span: content.joined!.span };
}

export function callDay(input: DayInput): DayProjection {
  const lines: DayLine[] = [];
  const facts: DayFact[] = [];
  for (const extract of input.extracts) {
    const content = extract.content as unknown as CallAudioContent;
    if (content.short) continue;
    const unit = extract.unit;
    const enriched: Enriched = (item) => input.enrichments.get(item);
    const head = headWords(content, partsState(content, enriched), summaryOf(unit, enriched));
    const key = `${CALLAUDIO_FAMILY}:${unit}`;
    const block = { key, title: head.title };
    const joins: { joins?: RecordRef } = content.joined === null ? {} : { joins: content.joined.record };
    const joined = content.joined === null ? [] : [content.joined.record];
    const first = [...content.mic, ...content.sound].sort((left, right) => left.start_ms - right.start_ms || (left.track === "mic" ? -1 : 1))[0]!;
    const whole = drawnFrom([unit], [...[...content.mic, ...content.sound].map((part) => partRecord(content.source, part)), ...joined]);
    const at = lines.push({
      family: CALLAUDIO_FAMILY, unit, units: [unit], ...whole, start_ms: content.span.start_ms, end_ms: content.span.end_ms, text: head.text,
      record: partRecord(content.source, first), item: stretchItem(unit), block, chat: key, ...joins,
    }) - 1;
    const other = otherName(content, input.labels);
    for (const turn of callTurns(content, heardOf(enriched))) {
      const who = whoOf(turn, other);
      const names: NameSpan[] = namesOther(turn, other) && other.who !== null ? [{ start: 0, end: who.length, who: other.who }] : [];
      lines.push({
        family: CALLAUDIO_FAMILY, unit, units: [unit], ...drawnFrom([unit], [partRecord(content.source, turn.part), ...joined]),
        start_ms: turn.start_ms, end_ms: turn.end_ms, text: `${who}: ${turn.text}`,
        ...(names.length === 0 ? {} : { names }), record: partRecord(content.source, turn.part), item: partItem(turn.part), block, chat: key, ...joins,
      });
    }
    facts.push({
      of: CALLAUDIO_FAMILY, id: factId(CALLAUDIO_FAMILY, unit), time_ms: content.span.start_ms, start_ms: content.span.start_ms, end_ms: content.span.end_ms,
      keys: { ...(content.holder === null ? {} : { app: content.holder }), call: content.joined?.service ?? NOT_JOINED }, measures: { minutes: (content.span.end_ms - content.span.start_ms) / 60_000 },
      who: (content.joined?.handles ?? []).map((handle) => ({ handle, role: "attendee" as const })),
      from: { units: [unit], ...whole, record: partRecord(content.source, first), item: stretchItem(unit) }, lines: [at],
    });
  }
  return { lines, facts };
}

export function summaryInput(content: CallContent, heard: (item: string) => readonly KeptSegment[] | null, zone: string): Piece[] {
  const clock = (ms: number) => render(ms, zone, "s").slice(11, 19);
  const length = content.span.end_ms - content.span.start_ms;
  const out: Piece[] = said`App: ${content.holder ?? "unknown"}\nStart: ${render(content.span.start_ms, zone, "minute")} ${zone}\nLength: ${lengthWords(length)}\n\n`;
  let chars = out.reduce((sum, piece) => sum + piece.text.length, 0);
  const turns = callTurns(content, heard);
  for (const [index, turn] of turns.entries()) {
    const line = said`${clock(turn.start_ms)} ${turn.track === "mic" ? "You" : "Them"}: ${free(turn.text)}\n`;
    const size = line.reduce((sum, piece) => sum + piece.text.length, 0);
    if (chars + size > SUMMARY_CHARS) {
      const left = Math.ceil((turns.at(-1)!.end_ms - turns[index]!.start_ms) / 60_000);
      out.push({ text: `[the call goes on for ${left} more ${left === 1 ? "minute" : "minutes"}, left out]\n` });
      break;
    }
    out.push(...line);
    chars += size;
  }
  return out;
}
