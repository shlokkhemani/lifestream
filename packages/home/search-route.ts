import { addDays, civilDay, dayBounds, type DaySettings, type RecordRef } from "@lifestreamprotocol/core";
import { readRouteId } from "@lifestreamprotocol/model";
import { earliest, opensAt } from "@lifestreamprotocol/privacy";
import { handleOfId } from "@lifestreamprotocol/families";
import { ASK_PRODUCT, type PeopleMap } from "./counting.js";
import { argumentsWritten, aroundBytes, CursorError, CursorWriter, GIVEN_MOST, NEXT_BYTES, opened, resolvedOf, sealed, type Bound, type CursorReader, type Opened, type Params } from "./cursor-text.js";
import { timeParameter } from "./home-clock.js";
import { freshMembers, OPEN_FROM, type ScreenRead } from "./index-file.js";
import type { Call } from "./call.js";
import { busy } from "./screen-index.js";
import { areasKept, at, placesKept, placeStretches, placeTermsOf, wasAt, type Presence } from "./presence.js";
import type { Count, Hit, SearchAnswer as EngineAnswer, SearchQuery } from "./record-search.js";
import { lineRef, makeRef, readRef } from "./refs.js";
import { Refusal, refused } from "./refusal.js";
import { productWindows, type ProductWindows } from "./screen-keys.js";
import { cursorOf as screenCursorOf, cursorText as screenCursorText, gaveToo, MEANING_ROOM, PAGE_HITS, stretchStart, TERM_LINES, windowOf, type ScreenCursor, type ScreenGate, type ScreenHit as EngineScreenHit, type StretchGroups } from "./screen-query.js";
import { meaningMatches, meaningStanding, vectorOf, vectorScan, type HeldMeaning, type MeaningMatch } from "./screen-reads.js";
import { argsOf, familyOf, paramsOf, searchParams, storedFamilies, type RecordHit, type RecordList, type ScreenHit, type ScreenList, type SearchAnswer, type SearchParams } from "./search-contract.js";
import type { RecordRead, SearchCursor } from "./search-index.js";
import { placeFold, readQuery, RECORD_WORDS, SCREEN_WORDS, tokens, wordsIn, wordsOfTerms, type Read } from "./search-words.js";
import { chosenFor, type Settings } from "./settings.js";
import { notBuilding, PERSONS_MAX, personsAsked } from "./count.js";


export interface MeaningModel {
  unit: string;
  file: string;
  power: Settings["search"]["power"];
}

export function meaningModel(settings: Pick<Settings, "defaults" | "search">): MeaningModel | null {
  const id = chosenFor(settings, "search");
  const route = id === null ? null : readRouteId(id);
  return route?.runner === undefined ? null : { unit: route.runner, file: route.model, power: settings.search.power };
}

export interface ScreenOptions {
  meaningModel: MeaningModel | null;
  file: string;
  meaning?: HeldMeaning;
  lent?: Lent;
  copies?: Copies;
}

export interface Unmatched {
  in: readonly string[];
  nowhere: readonly string[];
  width?: number;
}

export type MeaningLent = { words: string } | { withheld: true };

export type Copies = readonly (readonly string[])[];

export interface Lent {
  passages?: true;
  copies?: Copies;
  unmatched?: Unmatched;
  meaning?: MeaningLent;
  width?: number;
}

export interface Widened {
  steps: { hits: number; next: string | null }[];
  ended?: true;
}

type List = "record" | "screen" | "goto";
const KINDS = ["page", "rank", "rest", "scan"] as const;
const GOTO_MOST = 3;
export const SEARCH_LIMIT = 20;

export const ROUND_WIDTH = GIVEN_MOST;

const bad = (member: string, why: string): never => refused("BAD_PARAMETER", `\`${member}\` ${why}.`);

type Args = Params<"record">;

interface RecordCarried {
  list: "record";
  at: SearchCursor;
  total: number;
  capped: boolean;
}

interface ScreenCarried {
  list: "screen";
  records: boolean;
  at: ScreenCursor;
}

type Carried = RecordCarried | ScreenCarried;

interface Envelope<C extends Carried = Carried> {
  carried: C;
  opened: Opened<"record" | "screen">;
}

export interface SearchAsked {
  params: SearchParams;
  args: Args;
  lists: readonly List[];
  cursor?: Envelope;
}

const optional = (out: CursorWriter, value: number | null) => (value === null ? out.put(0) : out.put(1).signed(value));

export function searchPlace(out: CursorWriter, at: SearchCursor): CursorWriter {
  out.put(KINDS.indexOf(at.kind));
  if (at.kind === "page") optional(optional(out, at.slot), at.stop);
  else if (at.kind === "rank") optional(optional(out, at.from), at.today).set(at.given);
  else if (at.kind === "rest") optional(optional(out, at.place), at.stop).set(at.given);
  else optional(out, at.slot).set(at.given ?? []);
  return out;
}

