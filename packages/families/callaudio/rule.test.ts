import { describe, expect, it } from "vitest";
import type { CallTrack } from "@lifestreamprotocol/core";
import { callRule, holderOf, isOpen, isQuiet, joins, loudSeconds, stoppedAt, stretchesOf, THRESHOLDS, unitOf, type Part, type Stretch } from "./rule.js";

const T0 = Date.UTC(2026, 0, 5, 10, 0, 0);
const MIN = 60;
const SOURCE = "audio:local:macbook-pro-0001";
const ZOOM = "us.zoom.xos";
const CHROME = "com.google.Chrome";
const DICTATION = "com.example.dictation";

type Loud = ((t: number) => boolean) | null;

const talk = {
  mic: (t: number) => t % 20 < 8,
  sound: (t: number) => t % 20 >= 10 && t % 20 < 18,
};
const always = (): boolean => true;
const never = (): boolean => false;

interface Shape {
  readonly holder?: string;
  readonly holders?: readonly string[];
  readonly players?: readonly string[];
  readonly session?: string | null;
  readonly camera?: boolean;
  readonly offset_ms?: number;
  readonly ended_by?: string;
  readonly quiet_dbfs?: number;
}

function part(track: CallTrack, from_s: number, seconds: number, loud: Loud, shape: Shape = {}, index = 1): Part {
  const start_ms = T0 + from_s * 1_000 + (shape.offset_ms ?? 0);
  const holders = shape.holders ?? [shape.holder ?? ZOOM];
  const made: Part = {
    kind: track === "mic" ? "mic-recording" : "sound-recording",
    key: `${track}-${from_s}`,
    track,
    start_ms,
    end_ms: start_ms + seconds * 1_000,
    sha256: `${from_s}`.padStart(64, track === "mic" ? "a" : "b"),
    media_type: "audio/mp4",
    ms: seconds * 1_000,
    part: index,
    ended_by: shape.ended_by ?? "part_limit",
    holders,
    players: shape.players ?? holders,
    camera: shape.camera ?? false,
    loudness: loud === null ? null : { every_ms: 1_000, rms_dbfs: Array.from({ length: seconds }, (_, second) => (loud(from_s + second) ? -20 : shape.quiet_dbfs ?? -70)) },
    outputs: [],
  };
  const session = shape.session === undefined ? `${track}-session-${from_s}` : shape.session;
  return session === null ? made : { ...made, session };
}

function track(name: CallTrack, from_min: number, to_min: number, loud: Loud, shape: Shape = {}): Part[] {
  const parts: Part[] = [];
  const session = shape.session === undefined ? `${name}-session-${from_min}` : shape.session;
  for (let from = from_min * MIN, index = 1; from < to_min * MIN; from += 10 * MIN, index++) {
    parts.push(part(name, from, Math.min(10 * MIN, to_min * MIN - from), loud, { ...shape, session }, index));
  }
  return parts;
}

const both = (from_min: number, to_min: number, mic: Loud, sound: Loud, shape: Shape = {}): Part[] => [
  ...track("mic", from_min, to_min, mic, shape),
  ...track("sound", from_min, to_min, sound, shape),
];

const verdicts = (parts: readonly Part[], joined = false): boolean[] => stretchesOf(parts).map((stretch) => callRule(stretch, joined).call);

const only = (parts: readonly Part[]): Stretch => {
  const stretches = stretchesOf(parts);
  expect(stretches).toHaveLength(1);
  return stretches[0]!;
};

