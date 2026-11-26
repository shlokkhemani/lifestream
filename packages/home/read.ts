import { accountOf, addDays, canonical, civilDay, dayBounds, GONE, handleId, handleOf, instantIn, type DaySettings, type Json, type RecordRef } from "@lifestreamprotocol/core";
import type { ConversationDay, DayAtom, DayDocument, DayFileFact, RecordRead as FamilyRecordRead, UnshownOf } from "@lifestreamprotocol/families";
import { AI_FAMILY, chatMembers, MESSAGES_FAMILY, parseMessagesUnit, partyHandle, PHOTOS_FAMILY, recordFocus, resolveChat, unitFocus } from "@lifestreamprotocol/families";
import { briefOf, leads, type BriefWindow } from "./brief.js";
import { outsideAccess, tooBroad, type Call, type Reader as ReaderKind, type ServedRef } from "./call.js";
import type { Cell } from "./cell.js";
import { type CountAsk, type CountPlace } from "./counting.js";
import { aroundBytes, CursorError, NEXT_CHARS, opened as openedCursor, resolvedOf, sealed, type Bound, type Current } from "./cursor-text.js";
import { shownName } from "./devices.js";
import { freshnessWords, type FreshSource } from "./freshness.js";
import { readTime } from "./home-clock.js";
import { freshMembers, type Fresh } from "./index-file.js";
import { byHandles, cutShape, digestOf, NoRoom, Room, sizeOf, type Cut, type Measure } from "./pager.js";
import { peopleOne } from "./people-search.js";
import type { PeopleSearchChat } from "./people.js";
import { photoOfRecord, withoutChat, type HeldPhoto, type Photo } from "./photo.js";
import { at, dayOf, wasAt as wasAtPlace } from "./presence.js";
import { lineRef, makeRef, ordinalOf, readRef, type RefParts } from "./refs.js";
import { refused, Refusal } from "./refusal.js";
import { SEGMENT_MS } from "./screen-index.js";
import { productWindows } from "./screen-keys.js";
import { NEAR_FRAMES, STRETCH_MS, type ScreenWindow, type WindowNamed, type WindowNear, type WindowRead } from "./screen-reads.js";
import { MachineSittings } from "./screen-sittings.js";
import type { MachineSources } from "./screen-source.js";
import {
  ContractError, day as dayShape, familyOf, int, lastMs, list, nullable, object, oneOf, readAnswer, tagged, text, type Citation, type DescribeAnswer, type DescribeParams,
  type Family as ContractFamily, type OnePlace, type Opens, type Of, type PeopleMatch, type ReadAnswer, type ReadOne, type ReadParams, type Shape, type Voice,
} from "./search-contract.js";
import { atomPassages } from "./record-search.js";
import { atomSame, LINE_ACCOUNTS, lineAccountsOf, type AtomRow as IndexAtom, type FactsRead } from "./search-index.js";
import { atomsOf as dayAtoms } from "./search.js";
import { collectionsOf, countAskOf, notBuilding, openRow, rowAskedOf, type RowAdmitted, type RowOpened } from "./count.js";
import { voiced, voiceOf } from "./voice-cite.js";

const PAGE_DAYS = 31;
export const READ_ROWS = 110_000;
export const PAGE_LINES = 400;
const AROUND_DAYS = 15;
export const PICTURES_MOST = 6;
const AROUND_LINES = 5;
const CHATS_A_PAGE = 32;
const STRETCH_ROWS = 20_000;
const ATOMS_AT_ONCE = PAGE_LINES + 1;
const DAYS_AT_ONCE = PAGE_DAYS + 1;
const RAW_RECORDS = 50;
const RECORD_ATOMS = 64;
const RECORD_UNREAD = "this call's reads ran out before that record's lines were read: read it alone, or with fewer refs";
const WINDOW_BEFORE_MS = STRETCH_MS / 2;
export const HIT_CHARS = 2_000;
export const CITES_MOST = 8;
export const PICTURE_WORDS = "a picture: `read` it to see it";
const YOU = "You";
const TITLE_CHARS = 80;
const PLACE_BYTES = 1_000;
const FRESH_CHARS = sizeOf({ as_of: "2026-11-02T10:00:00.000+05:30", pending: Array.from({ length: 100 }, () => ({ day: "2026-11-02", why: "erased" })), pending_more: Number.MAX_SAFE_INTEGER });
const SPAN_CHARS = sizeOf({ span: { from: "2026-11-02T10:00:00.000+05:30", to: "2026-11-02T10:00:00.000+05:30" } });
const LINE_KEEP = ["ref", "at", "day", "family", "from", "picture"] as const;
const RECORD_KEEP = ["what", "ref", "day", "family"] as const;
const SCREEN_KEEP = ["at", "app", "title"] as const;
const RECORD_GONE = "this record is no longer held: it was removed, or its source erased it";
const PICTURE_GONE = "this picture is no longer held";
const PERSON_GONE = "no one is held by this ref now";
const PLACE_GONE = "no place is held by this ref now";
const CHAT_GONE = "no chat is held by this ref now";
const WINDOW_GONE = "the screen holds no such window on its day now: that day's screen was erased, or never read";
const LINE_LEFT = "That day line is no longer in its day: its day was printed again without it, or erased. Search or read the day again.";
const LINE_UNREAD = "this call's reads ran out before that day line was found: read it alone, or with fewer refs";
const MINUTE = 60_000;
const SCREEN_FAMILY = "screen";
const MINUTE_TENTHS = 600;
const SCREEN_ROWS = 1_000;
const MODEL_SIZE = byHandles(readAnswer as Shape<unknown>);

export const MODEL_READ_CHARS = 16_000;

export const readSize = (reader: ReaderKind): Measure => (reader === "model" ? MODEL_SIZE : sizeOf);

export const readRoom = (reader: ReaderKind, answerChars: number): number => (reader === "model" ? Math.min(answerChars, MODEL_READ_CHARS) : answerChars);

interface Line {
  ref?: string;
  at?: string;
  day?: string;
  family?: ContractFamily;
  from?: string;
  picture?: true;
  text: string;
  cites?: string[];
  cites_more?: number;
}

interface MessageFact {
  source: string;
  key: string;
  at: number;
  parts?: { what: string; blob?: string; media_type?: string; ask?: string }[];
}

interface ChatAtom {
  start_ms: number | null;
  text: string;
  names?: { start: number; end: number }[];
  record?: RecordRef;
}

interface AtomRow {
  day: string;
  n: number;
  family: string;
  unit: string;
  item: string | null;
  source: string | null;
  kind: string | null;
  key: string | null;
  start_ms: number | null;
  end_ms: number | null;
  dated: number;
  line: string;
  names?: string | null;
  title: string;
  pictures: number | null;
  chat: string | null;
  same: string;
}
const ATOM_COLUMNS = "day, n, family, unit, item, source, kind, key, start_ms, end_ms, dated, line, title, pictures, chat, same";

export interface ScreenSource {
  readonly file: string;
  readonly clock: DaySettings;
  readonly as_of: string | null;
  segments(window: WindowNamed): number[];
  windowsIn(machine: string, from_ms: number, to_ms: number): ScreenWindow[];
  windowRead(window: WindowNamed, from_ms: number, to_ms: number, near: readonly number[]): WindowRead;
  windowNear(window: WindowNamed, from_ms: number, to_ms: number, at_ms: number | null): WindowNear | null;
  stretchLines(from_ms: number, to_ms: number): { t_ms: number; app: string; title: string; text: string }[];
  sources: MachineSources;
}

export interface Range {
  from: string;
  to: string;
  from_ms: number;
  to_ms: number;
  whole: boolean;
  wholeDays: { from: string; to: string } | null;
  stated: { from: string; to: string };
}

export interface Stretch extends Range {
  families: readonly ContractFamily[] | null;
  products: readonly string[] | null;
}

export interface ReadSources {
  readonly call: Call;
  chatDay(network: string, chat: string, keys: readonly string[], day: string): { title: string | null; atoms: ChatAtom[]; messages: MessageFact[] };
  chatKeys(network: string, chat: string): string[];
  aiChatOf(record: RecordRef): string | undefined;
  isAiChat(chat: string): boolean;
  productName(product: string): string;
  isProduct(product: string): boolean;
  recordOf(record: RecordRef, version?: string): { family: string | undefined; read: FamilyRecordRead | null; product: string | undefined; dated: boolean };
  name(id: string): string;
  readonly pieces?: boolean;
  photo(hex: string): HeldPhoto | undefined;
  unheld(of: UnshownOf): string | null;
  held(blob: string): boolean;
  dayDocument(day: string): DayDocument | undefined;
  freshness(): readonly FreshSource[];
  screen(): ScreenSource;
  screenIfReady(): ScreenSource | "busy" | undefined;
  readonly admitted?: RowAdmitted;
}


const word = text(/^.+$/su, "a non-empty text");
const count = int();
const ms = int(Number.MIN_SAFE_INTEGER);
const digest = text(/^[A-Za-z0-9_-]{12}$/u, "a digest");
const countPlace: Shape<CountPlace> = {
  schema: { type: "object" },
  parse(value, at = "$") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ContractError(at, "wants a row's place");
    return value as CountPlace;
  },
};

const CHAT_PLACE = object({ k: oneOf("chat"), c: word, e: ms, d: dayShape }, { r: digest, a: ms, q: count, i: cutShape });
const ROW_PLACE = object({ k: oneOf("row") }, { p: countPlace, i: cutShape });
const DAYS_PLACE = object({ k: oneOf("days"), d: dayShape }, { a: word, m: count, x: oneOf(1), z: int(0, 3), s: nullable(ms), e: nullable(ms), t: count, w: count, g: digest, i: cutShape });
const BRIEF_PLACE = object({ k: oneOf("brief"), d: dayShape, l: count, v: text() }, { i: cutShape });
const RUN_END = object({ t: ms, q: count }, { h: digest });
const RUN = object({ n: list(ms, 1, NEAR_FRAMES), a: RUN_END, b: RUN_END }, { c: cutShape });
const WINDOW_PLACE = object({ k: oneOf("window"), s: ms }, { r: RUN, t: ms, h: digest, q: count, i: cutShape });
const SCREEN_PLACE = object({ k: oneOf("screen"), t: ms, h: digest, q: count }, { i: cutShape });
const RECORD_PLACE = object({ k: oneOf("record") }, { s: count, i: cutShape });
const LINE_PLACE = object({ k: oneOf("line") }, { i: cutShape });
const PEOPLE_PLACE = object({ k: oneOf("people") }, { i: cutShape });
const SPOT_PLACE = object({ k: oneOf("place") }, { i: cutShape });
const PHOTO_PLACE = object({ k: oneOf("photo") }, { i: cutShape });

type ChatPlace = Of<typeof CHAT_PLACE>;
type RowPlace = Of<typeof ROW_PLACE>;
type DaysPlace = Of<typeof DAYS_PLACE>;
type BriefPlace = Of<typeof BRIEF_PLACE>;
type WindowPlace = Of<typeof WINDOW_PLACE>;
type RunEnd = Of<typeof RUN_END>;
type Run = Of<typeof RUN>;
type ScreenPlace = Of<typeof SCREEN_PLACE>;
type RecordPlace = Of<typeof RECORD_PLACE>;
type LinePlace = Of<typeof LINE_PLACE>;
type PeoplePlace = Of<typeof PEOPLE_PLACE>;
type SpotPlace = Of<typeof SPOT_PLACE>;
type PhotoPlace = Of<typeof PHOTO_PLACE>;
type Place = ChatPlace | RowPlace | DaysPlace | BriefPlace | WindowPlace | ScreenPlace | RecordPlace | LinePlace | PeoplePlace | SpotPlace | PhotoPlace;
type Kind = Place["k"];
type PlaceOf<K extends Kind> = Extract<Place, { k: K }>;

type Args = Omit<ReadParams, "cursor">;

type Detail = "lines" | "brief" | "raw";

type Entry = ReadOne | Extract<ReadAnswer, { what: "lines" | "brief" | "raw" | "screen" }>;

const NEXT_ALWAYS: ReadonlySet<string> = new Set(["chat", "row", "window", "lines", "raw", "brief", "screen"]);

interface Opened<K extends Kind> {
  entry: Entry;
  next: PlaceOf<K> | null;
}

interface Opener<K extends Kind, A> {
  readonly place: Shape<PlaceOf<K>>;
  readonly binds: readonly (keyof Bound)[];
  address(args: Args, place: PlaceOf<K>, reader: Reader): A;
  open(address: A, place: PlaceOf<K> | undefined, reader: Reader): Opened<K>;
}

function oneRef<K extends keyof RefParts>(args: Args, kind: K): { parts: RefParts[K]; given: string } {
  if (typeof args.ref !== "string") return refused("BAD_PARAMETER", "`cursor` is not a next this route gave.");
  return { parts: readRef(args.ref, "ref", [kind]).parts as RefParts[K], given: args.ref };
}

interface PeopleAddress {
  id: string;
  chat: boolean;
  given: string;
  args: Args;
  match?: PeopleMatch;
}

function peopleAddress(args: Args): PeopleAddress {
  if (typeof args.ref !== "string") return refused("BAD_PARAMETER", "`cursor` is not a next this route gave.");
  const ref = readRef(args.ref, "ref", ["person", "chat"]);
  return ref.kind === "person" ? { id: ref.parts.handle, chat: false, given: args.ref, args } : { id: ref.parts.key, chat: true, given: args.ref, args };
}

