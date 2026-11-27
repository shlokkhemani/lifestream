import type { Connector, groups as groupsLabeler } from "@lifestreamprotocol/connect";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { digest, duration, foldName, GONE, handleId, isObject, isSqliteError, openMemo, type BlobReader, type DaySettings, type HomeFolder, type Json, type JsonObject, type Memo, type OpenView, type SourceSelector } from "@lifestreamprotocol/core";
import type { NamedPerson, NameTable } from "@lifestreamprotocol/privacy";
import {
  AI_FAMILY, assistantsOf, callPeoplePart, CALLS_FAMILY, CAMERA_UNIT, cardParts, chatDayPart, CONTACT_KIND, contactPhotoBytes, FACES_SOURCES, GROUP_UNIT, isName, LABELS_FAMILY, labelsFrom, MAIL_FAMILY, mailDayPart, MESSAGES_FAMILY, ownCountry,
  handleOfId, ownHandles, PEOPLE_CODE, networksIn, NO_GROUP_SETTINGS, PEOPLE_SOURCES, peopleOf, PLACES_UNIT, ownProductsIn, productNames, readCard, readPeople, rejoin, sameIdOf, shownPart, shownUnit, spelledId, whoNow, type CallPeoplePart, type Card, type CardParts,
  type ChatDayPart, type Details, type FacesSaid, type Family, type GroupSettings, type JoinedList, type JoinedPerson, type LabelRow, type MailDayPart, type NamedFace, type Networks, type PeopleAnswer,
  type People, type PeopleNow, type PeopleRun, type PersonDetail, type ProviderLabel, type Rejoined, type Searched, type StatedDetails, type StatedPhoto, type Talk, type Who,
} from "@lifestreamprotocol/families";
import { switchOf } from "./catalog.js";
import { GIVEN_MOST, resolvedOf } from "./cursor-text.js";
import { jobPaused, LANE, type Kind } from "./jobs.js";
import type { Registry } from "./registry.js";
import { damaged, PEOPLE, preparedDirOf, preparedFileOf, readPrepared, writePrepared, type PreparedRead } from "./prepared.js";
import type { Reach } from "./counting.js";
import { makeRef, personRef } from "./refs.js";
import type { PeopleMatch } from "./search-contract.js";
import { EDIT_FROM, editsOf, NEAR_FROM, SKELETON_FROM, skeletonOf } from "./search-words.js";
import { connectorSettings, type Settings } from "./settings.js";


const ANNOUNCED = "people:announced";

const FACE_SPACES = ["named", "scan"] as const;

const WHO: Readonly<Record<string, readonly string[]>> = Object.fromEntries([
  ...who(PEOPLE_SOURCES, ["person", "photo", "details", "group"]), ...who(FACES_SOURCES, ["named"]),
]);

function who(sources: SourceSelector, kinds: readonly string[]): [string, readonly string[]][] {
  return sources.product!.map((product) => [product, kinds]);
}

export function isWho(product: string, kind: string): boolean {
  return kind === CONTACT_KIND || WHO[product]?.includes(kind) === true;
}

export function whoProducts(families: readonly Pick<Family, "name" | "adapters">[]): ReadonlySet<string> {
  const books = families.find((family) => family.name === LABELS_FAMILY)?.adapters ?? [];
  return new Set([...Object.keys(WHO), ...books.map((given) => given.product)]);
}

export const PEOPLE_FAMILIES: readonly string[] = [MESSAGES_FAMILY, MAIL_FAMILY, CALLS_FAMILY, LABELS_FAMILY];

export function peopleProducts(families: readonly Pick<Family, "name" | "adapters">[]): ReadonlySet<string> {
  const fed = families.filter((family) => PEOPLE_FAMILIES.includes(family.name));
  return new Set([...whoProducts(families), ...fed.flatMap((family) => (family.adapters ?? []).map((given) => given.product))]);
}

interface PeopleData {
  off: readonly string[];
  day: DaySettings;
  groups: Record<string, GroupSettings>;
}

const DAY_MS = 86_400_000;

function groupSettings(connectors: readonly Connector[], blocks: Settings["connectors"], networks: Networks): Record<string, GroupSettings> {
  const of = (product: string): GroupSettings => {
    const connector = connectors.find((each) => each.product === product);
    const fields = connector === undefined ? {} : connectorSettings(connector, blocks[connector.id]).fields;
    const after = fields.groups_quiet_after as string | undefined;
    return {
      archived: fields.groups_archived === "on",
      after_days: after === undefined || after === "never" ? NO_GROUP_SETTINGS.after_days : duration(after) / DAY_MS,
      talk: (fields.groups_talk as Talk | undefined) ?? NO_GROUP_SETTINGS.talk,
    };
  };
  return Object.fromEntries(networks.products.map((product) => [product, of(product)]));
}

export function peopleFileOf(root: string, machine: string): string {
  return preparedFileOf(preparedDirOf(root, machine, "people"), "people");
}

export function readGroups(folder: HomeFolder, file: string): groupsLabeler.PreparedGroups | undefined {
  try {
    return readPrepared(folder, file, PEOPLE.format, (read) => ({
      changed: read.meta("changed:groups") ?? read.position,
      groups: new Map(read.rows<groupsLabeler.GroupRow>("groups")),
    }))?.value;
  } catch (error) {
    if (damaged(error)) return undefined;
    throw error;
  }
}

export function readQuiet(folder: HomeFolder, file: string): Record<string, number> | undefined {
  try {
    return readPrepared(folder, file, PEOPLE.format, (read) => read.value<Record<string, number>>("answer", "quiet"))?.value;
  } catch (error) {
    if (damaged(error) || (isSqliteError(error) && error.code === "SQLITE_BUSY")) return undefined;
    throw error;
  }
}

const NAME_TABLE = "table";

const nameTables = new Map<string, { etag: string; table: NameTable }>();

