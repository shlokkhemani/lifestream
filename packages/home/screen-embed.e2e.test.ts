import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { civilDay, openHomeFolder, type DaySettings } from "@lifestreamprotocol/core";
import { embedAskOf, vectorText, type RunnerEnded, type RunnerFile, type RunnerListing, type RunnerPlaced } from "@lifestreamprotocol/model";
import type { DriveHalf } from "./detector.js";
import { admission, IDLE_S, openEmbedder } from "./embedder.js";
import { startHome } from "./home.js";
import { mintPrincipal } from "./principals.js";
import { checkoutProgram } from "./programs.js";
import { DIM } from "./screen-scan-wasm.js";
import { meaningCounts, meaningSettingsOf, readScreen, ScreenIndex, screenFileOf, waitsOf, type ScreenFrame, type ScreenSegment, type ScreenSource } from "./screen-index.js";
import { MODELS_META, type StoredModels } from "./models.js";
import { embedPass } from "./screen-job.js";
import { searchFileOf } from "./search-index.js";
import { askHome } from "./socket.js";
import { artifact, FAKES, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { doorHere } from "./test/harness-door.js";
import { REPO } from "./test/support.js";
import { testSocket } from "./test/folder.js";

const RUNNER = "runner-macbook-pro-0001";
const DRIVE = "synthetic-token-test-drive".padEnd(43, "x");
const MODEL = "embeddinggemma-2-q8-512";
const DAYS: DaySettings = { zone: "UTC", day_start_hour: 4 };
const T0 = Date.parse("2026-11-02T06:00:00Z");
const DAY = 86_400_000;
const SEG = 300_000;
const scratch = mkdtempSync(join(tmpdir(), "lifestream-screen-embed-"));
const homes: string[] = [];
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const root of homes) removeRoot(root);
});
let files = 0;

const WORDS = ["amber", "basil", "cobalt", "delta", "ember", "fjord", "garnet", "harbor", "indigo", "juniper", "kelp", "lumen", "meadow", "nectar", "onyx", "pepper"];

function sentence(seed: number): string {
  return `Example post ${seed}: ${Array.from({ length: 12 }, (_, i) => WORDS[(seed * 5 + i * 3) % WORDS.length]).join(" ")}.`;
}

function segments(start: number, count: number, seed: number): ScreenSegment[] {
  return Array.from({ length: count }, (_, s) => {
    const from = start + s * SEG;
    const frames: ScreenFrame[] = Array.from({ length: 5 }, (_, f) => ({
      t: from + f * 4_000, app: "Example Browser", site: "www.example.com", title: `Example Page ${seed}`, display: "1",
      lines: [sentence(seed * 1_000 + s * 10 + f), sentence(seed * 1_000 + s * 10 + f + 500)],
    }));
    return { machine: "mac-0001", version: "v1", start_ms: from, frames };
  });
}

function sourceOf(held: ScreenSegment[]): ScreenSource {
  return { segments: (machine, day) => held.filter((segment) => segment.machine === machine && civilDay(segment.start_ms, DAYS) === day) };
}

function indexOf(held: ScreenSegment[], model = MODEL, settings?: string): { file: string; index: ScreenIndex } {
  const file = join(scratch, `f${++files}`, "screen.db");
  const build = ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: DAYS, meaning: model }, () => true);
  build.apply(held, sourceOf(held));
  build.finish();
  return { file, index: ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: DAYS, meaning: model, ...(settings === undefined ? {} : { settings }) }, () => true) };
}

function vectorFor(text: string): Float32Array {
  const vector = new Float32Array(DIM);
  vector[[...text].reduce((sum, char) => sum + char.charCodeAt(0), 0) % DIM] = 1;
  return vector;
}

const ready = (id: string): RunnerFile => ({ id, name: id, input: ["text"], output: "vectors", tools: false, context_tokens: 2_048, thinking: [], bytes: 1, languages: [], memory_gb: 8, state: "ready", fetched_bytes: 1, failure: null });

const listing = (over: Partial<RunnerListing> = {}): RunnerListing => ({
  unit: RUNNER, name: "Synthetic Mac", version: "3", boot: "boot-a", slots: 1, power: "mains", idle_s: 600, thermal: "nominal", memory_gb: 16, running: [],
  files: [ready(MODEL)], present: true, ...over,
});

