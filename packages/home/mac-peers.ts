import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isObject } from "@lifestreamprotocol/core";
import { answerHeld, jsonOf, openPeers, type Hand, type Peer, type PeerWire } from "./peers.js";
import { refuse } from "./refusal.js";

export const MAC_EXCHANGE = "/v1/mac/exchange";
export const MAC_PEERS = "/v1/mac";
export const MAC_POLL_MS = 20_000;
export const MAC_PRESENCE_MS = 35_000;
const MAC_EXCHANGE_BYTES = 256 * 1024;
const MAC_SILENT_MS = 30_000;

export type MacCommand =
  | { readonly id: string; readonly kind: "refresh"; readonly connector: string }
  | { readonly id: string; readonly kind: "settings" }
  | { readonly id: string; readonly kind: "flush"; readonly sources?: readonly string[]; readonly budget_ms: number };

export interface MacError {
  readonly code: string;
  readonly message: string;
}

export type MacCommandResult =
  | { readonly id: string; readonly ok: true; readonly seals?: Readonly<Record<string, number>> }
  | { readonly id: string; readonly ok: false; readonly error: MacError };

export interface MacStatement {
  readonly boot: string;
  readonly sources: readonly string[];
  readonly running: readonly string[];
}

export interface MacExchanged {
  readonly hand: number;
  readonly calls: readonly MacCommand[];
}

export interface MacPeerListing {
  readonly unit: string;
  readonly boot: string;
  readonly sources: readonly string[];
  readonly present: boolean;
  readonly waiting: boolean;
  readonly seen_ms: number;
}

export interface MacFlushResult {
  readonly state: "skipped_offline" | "clean" | "flushed" | "timeout";
  readonly seals: Readonly<Record<string, number>>;
  readonly passes: Readonly<Record<string, string>>;
  readonly elapsed_ms: number;
}

export interface MacFlush {
  readonly sources?: readonly string[];
  readonly budget_ms: number;
  readonly signal?: AbortSignal;
}

export interface MacPeersOptions {
  readonly poll_ms?: number;
  readonly presence_ms?: number;
  readonly silent_ms?: number;
}

export interface MacPeers extends PeerWire {
  present(): boolean;
  listing(): MacPeerListing[];
  notifyRefresh(connector: string, excludeUnit?: string | null): number;
  notifySettings(excludeUnit?: string | null): number;
  flush(options: MacFlush): Promise<MacFlushResult>;
  close(): void;
}

interface MacKept {
  sleeping: boolean;
  unanswered: boolean;
  pass: string | null;
}

type Mac = Peer<MacStatement> & MacKept;

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((each) => typeof each === "string");

const sealsOk = (value: unknown): value is Record<string, number> =>
  isObject(value) && Object.values(value).every((seal) => Number.isSafeInteger(seal) && (seal as number) > 0);