describe("callRule", () => {
  it("takes a Zoom call, a Meet in Chrome and a call on speakers for calls", () => {
    expect(verdicts(both(0, 30, talk.mic, talk.sound))).toEqual([true]);
    expect(verdicts(both(0, 25, talk.mic, talk.sound, { holder: CHROME }))).toEqual([true]);
    const speakers = both(0, 20, (t) => talk.mic(t) || talk.sound(t), talk.sound);
    expect(verdicts(speakers)).toEqual([true]);
  });

  it("leaves dictation, Siri, dictation over music and a short exchange as short uses", () => {
    expect(verdicts(both(0, 8 / MIN, always, never, { holder: DICTATION }))).toEqual([false]);
    expect(verdicts(both(0, 6, always, never, { holder: DICTATION }))).toEqual([false]);
    expect(verdicts(both(0, 6, always, always, { holder: DICTATION }))).toEqual([false]);
    expect(verdicts([part("mic", 0, 10, (t) => t < 6), part("sound", 0, 10, (t) => t >= 6)])).toEqual([false]);
    expect(verdicts(both(0, 1.5, talk.mic, talk.sound))).toEqual([false]);
  });

  it("leaves a dictation app that mutes what plays while it listens a short use: between its sounds the sound side is digital silence, never a line, unless a call record says it was a call", () => {
    expect(verdicts(both(0, 30, talk.mic, talk.sound, { holder: DICTATION, quiet_dbfs: -96 }))).toEqual([false]);
    expect(callRule(only(track("sound", 0, 20, talk.sound, { camera: true, quiet_dbfs: -96 }))).call).toBe(false);
    expect(verdicts(both(0, 30, talk.mic, talk.sound, { quiet_dbfs: -88 }))).toEqual([true]);
    expect(verdicts(both(0, 30, talk.mic, talk.sound, { quiet_dbfs: -96 }), true)).toEqual([true]);
  });

  it("leaves a Meet tab held six hours beside a playing video a short use", () => {
    const stretch = only(both(0, 6 * 60, never, always, { holder: CHROME }));
    expect(stretch.parts).toHaveLength(72);
    expect(callRule(stretch)).toEqual({ call: false, two_way_ms: 0 });
  });

  it("runs a call's span from its first to its last two-way window", () => {
    const parts = both(0, 30, (t) => t >= 5 * MIN && t < 20 * MIN && talk.mic(t), (t) => t >= 5 * MIN && t < 20 * MIN && talk.sound(t));
    const verdict = callRule(only(parts));
    expect(verdict).toEqual({ call: true, span: { start_ms: T0 + 5 * MIN * 1_000, end_ms: T0 + 20 * MIN * 1_000 }, two_way_ms: 15 * MIN * 1_000 });
  });

  it("asks a crash-sealed part beside a heard two-way window or a joined call record: one with no loudness counts its whole span", () => {
    const sealed = [part("mic", 0, 10 * MIN, null), part("sound", 0, 10 * MIN, null)];
    expect(callRule(only(sealed))).toEqual({ call: false, two_way_ms: 0 });
    expect(callRule(only(sealed), true)).toEqual({ call: true, span: { start_ms: T0, end_ms: T0 + 10 * MIN * 1_000 }, two_way_ms: 0 });
    const half = [part("mic", 0, 10 * MIN, null), part("sound", 0, 10 * MIN, talk.sound)];
    expect(callRule(only(half)).call).toBe(false);
    expect(callRule(only(half), true).call).toBe(true);
    const heardFirst = [...both(0, 1, talk.mic, talk.sound), part("mic", MIN, 10 * MIN, null), part("sound", MIN, 10 * MIN, null)];
    expect(callRule(only(heardFirst))).toEqual({ call: true, span: { start_ms: T0, end_ms: T0 + 11 * MIN * 1_000 }, two_way_ms: MIN * 1_000 });
    expect(isQuiet(sealed[0]!)).toBe(false);
    expect(loudSeconds(sealed[0]!)).toBeNull();
  });

  it("names a call's app by the holder that plays its sound, never a dictation app that held the mic longer", () => {
    const call = (players: readonly string[]) => [
      ...both(0, 10, talk.mic, talk.sound, { holders: [ZOOM, DICTATION], players }),
      ...track("mic", 10, 14, always, { holders: [DICTATION], players: [] }),
    ];
    expect(holderOf(only(call([ZOOM])))).toBe(ZOOM);
    expect(holderOf(only(call([])))).toBe(DICTATION);
  });

  it("counts a sound-only stretch a call only when a call record joins it or the camera was on", () => {
    const sound = track("sound", 0, 20, talk.sound);
    expect(callRule(only(sound))).toEqual({ call: false, two_way_ms: 0 });
    expect(callRule(only(sound), true).call).toBe(true);
    expect(callRule(only(track("sound", 0, 20, talk.sound, { camera: true }))).call).toBe(true);
    expect(callRule(only(track("sound", 0, 1, talk.sound)), true).call).toBe(false);
    expect(callRule(only(track("sound", 0, 10, always, { holder: CHROME }))).call).toBe(false);
  });

  it("never takes a mic-only stretch for a call, joined or not", () => {
    expect(callRule(only(track("mic", 0, 30, talk.mic)), true)).toEqual({ call: false, two_way_ms: 0 });
  });
});

