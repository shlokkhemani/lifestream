import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { addDays, civilDay, instant, sourceName, span, type DaySettings, type Json, type ReaderOutput, type SourceRow, type Version } from "@lifestreamprotocol/core";
import { DayReadError, type DayDocument } from "../days.js";
import { networksOf } from "../messages/networks.js";
import { FED } from "../test/fed.js";
import { buildLabels, foldProviders, type DayLabels } from "../shared/labels.js";
import { cardParts, readCard, type RecordState } from "../shared/people.js";
import { messagesFamily, type ChatDay } from "../messages/family.js";
import { dayInput } from "../test/day-input.js";
import { callsFamily } from "./family.js";
import { shuffled, TestHome } from "../test/drive.js";
import { pin } from "../test/pin.js";

const GOLDEN = new URL("./test/", import.meta.url);
const calls = callsFamily({ books: FED.labels, messages: FED.messages })(FED.calls);
const UPDATE = process.env.LIFESTREAM_UPDATE_GOLDEN === "1";
const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const MAC = "apple-calls:person-a@example.com:macbook-pro-0001";
const AIR = "apple-calls:person-a@example.com:macbook-air-aa43";
const WA_MAC = "whatsapp:15550000000:macbook-pro-0001";
const WA_PHONE = "whatsapp:15550000000:iphone-aa01";
const APPLE_EPOCH_S = 978_307_200;
const SNAPSHOT_1 = Date.UTC(2026, 8, 21);
const SNAPSHOT_2 = Date.UTC(2026, 8, 22);

const INTEGER_COLUMNS = [
  "ZANSWERED", "ZAUTOANSWEREDREASON", "ZCALLDIRECTORYIDENTITYTYPE", "ZCALL_CATEGORY", "ZCALLTYPE", "ZDISCONNECTED_CAUSE",
  "ZFACE_TIME_DATA", "ZFILTERED_OUT_REASON", "ZHANDLE_TYPE", "ZHASMESSAGE", "ZJUNKCONFIDENCE", "ZNUMBER_AVAILABILITY",
  "ZORIGINATED", "ZREAD", "ZSCREENSHARINGTYPE", "ZUSEDEMERGENCYVIDEOSTREAMING", "ZVERIFICATIONSTATUS", "ZWASEMERGENCYCALL",
  "ZCOMMUNICATIONTRUSTSCORE", "ZNEEDEDSCANNOUNCEMENT", "ZORIGINATINGUITYPE",
];
const TEXT_COLUMNS = [
  "ZADDRESS", "ZBLOCKEDBYEXTENSION", "ZBLOCKEDBYEXTENSIONNAME", "ZIDENTITYEXTENSION", "ZISO_COUNTRY_CODE",
  "ZJUNKIDENTIFICATIONCATEGORY", "ZLOCATION", "ZNAME", "ZSERVICE_PROVIDER", "ZUNIQUE_ID", "ZIMAGEURL", "ZORIGINATINGDEVICENAME",
];
const BLOB_COLUMNS = ["ZCONVERSATIONID", "ZLOCALPARTICIPANTUUID", "ZOUTGOINGLOCALPARTICIPANTUUID", "ZPARTICIPANTGROUPUUID", "ZREMINDERUUID"];

interface Synthetic {
  id: string;
  at: number;
  seconds?: number;
  outgoing?: boolean;
  answered?: boolean;
  provider?: string;
  category?: number;
  handle?: string | null;
  name?: string;
}
interface Tick { read?: number; junk?: number; conversation?: string; cause?: number }

