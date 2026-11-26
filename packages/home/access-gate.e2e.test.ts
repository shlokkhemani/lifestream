import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { civilDay, openHome, openHomeFolder, type DaySettings, type OpenView, type SourceRow, type Type } from "@lifestreamprotocol/core";
import { HOME_FILE, HOME_FORMAT } from "./lifecycle.js";
import { buildLabels, labelsFrom, MESSAGES_COLLECTIONS, MONEY_COLLECTIONS, PHYSICAL, type DayDocument, type DayFileFact, type Family, type PersonDetail, type Piece, type Searched } from "@lifestreamprotocol/families";
import { compile, type Access, type Allow, type Reach, type Window } from "@lifestreamprotocol/privacy";
import { presenceTablesOf, restsOnIn } from "./places.js";
import { peopleSearchAnswer } from "./people-search.js";
import type { PeopleSearchChat } from "./people.js";
import type { HeldPhoto, Photo } from "./photo.js";
import type { PresenceSource } from "./presence.js";
import { describedOf, readAnswerOf, servedRefOf, type ReadSources, type ScreenSource } from "./read.js";
import { stepKey, type Step } from "./reads.js";
import { refsLeaving } from "./way-out.js";
import { makeRef, personRef, readRef } from "./refs.js";
import { Refusal } from "./refusal.js";
import { ScreenIndex, type ScreenFrame, type ScreenSegment } from "./screen-index.js";
import type { ScreenWindow } from "./screen-reads.js";
import { answerOf, paramsOf, readParams, searchParams, searchPeopleParams, type SearchPeopleAnswer, type CountCatalog, type CountFound, type CountResult, type RecordList, type ScreenList, type SearchAnswer } from "./search-contract.js";
import { collectionsOf, countAskOf, countIn, countShown, openRow, plainCount } from "./count.js";
import { ASK_PRODUCT, Fetch, type PeopleMap } from "./counting.js";
import { countAsked } from "./test/record-reads.js";
import { lineAccountsOf, SearchIndex, type AtomEntry, type RecordEntry } from "./search-index.js";
import { recordPartOf, screenAnswerOf, searchAnswerOf, searchAskedOf } from "./search-route.js";
import { onCall, type CallOf, type Tables } from "./test/calls.js";
import type { FreshSource } from "./freshness.js";
import { presenceSource, writePresenceFile } from "./test/presence-file.js";
import { OUTSIDE_WORDS, type Call } from "./call.js";
import { READ_TOO_BROAD, rowsCounted } from "./work.js";

const UTC: DaySettings = { zone: "UTC", day_start_hour: 0 };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-14T12:00:00Z");
const OFF = null;

const WORK = "gmail:person-a@example.com";
const HOME = "gmail:person-b@example.com";
const CHAT = "whatsapp:15550000001";
const PROFILE_A = "chrome:person-a@example.com";
const PROFILE_B = "chrome:person-b@example.com";
const HEALTH = "health:local";
const MONEY = "bank:acct-0001";
const SCREEN = "macscreen:macbook-pro-0001";
const LOCATION = "location:local";
const MOTION = "motion:local";
const TIMELINE = "google-timeline:person-a@example.com";
const MACHINE = "macbook-pro-0001";
const SCREEN_SRC = `${SCREEN}:${MACHINE}`;
const CATEGORY: Record<string, Type> = {
  [WORK]: "mail", [HOME]: "mail", [CHAT]: "messages", [PROFILE_A]: "web", [PROFILE_B]: "web", [HEALTH]: "health", [MONEY]: "money", [SCREEN]: "device-activity",
  [LOCATION]: "places", [MOTION]: "places", [TIMELINE]: "places",
};
const category = (account: string): Type | null => CATEGORY[account] ?? null;

const SAM_CHAT = "whatsapp:15550000002@s.whatsapp.net";
const GROUP = "whatsapp:120363000000000001@g.us";

interface Held {
  entry: RecordEntry;
  chat?: string;
  accounts?: string[];
}

const held = (account: string, key: string, at_ms: number, words: string, family: string, more: { chat?: string; accounts?: string[]; dated?: true } = {}): Held => ({
  entry: { record: { source: `${account}:phone-7669`, kind: "item", key }, family, version: `v-${key}`, start_ms: at_ms, end_ms: null, title: "", text: words, who: [], link: null, ...(more.dated === undefined ? {} : { dated: true }) },
  ...(more.chat === undefined ? {} : { chat: more.chat }), ...(more.accounts === undefined ? {} : { accounts: more.accounts }),
});

const RECORDS: Held[] = [
  held(WORK, "m1", NOW - 2 * HOUR, "invoice paid today", "mail"),
  held(WORK, "m2", NOW - 30 * HOUR, "invoice from last week", "mail"),
  held(WORK, "m3", NOW - 3 * HOUR, "invoice sent to the accountant", "mail"),
  held(WORK, "m4", NOW - 5 * HOUR, "lunch on friday", "mail"),
  held(WORK, "r1", NOW - 4 * HOUR, "the invoice quoted in a reply", "mail", { accounts: [WORK, HOME] }),
  held(HOME, "h1", NOW - HOUR, "invoice for the flat", "mail"),
  held(CHAT, "w1", NOW - HOUR, "invoice in the group", "messages", { chat: GROUP }),
  held(CHAT, "w2", NOW - 2 * HOUR, "invoice between us", "messages", { chat: SAM_CHAT }),
  held(PROFILE_A, "v1", NOW - 6 * HOUR, "invoice template read on two profiles", "web", { accounts: [PROFILE_A, PROFILE_B] }),
  held(PROFILE_A, "v2", NOW - 7 * HOUR, "invoice archive page", "web"),
  held(MONEY, "p1", NOW - 8 * HOUR, "invoice payment to the studio", "money"),
  held(WORK, "d1", Date.parse("2026-11-14T00:00:00Z"), "invoice due today", "mail", { dated: true }),
  held(WORK, "d2", Date.parse("2026-11-13T00:00:00Z"), "invoice due yesterday", "mail", { dated: true }),
];

const lone = (n: number, family: string, at_ms: number, text: string, accounts?: string[]): AtomEntry => ({
  n, family, unit: `${family}:lone-${n}`, start_ms: at_ms, end_ms: null, text, ...(accounts === undefined ? {} : { accounts }),
});
const SLEEP = lone(900, "health", NOW - 6 * HOUR, "slept with an invoice under the pillow", [HEALTH]);
const BOTH = lone(901, "mail", NOW - 9 * HOUR, "an invoice count across both mailboxes", [WORK, HOME]);
const UNSTATED = lone(902, "notes", NOW - 10 * HOUR, "an invoice scribbled on a napkin");
const LINES = [SLEEP, BOTH, UNSTATED];

const scratch = mkdtempSync(join(tmpdir(), "lifestream-access-gate-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
let seq = 0;

function indexFile(records: readonly Held[], lines: readonly AtomEntry[]): { index: SearchIndex; file: string } {
  const file = join(scratch, `r${++seq}`, "index.db");
  mkdirSync(join(scratch, `r${seq}`), { recursive: true });
  const built = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, UTC);
  built.records([], [], { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } });
  built.finish();
  const index = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, UTC);
  index.records(records.map((each) => each.entry), [], { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } });
  const days = new Map<string, AtomEntry[]>();
  records.forEach(({ entry, chat, accounts }, n) => {
    const day = civilDay(entry.start_ms!, UTC);
    days.set(day, [...days.get(day) ?? [], {
      n: n + 1, family: entry.family, unit: `${entry.family}:${entry.record.key}`, record: entry.record, start_ms: entry.start_ms, end_ms: null, text: entry.text,
      ...(entry.dated === true ? { dated: true } : {}), ...(chat === undefined ? {} : { chat }), ...(accounts === undefined ? {} : { accounts }),
    }]);
  });
  for (const line of lines) {
    const day = civilDay(line.start_ms!, UTC);
    days.set(day, [...days.get(day) ?? [], line]);
  }
  for (const [day, atoms] of days) index.day(day, { inputs: `in-${++seq}`, mtime_us: seq, atoms });
  return { index, file };
}

const indexOf = (records: readonly Held[], lines: readonly AtomEntry[] = LINES): SearchIndex => indexFile(records, lines).index;

function owedOf(records: readonly Held[]): SearchIndex {
  const { index, file } = indexFile(records, LINES);
  index.close();
  const db = new Database(file);
  try {
    db.prepare("UPDATE meta SET value = '0' WHERE key = 'facts_format'").run();
  } finally {
    db.close();
  }
  return SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, UTC);
}

function access(parts: Partial<Access>): Access {
  return { allow: [], items: [], not: [], only: [], window: null, hide: "none", shown: [], ...parts };
}
const allow = (reach: Reach, window: Window = null): Allow => ({ reach, window, until_ms: null });
const account = (id: string): Reach => ({ account: id, but: [] });

const FULL = access({ allow: [allow({ all: true, but: [] })] });
const DEFAULT = access({ allow: [allow({ all: true, but: ["health", "money"] })] });
const MAIL_DAY = access({ allow: [allow({ type: "mail", but: [] }, { past_ms: DAY })] });
const OPEN_BESIDE = access({ allow: [allow({ all: true, but: [] }), allow(account(CHAT))] });
const WORK_ONLY = access({ allow: [allow(account(WORK))] });
const BOTH_MAIL = access({ allow: [allow(account(WORK)), allow(account(HOME))] });

const SMALLER: [string, Access, string[], AtomEntry[]][] = [
  ["Full", FULL, RECORDS.map((each) => each.entry.record.key), LINES],
  ["Everything but Health and Money (the default)", DEFAULT, ["m1", "m2", "m3", "m4", "r1", "h1", "w1", "w2", "v1", "v2", "d1", "d2"], [BOTH]],
  ["Mail · past 24 hours", MAIL_DAY, ["m1", "m3", "m4", "r1", "h1", "d1"], [BOTH]],
];

const BUDGET = 2_600;

const context = (index: SearchIndex, more: Partial<CallOf> = {}): CallOf => ({ index, epoch: 1, now_ms: NOW, category, ...more });

function ask(index: SearchIndex, params: Record<string, string>, more: Partial<CallOf> = {}): { answer: SearchAnswer; call: Call } {
  const query = new URLSearchParams(params);
  return onCall(context(index, more), (call) => {
    const asked = searchAskedOf(paramsOf(searchParams, query));
    const answer = searchAnswerOf(asked, call, recordPartOf(asked, call).answer, undefined);
    return { answer: answerOf("/v1/search", 200, JSON.parse(JSON.stringify(answer))) as SearchAnswer, call };
  });
}

function refusal(work: () => unknown, words = false): string {
  try {
    work();
    return "answered";
  } catch (error) {
    if (error instanceof Refusal) return `${error.status} ${error.code}${words ? ` ${error.words}` : ""}`;
    throw error;
  }
}

const keyOf = (ref: string) => (ref.startsWith("record.") ? readRef(ref, "ref", ["record"]).parts.key : ref);
const keysOf = (answer: SearchAnswer) => answer.record!.hits.map((hit) => keyOf(hit.ref));

interface Followed {
  pages: { total?: number; capped?: boolean; next: boolean; spread?: RecordList["spread"]; held?: RecordList["held"] }[];
  keys: string[];
  variants?: SearchAnswer["variants"];
}

function follow(index: SearchIndex, params: Record<string, string>, more: Partial<CallOf> = {}): Followed {
  const pages: Followed["pages"] = [];
  const keys: string[] = [];
  let { answer } = ask(index, { lists: "record", ...params }, more);
  const variants = answer.variants;
  for (let page = 0; page < 50; page++) {
    const list = answer.record!;
    keys.push(...list.hits.map((hit) => keyOf(hit.ref)));
    pages.push({
      ...(list.total === undefined ? {} : { total: list.total }), ...(list.capped === undefined ? {} : { capped: list.capped }), next: typeof list.next === "string",
      ...(list.spread === undefined ? {} : { spread: list.spread }), ...(list.held === undefined ? {} : { held: list.held }),
    });
    if (typeof list.next !== "string") break;
    ({ answer } = ask(index, { cursor: list.next }, more));
  }
  return { pages, keys: keys.sort(), ...(variants === undefined ? {} : { variants }) };
}

const ASKS: Record<string, string>[] = [
  { query: "invoice" }, { query: "invoice", limit: "2" }, { limit: "2" }, { order: "oldest", limit: "1" }, { query: "invoce" }, { query: "invoice", order: "oldest", limit: "3" },
  { query: "invoice", from: "2026-11-14T09:00Z" }, { query: "lunch" }, { query: "accountant" }, { query: "pillow" }, { query: "due" },
];

