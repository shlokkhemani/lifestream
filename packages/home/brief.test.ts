import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DaySettings } from "@lifestreamprotocol/core";
import type { DayAtom, DayDocument, DayFileFact } from "@lifestreamprotocol/families";
import { BRIEF_WINDOWS, briefOf } from "./brief.js";
import { ANSWER_CHARS, type Call, type Reader } from "./call.js";
import { readAnswerOf, readRoom, readSize, type ReadSources } from "./read.js";
import { makeRef } from "./refs.js";
import { Refusal } from "./refusal.js";
import type { ScreenWindow } from "./screen-reads.js";
import { answerOf, paramsOf, readParams, type ReadAnswer } from "./search-contract.js";
import { Work } from "./work.js";

const CLOCK: DaySettings = { zone: "UTC", day_start_hour: 4 };
const NOW = Date.parse("2026-11-04T05:20:00Z");
const CHAT = "whatsapp:local:phone-0001";
const AI = "chatgpt:person-a@example.com:cloud";
const BANK = "bank:acct-0001:cloud";
const NOTES = "apple-notes:local:mac-0001";

type Brief = Extract<ReadAnswer, { what: "brief" }>;

const clockOf = (ms: number) => new Date(ms).toISOString().slice(11, 16);

function atom(n: number, family: string, text: string, from: string, more: Partial<DayAtom> & { to?: string; source?: string } = {}): DayAtom {
  const { to, source, ...rest } = more;
  const start_ms = Date.parse(from), end_ms = to === undefined ? null : Date.parse(to);
  return {
    n, family, unit: `${family}/${n}`, units: [`${family}/${n}`], start_ms, end_ms, local_start: clockOf(start_ms), local_end: end_ms === null ? null : clockOf(end_ms), flags: [], text,
    ...(source === undefined ? {} : { record: { source, kind: "item", key: `k${n}` } }), ...rest,
  };
}

const untimed = (n: number, family: string, text: string): DayAtom => ({ ...atom(n, family, text, "2026-11-03T12:00:00Z"), start_ms: null, end_ms: null, local_start: null, local_end: null });

function payment(id: string, at: string, payee: string, lines: number[]): DayFileFact {
  const start_ms = Date.parse(at);
  return {
    id: `payments:${id.padStart(24, "0")}`, family: "money", of: "payments", time_ms: start_ms, start_ms, end_ms: start_ms,
    keys: { payee, direction: "debit", currency: "EUR" }, measures: { amount: "5.00" }, who: [], from: { units: [`money/${id}`], record: { source: BANK, kind: "txn", key: id }, alone: true }, lines,
  };
}

const steps: DayFileFact = {
  id: "days:000000000000000000000001", family: "health", of: "days", time_ms: Date.parse("2026-11-03T04:00:00Z"), start_ms: Date.parse("2026-11-03T04:00:00Z"),
  end_ms: Date.parse("2026-11-03T04:00:00Z"), date_only: true, keys: { instrument: "Watch" }, measures: { steps: 9000 }, who: [], from: { units: ["health/d1"], instrument: "Watch" }, lines: [],
};

const family = (n: number, at: string) => atom(n, "messages", `Person A: synthetic line ${n}`, at, { source: CHAT, block: { key: "chat-family", title: "Family group" } });
const turn = (n: number, at: string) => atom(n, "ai", `the user: question ${n}`, at, { source: AI, block: { key: "ai-topic", title: "Assistant · Topic" } });

