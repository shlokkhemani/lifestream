import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { civilDay, dayBounds, openHomeFolder, type DaySettings, type OpenView } from "@lifestreamprotocol/core";
import type { RunnerListing } from "@lifestreamprotocol/model";
import type { LazyFrame, ScreenFrameRead } from "@lifestreamprotocol/families";
import { startHome } from "./home.js";
import { mintPrincipal } from "./principals.js";
import { checkoutProgram } from "./programs.js";
import { markingProgress, screenQueue } from "./marking.js";
import { Refusal } from "./refusal.js";
import { DIM } from "./screen-scan-wasm.js";
import { readScreen, ScreenIndex, screenFileOf, type ScreenFrame, type ScreenSegment, type ScreenSource } from "./screen-index.js";
import { controlLabel, frameLines, meaningMatches, meaningStanding, screenGroups, screenReads, SEARCH_STATE_ROUTE, windowsIn } from "./screen-reads.js";
import { VectorScan } from "./screen-vectors.js";
import { searchFileOf } from "./search-index.js";
import type { Settings } from "./settings.js";
import { screenFamily } from "./test/fakes.js";
import { askHome } from "./socket.js";
import { artifact, FAKES, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { doorHere } from "./test/harness-door.js";
import { REPO } from "./test/support.js";
import { testSocket } from "./test/folder.js";

const RUNNER = "runner-macbook-pro-0001";
const MODEL = "embeddinggemma-2-q8-512";
const ON = { unit: RUNNER, file: MODEL, power: "plugged-idle" } as const;
const OFF = null;
const STATED = { power: "plugged-idle" } as const;
const DAYS: DaySettings = { zone: "UTC", day_start_hour: 4 };
const T0 = Date.parse("2026-11-02T06:00:00Z");
const DAY = 86_400_000;
const SEG = 300_000;
const scratch = mkdtempSync(join(tmpdir(), "lifestream-screen-reads-"));
const homes: string[] = [];
const scan = new VectorScan(openHomeFolder(scratch));
afterAll(async () => {
  await scan.close();
  rmSync(scratch, { recursive: true, force: true });
  for (const root of homes) removeRoot(root);
});
let files = 0;

const WORDS = ["amber", "basil", "cobalt", "delta", "ember", "fjord", "garnet", "harbor", "indigo", "juniper", "kelp", "lumen", "meadow", "nectar", "onyx", "pepper"];

function sentence(seed: number): string {
  return `Example post ${seed}: ${Array.from({ length: 12 }, (_, i) => WORDS[(seed * 5 + i * 3) % WORDS.length]).join(" ")}.`;
}

function segment(from: number, seed: number): ScreenSegment {
  const frames: ScreenFrame[] = Array.from({ length: 5 }, (_, f) => ({
    t: from + f * 4_000, app: "Example Browser", site: "www.example.com", title: `Example Page ${seed}`, display: "1",
    lines: [sentence(seed * 100 + f), sentence(seed * 100 + f + 50)],
  }));
  return { machine: "mac-0001", version: "v1", start_ms: from, frames };
}

function sourceOf(held: ScreenSegment[]): ScreenSource {
  return { segments: (machine, day) => held.filter((each) => each.machine === machine && civilDay(each.start_ms, DAYS) === day) };
}

function vectorFor(text: string): Float32Array {
  const vector = new Float32Array(DIM);
  let seed = createHash("sha256").update(text).digest();
  for (let i = 0; i < DIM; i++) {
    if (i % 32 === 0 && i > 0) seed = createHash("sha256").update(seed).digest();
    vector[i] = seed[i % 32]! / 127.5 - 1;
  }
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
}

function built(held: ScreenSegment[], land: boolean, vectorOf: (text: string) => Float32Array = vectorFor): { file: string; texts: Map<string, string> } {
  const file = join(scratch, `f${++files}`, "screen.db");
  const build = ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: DAYS, meaning: MODEL }, () => true);
  build.apply(held, sourceOf(held));
  build.finish();
  const index = ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: DAYS, meaning: MODEL }, () => true);
  const queued = index.queued(10_000);
  if (land) index.land({ model: MODEL, generation: index.generation() }, queued.map((each) => ({ textHash: each.textHash, vector: vectorOf(each.text) })));
  index.close();
  return { file, texts: new Map(queued.map((each) => [each.text, each.textHash])) };
}

