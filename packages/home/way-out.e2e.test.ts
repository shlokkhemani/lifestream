import { constants, cpSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { DAYS_MARK, importSubject, openHome, openHomeFolder, type DaySettings, type DetailType, type JsonObject, type Level, type ReaderOutput } from "@lifestreamprotocol/core";
import { CALLS_COLLECTIONS, MESSAGES_COLLECTIONS, MONEY_COLLECTIONS, type DayFileFact, type Family, type PersonDetail, type Searched } from "@lifestreamprotocol/families";
import { openHider, openMarks, type Detector, type DetectorModel, type NamedPerson, type NameTable, type PrivacySettings, type Sealed } from "@lifestreamprotocol/privacy";
import { QUIET } from "./door.js";
import { ErasableStreams } from "./erasable-streams.js";
import { openHiding, type Hiding, type HidingInputs, type Routed, type ToolRoute } from "./hiding.js";
import { HomeFile } from "./home-file.js";
import { nameTableOf } from "./people.js";
import { openMarking, searchQueue } from "./marking.js";
import type { HiddenReader } from "./principals.js";
import { PEOPLE, preparedDirOf, preparedFileOf, writePrepared } from "./prepared.js";
import { openReads, type Reply, type Step } from "./reads.js";
import { Refusal } from "./refusal.js";
import type { Registry } from "./registry.js";
import { answerOf, type ContractPath } from "./search-contract.js";
import { ROUND_WIDTH, SCREEN_WRITTEN } from "./search-route.js";
import { ScreenIndex, screenFileOf, type ScreenSegment } from "./screen-index.js";
import { SearchIndex, searchFileOf, type AtomEntry, type RecordEntry } from "./search-index.js";
import type { Settings } from "./settings.js";
import { openWriter, type Writer } from "./writers.js";
import { agentAt, levelled } from "./test/agent-levels.js";
import { cleanup, makeHome, NOW_MS } from "./test/support.js";

const roots: string[] = [];
afterAll(() => cleanup(roots));

const CLOCK: DaySettings = { zone: "UTC", day_start_hour: 0 };
const DAY = "2026-09-02";
const at = (time: string) => Date.parse(`${DAY}T${time}:00Z`);
const ADA = "phone:+15550000001";
const BRAM = "phone:+15550000002";
const VEY = "phone:+15550000003";
const SAM1 = "phone:+15550000004";
const SAM2 = "phone:+15550000005";
const ROSE = "phone:+15550000006";
const MODEL: DetectorModel = { id: "fake-filter", file: "sha256:00", decode: "1" };
const PRIVACY: PrivacySettings = { level: "all", chat: "all", links: "tokens", always: [], never: [] };
const NAMES: NameTable = {
  version: "people-1", owner: { who: "person:owner", shown: "Owner Example" },
  people: [
    { who: "person:owner", is: "human", shown: "Owner Example", names: ["Owner Example"], accounts: [] },
    { who: "person:ada", is: "human", shown: "Ada Quill", names: ["Ada Quill", "Ada"], accounts: ["+15550000001"] },
    { who: "person:bram", is: "human", shown: "Bram Tolt", names: ["Bram Tolt", "Bram"], accounts: ["+15550000002"] },
    { who: "person:vey", is: "human", shown: "Ada Vey", names: ["Ada Vey"], accounts: ["+15550000003"] },
    { who: "person:sam1", is: "human", shown: "Sam Example", names: ["Sam Example"], accounts: ["+15550000004"] },
    { who: "person:sam2", is: "human", shown: "Sam Example", names: ["Sam Example"], accounts: ["+15550000005"] },
    { who: "person:rose", is: "human", shown: "Rose Example", names: ["Rose Example"], accounts: ["+15550000006"] },
  ],
};
const NUMBERS = ["15550000001", "15550000002"];
const LEAKS: Readonly<Record<string, readonly string[]>> = { names: NUMBERS, all: ["Ada", "Quill", "Bram", "Tolt", ...NUMBERS] };
interface Called {
  key: string;
  time: string;
  handle: string;
  text: string;
  line?: string;
  names?: [string, string][];
}
interface Shown {
  at_ms: number;
  title: string;
  lines: string[];
}
const CALLS: Called[] = [
  { key: "c1", time: "09:00", handle: ADA, text: "Call with Ada Quill about the garden" },
  { key: "c2", time: "10:00", handle: ADA, text: "Ada Quill again, the garden gate" },
  { key: "c3", time: "11:00", handle: BRAM, text: "Planning the trip with Bram Tolt" },
];
const record = (key: string) => ({ source: "wa:local:a", kind: "call", key });

function person(id: string, name: string, handles: readonly string[], seen: readonly string[] = []): PersonDetail {
  return {
    id, name, call_name: name.split(" ")[0]!, full_name: name, show: "full_name", by: "card", person: null, entity: "person", entity_by: "home", relationship: null, me: false,
    hidden: false, organised: false, card: true, photo: null, score: 1, networks: [], chats: [], received: 0, sent: 0, mails_from: 0, mails_to: 0, first_ms: null,
    last_ms: null, last_30: 0, days_count: 0, last_day: 0, days: {}, suggestions: [], names_seen: seen, also_called: [], record: null,
    handles: handles.map((handle) => ({ id: handle, kind: handle.slice(0, handle.indexOf(":")), network: null, words: handle, from: null })),
  } as unknown as PersonDetail;
}

const DETECTED: Readonly<Record<string, DetailType>> = { Rosalind: "person", Quxley: "person", "Bea Shared": "person", "Mira Kestrel": "person", Mira: "person" };

function detectorOf(model: { id: string }): Detector {
  const now = (): DetectorModel => ({ ...MODEL, id: model.id });
  return {
    state: () => ({ state: "ready", model: now() }),
    async find(passages) {
      return {
        model: now(),
        marks: passages.map((passage) => (passage.includes("smudged") ? null : Object.entries(DETECTED).flatMap(([word, type]) =>
          [...passage.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, "giu"))].map((match) => ({ start: match.index, end: match.index + word.length, type }))))),
      };
    },
  };
}

interface Home {
  hiding: Hiding;
  writer: Writer;
  plain(path: ContractPath, params: Record<string, string | string[]>): Promise<{ status: number; body: any }>;
  routed: string[];
  names: { table: NameTable | undefined };
  gate: { wait?: () => Promise<void> };
  screenBusy: { from?: number };
  narrow: { reads: boolean };
  erase: { next: boolean };
  steps: Step[];
  model: { id: string };
  hold(): () => void;
  mark(): Promise<void>;
}

interface More {
  calls?: readonly Called[];
  without?: readonly string[];
  screen?: readonly Shown[];
  facts?: readonly DayFileFact[];
  records?: readonly RecordEntry[];
  lines?: Readonly<Record<string, string>>;
  named?: Readonly<Record<string, readonly [string, string][]>>;
  held?: { family: Family; source: string; rows: readonly ReaderOutput[] };
  people?: readonly NamedPerson[];
}

const spansIn = (line: string, names: readonly (readonly [string, string])[]) => names.map(([words, who]) => ({ start: line.indexOf(words), end: line.indexOf(words) + words.length, who }));

let emptyHomeTemplate: string | undefined;
let defaultHomeTemplate: string | undefined;

function cloneTemplate(template: string): string {
  const root = mkdtempSync(join(tmpdir(), "way-out-e2e-"));
  roots.push(root);
  cpSync(template, root, { recursive: true, mode: constants.COPYFILE_FICLONE });
  return root;
}

function emptyTemplate(): string {
  if (emptyHomeTemplate !== undefined && existsSync(emptyHomeTemplate)) return emptyHomeTemplate;
  const home = makeHome({}, roots);
  mkdirSync(join(home.root, "days"), { recursive: true });
  const db = openHome(openHomeFolder(home.root), "migrate");
  db.commit((tx) => tx.tables.meta.set(DAYS_MARK, "test"));
  db.close();
  openMarks(openHomeFolder(dirname(join(home.root, "machine", "marks.db"))), join(home.root, "machine", "marks.db")).close();
  return (emptyHomeTemplate = home.root);
}

function buildFiles(root: string, more: More): void {
  const calls = [...CALLS, ...more.calls ?? []].filter((call) => !more.without?.includes(call.key));
  const machine = join(root, "machine-test");
  const stated = more.held;
  if (stated !== undefined) {
    const db = openHome(openHomeFolder(root), "write");
    db.commit((tx) => {
      tx.tables.sources.add({ id: stated.source, vendor: "google", connector: "fake-rows", added_ms: NOW_MS });
      const run = tx.tables.runs.start({ kind: "import", subject: importSubject(stated.source, `${stated.source}/1`), started_ms: NOW_MS });
      tx.records.land(run, { id: `${stated.source}/1`, source: stated.source, stated_ms: NOW_MS }, stated.rows, Object.fromEntries(stated.rows.map((row) => [row.kind, () => []])), openHomeFolder(root).blobs(join(root, "blobs")));
    });
    db.close();
  }
  const index = SearchIndex.write(openHomeFolder(root), searchFileOf(root, machine), () => true, 0, CLOCK);
  const entries: RecordEntry[] = calls.map((call) => ({
    record: record(call.key), family: "calls", version: `v-${call.key}`, start_ms: at(call.time), end_ms: at(call.time) + 600_000, title: "", text: call.text,
    who: [call.handle.slice(call.handle.indexOf(":") + 1)], link: null,
  }));
  index.records([...entries, ...more.records ?? []], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
  const atoms: AtomEntry[] = calls.map((call, n) => {
    const line = call.line ?? call.text;
    return {
      n: n + 1, family: "calls", unit: `calls/${call.key}`, record: record(call.key), start_ms: at(call.time), end_ms: at(call.time) + 600_000, text: line,
      ...(call.names === undefined ? {} : { names: spansIn(line, call.names) }),
    };
  });
  const extra = (more.facts ?? []).map((fact) => {
    const line = more.lines?.[fact.id];
    if (line === undefined) return fact;
    const named = more.named?.[fact.id];
    const n = atoms.push({
      n: atoms.length + 1, family: fact.family, unit: fact.from.units[0]!, record: fact.from.record!, start_ms: fact.start_ms, end_ms: null, text: line,
      ...(named === undefined ? {} : { names: spansIn(line, named) }),
    });
    return { ...fact, lines: [n] };
  });
  const facts: DayFileFact[] = calls.map((call) => ({
    id: `calls:${call.key.padStart(24, "0")}`, family: "calls", of: "calls", time_ms: at(call.time), start_ms: at(call.time), end_ms: at(call.time) + 600_000,
    keys: { service: "whatsapp", direction: "outgoing", outcome: "connected" }, measures: { minutes: 10 }, who: [{ handle: call.handle, role: "receiver" }],
    from: { units: [`calls/${call.key}`], record: record(call.key), alone: true }, lines: [],
  }));
  index.day(DAY, { inputs: "in-1", mtime_us: 1, atoms, facts: { window: { start_ms: at("00:00"), end_ms: at("00:00") + 86_400_000 }, facts: [...facts, ...extra] } });
  index.finish();
  index.close();
  if (more.screen !== undefined) {
    const file = screenFileOf(searchFileOf(root, machine));
    const held: ScreenSegment[] = more.screen.map((each) => ({
      machine: "mac-0001", version: "v1", start_ms: each.at_ms,
      frames: [0, 1, 2, 3, 4].map((f) => ({ t: each.at_ms + f * 4_000, app: "Notes", site: null, title: each.title, display: "1", lines: each.lines })),
    }));
    const built = ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: CLOCK, meaning: false }, () => true);
    built.apply(held, { segments: (_machine: string, day: string) => held.filter((each) => new Date(each.start_ms).toISOString().slice(0, 10) === day) }, { seq: 1 });
    built.finish();
    ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: CLOCK, meaning: false }, () => true).close();
  }
  const persons = [
    person("person:ada", "Ada Quill", [ADA]), person("person:bram", "Bram Tolt", [BRAM]), person("person:vey", "Ada Vey", [VEY]), person("person:sam1", "Sam Example", [SAM1]),
    person("person:sam2", "Sam Example", [SAM2]), person("person:rose", "Rose Example", [ROSE], ["Ada Quill"]),
    ...(more.people ?? []).map((each) => person(each.who, each.shown, each.accounts.map((account) => `phone:${account}`))),
  ].filter((each) => !more.without?.includes(each.id));
  writePrepared(openHomeFolder(root), preparedFileOf(preparedDirOf(root, machine, "people"), "people"), PEOPLE, {
    rows: new Map<string, Map<string, JsonObject>>([
      ["answer", new Map([["list", { people: [], chats: [] } as unknown as JsonObject]])],
      ["person", new Map(persons.map((each) => [each.id, { person: each } as unknown as JsonObject]))],
      ["alias", new Map(persons.flatMap((each) => [[each.id, { id: each.id }], ...each.handles.map((handle) => [handle.id, { id: each.id }])] as [string, JsonObject][]))],
      ["names", new Map([["all", { people: persons.map((each): Searched => ({ id: each.id, words: each.name.toLowerCase().split(" "), values: [], phones: each.handles.map((handle) => handle.id.slice("phone:+".length)) }) as unknown as Searched) } as unknown as JsonObject]])],
    ]),
    position: "1:1",
  });
}