function call(input: Synthetic, tick: Tick = {}): ReaderOutput {
  const date = input.at / 1000 - APPLE_EPOCH_S;
  const seconds = input.seconds ?? 0;
  const columns: Record<string, Json> = Object.fromEntries([...INTEGER_COLUMNS, ...TEXT_COLUMNS, ...BLOB_COLUMNS].map((column) => [column, null]));
  Object.assign(columns, {
    ZUNIQUE_ID: input.id, ZDATE: date, ZDURATION: seconds, ZORIGINATED: input.outgoing === true ? 1 : 0,
    ZANSWERED: input.answered === true ? 1 : 0, ZSERVICE_PROVIDER: input.provider ?? "com.apple.Telephony",
    ZCALL_CATEGORY: input.category ?? 1, ZCALLTYPE: 1, ZNAME: input.name ?? null, ZREAD: tick.read ?? 1,
    ZJUNKCONFIDENCE: tick.junk ?? 0, ZDISCONNECTED_CAUSE: tick.cause ?? 0, ZISO_COUNTRY_CODE: "us",
    ZCONVERSATIONID: tick.conversation === undefined ? null : { $bytes64: tick.conversation },
  });
  const value = input.handle === undefined ? "+15550000001" : input.handle;
  const handle = value === null ? null : { ZTYPE: value.includes("@") ? 3 : 2, ZNORMALIZEDVALUE: value, ZVALUE: value };
  const start = instant(date, "apple-s");
  return {
    kind: "call", key: input.id,
    time: seconds > 0 ? span(start, instant(date + seconds, "apple-s")) : start,
    content: { type: "apple.call", call: columns, initiator: input.outgoing === true ? null : handle, handles: handle === null ? [] : [handle], emergency_media: [] },
  };
}

const at = (iso: string) => Date.parse(iso);
const CALLS: Synthetic[] = [
  { id: "CALL-0001", at: at("2026-09-20T14:05:00Z"), seconds: 185, outgoing: true },
  { id: "CALL-0002", at: at("2026-09-20T15:30:00Z"), handle: "+15550000002" },
  { id: "CALL-0003", at: at("2026-09-20T17:00:00Z"), seconds: 42, answered: true, provider: "com.apple.FaceTime", category: 2, handle: "person-a@example.com" },
  { id: "CALL-0004", at: at("2026-09-20T18:10:00Z"), outgoing: true, handle: "+15550000009", name: "Synthetic Clinic" },
  { id: "CALL-0005", at: at("2026-09-20T20:00:00Z"), handle: null },
  { id: "CALL-0006", at: at("2026-09-21T07:50:00Z"), seconds: 30 * 60, answered: true, handle: "+15550000002" },
];

const person = (slug: string, name: string, phone: string): RecordState => ({
  record: {
    slug, name, full_name: null, show: "name", entity: "person", relationship: null, hidden: false, me: false,
    anchor: { kind: "phone", value: phone }, handles: [], excluded: [], dismissed: [], merged_into: null, also_called: [],
  },
  since: new Map(), me_since: null, merged_since: null,
});

interface Shell { source: string; account: string; kind: string; key: string; stated_ms: number; content: Json }

const WHATSAPP = FED.messages.find((each) => each.product === "whatsapp")!.adapter;

function whatsappNames(shells: readonly Shell[]): [string, ReturnType<typeof foldProviders>][] {
  const said = shells.map(({ source, account, kind, key, stated_ms, content }) => ({
    source, kind, key, stated_ms,
    said: WHATSAPP.label!({ source: { id: source, product: "whatsapp", account, copy: sourceName(source).copy } as SourceRow, version: { kind, key, content } as Version })!,
  }));
  return [["whatsapp", foldProviders(said, new Set(shells.flatMap(({ account }) => WHATSAPP.self!(account) ?? [])))]];
}

function labels(personA = "Person A", providers?: Shell[]): DayLabels {
  const card = readCard({ source: "apple-contacts:local:iphone-aa01", key: "card-a" }, 0,
    cardParts({ type: "contacts.card", card: `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${personA}\r\nTEL;TYPE=CELL:+1 (555) 000-0001\r\nEMAIL:person-a@example.com\r\nEND:VCARD\r\n` })!);
  return buildLabels({
    people: [person("person-b", "Person B", "+15550000002")],
    contacts: [card],
    places: [],
    ...(providers === undefined ? {} : { providers: whatsappNames(providers), networks: networksOf(FED.messages) }),
  });
}

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.close();
});

function newHome(whatsapp = false): TestHome {
  const home = new TestHome("families-calls-", { families: [calls], settings: SETTINGS });
  home.addSource(MAC, "callhistory-mac");
  home.addSource(AIR, "callhistory-mac");
  if (whatsapp) for (const source of [WA_MAC, WA_PHONE]) home.addSource(source, "whatsapp-db");
  homes.push(home);
  return home;
}

