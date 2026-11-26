import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { episodes, HOURS_OVER, readsOf, updatedOf, workoutMs, type DayEpisodes, type Episode, type EpisodesExtras, type EpisodesFile, type Name, type Row, type Run } from "./day-episodes.js";
import { duration } from "./day-words.js";
import type { DayAtom } from "./days.js";

const FOLDER = join(dirname(fileURLToPath(import.meta.url)), "test", "day-page");
const WRITE = process.env.LIFESTREAM_FIXTURES === "write";
const DAYS = ["2026-10-25", "2026-10-31", "2026-11-10", "2031-03-04", "2031-04-05", "2031-05-20", "2031-06-12", "2031-07-01", "2031-07-02"];

const read = (name: string): string => readFileSync(join(FOLDER, name), "utf8");
const { sources } = JSON.parse(read("sources.json")) as { sources: NonNullable<EpisodesExtras["sources"]> };
const today = JSON.parse(read("today.json")) as { day: string; now_ms: number };

function caseOf(day: string): { file: EpisodesFile; extras: EpisodesExtras } {
  const { sleep, sent, groups, products, ...file } = JSON.parse(read(`${day}.day.json`)) as EpisodesFile & EpisodesExtras;
  return { file, extras: { ...sleep && { sleep }, ...sent && { sent }, ...groups && { groups }, ...products && { products }, sources } };
}

function wordedAsTheApps(day: DayEpisodes, zone: string): object {
  const clock = (ms: number): string => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone }).format(ms);
  const spoken = (run: Run): string => run.type === "span" ? [run.text, `${clock(run.start_ms)}–${clock(run.end_ms)}`].filter(Boolean).join(" ")
    : run.type === "text" ? run.text : "";
  const words = (runs: Run[]): Run[] => runs.some((run) => run.type === "span")
    ? [{ type: "text", text: runs.map(spoken).join(" · "), tone: "secondary" }] : runs;
  const named = ({ text, firstRowId, at_ms }: Name) => ({ text: at_ms === null ? text : `${text} ${clock(at_ms)}`, firstRowId });
  return {
    ...day,
    chapters: day.chapters.map((chapter) => ({
      ...chapter, names: chapter.names.map(named),
      ...chapter.hours && { hours: chapter.hours.map((hour) => ({ ...hour, names: hour.names.map(named) })) },
    })),
    episodes: day.episodes.map((episode) => ({ ...episode, row: { ...episode.row, words: words(episode.row.words) } })),
    untimed: { ...day.untimed, names: day.untimed.names.map(named) },
  };
}

function held(name: string, now: number | null, day: string): { written: string; held: string } {
  const { file, extras } = caseOf(day);
  const written = `${JSON.stringify(wordedAsTheApps(episodes(file, extras, now), file.zone), null, 2)}\n`;
  if (WRITE) writeFileSync(join(FOLDER, name), written);
  return { written, held: read(name) };
}