function recordPlace(carried: Omit<RecordCarried, "list">): CursorWriter {
  return searchPlace(new CursorWriter(), carried.at).put(carried.total).put(carried.capped ? 1 : 0);
}

const holdsGiven = (at: SearchCursor) => at.kind !== "page" && (at.given?.length ?? 0) > 0;

function recordBound(file: string, epoch: number | null, resolved: string | undefined, at: SearchCursor): Bound {
  return { index: file, ...(holdsGiven(at) ? { epoch } : {}), ...(resolved === undefined ? {} : { resolved }) };
}
const screenBound = (file: string, epoch: number | null, at: ScreenCursor): Bound => ({ screen: file, ...(at.given.length > 0 ? { epoch } : {}) });

export function cursorOf(carried: Omit<RecordCarried, "list">, args: Args, bound: Bound): string {
  return sealed("record", recordPlace(carried).written, args, bound);
}

const recordsPlace = (records: boolean): Buffer => Buffer.from(new CursorWriter().put(records ? 1 : 0).written);

export function screenNextOf(at: ScreenCursor, records: boolean, args: Args, file: string, epoch: number | null): string {
  return sealed("screen", Buffer.concat([recordsPlace(records), Buffer.from(screenCursorText(at), "base64url")]), args, screenBound(file, epoch, at));
}

export function screenRoom(args: Args, meaning = false): number {
  return Math.floor(((NEXT_BYTES - aroundBytes(argumentsWritten("screen", args).length) - recordsPlace(true).length) * 4) / 3) - (meaning ? MEANING_ROOM : 0);
}

export function searchPlaceRead(read: CursorReader): SearchCursor {
  const kind = KINDS[read.small(KINDS.length - 1)]!;
  const safe = (value: bigint) => {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) throw read.broken();
    return value;
  };
  const slot = () => (read.small(1) === 0 ? null : Number(safe(read.signed())));
  const given = () => read.set(GIVEN_MOST).map((each) => Number(safe(each)));
  if (kind === "page") return { kind, slot: slot(), stop: slot() };
  if (kind === "rank") return { kind, from: slot(), today: slot(), given: given() };
  if (kind === "rest") return { kind, place: slot(), stop: slot(), given: given() };
  return { kind, slot: slot(), given: given() };
}

function screenCarried(read: CursorReader): ScreenCarried {
  const records = read.small(1) === 1;
  return { list: "screen", records, at: screenCursorOf(read.rest().toString("base64url")) };
}

function recordCarried(read: CursorReader): RecordCarried {
  const at = searchPlaceRead(read);
  const total = read.small();
  const capped = read.small(1) === 1;
  read.end();
  return { list: "record", at, total, capped };
}

export function searchAskedOf(given: SearchParams): SearchAsked {
  let cursor: Envelope | undefined;
  if (given.cursor !== undefined) {
    const held = opened(given.cursor, ["record", "screen"], given);
    try {
      cursor = { opened: held, carried: held.route === "record" ? recordCarried(held.place) : screenCarried(held.place) };
    } catch (error) {
      if (error instanceof CursorError) bad("cursor", "is not a next this route gave");
      throw error;
    }
  }
  const { lists: _lists, cursor: _cursor, ...args } = cursor === undefined ? given : { ...cursor.opened.params, cursor: undefined };
  const params: SearchParams = args;
  argumentsWritten("record", args);
  if (params.typing !== undefined && (params.query === undefined || params.query.trim() === "")) bad("typing", "is 1 with query");
  const lists: readonly List[] = cursor !== undefined ? [cursor.carried.list] : given.lists ?? ["record", "screen"];
  return { params, args, lists, ...(cursor === undefined ? {} : { cursor }) };
}

export interface RecordAsk {
  read: RecordRead;
  words: Read | undefined;
  people: PeopleMap | undefined;
  said: SearchAnswer["person"];
  where: Presence | undefined;
  day: DaySettings;
  from_ms: number | undefined;
  to_ms: number | undefined;
  query: SearchQuery;
}