function golden(name: string, text: string): void {
  const path = new URL(name, GOLDEN);
  if (UPDATE) writeFileSync(path, text);
  expect(existsSync(path), `${path.pathname} is missing; run with LIFESTREAM_UPDATE_GOLDEN=1`).toBe(true);
  expect(text).toBe(readFileSync(path, "utf8"));
}

describe("calls family: what must be impossible", () => {
  it("an extract is written when only an unread field ticked (ZREAD, ZJUNKCONFIDENCE, conversation ids)", () => {
    const home = newHome();
    const first = home.deliver(MAC, SNAPSHOT_1, CALLS.map((input) => call(input, { read: 0 })));
    expect(first.written.length).toBe(CALLS.length);
    const before = home.extracts("calls");
    const ticked = home.deliver(MAC, SNAPSHOT_2, CALLS.map((input) => call(input, { read: 1, junk: 2, conversation: "AAAAAAAAAAAAAAAAAAAAAA==", cause: 3 })));
    expect(ticked.landed.changed).toBe(CALLS.length);
    expect(Object.keys(ticked.landed.changedPaths).sort()).toEqual([
      "call.ZCONVERSATIONID", "call.ZDISCONNECTED_CAUSE", "call.ZJUNKCONFIDENCE", "call.ZREAD",
    ]);
    expect(ticked.touched.length).toBe(CALLS.length);
    expect(ticked.written).toEqual([]);
    expect(ticked.days).toEqual([]);
    expect(home.extracts("calls")).toEqual(before);
    home.artifact("unread-ticks.json", { changedPaths: ticked.landed.changedPaths, touched: ticked.touched, written: ticked.written });
  });

  it("units differ when the same data arrives in another order", () => {
    const deliveries = [
      [MAC, SNAPSHOT_1, CALLS.slice(0, 4).map((input) => call(input, { read: 0 }))],
      [AIR, SNAPSHOT_1, CALLS.slice(2).map((input) => call(input, { junk: 1 }))],
      [MAC, SNAPSHOT_2, CALLS.map((input) => call(input))],
    ] as const;
    const results = [[0, 1, 2], [2, 1, 0], [1, 2, 0]].map((order, index) => {
      const home = newHome();
      for (const position of order) {
        const [source, stated, rows] = deliveries[position]!;
        home.deliver(source, stated, shuffled(rows, index * 10 + position));
      }
      return { extracts: home.extracts("calls").map(({ unit, reading, content, days }) => ({ unit, reading, content, days })), home };
    });
    expect(results[1]!.extracts).toEqual(results[0]!.extracts);
    expect(results[2]!.extracts).toEqual(results[0]!.extracts);
    expect(results[0]!.extracts.map((row) => row.unit)).toEqual(CALLS.map((input) => `apple:${input.id}`));
    expect(results[0]!.extracts.map((row) => (row.content as { source: string }).source)).toEqual([MAC, MAC, AIR, AIR, AIR, AIR]);
    results[0]!.home.artifact("order.json", results[0]!.extracts as unknown as Json);
  });

  it("a renamed contact rewrites an extract", () => {
    const home = newHome();
    home.deliver(MAC, SNAPSHOT_1, CALLS.map((input) => call(input)));
    const before = home.extracts("calls");
    const day = home.render("2026-09-20", labels());
    expect(day.txt.split("\n").slice(3, 9)).toEqual([
      "10:05–10:08 Phone call with Person A, the user called, 3 min",
      "11:30 Missed phone call from Person B",
      "13:00 FaceTime video call with Person A, they called, 42 s",
      "14:10 Phone call to Synthetic Clinic, no answer",
      "16:00 Missed phone call from an unknown number",
      "2026-09-21 03:50–04:00 Phone call with Person B, they called, 30 min (continues into 21 Sep)",
    ]);
    golden("2026-09-20.day.txt", day.txt);
    const renamed = home.render("2026-09-20", labels("Person Renamed"));
    expect(renamed.txt).toBe(day.txt.replaceAll("Person A", "Person Renamed"));
    expect(renamed.inputs).not.toBe(day.inputs);
    expect(home.extracts("calls")).toEqual(before);
    const bare = home.render("2026-09-20", buildLabels({ people: [], contacts: [], places: [] })).txt;
    expect(bare).toContain("Phone call with +15550000001, the user called, 3 min");
    expect(bare).toContain("Phone call to Synthetic Clinic, no answer");
    home.artifact("renamed.json", { before: day.txt, after: renamed.txt, bare });
    pin(calls, { calls: FED.calls, messages: FED.messages }, home.extracts("calls"));
  });

  it("an adapter's service words changed keep every extract's change key and the day's inputs, though the day's words differ", () => {
    const home = newHome();
    home.deliver(MAC, SNAPSHOT_1, CALLS.map((input) => call(input)));
    const reworded = callsFamily({ books: FED.labels, messages: FED.messages })(FED.calls.map((given) => given.product !== "apple-calls" ? given : {
      ...given, adapter: { ...given.adapter, services: Object.fromEntries(Object.entries(given.adapter.services).map(([service, words]) => [service, `${words} (reworded)`])) },
    }));
    const day = home.render("2026-09-20", labels());
    const after = home.render("2026-09-20", labels(), undefined, [reworded]);
    expect(after.txt).not.toBe(day.txt);
    expect(after.inputs).not.toBe(day.inputs);
    const stored = home.extracts("calls");
    const kept = home.read((view) => stored.filter((row) => {
      const built = reworded.extract(row.unit, view, home.blobs)!;
      return built.reading === row.reading && reworded.code === row.code;
    }).map((row) => row.unit));
    expect(kept).toEqual([]);
    home.artifact("reworded.json", { before: day.txt, after: after.txt, code: [calls.code, reworded.code] });
  });

  it("a call from another number of You names the owner by name, or names anyone but the user", () => {
    const home = newHome();
    home.deliver(MAC, SNAPSHOT_1, [call({ id: "CALL-0101", at: at("2026-09-20T16:00:00Z"), handle: "+15550000011" })]);
    const you = (me: boolean): DayLabels => buildLabels({
      people: [person("person-b", "Person B", "+15550000002"), { ...person("sam", "Sam", "+15550000011"), record: { ...person("sam", "Sam", "+15550000011").record, me } }],
      places: [],
    });
    const line = (labels: DayLabels) => (JSON.parse(home.render("2026-09-20", labels).json) as DayDocument).atoms.find((atom) => atom.family === "calls")?.text;
    const before = line(you(false));
    const after = line(you(true));
    expect(before).toBe("Missed phone call from Sam");
    expect(after).toBe("Missed phone call from the user");
    home.artifact("you.json", { before, after });
  });

  it("renderDay reads outside days()", () => {
    const home = newHome();
    home.deliver(MAC, SNAPSHOT_1, CALLS.map((input) => call(input)));
    const extracts = home.extracts("calls");
    const crossing = extracts.find((row) => row.unit === "apple:CALL-0006")!;
    expect(crossing.days).toEqual(["2026-09-20", "2026-09-21"]);
    const seen = new Map<string, string[]>();
    for (let day = "2026-09-19"; day <= "2026-09-22"; day = addDays(day, 1)) {
      const document = JSON.parse(home.render(day, labels()).json) as DayDocument;
      for (const atom of document.atoms) {
        expect(atom.units).toHaveLength(1);
        expect(extracts.find((row) => row.unit === atom.unit)!.days).toContain(day);
        seen.set(atom.unit, [...seen.get(atom.unit) ?? [], day]);
      }
    }
    expect(Object.fromEntries(seen)).toEqual(Object.fromEntries(extracts.map((row) => [row.unit, row.days])));
    expect(civilDay(crossing.start_ms!, SETTINGS)).toBe("2026-09-20");
    const stray = extracts.find((row) => row.unit === "apple:CALL-0001")!;
    expect(() => home.render("2026-09-22", labels(), (reader) => ({ ...reader, extractsOn: () => [stray] }))).toThrow(DayReadError);
    home.artifact("days.json", Object.fromEntries(seen));
  });
});