export function readNameTable(folder: HomeFolder, file: string): NameTable | undefined;
export function readNameTable(folder: HomeFolder, file: string, known: string | null): NameTable | "same" | undefined;
export function readNameTable(folder: HomeFolder, file: string, known: string | null = null): NameTable | "same" | undefined {
  try {
    return readPrepared(folder, file, PEOPLE.format, (read): NameTable | "same" | undefined => {
      const etag = read.etag("names", NAME_TABLE);
      if (etag === undefined) return undefined;
      if (etag === known) return "same";
      const held = nameTables.get(file);
      if (held?.etag === etag) return held.table;
      const body = read.value<Omit<NameTable, "version">>("names", NAME_TABLE)!;
      const table: NameTable = { version: etag, owner: body.owner, people: body.people };
      nameTables.set(file, { etag, table });
      return table;
    })?.value;
  } catch (error) {
    if (damaged(error) || (isSqliteError(error) && error.code === "SQLITE_BUSY")) return undefined;
    throw error;
  }
}

export type Assistant = { product: string; name: string; who: string };

export function nameTableOf(persons: readonly PersonDetail[], assistants: readonly Assistant[]): Omit<NameTable, "version"> {
  const people = [...persons].sort((left, right) => compare(left.id, right.id)).map((person): NamedPerson => {
    const said = [...(person.by === "none" ? [] : [person.call_name]), person.full_name ?? ""].filter(isName).map((name) => name.trim());
    const called = person.also_called.map(({ name }) => name.trim()).filter(isName);
    const whole = (name: string) => /\s/u.test(name);
    const talked = person.me || person.sent + person.received + person.mails_from + person.mails_to > 0;
    const alone = talked ? [...said.map((name) => name.split(/\s+/u)[0]!), ...called.filter((name) => !whole(name))].filter(isName) : [];
    return {
      who: person.id, is: IS[person.entity] ?? "human", shown: person.name,
      names: [...new Set([...said.filter(whole), ...called.filter(whole), ...alone])],
      accounts: person.handles.map((handle) => handle.kind === "network" ? handle.id : handle.id.slice(handle.id.indexOf(":") + 1)),
    };
  });
  const bots = assistants.map(({ who, name }): NamedPerson => ({ who, is: "bot", shown: name, names: [name], accounts: [] }));
  const owner = persons.find((person) => person.me);
  return { owner: owner === undefined ? null : { who: owner.id, shown: owner.name }, people: [...people, ...bots] };
}

const IS: Readonly<Record<string, NamedPerson["is"]>> = { person: "human", ai: "bot", business: "business", bot: "bot" };

interface PeopleResult {
  position: string;
  changed: string;
  counts: {
    persons: number;
    listed: number;
    extracts: number;
    joined: number;
    versions: number;
    records: number;
    written: number;
    removed: number;
  };
}

export const peopleKind: Kind<PeopleData, never, PeopleResult, null> = {
  dies: true,
  begin(main) {
    return { data: { off: main.settings.sources.off, day: main.settings.day, groups: groupSettings(main.registry.connectors, main.settings.connectors, networksIn(main.registry.families)) }, state: null };
  },
  async *helper(env, task) {
    const { day } = task.data;
    const dir = preparedDirOf(env.folder.root, env.machine, "people");
    const memo = openMemo(env.folder, join(dir, "memo.db"), digest({ code: PEOPLE_CODE, zone: day.zone, day_start_hour: day.day_start_hour }));
    try {
      const view = env.db.view();
      try {
        return prepare(env.folder, view, memo, dir, task.data, env.registry, env.blobs);
      } finally {
        view.close();
      }
    } finally {
      memo.close();
    }
  },
  done(main, tx, running, result) {
    const now = main.now();
    const run = tx.tables.runs.start({ kind: "people", subject: "people", started_ms: running.job.started_ms ?? now });
    tx.tables.runs.end(run, { ended_ms: now, outcome: "ok", counts: result.counts });
    tx.tables.events.append({ at_ms: now, kind: "people", key: "people", detail: { position: result.position, changed: result.changed } });
    if (tx.tables.meta.get(ANNOUNCED) === result.changed) return;
    tx.tables.meta.set(ANNOUNCED, result.changed);
    tx.tables.jobs.enqueue({ kind: "places", key: "places", lane: LANE.live, not_before_ms: now, now_ms: now });
  },
};