describe("a search under a gate answers what a home holding only the allowed records answers", () => {
  it.each(SMALLER)("%s", (_name, lines, records, kept) => {
    const whole = indexOf(RECORDS);
    const smaller = indexOf(RECORDS.filter((each) => records.includes(each.entry.record.key)), kept);
    for (const params of ASKS) {
      const gated = follow(whole, params, { access: lines });
      expect({ params, ...gated }).toEqual({ params, ...follow(smaller, params) });
    }
  });

  it("judges an entry by every account its row states: a record stated by two profiles, a reply quoting a withheld mailbox, a lone line of two", () => {
    const whole = indexOf(RECORDS);
    const keys = (lines: Access, query: string) => keysOf(ask(whole, { lists: "record", query }, { access: lines }).answer);
    expect(keys(access({ allow: [allow(account(PROFILE_A))] }), "template")).toEqual([]);
    expect(keys(access({ allow: [allow(account(PROFILE_A)), allow(account(PROFILE_B))] }), "template")).toEqual(["v1"]);
    expect(keys(access({ allow: [allow(account(PROFILE_A))] }), "archive")).toEqual(["v2"]);
    expect(keys(WORK_ONLY, "quoted")).toEqual([]);
    expect(keys(BOTH_MAIL, "quoted")).toEqual(["r1"]);
    expect(keys(WORK_ONLY, "mailboxes")).toEqual([]);
    expect(keys(BOTH_MAIL, "mailboxes")).toHaveLength(1);
    expect(keys(access({ allow: [allow({ type: "mail", but: [HOME] })] }), "mailboxes")).toEqual([]);
  });

  it("judges a dated record at its day's start against a window", () => {
    const whole = indexOf(RECORDS);
    expect(keysOf(ask(whole, { lists: "record", query: "due" }, { access: MAIL_DAY }).answer)).toEqual(["d1"]);
    expect(keysOf(ask(whole, { lists: "record", query: "due" }, { access: access({ allow: [allow(account(WORK), { past_ms: 37 * HOUR })] }) }).answer).sort()).toEqual(["d1", "d2"]);
  });

  it("withholds a line no row states under every gate that is not open, and serves it beside an open allow", () => {
    const whole = indexOf(RECORDS);
    const lines = (more: Partial<CallOf>) => ask(whole, { lists: "record", query: "napkin" }, more).answer.record!.hits.map((hit) => hit.family);
    expect(lines({})).toEqual(["notes"]);
    expect(lines({ access: OPEN_BESIDE })).toEqual(["notes"]);
    for (const shut of [DEFAULT, MAIL_DAY, WORK_ONLY]) expect(lines({ access: shut })).toEqual([]);
    for (const params of ASKS) expect(follow(whole, params, { access: OPEN_BESIDE })).toEqual(follow(whole, params));
  });

  it("answers an owed facts layer INDEX_BUILDING under a gate, and main's answer under none", () => {
    const owed = owedOf(RECORDS);
    const whole = indexOf(RECORDS);
    expect(follow(owed, { query: "invoice" })).toEqual(follow(whole, { query: "invoice" }));
    for (const lines of [DEFAULT, MAIL_DAY]) expect(refusal(() => ask(owed, { lists: "record", query: "invoice" }, { access: lines }))).toBe("503 INDEX_BUILDING");
    expect(follow(owed, { query: "invoice" }, { access: FULL })).toEqual(follow(whole, { query: "invoice" }));
  });
});

describe("a step carries data only", () => {
  it("crosses a clone as it is, and two equal searches under two accesses never share a read", () => {
    const step = (lines: Access | undefined): Step => ({ ask: { query: "invoice" }, ...(lines === undefined ? {} : { access: lines }) });
    expect(structuredClone(step(MAIL_DAY))).toEqual(step(MAIL_DAY));
    expect(() => structuredClone(compile(MAIL_DAY, NOW, category))).toThrow();
    const key = (lines: Access | undefined) => stepKey("/v1/search", step(lines), undefined);
    expect(new Set([key(undefined), key(DEFAULT), key(MAIL_DAY), key(WORK_ONLY), key(BOTH_MAIL)]).size).toBe(5);
    expect(key(structuredClone(MAIL_DAY))).toBe(key(MAIL_DAY));
  });
});

describe("where the person was, under a gate", () => {
  const PARIS = { latitude: 48.8566, longitude: 2.3522 };
  const labels = labelsFrom((unit) => {
    const content = buildLabels({ places: [{ slug: "home", name: "Home", latitude: PARIS.latitude, longitude: PARIS.longitude, radius_m: 100, also: [], ids: [] }] }).contents.get(unit);
    return content === undefined ? undefined : { content };
  }, UTC);
  const stay: Piece = { kind: "stay", level: "place", how: "observed", point: PARIS, from: null, to: null, units: [`stay/location:local:iphone-aa01/${NOW - 3 * DAY}`], start_ms: NOW - 3 * DAY, end_ms: NOW };
  const file = join(scratch, "places.db");
  writePresenceFile(file, presenceTablesOf([stay], ["2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14"], labels, new Map(), UTC, NOW, restsOnIn([], [])));
  const presence = presenceSource(file);

  it("a hit states its place when the stay is allowed; under Mail · past 24 hours none, its time in the home's zone, and a place names nothing", () => {
    const whole = indexOf(RECORDS);
    const hit = (more: Partial<CallOf>) => ask(whole, { lists: "record", query: "flat" }, { presence, ...more }).answer.record!.hits[0]!;
    const plain = hit({});
    expect([plain.the_user_was_at, plain.at]).toEqual(["Home", "2026-11-14T12:00+01:00"]);
    expect(hit({ access: DEFAULT })).toEqual(plain);
    const gated = hit({ access: MAIL_DAY });
    expect([gated.the_user_was_at, gated.at]).toEqual([undefined, "2026-11-14T11:00+00:00"]);
    const placed = (more: Partial<CallOf>) => keysOf(ask(whole, { lists: "record", query: "flat", place: "Home" }, { presence, ...more }).answer);
    expect(placed({})).toEqual(["h1"]);
    expect(placed({ access: DEFAULT })).toEqual(["h1"]);
    expect(placed({ access: MAIL_DAY })).toEqual([]);
  });
});

describe("what was kept out", () => {
  it("states outside when, and only when, the walk passed over a withheld match, and never on a next", () => {
    const whole = indexOf(RECORDS);
    const kept = ask(whole, { lists: "record", query: "invoice", limit: "1" }, { access: MAIL_DAY });
    expect(kept.answer.outside).toBe(true);
    expect(kept.answer.record!.hits).toHaveLength(1);
    expect(kept.call.log.withheld).toEqual({ by: { "no-line": 8, unresolved: 1 }, capped: false });
    const windowed = ask(whole, { lists: "record", query: "invoice" }, { access: access({ allow: [allow(account(WORK))], window: { past_ms: DAY } }) });
    expect(windowed.call.log.withheld).toEqual({ by: { window: 2, "no-line": 9, unresolved: 1 }, capped: false });
    expect(JSON.stringify(kept.answer)).not.toMatch(/no-line|unresolved|withheld/u);
    const next = ask(whole, { cursor: kept.answer.record!.next! }, { access: MAIL_DAY });
    expect(next.answer.outside).toBeUndefined();
    const lunch = ask(whole, { lists: "record", query: "lunch" }, { access: MAIL_DAY });
    expect(lunch.answer.outside).toBeUndefined();
    expect(lunch.call.log.withheld).toBeUndefined();
    const anything = ask(whole, { lists: "record", query: "accountant" }, { access: DEFAULT });
    expect([anything.answer.outside, anything.answer.record!.total]).toEqual([undefined, 1]);
  });

  it("a withheld match past the first page still states outside", () => {
    const records = [...Array.from({ length: 30 }, (_, n) => held(WORK, `r${n}`, NOW - (n + 1) * 60_000, `receipt number ${n}`, "mail")), held(HOME, "x1", NOW - 20 * HOUR, "receipt at home", "mail")];
    const whole = indexOf(records, []);
    const answer = ask(whole, { lists: "record", query: "receipt", limit: "5", order: "newest" }, { access: WORK_ONLY });
    expect([answer.answer.outside, answer.answer.record!.total, answer.answer.record!.hits.length]).toEqual([true, 30, 5]);
    expect(answer.call.log.withheld).toEqual({ by: { "no-line": 1 }, capped: false });
  });

  it("at the walk's cap, states outside for a withheld match it passed and says it stopped, states nothing of one past the cap, and tells reached from the last allowed row", () => {
    const receipts = (account: string, count: number, from: number) => Array.from({ length: count }, (_, n) => held(account, `${account === WORK ? "r" : "x"}${n}`, NOW - (from + n) * 60_000, `receipt number ${n}`, "mail"));
    const capped = (records: readonly Held[]) => ask(indexOf(records, []), { lists: "record", query: "receipt", order: "newest" }, { access: WORK_ONLY, budget: BUDGET });
    const passed = capped([...receipts(WORK, 10, 10), ...receipts(HOME, 400, 100)]);
    const list = passed.answer.record!;
    expect([list.capped, list.total, passed.answer.outside, passed.call.log.withheld?.capped, Object.keys(passed.call.log.withheld!.by)]).toEqual([true, 10, true, true, ["no-line"]]);
    expect(list.reached?.at).toBe(list.hits.at(-1)!.at);
    const beyond = capped([...receipts(WORK, 400, 10), ...receipts(HOME, 1, 1_000)]);
    expect([beyond.answer.record!.capped, beyond.answer.outside, beyond.call.log.withheld]).toEqual([true, undefined, undefined]);
  });

  it("goto is not stated under a gate", () => {
    const whole = indexOf(RECORDS);
    const gated = ask(whole, { lists: "goto", query: "today" }, { access: MAIL_DAY, people: { find: () => [], person: () => undefined } as never });
    expect(gated.answer.goto).toBeUndefined();
    expect(ask(whole, { lists: "goto", query: "today" }, { people: { find: () => [], person: () => undefined } as never }).answer.goto?.day).toBe("2026-11-14");
  });
});

describe("no gate, no cost", () => {
  const statements = (work: () => void): { sql: string[]; rows: number } => {
    const prepare = vi.spyOn(Database.prototype, "prepare");
    const before = rowsCounted();
    work();
    const sql = prepare.mock.calls.map(([text]) => text).filter((text) => !text.startsWith("EXPLAIN") && !text.includes("pragma_"));
    prepare.mockRestore();
    return { sql, rows: rowsCounted() - before };
  };

  it("with no access, and with a full one, the walk prepares main's statements and reads the same rows", () => {
    expect(compile(FULL, NOW, category)).toBeNull();
    const runs = [undefined, FULL].map((lines) => statements(() => {
      const whole = indexOf(RECORDS);
      for (const params of ASKS) follow(whole, params, lines === undefined ? {} : { access: lines });
    }));
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[0]!.sql.some((sql) => sql.includes("entry_states x"))).toBe(false);
    const gated = statements(() => {
      const whole = indexOf(RECORDS);
      for (const params of ASKS) follow(whole, params, { access: MAIL_DAY });
    });
    expect(gated.sql.some((sql) => sql.includes("LEFT JOIN entry_states x ON x.slot = e.slot"))).toBe(true);
  });
});

interface Shown {
  from: number;
  title: string;
  lines: string[];
}

function screenFile(windows: readonly Shown[]): string {
  const file = join(scratch, `s${++seq}`, "screen.db");
  mkdirSync(join(scratch, `s${seq}`), { recursive: true });
  const segments: ScreenSegment[] = windows.map((window) => ({
    machine: MACHINE, version: "v1", start_ms: window.from,
    frames: Array.from({ length: 5 }, (_, f): ScreenFrame => ({ t: window.from + f * 4_000, app: "Safari", site: null, title: window.title, display: "1", lines: window.lines })),
  }));
  const source = { segments: (machine: string, day: string) => segments.filter((each) => each.machine === machine && civilDay(each.start_ms, UTC) === day) };
  const build = ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: UTC, meaning: false }, () => true);
  build.apply(segments, source, { seq: 7 });
  build.finish();
  return file;
}

const WINDOWS: Shown[] = [
  { from: NOW - 2 * HOUR, title: "Billing recent", lines: ["the invoice for the studio"] },
  { from: NOW - 30 * HOUR, title: "Billing older", lines: ["an older invoice for the studio"] },
  { from: NOW - 50 * HOUR, title: "Billing oldest", lines: ["the oldest invoice of all"] },
];

async function screenOf(file: string, more: Partial<CallOf>): Promise<{ list: ScreenList; answer: SearchAnswer }> {
  const query = new URLSearchParams({ lists: "screen", query: "invoice" });
  return onCall({ now_ms: NOW, epoch: 1, screen: file, index: indexOf([], []), screenAccounts: new Map([[MACHINE, [SCREEN]]]), category, ...more }, async (call) => {
    const asked = searchAskedOf(paramsOf(searchParams, query));
    const part = await screenAnswerOf(asked, call, { meaningModel: OFF, file });
    const answer = answerOf("/v1/search", 200, JSON.parse(JSON.stringify(searchAnswerOf(asked, call, undefined, part)))) as SearchAnswer;
    return { list: answer.screen as ScreenList, answer };
  });
}