const OPENERS: { [K in Kind]: Opener<K, unknown> } = {
  chat: {
    place: CHAT_PLACE, binds: ["index"],
    address: (_args, place, reader) => ({ chat: reader.chat(place.c) }),
    open: (address, place, reader) => {
      const { chat, from } = address as ChatAddress;
      return reader.chatPage(chat, place ?? { k: "chat", c: chat.key, e: dayBounds(chat.last, reader.clock()).end_ms, d: chat.first }, from);
    },
  },
  row: {
    place: ROW_PLACE, binds: ["index", "facts"],
    address: (args) => oneRef(args, "row"),
    open: (row, place, reader) => reader.row((row as { parts: RefParts["row"]; given: string }).parts, (row as { given: string }).given, place),
  },
  days: {
    place: DAYS_PLACE, binds: ["index"],
    address: (args, _place, reader) => {
      const stretch = stretchOf(args, reader.clock());
      return { stretch, detail: detailOf(args, stretch) };
    },
    open: (address, place, reader) => {
      const { stretch, detail } = address as { stretch: Stretch; detail: "lines" | "raw" };
      return reader.days(stretch, detail, place ?? { k: "days", d: stretch.from });
    },
  },
  brief: {
    place: BRIEF_PLACE, binds: [],
    address: (args, _place, reader) => stretchOf(args, reader.clock()),
    open: (stretch, place, reader) => reader.brief(stretch as Stretch, place ?? { k: "brief", d: (stretch as Stretch).from, l: 0, v: "" }),
  },
  window: {
    place: WINDOW_PLACE, binds: ["screen"],
    address: (args) => oneRef(args, "window"),
    open: (window, place, reader) => reader.window((window as { parts: RefParts["window"] }).parts, (window as { given: string }).given, place),
  },
  screen: {
    place: SCREEN_PLACE, binds: ["screen"],
    address: (args, _place, reader) => stretchOf(args, reader.clock()),
    open: (stretch, place, reader) => reader.screenText(stretch as Stretch, place),
  },
  record: {
    place: RECORD_PLACE, binds: ["resolved"],
    address: (args) => ({ ...oneRef(args, "record"), history: args.history === 1 }),
    open: (address, place, reader) => {
      const { parts, given, history } = address as { parts: RecordRef; given: string; history: boolean };
      return reader.wholePage(parts, given, history, place ?? { k: "record" });
    },
  },
  line: {
    place: LINE_PLACE, binds: [],
    address: (args) => oneRef(args, "line"),
    open: (line, place, reader) => reader.line((line as { parts: RefParts["line"] }).parts, (line as { given: string }).given, place),
  },
  people: {
    place: PEOPLE_PLACE, binds: [],
    address: (args) => peopleAddress(args),
    open: (address, place, reader) => reader.people(address as PeopleAddress, place),
  },
  place: {
    place: SPOT_PLACE, binds: [],
    address: (args) => oneRef(args, "place"),
    open: (spot, place, reader) => reader.place((spot as { parts: RefParts["place"] }).parts.id, (spot as { given: string }).given, place),
  },
  photo: {
    place: PHOTO_PLACE, binds: [],
    address: (args) => ({ given: typeof args.ref === "string" ? args.ref : refused("BAD_PARAMETER", "`cursor` is not a next this route gave.") }),
    open: (address, place, reader) => reader.photoPage(address as { given: string; photo?: HeldPhoto }, place),
  },
};

const PLACE: Shape<Place> = tagged("k", Object.fromEntries(Object.entries(OPENERS).map(([kind, opener]) => [kind, opener.place])) as { [K in Kind]: Shape<PlaceOf<K>> });

function placeFrom(bytes: Buffer): Place {
  try {
    return PLACE.parse(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ContractError) throw new CursorError("is not a next this route gave");
    throw error;
  }
}

function nextMost(args: Args, room: Room): number {
  const chars = Math.ceil(((aroundBytes(Buffer.byteLength(canonical(args as unknown as Json), "utf8")) + PLACE_BYTES) * 4) / 3);
  return room.measure({ next: "x".repeat(Math.min(NEXT_CHARS, chars)) }) - 1;
}

export function readAnswerOf(asked: ReadParams, sources: ReadSources): ReadAnswer {
  return new Reader(sources).answer(asked);
}

export function refFailure(error: Refusal, first: boolean): "gone" | "unopened" {
  if (error.status === 503 || error.code === "TOO_BROAD") {
    if (first) throw error;
    return "unopened";
  }
  if (error.code === "LINE_MOVED" || error.code === "BAD_PARAMETER" || error.code === "OUTSIDE_ACCESS") return "gone";
  throw error;
}

export function servedRefOf(sources: ReadSources): ServedRef {
  const reader = new Reader(sources);
  return (given) => reader.serves(given);
}

export function describedOf(asked: DescribeParams, sources: ReadSources): DescribeAnswer {
  const refs = typeof asked.ref === "string" ? [asked.ref] : asked.ref;
  const reader = new Reader(sources);
  const described: Citation[] = [];
  for (const [n, given] of refs.entries()) {
    try {
      described.push(reader.describe(given));
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      if (refFailure(error, described.length === 0) === "unopened") return { described, unopened: refs.slice(n) };
      described.push(gone(given, error.words));
    }
  }
  return { described };
}

const gone = (ref: string, why: string): Citation => ({ ref, kind: "gone", why });

const clipped = (text: string): string => text.replace(/\s+/gu, " ").trim().slice(0, TITLE_CHARS);

const detailOf = (asked: Args, stretch: Stretch): Detail => asked.detail ?? (stretch.whole && addDays(stretch.from, 2) <= stretch.to ? "brief" : "lines");

function readAgain(stretch: Stretch, detail: Detail): string {
  const said = [
    `\`from\` ${stretch.stated.from}`, `\`to\` ${stretch.stated.to}`, `\`detail\` ${detail}`,
    ...(stretch.families === null ? [] : [`\`families\` [${stretch.families.join(", ")}]`]),
    ...(stretch.products === null ? [] : [`\`products\` [${stretch.products.join(", ")}]`]),
  ];
  return `read again with ${said.slice(0, -1).join(", ")} and ${said.at(-1)}`;
}

function resolvedArgs(asked: ReadParams, now_ms: number, zone: string): Args {
  const { cursor: _cursor, last, ...rest } = asked;
  if (last === undefined) return rest;
  const to_ms = Math.ceil(now_ms / MINUTE) * MINUTE;
  return {
    ...rest, from: instantIn(to_ms - lastMs(last), zone), to: instantIn(to_ms, zone),
    ...(rest.chat === undefined && rest.detail === undefined ? { detail: "brief" as const } : {}),
  };
}

interface Timed {
  t: number;
  line: Line;
}

interface Chat {
  key: string;
  ai: boolean;
  title: string | null;
  first: string;
  last: string;
  linesOn(day: string): Timed[];
}

interface ChatAddress {
  chat: Chat;
  from?: string;
}

interface Resumed {
  at: number;
  exact: boolean;
}

function resume(items: readonly { t: number; id: string }[], place: { r?: string | undefined; a?: number | undefined; q?: number | undefined }): Resumed {
  if (place.a === undefined) return { at: 0, exact: false };
  if (place.r !== undefined) {
    const found = items.findIndex((item) => item.id === place.r && item.t === place.a);
    if (found >= 0) return { at: found, exact: true };
  }
  let given = 0;
  for (const [at, item] of items.entries()) {
    if (item.t > place.a) return { at, exact: false };
    if (item.t === place.a && given++ === (place.q ?? 0)) return { at, exact: false };
  }
  return { at: items.length, exact: false };
}

function placedAt(items: readonly { t: number; id: string }[], at: number): { r?: string; a?: number; q?: number } {
  const item = items[at];
  const last = items.at(-1);
  if (item === undefined) return last === undefined ? {} : { a: last.t, q: items.filter((each) => each.t === last.t).length };
  return { r: item.id, a: item.t, q: items.slice(0, at).filter((each) => each.t === item.t).length };
}

const chatItems = (lines: readonly Timed[]): { t: number; id: string }[] => lines.map((line) => ({ t: line.t, id: digestOf(line.line.ref ?? line.line.text) }));

class Reader {
  #pictures = 0;
  #factsBuilt: true | undefined;
  readonly room: Room;
  #screenSource: ScreenSource | undefined;
  #sittings: MachineSittings | undefined;
  readonly #screenUnits = new Map<string, ReadonlyMap<string, number>>();
  #screenBusy = false;
  readonly #unscreened = new Set<string>();
  readonly #windows = new Map<string, DayWindows | null>();
  readonly #documents = new Map<string, DayDocument | null>();

  constructor(readonly sources: ReadSources) {
    this.room = new Room(readRoom(sources.call.reader, sources.call.answerChars), readSize(sources.call.reader));
  }

  get call(): Call {
    return this.sources.call;
  }

  clock(): DaySettings {
    return this.call.clock();
  }

  at(ms: number, dated = false): string | undefined {
    return at(ms, dated, this.call.whereIfReady(), this.clock());
  }

  screenAt(ms: number): string {
    return at(ms, false, this.call.whereIfReady(), this.screen().clock)!;
  }

