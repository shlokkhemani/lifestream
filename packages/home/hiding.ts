import {
  civilDay, DETAIL_TYPES, DETAIL_WORDS, HideError, hides, hidesAny, isDetailType, isObject, LEVEL_NAMES, restoreDetails, wantedOf,
  type Counts, type DaySettings, type DetailType, type Json, type JsonObject, type Level, type LevelName, type Mark, type Piece, type PlaceholderTable, type Wanted,
} from "@lifestreamprotocol/core";
import type { NewOutbound, OutboundWhat, TablePart, Withheld } from "@lifestreamprotocol/model";
import {
  compile, drew, linesText, openHider, sealOf, sealsAny,
  type Access, type Detector, type HomeAccount, type MarksStore, type NameTable, type Pictures, type PrivacySettings, type Reader, type Sealed, type Text,
} from "@lifestreamprotocol/privacy";
import { ASK_READER, noAccess } from "./access.js";
import { accessAt, parsedOr, type CallEnd, type HeldReader } from "./access-ledger.js";
import type { KeptOut } from "./call.js";
import { hidingPick } from "./detector.js";
import { valueMarks, type MarkingProgress } from "./marking.js";
import type { HiddenReader } from "./principals.js";
import { refuse, Refusal, RETRY_SOON_S, starting } from "./refusal.js";
import { answerOf, argsOf, HANDLE, leavesOf, REFS_CHARS, REFS_MOST, ROUTES, searchRefusal, type Citation, type DescribeAnswer, type Leaves, type Shape, type TOOL_ROUTES } from "./search-contract.js";
import { TRIES } from "./count.js";
import type { SealedPeople } from "./people-search.js";
import type { Step } from "./reads.js";
import { besides, continuationOf, itemsOf, nothing, routed, wayIn, wayOut, type Asked, type Hide, type Sealing } from "./way-out.js";
import { GUARDED } from "./work.js";
import type { Writer } from "./writers.js";


export interface HidingInputs {
  settings: () => PrivacySettings;
  names: (known: string | null) => Promise<NameTable | "same" | undefined>;
  detector: Detector;
  chosen: () => string | null;
  hidingFile: () => string | null;
  pictures: Pictures;
  marks: MarksStore;
  writer: Pick<Writer, "epoch" | "level" | "part" | "save" | "outbound" | "list" | "begin" | "end" | "person">;
  existing: () => Promise<readonly HomeAccount[]>;
  progress: () => Promise<MarkingProgress | null> | MarkingProgress | null;
  day: () => DaySettings;
  clock: () => number;
  leavesOf: (model: string) => Promise<string | null | undefined>;
  bound?: () => Bound;
  log: (line: JsonObject) => void;
  voice?: () => string | null | Promise<string | null>;
  describe?: (refs: readonly string[]) => Promise<DescribeAnswer>;
  route?: (path: ToolRoute, step: Step) => Promise<Routed>;
}

export type ToolRoute = (typeof TOOL_ROUTES)[number];

export interface Routed {
  status: number;
  value: unknown;
  epoch: number;
  withheld?: KeptOut;
}

const TOOLS: Readonly<Record<ToolRoute, string>> = { "/v1/search": "search", "/v1/count": "count", "/v1/people/search": "search_people", "/v1/read": "read" };

export interface Hiding {
  hide(reader: HiddenReader, body: JsonObject): Promise<JsonObject>;
  restore(reader: HiddenReader, body: JsonObject): Promise<JsonObject>;
  link(reader: HiddenReader, body: JsonObject): Promise<JsonObject>;
  read(reader: HiddenReader, path: ToolRoute, body: unknown, initialize?: boolean): Promise<{ status: number; value: JsonObject }>;
  state(): Promise<JsonObject>;
  keep(table: string, level: LevelName, pick?: LevelName): Promise<LevelName>;
  chat(id: string, pinned?: LevelName): Promise<JsonObject>;
  warm(blob: string): Promise<void>;
}

export const BOUND_MS = 30_000;

export interface Bound {
  passed(): boolean;
  on(passed: () => void): () => void;
}

