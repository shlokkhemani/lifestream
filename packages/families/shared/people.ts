import {
  addDays, calledName, canonicalEmail, canonicalPhone, compareHandles, foldName, GONE, handleId, handleOf, isPlainWord, MOST_CALLED, profileFault,
  readPersonRecord, sha256, type Entity, type Handle, type Json, type PersonRecord, type ProfileNetwork, type RecordRef, type View,
} from "@lifestreamprotocol/core";
import type { PersonLabel, ProviderLabel } from "../family.js";
import { labelIdOf, providerHandle, providerUnit, type Networks } from "../messages/networks.js";
import { isName, unknownName } from "./cast.js";
import { contactCard, contactId, contactPhoto, properties, type ContactPhoto, type ContactRef } from "./contact.js";


export const CANDIDATE_MESSAGES = 3;
export const CANDIDATE_MAILS = 2;
export const OFTEN = 10;
export const HALF_LIFE_DAYS = 90;
export const WEIGHTS = { theirs: 1, mine: 2, mail: 3, photo: 2 } as const;
export const AI_REPLIES = 20;
export const AI_QUICK_SHARE = 0.7;
export const QUICK_MS = 20_000;
export const AI_RATIO = 1.5;
export const WISHED_YEARS = 2;
const WORK_CHARACTERS = 120;
const FIRST_YEAR = 1900;
const NAME_WORDS = 2;
const MOST_OF_A_KIND = 3;
const MOST_PROFILES = 12;
const NO_REPLY = /(?:^|[._+-])(?:noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|bounces?|notifications?|notify)(?:[._+-]|$)/u;
export const SERVICE_FIRSTS = 3;
export const BUSINESS_LEVEL = 3;
export const BUSINESS_NAME_LETTERS = 3;
const SECOND_LEVELS = new Set(["ac", "bank", "co", "com", "edu", "firm", "gen", "gov", "ind", "ltd", "mil", "net", "nic", "org", "plc", "res", "sch"]);
const TITLES = new Set(["mr", "mrs", "ms", "dr"]);


export interface Card extends CardParts {
  id: string;
  since_ms: number;
}

export interface CardParts {
  name: string | null;
  names: string[];
  nicknames: string[];
  business: boolean;
  phones: string[];
  emails: string[];
  photo: ContactPhoto | null;
  work: string | null;
  birthday: Birthday | null;
  profiles: Profile[];
}

export interface Birthday {
  month: number;
  day: number;
  year: number | null;
}

export interface Profile {
  network: ProfileNetwork;
  value: string;
}

export type DetailField = "work" | "birthday" | "profiles";

export interface Details {
  work: string | null;
  birthday: Birthday | null;
  profiles: readonly Profile[];
  cleared?: readonly DetailField[];
}

export interface DetailsStatement {
  readonly key: string;
  readonly stated_ms: number;
  readonly details: Details;
}

export interface RecordState {
  record: PersonRecord;
  since: ReadonlyMap<string, number>;
  me_since: number | null;
  merged_since: number | null;
}

export interface PeopleInputs {
  cards: readonly Card[];
  records: readonly RecordState[];
  providers: ReadonlyMap<string, ProviderLabel>;
  networks?: Networks;
  country: string | null;
  own?: readonly OwnHandle[];
  seen?: Iterable<Handle>;
}

export interface OwnHandle extends Handle {
  readonly product: string;
}

export type LinkedBy = "you" | "card" | "home" | (string & {}) | null;

export interface PersonHandle extends Handle {
  from: LinkedBy;
}

export interface Person {
  id: string;
  name: string;
  call_name: string;
  full_name: string | null;
  show: PersonRecord["show"];
  by: PersonLabel["by"];
  slug: string | null;
  slugs: readonly string[];
  entity: Entity | null;
  relationship: string | null;
  me: boolean;
  hidden: boolean;
  organised: boolean;
  handles: readonly PersonHandle[];
  cards: readonly Card[];
  record: PersonRecord | null;
  stated: PersonRecord | null;
}

export interface People {
  readonly all: readonly Person[];
  readonly ids: ReadonlyMap<string, Person>;
  readonly apart: ReadonlyMap<string, readonly string[]>;
  readonly providers: ReadonlyMap<string, ProviderLabel>;
  readonly networks: Networks | undefined;
  readonly accounts: ReadonlyMap<string, readonly string[]>;
  readonly joined: ReadonlyMap<string, readonly Member[]>;
}

export interface Member {
  readonly slug: string;
  readonly with: readonly string[];
  readonly leaving: readonly Handle[];
  readonly card: Card | null;
}


export function readCard(ref: ContactRef, since_ms: number, parts: CardParts): Card {
  return { ...parts, id: contactId(ref), since_ms };
}

export function cardParts(content: Json): CardParts | null {
  const vcard = contactCard(content);
  if (vcard === null) return null;
  let fn: string | null = null, n: string | null = null, org: string | null = null, title: string | null = null, birthday: Birthday | null = null;
  const nicknames: string[] = [], phones: string[] = [], emails: string[] = [], profiles: Profile[] = [];
  for (const { name, value, parameters } of properties(vcard)) {
    if (name === "FN" && fn === null) fn = unescape(value) || null;
    else if (name === "N" && n === null) n = nameOfN(value);
    else if (name === "ORG" && org === null) org = unescape(value.split(/(?<!\\);/u)[0] ?? "") || null;
    else if (name === "TITLE" && title === null) title = unescape(value) || null;
    else if (name === "BDAY" && birthday === null) birthday = birthdayOf(value, parameters);
    else if (name === "NICKNAME") nicknames.push(...value.split(/(?<!\\),/u).map(unescape).filter(Boolean));
    else if (name === "TEL" && value !== "") phones.push(value);
    else if (name === "EMAIL") pushNew(emails, canonicalEmail(value));
    else if (name === "URL" || name === "X-SOCIALPROFILE") {
      const profile = profileOf(unescape(value)) ?? (name === "X-SOCIALPROFILE" ? socialProfile(parameters) : null);
      if (profile !== null && !profiles.some((each) => each.network === profile.network && each.value === profile.value)) profiles.push(profile);
    }
  }
  const shown = fn ?? n ?? org;
  if (shown === null && phones.length === 0 && emails.length === 0) return null;
  const names = [...new Set([fn, n, ...nicknames, org].flatMap((each) => each === null ? [] : [each]))];
  const business = org !== null && n === null;
  const work = business ? null : [title, org].filter((each) => each !== null).join(", ") || null;
  return {
    name: shown, names, nicknames: [...new Set(nicknames)], business, phones, emails, photo: contactPhoto(content),
    work: work !== null && [...work].length <= WORK_CHARACTERS ? work : null, birthday, profiles,
  };
}

function birthdayOf(value: string, parameters: readonly string[]): Birthday | null {
  const date = value.split("T")[0]!;
  const dated = /^(\d{4})-?(\d{2})-?(\d{2})$/u.exec(date);
  const yearless = dated === null ? /^--(\d{2})-?(\d{2})$/u.exec(date) : null;
  if (dated === null && yearless === null) return null;
  const year = dated === null ? null : Number(dated[1]);
  const [month, day] = (dated === null ? yearless!.slice(1) : dated.slice(2)).map(Number) as [number, number];
  const omitted = parameters.some((each) => /^X-APPLE-OMIT-YEAR=/iu.test(each) && Number(each.slice(each.indexOf("=") + 1)) === year);
  const known = year !== null && !omitted && year !== 1604 && year >= FIRST_YEAR && year <= new Date().getUTCFullYear() ? year : null;
  return isBirthday(month, day, known) ? { month, day, year: known } : null;
}

