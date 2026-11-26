import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname, totalmem } from "node:os";
import {
  ArtifactError, DOCUMENT_IDLE_S, embedAskOf, FETCHING_MS, isHanded, Refused, RUNNER_EXCHANGE, RUNNER_WIRE_VERSION, STOP_MS,
  type FileFailure, type RunnerCall, type RunnerWait, type RunnerExchange, type RunnerFile, type RunnerFileState, type RunnerHanded, type RunnerResult, type RunnerStated,
} from "@lifestreamprotocol/model";
import type { LibraryName, Row } from "./files.js";
import { Failed, NotReady, type Library } from "./library.js";


export interface RunnerOptions {
  readonly door: string;
  readonly pass: string;
  readonly rows: readonly Row[];
  readonly libraries: Readonly<Record<LibraryName, Library>>;
  readonly signal: AbortSignal;
  readonly log?: (line: string) => void;
  readonly retry_ms?: number;
  readonly rest_ms?: number;
  readonly drain_ms?: number;
  readonly name?: string;
  readonly power?: () => Promise<RunnerStated["power"]>;
  readonly idle?: () => Promise<RunnerStated["idle_s"]>;
  readonly thermal?: () => Promise<RunnerStated["thermal"]>;
}

const SLOTS = 1;
const REST_MS = 5 * 60_000;
const POWER_MS = 60_000;
export const DRAIN_MS = 5_000;

interface FileOf {
  state: RunnerFileState;
  fetched_bytes: number;
  failure: FileFailure | null;
  doing: { readonly op: "fetch" | "remove"; readonly stop: AbortController; readonly done: Promise<void> } | null;
  failed: { readonly op: "fetch" | "remove"; readonly at_ms: number } | null;
  owed: boolean;
}

interface Running {
  readonly stop: AbortController;
  cancelled: number | null;
}

function heals(failure: FileFailure): boolean {
  switch (failure) {
    case "offline":
    case "refused":
    case "full":
    case "disk":
    case "failed":
      return true;
    case "hash":
    case "untrusted":
      return false;
    default:
      return failure satisfies never;
  }
}

function failureOf(error: unknown): FileFailure {
  if (error instanceof ArtifactError) return error.reason;
  return error instanceof Refused ? "untrusted" : "failed";
}

