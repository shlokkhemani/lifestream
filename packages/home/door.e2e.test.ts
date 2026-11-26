import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import fs, { chmodSync, closeSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { createConnection, createServer as createSocketServer, type AddressInfo, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect as tlsConnect } from "node:tls";
import { Writable } from "node:stream";
import { afterAll, describe, expect, it, onTestFinished, vi } from "vitest";
import Database from "better-sqlite3";
import { BOTTOM_BYTES, KEEP_BYTES, openHome, openHomeFolder, tryLock, type JsonObject } from "@lifestreamprotocol/core";
import { DEVICES, releaseFloors } from "./devices.js";
import { modelReaches, MOVED_AWAY, QUIET, serveDoor, stalls, type Door, type DoorOptions } from "./door.js";
import { nudges, NUDGES_OWED } from "./nudges.js";
import { callsLock, listRunners, openLedger, RUNNER_EXCHANGE } from "@lifestreamprotocol/model";
import { readPrivacySettings } from "@lifestreamprotocol/privacy";
import { Models, MODELS_META } from "./models.js";
import { HIDDEN } from "./chat-route.js";
import { awayWords } from "./lifecycle.js";
import { addressesOf, machine, type Interfaces } from "./machine.js";
import { PEOPLE, preparedDirOf, preparedFileOf, writePrepared } from "./prepared.js";
import { peopleFileOf } from "./people.js";
import { BUSY_WORDS, READ_MS } from "./readers.js";
import { DOOR_AWAY, NOT_NOW, Refusal, RETRY_SOON_S, STARTING } from "./refusal.js";
import { openSealing, readDelivery } from "./inbox.js";
import { mintPrincipal, readPrincipals, retireUnit, revokePrincipal, writePrincipals, PRINCIPALS_FORMAT, tokenTag } from "./principals.js";
import { hold, release as releaseHold } from "./hold.js";
import { startHome } from "./home.js";
import { homeRegistryModule } from "./programs.js";
import { askHome } from "./socket.js";
import { PEER_GUESSES } from "./pairing.js";
import { runCli } from "./cli.js";
import type { ConnectorReport, StreamsReport } from "./streams-report.js";
import { fakeDeclarations } from "./test/fakes.js";
import {
  acquisitionBundle, basic, custodyKept, custodyRun, DEVICE, healthLine, holdModels, inboxTree, INSTALL_TWO, LUNA_ROUTE, makeHome, makeHomeDb, NOW_MS, PHONE_SOURCE, PHONE_UNIT, phoneBundle, reach, REPO,
  sha256, startDoor, type Home,
} from "./test/support.js";
import { editSettings, writeFolder, testSocket } from "./test/folder.js";
import { settleAccess } from "./access-move.js";
import { endNudges, FAKE_OFFER, FAKE_ROUTE, FAKES, freeSpace, hex, LOOK_MS, makeRoot, nudgeLog, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship, shipFiles } from "./test/harness-deliveries.js";
import { BUNDLE_ENTRIES, declarations, LENT, memorySecrets, pollCall, vendorOf } from "@lifestreamprotocol/connect";
import { basicInstant, type FakeFolder } from "@lifestreamprotocol/connect/sdk";
import type { StartCost } from "./estimate.js";
import { startWords } from "./stream-words.js";
import { releaseFolder } from "./test/fed.js";
import { GMAIL_ACCOUNT, GMAIL_SOURCE, START_REGISTRY } from "./test/start-registry.js";
import { stated, value } from "./test/through.js";


const MAC = "macbook-pro-0001";
const MACHINE = `machine:local:${MAC}`;
const UNIT_OF_MAC = `runner-${MAC}`;
const CALLS = `apple-calls:person-a@example.com:${MAC}`;
const LOCATION = `location:local:${PHONE_UNIT}`;
const MOTION = `motion:local:${PHONE_UNIT}`;
const PHOTOS = `apple-photos:synthetic-account:${PHONE_UNIT}`;
const FORMATS = { mac: ["org.lifestreamprotocol.acquisition/1"], phone: ["ios-bundle/1", "ios-bundle/2", "ios-bundle/3"] };
const report: Record<string, unknown> = {};

afterAll(() => {
  const directory = join(REPO, "packages", "home", ".build", "e2e");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "door.json"), `${JSON.stringify(report, null, 2)}\n`);
});

function homeWith(principals: Parameters<typeof makeHome>[0]): Home {
  const at = makeHome(principals, []);
  onTestFinished(() => rmSync(at.root, { recursive: true, force: true }));
  return at;
}

function home(): Home {
  return homeWith({
    mac: { kind: "mac", scopes: ["deliver"], sources: [MACHINE, CALLS] },
    phone: { kind: "phone", scopes: ["deliver"], sources: [PHONE_SOURCE, LOCATION, MOTION, PHOTOS], unit: PHONE_UNIT },
    reader: { scopes: ["read"] },
  });
}

interface Running {
  readonly url: string;
  readonly logs: string[];
  readonly door: Door;
}

async function serve(at: Home, settings: { max_bundle_bytes?: number; lan_port?: number } = {}, clock?: () => number, more: DoorOptions = {}): Promise<Running> {
  const logs: string[] = [];
  let tick = 0;
  const door = await serveDoor(at.root, { port: 0, max_bundle_bytes: 8 * 1024 ** 3, ...settings },
    { lookMs: LOOK_MS, log: (line) => logs.push(line), clock: clock ?? (() => NOW_MS + tick++), floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" }, ...more });
  onTestFinished(() => door.close());
  return { url: `http://127.0.0.1:${door.port}`, logs, door };
}

const auth = (at: Home, who: string): Record<string, string> => ({
  authorization: `Bearer ${at.tokens[who]}`, ...(who === "mac" ? DEVICE.mac : who === "phone" ? DEVICE.phone : {}),
});

async function put(url: string, path: string, headers: Record<string, string>, body: Buffer | ReadableStream<Uint8Array>): Promise<{ status: number; body: Record<string, unknown>; retry: string | null }> {
  const response = await fetch(`${url}${path}`, { method: "PUT", headers, body, duplex: "half" } as RequestInit);
  return { status: response.status, body: await response.json() as Record<string, unknown>, retry: response.headers.get("retry-after") };
}

async function get(url: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}${path}`, { headers });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function post(url: string, path: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function exchange(url: string, headers: Record<string, string>, body: unknown = {}, query = ""): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}/v1/exchange${query}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function putUnread(url: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown>; retry: string | null }> {
  return new Promise((resolve, reject) => {
    const framing = headers["content-length"] === undefined ? { "transfer-encoding": "chunked" } : {};
    const request = httpRequest(`${url}${path}`, { method: "PUT", headers: { ...headers, ...framing } }, (response) => {
      let text = "";
      response.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
      response.on("end", () => {
        request.destroy();
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown>, retry: response.headers["retry-after"] as string ?? null });
      });
    });
    request.on("error", reject);
    request.flushHeaders();
  });
}

const sized = (bytes: Buffer): Record<string, string> => ({ "content-length": String(bytes.length) });

function held(bytes: Buffer): { body: ReadableStream<Uint8Array>; started: Promise<void>; release(): void } {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const begun = new Promise<void>((resolve) => { started = resolve; });
  let step = 0;
  return {
    started: begun, release,
    body: new ReadableStream({
      async pull(controller) {
        if (step === 0) { controller.enqueue(bytes.subarray(0, 10)); started(); step = 1; return; }
        await gate;
        controller.enqueue(bytes.subarray(10));
        controller.close();
      },
    }),
  };
}

const mac = (n: number, extra: Partial<Parameters<typeof acquisitionBundle>[0]> = {}) => acquisitionBundle({
  source: MACHINE, fetched_ms: NOW_MS + n * 60_000, files: [[`${String(n).padStart(4, "0")}.jsonl`, Buffer.from(`{"synthetic":${n}}\n`)]],
  custody: { [MACHINE]: { seal: n + 1 } }, ...extra,
});

const sealedNames = (at: Home, source: string) => {
  const directory = join(at.root, "inbox", source);
  return existsSync(directory) ? readdirSync(directory).filter((name) => name !== "blobs" && existsSync(join(directory, name, "manifest.json"))).sort() : [];
};
const leftovers = (at: Home) => readdirSync(join(at.root, "door", "uploads"));
const custodyOf = (answer: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(answer.sources as Record<string, { received: number; imported: number }>).map(([source, held]) => [source, [held.received, held.imported]]));

describe("a device request today's door accepts is refused, or the reverse", () => {
  it("seals a Mac bundle (201 and the answer), its file in its directory and its blob in the source's store; a repeat is 200 and reads nothing", async () => {
    const at = home();
    const { url } = await serve(at);
    const blob = Buffer.from("synthetic machine blob bytes");
    const bundle = mac(0, { blobs: [blob] });
    const first = await put(url, bundle.path, auth(at, "mac"), bundle.bytes);
    expect(first).toMatchObject({ status: 201, retry: null, body: {
      home: { id: expect.stringMatching(/^test-/u), version: "checkout", generation: null, floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" } },
      pass: at.ids.mac, unit: "mac", calls: [],
      sources: { [CALLS]: { received: 0, imported: 0, formats: FORMATS.mac }, [MACHINE]: { received: 1, imported: 0, formats: FORMATS.mac } },
    } });
    expect(Object.keys(first.body)).toEqual(["home", "clock", "pass", "unit", "sources", "owner", "needs", "calls", "settings", "mobile_data", "stores", "turn"]);
    expect(first.body.clock).toMatch(/^[0-9a-f]{16}$/u);
    expect(first.body.settings).toEqual({ "apple-calls": { refresh: "5m", start_ms: null }, machine: { start_ms: null } });
    const directory = join(at.root, "inbox", MACHINE, basic(NOW_MS));
    expect(readFileSync(join(directory, "0000.jsonl"), "utf8")).toBe('{"synthetic":0}\n');
    expect(readFileSync(join(at.root, "inbox", MACHINE, "blobs", sha256(blob)))).toEqual(blob);
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
    expect(Object.keys(manifest)).toEqual(["format", "source_id", "feeder", "fetched_at", "complete", "files", "facts", "custody", "pass", "sealed_at"]);
    expect(manifest).toMatchObject({ format: "org.lifestreamprotocol.acquisition/1", source_id: MACHINE, complete: true,
      fetched_at: new Date(NOW_MS).toISOString(), facts: { blobs_carried: 1 }, custody: { [MACHINE]: { seal: 1 } }, pass: at.ids.mac });
    expect(readDelivery(openHomeFolder(at.root), MACHINE, basic(NOW_MS))).toMatchObject({ id: bundle.id, source: MACHINE, stated_ms: NOW_MS,
      sealed_ms: NOW_MS, stamped_ms: Date.parse(manifest.sealed_at as string), pass: at.ids.mac, custody: { [MACHINE]: { seal: 1 } },
      files: [{ path: "0000.jsonl", blob: `sha256:${sha256(Buffer.from('{"synthetic":0}\n'))}`, size: 16 }] });
    const repeat = await putUnread(url, bundle.path, auth(at, "mac"));
    expect([repeat.status, custodyOf(repeat.body)]).toEqual([200, { [CALLS]: [0, 0], [MACHINE]: [1, 0] }]);
    expect(sealedNames(at, MACHINE)).toEqual([basic(NOW_MS)]);
    expect(leftovers(at)).toEqual([]);
    report.mac_seal = { answer: first.body, manifest, tree: inboxTree(at.root) };
  });

  it("refuses a path id the manifest disagrees with, a body that is no bundle, a tampered file and a tampered blob, leaving no partial and no seal", async () => {
    const at = home();
    const { url } = await serve(at);
    const bundle = mac(0);
    const other = `/v1/acquisitions/${encodeURIComponent(MACHINE)}/${basic(NOW_MS + 1_000)}`;
    const answers = {
      id: await put(url, other, auth(at, "mac"), bundle.bytes),
      not_zip: await put(url, bundle.path, auth(at, "mac"), Buffer.from("this is not a ZIP")),
      file: await put(url, bundle.path, auth(at, "mac"), mac(0, {
        manifest: (stated) => ({ ...stated, files: (stated.files as { file: string; bytes: number }[]).map((file) => ({ ...file, sha256: "f".repeat(64) })) }),
      }).bytes),
      blob: await put(url, bundle.path, auth(at, "mac"), mac(0, {
        manifest: (stated) => ({ ...stated, facts: { ...stated.facts as object, blobs_carried: 1 } }),
        extra: [[`blobs/${"a".repeat(64)}`, Buffer.from("bytes that hash to something else")]],
      }).bytes),
      unlisted: await put(url, bundle.path, auth(at, "mac"), mac(0, { extra: [["stray.txt", Buffer.from("stray")]] }).bytes),
      custody: await put(url, bundle.path, auth(at, "mac"), mac(0, { custody: { [MACHINE]: { seal: 0 } } }).bytes),
    };
    expect(Object.fromEntries(Object.entries(answers).map(([name, answer]) => [name, [answer.status, answer.body.code]]))).toEqual({
      id: [422, "ACQUISITION_ID_MISMATCH"], not_zip: [422, "ACQUISITION_MANIFEST"], file: [422, "ACQUISITION_HASH_MISMATCH"],
      blob: [422, "ACQUISITION_BLOB_MISMATCH"], unlisted: [422, "ACQUISITION_MANIFEST"], custody: [422, "ACQUISITION_MANIFEST"],
    });
    expect(answers.id.body.message).toContain(basic(NOW_MS));
    expect(answers.file.body.message).toContain("0000.jsonl");
    expect(sealedNames(at, MACHINE)).toEqual([]);
    expect(existsSync(join(at.root, "inbox", MACHINE, basic(NOW_MS)))).toBe(false);
    expect(leftovers(at)).toEqual([]);
    report.refusals = Object.fromEntries(Object.entries(answers).map(([name, answer]) => [name, answer.body]));
  });

  it("answers a second PUT of an id while its body is still read with 409 UPLOAD_ACTIVE and Retry-After: 60, a Mac's and a phone's, logged by its code, and the first still seals", async () => {
    const at = home();
    const { url, logs } = await serve(at);
    const active = { status: 409, retry: "60", body: { code: "UPLOAD_ACTIVE", message: "bundle upload is active" } };
    const bundle = mac(0);
    const slow = held(bundle.bytes);
    const first = put(url, bundle.path, { ...auth(at, "mac"), ...sized(bundle.bytes) }, slow.body);
    await until("the Mac's first upload's partial", () => leftovers(at).length > 0);
    const second = await put(url, bundle.path, auth(at, "mac"), bundle.bytes);
    expect(second).toEqual(active);
    slow.release();
    expect((await first).status).toBe(201);
    const phone = phoneBundle({ domains: { "location.jsonl": [1] }, custody: { [LOCATION]: { seal: 1 } } });
    const slowPhone = held(phone.bytes);
    const firstPhone = put(url, `/v1/bundles/${phone.id}`, { ...auth(at, "phone"), ...sized(phone.bytes) }, slowPhone.body);
    await until("the phone's first upload's partial", () => leftovers(at).length > 0);
    const secondPhone = await put(url, `/v1/bundles/${phone.id}`, auth(at, "phone"), phone.bytes);
    expect(secondPhone).toEqual(active);
    slowPhone.release();
    expect((await firstPhone).status).toBe(201);
    const refused = logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.status === 409);
    expect(refused.map((line) => [line.method, line.code])).toEqual([["PUT", "UPLOAD_ACTIVE"], ["PUT", "UPLOAD_ACTIVE"]]);
    report.upload_active = { mac: second.body, phone: secondPhone.body, logged: refused };
  });

  it("lets go of an upload whose body goes silent: its connection ended with no answer, its partial removed, the log saying why, and the phone's next send of the same bundle sealed", async () => {
    const at = home();
    const { url, logs } = await serve(at, {}, undefined, { silentMs: 60 });
    const phone = phoneBundle({ domains: { "location.jsonl": [1] }, custody: { [LOCATION]: { seal: 1 } } });
    const silent = held(phone.bytes);
    let ended: number | "no answer" | undefined;
    void put(url, `/v1/bundles/${phone.id}`, { ...auth(at, "phone"), ...sized(phone.bytes) }, silent.body).then((answer) => { ended = answer.status; }, () => { ended = "no answer"; });
    const puts = () => logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.method === "PUT");
    await until("the door lets the silent upload go", () => puts().length > 0);
    expect(puts()).toMatchObject([{ status: 503, code: "NOT_NOW", message: "The upload stopped arriving: send it again." }]);
    await until("the phone's silent request ends", () => ended !== undefined);
    expect(ended).toBe("no answer");
    expect(leftovers(at)).toEqual([]);
    const again = await put(url, `/v1/bundles/${phone.id}`, auth(at, "phone"), phone.bytes);
    expect([again.status, custodyOf(again.body)[LOCATION]]).toEqual([201, [1, 0]]);
    expect(leftovers(at)).toEqual([]);
    report.upload_silent = { logged: puts(), ended, again: again.status };
  });

  it("states one run and a growing n in every answer's turn, across exchanges, a bundle's 201 and its repeat's 200, a 409 STALE's and a Mac's, in the order they were built", async () => {
    const at = home();
    const { url } = await serve(at);
    type Turn = { run: string; n: number };
    const turns: [string, Turn][] = [];
    const took = (what: string, answer: Record<string, unknown>) => { turns.push([what, answer.turn as Turn]); };
    took("exchange", (await exchange(url, auth(at, "phone"))).body);
    const first = phoneBundle({ domains: { "location.jsonl": [1] }, custody: { [LOCATION]: { seal: 1 } } });
    const sealed = await put(url, `/v1/bundles/${first.id}`, auth(at, "phone"), first.bytes);
    expect(sealed.status).toBe(201);
    took("bundle", sealed.body);
    const repeat = await putUnread(url, `/v1/bundles/${first.id}`, auth(at, "phone"));
    expect(repeat.status).toBe(200);
    took("repeat", repeat.body);
    const behind = phoneBundle({ domains: { "location.jsonl": [1, 2] }, custody: { [LOCATION]: { seal: 1 } } });
    const stale = await put(url, `/v1/bundles/${behind.id}`, auth(at, "phone"), behind.bytes);
    expect([stale.status, stale.body.code]).toEqual([409, "STALE"]);
    took("stale", stale.body.answer as Record<string, unknown>);
    took("mac", (await put(url, mac(0).path, auth(at, "mac"), mac(0).bytes)).body);
    took("exchange again", (await exchange(url, auth(at, "phone"))).body);
    expect(turns.every(([, turn]) => /^[0-9a-f]{16}$/u.test(turn.run))).toBe(true);
    expect(new Set(turns.map(([, turn]) => turn.run)).size).toBe(1);
    const ns = turns.map(([, turn]) => turn.n);
    expect(ns.every((n, index) => Number.isSafeInteger(n) && n >= 1 && (index === 0 || n > ns[index - 1]!))).toBe(true);
    report.turns = turns;
  });

  it("refuses a bundle above the size cap with 413 by its stated length, and one that states no length with 411, before reading a byte, keeping no partial", async () => {
    const at = home();
    const { url } = await serve(at, { max_bundle_bytes: 64 });
    const bundle = mac(0);
    const stated = await putUnread(url, bundle.path, { ...auth(at, "mac"), "content-length": "4096" });
    expect([stated.status, stated.body.code]).toEqual([413, "BUNDLE_TOO_LARGE"]);
    const unstated = await putUnread(url, bundle.path, auth(at, "mac"));
    expect([unstated.status, unstated.body.code]).toEqual([411, "LENGTH_REQUIRED"]);
    expect(leftovers(at)).toEqual([]);
    expect(sealedNames(at, MACHINE)).toEqual([]);
    report.length_required = unstated;
  });

  it("answers 404 for an unknown endpoint and 401 for any request without a live pass; a reader's exchange is refused", async () => {
    const at = home();
    const { url } = await serve(at);
    expect(await get(url, "/v1/nothing", auth(at, "mac"))).toEqual({ status: 404, body: { message: "unknown endpoint" } });
    expect(await get(url, "/v1/state", auth(at, "mac"))).toEqual({ status: 404, body: { message: "unknown endpoint" } });
    expect(await exchange(url, {})).toMatchObject({ status: 401, body: { code: "PRINCIPAL_UNKNOWN" } });
    expect(await get(url, "/v1/nothing")).toMatchObject({ status: 401 });
    expect(await exchange(url, auth(at, "reader"))).toMatchObject({ status: 403, body: { code: "PRINCIPAL_SCOPE" } });
  });

  it("seals a phone bundle under its bundle id, one seal per source it carries; a repeat is 200; the door's refusals of a bundle whole keep their order and codes", async () => {
    const at = home();
    const { url } = await serve(at);
    const bundle = phoneBundle({ domains: { "location.jsonl": [1, 2, 3], "motion.jsonl": [1], "health.jsonl": [] }, custody: { [LOCATION]: { seal: 1 }, [MOTION]: { seal: 1 } } });
    const accepted = await put(url, `/v1/bundles/${bundle.id}`, auth(at, "phone"), bundle.bytes);
    expect(accepted).toMatchObject({ status: 201, retry: null, body: { pass: at.ids.phone, unit: PHONE_UNIT, calls: [],
      sources: { [LOCATION]: { received: 1, imported: 0, formats: FORMATS.phone }, [MOTION]: { received: 1, imported: 0 }, [PHOTOS]: { received: 0, imported: 0 } } } });
    expect(Object.keys(accepted.body.sources as object)).toEqual([PHOTOS, LOCATION, MOTION]);
    const directory = join(at.root, "inbox", PHONE_SOURCE, bundle.id);
    expect(existsSync(join(directory, "bundle.zip"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ source_id: PHONE_SOURCE, feeder: "ios-bundle", fetched_at: expect.stringMatching(/^2026-09-08T04:00:00\.\d{3}Z$/u),
      pass: at.ids.phone, custody: { [LOCATION]: { seal: 1 }, [MOTION]: { seal: 1 } } });
    expect(manifest.files.map((file: { file: string }) => file.file)).toEqual(["bundle/manifest.json", "bundle/health.jsonl", "bundle/location.jsonl", "bundle/motion.jsonl"]);
    for (const file of manifest.files as { file: string; sha256: string; bytes: number }[]) {
      const bytes = readFileSync(join(directory, file.file));
      expect([sha256(bytes), bytes.length]).toEqual([file.sha256, file.bytes]);
    }
    expect(manifest.sealed_at).toBe(manifest.fetched_at);
    expect(manifest.facts).toEqual({
      history: true, bundle_id: bundle.id, created_at: "2026-08-31T10:00:01+05:30", install_id: "00000000-0000-0000-0000-000000000001",
      time_range_covered: { start: "2026-08-31T09:59:00+05:30", end: "2026-08-31T10:01:00+05:30" },
      domains: { "location.jsonl": { observations: 3, first_sequence: 1, last_sequence: 3 }, "motion.jsonl": { observations: 1, first_sequence: 1, last_sequence: 1 },
        "health.jsonl": { observations: 0 } },
      blobs_carried: 0, blobs_referenced: 0,
    });
    expect(custodyOf((await putUnread(url, `/v1/bundles/${bundle.id}`, auth(at, "phone"))).body)).toEqual({ [PHOTOS]: [0, 0], [LOCATION]: [1, 0], [MOTION]: [1, 0] });
    const next = phoneBundle({ domains: { "location.jsonl": [4] }, custody: { [LOCATION]: { seal: 2 } } });
    const codes = {
      id: await put(url, `/v1/bundles/sha256:${"f".repeat(64)}`, auth(at, "phone"), next.bytes),
      integrity: await (async () => { const bad = phoneBundle({ domains: { "location.jsonl": [4] }, declaredHash: `sha256:${"f".repeat(64)}`, custody: { [LOCATION]: { seal: 2 } } });
        return put(url, `/v1/bundles/${bad.id}`, auth(at, "phone"), bad.bytes); })(),
      zip: await put(url, `/v1/bundles/${next.id}`, auth(at, "phone"), Buffer.from("not a zip")),
      custody: await (async () => { const bad = phoneBundle({ domains: { "location.jsonl": [4] }, custody: { [LOCATION]: { seal: "two" } } as never });
        return put(url, `/v1/bundles/${bad.id}`, auth(at, "phone"), bad.bytes); })(),
      none: await (async () => { const bad = phoneBundle({ domains: { "location.jsonl": [4] } });
        return put(url, `/v1/bundles/${bad.id}`, auth(at, "phone"), bad.bytes); })(),
      not_its: await (async () => { const bad = phoneBundle({ domains: { "location.jsonl": [4] }, custody: { [`location:local:${MAC}`]: { seal: 1 } } });
        return put(url, `/v1/bundles/${bad.id}`, auth(at, "phone"), bad.bytes); })(),
      placed: await (async () => { const bad = phoneBundle({ entries: { "location.jsonl": [4, 7].map((sequence) => ({ domain: "location", kind: "synthetic", sequence })) },
        custody: { [LOCATION]: { seal: 2 } } });
        return put(url, `/v1/bundles/${bad.id}`, auth(at, "phone"), bad.bytes); })(),
    };
    expect(Object.fromEntries(Object.entries(codes).map(([name, answer]) => [name, [answer.status, answer.body.code]]))).toEqual({
      id: [422, "IOS_BUNDLE_ID_MISMATCH"], integrity: [422, "IOS_BUNDLE_INTEGRITY_MISMATCH"], zip: [422, "IOS_BUNDLE_BAD_ZIP"],
      custody: [422, "IOS_BUNDLE_BAD_MANIFEST"], none: [422, "CUSTODY_MISSING"], not_its: [403, "PRINCIPAL_SCOPE"], placed: [422, "IOS_BUNDLE_BAD_ENTRY"],
    });
    expect(codes.placed.body.message).toBe("location.jsonl line 2 has sequence 7; its place states 5");
    expect(sealedNames(at, PHONE_SOURCE)).toEqual([bundle.id]);
    expect(leftovers(at)).toEqual([]);
    report.phone_seal = { answer: accepted.body, manifest, refusals: Object.fromEntries(Object.entries(codes).map(([n, a]) => [n, a.body.code])) };
  });

  it("stores the blobs a phone bundle carries and refuses one that names a blob the store lacks or holds as no file", async () => {
    const at = home();
    const { url } = await serve(at);
    const blob = Buffer.from("synthetic photo bytes"), hash = `sha256:${sha256(blob)}`;
    let seal = 1;
    const ship = (sequence: number, carried: boolean) => {
      const bundle = phoneBundle({ domains: { "photos.jsonl": [sequence] }, names: { [sequence]: hash }, ...(carried ? { blobs: [blob] } : {}), second: sequence,
        custody: { [PHOTOS]: { seal } } });
      return put(url, `/v1/bundles/${bundle.id}`, auth(at, "phone"), bundle.bytes).then((answer) => { if (answer.status === 201) seal++; return answer; });
    };
    expect(await ship(1, false)).toMatchObject({ status: 422, body: { code: "IOS_BUNDLE_BLOB_MISSING", message: expect.stringContaining(hash) } });
    const carried = await ship(1, true);
    expect(carried.status).toBe(201);
    const store = join(at.root, "inbox", PHONE_SOURCE, "blobs", sha256(blob));
    expect(readFileSync(store)).toEqual(blob);
    expect((await ship(2, false)).status).toBe(201);
    rmSync(store); mkdirSync(store);
    expect(await ship(3, false)).toMatchObject({ status: 422, body: { code: "IOS_BUNDLE_BLOB_MISMATCH" } });
    expect(custodyOf((await exchange(url, auth(at, "phone"))).body)[PHOTOS]).toEqual([2, 0]);
  });

  it("refuses a bundle naming a blob the sweep moved from the lane to the home's blobs/", async () => {
    const at = home();
    const { url } = await serve(at);
    const blob = Buffer.from("synthetic photo bytes, swept"), hash = `sha256:${sha256(blob)}`;
    const ship = (sequence: number, carried: boolean) => {
      const bundle = phoneBundle({ domains: { "photos.jsonl": [sequence] }, names: { [sequence]: hash }, ...(carried ? { blobs: [blob] } : {}), second: sequence,
        custody: { [PHOTOS]: { seal: sequence } } });
      return put(url, `/v1/bundles/${bundle.id}`, auth(at, "phone"), bundle.bytes);
    };
    expect((await ship(1, true)).status).toBe(201);
    openHomeFolder(at.root).blobs(join(at.root, "blobs")).put(blob);
    rmSync(join(at.root, "inbox", PHONE_SOURCE, "blobs", sha256(blob)));
    expect((await ship(2, false)).status).toBe(201);
  });

  it("takes one of two bundles that state the same seal at once: the other is 409 STALE with the answer, and seals nothing", async () => {
    const at = home();
    const { url } = await serve(at);
    const a = phoneBundle({ domains: { "location.jsonl": [1] }, custody: { [LOCATION]: { seal: 1 } } });
    const b = phoneBundle({ domains: { "location.jsonl": [1, 2] }, custody: { [LOCATION]: { seal: 1 } } });
    const answers = await Promise.all([a, b].map((bundle) => put(url, `/v1/bundles/${bundle.id}`, auth(at, "phone"), bundle.bytes)));
    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 409]);
    const stale = answers.find((answer) => answer.status === 409)!;
    expect(stale.body).toMatchObject({ code: "STALE", message: expect.stringContaining(`${LOCATION} states seal 1; the home has received 1`) });
    expect(custodyOf(stale.body.answer as Record<string, unknown>)[LOCATION]).toEqual([1, 0]);
    expect(sealedNames(at, PHONE_SOURCE)).toHaveLength(1);
    report.stale_race = stale.body;
  });

  it("reads a deflated member as well as a stored one, and removes a stale partial a stopped door left", async () => {
    const at = home();
    mkdirSync(join(at.root, "door", "uploads"), { recursive: true });
    writeFileSync(join(at.root, "door", "uploads", "stale.zip.partial"), "interrupted upload");
    const { url } = await serve(at);
    expect(leftovers(at)).toEqual([]);
    const bundle = mac(0, { deflate: new Set(["0000.jsonl", "manifest.json"]) });
    expect((await put(url, bundle.path, auth(at, "mac"), bundle.bytes)).status).toBe(201);
    expect(readFileSync(join(at.root, "inbox", MACHINE, basic(NOW_MS), "0000.jsonl"), "utf8")).toBe('{"synthetic":0}\n');
  });

  it("takes the Mac app's own bundle bytes as its Swift code wrote them: ZIP64 local headers, three blobs", async () => {
    const source = "screen:local:synthetic-mac-0001";
    const at = homeWith({ recorder: { scopes: ["read", "deliver"], sources: [source] } });
    const { url } = await serve(at, {}, () => Date.parse("2026-09-24T17:31:00Z"));
    const bytes = readFileSync(join(REPO, "packages", "connect", "macos-app", "screen", "test", "recorder-bundle.zip"));
    const answer = await put(url, `/v1/acquisitions/${encodeURIComponent(source)}/20260924T173000.250Z`, auth(at, "recorder"), bytes);
    const stated = JSON.parse(readFileSync(join(at.root, "inbox", source, "20260924T173000.250Z", "manifest.json"), "utf8")) as { custody?: Record<string, { seal: number }> };
    expect(answer).toMatchObject({ status: 201, retry: null, body: { pass: at.ids.recorder, sources: { [source]: { received: stated.custody?.[source]?.seal ?? 0, imported: 0 } }, needs: [] } });
    const tree = inboxTree(at.root);
    expect(Object.keys(tree).sort()).toEqual([
      `${source}/20260924T173000.250Z/manifest.json`, `${source}/20260924T173000.250Z/observations.jsonl`,
      ...["4768bc29f52228dbe9fdee4a93e3c0ea1f8c5482a0574cd04165e4f7a5821d73", "94d601a8a041c1a09cae879ff7e92f8bba9a2015839b45de9861f293be7d47d7",
        "d5e830e8f1d4f23e0c8103b2769fb62a45e0f6ae60bc5ded4ac98e8d6d972cf2"].map((hex) => `${source}/blobs/${hex}`),
    ].sort());
    expect(readDelivery(openHomeFolder(at.root), source, "20260924T173000.250Z")).toMatchObject({ stated_ms: Date.parse("2026-09-24T17:30:00.250Z"),
      files: [{ path: "observations.jsonl", size: 7021 }] });
    report.mac_app_bundle = tree;
  });

  it("logs one line per request naming the pass, never the pass itself, a hash by its first eight digits", async () => {
    const at = home();
    const { url, logs } = await serve(at);
    const bundle = phoneBundle({ domains: { "location.jsonl": [1] }, custody: { [LOCATION]: { seal: 1 } } });
    await put(url, `/v1/bundles/${bundle.id}`, auth(at, "phone"), bundle.bytes);
    await exchange(url, auth(at, "phone"));
    await exchange(url, {});
    const wrong = `${"synthetic-token-wrong".padEnd(43, "x")}`;
    await exchange(url, { authorization: `Bearer ${wrong}` });
    const lines = logs.map((line) => JSON.parse(line)).filter((line) => line.method !== undefined);
    expect(lines.map((line) => [line.principal, line.status])).toEqual([[at.ids.phone, 201], [at.ids.phone, 200], ["-", 401], ["-", 401]]);
    expect(lines.slice(2).map((line) => line.token)).toEqual(["none", createHash("sha256").update(wrong).digest("hex").slice(0, 8)]);
    expect(tokenTag(`Bearer ${wrong}`)).toBe(lines[3].token);
    expect(lines.every((line) => Object.keys(line)[0] === "at")).toBe(true);
    expect(lines[0]).toMatchObject({ bytes: bundle.bytes.length, path: `/v1/bundles/sha256:${bundle.id.slice(7, 15)}` });
    const text = logs.join("\n");
    expect(text).not.toContain(at.tokens.phone);
    expect(text).not.toContain(bundle.id.slice(7));
  });
});

describe("an upload the disk has no room for, taken", () => {
  it("refuses a later upload, a kind none stated, on a low disk before reading a byte, takes a new one, and refuses both on a full one; an exchange is still answered", async () => {
    const at = home();
    const free = freeSpace(4e9);
    const { url } = await serve(at);
    const bundle = mac(0);
    const later = await putUnread(url, bundle.path, { ...auth(at, "mac"), ...sized(bundle.bytes), "lifestream-kind": "later" });
    const none = await putUnread(url, bundle.path, { ...auth(at, "mac"), ...sized(bundle.bytes) });
    expect([later.status, later.retry, later.body.code, none.status, none.body.code]).toEqual([503, "300", "DISK_LOW", 503, "DISK_LOW"]);
    expect(leftovers(at)).toEqual([]);
    expect((await exchange(url, auth(at, "mac"))).status).toBe(200);
    expect((await put(url, bundle.path, { ...auth(at, "mac"), "lifestream-kind": "new" }, bundle.bytes)).status).toBe(201);
    free.set(BOTTOM_BYTES - 1);
    const next = mac(1);
    const full = await putUnread(url, next.path, { ...auth(at, "mac"), ...sized(next.bytes), "lifestream-kind": "new" });
    expect([full.status, full.body.code]).toEqual([503, "DISK_LOW"]);
    expect(sealedNames(at, MACHINE)).toHaveLength(1);
    report.disk_low = { later, none, full };
  });

  it("counts a body as what lands once its ZIP is listed: a small body whose members unpack large is refused before a member is written; a stored one is taken with room for its length twice", async () => {
    const at = home();
    const packed = mac(0, { files: [["0000.jsonl", Buffer.alloc(4 * 1024 * 1024, 0x20)]], deflate: new Set(["0000.jsonl"]) });
    const free = freeSpace(KEEP_BYTES + 2 * packed.bytes.length);
    const { url } = await serve(at);
    const refused = await put(url, packed.path, { ...auth(at, "mac"), ...sized(packed.bytes) }, packed.bytes);
    expect([refused.status, refused.retry, refused.body.code]).toEqual([503, "300", "DISK_LOW"]);
    expect([existsSync(join(at.root, "inbox", MACHINE)), leftovers(at)]).toEqual([false, []]);
    const stored = mac(0);
    free.set(KEEP_BYTES + 2 * stored.bytes.length);
    expect((await put(url, stored.path, { ...auth(at, "mac"), ...sized(stored.bytes) }, stored.bytes)).status).toBe(201);
    expect(sealedNames(at, MACHINE)).toEqual([basic(NOW_MS)]);
    report.unpacks_large = refused.body;
  });

  it("counts each of two bodies landing at once once: the second's listed members take the place of its length twice, never beside it", async () => {
    const at = home();
    const first = mac(0);
    const MEMBERS = 256 * 1024;
    const second = acquisitionBundle({ source: CALLS, fetched_ms: NOW_MS, files: [["calls.jsonl", Buffer.alloc(MEMBERS, 0x20)]], deflate: new Set(["calls.jsonl"]), custody: { [CALLS]: { seal: 1 } } });
    freeSpace(KEEP_BYTES + 2 * first.bytes.length + MEMBERS);
    const { url } = await serve(at);
    const slow = held(first.bytes);
    const landing = put(url, first.path, { ...auth(at, "mac"), ...sized(first.bytes) }, slow.body);
    await until("the first upload's partial", () => leftovers(at).length > 0);
    const beside = await put(url, second.path, { ...auth(at, "mac"), ...sized(second.bytes) }, second.bytes);
    expect([beside.status, beside.body.code]).toEqual([201, undefined]);
    slow.release();
    expect((await landing).status).toBe(201);
    expect([sealedNames(at, MACHINE).length, sealedNames(at, CALLS).length]).toEqual([1, 1]);
    report.two_counted_once = beside.body;
  });

  it("counts a body twice, and the bodies admitted and not yet sealed as taken: of two uploads at once the disk holds one, the other is refused before a byte", async () => {
    const at = home();
    const [first, second] = [mac(0), mac(1)];
    freeSpace(KEEP_BYTES + 2 * first.bytes.length + first.bytes.length);
    const { url } = await serve(at);
    const slow = held(first.bytes);
    const landing = put(url, first.path, { ...auth(at, "mac"), ...sized(first.bytes) }, slow.body);
    await until("the first upload's partial", () => leftovers(at).length > 0);
    const refused = await putUnread(url, second.path, { ...auth(at, "mac"), ...sized(second.bytes) });
    expect([refused.status, refused.body.code]).toEqual([503, "DISK_LOW"]);
    slow.release();
    expect((await landing).status).toBe(201);
    expect((await put(url, second.path, auth(at, "mac"), second.bytes)).status).toBe(201);
    expect([leftovers(at), sealedNames(at, MACHINE).length]).toEqual([[], 2]);
    report.two_at_once = refused;
  });

  it("ends a body the disk filled under as it landed with DISK_LOW, answered on its connection while the rest of it is still to come, keeping nothing of it", async () => {
    const at = home();
    const free = freeSpace(6e9);
    const { url, logs } = await serve(at, {}, undefined, { recheckBytes: 10 });
    const bundle = mac(0);
    const sending = httpRequest(`${url}${bundle.path}`, { method: "PUT", headers: { ...auth(at, "mac"), ...sized(bundle.bytes) } });
    const answered = new Promise<{ status: number; retry: string | null; body: Record<string, unknown> }>((resolve, reject) => {
      sending.on("response", (response) => {
        let text = "";
        response.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, retry: (response.headers["retry-after"] as string | undefined) ?? null, body: JSON.parse(text) as Record<string, unknown> }));
      });
      sending.on("error", reject);
    });
    onTestFinished(() => { sending.destroy(); });
    sending.write(bundle.bytes.subarray(0, 10));
    await until("the upload's partial", () => leftovers(at).length > 0);
    free.set(4e9);
    sending.write(bundle.bytes.subarray(10, 20));
    const ended = await answered;
    expect(bundle.bytes.length).toBeGreaterThan(20);
    expect([ended.status, ended.retry, ended.body.code]).toEqual([503, "300", "DISK_LOW"]);
    expect(logs.map((line) => JSON.parse(line) as { status?: number; code?: string }).filter((line) => line.status !== undefined).map((line) => [line.status, line.code])).toEqual([[503, "DISK_LOW"]]);
    expect([leftovers(at), sealedNames(at, MACHINE)]).toEqual([[], []]);
    report.filled_while_landing = ended;
  });
});

function listing(count: number): Buffer {
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(45, 12);
  record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(BigInt(count), 24);
  record.writeBigUInt64LE(BigInt(count), 32);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.fill(0xff, 4, 20);
  return Buffer.concat([record, locator, end]);
}

describe("a bundle that lists more members than the door maps, taken", () => {
  it("refuses a Mac's bundle and a phone's that list more than the bound with 422 as they open, sealing nothing", async () => {
    const at = home();
    const { url } = await serve(at);
    const over = listing(BUNDLE_ENTRIES + 1);
    const answers = {
      mac: await put(url, mac(0).path, auth(at, "mac"), over),
      phone: await put(url, `/v1/bundles/sha256:${"a".repeat(64)}`, auth(at, "phone"), over),
    };
    expect(Object.fromEntries(Object.entries(answers).map(([name, answer]) => [name, [answer.status, answer.body.code]]))).toEqual({
      mac: [422, "ACQUISITION_MANIFEST"], phone: [422, "IOS_BUNDLE_BAD_ENTRY"],
    });
    expect(answers.mac.body.message).toBe(`the bundle lists ${BUNDLE_ENTRIES + 1} members; a bundle holds at most ${BUNDLE_ENTRIES}`);
    expect([sealedNames(at, MACHINE), sealedNames(at, PHONE_SOURCE), leftovers(at)]).toEqual([[], [], []]);
    report.entries_bound = answers;
  });

  it("refuses a Mac's bundle whose central directory breaks as its members are listed with 422, never 500", async () => {
    const at = home();
    const { url } = await serve(at);
    const broken = await put(url, mac(0).path, auth(at, "mac"), listing(5));
    expect([broken.status, broken.body.code]).toEqual([422, "ACQUISITION_MANIFEST"]);
    expect([sealedNames(at, MACHINE), leftovers(at)]).toEqual([[], []]);
    report.broken_listing = broken;
  });
});

describe("a bundle custody cannot take, taken", () => {
  it("refuses a device below its floor or naming none, a bundle stated past the clock, files with no custody or a custody that names none of their source, a bundle that holds nothing; a source turned off is gone", async () => {
    const at = home();
    const { url } = await serve(at);
    const bundle = mac(0);
    const answers = {
      no_header: await putUnread(url, bundle.path, { authorization: `Bearer ${at.tokens.mac}` }),
      old: await putUnread(url, bundle.path, { authorization: `Bearer ${at.tokens.mac}`, "lifestream-device": "mac/0.9.7" }),
      old_exchange: await exchange(url, { authorization: `Bearer ${at.tokens.mac}`, "lifestream-device": "mac/0.9" }),
      ahead: await (async () => { const ahead = mac(0, { fetched_ms: NOW_MS + 11 * 60_000 }); return put(url, ahead.path, auth(at, "mac"), ahead.bytes); })(),
      no_custody: await put(url, bundle.path, auth(at, "mac"), mac(0, { custody: undefined }).bytes),
      empty_custody: await put(url, bundle.path, auth(at, "mac"), mac(0, { custody: {} }).bytes),
      two_sources: await put(url, bundle.path, auth(at, "mac"), mac(0, { custody: { [MACHINE]: { seal: 1 }, [CALLS]: { seal: 1 } } }).bytes),
    };
    expect(Object.fromEntries(Object.entries(answers).map(([name, answer]) => [name, [answer.status, answer.body.code, answer.body.floor]]))).toEqual({
      no_header: [426, "DEVICE_TOO_OLD", "1.0"], old: [426, "DEVICE_TOO_OLD", "1.0"], old_exchange: [426, "DEVICE_TOO_OLD", "1.0"],
      ahead: [422, "CLOCK_AHEAD", undefined], no_custody: [422, "CUSTODY_MISSING", undefined], empty_custody: [422, "CUSTODY_MISSING", undefined],
      two_sources: [422, "CUSTODY_MISSING", undefined],
    });
    expect(answers.empty_custody.body.message).toBe(`the bundle carries data of ${MACHINE}, and its custody states no seal of it`);
    expect(sealedNames(at, MACHINE)).toEqual([]);
    const close = mac(0, { fetched_ms: NOW_MS + 9 * 60_000 });
    expect((await put(url, close.path, auth(at, "mac"), close.bytes)).status).toBe(201);
    const [sealing, stating] = [mac(1, { files: [] }), acquisitionBundle({ source: MACHINE, fetched_ms: NOW_MS + 60_000, files: [], facts: { read_through: new Date(NOW_MS + 60_000).toISOString() } })];
    const nothing = {
      sealed: await put(url, sealing.path, auth(at, "mac"), sealing.bytes),
      read_through: await put(url, stating.path, auth(at, "mac"), stating.bytes),
    };
    expect(Object.values(nothing).map((answer) => [answer.status, answer.body.code])).toEqual([[422, "ACQUISITION_MANIFEST"], [422, "ACQUISITION_MANIFEST"]]);
    expect(nothing.sealed.body.message).toMatch(/holds no file and no blob/u);
    expect(sealedNames(at, MACHINE)).toEqual([basic(NOW_MS + 9 * 60_000)]);
    expect(custodyOf((await exchange(url, auth(at, "mac"))).body)[MACHINE]).toEqual([1, 0]);
    editSettings(at.root, { "sources.off": [CALLS] });
    expect(Object.keys((await exchange(url, auth(at, "mac"))).body.sources as object)).toEqual([MACHINE]);
    const off = acquisitionBundle({ source: CALLS, fetched_ms: NOW_MS, files: [["c.jsonl", Buffer.from("{}\n")]], custody: { [CALLS]: { seal: 1 } } });
    expect(await putUnread(url, off.path, auth(at, "mac"))).toMatchObject({ status: 403, body: { code: "PRINCIPAL_SCOPE", message: expect.stringContaining("turned off") } });
    report.custody_refusals = Object.fromEntries(Object.entries({ ...answers, ...nothing }).map(([name, answer]) => [name, answer.body]));
  });

  it("holds a Mac below the release's floor at the door, its exchange and its bundle, and serves one at it", async () => {
    const at = home();
    const floors = releaseFloors();
    const { url } = await serve(at, {}, undefined, { floors });
    const below = String(Number(floors.mac) - 1);
    const bundle = mac(0);
    const answers = {
      exchange: await exchange(url, { authorization: `Bearer ${at.tokens.mac}`, "lifestream-device": `mac/${below}` }),
      bundle: await putUnread(url, bundle.path, { authorization: `Bearer ${at.tokens.mac}`, "lifestream-device": `mac/${below}` }),
    };
    expect(Object.values(answers).map((answer) => [answer.status, answer.body.code, answer.body.floor])).toEqual([[426, "DEVICE_TOO_OLD", floors.mac], [426, "DEVICE_TOO_OLD", floors.mac]]);
    expect(sealedNames(at, MACHINE)).toEqual([]);
    const at_floor = { authorization: `Bearer ${at.tokens.mac}`, "lifestream-device": `mac/${floors.mac}` };
    expect((await exchange(url, at_floor)).status).toBe(200);
    expect((await put(url, bundle.path, at_floor, bundle.bytes)).status).toBe(201);
    report.mac_floor = { floor: floors.mac, refused: below };
  });
});

describe("a runner below the release's floor", () => {
  it("is refused 426, listed under below until it exchanges at the floor, and the home's next read keeps its last files with Update this runner", async () => {
    const UNIT = "runner-macbook-pro-0001";
    const at = homeWith({ runner: { scopes: ["run"], kind: "runner", unit: UNIT }, driver: { scopes: ["drive"] }, reader: { scopes: ["read"] } });
    makeHomeDb(join(at.root, "home.db")).close();
    const floors = releaseFloors();
    const { url } = await serve(at, {}, undefined, { floors });
    const older = String(Number(floors.runner) - 1);
    const file = {
      id: "qwen3.5-4b", name: "Qwen 3.5", input: ["text", "image"], output: "text", tools: false, context_tokens: 4_000, thinking: [], bytes: 1_000, languages: [], memory_gb: 16,
      state: "ready", fetched_bytes: 1_000, failure: null,
    };
    const exchange = async (version: string, signal?: AbortSignal): Promise<{ status: number; code: unknown }> => {
      const response = await fetch(`${url}${RUNNER_EXCHANGE}`, {
        method: "POST", headers: { authorization: `Bearer ${at.tokens.runner}`, "lifestream-device": `runner/${version}`, "content-type": "application/json" },
        body: JSON.stringify({ runner: { name: "Synthetic Mac", version, boot: "boot-a", slots: 1, power: "mains", idle_s: null, thermal: null, memory_gb: 16, running: [], files: [file] }, results: [] }),
        ...(signal === undefined ? {} : { signal }),
      });
      const said = await response.text();
      return { status: response.status, code: response.status === 200 ? null : (JSON.parse(said) as { code: string }).code };
    };
    expect(await exchange(floors.runner)).toEqual({ status: 200, code: null });
    expect(await exchange(older)).toEqual({ status: 426, code: "DEVICE_TOO_OLD" });
    const listed = await listRunners(url, at.tokens.driver!);
    expect([listed.runners.map((each) => [each.unit, each.files.map((held) => held.id)]), listed.below]).toEqual([[[UNIT, ["qwen3.5-4b"]]], [{ unit: UNIT, version: older }]]);

    const models = new Models({
      settings: () => ({
        model: { cap: 4 }, defaults: { pictures: null, audio: null, text: null, chat: null, search: null, hiding: null }, connectors: {}, runners: {}, privacy: readPrivacySettings({}),
      }),
      registry: () => ({ connectors: [], families: [] }), ledger: { resting: () => new Map() },
      found: () => ({ programs: {}, door: url, held: () => false }),
      runners: () => listRunners(url, at.tokens.driver!), paired: () => new Set([UNIT]), clock: () => NOW_MS, day: () => ({ zone: "UTC", day_start_hour: 4 }),
      unset: () => [], fill: () => undefined,
    });
    await models.read();
    const db = openHome(openHomeFolder(at.root), "migrate");
    try {
      db.commit((tx) => void models.tick(tx));
    } finally {
      db.close();
    }
    const page = await get(url, "/v1/page/models", { authorization: `Bearer ${at.tokens.reader}` });
    const runners = (page.body.connections as { kind: string; id: string; line: string | null; files?: { id: string }[] }[]).filter((each) => each.kind === "runner");
    expect(runners.map((each) => [each.id, each.line, each.files!.map((held) => held.id)])).toEqual([[`runner:${UNIT}`, "Update this runner", ["qwen3.5-4b"]]]);

    const waiting = new AbortController();
    void exchange(floors.runner, waiting.signal).catch(() => undefined);
    await until("the runner exchanged at its floor again, and is below no more", async () => (await listRunners(url, at.tokens.driver!)).below.length === 0);
    waiting.abort();
    report.runner_floor = { floor: floors.runner, refused: older };
  });
});

describe("the Search by meaning default", () => {
  it("is read at each ask: changed in settings, the door's embedder asks the new runner file's vectors with no restart", async () => {
    const UNIT = "runner-macbook-pro-0001";
    const at = homeWith({ runner: { scopes: ["run"], kind: "runner", unit: UNIT }, reader: { scopes: ["read"] } });
    makeHomeDb(join(at.root, "home.db")).close();
    const floors = releaseFloors();
    const { url } = await serve(at, {}, undefined, { floors });
    const embedder = (id: string) => ({
      id, name: id, input: ["text"], output: "vectors", tools: false, context_tokens: 2_000, thinking: [], bytes: 1_000, languages: [], memory_gb: 2, state: "ready", fetched_bytes: 1_000, failure: null,
    });
    const exchange = async (): Promise<{ model: string }[]> => {
      const response = await fetch(`${url}${RUNNER_EXCHANGE}`, {
        method: "POST", headers: { authorization: `Bearer ${at.tokens.runner}`, "lifestream-device": `runner/${floors.runner}`, "content-type": "application/json" },
        body: JSON.stringify({ runner: { name: "Synthetic Mac", version: floors.runner, boot: "boot-a", slots: 1, power: "mains", idle_s: null, thermal: null, memory_gb: 16, running: [], files: [embedder("embed-a"), embedder("embed-b")] }, results: [] }),
      });
      return ((await response.json()) as { calls: { model: string }[] }).calls;
    };
    expect(await exchange()).toEqual([]);
    const asked = async (file: string): Promise<string[]> => {
      editSettings(at.root, { "model.defaults.search": `runner:${UNIT}/${file}` });
      const stop = new AbortController();
      const search = fetch(`${url}/v1/search?lists=screen&query=osprey`, { headers: { authorization: `Bearer ${at.tokens.reader}` }, signal: stop.signal }).catch(() => undefined);
      let calls: { model: string }[] = [];
      await until(`the door places the ask's embedding on ${file}`, async () => (calls = await exchange()).length > 0);
      stop.abort();
      await search;
      return calls.map((call) => call.model);
    };
    expect(await asked("embed-a")).toEqual(["embed-a"]);
    expect(await asked("embed-b")).toEqual(["embed-b"]);
  });
});

