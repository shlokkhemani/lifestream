import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMainThread, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { BlobError, daysOf, digest, SecretError, TimeError, type DaySettings, type ExtractRow, type Guard, type Json, type Prompt, type ReaderOutput, type ScreenAdapter, type View } from "@lifestreamprotocol/core";
import { chromeSites, NeedsYou, NotYet, recipeSecret, roadsOf, Refused, runErrand, StationFailed, type Acquirer, type Connector, type Reader, type Labeler } from "@lifestreamprotocol/connect";
import {
  aiFamily, healthFamily, labelsFamily, linesOnly, mailFamily, messagesFamily, nameId, photosFamily, physicalFamily, placeWords, SCREEN_ACCOUNT, voiceFamily, type DayLine, type Family, type Given,
} from "@lifestreamprotocol/families";
import type { Registry, RegistryHome } from "../registry.js";
import { connectors, connectorsWith, feedersOf, readers as releaseReaders } from "../registry-home.js";
import type { Settings } from "../settings.js";
import { RELEASE_FED, releaseFolder } from "./fed.js";

const fault = { "storage-helper-open": "SELECT sqlite_version() AS v", "storage-helper-import": "FROM sources WHERE id =" }[process.env.LIFESTREAM_FAILPOINT ?? ""];
if (!isMainThread && fault !== undefined) {
  const prepare = Database.prototype.prepare;
  Database.prototype.prepare = function (this: Database.Database, sql: string) {
    if (this.name.endsWith("home.db") && sql.includes(fault)) throw new Database.SqliteError("disk I/O error", "SQLITE_IOERR");
    return prepare.call(this, sql);
  } as typeof prepare;
}

const GAP_MS = 300_000;
const DAY_MS = 86_400_000;

const note: Guard = (content) => {
  if (typeof content === "object" && content !== null && !Array.isArray(content) && content.guard_throws === true) throw new TypeError("a synthetic guard's bug");
  return typeof content === "object" && content !== null && !Array.isArray(content) && typeof content.text === "string" && typeof content.at === "number"
    ? [] : ["a note states text and at"];
};
const frame: Guard = (content) =>
  typeof content === "object" && content !== null && !Array.isArray(content) && typeof content.at === "number" ? [] : ["a frame states at"];
const contact: Guard = (content) =>
  typeof content === "object" && content !== null && !Array.isArray(content) && typeof content.card === "string" ? [] : ["a contact states its card"];
const object: Guard = (content) => typeof content === "object" && content !== null && !Array.isArray(content) ? [] : ["content is an object"];

const reads = new Map<string, number>();

export const fakeRows: Reader = {
  name: "fake-rows",
  kinds: { note, frame, contact, pushname: object, place: object, msg: object, img: object, fix: object, call: object },
  async *read(delivery, files): AsyncIterable<ReaderOutput> {
    try {
      yield* fakeRowsOf(delivery, files);
    } finally {
      if (typeof delivery.facts.closed === "string") writeFileSync(delivery.facts.closed, "");
    }
  },
};

export const facesRows: Reader = { ...fakeRows, name: "faces-rows", kinds: { image: object, scan: object, named: object } };
export const camerasRows: Reader = { ...fakeRows, name: "cameras-rows", kinds: { camera: object, photo: object } };
export const voiceRows: Reader = { ...fakeRows, name: "voice-rows", kinds: { voice: object, note } };