export function within(ms: number): () => Bound {
  return () => {
    const deadline = Date.now() + ms;
    return {
      passed: () => Date.now() >= deadline,
      on: (passed) => {
        const timer = setTimeout(passed, Math.max(0, deadline - Date.now()));
        return () => clearTimeout(timer);
      },
    };
  };
}
const AT_ONCE = 4;
const BLOB = /^sha256:[0-9a-f]{64}$/u;
const CHAT_TABLE = /^chat:\S{1,200}$/u;
const refOf = (detail: string): string => continuationOf(detail)?.of ?? detail;
const shaped = (written: string): boolean => (HANDLE.test(written) && written.length <= 10) || /^\[\[[^\]]{1,80}\]\]$/u.test(written);
const CITED = /\[(r[1-9]\d*(?:\s*,\s*r[1-9]\d*)*)\]/gu;
const BUSY = "Lifestream is hiding other answers: ask again in a moment";
async function readerOf(reader: HiddenReader, part: (wanted: Wanted) => Promise<PlaceholderTable>): Promise<Reader> {
  const showing = reader.agent?.shown ?? [];
  const table = showing.length === 0 ? undefined : await part({ ...wantedOf([]), placeholders: new Set(showing) });
  const shown = table === undefined ? [] : table.entries.filter((entry) => showing.includes(entry.placeholder)).map((entry) => entry.detail);
  return sealsAny(reader.sealed) ? { sealed: reader.sealed, shown } : { shown };
}

function peopleOf(sealed: Sealed): SealedPeople {
  return "except" in sealed ? { except: [...sealed.except] } : { people: [...sealed.people] };
}

function sentOf(body: unknown): Json {
  return isObject(body) && Object.hasOwn(body, "args") ? JSON.parse(JSON.stringify(body.args ?? null)) as Json : null;
}

function wordsOf(value: JsonObject): string | null {
  return typeof value.message === "string" ? value.message : null;
}

export function countedOf(tool: string, value: unknown): string | null {
  if (tool !== "count" || typeof value !== "object" || value === null) return null;
  const n = (value as { total?: { n?: unknown } }).total?.n;
  return Number.isSafeInteger(n) ? String(n) : null;
}

function codeOf(value: JsonObject): { code: string } | Record<never, never> {
  return typeof value.code === "string" ? { code: value.code } : {};
}

function keptBeside(was: KeptOut | undefined, more: KeptOut): KeptOut {
  if (was === undefined) return more;
  const by = { ...was.by };
  for (const [why, n] of Object.entries(more.by) as [keyof KeptOut["by"], number][]) by[why] = (by[why] ?? 0) + n;
  return { by, capped: was.capped || more.capped };
}

function withheldOf(kept: KeptOut | undefined): Withheld[] {
  if (kept === undefined) return [];
  return Object.entries(kept.by).filter(([, n]) => n !== undefined && n > 0).map(([line, n]) => ({ line, n: n!, least: kept.capped }));
}

export const ERASING = "Lifestream is erasing something you asked it to: hiding goes on once it is done";

class Erased extends Error {
  constructor(readonly epoch: number) {
    super("an erasure ran since these texts were read");
  }
}

export const PICTURE_UNMADE = "This picture cannot be shown: Lifestream could not hide it.";