  get #gated(): boolean {
    return this.call.gate !== undefined;
  }

  #chatSpan(key: string): { first: string; last: string } | null {
    const span = chatSpanOf(this.call, key);
    if (span === "capped" && this.#gated) tooBroad();
    if (span === null && this.#gated) outsideAccess();
    return span === "capped" ? null : span;
  }

  #servesRecord(record: Pick<RecordRef, "source">, start_ms: number | null): boolean {
    return !this.#gated || this.call.servesRecord(record, start_ms);
  }

  #servesScreen(machine: string, at_ms: number): boolean {
    return !this.#gated || this.call.servesScreen(machine, at_ms);
  }

  #lineServed(read: FactsRead, atom: AtomRow): boolean {
    if (!this.#gated) return true;
    if (this.#factsBuilt === undefined) {
      notBuilding(this.call.index());
      this.#factsBuilt = true;
    }
    const accounts = lineAccountsOf(read.point<{ accounts: string }>(LINE_ACCOUNTS, [atom.day, atom.n])?.accounts, atom.source);
    return this.call.judge(accounts === null ? null : { accounts, start_ms: atom.start_ms }, true);
  }


  answer(asked: ReadParams): ReadAnswer {
    let answer: ReadAnswer;
    try {
      answer = this.#answer(asked);
    } catch (error) {
      if (error instanceof NoRoom) throw new Error("a page's own members are past its reader's size");
      throw error;
    }
    const size = this.room.measure(answer);
    if (size > this.room.size) throw new Error(`a read answered ${size} characters, past its reader's ${this.room.size}`);
    const kept = this.#gated ? this.call.keptOut() : undefined;
    if (kept === undefined) return answer;
    this.call.log.withheld = kept;
    return asked.cursor === undefined && answer.what !== "gone" ? { ...answer, outside: true } : answer;
  }

  #answer(asked: ReadParams): ReadAnswer {
    if (asked.cursor !== undefined) return this.#goOn(asked);
    const args = resolvedArgs(asked, this.call.now_ms, this.clock().zone);
    if (asked.ref !== undefined) {
      const refs = typeof asked.ref === "string" ? [asked.ref] : asked.ref;
      return refs.length === 1 ? this.ref(refs[0]!, asked.history === 1, args) : this.#refs(refs, asked.history === 1);
    }
    if (args.chat !== undefined) return this.#chatRead(readRef(args.chat, "chat", ["chat"]).parts.key, args.from, args.to, args);
    const unknown = args.products?.find((product) => !this.sources.isProduct(product) && productWindows([product]) === undefined);
    if (unknown !== undefined) refused("BAD_PARAMETER", `\`products\` names ${unknown}, a product this home does not know`);
    const stretch = stretchOf(args, this.clock());
    const detail = detailOf(args, stretch);
    const screen = detail === "raw" && stretch.families?.includes("screen") === true;
    if (screen && stretch.families!.length > 1) refused("BAD_PARAMETER", "the screen's text is read alone: `families` screen, with `detail` raw");
    const freshness = asked.last === undefined ? undefined : this.#freshness(stretch);
    if (freshness !== undefined) this.room.state({ freshness });
    const entry = screen ? this.page("screen", stretch, undefined, args)
      : detail === "brief" ? this.page("brief", stretch, undefined, args) : this.page("days", { stretch, detail }, undefined, args);
    return (freshness === undefined ? entry : { ...entry, freshness }) as ReadAnswer;
  }

  #freshness(stretch: Stretch): string | undefined {
    const served = (source: string, at_ms: number): boolean => !this.#gated || this.call.quietly(() => this.call.serves([accountOf(source)], at_ms));
    const counted = this.sources.freshness().filter((source) => source.road !== "owner"
      && source.families.some((family) => stretch.families === null || stretch.families.includes(familyOf(family)))
      && (stretch.products === null || stretch.products.includes(source.product))
      && served(source.id, stretch.to_ms))
      .map((source) => (source.item_ms !== null && served(source.id, source.item_ms) ? source : { ...source, item_ms: null, item_dated: false }))
      .filter((source) => source.road !== "upload" || (source.item_ms !== null && source.item_ms >= stretch.from_ms && source.item_ms < stretch.to_ms));
    return freshnessWords(counted, { now_ms: this.call.now_ms, clock: this.clock() });
  }

  #document(day: string): DayDocument | undefined {
    if (!this.#documents.has(day)) this.#documents.set(day, this.sources.dayDocument(day) ?? null);
    return this.#documents.get(day) ?? undefined;
  }

  page<K extends Kind>(kind: K, address: unknown, place: PlaceOf<K> | undefined, args: Args): Entry {
    const opener = OPENERS[kind] as Opener<K, unknown>;
    const held = this.room.hold(nextMost(args, this.room));
    const { entry, next } = opener.open(address, place, this);
    const out = next === null
      ? (NEXT_ALWAYS.has(entry.what) ? { ...entry, next: null } : entry)
      : { ...entry, next: sealed("read", Buffer.from(canonical(next as unknown as Json), "utf8"), args, this.#bound(opener.binds, args)) };
    this.room.settle(held, "next" in out ? { next: out.next } : undefined);
    return out as Entry;
  }

  nested<T>(open: () => T): T | undefined {
    const mark = this.room.mark();
    const end = this.room.begin(true);
    try {
      return open();
    } catch (error) {
      if (!(error instanceof NoRoom)) throw error;
      this.room.back(mark);
      return undefined;
    } finally {
      end();
    }
  }

  #gone<K extends Kind>(given: string, why: string): Opened<K> {
    const entry = { what: "gone" as const, ref: given, why };
    this.room.state(entry);
    return { entry, next: null };
  }

  #bound(binds: readonly (keyof Bound)[], args: Args): Bound {
    const now = this.#current(args);
    return Object.fromEntries(binds.map((member) => [member, now[member]!()]));
  }

  #current(args: Args): Current {
    return {
      index: () => this.call.index().file, facts: () => this.call.index().factsBuild, screen: () => this.screen().file,
      resolved: () => {
        const record = typeof args.ref === "string" ? readRef(args.ref, "ref", ["record"]).parts : undefined;
        return resolvedOf(record === undefined ? null : this.call.view().head(record)?.version ?? null);
      },
    };
  }

  #goOn(asked: ReadParams): ReadAnswer {
    const held = openedCursor(asked.cursor!, ["read"], resolvedArgs(asked, this.call.now_ms, this.clock().zone));
    let place: Place;
    try {
      place = placeFrom(held.place.rest());
    } catch (error) {
      if (error instanceof CursorError) return refused("BAD_PARAMETER", "`cursor` is not a next this route gave.");
      throw error;
    }
    const args = held.params;
    held.check(this.#current(args));
    const opener = OPENERS[place.k] as Opener<Kind, unknown>;
    return this.page(place.k, opener.address(args, place, this), place, args) as ReadAnswer;
  }

  #refs(refs: readonly string[], history: boolean): ReadAnswer {
    this.room.state({ what: "refs", opened: [] });
    const unopenedFrom = (n: number) => this.room.measure({ unopened: refs.slice(n) });
    let owed = this.room.hold(unopenedFrom(1));
    const opened: ReadOne[] = [];
    let unopened: string[] = [];
    for (const [n, given] of refs.entries()) {
      if (n > 0) {
        const freed = unopenedFrom(n) - unopenedFrom(n + 1);
        this.room.settle(freed, undefined);
        owed -= freed;
      }
      const mark = this.room.mark();
      const end = this.room.begin(n === 0);
      let one: ReadOne;
      try {
        this.room.hold(3);
        one = this.ref(given, history, { ref: given, ...(history ? { history: 1 as const } : {}) });
      } catch (error) {
        this.room.back(mark);
        if (error instanceof NoRoom && n > 0) {
          unopened = refs.slice(n);
          break;
        }
        if (!(error instanceof Refusal)) throw error;
        if (refFailure(error, opened.length === 0) === "unopened") {
          unopened = refs.slice(n);
          break;
        }
        one = { what: "gone", ref: given, why: error.words };
        try {
          this.room.hold(this.room.measure(one) + 1);
        } catch (full) {
          if (!(full instanceof NoRoom) || n === 0) throw full;
          this.room.back(mark);
          unopened = refs.slice(n);
          break;
        }
      } finally {
        end();
      }
      opened.push(one);
    }
    this.room.settle(owed, unopened.length === 0 ? undefined : { unopened });
    return { what: "refs", opened, ...(unopened.length === 0 ? {} : { unopened }) };
  }

  ref(given: string, history: boolean, args: Args): ReadOne {
    const ref = readRef(given, "ref");
    switch (ref.kind) {
      case "record": return this.#record(ref.parts, given, history, args);
      case "line": return this.page("line", { parts: ref.parts, given }, undefined, args) as ReadOne;
      case "row": return this.page("row", { parts: ref.parts, given }, undefined, args) as ReadOne;
      case "person": return this.page("people", { id: ref.parts.handle, chat: false, given, args } satisfies PeopleAddress, undefined, args) as ReadOne;
      case "chat": {
        const match = peopleOne(this.call, ref.parts.key, true);
        if (match === undefined) return this.#latest(this.chat(ref.parts.key), args);
        return this.page("people", { id: ref.parts.key, chat: true, given, args, match } satisfies PeopleAddress, undefined, args) as ReadOne;
      }
      case "place": return this.page("place", { parts: ref.parts, given }, undefined, args) as ReadOne;
      case "picture": return this.page("photo", { given }, undefined, args) as ReadOne;
      case "window": return this.page("window", { parts: ref.parts, given }, undefined, args) as ReadOne;
    }
  }


  #chatRead(key: string, from: string | undefined, to: string | undefined, args: Args): ReadAnswer {
    const chat = this.chat(key);
    if (from === undefined && to === undefined) return (chat.ai ? this.page("chat", { chat }, undefined, args) : this.#latest(chat, args)) as ReadAnswer;
    const range = rangeOf({ ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) }, this.clock(), { first: chat.first, last: chat.last });
    const lines = chat.linesOn(range.from);
    const s = lines.findIndex((line) => line.t >= range.from_ms);
    const address: ChatAddress = range.whole ? { chat } : { chat, from: range.stated.from };
    return this.page("chat", address, { k: "chat", c: chat.key, e: range.to_ms, d: range.from, ...placedAt(chatItems(lines), s < 0 ? lines.length : s) }, args) as ReadAnswer;
  }

  chat(key: string): Chat {
    return this.sources.isAiChat(key) ? this.#aiChat(key) : this.#messagesChat(key);
  }

  #chatOfMessage(record: RecordRef, start_ms: number | null): string | undefined {
    if (start_ms === null) return undefined;
    const view = this.call.view();
    const day = civilDay(start_ms, this.clock());
    for (let after: string | null = null; ;) {
      const rows = view.extractPage(MESSAGES_FAMILY, { day }, after === null ? null : { unit: after, start_ms: null }, CHATS_A_PAGE);
      for (const row of rows) {
        const messages = (row.content as { messages?: { source: string; key: string }[] } | null)?.messages ?? [];
        if (!messages.some((message) => message.key === record.key)) continue;
        const { network, chat } = parseMessagesUnit(row.unit);
        return `${network}:${resolveChat(this.call.networks, network, chat, this.call.labels())}`;
      }
      if (rows.length < CHATS_A_PAGE) return undefined;
      after = rows.at(-1)!.unit;
    }
  }

  #messagesChat(asked: string): Chat {
    const { sources, call } = this;
    const key = call.chat(asked);
    const colon = key.indexOf(":");
    const network = key.slice(0, colon), chat = key.slice(colon + 1);
    const keys = sources.chatKeys(network, chat);
    const span = this.#chatSpan(key);
    const today = civilDay(call.now_ms, this.clock());
    const { first, last } = span ?? { first: today, last: today };
    const days = new Map<string, Timed[]>();
    let title: string | null = null;
    return {
      key, ai: false, first, last,
      get title() {
        return title;
      },
      linesOn: (day) => {
        const held = days.get(day);
        if (held !== undefined) return held;
        const read = sources.chatDay(network, chat, keys, day);
        title ??= read.title;
        const lines = read.messages.flatMap((message): Timed[] => {
          if (!this.call.quietly(() => this.#servesRecord(message, message.at))) return [];
          const atom = read.atoms.find((each) => each.record?.source === message.source && each.record.key === message.key);
          if (atom === undefined) return [];
          const said = spoken(atom);
          const line: Line = {
            ref: makeRef("record", { source: message.source, kind: atom.record!.kind, key: message.key }), at: this.at(message.at)!, day,
            ...(said.from === undefined ? {} : { from: said.from }), text: said.text,
          };
          return [line, ...imagesOf(message).map((image) => this.pictureLine(image, line))].map((each) => ({ t: message.at, line: each }));
        });
        days.set(day, lines);
        return lines;
      },
    };
  }

  #aiChat(key: string): Chat {
    const view = this.call.view(), settings = this.clock();
    const byDay = new Map<string, { k: string; timed: Timed }[]>();
    let title: string | null = null;
    let provider: string | null = null;
    const source = key.slice(0, key.indexOf("/"));
    const units = aiDays(this.call, key);
    const seen = new Set<string>();
    let withheld = false;
    for (const unit of units) {
      const content = view.extract(AI_FAMILY, unit)?.content as unknown as ConversationDay | undefined;
      if (content === undefined) continue;
      title = content.title ?? title;
      provider ??= content.provider;
      for (const turn of content.turns) {
        if (seen.has(turn.key)) continue;
        seen.add(turn.key);
        if (!this.#servesRecord({ source: turn.source ?? source }, turn.at_ms)) {
          withheld = true;
          continue;
        }
        const day = civilDay(turn.at_ms, settings);
        const extra = [...turn.attachments.map((file) => `[file: ${file.name}]`), ...(turn.images > 0 ? [`[${turn.images} ${turn.images === 1 ? "image" : "images"}]`] : [])];
        const line: Line = {
          ref: makeRef("record", { source: turn.source ?? source, kind: "msg", key: turn.key }), at: this.at(turn.at_ms)!, day,
          from: turn.role === "user" ? YOU : this.sources.productName(provider ?? ""), text: [turn.words, ...extra].filter((part) => part.trim() !== "").join("\n") || "[empty turn]",
        };
        const held = byDay.get(day);
        if (held === undefined) byDay.set(day, [{ k: turn.key, timed: { t: turn.at_ms, line } }]);
        else held.push({ k: turn.key, timed: { t: turn.at_ms, line } });
      }
    }
    const lines = new Map([...byDay].map(([day, turns]) => [day, turns.sort((left, right) => left.timed.t - right.timed.t || (left.k < right.k ? -1 : 1)).map((turn) => turn.timed)]));
    const days = [...lines.keys()].sort();
    if (days.length === 0 && withheld) outsideAccess();
    if (days.length === 0) refused("BAD_PARAMETER", "`chat` names a conversation that holds no turn now");
    return { key, ai: true, title, first: days[0]!, last: days.at(-1)!, linesOn: (day) => lines.get(day) ?? [] };
  }

  #latest(chat: Chat, args: Args): Extract<ReadOne, { what: "chat" }> {
    const end = dayBounds(chat.last, this.clock()).end_ms;
    return this.page("chat", { chat }, this.#back(chat, { d: chat.last, s: Infinity }, chat.first, end, 1), args) as Extract<ReadOne, { what: "chat" }>;
  }

  #around(chat: Chat, record: RecordRef, given: string, args: Args): Extract<ReadOne, { what: "chat" }> {
    const head = this.call.view().head(record);
    const day = head?.start_ms === null || head === undefined ? chat.last : civilDay(head.start_ms, this.clock());
    const first = day < chat.first ? day : chat.first, last = day > chat.last ? day : chat.last;
    const ref = makeRef("record", record);
    const at = chat.linesOn(day).findIndex((line) => line.line.ref === ref);
    const start = this.#back(chat, { d: day, s: at < 0 ? 0 : at + 1 }, first, dayBounds(last, this.clock()).end_ms, 2, AROUND_DAYS);
    this.room.state({ around: given });
    return { ...this.page("chat", { chat }, start, args) as Extract<ReadOne, { what: "chat" }>, around: given };
  }

  #back(chat: Chat, end: { d: string; s: number }, first: string, e: number, share: number, days = PAGE_DAYS): ChatPlace {
    let lines = 0, chars = 0, held = 0;
    const room = this.room.left - FRESH_CHARS;
    const placed = (d: string, s: number): ChatPlace => ({ k: "chat", c: chat.key, e, d, ...placedAt(chatItems(chat.linesOn(d)), s) });
    let start = placed(end.d, Math.min(end.s, chat.linesOn(end.d).length));
    for (let day = end.d; day >= first; day = addDays(day, -1)) {
      const all = chat.linesOn(day);
      const upTo = day === end.d ? Math.min(end.s, all.length) : all.length;
      if (upTo === 0) continue;
      if (held === days) break;
      held++;
      let s = upTo;
      while (s > 0) {
        const line = all[s - 1]!.line;
        const size = this.room.measure(line) + 1;
        if ((lines + 1) * share > PAGE_LINES || (chars + size) * share > room) {
          if (lines === 0) s--;
          return placed(day, s);
        }
        lines++;
        chars += size;
        s--;
      }
      start = placed(day, 0);
    }
    return start;
  }

  chatPage(chat: Chat, place: ChatPlace, stated?: string): Opened<"chat"> {
    const lines: Line[] = [];
    let days = 0;
    let from: string | null = null, to: string | null = null;
    const last = civilDay(place.e - 1, this.clock());
    chat.linesOn(place.d);
    const title = chat.title ?? chat.key;
    this.room.state({ what: "chat", chat: makeRef("chat", { key: chat.key }), title, lines: [] });
    const span = this.room.hold(SPAN_CHARS);
    const next = (d: string, all: readonly Timed[], s: number, i?: Cut): ChatPlace => ({ k: "chat", c: chat.key, e: place.e, d, ...placedAt(chatItems(all), s), ...(i === undefined ? {} : { i }) });
    let stop: ChatPlace | null = null;
    walk: for (let day = place.d; day <= last; day = addDays(day, 1)) {
      const all = chat.linesOn(day).filter((line) => line.t < place.e);
      const begin = day === place.d ? resume(chatItems(all), place) : { at: 0, exact: false };
      if (begin.at >= all.length) continue;
      if (days === PAGE_DAYS) {
        stop = next(day, all, begin.at);
        break;
      }
      days++;
      for (let at = begin.at; at < all.length; at++) {
        if (lines.length === PAGE_LINES) {
          stop = next(day, all, at);
          break walk;
        }
        const inside = day === place.d && at === begin.at && begin.exact ? place.i : undefined;
        const got = this.room.admit(all[at]!.line, { from: inside, keep: LINE_KEEP });
        if (got === null) {
          stop = next(day, all, at);
          break walk;
        }
        lines.push(got.piece);
        from ??= day;
        to = day;
        if (got.to !== null) {
          stop = next(day, all, at, got.to);
          break walk;
        }
      }
    }
    const spanned = { from: stated ?? from ?? place.d, to: to ?? last };
    this.room.settle(span, { span: spanned });
    return { entry: { what: "chat", chat: makeRef("chat", { key: chat.key }), title, span: spanned, lines }, next: stop };
  }


  days(stretch: Stretch, detail: "lines" | "raw", place: DaysPlace): Opened<"days"> {
    const meter = this.call.meter.inner(STRETCH_ROWS);
    return this.call.index().facts((read) => {
      this.room.state({ what: detail, [detail === "lines" ? "lines" : "records"]: [] });
      const span = this.room.hold(SPAN_CHARS), freshHeld = this.room.hold(FRESH_CHARS);
      const lines: Line[] = [];
      const records: Extract<ReadOne, { what: "record" }>[] = [];
      let days = 0;
      let counted: string | null = null, last: string | null = null;
      let next: DaysPlace | null = null;
      let readTo: AtomRead | undefined;
      const windowed = detail === "lines";
      const closing = place.a === undefined && place.w !== undefined;
      let resumed: { w: number; g: string | undefined } | undefined = !closing && place.a !== undefined && place.x === undefined && place.w !== undefined ? { w: place.w, g: place.g } : undefined;
      let due = place.d;
      const after = (step: AtomRead | undefined): DaysPlace => (step === undefined ? place : daysPlace(step, true));
      const entered = (day: string): boolean => {
        if (day === counted) return true;
        if (days === PAGE_DAYS) return false;
        days++;
        counted = day;
        return true;
      };
      const expired = (): never => refused("CURSOR_EXPIRED", `the screen's windows moved since this page was given: ${readAgain(stretch, "lines")}`);
      const moved = (group: readonly Line[], from: { w: number; g: string | undefined; i?: Cut | undefined }): void => {
        if ((from.w > 0 || from.i !== undefined) && from.g !== groupDigest(group)) expired();
      };
      const admitted = (group: readonly Line[], from: number, cut: Cut | undefined, at: (w: number, i?: Cut) => DaysPlace): DaysPlace | null => {
        for (let w = from; w < group.length; w++) {
          if (lines.length >= PAGE_LINES) return at(w);
          const got = this.room.admit(group[w]!, { from: w === from ? cut : undefined, keep: LINE_KEEP });
          if (got === null) return at(w);
          lines.push(got.piece);
          if (got.to !== null) return at(w, got.to);
        }
        return null;
      };
      const close = (until: string, first?: { w: number; g: string | undefined; i?: Cut | undefined }): DaysPlace | null => {
        if (!windowed) return null;
        for (; due < until && due <= stretch.to; due = addDays(due, 1)) {
          const day = due;
          const group = this.#closingOf(read, day, stretch);
          const from = day === place.d && first !== undefined ? first : { w: 0, g: undefined };
          moved(group, from);
          if (from.w >= group.length) continue;
          const g = groupDigest(group);
          const at = (w: number, i?: Cut): DaysPlace => ({ k: "days", d: day, w, g, ...(i === undefined ? {} : { i }) });
          if (!entered(day)) return at(0);
          const given = lines.length;
          const stop = admitted(group, from.w, from.i, at);
          if (lines.length > given) last = day;
          if (stop !== null) return stop;
        }
        return null;
      };
      walk: {
        if (closing) {
          next = close(addDays(place.d, 1), { w: place.w!, g: place.g, i: place.i });
          if (next !== null) break walk;
        }
        for (const step of atomsOf(read, stretch, closing ? { k: "days", d: addDays(place.d, 1) } : place)) {
          if ("stop" in step) {
            const at = readTo === undefined ? step.stop : after(readTo);
            next = close(at.d) ?? at;
            break walk;
          }
          const { atom } = step;
          if (atom.day > due) {
            next = close(atom.day);
            if (next !== null) break walk;
          }
          const sitting = windowed && (stretch.families === null || stretch.families.includes(SCREEN_FAMILY)) ? this.#sittingWindows(read, atom, stretch) : undefined;
          const from = resumed;
          resumed = undefined;
          if (sitting !== undefined) {
            const group = this.#windowGroup(atom.day, sitting, this.#windowsOn(atom.day, stretch)!.mac);
            moved(group, { w: from?.w ?? 0, g: from?.g, i: step.from });
            if (group.length === 0 || (from?.w ?? 0) >= group.length) {
              readTo = step;
              continue;
            }
            if (!entered(atom.day)) {
              next = daysPlace(step, false);
              break walk;
            }
            const g = groupDigest(group), given = lines.length;
            const stop = admitted(group, from?.w ?? 0, step.from, (w, i) => ({ ...daysPlace(step, false, i), w, g }));
            if (lines.length > given) last = atom.day;
            if (stop !== null) {
              next = stop;
              break walk;
            }
            readTo = step;
            continue;
          }
          if (from !== undefined) expired();
          if (!rowKept(atom, stretch, read) || !this.#lineServed(read, atom)) {
            readTo = step;
            continue;
          }
          if (!entered(atom.day)) {
            next = daysPlace(step, false);
            break walk;
          }
          if (detail === "lines") {
            const line = this.dayLine(atom, step.m());
            const group = [line, ...this.#picturesOf(atom).map((image) => this.pictureLine(image, line))];
            if (lines.length > 0 && lines.length + group.length > PAGE_LINES) {
              next = daysPlace(step, false);
              break walk;
            }
            const got = this.room.admit(group, { from: step.from, keep: LINE_KEEP });
            if (got === null) {
              next = daysPlace(step, false);
              break walk;
            }
            lines.push(...got.piece);
            if (got.to !== null) {
              next = daysPlace(step, false, got.to);
              last = atom.day;
              break walk;
            }
          } else {
            const record = recordOf(atom);
            const ref = record === undefined ? undefined : makeRef("record", record);
            const head = record === undefined ? undefined : this.call.view().head(record);
            if (record === undefined || ref === undefined || head === undefined || head.version === GONE || !this.#servesRecord(record, head.start_ms) || (step.from === undefined && !firstPrinted(read, atom, stretch, meter))) {
              readTo = step;
              continue;
            }
            if (records.length >= RAW_RECORDS) {
              next = daysPlace(step, false);
              break walk;
            }
            const got = this.room.admit(this.#whole(record, ref, atom.day), { from: step.from, keep: RECORD_KEEP, need: ["text"] });
            if (got === null) {
              next = daysPlace(step, false);
              break walk;
            }
            records.push(got.piece);
            if (got.to !== null) {
              next = daysPlace(step, false, got.to);
              last = atom.day;
              break walk;
            }
          }
          readTo = step;
          last = atom.day;
        }
        next = close(addDays(stretch.to, 1));
      }
      const begun = place.a === undefined && place.w === undefined && place.d === stretch.from;
      const spanned = { from: begun ? stretch.stated.from : place.d, to: next === null ? stretch.stated.to : last ?? place.d };
      const page = freshMembers(this.#stretchFresh(place.d, next === null ? stretch.to : next.d, meter));
      this.room.settle(span, { span: spanned });
      this.room.settle(freshHeld, page);
      return { entry: detail === "lines" ? { what: "lines", span: spanned, lines, ...page } : { what: "raw", span: spanned, records, ...page }, next };
    }, meter);
  }

  #fresh(from: string, to: string, meter = this.call.meter): Fresh | undefined {
    const index = this.call.index();
    return this.call.fresh(index.seq, index.held(from, to, meter));
  }

  #stretchFresh(from: string, to: string, meter = this.call.meter): Fresh | undefined {
    const fresh = this.#fresh(from, to, meter);
    const held = new Set(fresh?.pending.map((each) => each.day));
    const unscreened = [...this.#unscreened].filter((day) => day >= from && day <= to && !held.has(day));
    if (unscreened.length === 0) return fresh;
    const pending = [...fresh?.pending ?? [], ...unscreened.map((day) => ({ day, why: "new" as const }))].sort((left, right) => (left.day < right.day ? 1 : -1));
    return { as_of: null, ...fresh, pending };
  }

  dayLine(atom: AtomRow, m: number): Line {
    const record = recordOf(atom);
    return {
      ref: record === undefined ? lineRef(atom, m) : makeRef("record", record),
      ...(atom.start_ms === null || atom.dated === 1 ? {} : { at: this.at(atom.start_ms)! }),
      day: atom.day, family: familyOf(atom.family),
      text: this.#unheld(atom, leads(atom.title, atom.line) ? `${atom.title}: ${atom.line}` : atom.line),
    };
  }

  #unheld(atom: AtomRow, text: string): string {
    if (atom.family !== PHOTOS_FAMILY || atom.item === null || /^photo:[0-9a-f]{64}$/u.test(atom.item)) return text;
    const words = this.sources.unheld({ burst: atom.unit, item: atom.item });
    return words === null ? text : `${text}\n\n${words}`;
  }

  #picturesOf(atom: AtomRow): string[] {
    const photo = /^photo:([0-9a-f]{64})$/u.exec(atom.item ?? "")?.[1];
    if (photo !== undefined) return [`sha256:${photo}`];
    if (atom.pictures === null || atom.family !== MESSAGES_FAMILY || atom.source === null || atom.key === null) return [];
    const content = this.call.view().extract(MESSAGES_FAMILY, atom.unit)?.content as { messages?: MessageFact[] } | null | undefined;
    const message = (content?.messages ?? []).find((each) => each.source === atom.source && each.key === atom.key);
    return message === undefined ? [] : imagesOf(message);
  }

  brief(stretch: Stretch, place: BriefPlace): Opened<"brief"> {
    this.room.state({ what: "brief", days: [] });
    const span = this.room.hold(SPAN_CHARS), freshHeld = this.room.hold(FRESH_CHARS);
    const days: { day: string; lines: Line[] }[] = [];
    let next: BriefPlace | null = null;
    walk: for (let day = place.d; day <= stretch.to; day = addDays(day, 1)) {
      if (days.length === PAGE_DAYS) {
        next = { k: "brief", d: day, l: 0, v: "" };
        break;
      }
      const { lines: all, v } = this.#briefOn(day, stretch);
      const from = day === place.d ? place.l : 0;
      if (from > 0 && v !== place.v) {
        refused("CURSOR_EXPIRED", `that day was written again since this page was given: ${readAgain(stretch, "brief")}`);
      }
      const mark = this.room.mark();
      const lines: Line[] = [];
      try {
        this.room.hold(sizeOf({ day, lines: [] }) + 1);
      } catch (error) {
        if (!(error instanceof NoRoom) || days.length === 0) throw error;
        next = { k: "brief", d: day, l: from, v };
        break;
      }
      for (let l = from; l < all.length; l++) {
        const got = this.room.admit(all[l]!, { from: day === place.d && l === from ? place.i : undefined, need: ["text"] });
        if (got === null) {
          next = { k: "brief", d: day, l, v };
          if (lines.length === 0) this.room.back(mark);
          else days.push({ day, lines });
          break walk;
        }
        lines.push(got.piece);
        if (got.to !== null) {
          next = { k: "brief", d: day, l, v, i: got.to };
          days.push({ day, lines });
          break walk;
        }
      }
      days.push({ day, lines });
    }
    const to = next === null ? stretch.to : days.at(-1)?.day ?? place.d;
    const spanned = { from: place.d === stretch.from && place.l === 0 && place.i === undefined ? stretch.stated.from : place.d, to: next === null ? stretch.stated.to : to };
    const page = freshMembers(this.#stretchFresh(place.d, to));
    this.room.settle(span, { span: spanned });
    this.room.settle(freshHeld, page);
    return { entry: { what: "brief", span: spanned, days, ...page }, next };
  }

  #briefOn(day: string, stretch: Stretch): { lines: Line[]; v: string } {
    const document = this.#document(day);
    const windows = this.#windowsOn(day, stretch);
    const shown = windows === undefined ? [] : [...windows.sittings.values()].flat().concat(windows.tail).sort(byStart).map((window) => this.#briefWindow(window, windows.mac));
    if (document === undefined && shown.length === 0) return { lines: [], v: "" };
    const unsummarised = new Set(windows?.sittings.keys() ?? []);
    const read = document ?? { day, atoms: [], facts: [] };
    const atoms = document === undefined ? new Map<number, { atom: AtomRow; m: number }>() : dayLines(day, document);
    const alone = (record: RecordRef | undefined, rests: boolean) => (record !== undefined && rests ? [accountOf(record.source)] : []);
    const atomServed = (atom: DayAtom) => !this.#gated || this.call.serves(atom.accounts ?? alone(atom.record, atom.units.length === 1), atom.start_ms);
    const factServed = (fact: DayFileFact) => !this.#gated || this.call.serves(fact.from.accounts ?? alone(fact.from.record, fact.from.alone === true), fact.start_ms);
    const told = (atom: DayAtom) => atom.family !== SCREEN_FAMILY || !unsummarised.has(atom.unit);
    const whole = stretch.whole && stretch.families === null && stretch.products === null && !this.#gated && unsummarised.size === 0;
    const cut = whole ? read : {
      ...read,
      atoms: read.atoms.filter((atom) => told(atom) && atomKept(atom, day, stretch) && atomServed(atom)),
      facts: read.facts.filter((fact) => factKept(fact, day, stretch) && factServed(fact)),
    };
    const lines = briefOf(cut, shown).lines.flatMap((line) => {
      const cited = line.atoms.flatMap((n) => atoms.get(n) ?? []);
      const cites = [...new Set([...cited.map(({ atom, m }) => {
        const record = recordOf(atom);
        return record === undefined ? lineRef(atom, m) : makeRef("record", record);
      }), ...line.refs ?? []])];
      if (cites.length === 0) return [];
      return [{ text: line.text, cites: cites.slice(0, CITES_MOST), ...(cites.length > CITES_MOST ? { cites_more: cites.length - CITES_MOST } : {}) }];
    });
    return { lines, v: shown.length === 0 ? document!.inputs : digestOf([document?.inputs ?? "", shown.map((window) => [window.ref, window.text])]) };
  }


  screen(): ScreenSource {
    return this.#screenSource ??= this.sources.screen();
  }

  #screenReady(): ScreenSource | undefined {
    if (this.#screenSource !== undefined || this.#screenBusy) return this.#screenSource;
    const ready = this.sources.screenIfReady();
    if (ready === "busy") this.#screenBusy = true;
    else this.#screenSource = ready;
    return this.#screenSource;
  }

  #windowsOn(day: string, stretch: Stretch): DayWindows | undefined {
    const held = this.#windows.get(day);
    if (held !== undefined) return held ?? undefined;
    const read = this.#windowsRead(day, stretch);
    this.#windows.set(day, read ?? null);
    return read;
  }

  #windowsRead(day: string, stretch: Stretch): DayWindows | undefined {
    const sittings = new Map<string, ScreenWindow[]>();
    const tail: ScreenWindow[] = [];
    if (stretch.families !== null && !stretch.families.includes(SCREEN_FAMILY)) return { sittings, tail, mac: () => null };
    const screen = this.#screenReady();
    if (screen === undefined) {
      if (this.#screenBusy) this.#unscreened.add(day);
      return undefined;
    }
    const bounds = dayBounds(day, this.clock());
    const lo = Math.max(bounds.start_ms, stretch.from_ms), hi = Math.min(bounds.end_ms, stretch.to_ms);
    if (lo >= hi) return { sittings, tail, mac: () => null };
    const wanted = stretch.products === null ? undefined : stretch.products.flatMap((product) => productWindows([product]) ?? []);
    const whole = (machine: string) => wanted === undefined || screen.sources.of(machine).some((source) => stretch.products!.includes(productOf(source)));
    const shownOn = (machine: string) => {
      const all = whole(machine);
      return (window: ScreenWindow) => (all || wanted!.some((row) => row.apps.includes(window.app) || row.sites.includes(window.site))) && this.#servesScreen(window.machine, window.start_ms);
    };
    this.#sittings ??= new MachineSittings(this.call.view(), screen.sources);
    const present = new Set<string>();
    for (const machine of [...screen.sources.machines()].sort()) {
      const shown = shownOn(machine);
      const held = this.#sittings.on(machine, day);
      if (held.some((sitting) => this.#servesScreen(machine, sitting.start_ms))) present.add(machine);
      for (const sitting of held) {
        if (sitting.summarised) continue;
        const from = Math.max(lo, sitting.start_ms), to = Math.min(hi, sitting.end_ms + 1);
        sittings.set(sitting.unit, from < to ? screen.windowsIn(machine, from, to).filter(shown) : []);
      }
      const newest = held.reduce<number | null>((end, sitting) => Math.max(end ?? sitting.end_ms, sitting.end_ms), null);
      const from = Math.max(lo, newest === null ? bounds.start_ms : Math.floor(newest / SEGMENT_MS) * SEGMENT_MS + SEGMENT_MS);
      if (from < hi) {
        const windows = screen.windowsIn(machine, from, hi);
        if (windows.some((window) => this.#servesScreen(machine, window.start_ms))) present.add(machine);
        tail.push(...windows.filter(shown));
      }
    }
    return { sittings, tail: tail.sort(byStart), mac: (machine) => (present.size > 1 ? shownName(this.call.view().tables, machine) : null) };
  }

  #sittingWindows(read: FactsRead, atom: Pick<AtomRow, "family" | "unit" | "day" | "n">, stretch: Stretch): ScreenWindow[] | undefined {
    if (atom.family !== SCREEN_FAMILY) return undefined;
    const windows = this.#windowsOn(atom.day, stretch)?.sittings.get(atom.unit);
    return windows === undefined || this.#screenUnitsOn(read, atom.day).get(atom.unit) === atom.n ? windows : [];
  }

  #screenUnitsOn(read: FactsRead, day: string): ReadonlyMap<string, number> {
    const held = this.#screenUnits.get(day) ?? screenUnitsOn(read, day);
    this.#screenUnits.set(day, held);
    return held;
  }

  #closingOf(read: FactsRead, day: string, stretch: Stretch): Line[] {
    const windows = this.#windowsOn(day, stretch);
    if (windows === undefined) return [];
    const unlisted = [...windows.sittings].filter(([, shown]) => shown.length > 0);
    const listed = unlisted.length === 0 ? new Map<string, number>() : this.#screenUnitsOn(read, day);
    const orphans = unlisted.filter(([unit]) => !listed.has(unit)).flatMap(([, shown]) => shown);
    return this.#windowGroup(day, [...orphans, ...windows.tail].sort(byStart), windows.mac);
  }

  #windowGroup(day: string, windows: readonly ScreenWindow[], mac: DayWindows["mac"]): Line[] {
    const long = windows.filter((window) => window.tenths >= MINUTE_TENTHS);
    const short = windows.filter((window) => window.tenths < MINUTE_TENTHS);
    const lines = long.map((window): Line => ({ ref: windowRef(window), at: this.at(window.start_ms)!, day, family: SCREEN_FAMILY, text: this.#windowText(window, mac) }));
    if (short.length === 0) return lines;
    const cites = short.map(windowRef);
    return [...lines, {
      day, family: SCREEN_FAMILY, text: `${short.length} more window${short.length === 1 ? "" : "s"}, under a minute each`,
      cites: cites.slice(0, CITES_MOST), ...(cites.length > CITES_MOST ? { cites_more: cites.length - CITES_MOST } : {}),
    }];
  }

  #briefWindow(window: ScreenWindow, mac: DayWindows["mac"]): BriefWindow {
    return { text: this.#windowText(window, mac), ref: windowRef(window), tenths: window.tenths };
  }

  #windowText(window: ScreenWindow, mac: DayWindows["mac"]): string {
    const { zone } = this.clock();
    const clock = (ms: number) => instantIn(ms, zone).slice(11, 16);
    const start = clock(window.start_ms), end = clock(window.end_ms);
    const minutes = Math.round(window.tenths / MINUTE_TENTHS);
    const title = window.name !== "" && window.name !== window.app ? `${window.app}, ${window.name}` : window.app;
    const on = mac(window.machine);
    return `${start}${end === start ? "" : `–${end}`}${on === null ? "" : ` on ${on}`}, not summarised yet: ${title}, ${minutes >= 1 ? `${minutes} min` : "under a minute"} on screen`;
  }

  screenText(stretch: Stretch, place: ScreenPlace | undefined): Opened<"screen"> {
    const screen = this.screen();
    if (stretch.to_ms - stretch.from_ms > STRETCH_MS) {
      refused("BAD_PARAMETER", `the screen's text is read ${STRETCH_MS / 60_000} minutes at most a call: give \`from\` and \`to\` that close, or read the day's lines`);
    }
    const { zone } = this.clock();
    const spanned = { from: instantIn(stretch.from_ms, zone), to: instantIn(stretch.to_ms, zone) };
    this.room.state({ what: "screen", span: spanned, lines: [], ...(screen.as_of === null ? {} : { as_of: screen.as_of }) });
    const shown = screen.stretchLines(stretch.from_ms, stretch.to_ms).filter((line) => this.#screenServed(line.t_ms)).map((line) => ({ t_ms: line.t_ms, line: { at: this.screenAt(line.t_ms), app: line.app, title: line.title, text: line.text } }));
    const { taken, next } = screenPage(shown, place, this.room);
    return {
      entry: { what: "screen", span: spanned, lines: taken, ...(screen.as_of === null ? {} : { as_of: screen.as_of }) },
      next: next === null ? null : { k: "screen", ...next },
    };
  }

  #screenServed(at_ms: number): boolean {
    if (!this.#gated) return true;
    const machines = [...this.call.screenAccounts().keys()];
    return machines.length > 0 ? machines.every((machine) => this.#servesScreen(machine, at_ms)) : this.call.serves([], at_ms);
  }

  window(ref: RefParts["window"], given: string, place: WindowPlace | undefined): Opened<"window"> {
    const screen = this.screen();
    const named: WindowNamed = { machine: ref.machine, day: ref.day, app: ref.app, site: ref.site, name: ref.name };
    const segments = screen.segments(named);
    if (segments.length === 0) return this.#gone(given, WINDOW_GONE);
    if (!this.#servesScreen(ref.machine, ref.at_ms ?? segments[0]!)) outsideAccess();
    const day = dayBounds(ref.day, screen.clock);
    const start = place?.s ?? (ref.at_ms === null ? segments[0]! : Math.max(day.start_ms, ref.at_ms - WINDOW_BEFORE_MS));
    const end = Math.min(start + STRETCH_MS, day.end_ms);
    const head = {
      what: "window" as const, ref: given, day: ref.day, app: ref.app, title: ref.name !== "" ? ref.name : ref.app,
      ...(ref.at_ms === null ? {} : { at: this.screenAt(ref.at_ms) }),
    };
    this.room.state({ ...head, lines: [], ...(screen.as_of === null ? {} : { as_of: screen.as_of }) });
    const served = (lines: readonly { t_ms: number; text: string }[]) => lines.filter((line) => this.#servesScreen(ref.machine, line.t_ms)).map((line) => ({ t_ms: line.t_ms, line: { at: this.screenAt(line.t_ms), text: line.text } }));
    const after = segments.find((segment) => segment + SEGMENT_MS > end);
    const later: WindowPlace | null = after === undefined || end >= day.end_ms ? null : { k: "window", s: Math.max(end, after) };
    const entry = (lines: { at: string; text: string }[]): Entry => ({ ...head, lines, ...(screen.as_of === null ? {} : { as_of: screen.as_of }) });
    const taken: { at: string; text: string }[] = [];
    if (place === undefined) {
      const near = screen.windowNear(named, start, end, ref.at_ms);
      if (near === null) return { entry: entry([]), next: later };
      const shown = served(near.lines);
      if (shown.length > 0) {
        const items = itemsOf(shown);
        const ran = (lo: number, hi: number, c?: Cut): WindowPlace => ({ k: "window", s: start, r: { n: near.at, a: runEnd(items, lo), b: runEnd(items, hi), ...(c === undefined ? {} : { c }) } });
        const run = runAround(shown, ref.at_ms);
        for (let at = run.lo; at < run.hi; at++) {
          const got = this.room.admit(shown[at]!.line, { keep: SCREEN_KEEP });
          if (got === null) return { entry: entry(taken), next: ran(run.lo, at) };
          taken.push(got.piece);
          if (got.to !== null) return { entry: entry(taken), next: ran(run.lo, at, got.to) };
        }
        return { entry: entry(taken), next: near.whole && run.lo === 0 && run.hi === shown.length ? later : ran(run.lo, run.hi) };
      }
    }
    let r: Run | undefined = place?.r;
    const read = screen.windowRead(named, start, end, r?.n ?? []);
    const run = new Set<string>();
    if (r !== undefined) {
      const near = served(read.near);
      const items = itemsOf(near);
      const lo = resume(items, endPlace(r.a)).at;
      let hi = Math.max(lo, resume(items, endPlace(r.b)).at);
      if (r.c !== undefined) {
        const cut = resume(items, endPlace(r.b));
        if (cut.exact) {
          const got = this.room.admit(near[cut.at]!.line, { from: r.c, keep: SCREEN_KEEP })!;
          taken.push(got.piece);
          if (got.to !== null) return { entry: entry(taken), next: { ...place!, r: { ...r, c: got.to } } };
          hi = cut.at + 1;
        }
        r = { n: r.n, a: r.a, b: runEnd(items, hi) };
      }
      for (const line of near.slice(lo, hi)) run.add(line.line.text);
    }
    const outside = served(read.all()).filter((line) => !run.has(line.line.text));
    const resumed = place?.t === undefined || place.h === undefined ? undefined : { t: place.t, h: place.h, q: place.q ?? 0, ...(place.i === undefined ? {} : { i: place.i }) };
    const rest = screenPage(outside, resumed, this.room);
    taken.push(...rest.taken);
    return { entry: entry(taken), next: rest.next === null ? later : { k: "window", s: start, ...(r === undefined ? {} : { r }), ...rest.next } };
  }

  #sittingOf(machine: string, t: number): string | undefined {
    this.#sittings ??= new MachineSittings(this.call.view(), this.screen().sources);
    const held = this.#sittings.holding(machine, civilDay(t, this.clock()), t, t)[0];
    return held?.unit;
  }


  #record(ref: RecordRef, given: string, history: boolean, args: Args): ReadOne {
    const view = this.call.view();
    const record = { source: ref.source, kind: ref.kind, key: ref.key };
    const head = view.head(record);
    if (head === undefined || head.version === GONE) return this.#gone<"record">(given, RECORD_GONE).entry as ReadOne;
    if (!this.#servesRecord(record, head.start_ms)) outsideAccess();
    const product = view.source(record.source)?.product;
    if (product !== undefined && this.call.networks.of(product) !== undefined && record.kind === "msg") {
      const found = this.#chatOfMessage(record, head.start_ms);
      if (found !== undefined) return this.#around(this.chat(found), record, given, args);
    }
    const ai = this.sources.aiChatOf(record);
    if (ai !== undefined) return this.#around(this.chat(ai), record, given, args);
    const photo = this.#photoOfRecord(record, head.version);
    if (photo !== undefined) return this.page("photo", { given, photo }, undefined, args) as ReadOne;
    return this.page("record", { parts: record, given, history: history && !this.#gated }, undefined, args) as ReadOne;
  }

  #photoOfRecord(record: RecordRef, version: string): HeldPhoto | undefined {
    if (this.sources.recordOf(record).family !== PHOTOS_FAMILY) return undefined;
    return photoOfRecord(this.call.view(), version, (hex) => this.sources.photo(hex));
  }

  wholePage(ref: RecordRef, given: string, wanted: boolean, place: RecordPlace): Opened<"record"> {
    const record = { source: ref.source, kind: ref.kind, key: ref.key };
    const head = this.call.view().head(record);
    if (head === undefined || head.version === GONE) return this.#gone(given, RECORD_GONE);
    if (!this.#servesRecord(record, head.start_ms)) outsideAccess();
    const history = wanted && !this.#gated;
    const whole = this.#whole(record, given);
    let entry: Extract<ReadOne, { what: "record" }>;
    if (place.s === undefined) {
      const got = this.room.admit(whole, { from: place.i, keep: RECORD_KEEP, need: ["text"] })!;
      if (got.to !== null) return { entry: got.piece, next: { k: "record", i: got.to } };
      if (!history) return { entry: got.piece, next: null };
      entry = got.piece;
    } else {
      entry = { what: "record", ref: given, ...(whole.day === undefined ? {} : { day: whole.day }), family: whole.family, text: "" };
      this.room.state(entry);
    }
    this.room.state({ history: [] });
    const versions: { at: string; text: string }[] = [];
    let next: RecordPlace | null = null;
    const statements = this.call.view().history(record);
    const first = place.s === undefined ? 0 : Math.max(0, statements.findIndex((statement) => statement.seq >= place.s!));
    for (const statement of statements.slice(first)) {
      const version = { at: this.at(statement.stated_ms)!, text: statement.version === GONE ? "" : this.sources.recordOf(record, statement.version).read?.text ?? "" };
      const got = this.room.admit(version, { from: place.s === statement.seq ? place.i : undefined, keep: ["at"] });
      if (got === null) {
        next = { k: "record", s: statement.seq };
        break;
      }
      versions.push(got.piece);
      if (got.to !== null) {
        next = { k: "record", s: statement.seq, i: got.to };
        break;
      }
    }
    return { entry: { ...entry, history: versions }, next };
  }

  #whole(record: RecordRef, given: string, printed?: string): Extract<ReadOne, { what: "record" }> {
    const head = this.call.view().head(record)!;
    const { family, read, product, dated } = this.sources.recordOf(record);
    const named = this.#party(record);
    const when = head.start_ms === null ? undefined : this.at(head.start_ms, dated);
    const day = dayOf(head.start_ms, dated, this.clock()) ?? printed ?? this.call.indexIfReady()?.facts((facts) => firstLineOf(facts, record)?.day);
    return {
      what: "record", ref: given, ...(day === undefined ? {} : { day }), family: familyOf(family),
      ...(when === undefined ? {} : { at: when }),
      ...(product === undefined ? {} : { product }),
      ...(read?.title === undefined ? {} : { title: read.title }),
      ...(read?.from === undefined ? {} : { from: named(read.from) }),
      ...(read?.to === undefined ? {} : { to: read.to.map(named) }),
      ...(read?.who === undefined ? {} : { who: read.who.map(named) }),
      ...(read?.link === undefined ? {} : { link: read.link }),
      text: read?.text ?? (family === PHOTOS_FAMILY ? this.sources.unheld({ record }) : null) ?? "",
    };
  }


  #party(record: RecordRef): (id: string | null) => string {
    if (this.sources.pieces !== true) return (id) => (id === null ? YOU : this.sources.name(id));
    const said = this.call.indexIfReady()?.facts((facts) => namedIn(facts, record)) ?? [];
    return (id) => {
      if (id === null) return YOU;
      const name = this.sources.name(id);
      const handle = handleOf(id);
      const who = handle === null ? id : handleId(handle);
      return (said.find((each) => each.who === who) ?? said.find((each) => each.text === name) ?? name) as string;
    };
  }

  photoPage(address: { given: string; photo?: HeldPhoto }, place: PhotoPlace | undefined): Opened<"photo"> {
    const held = address.photo ?? this.#photoOfRef(address.given);
    if (held === undefined) return this.#gone(address.given, PICTURE_GONE);
    const got = this.room.admit(this.#photo(this.#servedPhoto(held), address.given), { from: place?.i, keep: ["what", "ref"] })!;
    return { entry: got.piece, next: got.to === null ? null : { k: "photo", i: got.to } };
  }

  #photoOfRef(given: string): HeldPhoto | undefined {
    const ref = readRef(given, "ref", ["picture", "record"]);
    if (ref.kind === "picture") return this.sources.photo(ref.parts.image.replace(/^sha256:/u, ""));
    const head = this.call.view().head(ref.parts);
    return head === undefined || head.version === GONE ? undefined : this.#photoOfRecord(ref.parts, head.version);
  }

  #servedPhoto(held: HeldPhoto): Photo {
    if (!this.#gated) return held.photo;
    if (!this.call.serves(held.accounts, held.photo.at_ms)) outsideAccess();
    const { chat } = held.photo;
    return chat === null || this.call.servesRecord(chat.record, chat.at_ms) ? held.photo : withoutChat(held.photo);
  }

  #photo(photo: Photo, given: string): Extract<ReadOne, { what: "photo" }> {
    const shown = ++this.#pictures <= PICTURES_MOST;
    const facts: string[] = [];
    if (photo.camera !== null) facts.push(`taken with ${photo.camera.name}`);
    const named = photo.people.filter((person) => !person.me).map((person) => person.name);
    if (named.length > 0) facts.push(`with ${named.join(", ")}`);
    if (photo.people.some((person) => person.me)) facts.push("you are in it");
    if (photo.chat !== null) facts.push(`sent in ${photo.chat.title}${photo.chat.sender === null ? "" : ` by ${photo.chat.mine ? YOU : photo.chat.sender.name}`}`);
    if (!shown) facts.push(`not shown: a call shows ${PICTURES_MOST} pictures at most; read this one again to see it`);
    const wasAt = (photo.at_ms === null ? undefined : wasAtPlace(this.call.whereIfReady(), { start_ms: photo.at_ms, day: civilDay(photo.at_ms, this.clock()) }).words) ?? photo.area?.city ?? null;
    const day = photo.day ?? undefined;
    return {
      what: "photo", ref: given, ...(day === undefined ? {} : { day }), ...(shown ? { image: photo.hash } : {}),
      ...(photo.at_ms === null ? {} : { at: this.at(photo.at_ms)! }), ...(photo.caption === null ? {} : { title: photo.caption }),
      ...(wasAt === null ? {} : { the_user_was_at: wasAt }), facts,
    };
  }

  pictureLine(image: string, after: Line): Line {
    return {
      ref: makeRef("picture", { image }), ...(after.at === undefined ? {} : { at: after.at }), ...(after.day === undefined ? {} : { day: after.day }),
      ...(after.family === undefined ? {} : { family: after.family }), ...(after.from === undefined ? {} : { from: after.from }), picture: true, text: PICTURE_WORDS,
    };
  }


  line(ref: RefParts["line"], given: string, place: LinePlace | undefined): Opened<"line"> {
    const index = this.call.index();
    const found = index.facts((read) => lineIn(read, ref));
    if ("not" in found && found.not === "unread") refused("TOO_BROAD", LINE_UNREAD);
    const fresh = this.#fresh(ref.day, ref.day);
    let held = "found" in found ? found.found : undefined;
    if (held === undefined && fresh?.pending.some((day) => day.day === ref.day) === true) {
      const document = this.sources.dayDocument(ref.day);
      if (document !== undefined) {
        const atoms = [...dayLines(ref.day, document).values()];
        const at = identified(atoms.map(({ atom }) => atom), ref);
        if (at !== undefined) held = { atoms: atoms.slice(Math.max(0, at - AROUND_LINES), at + AROUND_LINES + 1), at: Math.min(at, AROUND_LINES), rev: document.inputs };
      }
    }
    if (held === undefined) return refused("LINE_MOVED", LINE_LEFT);
    const { atoms, at: own, rev } = this.#gated ? this.#servedAround(held) : held;
    const page = freshMembers(fresh);
    this.room.state({ what: "line", ref: given, day: ref.day, rev, lines: [], ...page });
    const printed = (step: { atom: AtomRow; m: number }, opened = false): Line[] => {
      const line = opened ? { ...this.dayLine(step.atom, step.m), ref: given } : this.dayLine(step.atom, step.m);
      return [line, ...this.#picturesOf(step.atom).map((image) => this.pictureLine(image, line))];
    };
    const entry = (lines: Line[], record?: Extract<ReadOne, { what: "record" }>): Extract<ReadOne, { what: "line" }> => ({
      what: "line", ref: given, day: ref.day, rev, lines, ...(record === undefined ? {} : { record }), ...page,
    });
    const self = this.room.admit(printed(atoms[own]!, true), { from: place?.i, keep: LINE_KEEP })!;
    if (self.to !== null) return { entry: entry(self.piece), next: { k: "line", i: self.to } };
    const before: Line[][] = [], after: Line[][] = [];
    let back = own - 1, on = own + 1;
    let backOpen = true, onOpen = true;
    while ((backOpen && back >= 0) || (onOpen && on < atoms.length)) {
      if (backOpen && back >= 0) {
        const got = this.room.admit(printed(atoms[back]!));
        if (got === null) backOpen = false;
        else {
          before.unshift(got.piece);
          back--;
        }
      }
      if (onOpen && on < atoms.length) {
        const got = this.room.admit(printed(atoms[on]!));
        if (got === null) onOpen = false;
        else {
          after.push(got.piece);
          on++;
        }
      }
    }
    const atom = atoms[own]!.atom;
    const record = recordOf(atom);
    const behindRef = record === undefined ? undefined : makeRef("record", record);
    const stated = record === undefined ? undefined : this.call.view().head(record);
    const head = stated?.version;
    const behind = record === undefined || behindRef === undefined || head === undefined || head === GONE || !this.#servesRecord(record, stated!.start_ms) ? undefined : this.nested(() => {
      this.room.state({ record: null });
      return this.page("record", { parts: record, given: behindRef, history: false }, undefined, { ref: behindRef });
    });
    return { entry: entry([...before.flat(), ...self.piece, ...after.flat()], behind?.what === "record" ? behind : undefined), next: null };
  }


  #servedAround<T extends { atoms: { atom: AtomRow; m: number }[]; at: number }>(held: T): T {
    const own = held.atoms[held.at]!;
    const atoms = this.call.index().facts((read) => held.atoms.filter((each) => this.#lineServed(read, each.atom)));
    if (!atoms.includes(own)) outsideAccess();
    return { ...held, atoms, at: atoms.indexOf(own) };
  }

  row(ref: RefParts["row"], given: string, place: RowPlace | undefined): Opened<"row"> {
    let ask: CountAsk;
    let opened: RowOpened;
    try {
      ask = countAskOf(ref.ask, collectionsOf(this.call.families));
      opened = openRow(this.call, ask, ref.kept, ref.scope, place?.p, this.sources.admitted);
    } catch (error) {
      if (error instanceof Refusal && error.code === "BAD_PARAMETER") return this.#gone(given, `this count can no longer be run as it was asked: ${error.words}`);
      throw error;
    }
    const { answer, now } = opened;
    const value = (cell: Cell) => cell.value;
    const head = {
      what: "row" as const, ref: given, asked: String(answer.asked.value), n: ref.n, ...(now === undefined || now === ref.n ? {} : { now }),
      columns: answer.columns,
      ...(answer.as_of == null ? {} : { as_of: answer.as_of }),
      ...(answer.pending === undefined || answer.pending.length === 0 ? {} : { pending: answer.pending }), ...(answer.pending_more === undefined ? {} : { pending_more: answer.pending_more }),
    };
    this.room.state({ ...head, rows: [] });
    const rows: unknown[][] = [];
    const before = (k: number): { p?: CountPlace } => {
      const p = k === 0 ? place?.p : answer.places?.[k - 1];
      return p === undefined ? {} : { p };
    };
    let next: RowPlace | null = answer.place === undefined ? null : { k: "row", p: answer.place };
    for (const [k, row] of answer.rows.entries()) {
      const got = this.room.admit(row.map(value), { from: k === 0 ? place?.i : undefined, tuple: true });
      if (got === null) {
        next = { k: "row", ...before(k) };
        break;
      }
      rows.push(got.piece);
      if (got.to !== null) {
        next = { k: "row", ...before(k), i: got.to };
        break;
      }
    }
    return { entry: { ...head, rows: rows as Extract<ReadOne, { what: "row" }>["rows"] }, next };
  }


  people(address: PeopleAddress, place: PeoplePlace | undefined): Opened<"people"> {
    const match = address.match ?? peopleOne(this.call, address.id, address.chat);
    if (match === undefined) return this.#gone(address.given, address.chat ? CHAT_GONE : PERSON_GONE);
    this.room.state({ what: "people", match: null });
    const got = this.room.admit(match, { from: place?.i, keep: ["ref", "kind", "name"] })!;
    if (got.to !== null) return { entry: { what: "people", match: got.piece }, next: { k: "people", i: got.to } };
    const latest = address.chat ? this.nested(() => {
      this.room.state({ latest: null });
      return this.#latest(this.chat(address.id), address.args);
    }) : undefined;
    return { entry: { what: "people", match: got.piece, ...(latest === undefined ? {} : { latest }) }, next: null };
  }

  place(id: string, given: string, place: SpotPlace | undefined): Opened<"place"> {
    const held = placeOf(this.call, id);
    if (held === undefined) return this.#gone(given, PLACE_GONE);
    const found = this.#gated ? this.#placeServed(held) : held;
    const got = this.room.admit({ what: "place" as const, ref: given, place: found }, { from: place?.i, keep: ["what", "ref", "slug", "name", "unit", "start_ms"] })!;
    return { entry: got.piece as Extract<ReadOne, { what: "place" }>, next: got.to === null ? null : { k: "place", i: got.to } };
  }


  #placeServed(place: OnePlace): OnePlace {
    this.call.where();
    const visits = (place.visits ?? []).filter((visit) => this.call.stayServed(visit.start_ms, visit.end_ms ?? visit.start_ms + 1, true))
      .map(({ people: _people, ...visit }) => visit);
    if (visits.length === 0) outsideAccess();
    const { slug, name, latitude, longitude, radius_m, also, ids, area, part_of, inside, home } = place;
    const stated = { latitude, longitude, radius_m, also, ids, area, part_of, inside, home };
    return {
      slug, name, ...Object.fromEntries(Object.entries(stated).filter(([, value]) => value !== undefined)),
      first_ms: Math.min(...visits.map((visit) => visit.start_ms)), last_ms: Math.max(...visits.map((visit) => visit.end_ms ?? visit.start_ms)),
      visits_count: visits.length, visits,
    } as OnePlace;
  }

  describe(given: string): Citation {
    const ref = readRef(given, "ref");
    switch (ref.kind) {
      case "record": return this.#describeRecord(ref.parts, given);
      case "line": return this.#describeLine(ref.parts, given);
      case "picture": {
        const held = this.sources.photo(ref.parts.image.replace(/^sha256:/u, ""));
        return held === undefined ? gone(given, PICTURE_GONE) : this.#photoDescribed(this.#servedPhoto(held), given);
      }
      case "window": return this.#describeWindow(ref.parts, given);
      case "row": {
        let asked: string;
        try {
          asked = rowAskedOf(ref.parts.ask, ref.parts.scope, collectionsOf(this.call.families));
        } catch (error) {
          if (error instanceof Refusal && error.code === "BAD_PARAMETER") return gone(given, `this count can no longer be run as it was asked: ${error.words}`);
          throw error;
        }
        return { ref: given, kind: "row", asked, n: ref.parts.n, opens: { page: "read" } };
      }
      case "person": {
        const people = this.call.people();
        const id = people.idOf(ref.parts.handle);
        const person = id === undefined ? undefined : people.person(id);
        return person === undefined ? gone(given, PERSON_GONE) : { ref: given, kind: "person", name: person.name, opens: { page: "people", id: ref.parts.handle } };
      }
      case "chat": return this.#describeChat(ref.parts.key, given);
      case "place": {
        const place = placeOf(this.call, ref.parts.id);
        return place === undefined ? gone(given, PLACE_GONE) : { ref: given, kind: "place", name: place.name, opens: { page: "places", id: place.slug } };
      }
    }
  }

  #describeRecord(record: RecordRef, given: string): Citation {
    const view = this.call.view();
    const head = view.head(record);
    if (head === undefined || head.version === GONE) return gone(given, RECORD_GONE);
    const focus = recordFocus(record);
    const atom = this.call.index().facts((read) => firstLineOf(read, record));
    const read = this.sources.recordOf(record);
    if ((atom?.family ?? read.family) === PHOTOS_FAMILY) {
      const held = this.#photoOfRecord(record, head.version);
      if (held !== undefined) return this.#photoDescribed(this.#servedPhoto(held), given, atom === undefined ? undefined : focus);
    }
    const product = view.source(record.source)?.product;
    const message = product !== undefined && this.call.networks.of(product) !== undefined && record.kind === "msg";
    const ai = message ? undefined : this.sources.aiChatOf(record);
    const chat = atom?.chat ?? (message ? this.#chatOfMessage(record, head.start_ms) : ai);
    const day = dayOf(head.start_ms, read.dated, this.clock()) ?? atom?.day;
    const title = atom?.title || read.read?.title || clipped(read.read?.text ?? atom?.line ?? "");
    const when = head.start_ms === null ? undefined : this.at(head.start_ms, read.dated);
    const placed = {
      ...(day === undefined ? {} : { day }),
      opens: day === undefined ? { page: "read" as const } : { page: "days" as const, day, ...(atom?.day === day ? { focus } : {}) },
      ...(when === undefined ? {} : { at: when }), ...(title === "" ? {} : { title }),
      ...(chat === undefined || chat === null ? {} : { chat: makeRef("chat", { key: chat }), ...(atom?.chat != null && atom.title !== "" ? { chat_title: atom.title } : {}) }),
    };
    if (ai !== undefined) return { ref: given, kind: "turn", ...placed };
    const voice = this.#voiceOf(atom, record);
    return { ref: given, kind: message ? "message" : "record", ...placed, ...(voice === undefined ? {} : { voice }) };
  }

  #describeLine(ref: RefParts["line"], given: string): Citation {
    const found = this.call.index().facts((read) => lineAtomIn(read, ref));
    if ("not" in found && found.not === "unread") refused("TOO_BROAD", LINE_UNREAD);
    let atom = "found" in found ? found.found.atom : undefined;
    if (atom === undefined && this.#fresh(ref.day, ref.day)?.pending.some((day) => day.day === ref.day) === true) {
      const document = this.sources.dayDocument(ref.day);
      const atoms = document === undefined ? [] : [...dayLines(ref.day, document).values()].map((each) => each.atom);
      const at = identified(atoms, ref);
      atom = at === undefined ? undefined : atoms[at];
    }
    if (atom === undefined) return gone(given, LINE_LEFT);
    const record = recordOf(atom);
    const title = atom.title || clipped(atom.line);
    const when = atom.start_ms === null || atom.dated === 1 ? undefined : this.at(atom.start_ms);
    const voice = this.#voiceOf(atom, record);
    return {
      ref: given, kind: "line", day: ref.day, opens: { page: "days", day: ref.day, focus: record === undefined ? unitFocus(atom.unit) : recordFocus(record) },
      ...(when === undefined ? {} : { at: when }), ...(title === "" ? {} : { title }),
      ...(atom.chat === null ? {} : { chat: makeRef("chat", { key: atom.chat }), ...(atom.title === "" ? {} : { chat_title: atom.title }) }),
      ...(voice === undefined ? {} : { voice }),
    };
  }

  #voiceOf(atom: AtomRow | undefined, record: RecordRef | undefined): Voice | undefined {
    if (atom === undefined || record === undefined || !voiced(atom.family)) return undefined;
    const extract = this.call.view().extract(atom.family, atom.unit);
    const voice = extract === undefined ? undefined : voiceOf(extract, record, () => spoken(this.#chatAtomOf(atom)).from);
    return voice !== undefined && this.sources.held(voice.audio) ? voice : undefined;
  }

  #chatAtomOf(atom: AtomRow): ChatAtom {
    const names = atom.names !== undefined ? atom.names
      : this.call.index().facts((read) => read.walk<{ names: string | null }>("SELECT names FROM atoms WHERE day = ? AND n = ? LIMIT ?", [atom.day, atom.n], 1).rows[0]?.names ?? null);
    return { start_ms: atom.start_ms, text: atom.line, ...(names === null ? {} : { names: JSON.parse(names) as NonNullable<ChatAtom["names"]> }) };
  }

  #photoDescribed(photo: Photo, given: string, focus?: string): Citation {
    const day = photo.day ?? undefined;
    const on = focus ?? photo.focus ?? undefined;
    return {
      ref: given, kind: "photo", ...(day === undefined ? {} : { day }), image: photo.hash,
      opens: day === undefined ? { page: "read" } : { page: "days", day, ...(on === undefined ? {} : { focus: on }) },
      ...(photo.at_ms === null ? {} : { at: this.at(photo.at_ms)! }), ...(photo.caption === null || photo.caption === "" ? {} : { title: photo.caption }),
      ...(photo.chat === null ? {} : { chat: makeRef("chat", { key: `${photo.chat.network}:${photo.chat.chat}` }), chat_title: photo.chat.title }),
    };
  }

  #describeWindow(ref: RefParts["window"], given: string): Citation {
    const segments = this.screen().segments({ machine: ref.machine, day: ref.day, app: ref.app, site: ref.site, name: ref.name });
    if (segments.length === 0) return gone(given, WINDOW_GONE);
    const sitting = this.#sittingOf(ref.machine, ref.at_ms ?? segments[0]!);
    return {
      ref: given, kind: "window", day: ref.day, app: ref.app, title: ref.name !== "" ? ref.name : ref.app,
      opens: { page: "days", day: ref.day, ...(sitting === undefined ? {} : { focus: unitFocus(sitting, ref.at_ms === null ? undefined : minuteOf(ref.at_ms)) }) },
      ...(ref.at_ms === null ? {} : { at: this.screenAt(ref.at_ms) }),
    };
  }

  serves(given: string): boolean {
    let ref: ReturnType<typeof readRef>;
    try {
      ref = readRef(given, "ref");
    } catch (error) {
      if (error instanceof Refusal) return true;
      throw error;
    }
    try {
      return this.#judgedRef(ref);
    } catch (error) {
      if (error instanceof Refusal) return error.code !== "OUTSIDE_ACCESS";
      throw error;
    }
  }

  #judgedRef(ref: ReturnType<typeof readRef>): boolean {
    switch (ref.kind) {
      case "record": {
        const head = this.call.view().head(ref.parts);
        return head === undefined || this.#servesRecord(ref.parts, head.start_ms);
      }
      case "window": {
        const at_ms = ref.parts.at_ms ?? this.screen().segments({ machine: ref.parts.machine, day: ref.parts.day, app: ref.parts.app, site: ref.parts.site, name: ref.parts.name })[0];
        return at_ms === undefined || this.#servesScreen(ref.parts.machine, at_ms);
      }
      case "line": {
        const found = this.call.index().facts((read) => {
          const atom = lineAtomIn(read, ref.parts);
          return "found" in atom ? this.#lineServed(read, atom.found.atom) : true;
        });
        return found;
      }
      case "picture": {
        const held = this.sources.photo(ref.parts.image.replace(/^sha256:/u, ""));
        return held === undefined || this.call.serves(held.accounts, held.photo.at_ms);
      }
      case "person": return this.call.named(ref.parts.handle) !== undefined;
      case "chat": {
        if (this.sources.isAiChat(ref.parts.key)) return this.#aiChat(ref.parts.key) !== undefined;
        return chatSpanOf(this.call, this.call.chat(ref.parts.key)) !== null;
      }
      case "place": {
        const held = placeOf(this.call, ref.parts.id);
        return held === undefined || (held.visits ?? []).some((visit) => this.call.stayServed(visit.start_ms, visit.end_ms ?? visit.start_ms + 1));
      }
      case "row": return true;
    }
  }

  #describeChat(key: string, given: string): Citation {
    const list = this.call.peopleFileIfReady()?.value<{ chats: PeopleSearchChat[]; people: readonly ChatWriter[] }>("answer", "list");
    const listed = list?.chats.find((each) => each.key === key);
    if (listed !== undefined) return { ref: given, kind: "chat", name: listed.label, opens: this.#chatOpens(key, listed.group, list!.people) };
    if (this.sources.isAiChat(key)) {
      const newest = aiDays(this.call, key).at(-1);
      const content = newest === undefined ? undefined : this.call.view().extract(AI_FAMILY, newest)?.content as unknown as ConversationDay | undefined;
      if (content === undefined || content.turns.length === 0) return gone(given, CHAT_GONE);
      return { ref: given, kind: "chat", name: content.title ?? key, opens: { page: "read" } };
    }
    if (this.#chatSpan(this.call.chat(key)) === null) return gone(given, CHAT_GONE);
    return { ref: given, kind: "chat", name: this.sources.name(key.slice(key.indexOf(":") + 1)), opens: { page: "read" } };
  }

  #chatOpens(key: string, group: boolean, people: readonly ChatWriter[]): Opens {
    if (group) return { page: "people", id: key, person: null, group: key };
    const person = mostWritten(people, key) ?? this.#otherEnd(key);
    return person === null ? { page: "read" } : { page: "people", id: key, person };
  }

  #otherEnd(key: string): string | null {
    const at = key.indexOf(":");
    const network = key.slice(0, at);
    const members = chatMembers(this.call.networks, network, key.slice(at + 1));
    const handle = members.length === 1 ? partyHandle(network, members[0]!) : null;
    return (handle === null ? undefined : this.call.peopleIfReady()?.idOf(handleId(handle))) ?? null;
  }
}