function prepare(folder: HomeFolder, view: OpenView, memo: Memo, dir: string, { off, day, groups }: PeopleData, registry: Pick<Registry, "connectors" | "families">, blobs: Pick<BlobReader, "has" | "bytes">): PeopleResult {
  const { connectors } = registry;
  const networks = networksIn(registry.families);
  const held = (hash: string) => blobs.has(hash);
  const counts = { extracts: 0, joined: 0, versions: 0, records: 0 };
  const position = view.position();

  const labelUnits = parts<LabelRow>(view, memo, LABELS_FAMILY, (unit) => unit !== PLACES_UNIT && !unit.startsWith(CAMERA_UNIT) && !unit.startsWith(GROUP_UNIT), (row) => ({ content: row.content }), counts);
  const labels = labelsFrom((unit) => labelUnits.get(unit), day);
  const providers = new Map<string, ProviderLabel>();
  for (const [unit, row] of labelUnits) {
    if (isObject(row.content) && isObject(row.content.provider)) providers.set(unit, row.content.provider as unknown as ProviderLabel);
  }

  const chatParts = parts<ChatDayPart | null>(view, memo, MESSAGES_FAMILY, () => true, (row) => {
    const part = chatDayPart(row.content, day, networks);
    return part.total === 0 ? null : part;
  }, counts);
  const byShown = new Map<string, string[]>();
  for (const [unit, part] of chatParts) {
    if (part === null) continue;
    const shown = shownUnit(unit, labels, networks);
    const list = byShown.get(shown);
    if (list === undefined) byShown.set(shown, [unit]);
    else list.push(unit);
  }
  const chats: ChatDayPart[] = [];
  for (const units of byShown.values()) {
    if (units.length === 1) {
      chats.push(chatParts.get(units[0]!)!);
      continue;
    }
    counts.joined++;
    chats.push(shownPart(units.sort().flatMap((unit) => view.extract(MESSAGES_FAMILY, unit) ?? []), labels, day, networks));
  }
  const owner = (unit: string) => view.source(unit.slice(0, unit.lastIndexOf("/")))?.account ?? "";
  const mails = parts<MailDayPart>(view, memo, MAIL_FAMILY, () => true, (row) => mailDayPart(row.content, owner(row.unit), day), counts);
  const calls = parts<CallPeoplePart | null>(view, memo, CALLS_FAMILY, () => true, (row) => callPeoplePart(row.content), counts);

  const photoAt = new Map<string, string>();
  const cards: Card[] = [];
  for (const { head, value } of versions<CardParts | null>(view, memo, CONTACT_KIND, view.sources({}).map((source) => source.id), CONTACT_KIND, cardParts, counts)) {
    if (value === null) continue;
    const photo = value.photo?.blob === true && !held(value.photo.hash) ? null : value.photo;
    cards.push(readCard(head, head.since_ms, { ...value, photo }));
    if (photo !== null) photoAt.set(photo.hash, head.version);
  }
  const people = view.sources(PEOPLE_SOURCES).map((source) => source.id);
  const { records, photos, details } = peopleSaid(view, held);
  counts.records += records.length;
  const words = new Map<string, { quiet: boolean; stated_ms: number }>();
  for (const { head, value } of versions(view, memo, "group", people, "group", (content) => isObject(content) && typeof content.quiet === "boolean" ? content.quiet : null, counts)) {
    const held = words.get(head.key);
    if (value !== null && (held === undefined || head.stated_ms > held.stated_ms)) words.set(head.key, { quiet: value, stated_ms: head.stated_ms });
  }
  const isOff = switchOf(connectors, off).source;
  const faceSources = view.sources(FACES_SOURCES).filter((source) => !isOff(source)).map((source) => source.id);
  let faces: FacesSaid | null = null;
  if (faceSources.length > 0) {
    const named = new Map<string, { photos: NamedFace[]; labels: string[] }>();
    for (const { head, value } of versions(view, memo, "named", faceSources, "named", namedOf, counts)) {
      const held = named.get(head.key);
      named.set(head.key, held === undefined ? value : { photos: [...held.photos, ...value.photos], labels: [...new Set([...held.labels, ...value.labels])].sort() });
    }
    faces = { named };
  } else {
    for (const space of FACE_SPACES) memo.values(space, [], () => undefined);
  }

  const answer = peopleOf({
    networks, chats, mail: mails.values(), calls: [...calls.values()].filter((part): part is CallPeoplePart => part !== null), labels, cards, records, providers, faces, photos, details, day, names: productNames(registry.families),
    own: ownHandles(view, ownProductsIn(registry.families), networks),
    groups: { words: new Map([...words].map(([key, word]) => [key, word.quiet])), rules: groups },
    country: ownCountry(view, networks),
  });
  const assistants = assistantsOf(registry.families.find((family) => family.name === AI_FAMILY));
  const prepared = rowsOf(answer, assistants, scanSizes(view, memo, faceSources, new Set([...answer.photos.values()].flatMap((served) => served.map(({ image }) => image))), counts));
  const read = peopleHeads(view);
  prepared.rows.set(HEADS, new Map(OWNER_KINDS.map((kind) => [kind, { versions: read.versions[kind] }])));
  prepared.rows.set(RESOLVED, whoRows(answer.who));
  const { written, removed, changed } = writePrepared(folder, preparedFileOf(dir, "people"), PEOPLE, {
    rows: prepared.rows, position, meta: { [HEADS]: read.digest },
    own: (db) => writeCards(db, prepared.cards, (hash) => {
      const version = photoAt.get(hash);
      return version === undefined ? null : contactPhotoBytes(view.version(version).content, blobs);
    }),
  });
  return { position, changed, counts: { persons: answer.persons.length, listed: answer.list.people.length, ...counts, written, removed } };
}

function writeCards(db: Database.Database, cards: ReadonlySet<string>, photo: (hash: string) => { bytes: Buffer; type: string } | null): { written: number; removed: number } {
  let written = 0, removed = 0;
  const held = new Set(db.prepare("SELECT key FROM card").pluck().all() as string[]);
  const put = db.prepare("INSERT INTO card (key, type, bytes) VALUES (?, ?, ?)");
  for (const hash of cards) {
    if (held.has(hash)) continue;
    const read = photo(hash);
    if (read === null) continue;
    put.run(hash, read.type, read.bytes);
    written++;
  }
  const drop = db.prepare("DELETE FROM card WHERE key = ?");
  for (const hash of held) {
    if (cards.has(hash)) continue;
    drop.run(hash);
    removed++;
  }
  return { written, removed };
}

function rowsOf(answer: PeopleAnswer, assistants: readonly Assistant[], sizes: ReadonlyMap<string, Size | null>): { rows: Map<string, Map<string, JsonObject>>; cards: Set<string> } {
  const rows = new Map<string, Map<string, JsonObject>>();
  const table = (name: string) => {
    const map = new Map<string, JsonObject>();
    rows.set(name, map);
    return map;
  };
  const json = (value: unknown) => value as JsonObject;
  const answers = table("answer");
  answers.set("list", json(answer.list));
  if (Object.keys(answer.quiet).length > 0) answers.set("quiet", json(answer.quiet));
  const persons = table("person");
  const cards = new Set<string>();
  for (const person of answer.persons) {
    persons.set(person.id, json({ person }));
    for (const photo of [person.photo, ...person.joined.map((member) => member.photo)]) if (photo !== null && "card" in photo) cards.add(photo.card);
  }
  const alias = table("alias");
  for (const [id, person] of answer.alias) alias.set(id, { id: person });
  const names = table("names");
  names.set("all", json({ people: answer.searched }));
  names.set(NAME_TABLE, json(nameTableOf(answer.persons, assistants)));
  const photos = table("photos");
  for (const [id, served] of answer.photos) photos.set(id, json({ photos: served }));
  const groups = table("groups");
  for (const [key, row] of answer.groups) groups.set(key, json(row));
  const images = table("image");
  const named = table("named");
  const byId = new Map(answer.persons.map((person) => [person.id, person]));
  const faces = new Map<string, Map<string, readonly number[]>>();
  for (const [id, served] of answer.photos) {
    for (const { image, box } of served) {
      const on = faces.get(image) ?? new Map<string, readonly number[]>();
      faces.set(image, on);
      const held = on.get(id);
      if (held === undefined || box[0]! < held[0]!) on.set(id, box);
    }
  }
  for (const [image, on] of faces) {
    const size = sizes.get(image) ?? null;
    const people = [...on].sort(([leftId, left], [rightId, right]) => left[0]! - right[0]! || compare(leftId, rightId)).map(([id, box]) => ({ id, box: size === null ? null : [...box] }));
    images.set(image, json({ size, people }));
    for (const { id } of people) {
      const person = byId.get(id);
      if (person !== undefined && !named.has(id)) named.set(id, json({ id, name: person.name, photo: person.photo, me: person.me }));
    }
  }
  return { rows, cards };
}