async function* fakeRowsOf(delivery: Parameters<Reader["read"]>[0], files: Parameters<Reader["read"]>[1]): AsyncIterable<ReaderOutput> {
  if (typeof delivery.facts.hold === "string") holdWhile(delivery.facts.hold);
  const generate = delivery.facts.generate as { count: number; start_ms: number; step_ms: number; prefix: string; values?: number; hold?: string; again?: string; throw_at?: number } | undefined;
  if (generate !== undefined) {
    const readKey = `${delivery.id}:${generate.again ?? ""}`;
    const read = (reads.get(readKey) ?? 0) + 1;
    reads.set(readKey, read);
    const values = generate.values === undefined ? {} : { values: Array.from({ length: generate.values }, (_, value) => value) };
    for (let index = 0; index < generate.count; index++) {
      if (index === generate.throw_at) throw new TypeError(`a synthetic bug at note ${index}`);
      const at = generate.start_ms + index * generate.step_ms;
      yield { kind: "note", key: `${generate.prefix}-${index}`, content: { text: `history ${index}`, at, ...values }, time: { start_ms: at, precision: "ms" } };
    }
    if (generate.hold !== undefined) holdWhile(generate.hold);
    if (generate.again !== undefined && read > 1) holdWhile(generate.again);
    return;
  }
  const file = delivery.files.find((each) => each.path === "rows.ndjson");
  if (file === undefined) return;
  for (const line of files.text(file.blob).split("\n")) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line) as {
      kind: string; key: string; content: Json; at?: number; blobs?: Json; bytes?: Json; stores?: string; gone?: true; hold?: string; read_if?: string; read_blobs?: true;
      throw_if?: string; error?: "Refused" | "TypeError" | "TimeError" | "EIO" | "EACCES"; fault_if?: string; quiet_while?: string;
    };
    if (row.throw_if !== undefined) {
      if (existsSync(row.throw_if)) throw thrown(row.error);
      continue;
    }
    if (row.fault_if !== undefined) {
      if (existsSync(row.fault_if)) files.bytes(`sha256:${"0".repeat(64)}`);
      continue;
    }
    if (row.quiet_while !== undefined) {
      while (existsSync(row.quiet_while)) await new Promise((resolve) => setTimeout(resolve, 20));
      continue;
    }
    if (row.hold !== undefined) {
      holdWhile(row.hold);
      continue;
    }
    if (row.read_if !== undefined && !existsSync(row.read_if)) continue;
    if (row.read_blobs === true) for (const blob of row.blobs as string[]) files.bytes(blob);
    const at = typeof row.at === "number" ? row.at : undefined;
    yield {
      kind: row.kind, key: row.key, content: row.content,
      ...(at === undefined ? {} : { time: { start_ms: at, precision: "ms" as const } }),
      ...(row.blobs === undefined ? {} : { blobs: row.blobs as string[] }),
      ...(row.bytes === undefined ? {} : { bytes: row.bytes as never }),
      ...(row.stores === undefined ? {} : { bytes: [Buffer.from(row.stores)], blobs: [`sha256:${createHash("sha256").update(row.stores).digest("hex")}`] }),
      ...(row.gone === true ? { gone: true as const } : {}),
    };
  }
}

function unitDays(extract: ExtractRow, settings: DaySettings): string[] {
  return extract.start_ms === null ? [] : daysOf({ start_ms: extract.start_ms, end_ms: extract.end_ms ?? extract.start_ms, precision: "ms" }, settings);
}

interface Note {
  key: string;
  text: string;
  at: number;
  photo: boolean | string;
  hidden?: true | string;
  who?: string;
  where?: { latitude: number; longitude: number };
  on?: string;
  plan_hold?: string;
  render_hold?: string;
  plan_throw?: true;
  render_throw?: true | "ENOSPC";
  images?: string[];
  title?: string;
  text_throw?: true;
}

const photoItem = (note: Note): string => `photo:${typeof note.photo === "string" ? note.photo : note.key}`;

function extractNotes(unit: string, view: View, withFrames: boolean, tolerant: boolean) {
  const slash = unit.lastIndexOf("/");
  const source = unit.slice(0, slash), at = unit.slice(slash + 1);
  const hour = at.length === 13;
  const start = Date.parse(hour ? `${at}:00:00Z` : `${at}T00:00:00Z`);
  const list: Note[] = [];
  for (const { head, version } of view.records(source, "note", { start_ms: start, end_ms: start + (hour ? 3_600_000 : DAY_MS) })) {
    const content = version.content as {
      text: string; at: number; photo?: boolean | string; hold?: string; plan_hold?: string; render_hold?: string; plan_throw?: boolean; render_throw?: boolean | "ENOSPC";
      hidden?: boolean | string; images?: string[]; who?: string; where?: { latitude: number; longitude: number }; on?: string;
      extract_throw?: boolean;
    };
    if (content.hold !== undefined) holdWhile(content.hold);
    if (!tolerant && content.extract_throw === true) throw new Error(`note ${head.key} is malformed`);
    list.push({
      key: head.key, text: content.text, at: content.at, photo: typeof content.photo === "string" ? content.photo : content.photo === true,
      ...(content.hidden === true || typeof content.hidden === "string" ? { hidden: content.hidden } : {}),
      ...(content.who === undefined ? {} : { who: content.who }),
      ...(content.where === undefined ? {} : { where: content.where }),
      ...(content.on === undefined ? {} : { on: content.on }),
      ...(content.plan_hold === undefined ? {} : { plan_hold: content.plan_hold }),
      ...(content.render_hold === undefined ? {} : { render_hold: content.render_hold }),
      ...(content.plan_throw === true ? { plan_throw: true as const } : {}),
      ...(content.render_throw === true || content.render_throw === "ENOSPC" ? { render_throw: content.render_throw } : {}),
      ...(content.images === undefined ? {} : { images: content.images }),
    });
  }
  if (list.length === 0) return null;
  list.sort((left, right) => left.at - right.at || (left.key < right.key ? -1 : 1));
  const frames = !withFrames ? {} : {
    frames: view.sources({ product: ["screen"] }).reduce((sum, screen) => sum + [...view.heads(screen.id, "frame", { start_ms: start, end_ms: start + (hour ? 3_600_000 : DAY_MS) })].length, 0),
  };
  const content = { source, notes: list, ...frames } as unknown as Json;
  return { content, start_ms: list[0]!.at, end_ms: list.at(-1)!.at, reading: digest(content) };
}

