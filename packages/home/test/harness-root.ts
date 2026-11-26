import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { onTestFinished, TestRunner } from "vitest";
import { openHome, openHomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import { openLedger } from "@lifestreamprotocol/model";
import { declarations, vendorOf } from "@lifestreamprotocol/connect";
import { ask, type HomeSocket } from "../socket.js";
import { SINCE } from "../models.js";
import { searchFileOf } from "../search-index.js";
import { openWith, readVault, recoveryKey } from "../vault.js";
import { homeSources } from "../devices.js";
import { checkoutProgram } from "../programs.js";
import { TEST_UNIT, testSocket, writeFolder } from "./folder.js";

export const OWN_SOURCES: readonly string[] = homeSources(TEST_UNIT).map((source) => source.id);

export const REPO = fileURLToPath(new URL("../../../", import.meta.url));
export const FAKES = fileURLToPath(new URL("./fakes.ts", import.meta.url));
const CHILD = fileURLToPath(new URL("./child.ts", import.meta.url));
export const TICK_MS = 10;
export const LOOK_MS = 10;
const watched = new Set<string>();

export interface RootOptions {
  clocks?: boolean;
  helpers?: number;
  fake?: JsonObject;
  sources: Record<string, string>;
  cap?: number;
  defaults?: boolean;
  settings?: JsonObject;
}

export const FAKE_OFFER = { model: "fake-model", name: "Fake model", input: ["text", "image", "audio"], output: "text", tools: false, context_tokens: null, thinking: [], ready: true };
export const FAKE_ROUTE = "fake:fake-model";
const SINCE_EPOCH = "1970-01-31";

let emptyRootTemplate: string | undefined;

function rootTemplate(): string {
  if (emptyRootTemplate !== undefined && existsSync(emptyRootTemplate)) return emptyRootTemplate;
  const dir = mkdtempSync(join(tmpdir(), "lifestream-root-template-"));
  const db = openHome(openHomeFolder(dir), "migrate");
  db.commit((tx) => {
    tx.tables.meta.set(SINCE, SINCE_EPOCH);
  });
  db.close();
  mkdirSync(join(dir, "replies"), { recursive: true });
  openLedger(openHomeFolder(dir), { mode: "migrate" }).close();
  emptyRootTemplate = dir;
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function makeRoot(prefix: string, options: RootOptions): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cpSync(rootTemplate(), root, { recursive: true, mode: constants.COPYFILE_FICLONE });
  const route = options.defaults === false ? null : FAKE_ROUTE;
  const settings: JsonObject = {
    helpers: options.helpers ?? 2, clocks: options.clocks ?? false,
    "model.cap": options.cap ?? 64,
    "model.defaults.pictures": route, "model.defaults.audio": route, "model.defaults.text": route,
    ...options.settings,
    "model.transports.fake": { delay_ms: 0, models: [FAKE_OFFER], ...options.fake, ...options.settings?.["model.transports.fake"] as JsonObject | undefined },
  };
  writeFolder(root, settings);
  const entries = Object.entries(options.sources);
  if (entries.length > 0) {
    const db = openHome(openHomeFolder(root), "write");
    db.commit((tx) => {
      for (const [id, connector] of entries) tx.tables.sources.add({ id, vendor: vendorOf(declarations(), id), connector, added_ms: 0 });
    });
    db.close();
  }
  watched.add(root);
  return root;
}

export function copyRoot(root: string, prefix: string): string {
  const copy = mkdtempSync(join(tmpdir(), prefix));
  cpSync(root, copy, { recursive: true, mode: constants.COPYFILE_FICLONE });
  watched.add(copy);
  return copy;
}

const pollDbs = new Map<string, { db: Database.Database; ino: number }>();
let pollDepth = 0;

function closePollDbs(prefix?: string): void {
  for (const [path, held] of pollDbs) {
    if (prefix !== undefined && !path.startsWith(prefix)) continue;
    try { held.db.close(); } catch {}
    pollDbs.delete(path);
  }
}

function withReadonlyDb<T>(path: string, timeout: number, read: (db: Database.Database) => T): T {
  if (pollDepth === 0) {
    const db = new Database(path, { readonly: true, fileMustExist: true, timeout });
    try {
      return read(db);
    } finally {
      db.close();
    }
  }
  const st = statSync(path);
  let held = pollDbs.get(path);
  if (held !== undefined && held.ino !== st.ino) {
    try { held.db.close(); } catch {}
    pollDbs.delete(path);
    held = undefined;
  }
  if (held === undefined) {
    held = { db: new Database(path, { readonly: true, fileMustExist: true, timeout }), ino: st.ino };
    pollDbs.set(path, held);
  }
  try {
    return read(held.db);
  } catch (error) {
    try { held.db.close(); } catch {}
    pollDbs.delete(path);
    throw error;
  }
}

export function removeRoot(root: string): void {
  watched.delete(root);
  endNudges(root);
  closePollDbs(root);
  if (process.env.LIFESTREAM_KEEP_ARTIFACTS === "1") return;
  rmSync(root, { recursive: true, force: true });
}

export async function makeVault(root: string): Promise<Buffer> {
  const sock = testSocket(root);
  const made = (await ask(sock, { verb: "vault-init" })) as { recovery: string };
  await ask(sock, { verb: "vault-confirm", recovery: made.recovery });
  return openWith(readVault(root)!, "recovery", recoveryKey.parse(made.recovery))!.key;
}

export function artifact(root: string, name: string, value: unknown): string {
  const path = join(root, "artifacts", `${name}.json`);
  mkdirSync(join(root, "artifacts"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

const FIXTURE_MS = Date.UTC(2026, 9, 14, 9, 0);

export function clientFixture(name: string, read: unknown, durations: readonly string[] = []): { file: string; written: string; held: string } {
  const pinned = JSON.stringify(read, (key, value: unknown) =>
    key.endsWith("_ms") && !durations.includes(key) && typeof value === "number" ? FIXTURE_MS : key === "position" && typeof value === "string" ? `1:${FIXTURE_MS}` : value, 2);
  const file = join(REPO, "homelink", "Tests", "Fixtures", `${name}.json`);
  const written = `${pinned}\n`;
  if (process.env.LIFESTREAM_FIXTURES === "write") writeFileSync(file, written);
  return { file, written, held: existsSync(file) ? readFileSync(file, "utf8") : "" };
}

export interface Keeper {
  owe(id?: string): void;
  close(): void;
}

const keepers = new Map<string, { kept: Keeper; logs: JsonObject[] }>();

export function keeperOf(root: string, make: (socket: HomeSocket, log: (line: JsonObject) => void) => Keeper, machineDir?: string): Keeper {
  let keeper = keepers.get(root);
  if (keeper === undefined) {
    const logs: JsonObject[] = [];
    keeper = { kept: make(testSocket(root, machineDir), (line) => logs.push(line)), logs };
    keepers.set(root, keeper);
    if (TestRunner.getCurrentTest() !== undefined) onTestFinished(() => { endNudges(root); });
  }
  return keeper.kept;
}

export function nudgeLog(root: string): readonly JsonObject[] {
  return keepers.get(root)?.logs ?? [];
}

export function endNudges(root: string): boolean {
  const keeper = keepers.get(root);
  keeper?.kept.close();
  return keepers.delete(root);
}

export function hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const WAIT_MS = 30_000;
const realNow = Date.now;

function giveUpAt(): number {
  const test = TestRunner.getCurrentTest();
  const started = test?.result?.startTime;
  return test !== undefined && started !== undefined && test.timeout > 120_000 ? started + test.timeout - 10_000 : realNow() + WAIT_MS;
}

export function freeSpace(bytes: number): { set(bytes: number): void } {
  const dir = mkdtempSync(join(tmpdir(), "lifestream-free-"));
  const file = join(dir, "free");
  const set = (next: number): void => {
    writeFileSync(`${file}.next`, String(next));
    renameSync(`${file}.next`, file);
  };
  set(bytes);
  const before = process.env.LIFESTREAM_TEST_FREE!;
  process.env.LIFESTREAM_TEST_FREE = file;
  onTestFinished(() => {
    process.env.LIFESTREAM_TEST_FREE = before;
    rmSync(dir, { recursive: true, force: true });
  });
  return { set };
}

function holding(root: string, now = Date.now()): string[] {
  if (!existsSync(join(root, "home.db"))) return [];
  const { jobs, asks, models } = readHome(root, (db) => ({
    jobs: db.prepare("SELECT kind, key, state, attempts, error, not_before_ms FROM jobs WHERE state IN ('queued', 'running') ORDER BY id").all() as
      { kind: string; key: string; state: string; attempts: number; error: string | null; not_before_ms: number }[],
    asks: db.prepare("SELECT family, item, waits, retry_ms FROM asks WHERE state = 'pending' ORDER BY family, item").all() as
      { family: string; item: string; waits: string | null; retry_ms: number | null }[],
    models: db.prepare("SELECT value FROM meta WHERE key = 'llm:models'").pluck().get() as string | undefined,
  }));
  const routes = models === undefined ? [] : (JSON.parse(models) as { routes: { id: string; state: string }[] }).routes.filter((route) => route.state !== "ready");
  const calls = readLedger(root, (db) => db.prepare("SELECT a.transport, a.state, a.error FROM attempts a WHERE a.state <> 'replied' AND a.state <> 'settled' ORDER BY a.id").all()) as
    { transport: string | null; state: string; error: string | null }[] | undefined;
  return [
    ...jobs.map((job) => `job ${job.kind} ${job.key} ${job.state}, attempts ${job.attempts}, due in ${job.not_before_ms - now} ms${job.error === null ? "" : `, error: ${job.error}`}`),
    ...asks.map((ask) => `ask ${ask.family} ${ask.item} pending${ask.waits === null ? "" : `, waits on ${ask.waits}`}${ask.retry_ms === null ? "" : `, retry_ms ${ask.retry_ms}`}`),
    ...routes.map((route) => `route ${route.id} ${route.state}`),
    ...(calls ?? []).map((call) => `call on ${call.transport ?? "?"} ${call.state}${call.error === null ? "" : `, error: ${call.error}`}`),
  ];
}

function heldNow(): string {
  const held = [...watched].flatMap((root) => {
    let lines: string[];
    try {
      lines = holding(root);
    } catch (error) {
      lines = [`unread: ${(error as Error).message}`];
    }
    return lines.length === 0 ? [] : [`${root}: ${lines.join("; ")}`];
  });
  return held.length === 0 ? "" : `; the home held ${held.join(" | ")}`;
}

export async function until(what: string, ready: () => boolean | Promise<boolean>): Promise<void> {
  const began = realNow();
  const deadline = giveUpAt();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`never came in ${Math.round((realNow() - began) / 1_000)} s: ${what}${heldNow()}`)), Math.max(0, deadline - began));
  });
  pollDepth += 1;
  try {
    for (let polls = 0; ; polls += 1) {
      const done = await Promise.race([Promise.resolve().then(ready).catch(() => false), expired]);
      if (done) return;
      await Promise.race([new Promise((resolve) => setTimeout(resolve, polls < 20 ? 5 : 15)), expired]);
    }
  } finally {
    clearTimeout(timer);
    pollDepth -= 1;
    if (pollDepth === 0) closePollDbs();
  }
}