const DAYS = new Map<string, DayDocument>([
  ["2026-11-03", document("2026-11-03", [
    atom(1, "notes", "synthetic note in the evening", "2026-11-03T20:00:00Z", { source: NOTES }),
    family(2, "2026-11-04T01:00:00Z"),
    atom(3, "physical", "At Place A", "2026-11-04T02:00:00Z", { to: "2026-11-04T02:40:00Z" }),
    family(4, "2026-11-04T02:30:00Z"),
    atom(5, "money", "EXAMPLE SHOP 5.00", "2026-11-04T03:00:00Z", { source: BANK }),
    family(6, "2026-11-04T03:10:00Z"),
    untimed(7, "notes", "synthetic note with no time"),
    { ...untimed(8, "health", "Slept 7h"), flags: ["heading"] },
  ], [steps, payment("p1", "2026-11-04T03:00:00Z", "Example Shop", [5])])],
  ["2026-11-04", document("2026-11-04", [
    turn(1, "2026-11-04T04:30:00Z"),
    turn(2, "2026-11-04T05:10:00Z"),
    atom(3, "calendar", "Synthetic standup", "2026-11-04T06:00:00Z"),
  ], [])],
]);

function document(day: string, atoms: DayAtom[], facts: DayFileFact[]): DayDocument {
  return { day, zone: "UTC", day_start_hour: 4, inputs: `in-${day}`, atoms, facts } as unknown as DayDocument;
}

interface Screen {
  sittings: { unit: string; start_ms: number; end_ms: number; summarised: boolean }[];
  windows: ScreenWindow[];
}

function screenSources(screen: Screen): { view: unknown; source: unknown } {
  const onDay = (day: string, ms: number) => new Date(ms - 4 * 3_600_000).toISOString().slice(0, 10) === day;
  const view = {
    extractPage: (_family: string, select: { day: string }) => screen.sittings.filter((sitting) => onDay(select.day, sitting.start_ms) || onDay(select.day, sitting.end_ms))
      .map((sitting) => ({ unit: sitting.unit, start_ms: sitting.start_ms, end_ms: sitting.end_ms })),
    enrichment: (_family: string, item: string) => (screen.sittings.find((sitting) => sitting.unit === item)?.summarised === true ? { state: "done" } : undefined),
  };
  const source = {
    file: "screen-1", clock: CLOCK, as_of: null, sources: { of: (machine: string) => [`screen:local:${machine}`], machines: () => [MAC] },
    windowsIn: (machine: string, from_ms: number, to_ms: number) => screen.windows.filter((window) => window.machine === machine && window.end_ms >= from_ms && window.start_ms < to_ms)
      .map((window) => ({ ...window, start_ms: Math.max(window.start_ms, from_ms), end_ms: Math.min(window.end_ms, to_ms) })),
  };
  return { view, source };
}

function sourcesOf(reader: Reader, days: ReadonlyMap<string, DayDocument>, now_ms: number, screen?: Screen): ReadSources {
  const held = screen === undefined ? undefined : screenSources(screen);
  const call = {
    now_ms, reader, answerChars: ANSWER_CHARS[reader], meter: new Work(110_000), clock: () => CLOCK, whereIfReady: () => undefined,
    index: () => ({ clock: CLOCK, seq: 0, file: "file-1", factsBuild: "build-1", held: (from: string, to: string) => ({ from, to, days: new Map() }) }),
    fresh: () => ({ as_of: "2026-11-04T05:20+00:00", pending: [] }),
    ...(held === undefined ? {} : { view: () => held.view }),
  } as unknown as Call;
  return {
    call, freshness: () => [], dayDocument: (day: string) => days.get(day), isProduct: (product: string) => ["whatsapp", "chatgpt", "bank", "apple-notes"].includes(product),
    screenIfReady: () => held?.source,
  } as unknown as ReadSources;
}

function read(params: Record<string, string | string[]>, reader: Reader = "person", days = DAYS, now_ms = NOW, screen?: Screen): ReadAnswer {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) for (const each of [value].flat()) query.append(name, each);
  const answer = readAnswerOf(paramsOf(readParams, query), sourcesOf(reader, days, now_ms, screen));
  expect(readSize(reader)(answer)).toBeLessThanOrEqual(readRoom(reader, ANSWER_CHARS[reader]));
  return answerOf("/v1/read", 200, JSON.parse(JSON.stringify(answer))) as ReadAnswer;
}

const texts = (brief: ReadAnswer) => (brief as Brief).days.map((day) => [day.day, day.lines.map((line) => line.text)]);

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof Refusal) return `${error.code}: ${error.words}`;
    throw error;
  }
  return "answered";
};