export function recordAskOf(asked: SearchAsked, call: Call, lent?: Lent): RecordAsk & { carried: Envelope<RecordCarried> | undefined; bound: (at: SearchCursor) => Bound } {
  const { params, lists } = asked;
  const carried = asked.cursor?.carried.list === "record" ? asked.cursor as Envelope<RecordCarried> : undefined;
  const read = call.index();
  const where = call.whereIfReady();
  const day = read.clock;
  const typed = params.query?.trim() === "" ? undefined : params.query;
  const words = typed === undefined ? undefined : readQuery(typed, RECORD_WORDS, params.typing === 1);
  if (words !== undefined && wordsOfTerms(words.terms) === null) bad("query", "names no word to find");
  const order = params.order ?? (words === undefined ? "newest" : "relevance");
  if (words === undefined && order === "relevance") bad("order", "is newest or oldest without query: relevance ranks words");
  const { from_ms, to_ms } = rangeAsked(params, day);

  const wantsPeople = params.person !== undefined || (lists.includes("goto") && words !== undefined);
  const people = params.person !== undefined ? call.people() : wantsPeople ? call.peopleIfReady() : undefined;
  if (params.person !== undefined && params.person.length > PERSONS_MAX) bad("person", `names at most ${PERSONS_MAX} people`);
  const resolved = params.person === undefined ? undefined : personsAsked(params.person, people!, call);
  const said = resolved?.said;
  const who = resolved === undefined ? undefined : [...new Set(resolved.who.flatMap((each) => each.handles.map((handle) => handleOfId(handle)?.value ?? handle)))];
  const chats = params.chat === undefined ? undefined : [call.chat(readRef(params.chat, "chat", ["chat"]).parts.key)];
  let places: SearchQuery["places"];
  let areas: ReturnType<typeof areasKept> | undefined;
  if (params.place !== undefined) {
    const terms = placeTermsOf(params.place);
    if (terms.length === 0) bad("place", "names no place");
    call.where();
    areas = areasKept(where!.areas, placesKept(where!.areas, terms));
    places = placeStretches(where!, areas, day);
  }
  const resolution = who === undefined && areas === undefined && chats === undefined ? undefined
    : resolvedOf({ who: who === undefined ? null : [...who].sort(), places: areas === undefined ? null : { in: areas.in === undefined ? null : [...areas.in].sort(), out: [...areas.out].sort() }, chats: chats ?? null });
  carried?.opened.check({ index: () => read.file, epoch: () => call.epoch, resolved: () => resolution });
  const bound = (at: SearchCursor) => recordBound(read.file, call.epoch, resolution, at);
  const query: SearchQuery = {
    ...(words === undefined ? {} : { terms: words.terms, ...(words.typing ? { typing: true } : {}) }),
    ...(params.families === undefined ? {} : { families: storedFamilies(params.families, call.families.map((each) => each.name)) }), ...(params.products === undefined ? {} : { products: params.products }),
    ...(call.reader === "model" ? { notProducts: [ASK_PRODUCT] } : { forPerson: true }),
    from_ms, to_ms, who, order, limit: params.limit ?? SEARCH_LIMIT, ...(lent?.width === undefined ? {} : { width: lent.width }), today_ms: dayBounds(civilDay(call.now_ms, day), day).end_ms,
    ...(chats === undefined ? {} : { chats }), ...(places === undefined ? {} : { places }),
    ...(carried === undefined ? {} : { after: carried.carried.at }),
    ...(carried === undefined || carried.carried.at.kind === "scan" ? { facets: ["family", "month"] } : {}),
    sender: senderOf(call, people),
    ...(lent?.passages === true ? { passages: true } : {}),
    ...(call.gate === undefined ? {} : { gate: call }),
  };
  return { read, words, people, said, where, day, from_ms, to_ms, query, carried, bound };
}

export interface RecordPart {
  answer: SearchAnswer;
  copies?: Copies;
}

export function recordPartOf(asked: SearchAsked, call: Call, lent?: Lent): RecordPart {
  const { args, lists } = asked;
  const { read, words, people, said, where, day, from_ms, to_ms, query, carried, bound } = recordAskOf(asked, call, lent);
  const answer: SearchAnswer = {
    ...(words === undefined || (words.without.length === 0 && Object.keys(words.as).length === 0) ? {} : { read_as: { without: words.without, as: words.as as Record<string, string[]> } }),
    ...(said === undefined || said.length === 0 ? {} : { person: said }),
  };
  let copies: Copies | undefined;
  if (lists.includes("record")) {
    if (call.gate !== undefined) notBuilding(read);
    const found: EngineAnswer = read.search({ ...query, passages: true });
    if (!("hits" in found)) throw new Error("a search of hits answered groups");
    call.walked(found.capped === true);
    if (found.variants !== undefined) answer.variants = found.variants;
    copies = copiesIn(found.hits);
    const shown = lent?.passages === true ? found : { ...found, hits: found.hits.map(({ passages: _passages, ...hit }) => hit) };
    answer.record = recordListOf(read, shown, { carried: carried?.carried, args, bound, where, day, from_ms, to_ms, call });
  }
  if (lists.includes("goto") && call.gate === undefined) answer.goto = gotoOf(words, people, call, day);
  return { answer, ...(copies === undefined ? {} : { copies }) };
}

const copiesIn = (hits: readonly Hit[]): Copies =>
  hits.filter((hit) => hit.family !== null && familyOf(hit.family) !== "screen").map((hit) => (hit.passages ?? []).map((passage) => passage.text));

function copiesSearched(asked: SearchAsked, call: Call): Copies {
  const read = call.indexIfReady();
  if (read === undefined || (call.gate !== undefined && read.building() !== null)) return [];
  try {
    const { query } = recordAskOf({ params: asked.params, args: asked.args, lists: ["record"] }, call);
    const found: EngineAnswer = read.search({ ...query, passages: true });
    return "hits" in found ? copiesIn(found.hits) : [];
  } catch (error) {
    if (error instanceof Refusal) return [];
    throw error;
  }
}