function driveOf(state: { listing: RunnerListing; answer?: (placed: RunnerPlaced, texts: readonly string[]) => Promise<RunnerEnded> | RunnerEnded }): DriveHalf & { placed: string[][]; listed: number } {
  const drive = {
    placed: [] as string[][],
    listed: 0,
    async list() {
      drive.listed++;
      return [state.listing];
    },
    async place(placed: RunnerPlaced) {
      const { texts } = embedAskOf(placed.input)!;
      drive.placed.push([...texts]);
      return state.answer === undefined ? answered(placed, texts) : state.answer(placed, texts);
    },
  };
  return drive;
}

function answered(placed: RunnerPlaced, texts: readonly string[]): RunnerEnded {
  return { ok: { text: JSON.stringify({ dimensions: DIM, vectors: texts.map((text) => vectorText(vectorFor(text))) }), model: placed.model } };
}

const embedderOf = (drive: DriveHalf) => openEmbedder({ meaning: () => ({ unit: RUNNER, file: MODEL }), drive });
const count = (file: string, table: string): number => {
  const db = new Database(file, { readonly: true });
  try {
    return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
};

describe("when a batch may go", () => {
  it("only while the runner is present, its file ready, its machine on mains or with no battery, idle two minutes and cool; an ask's only while its file is ready", () => {
    const go = (over: Partial<RunnerListing>, role: "document" | "query" = "document") => admission([listing(over)], RUNNER, MODEL, role);
    expect(go({})).toEqual({ go: true });
    expect(go({ power: null })).toEqual({ go: true });
    expect(go({ power: "battery" })).toMatchObject({ go: false, why: "battery" });
    expect(go({ idle_s: IDLE_S - 1 })).toMatchObject({ go: false, why: "in_use" });
    expect(go({ idle_s: null })).toMatchObject({ go: false, why: "in_use" });
    expect(go({ thermal: "elevated" })).toMatchObject({ go: false, why: "warm" });
    expect(go({ thermal: null })).toMatchObject({ go: false, why: "warm" });
    expect(go({ present: false })).toMatchObject({ go: false, why: "no_runner" });
    expect(admission([], RUNNER, MODEL, "document")).toMatchObject({ go: false, why: "no_runner" });
    expect(go({ files: [{ ...ready(MODEL), state: "fetching" }] })).toMatchObject({ go: false, why: "not_ready" });
    expect(go({ files: [] })).toMatchObject({ go: false, why: "not_ready" });
    expect(go({ power: "battery", idle_s: 0, thermal: "elevated" }, "query")).toEqual({ go: true });
  });
});

describe("the screen job's embedding pass", () => {
  it("places no batch while the runner waits (battery, in use, warm, away, file not ready), the queue as it was, the wait kept for the routes", async () => {
    const { file, index } = indexOf(segments(T0, 2, 1));
    const queued = index.queueLength();
    expect(queued).toBeGreaterThan(0);
    const kept = () => {
      const db = readScreen(openHomeFolder(dirname(file)), file)!;
      try {
        return waitsOf(db);
      } finally {
        db.close();
      }
    };
    const cases = [
      [{ power: "battery" as const }, "battery"], [{ idle_s: 30 }, "in_use"], [{ thermal: "elevated" as const }, "warm"], [{ present: false }, "no_runner"],
      [{ files: [{ ...ready(MODEL), state: "fetching" as const }] }, "downloading"],
    ] as const;
    for (const [over, word] of cases) {
      const drive = driveOf({ listing: listing(over) });
      const pass = await embedPass(index, embedderOf(drive), () => true);
      expect(pass).toMatchObject({ embedded: 0, more: false, waits: word });
      expect(kept()).toMatchObject({ waits: word, line: expect.any(String) });
      expect(drive.placed).toEqual([]);
    }
    expect(index.queueLength()).toBe(queued);
    await embedPass(index, embedderOf(driveOf({ listing: listing() })), () => true);
    expect(kept()).toBeNull();
    index.close();
    expect(count(file, "screen_vector")).toBe(queued);
  });

  it("keeps every text when the runner refuses the batch on battery or in use (its own fresh look), and says why", async () => {
    const { index } = indexOf(segments(T0, 1, 11));
    const queued = index.queueLength();
    for (const reason of ["battery", "in_use"] as const) {
      const refused = driveOf({ listing: listing(), answer: () => ({ error: { code: "BUSY", reason, model: MODEL } }) });
      expect(await embedPass(index, embedderOf(refused), () => true)).toMatchObject({ embedded: 0, skipped: 0, waits: reason });
      expect(refused.placed).toHaveLength(1);
      expect(index.queueLength()).toBe(queued);
    }
    index.close();
  });

  it("stops at a busy runner with every text still queued, and lands them on a later pass", async () => {
    const { index } = indexOf(segments(T0, 2, 2));
    const queued = index.queueLength();
    const busy = driveOf({ listing: listing(), answer: () => ({ error: { code: "BUSY", model: MODEL } }) });
    expect(await embedPass(index, embedderOf(busy), () => true)).toMatchObject({ embedded: 0, waits: "busy" });
    expect(busy.placed).toHaveLength(1);
    expect(index.queueLength()).toBe(queued);
    expect(await embedPass(index, embedderOf(driveOf({ listing: listing() })), () => true)).toMatchObject({ embedded: queued, waits: null, more: false });
    expect(index.queueLength()).toBe(0);
    index.close();
  });

  it("embeds the newest texts first, at most 32 a batch, asking whether it may before each one", async () => {
    const { file, index } = indexOf([...segments(T0 - 2 * DAY, 6, 3), ...segments(T0, 1, 4)]);
    const newest = new Database(file, { readonly: true });
    const texts = new Map(index.queued(10_000).map((each) => [each.textHash, each.text]));
    const newer = (newest.prepare("SELECT text_hash FROM screen_embed_queue WHERE day = (SELECT max(day) FROM screen_embed_queue)").all() as { text_hash: string }[]).map((row) => texts.get(row.text_hash)!);
    newest.close();
    const queued = index.queueLength();
    expect(queued).toBeGreaterThan(64);
    const drive = driveOf({ listing: listing() });
    const pass = await embedPass(index, embedderOf(drive), () => true);
    expect(pass).toMatchObject({ embedded: queued, dropped: 0, skipped: 0, waits: null, more: false });
    expect(drive.placed.every((batch) => batch.length <= 32)).toBe(true);
    expect(drive.placed.flat()).toHaveLength(queued);
    expect(new Set(drive.placed.flat().slice(0, newer.length))).toEqual(new Set(newer));
    expect(drive.listed).toBe(drive.placed.length);
    index.close();
    expect(count(file, "screen_vector")).toBe(queued);
  });

  it("stops between batches once its time is up, and once the person comes back", async () => {
    const { index } = indexOf(segments(T0 - 2 * DAY, 12, 5));
    const timed = driveOf({ listing: listing() });
    expect(await embedPass(index, embedderOf(timed), () => timed.placed.length < 1)).toMatchObject({ embedded: 32, more: true });
    const person: Parameters<typeof driveOf>[0] = { listing: listing(), answer: (placed, texts) => {
      person.listing = listing({ idle_s: 3 });
      return answered(placed, texts);
    } };
    expect(await embedPass(index, embedderOf(driveOf(person)), () => true)).toMatchObject({ embedded: 32, waits: "in_use" });
    index.close();
  });

  it("tries a batch the model fails a text at a time, and skips a text it fails alone while the others embed, for good", async () => {
    const held = segments(T0, 1, 6);
    const { file, index } = indexOf(held);
    const queued = index.queueLength();
    const poison = index.queued(1)[0]!.text;
    const drive = driveOf({ listing: listing(), answer: (placed, texts) => texts.includes(poison)
      ? { error: { code: "FAILED", model: MODEL, reason: "failed" } }
      : answered(placed, texts) });
    expect(await embedPass(index, embedderOf(drive), () => true)).toMatchObject({ embedded: queued - 1, skipped: 1, waits: null });
    expect(index.queueLength()).toBe(0);
    index.apply([], sourceOf(held), undefined, new Set([`mac-0001\0${civilDay(T0, DAYS)}`]));
    expect(index.queueLength()).toBe(0);
    index.close();
    expect(count(file, "screen_vector")).toBe(queued - 1);
    expect(count(file, "screen_embed_skipped")).toBe(1);
    const db = readScreen(openHomeFolder(dirname(file)), file)!;
    try {
      expect(meaningCounts(db)).toEqual({ embedded: queued - 1, queued: 0, skipped: 1, named: queued });
    } finally {
      db.close();
    }
  });

  it("keeps the whole queue when the model fails every text (it is the model, not the texts), waits failing, and lands them once it answers", async () => {
    const { file, index } = indexOf(segments(T0, 1, 9));
    const queued = index.queueLength();
    const down = driveOf({ listing: listing(), answer: () => ({ error: { code: "FAILED", model: MODEL, reason: "failed" } }) });
    expect(await embedPass(index, embedderOf(down), () => true)).toMatchObject({ embedded: 0, skipped: 0, waits: "failing" });
    expect(down.placed).toHaveLength(1 + Math.min(32, queued));
    expect(index.queueLength()).toBe(queued);
    expect(await embedPass(index, embedderOf(driveOf({ listing: listing() })), () => true)).toMatchObject({ embedded: queued, waits: null });
    index.close();
    expect(count(file, "screen_vector")).toBe(queued);
  });

  it("lands nothing for a reply that comes after the run was stopped (meaning's settings changed)", async () => {
    const { file, index } = indexOf(segments(T0, 1, 10));
    const queued = index.queueLength();
    const stop = new AbortController();
    const drive = driveOf({ listing: listing(), answer: (placed, texts) => {
      stop.abort();
      return answered(placed, texts);
    } });
    expect(await embedPass(index, embedderOf(drive), () => true, stop.signal)).toMatchObject({ embedded: 0 });
    expect(drive.placed).toHaveLength(1);
    expect(index.queueLength()).toBe(queued);
    index.close();
    expect(count(file, "screen_vector")).toBe(0);
  });

  it("lands nothing for a reply asked under settings the index no longer states, whatever reaches the run first", async () => {
    const on = meaningSettingsOf({ unit: RUNNER, file: MODEL, power: "plugged-idle" });
    const off = meaningSettingsOf(null);
    const { file, index } = indexOf(segments(T0, 1, 12), MODEL, on);
    expect(ScreenIndex.stateMeaning(openHomeFolder(dirname(file)), file, on, 1_000)).toBe(true);
    const queued = index.queueLength();
    const drive = driveOf({ listing: listing(), answer: (placed, texts) => {
      expect(ScreenIndex.stateMeaning(openHomeFolder(dirname(file)), file, off, 1_000)).toBe(true);
      return answered(placed, texts);
    } });
    expect(await embedPass(index, embedderOf(drive), () => true)).toMatchObject({ embedded: 0 });
    expect(drive.placed).toHaveLength(1);
    expect(index.queueLength()).toBe(queued);
    expect(ScreenIndex.stateMeaning(openHomeFolder(dirname(file)), file, on, 1_000)).toBe(true);
    expect(await embedPass(index, embedderOf(driveOf({ listing: listing() })), () => true)).toMatchObject({ embedded: queued });
    index.close();
    expect(count(file, "screen_vector")).toBe(queued);
  });

  it("lands nothing for a reply that comes after an erasure of its texts", async () => {
    const held = segments(T0, 2, 7);
    const { file, index } = indexOf(held);
    const drive = driveOf({ listing: listing(), answer: (placed, texts) => {
      ScreenIndex.erase(openHomeFolder(dirname(file)), file, [{ machine: "mac-0001", from_ms: T0, to_ms: T0 + 2 * SEG }], sourceOf([]));
      return answered(placed, texts);
    } });
    const pass = await embedPass(index, embedderOf(drive), () => true);
    expect(pass.embedded).toBe(0);
    expect(pass.dropped).toBe(drive.placed[0]!.length);
    index.close();
    expect(count(file, "screen_vector")).toBe(0);
    expect(count(file, "screen_embed_queue")).toBe(0);
  });

  it("lands nothing for a reply asked under another model or another build", () => {
    const held = segments(T0, 1, 8);
    const { file, index } = indexOf(held);
    const asked = { model: MODEL, generation: index.generation() };
    const replies = index.queued(4).map((each) => ({ textHash: each.textHash, vector: vectorFor(each.text) }));
    index.close();
    const other = ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: DAYS, meaning: "other-model" }, () => true);
    expect(other.building).toBe(false);
    expect(other.land(asked, replies)).toEqual({ landed: 0, dropped: 4 });
    other.close();
    const rebuilt = ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: DAYS, meaning: "other-model" }, (_, building) => building);
    rebuilt.apply(held, sourceOf(held));
    rebuilt.finish();
    const after = ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: DAYS, meaning: "other-model" }, () => true);
    expect(after.land({ model: "other-model", generation: asked.generation }, replies)).toEqual({ landed: 0, dropped: 4 });
    expect(after.land({ model: "other-model", generation: after.generation() }, replies)).toEqual({ landed: 4, dropped: 0 });
    after.close();
  });
});

