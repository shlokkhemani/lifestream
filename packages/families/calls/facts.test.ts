import { describe, expect, it } from "vitest";
import type { DaySettings } from "@lifestreamprotocol/core";
import { dayFacts } from "../days.js";
import { collectionsFault } from "../family.js";
import { FED } from "../test/fed.js";
import { factsConform, insertKeepsFacts } from "../test/facts.js";
import { dayInput, type Content } from "../test/day-input.js";
import { messagesFamily, type ChatDay } from "../messages/family.js";
import { calendarFamily } from "../calendar/family.js";
import { callaudioFamily } from "../callaudio/family.js";
import { notesFamily } from "../notes/family.js";
import { callsFamily, type Call } from "./family.js";

const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const CALLS = callsFamily({ books: FED.labels, messages: FED.messages })(FED.calls);
const SOURCE = "apple-calls:person-a@example.com:macbook-pro-0001";
const at = (local: string) => Date.parse(`${local}-04:00`);

function call(key: string, said: Omit<Call, "source">): Content {
  return { unit: `phone:${key}`, content: { source: SOURCE, ...said }, start_ms: said.start_ms, end_ms: said.end_ms ?? said.start_ms };
}

const RECORD: Content[] = [
  call("c1", { service: "phone", direction: "outgoing", outcome: "connected", start_ms: at("2026-10-25T03:40"), end_ms: at("2026-10-25T04:40"), parties: [{ id: "+15550000001", kind: "phone" }] }),
  call("c2", { service: "facetime", direction: "incoming", outcome: "missed", start_ms: at("2026-10-25T09:00"), end_ms: null, parties: [{ id: "person-b@example.com", kind: "email" }] }),
  call("c3", {
    service: "phone", direction: "outgoing", outcome: "connected", start_ms: at("2026-10-25T12:00"), end_ms: at("2026-10-25T12:30"),
    parties: [{ id: "+15550000003", kind: "phone" }, { id: "+15550000002", kind: "phone" }], group: "group-1",
  }),
];
const MESSAGES = messagesFamily({ books: FED.labels })(FED.messages);
const WA = "whatsapp:15550000000:macbook-pro-0001";
const WA_ONE = "15550000001@s.whatsapp.net";
const WA_GROUP = "120363000000000001@g.us";

function whatsappCall(key: string, said: Omit<Call, "source" | "service" | "direction" | "outcome" | "end_ms">): Content {
  const content: Call = { source: WA, service: "whatsapp-voice", direction: "incoming", outcome: "connected", end_ms: said.start_ms + 60_000, ...said };
  return { unit: `whatsapp:${key}`, content, start_ms: said.start_ms, end_ms: said.start_ms + 60_000 };
}

function message(chat: string, key: string, start_ms: number): Content {
  const content: ChatDay = { network: "whatsapp", chat, day: "2026-10-25", messages: [{ source: WA, key: `${chat}:${key}`, at: start_ms, from: { id: "me", kind: "me" }, text: "Synthetic hello" }] };
  return { unit: `2026-10-25:whatsapp:${chat}`, content, start_ms, end_ms: start_ms };
}

const input = (day: string, contents: readonly Content[] = RECORD) => dayInput(CALLS, day, contents, SETTINGS);
const stated = (day: string) => dayFacts(CALLS, CALLS.day(input(day)), day, SETTINGS, (line) => line);

