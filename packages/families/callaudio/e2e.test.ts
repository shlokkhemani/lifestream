import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { audioCallAudio, providers } from "@lifestreamprotocol/connect";
import type { Ask, CallAudioAdapter, CallAudioPart, CallsAdapter, Call, CallTrack, DaySettings, ExtractRow, Json, ReaderOutput } from "@lifestreamprotocol/core";
import { tableUnits, type DayDocument } from "../days.js";
import type { DayLine, Family, Given } from "../family.js";
import { callsFamily } from "../calls/family.js";
import { buildLabels, labelsFrom, type DayLabels } from "../shared/labels.js";
import type { RecordState } from "../shared/people.js";
import { FED } from "../test/fed.js";
import { pin } from "../test/pin.js";
import { FakeLedger, ROUTE, sha256, TestHome } from "../test/drive.js";
import { askedParts, partItem, stretchItem, type CallAudioContent, type CallContent } from "./content.js";
import { CALL_SUMMARY, CALL_TRANSCRIPT, callaudioFamily } from "./family.js";
import type { Shape, ShapeName, Spoken } from "./test/recorded.js";
import { callAudioView } from "./view.js";

const WRITE = process.env.LIFESTREAM_FIXTURES === "write";
const FIXTURES = new URL("./test/", import.meta.url);
const SETTINGS: DaySettings = { zone: "Asia/Kolkata", day_start_hour: 4 };
const DAY = "2026-10-05";
const SOURCE = "audio:local:macbook-pro-0001";
const CALLS_SOURCE = "test-calls:local:iphone-aa01";
const T0 = Date.UTC(2026, 9, 5, 8, 30);
const MIN = 60_000;
const ZOOM = "us.zoom.xos";
const WHATSAPP = "net.whatsapp.WhatsApp";
const DICTATION = "com.example.dictation";

const PARTS: CallAudioAdapter = {
  version: "1",
  kinds: ["mic-recording", "sound-recording"],
  part: ({ version }) => version.content as unknown as CallAudioPart,
};
const AUDIO: readonly Given<CallAudioAdapter>[] = [{ product: "audio", name: "Call recordings", vendor: "lifestream", type: "voice", adapter: PARTS }];
const CALLS_ADAPTER: CallsAdapter = { version: "1", kinds: ["call"], services: { phone: "Phone call" }, call: ({ version }) => version.content as unknown as Call };
const CALLS: readonly Given<CallsAdapter>[] = [{ product: "test-calls", name: "Test Calls", vendor: "synthetic", type: "calls", adapter: CALLS_ADAPTER }];

const family = callaudioFamily({ books: FED.labels, zone: SETTINGS.zone, calls: CALLS })(AUDIO);
const recorder = callaudioFamily({ books: FED.labels, zone: SETTINGS.zone, calls: CALLS })([{ product: "audio", name: "Call recordings", vendor: "lifestream", type: "voice", adapter: audioCallAudio }]);
const READER = providers().flatMap((provider) => provider.readers).find((reader) => reader.name === "audio-recording")!;
const RECORDED = new URL("./test/recorded/", import.meta.url);
const RECORDED_DAY = "2026-10-06";
const SPOKEN = JSON.parse(readFileSync(new URL("recorded.words.json", FIXTURES), "utf8")) as Record<string, Spoken>;
const SHAPES = JSON.parse(readFileSync(new URL("recorded.shapes.json", FIXTURES), "utf8")) as Shape[];
const calls = callsFamily({ books: FED.labels, messages: FED.messages })(CALLS);

const talk = {
  mic: (second: number) => second % 20 < 8,
  sound: (second: number) => second % 20 >= 10 && second % 20 < 18,
};
const always = () => true;

interface Segment { start_s: number; end_s: number; text: string }
interface Recorded { row: ReaderOutput; audio: Buffer; sha256: string; words: Segment[] }

