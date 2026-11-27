import { addDays, civilDay, foldName, handleId, handleOf, isObject, isPhoneShaped, parseFaceKey, type DaySettings, type Entity, type ExtractRow, type Handle, type Json, type MessageParty, type PartyKind, type PersonRecord } from "@lifestreamprotocol/core";
import type { Call } from "../calls/family.js";
import type { Family, Labels, PersonLabel, ProviderLabel } from "../family.js";
import type { MailDayContent } from "../mail/family.js";
import { handleOfId, resolvedChat } from "../shared/labels.js";
import {
  alsoCalled, birthdayValue, detailsOf, noReply, OFTEN, organise, serviceOf, QUICK_MS, resolve, statedPerson, whoseDetails, type Card, type Counts, type Details, type DetailsGroup, type Member, type Organised,
  type OwnHandle, type People, type Person, type RecordState, type Seen, type LinkedBy, type Service, type Suggestion,
} from "../shared/people.js";
import { shownChatDay, type ChatDay } from "./family.js";
import { chatMembers, isGroupChat, partyHandle, providerUnit, resolveChat, type Networks } from "./networks.js";
import { spans, quiet, why, type GroupRule, type Span, type Why } from "./groups.js";

export const PEOPLE_CODE = "9";

export const WISHES: readonly string[] = ["happy birthday", "happy bday", "happy b'day", "hbd", "many happy returns", "happiest birthday", "janamdin mubarak", "janmdin mubarak"];
const WISH_WORDS = WISHES.map((phrase) => phrase.split(" "));

export interface ChatDayPart {
  readonly network: string;
  readonly chat: string;
  readonly other: MessageParty | null;
  readonly total: number;
  readonly mine: number;
  readonly mine_days: Readonly<Record<string, number>>;
  readonly wished: readonly string[];
  readonly first_ms: number;
  readonly last_ms: number;
  readonly senders: readonly SenderPart[];
}

export interface SenderPart {
  readonly id: string;
  readonly kind: PartyKind;
  readonly count: number;
  readonly first_ms: number;
  readonly last_ms: number;
  readonly days: Readonly<Record<string, number>>;
  readonly times: Readonly<Record<string, readonly [number, number]>>;
  readonly replies: number;
  readonly quick: number;
}

export interface MailDayPart {
  readonly addresses: readonly MailAddressPart[];
}

export interface MailAddressPart {
  readonly address: string;
  readonly from: Readonly<Record<string, number>>;
  readonly to: Readonly<Record<string, number>>;
  readonly machine: number;
  readonly names: { readonly from: readonly string[]; readonly to: readonly string[] };
  readonly first_ms: number;
  readonly last_ms: number;
}

export interface CallPeoplePart {
  readonly at_ms: number;
  readonly parties: readonly { readonly handle: Handle; readonly name: string | null }[];
}

export interface NamedFace {
  readonly face: string;
  readonly at_ms: number | null;
  readonly camera: boolean;
  readonly crop: string | null;
  readonly tier: string | null;
  readonly size: number;
}

export interface FacesSaid {
  readonly named: ReadonlyMap<string, { readonly photos: readonly NamedFace[]; readonly labels: readonly string[] }>;
}

export interface PeopleInput {
  readonly networks: Networks;
  readonly chats: Iterable<ChatDayPart>;
  readonly mail: Iterable<MailDayPart>;
  readonly calls?: Iterable<CallPeoplePart>;
  readonly labels: Labels;
  readonly cards: readonly Card[];
  readonly records: readonly RecordState[];
  readonly providers: ReadonlyMap<string, ProviderLabel>;
  readonly country: string | null;
  readonly own: readonly OwnHandle[];
  readonly names?: (product: string) => string | undefined;
  readonly faces: FacesSaid | null;
  readonly photos: readonly StatedPhoto[];
  readonly details: readonly StatedDetails[];
  readonly groups: GroupsInput;
  readonly day: DaySettings;
}

export type Talk = "joined" | "all" | "none";

export interface GroupSettings extends GroupRule {
  readonly talk: Talk;
}

export const NO_GROUP_SETTINGS: GroupSettings = { archived: false, after_days: null, talk: "joined" };

export interface GroupsInput {
  readonly words: ReadonlyMap<string, boolean>;
  readonly rules: Readonly<Record<string, GroupSettings>>;
}

export interface GroupRow {
  readonly yours: readonly Span[];
  readonly first_day: string;
  readonly last_day: string;
}

interface Stated {
  readonly key: string;
  readonly stated_ms: number;
}

export interface StatedPhoto extends Stated {
  readonly image: string;
}

export interface StatedDetails extends Stated {
  readonly details: Details;
}

export type PersonPhoto = { crop: string } | { card: string } | null;

export interface PersonEntry {
  readonly id: string;
  readonly name: string;
  readonly call_name: string;
  readonly full_name: string | null;
  readonly show: "name" | "full_name";
  readonly by: PersonLabel["by"];
  readonly person: string | null;
  readonly entity: string;
  readonly entity_by: "you" | "home";
  readonly relationship: string | null;
  readonly me: boolean;
  readonly hidden: boolean;
  readonly organised: boolean;
  readonly card: boolean;
  readonly photo: PersonPhoto;
  readonly score: number;
  readonly handles: readonly { id: string; kind: string; network: string | null; words: string; from: string | null; own: boolean }[];
  readonly networks: readonly string[];
  readonly chats: readonly { readonly key: string; readonly count: number }[];
  readonly received: number;
  readonly sent: number;
  readonly mails_from: number;
  readonly mails_to: number;
  readonly first_ms: number | null;
  readonly last_ms: number | null;
  readonly last_30: number;
  readonly days_count: number;
  readonly last_day: number;
  readonly work?: string;
}

export interface CalledEntry {
  readonly name: string;
  readonly from: "Contacts" | "You added";
}

export interface JoinedEntry {
  readonly id: string;
  readonly name: string;
  readonly photo: PersonPhoto;
  readonly handles: readonly string[];
  readonly with: readonly string[];
}

export interface PersonDetail extends PersonEntry {
  readonly days: Readonly<Record<string, number>>;
  readonly suggestions: readonly Suggestion[];
  readonly names_seen: readonly string[];
  readonly also_called: readonly CalledEntry[];
  readonly joined: readonly JoinedEntry[];
  readonly record: (Omit<PersonRecord, "handles"> & { type: "people.person"; handles: readonly Handle[] }) | null;
  readonly details?: Details;
}

