import { dayBounds, DAYS_MARK, digest, sha256, type DayRow as ListedDay, type DaySettings, type ExtractRow, type OpenView, type RecordRef } from "@lifestreamprotocol/core";
import {
  CALLAUDIO_FAMILY, callAudioAnswers, callAudioView, dayPage, moment, namesOf, PHYSICAL, REACH_DAYS, resolvedPlace, saidOf, where,
  type Block, type CallParty, type Chapter, type ChapterHead, type Conversation, type DayDocument, type DayExtras, type DayName, type DayPage, type DayRow,
  type DayWords, type EpisodesExtras, type KnownPerson, type KnownPlace, type Labels, type MomentMade, type Piece, type RecordText, type SidePlace, type WherePiece,
} from "@lifestreamprotocol/families";
import type { AnswerOf, Body, DayCount, DayRow as PageRow, DayRun, PageHandler } from "./pages.js";
import { notNow, refuse, RETRY_SOON_S } from "./refusal.js";

export const LISTING = "The home is listing its days: try again in a moment.";
export const RENDERING_LINE = "This day is being written.";
export const BEFORE_HOME = "Before Lifestream’s first day";

const MINUTE_MS = 60_000;
const DAYS_LIMIT = 256;
const DAYS_MOST = 1024;
const NEEDS_KEPT = 16;
const HEALTH = "health";
const MAIL = "mail";
const MESSAGES = "messages";
const AI = "ai";
const CALLS = "calls";
const SLEEP_UNIT = /^(?:sleep|cycle)\//u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

type Days = AnswerOf<"days">;
type Day = AnswerOf<"day">;
type Thread = AnswerOf<"thread">;
type MomentAnswer = AnswerOf<"moment">;
type PageChapter = Day["chapters"][number];
type PageBlock = PageChapter["blocks"][number];
type PageSide = Day["side"];
type File = Pick<DayDocument, "day" | "zone" | "window" | "coverage" | "atoms">;
type Atom = DayDocument["atoms"][number];
type Products = NonNullable<DayExtras["products"]>;
type Spoken = Conversation["messages"][number];

export interface HeldPeople {
  readonly tag: string;
  list(): readonly KnownPerson[];
}

export interface DaysReads {
  viewed<T>(use: (view: OpenView) => T): T;
  people<T>(machine: string, view: OpenView, use: (people: HeldPeople | null) => T): T;
  day(): DaySettings;
  dayHead(day: string): string | null;
  dayFile(day: string): DayDocument | null;
  products(): { readonly digest: string; readonly products: Products };
  labels(view: OpenView): Labels;
  evidence(view: OpenView, day: string): ExtractRow[];
  places(view: OpenView): KnownPlace[];
  spots(machine: string, pieces: readonly Piece[]): (string | null)[];
  group(labels: Labels, chat: string): boolean;
  owners(view: OpenView): ReadonlyMap<string, string>;
  text(view: OpenView, ref: RecordRef): RecordText | null;
  account(view: OpenView, item: string): unknown;
  transcribed(view: OpenView, ref: RecordRef, now_ms: number): MomentMade | null;
  made(view: OpenView, asked: readonly { family: string; item: string }[], now_ms: number): MomentMade[];
  open(labels: Labels, chat: string): { readonly label: string; readonly href: string } | null;
  chat(view: OpenView, chat: string, day: string): { readonly chat: string; readonly conversation: Conversation | null };
}

interface Needs {
  readonly sleep: readonly string[];
  readonly mail: boolean;
  readonly chats: readonly string[];
  readonly calls: readonly Atom[];
  readonly located: boolean;
}

const settingsTag = (day: DaySettings): string => digest({ zone: day.zone, day_start_hour: day.day_start_hour });
const minuteOf = (ms: number): number => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

