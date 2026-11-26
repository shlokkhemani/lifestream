import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as tlsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { serveDoor } from "./door.js";
import { startHome } from "./home.js";
import { machine } from "./machine.js";
import { unheldWords } from "./photo.js";
import { mintPrincipal, readPrincipals } from "./principals.js";
import { openStated, type Stated } from "./stated.js";
import { askHome } from "./socket.js";
import type { Need } from "./status.js";
import type { StreamsReport } from "./streams-report.js";
import { ranOf, SCRIPT } from "./test/clock-fakes.js";
import { fakeDeclarations } from "./test/fakes.js";
import { editSettings, testSocket } from "./test/folder.js";
import { FAKES, freeSpace, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { DEVICE, REPO } from "./test/support.js";
import { openHomeFolder, type OpenView } from "@lifestreamprotocol/core";

const ACCOUNT = "person-a@example.com";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);
const CLOCKED = fileURLToPath(new URL("./test/clock-fakes.ts", import.meta.url));
const LANE = "apple-notes:local:clock";
const report: Record<string, unknown> = {};

afterAll(() => {
  const directory = join(REPO, "packages", "home", ".build", "e2e");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "limits.json"), `${JSON.stringify(report, null, 2)}\n`);
});

type Answer = { status: number; body: Record<string, unknown> };

