import type { ExtractRow, Json, RecordRef } from "@lifestreamprotocol/core";
import { CALLAUDIO_FAMILY, MESSAGES_FAMILY, VOICE_FAMILY, type CallContent, type CallPart, type ChatDay } from "@lifestreamprotocol/families";
import { describe, expect, it } from "vitest";
import { makeRef } from "./refs.js";
import { citation } from "./search-contract.js";
import { voiced, voiceOf } from "./voice-cite.js";

const WHATSAPP = "whatsapp:15550000009:iphone-aa01";
const IMESSAGE = "imessage:local:macbook-pro-0001";
const RECORDER = "voice-notes:local:iphone-aa01";
const NOTE = `sha256:${"a".repeat(64)}`;
const OTHER = `sha256:${"b".repeat(64)}`;
const HEX = "c".repeat(64);
const AT = Date.parse("2026-10-04T20:40:00Z");

type Message = ChatDay["messages"][number];

const message = (source: string, key: string, more: Partial<Message> = {}): Message => ({
  source, key, at: AT, from: { id: "+15550000001", kind: "phone" }, ...more,
});

const chatDay = (messages: Message[]): ExtractRow => ({
  family: MESSAGES_FAMILY, unit: "whatsapp/2026-10-04/chat-a", reading: "r", code: "1",
  content: { network: "whatsapp", chat: "chat-a", day: "2026-10-04", messages } as unknown as Json,
  start_ms: AT, end_ms: AT, days: ["2026-10-04"], seq: 1,
});

const recording = (key: string, ask: boolean, duration_seconds: number): ExtractRow => ({
  family: VOICE_FAMILY, unit: `${RECORDER}/${key}`, reading: "r", code: "2",
  content: { sha256: HEX, media_type: "audio/mp4", duration_seconds, started_ms: AT, ended_ms: AT + 23_000, location: null, ask } as unknown as Json,
  start_ms: AT, end_ms: AT + 23_000, days: ["2026-10-04"], seq: 2,
});

const whatsappNote = { what: "voice note", blob: NOTE, media_type: "audio/ogg", ask: "transcript" as const, format: "ogg", seconds: 23 };
const imessageNote = { what: "voice note", blob: OTHER, media_type: "audio/x-caf", ask: "transcript" as const, format: "m4a" };

const day = chatDay([
  message(WHATSAPP, "w1", { parts: [whatsappNote] }),
  message(IMESSAGE, "i1", { parts: [imessageNote] }),
  message(WHATSAPP, "w2", { from: { id: "me", kind: "me" }, parts: [{ ...whatsappNote, seconds: 4 }] }),
  message(WHATSAPP, "w3", { parts: [{ what: "voice note", blob: NOTE, seconds: 23 }] }),
  message(WHATSAPP, "w4", { withdrawn: true, parts: [whatsappNote] }),
  message(WHATSAPP, "w5", { text: "Synthetic words" }),
  message(WHATSAPP, "w6", { parts: [{ what: "photo", blob: OTHER, media_type: "image/jpeg", ask: "caption" }] }),
]);

const ref = (record: RecordRef) => makeRef("record", record);
const msg = (source: string, key: string): RecordRef => ({ source, kind: "message", key });
const voice = (record: RecordRef): RecordRef => ({ source: RECORDER, kind: "voice", key: record.key });

describe("voiceOf: a cited message's or recording's voice note, from its unit extract", () => {
  const held: [string, ExtractRow, RecordRef, string | undefined, unknown][] = [
    ["a WhatsApp note states its seconds and who said it", day, msg(WHATSAPP, "w1"), "Person A", { audio: NOTE, record: ref(msg(WHATSAPP, "w1")), seconds: 23, from: "Person A" }],
    ["an iMessage note states no seconds", day, msg(IMESSAGE, "i1"), "Person A", { audio: OTHER, record: ref(msg(IMESSAGE, "i1")), from: "Person A" }],
    ["the person's own note is mine, named by no one", day, msg(WHATSAPP, "w2"), "You", { audio: NOTE, record: ref(msg(WHATSAPP, "w2")), seconds: 4, mine: true }],
    ["a note whose speaker the day did not name has no from", day, msg(WHATSAPP, "w1"), undefined, { audio: NOTE, record: ref(msg(WHATSAPP, "w1")), seconds: 23 }],
    ["an iPhone recording is mine, its seconds rounded", recording("n1", true, 22.6), voice(msg(RECORDER, "n1")), undefined, { audio: `sha256:${HEX}`, record: ref(voice(msg(RECORDER, "n1"))), seconds: 23, mine: true }],
    ["a recording under a second states 0 seconds", recording("n2", true, 0.3), voice(msg(RECORDER, "n2")), undefined, { audio: `sha256:${HEX}`, record: ref(voice(msg(RECORDER, "n2"))), seconds: 0, mine: true }],
  ];
  for (const [name, extract, record, from, expected] of held) {
    it(name, () => {
      const found = voiceOf(extract, { record, item: null, at_ms: AT }, () => from);
      expect(found).toEqual(expected);
      const line = { ref: makeRef("line", { day: "2026-10-04", same: "0a0b0c0d0e0f1011", m: 0, unit: extract.unit, item: null }), kind: "line", day: "2026-10-04", opens: { page: "read" }, voice: found };
      expect(citation.parse(line)).toEqual(line);
    });
  }

  const none: [string, ExtractRow, RecordRef][] = [
    ["a note whose blob the home does not hold (no ask)", day, msg(WHATSAPP, "w3")],
    ["a withdrawn message", day, msg(WHATSAPP, "w4")],
    ["a plain text message", day, msg(WHATSAPP, "w5")],
    ["a photo", day, msg(WHATSAPP, "w6")],
    ["a message the extract does not hold", day, msg(WHATSAPP, "w9")],
    ["a message of another source with the same key", day, msg(IMESSAGE, "w1")],
    ["a recording whose blob the home does not hold", recording("n3", false, 12), voice(msg(RECORDER, "n3"))],
    ["a dictation", { ...recording("d1", true, 0), content: { text: "Synthetic words", at_ms: AT } as unknown as Json }, voice(msg(RECORDER, "d1"))],
    ["a unit of another family", { ...day, family: "calls" }, msg(WHATSAPP, "w1")],
  ];
  for (const [name, extract, record] of none) {
    it(`none for ${name}`, () => expect(voiceOf(extract, { record, item: null, at_ms: AT }, () => "Person A")).toBeUndefined());
  }

  it("names the families whose units hold a voice note, and no other", () => {
    expect([MESSAGES_FAMILY, VOICE_FAMILY, CALLAUDIO_FAMILY, "calls", "photos", "constructor"].map(voiced)).toEqual([true, true, true, false, false, false]);
  });
});

