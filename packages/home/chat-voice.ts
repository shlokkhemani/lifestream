import type { Connector } from "@lifestreamprotocol/connect";
import type { Ask, BlobReader, HomeFolder } from "@lifestreamprotocol/core";
import { AI_FAMILY, askVoiceNote, voiceItem } from "@lifestreamprotocol/families";
import type { Asker, RunnerEnded } from "@lifestreamprotocol/model";
import { BLOB_NAME, NOTE_ID, openStage, stagedOrStored } from "./ask-files.js";
import { askKey, type SentAsk } from "./asks.js";
import { catalogOf } from "./catalog.js";
import type { CopyAnswer, CopyAsked } from "./copies.js";
import { WRITING } from "./made.js";
import { readRouting, routed, serving, workId, type ModelRoute, type Routing, type RoutingAt, type RoutingTables } from "./models.js";
import type { Calls } from "./pick.js";
import { NO_VOICE, VOICE_OFF } from "./processing.js";
import { RESERVED_MS } from "./runners.js";


export const WARM_AGAIN_MS = 30_000;
export const WORDS_WITHIN_MS = 12_000;

export const NOT_WRITTEN = "Couldn't write out this voice note";


export type WordsAnswer = { words: string } | { waiting: string } | { failed: string };

export interface ChatVoiceOptions {
  source(): string;
  work(): string | null;
  routing(): Routing;
  asker(blobs: BlobReader): Asker;
  blobs: BlobReader;
  folder: HomeFolder;
  epoch(): number;
  copy(asked: CopyAsked): Promise<CopyAnswer>;
  calls: Pick<Calls, "now" | "holds">;
  warm(runner: string, model: string, signal: AbortSignal): Promise<RunnerEnded>;
  log(line: Record<string, string>): void;
  clock(): number;
  within_ms?: number;
}

interface Hold {
  unit: string;
  until_ms: number;
  warming: AbortController | null;
  warmed_ms: number;
}

export class ChatVoice {
  readonly #holds = new Map<string, Hold>();
  #waiters = new Set<() => void>();

  constructor(private readonly options: ChatVoiceOptions) {}

  wake(): void {
    this.#expire();
    const waiters = this.#waiters;
    this.#waiters = new Set();
    for (const resolve of waiters) resolve();
  }

  async verb(request: { open?: unknown; cancel?: unknown; words?: unknown; note?: unknown }): Promise<{ runner: string | null } | { cancelled: string } | WordsAnswer> {
    if (request.open !== undefined) return this.open(noteOf(request.open, "open"));
    if (request.cancel !== undefined) return this.cancel(noteOf(request.cancel, "cancel"));
    if (typeof request.words !== "string" || !BLOB_NAME.test(request.words)) throw new TypeError("chat-voice names a note to open or cancel, or the words of an audio blob (sha256:<64 hex>)");
    return this.words(request.words, request.note === undefined ? undefined : noteOf(request.note, "note"));
  }

  open(note: string): { runner: string | null } {
    this.#expire();
    const now = this.options.clock();
    const route = this.#route();
    const runner = route !== null && route.runner !== null && !openStage(this.options.folder).closed(note) ? route.runner.unit : null;
    const was = this.#holds.get(note);
    if (runner === null) {
      if (was !== undefined) this.#end(note);
      return { runner: null };
    }
    if (was !== undefined && was.unit !== runner) this.#end(note);
    const hold = this.#holds.get(note) ?? { unit: runner, until_ms: now, warming: null, warmed_ms: -Infinity };
    hold.until_ms = now + RESERVED_MS;
    this.#holds.set(note, hold);
    if (hold.warming === null && now - hold.warmed_ms >= WARM_AGAIN_MS && route!.state === "ready") this.#warm(hold, route!.model);
    return { runner };
  }

  cancel(note: string): { cancelled: string } {
    this.#end(note);
    return { cancelled: note };
  }

  async words(audio: string, note?: string): Promise<WordsAnswer> {
    if (note !== undefined) this.#end(note, false);
    const by = this.options.clock() + (this.options.within_ms ?? WORDS_WITHIN_MS);
    const blobs = stagedOrStored(this.options.blobs, openStage(this.options.folder));
    if (!blobs.has(audio)) return { failed: NOT_WRITTEN };
    const asker = this.options.asker(blobs);
    const ask = askVoiceNote(audio, this.options.source());
    for (;;) {
      const now = this.options.clock();
      const stands = asker.answer(ask);
      if (stands !== null && "reply" in stands) return { words: (stands.reply.value as string).trim() };
      if (stands === null) {
        const placed = await this.#place(asker, ask, now);
        if (placed !== null) return placed;
      }
      if (this.options.clock() >= by) return { waiting: WRITING };
      await this.#wait(by);
    }
  }