describe("a day's episodes", () => {
  it("the folder holds the nine days, the sources read and the today case", () => {
    expect(readdirSync(FOLDER).filter((name) => !name.endsWith(".page.json") && !name.endsWith(".moments.json")).sort()).toEqual(
      [...DAYS.flatMap((day) => [`${day}.day.json`, `${day}.episodes.json`]), "sources.json", "today.episodes.json", "today.json"].sort());
  });

  for (const day of DAYS) {
    it(`${day}: the episodes are the expected file, byte for byte`, () => {
      const { written, held: kept } = held(`${day}.episodes.json`, null, day);
      expect(kept, `test/day-page/${day}.episodes.json is this day's episodes: LIFESTREAM_FIXTURES=write writes it`).toBe(written);
    });
  }

  it("today: a day worked out at a now inside it is the expected file, byte for byte", () => {
    const { written, held: kept } = held("today.episodes.json", today.now_ms, today.day);
    expect(kept, "test/day-page/today.episodes.json is the today case's episodes: LIFESTREAM_FIXTURES=write writes it").toBe(written);
  });

  it("today: an event after now is a plan, out of the chapters, and a move under way is counted up to now", () => {
    const { file, extras } = caseOf(today.day);
    const got = episodes(file, extras, today.now_ms);
    expect(got.plan.length).toBeGreaterThan(0);
    const chaptered = new Set(got.chapters.flatMap((chapter) => chapter.rows));
    for (const id of got.plan) expect(chaptered.has(id)).toBe(false);
    const moving = got.episodes.filter((episode) => episode.kind === "move" && (episode.start_ms as number) <= today.now_ms
      && today.now_ms < (episode.end_ms as number));
    expect(moving.map((episode) => episode.row.count)).toEqual([{ text: duration(today.now_ms - (moving[0]?.start_ms as number)) }]);
    expect(episodes(file, extras).episodes.find((episode) => episode.id === moving[0]?.id)?.row.count).not.toEqual(moving[0]?.row.count);
  });

  it("every timed atom but a heading or a figure lands in exactly one episode", () => {
    for (const day of DAYS) {
      const { file, extras } = caseOf(day);
      const got = episodes(file, extras);
      const seen = new Map<number, number>();
      for (const episode of got.episodes) for (const n of episode.atoms) seen.set(n, (seen.get(n) ?? 0) + 1);
      for (const atom of file.atoms) {
        const times = seen.get(atom.n) ?? 0;
        const left = got.headings.includes(atom.n) || (atom.family === "health" && atom.unit.startsWith("span/") && !atom.flags.includes("heading"));
        expect(times, `${day} atom ${atom.n}`).toBe(left ? 0 : 1);
      }
    }
  });
});

describe("a day's episodes from atoms written for the rule", () => {
  const START = Date.UTC(2026, 9, 14, 12, 0);
  const dayOf = (atoms: Partial<DayAtom>[], window = { start_ms: START, end_ms: START + 86_400_000 }): EpisodesFile => ({
    day: "2026-10-14", zone: "UTC", window, coverage: [],
    atoms: atoms.map((atom) => ({ units: [], local_start: "", local_end: null, flags: [], ...atom }) as DayAtom),
  });
  const physical = (n: number, unit: string, text: string, from: number, to: number): Partial<DayAtom> =>
    ({ n, family: "physical", unit, start_ms: START + from * 60_000, end_ms: START + to * 60_000, local_end: "", text });
  const placed = (atoms: Partial<DayAtom>[]): DayEpisodes =>
    episodes(dayOf(atoms, { start_ms: START - 4 * 3_600_000, end_ms: START + 20 * 3_600_000 }), {});
  const line = (episode: Episode): string => episode.row.words.map((run) => run.type === "text" ? run.text : "").filter(Boolean).join(" · ");

  it("a save of a draft the mailbox kept says Draft, never Sent", () => {
    const first = (text: string): Run[] => episodes(dayOf([{ n: 1, family: "mail", unit: "gmail:person-a@example.com:cloud/2026-10-14",
      start_ms: START, end_ms: null, text, record: { source: "gmail:person-a@example.com:cloud", kind: "mailmsg", key: "m1" } }]),
    { sent: ["gmail:person-a@example.com:cloud m1"] }).episodes[0]!.row.words;
    expect(first("Mail in Drafts from the user to Person B: “Re: synthetic plans” — Synthetic first save."))
      .toEqual([{ type: "text", text: "Draft", tone: "secondary" }, { type: "quote", text: "Re: synthetic plans" }]);
    expect(first("Mail from the user to Person B: “Re: synthetic plans” — Synthetic reply as sent."))
      .toEqual([{ type: "text", text: "Sent", tone: "secondary" }, { type: "quote", text: "Re: synthetic plans" }]);
  });

  it("a day's sightings and a doubted provider's stay are quiet stays of their own, each a place of the day", () => {
    const day = placed([
      physical(1, "stay/google-timeline:person-a@example.com:export/v1", "In Paris (Timeline said Synthetic Restaurant; a photo at 13:38 was 1.4 km away)", 0, 90),
      physical(2, "seen/google-photos:person-a@example.com:export/2026-10-14", "At an unnamed place 1.4 km from Synthetic Restaurant (from photos)", 90, 120),
      physical(3, "stay/location:local:phone-a/1", "At Synthetic Home (still there at the last fix)", 180, 240),
    ]);
    const stays = day.episodes.filter((episode) => episode.kind === "stay");
    expect(stays.map((episode) => [episode.row.name, line(episode), episode.row.quiet])).toEqual([
      ["Paris", "", true], ["Near Synthetic Restaurant", "1.4 km away", true], ["Synthetic Home", "", false]]);
    expect(day.figures.places).toBe(3);
  });

  it("a walk inside a stay is drawn inside the stay on the day, never as a move", () => {
    const day = placed([
      physical(1, "stay/location:local:phone-a/1", "At Synthetic Home", 0, 240),
      physical(2, "stay/location:local:phone-a/1", "Walking at Synthetic Home", 30, 90),
    ]);
    expect(day.episodes.map((episode) => [episode.kind, episode.atoms])).toEqual([["stay", [1, 2]]]);
    const chapters = day.chapters.filter((chapter) => chapter.kind !== "none");
    expect(chapters.map((chapter) => [chapter.kind, day.episodes.find((episode) => episode.id === chapter.episode)?.row.name]))
      .toEqual([["stay", "Synthetic Home"]]);
  });
});

