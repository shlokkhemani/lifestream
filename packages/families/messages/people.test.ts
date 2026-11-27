import { handleId, type DaySettings, type Handle, type PersonRecord } from "@lifestreamprotocol/core";
import { describe, expect, it } from "vitest";
import { FED } from "../test/fed.js";
import { labelsFrom } from "../shared/labels.js";
import { cardParts, calledId, readCard, suggestionId, type Card, type RecordState } from "../shared/people.js";
import { networksOf } from "./networks.js";
import {
  callPeoplePart, findPeople, NO_GROUP_SETTINGS, peopleOf, rejoin, whoNow, type CallPeoplePart, type FacesSaid, type JoinedPerson, type MailDayPart, type PeopleAnswer, type PeopleChanged, type PeopleInput, type PeopleNow,
  type PeopleRun, type StatedDetails, type StatedPhoto,
} from "./people.js";

const NETWORKS = networksOf(FED.messages);
const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const DAY = "2026-10-02";
const T = Date.parse(`${DAY}T16:00:00Z`);
const BOOK = "apple-contacts:person-a@example.com:iphone-aa01";
const OWN: Handle = { kind: "phone", value: "+15550000800" };
const COUNTED = ["score", "networks", "chats", "received", "sent", "mails_from", "mails_to", "first_ms", "last_ms", "last_30", "days_count", "last_day", "days"] as const;
const REFINED = ["suggestions", "names_seen"] as const;

const phone = (n: string): Handle => ({ kind: "phone", value: `+15550000${n}` });
const email = (local: string): Handle => ({ kind: "email", value: `${local}@example.com` });
const card = (lines: string[], since = T) => {
  const vcard = ["BEGIN:VCARD", "VERSION:3.0", ...lines, "END:VCARD"].join("\r\n");
  return readCard({ source: BOOK, key: vcard }, since, cardParts({ type: "contacts.card", card: vcard })!);
};
const record = (slug: string, name: string | null, handles: Handle[], extra: Partial<PersonRecord> = {}): PersonRecord => ({
  slug, name, full_name: null, show: "name", entity: null, relationship: null, hidden: false, me: false,
  anchor: handles[0] ?? null, handles: handles.slice(1), excluded: [], dismissed: [], also_called: [], merged_into: null, ...extra,
});
const stateOf = (said: PersonRecord, since: number, was?: RecordState): RecordState => ({
  record: said,
  since: new Map([...said.anchor === null ? [] : [said.anchor], ...said.handles].map((handle) => [handleId(handle), was?.since.get(handleId(handle)) ?? since])),
  me_since: said.me ? was?.record.me === true ? was.me_since : since : null,
  merged_since: said.merged_into === null ? null : was?.record.merged_into === said.merged_into ? was.merged_since : since,
});
const face = (n: number) => `${n.toString(16).padStart(64, "0")}:0,0,10,10`;
const address = (handle: Handle, from: number, to: number, names: string[] = []) => ({
  address: handle.value, from: { [DAY]: from }, to: { [DAY]: to }, machine: 0, names: { from: names, to: [] }, first_ms: T, last_ms: T,
});

interface World {
  readonly records: readonly RecordState[];
  readonly photos: readonly StatedPhoto[];
  readonly details: readonly StatedDetails[];
}

