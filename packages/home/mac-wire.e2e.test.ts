import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { KEEP_BYTES, openHomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import { BUNDLE_FILES } from "./bundle.js";
import { serveDoor, type DoorOptions } from "./door.js";
import { acquisitionBundle, basic, DEVICE, makeHome, NOW_MS, PHONE_SOURCE, PHONE_UNIT, REPO, sha256, type Home } from "./test/support.js";
import { editSettings } from "./test/folder.js";
import { freeSpace, LOOK_MS, until } from "./test/harness-root.js";


const MAC = "macbook-pro-0001";
const MACHINE = `machine:local:${MAC}`;
const CALLS = `apple-calls:person-a@example.com:${MAC}`;
const OTHER = "machine:local:macbook-pro-0002";
const HELD = "/v1/blobs/held";
const report: Record<string, unknown> = {};

afterAll(() => {
  const directory = join(REPO, "packages", "home", ".build", "e2e");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "mac-wire.json"), `${JSON.stringify(report, null, 2)}\n`);
});

function home(): Home {
  const at = makeHome({
    mac: { kind: "mac", scopes: ["deliver"], sources: [MACHINE, CALLS] },
    phone: { kind: "phone", scopes: ["deliver"], sources: [PHONE_SOURCE], unit: PHONE_UNIT },
    reader: { scopes: ["read"] },
  }, []);
  onTestFinished(() => rmSync(at.root, { recursive: true, force: true }));
  return at;
}

async function watched(at: Home, settings: { max_bundle_bytes?: number } = {}, more: DoorOptions = {}): Promise<{ url: string; puts: () => Record<string, unknown>[] }> {
  const logs: string[] = [];
  let tick = 0;
  const door = await serveDoor(at.root, { port: 0, max_bundle_bytes: 8 * 1024 ** 3, ...settings },
    { lookMs: LOOK_MS, log: (line) => logs.push(line), clock: () => NOW_MS + tick++, floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" }, ...more });
  onTestFinished(() => door.close());
  return {
    url: `http://127.0.0.1:${door.port}`,
    puts: () => logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.method === "PUT"),
  };
}

async function serve(at: Home, settings: { max_bundle_bytes?: number } = {}): Promise<string> {
  return (await watched(at, settings)).url;
}

function stalled(bytes: Buffer): ReadableStream<Uint8Array> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  onTestFinished(() => release());
  let sent = false;
  return new ReadableStream({
    async pull(controller) {
      if (!sent) { controller.enqueue(bytes.subarray(0, 10)); sent = true; return; }
      await gate;
      controller.close();
    },
  });
}

const auth = (at: Home, who: string): Record<string, string> => ({
  authorization: `Bearer ${at.tokens[who]}`, ...(who === "mac" ? DEVICE.mac : who === "phone" ? DEVICE.phone : {}),
});

async function put(url: string, path: string, headers: Record<string, string>, body: Buffer): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}${path}`, { method: "PUT", headers, body });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function post(url: string, path: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function putUnread(url: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${url}${path}`, { method: "PUT", headers }, (response) => {
      let text = "";
      response.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
      response.on("end", () => {
        request.destroy();
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> });
      });
    });
    request.on("error", reject);
    request.flushHeaders();
  });
}

const gzipped = (bytes: Buffer, unpacked = bytes.length): Record<string, string> => ({ "content-encoding": "gzip", "lifestream-uncompressed-length": String(unpacked) });

const mac = (n: number, extra: Partial<Parameters<typeof acquisitionBundle>[0]> = {}) => acquisitionBundle({
  source: MACHINE, fetched_ms: NOW_MS + n * 60_000, files: [[`${String(n).padStart(4, "0")}.jsonl`, Buffer.from(`{"synthetic":${n}}\n`)]],
  custody: { [MACHINE]: { seal: n + 1 } }, ...extra,
});

const staging = (n: number, staged: readonly string[], extra: Partial<Parameters<typeof acquisitionBundle>[0]> = {}) => mac(n, {
  ...extra,
  manifest: (manifest) => ({ ...manifest, facts: { ...manifest.facts as JsonObject, blobs_carried: (extra.blobs?.length ?? 0) + staged.length }, staged_blobs: staged }),
});

