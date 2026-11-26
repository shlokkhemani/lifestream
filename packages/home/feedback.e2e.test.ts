import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { openHomeFolder, type JsonObject, type Keys } from "@lifestreamprotocol/core";
import type { Added } from "./agents.js";
import { READER_HEADER } from "./call.js";
import { serveDoor } from "./door.js";
import { REPORT_FILE, SHOT_BYTES, TEXT_MAX, type Report } from "./feedback.js";
import { startHome, type Home } from "./home.js";
import { adopt, readHome } from "./lifecycle.js";
import { machine } from "./machine.js";
import { FEEDBACK_WORDS, REPORT_WORDS } from "./page-feedback.js";
import { peopleFileOf } from "./people.js";
import { PEOPLE, writePrepared } from "./prepared.js";
import { mintPrincipal } from "./principals.js";
import { askHome } from "./socket.js";
import { draftRecovery, readHandoff, Vault } from "./vault.js";
import { editSettings, TEST_UNIT, testSocket } from "./test/folder.js";
import { fakeWorker } from "./test/feedback-worker.js";
import { clientFixture, FAKES, LOOK_MS, TICK_MS, until } from "./test/harness-root.js";
import { acquisitionBundle, DEVICE, makeHome, NOW_MS, PHONE_UNIT } from "./test/support.js";

const ROUTES = ["draft", "screenshot", "send"] as const;
const MAC_UNIT = "macbook-pro-0001";
const CHAT = "1790000000000-abcdef";
const FLOORS = { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" };
const FIXTURE_DAY = "2026-09-08";
const FIXTURE_APP = "Home: 1 (0000000000ab)\niPhone app: 1.0.0, iOS not stated\n";
const ASK_REGISTRY = new URL("./test/ask-registry.ts", import.meta.url);
const ASK = `ask:local:${TEST_UNIT}`;
const asked = (chat: string, n: number) => `${chat}:${String(n).padStart(4, "0")}`;
const temps: string[] = [];

afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Answer { status: number; body: JsonObject }

function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR"), header, Buffer.alloc(4)]);
}

function postUnread(url: string, path: string, headers: Record<string, string>): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const framing = headers["content-length"] === undefined ? { "transfer-encoding": "chunked" } : {};
    const request = httpRequest(`${url}${path}`, { method: "POST", headers: { ...headers, ...framing } }, (response) => {
      let text = "";
      response.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
      response.on("end", () => {
        request.destroy();
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as JsonObject });
      });
    });
    request.on("error", reject);
    request.flushHeaders();
  });
}

function chatTurn(made_ms: number, answer: string): { path: string; bytes: Buffer } {
  const lines = [
    { kind: "chat", key: CHAT, content: { type: "ask.chat", title: "Synthetic", at_ms: made_ms } },
    { kind: "msg", key: asked(CHAT, 1), content: { type: "ask.msg", chat: CHAT, n: 1, at_ms: made_ms, role: "user", text: "Who rang me?" } },
    { kind: "msg", key: asked(CHAT, 2), content: { type: "ask.msg", chat: CHAT, n: 2, at_ms: made_ms + 1, role: "assistant", text: answer, end: "done" } },
  ];
  const text = Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  return acquisitionBundle({
    source: ASK, feeder: "owner-statements", fetched_ms: made_ms, files: [["statements.ndjson", text]],
    manifest: (manifest) => ({ ...manifest, facts: { statements: lines.length, blobs_carried: 0 } }),
  });
}