export function daysPage(reads: Pick<DaysReads, "viewed" | "day">): PageHandler<Days> {
  return {
    params: ["from", "to", "after", "limit"],
    open: (ask, use) => reads.viewed((view) => {
      const from = dayParam(ask.query, "from"), to = dayParam(ask.query, "to"), after = dayParam(ask.query, "after");
      const limit = limitOf(ask.query.get("limit"));
      if (view.tables.meta.get(DAYS_MARK) === undefined) notNow("busy", LISTING, RETRY_SOON_S);
      const rows = view.derived.days.page(from ?? undefined, to ?? undefined, after ?? undefined, limit + 1);
      const shown = rows.slice(0, limit);
      const written = view.derived.days.page(ask.today, ask.today, undefined, 1).length > 0;
      const newest = written ? ask.today : view.derived.days.page(undefined, undefined, undefined, Number.MAX_SAFE_INTEGER).at(-1)?.day ?? ask.today;
      const next = rows.length > limit ? shown.at(-1)!.day : null;
      return use({
        position: view.position(),
        counting: false,
        inputs: [sha256(JSON.stringify({ from, to, after, limit, opening: newest, next, rows: shown }))],
        build: () => ({ opening: newest, days: shown.map(listedOf), next }),
      });
    }),
  };
}

function listedOf(row: ListedDay): Body<Days>["days"][number] {
  return {
    day: row.day,
    counts: { total: row.counts.total, families: Object.entries(row.counts.per_family).sort(([left], [right]) => compare(left, right)).map(([family, count]) => ({ family, count })) },
  };
}

function neededBy(reads: Pick<DaysReads, "dayFile">): (day: string, inputs: string) => Needs | null {
  const needsKept = new Map<string, Needs>();
  return (day, inputs) => {
    const key = `${day} ${inputs}`;
    const held = needsKept.get(key);
    if (held !== undefined) return held;
    const file = reads.dayFile(day);
    if (file === null) return null;
    const made = needsIn(file);
    needsKept.set(key, made);
    if (needsKept.size > NEEDS_KEPT) needsKept.delete(needsKept.keys().next().value!);
    return made;
  };
}

export function dayPageOf(reads: DaysReads): PageHandler<Day> {
  const needsOf = neededBy(reads);
  return {
    params: ["day"],
    open: (ask, use) => reads.viewed((view) => {
      const day = ask.query.get("day") ?? refuse(422, "BAD_PARAMETER", "day names the day, YYYY-MM-DD");
      if (!DAY.test(day)) refuse(422, "BAD_PARAMETER", "day is a civil day, YYYY-MM-DD");
      const settings = reads.day();
      const window = dayBounds(day, settings);
      const minute = minuteOf(ask.now_ms);
      const now = window.start_ms <= minute && minute < window.end_ms ? minute : null;
      const head = reads.dayHead(day);
      const needs = head === null ? null : needsOf(day, head);
      const clocked = [settingsTag(settings), digest({ day, now })];
      if (head === null || needs === null) {
        const state = view.derived.days.page(day, day, undefined, 1).length > 0 ? "rendering" as const : "empty" as const;
        const first = view.derived.days.page(undefined, undefined, undefined, 1)[0]?.day ?? null;
        const before = state === "empty" && first !== null && day < first;
        return use({
          position: view.position(), inputs: [digest({ state, before }), ...clocked], counting: false,
          build: () => unwritten(day, settings, state, now, before),
        });
      }
      return reads.people(ask.machine, view, (people) => {
        const extras = extrasOf(reads, view, ask.machine, day, window, needs, now);
        const tag = sha256(JSON.stringify({ ...extras, products: extras.products.digest }));
        return use({
          position: view.position(),
          counting: false,
          inputs: [digest({ head }), tag, people?.tag ?? "no people", ...clocked],
          build: () => {
            const file = reads.dayFile(day) ?? refuse(404, "DAY_UNKNOWN", `no files for ${day}`);
            return dayBody(day, dayPage(file, { ...extras, products: extras.products.products, people: people === null ? [] : [...people.list()] }, now));
          },
        });
      });
    }),
  };
}