function toward(from: Float32Array, text: string, by: number): Float32Array {
  const own = vectorFor(text);
  const mixed = from.map((value, i) => value * (1 - by) + own[i]! * by);
  const norm = Math.hypot(...mixed);
  return mixed.map((value) => value / norm);
}

const BLOCK_ON = (day: string) => new RegExp(`^block:mac-0001/${day}/\\d+$`, "u");

async function opened<T>(file: string, read: (db: Database.Database) => T | Promise<T>): Promise<T> {
  const db = readScreen(openHomeFolder(dirname(file)), file)!;
  try {
    return await read(db);
  } finally {
    db.close();
  }
}

describe("the meaning list", () => {
  const held = [segment(T0, 1), segment(T0 + SEG, 2), segment(T0 + 3 * DAY, 3)];
  const { file, texts } = built(held, true);
  const ask = (text: string, range: { from_ms?: number; to_ms?: number } = {}) => opened(file, (db) =>
    meaningMatches(db, file, scan, { vector: vectorFor(text), model: MODEL, limit: 5, from_ms: T0 - DAY, to_ms: T0 + 10 * DAY, ...range }));

  it("answers the block the ask is first, at its minute, named by its occurrence as a word match is", async () => {
    const block = sentence(203);
    expect(texts.has(block)).toBe(true);
    const matches = await ask(block);
    expect(matches).toHaveLength(5);
    expect(matches[0]).toMatchObject({
      rank: 1, evidence: expect.stringMatching(BLOCK_ON("2026-11-02")), excerpt: block, app: "Example Browser", site: "example.com", window: "Example Page 2",
      machine: "mac-0001", time: "2026-11-02 06:05", time_precision: "minute", ref: `screen:mac-0001/${T0 + SEG + 3 * 4_000}`,
    });
    expect(matches.map((each) => each.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("answers a day chunk over its range, its excerpt a line of its first row, its evidence that row", async () => {
    const chunk = await opened(file, (db) => db.prepare("SELECT q.text_hash FROM screen_unit u JOIN screen_vector q ON q.text_hash = u.text_hash WHERE u.kind = 'chunk' AND u.day = '2026-11-02' LIMIT 1").pluck().get() as string);
    const text = [...texts].find(([, hash]) => hash === chunk)![0];
    const [first] = await ask(text);
    expect(first).toMatchObject({ time_precision: "range", machine: "mac-0001", day: "2026-11-02" });
    expect(first!.evidence).toMatch(/^row:\d+$/u);
    expect(first!.time).toMatch(/^2026-11-02 06:0\d – 06:\d\d$/u);
    expect(text.split("\n")).toContain(first!.excerpt);
  });

  it("cuts a chunk's excerpt from its own lines, though its row holds another chunk's longer ones", async () => {
    const line = (n: number) => `Row line ${n} ${"with example words ".repeat(30 - n).trim()}`;
    const one: ScreenSegment = { machine: "mac-0001", version: "v1", start_ms: T0, frames: [
      { t: T0, app: "Example Reader", site: null, title: "Example Book", display: "1", lines: Array.from({ length: 20 }, (_, n) => line(n)) },
    ] };
    const copy = built([one], true);
    const hashes = await opened(copy.file, (db) => db.prepare("SELECT text_hash FROM screen_unit WHERE kind = 'chunk' ORDER BY unit").pluck().all() as string[]);
    expect(hashes).toHaveLength(2);
    const second = [...copy.texts].find(([, hash]) => hash === hashes[1])![0];
    const [first] = await opened(copy.file, (db) => meaningMatches(db, copy.file, scan, { vector: vectorFor(second), model: MODEL, limit: 1, from_ms: T0 - DAY, to_ms: T0 + DAY }));
    expect(first!.evidence).toMatch(/^row:\d+$/u);
    expect(second.split("\n")).toContain(first!.source);
  });

  it("names nothing outside the range asked, though the scan reads the whole month", async () => {
    const late = sentence(301);
    expect((await ask(late))[0]!.evidence).toMatch(BLOCK_ON("2026-11-05"));
    const day = dayBounds("2026-11-02", DAYS);
    const matches = await ask(late, { from_ms: day.start_ms, to_ms: day.end_ms });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((each) => each.day === "2026-11-02")).toBe(true);
  });

  it("finds a day's best texts past 40 nearer ones on other days: the range keeps its rows before the top k", async () => {
    const ask = vectorFor("the ask");
    const near = [segment(T0 + DAY, 20), segment(T0 + DAY + SEG, 21), segment(T0 + DAY + 2 * SEG, 22), segment(T0 + DAY + 3 * SEG, 23), segment(T0 + DAY + 4 * SEG, 24)];
    const own = [segment(T0, 25)];
    const ownTexts = new Set(own.flatMap((each) => each.frames.flatMap((frame) => frame.lines)));
    const copy = built([...own, ...near], true, (text) => toward(ask, text, text.split("\n").some((line) => ownTexts.has(line)) ? 0.6 : 0.2));
    const nearer = await opened(copy.file, (db) => db.prepare("SELECT count(DISTINCT text_hash) FROM screen_unit WHERE day = '2026-11-03'").pluck().get() as number);
    expect(nearer).toBeGreaterThan(40);
    const day = dayBounds("2026-11-02", DAYS);
    const matches = await opened(copy.file, (db) => meaningMatches(db, copy.file, scan, { vector: ask, model: MODEL, limit: 5, from_ms: day.start_ms, to_ms: day.end_ms }));
    expect(matches).toHaveLength(5);
    expect(matches.every((each) => each.day === "2026-11-02")).toBe(true);
  });

  it("finds a text the range's day names though its vector is stored in an earlier month, and its evidence is that day's", async () => {
    const october = Date.parse("2026-10-30T06:00:00Z");
    const first = segment(october, 30);
    const copy = built([first], true);
    const again: ScreenSegment = { ...segment(T0, 30), start_ms: T0, frames: first.frames.map((frame, f) => ({ ...frame, t: T0 + f * 4_000 })) };
    const index = ScreenIndex.write(openHomeFolder(dirname(copy.file)), copy.file, { days: DAYS, meaning: MODEL }, () => true);
    index.apply([again], sourceOf([first, again]));
    expect(index.queueLength()).toBe(0);
    index.close();
    const text = sentence(3000);
    const inNovember = dayBounds("2026-11-02", DAYS);
    const november = await opened(copy.file, (db) => meaningMatches(db, copy.file, scan, { vector: vectorFor(text), model: MODEL, limit: 1, from_ms: inNovember.start_ms, to_ms: inNovember.end_ms }));
    expect(november[0]).toMatchObject({ excerpt: text, day: "2026-11-02", evidence: expect.stringMatching(BLOCK_ON("2026-11-02")) });
    const inOctober = dayBounds("2026-10-30", DAYS);
    const before = await opened(copy.file, (db) => meaningMatches(db, copy.file, scan, { vector: vectorFor(text), model: MODEL, limit: 1, from_ms: inOctober.start_ms, to_ms: inOctober.end_ms }));
    expect(before[0]).toMatchObject({ excerpt: text, day: "2026-10-30", evidence: expect.stringMatching(BLOCK_ON("2026-10-30")) });
    expect(before[0]!.evidence).not.toBe(november[0]!.evidence);
    expect(before[0]!.evidence).not.toContain(copy.texts.get(text)!);
  });

  it("names no text an erasure took", async () => {
    const copy = built(held, true);
    const gone = sentence(102);
    ScreenIndex.erase(openHomeFolder(dirname(copy.file)), copy.file, [{ machine: "mac-0001", from_ms: T0, to_ms: T0 + 2 * SEG }], sourceOf([held[2]!]));
    const matches = await opened(copy.file, (db) => meaningMatches(db, copy.file, scan, { vector: vectorFor(gone), model: MODEL, limit: 5, from_ms: T0 - DAY, to_ms: T0 + 10 * DAY }));
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((each) => each.day !== "2026-11-02")).toBe(true);
  });
});

describe("meaning's standing", () => {
  it("is available only while on for the file's own model, and states what the job last waited on only while texts wait", async () => {
    const held = [segment(T0 - DAY, 4), segment(T0, 5)];
    const waiting = built(held, false);
    const index = ScreenIndex.write(openHomeFolder(dirname(waiting.file)), waiting.file, { days: DAYS, meaning: MODEL }, () => true);
    index.setWaits({ waits: "battery", line: "Waiting for Example Mac to be plugged in" });
    index.close();
    await opened(waiting.file, (db) => {
      const words = db.prepare("SELECT max(end_ms) FROM screen_row").pluck().get() as number;
      expect(meaningStanding(db, OFF)).toEqual({ available: false, words_indexed_through: words, waits: null });
      expect(meaningStanding(db, { ...ON, file: "other-model" })).toEqual({ available: false, words_indexed_through: words, waits: null });
      expect(meaningStanding(db, ON)).toEqual({ available: true, words_indexed_through: words, waits: { waits: "battery", line: "Waiting for Example Mac to be plugged in" } });
    });
    const landed = built(held, true);
    const caught = ScreenIndex.write(openHomeFolder(dirname(landed.file)), landed.file, { days: DAYS, meaning: MODEL }, () => true);
    caught.setWaits({ waits: "battery", line: "Waiting for Example Mac to be plugged in" });
    caught.close();
    await opened(landed.file, (db) => {
      const words = db.prepare("SELECT max(end_ms) FROM screen_row").pluck().get() as number;
      expect(meaningStanding(db, ON)).toEqual({ available: true, words_indexed_through: words, waits: null });
    });
  });
});

describe("a screen file a publication holds", () => {
  const lock = (file: string): Database.Database => {
    const held = new Database(file, { fileMustExist: true, timeout: 0 });
    held.pragma("locking_mode = EXCLUSIVE");
    expect(held.pragma("journal_mode = MEMORY", { simple: true })).toBe("memory");
    held.exec("UPDATE meta SET value = value WHERE name = 'format'");
    return held;
  };
  const whileLocked = async <T>(file: string, work: () => T | Promise<T>): Promise<{ outcome: { value: T } | { code: string }; closed: boolean }> => {
    const held = lock(file);
    const opened = new Set<Database.Database>();
    const prepare = Database.prototype.prepare;
    vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, ...args: Parameters<typeof prepare>) {
      if (this !== held && this.name === file) opened.add(this);
      return prepare.apply(this, args);
    });
    try {
      const outcome = await Promise.resolve().then(work).then((value) => ({ value }), (error: unknown) => {
        if (error instanceof Refusal) return { code: error.code };
        throw error;
      });
      return { outcome, closed: opened.size > 0 && [...opened].every((db) => !db.open) };
    } finally {
      vi.restoreAllMocks();
      held.close();
    }
  };

  const stateOf = (file: string) => {
    const routes = screenReads({
      folder: openHomeFolder(dirname(file)),
      settings: () => ({ defaults: { search: null }, search: { power: "plugged-idle" } }) as unknown as Settings, blobs: undefined as never,
      families: [screenFamily({ index: true })], viewed: (work) => work({ position: () => ({ seq: 1 }), through: 1 } as unknown as OpenView), file: () => file, record: () => join(dirname(file), "index.db"), waitMs: 50,
    });
    return () => routes.get(SEARCH_STATE_ROUTE)!({
      url: SEARCH_STATE_ROUTE, now_ms: T0 + DAY, held: { machine: "mac-0001", sites: [], present: [], refused: [], stated: {} as never },
    });
  };

  it("answers search's state 503 NOT_NOW and the privacy page no progress, never a failure, each connection closed", async () => {
    const { file } = built([segment(T0, 7)], false);
    const search = stateOf(file);
    expect(await whileLocked(file, search)).toEqual({ outcome: { code: "NOT_NOW" }, closed: true });
    const progress = () => markingProgress([screenQueue(openHomeFolder(dirname(file)), file, 50)], { id: "store-test" }, null);
    expect(await whileLocked(file, progress)).toEqual({ outcome: { value: null }, closed: true });
    expect(progress()).toMatchObject({ total: expect.any(Number) });
    expect((await search()).status).toBe(200);
  });

  it("reads a rebuild's progress with the screen file let go, so a publication waiting out the file's readers never waits on the route", async () => {
    const { file } = built([segment(T0, 7)], false);
    const rebuild = ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: DAYS, meaning: MODEL }, () => false);
    const building = join(dirname(file), "screen.building.db");
    const onFile = new Set<Database.Database>();
    const heldAtBuilding: number[] = [];
    const prepare = Database.prototype.prepare;
    vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, ...args: Parameters<typeof prepare>) {
      if (this.name === file) onFile.add(this);
      if (this.name === building) heldAtBuilding.push([...onFile].filter((db) => db.open).length);
      return prepare.apply(this, args);
    });
    let reply;
    try {
      reply = await stateOf(file)();
    } finally {
      vi.restoreAllMocks();
      rebuild.close();
    }
    expect({ status: reply.status, building: JSON.parse(reply.body as string).screen.building }).toEqual({ status: 200, building: { done: 0, of: 1 } });
    expect({ read: onFile.size > 0 && heldAtBuilding.length > 0, held: heldAtBuilding.filter((count) => count > 0) }).toEqual({ read: true, held: [] });
  });
});

