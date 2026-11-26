import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RecordRef } from "@lifestreamprotocol/core";
import { describe, expect, it } from "vitest";
import { episodes, type EpisodesExtras, type EpisodesFile } from "./day-episodes.js";
import type { CallAudioView } from "./callaudio/view.js";
import { moment, type CallHeard, type CallRecording, type Moment, type MomentMade, type MomentReads, type MomentView } from "./day-moment.js";
import { atomFocus, dayPage, recordFocus, unitFocus } from "./day-page.js";
import { NO_SIDE, type KnownPerson } from "./day-side.js";
import type { DayAtom } from "./days.js";
import { datedDays, DATE } from "./plain/test/dated.js";

const FOLDER = join(dirname(fileURLToPath(import.meta.url)), "test", "day-page");
const WRITE = process.env.LIFESTREAM_FIXTURES === "write";
const CALLER = "person-a@example.com";
const OPEN = { label: "Open in the app", href: "https://example.com/chat" };
const PLACE = "place-a";
const CALLS_SOURCE = "apple-calls:person-a@example.com:macbook-pro-0001";
const MONDAY = "2031-03-03";
const THURSDAY = "2031-03-06";
const madeOf = (ref: RecordRef): MomentMade => ({
  by: "Model A", at_ms: null, state: "done", line: "Model A · today", ask: { family: "voice", item: `voice-${ref.key}`, prompt: "transcribe" }, choose: [],
});

function callOn(day: string, n: number, key: string, text: string): DayAtom {
  const start_ms = Date.parse(`${day}T09:00:00Z`);
  return {
    n, family: "calls", unit: `calls:local:macbook-pro-0001/${day}`, units: [], start_ms, end_ms: start_ms + 240_000, local_start: "09:00", local_end: "09:04",
    flags: [], text, record: { source: CALLS_SOURCE, kind: "call", key },
  };
}

const WEEK: Readonly<Record<string, DayAtom[]>> = {
  [MONDAY]: [callOn(MONDAY, 1, "CALL-W1", "Video call with Person A, they called, 4 min")],
  [THURSDAY]: [callOn(THURSDAY, 1, "CALL-W2", "Missed phone call from Person A")],
};

const read = (name: string): string => readFileSync(join(FOLDER, name), "utf8");
const { sources } = JSON.parse(read("sources.json")) as { sources: NonNullable<EpisodesExtras["sources"]> };
const today = JSON.parse(read("today.json")) as { day: string; now_ms: number };

function inputsOf(day: string): { file: EpisodesFile; extras: EpisodesExtras } {
  const { sleep, sent, groups, products, ...file } = JSON.parse(read(`${day}.day.json`)) as EpisodesFile & EpisodesExtras;
  return { file, extras: { ...sleep && { sleep }, ...sent && { sent }, ...groups && { groups }, ...products && { products }, sources } };
}

const READS: MomentReads = {
  text: (ref: RecordRef) => ({ title: `Title ${ref.key}`, text: `Where ${ref.key}\nWords of ${ref.key}`, who: [ref.kind.includes("call") ? CALLER : `${ref.key}@example.com`] }),
  account: () => ({
    summary: "A synthetic sitting.",
    life: { people: ["Person A, a friend"], projects: ["Project B (a draft)"] },
    actions: [{ at_ms: 2, what: "saved" }, { at_ms: 1, what: "opened" }],
    timeline: [{ start_ms: 0, end_ms: 60_000, task: "writing", present: "yes" }, { start_ms: 60_000, end_ms: 120_000, task: "reading", present: "no" }],
  }),
  turns: () => null,
  open: () => OPEN,
  place: () => PLACE,
  made: madeOf,
  calls: (asked) => WEEK[asked] ?? [],
  callAudio: () => null,
  people: () => PEOPLE,
};

const NOTHING: MomentReads = {
  text: () => null, account: () => null, turns: () => null, open: () => null, place: () => null, made: () => null, calls: () => [], callAudio: () => null, people: () => [],
};

interface Golden {
  name: string;
  day: string;
  now: number | null;
}

