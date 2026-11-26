import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { canonical, digest, piecesText, parse, type Ask, type DaySettings, type ExtractRow, type Json, type JsonObject, type ReaderOutput } from "@lifestreamprotocol/core";
import { checkDayFile, renderDay, tableUnits } from "../days.js";
import { buildLabels } from "../shared/labels.js";
import { VOICE_TRANSCRIPT, VOICE_TRANSCRIPT_PROMPT, voiceFamily } from "./family.js";
import { FED } from "../test/fed.js";
import { pin } from "../test/pin.js";
import { askKey, dayReader, FakeLedger, inputHash, ROUTE, sha256, shuffled, TestHome } from "../test/drive.js";
import { WORDS_CAP } from "./dictations.js";
import { conforming } from "../test/units.js";

const GOLDEN_FILE = new URL("./test/golden/voice-transcript.golden.json", import.meta.url);
const WRITE = process.env.LIFESTREAM_FIXTURES === "write";
const GOLDEN = JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as {
  made_by: string;
  runtime: { model: string; effort: string; sampling: { temperature: number } };
  notes: {
    name: string; audio_text: string; sha256: string; payload: Json;
    request: { model: string; prompt_hash: string; input_hash: string; body: string; attachments: { kind: string; sha256: string; extension: string }[] };
  }[];
};

const VOICE = "voice-notes:local:iphone-aa01";
const WISPR = "wispr-flow:person-a@example.com:macbook-pro-0001";
const AQUA = "aqua-voice:100001:macbook-pro-0001";
const SETTINGS: DaySettings = { zone: "Asia/Kolkata", day_start_hour: 4 };
const family = voiceFamily(FED.voice);
const transcript = (ask: Ask) => `A synthetic transcript of ${ask.item.slice(6, 14)}.`;
const PLACE = { slug: "place-a", name: "Place A", latitude: 10.5, longitude: 20.25, radius_m: 500, ids: [], also: [] };

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.close();
});
function home(): TestHome {
  const opened = new TestHome("lifestream-voice-");
  homes.push(opened);
  return opened;
}

function note(sequence: number, startedIso: string, seconds: number, options: { audio?: string; tick?: number; media?: string } = {}): { payload: JsonObject; audio: Buffer } {
  const audio = Buffer.from(options.audio ?? `synthetic audio ${sequence}`);
  const started = Date.parse(startedIso);
  const tick = options.tick ?? 0;
  return {
    audio,
    payload: {
      type: "voice.note",
      content: {
        captured: { elapsed_seconds: 100 + tick, wall_rfc3339: new Date(started + seconds * 1000 + 30).toISOString(), wall_unix_seconds: started / 1000 + tick },
        domain: "voice", kind: "voice_note", observed_at: startedIso,
        payload: {
          blob: { bytes: audio.length, hash: `sha256:${sha256(audio)}`, role: "voice_note", type: options.media ?? "audio/mp4" },
          capture_mode: "hands_free", duration_seconds: seconds,
          encoder: { bit_rate: 128000 + tick, channels: 1, container: "m4a", format: "aac_lc", sample_rate_hz: 48000 },
          end_reason: "tapped", ended_at: new Date(started + seconds * 1000).toISOString(),
          input: { port_name: tick === 0 ? "Synthetic Microphone" : "Synthetic Headset", port_type: "MicrophoneBuiltIn" },
          location: { horizontal_accuracy: 8 + tick, latitude: PLACE.latitude, longitude: PLACE.longitude, timestamp: new Date(started - 60_000 + tick).toISOString() },
          started_at: startedIso,
        },
        process_instance_id: `00000000-0000-4000-8000-0000000000a${tick}`, schema_version: 1, sequence,
      },
    },
  };
}