const CARDS: Card[] = [
  card(["FN:Person Ka", "TEL;TYPE=CELL:+15550000801"]), card(["FN:Person Kb", "NICKNAME:Kay", "TEL;TYPE=CELL:+15550000811"]),
  card(["FN:Person Kd", "TEL;TYPE=CELL:+15550000851"]), card(["FN:Person Kn Card", "TEL;TYPE=CELL:+15550000883"]),
  card(["ORG:Synthetic Bakery", "TEL:+15550000821"]), card(["ORG:Synthetic Florist", "TEL:+15550000831"]),
  card(["FN:Person Kp", "TEL;TYPE=CELL:+15550000861", "EMAIL:person-kp@example.com"]),
];
const MAIL: MailDayPart = { addresses: [
  address(email("person-ka"), 3, 4, ["Person Ka"]), address(email("person-kp"), 2, 5), address(email("person-loose"), 1, 3, ["Person Loose"]),
  address(email("person-kf"), 4, 4), address(email("person-kg"), 2, 2),
] };
const FACES: FacesSaid = { named: new Map([
  ["person-kf", { photos: [{ face: face(1), at_ms: T, camera: true, crop: "sha256:" + "1".repeat(64), tier: "seed", size: 40 }], labels: [] }],
  ["person-kg", { photos: [{ face: face(2), at_ms: T - 1, camera: true, crop: "sha256:" + "2".repeat(64), tier: null, size: 10 }], labels: [] }],
]) };

const FIRST: readonly PersonRecord[] = [
  record("person-ka", "Person Ka", [phone("801"), email("person-ka")]),
  record("person-kb", "Person Kb", [phone("811")]),
  record("person-kc", "Person Kc", [phone("881")]),
  record("person-kd", "Person Kd", [phone("851")]),
  record("person-ke", "Person Ke", [phone("893")]),
  record("person-kf", "Person Kf", [phone("895"), email("person-kf")]),
  record("person-kg", "Person Kg", [phone("897"), email("person-kg")], { merged_into: "person-kf" }),
  record("person-kh", "Person Kh", [phone("809")]),
  record("person-kn", "Person Kn", [phone("883")]),
  record("person-ku", "Person Ku", [phone("871"), phone("872")]),
];

function inputOf(world: World): PeopleInput {
  return {
    networks: NETWORKS, chats: [], mail: [MAIL], labels: labelsFrom(() => undefined, SETTINGS), cards: CARDS, records: world.records, providers: new Map(),
    country: "1", own: [{ ...OWN, product: "whatsapp" }], faces: FACES, photos: world.photos, details: world.details, day: SETTINGS,
    groups: { words: new Map(), rules: { whatsapp: NO_GROUP_SETTINGS } },
  };
}

function kept<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function runOf(answer: PeopleAnswer): PeopleRun {
  const rows = new Map(answer.persons.map((person) => [person.id, kept(person)]));
  const list = kept(answer.list);
  return { who: kept(answer.who), list: () => list, row: (id) => rows.get(id), alias: (id) => answer.alias.get(id) };
}

function nowOf(world: World): PeopleNow {
  return { records: world.records, photos: world.photos, details: world.details, own: [{ ...OWN, product: "whatsapp" }], country: "1", networks: NETWORKS };
}

function changedOf(before: World, after: World): PeopleChanged {
  const differ = <T extends { key: string }>(left: readonly T[], right: readonly T[]) => {
    const was = new Map(left.map((each) => [each.key, JSON.stringify(each)]));
    const is = new Map(right.map((each) => [each.key, JSON.stringify(each)]));
    return [...new Set([...was.keys(), ...is.keys()])].filter((key) => was.get(key) !== is.get(key));
  };
  const slugs = (world: World) => world.records.map((state) => ({ key: state.record.slug, record: state.record }));
  return { persons: differ(slugs(before), slugs(after)), keys: [...differ(before.photos, after.photos), ...differ(before.details, after.details)], groups: new Map() };
}

function without<T extends object>(value: T, keys: readonly string[]): Partial<T> {
  return Object.fromEntries(Object.entries(kept(value)).filter(([key]) => !keys.includes(key))) as Partial<T>;
}

