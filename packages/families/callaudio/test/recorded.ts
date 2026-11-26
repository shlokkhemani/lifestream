import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { CallTrack, Json, JsonObject } from "@lifestreamprotocol/core";
import { holderName } from "../lines.js";
import { callRule, holderOf, joins, loudSeconds, stretchesOf, THRESHOLDS, type Span, type Stretch } from "../rule.js";
import { speakerSpans } from "../turns.js";
import { readLive, type LivePart } from "./live.js";

const RECORDED = fileURLToPath(new URL("./recorded/", import.meta.url));
const WORDS = fileURLToPath(new URL("./recorded.words.json", import.meta.url));
const SHAPES = fileURLToPath(new URL("./recorded.shapes.json", import.meta.url));

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FIRST_SLOT = Date.UTC(2026, 9, 6, 3, 30);
const CALL_CAP = 20 * MINUTE;
const HELD_CAP = 2 * HOUR;
const HELD_LEAST = 2 * HOUR;
const RATE = 16_000;
const BIT_RATE = 16_000;
const MIC_VOICE = "Samantha";
const SOUND_VOICE = "Daniel";
const ECHO_GAIN = 0.35;
const ECHO_DELAY_S = 0.3;
const SEGMENTS_A_PART = 1;
const ECHOED_A_PART = 2;
const SPEAKERS_LEAST = 0.5;
const SEGMENT_S = 3.5;
const SILENCE_STEP_S = 0.07;
const ZOOM = "us.zoom.xos";
const BROWSERS = new Set(["com.google.Chrome", "com.apple.Safari", "company.thebrowser.Browser", "com.brave.Browser", "org.mozilla.firefox", "com.microsoft.edgemac"]);
const STEM = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z\.(mic|sound)(-[1-9]\d*)?$/u;

const NOUNS = ["budget", "garden", "report", "kitchen", "schedule", "invoice", "roof", "draft", "ticket", "parcel", "fence", "lesson"];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const WHENS = ["morning", "evening"];
const STATES = ["ready", "late", "fine", "done", "open", "short"];
const NODS = ["Right, go on.", "Yes, I see.", "Okay, sure.", "Hmm, true."];

export type ShapeName = "headphones" | "speakers" | "dictation" | "held";

export interface Shape {
  readonly name: ShapeName;
  readonly about: string;
  readonly from_ms: number;
  readonly to_ms: number;
  readonly parts: number;
}

export interface Segment {
  readonly start_s: number;
  readonly end_s: number;
  readonly text: string;
}

export interface Spoken {
  readonly track: CallTrack;
  readonly echo: readonly string[];
  readonly segments: readonly Segment[];
}

interface Picked {
  readonly name: ShapeName;
  readonly about: string;
  readonly parts: readonly LivePart[];
}

