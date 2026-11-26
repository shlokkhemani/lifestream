import { describe, expect, it } from "vitest";
import type { CallAudioPart, CallTrack, Json } from "@lifestreamprotocol/core";
import type { CallContent, CallPart } from "./content.js";
import { callTurns } from "./lines.js";
import { THRESHOLDS } from "./rule.js";
import { readTranscript, speakerSpans, turnsOf, whoOf, type Heard, type KeptSegment } from "./turns.js";

const T0 = Date.UTC(2026, 0, 5, 10, 0, 0);
const PART_S = 600;

const segment = (start_s: number | null, end_s: number | null, text: string | null): Json => ({ start_s, end_s, text });
const kept = (start_s: number, end_s: number, text: string): KeptSegment => ({ start_s, end_s, text });
const heard = (track: CallTrack, index: number, segments: KeptSegment[]): Heard => ({ key: `${track}-${index}`, track, start_ms: T0 + index * PART_S * 1_000, segments });

describe("readTranscript", () => {
  it("drops each unreadable segment and keeps the rest in order", () => {
    const answer = {
      segments: [
        segment(12, 14.5, "Second."),
        segment(0.5, 3, "  First.  "),
        segment(null, 4, "No start."),
        segment(5, null, "No end."),
        segment(6, 7, null),
        segment(-1, 2, "Before the start."),
        segment(9, 8, "Reversed."),
        segment(PART_S - 1, PART_S + THRESHOLDS.PAST_END_S + 1, "Past the end."),
        segment(PART_S - 1, PART_S + THRESHOLDS.PAST_END_S, "At the end."),
        segment(10, 11, "   "),
        segment(12.5, 13, "Second."),
        segment(20, 21, "Second."),
      ],
    };
    expect(readTranscript(answer, PART_S)).toEqual({
      segments: [kept(0.5, 3, "First."), kept(12, 14.5, "Second."), kept(20, 21, "Second."), kept(PART_S - 1, PART_S + THRESHOLDS.PAST_END_S, "At the end.")],
      dropped: 8,
      refused: "8 of 12 segments are unreadable",
    });
  });

  it("refuses an answer only past the bad share", () => {
    const good = [segment(0, 1, "One."), segment(2, 3, "Two.")];
    expect(readTranscript({ segments: [...good, segment(null, 1, "Bad.")] }, PART_S).refused).toBeNull();
    expect(readTranscript({ segments: [...good, segment(null, 1, "Bad."), segment(5, 4, "Bad.")] }, PART_S).refused).toBeNull();
    expect(readTranscript({ segments: [...good, segment(null, 1, "Bad."), segment(5, 4, "Bad."), segment(-2, 1, "Bad.")] }, PART_S).refused).toBe("3 of 5 segments are unreadable");
  });

  it("takes an empty list for no speech and refuses an answer with no segments", () => {
    expect(readTranscript({ segments: [] }, PART_S)).toEqual({ segments: [], dropped: 0, refused: null });
    expect(readTranscript("words", PART_S).refused).toBe("the answer states no segments");
  });
});

describe("speakerSpans", () => {
  it("holds the times the room played to the built-in speakers", () => {
    const part = (outputs: CallAudioPart["outputs"]): CallAudioPart => ({
      track: "mic", start_ms: T0, end_ms: T0 + PART_S * 1_000, sha256: "a".repeat(64), media_type: "audio/mp4", ms: PART_S * 1_000, part: 1,
      ended_by: "part_limit", holders: ["us.zoom.xos"], players: ["us.zoom.xos"], camera: false, loudness: null, outputs,
    });
    expect(speakerSpans([part([
      { at_ms: T0, uid: "BuiltInSpeakerDevice", transport: "built_in" },
      { at_ms: T0 + 300_000, uid: "headset-0001", transport: "bluetooth" },
      { at_ms: T0 + 400_000 },
      { at_ms: T0 + 500_000, uid: "BuiltInSpeakerDevice", transport: "built_in" },
    ])])).toEqual([{ start_ms: T0, end_ms: T0 + 300_000 }, { start_ms: T0 + 500_000, end_ms: T0 + PART_S * 1_000 }]);
    expect(speakerSpans([part([{ at_ms: T0 }])])).toEqual([]);
  });
});