function needsIn(file: Pick<DayDocument, "atoms">): Needs {
  const sleep = new Set<string>(), chats = new Set<string>(), calls = new Map<string, Atom>();
  let mail = false, located = false;
  for (const atom of file.atoms) {
    if (atom.family === HEALTH && atom.flags.includes("heading") && SLEEP_UNIT.test(atom.unit)) sleep.add(atom.unit);
    if (atom.family === MAIL) mail = true;
    if (atom.family === PHYSICAL) located = true;
    if (atom.family === MESSAGES && atom.block !== undefined) chats.add(atom.block.key);
    if (atom.family === CALLS && atom.record !== undefined) calls.set(`${atom.record.source} ${atom.record.kind} ${atom.record.key}`, atom);
  }
  return { sleep: [...sleep], mail, chats: [...chats], calls: [...calls.values()], located };
}

type Joined = Omit<DayExtras, "products" | "people"> & { products: { digest: string; products: Products } };

function episodesExtrasOf(reads: DaysReads, view: OpenView, day: string, window: { start_ms: number; end_ms: number }, needs: Needs, now: number | null, labels: Labels): Omit<EpisodesExtras, "products"> {
  const sleep: Record<string, { start_ms: number; end_ms: number }> = {};
  for (const unit of needs.sleep) {
    const night = nightOf(view.extract(HEALTH, unit)?.content, window);
    if (night !== null) sleep[unit] = night;
  }
  return {
    sleep,
    sent: needs.mail ? sentOf(view, day, reads.owners(view)) : [],
    groups: needs.chats.filter((chat) => reads.group(labels, chat)),
    ...(now === null ? {} : { sources: view.sources().map(({ id, read_through_ms }) => ({ id, read_through_ms })) }),
  };
}

function extrasOf(reads: DaysReads, view: OpenView, machine: string, day: string, window: { start_ms: number; end_ms: number }, needs: Needs, now: number | null): Joined {
  const labels = reads.labels(view);
  const calls = needs.calls.flatMap(({ record: ref }): CallParty[] => {
    if (ref === undefined) return [];
    const text = reads.text(view, ref);
    return text === null ? [] : [{ record: ref, who: (text.who ?? []).map(String).filter(Boolean), title: text.title ?? "" }];
  });
  return {
    ...episodesExtrasOf(reads, view, day, window, needs, now, labels),
    products: reads.products(),
    where: needs.located ? whereOf(reads, view, machine, day, window, labels, now) : [],
    places: needs.located ? reads.places(view) : [],
    calls,
  };
}

function nightOf(content: unknown, window: { start_ms: number; end_ms: number }): { start_ms: number; end_ms: number } | null {
  const held = content as { kind?: unknown; start_ms?: number; end_ms?: number; sleeps?: { nap?: boolean; start_ms: number; end_ms: number }[] } | null | undefined;
  if (held?.kind === "sleep") return { start_ms: held.start_ms!, end_ms: held.end_ms! };
  if (held?.kind !== "cycle") return null;
  const night = (held.sleeps ?? []).find((sleep) => !sleep.nap && sleep.end_ms >= window.start_ms && sleep.end_ms < window.end_ms);
  return night === undefined ? null : { start_ms: night.start_ms, end_ms: night.end_ms };
}

function sentOf(view: OpenView, day: string, owners: ReadonlyMap<string, string>): string[] {
  return view.extractsOn(MAIL, day).flatMap(({ content }) => {
    const held = content as { source?: unknown; mails?: { key: string; from?: { address?: unknown } }[] } | null;
    const owner = (owners.get(String(held?.source)) ?? "").toLowerCase();
    return (held?.mails ?? []).filter((mail) => String(mail.from?.address ?? "").toLowerCase() === owner).map((mail) => `${String(held?.source)} ${mail.key}`);
  });
}

