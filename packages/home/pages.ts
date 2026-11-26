import { NEED_REASONS, WAIT_REASONS } from "@lifestreamprotocol/connect";
import { digest, ENTITIES, RELEASE, sha256 } from "@lifestreamprotocol/core";
import { REQUEST_STATES } from "@lifestreamprotocol/model";
import { FEEDBACK_KINDS } from "./feedback.js";
import { BROKEN_REASONS, QUIET_REASONS, REQUIREMENTS, STATES } from "./health.js";
import * as shapes from "./search-contract.js";
import type { Leaf, Of, Schema, Shape } from "./search-contract.js";
import type { DeviceKind } from "./devices.js";
import type { Held } from "./reads.js";

export type Node =
  | { readonly of: "text"; readonly pattern: string | null }
  | { readonly of: "int"; readonly min: number; readonly max: number }
  | { readonly of: "num" }
  | { readonly of: "bool" }
  | { readonly of: "enum"; readonly values: readonly string[] }
  | { readonly of: "list"; readonly each: Shape<unknown>; readonly min: number; readonly max: number }
  | { readonly of: "nullable"; readonly inner: Shape<unknown> }
  | { readonly of: "object"; readonly members: Readonly<Record<string, Shape<unknown>>> }
  | { readonly of: "tagged"; readonly tag: string; readonly cases: Readonly<Record<string, Readonly<Record<string, Shape<unknown>>>>> }
  | { readonly of: "named"; readonly name: string; readonly inner: Shape<unknown> }
  | { readonly of: "kept" };

export interface PageShape<T> extends Shape<T> {
  readonly node: Node;
}

type Members = Readonly<Record<string, PageShape<unknown>>>;
type Flat<T> = { [K in keyof T]: T[K] } & {};
type Built<M extends Members> = Flat<{ -readonly [K in keyof M]: Of<M[K]> }>;
type Cases<K extends string, C extends Readonly<Record<string, Members>>> = { [N in keyof C & string]: Flat<{ [T in K]: N } & Built<C[N]>> }[keyof C & string];

const marked = <T>(inner: Shape<T>, node: Node): PageShape<T> => ({ ...inner, node });

const patternOf = (schema: Schema): string => String(schema.pattern);

export function text(leaf: Leaf = "free", pattern?: RegExp, what?: string): PageShape<string> {
  return marked(shapes.text(pattern, what, leaf), { of: "text", pattern: pattern?.source ?? null });
}

export const day: PageShape<string> = marked(shapes.day, { of: "text", pattern: patternOf(shapes.day.schema) });
export const month: PageShape<string> = marked(shapes.month, { of: "text", pattern: patternOf(shapes.month.schema) });
export const words = text();
export const label = text("label");
export const name = text("name");
export const id = text("id");
export const excerpt = text("excerpt");
export const picture = text("picture");
export const ref = text("ref");
export const cursor = text("cursor");

export function int(min = 0, max = Number.MAX_SAFE_INTEGER): PageShape<number> {
  return marked(shapes.int(min, max), { of: "int", min, max });
}

export const num: PageShape<number> = marked(shapes.num, { of: "num" });
export const bool: PageShape<boolean> = marked(shapes.bool, { of: "bool" });

export function oneOf<const V extends readonly [string, ...string[]]>(...values: V): PageShape<V[number]> {
  return marked(shapes.oneOf(...values), { of: "enum", values });
}

export function list<T>(each: PageShape<T>, min = 0, max = Number.MAX_SAFE_INTEGER): PageShape<T[]> {
  return marked(shapes.list(each, min, max), { of: "list", each, min, max });
}

export function nullable<T>(inner: PageShape<T>): PageShape<T | null> {
  return marked(shapes.nullable(inner), { of: "nullable", inner });
}

export function object<const M extends Members>(members: M): PageShape<Built<M>> {
  return marked(shapes.object(members) as Shape<Built<M>>, { of: "object", members });
}

export function tagged<const K extends string, const C extends Readonly<Record<string, Members>>>(tag: K, cases: C): PageShape<Cases<K, C>> {
  const objects = Object.fromEntries(Object.entries(cases).map(([each, members]) => [each, shapes.object({ ...members, [tag]: shapes.oneOf(each) })]));
  const parser = shapes.tagged(tag, objects) as Shape<Cases<K, C>>;
  return marked({ ...parser, schema: { ...parser.schema, discriminator: { propertyName: tag } } }, { of: "tagged", tag, cases });
}

export function named<T>(title: string, inner: PageShape<T>): PageShape<T> {
  return { ...inner, node: { of: "named", name: title, inner } };
}

export const kept: PageShape<unknown> = marked({ parse: (value) => value, schema: {} }, { of: "kept" });

export const When = named("When", tagged("kind", { day: { day }, month: { month }, at: { at_ms: int() }, clock: { at_ms: int() } }));
export type When = Of<typeof When>;

export const PhrasePart = named("PhrasePart", tagged("kind", { words: { words }, time: { time: When } }));
export type PhrasePart = Of<typeof PhrasePart>;
export type Phrase = PhrasePart[];
export const phrase = list(PhrasePart, 1);

export const Row = named("Row", object({ id, name, named: bool, face: bool, photo: nullable(picture), when: nullable(When), line: nullable(words), find: list(words) }));
export type Row = Of<typeof Row>;

export const ChatRow = named("ChatRow", object({ chat: id, title: name, photo: nullable(picture), when: nullable(When), line: nullable(words), find: list(words) }));
export type ChatRow = Of<typeof ChatRow>;

const TalkLine = named("TalkLine", object({ who: id, name, text: excerpt, forwarded: bool, at_ms: int(), mine: bool, n: int() }));

export const Talk = named("Talk", object({
  day, chat: id, title: name, group: bool, network: words, lines: list(TalkLine), folded: list(object({ line: words, lines: list(TalkLine) })), focus: id,
}));
export type Talk = Of<typeof Talk>;

const Entity = named("Entity", oneOf(...ENTITIES));
const Week = named("Week", object({ start: day, count: int(), day: nullable(day) }));
const HistoryYear = named("HistoryYear", object({ year: text("label", /^\d{4}$/u, "a year, YYYY"), count: int(), day: nullable(day) }));
const History = named("History", tagged("kind", {
  weeks: { weeks: list(Week, 1, 104), marked: nullable(int(0, 103)) },
  years: { years: list(HistoryYear, 2), total: int(), marked: nullable(int()) },
  facts: { total: int(), first: nullable(day) },
}));
const Month = named("Month", object({
  days: list(named("MonthDay", object({ day, count: int() })), 30, 30),
  count: int(),
  calls: nullable(object({ count: int(), words })),
  line: words,
  before: nullable(object({ day, joiner: words })),
}));
const HandleKind = named("HandleKind", oneOf("phone", "email", "jid", "network"));
const RecordHandle = named("RecordHandle", object({ kind: HandleKind, value: text() }));