function recorded(track: CallTrack, start_ms: number, minutes: number, loud: (second: number) => boolean, shape: { holder: string; session: string; part: number; words: Segment[] }): Recorded {
  const audio = Buffer.from(`synthetic ${track} audio ${start_ms}`);
  const hash = sha256(audio);
  const seconds = minutes * 60;
  const part: CallAudioPart = {
    track, start_ms, end_ms: start_ms + seconds * 1_000, sha256: hash, media_type: "audio/mp4", ms: seconds * 1_000, session: shape.session, part: shape.part,
    ended_by: "part_limit", holders: [shape.holder], players: [shape.holder], camera: false,
    loudness: { every_ms: 1_000, rms_dbfs: Array.from({ length: seconds }, (_, second) => (loud(second) ? -20 : -70)) }, outputs: [],
  };
  const key = new Date(start_ms).toISOString().replace(/[-:]/gu, "");
  return {
    audio, sha256: hash, words: shape.words,
    row: {
      kind: track === "mic" ? "mic-recording" : "sound-recording", key, content: part as unknown as Json,
      time: { start_ms, end_ms: part.end_ms, precision: "ms" }, device: "macbook-pro-0001", blobs: [`sha256:${hash}`],
    },
  };
}

const at = (minutes: number, seconds = 0) => T0 + minutes * MIN + seconds * 1_000;
const said = (start_s: number, end_s: number, text: string): Segment => ({ start_s, end_s, text });

function lease(): Recorded[] {
  return [
    recorded("mic", at(0), 10, talk.mic, { holder: ZOOM, session: "mic-a", part: 1, words: [said(1, 4, "Hello, can you hear me?"), said(21, 24, "Good. Shall we go over the lease?")] }),
    recorded("sound", at(0), 10, talk.sound, { holder: ZOOM, session: "sound-a", part: 1, words: [said(11, 14, "Yes, I can hear you."), said(31, 35, "Sure, the renewal is due next month.")] }),
    recorded("mic", at(10), 10, talk.mic, { holder: ZOOM, session: "mic-a", part: 2, words: [said(2, 5, "I will send the signed copy tonight.")] }),
    recorded("sound", at(10), 10, talk.sound, { holder: ZOOM, session: "sound-a", part: 2, words: [said(8, 10, "Great, thanks.")] }),
  ];
}

function weekend(): Recorded[] {
  return [
    recorded("mic", at(120), 10, talk.mic, { holder: WHATSAPP, session: "mic-b", part: 1, words: [said(1, 3, "Are we still on for Saturday?"), said(41, 44, "I will book the table.")] }),
    recorded("sound", at(120), 10, talk.sound, { holder: WHATSAPP, session: "sound-b", part: 1, words: [said(11, 14, "Yes, Saturday works for me.")] }),
  ];
}

function dictation(): Recorded[] {
  return [recorded("mic", at(200), 6, always, { holder: DICTATION, session: "mic-c", part: 1, words: [said(0, 5, "A dictated note.")] })];
}

function backToBack(): Recorded[] {
  return [
    recorded("mic", at(120), 4, talk.mic, { holder: WHATSAPP, session: "mic-d", part: 1, words: [said(1, 3, "Is the bike still for sale?")] }),
    recorded("sound", at(120), 4, talk.sound, { holder: WHATSAPP, session: "sound-d", part: 1, words: [said(11, 14, "Yes, I can drop it off at five.")] }),
    recorded("mic", at(125), 10, talk.mic, { holder: WHATSAPP, session: "mic-e", part: 1, words: [said(1, 3, "Dinner at eight?")] }),
    recorded("sound", at(125), 10, talk.sound, { holder: WHATSAPP, session: "sound-e", part: 1, words: [said(11, 13, "Eight works.")] }),
  ];
}