function onlyCopy(hit: EngineScreenHit, held: readonly (readonly string[])[]): boolean {
  const terms = [...hit.terms ?? [], ...hit.also.flatMap((other) => other.terms ?? [])];
  if (terms.length === 0 || terms.some((term) => term.lines.length >= TERM_LINES)) return false;
  const asked = new Set(terms.flatMap((term) => [...tokens(term.word), ...term.forms.flat()]));
  const lines = terms.flatMap((term) => term.lines).map(tokens).filter((words) => words.some((word) => !asked.has(word)));
  return lines.length > 0 && held.some((texts) => lines.every((words) => texts.some((text) => text.includes(` ${words.join(" ")} `))));
}

function screenGate(call: Call): ScreenGate {
  const gate = call.gate!;
  const machines = call.screenAccounts();
  const accountsOf = (machine: string) => machines.get(machine) ?? [];
  const floors = new Map<string, number | null | undefined>();
  const floor = (machine: string) => {
    if (!floors.has(machine)) floors.set(machine, earliest(gate, accountsOf(machine)));
    return floors.get(machine);
  };
  const firsts = [...machines.keys()].map(floor);
  const since_ms = firsts.includes(null) ? null : firsts.reduce<number>((least, first) => Math.min(least, first ?? Infinity), Infinity);
  return {
    since_ms: since_ms === Infinity ? call.now_ms : since_ms,
    floor,
    allows: (machine, at_ms, tally) => {
      const from = floor(machine);
      const allowed = from === null || (from !== undefined && at_ms >= from);
      if (!allowed && tally) call.judge({ accounts: accountsOf(machine), start_ms: at_ms }, true);
      return allowed;
    },
  };
}

export function searchAnswerOf(asked: SearchAsked, call: Call, record: SearchAnswer | undefined, screen: ScreenPart | undefined): SearchAnswer {
  const { record: list, goto, read_as, ...said } = record ?? {};
  const kept = call.keptOut();
  if (kept !== undefined) call.log.withheld = kept;
  return {
    ...(read_as ?? screen?.read_as) === undefined ? {} : { read_as: read_as ?? screen!.read_as! }, ...said,
    ...(list === undefined ? {} : { record: list }), ...(screen === undefined ? {} : { screen: screen.screen }), ...(goto === undefined ? {} : { goto }),
    ...(kept !== undefined && asked.cursor === undefined ? { outside: true as const } : {}),
  };
}

export interface ScreenPart {
  screen: ScreenList | { unread: string };
  read_as?: { without: string[]; as: Record<string, string[]> };
}

function rangeAsked(params: SearchParams, clock: DaySettings): { from_ms: number | undefined; to_ms: number | undefined } {
  const time = (name: "from" | "to", edge: "start" | "end") => (params[name] === undefined ? undefined : timeParameter(name, params[name]!, clock, edge));
  const from_ms = time("from", "start"), to_ms = time("to", "end");
  if (from_ms !== undefined && to_ms !== undefined && to_ms < from_ms) bad("to", "is not before from");
  return { from_ms, to_ms };
}

export function screenUnread(params: SearchParams): false | { unread: string } | true {
  if (params.families !== undefined && !params.families.includes("screen")) return false;
  if (params.person !== undefined) return { unread: "the screen records no person" };
  if (params.chat !== undefined) return { unread: "the screen records no chat" };
  if (params.place !== undefined) return { unread: "the screen records no place" };
  if (params.query === undefined || params.query.trim() === "") return { unread: "the screen is searched by its words, and none were asked" };
  const missing = params.products?.find((product) => productWindows([product]) === undefined);
  if (missing !== undefined) return { unread: `the screen keeps no table of the windows of ${missing}` };
  return true;
}

export function meaningAsked(query: URLSearchParams | object, lent?: MeaningLent): string | undefined {
  if (lent !== undefined && "withheld" in lent) return undefined;
  let asked: SearchAsked;
  try {
    asked = searchAskedOf(query instanceof URLSearchParams ? paramsOf(searchParams, query) : argsOf(searchParams, query));
  } catch {
    return undefined;
  }
  if (!asked.lists.includes("screen")) return undefined;
  if (asked.cursor !== undefined && (asked.cursor.carried.list !== "screen" || !stretchStart(asked.cursor.carried.at))) return undefined;
  if (screenUnread(asked.params) !== true) return undefined;
  const words = lent?.words ?? asked.params.query!;
  return quotedAll(words) ? undefined : words.trim();
}

const quotedAll = (q: string): boolean => {
  const wanted = readQuery(q, SCREEN_WORDS).terms.filter((term) => !term.negated);
  return wanted.length > 0 && wanted.every((term) => term.quoted);
};

export const SCREEN_BUILT = "the screen index is being built";
export const SCREEN_WRITTEN = "the screen index is being written";
const MEANING_NOT_READY = "Search by meaning is getting ready: the screen's texts are not read for meaning yet.";
const MEANING_UNREAD = "Search by meaning did not read this ask: ask again.";

