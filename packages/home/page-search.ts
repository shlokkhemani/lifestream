import { sha256 } from "@lifestreamprotocol/core";
import type { AnswerOf, Body, Opens, PageAsk, SearchRow, PageHandler, When } from "./pages.js";
import { refuse, Refusal } from "./refusal.js";
import { countOf, partialOf, type GroupCount, type Kind, type KindsAnswer, type KindsHit, type KindsPage, type MatchedWindow, type Sitting, type TopRow, type Track } from "./kinds-contract.js";
import type { Citation, Family } from "./search-contract.js";
import { amount } from "./stream-words.js";

export interface SearchReads {
  position(): string;
  kinds(ask: PageAsk, query: URLSearchParams): Promise<KindsAnswer | KindsPage>;
  described(ask: PageAsk, refs: readonly string[]): Promise<ReadonlyMap<string, Citation>>;
  people(ask: PageAsk, handles: readonly string[]): ReadonlyMap<string, Listed>;
  building(machine: string): { done: number; of: number } | null;
  product(id: string): string;
  newestDay(month: string, today: string): string | null;
}

type Search = AnswerOf<"search">;
type SearchKind = AnswerOf<"searchKind">;
type Count = Search["total"];
type Reading = NonNullable<Search["reading"]>;
type Section = Search["kinds"][number];
type Fresh = { pending?: readonly { day: string }[]; pending_more?: number };
type Cited = (ref: string) => Opens | null;
type Listed = { readonly id: string; readonly photo: string | null };
type People = ReadonlyMap<string, Listed>;

const INDEX_BUILDING = "INDEX_BUILDING";
const WORDS = ["query", "from", "to", "typing"] as const;
const SEEING = [...WORDS, "see", "upcoming", "cursor"] as const;
const PRODUCT_NAMED: ReadonlySet<Family> = new Set(["ai"]);
const USER = "the user";
const YOU = "You";
const DOT = " · ";
const GETTING_READY = "Search is getting ready";
const STILL_READING = "Still reading";
const DAY: readonly [string, string] = ["day", "days"];
const MESSAGE: readonly [string, string] = ["message", "messages"];
const PLAY: readonly [string, string] = ["play", "plays"];
const WINDOW: readonly [string, string] = ["window", "windows"];
const SEE_OR_CURSOR = "a kind's page names its `see`, or the `cursor` a page of it gave";

const FAMILY_TITLES: Readonly<Record<Family, string>> = {
  messages: "Messages", mail: "Mail", calls: "Calls", callaudio: "Call recordings", calendar: "Calendar", notes: "Notes", ai: "AI chats", web: "Browsing", screen: "Mac",
  photos: "Photos", health: "Health", money: "Payments", physical: "Places", listening: "Listening", voice: "Voice notes", phone: "Phone",
};

export function searchPage(reads: SearchReads): PageHandler<Search> {
  return {
    params: WORDS,
    open: async (ask, use) => {
      const position = reads.position();
      const body = await searchBody(reads, ask);
      return use({ position, inputs: [sha256(JSON.stringify(body))], counting: false, build: () => body });
    },
  };
}

export function searchKindPage(reads: SearchReads): PageHandler<SearchKind> {
  return {
    params: SEEING,
    open: async (ask, use) => {
      if (!ask.query.has("see") && !ask.query.has("cursor")) refuse(422, "BAD_PARAMETER", SEE_OR_CURSOR);
      const position = reads.position();
      const body = await kindBody(reads, ask);
      return use({ position, inputs: [sha256(JSON.stringify(body))], counting: false, build: () => body });
    },
  };
}

async function kindsRead(reads: SearchReads, ask: PageAsk, readying: boolean): Promise<KindsAnswer | KindsPage | null> {
  try {
    return await reads.kinds(ask, ask.query);
  } catch (error) {
    if (readying && error instanceof Refusal && error.code === INDEX_BUILDING) return null;
    throw error;
  }
}

const isAnswer = (read: KindsAnswer | KindsPage): read is KindsAnswer => "top" in read;

async function searchBody(reads: SearchReads, ask: PageAsk): Promise<Body<Search>> {
  const found = await kindsRead(reads, ask, true);
  if (found === null) return { top: [], kinds: [], total: { n: 0, partial: false }, held: null, reading: readyingOf(reads.building(ask.machine)), nothing: null };
  if (!isAnswer(found)) throw new Error("a search without `see` or `cursor` answers its kinds");
  const opensOf = await citedBy(reads, ask, [
    ...found.top.map((row) => ("person" in row ? row.person.ref : "place" in row ? row.place.ref : row.hit.ref)),
    ...found.kinds.flatMap(refsOf),
  ]);
  const people = peopleOf(reads, ask, found.top, opensOf);
  const top = [...dateRows(reads, ask, found), ...found.top.map((row) => topRow(reads, row, opensOf, people))];
  const kinds = found.kinds.map((kind) => section(reads, kind, opensOf));
  return {
    top,
    kinds,
    total: countIn(found.total),
    held: found.held ?? null,
    reading: behind(found),
    nothing: top.length === 0 && kinds.length === 0 ? nothingWords(ask) : null,
  };
}