describe("turnsOf", () => {
  const doubleTalk = [
    heard("mic", 0, [kept(10, 16, "Sounds good to me we will send the lease papers tomorrow."), kept(30, 33, "Thank you, see you then.")]),
    heard("sound", 0, [kept(12, 17, "We will send the lease papers tomorrow."), kept(40, 44, "Bye now.")]),
  ];
  const all = [{ start_ms: T0, end_ms: T0 + PART_S * 1_000 }];

  it("removes the other side's echo from the mic on the built-in speakers and keeps the person's words", () => {
    expect(turnsOf(doubleTalk, all).map((turn) => [turn.track, turn.text])).toEqual([
      ["mic", "Sounds good to me"],
      ["sound", "We will send the lease papers tomorrow."],
      ["mic", "Thank you, see you then."],
      ["sound", "Bye now."],
    ]);
  });

  it("removes nothing on headphones, and no run shorter than the echo's words", () => {
    expect(turnsOf(doubleTalk, []).map((turn) => turn.text)[0]).toBe("Sounds good to me we will send the lease papers tomorrow.");
    const short = [heard("mic", 0, [kept(10, 12, "I read the lease papers.")]), heard("sound", 0, [kept(10, 13, "Did you see the lease papers yet?")])];
    expect(turnsOf(short, all).map((turn) => turn.text)).toEqual(["I read the lease papers.", "Did you see the lease papers yet?"]);
  });

  it("drops a mic segment that was only echo, and leaves an echo outside its reach", () => {
    const echo = [heard("mic", 0, [kept(12, 17, "We will send the lease papers tomorrow.")]), heard("sound", 0, [kept(12.2, 17, "We will send the lease papers tomorrow.")])];
    expect(turnsOf(echo, all).map((turn) => turn.track)).toEqual(["sound"]);
    const far = [heard("mic", 0, [kept(30, 35, "We will send the lease papers tomorrow.")]), heard("sound", 0, [kept(12, 17, "We will send the lease papers tomorrow.")])];
    expect(turnsOf(far, all).map((turn) => turn.track)).toEqual(["sound", "mic"]);
  });

  it("joins one track's segments across a part boundary and interleaves the tracks by start", () => {
    const turns = turnsOf([
      heard("mic", 1, [kept(0.5, 2, "the calendar first."), kept(9, 10, "Done.")]),
      heard("mic", 0, [kept(PART_S - 3, PART_S, "Let me check")]),
      heard("sound", 1, [kept(1, 3, "Sure, take your time.")]),
    ], []);
    expect(turns).toEqual([
      { track: "mic", start_ms: T0 + (PART_S - 3) * 1_000, end_ms: T0 + (PART_S + 2) * 1_000, text: "Let me check the calendar first.", key: "mic-0", from_s: PART_S - 3 },
      { track: "sound", start_ms: T0 + (PART_S + 1) * 1_000, end_ms: T0 + (PART_S + 3) * 1_000, text: "Sure, take your time.", key: "sound-1", from_s: 1 },
      { track: "mic", start_ms: T0 + (PART_S + 9) * 1_000, end_ms: T0 + (PART_S + 10) * 1_000, text: "Done.", key: "mic-1", from_s: 9 },
    ]);
  });

  it("ends a turn at a pause of the turn gap or at the longest turn, and keeps one long segment one turn", () => {
    const texts = (segments: KeptSegment[]) => turnsOf([heard("sound", 0, segments)], []).map((turn) => turn.text);
    expect(texts([kept(0, 30, "A."), kept(31, 59, "B."), kept(60, 70, "C.")])).toEqual(["A. B.", "C."]);
    expect(texts([kept(0, 5, "A."), kept(7, 9, "B.")])).toEqual(["A.", "B."]);
    expect(texts([kept(0, 75, "A long one.")])).toEqual(["A long one."]);
  });

  it("names the mic You and the other side by the joined call's one other party only inside that call's span, else Them", () => {
    const other = { name: "Person A", span: { start_ms: T0 + 120_000, end_ms: T0 + 600_000 } };
    const turn = (track: CallTrack, start_s: number, end_s: number) => ({ track, start_ms: T0 + start_s * 1_000, end_ms: T0 + end_s * 1_000 });
    expect(whoOf(turn("mic", 200, 210), other)).toBe("You");
    expect(whoOf(turn("mic", 10, 20), other)).toBe("You");
    expect(whoOf(turn("sound", 200, 210), other)).toBe("Person A");
    expect(whoOf(turn("sound", 10, 20), other)).toBe("Them");
    expect(whoOf(turn("sound", 100, 150), other)).toBe("Person A");
    expect(whoOf(turn("sound", 590, 640), other)).toBe("Them");
    expect(whoOf(turn("sound", 200, 210), null)).toBe("Them");
  });
});

describe("callTurns", () => {
  it("prints no turn that starts before the call's span", () => {
    const mic: CallPart = {
      kind: "mic-recording", key: "mic-0", track: "mic", sha256: "a".repeat(64), media_type: "audio/mp4", start_ms: T0, ms: PART_S * 1_000, loud_s: 300, quiet: false, asked: true,
    };
    const content: CallContent = {
      short: false, source: "audio:local:macbook-pro-0001", span: { start_ms: T0 + 60_000, end_ms: T0 + PART_S * 1_000 }, mic: [mic], sound: [],
      holder: "Zoom", camera: false, speakers: [], stopped_ms: null, open: false, joined: null,
    };
    const turns = callTurns(content, () => [kept(10, 12, "Before the call."), kept(70, 72, "In the call.")]);
    expect(turns.map((turn) => turn.text)).toEqual(["In the call."]);
  });
});