function judge(before: World, after: World): { counting: string[]; read: Map<string, JoinedPerson> } {
  const run = runOf(peopleOf(inputOf(before)));
  const now = nowOf(after);
  const joined = rejoin(run, whoNow(run.who, now), now, changedOf(before, after), true);
  const fresh = peopleOf(inputOf(after));
  const counting: string[] = [];
  const read = new Map<string, JoinedPerson>();
  for (const person of fresh.persons) {
    const found = joined.person(person.id);
    expect(found, `${person.id} is found`).toBeDefined();
    const shown = "row" in found! ? run.row(found.row)! : found!.person;
    read.set(person.id, shown);
    const { counting: said, ...rest } = shown as JoinedPerson;
    if (said === true) counting.push(person.id);
    const left = said === true ? [...REFINED, ...COUNTED, ...person.entity_by === "home" ? ["entity"] : []] : REFINED;
    expect(without(rest, left), `${person.id} as the next run serves them`).toEqual(without(kept(person), left));
  }
  const list = joined.list();
  const settled = (ids: readonly string[]) => ids.filter((id) => !counting.includes(id)).sort();
  expect([list.you?.id ?? null, settled(list.people.map((entry) => entry.id)), settled(list.organise.queue), list.organise.organised])
    .toEqual([fresh.list.you?.id ?? null, settled(fresh.list.people.map((entry) => entry.id)), settled(fresh.list.organise.queue), fresh.list.organise.organised]);
  return { counting: counting.sort(), read };
}

function act(world: World, records: Record<string, (said: PersonRecord) => PersonRecord>, made: PersonRecord[] = [], more: Partial<World> = {}): World {
  const at = T + 60_000;
  const states = world.records.map((state) => {
    const change = records[state.record.slug];
    return change === undefined ? state : stateOf(change(structuredClone(state.record)), at, state);
  });
  return { ...world, ...more, records: [...states, ...made.map((each) => stateOf(each, at))] };
}