export async function serve(options: RunnerOptions): Promise<void> {
  const { signal, rows } = options;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const retryMs = options.retry_ms ?? 5_000;
  const restMs = options.rest_ms ?? REST_MS;
  const boot = randomBytes(8).toString("hex");
  const memory_gb = Math.round(totalmem() / 1024 ** 3);
  const files = new Map<string, FileOf>(rows.map((row) => [row.id, { state: "absent", fetched_bytes: 0, failure: null, doing: null, failed: null, owed: false }]));
  const fileOf = (row: Row): FileOf => files.get(row.id)!;
  const running = new Map<string, Running>();
  let outbox: RunnerResult[] = [];
  let wanted: readonly string[] = [];
  const unsettled = new Set<Promise<void>>();
  const keep = (promise: Promise<void>): Promise<void> => {
    unsettled.add(promise);
    void promise.then(() => unsettled.delete(promise));
    return promise;
  };
  let say = (): void => undefined;
  let stopping = false;
  const stop = (why: string): void => {
    if (stopping) return;
    stopping = true;
    say();
    for (const each of running.values()) each.stop.abort(new Error(why));
    for (const file of files.values()) file.doing?.stop.abort(new Error(why));
  };
  signal.addEventListener("abort", () => stop("the runner stopped"), { once: true });
  if (signal.aborted) stop("the runner stopped");
  const name = options.name ?? await machineName();
  let power: { at: number; value: RunnerStated["power"] } = { at: -Infinity, value: null };
  let thermal: { at: number; value: RunnerStated["thermal"] } = { at: -Infinity, value: null };

  const stated = async (): Promise<RunnerStated> => {
    if (Date.now() - power.at > POWER_MS) power = { at: Date.now(), value: await (options.power ?? powerSource)() };
    if (Date.now() - thermal.at > POWER_MS) thermal = { at: Date.now(), value: await (options.thermal ?? thermalState)() };
    const idle_s = await (options.idle ?? idleSeconds)();
    const stating = rows.map((row): RunnerFile => {
      const { state, fetched_bytes, failure } = fileOf(row);
      return {
        id: row.id, name: row.name, input: row.input, output: row.output, tools: row.tools, context_tokens: row.context_tokens, thinking: row.thinking,
        bytes: row.bytes, languages: row.languages, memory_gb: row.memory_gb, state, fetched_bytes, failure,
        ...(row.library === "detector" ? { detector: row.key } : {}),
      };
    });
    return { name, version: RUNNER_WIRE_VERSION, boot, slots: SLOTS, power: power.value, idle_s, thermal: thermal.value, memory_gb, running: [...running.keys()], files: stating };
  };

  async function documentWait(): Promise<RunnerWait | null> {
    power = { at: Date.now(), value: await (options.power ?? powerSource)() };
    if (power.value === "battery") return "battery";
    const idle_s = await (options.idle ?? idleSeconds)();
    return idle_s === null || idle_s < DOCUMENT_IDLE_S ? "in_use" : null;
  }

  async function result(call: RunnerCall, stop: AbortController): Promise<RunnerResult> {
    const row = rows.find((each) => each.id === call.model);
    if (row === undefined || fileOf(row).state !== "ready") return { id: call.id, error: { code: "NOT_READY", model: call.model } };
    if (call.warm === true && row.library !== "speech") {
      log(`runner: a warm call ${call.id} names ${row.id}, which transcribes nothing`);
      return { id: call.id, error: { code: "FAILED", reason: "failed", model: row.id } };
    }
    const waits = !("embed" in row) || row.embed === undefined || embedAskOf(call.input)?.role !== "document" ? null : await documentWait();
    if (waits !== null) return { id: call.id, error: { code: "BUSY", reason: waits, model: row.id } };
    try {
      return { id: call.id, ok: await options.libraries[row.library].run(row, call, stop.signal) };
    } catch (error) {
      if (error instanceof NotReady) {
        log(`runner: ${row.id} is not ready: ${error.message}`);
        if (fileOf(row).state === "ready") Object.assign(fileOf(row), { state: "absent", fetched_bytes: 0 });
        reconcile();
        return { id: call.id, error: { code: "NOT_READY", model: row.id } };
      }
      log(`runner: call ${call.id} on ${row.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof Failed) return { id: call.id, error: { code: "FAILED", reason: error.reason, model: row.id, ...(error.seconds === undefined ? {} : { seconds: error.seconds }) } };
      return { id: call.id, error: { code: "FAILED", reason: "failed", model: row.id } };
    }
  }

  function run(call: RunnerCall): void {
    const held: Running = { stop: new AbortController(), cancelled: null };
    running.set(call.id, held);
    keep(result(call, held.stop).then((made) => {
      running.delete(call.id);
      if (held.cancelled === null) outbox.push(made);
      else if (Date.now() - held.cancelled > STOP_MS) log(`runner: call ${call.id} took ${Date.now() - held.cancelled} ms to stop`);
      say();
    }));
  }

  const resting = (file: FileOf, op: "fetch" | "remove"): boolean => file.failed?.op === op && Date.now() - file.failed.at_ms < restMs;

  function begin(row: Row, op: "fetch" | "remove"): void {
    const file = fileOf(row);
    const stop = new AbortController();
    const library = options.libraries[row.library];
    Object.assign(file, op === "fetch" ? { state: "fetching", fetched_bytes: 0, failure: null } : { state: "absent", fetched_bytes: 0, failure: null, owed: true });
    const work = op === "fetch" ? library.fetch(row, (bytes) => { file.fetched_bytes = bytes; }, stop.signal) : library.remove(row, stop.signal);
    const done = keep(work.then(() => {
      Object.assign(file, op === "fetch" ? { state: "ready", fetched_bytes: row.bytes } : {}, { failed: null, owed: false });
    }, (error: unknown) => {
      if (stop.signal.aborted) {
        if (op === "fetch") Object.assign(file, { state: "absent", fetched_bytes: 0, owed: true });
        return;
      }
      log(`runner: ${op === "fetch" ? "fetching" : "removing"} ${row.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (op === "fetch") Object.assign(file, { state: "failed", failure: failureOf(error) });
      file.failed = { op, at_ms: Date.now() };
    }).finally(() => {
      file.doing = null;
      reconcile();
      say();
    }));
    file.doing = { op, stop, done };
  }

  function reconcile(): void {
    if (stopping) return;
    for (const row of rows) {
      const file = fileOf(row);
      if (wanted.includes(row.id)) {
        if (file.doing !== null || file.state === "ready" || file.state === "fetching") continue;
        if ((file.state === "failed" && file.failure !== null && !heals(file.failure)) || resting(file, "fetch")) continue;
        begin(row, "fetch");
      } else if (file.doing?.op === "fetch") {
        file.doing.stop.abort(new Error("no longer wanted"));
      } else if (file.doing === null && (file.state !== "absent" || file.owed) && !resting(file, "remove")) {
        begin(row, "remove");
      }
    }
  }

  function apply(handed: RunnerHanded): void {
    if (stopping) return;
    for (const id of handed.cancel) {
      const held = running.get(id);
      if (held !== undefined && held.cancelled === null) {
        held.cancelled = Date.now();
        held.stop.abort(new Error("the home ended the call"));
      }
      outbox = outbox.filter((made) => made.id !== id);
    }
    for (const call of handed.calls) if (!running.has(call.id)) run(call);
    wanted = handed.files;
    reconcile();
  }

  let away: string | null = null;
  while (!stopping) {
    const cut = new AbortController();
    say = () => cut.abort();
    const fetching = [...files.values()].some((file) => file.doing?.op === "fetch");
    const tick = fetching ? setTimeout(say, FETCHING_MS) : undefined;
    const sent = outbox.slice();
    try {
      const body: RunnerExchange = { runner: await stated(), results: sent };
      const response = await fetch(new URL(RUNNER_EXCHANGE, options.door), {
        method: "POST", signal: cut.signal, body: JSON.stringify(body),
        headers: { "content-type": "application/json", authorization: `Bearer ${readFileSync(options.pass, "utf8").trim()}`, "lifestream-device": `runner/${RUNNER_WIRE_VERSION}` },
      });
      const answer = await response.json().catch(() => null) as unknown;
      const code = (answer as { code?: unknown } | null)?.code;
      if (response.status === 409 && code === "SUPERSEDED") {
        log("runner: a later start of this runner serves its pass: this one stops");
        stop("a later start of the runner serves its pass");
        break;
      }
      if (response.status !== 200 || !isHanded(answer)) throw new Error(`the door answered ${response.status}${typeof code === "string" ? ` ${code}` : ""}`);
      if (away !== null) log("runner: the door answers again");
      away = null;
      outbox = outbox.filter((made) => !sent.includes(made));
      apply(answer);
    } catch (error) {
      if (cut.signal.aborted) continue;
      const why = error instanceof Error ? error.message : String(error);
      if (why !== away) log(`runner: the exchange failed: ${why}`);
      away = why;
      await pause(retryMs, signal);
    } finally {
      clearTimeout(tick);
    }
  }
  stop("the runner stopped");
  const drained = Promise.all([...unsettled, ...[...new Set(Object.values(options.libraries))].map((library) => library.close())]);
  const drainMs = options.drain_ms ?? DRAIN_MS;
  if (!await within(drained, drainMs)) log(`runner: work still running ${drainMs} ms after the stop: it ends with the process`);
}