function thrown(name: "Refused" | "TypeError" | "TimeError" | "EIO" | "EACCES" | undefined): Error {
  if (name === "Refused") return new Refused("a synthetic refusal past the rows read");
  if (name === "EIO") return Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
  if (name === "EACCES") {
    const cause = Object.assign(new Error("EACCES: permission denied, access"), { code: "EACCES" });
    return new BlobError("BLOB_NOT_STORED", `whether blob sha256:${"0".repeat(64)} is stored cannot be read: ${cause.message}`, { cause });
  }
  if (name === "TypeError") return new TypeError("a synthetic bug past the rows read");
  if (name === "TimeError") return new TimeError("calendar", "a synthetic time past the rows read");
  return new Error("a synthetic failure past the rows read");
}

function holdWhile(path: string): void {
  if (existsSync(path)) writeFileSync(`${path}.held`, "");
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  while (existsSync(path)) Atomics.wait(sleep, 0, 0, 20);
}

type PromptOptions = Partial<Pick<Prompt, "version" | "keeps" | "type" | "text">>;

function fakePrompt(text: string, options: PromptOptions = {}): Prompt {
  return { version: 1, keeps: [], type: "text", text, ...options };
}

type NotesOptions = { code?: string; per?: "day" | "hour"; frames?: boolean; text?: string; tolerant?: boolean; absent?: boolean; caption?: PromptOptions; replicas_throw?: string };

export function notesFamily(options: NotesOptions = {}): Family {
  const unitOf = (at: number): string => new Date(at).toISOString().slice(0, options.per === "hour" ? 13 : 10);
  const frames = options.frames === true;
  return {
    name: "notes",
    type: "notes",
    code: options.code ?? "1",
    inputs: [
      { sources: { product: ["apple-notes"] }, kinds: ["note"], role: "evidence" },
      ...(frames ? [{ sources: { product: ["screen"] }, kinds: ["frame"], role: "evidence" as const }] : []),
      { sources: { product: ["apple-contacts"] }, kinds: ["contact"], role: "labels" },
    ],
    prompts: { "fake-caption": fakePrompt("Describe the photo in one line.", options.caption) },
    works: { photos: { product: ["apple-notes"] } },
    touched: (changes, view) => changes.flatMap((change) => {
      const spans = new Set([change.after, change.before].map((version) => version?.time?.start_ms).filter((ms) => ms !== undefined).map(unitOf));
      const sources = change.record.kind === "frame" ? view.sources({ product: ["apple-notes"] }).map((source) => source.id) : [change.record.source];
      return sources.flatMap((source) => [...spans].map((span) => ({ unit: `${source}/${span}` })));
    }),
    extract: (unit, view) => extractNotes(unit, view, frames, options.tolerant === true),
    days: unitDays,
    plan(extract, answered) {
      const { notes: list } = extract.content as unknown as { notes: Note[] };
      const asks = [];
      const answers = [];
      for (const each of list) {
        if (each.plan_hold !== undefined) holdWhile(each.plan_hold);
        if (each.plan_throw === true) throw new TypeError(`note ${each.key} is malformed`);
        if (each.photo === false) continue;
        const item = photoItem(each);
        const reply = answered.get(item);
        if (reply !== undefined) answers.push({ item, content: reply.text });
        else {
          const input = typeof each.photo === "string" ? `Caption the photo ${each.photo}.` : `Caption the photo of note ${each.text}.`;
          const attachments = (each.images ?? []).map((blob) => ({ blob, media_type: "image/jpeg" }));
          asks.push({ family: "notes", item, prompt: "fake-caption", input: [{ text: input, free: true }], work: "photos", source: (extract.content as unknown as { source: string }).source, ...(attachments.length === 0 ? {} : { attachments }) });
        }
      }
      return { asks, answers };
    },
    items(extract) {
      return (extract.content as unknown as { notes: Note[] }).notes.filter((each) => each.photo !== false).map((each) => ({ item: photoItem(each), prompt: "fake-caption" }));
    },
    ...(options.text === undefined ? {} : { text: {
      version: options.text,
      kinds: ["note"],
      of(record, version) {
        const note = version.content as unknown as Note;
        if (note.text_throw === true) throw new TypeError(`note ${record.key} has no words to read`);
        if (note.text === "" && note.title === undefined) return null;
        return { text: note.text, ...(note.title === undefined ? {} : { title: note.title }), ...(note.who === undefined ? {} : { who: [note.who] }) };
      },
    }, read: {
      of(_record, version) {
        const note = version.content as unknown as Note;
        if (note.text === "" && note.title === undefined) return null;
        return { text: note.text, ...(note.title === undefined ? {} : { title: note.title }), ...(note.who === undefined ? {} : { who: [note.who] }) };
      },
    } }),
    replicas(thing, view) {
      if (options.replicas_throw !== undefined && existsSync(options.replicas_throw)) throw new TypeError(`the notes family cannot name the replicas of ${thing}`);
      const records = view.sources({ product: ["apple-notes"] }).map((source) => ({ source: source.id, kind: "note", key: thing })).filter((record) => view.head(record) !== undefined);
      const items = new Set<string>();
      for (const record of records) {
        const head = view.head(record)!;
        const photo = head.version === "gone" ? undefined : (view.version(head.version).content as { photo?: boolean | string } | undefined)?.photo;
        if (photo === true || typeof photo === "string") items.add(photoItem({ key: thing, photo } as Note));
      }
      return { records, items: [...items].sort() };
    },
    day: linesOnly((input): DayLine[] => {
      const lines: DayLine[] = [];
      for (const extract of input.extracts) {
        const { source, notes: list } = extract.content as unknown as { source: string; notes: Note[] };
        for (const each of list) {
          if (each.render_hold !== undefined) holdWhile(each.render_hold);
          if (each.render_throw === true) throw new TypeError(`note ${each.key} cannot be printed`);
          if (each.render_throw === "ENOSPC") throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
          if (each.hidden === true || (typeof each.hidden === "string" && input.labels.person(each.hidden) === undefined)) continue;
          const caption = each.photo === false ? undefined : input.enrichments.get(photoItem(each));
          const said = caption?.state === "done" ? ` [${String(caption.content)}]` : each.photo === false ? "" : " [photo]";
          const who = each.who === undefined ? "" : ` with ${nameId(each.who, input.labels).name}`;
          const where = each.where === undefined ? "" : ` at ${placeWords(each.where, input.labels)}`;
          const on = each.on === undefined ? "" : ` on ${input.device(each.on)}`;
          lines.push({
            family: "notes", unit: extract.unit, units: [extract.unit], start_ms: each.at, end_ms: null, text: `${each.text}${who}${where}${on}${said}`,
            record: { source, kind: "note", key: each.key },
          });
        }
      }
      return lines;
    }),
  };
}