const windowsOf = (list: ScreenList) => list.hits.map((hit) => `${hit.day} ${hit.title}`).sort();
const shapeOf = (list: ScreenList) => ({ total: list.total, windows: windowsOf(list), next: list.next });

describe("the screen list under a gate", () => {
  it("holds the windows of a Mac whose screen source the access allows, inside its window, as a smaller home does", async () => {
    const whole = screenFile(WINDOWS);
    const day = access({ allow: [allow(account(SCREEN), { past_ms: DAY })] });
    const gated = await screenOf(whole, { access: day });
    const smaller = await screenOf(screenFile([WINDOWS[0]!]), {});
    expect(shapeOf(gated.list)).toEqual(shapeOf(smaller.list));
    expect(windowsOf(gated.list)).toEqual(["2026-11-14 Billing recent"]);
    expect(gated.answer.outside).toBe(true);
    expect(smaller.answer.outside).toBeUndefined();
    expect(Date.parse(gated.list.hits[0]!.at!)).toBeGreaterThanOrEqual(NOW - DAY);
  });

  it("under the three accesses: everything under full and the default; under Mail · past 24 hours no screen part, and nothing of the screen said", async () => {
    const whole = screenFile(WINDOWS);
    const plain = await screenOf(whole, {});
    for (const lines of [FULL, DEFAULT]) {
      const gated = await screenOf(whole, { access: lines });
      expect(shapeOf(gated.list)).toEqual(shapeOf(plain.list));
      expect(gated.answer.outside).toBeUndefined();
    }
    const none = await screenOf(whole, { access: MAIL_DAY });
    expect([none.answer.screen, none.answer.outside]).toEqual([undefined, undefined]);
  });
});

const MINUTE = 60_000;
const COUNTED: readonly Family[] = [
  { name: "messages", collections: MESSAGES_COLLECTIONS } as unknown as Family,
  { name: "money", collections: MONEY_COLLECTIONS } as unknown as Family,
  { name: "health", collections: { days: { keys: ["instrument"], measures: { steps: { unit: "count", ops: ["sum", "avg", "min", "max"], time: "start", split: "whole", from: "stated" } } } } } as unknown as Family,
];

interface Stated {
  account?: string;
  accounts?: string[];
  dated?: true;
}

const recordOf = (account: string | undefined, kind: string, key: string) => (account === undefined ? {} : { record: { source: `${account}:phone-7669`, kind, key }, alone: true as const });
const day0 = (at_ms: number) => Date.parse(`${civilDay(at_ms, UTC)}T00:00:00Z`);

function message(key: string, at_ms: number, product: string, chat: string, stated: Stated): DayFileFact {
  const start = stated.dated === undefined ? at_ms : day0(at_ms);
  return {
    id: `messages:${key.padStart(24, "0")}`, family: "messages", of: "messages", time_ms: start, start_ms: start, end_ms: start, ...(stated.dated === undefined ? {} : { date_only: true }),
    keys: { chat, direction: "incoming", product }, measures: {}, who: [],
    from: { units: [`messages/${key}`], ...recordOf(stated.account, "message", key), ...(stated.accounts === undefined ? {} : { accounts: stated.accounts }) }, lines: [],
  };
}

function payment(key: string, at_ms: number, payee: string, amount: string, stated: Stated): DayFileFact {
  const start = stated.dated === undefined ? at_ms : day0(at_ms);
  return {
    id: `payments:${key.padStart(24, "0")}`, family: "money", of: "payments", time_ms: start, start_ms: start, end_ms: start, ...(stated.dated === undefined ? {} : { date_only: true }),
    keys: { payee, direction: "debit", currency: "EUR" }, measures: { amount }, who: [],
    from: { units: [`money/${key}`], ...recordOf(stated.account, "payment", key), ...(stated.accounts === undefined ? {} : { accounts: stated.accounts }) }, lines: [],
  };
}

const steps = (key: string, at_ms: number, n: number): DayFileFact => ({
  id: `days:${key.padStart(24, "0")}`, family: "health", of: "days", time_ms: day0(at_ms), start_ms: day0(at_ms), end_ms: day0(at_ms), date_only: true,
  keys: { instrument: "Watch" }, measures: { steps: n }, who: [], from: { units: [`health/${key}`], instrument: "Watch", accounts: [HEALTH] }, lines: [],
});

const BULK = Array.from({ length: 56 }, (_, n) => message(`b${n}`, NOW - (n + 10) * MINUTE, "gmail", "bulk", { account: n % 2 === 0 ? WORK : HOME }));
const FACTS: DayFileFact[] = [
  message("m1", NOW - 2 * HOUR, "gmail", "alpha", { account: WORK }),
  message("m2", NOW - 30 * HOUR, "gmail", "alpha", { account: WORK }),
  message("m3", NOW - HOUR, "gmail", "beta", { account: HOME }),
  message("m4", NOW - 4 * HOUR, "gmail", "beta", { account: WORK, accounts: [WORK, HOME] }),
  message("w1", NOW - HOUR, "whatsapp", "delta", { account: CHAT }),
  message("w2", NOW - 50 * HOUR, "whatsapp", "epsilon", { account: CHAT }),
  message("u1", NOW - 3 * HOUR, "notes", "napkin", {}),
  message("d1", Date.parse("2026-11-13T09:00:00Z"), "gmail", "gamma", { account: WORK, dated: true }),
  message("d2", Date.parse("2026-11-14T09:00:00Z"), "gmail", "gamma", { account: WORK, dated: true }),
  payment("p1", Date.parse("2026-11-13T09:00:00Z"), "ACME CABS", "50.00", { account: MONEY, dated: true }),
  payment("p2", Date.parse("2026-11-14T09:00:00Z"), "ACME CABS", "7.25", { account: MONEY, dated: true }),
  payment("p3", NOW - 5 * HOUR, "STUDIO", "20.00", { account: MONEY, accounts: [MONEY, WORK] }),
  payment("p4", NOW - 6 * HOUR, "STUDIO", "12.00", { account: WORK }),
  steps("h1", Date.parse("2026-11-13T09:00:00Z"), 9000),
  ...BULK,
];

const keyOfFact = (fact: DayFileFact) => fact.id.slice(fact.id.indexOf(":") + 1).replace(/^0+/u, "");
const BULK_WORK = BULK.filter((_, n) => n % 2 === 0).map(keyOfFact);
const BULK_ALL = BULK.map(keyOfFact);

const COUNT_HOME = join(scratch, "count-home");
mkdirSync(join(COUNT_HOME, "days"), { recursive: true });
writeFileSync(join(COUNT_HOME, HOME_FILE), JSON.stringify({ format: HOME_FORMAT, id: "home-test", created: "2026-10-01T00:00:00Z" }));
openHome(openHomeFolder(COUNT_HOME), "migrate").close();

function factsIndex(facts: readonly DayFileFact[]): SearchIndex {
  const file = join(scratch, `c${++seq}`, "index.db");
  mkdirSync(join(scratch, `c${seq}`), { recursive: true });
  const index = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, UTC);
  index.records([], [], { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } });
  const days = new Map<string, DayFileFact[]>();
  for (const fact of facts) days.set(civilDay(fact.start_ms, UTC), [...days.get(civilDay(fact.start_ms, UTC)) ?? [], fact]);
  for (const [day, held] of days) {
    const start_ms = Date.parse(`${day}T00:00:00Z`);
    index.day(day, { inputs: `in-${++seq}`, mtime_us: seq, atoms: [], facts: { window: { start_ms, end_ms: start_ms + DAY }, facts: held } });
  }
  return index;
}

const COUNTS: [string, Access, string[]][] = [
  ["Full", FULL, FACTS.map(keyOfFact)],
  ["Everything but Health and Money (the default)", DEFAULT, ["m1", "m2", "m3", "m4", "w1", "w2", "d1", "d2", "p4", ...BULK_ALL]],
  ["Mail · past 24 hours", MAIL_DAY, ["m1", "m3", "m4", "d2", "p4", ...BULK_ALL]],
];

const COUNT_ASKS: Record<string, string>[] = [
  { of: "messages" }, { of: "messages", by: "product" }, { of: "messages", by: "day" }, { of: "messages", by: "chat" }, { of: "messages", from: "2026-11-14" },
  { of: "messages", by: "item" }, { of: "messages", "match.product": "gmail", by: "chat" },
  { of: "payments", measure: "amount", op: "sum" }, { of: "payments", measure: "amount", op: "max" }, { of: "payments", measure: "amount", op: "first" },
  { of: "payments", measure: "amount", op: "last" }, { of: "payments", by: "payee" }, { of: "days", measure: "steps", op: "sum" },
  { of: "payments", "match.payee": "acme" }, { of: "payments", measure: "amount", op: "sum", "match.payee": "studio" },
];

type Counted = CountResult | CountFound | CountCatalog;

function counting(index: SearchIndex, params: Record<string, string>, more: Partial<CallOf> = {}): { answer: Counted; call: Call } {
  return onCall({ ...context(index, more), families: COUNTED, home: join(COUNT_HOME, "home.db"), fresh: () => undefined }, (call) => {
    const asked = countAsked(params, collectionsOf(COUNTED));
    const answer = countShown(countIn(call, asked, (read, counted, held) => plainCount(read, counted, held)), asked);
    return { answer: answerOf("/v1/count", 200, JSON.parse(JSON.stringify(answer))) as Counted, call };
  });
}

function opened(index: SearchIndex, ref: string, more: Partial<CallOf> = {}): unknown {
  return onCall({ ...context(index, more), families: COUNTED, home: join(COUNT_HOME, "home.db"), fresh: () => undefined }, (call) => {
    const { ask: written, kept, scope } = readRef(ref, "ref", ["row"]).parts;
    const asked = countAskOf(written, collectionsOf(COUNTED));
    return countShown(openRow(call, asked, kept, scope, undefined).answer, asked);
  });
}

const rowsOf = (answer: Counted) => ("rows" in answer ? answer.rows ?? [] : []);
const cursorOf = (answer: Counted) => ("next" in answer && typeof answer.next === "string" ? answer.next : undefined);
const placed = (answer: Counted) => {
  const { outside: _outside, ...rest } = answer as Counted & { outside?: true };
  return { ...rest, ...("next" in rest ? { next: typeof rest.next === "string" } : {}) };
};

function pages(index: SearchIndex, params: Record<string, string>, more: Partial<CallOf> = {}): { pages: unknown[]; opened: unknown[] } {
  const all: unknown[] = [];
  const rows: unknown[] = [];
  let { answer } = counting(index, params, more);
  for (let page = 0; page < 10; page++) {
    all.push(placed(answer));
    rows.push(...rowsOf(answer));
    const next = cursorOf(answer);
    if (next === undefined) break;
    ({ answer } = counting(index, { cursor: next }, more));
  }
  const refs = rows.map((row) => (row as unknown[]).at(-1)).filter((ref): ref is string => typeof ref === "string" && ref.startsWith("row."));
  return { pages: all, opened: refs.slice(0, 3).map((ref) => placed(opened(index, ref, more) as Counted)) };
}