const PersonRecord = named("PersonRecord", object({
  type: named("RecordType", oneOf("people.person")),
  slug: id,
  name: nullable(name),
  full_name: nullable(name),
  show: oneOf("name", "full_name"),
  entity: nullable(Entity),
  relationship: nullable(words),
  hidden: bool,
  me: bool,
  anchor: nullable(RecordHandle),
  handles: list(RecordHandle),
  excluded: list(RecordHandle),
  dismissed: list(id),
  also_called: list(name),
  merged_into: nullable(id),
}));

const Profile = named("Profile", object({ network: label, value: text() }));

const Details = named("Details", object({
  work: nullable(words),
  birthday: nullable(object({ month: int(1, 12), day: int(1, 31), year: nullable(int()) })),
  profiles: list(Profile),
  cleared: list(oneOf("work", "birthday", "profiles")),
}));

const Suggestion = named("Suggestion", object({
  id,
  kind: oneOf("handle", "full_name", "same", "entity", "work", "birthday", "profile"),
  value: text(),
  reasons: list(object({ reason: label, count: num })),
  ticked: bool,
  other: nullable(object({ id, name, photo: nullable(picture), named: bool, face: bool })),
}));

const State = named("State", oneOf(...STATES));
const HealthReason = named("HealthReason", oneOf(...[...new Set([...REQUIREMENTS, ...NEED_REASONS, "grant", ...WAIT_REASONS, ...BROKEN_REASONS, ...QUIET_REASONS])] as [string, ...string[]]));

export const Act = named("Act", tagged("do", {
  try: { label, need: id },
  skip: { label, need: id },
  "let-go": { label, need: id },
  import: { label, kind: id },
  read: { label, need: id, of: id },
  ignore: { label, need: id, of: id },
  turn: { label, ids: list(id) },
  signin: { label, of: id },
  refresh: { label, of: id },
  resume: { label, of: id },
  set: { label, member: id },
  grant: { label, unit: id, grant: id },
  open: { label, url: text() },
  copy: { label, text: text() },
  browser: { label, of: id },
  pair: { label },
  extension: { label },
  upload: { label },
  install: { label },
  storage: { label },
  vault: { label },
  verify: { label },
  report: { label, of: id },
}));
export type Act = Of<typeof Act>;

export const Health = named("Health", object({
  state: State, reason: nullable(HealthReason), words, since_ms: nullable(int()), next_ms: nullable(int()), acts: list(Act), detail: nullable(words), line: nullable(words),
}));
export type Health = Of<typeof Health>;

export const NEED_KINDS = ["password", "connect", "notice"] as const;

export const Need = named("Need", object({
  id, state: State, reason: nullable(HealthReason), words, since_ms: nullable(int()), next_ms: nullable(int()), acts: list(Act), detail: nullable(words), line: nullable(words),
  connector: nullable(id), streams: nullable(list(id)), copy: nullable(id), unit: nullable(id),
  at: nullable(object({ site: text(), open: nullable(text()), errand: nullable(text()) })),
  weight: oneOf("stopped", "advice"), banner: bool, dismissed: bool, kind: oneOf(...NEED_KINDS), about: nullable(words),
}));
export type Need = Of<typeof Need>;

export const StreamRow = named("StreamRow", object({
  ids: list(id, 1), joined: bool, name, icon: label, health: Health, line: words, time: nullable(When), more: list(words), last: nullable(When), act: nullable(Act), find: list(words),
}));
export type StreamRow = Of<typeof StreamRow>;

const AskAnswer = named("AskAnswer", oneOf("once", "always", "no"));
const AskState = named("AskState", oneOf(...REQUEST_STATES));

export const WaitingAsk = named("WaitingAsk", object({
  id, reader: id, name, by: oneOf("agent", "chat"),
  head: words, line: words, asked_line: phrase, under_line: phrase, says_title: words, wants: words, today: kept, under: nullable(words),
  reason: nullable(words), screen: nullable(words), adds: list(words), keeps: nullable(words),
  choices: list(object({ answer: AskAnswer, words })), editable: bool, default: AskAnswer,
  version: int(), proposed: kept, at_ms: int(), until_ms: int(), state: AskState, outcome: nullable(phrase),
}));
export type WaitingAsk = Of<typeof WaitingAsk>;

export const WaitingSignIn = named("WaitingSignIn", object({
  id, name, checked: bool, host: nullable(label), choices: list(int()), at_ms: int(), until_ms: int(),
  head: words, over_line: phrase, sentence: words, access: kept, view: kept, pick: words, pick_line: words, over: words, app: nullable(id), notice: words,
}));
export type WaitingSignIn = Of<typeof WaitingSignIn>;

const GuideLink = named("GuideLink", tagged("to", {
  web: { label, url: text("ref", /^https:\/\/[a-z0-9.-]+\/[^\s]*$/u, "an https address") },
  messages: { label },
}));
const GuideValue = named("GuideValue", object({ label, text: words, address: bool }));
const GuideStep = named("GuideStep", tagged("kind", {
  add: { title: words, where: words, path: list(label, 1, 5), values: list(GuideValue), then: nullable(words), open: nullable(GuideLink) },
  message: { title: words, line: words, value: GuideValue, open: nullable(GuideLink), next: nullable(label) },
  yes: {
    title: words, line: words, wait: words, hint: words, sees: words, other: words,
    wrong: words, finishing: words, unfinished: words, out: words, denied: words, reads: words,
  },
  name: { title: words, placeholder: label },
  sees: { title: words, make: label, sees: words, access: kept, view: kept },
  give: { title: words, where: nullable(words), path: list(label, 0, 5), then: nullable(words), warn: nullable(words), once: words, unknown: words },
  elsewhere: { title: words, line: words },
}));
const GuideAddress = named("GuideAddress", object({ title: words, line: words, ready: words, on: label }));
export const Guide = named("Guide", object({
  app: oneOf("claude", "chatgpt", "muse", "grok-bot", "instinct", "another"),
  name, mark: label, line: nullable(words), how: oneOf("sign-in", "key"),
  connected: nullable(id),
  head: words, need: words, hosts: list(label),
  address: nullable(GuideAddress),
  steps: list(GuideStep, 1, 3),
  done: object({ title: words, ask: nullable(object({ title: words, line: words, question: words })), open: nullable(GuideLink) }),
}));
export type Guide = Of<typeof Guide>;


export const Opens = named("Opens", tagged("page", {
  days: { day, focus: nullable(label) },
  month: { month, day: nullable(day) },
  people: { id, person: nullable(id), group: nullable(id) },
  places: { id },
  read: {},
}));
export type Opens = Of<typeof Opens>;