interface ChatWriter {
  readonly id: string;
  readonly me: boolean;
  readonly chats: readonly { readonly key: string; readonly count: number }[];
}

function mostWritten(people: readonly ChatWriter[], chat: string): string | null {
  let most: { id: string; count: number } | null = null;
  for (const person of people) {
    if (person.me) continue;
    const count = person.chats.reduce((sum, each) => (each.key === chat ? sum + each.count : sum), 0);
    if (count > 0 && (most === null || count > most.count || (count === most.count && person.id < most.id))) most = { id: person.id, count };
  }
  return most?.id ?? null;
}

const MINUTE_MS = 60_000;

function minuteOf(at_ms: number): { from_ms: number; to_ms: number } {
  const from_ms = at_ms - (at_ms % MINUTE_MS);
  return { from_ms, to_ms: from_ms + MINUTE_MS };
}

function aiDays(call: Call, key: string): string[] {
  return [...call.view().extractReadings(AI_FAMILY, `${key}/`)].map((row) => row.unit).filter((unit) => /\/\d{4}-\d{2}-\d{2}$/u.test(unit)).sort();
}

function namedIn(read: FactsRead, record: RecordRef): { text: string; who: string }[] {
  const said: { text: string; who: string }[] = [];
  for (let after = 0; ;) {
    const atoms = read.walk<IndexAtom>("SELECT * FROM atoms WHERE source = ? AND kind = ? AND key = ? AND id > ? ORDER BY id LIMIT ?", [record.source, record.kind, record.key, after], RECORD_ATOMS);
    for (const passage of atoms.rows.flatMap(atomPassages)) for (const span of passage.names) said.push({ text: passage.text.slice(span.start, span.end), who: span.who });
    if (!atoms.more) return said;
    if (atoms.rows.length === 0) return refused("TOO_BROAD", RECORD_UNREAD);
    after = atoms.rows.at(-1)!.id;
  }
}

