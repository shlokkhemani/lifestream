import {
  FIND_HANDED, FIND_PASSAGES, findAnswerOf, listRunners, readRouteId, RUNNER_CALLS, type FindLine, type RunnerCode, type RunnerEnded, type RunnerListing, type RunnerPlaced,
} from "@lifestreamprotocol/model";
import { textHead } from "@lifestreamprotocol/core";
import type { Detector, DetectorState } from "@lifestreamprotocol/privacy";
import { fileLine, runnerLine } from "./models.js";
import { Refusal } from "./refusal.js";


export type DetectorCode = RunnerCode | "OFF" | "TIMEOUT" | "NO_DOOR" | "REFUSED" | "BAD_ANSWER";

export class DetectorError extends Error {
  override name = "DetectorError";

  constructor(readonly code: DetectorCode, message: string) {
    super(message);
  }
}

export class DriveRefused extends Error {
  override name = "DriveRefused";

  constructor(readonly status: number, readonly words: string) {
    super(`the door refused the call: ${status} ${words}`);
  }
}

export interface DriveHalf {
  place(placed: RunnerPlaced, signal: AbortSignal, handed: () => void): Promise<RunnerEnded>;
  list(): Promise<readonly RunnerListing[]>;
}

export interface DetectorOptions {
  chosen: () => string | null;
  line: FindLine;
  drive: DriveHalf;
  timeout_ms?: number;
  wait_ms?: number;
  fresh_ms?: number;
  clock?: () => number;
}

const TIMEOUT_MS = 5 * 60_000;
const WAIT_MS = 60 * 60_000;
const FRESH_MS = 2_000;

const OFF = "No model is chosen for Hiding details";

const text = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function hidingPick(id: string): { unit: string; file: string } | null {
  const route = readRouteId(id);
  return route?.runner === undefined ? null : { unit: route.runner, file: route.model };
}

function stateOf(id: string, runners: readonly RunnerListing[]): { state: DetectorState; code: "NO_RUNNER" | "NOT_READY" } {
  const pick = hidingPick(id);
  if (pick === null) return { state: { state: "absent", why: `${id} is no runner's model: Hiding details runs on a runner` }, code: "NOT_READY" };
  const runner = runners.find((each) => each.unit === pick.unit);
  if (runner === undefined) return { state: { state: "absent", why: "The machine chosen to run the hiding model has not been heard from" }, code: "NO_RUNNER" };
  const away = runnerLine(runner);
  if (away !== null) return { state: { state: "absent", why: away }, code: "NO_RUNNER" };
  const file = runner.files.find((each) => each.id === pick.file && each.detector !== undefined);
  if (file === undefined) return { state: { state: "absent", why: `${runner.name} cannot run the hiding model` }, code: "NOT_READY" };
  if (file.state === "fetching") return { state: { state: "downloading", bytes: file.fetched_bytes, total: file.bytes }, code: "NOT_READY" };
  const why = fileLine(file);
  if (why !== null) return { state: { state: "absent", why: `Hiding model on ${runner.name}: ${why}` }, code: "NOT_READY" };
  return { state: { state: "ready", model: { id: file.id, file: file.detector!.file, decode: file.detector!.decode } }, code: "NOT_READY" };
}

export function hidingFile(runners: readonly RunnerListing[], chosen: string | null): string | null {
  const pick = chosen === null ? null : hidingPick(chosen);
  if (pick !== null && runners.some((runner) => runner.unit === pick.unit && runner.files.some((file) => file.id === pick.file && file.detector !== undefined))) return pick.file;
  return runners.flatMap((runner) => runner.files).find((file) => file.detector !== undefined)?.id ?? null;
}