describe("a count under a gate answers what a home holding only the allowed facts answers", () => {
  it.each(COUNTS)("%s", (_name, lines, kept) => {
    const whole = factsIndex(FACTS);
    const smaller = factsIndex(FACTS.filter((fact) => kept.includes(keyOfFact(fact))));
    for (const params of COUNT_ASKS) expect({ params, ...pages(whole, params, { access: lines }) }).toEqual({ params, ...pages(smaller, params) });
  });

  it("withholds a fact of two accounts with one allowed, a fact resting on one record of a withheld account, and a dated fact against a window", () => {
    const whole = factsIndex(FACTS);
    const total = (lines: Access, params: Record<string, string>) => (counting(whole, params, { access: lines }).answer as CountResult).total?.n;
    expect(total(WORK_ONLY, { of: "messages", "match.product": "gmail", "match.chat": "beta" })).toBe(0);
    expect(total(BOTH_MAIL, { of: "messages", "match.product": "gmail", "match.chat": "beta" })).toBe(2);
    expect(total(WORK_ONLY, { of: "payments" })).toBe(1);
    expect(total(access({ allow: [allow(account(MONEY))] }), { of: "payments" })).toBe(2);
    expect(total(MAIL_DAY, { of: "messages", "match.chat": "gamma" })).toBe(1);
    expect(total(access({ allow: [allow(account(WORK), { past_ms: 2 * DAY })] }), { of: "messages", "match.chat": "gamma" })).toBe(2);
  });

  it("reads every tally the gate holds whole, and walks the facts of a day only where its window cuts a tally of that day", () => {
    const at = (iso: string) => Date.parse(iso);
    const cut: DayFileFact[] = [
      message("c1", at("2026-11-12T10:00:00Z"), "gmail", "alpha", { account: WORK }),
      message("c2", at("2026-11-13T06:00:00Z"), "gmail", "alpha", { account: WORK }),
      message("c3", at("2026-11-13T18:00:00Z"), "gmail", "beta", { account: WORK }),
      message("c4", at("2026-11-14T09:00:00Z"), "gmail", "alpha", { account: WORK }),
      message("c5", at("2026-11-14T10:00:00Z"), "gmail", "beta", { account: WORK, accounts: [WORK, HOME] }),
      message("c6", at("2026-11-13T20:00:00Z"), "gmail", "beta", { account: WORK, accounts: [WORK, HOME] }),
    ];
    const windowed = access({ allow: [allow(account(WORK))], window: { past_ms: DAY } });
    const whole = factsIndex(cut);
    const smaller = factsIndex(cut.filter((fact) => ["c3", "c4"].includes(keyOfFact(fact))));
    const walked = vi.spyOn(Fetch.prototype, "dayFacts");
    const asks: [Record<string, string>, string[]][] = [
      [{ of: "messages" }, ["2026-11-13"]], [{ of: "messages", by: "day" }, ["2026-11-13"]], [{ of: "messages", by: "chat" }, ["2026-11-13"]],
      [{ of: "messages", "match.chat": "beta" }, []],
    ];
    for (const [params, days] of asks) {
      walked.mockClear();
      expect({ params, ...pages(whole, params, { access: windowed }) }).toEqual({ params, ...pages(smaller, params) });
      expect({ params, walked: [...new Set(walked.mock.calls.map(([, day]) => day))] }).toEqual({ params, walked: days });
    }
    walked.mockClear();
    const counted = counting(whole, { of: "messages", by: "day" }, { access: windowed });
    expect([(counted.answer as CountResult).total?.n, counted.answer.outside, counted.call.log.withheld?.by]).toEqual([2, true, { window: 2, "no-line": 2 }]);
    walked.mockClear();
    const both = counting(whole, { of: "messages", "match.chat": "beta" }, { access: BOTH_MAIL });
    expect([(both.answer as CountResult).total?.n, both.answer.outside, walked.mock.calls.length]).toEqual([3, undefined, 0]);
    const work = counting(whole, { of: "messages", "match.chat": "beta" }, { access: WORK_ONLY });
    expect([(work.answer as CountResult).total?.n, work.call.log.withheld?.by, walked.mock.calls.length]).toEqual([1, { "no-line": 2 }, 0]);
    walked.mockRestore();
  });

  it("counts by a key over every day from the kept totals under the default, and under a window reads the tallies of the window's days alone", () => {
    const ANN = "whatsapp:15550000003@s.whatsapp.net";
    const people: PeopleMap = {
      version: "people-1",
      idOf: (id) => (id === SAM_CHAT ? "person:sam" : id === ANN ? "person:ann" : undefined),
      person: (id) => (id === "person:sam" ? { name: "Sam Example", handles: [SAM_CHAT] } : id === "person:ann" ? { name: "Ann Example", handles: [ANN] } : undefined),
      find: () => [],
    };
    const accountOf = [WORK, HOME, CHAT, MONEY, WORK];
    const spread = Array.from({ length: 90 }, (_, n): DayFileFact => {
      const account = accountOf[n % accountOf.length]!;
      const fact = message(`s${n}`, NOW - Math.floor(n / 3) * DAY - ((n % 3) + 1) * HOUR, account.slice(0, account.indexOf(":")), `chat-${n % 4}`, {
        account, ...(n % 7 === 0 && account !== MONEY ? { accounts: [account, MONEY] } : {}),
      });
      return { ...fact, who: [{ handle: n % 2 === 0 ? SAM_CHAT : ANN, role: "sender" }] };
    });
    const startOf = (fact: DayFileFact) => fact.start_ms;
    const accountsOf = (fact: DayFileFact) => fact.from.accounts ?? [fact.from.record!.source.slice(0, fact.from.record!.source.lastIndexOf(":"))];
    const allowedBy: [Access, (fact: DayFileFact) => boolean, string][] = [
      [DEFAULT, (fact) => accountsOf(fact).every((each) => each !== MONEY), "2026-10-15"],
      [MAIL_DAY, (fact) => startOf(fact) >= NOW - DAY && accountsOf(fact).every((each) => each === WORK || each === HOME), "2026-11-10"],
    ];
    const whole = factsIndex(spread);
    const tallied = vi.spyOn(Fetch.prototype, "cells");
    const walked = vi.spyOn(Fetch.prototype, "dayFacts");
    for (const [lines, allowed, earliest] of allowedBy) {
      const smaller = factsIndex(spread.filter(allowed));
      for (const params of [{ of: "messages", by: "product" }, { of: "messages", by: "person" }]) {
        tallied.mockClear();
        walked.mockClear();
        const counted = counting(whole, params, { access: lines, people });
        const read = tallied.mock.calls.filter(([kind]) => kind !== "days");
        expect({ params, ...pages(whole, params, { access: lines, people }) }).toEqual({ params, ...pages(smaller, params, { people }) });
        expect(counted.call.log.withheld?.by).toEqual({ "no-line": spread.length - spread.filter(allowed).length });
        expect({ params, earliest: read.map(([, , from]) => from).sort()[0] ?? earliest, walked: walked.mock.calls.every(([, day]) => day >= earliest) })
          .toEqual({ params, earliest, walked: true });
        if (lines === DEFAULT) expect({ params, read: read.length, walked: walked.mock.calls.length }).toEqual({ params, read: 0, walked: 0 });
        else expect({ params, read: read.length > 0 }).toEqual({ params, read: true });
      }
    }
    tallied.mockRestore();
    walked.mockRestore();
  });

  it("counts a row's handle again under the gate of the read that opens it", () => {
    const whole = factsIndex(FACTS);
    const { answer } = counting(whole, { of: "messages", by: "product" });
    const gmail = rowsOf(answer).find((row) => row[0] === "gmail")!;
    expect(gmail[1]).toBe(62);
    const reopened = opened(whole, String(gmail.at(-1)), { access: WORK_ONLY }) as CountResult;
    expect(reopened.total?.n).toBe(4 + BULK_WORK.length);
  });

  it("states outside when, and only when, a withheld fact matched, never on a next, and logs the withheld by why", () => {
    const whole = factsIndex(FACTS);
    const money = counting(whole, { of: "payments", measure: "amount", op: "sum" }, { access: DEFAULT });
    expect([(money.answer as CountResult).total?.sum, money.answer.outside]).toEqual(["12.00 EUR", true]);
    expect(money.call.log.withheld).toEqual({ by: { "no-line": 3 }, capped: false });
    const studio = counting(whole, { of: "payments", "match.payee": "studio" }, { access: MAIL_DAY });
    expect([(studio.answer as CountResult).total?.n, studio.answer.outside]).toEqual([1, true]);
    const mail = counting(whole, { of: "messages", "match.product": "gmail", from: "2026-11-14T08:00Z" }, { access: MAIL_DAY });
    expect([mail.answer.outside, mail.call.log.withheld]).toEqual([undefined, undefined]);
    const windowed = counting(whole, { of: "messages", "match.product": "gmail" }, { access: access({ allow: [allow(account(WORK))], window: { past_ms: DAY } }) });
    expect(windowed.call.log.withheld?.by).toEqual({ window: 2, "no-line": 30 });
    const unstated = counting(whole, { of: "messages", "match.product": "notes" }, { access: DEFAULT });
    expect([(unstated.answer as CountResult).total?.n, unstated.call.log.withheld?.by]).toEqual([0, { unresolved: 1 }]);
    const health = counting(whole, { of: "days", measure: "steps", op: "sum" }, { access: DEFAULT });
    expect([health.answer.outside, health.call.log.withheld?.by]).toEqual([true, { "no-line": 1 }]);
    const first = counting(whole, { of: "messages", by: "item" }, { access: MAIL_DAY });
    expect(first.answer.outside).toBe(true);
    const next = counting(whole, { cursor: cursorOf(first.answer)! }, { access: MAIL_DAY });
    expect(next.answer.outside).toBeUndefined();
    expect(JSON.stringify(money.answer)).not.toMatch(/no-line|unresolved|withheld/u);
  });

  it("the catalog holds the days and counts of the allowed population only", () => {
    const whole = factsIndex(FACTS);
    for (const [, lines, kept] of COUNTS) {
      const smaller = factsIndex(FACTS.filter((fact) => kept.includes(keyOfFact(fact))));
      expect(placed(counting(whole, {}, { access: lines }).answer)).toEqual(placed(counting(smaller, {}).answer));
    }
  });

  it("names every family in the catalog, and the first day each holds of the allowed population only", () => {
    const whole = indexOf(RECORDS);
    const firsts = (lines?: Access) => onCall(context(whole, lines === undefined ? {} : { access: lines }), (call) => whole.snapshot({}, (read) => read.facts((facts) => facts.families([ASK_PRODUCT], call.gate === undefined ? undefined : call))));
    expect(firsts(WORK_ONLY)).toEqual([{ family: "mail", first: "2026-11-13" }]);
    expect(firsts(MAIL_DAY)).toEqual([{ family: "mail", first: "2026-11-14" }]);
    expect(firsts(FULL)).toEqual(firsts());
    expect(firsts().map((each) => each.family)).toEqual(expect.arrayContaining(["mail", "messages", "money", "web"]));
  });

  it("answers INDEX_BUILDING while the facts layer, or where the person was, is owed", () => {
    const whole = factsIndex(FACTS);
    expect(refusal(() => counting(whole, { of: "messages", place: "Home" }, { access: DEFAULT }))).toBe("503 INDEX_BUILDING");
    expect(refusal(() => counting(whole, { of: "messages", by: "hour" }, { access: DEFAULT }))).toBe("503 INDEX_BUILDING");
    const owed = owedOf(RECORDS);
    expect(refusal(() => counting(owed, { of: "messages" }, { access: DEFAULT }))).toBe("503 INDEX_BUILDING");
  });
});

describe("a count with no gate, or a full one, costs main's statements", () => {
  it("prepares the same statements and reads the same rows under no access and a full one, and reads the all-time totals by their accounts under a gate", () => {
    const statements = (work: () => void): { sql: string[]; rows: number } => {
      const prepare = vi.spyOn(Database.prototype, "prepare");
      const before = rowsCounted();
      work();
      const sql = prepare.mock.calls.map(([text]) => text).filter((text) => !text.startsWith("EXPLAIN") && !text.includes("pragma_"));
      prepare.mockRestore();
      return { sql, rows: rowsCounted() - before };
    };
    const runs = [undefined, FULL].map((lines) => statements(() => {
      const whole = factsIndex(FACTS);
      for (const params of COUNT_ASKS) pages(whole, params, lines === undefined ? {} : { access: lines });
    }));
    expect(runs[1]).toEqual(runs[0]);
    const prepared = (sql: string) => /^SELECT\b.*\bn\b.*\bFROM (tally|day_total|totals)\b/su.test(sql.trim());
    expect(runs[0]!.sql.some(prepared)).toBe(true);
    const built = factsIndex(FACTS);
    const gated = statements(() => {
      for (const params of [...COUNT_ASKS, {}]) pages(built, params, { access: DEFAULT });
    });
    expect(gated.sql.some(prepared)).toBe(true);
    expect(gated.sql.filter((sql) => /\bFROM totals\b/u.test(sql))).toEqual(["SELECT combo, crew, accounts, n, first, last FROM totals WHERE of = ? LIMIT ?"]);
  });
});

const LOCATION_SRC = `${LOCATION}:iphone-aa01`;
const MOTION_SRC = `${MOTION}:iphone-aa01`;
const TIMELINE_SRC = `${TIMELINE}:cloud`;
const SOURCE_ROWS = [
  { id: LOCATION_SRC, product: "location", account: "local", copy: "iphone-aa01" },
  { id: MOTION_SRC, product: "motion", account: "local", copy: "iphone-aa01" },
  { id: TIMELINE_SRC, product: "google-timeline", account: "person-a@example.com", copy: "cloud" },
];
const PHYSICAL_ADAPTERS = [{ name: PHYSICAL, adapters: [{ product: "location", adapter: { fix: () => undefined } }, { product: "motion", adapter: { motion: () => undefined } }] }] as unknown as Pick<Family, "name" | "adapters">[];
const PHONE_RESTS_ON = restsOnIn(PHYSICAL_ADAPTERS, SOURCE_ROWS as unknown as SourceRow[]);