function parts<T>(view: OpenView, memo: Memo, family: string, keeps: (unit: string) => boolean, make: (row: { unit: string; content: Json; code: string }) => T, counts: { extracts: number }): Map<string, T> {
  const units = new Map<string, string>();
  for (const { unit, reading, code } of view.extractReadings(family)) if (keeps(unit)) units.set(`${unit}\0${reading}\0${code}`, unit);
  const kept = memo.values<T>(family, [...units.keys()], (key) => {
    const row = view.extract(family, units.get(key)!);
    if (row === undefined) return undefined;
    counts.extracts++;
    return make(row);
  });
  return new Map([...kept].map(([key, part]) => [units.get(key)!, part]));
}

function versions<T>(view: OpenView, memo: Memo, space: string, sources: readonly string[], kind: string, make: (content: Json) => T, counts: { versions: number }) {
  const heads = sources.flatMap((source) => [...view.heads(source, kind)]);
  const kept = memo.values<T>(space, [...new Set(heads.map((head) => head.version))], (id) => {
    counts.versions++;
    return make(view.version(id).content);
  });
  return heads.map((head) => ({ head, value: kept.get(head.version)! }));
}

interface Size {
  width: number;
  height: number;
}

function scanSizes(view: OpenView, memo: Memo, sources: readonly string[], images: ReadonlySet<string>, counts: { versions: number }): Map<string, Size | null> {
  const scans = new Map<string, string>();
  for (const image of images) {
    for (const source of sources) {
      const head = view.head({ source, kind: "scan", key: image });
      if (head === undefined || head.version === GONE) continue;
      scans.set(image, head.version);
      break;
    }
  }
  const kept = memo.values<Size | null>("scan", [...new Set(scans.values())], (id) => {
    counts.versions++;
    const content = view.version(id).content;
    return isObject(content) && typeof content.width === "number" && typeof content.height === "number" ? { width: content.width, height: content.height } : null;
  });
  return new Map([...images].map((image) => [image, scans.has(image) ? kept.get(scans.get(image)!) ?? null : null]));
}

function namedOf(content: Json): { photos: NamedFace[]; labels: string[] } {
  if (!isObject(content)) return { photos: [], labels: [] };
  const photos = Array.isArray(content.photos) ? content.photos.flatMap((face): NamedFace[] => isObject(face) && typeof face.face === "string" ? [{
    face: face.face, at_ms: typeof face.at_ms === "number" ? face.at_ms : null, camera: face.camera === true, crop: typeof face.crop === "string" ? face.crop : null,
    tier: typeof face.tier === "string" ? face.tier : null, size: typeof face.size === "number" ? face.size : 0,
  }] : []) : [];
  const labels = Array.isArray(content.labels) ? content.labels.filter((label): label is string => typeof label === "string") : [];
  return { photos, labels };
}

function detailsOfContent(content: Json): Details | null {
  if (!isObject(content) || content.type !== "people.details" || !Array.isArray(content.profiles)) return null;
  const birthday = isObject(content.birthday) ? content.birthday : null;
  return {
    work: typeof content.work === "string" ? content.work : null,
    birthday: birthday === null ? null : { month: birthday.month as number, day: birthday.day as number, year: typeof birthday.year === "number" ? birthday.year : null },
    profiles: content.profiles as unknown as Details["profiles"],
    ...(Array.isArray(content.cleared) ? { cleared: content.cleared as unknown as NonNullable<Details["cleared"]> } : {}),
  };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}



export const PEOPLE_SEARCH_MATCHES = 10;
const PEOPLE_SEARCH_CHATS = 12;
const ELSEWHERE_CHATS = 12;
const SHORT_WHOLE = 2;
const ALSO_MOST = 8;
const SAME_MOST = 5;
const SAME_READS = 40;
const FULL_WORDS = 2;

export interface PeopleSearchChat {
  readonly key: string;
  readonly group: boolean;
  readonly label: string;
}

export interface Elsewhere {
  as: "place" | "payee" | "app" | "chat" | "words";
  chat?: string;
  family?: string;
  n?: number;
  capped?: true;
  first?: string;
  last?: string;
}

export interface PeopleSearchMatch {
  id: string;
  kind: "person" | "group" | "business" | "bot";
  name: string;
  also: string[];
  tied?: string[];
  same?: { id: string; by: SameBy }[];
  handles: string[];
  chats: { chat: string; title: string; messages?: number }[];
  chats_more?: number;
  reach: Reach;
  near?: string[];
  me?: true;
  capped?: true;
}

type SameBy = "face" | "name" | "sender";

const SAME_WHY: Readonly<Record<SameBy, string>> = {
  face: "a face named with a name of the other's",
  name: "the same full name",
  sender: "the same full name, as a sender or a chat gave it",
};