const nameOf = (bytes: Buffer): string => `sha256:${sha256(bytes)}`;
const sealedNames = (at: Home) => {
  const directory = join(at.root, "inbox", MACHINE);
  return existsSync(directory) ? readdirSync(directory).filter((name) => name !== "blobs" && existsSync(join(directory, name, "manifest.json"))).sort() : [];
};
const inLane = (at: Home, bytes: Buffer): boolean => existsSync(join(at.root, "inbox", MACHINE, "blobs", sha256(bytes)));
const leftovers = (at: Home) => readdirSync(join(at.root, "door", "uploads"));
const factsOf = (at: Home, n: number) => (JSON.parse(readFileSync(join(at.root, "inbox", MACHINE, basic(NOW_MS + n * 60_000), "manifest.json"), "utf8")) as { facts: JsonObject; staged_blobs?: string[] });
const stage = (url: string, at: Home, bytes: Buffer, headers: Record<string, string> = {}) =>
  put(url, `/v1/files/${nameOf(bytes)}`, { ...auth(at, "mac"), "lifestream-source": MACHINE, "lifestream-kind": "new", ...headers }, bytes);

describe("a Mac bundle sent as gzip", () => {
  it("seals as the ZIP it unpacks to, its file and blob as a plain bundle's; a plain bundle and one stated identity still seal", async () => {
    const at = home();
    const url = await serve(at);
    const blob = Buffer.from("synthetic machine blob bytes, sent packed");
    const packed = mac(0, { blobs: [blob], files: [["0000.jsonl", Buffer.from(`${'{"synthetic":0}\n'.repeat(2_000)}`)]] });
    const wire = gzipSync(packed.bytes);
    expect(wire.length).toBeLessThan(packed.bytes.length / 10);
    const first = await put(url, packed.path, { ...auth(at, "mac"), ...gzipped(packed.bytes) }, wire);
    expect(first.status).toBe(201);
    expect(readFileSync(join(at.root, "inbox", MACHINE, basic(NOW_MS), "0000.jsonl"), "utf8")).toBe('{"synthetic":0}\n'.repeat(2_000));
    expect(readFileSync(join(at.root, "inbox", MACHINE, "blobs", sha256(blob)))).toEqual(blob);
    expect((await put(url, packed.path, { ...auth(at, "mac"), ...gzipped(packed.bytes) }, wire)).status).toBe(200);
    const plain = mac(1);
    expect((await put(url, plain.path, auth(at, "mac"), plain.bytes)).status).toBe(201);
    const identity = mac(2);
    expect((await put(url, identity.path, { ...auth(at, "mac"), "content-encoding": "identity" }, identity.bytes)).status).toBe(201);
    expect([sealedNames(at).length, leftovers(at)]).toEqual([3, []]);
    report.gzip = { wire: wire.length, unpacked: packed.bytes.length };
  });

  it("refuses one stating no length unpacked, one not a whole number from 1, one past the door's bound, and an encoding the door does not read, before a byte is read", async () => {
    const at = home();
    const url = await serve(at, { max_bundle_bytes: 100_000 });
    const bundle = mac(0);
    const wire = gzipSync(bundle.bytes);
    const length = { "content-length": String(wire.length) };
    const answers = {
      none: await putUnread(url, bundle.path, { ...auth(at, "mac"), ...length, "content-encoding": "gzip" }),
      zero: await putUnread(url, bundle.path, { ...auth(at, "mac"), ...length, ...gzipped(bundle.bytes, 0) }),
      words: await putUnread(url, bundle.path, { ...auth(at, "mac"), ...length, "content-encoding": "gzip", "lifestream-uncompressed-length": "ten" }),
      large: await putUnread(url, bundle.path, { ...auth(at, "mac"), ...length, ...gzipped(bundle.bytes, 100_001) }),
      brotli: await putUnread(url, bundle.path, { ...auth(at, "mac"), ...length, "content-encoding": "br", "lifestream-uncompressed-length": String(bundle.bytes.length) }),
      twice: await putUnread(url, bundle.path, { ...auth(at, "mac"), ...length, "content-encoding": "gzip, gzip", "lifestream-uncompressed-length": String(bundle.bytes.length) }),
    };
    expect(Object.fromEntries(Object.entries(answers).map(([what, answer]) => [what, [answer.status, answer.body.code]]))).toEqual({
      none: [422, "UPLOAD_HEADERS"], zero: [422, "UPLOAD_HEADERS"], words: [422, "UPLOAD_HEADERS"], large: [413, "BUNDLE_TOO_LARGE"],
      brotli: [415, "BUNDLE_ENCODING"], twice: [415, "BUNDLE_ENCODING"],
    });
    expect([sealedNames(at), leftovers(at)]).toEqual([[], []]);
    report.gzip_headers = Object.fromEntries(Object.entries(answers).map(([what, answer]) => [what, answer.body]));
  });

  it("refuses one that unpacks past its stated length 413, one short of it, cut, or no gzip 422, nothing sealed or left; the bundle then seals", async () => {
    const at = home();
    const url = await serve(at);
    const bundle = mac(0);
    const wire = gzipSync(bundle.bytes);
    const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024));
    const answers = {
      bomb: await put(url, bundle.path, { ...auth(at, "mac"), ...gzipped(bundle.bytes) }, bomb),
      past: await put(url, bundle.path, { ...auth(at, "mac"), ...gzipped(bundle.bytes, bundle.bytes.length - 1) }, wire),
      short: await put(url, bundle.path, { ...auth(at, "mac"), ...gzipped(bundle.bytes, bundle.bytes.length + 1) }, wire),
      cut: await put(url, bundle.path, { ...auth(at, "mac"), ...gzipped(bundle.bytes) }, wire.subarray(0, wire.length - 8)),
      plain: await put(url, bundle.path, { ...auth(at, "mac"), ...gzipped(bundle.bytes) }, bundle.bytes),
      junk: await put(url, bundle.path, { ...auth(at, "mac"), ...gzipped(bundle.bytes) }, Buffer.concat([wire.subarray(0, 10), Buffer.alloc(200, 0xff)])),
    };
    expect(Object.fromEntries(Object.entries(answers).map(([what, answer]) => [what, [answer.status, answer.body.code]]))).toEqual({
      bomb: [413, "BUNDLE_TOO_LARGE"], past: [413, "BUNDLE_TOO_LARGE"], short: [422, "BUNDLE_ENCODING"], cut: [422, "BUNDLE_ENCODING"],
      plain: [422, "BUNDLE_ENCODING"], junk: [422, "BUNDLE_ENCODING"],
    });
    expect([sealedNames(at), leftovers(at)]).toEqual([[], []]);
    expect((await put(url, bundle.path, { ...auth(at, "mac"), ...gzipped(bundle.bytes) }, wire)).status).toBe(201);
    report.gzip_refusals = Object.fromEntries(Object.entries(answers).map(([what, answer]) => [what, answer.body]));
  });

  it("counts its length unpacked twice for room, never its length on the wire", async () => {
    const at = home();
    const bundle = mac(0, { files: [["0000.jsonl", Buffer.alloc(1024 * 1024, 0x20)]] });
    const wire = gzipSync(bundle.bytes);
    const free = freeSpace(KEEP_BYTES + 2 * wire.length + 1_000);
    const url = await serve(at);
    const headers = { ...auth(at, "mac"), "content-length": String(wire.length), ...gzipped(bundle.bytes) };
    expect(await putUnread(url, bundle.path, headers)).toMatchObject({ status: 503, body: { code: "DISK_LOW" } });
    free.set(KEEP_BYTES + 2 * bundle.bytes.length);
    expect((await put(url, bundle.path, { ...auth(at, "mac"), ...gzipped(bundle.bytes) }, wire)).status).toBe(201);
    report.gzip_room = { wire: wire.length, unpacked: bundle.bytes.length };
  });
});