export function steppedClock(root: string, lane: string, refresh_ms: number): { now: () => number; nextTurn(): Promise<void>; stepUntil(what: string, ready: () => boolean): Promise<void> } {
  let ahead = 0;
  const now = () => Math.max(Date.now(), ahead);
  const next = () => (readHome(root, (db) => db.prepare("SELECT next_ms FROM polls WHERE acquirer = ?").pluck().get(lane)) as number | undefined) ?? 0;
  const step = () => {
    const turn = next();
    if (turn - now() > refresh_ms) throw new Error(`${lane}'s next turn is ${(turn - now()).toLocaleString("en-US")} ms out; its refresh is ${refresh_ms.toLocaleString("en-US")}`);
    ahead = turn;
  };
  return {
    now,
    async nextTurn() {
      await until(`${lane}'s end set its next turn`, () => next() > now());
      step();
    },
    async stepUntil(what, ready) {
      for (;;) {
        await until(what, () => ready() || next() > now());
        if (ready()) return;
        step();
      }
    },
  };
}

export function readHome<T>(root: string, read: (db: Database.Database) => T): T {
  return withReadonlyDb(join(root, "home.db"), 5_000, read);
}

export function readLedger<T>(root: string, read: (db: Database.Database) => T): T | undefined {
  const path = join(root, "replies", "replies.db");
  if (!existsSync(path)) return undefined;
  return withReadonlyDb(path, 5_000, read);
}

