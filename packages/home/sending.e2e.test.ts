import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { serveDoor } from "./door.js";
import { startHome } from "./home.js";
import { mintPrincipal, readPrincipals } from "./principals.js";
import { report as homeReport } from "./report.js";
import { askHome } from "./socket.js";
import type { Need } from "./status.js";
import type { StreamsReport } from "./streams-report.js";
import { fakeDeclarations } from "./test/fakes.js";
import { editSettings, testSocket } from "./test/folder.js";
import { FAKES, makeRoot, readHome, removeRoot, until, TICK_MS } from "./test/harness-root.js";
import { acquisitionBundle, DEVICE, INSTALL_TWO, photoLine, phoneBundle, REPO, sha256 } from "./test/support.js";
import { stated, value } from "./test/through.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

const ACCOUNT = "person-a@example.com";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const report: Record<string, unknown> = {};

afterAll(() => {
  const directory = join(REPO, "packages", "home", ".build", "e2e");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "sending.json"), `${JSON.stringify(report, null, 2)}\n`);
});

type Answer = { status: number; body: Record<string, unknown> };

async function call(url: string, method: string, path: string, headers: Record<string, string>, body?: Buffer | string): Promise<Answer> {
  const response = await fetch(`${url}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const WALL = "2026-08-31T10:00:00.125+05:30";
const captured = { wall_rfc3339: WALL, wall_unix_seconds: Date.parse(WALL) / 1000, elapsed_seconds: 100 };
const lifecycle = (sequence: number) => ({ domain: "location", kind: "lifecycle", sequence, captured, payload: { event: "process_launch" } });

async function running(prefix: string, clock?: () => number) {
  const root = makeRoot(prefix, { sources: {} });
  const reader = mintPrincipal(openHomeFolder(root), { unit: "reader", scopes: ["read"], now_ms: Date.now() }).token;
  const skew = { ms: 0 };
  const now = clock ?? (() => Date.now() + skew.ms);
  const logs: string[] = [];
  const door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, {
    log: (line) => logs.push(line), clock: now, floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" }, registry: FAKES, connectors: fakeDeclarations(),
  });
  editSettings(root, { "door.port": door.port });
  const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, slot: null, log: () => undefined });
  onTestFinished(async () => {
    await door.close();
    await home.stop();
    removeRoot(root);
  });
  const sock = testSocket(root);
  const url = `http://127.0.0.1:${door.port}`;
  const read = { authorization: `Bearer ${reader}` };
  const pair = async (body: Record<string, unknown>, kind: "phone" | "mac", replaces?: string) => {
    const { code } = (await askHome(sock, "pair", replaces === undefined ? [] : ["--replace", replaces])) as { code: string };
    const pass = randomBytes(32).toString("base64url");
    const paired = await call(url, "POST", "/v1/pair", { ...DEVICE[kind], "content-type": "application/json" }, JSON.stringify({ code, pass, kind, ...body }));
    expect(paired.status).toBe(200);
    const unit = paired.body.unit as string;
    const headers = { authorization: `Bearer ${pass}`, ...DEVICE[kind] };
    const id = readPrincipals(openHomeFolder(root)).principals.find((row) => row.unit === unit && row.revoked_at === null)!.id;
    return {
      unit, id, headers,
      exchange: (body: Record<string, unknown> = {}) => call(url, "POST", "/v1/exchange", { ...headers, "content-type": "application/json" }, JSON.stringify(body)),
    };
  };
  return {
    root, url, skew, now, logs,
    async phone(replaces?: string) {
      const phone = await pair({ model: "iPhone 17 Pro", account: ACCOUNT, ...(replaces === undefined ? { new: true } : {}) }, "phone", replaces);
      return { ...phone, ship: (bundle: { id: string; bytes: Buffer }) => call(url, "PUT", `/v1/bundles/${bundle.id}`, phone.headers, bundle.bytes) };
    },
    mac: () => pair({ model: "MacBook Pro", serial4: "0001" }, "mac"),
    async streams(): Promise<StreamsReport> {
      const answer = await call(url, "GET", "/v1/connectors", read);
      expect(answer.status).toBe(200);
      return answer.body as unknown as StreamsReport;
    },
    async needs(): Promise<Need[]> {
      const answer = await call(url, "GET", "/v1/status", read);
      expect(answer.status).toBe(200);
      return answer.body.needs as Need[];
    },
    imported: (pass: string, source: string) => readHome(root, (db) =>
      db.prepare("SELECT count(*) FROM deliveries WHERE pass = ? AND source = ? AND state = 'imported'").pluck().get(pass, source)) as number,
    readThrough: (source: string) => readHome(root, (db) => db.prepare("SELECT read_through_ms FROM sources WHERE id = ?").pluck().get(source)) as number | null,
  };
}

const sendingOf = (streams: StreamsReport) => streams.needs.filter((need) => /^(sending|send|answering):/u.test(need.id))
  .map((need) => ({ id: need.id, state: need.state, words: need.words, connector: need.connector })).sort((a, b) => a.id.localeCompare(b.id));
const stateOf = (streams: StreamsReport, id: string) => streams.connectors.find((each) => each.id === id)!.health;
const deviceOf = (streams: StreamsReport, unit: string) => streams.devices.find((each) => each.unit === unit)!;
const ids = (needs: unknown) => (needs as { id: string }[]).map((need) => need.id).sort();

describe("a source a device states failing", () => {
  it("is a need before an hour or never, on no row or another, says the device's words to the person, outlives its statement; a whole send leaves a stream flowing; a sat-out source's read-through moves", async () => {
    const home = await running("lifestream-sending-stopped-");
    const phone = await home.phone();
    const mac = await home.mac();
    const photos = `apple-photos:${ACCOUNT}:${phone.unit}`, location = `location:local:${phone.unit}`;
    const screen = `screen:local:${mac.unit}`;
    expect((await phone.ship(phoneBundle({ entries: { "location.jsonl": [lifecycle(1)] }, custody: { [location]: { seal: 1 } }, second: 1 }))).status).toBe(201);
    await until("seal 1 imported, Photos read through by its statement", () => home.imported(phone.id, location) === 1 && home.readThrough(photos) !== null);
    const beat = home.readThrough(photos);
    expect(beat).toEqual(expect.any(Number));

    const since = home.now();
    const failing = { sources: { [photos]: { since_ms: since, code: "LOCAL_STORAGE", message: "synthetic: the photos slice did not stage" } } };
    expect((await phone.exchange({ sending: failing })).status).toBe(200);
    const early = await home.streams();
    expect(sendingOf(early)).toEqual([]);
    expect(stateOf(early, "apple-photos").state).not.toBe("broken");

    home.skew.ms = HOUR + MINUTE;
    const refused = {
      sealed: await phone.ship(phoneBundle({ entries: { "location.jsonl": [lifecycle(2)] }, custody: { [location]: { seal: 2 }, [photos]: { seal: 1 } }, satOut: [photos], second: 2 })),
      not_its: await phone.ship(phoneBundle({ entries: { "location.jsonl": [lifecycle(2)] }, custody: { [location]: { seal: 2 } }, satOut: [`apple-photos:${ACCOUNT}:iphone-ffff`], second: 2 })),
    };
    expect(Object.fromEntries(Object.entries(refused).map(([name, answer]) => [name, [answer.status, answer.body.code]])))
      .toEqual({ sealed: [422, "IOS_BUNDLE_BAD_MANIFEST"], not_its: [422, "IOS_BUNDLE_BAD_MANIFEST"] });
    expect((await phone.ship(phoneBundle({ entries: { "location.jsonl": [lifecycle(2)] }, custody: { [location]: { seal: 2 } }, satOut: [photos], second: 3 }))).status).toBe(201);
    await until("the sat-out seal imported for Location", () => home.imported(phone.id, location) === 2);
    expect(home.imported(phone.id, photos)).toBe(0);
    expect(home.readThrough(photos)).toBe(beat);
    expect(home.readThrough(location)).toBeGreaterThan(beat!);

    await phone.exchange({ sending: failing });
    const stopped = await home.streams();
    const photosWords = "Couldn't send Photos";
    const photosLine = "Check that iPhone 17 Pro has free space, then open Lifestream on it";
    expect(sendingOf(stopped)).toEqual([{ id: `sending:${photos}`, state: "broken", words: photosWords, connector: "apple-photos" }]);
    expect(stateOf(stopped, "apple-photos")).toMatchObject({ state: "broken", reason: "failing", words: photosWords, line: photosLine });
    expect(stateOf(stopped, "location").state).not.toBe("broken");
    expect(deviceOf(stopped, phone.unit).health.state).toBe("ok");
    const need = (await home.needs()).find((each) => each.id === `sending:${photos}`)!;
    expect(need).toMatchObject({ since_ms: since, state: "broken", reason: "failing", connector: "apple-photos", copy: photos, unit: phone.unit, words: photosWords, line: photosLine });
    expect(ids((await mac.exchange()).body.needs)).toContain(`sending:${photos}`);
    expect(ids((await phone.exchange({ sending: failing })).body.needs)).toContain(`sending:${photos}`);

    await phone.exchange({ sending: {} });
    const cleared = await home.streams();
    expect(sendingOf(cleared)).toEqual([]);
    expect(deviceOf(cleared, phone.unit).health.state).toBe("ok");

    const whole = { send: { since_ms: home.now() - HOUR - MINUTE, code: "LOCAL_STORAGE", message: "synthetic: the database does not open" } };
    await phone.exchange({ sending: whole });
    const refusedScreen = { sources: { [screen]: { since_ms: home.now() - 2 * HOUR, code: "BUNDLE_TOO_LARGE", message: "synthetic: the door refused the bundle" } } };
    await mac.exchange({ sending: refusedScreen });
    const down = await home.streams();
    const raised = sendingOf(down);
    expect(raised.filter((each) => each.id === `send:${phone.unit}` || each.id === `sending:${screen}`)).toEqual([
      { id: `send:${phone.unit}`, state: "broken", words: "Couldn't send from iPhone 17 Pro", connector: null },
      { id: `sending:${screen}`, state: "broken", words: "Couldn't send Screen", connector: "screen" },
    ]);
    expect(down.needs.filter((each) => each.id === `send:${phone.unit}` || each.id === `sending:${screen}`).map((each) => [each.id, each.line]).sort(([a], [b]) => a!.localeCompare(b!))).toEqual([
      [`send:${phone.unit}`, "Check that iPhone 17 Pro has free space, then open Lifestream on it"],
      [`sending:${screen}`, "Update Lifestream on MacBook Pro"],
    ]);
    for (const id of ["location", "apple-photos"]) expect([id, stateOf(down, id).state]).toEqual([id, "broken"]);
    expect(deviceOf(down, phone.unit).health).toMatchObject({ state: "broken", reason: "failing" });
    expect(ids((await mac.exchange({ sending: refusedScreen })).body.needs)).toEqual(expect.arrayContaining([`send:${phone.unit}`, `sending:${screen}`]));

    const codex = `codex:local:${mac.unit}`;
    const unreadLogs = (since_ms: number) => ({ sources: { [codex]: { since_ms, code: "SESSION_LOG_UNREADABLE", message: "synthetic: rollout-synthetic.jsonl" } } });
    await mac.exchange({ found: ["codex"], sending: unreadLogs(home.now()) });
    const unreadWaiting = stateOf(await home.streams(), "codex");
    expect(unreadWaiting).toMatchObject({ state: "waiting", reason: "retrying", words: "A session log couldn't be read", detail: expect.stringContaining("rollout-synthetic.jsonl") });
    await mac.exchange({ found: ["codex"], sending: unreadLogs(home.now() - 2 * HOUR) });
    const unreadLater = await home.streams();
    expect(stateOf(unreadLater, "codex")).toMatchObject({ state: "waiting", reason: "retrying", words: "A session log couldn't be read",
      detail: expect.stringContaining("rollout-synthetic.jsonl") });
    expect(unreadLater.needs.map((need) => need.id)).not.toContain(`sending:${codex}`);

    await phone.exchange();
    await mac.exchange();
    const again = await home.streams();
    expect(sendingOf(again)).toEqual([]);
    expect(deviceOf(again, phone.unit).health.state).toBe("ok");
    report.stopped = { early: sendingOf(early), stopped: sendingOf(stopped), need, refused: Object.fromEntries(Object.entries(refused).map(([name, answer]) => [name, answer.body])),
      read_through: { beat, photos: home.readThrough(photos), location: home.readThrough(location) }, down: raised,
      phone: deviceOf(down, phone.unit), stopped_phone: deviceOf(stopped, phone.unit), unread_logs: { waiting: unreadWaiting, later: stateOf(unreadLater, "codex") } };
  });
});

describe("answering but not sending", () => {
  it("a pass heard an hour since it delivered says nothing, or is excused while it states an upload, after it delivered, or when it never delivered; one that stops is answering or misses the 26 hours", async () => {
    const home = await running("lifestream-sending-answering-");
    const phone = await home.phone();
    const mac = await home.mac();
    const location = `location:local:${phone.unit}`;
    const answering = `answering:${phone.unit}`;
    const shipped = async (seal: number) => {
      expect((await phone.ship(phoneBundle({ entries: { "location.jsonl": [lifecycle(seal)] }, custody: { [location]: { seal } }, second: seal }))).status).toBe(201);
      await until(`seal ${seal} imported`, () => home.imported(phone.id, location) === seal);
    };
    await shipped(1);
    const raised = async () => sendingOf(await home.streams()).map((each) => each.id);

    await phone.exchange();
    home.skew.ms = 30 * MINUTE;
    await phone.exchange();
    expect(await raised()).toEqual([]);
    home.skew.ms = HOUR + 2 * MINUTE;
    await phone.exchange();
    await mac.exchange();
    const quiet = await home.streams();
    expect(sendingOf(quiet)).toEqual([{ id: answering, state: "broken", words: "iPhone 17 Pro isn’t sending", connector: null }]);
    expect(deviceOf(quiet, phone.unit).health).toMatchObject({ state: "broken", reason: "failing", words: "iPhone 17 Pro isn’t sending", line: "Open Lifestream on it" });
    expect(ids((await mac.exchange()).body.needs)).toContain(answering);

    await shipped(2);
    expect(await raised()).toEqual([]);
    await phone.exchange();
    expect(await raised()).toEqual([]);
    const sending = await home.streams();
    expect(deviceOf(sending, phone.unit).health.state).toBe("ok");

    home.skew.ms += 27 * HOUR;
    const silent = await home.streams();
    expect(silent.needs.map((each) => each.id).filter((id) => id.startsWith("answering:") || id.startsWith("phone:"))).toEqual([]);
    expect(deviceOf(silent, phone.unit).health).toMatchObject({ state: "quiet", reason: "device" });
    report.answering = { quiet: sendingOf(quiet), phone: deviceOf(quiet, phone.unit), silent: deviceOf(silent, phone.unit) };
  });
});

describe("a read-through said again", () => {
  it("a Mac that repeats its last read-through and sends nothing is not sending an hour on; a read-through stated later is its delivery", async () => {
    const home = await running("lifestream-sending-repeat-");
    const mac = await home.mac();
    const screen = `screen:local:${mac.unit}`;
    const answering = `answering:${mac.unit}`;
    const raised = async () => sendingOf(await home.streams()).map((each) => each.id);
    const bundle = acquisitionBundle({ source: screen, fetched_ms: home.now() - MINUTE, files: [["rows.ndjson", Buffer.from(`${JSON.stringify({ time: home.now() })}\n`)]], custody: { [screen]: { seal: 1 } } });
    expect((await call(home.url, "PUT", bundle.path, mac.headers, bundle.bytes)).status).toBe(201);
    await until("the Mac's delivery indexed", () => readHome(home.root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE pass = ? AND seal = 1").pluck().get(mac.id)) === 1);
    const once = { [screen]: stated(value(home.now() - MINUTE, home.now())) };
    await mac.exchange({ through: once });
    home.skew.ms = 2 * MINUTE;
    await mac.exchange({ through: once });
    home.skew.ms = 32 * MINUTE;
    await mac.exchange({ through: once });
    expect(await raised()).toEqual([]);
    home.skew.ms = HOUR + 4 * MINUTE;
    await mac.exchange({ through: once });
    const repeated = await raised();
    expect(repeated).toEqual([answering]);
    await mac.exchange({ through: { [screen]: stated(value(home.now() - MINUTE, home.now())) } });
    const fresh = await raised();
    expect(fresh).toEqual([]);
    report.repeated = { repeated, fresh };
  });
});

describe("a night between requests", () => {
  it("a phone that exchanged after its delivery, slept and woke is no alarm at its wake, and is one after an hour of requests delivering nothing", async () => {
    const home = await running("lifestream-sending-night-");
    const phone = await home.phone();
    const location = `location:local:${phone.unit}`;
    const answering = `answering:${phone.unit}`;
    const raised = async () => sendingOf(await home.streams()).map((each) => each.id);
    expect((await phone.ship(phoneBundle({ entries: { "location.jsonl": [lifecycle(1)] }, custody: { [location]: { seal: 1 } }, second: 1 }))).status).toBe(201);
    await until("seal 1 imported", () => home.imported(phone.id, location) === 1);
    home.skew.ms = 10 * MINUTE;
    await phone.exchange();
    home.skew.ms = 8 * HOUR;
    await phone.exchange();
    const wake = await raised();
    expect(wake).toEqual([]);
    home.skew.ms = 8 * HOUR + 30 * MINUTE;
    await phone.exchange();
    expect(await raised()).toEqual([]);
    home.skew.ms = 9 * HOUR + 2 * MINUTE;
    await phone.exchange();
    const hour = await raised();
    expect(hour).toEqual([answering]);
    report.night = { wake, hour };
  });
});

describe("a hand-over", () => {
  it("the current install speaks for the phone, from its first request, whatever the replaced one says after it", async () => {
    const home = await running("lifestream-sending-handover-");
    const old = await home.phone();
    const photos = `apple-photos:${ACCOUNT}:${old.unit}`, location = `location:local:${old.unit}`;
    const failing = { sources: { [photos]: { since_ms: home.now() - 2 * HOUR, code: "PHOTOS", message: "synthetic: the library refused the read" } } };
    const raised = async () => sendingOf(await home.streams()).map((each) => each.id);
    await old.exchange({ sending: failing });
    const fresh = await home.phone(old.unit);
    const before = await raised();
    expect(before).toEqual([`sending:${photos}`]);
    await fresh.exchange({ sending: {} });
    expect(await raised()).toEqual([]);
    await old.exchange({ sending: { sources: { [photos]: { ...failing.sources[photos], message: "synthetic: the library refused the read again" } } } });
    const changed = await raised();
    expect(changed).toEqual([]);
    expect((await fresh.ship(phoneBundle({ entries: { "location.jsonl": [lifecycle(1)] }, custody: { [location]: { seal: 1 } }, install: INSTALL_TWO, second: 1 }))).status).toBe(201);
    expect((await old.exchange({ sending: failing })).body.replaced).toEqual(expect.any(String));
    expect(await raised()).toEqual([]);
    await fresh.exchange({ sending: failing });
    const own = (await home.needs()).find((each) => each.id === `sending:${photos}`);
    expect(own).toMatchObject({ words: "Couldn't send Photos", line: "Open Lifestream on iPhone 17 Pro" });
    report.handover = { before, changed, own };
  });
});

describe("the door checks the bundle whole", () => {
  it("refuses a gone naming a file no one holds, refuses or lands a line that mixes its clocks, takes a note missing its rich text with no loss stated", async () => {
    const home = await running("lifestream-sending-door-");
    const phone = await home.phone();
    const photos = `apple-photos:${ACCOUNT}:${phone.unit}`, location = `location:local:${phone.unit}`, notes = `notes:local:${phone.unit}`;

    const cleared = Buffer.from("a synthetic screenshot the phone cleared");
    const gone = { ...photoLine(1, cleared), kind: "gone" };
    const goneAnswer = await phone.ship(phoneBundle({ entries: { "photos.jsonl": [gone] }, custody: { [photos]: { seal: 1 } }, second: 1 }));
    expect(goneAnswer.status).toBe(201);

    const mixed = { ...lifecycle(1), boot_id: "00000000-0000-4000-8000-0000000000b1" };
    expect((await phone.ship(phoneBundle({ entries: { "location.jsonl": [mixed, lifecycle(2)] }, custody: { [location]: { seal: 1 } }, second: 2 }))).status).toBe(201);
    await until("the mixed bundle imported", () => home.imported(phone.id, location) === 1);
    const run = readHome(home.root, (db) => db.prepare("SELECT counts FROM runs WHERE kind = 'import' AND subject LIKE ? ORDER BY id DESC LIMIT 1").pluck().get(`${location} %`)) as string;
    const counts = JSON.parse(run) as { new: number; refused: number; refusals: { key: string; violations: string[] }[] };
    expect([counts.new, counts.refused]).toEqual([1, 1]);
    expect(counts.refusals).toEqual([expect.objectContaining({ key: "location.jsonl line 1", violations: [expect.stringContaining("mixes its clocks")] })]);

    const archive = Buffer.from("a synthetic rich-text archive the phone lost");
    const note = {
      schema_version: 1, domain: "notes", kind: "note", sequence: 1, observed_at: "2026-08-31T04:30:00Z", captured, process_instance_id: "00000000-0000-4000-8000-0000000000c1",
      payload: { id: "00000000-0000-4000-8000-00000000e001", folder: null, title: "A synthetic note", text: "A synthetic note", created: "2026-08-31T04:20:00Z",
        modified: "2026-08-31T04:30:00Z", pinned: false, pin_order: 0, deleted_at: null, purged: false, rich: { hash: `sha256:${sha256(archive)}`, bytes: archive.length }, attachments: [] },
    };
    const unstated = await phone.ship(phoneBundle({ entries: { "notes.jsonl": [note] }, custody: { [notes]: { seal: 1 } }, second: 4 }));
    expect([unstated.status, unstated.body.code]).toEqual([409, "FILES_MISSING"]);
    const stated = await phone.ship(phoneBundle({ entries: { "notes.jsonl": [note] }, custody: { [notes]: { seal: 1, lost: [{ items: 1, what: "files this phone no longer holds" }] } }, second: 5 }));
    expect(stated.status).toBe(201);
    report.door = { gone: goneAnswer.status, mixed: counts, note: { unstated: unstated.body, stated: stated.status } };
  });
});

describe("the phone measured", () => {
  it("lifestream report states each latency, arrival to import, the newest fix's age while moving, the quiet minutes and the sends a phone's entries and counts say, and nothing a quiet phone does not state", async () => {
    const base = Math.floor(Date.now() / MINUTE) * MINUTE;
    const at = (minutes: number) => base + minutes * MINUTE;
    const door = { ms: at(-59) };
    const home = await running("lifestream-sending-measured-", () => door.ms);
    const phone = await home.phone();
    const other = await home.phone();
    const location = `location:local:${phone.unit}`, energy = `energy:local:${phone.unit}`;
    const iso = (minutes: number) => new Date(at(minutes)).toISOString();
    const sequences: Record<string, number> = {};
    const line = (domain: string, kind: string, minutes: number, payload: object, observed = false) => {
      const sequence = (sequences[domain] = (sequences[domain] ?? 0) + 1);
      return { domain, kind, sequence, ...(observed ? { observed_at: iso(minutes) } : {}),
        captured: { wall_rfc3339: iso(minutes), wall_unix_seconds: at(minutes) / 1000, elapsed_seconds: sequence }, payload };
    };
    const fix = (minutes: number) => line("location", "fix", minutes, { latitude: 0, longitude: 0 });
    const event = (minutes: number, name: string, detail: object = {}) => line("location", "recorder_event", minutes, { event: name, detail });
    const moves = (minutes: number, to: string) => event(minutes, "coverage_transition", { from: "unknown", to, reason: "synthetic", reason_evidence: "synthetic" });
    const window = (from: number, to: number, counts: Record<string, number>) => line("energy", "parts", from, { window: { start: iso(from), end: iso(to) }, counts }, true);
    const ran = (source: string) => readHome(home.root, (db) =>
      db.prepare("SELECT count(*) FROM deliveries WHERE source = ? AND state = 'imported' AND run IS NOT NULL").pluck().get(source)) as number;

    door.ms = at(-40);
    expect((await phone.exchange()).status).toBe(200);
    door.ms = at(-21.5);
    expect((await phone.ship(phoneBundle({ entries: { "location.jsonl": [
      moves(-50, "high_rate_expected"), fix(-49), fix(-45), fix(-41), fix(-37), event(-33, "visit"),
      event(-32, "catch_geofence_event", { identifier: "region-a", state: "unsatisfied" }), event(-31, "catch_geofence_event", { identifier: "region-a", state: "satisfied" }),
      fix(-30), fix(-26), moves(-22, "stationary_auto_paused"),
    ] }, custody: { [location]: { seal: 1 } }, second: 1 }))).status).toBe(201);
    door.ms = at(-10);
    expect((await other.exchange()).status).toBe(200);
    door.ms = at(-6);
    expect((await phone.exchange()).status).toBe(200);
    door.ms = at(-5);
    expect((await call(home.url, "GET", "/v1/days", phone.headers)).status).toBe(200);
    door.ms = at(0);
    expect((await phone.ship(phoneBundle({ entries: {
      "location.jsonl": [fix(-15), moves(-8, "high_rate_expected"), fix(-7), fix(-3)],
      "energy.jsonl": [
        window(-45, -30, { requests_battery: 3, requests_power: 1, bundles_sent_battery: 1, send_bytes_battery: 2000, send_bytes_power: 500, send_unanswered_battery: 1, files_sent_battery: 2, send_cut_battery: 1 }),
        line("energy", "power_state", -20, { battery_level: 0.5, battery_state: "unplugged" }, true),
        window(-5, 0, { requests_power: 2, bundles_sent_power: 2, files_sent_power: 1, send_bytes_power: 4000, ship_passes: 2 }),
      ],
    }, custody: { [location]: { seal: 2 }, [energy]: { seal: 1 } }, second: 2 }))).status).toBe(201);
    await until("both location bundles and the energy one imported", () => ran(location) === 2 && ran(energy) === 1);
    door.ms = at(4);
    expect((await phone.exchange()).status).toBe(200);

    const doorLog = join(home.root, "door.log");
    writeFileSync(doorLog, `${home.logs.join("\n")}\n`);
    const { phones } = await homeReport(openHomeFolder(home.root), { from_ms: at(-60), to_ms: at(10), door_log: doorLog, machine: join(home.root, "machine") });
    const measured = phones.units[phone.unit]!, quiet = phones.units[other.unit]!;
    const seconds = (minutes: number[]) => ({ p50: minutes[0]! * 60, p90: minutes[1]! * 60, max: minutes[2]! * 60 });
    expect(measured.latency).toEqual({
      moving_fixes: { entries: 8, seconds: seconds([8.5, 27.5, 27.5]), under: { "2m": 0, "5m": 0.25, "15m": 0.5, "30m": 1 } },
      visits: { entries: 1, seconds: seconds([11.5, 11.5, 11.5]), under: { "2m": 0, "5m": 0, "15m": 1, "30m": 1 } },
      geofence_exits: { entries: 1, seconds: seconds([10.5, 10.5, 10.5]), under: { "2m": 0, "5m": 0, "15m": 1, "30m": 1 } },
      moves: { entries: 3, seconds: seconds([8, 28.5, 28.5]), under: { "2m": 1 / 3, "5m": 1 / 3, "15m": 2 / 3, "30m": 1 } },
    });
    expect(measured.import_seconds).not.toBeNull();
    expect(measured.newest_fix).toEqual({ moving_minutes: 46, quiet: 42, without: 1, age_seconds: seconds([7, 20, 20]) });
    const sum = (hours: Record<string, number> | null) => Object.values(hours ?? {}).reduce((total, n) => total + n, 0);
    expect([sum(measured.quiet_minutes), sum(quiet.quiet_minutes)]).toEqual([65, 69]);
    expect(Object.keys(measured.quiet_minutes!).every((hour) => /^\d{4}-\d{2}-\d{2} \d{2}$/u.test(hour))).toBe(true);
    const sends = Object.values(measured.sends ?? {}).reduce<Record<string, number>>((total, hour) => {
      for (const [name, n] of Object.entries(hour)) total[name] = (total[name] ?? 0) + n;
      return total;
    }, {});
    expect(sends).toEqual({
      requests: 6, requests_battery: 3, bundles: 3, bundles_battery: 1, files: 3, files_battery: 2, bytes: 6500, bytes_battery: 2000, unanswered: 1, unanswered_battery: 1, cut: 1, cut_battery: 1,
    });
    expect(quiet).toMatchObject({ import_seconds: null, sends: null, newest_fix: { moving_minutes: 0, quiet: 0, without: 0, age_seconds: null } });
    expect(Object.values(quiet.latency).map((each) => [each.entries, each.seconds, each.under])).toEqual(Array(4).fill([0, null, null]));
    const days = Object.values(phones.days);
    expect(days.flatMap((each) => each.door_starts_ms)).toEqual([at(-59)]);
    expect(days.reduce((total, each) => total + each.import_runs, 0)).toBeGreaterThanOrEqual(3);
    report.measured = phones;
  });
});