describe("a call recording's episode", () => {
  const file = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "callaudio", "test", "2026-10-05.day.json"), "utf8")) as EpisodesFile;
  const calls = (atoms: DayAtom[]): string[][] => episodes({ ...file, atoms }, {}).episodes.filter((episode) => episode.kind === "call")
    .map((episode) => [episode.id, episode.family, episode.row.name, `${episode.start_ms}-${episode.end_ms}`, episode.atoms.join(" ")]);
  const call = file.atoms.find((atom) => atom.family === "calls")!;
  const span = `${call.start_ms}-${call.end_ms}`;

  it("joined to a call record is the call's one moment, its name and span the call's; alone its own", () => {
    expect(calls(file.atoms)).toEqual([
      ["e1", "callaudio", "Zoom", "1791189000000-1791190200000", "1 2 3 4 5 6 7"],
      ["e8", "calls", "Person B", span, "8 9 10 11 12"],
    ]);
  });

  it("its row's line is the summary's title, after how a joined call went; with no app named it is a Call", () => {
    const lines = (atoms: DayAtom[]): [string, string[]][] => episodes({ ...file, atoms }, {}).episodes.filter((episode) => episode.kind === "call")
      .map((episode) => [episode.row.name, episode.row.words.map((run) => run.type === "text" ? run.text : "")]);
    expect(lines(file.atoms)).toEqual([["Zoom", ["Lease renewal"]], ["Person B", ["Called you", "Weekend plans"]]]);
    const unnamed = file.atoms.map((atom) => atom.n === 1 ? { ...atom, text: atom.text.replace("Call on Zoom, ", "Call, "), block: { ...atom.block!, title: "Call, 20 min" } } : atom);
    expect(lines(unnamed)[0]).toEqual(["Call", []]);
    const dotted = file.atoms.map((atom) => atom.n === 1 ? { ...atom, text: "Call on Zoom, 20 min: Rent vs. buy. You and they weighed it.", block: { ...atom.block!, title: "Call on Zoom, 20 min: Rent vs. buy" } } : atom);
    expect(lines(dotted)[0], "a title with a period, read from its block").toEqual(["Zoom", ["Rent vs. buy"]]);
  });

  it("joined, it reads the call record even when its own lines come first", () => {
    const early = file.atoms.map((atom) => atom.n < 8 ? atom : { ...atom, n: atom === call ? 12 : atom.n - 1 });
    expect(calls(early).at(-1)).toEqual(["e8", "calls", "Person B", span, "12 8 9 10 11"]);
  });

  it("alone, a turn said before its head line leaves the head first: the app's name and the head's span", () => {
    const head = file.atoms[0]!;
    const hello = { ...file.atoms[1]!, n: 1, start_ms: head.start_ms! - 5_000, end_ms: head.start_ms! - 4_000, text: "Them: let me call to Ben" };
    const before = [hello, { ...head, n: 2 }, ...file.atoms.slice(2)];
    const [episode] = episodes({ ...file, atoms: before }, {}).episodes.filter((each) => each.kind === "call");
    expect([episode!.id, episode!.row.name, episode!.title, `${episode!.start_ms}-${episode!.end_ms}`, episode!.atoms.slice(0, 2)])
      .toEqual(["e1", "Zoom", "Zoom", `${head.start_ms}-${head.end_ms}`, [2, 1]]);
  });

  it("without joins, it is never put with a call record it overlaps", () => {
    const apart = file.atoms.map(({ joins: _joins, ...atom }) => atom);
    expect(calls(apart).map(([id, family, , , atoms]) => [id, family, atoms])).toEqual([
      ["e1", "callaudio", "1 2 3 4 5 6 7"], ["e8", "calls", "8"], ["e9", "callaudio", "9 10 11 12"],
    ]);
  });
});