function piecesOf(reads: DaysReads, view: OpenView, day: string, window: { start_ms: number; end_ms: number }, labels: Labels, now: number | null): Piece[] {
  const span = { start_ms: window.start_ms, end_ms: Math.min(window.end_ms, now ?? Infinity) };
  return span.end_ms <= span.start_ms ? [] : where(reads.evidence(view, day), span, labels, REACH_DAYS, reads.day());
}

function slugsOf(pieces: readonly Piece[], labels: Labels): Map<string, string> {
  const found = new Map<string, string>();
  for (const piece of pieces) {
    const slug = piece.kind === "stay" && piece.point !== null ? resolvedPlace(piece.point, labels)[2] : null;
    if (slug !== null) for (const unit of piece.units) if (!found.has(unit)) found.set(unit, slug);
  }
  return found;
}

function whereOf(reads: DaysReads, view: OpenView, machine: string, day: string, window: { start_ms: number; end_ms: number }, labels: Labels, now: number | null): WherePiece[] {
  const pieces = piecesOf(reads, view, day, window, labels, now);
  if (!pieces.length) return [];
  const names = namesOf(pieces, labels);
  const spots = reads.spots(machine, pieces);
  return pieces.map((piece, at) => {
    const [, , slug, name] = piece.kind === "stay" && piece.point !== null ? resolvedPlace(piece.point, labels) : [0, 0, null, null];
    return { ...piece, names: names[at]!, place: slug === null ? null : { slug, name: name ?? slug }, spot: spots[at] ?? null };
  });
}

function unwritten(day: string, settings: DaySettings, state: "rendering" | "empty", now: number | null, before: boolean): Body<Day> {
  const file: File = { day, zone: settings.zone, window: dayBounds(day, settings), coverage: [], atoms: [] };
  const page = dayPage(file, { where: [], places: [], people: [], calls: [] }, now);
  return { ...dayBody(day, page), state, line: state === "rendering" ? RENDERING_LINE : page.line, before_home: before ? BEFORE_HOME : null };
}

export function dayBody(day: string, page: DayPage): Body<Day> {
  return {
    day,
    state: page.state,
    line: page.line,
    now_ms: page.now_ms,
    updated_ms: page.updated_ms,
    all_day: page.all_day.map(rowOf),
    chapters: page.chapters.map(chapterOf),
    also: page.also === null ? null : { folded: page.also.folded, names: page.also.names.map(nameOf), rows: page.also.rows.map(rowOf) },
    plans: page.plans.map(rowOf),
    until_ms: page.until_ms,
    now_divider: page.now_divider,
    end_ms: page.end_ms,
    before_home: page.before_home,
    side: sideOf(page.side),
  };
}

function runOf(run: DayWords): DayRun {
  switch (run.type) {
    case "text": return { type: "text", text: run.text, tone: run.tone, title: "title" in run };
    case "quote": return { type: "quote", text: run.text };
    case "list": return { type: "list", items: [...run.items] };
    case "span": return { type: "span", text: run.text, tone: run.tone, start_ms: run.start_ms, end_ms: run.end_ms };
    case "titles": return { type: "titles", items: [...run.items] };
    case "tiles": return {
      type: "tiles", more: run.more,
      photos: run.photos.map((photo) => ({ item: photo.item, hash: photo.hash, at_ms: photo.at_ms, video: photo.video, duration_ms: photo.duration_ms, live: photo.live === true })),
    };
  }
}

function countOf(count: DayRow["count"]): DayCount | null {
  if (count === null) return null;
  if ("text" in count) return { kind: "words", text: count.text };
  return "sent" in count ? { kind: "sent", count: count.sent } : { kind: "received", count: count.received };
}

const nameOf = (name: DayName): Day["chapters"][number]["names"][number] => ({ text: name.text, first_row: name.firstRowId, at_ms: name.at_ms });

function rowOf(row: DayRow): PageRow {
  return {
    key: row.key, kind: row.kind, at_ms: row.at_ms, end_ms: row.end_ms, icon: row.icon, name: row.name, note: row.note, words: row.words.map(runOf),
    count: countOf(row.count), quiet: row.quiet, focus: row.focus, divider: row.divider,
  };
}

