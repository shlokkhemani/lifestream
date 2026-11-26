import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, instant, openHome, openHomeFolder } from "@lifestreamprotocol/core";
import { recordFocus, unitFocus, VOICE_TRANSCRIPT } from "@lifestreamprotocol/families";
import { serveDoor, type Door } from "./door.js";
import { startHome, type Home } from "./home.js";
import { BEFORE_HOME } from "./page-days.js";
import { PAGES } from "./pages.js";
import { mintPrincipal } from "./principals.js";
import { effective } from "./settings.js";
import { dayWords } from "./stream-words.js";
import { clientFixture, FAKE_OFFER, makeRoot, readHome, removeRoot, REPO, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { BANK_CONNECTOR } from "./test/canned-days-registry.js";

const ZONE = "Asia/Kolkata";
const UNIT = "iphone-aa01";
const LOCATION = `location:local:${UNIT}`;
const LOCATION_BEFORE_OFF = "location:local:iphone-aa00";
const PLACES = `places:local:${UNIT}`;
const WHATSAPP = `whatsapp:15550000000:${UNIT}`;
const IMESSAGE = `imessage:+15550000090:${UNIT}`;
const BOOK = `apple-contacts:local:${UNIT}`;
const CALLS = `apple-calls:sam.2014@example.com:${UNIT}`;
const CALENDAR = "google-calendar:person-a@example.com:cloud";
const HEALTH = "apple-health:person-a@example.com:cloud";
const BANK = "synthetic-bank:acct-aa11:export";
const PHOTOS = `apple-photos:person-a@example.com:${UNIT}`;
const GMAIL = "gmail:person-a@example.com:cloud";
const SCREEN_TIME = `screen-time:local:${UNIT}`;
const VOICE = `voice-notes:local:${UNIT}`;
const CANNED = join(REPO, "homelink", "Tests", "Fixtures", "pages", "canned");
const REGISTRY = join(REPO, "packages", "home", "test", "canned-days-registry.ts");
const READER = "synthetic-canned-days-reader".padEnd(43, "r");
const APPLE_EPOCH_S = 978_307_200;
const PINNED = Date.parse("2026-11-07T22:30:00+05:30");
const TODAY = "2026-11-07";
const START_HOUR = 4;
const MINUTE = 60_000;
const STILL_EVERY = 2 * MINUTE;
const MOVING_EVERY = 20_000;
const BEFORE_BACK = 500;
const NEWEST = 21;
const WRITTEN_BACKS = [...Array.from({ length: NEWEST }, (_, back) => back), 22, 40];
const OFF_BACK = 9;
const SLEEP = "HKCategoryTypeIdentifierSleepAnalysis";

type Body = Record<string, any>;
type Point = { latitude: number; longitude: number };
type Shape = "weekday" | "weekend" | "quiet" | "tripOut" | "tripAway" | "tripBack" | "past";
type Piece = { from: number; to: number; at: Point } | { from: number; to: number; leave: Point; reach: Point };

const HOME: Point = { latitude: 37.3349, longitude: -122.009 };
const OFFICE: Point = { latitude: 37.322, longitude: -121.987 };
const SPOT: Point = { latitude: 37.3187, longitude: -122.009 };
const STOP: Point = { latitude: 37.3274, longitude: -122.001 };
const AWAY: Point = { latitude: 36.6002, longitude: -121.8947 };
const SPOT_KEY = `spot:${SPOT.latitude},${SPOT.longitude}`;
const CLEAR_M = 120;

const A = "+15550000001", B = "+15550000002", C_MAIL = "person-c@example.com";
const jid = (phone: string) => `${phone.slice(1)}@s.whatsapp.net`;
const ALPHA = "120363000000000001@g.us";

const LAST_MONTH = (() => {
  const [year, month] = [Number(TODAY.slice(0, 4)), Number(TODAY.slice(5, 7))];
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
})();
const TRIP = [12, 13, 14].map((day) => `${LAST_MONTH}-${day}`);
const YESTERDAY = addDays(TODAY, -1);
const UNWRITTEN = addDays(TODAY, -BEFORE_BACK);

const midnight = (day: string) => instant(`${day}T00:00:00`, "local", { zone: ZONE }).start_ms;
const hour = (day: string, hours: number) => midnight(day) + Math.round(hours * 3600) * 1000;
const backOf = (day: string) => Math.round((Date.parse(`${TODAY}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
const weekend = (day: string) => [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
const drift = (back: number) => ((back * 17) % 23) / 60;
const iso = (ms: number) => new Date(ms).toISOString();
const stanzaOf = (chat: string, day: string, hours: number) => `${chat}-${day}-${Math.round(hours * 600)}`;
const caseOf = (words: string) => words.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");

function shapeOf(day: string): Shape {
  const trip = TRIP.indexOf(day);
  if (trip >= 0) return (["tripOut", "tripAway", "tripBack"] as const)[trip]!;
  const back = backOf(day);
  if (back >= NEWEST) return "past";
  if (!weekend(day)) return "weekday";
  const quiet = [7, 8, 9, 10, 11, 12, 13].find((each) => weekend(addDays(TODAY, -each)));
  return back === quiet ? "quiet" : "weekend";
}

const noodled = (day: string) => shapeOf(day) === "weekday" && backOf(day) === Array.from({ length: NEWEST }, (_, back) => back).find((back) => back % 3 === 0 && shapeOf(addDays(TODAY, -back)) === "weekday");

const busy = (day: string) => shapeOf(day) === "weekday" && backOf(day) === [1, 2, 3, 4, 5, 6].find((each) => !weekend(addDays(TODAY, -each)));

function piecesOf(day: string): Piece[] {
  if (backOf(day) === OFF_BACK) return [];
  const start = START_HOUR, end = 24 + START_HOUR;
  const stay = (at: Point, from: number, to: number): Piece => ({ from: hour(day, from), to: hour(day, to), at });
  const move = (leave: Point, reach: Point, from: number, to: number): Piece => ({ from: hour(day, from), to: hour(day, to), leave, reach });
  const trip = TRIP.indexOf(day);
  if (trip === 0) return [stay(HOME, start, 9), move(HOME, AWAY, 9, 12), stay(AWAY, 12, end)];
  if (trip === 1) return [stay(AWAY, start, end)];
  if (trip === 2) return [stay(AWAY, start, 16), move(AWAY, HOME, 16, 19), stay(HOME, 19, end)];
  const homeward = (leave: number, walk: number): Piece[] => backOf(day) !== 1
    ? [move(SPOT, HOME, leave, leave + walk), stay(HOME, leave + walk, end)]
    : [move(SPOT, STOP, leave, leave + 0.1), stay(STOP, leave + 0.1, leave + 0.5), move(STOP, HOME, leave + 0.5, leave + 0.8), stay(HOME, leave + 0.8, end)];
  if (weekend(day)) return [stay(HOME, start, 10.5), move(HOME, SPOT, 10.5, 10.8), stay(SPOT, 10.8, 12.2), ...homeward(12.2, 0.3)];
  return [stay(HOME, start, 8.5), move(HOME, OFFICE, 8.5, 8.9), stay(OFFICE, 8.9, 17.6), move(OFFICE, SPOT, 17.6, 17.85), stay(SPOT, 17.85, 19), ...homeward(19, 0.4)];
}

let fixes = 0;
function fix(ms: number, point: Point, speed: number) {
  const n = ++fixes;
  return {
    kind: "fix", key: `44444444-4444-4444-8444-444444444444:${n}`, time: { start_ms: ms, precision: "ms" },
    content: { type: "location.fix", content: { kind: "fix", payload: { location: { timestamp_rfc3339_utc: iso(ms), latitude: point.latitude, longitude: point.longitude, horizontal_accuracy: 5, altitude: 20, speed } } } },
  };
}

const metres = (from: Point, to: Point) => Math.hypot((to.latitude - from.latitude) * 111_195, (to.longitude - from.longitude) * 111_195 * Math.cos(from.latitude * Math.PI / 180));

function fixesOf(piece: Piece): object[] {
  if ("at" in piece) return Array.from({ length: Math.ceil((piece.to - piece.from) / STILL_EVERY) }, (_, n) => fix(piece.from + n * STILL_EVERY, piece.at, 0));
  const steps = Math.max(1, Math.ceil((piece.to - piece.from) / MOVING_EVERY));
  const { leave, reach } = piece;
  const along = Array.from({ length: steps }, (_, n) => ({ n, at: {
    latitude: leave.latitude + ((reach.latitude - leave.latitude) * n) / steps,
    longitude: leave.longitude + ((reach.longitude - leave.longitude) * n) / steps,
  } }));
  return along.filter(({ at }) => metres(leave, at) > CLEAR_M && metres(at, reach) > CLEAR_M).map(({ n, at }) => fix(piece.from + n * MOVING_EVERY, at, 2));
}

function carry(name: string, carried: Record<string, Buffer>, bytes: Buffer = readFileSync(join(CANNED, name))) {
  const hex = createHash("sha256").update(bytes).digest("hex");
  carried[hex] = bytes;
  return { hash: `sha256:${hex}`, bytes: bytes.length };
}

type Carries = { media?: { file: string; video: boolean; carried: Record<string, Buffer> }; replying?: string };

function wa(stanza: string, chat: string, when: number, words: string | null, mine: boolean, member: string | null = null, { media, replying }: Carries = {}) {
  const date = when / 1000 - APPLE_EPOCH_S;
  const held = media === undefined ? null : carry(media.file, media.carried);
  const message = {
    ZSTANZAID: stanza, ZTEXT: words, ZFROMJID: mine ? null : chat, ZTOJID: null, ZPUSHNAME: null, ZMESSAGEDATE: date, ZSENTDATE: date,
    ZMESSAGETYPE: media === undefined ? 0 : media.video ? 2 : 1, ZGROUPEVENTTYPE: null, ZFLAGS: 0, ZMESSAGESTATUS: 1, ZMESSAGEERRORSTATUS: 0, ZISFROMME: mine ? 1 : 0, ZSTARRED: 0,
  };
  return {
    kind: "msg", key: `${chat}:${stanza}`, time: { start_ms: when, precision: "ms" }, ...held === null ? {} : { blobs: [held.hash] },
    content: {
      type: "whatsapp.msg", message, session_jid: chat, parent_stanza_id: replying ?? null, media_item: null, group_member_jid: mine ? null : member,
      blobs: held === null ? [] : [{ hash: held.hash, bytes: held.bytes, role: "ZWAMEDIAITEM.ZMEDIALOCALPATH" }],
    },
  };
}

function imessage(stanza: string, when: number, words: string, mine: boolean) {
  const handle = { kind: "email", canonical: C_MAIL };
  return {
    kind: "msg", key: stanza, time: { start_ms: when, precision: "ms" },
    content: mine
      ? { type: "imessage.msg", sender: null, recipients: [handle], flags: { is_from_me: 1 }, text: words }
      : { type: "imessage.msg", sender: handle, recipients: [], flags: { is_from_me: 0 }, text: words },
  };
}

function phoneCall(id: string, when: number, seconds: number, outgoing: boolean, phone: string) {
  const handle = { ZTYPE: 2, ZNORMALIZEDVALUE: phone, ZVALUE: phone };
  return {
    kind: "call", key: id, time: { start_ms: when, precision: "s" }, content: {
      type: "apple.call", initiator: outgoing ? null : handle, handles: [handle], emergency_media: [],
      call: { ZUNIQUE_ID: id, ZDATE: when / 1000 - APPLE_EPOCH_S, ZDURATION: seconds, ZORIGINATED: outgoing ? 1 : 0, ZANSWERED: 1, ZSERVICE_PROVIDER: "com.apple.Telephony", ZCALL_CATEGORY: 1, ZNAME: null },
    },
  };
}

function event(key: string, start: number, end: number, summary: string) {
  const stamp = (ms: number) => iso(ms).replace(/[-:]/gu, "").replace(/\.\d{3}/u, "");
  const lines = ["BEGIN:VEVENT", `UID:${key}@example.com`, `DTSTAMP:${stamp(start)}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`, `SUMMARY:${summary}`, "END:VEVENT", ""];
  return { kind: "event", key: `${key}@example.com`, time: { start_ms: start, end_ms: end, precision: "s" }, content: { type: "calendar.event", content: lines.join("\r\n") } };
}

function allDay(key: string, day: string, summary: string) {
  const date = (each: string) => each.replaceAll("-", "");
  const lines = ["BEGIN:VEVENT", `UID:${key}@example.com`, `DTSTAMP:${date(day)}T000000Z`, `DTSTART;VALUE=DATE:${date(day)}`, `DTEND;VALUE=DATE:${date(addDays(day, 1))}`, `SUMMARY:${summary}`, "END:VEVENT", ""];
  const start = Date.parse(`${day}T00:00:00Z`);
  return { kind: "event", key: `${key}@example.com`, time: { start_ms: start, end_ms: start + 86_400_000, precision: "day" }, content: { type: "calendar.event", content: lines.join("\r\n") } };
}

function sample(key: string, from: number, to: number, type: string, value: string, unit: string | null) {
  return {
    kind: "sample", key, time: { start_ms: from, end_ms: to, precision: "s" },
    content: { type: "health.sample", sample_type: type, source_name: "iPhone", value, ...(unit === null ? {} : { unit }), metadata: {} },
  };
}

function workout(key: string, from: number, to: number, activity: string) {
  return {
    kind: "workout", key, time: { start_ms: from, end_ms: to, precision: "s" },
    content: { type: "health.workout", source_name: "iPhone", value: `HKWorkoutActivityType${activity}`, detail: { duration_s: (to - from) / 1000 }, metadata: {} },
  };
}

const card = (...lines: string[]) => {
  const text = `BEGIN:VCARD\r\nVERSION:3.0\r\n${lines.map((line) => `${line}\r\n`).join("")}END:VCARD\r\n`;
  return { kind: "contact", key: createHash("sha256").update(text).digest("hex"), content: { type: "contacts.card", card: text } };
};
const chatRow = (chat: string, title: string) => ({ kind: "chat", key: chat, content: { type: "whatsapp.chat", group_info: null,
  chat: { ZCONTACTJID: chat, ZCONTACTIDENTIFIER: null, ZPARTNERNAME: title, ZSESSIONTYPE: 1, ZARCHIVED: 0 } } });
const place = (slug: string, name: string, centre: Point, radius_m: number, home?: true) => ({ kind: "place", key: slug, content: { type: "places.place", name, centre, radius_m, ids: [], ...home && { home } } });

type Said = { whatsapp: object[]; imessage: object[]; calls: object[]; calendar: object[]; health: object[]; bank: object[]; photos: object[]; mail: object[]; usage: object[]; voice: object[]; carried: Record<string, Buffer> };
type Shot = { file: string; seconds: number | null; motion: string | null };

const CHAT_MEDIA = [
  { file: "chat.table.jpg", video: false }, { file: "chat.street.mov", video: true },
  { file: "chat.menu.jpg", video: false }, { file: "chat.door.mov", video: true },
];
const NOODLES: Shot[] = [{ file: "noodles.bowl.jpg", seconds: null, motion: null }, { file: "noodles.closer.jpg", seconds: null, motion: null }];

const TRIP_SHOTS: Shot[] = [
  { file: "trip.street.jpg", seconds: null, motion: null },
  { file: "trip.market.jpg", seconds: null, motion: null },
  { file: "trip.square.mov", seconds: 4, motion: null },
  { file: "trip.courtyard.jpg", seconds: null, motion: "trip.courtyard.mov" },
];

function shot(id: string, when: number, { file, seconds, motion }: Shot, carried: Record<string, Buffer>) {
  const held = (type: string, type_raw: number, uti: string, media: string, name: string) => {
    const blob = carry(name, carried);
    return { type, type_raw, uti, original_filename: name, blob: { ...blob, type: media, role: type } };
  };
  const resources = [
    seconds === null ? held("photo", 1, "public.jpeg", "image/jpeg", file) : held("video", 2, "com.apple.quicktime-movie", "video/quicktime", file),
    ...motion === null ? [] : [held("pairedVideo", 9, "com.apple.quicktime-movie", "video/quicktime", motion)],
  ];
  const payload = {
    local_identifier: id, cloud_identifier: null, modification_date: null, creation_date: iso(when), media_type: seconds === null ? "image" : "video",
    media_subtypes: 0, pixel_width: 1200, pixel_height: 900, location: null, favorite: false, hidden: false, resources, ...seconds === null ? {} : { duration: seconds },
  };
  return { kind: "img", key: `${id}:null`, time: { start_ms: when, precision: "ms" }, content: { type: "photos.apple.asset", content: payload }, blobs: resources.map((each) => each.blob.hash) };
}

function voiceNote(key: string, from: number, seconds: number, carried: Record<string, Buffer>) {
  const { hash } = carry(key, carried, Buffer.from(`synthetic voice note ${key}`));
  const to = from + seconds * 1000;
  return {
    kind: "voice", key, time: { start_ms: from, end_ms: to, precision: "s" }, blobs: [hash],
    content: { type: "voice.note", content: { payload: {
      blob: { hash, type: "audio/mp4" }, duration_seconds: seconds, started_at: iso(from), ended_at: iso(to), location: null,
    } } },
  };
}

function mail(key: string, when: number, from: string, subject: string, words: string, carried: Record<string, Buffer>) {
  const bytes = Buffer.from([`From: ${from}`, "To: person-a@example.com", `Subject: ${subject}`, `Date: ${new Date(when).toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${key}@example.com>`, "Content-Type: text/plain; charset=utf-8", "", words, ""].join("\r\n"));
  const hex = createHash("sha256").update(bytes).digest("hex");
  carried[hex] = bytes;
  const blob = `sha256:${hex}`;
  const provider = { gm_msgid: key, gm_thrid: key, folder: "[Gmail]/All Mail", labels: ["\\Inbox"], internaldate: iso(when) };
  return {
    kind: "mailmsg", key, time: { start_ms: when, precision: "s" }, blobs: [blob],
    content: { type: "gmail.msg", content: provider, blobs: [{ hash: blob, bytes: bytes.length, media_type: "message/rfc822", role: "original" }] },
  };
}

function screenHour(key: string, from: number, categories: [string, number][]) {
  const seconds = categories.reduce((sum, [, each]) => sum + each, 0);
  const data = {
    segmentInterval: { kind: "hourly" }, totalActivityDuration: seconds,
    categories: categories.map(([name, each]) => ({ category: { localizedDisplayName: name }, totalActivityDuration: each })),
  };
  return {
    kind: "usage", key, time: { start_ms: from, end_ms: from + 3_600_000, precision: "s" },
    content: { type: "usage.segment", content: { payload: { data }, captured: { wall_rfc3339: iso(from + 3_600_000) } } },
  };
}

const payment = (day: string, debit: string, narration: string, balance: string) => ({
  kind: "txn", key: `txn-${day}`, time: { start_ms: Date.parse(`${day}T00:00:00Z`), precision: "day" },
  content: { type: "bank.txn", date: day, debit, closing_balance: balance, currency: "USD", narration },
});

function sketch(day: string, said: Said): void {
  const shape = shapeOf(day);
  if (shape === "past") return;
  const back = backOf(day), d = drift(back);
  const at = (hours: number) => hour(day, hours);
  const toA = (hours: number, words: string | null, mine: boolean, carries: Carries = {}) => said.whatsapp.push(wa(stanzaOf("a", day, hours), jid(A), at(hours), words, mine, null, carries));
  const inAlpha = (hours: number, words: string, from: string | null) => said.whatsapp.push(wa(stanzaOf("alpha", day, hours), ALPHA, at(hours), words, from === null, from === null ? null : jid(from)));
  const toC = (hours: number, words: string, mine: boolean) => said.imessage.push(imessage(`c-${day}-${Math.round(hours * 600)}`, at(hours), words, mine));
  const late = shape === "weekend" || shape === "quiet";
  const [asleep, woke] = [at(-1 + d), at((late ? 7.8 : 6.4) + d)];
  if (woke <= PINNED) said.health.push(sample(`sleep-${day}`, asleep, woke, SLEEP, "HKCategoryValueSleepAnalysisAsleepCore", null));
  const steps = () => {
    said.health.push(sample(`steps-${day}-1`, at(7.0), at(7.25), "HKQuantityTypeIdentifierStepCount", "320", "count"));
    said.health.push(sample(`steps-${day}-2`, at(7.25), at(7.5), "HKQuantityTypeIdentifierStepCount", "1140", "count"));
  };
  if (shape === "weekday") {
    steps();
    toA(7.5 + d, "morning! up yet?", false);
    toA(7.55 + d, "yes, heading in soon", true);
    inAlpha(10.1 + d, "standup moved to half past", B);
    inAlpha(10.15 + d, "ok", A);
    inAlpha(10.9 + d, "thanks both", null);
    inAlpha(11.05 + d, "see you there", B);
    said.calls.push(back % 2 === 0 ? phoneCall(`CALL-${day}`, at(12.1), 12 * 60, false, B) : phoneCall(`CALL-${day}`, at(12.5), 4 * 60, true, A));
    if (back % 3 !== 2) said.calendar.push(event(`review-${day}`, at(16.0), at(16.5), "Design review"));
    toC(21.0 + d, "did you see the game?", false);
    toC(21.1 + d, "not yet, no spoilers", true);
    if (noodled(day)) NOODLES.forEach((each, index) => said.photos.push(shot(`NOODLES-${day}-${index}`, at(18.2 + index / 120), each, said.carried)));
    if (back % 4 === 2) said.voice.push(voiceNote(`voice-${day}`, at(18.5), 38, said.carried));
    if (back % 3 === 1 || back === 0) said.bank.push(payment(day, "12.50", "CORNER CAFE", "1204.00"));
    if (busy(day)) {
      said.mail.push(mail(`bank-${day}`, at(6.6), "Synthetic Bank <statements@bank.example.com>", "Statement ready", "Your synthetic statement is ready.", said.carried));
      said.mail.push(mail(`lunch-${day}`, at(7.3), `Person C <${C_MAIL}>`, "Lunch this week?", "are you free Thursday", said.carried));
      said.usage.push(screenHour(`usage-${day}-7`, at(7), [["Social", 9 * 60], ["Utilities", 5 * 60]]));
      toA(16.3, "are we still on for Friday?", false);
      CHAT_MEDIA.forEach((media, index) => toA(16.31 + index / 100, null, false, { media: { ...media, carried: said.carried } }));
      toA(16.35, "yes, booked", true, { replying: stanzaOf("a", day, 16.3) });
    }
  }
  if (shape === "weekend") {
    steps();
    said.health.push(workout(`workout-${day}`, at(10.85), at(11.6), "TraditionalStrengthTraining"), workout(`yoga-${day}`, at(11.62), at(11.95), "Yoga"));
    toC(13.0 + d, "brunch next weekend?", false);
    toC(13.1 + d, "yes please", true);
    inAlpha(15.0, "who is around tonight?", A);
    inAlpha(15.2, "me", B);
    said.calls.push(phoneCall(`CALL-${day}`, at(18.0), 18 * 60, true, A));
    said.bank.push(payment(day, "48.00", "SYNTHETIC GROCER", "1156.00"));
  }
  if (shape === "quiet") {
    toA(17.0, "all good?", false);
    toA(17.3, "resting today", true);
  }
  if (shape === "tripOut") {
    inAlpha(9.1, "on the road", null);
    inAlpha(9.2, "safe travels", B);
  }
  if (shape === "tripAway") {
    toA(10.4, "how is the old town?", false);
    toA(10.5, "lovely, photos later", true);
    TRIP_SHOTS.forEach((each, index) => said.photos.push(shot(`TRIP-${day}-${index}`, at(14 + index / 120), each, said.carried)));
  }
  if (shape === "tripBack") {
    inAlpha(16.1, "heading home", null);
    inAlpha(16.2, "drive safe", B);
    said.voice.push(voiceNote(`voice-${day}`, at(20.0), 21, said.carried));
  }
  if (back === 0) {
    said.calendar.push(allDay(`stay-${day}`, day, "Stay at Synthetic Harbour Residences @ Northern Coast Bay, Block C"), allDay(`holiday-${day}`, day, "Synthetic Festival (Day Two)"));
    const run = ["happy festival!", "what's the plan tonight", "Happy festival to you too", "Just woke up", "Heading to the market", "Cooking for everyone later",
      "Come by after seven?", "yes, bringing dessert", "Perfect", "Bring the synthetic cake from last time", "and a jacket, it gets cold on the terrace"];
    const mine = new Set([0, 1, 7]);
    run.forEach((words, index) => toA(index < 2 ? 15.45 + index / 60 : 15.75 + (index - 2) / 60, words, mine.has(index)));
    for (let index = 0; index < 24; index++) {
      const group = index % 4 === 3;
      const chat = group ? `1203630000000${index}@g.us` : `155500011${String(index).padStart(2, "0")}@s.whatsapp.net`;
      if (group) said.whatsapp.push(chatRow(chat, `Synthetic Group ${index + 1}`));
      said.whatsapp.push(wa(`crowd-${day}-${index}`, chat, at(20 + index / 60), "see you at the synthetic gathering", false, group ? jid(`+155500012${String(index).padStart(2, "0")}`) : null));
    }
    const ahead = Math.floor((PINNED - midnight(day)) / 3_600_000 + 1.5);
    if (at(ahead + 0.5) < hour(addDays(day, 1), START_HOUR)) said.calendar.push(event(`call-${day}`, at(ahead), at(ahead + 0.5), "Call with Person A"));
  }
}

describe("The canned home's day pages, which the phone's canned home serves", () => {
  const written = [...WRITTEN_BACKS.map((back) => addDays(TODAY, -back)), ...TRIP].sort();
  let root: string;
  let home: Home;
  let door: Door;
  let url = "";
  let shipped = 0;

  const imported = (id: string) => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) === "imported";
  const ran = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get()) === 0;
  const send = async (source: string, rows: object[], carried: Record<string, Buffer> = {}) => {
    if (rows.length === 0) return;
    const id = await ship(root, { source, fetched_ms: PINNED - 3_600_000 + shipped * MINUTE, rows: rows as never, carried });
    shipped++;
    await until(`${id} imported and its days written after it`, () => imported(id) && ran());
  };
  const read = async (name: "day" | "moment" | "thread", query: Record<string, string>) => {
    const response = await fetch(`${url}${PAGES[name].route}?${new URLSearchParams(query)}`, { headers: { authorization: `Bearer ${READER}` } });
    const text = await response.text();
    expect(response.status, `the ${name} page of ${JSON.stringify(query)}`).toBe(200);
    const body = JSON.parse(text) as Body;
    PAGES[name].shape.parse(body);
    return body;
  };
  const page = (day: string) => read("day", { day });
  const pinnedAs = (name: "day" | "moment" | "thread", kase: string, body: Body) => {
    mkdirSync(CANNED, { recursive: true });
    const times = [...JSON.stringify(body).matchAll(/"([a-z_]+_ms)":/gu)].map((match) => match[1]!).filter((key) => key !== "updated_ms");
    const fixture = clientFixture(`pages/canned/${name}.${kase}`, body, [...new Set(times)]);
    expect(fixture.held, `homelink/Tests/Fixtures/pages/canned/${name}.${kase}.json is this read: LIFESTREAM_FIXTURES=write writes it`).toBe(fixture.written);
  };
  const pinned = (kase: string, body: Body) => pinnedAs("day", kase, body);
  const stays = (body: Body) => (body.chapters as Body[]).filter((chapter) => chapter.kind === "stay");
  const nearHome = (body: Body) => stays(body).find((chapter) => chapter.head?.place === SPOT_KEY);

  beforeAll(async () => {
    const sources = { ...Object.fromEntries([LOCATION, LOCATION_BEFORE_OFF, PLACES, WHATSAPP, IMESSAGE, BOOK, CALLS, CALENDAR, HEALTH, PHOTOS, GMAIL, SCREEN_TIME].map((source) => [source, "canned-days-rows"])), [VOICE]: "voice-ios-bundle" };
    const another = { ...FAKE_OFFER, model: "fake-model-2", name: "Another fake model" };
    root = makeRoot("lifestream-page-canned-day-", { sources, settings: { unit: UNIT, "day.zone": ZONE, "model.transports.fake": { models: [FAKE_OFFER, another] } } });
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => tx.tables.sources.add({ id: BANK, vendor: BANK_CONNECTOR.vendor, connector: "canned-days-rows", added_ms: 0 }));
    db.close();
    mintPrincipal(openHomeFolder(root), { unit: "reader-0001", scopes: ["read"], token: READER, now_ms: 0 });
    home = await startHome(root, { registry: REGISTRY, clock: () => PINNED, log: () => undefined });
    door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: REGISTRY, clock: () => PINNED });
    url = `http://127.0.0.1:${door.port}`;

    const said: Said = { whatsapp: [chatRow(ALPHA, "Group Alpha")], imessage: [], calls: [], calendar: [], health: [], bank: [], photos: [], mail: [], usage: [], voice: [], carried: {} };
    for (const day of written) sketch(day, said);
    await send(BOOK, [card("FN:Person A", `TEL:${A}`), card("FN:Person B", `TEL:${B}`), card("FN:Person C", `EMAIL:${C_MAIL}`)]);
    await send(PLACES, [place("home-place", "Home", HOME, 100, true), place("the-office", "The Office", OFFICE, 100)]);
    const located = written.flatMap((day) => piecesOf(day).flatMap(fixesOf)) as { time: { start_ms: number } }[];
    const off = hour(addDays(TODAY, -OFF_BACK), START_HOUR);
    await send(LOCATION_BEFORE_OFF, located.filter((row) => row.time.start_ms < off));
    await send(LOCATION, located.filter((row) => row.time.start_ms >= off && row.time.start_ms <= PINNED));
    await send(WHATSAPP, said.whatsapp, said.carried);
    await send(IMESSAGE, said.imessage);
    await send(CALLS, said.calls);
    await send(CALENDAR, said.calendar);
    await send(HEALTH, said.health);
    await send(BANK, said.bank);
    await send(PHOTOS, said.photos, said.carried);
    await send(GMAIL, said.mail, said.carried);
    await send(SCREEN_TIME, said.usage);
    await send(VOICE, said.voice, said.carried);
    const transcribed = () => readHome(root, (db) => db.prepare("SELECT count(DISTINCT item) FROM enrichments WHERE family = 'voice' AND prompt = ? AND state = 'done'").pluck().get(VOICE_TRANSCRIPT));
    const owed = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM dirty_days WHERE day <= ?").pluck().get(TODAY));
    await until("every voice note transcribed and its day written after it", () => transcribed() === said.voice.length && owed() === 0 && ran());
  });

  afterAll(async () => {
    await door?.close();
    await home?.stop().catch(() => undefined);
    if (root !== undefined) removeRoot(root);
  });

  it("writes today at now: its steps so far, its last stay open, the call after now a plan", async () => {
    const body = await page(TODAY);
    expect(body.now_ms, "today holds now").not.toBeNull();
    expect((body.side.figures as Body[]).map((figure) => figure.key), "today's steps, so far").toContain("steps");
    expect((body.plans as Body[]).length, "the call with Person A after now").toBeGreaterThan(0);
    expect(stays(body)[0]?.head?.title, "the day opens at Home").toBe("Home");
    pinned(TODAY, body);
  });

  it("writes yesterday: Home at the day's start, an unnamed stay near Home, dated records under Also that day, its places and people", async () => {
    const body = await page(YESTERDAY);
    const first = stays(body)[0];
    expect([first?.head?.title, first?.start_ms], "the first stay is Home from the day's start").toEqual(["Home", hour(YESTERDAY, START_HOUR)]);
    expect(first?.names.length, "its names band").toBeGreaterThan(0);
    expect(first?.names.at(-1)?.text, "the band's last name, which the day journey opens").toBe("Person A");
    expect((first?.blocks as Body[]).flatMap((block) => block.rows as Body[]).map((row) => row.kind), "the morning at Home: mail, the phone's screen time, Person A")
      .toEqual(expect.arrayContaining(["mail_received", "conversation"]));
    expect(stays(body).length, "yesterday is its stays").toBeGreaterThanOrEqual(2);
    expect(body.also?.rows.length, "the day's dated record").toBeGreaterThan(0);
    expect(nearHome(body)?.head, "the stay at the spot the phone offers to name").toMatchObject({ title: expect.stringMatching(/^Near Home/u), quiet: true });
    expect((body.side.places as Body[]).map((each) => each.slug), "Home by its slug").toContain("home-place");
    expect(stays(body).map((stay) => [stay.head?.title, stay.head?.icon]).filter(([title]) => title === "Home" || title === "The Office"), "the stays at home carry the home glyph")
      .toEqual([["Home", "home"], ["The Office", "place"], ["Home", "home"]]);
    expect((body.side.people as Body[]).length, "the people of the day").toBeGreaterThan(0);
    pinned(YESTERDAY, body);
  });

  it("writes the moment each name of yesterday's first stay opens, by the row the page names, and a conversation's thread", async () => {
    const names = (stays(await page(YESTERDAY))[0]?.names ?? []) as Body[];
    expect(names.length, "the first stay's names band").toBeGreaterThan(0);
    for (const name of names) {
      const body = await read("moment", { day: YESTERDAY, focus: name.first_row });
      expect([body.state, body.moment?.row], `${name.text} opens its row`).toEqual(["found", name.first_row]);
      pinnedAs("moment", `${YESTERDAY}-${caseOf(name.first_row)}`, body);
      const view = body.moment.view as Body;
      if ((view.view === "thread" || view.view === "quiet") && typeof view.chat === "string") {
        const thread = await read("thread", { chat: view.chat, day: YESTERDAY });
        expect(thread.messages.length, `${name.text}'s conversation`).toBeGreaterThan(0);
        pinnedAs("thread", `${caseOf(view.chat)}-${YESTERDAY}`, thread);
      }
    }
  });

  it("writes the moment of yesterday's first stay, Home, with the slug its place page opens by", async () => {
    const first = stays(await page(YESTERDAY))[0]!;
    const body = await read("moment", { day: YESTERDAY, focus: first.episode });
    expect([body.state, body.moment?.kind], "the stay's own moment").toEqual(["found", "stay"]);
    expect(body.moment.place, "Home by its slug").toMatchObject({ name: "Home", slug: "home-place" });
    pinnedAs("moment", `${YESTERDAY}-${caseOf(first.episode)}`, body);
  });

  it("writes the moment the search for \"booked\" opens: the reply marked in its conversation, which carries two photos and two videos", async () => {
    const booked = `${jid(A)}:${stanzaOf("a", YESTERDAY, 16.35)}`;
    const focus = recordFocus({ source: WHATSAPP, kind: "msg", key: booked });
    const body = await read("moment", { day: YESTERDAY, focus });
    expect([body.state, body.moment?.view?.view, body.moment?.marks], "the reply, marked in its conversation").toEqual(["found", "thread", [booked]]);
    pinnedAs("moment", `${YESTERDAY}-${caseOf(focus)}`, body);
    const thread = await read("thread", { chat: body.moment.view.chat, day: YESTERDAY });
    const messages = thread.messages as Body[];
    expect(messages.flatMap((message) => [...(message.pictures as Body[]).map(() => "photo"), ...message.video === null ? [] : ["video"]]), "the chat's photos and videos, its first video second")
      .toEqual(["photo", "video", "photo", "video"]);
    expect(messages.find((message) => message.key === booked)?.quote, "the reply quotes the message it answers").toMatchObject({ text: "are we still on for Friday?" });
    pinnedAs("thread", `${caseOf(body.moment.view.chat)}-${YESTERDAY}`, thread);
  });

  it("writes the moment a chat's picture opens at, the message that carried it, as the home's photo names it", async () => {
    const { hash } = carry(CHAT_MEDIA[0]!.file, {});
    const response = await fetch(`${url}/v1/photos/${hash}`, { headers: { authorization: `Bearer ${READER}` } });
    expect(response.status, "the chat picture's photo").toBe(200);
    const { photo } = await response.json() as Body;
    const carrier = `${jid(A)}:${stanzaOf("a", YESTERDAY, 16.31)}`;
    const focus = recordFocus({ source: WHATSAPP, kind: "msg", key: carrier });
    expect([photo.day, photo.chat?.focus, photo.chat?.sender?.name], "sent by Person A in the message the phone's canned photo names").toEqual([YESTERDAY, focus, "Person A"]);
    const body = await read("moment", { day: YESTERDAY, focus });
    expect([body.state, body.moment?.marks], "the message that carried it, marked").toEqual(["found", [carrier]]);
    pinnedAs("moment", `${YESTERDAY}-${caseOf(focus)}`, body);
  });

  it("writes the moment the noodles' photos open at: their burst, on the newest day they were taken", async () => {
    const day = written.find(noodled)!;
    const focus = unitFocus(`burst/${hour(day, 18.2)}`);
    const body = await read("moment", { day, focus });
    expect([body.state, (body.moment?.pictures as Body[] | undefined)?.length], "the burst's two photos").toEqual(["found", NOODLES.length]);
    pinnedAs("moment", `${day}-${caseOf(focus)}`, body);
  });

  it("writes the moment a trip photo's date opens at: its burst of two photos, the square's video and the courtyard's Live Photo", async () => {
    const day = TRIP[1]!;
    const { hash } = carry(TRIP_SHOTS[1]!.file, {});
    const response = await fetch(`${url}/v1/photos/${hash}`, { headers: { authorization: `Bearer ${READER}` } });
    expect(response.status, "the market photo's photo").toBe(200);
    const { photo } = await response.json() as Body;
    const focus = unitFocus(`burst/${hour(day, 14)}`);
    expect([photo.day, photo.focus], "the day and moment the phone's canned photo names").toEqual([day, focus]);
    const body = await read("moment", { day, focus });
    expect([body.state, (body.moment?.pictures as Body[] | undefined)?.map((picture) => [picture.video, picture.duration_ms, picture.live])], "the burst, in the order it was taken").toEqual([
      "found", [[false, null, false], [false, null, false], [true, 4000, false], [false, null, true]],
    ]);
    pinnedAs("moment", `${day}-${caseOf(focus)}`, body);
  });

  it("writes the moment the voice note's search opens: its transcript made, and the act to make it again", async () => {
    const day = written.filter((each) => shapeOf(each) === "weekday" && backOf(each) % 4 === 2).at(-1)!;
    const focus = recordFocus({ source: VOICE, kind: "voice", key: `voice-${day}` });
    const body = await read("moment", { day, focus });
    const [note] = body.moment.view.notes as Body[];
    expect([note!.made?.state, note!.words, body.moment.title], "the transcript made, in the note's words and the moment's title").toEqual(["done", expect.stringMatching(/\S/u), `“${note!.words}”`]);
    expect((note!.made.choose as Body[]).length, "another model to transcribe it again").toBeGreaterThan(0);
    const madeAt = hour(day, 18.6);
    const made = { ...note!.made, at_ms: madeAt, line: `${note!.made.by} · ${dayWords(madeAt, PINNED, effective(root).settings.day)}` };
    pinnedAs("moment", `${day}-${caseOf(focus)}`, { ...body, moment: { ...body.moment, view: { ...body.moment.view, notes: [{ ...note, made }] } } });
  });

  it("writes the moment Ask's first source opens, today's first message from Person A, and its conversation", async () => {
    const key = `${ALPHA}:${stanzaOf("alpha", TODAY, 15.0)}`;
    const focus = recordFocus({ source: WHATSAPP, kind: "msg", key });
    const body = await read("moment", { day: TODAY, focus });
    expect([body.state, body.moment?.view?.view, body.moment?.marks], "the message, marked in Group Alpha").toEqual(["found", "thread", [key]]);
    pinnedAs("moment", `${TODAY}-${caseOf(focus)}`, body);
    const thread = await read("thread", { chat: body.moment.view.chat, day: TODAY });
    expect((thread.messages as Body[]).map((message) => message.text), "Group Alpha today").toContain("who is around tonight?");
    pinnedAs("thread", `${caseOf(body.moment.view.chat)}-${TODAY}`, thread);
  });

  it("writes every other day the UI journeys open: each of the last three weeks, the day the phone was off, last month's trip, 22 and 40 days back", async () => {
    for (const day of written.filter((each) => each !== TODAY && each !== YESTERDAY)) {
      const body = await page(day);
      expect(body.state, day).toBe("ready");
      if (backOf(day) === OFF_BACK) expect(body.side.located, "no location the day the phone was off").toBe(false);
      else expect(stays(body)[0]?.head?.title, `${day} opens at Home or where the trip left off`).toEqual(TRIP.slice(1).includes(day) ? expect.any(String) : "Home");
      if (shapeOf(day) === "tripAway") {
        const band = (stays(body) as Body[]).flatMap((chapter) => chapter.photos as Body[]).map((photo) => [photo.video, photo.duration_ms, photo.alt]);
        expect(band, "the trip's band: two photos, the square's 4 s video, the courtyard's Live Photo").toEqual([
          [false, null, "Photo"], [false, null, "Photo"], [true, 4000, "Video"], [false, null, "Live Photo"],
        ]);
      }
      pinned(day, body);
    }
  });

  it("writes a day before the home's first day as before its history", async () => {
    const body = await page(UNWRITTEN);
    expect([body.state, body.before_home], "a day before the home's history").toEqual(["empty", BEFORE_HOME]);
    pinned(UNWRITTEN, body);
  });

  it("writes yesterday again once the spot near Home is named, as the naming walk names it", async () => {
    await send(PLACES, [place("home-place", "Home", HOME, 100, true), place("the-office", "The Office", OFFICE, 100), place("synthetic-gym", "Synthetic Gym", SPOT, 150)]);
    const body = await page(YESTERDAY);
    const named = stays(body).find((chapter) => chapter.head?.title === "Synthetic Gym");
    expect(named?.head?.quiet, "the stay reads the place named").toBe(false);
    expect(nearHome(body), "no stay left to name there").toBeUndefined();
    pinned(`${YESTERDAY}-named`, body);
  });
});
