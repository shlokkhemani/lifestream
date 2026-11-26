import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  BEAT_MS, CALL_BYTES, CALL_SILENT_MS, CHAT_LINE, endedOf, EXCHANGE_BYTES, EXCHANGE_SILENT_MS, FIND_HANDED, FIND_LINES, FIND_PASSAGES, isPlaced, isResult, isStated, POLL_MS, PRESENCE_MS, RUNNER_CALLS,
  readRouteId, RUNNER_EXCHANGE, RUNNER_TRANSPORT, runnerInfo, RUNNERS, type CallLine, type FindLine, type RunnerCall, type RunnerEnded, type RunnerError, type RunnerHanded, type RunnerBelow, type RunnerInfo, type RunnersListed, type RunnerListing, type RunnerPlaced, type RunnerResult,
} from "@lifestreamprotocol/model";
import type { JsonObject } from "@lifestreamprotocol/core";
import { WORK_MEMBER } from "./models.js";
import { answerHeld, jsonOf, openPeers, type Hand, type Peer, type PeerWire } from "./peers.js";
import { Refusal, refuse } from "./refusal.js";


export function wantedOn(
  settings: { runners: Readonly<Record<string, { files?: readonly string[] }>>; defaults: Readonly<Record<string, string | null>>; connectors: Readonly<Record<string, JsonObject>> },
  runner: Pick<RunnerInfo, "unit" | "files">,
): string[] {
  const picks = [...Object.values(settings.defaults), ...Object.values(settings.connectors).flatMap((block) =>
    Object.entries(block).flatMap(([member, value]) => (member.startsWith(WORK_MEMBER) && typeof value === "string" ? [value] : [])))];
  const named = picks.flatMap((id) => {
    const route = id === null ? null : readRouteId(id);
    return route?.transport === RUNNER_TRANSPORT && route.runner === runner.unit && runner.files.some((file) => file.id === route.model) ? [route.model] : [];
  });
  return [...new Set([...settings.runners[runner.unit]?.files ?? [], ...named])];
}

export interface RunnersOptions {
  readonly wanted: (runner: RunnerInfo) => readonly string[];
  readonly poll_ms?: number;
  readonly presence_ms?: number;
  readonly silent_ms?: number;
  readonly reserved_ms?: number;
}

export const RESERVED_MS = 60_000;

export interface Runners extends PeerWire {
  place(placed: RunnerPlaced, signal: AbortSignal, handed?: () => void, ahead?: boolean): Promise<RunnerEnded>;
  reserve(note: string, runner: string): boolean;
  release(note: string): void;
  listing(): RunnerListing[];
  below(unit: string, version: string): void;
  close(): void;
}

interface RunnerKept {
  listed: string;
  told: ReadonlySet<string>;
}

type Runner = Peer<RunnerInfo> & RunnerKept;

type Slot = "models" | "detector";

interface Waiting {
  readonly unit: string;
  readonly call: RunnerCall;
  readonly slot: Slot;
  readonly rank: number;
  readonly order: number;
  readonly fore: boolean;
  readonly preempts: boolean;
  readonly settle: (ended: RunnerEnded) => void;
  readonly handed: () => void;
}

const FOREGROUND = -1;
const BACKGROUND = FIND_LINES.length;

const isFind = (line: CallLine | undefined): line is FindLine => line !== undefined && (FIND_LINES as readonly string[]).includes(line);

const LOOK_MS = 1_000;

const ended = (error: RunnerError): RunnerEnded => ({ error });

const refusal = (): Refusal => new Refusal(400, "BAD_CALL", `a call names its runner and states its model, input and attachments (each a media_type and base64); a find, its line (${FIND_LINES.join(", ")}) and the JSON of 1 to ${FIND_PASSAGES} passages, no attachment`);
const crossed = (): Refusal => new Refusal(400, "BAD_CALL", "a find goes to a detector's file, and a detector's file takes only finds");
const cold = (): Refusal => new Refusal(400, "BAD_CALL", "a warm call goes to a file that transcribes");