export function screenOutside(call: Call): boolean {
  const gate = call.gate;
  if (gate === undefined) return false;
  const machines = [...call.screenAccounts().values()];
  return (machines.length === 0 ? [[]] : machines).every((accounts) => earliest(gate, accounts) === undefined);
}

export async function screenAnswerOf(asked: SearchAsked, call: Call, options: ScreenOptions): Promise<ScreenPart | undefined> {
  const wanted = screenUnread(asked.params);
  if (wanted === false || screenOutside(call)) return undefined;
  if (wanted !== true) return { screen: wanted };
  const read = call.screenIfReady();
  if (read === "none") return { screen: { unread: SCREEN_BUILT } };
  const written = { screen: { unread: SCREEN_WRITTEN } };
  if (read === "busy") return written;
  try {
    return await screenListOf(read, asked, call, options);
  } catch (error) {
    if (busy(error)) return written;
    throw error;
  }
}

export function screenGroupsOf(asked: SearchAsked, call: Call, at?: ScreenCursor): { groups: StretchGroups; file: string; clock: DaySettings } | { unread: string } {
  const wanted = screenUnread(asked.params);
  if (typeof wanted === "object") return wanted;
  const read = call.screenIfReady();
  if (read === "none") return { unread: SCREEN_BUILT };
  const written = { unread: SCREEN_WRITTEN };
  if (read === "busy") return written;
  const { from_ms, to_ms } = rangeAsked(asked.params, read.clock);
  const gate = call.gate === undefined ? undefined : screenGate(call);
  try {
    const groups = read.groups({
      q: asked.params.query!, now_ms: call.now_ms, ...(asked.params.typing === 1 ? { typing: true as const } : {}),
      ...(from_ms === undefined ? {} : { from_ms }), ...(to_ms === undefined ? {} : { to_ms }), ...(at === undefined ? {} : { cursor: at }), ...(gate === undefined ? {} : { gate }),
    });
    return { groups, file: read.file, clock: read.clock };
  } catch (error) {
    if (busy(error)) return written;
    throw error;
  }
}

async function screenListOf(read: ScreenRead, asked: SearchAsked, call: Call, options: ScreenOptions): Promise<ScreenPart> {
  const { params, args } = asked;
  const clock = read.clock;
  const { from_ms, to_ms } = rangeAsked(params, clock);
  const carried = asked.cursor?.carried.list === "screen" ? asked.cursor as Envelope<ScreenCarried> : undefined;
  carried?.opened.check({ screen: () => read.file, epoch: () => call.epoch });
  const windows = params.products === undefined ? undefined : productWindows(params.products);
  const first = stretchStart(carried?.carried.at);
  const lent = options.lent;
  const gate = call.gate === undefined ? undefined : screenGate(call);
  const records = carried?.carried.records ?? (asked.lists.includes("record") || lent?.copies !== undefined);
  const held = (lent?.copies ?? options.copies ?? (records ? copiesSearched(asked, call) : [])).map((texts) => texts.map((text) => ` ${tokens(text).join(" ")} `)).filter((texts) => texts.length > 0);
  const page = read.search({
    q: params.query!, now_ms: call.now_ms, room: screenRoom(args, first),
    ...(lent?.passages === true || held.length > 0 ? { evidence: true } : {}),
    ...(lent?.unmatched === undefined ? {} : {
      unmatched: new Set(lent.unmatched.in), nowhere: new Set(lent.unmatched.nowhere), ...(lent.unmatched.width === undefined ? {} : { width: lent.unmatched.width }),
    }),
    ...(from_ms === undefined ? {} : { from_ms }), ...(to_ms === undefined ? {} : { to_ms }), ...(windows === undefined ? {} : { windows }),
    ...(carried === undefined ? {} : { cursor: carried.carried.at }), ...(gate === undefined ? {} : { gate }),
  });
  const zone = clock.zone;
  const span = {
    from_ms: Math.max(from_ms ?? -Infinity, gate?.since_ms ?? -Infinity, dayBounds(page.stretch.from, clock).start_ms),
    to_ms: Math.min(to_ms ?? Infinity, call.now_ms, dayBounds(page.stretch.to, clock).end_ms),
  };
  const meaning = await meaningOf(read, params.query!, first ? span : undefined, page.hits.length, options, windows, gate);
  const proven = new Set(page.hits.map((hit) => hit.evidence));
  const byMeaning = meaning.matches.filter((match) => !proven.has(match.evidence)).slice(0, PAGE_HITS);
  const words = held.length === 0 ? page.hits : page.hits.filter((hit) => !onlyCopy(hit, held));
  const next = gaveToo(page, byMeaning.map((match) => ({ key: BigInt(match.key), day: match.day })));
  const asOf = call.asOf(page.seq, zone);
  const where = call.whereIfReady();
  const screen: ScreenList = {
    ...(asOf === null ? {} : { as_of: asOf }), total: page.total, capped: page.capped,
    ...(page.reached === undefined ? {} : { reached: page.reached }),
    meaning: meaning.state, ...(meaning.waits === undefined ? {} : { waits: meaning.waits }),
    hits: [...words.map((hit) => screenHitOf(hit, clock, where, lent?.passages === true)), ...byMeaning.map((match) => meaningHitOf(match, clock, where))],
    ...(page.order === undefined ? {} : { order: page.order }),
    next: next === undefined ? null : screenNextOf(next, records, args, read.file, call.epoch),
    ...(next === undefined ? {} : { next_gives: next.newest === page.stretch.to ? "windows" as const : "days" as const }),
  };
  const said = page.read_as.without.length === 0 && Object.keys(page.read_as.as).length === 0 ? undefined : { without: page.read_as.without, as: page.read_as.as as Record<string, string[]> };
  return { screen, ...(said === undefined ? {} : { read_as: said }) };
}