function headOf(head: ChapterHead | null): PageChapter["head"] {
  if (head === null) return null;
  return {
    title: head.title, line: head.line, place: head.place, stated_by: head.stated_by, since_ms: head.since_ms, icon: head.icon, quiet: head.quiet,
    words: head.words.map(runOf), length: head.length,
  };
}

function blockOf(block: Block): PageBlock {
  return {
    key: block.key, kind: block.kind, start_ms: block.start_ms, title: block.title, line: block.line, count: countOf(block.count), folded: block.folded,
    rows: block.rows.map(rowOf), divider: block.divider,
  };
}

function chapterOf(chapter: Chapter): PageChapter {
  return {
    key: chapter.key, kind: chapter.kind, episode: chapter.episode, head: headOf(chapter.head), start_ms: chapter.start_ms, end_ms: chapter.end_ms,
    folded: chapter.folded, names: chapter.names.map(nameOf),
    photos: chapter.photos.map((photo) => ({ hash: photo.hash, at_ms: photo.at_ms, alt: photo.alt, video: photo.video, duration_ms: photo.duration_ms })),
    blocks: chapter.blocks.map(blockOf), divider: chapter.divider,
  };
}

function placeOf(place: SidePlace): PageSide["places"][number] {
  return {
    key: place.key, slug: place.slug, name: place.name, line: place.line, home: place.home, quiet: place.quiet, ms: place.ms, length: place.length,
    spoken: place.spoken, point: { latitude: place.point.latitude, longitude: place.point.longitude, id: place.point.id ?? null }, radius_m: place.radius_m,
    rows: [...place.rows],
  };
}

function sideOf(side: DayPage["side"]): PageSide {
  const runs = (each: { runs: readonly { glyph: "message" | "call" | "call-missed"; value: string; quiet: boolean }[] }) =>
    each.runs.map(({ glyph, value, quiet }) => ({ glyph, value, quiet }));
  return {
    figures: side.figures.map(({ key, value, words }) => ({ key, value, words })),
    located: side.located,
    places: side.places.map(placeOf),
    people: side.people.map((person) => ({ key: person.key, person: person.person, name: person.name, photo: person.photo, runs: runs(person), spoken: person.spoken, rows: [...person.rows] })),
    groups: side.groups.map((group) => ({ chat: group.chat, title: group.title, runs: runs(group), spoken: group.spoken, quiet: group.quiet, rows: [...group.rows] })),
    unreturned: side.unreturned.map(({ key, at_ms, person, name }) => ({ key, at_ms, person, name })),
  };
}

