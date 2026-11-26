import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, ServerResponse, type IncomingMessage } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { civilDay, dayBounds, digest, homeSchema, instant, openHome, openHomeFolder, tryLock, trySharedLock, type Json } from "@lifestreamprotocol/core";
import { areaOf, networksOf, readLabels, resolvedChat, resolvedPlace, servedTable } from "@lifestreamprotocol/families";
import { askGeneration, serveDoor, type Door } from "./door.js";
import { DOOR_LOCK } from "./erasable-streams.js";
import { homeClock } from "./home-clock.js";
import { preparedDirOf, preparedFileOf } from "./prepared.js";
import { dayPath } from "./derive.js";
import { openReads } from "./reads.js";
import { startHome, type Home } from "./home.js";
import { HomeFile } from "./home-file.js";
import { readDelivery } from "./inbox.js";
import { mintPrincipal } from "./principals.js";
import { effective, lastGood } from "./settings.js";
import { askHome } from "./socket.js";
import { maintenance } from "./verbs/maintenance.js";
import { machine, pointAt } from "./machine.js";
import { move } from "./move.js";
import { newMachine, removeTemps, temp } from "./test/machines.js";
import { artifact, ChildHome, clientFixture, FAKE_OFFER, FAKES, hex, LOOK_MS, makeRoot, readHome, removeRoot, settled, TICK_MS, until } from "./test/harness-root.js";
import { ship, shipFiles } from "./test/harness-deliveries.js";
import { doorHere } from "./test/harness-door.js";
import { statusOf } from "./test/harness-status.js";
import { editSettings, writeFolder, testSocket } from "./test/folder.js";
import { dayWords } from "./stream-words.js";
import { DEVICE, REPO, startDoor } from "./test/support.js";
import { RELEASE_FED } from "./test/fed.js";
import { RELEASE_NETWORKED as NETWORKED } from "./test/fed.js";


const HOUR = 3_600_000;
const A = "apple-notes:local:device-a";
const B = "apple-notes:local:device-b";
const CONTACTS = "apple-contacts:local:device-a";
const HOME_UNIT = "home-0001";
const PLACES = `places:local:${HOME_UNIT}`;
const DAYS = ["2026-09-28", "2026-09-29", "2026-09-30"];
const RAW = Buffer.from(Array.from({ length: 4_096 }, (_, index) => index % 251));
const TEXT = Buffer.from(Array.from({ length: 4_000 }, (_, index) => `synthetic line ${index}\n`).join(""));
const card = (name: string) => ({ card: `BEGIN:VCARD\r\nFN:${name}\r\nTEL:+15550000001\r\nEND:VCARD\r\n` });
const TOKENS = { reader: "synthetic-token-reader".padEnd(43, "r"), device: "synthetic-token-device".padEnd(43, "d") };
const summary: Record<string, unknown> = {};

function note(index: number, extra: Record<string, unknown> = {}, blobs?: string[]) {
  const at = Date.parse(`${DAYS[Math.floor(index / 10)]}T06:00:00Z`) + (index % 10) * HOUR;
  return { kind: "note", key: `n${String(index).padStart(2, "0")}`, content: { text: `synthetic note ${index}`, at, ...extra }, at, ...(blobs === undefined ? {} : { blobs }) };
}