function firstLineOf(read: FactsRead, record: RecordRef): AtomRow | undefined {
  let first: (AtomRow & { id: number }) | undefined;
  for (let after = 0; ;) {
    const lines = read.walk<AtomRow & { id: number }>(`SELECT id, ${ATOM_COLUMNS} FROM atoms WHERE source = ? AND kind = ? AND key = ? AND id > ? ORDER BY id LIMIT ?`,
      [record.source, record.kind, record.key, after], RECORD_ATOMS);
    for (const line of lines.rows) if (first === undefined || line.day < first.day || (line.day === first.day && line.n < first.n)) first = line;
    if (!lines.more) return first;
    if (lines.rows.length === 0) return refused("TOO_BROAD", RECORD_UNREAD);
    after = lines.rows.at(-1)!.id;
  }
}

function fallbackKey(atom: Pick<AtomRow, "start_ms" | "end_ms">, z: number): [number, number, number] {
  if (z === 1) return [1, atom.start_ms!, -(atom.end_ms ?? atom.start_ms!)];
  if (z === 2) return [2, atom.start_ms!, 0];
  return [z, 0, 0];
}

function sectionOf(atom: Pick<AtomRow, "start_ms" | "dated">, before: number): number {
  if (atom.dated === 1) return 2;
  if (atom.start_ms !== null) return 1;
  return before >= 1 ? 3 : before;
}