function isBirthday(month: number, day: number, year: number | null): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year === null || (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0));
  return day <= (month === 2 ? (leap ? 29 : 28) : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!);
}

const NETWORK_HOSTS: Readonly<Record<string, Profile["network"]>> = {
  "instagram.com": "instagram", "x.com": "x", "twitter.com": "x", "linkedin.com": "linkedin", "facebook.com": "facebook", "github.com": "github",
};
const NOT_HANDLES: Readonly<Partial<Record<Profile["network"], ReadonlySet<string>>>> = {
  instagram: new Set(["p", "reel", "reels", "explore", "stories", "accounts", "tv"]),
  x: new Set(["home", "i", "intent", "share", "search", "hashtag", "explore", "settings"]),
  facebook: new Set(["pages", "groups", "events", "sharer", "share", "watch"]),
  github: new Set(["orgs", "topics", "settings", "marketplace", "explore"]),
};

export function profileOf(link: string): Profile | null {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/iu.test(link) ? link : `https://${link}`);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname.includes(".")) return null;
  const host = url.hostname.replace(/^(?:www|m|mobile)\./u, "");
  const network = NETWORK_HOSTS[host];
  const words = url.pathname.split("/").filter(Boolean).map((word) => {
    try {
      return decodeURIComponent(word);
    } catch {
      return word;
    }
  });
  if (network === undefined) return kept({ network: "site", value: `${url.hostname}${url.pathname.replace(/\/+$/u, "")}` });
  const handle = network === "linkedin" ? (words[0] === "in" ? words[1] : undefined)
    : network === "facebook" && words[0] === "profile.php" ? url.searchParams.get("id") ?? undefined
    : words[0];
  if (handle === undefined || NOT_HANDLES[network]?.has(handle.toLowerCase()) === true) return null;
  return kept({ network, value: network === "x" || network === "instagram" || network === "github" ? handle.replace(/^@/u, "").toLowerCase() : handle });
}

function socialProfile(parameters: readonly string[]): Profile | null {
  const parameter = (name: string) => parameters.find((each) => each.toUpperCase().startsWith(`${name}=`))?.slice(name.length + 1);
  const type = parameter("TYPE")?.toLowerCase();
  const user = parameter("X-USER");
  const network = type === "twitter" ? "x" : type === undefined ? undefined : NETWORK_HOSTS[`${type}.com`];
  if (network === undefined || user === undefined) return null;
  return kept({ network, value: network === "linkedin" || network === "facebook" ? user : user.replace(/^@/u, "").toLowerCase() });
}

function kept(profile: Profile): Profile | null {
  return profileFault(profile as unknown as Json) === undefined ? profile : null;
}

function nameOfN(value: string): string | null {
  const [family = "", given = "", additional = ""] = value.split(/(?<!\\);/u).map(unescape);
  const name = [given, additional, family].map((part) => part.trim()).filter(Boolean).join(" ");
  return name === "" ? null : name;
}

function unescape(value: string): string {
  return value.replace(/\\([nN,;:\\])/gu, (_all, char: string) => (char === "n" || char === "N" ? " " : char)).trim();
}

export function readRecord(view: View, ref: RecordRef): RecordState | null {
  const head = view.head(ref);
  if (head === undefined || head.version === GONE) return null;
  const record = readPersonRecord(view.version(head.version).content);
  if (record === null) return null;
  const tracked = new Map(heldHandles(record).map((handle) => [handleId(handle), head.stated_ms]));
  const live = new Set(tracked.keys());
  let me = record.me ? head.stated_ms : null;
  let meLive = me !== null;
  let merged = record.merged_into === null ? null : head.stated_ms;
  let mergedLive = merged !== null;
  const read = new Map<string, PersonRecord | null>();
  for (const statement of view.history(ref).sort((left, right) => right.stated_ms - left.stated_ms || right.seq - left.seq)) {
    if (live.size === 0 && !meLive && !mergedLive) break;
    if (statement.late || statement.stated_ms > head.stated_ms) continue;
    if (statement.version === GONE) break;
    if (!read.has(statement.version)) read.set(statement.version, readPersonRecord(view.version(statement.version).content));
    const then = read.get(statement.version)!;
    const ids = new Set(then === null ? [] : heldHandles(then).map(handleId));
    for (const id of live) {
      if (ids.has(id)) tracked.set(id, statement.stated_ms);
      else live.delete(id);
    }
    if (meLive && then?.me === true) me = statement.stated_ms;
    else meLive = false;
    if (mergedLive && then?.merged_into === record.merged_into) merged = statement.stated_ms;
    else mergedLive = false;
  }
  return { record, since: tracked, me_since: me, merged_since: merged };
}

export function heldHandles(record: PersonRecord): Handle[] {
  return [...(record.anchor === null ? [] : [record.anchor]), ...record.handles];
}

export type StatedPerson = PersonRecord & { type: "people.person" };

export function statedPerson(record: PersonRecord): StatedPerson {
  return { type: "people.person", ...record, handles: record.handles.filter((handle) => record.anchor === null || handleId(handle) !== handleId(record.anchor)) };
}


export type You = { readonly root: string; readonly marked: boolean } | { readonly holder: true } | null;

export function youOf({ states, rootOf }: MergeTree, own: readonly Handle[]): You {
  const marks = new Map<string, number>();
  const claims = new Map<string, number>();
  const ids = new Set(own.map(handleId));
  for (const [slug, state] of states) {
    const root = rootOf.get(slug)!;
    if (state.record.me) marks.set(root, Math.max(marks.get(root) ?? -Infinity, state.me_since ?? 0));
    for (const handle of heldHandles(state.record)) {
      const id = handleId(handle);
      if (ids.has(id)) claims.set(root, Math.min(claims.get(root) ?? Infinity, state.since.get(id) ?? Number.MAX_SAFE_INTEGER));
    }
  }
  const [marked] = [...marks].sort(([leftRoot, left], [rightRoot, right]) => right - left || compare(leftRoot, rightRoot));
  if (marked !== undefined) return { root: marked[0], marked: true };
  const [claimed] = [...claims].sort(([leftRoot, left], [rightRoot, right]) => left - right || compare(leftRoot, rightRoot));
  if (claimed !== undefined) return { root: claimed[0], marked: false };
  return ids.size > 0 ? { holder: true } : null;
}


const HOLDER = "";