const BIKE_CALL: Call = {
  service: "whatsapp", direction: "outgoing", outcome: "connected", start_ms: at(120), end_ms: at(124), parties: [{ id: "+15550000003", kind: "phone" }],
};
const DINNER_CALL: Call = {
  service: "whatsapp", direction: "outgoing", outcome: "connected", start_ms: at(125), end_ms: at(135), parties: [{ id: "+15550000002", kind: "phone" }],
};

const WEEKEND_CALL: Call = {
  service: "phone", direction: "incoming", outcome: "connected", start_ms: at(119, 30), end_ms: at(130), parties: [{ id: "+15550000002", kind: "phone" }],
};

function callRow(call: Call, key = "CALL-0001"): ReaderOutput {
  return { kind: "call", key, content: call as unknown as Json, time: { start_ms: call.start_ms, end_ms: call.end_ms!, precision: "ms" } };
}

const SUMMARIES: Readonly<Record<string, string>> = {
  "Hello, can you hear me?": JSON.stringify({ title: "Lease renewal", summary: "You and they went over the lease renewal; you will send the signed copy." }),
  "Are we still on for Saturday?": JSON.stringify({ title: "Weekend plans", summary: "You and they settled on Saturday; you will book the table." }),
  "Is the bike still for sale?": JSON.stringify({ title: "Bike and dinner", summary: "A bike drop-off at five, then dinner at eight." }),
};

function model(parts: readonly Recorded[], givenUp: ReadonlySet<string> = new Set()): (ask: Ask) => string | null {
  const bySha = new Map(parts.map((each) => [each.sha256, each]));
  return (ask) => {
    if (givenUp.has(ask.item)) return null;
    if (ask.prompt === CALL_TRANSCRIPT) return JSON.stringify({ segments: bySha.get(ask.item.slice("recording:".length))!.words });
    expect(ask.prompt).toBe(CALL_SUMMARY);
    const text = ask.input.map((piece) => piece.text).join("");
    return Object.entries(SUMMARIES).find(([first]) => text.includes(first))![1];
  };
}

const person = (slug: string, name: string, phone: string): RecordState => ({
  record: {
    slug, name, full_name: null, show: "name", entity: "person", relationship: null, hidden: false, me: false,
    anchor: { kind: "phone", value: phone }, handles: [], excluded: [], dismissed: [], merged_into: null, also_called: [],
  },
  since: new Map(), me_since: null, merged_since: null,
});
const labels = (name = "Person B"): DayLabels => buildLabels({ people: [person("person-b", name, "+15550000002")], places: [] });

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.close();
});

function newHome(): TestHome {
  const home = new TestHome("families-callaudio-", { families: [calls, family], settings: SETTINGS });
  homes.push(home);
  return home;
}

function deliver(home: TestHome, stated_ms: number, parts: readonly Recorded[], source = SOURCE): string[] {
  for (const each of parts) home.blobs.put(each.audio, { mediaType: "audio/mp4" });
  return home.deliver(source, stated_ms, parts.map((each) => each.row)).written;
}

function readThrough(home: TestHome, stated_ms: number): string[] {
  const before_ms = home.read((view) => view.source(SOURCE)!.read_through_ms);
  home.land(SOURCE, stated_ms, []);
  const rows = home.read((view) => family.readThrough!({ source: SOURCE, before_ms, after_ms: stated_ms }, view).map((unit) => {
    const built = family.extract(unit, view, home.blobs)!;
    const row: ExtractRow = { family: family.name, unit, code: family.code, seq: view.through, days: [], ...built };
    return { ...row, days: family.days(row, SETTINGS) };
  }));
  home.db.commit((tx) => {
    for (const row of rows) tx.derived.extracts.put(row);
  });
  return rows.map((row) => row.unit);
}

function dayLines(home: TestHome, names = labels(), reading: Family = family, day = DAY): DayLine[] {
  const enrichments = new Map(home.enrichments(reading.name).map((row) => [row.item, row]));
  const extracts = home.extracts(reading.name).filter((row) => row.days.includes(day));
  return reading.day({ day, settings: SETTINGS, extracts, enrichments, labels: labelsFrom(tableUnits(names), SETTINGS), sources: new Map(), device: (unit) => unit }).lines;
}