const SPOTS = { home: { latitude: 48.8566, longitude: 2.3522 }, office: { latitude: 48.8738, longitude: 2.295 }, cafe: { latitude: 48.8530, longitude: 2.3499 } };
const SPOT_LABELS = labelsFrom((unit) => {
  const content = buildLabels({ places: Object.entries(SPOTS).map(([slug, point]) => ({ slug, name: slug[0]!.toUpperCase() + slug.slice(1), ...point, radius_m: 100, also: [], ids: [] })) }).contents.get(unit);
  return content === undefined ? undefined : { content };
}, UTC);
const spot = (point: { latitude: number; longitude: number }, start_ms: number, end_ms: number, units: string[]): Piece => ({ kind: "stay", level: "place", how: "observed", point, from: null, to: null, units, start_ms, end_ms });
const BEFORE = spot(SPOTS.home, NOW - 30 * HOUR, NOW - 10 * HOUR, [`stay/${LOCATION_SRC}/${NOW - 30 * HOUR}`]);
const JOINED = spot(SPOTS.office, NOW - 10 * HOUR, NOW - 6 * HOUR, [`stay/${LOCATION_SRC}/${NOW - 10 * HOUR}`, `visit/${TIMELINE_SRC}/${NOW - 10 * HOUR}`]);
const SHAPED = spot(SPOTS.cafe, NOW - 6 * HOUR, NOW, [`stay/${LOCATION_SRC}/${NOW - 6 * HOUR}`]);

function presenceOfPieces(pieces: readonly Piece[]): PresenceSource {
  const file = join(scratch, `p${++seq}`, "places.db");
  mkdirSync(join(scratch, `p${seq}`), { recursive: true });
  writePresenceFile(file, presenceTablesOf(pieces, ["2026-11-13", "2026-11-14"], SPOT_LABELS, new Map(), UTC, NOW, PHONE_RESTS_ON));
  return presenceSource(file);
}

const PLACES_ALL = access({ allow: [allow({ type: "places", but: [] })] });
const LOCATION_ONLY = access({ allow: [allow(account(LOCATION))] });
const PHONE = access({ allow: [allow(account(LOCATION)), allow(account(MOTION))] });
const WITNESSES = access({ allow: [allow(account(LOCATION)), allow(account(MOTION)), allow(account(TIMELINE))] });
const PLACES_DAY = access({ allow: [allow({ type: "places", but: [] }, { past_ms: DAY })] });

describe("where the person was, piece by piece", () => {
  const presence = presenceOfPieces([BEFORE, JOINED, SHAPED]);
  const kept = (lines?: Access) => onCall(context(indexOf(RECORDS), { presence, ...(lines === undefined ? {} : { access: lines }) }), (call) => call.whereIfReady()!.pieces.map((piece) => [piece[0], piece[5]]));

  it("states on a phone's piece the account of Motion, which shaped it, and of every witness", () => {
    expect(kept()).toEqual(expect.arrayContaining([
      [BEFORE.start_ms, [LOCATION, MOTION]], [JOINED.start_ms, [TIMELINE, LOCATION, MOTION]], [SHAPED.start_ms, [LOCATION, MOTION]],
    ]));
  });

  it("serves a piece only when every account it was laid from is allowed at its start", () => {
    const whole = kept();
    const starts = (lines: Access) => kept(lines).map(([start]) => start);
    const where = (keep: (start: number, accounts: readonly string[]) => boolean) => whole.filter(([start, accounts]) => keep(start as number, accounts as string[])).map(([start]) => start);
    for (const lines of [PLACES_ALL, FULL, DEFAULT, WITNESSES]) expect(starts(lines)).toEqual(where(() => true));
    for (const lines of [LOCATION_ONLY, MAIL_DAY]) expect(starts(lines)).toEqual([]);
    expect(starts(PHONE)).toEqual(where((_start, accounts) => !accounts.includes(TIMELINE)));
    expect(starts(PHONE)).toEqual(expect.arrayContaining([BEFORE.start_ms, SHAPED.start_ms]));
    expect(starts(PHONE)).not.toContain(JOINED.start_ms);
    expect(starts(PLACES_DAY)).toEqual(where((start) => start >= NOW - DAY));
    expect(starts(PLACES_DAY)).not.toContain(BEFORE.start_ms);
    expect(starts(PLACES_DAY)).toEqual(expect.arrayContaining([JOINED.start_ms, SHAPED.start_ms]));
  });

  it("a hit's place, the place argument and a count's place read the served pieces only", () => {
    const at = (ms: number, key: string, account: string) => held(account, key, ms, `a parcel note ${key}`, "mail");
    const records = [at(NOW - 20 * HOUR, "e1", WORK), at(NOW - 8 * HOUR, "e2", WORK), at(NOW - 2 * HOUR, "e3", WORK)];
    const whole = indexOf(records, []);
    const was = (lines: Access) => Object.fromEntries(ask(whole, { lists: "record", query: "parcel" }, { presence, access: lines }).answer.record!.hits.map((hit) => [keyOf(hit.ref), hit.the_user_was_at ?? null]));
    const mail = (also: Access) => access({ allow: [allow({ type: "mail", but: [] }), ...also.allow] });
    expect(was(mail(PLACES_ALL))).toEqual({ e1: "Home", e2: "Office", e3: "Cafe" });
    expect(was(mail(PHONE))).toEqual({ e1: "Home", e2: null, e3: "Cafe" });
    expect(was(mail(PLACES_DAY))).toEqual({ e1: null, e2: "Office", e3: "Cafe" });
    expect(was(mail(LOCATION_ONLY))).toEqual({ e1: null, e2: null, e3: null });
    const placed = (lines: Access, place: string) => keysOf(ask(whole, { lists: "record", query: "parcel", place }, { presence, access: lines }).answer).sort();
    expect(placed(mail(PLACES_ALL), "Office")).toEqual(["e2"]);
    expect(placed(mail(PHONE), "Office")).toEqual([]);
    expect(placed(mail(PLACES_DAY), "Home")).toEqual([]);
    const facts = factsIndex([
      message("e1", NOW - 20 * HOUR, "gmail", "parcel", { account: WORK }), message("e2", NOW - 8 * HOUR, "gmail", "parcel", { account: WORK }),
      message("e3", NOW - 2 * HOUR, "gmail", "parcel", { account: WORK }),
    ]);
    const there = (lines: Access, place: string) => (counting(facts, { of: "messages", place }, { presence, access: lines }).answer as CountResult).total?.n;
    expect(there(mail(PLACES_ALL), "Office")).toBe(1);
    expect(there(mail(PHONE), "Office")).toBe(0);
    expect(there(mail(PLACES_DAY), "Home")).toBe(0);
    expect(there(mail(PLACES_DAY), "Cafe")).toBe(1);
  });
});

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
function personOf(id: string, name: string, handles: readonly string[]): PersonDetail {
  return {
    id, name, call_name: name.split(" ")[0]!, full_name: name, show: "full_name", by: "card", person: null, entity: "person", entity_by: "home", relationship: null, me: false,
    hidden: false, organised: false, card: true, photo: null, score: 1, networks: [], chats: [], received: 0, sent: 0, mails_from: 0, mails_to: 0, first_ms: null,
    last_ms: null, last_30: 0, days_count: 0, last_day: 0, days: {}, suggestions: [], names_seen: [], also_called: [], record: null,
    handles: handles.map((handle) => ({ id: handle, kind: handle.slice(0, handle.indexOf(":")), network: null, words: handle, from: null })),
  } as unknown as PersonDetail;
}
const searchedOf = (detail: PersonDetail): Searched => ({
  id: detail.id, words: [detail.name, ...detail.names_seen].flatMap((name) => fold(name).split(/[^\p{L}\p{N}]+/u)).filter(Boolean), values: detail.handles.map((handle) => fold(handle.id.slice(handle.id.indexOf(":") + 1))), phones: [],
});

const SAM = { id: "person:sam", name: "Sam Example", email: "email:sam@example.com", jid: "jid:15550000002@s.whatsapp.net" };
const KIM = { id: "person:kim", name: "Kim Example", jid: "jid:15550000003@s.whatsapp.net" };
const KIM_CHAT = "whatsapp:15550000003@s.whatsapp.net";
const said = (key: string, at_ms: number, product: string, chat: string, from: string, handle: string): DayFileFact => ({ ...message(key, at_ms, product, chat, { account: from }), who: [{ handle, role: "sender" }] });
const SAID: DayFileFact[] = [
  said("s1", NOW - 3 * HOUR, "gmail", "sam-thread", WORK, SAM.email),
  said("s2", NOW - 40 * HOUR, "gmail", "sam-thread", WORK, SAM.email),
  said("s3", NOW - 2 * HOUR, "whatsapp", SAM_CHAT, CHAT, SAM.jid),
  said("s4", NOW - 20 * HOUR, "whatsapp", SAM_CHAT, CHAT, SAM.jid),
  said("k1", NOW - 5 * HOUR, "whatsapp", KIM_CHAT, CHAT, KIM.jid),
];
const PERSONS = [personOf(SAM.id, SAM.name, [SAM.email, SAM.jid]), personOf(KIM.id, KIM.name, [KIM.jid])];
const CHATS: PeopleSearchChat[] = [{ key: SAM_CHAT, group: false, label: SAM.name }, { key: KIM_CHAT, group: false, label: KIM.name }];

function peopleTablesOf(persons: readonly PersonDetail[], chats: readonly PeopleSearchChat[]): Tables {
  return {
    names: { all: { people: persons.map(searchedOf) } },
    person: Object.fromEntries(persons.map((each) => [each.id, { person: each }])),
    alias: Object.fromEntries(persons.flatMap((each) => [[each.id, { id: each.id }], ...each.handles.map((handle) => [handle.id, { id: each.id }])])),
    answer: { list: { chats } },
  };
}

interface Home2 {
  facts: SearchIndex;
  tables: Tables;
}

function homeOf(facts: readonly DayFileFact[], handles: readonly string[] | null): Home2 {
  const persons = PERSONS.flatMap((each) => {
    const kept = each.handles.filter((handle) => handles === null || handles.includes(handle.id));
    return kept.length === 0 ? [] : [{ ...each, handles: kept }];
  });
  const chats = CHATS.filter((chat) => facts.some((fact) => fact.keys.chat === chat.key));
  return { facts: factsIndex(facts), tables: peopleTablesOf(persons, chats) };
}

const onPeople = (home: Home2, more: Partial<CallOf>): CallOf => ({
  ...context(home.facts, more), families: COUNTED, home: join(COUNT_HOME, "home.db"), fresh: () => undefined, peopleTables: home.tables, view: RECORD_VIEW,
});

function peopleSearch(home: Home2, params: Record<string, string>, more: Partial<CallOf> = {}): unknown {
  return onCall(onPeople(home, more), (call) => answerOf("/v1/people/search", 200, JSON.parse(JSON.stringify(peopleSearchAnswer(call, paramsOf(searchPeopleParams, new URLSearchParams(params)))))));
}

const MAIL_ONLY = access({ allow: [allow({ type: "mail", but: [] })] });
const MESSAGES_DAY = access({ allow: [allow({ type: "messages", but: [] }, { past_ms: DAY })] });

interface Kept {
  heads: Map<string, number>;
  photos?: Map<string, HeldPhoto>;
  documents?: Map<string, DayDocument>;
  chat?: { messages: MessageAt[] };
  screen?: ScreenSource;
  screenReady?: ScreenSource;
  fresh?: FreshSource[];
}

interface MessageAt {
  source: string;
  key: string;
  at: number;
}

const RECORD_VIEW = viewOf(new Map(RECORDS.map(({ entry }) => [entry.record.key, entry.start_ms!])));

function viewOf(heads: ReadonlyMap<string, number>): OpenView {
  return {
    head: (record: { key: string }) => {
      const start_ms = heads.get(record.key);
      return start_ms === undefined ? undefined : { version: `v-${record.key}`, start_ms, stated_ms: start_ms };
    },
    source: () => undefined, blobsOf: () => [], history: () => [{ version: `v-old`, stated_ms: NOW - 50 * HOUR }],
    extractPage: () => [], enrichment: () => undefined,
  } as unknown as OpenView;
}

function sourcesOf(call: Call, kept: Kept): ReadSources {
  const records = new Map(RECORDS.map(({ entry }) => [entry.record.key, entry]));
  return {
    call,
    recordOf: (record: { key: string }) => {
      const entry = records.get(record.key);
      return { family: entry?.family ?? "notes", read: entry === undefined || !kept.heads.has(record.key) ? null : { text: entry.text }, product: undefined, dated: entry?.dated === true };
    },
    aiChatOf: () => undefined, isAiChat: () => false, productName: (product: string) => product, name: (id: string) => id,
    photo: (hex: string) => kept.photos?.get(hex), dayDocument: (day: string) => kept.documents?.get(day), freshness: () => kept.fresh ?? [],
    chatKeys: () => [],
    chatDay: (_network: string, _chat: string, _keys: readonly string[], day: string) => {
      const messages = (kept.chat?.messages ?? []).filter((each) => civilDay(each.at, UTC) === day);
      return { title: "The group", messages, atoms: messages.map((each) => ({ start_ms: each.at, text: `Kim: hello ${each.key}`, record: { source: each.source, kind: "message", key: each.key } })) };
    },
    screen: () => kept.screen ?? (() => {
      throw new Error("this read opens no screen");
    })(),
    screenIfReady: () => kept.screenReady,
  } as unknown as ReadSources;
}