export function resolve(inputs: PeopleInputs): People {
  const handles = new Map<string, Handle>();
  const note = (handle: Handle | null): string | null => {
    if (handle === null) return null;
    const id = handleId(handle);
    if (!handles.has(id)) handles.set(id, handle);
    return id;
  };

  const cards = new Map<string, { card: Card; ids: string[] }>();
  for (const card of [...inputs.cards].sort((left, right) => left.since_ms - right.since_ms || compare(left.id, right.id))) {
    if (cards.has(card.id)) continue;
    const ids = [...new Set([
      ...card.phones.map((phone) => note(phoneHandle(canonicalPhone(phone, inputs.country)))),
      ...card.emails.map((email) => note({ kind: "email", value: email })),
    ].flatMap((id) => id === null ? [] : [id]))];
    cards.set(card.id, { card, ids });
  }
  const home = [...new Set((inputs.own ?? []).flatMap(({ kind, value }) => note({ kind, value }) ?? []))].sort(compare);
  const ownIds = new Set(home);

  const tree = mergeTree(inputs.records);
  const { states, groups, into } = tree;
  const you = youOf(tree, inputs.own ?? []);
  const youRoot = you !== null && "root" in you ? you.root : null;
  const merged = new Map([...groups].map(([root, group]) => [root, foldGroup(root, group, root === youRoot)]));
  const cut = new Set<string>();
  for (const state of states.values()) {
    for (const handle of state.record.excluded) {
      const id = note(handle)!;
      if (!ownIds.has(id)) cut.add(id);
    }
  }

  for (const group of groups.values()) for (const state of group) for (const handle of heldHandles(state.record)) note(handle);
  const { claims, apart } = claimed(groups, home, youRoot);

  const links: [string, string, LinkedBy & string][] = [];
  for (const { ids } of cards.values()) {
    const linked = ids.filter((id) => !cut.has(id));
    for (let index = 1; index < linked.length; index++) links.push([linked[0]!, linked[index]!, "card"]);
  }
  const paired = new Map<string, string>();
  const pairings: [string, string][] = [];
  for (const [unit, label] of [...inputs.providers].sort(([left], [right]) => compare(left, right))) {
    if (label.business !== undefined && Object.keys(label).every((member) => member === "business" || member === "businessName")) continue;
    const handle = inputs.networks === undefined ? handleOf(unit.slice(unit.indexOf(":") + 1)) : providerHandle(inputs.networks, unit);
    const product = handle === null ? undefined : networksSpelling(inputs.networks, handle).find((each) => providerUnit(inputs.networks!, each.product, each.id) === unit)?.product;
    const id = note(handle);
    const prefix = unit.slice(0, unit.indexOf(":") + 1);
    for (const alias of label.aliases ?? []) {
      const other = note(inputs.networks === undefined ? handleOf(alias) : providerHandle(inputs.networks, `${prefix}${alias}`));
      if (product === undefined || id === null || other === null || id === other) continue;
      pairings.push([id, other]);
      if (cut.has(id) || cut.has(other)) continue;
      links.push([id, other, product]);
      if (!paired.has(id)) paired.set(id, product);
      if (!paired.has(other)) paired.set(other, product);
    }
  }
  for (const handle of inputs.seen ?? []) note(handle);
  for (const id of home.slice(1)) links.push([home[0]!, id, "home"]);

  const union = new UnionFind();
  for (const id of handles.keys()) union.add(id);
  for (const [left, right] of links) union.join(left, right);
  const components = union.groups();

  const owned = new Map<string, string[]>();
  const own_ = (root: string, ids: readonly string[]) => {
    const list = owned.get(root);
    if (list === undefined) owned.set(root, [...ids]);
    else list.push(...ids);
  };
  const loose: string[][] = [];
  for (const members of components) {
    const roots = new Set(members.flatMap((id) => claims.get(id) ?? []));
    if (roots.size === 1) {
      own_([...roots][0]!, members);
      continue;
    }
    if (roots.size === 0) {
      loose.push(members);
      continue;
    }
    const sorted = [...roots].sort(compare);
    for (const [index, left] of sorted.entries()) for (const right of sorted.slice(index + 1)) apart.add(pair(left, right));
    const rest = new Set(members.filter((id) => !claims.has(id)));
    for (const id of members) {
      const root = claims.get(id);
      if (root !== undefined) own_(root, [id]);
    }
    const again = new UnionFind();
    for (const id of rest) again.add(id);
    for (const [left, right] of links) if (rest.has(left) && rest.has(right)) again.join(left, right);
    loose.push(...again.groups());
  }

  const cardsOf = new Map<string, Card[]>();
  for (const { card, ids } of cards.values()) {
    for (const id of ids) {
      const list = cardsOf.get(id);
      if (list === undefined) cardsOf.set(id, [card]);
      else list.push(card);
    }
  }
  const accounts = new Map<string, string[]>();
  for (const handle of inputs.own ?? []) {
    const id = handleId(handle);
    accounts.set(id, [...new Set([...accounts.get(id) ?? [], handle.product])].sort(compare));
  }
  const build = (ids: Iterable<string>, root: Folded | null, extraCards: readonly Card[] = []): Person => {
    const list = [...ids].map((id) => handles.get(id)!).sort(compareHandles);
    const theirCards = [...new Map([...list.flatMap((handle) => cardsOf.get(handleId(handle)) ?? []), ...extraCards].map((card) => [card.id, card])).values()]
      .sort((left, right) => right.since_ms - left.since_ms || compare(left.id, right.id));
    const linked = (handle: Handle): LinkedBy => {
      const id = handleId(handle);
      if (ownIds.has(id)) return "home";
      if (root !== null && claims.get(id) === root.record.slug) return "you";
      if (list.length === 1) return null;
      if (theirCards.some((card) => cards.get(card.id)!.ids.includes(id))) return "card";
      return paired.get(id) ?? null;
    };
    const record = root?.record ?? null;
    const called = callName(record, theirCards, list, providerLabels(list, inputs.providers, inputs.networks));
    return {
      id: record !== null ? `person:${record.slug}` : list[0] !== undefined ? handleId(list[0]) : contactPersonId(theirCards[0]!),
      name: shownName(record, called.name), call_name: called.name, full_name: record?.full_name ?? null,
      show: record?.show ?? "name", by: called.by,
      slug: record?.slug ?? null, slugs: root?.slugs ?? [], entity: record?.entity ?? null, relationship: record?.relationship ?? null,
      me: youRoot !== null ? record?.slug === youRoot : you !== null && list.some((handle) => ownIds.has(handleId(handle))),
      hidden: record?.hidden ?? false, organised: record !== null,
      handles: list.map((handle) => ({ ...handle, from: linked(handle) })), cards: theirCards, record, stated: root?.stated ?? null,
    };
  };
  const all: Person[] = [];
  for (const [root, folded] of merged) all.push(build(owned.get(root) ?? [], folded));
  const holder = owned.has(HOLDER) ? build(owned.get(HOLDER)!, null) : null;
  if (holder !== null) all.push(holder);
  for (const members of loose) all.push(build(members, null));
  for (const { card, ids } of cards.values()) if (ids.length === 0) all.push(build([], null, [card]));
  all.sort((left, right) => compare(left.id, right.id));

  const byId = new Map<string, Person>();
  for (const person of all) {
    byId.set(person.id, person);
    for (const slug of person.slugs) byId.set(`person:${slug}`, person);
    for (const handle of person.handles) byId.set(handleId(handle), person);
  }
  for (const person of all) for (const card of person.cards) if (!byId.has(contactPersonId(card))) byId.set(contactPersonId(card), person);
  const kept = new Map<string, string[]>();
  const idOf = (root: string) => root === HOLDER ? holder!.id : `person:${root}`;
  for (const key of apart) {
    const [left, right] = key.split("\0").map(idOf) as [string, string];
    kept.set(left, [...kept.get(left) ?? [], right]);
    kept.set(right, [...kept.get(right) ?? [], left]);
  }
  const joined = membersOf(groups, into, {
    edges: [...[...cards.values()].map(({ ids }) => ids), ...pairings], own: ownIds, handles, cards: [...cards.values()],
  });
  return { all, apart: kept, providers: inputs.providers, networks: inputs.networks, ids: byId, accounts, joined };
}