describe("the door's read routes", () => {
  let root: string;
  let home: Home;
  let door: Door;
  let url: string;
  const logs: string[] = [];
  let shipped = 0;
  const compressed = `sha256:${hex(TEXT)}`;
  const raw = `sha256:${hex(RAW)}`;

  const held = (): string[] => readdirSync(join(root, "days")).filter((name) => name.endsWith(".day.json")).map((name) => name.slice(0, -".day.json".length)).sort();
  const send = async (planned: Parameters<typeof ship>[1]): Promise<string> => {
    const id = await ship(root, planned);
    shipped++;
    await until("the home settled", () => settled(root, shipped));
    return id;
  };

  const get = async (path: string, who: keyof typeof TOKENS | null = "reader", headers: Record<string, string> = {}) => {
    const response = await fetch(`${url}${path}`, { headers: { ...(who === null ? {} : { authorization: `Bearer ${TOKENS[who]}` }), ...headers } });
    return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
  };
  const json = async (path: string): Promise<Record<string, any>> => {
    const answer = await get(path);
    expect(answer.status, answer.bytes.toString()).toBe(200);
    return JSON.parse(answer.bytes.toString("utf8")) as Record<string, any>;
  };
  const pages = async (path: string, member: string, from?: string): Promise<{ items: any[]; count: number }> => {
    const items: any[] = [];
    let count = 0;
    for (let after = from; ;) {
      const page = await json(`${path}${after === undefined ? "" : `&after=${after}`}`);
      items.push(...page[member]);
      count++;
      if (page.next === undefined) return { items, count };
      after = page.next as string;
    }
  };
  const fed = async (stream: ReadableStreamDefaultReader<Uint8Array>, key: string): Promise<void> => {
    for (let text = ""; !text.includes(`"key":${JSON.stringify(key)}`);) {
      const { value, done } = await stream.read();
      if (done) throw new Error(`the feed ended before the event of ${key}`);
      text += Buffer.from(value).toString("utf8");
    }
  };
  const position = () => readHome(root, (db) => {
    const newest = db.prepare("SELECT seq, at_ms FROM events ORDER BY seq DESC LIMIT 1").get() as { seq: number; at_ms: number } | undefined;
    return newest === undefined ? "0:0" : `${newest.seq}:${newest.at_ms}`;
  });
  const heads = (source: string, order = "h.key") => readHome(root, (db) => (db.prepare(
    `SELECT h.source, h.kind, h.key, h.version, h.stated_ms, h.since_ms, h.start_ms, h.end_ms, v.precision, v.text FROM heads h
       JOIN versions v ON v.id = h.version WHERE h.source = ? AND h.kind = 'note' AND h.version <> 'gone' ORDER BY ${order}`,
  ).all(source) as Record<string, any>[]).map(({ text, source: s, kind, key, ...head }) => ({ source: s, kind, key, head, content: JSON.parse(text).content })));
  const extracts = (where = "", ...params: unknown[]) => readHome(root, (db) => (db.prepare(
    `SELECT family, unit, reading, code, content, start_ms, end_ms, days, items FROM extracts WHERE family = 'notes' ${where}`,
  ).all(...params) as Record<string, any>[]).map((row) => ({ ...row, content: JSON.parse(row.content), days: JSON.parse(row.days), items: JSON.parse(row.items) })));

  beforeAll(async () => {
    root = makeRoot("lifestream-reads-", {
      sources: { [A]: "fake-rows", [B]: "fake-rows", [CONTACTS]: "fake-rows", [PLACES]: "fake-rows" },
      settings: { unit: HOME_UNIT, "families.messages": {} },
    });
    for (const [unit, scopes, sources] of [["reader", ["read"], []], ["device", ["deliver"], [A]]] as const) {
      mintPrincipal(openHomeFolder(root), { unit, kind: unit === "device" ? "mac" : null, scopes: [...scopes], sources: [...sources], token: TOKENS[unit], now_ms: 0 });
    }
    openHomeFolder(root).blobs(join(root, "blobs")).put(TEXT, { mediaType: "text/plain" });
    home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
    await send({ source: CONTACTS, fetched_ms: Date.now(), rows: [{ kind: "contact", key: "c1", content: card("Person A") }] });
    await send({ source: PLACES, fetched_ms: Date.now(), rows: [{ kind: "place", key: "desk", content: { type: "places.place", name: "Synthetic Desk", centre: { latitude: 10, longitude: 20 }, radius_m: 100, ids: ["google:synthetic-desk"] } }] });
    await send({
      source: A, fetched_ms: Date.now(), carried: { [hex(RAW)]: RAW },
      rows: Array.from({ length: 30 }, (_, index) => index === 3 || index === 17 ? note(index, { photo: true })
        : index === 5 ? note(index, {}, [raw]) : index === 6 ? note(index, {}, [compressed]) : note(index)),
    });
    await send({ source: B, fetched_ms: Date.now(), rows: [note(0), note(11)] });
    await until("every day rendered", () => DAYS.every((day) => readdirSync(join(root, "days")).includes(`${day}.day.json`)));
    await until("the labels family read the contact and the place", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM extracts WHERE family = 'labels' AND unit IN ('phone:+15550000001', 'places')").pluck().get()) === 2);
    door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { lookMs: LOOK_MS, log: (line) => logs.push(line), registry: FAKES });
    url = `http://127.0.0.1:${door.port}`;
  });

  afterAll(async () => {
    await door?.close();
    await home?.stop().catch(() => undefined);
    mkdirSync(join(REPO, "packages", "home", ".build", "e2e"), { recursive: true });
    writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "reads.json"), `${JSON.stringify(summary, null, 2)}\n`);
    if (root !== undefined) removeRoot(root);
  });

  it("answers what the home holds, wrongly: every route against the tables and files read by hand", async () => {
    const at = position();
    const answers: Record<string, unknown> = {};

    const days = await json("/v1/days");
    expect(days.position).toBe(at);
    expect(held()).toEqual(expect.arrayContaining(DAYS));
    expect(days.days).toEqual(held().map((day) => {
      const file = JSON.parse(readFileSync(join(root, "days", `${day}.day.json`), "utf8"));
      return { day, inputs: file.inputs, counts: file.counts };
    }));
    expect((await json(`/v1/days?from=${DAYS[1]}&to=${DAYS[1]}`)).days.map((entry: { day: string }) => entry.day)).toEqual([DAYS[1]]);
    const aside = join(root, "days", `${DAYS[2]}.day.json`);
    renameSync(aside, `${aside}.aside`);
    try {
      const listed = (await json("/v1/days")).days;
      expect(listed).toEqual(days.days);
      expect(listed.map((entry: { day: string }) => entry.day)).toContain(DAYS[2]);
    } finally {
      renameSync(`${aside}.aside`, aside);
    }
    for (const [file, type] of [["json", "application/json"], ["txt", "text/plain; charset=utf-8"], ["lines", "application/json"]] as const) {
      const answer = await get(`/v1/days/${DAYS[0]}?file=${file}`);
      expect(answer.status).toBe(200);
      expect(answer.headers.get("content-type")).toBe(type);
      expect(answer.headers.get("etag")).toBe(`"${days.days[0].inputs}"`);
      expect(answer.bytes.equals(readFileSync(join(root, "days", `${DAYS[0]}.day.${file === "json" ? "json" : file === "txt" ? "txt" : "lines.json"}`)))).toBe(true);
    }
    expect((await get(`/v1/days/${DAYS[0]}`)).bytes.toString()).toContain('"atoms"');
    expect((await get(`/v1/days/${DAYS[0]}`, "reader", { "if-none-match": `"${days.days[0].inputs}"` })).status).toBe(304);
    answers.days = days;

    const sources = await json("/v1/sources?product=apple-notes");
    expect(sources.sources).toEqual(readHome(root, (db) => (db.prepare("SELECT * FROM sources WHERE product = 'apple-notes' ORDER BY id").all() as Record<string, any>[])
      .map((row) => ({ ...row, options: JSON.parse(row.options), kinds: ["note"] }))));
    answers.sources = sources;

    const records = await json(`/v1/records?source=${A}&kind=note`);
    expect(records.position).toBe(at);
    expect(records.records).toEqual(heads(A));
    expect(records.next).toBeUndefined();
    const [from_ms, to_ms] = [Date.parse(`${DAYS[1]}T08:30:00Z`), Date.parse(`${DAYS[1]}T12:00:00Z`)];
    expect((await json(`/v1/records?source=${A}&kind=note&from_ms=${from_ms}&to_ms=${to_ms}`)).records.map((record: { key: string }) => record.key))
      .toEqual(["n13", "n14", "n15"]);
    const { day } = effective(root).settings;
    const local = new Date(to_ms).toISOString().slice(0, 16);
    const toLocal = instant(local, "local", { zone: day.zone }).start_ms;
    expect((await json(`/v1/records?source=${A}&kind=note&from_ms=${encodeURIComponent(`${DAYS[1]}T10:30+02:00`)}&to_ms=${local}`)).records)
      .toEqual((await json(`/v1/records?source=${A}&kind=note&from_ms=${from_ms}&to_ms=${toLocal}`)).records);

    const counted = await json(`/v1/counts?source=${A}&kind=note&kind=nothing`);
    expect(counted).toEqual({ position: at, counts: { note: heads(A).length, nothing: 0 } });
    answers.counts = counted;
    const kept = new Database(join(root, "home.db"), { timeout: 30_000 });
    try {
      kept.prepare("UPDATE spans SET live = NULL WHERE source = ? AND kind = 'note'").run(A);
      expect((await json(`/v1/counts?source=${A}&kind=note&kind=nothing`)).counts).toEqual({ note: null, nothing: 0 });
    } finally {
      kept.prepare("UPDATE spans SET live = ? WHERE source = ? AND kind = 'note'").run(heads(A).length, A);
      kept.close();
    }

    const record = await json(`/v1/record?source=${A}&kind=note&key=n05&history=1`);
    const stored = heads(A).find((each) => each.key === "n05")!;
    expect(record).toMatchObject({ position: at, source: A, kind: "note", key: "n05", head: stored.head, blobs: [raw] });
    expect(record.version).toEqual({ id: stored.head.version, content: stored.content, start_ms: stored.content.at, end_ms: null, offset_min: null, precision: "ms" });
    expect(record.history).toEqual(readHome(root, (db) => db.prepare("SELECT seq, version, stated_ms, run, device, locator, origin, late FROM statements WHERE source = ? AND key = 'n05'")
      .all(A).map((row: any) => ({ ...row, late: row.late === 1 }))));
    answers.record = record;

    const unit = `${A}/${DAYS[0]}`;
    expect((await json(`/v1/extracts?family=notes&unit=${encodeURIComponent(unit)}`)).extracts).toEqual(extracts("AND unit = ?", unit));
    expect((await json(`/v1/extracts?family=notes&day=${DAYS[1]}`)).extracts).toEqual(extracts("AND unit IN (SELECT unit FROM extract_days WHERE family = 'notes' AND day = ?) ORDER BY unit", DAYS[1]));
    const range = [Date.parse(`${DAYS[0]}T00:00:00Z`), Date.parse(`${DAYS[2]}T00:00:00Z`)];
    const ranged = await json(`/v1/extracts?family=notes&from_ms=${range[0]}&to_ms=${range[1]}`);
    expect(ranged.extracts).toEqual(extracts("AND start_ms >= ? AND start_ms < ? ORDER BY start_ms, unit", range[0], range[1]));
    expect(ranged.extracts.flatMap((row: { items: string[] }) => row.items)).toEqual(["photo:n03", "photo:n17"]);
    expect((await json(`/v1/extracts?family=notes&from_ms=${DAYS[0]}&to_ms=${DAYS[1]}`)).extracts)
      .toEqual((await json(`/v1/extracts?family=notes&from_ms=${dayBounds(DAYS[0]!, day).start_ms}&to_ms=${dayBounds(DAYS[1]!, day).end_ms}`)).extracts);
    answers.extracts = ranged;

    const enrichments = await json("/v1/enrichments?family=notes&prompt=fake-caption&item=photo:n03&item=photo:n17&item=photo:none");
    expect(enrichments.enrichments).toEqual(readHome(root, (db) => (db.prepare("SELECT family, item, prompt, state, content FROM enrichments ORDER BY item").all() as Record<string, any>[])
      .map((row) => ({ ...row, content: JSON.parse(row.content) }))));
    expect(enrichments.enrichments.map((row: { state: string }) => row.state)).toEqual(["done", "done"]);
    answers.enrichments = enrichments;

    const status = await json("/v1/status");
    const { at_ms: _at, ...expected } = statusOf(root, { now_ms: Date.now(), settings: effective(root).settings, door: null });
    const { at_ms: _answered, position: statusAt, ...answered } = status;
    expect(statusAt).toBe(at);
    const freeOf = (report: Record<string, any>) => ({ ...report, disk: { ...report.disk, free_bytes: typeof report.disk.free_bytes } });
    expect(freeOf(answered)).toEqual(freeOf(JSON.parse(JSON.stringify(expected))));
    answers.status = status;
    summary.routes = Object.keys(answers);
    summary.artifact = artifact(root, "answers", answers);
  });

  it("labels other than the ones the days render with (the records read again, a rename served before the labels family read it), a version that is not the table's digest, or the whole table on every answer", async () => {
    const settings = effective(root).settings;
    const fromRecords = () => {
      const db = openHome(openHomeFolder(root), "read");
      const view = db.view();
      try {
        const labels = readLabels(view, settings.unit, NETWORKED);
        return JSON.parse(JSON.stringify({ version: labels.version, labels: servedTable(labels.table) })) as { version: string; labels: Record<string, any> };
      } finally {
        view.close();
        db.close();
      }
    };
    const first = await json("/v1/labels");
    expect(Object.keys(first).sort()).toEqual(["labels", "position", "version"]);
    expect(digest(first.labels as Json)).toBe(first.version);
    expect({ version: first.version, labels: first.labels }).toEqual(fromRecords());
    expect(first.labels.people).toEqual([["phone", "+15550000001", "phone:+15550000001", "Person A", "contact", null, false]]);
    expect(first.labels.places).toEqual([{ slug: "desk", name: "Synthetic Desk", latitude: 10, longitude: 20, radius_m: 100, ids: ["google:synthetic-desk"] }]);
    expect(first.labels.google).toEqual([]);
    const askA = "/v1/labels?id=%2B15550000001&id=15550000009%40s.whatsapp.net&id=person-z%40example.com";
    const asked = await json(askA);
    expect(Object.keys(asked).sort()).toEqual(["chats", "names", "places", "position"]);
    expect(asked.names).toEqual([["+15550000001", "Person A", "contact", null], ["15550000009@s.whatsapp.net", "unknown …00009", "none", null], ["person-z@example.com", "person-z@example.com", "none", null]]);
    expect([asked.chats, asked.places]).toEqual([[], []]);
    await askHome(testSocket(root), "pause", ["kind:extract", "--reason", "the test holds it"]);
    let held: Record<string, any>;
    try {
      await ship(root, { source: CONTACTS, fetched_ms: Date.now(), rows: [{ kind: "contact", key: "c1", content: card("Person B") }] });
      shipped++;
      await until("the rename landed", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get()) === shipped);
      expect(fromRecords().labels.people).toEqual([["phone", "+15550000001", "phone:+15550000001", "Person B", "contact", null, false]]);
      held = await json("/v1/labels");
      expect([held.version, held.labels]).toEqual([first.version, first.labels]);
      expect((await json(askA)).names).toEqual(asked.names);
    } finally {
      await askHome(testSocket(root), "resume", ["kind:extract"]);
    }
    await until("the home settled", () => settled(root, shipped));
    const second = await json("/v1/labels");
    expect(digest(second.labels as Json)).toBe(second.version);
    expect(second.version).not.toBe(first.version);
    expect({ version: second.version, labels: second.labels }).toEqual(fromRecords());
    expect(second.labels.people).toEqual([["phone", "+15550000001", "phone:+15550000001", "Person B", "contact", null, false]]);
    expect((await json(askA)).names[0]).toEqual(["+15550000001", "Person B", "contact", null]);
    summary.labels = { first: first.version, held: held.version, second: second.version };
  });

  it("a reader names a chat or places a point by a rule of its own: the door serves the families' title and place, or refuses the parameter", async () => {
    const chats = ["imessage:+15550000001", "imessage:+15550000001,person-z@example.com", "whatsapp:15550000009@s.whatsapp.net", "whatsapp:120363000000000001@g.us"];
    const OPENS: Record<string, { label: string; href: string } | null> = {
      "imessage:+15550000001": { label: "Open in iMessage", href: "imessage:%2B15550000001" }, "imessage:+15550000001,person-z@example.com": null,
      "whatsapp:15550000009@s.whatsapp.net": { label: "Open in WhatsApp", href: "https://wa.me/15550000009" }, "whatsapp:120363000000000001@g.us": null,
    };
    const points = ["10,20", "10.001,20", "10.002,20", "-33.5,151.25", "0,0", "1e-7,-0", "10.002,20,google:synthetic-desk"];
    const answer = await json(`/v1/labels?${[...chats.map((chat) => `chat=${encodeURIComponent(chat)}`), ...points.map((point) => `point=${point}`)].join("&")}`);
    const settings = effective(root).settings;
    const db = openHome(openHomeFolder(root), "read");
    const view = db.view();
    let expected;
    try {
      const labels = readLabels(view, settings.unit, NETWORKED);
      expected = {
        chats: chats.map((chat) => [...resolvedChat(chat, labels, networksOf(RELEASE_FED.messages))!, OPENS[chat]]),
        places: points.map((point) => {
          const [latitude, longitude, id] = point.split(",") as [string, string, string | undefined];
          return resolvedPlace({ latitude: Number(latitude), longitude: Number(longitude), ...(id === undefined ? {} : { id }) }, labels);
        }),
      };
    } finally {
      view.close();
      db.close();
    }
    expect({ chats: answer.chats, places: answer.places }).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(answer.chats).toEqual([
      ["imessage:+15550000001", "Person B", false, OPENS["imessage:+15550000001"]], ["imessage:+15550000001,person-z@example.com", "Person B, person-z@example.com", true, null],
      ["whatsapp:15550000009@s.whatsapp.net", "unknown …00009", false, OPENS["whatsapp:15550000009@s.whatsapp.net"]], ["whatsapp:120363000000000001@g.us", "120363000000000001@g.us", true, null],
    ]);
    expect(answer.places).toEqual([[10, 20, "desk", "Synthetic Desk", "Synthetic Desk"], [10.001, 20, null, null, "an unnamed place 0.1 km from Synthetic Desk"],
      [10.002, 20, null, null, "an unnamed place 0.2 km from Synthetic Desk"], [-33.5, 151.25, null, null, "an unnamed place in Central Coast"],
      [0, 0, null, null, "an unnamed place 2476 km from Synthetic Desk"], [1e-7, 0, null, null, "an unnamed place 2476 km from Synthetic Desk"],
      [10.002, 20, "desk", "Synthetic Desk", "Synthetic Desk"]]);
    for (const [path, named] of [
      ["/v1/labels?chat=sms:%2B15550000001", "chat"], ["/v1/labels?chat=whatsapp:", "chat"], ["/v1/labels?point=10", "point"], ["/v1/labels?point=91,0", "point"],
      ["/v1/labels?point=10,abc", "point"], ["/v1/labels?point=10,%2B20", "point"], ["/v1/labels?point=10,20,", "point"], [`/v1/labels?${Array.from({ length: 257 }, (_, index) => `point=${index / 1000},0`).join("&")}`, "point"],
      [`/v1/labels?${Array.from({ length: 257 }, (_, index) => `id=i${index}`).join("&")}`, "id"],
    ] as const) {
      const refused = await get(path);
      expect([path, refused.status, JSON.parse(refused.bytes.toString()).message.split(" ")[0]]).toEqual([path, 422, named]);
    }
    summary.chats_places = { chats: answer.chats, places: answer.places };
  });

  it("a reader re-decides which extracts a day shows, or takes a day not rendered yet for one that hides it: shown_on and unrendered_on are what the files print", async () => {
    const printed = (day: string): Set<string> => readdirSync(join(root, "days")).includes(`${day}.day.json`)
      ? new Set((JSON.parse(readFileSync(join(root, "days", `${day}.day.json`), "utf8")) as { atoms: { units: string[] }[] }).atoms.flatMap((atom) => atom.units))
      : new Set();
    const range = `from_ms=${Date.parse(`${DAYS[0]}T00:00:00Z`)}&to_ms=${Date.parse(`${DAYS[2]}T23:59:59Z`)}`;
    const shownAll = async () => (await pages(`/v1/extracts?family=notes&${range}&limit=2&shown=1`, "extracts")).items;
    const unit = `${B}/${DAYS[2]}`;
    const at = (time: string) => Date.parse(`${DAYS[2]}T${time}:00Z`);
    await askHome(testSocket(root), "pause", ["kind:render", "--reason", "the test holds it"]);
    await ship(root, { source: B, fetched_ms: Date.now(), rows: [
      { kind: "note", key: "h1", content: { text: "synthetic hidden note", at: at("02:00"), hidden: true }, at: at("02:00") },
      { kind: "note", key: "h2", content: { text: "synthetic note about a person", at: at("03:00"), hidden: "+15550000003" }, at: at("03:00") },
      { kind: "note", key: "h3", content: { text: "synthetic shown note", at: at("06:00") }, at: at("06:00") },
    ] });
    shipped++;
    await until("the unit extracted", () => extracts("AND unit = ?", unit).length === 1);
    const waiting = (await json(`/v1/extracts?family=notes&unit=${encodeURIComponent(unit)}&shown=1`)).extracts[0];
    expect([waiting.days, waiting.shown_on, waiting.unrendered_on]).toEqual([[DAYS[1], DAYS[2]], [], [DAYS[1], DAYS[2]]]);
    await askHome(testSocket(root), "resume", ["kind:render"]);
    await until("the home settled", () => settled(root, shipped));

    const plain = await pages(`/v1/extracts?family=notes&${range}&limit=2`, "extracts");
    const shown = await shownAll();
    expect(shown.map(({ shown_on: _shown, unrendered_on: _unrendered, ...row }) => row)).toEqual(plain.items);
    for (const row of shown) {
      expect([row.unit, row.shown_on, row.unrendered_on]).toEqual([row.unit, row.days.filter((day: string) => printed(day).has(row.unit)), []]);
    }
    expect(shown.find((row) => row.unit === unit)).toMatchObject({ days: [DAYS[1], DAYS[2]], shown_on: [DAYS[2]], unrendered_on: [] });
    const day = await json(`/v1/extracts?family=notes&day=${DAYS[1]}&shown=1`);
    expect(day.extracts.map((row: { unit: string; shown_on: string[] }) => [row.unit, row.shown_on.includes(DAYS[1]!)]))
      .toEqual(day.extracts.map((row: { unit: string }) => [row.unit, printed(DAYS[1]!).has(row.unit)]));

    await send({ source: CONTACTS, fetched_ms: Date.now(), rows: [{ kind: "contact", key: "c2", content: { card: "BEGIN:VCARD\r\nFN:Person C\r\nTEL:+15550000003\r\nEND:VCARD\r\n" } }] });
    await until("the day re-rendered", () => printed(DAYS[1]!).has(unit));
    await until("the home settled", () => settled(root, shipped));
    const named = (await json(`/v1/extracts?family=notes&unit=${encodeURIComponent(unit)}&shown=1`)).extracts[0];
    expect([named.shown_on, named.unrendered_on]).toEqual([[DAYS[1], DAYS[2]], []]);
    expect(readFileSync(join(root, "days", `${DAYS[1]}.day.txt`), "utf8")).toContain("synthetic note about a person");
    summary.shown_on = { waiting: [waiting.shown_on, waiting.unrendered_on], rendered: Object.fromEntries(shown.map((row) => [row.unit, [row.days, row.shown_on]])), named: named.shown_on };
  });

  it("pages that miss or repeat a row: every list read a page at a time is the list read whole, in order", async () => {
    const records = await pages(`/v1/records?source=${A}&kind=note&limit=7`, "records");
    expect(records.count).toBe(Math.ceil(heads(A).length / 7));
    expect(records.items).toEqual(heads(A));
    const from = Date.parse(`${DAYS[0]}T00:00:00Z`);
    const ranged = await pages(`/v1/records?source=${A}&kind=note&from_ms=${from}&to_ms=${from + 3 * 86_400_000}&limit=4`, "records");
    expect(ranged.items).toEqual(heads(A, "h.start_ms, h.key"));
    const sources = readHome(root, (db) => db.prepare("SELECT id FROM sources ORDER BY id").pluck().all());
    expect(sources).toEqual(expect.arrayContaining([CONTACTS, A, B]));
    expect((await pages("/v1/sources?limit=1", "sources")).items.map((row) => row.id)).toEqual(sources);
    expect((await pages("/v1/days?limit=1", "days")).items.map((row) => row.day)).toEqual(held());
    const all = extracts("ORDER BY start_ms, unit");
    const span = `from_ms=${from}&to_ms=${from + 3 * 86_400_000}`;
    const extractPages = await pages(`/v1/extracts?family=notes&${span}&limit=1`, "extracts");
    expect([extractPages.items, extractPages.count]).toEqual([all, all.length]);
    expect((await pages(`/v1/extracts?family=notes&day=${DAYS[0]}&limit=1`, "extracts")).items).toEqual(extracts("AND unit LIKE ? ORDER BY unit", `%/${DAYS[0]}`));
    summary.paging = { records: records.count, ranged: ranged.count, extracts: extractPages.count };
  });

  it("a write between two pages duplicates or skips a row: paging is by key, never by offset", async () => {
    const before = heads(A).map((row) => row.key);
    const first = await json(`/v1/records?source=${A}&kind=note&limit=5`);
    const cursor = first.records.at(-1).key as string;
    await send({ source: A, fetched_ms: Date.now(), rows: [{ ...note(1), key: "a-new" }, { ...note(2), key: "z-new" }, note(20, { text: "synthetic note 20, changed" })] });
    const rest = await pages(`/v1/records?source=${A}&kind=note&limit=5`, "records", first.next as string);
    const keys = [...first.records, ...rest.items].map((row: { key: string }) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([...before, "z-new"]);
    expect(keys.filter((key) => key > cursor)).toEqual([...before.filter((key) => key > cursor), "z-new"]);
    expect(rest.items.find((row: { key: string }) => row.key === "n20").content.text).toBe("synthetic note 20, changed");
    summary.keyset = { cursor, keys: keys.length };
  });

  it("a reader without a read principal reads anything: no token is 401, a device's token 403, before any parameter is looked at", async () => {
    const paths = ["/v1/days?limit=0", `/v1/days/${DAYS[0]}`, "/v1/sources?bogus=1", "/v1/records", "/v1/record", "/v1/extracts", "/v1/enrichments",
      "/v1/labels", "/v1/status", `/v1/blobs/${raw}`, "/v1/feed"];
    const statuses: Record<string, number[]> = {};
    for (const path of paths) {
      const none = await get(path, null);
      const device = await get(path, "device");
      statuses[path] = [none.status, device.status];
      expect(JSON.parse(none.bytes.toString()).code).toBe("PRINCIPAL_UNKNOWN");
      expect(JSON.parse(device.bytes.toString()).code).toBe("PRINCIPAL_SCOPE");
    }
    expect(Object.values(statuses).every(([none, device]) => none === 401 && device === 403)).toBe(true);
    const bad = await fetch(`${url}/v1/labels`, { headers: { authorization: `Bearer ${"x".repeat(43)}` } });
    expect(bad.status).toBe(401);
    summary.auth = statuses;
  });

  it("a reader works a day out itself: the clock is the home's table, its ETag its id, and a time reads in every form as the home reads it", async () => {
    const { day } = effective(root).settings;
    const clock = await get("/v1/clock");
    expect(clock.status).toBe(200);
    const table = JSON.parse(clock.bytes.toString("utf8"));
    expect(table).toEqual(homeClock(day));
    expect(Object.keys(table)).toEqual(["id", "zone", "start_hour", "runs"]);
    expect(clock.headers.get("etag")).toBe(`"${table.id}"`);
    expect((await get("/v1/clock", "reader", { "if-none-match": `"${table.id}"` })).status).toBe(304);
    expect((await get("/v1/clock", "reader", { "if-none-match": '"0000000000000000"' })).status).toBe(200);
    expect((await get("/v1/clock", "device")).status).toBe(403);
    expect((await get("/v1/clock?zone=UTC")).status).toBe(422);

    const nine = instant(`${DAYS[1]}T09:00`, "local", { zone: day.zone }).start_ms;
    const one = (ms: number) => ({ start_ms: ms, end_ms: ms + 1 });
    const times = async (query: string) => (await json(`/v1/time?${query}`)).times;
    expect(await times(`at=${nine}&at=${DAYS[1]}T09:00`)).toEqual([one(nine), one(nine)]);
    expect(await times(`at=${encodeURIComponent(new Date(nine).toISOString())}`)).toEqual([one(nine)]);
    expect(await times(`at=${DAYS[1]}`)).toEqual([dayBounds(DAYS[1]!, day)]);
    const small = instant(`${DAYS[2]}T0${day.day_start_hour - 1}:30`, "local", { zone: day.zone }).start_ms;
    expect(await times(`at=0${day.day_start_hour - 1}:30&in=${DAYS[1]}`)).toEqual([one(small)]);
    expect(civilDay(small, day)).toBe(DAYS[1]);
    const refused: Record<string, unknown> = {};
    for (const [path, named] of [
      ["/v1/time", "at"], [`/v1/time?at=1&at=2&at=3`, "at"], ["/v1/time?at=01:30", "at"], ["/v1/time?at=soon", "at"],
      [`/v1/time?at=01:30&in=2026-13-01`, "in"], ["/v1/time?at=1&when=1", "when"],
    ] as const) {
      const answer = await get(path);
      const body = JSON.parse(answer.bytes.toString()) as { code: string; message: string };
      refused[path] = body;
      expect([path, answer.status, body.code, body.message.split(" ")[0]]).toEqual([path, 422, "BAD_PARAMETER", named]);
    }
    const unreal = JSON.parse((await get("/v1/time?at=2026-02-30T09:00")).bytes.toString()) as { message: string };
    expect(unreal.message).toMatch(/^at is whole milliseconds since the epoch, .*: 2026-02-30 09:00:00 is not a calendar date and clock$/u);
    summary.clock = { clock: { id: table.id, runs: table.runs.length }, refused };
  });

  it("a bad parameter read as a default, or an unknown thing answered 200: 422 naming the parameter, 404 naming the thing", async () => {
    const cases: [string, number, string][] = [
      ["/v1/days?limit=0", 422, "limit"], ["/v1/days?limit=1025", 422, "limit"], ["/v1/days?from=2026-02-30", 422, "from"],
      ["/v1/days?after=not-a-next", 422, "after"], ["/v1/sources?bogus=1", 422, "bogus"],
      [`/v1/records?kind=note`, 422, "source"], [`/v1/records?source=${A}&source=${B}&kind=note`, 422, "source"],
      [`/v1/records?source=${A}&kind=note&from_ms=yesterday`, 422, "from_ms"], [`/v1/records?source=${A}&kind=note&from_ms=10&to_ms=5`, 422, "to_ms"],
      [`/v1/records?source=${A}&kind=note&after=${Buffer.from('[1,"n01"]').toString("base64url")}`, 422, "after"],
      [`/v1/record?source=${A}&kind=note&key=n01&history=yes`, 422, "history"],
      [`/v1/counts?source=${A}`, 422, "kind"], [`/v1/counts?source=${A}&${Array.from({ length: 17 }, (_, index) => `kind=k${index}`).join("&")}`, 422, "kind"],
      ["/v1/counts?source=notes:nobody&kind=note", 404, "SOURCE_UNKNOWN"],
      [`/v1/extracts?family=notes&unit=x&day=${DAYS[0]}`, 422, "unit"], ["/v1/extracts?family=notes&from_ms=1", 422, "to_ms"],
      ["/v1/extracts?family=notes", 422, "unit"], [`/v1/extracts?family=notes&day=${DAYS[0]}&shown=yes`, 422, "shown"], ["/v1/enrichments?family=notes&prompt=p", 422, "item"],
      [`/v1/enrichments?family=notes&prompt=p&${Array.from({ length: 257 }, (_, index) => `item=i${index}`).join("&")}`, 422, "item"],
      [`/v1/days/${DAYS[0]}?file=pdf`, 422, "file"], ["/v1/days/2026-13-01", 422, "day"], ["/v1/labels?x=1", 422, "x"],
      ["/v1/blobs/sha256:abc", 422, "blob"],
      ["/v1/days/2020-01-01", 404, "DAY_UNKNOWN"], [`/v1/record?source=${A}&kind=note&key=nobody`, 404, "RECORD_UNKNOWN"],
      ["/v1/records?source=notes:nobody&kind=note", 404, "SOURCE_UNKNOWN"], ["/v1/extracts?family=notes&unit=nobody", 404, "EXTRACT_UNKNOWN"],
      [`/v1/blobs/sha256:${"0".repeat(64)}`, 404, "BLOB_UNKNOWN"],
    ];
    const seen: Record<string, unknown> = {};
    for (const [path, status, named] of cases) {
      const answer = await get(path);
      const body = JSON.parse(answer.bytes.toString()) as { code: string; message: string };
      seen[path] = [answer.status, body.code, body.message];
      expect([path, answer.status]).toEqual([path, status]);
      if (status === 422) expect([path, body.code, body.message.split(" ")[0]]).toEqual([path, "BAD_PARAMETER", named]);
      else expect([path, body.code]).toEqual([path, named]);
    }
    const delivery = readDelivery(openHomeFolder(root), B, readdirSync(join(root, "inbox", B)).find((name) => name !== "blobs")!)!;
    expect(openHomeFolder(root).blobs(join(root, "blobs"), { reading: true }).has(delivery.files[0]!.blob)).toBe(true);
    expect((await get(`/v1/blobs/${delivery.files[0]!.blob}`)).status).toBe(404);
    summary.refusals = seen;
  });

  it("a path that reaches outside the root: every escape is refused by shape or lands on no route", async () => {
    const secret = readFileSync(join(root, "config", "principals.json"));
    const attempts = [
      "/v1/days/..%2F..%2Fconfig%2Fprincipals.json", "/v1/days/2026-09-28%2F..%2F..%2Fhome.db", "/v1/days/..", "/v1/days/%2e%2e%2f%2e%2e%2fhome.db",
      "/v1/days/../../config/principals.json", "/v1/blobs/..%2F..%2Fhome.db", "/v1/blobs/sha256:..%2F..%2Fhome.db", "/v1/blobs/%2Fetc%2Fpasswd",
      `/v1/days/${DAYS[0]}%00.day.json`, "/v1/days/%E0%A4%A",
    ];
    const answered: Record<string, number> = {};
    for (const path of attempts) {
      const answer = await get(path);
      answered[path] = answer.status;
      expect([path, [404, 422].includes(answer.status)]).toEqual([path, true]);
      expect(answer.bytes.includes(secret)).toBe(false);
      expect(answer.bytes.toString()).not.toContain("SQLite format");
    }
    summary.escapes = answered;
  });

  it("a blob read wrong: whole, by range, by suffix, open-ended and unsatisfiable, raw and compressed, each byte for byte", async () => {
    const read: Record<string, unknown> = {};
    for (const [hash, bytes] of [[raw, RAW], [compressed, TEXT]] as const) {
      const whole = await get(`/v1/blobs/${hash}`);
      expect([whole.status, whole.headers.get("content-length"), whole.headers.get("accept-ranges")]).toEqual([200, String(bytes.length), "bytes"]);
      expect(whole.bytes.equals(bytes)).toBe(true);
      for (const [range, start, end] of [["bytes=10-19", 10, 20], ["bytes=-5", bytes.length - 5, bytes.length], ["bytes=4000-", 4000, bytes.length], ["bytes=0-999999999", 0, bytes.length]] as const) {
        const part = await get(`/v1/blobs/${hash}`, "reader", { range });
        expect([range, part.status, part.headers.get("content-range")]).toEqual([range, 206, `bytes ${start}-${end - 1}/${bytes.length}`]);
        expect(part.bytes.equals(bytes.subarray(start, end))).toBe(true);
      }
      const beyond = await get(`/v1/blobs/${hash}`, "reader", { range: `bytes=${bytes.length}-` });
      expect([beyond.status, beyond.headers.get("content-range")]).toEqual([416, `bytes */${bytes.length}`]);
      expect((await get(`/v1/blobs/${hash}`, "reader", { range: "bytes=0-1,5-6" })).status).toBe(200);
      expect((await get(`/v1/blobs/${hash}`, "reader", { "if-none-match": `"${hash}"` })).status).toBe(304);
      read[hash] = bytes.length;
    }
    const stored = join(root, "blobs", hex(TEXT).slice(0, 2), hex(TEXT).slice(2, 4), hex(TEXT));
    expect(readFileSync(stored).length).toBeLessThan(TEXT.length / 4);
    summary.blobs = read;
  });

  it("a blob whose bytes no longer hash to its name served as a whole answer", async () => {
    const several = Buffer.alloc(3 * (1 << 20) + 100, "synthetic photo bytes ");
    const one = Buffer.from("fake voice note bytes ".repeat(100));
    const json = Buffer.from(JSON.stringify({ rows: Array.from({ length: 50_000 }, (_, i) => ({ i, to: "+15550000001" })) }));
    const store = openHomeFolder(root).blobs(join(root, "blobs"));
    const hashes = [store.put(several), store.put(one), store.put(json, { mediaType: "application/json" })];
    await send({ source: A, fetched_ms: Date.now(), rows: [{ ...note(28), key: "damaged", blobs: hashes }] });
    const pathOf = (bytes: Buffer) => join(root, "blobs", hex(bytes).slice(0, 2), hex(bytes).slice(2, 4), hex(bytes));
    for (const [hash, bytes] of [[hashes[0]!, several], [hashes[1]!, one]] as const) {
      const other = Buffer.from(bytes);
      other[other.length >> 1] = other[other.length >> 1]! ^ 0xff;
      chmodSync(pathOf(bytes), 0o644);
      writeFileSync(pathOf(bytes), other);
      expect(hash).toBe(`sha256:${hex(bytes)}`);
    }
    const half = json.length >> 1;
    const stored = readFileSync(pathOf(json));
    chmodSync(pathOf(json), 0o644);
    writeFileSync(pathOf(json), Buffer.concat([zstdCompressSync(json.subarray(0, half)), zstdCompressSync(json.subarray(half)), stored.subarray(-40)]));
    expect([hashes[2], store.size(hashes[2]!)]).toEqual([`sha256:${hex(json)}`, half]);
    const fetched = (hash: string) => new Promise<{ status: number | null; length: string | undefined; bytes: number; whole: boolean }>((resolve) => {
      httpRequest(`${url}/v1/blobs/${hash}`, { headers: { authorization: `Bearer ${TOKENS.reader}` } }, (response) => {
        let bytes = 0;
        response.on("data", (chunk: Buffer) => { bytes += chunk.length; });
        response.on("error", () => undefined);
        response.on("close", () => resolve({ status: response.statusCode!, length: response.headers["content-length"], bytes, whole: response.complete }));
      }).on("error", () => resolve({ status: null, length: undefined, bytes: 0, whole: false })).end();
    });
    const served = { several: await fetched(hashes[0]!), one: await fetched(hashes[1]!), frames: await fetched(hashes[2]!) };
    expect(served).toEqual({
      several: { status: 200, length: String(several.length), bytes: expect.any(Number), whole: false },
      one: { status: null, length: undefined, bytes: 0, whole: false },
      frames: { status: 200, length: String(half), bytes: expect.any(Number), whole: false },
    });
    expect(served.several.bytes).toBeLessThanOrEqual(3 * (1 << 20));
    expect(served.frames.bytes).toBeLessThan(half);
    summary.damaged = served;
  });

  it("a slow reader of a large blob makes the door hold it: what the door queues for the socket stays one chunk", async () => {
    const big = Buffer.alloc(16 << 20);
    for (let at = 0; at < big.length; at += 4) big.writeUInt32LE(at * 2_654_435_761 >>> 0, at);
    const hash = openHomeFolder(root).blobs(join(root, "blobs")).put(big);
    await send({ source: A, fetched_ms: Date.now(), rows: [{ ...note(29), key: "big", blobs: [hash] }] });
    let queued = 0;
    const write = ServerResponse.prototype.write;
    ServerResponse.prototype.write = function (this: ServerResponse, ...args: Parameters<typeof write>) {
      const result = write.apply(this, args);
      if (this.req?.url?.startsWith("/v1/blobs/")) queued = Math.max(queued, this.writableLength);
      return result;
    } as typeof write;
    try {
      const digest = createHash("sha256");
      let bytes = 0;
      await new Promise<void>((resolve, reject) => {
        httpRequest(`${url}/v1/blobs/${hash}`, { headers: { authorization: `Bearer ${TOKENS.reader}` } }, (response) => {
          let paused = false;
          response.on("data", (chunk: Buffer) => {
            digest.update(chunk);
            bytes += chunk.length;
            if (!paused) {
              paused = true;
              response.pause();
              // paces: the stalled reader's resume; the door must wait for it, not read on.
              setTimeout(() => response.resume(), 100);
            }
          });
          response.on("end", resolve);
          response.on("error", reject);
        }).on("error", reject).end();
      });
      expect([bytes, `sha256:${digest.digest("hex")}`]).toEqual([big.length, hash]);
    } finally {
      ServerResponse.prototype.write = write;
    }
    expect(queued).toBeGreaterThan(0);
    expect(queued).toBeLessThanOrEqual(2 << 20);
    summary.slow_reader = { blob_bytes: big.length, most_queued: queued };
  });

  it("a door that holds home.db open stands in the way of maintenance: a checkpoint while a reader follows the feed and reads", async () => {
    const feed = new AbortController();
    const following = fetch(`${url}/v1/feed`, { headers: { authorization: `Bearer ${TOKENS.reader}` }, signal: feed.signal });
    const stream = (await following).body!.getReader();
    await stream.read();
    expect((await get(`/v1/records?source=${A}&kind=note&limit=3`)).status).toBe(200);
    await fed(stream, await send({ source: A, fetched_ms: Date.now(), rows: [{ ...note(8), key: "before-checkpoint" }] }));
    const checkpoint = await askHome(testSocket(root), "maintenance", ["checkpoint"]) as { checkpoint: { busy: number } };
    expect(checkpoint.checkpoint.busy).toBe(0);
    await send({ source: A, fetched_ms: Date.now(), rows: [{ ...note(9), key: "after-checkpoint" }] });
    expect((await json(`/v1/record?source=${A}&kind=note&key=after-checkpoint`)).key).toBe("after-checkpoint");
    feed.abort();
    await stream.cancel().catch(() => undefined);
    summary.maintenance = checkpoint;
  });

  it("a read during maintenance waits on it or reads a file half done, or reads a file at a version this release does not read: it answers the one 503 at once, then reads again after", async () => {
    await home.stop();
    const held = new Database(join(root, "home.db"), { fileMustExist: true });
    held.pragma("locking_mode = EXCLUSIVE");
    held.exec("BEGIN IMMEDIATE; COMMIT");
    const timings: Record<string, number> = {};
    try {
      for (const path of [`/v1/records?source=${A}&kind=note`, "/v1/labels", `/v1/blobs/${raw}`, "/v1/days", "/v1/status", "/v1/connectors"]) {
        const started = performance.now();
        const answer = await get(path);
        timings[path] = Math.round(performance.now() - started);
        expect([path, answer.status, answer.headers.get("retry-after"), JSON.parse(answer.bytes.toString()).code]).toEqual([path, 503, "5", "NOT_NOW"]);
      }
    } finally {
      held.close();
    }
    expect((await get(`/v1/records?source=${A}&kind=note&limit=1`)).status).toBe(200);
    const feed = new AbortController();
    const stream = (await fetch(`${url}/v1/feed`, { headers: { authorization: `Bearer ${TOKENS.reader}` }, signal: feed.signal })).body!.getReader();
    await stream.read();
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => tx.tables.events.append({ at_ms: Date.now(), kind: "test", key: "fed-without-a-home" }));
    db.close();
    await fed(stream, "fed-without-a-home");
    expect(await maintenance(openHomeFolder(root), ["checkpoint"])).toMatchObject({ checkpoint: { busy: 0 } });
    feed.abort();
    await stream.cancel().catch(() => undefined);
    const setVersion = (version: number) => {
      const write = new Database(join(root, "home.db"), { fileMustExist: true });
      try {
        write.pragma(`user_version = ${version}`);
      } finally {
        write.close();
      }
    };
    setVersion(homeSchema.latest - 1);
    const unread: Record<string, unknown> = {};
    try {
      for (const path of ["/v1/days", "/v1/status", "/v1/connectors"]) {
        const answer = await get(path);
        const body = JSON.parse(answer.bytes.toString()) as { code: string; message: string };
        unread[path] = [answer.status, body.message];
        expect([path, answer.status, body.code, body.message]).toEqual([path, 503, "NOT_NOW", expect.stringMatching(/home\.db is at version \d+; this release reads \d+: the home has not started this release yet/u)]);
      }
    } finally {
      setVersion(homeSchema.latest);
    }
    expect((await get("/v1/status")).status).toBe(200);
    summary.busy = timings;
    summary.unread = unread;
  });
});

