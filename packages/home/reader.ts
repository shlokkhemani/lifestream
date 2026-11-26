import { join } from "node:path";
import { parentPort } from "node:worker_threads";
import Database from "better-sqlite3";
import { faces as facesLabeler, type Connector } from "@lifestreamprotocol/connect";
import { openHandedFolder, type HandedFolder, type HomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import type { Family } from "@lifestreamprotocol/families";
import type { DetectorModel } from "@lifestreamprotocol/privacy";
import { offeredOf } from "./access-routes.js";
import { voicedAudio } from "./ask-files.js";
import { voiceLeaves } from "./chat-voice.js";
import { readAnswer, readImported, readNeeds, type AnswerAsk, type NeedsAsk, type ReadPoint } from "./custody.js";
import { readFeed, type FeedRead } from "./feed.js";
import { admittedSet, declaredOf } from "./folders.js";
import { errorText } from "./job-error.js";
import { HomeFile } from "./home-file.js";
import { filesLooked } from "./imports.js";
import { openPhoneBundle } from "./phone.js";
import { mergedPeople, scannedFaces } from "./engine-pictures.js";
import { markingQueues } from "./index-job.js";
import { markingProgress } from "./marking.js";
import { storedModels } from "./models.js";
import { peopleFileOf, readNameTable } from "./people.js";
import { PLACES, preparedDirOf, preparedFileOf, readPrepared } from "./prepared.js";
import type { Principal } from "./principals.js";
import { openReads, refusalReply, served, type Ask, type PreparedAsk, type Reply } from "./reads.js";
import { Refusal } from "./refusal.js";
import { homeOf, loadRegistry, type Loaded } from "./registry.js";
import { restore } from "./restore.js";
import { effective, lastGood, type Settings } from "./settings.js";
import { rowsCounted } from "./work.js";

export interface ReaderInit {
  root: string;
  machine: string;
  handed: HandedFolder;
  registry?: string;
  statements?: boolean;
  readWaitMs?: number;
}

export type Short =
  | { answer: AnswerAsk } | { needs: NeedsAsk } | { imported: readonly (readonly [pass: string, source: string])[] }
  | { feed: FeedRead }
  | { prepared: string; ask: PreparedAsk }
  | { card: { machine: string; hash: string } }
  | { centre: { machine: string; spot: string } }
  | { served: readonly string[] }
  | { looked: readonly string[] }
  | { names: { machine: string; known: string | null } }
  | { faces: string }
  | { anchors: string }
  | { merged: string }
  | { voiced: { source: string; audio: readonly string[] } }
  | { marking: { machine: string; store: string; model: DetectorModel | null } }
  | { voice: { now_ms: number } }
  | { leaves: string }
  | { offered: true }
  | { restore: { pass: Principal; delivers: readonly string[]; points: Readonly<Record<string, ReadPoint | null>> } };

export type ToReader =
  | { attach: ReaderInit }
  | { detach: true }
  | ({ id: number } & ({ pathname: string; ask: Ask } | { bundle: string } | { short: Short }));
export type FromReader = { id: number; ran?: Ran[]; timed?: Timed } & (
  | { value: unknown }
  | { refusal: { status: number; code: string; message: string; retryAfter?: number; extra: JsonObject } }
  | { error: string }
);
export interface Ran {
  readonly file: string;
  readonly sql: string;
  readonly params: unknown[];
}

export interface Slowest {
  readonly sql: string;
  readonly ms: number;
}

export interface Timed {
  readonly slowest: Slowest;
  readonly statements: number;
  readonly ms: number;
  readonly rows: number;
}

interface State {
  root: string;
  folder: HomeFolder;
  home: HomeFile;
  settings: () => Settings;
  connectors: readonly Connector[];
  families: readonly Family[];
  blobs: ReturnType<HomeFolder["blobs"]>;
  reads: ReturnType<typeof openReads>;
  statements: boolean;
}

const port = parentPort!;
let state: State | null = null;
let ready: Promise<void> = Promise.resolve();
let ran: Ran[] | null = null;
const asking: { slowest: Slowest | null; statements: number; ms: number } = { slowest: null, statements: 0, ms: 0 };
const timed = (sql: string, took: number, step: number, first: boolean): void => {
  if (first) asking.statements++;
  asking.ms += step;
  if (asking.slowest === null || took > asking.slowest.ms) asking.slowest = { sql, ms: took };
};
const prepare = Database.prototype.prepare;
Database.prototype.prepare = function (this: Database.Database, sql: string) {
  const statement = prepare.call(this, sql) as unknown as Record<"get" | "all" | "run" | "iterate", (...params: unknown[]) => unknown>;
  for (const method of ["get", "all", "run"] as const) {
    const real = statement[method].bind(statement);
    statement[method] = (...params: unknown[]) => {
      ran?.push({ file: this.name, sql, params });
      const started = performance.now();
      try {
        return real(...params);
      } finally {
        const ms = performance.now() - started;
        timed(sql, ms, ms, true);
      }
    };
  }
  const iterate = statement.iterate.bind(statement);
  statement.iterate = (...params: unknown[]) => {
    ran?.push({ file: this.name, sql, params });
    let started = performance.now();
    const rows = iterate(...params) as IterableIterator<unknown>;
    let ms = performance.now() - started;
    timed(sql, ms, ms, true);
    const step = (move: () => IteratorResult<unknown>): IteratorResult<unknown> => {
      started = performance.now();
      try {
        return move();
      } finally {
        const took = performance.now() - started;
        ms += took;
        timed(sql, ms, took, false);
      }
    };
    return {
      next: () => step(() => rows.next()),
      return: (value?: unknown) => step(() => rows.return?.(value) ?? { done: true, value }),
      [Symbol.iterator]() { return this; },
    };
  };
  return statement as unknown as Database.Statement;
} as typeof prepare;

async function attach(init: ReaderInit): Promise<void> {
  const folder = openHandedFolder(init.handed);
  const loaded: Loaded | undefined = init.registry === undefined ? undefined : await loadRegistry(init.registry, effective(folder).settings, homeOf(folder));
  const home = new HomeFile(folder);
  const settings = lastGood(folder);
  const connectors = loaded?.connectors ?? declaredOf((await admittedSet(init.root)).map((each) => each.entry));
  const families = loaded?.families ?? [];
  const blobs = folder.blobs(join(init.root, "blobs"), { reading: true });
  const reads = openReads({ folder, home, blobs, settings, ...(loaded === undefined ? {} : { registry: loaded }), ...(init.readWaitMs === undefined ? {} : { readWaitMs: init.readWaitMs }) });
  state = { root: init.root, folder, home, settings, connectors, families, blobs, reads, statements: init.statements === true };
  port.postMessage({ up: true });
}

const short = (current: State, asked: Short): unknown => {
  const { root, folder, home, settings, connectors, families, blobs, reads } = current;
  const context = () => ({ folder, settings: settings(), connectors, families });
  if ("answer" in asked) return readAnswer(home, asked.answer, context());
  if ("needs" in asked) return readNeeds(home, asked.needs, context());
  if ("imported" in asked) return readImported(home, asked.imported);
  if ("feed" in asked) return readFeed(home, asked.feed);
  if ("prepared" in asked) return reads.prepared(asked.prepared)!(asked.ask);
  if ("card" in asked) return reads.card(asked.card.machine, asked.card.hash);
  if ("centre" in asked) {
    try {
      return readPrepared(folder, preparedFileOf(preparedDirOf(root, asked.centre.machine, "places"), "places"), PLACES.format,
        (file) => file.value<{ latitude: number; longitude: number }>("spans", asked.centre.spot))?.value;
    } catch {
      return undefined;
    }
  }
  if ("served" in asked) return home.view((view) => asked.served.filter((blob) => served(view, blobs, blob))) ?? null;
  if ("looked" in asked) return home.view((view) => filesLooked(view.tables.meta, asked.looked)) ?? null;
  if ("names" in asked) return readNameTable(folder, peopleFileOf(root, asked.names.machine), asked.names.known);
  if ("faces" in asked) return home.view((view) => scannedFaces(view, asked.faces)) ?? [];
  if ("anchors" in asked) return home.view((view) => facesLabeler.faceAnchors(view, asked.anchors)) ?? { photos: [], merged: {} };
  if ("merged" in asked) return home.view((view) => mergedPeople(view, asked.merged)) ?? {};
  if ("voiced" in asked) return home.view((view) => voicedAudio(view, asked.voiced.source, asked.voiced.audio)) ?? [];
  if ("marking" in asked) return markingProgress(markingQueues(folder, asked.marking.machine), { id: asked.marking.store }, asked.marking.model);
  if ("voice" in asked) {
    const now = settings();
    const at = { connectors, blocks: now.connectors, defaults: now.defaults, runners: now.runners, now_ms: asked.voice.now_ms, day: now.day };
    return home.view((view) => voiceLeaves(view.tables, at, `ask:local:${now.unit}`)) ?? null;
  }
  if ("leaves" in asked) {
    const route = home.view((view) => storedModels(view.tables.meta).routes.find((each) => each.id === asked.leaves));
    return route === undefined || !route.offered ? null : { leaves: route.leaves };
  }
  if ("offered" in asked) return home.view((view) => offeredOf(view.sources(), connectors, families)) ?? null;
  const { pass, delivers, points } = asked.restore;
  return home.view((view) => restore(view, connectors, pass, delivers, points)) ?? null;
};

port.on("message", (asked: ToReader) => {
  if ("attach" in asked) {
    ready = attach(asked.attach).catch((error) => {
      setImmediate(() => { throw error; });
      return new Promise<void>(() => undefined);
    });
    return;
  }
  if ("detach" in asked) {
    void ready.catch(() => undefined).then(() => {
      state = null;
      ran = null;
      ready = Promise.resolve();
      port.postMessage({ detached: true });
    });
    return;
  }
  void ready.then(async () => {
    const current = state!;
    const { id } = asked;
    if (current.statements) ran = [];
    Object.assign(asking, { slowest: null, statements: 0, ms: 0 });
    const counted = rowsCounted();
    let answer: FromReader;
    try {
      answer = { id, value: "pathname" in asked ? await current.reads.reply(asked.pathname)!(asked.ask) : "bundle" in asked ? await openPhoneBundle(current.folder, asked.bundle) : short(current, asked.short) };
    } catch (error) {
      answer = error instanceof Refusal
        ? "pathname" in asked ? { id, value: refusalReply(error) }
          : { id, refusal: { status: error.status, code: error.code, message: error.words, ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }), extra: error.extra } }
        : { id, error: errorText(error) };
    }
    if (ran !== null) answer.ran = ran;
    if (asking.slowest !== null) answer.timed = { slowest: asking.slowest, statements: asking.statements, ms: asking.ms, rows: rowsCounted() - counted };
    ran = null;
    port.postMessage(answer);
  });
});