describe("a brief's lines", () => {
  it("a chat's and a conversation's line start with the clock of their first and last line; one of a single time names it once; one with no time has none", () => {
    const day = DAYS.get("2026-11-03")!;
    expect(briefOf(day).lines.find((line) => line.part === "people")).toEqual({ part: "people", text: "01:00–03:10 Family group: 3 messages", atoms: [2, 4, 6] });
    expect(briefOf(DAYS.get("2026-11-04")!).lines.find((line) => line.part === "ai")!.text).toBe("04:30–05:10 Assistant · Topic: 2 turns");
    expect(briefOf({ ...day, atoms: [family(2, "2026-11-04T01:00:00Z")] }).lines[0]!.text).toBe("01:00 Family group: 1 message");
    expect(briefOf({ ...day, atoms: [{ ...family(2, "2026-11-04T01:00:00Z"), start_ms: null, local_start: null }], facts: [] }).lines[0]!.text).toBe("Family group: 1 message");
    expect(briefOf(day)).not.toHaveProperty("zone");
    expect(briefOf(day).lines.some((line) => "names" in line)).toBe(false);
  });
});

describe("a recorded call in a brief", () => {
  const CALL_DAY = JSON.parse(readFileSync(new URL("../families/callaudio/test/2026-10-05.day.json", import.meta.url), "utf8")) as DayDocument;

  it("a call no call record joins is a people line by its head; a joined call's head is the call record's line; no turn shows", () => {
    const lines = briefOf(CALL_DAY).lines;
    expect(lines.filter((line) => line.part === "people")).toEqual([
      { part: "people", text: "14:00–14:20 Call on Zoom, 20 min: Lease renewal. You and they went over the lease renewal; you will send the signed copy.", atoms: [1] },
      { part: "people", text: "15:59–16:10 Phone call with Person B, they called, 11 min", atoms: [8] },
    ]);
    expect(lines.flatMap((line) => line.atoms)).toEqual([1, 8]);
  });

  it("a head whose call fact is gone stays out, and the turns never fall to the rest", () => {
    const lines = briefOf({ ...CALL_DAY, facts: CALL_DAY.facts.filter((fact) => fact.of !== "callaudio") }).lines;
    expect(lines).toEqual([{ part: "people", text: "15:59–16:10 Phone call with Person B, they called, 11 min", atoms: [8] }]);
  });
});