function membersOf(
  groups: ReadonlyMap<string, readonly RecordState[]>, into: ReadonlyMap<string, string>,
  links: { edges: readonly (readonly string[])[]; own: ReadonlySet<string>; handles: ReadonlyMap<string, Handle>; cards: readonly { card: Card; ids: readonly string[] }[] },
): Map<string, Member[]> {
  const byHandle = new Map<string, (readonly string[])[]>();
  for (const edge of links.edges) for (const id of edge) push(byHandle, id, edge);
  const holders = new Map<string, Set<string>>();
  for (const group of groups.values()) {
    for (const state of group) {
      for (const handle of heldHandles(state.record)) {
        const id = handleId(handle);
        holders.set(id, (holders.get(id) ?? new Set()).add(state.record.slug));
      }
    }
  }
  const reach = (start: Iterable<string>, stop: (id: string) => boolean): Set<string> => {
    const out = new Set([...start].filter((id) => !stop(id)));
    const queue = [...out];
    for (let at = 0; at < queue.length; at++) {
      for (const edge of byHandle.get(queue[at]!) ?? []) {
        for (const id of edge) {
          if (out.has(id) || stop(id)) continue;
          out.add(id);
          queue.push(id);
        }
      }
    }
    return out;
  };
  const children = new Map<string, string[]>();
  for (const [slug, parent] of into) push(children, parent, slug);
  const out = new Map<string, Member[]>();
  for (const [root, group] of groups) {
    if (group.length < 2) continue;
    const order = [...group].filter((state) => state.record.slug !== root)
      .sort((left, right) => (left.merged_since ?? 0) - (right.merged_since ?? 0) || compare(left.record.slug, right.record.slug)).map((state) => state.record.slug);
    const rank = new Map(order.map((slug, index) => [slug, index]));
    const bySlug = new Map(group.map((state) => [state.record.slug, state.record]));
    const heldBy = (slugs: Iterable<string>) => [...slugs].flatMap((slug) => heldHandles(bySlug.get(slug)!).map(handleId));
    out.set(root, order.map((slug): Member => {
      const branch = [slug];
      for (let at = 0; at < branch.length; at++) branch.push(...children.get(branch[at]!) ?? []);
      const inBranch = new Set(branch);
      const branchHeld = new Set(heldBy(branch));
      const theirs = new Set(heldBy(group.map((state) => state.record.slug).filter((each) => !inBranch.has(each))));
      for (const id of [...theirs]) {
        for (const edge of byHandle.get(id) ?? []) if (!edge.some((each) => branchHeld.has(each))) for (const each of edge) theirs.add(each);
      }
      const stop = (id: string) => links.own.has(id) || theirs.has(id) || [...holders.get(id) ?? []].some((holder) => !inBranch.has(holder));
      const leaving = [...reach(branchHeld, stop)].map((id) => links.handles.get(id)!).sort(compareHandles);
      const record = bySlug.get(slug)!;
      const anchor = record.anchor === null ? null : handleId(record.anchor);
      const card = anchor === null ? null : links.cards.filter(({ ids }) => ids.includes(anchor)).map(({ card }) => card)
        .sort((left, right) => right.since_ms - left.since_ms || compare(left.id, right.id))[0] ?? null;
      return { slug, with: branch.slice(1).sort((left, right) => rank.get(left)! - rank.get(right)!), leaving, card };
    }));
  }
  return out;
}

export function contactPersonId(card: Pick<Card, "id">): string {
  return `contact:${card.id.slice(0, 16)}`;
}

function phoneHandle(phone: string | null): Handle | null {
  return phone === null ? null : { kind: "phone", value: phone };
}

export function claimsOf(tree: MergeTree, own: readonly Handle[]): ReadonlyMap<string, string | null> {
  const you = youOf(tree, own);
  const { claims } = claimed(tree.groups, [...new Set(own.map(handleId))], you !== null && "root" in you ? you.root : null);
  return new Map([...claims].map(([id, root]) => [id, root === HOLDER ? null : root]));
}

function claimed(groups: ReadonlyMap<string, readonly RecordState[]>, home: readonly string[], youRoot: string | null): { claims: Map<string, string>; apart: Set<string> } {
  const ownIds = new Set(home);
  const stated: { id: string; root: string; since: number }[] = [];
  for (const [root, group] of groups) {
    const excluded = new Set(group.flatMap((state) => state.record.excluded.map(handleId)));
    for (const state of group) {
      for (const handle of heldHandles(state.record)) {
        const id = handleId(handle);
        if (!excluded.has(id) && !ownIds.has(id)) stated.push({ id, root, since: state.since.get(id) ?? Number.MAX_SAFE_INTEGER });
      }
    }
  }
  const claims = new Map<string, string>(home.map((id) => [id, youRoot ?? HOLDER]));
  const apart = new Set<string>();
  for (const { id, root } of stated.sort((left, right) => left.since - right.since || compare(left.root, right.root))) {
    const first = claims.get(id);
    if (first === undefined) claims.set(id, root);
    else if (first !== root) apart.add(pair(first, root));
  }
  return { claims, apart };
}

export interface MergeTree {
  readonly states: ReadonlyMap<string, RecordState>;
  readonly rootOf: ReadonlyMap<string, string>;
  readonly into: ReadonlyMap<string, string>;
  readonly groups: ReadonlyMap<string, readonly RecordState[]>;
}

export function mergeTree(records: readonly RecordState[]): MergeTree {
  const states = new Map<string, RecordState>();
  for (const state of records) if (!states.has(state.record.slug)) states.set(state.record.slug, state);
  const into = new Map<string, string>();
  const rootOf = (slug: string): string => {
    let current = slug;
    for (let next = into.get(current); next !== undefined; next = into.get(current)) current = next;
    return current;
  };
  const merges = [...states.values()].filter((state) => state.record.merged_into !== null && states.has(state.record.merged_into))
    .sort((left, right) => (left.merged_since ?? 0) - (right.merged_since ?? 0) || compare(left.record.slug, right.record.slug));
  for (const state of merges) {
    if (rootOf(state.record.merged_into!) !== state.record.slug) into.set(state.record.slug, state.record.merged_into!);
  }
  const roots = new Map([...states.keys()].map((slug) => [slug, rootOf(slug)]));
  const groups = new Map<string, RecordState[]>();
  for (const [slug, state] of states) push(groups, roots.get(slug)!, state);
  return { states, rootOf: roots, into, groups };
}

export function registryNames({ rootOf, groups }: MergeTree, slugs: readonly string[]): Map<string, string> | null {
  const names = new Map<string, string>();
  for (const slug of slugs) {
    const root = rootOf.get(slug);
    if (root === undefined) return null;
    const { record } = foldGroup(root, groups.get(root)!, false);
    if (record.name === null) return null;
    names.set(`person:${root}`, shownName(record, record.name));
  }
  return names;
}

function shownName(record: PersonRecord | null, called: string): string {
  return record?.show === "full_name" && record.full_name !== null ? record.full_name : called;
}

interface Folded {
  record: PersonRecord;
  stated: PersonRecord;
  slugs: string[];
}