describe("a day file an older renderer wrote", () => {
  it("a start that moved the renderer marks no day, the door refuses the old file while its render waits, or the render needs another delivery: served as stored, then the new shape; a second start marks none", async () => {
    const root = makeRoot("lifestream-reads-old-file-", { sources: { [A]: "fake-rows" } });
    mintPrincipal(openHomeFolder(root), { unit: "reader", kind: null, scopes: ["read"], sources: [], token: TOKENS.reader, now_ms: 0 });
    const sock = testSocket(root);
    const marked = () => readHome(root, (db) => db.prepare("SELECT day FROM dirty_days ORDER BY day").pluck().all()) as string[];
    const renderer = () => readHome(root, (db) => db.prepare("SELECT fingerprint FROM cursors WHERE name = 'days'").pluck().get()) as string;
    let home: Home | undefined;
    let door: Door | undefined;
    try {
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
      await ship(root, { source: A, fetched_ms: Date.now(), rows: [note(0), note(10)] });
      await until("the first delivery settled", () => settled(root, 1));
      const OLD = [DAYS[0]!, DAYS[1]!];
      await until("its two days rendered", () => OLD.every((day) => readdirSync(join(root, "days")).includes(`${day}.day.json`)));
      const current = renderer();
      const listed = readHome(root, (db) => db.prepare("SELECT day FROM days ORDER BY day").pluck().all()) as string[];
      expect(listed).toEqual(expect.arrayContaining(OLD));
      await askHome(sock, "pause", ["kind:render", "--reason", "the test holds it"]);
      await home.stop();
      home = undefined;
      const olden = (day: string) => {
        const rendered = readFileSync(dayPath(root, day, "json"), "utf8");
        expect(rendered).toMatch(/"read":"(?:none|into|through)"/u);
        const old = rendered.replace(/"read":"(?:none|into|through)"/gu, `"read_ms":${Date.parse(`${day}T12:00:00Z`)}`)
          .replace(/"renderer": "[^"]*"/u, '"renderer": "7/older"').replace(/"inputs": "sha256:[0-9a-f]{64}"/u, `"inputs": "${digest(`an older renderer's inputs of ${day}`)}"`);
        writeFileSync(dayPath(root, day, "json"), old);
        return old;
      };
      const old = olden(DAYS[0]!);
      olden(DAYS[1]!);
      const db = openHome(openHomeFolder(root), "migrate");
      db.commit((tx) => tx.tables.cursors.move("days", { at_ms: Date.now(), fingerprint: digest("an older renderer") }));
      db.close();
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
      door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 20 }, { lookMs: LOOK_MS, log: () => undefined, registry: FAKES });
      const read = async (asked: string) => {
        const response = await fetch(`http://127.0.0.1:${door!.port}${asked}`, { headers: { authorization: `Bearer ${TOKENS.reader}` } });
        return { status: response.status, etag: response.headers.get("etag"), text: await response.text() };
      };
      expect(renderer()).toBe(current);
      const upgraded = marked();
      expect(upgraded).toEqual(expect.arrayContaining(listed));
      expect(((JSON.parse((await read("/v1/days")).text) as { days: { day: string }[] }).days).map((row) => row.day)).toContain(DAYS[0]);
      const stored = await read(`/v1/days/${DAYS[0]}?file=json`);
      expect([stored.status, stored.text, stored.etag]).toEqual([200, old, `"${digest(`an older renderer's inputs of ${DAYS[0]}`)}"`]);
      await askHome(sock, "resume", ["kind:render"]);
      await until("both days drawn again", () => OLD.every((day) => !readFileSync(dayPath(root, day, "json"), "utf8").includes('"read_ms"')));
      await until("every day marked rendered", () => marked().length === 0);
      const drawn = await read(`/v1/days/${DAYS[0]}?file=json`);
      expect(drawn.status).toBe(200);
      expect(drawn.text).toMatch(/"read":"(?:none|into|through)"/u);
      expect(drawn.text).not.toContain("read_ms");
      expect(readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries").pluck().get())).toBe(1);
      await askHome(sock, "pause", ["kind:render", "--reason", "the test holds it"]);
      await door.close();
      door = undefined;
      await home.stop();
      home = undefined;
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
      expect(marked()).toEqual([]);
      summary.older_renderer = { stored: stored.etag, drawn: drawn.etag, upgraded };
    } finally {
      await door?.close();
      await home?.stop().catch(() => undefined);
      removeRoot(root);
    }
  });
});

describe("a blob's stream across an erasure of it", () => {
  it("an erasure of a blob cuts its stream held open mid-blob: the stream ends unfinished, and the erasure completes after it", async () => {
    const root = makeRoot("lifestream-reads-cut-", { sources: { [A]: "fake-rows" } });
    mintPrincipal(openHomeFolder(root), { unit: "reader", scopes: ["read"], token: TOKENS.reader, now_ms: 0 });
    const door = await doorHere(root, { registry: FAKES });
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
    try {
      const big = Buffer.alloc(16 << 20);
      for (let at = 0; at < big.length; at += 4) big.writeUInt32LE((at * 2_654_435_761 + 7) >>> 0, at);
      const hash = `sha256:${hex(big)}`;
      await ship(root, { source: A, fetched_ms: Date.now(), rows: [{ ...note(0), key: "streamed", blobs: [hash] }], carried: { [hex(big)]: big } });
      await until("the home settled", () => settled(root, 1));
      const closed = () => door.logs.some((line) => line.includes(`"path":"/v1/blobs/sha256:${hex(big).slice(0, 8)}`) && line.includes(`"method":"GET"`));
      let bytes = 0;
      let opened!: () => void;
      const first = new Promise<void>((resolve) => { opened = resolve; });
      let response!: IncomingMessage;
      const ended = new Promise<boolean>((resolve) => {
        httpRequest(`${door.url}/v1/blobs/${hash}`, { headers: { authorization: `Bearer ${TOKENS.reader}` } }, (answer) => {
          response = answer;
          answer.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes === chunk.length) {
              answer.pause();
              opened();
            }
          });
          answer.on("error", () => undefined);
          answer.on("close", () => resolve(answer.complete));
        }).on("error", () => resolve(false)).end();
      });
      await first;
      expect([response.statusCode, closed()]).toEqual([200, false]);
      const erased = await askHome(testSocket(root), "erase", ["notes", "streamed", "--apply"]) as { blobs: number };
      expect([erased.blobs, closed()]).toEqual([1, true]);
      response.resume();
      const whole = await ended;
      expect([whole, bytes < big.length]).toEqual([false, true]);
      summary.cut = { blob_bytes: big.length, read: bytes };
    } finally {
      await home.stop().catch(() => undefined);
      await door.stop();
      removeRoot(root);
    }
  });
});