interface WhatsAppSynthetic {
  id: string;
  at: number;
  seconds?: number;
  incoming?: boolean;
  missed?: boolean;
  video?: boolean;
  with?: (string | null)[];
  group?: string;
}
interface WhatsAppTick { bytes?: number; outcome?: number; reason?: number; token?: string; lightweight?: number }

function whatsappCall(input: WhatsAppSynthetic, tick: WhatsAppTick = {}): ReaderOutput {
  const date = input.at / 1000 - APPLE_EPOCH_S;
  const participants = (input.with ?? ["15550000001@s.whatsapp.net"])
    .map((jid) => ({ ZOUTCOME: tick.outcome ?? 1, ZJIDSTRING: jid }))
    .sort((left, right) => String(left.ZJIDSTRING).localeCompare(String(right.ZJIDSTRING)));
  return {
    kind: "call", key: input.id, time: instant(date, "apple-s"),
    content: {
      type: "whatsapp.call",
      call: {
        ZBYTESRECEIVED: tick.bytes ?? 0, ZBYTESSENT: tick.bytes ?? 0, ZISBOTGROUPCALL: 0, ZISLIGHTWEIGHT: tick.lightweight ?? 0,
        ZOUTCOME: tick.outcome ?? 1, ZDATE: date, ZDURATION: input.seconds ?? 0, ZCALLIDSTRING: input.id,
        ZGROUPCALLCREATORUSERJIDSTRING: null, ZGROUPJIDSTRING: input.group ?? null, ZREMINDERID: null, ZSCHEDULEDID: null,
      },
      aggregate: {
        ZINCOMING: input.incoming === true ? 1 : 0, ZMISSED: input.missed === true ? 1 : 0, ZMISSEDREASON: tick.reason ?? 0,
        ZVIDEO: input.video === true ? 1 : 0, ZFIRSTDATE: date, ZLINKTOKEN: tick.token ?? null,
      },
      participants,
    },
  };
}