export interface ChatEntry {
  readonly key: string;
  readonly network: string;
  readonly chat: string;
  readonly group: boolean;
  readonly label: string;
  readonly total: number;
  readonly mine: number;
  readonly first_ms: number;
  readonly last_ms: number;
  readonly quiet?: { readonly why: Why; readonly last_day: string | null } | null;
  readonly word?: boolean | null;
}

export interface ServedPhoto { image: string; face: string; box: readonly number[]; at_ms: number | null; crop: string | null; camera: boolean }

export interface YouEntry extends PersonEntry {
  readonly also_called: readonly CalledEntry[];
  readonly suggested: number;
}

export interface PeopleList {
  readonly you: YouEntry | null;
  readonly people: readonly PersonEntry[];
  readonly chats: readonly ChatEntry[];
  readonly organise: {
    readonly queue: readonly string[]; readonly organised: number; readonly often: number;
    readonly businesses: readonly { readonly id: string; readonly reasons: Readonly<Record<string, number>> }[];
  };
  readonly others: number;
}

export interface Searched {
  readonly id: string;
  readonly words: readonly string[];
  readonly values: readonly string[];
  readonly phones: readonly string[];
}

export interface PeopleAnswer {
  readonly list: PeopleList;
  readonly persons: readonly PersonDetail[];
  readonly alias: ReadonlyMap<string, string>;
  readonly searched: readonly Searched[];
  readonly photos: ReadonlyMap<string, readonly ServedPhoto[]>;
  readonly groups: ReadonlyMap<string, GroupRow>;
  readonly quiet: Readonly<Record<string, number>>;
  readonly who: Who;
}

export interface FacePicks {
  readonly seed?: readonly [size: number, face: string, crop: string];
  readonly newest?: readonly [at_ms: number | null, face: string, crop: string];
}

export interface Who {
  readonly cards: readonly Card[];
  readonly providers: readonly (readonly [string, ProviderLabel])[];
  readonly seen: readonly Handle[];
  readonly faces: Readonly<Record<string, FacePicks>>;
}

type Counting = { readonly counting?: true };
export type JoinedPerson = PersonDetail & Counting;
export type JoinedList = Omit<PeopleList, "you" | "people"> & { readonly you: (YouEntry & Counting) | null; readonly people: readonly (PersonEntry & Counting)[] };

export interface PeopleRun {
  readonly who: Who;
  list(): PeopleList;
  row(id: string): PersonDetail | undefined;
  alias(id: string): string | undefined;
}

export interface PeopleNow {
  readonly records: readonly RecordState[];
  readonly photos: readonly StatedPhoto[];
  readonly details: readonly StatedDetails[];
  readonly own: readonly OwnHandle[];
  readonly country: string | null;
  readonly networks: Networks;
  readonly names?: (product: string) => string | undefined;
}

export interface PeopleChanged {
  readonly persons: readonly string[];
  readonly keys: readonly string[];
  readonly groups: ReadonlyMap<string, boolean | null>;
}

export interface Rejoined {
  person(id: string): { row: string } | { person: JoinedPerson } | undefined;
  stands(id: string): string | null | undefined;
  list(): JoinedList;
}

type CountedKey = "entity" | "score" | "networks" | "chats" | "received" | "sent" | "mails_from" | "mails_to" | "first_ms" | "last_ms" | "last_30" | "days_count" | "last_day";
type CountedPart = Pick<PersonEntry, CountedKey> & Pick<PersonDetail, "days">;
type OwnPart = Omit<PersonDetail, CountedKey | "days" | "suggestions" | "names_seen"> & { readonly said: Entity | null };

export const FOUND = 50;
const NOT_PEOPLE = new Set(["me", "system", "raw"]);
const WINDOW_DAYS = 30;
const RECENT_PHOTO_DAYS = 730;

export function chatDayPart(content: Json, day: DaySettings, networks: Networks): ChatDayPart {
  return partOf(content as unknown as ChatDay, day, networks);
}

export function shownPart(extracts: readonly ExtractRow[], labels: Labels, day: DaySettings, networks: Networks): ChatDayPart {
  return partOf(shownChatDay(extracts, labels, networks), day, networks);
}

function partOf({ network, chat, messages }: ChatDay, day: DaySettings, networks: Networks): ChatDayPart {
  const group = isGroupChat(networks, network, chat);
  const mine_days: Record<string, number> = {};
  const wished = new Set<string>();
  const senders = new Map<string, { id: string; kind: PartyKind; count: number; first_ms: number; last_ms: number; days: Record<string, number>; times: Record<string, [number, number]>; replies: number; quick: number }>();
  let mine = 0, first_ms = Infinity, last_ms = -Infinity;
  let asked: number | null = null;
  const answered = new Set<string>();
  for (const message of messages) {
    const civil = civilDay(message.at, day);
    first_ms = Math.min(first_ms, message.at);
    last_ms = Math.max(last_ms, message.at);
    const { id, kind } = message.from;
    if (kind === "me") {
      mine++;
      mine_days[civil] = (mine_days[civil] ?? 0) + 1;
      asked = message.at;
      answered.clear();
      if (!group && message.withdrawn !== true && message.text !== undefined && isWish(message.text)) wished.add(civil);
    }
    if (NOT_PEOPLE.has(kind)) continue;
    let sender = senders.get(id);
    if (sender === undefined) senders.set(id, sender = { id, kind, count: 0, first_ms: message.at, last_ms: message.at, days: {}, times: {}, replies: 0, quick: 0 });
    sender.count++;
    sender.first_ms = Math.min(sender.first_ms, message.at);
    sender.last_ms = Math.max(sender.last_ms, message.at);
    sender.days[civil] = (sender.days[civil] ?? 0) + 1;
    const times = sender.times[civil];
    sender.times[civil] = times === undefined ? [message.at, message.at] : [Math.min(times[0], message.at), Math.max(times[1], message.at)];
    if (asked !== null && !answered.has(id)) {
      answered.add(id);
      sender.replies++;
      if (message.at - asked <= QUICK_MS) sender.quick++;
    }
  }
  const members = chatMembers(networks, network, chat);
  const other: MessageParty | null = group ? null : members.length === 1 ? { id: members[0]!.id, kind: members[0]!.kind } : { id: chat, kind: "raw" };
  return { network, chat, other, total: messages.length, mine, mine_days, wished: [...wished].sort(compare), first_ms, last_ms, senders: [...senders.values()] };
}

