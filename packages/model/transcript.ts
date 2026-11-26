import { canonical, type JsonObject } from "@lifestreamprotocol/core";
import { bare } from "./answer-types.js";

export const TIMED_TRANSCRIPT: JsonObject = {
  type: "object",
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start_s: { type: ["number", "null"] },
          end_s: { type: ["number", "null"] },
          text: { type: ["string", "null"] },
        },
        required: ["start_s", "end_s", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["segments"],
  additionalProperties: false,
};

export interface TimedSegment {
  readonly start_s: number | null;
  readonly end_s: number | null;
  readonly text: string | null;
}

export interface TimedTranscript {
  readonly segments: readonly TimedSegment[];
}

export interface KeptSegment {
  readonly start_s: number;
  readonly end_s: number;
  readonly text: string;
}

export interface KeptTranscript {
  readonly segments: readonly KeptSegment[];
  readonly dropped: number;
}

export const PAST_END_S = 2;

const TIMED = canonical(TIMED_TRANSCRIPT);

export function isTimedSchema(schema: JsonObject): boolean {
  return canonical(bare(schema)) === TIMED;
}

const spoken = (text: string): string => text.trim().replace(/\s+/gu, " ");

function whole(segment: TimedSegment, length_s: number): KeptSegment | null {
  const { start_s, end_s, text } = segment;
  if (start_s === null || end_s === null || text === null) return null;
  if (!Number.isFinite(start_s) || !Number.isFinite(end_s) || start_s < 0 || end_s < start_s || end_s > length_s + PAST_END_S) return null;
  if (spoken(text) === "") return null;
  return { start_s, end_s, text: text.trim() };
}

const overlaps = (later: KeptSegment, earlier: KeptSegment): boolean => later.start_s === earlier.start_s || later.start_s < earlier.end_s;

export function keptSegments(answer: TimedTranscript, length_s: number): KeptTranscript {
  const valid = answer.segments.map((segment) => whole(segment, length_s)).filter((segment): segment is KeptSegment => segment !== null);
  const sorted = [...valid].sort((left, right) => left.start_s - right.start_s || left.end_s - right.end_s);
  const kept: KeptSegment[] = [];
  for (const segment of sorted) {
    const words = spoken(segment.text);
    if (kept.some((earlier) => overlaps(segment, earlier) && spoken(earlier.text) === words)) continue;
    kept.push(segment);
  }
  return { segments: kept, dropped: answer.segments.length - kept.length };
}