function row(target: TestHome, payload: Json, audio: Buffer, sequence: number, held = true): ReaderOutput {
  const blob = held ? target.blobs.put(audio, { mediaType: "audio/mp4" }) : `sha256:${sha256(audio)}`;
  const content = payload as JsonObject;
  const started = ((content.content as JsonObject).payload as JsonObject).started_at as string;
  return {
    kind: "voice", key: `00000000-0000-4000-8000-0000000000aa:${sequence}`, content: payload,
    time: { start_ms: Date.parse(started), precision: "ms" }, device: "iphone-aa01", blobs: [blob],
  };
}

function extracts(target: TestHome): ExtractRow[] {
  return target.read((view) => [...view.extracts("voice")]).sort((left, right) => left.unit < right.unit ? -1 : 1);
}

function comparable(rows: ExtractRow[]) {
  return rows.map(({ unit, reading, content, days, start_ms, end_ms }) => ({ unit, reading, content, days, start_ms, end_ms }));
}


interface WisprRow {
  id: string; at: string; asr?: string | null; formatted?: string | null; edited?: string | null; pasted?: string | null;
  app?: string | null; url?: string | null; status?: string; tick?: number;
}
function wispr({ id, at, asr = null, formatted = null, edited = null, pasted, app = "com.example.chat", url = null, status = "formatted", tick = 0 }: WisprRow): ReaderOutput {
  const audio = Buffer.from(`synthetic dictation audio ${id} ${tick}`);
  const history: JsonObject = {
    transcriptEntityId: id, asrText: asr, formattedText: formatted, editedText: edited, pastedText: pasted === undefined ? formatted : pasted,
    timestamp: `${at.slice(0, 10)} ${at.slice(11, 23)} +00:00`, timezoneOffsetMinutes: -330, status, app, url,
    audio: { hash: `sha256:${sha256(audio)}`, bytes: audio.length }, screenshot: null, opusChunks: null,
    additionalContext: JSON.stringify({ ax_context: null, tick }), e2eLatency: 250.5 + tick, needsUploading: tick % 2, duration: 2.5,
    numWords: 4, shareType: "no", textboxContents: tick === 0 ? null : "synthetic textbox", appVersion: `1.3.${tick}`,
    editedTextStatus: "NOT_EXTRACTED", editedTextAttempts: tick, averageLogProb: -0.25 - tick, platform: "desktop",
  };
  return { kind: "dictation", key: id, content: { type: "wispr-flow.dictation", History: history }, time: { start_ms: Date.parse(at), precision: "ms" }, device: "macbook-pro-0001" };
}

function aqua(session: number, at: string, content: string, rawText: string | null): ReaderOutput {
  const audio = Buffer.from(`synthetic aqua recording ${session}`);
  return {
    kind: "dictation", key: String(session), time: { start_ms: Date.parse(at), precision: "ms" }, device: "macbook-pro-0001",
    content: {
      type: "aqua-voice.dictation",
      dictation: { kind: "transcription", source: "local", timestamp: at, content, rawText, sessionId: session, audioFilePath: `audio/AQ_${Date.parse(at) - 2}.wav`, audioDurationSeconds: 4.2 },
      audio: { hash: `sha256:${sha256(audio)}`, bytes: audio.length },
    },
  };
}

function dictations(): { wispr: ReaderOutput[]; aqua: ReaderOutput[] } {
  const id = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;
  return {
    wispr: [
      wispr({ id: id(1), at: "2026-09-05T06:00:00.250Z", asr: "um synthetic one", formatted: "Synthetic one." }),
      wispr({ id: id(2), at: "2026-09-05T06:03:00.000Z", asr: "synthetic two", formatted: "Synthetic two.", edited: "Synthetic two, edited." }),
      wispr({ id: id(3), at: "2026-09-05T06:07:30.000Z", asr: "synthetic three", formatted: "Synthetic three.", pasted: "Synthetic three, pasted." }),
      wispr({ id: id(4), at: "2026-09-05T06:08:00.000Z", asr: "synthetic four", formatted: "Synthetic four.", app: "com.example.browser", url: "https://example.com/compose/?draft=fake-token#top" }),
      wispr({ id: id(5), at: "2026-09-05T06:30:00.000Z", asr: "synthetic five", formatted: null, pasted: null }),
      wispr({ id: id(6), at: "2026-09-05T06:31:00.000Z", status: "dismissed", app: null }),
      wispr({ id: id(7), at: "2026-09-05T07:00:00.000Z", formatted: `${"Synthetic long dictation. ".repeat(60).trim()}`, app: "com.example.editor" }),
    ],
    aqua: [
      aqua(190000001, "2026-09-05T06:15:00.002Z", "", null),
      aqua(190000002, "2026-09-05T06:16:00.500Z", "Synthetic Aqua, written.", "synthetic aqua written"),
      aqua(190000003, "2026-09-05T06:17:00.084Z", "", "synthetic aqua heard only"),
    ],
  };
}