export function searchIndexed(root: string): boolean {
  const path = searchFileOf(root, process.env.LIFESTREAM_MACHINE_DIR!);
  if (!existsSync(path)) return false;
  const { seq, days } = withReadonlyDb(path, 10_000, (db) => ({
    seq: (JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'position'").pluck().get() as string) as { seq: number }).seq,
    days: db.prepare("SELECT count(*) FROM days").pluck().get() as number,
  }));
  const home = readHome(root, (db) => ({
    top: db.prepare("SELECT coalesce(max(seq), 0) FROM statements").pluck().get() as number,
    waiting: db.prepare(`SELECT (SELECT count(*) FROM jobs WHERE (kind IN ('render', 'extract', 'import') OR (kind = 'index' AND key = 'search')) AND state <> 'done')
      + (SELECT count(*) FROM dirty_days)`).pluck().get() as number,
  }));
  const files = existsSync(join(root, "days")) ? readdirSync(join(root, "days")).filter((name) => name.endsWith(".day.json")).length : 0;
  return seq === home.top && home.waiting === 0 && files === days;
}

export function settled(root: string, deliveries: number): boolean {
  const home = readHome(root, (db) => ({
    imported: (db.prepare("SELECT count(*) AS n FROM deliveries WHERE state = 'imported'").get() as { n: number }).n,
    busy: (db.prepare("SELECT count(*) AS n FROM jobs WHERE state IN ('queued', 'running')").get() as { n: number }).n,
    pending: (db.prepare("SELECT count(*) AS n FROM asks WHERE state = 'pending'").get() as { n: number }).n,
  }));
  const ledger = readLedger(root, (db) => ({
    open: (db.prepare("SELECT count(*) AS n FROM requests WHERE open = 1").get() as { n: number }).n,
    sending: (db.prepare("SELECT count(*) AS n FROM attempts WHERE state = 'sending'").get() as { n: number }).n,
  })) ?? { open: 0, sending: 0 };
  return home.imported === deliveries && home.busy === 0 && home.pending === 0 && ledger.open === 0 && ledger.sending === 0;
}

export function snapshot(root: string): {
  heads: unknown[]; days: Record<string, string>; replies: unknown[]; attempts: Record<string, string[]>;
  deliveries: unknown[]; imports: Record<string, number>; dayUnits: { family: string; unit: string; day: string; reading: string; code: string; shown: number }[];
} {
  const home = readHome(root, (db) => ({
    heads: db.prepare("SELECT source, kind, key, version, stated_ms FROM heads ORDER BY source, kind, key").all(),
    deliveries: db.prepare("SELECT id, source, state FROM deliveries ORDER BY id, source").all(),
    dayUnits: db.prepare("SELECT family, unit, day, reading, code, shown FROM day_units ORDER BY day, family, unit").all() as
      { family: string; unit: string; day: string; reading: string; code: string; shown: number }[],
    imports: db.prepare("SELECT subject, count(*) AS n FROM runs WHERE kind = 'import' AND outcome = 'ok' GROUP BY subject ORDER BY subject").all() as
      { subject: string; n: number }[],
  }));
  const ledger = readLedger(root, (db) => ({
    replies: db.prepare("SELECT key, text FROM replies ORDER BY key").all(),
    attempts: db.prepare("SELECT key, state FROM attempts ORDER BY key, id").all() as { key: string; state: string }[],
  })) ?? { replies: [], attempts: [] };
  const days: Record<string, string> = {};
  const directory = join(root, "days");
  if (existsSync(directory)) for (const name of readdirSync(directory).sort()) days[name] = readFileSync(join(directory, name), "utf8");
  const attempts: Record<string, string[]> = {};
  for (const { key, state } of ledger.attempts) (attempts[key] ??= []).push(state);
  return {
    heads: home.heads, days, replies: ledger.replies, attempts, deliveries: home.deliveries, dayUnits: home.dayUnits,
    imports: Object.fromEntries(home.imports.map((row) => [row.subject, row.n])),
  };
}

export interface ChildOptions {
  slot?: Buffer;
  strayFd?: boolean;
  fdNamedOnly?: boolean;
  fsync?: boolean;
  env?: Record<string, string>;
}

export class ChildHome {
  #child: ChildProcess | null = null;
  #exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  #machineDir: string | undefined;
  exits: { code: number | null; signal: NodeJS.Signals | null }[] = [];

  constructor(readonly root: string) {}

  start(failpoint?: string, options: ChildOptions = {}): void {
    const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
    this.#machineDir = env.LIFESTREAM_MACHINE_DIR;
    delete env.LIFESTREAM_FAILPOINT;
    delete env.LIFESTREAM_VAULT_FD;
    if (failpoint !== undefined) env.LIFESTREAM_FAILPOINT = failpoint;
    delete env.LIFESTREAM_TEST_FSYNC;
    if (options.fsync === true) env.LIFESTREAM_TEST_FSYNC = "1";
    if ((options.slot !== undefined && options.strayFd !== true) || options.fdNamedOnly === true) env.LIFESTREAM_VAULT_FD = "3";
    let fd: number | "ignore" = "ignore";
    if (options.slot !== undefined) {
      const dir = mkdtempSync(join(tmpdir(), "lifestream-slot-"));
      writeFileSync(join(dir, "slot"), options.slot, { mode: 0o600 });
      fd = openSync(join(dir, "slot"), "r");
      rmSync(dir, { recursive: true });
    }
    const child = spawn(process.execPath, [...checkoutProgram(CHILD), this.root, String(TICK_MS)], { cwd: REPO, env, stdio: ["ignore", "ignore", "pipe", fd] });
    if (typeof fd === "number") closeSync(fd);
    let stderr = "";
    child.stderr!.on("data", (data: Buffer) => { stderr += data.toString("utf8"); });
    this.#child = child;
    this.#exit = new Promise((resolve) => child.once("exit", (code, signal) => {
      const exit = { code, signal };
      this.exits.push(exit);
      if ((signal === null ? code !== 0 : signal !== "SIGTERM" && signal !== "SIGKILL") && stderr !== "") process.stderr.write(`child home (${signal ?? code}): ${stderr}\n`);
      resolve(exit);
    }));
  }

  get alive(): boolean {
    return this.#child !== null && this.#child.exitCode === null && this.#child.signalCode === null;
  }

  async ready(): Promise<void> {
    const { path } = testSocket(this.root, this.#machineDir);
    let answers = false;
    await until("the child home's socket", () => {
      if (!answers && existsSync(path)) {
        const probe = createConnection(path);
        probe.once("connect", () => { answers = true; probe.destroy(); });
        probe.once("error", () => undefined);
      }
      return answers || !this.alive;
    });
  }

  async exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.#exit!;
  }

  async stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.alive) this.#child!.kill("SIGTERM");
    return this.exited();
  }

  kill(): void {
    if (this.alive) this.#child!.kill("SIGKILL");
  }
}
