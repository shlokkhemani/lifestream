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

const TIMED = canonical(TIMED_TRANSCRIPT);

export function isTimedSchema(schema: JsonObject): boolean {
  return canonical(bare(schema)) === TIMED;
}