describe("a stretch's windows", () => {
  it("each window once a day, its time on screen summed over its segments, its start its first segment's cut to the stretch, read from the index alone", async () => {
    const { file } = built([segment(T0, 1), segment(T0 + SEG, 1), segment(T0 + 2 * SEG, 2)], false);
    await opened(file, (db) => {
      const rows = db.prepare(`SELECT k.name, count(*) AS rows, sum(r.tenths) AS tenths, max(r.end_ms) AS end_ms FROM screen_row r JOIN screen_key k ON k.id = r.key GROUP BY k.name ORDER BY k.name`)
        .all() as { name: string; rows: number; tenths: number; end_ms: number }[];
      expect(rows.map((row) => row.rows)).toEqual([2, 1]);
      const windows = windowsIn(db, "mac-0001", T0 + 10_000, T0 + 3 * SEG);
      expect(windows).toEqual([
        { machine: "mac-0001", day: "2026-11-02", app: "Example Browser", site: expect.any(String), name: rows[0]!.name, start_ms: T0 + 10_000, end_ms: rows[0]!.end_ms, tenths: rows[0]!.tenths },
        { machine: "mac-0001", day: "2026-11-02", app: "Example Browser", site: expect.any(String), name: rows[1]!.name, start_ms: T0 + 2 * SEG, end_ms: rows[1]!.end_ms, tenths: rows[1]!.tenths },
      ]);
      expect(windowsIn(db, "mac-0001", T0, T0 + SEG).map((window) => [window.name, window.start_ms, window.end_ms <= T0 + SEG])).toEqual([[rows[0]!.name, T0, true]]);
      expect(windowsIn(db, "mac-0001", T0 + 2 * SEG + 60_000, T0 + 3 * SEG), "a window whose segment ended before the stretch").toEqual([]);
      expect(windowsIn(db, "mac-0002", T0, T0 + 3 * SEG)).toEqual([]);
    });
  });
});