describe("calls facts", () => {
  it("declares collections that hold together: calls.minutes and callaudio.minutes are two readings of one length, each naming the other", () => {
    expect(collectionsFault([CALLS])).toEqual(["calls.minutes names callaudio.minutes, which no family declares"]);
    const callaudio = callaudioFamily({ books: FED.labels, zone: SETTINGS.zone, calls: FED.calls })(FED.callaudio);
    expect(collectionsFault([CALLS, callaudio, notesFamily(FED.notes), calendarFamily({ books: FED.labels })(FED.calendar)])).toEqual([]);
  });

  it("a 60-minute call across the day's edge is one call of 60, whole, on the day it began, and no fact of the next day", () => {
    const [before] = stated("2026-10-24");
    expect(before!.measures).toEqual({ minutes: 60 });
    expect([before!.time_ms, before!.start_ms, before!.end_ms]).toEqual([at("2026-10-25T03:40"), at("2026-10-25T03:40"), at("2026-10-25T04:40")]);
    expect(before!.keys).toEqual({ service: "phone", direction: "outgoing", outcome: "connected" });
    expect("part" in before!).toBe(false);
    expect(stated("2026-10-25").some((fact) => fact.id === before!.id)).toBe(false);
    const projection = CALLS.day(input("2026-10-25"));
    expect(projection.lines.some((line) => line.start_ms === at("2026-10-25T03:40") && line.end_ms === at("2026-10-25T04:40"))).toBe(true);
  });

  it("a missed call states no minutes, never a zero", () => {
    const missed = CALLS.day(input("2026-10-25")).facts.find((fact) => fact.keys["outcome"] === "missed")!;
    expect(missed.measures).toEqual({});
    expect(missed.who).toEqual([{ handle: "email:person-b@example.com", role: "sender" }]);
  });

  it("a group call is one fact, its people raw handles with their roles", () => {
    const group = CALLS.day(input("2026-10-25")).facts.filter((fact) => fact.keys["group"] === "group-1");
    expect(group).toHaveLength(1);
    expect(group[0]!.who).toEqual([{ handle: "phone:+15550000002", role: "receiver" }, { handle: "phone:+15550000003", role: "receiver" }]);
    expect(group[0]!.measures).toEqual({ minutes: 30 });
  });

  it("a call states its chat as a messages fact of that chat does: a group call its group, a call of one other party theirs; none for several outside a group, nobody, or Apple's", () => {
    const calls = [
      whatsappCall("W1", { start_ms: at("2026-10-25T09:00"), parties: [{ id: WA_ONE, kind: "jid" }] }),
      whatsappCall("W2", { start_ms: at("2026-10-25T10:00"), parties: [{ id: WA_ONE, kind: "jid" }, { id: "15550000003@s.whatsapp.net", kind: "jid" }], group: WA_GROUP }),
      whatsappCall("W3", { start_ms: at("2026-10-25T11:00"), parties: [{ id: WA_ONE, kind: "jid" }, { id: "15550000003@s.whatsapp.net", kind: "jid" }] }),
      whatsappCall("W4", { start_ms: at("2026-10-25T12:00"), parties: [] }),
    ];
    const chats = Object.fromEntries(CALLS.day(input("2026-10-25", [...calls, ...RECORD])).facts.map((fact) => [fact.from.units[0], fact.keys["chat"]]));
    const said = Object.fromEntries(MESSAGES.day(dayInput(MESSAGES, "2026-10-25", [message(WA_ONE, "M1", at("2026-10-25T09:01")), message(WA_GROUP, "M2", at("2026-10-25T10:01"))], SETTINGS)).facts
      .map((fact) => [fact.from.record!.key.split(":")[0], fact.keys["chat"]]));
    expect(said).toEqual({ [WA_ONE]: `whatsapp:${WA_ONE}`, [WA_GROUP]: `whatsapp:${WA_GROUP}` });
    expect(chats).toEqual({
      "whatsapp:W1": said[WA_ONE], "whatsapp:W2": said[WA_GROUP], "whatsapp:W3": undefined, "whatsapp:W4": undefined,
      "phone:c1": undefined, "phone:c2": undefined, "phone:c3": undefined,
    });
  });

  it("holds to F1's conformance: order, one day's statement and an inserted line", () => {
    expect(factsConform(CALLS, ["2026-10-24", "2026-10-25"].map((day) => input(day)))).toEqual([]);
    const earlier = call("c0", { service: "phone", direction: "incoming", outcome: "connected", start_ms: at("2026-10-25T08:00"), end_ms: at("2026-10-25T08:05"), parties: [{ id: "+15550000004", kind: "phone" }] });
    expect(insertKeepsFacts(CALLS, input("2026-10-25"), input("2026-10-25", [earlier, ...RECORD]))).toEqual([]);
  });
});