interface Candidate {
  readonly stretch: Stretch;
  readonly call: boolean;
  readonly holder: string | null;
  readonly speakers: number;
  readonly length_ms: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const stemTime = (ms: number): string => iso(ms).replace(/[-:]/gu, "");
const near = (target_ms: number) => (a: Candidate, b: Candidate): number => Math.abs(a.length_ms - target_ms) - Math.abs(b.length_ms - target_ms);
const loud = (parts: readonly LivePart[], track: CallTrack): number => parts.filter((part) => part.track === track).reduce((sum, part) => sum + (loudSeconds(part) ?? 0), 0);

function within(parts: readonly LivePart[], from_ms: number, to_ms: number): LivePart[] {
  return parts.filter((part) => part.start_ms >= from_ms && part.start_ms < to_ms);
}

function pick(parts: readonly LivePart[], calls: readonly Span[]): Picked[] {
  const candidates = stretchesOf(parts).map((stretch): Candidate => ({
    stretch,
    call: callRule(stretch, calls.some((call) => joins(stretch, call))).call,
    holder: holderOf(stretch),
    speakers: speakerSpans(stretch.parts).reduce((sum, span) => sum + span.end_ms - span.start_ms, 0) / (stretch.end_ms - stretch.start_ms),
    length_ms: stretch.end_ms - stretch.start_ms,
  }));
  const rank = (holder: string | null): number => (holder === null ? 3 : holder === ZOOM ? 0 : BROWSERS.has(holder) ? 2 : holderName(holder) !== holder ? 1 : 3);
  const calls5 = candidates.filter((each) => each.call && each.length_ms >= 5 * MINUTE);
  const headphones = calls5.filter((each) => each.speakers === 0).sort((a, b) => rank(a.holder) - rank(b.holder) || near(20 * MINUTE)(a, b))[0];
  const speakers = calls5.filter((each) => each.speakers >= SPEAKERS_LEAST)
    .sort((a, b) => Number(BROWSERS.has(b.holder ?? "")) - Number(BROWSERS.has(a.holder ?? "")) || b.speakers - a.speakers)[0];
  const dictation = candidates.filter((each) => {
    const own = each.stretch.parts as readonly LivePart[];
    return !each.call && each.length_ms >= 2 * MINUTE && each.length_ms <= 10 * MINUTE && loud(own, "mic") >= 60 && loud(own, "sound") <= loud(own, "mic") * 0.05;
  }).sort(near(6 * MINUTE))[0];
  const held = heldSession(parts);
  const missing = [["a call on headphones", headphones], [`a call on speakers ${SPEAKERS_LEAST * 100}% of it`, speakers], ["a dictation", dictation], ["a session held two hours", held]].filter(([, found]) => found === undefined);
  if (missing.length > 0) throw new Error(`the window holds no ${missing.map(([what]) => what).join(", no ")}: widen --days`);
  const callParts = (found: Candidate) => within(parts, found.stretch.start_ms, Math.min(found.stretch.end_ms, found.stretch.start_ms + CALL_CAP));
  const shown = (found: Candidate) => (found.holder === null ? "no holder" : holderName(found.holder) === found.holder ? "an app outside the list" : holderName(found.holder));
  return [
    { name: "headphones", about: `a call on headphones, on ${shown(headphones!)}`, parts: callParts(headphones!) },
    { name: "speakers", about: `a call on the built-in speakers, on ${shown(speakers!)}`, parts: callParts(speakers!) },
    { name: "dictation", about: `a dictation of ${Math.round(dictation!.length_ms / MINUTE)} min, on ${shown(dictation!)}`, parts: callParts(dictation!) },
    { name: "held", about: `the first two hours of a session held ${Math.round((held!.to_ms - held!.from_ms) / HOUR)} h, by ${held!.holder}`, parts: within(parts, held!.from_ms, held!.from_ms + HELD_CAP) },
  ];
}

function heldSession(parts: readonly LivePart[]): { from_ms: number; to_ms: number; holder: string } | undefined {
  const sessions = new Map<string, LivePart[]>();
  for (const part of parts) {
    const session = `${part.track} ${part.session ?? part.key}`;
    sessions.set(session, [...(sessions.get(session) ?? []), part]);
  }
  return [...sessions.values()].map((held) => {
    const holders = held.flatMap((part) => part.holders);
    const browser = holders.find((holder) => BROWSERS.has(holder));
    return { from_ms: Math.min(...held.map((part) => part.start_ms)), to_ms: Math.max(...held.map((part) => part.end_ms)), browser, holder: browser === undefined ? "an app outside the list" : holderName(browser) };
  }).filter((each) => each.to_ms - each.from_ms >= HELD_LEAST)
    .sort((a, b) => Number(b.browser !== undefined) - Number(a.browser !== undefined) || (b.to_ms - b.from_ms) - (a.to_ms - a.from_ms))[0];
}

class Names {
  readonly #apps = new Map<string, string>();
  readonly #devices = new Map<string, string>();