async function meaningOf(
  read: ScreenRead, q: string, span: { from_ms: number; to_ms: number } | undefined, words: number, context: ScreenOptions, windows?: ProductWindows, gate?: ScreenGate,
): Promise<{ state: ScreenList["meaning"]; waits?: string; matches: MeaningMatch[] }> {
  const lent = context.lent?.meaning;
  if (quotedAll(lent !== undefined && "words" in lent ? lent.words : q)) return { state: "not_asked", matches: [] };
  if (context.meaningModel === null) return { state: "off", matches: [] };
  if (lent !== undefined && "withheld" in lent) return { state: "withheld", matches: [] };
  const standing = meaningStanding(read.db, context.meaningModel);
  if (!standing.available) return { state: "waits", waits: MEANING_NOT_READY, matches: [] };
  const held = context.meaning;
  const waits = held !== undefined && "waits" in held ? held.waits : standing.waits?.line;
  const vector = held === undefined || "waits" in held ? undefined : vectorOf(held);
  if (span !== undefined && vector === undefined && waits === undefined) return { state: "waits", waits: MEANING_UNREAD, matches: [] };
  const matches = span === undefined || vector === undefined || span.to_ms <= span.from_ms ? [] : await meaningMatches(read.db, context.file, vectorScan(read.folder), {
    vector, model: (held as { model: string }).model, from_ms: span.from_ms, to_ms: span.to_ms, limit: PAGE_HITS + words,
    ...(windows === undefined ? {} : { windows }), ...(gate === undefined ? {} : { floor: gate.floor }),
  });
  return { state: waits === undefined ? "on" : "waits", ...(waits === undefined ? {} : { waits }), matches };
}

export const shownAt = (ms: number, clock: DaySettings, where: Presence | undefined): string => at(ms, false, where, clock)!;

export function screenHitOf(hit: EngineScreenHit, clock: DaySettings, where: Presence | undefined, evidence = false): ScreenHit {
  const proven = !evidence ? {} : {
    source: hit.source, terms: hit.terms, group: hit.group,
    siblings: hit.also.map((other) => ({ title: windowOf(other), terms: other.terms, group: other.group })),
  };
  return {
    ...proven,
    ref: makeRef("window", { machine: hit.machine, day: hit.day, app: hit.app, site: hit.site, name: hit.name, at_ms: hit.until_ms === null ? hit.at_ms : null }),
    at: shownAt(hit.at_ms, clock, where), ...(hit.until_ms === null ? {} : { until: shownAt(hit.until_ms, clock, where), time_precision: "range" as const }),
    day: hit.day, app: hit.app, title: windowOf(hit), snippet: hit.excerpt, reason: hit.reason, ...(hit.also.length === 0 ? {} : { also: hit.also.length }),
  };
}

function meaningHitOf(match: MeaningMatch, clock: DaySettings, where: Presence | undefined): ScreenHit {
  const spans = match.spans ?? [];
  const from = spans[0]?.[0] ?? dayBounds(match.day, clock).start_ms;
  const to = spans.at(-1)?.[1] ?? from;
  const minute = match.time_precision === "minute";
  return {
    ref: makeRef("window", { machine: match.machine, day: match.day, app: match.app, site: match.site, name: match.name, at_ms: minute ? from : null }),
    at: shownAt(from, clock, where), ...(minute ? {} : { until: shownAt(to, clock, where), time_precision: "range" as const }),
    day: match.day, app: match.app, title: match.window, snippet: match.excerpt, reason: "meaning",
  };
}