describe("voiceOf: a cited call turn plays its own part from the turn's time", () => {
  const MAC = "audio:local:macbook-pro-0001";
  const MIC = "d".repeat(64), SOUND = "e".repeat(64);
  const part = (track: CallPart["track"], sha256: string): CallPart => ({
    kind: `${track}-recording`, key: "20261005T083000.000Z", track, sha256, media_type: "audio/mp4", start_ms: AT, ms: 600_000, loud_s: 300, quiet: false, asked: true,
  });
  const content: CallContent = {
    short: false, source: MAC, span: { start_ms: AT, end_ms: AT + 600_000 }, mic: [part("mic", MIC)], sound: [part("sound", SOUND)],
    holder: "Zoom", camera: false, speakers: [], stopped_ms: null, open: false, joined: null,
  };
  const call: ExtractRow = {
    family: CALLAUDIO_FAMILY, unit: `${MAC}/mic-recording/20261005T083000.000Z`, reading: "r", code: "3",
    content: content as unknown as Json, start_ms: AT, end_ms: AT + 600_000, days: ["2026-10-05"], seq: 3,
  };
  const mic: RecordRef = { source: MAC, kind: "mic-recording", key: "20261005T083000.000Z" };
  const sound: RecordRef = { source: MAC, kind: "sound-recording", key: "20261005T083000.000Z" };
  const turn = (record: RecordRef, sha256: string, at_ms: number) => ({ record, item: `recording:${sha256}`, at_ms });

  it("two turns of one part play from two places, the person's own as mine", () => {
    expect(voiceOf(call, turn(mic, MIC, AT + 1_000), () => "You")).toEqual({ audio: `sha256:${MIC}`, record: ref(mic), seconds: 600, from_s: 1, mine: true });
    expect(voiceOf(call, turn(mic, MIC, AT + 600_500), () => "You")).toEqual({ audio: `sha256:${MIC}`, record: ref(mic), seconds: 600, from_s: 600, mine: true });
    expect(voiceOf(call, turn(mic, MIC, AT + 254_900), () => "You")).toEqual({ audio: `sha256:${MIC}`, record: ref(mic), seconds: 600, from_s: 254, mine: true });
  });

  it("the other side's turn is named by its line, and the call's first second states no from_s", () => {
    expect(voiceOf(call, turn(sound, SOUND, AT + 11_000), () => "Person B")).toEqual({ audio: `sha256:${SOUND}`, record: ref(sound), seconds: 600, from_s: 11, from: "Person B" });
    expect(voiceOf(call, turn(sound, SOUND, AT), () => "Them")).toEqual({ audio: `sha256:${SOUND}`, record: ref(sound), seconds: 600, from: "Them" });
    const cited = voiceOf(call, turn(sound, SOUND, AT + 11_000), () => "Person B");
    const line = { ref: makeRef("line", { day: "2026-10-05", same: "0a0b0c0d0e0f1011", m: 0, unit: call.unit, item: null }), kind: "line", day: "2026-10-05", opens: { page: "read" }, voice: cited };
    expect(citation.parse(line)).toEqual(line);
  });

  it("the call's head line plays nothing, though its record is the call's first part", () => {
    expect(voiceOf(call, { record: mic, item: `stretch:${call.unit}`, at_ms: AT }, () => "You")).toBeUndefined();
    expect(voiceOf(call, { record: mic, item: null, at_ms: AT }, () => "You")).toBeUndefined();
  });

  it("none for a part the call does not hold, or a short use", () => {
    expect(voiceOf(call, turn(mic, "f".repeat(64), AT), () => "You")).toBeUndefined();
    expect(voiceOf({ ...call, content: { short: true, source: MAC } as unknown as Json }, turn(mic, MIC, AT), () => "You")).toBeUndefined();
  });
});
