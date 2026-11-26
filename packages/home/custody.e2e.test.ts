import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { spawnSync } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { request as httpRequest } from "node:http";
import { createServer, type Socket } from "node:net";
import { homeSources } from "./devices.js";
import { serveDoor, type Door } from "./door.js";
import { homeClock } from "./home-clock.js";
import { mintPrincipal, readPrincipals } from "./principals.js";
import { askHome, type HomeSocket } from "./socket.js";
import { ChildHome, FAKES, LOOK_MS, makeRoot, readHome, removeRoot, REPO, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { doorHere } from "./test/harness-door.js";
import { startHere } from "./test/harness-home.js";
import { statusOf } from "./test/harness-status.js";
import { acquisitionBundle, DEVICE, healthLine, INSTALL_TWO, makeHome, phoneBundle, photoLine, sha256 } from "./test/support.js";
import { readOpsSettings } from "./verbs/context.js";
import { runnerUnit } from "./lifecycle.js";
import { PEER_GUESSES, SHOWN_MS } from "./pairing.js";
import { effective } from "./settings.js";
import { editSettings, testSocket } from "./test/folder.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

const report: Record<string, unknown> = {};
const removeAtEnd = (path: string): void => onTestFinished(() => removeRoot(path));
const homeOn = (root: string) => startHere(root, { tickMs: TICK_MS, slot: null, log: () => undefined });

function childOn(root: string): ChildHome {
  const child = new ChildHome(root);
  onTestFinished(async () => { await child.stop(); });
  return child;
}

afterAll(() => {
  const directory = join(tmpdir(), "lifestream-home-ops-e2e");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "custody.json"), `${JSON.stringify(report, null, 2)}\n`);
});

type Answer = { status: number; body: Record<string, unknown>; retry: string | null };

const newPass = (): string => randomBytes(32).toString("base64url");

async function running(prefix: string): Promise<{ root: string; door: Awaited<ReturnType<typeof doorHere>>; home: Awaited<ReturnType<typeof homeOn>>; sock: HomeSocket }> {
  const root = makeRoot(prefix, { sources: {} });
  removeAtEnd(root);
  const door = await doorHere(root);
  return { root, door, home: await homeOn(root), sock: testSocket(root) };
}