const compareKeys = (left: readonly number[], right: readonly number[]): number => {
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  return 0;
};

interface AtomRead {
  atom: AtomRow;
  rev: string;
  z: number;
  t: number;
  m(): number;
  from?: Cut;
}

function daysPlace(step: AtomRead, after: boolean, i?: Cut): DaysPlace {
  const { atom } = step;
  return { k: "days", d: atom.day, a: atom.same, m: step.m(), ...(after ? { x: 1 as const } : {}), z: step.z, s: atom.start_ms, e: atom.end_ms, t: step.t, ...(i === undefined ? {} : { i }) };
}

type Lookup<T> = { found: T } | { not: "absent" | "ambiguous" | "unread" };

function* atomsOf(read: FactsRead, stretch: Stretch, at: DaysPlace): Generator<AtomRead | { stop: DaysPlace }> {
  for (let after: string | null = null; ;) {
    const days: { rows: { day: string; inputs: string }[]; more: boolean } = read.walk<{ day: string; inputs: string }>(`SELECT day, inputs FROM days WHERE day ${after === null ? ">=" : ">"} ? AND day <= ? ORDER BY day LIMIT ?`,
      [after ?? at.d, stretch.to], DAYS_AT_ONCE);
    if (days.rows.length === 0 && days.more) {
      yield { stop: after === null ? at : { k: "days", d: addDays(after, 1) } };
      return;
    }
    for (const { day, inputs } of days.rows) {
      if (inputs === "") continue;
      let n = 0, z = 0, t = 0;
      let key: readonly number[] | undefined;
      const ordinals = new Map<string, number>();
      let whole = true;
      let seek: { key: readonly number[]; t: number } | undefined;
      let first: Cut | undefined;
      if (day === at.d && at.a !== undefined) {
        const anchor = atomSeek(read, day, at.a, at.m ?? 0);
        if ("not" in anchor && anchor.not === "unread") {
          yield { stop: at };
          return;
        }
        if ("found" in anchor) {
          const from = at.x !== 1;
          n = anchor.found.n + (from ? 0 : 1);
          z = from && (at.z === 1 || at.z === 2) ? 0 : at.z ?? 0;
          key = fallbackKey(anchor.found, at.z ?? 0);
          t = (at.t ?? 0) - (from ? 1 : 0);
          whole = false;
          ordinals.set(at.a, (at.m ?? 0) - (from ? 1 : 0));
          if (from) first = at.i;
        } else {
          seek = { key: fallbackKey({ start_ms: at.s ?? null, end_ms: at.e ?? null }, at.z ?? 0), t: at.t ?? 0 };
        }
      }
      for (; ;) {
        const atoms = read.walk<AtomRow>(`SELECT ${ATOM_COLUMNS} FROM atoms WHERE day = ? AND n >= ? ORDER BY n LIMIT ?`, [day, n], ATOMS_AT_ONCE);
        for (const atom of atoms.rows) {
          z = sectionOf(atom, z);
          const own = fallbackKey(atom, z);
          t = key !== undefined && compareKeys(own, key) === 0 ? t + 1 : 0;
          key = own;
          const prior = ordinals.get(atom.same);
          const known = prior === undefined ? (whole ? 0 : undefined) : prior + 1;
          if (known !== undefined) ordinals.set(atom.same, known);
          let m = known;
          const step: AtomRead = {
            atom, rev: inputs, z, t,
            m: () => {
              m ??= ordinalOf(read, day, atom.same, atom.n);
              return m;
            },
            ...(first === undefined ? {} : { from: first }),
          };
          first = undefined;
          if (seek !== undefined) {
            const order = compareKeys(own, seek.key);
            if (order < 0 || (order === 0 && t < seek.t)) continue;
            seek = undefined;
          }
          yield step;
        }
        if (!atoms.more) break;
        if (atoms.rows.length === 0) {
          yield { stop: day === at.d ? at : { k: "days", d: day } };
          return;
        }
        n = atoms.rows.at(-1)!.n + 1;
      }
    }
    if (!days.more) return;
    after = days.rows.at(-1)!.day;
  }
}