const Family = named("SearchFamily", oneOf(...shapes.FAMILIES));
const Count = named("Count", object({ n: int(), partial: bool }));
const Reading = named("Reading", tagged("state", {
  building: { line: words, percent: nullable(int(0, 99)) },
  behind: { line: words, newest: When },
}));
const SearchWindow = named("SearchWindow", object({ ref, app: label, title: words, line: nullable(excerpt), when: nullable(When), opens: nullable(Opens) }));

export const SearchRow = named("SearchRow", tagged("kind", {
  hit: { ref, family: Family, title: words, line: nullable(excerpt), when: nullable(When), picture: nullable(picture), opens: nullable(Opens) },
  person: { ref, name, line: nullable(words), picture: nullable(picture), opens: nullable(Opens) },
  place: { ref, name, line: words, opens: nullable(Opens) },
  date: { when: When, opens: Opens },
  track: { ref, title: words, artist: nullable(name), line: words },
  sitting: { key: id, title: words, line: nullable(excerpt), said: nullable(excerpt), when: When, windows: list(SearchWindow, 0, 3), windows_line: nullable(words), opens: Opens },
}));
export type SearchRow = Of<typeof SearchRow>;

const KindSection = named("KindSection", object({
  family: Family, title: words, count: nullable(Count), upcoming: nullable(Count), see: bool, unread: nullable(words), rows: list(SearchRow, 0, 3),
}));

const Frame = named("Frame", object({ north: num, south: num, east: num, west: num }));

const Circle = named("Circle", object({ latitude: num, longitude: num, radius_m: num }));
const Point = named("Point", object({ latitude: num, longitude: num }));

export const PlaceRow = named("PlaceRow", object({
  slug: id, name, line: nullable(words), when: nullable(When), spent: nullable(object({ day, hours: num })), find: list(words), latitude: num, longitude: num, radius_m: num,
  also: list(Circle), hours: num,
}));
export type PlaceRow = Of<typeof PlaceRow>;

const HomeAsk = named("HomeAsk", object({ line: words, since: When }));

export const SpotRow = named("SpotRow", object({
  key: id, latitude: num, longitude: num, line: words, find: list(words), when: nullable(When), photos: list(picture), photos_total: int(), ask: nullable(HomeAsk), city: nullable(words),
}));
export type SpotRow = Of<typeof SpotRow>;

const HiddenRow = named("HiddenRow", object({ key: id, latitude: num, longitude: num, hidden: When, line: nullable(words) }));
const PlaceVisit = named("PlaceVisit", object({ key: id, unit: id, day, start_ms: int(), end_ms: int(), focus: id, people: list(id) }));
const PlaceLink = named("PlaceLink", object({ slug: id, name }));
const PlacePerson = named("PlacePerson", object({ id, name, photo: nullable(picture), line: nullable(words) }));
const NamedCircle = named("NamedCircle", object({ slug: id, latitude: num, longitude: num, radius_m: num }));
const StayPoint = named("StayPoint", object({ latitude: num, longitude: num, count: int(1) }));

const DayKind = named("DayKind", oneOf(
  "stay", "move", "sleep", "workout", "sitting", "phone", "browsing", "conversation", "ai", "call", "mail_sent", "mail_received", "event", "note",
  "voice_note", "dictation", "search", "photos", "listening", "check_in", "payment", "other", "gap",
));

const Tile = named("Tile", object({ item: id, hash: picture, at_ms: nullable(int()), video: bool, duration_ms: nullable(int()), live: bool }));

const RunTone = named("RunTone", oneOf("secondary", "tertiary"));

export const DayRun = named("DayRun", tagged("type", {
  text: { text: words, tone: RunTone, title: bool },
  quote: { text: excerpt },
  list: { items: list(words) },
  span: { text: words, tone: RunTone, start_ms: int(), end_ms: int() },
  titles: { items: list(words) },
  tiles: { photos: list(Tile), more: int() },
}));
export type DayRun = Of<typeof DayRun>;

export const DayCount = named("DayCount", tagged("kind", { words: { text: words }, sent: { count: int() }, received: { count: int() } }));
export type DayCount = Of<typeof DayCount>;

const DayName = named("DayName", object({ text: words, first_row: id, at_ms: nullable(int()) }));

export const DayRow = named("DayRow", object({
  key: id, kind: DayKind, at_ms: nullable(int()), end_ms: nullable(int()), icon: label, name: words, note: words, words: list(DayRun), count: nullable(DayCount),
  quiet: bool, focus: nullable(id), divider: nullable(day),
}));
export type DayRow = Of<typeof DayRow>;

const DayBlock = named("DayBlock", object({
  key: id, kind: oneOf("hour", "run"), start_ms: int(), title: nullable(words), line: nullable(words), count: nullable(DayCount), folded: bool, rows: list(DayRow), divider: nullable(day),
}));

const DayChapter = named("DayChapter", object({
  key: id,
  kind: oneOf("stay", "move", "none", "day", "gap"),
  episode: nullable(id),
  head: nullable(object({
    title: words, line: nullable(words), place: nullable(id), stated_by: nullable(words), since_ms: nullable(int()), icon: label, quiet: bool, words: list(DayRun), length: nullable(words),
  })),
  start_ms: int(),
  end_ms: nullable(int()),
  folded: bool,
  names: list(DayName),
  photos: list(object({ hash: picture, at_ms: nullable(int()), alt: words, video: bool, duration_ms: nullable(int()) })),
  blocks: list(DayBlock),
  divider: nullable(day),
}));

const ContactRun = named("ContactRun", object({ glyph: oneOf("message", "call", "call-missed"), value: words, quiet: bool }));

const DaySide = named("DaySide", object({
  figures: list(named("SideFigure", object({ key: oneOf("asleep", "steps", "recovery", "sent", "received"), value: words, words }))),
  located: bool,
  places: list(named("SidePlace", object({
    key: id, slug: nullable(id), name, line: nullable(words), home: bool, quiet: bool, ms: int(), length: words, spoken: words,
    point: named("SidePoint", object({ latitude: num, longitude: num, id: nullable(id) })), radius_m: nullable(num), rows: list(id),
  }))),
  people: list(named("SidePerson", object({ key: id, person: nullable(id), name, photo: nullable(picture), runs: list(ContactRun), spoken: words, rows: list(id) }))),
  groups: list(named("SideGroup", object({ chat: id, title: name, runs: list(ContactRun), spoken: words, quiet: bool, rows: list(id) }))),
  unreturned: list(named("SideCall", object({ key: id, at_ms: int(), person: nullable(id), name }))),
}));