export function peopleMatchOf(match: PeopleSearchMatch, refOf: (id: string) => string): PeopleMatch {
  const chatRef = (key: string) => makeRef("chat", { key });
  const counted = match.chats.flatMap(({ chat, title, messages }) => (messages === undefined ? [] : [{ chat: chatRef(chat), title, messages }]));
  return {
    ref: match.kind === "group" ? chatRef(match.id) : personRef(match), kind: match.kind, name: match.name,
    ...(match.me === true ? { the_user: true as const } : {}), ...(match.also.length === 0 ? {} : { also: match.also }),
    ...(match.tied === undefined ? {} : { tied: match.tied.map(refOf) }),
    ...(match.same === undefined ? {} : { same: match.same.map(({ id, by }) => ({ ref: refOf(id), why: SAME_WHY[by] })) }),
    ...(match.handles.length === 0 ? {} : { handles: match.handles.map((handle) => handleOfId(handle)?.value ?? handle) }),
    ...(counted.length === 0 ? {} : { chats: counted }), ...(Object.keys(match.reach).length === 0 ? {} : { reach: match.reach }),
  };
}

export interface PeopleSearchAnswer {
  note?: string;
  matches: PeopleSearchMatch[];
  elsewhere?: Elsewhere[];
  capped?: true;
  next?: Page;
  resolved: string;
}

export interface Page {
  given: number[];
  place?: number;
  chats?: number;
}

export interface PeopleSearchInput {
  readonly searched: readonly Searched[];
  person(id: string): PersonDetail | undefined;
  idOf(id: string): string | undefined;
  readonly chats: readonly PeopleSearchChat[];
  counted<T>(count: (counts: PeopleSearchCounts) => T): T;
  elsewhere(name: string, words: boolean): Elsewhere[];
  nameless?: true;
  served?: PeopleServed;
}

export interface PeopleServed {
  involved(id: string): boolean;
  handles(id: string): readonly string[];
  names(id: string): readonly string[];
  searched(id: string, handles: boolean): Searched | undefined;
}

export interface PeopleSearchCounts {
  touch(of: readonly ({ person: string } | { chat: string })[]): (number | undefined)[];
  reach(of: { person: string } | { chat: string }): { reach: Reach; chats: { chat: string; messages: number }[]; handles?: string[] } | undefined;
}

interface Took {
  id: string;
  words: Set<string>[];
  near: Set<string>;
}

export function peopleSearchOf(asked: { name: string; page?: Page } | { id: string; page?: Page }, input: PeopleSearchInput, resolved?: (digest: string) => void): PeopleSearchAnswer | undefined {
  const order = new Map(input.searched.map((person, at) => [person.id, at]));
  const chatsByKey = new Map(input.chats.map((chat) => [chat.key, chat]));
  const same = sameFinder(input, order);
  const given = new Set(asked.page?.given ?? []);
  if ("id" in asked) {
    const person = input.idOf(asked.id);
    const chat = chatsByKey.get(asked.id);
    if (person === undefined && chat === undefined) return undefined;
    const one = resolvedOf([person ?? chat!.key]);
    resolved?.(one);
    if (given.has(0)) return { matches: [], resolved: one };
    const match = input.counted((counts) => (person !== undefined ? personMatch(person, undefined, input, counts, chatsByKey) : groupMatch(chat!, counts)))!;
    if (person !== undefined) listSame(match, same(person), input);
    return { matches: [match], resolved: one, ...(match.capped === true ? { capped: true as const, next: { given: [0] } } : {}) };
  }
  const words = foldName(asked.name).split(/\s+/u).filter(Boolean);
  const take = (near: boolean) => input.searched.flatMap((person) => {
    const took = tookOf(person, words, near);
    if (took === null || input.served === undefined) return took ?? [];
    const named = input.served.searched(person.id, false);
    return (named === undefined ? null : tookOf(named, words, near) ?? tookOf(input.served.searched(person.id, true)!, words, near)) ?? [];
  });
  let took = words.length === 0 ? [] : take(false);
  if (took.length === 0 && words.length > 0) took = take(true);
  const persons = took.filter((each) => input.person(each.id) !== undefined).map((each) => ({ id: each.id, took: each }));
  const groups = input.chats.filter((chat) => chat.group && words.length > 0 && words.every((word) => titleWords(chat.label).some((each) => each.startsWith(word))))
    .map((chat) => ({ id: chat.key, chat }));
  const candidates: ({ id: string; took: Took } | { id: string; chat: PeopleSearchChat })[] = [...persons, ...groups];
  const whole = persons.some(({ took: each }) => words.every((word, at) => each.words[at]!.has(word)));
  const titled = words.length === 0 || whole ? [] : titledChats(words, input);
  const digest = resolvedOf({ candidates: candidates.map((each) => each.id), chats: titled.map((chat) => chat.key) });
  resolved?.(digest);
  const named = nameWords(asked.name).join(" ");
  const bearers = persons.filter(({ id }) => named !== "" && servedNames(id, input).some((name) => nameWords(name).join(" ") === named)).map(({ id }) => id);
  const place = asked.page?.place;
  const pending = candidates.flatMap((each, at) => (given.has(at) || (place !== undefined && at <= place) ? [] : [{ each, at }]));
  const { all, ranked, touches, matches } = input.counted((counts) => {
    const ranked = place === undefined ? pending : pending.slice(0, PEOPLE_SEARCH_MATCHES);
    const touches = counts.touch(ranked.map(({ each }) => ("chat" in each ? { chat: each.chat.key } : { person: each.id })));
    const touched = pending.map(({ each, at }, i) => ({ each, at, touch: touches[i] ?? -1 })).filter(({ touch }) => input.served === undefined || touch !== 0);
    const all = place !== undefined ? touched
      : touched.sort((left, right) => right.touch - left.touch
        || (order.get(left.each.id) ?? Infinity) - (order.get(right.each.id) ?? Infinity) || compare(left.each.id, right.each.id));
    const proven = input.served === undefined ? all : all.filter(({ touch }) => touch > 0);
    const matches = proven.slice(0, PEOPLE_SEARCH_MATCHES).map(({ each, at, touch }) => ({ at, match: (() => {
      const counted = touch >= 0;
      const match = "chat" in each ? groupMatch(each.chat, counts, counted) : personMatch(each.id, each.took, input, counts, chatsByKey, counted)!;
      const tied = bearers.filter((other) => other !== each.id && (input.served === undefined || input.served.involved(other)));
      if (bearers.includes(each.id) && tied.length > 0) match.tied = tied;
      if (!("chat" in each)) listSame(match, same(each.id), input);
      return match;
    })() }));
    return { all, ranked, touches, matches };
  });
  const answer: PeopleSearchAnswer = { matches: matches.map(({ match }) => match), resolved: digest };
  if (touches.includes(undefined) || answer.matches.some((match) => match.capped === true)) answer.capped = true;
  if (answer.matches.length > 1) answer.note = noteOf(answer.matches, input);
  let chatsGiven = asked.page?.chats ?? 0;
  let chatsLeft = false;
  if (words.length > 0) {
    const elsewhere = asked.page === undefined ? input.elsewhere(asked.name, !whole) : [];
    if (!whole) {
      const chats = chatsElsewhere(titled, input, chatsGiven);
      const at = elsewhere.findIndex((each) => each.as === "words");
      elsewhere.splice(at < 0 ? elsewhere.length : at, 0, ...chats.entries);
      chatsGiven += chats.given;
      chatsLeft = chats.left;
    }
    if (elsewhere.length > 0) answer.elsewhere = elsewhere;
  }
  if (all.length > matches.length || answer.capped === true || chatsLeft) {
    const now = [...given, ...matches.map(({ at }) => at)].sort((left, right) => left - right);
    const at = place === undefined ? (now.length >= GIVEN_MOST ? -1 : undefined) : Math.max(place, ...ranked.slice(0, PEOPLE_SEARCH_MATCHES).map((each) => each.at));
    answer.next = {
      given: at === undefined ? now : now.filter((each) => each > at),
      ...(at === undefined ? {} : { place: at }),
      ...(chatsGiven === 0 ? {} : { chats: chatsGiven }),
    };
  }
  return answer;
}