function defaultTemplate(): string {
  if (defaultHomeTemplate !== undefined && existsSync(defaultHomeTemplate)) return defaultHomeTemplate;
  const root = cloneTemplate(emptyTemplate());
  buildFiles(root, {});
  return (defaultHomeTemplate = root);
}

function homeOf(more: More = {}): Home {
  const plain = more.calls === undefined && more.without === undefined && more.screen === undefined && more.facts === undefined
    && more.records === undefined && more.lines === undefined && more.named === undefined && more.held === undefined && more.people === undefined;
  const root = plain ? cloneTemplate(defaultTemplate()) : cloneTemplate(emptyTemplate());
  if (!plain) buildFiles(root, more);
  const machine = join(root, "machine-test");
  const stated = more.held;
  const families = [
    { name: "calls", collections: CALLS_COLLECTIONS }, { name: "money", collections: MONEY_COLLECTIONS }, { name: "messages", collections: MESSAGES_COLLECTIONS },
    ...stated === undefined ? [] : [stated.family],
  ] as unknown as Family[];
  const reads = openReads({
    folder: openHomeFolder(root), home: new HomeFile(openHomeFolder(root)), blobs: undefined as never, settings: () => ({ day: CLOCK, defaults: { search: null }, search: { power: "plugged-idle" } }) as Settings,
    registry: { connectors: [], readers: [], families } as unknown as Registry,
    streams: { feed: undefined as never, serves: async () => false, card: async () => undefined, open: new ErasableStreams(), checked: (_name, read) => read() },
  });
  const writer = openWriter(openHomeFolder(root), join(root, "machine"), QUIET, () => undefined);
  onTestFinished(() => writer.close());
  const marks = openMarks(openHomeFolder(dirname(join(root, "machine", "marks.db"))), join(root, "machine", "marks.db"));
  onTestFinished(() => marks.close());
  const ask = async (path: ContractPath, more: { url: string; step?: Step }): Promise<{ status: number; body: any }> => {
    try {
      const reply = await (reads.reply(path)!({ url: more.url, now_ms: NOW_MS, held: { machine } as never, epoch: 0, ...(more.step === undefined ? {} : { reader: "model" as const, step: more.step }) }) as Reply | Promise<Reply>);
      return { status: reply.status ?? 200, body: JSON.parse(String(reply.body)) };
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return { status: error.status, body: { code: error.code, message: error.words, ...error.extra } };
    }
  };
  const routed: string[] = [];
  const steps: Step[] = [];
  const model = { id: MODEL.id };
  const detector = detectorOf(model);
  const gate: Home["gate"] = {};
  const screenBusy: Home["screenBusy"] = {};
  const narrow: Home["narrow"] = { reads: false };
  const added = more.people ?? [];
  const names: Home["names"] = {
    table: added.length === 0 ? NAMES : { ...NAMES, version: [NAMES.version, ...added.map((each) => each.who)].join("+"), people: [...NAMES.people, ...added] },
  };
  const erase = { next: false };
  let held: Promise<void> | null = null;
  const route: NonNullable<HidingInputs["route"]> = async (path, step): Promise<Routed> => {
    routed.push(path);
    steps.push(step);
    await gate.wait?.();
    const { width, ...lent } = ("ask" in step ? step.lends : undefined) ?? { pieces: true as const };
    const { status, body } = await ask(path, { url: path, step: narrow.reads && width !== undefined && "ask" in step ? { ...step, lends: lent } : step });
    const busy = screenBusy.from !== undefined && steps.length > screenBusy.from && body.screen !== undefined;
    return { status, value: busy ? { ...body, screen: { unread: SCREEN_WRITTEN } } : body, epoch: 0 };
  };
  const hiding = openHiding({
    settings: () => PRIVACY,
    names: async (known) => (names.table !== undefined && names.table.version === known ? "same" : names.table),
    detector: {
      state: detector.state,
      async find(passages) {
        if (held !== null) await held;
        return detector.find(passages);
      },
    },
    chosen: () => "runner:runner-macbook-pro-0001/privacy-filter", hidingFile: () => "privacy-filter", pictures: { read: async () => ({ cannot: "no" }), make: async () => ({ cannot: "no" }) } as never, marks,
    existing: async () => [],
    writer: levelled(openHomeFolder(root), {
      epoch: () => writer.epoch(), level: writer.level.bind(writer), part: (...args) => writer.part(...args), outbound: (...args) => writer.outbound(...args), list: (...args) => writer.list(...args),
      begin: (...args) => writer.begin(...args), end: (...args) => writer.end(...args), person: writer.person.bind(writer),
      save: async (...args: Parameters<Writer["save"]>) => {
        if (erase.next) {
          erase.next = false;
          return { erased: true } as Awaited<ReturnType<Writer["save"]>>;
        }
        return writer.save(...args);
      },
    }, NOW_MS),
    progress: () => null, day: () => CLOCK, clock: () => NOW_MS, log: () => undefined, route, leavesOf: async () => "OpenAI",
  });
  return {
    hiding, writer, routed, gate, screenBusy, narrow, names, erase, steps, model,
    async mark() {
      const hider = openHider({ people: () => NAMES, settings: () => PRIVACY, detector, pictures: { read: async () => ({ cannot: "no" }), make: async () => ({ cannot: "no" }) }, marks });
      const job = openMarking({ queues: [searchQueue(openHomeFolder(root), searchFileOf(root, machine))], hider, detector, marks, chosen: () => true, log: () => undefined, look_ms: 0, rest_ms: 0 });
      await job.poke();
      await job.stop();
    },
    plain: (path, params) => ask(path, { url: `${path}?${new URLSearchParams(Object.entries(params).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((each): [string, string] => [name, each])))}` }),
    hold() {
      let open!: () => void;
      held = new Promise((resolve) => { open = resolve; });
      return () => { held = null; open(); };
    },
  };
}

const turn = (level: Level, chat = "c1"): HiddenReader => ({ pass: `p-turn-${chat}`, agent: null, turn: { table: `chat:${chat}`, level } as never });
const agent = (level: Level): HiddenReader => agentAt(level);
const PASSES: [string, (level: Level) => HiddenReader][] = [["a turn's pass", (level) => turn(level)], ["an agent's pass", agent]];
const bodyOf = (reader: HiddenReader, args: JsonObject, shown: string[] = []): JsonObject => (reader.agent === null ? { args, to: "codex:gpt-6-luna", shown } : { args });
const HANDLE = /^r[1-9]\d*$/u;

function sameButHandles(hidden: unknown, plain: unknown, where = "$"): void {
  if (typeof plain === "string" && typeof hidden === "string" && hidden !== plain) {
    expect(hidden, `${where}: ${plain}`).toMatch(HANDLE);
    return;
  }
  if (Array.isArray(plain)) {
    expect(Array.isArray(hidden), where).toBe(true);
    expect((hidden as unknown[]).length, where).toBe(plain.length);
    plain.forEach((each, i) => sameButHandles((hidden as unknown[])[i], each, `${where}[${i}]`));
    return;
  }
  if (typeof plain === "object" && plain !== null) {
    expect(Object.keys(hidden as object).sort(), where).toEqual(Object.keys(plain).sort());
    for (const [name, each] of Object.entries(plain)) sameButHandles((hidden as Record<string, unknown>)[name], each, `${where}.${name}`);
    return;
  }
  expect(hidden, where).toEqual(plain);
}

const ASKS: [ToolRoute, JsonObject, Record<string, string | string[]>][] = [
  ["/v1/count", { of: "calls", by: ["person"] }, { of: "calls", by: "person" }],
  ["/v1/people/search", { name: "Ada" }, { name: "Ada" }],
  ["/v1/read", { from: DAY, to: DAY }, { from: DAY, to: DAY }],
];