export const notes: Family = notesFamily();

interface Sitting {
  source: string;
  frames: string[];
  first: number;
  last: number;
  closed: boolean;
  missing: number;
  text?: string;
}

function frames(view: View, source: string, from: number, to: number): { key: string; at: number }[] {
  return [...view.heads(source, "frame", { start_ms: from, end_ms: to })]
    .map((head) => ({ key: head.key, at: head.start_ms! }))
    .sort((left, right) => left.at - right.at || (left.key < right.key ? -1 : 1));
}

const machineOf = (view: View, source: string): string | undefined => view.sources({ product: ["screen"] }).find((row) => row.id === source)?.copy;

const screenSourceOf = (view: View, machine: string): string | undefined => view.sources({ product: ["screen"] }).find((row) => row.copy === machine)?.id;

function sittingStart(view: View, source: string, at: number): number {
  let first = at;
  for (;;) {
    const earlier = frames(view, source, first - GAP_MS, first).filter((each) => each.at < first);
    if (earlier.length === 0) return first;
    first = earlier[0]!.at;
  }
}

type ScreenOptions = { chain?: boolean; part?: PromptOptions; refuse?: boolean; index?: boolean };

const SCREEN_FRAMES: Given<ScreenAdapter> = { product: "screen", name: "Fake screen", vendor: "example", type: null, adapter: { version: "1", kinds: ["frame"], role: "frames" } };