function titledChats(words: readonly string[], input: PeopleSearchInput): PeopleSearchChat[] {
  return input.chats.filter((chat) => !chat.group && words.every((word) => titleWords(chat.label).some((each) => each.startsWith(word))));
}

function chatsElsewhere(titled: readonly PeopleSearchChat[], input: PeopleSearchInput, from: number): { entries: Elsewhere[]; given: number; left: boolean } {
  const page = titled.slice(from, from + ELSEWHERE_CHATS);
  const entries = input.counted((counts) => page.flatMap(({ key }): Elsewhere[] => {
    const read = counts.reach({ chat: key });
    if (read === undefined) return [{ as: "chat", ...(input.served === undefined ? { chat: key } : {}), capped: true }];
    const messages = read.reach.messages;
    return messages === undefined || messages[0] === 0 ? [] : [{ as: "chat", chat: key, n: messages[0], first: messages[1], last: messages[2] }];
  }));
  return { entries, given: page.length, left: titled.length > from + page.length };
}

function listSame(match: PeopleSearchMatch, same: NonNullable<PeopleSearchMatch["same"]>, input: PeopleSearchInput): void {
  const held = input.served === undefined ? same : same.filter(({ id }) => input.served!.involved(id));
  if (held.length > 0) match.same = held;
}

interface FullNames {
  own: Set<string>;
  seen: Set<string>;
}

function fullNamesOf(person: PersonDetail, seen: boolean): FullNames {
  const key = (name: string) => {
    const words = nameWords(name);
    return isName(name) && words.length >= FULL_WORDS ? [words.join(" ")] : [];
  };
  const own = new Set([...(person.by === "none" ? [] : [person.call_name]), person.full_name ?? "", ...person.also_called.map(({ name }) => name)].flatMap(key));
  return { own, seen: new Set((seen ? person.names_seen : []).flatMap(key).filter((name) => !own.has(name))) };
}

function sameFinder(input: PeopleSearchInput, order: ReadonlyMap<string, number>): (id: string) => NonNullable<PeopleSearchMatch["same"]> {
  let byWord: Map<string, Set<string>> | undefined;
  const read = new Map<string, { person: PersonDetail; names: FullNames } | undefined>();
  const detail = (id: string) => {
    if (!read.has(id)) {
      const person = read.size < SAME_READS ? input.person(id) : undefined;
      read.set(id, person === undefined ? undefined : { person, names: fullNamesOf(person, input.served === undefined) });
    }
    return read.get(id);
  };
  const bearing = (name: string): string[] => {
    byWord ??= wordIndex(input.searched);
    const sets = name.split(" ").map((word) => byWord!.get(word) ?? new Set<string>()).sort((left, right) => left.size - right.size);
    return [...sets[0]!].filter((id) => sets.every((set) => set.has(id)));
  };
  return (id) => {
    const self = detail(id);
    if (self === undefined || self.person.me || self.person.hidden) return [];
    const { person, names } = self;
    const handleless = (each: PersonDetail) => each.record !== null && each.handles.length === 0;
    const found: { id: string; by: SameBy }[] = [];
    for (const other of [...new Set([...names.own, ...names.seen].flatMap(bearing))].sort((left, right) => (order.get(left) ?? Infinity) - (order.get(right) ?? Infinity) || compare(left, right))) {
      if (found.length === SAME_MOST) break;
      if (other === id) continue;
      const them = detail(other);
      if (them === undefined || them.person.me || them.person.hidden) continue;
      const declined = sameIdOf(person.id, them.person.id);
      if ([person, them.person].some((each) => each.record?.dismissed.includes(declined) === true)) continue;
      const shared = (left: Set<string>, right: Set<string>) => [...left].some((name) => right.has(name));
      const own = shared(names.own, them.names.own);
      const seen = shared(names.own, them.names.seen) || shared(names.seen, them.names.own);
      if (!own && !seen) continue;
      found.push({ id: other, by: handleless(person) || handleless(them.person) ? "face" : own ? "name" : "sender" });
    }
    return found;
  };
}

function wordIndex(searched: readonly Searched[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const person of searched) {
    for (const word of person.words) {
      const ids = index.get(word);
      if (ids === undefined) index.set(word, new Set([person.id]));
      else ids.add(person.id);
    }
  }
  return index;
}