function answering(pictures: Pictures, log: (line: JsonObject) => void): Pictures {
  const unmade = (how: "read" | "make", error: unknown): { cannot: string } => {
    if (error instanceof Refusal) throw error;
    log({ hiding: "picture_unmade", how, cause: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    return { cannot: PICTURE_UNMADE };
  };
  return {
    async read(blob) {
      try {
        return await pictures.read(blob);
      } catch (error) {
        return unmade("read", error);
      }
    },
    async make(draft) {
      try {
        return await pictures.make(draft);
      } catch (error) {
        return unmade("make", error);
      }
    },
  };
}

export function openHiding(inputs: HidingInputs): Hiding {
  let settings = inputs.settings();
  let names: NameTable | undefined;
  const hider = openHider({ people: () => names, settings: () => settings, detector: inputs.detector, pictures: answering(inputs.pictures, inputs.log), marks: inputs.marks });

  const fresh = async (): Promise<PrivacySettings> => {
    settings = inputs.settings();
    const read = await inputs.names(names?.version ?? null);
    if (read !== "same") names = read;
    return settings;
  };

  const boundOf = inputs.bound ?? within(BOUND_MS);
  const slots = places();
  const turn = turns();

  const chatLevel = (table: string, privacy: PrivacySettings): Promise<LevelName> => inputs.writer.level(table, privacy.chat);

  const accessOf = async (reader: string): Promise<Access> => {
    const held = await inputs.writer.person<HeldReader>({ reader: { reader, now_ms: inputs.clock() } });
    return accessAt(reader, held.access);
  };

  const under = async (reader: HiddenReader, body: JsonObject, privacy: PrivacySettings): Promise<{ table: string; level: Level }> => {
    if (reader.agent !== null) return { table: reader.agent.table, level: (await accessOf(reader.pass)).hide };
    const table = body.table;
    if (typeof table !== "string" || !CHAT_TABLE.test(table)) refuse(403, "NOT_YOUR_TABLE", "This pass hides and restores under a conversation's table (chat:<id>) alone");
    if (reader.turn === undefined) return { table, level: await chatLevel(table, privacy) };
    if (table !== reader.turn.table) refuse(403, "NOT_YOUR_TABLE", "A turn's pass hides and restores under its own conversation's table alone");
    return { table, level: reader.turn.level };
  };

  const receiverOf = async (reader: HiddenReader, body: JsonObject): Promise<{ receiver: string | null; route: string | null }> => {
    if (reader.agent !== null) return { receiver: reader.agent.name, route: null };
    const to = typeof body.to === "string" && body.to !== "" ? body.to : bad("to is the id of the model Chat sends this to");
    const leaves = await inputs.leavesOf(to);
    if (leaves === undefined) bad(`${to}: no connection lists this model`);
    return { receiver: leaves, route: to };
  };

  const partAt = async (scope: string, wanted: Wanted, epoch: number): Promise<TablePart> => {
    const part = await inputs.writer.part(scope, wanted);
    if (part.epoch !== epoch) throw new Erased(part.epoch);
    return part;
  };

  const unheld = async (): Promise<number> => {
    const now = await inputs.writer.epoch();
    if (now.erasing) notReady(ERASING);
    return now.epoch;
  };

  const unmoved = async (epoch: number): Promise<void> => {
    const now = await inputs.writer.epoch();
    if (now.epoch !== epoch) throw new Erased(now.epoch);
    if (now.erasing) notReady(ERASING);
  };

  const failed = (error: unknown): never => {
    if (error instanceof Refusal) throw error;
    if (error instanceof Erased) refuse(409, "ERASED", "An erasure ran since these texts were read: read them again", undefined, { epoch: error.epoch });
    if (error instanceof HideError) bad(error.message);
    inputs.log({ hiding: "failed", cause: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    return refuse(500, "HIDE_FAILED", "Lifestream could not hide this answer");
  };

  const hiding: Hiding = {
    async hide(reader, body) {
      const bound = boundOf();
      const privacy = await fresh();
      const { table: scope, level: chatAt } = await under(reader, body, privacy);
      const { receiver, route } = await receiverOf(reader, body);
      const level: Level = receiver === null ? "none" : chatAt;
      const epoch = epochOf(body.epoch);
      const what: OutboundWhat = reader.agent !== null ? "read" : body.what === "read" || body.what === "text" ? body.what : bad("what is read (a tool's answer) or text (Chat's own words)");
      const tool = what === "read" ? (typeof body.tool === "string" && body.tool !== "" ? body.tool : bad("a read names its tool")) : null;
      const texts = textsOf(body.texts);
      if (reader.agent !== null && texts.some((text) => "picture" in text)) bad("a picture is a Chat question's photo: an agent's is made on its read's way out");
      const done = await turn(scope, bound);
      try {
        await slots.take(bound);
      } catch (error) {
        done();
        throw error;
      }
      try {
        if (bound.passed()) notReady(BUSY);
        let read: TablePart | undefined;
        const partOf = async (wanted: Wanted): Promise<PlaceholderTable> => {
          const part = await partAt(scope, wanted, epoch);
          read = read === undefined ? part : besidePart(read, part);
          return part.table;
        };
        let served: { table: PlaceholderTable; counts: Counts; detector: string | null; chars: number; pictures: number; reply: JsonObject };
        try {
          const marked = inputs.marks.epoch;
          await unmoved(epoch);
          const passing = new AbortController();
          const forget = bound.on(() => passing.abort());
          const over = await readerOf(reader, partOf);
          const answer = await hider.hide(texts, level, partOf, passing.signal, marked, over).finally(forget);
          if ("wait" in answer) notReady(answer.wait);
          served = {
            table: answer.table, counts: answer.counts, detector: answer.detector,
            chars: answer.texts.reduce((sum, text) => sum + (typeof text === "string" ? text.length : 0), 0),
            pictures: answer.texts.filter((text) => typeof text !== "string" && !("cannot" in text)).length,
            reply: {
              texts: answer.texts.map((text): Json => (typeof text === "string" ? text : "cannot" in text ? { cannot: text.cannot } : { jpeg: Buffer.from(text.jpeg).toString("base64"), drew: drew(text) })),
              spans: answer.spans.map((placed) => placed.map(({ start, end, placeholder }) => ({ start, end, placeholder }))),
            },
          };
        } catch (error) {
          return failed(error);
        }
        const row: NewOutbound | undefined = receiver === null ? undefined : {
          at_ms: inputs.clock(), receiver, route, by: reader.pass, what, tool, level, counts: served.counts, detector: served.detector,
          chars: served.chars, pictures: served.pictures, key: null, attempt: null, refs: [],
        };
        const saved = await inputs.writer.save(read!, served.table, row);
        if ("saved" in saved) return { level: level as Json, epoch, ...served.reply };
        if ("dropped" in saved) gone();
        if ("erased" in saved) {
          try {
            await unmoved(epoch);
          } catch (error) {
            return failed(error);
          }
        }
        return failed(new Error(`${scope}: ${"stale" in saved ? "the table was written since the call read its part, under its turn" : "the save found the table erased, the epoch unmoved"}`));
      } finally {
        slots.give();
        done();
      }
    },

    async restore(reader, body) {
      const bound = boundOf();
      const privacy = await fresh();
      const { table: scope, level } = await under(reader, body, privacy);
      const text = body.text;
      const params = body.params;
      if ((typeof text === "string") === (params !== undefined)) bad("a restore states a text, or params, never both");
      const asked: string[] = typeof text === "string" ? [text] : paramsOf(params);
      const wanted = wantedOf(asked.map((value) => ({ text: value, marks: [] })));
      if (typeof text === "string") for (const handle of citedIn(text)) wanted.placeholders.add(handle);
      const done = await turn(scope, bound);
      try {
        for (;;) {
          if (bound.passed()) notReady(BUSY);
          const epoch = await unheld();
          let part: TablePart;
          try {
            part = await partAt(scope, wanted, epoch);
          } catch (error) {
            if (error instanceof Erased) continue;
            throw error;
          }
          let table: PlaceholderTable = part.table;
          const held = new Map(table.entries.map((entry) => [entry.placeholder, entry]));
          const restored = asked.map((value) => {
            const back = restoreDetails(value, table);
            table = back.table;
            return { value: back.text, marks: back.marks, unknown: back.unknown };
          });
          const saved = await inputs.writer.save(part, table);
          if ("erased" in saved) {
            await unheld();
            continue;
          }
          if ("dropped" in saved) gone();
          if ("stale" in saved) failed(new Error(`${scope}: the table was written since the call read its part, under its turn`));
          if (typeof text === "string") {
            const { value, marks, unknown } = restored[0]!;
            const refs = citedIn(text).flatMap((handle) => {
              const entry = held.get(handle);
              return entry?.type === "ref" ? [{ handle, ref: refOf(entry.detail) }] : [];
            });
            const citations = await describedOf(inputs.describe, refs, inputs.log);
            return { level: level as Json, epoch, text: value, marks: marks as unknown as Json, unknown, refs, ...(citations === undefined ? {} : { citations: citations as unknown as Json }) };
          }
          return { level: level as Json, epoch, params: restored as unknown as Json };
        }
      } finally {
        done();
      }
    },

    async link(reader, body) {
      if (reader.agent !== null) refuse(403, "PRINCIPAL_SCOPE", "An agent opens no link through the home: only Chat's are written down here");
      let host: string;
      try {
        const url = new URL(typeof body.link === "string" ? body.link : "");
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError("no web link");
        host = url.hostname.toLowerCase();
      } catch {
        return bad("link is the web address Chat is about to open (http or https)");
      }
      const seq = await inputs.writer.outbound({
        at_ms: inputs.clock(), receiver: host, route: null, by: reader.pass, what: "link", tool: null, level: "none", counts: {}, detector: null,
        chars: (body.link as string).length, pictures: 0, key: null, attempt: null,
      });
      return { seq, receiver: host };
    },

    async read(reader, path, body, initialize = false) {
      const bound = boundOf();
      if (reader.agent === null && reader.turn === undefined) refuse(403, "PRINCIPAL_SCOPE", "A model reads these routes on an agent's pass or a turn's: the person reads them by GET");
      const id = reader.agent === null ? ASK_READER : reader.pass;
      const at_ms = inputs.clock();
      const existing = await inputs.existing();
      const begun = await inputs.writer.begin({ reader: id, tool: TOOLS[path], sent: sentOf(body), at_ms, initialize, existing });
      if ("moved" in begun) return starting();
      const access = begun.access === undefined ? noAccess(id) : parsedOr(begun.access.lines);
      const gated = compile(access, at_ms, () => null) === null ? undefined : access;
      const ended = (end: Omit<CallEnd, "id" | "ms">): CallEnd => ({ id: begun.id, ms: inputs.clock() - at_ms, ...end });
      try {
        const { table: scope } = reader.agent ?? reader.turn!;
        const call = argsOf(ROUTES[path].call as Shape<{ args: unknown; to?: string; shown?: string[] }>, body);
        const { receiver, route } = await receiverOf(reader, call as unknown as JsonObject);
        const level: Level = reader.agent !== null ? access.hide : receiver === null ? "none" : reader.turn!.level;
        const shown = new Set(reader.agent === null ? call.shown ?? [] : []);
        const run = inputs.route ?? (() => refuse(404, "NO_ROUTE", "This door reads no route for a model"));
        const sealing = sealsAny(reader.sealed);
        const sealedIds = sealing ? peopleOf(reader.sealed!) : undefined;
        const showing = reader.agent?.shown ?? [];
        const hiding = hidesAny(level) || sealing;
        settings = inputs.settings();
        if (hiding) await fresh();
        for (let tries = 0; tries < TRIES; tries++) {
          const epoch = await unheld();
          let held: (() => void) | undefined;
          try {
            return await once(epoch, async () => {
              held ??= await turn(scope, bound);
            });
          } catch (error) {
            if (error instanceof Erased) continue;
            return failed(error);
          } finally {
            held?.();
          }
        }
        return refuse(503, "NOT_NOW", "Lifestream is erasing something: try again in a minute.", RETRY_SOON_S);

        async function once(epoch: number, hold: () => Promise<void>): Promise<{ status: number; value: JsonObject }> {
          let read: TablePart | undefined;
          let turned = false;
          const partOf = async (wanted: Wanted): Promise<PlaceholderTable> => {
            const part = await partAt(scope, wanted, epoch);
            if (turned) read = read === undefined ? part : besidePart(read, part);
            return part.table;
          };
          const underTurn = async (): Promise<void> => {
            await hold();
            turned = true;
          };
          if (hiding) await underTurn();
          const written = stringsIn(call.args);
          const wanted = wantedOf(written.map((text) => ({ text, marks: [] })));
          for (const text of written) if (HANDLE.test(text.trim())) wanted.placeholders.add(text.trim());
          for (const placeholder of showing) wanted.placeholders.add(placeholder);
          let current = await partOf(wanted);
          let unknown: readonly string[] = [];
          const over = await readerOf(reader, async () => current);
          const marked = inputs.marks.epoch;
          await unmoved(epoch);
          const passing = new AbortController();
          const forget = bound.on(() => passing.abort());
          let detector: string | null | undefined;
          const counts: Counts = {};
          const slotted = async <T>(work: () => Promise<T>): Promise<T> => {
            if (!hiding) return work();
            await slots.take(bound);
            try {
              return await work();
            } finally {
              slots.give();
            }
          };
          const look: Hide = (texts) => slotted(() => hider.hide(texts, level, besides(partOf, current), passing.signal, marked, over));
          const hidingInto = (left?: Counts): Hide => (texts) => slotted(async () => {
            const hidden = await hider.hide(texts, level, besides(partOf, current), passing.signal, marked, over);
            if (!("texts" in hidden)) return hidden;
            current = hidden.table;
            detector = detector === undefined || detector === hidden.detector ? hidden.detector : null;
            if (left !== undefined) for (const [type, n] of Object.entries(hidden.counts) as [DetailType, number][]) left[type] = (left[type] ?? 0) + n;
            return hidden;
          });
          const hide = hidingInto();
          let kept: KeptOut | undefined;
          let restored: Json = null;
          const engine = async (step: Step): Promise<Routed> => {
            const answered = await run(path, { ...step, ...(sealedIds === undefined ? {} : { sealed: sealedIds }), ...(gated === undefined ? {} : { access: gated }) });
            if (answered.epoch !== epoch) throw new Erased(answered.epoch);
            if (answered.withheld !== undefined) kept = keptBeside(kept, answered.withheld);
            return answered;
          };
          try {
            let sealed: Sealing | undefined;
            if (sealing) {
              const ready = hider.ready(["person"]);
              if (ready !== true) return notReady(ready.wait);
              const open: Hide = (texts) => slotted(() => hider.hide(texts, level, besides(partOf, current), passing.signal, marked, { shown: over.shown }));
              sealed = { seal: sealOf(names!, reader.sealed)!, open };
            }
            const asked = await wayIn(path, ROUTES[path].params as Shape<unknown>, call.args, current, level, shown, hiding ? names : undefined, look, sealed);
            let answered: { status: number; value: unknown; asked: Asked<unknown> };
            if ("wait" in asked) return notReady(asked.wait);
            if ("unknown" in asked) {
              unknown = asked.unknown;
              answered = { status: 404, value: { code: "HANDLE_UNKNOWN", message: `${asked.unknown.map((each) => (shaped(each.trim()) ? each.trim() : "a value that is no handle")).join(", ")}: not a placeholder or a handle this conversation was given` }, asked: nothing(path, level, hiding, written) };
            } else if ("withheld" in asked) {
              answered = { status: 422, value: { code: "WITHHELD", message: asked.withheld, ...(asked.not_searched === undefined ? {} : { not_searched: asked.not_searched }) }, asked: { ...nothing(path, level, hiding, written), not_searched: asked.not_searched ?? [] } };
            } else {
              restored = JSON.parse(JSON.stringify(asked.params ?? null)) as Json;
              const route = await routed(path, asked, {
                engine, look, hide, current: () => current, passed: () => bound.passed(),
                marked: (values) => {
                  const state = inputs.detector.state();
                  return state.state === "ready" ? valueMarks(inputs.marks, state.model, values) : null;
                },
              });
              if ("wait" in route) return notReady(route.wait);
              answered = { ...route, asked };
            }
            await underTurn();
            if (!hiding) current = await partOf(wanted);
            for (const each of unknown) current = restoreDetails(each, current).table;
            const shape = (answered.status === 200 ? ROUTES[path].answer : searchRefusal) as Shape<unknown>;
            const out = await wayOut(shape, answered.value, answered.asked, hidingInto(counts));
            if ("wait" in out) return notReady(out.wait);
            const value = out.answer as JsonObject;
            if (GUARDED) answerOf(path, answered.status, value);
            const row: NewOutbound | undefined = receiver === null ? undefined : {
              at_ms: inputs.clock(), receiver, route, by: reader.pass, what: "read", tool: TOOLS[path], level, counts, detector: detector ?? null,
              chars: JSON.stringify(value).length, pictures: out.pictures, key: null, attempt: null, refs: out.refs,
            };
            const end = ended({
              result: answered.status === 200 ? "answered" : "refused",
              words: answered.status === 200 ? countedOf(TOOLS[path], answered.value) : wordsOf(value),
              ...(answered.status === 200 ? {} : codeOf(value)),
              withheld: withheldOf(kept),
              read: restored,
              ...(answered.status === 200 ? { items: itemsOf(TOOLS[path], answered.value, existing) } : {}),
            });
            const saved = await inputs.writer.save(read!, current, row === undefined ? undefined : { ...row, call: end.id }, end);
            if ("saved" in saved) return { status: answered.status, value };
            if ("dropped" in saved) gone();
            if ("erased" in saved) throw new Erased(epoch);
            return failed(new Error(`${scope}: the table was written since the call read its part, under its turn`));
          } finally {
            forget();
          }
        }
      } catch (error) {
        await inputs.writer.end(ended({ result: "failed", ...(error instanceof Refusal ? { code: error.code, words: error.words } : { words: "The door failed." }), withheld: [] })).catch(() => false);
        throw error;
      }
    },

    async state() {
      const privacy = await fresh();
      const { epoch, erasing } = await inputs.writer.epoch();
      const day = inputs.day();
      const today = civilDay(inputs.clock(), day);
      const { totals } = await inputs.writer.list({ from: today, to: today, day });
      const ready = erasing ? { wait: ERASING } : hider.ready("all");
      const detected = inputs.detector.state();
      const chosen = inputs.chosen();
      const progress = await inputs.progress();
      return {
        epoch,
        ready: ready === true,
        line: ready === true ? null : ready.wait,
        detector: {
          model: chosen, runner: (chosen === null ? null : hidingPick(chosen)?.unit) ?? "off", file: inputs.hidingFile(), state: detected.state,
          line: detected.state === "absent" ? detected.why : null,
          ...(detected.state === "downloading" ? { bytes: detected.bytes, total: detected.total } : {}),
        },
        marking: progress === null ? null : { ...progress },
        level: privacy.level,
        chat: privacy.chat,
        levels: Object.fromEntries(LEVEL_NAMES.map((name) => [name, DETAIL_TYPES.filter((type) => !type.includes(".") && type !== "ref" && hides(name, type))])),
        links: privacy.links,
        always: [...privacy.always],
        never: [...privacy.never],
        today: totals as unknown as Json,
        types: DETAIL_WORDS as unknown as Json,
        voice: { leaves: (await inputs.voice?.()) ?? null },
      };
    },

    keep: (table, level, pick) => inputs.writer.level(table, level, pick),

    async chat(id, pinned) {
      const table = `chat:${id}`;
      if (!CHAT_TABLE.test(table)) bad("a conversation's id is up to 200 characters, none of them a space");
      const level = pinned ?? await inputs.writer.level(table, null) ?? inputs.settings().chat;
      const { epoch } = await inputs.writer.epoch();
      return { chat: id, level, epoch };
    },

    async warm(blob) {
      try {
        settings = inputs.settings();
        if (inputs.detector.state().state === "off") return;
        const epoch = inputs.marks.epoch;
        const findings = await inputs.pictures.read(blob);
        if ("cannot" in findings) return;
        const { text } = linesText(findings.lines);
        if (text.trim() === "") return;
        const marked = await hider.mark([text], epoch);
        if ("again" in marked) inputs.log({ hiding: "a photo's marks were not warmed", why: marked.again });
      } catch (error) {
        inputs.log({ hiding: "a photo's marks were not warmed", error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
  return hiding;
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  return isObject(value as Json) ? Object.values(value as JsonObject).flatMap(stringsIn) : [];
}

function busy(): Refusal {
  return new Refusal(503, "HIDE_NOT_READY", BUSY, RETRY_SOON_S);
}

function waitIn(line: (() => void)[], bound: Bound, pass: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let forget = (): void => undefined;
    const mine = (): void => {
      forget();
      if (!bound.passed()) return resolve();
      pass();
      reject(busy());
    };
    line.push(mine);
    forget = bound.on(() => {
      const at = line.indexOf(mine);
      if (at !== -1) line.splice(at, 1);
      reject(busy());
    });
  });
}

function places(): { take: (bound: Bound) => Promise<void>; give: () => void } {
  let held = 0;
  const line: (() => void)[] = [];
  const give = (): void => {
    const next = line.shift();
    if (next === undefined) held--;
    else next();
  };
  return {
    give,
    take: async (bound) => {
      if (bound.passed()) throw busy();
      if (held < AT_ONCE) {
        held++;
        return;
      }
      await waitIn(line, bound, give);
    },
  };
}

function turns(): (scope: string, bound: Bound) => Promise<() => void> {
  const lines = new Map<string, (() => void)[]>();
  const pass = (scope: string): void => {
    const next = lines.get(scope)!.shift();
    if (next === undefined) lines.delete(scope);
    else next();
  };
  return async (scope, bound) => {
    if (bound.passed()) throw busy();
    let given = false;
    const done = (): void => {
      if (given) return;
      given = true;
      pass(scope);
    };
    const line = lines.get(scope);
    if (line === undefined) lines.set(scope, []);
    else await waitIn(line, bound, () => pass(scope));
    return done;
  };
}

function bad(message: string): never {
  return refuse(422, "BAD_REQUEST", message);
}

function notReady(line: string): never {
  return refuse(503, "HIDE_NOT_READY", line, RETRY_SOON_S);
}

function gone(): never {
  return refuse(410, "TABLE_DROPPED", "This agent's access was removed: its placeholders are gone");
}

function epochOf(value: Json | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) bad("epoch is the ledger's epoch the texts were read under: GET /v1/privacy, or an earlier answer, says it");
  return value;
}

function textsOf(value: Json | undefined): Text[] {
  if (!Array.isArray(value) || value.length === 0) bad("texts is a list of texts, each a list of pieces");
  return value.map((text, at): Text => {
    if (isObject(text)) {
      if (typeof text.picture !== "string" || !BLOB.test(text.picture) || text.tags !== true || Object.keys(text).length !== 2) bad(`texts[${at}] is a list of pieces or a Chat question's photo, {picture: "sha256:<hex>", tags: true}`);
      return { picture: text.picture, tags: true };
    }
    if (!Array.isArray(text)) bad(`texts[${at}] is a list of pieces or a Chat question's photo`);
    return text.map((piece, index): Piece => pieceOf(piece, `texts[${at}][${index}]`));
  });
}

function pieceOf(value: Json, where: string): Piece {
  if (!isObject(value) || typeof value.text !== "string") bad(`${where} is a piece: {text} and what it is`);
  const optional = (name: string): string | undefined => {
    const member = value[name];
    if (member !== undefined && typeof member !== "string") bad(`${where}.${name} is a string`);
    return member as string | undefined;
  };
  if ("quote" in value) bad(`${where}: a quote is the asker's alone`);
  if (value.free === true) {
    const whole = optional("whole");
    const known = value.known;
    if (known !== undefined && !(Array.isArray(known) && known.every((mark) => isObject(mark) && Number.isInteger(mark.start) && Number.isInteger(mark.end) && typeof mark.type === "string"
      && (mark.who === undefined || typeof mark.who === "string") && (mark.shown === undefined || typeof mark.shown === "string")))) {
      bad(`${where}.known is a list of marks, each {start, end, type, who?, shown?}`);
    }
    return { text: value.text, free: true, ...(whole === undefined ? {} : { whole }), ...(known === undefined ? {} : { known: known as unknown as Mark[] }) };
  }
  if (value.is !== undefined) {
    if (!isDetailType(value.is)) bad(`${where}.is is a type of detail`);
    if (value.is === "ref") bad(`${where}: a ref becomes a handle in a route's answer alone`);
    const who = optional("who");
    return { text: value.text, is: value.is, ...(who === undefined ? {} : { who }) };
  }
  return { text: value.text, free: true };
}

function paramsOf(value: Json | undefined): string[] {
  if (!Array.isArray(value)) bad("params is a list, each {value}");
  return value.map((param, at) => {
    if (!isObject(param) || typeof param.value !== "string" || Object.keys(param).length !== 1) bad(`params[${at}] is {value}`);
    return param.value;
  });
}

function describedAtOnce(refs: readonly { handle: string; ref: string }[]): { handle: string; ref: string }[] {
  let chars = 0;
  const taken = refs.slice(0, REFS_MOST).filter(({ ref }) => (chars += ref.length) <= REFS_CHARS);
  return taken.length === 0 ? refs.slice(0, 1) : taken;
}

async function describedOf(describe: HidingInputs["describe"], refs: readonly { handle: string; ref: string }[], log: HidingInputs["log"]): Promise<Record<string, Citation> | undefined> {
  if (describe === undefined) return undefined;
  const described: Record<string, Citation> = {};
  for (let left = [...refs]; left.length > 0;) {
    const batch = describedAtOnce(left);
    let answer: DescribeAnswer;
    try {
      answer = await describe(batch.map(({ ref }) => ref));
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      if (error.code === "TOO_BROAD") {
        left = left.slice(1);
        continue;
      }
      log({ event: "citations_unsaid", code: error.code });
      return undefined;
    }
    answer.described.forEach((citation, at) => {
      described[batch[at]!.handle] = citation;
    });
    left = [...batch.slice(answer.described.length), ...left.slice(batch.length)];
  }
  return described;
}

function citedIn(text: string): string[] {
  return [...new Set([...text.matchAll(CITED)].flatMap((cited) => cited[1]!.split(/\s*,\s*/u)))];
}

function besidePart(read: TablePart, part: TablePart): TablePart {
  const held = new Set(read.table.entries.map((entry) => entry.placeholder));
  return { ...read, table: { ...read.table, entries: [...read.table.entries, ...part.table.entries.filter((entry) => !held.has(entry.placeholder))] } };
}