let clock = Date.UTC(2026, 8, 6);
const next = () => (clock += 1_000);

describe("the voice family: each way it could fail, written before the code", () => {
  it("an extract is written when only an unread field ticked (capture clocks, process ids, encoder, microphone, fix accuracy)", () => {
    const target = home();
    const first = note(1, "2026-09-05T06:30:00.000Z", 6.317125);
    target.land(VOICE, next(), [row(target, first.payload, first.audio, 1)]);
    const pass = target.extractPass(family, SETTINGS);
    expect(pass.written.length).toBe(1);
    const ledger = new FakeLedger(ROUTE);
    expect(ledger.settle(target, family, transcript).asked.length).toBe(1);
    const before = comparable(extracts(target));
    const ticked = note(1, "2026-09-05T06:30:00.000Z", 6.317125, { tick: 7 });
    expect(canonical(ticked.payload)).not.toBe(canonical(first.payload));
    target.land(VOICE, next(), [row(target, ticked.payload, ticked.audio, 1)]);
    const again = target.extractPass(family, SETTINGS);
    expect(again.touched.length).toBe(1);
    expect(again.written).toEqual([]);
    expect(comparable(extracts(target))).toEqual(before);
    expect(ledger.settle(target, family, transcript).asked).toEqual([]);
    target.artifact("unread-ticks", { pass, again, extracts: before });
  });

  it("units differ when the same data arrives in another order", () => {
    const notes = [1, 2, 3, 4].map((sequence) => note(sequence, new Date(Date.UTC(2026, 8, 5, 6, 30 + sequence)).toISOString(), sequence * 1.5));
    const run = (order: number[]) => {
      const target = home();
      for (const index of order) {
        target.land(VOICE, next(), [row(target, notes[index]!.payload, notes[index]!.audio, index + 1)]);
        target.extractPass(family, SETTINGS);
      }
      return comparable(extracts(target));
    };
    const forward = run([0, 1, 2, 3]);
    expect(forward.length).toBe(4);
    expect(run([3, 2, 1, 0])).toEqual(forward);
    expect(run([2, 0, 3, 1])).toEqual(forward);
  });

  it("an answered item is asked again", () => {
    const target = home();
    const notes = [1, 2].map((sequence) => note(sequence, new Date(Date.UTC(2026, 8, 5, 6, 30 + sequence)).toISOString(), 3));
    const odd = note(3, "2026-09-05T07:00:00.000Z", 3, { media: "audio/x-caf" });
    target.land(VOICE, next(), [...notes.map((item, index) => row(target, item.payload, item.audio, index + 1)), row(target, odd.payload, odd.audio, 3)]);
    target.extractPass(family, SETTINGS);
    const ledger = new FakeLedger(ROUTE);
    expect(ledger.settle(target, family, transcript).asked.length).toBe(2);
    expect(ledger.settle(target, family, transcript).asked).toEqual([]);
    expect(ledger.sent.length).toBe(2);
    const refusing = new FakeLedger(ROUTE);
    let replies = 0;
    const again = refusing.settle(target, family, (ask) => (replies++ === 0 ? "" : transcript(ask)));
    expect(again.refused.length).toBe(1);
    expect(refusing.sent.length).toBe(3);
  });

  it("a note whose audio has not arrived is asked about, or its arrival never asks it", () => {
    const target = home();
    const late = note(1, "2026-09-05T06:30:00.000Z", 3);
    target.land(VOICE, next(), [row(target, late.payload, late.audio, 1, false)]);
    target.extractPass(family, SETTINGS);
    expect(new FakeLedger(ROUTE).settle(target, family, transcript).asked).toEqual([]);
    target.blobs.put(late.audio, { mediaType: "audio/mp4" });
    const [stored] = extracts(target);
    const reread = target.read((view) => family.extract(stored!.unit, view, target.blobs))!;
    expect(reread.reading).not.toBe(stored!.reading);
    expect(family.plan!({ ...stored!, ...reread }, new Map()).asks.map((ask) => ask.item)).toEqual([`voice:${sha256(late.audio)}`]);
  });

  it("a voice request's input or identity differs from the golden", () => {
    const target = home();
    GOLDEN.notes.forEach((entry, index) => {
      const payload = parse(canonical(entry.payload));
      target.land(VOICE, next(), [row(target, payload, Buffer.from(entry.audio_text), index + 1)]);
    });
    target.extractPass(family, SETTINGS);
    const asked = new FakeLedger(ROUTE).settle(target, family, transcript).asked;
    expect(family.prompts![VOICE_TRANSCRIPT]).toBe(VOICE_TRANSCRIPT_PROMPT);
    expect(GOLDEN.runtime).toMatchObject(ROUTE);
    if (WRITE) {
      const made_by = "the request voice/e2e.test.ts writes under LIFESTREAM_FIXTURES=write: the body and its prompt's hash today's prompt's, the input and identity those the ledger's transcripts were first asked with, which the test holds";
      const notes = GOLDEN.notes.map((entry) => {
        const ask = asked.find((candidate) => candidate.item === `voice:${entry.sha256}`)!;
        return { ...entry, request: { ...entry.request, prompt_hash: digest(VOICE_TRANSCRIPT_PROMPT.text), body: VOICE_TRANSCRIPT_PROMPT.text + piecesText(ask.input) } };
      });
      writeFileSync(GOLDEN_FILE, `${JSON.stringify({ ...GOLDEN, made_by, notes }, null, 2)}\n`);
    }
    const written = JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as typeof GOLDEN;
    const keys = written.notes.map((entry) => {
      const ask = asked.find((candidate) => candidate.item === `voice:${entry.sha256}`)!;
      expect(ask).toBeDefined();
      expect(entry.request.prompt_hash, "test/golden/voice-transcript.golden.json is today's prompt's: LIFESTREAM_FIXTURES=write writes it").toBe(digest(VOICE_TRANSCRIPT_PROMPT.text));
      const text = entry.request.body.slice(0, entry.request.body.length - piecesText(ask.input).length);
      expect({ model: ROUTE.model, input: entry.request.body.endsWith(piecesText(ask.input)), prompt_hash: digest(text), input_hash: inputHash(ask), attachments: ask.attachments }).toEqual({
        model: entry.request.model, input: true, prompt_hash: entry.request.prompt_hash, input_hash: entry.request.input_hash,
        attachments: [{ blob: `sha256:${entry.request.attachments[0]!.sha256}`, media_type: "audio/mp4" }],
      });
      expect(entry.request.attachments[0]!.extension).toBe(".m4a");
      expect([ask.work, ask.source]).toEqual(["voice", VOICE]);
      return { name: entry.name, ...askKey(family, ask, ROUTE) };
    });
    target.artifact("golden-keys", keys);
  });

  it("version 2, in Latin letters, keeps version 1's transcripts as they are: a note transcribed before is not asked again", () => {
    expect([VOICE_TRANSCRIPT_PROMPT.version, VOICE_TRANSCRIPT_PROMPT.type, VOICE_TRANSCRIPT_PROMPT.keeps, VOICE_TRANSCRIPT_PROMPT.converters]).toEqual([2, "text", [{ version: 1, type: "text" }], undefined]);
  });

  it("a dictation moves a paid ask: the transcripts asked on a day of notes and dictations differ from the golden by identity", () => {
    const target = home();
    GOLDEN.notes.forEach((entry, index) => target.land(VOICE, next(), [row(target, parse(canonical(entry.payload)), Buffer.from(entry.audio_text), index + 1)]));
    const { wispr: wisprRows, aqua: aquaRows } = dictations();
    target.land(WISPR, next(), wisprRows);
    target.land(AQUA, next(), aquaRows);
    target.extractPass(family, SETTINGS);
    const dictated = extracts(target).filter((extract) => !extract.unit.startsWith(VOICE));
    expect(dictated.length).toBe(8);
    expect(dictated.flatMap((extract) => [...family.items!(extract), ...family.plan!(extract, new Map()).asks])).toEqual([]);
    const ledger = new FakeLedger(ROUTE);
    const asked = ledger.settle(target, family, transcript).asked.map((ask) => inputHash(ask)).sort();
    expect(asked).toEqual(GOLDEN.notes.map((entry) => entry.request.input_hash).sort());
    target.artifact("asks", { asked, units: extracts(target).map((extract) => extract.unit) });
    pin(family, { voice: FED.voice }, extracts(target));
  });

  it("a dictation is written again when only an unread field ticked (audio, latency, upload flag, textbox, app version, scores, context)", () => {
    const target = home();
    const first = wispr({ id: "00000000-0000-4000-8000-000000000201", at: "2026-09-05T06:00:00.000Z", formatted: "Synthetic words." });
    target.land(WISPR, next(), [first]);
    expect(target.extractPass(family, SETTINGS).written.length).toBe(1);
    const before = comparable(extracts(target));
    const ticked = wispr({ id: "00000000-0000-4000-8000-000000000201", at: "2026-09-05T06:00:00.000Z", formatted: "Synthetic words.", tick: 3 });
    expect(canonical(ticked.content)).not.toBe(canonical(first.content));
    target.land(WISPR, next(), [ticked]);
    const again = target.extractPass(family, SETTINGS);
    expect(again.touched.length).toBe(1);
    expect(again.written).toEqual([]);
    expect(comparable(extracts(target))).toEqual(before);
    target.land(WISPR, next(), [wispr({ id: "00000000-0000-4000-8000-000000000201", at: "2026-09-05T06:00:00.000Z", formatted: "Synthetic words.", edited: "Synthetic words, fixed." })]);
    expect(target.extractPass(family, SETTINGS).written.length).toBe(1);
  });

  it("dictations print another form than the last the product states, lose their app or page, print past the cap unsaid, or group apart from time and app", () => {
    const runs = [0, 1].map((seed) => {
      const target = home();
      const { wispr: wisprRows, aqua: aquaRows } = dictations();
      const all = shuffled([...wisprRows.map((each) => [WISPR, each] as const), ...aquaRows.map((each) => [AQUA, each] as const)], seed + 3);
      for (const half of [all.slice(0, 5), all.slice(5)]) {
        for (const source of [WISPR, AQUA]) target.land(source, next(), half.filter(([named]) => named === source).map(([, each]) => each));
        target.extractPass(family, SETTINGS);
      }
      const rendered = target.read((view) => conforming(renderDay("2026-09-05", [family], dayReader(view), SETTINGS, tableUnits(buildLabels({ people: [], contacts: [], places: [] })))));
      expect(checkDayFile(JSON.parse(rendered.json))).toEqual([]);
      return { target, txt: rendered.txt, units: comparable(extracts(target)) };
    });
    expect(runs[1]!.units).toEqual(runs[0]!.units);
    expect(runs[1]!.txt).toBe(runs[0]!.txt);
    const lines = runs[0]!.txt.split("\n");
    const timed = lines.slice(lines.indexOf("") + 1, lines.indexOf("Coverage") - 1);
    const long = `${"Synthetic long dictation. ".repeat(60).trim()}`;
    expect(long.length).toBeGreaterThan(WORDS_CAP);
    expect(timed).toEqual([
      "11:30–11:37 Dictated into com.example.chat (3)",
      '  11:30 "Synthetic one."',
      '  11:33 "Synthetic two, edited."',
      '  11:37 "Synthetic three, pasted."',
      '11:38 Dictated into com.example.browser (example.com/compose): "Synthetic four."',
      "11:46–11:47 Dictated with Aqua Voice (2)",
      '  11:46 "Synthetic Aqua, written."',
      '  11:47 "synthetic aqua heard only"',
      '12:00 Dictated into com.example.chat: "synthetic five"',
      `12:30 Dictated into com.example.editor: "${long.slice(0, WORDS_CAP)}…" [${long.length.toLocaleString("en-US")} characters]`,
    ]);
    runs[0]!.target.artifact("dictations-day", { txt: runs[0]!.txt });
  });

  it("a dictation's search text is another form than the last the product states, or cut at the day's cap; a dismissed dictation has one, or a recording is read for one", () => {
    const target = home();
    const { wispr: wisprRows, aqua: aquaRows } = dictations();
    target.land(WISPR, next(), wisprRows);
    target.land(AQUA, next(), aquaRows);
    const { payload, audio } = note(1, "2026-09-05T06:31:00.000Z", 3);
    target.land(VOICE, next(), [row(target, payload, audio, 1)]);
    const id = (n: number) => `${WISPR} dictation 00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;
    expect(Object.fromEntries(target.texts(family).map(({ record, text }) => [record, text]))).toEqual({
      [`${AQUA} dictation 190000001`]: null,
      [`${AQUA} dictation 190000002`]: { text: "Synthetic Aqua, written." },
      [`${AQUA} dictation 190000003`]: { text: "synthetic aqua heard only" },
      [id(1)]: { text: "Synthetic one." },
      [id(2)]: { text: "Synthetic two, edited." },
      [id(3)]: { text: "Synthetic three, pasted." },
      [id(4)]: { text: "Synthetic four." },
      [id(5)]: { text: "synthetic five" },
      [id(6)]: null,
      [id(7)]: { text: "Synthetic long dictation. ".repeat(60).trim() },
    });
    expect("Synthetic long dictation. ".repeat(60).trim().length).toBeGreaterThan(WORDS_CAP);
    target.artifact("texts.json", target.texts(family));
  });

  it("`renderDay` reads outside `days()`", () => {
    const target = home();
    const across = note(1, "2026-09-05T22:29:50.000Z", 20);
    const noon = note(2, "2026-09-05T06:30:00.000Z", 4.554291666666667);
    target.land(VOICE, next(), [row(target, across.payload, across.audio, 1), row(target, noon.payload, noon.audio, 2)]);
    target.extractPass(family, SETTINGS);
    new FakeLedger(ROUTE).settle(target, family, transcript);
    const seen: Record<string, string[]> = {};
    const files: Record<string, string> = {};
    for (const day of ["2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07"]) {
      const reads: { family: string; unit: string; day: string }[] = [];
      const rendered = target.read((view) => renderDay(day, [family], dayReader(view, reads), SETTINGS, tableUnits(buildLabels({ people: [], contacts: [], places: [PLACE] }))));
      for (const one of reads) expect(family.days(extracts(target).find((row) => row.unit === one.unit)!, SETTINGS)).toContain(day);
      const document = JSON.parse(rendered.json) as { atoms: { units: string[] }[] };
      expect(checkDayFile(document)).toEqual([]);
      for (const atom of document.atoms) for (const unit of atom.units) seen[unit] = [...(seen[unit] ?? []), day];
      files[day] = rendered.txt;
    }
    expect(seen).toEqual({ [`${VOICE}/00000000-0000-4000-8000-0000000000aa:1`]: ["2026-09-05", "2026-09-06"], [`${VOICE}/00000000-0000-4000-8000-0000000000aa:2`]: ["2026-09-05"] });
    expect(files["2026-09-05"]).toContain("Voice note, 5 s at Place A: A synthetic transcript");
    target.artifact("days", files);
  });
});