describe("the People join: who a person is, decided once", () => {
  const start: World = { records: FIRST.map((each) => stateOf(each, T)), photos: [], details: [] };

  it("every act of the People table, joined with the last run, reads as the next run reads it: every field the owner says, and counted parts only where `counting` says they are not theirs", () => {
    const pass = (after: World) => judge(start, after).counting;
    const ka = { "person-ka": (said: PersonRecord) => ({ ...said, name: "Kay A", full_name: "Person Ka Example", relationship: "friend" }) };
    const work: StatedDetails = { key: "person:person-ka", stated_ms: T + 60_000, details: { work: "Example Works", birthday: null, profiles: [] } };
    expect(pass(act(start, ka, [], { details: [work] }))).toEqual([]);
    expect(pass(act(start, { "person-kh": (said) => ({ ...said, hidden: true }) }))).toEqual([]);
    expect(pass(act(start, { "person-kb": (said) => ({ ...said, also_called: ["Kaybee"], dismissed: [calledId("Kay")] }) }))).toEqual([]);
    expect(pass(act(start, {}, [record("synthetic-bakery", null, [phone("821")], { entity: "business" })]))).toEqual([]);
    expect(pass(act(start, {}, [record("synthetic-florist", null, [phone("831")], { dismissed: [suggestionId("entity", "business")] })]))).toEqual([]);
    expect(pass(act(start, { "person-ku": (said) => ({ ...said, handles: [], excluded: [phone("872")] }) }))).toEqual(["person:person-ku", "phone:+15550000872"]);
    expect(pass(act(start, { "person-kd": (said) => ({ ...said, merged_into: "person-kc" }) }))).toEqual(["person:person-kc"]);
    expect(pass(act(start, { "person-ke": (said) => ({ ...said, handles: [email("person-loose")] }) }))).toEqual(["person:person-ke"]);
    expect(pass(act(start, { "person-kg": (said) => ({ ...said, merged_into: null }) }))).toEqual(["person:person-kf", "person:person-kg"]);
    expect(pass(act(start, {}, [record("sam", "Sam", [], { full_name: "Sam Example", me: true, entity: "person" })]))).toEqual([]);
    const picture: StatedPhoto = { key: "person:person-ka", image: "sha256:" + "a".repeat(64), stated_ms: T + 60_000 };
    expect(pass(act(start, {}, [], { photos: [picture] }))).toEqual([]);
    expect(pass(act(start, {}, [record("person-face", "Person Face", [])]))).toEqual(["person:person-face"]);
    expect(pass(act(start, {}, [record("person-kp", null, [phone("861")])]))).toEqual([]);
  });

  it("a cleared name reads the card's name at once, a photo undone falls back to the faces named, and an erased root leaves its member a person of their own", () => {
    const cleared = judge(start, act(start, { "person-kn": (said) => ({ ...said, name: null }) })).read.get("person:person-kn")!;
    expect([cleared.name, cleared.by, cleared.counting]).toEqual(["Person Kn Card", "contact", undefined]);
    const picture: StatedPhoto = { key: "person:person-kf", image: "sha256:" + "f".repeat(64), stated_ms: T };
    const pictured: World = { ...start, photos: [picture] };
    expect(judge(pictured, start).read.get("person:person-kf")!.photo).toEqual({ crop: "sha256:" + "1".repeat(64) });
    const erased: World = { ...start, records: start.records.filter((state) => state.record.slug !== "person-kf") };
    const member = judge(start, erased).read.get("person:person-kg")!;
    expect([member.id, member.person, member.joined]).toEqual(["person:person-kg", "person-kg", []]);
  });

  it("while People is paused no answer says counting, and a person an act made stands on the row of the handle they were", () => {
    const after = act(start, { "person-kg": (said) => ({ ...said, merged_into: null }) }, [record("person-kp", "Person Kp", [phone("861")])]);
    const run = runOf(peopleOf(inputOf(start)));
    const now = nowOf(after);
    const held = rejoin(run, whoNow(run.who, now), now, changedOf(start, after), false);
    const split = held.person("person:person-kg");
    expect(split !== undefined && "person" in split ? split.person.counting : "row").toBeUndefined();
    expect(held.list().people.filter((entry) => entry.counting !== undefined)).toEqual([]);
    const stood = run.alias("phone:+15550000861");
    expect([held.stands("person:person-kp"), held.stands("phone:+15550000861"), held.stands("email:person-kp@example.com"), stood?.startsWith("person:")])
      .toEqual([stood, stood, stood, false]);
  });

  it("a call-only caller is searchable by caller-ID name and phone without entering the People list, and merges when a card holds the number", () => {
    const calls = [
      callPeoplePart({ start_ms: T, parties: [{ id: "+15550000991", kind: "phone", provider: "Synthetic Caller" }] }),
      callPeoplePart({ start_ms: T + 1_000, parties: [{ id: "+15550000992", kind: "phone", provider: "+15550000992" }] }),
      callPeoplePart({ start_ms: T + 2_000, parties: [{ id: "15550000993@s.whatsapp.net", kind: "jid" }] }),
      callPeoplePart({ start_ms: T + 3_000, parties: [{ id: "+15550000801", kind: "phone", provider: "Ka Caller Id" }] }),
      callPeoplePart({ start_ms: T + 4_000, parties: [] }),
    ].filter((part): part is CallPeoplePart => part !== null);
    expect(calls).toHaveLength(4);
    const answer = peopleOf({ ...inputOf(start), calls });
    const byId = new Map(answer.persons.map((person) => [person.id, person]));
    const caller = byId.get("phone:+15550000991")!;
    expect(caller.handles.map((handle) => handle.id)).toEqual(["phone:+15550000991"]);
    expect(caller.names_seen).toEqual(["Synthetic Caller"]);
    expect(answer.list.people.some((entry) => entry.id === caller.id)).toBe(false);
    expect(findPeople(answer.searched, "Synthetic Caller")).toEqual([caller.id]);
    expect(findPeople(answer.searched, "5550000991")).toEqual([caller.id]);
    expect(byId.get("phone:+15550000992")!.names_seen).toEqual([]);
    expect(byId.get("phone:+15550000993")!.handles.map((handle) => handle.id)).toEqual(["phone:+15550000993"]);
    expect(byId.get("person:person-ka")!.names_seen).toContain("Ka Caller Id");
    expect(byId.get("person:person-ka")!.last_30).toBe(peopleOf(inputOf(start)).persons.find((person) => person.id === "person:person-ka")!.last_30);
  });
});