describe("an owner's statement sealed with a line its reader refuses", () => {
  it("one refused line among good ones is sealed, or answered other than 422 STATEMENTS_BAD naming that line", async () => {
    const places = "google-maps:person-a@example.com:lookup";
    const at = homeWith({ desk: { scopes: ["deliver"], sources: [places] } });
    editSettings(at.root, { unit: MAC });
    const { url } = await serve(at);
    const named = (id: string) => ({ kind: "place", key: `google:${id}`, content: { type: "google.place", id, name: "Synthetic Gym", centre: { latitude: 0, longitude: 0 } } });
    const lines = [JSON.stringify(named("synthetic-gym")), "{\"kind\":", JSON.stringify(named("synthetic-pond"))];
    const bundle = acquisitionBundle({
      source: places, feeder: "owner-statements", fetched_ms: NOW_MS - 60_000, files: [["statements.ndjson", Buffer.from(lines.map((line) => `${line}\n`).join(""))]],
      manifest: (manifest) => ({ ...manifest, facts: { statements: lines.length, blobs_carried: 0 } }),
    });
    const answer = await put(url, bundle.path, { authorization: `Bearer ${at.tokens.desk}` }, bundle.bytes);
    expect([answer.status, answer.body.code]).toEqual([422, "STATEMENTS_BAD"]);
    expect(answer.body.message).toMatch(/^statements\.ndjson line 2 is not one JSON object: /u);
    expect([sealedNames(at, places), leftovers(at)]).toEqual([[], []]);
    report.owner_line_refused = answer.body;
  });
});

describe("a delivery sealed without its manifest last", () => {
  it("a door killed after the files and before the manifest leaves no seal; the repeat seals once and whole", async () => {
    const at = home();
    const blob = Buffer.from("synthetic blob");
    const bundle = mac(0, { files: [["a.jsonl", Buffer.from("{}\n")], ["nested/b.jsonl", Buffer.from("[]\n")]], blobs: [blob] });
    const dying = await startDoor(at, { LIFESTREAM_FAILPOINT: "seal.manifest" });
    onTestFinished(async () => { await dying.stop(); });
    await expect(put(dying.url, bundle.path, auth(at, "mac"), bundle.bytes)).rejects.toThrow();
    expect(await dying.exited).toBe("SIGKILL");
    const directory = join(at.root, "inbox", MACHINE, basic(NOW_MS));
    const left = { files: readdirSync(directory, { recursive: true }).map(String).sort(), manifest: existsSync(join(directory, "manifest.json")) };
    expect(left).toEqual({ files: ["a.jsonl", "nested", "nested/b.jsonl"], manifest: false });
    expect(sealedNames(at, MACHINE)).toEqual([]);

    const door = await serve(at);
    const repeat = await put(door.url, bundle.path, auth(at, "mac"), bundle.bytes);
    expect([repeat.status, custodyOf(repeat.body)[MACHINE]]).toEqual([201, [1, 0]]);
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as { files: { file: string; sha256: string; bytes: number }[] };
    expect(manifest.files.map((file) => [file.file, sha256(readFileSync(join(directory, file.file))) === file.sha256])).toEqual([["a.jsonl", true], ["nested/b.jsonl", true]]);
    expect(leftovers(at)).toEqual([]);
    report.killed_before_manifest = { left_after_kill: left, after_repeat: inboxTree(at.root) };
  });

  it("a door killed after its seal, before its custody row and its answer: the next door counts the seal, the repeat answers 200, sealed once", async () => {
    const at = home();
    const bundle = phoneBundle({ domains: { "location.jsonl": [1, 2] }, custody: { [LOCATION]: { seal: 1 } } });
    const dying = await startDoor(at, { LIFESTREAM_FAILPOINT: "door.sealed" });
    onTestFinished(async () => { await dying.stop(); });
    await expect(put(dying.url, `/v1/bundles/${bundle.id}`, auth(at, "phone"), bundle.bytes)).rejects.toThrow();
    expect(await dying.exited).toBe("SIGKILL");
    expect(sealedNames(at, PHONE_SOURCE)).toEqual([bundle.id]);
    const cached = new Database(join(at.root, "door", "custody.db"), { readonly: true });
    expect(cached.prepare("SELECT count(*) FROM seals").pluck().get()).toBe(0);
    cached.close();
    const door = await serve(at);
    expect(custodyOf((await exchange(door.url, auth(at, "phone"))).body)[LOCATION]).toEqual([1, 0]);
    const repeat = await putUnread(door.url, `/v1/bundles/${bundle.id}`, auth(at, "phone"));
    expect([repeat.status, custodyOf(repeat.body)[LOCATION]]).toEqual([200, [1, 0]]);
    const next = phoneBundle({ domains: { "location.jsonl": [3] }, custody: { [LOCATION]: { seal: 2 } } });
    expect((await put(door.url, `/v1/bundles/${next.id}`, auth(at, "phone"), next.bytes)).status).toBe(201);
    expect(sealedNames(at, PHONE_SOURCE)).toEqual([bundle.id, next.id].sort());
    report.killed_after_seal = { answer: repeat.body };
  });
});

describe("a sealed delivery lost when the home is down", () => {
  it("three devices ship with no home process at all: every delivery is sealed, whole and in order", async () => {
    const at = homeWith({
      "mac-aa01": { kind: "mac", scopes: ["deliver"], sources: ["machine:local:macbook-pro-aa01"] },
      "mac-aa02": { kind: "mac", scopes: ["deliver"], sources: ["input:local:macbook-pro-aa02"] },
      "mac-aa03": { kind: "mac", scopes: ["deliver"], sources: ["audio:local:macbook-pro-aa03"] },
    });
    const per = 30;
    let tick = 0;
    const { url } = await serve(at, {}, () => NOW_MS + per * 300_000 + tick++);
    const devices = [["mac-aa01", "machine:local:macbook-pro-aa01"], ["mac-aa02", "input:local:macbook-pro-aa02"], ["mac-aa03", "audio:local:macbook-pro-aa03"]] as const;
    const shipped = devices.map(([, source]) => Array.from({ length: per }, (_, n) => acquisitionBundle({
      source, fetched_ms: NOW_MS + n * 300_000, files: [[`${n}.jsonl`, Buffer.from(`{"device":"${source}","n":${n}}\n`)]], custody: { [source]: { seal: n + 1 } },
    })));
    const statuses = await Promise.all(devices.map(async ([who], index) => {
      const answers: number[] = [];
      for (const bundle of shipped[index]!) answers.push((await put(url, bundle.path, { authorization: `Bearer ${at.tokens[who]}`, ...DEVICE.mac }, bundle.bytes)).status);
      return answers;
    }));
    expect(statuses.flat().filter((status) => status !== 201)).toEqual([]);
    expect(existsSync(join(at.root, "home.db"))).toBe(false);
    const inbox = join(at.root, "inbox");
    const held = devices.map(([, source]) => sealedNames(at, source).map((name) => readDelivery(openHomeFolder(dirname(inbox)), source, name)!));
    devices.forEach(([, source], index) => {
      expect(held[index]!.map((delivery) => delivery.id)).toEqual(shipped[index]!.map((bundle) => bundle.id));
      expect(held[index]!.map((delivery) => delivery.custody[source]!.seal)).toEqual(shipped[index]!.map((_, n) => n + 1));
      expect(held[index]!.every((delivery, n) => n === 0 || delivery.stamped_ms! > held[index]![n - 1]!.stamped_ms!)).toBe(true);
      for (const delivery of held[index]!) {
        const file = delivery.files[0]!;
        expect(`sha256:${sha256(readFileSync(join(inbox, delivery.id, file.path)))}`).toBe(file.blob);
      }
    });
    report.home_down = { devices: devices.length, per_device: per, sealed: held.map((list) => list.length), first: held[0]![0]!.id, last: held[0]!.at(-1)!.id };
  });

  it("nudges a listening home once per seal with one JSON line naming the delivery, answered at once, and a home that is not listening costs nothing", async () => {
    const at = home();
    const { url } = await serve(at);
    const first = mac(0);
    expect((await put(url, first.path, auth(at, "mac"), first.bytes)).status).toBe(201);
    const fake = await fakeHome(testSocket(at.root).path, () => "result");
    try {
      const second = mac(1), third = phoneBundle({ domains: { "location.jsonl": [1] }, custody: { [LOCATION]: { seal: 1 } } });
      expect((await put(url, second.path, auth(at, "mac"), second.bytes)).status).toBe(201);
      expect((await put(url, `/v1/bundles/${third.id}`, auth(at, "phone"), third.bytes)).status).toBe(201);
      await until("both nudges answered", () => fake.answered >= 2);
      expect(fake.asked).toEqual([
        { verb: "sealed", delivery: second.id, folder: at.root }, { verb: "sealed", delivery: `${PHONE_SOURCE}/${third.id}`, folder: at.root },
      ]);
    } finally { await fake.close(); }
    report.nudges = fake.asked;
  });
});

