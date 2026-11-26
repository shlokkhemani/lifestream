import type { CallTrack, RecordRef } from "@lifestreamprotocol/core";
import type { Party } from "../shared/cast.js";
import type { Span } from "./rule.js";

export const CALLAUDIO_FAMILY = "callaudio";

export interface CallPart {
  kind: string;
  key: string;
  track: CallTrack;
  sha256: string;
  media_type: string;
  start_ms: number;
  ms: number;
  loud_s: number | null;
  quiet: boolean;
  asked: boolean;
}

export interface JoinedCall {
  record: RecordRef;
  unit: string;
  service: string;
  span: Span;
  handles: string[];
  parties: Party[];
  other: Party | null;
}

export interface ShortUse {
  short: true;
  source: string;
}

export interface CallContent {
  short: false;
  source: string;
  span: Span;
  mic: CallPart[];
  sound: CallPart[];
  holder: string | null;
  camera: boolean;
  speakers: Span[];
  stopped_ms: number | null;
  open: boolean;
  joined: JoinedCall | null;
}

export type CallAudioContent = ShortUse | CallContent;

export interface CallSummary {
  title: string;
  summary: string;
}

export function partItem(part: Pick<CallPart, "sha256">): string {
  return `recording:${part.sha256}`;
}

const STRETCH = "stretch:";

export function stretchItem(unit: string): string {
  return `${STRETCH}${unit}`;
}

export function stretchUnit(item: string): string | null {
  return item.startsWith(STRETCH) && item.length > STRETCH.length ? item.slice(STRETCH.length) : null;
}

export function askedParts(content: CallContent): CallPart[] {
  return [...content.mic, ...content.sound].filter((part) => part.asked)
    .sort((left, right) => left.start_ms - right.start_ms || (left.track === right.track ? 0 : left.track === "mic" ? -1 : 1));
}

export function partRecord(source: string, part: Pick<CallPart, "kind" | "key">): RecordRef {
  return { source, kind: part.kind, key: part.key };
}