const readCall = (index: SearchIndex, kept: Kept, more: Partial<CallOf>): CallOf => ({
  ...context(index, more), families: COUNTED, home: join(COUNT_HOME, "home.db"), view: viewOf(kept.heads), fresh: () => ({ as_of: "2026-11-14T12:00+00:00", pending: [] }),
});

function reading(index: SearchIndex, kept: Kept, params: Record<string, string | string[]>, more: Partial<CallOf> = {}): unknown {
  return onCall(readCall(index, kept, more), (call) => {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) for (const each of [value].flat()) query.append(name, each);
    return answerOf("/v1/read", 200, JSON.parse(JSON.stringify(readAnswerOf(paramsOf(readParams, query), sourcesOf(call, kept)))));
  });
}

const reads = (work: () => unknown): unknown => {
  try {
    return work();
  } catch (error) {
    if (error instanceof Refusal) return `${error.status} ${error.code}`;
    throw error;
  }
};

const bare = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (name, each) => (["ref", "cites", "next", "as_of", "outside"].includes(name) ? undefined : each)));
const told = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (name, each) => (name === "outside" ? undefined : each)));

describe("people search and read under a gate", () => {
  it("an agent limited to Mail finds a person by name with their mail handle and counts only, and reads their WhatsApp chat as a chat the home does not hold", () => {
    const whole = homeOf(SAID, null);
    const found = peopleSearch(whole, { name: "Example" }, { access: MAIL_ONLY }) as SearchPeopleAnswer;
    expect(found.matches.map((match) => match.name)).toEqual([SAM.name]);
    const text = JSON.stringify(found);
    expect(text).not.toContain("whatsapp");
    expect(text).not.toContain(SAM.jid);
    expect(text).not.toContain("Kim");
    const page = reading(whole.facts, { heads: new Map() }, { ref: personRef({ id: SAM.id, handles: [SAM.email] }) }, onPeopleMore(whole, MAIL_ONLY));
    expect(JSON.stringify(page)).not.toMatch(/whatsapp|jid:/u);
    expect(reads(() => reading(whole.facts, { heads: new Map() }, { ref: makeRef("chat", { key: SAM_CHAT }) }, onPeopleMore(whole, MAIL_ONLY)))).toBe("403 OUTSIDE_ACCESS");
    expect(reads(() => reading(whole.facts, { heads: new Map() }, { chat: makeRef("chat", { key: SAM_CHAT }) }, onPeopleMore(whole, MAIL_ONLY)))).toBe("403 OUTSIDE_ACCESS");
    expect(reads(() => peopleSearch(whole, { id: makeRef("chat", { key: KIM_CHAT }) }, { access: MAIL_ONLY }))).toBe("403 OUTSIDE_ACCESS");
    const smaller = homeOf(SAID.filter((fact) => fact.keys.product === "gmail"), [SAM.email]);
    expect([found.outside, (page as { outside?: true }).outside]).toEqual([true, true]);
    expect(told(found)).toEqual(peopleSearch(smaller, { name: "Example" }));
    expect(told(page)).toEqual(reading(smaller.facts, { heads: new Map() }, { ref: personRef({ id: SAM.id, handles: [SAM.email] }) }, onPeopleMore(smaller)));
  });

  const ACCESSES: [string, Access, string[], string[] | null][] = [
    ["Full", FULL, SAID.map(keyOfFact), null],
    ["Everything but Health and Money (the default)", DEFAULT, SAID.map(keyOfFact), null],
    ["Mail · past 24 hours", MAIL_DAY, ["s1"], [SAM.email]],
  ];

  it.each(ACCESSES)("people search and a person's page under %s equal a home holding only the allowed facts", (_name, lines, keys, handles) => {
    const whole = homeOf(SAID, null);
    const smaller = homeOf(SAID.filter((fact) => keys.includes(keyOfFact(fact))), handles);
    for (const name of ["Example", "Sam", "Kim"]) expect({ name, ...told(peopleSearch(whole, { name }, { access: lines })) as object }).toEqual({ name, ...peopleSearch(smaller, { name }) as object });
    const ref = personRef({ id: SAM.id, handles: handles ?? [SAM.email, SAM.jid] });
    expect(told(reading(whole.facts, { heads: new Map() }, { ref }, onPeopleMore(whole, lines)))).toEqual(reading(smaller.facts, { heads: new Map() }, { ref }, onPeopleMore(smaller)));
  });

  const ALLOWED: [string, Access, string[]][] = SMALLER.map(([name, lines, keys]) => [name, lines, keys]);

  it.each(ALLOWED)("a record under %s: an allowed one as a smaller home reads it, a withheld one OUTSIDE_ACCESS, and gone among several", (_name, lines, keys) => {
    const whole = indexOf(RECORDS);
    const all = new Map(RECORDS.map(({ entry }) => [entry.record.key, entry.start_ms!]));
    const smaller = new Map([...all].filter(([key]) => keys.includes(key)));
    for (const { entry } of RECORDS) {
      const ref = makeRef("record", entry.record);
      const gated = reads(() => reading(whole, { heads: all }, { ref }, { access: lines }));
      if (keys.includes(entry.record.key)) expect({ ref, gated }).toEqual({ ref, gated: reading(whole, { heads: smaller }, { ref }) });
      else expect({ ref, gated }).toEqual({ ref, gated: "403 OUTSIDE_ACCESS" });
    }
    const pair = [makeRef("record", RECORDS[0]!.entry.record), makeRef("record", RECORDS[6]!.entry.record)];
    const both = reading(whole, { heads: all }, { ref: pair }, { access: lines }) as { opened: { what: string; why?: string }[] };
    const withheld = !keys.includes(RECORDS[6]!.entry.record.key);
    expect(both.opened.map((each) => [each.what, each.why ?? null])).toEqual([["record", null], withheld ? ["gone", "Outside your access."] : ["record", null]]);
  });

  it("gives older versions only under a full access", () => {
    const whole = indexOf(RECORDS);
    const all = new Map(RECORDS.map(({ entry }) => [entry.record.key, entry.start_ms!]));
    const ref = makeRef("record", RECORDS[0]!.entry.record);
    const plain = reading(whole, { heads: all }, { ref, history: "1" });
    expect(reading(whole, { heads: all }, { ref, history: "1" }, { access: FULL })).toEqual(plain);
    expect(reading(whole, { heads: all }, { ref, history: "1" }, { access: DEFAULT })).toEqual(reading(whole, { heads: all }, { ref }));
    expect(reading(whole, { heads: all }, { ref, history: "1" }, { access: DEFAULT })).not.toEqual(plain);
  });

  it("a chat holds its allowed messages as a smaller home's does, one with none is outside the access, and an unknown key is a bad parameter", () => {
    const facts = [message("g1", NOW - HOUR, "whatsapp", GROUP, { account: CHAT }), message("g2", NOW - 30 * HOUR, "whatsapp", GROUP, { account: CHAT })];
    const messages = facts.map((fact) => ({ source: `${CHAT}:phone-7669`, key: keyOfFact(fact), at: fact.start_ms }));
    const whole = factsIndex(facts);
    const chat = { chat: makeRef("chat", { key: GROUP }) };
    const plain = reading(whole, { heads: new Map(), chat: { messages } }, chat);
    for (const lines of [FULL, DEFAULT]) expect(reading(whole, { heads: new Map(), chat: { messages } }, chat, { access: lines })).toEqual(plain);
    const smaller = reading(factsIndex([facts[0]!]), { heads: new Map(), chat: { messages: [messages[0]!] } }, chat);
    const cut = reading(whole, { heads: new Map(), chat: { messages } }, chat, { access: MESSAGES_DAY }) as { outside?: true };
    expect([cut.outside, told(cut)]).toEqual([true, smaller]);
    expect(JSON.stringify(smaller)).toContain("hello g1");
    expect(JSON.stringify(smaller)).not.toContain("hello g2");
    expect(reads(() => reading(whole, { heads: new Map(), chat: { messages } }, chat, { access: MAIL_DAY }))).toBe("403 OUTSIDE_ACCESS");
    expect(reads(() => reading(whole, { heads: new Map(), chat: { messages } }, { chat: makeRef("chat", { key: "whatsapp:120363000000000009@g.us" }) }, { access: MAIL_DAY }))).toBe("422 BAD_PARAMETER");
  });

  it.each(SMALLER)("a stretch and its brief under %s hold the allowed lines, as a smaller home's do", (_name, lines, keys, kept) => {
    const whole = indexOf(RECORDS);
    const allowed = RECORDS.filter((each) => keys.includes(each.entry.record.key));
    const smaller = indexOf(allowed, kept);
    const all = new Map(RECORDS.map(({ entry }) => [entry.record.key, entry.start_ms!]));
    const stretch = { from: "2026-11-14", to: "2026-11-14" };
    expect(bare(reading(whole, { heads: all }, stretch, { access: lines }))).toEqual(bare(reading(smaller, { heads: all }, stretch)));
    const documents = (records: readonly Held[], loose: readonly AtomEntry[]) => new Map([["2026-11-14", documentOf("2026-11-14", records, loose)]]);
    const brief = { ...stretch, detail: "brief" };
    const gated = bare(reading(whole, { heads: all, documents: documents(RECORDS, LINES) }, brief, { access: lines }));
    expect(gated).toEqual(bare(reading(smaller, { heads: all, documents: documents(allowed, kept) }, brief)));
  });

  it("a brief of part of a day judges time before access: a withheld record outside the stretch never says outside, one inside it does", () => {
    const whole = indexOf(RECORDS);
    const all = new Map(RECORDS.map(({ entry }) => [entry.record.key, entry.start_ms!]));
    const documents = new Map([["2026-11-14", documentOf("2026-11-14", RECORDS, LINES)]]);
    const part = (from_ms: number, to_ms: number) => reading(whole, { heads: all, documents }, {
      from: new Date(from_ms).toISOString(), to: new Date(to_ms).toISOString(), detail: "brief",
    }, { access: MAIL_ONLY }) as { days: { lines: { text: string }[] }[]; outside?: true };
    const quiet = part(NOW - 5.5 * HOUR, NOW - 4.5 * HOUR);
    expect([quiet.days.flatMap((day) => day.lines.map((line) => line.text)), quiet.outside]).toEqual([["lunch on friday"], undefined]);
    const hiding = part(NOW - 6.5 * HOUR, NOW - 4.5 * HOUR);
    expect([hiding.days.flatMap((day) => day.lines.map((line) => line.text)), hiding.outside]).toEqual([["lunch on friday"], true]);
  });

  it("a `last` read's freshness leaves out a source outside the agent's access, says none for an item before its access starts, and never says outside", () => {
    const fresh = (id: string, name: string, family: string, synced_ms: number, item_ms: number): FreshSource => ({
      id, product: id.split(":")[0]!, name, device: null, families: [family], road: "poll", heard_ms: synced_ms, synced_ms, item_ms, item_dated: false,
    });
    const kept: Kept = { heads: new Map(), fresh: [fresh(`${WORK}:cloud`, "Gmail, person-a@example.com", "mail", NOW - HOUR, NOW - 30 * HOUR), fresh(`${CHAT}:phone-0001`, "WhatsApp, Phone", "messages", NOW - 2 * HOUR, NOW - HOUR)] };
    const last = (more: Partial<CallOf> = {}) => reading(indexOf(RECORDS), kept, { last: "3h" }, more) as { freshness?: string; outside?: true };
    expect(last()).toMatchObject({ freshness: "Not synced in the last 15 min: WhatsApp, Phone (last synced 10:00, last item 11:00); Gmail, person-a@example.com (last synced 11:00, last item 2026-11-13 06:00)." });
    const gated = last({ access: MAIL_DAY });
    expect(gated.freshness).toBe("Not synced in the last 15 min: Gmail, person-a@example.com (last synced 11:00, last item none).");
    expect(gated.outside).toBeUndefined();
  });

  it("a `last` read's freshness never shows an upload for an item the agent may not see", () => {
    const upload: FreshSource = { id: `${WORK}:upload`, product: "gmail", name: "Mail export", device: null, families: ["mail"], road: "upload", heard_ms: NOW - 2 * HOUR, synced_ms: NOW - 2 * HOUR, item_ms: NOW - 2 * HOUR, item_dated: false };
    const last = (more: Partial<CallOf> = {}) => reading(indexOf(RECORDS), { heads: new Map(), fresh: [upload] }, { last: "3h" }, more) as { freshness?: string };
    expect(last().freshness).toContain("Mail export");
    expect(last({ access: access({ allow: [allow({ type: "mail", but: [] }, { past_ms: HOUR })] }) }).freshness).toBeUndefined();
  });

  it("a picture is read when its record is allowed", () => {
    const whole = indexOf(RECORDS);
    const hash = "c".repeat(64);
    const photos = new Map([[hash, photoOf(hash, [CHAT], NOW - HOUR)]]);
    const ref = makeRef("picture", { image: `sha256:${hash}` });
    const plain = reading(whole, { heads: new Map(), photos }, { ref });
    for (const lines of [FULL, DEFAULT]) expect(reading(whole, { heads: new Map(), photos }, { ref }, { access: lines })).toEqual(plain);
    expect(reads(() => reading(whole, { heads: new Map(), photos }, { ref }, { access: MAIL_DAY }))).toBe("403 OUTSIDE_ACCESS");
    const pair = reading(whole, { heads: new Map(RECORDS.map(({ entry }) => [entry.record.key, entry.start_ms!])), photos }, { ref: [makeRef("record", RECORDS[0]!.entry.record), ref] }, { access: MAIL_DAY });
    expect((pair as { opened: { what: string }[] }).opened.map((each) => each.what)).toEqual(["record", "gone"]);
  });

  it("a record read under a gate needs nothing of a facts layer that is being made again; a stretch's lines wait for it", () => {
    const owed = owedOf(RECORDS);
    const all = new Map(RECORDS.map(({ entry }) => [entry.record.key, entry.start_ms!]));
    const ref = makeRef("record", RECORDS[0]!.entry.record);
    expect(reading(owed, { heads: all }, { ref }, { access: MAIL_DAY })).toEqual(reading(indexOf(RECORDS), { heads: all }, { ref }, { access: MAIL_DAY }));
    expect(reads(() => reading(owed, { heads: all }, { from: "2026-11-14", to: "2026-11-14" }, { access: MAIL_DAY }))).toBe("503 INDEX_BUILDING");
  });

  it("a picture is described as it is read: a withheld one is gone, outside the access", () => {
    const hash = "c".repeat(64);
    const kept: Kept = { heads: new Map(), photos: new Map([[hash, photoOf(hash, [CHAT], NOW - HOUR)]]) };
    const ref = makeRef("picture", { image: `sha256:${hash}` });
    const described = (lines?: Access) => onCall(readCall(indexOf(RECORDS), kept, lines === undefined ? {} : { access: lines }), (call) => describedOf({ ref }, sourcesOf(call, kept)).described[0]);
    expect(described(DEFAULT)).toEqual(described());
    expect(described(MAIL_DAY)).toEqual({ ref, kind: "gone", why: "Outside your access." });
  });

  it("a screen window is read when its Mac's screen source is allowed at its minute", () => {
    const whole = indexOf(RECORDS);
    const lines = (at_ms: number) => [{ t_ms: at_ms, text: "the invoice for the studio" }, { t_ms: at_ms + MINUTE, text: "the total at the foot" }];
    const windowAt = (at_ms: number): ScreenSource => ({
      file: "screen-1", clock: UTC, as_of: null, stretchLines: () => [], sources: { of: () => [SCREEN_SRC], machines: () => [MACHINE] },
      segments: () => [at_ms], windowsIn: () => [],
      windowRead: (_window: unknown, from: number, to: number, near: readonly number[]) => ({
        near: lines(at_ms).filter((line) => near.includes(line.t_ms)), all: () => lines(at_ms).filter((line) => line.t_ms >= from && line.t_ms < to),
      }),
      windowNear: () => ({ at: [at_ms, at_ms + MINUTE], whole: true, lines: lines(at_ms) }),
    });
    const ref = (at_ms: number) => makeRef("window", { machine: MACHINE, day: civilDay(at_ms, UTC), app: "Safari", site: "", name: "Billing", at_ms });
    const read = (at_ms: number, lines?: Access) => reads(() => reading(whole, { heads: new Map(), screen: windowAt(at_ms) }, { ref: ref(at_ms) }, { screenAccounts: new Map([[MACHINE, [SCREEN]]]), ...(lines === undefined ? {} : { access: lines }) }));
    const recent = NOW - 2 * HOUR, older = NOW - 30 * HOUR;
    const screenDay = access({ allow: [allow(account(SCREEN), { past_ms: DAY })] });
    for (const lines of [FULL, DEFAULT, screenDay]) expect(read(recent, lines)).toEqual(read(recent));
    expect(read(older, DEFAULT)).toEqual(read(older));
    expect(read(older, screenDay)).toBe("403 OUTSIDE_ACCESS");
    expect(read(recent, MAIL_DAY)).toBe("403 OUTSIDE_ACCESS");
  });

  it("a window line of the screen not summarised yet shows only where its Mac's screen source is allowed at its minute, the rest counted outside", () => {
    const recent = NOW - 2 * HOUR, older = NOW - 30 * HOUR;
    const shownAt = (start_ms: number): ScreenWindow => ({ machine: MACHINE, day: civilDay(start_ms, UTC), app: "Safari", site: "", name: "Billing", start_ms, end_ms: start_ms + 10 * MINUTE, tenths: 6_000 });
    const screenReady = {
      file: "screen-1", clock: UTC, as_of: null, stretchLines: () => [], sources: { of: () => [SCREEN_SRC], machines: () => [MACHINE] }, segments: () => [],
      windowsIn: (_machine: string, from_ms: number, to_ms: number) => [older, recent].map(shownAt).filter((each) => each.end_ms >= from_ms && each.start_ms < to_ms),
      windowRead: () => ({ near: [], all: () => [] }), windowNear: () => null,
    } as unknown as ScreenSource;
    const asked = { from: civilDay(older, UTC), to: civilDay(recent, UTC), detail: "brief" };
    const brief = (lines?: Access) => reading(indexOf(RECORDS), { heads: new Map(), screenReady }, asked, { screenAccounts: new Map([[MACHINE, [SCREEN]]]), ...(lines === undefined ? {} : { access: lines }) }) as {
      days: { lines: { text: string }[] }[]; outside?: true;
    };
    const texts = (answer: ReturnType<typeof brief>) => answer.days.flatMap((day) => day.lines.map((line) => line.text));
    expect(texts(brief())).toEqual([expect.stringContaining("Safari, Billing, 10 min on screen"), expect.stringContaining("Safari, Billing, 10 min on screen")]);
    const screenDay = access({ allow: [allow(account(SCREEN), { past_ms: DAY })] });
    expect(texts(brief(screenDay))).toEqual([`${new Date(recent).toISOString().slice(11, 16)}–${new Date(recent + 10 * MINUTE).toISOString().slice(11, 16)}, not summarised yet: Safari, Billing, 10 min on screen`]);
    expect(brief(screenDay).outside).toBe(true);
    expect(brief(MAIL_DAY)).toMatchObject({ days: [{ lines: [] }, { lines: [] }], outside: true });
  });
});