const GROUP = "120363000000000001@g.us";
const SHELLS: Shell[] = [
  {
    source: WA_MAC, account: "15550000000", kind: "chat", key: "99990000002@lid", stated_ms: SNAPSHOT_1,
    content: { type: "whatsapp.chat", chat: { ZCONTACTJID: "15550000002@s.whatsapp.net", ZCONTACTIDENTIFIER: "99990000002@lid", ZPARTNERNAME: "Partner Shell" }, group_info: null },
  },
  { source: WA_MAC, account: "15550000000", kind: "chat", key: GROUP, stated_ms: SNAPSHOT_1, content: { type: "whatsapp.chat", chat: { ZCONTACTJID: GROUP, ZPARTNERNAME: "Group Alpha" }, group_info: null } },
];

const WHATSAPP_CALLS: WhatsAppSynthetic[] = [
  { id: "WA00000000000000000000000000000001", at: at("2026-09-20T14:20:00Z"), seconds: 185 },
  { id: "WA00000000000000000000000000000002", at: at("2026-09-20T15:40:00Z"), incoming: true, missed: true, with: ["99990000002@lid"] },
  { id: "WA00000000000000000000000000000003", at: at("2026-09-20T16:10:00Z"), incoming: true, video: true, with: ["15550000001@s.whatsapp.net"] },
  { id: "WA00000000000000000000000000000004", at: at("2026-09-20T17:30:00Z"), seconds: 42, video: true, with: ["15550000007@s.whatsapp.net"] },
  { id: "WA00000000000000000000000000000005", at: at("2026-09-20T19:00:00Z"), seconds: 1_500, incoming: true, group: GROUP, with: ["15550000001@s.whatsapp.net", "99990000002@lid"] },
];