const DayMessage = named("DayMessage", object({
  key: id,
  who: id,
  name,
  text: excerpt,
  at_ms: int(),
  mine: bool,
  forwarded: bool,
  edited: bool,
  gone: bool,
  event: nullable(words),
  voice: nullable(object({ audio: nullable(picture), seconds: nullable(int()), length: nullable(words), transcript: excerpt })),
  pictures: list(object({ hash: picture, alt: excerpt })),
  video: nullable(picture),
  sticker: nullable(picture),
  missing: list(oneOf("photo", "video")),
  attachments: list(object({ icon: oneOf("person", "file"), name: words, line: words })),
  link: nullable(object({ title: words, href: words })),
  location: nullable(object({ name: words, latitude: num, longitude: num })),
  quote: nullable(object({ mine: bool, name, text: excerpt })),
  reactions: list(object({ face: words, mine: bool, name })),
}));

const MomentRecord = named("MomentRecord", object({ source: id, kind: label, key: id }));
const MomentFact = named("MomentFact", object({ label: words, value: words }));
const MomentTimed = named("MomentTimed", object({ start_ms: nullable(int()), end_ms: nullable(int()), text: excerpt }));
const MomentSite = named("MomentSite", object({ title: words, line: nullable(words), at_ms: nullable(int()), icon: label, href: nullable(words) }));
const MomentApp = named("MomentApp", object({ name: words, minutes: nullable(num) }));
const MomentAction = named("MomentAction", object({ at_ms: int(), what: excerpt }));
const Made = named("Made", object({
  by: nullable(words), at_ms: nullable(int()), state: named("MadeState", oneOf("done", "off", "needs", "waiting", "failed")), line: nullable(words),
  ask: nullable(named("MadeAsk", object({ family: label, item: id, prompt: id }))), choose: list(named("MadeStep", object({ value: id, words, note: nullable(words) }))),
}));

const MomentView = named("MomentView", tagged("view", {
  thread: { chat: nullable(id), group: bool },
  quiet: { chat: id },
  ai: { work: list(excerpt), turns: list(named("MomentTurn", object({ at_ms: nullable(int()), mine: bool, words: excerpt, full: bool, files: list(words), tools: list(words), marked: bool }))) },
  call: {
    figure: nullable(named("CallFigure", object({ length_ms: nullable(int()), words: nullable(words), label: words }))), group: words, name,
    others: list(named("OtherCall", object({ at_ms: int(), way: words, length_ms: nullable(int()) }))),
    week: nullable(named("CallWeek", object({
      current: bool, calls: list(named("WeekCall", object({ day, at_ms: int(), title: words, icon: label, length_ms: nullable(int()), focus: id }))),
    }))),
  },
  mail: {
    list: bool,
    letters: list(named("Letter", object({
      at_ms: nullable(int()), from: name, to: words, subject: excerpt, words: excerpt, attached: list(words), address: nullable(words), person: nullable(name), person_id: nullable(id), record: nullable(MomentRecord),
    }))),
  },
  stay: { today_ms: int(), unit: id, note: nullable(words), inside: list(MomentTimed) },
  move: { km: nullable(words), length_ms: nullable(int()), from: words, to: words, mode: nullable(words), legs: list(MomentTimed), note: nullable(words) },
  body: { label: words, length_ms: nullable(int()), bed_ms: nullable(int()), wake_ms: nullable(int()), facts: list(list(MomentFact)), vitals: list(words) },
  sitting: {
    account: nullable(named("ScreenAccount", object({
      narrative: excerpt, tasks: list(named("AccountTask", object({ task: words, seconds: int() }))), people: list(words), projects: list(words),
      steps: list(named("AccountStep", object({
        start_ms: int(), end_ms: int(), present: nullable(label), task: nullable(words), where: nullable(words), doing: nullable(excerpt), actions: list(MomentAction),
      }))),
      loose: list(MomentAction), actions: int(),
    }))),
    apps: list(MomentApp), sites: list(MomentSite), lines: list(MomentTimed),
  },
  apps: { total_ms: nullable(int()), apps: list(MomentApp), sites: list(MomentSite) },
  event: { plan: bool, where: nullable(named("EventWhere", object({ text: words, href: words }))), with: nullable(words), words: excerpt },
  note: { words: nullable(excerpt) },
  voice: { timed: bool, notes: list(named("VoiceNote", object({ at_ms: nullable(int()), words: excerpt, seconds: nullable(int()), record: nullable(MomentRecord), made: nullable(Made) }))) },
  photos: { lines: list(named("PhotoLine", object({ start_ms: nullable(int()), end_ms: nullable(int()), text: excerpt, video: bool }))) },
  listening: { tracks: list(words) },
  check_in: { head: nullable(words), median: nullable(words), lapses: nullable(words), facts: list(MomentFact), note: nullable(excerpt) },
  payment: { amount: nullable(words), direction: oneOf("in", "out"), facts: list(MomentFact) },
  lines: { lines: list(MomentTimed) },
}));

const DayMoment = named("DayMoment", object({
  key: id,
  row: id,
  kind: DayKind,
  icon: label,
  title: excerpt,
  name: excerpt,
  near: nullable(words),
  start_ms: nullable(int()),
  end_ms: nullable(int()),
  untimed: nullable(words),
  length_ms: nullable(int()),
  products: list(name),
  people: list(named("MomentPerson", object({ name, person: nullable(id), chat: nullable(id), call: nullable(MomentRecord) }))),
  place: nullable(named("MomentPlace", object({ name, unit: id, slug: nullable(id) }))),
  out: nullable(named("MomentOpen", object({ label: words, href: words }))),
  record: nullable(MomentRecord),
  letter: nullable(int()),
  marks: list(id),
  pictures: list(named("MomentPicture", object({ hash: picture, alt: excerpt, words: excerpt, video: bool, duration_ms: nullable(int()), live: bool }))),
  source: named("MomentSource", object({
    records: list(named("MomentSourceRecord", object({ source: id, kind: label, key: id, at_ms: nullable(int()) }))), more: int(),
    units: list(named("MomentUnit", object({ family: label, unit: id }))), atoms: int(), start_ms: nullable(int()), end_ms: nullable(int()),
  })),
  view: MomentView,
}));

export const FeedbackKind = named("FeedbackKind", oneOf(...FEEDBACK_KINDS));

export const FeedbackDraft = named("FeedbackDraft", object({
  attachments: list(named("FeedbackAttachment", object({ kind: FeedbackKind, title: words, text: text(), counts: kept }))),
  email: nullable(text()),
}));
export type FeedbackDraft = Of<typeof FeedbackDraft>;

export const REPLIES = { FeedbackDraft } as const satisfies Readonly<Record<string, PageShape<unknown>>>;

const Mail = named("Mail", object({ family: oneOf("mail", "calendar"), title: nullable(words), from: nullable(words), day: nullable(day) }));

const SettingsValue = named("SettingsValue", object({ id, label: nullable(label), value: nullable(phrase), signal: nullable(State) }));
const SettingsDevice = named("SettingsDevice", object({ id, name, icon: id, line: words, signal: nullable(State), removed: bool }));