export function handleWords(handle: Handle, networks: Networks): string {
  if (handle.kind === "jid") return handle.value.endsWith("@lid") ? "Hidden number" : `+${handle.value.slice(0, handle.value.indexOf("@"))}`;
  if (handle.kind !== "network") return handle.value;
  const colon = handle.value.indexOf(":");
  const id = handle.value.slice(colon + 1);
  return networks.of(handle.value.slice(0, colon))?.unknown?.(id) ?? id;
}

export function fromWords(from: LinkedBy, products: readonly string[], name: (product: string) => string | undefined): string | null {
  if (from === null) return null;
  if (from === "card") return "Contacts";
  if (from === "you") return "You added";
  if (from === "home") return products.length === 0 ? null : `Your ${productWords(products, name)}`;
  return name(from) ?? null;
}

export function productWords(products: readonly string[], name: (product: string) => string | undefined): string {
  const names = [...new Set([...products].sort(compare).map((product) => name(product) ?? product))];
  return names.length <= 1 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
}

export function productNames(families: readonly Pick<Family, "adapters">[]): (product: string) => string | undefined {
  const names = new Map<string, string>();
  for (const given of families.flatMap((family) => family.adapters ?? [])) if (!names.has(given.product)) names.set(given.product, given.name);
  return (product) => names.get(product);
}