describe("stretchesOf", () => {
  it("cuts two meetings of one hold where both tracks are quiet for the split gap, the tracks' boundaries a few ms apart", () => {
    const meeting = (t: number, side: (t: number) => boolean) => (t < 20 * MIN || t >= 40 * MIN) && side(t);
    const parts = [
      ...track("mic", 0, 60, (t) => meeting(t, talk.mic), { holder: CHROME }),
      ...track("sound", 0, 60, (t) => meeting(t, talk.sound), { holder: CHROME, offset_ms: 7 }),
    ];
    const stretches = stretchesOf(parts);
    expect(stretches.map((stretch) => unitOf(SOURCE, stretch))).toEqual([`${SOURCE}/mic-recording/mic-0`, `${SOURCE}/mic-recording/mic-2400`]);
    expect(stretches.map((stretch) => stretch.parts.length)).toEqual([4, 4]);
    expect(stretches.map((stretch) => callRule(stretch).call)).toEqual([true, true]);
  });

  it("cuts two meetings of one hold where no two-way window falls for the split gap, music between them a short use", () => {
    const parts = [
      ...track("mic", 0, 60, (t) => (t < 20 * MIN || t >= 40 * MIN) && talk.mic(t), { holder: CHROME }),
      ...track("sound", 0, 60, (t) => (t < 20 * MIN || t >= 40 * MIN ? talk.sound(t) : true), { holder: CHROME }),
    ];
    const stretches = stretchesOf(parts);
    expect(stretches.map((stretch) => unitOf(SOURCE, stretch))).toEqual([
      `${SOURCE}/mic-recording/mic-0`, `${SOURCE}/mic-recording/mic-1200`, `${SOURCE}/mic-recording/mic-2400`,
    ]);
    expect(stretches.map((stretch) => callRule(stretch).call)).toEqual([true, false, true]);
  });

  it("cuts a dictation hold at every stretch of the split gap with no two-way window, and judges each piece alone", () => {
    const parts = both(0, 120, always, (t) => t % (40 * MIN) < MIN && talk.sound(t), { holder: DICTATION, players: [CHROME] });
    const stretches = stretchesOf(parts);
    expect(stretches.map((stretch) => stretch.windows.length)).toEqual([2, 0, 2, 0, 2, 0]);
    expect(stretches.map((stretch) => callRule(stretch).call)).toEqual([false, false, false, false, false, false]);
    expect(stretches.flatMap((stretch) => stretch.parts).length).toBe(parts.length);
  });

  it("never cuts through a part with no loudness", () => {
    const quietMiddle = [...both(0, 10, talk.mic, talk.sound), ...both(10, 20, never, never), ...both(20, 30, talk.mic, talk.sound)];
    expect(stretchesOf(quietMiddle)).toHaveLength(2);
    const sealed = quietMiddle.map((each) => (each.track === "mic" && each.start_ms === T0 + 10 * MIN * 1_000 ? { ...each, loudness: null } : each));
    expect(stretchesOf(sealed)).toHaveLength(1);
  });

  it("keeps back-to-back uses of different apps apart and joins one app's", () => {
    const zoom = both(0, 20, talk.mic, talk.sound, { holder: ZOOM });
    expect(stretchesOf([...zoom, ...both(21, 40, talk.mic, talk.sound, { holder: CHROME })])).toHaveLength(2);
    expect(stretchesOf([...zoom, ...both(21, 25, always, never, { holder: DICTATION })])).toHaveLength(2);
    expect(stretchesOf([...zoom, ...both(21, 40, talk.mic, talk.sound, { holder: ZOOM })])).toHaveLength(1);
    expect(stretchesOf([...zoom, ...both(23, 40, talk.mic, talk.sound, { holder: ZOOM })])).toHaveLength(2);
  });

  it("joins a call across a device change: two mic sessions 40 s apart", () => {
    const parts = [
      ...track("sound", 0, 30, talk.sound),
      part("mic", 0, 10 * MIN, talk.mic, { session: "mic-a", ended_by: "device_changed" }),
      part("mic", 10 * MIN + 40, 10 * MIN, talk.mic, { session: "mic-b" }),
    ];
    expect(callRule(only(parts)).call).toBe(true);
  });

  it("chains a part with no session only by overlap or its own holder", () => {
    const parts = [part("mic", 0, 5 * MIN, talk.mic, { session: null }), part("sound", 0, 5 * MIN, talk.sound, { session: null })];
    expect(only(parts).parts).toHaveLength(2);
  });

  it("gives a quiet part inside a cut to no stretch", () => {
    const parts = [...both(0, 10, talk.mic, talk.sound), ...both(10, 25, never, never), ...both(25, 35, talk.mic, talk.sound)];
    const stretches = stretchesOf(parts);
    expect(stretches).toHaveLength(2);
    expect(stretches.flatMap((stretch) => stretch.parts.map((each) => each.key)).sort()).toEqual(["mic-0", "mic-1500", "sound-0", "sound-1500"]);
    expect(stretchesOf(both(0, 30, never, never))).toEqual([]);
  });

  it("names a stretch by its earliest part, mic first, whatever order its parts arrive in", () => {
    const parts = both(0, 30, talk.mic, talk.sound);
    const forward = stretchesOf(parts);
    const backward = stretchesOf([...parts].reverse());
    expect(backward).toEqual(forward);
    expect(unitOf(SOURCE, forward[0]!)).toBe(`${SOURCE}/mic-recording/mic-0`);
    const soundFirst = [...track("sound", 0, 20, talk.sound), ...track("mic", 1, 20, talk.mic)];
    expect(unitOf(SOURCE, only(soundFirst))).toBe(`${SOURCE}/sound-recording/sound-0`);
  });
});