function onPeopleMore(home: Home2, lines?: Access): Partial<CallOf> {
  return { peopleTables: home.tables, ...(lines === undefined ? {} : { access: lines }) };
}

function documentOf(day: string, records: readonly Held[], loose: readonly AtomEntry[]): DayDocument {
  const atoms = [
    ...records.filter(({ entry }) => civilDay(entry.start_ms!, UTC) === day).map(({ entry, accounts }, n) => ({
      n: n + 1, family: entry.family, unit: `${entry.family}:${entry.record.key}`, units: [`${entry.family}:${entry.record.key}`], record: entry.record,
      start_ms: entry.start_ms, end_ms: null, text: entry.text, local_start: null, local_end: null, flags: [], ...(accounts === undefined ? {} : { accounts }),
    })),
    ...loose.filter((line) => civilDay(line.start_ms!, UTC) === day).map((line) => ({
      n: line.n, family: line.family, unit: line.unit, units: [line.unit], start_ms: line.start_ms, end_ms: null, text: line.text, local_start: null, local_end: null, flags: [],
      ...(line.accounts === undefined ? {} : { accounts: line.accounts }),
    })),
  ];
  return { day, zone: "UTC", day_start_hour: 0, inputs: `in-${day}`, facts: [], atoms } as unknown as DayDocument;
}

function photoOf(hash: string, accounts: string[], at_ms: number): HeldPhoto {
  const photo = {
    hash, kind: "photo", play: null, at_ms, zone: "UTC", date: civilDay(at_ms, UTC), day: civilDay(at_ms, UTC), unit: null, focus: null, caption: "a cake", described: null, people: [], size: null,
    place: null, area: null, camera: null, from: null, chat: null,
  } as unknown as Photo;
  return { photo, accounts };
}

const PHOTOS = "photos:local";
const PHOTOS_ONLY = access({ allow: [allow(account(PHOTOS))] });
const PHOTOS_CHAT = access({ allow: [allow(account(PHOTOS)), allow(account(CHAT))] });
const PHOTOS_PHONE = access({ allow: [allow(account(PHOTOS)), allow(account(LOCATION)), allow(account(MOTION))] });
const STRANGER = "jid:15550000009@s.whatsapp.net";

const spelledOut = (value: unknown): string => {
  const strings: string[] = [];
  JSON.stringify(value, (_name, each) => {
    if (typeof each === "string") strings.push(/^[a-z]+\.[A-Za-z0-9_-]+$/u.test(each) ? Buffer.from(each.slice(each.indexOf(".") + 1), "base64url").toString("utf8") : each);
    return each;
  });
  return strings.join("\n");
};