describe("embedding end to end", () => {
  it("embeds the screen's texts on the runner the Search by meaning default names once the index has read them, and turned off, drops the vectors and keeps the words", async () => {
    const SOURCE = "screen:local:mac-0001";
    const root = makeRoot("lifestream-screen-embed-", { sources: { [SOURCE]: "fake-rows" }, settings: { "families.screen": { index: true }, "model.defaults.search": `runner:${RUNNER}/${MODEL}` } });
    homes.push(root);
    mintPrincipal(openHomeFolder(root), { unit: "test-drive", scopes: ["drive"], token: DRIVE, now_ms: Date.now() });
    const state = (name: string, value: string) => {
      const path = join(root, `runner-${name}`);
      writeFileSync(path, value);
      return path;
    };
    const door = await doorHere(root, { registry: FAKES });
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    const sock = testSocket(root);
    const passFile = join(process.env.LIFESTREAM_MACHINE_DIR!, "runner", "door-token");
    const program = spawn(process.execPath, [...checkoutProgram(join(REPO, "packages", "runner", "test", "fake-runner.ts")),
      "--door", door.url, "--pass", passFile, "--power", state("power", "mains"), "--idle", state("idle", "600"), "--thermal", state("thermal", "nominal")], { cwd: REPO, stdio: ["ignore", "ignore", "pipe"] });
    const said: string[] = [];
    program.stderr!.on("data", (chunk: Buffer) => said.push(chunk.toString("utf8")));
    const exited = new Promise<void>((resolve) => program.once("exit", () => resolve()));
    const file = screenFileOf(searchFileOf(root, process.env.LIFESTREAM_MACHINE_DIR!));
    const read = <T>(sql: string): T | undefined => {
      if (!existsSync(file)) return undefined;
      const db = new Database(file, { readonly: true, timeout: 10_000 });
      try {
        return db.prepare(sql).get() as T | undefined;
      } catch {
        return undefined;
      } finally {
        db.close();
      }
    };
    try {
      let listed: unknown;
      await until("the meaning model's file ready on the runner", async () => {
        const answer = await fetch(`${door.url}/v1/runners`, { headers: { authorization: `Bearer ${DRIVE}` } });
        const { runners } = await answer.json() as { runners: RunnerListing[] };
        listed = runners;
        return runners.find((each) => each.unit === RUNNER)?.files.find((each) => each.id === MODEL)?.state === "ready";
      }).catch((error: Error) => { throw new Error(`${error.message}; the door listed ${JSON.stringify(listed)}; the runner said ${said.join("")}`); });

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
        frame("f1", at, sentence(1), sentence(2)), frame("f2", at + 4_000, sentence(1), sentence(3)), frame("f3", at + SEG, sentence(4)),
      ] as never });
      await until("every text of the frames embedded", () => {
        const units = read<{ n: number }>("SELECT count(DISTINCT text_hash) AS n FROM screen_unit")?.n ?? 0;
        return units > 0 && read<{ n: number }>("SELECT count(*) AS n FROM screen_vector")?.n === units && read<{ n: number }>("SELECT count(*) AS n FROM screen_embed_queue")?.n === 0;
      }).catch((error: Error) => { throw new Error(`${error.message}; runs ${JSON.stringify(runs())}; the runner said ${said.join("")}`); });
      const embedded = read<{ n: number }>("SELECT count(*) AS n FROM screen_vector")!.n;
      expect(read<{ value: string }>("SELECT value FROM meta WHERE name = 'vector_model'")).toEqual({ value: MODEL });
      const generation = read<{ value: string }>("SELECT value FROM meta WHERE name = 'generation'")!.value;
      const vectors = join(file, "..", "screen-vectors", generation);
      expect(existsSync(join(vectors, MODEL))).toBe(true);

      await askHome(sock, "models", ["default", "search", "none"]);
      await until("the vectors gone", () => !existsSync(vectors) && read<{ value: string }>("SELECT value FROM meta WHERE name = 'meaning'")?.value === "false");
      expect(read<{ value: string }>("SELECT value FROM meta WHERE name = 'generation'")).toEqual({ value: generation });
      expect(read<{ n: number }>("SELECT count(*) AS n FROM screen_fts WHERE screen_fts MATCH 'cobalt'")?.n).toBeGreaterThan(0);
      artifact(root, "screen-embed", { embedded, runs: runs() });
    } finally {
      program.kill("SIGTERM");
      await exited;
      await home.stop();
      await door.stop();
    }

    function runs(): unknown[] {
      return readHome(root, (db) => db.prepare("SELECT counts FROM runs WHERE kind = 'index' AND subject = 'screen' ORDER BY id").all() as { counts: string }[]).map((row) => JSON.parse(row.counts) as unknown);
    }
  });
});