const SettingsPick = named("SettingsPick", object({ words: label, value: id, chosen: bool, default: bool }));

export const SettingsEnd = named("SettingsEnd", tagged("kind", {
  value: { value: phrase, signal: nullable(State) },
  choice: { key: id, choices: list(object({ words: label, value: num, chosen: bool, default: bool }), 1) },
  pick: { key: id, choices: list(SettingsPick, 1) },
}));
export type SettingsEnd = Of<typeof SettingsEnd>;

export const SettingsRow = named("SettingsRow", object({ id, label, line: nullable(words), end: nullable(SettingsEnd) }));
export type SettingsRow = Of<typeof SettingsRow>;

const SettingsPart = named("SettingsPart", object({ label: nullable(label), line: nullable(words), rows: list(SettingsRow) }));

export const StorageTone = named("StorageTone", oneOf("s1", "s2", "s3", "s4", "s5", "other", "own", "uncounted", "disk", "free"));
export type StorageTone = Of<typeof StorageTone>;
const StoragePart = named("StoragePart", object({ id, name: label, tone: StorageTone, share: num, size: words }));
const StorageKey = named("StorageKey", object({ id, name: label, tone: StorageTone }));
const StorageBar = named("StorageBar", object({ label: words, parts: list(StoragePart), key: list(StorageKey), left: words }));
const StorageSeries = named("StorageSeries", object({ id, name: label, tone: StorageTone, bytes: list(num) }));
const StorageChart = named("StorageChart", object({
  label: phrase, first: day, parts: list(StorageSeries), rate: nullable(num), room: nullable(object({ bytes: num, name: label })),
}));
const StorageUse = named("StorageUse", object({
  id, part: id, name: label, tone: StorageTone, size: words, share: num, line: nullable(phrase), opens: nullable(id), folded: bool,
}));

export const MODELS_FOUND = 20;
const ModelUseId = named("ModelUseId", oneOf("pictures", "audio", "text", "chat", "search", "hiding"));
export const ModelRow = named("ModelRow", object({ value: id, name, account: nullable(name), chosen: bool }));
export type ModelRow = Of<typeof ModelRow>;
export const ModelGroup = named("ModelGroup", object({ label, rows: list(ModelRow, 1) }));
export type ModelGroup = Of<typeof ModelGroup>;
export const ModelMenu = named("ModelMenu", object({
  default: nullable(ModelRow), rows: list(ModelRow), local: nullable(ModelGroup), more: named("ModelMore", object({ words: label, use: ModelUseId, work: nullable(id) })),
  off: nullable(ModelRow),
}));
export type ModelMenu = Of<typeof ModelMenu>;
const ModelPlace = named("ModelPlace", object({ place: label, value: nullable(id), line: nullable(words), working: bool, ready: bool, leaves: bool }));
const ModelLevel = named("ModelLevel", object({ value: id, name, chosen: bool, suggested: bool }));
const ModelThinking = named("ModelThinking", object({ label, value: id, words, levels: list(ModelLevel, 1) }));
const ModelUse = named("ModelUse", object({
  use: ModelUseId,
  label, line: nullable(words), words, value: nullable(id), thinking: nullable(ModelThinking), menu: ModelMenu, places: list(ModelPlace),
}));
const ModelFileState = named("ModelFileState", oneOf("absent", "fetching", "ready", "failed"));
const ModelFileDo = named("ModelFileDo", oneOf("fetch", "remove", "cancel"));
const ModelFileAct = named("ModelFileAct", object({ act: ModelFileDo, words: label }));
const ModelFile = named("ModelFile", object({
  id, name, line: words, working: bool, state: ModelFileState, fits: bool, words: nullable(label), acts: list(ModelFileAct),
}));
const ModelFound = named("ModelFound", object({ name, size: words, from: label }));
const ModelSwitch = named("ModelSwitch", object({ label, on: bool, line: nullable(words) }));
const ModelKeyField = named("ModelKeyField", object({ label, placeholder: words, add: label, remove: label }));
const ModelServerWords = named("ModelServerWords", object({ about: words, add: label, remove: label, field: label, placeholder: words, save: label }));
const ModelConnection = named("ModelConnection", tagged("kind", {
  plan: { id, name, line: nullable(words), signed: bool, words: label },
  key: { id, name, line: nullable(words), held: bool, words: nullable(label), key: ModelKeyField },
  runner: {
    id, unit: id, place: label, name, line: nullable(words), none: nullable(words), run: nullable(ModelSwitch), battery: nullable(ModelSwitch),
    files: list(ModelFile), found: list(ModelFound), paused: bool,
  },
  address: { id, label, url: nullable(words), line: nullable(words), words: ModelServerWords },
}));

export const MOVES = ["people", "places", "streams", "days", "clock", "today", "storage"] as const;
export type Move = (typeof MOVES)[number];
export type Settled = "people" | "places";
export type Digest = string;

export interface PageAsk {
  readonly machine: string;
  readonly now_ms: number;
  readonly query: URLSearchParams;
  readonly today: string;
  readonly device: DeviceKind | null;
  readonly unit: string | null;
  readonly held: Held;
}

export interface PageContract<A> {
  readonly route: string;
  readonly shape: PageShape<A>;
  readonly today: boolean;
  readonly device: boolean;
  readonly moves: readonly Move[];
  readonly settled: Settled | null;
  readonly models: boolean;
}

export type Body<A> = Omit<A, "position" | "today" | "counting">;

export interface Opened<A> {
  readonly position: string;
  readonly inputs: readonly Digest[];
  readonly counting: boolean;
  build(): Body<A>;
}

export interface PageParams {
  readonly params: readonly string[];
}

export interface PageHandler<A> extends PageParams {
  open<T>(ask: PageAsk, use: (opened: Opened<A>) => T): T | Promise<T>;
}

export type Handlers = { readonly [N in PageName]?: PageHandler<AnswerOf<N>> };

type Framed = { readonly position?: never; readonly today?: never; readonly counting?: never };
type Answer<M extends Members, S extends Settled | null> = Flat<{ position: string; today: string } & Built<M> & (S extends null ? unknown : { counting: boolean })>;

const position = text("label", /^\d+:\d+$/u, "a position, seq:at_ms");

function page<const M extends Members & Framed, const S extends Settled | null>(spec: {
  readonly route: string;
  readonly members: M;
  readonly today: boolean;
  readonly device: boolean;
  readonly moves: readonly Move[];
  readonly settled: S;
  readonly models?: true;
}): PageContract<Answer<M, S>> {
  const shape = object({ position, today: day, ...spec.members, ...(spec.settled === null ? {} : { counting: bool }) });
  return {
    route: spec.route, shape: shape as PageShape<unknown> as PageShape<Answer<M, S>>, today: spec.today, device: spec.device, moves: spec.moves, settled: spec.settled,
    models: spec.models ?? false,
  };
}