export function screenFamily(options: ScreenOptions = {}): Family {
  const chain = options.chain === true;
  return {
    name: "screen",
    type: "device-activity",
    code: "1",
    ...(options.index === true ? {
      adapters: [SCREEN_FRAMES],
      replicas: (thing: string, view: View) => ({
        records: view.sources({ product: ["screen"] }).map((source) => ({ source: source.id, kind: "frame", key: thing })).filter((record) => view.head(record) !== undefined),
        items: [],
      }),
    } : {}),
    inputs: [{ sources: { product: ["screen"] }, kinds: ["frame"], role: "evidence" }],
    prompts: {
      "fake-sitting": fakePrompt("Give an account of the sitting."),
      ...(chain ? { "fake-part": fakePrompt("Say what the part of the sitting shows.", options.part) } : {}),
    },
    works: { screen: { product: ["screen"] } },
    touched: (changes, view) => changes.flatMap((change) => {
      const at = [change.after, change.before].map((version) => version?.time?.start_ms).find((ms) => ms !== undefined);
      const machine = machineOf(view, change.record.source);
      return at === undefined || machine === undefined ? [] : [{ unit: `${machine}/${sittingStart(view, change.record.source, at)}` }];
    }),
    readThrough(move, view) {
      return [...view.extracts("screen")].filter((row) => {
        const sitting = row.content as unknown as Sitting;
        return sitting.source === move.source && !sitting.closed;
      }).map((row) => row.unit);
    },
    extract(unit, view, files) {
      const at = unit.lastIndexOf("/");
      const source = screenSourceOf(view, unit.slice(0, at));
      if (source === undefined) return null;
      const first = Number(unit.slice(at + 1));
      const all = frames(view, source, first, first + 24 * 3_600_000);
      if (all[0]?.at !== first) return null;
      const kept = [all[0]!];
      for (const each of all.slice(1)) {
        if (each.at - kept.at(-1)!.at > GAP_MS) break;
        kept.push(each);
      }
      const last = kept.at(-1)!.at;
      const read = view.sources().find((row) => row.id === source)?.read_through_ms ?? null;
      let missing = 0;
      const texts: string[] = [];
      for (const each of kept) {
        const head = view.head({ source, kind: "frame", key: each.key })!;
        const { blob, hold, closed_throw, text } = view.version(head.version).content as { blob?: string; hold?: string; closed_throw?: boolean; text?: string };
        if (hold !== undefined) holdWhile(hold);
        if (closed_throw === true && read !== null && read > last + GAP_MS) throw new Error(`frame ${each.key} is malformed`);
        if (blob !== undefined && !files.has(blob)) missing++;
        if (text !== undefined) texts.push(text);
      }
      const sitting: Sitting = {
        source, frames: kept.map((each) => each.key), first, last, closed: read !== null && read > last + GAP_MS, missing, ...(texts.length === 0 ? {} : { text: texts.join("\n") }),
      };
      const content = sitting as unknown as Json;
      return { content, start_ms: first, end_ms: last, reading: digest(content) };
    },
    days: unitDays,
    plan(extract, answered) {
      const sitting = extract.content as unknown as Sitting;
      if (!sitting.closed) return { asks: [] };
      const frames = `The sitting of frames ${sitting.frames.join(", ")}.${sitting.text === undefined ? "" : ` On screen: ${sitting.text}`}`;
      if (!chain) {
        const reply = answered.get(extract.unit);
        if (reply !== undefined) return { asks: [], answers: [{ item: extract.unit, content: reply.text }] };
        return { asks: [{ family: "screen", item: extract.unit, prompt: "fake-sitting", input: [{ text: frames, free: true }], work: "screen", source: sitting.source }] };
      }
      const part = answered.get(`${extract.unit}/part`);
      if (part !== undefined && options.refuse === true) return { asks: [], refusals: [{ item: `${extract.unit}/part`, reason: "the part's answer breaks a rule of the reader" }] };
      if (part === undefined) return { asks: [{ family: "screen", item: `${extract.unit}/part`, prompt: "fake-part", input: [{ text: frames, free: true }], work: "screen", source: sitting.source }] };
      const account = answered.get(`${extract.unit}/sitting`);
      if (account !== undefined) return { asks: [], answers: [{ item: extract.unit, content: account.text }] };
      return { asks: [{ family: "screen", item: `${extract.unit}/sitting`, prompt: "fake-sitting", input: [{ text: `${frames} Its part: ${part.text}.`, free: true }], work: "screen", source: sitting.source }] };
    },
    items: (extract) => [{ item: extract.unit, prompt: SCREEN_ACCOUNT }],
    day: linesOnly((input): DayLine[] => {
      return input.extracts.map((extract) => {
        const sitting = extract.content as unknown as Sitting;
        const account = input.enrichments.get(extract.unit);
        return {
          family: "screen", unit: extract.unit, units: [extract.unit], start_ms: sitting.first, end_ms: sitting.last,
          text: `${sitting.frames.length} frames${sitting.closed ? "" : " (open)"}${account?.state === "done" ? `: ${String(account.content)}` : ""}`,
          item: extract.unit,
        };
      });
    }),
  };
}

export const screen: Family = screenFamily();

function seeded(seed: string, length: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0);
  const chars = new Array<string>(length);
  for (let index = 0; index < length; index++) {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    chars[index] = alphabet[((mixed ^ (mixed >>> 14)) >>> 0) & 63]!;
  }
  return chars.join("");
}

export function bulkFamily(): Family {
  const bytes = Number(process.env.LIFESTREAM_TEST_BULK_BYTES ?? 1024);
  return {
    name: "bulk",
    type: "notes",
    code: "1",
    inputs: [{ sources: { product: ["apple-notes"] }, kinds: ["note"], role: "evidence" }],
    touched: (changes) => changes.map((change) => ({ unit: `${change.record.source}/${change.record.key}` })),
    extract(unit, view) {
      const slash = unit.lastIndexOf("/");
      const head = view.head({ source: unit.slice(0, slash), kind: "note", key: unit.slice(slash + 1) });
      if (head === undefined || head.version === "gone") return null;
      const { at } = view.version(head.version).content as { at: number };
      const content = { key: unit.slice(slash + 1), text: seeded(unit, bytes) };
      return { content, start_ms: at, end_ms: at, reading: digest(content) };
    },
    days: unitDays,
    day: linesOnly(() => []),
  };
}