describe("the way out on the routes, paired with the person's read", () => {
  for (const [pass, reader] of PASSES) {
    it(`at none, by ${pass}: each of count, search_people and read answers the person's answer with each ref and cursor a handle, and nothing else changed`, async () => {
      const home = homeOf();
      for (const [path, args, params] of ASKS) {
        const plain = await home.plain(path, params);
        const hidden = await home.hiding.read(reader("none"), path, bodyOf(reader("none"), args));
        expect(hidden.status, path).toBe(plain.status);
        sameButHandles(hidden.value, plain.body, path);
        answerOf(path, hidden.status, hidden.value);
      }
    });

    for (const level of ["names", "all"] as const) {
      it(`at ${level}, by ${pass}: nothing of a type the level hides leaves; a count's numbers stand; each row handle opens what stands; the person a row names is found by what it says`, async () => {
        const home = homeOf();
        const plain = await home.plain("/v1/count", { of: "calls", by: "person" });
        const counted = await home.hiding.read(reader(level), "/v1/count", bodyOf(reader(level), { of: "calls", by: ["person"] }));
        expect(counted.status).toBe(200);
        const rows = counted.value.rows as unknown[][];
        expect(rows.length).toBe((plain.body.rows as unknown[]).length);
        expect((counted.value.total as { n: number }).n).toBe(plain.body.total.n);
        const people = rows.map((row) => row[0]);
        expect(new Set(people).size).toBe(2);
        if (level === "all") for (const each of people) expect(each).toMatch(/^\[\[Person \d+\]\]$/u);
        for (const row of rows) expect(row.at(-1)).toMatch(HANDLE);
        const adaRow = rows.find((row) => row[1] === 2)!;
        const opened = await home.hiding.read(reader(level), "/v1/read", bodyOf(reader(level), { ref: adaRow.at(-1) as string }));
        expect(opened.status).toBe(200);
        expect(opened.value).toMatchObject({ what: "row", n: 2 });
        expect((opened.value.rows as unknown[]).length).toBe(2);
        const found = await home.hiding.read(reader(level), "/v1/people/search", bodyOf(reader(level), { name: adaRow[0] as string }));
        expect(found.status).toBe(200);
        expect((found.value.matches as { name: string }[]).map((each) => each.name)).toEqual([adaRow[0]]);
        const day = await home.hiding.read(reader(level), "/v1/read", bodyOf(reader(level), { from: DAY, to: DAY }));
        expect(day.status).toBe(200);
        const said = JSON.stringify([counted, opened, found, day]);
        for (const word of LEAKS[level]!) expect(said).not.toContain(word);
        expect(said).not.toMatch(/"(?:row|record|line|person|chat)\.[A-Za-z0-9_-]{8,}/u);
      });
    }
  }

  it("a name of a hidden type the reader was not shown is asked as a name no one has; shown, it is searched and leaves as the person's placeholder", async () => {
    const home = homeOf();
    const stranger = await home.plain("/v1/people/search", { name: "Zed Nobody" });
    const guessed = await home.hiding.read(turn("all"), "/v1/people/search", bodyOf(turn("all"), { name: "Ada Quill" }));
    expect(guessed.status).toBe(stranger.status);
    expect(JSON.stringify(guessed.value)).not.toContain("Quill");
    expect((guessed.value.matches as unknown[] | undefined)?.length ?? 0).toBe((stranger.body.matches as unknown[] | undefined)?.length ?? 0);
    const shown = await home.hiding.read(turn("all"), "/v1/people/search", bodyOf(turn("all"), { name: "Ada Quill" }, ["You spoke with Ada Quill"]));
    expect(shown.status).toBe(200);
    expect((shown.value.matches as { name: string }[]).map((each) => each.name)).toEqual([expect.stringMatching(/^\[\[Person \d+\]\]$/u)]);
  });

  it("a handle or a placeholder this conversation was never given is HANDLE_UNKNOWN, read nowhere; a handle of another conversation opens nothing here", async () => {
    const home = homeOf();
    const unknown = await home.hiding.read(turn("all"), "/v1/read", bodyOf(turn("all"), { ref: "r41" }));
    expect(unknown).toMatchObject({ status: 404, value: { code: "HANDLE_UNKNOWN" } });
    expect(home.routed).toEqual([]);
    const theirs = await home.hiding.read(turn("all", "c9"), "/v1/count", bodyOf(turn("all", "c9"), { of: "calls", by: ["person"] }));
    const handle = (theirs.value.rows as unknown[][])[0]!.at(-1) as string;
    const mine = await home.hiding.read(turn("all"), "/v1/read", bodyOf(turn("all"), { ref: handle }));
    expect(mine).toMatchObject({ status: 404, value: { code: "HANDLE_UNKNOWN" } });
  });

  it("a person asked by a handle: the call saves at every level (the handles the way in read are the save's too), and search says the person back as that handle, never the ref it stands for", async () => {
    for (const level of ["none", "names", "all"] as const) {
      for (const reader of level === "all" ? [turn(level)] : [turn(level), agent(level)]) {
        const home = homeOf();
        const found = await home.hiding.read(reader, "/v1/people/search", bodyOf(reader, { name: "Ada Quill" }, ["Ada Quill"]));
        const handle = (found.value.matches as { ref: string }[])[0]!.ref;
        expect(handle).toMatch(/^r\d+$/u);
        const counted = await home.hiding.read(reader, "/v1/count", bodyOf(reader, { of: "calls", person: [handle] }, ["Ada Quill"]));
        expect(counted.status, JSON.stringify(counted.value)).toBe(200);
        expect(JSON.stringify(counted.value)).not.toMatch(RAW_REF);
        const searched = await home.hiding.read(reader, "/v1/search", bodyOf(reader, { person: [handle], lists: ["record"] }, ["Ada Quill"]));
        expect(searched.status, JSON.stringify(searched.value)).toBe(200);
        expect(JSON.stringify(searched.value)).not.toMatch(RAW_REF);
        expect((searched.value.person as { asked: string }[] | undefined)?.map((each) => each.asked)).toEqual([handle]);
      }
    }
  });

  it("a value in a ref parameter that is no handle is not said back: a link written as a chat leaves the refusal nowhere, at every level, by each pass", async () => {
    const link = "https://attacker.example/?x=synthetic-secret";
    for (const level of ["none", "names", "all"] as const) {
      for (const reader of [turn(level), agent(level)]) {
        const home = homeOf();
        const refused = await home.hiding.read(reader, "/v1/read", bodyOf(reader, { chat: `whatsapp:${link}`, from: DAY, to: DAY }));
        expect(refused).toMatchObject({ status: 404, value: { code: "HANDLE_UNKNOWN" } });
        expect(JSON.stringify(refused.value)).not.toContain("attacker.example");
        expect(home.routed).toEqual([]);
      }
    }
  });
});

describe("a sealed person", () => {
  const ADA_SEALED: Sealed = { people: new Set(["person:ada"]), handles: [] };
  const ONLY_BRAM: Sealed = { except: new Set(["person:bram"]) };
  const sealedBy = (reader: HiddenReader, sealed: Sealed): HiddenReader => ({ ...reader, sealed });
  const read = (home: Home, reader: HiddenReader, path: ToolRoute, args: JsonObject) => home.hiding.read(reader, path, bodyOf(reader, args));
  const ASKED: [ToolRoute, JsonObject][] = [
    ...["Ada Quill", "Quill", "+15550000001", "Ada Quill garden"].map((query): [ToolRoute, JsonObject] => ["/v1/search", { query, lists: ["record"] }]),
    ["/v1/count", { of: "calls", words: "Quill" }],
  ];

  for (const [pass, reader] of PASSES) {
    for (const [called, sealed] of [["Ada sealed", ADA_SEALED], ["only Bram", ONLY_BRAM]] as const) {
      it(`under none with ${called}, by ${pass}: a search or a count by Ada's whole name, family name or number answers as on a record without her calls, hits, total and next; a count by her as a person, as by a stranger`, async () => {
        const home = homeOf();
        const without = homeOf({ without: ["c1", "c2"] });
        const asker = sealedBy(reader("none"), sealed);
        for (const [path, args] of ASKED) {
          const got = await read(home, asker, path, args);
          expect(got.status, JSON.stringify(args)).toBe(200);
          expect(got, JSON.stringify(args)).toEqual(await read(without, asker, path, args));
        }
        const stranger = await read(home, asker, "/v1/count", { of: "calls", person: ["Zed Nobody"] });
        for (const person of ["Ada Quill", "Quill", "+15550000001"]) {
          expect(await read(home, asker, "/v1/count", { of: "calls", person: [person] }), person).toEqual(JSON.parse(JSON.stringify(stranger).replaceAll("Zed Nobody", person)));
        }
        const bram = await read(home, asker, "/v1/search", { query: "Bram Tolt", lists: ["record"] });
        expect(bram).toEqual(await read(without, asker, "/v1/search", { query: "Bram Tolt", lists: ["record"] }));
        expect((bram.value.record as { total: number }).total).toBe(1);
      });
    }

    it(`under none with Ada sealed, by ${pass}: her calls' excerpts say her placeholder, with no piece of her name or number and no marker beside it; a people search finds no one by her name and leaves her out of anyone else's same`, async () => {
      const home = homeOf();
      const asker = sealedBy(reader("none"), ADA_SEALED);
      const garden = await read(home, asker, "/v1/search", { query: "garden", lists: ["record"] });
      const hits = (garden.value.record as { hits: { snippet: unknown }[] }).hits;
      expect(hits.length).toBe(2);
      const said = JSON.stringify(garden.value);
      for (const piece of ["Ada", "Quill", "15550000001"]) expect(said).not.toContain(piece);
      expect(said).toContain("[[Person 1]]");
      expect(said).not.toMatch(/«[^»]*\[\[|\]\][^«]*»/u);
      const stranger = await read(home, asker, "/v1/people/search", { name: "Zed Nobody" });
      for (const name of ["Ada Quill", "Quill", "+15550000001"]) expect(await read(home, asker, "/v1/people/search", { name }), name).toEqual(stranger);
      const sam = sealedBy(reader("none"), { people: new Set(["person:sam1"]), handles: [] });
      const both = await read(home, reader("none"), "/v1/people/search", { name: "Sam Example" });
      const matches = both.value.matches as { ref: string; handles?: string[]; same?: { ref: string }[] }[];
      const other = matches.find((match) => match.handles?.includes("+15550000005"))!;
      expect(other.same?.length).toBe(1);
      const seen = await read(home, sam, "/v1/people/search", { id: other.ref });
      expect(seen.status).toBe(200);
      expect((seen.value.matches as { ref: string; same?: unknown[] }[]).map((match) => [match.ref, match.same])).toEqual([[other.ref, undefined]]);
    });

    it(`under none with Ada sealed, by ${pass}: a person or a name the engine finds by a prefix or by digits answers as on a record with Ada out of People`, async () => {
      const open = homeOf();
      expect(await read(open, reader("none"), "/v1/count", { of: "calls", person: ["Qu"] })).toMatchObject({ status: 200, value: { total: { n: 2 } } });
      expect((await read(open, reader("none"), "/v1/people/search", { name: "Qui" })).value.matches).toHaveLength(1);
      expect((await read(open, reader("none"), "/v1/people/search", { name: "555000000" })).value.matches).toHaveLength(6);
      const home = homeOf();
      const without = homeOf({ without: ["c1", "c2", "person:ada"] });
      const asker = sealedBy(reader("none"), ADA_SEALED);
      const asks: [ToolRoute, JsonObject][] = [
        ...["Qu", "555000000", "0000001"].flatMap((value): [ToolRoute, JsonObject][] => [["/v1/count", { of: "calls", person: [value] }], ["/v1/search", { person: [value], lists: ["record"] }]]),
        ...["Ad", "Qui", "555000000"].map((name): [ToolRoute, JsonObject] => ["/v1/people/search", { name }]),
      ];
      for (const [path, args] of asks) expect(await read(home, asker, path, args), JSON.stringify(args)).toEqual(await read(without, asker, path, args));
    });

    it(`under none with Ada sealed, by ${pass}: her ref, given before the seal, reads as a person no one holds, and Rose's page no longer names her`, async () => {
      const home = homeOf();
      const open = reader("none");
      const asker = sealedBy(open, ADA_SEALED);
      const ada = ((await read(home, open, "/v1/people/search", { name: "Ada Quill" })).value.matches as { ref: string }[])[0]!.ref;
      const rose = ((await read(home, open, "/v1/people/search", { name: "Rose Example" })).value.matches as { ref: string; same?: { ref: string }[] }[])[0]!;
      expect(rose.same?.map((each) => each.ref)).toEqual([ada]);
      const gone = await read(home, asker, "/v1/read", { ref: ada });
      expect(gone).toMatchObject({ status: 200, value: { what: "gone", ref: ada } });
      for (const piece of ["Ada", "Quill", "15550000001"]) expect(JSON.stringify(gone.value)).not.toContain(piece);
      const page = await read(home, asker, "/v1/read", { ref: rose.ref });
      expect(page).toMatchObject({ status: 200, value: { what: "people", match: { ref: rose.ref } } });
      expect((page.value.match as { same?: unknown }).same).toBeUndefined();
      const seen = await read(home, open, "/v1/read", { ref: rose.ref });
      expect((seen.value.match as { same?: { ref: string }[] }).same?.map((each) => each.ref)).toEqual([ada]);
    });

    it(`under none, by ${pass}: search hits whose day lines name Ada by her phone handle hide her name and number with Ada sealed, and show both under only Ada`, async () => {
      const home = homeOf({
        calls: [
          { key: "h1", time: "12:00", handle: ADA, text: "the hedge needs cutting", line: "Qadie: the hedge needs cutting", names: [["Qadie", ADA]] },
          { key: "h2", time: "12:30", handle: ADA, text: "the hedge is cut", line: "+15550000001: the hedge is cut", names: [["+15550000001", ADA]] },
        ],
      });
      const hedge = async (sealed: Sealed) => {
        const got = await read(home, sealedBy(reader("none"), sealed), "/v1/search", { query: "hedge", lists: ["record"] });
        expect(got.status, JSON.stringify(got.value)).toBe(200);
        const snippets = (got.value.record as { hits: { snippet: string | { text: string } }[] }).hits
          .map((hit) => (typeof hit.snippet === "string" ? hit.snippet : hit.snippet.text).replaceAll("«", "").replaceAll("»", ""));
        return { said: JSON.stringify(got.value), cutting: snippets.find((text) => text.endsWith("needs cutting")), cut: snippets.find((text) => text.endsWith("is cut")) };
      };
      const sealed = await hedge(ADA_SEALED);
      for (const piece of ["Qadie", "15550000001", "Ada", "Quill"]) expect(sealed.said).not.toContain(piece);
      expect(sealed.cutting).toMatch(/^\[\[Person \d+\]\]: the hedge needs cutting$/u);
      expect(sealed.cut).toMatch(/^\[\[[A-Za-z]+ \d+\]\]: the hedge is cut$/u);
      const shown = await hedge({ except: new Set(["person:ada"]) });
      expect([shown.cutting, shown.cut]).toEqual(["Qadie: the hedge needs cutting", "+15550000001: the hedge is cut"]);
    });

    it(`under none with only Bram, by ${pass}: "me" and a group's name reach the engine as written, with the list; a name of someone outside it as a guess`, async () => {
      const home = homeOf();
      const asker = sealedBy(reader("none"), ONLY_BRAM);
      for (const [path, args] of [["/v1/count", { of: "calls", person: ["me"] }], ["/v1/people/search", { name: "Book club" }], ["/v1/people/search", { name: "Ada Quill" }]] as [ToolRoute, JsonObject][]) {
        await read(home, asker, path, args);
      }
      const asked = home.steps.map((step) => ("ask" in step ? step.ask : "candidates" in step ? step.candidates : {}) as { person?: string[]; name?: string });
      expect(asked.map((each) => each.person?.[0] ?? each.name)).toEqual(["me", "Book club", expect.stringMatching(/^qxzvjwkh/u)]);
      for (const step of home.steps) expect(step.sealed).toEqual({ except: ["person:bram"] });
    });

    it(`by ${pass}, with no sealed list or an empty one, each answer is main's`, async () => {
      for (const sealed of [undefined, { people: new Set<string>(), handles: [] }]) {
        const home = homeOf();
        const asker = sealed === undefined ? reader("none") : sealedBy(reader("none"), sealed);
        const asks: [ToolRoute, JsonObject, Record<string, string | string[]>][] = [...ASKS, ["/v1/search", { query: "Ada Quill", lists: ["record"] }, { query: "Ada Quill", lists: "record" }]];
        for (const [path, args, params] of asks) {
          const plain = await home.plain(path, params);
          const hidden = await read(home, asker, path, args);
          expect(hidden.status, path).toBe(plain.status);
          sameButHandles(hidden.value, plain.body, path);
        }
        for (const step of home.steps) expect(step).not.toHaveProperty("sealed");
      }
    });
  }
});

describe("the one path", () => {
  it("at none: three reads of one conversation all begin their engine read before any saves, while four hide calls hold every slot", async () => {
    const home = homeOf();
    const release = home.hold();
    const hides = [1, 2, 3, 4].map((n) => home.hiding.hide({ pass: "p-chat0001", agent: null }, {
      table: `chat:h${n}`, to: "codex:gpt-6-luna", what: "text", epoch: 0, texts: [[{ text: "Lunch with Ada Quill", free: true }]],
    }));
    let entered = 0;
    let open!: () => void;
    const all = new Promise<void>((resolve) => { open = resolve; });
    home.gate.wait = () => {
      entered++;
      if (entered === 3) open();
      return all;
    };
    const reads = [0, 1, 2].map(() => home.hiding.read(turn("none"), "/v1/count", bodyOf(turn("none"), { of: "calls", by: ["person"] })));
    const answered = await Promise.all(reads);
    expect(entered).toBe(3);
    for (const each of answered) expect(each.status).toBe(200);
    release();
    await Promise.all(hides);
  });

  it("at none: a read that hides nothing, begun before another read of its conversation saves handles and saving after it, leaves the handles' count where that read put it: the next read gives new handles, never one given", async () => {
    const home = homeOf();
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    home.gate.wait = () => {
      if (!first) return Promise.resolve();
      first = false;
      entered();
      return released;
    };
    const catalog = readOf(home, turn("none"), "/v1/count", bodyOf(turn("none"), {}));
    await waiting;
    const counted = await readOf(home, turn("none"), "/v1/count", bodyOf(turn("none"), { of: "calls", by: ["person"] }));
    expect(counted.status).toBe(200);
    release();
    expect((await catalog).status).toBe(200);
    const given = new Set(JSON.stringify(counted.value).match(/\br[1-9]\d*\b/gu));
    expect(given.size).toBeGreaterThan(0);
    const day = await readOf(home, turn("none"), "/v1/read", bodyOf(turn("none"), { from: DAY, to: DAY }));
    expect(day.status).toBe(200);
    const opened = (JSON.stringify(day.value).match(/\br[1-9]\d*\b/gu) ?? []).filter((handle) => !given.has(handle));
    expect(opened.length).toBeGreaterThan(0);
  });

  it("at none: a read answers while People has no name table; at all a read with names to hide waits in fixed words", async () => {
    const home = homeOf();
    home.names.table = undefined;
    const none = await home.hiding.read(turn("none"), "/v1/people/search", bodyOf(turn("none"), { name: "Ada" }));
    expect(none.status).toBe(200);
    await expect(home.hiding.read(turn("all"), "/v1/count", bodyOf(turn("all"), { of: "calls", by: ["person"] }))).rejects.toMatchObject({ status: 503, code: "HIDE_NOT_READY" });
  });

  it("a read writes its outbound row, its tool and the refs it served, before it answers; an erasure between its read and its save runs it again from the way in", async () => {
    const home = homeOf();
    home.erase.next = true;
    const counted = await home.hiding.read(agent("all"), "/v1/count", bodyOf(agent("all"), { of: "calls", by: ["person"] }));
    expect(counted.status).toBe(200);
    expect(home.routed.filter((path) => path === "/v1/count").length).toBe(4);
    const day = await home.hiding.read(agent("all"), "/v1/read", bodyOf(agent("all"), { from: DAY, to: DAY }));
    expect(day.status).toBe(200);
    const { rows } = await home.writer.list({ from: "2026-09-08", to: "2026-09-08", day: CLOCK });
    expect(rows.map((row) => [row.tool, row.what, row.receiver]).sort()).toEqual([["count", "read", "Vault App"], ["read", "read", "Vault App"]]);
    expect(rows.find((row) => row.tool === "read")!.refs).toBeGreaterThan(0);
  });

  it("a body naming a table, a level or an epoch is refused before any read; a pass that is no model reader's is refused", async () => {
    const home = homeOf();
    for (const extra of [{ table: "chat:c2" }, { level: "none" }, { epoch: 0 }]) {
      await expect(home.hiding.read(turn("none"), "/v1/count", { ...bodyOf(turn("none"), { of: "calls" }), ...extra })).rejects.toMatchObject({ code: "BAD_PARAMETER" });
    }
    await expect(home.hiding.read({ pass: "p-mac", agent: null }, "/v1/count", { args: { of: "calls" } })).rejects.toMatchObject({ status: 403 });
    expect(home.routed).toEqual([]);
  });
});


const readOf = (home: Home, ...args: Parameters<Hiding["read"]>) => home.hiding.read(...args) as Promise<{ status: number; value: any }>;
const widthsOf = (home: Home) => home.steps.map((step) => ("ask" in step ? step.lends?.unmatched?.width : undefined));
const RAW_REF = /eyJ|WyJ|"(?:row|record|line|person|chat|window)\.[A-Za-z0-9_-]{8,}/u;
const FORTY: Called[] = Array.from({ length: 40 }, (_, n) => ({ key: `v${n}`, time: `${String(12 + Math.floor(n / 6)).padStart(2, "0")}:${String((n % 6) * 10).padStart(2, "0")}`, handle: VEY, text: `Lunch with Ada Vey, the team's ${n}` }));
const ELEVEN: Called[] = Array.from({ length: 11 }, (_, n) => ({ key: `p${n}`, time: `${String(12 + n).padStart(2, "0")}:30`, handle: BRAM, text: `Paid 5550001234 for tickets ${n}` }));
const SCREEN: Shown[] = [
  { at_ms: NOW_MS - 3_600_000, title: "Quokka notes", lines: ["quokka plans with Ada Quill for the weekend"] },
  { at_ms: NOW_MS - 7_200_000, title: "Field guide", lines: ["the quokka lives on an island"] },
  { at_ms: NOW_MS - 10_800_000, title: "Contacts", lines: ["Ada Quill"] },
];

async function placeholderOf(home: Home, reader: HiddenReader, n: number): Promise<string> {
  const counted = await readOf(home, reader, "/v1/count", bodyOf(reader, { of: "calls", by: ["person"] }));
  return (counted.value.rows as unknown[][]).find((row) => row[1] === n)![0] as string;
}

async function followed(home: Home, reader: HiddenReader, args: JsonObject): Promise<{ pages: { status: number; value: any }[]; hits: any[] }> {
  const pages = [await readOf(home, reader, "/v1/search", bodyOf(reader, args))];
  for (let next = pages[0]!.value.record?.next; typeof next === "string"; next = pages.at(-1)!.value.record?.next) {
    expect(pages.length).toBeLessThan(30);
    pages.push(await readOf(home, reader, "/v1/search", bodyOf(reader, { cursor: next })));
  }
  return { pages, hits: pages.flatMap((page) => page.value.record?.hits ?? []) };
}

describe("search's two lists on the path", () => {
  for (const [pass, reader] of PASSES) {
    it(`at none, by ${pass}: both lists answer the person's answer with each ref and cursor a handle, and nothing else changed`, async () => {
      const home = homeOf({ screen: SCREEN });
      for (const query of ["garden", "quokka"]) {
        const plain = await home.plain("/v1/search", { query, lists: ["record", "screen"] });
        const hidden = await readOf(home, reader("none"), "/v1/search", bodyOf(reader("none"), { query }));
        expect(hidden.status, query).toBe(plain.status);
        sameButHandles(hidden.value, plain.body, query);
        answerOf("/v1/search", hidden.status, hidden.value);
        expect(JSON.stringify(hidden.value)).not.toMatch(RAW_REF);
      }
    });
  }

  it("at all: a placeholder's list is the same hits in the same order with the same last total, with or without forty entries that hold the name inside another; every next followed gives each once and ends", async () => {
    const lists = [];
    for (const calls of [[], FORTY]) {
      const home = homeOf({ calls });
      const ada = await placeholderOf(home, turn("all"), 2);
      const { pages, hits } = await followed(home, turn("all"), { query: ada, limit: 1, order: "newest" });
      for (const page of pages) {
        expect(page.status).toBe(200);
        answerOf("/v1/search", page.status, page.value);
        expect(page.value.record).not.toHaveProperty("reached");
        expect(page.value.record).not.toHaveProperty("spread");
        expect(page.value.record.capped).toBe(typeof page.value.record.next === "string");
      }
      const said = JSON.stringify(pages);
      for (const word of [...LEAKS.all!, "Vey"]) expect(said).not.toContain(word);
      expect(said).not.toMatch(RAW_REF);
      for (const hit of hits) expect(hit.snippet).toContain(ada);
      expect(pages.at(-1)!.value.record.total).toBe(hits.length);
      expect(home.routed.filter((path) => path === "/v1/search").length).toBeGreaterThanOrEqual(pages.length);
      lists.push(hits.map((hit) => [hit.at, hit.family]));
    }
    expect(lists[0]!.length).toBeGreaterThan(0);
    expect(lists[1]).toEqual(lists[0]);
  });

  it("at all: a page that drops hits is filled from the engine's next pages, at most ten of them", async () => {
    const home = homeOf({ calls: FORTY });
    const ada = await placeholderOf(home, turn("all"), 2);
    const before = home.routed.length;
    const page = await readOf(home, turn("all"), "/v1/search", bodyOf(turn("all"), { query: ada, limit: 2, order: "newest" }));
    expect(page.status).toBe(200);
    expect(home.routed.length - before).toBe(10);
    expect(page.value.record.hits).toEqual([]);
    expect(page.value.record.next).toMatch(HANDLE);
  });

  it("at all: a placeholder is searched by the names that person alone goes by: a first name another person goes by too is left out, so every next followed reads the engine once a page", async () => {
    const home = homeOf({ calls: FORTY });
    home.names.table = { ...NAMES, version: "people-2", people: NAMES.people.map((each) => (each.who === "person:vey" ? { ...each, names: ["Ada Vey", "Ada"] } : each)) };
    const ada = await adaOf(home);
    const before = home.routed.length;
    const { pages, hits } = await followed(home, ALL, { query: ada, lists: ["record"], limit: 1, order: "newest" });
    expect(hits.map((hit) => hit.at.slice(11, 16))).toEqual(["10:00", "09:00"]);
    for (const hit of hits) expect(hit.snippet).toContain(ada);
    expect(home.routed.length - before).toBe(pages.length);
    const asked = home.steps.slice(-pages.length).flatMap((step) => ("ask" in step && typeof (step.ask as { query?: unknown }).query === "string" ? [(step.ask as { query: string }).query] : []));
    expect(asked.length).toBeGreaterThan(0);
    for (const query of asked) {
      expect(query).toContain('"Ada Quill"');
      expect(query).not.toContain('"Ada"');
    }
  });

  it("at all: a person found by her number and searched by her placeholder gets back her lines whose day names her by a handle, each once under that placeholder, and the list ends with them", async () => {
    const wren = "phone:+15550000013";
    const quill = "phone:+15550000014";
    const home = homeOf({
      people: [
        { who: "person:wren", is: "human", shown: "Sam Wren", names: ["Sam Wren", "Sam"], accounts: ["+15550000013"] },
        { who: "person:quill", is: "human", shown: "Sam Quill", names: ["Sam Quill", "Sam"], accounts: ["+15550000014"] },
      ],
      calls: [
        { key: "w1", time: "13:00", handle: wren, text: "the boat leaves at noon", line: "Sam Wren: the boat leaves at noon", names: [["Sam Wren", wren]] },
        { key: "w2", time: "14:00", handle: wren, text: "bring the blue map", line: "Sam Wren: bring the blue map", names: [["Sam Wren", wren]] },
        { key: "q1", time: "15:00", handle: quill, text: "the boat is full", line: "Sam Quill: the boat is full", names: [["Sam Quill", quill]] },
      ],
    });
    const found = await readOf(home, ALL, "/v1/people/search", bodyOf(ALL, { name: "+15550000013" }, ["what did +15550000013 say"]));
    expect(found.status).toBe(200);
    const her = found.value.matches[0].name as string;
    const before = home.routed.length;
    const { pages, hits } = await followed(home, ALL, { query: her, lists: ["record"], limit: 1, order: "newest" });
    expect(hits.map((hit) => hit.at.slice(11, 16))).toEqual(["14:00", "13:00"]);
    expect(new Set(hits.map((hit) => hit.ref)).size).toBe(hits.length);
    for (const hit of hits) expect(hit.snippet).toContain(her);
    for (const page of pages) answerOf("/v1/search", page.status, page.value);
    expect(pages.at(-1)!.value.record.next ?? null).toBeNull();
    expect(pages.at(-1)!.value.record.total).toBe(hits.length);
    expect(home.routed.length - before).toBe(pages.length);
    const said = JSON.stringify(pages);
    for (const word of ["Wren", "Quill", "15550000013", "15550000014"]) expect(said).not.toContain(word);
  });

  it("at all: following the placeholder of a person who is mostly a member of groups reads wide pages of the engine while hiding drops, fewer reads a kept hit, and gives each page the hits and next today's one page at a time gives", async () => {
    const wren = "phone:+15550000013";
    const home = homeOf({
      people: [{ who: "person:wren", is: "human", shown: "Sam Wren", names: ["Sam Wren", "Sam"], accounts: ["+15550000013"] }],
      calls: [
        ...["13:00", "13:10", "13:20"].map((time, n): Called => ({ key: `w${n}`, time, handle: wren, text: `the boat leaves at ${n}`, line: `Sam Wren: the boat leaves at ${n}`, names: [["Sam Wren", wren]] })),
        ...Array.from({ length: 60 }, (_, n): Called => ({ key: `g${n}`, time: `${String(14 + Math.floor(n / 6)).padStart(2, "0")}:${String((n % 6) * 10).padStart(2, "0")}`, handle: wren, text: `group plan ${n}` })),
      ],
    });
    const found = await readOf(home, ALL, "/v1/people/search", bodyOf(ALL, { name: "+15550000013" }, ["what did +15550000013 say"]));
    const her = found.value.matches[0].name as string;
    const follow = async (narrow: boolean) => {
      home.narrow.reads = narrow;
      const before = home.routed.length;
      const { pages, hits } = await followed(home, ALL, { query: her, lists: ["record"], limit: 2 });
      for (const page of pages) answerOf("/v1/search", page.status, page.value);
      return {
        reads: home.routed.length - before,
        pages: pages.map((page) => [page.value.record.hits.map((hit: any) => [hit.at, hit.family, typeof hit.snippet === "string" ? hit.snippet : hit.snippet.text]), typeof page.value.record.next, page.value.record.total]),
        hits,
      };
    };
    const today = await follow(true);
    const wide = await follow(false);
    expect(today.hits.length).toBe(3);
    for (const hit of today.hits) expect(hit.snippet).toContain(her);
    expect(wide.pages).toEqual(today.pages);
    expect(home.steps.some((step) => "ask" in step && step.lends?.width !== undefined)).toBe(true);
    expect(wide.reads).toBeLessThanOrEqual(2 * wide.pages.length);
    expect(wide.reads * 3).toBeLessThan(today.reads);
  });

  it("at all: a shown query the engine read without its filler words keeps every hit the person's read finds", async () => {
    const home = homeOf();
    const query = "about the garden";
    const plain = await home.plain("/v1/search", { query, lists: ["record"] });
    expect(plain.body.read_as?.without).toEqual(["about", "the"]);
    const hidden = await readOf(home, turn("all"), "/v1/search", bodyOf(turn("all"), { query, lists: ["record"] }, [`What did we say ${query}?`]));
    expect(hidden.status).toBe(200);
    expect(plain.body.record.hits.length).toBeGreaterThan(1);
    expect(hidden.value.record.hits.map((hit: { at: string }) => hit.at)).toEqual(plain.body.record.hits.map((hit: { at: string }) => hit.at));
    expect(JSON.stringify(hidden.value)).not.toContain("passages");
  });

  it("at all: a term left out answers alike over zero or eleven hidden matches, and is named as written", async () => {
    const answers = [];
    for (const calls of [[], ELEVEN]) {
      const home = homeOf({ calls });
      const found = await readOf(home, turn("all"), "/v1/search", bodyOf(turn("all"), { query: "garden 5550001234", lists: ["record"] }));
      expect(found.status).toBe(200);
      expect(found.value.not_searched).toEqual(["5550001234"]);
      answers.push({ found: found.value, reads: home.routed.length });
    }
    sameButHandles(answers[1]!.found, answers[0]!.found);
    expect(answers[1]!.reads).toBe(answers[0]!.reads);
  });

  it("at all: a plain hidden name the reader was not shown is withheld with no engine read, with or without entries that hold it", async () => {
    for (const calls of [[], FORTY]) {
      const home = homeOf({ calls });
      const found = await readOf(home, turn("all"), "/v1/search", bodyOf(turn("all"), { query: "Ada" }));
      expect(found).toMatchObject({ status: 422, value: { code: "WITHHELD" } });
      expect(home.routed).toEqual([]);
    }
  });

  for (const [pass, reader] of PASSES) {
    it(`at all, by ${pass}: the screen list keeps windows whose words stand, hidden, with no proof of its own and no total`, async () => {
      const home = homeOf({ screen: SCREEN });
      const found = await readOf(home, reader("all"), "/v1/search", bodyOf(reader("all"), { query: "quokka", lists: ["screen"] }));
      expect(found.status).toBe(200);
      answerOf("/v1/search", found.status, found.value);
      const screen = found.value.screen;
      expect(screen).not.toHaveProperty("total");
      expect(screen.hits.map((hit: { title: string }) => hit.title).sort()).toEqual(["Field guide", "Quokka notes"]);
      for (const hit of screen.hits) for (const member of ["source", "terms", "group", "siblings"]) expect(hit).not.toHaveProperty(member);
      const notes = screen.hits.find((hit: { title: string }) => hit.title === "Quokka notes");
      expect(notes.snippet).toMatch(/«quokka».*\[\[Person \d+\]\]/u);
      const said = JSON.stringify(found);
      for (const word of LEAKS.all!) expect(said).not.toContain(word);
      expect(said).not.toMatch(RAW_REF);
    });
  }

  it("at all: a window whose word stands only inside a hidden name is searched again as matching nothing there, and answers as a word no screen holds", async () => {
    const home = homeOf({ screen: SCREEN });
    const hidden = await readOf(home, turn("all"), "/v1/search", bodyOf(turn("all"), { query: "quill", lists: ["screen"] }));
    const rounds = home.routed.length;
    const none = await readOf(home, turn("all"), "/v1/search", bodyOf(turn("all"), { query: "zzqx", lists: ["screen"] }));
    expect([hidden.status, none.status]).toEqual([200, 200]);
    expect(rounds).toBe(2);
    expect(hidden.value.screen.hits).toEqual([]);
    expect(none.value.screen.hits).toEqual([]);
    expect(JSON.stringify(hidden)).not.toContain("Quill");
  });

  it("at all: a word that stands only inside a hidden name in many windows is judged, after its first page, in rounds of a cursor's windows; the round that lists none is the answer, a word no screen holds", async () => {
    const many: Shown[] = Array.from({ length: 70 }, (_, n) => ({ at_ms: NOW_MS - 3_600_000 * (n + 4), title: `Ledger ${n}`, lines: [`call Ada Quill about item ${n}`] }));
    const home = homeOf({ screen: [...SCREEN, ...many] });
    const hidden = await readOf(home, turn("all"), "/v1/search", bodyOf(turn("all"), { query: "quill", lists: ["screen"] }));
    expect(hidden.status).toBe(200);
    expect(hidden.value.screen.hits).toEqual([]);
    expect(widthsOf(home)).toEqual([undefined, ROUND_WIDTH, ROUND_WIDTH]);
    expect(JSON.stringify(hidden)).not.toContain("Quill");
  });

  it("at all: wide rounds only find what is dropped: the answer is one ordinary page over what they found, ten visible windows and a next that gives the other five", async () => {
    const inName: Shown[] = Array.from({ length: 30 }, (_, n) => ({ at_ms: NOW_MS - 600_000 * (n + 20), title: `Ledger ${n}`, lines: [`Ada Quill ${n}`] }));
    const seen: Shown[] = Array.from({ length: 15 }, (_, n) => ({
      at_ms: NOW_MS - 600_000 * (n + 60), title: `Pens ${n}`, lines: [`sharpened the quill pen for a long letter to the printer, batch ${n}`],
    }));
    const home = homeOf({ screen: [...inName, ...seen] });
    const first = await readOf(home, turn("all"), "/v1/search", bodyOf(turn("all"), { query: "quill", lists: ["screen"] }));
    expect(first.status).toBe(200);
    const widths = widthsOf(home);
    const wide = widths.slice(1, -1);
    expect(widths[0]).toBeUndefined();
    expect(widths.at(-1)).toBeUndefined();
    expect(wide.length).toBeGreaterThan(0);
    expect(wide).toEqual(wide.map(() => ROUND_WIDTH));
    const titles = (page: { value: any }) => (page.value.screen.hits as { title: string }[]).map((hit) => hit.title);
    expect(titles(first)).toHaveLength(10);
    for (const title of titles(first)) expect(title).toMatch(/^Pens \d+$/u);
    expect(typeof first.value.screen.next).toBe("string");
    const second = await readOf(home, turn("all"), "/v1/search", bodyOf(turn("all"), { cursor: first.value.screen.next }));
    expect(second.status).toBe(200);
    expect(titles(second)).toHaveLength(5);
    expect([...titles(first), ...titles(second)].sort()).toEqual(seen.map((each) => each.title).sort());
    expect(second.value.screen.next ?? null).toBeNull();
    expect(JSON.stringify([first, second])).not.toContain("Quill");
  });

  it("at all: a round whose screen read is unread answers the screen's busy state, never a list or a next from an earlier round", async () => {
    const many: Shown[] = Array.from({ length: 70 }, (_, n) => ({ at_ms: NOW_MS - 3_600_000 * (n + 4), title: `Ledger ${n}`, lines: [`call Ada Quill about item ${n}`] }));
    const home = homeOf({ screen: [...SCREEN, ...many] });
    home.screenBusy.from = 2;
    const hidden = await readOf(home, turn("all"), "/v1/search", bodyOf(turn("all"), { query: "quill", lists: ["screen"] }));
    expect(hidden.status).toBe(200);
    expect(widthsOf(home)).toEqual([undefined, ROUND_WIDTH, ROUND_WIDTH]);
    expect(hidden.value.screen).toEqual({ unread: SCREEN_WRITTEN });
    expect(JSON.stringify(hidden)).not.toContain("Quill");
  });

  it("at all: a word the reader was shown matches nowhere inside a hidden name: a count by it is a count of a word no record holds, a screen list by it keeps no window", async () => {
    const home = homeOf({ screen: SCREEN });
    const shown = ["the quill pen broke", "zzqx"];
    const plain = await home.plain("/v1/count", { of: "calls", words: "quill" });
    expect(plain.body.total.n).toBe(2);
    const counted = [];
    for (const words of ["quill", "zzqx"]) {
      const found = await readOf(home, turn("all"), "/v1/count", bodyOf(turn("all"), { of: "calls", words, by: ["person"] }, shown));
      expect(found.status, words).toBe(200);
      counted.push([found.value.total.n, found.value.rows]);
    }
    expect(counted[0]).toEqual(counted[1]);
    expect(counted[0]).toEqual([0, []]);
    const screen = await readOf(home, turn("all"), "/v1/search", bodyOf(turn("all"), { query: "quill", lists: ["screen"] }, shown));
    expect(screen.status).toBe(200);
    expect(screen.value.screen.hits).toEqual([]);
  });

  it("at all: the outbound row counts what left, never what was hidden only to judge a hit; each kept hit's snippet marks a word of the query", async () => {
    const home = homeOf();
    const found = await readOf(home, agent("all"), "/v1/search", bodyOf(agent("all"), { query: "garden", lists: ["record"] }));
    expect(found.status).toBe(200);
    expect(found.value.record.hits).toHaveLength(2);
    for (const hit of found.value.record.hits) expect(hit.snippet).toContain("«garden»");
    const { rows } = await home.writer.list({ from: "2026-09-08", to: "2026-09-08", day: CLOCK });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.counts.person).toBe(JSON.stringify(found.value).match(/\[\[Person \d+\]\]/gu)!.length);
  });

  it("at names: two calls of one conversation at once: the second reads the engine only once the first has saved, so no name the first saves changes what the second judged; its hits leave hidden", async () => {
    const home = homeOf();
    const events: string[] = [];
    home.gate.wait = async () => void events.push("engine");
    const release = home.hold();
    const first = home.hiding.hide({ pass: "p-turn-c1", agent: null }, {
      table: "chat:c1", to: "codex:gpt-6-luna", what: "text", epoch: 0, texts: [[{ text: "Lunch with Bram Tolt at 5550001234", free: true }]],
    }).then((saved) => {
      events.push("saved");
      return saved;
    });
    const second = readOf(home, turn("names"), "/v1/search", bodyOf(turn("names"), { query: "garden", lists: ["record"] }));
    release();
    await first;
    const answered = await second;
    expect(answered.status).toBe(200);
    expect(events[0]).toBe("saved");
    expect(events.slice(1).every((each) => each === "engine")).toBe(true);
    expect((answered.value.record as { hits: unknown[] }).hits.length).toBe(2);
    expect(JSON.stringify(answered)).not.toContain("15550000001");
  });
});