export const PAGES = {
  people: page({
    route: "/v1/page/people",
    members: {
      you: nullable(Row),
      counts: object({ people: int(), groups: int() }),
      most: list(object({ id, line: words }), 0, 5),
      sections: list(object({ key: text("label", /^(?:month:\d{4}-\d{2}|year:\d{4}|none)$/u, "a section key, month:YYYY-MM, year:YYYY or none"), title: nullable(words), rows: list(Row) })),
      ai: list(Row),
      new: list(object({ id, line: words }), 0, 3),
      businesses: nullable(object({
        line: words,
        offered: list(object({ id, name, named: bool, photo: nullable(picture), why: nullable(words), handles: list(object({ id, words })) })),
      })),
      organise: object({ count: int(), line: nullable(words), queue: list(id), organised: int(), often: int() }),
      groups: object({ yours: list(ChatRow), quiet: list(ChatRow), quiet_line: nullable(words) }),
    },
    today: true,
    device: false,
    moves: ["people", "today"],
    settled: "people",
  }),
  person: page({
    route: "/v1/page/person",
    members: {
      became: nullable(id),
      me: bool,
      head: object({
        name,
        named: bool,
        full_name: nullable(name),
        photo: nullable(picture),
        chips: list(tagged("kind", {
          birthday: { month: int(1, 12), day: int(1, 31) },
          profile: { network: label, words, href: nullable(text()) },
        })),
        since: nullable(When),
        relationship: nullable(words),
        work: nullable(words),
        entity: Entity,
        entity_by: nullable(oneOf("you", "home")),
      }),
      handles: list(object({ id, kind: HandleKind, network: nullable(label), words, from: nullable(words), own: bool })),
      month: Month,
      history: History,
      talk: nullable(Talk),
      where: list(object({ chat: nullable(id), title: name, group: bool, network: words, when: nullable(When), count: int(), line: words, quiet: bool })),
      suggestions_line: nullable(words),
      edit: object({
        call: nullable(name),
        full_name: nullable(name),
        name_from: nullable(words),
        record_id: nullable(id),
        face: bool,
        reach: nullable(words),
        last: nullable(When),
        much: words,
        mails: object({ from: int(), to: int(), newest: nullable(list(Mail, 0, 6)) }),
        record: nullable(PersonRecord),
        details: nullable(Details),
        suggestions: list(Suggestion),
        also_called: list(object({ name, from: words })),
        names_seen: list(name),
        joined: list(object({ id, name, photo: nullable(picture), handles: list(words), with: list(words) })),
      }),
    },
    today: true,
    device: false,
    moves: ["people", "days", "today"],
    settled: "people",
  }),
  group: page({
    route: "/v1/page/group",
    members: {
      head: object({
        title: name, photo: nullable(picture), line: words, since: nullable(When),
        word: oneOf("rule", "always", "never"),
        quiet: bool,
        why: nullable(object({ words, since: nullable(When) })),
      }),
      total: int(),
      writers: list(object({ id, name, named: bool, photo: nullable(picture), share: words })),
      yours: nullable(words),
      talk: nullable(Talk),
    },
    today: true,
    device: false,
    moves: ["people", "days", "today"],
    settled: "people",
  }),
  peopleFind: page({
    route: "/v1/page/people/find",
    members: { rows: list(Row, 0, 6), profiles: list(Profile, 0, 2) },
    today: false,
    device: false,
    moves: [],
    settled: null,
  }),
  connectors: page({
    route: "/v1/connectors",
    members: {
      rows: list(StreamRow),
      needs: list(Need),
      badge: object({ needs: int(), asks: int() }),
      at_ms: kept, day: kept, products: kept, disk: kept, paused: kept, home: kept, devices: kept, extension: kept, connectors: kept, setup: kept, off: kept, imports: kept, adding: kept,
    },
    today: false,
    device: true,
    moves: ["streams"],
    settled: null,
    models: true,
  }),
  agentsWaiting: page({
    route: "/v1/agents/waiting",
    members: {
      requests: list(WaitingSignIn),
      asks: list(WaitingAsk),
    },
    today: false,
    device: false,
    moves: ["streams"],
    settled: null,
  }),
  agentGuides: page({
    route: "/v1/agents/guides",
    members: {
      title: words,
      apps: list(Guide, 6, 6),
    },
    today: false,
    device: true,
    moves: ["streams"],
    settled: null,
  }),
  search: page({
    route: "/v1/page/search",
    members: {
      top: list(SearchRow, 0, 4),
      kinds: list(KindSection),
      total: Count,
      held: nullable(object({ first: day, last: day })),
      reading: nullable(Reading),
      nothing: nullable(words),
    },
    today: false,
    device: false,
    moves: [],
    settled: null,
  }),
  searchKind: page({
    route: "/v1/page/search/kind",
    members: {
      family: Family,
      title: words,
      upcoming: bool,
      rows: list(SearchRow),
      next: nullable(cursor),
      unread: nullable(words),
      reading: nullable(Reading),
      nothing: nullable(words),
    },
    today: false,
    device: false,
    moves: [],
    settled: null,
  }),
  places: page({
    route: "/v1/page/places",
    members: {
      here: nullable(id),
      frame: nullable(Frame),
      cities: list(object({
        key: text("label", /^(?:city:.+|elsewhere)$/u, "a city key, city:<name> or elsewhere"), title: words, here: bool, when: nullable(When), since: nullable(When), point: Point,
        places: list(PlaceRow), once: list(PlaceRow),
      })),
      to_name: list(SpotRow),
      hidden: list(HiddenRow),
    },
    today: false,
    device: false,
    moves: ["places"],
    settled: "places",
  }),
  place: page({
    route: "/v1/page/place",
    members: {
      head: object({ name, line: nullable(words), since: nullable(When) }),
      here: bool,
      rhythm: nullable(words),
      stays: int(),
      visits: object({ count: int(), rows: list(PlaceVisit) }),
      people: list(PlacePerson),
      photos: object({ first: list(picture, 0, 4), total: int(), line: nullable(words) }),
      part_of: nullable(PlaceLink),
      inside: list(PlaceLink),
      ask_home: nullable(HomeAsk),
      clashes: list(object({ id, names: list(name) })),
    },
    today: false,
    device: false,
    moves: ["places"],
    settled: "places",
  }),
  placeEdit: page({
    route: "/v1/page/place/edit",
    members: {
      slug: id,
      circle: Circle,
      others: list(NamedCircle),
      points: list(StayPoint),
      held: int(),
      read: bool,
      line: nullable(words),
    },
    today: false,
    device: false,
    moves: ["places"],
    settled: "places",
  }),
  year: page({
    route: "/v1/page/year",
    members: {
      year: int(1, 9999),
      span: named("YearSpan", object({ first: int(1, 9999), last: int(1, 9999) })),
      trips: list(object({ title: words, nights: words, range: object({ first: day, last: day }), route: list(name), guessed: bool, days: list(named("TripDay", object({ day, line: words }))) })),
      figures: list(object({ count: int(), words })),
      cities: list(object({ name, nights: int(), point: nullable(Point), country: nullable(words), base: bool })),
      base: nullable(object({ name, nights: int() })),
    },
    today: false,
    device: false,
    moves: ["places"],
    settled: null,
  }),
  days: page({
    route: "/v1/page/days",
    members: {
      opening: day,
      days: list(named("WrittenDay", object({ day, counts: object({ total: int(), families: list(object({ family: label, count: int() })) }) }))),
      next: nullable(day),
    },
    today: true,
    device: false,
    moves: ["days", "clock", "today"],
    settled: null,
  }),
  day: page({
    route: "/v1/page/day",
    members: {
      day,
      state: named("DayState", oneOf("ready", "rendering", "empty")),
      line: nullable(words),
      now_ms: nullable(int()),
      updated_ms: nullable(int()),
      all_day: list(DayRow),
      chapters: list(DayChapter),
      also: nullable(object({ folded: bool, names: list(DayName), rows: list(DayRow) })),
      plans: list(DayRow),
      until_ms: nullable(int()),
      now_divider: nullable(day),
      end_ms: nullable(int()),
      before_home: nullable(words),
      side: DaySide,
    },
    today: true,
    device: false,
    moves: ["days", "clock", "today"],
    settled: null,
  }),
  moment: page({
    route: "/v1/page/moment",
    members: {
      day,
      state: named("MomentState", oneOf("found", "gone", "rendering", "empty")),
      moment: nullable(DayMoment),
    },
    today: true,
    device: false,
    moves: ["days", "clock", "today"],
    settled: null,
  }),
  thread: page({
    route: "/v1/page/thread",
    members: {
      chat: id,
      day,
      title: nullable(name),
      messages: list(DayMessage),
    },
    today: false,
    device: false,
    moves: ["people", "days", "clock"],
    settled: null,
  }),
  feedback: page({
    route: "/v1/page/feedback",
    members: {
      open: bool,
      title: words,
      about: object({ chat: words, connector: words }),
      field: object({ placeholder: words, max: int(1) }),
      email: object({ label, placeholder: words }),
      kinds: list(object({ kind: FeedbackKind, title: words, add: nullable(label) })),
      see: label,
      send: label,
      clear: label,
      sent: object({ title: words, line: nullable(words) }),
      again: words,
      privacy: words,
    },
    today: false,
    device: false,
    moves: [],
    settled: null,
  }),
  settings: page({
    route: "/v1/page/settings",
    members: { you: nullable(Row), values: list(SettingsValue), devices: list(SettingsDevice), removed: label },
    today: false,
    device: true,
    moves: ["streams", "people"],
    settled: null,
  }),
  settingsPage: page({
    route: "/v1/page/settings/page",
    members: { id, title: label, line: nullable(words), parts: list(SettingsPart) },
    today: true,
    device: true,
    moves: ["streams", "today"],
    settled: null,
  }),
  storage: page({
    route: "/v1/page/storage",
    members: {
      title: label,
      counted: bool,
      figure: words,
      after: words,
      disk: words,
      growth: label,
      sentence: phrase,
      bar: StorageBar,
      chart: nullable(StorageChart),
      used: label,
      uses: list(StorageUse),
      more: nullable(words),
      fewer: label,
      keep: object({ label, line: words, size: words }),
    },
    today: true,
    device: true,
    moves: ["storage", "today"],
    settled: null,
  }),
  modelDefaults: page({
    route: "/v1/page/models/defaults",
    members: { uses: list(ModelUse, 6, 6) },
    today: false,
    device: false,
    moves: ["streams"],
    settled: null,
  }),
  modelProviders: page({
    route: "/v1/page/models/providers",
    members: { accounts: label, connections: list(ModelConnection) },
    today: false,
    device: false,
    moves: ["streams"],
    settled: null,
  }),
  modelsFind: page({
    route: "/v1/page/models/find",
    members: { placeholder: words, groups: list(ModelGroup), none: nullable(words) },
    today: false,
    device: false,
    moves: ["streams"],
    settled: null,
  }),
} as const satisfies Readonly<Record<string, PageContract<unknown>>>;