function recordListOf(
  read: RecordRead, found: Extract<EngineAnswer, { hits: Hit[] }>,
  how: { carried: RecordCarried | undefined; args: Args; bound: (at: SearchCursor) => Bound; where: Presence | undefined; day: DaySettings; from_ms?: number | undefined; to_ms?: number | undefined; call: Call },
): RecordList & Partial<Widened> {
  const { carried, where, day } = how;
  const total = found.total ?? carried?.total ?? found.hits.length;
  const capped = found.capped ?? carried?.capped ?? false;
  const each = found.hits.map((hit) => recordHitOf(hit, where, day));
  const hits = each.flat();
  const reachedAt = found.reached?.at === undefined || found.reached.at === null ? undefined : Date.parse(found.reached.at);
  const oldestHit = found.hits.reduce<number | undefined>((least, hit) => (hit.start_ms === null ? least : Math.min(least ?? Infinity, hit.start_ms)), undefined);
  const bound = reachedAt ?? (found.order !== undefined || carried?.at.kind === "page" ? oldestHit : undefined);
  const newestSide = found.reached?.side !== "oldest";
  const opens = how.call.gate === undefined ? null : opensAt(how.call.gate);
  const fromMs = opens === null ? how.from_ms : Math.max(how.from_ms ?? opens, opens);
  const askedFrom = fromMs !== undefined ? civilDay(fromMs, day) : OPEN_FROM;
  const askedTo = how.to_ms !== undefined ? civilDay(how.to_ms - 1, day) : civilDay(how.call.now_ms, day);
  const fromDay = bound !== undefined && newestSide && civilDay(bound, day) > askedFrom ? civilDay(bound, day) : askedFrom;
  const toDay = bound !== undefined && !newestSide && civilDay(bound, day) < askedTo ? civilDay(bound, day) : askedTo;
  const fresh = how.call.fresh(read.seq, read.held(fromDay, toDay < fromDay ? fromDay : toDay));
  const nextOf = (at: SearchCursor | undefined) => (at === undefined ? null : cursorOf({ at, total, capped }, how.args, how.bound(at)));
  const next = nextOf(found.next);
  let shown = 0;
  const widened: Partial<Widened> = found.steps === undefined ? {} : {
    steps: found.steps.map((at, n) => ({ hits: shown += each[n]!.length, next: nextOf(at) })),
    ...(found.ended === true ? { ended: true as const } : {}),
  };
  const spread = found.facets === undefined ? undefined : {
    families: countsOf(found.facets.family ?? [], familyOf),
    months: countsOf(found.facets.month ?? [], (key) => key),
  };
  return {
    ...freshMembers(fresh), total, capped, hits,
    ...(found.reached?.at === undefined || found.reached.at === null ? {} : { reached: { side: found.reached.side, at: found.reached.at, whole: found.reached.whole } }),
    ...(found.held === undefined ? {} : { held: found.held }),
    ...(spread === undefined ? {} : { spread }), ...(found.order === undefined ? {} : { order: found.order }),
    next, ...widened,
  };
}

function senderOf(call: Call, asked: PeopleMap | undefined): (who: string, handle: string) => boolean {
  let people: PeopleMap | null | undefined = asked;
  const ids = new Map<string, string | undefined>();
  const idOf = (map: PeopleMap, id: string) => {
    if (!ids.has(id)) ids.set(id, map.idOf(id));
    return ids.get(id);
  };
  return (who, handle) => {
    if (people === undefined) {
      try {
        people = call.peopleIfReady() ?? null;
      } catch (error) {
        if (!(error instanceof Refusal) || error.code !== "NOT_NOW") throw error;
        people = null;
      }
    }
    if (people === null) return false;
    const person = idOf(people, handle);
    return person !== undefined && idOf(people, who) === person;
  };
}

function countsOf(counts: readonly Count[], name: (key: string) => string): Record<string, number | { n: number; partial: true }> {
  const out: Record<string, number | { n: number; partial: true }> = {};
  for (const count of counts) {
    const key = name(count.key);
    const was = out[key];
    const n = (was === undefined ? 0 : typeof was === "number" ? was : was.n) + count.n;
    out[key] = count.partial === true || typeof was === "object" ? { n, partial: true } : n;
  }
  return out;
}