describe("a day file's stream, and a cut owed, across an erasure", () => {
  const held = (url: string, path: string) => {
    let bytes = 0;
    let opened!: () => void;
    const first = new Promise<void>((resolve) => { opened = resolve; });
    let response!: IncomingMessage;
    const ended = new Promise<boolean>((resolve) => {
      httpRequest(`${url}${path}`, { headers: { authorization: `Bearer ${TOKENS.reader}` } }, (answer) => {
        response = answer;
        answer.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes === chunk.length) {
            answer.pause();
            opened();
          }
        });
        answer.on("error", () => undefined);
        answer.on("close", () => resolve(answer.complete));
      }).on("error", () => resolve(false)).end();
    });
    return { first, ended, status: () => response.statusCode, resume: () => response.resume(), bytes: () => bytes };
  };
  const marked = (root: string): boolean => {
    const db = new Database(join(root, "replies", "replies.db"), { readonly: true });
    try {
      return db.prepare("SELECT 1 FROM meta WHERE key = 'erasing'").get() !== undefined;
    } finally {
      db.close();
    }
  };
  const BIG = 16 << 20;

  it("an erasure of what a day printed cuts that day's file streamed open mid-file: it ends unfinished, the erasure completes after it", async () => {
    const root = makeRoot("lifestream-reads-day-cut-", { sources: { [A]: "fake-rows" } });
    mintPrincipal(openHomeFolder(root), { unit: "reader", scopes: ["read"], token: TOKENS.reader, now_ms: 0 });
    const door = await doorHere(root, { registry: FAKES });
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
    try {
      await ship(root, { source: A, fetched_ms: Date.now(), rows: [{ ...note(0), key: "printed" }] });
      await until("the home settled", () => settled(root, 1));
      await until("the day's file rendered", () => readFileSync(dayPath(root, DAYS[0]!, "txt"), "utf8").includes("synthetic note 0"));
      writeFileSync(dayPath(root, DAYS[0]!, "txt"), "synthetic note 0\n".repeat(BIG / 17));
      const stream = held(door.url, `/v1/days/${DAYS[0]}?file=txt`);
      await stream.first;
      const closed = () => door.logs.some((line) => line.includes(`"path":"/v1/days/${DAYS[0]}"`) && line.includes(`"method":"GET"`));
      expect([stream.status(), closed()]).toEqual([200, false]);
      const erased = await askHome(testSocket(root), "erase", ["notes", "printed", "--apply"]) as { days: string[]; streams: string };
      expect([erased.days, erased.streams, closed(), marked(root)]).toEqual([[DAYS[0]], "cut", true, false]);
      stream.resume();
      expect([await stream.ended, stream.bytes() < BIG]).toEqual([false, true]);
    } finally {
      await home.stop().catch(() => undefined);
      await door.stop();
      removeRoot(root);
    }
  });

  it("a cut the door does not answer, a door holding the folder, leaves the mark standing and the erasure not complete; the next start cuts every stream and clears it", async () => {
    const root = makeRoot("lifestream-reads-owed-", { sources: { [A]: "fake-rows" } });
    const probe = await new Promise<number>((resolve) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as { port: number }).port;
        server.close(() => resolve(port));
      });
    });
    editSettings(root, { "door.port": probe });
    mkdirSync(join(root, "door"), { recursive: true });
    const lock = trySharedLock(join(root, DOOR_LOCK))!;
    const logs: string[] = [];
    let home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: (line) => logs.push(JSON.stringify(line)) });
    try {
      await ship(root, { source: A, fetched_ms: Date.now(), rows: [{ ...note(0), key: "owed" }] });
      await until("the home settled", () => settled(root, 1));
      const erased = await askHome(testSocket(root), "erase", ["notes", "owed", "--apply"]) as { applied: boolean; streams: string };
      expect([erased.applied, erased.streams, marked(root)]).toEqual([true, "owed", true]);
      await home.stop();
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: (line) => logs.push(JSON.stringify(line)) });
      expect(marked(root)).toBe(true);
      expect(logs.some((line) => line.includes("erasure mark stands"))).toBe(true);
      await home.stop();
      lock.release();
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: (line) => logs.push(JSON.stringify(line)) });
      expect(marked(root)).toBe(false);
      expect(logs.some((line) => line.includes("erasure mark cleared"))).toBe(true);
    } finally {
      lock.release();
      await home.stop().catch(() => undefined);
      removeRoot(root);
    }
  });

  const bigBlob = (door: { logs: string[] }) => {
    const bytes = Buffer.alloc(BIG);
    for (let at = 0; at < bytes.length; at += 4) bytes.writeUInt32LE((at * 2_654_435_761 + 7) >>> 0, at);
    const name = hex(bytes);
    const closed = () => door.logs.findIndex((line) => line.includes(`"path":"/v1/blobs/sha256:${name.slice(0, 8)}`) && line.includes(`"method":"GET"`));
    return { bytes, hash: `sha256:${name}`, carried: { [name]: bytes }, closed: () => closed() !== -1, line: closed };
  };

  it("a blob's stream on a part a connectors swap left draining is cut by an erasure of it, which completes only after it closed", async () => {
    const root = makeRoot("lifestream-reads-swap-cut-", { sources: { [A]: "fake-rows" } });
    mintPrincipal(openHomeFolder(root), { unit: "reader", scopes: ["read"], token: TOKENS.reader, now_ms: 0 });
    let swapped = false;
    const door = await doorHere(root, { registry: FAKES, generation: async (folder, machineDir) => (swapped ? "a-swapped-generation" : await askGeneration(folder, machineDir)) });
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
    try {
      const blob = bigBlob(door);
      await ship(root, { source: A, fetched_ms: Date.now(), rows: [{ ...note(0), key: "swapped", blobs: [blob.hash] }], carried: blob.carried });
      await until("the home settled", () => settled(root, 1));
      const stream = held(door.url, `/v1/blobs/${blob.hash}`);
      await stream.first;
      const serving = () => door.logs.filter((line) => line.includes('"door":"serving"')).length;
      const before = serving();
      swapped = true;
      await until("another part serves, the stream's part draining", () => serving() > before);
      expect([stream.status(), blob.closed()]).toEqual([200, false]);
      const erased = await askHome(testSocket(root), "erase", ["notes", "swapped", "--apply"]) as { blobs: number; streams: string };
      expect([erased.blobs, erased.streams, blob.closed(), marked(root)]).toEqual([1, "cut", true, false]);
      stream.resume();
      expect([await stream.ended, stream.bytes() < BIG]).toEqual([false, true]);
    } finally {
      await home.stop().catch(() => undefined);
      await door.stop();
      removeRoot(root);
    }
  });

  it("a blob's stream on a part a move left draining, the home moved away and back before it closed: the lock stays the draining part's, no second door takes it, and an erasure of the blob cuts the stream and completes only after it closed", async () => {
    const root = realpathSync(makeRoot("lifestream-reads-move-back-", { sources: { [A]: "fake-rows" } }));
    mintPrincipal(openHomeFolder(root), { unit: "reader", scopes: ["read"], token: TOKENS.reader, now_ms: 0 });
    const here = newMachine("reads-move-back");
    pointAt(machine({ env: { LIFESTREAM_MACHINE_DIR: here.dir }, home: here.user }), root);
    const now = () => machine({ env: { LIFESTREAM_MACHINE_DIR: here.dir }, home: here.user });
    const at = now();
    const away = join(realpathSync(temp("reads-move-back-to")), "home");
    const door = await doorHere(root, { registry: FAKES, machine: at });
    let home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, machine: at, log: () => undefined });
    try {
      const blob = bigBlob(door);
      await ship(root, { source: A, fetched_ms: Date.now(), rows: [{ ...note(0), key: "moved", blobs: [blob.hash] }], carried: blob.carried }, { machineDir: here.dir });
      await until("the home settled", () => settled(root, 1));
      const stream = held(door.url, `/v1/blobs/${blob.hash}`);
      await stream.first;
      await home.stop();
      await move(away, { machine: now() });
      await until("the door left the home's folder, its part draining", () => door.logs.some((line) => line.includes(`Lifestream moved to ${away}`)));
      await move(root, { machine: now() });
      expect([stream.status(), blob.closed()]).toEqual([200, false]);
      expect(tryLock(join(root, DOOR_LOCK))).toBe(null);
      const serving = () => door.logs.filter((line) => line.includes('"door":"serving"')).length;
      const before = serving();
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, machine: now(), log: () => undefined });
      const erased = await askHome(testSocket(root, here.dir), "erase", ["notes", "moved", "--apply"]) as { blobs: number; streams: string };
      expect([erased.blobs, erased.streams, blob.closed(), marked(root)]).toEqual([1, "cut", true, false]);
      stream.resume();
      expect([await stream.ended, stream.bytes() < BIG]).toEqual([false, true]);
      await until("the door serves the home's folder again", () => serving() > before);
      expect(tryLock(join(root, DOOR_LOCK))).toBe(null);
    } finally {
      await home.stop().catch(() => undefined);
      await door.stop();
      removeRoot(root);
      removeTemps();
    }
  });

  it("a cut owed is settled before the next erasure: refused while the door is out of reach, the mark standing; in reach, the earlier stream cut before the next erasure goes, whose end then clears the mark", async () => {
    const root = makeRoot("lifestream-reads-owed-next-", { sources: { [A]: "fake-rows" } });
    mintPrincipal(openHomeFolder(root), { unit: "reader", scopes: ["read"], token: TOKENS.reader, now_ms: 0 });
    const door = await doorHere(root, { registry: FAKES });
    let reachable = false;
    const relay = createHttpServer((request, response) => {
      if (!reachable) return void request.socket.destroy();
      const onward = httpRequest({
        host: "127.0.0.1", port: door.door.port, path: request.url, method: request.method, headers: { ...request.headers, host: `127.0.0.1:${door.door.port}` },
      }, (answer) => {
        response.writeHead(answer.statusCode!, answer.headers);
        answer.pipe(response);
      });
      onward.on("error", () => response.destroy());
      request.pipe(onward);
    });
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    editSettings(root, { "door.port": (relay.address() as AddressInfo).port });
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
    const sock = testSocket(root);
    try {
      const blob = bigBlob(door);
      await ship(root, { source: A, fetched_ms: Date.now(), rows: [{ ...note(0), key: "earlier", blobs: [blob.hash] }, { ...note(1), key: "later" }], carried: blob.carried });
      await until("the home settled", () => settled(root, 1));
      const stream = held(door.url, `/v1/blobs/${blob.hash}`);
      await stream.first;
      const earlier = await askHome(sock, "erase", ["notes", "earlier", "--apply"]) as { applied: boolean; streams: string };
      expect([earlier.applied, earlier.streams, marked(root), blob.closed()]).toEqual([true, "owed", true, false]);
      await expect(askHome(sock, "erase", ["notes", "later", "--apply"])).rejects.toThrow(/still owed/);
      expect([marked(root), blob.closed()]).toEqual([true, false]);
      reachable = true;
      const cuts = () => door.logs.flatMap((line, at) => (line.includes('"path":"/v1/streams/leaving"') ? [at] : []));
      const later = await askHome(sock, "erase", ["notes", "later", "--apply"]) as { applied: boolean; records: number; streams: string };
      expect([later.applied, later.records, later.streams, blob.closed(), marked(root)]).toEqual([true, 1, "cut", true, false]);
      expect(cuts()).toHaveLength(2);
      expect(blob.line()).toBeLessThan(cuts()[0]!);
      stream.resume();
      expect([await stream.ended, stream.bytes() < BIG]).toEqual([false, true]);
    } finally {
      await home.stop().catch(() => undefined);
      await new Promise((resolve) => relay.close(resolve));
      await door.stop();
      removeRoot(root);
    }
  });

  it("an erasure killed before its commit, the home started again while its door's cut route is out of reach: the removal completes and the mark stands; in reach, the next start cuts every stream and clears it", async () => {
    const root = makeRoot("lifestream-reads-resume-owed-", { sources: { [A]: "fake-rows" } });
    const door = await doorHere(root, { registry: FAKES });
    let reachable = false;
    const relay = createHttpServer((request, response) => {
      if (!reachable) return void request.socket.destroy();
      const onward = httpRequest({
        host: "127.0.0.1", port: door.door.port, path: request.url, method: request.method, headers: { ...request.headers, host: `127.0.0.1:${door.door.port}` },
      }, (answer) => {
        response.writeHead(answer.statusCode!, answer.headers);
        answer.pipe(response);
      });
      onward.on("error", () => response.destroy());
      request.pipe(onward);
    });
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    editSettings(root, { "door.port": (relay.address() as AddressInfo).port });
    const sock = testSocket(root);
    const ran = () => readHome(root, (db) => ({
      intent: db.prepare("SELECT count(*) FROM meta WHERE key = 'erasure'").pluck().get(),
      erased: db.prepare("SELECT count(*) FROM runs WHERE kind = 'erase' AND outcome = 'ok'").pluck().get(),
    }));
    const logs: string[] = [];
    const dying = new ChildHome(root);
    let home: Home | undefined;
    try {
      dying.start("erase.cleanup");
      await dying.ready();
      await ship(root, { source: A, fetched_ms: Date.now(), rows: [{ ...note(0), key: "resumed" }] });
      await until("the home settled", () => settled(root, 1));
      await expect(askHome(sock, "erase", ["notes", "resumed", "--apply"])).rejects.toThrow();
      expect(await dying.exited()).toEqual({ code: null, signal: "SIGKILL" });
      rmSync(sock.path, { force: true });
      expect([ran(), marked(root)]).toEqual([{ intent: 1, erased: 0 }, true]);
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: (line) => logs.push(JSON.stringify(line)) });
      expect([ran(), marked(root)]).toEqual([{ intent: 0, erased: 1 }, true]);
      expect([logs.some((line) => line.includes("erasure finished")), logs.some((line) => line.includes("erasure mark stands"))]).toEqual([true, true]);
      await home.stop();
      reachable = true;
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: (line) => logs.push(JSON.stringify(line)) });
      expect([ran(), marked(root)]).toEqual([{ intent: 0, erased: 1 }, false]);
      expect(logs.some((line) => line.includes("erasure mark cleared"))).toBe(true);
      expect(door.logs.some((line) => line.includes('"path":"/v1/streams/leaving"'))).toBe(true);
    } finally {
      await dying.stop();
      await home?.stop().catch(() => undefined);
      await new Promise((resolve) => relay.close(resolve));
      await door.stop();
      removeRoot(root);
    }
  });
});