const payment = (key: string, payee: string, amount: string, currency = "EUR"): DayFileFact => ({
  id: `payments:${key.padStart(24, "0")}`, family: "money", of: "payments", time_ms: at("00:00"), start_ms: at("00:00"), end_ms: at("00:00"), date_only: true,
  keys: { payee, direction: "debit", currency }, measures: { amount }, who: [], from: { units: [`money/${key}`], record: { source: "bank:acct:a", kind: "payment", key }, alone: true }, lines: [],
});
const paid = (key: string, text: string): RecordEntry => ({
  record: { source: "bank:acct:a", kind: "payment", key }, family: "money", version: `v-${key}`, start_ms: at("00:00"), end_ms: null, title: "", text, who: [], link: null,
});
const message = (key: string, time: string): DayFileFact => ({
  id: `messages:${key.padStart(24, "0")}`, family: "messages", of: "messages", time_ms: at(time), start_ms: at(time), end_ms: at(time),
  keys: { chat: "whatsapp:15550000001@s.whatsapp.net", direction: "received", product: "whatsapp", searchable: "yes" }, measures: {},
  who: [{ handle: ADA, role: "sender" }], from: { units: [`messages/${key}`], record: { source: "wa:local:a", kind: "msg", key }, alone: true }, lines: [],
});
const PAYMENTS: DayFileFact[] = [
  payment("p1", "ACME CABS", "10.00"), payment("p2", "ACME CABS", "20.00"), payment("p3", "Quxley Zent", "99.00"), payment("p4", "Ada Quill", "7.00"),
  payment("p5", "Ada", "1.00"), payment("p6", "CORNER BAKERY", "3.00"), payment("p7", "ROAD SHOP", "4.00", "USD"), message("m1", "08:00"), message("m2", "08:30"),
];
const PAID_FOR: RecordEntry[] = [paid("p1", "ACME CABS ride to dinner"), paid("p3", "dinner with Rosalind"), paid("p4", "lunch with Ada Quill"), paid("p6", "lunch with Ada Vey")];
const MONEY: More = { facts: PAYMENTS, records: PAID_FOR, lines: { [PAYMENTS[0]!.id]: "taxi home" } };
const PERSON = /^\[\[Person \d+\]\]$/u;
const ALL = turn("all");