const GOLDENS: Golden[] = [
  { name: "2031-03-04", day: "2031-03-04", now: null },
  { name: "2031-04-05", day: "2031-04-05", now: null },
  { name: "today", day: today.day, now: today.now_ms },
];

function momentsOf(golden: Golden): Record<string, Moment | null> {
  const { file, extras } = inputsOf(golden.day);
  const ids = episodes(file, extras, golden.now).episodes.map((episode) => episode.id);
  return Object.fromEntries(ids.map((id) => [id, moment(file, extras, { focus: id, whole: false, marks: null, today: golden.day }, READS, golden.now)]));
}

const day = "2031-03-04";
const { file, extras } = inputsOf(day);
const all = episodes(file, extras, null);
const atomsOf = (id: string) => all.episodes.find((episode) => episode.id === id)!.atoms.map((n) => file.atoms.find((atom) => atom.n === n)!);
const first = (kind: string) => all.episodes.find((episode) => episode.kind === kind)!;
const at = (focus: string, reads = READS, now: number | null = null, more: { whole?: boolean; marks?: string[]; today?: string } = {}) =>
  moment(file, extras, { focus, whole: more.whole ?? false, marks: more.marks ?? null, today: more.today ?? day }, reads, now);
const direct = all.episodes.find((episode) => episode.kind === "conversation" && !episode.group && episode.title)!;
const PEOPLE: KnownPerson[] = [
  { id: "person-a", name: "Person A", chats: [], handles: [{ id: `email:${CALLER}`, kind: "email" }] },
  { id: "person-chat", name: "Person Z", chats: [{ key: atomsOf(direct.id)[0]!.block!.key }], handles: [] },
];