describe("a Mac bundle sent as gzip, its body refused or lost", () => {
  it("answers 413 whole to one that unpacks past its stated length partway through a large body, the rest of it read, nothing left; it then seals", async () => {
    const at = home();
    const url = await serve(at);
    const bundle = mac(0, { files: [["0000.jsonl", randomBytes(4 * 1024 * 1024)]] });
    const wire = gzipSync(bundle.bytes);
    expect(wire.length).toBeGreaterThan(4 * 1024 * 1024);
    const refused = await put(url, bundle.path, { ...auth(at, "mac"), ...gzipped(bundle.bytes, 1024 * 1024) }, wire);
    expect([refused.status, refused.body.code]).toEqual([413, "BUNDLE_TOO_LARGE"]);
    expect([sealedNames(at), leftovers(at)]).toEqual([[], []]);
    expect((await put(url, bundle.path, { ...auth(at, "mac"), ...gzipped(bundle.bytes) }, wire)).status).toBe(201);
    report.gzip_refused_midway = { wire: wire.length, answer: refused.body };
  });

  it("lets go of one whose body goes silent 503 NOT_NOW, its partial removed; the next send of it seals", async () => {
    const at = home();
    const { url, puts } = await watched(at, {}, { silentMs: 60 });
    const bundle = mac(0);
    const wire = gzipSync(bundle.bytes);
    let ended: number | "no answer" | undefined;
    void fetch(`${url}${bundle.path}`, {
      method: "PUT", headers: { ...auth(at, "mac"), ...gzipped(bundle.bytes), "content-length": String(wire.length) }, body: stalled(wire), duplex: "half",
    } as RequestInit).then((answer) => { ended = answer.status; }, () => { ended = "no answer"; });
    await until("the door lets the silent upload go", () => puts().length > 0);
    expect(puts()).toMatchObject([{ status: 503, code: "NOT_NOW" }]);
    await until("the silent request ends", () => ended !== undefined);
    expect([ended, leftovers(at)]).toEqual(["no answer", []]);
    expect((await put(url, bundle.path, { ...auth(at, "mac"), ...gzipped(bundle.bytes) }, wire)).status).toBe(201);
    report.gzip_silent = puts()[0];
  });

  it("answers one whose connection is cut short of its length as a plain one cut, never 422, nothing left", async () => {
    const at = home();
    const { url, puts } = await watched(at);
    const bundle = mac(0, { files: [["0000.jsonl", randomBytes(256 * 1024)]] });
    const wire = gzipSync(bundle.bytes);
    await cutAfter(url, bundle.path, auth(at, "mac"), bundle.bytes.length, bundle.bytes.subarray(0, 100_000));
    await until("the plain cut upload logged", () => puts().length === 1);
    await cutAfter(url, bundle.path, { ...auth(at, "mac"), ...gzipped(bundle.bytes) }, wire.length, wire.subarray(0, 100_000));
    await until("the gzip cut upload logged", () => puts().length === 2);
    const [plain, packed] = puts() as [Record<string, unknown>, Record<string, unknown>];
    expect(packed.status).not.toBe(422);
    expect(packed.status).toBe(plain.status);
    expect([sealedNames(at), leftovers(at)]).toEqual([[], []]);
    report.gzip_cut = { plain, packed };
  });

  it("refuses one stating no Content-Length 411 and one stating 0 422 BUNDLE_ENCODING, nothing left", async () => {
    const at = home();
    const url = await serve(at);
    const bundle = mac(0);
    const answers = {
      unstated: await putUnread(url, bundle.path, { ...auth(at, "mac"), ...gzipped(bundle.bytes), "transfer-encoding": "chunked" }),
      empty: await put(url, bundle.path, { ...auth(at, "mac"), ...gzipped(bundle.bytes) }, Buffer.alloc(0)),
    };
    expect(Object.fromEntries(Object.entries(answers).map(([what, answer]) => [what, [answer.status, answer.body.code]]))).toEqual({
      unstated: [411, "LENGTH_REQUIRED"], empty: [422, "BUNDLE_ENCODING"],
    });
    expect([sealedNames(at), leftovers(at)]).toEqual([[], []]);
  });

  it("logs the bytes that came on the wire, not the bytes they unpack to", async () => {
    const at = home();
    const { url, puts } = await watched(at);
    const bundle = mac(0, { files: [["0000.jsonl", Buffer.from('{"synthetic":0}\n'.repeat(2_000))]] });
    const wire = gzipSync(bundle.bytes);
    expect((await put(url, bundle.path, { ...auth(at, "mac"), ...gzipped(bundle.bytes) }, wire)).status).toBe(201);
    expect(puts()).toMatchObject([{ status: 201, bytes: wire.length }]);
    expect(wire.length).toBeLessThan(bundle.bytes.length);
  });
});