describe("a stretch's lines", () => {
  const frame = (t: number, { lines = [], ocr = [], ...over }: Partial<ScreenFrameRead>): LazyFrame => ({
    t, app: "Example Browser", title: "Example Page", site: "example.com", display: "1", read: "v", ...over, text: () => ({ lines, ocr }),
  });

  it("drops a control's short label and an empty field's cursor, and reads OCR only for a frame with no accessibility line", () => {
    expect(controlLabel("[Button] Send")).toBe(true);
    expect(controlLabel("[Link] Home <https://example.com/>")).toBe(true);
    expect(controlLabel("[Link] Read the whole story about the rug <https://example.com/rug>")).toBe(false);
    expect(controlLabel("▶ cursor here: empty TextField “Search”")).toBe(true);
    expect(controlLabel("A plain line of text")).toBe(false);
    expect(frameLines({ lines: ["[Button] Send", "The meeting moved to Thursday at noon."], ocr: ["OCR words"] })).toEqual(["The meeting moved to Thursday at noon."]);
    expect(frameLines({ lines: [], ocr: ["OCR words"] })).toEqual(["OCR words"]);
    expect(frameLines({ lines: ["[Button] Send"], ocr: ["OCR words"] })).toEqual([]);
  });

  it("groups one window in a row, folds a typed line into its latest state, drops a line inside a longer one", () => {
    const typing = "A message being typed into the box, word by word, until it is";
    const frames = [
      frame(T0, { lines: ["Short words", `${typing} do`] }),
      frame(T0 + 2_000, { lines: ["Short words", `${typing} done.`, "Short words and more of them"] }),
      frame(T0 + 4_000, { app: "Example Editor", title: "Notes", site: null, lines: ["Editor line"] }),
      frame(T0 + 6_000, { lines: ["Back on the page"] }),
    ];
    const groups = screenGroups("mac-0001", frames, { from_ms: T0, to_ms: T0 + 60_000 });
    expect(groups.map((group) => [group.app, group.window, group.lines.map((line) => [line.t_ms - T0, line.text])])).toEqual([
      ["Example Browser", "Example Page", [[2_000, `${typing} done.`], [2_000, "Short words and more of them"]]],
      ["Example Editor", "Notes", [[4_000, "Editor line"]]],
      ["Example Browser", "Example Page", [[6_000, "Back on the page"]]],
    ]);
    expect(groups[0]).toMatchObject({ from_ms: T0, to_ms: T0 + 4_000 });
  });

  it("with new_only keeps the lines the index says are new, every line past its reach, and no window left with none", () => {
    const frames = [frame(T0, { lines: ["Seen this morning already"] }), frame(T0 + 2_000, { lines: ["Seen this morning already", "New in the stretch"] }), frame(T0 + 4_000, { app: "Example Editor", title: "Notes", site: null, lines: ["Old note"] })];
    const groups = screenGroups("mac-0001", frames, {
      from_ms: T0, to_ms: T0 + 60_000,
      isNew: (_machine, key, line, t) => t >= T0 + 3_000 ? undefined : line === "New in the stretch" && key.site === "example.com",
    });
    expect(groups.map((group) => group.lines.map((line) => line.text))).toEqual([["New in the stretch"], ["Old note"]]);
    expect(screenGroups("mac-0001", frames, { from_ms: T0, to_ms: T0 + 60_000, isNew: () => false })).toEqual([]);
  });
});