describe("a brief of any stretch", () => {
  it("`last` across the day's start hour: both days, each cut to the stretch; a line overlapping its start kept; a day-only fact and a line with no time left out", () => {
    const brief = read({ last: "3h" }) as Brief;
    expect(brief).toMatchObject({ what: "brief", span: { from: "2026-11-04T02:20+00:00", to: "2026-11-04T05:20+00:00" }, next: null });
    expect(texts(brief)).toEqual([
      ["2026-11-03", ["02:00–02:40 At Place A", "02:30–03:10 Family group: 2 messages", "payment: Example Shop debit amount 5.00 EUR"]],
      ["2026-11-04", ["04:30–05:10 Assistant · Topic: 2 turns"]],
    ]);
  });

  it("from and to inside a day read as a brief; the whole day keeps what has no time and what is dated to it", () => {
    expect(texts(read({ from: "2026-11-04T00:00:00Z", to: "2026-11-04T02:10:00Z", detail: "brief" }))).toEqual([
      ["2026-11-03", ["02:00–02:40 At Place A", "01:00 Family group: 1 message"]],
    ]);
    const whole = texts(read({ from: "2026-11-03", to: "2026-11-03", detail: "brief" }))[0]![1] as string[];
    expect(whole).toEqual(expect.arrayContaining(["01:00–03:10 Family group: 3 messages", "the day: steps 9000 (instrument Watch)", "notes: 2 lines"]));
  });

  it("a stretch that holds a whole day and part of the next: the whole day keeps its dated fact, the part does not", () => {
    const lines = texts(read({ from: "2026-11-03", to: "2026-11-04T05:00:00Z", detail: "brief" }));
    expect(lines[0]![1]).toContain("the day: steps 9000 (instrument Watch)");
    expect(lines[1]).toEqual(["2026-11-04", ["04:30 Assistant · Topic: 1 turn"]]);
  });

  it("`products` keeps the lines of the products named, by their accounts or their record's source; `families` and `products` together keep both rules", () => {
    expect(texts(read({ last: "3h", products: "whatsapp" }))).toEqual([["2026-11-03", ["02:30–03:10 Family group: 2 messages"]], ["2026-11-04", []]]);
    expect(texts(read({ last: "3h", products: ["bank", "chatgpt"] }))).toEqual([
      ["2026-11-03", ["payment: Example Shop debit amount 5.00 EUR"]], ["2026-11-04", ["04:30–05:10 Assistant · Topic: 2 turns"]],
    ]);
    const accounts = new Map([["2026-11-03", document("2026-11-03", [{ ...atom(1, "messages", "Person A: hi", "2026-11-04T03:00:00Z", { block: { key: "c", title: "Chat" } }), accounts: ["whatsapp:local"] }], [])]]);
    expect(texts(read({ last: "3h", products: "whatsapp" }, "person", accounts))[0]).toEqual(["2026-11-03", ["03:00 Chat: 1 message"]]);
    expect(texts(read({ last: "3h", products: "whatsapp", families: "ai" }))).toEqual([["2026-11-03", []], ["2026-11-04", []]]);
  });

  it("a product no connector declares and the screen keeps no table of is refused, naming it", () => {
    expect(refusal(() => read({ last: "3h", products: ["whatsapp", "no-such-product"] }))).toBe("BAD_PARAMETER: `products` names no-such-product, a product this home does not know");
    expect(texts(read({ last: "3h", products: "github" }))).toEqual([["2026-11-03", []], ["2026-11-04", []]]);
  });
});

describe("`last` is resolved once, at the home's now", () => {
  it("its span ends at now, or the minute after it, and starts its duration before, in the home's zone", () => {
    const span = (now_ms: number, last: string) => (read({ last }, "person", DAYS, now_ms) as Brief).span;
    expect(span(NOW, "45m")).toEqual({ from: "2026-11-04T04:35+00:00", to: "2026-11-04T05:20+00:00" });
    expect(span(NOW - 30_000, "45m")).toEqual({ from: "2026-11-04T04:35+00:00", to: "2026-11-04T05:20+00:00" });
    expect(span(NOW, "24h")).toEqual({ from: "2026-11-03T05:20+00:00", to: "2026-11-04T05:20+00:00" });
  });
});

const MAC = "mac-0001";
const at = (clock: string) => Date.parse(`2026-11-04T${clock}:00Z`);
const SUMMED = `${MAC}/${at("04:10")}`, PENDING = `${MAC}/${at("04:45")}`;
const shown = (app: string, name: string, from: string, to: string, minutes: number): ScreenWindow => ({
  machine: MAC, day: "2026-11-04", app, site: "", name, start_ms: at(from), end_ms: at(to), tenths: minutes * 600,
});
const SCREEN: Screen = {
  sittings: [{ unit: SUMMED, start_ms: at("04:10"), end_ms: at("04:40"), summarised: true }, { unit: PENDING, start_ms: at("04:45"), end_ms: at("05:05"), summarised: false }],
  windows: [
    shown("Example Editor", "Plan", "04:10", "04:40", 30),
    shown("Safari", "Example Air", "04:45", "05:00", 15),
    shown("Notes", "", "05:00", "05:05", 5),
    shown("Google Chrome", "Example Inbox", "05:10", "05:20", 10),
  ],
};
const sitting = (n: number, unit: string, text: string, from: string, to: string): DayAtom => ({ ...atom(n, "screen", text, `2026-11-04T${from}:00Z`, { to: `2026-11-04T${to}:00Z` }), unit, units: [unit], item: unit });
const SCREEN_DAY = new Map([["2026-11-04", document("2026-11-04", [
  sitting(1, SUMMED, "Summary: synthetic planning", "04:10", "04:40"),
  sitting(2, PENDING, "20 min at the Mac (account pending)", "04:45", "05:05"),
], [])]]);
const windowLine = (app: string, name: string, from: string, to: string, minutes: number) =>
  `${from}–${to}, not summarised yet: ${name === "" ? app : `${app}, ${name}`}, ${minutes} min on screen`;