describe("a moment: one row of the day, everything the panel draws of it", () => {
  for (const golden of GOLDENS) {
    it(`pins the moment of every row of ${golden.name} (LIFESTREAM_FIXTURES=write rewrites)`, () => {
      const written = `${JSON.stringify(momentsOf(golden), null, 2)}\n`;
      const name = `${golden.name}.moments.json`;
      if (WRITE) writeFileSync(join(FOLDER, name), written);
      expect(written).toBe(read(name));
    });
  }

  it("finds a row by its atom, its unit and its record alike, and marks the record it was asked by", () => {
    const call = first("call");
    const atom = atomsOf(call.id)[0]!;
    const ref = atom.record!;
    const byRecord = at(`rec:${ref.source} ${ref.kind} ${ref.key}`)!;
    expect(at(`a${atom.n}`)!.key).toBe(call.id);
    expect(at(`u:${atom.unit}`)!.key).toBe(call.id);
    expect(byRecord.key).toBe(call.id);
    expect(byRecord.marks).toEqual([ref.key]);
    expect(at(call.id)!.marks).toEqual([]);
  });

  it("opens every row of each golden day by the focus its page gives it, asked with no marks, as its key opens it", () => {
    for (const golden of GOLDENS) {
      const { file: held, extras: more } = inputsOf(golden.day);
      const page = dayPage(held, { ...more, ...NO_SIDE }, golden.now);
      const rows = [...page.all_day, ...page.chapters.flatMap((chapter) => chapter.blocks.flatMap((block) => block.rows)), ...page.also?.rows ?? [], ...page.plans];
      expect(rows.length, golden.name).toBeGreaterThan(0);
      for (const row of rows) {
        const ask = { whole: false, today: golden.day };
        const byKey = moment(held, more, { focus: row.key, marks: null, ...ask }, READS, golden.now);
        const byFocus = moment(held, more, { focus: row.focus!, marks: [], ...ask }, READS, golden.now);
        expect(byFocus, `${golden.name} ${row.key} ${row.focus}`).toEqual(byKey);
      }
    }
  });

  it("answers null for a focus the day holds nothing of", () => {
    expect(at("e999999")).toBeNull();
    expect(at("rec:nowhere kind key")).toBeNull();
  });

  it("opens a site's row as the sitting it sits in, and names that sitting as the row", () => {
    const site = all.episodes.find((episode) => episode.within !== undefined)!;
    const got = at(`a${site.atoms[0]}`)!;
    expect(got.row).toBe(site.within);
    expect(got.view.view).toBe("sitting");
  });

  it("lists other calls with the same person by the records' who, in time order, and none when no record reads", () => {
    const calls = all.episodes.filter((episode) => episode.kind === "call" && episode.start_ms !== null && atomsOf(episode.id)[0]!.record);
    const got = at(calls[0]!.id)!;
    expect(got.view.view).toBe("call");
    if (got.view.view !== "call") return;
    expect(got.view.others.map((other) => other.at_ms)).toEqual(calls.slice(1).map((other) => other.start_ms).sort((a, b) => a! - b!));
    const alone = at(calls[0]!.id, NOTHING)!;
    expect(alone.view.view === "call" && alone.view.others).toEqual([]);
  });

  it("gives a call the week's calls with the same person by the records' who, other days' too, never itself, and never past today", () => {
    const call = all.episodes.find((episode) => episode.kind === "call" && atomsOf(episode.id)[0]!.text.startsWith("Phone call with Person A"))!;
    const own = atomsOf(call.id)[0]!.record!;
    const others = all.episodes.filter((episode) => episode.kind === "call" && episode.id !== call.id && episode.start_ms !== null && atomsOf(episode.id)[0]!.record);
    const week = (asked: string) => {
      const got = at(call.id, READS, null, { today: asked })!.view;
      return got.view === "call" ? got.week : undefined;
    };
    const now = week(day)!;
    expect(now.current).toBe(true);
    expect(now.calls.map((each) => each.focus)).not.toContain(`rec:${own.source} ${own.kind} ${own.key}`);
    expect(now.calls.map((each) => [each.day, each.at_ms])).toEqual([
      [MONDAY, WEEK[MONDAY]![0]!.start_ms], ...others.map((other) => [day, other.start_ms]).sort((left, right) => (left[1] as number) - (right[1] as number)),
    ]);
    expect(now.calls[0]).toEqual({ day: MONDAY, at_ms: WEEK[MONDAY]![0]!.start_ms, title: "Video call", icon: "video", length_ms: 240_000, focus: `rec:${CALLS_SOURCE} call CALL-W1` });
    const later = week("2031-04-01")!;
    expect(later.current).toBe(false);
    expect(later.calls.at(-1)).toMatchObject({ day: THURSDAY, title: "Missed phone call", icon: "call-missed", length_ms: 240_000 });
    expect(week("2031-03-02")!.calls).toEqual([]);
    const alone = at(call.id, NOTHING)!.view;
    expect(alone.view === "call" && alone.week).toBeNull();
  });

  it("gives a stay the slug of the place the home knows it as, and a row inside the stay that same place", () => {
    const stay = first("stay");
    expect(at(stay.id)!.place).toMatchObject({ name: at(stay.id)!.title, slug: PLACE });
    expect(at(stay.id, NOTHING)!.place!.slug).toBeNull();
  });

  it("gives a voice note the transcribe act the home offers for its record", () => {
    const note = first("voice_note");
    const got = at(note.id)!.view;
    expect(got.view).toBe("voice");
    if (got.view !== "voice") return;
    expect(got.notes.map((each) => each.made)).toEqual(got.notes.map((each) => each.record === null ? null : madeOf(each.record)));
    expect(got.notes.some((each) => each.made !== null)).toBe(true);
    const bare = at(note.id, NOTHING)!.view;
    expect(bare.view === "voice" && bare.notes.map((each) => each.made)).toEqual(got.notes.map(() => null));
  });

  it("gives a voice note no words until its transcript is made, its words after", () => {
    const { file: held, extras: more } = inputsOf("2031-04-05");
    const note = episodes(held, more, null).episodes.find((episode) => episode.kind === "voice_note")!;
    const text = held.atoms.find((atom) => atom.n === note.atoms[0])!.text;
    expect(text).not.toContain(": ");
    const ask = { focus: note.id, whole: false, marks: null, today: "2031-04-05" };
    const bare = moment(held, more, ask, NOTHING, null)!.view;
    expect(bare.view === "voice" && bare.notes.map((each) => each.words)).toEqual([""]);
    const made = { ...held, atoms: held.atoms.map((atom) => atom.n === note.atoms[0] ? { ...atom, text: `${text}: Synthetic words.` } : atom) };
    const heard = moment(made, more, ask, NOTHING, null)!.view;
    expect(heard.view === "voice" && heard.notes.map((each) => each.words)).toEqual(["Synthetic words."]);
  });

  it("names each person's id: a chat by its key, a call by its record's handles, none the home holds no person for", () => {
    const call = all.episodes.find((episode) => episode.kind === "call" && atomsOf(episode.id)[0]!.text.startsWith("Phone call with Person A"))!;
    expect(at(call.id)!.people).toEqual([{ name: "Person A", person: "person-a", chat: null, call: atomsOf(call.id)[0]!.record }]);
    expect(at(direct.id)!.people.map((person) => person.person)).toEqual(["person-chat"]);
    expect(at(call.id, NOTHING)!.people.map((person) => person.person)).toEqual([null]);
  });

  it("draws mail with several letters as a list, and a letter's atom opens that letter", () => {
    const mail = all.episodes.find((episode) => episode.kind === "mail_received" && episode.atoms.length > 1)!;
    const listed = at(mail.id)!;
    expect(listed.view.view === "mail" && listed.view.list).toBe(true);
    expect(listed.letter).toBeNull();
    expect(listed.record).toBeNull();
    const second = at(`a${mail.atoms[1]}`)!;
    expect(second.letter).toBe(1);
    expect(second.view.view === "mail" && second.view.letters[1]!.words).toBe(`Where ${atomsOf(mail.id)[1]!.record!.key}\nWords of ${atomsOf(mail.id)[1]!.record!.key}`);
  });

  it("names a letter's sender by the person the home holds for its record's handle, and none it holds no person for", () => {
    const mail = all.episodes.find((episode) => episode.kind === "mail_received" && episode.atoms.length > 1)!;
    const [first, second] = atomsOf(mail.id).map((atom) => atom.record!);
    const sender: KnownPerson = { id: "person-sender", name: "Sender A", chats: [], handles: [{ id: `email:${first!.key}@example.com`, kind: "email" }] };
    const letters = (reads: MomentReads) => {
      const got = at(mail.id, reads)!.view;
      return got.view === "mail" ? got.letters.map((letter) => [letter.person === null, letter.person_id]) : [];
    };
    const named = letters({ ...READS, people: () => [sender] });
    expect(named[0], "the first letter's sender, by its record's handle").toEqual([false, "person-sender"]);
    expect(named[1], `the second, ${second!.key}, held by no one`).toEqual([false, null]);
    expect(letters(NOTHING).map(([, id]) => id), "no person read, no id").toEqual(named.map(() => null));
  });

  it("gives a chat its way out from the home's open and a group none", () => {
    const direct = all.episodes.find((episode) => episode.kind === "conversation" && !episode.group);
    const group = all.episodes.find((episode) => episode.kind === "conversation" && episode.group);
    if (direct) expect(at(direct.id)!.out).toEqual(OPEN);
    if (group) expect(at(group.id)!.out).toBeNull();
    expect(direct ?? group).toBeDefined();
  });

  it("orders a sitting's tasks by time spent and gives each step its own actions", () => {
    const sitting = first("sitting");
    const got = at(sitting.id)!;
    expect(got.view.view).toBe("sitting");
    if (got.view.view !== "sitting" || got.view.account === null) throw new Error("no account");
    expect(got.view.account.tasks.map((task) => task.task)).toEqual(["Writing", "Reading"]);
    expect(got.view.account.steps.map((step) => step.actions.map((action) => action.what))).toEqual([["opened", "saved"], []]);
    expect(got.view.account.steps.map((step) => step.present)).toEqual([null, "no"]);
    expect(got.view.account.people).toEqual(["Person A"]);
    expect(at(sitting.id, NOTHING)!.view.view === "sitting" && (at(sitting.id, NOTHING)!.view as { account: unknown }).account).toBeNull();
  });

  it("calls an event after the home's now a plan, and never on a past day", () => {
    const { file: todayFile, extras: todayExtras } = inputsOf(today.day);
    const later = episodes(todayFile, todayExtras, today.now_ms).episodes.find((episode) => episode.kind === "event" && episode.start_ms !== null && episode.start_ms > today.now_ms);
    const event = first("event");
    expect(at(event.id)!.view.view === "event" && (at(event.id)!.view as { plan: boolean }).plan).toBe(false);
    if (later === undefined) return;
    const got = moment(todayFile, todayExtras, { focus: later.id, whole: false, marks: null, today: today.day }, READS, today.now_ms)!;
    expect(got.view.view === "event" && got.view.plan).toBe(true);
  });

  it("joins a chat's pieces when asked for the whole chat", () => {
    const pieces = new Map<string, string[]>();
    for (const episode of all.episodes.filter((each) => each.kind === "conversation")) {
      const key = atomsOf(episode.id)[0]!.block?.key ?? "";
      pieces.set(key, [...pieces.get(key) ?? [], episode.id]);
    }
    const split = [...pieces.values()].find((ids) => ids.length > 1);
    if (split === undefined) return;
    const asked = atomsOf(split[0]!)[0]!;
    const whole = at(`a${asked.n}`, READS, null, { whole: true })!;
    expect(whole.source.atoms).toBe(split.reduce((sum, id) => sum + atomsOf(id).length, 0));
  });
});