describe("the screen routes end to end", () => {
  it("answer search's state, the screen's list by meaning through the runner, and with meaning off, words alone and no error", async () => {
    const SOURCE = "screen:local:mac-0001";
    const TOKEN = "synthetic-token-screen-reader".padEnd(43, "r");
    const DRIVE = "synthetic-token-screen-drive".padEnd(43, "x");
    const root = makeRoot("lifestream-screen-reads-", { sources: { [SOURCE]: "fake-rows" }, settings: { "families.screen": { index: true }, "model.defaults.search": `runner:${RUNNER}/${MODEL}` } });
    homes.push(root);
    mintPrincipal(openHomeFolder(root), { unit: "reader", scopes: ["read"], sources: [], token: TOKEN, now_ms: 0 });
    mintPrincipal(openHomeFolder(root), { unit: "test-drive", scopes: ["drive"], token: DRIVE, now_ms: 0 });
    const state = (name: string, value: string) => {
      const path = join(root, `runner-${name}`);
      writeFileSync(path, value);
      return path;
    };
    const door = await doorHere(root, { registry: FAKES });
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    const passFile = join(process.env.LIFESTREAM_MACHINE_DIR!, "runner", "door-token");
    const program = spawn(process.execPath, [...checkoutProgram(join(REPO, "packages", "runner", "test", "fake-runner.ts")),
      "--door", door.url, "--pass", passFile, "--power", state("power", "mains"), "--idle", state("idle", "600"), "--thermal", state("thermal", "nominal")], { cwd: REPO, stdio: ["ignore", "ignore", "pipe"] });
    const said: string[] = [];
    program.stderr!.on("data", (chunk: Buffer) => said.push(chunk.toString("utf8")));
    const exited = new Promise<void>((resolve) => program.once("exit", () => resolve()));
    const file = screenFileOf(searchFileOf(root, process.env.LIFESTREAM_MACHINE_DIR!));
    const count = (sql: string): number | undefined => {
      if (!existsSync(file)) return undefined;
      const db = new Database(file, { readonly: true, timeout: 10_000 });
      try {
        return db.prepare(sql).pluck().get() as number;
      } catch {
        return undefined;
      } finally {
        db.close();
      }
    };
    const get = async (path: string, token = TOKEN) => {
      const response = await fetch(`${door.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const answers: Record<string, unknown> = {};
    try {
      await until("the meaning model's file ready on the runner", async () => {
        const { runners } = (await get("/v1/runners", DRIVE)).body as { runners: RunnerListing[] };
        return runners.find((each) => each.unit === RUNNER)?.files.find((each) => each.id === MODEL)?.state === "ready";
      }).catch((error: Error) => { throw new Error(`${error.message}; the runner said ${said.join("")}`); });
      const first = await get("/v1/search/state");
      expect(first.status).toBe(200);
      expect(first.body.screen).toMatchObject({ ...STATED, words_indexed_through: null, vectors_bytes: 0, queued: 0, waits: null, embedded: 0, named: 0 });
      const POST = "A long post about the zircon lighthouse and its keeper, who reads every evening by the sea.";
      const NOTE = "Notes on the harbor walk: bring the brass compass, and leave before the tide turns.";
      const frame = (key: string, at: number, ...lines: string[]) => ({
        kind: "frame", key, at,
        content: {
          at, status: "captured", displayID: 1, application: { name: "Example Editor", bundleID: "com.example.editor" },
          frontWindow: { windowID: 11 }, windows: [{ windowID: 11, title: "Notes" }],
          accessibility: { nodes: lines.map((value) => ({ depth: 1, role: "AXStaticText", value })) }, ocr: [],
        },
      });
      const at = Date.parse("2026-09-28T06:00:00Z");
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [
        frame("f1", at, POST), frame("f2", at + 4_000, POST, NOTE), frame("f3", at + SEG, NOTE),
      ] as never });
      await until("both segments indexed and every text embedded", () => {
        const units = count("SELECT count(DISTINCT text_hash) FROM screen_unit") ?? 0;
        return (count("SELECT count(DISTINCT segment) FROM screen_row") ?? 0) >= 2 && units > 0
          && count("SELECT count(*) FROM screen_vector") === units && count("SELECT count(*) FROM screen_embed_queue") === 0;
      }).catch((error: Error) => {
        const stood = { units: count("SELECT count(DISTINCT text_hash) FROM screen_unit"), vectors: count("SELECT count(*) FROM screen_vector"), queued: count("SELECT count(*) FROM screen_embed_queue") };
        const runs = readHome(root, (db) => db.prepare("SELECT counts FROM runs WHERE kind = 'index' AND subject = 'screen' ORDER BY id DESC LIMIT 3").all());
        throw new Error(`${error.message}; the file ${JSON.stringify(stood)}; runs ${JSON.stringify(runs)}; the runner said ${said.join("")}`);
      });

      const reached = await get("/v1/search/state");
      answers.state = reached.body;
      const minute = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
      const units = count("SELECT count(DISTINCT text_hash) FROM screen_unit")!;
      expect(reached.body.screen).toEqual({
        ...STATED, as_of: expect.any(String), building: null, words_indexed_through: minute(count("SELECT max(end_ms) FROM screen_row")!),
        bytes: expect.any(Number), vectors_bytes: expect.any(Number), queued: 0, waits: null, waits_line: null, embedded: units, named: units, skipped: 0,
      });
      expect(reached.body.screen.bytes).toBeGreaterThan(0);
      expect(reached.body.screen.vectors_bytes).toBeGreaterThan(0);
      expect((await get("/v1/search/state?q=x")).status).toBe(422);

      const day = "2026-09-28";
      const listed = async (query: string) => {
        const answer = await get(`/v1/search?lists=screen&query=${encodeURIComponent(query)}&from=${day}&to=${day}`);
        expect(answer.status).toBe(200);
        return answer.body.screen as { meaning: string; hits: { app: string; reason: string }[] };
      };
      const meaning = await listed("a lighthouse keeper");
      answers.meaning = meaning;
      expect(meaning.meaning).toBe("on");
      expect(meaning.hits.length).toBeGreaterThan(0);
      for (const hit of meaning.hits) expect(hit).toMatchObject({ app: "Example Editor" });

      await askHome(testSocket(root), "models", ["default", "search", "none"]);
      await until("the meaning dropped from the file", () => count("SELECT count(*) FROM meta WHERE name = 'meaning' AND value = 'false'") === 1);
      const off = await listed("a lighthouse keeper");
      answers.off = off;
      expect(off.meaning).toBe("off");
      expect(off.hits.every((hit) => hit.reason !== "meaning")).toBe(true);
      await until("the meaning vectors deleted", async () => (await get("/v1/search/state")).body.screen.vectors_bytes === 0);
      const gone = await get("/v1/search/state");
      answers.state_off = gone.body;
      expect(gone.body.screen).toMatchObject({ ...STATED, words_indexed_through: reached.body.screen.words_indexed_through, queued: 0, embedded: 0, named: 0, skipped: 0 });
      artifact(root, "screen-reads", answers);
      const drawn = { state: reached.body.screen, state_off: gone.body.screen };
      if (process.env.LIFESTREAM_FIXTURES === "write") writeFileSync(PAGES_FIXTURE, `${JSON.stringify(drawn, null, 2)}\n`);
      const held = existsSync(PAGES_FIXTURE) ? JSON.parse(readFileSync(PAGES_FIXTURE, "utf8")) as unknown : null;
      expect(shapeOf(held), "dashboard/test/fixtures/screen-door.json is these answers: LIFESTREAM_FIXTURES=write writes it").toEqual(shapeOf(drawn));
    } finally {
      program.kill("SIGTERM");
      await exited;
      await home.stop();
      await door.stop();
    }
  });
});

const PAGES_FIXTURE = join(REPO, "dashboard", "test", "fixtures", "screen-door.json");

function shapeOf(value: unknown): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])];
  if (typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shapeOf((value as Record<string, unknown>)[key])]));
  return typeof value;
}