export function recordHitOf(hit: Hit, where: Presence | undefined, day: DaySettings): RecordHit[] {
  if (hit.family === null) return [];
  const marked = new Set([...hit.snippet.matchAll(/«([^»]+)»/gu)].flatMap((each) => wordsIn(each[1]!).map((one) => one.word)));
  const spansIn = (text: string) => wordsIn(text).filter((each) => marked.has(each.word)).map(({ start, end }) => ({ start, end }));
  const passage = hit.passages?.find((each) => spansIn(each.text).length > 0) ?? hit.passages?.find((each) => each.text !== "");
  const sender = hit.from === undefined ? undefined : hit.passages?.flatMap((each) => each.names.filter((named) => each.text.slice(named.start, named.end) === hit.from))[0]?.who;
  const snippet = passage === undefined ? hit.snippet : { text: passage.text, names: passage.names, spans: spansIn(passage.text) };
  const from = sender === undefined ? hit.from : { text: hit.from!, who: sender };
  const ref = hit.layer === "records" || hit.day === null ? makeRef("record", hit.ref as RecordRef)
    : lineRef({ day: hit.day, same: hit.line!.same, unit: hit.unit ?? "", item: hit.item ?? null }, hit.line!.m);
  const was = hit.start_ms === null || hit.day === null ? { owners: [] } : wasAt(where, { start_ms: hit.start_ms, dated: hit.dated, day: hit.day });
  return [{
    ref, ...(hit.day === null ? {} : { day: hit.day }), family: familyOf(hit.family),
    ...(hit.start_ms === null || hit.day === null || hit.dated === true ? {} : { at: at(hit.start_ms, false, where, day)! }),
    ...(hit.product === undefined ? {} : { product: hit.product }), ...(hit.title === "" ? {} : { title: hit.title }),
    ...(from === undefined ? {} : { from: from as string }), ...(hit.snippet === "" && passage === undefined ? {} : { snippet: snippet as string }),
    ...(hit.chat === undefined ? {} : { chat: makeRef("chat", { key: hit.chat }) }), ...(hit.chat_title === undefined || hit.chat_title === "" ? {} : { chat_title: hit.chat_title }),
    ...(was.words === undefined ? {} : { the_user_was_at: was.words }), ...(hit.picture === undefined || hit.picture < 1 ? {} : { picture: hit.picture }),
    ...(hit.layer === "atoms" && hit.rev !== undefined ? { rev: hit.rev } : {}), ...(hit.more === true ? { more: true as const } : {}),
    ...(hit.passages === undefined ? {} : { passages: hit.passages }),
  }];
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function gotoOf(words: Read | undefined, people: PeopleMap | undefined, call: Call, day: DaySettings): NonNullable<SearchAnswer["goto"]> {
  const text = wantedOf(words);
  const named = text === "" ? { day: null, month: null } : whenNamed(text.toLowerCase(), civilDay(call.now_ms, day));
  return { people: peopleNamed(words, people, call).map(({ ref, name }) => ({ ref, name })), places: placesNamed(words, call).map(({ ref, name }) => ({ ref, name })), ...named };
}

const wantedOf = (words: Read | undefined): string => (words === undefined ? [] : words.terms.filter((term) => !term.negated).map((term) => term.text)).join(" ");

export function peopleNamed(words: Read | undefined, people: PeopleMap | undefined, call: Call): { ref: string; name: string; id: string; handles: readonly string[] }[] {
  const text = wantedOf(words);
  return text === "" || people === undefined ? [] : people.find(text).slice(0, GOTO_MOST).flatMap((id) => {
    const person = people.person(id);
    return person === undefined ? [] : [{ ref: call.personRef(id), name: person.name, id, handles: person.handles }];
  });
}

export function placesNamed(words: Read | undefined, call: Call): { ref: string; name: string; days: number }[] {
  const folded = (words === undefined ? [] : words.terms.filter((term) => !term.negated).map((term) => placeFold(term.text))).filter((word) => word !== "");
  return folded.length === 0 ? [] : [...call.placesIfReady()?.value<{ places: { slug: string; name: string; days?: number }[] }>("answer", "list")?.places ?? []]
    .filter((place) => folded.every((word) => placeFold(place.name).split(" ").some((part) => part.startsWith(word))))
    .sort((left, right) => (right.days ?? 0) - (left.days ?? 0)).slice(0, GOTO_MOST)
    .map((place) => ({ ref: makeRef("place", { id: place.slug }), name: place.name, days: place.days ?? 0 }));
}

export function whenNamed(text: string, today: string): { day: string | null; month: string | null } {
  const none = { day: null, month: null };
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) return Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ? none : { day: text, month: null };
  if (/^\d{4}-\d{2}$/u.test(text)) return Number(text.slice(5)) >= 1 && Number(text.slice(5)) <= 12 ? { day: null, month: text } : none;
  if (text === "today") return { day: today, month: null };
  if (text === "yesterday") return { day: addDays(today, -1), month: null };
  const month = (word: string) => (word.length < 3 ? -1 : MONTHS.findIndex((name) => name.startsWith(word)));
  const pad = (n: number) => String(n).padStart(2, "0");
  const parts = text.split(/[\s,]+/u).filter(Boolean);
  let m = -1, d: number | undefined, y: number | undefined;
  for (const part of parts) {
    if (/^\d{4}$/u.test(part) && y === undefined) y = Number(part);
    else if (/^\d{1,2}(?:st|nd|rd|th)?$/u.test(part) && d === undefined) d = parseInt(part, 10);
    else if (month(part) >= 0 && m < 0) m = month(part);
    else return none;
  }
  if (m < 0) return none;
  if (d === undefined) {
    const year = y ?? (`${today.slice(0, 4)}-${pad(m + 1)}` <= today.slice(0, 7) ? Number(today.slice(0, 4)) : Number(today.slice(0, 4)) - 1);
    return { day: null, month: `${year}-${pad(m + 1)}` };
  }
  const yearOf = (year: number) => `${year}-${pad(m + 1)}-${pad(d!)}`;
  const named = y !== undefined ? yearOf(y) : yearOf(Number(today.slice(0, 4))) <= today ? yearOf(Number(today.slice(0, 4))) : yearOf(Number(today.slice(0, 4)) - 1);
  const ms = Date.parse(`${named}T00:00:00Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== named ? none : { day: named, month: null };
}