export type PageName = keyof typeof PAGES;
export type AnswerOf<N extends PageName> = Of<(typeof PAGES)[N]["shape"]>;

export type Described =
  | { readonly of: "text"; readonly pattern: string | null }
  | { readonly of: "int"; readonly min: number; readonly max: number }
  | { readonly of: "num" }
  | { readonly of: "bool" }
  | { readonly of: "enum"; readonly values: readonly string[] }
  | { readonly of: "list"; readonly each: Described; readonly min: number; readonly max: number }
  | { readonly of: "nullable"; readonly inner: Described }
  | { readonly of: "object"; readonly members: readonly Member[] }
  | { readonly of: "tagged"; readonly tag: string; readonly cases: readonly (readonly [string, readonly Member[]])[] }
  | { readonly of: "ref"; readonly name: string }
  | { readonly of: "kept" };

export type Member = readonly [string, Described];

export interface DescribedPage {
  readonly name: string;
  readonly route: string;
  readonly today: boolean;
  readonly device: boolean;
  readonly moves: readonly Move[];
  readonly settled: Settled | null;
  readonly members: readonly Member[];
}

export interface Def {
  readonly name: string;
  readonly shape: Described;
  readonly page: string;
  readonly at: string;
}

export interface Contract {
  readonly pages: readonly DescribedPage[];
  readonly defs: readonly Def[];
}

export class PageShapeError extends Error {
  constructor(readonly page: string, readonly member: string, readonly why: string) {
    super(`page ${page}, ${member === "" ? "its answer" : `member ${member}`}: ${why}`);
    this.name = "PageShapeError";
  }
}

const ROUTE = /^\/v1\/[a-z0-9][a-z0-9/_-]*$/u;
const TYPE_NAME = /^[A-Z][A-Za-z0-9]*$/u;

function outside(schema: Schema): string {
  if ("prefixItems" in schema) return "a tuple";
  if ("lastItem" in schema) return "an endingIn";
  if (schema.type === "object" && typeof schema.additionalProperties === "object") return "a map";
  if (schema.type === "object") {
    const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);
    if (Object.keys(schema.properties as object ?? {}).some((each) => !required.has(each))) return "an object with optional members";
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((each) => (each as Schema).type === "null")) return "an either";
  return "a rule, or a shape pages.ts did not make";
}

const within = (at: string, member: string): string => (at === "" ? member : `${at}.${member}`);