describe("a moment the dashboard's tests once built by hand", () => {
  const START = Date.UTC(2026, 9, 14, 12, 0);
  const ask = { whole: false, marks: null, today: "2026-10-14" };

  it("a call from your other number, or a chat with yourself: You in its name, never \"the user\"", () => {
    const own: EpisodesFile = {
      day: "2026-10-14", zone: "UTC", window: { start_ms: START, end_ms: START + 86_400_000 }, coverage: [],
      atoms: [
        { n: 1, family: "calls", unit: "calls:local:macbook-pro-0001/2026-10-14", units: [], start_ms: START, end_ms: null, local_start: "12:00",
          local_end: null, flags: [], text: "Missed phone call from the user", record: { source: "calls:local:macbook-pro-0001", kind: "call", key: "c1" } },
        { n: 2, family: "messages", unit: "2026-10-14:whatsapp:15550000002@s.whatsapp.net", units: [], start_ms: START + 3_600_000, end_ms: null,
          local_start: "13:00", local_end: null, flags: [], text: "the user: a synthetic note to self",
          record: { source: "whatsapp:15550000001:iphone-aa01", kind: "msg", key: "15550000002@s.whatsapp.net:AAA1" },
          block: { key: "whatsapp:15550000001:iphone-aa01/15550000002@s.whatsapp.net", title: "the user" } },
      ] satisfies DayAtom[],
    };
    const rows = episodes(own, {}).episodes;
    const named = (kind: string) => moment(own, {}, { focus: rows.find((each) => each.kind === kind)!.id, ...ask }, NOTHING, null)!;
    expect([named("call").name, named("conversation").name]).toEqual(["You", "You"]);
    expect(named("call").people.map((person) => person.name)).not.toContain("the user");
  });

  it("a focus names a record whose key holds spaces, and a unit within a time range: the line there is the one marked", () => {
    const unit = "2026-10-14:whatsapp:15550000003@s.whatsapp.net";
    const source = "whatsapp:15550000001:iphone-aa01";
    const lineAt = (n: number, minutes: number, key: string): DayAtom => ({
      n, family: "messages", unit, units: [], start_ms: START + minutes * 60_000, end_ms: null, local_start: `12:0${minutes}`, local_end: null, flags: [],
      text: `Person A: synthetic line ${n}`, record: { source, kind: "msg", key },
      block: { key: "whatsapp:15550000001:iphone-aa01/15550000003@s.whatsapp.net", title: "Person A" },
    });
    const chat: EpisodesFile = {
      day: "2026-10-14", zone: "UTC", window: { start_ms: START, end_ms: START + 86_400_000 }, coverage: [],
      atoms: [lineAt(1, 0, "a key with spaces"), lineAt(2, 2, "second-line"), lineAt(3, 4, "third-line")] satisfies DayAtom[],
    };
    const focused = (focus: string) => moment(chat, {}, { focus, ...ask }, NOTHING, null)!;
    expect(recordFocus({ source, kind: "msg", key: "a key with spaces" })).toBe(`rec:${source} msg a key with spaces`);
    expect(focused(recordFocus({ source, kind: "msg", key: "a key with spaces" })).marks).toEqual(["a key with spaces"]);
    const ranged = unitFocus(unit, { from_ms: START + 120_000, to_ms: START + 180_000 });
    expect(ranged).toBe(`u:${unit}@${START + 120_000}-${START + 180_000}`);
    expect(focused(ranged).marks).toEqual(["second-line"]);
    expect(focused(unitFocus(unit)).key).toBe(focused(ranged).key);
    expect(focused(unitFocus(unit)).marks).toEqual([]);
    expect(focused(atomFocus(3)).marks).toEqual(["third-line"]);
  });

  it("a chat opens where the home's open says, a group and a chat the home has no open for nowhere, a line at its record", () => {
    const { file: lines, extras: more } = inputsOf("2031-07-01");
    const rows = episodes(lines, more).episodes;
    const chat = rows.find((each) => each.family === "messages")!;
    const line = rows.find((each) => each.family === "plain")!;
    const of = (id: string, reads: MomentReads, groups: string[] = []) => moment(lines, { ...more, groups }, { focus: id, ...ask }, reads, null)!;
    expect(of(chat.id, READS).out).toEqual(OPEN);
    expect(of(chat.id, NOTHING).out).toBeNull();
    expect(of(chat.id, READS, ["example-chat:12345"]).out).toBeNull();
    expect(of(line.id, READS).record).toEqual({ source: "example-log:local:test", kind: "line", key: "l-1" });
  });

  it("a dated line is no plan: \"No time of day\" in every zone; a dated event \"All day\"", () => {
    for (const { zone, days } of datedDays()) {
      const dated = days[DATE]! as EpisodesFile;
      const film = dated.atoms.find((atom) => atom.record?.key === "film")!;
      expect(moment(dated, {}, { focus: `a${film.n}`, ...ask }, NOTHING, null)!.untimed, zone).toBe("No time of day");
    }
    const event = all.all_day[0];
    expect(event, "the golden day has an all-day event").toBeDefined();
    expect(at(event!)!.untimed).toBe("All day");
  });
});

