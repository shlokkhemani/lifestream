import { describe, expect, it } from "vitest";
import { faults, read } from "./answer-types.js";
import { isTimedSchema, TIMED_TRANSCRIPT } from "./transcript.js";

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