  app(bundle: string): string {
    if (holderName(bundle) !== bundle) return bundle;
    const named = this.#apps.get(bundle) ?? `com.example.app-${this.#apps.size + 1}`;
    this.#apps.set(bundle, named);
    return named;
  }

  device(uid: string): string {
    const named = this.#devices.get(uid) ?? `device-${String(this.#devices.size + 1).padStart(4, "0")}`;
    this.#devices.set(uid, named);
    return uid.endsWith(":input") ? `${named}:input` : named;
  }
}

const DEVICE_NAMES: Readonly<Record<string, string>> = { built_in: "Built-in", bluetooth: "Bluetooth headphones", usb: "USB audio" };

function deviceOf(value: Json | undefined, names: Names): JsonObject | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const device: JsonObject = { ...value, uid: names.device(String(value.uid)) };
  return value.name === undefined ? device : { ...device, name: DEVICE_NAMES[String(value.transport)] ?? "Audio device" };
}

function levelOf(value: Json | undefined, names: Names): JsonObject | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const device = deviceOf(value.device, names);
  return device === undefined ? { ...value } : { ...value, device };
}

function shifted(at: Json | undefined, delta_ms: number): string {
  return iso(Date.parse(String(at)) + delta_ms);
}

function shiftStem(session: string, delta_ms: number): string {
  const stem = STEM.exec(session);
  if (stem === null) throw new Error(`a session that names no recording: ${session}`);
  const [, y, mo, d, h, mi, s, ms, track, rank] = stem;
  return `${stemTime(Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`) + delta_ms)}.${track}${rank ?? ""}`;
}

function sidecarOf(part: LivePart, delta_ms: number, names: Names): JsonObject {
  const content = part.record.content as JsonObject;
  const sidecar: JsonObject = { at: iso(part.start_ms + delta_ms) };
  for (const [member, value] of Object.entries(content)) {
    if (member === "until" || member === "detected_at") sidecar[member] = shifted(value, delta_ms);
    else if (member === "session") sidecar[member] = shiftStem(String(value), delta_ms);
    else if (member === "device") sidecar[member] = deviceOf(value, names) ?? null;
    else if (member === "room") {
      sidecar[member] = (value as JsonObject[]).map((entry) => {
        const room: JsonObject = { at: shifted(entry.at, delta_ms), holders: (entry.holders as string[]).map((app) => names.app(app)), players: (entry.players as string[]).map((app) => names.app(app)) };
        const output = levelOf(entry.output, names);
        const input = levelOf(entry.input, names);
        return { ...room, ...(output === undefined ? {} : { output }), ...(input === undefined ? {} : { input }) };
      });
    } else if (member === "camera") {
      sidecar[member] = (value as JsonObject[]).map((entry) => ({ at: shifted(entry.at, delta_ms), until: shifted(entry.until, delta_ms), device: "Camera" }));
    } else sidecar[member] = value;
  }
  return sidecar;
}

function stemOf(part: LivePart, delta_ms: number): string {
  const rank = part.key.includes(":") ? Number(part.key.split(":")[1]) : 0;
  return `${stemTime(part.start_ms + delta_ms)}.${part.track}${rank === 0 ? "" : `-${rank + 1}`}`;
}

class Lines {
  #mic = 0;
  #sound = 0;
  #nod = 0;

  next(track: CallTrack): string {
    if (track === "mic") {
      const n = this.#mic++;
      return `Can we move the ${NOUNS[n % NOUNS.length]} to ${DAYS[Math.floor(n / NOUNS.length) % DAYS.length]} ${WHENS[Math.floor(n / (NOUNS.length * DAYS.length)) % WHENS.length]}?`;
    }
    const n = this.#sound++;
    return `The ${NOUNS[n % NOUNS.length]} for ${DAYS[Math.floor(n / NOUNS.length) % DAYS.length]} ${WHENS[Math.floor(n / (NOUNS.length * DAYS.length)) % WHENS.length]} looks ${STATES[Math.floor(n / (NOUNS.length * DAYS.length * WHENS.length)) % STATES.length]}.`;
  }

  nod(): string {
    return NODS[this.#nod++ % NODS.length]!;
  }
}

function loudRuns(part: LivePart): Segment[] {
  if (part.loudness === null) return [];
  const { every_ms, rms_dbfs } = part.loudness;
  const runs: { start_s: number; end_s: number }[] = [];
  rms_dbfs.forEach((level, index) => {
    if (level < THRESHOLDS.LOUD_DBFS) return;
    const start_s = (index * every_ms) / SECOND;
    const last = runs.at(-1);
    if (last !== undefined && last.end_s === start_s) last.end_s = start_s + every_ms / SECOND;
    else runs.push({ start_s, end_s: start_s + every_ms / SECOND });
  });
  return runs.filter((run) => run.end_s - run.start_s >= 2).map((run) => ({ ...run, text: "" }));
}

interface Echo extends Segment {
  readonly heard: string;
  readonly nod: string;
}

interface Words {
  readonly own: Segment[];
  readonly echo: Echo[];
}

function wordsOf(parts: readonly LivePart[], echoes: boolean, lines: Lines): Map<LivePart, Words> {
  const words = new Map<LivePart, Words>();
  for (const part of [...parts].sort((a, b) => a.start_ms - b.start_ms)) {
    const own = loudRuns(part).slice(0, echoes ? ECHOED_A_PART : SEGMENTS_A_PART).map((run) => ({ start_s: run.start_s, end_s: Math.min(run.end_s, run.start_s + SEGMENT_S), text: lines.next(part.track) }));
    words.set(part, { own, echo: [] });
  }
  if (!echoes) return words;
  const speakers = speakerSpans(parts);
  for (const mic of parts.filter((part) => part.track === "mic")) {
    for (const sound of parts.filter((part) => part.track === "sound")) {
      for (const said of words.get(sound)!.own) {
        const at_ms = sound.start_ms + said.start_s * SECOND + ECHO_DELAY_S * SECOND;
        if (at_ms < mic.start_ms || at_ms >= mic.end_ms - SEGMENT_S * SECOND || !speakers.some((span) => at_ms >= span.start_ms && at_ms < span.end_ms)) continue;
        const start_s = Math.round((at_ms - mic.start_ms) / 100) / 10;
        const nod = lines.nod();
        words.get(mic)!.echo.push({ start_s, end_s: start_s + (said.end_s - said.start_s) + 1, text: `${said.text} ${nod}`, heard: said.text, nod });
      }
    }
  }
  return words;
}

function pcm(file: string): Int16Array {
  const bytes = readFileSync(file);
  let offset = 12;
  while (offset < bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "data") return new Int16Array(bytes.buffer.slice(bytes.byteOffset + offset + 8, bytes.byteOffset + offset + 8 + size));
    offset += 8 + size + (size % 2);
  }
  throw new Error(`${file} holds no data chunk`);
}

function wav(samples: Int16Array): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(samples.byteLength, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]);
}

class Voice {
  #made = 0;

  constructor(readonly dir: string) {}

  say(voice: string, text: string): Int16Array {
    const file = join(this.dir, `say-${this.#made++}.wav`);
    execFileSync("say", ["-v", voice, "-o", file, "--file-format=WAVE", `--data-format=LEI16@${RATE}`, text]);
    return pcm(file);
  }

  m4a(samples: Int16Array): Buffer {
    const name = `clip-${this.#made++}`;
    writeFileSync(join(this.dir, `${name}.wav`), wav(samples));
    execFileSync("afconvert", ["-f", "m4af", "-d", "aac", "-b", String(BIT_RATE), join(this.dir, `${name}.wav`), join(this.dir, `${name}.m4a`)]);
    return readFileSync(join(this.dir, `${name}.m4a`));
  }
}