async function kindBody(reads: SearchReads, ask: PageAsk): Promise<Body<SearchKind>> {
  const see = ask.query.get("see") as Family | null;
  const page = await kindsRead(reads, ask, see !== null);
  if (page === null) {
    const family = see!;
    return { family, title: FAMILY_TITLES[family], upcoming: ask.query.has("upcoming"), rows: [], next: null, unread: null, reading: readyingOf(reads.building(ask.machine)), nothing: null };
  }
  if (isAnswer(page)) throw new Error("a search with `see` or `cursor` answers one kind's page");
  const opensOf = await citedBy(reads, ask, refsOf(page));
  const rows = rowsOf(reads, page, opensOf);
  const unread = "unread" in page && page.unread !== undefined ? page.unread : null;
  return {
    family: page.family,
    title: FAMILY_TITLES[page.family],
    upcoming: "upcoming" in page && page.upcoming === true,
    rows,
    next: "next" in page ? page.next : null,
    unread,
    reading: "pending" in page ? behind(page) : null,
    nothing: rows.length === 0 && unread === null && !ask.query.has("cursor") ? nothingWords(ask) : null,
  };
}

async function citedBy(reads: SearchReads, ask: PageAsk, refs: readonly string[]): Promise<Cited> {
  const cited = await reads.described(ask, refs);
  return (ref) => pageOpens(cited.get(ref));
}

function refsOf(kind: Kind | KindsPage): string[] {
  if ("hits" in kind) return kind.hits.map((hit) => hit.ref);
  if ("sittings" in kind && kind.sittings !== undefined) return kind.sittings.flatMap((sitting) => sitting.matched.map((window) => window.ref));
  return [];
}

function dateRows(reads: SearchReads, ask: PageAsk, found: KindsAnswer): SearchRow[] {
  if (found.day !== undefined) return [{ kind: "date", when: { kind: "day", day: found.day }, opens: { page: "days", day: found.day, focus: null } }];
  if (found.month !== undefined) return [{ kind: "date", when: { kind: "month", month: found.month }, opens: { page: "month", month: found.month, day: reads.newestDay(found.month, ask.today) } }];
  return [];
}

function peopleOf(reads: SearchReads, ask: PageAsk, top: readonly TopRow[], opensOf: Cited): People {
  const handles = top.flatMap((row) => {
    const opens = "person" in row ? opensOf(row.person.ref) : null;
    return opens?.page === "people" ? [opens.id] : [];
  });
  return handles.length === 0 ? new Map() : reads.people(ask, handles);
}

function topRow(reads: SearchReads, row: TopRow, opensOf: Cited, people: People): SearchRow {
  if ("person" in row) {
    const { ref, name, messages } = row.person;
    const opens = opensOf(ref);
    const listed = opens?.page === "people" ? people.get(opens.id) : undefined;
    return {
      kind: "person", ref, name, line: messages === undefined ? null : amount(messages, MESSAGE), picture: listed?.photo ?? null,
      opens: opens?.page === "people" && listed !== undefined ? { ...opens, person: listed.id } : opens,
    };
  }
  if ("place" in row) {
    const { ref, name, days } = row.place;
    return { kind: "place", ref, name, line: amount(days, DAY), opens: opensOf(ref) };
  }
  return hitRow(reads, row.hit, opensOf(row.hit.ref));
}

function section(reads: SearchReads, kind: Kind, opensOf: Cited): Section {
  const rows = rowsOf(reads, kind, opensOf);
  const n = "n" in kind ? kind.n : undefined;
  return {
    family: kind.family,
    title: FAMILY_TITLES[kind.family],
    count: n === undefined ? null : countIn(n),
    upcoming: "upcoming" in kind && kind.upcoming !== undefined ? countIn(kind.upcoming) : null,
    see: n !== undefined && (partialOf(n) || countOf(n) > rows.length),
    unread: "unread" in kind && kind.unread !== undefined ? kind.unread : null,
    rows,
  };
}

function rowsOf(reads: SearchReads, kind: Kind | KindsPage, opensOf: Cited): SearchRow[] {
  if ("hits" in kind) return kind.hits.map((hit) => hitRow(reads, hit, opensOf(hit.ref)));
  if ("tracks" in kind) return kind.tracks.map(trackRow);
  if ("sittings" in kind && kind.sittings !== undefined) return kind.sittings.map((sitting) => sittingRow(sitting, opensOf));
  return [];
}

const countIn = (count: GroupCount): Count => ({ n: countOf(count), partial: partialOf(count) });

const nothingWords = (ask: PageAsk): string => `Nothing matches “${(ask.query.get("query") ?? "").trim()}”.`;