export function isWish(text: string): boolean {
  const words = text.toLowerCase().replace(/[\u2018\u2019`]/gu, "'").split(/[^\p{L}\p{N}']+/u).map((word) => word.replace(/^'+|'+$/gu, "")).filter(Boolean);
  return WISH_WORDS.some((phrase) => words.some((_word, start) => phrase.every((word, at) => words[start + at] === word)));
}

export function mailDayPart(content: Json, owner: string, day: DaySettings): MailDayPart {
  const mails = isObject(content) && Array.isArray(content.mails) ? (content as unknown as MailDayContent).mails : [];
  const own = owner.toLowerCase();
  const addresses = new Map<string, { address: string; from: Record<string, number>; to: Record<string, number>; machine: number; names: { from: Set<string>; to: Set<string> }; first_ms: number; last_ms: number }>();
  const of = (party: { address: string; name: string | null }, at: number, way: "from" | "to") => {
    let found = addresses.get(party.address);
    if (found === undefined) addresses.set(party.address, found = { address: party.address, from: {}, to: {}, machine: 0, names: { from: new Set(), to: new Set() }, first_ms: at, last_ms: at });
    if (party.name !== null) found.names[way].add(party.name);
    found.first_ms = Math.min(found.first_ms, at);
    found.last_ms = Math.max(found.last_ms, at);
    return found;
  };
  for (const mail of mails) {
    if (mail.route === "junk" || mail.draft || mail.from === null) continue;
    const civil = civilDay(mail.at_ms, day);
    if (mail.from.address === own) {
      if (mail.route !== "read") continue;
      for (const party of mail.to) {
        if (party.address === own || noReply(party.address)) continue;
        const to = of(party, mail.at_ms, "to").to;
        to[civil] = (to[civil] ?? 0) + 1;
      }
      continue;
    }
    const sender = of(mail.from, mail.at_ms, "from");
    if (mail.route === "bulk") sender.machine++;
    else sender.from[civil] = (sender.from[civil] ?? 0) + 1;
  }
  return { addresses: [...addresses.values()].map(({ names, ...address }) => ({ ...address, names: { from: [...names.from].sort(compare), to: [...names.to].sort(compare) } })) };
}

export function callPeoplePart(content: Json): CallPeoplePart | null {
  if (!isObject(content) || typeof content.start_ms !== "number" || !Array.isArray(content.parties)) return null;
  const call = content as unknown as Call;
  const parties: { handle: Handle; name: string | null }[] = [];
  for (const party of call.parties) {
    if (NOT_PEOPLE.has(party.kind)) continue;
    const handle = handleOf(party.id, party.network);
    if (handle === null) continue;
    const raw = party.provider?.trim();
    const name = raw !== undefined && raw.length > 0 && !isPhoneShaped(raw) ? raw : null;
    parties.push({ handle, name });
  }
  return parties.length === 0 ? null : { at_ms: call.start_ms, parties };
}

interface HandleSeen {
  networks: Set<string>;
  chats: Map<string, number>;
  received: number;
  sent: number;
  replies: number;
  quick: number;
  theirs: Map<string, number>;
  groups: Map<string, number>;
  mine: Map<string, number>;
  mail_from: Map<string, number>;
  mail_to: Map<string, number>;
  machine: number;
  names_from: Set<string>;
  names_to: Set<string>;
  call_names: Set<string>;
  service: Service | null;
  days: Map<string, number>;
  wished: Set<string>;
  first_ms: number;
  last_ms: number;
}

interface Folded extends Omit<HandleSeen, "replies" | "quick" | "theirs" | "groups" | "mine" | "mail_from" | "mail_to" | "machine" | "names_from" | "names_to" | "call_names" | "service" | "wished"> {
  seen: Seen;
}

export function peopleOf(input: PeopleInput): PeopleAnswer {
  const { labels } = input;
  interface Chat {
    key: string; network: string; chat: string; group: boolean; total: number; mine: number; first_ms: number; last_ms: number;
    mine_days: Map<string, number>;
  }
  const chats = new Map<string, Chat>();
  const handles = new Map<string, { handle: Handle; seen: HandleSeen }>();
  const at = (handle: Handle): HandleSeen => {
    const id = handleId(handle);
    let found = handles.get(id);
    if (found === undefined) {
      handles.set(id, found = { handle, seen: {
        networks: new Set(), chats: new Map(), received: 0, sent: 0, replies: 0, quick: 0, theirs: new Map(), groups: new Map(), mine: new Map(),
        mail_from: new Map(), mail_to: new Map(), machine: 0, names_from: new Set(), names_to: new Set(), call_names: new Set(), service: null, days: new Map(), wished: new Set(), first_ms: Infinity, last_ms: -Infinity,
      } });
    }
    return found.seen;
  };
  const touch = (seen: HandleSeen, first: number, last: number) => {
    seen.first_ms = Math.min(seen.first_ms, first);
    seen.last_ms = Math.max(seen.last_ms, last);
  };

  const parts = [...input.chats].filter((part) => part.total > 0);
  const keyOf = new Map<ChatDayPart, string>();
  let now = "";
  for (const part of parts) {
    const shown = resolveChat(input.networks, part.network, part.chat, labels);
    const key = `${part.network}:${shown}`;
    keyOf.set(part, key);
    let chat = chats.get(key);
    if (chat === undefined) {
      chats.set(key, chat = { key, network: part.network, chat: shown, group: isGroupChat(input.networks, part.network, part.chat), total: 0, mine: 0, first_ms: Infinity, last_ms: -Infinity, mine_days: new Map() });
    }
    chat.total += part.total;
    chat.mine += part.mine;
    chat.first_ms = Math.min(chat.first_ms, part.first_ms);
    chat.last_ms = Math.max(chat.last_ms, part.last_ms);
    add(chat.mine_days, part.mine_days);
    const last = civilDay(part.last_ms, input.day);
    if (last > now) now = last;
  }

  for (const part of parts) {
    const key = keyOf.get(part)!;
    const chat = chats.get(key)!;
    const other = part.other === null ? null : partyHandle(part.network, part.other);
    const talk = (input.groups.rules[part.network] ?? NO_GROUP_SETTINGS).talk;
    const counted = (civil: string) => talk === "all" || (talk === "joined" && chat.mine_days.has(civil));
    for (const sender of part.senders) {
      const handle = partyHandle(part.network, sender);
      if (handle === null) continue;
      const seen = at(handle);
      seen.networks.add(part.network);
      seen.chats.set(key, (seen.chats.get(key) ?? 0) + sender.count);
      if (!chat.group) {
        seen.received += sender.count;
        add(seen.days, sender.days);
        touch(seen, sender.first_ms, sender.last_ms);
        if (other !== null) {
          add(seen.theirs, sender.days);
          seen.replies += sender.replies;
          seen.quick += sender.quick;
        }
        continue;
      }
      for (const [civil, count] of Object.entries(sender.days)) {
        if (!counted(civil)) continue;
        seen.received += count;
        seen.groups.set(civil, (seen.groups.get(civil) ?? 0) + count);
        seen.days.set(civil, (seen.days.get(civil) ?? 0) + count);
        const [first, last] = sender.times[civil]!;
        touch(seen, first, last);
      }
    }
    if (other !== null && part.mine > 0) {
      const seen = at(other);
      seen.sent += part.mine;
      add(seen.mine, part.mine_days);
      add(seen.days, part.mine_days);
      for (const civil of part.wished) seen.wished.add(civil);
      touch(seen, part.first_ms, part.last_ms);
    }
  }
  for (const part of input.mail) {
    for (const address of part.addresses) {
      const handle = handleOf(address.address);
      if (handle === null || handle.kind !== "email") continue;
      const seen = at(handle);
      add(seen.mail_from, address.from);
      add(seen.mail_to, address.to);
      seen.machine += address.machine;
      add(seen.days, address.from);
      add(seen.days, address.to);
      for (const name of address.names.from) seen.names_from.add(name);
      for (const name of address.names.to) seen.names_to.add(name);
      touch(seen, address.first_ms, address.last_ms);
    }
  }
  for (const part of input.calls ?? []) {
    for (const party of part.parties) {
      const seen = at(party.handle);
      if (party.name !== null) seen.call_names.add(party.name);
      touch(seen, part.at_ms, part.at_ms);
    }
  }
  for (const { handle, seen } of handles.values()) {
    seen.service = handle.kind === "email" ? serviceOf(handle.value, seen.names_from, { from: sum(seen.mail_from), to: sum(seen.mail_to), machine: seen.machine }) : null;
  }

  const seenHandles = [...handles.values()].map((each) => each.handle);
  const people = resolve({ cards: input.cards, records: input.records, providers: input.providers, networks: input.networks, country: input.country, own: input.own, seen: seenHandles });
  const faces = facesOf(input.faces, input.day);
  for (const { seen } of handles.values()) for (const civil of seen.days.keys()) if (civil > now) now = civil;
  for (const days of faces.camera.values()) for (const civil of days.keys()) if (civil > now) now = civil;
  const recent = now === "" ? -Infinity : Date.parse(`${addDays(now, -RECENT_PHOTO_DAYS)}T00:00:00Z`);
  const picks = facePicks(faces, recent);
  const shown = shownOf(people, { networks: input.networks, names: input.names, records: input.records, photos: input.photos, details: input.details, faces: picks });

  interface Verdict { row: GroupRow; quiet: { why: Why; last_day: string | null } | null; word: boolean | null }
  const verdicts = new Map<string, Verdict>();
  for (const chat of chats.values()) {
    if (!chat.group) continue;
    const rule = input.groups.rules[chat.network] ?? NO_GROUP_SETTINGS;
    const word = input.groups.words.get(chat.key) ?? null;
    const facts = { word, archived: input.providers.get(providerUnit(input.networks, chat.network, chat.chat))?.archived === true, yours: [...chat.mine_days.keys()].sort(compare) };
    const yours = spans(facts, rule);
    verdicts.set(chat.key, {
      row: { yours, first_day: civilDay(chat.first_ms, input.day), last_day: civilDay(chat.last_ms, input.day) },
      quiet: quiet(yours, now) ? { why: why(facts, rule), last_day: facts.yours.at(-1) ?? null } : null,
      word,
    });
  }

  const quietNow = (key: string) => verdicts.get(key)?.quiet != null;

  const folded = new Map<Person, Folded | null>();
  const foldedOf = (person: Person): Folded | null => {
    if (!folded.has(person)) {
      const theirs = person.handles.flatMap((handle) => handles.get(handleId(handle))?.seen ?? []);
      const photos = person.slugs.flatMap((slug) => faces.camera.get(slug) ?? []);
      const labelled = person.slugs.flatMap((slug) => faces.labels.get(slug) ?? []);
      const services = person.handles.map((handle) => handles.get(handleId(handle))?.seen.service ?? null);
      folded.set(person, theirs.length === 0 && photos.length === 0 ? null : foldSeen(theirs, photos, labelled, person.handles.map((handle) => handle.value), services));
    }
    return folded.get(person)!;
  };
  const senders = [...handles.values()].flatMap(({ handle, seen }) =>
    (seen.service === "no-reply" || seen.service === "relay") && people.ids.get(handleId(handle))?.entity !== "person" ? [handle.value] : []);
  const organised = organise(people, (person) => foldedOf(person)?.seen, now, (person) => shown.details(person), senders);
  const since = now === "" ? "" : addDays(now, 1 - WINDOW_DAYS);

  const pageRank = (key: string) => !chats.get(key)!.group ? 0 : quietNow(key) ? 2 : 1;
  const counted = new Map<Person, CountedPart>();
  const countedOf = (person: Person): CountedPart => {
    const kept = counted.get(person);
    if (kept !== undefined) return kept;
    const seen = foldedOf(person);
    const days = [...seen?.days ?? []].sort(([left], [right]) => compare(left, right));
    const part: CountedPart = {
      entity: organised.entity(person), score: organised.score(person),
      networks: [...seen?.networks ?? []].sort(compare),
      chats: [...seen?.chats ?? []].sort(([leftKey, left], [rightKey, right]) => pageRank(leftKey) - pageRank(rightKey)
        || (chats.get(leftKey)!.group ? chats.get(rightKey)!.last_ms - chats.get(leftKey)!.last_ms : right - left) || compare(leftKey, rightKey)).map(([key, count]) => ({ key, count })),
      received: seen?.received ?? 0, sent: seen?.sent ?? 0, mails_from: sum(seen?.seen.counts.mail_from), mails_to: sum(seen?.seen.counts.mail_to),
      first_ms: seen === null || seen.first_ms === Infinity ? null : seen.first_ms, last_ms: seen === null || seen.last_ms === -Infinity ? null : seen.last_ms,
      last_30: days.reduce((total, [civil, count]) => civil >= since ? total + count : total, 0),
      days_count: days.length, last_day: days.at(-1)?.[1] ?? 0, days: Object.fromEntries(days),
    };
    counted.set(person, part);
    return part;
  };
  const entryOf = (person: Person): PersonEntry => entryFrom(shown.of(person), countedOf(person));
  const detailOf = (person: Person): PersonDetail => detailFrom(shown.of(person), countedOf(person), organised.suggestions(person), organised.namesSeen(person));

  const recentMine = (chat: Chat) => {
    let total = 0;
    for (const [civil, count] of chat.mine_days) if (civil >= since) total += count;
    return total;
  };
  const chatOrder = (left: Chat, right: Chat) => Number(quietNow(left.key)) - Number(quietNow(right.key))
    || (quietNow(left.key) ? 0 : recentMine(right) - recentMine(left)) || right.last_ms - left.last_ms || compare(left.key, right.key);
  const chatEntries = [...chats.values()].sort(chatOrder).map((chat): ChatEntry => {
    const [, label, group] = resolvedChat(chat.key, labels, input.networks)!;
    const verdict = verdicts.get(chat.key);
    return {
      key: chat.key, network: chat.network, chat: chat.chat, group, label, total: chat.total, mine: chat.mine, first_ms: chat.first_ms, last_ms: chat.last_ms,
      ...(verdict === undefined ? {} : { quiet: verdict.quiet, word: verdict.word }),
    };
  });
  const byScore = [...people.all].sort((left, right) => organised.score(right) - organised.score(left) || compare(left.id, right.id));
  const photos = new Map<string, ServedPhoto[]>();
  for (const person of people.all) {
    const named = person.slugs.flatMap((slug) => faces.named.get(slug) ?? []).sort(newestFirst);
    if (named.length > 0) photos.set(person.id, named);
  }
  const you = organised.you;
  return {
    list: {
      you: you === null ? null : youFrom(entryOf(you), shown.of(you).also_called, organised.suggestions(you)),
      people: organised.listed.map(entryOf),
      chats: chatEntries,
      organise: {
        queue: organised.queue, organised: organised.organised, often: organised.often,
        businesses: organised.listed.flatMap((person) => organised.suggestions(person).filter((each) => each.kind === "entity" && each.value === "business")
          .map((offered) => ({ id: person.id, reasons: offered.reasons }))),
      },
      others: organised.others,
    },
    persons: people.all.map(detailOf),
    alias: new Map([...[...people.ids].map(([id, person]) => [id, person.id] as const), ...you === null ? [] : [["me", you.id] as const]]),
    searched: byScore.map((person) => searchedOf(person, organised)),
    photos,
    groups: new Map([...verdicts].sort(([left], [right]) => compare(left, right)).map(([key, verdict]) => [key, verdict.row])),
    quiet: Object.fromEntries(input.networks.products.map((network) => [network, [...chats.values()].filter((chat) => chat.network === network && quietNow(chat.key)).length])),
    who: { cards: input.cards, providers: [...input.providers], seen: seenHandles, faces: picks },
  };
}

export function whoNow(who: Who, now: Pick<PeopleNow, "records" | "own" | "country" | "networks">): People {
  return resolve({ cards: who.cards, records: now.records, providers: new Map(who.providers), networks: now.networks, country: now.country, own: now.own, seen: who.seen });
}

const NOTHING_COUNTED: Omit<CountedPart, "entity"> = {
  score: 0, networks: [], chats: [], received: 0, sent: 0, mails_from: 0, mails_to: 0, first_ms: null, last_ms: null, last_30: 0, days_count: 0, last_day: 0, days: {},
};

export function rejoin(run: PeopleRun, people: People, now: PeopleNow, changed: PeopleChanged, counting: boolean): Rejoined {
  const shown = shownOf(people, { networks: now.networks, names: now.names, records: now.records, photos: now.photos, details: now.details, faces: run.who.faces });
  const kept = run.list();
  const you = people.all.find((person) => person.me) ?? null;
  const read = new Map<string, PersonDetail | undefined>();
  const rowOf = (id: string) => {
    if (!read.has(id)) read.set(id, run.row(id));
    return read.get(id);
  };
  const rows = new Set<string>();
  const touched = new Set<Person>();
  const queue: (Person | string)[] = [];
  const reach = (each: Person | string | null | undefined) => {
    if (each == null || (typeof each === "string" ? rows.has(each) || rowOf(each) === undefined : touched.has(each))) return;
    if (typeof each === "string") rows.add(each);
    else touched.add(each);
    queue.push(each);
  };
  const basesOf = (person: Person) =>
    [...new Set([person.id, ...person.slugs.map((slug) => `person:${slug}`), ...person.handles.map(handleId)].flatMap((id) => run.alias(id) ?? []))].filter((id) => rowOf(id) !== undefined);
  const personsOf = (id: string): Person[] => {
    const row = rowOf(id)!;
    return [id, ...row.handles.map((handle) => handle.id), ...row.person === null ? [] : [`person:${row.person}`], ...row.joined.map((member) => member.id)]
      .flatMap((each) => people.ids.get(each) ?? []);
  };
  if (changed.persons.length + changed.keys.length > 0) {
    for (const key of [...changed.persons.map((slug) => `person:${slug}`), ...changed.keys]) {
      reach(run.alias(key));
      reach(people.ids.get(key));
    }
    reach(kept.you?.id);
    reach(you);
  }
  for (let at = 0; at < queue.length; at++) {
    const each = queue[at]!;
    if (typeof each === "string") for (const person of personsOf(each)) reach(person);
    else for (const id of basesOf(each)) reach(id);
  }

  const built = new Map<string, { detail: JoinedPerson; stands: string | null; theirs: boolean }>();
  for (const person of touched) {
    const bases = basesOf(person);
    const base = bases.length === 1 ? rowOf(bases[0]!) : bases.includes(person.id) ? rowOf(person.id) : undefined;
    const own = shown.of(person);
    const unjudged = own.said === null && base !== undefined && base.entity_by === "you";
    const held = (ids: readonly string[]) => [...ids].sort().join("\0");
    const theirs = base !== undefined && bases.length === 1 && !unjudged && held(base.handles.map((handle) => handle.id)) === held(own.handles.map((handle) => handle.id));
    const entity = own.said ?? (base?.entity_by === "home" ? base.entity : "person");
    const counts: CountedPart = base === undefined ? { ...NOTHING_COUNTED, entity } : {
      entity, score: base.score, networks: base.networks, chats: base.chats, received: base.received, sent: base.sent, mails_from: base.mails_from, mails_to: base.mails_to,
      first_ms: base.first_ms, last_ms: base.last_ms, last_30: base.last_30, days_count: base.days_count, last_day: base.last_day, days: base.days,
    };
    const detail = detailFrom(own, counts, stillOffered(base?.suggestions ?? [], person, own, people), base?.names_seen ?? []);
    built.set(person.id, { detail: counting && !theirs ? { ...detail, counting: true } : detail, stands: base?.id ?? null, theirs });
  }

  const find = (id: string): Person | undefined => id === "me" ? you ?? undefined : people.ids.get(id) ?? people.ids.get(spelledId(id) ?? "");
  return {
    person(id) {
      const found = find(id);
      if (found === undefined) return undefined;
      const made = built.get(found.id);
      if (made !== undefined) return { person: made.detail };
      const row = run.alias(found.id);
      return row === undefined ? undefined : { row };
    },
    stands(id) {
      const found = find(id);
      if (found === undefined) return undefined;
      const made = built.get(found.id);
      return made !== undefined ? made.stands : run.alias(found.id) ?? null;
    },
    list() {
      const listedBefore = new Set(kept.people.map((entry) => entry.id));
      const listed = (person: Person) => !person.me && !person.hidden && (person.record !== null || person.cards.length > 0 || (built.get(person.id)!.theirs && listedBefore.has(built.get(person.id)!.stands!)));
      const entries = [...kept.people.filter((entry) => !rows.has(entry.id)), ...[...touched].filter(listed).map((person) => listEntry(built.get(person.id)!.detail))]
        .sort((left, right) => right.score - left.score || compare(left.id, right.id));
      const madeYou = you === null ? undefined : built.get(you.id)?.detail;
      const offers = new Map(kept.organise.businesses.map((offer) => [offer.id, offer]));
      const business = (each: Suggestion) => each.kind === "entity" && each.value === "business";
      const organised = kept.organise.organised - [...rows].filter((id) => rowOf(id)!.organised && !rowOf(id)!.me).length
        + [...touched].filter((person) => !person.me && person.record !== null).length;
      return {
        ...kept,
        you: you === null ? null : madeYou === undefined ? kept.you : youFrom(listEntry(madeYou), madeYou.also_called, madeYou.suggestions),
        people: entries,
        chats: kept.chats.map((chat) => {
          if (!changed.groups.has(chat.key)) return chat;
          const word = changed.groups.get(chat.key)!;
          return { ...chat, word, quiet: word === true ? { why: "owner" as const, last_day: chat.quiet?.last_day ?? null } : word === false || chat.quiet?.why === "owner" ? null : chat.quiet ?? null };
        }),
        organise: {
          queue: entries.filter((entry) => !entry.organised && entry.handles.length > 0).map((entry) => entry.id),
          organised, often: entries.filter((entry) => !entry.organised && entry.score > OFTEN).length,
          businesses: entries.flatMap((entry) => {
            const made = built.get(entry.id)?.detail;
            if (made === undefined) return offers.has(entry.id) ? [offers.get(entry.id)!] : [];
            return made.suggestions.filter(business).map((offered) => ({ id: entry.id, reasons: offered.reasons }));
          }),
        },
      };
    },
  };
}

export function listEntry({ days: _days, suggestions: _suggestions, names_seen: _names, also_called: _called, joined: _joined, record: _record, details: _details, ...entry }: JoinedPerson): PersonEntry & Counting {
  return entry;
}

function stillOffered(offered: readonly Suggestion[], person: Person, own: OwnPart, people: People): Suggestion[] {
  const dismissed = new Set(person.record?.dismissed ?? []);
  const held = new Set(person.handles.map(handleId));
  const excluded = new Set(person.record?.excluded.map(handleId) ?? []);
  const named = new Set([person.call_name, person.full_name ?? ""].map(foldName));
  const details = own.details;
  const profiles = new Set((details?.profiles ?? []).map((profile) => `${profile.network}:${profile.value}`));
  const knownDay = (value: string) => details?.birthday != null && birthdayValue({ ...details.birthday, year: value.length === 5 ? null : details.birthday.year }) === value;
  return offered.filter((each) => !dismissed.has(each.id) && (
    each.kind === "handle" ? !held.has(each.value) && !excluded.has(each.value) && (people.ids.get(each.value)?.record ?? null) === null
      : each.kind === "entity" ? person.entity === null && !person.me
        : each.kind === "full_name" ? !named.has(foldName(each.value))
          : each.kind === "same" ? people.ids.get(each.value.includes(":") ? each.value : `person:${each.value}`) !== person
            : each.kind === "work" ? details?.work == null || foldName(details.work) !== foldName(each.value)
              : each.kind === "profile" ? !profiles.has(each.value)
                : !knownDay(each.value)));
}

interface ShownInput {
  readonly networks: Networks;
  readonly names: ((product: string) => string | undefined) | undefined;
  readonly records: readonly RecordState[];
  readonly photos: readonly StatedPhoto[];
  readonly details: readonly StatedDetails[];
  readonly faces: Readonly<Record<string, FacePicks>>;
}

interface Shown {
  of(person: Person): OwnPart;
  details(person: Person): Details | undefined;
}

function shownOf(people: People, input: ShownInput): Shown {
  const stated = newestStated(input.photos, people.ids);
  const records = new Map<string, PersonRecord>();
  for (const state of input.records) if (!records.has(state.record.slug)) records.set(state.record.slug, state.record);
  const groupOf = (person: Person): DetailsGroup => ({ root: person.slug ?? "", records: person.slugs.flatMap((slug) => records.get(slug) ?? []) });
  const said = new Map<Person, StatedDetails[]>();
  for (const statement of input.details) {
    const person = people.ids.get(statement.key);
    if (person !== undefined) said.set(person, [...said.get(person) ?? [], statement]);
  }
  const details = new Map<Person, Details>();
  for (const [person, statements] of said) {
    const shown = detailsOf(groupOf(person), statements);
    if (shown !== undefined) details.set(person, shown);
  }
  const nameOf = (product: string) => input.names?.(product) ?? input.networks.name(product);
  const joinedOf = (person: Person): JoinedEntry[] => {
    const members = person.slug === null ? [] : people.joined.get(person.slug) ?? [];
    const bySlug = new Map(members.map((member) => [member.slug, member]));
    const group = groupOf(person);
    const aloneName = (member: Member): string => {
      const record = records.get(member.slug)!;
      const handle = record.anchor ?? record.handles[0];
      return record.name ?? record.full_name ?? member.card?.name ?? (handle === undefined ? "" : handleWords(handle, input.networks));
    };
    return members.flatMap((member): JoinedEntry[] => {
      const named = [member.slug, ...member.with].some((slug) => input.faces[slug] !== undefined);
      if (member.leaving.length === 0 && !named) return [];
      const own = input.photos.filter((photo) => people.ids.get(photo.key) === person && whoseDetails(group, photo.key) === member.slug)
        .sort((left, right) => right.stated_ms - left.stated_ms || compare(left.key, right.key))[0];
      const card = member.card?.photo?.hash;
      return [{
        id: `person:${member.slug}`, name: aloneName(member), photo: own !== undefined ? { crop: own.image } : card !== undefined ? { card } : null,
        handles: member.leaving.map(handleId), with: member.with.map((slug) => aloneName(bySlug.get(slug)!)),
      }];
    });
  };
  const parts = new Map<Person, OwnPart>();
  return {
    details: (person) => details.get(person),
    of(person) {
      const kept = parts.get(person);
      if (kept !== undefined) return kept;
      const record = person.stated === null ? null : statedPerson(person.stated);
      const shown = details.get(person);
      const part: OwnPart = {
        id: person.id, name: person.name, call_name: person.call_name, full_name: person.full_name, show: person.show, by: person.by, person: person.slug,
        said: person.entity, entity_by: person.entity === null ? "home" : "you", relationship: person.relationship, me: person.me, hidden: person.hidden,
        organised: person.organised, card: person.cards.length > 0, photo: photoOf(person, stated, input.faces),
        handles: person.handles.map((handle) => ({
          id: handleId(handle), kind: handle.kind, network: handle.kind === "network" ? handle.value.slice(0, handle.value.indexOf(":")) : null, words: handleWords(handle, input.networks),
          from: fromWords(handle.from, people.accounts.get(handleId(handle)) ?? [], nameOf), own: people.accounts.has(handleId(handle)),
        })),
        ...(shown?.work != null ? { work: shown.work } : {}),
        also_called: alsoCalled(person).map(({ name, from }) => ({ name, from: from === "card" ? "Contacts" : "You added" })),
        joined: joinedOf(person), record, ...(shown === undefined ? {} : { details: shown }),
      };
      parts.set(person, part);
      return part;
    },
  };
}

function entryFrom(own: OwnPart, counted: CountedPart): PersonEntry {
  return {
    id: own.id, name: own.name, call_name: own.call_name, full_name: own.full_name, show: own.show, by: own.by, person: own.person, entity: counted.entity, entity_by: own.entity_by,
    relationship: own.relationship, me: own.me, hidden: own.hidden, organised: own.organised, card: own.card, photo: own.photo, score: counted.score, handles: own.handles,
    networks: counted.networks, chats: counted.chats, received: counted.received, sent: counted.sent, mails_from: counted.mails_from, mails_to: counted.mails_to,
    first_ms: counted.first_ms, last_ms: counted.last_ms, last_30: counted.last_30, days_count: counted.days_count, last_day: counted.last_day,
    ...(own.work === undefined ? {} : { work: own.work }),
  };
}

function detailFrom(own: OwnPart, counted: CountedPart, suggestions: readonly Suggestion[], seen: readonly string[]): PersonDetail {
  const told = new Set([own.name, own.full_name ?? "", ...own.also_called.map(({ name }) => name)].map(foldName));
  return {
    ...entryFrom(own, counted), days: counted.days, suggestions, names_seen: seen.filter((name) => !told.has(foldName(name))),
    also_called: own.also_called, joined: own.joined, record: own.record, ...(own.details === undefined ? {} : { details: own.details }),
  };
}

function youFrom<T extends PersonEntry>(entry: T, also: readonly CalledEntry[], suggestions: readonly Suggestion[]): T & Pick<YouEntry, "also_called" | "suggested"> {
  return { ...entry, also_called: also, suggested: suggestions.filter((each) => each.kind === "handle" || each.kind === "same").length };
}

export function findPeople(searched: readonly Searched[], text: string): string[] {
  const asked = foldName(text).split(/\s+/u).filter(Boolean);
  if (asked.length === 0) return [];
  const found: string[] = [];
  for (const person of searched) {
    if (found.length >= FOUND) break;
    const matched = asked.every((word) => {
      if (person.words.some((name) => name.startsWith(word)) || person.values.some((value) => value.includes(word))) return true;
      const digits = word.replace(/[+\s().-]/gu, "");
      return /^\d{3,}$/u.test(digits) && person.phones.some((phone) => phone.includes(digits));
    });
    if (matched) found.push(person.id);
  }
  return found;
}

export function spelledId(id: string): string | null {
  const handle = handleOfId(id);
  return handle === null ? null : handleId(handle);
}

function searchedOf(person: Person, organised: Organised): Searched {
  return searchedBy(person.id, [person.call_name, person.full_name ?? "", ...organised.namesSeen(person)], person.handles);
}

export function searchedBy(id: string, names: readonly string[], handles: readonly Handle[]): Searched {
  return {
    id, words: [...new Set(names.flatMap((name) => foldName(name).split(/[^\p{L}\p{N}]+/u)).filter(Boolean))], values: handles.map((handle) => foldName(handle.value)),
    phones: handles.flatMap((handle) => handle.kind === "phone" ? [handle.value.slice(1)] : []),
  };
}

function foldSeen(theirs: readonly HandleSeen[], photos: readonly ReadonlyMap<string, number>[], labels: readonly string[], addresses: readonly string[], services: readonly (Service | null)[]): Folded {
  const counts = {
    theirs: new Map<string, number>(), groups: new Map<string, number>(), mine: new Map<string, number>(), replies: 0, quick: 0, mail_from: new Map<string, number>(),
    mail_to: new Map<string, number>(), photos: new Map<string, number>(),
  };
  const out = { networks: new Set<string>(), chats: new Map<string, number>(), received: 0, sent: 0, days: new Map<string, number>(), first_ms: Infinity, last_ms: -Infinity };
  const names = new Set<string>();
  const callNames = new Set<string>();
  const wished = new Set<string>();
  for (const seen of theirs) {
    for (const network of seen.networks) out.networks.add(network);
    add(out.chats, seen.chats);
    out.received += seen.received;
    out.sent += seen.sent;
    add(out.days, seen.days);
    out.first_ms = Math.min(out.first_ms, seen.first_ms);
    out.last_ms = Math.max(out.last_ms, seen.last_ms);
    add(counts.theirs, seen.theirs);
    add(counts.groups, seen.groups);
    add(counts.mine, seen.mine);
    add(counts.mail_from, seen.mail_from);
    add(counts.mail_to, seen.mail_to);
    counts.replies += seen.replies;
    counts.quick += seen.quick;
    for (const civil of seen.wished) wished.add(civil);
    for (const name of seen.call_names) callNames.add(name);
    if (seen.service !== null) continue;
    for (const name of [...seen.names_from, ...seen.names_to]) names.add(name);
  }
  for (const days of photos) add(counts.photos, days);
  const service = services.length > 0 && services.every((each) => each !== null);
  const sender = services.length > 0 && services.every((each) => each === "no-reply" || each === "relay") ? (services.includes("relay") ? "relay" : "no-reply") : null;
  const senders = addresses.filter((_, index) => services[index] === "no-reply" || services[index] === "relay");
  return {
    ...out,
    seen: {
      counts: counts satisfies Counts, mail_names: [...names].sort(compare),
      ...(callNames.size === 0 ? {} : { call_names: [...callNames].sort(compare) }),
      photo_labels: labels, service, sender, senders, wished: [...wished].sort(compare),
    },
  };
}

interface Faces {
  readonly named: ReadonlyMap<string, readonly ServedPhoto[]>;
  readonly camera: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly labels: ReadonlyMap<string, readonly string[]>;
  readonly byFace: ReadonlyMap<string, NamedFace>;
}

function facesOf(input: FacesSaid | null, day: DaySettings): Faces {
  const named = new Map<string, ServedPhoto[]>();
  const camera = new Map<string, Map<string, number>>();
  const labels = new Map<string, readonly string[]>();
  const byFace = new Map<string, NamedFace>();
  for (const [slug, said] of input?.named ?? []) {
    labels.set(slug, said.labels);
    for (const face of said.photos) {
      const at = parseFaceKey(face.face);
      if (at === null) continue;
      byFace.set(face.face, face);
      push(named, slug, { image: at.photo, face: face.face, box: at.box, at_ms: face.at_ms, crop: face.crop, camera: face.camera });
      if (face.camera && face.at_ms !== null) {
        const days = camera.get(slug) ?? new Map<string, number>();
        const civil = civilDay(face.at_ms, day);
        days.set(civil, (days.get(civil) ?? 0) + 1);
        camera.set(slug, days);
      }
    }
  }
  return { named, camera, labels, byFace };
}

function newestStated<T extends Stated>(statements: readonly T[], ids: ReadonlyMap<string, Person>): Map<Person, T> {
  const theirs = new Map<Person, T>();
  for (const statement of statements) {
    const person = ids.get(statement.key);
    if (person === undefined) continue;
    const held = theirs.get(person);
    if (held === undefined || statement.stated_ms > held.stated_ms || (statement.stated_ms === held.stated_ms && statement.key < held.key)) theirs.set(person, statement);
  }
  return theirs;
}

function facePicks(faces: Faces, recent: number): Record<string, FacePicks> {
  const picks: Record<string, FacePicks> = {};
  const size = (photo: ServedPhoto) => faces.byFace.get(photo.face)?.size ?? 0;
  for (const [slug, named] of faces.named) {
    const cropped = named.filter((photo) => photo.crop !== null);
    const seed = cropped.filter((photo) => photo.camera && photo.at_ms !== null && photo.at_ms >= recent && faces.byFace.get(photo.face)?.tier === "seed")
      .sort((left, right) => size(right) - size(left) || compare(left.face, right.face))[0];
    const newest = [...cropped].sort(newestFirst)[0];
    picks[slug] = {
      ...(seed === undefined ? {} : { seed: [size(seed), seed.face, seed.crop!] as const }),
      ...(newest === undefined ? {} : { newest: [newest.at_ms, newest.face, newest.crop!] as const }),
    };
  }
  return picks;
}

function photoOf(person: Person, stated: ReadonlyMap<Person, StatedPhoto>, faces: Readonly<Record<string, FacePicks>>): PersonPhoto {
  const said = stated.get(person);
  if (said !== undefined) return { crop: said.image };
  const card = person.cards.find((each) => each.photo !== null)?.photo;
  if (card != null) return { card: card.hash };
  const picks = person.slugs.flatMap((slug) => faces[slug] ?? []);
  const seed = picks.flatMap((pick) => pick.seed === undefined ? [] : [pick.seed]).sort(([leftSize, leftFace], [rightSize, rightFace]) => rightSize - leftSize || compare(leftFace, rightFace))[0];
  if (seed !== undefined) return { crop: seed[2] };
  const newest = picks.flatMap((pick) => pick.newest === undefined ? [] : [pick.newest])
    .sort(([leftAt, leftFace], [rightAt, rightFace]) => (rightAt ?? -Infinity) - (leftAt ?? -Infinity) || compare(leftFace, rightFace))[0];
  return newest === undefined ? null : { crop: newest[2] };
}

function newestFirst(left: ServedPhoto, right: ServedPhoto): number {
  return (right.at_ms ?? -Infinity) - (left.at_ms ?? -Infinity) || compare(left.face, right.face);
}

function add(into: Map<string, number>, from: ReadonlyMap<string, number> | Readonly<Record<string, number>>): void {
  for (const [key, count] of from instanceof Map ? from : Object.entries(from)) into.set(key, (into.get(key) ?? 0) + count);
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function sum(days: ReadonlyMap<string, number> | undefined): number {
  let total = 0;
  for (const count of days?.values() ?? []) total += count;
  return total;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
