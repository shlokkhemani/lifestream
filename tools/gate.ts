import { fork, spawn, type ChildProcess } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { parseArgs } from "node:util";
import { openHomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import { openLedger } from "@lifestreamprotocol/model";
import { openMarks, type Detector, type PrivacySettings } from "@lifestreamprotocol/privacy";
import { QUIET } from "../packages/home/door.js";
import { openHiding, type Routed, type ToolRoute } from "../packages/home/hiding.js";
import { settled } from "../packages/home/test/agent-levels.js";
import type { HiddenReader } from "../packages/home/principals.js";
import { ErasableStreams } from "../packages/home/erasable-streams.js";
import { HomeFile } from "../packages/home/home-file.js";
import { peopleFileOf, readNameTable } from "../packages/home/people.js";
import { READ_MS } from "../packages/home/readers.js";
import { openReads, refusalReply, type Reply, type Step } from "../packages/home/reads.js";
import { makeRef, personRef } from "../packages/home/refs.js";
import { Refusal } from "../packages/home/refusal.js";
import homeRegistry from "../packages/home/registry-home.js";
import { homeOf } from "../packages/home/registry.js";
import { effectiveOf, type Settings } from "../packages/home/settings.js";
import { rowsCounted } from "../packages/home/work.js";
import { openWriter } from "../packages/home/writers.js";
import { copyToAsk, DAY, GATE_CACHE, gateHome, NOW_MS, SIZES, UNIT, type GateHome, type SizeName } from "./gate-home.js";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const ROOM_MS = 1_000;
const WORDS_ROOM_MS = 3_000;
const PAGE_ROWS = 30_000;
const COUNT_ROWS = 110_000;
const WORDS_ROWS = 100_000;
const SCREEN_ROWS = 50_000;
const SCREEN_PAGE = 10;
const FOLLOW_MOST = 1_000;

type Params = Record<string, string | readonly string[]>;

interface Call {
  route: string;
  query: Params;
}

interface Ask extends Call {
  name: string;
  hidden?: Hidden;
  words?: boolean;
  needs?: { sum?: number; screened?: number; rejected?: true; withheld?: true; hers?: true };
  over?: Fits;
}

interface Hidden {
  args: Record<string, unknown>;
  said?: string[];
  person?: { name: string; as?: "person" | "query"; chat?: true };
  follow?: true;
}

interface Fits {
  from: string;
  to: string;
}

interface Answered {
  ms: number;
  status: number;
  code?: string;
  reads: number[];
  engine_ms?: number;
  bytes: number;
  error?: string;
  said?: string;
  fits?: Fits;
  summed?: number;
  screened?: number;
  hers?: { placeholder: string; hits: number; twice: number; without: number; total: number | null; ended: boolean };
}

const settingsOf = (): Settings => effectiveOf({ "day.zone": DAY.zone, "day.day_start_hour": DAY.day_start_hour, unit: UNIT }, "the gate").settings;

function asksOf(home: GateHome): Ask[] {
  const month = { from: "2026-10-01", to: "2026-10-31" };
  const tenMonths = { from: "2026-01-01", to: "2026-10-31" };
  const life = { from: home.first, to: home.last };
  const person = personRef(home.largest);
  const word = home.words.common;
  const counts: Ask[] = [
    { name: "count: messages a month by week", route: "/v1/count", query: { of: "messages", ...month, by: "week" } },
    { name: "count: messages Jan-Oct by month", route: "/v1/count", query: { of: "messages", ...tenMonths, by: "month" } },
    { name: "count: messages whole life by year", route: "/v1/count", query: { of: "messages", ...life, by: "year" } },
    { name: "count: messages by chat, whole life", route: "/v1/count", query: { of: "messages", ...life, by: "chat" } },
    { name: "count: messages by chat, ten months", route: "/v1/count", query: { of: "messages", ...tenMonths, by: "chat" } },
    { name: "count: messages by person, a month", route: "/v1/count", query: { of: "messages", ...month, by: "person" } },
    { name: "count: the largest person by year", route: "/v1/count", query: { of: "messages", ...life, person, by: "year" } },
    { name: "count: the largest person by chat", route: "/v1/count", query: { of: "messages", ...life, person, by: "chat" } },
    { name: "count: mails by month, whole life", route: "/v1/count", query: { of: "mails", ...life, by: "month" } },
    { name: "count: payments by month, whole life", route: "/v1/count", query: { of: "payments", ...life, measure: "amount", by: "month" } },
    { name: `count: a word ('${word}'), ten months`, route: "/v1/count", query: { of: "messages", ...tenMonths, words: word, by: "month" }, words: true },
    {
      name: `count: minutes of the four weeks' stay from inside it (${home.long.inside}), by day`, route: "/v1/count",
      query: { of: "stays", from: home.long.inside, to: home.long.to, measure: "minutes", op: "sum", by: "day", "match.place": home.long.place.split(" ").at(-1)! },
      needs: { sum: home.long.minutes },
    },
  ];
  const searches: Ask[] = [
    { name: `search: '${word}'`, route: "/v1/search", query: { lists: "record", query: word }, words: true },
    { name: `search: '${word}', a month`, route: "/v1/search", query: { lists: "record", query: word, ...month }, words: true },
    { name: `search: '${home.words.rare}', whole life`, route: "/v1/search", query: { lists: "record", query: home.words.rare }, words: true },
    { name: `search: a common word beside a rare one ('${word} ${home.words.rare}')`, route: "/v1/search", query: { lists: "record", query: `${word} ${home.words.rare}` }, words: true },
  ];
  const screen = home.screen;
  const oldest = { from: screen.from, to: dayAfter(screen.from, 30) };
  const page = Math.min(SCREEN_PAGE, screen.common_windows);
  const screens: Ask[] = [
    { name: `screen: '${screen.common}' (${screen.common_windows} window-days), the newest stretch`, query: { lists: "screen", query: screen.common } },
    { name: `screen: '${screen.common}', the oldest stretch`, query: { lists: "screen", query: screen.common, ...oldest } },
    { name: `screen: '${screen.common}', the whole year`, query: { lists: "screen", query: screen.common, from: screen.from, to: screen.to } },
  ].map((ask): Ask => ({ ...ask, route: "/v1/search", words: true, needs: { screened: page } }));
  const said = [`what did ${screen.name} write`];
  const hiddenScreens: Ask[] = [
    { name: `hidden screen: '${screen.name}' (in a name on ${screen.name_windows} window-days), said by the person, the newest stretch`, query: {}, hidden: { args: { query: screen.name, lists: ["screen"] }, said } },
    { name: `hidden screen: '${screen.name}', said by the person, the oldest stretch`, query: {}, hidden: { args: { query: screen.name, lists: ["screen"], ...oldest }, said } },
  ].map((ask): Ask => ({ ...ask, route: "/v1/search", words: true, needs: { rejected: true } }));
  const top = home.words.top;
  const sixWeeks = { from: "2026-09-30", to: "2026-11-10" };
  const twoHours = { from: "2026-10-15T18:00:00Z", to: "2026-10-15T20:00:00Z" };
  const agent = (query: Params): Params => ({ lists: "record", limit: "20", ...query });
  const chatOf = (chat: string) => makeRef("chat", { key: chat });
  const shapes: Ask[] = [
    { name: `search: '${word}', the largest chat, six weeks, 50`, query: agent({ query: word, chat: chatOf(home.largest.chat), ...sixWeeks, limit: "50" }) },
    { name: `search: '${word}', a small chat (${home.small.messages}), six weeks, 50`, query: agent({ query: word, chat: chatOf(home.small.chat), ...sixWeeks, limit: "50" }) },
    { name: "search: two words OR'd, the largest chat, newest", query: agent({ query: `${top[0]} OR ${top[1]}`, chat: chatOf(home.largest.chat), order: "newest" }) },
    { name: `search: '${top[1]}', the largest chat, from 2026-01-01, newest`, query: agent({ query: top[1]!, chat: chatOf(home.largest.chat), from: "2026-01-01", order: "newest" }) },
    { name: "search: two words OR'd, the largest person, newest", query: agent({ query: `${top[0]} OR ${top[2]}`, person: person, order: "newest" }) },
    { name: "search: two words OR'd, the largest person, [voice, messages], newest", query: agent({ query: `${top[0]} OR ${top[2]}`, person: person, families: ["voice", "messages"], order: "newest" }) },
    { name: "search: no words, the largest person, three days, oldest, 20", query: agent({ person: person, from: "2026-10-13", to: "2026-10-15", order: "oldest" }) },
    { name: "search: seven words OR'd, two hours of a day, oldest, 30", query: agent({ query: top.join(" OR "), ...twoHours, order: "oldest", limit: "30" }) },
    { name: "search: four words OR'd, two months five years back, 50", query: agent({ query: top.slice(0, 4).join(" OR "), from: "2021-09-01", to: "2021-10-31", limit: "50" }) },
    { name: `search: '${top[3]}', [mail], oldest, 50`, query: agent({ query: top[3]!, families: ["mail"], order: "oldest", limit: "50" }) },
  ].map((ask): Ask => ({ ...ask, route: "/v1/search", words: true }));
  const name: Ask = { name: `search: '${home.common}', a name every hit shows`, route: "/v1/search", query: agent({ query: home.common }), words: true };
  const busy = home.filed.busy;
  const stretch = (from: string, to: string, detail: string): Call => ({ route: "/v1/read", query: { from, to, detail } });
  const reads: Ask[] = [
    { name: `read: the busiest day whole, brief (${busy}, ${home.filed.lines} lines)`, ...stretch(busy, busy, "brief") },
    { name: "read: the busiest day, lines", ...stretch(busy, busy, "lines") },
    { name: "read: a week, brief", ...stretch("2026-11-02", "2026-11-08", "brief") },
    { name: "read: the largest chat over five days", route: "/v1/read", query: { chat: chatOf(home.largest.chat), from: "2026-11-06", to: "2026-11-10" } },
  ];
  return [
    ...searches,
    ...shapes,
    name,
    ...screens,
    ...counts,
    { name: `search_people: a common name ('${home.common}', in ${home.common_groups} group titles)`, route: "/v1/people/search", query: { name: home.common } },
    { name: "search_people: the largest person", route: "/v1/people/search", query: { name: home.largest.name } },
    { name: `search_people: a number's start every phone holds ('${home.crowd.name}', ${home.crowd.people} people)`, route: "/v1/people/search", query: { name: home.crowd.name } },
    ...reads,
    { name: "days: ten months", route: "/v1/days", query: { ...tenMonths, limit: "500" } },
    { name: "where: a month", route: "/v1/where", query: month },
    { name: "extracts: messages of a day", route: "/v1/extracts", query: { family: "messages", day: "2026-10-15", limit: "500" } },
    { name: "sources", route: "/v1/sources", query: {} },
    { name: "labels: the largest chat", route: "/v1/labels", query: { chat: home.largest.chat } },
    ...[counts[0]!, counts[1]!, counts[3]!, counts[4]!, counts[10]!].map((ask): Ask => ({ ...ask, name: `hidden ${ask.name}`, query: {}, hidden: { args: countArgs(ask.query) } })),
    ...[searches[0]!, searches[1]!, searches[3]!, ...shapes.filter((ask) => ask.query.chat !== chatOf(home.small.chat))].map((ask): Ask => ({ ...ask, name: `hidden ${ask.name}`, query: {}, hidden: searchArgs(ask.query, home) })),
    {
      name: `hidden search: '${home.common}' not shown, withheld with no engine read`, route: "/v1/search", query: {}, words: true,
      hidden: { args: { query: home.common, lists: ["record"] } }, needs: { withheld: true },
    },
    {
      name: `hidden search: her placeholder ('${home.her.name}', ${home.her.records} records), every next followed`, route: "/v1/search", query: {}, words: true,
      hidden: { args: { lists: ["record"], limit: 10 }, said: [`what did ${home.her.phone} say`], person: { name: home.her.phone, as: "query" }, follow: true }, needs: { hers: true },
    },
    ...hiddenScreens,
    {
      name: `hidden screen: '${screen.name}' not said, withheld with no engine read`, route: "/v1/search", query: {}, words: true,
      hidden: { args: { query: screen.name, lists: ["screen"] } }, needs: { withheld: true },
    },
  ];
}

function countArgs(query: Params): Record<string, unknown> {
  return Object.fromEntries(Object.entries(query).map(([name, value]) => [name, name === "by" ? [value].flat() : value]));
}

function searchArgs(query: Params, home: GateHome): Hidden {
  const args: Record<string, unknown> = { lists: ["record"] };
  if (typeof query.query === "string") args.query = query.query;
  if (typeof query.from === "string") args.from = query.from;
  if (typeof query.to === "string") args.to = query.to;
  if (query.families !== undefined) args.families = [query.families].flat();
  if (typeof query.order === "string") args.order = query.order;
  if (typeof query.limit === "string") args.limit = Number(query.limit);
  const byPerson = query.person !== undefined;
  const byChat = query.chat === makeRef("chat", { key: home.largest.chat });
  if (!byPerson && !byChat) return { args };
  return { args, said: [`what did ${home.largest.name} and I talk about`], person: { name: home.largest.name, ...(byPerson ? { as: "person" as const } : {}), ...(byChat ? { chat: true as const } : {}) } };
}

function dayAfter(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}


async function child(root: string, machine: string): Promise<void> {
  const settings = settingsOf();
  const folder = openHomeFolder(root, { machine, program: "home" });
  const registry = await homeRegistry(settings, homeOf(folder));
  const streams = { feed: undefined as never, serves: async () => false, card: async () => undefined, open: new ErasableStreams(), checked: <T,>(_name: string, read: () => Promise<T>) => read() };
  const reads = openReads({ folder, home: new HomeFile(folder), blobs: undefined as never, settings: () => settings, registry, streams });
  const held = { machine, sites: [], present: [], refused: [], stated: {} } as never;
  const url = (route: string, query: Params | URLSearchParams) => `${route}?${(query instanceof URLSearchParams ? query : paramsOf(query)).toString()}`;
  const metered = async <T>(rows: number[], read: () => T | Promise<T>): Promise<T> => {
    const counted = rowsCounted();
    try {
      return await read();
    } finally {
      rows.push(rowsCounted() - counted);
    }
  };
  const replied = (route: string, query: Params | URLSearchParams, rows: number[]): Promise<Reply> =>
    metered(rows, () => reads.reply(route)!({ url: url(route, query), now_ms: NOW_MS, held }));
  const called = async (call: Call, rows: number[]): Promise<{ status: number; code?: string; body: string }> => {
    if (reads.reply(call.route) !== undefined) {
      const reply = await replied(call.route, call.query, rows).catch((error: unknown) => {
        if (error instanceof Refusal) return refusalReply(error);
        throw error;
      });
      return { status: reply.status, ...(reply.code === undefined ? {} : { code: reply.code }), body: String(reply.body) };
    }
    const route = reads.route(call.route) ?? (() => { throw new Error(`no door route ${call.route}`); })();
    const sink = new Sink();
    const request = { url: url(call.route, call.query), headers: {} } as unknown as IncomingMessage;
    await metered(rows, async () => {
      await route(request, sink as unknown as ServerResponse, { machine, still: () => true });
      if (!sink.writableFinished) await finished(sink);
    });
    return { status: sink.status, body: Buffer.concat(sink.chunks).toString("utf8") };
  };
  const scratch = mkdtempSync(join(tmpdir(), "lifestream-gate-"));
  mkdirSync(join(scratch, "replies"));
  const scratchFolder = openHomeFolder(scratch);
  openLedger(scratchFolder, { mode: "migrate" }).close();
  settled(scratchFolder, NOW_MS);
  const writer = openWriter(scratchFolder, machine, QUIET, () => undefined);
  const detector: Detector = { state: () => ({ state: "off" }), find: async () => { throw new Error("no hiding model on the gate"); } };
  const privacy: PrivacySettings = { level: "all", chat: "all", links: "tokens", always: [], never: [] };
  const pictures = { read: async () => ({ cannot: "no pictures on the gate" }), make: async () => ({ cannot: "no pictures on the gate" }) } as const;
  let engine: number[] = [];
  let engineMs = 0;
  const route = async (path: ToolRoute, step: Step): Promise<Routed> => {
    const started = performance.now();
    try {
      const reply = await metered(engine, () => reads.reply(path)!({ url: path, now_ms: NOW_MS, held, epoch: 0, reader: "model", step }));
      return { status: reply.status, value: JSON.parse(String(reply.body)), epoch: 0 };
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return { status: error.status, value: { code: error.code, message: error.words, ...error.extra }, epoch: 0 };
    } finally {
      engineMs += performance.now() - started;
    }
  };
  const hiding = openHiding({
    settings: () => privacy, names: async (known) => readNameTable(folder, peopleFileOf(root, machine), known), detector, chosen: () => null, hidingFile: () => null, pictures,
    marks: openMarks(scratchFolder, join(scratch, "marks.db")), writer, progress: () => null, day: () => settings.day, clock: () => NOW_MS, log: () => undefined, route,
    existing: async () => [], leavesOf: async () => "OpenAI",
  });
  let conversations = 0;
  const hiddenAsk = async (ask: Ask & { hidden: Hidden }): Promise<Answered> => {
    const reader: HiddenReader = { pass: "gate", agent: null, turn: { table: `chat:gate-${++conversations}`, level: "all" } };
    const read = (path: ToolRoute, args: Record<string, unknown>) => hiding.read(reader, path, { args, to: "codex:gate", shown: ask.hidden.said ?? [] } as JsonObject);
    const args = { ...ask.hidden.args };
    let placeholder: string | undefined;
    if (ask.hidden.person !== undefined) {
      const found = await read("/v1/people/search", { name: ask.hidden.person.name });
      const match = (found.value.matches as { name: string; chats?: { chat: string; messages: number }[] }[] | undefined)?.[0];
      if (match === undefined) throw new Error(`no person ${ask.hidden.person.name}: ${JSON.stringify(found.value).slice(0, 200)}`);
      placeholder = match.name;
      if (ask.hidden.person.as === "person") args.person = [placeholder];
      if (ask.hidden.person.as === "query") args.query = placeholder;
      if (ask.hidden.person.chat === true) args.chat = [...match.chats ?? []].sort((a, b) => b.messages - a.messages)[0]?.chat;
    }
    engine = [];
    engineMs = 0;
    const started = performance.now();
    let { status, value } = await read(ask.route as ToolRoute, args);
    const answers = [value];
    const seen = new Set<string>();
    let twice = 0;
    let without = 0;
    const tally = (answer: JsonObject) => {
      for (const hit of ((answer.record as JsonObject | undefined)?.hits ?? []) as JsonObject[]) {
        if (seen.has(String(hit.ref))) twice++;
        seen.add(String(hit.ref));
        if (placeholder !== undefined && !JSON.stringify(hit).includes(placeholder)) without++;
      }
    };
    tally(value);
    let pages = 1;
    while (ask.hidden.follow === true && status === 200 && typeof (value.record as JsonObject | undefined)?.next === "string" && pages < FOLLOW_MOST) {
      ({ status, value } = await read(ask.route as ToolRoute, { cursor: (value.record as JsonObject).next, limit: args.limit }));
      answers.push(value);
      tally(value);
      pages++;
    }
    const ms = performance.now() - started;
    const last = answers.at(-1)!;
    const listed = (last.record ?? last.screen ?? last) as Record<string, unknown>;
    const ended = status === 200 && typeof (last.record as JsonObject | undefined)?.next !== "string";
    return {
      ms, status, ...(status === 200 ? {} : { code: String(value.code) }), reads: engine, engine_ms: engineMs, bytes: answers.reduce((sum, each) => sum + JSON.stringify(each).length, 0),
      ...(status === 200 ? { said: saidOf(JSON.stringify(listed)) } : { error: String(value.message ?? "").slice(0, 200) }),
      ...fitsOf(value.fits),
      ...(Array.isArray((last.screen as JsonObject | undefined)?.hits) ? { screened: ((last.screen as JsonObject).hits as unknown[]).length } : {}),
      ...(ask.hidden.follow === true ? { hers: { placeholder: placeholder ?? "", hits: seen.size, twice, without, total: typeof (last.record as JsonObject | undefined)?.total === "number" ? (last.record as JsonObject).total as number : null, ended } } : {}),
    };
  };

  process.on("message", async (ask: Ask) => {
    const started = performance.now();
    const rows: number[] = [];
    let answered: Answered;
    try {
      if (ask.hidden !== undefined) {
        answered = await hiddenAsk(ask as Ask & { hidden: Hidden });
      } else {
        const { status, code, body } = await called(ask, rows);
        const ms = performance.now() - started;
        const first = parsed(body);
        answered = {
          ms, status, ...(code === undefined ? {} : { code }), reads: rows, bytes: body.length,
          ...(status === 200 ? { said: saidOf(body) } : { error: String(first?.message ?? body.slice(0, 200)) }),
          ...fitsOf(first?.fits), ...summedOf(first), ...screenedOf(first),
        };
      }
    } catch (error) {
      const ms = performance.now() - started;
      answered = error instanceof Refusal
        ? { ms, status: error.status, code: error.code, reads: rows, bytes: 0, error: error.message, ...fitsOf(error.extra.fits) }
        : { ms, status: 500, reads: rows, bytes: 0, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    }
    process.send!(answered);
  });
  await writer.epoch();
  process.send!({ ready: true });
}

function parsed(body: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(body) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function fitsOf(value: unknown): { fits?: Fits } {
  const fits = value as Partial<Fits> | undefined;
  return typeof fits?.from === "string" && typeof fits.to === "string" ? { fits: { from: fits.from, to: fits.to } } : {};
}

function summedOf(answer: Record<string, unknown> | undefined): { summed?: number } {
  const sum = (answer?.total as { sum?: unknown } | undefined)?.sum;
  return typeof sum === "number" ? { summed: sum } : {};
}

function screenedOf(answer: Record<string, unknown> | undefined): { screened?: number } {
  const hits = (answer?.screen as JsonObject | undefined)?.hits;
  return Array.isArray(hits) ? { screened: hits.length } : {};
}

const LISTS = ["hits", "rows", "matches", "days", "extracts", "sources", "groups", "pieces", "lines", "atoms"];

function saidOf(body: string): string {
  const answer = parsed(body);
  if (answer === undefined) return `${body.length} bytes of text`;
  if (typeof answer.withheld === "string") return "withheld";
  const parts: string[] = [];
  const total = answer.total;
  const n = (each: unknown) => (each as { of?: string; n?: number });
  if (typeof total === "number") parts.push(`total ${total}`);
  else if (Array.isArray(total)) parts.push(`n ${total.map((each) => `${n(each).n} ${n(each).of ?? ""}`.trim()).join(" + ")}`);
  else if (total !== undefined) parts.push(`n ${n(total).n}`);
  for (const name of LISTS) if (Array.isArray(answer[name])) parts.push(`${(answer[name] as unknown[]).length} ${name}`);
  if (typeof answer.more === "number") parts.push(`${answer.more} more`);
  if (Array.isArray(answer.days)) {
    const messages = (answer.days as { messages?: unknown }[]).reduce((sum, each) => sum + (Array.isArray(each.messages) ? each.messages.length : 0), 0);
    if (messages > 0) parts.push(`${messages} messages`);
  }
  return parts.join(", ");
}

function paramsOf(query: Params): URLSearchParams {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) for (const each of typeof value === "string" ? [value] : value) params.append(name, each);
  return params;
}

class Sink extends Writable {
  status = 200;
  readonly chunks: Buffer[] = [];
  writeHead(status: number): this {
    this.status = status;
    return this;
  }
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    done();
  }
}


function startChild(home: GateHome): Promise<ChildProcess> {
  const started = fork(fileURLToPath(import.meta.url), ["--child", home.root, home.machine], { execArgv: process.execArgv, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  return new Promise((resolve, reject) => {
    started.once("message", () => resolve(started));
    started.once("exit", (code) => reject(new Error(`the reader child ended (${code}) before it was ready`)));
  });
}

function asked(reader: ChildProcess, ask: Ask): Promise<Answered | "cut"> {
  return new Promise((resolve) => {
    const cut = setTimeout(() => {
      reader.removeAllListeners("message");
      reader.kill("SIGKILL");
      resolve("cut");
    }, READ_MS);
    reader.once("message", (answer: Answered) => {
      clearTimeout(cut);
      resolve(answer);
    });
    reader.send(ask);
  });
}

async function heldWhole(): Promise<() => Promise<void>> {
  if (process.env.LIFESTREAM_TEST_LOCKED === undefined) {
    console.log("gate: not under tools/test-lock.sh, so the asks are timed on a machine other runs may share");
    return async () => {};
  }
  const holder = spawn(join(REPO, "tools", "test-lock.sh"), ["--whole"], { stdio: ["pipe", "pipe", "inherit"] });
  const ended = new Promise<number | null>((resolve) => holder.once("exit", (code) => resolve(code)));
  const held = await new Promise<boolean>((resolve) => {
    holder.stdout.once("data", () => resolve(true));
    void ended.then(() => resolve(false));
  });
  if (!held) {
    console.log(`gate: the test slots were not held whole (test-lock.sh --whole ended ${await ended}), so the asks are timed beside other runs`);
    return async () => {};
  }
  return async () => {
    holder.stdin.end();
    await ended;
  };
}

async function gate(): Promise<number> {
  const { values } = parseArgs({ options: { size: { type: "string", default: "full" }, seed: { type: "string", default: "1" }, cache: { type: "string", default: GATE_CACHE }, json: { type: "string" } } });
  const size = SIZES[values.size as SizeName] ?? (() => { throw new Error(`--size is ${Object.keys(SIZES).join(", ")}`); })();
  const seed = Number(values.seed);
  const kept = gateHome({ size, seed, cache: values.cache, log: (line) => console.error(line) });
  const copying = Date.now();
  const copied = copyToAsk(kept, values.cache);
  console.log(`gate: the kept home copied to ask in ${Math.round((Date.now() - copying) / 100) / 10} s, removed when the asks end`);
  try {
    return await askOf(copied.home, values.size, seed, values.json);
  } finally {
    copied.drop();
  }
}

async function askOf(home: GateHome, sizeName: string, seed: number, json: string | undefined): Promise<number> {
  const facts = Object.values(home.counts).reduce((sum, n) => sum + n, 0);
  console.log(`gate home ${home.key} (${sizeName}, seed ${seed}): ${facts.toLocaleString("en")} facts ${JSON.stringify(home.counts)}, ${home.first} to ${home.last}`);
  console.log(`  ${home.kept ? "kept" : "built"}: build ${home.build_s} s, ${(home.bytes / 1e9).toFixed(2)} GB on disk; digest ${home.digest.slice(0, 16)}; largest ${home.largest.id} in ${home.largest.messages.toLocaleString("en")} messages, ${home.largest.chat} of ${home.largest.chat_messages.toLocaleString("en")}`);
  let reader = await startChild(home);
  const giveBack = await heldWhole();
  const results: { ask: Ask; answer: Answered | "cut"; budget: number | null; flag: string | null }[] = [];
  const asks = asksOf(home);
  for (let at = 0; at < asks.length; at++) {
    const ask = asks[at]!;
    const answer = await asked(reader, ask);
    if (answer === "cut") reader = await startChild(home);
    else if (answer.fits !== undefined && ask.over === undefined) {
      const over = ask.hidden === undefined ? { query: { ...ask.query, ...answer.fits } } : { hidden: { ...ask.hidden, args: { ...ask.hidden.args, ...answer.fits } } };
      asks.splice(at + 1, 0, { ...ask, name: `${ask.name}, over its fits (${answer.fits.from} to ${answer.fits.to})`, ...over, over: answer.fits });
    }
    const budget = budgetOf(ask) ?? null;
    const flag = flagOf(ask, answer, budget);
    results.push({ ask, answer, budget, flag });
    const ms = answer === "cut" ? `>${READ_MS}` : answer.ms.toFixed(0);
    console.log(`${flag === null ? "  ok  " : "  FLAG"} ${ms.padStart(8)} ms  ${rowsOf(answer).padStart(11)} rows  ${(budget === null ? "-" : `of ${budget.toLocaleString("en")}`).padStart(10)}  ${ask.name}${saidLine(answer)}${flag === null ? "" : `  [${flag}]`}`);
  }
  await giveBack();
  reader.kill();
  if (json !== undefined) writeFileSync(json, `${JSON.stringify({ home, results }, null, 2)}\n`);
  const flagged = results.filter((result) => result.flag !== null);
  if (flagged.length === 0) {
    console.log(`gate: every ask within its room and its rows (${results.length} asks)`);
    return 0;
  }
  console.log(`gate: ${flagged.length} of ${results.length} asks flagged`);
  for (const { ask, answer, budget, flag } of flagged) console.log(`  ${ask.name}: ${rowsOf(answer)} rows${budget === null ? "" : ` of ${budget.toLocaleString("en")} a read`}  [${flag}]`);
  return 1;
}

function budgetOf(ask: Ask): number | undefined {
  if (ask.route === "/v1/search" && [ask.query.lists, ...((ask.hidden?.args.lists as string[] | undefined) ?? [])].includes("screen")) return SCREEN_ROWS;
  if (ask.route === "/v1/search") return PAGE_ROWS;
  if (ask.route === "/v1/count") return ask.query.words === undefined && ask.hidden?.args.words === undefined ? COUNT_ROWS : WORDS_ROWS + COUNT_ROWS;
  return undefined;
}

function flagOf(ask: Ask, answer: Answered | "cut", budget: number | null): string | null {
  if (answer === "cut") return `cut at ${READ_MS / 1000} s`;
  const flags: string[] = [];
  const refused = answer.status !== 200;
  const broad = answer.code === "TOO_BROAD" && ask.route === "/v1/count" && ask.over === undefined;
  const { sum, screened, rejected, withheld, hers } = ask.needs ?? {};
  if (refused && !broad && !(withheld === true && answer.code === "WITHHELD")) flags.push(`${answer.status} ${answer.code ?? ""} ${answer.error ?? ""}`.trim());
  const most = Math.max(0, ...answer.reads);
  if (budget !== null && most > budget) flags.push(`a read of ${most.toLocaleString("en")} rows, past its ${budget.toLocaleString("en")}`);
  const room = ask.words === true ? WORDS_ROOM_MS : ROOM_MS;
  if (answer.ms > room) flags.push(`over ${room / 1000} s`);
  if (sum !== undefined && !(Math.abs((answer.summed ?? 0) - sum) < 1)) flags.push(`summed ${answer.summed ?? "nothing"}, where the fact through the range has ${sum}`);
  if (screened !== undefined && (answer.screened ?? 0) < screened) flags.push(`${answer.screened ?? "no"} screen matches, not ${screened}`);
  if (rejected === true && !(answer.reads.length > 1 && answer.screened === 0)) {
    flags.push(`${answer.screened ?? "no"} windows left over ${answer.reads.length} engine reads: the rounds did not run, or a window stood`);
  }
  if (withheld === true && !(answer.code === "WITHHELD" && answer.reads.length === 0)) flags.push(`${answer.code ?? answer.status} over ${answer.reads.length} engine reads, not withheld with none`);
  if (hers === true) {
    const her = answer.hers;
    if (her === undefined || !her.ended) flags.push("her list did not end");
    else {
      if (her.hits === 0) flags.push("no hit of hers");
      if (her.twice > 0) flags.push(`${her.twice} hits given twice`);
      if (her.without > 0) flags.push(`${her.without} hits without ${her.placeholder}`);
      if (her.total !== her.hits) flags.push(`last total ${her.total ?? "none"}, not her ${her.hits} hits`);
    }
  }
  return flags.length === 0 ? null : flags.join("; ");
}

function rowsOf(answer: Answered | "cut"): string {
  if (answer === "cut") return "-";
  const all = answer.reads.reduce((sum, each) => sum + each, 0).toLocaleString("en");
  const engine = answer.engine_ms === undefined ? "" : `, engine ${answer.engine_ms.toFixed(0)} ms`;
  return answer.reads.length > 1 ? `${all} (${answer.reads.length} reads, most ${Math.max(...answer.reads).toLocaleString("en")}${engine})` : `${all}${engine === "" ? "" : ` (${engine.slice(2)})`}`;
}

function saidLine(answer: Answered | "cut"): string {
  if (answer === "cut") return "";
  if (answer.code === "TOO_BROAD") return `  (TOO_BROAD${answer.fits === undefined ? ", no fits" : `, fits ${answer.fits.from} to ${answer.fits.to}`})`;
  return answer.said === undefined || answer.said === "" ? "" : `  (${answer.said})`;
}

if (process.argv[2] === "--child") await child(process.argv[3]!, process.argv[4]!);
else process.exitCode = await gate();