async function call(url: string, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Answer> {
  const response = await fetch(`${url}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function overLan(port: number, path: string, headers: Record<string, string>, body: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const asked = tlsRequest({ host: "127.0.0.1", port, method: "POST", path, headers, rejectUnauthorized: false, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown> }));
    });
    asked.on("error", reject);
    asked.end(body);
  });
}

async function running(prefix: string, options: { registry: string; clocks: boolean; clock: () => number }) {
  const root = makeRoot(prefix, {
    clocks: options.clocks, sources: options.clocks ? { [LANE]: "fake-rows" } : {}, ...(options.clocks ? { settings: { "connectors.fake-clock": { refresh: "10m" } } } : {}),
  });
  const dir = mkdtempSync(join(tmpdir(), "lifestream-limits-machine-"));
  writeFileSync(join(dir, "machine.json"), JSON.stringify({ dnssd: join(dir, "no-dns-sd"), bonjour: "127.0.0.1", addresses: [] }));
  const at = machine({ env: { ...process.env, LIFESTREAM_MACHINE_DIR: dir } });
  if (options.clocks) writeFileSync(join(root, SCRIPT), JSON.stringify({ fetch: [], page: [] }));
  const logs: string[] = [];
  const open = (port: number) => serveDoor(root, { port, lan_port: 0, max_bundle_bytes: 1 << 30 }, {
    log: (line) => logs.push(line), clock: options.clock, machine: at, floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" }, registry: options.registry, connectors: fakeDeclarations(),
  });
  let door: Awaited<ReturnType<typeof serveDoor>> | null = await open(0);
  const port = door.port;
  editSettings(root, { "door.port": port });
  const lan = () => (JSON.parse(logs.findLast((line) => line.includes('"door":"open"'))!) as { lan: number }).lan;
  const start = () => startHome(root, {
    registry: options.registry, slot: null, tickMs: TICK_MS, log: (line) => logs.push(line), machine: at,
    clock: options.clocks ? () => options.clock() + ranOf(root).length : options.clock,
  });
  let home = await start();
  onTestFinished(async () => {
    await door?.close();
    await home.stop();
    removeRoot(root);
    rmSync(dir, { recursive: true, force: true });
  });
  const sock = testSocket(root, at.dir);
  const url = `http://127.0.0.1:${door.port}`;
  const pair = async (kind: "phone" | "mac", body: Record<string, unknown>) => {
    const { code } = (await askHome(sock, "pair")) as { code: string };
    const pass = randomBytes(32).toString("base64url");
    const paired = await call(url, "POST", "/v1/pair", { ...DEVICE[kind], "content-type": "application/json" }, JSON.stringify({ code, pass, kind, ...body }));
    expect(paired.status).toBe(200);
    const unit = paired.body.unit as string;
    const headers = { authorization: `Bearer ${pass}`, ...DEVICE[kind], "content-type": "application/json" };
    return {
      unit,
      pass: () => readPrincipals(openHomeFolder(root)).principals.find((each) => each.unit === unit && each.revoked_at === null)!.id,
      exchange: (said: Record<string, unknown> = {}) => call(url, "POST", "/v1/exchange", headers, JSON.stringify(said)),
      away: (said: Record<string, unknown> = {}) => overLan(lan(), "/v1/exchange", headers, JSON.stringify(said)),
      set: (members: Record<string, unknown>) => call(url, "POST", "/v1/settings", headers, JSON.stringify(members)),
    };
  };
  return {
    root, sock, logs, url,
    home: () => home,
    restart: async (meanwhile: () => Promise<void>) => {
      await door!.close();
      door = null;
      await home.stop();
      home = await start();
      await meanwhile();
      door = await open(port);
    },
    mac: (serial4 = "0001") => pair("mac", { model: "MacBook Pro", serial4 }),
    phone: () => pair("phone", { model: "iPhone 17 Pro", account: ACCOUNT, new: true }),
    streams: async () => (await askHome(sock, "connectors")) as StreamsReport,
    needs: async () => ((await askHome(sock, "status", ["--json"])) as { needs: Need[] }).needs,
    told: (unit: string) => readHome(root, (db) => db.prepare("SELECT count(*) FROM events WHERE kind = 'stated' AND key = ?").pluck().get(unit)) as number,
    settled: (unit: string) => {
      const db = new Database(join(root, "door", "stated.db"), { readonly: true });
      try { return (db.prepare("SELECT min(told) FROM stated WHERE unit = ?").pluck().get(unit) as number | null) === 1; } finally { db.close(); }
    },
  };
}

const limits = (needs: readonly Need[]) => needs.filter((need) => need.id === "metered" || need.id.startsWith("room:"))
  .map((need) => [need.id, need.state, need.words, need.line ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));

describe("the home's network", () => {
  it("reads a Mac's word of the last release as no statement, runs the home's page while its Mac states `now`, reads a day of silence as free, answers history to an exchange from away, holds one over loopback, or takes a Mac's word from away, and runs it once the Mac states `all`", async () => {
    const clock = { now: T0 };
    const home = await running("lifestream-limits-network-", { registry: CLOCKED, clocks: true, clock: () => clock.now });
    const ran = () => ranOf(home.root).filter((each) => each.name === "fake-clock").map((each) => each.call);
    const pending = () => readHome(home.root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE kind = 'poll' AND key = 'fake-clock' AND state <> 'done'").pluck().get()) as number;
    const settled = async (count: number, what: string) => {
      await until(what, () => ran().length >= count && pending() === 0);
      return ran();
    };
    const row = async () => (await home.streams()).connectors.find((each) => each.id === "fake-clock")!;
    const history = (answer: Answer) => Object.values(answer.body.sources as Record<string, { history: boolean }>).map((source) => source.history);
    const seen: Record<string, unknown> = {};
    report.network = seen;

    expect(await settled(2, "the first fetch and page")).toEqual(["fetch", "page"]);
    const mac = await home.mac();
    const phone = await home.phone();
    expect(history(await phone.away()).length).toBeGreaterThan(0);

    expect((await mac.exchange({ network: "metered" })).status).toBe(200);
    expect((await mac.exchange({ network: "free" })).status).toBe(200);
    seen.lastRelease = history(await phone.away());
    expect(history(await phone.away()).every((each) => each)).toBe(true);
    expect(limits(await home.needs())).toEqual([]);

    expect((await mac.exchange({ network: "now" })).status).toBe(200);
    await until("the home reads that the past waits", () => home.logs.some((line) => line.includes('"past":"waits"')));
    clock.now = T0 + 10 * MINUTE;
    expect((await settled(3, "the fetch at its refresh")).slice(2)).toEqual(["fetch"]);
    const held = await row();
    seen.held = held.health;
    expect([held.health.state, held.health.reason, held.health.words]).toEqual(["waiting", "metered", "Waiting for Wi-Fi"]);
    expect(limits(await home.needs())).toEqual([["metered", "needs-you", "Lifestream is on a hotspot", "History waits for Wi-Fi · Settings › Mobile data"]]);

    const away = await phone.away();
    const loopback = await phone.exchange();
    seen.answers = { away: history(away), loopback: history(loopback) };
    expect(history(away).every((each) => !each)).toBe(true);
    expect(history(loopback).every((each) => each)).toBe(true);
    expect((await (await home.mac("aa43")).away({ network: "all" })).status).toBe(200);
    expect(limits(await home.needs()).map((need) => need[0])).toEqual(["metered"]);

    const before = ran().length;
    await home.restart(async () => {
      const started = home.home();
      await until("ten ticks of the home started again", () => started.stats().ticks.count >= 10 && pending() === 0);
      seen.restarted = ran().slice(before);
      expect(ran().slice(before)).toEqual([]);
    });
    const told = home.logs.filter((line) => line.includes('"past":"waits"')).length;
    clock.now = T0 + 11 * MINUTE;
    await until("the home started again reads that the past waits", () => home.logs.filter((line) => line.includes('"past":"waits"')).length > told);
    expect(limits(await home.needs()).map((need) => need[0])).toEqual(["metered"]);

    clock.now = T0 + DAY;
    expect((await settled(4, "the fetch a day on")).slice(3)).toEqual(["fetch"]);
    expect((await row()).health.reason).toBe("metered");

    expect((await mac.exchange({ network: "low-data" })).status).toBe(200);
    expect(history(await phone.away()).every((each) => !each)).toBe(true);
    expect(limits(await home.needs())).toEqual([["metered", "needs-you", "Low Data Mode is on", "History waits · turn Low Data Mode off in this Mac's network settings"]]);
    expect((await mac.exchange({ network: "all" })).status).toBe(200);
    expect(history(await phone.away()).every((each) => each)).toBe(true);
    await until("the home reads that the past moves", () => home.logs.some((line) => line.includes('"past":"moves"')) && home.logs.findLastIndex((line) => line.includes('"past":"moves"')) > home.logs.findIndex((line) => line.includes('"past":"waits"')));
    clock.now = T0 + DAY + 10 * MINUTE;
    await until("the page runs once the network is free", () => ran().slice(4).includes("page"));
    seen.free = (await row()).health;
    expect((await row()).health.reason).not.toBe("metered");
    expect(limits(await home.needs())).toEqual([]);
    seen.ran = ran();
  });

  it("holds the home's pages, the door's answers or the need once the Mac whose word held the past is retired, or its pass revoked", async () => {
    const clock = { now: T0 };
    const home = await running("lifestream-limits-gone-", { registry: CLOCKED, clocks: true, clock: () => clock.now });
    const ran = () => ranOf(home.root).filter((each) => each.name === "fake-clock").map((each) => each.call);
    const history = (answer: Answer) => Object.values(answer.body.sources as Record<string, { history: boolean }>).map((source) => source.history);
    const waits = () => home.logs.filter((line) => line.includes('"past":"waits"')).length;
    const moves = () => home.logs.filter((line) => line.includes('"past":"moves"')).length;
    const seen: Record<string, unknown> = {};
    report.gone = seen;
    await until("the first fetch and page", () => ran().join() === "fetch,page");
    const phone = await home.phone();

    const mac = await home.mac();
    await mac.exchange({ network: "now" });
    await until("the home reads that the past waits", () => waits() === 1);
    let freed = moves();
    await askHome(home.sock, "device", ["retire", mac.unit]);
    seen.retired = { needs: limits(await home.needs()), away: history(await phone.away()) };
    expect(limits(await home.needs())).toEqual([]);
    expect(history(await phone.away()).every((each) => each)).toBe(true);
    clock.now = T0 + 3 * MINUTE;
    await until("the home reads that the past moves once its Mac is retired", () => moves() > freed);
    await until("the page runs once its Mac is retired", () => ran().slice(2).includes("page"));

    const other = await home.mac("aa43");
    await other.exchange({ network: "now" });
    await until("the home reads that the other Mac's word holds the past", () => waits() === 2);
    const paged = ran().length;
    freed = moves();
    await askHome(home.sock, "principals", ["revoke", other.pass()]);
    seen.revoked = { needs: limits(await home.needs()), away: history(await phone.away()) };
    expect(limits(await home.needs())).toEqual([]);
    expect(history(await phone.away()).every((each) => each)).toBe(true);
    clock.now = T0 + 20 * MINUTE;
    await until("the home reads that the past moves once the pass is revoked", () => moves() > freed);
    await until("a page runs once the pass is revoked", () => ran().slice(paged).includes("page"));
    seen.ran = ran();
  });
});

describe("why a photo has no picture, from what the devices stated through the door", () => {
  it("names the home's own Mac on loopback as sending, a phone away by its own word, the home's hotspot for an away phone's older photos, keeps a statement left out and takes a word it does not know as none", async () => {
    const home = await running("lifestream-limits-unheld-", { registry: FAKES, clocks: false, clock: () => Date.now() });
    const mac = await home.mac();
    const phone = await home.phone();
    const { token } = mintPrincipal(openHomeFolder(home.root), { unit: "reader-stated", scopes: ["drive"], now_ms: Date.now() });
    const source = (unit: string) => `apple-photos:${ACCOUNT}:${unit}`;
    const units = new Map([[source(mac.unit), mac.unit], [source(phone.unit), phone.unit]]);
    const names = new Map([[mac.unit, "MacBook Pro"], [phone.unit, "Example Phone"]]);
    const view = {
      source: (id: string) => (units.has(id) ? { copy: units.get(id) } : undefined),
      tables: { meta: { get: () => undefined }, devices: { get: (unit: string) => (names.has(unit) ? { model: names.get(unit), retired_ms: null } : undefined) } },
    } as unknown as OpenView;
    const words = async (unit: string) => {
      const stated = (await call(home.url, "GET", "/v1/stated", { authorization: `Bearer ${token}` })).body.stated as Stated;
      return unheldWords(view, stated, { video: false, wanted: { at_ms: 0, missing: [], routes: [{ source: source(unit), asset: "asset-0001", files: ["photo"], refused: false }] } });
    };
    const seen: Record<string, unknown> = {};
    report.unheld = seen;

    expect((await mac.exchange({ network: "now" })).status).toBe(200);
    seen.homeMac = await words(mac.unit);
    seen.homeHotspot = await words(phone.unit);
    expect([seen.homeMac, seen.homeHotspot]).toEqual(["no picture yet: on its way from MacBook Pro", "no picture yet: Lifestream is on a hotspot, so older photos from Example Phone wait for Wi-Fi"]);

    expect((await phone.away({ network: "low-data" })).status).toBe(200);
    const lowData = "no picture yet: Example Phone is on Low Data Mode, which holds its large sends";
    expect(await words(phone.unit)).toBe(lowData);
    expect((await phone.away()).status).toBe(200);
    expect(await words(phone.unit)).toBe(lowData);

    expect((await mac.exchange({ network: "all" })).status).toBe(200);
    expect((await phone.away({ network: "now" })).status).toBe(200);
    seen.phoneNow = await words(phone.unit);
    expect(seen.phoneNow).toBe("no picture yet: on its way from Example Phone, and its older photos wait for Wi-Fi");
    expect((await phone.away({ network: "slow" })).status).toBe(200);
    expect(await words(phone.unit)).toBe("no picture yet: on its way from Example Phone");
    expect((await phone.away({ room: "full" })).status).toBe(200);
    expect(await words(phone.unit)).toBe("no picture yet: Example Phone is out of space");
  });
});

describe("a device's mobile data", () => {
  it("answers each device its own choice, `now` while unset", async () => {
    const home = await running("lifestream-limits-mobile-", { registry: FAKES, clocks: false, clock: () => Date.now() });
    const mac = await home.mac();
    const phone = await home.phone();
    const own = (unit: string) => `devices.${unit}.mobile_data`;
    const seen: Record<string, unknown> = {};
    report.mobile = seen;

    expect([(await phone.exchange()).body.mobile_data, (await mac.exchange()).body.mobile_data]).toEqual(["now", "now"]);
    expect(await phone.set({ [own(phone.unit)]: "everything" })).toEqual({ status: 200, body: {} });
    expect((await mac.set({ [own(mac.unit)]: "small" })).status).toBe(422);
    seen.answers = { phone: (await phone.exchange()).body.mobile_data, mac: (await mac.exchange()).body.mobile_data };
    expect(seen.answers).toEqual({ phone: "everything", mac: "now" });
  });
});

describe("what a device states of its limits", () => {
  it("keeps a stated table of the last release's shape, so a Mac's `stopped` stated before the home's deploy is worded `undefined`", () => {
    const root = mkdtempSync(join(tmpdir(), "lifestream-stated-shape-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "door"));
    openStated(openHomeFolder(root), testSocket(root), () => 0, () => {}, () => false).close();
    const older = new Database(join(root, "door", "stated.db"));
    older.prepare(`INSERT INTO stated (pass, unit, sending, recorder, at_ms, told, heard_ms) VALUES ('pass-a', 'macbook-pro-0001', '{}', '{"state":"stopped"}', 1, 1, 1)`).run();
    older.pragma("user_version = 3");
    older.close();
    openStated(openHomeFolder(root), testSocket(root), () => 0, () => {}, () => false).close();
    const after = new Database(join(root, "door", "stated.db"), { readonly: true });
    try {
      expect(after.prepare("SELECT COUNT(*) AS rows FROM stated").get()).toEqual({ rows: 0 });
    } finally {
      after.close();
    }
  });

  it("ages an asking grant by a recorder's or a room's change, tells a recorder's change more than once a minute or never, forgets a member left out, takes another shape, takes a stopped recorder, raises a disk's need otherwise than by its device's name or for a retired one, or the home's own Mac's beside the home's disk, and reads a network word it does not know as no statement", async () => {
    const skew = { ms: 0 };
    const free = freeSpace(1e12);
    const home = await running("lifestream-limits-stated-", { registry: FAKES, clocks: false, clock: () => Date.now() + skew.ms });
    const mac = await home.mac();
    const phone = await home.phone();
    const seen: Record<string, unknown> = {};
    report.stated = seen;
    const grants = async () => (await home.streams()).devices.find((device) => device.unit === mac.unit)!.grants;

    expect((await mac.exchange({ grants: { screenRecording: "asking" }, room: "ok" })).status).toBe(200);
    await until("the first statement told", () => home.settled(mac.unit) && home.told(mac.unit) === 1);
    skew.ms = MINUTE;
    await mac.exchange({ recorder: { state: "interrupted", cause: "away" } });
    await until("the recorder's change told", () => home.settled(mac.unit) && home.told(mac.unit) === 2);
    skew.ms = 90_000;
    await mac.exchange({ recorder: { state: "interrupted", cause: "browser" } });
    skew.ms = 100_000;
    await mac.exchange({ room: "low" });
    await until("the room's change told", () => home.settled(mac.unit));
    expect(home.told(mac.unit)).toBe(3);
    skew.ms = 110_000;
    await mac.exchange({ recorder: { state: "paused" } });
    expect(home.settled(mac.unit)).toBe(false);

    skew.ms = 2 * MINUTE + 1_000;
    seen.aged = await grants();
    expect(seen.aged).toEqual({});
    skew.ms = 165_000;
    await mac.exchange();
    await until("the held recorder told at the next exchange after the minute", () => home.settled(mac.unit));
    expect(home.told(mac.unit)).toBe(4);

    expect(await mac.exchange({ network: "slow" })).toMatchObject({ status: 200 });
    for (const said of [{ room: "half" }, { recorder: null }, { recorder: { cause: "disk" } }, { recorder: { state: "napping" } },
      { recorder: { state: "interrupted", cause: "nap" } }, { recorder: { state: "interrupted" } },
      { recorder: { state: "interrupted", cause: "disk", since: new Date().toISOString() } }, { recorder: { state: "recording", cause: "disk" } },
      { recorder: { state: "stopped" } }]) {
      expect(await mac.exchange(said)).toMatchObject({ status: 422, body: { code: "BAD_REQUEST" } });
    }

    await askHome(home.sock, "device", ["name", phone.unit, "Sam's iPhone"]);
    await phone.exchange({ room: "full", network: "now" });
    const former = await home.mac("aa41");
    await former.exchange({ network: "all" });
    await mac.exchange({ network: "all" });
    const needs = limits(await home.needs());
    seen.needs = needs;
    const macLow = [`room:${mac.unit}`, "needs-you", "MacBook Pro's disk is almost full", "Photos and dropped files wait for room"];
    const phoneFull = [`room:${phone.unit}`, "broken", "Sam's iPhone's disk is full", "Location and Health aren't saved · free some space on it"];
    expect(needs).toEqual([macLow, phoneFull].sort((a, b) => a[0]!.localeCompare(b[0]!)));
    expect(limits((await phone.exchange()).body.needs as Need[])).toEqual(needs);
    await former.exchange({ room: "low" });
    free.set(4e9);
    const shared = (await home.needs()).filter((need) => need.id === "disk:low" || need.id.startsWith("room:")).map((need) => need.id);
    seen.shared = shared;
    expect(shared.sort()).toEqual(["disk:low", `room:${former.unit}`, `room:${phone.unit}`].sort());
    free.set(1e12);
    await askHome(home.sock, "device", ["retire", former.unit]);
    await mac.exchange({ room: "ok" });
    await askHome(home.sock, "device", ["retire", phone.unit]);
    expect(limits(await home.needs())).toEqual([]);
  });
});
