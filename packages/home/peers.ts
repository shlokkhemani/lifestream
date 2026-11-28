import type { IncomingMessage, ServerResponse } from "node:http";
import { isObject, type JsonObject } from "@lifestreamprotocol/core";
import type { FindLine } from "@lifestreamprotocol/model";
import { notNow, refuse, RETRY_SOON_S } from "./refusal.js";
import { bodyOf } from "./silence.js";


export type PeerCaller = { readonly peer: string; readonly pass?: string } | { readonly drive: true; readonly line?: FindLine };

export interface PeerWire {
  half(method: string | undefined, pathname: string): "peer" | "drive" | null;
  serve(caller: PeerCaller, request: IncomingMessage, response: ServerResponse): Promise<void>;
}

export interface Statement {
  readonly boot: string;
  readonly running: readonly string[];
}

export interface Handable {
  readonly id: string;
}

export interface Hand<C> {
  readonly id: number;
  readonly calls: C[];
}

export interface Fenced {
  readonly id: string;
  readonly why: "taken" | "ended";
}

export interface Peer<S extends Statement> {
  readonly unit: string;
  readonly info: S;
  readonly seen: number;
}

export interface PeersOptions<R> {
  readonly poll_ms?: number;
  readonly presence_ms?: number;
  readonly noun: string;
  readonly interrupted: (id: string, cause: "closed" | "restarted", unit: string) => R;
}

export interface Peers<S extends Statement, C extends Handable, R, X> {
  peers(): (Peer<S> & X)[];
  get(unit: string): (Peer<S> & X) | undefined;
  present(peer: Peer<S>): boolean;
  waiting(peer: Peer<S>): boolean;
  arrive(unit: string, info: S, extra: () => X): { peer: Peer<S> & X; again: boolean; was: boolean; retired: string[] };
  settle<T extends R & Handable>(peer: Peer<S>, results: readonly T[]): T[];
  rehand(peer: Peer<S>): string[];
  hand(peer: Peer<S>, call: C, settle: (result: R) => void): void;
  offer(call: C, pick: (present: (Peer<S> & X)[]) => (Peer<S> & X) | { readonly refused: R }, settle: (result: R) => void): (Peer<S> & X) | null;
  end(peer: Peer<S>, id: string, result: R): void;
  pending(peer: Peer<S>): C[];
  unhanded(peer: Peer<S>): C[];
  holds(peer: Peer<S>, id: string): boolean;
  take(peer: Peer<S>): Hand<C>;
  giveBack(peer: Peer<S>, hand: Hand<C>): Fenced[];
  queued(peer: Peer<S>): number;
  wait(peer: Peer<S>, response: ServerResponse): Promise<Hand<C>>;
  wake(peer?: Peer<S>): void;
  close(): void;
}

const REPLACED_KEPT = 8;

interface Slot<S extends Statement, C, R, X> {
  readonly peer: { unit: string; info: S; seen: number } & X;
  queue: C[];
  readonly pending: Map<string, { readonly call: C; readonly settle: (result: R) => void; hand: number | null }>;
  waiting: ((hand: Hand<C>) => void) | null;
  replaced: string[];
  hands: number;
}