export function momentPage(reads: DaysReads): PageHandler<MomentAnswer> {
  const needsOf = neededBy(reads);
  return {
    params: ["day", "focus", "whole", "marks"],
    open: (ask, use) => reads.viewed((view) => {
      const day = ask.query.get("day") ?? refuse(422, "BAD_PARAMETER", "day names the day, YYYY-MM-DD");
      if (!DAY.test(day)) refuse(422, "BAD_PARAMETER", "day is a civil day, YYYY-MM-DD");
      const focus = ask.query.get("focus") ?? refuse(422, "BAD_PARAMETER", "focus names a row (e<n>), an atom (a<n>), a unit (u:<unit>) or a record (rec:<source> <kind> <key>)");
      const whole = ask.query.get("whole");
      if (whole !== null && whole !== "1") refuse(422, "BAD_PARAMETER", "whole is 1 or absent");
      const marks = marksOf(ask.query.get("marks"));
      const settings = reads.day();
      const window = dayBounds(day, settings);
      const minute = minuteOf(ask.now_ms);
      const now = window.start_ms <= minute && minute < window.end_ms ? minute : null;
      const head = reads.dayHead(day);
      const needs = head === null ? null : needsOf(day, head);
      const file = needs === null ? null : reads.dayFile(day);
      const answer = (body: Body<MomentAnswer>) =>
        use({ position: view.position(), counting: false, inputs: [sha256(JSON.stringify(body)), settingsTag(settings), digest({ day, now })], build: () => body });
      if (file === null) return answer({ day, state: view.derived.days.page(day, day, undefined, 1).length > 0 ? "rendering" : "empty", moment: null });
      return reads.people(ask.machine, view, (people) => {
        const labels = reads.labels(view);
        const extras = { ...episodesExtrasOf(reads, view, day, window, needs!, now, labels), products: reads.products().products };
        let slugs: Map<string, string> | undefined;
        const found = moment(file, extras, { focus, whole: whole === "1", marks, today: ask.today }, {
          text: (ref) => reads.text(view, ref),
          account: (item) => reads.account(view, item),
          turns: (unit) => view.extract(AI, unit)?.content ?? null,
          open: (chat) => reads.open(labels, chat),
          place: (unit) => (slugs ??= needs!.located ? slugsOf(piecesOf(reads, view, day, window, labels, now), labels) : new Map()).get(unit) ?? null,
          made: (ref) => reads.transcribed(view, ref, ask.now_ms),
          calls: (other) => {
            const head = reads.dayHead(other);
            return head === null ? [] : [...needsOf(other, head)?.calls ?? []];
          },
          callAudio: (unit) => {
            const extract = view.extract(CALLAUDIO_FAMILY, unit);
            const heard = extract === undefined ? null : callAudioView(extract, callAudioAnswers(unit, (item, prompt) => view.enrichment(CALLAUDIO_FAMILY, item, prompt)), labels);
            if (heard === null) return null;
            const [summary, ...parts] = reads.made(view, [heard.summary_item, ...heard.asked].map((item) => ({ family: CALLAUDIO_FAMILY, item })), ask.now_ms);
            return { view: heard, parts, summary: summary?.ask ? summary : null };
          },
          people: () => people === null ? [] : people.list(),
        }, now);
        return answer({ day, state: found === null ? "gone" : "found", moment: found });
      });
    }),
  };
}

function marksOf(value: string | null): string[] | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed) || !parsed.every((each) => typeof each === "string")) refuse(422, "BAD_PARAMETER", "marks is a JSON list of focuses");
  return parsed as string[];
}

export function threadPage(reads: Pick<DaysReads, "viewed" | "chat" | "day">): PageHandler<Thread> {
  return {
    params: ["chat", "day"],
    open: (ask, use) => reads.viewed((view) => {
      const asked = ask.query.get("chat") ?? refuse(422, "BAD_PARAMETER", "chat names the chat, <network>:<chat id>");
      const day = ask.query.get("day") ?? refuse(422, "BAD_PARAMETER", "day names the day, YYYY-MM-DD");
      if (!DAY.test(day)) refuse(422, "BAD_PARAMETER", "day is a civil day, YYYY-MM-DD");
      const { chat, conversation } = reads.chat(view, asked, day);
      const body: Body<Thread> = { chat, day, title: conversation?.title ?? null, messages: conversation === null ? [] : threadMessages(chat, conversation) };
      return use({ position: view.position(), inputs: [sha256(JSON.stringify(body)), settingsTag(reads.day()), digest({ today: ask.today })], counting: false, build: () => body });
    }),
  };
}

const ME = "me";
const THE_USER = "the user";
const THE_GROUP = "the group";
const SAID = ": ";

const REACTIONS: Readonly<Record<string, string>> = { love: "❤️", like: "👍", dislike: "👎", laugh: "😂", emphasize: "‼️", question: "❓" };

const EVENTS: Readonly<Record<string, string>> = {
  "subject changed": "changed the group’s name",
  "description changed": "changed the group’s description",
  "disappearing messages timer": "changed disappearing messages",
  "group settings changed": "changed the group’s settings",
};