describe("a Mac's file sent on its own", () => {
  it("is staged for a source the Mac delivers, from the byte the door holds; held answers it staged, then held whole", async () => {
    const at = home();
    const url = await serve(at);
    const bytes = randomBytes(64 * 1024), name = nameOf(bytes);
    const wrong = await put(url, `/v1/files/${name}`, { ...auth(at, "mac"), "lifestream-source": MACHINE, "upload-offset": "10" }, bytes.subarray(10));
    expect([wrong.status, wrong.body.code, wrong.body.held]).toEqual([409, "UPLOAD_OFFSET", 0]);
    expect(await stage(url, at, bytes)).toMatchObject({ status: 201, body: { file: name } });
    expect((await post(url, HELD, auth(at, "mac"), { blobs: [name] })).body).toEqual({ held: [], staged: [name], partly: {} });
    expect(await stage(url, at, bytes)).toMatchObject({ status: 200, body: { file: name, held: true } });
    report.mac_file = wrong.body;
  });

  it("goes on from the byte the door holds of a file it took a part of", async () => {
    const at = home();
    const url = await serve(at);
    const bytes = randomBytes(64 * 1024), name = nameOf(bytes);
    await cutAfter(url, `/v1/files/${name}`, { ...auth(at, "mac"), "lifestream-source": MACHINE }, bytes.length, bytes.subarray(0, 40_000));
    const partly = async () => (await post(url, HELD, auth(at, "mac"), { blobs: [name] })).body;
    await until("the cut part held", async () => ((await partly()).partly as Record<string, number>)[name] === 40_000);
    expect(await partly()).toEqual({ held: [], staged: [], partly: { [name]: 40_000 } });
    const rest = bytes.subarray(40_000);
    expect(await put(url, `/v1/files/${name}`, { ...auth(at, "mac"), "lifestream-source": MACHINE, "upload-offset": "40000" }, rest)).toMatchObject({ status: 201, body: { file: name } });
    expect((await post(url, HELD, auth(at, "mac"), { blobs: [name] })).body).toEqual({ held: [], staged: [name], partly: {} });
  });

  it("refuses a Mac's file naming no source or no source's id 422, one for a source its pass does not deliver or one turned off 403, and a reader's 403", async () => {
    const at = home();
    const url = await serve(at);
    const bytes = Buffer.from("synthetic file for a source"), path = `/v1/files/${nameOf(bytes)}`;
    const length = { "content-length": String(bytes.length) };
    editSettings(at.root, { "sources.off": [CALLS] });
    const answers = {
      none: await putUnread(url, path, { ...auth(at, "mac"), ...length }),
      bad: await putUnread(url, path, { ...auth(at, "mac"), ...length, "lifestream-source": "../machine" }),
      other: await putUnread(url, path, { ...auth(at, "mac"), ...length, "lifestream-source": OTHER }),
      off: await putUnread(url, path, { ...auth(at, "mac"), ...length, "lifestream-source": CALLS }),
      reader: await putUnread(url, path, { ...auth(at, "reader"), ...length, "lifestream-source": MACHINE }),
    };
    expect(Object.fromEntries(Object.entries(answers).map(([what, answer]) => [what, [answer.status, answer.body.code]]))).toEqual({
      none: [422, "UPLOAD_HEADERS"], bad: [422, "UPLOAD_HEADERS"], other: [403, "PRINCIPAL_SCOPE"], off: [403, "PRINCIPAL_SCOPE"], reader: [403, "PRINCIPAL_SCOPE"],
    });
    expect(answers.off.body.message).toContain("turned off");
    expect((await post(url, HELD, auth(at, "mac"), { blobs: [nameOf(bytes)] })).body).toEqual({ held: [], staged: [], partly: {} });
    report.mac_file_refusals = Object.fromEntries(Object.entries(answers).map(([what, answer]) => [what, answer.body]));
  });
});