export function openRunners(options: RunnersOptions): Runners {
  const runners = openPeers<RunnerInfo, RunnerCall, RunnerResult | RunnerEnded, RunnerKept>({
    poll_ms: options.poll_ms ?? POLL_MS, presence_ms: options.presence_ms ?? PRESENCE_MS, noun: "runner",
    interrupted: (_id, cause, unit) => ended({ code: "INTERRUPTED", reason: cause, ...(unit === "" ? {} : { runner: unit }) }),
  });
  const presence_ms = options.presence_ms ?? PRESENCE_MS;
  const belowAt = new Map<string, RunnerBelow & { at_ms: number }>();
  const belowList = (): RunnerBelow[] => [...belowAt.values()].filter((each) => Date.now() - each.at_ms < presence_ms).sort((a, b) => (a.unit < b.unit ? -1 : 1))
    .map(({ unit, version }) => ({ unit, version }));
  const filesOf = (runner: Runner): string => JSON.stringify([...options.wanted(runner.info)]);
  let line: Waiting[] = [];
  let placed = 0;
  let closed = false;
  const foreground = new Set<string>();
  const preempted = new Map<string, string>();
  const reservations = new Map<string, { unit: string; until_ms: number }>();
  const reserved_ms = options.reserved_ms ?? RESERVED_MS;
  const reserved = (unit: string): boolean => [...reservations.values()].some((each) => each.unit === unit);

  const slotOf = (runner: Runner, model: string): Slot | null => {
    const file = runner.info.files.find((each) => each.id === model);
    return file === undefined ? null : file.detector === undefined ? "models" : "detector";
  };
  const free = (runner: Runner, slot: Slot): number => {
    const held = runners.pending(runner);
    const ids = new Set(held.map((call) => call.id));
    const there = held.filter((call) => (slotOf(runner, call.model) ?? slot) === slot).length;
    const running = runner.info.running.filter((id) => !ids.has(id));
    const stopping = slot === "models" ? [...preempted].filter(([id, unit]) => unit === runner.unit && !running.includes(id)).length : 0;
    return runner.info.slots - there - running.length - stopping;
  };

  const cancelOf = (runner: Runner): string[] => runner.info.running.filter((id) => !runners.holds(runner, id));

  function end(runner: Runner, id: string, result: RunnerEnded): void {
    if (!runners.holds(runner, id)) return;
    runners.end(runner, id, result);
    runners.wake(runner);
    drain(runner);
  }

  function unwait(id: string, result: RunnerEnded): boolean {
    const waiting = line.find((each) => each.call.id === id);
    if (waiting === undefined) return false;
    line = line.filter((each) => each !== waiting);
    waiting.settle(result);
    return true;
  }

  function handOn(runner: Runner, call: RunnerCall, fore: boolean, settle: (ended: RunnerEnded) => void): void {
    if (fore) foreground.add(call.id);
    runners.hand(runner, call, (result) => {
      foreground.delete(call.id);
      settle("id" in result ? endedOf(result) : result);
    });
  }

  function drain(runner: Runner): void {
    if (closed || !runners.present(runner)) return;
    for (const waiting of line.filter((each) => each.unit === runner.unit)) {
      const ready = runner.info.files.some((file) => file.id === waiting.call.model && file.state === "ready");
      if (!ready || slotOf(runner, waiting.call.model) !== waiting.slot) {
        unwait(waiting.call.id, ended({ code: "NOT_READY", model: waiting.call.model }));
        continue;
      }
      if (free(runner, waiting.slot) <= 0) continue;
      if (waiting.rank === BACKGROUND && reserved(runner.unit)) continue;
      line = line.filter((each) => each !== waiting);
      handOn(runner, waiting.call, waiting.fore, waiting.settle);
      waiting.handed();
    }
  }

  function preempt(runner: Runner): void {
    const waiting = line.filter((each) => each.unit === runner.unit && each.slot === "models" && each.preempts).length;
    const stopping = [...preempted.values()].filter((unit) => unit === runner.unit).length;
    let need = waiting - Math.max(0, free(runner, "models")) - stopping;
    for (const call of runners.pending(runner)) {
      if (need <= 0) return;
      if (foreground.has(call.id) || slotOf(runner, call.model) !== "models") continue;
      preempted.set(call.id, runner.unit);
      need--;
      end(runner, call.id, ended({ code: "INTERRUPTED", reason: "preempted", runner: runner.unit }));
    }
  }

  const looking = setInterval(() => {
    const now = Date.now();
    for (const [note, { unit, until_ms }] of reservations) {
      if (until_ms > now) continue;
      reservations.delete(note);
      const runner = runners.get(unit);
      if (runner !== undefined) drain(runner);
    }
    for (const runner of runners.peers()) {
      if (runners.waiting(runner) && filesOf(runner) !== runner.listed) runners.wake(runner);
      if (!runners.present(runner)) {
        for (const { id } of runners.pending(runner)) end(runner, id, ended({ code: "NO_RUNNER", runner: runner.unit }));
        for (const waiting of line.filter((each) => each.unit === runner.unit)) unwait(waiting.call.id, ended({ code: "NO_RUNNER", runner: runner.unit }));
        for (const [id, unit] of preempted) if (unit === runner.unit) preempted.delete(id);
      }
    }
  }, LOOK_MS);
  looking.unref();

  async function exchange(unit: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { runner: stated, results }: { runner?: unknown; results?: unknown } = await jsonOf(request, EXCHANGE_BYTES, options.silent_ms ?? EXCHANGE_SILENT_MS);
    if (!isStated(stated) || !Array.isArray(results) || !results.every(isResult)) {
      return refuse(400, "BAD_CALL", "an exchange states its runner (name, version, boot, slots, power, memory_gb, running, files) and its results");
    }
    belowAt.delete(unit);
    const { peer: runner } = runners.arrive(unit, runnerInfo(unit, stated), (): RunnerKept => ({ listed: "", told: new Set() }));
    for (const [id, of] of preempted) if (of === unit && !runner.info.running.includes(id)) preempted.delete(id);
    runners.settle(runner, results as RunnerResult[]);
    runners.rehand(runner);
    drain(runner);
    const send = (hand: Hand<RunnerCall>): Promise<void> => {
      if (response.destroyed) return Promise.resolve(void runners.giveBack(runner, hand));
      const { calls } = hand;
      const files = options.wanted(runner.info);
      const cancel = cancelOf(runner);
      runner.listed = JSON.stringify([...files]);
      runner.told = new Set(cancel);
      const answer: RunnerHanded = { calls, cancel, files };
      return answerHeld(response, 200, answer);
    };
    const untold = cancelOf(runner).some((id) => !runner.told.has(id));
    if (runners.queued(runner) > 0 || untold || filesOf(runner) !== runner.listed) return send(runners.take(runner));
    return send(await runners.wait(runner, response));
  }

  function refused(sent: unknown): Refusal | null {
    if (!isPlaced(sent)) return refusal();
    const runner = runners.get(sent.runner);
    const slot = runner === undefined ? null : slotOf(runner, sent.model);
    if (slot !== null && isFind(sent.line) !== (slot === "detector")) return crossed();
    const file = runner?.info.files.find((each) => each.id === sent.model);
    return sent.warm === true && file !== undefined && !file.input.includes("audio") ? cold() : null;
  }

  function place(sent: RunnerPlaced, signal: AbortSignal, handed: () => void = () => undefined, ahead = false): Promise<RunnerEnded> {
    const refusing = refused(sent);
    if (refusing !== null) return Promise.reject(refusing);
    const call: RunnerCall = {
      id: `r-${randomBytes(6).toString("hex")}`, model: sent.model, input: sent.input, ...(sent.schema === undefined ? {} : { schema: sent.schema }), attachments: sent.attachments,
      ...(sent.warm === true ? { warm: true } : {}),
    };
    const chat = sent.line === CHAT_LINE;
    const fore = chat || ahead;
    return new Promise<RunnerEnded>((answer) => {
      const gone = ended({ code: "INTERRUPTED", reason: "driver_gone", runner: sent.runner });
      const going = (): void => {
        const runner = runners.get(sent.runner);
        if (!unwait(call.id, gone) && runner !== undefined) end(runner, call.id, gone);
      };
      const resolve = (how: RunnerEnded): void => {
        signal.removeEventListener("abort", going);
        answer(how);
      };
      if (closed) return resolve(ended({ code: "INTERRUPTED", reason: "closed" }));
      if (signal.aborted) return resolve(gone);
      signal.addEventListener("abort", going, { once: true });
      const runner = runners.peers().find((each) => each.unit === sent.runner && runners.present(each));
      if (runner === undefined) return resolve(ended({ code: "NO_RUNNER", runner: sent.runner }));
      if (!runner.info.files.some((file) => file.id === sent.model && file.state === "ready")) return resolve(ended({ code: "NOT_READY", model: sent.model }));
      const slot = slotOf(runner, sent.model)!;
      const queued = line.some((each) => each.unit === runner.unit && each.slot === slot);
      const held = slot === "models" && !fore && reserved(runner.unit);
      if (!queued && !held && free(runner, slot) > 0) {
        handOn(runner, call, fore, resolve);
        return handed();
      }
      if (!isFind(sent.line) && !fore && !held) return resolve(ended({ code: "BUSY", model: sent.model }));
      const rank = isFind(sent.line) ? FIND_LINES.indexOf(sent.line) : fore ? FOREGROUND : BACKGROUND;
      const waiting: Waiting = { unit: runner.unit, call, slot, rank, order: placed++, fore, preempts: chat && sent.warm !== true, settle: resolve, handed };
      line = [...line, waiting].sort((a, b) => a.rank - b.rank || a.order - b.order);
      if (waiting.preempts) preempt(runner);
      drain(runner);
    });
  }

  async function placeSent(request: IncomingMessage, response: ServerResponse, held: FindLine | undefined): Promise<void> {
    const sent: unknown = await jsonOf(request, CALL_BYTES, options.silent_ms ?? CALL_SILENT_MS);
    if (held !== undefined && isPlaced(sent) && sent.line !== held) {
      refuse(403, "PRINCIPAL_SCOPE", `this pass places a find in the ${held} line, and nothing else: ${sent.line === undefined ? "a model's call" : `a find in the ${sent.line} line`} is refused`);
    }
    const refusing = refused(sent);
    if (refusing !== null) throw refusing;
    const placed = sent as RunnerPlaced;
    const driver = new AbortController();
    response.once("close", () => {
      if (!response.writableFinished) driver.abort();
    });
    let early = false;
    const tell = (): void => {
      if (!isFind(placed.line) || response.writableEnded || response.destroyed) return;
      if (response.headersSent) response.write(FIND_HANDED);
      else early = true;
    };
    const answering = answerHeld(response, 200, place(placed, driver.signal, tell), BEAT_MS);
    if (early) response.write(FIND_HANDED);
    return answering;
  }

  const listing = (): RunnerListing[] => runners.peers().map((runner) => ({ ...runner.info, present: runners.present(runner) }));

  return {
    half(method, pathname) {
      if (method === "POST" && pathname === RUNNER_EXCHANGE) return "peer";
      if ((method === "POST" && pathname === RUNNER_CALLS) || (method === "GET" && pathname === RUNNERS)) return "drive";
      return null;
    },
    async serve(caller, request, response) {
      const pathname = new URL(request.url ?? "/", "http://door").pathname;
      if ("peer" in caller) return exchange(caller.peer, request, response);
      if (pathname === RUNNER_CALLS) return placeSent(request, response, "drive" in caller ? caller.line : undefined);
      return answerHeld(response, 200, { runners: listing(), below: belowList() } satisfies RunnersListed);
    },
    place,
    reserve(note, unit) {
      if (closed) return false;
      const was = reservations.get(note);
      reservations.set(note, { unit, until_ms: Date.now() + reserved_ms });
      if (was !== undefined && was.unit !== unit) {
        const left = runners.get(was.unit);
        if (left !== undefined) drain(left);
      }
      return was?.unit !== unit;
    },
    release(note) {
      const was = reservations.get(note);
      if (was === undefined) return;
      reservations.delete(note);
      const runner = runners.get(was.unit);
      if (runner !== undefined) drain(runner);
    },
    listing,
    below(unit, version) {
      belowAt.set(unit, { unit, version, at_ms: Date.now() });
    },
    close() {
      closed = true;
      clearInterval(looking);
      for (const waiting of line) waiting.settle(ended({ code: "INTERRUPTED", reason: "closed", runner: waiting.unit }));
      line = [];
      reservations.clear();
      preempted.clear();
      runners.close();
    },
  };
}