  async #place(asker: Asker, ask: Ask, now: number): Promise<WordsAnswer | null> {
    const work_id = this.options.work();
    const routing = this.options.routing();
    const serves = serving(routing, { work_id, chosen: null, at_key: now });
    if (!("route" in serves)) return { failed: serves.none === "off" ? VOICE_OFF : NO_VOICE };
    const route = serves.route;
    if (route.state !== "ready" || route.request === null) return { waiting: route.line ?? NO_VOICE };
    const way = routed(ask, { ...route, request: route.request });
    const call = { ...way.call, line: "chat" as const };
    const known = askKey(asker.known(ask));
    if (this.options.calls.holds(known)) return null;
    const epoch = this.options.epoch();
    const request = asker.request({ ...way.ask, line: "chat" });
    if ("reply" in request || "waits" in request) return null;
    if (!("send" in request)) return { failed: NOT_WRITTEN };
    let copy: SentAsk["copy"] = null;
    if (route.leaves !== null) {
      const made = await this.options.copy({
        op: "copy", key: request.send, revision: asker.key(way.ask), pieces: request.pieces, attachments: ask.attachments ?? [], receiver: route.leaves, route: route.id, level: "none", epoch,
      });
      if ("error" in made) return { failed: NOT_WRITTEN };
      if ("wait" in made) return { waiting: made.wait };
      if ("cannot" in made) return { failed: made.cannot };
      copy = { id: made.copy, receiver: route.leaves, level: "none" };
    }
    const sent: SentAsk = { item: ask.item, prompt: ask.prompt, known, key: request.send, route: route.id, call, work_id, at_key: now, copy };
    try {
      this.options.calls.now(AI_FAMILY, voiceItem(ask.attachments![0]!.blob), sent, () => this.wake());
    } catch (error) {
      this.options.log({ "chat-voice": "call not started", error: error instanceof Error ? error.message : String(error) });
      return { failed: NOT_WRITTEN };
    }
    return null;
  }

  #wait(by: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(done);
        resolve();
      }, Math.max(0, by - this.options.clock()));
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.#waiters.add(done);
    });
  }

  #route(): ModelRoute | null {
    const serves = serving(this.options.routing(), { work_id: this.options.work(), chosen: null, at_key: this.options.clock() });
    return "route" in serves ? serves.route : null;
  }

  #warm(hold: Hold, model: string): void {
    const controller = new AbortController();
    hold.warming = controller;
    void this.options.warm(hold.unit, model, controller.signal).then((ended) => {
      if ("error" in ended && !controller.signal.aborted) this.options.log({ "chat-voice": "warm call ended", code: ended.error.code });
    }, (error: unknown) => {
      if (!controller.signal.aborted) this.options.log({ "chat-voice": "warm call failed", error: error instanceof Error ? error.message : String(error) });
    }).finally(() => {
      if (hold.warming === controller) hold.warming = null;
      hold.warmed_ms = this.options.clock();
    });
  }

  #expire(): void {
    const now = this.options.clock();
    for (const [note, hold] of this.#holds) if (hold.until_ms <= now) this.#end(note);
  }

  #end(note: string, stop = true): void {
    const hold = this.#holds.get(note);
    if (hold === undefined) return;
    this.#holds.delete(note);
    if (stop) hold.warming?.abort();
  }
}

export function voiceWorkOf(connectors: readonly Connector[], source: string): string | null {
  const connector = catalogOf(connectors).of({ id: source });
  return connector?.processing?.voice === undefined ? null : workId(connector.id, "voice");
}

export function voiceLeaves(tables: RoutingTables, at: RoutingAt, source: string): string | null {
  const serves = serving(readRouting(tables, at), { work_id: voiceWorkOf(at.connectors, source), chosen: null, at_key: at.now_ms });
  return "route" in serves ? serves.route.leaves : null;
}

function noteOf(value: unknown, member: string): string {
  if (typeof value !== "string" || !NOTE_ID.test(value)) throw new TypeError(`chat-voice's ${member} is a note's id, 32 lowercase hex`);
  return value;
}