describe("a golden day's episodes with one input changed", () => {
  const every = caseOf("2031-03-04");
  const proof = caseOf("2031-07-01");
  const start = every.file.window.start_ms;
  const t = (hh: number, mm = 0): number => start + ((hh < 4 ? hh + 24 : hh) - 4) * 3_600_000 + mm * 60000;
  const holding = (day: DayEpisodes, n: number): Episode => day.episodes.find((episode) => episode.atoms.includes(n))!;
  const headed = (day: DayEpisodes, id: string) => day.chapters.find((chapter) => chapter.episode === id)!;
  const changed = (n: number, text: string): DayEpisodes => episodes({ ...every.file, atoms: every.file.atoms.map((atom) => atom.n === n ? { ...atom, text } : atom) }, every.extras);
  const said = (row: Row): string => row.words.map((run) => run.type === "text" ? `${run.tone === "tertiary" ? "~" : ""}${run.text}` : run.type === "quote" ? `“${run.text}”`
    : run.type === "tiles" ? `[${run.photos.length} tiles +${run.more}]` : run.type === "list" || run.type === "titles" ? `${run.type}: ${run.items.join(", ")}` : run.text)
    .join(" | ").replaceAll("\u00a0", " ");
  const without = (extras: EpisodesExtras, member: "sources" | "products"): EpisodesExtras => Object.fromEntries(Object.entries(extras).filter(([name]) => name !== member));
  const clocks = (file: EpisodesFile, extras: EpisodesExtras): Record<string, string> => {
    const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: file.zone });
    return Object.fromEntries([...readsOf(file, extras)].map(([name, ms]) => [name, clock.format(ms)]));
  };

  it("a WHOOP cycle's night is the sleep its extras name, never the cycle's span; its nap is a sleep of its own", () => {
    const { file, extras } = caseOf("2031-04-05");
    const cycle = "cycle/whoop:1:cloud/3001";
    const night = { start_ms: file.window.start_ms - 230 * 60000, end_ms: file.window.start_ms + 200 * 60000 };
    const nap = { start_ms: file.window.start_ms + 660 * 60000, end_ms: file.window.start_ms + 680 * 60000 };
    const atom = { n: 20, family: "health", unit: cycle, units: [], ...nap, local_start: "15:00", local_end: "15:20", flags: [], text: "nap — duration 0:20",
      record: { source: "whoop:1:cloud", kind: "cycle", key: "3001" } } satisfies DayAtom;
    const got = episodes({ ...file, atoms: [...file.atoms, atom] }, { ...extras, sleep: { [cycle]: night } });
    expect(got.headings).toEqual([2]);
    expect([holding(got, 1).kind, holding(got, 1).atoms, holding(got, 1).start_ms, holding(got, 1).end_ms]).toEqual(["sleep", [1], night.start_ms, night.end_ms]);
    expect([holding(got, 20).kind, holding(got, 20).atoms, holding(got, 20).start_ms, holding(got, 20).end_ms]).toEqual(["sleep", [20], nap.start_ms, nap.end_ms]);
    expect(got.figures.asleep_ms).toBe(430 * 60000);
  });

  it("a block of 13 rows folds by hour in the day's zone; one of 12 does not", () => {
    const office = headed(episodes(every.file, every.extras), "e12");
    expect(office.rows.length).toBe(HOURS_OVER + 1);
    expect(office.hours?.map((hour) => hour.start_ms)).toEqual([t(8), t(9), t(10), t(11), t(12)]);
    const twelve = headed(episodes({ ...every.file, atoms: every.file.atoms.filter((atom) => atom.n !== 34) }, every.extras), "e12");
    expect(twelve.rows.length).toBe(HOURS_OVER);
    expect(twelve.hours).toBeUndefined();
  });

  it("a workout whose instrument is its own source names it once; another instrument stays beside the source", () => {
    const measured = (by: string): string => said(holding(changed(59, `workout — running, duration 0:45, distance 6.11 km (${by})`), 59).row);
    expect(measured("WHOOP")).toBe("distance 6.11 km · WHOOP");
    expect(measured("Apple Watch")).toBe("distance 6.11 km (Apple Watch) · WHOOP");
  });

  it("a workout lasts what its line states, its moving time, on its row and its name; its span only with none stated", () => {
    const moving = changed(59, "workout — running, duration 0:35, distance 6.60 km (Strava)");
    expect(holding(moving, 59).row.count).toEqual({ text: "35m" });
    expect(moving.chapters.find((chapter) => chapter.rows.includes("e59"))!.names.map((name) => name.text)).toContain("Running 35m");
    const unstated = changed(59, "workout — running, distance 6.60 km (Strava)");
    expect(holding(unstated, 59).row.count).toEqual({ text: "45m" });
    expect(unstated.chapters.find((chapter) => chapter.rows.includes("e59"))!.names.map((name) => name.text)).toContain("Running 45m");
    const workout = every.file.atoms[58]!;
    const family = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "health", "test", "workouts.json"), "utf8")) as { text: string; ms: number }[];
    expect(family.length).toBeGreaterThan(0);
    for (const { text, ms } of family) expect(workoutMs({ ...workout, text }), text).toBe(ms);
  });

  it("a move's row: what the record adds, quieter", () => {
    const unseen = changed(11, "Not recorded, 5.9 km");
    expect([holding(unseen, 9).row.name, said(holding(unseen, 9).row)]).toEqual(["Walk 6.3 km", "~5.9 km of it not recorded"]);
  });

  it("the day's reads: one per product at its least read, no device named; updated the newest", () => {
    const reads = clocks(every.file, every.extras);
    expect(["Gmail", "Screen Time", "WHOOP", "Chrome", "Synthbank", "Photos"].map((name) => reads[name] ?? null)).toEqual(["04:00", "03:40", "03:30", "03:20", null, null]);
    expect(Object.keys(reads).filter((name) => /aa\d\d|profile|cloud|export/u.test(name))).toEqual([]);
    expect(episodes(every.file, every.extras).updated).toBe(every.file.window.end_ms);
    const autumn = caseOf("2026-10-25");
    expect(clocks(autumn.file, autumn.extras)).toEqual({ Health: "04:00", WhatsApp: "04:00" });
  });

  it("the day's reads: into takes its clock from the sources read, through the day's end; none, or a source the read lacks, is left out", () => {
    const { file, extras } = proof;
    const moved = (id: string, ms: (row: { read_through_ms: number }) => number) => sources.map((row) => row.id === id ? { ...row, read_through_ms: ms(row as { read_through_ms: number }) } : row);
    expect(clocks(file, extras)).toEqual({ "Example Log": "16:00", "example-gone": "16:00", "Example Chat": "15:00" });
    expect(clocks(file, { ...extras, sources: moved("example-log:local:test", (row) => row.read_through_ms + 30 * 60_000) }))
      .toEqual({ "Example Log": "16:30", "example-gone": "16:00", "Example Chat": "15:00" });
    expect(clocks(file, { ...extras, sources: moved("example-chat:person-z@example.com:cloud", () => file.window.end_ms + 60_000) }))
      .toEqual({ "Example Chat": "00:00", "Example Log": "16:00", "example-gone": "16:00" });
    expect(clocks(file, { ...extras, sources: moved("example-chat:person-z@example.com:cloud", () => file.window.start_ms - 60_000) }))
      .toEqual({ "Example Log": "16:00", "example-gone": "16:00" });
    expect(clocks(file, { ...extras, sources: sources.filter((row) => row.id !== "example-gone:local:test") })).toEqual({ "Example Log": "16:00", "Example Chat": "15:00" });
    expect(clocks(file, without(extras, "sources"))).toEqual({});
    const read = (how: "none" | "into" | "through"): EpisodesFile => ({ ...file, coverage: file.coverage.map((family) => ({ ...family, sources: family.sources.map((source) => ({ ...source, read: how })) })) });
    expect(clocks(read("through"), without(extras, "sources"))).toEqual({ "Example Chat": "00:00", "Example Log": "00:00", "example-gone": "00:00" });
    expect(clocks(read("none"), extras)).toEqual({});
    expect(updatedOf(file, extras)).toBe(Math.max(...readsOf(file, extras).values()));
    expect(updatedOf(file, extras)! % 60_000).toBe(0);
    expect(updatedOf(file, { ...extras, sources: moved("example-chat:person-z@example.com:cloud", (row) => row.read_through_ms + 30 * 60_000) }))
      .toBe(updatedOf(file, extras));
    expect(updatedOf(file, { ...extras, sources: moved("example-chat:person-z@example.com:cloud", (row) => row.read_through_ms + 90 * 60_000) }))
      .toBe(updatedOf(file, extras)! + 30 * 60_000);
    expect(updatedOf(file, { ...extras, sources: moved("example-log:local:test", (row) => row.read_through_ms + 24 * 60 * 60_000) })).toBe(file.window.end_ms);
    expect(updatedOf(file, without(extras, "sources"))).toBeNull();
    expect(updatedOf(read("none"), extras)).toBeNull();
  });

  it("a file an older renderer wrote (no read) knows no source, and draws the rest of its day as the new file does", () => {
    const old = caseOf("2031-07-02");
    const drawn = episodes(old.file, old.extras);
    expect(drawn.updated).toBeNull();
    const now = episodes(proof.file, proof.extras);
    expect(drawn.episodes.map((episode) => [episode.kind, episode.row.name, episode.atoms])).toEqual(now.episodes.map((episode) => [episode.kind, episode.row.name, episode.atoms]));
  });

  it("a plain line is named by its product's row as read now, or by its product's id with none", () => {
    const { file, extras } = proof;
    const renamed = episodes(file, { ...extras, products: { ...extras.products, "example-log": { name: "Example Log", row: "Log book", icon: "note" } } });
    expect(renamed.episodes.find((episode) => episode.id === "e3")?.row.name).toBe("Log book");
    expect(clocks(file, without(extras, "products"))).toEqual({ "example-gone": "16:00", "example-log": "16:00", "example-chat": "15:00" });
  });
});