async function moneyHome(more: More = {}): Promise<Home> {
  const home = homeOf({ ...MONEY, ...more });
  await home.mark();
  return home;
}
const asking = (home: Home, args: JsonObject, shown: string[] = [], reader = ALL, path: ToolRoute = "/v1/count") => readOf(home, reader, path, bodyOf(reader, args, shown));
const totalOf = (found: { status: number; value: any }): number => {
  expect(found.status, JSON.stringify(found.value)).toBe(200);
  return found.value.total.n;
};
const numbersOf = (found: { status: number; value: any }) => {
  const { ref: _ref, ...total } = found.value.total ?? {};
  return { status: found.status, total, population: found.value.population, rows: (found.value.rows as unknown[][] | undefined)?.map((row) => row.slice(0, -1)) };
};
async function adaOf(home: Home, reader = ALL): Promise<string> {
  const found = await asking(home, { name: "Ada Quill" }, ["Ada Quill"], reader, "/v1/people/search");
  return (found.value.matches as { name: string }[])[0]!.name;
}

describe("the old suites' cases, carried onto the path", () => {
  it("search by a person's placeholder finds her by her full name, her first name and her account; by a phone's placeholder, its digits spelled otherwise; excluded, it drops them", async () => {
    const home = homeOf({ calls: [
      { key: "a1", time: "13:00", handle: BRAM, text: "Ada said the gate is fixed" },
      { key: "a2", time: "14:00", handle: BRAM, text: "text +15550000001 later" },
      { key: "a3", time: "15:00", handle: BRAM, text: "ring 555-000-0001 tomorrow" },
    ] });
    const ada = await adaOf(home);
    const times = async (query: string) => {
      const { pages, hits } = await followed(home, ALL, { query, lists: ["record"], order: "oldest" });
      expect(pages.at(-1)!.value.record.total, query).toBe(hits.length);
      expect(JSON.stringify(pages), query).not.toMatch(/Quill|0000001/u);
      return hits.map((hit) => hit.at.slice(11, 16));
    };
    expect(await times(ada)).toEqual(["09:00", "10:00", "13:00", "14:00"]);
    const rang = await asking(home, { query: "ring", lists: ["record"] }, [], ALL, "/v1/search");
    const phone = /\[\[Phone \d+\]\]/u.exec(JSON.stringify(rang.value))?.[0];
    expect(phone, JSON.stringify(rang.value)).toBeDefined();
    expect(await times(phone!)).toContain("15:00");
    const without = await asking(home, { query: `garden -${ada}`, lists: ["record"] }, [], ALL, "/v1/search");
    expect(without.value.record.hits).toEqual([]);
  });

  it("a name seen on her shared address is no name of hers in the table People gives hiding: it takes a placeholder of its own, never hers", async () => {
    const home = homeOf({ calls: [{ key: "b1", time: "13:00", handle: ADA, text: "Bea Shared sent the photos" }] });
    const table = nameTableOf([{ ...person("person:ada", "Ada Quill", [ADA]), names_seen: ["Bea Shared"] } as PersonDetail], []);
    expect(table.people[0]!.names).not.toContain("Bea Shared");
    home.names.table = { ...NAMES, version: "people-2", people: [...table.people, ...NAMES.people.filter((each) => each.who !== "person:ada")] };
    const ada = await adaOf(home);
    const found = await asking(home, { query: "photos", lists: ["record"] }, [], ALL, "/v1/search");
    const snippet = (found.value.record.hits as { snippet: string }[])[0]!.snippet;
    expect(snippet).toMatch(/^\[\[Person \d+\]\] sent the «photos»$/u);
    expect(snippet).not.toContain(ada);
  });

  it("G5 a fragment of a structure key matches plainly under a level that hides, never withheld for marks it never takes", async () => {
    const home = homeOf(MONEY);
    expect(totalOf(await asking(home, { of: "payments", match: { currency: "US" } }))).toBe(1);
    expect(totalOf(await asking(home, { of: "payments", match: { currency: "-US" } }))).toBe(6);
  });

  it("two people shown alike are each found by their own placeholder, never the other's", async () => {
    const home = homeOf({ calls: [
      { key: "s1", time: "16:00", handle: SAM1, text: "Sam Example rang about the boat", names: [["Sam Example", "person:sam1"]] },
      { key: "s2", time: "17:00", handle: SAM2, text: "Sam Example rang about the bike", names: [["Sam Example", "person:sam2"]] },
    ] });
    const found = await asking(home, { name: "Sam Example" }, ["Sam Example"], ALL, "/v1/people/search");
    const sams = (found.value.matches as { name: string }[]).map((each) => each.name);
    expect(sams).toHaveLength(2);
    expect(new Set(sams).size).toBe(2);
    for (const [sam, said] of [[sams[0]!, "boat"], [sams[1]!, "bike"]] as const) {
      const { hits } = await followed(home, ALL, { query: sam, lists: ["record"] });
      expect(hits.map((hit) => hit.snippet.includes(said)), sam).toEqual([true]);
    }
  });

  it("a name two people go by is PERSON_UNKNOWN on search and count: plain at none, each match a placeholder and a handle at all, and each askable", async () => {
    const home = homeOf();
    const plain = await asking(home, { query: "garden", person: ["Ada"] }, [], turn("none"), "/v1/search");
    expect(plain).toMatchObject({ status: 404, value: { code: "PERSON_UNKNOWN" } });
    expect((plain.value.matches as { name: string }[]).map((each) => each.name).sort()).toEqual(["Ada Quill", "Ada Vey"]);
    const hidden = await asking(home, { query: "garden", person: ["Ada"] }, ["Ada"], ALL, "/v1/search");
    expect(hidden).toMatchObject({ status: 404, value: { code: "PERSON_UNKNOWN" } });
    const matches = hidden.value.matches as { name: string; ref: string }[];
    expect(matches.map((each) => each.name)).toEqual([expect.stringMatching(PERSON), expect.stringMatching(PERSON)]);
    expect(new Set(matches.map((each) => each.name)).size).toBe(2);
    expect(JSON.stringify(hidden.value)).not.toMatch(/Quill|Vey/u);
    expect(JSON.stringify(hidden.value)).not.toMatch(RAW_REF);
    const counted = await Promise.all(matches.map((each) => asking(home, { of: "calls", person: [each.ref] }, ["Ada"])));
    expect(counted.map(totalOf).sort()).toEqual([0, 2]);
    const ambiguous = await asking(home, { of: "calls", person: ["Ada"] }, ["Ada"]);
    expect(ambiguous).toMatchObject({ status: 404, value: { code: "PERSON_UNKNOWN" } });
    expect((ambiguous.value.matches as { name: string }[]).map((each) => each.name)).toEqual([expect.stringMatching(PERSON), expect.stringMatching(PERSON)]);
    expect(JSON.stringify(ambiguous.value)).not.toMatch(/Quill|Vey/u);
  });

  it("H1 a guessed hidden name in person counts as a stranger's; in match or words it is withheld by the query alone, named as written", async () => {
    const home = await moneyHome();
    const stranger = await asking(home, { of: "calls", person: ["Zed"] });
    expect(stranger).toMatchObject({ status: 404, value: { code: "PERSON_UNKNOWN" } });
    for (const guessed of ["Ada", "+15550000001"]) {
      const guess = await asking(home, { of: "calls", person: [guessed] });
      expect([guess.status, guess.value.code, guess.value.message], guessed).toEqual([stranger.status, stranger.value.code, stranger.value.message.replace("Zed", guessed)]);
    }
    for (const [args, not] of [[{ match: { payee: "Quxley" } }, "Quxley"], [{ match: { payee: "5550" } }, "5550"], [{ words: "Rosalind" }, "Rosalind"]] as const) {
      expect(await asking(home, { of: "payments", ...args }), not).toMatchObject({ status: 422, value: { code: "WITHHELD", not_searched: [not] } });
    }
  });

  it("H2 H3 H4 a fragment standing only inside a hidden payee counts as one no payee holds, letter by letter; its exclusion, or a guess's, moves no total", async () => {
    const home = await moneyHome();
    const sum = (payee?: string) => asking(home, { of: "payments", measure: "amount", match: { currency: "EUR", ...(payee === undefined ? {} : { payee }) } });
    const none = numbersOf(await sum("vvvv"));
    expect(numbersOf(await sum("uxle"))).toEqual(none);
    for (const step of ["q", "qu", "qux", "quxl", "quxle"]) expect(numbersOf(await sum(step)), step).toEqual(none);
    expect(await asking(home, { of: "payments", measure: "amount", match: { payee: "quxley" } })).toMatchObject({ status: 422, value: { code: "WITHHELD", not_searched: ["quxley"] } });
    const all = numbersOf(await sum());
    expect(all.total).toMatchObject({ n: 6 });
    for (const excluded of ["-uxle", "-quxl"]) expect(numbersOf(await sum(excluded)), excluded).toMatchObject({ total: all.total, population: all.population });
    expect(numbersOf(await sum("a -qux"))).toMatchObject({ total: numbersOf(await sum("a")).total });
    const words = (said: string) => asking(home, { of: "payments", words: said });
    expect(totalOf(await words("-Rosali"))).toBe(totalOf(await asking(home, { of: "payments" })));
    expect(totalOf(await words("Rosali"))).toBe(0);
    expect(totalOf(await words("dinner"))).toBe(2);
    expect(totalOf(await words("dinner -Rosalind"))).toBe(0);
    const stranger = await asking(home, { of: "calls", person: ["Zed"] });
    for (const args of [{ of: "calls", person: ["Bram"] }, { of: "calls", measure: "minutes", person: ["Bram"] }]) {
      const guess = await asking(home, args);
      expect([guess.status, guess.value.code]).toEqual([stranger.status, stranger.value.code]);
    }
  });

  it("H5 F14 a group by a hidden key shows each group as the level shows it, one placeholder for every name of one person; under none, plain", async () => {
    const home = await moneyHome();
    const byPayee = await asking(home, { of: "payments", by: ["payee"], match: { currency: "EUR" } });
    expect(byPayee.status).toBe(200);
    const keys = (byPayee.value.rows as unknown[][]).map((row) => row[0] as string);
    expect(keys).toEqual(expect.arrayContaining(["ACME CABS", "CORNER BAKERY", expect.stringMatching(/^\[\[Person \d+\]\] Zent$/u)]));
    const ada = await adaOf(home);
    expect((byPayee.value.rows as unknown[][]).filter((row) => row[0] === ada).map((row) => row[1])).toEqual([1, 1]);
    expect(JSON.stringify(byPayee.value)).not.toMatch(/Quxley|Quill/u);
    const zent = await asking(home, { of: "payments", match: { payee: "zent" } });
    expect(totalOf(zent)).toBe(1);
    expect(JSON.stringify(zent.value.matched)).toMatch(/\[\[Person \d+\]\] Zent/u);
    expect(JSON.stringify(zent.value)).not.toContain("Quxley");
    const plain = await asking(home, { of: "payments", by: ["payee"] }, [], turn("none"));
    expect((plain.value.rows as unknown[][]).map((row) => row[0])).toEqual(expect.arrayContaining(["Quxley Zent", "Ada Quill", "Ada"]));
    for (const row of plain.value.rows as unknown[][]) expect(row.at(-1)).toMatch(HANDLE);
  });

  it("H7 F1 a placeholder in match or person is said back as itself; a name the reader was shown stands; a handle People does not know finds its own calls", async () => {
    const home = await moneyHome({ calls: [{ key: "u1", time: "18:00", handle: "phone:+15550000077", text: "a call from a stranger" }] });
    const zent = (await asking(home, { of: "payments", by: ["payee"] })).value.rows.map((row: unknown[]) => row[0]).find((key: string) => key.endsWith(" Zent")) as string;
    const quxley = zent.slice(0, -" Zent".length);
    const matched = await asking(home, { of: "payments", match: { payee: quxley } });
    expect(totalOf(matched)).toBe(1);
    expect(Object.keys(matched.value.matched.payee)).toEqual([quxley]);
    expect(JSON.stringify(matched.value)).not.toContain("Quxley");
    const ada = await adaOf(home);
    expect(totalOf(await asking(home, { of: "payments", match: { payee: ada } }))).toBe(2);
    expect(totalOf(await asking(home, { of: "payments", match: { payee: `"${ada}"` } }))).toBe(2);
    expect(totalOf(await asking(home, { of: "calls", person: [ada] }))).toBe(2);
    expect(totalOf(await asking(home, { of: "calls", person: ["Bram"] }, ["How long did I talk to Bram?"]))).toBe(1);
    const rows = (await asking(home, { of: "calls", by: ["person"] })).value.rows as unknown[][];
    const cell = rows.map((row) => String(row[0])).find((each) => each.includes("[[Phone "))!;
    expect(cell, JSON.stringify(rows)).toBeDefined();
    const placeholder = /\[\[Phone \d+\]\]/u.exec(cell)![0];
    for (const [written, raw] of [[cell, cell.replace(placeholder, "+15550000077")], [placeholder, "+15550000077"]] as const) {
      const theirs = await asking(home, { of: "calls", person: [written] }, [JSON.stringify(rows)]);
      const plain = await home.plain("/v1/count", { of: "calls", person: raw });
      expect([theirs.status, theirs.value.code, theirs.value.total?.n], `${written}: ${JSON.stringify(theirs.value)} ${JSON.stringify(plain.body)}`).toEqual([plain.status, plain.body.code, plain.body.total?.n]);
      expect(JSON.stringify(theirs.value)).not.toContain("5550000077");
    }
  });

  it("F13 F15 F16 a placeholder in words counts the facts that show it, in any spelling, never one whose other person's name holds its words; an exclusion is looked for in every passage", async () => {
    const home = await moneyHome();
    const ada = await adaOf(home);
    const loose = ada.replace(/^\[\[Person (\d+)\]\]$/u, "[[person$1]]");
    expect(loose).not.toBe(ada);
    const all = totalOf(await asking(home, { of: "payments" }));
    for (const spelled of [ada, loose]) {
      expect(totalOf(await asking(home, { of: "payments", words: spelled })), spelled).toBe(1);
      expect(totalOf(await asking(home, { of: "payments", words: `-${spelled}` })), spelled).toBe(all - 1);
    }
    expect(totalOf(await asking(home, { of: "payments", words: "dinner -taxi" }))).toBe(1);
  });

  it("F17 an alternative that cannot be read never withholds a fact another alternative proves, in either order; alone it is withheld", async () => {
    const home = await moneyHome({ records: [...PAID_FOR, paid("p2", "dinner with friends")], lines: { [PAYMENTS[1]!.id]: "smudged receipt from Ada" } });
    const ada = await adaOf(home);
    for (const words of [`${ada} OR "dinner"`, `"dinner" OR ${ada}`]) expect(totalOf(await asking(home, { of: "payments", words })), words).toBe(4);
    expect(await asking(home, { of: "payments", words: ada })).toMatchObject({ status: 422, value: { code: "WITHHELD" } });
  });

  it("F18 A1 A4 a count at a level that hides states no also, which the engine counts from raw words: alike with or without forty entries of another person whose name holds a placeholder's words; at none the engine's", async () => {
    const said = [];
    for (const calls of [[], FORTY]) {
      const home = await moneyHome({ calls });
      const ada = await adaOf(home);
      for (const args of [{ words: ada }, { match: { payee: ada } }, { words: "dinner" }]) {
        const found = await asking(home, { of: "payments", ...args }, ["dinner"]);
        expect(found.status).toBe(200);
        expect(found.value).not.toHaveProperty("also");
        said.push(numbersOf(found));
      }
      expect((await asking(home, { of: "payments", words: "Quill" }, [], turn("none"))).value.also).toEqual([expect.stringContaining("2 calls entries")]);
    }
    expect(said.slice(3)).toEqual(said.slice(0, 3));
  });

  it("C2 C3 C4 a value not marked yet withholds the count, a new hiding model's too, until the job marks it; a value looked at and left out takes no placeholder; a value keeps its placeholder", async () => {
    const home = homeOf(MONEY);
    expect(await asking(home, { of: "payments", match: { payee: "zent" } })).toMatchObject({ status: 422, value: { code: "WITHHELD" } });
    await home.mark();
    expect(totalOf(await asking(home, { of: "payments", match: { payee: "zent" } }))).toBe(1);
    home.model.id = "fake-filter-2";
    expect(await asking(home, { of: "payments", match: { payee: "zent" } })).toMatchObject({ status: 422, value: { code: "WITHHELD" } });
    await home.mark();
    expect(totalOf(await asking(home, { of: "payments", match: { payee: "zent" } }))).toBe(1);
    const fresh = await moneyHome();
    const left = turn("all", "left");
    expect(totalOf(await asking(fresh, { of: "payments", match: { payee: "uxle" } }, [], left))).toBe(0);
    expect(totalOf(await asking(fresh, { of: "payments", words: "dinner" }, [], left))).toBe(2);
    const held = await fresh.hiding.restore(left, { table: "chat:left", text: "[[Person 1]] [[Person 2]]" });
    expect(held.unknown).toEqual(["[[Person 1]]", "[[Person 2]]"]);
    const first = await asking(fresh, { of: "payments", by: ["payee"] });
    const again = await asking(fresh, { of: "payments", by: ["payee"] });
    expect((again.value.rows as unknown[][]).map((row) => row[0])).toEqual((first.value.rows as unknown[][]).map((row) => row[0]));
  });

  it("G3 X3 X5 X6 a row's handle of a count matched by a placeholder opens its facts as the level shows them, alone or among refs; a raw ref is no handle", async () => {
    const home = await moneyHome();
    const zent = (await asking(home, { of: "payments", by: ["payee"] })).value.rows.map((row: unknown[]) => row[0]).find((key: string) => key.endsWith(" Zent")) as string;
    const byDay = await asking(home, { of: "payments", measure: "amount", by: ["day"], match: { payee: zent.slice(0, -" Zent".length) } });
    expect(totalOf(byDay)).toBe(1);
    const handle = (byDay.value.rows as unknown[][])[0]!.at(-1) as string;
    const opened = await asking(home, { ref: handle }, [], ALL, "/v1/read");
    expect(opened.status).toBe(200);
    expect(opened.value).toMatchObject({ what: "row", n: 1 });
    expect(JSON.stringify(opened.value)).toMatch(/\[\[Person \d+\]\] Zent/u);
    expect(JSON.stringify(opened.value)).not.toContain("Quxley");
    const among = await asking(home, { ref: [handle, handle] }, [], ALL, "/v1/read");
    expect(among.status).toBe(200);
    expect(JSON.stringify(among.value)).not.toContain("Quxley");
    expect(await asking(home, { ref: "row.eyJhIjoib2Y9cGF5bWVudHMifQ" }, [], ALL, "/v1/read")).toMatchObject({ status: 404, value: { code: "HANDLE_UNKNOWN" } });
  });

  it("X1 X2 an extreme and a list by item name each fact's keys and people as the level shows them, every ref a handle", async () => {
    const home = await moneyHome();
    const most = await asking(home, { of: "payments", measure: "amount", op: "max", match: { currency: "EUR" } });
    expect(most.status, JSON.stringify(most.value)).toBe(200);
    const items = await asking(home, { of: "payments", measure: "amount", by: ["item"], order: "value", match: { currency: "EUR" } });
    expect(items.status, JSON.stringify(items.value)).toBe(200);
    for (const row of items.value.rows as unknown[][]) expect(row.at(-1)).toMatch(HANDLE);
    const calls = await asking(home, { of: "calls", measure: "minutes", op: "max", by: ["outcome"] });
    expect(calls.status, JSON.stringify(calls.value)).toBe(200);
    const said = JSON.stringify([most.value, items.value, calls.value]);
    expect(said).toMatch(/\[\[Person \d+\]\] Zent/u);
    expect(said).not.toMatch(/Quxley|Quill|15550000001/u);
    expect(said).not.toMatch(RAW_REF);
  });

  it("X4 K1 the catalog answers under a level that hides, structure as it is; a count by chat counts its messages at none and at all, the chat hidden", async () => {
    const home = await moneyHome();
    const catalog = await asking(home, {});
    expect(catalog.status).toBe(200);
    expect(catalog.value.collections.find((each: { of: string }) => each.of === "payments")).toMatchObject({ keys: ["payee", "account", "direction", "channel", "currency"] });
    for (const level of ["none", "all"] as const) {
      const byChat = await asking(home, { of: "messages", by: ["chat"] }, [], turn(level));
      expect((byChat.value.rows as unknown[][]).map((row) => row[1]), level).toEqual([2]);
      expect(JSON.stringify(byChat.value).includes("15550000001"), level).toBe(level === "none");
      const opened = await asking(home, { ref: (byChat.value.rows as unknown[][])[0]!.at(-1) as string }, [], turn(level), "/v1/read");
      expect(opened.value, level).toMatchObject({ what: "row", n: 2 });
    }
  });

  it("the screen list: a group stands only where every term of it stands; a shown name inside a hidden name over more windows than one round answers as a word no screen holds", async () => {
    const many: Shown[] = Array.from({ length: 12 }, (_, n) => ({ at_ms: NOW_MS - 3_600_000 * (n + 4), title: `Thread ${n}`, lines: ["call Ada Quill", "quokka plans"] }));
    const home = homeOf({ screen: [...SCREEN, ...many] });
    const shown = ["the quill pen and the zzqx"];
    const hidden = await readOf(home, ALL, "/v1/search", bodyOf(ALL, { query: "quill quokka", lists: ["screen"] }, shown));
    const none = await readOf(home, ALL, "/v1/search", bodyOf(ALL, { query: "zzqx quokka", lists: ["screen"] }, shown));
    expect([hidden.status, none.status]).toEqual([200, 200]);
    sameButHandles(hidden.value.screen.hits.map((hit: { title: string }) => hit.title), none.value.screen.hits.map((hit: { title: string }) => hit.title));
    expect(JSON.stringify(hidden.value)).not.toContain("Quill");
  });

  it("the screen list asks by meaning only what names no hidden detail the reader may not name: a placeholder by the words it stands for", async () => {
    const home = homeOf({ screen: SCREEN });
    const lent = async (query: string, shown: string[] = []) => {
      home.steps.length = 0;
      const found = await readOf(home, ALL, "/v1/search", bodyOf(ALL, { query, lists: ["screen"] }, shown));
      return { status: found.status, meaning: (home.steps[0] as { lends?: { meaning?: unknown } } | undefined)?.lends?.meaning };
    };
    expect(await lent("Ada")).toEqual({ status: 422, meaning: undefined });
    expect(await lent("quokka 5550001234")).toEqual({ status: 200, meaning: { withheld: true } });
    expect(await lent("quokka")).toEqual({ status: 200, meaning: { words: "quokka" } });
    const ada = await adaOf(home);
    expect(await lent(`${ada} plans`)).toEqual({ status: 200, meaning: { words: "Ada Quill plans" } });
  });
});