describe("a Mac bundle naming staged blobs", () => {
  it("seals with each staged blob linked into its lane, the stage's copy gone and blobs_carried counting both; sent as gzip too", async () => {
    const at = home();
    const url = await serve(at);
    const [inline, staged] = [Buffer.from("synthetic blob carried in the zip"), randomBytes(300 * 1024)];
    expect((await stage(url, at, staged)).status).toBe(201);
    const bundle = staging(0, [nameOf(staged)], { blobs: [inline] });
    const wire = gzipSync(bundle.bytes);
    expect((await put(url, bundle.path, { ...auth(at, "mac"), ...gzipped(bundle.bytes) }, wire)).status).toBe(201);
    expect([readFileSync(join(at.root, "inbox", MACHINE, "blobs", sha256(staged))), readFileSync(join(at.root, "inbox", MACHINE, "blobs", sha256(inline)))]).toEqual([staged, inline]);
    expect((await post(url, HELD, auth(at, "mac"), { blobs: [nameOf(staged)] })).body).toEqual({ held: [], staged: [], partly: {} });
    const sealed = factsOf(at, 0);
    expect([sealed.facts.blobs_carried, sealed.staged_blobs]).toEqual([2, [nameOf(staged)]]);
    report.staged = sealed;
  });

  it("refuses one naming a blob neither staged nor held 409 FILES_MISSING, naming only those, every link undone and the staged copy kept; sealed once it is sent", async () => {
    const at = home();
    const url = await serve(at);
    const [sent, unsent] = [Buffer.from("synthetic blob staged before the bundle"), Buffer.from("synthetic blob not yet staged")];
    expect((await stage(url, at, sent)).status).toBe(201);
    const bundle = staging(0, [nameOf(sent), nameOf(unsent)]);
    const missing = await put(url, bundle.path, auth(at, "mac"), bundle.bytes);
    expect(missing).toMatchObject({ status: 409, body: { code: "FILES_MISSING", message: BUNDLE_FILES, missing: { files: [nameOf(unsent)] } } });
    expect([inLane(at, sent), inLane(at, unsent), sealedNames(at), leftovers(at)]).toEqual([false, false, [], []]);
    expect((await post(url, HELD, auth(at, "mac"), { blobs: [nameOf(sent), nameOf(unsent)] })).body).toEqual({ held: [], staged: [nameOf(sent)], partly: {} });
    expect((await stage(url, at, unsent)).status).toBe(201);
    expect((await put(url, bundle.path, auth(at, "mac"), bundle.bytes)).status).toBe(201);
    expect([inLane(at, sent), inLane(at, unsent), sealedNames(at)]).toEqual([true, true, [basic(NOW_MS)]]);
    expect((await post(url, HELD, auth(at, "mac"), { blobs: [nameOf(sent), nameOf(unsent)] })).body).toEqual({ held: [], staged: [], partly: {} });
    report.files_missing = missing.body;
  });

  it("undoes the lane's links of a bundle refused after they were made, the staged copy kept for the next", async () => {
    const at = home();
    const url = await serve(at);
    const staged = Buffer.from("synthetic blob staged for a bundle that does not hash");
    expect((await stage(url, at, staged)).status).toBe(201);
    const wrong = mac(0, {
      manifest: (manifest) => ({ ...manifest, facts: { ...manifest.facts as JsonObject, blobs_carried: 1 }, staged_blobs: [nameOf(staged)],
        files: (manifest.files as JsonObject[]).map((file) => ({ ...file, sha256: "0".repeat(64) })) }),
    });
    expect(await put(url, wrong.path, auth(at, "mac"), wrong.bytes)).toMatchObject({ status: 422, body: { code: "ACQUISITION_HASH_MISMATCH" } });
    expect([inLane(at, staged), sealedNames(at)]).toEqual([false, []]);
    expect((await post(url, HELD, auth(at, "mac"), { blobs: [nameOf(staged)] })).body).toEqual({ held: [], staged: [nameOf(staged)], partly: {} });
    const right = staging(0, [nameOf(staged)]);
    expect((await put(url, right.path, auth(at, "mac"), right.bytes)).status).toBe(201);
    expect(inLane(at, staged)).toBe(true);
  });

  it("takes a staged blob its lane or the home's blobs hold already with nothing staged", async () => {
    const at = home();
    const url = await serve(at);
    const [lane, homes] = [Buffer.from("synthetic blob the lane holds"), Buffer.from("synthetic blob the home holds")];
    const carrying = mac(0, { blobs: [lane] });
    expect((await put(url, carrying.path, auth(at, "mac"), carrying.bytes)).status).toBe(201);
    openHomeFolder(at.root).blobs(join(at.root, "blobs")).put(homes);
    const bundle = staging(1, [nameOf(lane), nameOf(homes)]);
    expect((await put(url, bundle.path, auth(at, "mac"), bundle.bytes)).status).toBe(201);
    expect([inLane(at, lane), inLane(at, homes), factsOf(at, 1).facts.blobs_carried]).toEqual([true, false, 2]);
  });

  it("refuses one whose staged blob is also a member, whose blobs_carried counts no staged blob, or whose lane holds no file at a staged name", async () => {
    const at = home();
    const url = await serve(at);
    const blob = Buffer.from("synthetic blob both carried and staged");
    const both = staging(0, [nameOf(blob)], { blobs: [blob] });
    const uncounted = mac(0, { manifest: (manifest) => ({ ...manifest, staged_blobs: [nameOf(blob)] }) });
    const answers = {
      both: await put(url, both.path, auth(at, "mac"), both.bytes),
      uncounted: await put(url, uncounted.path, auth(at, "mac"), uncounted.bytes),
    };
    mkdirSync(join(at.root, "inbox", MACHINE, "blobs", sha256(blob)), { recursive: true });
    const other = staging(0, [nameOf(blob)]);
    const answered = { ...answers, other: await put(url, other.path, auth(at, "mac"), other.bytes) };
    expect(Object.fromEntries(Object.entries(answered).map(([what, answer]) => [what, [answer.status, answer.body.code]]))).toEqual({
      both: [422, "ACQUISITION_MANIFEST"], uncounted: [422, "ACQUISITION_MANIFEST"], other: [422, "ACQUISITION_BLOB_MISMATCH"],
    });
    expect([sealedNames(at), leftovers(at)]).toEqual([[], []]);
    report.staged_refusals = Object.fromEntries(Object.entries(answered).map(([what, answer]) => [what, answer.body]));
  });
});

