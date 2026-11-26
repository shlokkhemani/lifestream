import type { EnrichmentRow, ExtractRow, RecordRef } from "@lifestreamprotocol/core";
import { whoOf } from "./turns.js";
import type { Labels } from "../family.js";
import { callTurns, heardOf, otherName, partsState, summaryOf, type Enriched, type PartsState } from "./lines.js";
import { askedParts, partItem, partRecord, stretchItem, type CallAudioContent, type CallSummary } from "./content.js";
import { CALL_SUMMARY, CALL_TRANSCRIPT } from "./family.js";

export interface CallAudioTurn {
  at_ms: number;
  end_ms: number;
  mine: boolean;
  who: string;
  words: string;
  heard: { record: RecordRef; item: string; from_ms: number };
}

export interface CallAudioView {
  summary: CallSummary | null;
  summary_item: string;
  asked: string[];
  stopped_ms: number | null;
  open: boolean;
  camera: boolean;
  parts: PartsState;
  turns: CallAudioTurn[];
}

export function callAudioView(extract: ExtractRow, answers: Enriched, labels: Labels): CallAudioView | null {
  const content = extract.content as unknown as CallAudioContent;
  if (content.short) return null;
  const other = otherName(content, labels);
  return {
    summary: summaryOf(extract.unit, answers),
    summary_item: stretchItem(extract.unit),
    asked: askedParts(content).map(partItem),
    stopped_ms: content.stopped_ms,
    open: content.open,
    camera: content.camera,
    parts: partsState(content, answers),
    turns: callTurns(content, heardOf(answers)).map((turn) => ({
      at_ms: turn.start_ms, end_ms: turn.end_ms, mine: turn.track === "mic", who: whoOf(turn, other), words: turn.text,
      heard: { record: partRecord(content.source, turn.part), item: partItem(turn.part), from_ms: Math.round(turn.from_s * 1_000) },
    })),
  };
}

export function callAudioAnswers(unit: string, read: (item: string, prompt: string) => EnrichmentRow | undefined): Enriched {
  const summary = stretchItem(unit);
  return (item) => read(item, item === summary ? CALL_SUMMARY : CALL_TRANSCRIPT);
}

export interface PartAudio {
  blob: string;
  seconds: number;
  mine: boolean;
  from_s: number;
}

export function partAudioOf(extract: ExtractRow, item: string | null, at_ms: number | null): PartAudio | null {
  const content = extract.content as unknown as CallAudioContent;
  if (content.short || item === null) return null;
  const part = [...content.mic, ...content.sound].find((each) => partItem(each) === item);
  if (part === undefined) return null;
  const seconds = Math.round(part.ms / 1_000);
  const from_s = at_ms === null ? 0 : Math.min(seconds, Math.max(0, Math.floor((at_ms - part.start_ms) / 1_000)));
  return { blob: `sha256:${part.sha256}`, seconds, mine: part.track === "mic", from_s };
}