describe("the models read", () => {
  it("answers from what the home holds while the home's models-list answer is held back, and the home receives the notice", async () => {
    const at = home();
    makeHomeDb(join(at.root, "home.db")).close();
    const { url } = await serve(at);
    const fake = await fakeHome(testSocket(at.root).path, (request) => (request.verb === "models-list" ? "hold" : "result"));
    try {
      const read = await get(url, "/v1/models", auth(at, "reader"));
      expect([read.status, Object.keys(read.body).sort()]).toEqual([200, ["connections", "models", "position", "uses"]]);
      await until("the home received the notice", () => fake.asked.some((request) => request.verb === "models-list"));
      expect(fake.asked.filter((request) => request.verb === "models-list")).toEqual([{ verb: "models-list", folder: at.root }]);
    } finally { await fake.close(); }
  });

  it("the page answer of Settings › AI models answers from what is held while the notice is held back, and the home receives the notice", async () => {
    const at = home();
    makeHomeDb(join(at.root, "home.db")).close();
    const { url } = await serve(at);
    const fake = await fakeHome(testSocket(at.root).path, (request) => (request.verb === "models-list" ? "hold" : "result"));
    try {
      const page = await get(url, "/v1/page/models", auth(at, "reader"));
      expect([page.status, (page.body.uses as { use: string }[]).map((each) => each.use)]).toEqual([200, ["pictures", "audio", "text", "chat", "search", "hiding"]]);
      await until("the home received the notice", () => fake.asked.some((request) => request.verb === "models-list"));
      expect(fake.asked.filter((request) => request.verb === "models-list")).toEqual([{ verb: "models-list", folder: at.root }]);
    } finally { await fake.close(); }
  });
});

describe("the privacy read's detector", () => {
  it("names the chosen Hiding details model by its model id, the file apart; with none chosen the model is null and the detector off", async () => {
    const off = home();
    const read = async (at: Home) => (await get((await serve(at)).url, "/v1/privacy", auth(at, "reader"))).body.detector as Record<string, unknown>;
    expect(await read(off)).toMatchObject({ model: null, state: "off" });
    const chosen = home();
    const model = `runner:${UNIT_OF_MAC}/privacy-filter`;
    editSettings(chosen.root, { "model.defaults.hiding": model });
    const detector = await read(chosen);
    expect(detector).toMatchObject({ model, state: "absent" });
  });
});

async function fakeHome(path: string, answer: (request: JsonObject, n: number) => "result" | "error" | "close" | "hold"): Promise<{ asked: JsonObject[]; answered: number; open: number; close(): Promise<void> }> {
  const held = new Set<Socket>();
  const state = { asked: [] as JsonObject[], answered: 0 };
  const server = createSocketServer((connection) => {
    held.add(connection);
    connection.on("close", () => held.delete(connection));
    connection.on("error", () => undefined);
    let text = "";
    connection.on("data", (chunk) => {
      text += chunk.toString("utf8");
      const end = text.indexOf("\n");
      if (end < 0) return;
      const { sent_ms: _sent, ...request } = JSON.parse(text.slice(0, end)) as JsonObject;
      const what = answer(request, state.asked.length);
      state.asked.push(request);
      if (what === "result") {
        state.answered++;
        connection.end(`${JSON.stringify({ result: { indexed: 1 } })}\n`);
      } else if (what === "error") connection.end(`${JSON.stringify({ error: "a synthetic manifest that cannot be read" })}\n`);
      else if (what === "close") connection.destroy();
    });
  });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    get asked() { return state.asked; },
    get answered() { return state.answered; },
    get open() { return held.size; },
    close: () => new Promise<void>((resolve) => {
      for (const each of held) each.destroy();
      server.close(() => resolve());
    }),
  };
}

describe("a nudge the home did not answer, lost", () => {
  const keeper = (path: string, answerMs?: number) => {
    const logs: JsonObject[] = [];
    const kept = nudges({ path, folder: "/homes/a" }, (line) => logs.push(line), answerMs, 15);
    onTestFinished(() => kept.close());
    return { kept, logs };
  };
  const socketIn = () => {
    const dir = mkdtempSync(join(tmpdir(), "lifestream-nudges-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, "fake.sock");
  };

  it("a home that took the nudge and gave no answer is asked again until it answers; the tries are logged, the first and the answered", async () => {
    const path = socketIn();
    const fake = await fakeHome(path, (_, n) => (n === 0 ? "close" : "result"));
    onTestFinished(() => fake.close());
    const { kept, logs } = keeper(path);
    kept.owe("lane-a/one");
    await until("the nudge answered", () => fake.answered === 1);
    await until("nothing owed", () => kept.owing().length === 0);
    expect(fake.asked).toEqual([{ verb: "sealed", delivery: "lane-a/one", folder: "/homes/a" }, { verb: "sealed", delivery: "lane-a/one", folder: "/homes/a" }]);
    expect(logs).toEqual([
      { nudge: "failed", delivery: "lane-a/one", tries: 1, error: expect.any(String) },
      { nudge: "answered", delivery: "lane-a/one", tries: 2 },
    ]);
  });

  it("an error answer is no answer: kept and sent again, one line for the error and none for the tries that repeat it", async () => {
    const path = socketIn();
    const fake = await fakeHome(path, (_, n) => (n < 2 ? "error" : "result"));
    onTestFinished(() => fake.close());
    const { kept, logs } = keeper(path);
    kept.owe("lane-a/unreadable");
    await until("the third try answered", () => fake.answered === 1);
    await until("nothing owed", () => kept.owing().length === 0);
    expect(fake.asked).toHaveLength(3);
    expect(logs).toEqual([
      { nudge: "failed", delivery: "lane-a/unreadable", tries: 1, error: "a synthetic manifest that cannot be read" },
      { nudge: "answered", delivery: "lane-a/unreadable", tries: 3 },
    ]);
  });

  it("no socket at the path: no home runs, nothing is kept, and nothing logged", async () => {
    const { kept, logs } = keeper(socketIn());
    kept.owe("lane-a/down");
    expect(kept.owing()).toEqual(["lane-a/down"]);
    await until("nothing owed", () => kept.owing().length === 0);
    expect(logs).toEqual([]);
  });

  it("a try whose time ran out before it connected (the door's turn held past it) is no refusal: kept and logged, not dropped", async () => {
    const path = socketIn();
    const fake = await fakeHome(path, () => "result");
    onTestFinished(() => fake.close());
    const { kept, logs } = keeper(path, 60_000);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      kept.owe("lane-a/held-turn");
      vi.runOnlyPendingTimers();
    } finally {
      vi.useRealTimers();
    }
    await until("the try's failure logged", () => logs.length === 1);
    expect([logs[0], kept.owing(), fake.asked]).toEqual([{ nudge: "failed", delivery: "lane-a/held-turn", tries: 1, error: expect.stringMatching(/did not answer/u) }, ["lane-a/held-turn"], []]);
  });

  it("a connection refused at a path that holds no listening home is no proof none runs: kept, logged, and answered once a home serves there", async () => {
    const path = socketIn();
    writeFileSync(path, "");
    const { kept, logs } = keeper(path);
    kept.owe("lane-a/refused");
    await until("the refused try logged", () => logs.length === 1);
    expect([logs[0], kept.owing()]).toEqual([{ nudge: "failed", delivery: "lane-a/refused", tries: 1, error: expect.any(String) }, ["lane-a/refused"]]);
    rmSync(path);
    const fake = await fakeHome(path, () => "result");
    onTestFinished(() => fake.close());
    await until("the nudge answered once a home serves", () => kept.owing().length === 0);
    expect([fake.asked.map((request) => request.delivery), logs.at(-1)]).toEqual([["lane-a/refused"], { nudge: "answered", delivery: "lane-a/refused", tries: expect.any(Number) }]);
  });

  it(`${NUDGES_OWED} nudges owed are kept; one more drops them all, closing their connections, and owes one whole look, itself sent again until answered; a close keeps nothing and closes what it held`, async () => {
    const path = socketIn();
    let looks = 0;
    const fake = await fakeHome(path, (request) => (request.delivery !== undefined ? "hold" : looks++ === 0 ? "close" : "result"));
    onTestFinished(() => fake.close());
    const { kept, logs } = keeper(path, 10 * 60_000);
    const ids = Array.from({ length: NUDGES_OWED }, (_, n) => `lane-a/${String(n).padStart(3, "0")}`);
    for (const id of ids) kept.owe(id);
    expect(kept.owing()).toEqual(ids);
    await until("every nudge held by the home", () => fake.asked.length === NUDGES_OWED && fake.open === NUDGES_OWED);
    kept.owe("lane-a/one-more");
    expect(kept.owing()).toEqual([null]);
    await until("the whole look answered", () => fake.answered === 1);
    await until("nothing owed", () => kept.owing().length === 0);
    await until("the dropped nudges' connections closed by the keeper", () => fake.open === 0);
    expect(logs.filter((line) => line.delivery === null)).toEqual([
      { nudge: "failed", delivery: null, tries: 1, error: expect.any(String) },
      { nudge: "answered", delivery: null, tries: 2 },
    ]);
    kept.owe("lane-a/at-close");
    await until("the nudge held by the home", () => fake.open === 1);
    kept.close();
    expect(kept.owing()).toEqual([]);
    await until("the held connection closed by the keeper's close", () => fake.open === 0);
    kept.owe("lane-a/after-close");
    expect(kept.owing()).toEqual([]);
  });

  it("the harness's ship and shipFiles nudge through a keeper of the root's, as the door does, which the root's end closes", async () => {
    const root = mkdtempSync(join(tmpdir(), "lifestream-ship-"));
    const fake = await fakeHome(testSocket(root).path, (_, n) => (n === 0 ? "close" : "result"));
    onTestFinished(() => fake.close());
    const source = "apple-notes:local:macbook-pro-0001";
    const shipped = await ship(root, { source, fetched_ms: NOW_MS, rows: [] });
    await until("the first nudge answered at its second try", () => fake.answered === 1);
    const filed = await shipFiles(root, source, NOW_MS + 1_000, { "note.txt": Buffer.from("synthetic") });
    await until("the second answered", () => fake.answered === 2);
    expect(fake.asked.map((request) => request.delivery)).toEqual([shipped, shipped, filed]);
    expect(nudgeLog(root).map((line) => [line.nudge, line.tries])).toEqual([["failed", 1], ["answered", 2]]);
    removeRoot(root);
    expect([endNudges(root), nudgeLog(root)]).toEqual([false, []]);
  });
});

describe("imported answered past a seal the home has not imported", () => {
  it("imported is the end of the unbroken run: it stops at the first unimported seal when a later one imported first, passes one the person gave up, advances through every seal settled past a gap once it closes, counts a seal held by two rows once, and never passes received", async () => {
    const at = home();
    const db = openHome(openHomeFolder(at.root), "migrate");
    const { url } = await serve(at);
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) {
      const bundle = mac(n);
      expect((await put(url, bundle.path, auth(at, "mac"), bundle.bytes)).status).toBe(201);
      ids.push(bundle.id);
    }
    const add = (id: string, seal: number, pass = at.ids.mac!) => db.commit((tx) => {
      tx.tables.deliveries.add({ id, source: MACHINE, sealed_ms: NOW_MS + seal, stated_ms: NOW_MS, facts: {}, pass, seal });
    });
    const mark = (id: string, state: "imported" | "failed" | "dead") => db.commit((tx) => reach(tx, id, MACHINE, state));
    const kept: Record<string, boolean> = {};
    const run = async (step: string) => {
      kept[step] = readHome(at.root, (read) => JSON.stringify(custodyKept(read)) === JSON.stringify(custodyRun(read)));
      return custodyOf((await exchange(url, auth(at, "mac"))).body)[MACHINE];
    };
    const seen: Record<string, unknown> = { none: await run("none") };
    ids.forEach((id, index) => add(id, index + 1));
    mark(ids[0]!, "imported");
    mark(ids[1]!, "imported");
    seen.two = await run("two");
    mark(ids[4]!, "imported");
    seen.fifth_before_third = await run("fifth_before_third");
    add(`${MACHINE}/again-5`, 5);
    mark(ids[2]!, "failed");
    seen.third_failed = await run("third_failed");
    mark(ids[2]!, "dead");
    seen.third_given_up = await run("third_given_up");
    expect(() => db.commit((tx) => {
      tx.tables.deliveries.move(ids[3]!, MACHINE, { move: "pass" });
      throw new Error("synthetic: the commit fails after its mark");
    })).toThrow("synthetic");
    seen.mark_thrown = await run("mark_thrown");
    mark(ids[3]!, "imported");
    seen.gap_closed = await run("gap_closed");
    add(`${MACHINE}/again-2`, 2);
    mark(`${MACHINE}/again-2`, "imported");
    add(`${MACHINE}/other`, 6, "p-00000000");
    mark(`${MACHINE}/other`, "imported");
    seen.repeats = await run("repeats");
    for (const seal of [6, 7]) {
      add(`${MACHINE}/past-${seal}`, seal);
      mark(`${MACHINE}/past-${seal}`, "imported");
    }
    seen.past_received = await run("past_received");
    const leads = readHome(at.root, (read) => read.prepare("SELECT imported FROM custody WHERE pass = ? AND source = ?").pluck().get(at.ids.mac, MACHINE));
    db.close();
    expect(seen).toEqual({
      none: [5, 0], two: [5, 2], fifth_before_third: [5, 2], third_failed: [5, 2], third_given_up: [5, 3], mark_thrown: [5, 3], gap_closed: [5, 5], repeats: [5, 5],
      past_received: [5, 5],
    });
    expect([leads, Object.entries(kept).filter(([, same]) => !same).map(([step]) => step)]).toEqual([7, []]);
    report.imported_run = seen;
  });

  it("answers the one 503 while home.db cannot be read; the seal stands and the repeat answers 200", async () => {
    const at = home();
    const db = makeHomeDb(join(at.root, "home.db"));
    const { url } = await serve(at);
    db.exec("BEGIN EXCLUSIVE; INSERT INTO meta (key, value) VALUES ('held', 'by a maintenance')");
    const bundle = mac(0);
    const answer = await put(url, bundle.path, auth(at, "mac"), bundle.bytes);
    expect([answer.status, answer.retry, answer.body.code]).toEqual([503, "5", "NOT_NOW"]);
    expect(sealedNames(at, MACHINE)).toEqual([basic(NOW_MS)]);
    db.exec("ROLLBACK");
    const repeat = await putUnread(url, bundle.path, auth(at, "mac"));
    expect([repeat.status, custodyOf(repeat.body)[MACHINE]]).toEqual([200, [1, 0]]);
    db.close();
  });

});

describe("a device's deliveries imported out of the order the door took them", () => {
  it("two seals in one clock millisecond, and a seal after both clocks step back, import in the order sealed, statement times aside", async () => {
    const at = home();
    let now = NOW_MS;
    const { url } = await serve(at, {}, () => now);
    const bundles = [0, 1, -60].map((minutes, n) => acquisitionBundle({
      source: MACHINE, fetched_ms: NOW_MS + minutes * 60_000, files: [[`${n}.jsonl`, Buffer.from(`{"n":${n}}\n`)]], custody: { [MACHINE]: { seal: n + 1 } },
    }));
    for (const [n, bundle] of bundles.entries()) {
      if (n === 2) now = NOW_MS - 3_600_000;
      expect((await put(url, bundle.path, auth(at, "mac"), bundle.bytes)).status).toBe(201);
    }
    const sealed = bundles.map((bundle) => readDelivery(openHomeFolder(at.root), MACHINE, bundle.id.slice(MACHINE.length + 1))!);
    const db = openHome(openHomeFolder(at.root), "migrate");
    const imported: string[] = [];
    try {
      db.commit((tx) => {
        tx.tables.sources.add({ id: MACHINE, vendor: vendorOf(declarations(), MACHINE), connector: "machine-events", added_ms: NOW_MS });
        tx.tables.deliveries.add({ id: `${MACHINE}/hand`, source: MACHINE, sealed_ms: NOW_MS - 7_200_000, stated_ms: NOW_MS - 7_200_000, facts: {} });
        for (const delivery of sealed) {
          tx.tables.deliveries.add({ id: delivery.id, source: MACHINE, sealed_ms: delivery.stamped_ms!, stated_ms: delivery.stated_ms, facts: delivery.facts,
            pass: delivery.pass, seal: delivery.custody[MACHINE]!.seal });
        }
      });
      while (db.commit((tx) => {
        const next = tx.tables.deliveries.next(MACHINE);
        if (next === undefined) return false;
        imported.push(next.id);
        tx.tables.deliveries.move(next.id, next.source, { move: "pass" });
        return true;
      }));
    } finally { db.close(); }
    expect(imported).toEqual([`${MACHINE}/hand`, ...bundles.map((bundle) => bundle.id)]);
    report.sealing_order = sealed.map((delivery) => ({ id: delivery.id, stamped_ms: delivery.stamped_ms, stated_ms: delivery.stated_ms }));
  });
});

describe("a pass with the wrong scope accepted", () => {
  it("refuses every pass outside its scope, before reading a byte, leaving nothing", async () => {
    const at = homeWith({
      mac: { kind: "mac", scopes: ["deliver"], sources: [MACHINE] },
      phone: { kind: "phone", scopes: ["deliver"], sources: [PHONE_SOURCE], unit: PHONE_UNIT },
      reader: { scopes: ["read"] },
      revoked: { kind: "mac", scopes: ["deliver"], sources: [MACHINE] },
    });
    revokePrincipal(openHomeFolder(at.root), at.ids.revoked!, NOW_MS);
    const { url } = await serve(at);
    const bundle = mac(0);
    const phone = phoneBundle({ domains: { "location.jsonl": [1] } });
    const other = acquisitionBundle({ source: CALLS, fetched_ms: NOW_MS, files: [["c.jsonl", Buffer.from("{}\n")]] });
    const answers = {
      wrong_source: await putUnread(url, other.path, auth(at, "mac")),
      phone_on_acquisition: await putUnread(url, bundle.path, auth(at, "phone")),
      mac_on_phone: await putUnread(url, `/v1/bundles/${phone.id}`, auth(at, "mac")),
      mac_as_phone: await putUnread(url, bundle.path, { ...auth(at, "mac"), ...DEVICE.phone }),
      reader_delivers: await putUnread(url, bundle.path, auth(at, "reader")),
      revoked: await putUnread(url, bundle.path, { ...auth(at, "revoked"), ...DEVICE.mac }),
      unknown: await putUnread(url, bundle.path, { authorization: "Bearer wrong" }),
      malformed: await putUnread(url, bundle.path, { authorization: `Basic ${at.tokens.mac}` }),
      deliverer_reads: await (async () => { const response = await fetch(`${url}/v1/feed`, { headers: auth(at, "mac") });
        return { status: response.status, body: await response.json() as Record<string, unknown>, retry: null }; })(),
    };
    expect(Object.fromEntries(Object.entries(answers).map(([name, answer]) => [name, [answer.status, answer.body.code]]))).toEqual({
      wrong_source: [403, "PRINCIPAL_SCOPE"], phone_on_acquisition: [403, "PRINCIPAL_SCOPE"], mac_on_phone: [403, "PRINCIPAL_SCOPE"],
      mac_as_phone: [403, "PRINCIPAL_SCOPE"], reader_delivers: [403, "PRINCIPAL_SCOPE"], revoked: [401, "PRINCIPAL_UNKNOWN"],
      unknown: [401, "PRINCIPAL_UNKNOWN"], malformed: [401, "PRINCIPAL_UNKNOWN"], deliverer_reads: [403, "PRINCIPAL_SCOPE"],
    });
    expect(inboxTree(at.root)).toEqual({});
    expect(leftovers(at)).toEqual([]);
    const file = readPrincipals(openHomeFolder(at.root));
    expect(file.format).toBe(PRINCIPALS_FORMAT);
    expect(statSync(join(at.root, "config", "principals.json")).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(file)).not.toContain(at.tokens.mac);
    report.scopes = Object.fromEntries(Object.entries(answers).map(([name, answer]) => [name, answer.status]));
  });
});

async function follow(url: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const response = await fetch(`${url}/v1/feed`, { headers, signal: controller.signal });
  expect(response.status).toBe(200);
  const events: { id: string; event: string; data: Record<string, unknown> }[] = [];
  const reader = response.body!.getReader();
  let text = "";
  const done = (async () => {
    try {
      for (;;) {
        const { value, done: ended } = await reader.read();
        if (ended) return;
        text += Buffer.from(value).toString("utf8");
        for (let end = text.indexOf("\n\n"); end !== -1; end = text.indexOf("\n\n")) {
          const block = text.slice(0, end);
          text = text.slice(end + 2);
          const fields = Object.fromEntries(block.split("\n").filter((line) => !line.startsWith(":") && line.includes(": "))
            .map((line) => [line.slice(0, line.indexOf(": ")), line.slice(line.indexOf(": ") + 2)]));
          if (fields.data !== undefined) events.push({ id: fields.id ?? "", event: fields.event ?? "message", data: JSON.parse(fields.data) });
        }
      }
    } catch {}
  })();
  return {
    events,
    async until(count: number): Promise<typeof events> {
      await until(`${count} events of the feed`, () => events.length >= count);
      return [...events];
    },
    async close() { controller.abort(); await done; },
  };
}