describe("calls family: what must be impossible for WhatsApp calls", () => {
  it("a WhatsApp call record in a day prints no call line", () => {
    const home = newHome(true);
    home.deliver(MAC, SNAPSHOT_1, CALLS.slice(0, 2).map((input) => call(input)));
    const delivered = home.deliver(WA_MAC, SNAPSHOT_1, WHATSAPP_CALLS.map((input) => whatsappCall(input)));
    expect(delivered.written).toEqual(WHATSAPP_CALLS.map((input) => `calls whatsapp:${input.id}`));
    const day = home.render("2026-09-20", labels("Person A", SHELLS));
    expect(day.txt.split("\n").slice(3, 10)).toEqual([
      "10:05–10:08 Phone call with Person A, the user called, 3 min",
      "10:20–10:23 WhatsApp voice call with Person A, the user called, 3 min",
      "11:30 Missed phone call from Person B",
      "11:40 Missed WhatsApp voice call from Person B",
      "12:10 WhatsApp video call from Person A, not answered",
      "13:30 WhatsApp video call with unknown …00007, the user called, 42 s",
      "15:00–15:25 WhatsApp voice call with Person A, Person B in Group Alpha, they called, 25 min",
    ]);
    const document = JSON.parse(day.json) as DayDocument;
    expect(document.atoms.filter((atom) => atom.record?.source === WA_MAC).map((atom) => atom.record)).toEqual(
      WHATSAPP_CALLS.map((input) => ({ source: WA_MAC, kind: "call", key: input.id })),
    );
    golden("2026-09-20.whatsapp.day.txt", day.txt);
    home.artifact("whatsapp-day.json", { txt: day.txt, atoms: document.atoms });
  });

  it("a call's chat is not the one its messages state: a phone JID the labels pair with a LID stated as itself, or a group call's chat missing", () => {
    const home = newHome(true);
    const phoneJid = { id: "WA00000000000000000000000000000006", at: at("2026-09-20T20:00:00Z"), seconds: 60, with: ["15550000002@s.whatsapp.net"] };
    home.deliver(WA_MAC, SNAPSHOT_1, [...WHATSAPP_CALLS, phoneJid].map((input) => whatsappCall(input)));
    const named = labels("Person A", SHELLS);
    const document = JSON.parse(home.render("2026-09-20", named).json) as DayDocument;
    const chats = Object.fromEntries(document.facts.filter((fact) => fact.of === "calls").map((fact) => [fact.from.units[0], fact.keys["chat"]]));
    const messages = messagesFamily({ books: FED.labels })(FED.messages);
    const said = (chat: string) => {
      const content: ChatDay = { network: "whatsapp", chat, day: "2026-09-20", messages: [{ source: WA_MAC, key: `${chat}:M1`, at: at("2026-09-20T20:01:00Z"), from: { id: "me", kind: "me" }, text: "Synthetic hello" }] };
      const input = dayInput(messages, "2026-09-20", [{ unit: `2026-09-20:whatsapp:${chat}`, content, start_ms: at("2026-09-20T20:01:00Z"), end_ms: at("2026-09-20T20:01:00Z") }], SETTINGS, { labels: named });
      return messages.day(input).facts[0]!.keys["chat"];
    };
    expect(said("15550000002@s.whatsapp.net")).toBe("whatsapp:99990000002@lid");
    expect(chats).toEqual({
      "whatsapp:WA00000000000000000000000000000001": said("15550000001@s.whatsapp.net"),
      "whatsapp:WA00000000000000000000000000000002": said("99990000002@lid"),
      "whatsapp:WA00000000000000000000000000000003": said("15550000001@s.whatsapp.net"),
      "whatsapp:WA00000000000000000000000000000004": said("15550000007@s.whatsapp.net"),
      "whatsapp:WA00000000000000000000000000000005": said(GROUP),
      "whatsapp:WA00000000000000000000000000000006": said("15550000002@s.whatsapp.net"),
    });
    home.artifact("whatsapp-chats.json", chats);
  });

  it("a call's search text misses the other party or the name its provider showed, or a call that names nobody has one", () => {
    const home = newHome(true);
    home.deliver(MAC, SNAPSHOT_1, CALLS.map((input) => call(input)));
    home.deliver(WA_MAC, SNAPSHOT_1, WHATSAPP_CALLS.map((input) => whatsappCall(input)));
    const party = (id: string, ...who: string[]) => ({ title: id, text: "", who: [id, ...who] });
    const a = ["15550000001@s.whatsapp.net", "+15550000001"];
    expect(Object.fromEntries(home.texts(calls).map(({ record, text }) => [record, text]))).toEqual({
      [`${MAC} call CALL-0001`]: party("+15550000001"),
      [`${MAC} call CALL-0002`]: party("+15550000002"),
      [`${MAC} call CALL-0003`]: party("person-a@example.com"),
      [`${MAC} call CALL-0004`]: { title: "Synthetic Clinic", text: "", who: ["+15550000009"] },
      [`${MAC} call CALL-0005`]: null,
      [`${MAC} call CALL-0006`]: party("+15550000002"),
      [`${WA_MAC} call WA00000000000000000000000000000001`]: party("15550000001@s.whatsapp.net", "+15550000001"),
      [`${WA_MAC} call WA00000000000000000000000000000002`]: party("99990000002@lid"),
      [`${WA_MAC} call WA00000000000000000000000000000003`]: party("15550000001@s.whatsapp.net", "+15550000001"),
      [`${WA_MAC} call WA00000000000000000000000000000004`]: party("15550000007@s.whatsapp.net", "+15550000007"),
      [`${WA_MAC} call WA00000000000000000000000000000005`]: { title: "15550000001@s.whatsapp.net, 99990000002@lid", text: "", who: [...a, "99990000002@lid"] },
    });
    home.artifact("texts.json", home.texts(calls));
  });

  it("the line's words and name differ from an Apple call's for the same person, direction and outcome", () => {
    const home = newHome(true);
    const pairs: [Synthetic, WhatsAppSynthetic][] = [
      [{ id: "CALL-0101", at: at("2026-09-20T14:00:00Z"), seconds: 185, outgoing: true }, { id: "WA01", at: at("2026-09-20T14:30:00Z"), seconds: 185 }],
      [{ id: "CALL-0102", at: at("2026-09-20T15:00:00Z"), handle: "+15550000002" }, { id: "WA02", at: at("2026-09-20T15:30:00Z"), incoming: true, missed: true, with: ["99990000002@lid"] }],
      [{ id: "CALL-0103", at: at("2026-09-20T16:00:00Z"), outgoing: true }, { id: "WA03", at: at("2026-09-20T16:30:00Z") }],
      [{ id: "CALL-0104", at: at("2026-09-20T17:00:00Z"), seconds: 3_900, answered: true, handle: "+15550000002" }, { id: "WA04", at: at("2026-09-20T17:30:00Z"), seconds: 3_900, incoming: true, with: ["15550000002@s.whatsapp.net"] }],
    ];
    home.deliver(MAC, SNAPSHOT_1, pairs.map(([apple]) => call(apple)));
    home.deliver(WA_MAC, SNAPSHOT_1, pairs.map(([, whatsapp]) => whatsappCall(whatsapp)));
    const atoms = (JSON.parse(home.render("2026-09-20", labels("Person A", SHELLS)).json) as DayDocument).atoms;
    const text = (key: string) => atoms.find((atom) => atom.record?.key === key)!.text;
    const compared = pairs.map(([apple, whatsapp]) => ({ apple: text(apple.id), whatsapp: text(whatsapp.id) }));
    for (const { apple, whatsapp } of compared) {
      expect(whatsapp).toBe(apple.replace("Phone call", "WhatsApp voice call").replace("phone call", "WhatsApp voice call"));
    }
    expect(compared.map((pair) => pair.whatsapp)).toEqual([
      "WhatsApp voice call with Person A, the user called, 3 min",
      "Missed WhatsApp voice call from Person B",
      "WhatsApp voice call to Person A, no answer",
      "WhatsApp voice call with Person B, they called, 1 h 5 min",
    ]);
    home.artifact("words.json", compared);
  });

  it("a call answered on another device prints as not answered, or one WhatsApp states missed prints as answered", () => {
    const home = newHome(true);
    const elsewhere = { id: "WA00000000000000000000000000000007", at: at("2026-09-20T16:10:00Z"), incoming: true };
    const missed = { id: "WA00000000000000000000000000000008", at: at("2026-09-20T16:40:00Z"), incoming: true, missed: true };
    home.deliver(WA_MAC, SNAPSHOT_1, [elsewhere, missed].map((input) => whatsappCall(input, { outcome: 5 })));
    const day = home.render("2026-09-20", labels("Person A", SHELLS));
    expect(day.txt.split("\n").slice(3, 5)).toEqual([
      "12:10 WhatsApp voice call with Person A, they called, answered",
      "12:40 Missed WhatsApp voice call from Person A",
    ]);
  });

  it("one call on two WhatsApp replicas prints twice", () => {
    const rows = (tick: WhatsAppTick) => WHATSAPP_CALLS.map((input) => whatsappCall(input, tick));
    const results = [[WA_MAC, WA_PHONE], [WA_PHONE, WA_MAC]].map((order) => {
      const home = newHome(true);
      for (const [index, source] of order.entries()) home.deliver(source!, SNAPSHOT_1 + index, rows({ bytes: index }));
      const day = home.render("2026-09-20", labels("Person A", SHELLS));
      return { home, txt: day.txt, extracts: home.extracts("calls").map(({ unit, reading, content }) => ({ unit, reading, content })) };
    });
    expect(results[1]!.extracts).toEqual(results[0]!.extracts);
    expect(results[1]!.txt).toBe(results[0]!.txt);
    expect(results[0]!.extracts.map((row) => row.unit)).toEqual(WHATSAPP_CALLS.map((input) => `whatsapp:${input.id}`));
    expect(results[0]!.extracts.map((row) => (row.content as { source: string }).source)).toEqual(WHATSAPP_CALLS.map(() => WA_PHONE));
    expect(results[0]!.txt.split("\n")[1]).toBe(`${WHATSAPP_CALLS.length} atoms: calls ${WHATSAPP_CALLS.length}`);
    results[0]!.home.artifact("whatsapp-replicas.json", { txt: results[0]!.txt, extracts: results[0]!.extracts });
  });

  it("a restatement ticking only a non-printed field re-renders the day", () => {
    const home = newHome(true);
    home.deliver(WA_MAC, SNAPSHOT_1, WHATSAPP_CALLS.map((input) => whatsappCall(input)));
    const before = home.extracts("calls");
    const ticked = home.deliver(WA_MAC, SNAPSHOT_2, WHATSAPP_CALLS.map((input) => whatsappCall(input, { bytes: 4_096, outcome: 3, reason: 2, token: "synthetic-token", lightweight: 1 })));
    expect(ticked.landed.changed).toBe(WHATSAPP_CALLS.length);
    expect(Object.keys(ticked.landed.changedPaths).sort()).toEqual([
      "aggregate.ZLINKTOKEN", "aggregate.ZMISSEDREASON", "call.ZBYTESRECEIVED", "call.ZBYTESSENT", "call.ZISLIGHTWEIGHT", "call.ZOUTCOME",
      "participants[].ZOUTCOME",
    ]);
    expect(ticked.touched.length).toBe(WHATSAPP_CALLS.length);
    expect(ticked.written).toEqual([]);
    expect(ticked.days).toEqual([]);
    expect(home.extracts("calls")).toEqual(before);
    home.artifact("whatsapp-ticks.json", { changedPaths: ticked.landed.changedPaths, touched: ticked.touched, written: ticked.written });
  });

  it("read of a call record keeps the raw handle and call details in text even when a caller-ID name titles it", () => {
    const home = newHome(true);
    const caller = { id: "CALL-READ-1", at: at("2026-09-20T19:00:00Z"), seconds: 280, answered: true, handle: "+15550000099", name: "Synthetic Caller" };
    home.deliver(MAC, SNAPSHOT_1, [...CALLS, caller].map((input) => call(input)));
    home.deliver(WA_MAC, SNAPSHOT_1, [whatsappCall(WHATSAPP_CALLS[0]!)]);
    const opened = (source: string, key: string) => home.read((view) => {
      const head = view.head({ source, kind: "call", key })!;
      return calls.read!.of({ source, kind: "call", key }, view.version(head.version), undefined as never, view);
    });
    expect(opened(MAC, "CALL-READ-1")).toEqual({
      title: "Synthetic Caller",
      from: "+15550000099",
      text: "Phone call with +15550000099, they called, 5 min",
    });
    expect(opened(MAC, "CALL-0004")).toEqual({
      title: "Synthetic Clinic",
      from: null,
      to: ["+15550000009"],
      text: "Phone call to +15550000009, no answer",
    });
    expect(opened(MAC, "CALL-0003")).toEqual({
      title: "person-a@example.com",
      from: "person-a@example.com",
      text: "FaceTime video call with person-a@example.com, they called, 42 s",
    });
    expect(opened(MAC, "CALL-0005")).toEqual({
      text: "Missed phone call from an unknown number",
    });
    expect(opened(WA_MAC, WHATSAPP_CALLS[0]!.id)).toEqual({
      title: "15550000001@s.whatsapp.net",
      from: null,
      to: ["15550000001@s.whatsapp.net", "+15550000001"],
      text: "WhatsApp voice call with +15550000001, the user called, 3 min",
    });
  });
});