describe("open, closed and joins", () => {
  it("keeps a stretch open until read-through passes its last part's end and the join gap", () => {
    const stretch = only(both(0, 20, talk.mic, talk.sound));
    expect(isOpen(stretch, stretch.end_ms + THRESHOLDS.JOIN_GAP)).toBe(true);
    expect(isOpen(stretch, stretch.end_ms + THRESHOLDS.JOIN_GAP + 1)).toBe(false);
  });

  it("ends a stretch at a stopped part: the same app back within the join gap is a stretch of its own, and the stopped one closes at its end", () => {
    const stopped = [
      part("mic", 0, 10 * MIN, talk.mic, { session: "mic-a", ended_by: "stopped" }),
      part("sound", 0, 10 * MIN, talk.sound, { session: "sound-a", ended_by: "stopped" }),
    ];
    const back = both(11, 20, talk.mic, talk.sound);
    const stretches = stretchesOf([...back, ...stopped]);
    expect(stretches.map((stretch) => stretch.parts.map((each) => each.key))).toEqual([["mic-0", "sound-0"], ["mic-660", "sound-660"]]);
    expect(stretches.map(stoppedAt)).toEqual([T0 + 10 * MIN * 1_000, null]);
    expect(isOpen(stretches[0]!, stretches[0]!.end_ms)).toBe(true);
    expect(isOpen(stretches[0]!, stretches[0]!.end_ms + 1)).toBe(false);
    expect(stretchesOf([...back, ...stopped.map((each) => ({ ...each, ended_by: "holders_gone" }))])).toHaveLength(1);
  });

  it("joins a call record that overlaps half of the stretch and half of itself", () => {
    const stretch = { start_ms: 0, end_ms: 100 };
    expect(joins(stretch, { start_ms: 40, end_ms: 110 })).toBe(true);
    expect(joins(stretch, { start_ms: 60, end_ms: 110 })).toBe(false);
    expect(joins(stretch, { start_ms: -200, end_ms: 100 })).toBe(false);
    expect(joins(stretch, { start_ms: 50, end_ms: 50 })).toBe(false);
  });
});