describe("the feed missing or repeating an event across a reopen", () => {
  it("sends every event once across new rows, a file put in place and a reconnect; resets a reader whose event an older copy put back, a pruned table or an old position does not hold", async () => {
    const at = home();
    const path = join(at.root, "home.db");
    let db = makeHomeDb(path);
    let stamp = 0;
    const add = (target: Database.Database, count: number) => {
      const insert = target.prepare("INSERT INTO events (at_ms, kind, key, detail) VALUES (?, 'day', ?, ?)");
      for (let n = 0; n < count; n++) insert.run(NOW_MS + 1_000 * ++stamp, `2026-10-0${n % 9 + 1}`, JSON.stringify({ n }));
    };
    const id = (seq: number) => `${seq}:${db.prepare("SELECT at_ms FROM events WHERE seq = ?").pluck().get(seq) as number}`;
    const putInPlace = (change: (copy: Database.Database) => void) => {
      const copy = join(at.root, "home.db.next");
      db.exec(`VACUUM INTO '${copy}'`);
      db.close();
      const next = new Database(copy);
      change(next);
      next.close();
      for (const suffix of ["-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
      renameSync(copy, path);
      db = new Database(path);
    };
    add(db, 3);
    const { url } = await serve(at);
    const seqs = (events: { data: Record<string, unknown> }[]) => events.map((event) => event.data.seq);
    const ids = (events: { id: string; event: string }[]) => events.map((event) => `${event.event} ${event.id}`);

    const reader = await follow(url, { ...auth(at, "reader"), "last-event-id": "0:0" });
    expect(seqs(await reader.until(3))).toEqual([1, 2, 3]);
    expect(reader.events[0]).toEqual({ id: id(1), event: "message", data: { seq: 1, at_ms: NOW_MS + 1_000, kind: "day", key: "2026-10-01", detail: { n: 0 } } });
    add(db, 2);
    expect(seqs(await reader.until(5))).toEqual([1, 2, 3, 4, 5]);

    putInPlace((next) => add(next, 1));
    expect(seqs(await reader.until(6))).toEqual([1, 2, 3, 4, 5, 6]);
    add(db, 1);
    expect(seqs(await reader.until(7))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const last = reader.events.at(-1)!.id;
    add(db, 2);
    expect(seqs(await reader.until(9))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await reader.close();

    const again = await follow(url, { ...auth(at, "reader"), "last-event-id": last });
    expect(seqs(await again.until(2))).toEqual([8, 9]);
    const fresh = await follow(url, auth(at, "reader"));
    add(db, 1);
    expect(seqs(await fresh.until(1))).toEqual([10]);
    expect(seqs(await again.until(3))).toEqual([8, 9, 10]);
    const before = { seven: id(7), eight: id(8), nine: id(9), ten: id(10) };

    putInPlace((older) => {
      older.prepare("DELETE FROM events WHERE seq > 4").run();
      older.prepare("UPDATE sqlite_sequence SET seq = 4 WHERE name = 'events'").run();
    });
    const reset = { id: id(4), event: "reset", data: { seq: 4, at_ms: NOW_MS + 4_000 } };
    expect((await again.until(4)).at(-1)).toEqual(reset);
    expect((await fresh.until(2)).at(-1)).toEqual(reset);
    add(db, 2);
    expect(ids(await again.until(6))).toEqual([`message ${before.eight}`, `message ${before.nine}`, `message ${before.ten}`, `reset ${id(4)}`, `message ${id(5)}`, `message ${id(6)}`]);
    expect(ids(await fresh.until(4))).toEqual([`message ${before.ten}`, `reset ${id(4)}`, `message ${id(5)}`, `message ${id(6)}`]);
    await again.close();
    await fresh.close();

    add(db, 3);
    expect(id(7)).not.toBe(before.seven);
    const back = await follow(url, { ...auth(at, "reader"), "last-event-id": before.seven });
    expect(await back.until(1)).toEqual([{ id: id(9), event: "reset", data: { seq: 9, at_ms: Number(id(9).split(":")[1]) } }]);
    add(db, 1);
    expect(ids(await back.until(2))).toEqual([`reset ${id(9)}`, `message ${id(10)}`]);
    await back.close();

    db.prepare("DELETE FROM events WHERE seq < 4").run();
    for (const stated of [`1:${NOW_MS + 1_000}`, "7:3", "0:10"]) {
      const late = await follow(url, { ...auth(at, "reader"), "last-event-id": stated });
      expect(await late.until(1), stated).toEqual([{ id: id(10), event: "reset", data: { seq: 10, at_ms: Number(id(10).split(":")[1]) } }]);
      await late.close();
    }
    const bad = await fetch(`${url}/v1/feed?from=nonsense`, { headers: auth(at, "reader") });
    expect([bad.status, ((await bad.json()) as { code: string }).code]).toEqual([400, "FEED_POSITION"]);
    db.close();
    report.feed = { first: reader.events.map((event) => event.id), resumed: ids(again.events), back: ids(back.events) };
  });
});

describe("a reader thread that cannot start", () => {
  it("is started again only for an ask, which it fails, each end named in the door's log", async () => {
    const at = home();
    const loads = join(at.root, "loads");
    const registry = join(at.root, "broken-registry.mjs");
    writeFileSync(registry, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(loads)}, "x");\nexport default () => { throw new Error("the synthetic registry cannot load"); };\n`);
    const counted = () => existsSync(loads) ? readFileSync(loads, "utf8").length : 0;
    const logs: string[] = [];
    const door = await serveDoor(at.root, { port: 0, max_bundle_bytes: 1 << 30 },
      { lookMs: LOOK_MS, log: (line) => logs.push(line), clock: () => NOW_MS, floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" }, registry });
    onTestFinished(() => door.close());
    const url = `http://127.0.0.1:${door.port}`;
    const ended = () => logs.map((line) => JSON.parse(line) as { reader?: string; why?: string }).filter((line) => line.reader === "ended");
    expect(counted()).toBe(0);
    for (let ask = 0; ask < 2; ask++) expect((await get(url, "/v1/sources", auth(at, "reader"))).status).toBe(500);
    expect(await exchange(url, auth(at, "mac"))).toMatchObject({ status: 503, body: { code: "NOT_NOW" } });
    expect(counted()).toBe(3);
    await until("the three reader threads' ends logged", () => ended().length >= 3);
    expect(ended().length).toBe(3);
    for (const line of ended()) expect(line.why).toContain("the synthetic registry cannot load");
    report.reader_start = { loads: counted(), ended: ended() };
  });
});

async function heldReads(options: DoorOptions = {}, before?: (at: Home) => void) {
  const at = home();
  before?.(at);
  const source = "apple-notes:local:device-a";
  const keys = ["first", "second", "gone", "next"];
  makeHomeDb(join(at.root, "home.db")).close();
  const db = openHome(openHomeFolder(at.root), "write");
  onTestFinished(() => db.close());
  db.commit((tx) => {
    tx.tables.sources.add({ id: source, vendor: vendorOf(declarations(), source), connector: "fake-rows", added_ms: 0 });
    const run = tx.tables.runs.start({ kind: "import", subject: source, started_ms: NOW_MS });
    tx.records.land(run, { id: `${source}/seed`, source, stated_ms: NOW_MS }, keys.map((key) => ({ kind: "note", key, content: { text: key } })), { note: () => [] }, { has: () => true });
    tx.tables.runs.end(run, { ended_ms: NOW_MS, outcome: "ok" });
  });
  const registry = fileURLToPath(new URL("./test/held-registry.ts", import.meta.url));
  const seen = new Map<string, ServerResponse[]>();
  const see = (message: unknown) => {
    const { request, response } = message as { request: IncomingMessage; response: ServerResponse };
    seen.set(request.url!, [...seen.get(request.url!) ?? [], response]);
  };
  subscribe("http.server.request.start", see);
  onTestFinished(() => { unsubscribe("http.server.request.start", see); });
  const logs: string[] = [];
  const door = await serveDoor(at.root, { port: 0, max_bundle_bytes: 1 << 30 },
    { lookMs: LOOK_MS, registry, log: (line) => logs.push(line), clock: () => NOW_MS, floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" }, ...options });
  const release = (key: string) => writeFileSync(join(at.root, `${key}.release`), "");
  const fifo = (key: string) => join(at.root, `${key}.fifo`);
  const stuck = new Set<string>();
  const stick = (key: string) => {
    expect(spawnSync("mkfifo", [fifo(key)]).status).toBe(0);
    stuck.add(key);
  };
  const letGo = (key: string): boolean => {
    try {
      closeSync(openSync(fifo(key), constants.O_WRONLY | constants.O_NONBLOCK));
      stuck.delete(key);
      return true;
    } catch {
      return false;
    }
  };
  const unstick = (key: string) => until(`the step stuck on ${key} returned`, () => letGo(key));
  onTestFinished(async () => {
    for (const key of [...keys, "bundle", "connectors", "answer", "prepared"]) release(key);
    for (const key of stuck) letGo(key);
    await door.close();
  });
  const url = `http://127.0.0.1:${door.port}`;
  const ask = async (path: string, what: string) => {
    const before = seen.get(path)?.length ?? 0;
    const hanging = new AbortController();
    const answer = fetch(`${url}${path}`, { headers: auth(at, "reader"), signal: hanging.signal })
      .then(async (response) => ({ status: response.status, body: await response.json() as Record<string, unknown>, retry: response.headers.get("retry-after") }), () => null);
    await until(`the door took ${what}`, () => (seen.get(path)?.length ?? 0) > before);
    const response = seen.get(path)![before]!;
    return { answer, response, hangUp: async () => { hanging.abort(); await until(`${what}'s connection closed`, () => response.destroyed); } };
  };
  const read = (key: string, route: "record" | "records" = "record") => {
    const before = [...keys].sort().filter((each) => each < key).at(-1);
    return ask(route === "record" ? `/v1/record?source=${source}&kind=note&key=${key}&text=1`
      : `/v1/records?source=${source}&kind=note&limit=1&text=1${before === undefined ? "" : `&after=${Buffer.from(JSON.stringify(before)).toString("base64url")}`}`, key);
  };
  const started = () => existsSync(join(at.root, "started")) ? readFileSync(join(at.root, "started"), "utf8").split("\n").filter(Boolean) : [];
  const records = () => logs.map((line) => JSON.parse(line) as { path?: string; status?: number; reader?: string }).filter((line) => line.path === "/v1/record");
  const ended = () => logs.map((line) => JSON.parse(line) as { reader?: string; why?: string }).filter((line) => line.reader === "ended");
  const note = (key: string) => db.commit((tx) => {
    const run = tx.tables.runs.start({ kind: "import", subject: source, started_ms: NOW_MS });
    tx.records.land(run, { id: `${source}/${key}`, source, stated_ms: NOW_MS }, [{ kind: "note", key, content: { text: key } }], { note: () => [] }, { has: () => true });
    tx.tables.runs.end(run, { ended_ms: NOW_MS, outcome: "ok" });
  });
  return { at, db, url, door, logs, ask, read, release, stick, unstick, started, records, ended, note, source };
}

describe("a computed read held", () => {
  it("a connectors report being computed holds more than its own reader thread: status waits for it, or the door's own routes do", async () => {
    const reads = await heldReads();
    const connectors = get(reads.url, "/v1/connectors", auth(reads.at, "reader"));
    await until("the report holds a thread", () => reads.started().includes("connectors"));
    expect(await get(reads.url, "/v1/status", auth(reads.at, "reader"))).toMatchObject({ status: 200, body: { position: expect.any(String) } });
    expect((await exchange(reads.url, auth(reads.at, "mac"))).status).toBe(200);
    reads.release("connectors");
    expect(await connectors).toMatchObject({ status: 200, body: { connectors: expect.any(Array) } });
    report.read_held_connectors = { started: reads.started() };
  });
});

describe("a slow computed read", () => {
  type Slow = { path?: string; status?: number; rows?: number; slowest?: { sql: string; ms: number }; statements?: number; statements_ms?: number; queued_ms?: number };
  const lineOf = (logs: string[], path: string) => logs.map((each) => JSON.parse(each) as Slow).find((each) => each.path === path);

  it("logs no statement, or one with its parameters: its line names its slowest statement's text and time, and how many ran in what time", async () => {
    const reads = await heldReads({ slowMs: -1 });
    const source = "apple-notes:local:device-a";
    expect(await get(reads.url, `/v1/counts?source=${source}&kind=note`, auth(reads.at, "reader"))).toMatchObject({ status: 200, body: { counts: { note: 4 } } });
    await until("the counts read's line", () => lineOf(reads.logs, "/v1/counts") !== undefined);
    const line = lineOf(reads.logs, "/v1/counts")!;
    expect(line).toMatchObject({ rows: 0, slowest: { sql: expect.any(String), ms: expect.any(Number) }, statements: expect.any(Number), statements_ms: expect.any(Number), queued_ms: expect.any(Number) });
    expect(line.statements).toBeGreaterThan(0);
    expect(line.slowest!.sql).not.toContain(source);
    report.slow_read = line;
  });

  it("says its rows on every line, one not slow too, which names no statement", async () => {
    const reads = await heldReads({ slowMs: Number.MAX_SAFE_INTEGER });
    expect((await get(reads.url, "/v1/counts?source=apple-notes:local:device-a&kind=note", auth(reads.at, "reader"))).status).toBe(200);
    await until("the counts read's line", () => lineOf(reads.logs, "/v1/counts") !== undefined);
    const line = lineOf(reads.logs, "/v1/counts")!;
    expect(line.rows).toBe(0);
    expect(line.slowest).toBeUndefined();
  });

  it("loses its statements when it fails: a read whose route throws logs its 500 with them", async () => {
    const reads = await heldReads({ slowMs: -1 });
    writeFileSync(join(reads.at.root, "broken"), "");
    expect((await get(reads.url, "/v1/connectors", auth(reads.at, "reader"))).status).toBe(500);
    await until("the failed read's line", () => lineOf(reads.logs, "/v1/connectors") !== undefined);
    const line = lineOf(reads.logs, "/v1/connectors")!;
    expect(line).toMatchObject({ status: 500, rows: 0, slowest: { sql: expect.any(String), ms: expect.any(Number) }, statements: expect.any(Number) });
    expect(line.statements).toBeGreaterThan(0);
    report.slow_failed_read = line;
  });
});

describe("a computed read past its bound", () => {
  it("is cut after the phone has given it up, so the phone sends it again elsewhere while the first still runs", () => {
    const swift = readFileSync(join(REPO, "homelink", "Sources", "HomeLink", "HomeLink.swift"), "utf8");
    const silence = /public static let silence: TimeInterval = (\d+)\n/u.exec(swift);
    expect(silence).not.toBeNull();
    expect(READ_MS).toBeLessThan(Number(silence![1]) * 1_000);
  });

  it("holds its thread and its snapshot for good, answers nothing or anything but \"not now\" for a few minutes, or the next read waits behind it", async () => {
    let reach!: () => void;
    const reached = new Promise<void>((resolve) => { reach = resolve; });
    let bounds = 0;
    const reads = await heldReads({ readBound: (name) => (name === "/v1/record" && bounds++ === 0 ? reached : new Promise<void>(() => undefined)) });
    const held = await reads.read("first");
    await until("the read holds its thread", () => reads.started().includes("first"));
    const holding = reads.db.checkpoint("truncate");
    expect(holding.busy).toBe(1);
    reach();
    const answer = await held.answer;
    expect(answer).toMatchObject({ status: 503, retry: "300", body: { code: "NOT_NOW", message: "Lifestream took too long to read this: try again in a few minutes." } });
    const ended = reads.ended;
    await until("the thread past its bound ended", () => ended().length === 1);
    expect(ended()).toEqual([expect.objectContaining({ why: "/v1/record read past its bound" })]);
    const emptied = reads.db.checkpoint("truncate");
    expect(emptied.busy).toBe(0);
    expect(reads.started()).toEqual(["first"]);
    reads.release("second");
    const next = await reads.read("second");
    expect((await next.answer)?.status).toBe(200);
    report.read_past_bound = { answer, ended: ended(), started: reads.started(), holding, emptied };
  });

  it("loses its bound when its client hangs up, so its thread holds its snapshot for good", async () => {
    let reach!: () => void;
    const reached = new Promise<void>((resolve) => { reach = resolve; });
    const reads = await heldReads({ readBound: (name) => (name === "/v1/record" ? reached : new Promise<void>(() => undefined)) });
    const held = await reads.read("first");
    await until("the read holds its thread", () => reads.started().includes("first"));
    await held.hangUp();
    reach();
    const ended = reads.ended;
    await until("the thread past its bound ended", () => ended().length === 1);
    expect(ended()).toEqual([expect.objectContaining({ why: "/v1/record read past its bound" })]);
    expect(held.response.headersSent).toBe(false);
    expect(reads.db.checkpoint("truncate").busy).toBe(0);
    report.read_gone_past_bound = { ended: ended(), started: reads.started() };
  });

  it("counts its bound from when a thread takes it, so a read that waited for one answers past the phone's silence, or runs once it was answered", async () => {
    let reach!: () => void;
    const reached = new Promise<void>((resolve) => { reach = resolve; });
    let bounds = 0;
    const reads = await heldReads({ readBound: (name) => (name.startsWith("/v1/record") && ++bounds === 3 ? reached : new Promise<void>(() => undefined)) });
    const first = await reads.read("first"), second = await reads.read("second", "records");
    await until("both long reads held", () => reads.started().length === 2);
    const queued = await reads.read("next");
    reach();
    const answer = await queued.answer;
    expect(answer).toMatchObject({ status: 503, retry: "60", body: { code: "NOT_NOW", message: expect.stringContaining("try again") } });
    for (const key of ["first", "second", "next"]) reads.release(key);
    expect([(await first.answer)?.status, (await second.answer)?.status]).toEqual([200, 200]);
    expect(reads.started().sort()).toEqual(["first", "second"]);
    report.read_waited_past_bound = { answer, started: reads.started() };
  });
});

describe("one copy of a read", () => {
  it("runs a route twice at once, or reads identical asks made while it runs more than once, or answers one of them from before a write that came before it", async () => {
    const reads = await heldReads();
    const running = await reads.read("first", "records");
    await until("the route runs", () => reads.started().includes("first"));
    const asks = [await reads.read("gone", "records"), await reads.read("gone", "records")];
    reads.note("fz");
    asks.push(await reads.read("gone", "records"));
    reads.release("first");
    expect((await running.answer)?.status).toBe(200);
    await until("the joined read holds its thread", () => reads.started().includes("fz"));
    reads.release("fz");
    const answers = await Promise.all(asks.map((each) => each.answer));
    expect(answers.map((each) => [each?.status, (each?.body.records as { key: string }[]).map((record) => record.key)])).toEqual([[200, ["fz"]], [200, ["fz"]], [200, ["fz"]]]);
    expect(reads.started()).toEqual(["first", "fz"]);
    report.read_joined = { started: reads.started(), answers: answers.map((each) => each?.body.records) };
  });
});

describe("a stuck read", () => {
  it("takes the door with it: two reads stuck past their bound hold a short read, an exchange or a third long read's answer, say READ_TOO_LONG, or start a second copy of their route", async () => {
    const reach = new Map<string, () => void>();
    const reads = await heldReads({ readBound: (path) => new Promise<void>((resolve) => { reach.set(path, resolve); }) });
    writePrepared(openHomeFolder(reads.at.root), preparedFileOf(preparedDirOf(reads.at.root, machine().dir, "people"), "people"), PEOPLE,
      { rows: new Map([["answer", new Map([["list", { people: [] }]])]]), position: "0:0" });
    reads.stick("first");
    reads.stick("connectors");
    const record = await reads.read("first");
    const connectors = await reads.ask("/v1/connectors", "the connectors report");
    await until("both reads stuck in their step", () => reads.started().includes("first") && reads.started().includes("connectors"));
    reach.get("/v1/record")!();
    reach.get("/v1/connectors")!();
    const cut = [await record.answer, await connectors.answer];
    for (const answer of cut) expect(answer).toMatchObject({ status: 503, retry: "300", body: { code: "NOT_NOW", message: "Lifestream took too long to read this: try again in a few minutes." } });
    expect(reads.ended()).toEqual([]);
    expect(await get(reads.url, "/v1/people", auth(reads.at, "reader"))).toMatchObject({ status: 200, body: { people: [] } });
    const phone = await exchange(reads.url, auth(reads.at, "phone"));
    expect(phone).toMatchObject({ status: 200, body: { needs: expect.any(Array) } });
    const counts = `/v1/counts?source=${encodeURIComponent(reads.source)}&kind=note`;
    const waiting = await reads.ask(counts, "the counts");
    reach.get("/v1/counts")!();
    const busy = await waiting.answer;
    expect(busy).toMatchObject({ status: 503, retry: "60", body: { code: "NOT_NOW" } });
    expect(JSON.stringify([...cut, busy, phone])).not.toContain("READ_TOO_LONG");
    await reads.unstick("connectors");
    await until("the connectors report's thread gone", () => reads.ended().some((line) => line.why === "/v1/connectors read past its bound"));
    const again = await reads.read("second");
    expect(await get(reads.url, counts, auth(reads.at, "reader"))).toMatchObject({ status: 200, body: { counts: { note: 4 } } });
    expect(reads.started()).not.toContain("second");
    await reads.unstick("first");
    await until("the record's thread gone", () => reads.ended().some((line) => line.why === "/v1/record read past its bound"));
    await until("the record read again", () => reads.started().includes("second"));
    reads.release("second");
    expect(await again.answer).toMatchObject({ status: 200, body: { text: { title: "second" } } });
    expect(reads.logs.join("\n")).not.toContain("READ_TOO_LONG");
    report.read_stuck = { cut, busy, phone: phone.body.needs, ended: reads.ended(), started: reads.started() };
  });
});

describe("two long reads held", () => {
  it("hold no short read: an exchange and People's row are answered on the third thread", async () => {
    const reads = await heldReads();
    writePrepared(openHomeFolder(reads.at.root), preparedFileOf(preparedDirOf(reads.at.root, machine().dir, "people"), "people"), PEOPLE,
      { rows: new Map([["answer", new Map([["list", { people: [] }]])]]), position: "0:0" });
    const first = await reads.read("first"), second = await reads.read("second", "records");
    await until("both long reads held", () => reads.started().length === 2);
    const third = await reads.read("next");
    expect((await exchange(reads.url, auth(reads.at, "mac"))).status).toBe(200);
    expect(await get(reads.url, "/v1/people", auth(reads.at, "reader"))).toMatchObject({ status: 200, body: { people: [] } });
    expect(reads.started().sort()).toEqual(["first", "second"]);
    reads.release("first");
    reads.release("second");
    reads.release("next");
    expect([(await first.answer)?.status, (await second.answer)?.status, (await third.answer)?.status]).toEqual([200, 200, 200]);
    report.short_read_free = { started: reads.started() };
  });
});

describe("a computed read run for a client gone, or held to the door's close", () => {
  it("never runs a queued read whose client hung up, drops a running one's answer unwritten and unlogged, and the next read takes the thread", async () => {
    const reads = await heldReads();
    const first = await reads.read("first"), second = await reads.read("second", "records");
    await until("both threads held", () => reads.started().length === 2);
    const gone = await reads.read("gone");
    await first.hangUp();
    await gone.hangUp();
    const next = await reads.read("next");
    reads.release("first");
    await until("a third read started", () => reads.started().length === 3);
    expect(reads.started()[2]).toBe("next");
    reads.release("next");
    expect(await next.answer).toMatchObject({ status: 200, body: { text: { title: "next" } } });
    expect(first.response.headersSent).toBe(false);
    expect(reads.records()).toEqual([expect.objectContaining({ status: 200 })]);
    reads.release("second");
    expect((await second.answer)?.status).toBe(200);
    expect(reads.started()).not.toContain("gone");
    report.read_gone = { started: reads.started(), logged: reads.records() };
  });

  it("drains as it closes: a held read answered as it ends, an upload still receiving finishes, waits for a thread to check it, and seals; a read still held at the drain's end is cut", async () => {
    let drain!: () => void;
    const drained = new Promise<void>((resolve) => { drain = resolve; });
    const reads = await heldReads({ drain: () => drained });
    onTestFinished(() => drain());
    const first = await reads.read("first"), second = await reads.read("second", "records");
    await until("both threads held", () => reads.started().length === 2);
    const bundle = phoneBundle({ domains: { "location.jsonl": [1] }, custody: { [LOCATION]: { seal: 1 } } });
    const slow = held(bundle.bytes);
    onTestFinished(() => slow.release());
    const upload = put(reads.url, `/v1/bundles/${bundle.id}`, { ...auth(reads.at, "phone"), ...sized(bundle.bytes) }, slow.body);
    await until("the upload's partial", () => leftovers(reads.at).length > 0);
    const closing = reads.door.close();
    reads.release("first");
    expect(await first.answer).toMatchObject({ status: 200 });
    reads.release("bundle");
    slow.release();
    const answer = await upload;
    expect(answer.status).toBe(201);
    expect(custodyOf(answer.body)[LOCATION]).toEqual([1, 0]);
    drain();
    await closing;
    expect(await second.answer).toBe(null);
    expect(sealedNames(reads.at, PHONE_SOURCE)).toEqual([bundle.id]);
    const lines = reads.logs.map((line) => JSON.parse(line) as { status?: number; reader?: string; door?: string; cut?: Record<string, number> });
    expect(lines.filter((line) => line.status === 500 || line.reader === "ended")).toEqual([]);
    expect(lines.find((line) => line.door === "closed")).toMatchObject({ ms: expect.any(Number), cut: { uploads: 0, feeds: 0, polls: 0, other: 1, sockets: expect.any(Number) } });
    report.read_closing = { started: reads.started(), logged: reads.records(), upload: answer.status };
  });

  it("drains for its while, then cuts: a silent upload, a trickling small body, a blocked feed and a finished answer its client does not read are cut and counted, an upload whose seal runs across the drain's end seals, and the cut upload leaves no partial", async () => {
    const at = home();
    const db = makeHomeDb(join(at.root, "home.db"));
    const big = "x".repeat(32 * 1024);
    const append = db.prepare("INSERT INTO events (at_ms, kind, key, detail) VALUES (?, 'day', ?, ?)");
    db.transaction(() => { for (let n = 0; n < 500; n++) append.run(NOW_MS + n, `2026-10-${String(n % 28 + 1).padStart(2, "0")}`, JSON.stringify({ big })); })();
    db.close();
    writePrepared(openHomeFolder(at.root), preparedFileOf(preparedDirOf(at.root, machine().dir, "people"), "people"), PEOPLE,
      { rows: new Map([["answer", new Map([["list", { people: [], filler: "x".repeat(24 * 1024 * 1024) }]])]]), position: "0:0" });
    const inbox = join(at.root, "inbox", MACHINE);
    let sealing = false;
    let letSeal!: () => void;
    const sealed = new Promise<void>((resolve) => { letSeal = resolve; });
    const write = fs.createWriteStream;
    fs.createWriteStream = ((path: Parameters<typeof write>[0], options?: Parameters<typeof write>[1]) => {
      const real = write(path, options);
      if (!String(path).startsWith(`${inbox}/`)) return real;
      sealing = true;
      return new Writable({
        write(chunk: Buffer, encoding, done) { void sealed.then(() => real.write(chunk, encoding, done)); },
        final(done) { void sealed.then(() => real.end(() => done())); },
      });
    }) as typeof write;
    syncBuiltinESMExports();
    onTestFinished(() => { letSeal(); fs.createWriteStream = write; syncBuiltinESMExports(); });
    let drain!: () => void;
    const drained = new Promise<void>((resolve) => { drain = resolve; });
    const feeds: ServerResponse[] = [];
    const people: ServerResponse[] = [];
    const see = (message: unknown) => {
      const { request, response } = message as { request: IncomingMessage; response: ServerResponse };
      if (request.url?.startsWith("/v1/feed") === true) feeds.push(response);
      if (request.url === "/v1/people") people.push(response);
    };
    subscribe("http.server.request.start", see);
    onTestFinished(() => { unsubscribe("http.server.request.start", see); });
    const { url, logs, door } = await serve(at, {}, undefined, { drain: () => drained });
    onTestFinished(() => drain());
    const port = Number(new URL(url).port);
    const phone = phoneBundle({ domains: { "location.jsonl": [1] }, custody: { [LOCATION]: { seal: 1 } } });
    const silent = held(phone.bytes);
    onTestFinished(() => silent.release());
    const cutUpload = put(url, `/v1/bundles/${phone.id}`, { ...auth(at, "phone"), ...sized(phone.bytes) }, silent.body).then((answer) => answer.status, () => "cut");
    const bundle = mac(0);
    const draining = held(bundle.bytes);
    const finished = put(url, bundle.path, { ...auth(at, "mac"), ...sized(bundle.bytes) }, draining.body).then((answer) => answer.status, () => "cut");
    await until("both uploads' partials", () => leftovers(at).length === 2);
    const trickle = createConnection({ host: "127.0.0.1", port });
    trickle.on("error", () => undefined);
    const trickleClosed = new Promise<void>((resolve) => trickle.once("close", () => resolve()));
    trickle.write(`POST /v1/exchange HTTP/1.1\r\nHost: ${new URL(url).host}\r\nAuthorization: ${auth(at, "mac").authorization}\r\nLifestream-Device: ${DEVICE.mac["lifestream-device"]}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{\r\n`);
    const blocked = createConnection({ host: "127.0.0.1", port });
    blocked.on("error", () => undefined);
    blocked.pause();
    const blockedClosed = new Promise<void>((resolve) => blocked.once("close", () => resolve()));
    blocked.write(`GET /v1/feed?from=0:0 HTTP/1.1\r\nHost: ${new URL(url).host}\r\nAuthorization: ${auth(at, "reader").authorization}\r\n\r\n`);
    await until("the feed's socket full", () => feeds.length === 1 && feeds[0]!.writableNeedDrain);
    const unread = createConnection({ host: "127.0.0.1", port });
    unread.on("error", () => undefined);
    unread.pause();
    const unreadClosed = new Promise<void>((resolve) => unread.once("close", () => resolve()));
    unread.write(`GET /v1/people HTTP/1.1\r\nHost: ${new URL(url).host}\r\nAuthorization: ${auth(at, "reader").authorization}\r\n\r\n`);
    await until("People's row written whole, its handler ended", () => logs.some((line) => (JSON.parse(line) as { path?: string }).path === "/v1/people"));
    expect(people[0]!.writableFinished).toBe(false);
    const closing = door.close();
    draining.release();
    await until("the Mac's seal under way", () => sealing);
    drain();
    expect(await finished).toBe("cut");
    letSeal();
    await closing;
    blocked.resume();
    unread.resume();
    await Promise.all([trickleClosed, blockedClosed, unreadClosed]);
    expect(await cutUpload).toBe("cut");
    expect(leftovers(at)).toEqual([]);
    expect(sealedNames(at, MACHINE)).toEqual([basic(NOW_MS)]);
    expect(sealedNames(at, PHONE_SOURCE)).toEqual([]);
    const closed = logs.map((line) => JSON.parse(line) as { door?: string; ms?: number; cut?: Record<string, number> }).find((line) => line.door === "closed");
    expect(closed).toMatchObject({ ms: expect.any(Number), cut: { uploads: 1, feeds: 1, polls: 0, other: 3 } });
    expect(closed!.cut!.sockets).toBeGreaterThanOrEqual(5);
    expect(logs.map((line) => JSON.parse(line) as { status?: number }).filter((line) => line.status === 500)).toEqual([]);
    report.drained_close = closed;
  });

  it("over the Wi-Fi's listener too: a finished answer a paired device does not read keeps its connection through the drain, and the drain's end cuts it", async () => {
    const at = homeWith({ phone: { kind: "phone", scopes: ["read"], unit: PHONE_UNIT } });
    makeHomeDb(join(at.root, "home.db")).close();
    writePrepared(openHomeFolder(at.root), preparedFileOf(preparedDirOf(at.root, machine().dir, "people"), "people"), PEOPLE,
      { rows: new Map([["answer", new Map([["list", { people: [], filler: "x".repeat(24 * 1024 * 1024) }]])]]), position: "0:0" });
    let drain!: () => void;
    const drained = new Promise<void>((resolve) => { drain = resolve; });
    const people: ServerResponse[] = [];
    const see = (message: unknown) => {
      const { request, response } = message as { request: IncomingMessage; response: ServerResponse };
      if (request.url === "/v1/people") people.push(response);
    };
    subscribe("http.server.request.start", see);
    onTestFinished(() => { unsubscribe("http.server.request.start", see); });
    const { logs, door } = await serve(at, { lan_port: 0 }, undefined, { drain: () => drained });
    onTestFinished(() => drain());
    const lan = (logs.map((line) => JSON.parse(line) as { door?: string; lan?: number }).find((line) => line.door === "open"))!.lan!;
    const unread = tlsConnect({ host: "127.0.0.1", port: lan, rejectUnauthorized: false });
    unread.on("error", () => undefined);
    await new Promise<void>((resolve) => unread.once("secureConnect", () => resolve()));
    unread.pause();
    const unreadClosed = new Promise<void>((resolve) => unread.once("close", () => resolve()));
    const headers = Object.entries(auth(at, "phone")).map(([name, value]) => `${name}: ${value}\r\n`).join("");
    unread.write(`GET /v1/people HTTP/1.1\r\nHost: door\r\n${headers}\r\n`);
    await until("People's row written whole over the Wi-Fi, its handler ended", () => logs.some((line) => (JSON.parse(line) as { path?: string }).path === "/v1/people"));
    const answer = people[0]!;
    const socket = answer.socket!;
    expect(answer.writableFinished).toBe(false);
    const closing = door.close();
    expect(socket.destroyed).toBe(false);
    drain();
    await closing;
    expect(socket.destroyed).toBe(true);
    unread.resume();
    await unreadClosed;
    const closed = logs.map((line) => JSON.parse(line) as { door?: string; cut?: Record<string, number> }).find((line) => line.door === "closed");
    expect(closed).toMatchObject({ cut: { uploads: 0, feeds: 0, polls: 0, other: 1, sockets: 1 } });
  });

  it("logs a seal's own disk failure after the drain's end as that failure and the part's, never the cut's 503; a body the cut ended is the 503", async () => {
    const at = home();
    const inbox = join(at.root, "inbox", MACHINE);
    let sealing = false;
    let fail!: () => void;
    const failing = new Promise<void>((resolve) => { fail = resolve; });
    const write = fs.createWriteStream;
    fs.createWriteStream = ((path: Parameters<typeof write>[0], options?: Parameters<typeof write>[1]) => {
      if (!String(path).startsWith(`${inbox}/`)) return write(path, options);
      sealing = true;
      return new Writable({
        write(_chunk: Buffer, _encoding, done) { void failing.then(() => done(Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" }))); },
      });
    }) as typeof write;
    syncBuiltinESMExports();
    onTestFinished(() => { fail(); fs.createWriteStream = write; syncBuiltinESMExports(); });
    let drain!: () => void;
    const drained = new Promise<void>((resolve) => { drain = resolve; });
    const { url, logs, door } = await serve(at, {}, undefined, { drain: () => drained });
    onTestFinished(() => drain());
    const phone = phoneBundle({ domains: { "location.jsonl": [1] }, custody: { [LOCATION]: { seal: 1 } } });
    const silent = held(phone.bytes);
    onTestFinished(() => silent.release());
    const cutUpload = put(url, `/v1/bundles/${phone.id}`, { ...auth(at, "phone"), ...sized(phone.bytes) }, silent.body).then((answer) => answer.status, () => "cut");
    const bundle = mac(0);
    const draining = held(bundle.bytes);
    const failed = put(url, bundle.path, { ...auth(at, "mac"), ...sized(bundle.bytes) }, draining.body).then((answer) => answer.status, () => "cut");
    await until("both uploads' partials", () => leftovers(at).length === 2);
    const closing = door.close();
    draining.release();
    await until("the Mac's seal under way", () => sealing);
    drain();
    expect(await failed).toBe("cut");
    fail();
    await closing;
    expect(await cutUpload).toBe("cut");
    const lines = logs.map((line) => JSON.parse(line) as { path?: string; status?: number; code?: string; message?: string; door?: string; why?: string });
    expect(lines.filter((line) => line.status === 500)).toEqual([expect.objectContaining({ message: expect.stringContaining("EIO") })]);
    expect(lines.filter((line) => line.door === "storage failed")).toEqual([expect.objectContaining({ why: expect.stringContaining("EIO") })]);
    expect(lines.find((line) => line.path?.startsWith("/v1/bundles/") === true)).toMatchObject({ status: 503, code: "NOT_NOW" });
    expect(sealedNames(at, MACHINE)).toEqual([]);
  });

  it("cuts a part still closing (a move's) at the drain's end too: its bundle check, held, is rejected the one 503, and the close ends without it", async () => {
    let drain!: () => void;
    const drained = new Promise<void>((resolve) => { drain = resolve; });
    const reads = await heldReads({ drain: () => drained, lookMs: 20 });
    onTestFinished(() => drain());
    const bundle = phoneBundle({ domains: { "location.jsonl": [1] }, custody: { [LOCATION]: { seal: 1 } } });
    const upload = put(reads.url, `/v1/bundles/${bundle.id}`, { ...auth(reads.at, "phone"), ...sized(bundle.bytes) }, bundle.bytes).then((answer) => answer.status, () => "cut");
    await until("the bundle's check held on its thread", () => reads.started().includes("bundle"));
    const pointer = join(machine().dir, "home");
    writeFileSync(pointer, `${join(tmpdir(), "synthetic-moved-home")}\n`);
    onTestFinished(() => rmSync(pointer, { force: true }));
    const lines = () => reads.logs.map((line) => JSON.parse(line) as { door?: string; why?: string; status?: number; cut?: Record<string, number> });
    await until("the part unseated by the move", () => lines().some((line) => line.door === "waiting" && line.why?.startsWith("Lifestream moved") === true));
    let ended = false;
    const closing = reads.door.close().then(() => { ended = true; });
    drain();
    await until("the door closed with the check still held", () => ended);
    await closing;
    expect(await upload).toBe("cut");
    expect(lines().filter((line) => line.status === 500)).toEqual([]);
    expect(lines().find((line) => line.door === "closed")).toMatchObject({ cut: { uploads: 0, feeds: 0, polls: 0, other: 1 } });
  });

  it("ends the face engine's child a model's picture read waits on when the drain ends: the read is the one 503, never a failure, and the child is gone", async () => {
    const registry = join(REPO, "packages", "home", "test", "read-registry.ts");
    const source = "whatsapp:local:iphone-aa01", chat = "15550000142@s.whatsapp.net";
    const photo = Buffer.from("synthetic chat photo bytes"), hash = `sha256:${hex(photo)}`;
    const sent = Math.floor(Date.now() / 86_400_000) * 86_400_000 - 10 * 86_400_000 + 9 * 3_600_000, date = sent / 1000 - 978_307_200;
    const day = new Date(sent).toISOString().slice(0, 10);
    const root = makeRoot("lifestream-door-picture-", { sources: { [source]: "fake-rows" }, settings: { "model.defaults.hiding": null } });
    const file = openHomeFolder(root);
    const agentToken = "synthetic-token-agent".padEnd(43, "x");
    mintPrincipal(file, {
      unit: "agent-a", kind: "agent", scopes: ["read"], token: agentToken, now_ms: NOW_MS,
      granted: { agent: { name: "Agent A", via: "pass", from: null, checked: false, client_id: null, resource: null } },
    });
    const agent = { authorization: `Bearer ${agentToken}`, "lifestream-server": mintPrincipal(file, { unit: "mcp", scopes: ["admit"], now_ms: NOW_MS }).token };
    const running = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry, log: () => undefined });
    onTestFinished(async () => {
      await running.stop();
      removeRoot(root);
    });
    const engineDir = join(root, "engine");
    mkdirSync(engineDir);
    writeFileSync(join(engineDir, "engine.json"), JSON.stringify({ hang: "read" }));
    const program = join(engineDir, "face-engine");
    writeFileSync(program, `#!/bin/sh\necho $$ >> '${engineDir}/pids'\nFAKE_ENGINE_DIR='${engineDir}' exec '${process.execPath}' '${join(REPO, "packages", "connect", "labelers", "faces", "test", "fake-engine.mjs")}' "$@"\n`);
    chmodSync(program, 0o755);
    let drain!: () => void;
    const drained = new Promise<void>((resolve) => { drain = resolve; });
    const logs: string[] = [];
    const door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { lookMs: LOOK_MS, log: (line) => logs.push(line), registry, drain: () => drained, hiding: { engine: program } });
    onTestFinished(() => door.close());
    onTestFinished(() => drain());
    const url = `http://127.0.0.1:${door.port}`;
    await ship(root, {
      source, fetched_ms: Date.now(), carried: { [hex(photo)]: photo },
      rows: [{
        kind: "msg", key: `${chat}:m1`, at: sent, blobs: [hash],
        content: {
          type: "whatsapp.msg", session_jid: chat, parent_stanza_id: null, media_item: null, group_member_jid: null,
          blobs: [{ hash, bytes: photo.length, role: "ZWAMEDIAITEM.ZMEDIALOCALPATH" }],
          message: {
            ZSTANZAID: "m1", ZTEXT: null, ZFROMJID: chat, ZTOJID: null, ZPUSHNAME: null, ZMESSAGEDATE: date, ZSENTDATE: date,
            ZMESSAGETYPE: 1, ZGROUPEVENTTYPE: null, ZFLAGS: 0, ZMESSAGESTATUS: 1, ZMESSAGEERRORSTATUS: 0, ZISFROMME: 0, ZSTARRED: 0,
          },
        },
      }],
    });
    let pictured: string | undefined;
    await until("the photo's line read, its handle given", async () => {
      const lines = (await post(url, "/v1/read", agent, { args: { from: day, to: day, detail: "lines" } })).body.lines as { ref: string; picture?: true }[] | undefined;
      pictured = lines?.find((line) => line.picture === true)?.ref;
      return pictured !== undefined;
    });
    const read = post(url, "/v1/read", agent, { args: { ref: pictured } }).then((answer) => answer.status, () => "cut");
    const pids = () => existsSync(join(engineDir, "pids")) ? readFileSync(join(engineDir, "pids"), "utf8").split("\n").filter(Boolean).map(Number) : [];
    await until("the engine's child running", () => pids().length === 1);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const closing = door.close();
    drain();
    await until("the engine's child gone", () => !alive(pids()[0]!));
    await closing;
    expect(await read).toBe("cut");
    const lines = logs.map((line) => JSON.parse(line) as { path?: string; status?: number; hiding?: string });
    expect(lines.filter((line) => line.path === "/v1/read").at(-1)).toMatchObject({ status: 503 });
    expect(lines.filter((line) => line.hiding === "failed")).toEqual([]);
  });
});

describe("a deploy", () => {
  it("SIGTERM lets an upload in flight finish with 201, then the door exits 0", async () => {
    const at = home();
    const door = await startDoor(at);
    onTestFinished(async () => { await door.stop(); });
    const bundle = mac(0);
    const slow = held(bundle.bytes);
    const answer = put(door.url, bundle.path, { ...auth(at, "mac"), ...sized(bundle.bytes) }, slow.body);
    await until("the upload's partial", () => leftovers(at).length > 0);
    door.child.kill("SIGTERM");
    await until("the door refuses a new connection", () => new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port: Number(new URL(door.url).port) });
      socket.once("connect", () => { socket.destroy(); resolve(false); });
      socket.once("error", () => resolve(true));
    }));
    slow.release();
    expect((await answer).status).toBe(201);
    expect(await door.exited).toBe(0);
    expect(sealedNames(at, MACHINE)).toEqual([basic(NOW_MS)]);
    await expect(exchange(door.url, auth(at, "mac"))).rejects.toThrow();
    expect(door.logs.map((line) => JSON.parse(line)).map((line) => line.door ?? line.status ?? line.custody)).toEqual(["rebuilt", "open", 201, "closed"]);
  });

  it("takes an exchange from a device's pass alone, and reads no wait: a reader's and a drive pass are refused, a Mac's answered at once whatever it states", async () => {
    const at = homeWith({
      mac: { kind: "mac", scopes: ["deliver"], sources: [MACHINE] },
      reader: { scopes: ["read"] },
      drive: { scopes: ["drive"] },
    });
    const { url } = await serve(at);
    for (const who of ["reader", "drive"]) expect(await exchange(url, auth(at, who))).toMatchObject({ status: 403, body: { code: "PRINCIPAL_SCOPE" } });
    const real = globalThis.setTimeout;
    const waits: number[] = [];
    globalThis.setTimeout = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms === 30_000 || ms === 61_000) waits.push(ms);
      return real(handler, ms, ...args);
    }) as typeof setTimeout;
    try {
      for (const query of ["?wait=0", "?wait=30", "?wait=61"]) expect((await exchange(url, auth(at, "mac"), {}, query)).status).toBe(200);
    } finally {
      globalThis.setTimeout = real;
    }
    expect(waits).toEqual([]);
  });
});