export function openDetector(options: DetectorOptions): Detector {
  const clock = options.clock ?? Date.now;
  const freshMs = options.fresh_ms ?? FRESH_MS;
  const timeoutMs = options.timeout_ms ?? TIMEOUT_MS;
  const waitMs = options.wait_ms ?? WAIT_MS;
  let held: { at: number; runners: readonly RunnerListing[] } | { at: number; error: string } | null = null;
  let reading: Promise<readonly RunnerListing[]> | null = null;

  function list(): Promise<readonly RunnerListing[]> {
    reading ??= options.drive.list().then((runners) => {
      held = { at: clock(), runners };
      return runners;
    }, (error: unknown) => {
      held = { at: clock(), error: text(error) };
      throw error;
    }).finally(() => { reading = null; });
    return reading;
  }

  return {
    state() {
      const chosen = options.chosen();
      if (chosen === null) return { state: "off" };
      if (held === null || clock() - held.at >= freshMs) list().catch(() => undefined);
      if (held === null) return { state: "absent", why: "Looking for the machine that runs the hiding model" };
      if ("error" in held) return { state: "absent", why: `Lifestream cannot list its runners: ${held.error}` };
      return stateOf(chosen, held.runners).state;
    },
    async find(passages, by) {
      if (passages.length > FIND_PASSAGES) throw new RangeError(`a find takes at most ${FIND_PASSAGES} passages, and was given ${passages.length}`);
      const chosen = options.chosen();
      if (chosen === null) throw new DetectorError("OFF", OFF);
      let runners: readonly RunnerListing[];
      try {
        runners = await list();
      } catch (error) {
        throw new DetectorError("NO_DOOR", `Lifestream cannot list its runners: ${text(error)}`);
      }
      const { state: stated, code } = stateOf(chosen, runners);
      if (stated.state !== "ready") throw new DetectorError(code, stated.state === "downloading" ? "The hiding model is downloading" : stated.state === "absent" ? stated.why : OFF);
      if (passages.length === 0) return { model: stated.model, marks: [] };
      const stop = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      let waiting: NodeJS.Timeout | undefined = setTimeout(() => stop.abort(new DetectorError("TIMEOUT", `the hiding model's line did not move within ${Math.round(waitMs / 60_000)} min`)), waitMs);
      const handed = (): void => {
        clearTimeout(waiting);
        waiting = undefined;
        timer ??= setTimeout(() => stop.abort(new DetectorError("TIMEOUT", `the hiding model did not answer within ${Math.round(timeoutMs / 1_000)} s`)), timeoutMs);
      };
      let end: RunnerEnded;
      try {
        end = await options.drive.place({ runner: hidingPick(chosen)!.unit, model: stated.model.id, input: JSON.stringify(passages), attachments: [], line: by === "mark" ? "mark" : options.line }, stop.signal, handed);
      } catch (error) {
        if (stop.signal.aborted) throw stop.signal.reason;
        if (error instanceof DetectorError) throw error;
        if (error instanceof DriveRefused) throw new DetectorError("REFUSED", `the door refused the hiding model's find: ${error.status} ${error.words}`);
        if (error instanceof Refusal) throw new DetectorError("REFUSED", `the door refused the hiding model's find: ${error.status} ${error.code}, ${error.words}`);
        throw new DetectorError("NO_DOOR", `the hiding model's find did not reach the door: ${text(error)}`);
      } finally {
        clearTimeout(timer);
        clearTimeout(waiting);
      }
      if (stop.signal.aborted) throw stop.signal.reason;
      if ("error" in end) {
        const { code: ended, reason } = end.error;
        throw new DetectorError(ended, `the hiding model's find ended ${ended}${reason === undefined ? "" : ` (${reason})`}`);
      }
      const found = findAnswerOf(end.ok.text, passages);
      if (found === null) throw new DetectorError("BAD_ANSWER", "the hiding model answered what no find answers");
      return {
        model: { id: end.ok.model, file: found.file, decode: found.decode },
        marks: found.marks.map((marks) => marks?.map(({ start, end: stop, type }) => ({ start, end: stop, type })) ?? null),
      };
    },
  };
}

export function driveHalf(door: string, passes: { readonly call: () => string | undefined; readonly drive: () => string | undefined }, fetcher: typeof fetch = fetch): DriveHalf {
  const at = door.replace(/\/+$/u, "");
  const pass = (name: "call" | "drive"): string => passes[name]() ?? (() => { throw new Error(`no ${name} pass is handed`); })();
  return {
    async place(placed, signal, handed) {
      const response = await fetcher(`${at}${RUNNER_CALLS}`, {
        method: "POST", headers: { authorization: `Bearer ${pass("call")}`, "content-type": "application/json" }, body: JSON.stringify(placed), signal,
      });
      if (response.status !== 200) {
        const words = await response.text().catch(() => "");
        throw new DriveRefused(response.status, textHead(words, 200));
      }
      const decoder = new TextDecoder();
      let body = "";
      let told = false;
      for await (const chunk of response.body!) {
        body += decoder.decode(chunk, { stream: true });
        if (!told && body.includes(FIND_HANDED)) {
          told = true;
          handed();
        }
      }
      body += decoder.decode();
      return JSON.parse(body.split("\n").filter((line) => line.trim() !== "").at(-1)!) as RunnerEnded;
    },
    list: () => listRunners(at, pass("drive"), fetcher).then(({ runners }) => runners),
  };
}