const isResult = (value: unknown): value is MacCommandResult => {
  if (!isObject(value) || typeof value.id !== "string") return false;
  if (value.ok === true) return value.seals === undefined || sealsOk(value.seals);
  return value.ok === false && isObject(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string";
};

const failed = (id: string, code: string, message: string): MacCommandResult => ({ id, ok: false, error: { code, message } });

const callId = (): string => `m-${randomBytes(6).toString("hex")}`;

export function openMacPeers(options: MacPeersOptions = {}): MacPeers {
  const peers = openPeers<MacStatement, MacCommand, MacCommandResult, MacKept>({
    poll_ms: options.poll_ms ?? MAC_POLL_MS, presence_ms: options.presence_ms ?? MAC_PRESENCE_MS, noun: "mac",
    interrupted: (id, cause) => failed(id, "INTERRUPTED", cause === "closed" ? "the door is stopping" : "the mac started again"),
  });
  let closed = false;
  const present = (peer: Mac): boolean => !peer.sleeping && !peer.unanswered && peers.present(peer);
  const presentPeers = (): Mac[] => peers.peers().filter(present);

  const sleep = (peer: Mac): void => {
    peer.sleeping = true;
    for (const { id } of peers.pending(peer)) peers.end(peer, id, failed(id, "INTERRUPTED", "mac is sleeping"));
    peers.wake(peer);
  };

  async function exchange(unit: string, pass: string | null, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const said = await jsonOf(request, MAC_EXCHANGE_BYTES, options.silent_ms ?? MAC_SILENT_MS);
    const { boot, sources, running = [], results = [], sleep: sleeping } = said;
    if (typeof boot !== "string" || boot === "" || !strings(sources) || !strings(running) || !Array.isArray(results) || !results.every(isResult)
      || (sleeping !== undefined && typeof sleeping !== "boolean")) {
      return refuse(400, "BAD_CALL", "a mac's exchange states its boot and sources, and may state what runs, its results and that it sleeps");
    }
    const { peer } = peers.arrive(unit, { boot, sources: [...sources], running: [...running] }, (): MacKept => ({ sleeping: false, unanswered: false, pass }));
    peer.pass = pass;
    peer.unanswered = false;
    peers.settle(peer, results as MacCommandResult[]);
    if (sleeping === true) {
      sleep(peer);
      return answerHeld(response, 200, { hand: 0, calls: [] } satisfies MacExchanged);
    }
    peer.sleeping = false;
    peers.rehand(peer);
    const send = (hand: Hand<MacCommand>): Promise<void> => {
      if (response.destroyed) return Promise.resolve(void peers.giveBack(peer, hand));
      return answerHeld(response, 200, { hand: hand.id, calls: hand.calls } satisfies MacExchanged);
    };
    if (peers.queued(peer) > 0) return send(peers.take(peer));
    return send(await peers.wait(peer, response));
  }

  const notify = (excludeUnit: string | null | undefined, pending: (call: MacCommand) => boolean, made: () => MacCommand): number => {
    if (closed) return 0;
    let told = 0;
    for (const peer of presentPeers()) {
      if (peer.unit === excludeUnit) continue;
      if (!peers.unhanded(peer).some(pending)) peers.hand(peer, made(), () => undefined);
      told++;
    }
    return told;
  };

  const listing = (): MacPeerListing[] => peers.peers()
    .map((peer) => ({ unit: peer.unit, boot: peer.info.boot, sources: [...peer.info.sources].sort(), present: present(peer), waiting: peers.waiting(peer), seen_ms: peer.seen }))
    .sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));

  function flush({ sources, budget_ms, signal }: MacFlush): Promise<MacFlushResult> {
    const started = performance.now();
    const elapsed = (): number => Math.round(performance.now() - started);
    const asked = closed ? [] : presentPeers();
    if (asked.length === 0) return Promise.resolve({ state: "skipped_offline", seals: {}, passes: {}, elapsed_ms: 0 });
    if (signal?.aborted === true) return Promise.resolve({ state: "timeout", seals: {}, passes: {}, elapsed_ms: 0 });
    const seals: Record<string, number> = {};
    const passes: Record<string, string> = {};
    return new Promise<MacFlushResult>((resolve) => {
      const handed = new Map<Mac, string>();
      let done = false;
      const finish = (state: MacFlushResult["state"]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        for (const [peer, id] of handed) peers.end(peer, id, failed(id, "TIMEOUT", "the flush ran past its budget"));
        resolve({ state, seals: { ...seals }, passes: { ...passes }, elapsed_ms: elapsed() });
      };
      const stop = (): void => finish("timeout");
      const expired = (): void => {
        for (const peer of handed.keys()) {
          peer.unanswered = true;
          peers.wake(peer);
        }
        finish("timeout");
      };
      const timer = setTimeout(expired, Math.max(0, budget_ms));
      signal?.addEventListener("abort", stop, { once: true });
      for (const peer of asked) handed.set(peer, callId());
      for (const [peer, id] of [...handed]) {
        const call: MacCommand = { id, kind: "flush", ...(sources === undefined ? {} : { sources: [...sources] }), budget_ms };
        peers.hand(peer, call, (result) => {
          if (done) return;
          handed.delete(peer);
          if (result.ok && result.seals !== undefined) {
            for (const [source, seal] of Object.entries(result.seals)) {
              if (seal <= (seals[source] ?? 0)) continue;
              seals[source] = seal;
              if (peer.pass === null) delete passes[source];
              else passes[source] = peer.pass;
            }
          }
          if (handed.size === 0) finish(Object.keys(seals).length > 0 ? "flushed" : "clean");
        });
      }
    });
  }

  return {
    half(method, pathname) {
      if (method === "POST" && pathname === MAC_EXCHANGE) return "peer";
      if (method === "GET" && pathname === MAC_PEERS) return "drive";
      return null;
    },
    async serve(caller, request, response) {
      if ("peer" in caller) return exchange(caller.peer, caller.pass ?? null, request, response);
      return answerHeld(response, 200, { macs: listing() });
    },
    present: () => !closed && presentPeers().length > 0,
    listing,
    notifyRefresh: (connector, excludeUnit) => notify(excludeUnit, (call) => call.kind === "refresh" && call.connector === connector, () => ({ id: callId(), kind: "refresh", connector })),
    notifySettings: (excludeUnit) => notify(excludeUnit, (call) => call.kind === "settings", () => ({ id: callId(), kind: "settings" })),
    flush,
    close() {
      closed = true;
      peers.close();
    },
  };
}