describe("where the door answers", () => {
  it("answers on loopback with no Tailscale and no setting, bound once on every IPv4 address", async () => {
    const at = home();
    const { url, logs, door } = await serve(at);
    const answered = await exchange(url, auth(at, "mac"));
    expect(answered.status).toBe(200);
    const lines = logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.door !== undefined);
    expect(lines).toEqual([{ at: expect.any(String), door: "open", host: "0.0.0.0", port: door.port }]);
    report.loopback = { exchange: answered.status, lines };
  });

  it("closes a connection that arrived at the Wi-Fi's or a cable's address before reading it, in Tailscale's range or not, and answers loopback's and Tailscale's, a utun interface come up after the door among them", async () => {
    const at = home();
    const v4 = (address: string) => ({ address, netmask: "255.192.0.0", family: "IPv4" as const, mac: "00:00:00:00:00:00", internal: false, cidr: `${address}/10` });
    const interfaces: Interfaces = { lo0: [{ ...v4("127.0.0.1"), internal: true }], en0: [v4("100.64.0.5"), v4("192.168.1.20")], utun4: [v4("100.100.100.101"), v4("100.127.255.255")] };
    const listening: Server[] = [];
    const heard = (message: unknown) => { listening.push((message as { server: Server }).server); };
    subscribe("tracing:net.server.listen:asyncStart", heard);
    let running: Running;
    try {
      running = await serve(at, {}, undefined, { interfaces: () => interfaces });
    } finally {
      unsubscribe("tracing:net.server.listen:asyncStart", heard);
    }
    const { url, door } = running;
    const server = listening.find((each) => (each.address() as AddressInfo | null)?.port === door.port)!;
    let requests = 0;
    const began = (message: unknown) => { if ((message as { server: Server }).server === server) requests++; };
    subscribe("http.server.request.start", began);
    onTestFinished(() => { unsubscribe("http.server.request.start", began); });
    const seen: Record<string, { answer: string; requests: number }> = {};
    for (const [local, answers] of [
      ["127.0.0.1", true], ["127.0.0.2", true], ["100.100.100.101", true], ["100.127.255.255", true],
      ["100.64.0.5", false], ["100.64.0.0", false], ["100.63.255.255", false], ["100.128.0.0", false], ["192.168.1.20", false], ["10.0.0.5", false], ["172.16.0.9", false],
      ["::1", false], ["fe80::1", false],
      ["100.64.0.9", "utun5"],
    ] as const) {
      if (answers === "utun5") interfaces.utun5 = [v4(local)];
      const before = requests;
      const answer = await arrivedAt(server, local);
      seen[local] = { answer, requests: requests - before };
      expect(seen[local], local).toEqual(answers !== false ? { answer: "HTTP/1.1 401 Unauthorized", requests: 1 } : { answer: "closed", requests: 0 });
    }
    expect(addressesOf(interfaces)).toEqual({ lan: ["100.64.0.5", "192.168.1.20"], tailnet: ["100.100.100.101", "100.127.255.255", "100.64.0.9"] });
    expect((await exchange(url, auth(at, "mac"))).status).toBe(200);
    report.arrivedAt = seen;
  });
});

async function arrivedAt(server: Server, local: string): Promise<string> {
  const relay = createSocketServer();
  const accepted = new Promise<Socket>((resolve) => relay.once("connection", resolve));
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const client = createConnection({ host: "127.0.0.1", port: (relay.address() as AddressInfo).port });
  client.on("error", () => undefined);
  const socket = await accepted;
  relay.close();
  Object.defineProperty(socket, "localAddress", { value: local });
  server.emit("connection", socket);
  let received = "";
  client.on("data", (chunk: Buffer) => { received += chunk.toString("latin1"); });
  const ended = new Promise<void>((resolve) => client.once("close", () => resolve()));
  client.end(`GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:${socket.localPort}\r\nConnection: close\r\n\r\n`);
  await ended;
  return received === "" ? "closed" : received.split("\r\n")[0]!;
}

describe("principals", () => {
  it("reads a principals file of today's format, or reads one whose rows lack a member, or guesses a row's kind", async () => {
    const at = home();
    const path = openHomeFolder(at.root);
    const today = readPrincipals(path);
    expect(today.principals.map((row) => Object.keys(row).sort().join())).toEqual(Array(3).fill("account,id,kind,minted_at,revoked_at,scopes,sources,suspended_at,token_sha256,unit"));
    expect(today.principals.map((row) => row.kind)).toEqual(["mac", "phone", null]);
    for (const member of ["suspended_at", "account"] as const) {
      const { [member]: _gone, ...lacking } = today.principals[2]!;
      writeFileSync(join(path.root, "config", "principals.json"), JSON.stringify({ ...today, principals: [lacking] }));
      expect(() => readPrincipals(path)).toThrow("principals[0] must state id, unit, scopes, sources, token_sha256, minted_at, revoked_at, suspended_at, kind, account");
    }
    const { kind: _kind, ...kindless } = today.principals[1]!;
    writeFileSync(join(path.root, "config", "principals.json"), JSON.stringify({ ...today, principals: [kindless] }));
    expect(() => readPrincipals(path)).toThrow("principals[0] must state id, unit, scopes, sources, token_sha256, minted_at, revoked_at, suspended_at, kind, account");
    expect(today.principals[0]).toMatchObject({ unit: "mac", scopes: ["deliver"], sources: [MACHINE, CALLS], minted_at: "2026-09-08T04:00:00.000Z",
      revoked_at: null, token_sha256: createHash("sha256").update(at.tokens.mac!).digest("hex") });
    writeFileSync(join(path.root, "config", "principals.json"), JSON.stringify({ ...today, principals: [{ ...today.principals[0]!, kind: "watch" }] }));
    expect(() => readPrincipals(path)).toThrow("principals[0].kind must be one of mac, phone, extension, runner, agent, or null");
    writeFileSync(join(path.root, "config", "principals.json"), JSON.stringify({ ...today, principals: today.principals.map(({ unit: _unit, ...row }) => row) }));
    expect(() => readPrincipals(path)).toThrow("principals[0] must state id, unit, scopes, sources, token_sha256, minted_at, revoked_at, suspended_at, kind, account");
  });

  it("mints the privacy bench's pass with `find` alone, a reader's, and refuses a row or a mint that gives it another scope or a kind", async () => {
    const root = makeRoot("lifestream-find-pass-", { sources: {} });
    onTestFinished(() => removeRoot(root));
    const path = openHomeFolder(root);
    const cli = async (args: string[]) => {
      let out = "";
      const status = await runCli([...args, "--root", root], { write: (text) => { out += text; } });
      return { status, out };
    };
    const minted = await cli(["principals", "mint", "--unit", "privacy-bench", "--scope", "find"]);
    expect(minted.status, minted.out).toBe(0);
    const row = readPrincipals(path).principals.find((each) => each.unit === "privacy-bench")!;
    expect([row.scopes, row.kind, row.sources]).toEqual([["find"], null, []]);
    for (const args of [["--scope", "find", "--scope", "read"], ["--scope", "find", "--source", "people:local:macbook-pro-0001"]]) {
      const refused = await cli(["principals", "mint", "--unit", "privacy-bench", ...args]);
      expect(refused.status, refused.out).not.toBe(0);
      expect(refused.out).toContain("a find pass places finds, and nothing else: --scope find alone");
    }
    expect(readPrincipals(path).principals.filter((each) => each.scopes.includes("find"))).toHaveLength(1);
    const file = readPrincipals(path);
    for (const [changed, words] of [
      [{ scopes: ["find", "read"] }, "find is a reader's pass's one scope"],
      [{ kind: "mac" }, "find is a reader's pass's one scope"],
      [{ sources: ["people:local:macbook-pro-0001"] }, "deliver names sources; read names none"],
    ] as const) {
      writeFileSync(join(path.root, "config", "principals.json"), JSON.stringify({ ...file, principals: file.principals.map((each) => (each.id === row.id ? { ...each, ...changed } : each)) }));
      expect(() => readPrincipals(path)).toThrow(words);
    }
  });
});

describe("a door whose folder goes, comes back, or never was", () => {
  const attempt = async (url: string, path: string, headers: Record<string, string>): Promise<{ status: number; code: unknown; retry: string | null; message: unknown } | "closed"> => {
    try {
      const response = await fetch(`${url}${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json", connection: "close" }, body: "{}" });
      const body = await response.json() as Record<string, unknown>;
      return { status: response.status, code: body.code, retry: response.headers.get("retry-after"), message: body.message };
    } catch {
      return "closed";
    }
  };
  const until_ = async (url: string, path: string, headers: Record<string, string>, ready: (answer: Awaited<ReturnType<typeof attempt>>) => boolean) => {
    let last: Awaited<ReturnType<typeof attempt>> | undefined;
    let asking: Promise<void> | null = null;
    await until(`the door's answer at ${path}`, () => {
      asking ??= attempt(url, path, headers).then((each) => { last = each; asking = null; });
      return last !== undefined && ready(last);
    });
    return last!;
  };
  const watching = async (root: string, clock: () => number = Date.now) => {
    const logs: string[] = [];
    const door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 },
      { log: (line) => logs.push(line), clock, lookMs: 50, floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" } });
    onTestFinished(() => door.close());
    let closed = false;
    void door.closed.then(() => { closed = true; });
    const events = () => logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.door !== undefined).map((line) => line.door);
    return { url: `http://127.0.0.1:${door.port}`, logs, events, closed: () => closed };
  };
  const moveAway = (root: string): string => {
    const away = `${root}-away`;
    renameSync(root, away);
    onTestFinished(() => rmSync(away, { recursive: true, force: true }));
    return away;
  };

  it("closes, answers no request but the one 503 naming the path, or makes the folder, once its folder went away (a drive unplugged); back, it serves without a restart", async () => {
    const at = home();
    let now = NOW_MS;
    const door = await watching(at.root, () => now);
    expect((await exchange(door.url, auth(at, "mac"))).status).toBe(200);
    const away = moveAway(at.root);
    now += 2_000;
    const pairing = await attempt(door.url, "/v1/pair", DEVICE.mac);
    expect(pairing).toEqual({ status: 503, code: "NOT_NOW", retry: "60", message: awayWords(at.root) });
    expect(await attempt(door.url, "/v1/exchange", auth(at, "mac"))).toEqual(pairing);
    expect(existsSync(at.root)).toBe(false);
    renameSync(away, at.root);
    now += 2_000;
    await until_(door.url, "/v1/exchange", auth(at, "mac"), (answer) => answer !== "closed" && answer.status === 200);
    expect({ closed: door.closed(), events: door.events() }).toEqual({ closed: false, events: ["open", "waiting", "serving"] });
    report.folderGone = { pairing, events: door.events() };
  });

  it("stops the stage sweep of each folder it closes: the one it served before the folder went, and the one it opened again at its own close", async () => {
    const at = home();
    let now = NOW_MS;
    const sweeps: ("running" | "stopped")[] = [];
    const door = await serveDoor(at.root, { port: 0, max_bundle_bytes: 1 << 30 }, {
      log: () => undefined, clock: () => now, lookMs: 50, floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" },
      beats: { stage: () => {
        const index = sweeps.push("running") - 1;
        return () => { sweeps[index] = "stopped"; };
      } },
    });
    onTestFinished(() => door.close());
    const url = `http://127.0.0.1:${door.port}`;
    expect((await exchange(url, auth(at, "mac"))).status).toBe(200);
    expect(sweeps).toEqual(["running"]);
    const away = moveAway(at.root);
    now += 2_000;
    await until("the gone folder's sweep stopped", () => sweeps[0] === "stopped");
    renameSync(away, at.root);
    now += 2_000;
    await until_(url, "/v1/exchange", auth(at, "mac"), (answer) => answer !== "closed" && answer.status === 200);
    expect(sweeps).toEqual(["stopped", "running"]);
    await door.close();
    expect(sweeps).toEqual(["stopped", "stopped"]);
  });

  it("serves a copy of its folder put in its place (the same home) only through custody of its own, opened again", async () => {
    const at = home();
    let now = NOW_MS;
    const door = await watching(at.root, () => now);
    expect((await exchange(door.url, auth(at, "mac"))).status).toBe(200);
    cpSync(moveAway(at.root), at.root, { recursive: true });
    now += 2_000;
    expect(await attempt(door.url, "/v1/exchange", auth(at, "mac"))).toMatchObject({ status: 503, code: "NOT_NOW", message: awayWords(at.root) });
    await until_(door.url, "/v1/exchange", auth(at, "mac"), (answer) => answer !== "closed" && answer.status === 200);
    expect({ closed: door.closed(), events: door.events() }).toEqual({ closed: false, events: ["open", "waiting", "serving"] });
  });

  it("answers 500 on and on, or closes, once its own custody.db fails under it (a drive mounted again under the same inode): it opens it again", async () => {
    const at = home();
    const door = await watching(at.root);
    expect((await exchange(door.url, auth(at, "mac"))).status).toBe(200);
    const probe = new Database(":memory:");
    const statement = Object.getPrototypeOf(probe.prepare("SELECT 1")) as { get: (...args: unknown[]) => unknown };
    probe.close();
    const get = statement.get;
    statement.get = function (this: { database: Database.Database }, ...args: unknown[]) {
      if (this.database.name.endsWith("custody.db")) throw new Database.SqliteError("disk I/O error", "SQLITE_IOERR_READ");
      return get.apply(this, args);
    };
    onTestFinished(() => { statement.get = get; });
    expect(await attempt(door.url, "/v1/exchange", auth(at, "mac"))).toMatchObject({ status: 500 });
    const waiting = await attempt(door.url, "/v1/exchange", auth(at, "mac"));
    expect(waiting).toMatchObject({ status: 503, code: "NOT_NOW", message: expect.stringContaining("SQLITE_IOERR_READ: disk I/O error") });
    statement.get = get;
    await until_(door.url, "/v1/exchange", auth(at, "mac"), (answer) => answer !== "closed" && answer.status === 200);
    const events = door.events();
    expect({ closed: door.closed(), first: events.slice(0, 2), last: events.at(-1), kinds: [...new Set(events)] }).toEqual({
      closed: false, first: ["open", "waiting"], last: "serving", kinds: ["open", "waiting", "serving"],
    });
  });

  it("seals a delivery whose upload began before a move took the calls' lock, or once the pointer names another folder or the folder is retired: the one 503 at the moment of sealing, and the device's next try seals", async () => {
    const at = home();
    const door = await serveDoor(at.root, { port: 0, max_bundle_bytes: 1 << 30 },
      { log: () => undefined, lookMs: 3_600_000, floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" } });
    onTestFinished(() => door.close());
    const url = `http://127.0.0.1:${door.port}`;
    const bundle = mac(0);
    const slow = held(bundle.bytes);
    onTestFinished(() => slow.release());
    const upload = put(url, bundle.path, { ...auth(at, "mac"), ...sized(bundle.bytes) }, slow.body);
    await until("the upload's partial", () => leftovers(at).length > 0);
    const moving = tryLock(callsLock(join(at.root, "replies", "replies.db")))!;
    slow.release();
    const refused = await upload;
    moving.release();
    expect(refused).toEqual({ status: 503, retry: "60", body: { code: "NOT_NOW", message: QUIET, wait: "busy", title: null, line: null, acts: [] } });
    expect(sealedNames(at, MACHINE)).toEqual([]);
    const pointer = join(machine().dir, "home");
    writeFileSync(pointer, `${join(tmpdir(), "synthetic-moved-home")}\n`);
    onTestFinished(() => rmSync(pointer, { force: true }));
    const elsewhere = await put(url, bundle.path, auth(at, "mac"), bundle.bytes);
    rmSync(pointer);
    const retire = () => writeFileSync(join(at.root, "RETIRED.json"), `${JSON.stringify({ retired: new Date(NOW_MS).toISOString() })}\n`);
    retire();
    const retired = await put(url, bundle.path, auth(at, "mac"), bundle.bytes);
    rmSync(join(at.root, "RETIRED.json"));
    const late = held(bundle.bytes);
    onTestFinished(() => late.release());
    const landing = put(url, bundle.path, { ...auth(at, "mac"), ...sized(bundle.bytes) }, late.body);
    await until("the upload's partial", () => leftovers(at).length > 0);
    retire();
    late.release();
    const retiredLanding = await landing;
    rmSync(join(at.root, "RETIRED.json"));
    expect({ elsewhere, retired, retiredLanding }).toEqual({
      elsewhere: { status: 503, retry: "60", body: { code: "NOT_NOW", message: QUIET, wait: "busy", title: null, line: null, acts: [] } },
      retired: { status: 503, retry: "300", body: { code: "NOT_NOW", message: MOVED_AWAY, wait: "busy", title: null, line: null, acts: [] } },
      retiredLanding: { status: 503, retry: "300", body: { code: "NOT_NOW", message: MOVED_AWAY, wait: "busy", title: null, line: null, acts: [] } },
    });
    expect(sealedNames(at, MACHINE)).toEqual([]);
    const again = await put(url, bundle.path, auth(at, "mac"), bundle.bytes);
    expect([again.status, custodyOf(again.body)[MACHINE]]).toEqual([201, [1, 0]]);
    expect(sealedNames(at, MACHINE)).toEqual([basic(NOW_MS)]);
  });

  it("lets a move take the calls' lock while a delivery's files are copied in, or leaves the delivery half-made: the move waits for its manifest", async () => {
    const at = home();
    const door = await serveDoor(at.root, { port: 0, max_bundle_bytes: 1 << 30 },
      { log: () => undefined, lookMs: 3_600_000, floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" } });
    onTestFinished(() => door.close());
    const url = `http://127.0.0.1:${door.port}`;
    const inbox = join(at.root, "inbox", MACHINE);
    const lock = callsLock(join(at.root, "replies", "replies.db"));
    const write = fs.createWriteStream;
    let taken: boolean | undefined;
    fs.createWriteStream = ((path: Parameters<typeof write>[0], options?: Parameters<typeof write>[1]) => {
      if (String(path).startsWith(`${inbox}/`) && taken === undefined) {
        const moving = tryLock(lock);
        taken = moving !== null;
        moving?.release();
      }
      return write(path, options);
    }) as typeof write;
    syncBuiltinESMExports();
    onTestFinished(() => { fs.createWriteStream = write; syncBuiltinESMExports(); });
    const bundle = mac(0);
    const sealed = await put(url, bundle.path, auth(at, "mac"), bundle.bytes);
    expect([sealed.status, taken]).toEqual([201, false]);
    expect(sealedNames(at, MACHINE)).toEqual([basic(NOW_MS)]);
    const after = tryLock(lock);
    expect(after).not.toBeNull();
    after!.release();
  });

  it("refuses to start, or makes the folder, on a folder that is not there (a cold boot with the drive away): it listens, says which path, and serves once it is there", async () => {
    const parent = mkdtempSync(join(tmpdir(), "door-gone-"));
    onTestFinished(() => rmSync(parent, { recursive: true, force: true }));
    const absent = join(parent, "home");
    const door = await watching(absent);
    expect(await attempt(door.url, "/v1/exchange", DEVICE.mac)).toEqual({ status: 503, code: "NOT_NOW", retry: "60", message: awayWords(absent) });
    expect(existsSync(absent)).toBe(false);
    writeFolder(absent);
    const answered = await until_(door.url, "/v1/exchange", DEVICE.mac, (answer) => answer !== "closed" && answer.message !== awayWords(absent));
    expect(answered).toEqual({ status: 503, code: "NOT_NOW", retry: "5", message: STARTING });
    expect({ closed: door.closed(), events: door.events() }).toEqual({ closed: false, events: ["waiting", "open", "serving"] });
  });

  it("answers 401 at a folder no home has started on (it holds no passes yet), or no Retry-After", async () => {
    const root = mkdtempSync(join(tmpdir(), "door-unstarted-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    writeFolder(root);
    const door = await watching(root);
    const answered = await attempt(door.url, "/v1/exchange", { authorization: `Bearer ${"synthetic-token-mac".padEnd(43, "x")}`, ...DEVICE.mac });
    expect(answered).toEqual({ status: 503, code: "NOT_NOW", retry: "5", message: STARTING });
    const line = door.logs.map((each) => JSON.parse(each) as Record<string, unknown>).find((each) => each.path === "/v1/exchange");
    expect(line).toMatchObject({ status: 503, code: "NOT_NOW", message: STARTING });
    expect(existsSync(join(root, "config", "principals.json"))).toBe(false);
  });

  it("asks 5 s of a home starting and of one started again on other connectors, each in its words, and answers the read in flight on the part it replaces; back on the new ones, it serves", async () => {
    let generation: string | null = null;
    const reads = await heldReads({ lookMs: 20, generation: async () => generation }, (at) => mkdirSync(join(at.root, "connectors", "synthetic-folder"), { recursive: true }));
    const lines = () => reads.logs.map((line) => JSON.parse(line) as { door?: string; why?: string });
    const starting = await (await reads.ask("/v1/sources", "a read while the home starts")).answer;
    expect(starting).toMatchObject({ status: 503, retry: "5", body: { code: "NOT_NOW", message: STARTING } });
    generation = "first";
    await until("the door serving the home's first generation", () => lines().some((line) => line.door === "serving"));
    const inFlight = await reads.read("first");
    await until("the read held on its thread", () => reads.started().includes("first"));
    generation = "second";
    const OTHER = "Lifestream started again: the door opens its connectors.";
    expect(await inFlight.answer).toEqual({ status: 503, retry: "5", body: { code: "NOT_NOW", message: OTHER, wait: "starting",
      title: "Lifestream is starting", line: null, acts: [] } });
    expect(lines().filter((line) => line.door === "waiting").map((line) => line.why)).toEqual([OTHER]);
    reads.release("first");
    await until("the door serving the home's second generation", () => lines().filter((line) => line.door === "serving").length === 2);
    expect((await (await reads.read("first")).answer)?.status).toBe(200);
    report.restart_waits = { starting, replaced: OTHER };
  });

  it("states the kind of every wait: a start with the strip's words, connectors that cannot load as a wait on the person, a request's own wait as busy", async () => {
    let generation: string | null = null;
    let broken = false;
    const reads = await heldReads({ lookMs: 20, generation: async () => {
      if (broken) throw new Error("a synthetic connector that does not load");
      return generation;
    } }, (at) => mkdirSync(join(at.root, "connectors", "synthetic-folder"), { recursive: true }));
    const body = async () => (await (await reads.ask("/v1/sources", "a read")).answer)!.body;
    expect(await body()).toEqual({ code: "NOT_NOW", message: STARTING, wait: "starting", title: "Lifestream is starting", line: null, acts: [] });
    broken = true;
    await until("the door waits on connectors it cannot load", () => reads.logs.some((line) => (JSON.parse(line) as { why?: string }).why?.includes("cannot load Lifestream's connectors") === true));
    const unloaded = await (await reads.ask("/v1/sources", "a read while the connectors cannot load")).answer;
    expect(unloaded).toMatchObject({ status: 503, retry: "5", body: { code: "NOT_NOW", wait: "needs", title: "Lifestream can't load its connectors",
      line: "It tries again in a moment. Its log says why", acts: [] } });
    broken = false;
    generation = "first";
    await until("the door serving", () => reads.logs.some((line) => (JSON.parse(line) as { door?: string }).door === "serving"));
    const people = await (await reads.ask("/v1/people", "a read of people not prepared")).answer;
    expect(people).toMatchObject({ status: 503, body: { code: "NOT_NOW", wait: "busy", title: null, line: null, acts: [] } });
  });

  it("keeps an upload landing through a restart on other connectors: the next part serves at once, a read answered by it while the body still lands; the upload seals in the same custody, and the seal after it on the next part follows it", async () => {
    let generation = "first";
    const reads = await heldReads({ lookMs: 20, generation: async () => generation });
    reads.release("bundle");
    const serving = () => reads.logs.filter((line) => (JSON.parse(line) as { door?: string }).door === "serving").length;
    const bundle = mac(0);
    const slow = held(bundle.bytes);
    onTestFinished(() => slow.release());
    const landing = put(reads.url, bundle.path, { ...auth(reads.at, "mac"), ...sized(bundle.bytes) }, slow.body);
    await until("the upload's partial", () => leftovers(reads.at).length > 0);
    generation = "second";
    await until("the door serving the home's second generation", () => serving() === 1);
    expect((await get(reads.url, "/v1/me", auth(reads.at, "reader"))).status).toBe(200);
    expect((await exchange(reads.url, auth(reads.at, "mac"))).status).toBe(200);
    const twice = await putUnread(reads.url, bundle.path, { ...auth(reads.at, "mac"), ...sized(bundle.bytes) });
    expect([twice.status, twice.body.code]).toEqual([409, "UPLOAD_ACTIVE"]);
    expect(leftovers(reads.at)).toHaveLength(1);
    slow.release();
    const landed = await landing;
    expect([landed.status, custodyOf(landed.body)[MACHINE]]).toEqual([201, [1, 0]]);
    const next = mac(1);
    const after = await put(reads.url, next.path, { ...auth(reads.at, "mac"), ...sized(next.bytes) }, next.bytes);
    expect([after.status, custodyOf(after.body)[MACHINE]]).toEqual([201, [2, 0]]);
    expect(sealedNames(reads.at, MACHINE)).toHaveLength(2);
    expect(reads.logs.filter((line) => (JSON.parse(line) as { door?: string }).door === "waiting")).toHaveLength(1);
  });
});

describe("Ask reached through the door", () => {
  it("forwards a turn with a turn pass in place of the device's, its query and body, and streams the answer back as it comes, in order; carries a refusal back as said; refuses a pass that cannot read but at the Mac's sign-in; 503 ASK_DOWN with no Ask server", async () => {
    const at = homeWith({ reader: { scopes: ["read"] }, mac: { kind: "mac", scopes: [...DEVICES.mac.scopes], sources: [MACHINE] } });
    mkdirSync(join(at.root, "replies"), { recursive: true });
    openLedger(openHomeFolder(at.root), { mode: "migrate" }).close();
    const seen: { method: string; url: string; authorization: string | undefined; body: string }[] = [];
    let release = (): void => undefined;
    const stub: Server = createHttpServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        seen.push({ method: request.method ?? "", url: request.url ?? "", authorization: request.headers.authorization, body });
        if (request.url?.startsWith("/ask?") === true) {
          response.writeHead(200, { "content-type": "application/x-ndjson" });
          response.write(`${JSON.stringify({ type: "chat", chat: "1790000000000-abcdef", n: 2 })}\n`);
          release = () => response.end(`${JSON.stringify({ type: "done" })}\n`);
        } else if (request.url === "/ask/login") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ state: "idle" }));
        } else {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "No conversation 1790000000000-abcdef." }));
        }
      });
    });
    await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
    let up = true;
    const down = () => new Promise<void>((done) => {
      if (!up) return done();
      up = false;
      stub.closeAllConnections();
      stub.close(() => done());
    });
    onTestFinished(down);
    const door = await serveDoor(at.root, { port: 0, max_bundle_bytes: 1 << 30 }, { lookMs: LOOK_MS,
      log: () => undefined, clock: () => NOW_MS, floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" },
      ask: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`,
    });
    onTestFinished(() => door.close());
    const url = `http://127.0.0.1:${door.port}`;

    const response = await fetch(`${url}/v1/ask?from=synthetic`, { method: "POST", headers: { ...auth(at, "reader"), "content-type": "application/json" }, body: JSON.stringify({ question: "Synthetic?", chat: "1790000000000-abcdef" }) });
    expect([response.status, response.headers.get("content-type")]).toEqual([200, "application/x-ndjson"]);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("\n")) {
      const read = await reader.read();
      expect(read.done).toBe(false);
      text += decoder.decode(read.value, { stream: true });
    }
    expect(JSON.parse(text)).toEqual({ type: "chat", chat: "1790000000000-abcdef", n: 2 });
    release();
    for (let read = await reader.read(); !read.done; read = await reader.read()) text += decoder.decode(read.value, { stream: true });
    expect(text.trim().split("\n").map((line) => (JSON.parse(line) as { type: string }).type)).toEqual(["chat", "done"]);
    expect(seen).toEqual([{ method: "POST", url: "/ask?from=synthetic", authorization: expect.stringMatching(/^Bearer turn\.[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/u), body: JSON.stringify({ question: "Synthetic?", chat: "1790000000000-abcdef" }) }]);

    expect(await get(url, "/v1/ask/chats/1790000000000-abcdef", auth(at, "reader"))).toEqual({ status: 404, body: { error: "No conversation 1790000000000-abcdef." } });
    expect(seen.at(-1)).toMatchObject({ method: "GET", url: "/ask/chats/1790000000000-abcdef" });
    expect(await get(url, "/v1/ask/chats", auth(at, "mac"))).toMatchObject({ status: 403, body: { code: "PRINCIPAL_SCOPE" } });
    expect(seen.length).toBe(2);
    expect(await get(url, "/v1/ask/login", auth(at, "mac"))).toEqual({ status: 200, body: { state: "idle" } });
    expect(seen.at(-1)).toMatchObject({ method: "GET", url: "/ask/login", authorization: `Bearer ${at.tokens.mac}` });
    expect(await get(url, "/v1/ask/login", auth(at, "reader"))).toMatchObject({ status: 403, body: { code: "PRINCIPAL_SCOPE" } });
    expect(seen.length).toBe(3);

    await down();
    const gone = await fetch(`${url}/v1/ask/chats`, { headers: auth(at, "reader") });
    expect([gone.status, gone.headers.get("retry-after")]).toEqual([503, "5"]);
    const said = await gone.json() as Record<string, string>;
    expect(said.code).toBe("ASK_DOWN");
    report["ask through the door"] = { events: text, seen, gone: said };
  });
});