function foldGroup(root: string, group: readonly RecordState[], you: boolean): Folded {
  const ordered = [...group].sort((left, right) => Number(right.record.slug === root) - Number(left.record.slug === root)
    || (left.merged_since ?? 0) - (right.merged_since ?? 0) || compare(left.record.slug, right.record.slug));
  const first = ordered[0]!.record;
  const fill = <K extends "name" | "full_name" | "entity" | "relationship">(key: K): PersonRecord[K] =>
    ordered.map((state) => state.record[key]).find((value) => value !== null) ?? null;
  const union = (lists: Handle[][]): Handle[] => [...new Map(lists.flat().map((handle) => [handleId(handle), handle])).values()].sort(compareHandles);
  const excluded = union(ordered.map((state) => state.record.excluded));
  const out = new Set(excluded.map(handleId));
  const record: PersonRecord = {
    ...first, name: fill("name"), full_name: fill("full_name"), entity: you ? "person" : fill("entity"), relationship: you ? null : fill("relationship"),
    hidden: you ? false : first.hidden, me: you,
    handles: union(ordered.map((state) => heldHandles(state.record))).filter((handle) => !out.has(handleId(handle))),
    excluded, dismissed: [...new Set(ordered.flatMap((state) => state.record.dismissed))].sort(),
    also_called: [...new Set(ordered.flatMap((state) => state.record.also_called))], merged_into: null,
  };
  return { record, stated: first, slugs: ordered.map((state) => state.record.slug).sort(compare) };
}

function callName(record: PersonRecord | null, cards: readonly Card[], handles: readonly Handle[], labels: readonly ProviderLabel[]): { name: string; by: PersonLabel["by"] } {
  if (record?.name != null) return { name: record.name, by: "registry" };
  const card = cards.find((each) => each.name !== null);
  if (card !== undefined) return { name: card.name!, by: "contact" };
  const partner = labels.find((label) => label.name !== undefined && isName(label.name))?.name;
  if (partner !== undefined) return { name: partner, by: "provider" };
  const pushed = labels.find((label) => label.pushName !== undefined && isName(label.pushName))?.pushName;
  if (pushed !== undefined) return { name: pushed, by: "push-name" };
  const lowest = handles[0];
  if (lowest !== undefined) return { name: lowest.kind === "jid" ? unknownName(lowest.value) : lowest.value, by: "none" };
  return { name: record?.full_name ?? "", by: "none" };
}

function networksSpelling(networks: Networks | undefined, handle: Handle): { product: string; id: string }[] {
  return (networks?.products ?? []).flatMap((product) => {
    const id = labelIdOf(networks!, product, handle);
    return id === null ? [] : [{ product, id }];
  });
}

function providerLabelsBy(handles: readonly Handle[], providers: ReadonlyMap<string, ProviderLabel>, networks: Networks | undefined): { product: string; label: ProviderLabel }[] {
  return handles.flatMap((handle) => networksSpelling(networks, handle).flatMap(({ product, id }) => {
    const label = providers.get(providerUnit(networks!, product, id));
    return label === undefined ? [] : [{ product, label }];
  }));
}

function providerLabels(handles: readonly Handle[], providers: ReadonlyMap<string, ProviderLabel>, networks: Networks | undefined): ProviderLabel[] {
  return providerLabelsBy(handles, providers, networks).map((each) => each.label);
}


export type Days = ReadonlyMap<string, number>;

export interface Counts {
  theirs: Days;
  groups: Days;
  mine: Days;
  replies: number;
  quick: number;
  mail_from: Days;
  mail_to: Days;
  photos: Days;
}

export function score(counts: Counts, newest: string): number {
  if (newest === "") return 0;
  const end = Date.parse(`${newest}T00:00:00Z`);
  let total = 0;
  const add = (days: Days, weight: number) => {
    for (const [day, count] of days) total += weight * count * 0.5 ** ((end - Date.parse(`${day}T00:00:00Z`)) / 86_400_000 / HALF_LIFE_DAYS);
  };
  add(counts.theirs, WEIGHTS.theirs);
  add(counts.groups, WEIGHTS.theirs);
  add(counts.mine, WEIGHTS.mine);
  add(counts.mail_from, WEIGHTS.mail);
  add(counts.mail_to, WEIGHTS.mail);
  add(counts.photos, WEIGHTS.photo);
  return Math.round(total * 100) / 100;
}

export interface Seen {
  counts: Counts;
  mail_names: readonly string[];
  call_names?: readonly string[];
  service: boolean;
  sender: "no-reply" | "relay" | null;
  senders: readonly string[];
  photo_labels: readonly string[];
  wished: readonly string[];
}

export interface Suggestion {
  id: string;
  kind: "handle" | "full_name" | "same" | "entity" | "work" | "birthday" | "profile";
  value: string;
  reasons: Record<string, number>;
  ticked: boolean;
}

export function suggestionId(kind: Suggestion["kind"] | "called", value: string): string {
  return sha256(`${kind}\0${value}`).slice("sha256:".length, "sha256:".length + 16);
}

export function calledId(name: string): string {
  return suggestionId("called", foldName(name));
}

export interface Organised {
  listed: readonly Person[];
  you: Person | null;
  others: number;
  queue: readonly string[];
  organised: number;
  often: number;
  score(person: Person): number;
  entity(person: Person): Entity;
  suggestions(person: Person): readonly Suggestion[];
  namesSeen(person: Person): readonly string[];
}

export function organise(
  people: People, seen: (person: Person) => Seen | undefined, newest: string, details: (person: Person) => Details | undefined, senders: Iterable<string>,
): Organised {
  const scores = new Map<Person, number>();
  const scoreOf = (person: Person) => {
    let found = scores.get(person);
    if (found === undefined) scores.set(person, found = (() => {
      const counts = seen(person)?.counts;
      return counts === undefined ? 0 : score(counts, newest);
    })());
    return found;
  };
  const you = people.all.find((person) => person.me) ?? null;
  const candidate = (person: Person) => {
    const said = seen(person);
    return said !== undefined && !said.service && (sum(said.counts.mine) >= CANDIDATE_MESSAGES || sum(said.counts.mail_to) >= CANDIDATE_MAILS);
  };
  const listed = people.all.filter((person) => !person.me && !person.hidden && (person.record !== null || person.cards.length > 0 || candidate(person)))
    .sort((left, right) => scoreOf(right) - scoreOf(left) || compare(left.id, right.id));
  const isListed = new Set(listed);
  const queue = listed.filter((person) => person.record === null && person.handles.length > 0).map((person) => person.id);
  const offered = you === null ? listed : [...listed, you];
  const labelsOf = (person: Person) => providerLabels(person.handles, people.providers, people.networks);
  const entities = new Map<Person, Entity>();
  const entityOf = (person: Person): Entity => {
    let found = entities.get(person);
    if (found === undefined) entities.set(person, found = person.entity ?? judged(person, seen(person), businessLevels(person, people, seen(person))));
    return found;
  };
  let known: KnownBusinesses | undefined;
  const signsOf = (person: Person) => businessSigns(person, people, seen(person), known ??= businessNames(senders, people.providers.values()));
  let suggestions: Map<Person, Suggestion[]> | undefined;
  return {
    listed, you, queue,
    others: people.all.filter((person) => !person.me && !isListed.has(person) && seen(person) !== undefined).length,
    organised: people.all.filter((person) => !person.me && person.record !== null).length,
    often: listed.filter((person) => person.record === null && scoreOf(person) > OFTEN).length,
    score: scoreOf,
    entity: entityOf,
    suggestions: (person) => isListed.has(person) || person === you ? (suggestions ??= suggest(people, offered, seen, details, scoreOf, entityOf, signsOf)).get(person) ?? [] : [],
    namesSeen: (person) => namesSeen(person, providerLabels(person.handles, people.providers, people.networks), seen(person)),
  };
}

