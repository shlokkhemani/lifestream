import { SHARE_ENV, Worker } from "node:worker_threads";
import type { HomeFolder, JsonObject } from "@lifestreamprotocol/core";
import type { VerifiedIosBundle } from "@lifestreamprotocol/connect";
import type { Epoch } from "@lifestreamprotocol/model";
import { detachWorker, takeWorker, workerKey } from "./idle-workers.js";
import { parkableRegistry, threadProgram } from "./programs.js";
import type { Ask, PreparedAsk, Reply } from "./reads.js";
import type { FromReader, Ran, Short, Timed, ToReader } from "./reader.js";
import { notNowRefusal, Refusal, RETRY_FULL_S, RETRY_S } from "./refusal.js";

export interface Readers {
  ask(pathname: string, served: Served, signal: AbortSignal): Promise<{ reply: Reply; epoch: number; read?: { timed: Timed | null; queued_ms: number } }>;
  bundle(path: string): Promise<VerifiedIosBundle>;
  read<T>(short: Short, options?: { signal?: AbortSignal }): Promise<T>;
  leaving<T>(short: Short, signal?: AbortSignal): Promise<T>;
  here<T>(name: string, read: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
  deadline(name: string): Deadline;
  depth(): number;
  peak(): number;
  close(reason: Error): Promise<void>;
}

export interface Served {
  prepared?: () => PreparedAsk;
  computed?: { key: string; ask: () => Ask };
}

export interface Deadline {
  readonly reached: Promise<void>;
  end(): void;
}

export class ReadFailed extends Error {
  constructor(message: string, readonly timed: Timed | null) {
    super(message);
  }
}

export const ERASING_WORDS = "Lifestream is erasing something: try again in a minute.";

const THREADS = 3;
const LONG = 2;
export const READ_MS = 45_000;
export type ReadBound = number | ((name: string, letGo: Promise<void>) => Promise<void>);
const CUT_WORDS = "Lifestream took too long to read this: try again in a few minutes.";
export const BUSY_WORDS = "Lifestream is busy with other reads: try again in a minute.";
const END_MS = 10_000;
const BOOT_DETACH_MS = 2_000;

class Reached extends Error {}

const atBound = (held: boolean): Refusal => held ? notNowRefusal("busy", CUT_WORDS, RETRY_FULL_S) : notNowRefusal("busy", BUSY_WORDS, RETRY_S);

type Asked = { pathname: string; ask: () => Ask } | { bundle: string } | { short: Short };

interface Thread {
  worker: Worker;
  key: string;
  held: Waiting | null;
  up: boolean;
  ending: boolean;
  cut: string | null;
  route: string | null;
  gone: Promise<void>;
}

type Joined = { resolve(answer: FromReader): void; reject(error: Error): void };

interface SharedBound {
  readonly reached: Promise<void>;
  hold(): () => void;
}

interface Waiting {
  id: number;
  asked: Asked;
  key?: string;
  joined: Set<Joined>;
  asked_at: number;
  queued_ms?: number;
  unbind?(): void;
}

const nameOf = (asked: Asked): string =>
  "pathname" in asked ? asked.pathname : "bundle" in asked ? "bundle" : "prepared" in asked.short ? asked.short.prepared : Object.keys(asked.short)[0]!;

export function openReaders(
  folder: HomeFolder, machine: string, registry: string | undefined, log: (line: JsonObject) => void, epoch: () => Promise<Epoch>, statements?: (ran: Ran[]) => void, bound: ReadBound = READ_MS, readWaitMs?: number,
): Readers {
  const queue: Waiting[] = [];
  const waitingBy = new Map<string, Waiting>();
  const threads: Thread[] = [];
  let next = 0;
  let closed = false;
  let closedFor: Error | undefined;
  let high = 0;

  const end = (thread: Thread): void => {
    thread.ending = true;
    if (thread.up) void thread.worker.terminate().catch(() => undefined);
  };

  const spawn = (): Thread => {
    const program = threadProgram("reader");
    const key = `${workerKey(program)}\0${registry ?? ""}`;
    const worker = takeWorker(key) ?? new Worker(program.url, {
      env: SHARE_ENV,
      ...(program.execArgv === undefined ? {} : { execArgv: program.execArgv }),
    });
    const thread: Thread = { worker, key, held: null, up: false, ending: false, cut: null, route: null, gone: new Promise((resolve) => worker.once("exit", () => resolve())) };
    threads.push(thread);
    worker.on("message", (answer: FromReader | { up: true } | { detached: true }) => {
      if ("detached" in answer) return;
      if ("up" in answer) {
        thread.up = true;
        if (thread.ending) end(thread);
        return;
      }
      const held = thread.held;
      if (held === null || held.id !== answer.id) return;
      thread.held = null;
      thread.route = null;
      if (answer.ran !== undefined) statements?.(answer.ran);
      settle(held, (each) => each.resolve(answer));
      give();
    });
    const lost = (why: string) => {
      const index = threads.indexOf(thread);
      if (index < 0) return;
      threads.splice(index, 1);
      if (!closed || thread.cut !== null) log({ reader: "ended", why: thread.cut ?? why });
      if (thread.held !== null) settle(thread.held, (each) => each.reject(new Error(`the reader thread ended: ${why}`)));
      thread.held = null;
      give();
    };
    worker.on("error", (error) => {
      thread.cut ??= error.message;
      if (thread.held !== null) settle(thread.held, (each) => each.reject(new Error(`the reader thread ended: ${error.message}`)));
      thread.held = null;
    });
    worker.on("exit", (code) => lost(`exit ${code}`));
    worker.postMessage({
      attach: {
        root: folder.root, machine, handed: folder.handOver(),
        ...(registry === undefined ? {} : { registry }),
        ...(statements === undefined ? {} : { statements: true }),
        ...(readWaitMs === undefined ? {} : { readWaitMs }),
      },
    } satisfies ToReader);
    return thread;
  };

  const settle = (waiting: Waiting, each: (joined: Joined) => void): void => {
    waiting.unbind?.();
    for (const joined of waiting.joined) each(joined);
    waiting.joined.clear();
  };

  const leave = (waiting: Waiting): void => {
    queue.splice(queue.indexOf(waiting), 1);
    if (waiting.key !== undefined) waitingBy.delete(waiting.key);
  };

  const timer = (name: string): { reached: Promise<void>; end(): void } => {
    if (typeof bound !== "number") {
      let letGo = (): void => undefined;
      const gone = new Promise<void>((resolve) => { letGo = resolve; });
      return { reached: bound(name, gone), end: () => letGo() };
    }
    let clear = (): void => undefined;
    const reached = new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, bound);
      clear = () => clearTimeout(timeout);
    });
    return { reached, end: clear };
  };

  const arm = (waiting: Waiting, name: string, shared?: SharedBound): void => {
    let armed = true;
    const past = () => {
      if (!armed) return;
      armed = false;
      if (queue.includes(waiting)) {
        leave(waiting);
        settle(waiting, (each) => each.reject(atBound(false)));
        return;
      }
      const thread = threads.find((each) => each.held === waiting);
      if (thread === undefined) return;
      thread.held = null;
      thread.cut = `${name} read past ${typeof bound === "number" ? `${bound} ms` : "its bound"}`;
      settle(waiting, (each) => each.reject(atBound(true)));
      end(thread);
    };
    const own = shared === undefined ? timer(name) : { reached: shared.reached, end: shared.hold() };
    void own.reached.then(past);
    waiting.unbind = () => {
      armed = false;
      own.end();
    };
  };

  const give = (): void => {
    for (let index = 0; index < queue.length && !closed;) {
      const waiting = queue[index]!;
      const { id, asked } = waiting;
      if (!("short" in asked) && (threads.filter((each) => each.cut !== null || (each.held !== null && !("short" in each.held.asked))).length >= LONG
        || ("pathname" in asked && threads.some((each) => each.route === asked.pathname)))) {
        index++;
        continue;
      }
      const thread = threads.find((each) => each.held === null && each.cut === null && !each.ending) ?? (threads.length < THREADS ? spawn() : undefined);
      if (thread === undefined) return;
      leave(waiting);
      waiting.queued_ms = performance.now() - waiting.asked_at;
      let message: ToReader;
      try {
        message = "pathname" in asked ? { id, pathname: asked.pathname, ask: asked.ask() } : { id, ...asked };
      } catch (error) {
        settle(waiting, (each) => each.reject(error as Error));
        continue;
      }
      thread.held = waiting;
      thread.route = "pathname" in asked ? asked.pathname : null;
      thread.worker.postMessage(message);
    }
  };

  const run = async (asked: Asked, options: { signal?: AbortSignal; key?: string; bound?: SharedBound } = {}): Promise<{ value: unknown; timed: Timed | null; queued_ms: number }> => {
    const { signal, key, bound: shared } = options;
    if (signal?.aborted) throw signal.reason instanceof Reached ? atBound(false) : signal.reason as Error;
    if (closed) throw closedFor ?? new Error("the door's readers are closed");
    const joins = key === undefined ? undefined : waitingBy.get(key);
    const waiting: Waiting = joins ?? { id: next++, asked, ...(key === undefined ? {} : { key }), joined: new Set(), asked_at: performance.now() };
    let abort = (): void => undefined;
    const answer = await new Promise<FromReader>((resolve, reject) => {
      const joined: Joined = { resolve, reject };
      waiting.joined.add(joined);
      abort = () => {
        waiting.joined.delete(joined);
        reject(signal!.reason instanceof Reached ? atBound(!queue.includes(waiting)) : signal!.reason as Error);
        if (waiting.joined.size > 0 || !queue.includes(waiting)) return;
        leave(waiting);
        waiting.unbind?.();
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (joins !== undefined) return;
      if (!("bundle" in asked)) arm(waiting, nameOf(asked), shared);
      queue.push(waiting);
      high = Math.max(high, queue.length);
      if (key !== undefined) waitingBy.set(key, waiting);
      give();
    }).finally(() => signal?.removeEventListener("abort", abort));
    const queued_ms = waiting.queued_ms ?? 0;
    if ("value" in answer) return { value: answer.value, timed: answer.timed ?? null, queued_ms };
    if ("refusal" in answer) {
      const { status, code, message, retryAfter, extra } = answer.refusal;
      throw new Refusal(status, code, message, retryAfter, extra);
    }
    throw new ReadFailed(answer.error, answer.timed ?? null);
  };

  const until = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason instanceof Reached ? atBound(false) : signal.reason as Error);
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
  });

  const checked = async <T>(name: string, attempt: (signal: AbortSignal, bound: SharedBound, epoch: number) => Promise<T>, signal: AbortSignal): Promise<T> => {
    const own = timer(name);
    let holding = 0;
    let returned = false;
    const shared: SharedBound = {
      reached: own.reached,
      hold() {
        holding++;
        let given = false;
        return () => {
          if (given) return;
          given = true;
          if (--holding === 0 && returned) own.end();
        };
      },
    };
    const cut = new AbortController();
    void own.reached.then(() => cut.abort(new Reached()));
    const left = () => cut.abort(signal.reason);
    if (signal.aborted) left();
    else signal.addEventListener("abort", left, { once: true });
    try {
      for (let tries = 1; ; tries++) {
        const before = await until(epoch(), cut.signal);
        let answered: { value: T } | { error: unknown } | undefined;
        if (!before.erasing) {
          try {
            answered = { value: await attempt(cut.signal, shared, before.epoch) };
          } catch (error) {
            if (cut.signal.aborted || !(error instanceof Refusal || error instanceof ReadFailed)) throw error;
            answered = { error };
          }
        }
        const after = await until(epoch(), cut.signal);
        if (answered !== undefined && !after.erasing && before.epoch === after.epoch) {
          if ("error" in answered) throw answered.error;
          return answered.value;
        }
        if (tries === 2) throw notNowRefusal("busy", ERASING_WORDS, RETRY_S);
      }
    } finally {
      returned = true;
      if (holding === 0) own.end();
      signal.removeEventListener("abort", left);
    }
  };

  return {
    ask: (pathname, served, signal) => checked(pathname, async (cut, bound, epoch) => {
      if (served.prepared !== undefined) {
        const reply = (await run({ short: { prepared: pathname, ask: served.prepared() } }, { signal: cut, bound })).value as Reply | undefined;
        if (reply !== undefined) return { reply, epoch };
      }
      if (served.computed === undefined) throw new Error(`no read route answers ${pathname}`);
      const computed = served.computed;
      const { value, timed, queued_ms } = await run({ pathname, ask: () => ({ ...computed.ask(), epoch }) }, { signal: cut, key: `${computed.key}\0${epoch}`, bound });
      return { reply: value as Reply, epoch, read: { timed, queued_ms } };
    }, signal),
    bundle: async (path) => (await run({ bundle: path })).value as VerifiedIosBundle,
    read: async <T>(short: Short, options: { signal?: AbortSignal } = {}) => (await run({ short }, options)).value as T,
    leaving: <T>(short: Short, signal?: AbortSignal) => checked(nameOf({ short }), async (cut, bound) => (await run({ short }, { signal: cut, bound })).value as T, signal ?? new AbortController().signal),
    here: <T>(name: string, read: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => checked(name, (cut) => read(cut), signal ?? new AbortController().signal),
    deadline: (name) => timer(name),
    depth: () => queue.length,
    peak: () => {
      const peak = high;
      high = queue.length;
      return peak;
    },
    async close(reason) {
      closed = true;
      closedFor = reason;
      waitingBy.clear();
      for (const waiting of queue.splice(0)) settle(waiting, (each) => each.reject(reason));
      const canPark = parkableRegistry(registry) && process.env.LIFESTREAM_FAILPOINT === undefined;
      const parked: Promise<void>[] = [];
      const terminating: Thread[] = [];
      for (const thread of [...threads]) {
        const idle = canPark && thread.held === null && thread.cut === null && !thread.ending;
        if (thread.held !== null) settle(thread.held, (each) => each.reject(reason));
        thread.held = null;
        if (idle) {
          const index = threads.indexOf(thread);
          if (index >= 0) threads.splice(index, 1);
          parked.push(detachWorker(thread.key, thread.worker, { detach: true } satisfies ToReader, (reply) => typeof reply === "object" && reply !== null && "detached" in reply, thread.up ? 500 : BOOT_DETACH_MS));
        } else {
          end(thread);
          terminating.push(thread);
        }
      }
      let wait: NodeJS.Timeout | undefined;
      const waited = new Promise<void>((resolve) => { wait = setTimeout(resolve, END_MS); });
      await Promise.race([Promise.all([...parked, ...terminating.map((thread) => thread.gone)]), waited]);
      clearTimeout(wait);
      for (const thread of terminating) thread.worker.unref();
    },
  };
}