function atomSeek(read: FactsRead, day: string, same: string, m: number): Lookup<AtomRow> {
  const walked = read.walk<AtomRow>(`SELECT ${ATOM_COLUMNS} FROM atoms WHERE day = ? AND same = ? ORDER BY n LIMIT ?`, [day, same], m + 1);
  const atom = walked.rows[m];
  if (atom !== undefined) return { found: atom };
  return walked.more ? { not: "unread" } : { not: "absent" };
}

function firstPrinted(read: FactsRead, atom: AtomRow, stretch: Stretch, meter: FactsRead["work"]): boolean {
  for (let after = 0; ;) {
    const lines = read.walk<AtomRow & { id: number }>(`SELECT id, ${ATOM_COLUMNS} FROM atoms WHERE source = ? AND kind = ? AND key = ? AND id > ? ORDER BY id LIMIT ?`,
      [atom.source, atom.kind, atom.key, after], RECORD_ATOMS, meter);
    const before = lines.rows.some((line) => line.day >= stretch.from && (line.day < atom.day || (line.day === atom.day && line.n < atom.n)) && rowKept(line, stretch, read));
    if (before) return false;
    if (!lines.more || lines.rows.length === 0) return true;
    after = lines.rows.at(-1)!.id;
  }
}

function dayLines(day: string, document: DayDocument): Map<number, { atom: AtomRow; m: number }> {
  const seen = new Map<string, number>();
  const out = new Map<number, { atom: AtomRow; m: number }>();
  for (const entry of [...dayAtoms(document as unknown as { atoms?: unknown[] })].sort((left, right) => left.n - right.n)) {
    const same = atomSame(day, entry);
    const m = seen.get(same) ?? 0;
    seen.set(same, m + 1);
    out.set(entry.n, {
      m,
      atom: {
        day, n: entry.n, family: entry.family, unit: entry.unit, item: entry.item ?? null, source: entry.record?.source ?? null, kind: entry.record?.kind ?? null,
        key: entry.record?.key ?? null, start_ms: entry.start_ms, end_ms: entry.end_ms, dated: entry.dated === true ? 1 : 0, line: entry.text,
        names: entry.names === undefined ? null : JSON.stringify(entry.names), title: entry.title ?? "", pictures: entry.pictures ?? null, chat: entry.chat ?? null, same,
      },
    });
  }
  return out;
}