function mix(under: Int16Array, over: Int16Array, gain: number, at: number): Int16Array {
  const out = new Int16Array(Math.max(under.length, at + over.length));
  out.set(under);
  over.forEach((sample, index) => {
    out[at + index] = Math.max(-32768, Math.min(32767, out[at + index]! + Math.round(sample * gain)));
  });
  return out;
}

function concat(pieces: readonly Int16Array[], gap: number): Int16Array {
  const out = new Int16Array(pieces.reduce((sum, piece) => sum + piece.length + gap, 0));
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length + gap;
  }
  return out;
}

function clipOf(voice: Voice, track: CallTrack, words: Words, silence: number): Int16Array {
  const own = words.own.map((said) => voice.say(track === "mic" ? MIC_VOICE : SOUND_VOICE, said.text));
  const echoed = words.echo.map((said) => mix(mix(new Int16Array(0), voice.say(SOUND_VOICE, said.heard), ECHO_GAIN, 0), voice.say(MIC_VOICE, said.nod), 1, Math.round(RATE * 0.6)));
  const pieces = [...own, ...echoed];
  return pieces.length === 0 ? new Int16Array(silence) : concat(pieces, Math.round(RATE * 0.25));
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { days: { type: "string", default: "30" } } });
  const to_ms = Date.now();
  const live = await readLive(to_ms - Number(values.days) * DAY, to_ms);
  const recorder = live.recorders.find((each) => each.source.product === "audio");
  if (recorder === undefined) throw new Error("the home holds no audio recorder's source");
  const picked = pick(recorder.parts, live.calls);
  const names = new Names();
  const lines = new Lines();
  const dir = mkdtempSync(join(tmpdir(), "callaudio-recorded-"));
  const voice = new Voice(dir);
  rmSync(RECORDED, { recursive: true, force: true });
  mkdirSync(RECORDED, { recursive: true });
  const spoken: Record<string, Spoken> = {};
  const shapes: Shape[] = [];
  let silent = 0;
  for (const [index, shape] of picked.entries()) {
    const from_ms = Math.min(...shape.parts.map((part) => part.start_ms));
    const delta_ms = FIRST_SLOT + index * 90 * MINUTE - from_ms;
    const words = wordsOf(shape.parts, shape.name === "speakers", lines);
    for (const part of shape.parts) {
      const said = words.get(part)!;
      const audio = voice.m4a(clipOf(voice, part.track, said, Math.round(RATE * (0.25 + silent++ * SILENCE_STEP_S))));
      const sha256 = createHash("sha256").update(audio).digest("hex");
      if (spoken[sha256] !== undefined) throw new Error(`two parts made the same audio: ${part.track} ${part.key}`);
      const stem = stemOf(part, delta_ms);
      const sidecar = sidecarOf(part, delta_ms, names);
      const stated = sidecar.audio as JsonObject;
      sidecar.audio = { ...stated, bit_rate: BIT_RATE, bytes: audio.length, channels: 1, codec: "aac", file: `${stem}.m4a`, media_type: "audio/mp4", sample_rate: RATE, sha256 };
      writeFileSync(join(RECORDED, `${stem}.json`), `${JSON.stringify(sidecar)}\n`);
      writeFileSync(join(RECORDED, `${stem}.m4a`), audio);
      spoken[sha256] = {
        track: part.track,
        echo: said.echo.map((each) => each.text),
        segments: [...said.own, ...said.echo.map(({ start_s, end_s, text }) => ({ start_s, end_s, text }))].sort((a, b) => a.start_s - b.start_s),
      };
    }
    const to = Math.max(...shape.parts.map((part) => part.end_ms));
    shapes.push({ name: shape.name, about: shape.about, from_ms: from_ms + delta_ms, to_ms: to + delta_ms, parts: shape.parts.length });
  }
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(WORDS, `${JSON.stringify(spoken, null, 1)}\n`);
  writeFileSync(SHAPES, `${JSON.stringify(shapes, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(shapes, null, 2)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