function suggest(
  people: People, offered: readonly Person[], seen: (person: Person) => Seen | undefined, theirDetails: (person: Person) => Details | undefined,
  scoreOf: (person: Person) => number, entityOf: (person: Person) => Entity, signsOf: (person: Person) => Record<string, number> | null,
): Map<Person, Suggestion[]> {
  const out = new Map<Person, Suggestion[]>();
  const namers = (people.networks?.products ?? []).filter((product) => people.networks!.of(product)?.labelId !== undefined);
  const tickedAmong = (kind: Suggestion["kind"], value: string) => kind === "handle" || kind === "profile" ? `${kind}\0${value.slice(0, value.indexOf(":"))}` : kind;
  const offer = (person: Person, kind: Suggestion["kind"], value: string, reasons: Record<string, number>, id = suggestionId(kind, value), other?: Person) => {
    const ids = other === undefined ? [id] : [id, anchorsId(person, other)];
    const declined = (whose: Person | undefined) => whose?.record?.dismissed.some((each) => ids.includes(each)) === true;
    if (declined(person) || declined(other)) return;
    const theirs = out.get(person) ?? [];
    const guess = (kind === "birthday" && Object.keys(reasons).every((reason) => reason === "wished")) || (kind === "entity" && value === "business");
    const ticked = kind !== "same" && !guess && !theirs.some((each) => tickedAmong(each.kind, each.value) === tickedAmong(kind, value));
    out.set(person, [...theirs, { id, kind, value, reasons, ticked }]);
  };
  const others = (person: Person) => person.slug ?? (person.handles[0] === undefined ? person.id : handleId(person.handles[0]));
  const byPerson = new Map<string, Person>();
  for (const person of offered) byPerson.set(person.id, person);

  interface Address { address: string; signed: string[][]; local: string; from: number; to: number }
  const byKey = new Map<string, Address[]>();
  for (const person of people.all) {
    const said = seen(person);
    if (person.record !== null || person.cards.length > 0 || person.me || said === undefined || said.service) continue;
    for (const handle of person.handles) {
      if (handle.kind !== "email") continue;
      const address: Address = {
        address: handle.value, signed: said.mail_names.map(words), local: letters(localPart(handle.value)),
        from: sum(said.counts.mail_from), to: sum(said.counts.mail_to),
      };
      for (const word of new Set(address.signed.flat())) push(byKey, `word\0${word}`, address);
      push(byKey, `local\0${address.local}`, address);
    }
  }
  const sameName = new Map<string, Person[]>();
  const seenName = new Map<string, Person[]>();
  const seenAs = new Map<Person, string[]>();
  for (const person of offered) {
    for (const key of sameNames(person)) push(sameName, key, person);
    seenAs.set(person, [...new Set(namesSeen(person, providerLabels(person.handles, people.providers, people.networks), seen(person)).flatMap((name) => nameKey(name) ?? []))]);
    for (const key of seenAs.get(person)!) push(seenName, key, person);
  }
  const handleless = (person: Person) => person.record !== null && person.handles.length === 0;

  for (const person of offered) {
    const excluded = new Set(person.record?.excluded.map(handleId) ?? []);
    const theirs = new Set(person.handles.map(handleId));
    const names = [person.by === "none" ? null : person.call_name, person.full_name]
      .flatMap((name) => name !== null && nameKey(name) !== null ? [words(name)] : []);
    const candidates = new Set(names.flatMap(([first, ...rest]) => [
      ...(byKey.get(`word\0${first}`) ?? []).filter((each) => each.signed.some((signed) => signed.includes(first!) && rest.some((word) => signed.includes(word)))),
      ...[[first, ...rest].join(""), [first, ...rest].reverse().join(""), ...rest.flatMap((word) => [`${first}${word}`, `${word}${first}`])]
        .flatMap((spelled) => byKey.get(`local\0${spelled}`) ?? []),
    ]));
    const matching = [...candidates].filter((each) => !theirs.has(`email:${each.address}`) && !excluded.has(`email:${each.address}`))
      .sort((left, right) => right.from + right.to - (left.from + left.to) || compare(left.address, right.address)).slice(0, MOST_OF_A_KIND);
    for (const each of matching) offer(person, "handle", `email:${each.address}`, { mails_from: each.from, mails_to: each.to });

    const where = [...namers, "mail", "photos"];
    const said = new Map<string, { name: string; counts: Record<string, number> }>();
    const say = (name: string, by: string) => {
      const clean = name.replace(/\s+/gu, " ").trim();
      if (nameKey(clean) === null || [person.call_name, person.full_name].some((other) => other !== null && foldName(other) === foldName(clean))) return;
      const entry = said.get(foldName(clean)) ?? { name: clean, counts: Object.fromEntries(where.map((each) => [each, 0])) };
      entry.counts[by] = (entry.counts[by] ?? 0) + 1;
      said.set(foldName(clean), entry);
    };
    for (const { product, label } of providerLabelsBy(person.handles, people.providers, people.networks)) for (const name of [label.name, label.pushName]) if (name !== undefined) say(name, product);
    for (const name of seen(person)?.mail_names ?? []) say(name, "mail");
    for (const name of seen(person)?.photo_labels ?? []) say(name, "photos");
    for (const entry of [...said.values()].sort((left, right) => total(right.counts) - total(left.counts) || compare(left.name, right.name)).slice(0, MOST_OF_A_KIND)) {
      offer(person, "full_name", entry.name, entry.counts);
    }

    const linked = new Set(people.apart.get(person.id) ?? []);
    const named = new Set(sameNames(person).flatMap((key) => sameName.get(key) ?? []));
    const seenBy = new Set([
      ...handleless(person) ? sameNames(person).flatMap((key) => seenName.get(key) ?? []) : [],
      ...seenAs.get(person)!.flatMap((key) => sameName.get(key) ?? []).filter(handleless),
    ]);
    const same = new Set([...[...linked].flatMap((id) => byPerson.get(id) ?? []), ...named, ...seenBy]);
    same.delete(person);
    for (const other of [...same].sort((left, right) => scoreOf(right) - scoreOf(left) || compare(left.id, right.id))) {
      if (other.me) continue;
      offer(person, "same", others(other), { linked: Number(linked.has(other.id)), named: Number(named.has(other)), seen: Number(seenBy.has(other)) }, sameIdOf(person.id, other.id), other);
    }

    const counts = seen(person)?.counts;
    const entity = entityOf(person);
    if (counts !== undefined && entity !== "ai" && !person.me) {
      const mine = sum(counts.mine);
      if (counts.replies >= AI_REPLIES && counts.quick / counts.replies >= AI_QUICK_SHARE && mine > 0 && sum(counts.theirs) / mine >= AI_RATIO) {
        offer(person, "entity", "ai", { replies: counts.replies, quick: counts.quick, theirs: sum(counts.theirs), mine });
      }
    }
    const signs = entity === "business" || person.entity !== null || person.me ? null : signsOf(person);
    if (signs !== null) offer(person, "entity", "business", signs);

    const details = theirDetails(person);
    for (const [work, cards] of tally(person.cards.flatMap((card) => card.work ?? []), 1)) {
      if (details?.work == null || foldName(details.work) !== foldName(work)) offer(person, "work", work, { cards });
    }
    const wishes = wishedDay(seen(person)?.wished ?? []);
    const known = (value: string) => details?.birthday != null && birthdayValue({ ...details.birthday, year: value.length === 5 ? null : details.birthday.year }) === value;
    const days = tally(person.cards.flatMap((card) => card.birthday === null ? [] : [birthdayValue(card.birthday)]), 1);
    for (const [day, cards] of days) {
      if (!known(day)) offer(person, "birthday", day, { cards, ...(wishes?.day === day.slice(-5) ? { wished: wishes.years } : {}) });
    }
    if (wishes !== null && ![...days.keys()].some((day) => day.slice(-5) === wishes.day) && !known(wishes.day)) offer(person, "birthday", wishes.day, { wished: wishes.years });
    const stated = new Set((details?.profiles ?? []).map((profile) => `${profile.network}:${profile.value}`));
    const profiles = [...tally(person.cards.flatMap((card) => card.profiles.map((each) => `${each.network}:${each.value}`)), MOST_PROFILES)];
    for (const [profile, cards] of profiles.filter(([profile]) => !stated.has(profile)).slice(0, MOST_PROFILES - stated.size)) offer(person, "profile", profile, { cards });
  }

  return out;
}