type PollLane = { chrome_as?: string; fail_while?: string; offline_while?: string; busy_while?: string; refuse_while?: string; attempts?: string; ask_first?: boolean; needs_first?: boolean; states?: string[]; transit?: boolean; password?: string; hold?: string; rotates?: boolean; steal?: string; exposes?: string; events?: number };

export function fakePoll(lane: PollLane = {}, name = "fake-poll", source = "apple-notes:local:poll"): Acquirer {
  return {
    name,
    source,
    secrets: [name, ...(lane.password === undefined ? [] : [lane.password])],
    async fetch(state, secrets, lent) {
      if (lane.attempts !== undefined) appendFileSync(lane.attempts, "x");
      if (lane.hold !== undefined && existsSync(lane.hold)) {
        writeFileSync(`${lane.hold}.held`, "");
        while (existsSync(lane.hold)) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (lane.fail_while !== undefined && existsSync(lane.fail_while)) throw new Error("synthetic outage: the provider did not answer");
      if (lane.offline_while !== undefined && existsSync(lane.offline_while)) throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND provider.example.com"), { code: "ENOTFOUND" }) });
      if (lane.busy_while !== undefined && existsSync(lane.busy_while)) throw new StationFailed("BUSY", "the Lifestream extension in every Chrome profile is busy with the site");
      const otherKey = { get: () => { throw new SecretError("sealed by another key", "other-key"); } };
      const refusing = lane.refuse_while !== undefined && existsSync(lane.refuse_while);
      const password = lane.password === undefined ? {} : { password_sha256: createHash("sha256").update(recipeSecret(refusing ? otherKey : secrets, lane.password, "Example", "export")).digest("hex") };
      const cursor = typeof state?.cursor === "number" ? state.cursor : 0;
      if (lane.ask_first === true && state?.asked !== true) throw new NotYet("provider-making", "asked the synthetic provider", { state: { cursor, asked: true } });
      if (lane.needs_first === true && state?.needed !== true) throw new NeedsYou("confirm", "confirm it's you to the synthetic provider", { state: { cursor, needed: true } });
      if (lane.rotates === true) {
        secrets.get(name);
        secrets.rotate(name, `synthetic-token-${cursor + 1}`);
      }
      const at = Date.now() - 1_000;
      const stolen = lane.steal === undefined ? {} : { stolen: answerTo(() => secrets.get(lane.steal!)) };
      if (lane.exposes !== undefined) appendFileSync(lane.exposes, `${JSON.stringify({ data: workerData, env: process.env })}\n`);
      if ((lane.events ?? 0) > 0 && cursor === 0) {
        const events = Array.from({ length: lane.events! }, (_, index) => ({ kind: "note", key: `event-${index}`, content: { text: `synthetic event ${index}`, at: at - index * 60_000 }, at: at - index * 60_000 }));
        return {
          files: [
            { path: "rows.ndjson", bytes: Buffer.from(events.map((event) => `${JSON.stringify(event)}\n`).join("")) },
            ...events.map((event) => ({ path: `events/${event.key}.ics`, bytes: Buffer.from(`BEGIN:VEVENT\r\nUID:${event.key}@example.com\r\nSUMMARY:${event.content.text}\r\nEND:VEVENT\r\n`) })),
          ],
          facts: {}, state: { ...state, cursor: 1 },
        };
      }
      const row = { kind: "note", key: `poll-${cursor}`, content: { text: `polled ${cursor}`, at, ...password, ...stolen }, at };
      const as = lane.chrome_as === undefined ? null : JSON.parse(readFileSync(lane.chrome_as, "utf8")) as { id: string; email: string } | null;
      if (lane.chrome_as !== undefined && as === null) throw new NeedsYou("signed-out", "Sign in to the synthetic provider in Chrome", { state: { cursor } });
      if (as !== null) {
        const accounts = lent?.accounts ?? {};
        if (accounts[as.id] === false) throw new NotYet("chrome", `waits for Chrome: signed in to the synthetic provider as ${as.email}`, { state: { cursor } });
        if (accounts[as.id] === undefined && Object.keys(accounts).length > 0) throw new NeedsYou("other-account", `Chrome is signed in as ${as.email}`, { account: as, state: { cursor } });
      }
      const stating = as !== null ? [{ id: `${name.slice(0, name.indexOf("-"))}:${as.id}:browser`, connector: "fake-rows", email: as.email }]
        : lane.states?.map((id) => ({ id, connector: "fake-rows" }));
      const facts = { ...(stating === undefined ? {} : { sources: stating }), ...(lane.transit === true ? { transit: true } : {}) };
      const media = lane.transit === true ? [{ path: `media/clip-${cursor}.bin`, bytes: Buffer.alloc(4096, cursor + 1) }] : [];
      return { files: [{ path: "rows.ndjson", bytes: Buffer.from(`${JSON.stringify(row)}\n`) }, ...media], facts, state: { ...state, cursor: cursor + 1 } };
    },
  };
}

function answerTo(read: () => string | undefined): string {
  try {
    return read() === undefined ? "absent" : "answered";
  } catch (error) {
    return (error as Error).message;
  }
}

const path = (label: string) => ({ kind: "path", label }) as const;
const flag = (label: string) => ({ kind: "toggle", label, default: false }) as const;

const FAKE_WORKS: Connector["processing"] = {
  photos: { label: "Photo descriptions", kind: "pictures", noun: ["photo", "photos"], about: "A model writes a short description of each photo." },
  screen: { label: "Screen summaries", kind: "text", noun: ["sitting", "sittings"], about: "A model writes what each sitting was." },
};

export const FAKE_CONNECTORS: readonly Connector[] = [
  ...(["fake-poll", "fake-poll-two"] as const).map((id) => ({
    id, product: "apple-notes", name: "Notes", vendor: "apple", type: "notes", records: "A note a poll fetches, one a poll.",
    sources: [{ id: id === "fake-poll" ? "apple-notes:local:poll" : "apple-notes:local:poll-two", read: "fake-rows", arrives: "poll" }],
    acquirers: [id], refresh: { default: "1h" }, processing: FAKE_WORKS,
    fields: {
      fail_while: path("Fails while"), offline_while: path("Offline while"), busy_while: path("Busy while"),
      refuse_while: path("Refuses the password while"), attempts: path("Attempts"), ask_first: flag("Asks first"), needs_first: flag("Needs the person first"),
      states: { kind: "list", label: "States" }, transit: flag("In transit"), password: { kind: "secret", label: "Password", secret: "fake.password" },
      hold: path("Holds while"), rotates: flag("Rotates its token"), steal: { kind: "text", label: "Steals the secret named" }, exposes: path("Exposes"),
      events: { kind: "number", label: "Events its first fetch answers", default: 0, min: 0 },
    },
  }) satisfies Connector),
  {
    id: "fake-errand", product: "apple-notes", name: "Notes", vendor: "apple", type: "notes", records: "An export a station keeps from a page.",
    sources: [{ id: "fake-errand:local:station", read: "fake-rows", arrives: "chrome" }], acquirers: ["fake-errand"], refresh: { default: "1h" },
  } satisfies Connector,
  {
    id: "fake-label", product: "audio", name: "Audio", vendor: "lifestream", type: "voice", records: "Nothing: its engine sleeps.",
    sources: [{ id: "audio:local:labels", read: "fake-rows", arrives: "label" }], fields: { pid: path("Its engine's pid") },
  } satisfies Connector,
];

function onSite(acquirer: Acquirer, origin: string): Acquirer {
  return {
    ...acquirer,
    async fetch(state, secrets, lent) {
      await runErrand(lent.stations, { name: acquirer.name, origins: [origin], deadline_ms: 60_000 }, async (errand) => void (await errand.open(`${origin}/`)));
      return acquirer.fetch(state, secrets, lent);
    },
  };
}

export function fakeErrand(work: string): Acquirer {
  return {
    name: "fake-errand",
    source: "fake-errand:local:station",
    secrets: ["fake.password"],
    async fetch(state, _secrets, lent) {
      const spec = { name: "fake-errand", origins: ["https://site.example"], secrets: ["fake.password"], deadline_ms: 60_000 };
      return runErrand(lent.stations, spec, async (errand) => {
        const tab = await errand.open("https://site.example/");
        const { signals } = await tab.snapshot();
        if (signals.verify) throw new NeedsYou("confirm", "Confirm it's you to site.example in Chrome", { at: { site: "site.example", errand: errand.id } });
        if (signals.password) throw new NeedsYou("signed-out", "Sign in to site.example in Chrome");
        await tab.fill({ label: "Password" }, { secret: "fake.password" });
        const [answer] = await tab.fetch([{ url: "https://site.example/export", as: "file", name: "export.bin" }]);
        const file = answer?.file;
        if (file === undefined) throw new Error(`the export was not kept: ${answer?.error?.message ?? `status ${String(answer?.status)}`}`);
        rmSync(work, { recursive: true, force: true });
        mkdirSync(work, { recursive: true });
        const kept = join(work, "export.bin");
        const door_ino = statSync(file.path!).ino;
        errand.move("export.bin", kept);
        return { files: [{ path: "export.bin", file: kept }], facts: { door_ino, door_path: file.path!, sha256: file.sha256 }, state: { polls: Number(state?.polls ?? 0) + 1 } };
      });
    },
  };
}

export function fakeLabel(lane: { pid?: string; fails?: string }): Labeler {
  const broken = () => {
    if (lane.fails !== undefined && existsSync(lane.fails)) throw new Error("a synthetic broken labeler");
  };
  const labeler: Labeler = {
    name: "fake-label",
    source: "audio:local:labels",
    inputs: [{ sources: { product: ["apple-notes"] }, get kinds() { broken(); return ["note"]; } }],
    async label(_view, _blobs, _since, signal) {
      if (lane.pid === undefined) return null;
      const child = spawn("sleep", ["300"], { stdio: "ignore", killSignal: "SIGKILL", ...(signal === undefined ? {} : { signal }) });
      writeFileSync(lane.pid, String(child.pid));
      await new Promise((resolve) => { child.once("error", resolve); child.once("exit", resolve); });
      return null;
    },
  };
  if (lane.fails !== undefined) {
    Object.defineProperty(labeler, "reading", {
      enumerable: true,
      get: () => {
        broken();
        return { code: "fake", borrows: [] };
      },
    });
  }
  return labeler;
}

export const phoneReaders = (): Reader[] => {
  const named = new Set(connectors().flatMap((connector) => connector.sources.filter((source) => roadsOf(source).includes("phone")).map((source) => source.read)));
  return releaseReaders().filter((reader) => named.has(reader.name));
};

export const fakeDeclarations = (): readonly Connector[] => connectorsWith(FAKE_CONNECTORS);

export const CONNECT_CODE = "connect-code";

function mailOf(options: { code?: string }): Family {
  const family = mailFamily({ books: RELEASE_FED.labels })(RELEASE_FED.mail);
  return { ...family, code: options.code ?? family.code };
}

export default function registry(settings: Settings, home: RegistryHome): Registry {
  const folder = home.root;
  const declared = fakeDeclarations();
  const block = (id: string) => settings.connectors[id];
  const polled = (id: string) => {
    const held = block(id);
    return held === undefined || (Object.keys(held).length > 0 && Object.keys(held).every((member) => member.startsWith("llm.") || member.startsWith("privacy."))) ? undefined : held;
  };
  const notesOptions = settings.families.notes as NotesOptions | undefined;
  return {
    code: existsSync(join(folder, CONNECT_CODE)) ? readFileSync(join(folder, CONNECT_CODE), "utf8").trim() : "fake-connect",
    connectors: declared, readers: [fakeRows, ...new Set([...releaseFolder("macos-app/machine").readers, ...phoneReaders()]), ...releaseFolder("voice/wispr-flow").readers, ...releaseFolder("mail/gmail").readers],
    feeders: feedersOf(declared),
    families: [
      ...(notesOptions?.absent === true ? [] : [notesFamily(notesOptions)]), screenFamily(settings.families.screen as ScreenOptions | undefined),
      ...(settings.families.messages === undefined ? [] : [messagesFamily({ books: RELEASE_FED.labels })(RELEASE_FED.messages)]), labelsFamily({ home: settings.unit, messages: RELEASE_FED.messages, mail: RELEASE_FED.mail })(RELEASE_FED.labels),
      ...(settings.families.mail === undefined ? [] : [mailOf(settings.families.mail as { code?: string })]),
      ...(settings.families.health === undefined ? [] : [healthFamily(RELEASE_FED.health)]),
      ...(settings.families.ai === undefined ? [] : [aiFamily(RELEASE_FED.ai)]),
      ...(settings.families.photos === undefined ? [] : [photosFamily({ faces: false })(RELEASE_FED.photos)]),
      ...(settings.families.voice === undefined ? [] : [voiceFamily(RELEASE_FED.voice)]),
      ...(settings.families.physical === undefined ? [] : [physicalFamily({ photos: RELEASE_FED.photos })(RELEASE_FED.physical)]),
      ...(settings.families.bulk === undefined ? [] : [bulkFamily()]),
    ],
    acquirers: [
      ...(polled("fake-poll") === undefined ? [] : [fakePoll(polled("fake-poll") as PollLane)]),
      ...(polled("fake-poll-two") === undefined ? [] : [fakePoll(polled("fake-poll-two") as PollLane, "fake-poll-two", "apple-notes:local:poll-two")]),
      ...chromeSites(declared).flatMap((site) => block(site.id) === undefined ? []
        : site.lanes.map((name) => onSite(fakePoll(block(site.id) as PollLane, name, name), site.origin))),
      ...(block("fake-errand") === undefined ? [] : [fakeErrand(join(folder, "tools", "fake-errand-work"))]),
    ],
    ...(block("fake-label") === undefined ? {} : { labelers: [fakeLabel(block("fake-label") as { pid?: string; fails?: string })] }),
  };
}