describe("the screen with no finished summary, in a brief", () => {
  it("windows join the screen part ranked by time on screen, at most six, then one line citing the rest", () => {
    const windows = Array.from({ length: BRIEF_WINDOWS + 3 }, (_, n) => ({ text: `window ${n}`, ref: `ref-${n}`, tenths: n * 600 }));
    const lines = briefOf({ day: "2026-11-04", atoms: [], facts: [] }, windows).lines;
    expect(lines.map((line) => line.text)).toEqual([...Array.from({ length: BRIEF_WINDOWS }, (_, n) => `window ${BRIEF_WINDOWS + 2 - n}`), "and 3 more windows"]);
    expect(lines.at(-1)).toEqual({ part: "screen", text: "and 3 more windows", atoms: [], refs: ["ref-2", "ref-1", "ref-0"] });
  });

  it("a sitting not summarised and the minutes past the newest sitting show as their windows, each citing its window at its start; a summarised sitting keeps its summary and no windows", () => {
    const brief = read({ last: "1h" }, "person", SCREEN_DAY, NOW, SCREEN) as Brief;
    expect(texts(brief)).toEqual([["2026-11-04", [
      "04:10–04:40 Summary: synthetic planning",
      windowLine("Safari", "Example Air", "04:45", "05:00", 15),
      windowLine("Google Chrome", "Example Inbox", "05:10", "05:20", 10),
      windowLine("Notes", "", "05:00", "05:05", 5),
    ]]]);
    expect(brief.days[0]!.lines[1]!.cites).toEqual([makeRef("window", { machine: MAC, day: "2026-11-04", app: "Safari", site: "", name: "Example Air", at_ms: at("04:45") })]);
    expect(JSON.stringify(brief)).not.toContain("account pending");
  });

  it("a day with no day file still shows its windows; with AI off every sitting is told by its windows", () => {
    const off: Screen = { ...SCREEN, sittings: SCREEN.sittings.map((each) => ({ ...each, summarised: false })) };
    expect(texts(read({ last: "1h" }, "person", new Map(), NOW, SCREEN))).toEqual([["2026-11-04", [
      windowLine("Safari", "Example Air", "04:45", "05:00", 15), windowLine("Google Chrome", "Example Inbox", "05:10", "05:20", 10), windowLine("Notes", "", "05:00", "05:05", 5),
    ]]]);
    expect(texts(read({ last: "1h" }, "person", SCREEN_DAY, NOW, off))[0]![1]).toEqual([
      windowLine("Example Editor", "Plan", "04:20", "04:40", 30), windowLine("Safari", "Example Air", "04:45", "05:00", 15),
      windowLine("Google Chrome", "Example Inbox", "05:10", "05:20", 10), windowLine("Notes", "", "05:00", "05:05", 5),
    ]);
  });

  it("`products` keeps the windows of a product's apps and sites; `families` without the screen keeps none", () => {
    expect(texts(read({ last: "1h", products: "chrome" }, "person", SCREEN_DAY, NOW, SCREEN))).toEqual([["2026-11-04", [windowLine("Google Chrome", "Example Inbox", "05:10", "05:20", 10)]]]);
    expect(texts(read({ last: "1h", families: "notes" }, "person", SCREEN_DAY, NOW, SCREEN))).toEqual([["2026-11-04", []]]);
  });

  it("a screen index not ready yet leaves the sitting's own line", () => {
    expect(texts(read({ last: "1h" }, "person", SCREEN_DAY))[0]![1]).toContain("04:45–05:05 20 min at the Mac (account pending)");
  });
});