type Message = Body<Thread>["messages"][number];
type Part = NonNullable<Spoken["fact"]["parts"]>[number];

export function threadMessages(chat: string, conversation: Conversation): Message[] {
  const messages: Message[] = [];
  const byKey = new Map<string, Message>();
  const lines = new Map(conversation.messages.map(({ line, fact }) => [fact.key, line.text]));
  const parentOf = (key: string): Message | undefined => byKey.get(key) ?? [...byKey].find(([each]) => each.endsWith(key.slice(key.indexOf(":"))))?.[1];
  for (const message of conversation.messages) {
    const { line, fact } = message;
    const [said] = saidOf(chat, { title: conversation.title, messages: [message] }, 0);
    if (said === undefined) continue;
    const speaker = speakerOf(line.text);
    const name = speaker.name === THE_GROUP ? "" : speaker.name;
    const parts = fact.parts ?? [];
    const reaction = parts.find((part) => part.what.startsWith("reaction: "));
    if (reaction !== undefined && fact.reply_to !== undefined) {
      const reacted = reaction.what.slice("reaction: ".length);
      const removed = reacted.startsWith("removed ");
      const face = REACTIONS[reacted.replace(/^removed /u, "")] ?? "•";
      const by = { face, mine: said.mine, name: said.mine ? "" : name.split(" ")[0]! };
      const parent = parentOf(fact.reply_to);
      if (parent !== undefined && removed) parent.reactions = parent.reactions.filter((each) => each.face !== by.face || each.mine !== by.mine || each.name !== by.name);
      else if (parent !== undefined) parent.reactions.push(by);
      else if (!removed) messages.push({ ...plainOf(chat, said, name, fact.key), event: `reacted ${face} to an earlier message` });
      continue;
    }
    const built: Message = {
      ...plainOf(chat, said, name, fact.key),
      text: fact.text ?? "",
      forwarded: fact.forwarded === true,
      edited: fact.edited === true,
      gone: fact.withdrawn === true || parts.some((part) => part.what === "message unsent" || part.what === "message deleted"),
    };
    const words = bracketWords(line.text, fact);
    for (const [index, part] of parts.entries()) carried(built, part, words[index] ?? "");
    const silent = parts.length > 0 && parts.every((part) => part.what.startsWith("system event") || part.what === "group event"
      || (part.what.startsWith("group event, kind ") && built.event === null));
    if (silent && built.text === "") continue;
    if (fact.reply_to !== undefined) built.quote = quoteOf(parentOf(fact.reply_to), line.text, lines.get(fact.reply_to));
    byKey.set(fact.key, built);
    messages.push(built);
  }
  return messages;
}

function plainOf(chat: string, said: { mine: boolean; from: readonly string[]; at_ms: number }, name: string, key: string): Message {
  return {
    key, who: said.mine ? ME : said.from[0] ?? chat, name, text: "", at_ms: said.at_ms, mine: said.mine, forwarded: false, edited: false, gone: false,
    event: null, voice: null, pictures: [], video: null, sticker: null, missing: [], attachments: [], link: null, location: null, quote: null, reactions: [],
  };
}