function tookOf(person: Searched, words: readonly string[], near: boolean): Took | null {
  const took: Took = { id: person.id, words: [], near: new Set() };
  for (const word of words) {
    const short = [...word].length <= SHORT_WHOLE && /^\p{L}+$/u.test(word);
    const initial = short && words.length > 1;
    const started = new Set(person.words.filter((name) => (short && !initial ? name === word : name.startsWith(word))));
    if (started.size > 0 || person.values.some((value) => (short ? value === word : value.includes(word))) || phoneHolds(person, word)) {
      took.words.push(started);
      continue;
    }
    if (!near) return null;
    const close = person.words.filter((name) => isNear(word, name));
    if (close.length === 0) return null;
    took.words.push(new Set(close));
    for (const name of close) took.near.add(name);
  }
  return took.near.size > 0 || !near ? took : null;
}

function phoneHolds(person: Searched, word: string): boolean {
  const digits = word.replace(/[+\s().-]/gu, "");
  return /^\d{3,}$/u.test(digits) && person.phones.some((phone) => phone.includes(digits));
}

export function isNear(word: string, name: string): boolean {
  if (word === name || [...word].length < NEAR_FROM || [...name].length < NEAR_FROM || /\d/u.test(word)) return false;
  const skeleton = skeletonOf(word);
  if ([...skeleton].length >= SKELETON_FROM && skeleton === skeletonOf(name)) return true;
  if ([...word].length < EDIT_FROM) return false;
  if (edited?.word !== word) edited = { word, edits: editsOf(word) };
  return edited.edits.has(name);
}
let edited: { word: string; edits: Set<string> } | undefined;

function personMatch(id: string, took: Took | undefined, input: PeopleSearchInput, counts: PeopleSearchCounts, chats: ReadonlyMap<string, PeopleSearchChat>, isCounted = true): PeopleSearchMatch | undefined {
  const person = input.person(id);
  if (person === undefined) return undefined;
  const read = isCounted ? counts.reach({ person: id }) : undefined;
  const { reach, chats: counted } = read ?? { reach: {}, chats: [] };
  const also = [...new Set(servedNames(id, input))].filter((name) => name !== person.name).slice(0, ALSO_MOST);
  const shown = [...counted].sort((left, right) => right.messages - left.messages || compare(left.chat, right.chat));
  return {
    id, kind: kindOf(person.entity), name: person.name, also, handles: input.served === undefined ? person.handles.map((handle) => handle.id) : [...input.served.handles(id)],
    chats: shown.slice(0, PEOPLE_SEARCH_CHATS).map(({ chat, messages }) => ({ chat, title: chats.get(chat)?.label ?? chat, messages })),
    ...(shown.length > PEOPLE_SEARCH_CHATS ? { chats_more: shown.length - PEOPLE_SEARCH_CHATS } : {}),
    reach, ...(took !== undefined && took.near.size > 0 ? { near: [...took.near].sort(compare) } : {}), ...(person.me ? { me: true as const } : {}),
    ...(read === undefined ? { capped: true as const } : {}),
  };
}

function groupMatch(chat: PeopleSearchChat, counts: PeopleSearchCounts, counted = true): PeopleSearchMatch {
  const read = counted ? counts.reach({ chat: chat.key }) : undefined;
  const messages = read?.chats.find((each) => each.chat === chat.key)?.messages;
  return {
    id: chat.key, kind: "group", name: chat.label, also: [], handles: [], chats: [{ chat: chat.key, title: chat.label, ...(messages === undefined ? {} : { messages }) }],
    reach: read?.reach ?? {}, ...(read === undefined ? { capped: true as const } : {}),
  };
}

function kindOf(entity: string): PeopleSearchMatch["kind"] {
  return entity === "business" ? "business" : entity === "bot" || entity === "ai" ? "bot" : "person";
}

function spanOfMatch(match: PeopleSearchMatch, input: PeopleSearchInput): [string, string] | null {
  const spans = Object.values(match.reach);
  if (spans.length > 0) return [spans.map(([, first]) => first).sort()[0]!, spans.map(([, , last]) => last).sort().at(-1)!];
  const days = Object.keys(input.person(match.id)?.days ?? {}).sort();
  return days.length === 0 ? null : [days[0]!, days.at(-1)!];
}

const COUNTED = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function noteOf(matches: readonly PeopleSearchMatch[], input: PeopleSearchInput): string {
  const tied = matches.filter((match) => match.tied !== undefined).length;
  const many = COUNTED[matches.length] ?? String(matches.length);
  const head = tied === matches.length ? `${many} contacts go by this name` : tied > 0 ? `${many} match, ${COUNTED[tied] ?? tied} of them contacts that share the name` : `${many} match`;
  if (input.nameless === true) return `${head}; each match's \`reach\` says when it was in touch`;
  const spanned = matches.map((match, at) => {
    const span = spanOfMatch(match, input);
    const id = match.id;
    if (span === null && match.capped === true) return `${id} not counted`;
    return `${id} ${at === 0 ? "in touch " : ""}${span === null ? "no contact held" : `${span[0]} → ${span[1]}`}`;
  });
  return `${head}: ${spanned.join(", ")}`;
}

function servedNames(id: string, input: PeopleSearchInput): readonly string[] {
  return input.served === undefined ? namesOf(input.person(id), true) : input.served.names(id);
}

export function namesOf(person: PersonDetail | undefined, seen: boolean): string[] {
  if (person === undefined) return [];
  return [person.name, person.call_name, person.full_name ?? "", ...person.also_called.map(({ name }) => name), ...(seen ? person.names_seen : [])].filter((name) => name.trim() !== "");
}