describe("an owner's statements naming staged blobs", () => {
  it("are refused 422 ACQUISITION_MANIFEST, nothing sealed; the same statements naming none seal", async () => {
    const places = "google-maps:person-a@example.com:lookup";
    const at = makeHome({ desk: { scopes: ["deliver"], sources: [places] } }, []);
    onTestFinished(() => rmSync(at.root, { recursive: true, force: true }));
    editSettings(at.root, { unit: MAC });
    const url = await serve(at);
    const line = JSON.stringify({ kind: "place", key: "google:synthetic-gym", content: { type: "google.place", id: "synthetic-gym", name: "Synthetic Gym", centre: { latitude: 0, longitude: 0 } } });
    const blob = Buffer.from("synthetic blob an owner's statements name staged");
    const statements = (staged: readonly string[]) => acquisitionBundle({
      source: places, feeder: "owner-statements", fetched_ms: NOW_MS - 60_000, files: [["statements.ndjson", Buffer.from(`${line}\n`)]],
      manifest: (manifest) => ({ ...manifest, facts: { statements: 1, blobs_carried: staged.length }, ...(staged.length === 0 ? {} : { staged_blobs: staged }) }),
    });
    const desk = { authorization: `Bearer ${at.tokens.desk}` };
    const naming = statements([nameOf(blob)]);
    const refused = await put(url, naming.path, desk, naming.bytes);
    expect([refused.status, refused.body.code]).toEqual([422, "ACQUISITION_MANIFEST"]);
    expect(leftovers(at)).toEqual([]);
    const plain = statements([]);
    expect(plain.path).toBe(naming.path);
    expect((await put(url, plain.path, desk, plain.bytes)).status).toBe(201);
    report.owner_staged = refused.body;
  });
});

function cutAfter(url: string, path: string, headers: Record<string, string>, length: number, bytes: Buffer): Promise<void> {
  const socket = createConnection({ host: "127.0.0.1", port: Number(new URL(url).port) });
  socket.on("error", () => undefined);
  socket.resume();
  const lines = Object.entries({ ...headers, "content-length": String(length) }).map(([name, value]) => `${name}: ${value}\r\n`).join("");
  socket.write(`PUT ${path} HTTP/1.1\r\nHost: ${new URL(url).host}\r\n${lines}\r\n`);
  socket.end(bytes);
  return new Promise((resolve) => socket.once("close", () => resolve()));
}