describe("the model's download done", () => {
  it("starts the first batch as the file comes ready, not at the job's own next look a minute later", async () => {
    const SOURCE = "screen:local:mac-0001";
    const root = makeRoot("lifestream-screen-embed-", { sources: { [SOURCE]: "fake-rows" }, settings: { "families.screen": { index: true }, "model.defaults.search": `runner:${RUNNER}/${MODEL}` } });
    homes.push(root);
    mintPrincipal(openHomeFolder(root), { unit: "test-drive", scopes: ["drive"], token: DRIVE, now_ms: Date.now() });
    const state = (name: string, value: string) => {
      const path = join(root, `runner-${name}`);
      writeFileSync(path, value);
      return path;
    };
    const arrived = join(root, "runner-arrived");
    const script = state("script", JSON.stringify({ fetching: arrived }));
    const door = await doorHere(root, { registry: FAKES });
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    const passFile = join(process.env.LIFESTREAM_MACHINE_DIR!, "runner", "door-token");
    const program = spawn(process.execPath, [...checkoutProgram(join(REPO, "packages", "runner", "test", "fake-runner.ts")),
      "--door", door.url, "--pass", passFile, "--script", script, "--power", state("power", "mains"), "--idle", state("idle", "600"), "--thermal", state("thermal", "nominal")], { cwd: REPO, stdio: ["ignore", "ignore", "pipe"] });
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
    const job = () => readHome(root, (db) => db.prepare("SELECT state, not_before_ms FROM jobs WHERE kind = 'index' AND key = 'screen'").get() as { state: string; not_before_ms: number } | undefined);
    try {
      let listed: unknown;
      await until("the door lists the meaning model's file fetching", async () => {
        const { runners } = await (await fetch(`${door.url}/v1/runners`, { headers: { authorization: `Bearer ${DRIVE}` } })).json() as { runners: RunnerListing[] };
        listed = runners;
        return runners.find((each) => each.unit === RUNNER)?.files.find((each) => each.id === MODEL)?.state === "fetching";
      }).catch((error: Error) => { throw new Error(`${error.message}; the door listed ${JSON.stringify(listed)}; the runner said ${said.join("")}`); });
      await askHome(testSocket(root), "models", ["battery", RUNNER, "spend"]);
      const seen = () => readHome(root, (db) => {
        const stored = db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(MODELS_META) as string | undefined;
        const runners = stored === undefined ? [] : (JSON.parse(stored) as StoredModels).runners;
        return runners.find((each) => each.unit === RUNNER)?.files.find((each) => each.id === MODEL)?.state;
      });
      await until("the home reads the file fetching", () => seen() === "fetching")
        .catch((error: Error) => { throw new Error(`${error.message}; the home read ${JSON.stringify(seen())}; the runner said ${said.join("")}`); });
      const frame = (key: string, at: number, ...lines: string[]) => ({
        kind: "frame", key, at,
        content: {
          at, status: "captured", displayID: 1, application: { name: "Example Editor", bundleID: "com.example.editor" },
          frontWindow: { windowID: 11 }, windows: [{ windowID: 11, title: "Notes" }],
          accessibility: { nodes: lines.map((value) => ({ depth: 1, role: "AXStaticText", value })) }, ocr: [],
        },
      });
      const at = Date.parse("2026-09-28T06:00:00Z");
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [frame("f1", at, sentence(1), sentence(2)), frame("f2", at + SEG, sentence(3))] as never });
      await until("the texts queued and the job waiting a minute on the file", () => {
        const waiting = job();
        return (count("SELECT count(*) FROM screen_embed_queue") ?? 0) > 0 && waiting?.state === "queued" && waiting.not_before_ms > Date.now() + 40_000;
      }).catch((error: Error) => { throw new Error(`${error.message}; job ${JSON.stringify(job())}; the runner said ${said.join("")}`); });
      expect(count("SELECT count(*) FROM screen_vector")).toBe(0);
      writeFileSync(arrived, "");
      await until("every text embedded once the file is ready", () => {
        const units = count("SELECT count(DISTINCT text_hash) FROM screen_unit") ?? 0;
        return units > 0 && count("SELECT count(*) FROM screen_vector") === units && count("SELECT count(*) FROM screen_embed_queue") === 0;
      }).catch((error: Error) => { throw new Error(`${error.message}; job ${JSON.stringify(job())}; the runner said ${said.join("")}`); });
    } finally {
      program.kill("SIGTERM");
      await exited;
      await home.stop();
      await door.stop();
    }
  });
});