function nameWords(name: string): string[] {
  return foldName(name).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function titleWords(title: string): string[] {
  return foldName(title).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}


const HEADS = "heads";
const RESOLVED = "who";
const NO_HEADS = createHash("sha256").digest("hex");
const OWNER_KINDS = ["person", "photo", "details", "group"] as const;
type OwnerKind = (typeof OWNER_KINDS)[number];
type Versions = Record<OwnerKind, Record<string, string>>;

export interface PeopleJoin {
  readonly same: boolean;
  list(): PeopleAnswer["list"] | JoinedList;
  person(id: string): { row: string } | { person: JoinedPerson } | undefined;
  detail(id: string): JoinedPerson | undefined;
  stands(id: string): string | null | undefined;
}

interface PeopleHeads {
  readonly versions: Versions;
  readonly digest: string;
}

function peopleHeads(view: OpenView): PeopleHeads {
  const versions: Versions = { person: {}, photo: {}, details: {}, group: {} };
  const hash = createHash("sha256");
  for (const { id } of view.sources(PEOPLE_SOURCES)) {
    for (const kind of OWNER_KINDS) {
      for (const head of view.heads(id, kind)) {
        versions[kind][`${id}\0${head.key}`] = head.version;
        hash.update(`${kind}\0${id}\0${head.key}\0${head.version}\n`);
      }
    }
  }
  return { versions, digest: hash.digest("hex") };
}

function whoRows(who: Who): Map<string, JsonObject> {
  return new Map<string, JsonObject>([
    ["cards", { cards: who.cards as unknown as Json[] }], ["providers", { providers: who.providers as unknown as Json[] }],
    ["seen", { seen: who.seen as unknown as Json[] }], ["faces", { faces: who.faces as unknown as JsonObject }],
  ]);
}

function whoOf(file: PreparedRead): Who {
  const part = <K extends keyof Who>(key: K): Who[K] => file.value<Record<K, Who[K]>>(RESOLVED, key)![key];
  return { cards: part("cards"), providers: part("providers"), seen: part("seen"), faces: part("faces") };
}

export function peopleJoined(view: OpenView, file: PreparedRead, families: readonly Family[]): PeopleJoin {
  const heads = peopleHeads(view);
  const same = (file.meta(HEADS) ?? NO_HEADS) === heads.digest;
  let joined: Rejoined | undefined;
  const join = () => joined ??= rejoined(view, file, heads, families);
  const person = (id: string): ReturnType<PeopleJoin["person"]> => {
    if (!same) return join().person(id);
    const row = keptPerson(file, id);
    return row === undefined ? undefined : { row };
  };
  return {
    same, person,
    list: () => same ? file.value<PeopleAnswer["list"]>("answer", "list")! : join().list(),
    detail(id) {
      const found = person(id);
      return found === undefined ? undefined : "row" in found ? file.value<{ person: PersonDetail }>("person", found.row)?.person : found.person;
    },
    stands: (id) => same ? keptPerson(file, id) : join().stands(id),
  };
}

export function keptPerson(file: PreparedRead, id: string): string | undefined {
  const spelled = spelledId(id);
  return (file.value<{ id: string }>("alias", id) ?? (spelled === null ? undefined : file.value<{ id: string }>("alias", spelled)))?.id;
}

let resolved: { key: string; now: PeopleNow; people: People; who: Who } | undefined;

function rejoined(view: OpenView, file: PreparedRead, heads: PeopleHeads, families: readonly Family[]): Rejoined {
  const kept = new Map(file.rows<{ versions: Record<string, string> }>(HEADS));
  const changed = (kind: OwnerKind): string[] => {
    const was = kept.get(kind)?.versions ?? {};
    const is = heads.versions[kind];
    return [...new Set([...Object.keys(was), ...Object.keys(is)].filter((key) => was[key] !== is[key]).map((key) => key.slice(key.indexOf("\0") + 1)))];
  };
  const networks = networksIn(families);
  const own = ownHandles(view, ownProductsIn(families), networks);
  const country = ownCountry(view, networks);
  const key = [file.db.name, file.position, heads.digest, country ?? "", ...own.map((each) => `${each.product}\0${handleId(each)}`)].join("\n");
  if (resolved?.key !== key) {
    const now: PeopleNow = { ...peopleSaid(view, (image) => view.holds(image)), own, country, networks, names: productNames(families) };
    const who = whoOf(file);
    resolved = { key, now, who, people: whoNow(who, now) };
  }
  const words = new Map(changed("group").map((chat) => [chat, groupWord(view, chat)] as const));
  const run: PeopleRun = {
    who: resolved.who,
    list: () => file.value<PeopleAnswer["list"]>("answer", "list")!,
    row: (id) => file.value<{ person: PersonDetail }>("person", id)?.person,
    alias: (id) => file.value<{ id: string }>("alias", id)?.id,
  };
  return rejoin(run, resolved.people, resolved.now, { persons: changed("person"), keys: [...changed("photo"), ...changed("details")], groups: words }, !jobPaused(view, "people"));
}

function groupWord(view: OpenView, chat: string): boolean | null {
  let newest: { quiet: boolean; stated_ms: number } | null = null;
  for (const { id } of view.sources(PEOPLE_SOURCES)) {
    const head = view.head({ source: id, kind: "group", key: chat });
    const content = head === undefined || head.version === GONE ? null : view.version(head.version).content;
    if (head !== undefined && isObject(content) && typeof content.quiet === "boolean" && (newest === null || head.stated_ms > newest.stated_ms)) newest = { quiet: content.quiet, stated_ms: head.stated_ms };
  }
  return newest?.quiet ?? null;
}

function peopleSaid(view: OpenView, held: (image: string) => boolean): Pick<PeopleNow, "records" | "photos" | "details"> {
  const records = readPeople(view);
  const photos: StatedPhoto[] = [];
  const details: StatedDetails[] = [];
  for (const { id: source } of view.sources(PEOPLE_SOURCES)) {
    for (const { head, version } of view.records(source, "photo")) {
      const image = head.version !== GONE && isObject(version.content) && typeof version.content.image === "string" ? version.content.image : null;
      if (image !== null && held(image)) photos.push({ key: head.key, image, stated_ms: head.stated_ms });
    }
  }
  for (const { id: source } of view.sources(PEOPLE_SOURCES)) {
    for (const { head, version } of view.records(source, "details")) {
      const value = head.version === GONE ? null : detailsOfContent(version.content);
      if (value !== null) details.push({ key: head.key, details: value, stated_ms: head.stated_ms });
    }
  }
  return { records, photos, details };
}
