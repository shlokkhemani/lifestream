import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, instant, openHomeFolder, type DaySettings, type EnrichmentRow, type ExtractRow, type OpenView } from "@lifestreamprotocol/core";
import { buildLabels, CALLAUDIO_FAMILY, dayPage, labelsFrom, type DayDocument, type DaySideExtras, type MomentMade, type WherePiece } from "@lifestreamprotocol/families";
import { serveDoor, type Door } from "./door.js";
import { startHome, type Home } from "./home.js";
import { BEFORE_HOME, dayBody, dayPageOf, lengthOf, momentPage, threadMessages, type DaysReads } from "./page-days.js";
import { servePages } from "./page-serve.js";
import { PAGES, type AnswerOf } from "./pages.js";
import { mintPrincipal } from "./principals.js";
import type { Ask } from "./reads.js";
import { clientFixture, makeRoot, readHome, removeRoot, REPO, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";

const GOLDENS = join(REPO, "packages", "families", "test", "day-page");
const SIDES = join(REPO, "packages", "families", "test", "day-side");
const RECORDED = join(REPO, "packages", "families", "callaudio", "test", "2026-10-05.day.json");
const REGISTRY = join(REPO, "packages", "home", "test", "days-registry.ts");
const ZONE = "Asia/Kolkata";
const UNIT = "macbook-pro-0001";
const LOCATION = "location:local:iphone-aa01";
const WHATSAPP = "whatsapp:919000000009:iphone-aa01";
const CALENDAR = "google-calendar:person-a@example.com:cloud";
const READER = "synthetic-days-reader".padEnd(43, "r");
const APPLE_EPOCH_S = 978_307_200;
const MINUTE = 60_000;
const PAST = "2026-10-04";
const TODAY = "2026-10-05";
const EMPTY_DAY = "2026-09-01";
const LARGE = "2026-10-02";
const A = "+15550000301";
const B = "+15550000302";
const DURATIONS = ["duration_ms", "length_ms", "today_ms", "total_ms", "from_ms"];

type Body = Record<string, any>;
type Point = { latitude: number; longitude: number };
type Day = AnswerOf<"day">;

const HOME: Point = { latitude: 12.9716, longitude: 77.5946 };
const WORK: Point = { latitude: 12.9352, longitude: 77.6245 };

const at = (day: string, clock: string) => instant(`${day}T${clock}:00`, "local", { zone: ZONE }).start_ms;
const iso = (ms: number) => new Date(ms).toISOString();
const jid = (phone: string) => `${phone.slice(1)}@s.whatsapp.net`;
const median = (values: number[]) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!;

let fixes = 0;
function fixAt(ms: number, point: Point, speed: number) {
  const n = ++fixes;
  return {
    kind: "fix", key: `33333333-3333-4333-8333-333333333333:${n}`, time: { start_ms: ms, precision: "ms" },
    content: { type: "location.fix", content: { kind: "fix", payload: { location: { timestamp_rfc3339_utc: iso(ms), latitude: point.latitude, longitude: point.longitude, horizontal_accuracy: 5, altitude: 900, speed } } } },
  };
}

function stays(legs: [number, number, Point][]) {
  return legs.flatMap(([from, to, point], index) => {
    const still = Array.from({ length: Math.ceil((to - from) / (2 * MINUTE)) }, (_, step) => fixAt(from + step * 2 * MINUTE, point, 0));
    const next = legs[index + 1];
    if (next === undefined) return still;
    return [...still, ...Array.from({ length: 30 }, (_, leg) => fixAt(to + leg * 20_000, {
      latitude: point.latitude + (next[2].latitude - point.latitude) * leg / 30, longitude: point.longitude + (next[2].longitude - point.longitude) * leg / 30,
    }, 9))];
  });
}

function wa(stanza: string, chat: string, when: number, mine = false) {
  const date = when / 1000 - APPLE_EPOCH_S;
  const message = {
    ZSTANZAID: stanza, ZTEXT: `synthetic line ${stanza}`, ZFROMJID: mine ? null : chat, ZTOJID: null, ZPUSHNAME: null, ZMESSAGEDATE: date, ZSENTDATE: date,
    ZMESSAGETYPE: 0, ZGROUPEVENTTYPE: null, ZFLAGS: 0, ZMESSAGESTATUS: 1, ZMESSAGEERRORSTATUS: 0, ZISFROMME: mine ? 1 : 0, ZSTARRED: 0,
  };
  return {
    kind: "msg", key: `${chat}:${stanza}`, time: { start_ms: when, precision: "ms" },
    content: { type: "whatsapp.msg", message, session_jid: chat, parent_stanza_id: null, media_item: null, group_member_jid: null, blobs: [] },
  };
}

function event(key: string, start: number, end: number, summary: string) {
  const stamp = (ms: number) => iso(ms).replace(/[-:]/gu, "").replace(/\.\d{3}/u, "");
  const lines = ["BEGIN:VEVENT", `UID:${key}@example.com`, `DTSTAMP:${stamp(start)}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`, `SUMMARY:${summary}`, "END:VEVENT", ""];
  return { kind: "event", key: `${key}@example.com`, time: { start_ms: start, end_ms: end, precision: "s" }, content: { type: "calendar.event", content: lines.join("\r\n") } };
}

function pinned(name: string, body: Body): void {
  mkdirSync(join(REPO, "homelink", "Tests", "Fixtures", "pages"), { recursive: true });
  const fixture = clientFixture(`pages/${name}`, body, DURATIONS);
  expect(fixture.held, `homelink/Tests/Fixtures/pages/${name}.json is this read: LIFESTREAM_FIXTURES=write writes it`).toBe(fixture.written);
}

const partStart = (key: string): number => Date.parse(`${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T${key.slice(9, 11)}:${key.slice(11, 13)}:${key.slice(13)}`);

function recordingsOf(file: DayDocument): { extract(unit: string): ExtractRow | undefined; enrichment(item: string): EnrichmentRow | undefined } {
  const extracts = new Map<string, ExtractRow>();
  const answers = new Map<string, EnrichmentRow>();
  const answer = (item: string, content: Body) => answers.set(item, { state: "done", item, content } as unknown as EnrichmentRow);
  const call = file.atoms.find((atom) => atom.family === "calls")!;
  for (const head of file.atoms.filter((atom) => atom.family === CALLAUDIO_FAMILY && atom.item?.startsWith("stretch:"))) {
    const parts = new Map<string, Body>();
    for (const turn of file.atoms.filter((atom) => atom.unit === head.unit && atom !== head)) {
      const start_ms = partStart(turn.record!.key);
      const part = parts.get(turn.item!) ?? {
        kind: turn.record!.kind, key: turn.record!.key, track: turn.record!.kind.startsWith("mic") ? "mic" : "sound", sha256: turn.item!.slice("recording:".length),
        media_type: "audio/mp4", start_ms, ms: 600_000, loud_s: 60, quiet: false, asked: true, segments: [],
      };
      part.segments.push({ start_s: (turn.start_ms! - start_ms) / 1_000, end_s: (turn.end_ms! - start_ms) / 1_000, text: turn.text.slice(turn.text.indexOf(": ") + 2) });
      parts.set(turn.item!, part);
    }
    for (const [item, { segments }] of parts) answer(item, { segments });
    const title = head.block!.title.slice(head.block!.title.indexOf(": ") + 2);
    answer(head.item!, { title, summary: head.text.slice(head.text.indexOf(`${title}. `) + title.length + 2) });
    const each = [...parts.values()].map(({ segments: _, ...part }) => part);
    const party = { id: B, kind: "phone" };
    extracts.set(head.unit, {
      family: CALLAUDIO_FAMILY, unit: head.unit, content: {
        short: false, source: head.record!.source, span: { start_ms: head.start_ms, end_ms: head.end_ms },
        mic: each.filter((part) => part.track === "mic"), sound: each.filter((part) => part.track === "sound"),
        holder: head.joins === undefined ? "Zoom" : null, camera: false, speakers: [], stopped_ms: null, open: false,
        joined: head.joins === undefined ? null : {
          record: head.joins, unit: call.unit, service: "phone", span: { start_ms: call.start_ms, end_ms: call.end_ms }, handles: [B], parties: [party], other: party,
        },
      },
    } as unknown as ExtractRow);
  }
  return { extract: (unit) => extracts.get(unit), enrichment: (item) => answers.get(item) };
}

function asked(url: string, now_ms: number, more: Partial<Ask> = {}): Ask {
  return { url, now_ms, held: { machine: "machine-0001" }, ...more } as unknown as Ask;
}

describe("The day page built from a day file and the home's reads", () => {
  const goldens = readdirSync(GOLDENS).filter((name) => name.endsWith(".day.json")).sort();

  const servedOver = (file: DayDocument & { sleep?: Record<string, { start_ms: number; end_ms: number }>; sent?: string[]; groups?: string[]; products?: Record<string, never> }, more: Partial<DaysReads> = {}, seen: Partial<Record<"extract" | "enrichment", unknown>> = {}) => {
    const settings: DaySettings = { zone: file.zone, day_start_hour: (file as { day_start_hour?: number }).day_start_hour ?? 4 };
    const read = { files: 0, builds: 0 };
    const OWNER = "owner@example.com";
    const sent = (file.sent ?? []).map((each) => ({ source: each.slice(0, each.lastIndexOf(" ")), key: each.slice(each.lastIndexOf(" ") + 1) }));
    const view = {
      position: () => "9:1700000000000",
      sources: () => [],
      extract: (family: string, unit: string) => (family === "health" && file.sleep?.[unit] !== undefined ? { content: { kind: "sleep", ...file.sleep[unit] } } : undefined),
      extractsOn: (family: string) => (family === "mail" ? sent.map(({ source, key }) => ({ content: { source, mails: [{ key, from: { address: OWNER } }] } })) : []),
      derived: { days: { page: () => [] } },
      ...seen,
    } as unknown as OpenView;
    const reads: DaysReads = {
      viewed: (use) => use(view),
      people: (_machine, _view, use) => use(null),
      day: () => settings,
      dayHead: (day) => (day === file.day ? (file as { inputs?: string }).inputs ?? "inputs" : null),
      dayFile: () => {
        read.files++;
        return file;
      },
      products: () => ({ digest: "products", products: file.products ?? {} }),
      labels: () => labelsFrom(() => undefined, settings),
      evidence: () => [],
      places: () => [],
      spots: (_machine, pieces) => pieces.map(() => null),
      group: (_labels, chat) => (file.groups ?? []).includes(chat),
      owners: () => new Map(sent.map(({ source }) => [source, OWNER])),
      text: () => null,
      account: () => null,
      transcribed: () => null,
      made: () => [],
      open: () => null,
      chat: () => ({ chat: "", conversation: null }),
      ...more,
    };
    const routes = servePages({ day: dayPageOf(reads), moment: momentPage(reads) }, () => settings);
    return { route: routes.get(PAGES.day.route)!, moment: routes.get(PAGES.moment.route)!, read, settings };
  };

  it("serves each golden day in the page's shape, equal to the families' page over the extras its reads gave", async () => {
    expect(goldens.length).toBeGreaterThanOrEqual(9);
    for (const name of goldens) {
      const file = JSON.parse(readFileSync(join(GOLDENS, name), "utf8"));
      const { route } = servedOver(file);
      const reply = await route(asked(`/v1/page/day?day=${file.day}`, file.window.end_ms + 7 * 86_400_000));
      expect(reply.status, name).toBe(200);
      const { position, today, ...body } = PAGES.day.shape.parse(JSON.parse(reply.body as string)) as Day;
      expect([position, today], name).toEqual(["9:1700000000000", expect.any(String)]);
      const expected = dayBody(file.day, dayPage(file, { sleep: file.sleep ?? {}, sent: file.sent ?? [], groups: file.groups ?? [], products: file.products ?? {}, where: [], places: [], people: [], calls: [] }, null));
      expect(body, name).toEqual(expected);
    }
  });

  it("answers 304 on its ETag having read no day file, and moves a day's ETag with the minute only while the day holds now", async () => {
    const file = JSON.parse(readFileSync(join(GOLDENS, goldens[0]!), "utf8"));
    const { route, read } = servedOver(file);
    const past = file.window.end_ms + 86_400_000;
    const first = await route(asked(`/v1/page/day?day=${file.day}`, past));
    expect(read.files, "the needs read once, the page built once").toBe(2);
    const again = await route(asked(`/v1/page/day?day=${file.day}`, past + MINUTE, { if_none_match: first.headers.etag! }));
    expect([again.status, read.files], "a past day's page is the same a minute on, and the 304 read no file").toEqual([304, 2]);

    const inside = file.window.start_ms + 12 * 60 * MINUTE;
    const today = await route(asked(`/v1/page/day?day=${file.day}`, inside));
    expect(JSON.parse(today.body as string).now_ms).toBe(inside);
    const same = await route(asked(`/v1/page/day?day=${file.day}`, inside + 30_000, { if_none_match: today.headers.etag! }));
    expect(same.status, "within the minute").toBe(304);
    const turned = await route(asked(`/v1/page/day?day=${file.day}`, inside + MINUTE, { if_none_match: today.headers.etag! }));
    expect(turned.status, "the minute turned on the day that holds now").toBe(200);
    expect(JSON.parse(turned.body as string).now_ms).toBe(inside + MINUTE);
  });

  const viewOver = (extract: (family: string, unit: string) => unknown, extractsOn: (family: string) => unknown[]): Partial<DaysReads> => {
    const view = { position: () => "9:1700000000000", sources: () => [], extract, extractsOn, derived: { days: { page: () => [] } } } as unknown as OpenView;
    return { viewed: (use) => use(view) };
  };
  const bodyOf = async (route: ReturnType<typeof servedOver>["route"], file: DayDocument): Promise<Body> => {
    const { position: _position, today: _today, ...body } = JSON.parse((await route(asked(`/v1/page/day?day=${file.day}`, file.window.end_ms + 7 * 86_400_000))).body as string) as Body;
    return body;
  };
  const pageOver = (file: DayDocument, extras: { sleep?: Record<string, { start_ms: number; end_ms: number }>; sent?: string[] }) =>
    dayBody(file.day, dayPage(file, { sleep: extras.sleep ?? {}, sent: extras.sent ?? [], groups: (file as { groups?: string[] }).groups ?? [], products: (file as { products?: Record<string, never> }).products ?? {}, where: [], places: [], people: [], calls: [] }, null));

  it("counts as Sent only mail from the address the owner list holds for its source, matched in any case", async () => {
    const { sent: _sent, sleep, ...file } = JSON.parse(readFileSync(join(GOLDENS, "2031-03-04.day.json"), "utf8")) as DayDocument & { sent: string[]; sleep: Record<string, { start_ms: number; end_ms: number }> };
    const OWNED = "gmail:person-a@example.com:cloud";
    const mails = [{ source: OWNED, mails: [{ key: "m-1", from: { address: "Person-A@Example.com" } }, { key: "m-4", from: { address: "person-b@example.com" } }] }];
    const extract = (family: string, unit: string) => (family === "health" && sleep[unit] !== undefined ? { content: { kind: "sleep", ...sleep[unit] } } : undefined);
    const { route } = servedOver(file, {
      ...viewOver(extract, (family) => (family === "mail" ? mails.map((content) => ({ content })) : [])),
      owners: () => new Map([[OWNED, "person-a@example.com"]]),
    });
    const body = await bodyOf(route, file);
    expect(body, "the owner's own mail, its address in another case, is Sent; another person's is not").toEqual(pageOver(file, { sleep, sent: [`${OWNED} m-1`] }));
    expect(body).not.toEqual(pageOver(file, { sleep, sent: [`${OWNED} m-1`, `${OWNED} m-4`] }));
    expect(body).not.toEqual(pageOver(file, { sleep }));
  });

  it("takes as a WHOOP cycle's night its sleep that is no nap and ends inside the day, never the night before or a nap", async () => {
    const file = JSON.parse(readFileSync(join(GOLDENS, "2031-04-05.day.json"), "utf8")) as DayDocument;
    const CYCLE = "cycle/whoop:1:cloud/3001";
    const start = file.window.start_ms;
    const night = { start_ms: start - 230 * MINUTE, end_ms: start + 200 * MINUTE };
    const before = { start_ms: night.start_ms - 86_400_000, end_ms: night.end_ms - 86_400_000 };
    const nap = { nap: true, start_ms: start + 600 * MINUTE, end_ms: start + 630 * MINUTE };
    const served = (sleeps: object[]) => bodyOf(servedOver(file, viewOver((family, unit) => (family === "health" && unit === CYCLE ? { content: { kind: "cycle", sleeps } } : undefined), () => [])).route, file);
    expect(await served([before, nap, night]), "the night that ends inside the day, past the night before and a nap").toEqual(pageOver(file, { sleep: { [CYCLE]: night } }));
    expect(await served([before, nap, night])).not.toEqual(pageOver(file, {}));
    expect(await served([before, nap]), "a cycle with only the night before and a nap has no night on this day").toEqual(pageOver(file, {}));
  });

  it("builds a thread's messages with what each carries: pictures, a quote, reactions on their message, a place, a file, a group's event, a missing video, a voice note", () => {
    const CHAT = jid(A);
    const at0 = at(PAST, "10:00");
    const said = (stanza: string, minute: number, text: string, fact: Record<string, unknown> = {}, mine = false) => ({
      line: { text, start_ms: at0 + minute * MINUTE } as never,
      fact: { source: WHATSAPP, key: `${CHAT}:${stanza}`, at: at0 + minute * MINUTE, from: mine ? { id: "me", kind: "me" } : { id: CHAT, kind: "jid" }, ...fact } as never,
    });
    const conversation = {
      title: "Person A",
      messages: [
        said("m1", 0, "Person A: synthetic hello", { text: "synthetic hello" }),
        said("m2", 1, "the user: [photo: a synthetic table] (reply to Person A, 10:00)", { parts: [{ what: "photo", blob: "sha256:aa", media_type: "image/jpeg" }], reply_to: `${CHAT}:m1` }, true),
        said("m3", 2, "Person A: [reaction: love] (to the user, 10:01)", { parts: [{ what: "reaction: love" }], reply_to: `${CHAT}:m2` }),
        said("m4", 3, "Person A: [location: Synthetic Cafe]", { parts: [{ what: "location", lat: 1.5, lon: 2.5 }] }),
        said("m5", 4, "Person A: [document: \"Synthetic plan\"]", { parts: [{ what: "document: \"Synthetic plan\"", media_type: "application/pdf", blob: "sha256:bb" }] }),
        said("m6", 5, "Person A: [group event, kind 1: subject changed]", { parts: [{ what: "group event, kind 1: subject changed" }] }),
        said("m7", 6, "Person A: [video]", { parts: [{ what: "video" }] }),
        said("m8", 7, "Person A: [voice note, 66 s: \"synthetic words\"]", { parts: [{ what: "voice note", seconds: 66, blob: "sha256:cc" }] }),
        said("m9", 8, "Person A: [reaction: like] (to an earlier message)", { parts: [{ what: "reaction: like" }], reply_to: `${CHAT}:gone` }),
        said("m10", 9, "Person A: synthetic answer (reply to Person B, 09:00)", { text: "synthetic answer", reply_to: `${CHAT}:old` }),
        said("m11", 10, "Person A: [system event]", { parts: [{ what: "system event" }] }),
      ],
    };
    const messages = threadMessages(`whatsapp:${CHAT}`, conversation);
    expect(messages.map((message) => message.key.slice(CHAT.length + 1)), "a reaction on its message and a silent event are no messages").toEqual(["m1", "m2", "m4", "m5", "m6", "m7", "m8", "m9", "m10"]);
    const [hello, photo, place, file, event, video, voice, orphan, answer] = messages;
    expect([hello!.text, hello!.name, hello!.mine, hello!.quote, hello!.reactions]).toEqual(["synthetic hello", "Person A", false, null, []]);
    expect([photo!.mine, photo!.text, photo!.pictures, photo!.quote, photo!.reactions]).toEqual([
      true, "", [{ hash: "sha256:aa", alt: "a synthetic table" }], { mine: false, name: "Person A", text: "synthetic hello" }, [{ face: "❤️", mine: false, name: "Person" }],
    ]);
    expect(place!.location).toEqual({ name: "Synthetic Cafe", latitude: 1.5, longitude: 2.5 });
    expect(file!.attachments).toEqual([{ icon: "file", name: "Synthetic plan", line: "PDF" }]);
    expect([event!.event, event!.text]).toEqual(["changed the group’s name", ""]);
    expect([video!.video, video!.missing]).toEqual([null, ["video"]]);
    expect(voice!.voice).toEqual({ audio: "sha256:cc", seconds: 66, length: "1:06", transcript: "synthetic words" });
    expect([orphan!.event, orphan!.text]).toEqual(["reacted 👍 to an earlier message", ""]);
    expect(answer!.quote).toEqual({ mine: false, name: "Person B", text: "A message at 09:00" });
    for (const message of messages) PAGES.thread.shape.parse({ chat: `whatsapp:${CHAT}`, day: PAST, title: null, messages: [message], position: "1:1", today: TODAY });
  });

  it("pins two golden days for the apps' suites: a midnight on an hour line with a written and a quiet group, and groups most written first", async () => {
    const golden = (day: string) => JSON.parse(readFileSync(join(GOLDENS, `${day}.day.json`), "utf8"));
    const served = async (file: DayDocument) => JSON.parse((await servedOver(file).route(asked(`/v1/page/day?day=${file.day}`, file.window.end_ms + 7 * 86_400_000))).body as string) as Body;
    const midnight = await served(golden("2031-03-04"));
    const hours = (midnight.chapters as Body[]).flatMap((chapter) => (chapter.blocks as Body[]).filter((block) => block.kind === "hour"));
    expect(hours.filter((block) => block.divider !== null).map((block) => block.divider), "the midnight between two hour lines").toEqual(["2031-03-05"]);
    expect((midnight.side.groups as Body[]).map((group) => [group.title, group.quiet])).toEqual([["Group Alpha", false], ["Group Gamma", true]]);
    pinned("day.midnight", midnight);
    const day = golden("2031-05-20");
    const wrote = { ...day, atoms: day.atoms.map((atom: Body) => [26, 27, 51].includes(atom.n) ? { ...atom, text: atom.text.replace(/^[^:]*:/u, "the user:") } : atom) };
    const groups = await served(wrote);
    expect((groups.side.groups as Body[]).map((group) => [group.title, group.runs[0].value])).toEqual([["Group Beta", "3"], ["Group Alpha", "1"]]);
    pinned("day.groups", groups);
  });

  it("pins the moments the apps' suites open: a call's other calls by the ids its record shares, its chip the person whose handle it names, the row a folded stay opens on", async () => {
    const golden = JSON.parse(readFileSync(join(GOLDENS, "2031-03-04.day.json"), "utf8")) as DayDocument;
    const starts = new Map((JSON.parse(readFileSync(join(GOLDENS, "2031-03-04.episodes.json"), "utf8")).episodes as Body[]).map((each) => [each.id, each.start_ms as number]));
    const who: Record<string, { who: string[]; title: string }> = {
      "CALL-0001": { who: ["+15550000001"], title: "Person A" },
      "CALL-0002": { who: ["+15550000006"], title: "+15550000006" },
      "CALL-0003": { who: ["+15550000005", "+15550000001"], title: "Person C" },
      "CALL-0004": { who: ["+15550000006"], title: "+15550000006" },
      "CALL-0005": { who: ["+15550000007"], title: "Person A" },
    };
    const known = (JSON.parse(readFileSync(join(SIDES, "2031-03-04.json"), "utf8")) as DaySideExtras).people;
    const { moment } = servedOver(golden, {
      text: (_view, ref) => who[ref.key] === undefined ? null : { text: "", ...who[ref.key] },
      people: (_machine, _view, use) => use({ tag: "known", list: () => known }),
    });
    const read = async (focus: string) => {
      const answer = await moment(asked(`/v1/page/moment?day=${golden.day}&focus=${encodeURIComponent(focus)}`, golden.window.end_ms + 7 * 86_400_000));
      expect(answer.status, focus).toBe(200);
      const body = JSON.parse(answer.body as string) as Body;
      PAGES.moment.shape.parse(body);
      return body;
    };
    const shared = await read("e47");
    expect([shared.state, shared.moment.view.name, shared.moment.view.others]).toEqual(["found", "Person A", [{ at_ms: starts.get("e31"), way: "They called", length_ms: 300_000 }]]);
    expect(shared.moment.view.week, "that week's calls with the ids its record shares, read from each day of it").toEqual({
      current: false,
      calls: [{ day: golden.day, at_ms: starts.get("e31"), title: "Phone call", icon: "call", length_ms: 300_000, focus: "rec:apple-calls:person-a@example.com:macbook-pro-0001 call CALL-0003" }],
    });
    expect(shared.moment.people.map((person: Body) => [person.name, person.person]), "the person whose handle the call's record names").toEqual([["Person A", "person-a"]]);
    pinned("moment.call", shared);
    const missed = await read("e50");
    expect([missed.moment.view.name, missed.moment.view.others]).toEqual(["+15550000006", [{ at_ms: starts.get("e51"), way: "You called", length_ms: 120_000 }]]);
    pinned("moment.missed", missed);
    for (const [name, focus] of [["moment.first", "e1"], ["moment.all-day", "e74"], ["moment.thread", "e13"]] as const) {
      const body = await read(focus);
      expect([body.state, body.moment.row]).toEqual(["found", focus]);
      pinned(name, body);
    }
    expect(await read("e999999")).toMatchObject({ state: "gone", moment: null });
  });

  it("pins a call recording's moments for the apps' suites from the callaudio journey's day, alone and joined: its summary and turns, each playing its own part from its time; with no recording read, none", async () => {
    const file = JSON.parse(readFileSync(RECORDED, "utf8")) as DayDocument;
    const held = recordingsOf(file);
    const made = (_view: OpenView, asked: readonly { family: string; item: string }[]): MomentMade[] => asked.map(({ family, item }) => ({
      by: "Model A", at_ms: file.window.start_ms, state: "done", line: "Model A · today", ask: { family, item, prompt: item.startsWith("stretch:") ? "call-summary" : "call-transcript" }, choose: [],
    }));
    const people = buildLabels({ places: [], people: [{
      record: {
        slug: "person-b", name: "Person B", full_name: null, show: "name", entity: "person", relationship: null, hidden: false, me: false,
        anchor: { kind: "phone", value: B }, handles: [], excluded: [], dismissed: [], merged_into: null, also_called: [],
      },
      since: new Map(), me_since: null, merged_since: null,
    }] });
    const settings: DaySettings = { zone: file.zone, day_start_hour: 4 };
    const labels = () => labelsFrom((unit) => {
      const content = people.contents.get(unit);
      return content === undefined ? undefined : { content };
    }, settings);
    const recorded = servedOver(file, { made, labels }, {
      extract: (family: string, unit: string) => family === CALLAUDIO_FAMILY ? held.extract(unit) : undefined,
      enrichment: (family: string, item: string) => family === CALLAUDIO_FAMILY ? held.enrichment(item) : undefined,
    });
    const read = async (served: { moment: typeof recorded.moment }, focus: string) => {
      const answer = await served.moment(asked(`/v1/page/moment?day=${file.day}&focus=${focus}`, file.window.end_ms));
      expect(answer.status, focus).toBe(200);
      const body = JSON.parse(answer.body as string) as Body;
      PAGES.moment.shape.parse(body);
      return body;
    };
    const turns = (body: Body) => (body.moment.view.recording.turns as Body[]).map((turn) => [turn.who, turn.words, turn.heard.record.kind, turn.heard.from_ms]);
    const alone = await read(recorded, "e1");
    expect([alone.state, alone.moment.title, alone.moment.view.name, alone.moment.view.recording.summary])
      .toEqual(["found", "Zoom", "Zoom", "You and they went over the lease renewal; you will send the signed copy."]);
    expect(turns(alone).slice(0, 2)).toEqual([["You", "Hello, can you hear me?", "mic-recording", 1_000], ["Them", "Yes, I can hear you.", "sound-recording", 11_000]]);
    expect([alone.moment.view.recording.made.state, alone.moment.view.recording.made.ask]).toEqual(["done", { family: CALLAUDIO_FAMILY, item: file.atoms[0]!.item, prompt: "call-transcript" }]);
    pinned("moment.recording", alone);
    const joined = await read(recorded, "e8");
    expect([joined.moment.title, joined.moment.view.name, joined.moment.people.map((person: Body) => person.name)]).toEqual(["Person B", "Person B", ["Person B"]]);
    expect(turns(joined)).toEqual([
      ["You", "Are we still on for Saturday?", "mic-recording", 1_000], ["Person B", "Yes, Saturday works for me.", "sound-recording", 11_000], ["You", "I will book the table.", "mic-recording", 41_000],
    ]);
    pinned("moment.recording-joined", joined);
    const dark = await read(servedOver(file), "e1");
    expect([dark.state, dark.moment.view.view, dark.moment.view.recording]).toEqual(["found", "call", null]);
  });

  it("pins a golden day whose second and third photos are a Live Photo and a 2 s video for the apps' suites: one row's tiles, its moment's gallery", async () => {
    const golden = JSON.parse(readFileSync(join(GOLDENS, "2031-03-04.day.json"), "utf8")) as DayDocument;
    const fixture = (name: string) => createHash("sha256").update(readFileSync(join(REPO, "dashboard", "test", "fixtures", name))).digest("hex");
    const atoms = golden.atoms as Body[];
    const first = atoms.find((atom) => atom.family === "photos")!;
    const [, live, video] = atoms.filter((atom) => atom.family === "photos" && atom.unit === first.unit);
    const films = { ...golden, atoms: atoms.map((atom) => atom === live ? { ...atom, item: `photo:${fixture("live.png")}`, text: "Photo: A chalked hand on a hold.", live: true }
      : atom === video ? { ...atom, item: `photo:${fixture("video.mp4")}`, text: "Video: 2s", video: { duration_ms: 2_000 } } : atom) } as DayDocument;
    const { route, moment } = servedOver(films);
    const now_ms = films.window.end_ms + 7 * 86_400_000;
    const day = JSON.parse((await route(asked(`/v1/page/day?day=${films.day}`, now_ms))).body as string) as Body;
    PAGES.day.shape.parse(day);
    const tiles = (row: Body) => (row.words as Body[]).flatMap((run) => run.type === "tiles" ? run.photos as Body[] : []);
    const rows = (day.chapters as Body[]).flatMap((chapter) => (chapter.blocks as Body[]).flatMap((block) => block.rows as Body[]));
    const row = rows.find((each) => tiles(each).some((tile) => tile.video))!;
    expect(tiles(row).map((tile) => [tile.hash, tile.video, tile.duration_ms, tile.live])).toEqual([
      [`sha256:${(first.item as string).slice("photo:".length)}`, false, null, false], [`sha256:${fixture("live.png")}`, false, null, true],
      [`sha256:${fixture("video.mp4")}`, true, 2_000, false],
    ]);
    pinned("day.films", day);
    const said = JSON.parse((await moment(asked(`/v1/page/moment?day=${films.day}&focus=${row.key}`, now_ms))).body as string) as Body;
    PAGES.moment.shape.parse(said);
    expect([said.state, said.moment.row]).toEqual(["found", row.key]);
    expect((said.moment.pictures as Body[]).map((picture) => [picture.words, picture.video, picture.duration_ms, picture.live])).toEqual([
      ["a synthetic cafe table", false, null, false], ["A chalked hand on a hold.", false, null, true], ["", true, 2_000, false],
    ]);
    pinned("moment.films", said);
  });

  it("pins a golden day with no place for the apps' suites: its rows stand in one placeless chapter, the side has no place", async () => {
    const file = JSON.parse(readFileSync(join(GOLDENS, "2031-04-05.day.json"), "utf8"));
    const placeless = JSON.parse((await servedOver(file).route(asked(`/v1/page/day?day=${file.day}`, file.window.end_ms + 7 * 86_400_000))).body as string) as Body;
    expect((placeless.chapters as Body[]).map((chapter) => chapter.kind)).toEqual(["day"]);
    expect([placeless.side.located, placeless.side.places]).toEqual([false, []]);
    pinned("day.placeless", placeless);
  });

  it("pins golden days with the side the home's reads give them for the apps' suites: places, people and calls; stays at places the person did not name; twelve places; brief stops, none ten minutes long", async () => {
    const golden = (day: string) => JSON.parse(readFileSync(join(GOLDENS, `${day}.day.json`), "utf8"));
    const sideOf = (day: string): DaySideExtras => JSON.parse(readFileSync(join(SIDES, `${day}.json`), "utf8"));
    const sided = async (file: DayDocument & { sleep?: Record<string, { start_ms: number; end_ms: number }>; sent?: string[]; groups?: string[] }, side: DaySideExtras): Promise<Body> => {
      const { position, today } = JSON.parse((await servedOver(file).route(asked(`/v1/page/day?day=${file.day}`, file.window.end_ms + 7 * 86_400_000))).body as string) as Body;
      const extras = { sleep: file.sleep ?? {}, sent: file.sent ?? [], groups: file.groups ?? [], products: {}, ...side };
      return PAGES.day.shape.parse({ position, today, ...dayBody(file.day, dayPage(file, extras, null)) }) as Body;
    };
    const day = golden("2031-03-04");
    const side = await sided(day, sideOf("2031-03-04"));
    expect((side.side.places as Body[]).map((place) => [place.name, place.slug, place.home])).toEqual([
      ["Synthetic Home", "synthetic-home", true], ["Synthetic Office", null, false], ["Synthetic Cafe", null, false],
      ["Synthetic City", null, false], ["Synthetic Port Town", null, false],
    ]);
    expect((side.side.people as Body[]).map((person) => [person.name, person.person])).toEqual([["Person A", "person-a"], ["Person C", "person-c"], ["+15550000006", null]]);
    expect((side.side.unreturned as Body[]).map((call) => call.key)).toEqual(["e52"]);
    pinned("day.side", side);

    const unnamedDay = golden("2031-06-12");
    const message = (day.atoms as Body[]).find((atom) => atom.family === "messages" && atom.block !== undefined)!;
    const withRow = { ...unnamedDay, atoms: [...unnamedDay.atoms, { ...message, n: 100, unit: "2031-06-12:whatsapp:15550000001@s.whatsapp.net", start_ms: 1939013000000, local_start: "16:13" }]
      .sort((left: Body, right: Body) => left.start_ms - right.start_ms) };
    const unnamed = await sided(withRow, sideOf("2031-06-12"));
    const heads = (unnamed.chapters as Body[]).filter((chapter) => chapter.kind === "stay").map((chapter) => [chapter.head.title, chapter.head.quiet,
      (chapter.blocks as Body[]).reduce((rows, block) => rows + block.rows.length, 0)]);
    expect(heads).toEqual([["Synthetic Home", false, 0], ["Near Synthetic Home", true, 0], ["Fresh from Synthetic Farm", false, 0], ["Near Fresh from Synthetic Farm", true, 0],
      ["Synthetic Port Town", true, 0], ["Unnamed place", true, 1], ["a hidden place", true, 0], ["Synthetic Home", false, 0]]);
    pinned("day.unnamed", unnamed);

    const names = ["Synthetic Market", "Synthetic Library", "Synthetic Station", "Harbour Point Light Station State Park", "Synthetic Hotel", "Synthetic Museum",
      "Synthetic Pier", "Synthetic Gardens", "Synthetic Terminal", "Synthetic Bakery", "Synthetic Theatre", "Synthetic Gallery"];
    let from = day.window.start_ms as number;
    const where = names.map((name, index): WherePiece => {
      const point = index < 6 ? { latitude: 51.5 + 0.01 * index, longitude: -0.12 + 0.012 * index } : { latitude: 38.72 + 0.01 * (index - 6), longitude: -9.14 + 0.012 * (index - 6) };
      const start_ms = from;
      from += (90 - 5 * index + (index === 5 ? 180 : 5)) * MINUTE;
      return { kind: "stay", start_ms, end_ms: start_ms + (90 - 5 * index) * MINUTE, point, units: [`stay/travel/${index}`], place: { slug: `tr-${String(index + 1).padStart(2, "0")}`, name } };
    });
    const travel = await sided(day, { ...sideOf("2031-03-04"), where, places: [] });
    expect((travel.side.places as Body[]).map((place) => [place.slug, place.length])).toEqual(names.map((_, index) => [`tr-${String(index + 1).padStart(2, "0")}`, expect.any(String)]));
    pinned("day.travel", travel);

    const stopped = (day.window.start_ms as number) + 600 * MINUTE;
    const stops = [["Synthetic Kiosk", 6], ["Synthetic Corner", 4]] as const;
    const brief = await sided(day, { ...sideOf("2031-03-04"), places: [], where: stops.map(([name, minutes], index): WherePiece => ({
      kind: "stay", start_ms: stopped + index * 30 * MINUTE, end_ms: stopped + index * 30 * MINUTE + minutes * MINUTE,
      point: { latitude: 10.05 + 0.01 * index, longitude: 76.05 + 0.01 * index }, units: [`stay/brief/${index}`], place: { slug: `br-0${index + 1}`, name },
    })) });
    expect((brief.side.places as Body[]).map((place) => [place.slug, place.ms])).toEqual([["br-01", 6 * MINUTE], ["br-02", 4 * MINUTE]]);
    expect([brief.side.located, (brief.side.people as Body[]).length, (brief.side.figures as Body[]).length > 0]).toEqual([true, 3, true]);
    pinned("day.brief", brief);
  });

  it("words a voice note's length once, its seconds rounded", () => {
    expect([lengthOf(0.4), lengthOf(12.4), lengthOf(59.6), lengthOf(65.5), lengthOf(3_600)]).toEqual(["0:00", "0:12", "1:00", "1:06", "60:00"]);
  });
});

describe("The days, day and thread pages through the door", () => {
  let root: string;
  let home: Home;
  let door: Door;
  let url = "";
  let now = at(TODAY, "14:00");
  let shipped = 0;
  const report: Record<string, unknown> = {};

  const imported = (id: string) => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) === "imported";
  const ran = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get()) === 0;
  const send = async (source: string, rows: object[]) => {
    const id = await ship(root, { source, fetched_ms: now + shipped * MINUTE, rows: rows as never });
    shipped++;
    await until(`${id} imported and its days written after it`, () => imported(id) && ran());
  };
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${READER}`, ...headers } });
    const text = await response.text();
    return { status: response.status, etag: response.headers.get("etag"), body: text === "" ? null : JSON.parse(text) as Body };
  };
  const page = async (name: "days" | "day" | "thread" | "moment", query: string) => {
    const answer = await get(`${PAGES[name].route}${query}`);
    expect(answer.status, `${PAGES[name].route}${query}`).toBe(200);
    PAGES[name].shape.parse(answer.body);
    return answer;
  };
  const rowsOf = (body: Body) => (body.chapters as Body[]).flatMap((chapter) => (chapter.blocks as Body[]).flatMap((block) => block.rows as Body[]));

  beforeAll(async () => {
    root = makeRoot("lifestream-page-days-", { sources: { [LOCATION]: "days-rows", [WHATSAPP]: "days-rows", [CALENDAR]: "days-rows" }, settings: { unit: UNIT, "day.zone": ZONE } });
    mintPrincipal(openHomeFolder(root), { unit: "reader-0001", scopes: ["read"], token: READER, now_ms: 0 });
    home = await startHome(root, { registry: REGISTRY, clock: () => now, log: () => undefined });
    door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: REGISTRY, clock: () => now });
    url = `http://127.0.0.1:${door.port}`;
    await send(LOCATION, [
      ...stays([[at(PAST, "08:00"), at(PAST, "11:00"), HOME], [at(PAST, "11:30"), at(PAST, "18:00"), WORK]]),
      ...stays([[at(TODAY, "08:00"), at(TODAY, "13:30"), HOME]]),
    ]);
    await send(WHATSAPP, [
      wa("p1", jid(A), at(PAST, "10:00"), true), wa("p2", jid(A), at(PAST, "10:01")), wa("p3", jid(A), at(PAST, "10:02"), true),
      wa("t1", jid(B), at(TODAY, "11:00")), wa("t2", jid(B), at(TODAY, "11:02"), true),
    ]);
    await send(CALENDAR, [event("plan-today", at(TODAY, "16:00"), at(TODAY, "17:00"), "Synthetic plan"), event("met-today", at(TODAY, "09:00"), at(TODAY, "09:30"), "Synthetic standup")]);
  });

  afterAll(async () => {
    await door?.close();
    await home?.stop().catch(() => undefined);
    mkdirSync(join(REPO, "packages", "home", ".build", "e2e"), { recursive: true });
    writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "page-days.json"), `${JSON.stringify(report, null, 2)}\n`);
    if (root !== undefined) removeRoot(root);
  });

  it("lists the written days and opens on today when today is written", async () => {
    const { body } = await page("days", "");
    expect(body!.today).toBe(TODAY);
    expect(body!.opening).toBe(TODAY);
    expect(body!.days.map((each: Body) => each.day)).toEqual(expect.arrayContaining([PAST, TODAY]));
    expect(body!.days.find((each: Body) => each.day === PAST).counts.total).toBeGreaterThan(0);
    expect(body!.next).toBeNull();
    const paged = await page("days", "?limit=1");
    expect([paged.body!.days.length, paged.body!.next]).toEqual([1, paged.body!.days[0].day]);
    report.days = body;
    pinned("days.full", body!);
  });

  it("builds a past day with no now, no open stay and no plans", async () => {
    const { body } = await page("day", `?day=${PAST}`);
    expect([body!.day, body!.state, body!.now_ms, body!.plans, body!.until_ms]).toEqual([PAST, "ready", null, [], null]);
    const stays = (body!.chapters as Body[]).filter((chapter) => chapter.kind === "stay");
    expect(stays.length, "two stays").toBeGreaterThanOrEqual(2);
    expect(stays.every((chapter) => chapter.end_ms !== null), "a past day's stays are closed").toBe(true);
    expect(rowsOf(body!).some((row) => row.kind === "conversation"), "the chat with A").toBe(true);
    expect(body!.side.people.length + body!.side.groups.length, "the side names who wrote").toBeGreaterThan(0);
    report.past = body;
    pinned("day.past", body!);
  });

  it("builds today at now: the last stay open, the event after now a plan, until its start", async () => {
    const { body } = await page("day", `?day=${TODAY}`);
    expect([body!.state, body!.now_ms]).toEqual(["ready", at(TODAY, "14:00")]);
    const last = (body!.chapters as Body[]).filter((chapter) => chapter.kind === "stay").at(-1);
    expect(last?.end_ms, "the last stay is open: its last fix is within the hour").toBeNull();
    expect((body!.plans as Body[]).map((plan) => plan.at_ms)).toEqual([at(TODAY, "16:00")]);
    expect(body!.until_ms).toBe(at(TODAY, "16:00"));
    expect(rowsOf(body!).filter((row) => row.kind === "event" && row.at_ms === at(TODAY, "16:00")), "the plan left the chapters").toEqual([]);
    expect(rowsOf(body!).some((row) => row.kind === "event" && row.at_ms === at(TODAY, "09:00")), "an event before now stays in its chapter").toBe(true);
    report.today = body;
    pinned("day.today", body!);
  });

  it("builds the day that was today once the day has turned: no now, no plans, every stay closed", async () => {
    const held = now;
    now = at(addDays(TODAY, 1), "10:00");
    try {
      const { body } = await page("day", `?day=${TODAY}`);
      expect([body!.day, body!.now_ms, body!.plans, body!.until_ms]).toEqual([TODAY, null, [], null]);
      expect((body!.chapters as Body[]).filter((chapter) => chapter.end_ms === null), "the day that was today closed its last stay").toEqual([]);
      pinned("day.turned", body!);
    } finally {
      now = held;
    }
  });

  it("answers a day with nothing as empty, in the page's shape, saying it is before the home's first day only when it is", async () => {
    const { body } = await page("day", `?day=${EMPTY_DAY}`);
    expect([body!.state, body!.chapters, body!.now_ms, body!.line]).toEqual(["empty", [], null, "Nothing recorded this day."]);
    expect(body!.before_home).toBe(BEFORE_HOME);
    pinned("day.empty", body!);
    const after = await page("day", `?day=${addDays(TODAY, 1)}`);
    expect([after.body!.state, after.body!.before_home]).toEqual(["empty", null]);
    pinned("day.nothing", after.body!);
  });

  it("answers the day's chat as its thread", async () => {
    const { body } = await page("thread", `?chat=${encodeURIComponent(`whatsapp:${jid(A)}`)}&day=${PAST}`);
    expect(body!.chat).toBe(`whatsapp:${jid(A)}`);
    expect((body!.messages as Body[]).map((message) => [message.at_ms, message.mine, message.text])).toEqual([
      [at(PAST, "10:00"), true, "synthetic line p1"], [at(PAST, "10:01"), false, "synthetic line p2"], [at(PAST, "10:02"), true, "synthetic line p3"],
    ]);
    expect((body!.messages as Body[]).every((message) => message.voice === null && message.quote === null && message.reactions.length === 0)).toBe(true);
    pinned("thread.full", body!);
  });

  it("answers a row's moment through the door: a chat with its thread, a stay with its time here, a row it no longer holds gone, a day with nothing empty", async () => {
    const day = (await page("day", `?day=${PAST}`)).body!;
    const chat = rowsOf(day).find((row) => row.kind === "conversation")!;
    const said = (await page("moment", `?day=${PAST}&focus=${chat.key}`)).body!;
    expect([said.state, said.moment.row, said.moment.view.view, said.moment.view.group]).toEqual(["found", chat.key, "thread", false]);
    expect(said.moment.view.chat, "the chat the thread page reads").not.toBeNull();
    const stay = (day.chapters as Body[]).find((chapter) => chapter.kind === "stay" && chapter.episode !== null)!;
    const here = (await page("moment", `?day=${PAST}&focus=${stay.episode}`)).body!;
    expect([here.moment.kind, here.moment.view.view, here.moment.view.today_ms > 0]).toEqual(["stay", "stay", true]);
    expect((await page("moment", `?day=${PAST}&focus=e999999`)).body).toMatchObject({ state: "gone", moment: null });
    expect((await page("moment", `?day=${addDays(PAST, -400)}&focus=e1`)).body).toMatchObject({ state: "empty", moment: null });
  });

  it("opens a row drawn before a delivery at its own moment once an earlier record has renumbered the day's rows", async () => {
    const drawn = rowsOf((await page("day", `?day=${PAST}`)).body!).find((row) => row.kind === "conversation")!;
    const opened = (await page("moment", `?day=${PAST}&focus=${encodeURIComponent(drawn.focus)}&marks=${encodeURIComponent("[]")}`)).body!;
    expect([opened.state, opened.moment.row, opened.moment.marks]).toEqual(["found", drawn.key, []]);
    await send(WHATSAPP, [wa("p0", jid(B), at(PAST, "09:00"))]);
    const redrawn = rowsOf((await page("day", `?day=${PAST}`)).body!).find((row) => row.focus === drawn.focus)!;
    expect(redrawn.key, "the earlier record moved the row's number").not.toBe(drawn.key);
    const again = (await page("moment", `?day=${PAST}&focus=${encodeURIComponent(drawn.focus)}&marks=${encodeURIComponent("[]")}`)).body!;
    expect([again.state, again.moment.row, again.moment.marks, again.moment.view.chat]).toEqual(["found", redrawn.key, [], opened.moment.view.chat]);
    expect((await page("moment", `?day=${PAST}&focus=${drawn.key}`)).body!.moment?.view.chat, "the old number names another moment now").not.toBe(opened.moment.view.chat);
  });

  it("answers 304 on the ETag, a new one when a delivery names the day, and for today when the minute turns", async () => {
    const past = await page("day", `?day=${PAST}`);
    const today = await page("day", `?day=${TODAY}`);
    expect((await get(`/v1/page/day?day=${PAST}`, { "if-none-match": past.etag! })).status).toBe(304);
    expect((await get(`/v1/page/day?day=${TODAY}`, { "if-none-match": today.etag! })).status).toBe(304);

    now += MINUTE;
    expect((await get(`/v1/page/day?day=${PAST}`, { "if-none-match": past.etag! })).status, "a past day holds a minute on").toBe(304);
    const turned = await get(`/v1/page/day?day=${TODAY}`, { "if-none-match": today.etag! });
    expect([turned.status, turned.body?.now_ms], "today moved with the minute").toEqual([200, at(TODAY, "14:01")]);

    await send(WHATSAPP, [wa("p4", jid(A), at(PAST, "20:00"))]);
    const landed = await get(`/v1/page/day?day=${PAST}`, { "if-none-match": past.etag! });
    expect(landed.status, "a message on the day moved its ETag").toBe(200);
    PAGES.day.shape.parse(landed.body);
    expect(landed.etag).not.toBe(past.etag);
    expect((await get(`/v1/page/day?day=${PAST}`, { "if-none-match": landed.etag! })).status).toBe(304);
  });

  it("refuses a day that is no day, and is read for no model", async () => {
    expect((await get("/v1/page/day?day=yesterday")).body).toMatchObject({ code: "BAD_PARAMETER" });
    expect((await get("/v1/page/day")).body).toMatchObject({ code: "BAD_PARAMETER" });
    expect((await get(`/v1/page/day?day=${PAST}`, { "lifestream-reader": "model" })).body).toMatchObject({ code: "PRINCIPAL_SCOPE" });
  });

  it("times a large day's page on the 200 and the 304 path, printed for the evidence step", async () => {
    const CHATS = 40, EACH = 100, READS = 5;
    const chat = (n: number) => jid(`+1555002${String(n).padStart(4, "0")}`);
    await send(LOCATION, stays([[at(LARGE, "04:30"), at(LARGE, "09:00"), HOME], [at(LARGE, "09:30"), at(LARGE, "19:00"), WORK], [at(LARGE, "19:30"), at(addDays(LARGE, 1), "03:30"), HOME]]));
    await send(WHATSAPP, Array.from({ length: CHATS * EACH }, (_, n) => wa(`l${n}`, chat(n % CHATS), at(LARGE, "05:00") + n * 11_000, n % 3 === 0)));
    const built: number[] = [], held: number[] = [];
    let etag = "";
    let rows = 0;
    for (let read = 0; read < READS; read++) {
      const began = performance.now();
      const answer = await get(`/v1/page/day?day=${LARGE}`);
      built.push(performance.now() - began);
      expect(answer.status).toBe(200);
      etag = answer.etag!;
      rows = rowsOf(answer.body!).length;
    }
    for (let read = 0; read < READS; read++) {
      const began = performance.now();
      const answer = await get(`/v1/page/day?day=${LARGE}`, { "if-none-match": etag });
      held.push(performance.now() - began);
      expect(answer.status).toBe(304);
    }
    Object.assign(report, { large: { messages: CHATS * EACH, rows, page_ms: built, held_ms: held, page_median_ms: median(built), held_median_ms: median(held), budgets_ms: [300, 30] } });
    process.stdout.write(`page /v1/page/day on a day of ${CHATS * EACH} messages: 200 median ${median(built).toFixed(1)} ms (budget 300), 304 median ${median(held).toFixed(1)} ms (budget 30), over ${READS} reads each\n`);
  });
});