export function openPeers<S extends Statement, C extends Handable, R, X>(options: PeersOptions<R>): Peers<S, C, R, X> {
  const pollMs = options.poll_ms ?? 25_000;
  const presenceMs = options.presence_ms ?? 90_000;
  const slots = new Map<string, Slot<S, C, R, X>>();
  let closed = false;
  const slotOf = (peer: Peer<S>): Slot<S, C, R, X> => slots.get(peer.unit)!;
  const present = (peer: Peer<S>): boolean => slotOf(peer).waiting !== null || Date.now() - peer.seen < presenceMs;
  const taken = (slot: Slot<S, C, R, X>, calls: C[]): Hand<C> => {
    const id = ++slot.hands;
    for (const call of calls) {
      const pending = slot.pending.get(call.id);
      if (pending !== undefined) pending.hand = id;
    }
    return { id, calls };
  };
  const answerWaiting = (slot: Slot<S, C, R, X>, calls: boolean): void => {
    const waiting = slot.waiting;
    if (waiting === null) return;
    slot.waiting = null;
    waiting(taken(slot, calls ? slot.queue.splice(0) : []));
  };
  const end = (slot: Slot<S, C, R, X>, id: string, result: R): void => {
    const pending = slot.pending.get(id);
    if (pending === undefined) return;
    slot.pending.delete(id);
    slot.queue = slot.queue.filter((queued) => queued.id !== id);
    pending.settle(result);
  };
  const hand = (peer: Peer<S>, call: C, settle: (result: R) => void): void => {
    if (closed) return settle(options.interrupted(call.id, "closed", peer.unit));
    const slot = slotOf(peer);
    slot.pending.set(call.id, { call, settle, hand: null });
    slot.queue.push(call);
    answerWaiting(slot, true);
  };
  return {
    peers: () => [...slots.values()].map((slot) => slot.peer),
    get: (unit) => slots.get(unit)?.peer,
    present,
    waiting: (peer) => slotOf(peer).waiting !== null,
    arrive(unit, info, extra) {
      if (closed) notNow("busy", "The door is stopping: it is asked again in a moment.", RETRY_SOON_S);
      const known = slots.get(unit);
      if (known?.replaced.includes(info.boot)) refuse(409, "SUPERSEDED", `a later start of ${options.noun} ${unit} serves its pass: this one stops`);
      const slot: Slot<S, C, R, X> = known ?? { peer: Object.assign({ unit, info, seen: 0 }, extra()), queue: [], pending: new Map(), waiting: null, replaced: [], hands: 0 };
      const was = known !== undefined && present(known.peer);
      answerWaiting(slot, false);
      const before = known?.peer.info.boot;
      const again = before !== undefined && before !== info.boot;
      slot.peer.info = info;
      slot.peer.seen = Date.now();
      slots.set(unit, slot);
      const retired: string[] = [];
      if (again) {
        slot.replaced = [...slot.replaced, before].slice(-REPLACED_KEPT);
        const kept = new Set([...slot.queue.map((call) => call.id), ...info.running]);
        for (const id of [...slot.pending.keys()]) {
          if (kept.has(id)) continue;
          retired.push(id);
          end(slot, id, options.interrupted(id, "restarted", unit));
        }
      }
      return { peer: slot.peer, again, was, retired };
    },
    settle(peer, results) {
      const slot = slotOf(peer);
      return results.filter((result) => {
        if (!slot.pending.has(result.id)) return true;
        end(slot, result.id, result);
        return false;
      });
    },
    rehand(peer) {
      const slot = slotOf(peer);
      const held = new Set(peer.info.running);
      const queued = new Set(slot.queue.map((call) => call.id));
      const again: string[] = [];
      for (const [id, pending] of slot.pending) {
        if (held.has(id) || queued.has(id)) continue;
        pending.hand = null;
        slot.queue.push(pending.call);
        again.push(id);
      }
      return again;
    },
    hand,
    offer(call, pick, settle) {
      if (closed) {
        settle(options.interrupted(call.id, "closed", ""));
        return null;
      }
      const chosen = pick([...slots.values()].map((slot) => slot.peer).filter(present));
      if ("refused" in chosen) {
        settle(chosen.refused);
        return null;
      }
      hand(chosen, call, settle);
      return chosen;
    },
    end: (peer, id, result) => end(slotOf(peer), id, result),
    pending: (peer) => [...slotOf(peer).pending.values()].map(({ call }) => call),
    unhanded: (peer) => [...slotOf(peer).queue],
    holds: (peer, id) => slotOf(peer).pending.has(id),
    take(peer) {
      const slot = slotOf(peer);
      return taken(slot, slot.queue.splice(0));
    },
    giveBack(peer, hand) {
      if (closed) return [];
      const slot = slotOf(peer);
      const fenced: Fenced[] = [];
      const back: C[] = [];
      for (const call of hand.calls) {
        const pending = slot.pending.get(call.id);
        if (pending === undefined) fenced.push({ id: call.id, why: "ended" });
        else if (pending.hand !== hand.id) fenced.push({ id: call.id, why: "taken" });
        else {
          pending.hand = null;
          back.push(call);
        }
      }
      slot.queue.unshift(...back);
      return fenced;
    },
    queued: (peer) => slotOf(peer).queue.length,
    async wait(peer, response) {
      const slot = slotOf(peer);
      if (closed || response.destroyed) return taken(slot, []);
      return new Promise<Hand<C>>((resolve) => {
        const timer = setTimeout(() => {
          if (slot.waiting === settle) slot.waiting = null;
          resolve(taken(slot, []));
        }, pollMs);
        const settle = (handed: Hand<C>): void => {
          clearTimeout(timer);
          resolve(handed);
        };
        slot.waiting = settle;
        response.once("close", () => {
          if (slot.waiting !== settle) return;
          slot.waiting = null;
          settle(taken(slot, []));
        });
      });
    },
    wake(peer) {
      for (const slot of peer === undefined ? slots.values() : [slotOf(peer)]) answerWaiting(slot, false);
    },
    close() {
      closed = true;
      for (const slot of slots.values()) {
        for (const id of [...slot.pending.keys()]) end(slot, id, options.interrupted(id, "closed", slot.peer.unit));
        slot.queue = [];
        answerWaiting(slot, false);
      }
    },
  };
}

export async function answerHeld(response: ServerResponse, status: number, value: unknown, beat_ms = 20_000): Promise<void> {
  if (!(value instanceof Promise)) {
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    return;
  }
  response.writeHead(status, { "content-type": "application/json" }).flushHeaders();
  const beat = setInterval(() => response.write("\n"), beat_ms);
  response.once("close", () => clearInterval(beat));
  try {
    response.end(JSON.stringify(await value));
  } finally {
    clearInterval(beat);
  }
}

export async function jsonOf(request: IncomingMessage, limit: number, silent_ms: number): Promise<JsonObject> {
  const read = await bodyOf(request, limit, silent_ms);
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.toString("utf8"));
  } catch {
    return refuse(400, "BAD_CALL", "the body is not a JSON object");
  }
  return isObject(parsed) ? parsed : refuse(400, "BAD_CALL", "the body is not a JSON object");
}