async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([promise.then(() => true, () => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]);
  clearTimeout(timer);
  return settled;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function machineName(): Promise<string> {
  if (process.platform !== "darwin") return Promise.resolve(hostname());
  return new Promise((resolve) => execFile("/usr/sbin/scutil", ["--get", "ComputerName"], { timeout: 5_000 }, (error, out) => resolve(error === null && out.trim() !== "" ? out.trim() : hostname())));
}

function powerSource(): Promise<RunnerStated["power"]> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => execFile("/usr/bin/pmset", ["-g", "batt"], { timeout: 5_000 }, (error, out) => resolve(error === null ? powerOf(out) : null)));
}

export function powerOf(pmset: string): RunnerStated["power"] {
  if (!pmset.includes("InternalBattery")) return null;
  const from = /drawing from '([^']+)'/u.exec(pmset)?.[1];
  return from === "AC Power" ? "mains" : from === "Battery Power" ? "battery" : null;
}

function idleSeconds(): Promise<RunnerStated["idle_s"]> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => execFile("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4", "-r", "-k", "HIDIdleTime"], { timeout: 5_000 }, (error, out) => resolve(error === null ? idleOf(out) : null)));
}

export function idleOf(ioreg: string): RunnerStated["idle_s"] {
  const nanoseconds = /"HIDIdleTime" = (\d+)/u.exec(ioreg)?.[1];
  return nanoseconds === undefined ? null : Math.floor(Number(nanoseconds) / 1e9);
}

function thermalState(): Promise<RunnerStated["thermal"]> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => execFile("/usr/bin/pmset", ["-g", "therm"], { timeout: 5_000 }, (error, out) => resolve(error === null ? thermalOf(out) : null)));
}

export function thermalOf(pmset: string): RunnerStated["thermal"] {
  const levels = [...pmset.matchAll(/(?:thermal|performance) warning level[^\d\n]*(\d+)/giu)].map((match) => Number(match[1]));
  const speed = /CPU_Speed_Limit\s*=\s*(\d+)/u.exec(pmset)?.[1];
  if (levels.some((level) => level > 0) || (speed !== undefined && Number(speed) < 100)) return "elevated";
  if (levels.length > 0 || speed !== undefined || /no thermal warning level has been recorded/iu.test(pmset)) return "nominal";
  return null;
}