describe("a large blob streamed by a door under a capped heap", () => {
  it("a door that holds a blob it serves dies under a heap no larger than the blob", async () => {
    const root = join(tmpdir(), `lifestream-reads-heap-${process.pid}-${Date.now()}`);
    writeFolder(root);
    try {
      const token = TOKENS.reader;
      mintPrincipal(openHomeFolder(root), { unit: "reader", scopes: ["read"], token, now_ms: 0 });
      const heap = 128;
      const line = Buffer.from("a synthetic line of a large text blob, repeated many times over\n");
      const chunk = Buffer.concat(Array.from({ length: (1 << 20) / line.length }, () => line));
      const file = Buffer.concat(Array.from({ length: heap }, () => chunk));
      const hash = openHomeFolder(root).blobs(join(root, "blobs")).put(file, { mediaType: "text/plain" });
      const expected = `sha256:${createHash("sha256").update(file).digest("hex")}`;
      const db = openHome(openHomeFolder(root), "migrate");
      db.close();
      const raw = new Database(join(root, "home.db"));
      raw.prepare("INSERT INTO version_blobs (version, blob) VALUES (?, ?)").run(`sha256:${"1".repeat(64)}`, hash);
      raw.close();
      const door = await startDoor({ root, tokens: { reader: token }, ids: {} }, { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=${heap}` });
      try {
        const response = await fetch(`${door.url}/v1/blobs/${hash}`, { headers: { authorization: `Bearer ${token}` } });
        const digest = createHash("sha256");
        let bytes = 0;
        for await (const part of response.body as AsyncIterable<Uint8Array>) {
          digest.update(part);
          bytes += part.length;
        }
        expect([response.status, bytes, `sha256:${digest.digest("hex")}`]).toEqual([200, file.length, expected]);
        expect(door.child.exitCode).toBeNull();
        summary.capped_heap = { heap_mib: heap, blob_bytes: file.length };
      } finally {
        await door.stop();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("one photo's facts", () => {
  const REGISTRY = fileURLToPath(new URL("./test/photo-registry.ts", import.meta.url));
  const UNIT = "macbook-pro-0001";
  const ZONE = "America/Sao_Paulo";
  const LIBRARY = "apple-photos:person-a@example.com:iphone-aa01";
  const WHATSAPP = "whatsapp:+15550000001:iphone-aa01";
  const WHATSAPP_MAC = "whatsapp:+15550000001:macbook-pro-0001";
  const FIXES = "location:local:iphone-fixes-aa01";
  const OWNER_PLACES = `places:local:${UNIT}`;
  const FACES = `faces:local:${UNIT}`;
  const CAMERAS = `cameras:local:${UNIT}`;
  const CAMERA = "apple/iphone-17-pro";
  const PARTNER = "15550000002@s.whatsapp.net";
  const READER = "synthetic-token-photo-reader".padEnd(43, "r");
  const PHONE = "synthetic-token-photo-phone".padEnd(43, "p");
  const INSTALL = "22222222-2222-4222-8222-222222222222";
  const HOME_POINT = { latitude: 45.75, longitude: 4.85 };
  const CAFE = { latitude: 45.764, longitude: 4.8357 };
  const PARIS = { latitude: 48.8566, longitude: 2.3522 };
  const at = (clock: string, day = "2026-09-12") => Date.parse(`${day}T${clock}Z`);
  const BOX = [1200, 800, 1600, 1300];
  const CROP = "c".repeat(64);
  const SIZE = { width: 4032, height: 3024 };
  const file = (name: string) => {
    const bytes = Buffer.from(`synthetic photo ${name}`);
    return { bytes, hex: hex(bytes), hash: `sha256:${hex(bytes)}` };
  };
  const LIBRARY_PHOTOS = [
    { name: "run-1", at: at("15:00:00"), gps: CAFE }, { name: "run-2", at: at("15:00:20"), gps: CAFE }, { name: "run-3", at: at("15:00:40"), gps: CAFE },
    { name: "screenshot", at: at("15:30:00"), gps: null }, { name: "both", at: at("16:00:00"), gps: CAFE }, { name: "night", at: at("05:10:00", "2026-09-13"), gps: PARIS },
    { name: "late", at: at("02:30:00", "2026-09-13"), gps: null },
  ];
  type Image = ReturnType<typeof file>;
  const [RUN_1, RUN_2, RUN_3, SHOT, BOTH, NIGHT, RECEIVED, LATE, MOVED, MIDNIGHT] = (["run-1", "run-2", "run-3", "screenshot", "both", "night", "received", "late", "moved", "midnight"] as const)
    .map(file) as [Image, Image, Image, Image, Image, Image, Image, Image, Image, Image];
  const picked = ({ city, region, country }: { city: string | null; region: string | null; country: string | null }) => ({ city, region, country });
  let root: string;
  let home: Home;
  let door: Door;
  let url: string;
  const answers: Record<string, unknown> = {};

  let sequence = 0;
  const fix = (when: number, point: { latitude: number; longitude: number }, speed: number) => {
    const iso = new Date(when).toISOString();
    const n = ++sequence;
    return { kind: "fix", key: `${INSTALL}:${n}`, at: when + 1_500, content: { type: "location.fix", content: {
      schema_version: 1, domain: "location", kind: "fix", sequence: n,
      payload: { location: { timestamp_rfc3339_utc: iso, timestamp_unix_seconds: when / 1000, ...point, horizontal_accuracy: 5, vertical_accuracy: 3, altitude: 12, speed, course: 90 },
        capture_context: { engine: "app_owned", authorization: "always" } },
      captured: { wall_rfc3339: iso, wall_unix_seconds: when / 1000, elapsed_seconds: n * 7.5 }, process_instance_id: INSTALL,
    } } };
  };
  const track = (stays: [number, number, { latitude: number; longitude: number }][]) => stays.flatMap(([from, to, point], index) => {
    const rows = [];
    for (let t = from; t < to; t += 120_000) rows.push(fix(t, point, 0));
    const next = stays[index + 1];
    if (next !== undefined) {
      for (let leg = 0; leg < 30; leg++) {
        const share = leg / 30;
        rows.push(fix(to + leg * 20_000, { latitude: point.latitude + (next[2].latitude - point.latitude) * share, longitude: point.longitude + (next[2].longitude - point.longitude) * share }, 9));
      }
    }
    return rows;
  });
  const snapshot = (name: string, when: number) => {
    const { bytes, hash } = file(name);
    const png = name === "screenshot";
    return {
      kind: "img", key: `SYN-${name.toUpperCase()}:null`, at: when, blobs: [hash],
      content: { type: "photos.apple.asset", content: { local_identifier: `SYN-${name.toUpperCase()}`, media_type: "image", modification_date: null, creation_date: new Date(when).toISOString(),
        resources: [{ type: "photo", type_raw: 1, uti: png ? "public.png" : "public.jpeg", original_filename: `IMG_${name}.${png ? "PNG" : "JPG"}`,
          blob: { hash, bytes: bytes.length, type: png ? "image/png" : "image/jpeg", role: "original" } }] } },
    };
  };
  const moved = (from: number, to: number) => {
    const first = snapshot("moved", from);
    const { blob: _blob, ...resource } = first.content.content.resources[0]!;
    return [first, {
      kind: "img", key: "SYN-MOVED:20260912T130000Z", at: to, blobs: [] as string[],
      content: { type: "photos.apple.asset", content: { ...first.content.content, modification_date: "2026-09-12T13:00:00Z", creation_date: new Date(to).toISOString(), resources: [resource] } },
    }];
  };
  const message = (stanza: string, when: number, image: Image, mine: boolean, text: string | null = null) => ({
    kind: "msg", key: `${PARTNER}:${stanza}`, at: when, blobs: [image.hash],
    content: { type: "whatsapp.msg", session_jid: PARTNER, message: { ZMESSAGETYPE: 1, ZISFROMME: mine ? 1 : 0, ZFROMJID: mine ? null : PARTNER, ZTEXT: text },
      blobs: [{ hash: image.hash, bytes: image.bytes.length, role: "ZWAMEDIAITEM.ZMEDIALOCALPATH" }] },
  });

  const get = async (path: string, token = READER, headers: Record<string, string> = {}) => {
    const response = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}`, ...headers } });
    const text = await response.text();
    return { status: response.status, etag: response.headers.get("etag"), body: text === "" ? {} : JSON.parse(text) as Record<string, any> };
  };
  const facts = async (image: { hash: string }) => {
    const answer = await get(`/v1/photos/${image.hash}`);
    expect(answer.status, image.hash).toBe(200);
    return answer.body.photo as Record<string, any>;
  };
  const count = (sql: string, ...params: unknown[]) => readHome(root, (db) => db.prepare(sql).pluck().get(...params) as number);
  const quiet = () => count("SELECT count(*) FROM deliveries WHERE state <> 'imported'") === 0 &&
    count("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')") === 0 && count("SELECT count(*) FROM dirty_days") === 0;
  const caption = (image: { hex: string }) => {
    const content = readHome(root, (db) => db.prepare("SELECT content FROM enrichments WHERE family = 'photos' AND item = ? AND state = 'done'").pluck().get(`photo:${image.hex}`) as string | undefined);
    return content === undefined ? undefined : (JSON.parse(content) as { text: string }).text;
  };

  beforeAll(async () => {
    root = makeRoot("lifestream-photo-", {
      sources: {
        [LIBRARY]: "photos-ios-bundle", [WHATSAPP]: "fake-rows", [WHATSAPP_MAC]: "fake-rows", [FIXES]: "fake-rows", [OWNER_PLACES]: "fake-rows", [FACES]: "faces-rows", [CAMERAS]: "cameras-rows",
        [`people:local:${UNIT}`]: "people-home",
      },
      settings: { unit: UNIT, "day.zone": ZONE, "model.transports.fake": { delay_ms: 0 } },
    });
    const principals = openHomeFolder(root);
    mintPrincipal(principals, { unit: "photo-reader-aa01", scopes: ["read"], token: READER, now_ms: 0 });
    mintPrincipal(principals, { unit: "iphone-aa01", kind: "phone", scopes: ["deliver"], sources: [LIBRARY], token: PHONE, now_ms: 0 });
    home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: REGISTRY, log: () => undefined });
    const now = Date.now();
    await ship(root, { source: OWNER_PLACES, fetched_ms: now, rows: [{ kind: "place", key: "cafe-0c0c0c", content: { type: "places.place", name: "Synthetic Cafe", centre: CAFE, radius_m: 100, ids: [] } }] });
    await shipFiles(root, `people:local:${UNIT}`, now, { "statements.ndjson": Buffer.from(`${JSON.stringify({ kind: "person", key: "person-a", content: {
      type: "people.person", slug: "person-a", name: "Person A", full_name: null, show: "name", entity: "person", relationship: null, hidden: false, me: false,
      anchor: { kind: "phone", value: "+15550000002" }, handles: [], excluded: [], dismissed: [], merged_into: null,
    } })}\n`) });
    await ship(root, { source: CAMERAS, fetched_ms: now, rows: [
      { kind: "camera", key: CAMERA, content: { type: "cameras.camera", make: "Apple", model: "iPhone 17 Pro", photos: 60, first_ms: at("15:00:00"), last_ms: at("05:10:00", "2026-09-13"), sample: RUN_1.hash, phones: [] } },
      ...LIBRARY_PHOTOS.filter((each) => each.gps !== null).map(({ name, gps }) => ({ kind: "photo", key: file(name).hex, content: { type: "cameras.photo", camera: CAMERA, gps } })),
    ] });
    await ship(root, { source: FACES, fetched_ms: now, rows: [
      { kind: "named", key: "person-a", content: { labels: [], photos: [{ face: `${RUN_2.hex}:${BOX.join(",")}`, at_ms: at("15:00:20"), camera: true, crop: CROP, tier: null, size: 1_600 }] } },
      { kind: "scan", key: RUN_2.hex, content: { pipeline: "0".repeat(64), status: "ok", ...SIZE, faces: [{ box: BOX }], vectors: null } },
    ] });
    await ship(root, {
      source: LIBRARY, fetched_ms: now, rows: [...LIBRARY_PHOTOS.map(({ name, at: when }) => snapshot(name, when)), ...moved(at("10:00:00"), at("12:00:00"))],
      carried: Object.fromEntries([...LIBRARY_PHOTOS.map(({ name }) => file(name)), MOVED].map(({ hex: held, bytes }) => [held, bytes])),
    });
    await ship(root, {
      source: WHATSAPP, fetched_ms: now,
      rows: [message("3EB0R1", at("15:45:00"), RECEIVED, false), message("3EB0S1", at("16:30:00"), BOTH, true), message("3EB0M1", at("23:59:59"), MIDNIGHT, false)],
      carried: { [RECEIVED.hex]: RECEIVED.bytes },
    });
    await ship(root, { source: WHATSAPP_MAC, fetched_ms: now, rows: [message("3EB0M1", at("00:00:00", "2026-09-13"), MIDNIGHT, false, "synthetic words at midnight")] });
    await ship(root, { source: FIXES, fetched_ms: now, rows: track([[at("12:00:00"), at("14:00:00"), HOME_POINT], [at("14:10:00"), at("17:00:00"), CAFE], [at("17:10:00"), at("18:00:00"), HOME_POINT]]) });
    door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { lookMs: LOOK_MS, log: () => undefined, registry: REGISTRY, floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" } });
    url = `http://127.0.0.1:${door.port}`;
    const held = () => readHome(root, (db) => ({
      deliveries: db.prepare("SELECT source, state FROM deliveries WHERE state <> 'imported'").all(),
      jobs: db.prepare("SELECT kind, state FROM jobs WHERE state IN ('queued', 'running')").all(),
      days: db.prepare("SELECT day, error FROM dirty_days").all(),
      units: db.prepare("SELECT family, unit, error FROM dirty_units WHERE error IS NOT NULL").all(),
      captions: db.prepare("SELECT item, state FROM enrichments WHERE family = 'photos'").all(),
    }));
    const settle = async (what: string, ready: () => boolean | Promise<boolean>) => {
      try {
        await until(what, ready);
      } catch (error) {
        throw new Error(`${(error as Error).message}\n${JSON.stringify({ held: held(), middle: await get(`/v1/photos/${RUN_2.hash}`), first: await get(`/v1/photos/${RUN_1.hash}`) })}`);
      }
    };
    await settle("the deliveries imported and the home quiet", quiet);
    await settle("the four captions answered", () => [RUN_1, RUN_3, BOTH, NIGHT].every((image) => caption(image) !== undefined));
    await settle("Person A on the run's middle", async () => (await get(`/v1/photos/${RUN_2.hash}`)).body.photo?.people.length === 1);
    await settle("the run's first at the café", async () => (await get(`/v1/photos/${RUN_1.hash}`)).body.photo?.place !== null);
    await settle("the home quiet again", quiet);
  });

  afterAll(async () => {
    await door?.close();
    await home?.stop().catch(() => undefined);
    mkdirSync(join(REPO, "packages", "home", ".build", "e2e"), { recursive: true });
    writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "photo.json"), `${JSON.stringify(answers, null, 2)}\n`);
    if (root !== undefined) removeRoot(root);
  });

  it("answers a member the home does not hold, borrows a caption, places a chat image, prints the reader's zone, or is found only when captioned", async () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).not.toBe(ZONE);
    const cafeArea = picked(areaOf(CAFE));
    const place = { slug: "cafe-0c0c0c", name: "Synthetic Cafe", latitude: CAFE.latitude, longitude: CAFE.longitude, radius_m: 100, area: cafeArea };
    const camera = { id: CAMERA, name: "Apple iPhone 17 Pro", mine: true };
    const burstOf = (image: { hex: string }) => readHome(root, (db) => (db.prepare("SELECT unit, content FROM extracts WHERE family = 'photos' AND unit LIKE 'burst/%'").all() as { unit: string; content: string }[])
      .filter(({ content }) => (JSON.parse(content) as { photos: { sha256: string | null }[] }).photos.some((each) => each.sha256 === image.hex)).map(({ unit }) => unit));
    const RUN = `burst/${at("15:00:00")}`;
    expect([RUN_1, RUN_2, RUN_3, SHOT, NIGHT].map(burstOf)).toEqual([[RUN], [RUN], [RUN], [`burst/${at("15:30:00")}`], [`burst/${at("05:10:00", "2026-09-13")}`]]);

    const first = await facts(RUN_1);
    expect(caption(RUN_1)).toMatch(/^fake reply /u);
    expect(first).toEqual({
      hash: RUN_1.hash, kind: "photograph", play: null, at_ms: at("15:00:00"), unit: RUN, day: "2026-09-12", focus: `u:${RUN}`,
      caption: caption(RUN_1), people: [], size: null, place, area: cafeArea, camera, from: "phone", chat: null,
      described: { by: "Fake model", at_ms: expect.any(Number), state: "done", line: expect.stringMatching(/^Fake model · \d{1,2} [A-Z][a-z]{2}$/u), ask: { family: "photos", item: `photo:${RUN_1.hex}`, prompt: "photo-caption" }, choose: [] },
    });
    const middle = await facts(RUN_2);
    expect(caption(RUN_3)).toBeDefined();
    expect(middle).toMatchObject({ kind: "photograph", unit: RUN, caption: null, size: SIZE, place, camera, from: "phone" });
    expect(middle.people).toEqual([{ id: "person:person-a", name: "Person A", me: false, box: BOX, photo: { crop: CROP } }]);
    const last = await facts(RUN_3);
    expect([last.unit, last.caption]).toEqual([RUN, caption(RUN_3)]);
    expect(await facts(SHOT)).toEqual({
      hash: SHOT.hash, kind: "screenshot", play: null, at_ms: at("15:30:00"), unit: `burst/${at("15:30:00")}`, day: "2026-09-12", focus: `u:burst/${at("15:30:00")}`,
      caption: null, people: [], size: null, place: null, area: null, camera: null, from: "phone", chat: null,
      described: { by: null, at_ms: null, state: "off", line: null, ask: null, choose: [] },
    });
    expect([RUN_2, SHOT].map((image) => count("SELECT count(*) FROM extract_items WHERE item = ?", `photo:${image.hex}`))).toEqual([0, 0]);
    const night = await facts(NIGHT);
    expect(night).toMatchObject({ kind: "photograph", at_ms: at("05:10:00", "2026-09-13"), unit: `burst/${at("05:10:00", "2026-09-13")}`, place: null, area: picked(areaOf(PARIS)), camera });
    expect(night.area.country).not.toBeNull();
    expect(await facts(LATE)).toMatchObject({ kind: "image", at_ms: at("02:30:00", "2026-09-13"), unit: `burst/${at("02:30:00", "2026-09-13")}` });
    expect(burstOf(MOVED)).toEqual([`burst/${at("12:00:00")}`]);
    expect(await facts(MOVED)).toMatchObject({ at_ms: at("12:00:00"), unit: `burst/${at("12:00:00")}`, from: "phone", chat: null });
    const sent = { source: WHATSAPP, kind: "msg", key: `${PARTNER}:3EB0R1` };
    expect(await facts(RECEIVED)).toEqual({
      hash: RECEIVED.hash, kind: "image", play: null, at_ms: at("15:45:00"), unit: null, day: "2026-09-12", focus: `rec:${WHATSAPP} msg ${PARTNER}:3EB0R1`,
      caption: null, people: [], size: null, place: null, area: null, camera: null, from: null,
      chat: {
        network: "whatsapp", chat: PARTNER, title: "Person A", group: false, sender: { id: PARTNER, name: "Person A" }, mine: false, at_ms: at("15:45:00"), day: "2026-09-12", record: sent,
        focus: `rec:${WHATSAPP} msg ${PARTNER}:3EB0R1`,
      },
      described: expect.objectContaining({ ask: { family: "messages", item: RECEIVED.hash, prompt: "chat-image-caption" } }),
    });
    const asked = readHome(root, (db) => db.prepare("SELECT state FROM asks WHERE family = 'messages' AND item = ? AND prompt = 'chat-image-caption'").pluck().get(RECEIVED.hash));
    expect([asked, (await facts(RECEIVED)).described.state]).toEqual(asked === "done" ? ["done", "done"] : ["pending", "waiting"]);
    const both = await facts(BOTH);
    const mine = { source: WHATSAPP, kind: "msg", key: `${PARTNER}:3EB0S1` };
    expect(burstOf(BOTH)).toHaveLength(1);
    expect(both).toMatchObject({ kind: "photograph", unit: burstOf(BOTH)[0], place, camera, from: "phone", caption: caption(BOTH) });
    expect(both.chat).toEqual({ network: "whatsapp", chat: PARTNER, title: "Person A", group: false, sender: null, mine: true, at_ms: at("16:30:00"), day: "2026-09-12", record: mine, focus: `rec:${WHATSAPP} msg ${mine.key}` });
    const midnight = await facts(MIDNIGHT);
    const words = { source: WHATSAPP_MAC, kind: "msg", key: `${PARTNER}:3EB0M1` };
    expect(midnight).toMatchObject({ kind: "image", at_ms: at("00:00:00", "2026-09-13"), unit: null, from: null });
    expect(midnight.chat).toEqual({ network: "whatsapp", chat: PARTNER, title: "Person A", group: false, sender: { id: PARTNER, name: "Person A" }, mine: false, at_ms: at("00:00:00", "2026-09-13"), day: "2026-09-12", record: words, focus: `rec:${WHATSAPP_MAC} msg ${words.key}` });
    for (const photo of [first, middle, last, night, await facts(MOVED)]) {
      const atoms = (JSON.parse(readFileSync(dayPath(root, civilDay(photo.at_ms, { zone: ZONE, day_start_hour: 4 }), "json"), "utf8")) as { atoms: { family: string; unit: string }[] }).atoms;
      expect(atoms.some((atom) => atom.family === "photos" && atom.unit === photo.unit), `${photo.hash} ${photo.unit}`).toBe(true);
    }
    Object.assign(answers, { first, middle, night, both, midnight });
  });

  it("answers a hex nobody names, a bad hash, an unchanged answer, the wanted list or the door's own thread wrongly", async () => {
    const unknown = await get(`/v1/photos/sha256:${"0".repeat(64)}`);
    expect([unknown.status, unknown.body.code]).toEqual([404, "PHOTO_UNKNOWN"]);
    for (const path of [`/v1/photos/sha256:${"A".repeat(64)}`, `/v1/photos/${RUN_1.hex}`, "/v1/photos/sha256:abc", `/v1/photos/${RUN_1.hash}?size=tile`]) {
      const refused = await get(path);
      expect([path, refused.status, refused.body.code]).toEqual([path, 422, "BAD_PARAMETER"]);
    }
    const first = await get(`/v1/photos/${RUN_1.hash}`);
    const { position, ...body } = first.body;
    expect(position).toEqual(expect.stringMatching(/^\d+:\d+$/u));
    expect(first.etag).toBe(`"${createHash("sha256").update(JSON.stringify(body)).digest("hex")}"`);
    expect((await get(`/v1/photos/${RUN_1.hash}`, READER, { "if-none-match": first.etag! })).status).toBe(304);
    const wanted = await get(`/v1/photos/wanted?source=${encodeURIComponent(LIBRARY)}&files=1`, PHONE, DEVICE.phone);
    expect([wanted.status, Array.isArray(wanted.body.photos), typeof wanted.body.left]).toEqual([200, true, "object"]);
    const owing = (count: number) => `/v1/photos/wanted?source=${encodeURIComponent(LIBRARY)}&files=1${Array.from({ length: count }, (_, index) => `&owed=${encodeURIComponent(`A1B2C3D4-0000-4000-8000-${String(index).padStart(12, "0")}/L0/001`)}`).join("")}`;
    const owedAll = await get(owing(200), PHONE, DEVICE.phone);
    expect([owedAll.status, owedAll.body.photos]).toEqual([200, wanted.body.photos]);
    const owedTooMany = await get(owing(201), PHONE, DEVICE.phone);
    expect([owedTooMany.status, owedTooMany.body.code, owedTooMany.body.message]).toEqual([422, "BAD_PARAMETER", "owed is named at most 200 times"]);
    const reads = openReads({ folder: openHomeFolder(root), home: new HomeFile(openHomeFolder(root)), blobs: openHomeFolder(root).blobs(join(root, "blobs"), { reading: true }), settings: lastGood(root) });
    const path = `/v1/photos/${RUN_1.hash}`;
    expect([typeof reads.prepared(path), reads.route(path), reads.reply(path)]).toEqual(["function", undefined, undefined]);
    expect([reads.prepared("/v1/photos/wanted"), typeof reads.reply("/v1/photos/wanted")]).toEqual([undefined, "function"]);
    await home.stop();
    const held = new Database(preparedFileOf(preparedDirOf(root, process.env.LIFESTREAM_MACHINE_DIR!, "people"), "people"), { fileMustExist: true });
    try {
      held.pragma("locking_mode = EXCLUSIVE");
      held.exec("BEGIN IMMEDIATE; COMMIT");
      const busy = await get(`/v1/photos/${RUN_2.hash}`);
      expect([busy.status, busy.body.code, busy.body.message]).toEqual([503, "NOT_NOW", "This photo's people and place are being prepared."]);
    } finally {
      held.close();
    }
    expect((await facts(RUN_2)).people.map((person: { id: string }) => person.id)).toEqual(["person:person-a"]);
    answers.unknown = unknown.body;
  });
});