const texts = (lines: readonly DayLine[]) => lines.map((line) => line.text);
const LEASE_UNIT = `${SOURCE}/mic-recording/20261005T083000.000Z`;
const WEEKEND_UNIT = `${SOURCE}/mic-recording/20261005T103000.000Z`;
const LEASE_TURNS = [
  "You: Hello, can you hear me?", "Them: Yes, I can hear you.", "You: Good. Shall we go over the lease?", "Them: Sure, the renewal is due next month.",
  "You: I will send the signed copy tonight.", "Them: Great, thanks.",
];

describe("the callaudio family: each way it could fail, written before the code", () => {
  it("prints a call alone and a call joined to a call record as head and turn lines, each with its fact, and leaves a dictation unprinted", () => {
    const home = newHome();
    const parts = [...lease(), ...weekend(), ...dictation()];
    deliver(home, at(240), parts);
    home.deliver(CALLS_SOURCE, at(240), [callRow(WEEKEND_CALL)]);
    const extracts = home.extracts(family.name);
    expect(extracts.map((row) => [row.unit, (row.content as unknown as { short: boolean }).short])).toEqual([
      [LEASE_UNIT, false], [WEEKEND_UNIT, false], [`${SOURCE}/mic-recording/20261005T115000.000Z`, true],
    ]);
    const asked = new FakeLedger(ROUTE).settle(home, family, model(parts)).asked;
    expect(asked.filter((ask) => ask.prompt === CALL_TRANSCRIPT).map((ask) => ask.item).sort()).toEqual([...lease(), ...weekend()].map((each) => partItem(each)).sort());
    expect(asked.filter((ask) => ask.prompt === CALL_SUMMARY).map((ask) => ask.item)).toEqual([stretchItem(LEASE_UNIT), stretchItem(WEEKEND_UNIT)]);
    expect(asked.every((ask) => ask.source === SOURCE && ask.work === (ask.prompt === CALL_TRANSCRIPT ? "transcripts" : "summaries"))).toBe(true);

    const lines = dayLines(home);
    expect(texts(lines)).toEqual([
      "Call on Zoom, 20 min: Lease renewal. You and they went over the lease renewal; you will send the signed copy.",
      ...LEASE_TURNS,
      "Call transcript: Weekend plans. You and they settled on Saturday; you will book the table.",
      "You: Are we still on for Saturday?", "Person B: Yes, Saturday works for me.", "You: I will book the table.",
    ]);
    const weekendRecord = { source: CALLS_SOURCE, kind: "call", key: "CALL-0001" };
    expect(lines.map((line) => line.joins ?? null)).toEqual([...Array(7).fill(null), ...Array(4).fill(weekendRecord)]);
    expect(lines.every((line) => line.block?.key === `callaudio:${line.unit}` && line.chat === line.block.key)).toBe(true);
    expect(lines[1]!.record).toEqual({ source: SOURCE, kind: "mic-recording", key: "20261005T083000.000Z" });
    expect(lines[1]!.item).toBe(partItem(lease()[0]!));

    const day = home.render(DAY, labels());
    const document = JSON.parse(day.json) as DayDocument;
    const facts = document.facts.filter((fact) => fact.of === "callaudio");
    expect(facts.map((fact) => [fact.keys, fact.measures, fact.who])).toEqual([
      [{ app: "Zoom", call: "none" }, { minutes: 20 }, []],
      [{ app: "WhatsApp", call: "phone" }, { minutes: 10 }, [{ handle: "phone:+15550000002", role: "attendee" }]],
    ]);
    const minutes = (fact: DayDocument["facts"][number]) => fact.measures.minutes as number;
    const called = document.facts.filter((fact) => fact.of === "calls").reduce((sum, fact) => sum + minutes(fact), 0);
    expect(called + facts.filter((fact) => fact.keys.call === "none").reduce((sum, fact) => sum + minutes(fact), 0)).toBe(10.5 + 20);
    expect(day.txt).toContain("Phone call with Person B, they called, 11 min");
    fixture(`${DAY}.day.json`, day.json);
    fixture(`${DAY}.day.txt`, day.txt);
    home.artifact("lines.json", lines);
    pin(family, { callaudio: AUDIO, calls: CALLS }, home.extracts(family.name));
  });

  it("made with no audio adapter, reads nothing: no input, no extract, no source in its coverage, though a call source is given", () => {
    const dark = callaudioFamily({ books: FED.labels, zone: SETTINGS.zone, calls: CALLS })([]);
    expect(dark.inputs).toEqual([]);
    const home = new TestHome("families-callaudio-dark-", { families: [calls, dark], settings: SETTINGS });
    homes.push(home);
    expect(home.deliver(CALLS_SOURCE, at(240), [callRow(WEEKEND_CALL)]).written).toEqual(["calls test-calls:CALL-0001"]);
    expect(home.extracts(dark.name)).toEqual([]);
    expect(home.render(DAY, labels()).txt).toContain("\ncallaudio: no sources\n");
  });

  it("back-to-back calls with two people chain into one stretch: a sound turn is named only inside the joined call's span, else Them", () => {
    const home = newHome();
    const parts = backToBack();
    deliver(home, at(240), parts);
    home.deliver(CALLS_SOURCE, at(240), [callRow(BIKE_CALL, "CALL-0002"), callRow(DINNER_CALL, "CALL-0003")]);
    expect(home.extracts(family.name).map((row) => row.unit)).toEqual([`${SOURCE}/mic-recording/20261005T103000.000Z`]);
    const ledger = new FakeLedger(ROUTE);
    ledger.settle(home, family, model(parts));
    const lines = dayLines(home);
    expect(texts(lines)).toEqual([
      "Call transcript: Bike and dinner. A bike drop-off at five, then dinner at eight.",
      "You: Is the bike still for sale?", "Them: Yes, I can drop it off at five.", "You: Dinner at eight?", "Person B: Eight works.",
    ]);
    expect(lines.map((line) => line.joins?.key ?? null)).toEqual(Array(5).fill("CALL-0003"));
    expect(lines.map((line) => line.names?.map((name) => name.who) ?? [])).toEqual([[], [], [], [], [expect.any(String)]]);
    expect(ledger.settle(home, family, model(parts)).asked).toEqual([]);
  });

  it("a call record joins only the recording that overlaps it most: another Mac's shorter recording of the call stands alone, though it landed first", () => {
    const home = newHome();
    const other = "audio:local:macbook-pro-0002";
    const shorter = [
      recorded("mic", at(121), 9, talk.mic, { holder: WHATSAPP, session: "mic-f", part: 1, words: [said(1, 3, "Are we still on for Saturday?")] }),
      recorded("sound", at(121), 9, talk.sound, { holder: WHATSAPP, session: "sound-f", part: 1, words: [said(11, 14, "Yes, Saturday works for me.")] }),
    ];
    const shorterUnit = `${other}/mic-recording/20261005T103100.000Z`;
    const joinedOf = (unit: string) => (home.extracts(family.name).find((row) => row.unit === unit)!.content as unknown as CallContent).joined?.record.key ?? null;
    deliver(home, at(240), shorter, other);
    home.deliver(CALLS_SOURCE, at(240), [callRow(WEEKEND_CALL)]);
    expect(joinedOf(shorterUnit)).toBe("CALL-0001");
    expect(deliver(home, at(241), weekend()).sort()).toEqual([`callaudio ${WEEKEND_UNIT}`, `callaudio ${shorterUnit}`].sort());
    expect([joinedOf(WEEKEND_UNIT), joinedOf(shorterUnit)]).toEqual(["CALL-0001", null]);
  });

  it("a renamed contact reprints the turn lines and asks nothing again", () => {
    const home = newHome();
    const parts = weekend();
    deliver(home, at(240), parts);
    home.deliver(CALLS_SOURCE, at(240), [callRow(WEEKEND_CALL)]);
    const ledger = new FakeLedger(ROUTE);
    ledger.settle(home, family, model(parts));
    const before = home.extracts(family.name);
    expect(texts(dayLines(home, labels("Person Renamed")))).toEqual(texts(dayLines(home)).map((text) => text.replace("Person B", "Person Renamed")));
    expect(ledger.settle(home, family, model(parts)).asked).toEqual([]);
    expect(home.extracts(family.name)).toEqual(before);
  });

  it("a call record that lands after the audio joins the stretch it overlaps, and the summary is not asked again", () => {
    const home = newHome();
    const parts = weekend();
    deliver(home, at(240), parts);
    const ledger = new FakeLedger(ROUTE);
    expect(ledger.settle(home, family, model(parts)).asked.map((ask) => ask.prompt)).toEqual([CALL_TRANSCRIPT, CALL_TRANSCRIPT, CALL_SUMMARY]);
    expect(texts(dayLines(home))[0]).toBe("Call on WhatsApp, 10 min: Weekend plans. You and they settled on Saturday; you will book the table.");
    const joined = home.deliver(CALLS_SOURCE, at(241), [callRow(WEEKEND_CALL)]);
    expect(joined.written).toEqual(["calls test-calls:CALL-0001", `callaudio ${WEEKEND_UNIT}`]);
    expect(ledger.settle(home, family, model(parts)).asked).toEqual([]);
    expect(texts(dayLines(home)).slice(0, 3)).toEqual(["Call transcript: Weekend plans. You and they settled on Saturday; you will book the table.", "You: Are we still on for Saturday?", "Person B: Yes, Saturday works for me."]);
  });

  it("a part that lands late and earlier re-keys the stretch, whose answers the ledger still holds", () => {
    const home = newHome();
    const parts = lease();
    deliver(home, at(21), parts.slice(2));
    const ledger = new FakeLedger(ROUTE);
    expect(ledger.settle(home, family, model(parts)).asked.map((ask) => ask.item)).toEqual(parts.slice(2).map((each) => partItem(each)));
    const late = home.deliver(SOURCE, at(240), parts.slice(0, 2).map((each) => {
      home.blobs.put(each.audio, { mediaType: "audio/mp4" });
      return each.row;
    }));
    expect(late.deleted).toEqual([`callaudio ${SOURCE}/mic-recording/20261005T084000.000Z`]);
    expect(home.extracts(family.name).map((row) => row.unit)).toEqual([LEASE_UNIT]);
    expect(ledger.settle(home, family, model(parts)).asked.map((ask) => ask.item)).toEqual([...parts.slice(0, 2).map((each) => partItem(each)), stretchItem(LEASE_UNIT)]);
  });

  it("an open stretch asks its parts at once and its summary only once read-through closes it, with no record landing", () => {
    const home = newHome();
    const parts = lease();
    deliver(home, at(21), parts);
    const ledger = new FakeLedger(ROUTE);
    expect(ledger.settle(home, family, model(parts)).asked.map((ask) => ask.prompt)).toEqual(Array(4).fill(CALL_TRANSCRIPT));
    expect(texts(dayLines(home))[0]).toBe("Call on Zoom, 20 min");
    expect(readThrough(home, at(22))).toEqual([]);
    expect(readThrough(home, at(30))).toEqual([LEASE_UNIT]);
    expect((home.extracts(family.name)[0]!.content as unknown as CallContent).open).toBe(false);
    expect(ledger.settle(home, family, model(parts)).asked.map((ask) => ask.item)).toEqual([stretchItem(LEASE_UNIT)]);
  });

  it("asks no summary while a part is left, and a given-up part lets it be asked, the head line naming the part that couldn't be read", () => {
    const home = newHome();
    const parts = lease();
    deliver(home, at(240), parts);
    const [extract] = home.extracts(family.name);
    const lost = partItem(parts[3]!);
    expect(family.plan!(extract!, new Map()).asks.map((ask) => ask.prompt)).toEqual(Array(4).fill(CALL_TRANSCRIPT));
    const ledger = new FakeLedger(ROUTE);
    const asked = ledger.settle(home, family, model(parts, new Set([lost]))).asked;
    expect(asked.map((ask) => ask.item)).toEqual([...parts.map((each) => partItem(each)), stretchItem(LEASE_UNIT)]);
    const summary = asked.at(-1)!.input.map((piece) => piece.text).join("");
    expect(summary).not.toContain("Great, thanks.");
    expect(summary).toContain("You: Hello, can you hear me?");
    expect(texts(dayLines(home)).slice(0, 1)).toEqual(["Call on Zoom, 20 min (1 part couldn't be read): Lease renewal. You and they went over the lease renewal; you will send the signed copy."]);
    const view = callAudioView(home.extracts(family.name)[0]!, (item) => home.enrichments(family.name).find((row) => row.item === item), labelsFrom(tableUnits(labels()), SETTINGS))!;
    expect(view.parts).toEqual({ asked: 4, done: 3, given_up: 1, waiting: 0 });
    expect(view.turns.map((turn) => `${turn.who}: ${turn.words}`)).toEqual(LEASE_TURNS.slice(0, 5));
    expect(view.turns[1]!.heard).toEqual({ record: { source: SOURCE, kind: "sound-recording", key: "20261005T083000.000Z" }, item: partItem(parts[1]!), from_ms: 11_000 });
  });

  it("puts no name in a summary's input: the turns are You and Them, the app named", () => {
    const home = newHome();
    const parts = weekend();
    deliver(home, at(240), parts);
    home.deliver(CALLS_SOURCE, at(240), [callRow(WEEKEND_CALL)]);
    const summary = new FakeLedger(ROUTE).settle(home, family, model(parts)).asked.find((ask) => ask.prompt === CALL_SUMMARY)!;
    expect(summary.input.map((piece) => piece.text).join("")).toBe([
      "App: WhatsApp", "Start: 2026-10-05 16:00 Asia/Kolkata", "Length: 10 min", "",
      "16:00:01 You: Are we still on for Saturday?", "16:00:11 Them: Yes, Saturday works for me.", "16:00:41 You: I will book the table.", "",
    ].join("\n"));
    expect(summary.input.filter((piece) => "free" in piece).map((piece) => piece.text)).toEqual(["Are we still on for Saturday?", "Yes, Saturday works for me.", "I will book the table."]);
  });

  it("reads real sidecar shapes through the audio reader and adapter: the calls on headphones and on the speakers print, the speakers' echo is gone from You, a dictation and a tab held for hours print nothing", async () => {
    const home = new TestHome("families-callaudio-recorded-", { families: [calls, recorder], settings: SETTINGS });
    homes.push(home);
    const files = readdirSync(RECORDED).sort().map((path) => {
      const bytes = readFileSync(new URL(path, RECORDED));
      return { path, blob: home.blobs.put(bytes, { mediaType: path.endsWith(".m4a") ? "audio/mp4" : "application/json" }), size: bytes.length };
    });
    const stated_ms = Math.max(...SHAPES.map((shape) => shape.to_ms)) + 10 * MIN;
    const rows: ReaderOutput[] = [];
    for await (const row of READER.read({ id: `${SOURCE}/recorded`, source: SOURCE, sealed_ms: stated_ms, stated_ms, facts: {}, files }, home.blobs)) rows.push(row);
    expect(rows.flatMap((row) => row.refused ?? [])).toEqual([]);
    expect(rows.flatMap((row) => READER.kinds[row.kind]!(row.content))).toEqual([]);
    expect(rows).toHaveLength(files.filter((file) => file.path.endsWith(".json")).length);
    home.deliver(SOURCE, stated_ms, rows);

    const answer = (ask: Ask): string => (ask.prompt === CALL_TRANSCRIPT
      ? JSON.stringify({ segments: SPOKEN[ask.item.slice("recording:".length)]!.segments })
      : JSON.stringify({ title: "Synthetic call", summary: "Two synthetic voices go over a schedule." }));
    new FakeLedger(ROUTE).settle(home, recorder, answer);
    const extracts = home.extracts(recorder.name);
    const content = (row: ExtractRow) => row.content as unknown as CallAudioContent;
    const of = (name: ShapeName) => {
      const shape = SHAPES.find((each) => each.name === name)!;
      return extracts.filter((row) => {
        const at = keyMs(row.unit.slice(row.unit.lastIndexOf("/") + 1));
        return at >= shape.from_ms && at < shape.to_ms;
      });
    };
    const called = (name: ShapeName) => of(name).map((row) => content(row)).filter((each): each is CallContent => !each.short);
    expect(called("headphones").map((call) => call.speakers)).toEqual([[]]);
    expect(called("speakers").map((call) => call.speakers.length > 0)).toEqual([true]);
    expect(of("dictation").length).toBeGreaterThan(0);
    expect(called("dictation")).toEqual([]);
    expect(of("held").length).toBeGreaterThan(0);
    expect(called("held")).toEqual([]);

    const lines = dayLines(home, labels(), recorder, RECORDED_DAY);
    const you = texts(lines).filter((text) => text.startsWith("You: "));
    const heard = Object.values(SPOKEN).filter((spoken) => spoken.track === "sound").flatMap((spoken) => spoken.segments.map((segment) => segment.text));
    const echoes = Object.values(SPOKEN).flatMap((spoken) => spoken.echo);
    expect(echoes.length).toBeGreaterThan(0);
    expect(you.filter((text) => heard.some((said) => text.includes(said)))).toEqual([]);
    for (const echo of echoes) {
      const nod = echo.slice(heard.find((said) => echo.startsWith(said))!.length + 1);
      expect(you.some((text) => text.includes(nod)), nod).toBe(true);
    }

    const day = home.render(RECORDED_DAY, labels());
    fixture(`${RECORDED_DAY}.recorded.day.json`, day.json);
    fixture(`${RECORDED_DAY}.recorded.day.txt`, day.txt);
    fixture("recorded.calls.json", `${JSON.stringify(extracts.map((row) => {
      const each = content(row);
      const unit = row.unit.slice(SOURCE.length + 1);
      if (each.short) return { unit, short: true };
      return {
        unit, short: false, holder: each.holder, span: [new Date(each.span.start_ms).toISOString(), new Date(each.span.end_ms).toISOString()],
        mic: each.mic.length, sound: each.sound.length, quiet: [...each.mic, ...each.sound].filter((part) => part.quiet).length, asked: askedParts(each).length,
        speakers: each.speakers.length, camera: each.camera, open: each.open,
      };
    }), null, 2)}\n`);
    home.artifact("recorded-lines.json", lines);
  });
});

function keyMs(key: string): number {
  const [, y, mo, d, h, mi, s, fraction] = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\.\d+)?Z/u.exec(key)!;
  return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${fraction ?? ""}Z`);
}

function fixture(name: string, text: string): void {
  const url = new URL(name, FIXTURES);
  if (WRITE) writeFileSync(url, text);
  expect(existsSync(url), `test/${name} is this journey's day: LIFESTREAM_FIXTURES=write writes it`).toBe(true);
  expect(text, `test/${name} is this journey's day: LIFESTREAM_FIXTURES=write writes it`).toBe(readFileSync(url, "utf8"));
}