function identified(atoms: readonly AtomRow[], ref: RefParts["line"]): number | undefined {
  let m = 0;
  for (const [at, atom] of atoms.entries()) {
    if (atom.same !== ref.same) continue;
    if (m === ref.m) return at;
    m++;
  }
  if (ref.item === null) return undefined;
  const same = atoms.flatMap((atom, at) => (atom.unit === ref.unit && atom.item === ref.item ? [at] : []));
  return same.length === 1 ? same[0] : undefined;
}

function lineIn(read: FactsRead, ref: RefParts["line"]): Lookup<{ atoms: { atom: AtomRow; m: number }[]; at: number; rev: string }> {
  const found = lineAtomIn(read, ref);
  if ("not" in found) return found;
  const { atom, rev } = found.found;
  const before = read.walk<AtomRow>(`SELECT ${ATOM_COLUMNS} FROM atoms WHERE day = ? AND n < ? ORDER BY n DESC LIMIT ?`, [ref.day, atom.n], AROUND_LINES).rows.reverse();
  const after = read.walk<AtomRow>(`SELECT ${ATOM_COLUMNS} FROM atoms WHERE day = ? AND n > ? ORDER BY n LIMIT ?`, [ref.day, atom.n], AROUND_LINES).rows;
  const atoms = [...before, atom, ...after].map((each) => ({ atom: each, m: recordOf(each) === undefined ? ordinalOf(read, each.day, each.same, each.n) : 0 }));
  return { found: { atoms, at: before.length, rev } };
}

function lineAtomIn(read: FactsRead, ref: RefParts["line"]): Lookup<{ atom: AtomRow; rev: string }> {
  const rev = read.point<{ inputs: string }>("SELECT inputs FROM days WHERE day = ?", [ref.day])?.inputs;
  if (rev === undefined || rev === "") return { not: "absent" };
  const exact = atomSeek(read, ref.day, ref.same, ref.m);
  if ("found" in exact) return { found: { atom: exact.found, rev } };
  if (exact.not === "unread") return exact;
  if (ref.item === null) return { not: "absent" };
  const found: AtomRow[] = [];
  for (let n = 0; ;) {
    const page = read.walk<AtomRow>(`SELECT ${ATOM_COLUMNS} FROM atoms WHERE day = ? AND n >= ? ORDER BY n LIMIT ?`, [ref.day, n], ATOMS_AT_ONCE);
    found.push(...page.rows.filter((each) => each.unit === ref.unit && each.item === ref.item));
    if (found.length > 1) return { not: "ambiguous" };
    if (!page.more) break;
    if (page.rows.length === 0) return { not: "unread" };
    n = page.rows.at(-1)!.n + 1;
  }
  return found.length === 1 ? { found: { atom: found[0]!, rev } } : { not: "absent" };
}

const endPlace = (end: RunEnd): { r?: string; a: number; q: number } => ({ ...(end.h === undefined ? {} : { r: end.h }), a: end.t, q: end.q });

const itemsOf = (shown: readonly { t_ms: number; line: { text: string } }[]): { t: number; id: string }[] => shown.map((each) => ({ t: each.t_ms, id: wordsOf(each.line.text) }));

function runEnd(items: readonly { t: number; id: string }[], at: number): RunEnd {
  const placed = placedAt(items, at);
  return { t: placed.a!, q: placed.q!, ...(placed.r === undefined ? {} : { h: placed.r }) };
}

function runAround(shown: readonly { t_ms: number; line: object }[], at_ms: number | null): { lo: number; hi: number } {
  if (shown.length === 0) return { lo: 0, hi: 0 };
  const far = (at: number) => (at_ms === null ? 0 : Math.abs(shown[at]!.t_ms - at_ms));
  let anchor = 0;
  for (let at = 1; at < shown.length; at++) if (far(at) < far(anchor)) anchor = at;
  let lo = anchor, hi = anchor + 1, chars = sizeOf(shown[anchor]!.line) + 1;
  let down = true, up = true;
  for (;;) {
    down &&= lo > 0;
    up &&= hi < shown.length;
    if (!down && !up) return { lo, hi };
    const before = down && (!up || far(lo - 1) < far(hi));
    const size = sizeOf(shown[before ? lo - 1 : hi]!.line) + 1;
    if (chars + size > HIT_CHARS) {
      if (before) down = false;
      else up = false;
      continue;
    }
    chars += size;
    if (before) lo--;
    else hi++;
  }
}

function screenPage<L extends { text: string }>(shown: readonly { t_ms: number; line: L }[], place: { t: number; h: string; q: number; i?: Cut } | undefined, room: Room): { taken: L[]; next: { t: number; h: string; q: number; i?: Cut } | null } {
  const items = shown.map((each) => ({ t: each.t_ms, id: wordsOf(each.line.text) }));
  const begin = place === undefined ? { at: 0, exact: false } : resume(items, { r: place.h, a: place.t, q: place.q });
  const named = (at: number, i?: Cut) => {
    const placed = placedAt(items, at);
    return { t: placed.a!, h: placed.r!, q: placed.q!, ...(i === undefined ? {} : { i }) };
  };
  const taken: L[] = [];
  for (let at = begin.at; at < shown.length; at++) {
    if (taken.length >= PAGE_LINES) return { taken, next: named(at) };
    const got = room.admit(shown[at]!.line, { from: at === begin.at && begin.exact ? place?.i : undefined, keep: SCREEN_KEEP });
    if (got === null) return { taken, next: named(at) };
    taken.push(got.piece);
    if (got.to !== null) return { taken, next: named(at, got.to) };
  }
  return { taken, next: null };
}

const wordsOf = (text: string): string => digestOf(text);

function imagesOf(message: MessageFact): string[] {
  return [...new Set((message.parts ?? []).flatMap((part) => (part.blob !== undefined && (part.media_type?.startsWith("image/") === true || part.ask === "caption")
    ? [part.blob.startsWith("sha256:") ? part.blob : `sha256:${part.blob}`] : [])))];
}

interface DayWindows {
  sittings: ReadonlyMap<string, ScreenWindow[]>;
  tail: ScreenWindow[];
  mac(machine: string): string | null;
}

const byStart = (left: ScreenWindow, right: ScreenWindow): number => left.start_ms - right.start_ms || right.tenths - left.tenths || left.machine.localeCompare(right.machine)
  || left.app.localeCompare(right.app) || left.site.localeCompare(right.site) || left.name.localeCompare(right.name);

const windowRef = (window: ScreenWindow): string => makeRef("window", { machine: window.machine, day: window.day, app: window.app, site: window.site, name: window.name, at_ms: window.start_ms });

const groupDigest = (group: readonly Line[]): string => digestOf(group.map((line) => [line.ref ?? null, line.text, line.cites ?? null]));

function screenUnitsOn(read: FactsRead, day: string): Map<string, number> {
  const units = new Map<string, number>();
  for (let after = -1; ;) {
    const { rows, more } = read.walk<{ n: number; unit: string }>(`SELECT n, unit FROM atoms WHERE day = ? AND n > ? AND family = '${SCREEN_FAMILY}' ORDER BY n LIMIT ?`, [day, after], SCREEN_ROWS);
    for (const row of rows) if (!units.has(row.unit)) units.set(row.unit, row.n);
    if (!more || rows.length === 0) return units;
    after = rows.at(-1)!.n;
  }
}

function recordOf(atom: AtomRow): RecordRef | undefined {
  return atom.source === null || atom.kind === null || atom.key === null ? undefined : { source: atom.source, kind: atom.kind, key: atom.key };
}

interface Span {
  start_ms: number;
  end_ms: number | null;
}

function kept(stretch: Stretch, family: string, day: string, spanOf: () => Span | null, products: () => readonly string[]): boolean {
  if (stretch.families !== null && !stretch.families.includes(familyOf(family))) return false;
  if (stretch.products !== null && !products().some((product) => stretch.products!.includes(product))) return false;
  if (stretch.whole) return true;
  const span = spanOf();
  if (span === null) return stretch.wholeDays !== null && day >= stretch.wholeDays.from && day <= stretch.wholeDays.to;
  return (span.end_ms ?? span.start_ms) >= stretch.from_ms && span.start_ms < stretch.to_ms;
}

const productOf = (source: string): string => source.split(":")[0]!;

const productsOf = (accounts: readonly string[] | null | undefined, source: string | null): string[] =>
  accounts !== null && accounts !== undefined ? accounts.map(productOf) : source === null ? [] : [productOf(source)];

function rowKept(atom: AtomRow, stretch: Stretch, read: FactsRead): boolean {
  const span = () => (atom.start_ms === null || atom.dated === 1 ? null : { start_ms: atom.start_ms, end_ms: atom.end_ms });
  return kept(stretch, atom.family, atom.day, span, () => productsOf(lineAccountsOf(read.point<{ accounts: string }>(LINE_ACCOUNTS, [atom.day, atom.n])?.accounts, atom.source), null));
}

function atomKept(atom: DayAtom, day: string, stretch: Stretch): boolean {
  const span = () => (atom.start_ms === null || atom.flags.includes("date_only") ? null : { start_ms: atom.start_ms, end_ms: atom.end_ms });
  return kept(stretch, atom.family, day, span, () => productsOf(atom.accounts, atom.record?.source ?? null));
}

function factKept(fact: DayFileFact, day: string, stretch: Stretch): boolean {
  return kept(stretch, fact.family, day, () => (fact.date_only === true ? null : { start_ms: fact.start_ms, end_ms: null }), () => productsOf(fact.from.accounts, fact.from.record?.source ?? null));
}

export function rangeOf(asked: { from?: string; to?: string }, settings: DaySettings, ends?: { first: string; last: string }): Range {
  const start = asked.from === undefined ? undefined : readTime("from", asked.from, settings);
  const end = asked.to === undefined ? undefined : readTime("to", asked.to, settings);
  const later = (left: string, right: string) => (left > right ? left : right);
  const earlier = (left: string, right: string) => (left < right ? left : right);
  const from_ms = start?.start_ms ?? dayBounds(earlier(ends?.first ?? "9999-12-31", civilDay(end!.start_ms, settings)), settings).start_ms;
  const to_ms = end !== undefined ? (end.day ? end.end_ms : end.start_ms) : dayBounds(later(ends?.last ?? "0000-01-01", civilDay(start!.start_ms, settings)), settings).end_ms;
  if (to_ms <= from_ms) refused("BAD_PARAMETER", "`to` is not after `from`");
  const from = civilDay(from_ms, settings), to = civilDay(to_ms - 1, settings);
  const fromWhole = dayBounds(from, settings).start_ms === from_ms, toWhole = dayBounds(to, settings).end_ms === to_ms;
  const whole = fromWhole && toWhole;
  const first = fromWhole ? from : addDays(from, 1), last = toWhole ? to : addDays(to, -1);
  return {
    from, to, from_ms, to_ms, whole, wholeDays: first <= last ? { from: first, to: last } : null,
    stated: whole ? { from, to } : { from: instantIn(from_ms, settings.zone), to: instantIn(to_ms, settings.zone) },
  };
}

export function stretchOf(asked: { from?: string; to?: string; families?: readonly ContractFamily[]; products?: readonly string[] }, settings: DaySettings): Stretch {
  return { ...rangeOf(asked, settings), families: asked.families ?? null, products: asked.products ?? null };
}

function spoken(atom: ChatAtom): { from?: string; text: string } {
  const name = atom.names?.[0];
  if (name !== undefined && name.start === 0 && atom.text.slice(name.end, name.end + 2) === ": ") return { from: atom.text.slice(0, name.end), text: atom.text.slice(name.end + 2) };
  const colon = atom.text.indexOf(": ");
  return colon > 0 ? { from: atom.text.slice(0, colon), text: atom.text.slice(colon + 2) } : { text: atom.text };
}

function placeOf(call: Call, slug: string): OnePlace | undefined {
  const file = call.placesIfReady() ?? refused("INDEX_BUILDING", "your places are being prepared", { building: ["places"] });
  const row = file.value<{ place: Record<string, unknown> }>("place", slug);
  return row === undefined ? undefined : onePlaceOf(row.place);
}

function chatSpanOf(call: Call, key: string): { first: string; last: string } | null | "capped" {
  const counts = call.peopleCounts();
  const reached = counts.reach({ chat: key });
  counts.tellPassed();
  if (reached === undefined) return "capped";
  const messages = reached.reach.messages;
  return messages === undefined || messages[0] === 0 ? null : { first: messages[1], last: messages[2] };
}

export function onePlaceOf(place: Record<string, unknown>): OnePlace {
  const members = ["slug", "name", "latitude", "longitude", "radius_m", "also", "ids", "area", "days", "hours", "first_ms", "last_ms", "visits_count", "nights", "here",
    "part_of", "inside", "ask_home", "rhythm", "visits", "photos", "photos_count", "people", "home"];
  return Object.fromEntries(members.filter((name) => place[name] !== undefined).map((name) => [name, place[name]])) as unknown as OnePlace;
}