describe("one voice recording's read", () => {
  const REGISTRY = fileURLToPath(new URL("./test/photo-registry.ts", import.meta.url));
  const VOICE = "voice-notes:local:iphone-aa01";
  const READER = "synthetic-token-voice-reader".padEnd(43, "r");
  const HELD = Buffer.from("synthetic voice recording, held");
  const AWAY = Buffer.from("synthetic voice recording, not arrived");
  const at = Date.UTC(2026, 9, 14, 9, 0);
  const recording = (key: string, sound: Buffer, start: number) => ({
    kind: "voice", key, at: start, blobs: [`sha256:${hex(sound)}`],
    content: { type: "voice.note", content: { payload: {
      blob: { hash: `sha256:${hex(sound)}`, type: "audio/mp4" }, duration_seconds: 21,
      started_at: new Date(start).toISOString(), ended_at: new Date(start + 21_000).toISOString(), location: null,
    } } },
  });
  let root: string;
  let home: Home;
  let door: Door;

  beforeAll(async () => {
    root = makeRoot("lifestream-voice-read-", { sources: { [VOICE]: "voice-ios-bundle" }, fake: { unavailable: "a synthetic outage" } });
    mintPrincipal(openHomeFolder(root), { unit: "voice-reader-aa01", scopes: ["read"], token: READER, now_ms: 0 });
    home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: REGISTRY, log: () => undefined });
    await ship(root, {
      source: VOICE, fetched_ms: Date.now(),
      rows: [recording("note-held", HELD, at), recording("note-away", AWAY, at + 3_600_000), { kind: "note", key: "not-a-recording", at, content: { text: "synthetic", at } }],
      carried: { [hex(HELD)]: HELD },
    });
    door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { lookMs: LOOK_MS, log: () => undefined, registry: REGISTRY, floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" } });
  });

  afterAll(async () => {
    await door?.close();
    await home?.stop().catch(() => undefined);
    if (root !== undefined) removeRoot(root);
  });

  it("a recording's read carries no transcribed, or another's, or calls it answered while it waits; one whose sound is away names an ask; a record that is no recording carries one", async () => {
    const read = async (key: string, kind = "voice") => {
      const response = await fetch(`http://127.0.0.1:${door.port}/v1/record?${new URLSearchParams({ source: VOICE, kind, key })}`, { headers: { authorization: `Bearer ${READER}` } });
      expect(response.status, key).toBe(200);
      return await response.json() as Record<string, any>;
    };
    const item = `voice:${hex(HELD)}`;
    const ask = { family: "voice", item, prompt: "voice-transcript" };
    const state = () => readHome(root, (db) => db.prepare("SELECT state FROM asks WHERE family = 'voice' AND item = ?").pluck().get(item)) as string | undefined;
    const settle = async (what: string, ready: () => boolean | Promise<boolean>) => {
      try {
        await until(what, ready);
      } catch (error) {
        throw new Error(`${(error as Error).message}\n${JSON.stringify({ held: readHome(root, (db) => ({
          extracts: db.prepare("SELECT unit, content FROM extracts WHERE family = 'voice'").all(),
          dirty: db.prepare("SELECT unit, error FROM dirty_units WHERE family = 'voice'").all(),
          asks: db.prepare("SELECT item, state, work_id, waits FROM asks WHERE family = 'voice'").all(),
          rows: db.prepare("SELECT item, state, reply_key FROM enrichments WHERE family = 'voice'").all(),
          deliveries: db.prepare("SELECT source, state FROM deliveries").all(),
          records: db.prepare("SELECT source, kind, key FROM heads").all(),
        })) })}`);
      }
    };
    await settle("the held recording waiting on its model", async () => state() === "pending" && (await read("note-held")).transcribed?.line === "The test model isn't available");
    expect((await read("note-held")).transcribed).toEqual({ by: null, at_ms: null, state: "waiting", line: "The test model isn't available", ask, choose: [] });
    await askHome(testSocket(root), "settings", ["set", "model.transports.fake", JSON.stringify({ delay_ms: 10, models: [FAKE_OFFER] })]);
    await settle("the held recording transcribed", () => state() === "done");
    const done = await read("note-held");
    expect(done.blobs).toEqual([`sha256:${hex(HELD)}`]);
    expect(done.transcribed).toEqual({ by: "Fake model", at_ms: expect.any(Number), state: "done", line: `Fake model · ${dayWords(done.transcribed.at_ms, Date.now(), effective(root).settings.day)}`, ask, choose: [] });
    const fixture = clientFixture("record", { ...done, transcribed: { ...done.transcribed, line: "Fake model · 14 Oct" } });
    expect(fixture.held, "homelink/Tests/Fixtures/record.json is this read: LIFESTREAM_FIXTURES=write writes it").toBe(fixture.written);
    expect((await read("note-away")).transcribed).toEqual({ by: null, at_ms: null, state: "off", line: null, ask: null, choose: [] });
    expect("transcribed" in await read("not-a-recording", "note")).toBe(false);
  });
});