describe("what a device allows", () => {
  const ACCOUNT = "person-a@example.com";
  const CLOUD = `apple-health:${ACCOUNT}:cloud`;
  type Allows = Record<string, string>;
  type Applies = Record<string, Record<string, unknown>>;

  async function allowing() {
    const root = makeRoot("lifestream-door-allows-", { sources: {} });
    const reader = mintPrincipal(openHomeFolder(root), { unit: "reader", scopes: ["read"], now_ms: Date.now() }).token;
    const skew = { ms: 0 };
    const logs: string[] = [];
    const address = { port: 0, max_bundle_bytes: 8 * 1024 ** 3 };
    const open = () => serveDoor(root, address, { lookMs: LOOK_MS,
      log: (line) => logs.push(line), clock: () => Date.now() + skew.ms, floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" }, registry: FAKES, connectors: fakeDeclarations(),
    });
    const door = await open();
    const port = address.port = door.port;
    editSettings(root, { "door.port": port });
    const started = { door, home: await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, slot: null, log: () => undefined }) };
    onTestFinished(async () => {
      await started.door.close();
      await started.home.stop();
      removeRoot(root);
    });
    const sock = testSocket(root);
    const url = `http://127.0.0.1:${port}`;
    const read = { authorization: `Bearer ${reader}` };
    return {
      root, url, sock, skew, logs, started, read,
      async reopen() { await started.door.close(); started.door = await open(); },
      async stopHome() { await started.home.stop(); },
      async startHome() { started.home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, slot: null, log: () => undefined }); },
      async phone(more: { name?: string; replaces?: string } = {}) {
        const code = (await askHome(sock, "pair", more.replaces === undefined ? [] : ["--replace", more.replaces])) as { code: string };
        const pass = randomPass();
        const body = { code: code.code, pass, kind: "phone", model: "iPhone 17 Pro", account: ACCOUNT, ...(more.replaces === undefined ? { new: true } : {}), ...(more.name === undefined ? {} : { name: more.name }) };
        const paired = await fetch(`${url}/v1/pair`, { method: "POST", headers: { ...DEVICE.phone, "content-type": "application/json" }, body: JSON.stringify(body) });
        expect(paired.status).toBe(200);
        const { unit } = await paired.json() as { unit: string };
        const headers = { authorization: `Bearer ${pass}`, ...DEVICE.phone };
        return {
          unit, pass, headers,
          exchange: (grants?: Allows, settings?: Applies) => exchange(url, headers, { ...(grants === undefined ? {} : { grants }), ...(settings === undefined ? {} : { settings }) }),
          set: (change: Record<string, unknown>) => post(url, "/v1/settings", headers, change),
          stream: (id: string, change: Record<string, unknown>) => post(url, `/v1/connectors/${id}`, headers, change),
        };
      },
      events: () => readHome(root, (db) => db.prepare("SELECT key FROM events WHERE kind = 'stated' ORDER BY seq").pluck().all()) as string[],
      told: (unit: string) => {
        const db = new Database(join(root, "door", "stated.db"), { readonly: true });
        try { return (db.prepare("SELECT min(told) FROM stated WHERE unit = ?").pluck().get(unit) as number | null) === 1; } finally { db.close(); }
      },
      held: (unit: string) => {
        const db = new Database(join(root, "door", "stated.db"), { readonly: true });
        try { return db.prepare("SELECT 1 FROM stated WHERE unit = ? AND (grants IS NOT NULL OR settings IS NOT NULL)").get(unit) !== undefined; } finally { db.close(); }
      },
      async report(headers: Record<string, string> = read) {
        const answer = await get(url, "/v1/connectors", headers);
        expect(answer.status).toBe(200);
        return reportOf(answer.body as unknown as StreamsReport);
      },
    };
  }

  it("status or bare connectors beside a running home is answered otherwise than by the door's route, or a door that does not answer otherwise than by a not now asked again in a moment, its words naming no address", async () => {
    const home = await allowing();
    const asked = (path: string) => home.logs.map((line) => JSON.parse(line) as { path?: string; status?: number }).filter((line) => line.path === path);
    const status = await askHome(home.sock, "status", ["--json"]) as Record<string, unknown>;
    expect(status).toMatchObject({ position: expect.stringMatching(/^\d+:\d+$/u), needs: expect.any(Array) });
    expect(asked("/v1/status")).toEqual([expect.objectContaining({ status: 200 })]);
    const lines: string[] = [];
    expect(await askHome(home.sock, "connectors", [], (line) => lines.push(line))).toMatchObject({ position: expect.stringMatching(/^\d+:\d+$/u), connectors: expect.any(Array) });
    expect(asked("/v1/connectors")).toEqual([expect.objectContaining({ status: 200 })]);
    expect(lines.length).toBeGreaterThan(0);
    const printed: string[] = [];
    expect(await askHome(home.sock, "status", [], (line) => printed.push(line))).toMatchObject({ position: expect.stringMatching(/^\d+:\d+$/u) });
    expect(printed.join("\n")).toContain("Today");
    expect(asked("/v1/status")).toHaveLength(2);
    await home.started.door.close();
    for (const [verb, args] of [["status", ["--json"]], ["connectors", []]] as const) {
      const refused = await askHome(home.sock, verb, [...args]).then(() => null, (error: unknown) => error);
      expect(refused).toBeInstanceOf(Refusal);
      expect(refused).toMatchObject({ status: 503, code: NOT_NOW, words: DOOR_AWAY, retryAfter: RETRY_SOON_S });
      expect((refused as Refusal).words).not.toMatch(/127\.0\.0\.1|:\d+/u);
    }
    await home.reopen();
    report.relayed_reports = { status: Object.keys(status), lines };
  });

  const randomPass = (): string => randomBytes(32).toString("base64url");

  const reportOf = (report: StreamsReport) => ({
    grants: Object.fromEntries(report.devices.filter((device) => device.kind === "phone").map((device) => [device.unit, device.grants])),
    access: report.needs.filter((need) => need.reason === "grant").map((need) => [need.id, need.words, need.unit]).sort(),
  });

  it("an exchange's grants reach no copy or phone, move no feed, or one that changes nothing or states nothing moves it; a grant not stated or asking past two minutes reads as stated; lifestream connectors says otherwise", async () => {
    const home = await allowing();
    const a = await home.phone();
    const stated = { location: "limited", motion: "on", photos: "not-now", health: "asked", contacts: "off", notifications: "not-asked" };
    expect((await a.exchange(stated)).status).toBe(200);
    await until("the home wrote the phone's grants", () => home.events().length === 1);
    const first = await home.report();
    expect(first.grants).toEqual({ [a.unit]: stated });

    await a.exchange(stated);
    await a.exchange();
    const asking = { ...stated, location: "asking" };
    await a.exchange(asking);
    await until("the home told of the change", () => home.told(a.unit));
    expect(home.events()).toEqual([a.unit, a.unit]);
    expect((await home.report()).grants[a.unit]!.location).toBe("asking");
    const socket = reportOf(await askHome(home.sock, "connectors") as StreamsReport);
    expect(socket.grants).toEqual((await home.report()).grants);

    home.skew.ms = 2 * 60_000 + 1_000;
    const later = await home.report();
    const { location: _location, ...unasked } = stated;
    expect(later.grants[a.unit]).toEqual(unasked);
    expect((await askHome(home.sock, "connectors") as StreamsReport).devices.find((device) => device.kind === "phone")!.grants).toEqual(later.grants[a.unit]);
    expect(await a.exchange({ location: "maybe" })).toMatchObject({ status: 422, body: { code: "BAD_REQUEST" } });
    report["what a device allows: stated"] = { first, later };
  });

  it("a replaced install's grants overwrite the new install's, grants are lost across a door restart or outlive their pass's revoke into a pairing again, or a change the home did not answer never moves the feed", async () => {
    const home = await allowing();
    const old = await home.phone();
    await old.exchange({ location: "on" });
    await until("the home wrote the grants", () => home.told(old.unit));
    await home.reopen();
    expect((await home.report()).grants[old.unit]?.location).toBe("on");

    const fresh = await home.phone({ replaces: old.unit });
    const bundle = phoneBundle({ entries: { "health.jsonl": [healthLine(1)] }, custody: { [CLOUD]: { seal: 1 } }, install: INSTALL_TWO });
    expect((await put(home.url, `/v1/bundles/${bundle.id}`, fresh.headers, bundle.bytes)).status).toBe(201);
    await fresh.exchange({ location: "limited" });
    await until("the home wrote the new install's grants", () => home.events().length === 2 && home.told(fresh.unit));
    const replaced = await old.exchange({ location: "off" });
    expect(replaced.body.replaced).toEqual(expect.any(String));
    expect((await home.report()).grants[old.unit]?.location).toBe("limited");

    await home.stopHome();
    await fresh.exchange({ location: "off" });
    await until("the door's ask of a stopped home lost", () => home.logs.some((line) => line.includes(`"stated":"${fresh.unit}"`) && line.includes('"lost"')));
    expect([home.events().length, home.told(fresh.unit)]).toEqual([2, false]);
    await home.startHome();
    await fresh.exchange();
    await until("the change the home missed written", () => home.told(fresh.unit));
    expect(home.events()).toEqual([old.unit, old.unit, old.unit]);
    expect((await home.report()).grants[old.unit]?.location).toBe("off");

    const principals = openHomeFolder(home.root);
    const revokeAll = () => {
      for (const pass of readPrincipals(principals).principals.filter((row) => row.unit === old.unit && row.revoked_at === null)) revokePrincipal(principals, pass.id, Date.now());
    };
    revokeAll();
    const gone = await home.report();
    expect(gone.grants[old.unit] ?? null).toBeNull();
    expect(home.held(old.unit)).toBe(false);

    const again = await home.phone({ replaces: old.unit });
    await again.exchange({ location: "limited" });
    revokeAll();
    const paired = await home.phone({ replaces: old.unit });
    expect((await paired.exchange()).status).toBe(200);
    const inherited = await home.report();
    expect(inherited.grants[old.unit] ?? null).toBeNull();
    expect(home.held(old.unit)).toBe(false);
    await paired.exchange({ location: "limited" });
    revokeAll();
    const third = await home.phone({ replaces: old.unit });
    await third.exchange({ location: "limited" });
    expect((await home.report()).grants[old.unit]).toEqual({ location: "limited" });
    report["what a device allows: passes"] = { gone, inherited };
  });

  it("a grant turned off or limited is no need, worded otherwise than its grant and device, out of status or a device's answer, one for two phones; one not now, never asked, asked, asking or unstated is a need, or a connector no phone allows has one", async () => {
    const home = await allowing();
    const a = await home.phone();
    const b = await home.phone({ name: "Work iPhone" });
    await a.exchange({ location: "off", photos: "limited", contacts: "limited", motion: "not-now", health: "asked", notifications: "asking" });
    await b.exchange({ location: "limited", photos: "not-asked", contacts: "on", notifications: "off", health: "limited" });
    await until("both phones' grants written", () => home.told(a.unit) && home.told(b.unit));
    const needs = [
      [`grant:contacts:${a.unit}`, "Contacts is limited", a.unit],
      [`grant:health:${b.unit}`, "Allow new Health data", b.unit],
      [`grant:photos:${a.unit}`, "Photos is limited", a.unit],
      [`grant:location:${a.unit}`, "Allow Location", a.unit],
      [`grant:location:${b.unit}`, "Location is limited", b.unit],
    ].sort();
    const seen = await home.report(a.headers);
    expect([seen.grants[a.unit]!.health, seen.grants[b.unit]!.health]).toEqual(["asked", "limited"]);
    expect(seen.access).toEqual(needs);
    const status = await get(home.url, "/v1/status", home.read);
    const grants = (list: unknown) => (list as { id: string; reason: string; words: string; unit: string }[]).filter((need) => need.reason === "grant").map((need) => [need.id, need.words, need.unit]).sort();
    expect(grants(status.body.needs)).toEqual(needs);
    expect(grants((await askHome(home.sock, "status", ["--json"]) as { needs: unknown }).needs)).toEqual(needs);
    expect(grants((await a.exchange()).body.needs)).toEqual(needs);
    await a.exchange({ location: "on", photos: "on", contacts: "on", motion: "not-now", health: "asked", notifications: "asking" });
    await until("the change written", () => home.told(a.unit) && home.events().length === 3);
    expect((await home.report()).access).toEqual([
      [`grant:health:${b.unit}`, "Allow new Health data", b.unit],
      [`grant:location:${b.unit}`, "Location is limited", b.unit],
    ]);
    report["what a device allows: needs"] = { seen, status: grants(status.body.needs) };
  });

  it("a device is answered what it does not deliver, or a connector it delivers without the start; what it states is lost, never read, or waits wrongly; a change it makes overwrites a newer one or reaches a field typed on the Mac", async () => {
    const home = await allowing();
    const a = await home.phone();
    const name = "iPhone 17 Pro";
    const rows = async (query = ""): Promise<Record<string, ConnectorReport>> =>
      Object.fromEntries(((await get(home.url, `/v1/connectors${query}`, home.read)).body as unknown as StreamsReport).connectors.map((row) => [row.id, row]));
    const declared = new Map(fakeDeclarations().map((connector) => [connector.id, connector]));

    const first = (await a.exchange()).body.settings as Applies;
    expect(first).toMatchObject({
      location: { precision: "precise", start_ms: null }, checkin: { prompts: false, bedtime: "23:30", start_ms: null }, "apple-photos": { refresh: "5m", start_ms: null },
      "screen-time": { refresh: "5m", start_ms: null },
    });
    for (const absent of ["screen", "claude", "whatsapp", "gmail"]) expect(first).not.toHaveProperty(absent);
    for (const [id, members] of Object.entries(first)) {
      const connector = declared.get(id)!;
      const names = [
        ...(connector.refresh === undefined ? [] : ["refresh"]),
        "start_ms", ...(connector.backfill?.pace === undefined ? [] : ["pace"]),
        ...Object.entries(connector.fields ?? {}).filter(([, field]) => field.kind !== "secret").map(([field]) => field),
      ].sort();
      expect([id, Object.keys(members).sort()]).toEqual([id, names]);
    }
    await askHome(home.sock, "connectors", ["set", "screen-time", "start", JSON.stringify("2026-08-01")]);
    const started = (await a.exchange()).body.settings as Applies;
    expect([started["screen-time"], started["apple-photos"]]).toMatchObject([{ start_ms: Date.UTC(2026, 7, 1) }, { start_ms: null }]);

    const applying = { location: { precision: "battery" }, checkin: { prompts: false, bedtime: "23:30" }, "apple-photos": { refresh: "5m", start_ms: null }, "screen-time": { start_ms: null } };
    expect((await a.exchange(undefined, applying)).status).toBe(200);
    await until("the home wrote the phone's settings", () => home.events().length === 1 && home.told(a.unit));
    const member = (row: ConnectorReport, key: string) => {
      const { value, panel, waiting } = row.members.find((each) => each.key === key)!;
      return { value, drawn: panel !== null, ...(waiting === undefined ? {} : { waiting: waiting.map((each) => each.name) }) };
    };
    const marks = (row: Record<string, ConnectorReport>) => ({
      precision: member(row.location!, "precision"), bedtime: member(row.checkin!, "bedtime"),
      refresh: member(row["apple-photos"]!, "refresh"), start: member(row["screen-time"]!, "start"),
      biome: member(row["screen-time"]!, "refresh"), spam: member(row.gmail!, "spam"),
    });
    const stating = marks(await rows());
    expect(stating).toMatchObject({
      precision: { value: "precise", drawn: true, waiting: [name] }, bedtime: { value: "23:30", drawn: true, waiting: [] },
      refresh: { value: "5m", drawn: true, waiting: [] }, start: { value: "2026-08-01", drawn: true },
      biome: { drawn: false, waiting: [] },
    });
    expect([Object.hasOwn(stating.spam, "waiting"), Object.hasOwn(stating.start, "waiting")]).toEqual([false, false]);
    const socket = Object.fromEntries((await askHome(home.sock, "connectors") as StreamsReport).connectors.map((row) => [row.id, row]));
    expect(marks(socket)).toEqual(stating);

    await a.exchange(undefined, applying);
    await a.exchange({ location: "on" });
    await until("the grants written", () => home.events().length === 2 && home.told(a.unit));
    expect(marks(await rows()).precision).toMatchObject({ drawn: true, waiting: [name] });
    await a.exchange(undefined, { ...applying, location: { precision: "precise" }, "screen-time": { start_ms: Date.UTC(2026, 7, 1) } });
    await until("the applied settings written", () => home.events().length === 3 && home.told(a.unit));
    const applied = marks(await rows());
    expect([applied.precision!.waiting, Object.hasOwn(applied.start, "waiting")]).toEqual([[], false]);

    const taken = await a.set({ connector: "location", member: "precision", value: "battery", was: "precise" });
    expect(taken, "the save answers what landed, as the report then says it").toEqual({ status: 200, body: { landed: { connector: "location", member: "precision", value: "battery" } } });
    expect(member((await rows()).location!, "precision")).toMatchObject({ value: "battery", drawn: true, waiting: [name] });
    expect((await a.exchange()).body.settings).toMatchObject({ location: { precision: "battery" } });
    expect(await a.set({ connector: "location", member: "precision", value: "precise", was: "precise" })).toMatchObject({ status: 409, body: { code: "CHANGED", value: "battery" } });
    expect(await a.set({ connector: "location", member: "precision", value: "nearest", was: "battery" })).toMatchObject({ status: 422, body: { code: "SETTING_REFUSED" } });
    expect(await a.set({ connector: "coast", member: "database", value: "/tmp/coast.db" })).toMatchObject({ status: 403, body: { code: "PRINCIPAL_SCOPE", message: expect.stringContaining("the Mac Lifestream runs on") } });
    expect(await a.set({ connector: "nothing", member: "precision", value: "battery" })).toMatchObject({ status: 403, body: { code: "PRINCIPAL_SCOPE" } });
    expect(await a.set({ connector: "location", member: "precision" })).toMatchObject({ status: 422, body: { code: "BAD_REQUEST" } });
    expect(member((await rows()).location!, "precision")).toMatchObject({ value: "battery" });

    const ocr = async (query: string) => member((await rows(query)).screen!, "ocr").waiting;
    const macs = [];
    for (const [serial4, name] of [["0001", "Desk Mac"], ["bb07", "Travel Mac"]] as const) {
      const code = (await askHome(home.sock, "pair")) as { code: string };
      const pass = randomPass();
      const paired = await fetch(`${home.url}/v1/pair`, {
        method: "POST", headers: { ...DEVICE.mac, "content-type": "application/json" }, body: JSON.stringify({ code: code.code, pass, kind: "mac", model: "MacBook Pro", serial4, name }),
      });
      expect(paired.status).toBe(200);
      const { unit } = await paired.json() as { unit: string };
      expect((await exchange(home.url, { authorization: `Bearer ${pass}`, ...DEVICE.mac }, { settings: { screen: { ocr: "always" } } })).status).toBe(200);
      await until(`${name}'s settings written`, () => home.told(unit));
      macs.push(unit);
      if (macs.length === 1) expect([await ocr(`?unit=${unit}`), await ocr("")]).toEqual([[], ["Desk Mac"]]);
    }
    expect([await ocr(`?unit=${macs[0]}`), await ocr(`?unit=${macs[1]}`), await ocr("")]).toEqual([["Travel Mac"], ["Desk Mac"], ["Desk Mac", "Travel Mac"]]);
    report["what a device allows: settings"] = { first, stating, applied, taken: taken.body };
  });

  it("a stream paused on a device, whole or its past alone, is no connector pause by you, keeps its history coming, a resume leaves it, Turn off leaves it on, or the route takes another pass, the home's own, an unknown stream or another body; a Mac's found or imports of another shape kept", async () => {
    const home = await allowing();
    const a = await home.phone();
    const standing = () => readHome(home.root, (db) => db.prepare("SELECT target, by FROM controls ORDER BY target").all()) as { target: string; by: string }[];
    const row = async () => ((await get(home.url, "/v1/connectors", home.read)).body as unknown as StreamsReport).connectors.find((each) => each.id === "apple-photos")!;
    const history = async () => Object.entries((await a.exchange()).body.sources as Record<string, { history: boolean }>).filter(([source]) => source.startsWith("apple-photos:")).map(([, held]) => held.history);
    const paused = await a.stream("apple-photos", { paused: true });
    expect(paused).toEqual({ status: 200, body: {} });
    expect(standing()).toEqual([{ target: "pause:apple-photos", by: "you" }]);
    expect(readHome(home.root, (db) => db.prepare("SELECT key, detail FROM events WHERE kind = 'pause'").all())).toEqual([{ key: "pause:apple-photos", detail: JSON.stringify({ by: "you", reason: "" }) }]);
    expect(await history()).toEqual([false]);
    expect(await row()).toMatchObject({ id: "apple-photos", on: true, health: { state: "paused" }, pauses: [{ scope: "all", by: "you" }] });
    const resumed = await a.stream("apple-photos", { paused: false });
    expect([resumed.status, standing(), await history(), (await row()).pauses]).toEqual([200, [], [true], []]);
    expect((await a.stream("apple-photos", { paused: false })).status).toBe(200);
    expect((await a.stream("apple-photos", { paused: true, history: true })).status).toBe(200);
    expect([standing(), await history()]).toEqual([[{ target: "pause:apple-photos:history", by: "you" }], [false]]);
    expect((await a.stream("apple-photos", { paused: false })).status).toBe(200);
    expect(standing()).toEqual([{ target: "pause:apple-photos:history", by: "you" }]);
    expect((await a.stream("apple-photos", { paused: false, history: true })).status).toBe(200);
    expect([standing(), await history()]).toEqual([[], [true]]);
    expect((await a.stream("apple-photos", { paused: true, history: false })).status).toBe(422);
    const off = await a.stream("apple-photos", { on: false });
    expect([off, (await row()).on]).toEqual([{ status: 200, body: {} }, false]);
    expect((JSON.parse(readFileSync(join(home.root, "config", "settings.json"), "utf8")) as Record<string, unknown>)["sources.off"]).toEqual(["apple-photos"]);
    expect(await post(home.url, "/v1/connectors/location", home.read, { paused: true })).toMatchObject({ status: 403, body: { code: "PRINCIPAL_SCOPE" } });
    expect(await a.stream("people", { paused: true })).toMatchObject({ status: 403, body: { code: "PRINCIPAL_SCOPE" } });
    expect(await a.stream("nothing", { paused: true })).toMatchObject({ status: 404, body: { code: "CONNECTOR_UNKNOWN" } });
    for (const body of [{}, { on: true }, { paused: "yes" }, { on: false, paused: true }]) {
      expect([body, await a.stream("location", body)]).toMatchObject([body, { status: 422, body: { code: "BAD_REQUEST" } }]);
    }
    expect(standing()).toEqual([]);
    report["what a device allows: a stream's foot"] = { paused: paused.body, off: off.body };

    const code = (await askHome(home.sock, "pair")) as { code: string };
    const pass = randomPass();
    const paired = await fetch(`${home.url}/v1/pair`, {
      method: "POST", headers: { ...DEVICE.mac, "content-type": "application/json" }, body: JSON.stringify({ code: code.code, pass, kind: "mac", model: "MacBook Pro", serial4: "cc11", name: "Synthetic Mac" }),
    });
    const { unit } = await paired.json() as { unit: string };
    const mac = { authorization: `Bearer ${pass}`, ...DEVICE.mac };
    const waiting = { id: "file-01", name: "takeout-20260814T091500Z-1-001.zip", bytes: 2_048, state: "waiting", why: "mac-room" };
    const sending = { id: "file-02", name: "takeout-20260801T080000Z-1-001.zip", bytes: 4_096, state: "sending", why: null, sha256: "a".repeat(64), seal: 7, pass: "upload-pass-1", sent_bytes: 1_024 };
    const takeout = { kind: "google-takeout", files: [waiting, sending] };
    const kept = { kind: "google-takeout", files: [{ ...waiting, sha256: null, seal: null, pass: null, sent_bytes: null }, sending] };
    expect((await exchange(home.url, mac, { found: ["safari", "apple-notes", "safari"], imports: [takeout] })).status).toBe(200);
    const stated = (column: "found" | "imports") => {
      const db = new Database(join(home.root, "door", "stated.db"), { readonly: true });
      try {
        return JSON.parse(db.prepare(`SELECT ${column} FROM stated WHERE unit = ?`).pluck().get(unit) as string) as unknown;
      } finally {
        db.close();
      }
    };
    expect([stated("found"), stated("imports")]).toEqual([["apple-notes", "safari"], [kept]]);
    for (const body of [{ found: ["Safari"] }, { imports: [{ ...takeout, kind: "Google Takeout" }] }, { imports: [{ ...takeout, files: [{ ...waiting, why: "rain" }] }] },
      { imports: [{ ...takeout, files: [{ id: "file-01", name: "a.zip", bytes: 1, state: "waiting" }] }] },
      { imports: [{ ...takeout, files: [{ ...sending, sha256: "not-a-digest" }] }] },
      { imports: [{ ...takeout, files: [{ ...sending, state: "read" }] }] }]) {
      expect([body, (await exchange(home.url, mac, body)).status]).toEqual([body, 422]);
    }
    expect([stated("found"), stated("imports")]).toEqual([["apple-notes", "safari"], [kept]]);
    const parts = { kind: "google-takeout", files: Array.from({ length: 300 }, (_, n) => ({ ...sending, id: `file-${n + 1}`, name: `takeout-20260814T091500Z-${n + 1}-001.zip`, bytes: 10_000_000_000 })) };
    expect((await exchange(home.url, mac, { imports: [parts] })).status).toBe(200);
    expect(stated("imports")).toEqual([parts]);
  });
});