function readyingOf(building: { done: number; of: number } | null): Reading {
  const percent = building === null || building.of <= 0 ? null : Math.min(99, Math.floor((100 * building.done) / building.of));
  return { state: "building", line: percent === null ? GETTING_READY : `${GETTING_READY}: ${percent}% read`, percent };
}

function behind(fresh: Fresh): Reading | null {
  const pending = fresh.pending ?? [];
  let newest: string | null = null;
  for (const each of pending) if (newest === null || each.day > newest) newest = each.day;
  if (newest === null) return null;
  const days = pending.length + (fresh.pending_more ?? 0);
  return { state: "behind", line: days === 1 ? STILL_READING : `${STILL_READING} ${amount(days, DAY)}, the newest`, newest: { kind: "day", day: newest } };
}

const oneLine = (words: string): string => words.replace(/\s+/gu, " ").trim();
const plain = (words: string): string => words.replace(/[«»]/gu, "");
const joined = (parts: readonly string[]): string | null => parts.filter((each) => each !== "").join(DOT) || null;

function whenOf(day: string | undefined, at: string | undefined): When | null {
  if (at !== undefined) return { kind: "at", at_ms: Date.parse(at) };
  return day === undefined ? null : { kind: "day", day };
}

export function hitRow(reads: Pick<SearchReads, "product">, hit: KindsHit, opens: Opens | null): SearchRow {
  const app = hit.product === undefined || !PRODUCT_NAMED.has(hit.family) ? "" : reads.product(hit.product);
  const whole = oneLine(hit.chat_title ?? hit.title ?? "");
  const prefix = `${app}${DOT.trimEnd()}`;
  const own = app !== "" && whole.startsWith(prefix) ? whole.slice(prefix.length).trim() : whole;
  return {
    kind: "hit",
    ref: hit.ref,
    family: hit.family,
    title: own !== "" ? own : app !== "" ? app : FAMILY_TITLES[hit.family],
    line: lineOf(hit, own === "" ? "" : app),
    when: whenOf(hit.day, hit.at),
    picture: hit.image ?? null,
    opens,
  };
}

function lineOf(hit: KindsHit, app: string): string | null {
  const snippet = oneLine(hit.snippet ?? "");
  const from = hit.from === undefined ? "" : hit.from === USER ? YOU : hit.from;
  switch (hit.family) {
    case "messages": {
      const speaker = from !== "" && from.toLocaleLowerCase() !== (hit.chat_title ?? "").trim().toLocaleLowerCase() ? from : "";
      return (speaker === "" ? snippet : `${speaker}: ${snippet}`) || null;
    }
    case "mail":
      return joined([from, snippet]);
    case "ai":
      return joined([app, from === YOU && snippet !== "" ? `${YOU}: ${snippet}` : snippet]);
    default:
      return snippet || null;
  }
}

function trackRow(track: Track): SearchRow {
  return { kind: "track", ref: track.ref, title: track.track, artist: track.artist ?? null, line: joined([amount(track.plays, PLAY), track.artist ?? ""])! };
}

export function sittingRow(sitting: Sitting, opensOf: Cited): SearchRow {
  const first = sitting.matched[0];
  const title = oneLine(sitting.summary ?? first?.title ?? FAMILY_TITLES.screen) || FAMILY_TITLES.screen;
  const own = oneLine(sitting.snippet ?? "");
  const windows = amount(sitting.windows, WINDOW);
  return {
    kind: "sitting",
    key: sitting.focus ?? `at:${Date.parse(sitting.at)}`,
    title,
    line: first !== undefined ? joined([windows, first.app, oneLine(first.snippet)]) : own === "" || plain(own) === title ? null : own,
    said: own === "" ? null : own,
    when: { kind: "at", at_ms: Date.parse(sitting.at) },
    windows: sitting.matched.map((window) => windowRow(window, opensOf(window.ref))),
    windows_line: first === undefined ? null : sitting.matched.length < sitting.windows ? `${sitting.matched.length} of ${windows}` : windows,
    opens: { page: "days", day: sitting.day, focus: sitting.focus ?? null },
  };
}

function windowRow(window: MatchedWindow, opens: Opens | null): Extract<SearchRow, { kind: "sitting" }>["windows"][number] {
  return { ref: window.ref, app: window.app, title: oneLine(window.title) || window.app, line: joined([window.app, oneLine(window.snippet)]), when: whenOf(undefined, window.at), opens };
}

function pageOpens(cited: Citation | undefined): Opens | null {
  if (cited === undefined || cited.kind === "gone") return null;
  const { opens } = cited;
  switch (opens.page) {
    case "days": return { page: "days", day: opens.day, focus: opens.focus ?? null };
    case "people": return { page: "people", id: opens.id, person: opens.person ?? null, group: opens.group ?? null };
    case "places": return { page: "places", id: opens.id };
    case "read": return { page: "read" };
  }
}
