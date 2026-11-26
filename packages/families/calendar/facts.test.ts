import { describe, expect, it } from "vitest";
import type { DaySettings, SourceRow } from "@lifestreamprotocol/core";
import { dayFacts } from "../days.js";
import { collectionsFault } from "../family.js";
import { callaudioFamily } from "../callaudio/family.js";
import { callsFamily } from "../calls/family.js";
import { notesFamily } from "../notes/family.js";
import { FED } from "../test/fed.js";
import { factsConform, insertKeepsFacts } from "../test/facts.js";
import { dayInput, type Content } from "../test/day-input.js";
import { calendarFamily, type CalendarEvent } from "./family.js";

const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const CALENDAR = calendarFamily({ books: FED.labels })(FED.calendar);
const OWNER = "person-a@example.com";
const SOURCE = `google-calendar:${OWNER}:macbook-pro-0001`;
const OTHER = `apple-calendar:${OWNER}:macbook-pro-0001`;
const SOURCES = new Map<string, SourceRow>([[SOURCE, {
  id: SOURCE, product: "google-calendar", vendor: "google", account: OWNER, copy: "macbook-pro-0001", connector: "google-calendar", options: {}, read_through_ms: null, added_ms: 0,
}]]);
const at = (local: string) => Date.parse(`${local}-04:00`);

function event(name: string, said: Partial<CalendarEvent> & Pick<CalendarEvent, "start_ms" | "end_ms">): Content {
  const content: CalendarEvent = {
    source: SOURCE, key: name, title: name, date_only: false, zone: "America/New_York", status: "CONFIRMED", organizer: null, attendees: 0,
    response: null, video: false, location: null, repeats: null, ...said,
  };
  return { unit: `${OWNER}/${name}`, content, start_ms: content.start_ms, end_ms: content.end_ms };
}

const RECORD: Content[] = [
  event("late", { start_ms: at("2026-10-25T03:30"), end_ms: at("2026-10-25T04:30") }),
  event("standup", {
    start_ms: at("2026-10-25T09:00"), end_ms: at("2026-10-25T09:30"), organizer: { address: "person-b@example.com", name: "B" }, attendees: 3, response: "ACCEPTED",
  }),
  event("mine", { start_ms: at("2026-10-25T12:00"), end_ms: at("2026-10-25T13:00"), organizer: { address: OWNER, name: null }, status: "CANCELLED" }),
  event("holiday", { start_ms: Date.UTC(2026, 9, 25), end_ms: Date.UTC(2026, 9, 26), date_only: true, zone: null }),
];
const input = (day: string, contents: readonly Content[] = RECORD) => dayInput(CALENDAR, day, contents, SETTINGS, { sources: SOURCES });
const fact = (day: string, name: string, contents?: readonly Content[]) => CALENDAR.day(input(day, contents)).facts.find((each) => each.from.units.includes(`${OWNER}/${name}`))!;

describe("calendar facts", () => {
  it("events.minutes and meetings.minutes are two readings of one length, each naming the other", () => {
    expect(collectionsFault([CALENDAR])).toEqual(["events.minutes names meetings.minutes, which no family declares"]);
    expect(collectionsFault([CALENDAR, notesFamily(FED.notes)])).toEqual(["meetings.minutes names callaudio.minutes, which no family declares"]);
    const calls = callsFamily({ books: FED.labels, messages: FED.messages })(FED.calls);
    const callaudio = callaudioFamily({ books: FED.labels, zone: SETTINGS.zone, calls: FED.calls })(FED.callaudio);
    expect(collectionsFault([CALENDAR, notesFamily(FED.notes), calls, callaudio])).toEqual([]);
  });

  it("an event is one whichever copy is shown: its id is its unit", () => {
    const moved = event("standup", { source: OTHER, start_ms: at("2026-10-25T09:00"), end_ms: at("2026-10-25T09:30"), title: "Standup (moved)" });
    expect(fact("2026-10-25", "standup", [moved]).id).toBe(fact("2026-10-25", "standup").id);
  });

  it("an event across the day's edge is one fact, whole, on the day it began; an all-day event is its date, with no minutes", () => {
    const whole = fact("2026-10-24", "late");
    expect([whole.measures, whole.time_ms]).toEqual([{ minutes: 60 }, at("2026-10-25T03:30")]);
    const stated = (day: string) => dayFacts(CALENDAR, CALENDAR.day(input(day)), day, SETTINGS, (line) => line).filter((each) => each.id === whole.id);
    expect(stated("2026-10-24").map((each) => [each.measures, each.start_ms, each.end_ms, "part" in each])).toEqual([[{ minutes: 60 }, at("2026-10-25T03:30"), at("2026-10-25T04:30"), false]]);
    expect(stated("2026-10-25")).toEqual([]);
    const holiday = fact("2026-10-25", "holiday");
    expect([holiday.date_only, holiday.time_ms, holiday.measures]).toEqual([true, Date.UTC(2026, 9, 25), {}]);
  });

  it("its keys are the record's own words, its organiser a raw handle unless it is the account", () => {
    const standup = fact("2026-10-25", "standup");
    expect(standup.keys).toEqual({ title: "standup", response: "ACCEPTED", status: "CONFIRMED" });
    expect(standup.who).toEqual([{ handle: "email:person-b@example.com", role: "attendee" }]);
    const mine = fact("2026-10-25", "mine");
    expect([mine.keys["status"], mine.who]).toEqual(["CANCELLED", []]);
  });

  it("holds to F1's conformance: order, one day's statement and an inserted line", () => {
    expect(factsConform(CALENDAR, ["2026-10-24", "2026-10-25"].map((day) => input(day)))).toEqual([]);
    const earlier = event("breakfast", { start_ms: at("2026-10-25T08:00"), end_ms: at("2026-10-25T08:30") });
    expect(insertKeepsFacts(CALENDAR, input("2026-10-25"), input("2026-10-25", [earlier, ...RECORD]))).toEqual([]);
  });
});