export function describe(pages: Readonly<Record<string, PageContract<unknown>>> = PAGES, replies: Readonly<Record<string, PageShape<unknown>>> = REPLIES): Contract {
  const defs = new Map<string, { shape: Shape<unknown>; def: Def | null }>();
  const routes = new Map<string, string>();

  const walk = (shape: Shape<unknown>, page: string, at: string): Described => {
    const node = (shape as Partial<PageShape<unknown>>).node;
    if (node === undefined) throw new PageShapeError(page, at, `${outside(shape.schema)} is not in the page language`);
    switch (node.of) {
      case "text":
      case "num":
      case "bool":
      case "kept":
        return node;
      case "int":
        return { of: "int", min: node.min, max: node.max };
      case "enum": {
        if (node.values.length === 0) throw new PageShapeError(page, at, "a oneOf names no value");
        if (node.values.some((value) => typeof value !== "string")) throw new PageShapeError(page, at, "a oneOf of the page language holds only text values");
        const twice = node.values.find((value, index) => node.values.indexOf(value) !== index);
        if (twice !== undefined) throw new PageShapeError(page, at, `a oneOf names ${JSON.stringify(twice)} twice`);
        return { of: "enum", values: [...node.values] };
      }
      case "list":
        return { of: "list", each: walk(node.each, page, `${at}[]`), min: node.min, max: node.max };
      case "nullable": {
        const inner = walk(node.inner, page, at);
        if (inner.of === "nullable") throw new PageShapeError(page, at, "a nullable of a nullable");
        return { of: "nullable", inner };
      }
      case "object":
        return { of: "object", members: Object.entries(node.members).map(([member, each]) => [member, walk(each, page, within(at, member))] as const) };
      case "tagged": {
        const cases = Object.entries(node.cases);
        if (cases.length === 0) throw new PageShapeError(page, at, "a tagged names no case");
        return {
          of: "tagged",
          tag: node.tag,
          cases: cases.map(([each, members]) => {
            if (Object.hasOwn(members, node.tag)) throw new PageShapeError(page, `${at}(${each}).${node.tag}`, `a case holds a member named as its tag, ${node.tag}`);
            return [each, Object.entries(members).map(([member, shaped]) => [member, walk(shaped, page, `${at}(${each}).${member}`)] as const)] as const;
          }),
        };
      }
      case "named": {
        if (!TYPE_NAME.test(node.name)) throw new PageShapeError(page, at, `the name ${JSON.stringify(node.name)} is no type name, A-Z then letters and digits`);
        const held = defs.get(node.name);
        if (held !== undefined) {
          if (held.shape !== shape) throw new PageShapeError(page, at, `the name ${node.name} is given to two shapes`);
          if (held.def === null) throw new PageShapeError(page, at, `${node.name} holds itself`);
          return { of: "ref", name: node.name };
        }
        const kind = (node.inner as Partial<PageShape<unknown>>).node?.of;
        if (kind !== "object" && kind !== "enum" && kind !== "tagged") throw new PageShapeError(page, at, `${node.name} names ${kind === undefined ? "a shape outside the page language" : `a ${kind}`}; a name is given to an object, a oneOf or a tagged`);
        defs.set(node.name, { shape, def: null });
        const def: Def = { name: node.name, shape: walk(node.inner, page, at), page, at };
        defs.set(node.name, { shape, def });
        return { of: "ref", name: node.name };
      }
    }
  };

  const described = Object.entries(pages).map(([title, each]): DescribedPage => {
    if (!ROUTE.test(each.route)) throw new PageShapeError(title, "", `the route ${JSON.stringify(each.route)} is no /v1/ route`);
    const other = routes.get(each.route);
    if (other !== undefined) throw new PageShapeError(title, "", `the route ${each.route} is page ${other}'s too`);
    routes.set(each.route, title);
    const moved = new Set<string>(each.moves);
    if (moved.size !== each.moves.length) throw new PageShapeError(title, "", "its moves name one member twice");
    const unknown = each.moves.find((move) => !(MOVES as readonly string[]).includes(move));
    if (unknown !== undefined) throw new PageShapeError(title, "", `its moves name ${JSON.stringify(unknown)}, which is no HomeChange member`);
    if (each.today !== moved.has("today")) throw new PageShapeError(title, "", each.today ? "it depends on today, so its moves name today" : "its moves name today, so it depends on today");
    if (each.settled !== null && !moved.has(each.settled)) throw new PageShapeError(title, "", `it is settled by ${each.settled}, so its moves name ${each.settled}`);
    const root = walk(each.shape, title, "");
    if (root.of !== "object") throw new PageShapeError(title, "", "a page answer is an object");
    const member = (key: string) => root.members.find(([held]) => held === key)?.[1];
    if (member("position")?.of !== "text") throw new PageShapeError(title, "position", "every page answer carries its position, text");
    if (member("today")?.of !== "text") throw new PageShapeError(title, "today", "every page answer carries the home's today, a day");
    if (each.settled !== null && member("counting")?.of !== "bool") throw new PageShapeError(title, "counting", "a page with settled carries counting, true or false");
    return { name: title, route: each.route, today: each.today, device: each.device, moves: [...each.moves], settled: each.settled, members: root.members };
  });

  for (const [title, shape] of Object.entries(replies)) {
    const root = walk(shape, title, "");
    if (root.of !== "ref" || root.name !== title) throw new PageShapeError(title, "", `a reply is a shape named ${title}`);
  }

  const sorted = [...defs.values()].map(({ def }) => def!).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { pages: described, defs: sorted };
}

const published = (schema: unknown): unknown =>
  Array.isArray(schema) ? schema.map(published)
    : typeof schema === "object" && schema !== null
      ? Object.fromEntries(Object.entries(schema).filter(([key, value]) => !(key === "leaf" && typeof value === "string")).map(([key, value]) => [key, published(value)]))
      : schema;

export function contractText(pages: Readonly<Record<string, PageContract<unknown>>> = PAGES): string {
  const json = {
    pages: Object.fromEntries(describe(pages).pages.map((each) => [each.name, {
      route: each.route,
      moves: each.moves,
      today: each.today,
      device: each.device,
      settled: each.settled,
      schema: published(pages[each.name]!.shape.schema),
    }])),
  };
  return `${JSON.stringify(json, null, 2)}\n`;
}

let version: string | undefined;

export function contractVersion(): string {
  return version ??= sha256(contractText());
}

export function pageETag(page: PageContract<unknown>, ask: Pick<PageAsk, "today" | "device"> & Partial<Pick<PageAsk, "unit">>, inputs: readonly Digest[], contract: string = contractVersion(), release: string = RELEASE): string {
  const parts = { contract, release, inputs: [...inputs], ...(page.today ? { today: ask.today } : {}), ...(page.device ? { device: ask.device, unit: ask.unit ?? null } : {}) };
  return `"${digest(parts).slice("sha256:".length)}"`;
}