async function request(url: string, method: string, path: string, headers: Record<string, string>, body?: Buffer | string): Promise<Answer> {
  const response = await fetch(`${url}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
  return { status: response.status, body: await response.json() as Record<string, unknown>, retry: response.headers.get("retry-after") };
}

const pair = (url: string, body: Record<string, unknown>, header: Record<string, string> = DEVICE.mac) =>
  request(url, "POST", "/v1/pair", { ...header, "content-type": "application/json" }, JSON.stringify(body));
const exchange = (url: string, pass: string, header: Record<string, string>, body: Record<string, unknown> = {}) =>
  request(url, "POST", "/v1/exchange", { authorization: `Bearer ${pass}`, ...header, "content-type": "application/json" }, JSON.stringify(body));
async function pairFrom(peer: string, url: string, body: Record<string, unknown>): Promise<Answer> {
  const seen = (message: unknown) => { Object.defineProperty((message as { socket: Socket }).socket, "remoteAddress", { value: peer }); };
  subscribe("net.server.socket", seen);
  try {
    return await new Promise<Answer>((resolve, reject) => {
      const text = JSON.stringify(body);
      const headers = { ...DEVICE.mac, "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) };
      const sent = httpRequest(`${url}/v1/pair`, { method: "POST", agent: false, headers }, (response) => {
        let answer = "";
        response.on("data", (chunk: Buffer) => (answer += chunk.toString("utf8")));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(answer) as Record<string, unknown>, retry: (response.headers["retry-after"] as string | undefined) ?? null }));
      });
      sent.on("error", reject);
      sent.end(text);
    });
  } finally {
    unsubscribe("net.server.socket", seen);
  }
}
const code = async (sock: HomeSocket, replace?: string) =>
  (await askHome(sock, "pair", replace === undefined ? [] : ["--replace", replace])) as { code: string; unit: string | null; link: string | null; match: string };

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const devicePasses = (root: string) => readPrincipals(openHomeFolder(root)).principals
  .filter((row) => row.kind !== null && row.unit !== runnerUnit(MAC_UNIT));

const custodyOf = (answer: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(answer.sources as Record<string, { received: number; imported: number }>).map(([source, held]) => [source, [held.received, held.imported]]));

const MAC_UNIT = "macbook-pro-0001";
const NUDGED = "apple-notes:local:macbook-pro-0001";
const MACHINE = `machine:local:${MAC_UNIT}`;
const MAC_OWN = ["audio", "claude-code", "codex", "input", "machine", "screen", "upload"].map((product) => `${product}:local:${MAC_UNIT}`);
const OWN = homeSources(MAC_UNIT).map((source) => source.id);

describe("pairing", () => {
  it("pairs a Mac with its own pass, again with the same pass, never with a used code, a code past five wrong guesses, a revoked pass, a unit with a live pass or a stopped home, and again once every pass of its unit is revoked", async () => {
    const { root, door, home, sock } = await running("lifestream-pairing-");
    const said: string[] = [];
    const minted = (await askHome(sock, "pair", [], (line) => said.push(line))) as Awaited<ReturnType<typeof code>>;
    expect(minted.code).toMatch(/^\d{8}$/u);
    expect(minted.match).toMatch(/^[A-Z2-7]{4}$/u);
    expect(minted.link).toMatch(new RegExp(`^lifestream://pair\\?code=${minted.code}&host=127\\.0\\.0\\.1&port=\\d+&fp=[A-Z2-7]{52}$`, "u"));
    expect(said.at(-1)).toBe(`link ${minted.link}`);
    report.pair_said = said.map((line) => line.replace(/\d{8}/gu, "<code>"));
    const mac = newPass();
    const offers = [
      `imessage:+15550000001:${MAC_UNIT}`, `whatsapp:+15550000002:${MAC_UNIT}`,
      "imessage:+15550000001:macbook-pro-bb01",
      `gmail:person-a@example.com:${MAC_UNIT}`,
      `location:local:${MAC_UNIT}`,
      `notaproduct:x:${MAC_UNIT}`, "not-a-source-id",
    ];
    const body = { code: minted.code, pass: mac, kind: "mac", model: "MacBook Pro", serial4: "0001", offers };
    const check = (text: string) => askHome(sock, "pair", ["check", text]);
    expect(await check(minted.code)).toEqual({ code: minted.code, state: "live" });
    const first = await pair(door.url, body);
    expect(await check(minted.code)).toEqual({ code: minted.code, state: "used", unit: MAC_UNIT });
    expect(first).toMatchObject({ status: 200, body: { unit: MAC_UNIT, answer: { unit: MAC_UNIT, calls: [] } } });
    expect("addresses" in first.body, "a Mac keeps where it paired (loopback): it is answered no addresses").toBe(false);
    const clockId = (first.body.answer as { clock: string }).clock;
    expect(clockId).toBe(homeClock(effective(root).settings.day).id);
    const { token: reader } = mintPrincipal(openHomeFolder(root), { unit: "reader", kind: null, scopes: ["read"], sources: [], now_ms: 0 });
    const served = await fetch(`${door.url}/v1/clock`, { headers: { authorization: `Bearer ${reader}` } });
    expect([served.status, served.headers.get("etag"), ((await served.json()) as { id: string }).id]).toEqual([200, `"${clockId}"`, clockId]);
    const made = [...MAC_OWN, `imessage:+15550000001:${MAC_UNIT}`, `whatsapp:+15550000002:${MAC_UNIT}`].sort();
    expect(Object.keys((first.body.answer as Record<string, unknown>).sources as object)).toEqual([]);
    await askHome(sock, "setup", ["skip", MAC_UNIT, "found"]);
    expect(Object.keys((await exchange(door.url, mac, DEVICE.mac)).body.sources as object)).toEqual(made);
    const passId = (first.body.answer as { pass: string }).pass;
    const sources = readHome(root, (db) => db.prepare("SELECT id, connector, options FROM sources ORDER BY id").all()) as { id: string; connector: string }[];
    expect(sources.map((source) => source.id)).toEqual([...made, ...OWN].sort());
    expect(sources.find((source) => source.id === MACHINE)!.connector).toBe("machine-events");
    expect(readHome(root, (db) => db.prepare("SELECT unit, model FROM devices").all())).toEqual([{ unit: MAC_UNIT, model: "MacBook Pro" }]);
    const file = readFileSync(join(root, "config", "principals.json"), "utf8");
    expect(file).not.toContain(mac);
    expect(devicePasses(root)).toEqual([expect.objectContaining({
      id: passId, unit: MAC_UNIT, kind: "mac", scopes: ["deliver"], revoked_at: null, sources: expect.arrayContaining(made),
    })]);

    const answers: Record<string, Answer> = {
      retry: await pair(door.url, body),
      retry_other_code: await pair(door.url, { ...body, code: "00000000" }),
      used: await pair(door.url, { ...body, pass: newPass() }),
      unit_held: await pair(door.url, { ...body, code: (await code(sock)).code, pass: newPass() }),
      no_header: await pair(door.url, { ...body, code: (await code(sock)).code, pass: newPass() }, {}),
      shape: await pair(door.url, { code: "12", pass: "short", kind: "watch" }),
    };
    const replaced = await pair(door.url, { ...body, code: (await code(sock, MAC_UNIT)).code, pass: newPass() });
    expect(replaced).toMatchObject({ status: 200, body: { unit: MAC_UNIT } });
    expect((replaced.body.answer as { pass: string }).pass).not.toBe(passId);
    await expect(code(sock, "macbook-pro-ffff")).rejects.toThrow("no device macbook-pro-ffff");

    const guessed = await code(sock);
    const wrong = guessed.code === "11111111" ? "22222222" : "11111111";
    for (let guess = 0; guess < 5; guess++) answers[`guess_${guess + 1}`] = await pairFrom(`100.64.0.${guess + 1}`, door.url, { ...body, code: wrong, pass: newPass(), serial4: "bb01" });
    answers.sixth = await pairFrom("100.64.0.6", door.url, { ...body, code: guessed.code, pass: newPass(), serial4: "bb01" });
    expect(await check(guessed.code)).toEqual({ code: guessed.code, state: "gone" });
    await expect(askHome(sock, "pair", ["check"])).rejects.toThrow("usage");

    await askHome(sock, "principals", ["revoke", passId]);
    answers.revoked = await pair(door.url, body);
    answers.revoked_exchange = await exchange(door.url, mac, DEVICE.mac);
    answers.one_live = await pair(door.url, { ...body, code: (await code(sock)).code, pass: newPass() });
    await askHome(sock, "principals", ["revoke", (replaced.body.answer as { pass: string }).pass]);
    const again = await pair(door.url, { ...body, code: (await code(sock)).code, pass: newPass() });
    expect(again).toMatchObject({ status: 200, body: { unit: MAC_UNIT } });
    expect(readHome(root, (db) => db.prepare("SELECT id FROM sources ORDER BY id").all())).toEqual(sources.map(({ id }) => ({ id })));
    expect(readHome(root, (db) => db.prepare("SELECT unit, model FROM devices").all())).toEqual([{ unit: MAC_UNIT, model: "MacBook Pro" }]);
    expect(devicePasses(root).filter((row) => row.revoked_at === null)).toEqual([expect.objectContaining({
      id: (again.body.answer as { pass: string }).pass, unit: MAC_UNIT, sources: expect.arrayContaining(made),
    })]);
    await home.stop();
    answers.stopped = await pair(door.url, { ...body, pass: newPass() });

    expect(Object.fromEntries(Object.entries(answers).map(([name, answer]) => [name, [answer.status, answer.body.code ?? answer.body.unit]]))).toEqual({
      retry: [200, MAC_UNIT], retry_other_code: [200, MAC_UNIT], used: [403, "PAIR_CODE"], unit_held: [409, "PAIR_UNIT_EXISTS"],
      no_header: [426, "DEVICE_TOO_OLD"], shape: [422, "PAIR_REQUEST"],
      guess_1: [403, "PAIR_CODE"], guess_2: [403, "PAIR_CODE"], guess_3: [403, "PAIR_CODE"], guess_4: [403, "PAIR_CODE"], guess_5: [403, "PAIR_CODE"],
      sixth: [403, "PAIR_CODE"], revoked: [403, "PAIR_CODE"], revoked_exchange: [401, "PRINCIPAL_UNKNOWN"], one_live: [409, "PAIR_UNIT_EXISTS"],
      stopped: [503, "NOT_NOW"],
    });
    expect((answers.retry!.body.answer as { pass: string }).pass).toBe(passId);
    expect(answers.stopped!.retry).toBe("5");
    expect(devicePasses(root).map((row) => row.unit)).toEqual([MAC_UNIT, MAC_UNIT, MAC_UNIT]);
    report.pairing = { first: first.body, answers: Object.fromEntries(Object.entries(answers).map(([name, answer]) => [name, answer.body])) };
  });


  it("takes a unit only while a pass of it is live: a live pass refuses, all revoked rejoins as itself, a device row with no pass pairs", async () => {
    const { root, door, sock } = await running("lifestream-pair-taken-");
    const mac = (serial4: string) => ({ pass: newPass(), kind: "mac", model: "MacBook Pro", serial4 });
    const first = await pair(door.url, { ...mac("0001"), code: (await code(sock)).code });
    const live = await pair(door.url, { ...mac("0001"), code: (await code(sock)).code });
    for (const row of devicePasses(root)) if (row.revoked_at === null) await askHome(sock, "principals", ["revoke", row.id]);
    const rejoined = await pair(door.url, { ...mac("0001"), code: (await code(sock)).code });
    await askHome(sock, "device", ["add", "macbook-pro-cc03", "--model", "MacBook Pro"]);
    const rowOnly = await pair(door.url, { ...mac("cc03"), code: (await code(sock)).code });
    expect([first, live, rejoined, rowOnly].map((answer) => [answer.status, answer.body.code ?? answer.body.unit])).toEqual([
      [200, MAC_UNIT], [409, "PAIR_UNIT_EXISTS"], [200, MAC_UNIT], [200, "macbook-pro-cc03"],
    ]);
    expect(devicePasses(root).filter((row) => row.revoked_at === null).map((row) => row.unit).sort()).toEqual([MAC_UNIT, "macbook-pro-cc03"]);
    expect(readHome(root, (db) => db.prepare("SELECT unit FROM devices ORDER BY unit").pluck().all())).toEqual([MAC_UNIT, "macbook-pro-cc03"]);
    report.taken = { live: live.body, rejoined: rejoined.body, rowOnly: rowOnly.body };
  });

  it("never pairs a retired unit again, while its pass lives or after every pass of it is revoked, and says why in its words", async () => {
    const { root, door, sock } = await running("lifestream-pair-retired-");
    const body = () => ({ pass: newPass(), kind: "mac", model: "MacBook Pro", serial4: "0001" });
    const first = await pair(door.url, { ...body(), code: (await code(sock)).code });
    expect(first).toMatchObject({ status: 200, body: { unit: MAC_UNIT } });
    await askHome(sock, "device", ["retire", MAC_UNIT]);
    const passes = () => devicePasses(root).length;
    const before = passes();
    const live = await pair(door.url, { ...body(), code: (await code(sock)).code });
    for (const row of devicePasses(root)) if (row.revoked_at === null) await askHome(sock, "principals", ["revoke", row.id]);
    const drained = await pair(door.url, { ...body(), code: (await code(sock)).code });
    const words = `${MAC_UNIT} was removed from Lifestream (lifestream device retire ${MAC_UNIT}), and a removed device does not pair again: its history stays in Lifestream, and it records nothing more`;
    expect([live, drained].map((answer) => [answer.status, answer.body.code, answer.body.message])).toEqual([[409, "PAIR_UNIT_RETIRED", words], [409, "PAIR_UNIT_RETIRED", words]]);
    expect(passes()).toBe(before);
    report.retired = { live: live.body, drained: drained.body };
  });

  it("never lets one peer's flood of wrong codes end the code another device types: past its own guesses it is slowed, before the home counts them", async () => {
    const { door, sock } = await running("lifestream-pair-flood-");
    const live = await code(sock);
    const wrong = live.code === "11111111" ? "22222222" : "11111111";
    const guess = (peer: string) => pairFrom(peer, door.url, { code: wrong, pass: newPass(), kind: "mac", model: "MacBook Pro", serial4: "bb02" });
    const flood: [number, unknown, string | null][] = [];
    for (let each = 0; each < 8; each++) {
      const answer = await guess("100.100.0.7");
      flood.push([answer.status, answer.body.code, answer.retry === null ? null : "retry"]);
    }
    expect(flood).toEqual([
      ...Array.from({ length: PEER_GUESSES }, () => [403, "PAIR_CODE", null]),
      ...Array.from({ length: 8 - PEER_GUESSES }, () => [429, "PAIR_SLOW_DOWN", "retry"]),
    ]);
    expect(await askHome(sock, "pair", ["check", live.code])).toEqual({ code: live.code, state: "live" });
    expect((await pairFrom("100.100.0.7", door.url, { code: live.code, pass: newPass(), kind: "mac", model: "MacBook Pro", serial4: "bb03" })).status).toBe(429);
    const paired = await pairFrom("100.100.0.8", door.url, { code: live.code, pass: newPass(), kind: "mac", model: "MacBook Pro", serial4: "bb04" });
    expect([paired.status, paired.body.unit]).toEqual([200, "macbook-pro-bb04"]);
    report.pair_flood = flood;
  });
  it("leases the Mac window's code: one code to every ask within SHOWN_MS, ended past it at a read and a pairing; never a hand-minted one; its link built once, again only while it has none, once for two asks", async () => {
    const root = makeRoot("lifestream-pairing-lease-", { sources: {} });
    removeAtEnd(root);
    const { url } = await doorHere(root);
    const hold = join(root, "hold");
    const hits = () => (existsSync(`${hold}.hits`) ? readFileSync(`${hold}.hits`, "utf8").split("\n").slice(0, -1) : []);
    const builds = () => hits().length;
    process.env.LIFESTREAM_FAILPOINT = "pair.link";
    process.env.LIFESTREAM_HOLD = hold;
    onTestFinished(() => {
      delete process.env.LIFESTREAM_FAILPOINT;
      delete process.env.LIFESTREAM_HOLD;
    });
    let at = Date.now();
    await startHere(root, { tickMs: 3_600_000, slot: null, log: () => undefined, clock: () => at });
    const sock = testSocket(root);
    type Shown = { code: string; unit: null; expires_ms: number; link: string | null; why?: string; match: string };
    const show = async () => (await askHome(sock, "pair", ["show"])) as Shown;
    const check = async (text: string) => ((await askHome(sock, "pair", ["check", text])) as { state: string }).state;
    const phone = (text: string) => pair(url, { code: text, pass: newPass(), kind: "phone", model: "iPhone 17 Pro", new: true }, DEVICE.phone);
    const lease: Record<string, unknown> = {};

    const first = await show();
    expect(first).toMatchObject({ code: expect.stringMatching(/^\d{8}$/u), unit: null, link: expect.stringContaining(`code=${first.code}&`), match: expect.stringMatching(/^[A-Z2-7]{4}$/u) });
    at += 5_000;
    const second = await show();
    at += 9_000;
    const third = await show();
    expect([second.code, third.code, builds()]).toEqual([first.code, first.code, 1]);
    at += SHOWN_MS + 1;
    expect(await check(first.code)).toBe("gone");
    const fourth = await show();
    expect([fourth.code !== first.code, builds()]).toEqual([true, 2]);
    at += SHOWN_MS + 1;
    lease.lapsed = (await phone(fourth.code)).body.code;
    expect(lease.lapsed).toBe("PAIR_CODE");

    const byHand = (await askHome(sock, "pair")) as Shown;
    const fifth = await show();
    at += 60_000;
    expect([fifth.code !== byHand.code, await check(byHand.code), await check(fifth.code)]).toEqual([true, "live", "gone"]);
    const used = await show();
    expect((await phone(used.code)).status).toBe(200);
    const sixth = await show();
    expect([sixth.code !== used.code, await check(used.code)]).toEqual([true, "used"]);
    let renewed = sixth;
    while (renewed.code === sixth.code) {
      at += 9_000;
      renewed = await show();
    }
    expect(at >= sixth.expires_ms).toBe(true);

    const listener = effective(root).settings.door.lan_port!;
    const nothing = await freePort();
    editSettings(root, { "door.lan_port": nothing });
    at += SHOWN_MS + 1;
    const down = await show();
    expect([down.link, down.why]).toEqual([null, `Lifestream can't open its Wi-Fi connection. Quit what uses port ${nothing}, or restart Lifestream.`]);
    const before = builds();
    expect((await show()).link).toBeNull();
    editSettings(root, { "door.lan_port": listener });
    const back = await show();
    await show();
    expect([back.code, back.link?.includes(`code=${down.code}&`), builds() - before]).toEqual([down.code, true, 2]);

    at += SHOWN_MS + 1;
    writeFileSync(hold, "");
    const counted = builds();
    const asks = [show()];
    await until("the link's build held", () => builds() === counted + 1);
    asks.push(show());
    await check("00000000");
    rmSync(hold);
    const both = await Promise.all(asks);
    expect([both.map((each) => each.code), both.map((each) => each.link?.includes(`code=${each.code}&`)), builds()]).toEqual([[hits().at(-1), hits().at(-1)], [true, true], counted + 1]);

    for (const ending of ["paired", "lapsed"] as const) {
      at += SHOWN_MS + 1;
      writeFileSync(hold, "");
      const counting = builds();
      const asked = show();
      await until(`the build of a code that ${ending} held`, () => builds() === counting + 1);
      const code = hits().at(-1)!;
      if (ending === "paired") expect((await phone(code)).status).toBe(200);
      else at += SHOWN_MS + 1;
      expect(await check(code)).toBe(ending === "paired" ? "used" : "gone");
      rmSync(hold);
      expect((await asked).code).toBe(code);
      const next = await show();
      lease[ending] = { check: await check(code), pair: (await phone(code)).body.code, next: next.code !== code, built: builds() - counting };
      expect(lease[ending]).toEqual({ check: ending === "paired" ? "used" : "gone", pair: "PAIR_CODE", next: true, built: 2 });
      expect(next.link).toContain(`code=${next.code}&`);
    }

    await expect(askHome(sock, "pair", ["close", byHand.code])).rejects.toThrow("usage: lifestream pair");
    report.lease = lease;
  });

  it("a home killed after storing a pass and before its sources: the device's retry with its pass finishes the pairing", async () => {
    const root = makeRoot("lifestream-pairing-killed-", { sources: {} });
    removeAtEnd(root);
    const door = await doorHere(root);
    const dying = childOn(root);
    dying.start("pair.passed");
    await dying.ready();
    const sock = testSocket(root);
    const body = { code: (await code(sock)).code, pass: newPass(), kind: "mac", model: "MacBook Pro", serial4: "0001" };
    const cut = await pair(door.url, body);
    expect((await dying.exited()).signal).toBe("SIGKILL");
    expect(cut.status).toBe(503);
    const left = { passes: devicePasses(root).length,
      sources: (readHome(root, (db) => db.prepare("SELECT id FROM sources").pluck().all()) as string[]).filter((id) => !OWN.includes(id)).length,
      devices: readHome(root, (db) => db.prepare("SELECT count(*) FROM devices").pluck().get()) };
    expect(left).toEqual({ passes: 1, sources: 0, devices: 0 });
    rmSync(sock.path, { force: true });
    await homeOn(root);
    const retry = await pair(door.url, body);
    expect(retry).toMatchObject({ status: 200, body: { unit: MAC_UNIT } });
    expect(Object.keys((retry.body.answer as Record<string, unknown>).sources as object)).toEqual([]);
    await askHome(testSocket(root), "setup", ["skip", MAC_UNIT, "found"]);
    expect(Object.keys((await exchange(door.url, body.pass, DEVICE.mac)).body.sources as object)).toEqual(MAC_OWN);
    expect(readHome(root, (db) => db.prepare("SELECT unit FROM devices").pluck().all())).toEqual([MAC_UNIT]);
    report.pairing_killed = { left, retry: retry.body };
  });

  it("pairs a phone under a unit not its own, makes its account's sources under two spellings of one Apple ID, takes another account on a retry, a Mac's account, or a phone's offers", async () => {
    const root = makeRoot("lifestream-pairing-phone-", {
      sources: {
        "imessage:+15550000001:macbook-pro-0001": "imessage-db", "apple-calls:+15550000001:macbook-pro-0001": "callhistory-mac",
        "screen-time:+15550000001:macbook-pro-0001": "biome-app-in-focus",
        "apple-notes:Person-A@Example.com:macbook-pro-0001": "notes-mac", "safari:person-a@example.com:macbook-pro-0001": "safari-history",
        "apple-reminders:person-b@example.com:macbook-pro-0001": "reminders-mac", "whatsapp:person-c@example.com:macbook-pro-0001": "whatsapp-db",
      },
      settings: { unit: "macbook-pro-0001" },
    });
    removeAtEnd(root);
    const door = await doorHere(root, { registry: FAKES });
    await homeOn(root);
    const sock = testSocket(root);
    const suggested = (await askHome(sock, "pair")) as { code: string; account: string | null; link: string };
    expect(new URL(suggested.link).searchParams.get("account")).toBe("person-a@example.com");
    const named = (await askHome(sock, "pair", ["--account", " Person-D@Example.COM "])) as { account: string | null };
    await expect(askHome(sock, "pair", ["--account", "a:b"])).rejects.toThrow("--account");

    const pass = newPass();
    const body = (code: string, account: unknown, pass_ = pass) => ({ code, pass: pass_, kind: "phone", model: "iPhone 17 Pro", account, new: true });
    const paired = await pair(door.url, body((await code(sock)).code, " Person-A@Example.com"), DEVICE.phone);
    expect(paired.status).toBe(200);
    const lan = new URL(suggested.link).searchParams.get("port");
    expect((paired.body.answer as Record<string, unknown>).addresses).toEqual([`https://127.0.0.1:${lan}`]);
    const unit = paired.body.unit as string;
    expect(unit).toMatch(/^iphone-17-pro-[0-9a-f]{4}$/u);
    const own = ["camera", "checkin", "energy", "location", "machine", "motion", "notes", "screen-time", "upload", "voice-notes"].map((product) => `${product}:local:${unit}`);
    const account = ["apple-health:person-a@example.com:cloud", `apple-contacts:person-a@example.com:${unit}`, `apple-photos:person-a@example.com:${unit}`];
    expect(Object.keys((paired.body.answer as Record<string, unknown>).sources as object)).toEqual([...own, ...account].sort());
    expect((paired.body.answer as Record<string, unknown>).owner).toEqual(["devices:local:macbook-pro-0001", "people:local:macbook-pro-0001", "places:local:macbook-pro-0001"]);
    const retry = await pair(door.url, body("00000000", "person-z@example.com"), DEVICE.phone);
    expect(Object.keys((retry.body.answer as Record<string, unknown>).sources as object)).toEqual([...own, ...account].sort());
    const secondPass = newPass();
    const second = await pair(door.url, body((await code(sock)).code, "person-a@example.com", secondPass), DEVICE.phone);
    const secondUnit = second.body.unit as string;
    expect(Object.keys((second.body.answer as Record<string, unknown>).sources as object)).toContain("apple-health:person-a@example.com:cloud");
    await askHome(sock, "connectors", ["off", secondUnit]);
    expect((await exchange(door.url, secondPass, DEVICE.phone)).body.sources).toEqual({});
    expect(Object.keys((await exchange(door.url, pass, DEVICE.phone)).body.sources as object)).toEqual([...own, ...account].sort());
    await askHome(sock, "connectors", ["on", secondUnit]);
    expect(Object.keys((await exchange(door.url, secondPass, DEVICE.phone)).body.sources as object)).toContain("apple-health:person-a@example.com:cloud");
    await askHome(sock, "connectors", ["off", unit]);
    const [offAnswer, onAnswer] = [(await exchange(door.url, pass, DEVICE.phone)).body, (await exchange(door.url, secondPass, DEVICE.phone)).body];
    expect(offAnswer.sources).toEqual({});
    expect(Object.keys(onAnswer.sources as object)).toContain("apple-health:person-a@example.com:cloud");
    expect(Object.keys(offAnswer.settings as object).sort()).toEqual(Object.keys(onAnswer.settings as object).sort());
    expect(Object.keys(offAnswer.settings as object)).toContain("location");
    const health = ((await askHome(sock, "connectors")) as { connectors: { id: string; copies: { id: string; on: boolean }[] }[] }).connectors.find((row) => row.id === "apple-health")!;
    expect(health.copies.find((source) => source.id === "apple-health:person-a@example.com:cloud")).toMatchObject({ on: true });
    await askHome(sock, "connectors", ["on", unit]);
    const offered = await exchange(door.url, pass, DEVICE.phone, { offers: ["apple-health:person-q@example.com:cloud", `apple-photos:person-q@example.com:${unit}`] });
    expect(Object.keys(offered.body.sources as object)).toEqual([...own, ...account].sort());
    expect(offered.body.owner).toEqual(["devices:local:macbook-pro-0001", "people:local:macbook-pro-0001", "places:local:macbook-pro-0001"]);
    const refusals = {
      mac: await pair(door.url, { code: (await code(sock)).code, pass: newPass(), kind: "mac", model: "MacBook Pro", serial4: "bb01", account: "person-a@example.com" }),
      colon: await pair(door.url, body((await code(sock)).code, "person:a@example.com", newPass()), DEVICE.phone),
      empty: await pair(door.url, body((await code(sock)).code, "  ", newPass()), DEVICE.phone),
      number: await pair(door.url, body((await code(sock)).code, 15550000001, newPass()), DEVICE.phone),
    };
    expect(Object.fromEntries(Object.entries(refusals).map(([name, answer]) => [name, [answer.status, answer.body.code]]))).toEqual({
      mac: [422, "PAIR_ACCOUNT"], colon: [422, "PAIR_REQUEST"], empty: [422, "PAIR_REQUEST"], number: [422, "PAIR_REQUEST"],
    });
    const byNumber = await pair(door.url, body((await code(sock)).code, "+1 (555) 000-0009", newPass()), DEVICE.phone);
    expect(Object.keys((byNumber.body.answer as Record<string, unknown>).sources as object)).toContain("apple-health:+15550000009:cloud");
    const sources = readHome(root, (db) => db.prepare("SELECT id, connector FROM sources WHERE id LIKE 'apple-health:%' OR id LIKE ? ORDER BY id").all(`%:${unit}`));
    expect(sources.filter((row) => (row as { id: string }).id.startsWith("apple-health:"))).toEqual([
      { id: "apple-health:+15550000009:cloud", connector: "health-ios-bundle" }, { id: "apple-health:person-a@example.com:cloud", connector: "health-ios-bundle" },
    ]);
    const passes = readPrincipals(openHomeFolder(root)).principals.filter((row) => row.kind === "phone");
    expect(passes.map((row) => [row.unit, row.account])).toEqual([[unit, "person-a@example.com"], [secondUnit, "person-a@example.com"], [expect.any(String), "+15550000009"]]);
    expect({ suggested: suggested.account, named: named.account }).toEqual({ suggested: "person-a@example.com", named: "person-d@example.com" });

    const later = newPass();
    const bare = await pair(door.url, { code: (await code(sock)).code, pass: later, kind: "phone", model: "iPhone 17 Pro", new: true }, DEVICE.phone);
    const bareUnit = bare.body.unit as string;
    const bareOwn = ["camera", "checkin", "energy", "location", "machine", "motion", "notes", "screen-time", "upload", "voice-notes"].map((product) => `${product}:local:${bareUnit}`);
    expect(Object.keys((bare.body.answer as Record<string, unknown>).sources as object)).toEqual(bareOwn.sort());
    expect(bare.body.answer).not.toHaveProperty("account");
    const accountAt = (pass_: string, header: Record<string, string>, body_: Record<string, unknown>) =>
      request(door.url, "POST", "/v1/account", { authorization: `Bearer ${pass_}`, ...header, "content-type": "application/json" }, JSON.stringify(body_));
    const unspelled = await accountAt(later, DEVICE.phone, { account: "person:b@example.com" });
    const stated = await accountAt(later, DEVICE.phone, { account: " Person-B@Example.com " });
    const laterAccount = ["apple-health:person-b@example.com:cloud", `apple-contacts:person-b@example.com:${bareUnit}`, `apple-photos:person-b@example.com:${bareUnit}`];
    expect([stated.status, stated.body.account, [...(stated.body.made as string[])].sort()]).toEqual([200, "person-b@example.com", laterAccount.sort()]);
    const afterStated = (await exchange(door.url, later, DEVICE.phone)).body;
    expect(Object.keys(afterStated.sources as object)).toEqual([...bareOwn, ...laterAccount].sort());
    expect(afterStated.account).toBe("person-b@example.com");
    expect(readHome(root, (db) => db.prepare("SELECT connector FROM sources WHERE id = ?").pluck().get(`apple-photos:person-b@example.com:${bareUnit}`))).toBe("photos-ios-bundle");
    const again = await accountAt(later, DEVICE.phone, { account: "person-c@example.com" });
    const paired_ = await accountAt(pass, DEVICE.phone, { account: "person-c@example.com" });
    expect([[unspelled.status, unspelled.body.code], [again.status, again.body.code], [paired_.status, paired_.body.code]])
      .toEqual([[422, "ACCOUNT_REQUEST"], [409, "ACCOUNT_SET"], [409, "ACCOUNT_SET"]]);
    expect(String(again.body.message)).toContain("person-b@example.com");
    expect([(await exchange(door.url, later, DEVICE.phone)).body.account, (await exchange(door.url, pass, DEVICE.phone)).body.account]).toEqual(["person-b@example.com", "person-a@example.com"]);
    expect(readPrincipals(openHomeFolder(root)).principals.find((row) => row.unit === bareUnit)?.account).toBe("person-b@example.com");
    report.phone_pairing = { paired: paired.body, suggested, named, refusals: Object.fromEntries(Object.entries(refusals).map(([name, answer]) => [name, answer.body])), sources, stated: stated.body, again: again.body };
  });
});