describe("a station's needs, and a station below the floor", () => {
  it("answers a station only the needs settled in Chrome, and says a station below the floor is to be reloaded or updated until it exchanges at the floor", async () => {
    const GITHUB = "github:person-a:cloud";
    const CLAUDE = "claude:person-a@example.com:browser";
    const [FRESH, DEVELOPMENT, STORE] = ["chrome-5550ac01", "chrome-5550ac02", "chrome-5550ac03"];
    const root = makeRoot("lifestream-door-station-needs-", {
      sources: { [GITHUB]: "github-api", [CLAUDE]: "claude-browser" },
      settings: { "connectors.github": { login: "person-a", route: "github-api" }, "sites.chosen": ["claude"] },
    });
    onTestFinished(() => removeRoot(root));
    const now = Date.now();
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => {
      tx.tables.attempts.put({ target: "fetch:github-api", source: GITHUB, outcome: "need", reason: "signed-out", facts: {}, detail: "GitHub no longer accepts this sign-in", since_ms: now - 3_600_000, at_ms: now - 60_000, contact_ms: now - 60_000, fails: 0 });
      tx.tables.attempts.put({ target: "fetch:claude-browser", source: CLAUDE, outcome: "need", reason: "signed-out", facts: { site: "claude.ai" }, detail: "Sign in to Claude in Chrome", since_ms: now - 3_600_000, at_ms: now - 60_000, contact_ms: now - 60_000, fails: 0 });
    });
    db.close();
    const raw = new Database(join(root, "home.db"));
    for (const unit of [FRESH, DEVELOPMENT, STORE]) raw.prepare("INSERT INTO devices (unit, model, added_ms) VALUES (?, 'Chrome', ?)").run(unit, now - 86_400_000);
    raw.close();
    const principals = openHomeFolder(root);
    const reader = { authorization: `Bearer ${mintPrincipal(principals, { unit: "reader", scopes: ["read"], now_ms: now }).token}` };
    const passes = Object.fromEntries([FRESH, DEVELOPMENT, STORE].map((unit) => [unit, mintPrincipal(principals, { unit, kind: "extension", scopes: ["station"], now_ms: now }).token]));
    const relayed: string[] = [];
    const socket = createSocketServer((connection) => {
      connection.on("data", (chunk) => {
        relayed.push(...chunk.toString("utf8").split("\n").filter((line) => line.length > 0).map((line) => (JSON.parse(line) as { verb: string }).verb));
        connection.end(`${JSON.stringify({ result: {} })}\n`);
      });
    });
    mkdirSync(dirname(testSocket(root).path), { recursive: true, mode: 0o700 });
    await new Promise<void>((resolve) => socket.listen(testSocket(root).path, resolve));
    onTestFinished(() => new Promise<void>((resolve) => socket.close(() => resolve())));
    const door = await serveDoor(root, { port: 0, max_bundle_bytes: 8 * 1024 ** 3 },
      { lookMs: LOOK_MS, log: () => undefined, registry: homeRegistryModule(), floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" } });
    onTestFinished(() => door.close());
    const url = `http://127.0.0.1:${door.port}`;
    const station = (unit: string, version: string, development = false) => post(url, "/v1/stations/exchange", { authorization: `Bearer ${passes[unit]!}`, "lifestream-device": `extension/${version}` }, {
      results: [], station: { unit, version, slots: 2, errands: [], boot: `boot-${unit}`, running: [], pressed: { choose: [], stop: [] }, allowing: [], opened: [], acted: [], ...(development ? { development: true } : {}) },
    });
    const streams = async () => (await get(url, "/v1/connectors", reader)).body as unknown as StreamsReport;
    const listed = async () => ((await get(url, "/v1/status", reader)).body.needs as unknown as StreamsReport["needs"]).map((need) => need.id);
    const facing = (report: StreamsReport) => ({ row: [report.extension.health.state, report.extension.health.words], present: report.extension.present,
      needs: report.needs.filter((need) => need.id.startsWith("extension:")).map((need) => [need.id, need.words]) });

    const all = await streams();
    expect(all.needs.map((need) => need.connector)).toEqual(expect.arrayContaining(["github", "claude"]));

    expect([(await station(DEVELOPMENT, "0.9.0", true)).body.code, (await station(STORE, "0.9.0")).body.code]).toEqual(["DEVICE_TOO_OLD", "DEVICE_TOO_OLD"]);
    const below = facing(await streams());
    expect(below).toEqual({
      row: ["needs-you", "Reload the Lifestream extension in Chrome"], present: false,
      needs: [[`extension:${DEVELOPMENT}`, "Reload the Lifestream extension in Chrome"], [`extension:${STORE}`, "Update the Lifestream extension in Chrome"]],
    });
    expect(await listed()).toEqual(expect.arrayContaining([`extension:${DEVELOPMENT}`, `extension:${STORE}`]));

    const fresh = await station(FRESH, "1.0.0");
    expect(fresh.status).toBe(200);
    const answered = fresh.body.needs as unknown as StreamsReport["needs"];
    expect(answered.map((need) => ({ connector: need.connector, site: need.at?.site }))).toEqual([{ connector: "claude", site: "claude.ai" }]);

    expect([(await station(DEVELOPMENT, "1.0.0", true)).status, (await station(STORE, "1.0.0")).status]).toEqual([200, 200]);
    const after = facing(await streams());
    expect(after).toEqual({ row: ["ok", "Running in Chrome"], present: true, needs: [] });
    expect((await listed()).filter((id) => id.startsWith("extension:"))).toEqual([]);
    report["a station's needs, and a station below the floor"] = { one_list: all.needs.map((need) => need.id), answered: answered.map((need) => need.id), below, after, relayed };
  });
});

async function exchangeRetry(url: string, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown>; retry: string | null }> {
  const response = await fetch(`${url}/v1/exchange`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" });
  return { status: response.status, body: await response.json() as Record<string, unknown>, retry: response.headers.get("retry-after") };
}

describe("custody's answers in their line", () => {
  it("bounds each where it waits, in production's order: the first's deadline answers it busy and cuts no thread, the next reads at once, its own deadline answers it busy; only a read past its own bound is cut, one reader: ended line; the last is answered", async () => {
    const line: (() => void)[] = [];
    const bounds: (() => void)[] = [];
    const reads = await heldReads({
      readBound: (name) => (name === "custody answer" ? new Promise<void>((resolve) => { line.push(resolve); })
        : name === "answer" ? new Promise<void>((resolve) => { bounds.push(resolve); }) : new Promise<void>(() => undefined)),
    });
    const answers = () => reads.started().filter((key) => key === "answer").length;
    writeFileSync(join(reads.at.root, "answer.hold"), "");
    const asked: ReturnType<typeof exchangeRetry>[] = [];
    for (const name of ["A", "B", "C"]) {
      asked.push(exchangeRetry(reads.url, auth(reads.at, "mac")));
      await until(`${name}'s deadline asked`, () => line.length === asked.length);
    }
    await until("A's read held", () => answers() === 1 && bounds.length === 1);
    line[0]!();
    expect(await asked[0]!).toMatchObject({ status: 503, retry: "60", body: { code: "NOT_NOW", message: BUSY_WORDS } });
    await until("B's read held on another thread", () => answers() === 2 && bounds.length === 2);
    expect(reads.ended()).toEqual([]);
    bounds[0]!();
    await until("A's thread gone", () => reads.ended().length === 1);
    line[1]!();
    expect(await asked[1]!).toMatchObject({ status: 503, retry: "60", body: { code: "NOT_NOW", message: BUSY_WORDS } });
    await until("C's read held", () => answers() === 3);
    reads.release("answer");
    expect((await asked[2]!).status).toBe(200);
    expect(reads.ended()).toHaveLength(1);
    rmSync(join(reads.at.root, "answer.hold"));
    expect((await exchangeRetry(reads.url, auth(reads.at, "mac"))).status).toBe(200);
    expect(reads.ended()).toHaveLength(1);
    report.custody_line = { started: reads.started(), ended: reads.ended() };
  });

  it("an upload whose seal finished and whose answer was cut: 503, the seal standing and its nudge owed; its resend, the line clear, is 200 from the seal", async () => {
    const line: (() => void)[] = [];
    const reads = await heldReads({ readBound: (name) => (name === "custody answer" ? new Promise<void>((resolve) => { line.push(resolve); }) : new Promise<void>(() => undefined)) });
    mkdirSync(dirname(testSocket(reads.at.root).path), { recursive: true, mode: 0o700 });
    writeFileSync(testSocket(reads.at.root).path, "");
    writeFileSync(join(reads.at.root, "answer.hold"), "");
    const bundle = mac(0);
    const sent = put(reads.url, bundle.path, { ...auth(reads.at, "mac"), ...sized(bundle.bytes) }, bundle.bytes);
    await until("its answer's read held", () => reads.started().includes("answer"));
    line[0]!();
    expect(await sent).toMatchObject({ status: 503, retry: "60", body: { code: "NOT_NOW", message: BUSY_WORDS } });
    expect(sealedNames(reads.at, MACHINE)).toEqual([basic(NOW_MS)]);
    const nudged = () => reads.logs.map((each) => JSON.parse(each) as { nudge?: string; delivery?: string | null }).filter((each) => each.nudge !== undefined).map((each) => each.delivery);
    await until("the sealed delivery's nudge owed", () => nudged().includes(`${MACHINE}/${basic(NOW_MS)}`));
    rmSync(join(reads.at.root, "answer.hold"));
    reads.release("answer");
    const again = await put(reads.url, bundle.path, { ...auth(reads.at, "mac"), ...sized(bundle.bytes) }, bundle.bytes);
    expect([again.status, custodyOf(again.body)[MACHINE]]).toEqual([200, [1, 0]]);
    expect(sealedNames(reads.at, MACHINE)).toEqual([basic(NOW_MS)]);
  });
});

describe("a prepared read whose client left", () => {
  it("leaves the queue while it waits, and is written nothing while it runs", async () => {
    let peopleReads = 0;
    const reads = await heldReads({ statements: (ran) => { if (ran.some((each) => each.file.endsWith("/people.db"))) peopleReads++; } });
    writePrepared(openHomeFolder(reads.at.root), preparedFileOf(preparedDirOf(reads.at.root, machine().dir, "people"), "people"), PEOPLE,
      { rows: new Map([["answer", new Map([["list", { people: [] }]])]]), position: "0:0" });
    const first = await reads.read("first"), second = await reads.read("second", "records");
    await until("both long reads held", () => reads.started().length === 2);
    writeFileSync(join(reads.at.root, "prepared.hold"), "");
    const running = await reads.ask("/v1/people", "People's row");
    await until("People's row held on the third thread", () => reads.started().includes("prepared"));
    const waiting = await reads.ask("/v1/people", "People's row again");
    await waiting.hangUp();
    await running.hangUp();
    reads.release("prepared");
    await until("the held People's row read on its thread", () => peopleReads === 1);
    for (const key of ["first", "second"]) reads.release(key);
    expect([(await first.answer)?.status, (await second.answer)?.status]).toEqual([200, 200]);
    expect(await get(reads.url, "/v1/people", auth(reads.at, "reader"))).toMatchObject({ status: 200, body: { people: [] } });
    expect(peopleReads).toBe(2);
    expect(running.response.headersSent).toBe(false);
    const lines = reads.logs.map((line) => JSON.parse(line) as { path?: string; status?: number }).filter((line) => line.path === "/v1/people");
    expect(lines).toEqual([expect.objectContaining({ status: 200 })]);
  });
});

function posting(url: string, path: string, headers: Record<string, string>): { write(chunk: Buffer | string): boolean; answer: Promise<{ status: number; body: Record<string, unknown> } | null> } {
  let write!: (chunk: Buffer | string) => boolean;
  const answer = new Promise<{ status: number; body: Record<string, unknown> } | null>((resolve) => {
    const request = httpRequest(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers } }, (response) => {
      let text = "";
      response.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
      response.on("end", () => {
        request.destroy();
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> });
      });
    });
    request.on("error", () => resolve(null));
    request.flushHeaders();
    write = (chunk) => request.write(chunk);
  });
  return { write, answer };
}

describe("a small body", () => {
  it("is let go at its silence, refused 413 BODY_TOO_LARGE before the sender finishes or before a byte, and read as {} empty, 422 when no object", async () => {
    const at = home();
    const { url, logs } = await serve(at, {}, undefined, { silentMs: 60 });
    const headers = { ...auth(at, "mac"), "transfer-encoding": "chunked" };
    const stopped = posting(url, "/v1/exchange", headers);
    stopped.write("{");
    expect(await stopped.answer).toBe(null);
    await until("the silent body's line", () => logs.some((line) => line.includes("\"path\":\"/v1/exchange\"")));
    expect(logs.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.path === "/v1/exchange")).toMatchObject({ status: 503, code: "NOT_NOW", message: expect.stringContaining("silent") });
    const large = posting(url, "/v1/exchange", headers);
    const piece = Buffer.alloc(256 * 1024, " ");
    for (let sent = 0; sent < 12; sent++) large.write(piece);
    expect(await large.answer).toMatchObject({ status: 413, body: { code: "BODY_TOO_LARGE" } });
    const stated = posting(url, "/v1/exchange", { ...auth(at, "mac"), "content-length": String(3 * 1024 * 1024) });
    expect(await stated.answer).toMatchObject({ status: 413, body: { code: "BODY_TOO_LARGE" } });
    const empty = await fetch(`${url}/v1/exchange`, { method: "POST", headers: auth(at, "mac") });
    expect(empty.status).toBe(200);
    expect(await post(url, "/v1/exchange", auth(at, "mac"), [1])).toMatchObject({ status: 422, body: { code: "BAD_REQUEST" } });
  });
});

describe("a small body refused as it ran past its limit", () => {
  it("is answered 413 whole with Connection: close, its rest dropped, and the door ends the connection: a sender that reads the answer and does nothing else is not left holding it", async () => {
    const at = home();
    const { url } = await serve(at, {}, undefined, { lingerMs: 50 });
    const client = createConnection({ host: "127.0.0.1", port: Number(new URL(url).port) });
    client.on("error", () => undefined);
    let text = "";
    let closed = false;
    client.on("data", (chunk: Buffer) => { text += chunk.toString("latin1"); });
    client.on("close", () => { closed = true; });
    client.write(`POST /v1/exchange HTTP/1.1\r\nHost: ${new URL(url).host}\r\nAuthorization: ${auth(at, "mac").authorization}\r\nLifestream-Device: ${DEVICE.mac["lifestream-device"]}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`);
    const piece = Buffer.alloc(256 * 1024, " ");
    for (let sent = 0; sent < 12; sent++) client.write(Buffer.concat([Buffer.from(`${piece.length.toString(16)}\r\n`), piece, Buffer.from("\r\n")]));
    await until("the 413 read whole", () => text.startsWith("HTTP/1.1 413") && text.includes("BODY_TOO_LARGE") && text.endsWith("}"));
    expect(text.toLowerCase()).toContain("connection: close");
    await until("the door ended the connection", () => closed);
  });

  it("serves nothing sent after it: a request pipelined behind the body's end is dropped, the connection ends, and the door's close does not wait on it", async () => {
    const at = home();
    const { url, logs, door } = await serve(at);
    const client = createConnection({ host: "127.0.0.1", port: Number(new URL(url).port) });
    client.on("error", () => undefined);
    let text = "";
    let closed = false;
    client.on("data", (chunk: Buffer) => { text += chunk.toString("latin1"); });
    client.on("close", () => { closed = true; });
    client.write(`POST /v1/exchange HTTP/1.1\r\nHost: ${new URL(url).host}\r\nAuthorization: ${auth(at, "mac").authorization}\r\nLifestream-Device: ${DEVICE.mac["lifestream-device"]}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`);
    const piece = Buffer.alloc(256 * 1024, " ");
    for (let sent = 0; sent < 12; sent++) client.write(Buffer.concat([Buffer.from(`${piece.length.toString(16)}\r\n`), piece, Buffer.from("\r\n")]));
    await until("the 413 read whole", () => text.startsWith("HTTP/1.1 413") && text.endsWith("}"));
    client.write(`0\r\n\r\nGET /v1/me HTTP/1.1\r\nHost: ${new URL(url).host}\r\nAuthorization: ${auth(at, "mac").authorization}\r\n\r\n`);
    await until("the door ended the connection", () => closed);
    expect(text.split("HTTP/1.1 ").length - 1).toBe(1);
    expect(logs.some((line) => line.includes("\"path\":\"/v1/me\""))).toBe(false);
    let shut = false;
    void door.close().then(() => { shut = true; });
    await until("the door closed", () => shut);
  });
});

const RETIRING = "synthetic-iphone-5a51";

describe("a feed follower admitted again", () => {
  it("is ended at the beat after its pass is revoked, suspended or its unit retired at the door's clock now; the others stream on; an agent's pass, a sign-in's too, follows no feed", async () => {
    const at = homeWith({
      reader: { scopes: ["read"] },
      suspended: { scopes: ["read"] },
      admit: { scopes: ["admit"] },
      retired: { kind: "phone", scopes: ["deliver", "read"], sources: [`location:local:${RETIRING}`], unit: RETIRING },
    });
    const file = openHomeFolder(at.root);
    const agentToken = "synthetic-token-agent".padEnd(43, "x");
    mintPrincipal(file, {
      unit: "agent-a", kind: "agent", scopes: ["read"], token: agentToken, now_ms: NOW_MS,
      granted: { agent: { name: "Agent A", via: "pass", from: null, checked: false, client_id: null, resource: null } },
    });
    const signedToken = "synthetic-token-signin".padEnd(43, "x");
    mintPrincipal(file, {
      unit: "agent-b", kind: "agent", scopes: ["read"], token: signedToken, now_ms: NOW_MS,
      granted: {
        agent: { name: "Agent B", via: "sign-in", from: null, checked: false, client_id: "client-b", resource: "https://example.com/mcp", request: "request-b" },
        expires_at: new Date(NOW_MS + 3_600_000).toISOString(), family_sha256: "a".repeat(64), refresh_sha256: "b".repeat(64),
      },
    });
    const db = makeHomeDb(join(at.root, "home.db"));
    onTestFinished(() => { db.close(); });
    db.prepare("INSERT INTO events (at_ms, kind, key, detail) VALUES (?, 'day', ?, NULL)").run(NOW_MS, "2026-10-01");
    const beats: (() => void)[] = [];
    const { url } = await serve(at, {}, () => NOW_MS, { beats: { feed: (tick) => { beats.push(tick); return () => undefined; } } });
    const follow = (headers: Record<string, string>) => {
      const seen: string[] = [];
      let ended = false;
      const stream = fetch(`${url}/v1/feed?from=0:0`, { headers }).then(async (response) => {
        let text = "";
        for await (const chunk of response.body!) {
          text += Buffer.from(chunk).toString("utf8");
          for (const match of text.matchAll(/^id: (.+)$/gmu)) if (!seen.includes(match[1]!)) seen.push(match[1]!);
        }
      }).catch(() => undefined).finally(() => { ended = true; });
      return { seen, ended: () => ended, stream };
    };
    const server = { "lifestream-server": at.tokens.admit! };
    for (const token of [signedToken, agentToken]) expect(await raw(url, "GET", "/v1/feed?from=0:0", { authorization: `Bearer ${token}`, ...server })).toEqual({ status: 403, code: "PRINCIPAL_SCOPE" });
    const followers = {
      retired: follow({ authorization: `Bearer ${at.tokens.retired}`, ...DEVICE.phone }),
      reader: follow(auth(at, "reader")),
      suspended: follow(auth(at, "suspended")),
    };
    const open = () => Object.entries(followers).filter(([, each]) => !each.ended()).map(([name]) => name);
    await until("every follower sent the first event", () => Object.values(followers).every((each) => each.seen.length === 1));
    beats[0]!();
    expect(open()).toEqual(["retired", "reader", "suspended"]);
    retireUnit(file, RETIRING, NOW_MS);
    beats[0]!();
    await followers.retired.stream;
    expect(open()).toEqual(["reader", "suspended"]);
    revokePrincipal(file, at.ids.reader!, NOW_MS);
    beats[0]!();
    await followers.reader.stream;
    expect(open()).toEqual(["suspended"]);
    const passes = readPrincipals(file);
    writePrincipals(file, { ...passes, principals: passes.principals.map((row) => (row.id === at.ids.suspended ? { ...row, suspended_at: new Date(NOW_MS).toISOString() } : row)) });
    beats[0]!();
    await followers.suspended.stream;
    expect(open()).toEqual([]);
  });
});

describe("a model reader's pass at the door", () => {
  const CHAT = "1790000000000-abcdef";
  const READ_ROUTES = [
    "/v1/days", "/v1/days/2026-11-02.json", "/v1/sources", "/v1/records", "/v1/counts", "/v1/record", "/v1/extracts", "/v1/enrichments", "/v1/labels",
    "/v1/conversation", "/v1/people", "/v1/people?id=me", "/v1/people?id=p-a", "/v1/people/search?name=example", "/v1/people/photos", "/v1/people/card",
    "/v1/places", "/v1/places/photos", "/v1/places/suggest", "/v1/devices", "/v1/where", "/v1/status", "/v1/connectors", "/v1/products",
    "/v1/search?lists=record&query=example", "/v1/count?of=messages",
    "/v1/read?from=2026-11-02", "/v1/describe?ref=aaaaaaaa", "/v1/time", "/v1/models", "/v1/processing/range", "/v1/storage", "/v1/start/cost", "/v1/photos/wanted",
    `/v1/photos/${"a".repeat(64)}`,
    "/v1/search/state", "/v1/clock", "/v1/feed", `/v1/blobs/sha256:${"a".repeat(64)}`, `/v1/pictures/sha256:${"a".repeat(64)}`,
    "/v1/outbound", "/v1/privacy", `/v1/privacy/chat/${CHAT}`, "/v1/privacy/chat/1790000000000-other", "/v1/me", "/v1/stated", "/v1/restore", "/v1/a-route-no-one-listed",
    "/v1/access", "/v1/agents",
  ];
  const TURN_GETS = ["/v1/sources", "/v1/records", "/v1/record", "/v1/people?id=me", "/v1/models", "/v1/clock", "/v1/privacy", "/v1/me", "/v1/agents"];
  const BODIES = {
    "/v1/count": {}, "/v1/search": { query: "example", lists: ["record"] }, "/v1/people/search": { name: "example" }, "/v1/read": { from: "2026-11-02" },
  } as const;

  it("is one table: an agent's pass reaches the four by POST, a restore, a note and who it is; a turn's those, a hide and its own conversation's state; nothing else, a route no one listed among it", () => {
    const turn = (chat: string | null) => ({ kind: null, turn: { id: "turn-a", chat, level: chat === null ? null : "all" as const, pick: null } });
    const passes = { agent: { kind: "agent" as const }, turn: turn(CHAT), unlevelled: turn(null) };
    const reached = (method: string, path: string) => Object.entries(passes).filter(([, pass]) => modelReaches(pass, method, new URL(path, "http://door"))).map(([name]) => name);
    for (const path of Object.keys(BODIES)) {
      expect(reached("POST", path), path).toEqual(["agent", "turn", "unlevelled"]);
      expect(reached("GET", `${path}?query=example`), path).toEqual([]);
    }
    expect(reached("POST", "/v1/hide-details")).toEqual(["turn"]);
    expect(reached("POST", "/v1/restore-details")).toEqual(["agent", "turn"]);
    expect(reached("POST", "/v1/feedback")).toEqual(["agent", "turn", "unlevelled"]);
    expect(reached("GET", "/v1/me")).toEqual(["agent", "turn", "unlevelled"]);
    expect(reached("POST", "/v1/privacy/keep")).toEqual(["turn"]);
    expect(reached("POST", "/v1/outbound")).toEqual(["turn", "unlevelled"]);
    for (const path of READ_ROUTES) {
      const expected = path === "/v1/access" ? ["agent"] : TURN_GETS.includes(path) ? (path === "/v1/me" ? ["agent", "turn", "unlevelled"] : ["turn", "unlevelled"]) : path === `/v1/privacy/chat/${CHAT}` ? ["turn"] : [];
      expect(reached("GET", path), path).toEqual(expected);
    }
    for (const path of ["/v1/act", "/v1/exchange", "/v1/process", "/v1/ask", "/v1/describe", "/v1/subscriptions/claude"]) expect(reached("POST", path), path).toEqual([]);
    const read = "/v1/agents/p-0000aa01/reads/call-00000000000000a1";
    expect([reached("GET", read), reached("GET", `${read}/things`)], "a read's page is a turn's as the agent's page is; its things are the person's alone").toEqual([["turn", "unlevelled"], []]);
  });

  it("walks every read route: an agent's pass at each level and a turn's at each level are served those the table names and 403 PRINCIPAL_SCOPE the rest; each POSTs the four and is answered by the path at its level, the person's own pass too when it names the conversation it reads for; an agent's without the MCP server's pass is 403 THROUGH_SERVER", async () => {
    const at = homeWith({ reader: { scopes: ["read"] }, admit: { scopes: ["admit"] } });
    const db = makeHomeDb(join(at.root, "home.db"));
    holdModels(db, [LUNA_ROUTE]);
    db.close();
    mkdirSync(join(at.root, "replies"), { recursive: true });
    openLedger(openHomeFolder(at.root), { mode: "migrate" }).close();
    editSettings(at.root, { "model.defaults.hiding": null });
    writePrepared(openHomeFolder(at.root), peopleFileOf(at.root, machine().dir), PEOPLE, { rows: new Map([["names", new Map([["table", {
      owner: { who: "p-owner", shown: "Owner Example" },
      people: [{ who: "p-owner", is: "human", shown: "Owner Example", names: ["Owner Example"], accounts: [] }],
    } as unknown as JsonObject]])]]), position: "p1" });
    const file = openHomeFolder(at.root);
    const agents = Object.fromEntries((["none", "names", "all"] as const).map((level) => {
      const token = `synthetic-token-${level}`.padEnd(43, "x");
      mintPrincipal(file, {
        unit: `agent-${level}`, kind: "agent", scopes: ["read"], token, now_ms: NOW_MS,
        granted: { agent: { name: `Agent ${level}`, via: "pass", from: null, checked: false, client_id: null, resource: null, level } as never },
      });
      return [level, { authorization: `Bearer ${token}`, "lifestream-server": at.tokens.admit! }];
    }));
    const moving = openLedger(openHomeFolder(at.root), { mode: "write" });
    settleAccess({ folder: openHomeFolder(at.root), access: moving.access, existing: () => [], now_ms: NOW_MS });
    moving.close();
    const passes: string[] = [];
    const stub: Server = createHttpServer((request, response) => {
      request.resume();
      request.on("end", () => {
        passes.push(request.headers.authorization!.slice("Bearer ".length));
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.write(`${JSON.stringify({ type: "chat", chat: CHAT, n: 2 })}\n`);
      });
    });
    await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
    onTestFinished(() => new Promise<void>((done) => {
      stub.closeAllConnections();
      stub.close(() => done());
    }));
    const { url } = await serve(at, {}, undefined, { ask: `http://127.0.0.1:${(stub.address() as AddressInfo).port}` });
    const leaving = new AbortController();
    onTestFinished(() => leaving.abort());
    const open: Response[] = [];
    const turnOf = async (method: string, path: string, body?: unknown): Promise<Record<string, string>> => {
      const response = await fetch(`${url}${path}`, {
        method, signal: leaving.signal, headers: { ...auth(at, "reader"), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.status).toBe(200);
      open.push(response);
      return { authorization: `Bearer ${passes.at(-1)!}` };
    };
    const question = (level: string) => turnOf("POST", "/v1/ask", { question: "Synthetic?", chat: CHAT, level });
    const turns = { none: await question("none"), names: await question("names"), all: await question("all") };
    const unlevelled = await turnOf("GET", "/v1/ask/chats");
    expect(new Set(passes).size).toBe(4);
    for (let i = 0; i < READ_ROUTES.length; i += 4) {
      await Promise.all(READ_ROUTES.slice(i, i + 4).map(async (path) => {
        await Promise.all([
          ...Object.entries(agents).map(async ([level, agent]) => {
            const answered = await raw(url, "GET", path, agent);
            if (path === "/v1/me" || path === "/v1/access") expect(answered.status, `agent ${level} ${path}`).toBe(200);
            else expect(answered, `agent ${level} ${path}`).toEqual({ status: 403, code: "PRINCIPAL_SCOPE" });
          }),
          ...[...Object.entries(turns), ["unlevelled", unlevelled] as const].map(async ([level, turn]) => {
            const answered = await raw(url, "GET", path, turn);
            const served = TURN_GETS.includes(path) || (level !== "unlevelled" && path === `/v1/privacy/chat/${CHAT}`);
            if (served) expect(answered.code, `turn ${level} ${path}`).not.toBe("PRINCIPAL_SCOPE");
            else expect(answered, `turn ${level} ${path}`).toEqual({ status: 403, code: "PRINCIPAL_SCOPE" });
          }),
        ]);
      }));
    }
    await Promise.all(Object.entries(BODIES).map(async ([path, args]) => {
      const argBody = JSON.stringify({ args });
      const turnBody = JSON.stringify({ args, to: "codex:gpt-6-luna", shown: [] });
      await Promise.all([
        ...Object.entries(agents).flatMap(([level, agent]) => [
          raw(url, "POST", path, { ...agent, "content-type": "application/json" }, argBody).then((answered) => {
            expect([403, 500].includes(answered.status), `agent ${level} ${path} ${JSON.stringify(answered)}`).toBe(false);
          }),
          raw(url, "POST", path, { authorization: agent.authorization!, "content-type": "application/json" }, argBody).then((answered) => {
            expect(answered, `agent ${level} ${path}`).toEqual({ status: 403, code: "THROUGH_SERVER" });
          }),
        ]),
        ...Object.entries(turns).map(([level, turn]) =>
          raw(url, "POST", path, { ...turn, "content-type": "application/json" }, turnBody).then((answered) => {
            expect([403, 500].includes(answered.status), `turn ${level} ${path} ${JSON.stringify(answered)}`).toBe(false);
          }),
        ),
        raw(url, "POST", path, { ...auth(at, "reader"), "content-type": "application/json" }, argBody).then((answered) => {
          expect(answered.status, `reader ${path}`).toBe(403);
        }),
        raw(url, "POST", path, { ...auth(at, "reader"), "lifestream-chat": CHAT, "content-type": "application/json" }, turnBody).then((named) => {
          expect([403, 500].includes(named.status), `reader for ${CHAT} ${path} ${JSON.stringify(named)}`).toBe(false);
        }),
        raw(url, "POST", path, { ...unlevelled, "content-type": "application/json" }, turnBody).then((answered) => {
          expect(answered.status, `unlevelled ${path}`).toBe(403);
        }),
      ]);
    }));
    expect(open.every((response) => !response.bodyUsed)).toBe(true);
  });
});

describe("a retired device's pass, read from its row", () => {
  it("reads nothing from a door's first request on, a door started again too, and delivers what it holds: the Mac's pass as a phone's", async () => {
    const at = homeWith({
      mac: { kind: "mac", scopes: ["deliver"], sources: [MACHINE, CALLS] },
      phone: { kind: "phone", scopes: ["deliver", "read"], sources: [LOCATION], unit: PHONE_UNIT },
      reader: { scopes: ["read"] },
    });
    const file = openHomeFolder(at.root);
    expect([...retireUnit(file, "mac", NOW_MS), ...retireUnit(file, PHONE_UNIT, NOW_MS), ...retireUnit(file, "reader", NOW_MS)]).toEqual([at.ids.mac, at.ids.phone]);
    expect(retireUnit(file, "mac", NOW_MS + 1)).toEqual([]);
    const refused = { status: 403, code: "PRINCIPAL_SCOPE" };
    const reads = [];
    for (const start of ["first", "again"]) {
      const { url, door } = await serve(at);
      const answers = {
        mac: await raw(url, "GET", "/v1/me", auth(at, "mac")),
        phone: await raw(url, "GET", "/v1/me", auth(at, "phone")),
        days: await raw(url, "GET", "/v1/days", auth(at, "phone")),
        reader: await raw(url, "GET", "/v1/me", auth(at, "reader")),
      };
      expect(answers, start).toEqual({ mac: refused, phone: refused, days: refused, reader: { status: 200, code: undefined } });
      reads.push(answers);
      await door.close();
    }
    const { url } = await serve(at);
    const bundle = mac(0);
    const shipped = await put(url, bundle.path, { ...auth(at, "mac"), ...sized(bundle.bytes) }, bundle.bytes);
    expect(shipped.status).toBe(201);
    report.retiredPasses = { reads, shipped: shipped.status };
  });
});

describe("the Wi-Fi told nothing before a pass", () => {
  it("answers the Wi-Fi's listener the plain sentence without a pass or with a wrong one; the paired phone's pass the hold's words and Check again; loopback the hold's words", async () => {
    const at = home();
    const { url, logs } = await serve(at, { lan_port: 0 });
    const lan = (logs.map((line) => JSON.parse(line) as { door?: string; lan?: number }).find((line) => line.door === "open"))!.lan!;
    const id = (JSON.parse(readFileSync(join(at.root, "HOME.json"), "utf8")) as { id: string }).id;
    hold(machine(), id, { since_ms: NOW_MS, cause: { missing: "home.db" }, check: { found: ["home.db is not there"], at_ms: NOW_MS } });
    onTestFinished(() => releaseHold(machine(), id));
    const overLan = (headers: Record<string, string>) => new Promise<{ status: number; body: Record<string, unknown>; retry: string | null }>((resolve, reject) => {
      const asked = httpsRequest({ host: "127.0.0.1", port: lan, method: "POST", path: "/v1/exchange", headers: { "content-type": "application/json", ...headers }, rejectUnauthorized: false, agent: false }, (response) => {
        let text = "";
        response.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
        response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(text) as Record<string, unknown>, retry: response.headers["retry-after"] as string ?? null }));
      });
      asked.on("error", reject);
      asked.end("{}");
    });
    const plain = { status: 503, retry: "60", body: { code: "NOT_NOW", message: "Lifestream is not ready: try again in a moment.", wait: "starting",
      title: "Lifestream isn't ready", line: null, acts: [] } };
    await until("the door holds", async () => (await exchangeRetry(url, auth(at, "mac"))).status === 503);
    expect(await overLan({})).toEqual(plain);
    expect(await overLan({ authorization: `Bearer ${"synthetic-token-wrong".padEnd(43, "x")}` })).toEqual(plain);
    const phone = await overLan(auth(at, "phone"));
    expect(phone).toMatchObject({ status: 503, body: { code: "NOT_NOW", wait: "needs", title: "Lifestream's database is missing", acts: [{ do: "verify", label: "Check again" }] } });
    expect(phone.body.message).not.toBe(plain.body.message);
    const loopback = await exchangeRetry(url, {});
    expect(loopback.body).toMatchObject({ code: "NOT_NOW", acts: [{ do: "verify" }] });
    report.lan_not_ready = { plain, phone: phone.body, loopback: loopback.body };
  });
});