function carried(message: Message, part: Part, words: string): void {
  const { what } = part;
  if (what === "photo") {
    if (part.blob !== undefined) message.pictures.push({ hash: part.blob, alt: words || "Photo" });
    else message.missing.push("photo");
  } else if (what === "video") {
    if (part.blob !== undefined) message.video = part.blob;
    else message.missing.push("video");
  } else if (what === "sticker") {
    if (part.blob !== undefined) message.sticker = part.blob;
  } else if (what === "voice note") {
    const seconds = part.seconds === undefined ? null : Math.max(0, Math.round(part.seconds));
    message.voice = { audio: part.blob ?? null, seconds, length: seconds === null ? null : lengthOf(seconds), transcript: transcriptOf(words) };
  } else if (what === "location" && part.lat !== undefined && part.lon !== undefined) {
    message.location = { name: words || "Shared location", latitude: part.lat, longitude: part.lon };
  } else if (what.startsWith("contact card")) {
    message.attachments.push({ icon: "person", name: what.slice("contact card: ".length) || "Contact", line: "Contact" });
  } else if (what.startsWith("document")) {
    message.attachments.push({ icon: "file", name: /^document: "([\s\S]*)"$/u.exec(what)?.[1] ?? "Document", line: part.media_type === "application/pdf" ? "PDF" : "Document" });
  } else if (what.startsWith("attachment (")) {
    message.attachments.push({ icon: "file", name: "Attachment", line: what.slice("attachment (".length, -1) });
  } else if (what.startsWith("link preview: \"")) {
    const href = /\bhttps?:\/\/[^\s<>"']+/u.exec(message.text)?.[0];
    if (href !== undefined) message.link = { title: what.slice("link preview: \"".length, -1), href };
  } else if (what.startsWith("group event, kind ")) {
    const meaning = /: (.*)$/u.exec(what)?.[1] ?? "";
    message.event = EVENTS[meaning] ?? message.event;
  }
}

function quoteOf(parent: Message | undefined, line: string, parentLine: string | undefined): Message["quote"] {
  if (parent !== undefined) {
    return { mine: parent.mine, name: parent.name, text: parent.text || (parent.pictures.length > 0 ? "Photo" : parent.voice !== null ? "Voice note" : "") };
  }
  const replied = /\(reply to (.+?), (\d{1,2}:\d{2})\)/u.exec(line);
  const mine = replied?.[1] === THE_USER;
  return {
    mine,
    name: replied === null || mine ? "" : replied[1]!,
    text: parentLine !== undefined ? speakerOf(parentLine).words : replied !== null ? `A message at ${replied[2]}` : "An earlier message",
  };
}

function speakerOf(text: string): { name: string; words: string } {
  const colon = text.indexOf(SAID);
  return colon < 0 ? { name: "", words: text } : { name: text.slice(0, colon), words: text.slice(colon + SAID.length) };
}

function bracketWords(text: string, fact: Spoken["fact"]): string[] {
  const words: string[] = [];
  let from = text.indexOf(SAID) + SAID.length + (fact.forwarded === true ? "(forwarded) ".length : 0) + (fact.text?.length ?? 0);
  const parts = fact.parts ?? [];
  const starts = parts.map((part) => {
    const at = text.indexOf(`[${part.what}`, from);
    if (at >= 0) from = at + 1;
    return at;
  });
  for (const [index, part] of parts.entries()) {
    const start = starts[index]!;
    if (start < 0) {
      words.push("");
      continue;
    }
    const next = starts.slice(index + 1).find((at) => at >= 0) ?? text.length;
    const segment = text.slice(start, next).replace(/(?: \((?:reply to|to) [^)]*\))?(?: \(edited\))?\s*$/u, "");
    const inner = segment.slice(1, segment.lastIndexOf("]"));
    const head = `${part.what}${part.seconds === undefined ? "" : `, ${part.seconds} s`}`;
    words.push(inner.startsWith(`${head}: `) ? inner.slice(head.length + 2) : "");
  }
  return words;
}

const transcriptOf = (said: string): string => said === "no speech" ? "" : said.replace(/^"([\s\S]*)"$/u, "$1");

export function lengthOf(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function dayParam(query: URLSearchParams, name: string): string | null {
  const value = query.get(name);
  if (value !== null && !DAY.test(value)) refuse(422, "BAD_PARAMETER", `${name} is a civil day, YYYY-MM-DD`);
  return value;
}

function limitOf(value: string | null): number {
  if (value === null) return DAYS_LIMIT;
  const limit = /^\d{1,4}$/u.test(value) ? Number(value) : NaN;
  if (!(limit >= 1 && limit <= DAYS_MOST)) refuse(422, "BAD_PARAMETER", `limit is 1 to ${DAYS_MOST}`);
  return limit;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