function machineBundle(seal: number, at_ms: number, lost?: { items: number; what: string }[]) {
  const line = `{"at":"${new Date(at_ms).toISOString()}","event":"sleep","detail":{"seal":${seal}}}\n`;
  return acquisitionBundle({
    source: MACHINE, fetched_ms: at_ms, files: [[`${new Date(at_ms).toISOString()}.jsonl`, Buffer.from(line)]],
    custody: { [MACHINE]: { seal, ...(lost === undefined ? {} : { lost }) } },
  });
}

describe("custody", () => {
  it("a Mac ships seals 1 to 4, a stale seal is refused with the answer, its loss of rows is kept as it said it and no notice, and a restore of the folder at seal 2 takes seal 3 again", async () => {
    let { root, door, home, sock } = await running("lifestream-custody-");
    const pass = newPass();
    await pair(door.url, { code: (await code(sock)).code, pass, kind: "mac", model: "MacBook Pro", serial4: "0001" });
    const T0 = Date.now() - 3_600_000;
    const ship = async (bundle: ReturnType<typeof machineBundle>) => request(door.url, "PUT", bundle.path, { authorization: `Bearer ${pass}`, ...DEVICE.mac }, bundle.bytes);
    const answer = async () => (await exchange(door.url, pass, DEVICE.mac)).body;
    const imported = (n: number) =>
      until(`seal ${n} imported`, () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE source = ? AND state = 'imported'").pluck().get(MACHINE)) === n);
    const seen: Record<string, unknown> = {};

    for (const seal of [1, 2]) expect((await ship(machineBundle(seal, T0 + seal * 60_000))).status).toBe(201);
    await imported(2);
    seen.at_two = custodyOf(await answer())[MACHINE];

    await door.stop();
    await home.stop();
    const copy = `${root}-at-seal-2`;
    removeAtEnd(copy);
    cpSync(root, copy, { recursive: true });
    door = await doorHere(root, { registry: FAKES });
    home = await homeOn(root);

    const lost = [{ items: 12, what: "messages the app pruned before they were carried" }];
    const third = machineBundle(3, T0 + 3 * 60_000, lost);
    const shipped3 = await ship(third);
    expect(custodyOf(shipped3.body)[MACHINE]).toEqual([3, expect.any(Number)]);
    expect((await ship(machineBundle(4, T0 + 4 * 60_000))).status).toBe(201);
    await imported(4);
    const after = await answer();
    seen.at_four = custodyOf(after)[MACHINE];
    expect((after.needs as { id: string }[]).filter((each) => each.id.startsWith("lost:"))).toEqual([]);
    const status = (await askHome(sock, "status", ["--json"])) as { needs: { id: string }[]; notices: { id: string }[] };
    expect({
      claim: readHome(root, (db) => db.prepare("SELECT lost FROM deliveries WHERE id = ? AND source = ?").pluck().get(third.id, MACHINE)),
      notices: [...status.needs, ...status.notices].filter((each) => each.id.startsWith("lost:")),
    }).toEqual({ claim: JSON.stringify(lost), notices: [] });

    const stale = await ship(machineBundle(4, T0 + 5 * 60_000));
    const ahead = await ship(machineBundle(6, T0 + 6 * 60_000));
    expect([stale.status, stale.body.code, ahead.status, ahead.body.code]).toEqual([409, "STALE", 409, "STALE"]);
    expect(custodyOf(stale.body.answer as Record<string, unknown>)[MACHINE]).toEqual([4, 4]);
    expect((await ship(third)).status).toBe(200);
    seen.stale = stale.body;

    await door.stop();
    await home.stop();
    const newer = join(root, "door", "custody.db");
    const kept = `${root}-custody.db`;
    removeAtEnd(kept);
    cpSync(newer, kept);
    rmSync(root, { recursive: true, force: true });
    cpSync(copy, root, { recursive: true });
    for (const suffix of ["-wal", "-shm"]) rmSync(`${newer}${suffix}`, { force: true });
    cpSync(kept, newer);
    door = await doorHere(root);
    home = await homeOn(root);
    seen.restored = custodyOf(await answer())[MACHINE];
    expect((await ship(machineBundle(4, T0 + 7 * 60_000))).status).toBe(409);
    const again = await ship(machineBundle(3, T0 + 8 * 60_000));
    expect(again.status).toBe(201);
    await imported(3);
    seen.after_restore = custodyOf(await answer())[MACHINE];
    expect(seen).toMatchObject({ at_two: [2, 2], at_four: [4, 4], restored: [2, 2], after_restore: [3, 3] });
    report.mac_custody = seen;
  });

  it("a door cache a cut disk tore is made again from the inbox: the Mac's custody stands and its next seal is taken", async () => {
    let { root, door, home, sock } = await running("lifestream-custody-torn-");
    const pass = newPass();
    await pair(door.url, { code: (await code(sock)).code, pass, kind: "mac", model: "MacBook Pro", serial4: "0001" });
    const T0 = Date.now() - 3_600_000;
    const ship = async (bundle: ReturnType<typeof machineBundle>) => request(door.url, "PUT", bundle.path, { authorization: `Bearer ${pass}`, ...DEVICE.mac }, bundle.bytes);
    const imported = (n: number) =>
      until(`seal ${n} imported`, () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE source = ? AND state = 'imported'").pluck().get(MACHINE)) === n);
    for (const seal of [1, 2]) expect((await ship(machineBundle(seal, T0 + seal * 60_000))).status).toBe(201);
    await imported(2);

    await door.stop();
    await home.stop();
    const cache = join(root, "door", "custody.db");
    const bytes = readFileSync(cache);
    expect(bytes.length).toBeGreaterThan(2 * 4096);
    bytes.fill(0xa5, 4096, 2 * 4096);
    writeFileSync(cache, bytes);
    door = await doorHere(root);
    home = await homeOn(root);

    const answered = custodyOf((await exchange(door.url, pass, DEVICE.mac)).body)[MACHINE];
    expect((await ship(machineBundle(3, T0 + 3 * 60_000))).status).toBe(201);
    await imported(3);
    const after = custodyOf((await exchange(door.url, pass, DEVICE.mac)).body)[MACHINE];
    expect({ answered, after }).toEqual({ answered: [2, 2], after: [3, 3] });
    report.torn_cache = { answered, after };
  });

  it("a purge of the newest seal and a door start: the seal is never taken again, and the next bundle is never answered imported before its import", async () => {
    let { root, door, home, sock } = await running("lifestream-custody-purge-");
    const pass = newPass();
    await pair(door.url, { code: (await code(sock)).code, pass, kind: "mac", model: "MacBook Pro", serial4: "0001" });
    const T0 = Date.now() - 3_600_000;
    const ship = async (bundle: ReturnType<typeof machineBundle>) => request(door.url, "PUT", bundle.path, { authorization: `Bearer ${pass}`, ...DEVICE.mac }, bundle.bytes);
    const imported = (n: number) =>
      until(`seal ${n} imported`, () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE source = ? AND state = 'imported'").pluck().get(MACHINE)) === n);
    const bundles = [1, 2, 3].map((seal) => machineBundle(seal, T0 + seal * 60_000));
    for (const bundle of bundles) expect((await ship(bundle)).status).toBe(201);
    await imported(3);

    await door.stop();
    await home.stop();
    rmSync(join(root, "inbox", ...bundles[2]!.id.split("/")), { recursive: true });
    door = await doorHere(root);
    const again = await ship(machineBundle(3, T0 + 5 * 60_000));
    const answered = custodyOf(again.body.answer as Record<string, unknown>)[MACHINE];
    const next = await ship(machineBundle(4, T0 + 6 * 60_000));
    const before = custodyOf(next.body)[MACHINE];
    home = await homeOn(root);
    await imported(4);
    const after = custodyOf((await exchange(door.url, pass, DEVICE.mac)).body)[MACHINE];
    expect({ answered, again: [again.status, again.body.code], next: next.status, before, after })
      .toEqual({ answered: [3, 3], again: [409, "STALE"], next: 201, before: [4, 3], after: [4, 4] });
    report.purged_seal = { answered, before, after };
  });

  it("refuses a phone bundle whole when one of its three sources states a stale seal", async () => {
    const { root, door, sock } = await running("lifestream-custody-phone-");
    const pass = newPass();
    const paired = await pair(door.url, { code: (await code(sock)).code, pass, kind: "phone", model: "iPhone 17 Pro" }, DEVICE.phone);
    const unit = paired.body.unit as string;
    const [location, motion, checkin] = ["location", "motion", "checkin"].map((product) => `${product}:local:${unit}`) as [string, string, string];
    const ship = async (seals: [number, number, number], first: number) => {
      const bundle = phoneBundle({
        domains: { "location.jsonl": [first], "motion.jsonl": [first], "checkin.jsonl": [first] }, second: first,
        custody: { [location]: { seal: seals[0] }, [motion]: { seal: seals[1] }, [checkin]: { seal: seals[2] } },
      });
      return request(door.url, "PUT", `/v1/bundles/${bundle.id}`, { authorization: `Bearer ${pass}`, ...DEVICE.phone }, bundle.bytes);
    };
    const held = () => ["location", "motion", "checkin"].map((product) => custodyOf(paired.body.answer as Record<string, unknown>)[`${product}:local:${unit}`]);
    expect(held()).toEqual([[0, 0], [0, 0], [0, 0]]);
    const copy = phoneBundle({ domains: { "location.jsonl": [1] }, custody: {} });
    const missing = await request(door.url, "PUT", `/v1/bundles/${copy.id}`, { authorization: `Bearer ${pass}`, ...DEVICE.phone }, copy.bytes);
    expect([missing.status, missing.body.code]).toEqual([422, "CUSTODY_MISSING"]);
    report.phone_copy = missing.body;
    const half = phoneBundle({ domains: { "location.jsonl": [1], "motion.jsonl": [1] }, custody: { [location]: { seal: 1 } } });
    const unnamed = await request(door.url, "PUT", `/v1/bundles/${half.id}`, { authorization: `Bearer ${pass}`, ...DEVICE.phone }, half.bytes);
    expect([unnamed.status, unnamed.body.code, unnamed.body.message]).toEqual([422, "CUSTODY_MISSING", `the bundle carries data of ${motion}, and its custody states no seal of it`]);
    expect(existsSync(join(root, "inbox", `phone:${unit}`, half.id))).toBe(false);
    expect((await ship([1, 1, 1], 1)).status).toBe(201);
    const refused = await ship([2, 2, 1], 2);
    expect([refused.status, refused.body.code]).toEqual([409, "STALE"]);
    expect(refused.body.message).toContain(`${checkin} states seal 1; the home has received 1`);
    const answer = custodyOf(refused.body.answer as Record<string, unknown>);
    expect([answer[location]![0], answer[motion]![0], answer[checkin]![0]]).toEqual([1, 1, 1]);
    expect(readdirSync(join(root, "inbox", `phone:${unit}`)).filter((name) => name !== "blobs")).toHaveLength(1);
    expect((await ship([2, 2, 2], 2)).status).toBe(201);
    report.phone_stale = refused.body;
  });
});

describe("the custody rebuild", () => {
  it("logs one line at each door start once custody is rebuilt: its time, the lanes listed and the manifests read", async () => {
    const at = makeHome({ mac: { kind: "mac", scopes: ["deliver"], sources: [MACHINE] } }, []);
    removeAtEnd(at.root);
    const lines: Record<string, unknown>[] = [];
    const open = async () => {
      const door = await serveDoor(at.root, { port: 0, max_bundle_bytes: 1 << 30 }, { lookMs: LOOK_MS, log: (line) => lines.push(JSON.parse(line) as Record<string, unknown>) });
      onTestFinished(() => door.close());
      return door;
    };
    const rebuilt = () => lines.filter((line) => line.custody === "rebuilt").map(({ at: _at, ms, ...rest }) => ({ ms: typeof ms, ...rest }));
    const first = await open();
    expect(rebuilt()).toEqual([{ ms: "number", custody: "rebuilt", lanes: 0, manifests_read: 0 }]);
    const T0 = Date.now() - 3_600_000;
    for (const seal of [1, 2]) {
      const bundle = machineBundle(seal, T0 + seal * 60_000);
      expect((await request(`http://127.0.0.1:${first.port}`, "PUT", bundle.path, { authorization: `Bearer ${at.tokens.mac}`, ...DEVICE.mac }, bundle.bytes)).status).toBe(201);
    }
    await first.close();
    for (const file of ["custody.db", "custody.db-wal", "custody.db-shm"]) rmSync(join(at.root, "door", file), { force: true });
    await open();
    expect(rebuilt()).toEqual([
      { ms: "number", custody: "rebuilt", lanes: 0, manifests_read: 0 },
      { ms: "number", custody: "rebuilt", lanes: 1, manifests_read: 2 },
    ]);
    report.custody_rebuilt = lines.filter((line) => line.custody === "rebuilt");
  });
});

async function phoneOf(at: () => string, sock: HomeSocket, account: string, { install, replaces }: { install?: string; replaces?: string } = {}) {
  const pass = newPass();
  const paired = await pair(at(), { code: (await code(sock, replaces)).code, pass, kind: "phone", model: "iPhone 17 Pro", account, ...(replaces === undefined ? { new: true } : {}) }, DEVICE.phone);
  const unit = paired.body.unit as string;
  let second = 0;
  const ship = async (input: Parameters<typeof phoneBundle>[0]) => {
    const bundle = phoneBundle({ ...input, second: ++second, ...(install === undefined ? {} : { install }) });
    return request(at(), "PUT", `/v1/bundles/${bundle.id}`, { authorization: `Bearer ${pass}`, ...DEVICE.phone }, bundle.bytes);
  };
  return { pass, unit, ship, answer: async () => custodyOf((await exchange(at(), pass, DEVICE.phone)).body) };
}

const importedCount = (root: string, source: string, pass?: string) => readHome(root, (db) =>
  db.prepare("SELECT count(*) FROM deliveries WHERE source = ? AND state = 'imported' AND (? IS NULL OR pass = ?)").pluck().get(source, pass ?? null, pass ?? null)) as number;

describe("a source of the account", () => {
  it("a second phone of the Apple ID ships its Health, and it is never imported, or one phone's seals stand for the other's", async () => {
    const { root, door, sock } = await running("lifestream-custody-account-");
    const health = "apple-health:person-a@example.com:cloud";
    const a = await phoneOf(() => door.url, sock, "person-a@example.com");
    const b = await phoneOf(() => door.url, sock, "Person-A@example.com", { install: INSTALL_TWO });
    expect((await a.ship({ entries: { "health.jsonl": [healthLine(1)] }, custody: { [health]: { seal: 1 } } })).status).toBe(201);
    expect((await b.ship({ entries: { "health.jsonl": [healthLine(1), healthLine(2)] }, custody: { [health]: { seal: 1 } } })).status).toBe(201);
    await until("both phones' health imported", () => importedCount(root, health) === 2);
    const first = { a: (await a.answer())[health], b: (await b.answer())[health] };
    expect((await a.ship({ entries: { "health.jsonl": [healthLine(2)] }, custody: { [health]: { seal: 2 } } })).status).toBe(201);
    await until("phone A's second seal imported", () => importedCount(root, health) === 3);
    const then = { a: (await a.answer())[health], b: (await b.answer())[health] };
    expect({ first, then }).toEqual({ first: { a: [1, 1], b: [1, 1] }, then: { a: [2, 2], b: [1, 1] } });
    const ids = Object.fromEntries(readPrincipals(openHomeFolder(root)).principals.map((row) => [row.id, row.unit === a.unit ? "a" : "b"]));
    const passes = (readHome(root, (db) => db.prepare("SELECT pass, seal, state FROM deliveries WHERE source = ? ORDER BY sealed_ms").all(health)) as { pass: string }[])
      .map((row) => ({ ...row, pass: ids[row.pass] }));
    expect(passes).toEqual([{ pass: "a", seal: 1, state: "imported" }, { pass: "b", seal: 1, state: "imported" }, { pass: "a", seal: 2, state: "imported" }]);
    report.account_source = { first, then, deliveries: passes };
  });

  it("a phone that replaces its unit under another Apple ID ships its Health into the old account's source too", async () => {
    const { root, door, sock } = await running("lifestream-custody-replaced-");
    const a = await phoneOf(() => door.url, sock, "person-a@example.com");
    const healthA = "apple-health:person-a@example.com:cloud";
    const healthB = "apple-health:person-b@example.com:cloud";
    expect((await a.ship({ entries: { "health.jsonl": [healthLine(1)] }, custody: { [healthA]: { seal: 1 } } })).status).toBe(201);
    await until("phone A's health imported", () => importedCount(root, healthA) === 1);
    const before = { a: (await a.answer())[healthA], records: readHome(root, (db) => db.prepare("SELECT count(*) FROM heads WHERE source = ?").pluck().get(healthA)) };
    const b = await phoneOf(() => door.url, sock, "person-b@example.com", { install: INSTALL_TWO, replaces: a.unit });
    expect(b.unit).toBe(a.unit);
    expect((await b.ship({ entries: { "health.jsonl": [healthLine(1), healthLine(2)] }, custody: { [healthB]: { seal: 1 } } })).status).toBe(201);
    await until("phone B's health imported", () => importedCount(root, healthB) === 1);
    await askHome(sock, "run", ["index-inbox", "inbox"]);
    await until("both Health sources read", () => readHome(root, (db) =>
      db.prepare("SELECT count(*) FROM deliveries WHERE source IN (?, ?) AND state IN ('sealed', 'importing')").pluck().get(healthA, healthB)) === 0);
    const ids = Object.fromEntries(readPrincipals(openHomeFolder(root)).principals.map((row) => [row.id, row.account === "person-a@example.com" ? "a" : "b"]));
    const fed = (readHome(root, (db) => db.prepare("SELECT source, pass FROM deliveries WHERE source IN (?, ?) ORDER BY sealed_ms, source").all(healthA, healthB)) as { source: string; pass: string }[])
      .map((row) => [row.source === healthA ? "A" : "B", ids[row.pass]]);
    const after = { a: (await a.answer())[healthA], records: readHome(root, (db) => db.prepare("SELECT count(*) FROM heads WHERE source = ?").pluck().get(healthA)) };
    expect({ fed, after }).toEqual({ fed: [["A", "a"], ["B", "b"]], after: before });
    report.replaced_unit = { fed, before, after };
  });

  it("takes a file from a replaced phone's pass, which reads nothing, so the files it holds reach the home", async () => {
    const { door, sock } = await running("lifestream-custody-replaced-file-");
    const a = await phoneOf(() => door.url, sock, "person-a@example.com");
    const b = await phoneOf(() => door.url, sock, "person-b@example.com", { install: INSTALL_TWO, replaces: a.unit });
    expect((await b.ship({ entries: { "health.jsonl": [healthLine(1)] }, custody: { "apple-health:person-b@example.com:cloud": { seal: 1 } } })).status).toBe(201);
    const bytes = Buffer.from("synthetic photo the replaced install still holds");
    const headers = { authorization: `Bearer ${a.pass}`, ...DEVICE.phone };
    const sent = await request(door.url, "PUT", `/v1/files/sha256:${sha256(bytes)}`, headers, bytes);
    const read = await request(door.url, "GET", "/v1/me", headers);
    expect([sent.status, read.status, read.body.code]).toEqual([201, 403, "PRINCIPAL_SCOPE"]);
  });
});

describe("a cleared file", () => {
  it("a home restored below a seal whose photos the phone cleared refuses its resent rows, takes more missing files than it says it lost, lands them silent, or says so of files it holds or once they arrive", async () => {
    let { root, door, home, sock } = await running("lifestream-custody-lost-");
    const phone = await phoneOf(() => door.url, sock, "person-a@example.com");
    const photos = `apple-photos:person-a@example.com:${phone.unit}`;
    const photo = (n: number) => Buffer.from(`synthetic jpeg bytes of photo ${n}`);
    const ship = (seal: number, lines: number[], carried: number[], lost?: number) => phone.ship({
      entries: { "photos.jsonl": lines.map((n) => photoLine(n, photo(n))) }, blobs: carried.map(photo),
      custody: { [photos]: { seal, ...(lost === undefined ? {} : { lost: [{ items: lost, what: "photo copies this phone cleared once the home had imported them" }] }) } },
    });
    for (const seal of [1, 2, 3, 4]) expect((await ship(seal, [seal], [seal])).status).toBe(201);
    await until("seals 1 to 4 imported", () => importedCount(root, photos) === 4);
    await door.stop();
    await home.stop();
    const copy = `${root}-at-seal-4`;
    removeAtEnd(copy);
    cpSync(root, copy, { recursive: true });
    const restart = async () => {
      door = await doorHere(root);
      home = await homeOn(root);
    };
    await restart();
    expect((await ship(5, [5], [5])).status).toBe(201);
    await until("seal 5 imported", () => importedCount(root, photos) === 5);
    await door.stop();
    await home.stop();
    rmSync(root, { recursive: true, force: true });
    cpSync(copy, root, { recursive: true });
    await restart();
    const restored = (await exchange(door.url, phone.pass, DEVICE.phone)).body;
    expect(custodyOf(restored)[photos]).toEqual([4, 4]);
    const tooMany = await ship(5, [5, 6], [], 1);
    expect([tooMany.status, tooMany.body.code, tooMany.body.missing]).toEqual([409, "FILES_MISSING", { files: [5, 6].map((n) => `sha256:${sha256(photo(n))}`) }]);
    const resent = await ship(5, [5], [], 1);
    expect(resent.status).toBe(201);
    expect((await ship(6, [4], [], 1)).status).toBe(201);
    await until("seals 5 and 6 imported after the restore", () => importedCount(root, photos) === 6);
    const hash = `sha256:${sha256(photo(5))}`;
    const said = JSON.stringify([{ items: 1, what: "photo copies this phone cleared once the home had imported them" }]);
    const held = readHome(root, (db) => ({
      lost: db.prepare("SELECT seal, lost FROM deliveries WHERE source = ? AND lost IS NOT NULL ORDER BY seal").all(photos),
      linked: db.prepare("SELECT count(*) FROM version_blobs WHERE blob = ?").pluck().get(hash),
      wanted: db.prepare("SELECT source, kind, key FROM wanted_blobs WHERE blob = ?").all(hash),
    }));
    expect(held).toEqual({
      lost: [{ seal: 5, lost: said }, { seal: 6, lost: said }],
      linked: 1, wanted: [{ source: photos, kind: "img", key: "SYNTHETIC-ASSET-5:null" }],
    });
    const lostNotices = () => statusOf(root, { now_ms: Date.now(), settings: readOpsSettings(root) }).notices.filter((each) => each.id.startsWith("lost:"));
    const needs = ((await exchange(door.url, phone.pass, DEVICE.phone)).body.needs as { id: string }[]).filter((each) => each.id.startsWith("lost:"));
    expect(needs.map((each) => each.id)).toEqual([`lost:${photos}`]);
    const seal5 = readHome(root, (db) => db.prepare("SELECT id FROM deliveries WHERE source = ? AND seal = 5 AND state = 'imported'").pluck().get(photos)) as string;
    const standing = lostNotices();
    expect(standing).toEqual([expect.objectContaining({
      id: `lost:${seal5}:${photos}`,
      what: `1\u00a0file of ${photos} is missing; ${phone.unit} said it cleared it (seal 5); it comes back only if a device carries it again: 1 photo copies this phone cleared once the home had imported them`,
    })]);
    expect((await ship(7, [5, 6], [5, 6])).status).toBe(201);
    await until("seal 7 imported", () => importedCount(root, photos) === 7);
    const arrived = { wanted: readHome(root, (db) => db.prepare("SELECT count(*) FROM wanted_blobs WHERE blob = ?").pluck().get(hash)), notices: lostNotices() };
    expect(arrived).toEqual({ wanted: 0, notices: [] });
    const edited = Buffer.from("synthetic jpeg bytes of photo 5, edited");
    expect((await phone.ship({
      entries: { "photos.jsonl": [photoLine(5, edited)] },
      custody: { [photos]: { seal: 8, lost: [{ items: 1, what: "photo copies this phone cleared once the home had imported them" }] } },
    })).status).toBe(201);
    await until("seal 8 imported", () => importedCount(root, photos) === 8);
    const seal8 = readHome(root, (db) => db.prepare("SELECT id FROM deliveries WHERE source = ? AND seal = 8").pluck().get(photos)) as string;
    const later = lostNotices().map((each) => each.id);
    expect(later).toEqual([`lost:${seal8}:${photos}`]);
    report.cleared_file = { restored: custodyOf(restored), too_many: tooMany.body, resent: resent.body, held, standing, arrived, later };
  });
});

describe("a contact's cleared photo", () => {
  it("a fresh home sent the contacts log, its cleared photos stated lost, is broken only until each contact's photo now arrives", async () => {
    const { root, door, sock } = await running("lifestream-custody-contacts-");
    const phone = await phoneOf(() => door.url, sock, "person-a@example.com");
    const book = `apple-contacts:person-a@example.com:${phone.unit}`;
    const image = (name: string) => Buffer.from(`synthetic jpeg bytes of ${name}`);
    const [before, now, deleted] = [image("contact A then"), image("contact A now"), image("contact D")];
    const card = (sequence: number, id: string, photo: Buffer) => ({
      domain: "contacts", kind: "card", sequence, observed_at: "2026-08-31T04:40:00Z", captured: { wall_rfc3339: "2026-08-31T10:00:00.125+05:30" },
      payload: { id, card: `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Person ${id}\r\nEND:VCARD\r\n`, serializer: "CNContactVCardSerialization",
        photo: { hash: `sha256:${sha256(photo)}`, bytes: photo.length, media_type: "image/jpeg" } },
    }) as { sequence: number };
    const gone = (sequence: number, id: string) =>
      ({ domain: "contacts", kind: "gone", sequence, observed_at: "2026-08-31T04:40:00Z", captured: { wall_rfc3339: "2026-08-31T10:00:00.125+05:30" }, payload: { id } }) as { sequence: number };
    const cleared = (items: number) => [{ items, what: "photo copies this phone cleared once the home had imported them" }];
    const lost = async () => ({
      needs: ((await exchange(door.url, phone.pass, DEVICE.phone)).body.needs as { id: string }[]).filter((each) => each.id.startsWith("lost:")).map((each) => each.id),
      notices: statusOf(root, { now_ms: Date.now(), settings: readOpsSettings(root) }).notices.filter((each) => each.id.startsWith("lost:")).length,
      wanted: readHome(root, (db) => db.prepare("SELECT count(DISTINCT blob) FROM wanted_blobs WHERE source = ?").pluck().get(book)),
    });
    expect((await phone.ship({ entries: { "contacts.jsonl": [card(1, "A", before), card(2, "D", deleted)] },
      custody: { [book]: { seal: 1, lost: cleared(2) } } })).status).toBe(201);
    await until("the old log imported", () => importedCount(root, book) === 1);
    const first = await lost();
    expect((await phone.ship({ entries: { "contacts.jsonl": [card(3, "A", now), gone(4, "D")] }, blobs: [now], custody: { [book]: { seal: 2 } } })).status).toBe(201);
    await until("the restatement imported", () => importedCount(root, book) === 2);
    const restated = await lost();
    expect({ first, restated }).toEqual({
      first: { needs: [`lost:${book}`], notices: 1, wanted: 2 },
      restated: { needs: [], notices: 0, wanted: 0 },
    });
    report.contact_photos = { first, restated };
  });
});

describe("bundles side by side", () => {
  it("a location bundle that names Photos sat out while a photos bundle is in flight moves location's read-through and not Photos'; the photos bundle, sealed after it, imports in order", async () => {
    const { root, door, sock } = await running("lifestream-custody-side-");
    const phone = await phoneOf(() => door.url, sock, "person-a@example.com");
    const photos = `apple-photos:person-a@example.com:${phone.unit}`, location = `location:local:${phone.unit}`;
    const photo = (n: number) => Buffer.from(`synthetic jpeg bytes of photo ${n}`);
    const readThrough = (source: string) => readHome(root, (db) => db.prepare("SELECT read_through_ms FROM sources WHERE id = ?").pluck().get(source)) as number | null;
    const records = (source: string) => readHome(root, (db) => db.prepare("SELECT count(*) FROM heads WHERE source = ? AND version <> 'gone'").pluck().get(source)) as number;
    const uploads = () => readdirSync(join(root, "door", "uploads")).length;
    const headers = { authorization: `Bearer ${phone.pass}`, ...DEVICE.phone };
    expect((await phone.ship({ domains: { "location.jsonl": [1] }, entries: { "photos.jsonl": [photoLine(1, photo(1))] }, blobs: [photo(1)],
      custody: { [location]: { seal: 1 }, [photos]: { seal: 1 } } })).status).toBe(201);
    await until("seal 1 of both imported", () => importedCount(root, location) === 1 && importedCount(root, photos) === 1);
    const before = { location: readThrough(location), photos: readThrough(photos) };
    const big = phoneBundle({ entries: { "photos.jsonl": [photoLine(2, photo(2))] }, blobs: [photo(2)], custody: { [photos]: { seal: 2 } }, second: 2 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sent) { sent = true; controller.enqueue(big.bytes.subarray(0, 10)); return; }
        await gate;
        controller.enqueue(big.bytes.subarray(10));
        controller.close();
      },
    });
    const inFlight = fetch(`${door.url}/v1/bundles/${big.id}`, { method: "PUT", headers: { ...headers, "content-length": String(big.bytes.length) }, body, duplex: "half" } as RequestInit);
    await until("the photos bundle's upload under way", () => uploads() > 0);
    const beside = phoneBundle({ domains: { "location.jsonl": [2] }, custody: { [location]: { seal: 2 } }, satOut: [photos], second: 3 });
    expect((await request(door.url, "PUT", `/v1/bundles/${beside.id}`, headers, beside.bytes)).status).toBe(201);
    await until("location's bundle imported", () => importedCount(root, location) === 2);
    expect(readHome(root, (db) => db.prepare("SELECT source FROM deliveries WHERE id = ?").pluck().all(`phone:${phone.unit}/${beside.id}`))).toEqual([location]);
    const sideBySide = { location: readThrough(location), photos: readThrough(photos), photo_records: records(photos) };
    expect(sideBySide.location).toBeGreaterThan(before.location!);
    expect([sideBySide.photos, sideBySide.photo_records]).toEqual([before.photos, 1]);
    release();
    const landed = await inFlight;
    expect(landed.status).toBe(201);
    const answer = custodyOf(await landed.json() as Record<string, unknown>);
    expect([answer[location], answer[photos]![0]]).toEqual([[2, 2], 2]);
    await until("the photos bundle imported", () => importedCount(root, photos) === 2);
    const order = (readHome(root, (db) => db.prepare("SELECT id FROM deliveries WHERE source = ? ORDER BY sealed_ms").pluck().all(photos)) as string[])
      .map((id) => id.slice(id.indexOf("/") + 1));
    const after = { location: readThrough(location), photos: readThrough(photos), photo_records: records(photos) };
    expect(order.slice(1)).toEqual([big.id]);
    expect(after.photo_records).toBe(2);
    expect(after.photos).toBeGreaterThan(before.photos!);
    expect(after.photos).toBeLessThan(sideBySide.location!);
    expect(after.location).toBe(sideBySide.location);
    report.side_by_side = { before, side_by_side: sideBySide, after, order };
  });
});

describe("the nudge", () => {
  it("a door that holds its turn past a second after a seal loses the nudge; a seal imports before an earlier one the home has not found, or waits silently", async () => {
    const root = makeRoot("lifestream-nudge-", { sources: { [NUDGED]: "fake-rows" } });
    removeAtEnd(root);
    const home = childOn(root);
    home.start();
    await home.ready();
    const sock = testSocket(root);
    const indexed = (id: string) => (readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE id = ?").pluck().get(id)) as number) > 0;
    await until("the start's inbox index", () => readHome(root, (db) => db.prepare("SELECT state FROM jobs WHERE kind = 'index-inbox'").pluck().get()) === "done");
    const lone = await ship(root, { source: NUDGED, fetched_ms: Date.now() - 60_000, rows: [{ kind: "note", key: "n1", content: { text: "synthetic", at: 0 }, at: 0 }] }, false);
    const held = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", [
      `import { writeFile } from "node:fs/promises";`, `import { nudges } from ${JSON.stringify(join(REPO, "packages", "home", "nudges.ts"))};`,
      "await new Promise((resolve) => setTimeout(resolve, 100));",
      `await writeFile(${JSON.stringify(join(root, "turn"))}, "a write the door's turn resumes from");`,
      `nudges(${JSON.stringify(sock)}, () => undefined).owe(${JSON.stringify(lone)});`, "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);",
    ].join("\n")], { cwd: REPO, encoding: "utf8" });
    expect(held.status, held.stderr).toBe(0);
    await until("the delivery indexed by its nudge", () => indexed(lone));

    const door: Door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { lookMs: LOOK_MS, log: () => undefined });
    const url = `http://127.0.0.1:${door.port}`;
    try {
      const pass = newPass();
      await pair(url, { code: (await code(sock)).code, pass, kind: "mac", model: "MacBook Pro", serial4: "0001" });
      const T0 = Date.now() - 3_600_000;
      const ship_ = async (seal: number) => {
        const bundle = machineBundle(seal, T0 + seal * 60_000);
        expect((await request(url, "PUT", bundle.path, { authorization: `Bearer ${pass}`, ...DEVICE.mac }, bundle.bytes)).status).toBe(201);
        return bundle.id;
      };
      const first = await ship_(1);
      await until("seal 1 indexed", () => indexed(first));
      renameSync(sock.path, `${sock.path}.aside`);
      const second = await ship_(2);
      renameSync(`${sock.path}.aside`, sock.path);
      const third = await ship_(3);
      await until("seal 3 indexed", () => indexed(third));
      const at = readHome(root, (db) => db.prepare("SELECT max(at_ms) FROM events WHERE kind = 'delivery' AND key = ?").pluck().get(third)) as number;
      await until("the import ran after seal 3 was indexed", () => readHome(root, (db) =>
        db.prepare("SELECT ended_ms FROM jobs WHERE kind = 'import' AND key = ? AND state = 'done'").pluck().get(MACHINE) as number | undefined ?? 0) >= at);
      const waiting = {
        states: readHome(root, (db) => db.prepare("SELECT seal, state FROM deliveries WHERE source = ? ORDER BY seal").all(MACHINE)),
        seal: statusOf(root, { now_ms: Date.now() + 11 * 60_000, settings: readOpsSettings(root) }).notices.filter((each) => each.id.startsWith("seal:")).map((each) => each.what),
      };
      expect(waiting).toEqual({
        states: [{ seal: 1, state: "imported" }, { seal: 3, state: "sealed" }],
        seal: [expect.stringContaining(`${MACHINE} waits at ${MAC_UNIT}'s seal 3 for seal 2`)],
      });
      await askHome(sock, "run", ["index-inbox", "inbox"]);
      await until("seals 2 and 3 imported", () => importedCount(root, MACHINE) === 3);
      const order = readHome(root, (db) => db.prepare("SELECT id FROM deliveries WHERE source = ? ORDER BY run").pluck().all(MACHINE));
      expect(order).toEqual([first, second, third]);
      report.nudge = { waiting, order };
    } finally {
      await door.close();
    }
  });
});