async function running(options: { keyed?: boolean; registry?: string | URL } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lifestream-feedback-machine-")));
  temps.push(dir);
  const root = join(dir, "the-home");
  writeFileSync(join(dir, "machine.json"), JSON.stringify({ dnssd: join(dir, "no-dns-sd"), bonjour: "127.0.0.1", unit: TEST_UNIT }));
  const at = machine({ env: { LIFESTREAM_MACHINE_DIR: dir } });
  const slot = options.keyed === true ? randomBytes(32) : null;
  const keyed = slot === null ? undefined : readHandoff(JSON.stringify({ home_id: randomUUID(), slot_key: slot.toString("hex"), recovery: draftRecovery(1).recovery }));
  await adopt(root, { machine: at, now: () => NOW_MS, ...(keyed === undefined ? {} : { keyed, fileSystem: () => "apfs" as const, platform: "darwin" as const }) });
  let keys: Keys | undefined;
  if (slot !== null) {
    const vault = new Vault({ root, machine: at.dir, home: readHome(root).id });
    expect(vault.start({ key: slot, why: null }, NOW_MS)).toBeNull();
    keys = vault.keys!;
  }
  const folder = openHomeFolder(root, { machine: at.dir, program: "home", ...(keys === undefined ? {} : { keys }) });
  const pass = () => randomBytes(32).toString("base64url");
  const passes = { reader: pass(), phone: pass(), mac: pass() };
  mintPrincipal(folder, { unit: "reader-0001", scopes: ["read"], token: passes.reader, now_ms: NOW_MS });
  mintPrincipal(folder, { unit: PHONE_UNIT, kind: "phone", scopes: ["deliver", "read"], sources: [`location:local:${PHONE_UNIT}`], token: passes.phone, now_ms: NOW_MS });
  mintPrincipal(folder, { unit: MAC_UNIT, kind: "mac", scopes: ["deliver", "read"], sources: [`machine:local:${MAC_UNIT}`], token: passes.mac, now_ms: NOW_MS });
  editSettings(root, { "model.defaults.hiding": null });
  writePrepared(folder, peopleFileOf(root, at.dir), PEOPLE, {
    rows: new Map([["names", new Map([["table", { owner: { who: "p-owner", shown: "Owner Example" }, people: [{ who: "p-owner", is: "human", shown: "Owner Example", names: ["Owner Example"], accounts: [] }] } as unknown as JsonObject]])]]),
    position: "p1",
  });
  const worker = await fakeWorker();
  const turns: string[] = [];
  let release = (): void => undefined;
  const ask: Server = createServer((request, response) => {
    turns.push(request.headers.authorization?.replace(/^Bearer /u, "") ?? "");
    request.resume();
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.write(`${JSON.stringify({ type: "chat", chat: CHAT, n: 2 })}\n`);
    release = () => response.end(`${JSON.stringify({ type: "done" })}\n`);
  });
  await new Promise<void>((done) => ask.listen(0, "127.0.0.1", done));
  const logs: string[] = [];
  const registry = options.registry ?? FAKES;
  const start = () => startHome(root, { lookMs: LOOK_MS, registry, machine: at, log: (line) => logs.push(line), tickMs: TICK_MS, stopGraceMs: 50, slot, feedbackUrl: worker.url });
  const door = await serveDoor(root, { port: 0, lan_port: 0, max_bundle_bytes: 1 << 30 }, {
    lookMs: LOOK_MS, log: () => undefined, registry, machine: at, floors: FLOORS, feedbackOpen: true, ask: `http://127.0.0.1:${(ask.address() as AddressInfo).port}`,
    ...(slot === null ? {} : { slot: { key: slot, why: null } }),
  });
  editSettings(root, { "door.port": door.port });
  let home: Home = await start();
  onTestFinished(async () => {
    release();
    await door.close();
    await home.stop();
    ask.closeAllConnections();
    await new Promise<void>((done) => ask.close(() => done()));
  });
  const url = `http://127.0.0.1:${door.port}`;
  const sock = testSocket(root, at.dir);
  const call = async (method: string, path: string, bearer: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> => {
    const bytes = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const response = await fetch(`${url}${path}`, {
      method, ...(bytes === undefined ? {} : { body: bytes }),
      headers: { authorization: `Bearer ${bearer}`, ...(bytes === undefined || Buffer.isBuffer(body) ? {} : { "content-type": "application/json" }), ...headers },
    });
    const text = await response.text();
    return { status: response.status, body: text === "" ? {} : JSON.parse(text) as JsonObject };
  };
  const as = {
    phone: (method: string, path: string, body?: unknown) => call(method, path, passes.phone, body, DEVICE.phone),
    mac: (method: string, path: string, body?: unknown) => call(method, path, passes.mac, body, DEVICE.mac),
  };
  const turn = async (): Promise<string> => {
    const asked = fetch(`${url}/v1/ask`, { method: "POST", headers: { authorization: `Bearer ${passes.reader}`, "content-type": "application/json" }, body: JSON.stringify({ question: "Synthetic?", chat: CHAT }) });
    await until("the Ask stand-in heard a turn", () => turns.length > 0);
    void asked.then((response) => response.text()).catch(() => undefined);
    return turns[0]!;
  };
  const reportFile = (id: string) => join(root, "feedback", id, "report.json");
  const onDisk = (id: string): Report | undefined => {
    const bytes = folder.file(REPORT_FILE, reportFile(id)).read();
    return bytes === undefined ? undefined : JSON.parse(bytes.toString("utf8")) as Report;
  };
  return {
    root, at, url, sock, passes, worker, logs, call, as, turn, onDisk, reportFile,
    mcp: readFileSync(join(dir, "mcp", "door-token"), "utf8").trim(),
    askPass: () => readFileSync(join(dir, "ask", "door-token"), "utf8").trim(),
    async restart() {
      await home.stop();
      home = await start();
    },
  };
}

describe("feedback, through the door", () => {
  it("while feedback is closed, every route answers 404 to the person, and the page answer says open false", async () => {
    const roots: string[] = [];
    const at = makeHome({ phone: { kind: "phone", scopes: ["deliver", "read"], sources: [`location:local:${PHONE_UNIT}`], unit: PHONE_UNIT } }, roots);
    onTestFinished(() => { for (const each of roots) rmSync(each, { recursive: true, force: true }); });
    const door = await serveDoor(at.root, { port: 0, max_bundle_bytes: 1 << 30 }, { lookMs: LOOK_MS, log: () => undefined, clock: () => NOW_MS, floors: FLOORS });
    onTestFinished(() => door.close());
    const url = `http://127.0.0.1:${door.port}`;
    const headers = { authorization: `Bearer ${at.tokens.phone}`, ...DEVICE.phone, "content-type": "application/json" };
    for (const route of ROUTES) {
      const answered = await fetch(`${url}/v1/feedback/${route}${route === "screenshot" ? `?id=${randomUUID()}` : ""}`, { method: "POST", headers, body: JSON.stringify({ id: randomUUID(), about: { kind: "menu" } }) });
      expect(answered.status, route).toBe(404);
    }
    const page = await fetch(`${url}/v1/page/feedback`, { headers });
    expect(page.status).toBe(200);
    expect(((await page.json()) as JsonObject).open).toBe(false);
  });

  it("no agent, turn, MCP server or model reader reaches a person's report; the Mac and the phone do; an agent's note is still kept", async () => {
    const at = await running();
    const added = await askHome(at.sock, "agents", ["add", "Hermes"]) as Added;
    const turn = await at.turn();
    const refused = { agent: added.pass, turn, mcp: at.mcp, model: at.passes.reader };
    for (const [who, bearer] of Object.entries(refused)) {
      const headers = who === "model" ? { [READER_HEADER]: "model" } : {};
      for (const route of ROUTES) {
        const answered = await at.call("POST", `/v1/feedback/${route}${route === "screenshot" ? `?id=${randomUUID()}` : ""}`, bearer, { id: randomUUID(), about: { kind: "menu" } }, headers);
        expect([answered.status, answered.body.code], `${who} ${route}`).toEqual([403, "PRINCIPAL_SCOPE"]);
      }
      expect((await at.call("GET", "/v1/page/feedback", bearer, undefined, headers)).status, `${who} page`).toBe(403);
    }
    for (const device of ["phone", "mac"] as const) {
      const drafted = await at.as[device]("POST", "/v1/feedback/draft", { id: randomUUID(), about: { kind: "menu" } });
      expect(drafted.status, device).toBe(200);
      expect((drafted.body.attachments as JsonObject[]).map((each) => each.kind), device).toEqual(["app"]);
    }
    expect((await at.call("POST", "/v1/feedback", added.pass, { category: "missing", message: "A synthetic note." })).body).toEqual({ outcome: "saved" });
    expect(readFileSync(join(at.root, "agents", "feedback.jsonl"), "utf8")).toContain("A synthetic note.");
  });

  it("a phone drafts, adds a screenshot and sends; the fake Worker reads the words as typed and the attachment as drafted, once; every bad ask is refused before it is kept", async () => {
    const at = await running();
    const page = await at.as.phone("GET", "/v1/page/feedback");
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ open: true, title: FEEDBACK_WORDS.title, field: { max: TEXT_MAX }, kinds: [{ kind: "answer" }, { kind: "connector" }, { kind: "app" }, { kind: "screenshot", add: "Add screenshot" }] });
    const pageFixture = clientFixture("feedback/page", { ...page.body, today: FIXTURE_DAY });
    expect(pageFixture.held, "homelink/Tests/Fixtures/feedback/page.json is this read: LIFESTREAM_FIXTURES=write writes it").toBe(pageFixture.written);

    const id = randomUUID();
    expect((await at.as.phone("POST", "/v1/feedback/draft", { id: "not-a-uuid", about: { kind: "menu" } })).status).toBe(422);
    expect((await at.as.phone("POST", "/v1/feedback/draft", { id, about: { kind: "elsewhere" } })).status).toBe(422);
    const drafted = await at.as.phone("POST", "/v1/feedback/draft", { id, about: { kind: "menu" } });
    expect(drafted.status).toBe(200);
    expect(await at.as.phone("POST", "/v1/feedback/draft", { id, about: { kind: "menu" } }), "the same id answers the held draft").toEqual(drafted);
    const app = (drafted.body.attachments as JsonObject[]).find((each) => each.kind === "app")!;
    expect(app.text).toContain("iPhone app: 1.0.0");
    const draftFixture = clientFixture("feedback/draft", { ...drafted.body, attachments: (drafted.body.attachments as JsonObject[]).map((each) => ({ ...each, text: FIXTURE_APP, counts: {} })) });
    expect(draftFixture.held, "homelink/Tests/Fixtures/feedback/draft.json is this read: LIFESTREAM_FIXTURES=write writes it").toBe(draftFixture.written);

    const headers = { authorization: `Bearer ${at.passes.phone}`, ...DEVICE.phone };
    expect((await postUnread(at.url, `/v1/feedback/screenshot?id=${id}`, headers)).status, "no Content-Length").toBe(411);
    expect((await postUnread(at.url, `/v1/feedback/screenshot?id=${id}`, { ...headers, "content-length": String(SHOT_BYTES + 1) })).body.code).toBe("FILE_TOO_LARGE");
    expect((await at.call("POST", "/v1/feedback/screenshot", at.passes.phone, png(1, 1), DEVICE.phone)).status, "no id").toBe(422);
    expect((await at.call("POST", `/v1/feedback/screenshot?id=${id}`, at.passes.phone, Buffer.from("a synthetic note, no picture"), DEVICE.phone)).body.code).toBe("FILE_KIND");
    expect((await at.call("POST", `/v1/feedback/screenshot?id=${randomUUID()}`, at.passes.phone, png(1, 1), DEVICE.phone)).status, "no draft").toBe(404);
    const shot = png(1179, 2556);
    const added = await at.call("POST", `/v1/feedback/screenshot?id=${id}`, at.passes.phone, shot, DEVICE.phone);
    expect([added.status, added.body]).toEqual([200, { width: 1179, height: 2556 }]);

    const text = "The day page froze <b>twice</b>; call +15550000001 if you like.";
    const sent = (said: JsonObject) => at.as.phone("POST", "/v1/feedback/send", { id, text, email: "person-a@example.com", keep: ["app", "screenshot"], ...said });
    expect((await sent({ text: " " })).status, "an empty text").toBe(422);
    expect((await sent({ text: "x".repeat(TEXT_MAX + 1) })).status, "a text too long").toBe(422);
    expect((await sent({ email: "nobody" })).status, "an email with no @").toBe(422);
    expect((await sent({ keep: ["answer"] })).status, "a kind the draft does not hold").toBe(422);
    expect((await sent({ id: randomUUID() })).body.code, "no draft").toBe("NOT_FOUND");
    expect(at.worker.filed).toEqual([]);
    expect(await sent({})).toEqual({ status: 200, body: { id } });
    expect(await sent({}), "Send again answers the same and keeps nothing more").toEqual({ status: 200, body: { id } });
    await until("the report went", () => at.onDisk(id)?.state === "sent");
    expect(at.worker.filed).toHaveLength(1);
    const [filed] = at.worker.filed;
    expect(filed!.length, "a try states its length").toBeDefined();
    expect(JSON.parse(filed!.parts.get("report")!.text)).toEqual({ v: 1, id, text, email: "person-a@example.com", about: "menu", device: "phone" });
    expect(filed!.parts.get("app")!.text, "the attachment the person read, byte for byte").toBe(app.text);
    expect(filed!.parts.get("screenshot")!.bytes.equals(shot)).toBe(true);
    expect(filed!.parts.has("answer")).toBe(false);
    expect(at.onDisk(id)).toMatchObject({ id, text, email: "person-a@example.com", state: "sent", tries: 1, screenshot: { width: 1179, height: 2556 } });
    expect(existsSync(join(at.root, "feedback", id, "screenshot.jpg"))).toBe(true);

    await at.restart();
    expect(await sent({}), "a kept report answers after a restart").toEqual({ status: 200, body: { id } });
    expect((await at.as.phone("POST", "/v1/feedback/send", { id: randomUUID(), text, email: null, keep: [] })).body.code, "a restart forgot every draft").toBe("NOT_FOUND");
    expect(at.worker.filed).toHaveLength(1);
  });

  it("the outbound log lists each report to the people who make Lifestream, with the draft's counts and whether it went, and reads back what was sent", async () => {
    const at = await running();
    at.worker.status.code = 503;
    at.worker.status.retry = "1";
    const id = randomUUID();
    const drafted = await at.as.mac("POST", "/v1/feedback/draft", { id, about: { kind: "menu" } });
    const app = (drafted.body.attachments as JsonObject[])[0]!;
    const text = "The outbound log should list this; call +15550000001.";
    expect((await at.as.mac("POST", "/v1/feedback/send", { id, text, email: "person-a@example.com", keep: ["app"] })).status).toBe(200);
    await until("the first try was answered 503", () => (at.onDisk(id)?.tries ?? 0) >= 1);
    const listed = async () => ((await at.as.mac("GET", "/v1/outbound")).body.rows as JsonObject[]).filter((row) => row.what === "feedback");
    const [waiting] = await listed();
    expect(waiting).toMatchObject({
      receiver: "lifestream", what: "feedback", by: MAC_UNIT, level: "all", counts: app.counts, pictures: 0, key: `feedback:${id}`,
      report: { state: "queued", words: REPORT_WORDS.states.queued, receiver: REPORT_WORDS.receiver },
    });
    const one = await at.as.mac("GET", `/v1/outbound/${String(waiting!.seq)}`);
    expect(one.status).toBe(200);
    expect(JSON.parse((one.body.sent as { body: string }).body)).toEqual({ text, email: "person-a@example.com", attachments: [{ kind: "app", title: "App details", text: app.text }] });
    expect(one.body.report).toMatchObject({ state: "queued" });

    at.worker.status.code = 201;
    await until("the report went once the Worker took it", () => at.onDisk(id)?.state === "sent");
    expect(await listed(), "one row for the report, whatever its tries").toEqual([expect.objectContaining({ seq: waiting!.seq, report: { state: "sent", words: REPORT_WORDS.states.sent, receiver: REPORT_WORDS.receiver, erased: null } })]);
  });

  it("an erased conversation leaves every report and draft that carried its answer: a queued report goes without it, a held draft no longer offers it, a sent one loses it in the home and its outbound read says the makers hold their copy", async () => {
    const at = await running({ registry: ASK_REGISTRY });
    const made = Date.now();
    const put = chatTurn(made, "Zorbot Exampleton rang from +15550000001.");
    const shipped = await fetch(`${at.url}${put.path}`, { method: "PUT", headers: { authorization: `Bearer ${at.askPass()}` }, body: new Uint8Array(put.bytes) });
    expect(shipped.status, await shipped.text()).toBe(201);
    const about = { kind: "chat", chat: CHAT, n: 2 };
    const withAnswer = async (id: string) => {
      const drafted = await at.as.mac("POST", "/v1/feedback/draft", { id, about });
      return (drafted.body.attachments as JsonObject[] | undefined)?.some((each) => each.kind === "answer") === true;
    };
    await until("the answer imported and a new draft offers it", () => withAnswer(randomUUID()));
    const sent = randomUUID();
    expect(await withAnswer(sent)).toBe(true);
    expect((await at.as.mac("POST", "/v1/feedback/send", { id: sent, text: "Sent with the answer", email: null, keep: ["answer", "app"] })).status).toBe(200);
    await until("the first report went", () => at.onDisk(sent)?.state === "sent");
    expect(at.worker.filed.at(-1)!.parts.get("answer")!.text).toContain("[[Phone 1]]");

    at.worker.status.code = 503;
    at.worker.status.retry = "1";
    const queued = randomUUID();
    expect(await withAnswer(queued)).toBe(true);
    expect((await at.as.mac("POST", "/v1/feedback/send", { id: queued, text: "Queued with the answer", email: null, keep: ["answer", "app"] })).status).toBe(200);
    await until("the queued report was tried", () => (at.onDisk(queued)?.tries ?? 0) >= 1);
    const held = randomUUID();
    expect(await withAnswer(held)).toBe(true);

    await askHome(at.sock, "erase", ["ai", asked(CHAT, 2), "--apply"]);
    expect(at.onDisk(queued)?.attachments.map((each) => each.kind)).toEqual(["app"]);
    expect(at.onDisk(queued)?.refs).toEqual([]);
    expect(at.onDisk(sent)).toMatchObject({ state: "sent", sent_before_erasure: true });
    expect(at.onDisk(sent)?.attachments.map((each) => each.kind)).toEqual(["app"]);
    const kept = await at.as.mac("POST", "/v1/feedback/send", { id: held, text: "Held", email: null, keep: ["answer"] });
    expect([kept.status, kept.body.code]).toEqual([422, "BAD_REQUEST"]);
    const rows = ((await at.as.mac("GET", "/v1/outbound")).body.rows as JsonObject[]).filter((row) => row.key === `feedback:${sent}`);
    const read = await at.as.mac("GET", `/v1/outbound/${String(rows[0]!.seq)}`);
    expect((read.body.refs as JsonObject[])).toEqual([]);
    expect(read.body.report).toEqual({ state: "sent", words: REPORT_WORDS.states.sent, receiver: REPORT_WORDS.receiver, erased: REPORT_WORDS.erased });
    expect((read.body.sent as { body: string }).body, "the home keeps no copy of the erased answer").not.toContain("[[Phone 1]]");

    at.worker.status.code = 201;
    await until("the queued report went", () => at.onDisk(queued)?.state === "sent");
    const last = at.worker.filed.at(-1)!;
    expect(JSON.parse(last.parts.get("report")!.text).id).toBe(queued);
    expect([...last.parts.keys()]).toEqual(["report", "app"]);
  });

  it("on an encrypted home, a report is kept keyed: its words are in no file of the home's folder, and read back through the home's keys", async () => {
    const at = await running({ keyed: true });
    const id = randomUUID();
    expect((await at.as.mac("POST", "/v1/feedback/draft", { id, about: { kind: "menu" } })).status).toBe(200);
    expect((await at.as.mac("POST", "/v1/feedback/send", { id, text: "A synthetic report from an encrypted home.", email: null, keep: ["app"] })).status).toBe(200);
    await until("the report went", () => at.worker.filed.length === 1);
    expect(at.onDisk(id)?.text).toBe("A synthetic report from an encrypted home.");
    const files = readdirSync(join(at.root, "feedback"), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(readFileSync(join(file.parentPath, file.name)).includes(Buffer.from("A synthetic report")), file.name).toBe(false);
  });
});