function raw(url: string, method: string, path: string, headers: Record<string, string>, body = ""): Promise<{ status: number; code: unknown }> {
  return new Promise((resolve, reject) => {
    const sent = httpRequest(`${url}${path}`, { method, headers: { ...headers, "content-length": String(Buffer.byteLength(body)) } }, (response) => {
      let text = "";
      response.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, code: text === "" ? undefined : (JSON.parse(text) as { code?: unknown }).code }));
    });
    sent.on("error", reject);
    sent.end(body);
  });
}

describe("the door against a web page, a rebound name, and its own log", () => {
  it("refuses a pairing from a page's or another extension's origin, or not sent as JSON, before the home hears of it", async () => {
    const at = home();
    const { url } = await serve(at);
    const body = JSON.stringify({ code: "12345678", pass: randomBytes(32).toString("base64url"), kind: "mac", model: "MacBook Pro", serial4: "0001" });
    const answers = {
      page: await raw(url, "POST", "/v1/pair", { ...DEVICE.mac, origin: "https://site.example", "content-type": "application/json" }, body),
      sandboxed: await raw(url, "POST", "/v1/pair", { ...DEVICE.mac, origin: "null", "content-type": "application/json" }, body),
      other_extension: await raw(url, "POST", "/v1/pair", { ...DEVICE.mac, origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "content-type": "application/json" }, body),
      text: await raw(url, "POST", "/v1/pair", { ...DEVICE.mac, "content-type": "text/plain" }, body),
      form: await raw(url, "POST", "/v1/pair", { ...DEVICE.mac, "content-type": "application/x-www-form-urlencoded" }, body),
      none: await raw(url, "POST", "/v1/pair", DEVICE.mac, body),
      device: await raw(url, "POST", "/v1/pair", { ...DEVICE.mac, "content-type": "application/json; charset=utf-8" }, body),
    };
    expect(answers).toEqual({
      page: { status: 403, code: "PAIR_ORIGIN" }, sandboxed: { status: 403, code: "PAIR_ORIGIN" }, other_extension: { status: 403, code: "PAIR_ORIGIN" },
      text: { status: 415, code: "PAIR_CONTENT_TYPE" }, form: { status: 415, code: "PAIR_CONTENT_TYPE" }, none: { status: 415, code: "PAIR_CONTENT_TYPE" },
      device: { status: 503, code: "NOT_NOW" },
    });
    report.pairGates = answers;
  });

  it("keeps a peer's guess taken when the home may have counted its code (its answer lost), and gives it back when the home was never reached", async () => {
    const at = home();
    const { url } = await serve(at);
    const guess = async () => raw(url, "POST", "/v1/pair", { ...DEVICE.mac, "content-type": "application/json" },
      JSON.stringify({ code: "12345678", pass: randomBytes(32).toString("base64url"), kind: "mac", model: "MacBook Pro", serial4: "0001" }));
    const unreached = [];
    for (let each = 0; each <= PEER_GUESSES; each++) unreached.push(await guess());
    expect(unreached).toEqual(Array.from({ length: PEER_GUESSES + 1 }, () => ({ status: 503, code: "NOT_NOW" })));
    const counted: JsonObject[] = [];
    const server = createSocketServer((connection) => {
      connection.on("error", () => undefined);
      let text = "";
      connection.on("data", (chunk) => {
        text += chunk.toString("utf8");
        if (!text.includes("\n")) return;
        const request = JSON.parse(text.slice(0, text.indexOf("\n"))) as JsonObject;
        if (request.verb !== "redeem") return void connection.end(`${JSON.stringify({ result: {} })}\n`);
        counted.push(request);
        if (counted.length === 1) return void connection.destroy();
        connection.end(`${JSON.stringify({ result: { refused: { status: 403, code: "PAIR_CODE", message: "this code does not pair" } } })}\n`);
      });
    });
    mkdirSync(dirname(testSocket(at.root).path), { recursive: true, mode: 0o700 });
    await new Promise<void>((resolve) => server.listen(testSocket(at.root).path, resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const answers = [];
    for (let each = 0; each <= PEER_GUESSES; each++) answers.push(await guess());
    expect(answers).toEqual([
      { status: 503, code: "OUTCOME_UNKNOWN" },
      ...Array.from({ length: PEER_GUESSES - 1 }, () => ({ status: 403, code: "PAIR_CODE" })),
      { status: 429, code: "PAIR_SLOW_DOWN" },
    ]);
    expect(counted).toHaveLength(PEER_GUESSES);
    report.pairLostAnswer = { unreached, answers };
  });

  it("refuses at loopback a Host that is not 127.0.0.1, localhost or [::1] at its port, a preflight too, and answers this machine's names", async () => {
    const at = home();
    const { url, door, logs } = await serve(at);
    const asked = async (host: string, method = "GET") => raw(url, method, "/v1/status", { host, ...(method === "OPTIONS" ? { origin: "http://rebound.example", "access-control-request-method": "GET" } : {}) });
    const port = door.port;
    const answers = {
      ip: await asked(`127.0.0.1:${port}`), name: await asked(`localhost:${port}`), upper: await asked(`LOCALHOST:${port}`), v6: await asked(`[::1]:${port}`),
      rebound: await asked(`rebound.example:${port}`), rebound_bare: await asked("rebound.example"), no_port: await asked("127.0.0.1"),
      other_port: await asked(`127.0.0.1:${port + 1}`), preflight: await asked(`rebound.example:${port}`, "OPTIONS"),
    };
    expect(answers).toEqual({
      ip: { status: 401, code: "PRINCIPAL_UNKNOWN" }, name: { status: 401, code: "PRINCIPAL_UNKNOWN" }, upper: { status: 401, code: "PRINCIPAL_UNKNOWN" },
      v6: { status: 401, code: "PRINCIPAL_UNKNOWN" },
      rebound: { status: 403, code: "HOST_REFUSED" }, rebound_bare: { status: 403, code: "HOST_REFUSED" }, no_port: { status: 403, code: "HOST_REFUSED" },
      other_port: { status: 403, code: "HOST_REFUSED" }, preflight: { status: 403, code: "HOST_REFUSED" },
    });
    expect((await exchange(url, auth(at, "mac"))).status).toBe(200);
    expect(logs.filter((line) => line.includes('"code":"HOST_REFUSED"'))).toHaveLength(5);
    report.loopbackHost = answers;
  });

  it("logs a request's route, never the account a source id, the person a path or the file an upload names", async () => {
    const at = home();
    const { url, logs } = await serve(at);
    const source = "whatsapp:+15550000001";
    await put(url, `/v1/acquisitions/${encodeURIComponent(source)}/20261003T090000Z`, auth(at, "mac"), Buffer.from("not a bundle"));
    await raw(url, "DELETE", "/v1/errands/e-5550aa09", auth(at, "mac"));
    await raw(url, "GET", `/v1/blobs/sha256:${"ab".repeat(32)}`, auth(at, "reader"));
    await raw(url, "GET", "/v1/days/2026-10-03?file=txt", auth(at, "reader"));
    await raw(url, "GET", "/v1/people/person-a/photos", auth(at, "reader"));
    await raw(url, "GET", "/v1/people/15550000001/photos", auth(at, "reader"));
    await raw(url, "PUT", "/v1/stations/files/e-5550aa09/person-a/statement?part=0", auth(at, "mac"));
    await raw(url, "GET", "/v1/search?lists=record&query=person-a", auth(at, "reader"));
    const paths = logs.map((line) => JSON.parse(line) as { path?: string }).flatMap((line) => line.path === undefined ? [] : [line.path]);
    expect(paths).toEqual(expect.arrayContaining([
      "/v1/acquisitions/whatsapp:<account>/20261003T090000Z", "/v1/errands/<id>", "/v1/blobs/sha256:abababab", "/v1/days/2026-10-03",
      "<unknown>", "/v1/stations/files/<id>/<file>", "/v1/search",
    ]));
    expect(logs.join("\n")).not.toMatch(/15550000001|e-5550aa09|person-a/u);
    report.loggedRoutes = paths;
  });
});

describe("the log names what it measures", () => {
  it("logs a synchronous section past 250 ms by name, one that throws too, and nothing for one under it", () => {
    const lines: JsonObject[] = [];
    let now = 0;
    const stall = stalls((line) => lines.push(line), () => now);
    expect(stall.timed("principals", () => { now += 251; return 1; })).toBe(1);
    stall.timed("settings", () => { now += 250; });
    expect(() => stall.timed("hold", () => { now += 300; throw new Error("a hold that cannot be read"); })).toThrow("a hold that cannot be read");
    expect(lines).toEqual([{ stall: "principals", ms: 251 }, { stall: "hold", ms: 300 }]);
  });

  it("logs custody.db's stall where it is: a seal's transaction, past the await of its write", async () => {
    const at = home();
    const { url, logs } = await serve(at);
    let skew = 0;
    const steady = performance.now.bind(performance);
    vi.spyOn(performance, "now").mockImplementation(() => steady() + skew);
    const transaction = Database.prototype.transaction;
    vi.spyOn(Database.prototype, "transaction").mockImplementation(function (this: Database.Database, work) {
      const made = transaction.call(this, work);
      if (!this.name.endsWith("custody.db")) return made;
      return Object.assign((...args: unknown[]) => {
        skew += 400;
        return made(...args);
      }, made);
    });
    onTestFinished(() => { vi.restoreAllMocks(); });
    const bundle = mac(0);
    expect((await put(url, bundle.path, auth(at, "mac"), bundle.bytes)).status).toBe(201);
    const stalled = logs.map((line) => JSON.parse(line) as { stall?: string; ms?: number }).filter((line) => line.stall === "custody.db");
    expect(stalled).toEqual([expect.objectContaining({ stall: "custody.db", ms: expect.any(Number) })]);
    expect(stalled[0]!.ms).toBeGreaterThanOrEqual(400);
  });

  it("logs the minute's line with the wall clock's gap and the high-waters of connections by reach, feeds and the queue, each counted where it rose though gone by the minute", async () => {
    const minutes: (() => void)[] = [];
    const reads = await heldReads({ beats: { minute: (tick) => { minutes.push(tick); return () => undefined; } } });
    const loopOf = () => reads.logs.map((line) => JSON.parse(line) as { loop?: Record<string, unknown> }).filter((line) => line.loop !== undefined).map((line) => line.loop!);
    const following = new AbortController();
    const feed = await fetch(`${reads.url}/v1/feed?from=0:0`, { headers: auth(reads.at, "reader"), signal: following.signal });
    expect(feed.status).toBe(200);
    following.abort();
    await until("the feed's follower gone", () => reads.logs.some((line) => (JSON.parse(line) as { path?: string }).path === "/v1/feed"));
    const held = [await reads.read("first"), await reads.read("second", "records")];
    await until("both long reads held", () => reads.started().length === 2);
    held.push(await reads.read("next"));
    for (const key of ["first", "second", "next"]) reads.release(key);
    for (const each of held) expect((await each.answer)?.status).toBe(200);
    minutes[0]!();
    expect(loopOf()[0]).toEqual({
      max_ms: expect.any(Number), p99_ms: expect.any(Number), clock_gap_ms: expect.any(Number),
      high: { loopback: expect.any(Number), tailscale: 0, lan: 0, feeds: 1, uploads: 0, queue: 1 },
      passes: { [reads.at.ids.reader!]: 4 },
    });
    expect((loopOf()[0]!.high as { loopback: number }).loopback).toBeGreaterThanOrEqual(1);
    minutes[0]!();
    expect(loopOf()[1]!.high).toMatchObject({ feeds: 0, queue: 0 });
    expect(loopOf()[1]!.passes).toEqual({});
  });

  it("counts the readers' queue of a part replaced before the minute: its peak is the minute's, though another part serves by then", async () => {
    const minutes: (() => void)[] = [];
    let generation = "first";
    const reads = await heldReads({ lookMs: 20, generation: async () => generation, beats: { minute: (tick) => { minutes.push(tick); return () => undefined; } } });
    const loopOf = () => reads.logs.map((line) => JSON.parse(line) as { loop?: { high: Record<string, number>; passes: Record<string, number> } })
      .filter((line) => line.loop !== undefined).map((line) => line.loop!);
    const held = [await reads.read("first"), await reads.read("second", "records")];
    await until("both long reads held", () => reads.started().length === 2);
    held.push(await reads.read("next"));
    for (const key of ["first", "second", "next"]) reads.release(key);
    for (const each of held) expect((await each.answer)?.status).toBe(200);
    generation = "second";
    await until("the part replaced", () => reads.logs.some((line) => (JSON.parse(line) as { door?: string }).door === "serving"));
    minutes[0]!();
    expect(loopOf()[0]!.high).toMatchObject({ queue: 1 });
    expect(loopOf()[0]!.passes).toEqual({ [reads.at.ids.reader!]: 3 });
  });

  it("counts the minute's requests by each pass that asked, by its id alone, and names a device's build and reach on its line, a refused one's too", async () => {
    const at = home();
    const minutes: (() => void)[] = [];
    const { url, logs } = await serve(at, {}, undefined, { beats: { minute: (tick) => { minutes.push(tick); return () => undefined; } } });
    const lines = () => logs.map((line) => JSON.parse(line) as JsonObject);
    const loopOf = () => lines().filter((line) => line.loop !== undefined).map((line) => line.loop as { passes: Record<string, number> });
    const exchanged = async (headers: Record<string, string>) => (await post(url, "/v1/exchange", headers, {})).status;
    await exchanged(auth(at, "mac"));
    await exchanged(auth(at, "mac"));
    expect(await exchanged({ ...auth(at, "mac"), "lifestream-device": "mac/0.1" })).toBe(426);
    await exchanged(auth(at, "phone"));
    expect(await exchanged({ authorization: `Bearer ${"synthetic-token-wrong".padEnd(43, "x")}`, ...DEVICE.phone })).toBe(401);
    expect((await get(url, "/v1/me", auth(at, "reader"))).status).toBe(200);
    expect((await get(url, "/v1/me", { ...auth(at, "reader"), "lifestream-device": "mac/1.0 synthetic-words" })).status).toBe(200);
    minutes[0]!();
    expect(loopOf()[0]!.passes).toEqual({ [at.ids.mac!]: 3, [at.ids.phone!]: 1, [at.ids.reader!]: 2 });
    const exchanges = lines().filter((line) => line.path === "/v1/exchange").map(({ principal, status, device, reach }) => ({ principal, status, device, reach }));
    expect(exchanges).toEqual([
      { principal: at.ids.mac, status: expect.any(Number), device: DEVICE.mac["lifestream-device"], reach: "loopback" },
      { principal: at.ids.mac, status: expect.any(Number), device: DEVICE.mac["lifestream-device"], reach: "loopback" },
      { principal: at.ids.mac, status: 426, device: "mac/0.1", reach: "loopback" },
      { principal: at.ids.phone, status: expect.any(Number), device: "phone/1.0.0", reach: "loopback" },
      { principal: "-", status: 401, device: "phone/1.0.0", reach: "loopback" },
    ]);
    expect(lines().filter((line) => line.path === "/v1/me").map(({ device, reach }) => [device, reach])).toEqual([[undefined, undefined], [undefined, undefined]]);
    expect(logs.filter((line) => line.includes("synthetic-words") || Object.values(at.tokens).some((token) => line.includes(token)))).toEqual([]);
    minutes[0]!();
    expect(loopOf()[1]!.passes).toEqual({});
    report.minute_passes = { passes: loopOf()[0]!.passes, exchanges };
  });
});

describe("two doors on one home", () => {
  it("a second door on the same home does not serve: the first holds the door lock, the second refused and said at its start or at a later look, then closed", async () => {
    const at = home();
    const first = await serve(at);
    await expect(serve(at, {}, undefined, { lockWaitMs: 50 })).rejects.toThrow(/another door serves the home/);
    let key = "";
    const second = await serve(at, {}, undefined, { generation: async () => key, lookMs: 20, lockWaitMs: 50 });
    key = "a-generation";
    expect(await second.door.closed).toMatch(/another door serves the home/);
    expect(second.logs.some((line) => line.includes('"door":"closed"') && line.includes("another door serves the home"))).toBe(true);
    expect((await get(first.url, "/v1/me", auth(at, "reader"))).status).toBe(200);
  });
});

describe("the start, from its slider to its price", () => {
  it("POST /v1/settings sets the home's start; every stream that follows it says it; a Mac is answered its start_ms and is behind while its Through states another; the price waits for a Mac's count once it states a start; its Through's months and Gmail's first page price the stops", async () => {
    const DAY_MS = 86_400_000;
    const now = Date.now();
    const day = new Date(now - 180 * DAY_MS).toISOString().slice(0, 10);
    const start_ms = Date.parse(`${day}T00:00:00Z`);
    const root = makeRoot("lifestream-door-start-", { sources: { [CALLS]: "callhistory-mac", [GMAIL_SOURCE]: "gmail" } });
    const { fakeGmail, mail } = (await import(new URL("../connect/mail/gmail/test/fake.ts", import.meta.url).href)) as typeof import("../connect/mail/gmail/test/fake.js");
    const all: FakeFolder = { uidValidity: 7, uidNext: 1, messages: [] };
    mail(all, 1, 1, ["\\Inbox"], Date.UTC(2020, 0, 15));
    mail(all, 2, 2, ["\\Inbox"], Date.UTC(2020, 0, 16));
    mail(all, 3, 3, ["\\Inbox"], now - 10 * DAY_MS);
    mail(all, 4, 4, ["\\Inbox"], now - 9 * DAY_MS);
    const server = fakeGmail({ "[Gmail]/All Mail": all });
    const gmail = releaseFolder("mail/gmail").gmailImapAcquirer({ account: GMAIL_ACCOUNT, password: "gmail.password" }, { imap: server.imap });
    const kept = { state: { polled_ms: now, folders: { "[Gmail]/All Mail": { uidvalidity: "7", uidnext: "5" } } } };
    await pollCall(gmail, kept, memorySecrets({ "gmail.password": "synthetic-app-password" }), "page", async ({ files, facts, source }) => {
      const fetched_at = facts.fetched_at as string;
      const sealing = openSealing(openHomeFolder(root), { source, name: basicInstant(Date.parse(fetched_at)), feeder: "gmail-imap", fetched_at });
      for (const [path, bytes] of Object.entries(files)) await sealing.write(path, (async function* () { yield bytes; })());
      return sealing.seal(facts);
    }, { ...LENT, start_ms });
    expect(server.asked.filter((asked) => asked.includes("INTERNALDATE"))).toEqual(["[Gmail]/All Mail SIZE INTERNALDATE 1:4"]);

    const address = { port: 0, max_bundle_bytes: 8 * 1024 ** 3 };
    const door = await serveDoor(root, address, { lookMs: LOOK_MS,
      log: () => undefined, clock: () => Date.now(), floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" }, registry: START_REGISTRY, connectors: fakeDeclarations(),
    });
    editSettings(root, { "door.port": door.port });
    const home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: START_REGISTRY, slot: null, log: () => undefined });
    onTestFinished(async () => {
      await door.close();
      await home.stop();
      removeRoot(root);
    });
    const url = `http://127.0.0.1:${door.port}`;
    const read = { authorization: `Bearer ${mintPrincipal(openHomeFolder(root), { unit: "reader", scopes: ["read"], now_ms: now }).token}` };
    const mac = { authorization: `Bearer ${mintPrincipal(openHomeFolder(root), { unit: MAC, kind: "mac", scopes: ["deliver"], sources: [CALLS], now_ms: now }).token}`, ...DEVICE.mac };
    const cost = async () => (await get(url, "/v1/start/cost", read)).body as unknown as StartCost;
    const rows = async () => ((await get(url, "/v1/connectors", read)).body as unknown as StreamsReport).connectors;

    expect(await post(url, "/v1/settings", mac, { "history.start": new Date(now + 2 * DAY_MS).toISOString().slice(0, 10) })).toMatchObject({ status: 422, body: { code: "SETTING_REFUSED" } });
    expect(await post(url, "/v1/settings", mac, { "history.start": day, connector: "gmail" })).toMatchObject({ status: 422, body: { code: "BAD_REQUEST" } });
    expect(await post(url, "/v1/settings", mac, { "history.start": day })).toEqual({ status: 200, body: {} });
    const following = async () => (await rows()).flatMap((row) => row.members.filter((member) => member.key === "start").map((member) => [row.id, member.words]));
    await until("every stream that follows the home says its start", async () => {
      const starts = await following();
      return starts.length > 1 && starts.every(([, words]) => words === startWords(day));
    });

    const answered = await exchange(url, mac, { found: [] });
    expect((answered.body.settings as Record<string, { start_ms?: number | null }>)["apple-calls"]).toMatchObject({ start_ms });
    await until("Gmail's first page counted, the Mac's Calls, which this Mac did not find, at what it holds", async () => {
      const priced = await cost();
      return priced.first === "2020-01" && priced.stops.every((stop) => !stop.more) && priced.settled;
    });
    const reads = { found: ["apple-calls"], grants: { fullDiskAccess: "on" }, stores: { digest: null, states: { "apple-calls": "allowed" } } };
    expect((await exchange(url, mac, { ...reads, through: { [CALLS]: stated(value(now - 120_000, now - 60_000, { left: 4, start_ms: null })) } })).status).toBe(200);
    await until("the Mac's copy, which this Mac now says it reads, waits for its count", async () => {
      const priced = await cost();
      return priced.stops.every((stop) => stop.more) && !priced.settled;
    });

    const thisMonth = new Date(now).toISOString().slice(0, 7);
    const months = { "2019-03": [50, 5_000_000] as [number, number], [thisMonth]: [10, 1_000_000] as [number, number] };
    const through = stated(value(now - 60_000, now, { left: 4, start_ms: null, months }));
    expect((await exchange(url, mac, { through: { [CALLS]: through } })).status).toBe(200);
    await until("the Mac's count priced", async () => (await cost()).settled);
    const calls = (await rows()).find((row) => row.id === "apple-calls")!;
    expect(calls.history?.state).toBe("syncing");

    const priced = await cost();
    const at = (months: number | null) => priced.stops.find((stop) => stop.months === months)!;
    expect(priced).toMatchObject({ start: day, first: "2019-03", settled: true });
    expect(priced.stops.every((stop) => !stop.more)).toBe(true);
    expect(priced.stops.some((stop) => stop.day === day)).toBe(true);
    for (const stream of ["apple-calls", "gmail"]) expect(at(null).streams[stream]!, stream).toBeGreaterThan(at(60).streams[stream]!);
    const text = (at(null).streams["apple-calls"]! - 6_000_000) / 60;
    expect(Number.isInteger(text) && text > 0 && text !== 3000, `${text} bytes an item: the home's own measured rate, not the empty-home figure`).toBe(true);
    report["the start, from its slider to its price"] = { day, starts: await following(), history: calls.history, cost: priced };
  });
});

describe("Chat's own loop reaching a model through the door", () => {
  const KEY = "synthetic-provider-key-0001";
  const ADDRESS_MODEL = "synthetic-local";
  const RESTING = { ...FAKE_OFFER, model: "fake-resting", name: "Fake resting", ready: false };

  interface Heard { path: string; headers: IncomingMessage["headers"]; body: Record<string, unknown>; ended: boolean }

  async function provider() {
    const heard: Heard[] = [];
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const server: Server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
      if (request.method === "GET" && request.url === "/address/v1/models") {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: ADDRESS_MODEL, object: "model" }] }));
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const each: Heard = { path: request.url ?? "", headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>, ended: false };
        heard.push(each);
        response.on("close", () => { each.ended = true; });
        const said = JSON.stringify(each.body.messages);
        if (said.includes("echo")) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "a synthetic failure", headers: request.headers } }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "first words" } }] })}\n\n`);
        if (said.includes("hang")) return;
        void gate.then(() => {
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "last words" } }] })}\n\n`);
          response.end("data: [DONE]\n\n");
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, heard, open };
  }

  async function chatHome() {
    const upstream = await provider();
    const root = makeRoot("lifestream-door-chat-", {
      sources: {},
      settings: {
        "model.transports.address": { url: `${upstream.url}/address/v1`, input: ["text"] },
        "model.transports.fake": { delay_ms: 0, models: [FAKE_OFFER, RESTING], reach: { url: `${upstream.url}/fake/chat/completions`, effort: "reasoning", key: KEY } },
      },
    });
    const logs: string[] = [];
    const door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, {
      lookMs: LOOK_MS, log: (line) => logs.push(line), floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" }, registry: FAKES, connectors: fakeDeclarations(),
    });
    editSettings(root, { "door.port": door.port });
    const home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, slot: null, log: () => undefined });
    onTestFinished(async () => {
      await door.close();
      await home.stop();
      removeRoot(root);
    });
    await until("the home read the fake's and the address's models", () => {
      const stored = readHome(root, (db) => String(db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(MODELS_META) ?? ""));
      return stored.includes(`"id":"${FAKE_ROUTE}"`) && stored.includes(`"id":"address:${ADDRESS_MODEL}"`);
    });
    const ask = readFileSync(join(machine().dir, "ask", "door-token"), "utf8").trim();
    const reader = mintPrincipal(openHomeFolder(root), { unit: "reader", scopes: ["read"], now_ms: Date.now() }).token;
    const url = `http://127.0.0.1:${door.port}`;
    const chat = (body: Record<string, unknown>, token = ask, signal?: AbortSignal) => fetch(`${url}/v1/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }),
    });
    const keyRead = () => fetch(`${url}/v1/secrets/openrouter`, { headers: { authorization: `Bearer ${ask}` } });
    return { upstream, logs, chat, reader, keyRead };
  }

  const asked = (model: string, words: string, more: Record<string, unknown> = {}) => ({ model, stream: true, messages: [{ role: "user", content: words }], ...more });

  it("relays an address's model and one whose reach reads OpenRouter's dialect, each streamed as it comes, the thinking level in the provider's own member", async () => {
    const { upstream, chat } = await chatHome();
    const local = await chat(asked(`address:${ADDRESS_MODEL}`, "a synthetic question", { reasoning_effort: "high" }));
    expect([local.status, local.headers.get("content-type")]).toEqual([200, "text/event-stream"]);
    const reader = local.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first, "the first words arrive before the provider sends the rest").toContain("first words");
    upstream.open();
    let rest = "";
    for (let part = await reader.read(); !part.done; part = await reader.read()) rest += new TextDecoder().decode(part.value);
    expect(rest).toContain("last words");
    expect(rest).toContain("[DONE]");
    const cloud = await chat(asked(FAKE_ROUTE, "another synthetic question", { reasoning_effort: "low" }));
    expect([cloud.status, (await cloud.text()).includes("last words")]).toEqual([200, true]);
    expect(upstream.heard.map(({ path, headers, body }) => ({ path, authorization: headers.authorization ?? null, body }))).toEqual([
      { path: "/address/v1/chat/completions", authorization: null, body: asked(ADDRESS_MODEL, "a synthetic question", { reasoning_effort: "high" }) },
      { path: "/fake/chat/completions", authorization: `Bearer ${KEY}`, body: asked("fake-model", "another synthetic question", { reasoning: { effort: "low" } }) },
    ]);
    report["Chat's relay"] = { heard: upstream.heard.map(({ path, body }) => ({ path, body })) };
  });

  it("refuses an id no connection lists, a model not ready with its line, a body naming none, and every pass but Ask's own, asking no provider", async () => {
    const { upstream, chat, reader } = await chatHome();
    const said = async (response: Response) => [response.status, ((await response.json()) as { code: string }).code];
    const resting = await chat(asked(`fake:${RESTING.model}`, "a synthetic question"));
    expect([resting.status, await resting.json()]).toEqual([409, { code: "NOT_READY", message: "Fake resting isn't ready", line: "Fake resting isn't ready" }]);
    expect(await said(await chat(asked("fake:no-such-model", "a synthetic question")))).toEqual([404, "NO_MODEL"]);
    expect(await said(await chat(asked("no-such-model", "a synthetic question")))).toEqual([404, "NO_MODEL"]);
    expect(await said(await chat({ messages: [] }))).toEqual([422, "BAD_REQUEST"]);
    expect(await said(await chat(asked(FAKE_ROUTE, "a synthetic question"), reader))).toEqual([403, "PRINCIPAL_SCOPE"]);
    expect(upstream.heard).toEqual([]);
  });

  it("hides the key in a provider's error that echoes it, passed on with the provider's status, and logs no key; no route hands Chat a key", async () => {
    const { chat, logs, keyRead } = await chatHome();
    expect((await keyRead()).status).toBe(404);
    const failed = await chat(asked(FAKE_ROUTE, "echo the headers"));
    const text = await failed.text();
    expect(failed.status).toBe(500);
    expect(text).toContain(HIDDEN);
    expect(text).not.toContain(KEY);
    expect(logs.join("\n")).not.toContain(KEY);
    expect(logs.some((line) => line.includes(`"path":"/v1/chat/completions"`))).toBe(true);
  });

  it("ends the provider's request when the caller leaves the stream", async () => {
    const { upstream, chat } = await chatHome();
    const leaving = new AbortController();
    const answer = await chat(asked(FAKE_ROUTE, "hang after the first words"), undefined, leaving.signal);
    const first = await answer.body!.getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain("first words");
    expect(upstream.heard.map((each) => each.ended)).toEqual([false]);
    leaving.abort();
    await until("the provider saw its request end", () => upstream.heard[0]!.ended);
  });
});