function tally(values: readonly string[], most = MOST_OF_A_KIND): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return new Map([...counts].sort(([leftValue, left], [rightValue, right]) => right - left || compare(leftValue, rightValue)).slice(0, most));
}

export function birthdayValue({ month, day, year }: Birthday): string {
  const monthDay = `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return year === null ? monthDay : `${String(year).padStart(4, "0")}-${monthDay}`;
}

export function wishedDay(wished: readonly string[]): { day: string; years: number } | null {
  const days = new Map<string, { years: Set<string>; on: Set<string> }>();
  const count = (civil: string, onTime: boolean) => {
    const day = civil.slice(5);
    const held = days.get(day) ?? { years: new Set<string>(), on: new Set<string>() };
    held.years.add(civil.slice(0, 4));
    if (onTime) held.on.add(civil.slice(0, 4));
    days.set(day, held);
  };
  for (const civil of new Set(wished)) {
    count(civil, true);
    count(addDays(civil, -1), false);
  }
  const ranked = [...days].sort(([, left], [, right]) => right.years.size - left.years.size || right.on.size - left.on.size);
  const [best, next] = ranked;
  if (best === undefined || best[1].years.size < WISHED_YEARS) return null;
  if (next !== undefined && next[1].years.size === best[1].years.size && next[1].on.size === best[1].on.size) return null;
  return { day: best[0], years: best[1].years.size };
}

function sameNames(person: Person): string[] {
  const typed = person.record?.name ?? null;
  const keys = [person.full_name, typed, person.cards[0]?.name ?? null].flatMap((name) => name === null ? [] : nameKey(name) ?? []);
  if (typed !== null && words(typed).length < NAME_WORDS) keys.push(`typed\0${foldName(typed)}`);
  return [...new Set(keys)];
}

function nameKey(name: string): string | null {
  const said = words(name);
  return isName(name) && said.length >= NAME_WORDS ? `name\0${said.join(" ")}` : null;
}

export function noReply(address: string): boolean {
  return NO_REPLY.test(localPart(address).toLowerCase());
}

export type Service = "no-reply" | "relay" | "list";

export function serviceOf(address: string, namesFrom: Iterable<string>, mail: { from: number; to: number; machine: number }): Service | null {
  if (noReply(address)) return "no-reply";
  const firsts = new Set<string>();
  for (const name of namesFrom) {
    const first = firstWord(name);
    if (first !== null) firsts.add(first);
    if (firsts.size >= SERVICE_FIRSTS) return "relay";
  }
  return mail.machine > 0 && mail.from === 0 && mail.to === 0 ? "list" : null;
}

export function judged(person: Pick<Person, "me">, seen: Seen | undefined, levels: readonly number[]): Entity {
  if (person.me) return "person";
  if (levels.length > 0 && levels.every((level) => level >= BUSINESS_LEVEL)) return "business";
  if (seen?.sender === "no-reply") return "bot";
  return "person";
}

export function businessLevels(person: Person, people: Pick<People, "providers" | "networks">, seen: Seen | undefined): number[] {
  return person.handles.flatMap((handle) => handle.kind === "email"
    ? seen?.senders.includes(handle.value) === true ? [] : [0]
    : [Math.max(0, ...providerLabels([handle], people.providers, people.networks).map((label) => label.business ?? 0))]);
}

export interface KnownBusinesses {
  names: ReadonlySet<string>;
  domains: ReadonlyMap<string, string>;
}

export function businessNames(senders: Iterable<string>, providers: Iterable<ProviderLabel>): KnownBusinesses {
  const names = new Set<string>();
  const domains = new Map<string, string>();
  const known = (name: string) => name.length >= BUSINESS_NAME_LETTERS && !plainWord(name);
  for (const address of senders) {
    const domain = domainOf(address);
    if (domain === null || !known(domain.name)) continue;
    names.add(domain.name);
    domains.set(domain.written, domain.name);
  }
  for (const label of providers) {
    if ((label.business ?? 0) < BUSINESS_LEVEL || label.businessName === undefined) continue;
    const name = businessWords(label.businessName, new Map()).join("");
    if (known(name)) names.add(name);
  }
  return { names, domains };
}

export function namedBusiness(person: Person, labels: readonly ProviderLabel[], seen: Seen | undefined, known: KnownBusinesses): boolean {
  if (known.names.size === 0) return false;
  const names: [name: string, counts: boolean][] = [
    ...person.cards.flatMap((card) => card.names.map((name): [string, boolean] => [name, true])),
    ...labels.flatMap((label): [string, boolean][] => [
      ...(label.name === undefined ? [] : [[label.name, true] as [string, boolean]]),
      ...(label.pushName === undefined ? [] : [[label.pushName, label.business !== undefined] as [string, boolean]]),
    ]),
    ...[...(seen?.mail_names ?? []), ...(seen?.photo_labels ?? [])].map((name): [string, boolean] => [name, true]),
  ].filter(([name]) => !name.includes("@"));
  const said = names.map(([name]) => businessWords(name, known.domains));
  const runs = said.map((words) => knownRun(words, known.names));
  if (!runs.some((run, at) => run !== null && names[at]![1])) return false;
  for (const [at, words] of said.entries()) {
    const run = runs[at]!;
    const beside = run === null ? words : [...words.slice(0, run[0]), ...words.slice(run[1])];
    if (!beside.every(plainWord)) return false;
  }
  return true;
}

function knownRun(said: readonly string[], known: ReadonlySet<string>): [number, number] | null {
  for (let start = 0; start < said.length; start++) {
    let run = "";
    for (let end = start + 1; end <= said.length; end++) {
      run += said[end - 1];
      if (known.has(run) && (end - start === 1 || said.slice(start, end).some(plainWord))) return [start, end];
    }
  }
  return null;
}

function businessWords(name: string, domains: ReadonlyMap<string, string>): string[] {
  const named = name.replace(/['’]/gu, "").replace(/[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu, (dotted) => domains.get(dotted.toLowerCase()) ?? dotted);
  return words(named);
}

function plainWord(word: string): boolean {
  return /^\p{N}+$/u.test(word) || isPlainWord(word) || (word.endsWith("s") && isPlainWord(word.slice(0, -1)));
}

function domainOf(address: string): { written: string; name: string } | null {
  const labels = address.slice(address.lastIndexOf("@") + 1).toLowerCase().split(".").filter((label) => label !== "");
  if (labels.length < 2) return null;
  const at = labels.length >= 3 && labels.at(-1)!.length === 2 && SECOND_LEVELS.has(labels.at(-2)!) ? labels.length - 3 : labels.length - 2;
  return { written: labels.slice(at).join("."), name: labels[at]!.replaceAll("-", "") };
}

function businessSigns(person: Person, people: Pick<People, "providers" | "networks">, seen: Seen | undefined, known: KnownBusinesses): Record<string, number> | null {
  const labels = providerLabels(person.handles, people.providers, people.networks);
  const cards = person.cards.filter((card) => card.business).length;
  const level = Math.max(0, ...labels.map((label) => label.business ?? 0));
  const signs = {
    ...(cards > 0 ? { cards } : {}), ...(level > 0 ? { whatsapp: level } : {}), ...(seen?.sender === "relay" ? { relay: 1 } : {}),
    ...(namedBusiness(person, labels, seen, known) ? { named: 1 } : {}),
  };
  return Object.keys(signs).length === 0 ? null : signs;
}

function firstWord(name: string): string | null {
  const comma = name.indexOf(",");
  const turned = comma < 0 ? name : `${name.slice(comma + 1)} ${name.slice(0, comma)}`;
  const [first] = words(turned);
  return first !== undefined && !TITLES.has(first) && (first.match(/\p{L}/gu)?.length ?? 0) >= 2 ? first : null;
}

function localPart(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? address : address.slice(0, at);
}

export function sameIdOf(left: string, right: string): string {
  return suggestionId("same", [left, right].sort(compare).join("\0"));
}

function anchorsId(left: Person, right: Person): string {
  return suggestionId("same", [anchorOf(left), anchorOf(right)].sort(compare).join("\0"));
}

function anchorOf(person: Person): string {
  if (person.record === null) return person.id;
  return person.record.anchor === null ? `person:${person.record.slug}` : handleId(person.record.anchor);
}

function namesSeen(person: Person, labels: readonly ProviderLabel[], seen: Seen | undefined): string[] {
  const out = new Map<string, string>();
  const add = (name: string | undefined) => {
    const clean = name?.replace(/\s+/gu, " ").trim();
    if (clean !== undefined && clean !== "" && !out.has(foldName(clean))) out.set(foldName(clean), clean);
  };
  for (const card of person.cards) for (const name of card.names) if (name === card.name || !card.nicknames.includes(name)) add(name);
  for (const { name } of alsoCalled(person)) add(name);
  for (const label of labels) {
    add(label.name);
    add(label.pushName);
  }
  for (const name of seen?.mail_names ?? []) add(name);
  for (const name of seen?.call_names ?? []) add(name);
  for (const name of seen?.photo_labels ?? []) add(name);
  return [...out.values()];
}


export interface AlsoCalled {
  readonly name: string;
  readonly from: "card" | "you";
}

export function alsoCalled(person: Pick<Person, "call_name" | "name" | "full_name" | "record" | "stated" | "cards">): AlsoCalled[] {
  const root = new Set(person.stated?.also_called ?? []);
  const declined = new Set(person.record?.dismissed ?? []);
  const named = new Set([person.call_name, person.name, person.full_name].flatMap((name) => name === null ? [] : [foldName(name)]));
  const out = new Map<string, AlsoCalled>();
  const add = (text: string, from: AlsoCalled["from"]) => {
    const name = calledName(text);
    if (name === null || named.has(foldName(name)) || out.has(foldName(name))) return;
    if (!(from === "you" && root.has(name)) && declined.has(calledId(name))) return;
    out.set(foldName(name), { name, from });
  };
  for (const name of person.record?.also_called ?? []) add(name, "you");
  for (const card of person.cards) for (const name of card.nicknames) add(name, "card");
  return [...out.values()].slice(0, MOST_CALLED);
}

export interface DetailsGroup {
  readonly root: string;
  readonly records: readonly PersonRecord[];
}

export function whoseDetails(group: DetailsGroup, key: string): string | null {
  const ordered = [...group.records].sort((left, right) => Number(right.slug === group.root) - Number(left.slug === group.root));
  if (key.startsWith("person:")) return ordered.find((record) => `person:${record.slug}` === key)?.slug ?? null;
  return ordered.find((record) => heldHandles(record).some((handle) => handleId(handle) === key))?.slug ?? null;
}

export function detailsOf(group: DetailsGroup, statements: readonly DetailsStatement[]): Details | undefined {
  const newest = (list: readonly DetailsStatement[]) => list.reduce<DetailsStatement | undefined>((best, each) =>
    best === undefined || each.stated_ms > best.stated_ms || (each.stated_ms === best.stated_ms && each.key < best.key) ? each : best, undefined);
  const shown = ({ work, birthday, profiles }: Details): Details => ({ work, birthday, profiles });
  if (group.records.length <= 1) {
    const whole = newest(statements);
    return whole === undefined ? undefined : shown(whole.details);
  }
  if (statements.length === 0) return undefined;
  const own = new Map<string, DetailsStatement[]>();
  const none: DetailsStatement[] = [];
  for (const statement of statements) {
    const slug = whoseDetails(group, statement.key);
    if (slug === null) none.push(statement);
    else own.set(slug, [...own.get(slug) ?? [], statement]);
  }
  const root = newest(own.get(group.root) ?? []);
  const others = [...[...own].flatMap(([slug, list]) => slug === group.root ? [] : newest(list) ?? []), ...none];
  const says = (details: Details, field: DetailField) => field === "profiles" ? details.profiles.length > 0 : details[field] !== null;
  const field = <F extends DetailField>(name: F): Details[F] => {
    if (root !== undefined && (says(root.details, name) || root.details.cleared?.includes(name) === true)) return root.details[name];
    return newest(others.filter((each) => says(each.details, name)))?.details[name] ?? (name === "profiles" ? [] : null) as Details[F];
  };
  return { work: field("work"), birthday: field("birthday"), profiles: field("profiles") };
}

function words(text: string): string[] {
  return foldName(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function letters(local: string): string {
  return foldName(local).replace(/[^\p{L}\p{N}]/gu, "");
}

function total(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function sum(days: Days): number {
  let total = 0;
  for (const count of days.values()) total += count;
  return total;
}

function pair(left: string, right: string): string {
  return left < right ? `${left}\0${right}` : `${right}\0${left}`;
}

class UnionFind {
  readonly #parent = new Map<string, string>();

  add(id: string): void {
    if (!this.#parent.has(id)) this.#parent.set(id, id);
  }

  #find(id: string): string {
    let root = id;
    while (this.#parent.get(root) !== root) root = this.#parent.get(root)!;
    for (let current = id; current !== root;) {
      const next = this.#parent.get(current)!;
      this.#parent.set(current, root);
      current = next;
    }
    return root;
  }

  join(left: string, right: string): void {
    const [a, b] = [this.#find(left), this.#find(right)];
    if (a === b) return;
    if (a < b) this.#parent.set(b, a);
    else this.#parent.set(a, b);
  }

  groups(): string[][] {
    const out = new Map<string, string[]>();
    for (const id of this.#parent.keys()) {
      const root = this.#find(id);
      const group = out.get(root);
      if (group === undefined) out.set(root, [id]);
      else group.push(id);
    }
    return [...out.values()];
  }
}

function pushNew(list: string[], value: string | null): void {
  if (value !== null && !list.includes(value)) list.push(value);
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