describe("a person as served", () => {
  const whole = homeOf(SAID, null);
  const onSam = (more: Partial<CallOf>): Partial<CallOf> => ({ families: COUNTED, peopleTables: whole.tables, home: join(COUNT_HOME, "home.db"), fresh: () => undefined, ...more });

  it("an agent allowed only Mail sees no WhatsApp handle of a person in search, count or people search", () => {
    const searched = ask(whole.facts, { lists: "record", query: "anything", person: "Sam Example" }, onSam({ access: MAIL_ONLY })).answer;
    expect(searched.person).toEqual([{ asked: "Sam Example", ref: personRef({ id: SAM.id, handles: [SAM.email] }), name: SAM.name }]);
    const byRef = counting(whole.facts, { of: "messages", person: personRef({ id: SAM.id, handles: [SAM.email] }) }, onSam({ access: MAIL_ONLY })).answer;
    const byPerson = counting(whole.facts, { of: "messages", by: "person" }, onSam({ access: MAIL_ONLY })).answer;
    const found = peopleSearch(whole, { name: "Sam" }, { access: MAIL_ONLY });
    for (const answer of [searched, byRef, byPerson, found]) {
      expect(spelledOut(answer)).not.toContain("15550000002");
      expect(spelledOut(answer)).not.toContain("whatsapp");
    }
    expect(spelledOut(byPerson)).toContain(SAM.email.slice("email:".length));
  });

  it("a person named by a handle no allowed fact holds is answered as an unknown handle is", () => {
    const asUnknown = (typed: string) => ({
      search: ask(whole.facts, { lists: "record", query: "anything", person: typed }, onSam({ access: MAIL_ONLY })).answer.person,
      read: told(reads(() => reading(whole.facts, { heads: new Map() }, { ref: makeRef("person", { handle: typed }) }, onPeopleMore(whole, MAIL_ONLY)))),
      people: reads(() => peopleSearch(whole, { id: makeRef("person", { handle: typed }) }, { access: MAIL_ONLY })),
    });
    const sam = asUnknown(SAM.jid), stranger = asUnknown(STRANGER);
    expect(sam.search).toEqual([{ asked: SAM.jid, name: SAM.jid }]);
    expect(stranger.search).toEqual([{ asked: STRANGER, name: STRANGER }]);
    expect(sam.people).toBe("422 BAD_PARAMETER");
    expect(stranger.people).toBe("422 BAD_PARAMETER");
    const { ref: _sam, ...samRead } = sam.read as { ref: string };
    const { ref: _stranger, ...strangerRead } = stranger.read as { ref: string };
    expect(samRead).toEqual(strangerRead);
    expect(reads(() => counting(whole.facts, { of: "messages", person: "Kim Example" }, onSam({ access: MAIL_ONLY })))).toBe("404 PERSON_UNKNOWN");
    expect(peopleSearch(whole, { id: personRef({ id: SAM.id, handles: [SAM.email] }) }, { access: MAIL_ONLY })).toMatchObject({ matches: [{ name: SAM.name, handles: [SAM.email.slice("email:".length)] }] });
  });

  it("matches and names a person only by what an allowed fact holds: a Mail-only agent typing their WhatsApp number, or a name only WhatsApp saw, finds no one", () => {
    const seen = homeOf(SAID, null);
    seen.tables = peopleTablesOf([{ ...PERSONS[0]!, names_seen: ["Sammy Wa"] } as PersonDetail, PERSONS[1]!], CHATS);
    const names = (params: Record<string, string>, lines?: Access) => (peopleSearch(seen, params, lines === undefined ? {} : { access: lines }) as SearchPeopleAnswer).matches.map((match) => [match.name, ...match.also ?? []]);
    expect(names({ name: "15550000002" })).toEqual([[SAM.name, "Sam", "Sammy Wa"]]);
    expect(names({ name: "Sammy" })).toEqual([[SAM.name, "Sam", "Sammy Wa"]]);
    expect(names({ name: "15550000002" }, MAIL_ONLY)).toEqual([]);
    expect(names({ name: "Sammy" }, MAIL_ONLY)).toEqual([]);
    expect(names({ name: "Sam" }, MAIL_ONLY)).toEqual([[SAM.name, "Sam"]]);
    expect(names({ name: "sam@example" }, MAIL_ONLY)).toEqual([[SAM.name, "Sam"]]);
    const onSeen = (lines?: Access): Partial<CallOf> => ({ families: COUNTED, peopleTables: seen.tables, home: join(COUNT_HOME, "home.db"), fresh: () => undefined, ...(lines === undefined ? {} : { access: lines }) });
    expect(counting(seen.facts, { of: "messages", person: "Sammy Wa" }, onSeen()).answer).toMatchObject({ matched: { person: { "Sammy Wa": [SAM.name] } } });
    expect(reads(() => counting(seen.facts, { of: "messages", person: "Sammy Wa" }, onSeen(MAIL_ONLY)))).toBe("404 PERSON_UNKNOWN");
    expect(reads(() => ask(seen.facts, { lists: "record", query: "anything", person: "Sammy Wa" }, onSeen(MAIL_ONLY)))).toBe("404 PERSON_UNKNOWN");
    expect(spelledOut(peopleSearch(seen, { name: "Sam" }, { access: MAIL_ONLY }))).not.toContain("Sammy");
  });

  it("a one-to-one chat whose key is also a person's handle is judged as a chat: withheld, it is outside the access", () => {
    const LEE = { id: "person:lee", name: "Lee Example", email: "email:lee@example.com", net: "net-a:4444" };
    const facts = [said("l1", NOW - 3 * HOUR, "gmail", "lee-thread", WORK, LEE.email), said("l2", NOW - 2 * HOUR, "net-a", LEE.net, CHAT, LEE.net)];
    const lee: Home2 = { facts: factsIndex(facts), tables: peopleTablesOf([personOf(LEE.id, LEE.name, [LEE.email, LEE.net])], [{ key: LEE.net, group: false, label: LEE.name }]) };
    const typed = (key: string, lines: Access) => ({
      people: refusal(() => peopleSearch(lee, { id: makeRef("chat", { key }) }, { access: lines }), true),
      read: refusal(() => reading(lee.facts, { heads: new Map() }, { ref: makeRef("chat", { key }) }, onPeopleMore(lee, lines)), true),
      chat: refusal(() => reading(lee.facts, { heads: new Map() }, { chat: makeRef("chat", { key }) }, onPeopleMore(lee, lines)), true),
    });
    const outside = `403 OUTSIDE_ACCESS ${OUTSIDE_WORDS}`;
    expect(typed(LEE.net, MAIL_ONLY)).toEqual({ people: outside, read: outside, chat: outside });
    expect(typed(LEE.net, DEFAULT)).toEqual({ people: "answered", read: "answered", chat: "answered" });
    expect(spelledOut(peopleSearch(lee, { id: makeRef("chat", { key: LEE.net }) }))).toContain(LEE.name);
    expect(peopleSearch(lee, { id: personRef({ id: LEE.id, handles: [LEE.email] }) }, { access: MAIL_ONLY })).toMatchObject({ matches: [{ name: LEE.name, handles: ["lee@example.com"] }] });
  });

  it("a person asked for when the budget ran out answers as a chat does: too broad, in the meter's words, never no such person", () => {
    const people = new Set<string>();
    const counts = new Set<string>();
    for (let budget = 1; budget <= 400; budget++) {
      people.add(refusal(() => peopleSearch(whole, { id: personRef({ id: SAM.id, handles: [SAM.email] }) }, { access: MAIL_ONLY, budget }), true));
      people.add(refusal(() => peopleSearch(whole, { id: makeRef("chat", { key: SAM_CHAT }) }, { access: DEFAULT, budget }), true));
      counts.add(refusal(() => counting(whole.facts, { of: "messages", person: "Sam Example" }, onSam({ access: MAIL_ONLY, budget }))));
      counts.add(refusal(() => counting(whole.facts, { of: "messages", person: SAM.email }, onSam({ access: MAIL_ONLY, budget }))));
    }
    expect([...people].sort()).toEqual([`422 TOO_BROAD ${READ_TOO_BROAD}`, "answered"]);
    expect([...counts].sort()).toEqual(["422 TOO_BROAD", "answered"]);
  });

  it("people counts under a gate read the kept totals by their accounts, and walk no person's facts from the start of time", () => {
    const walked = vi.spyOn(Fetch.prototype, "facts");
    try {
      for (const lines of [FULL, DEFAULT, MAIL_ONLY, MAIL_DAY]) peopleSearch(whole, { name: "Example" }, { access: lines });
      expect(walked).not.toHaveBeenCalled();
    } finally {
      walked.mockRestore();
    }
  });

  it("at every budget, people search serves only who an allowed fact proves involved, and says so when it ran out", () => {
    const unlimited = peopleSearch(whole, { name: "Example" }, { access: MAIL_ONLY }) as SearchPeopleAnswer;
    const states = new Set<string>();
    for (let budget = 1; budget <= 400; budget++) {
      const answered = reads(() => peopleSearch(whole, { name: "Example" }, { access: MAIL_ONLY, budget }));
      if (typeof answered === "string") {
        states.add(answered);
        continue;
      }
      const answer = answered as SearchPeopleAnswer;
      expect(spelledOut(answer)).not.toContain("15550000002");
      expect(spelledOut(answer)).not.toContain("15550000003");
      for (const match of answer.matches) expect(unlimited.matches).toContainEqual(match);
      states.add(answer.capped === true ? "capped" : "whole");
    }
    expect([...states].filter((state) => state !== "422 TOO_BROAD").sort()).toEqual(["capped", "whole"]);
  });
});

describe("a picture's page under a gate", () => {
  const hash = "e".repeat(64);
  const at_ms = NOW - 3 * HOUR;
  const sent = { network: "whatsapp", chat: SAM_CHAT, title: "The group", group: true, sender: { id: SAM.jid, name: SAM.name }, mine: false, at_ms, day: civilDay(at_ms, UTC), record: { source: `${CHAT}:phone-7669`, kind: "msg", key: "p1" }, focus: `rec:${CHAT}:phone-7669 msg p1` };
  const photo = photoOf(hash, [PHOTOS], at_ms);
  const photos = new Map<string, HeldPhoto>([[hash, { ...photo, photo: { ...photo.photo, chat: sent, focus: sent.focus } }]]);
  const gps = new Map<string, HeldPhoto>([[hash, { ...photo, photo: { ...photo.photo, area: { city: "Synthetic City", region: null, country: "France" } } }]]);
  const ref = makeRef("picture", { image: `sha256:${hash}` });
  const presence = presenceOfPieces([BEFORE, JOINED, SHAPED]);
  const page = (lines: Access, held = photos) => reading(indexOf(RECORDS), { heads: new Map(), photos: held }, { ref }, { presence, category: (id) => (id === PHOTOS ? "photos" : category(id)), access: lines }) as { facts: string[]; the_user_was_at?: string };

  it("says it was sent in a chat only when the chat's message is allowed", () => {
    expect(page(PHOTOS_CHAT).facts).toContain(`sent in The group by ${SAM.name}`);
    expect(page(PHOTOS_ONLY).facts.join(" ")).not.toContain("sent in");
  });

  it("says where the user was from presence as served: absent when the stay is withheld", () => {
    expect(page(PHOTOS_PHONE).the_user_was_at).toBe("Cafe");
    expect(page(PHOTOS_ONLY).the_user_was_at).toBeUndefined();
  });

  it("says where the user was from presence as served, else the city of the photo's own GPS: with Location withheld, and for any reader while presence is not ready", () => {
    expect(page(PHOTOS_PHONE, gps).the_user_was_at).toBe("Cafe");
    expect(page(PHOTOS_ONLY, gps).the_user_was_at).toBe("Synthetic City");
    expect((reading(indexOf(RECORDS), { heads: new Map(), photos: gps }, { ref }) as { the_user_was_at?: string }).the_user_was_at).toBe("Synthetic City");
  });
});

describe("a line's stated accounts", () => {
  it("a line stated with no accounts is unresolved, as a line no row states is", () => {
    expect([lineAccountsOf("", `${CHAT}:phone-7669`), lineAccountsOf(undefined, null), lineAccountsOf(`${WORK}\x1e${HOME}`, null)]).toEqual([null, null, [WORK, HOME]]);
  });
});

describe("under the test walks, the out face judges every ref once more", () => {
  const guarded = (call: Call, kept: Kept, ref: string): string => {
    try {
      call.guard(refsLeaving({ what: "refs", opened: [{ lines: [{ text: "a line", cites: [ref] }] }] }), servedRefOf(sourcesOf(call, kept)));
      return "passed";
    } catch (error) {
      return (error as Error).message.replace(ref, "it");
    }
  };
  const stops = "a withheld ref left the engine: it";

  it("a record, window, line or picture ref the gate withholds stops the answer; an allowed one, or any under no gate, passes", () => {
    const heads = new Map(RECORDS.map(({ entry }) => [entry.record.key, entry.start_ms!]));
    const hash = "c".repeat(64);
    const kept: Kept = { heads, photos: new Map([[hash, photoOf(hash, [CHAT], NOW - HOUR)]]) };
    const stretch = reading(indexOf(RECORDS), { heads }, { from: "2026-11-14", to: "2026-11-14" }) as { lines: { ref?: string; text: string }[] };
    const lineOf = (words: string) => stretch.lines.find((line) => line.text.includes(words))!.ref!;
    const refs = {
      mail: makeRef("record", RECORDS[0]!.entry.record),
      chat: makeRef("record", RECORDS[6]!.entry.record),
      window: makeRef("window", { machine: MACHINE, day: "2026-11-14", app: "Safari", site: "", name: "Billing", at_ms: NOW - HOUR }),
      slept: lineOf("slept"),
      both: lineOf("both mailboxes"),
      picture: makeRef("picture", { image: `sha256:${hash}` }),
    };
    const on = (ref: string, lines?: Access) => onCall({ ...readCall(indexOf(RECORDS), kept, lines === undefined ? {} : { access: lines }), screenAccounts: new Map([[MACHINE, [SCREEN]]]) }, (call) => guarded(call, kept, ref));
    expect(on(refs.mail, MAIL_DAY)).toBe("passed");
    expect(on(refs.chat, MAIL_DAY)).toBe(stops);
    expect(on(refs.window, MAIL_DAY)).toBe(stops);
    expect(on(refs.window, DEFAULT)).toBe("passed");
    expect(on(refs.slept, DEFAULT)).toBe(stops);
    expect(on(refs.slept, FULL)).toBe("passed");
    expect(on(refs.both, WORK_ONLY)).toBe(stops);
    expect(on(refs.both, BOTH_MAIL)).toBe("passed");
    expect(on(refs.picture, MAIL_DAY)).toBe(stops);
    expect(on(refs.picture, DEFAULT)).toBe("passed");
    for (const ref of Object.values(refs)) expect(on(ref)).toBe("passed");
  });

  it("a person, chat or place ref is judged as its read judges it", () => {
    const whole = homeOf(SAID, null);
    const kept: Kept = { heads: new Map() };
    const people = (ref: string, lines?: Access) => onCall(readCall(whole.facts, kept, onPeopleMore(whole, lines)), (call) => guarded(call, kept, ref));
    expect(people(personRef({ id: SAM.id, handles: [SAM.jid] }), MAIL_ONLY)).toBe(stops);
    expect(people(personRef({ id: SAM.id, handles: [SAM.email] }), MAIL_ONLY)).toBe("passed");
    expect(people(makeRef("chat", { key: SAM_CHAT }), MAIL_ONLY)).toBe(stops);
    expect(people(makeRef("chat", { key: SAM_CHAT }), DEFAULT)).toBe("passed");
    const presence = presenceOfPieces([BEFORE, JOINED, SHAPED]);
    const visit = { unit: "stay/office", start_ms: JOINED.start_ms, end_ms: JOINED.end_ms, day: "2026-11-14", people: [], centre: SPOTS.office };
    const placesTables: Tables = { place: { office: { place: { slug: "office", name: "Office", ...SPOTS.office, radius_m: 100, visits: [visit] } } } };
    const place = (lines?: Access) => onCall(readCall(indexOf(RECORDS), kept, { presence, placesTables, ...(lines === undefined ? {} : { access: lines }) }), (call) => guarded(call, kept, makeRef("place", { id: "office" })));
    expect(place(PHONE)).toBe(stops);
    expect(place(WITNESSES)).toBe("passed");
    expect(place()).toBe("passed");
  });
});