describe("one name, one placeholder, whichever tool returned it", () => {
  const ADDRESS = "person-a@example.com";
  const SOURCE = "gmail:owner@example.com:api";
  const MAIL = { source: SOURCE, kind: "mail", key: "m1" };
  const SUBJECT = "Invoice";
  const BODY = "Hi Mira, please find attached the invoice for the shed.";
  const LINE = `Mail from You to Mira Kestrel: “${SUBJECT}” — ${BODY}`;
  const MAILED: DayFileFact = {
    id: `mails:${"m1".padStart(24, "0")}`, family: "mail", of: "mails", time_ms: at("12:00"), start_ms: at("12:00"), end_ms: at("12:00"),
    keys: { direction: "sent", title: SUBJECT }, measures: {}, who: [{ handle: `email:${ADDRESS}`, role: "receiver" }], from: { units: ["mail/m1"], record: MAIL, alone: true }, lines: [],
  };
  const mailFamily = {
    name: "mail",
    inputs: [{ sources: { product: ["gmail"] }, kinds: ["mail"], role: "evidence" }],
    text: { version: "1", kinds: ["mail"], of: () => ({ title: SUBJECT, text: BODY, who: [ADDRESS] }) },
    read: { of: () => ({ title: SUBJECT, text: BODY, to: [ADDRESS] }) },
  } as unknown as Family;
  const MAILS: More = {
    held: { family: mailFamily, source: SOURCE, rows: [{ kind: "mail", key: "m1", content: { subject: SUBJECT }, time: { start_ms: at("12:00"), precision: "ms" } }] },
    records: [{ record: MAIL, family: "mail", version: "v-m1", start_ms: at("12:00"), end_ms: null, title: SUBJECT, text: BODY, who: [ADDRESS], link: null }],
    facts: [MAILED], lines: { [MAILED.id]: LINE }, named: { [MAILED.id]: [["Mira Kestrel", `email:${ADDRESS}`]] },
  };
  const placeholdersIn = (value: unknown) => new Set(JSON.stringify(value).match(/\[\[(?:Person|Email) \d+\]\]/gu));

  it("at all, through one grant: the addressee the mail's line names and the first name its body opens with are one placeholder in search, in the record read whole and in the day read", async () => {
    const home = homeOf(MAILS);
    const reader = agent("all");
    const found = await readOf(home, reader, "/v1/search", bodyOf(reader, { query: "invoice", lists: ["record"] }));
    expect(found.status, JSON.stringify(found.value)).toBe(200);
    const hit = (found.value.record.hits as { ref: string; family: string; snippet: string }[]).find((each) => each.family === "mail")!;
    const named = [...placeholdersIn(hit)];
    expect(named).toHaveLength(1);
    const [mira] = named as [string];
    expect(mira).toMatch(PERSON);
    const opened = await readOf(home, reader, "/v1/read", bodyOf(reader, { ref: hit.ref }));
    expect(opened.status, JSON.stringify(opened.value)).toBe(200);
    expect(opened.value).toMatchObject({ what: "record", to: [mira], text: `Hi ${mira}, please find attached the invoice for the shed.` });
    expect(placeholdersIn(opened.value)).toEqual(new Set([mira]));
    const day = await readOf(home, reader, "/v1/read", bodyOf(reader, { from: DAY, to: DAY }));
    expect(day.status, JSON.stringify(day.value)).toBe(200);
    const line = (day.value.lines as { text: string }[]).find((each) => each.text.includes(SUBJECT))!;
    expect(line.text).toBe(`Mail from You to ${mira}: “${SUBJECT}” — Hi ${mira}, please find attached the invoice for the shed.`);
    const said = JSON.stringify([found, opened, day]);
    for (const word of ["Mira", "Kestrel", ADDRESS]) expect(said).not.toContain(word);
  });
});
