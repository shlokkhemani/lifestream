import { describe, expect, it } from "vitest";
import { faults, read } from "./answer-types.js";
import { isTimedSchema, keptSegments, PAST_END_S, TIMED_TRANSCRIPT, type TimedSegment } from "./transcript.js";

const segment = (start_s: number | null, end_s: number | null, text: string | null): TimedSegment => ({ start_s, end_s, text });

describe("the timed transcript", () => {
  it("is a type inside the answer subset whose every member of a segment is nullable, so a missing one costs that segment only", () => {
    expect(faults(TIMED_TRANSCRIPT)).toEqual([]);
    expect(read(TIMED_TRANSCRIPT, '{"segments":[{"start_s":0,"end_s":1.5,"text":"Hello."},{"start_s":2}]}')).toEqual({
      value: { segments: [{ start_s: 0, end_s: 1.5, text: "Hello." }, { start_s: 2, end_s: null, text: null }] },
    });
    expect(read(TIMED_TRANSCRIPT, '{"segments":[]}')).toEqual({ value: { segments: [] } });
    expect(read(TIMED_TRANSCRIPT, '{"segments":[{"start_s":"01:05","end_s":66,"text":"Hello."}]}')).toEqual({ violations: [expect.stringContaining("start_s")] });
  });

  it("is known by its bare type, its descriptions aside, and no other type is", () => {
    expect(isTimedSchema(JSON.parse(JSON.stringify(TIMED_TRANSCRIPT)))).toBe(true);
    expect(isTimedSchema({ ...TIMED_TRANSCRIPT, description: "one side of a call" })).toBe(true);
    expect(isTimedSchema({ type: "object", properties: { segments: { type: "array", items: { type: "string" } } }, required: ["segments"], additionalProperties: false })).toBe(false);
    expect(isTimedSchema({ type: "object", properties: {}, required: [], additionalProperties: false })).toBe(false);
  });
});

describe("the segments kept of a timed transcript", () => {
  it("keeps every good segment, sorted by its start, and an empty list is an answer", () => {
    const answer = { segments: [segment(12, 14.5, "Second."), segment(0.5, 3, "First."), segment(12, 13, "Beside it.")] };
    expect(keptSegments(answer, 600)).toEqual({ segments: [segment(0.5, 3, "First."), segment(12, 13, "Beside it."), segment(12, 14.5, "Second.")], dropped: 0 });
    expect(keptSegments({ segments: [] }, 600)).toEqual({ segments: [], dropped: 0 });
  });

  it("drops a segment with a null member, a negative or reversed time, an end past the part, or no words", () => {
    const answer = {
      segments: [
        segment(null, 2, "No start."), segment(1, null, "No end."), segment(1, 2, null),
        segment(-0.5, 2, "Before the part."), segment(5, 4, "Reversed."), segment(598, 600 + PAST_END_S + 0.1, "Past the end."),
        segment(7, 8, "   "), segment(9, 9, "A blink."), segment(598, 600 + PAST_END_S, "At the end."),
      ],
    };
    expect(keptSegments(answer, 600)).toEqual({ segments: [segment(9, 9, "A blink."), segment(598, 600 + PAST_END_S, "At the end.")], dropped: 7 });
  });

  it("drops a model's loop, the same words over a kept segment they overlap, and keeps the same words said again later", () => {
    const answer = {
      segments: [
        segment(10, 14, "Can you hear me?"), segment(11, 15, "Can you  hear me? "), segment(10, 12, "Can you hear me?"),
        segment(14, 16, "Can you hear me?"), segment(30, 31, "Can you hear me?"), segment(11, 12, "Yes."),
      ],
    };
    expect(keptSegments(answer, 600)).toEqual({
      segments: [segment(10, 12, "Can you hear me?"), segment(11, 12, "Yes."), segment(14, 16, "Can you hear me?"), segment(30, 31, "Can you hear me?")],
      dropped: 2,
    });
  });
});