describe("a call recording's moment, from the callaudio journey's day", () => {
  const file = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "callaudio", "test", "2026-10-05.day.json"), "utf8")) as EpisodesFile;
  const recorded = file.atoms.filter((atom) => atom.family === "callaudio");
  const heads = recorded.filter((atom) => atom.item?.startsWith("stretch:"));
  const alone = heads.find((atom) => atom.joins === undefined)!;
  const joined = heads.find((atom) => atom.joins !== undefined)!;
  const call = file.atoms.find((atom) => atom.family === "calls")!;
  const STEP = { value: "route-a", words: "Model A", note: null };
  const UNHIDDEN = "Audio cannot be hidden. Choose a model on this Mac, or send voice notes as they are.";
  const WHOLE = { family: "callaudio", item: alone.item, prompt: "call-transcript" };
  const made = (state: MomentMade["state"], line: string | null = null, choose: MomentMade["choose"] = []): MomentMade =>
    ({ by: state === "done" ? "Model A" : null, at_ms: null, state, line, ask: { family: "callaudio", item: "recording:part", prompt: "call-transcript" }, choose });
  const partStart = (key: string): number => Date.parse(`${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T${key.slice(9, 11)}:${key.slice(11, 13)}:${key.slice(13)}`);

  function viewOf(unit: string, more: Partial<CallAudioView> = {}): CallAudioView {
    const head = heads.find((atom) => atom.unit === unit)!;
    const title = head.block!.title.slice(head.block!.title.indexOf(": ") + 2);
    const turns = recorded.filter((atom) => atom.unit === unit && atom !== head).map((atom) => {
      const colon = atom.text.indexOf(": ");
      const who = atom.text.slice(0, colon);
      return {
        at_ms: atom.start_ms!, end_ms: atom.end_ms!, mine: who === "You", who, words: atom.text.slice(colon + 2),
        heard: { record: atom.record!, item: atom.item!, from_ms: atom.start_ms! - partStart(atom.record!.key) },
      };
    });
    const asked = [...new Set(turns.map((turn) => turn.heard.item))];
    return {
      summary: { title, summary: head.text.slice(head.text.indexOf(`${title}. `) + title.length + 2) }, summary_item: head.item!, asked,
      stopped_ms: null, open: false, camera: false, parts: { asked: asked.length, done: asked.length, given_up: 0, waiting: 0 }, turns, ...more,
    };
  }

  const heard = (view: CallAudioView, parts: MomentMade[] = view.asked.map(() => made("done", "Model A · today")), summary: MomentMade | null = made("done")): CallHeard =>
    ({ view, parts, summary });
  const readsOf = (callAudio: MomentReads["callAudio"]): MomentReads => ({ ...NOTHING, callAudio });
  const open = (focus: string, reads: MomentReads): Moment => moment(file, {}, { focus, whole: false, marks: null, today: file.day }, reads, null)!;
  const callOf = (got: Moment): Extract<MomentView, { view: "call" }> => got.view as Extract<MomentView, { view: "call" }>;
  const recordingOf = (more: Partial<CallAudioView>, parts?: MomentMade[], summary?: MomentMade | null): CallRecording =>
    callOf(open(`a${alone.n}`, readsOf((unit) => heard(viewOf(unit, more), parts, summary)))).recording!;

  it("alone, a call is the app's: its name and chip the app, its summary and every turn, each playing its own part from its time", () => {
    const got = open(`a${alone.n}`, readsOf((unit) => heard(viewOf(unit))));
    expect([got.kind, got.icon, got.title, got.name, got.products, got.people, got.record]).toEqual(["call", "call", "Zoom", "Zoom", ["Zoom"], [], alone.record]);
    const view = callOf(got);
    expect([view.name, view.group, view.figure, view.others, view.week]).toEqual(["Zoom", "", { length_ms: 20 * 60_000, words: null, label: "Call" }, [], null]);
    expect(view.recording!.summary).toBe("You and they went over the lease renewal; you will send the signed copy.");
    expect(view.recording!.turns.map((turn) => [turn.who, turn.mine, turn.words, turn.heard!.record.kind, turn.heard!.record.key, turn.heard!.from_ms])).toEqual([
      ["You", true, "Hello, can you hear me?", "mic-recording", "20261005T083000.000Z", 1_000],
      ["Them", false, "Yes, I can hear you.", "sound-recording", "20261005T083000.000Z", 11_000],
      ["You", true, "Good. Shall we go over the lease?", "mic-recording", "20261005T083000.000Z", 21_000],
      ["Them", false, "Sure, the renewal is due next month.", "sound-recording", "20261005T083000.000Z", 31_000],
      ["You", true, "I will send the signed copy tonight.", "mic-recording", "20261005T084000.000Z", 2_000],
      ["Them", false, "Great, thanks.", "sound-recording", "20261005T084000.000Z", 8_000],
    ]);
    expect(view.recording!.made).toEqual({ ...made("done", "Model A · today"), ask: WHOLE });
    expect(open(`a${alone.n}`, readsOf((unit) => heard(viewOf(unit, { camera: true })))).icon, "the camera on").toBe("video");
    expect(got.source.records.map((record) => `${record.kind} ${record.key}`), "each recording once, though many turns play from it").toEqual([
      "mic-recording 20261005T083000.000Z", "sound-recording 20261005T083000.000Z", "mic-recording 20261005T084000.000Z", "sound-recording 20261005T084000.000Z",
    ]);
  });

  it("alone, a turn said before its head line leaves the call the app's: its title, record and figure the head's", () => {
    const [head, first, ...rest] = file.atoms;
    const hello = { ...first!, n: 1, start_ms: head!.start_ms! - 5_000, end_ms: head!.start_ms! - 4_000, text: "Them: let me call to Ben" };
    const before = { ...file, atoms: [hello, { ...head!, n: 2 }, ...rest] };
    const got = moment(before, {}, { focus: "a1", whole: false, marks: null, today: file.day }, readsOf(() => null), null)!;
    expect([got.title, got.products, got.record, callOf(got).name, callOf(got).figure]).toEqual(["Zoom", ["Zoom"], alone.record, "Zoom", { length_ms: 20 * 60_000, words: null, label: "Call" }]);
  });

  it("joined to its call record, one moment: the call's title, people, record and figure, the recording's turns named as its view names them", () => {
    const reads = readsOf((unit) => heard(viewOf(unit)));
    const said = recorded.find((atom) => atom.text.startsWith("Person B: "))!;
    for (const focus of [`e${call.n}`, `a${joined.n}`]) expect(open(focus, reads).key, focus).toBe(`e${call.n}`);
    const got = open(`a${said.n}`, reads);
    expect([got.key, got.title, got.people.map((person) => [person.name, person.call]), got.record, got.products])
      .toEqual([`e${call.n}`, "Person B", [["Person B", call.record]], call.record, ["Phone call"]]);
    const view = callOf(got);
    expect([view.name, view.figure]).toEqual(["Person B", { length_ms: call.end_ms! - call.start_ms!, words: null, label: "They called" }]);
    expect(view.recording!.summary).toBe("You and they settled on Saturday; you will book the table.");
    expect(view.recording!.turns.map((turn) => [turn.who, turn.words, turn.marked])).toEqual([
      ["You", "Are we still on for Saturday?", false], ["Person B", "Yes, Saturday works for me.", true], ["You", "I will book the table.", false],
    ]);
  });

  it("says each state of a call's words in one made, which asks for the whole call", () => {
    const cases: [string, MomentMade[], Partial<MomentMade> | null][] = [
      ["done", [made("done", "Model A · today"), made("done", "Model A · today")], { state: "done", line: "Model A · today", by: "Model A" }],
      ["transcribing", [made("done"), made("waiting", "In the queue"), made("waiting", "In the queue")], { state: "waiting", line: "Transcribing, 1 of 3 parts", choose: [] }],
      ["off or unset", [made("done"), made("off", null, [STEP])], { state: "off", line: null, choose: [STEP] }],
      ["not timed", [made("needs", "Model A can't time its words", [STEP])], { state: "needs", line: "Model A can't time its words", choose: [STEP] }],
      ["older than the range", [made("off", "Older than this stream's range", [STEP])], { state: "off", line: "Older than this stream's range", choose: [STEP] }],
      ["failed", [made("done"), made("failed", "Could not be processed", [STEP]), made("failed", "Could not be processed", [STEP])], { state: "failed", line: "2 parts couldn't be read", choose: [STEP] }],
      ["one failed", [made("done"), made("failed", "Could not be processed", [STEP])], { state: "failed", line: "1 part couldn't be read", choose: [STEP] }],
      ["audio can't be hidden", [made("done"), made("needs", UNHIDDEN, [STEP]), made("waiting", "In the queue")], { state: "needs", line: UNHIDDEN, choose: [STEP] }],
      ["no part asked", [], null],
    ];
    for (const [state, parts, said] of cases) {
      expect(recordingOf({}, parts).made, state).toEqual(said === null ? null : expect.objectContaining({ ...said, ask: WHOLE }));
    }
  });

  it("stopped, the time it stopped; with no summary, the turns alone beside the summary's own state", () => {
    const stopped_ms = alone.start_ms! + 10 * 60_000;
    const off = made("off", null, [STEP]);
    const recording = recordingOf({ stopped_ms, summary: null }, undefined, off);
    expect([recording.stopped_ms, recording.summary, recording.turns.length, recording.summarised]).toEqual([stopped_ms, null, 6, off]);
    expect(recordingOf({}, undefined, null).summarised, "nothing asked of the summary yet").toBeNull();
  });

  it("with no recording read, as a live home whose audio connector exports nothing, a call answers no recording", () => {
    const none = readsOf(() => null);
    const quiet = open(`a${alone.n}`, none);
    expect([quiet.title, quiet.products, callOf(quiet).name, callOf(quiet).recording]).toEqual(["Zoom", ["Zoom"], "Zoom", null]);
    expect([open(`e${call.n}`, none).title, callOf(open(`e${call.n}`, none)).recording]).toEqual(["Person B", null]);
  });
});
