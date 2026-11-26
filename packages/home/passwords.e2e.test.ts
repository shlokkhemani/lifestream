import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Worker } from "node:worker_threads";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { homeSecrets, keyId } from "@lifestreamprotocol/core";
import { runCli } from "./cli.js";
import { startHome, type Home } from "./home.js";
import { machine, type Machine } from "./machine.js";
import { ask, askHome, type HomeSocket } from "./socket.js";
import type { Need } from "./status.js";
import { artifact, FAKES, makeRoot, readHome, removeRoot, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { statusOf } from "./test/harness-status.js";
import { openWith, readVault, recoveryKey } from "./vault.js";
import { readOpsSettings } from "./verbs/index.js";
import { testSocket } from "./test/folder.js";


const PASSWORD = "x.password";
const FIRST = "fake-password-correct-horse";
const SECOND = "fake-password-battery-staple";
const THIRD = "fake-password-typed-again";
const FOURTH = "fake-password-asked-again";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const temps: string[] = [];

function testMachine(): Machine {
  const dir = (prefix: string) => {
    const made = mkdtempSync(join(tmpdir(), prefix));
    temps.push(made);
    return made;
  };
  const user = dir("lifestream-passwords-user-");
  mkdirSync(join(user, "Applications", "Lifestream.app"), { recursive: true });
  return machine({ env: { LIFESTREAM_MACHINE_DIR: dir("lifestream-passwords-machine-") }, home: user, system: dir("lifestream-passwords-system-") });
}

afterAll(() => {
  if (process.env.LIFESTREAM_KEEP_ARTIFACTS !== "1") for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("passwords: polls ask the home for their lane's secrets, and rotate through it", () => {
  let root: string;
  let home: Home | undefined;
  let sock: HomeSocket;
  const at = testMachine();
  const started = Date.now();
  let now = started;
  const logs: string[] = [];
  const slot = randomBytes(32);
  const another = randomBytes(32);
  let vaultKey: Buffer;
  let exposure: string;
  const seen: Record<string, unknown> = {};

  const pollSaid = (name = "fake-poll") => readHome(root, (db) => db.prepare("SELECT outcome || ' ' || coalesce(reason, '') FROM attempts WHERE target = ? ORDER BY at_ms DESC LIMIT 1").pluck().get(`fetch:${name}`) as string | undefined);
  const contents = (source = "apple-notes:local:poll") => readHome(root, (db) => (db.prepare("SELECT v.text FROM versions v JOIN heads h ON h.version = v.id WHERE v.kind = 'note' AND h.source = ? ORDER BY h.key").pluck().all(source) as string[])
    .map((text) => (JSON.parse(text) as { content: { password_sha256?: string; stolen?: string } }).content));
  const hashes = () => contents().map((content) => content.password_sha256);
  const needsAt = (now_ms: number): Need[] => statusOf(root, { now_ms, settings: readOpsSettings(root) }).needs;
  const ids = (needs: Need[]) => needs.map((need) => need.id).filter((id) => id.startsWith("password") || id === "vault:locked");
  const advance = () => { now += 2_000; };
  const cli = async (args: string[], input?: string) => {
    const lines: string[] = [];
    const status = await runCli([...args, "--root", root], { machine: at, write: (text) => lines.push(text), ...(input === undefined ? {} : { input: async () => input }) });
    return { status, out: lines.join("") };
  };
  const posted: string[] = [];
  const postMessage = Worker.prototype.postMessage;
  const spelled = (value: unknown): string => JSON.stringify(value, (_key, each: unknown) =>
    each instanceof Uint8Array ? `${Buffer.from(each).toString("hex")} ${Buffer.from(each).toString("base64")}` : each);
  let calls: string;
  const start = (slotKey: Buffer | null) => startHome(root, {
    registry: FAKES, clock: () => now, machine: at, slot: slotKey, log: (line) => logs.push(line),
    call: [process.execPath, join(calls, "call.mjs")],
  });

  beforeAll(async () => {
    exposure = mkdtempSync(join(tmpdir(), "lifestream-passwords-exposed-"));
    temps.push(exposure);
    calls = mkdtempSync(join(tmpdir(), "lifestream-passwords-calls-"));
    temps.push(calls);
    writeFileSync(join(calls, "call.mjs"), [
      'import { appendFileSync, readFileSync } from "node:fs";',
      "const stdin = readFileSync(0, \"utf8\");",
      "const env = Object.keys(process.env).filter((name) => name.startsWith(\"LIFESTREAM_SECRET\"));",
      `appendFileSync(${JSON.stringify(join(calls, "handed.jsonl"))}, JSON.stringify({ argv: process.argv.slice(2), env, stdin }) + "\\n");`,
      "process.exit(75);",
    ].join("\n"));
    Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: never[]) {
      posted.push(spelled(message));
      return postMessage.call(this, message, ...rest);
    };
    root = makeRoot("lifestream-passwords-", {
      sources: { "apple-notes:local:poll": "fake-rows", "apple-notes:local:poll-two": "fake-rows", "apple-notes:local:mac-0001": "fake-rows" }, clocks: true,
      settings: {
        "connectors.fake-poll": { refresh: "1s", password: PASSWORD, rotates: true, exposes: join(exposure, "helper.jsonl"), refuse_while: join(exposure, "refuse") }, "connectors.fake-poll-two": { refresh: "1s", rotates: true, steal: PASSWORD },
        "model.defaults.pictures": "openrouter:google/gemini-3.8-flash",
      },
    });
    sock = testSocket(root, at.dir);
    mkdirSync(join(root, "config", "secrets"), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "config", "secrets", "fake-poll-two"), "fake-token-plain\n", { mode: 0o600 });
    home = await start(null);

    await until("the poll waits for the vault", () => pollSaid() === "wait vault");
    await until("the rotating poll waits for the vault too", () => pollSaid("fake-poll-two") === "wait vault");
    seen.waitNeeds = needsAt(now + 60_000).filter((need) => need.id.startsWith("fetch:")).map((need) => need.id);
    seen.unkeyed = {
      files: readdirSync(join(root, "config", "secrets")), token: readFileSync(join(root, "config", "secrets", "fake-poll-two"), "utf8"),
      set: await cli(["secret", "set", PASSWORD], FIRST),
    };

    const made = (await ask(sock, { verb: "vault-init", slot_key: slot.toString("base64"), store: "keychain-login" })) as { recovery: string };
    vaultKey = openWith(readVault(root)!, "recovery", recoveryKey.parse(made.recovery))!.key;
    await ask(sock, { verb: "vault-confirm", recovery: made.recovery });
    seen.typed = await ask(sock, { verb: "seal", secret: PASSWORD, value: FIRST });
    advance();
    await until("the poll reads the sealed password", () => hashes().includes(sha(FIRST)));
    await until("the other lane's poll is answered", () => contents("apple-notes:local:poll-two").length > 0);
    seen.stolen = contents("apple-notes:local:poll-two")[0]!.stolen;
    seen.set = await cli(["secret", "set", PASSWORD], `${SECOND}\n`);
    advance();
    await until("the poll reads the password set", () => hashes().includes(sha(SECOND)));
    seen.requests = ((await ask(sock, { verb: "vault" })) as { requests: unknown[] }).requests;
    await ask(sock, { verb: "seal", secret: "openrouter", value: "fake-openrouter-key" });
    await ship(root, { source: "apple-notes:local:mac-0001", fetched_ms: Date.now() - 1_000, rows: [{ kind: "note", key: "photo-1", content: { text: "synthetic", at: Date.now() - 1_000, photo: true }, at: Date.now() - 1_000 }] }, { machineDir: at.dir });
    await until("a call is handed its key", () => existsSync(join(calls, "handed.jsonl")) && readFileSync(join(calls, "handed.jsonl"), "utf8").includes("fake-openrouter-key"));
    seen.handed = readFileSync(join(calls, "handed.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { argv: string[]; env: string[]; stdin: string });
    seen.callRequests = ((await ask(sock, { verb: "vault" })) as { requests: unknown[] }).requests;
    seen.forgot = {
      answers: [await ask(sock, { verb: "seal", secret: "openrouter", value: null }), await ask(sock, { verb: "seal", secret: "openrouter", value: null })],
      file: existsSync(join(root, "config", "secrets", "openrouter")),
      events: readHome(root, (db) => db.prepare("SELECT detail FROM events WHERE kind = 'secret' AND key = 'openrouter' ORDER BY seq").pluck().all() as string[]).map((detail) => JSON.parse(detail) as unknown),
    };
    const listedWith: (string | null)[] = [];
    const server = createServer((request, response) => {
      listedWith.push(request.headers.authorization ?? null);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "fake-hosted-model" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      await ask(sock, { verb: "seal", secret: "address", value: "fake-address-key" });
      await ask(sock, { verb: "models", args: ["--key", "--", "address", url], by: "you" });
      await until("the address is asked for its list", () => listedWith.length > 0);
      seen.address = {
        listedWith: [...listedWith],
        block: readOpsSettings(root).model.transports?.address,
        requests: ((await ask(sock, { verb: "vault" })) as { requests: { secret: string; lane: string; task: string; ok: boolean }[] }).requests.filter((each) => each.secret === "address"),
      };
      await ask(sock, { verb: "models", args: ["--", "address", "none"], by: "you" });
      await ask(sock, { verb: "seal", secret: "address", value: null });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await home.stop();

    const tokenBefore = readFileSync(join(root, "config", "secrets", "fake-poll"), "utf8");
    home = await start(null);
    advance();
    await until("the poll waits for the vault", () => pollSaid() === "wait vault");
    seen.lockedNeeds = ids(needsAt(now));
    seen.tokenWhileLocked = readFileSync(join(root, "config", "secrets", "fake-poll"), "utf8") === tokenBefore;
    await until("the rotating poll waits for the vault after the start", () => pollSaid("fake-poll-two") === "wait vault");
    advance();
    const unlockedAt = now;
    seen.unlocked = await ask(sock, { verb: "unlock", slot_key: slot.toString("base64") });
    seen.queuedByUnlock = readHome(root, (db) => (db.prepare("SELECT key, state, ended_ms FROM jobs WHERE kind = 'poll' AND key IN ('fake-poll', 'fake-poll-two') ORDER BY key").all() as { key: string; state: string; ended_ms: number | null }[])
      .map((job) => ({ key: job.key, woken: job.state !== "done" || (job.ended_ms ?? 0) >= unlockedAt })));
    await until("the poll runs once unlocked", () => pollSaid() === "ok ");
    seen.unlockedNeeds = ids(needsAt(now));

    homeSecrets(join(root, "config", "secrets"), { key: another }).set(PASSWORD, FIRST);
    advance();
    await until("the poll asks for the password again", () => pollSaid() === "need password");
    seen.again = needsAt(now).filter((need) => need.reason === "password");
    await ask(sock, { verb: "seal", secret: PASSWORD, value: THIRD });
    await until("the poll reads the password typed again", () => hashes().includes(sha(THIRD)));
    seen.cleared = ids(needsAt(now));
    seen.list = await cli(["secret", "list"]);
    seen.status = statusOf(root, { now_ms: now, settings: readOpsSettings(root) });
    seen.vaultStatus = await cli(["vault", "status"]);

    writeFileSync(join(exposure, "refuse"), "");
    advance();
    await until("the poll asks for the password", () => pollSaid() === "need password");
    const refused = () => needsAt(now).find((need) => need.id === `password:${PASSWORD}`);
    const first = refused();
    advance();
    await ask(sock, { verb: "seal", secret: PASSWORD, value: FOURTH });
    const sealedAt = readHome(root, (db) => db.prepare("SELECT max(seq) FROM events WHERE kind = 'secret' AND key = ?").pluck().get(PASSWORD)) as number;
    const ended = readHome(root, (db) => db.prepare("SELECT kind, json_extract(detail, '$.outcome') AS outcome FROM events WHERE seq > ? AND key = 'fetch:fake-poll' ORDER BY seq LIMIT 1").get(sealedAt)) as { kind: string; outcome: string | null } | undefined;
    await until("the poll asks for the new password too", () => pollSaid() === "need password");
    seen.refusedAgain = { first, ended, second: refused(), sealed_ms: now };
    rmSync(join(exposure, "refuse"));
    await home.stop();
    home = undefined;
    artifact(root, "passwords", { ...seen, logs: logs.map((line) => JSON.parse(line) as unknown) });
  });

  afterAll(async () => {
    Worker.prototype.postMessage = postMessage;
    await home?.stop();
    removeRoot(root);
  });

  it("a write with no key writes plain, or a locked home answers a plain token a provider would spend", () => {
    expect(seen.unkeyed).toMatchObject({ files: ["fake-poll-two"], token: "fake-token-plain\n", set: { status: 1, out: expect.stringMatching(/No vault yet: make your recovery key in the Lifestream app first/u) } });
  });

  it("a call process is handed a secret other than its transport's, on its command line or in its environment, or none once the vault opens", () => {
    const handed = seen.handed as { argv: string[]; env: string[]; stdin: string }[];
    const secretsOf = (call: { stdin: string }) => call.stdin.split("\n", 1)[0]!;
    const keyed = handed.filter((call) => secretsOf(call) !== "{}");
    expect(keyed.length).toBeGreaterThan(0);
    for (const call of keyed) expect(JSON.parse(secretsOf(call))).toEqual({ openrouter: "fake-openrouter-key" });
    for (const call of handed) {
      expect(call.env).toEqual([]);
      expect(call.argv.join(" ")).not.toContain("fake-openrouter-key");
    }
    expect(seen.callRequests).toEqual(expect.arrayContaining([expect.objectContaining({ secret: "openrouter", lane: "model", task: expect.stringMatching(/^call:/u), ok: true })]));
  });

  it("a key the person removes is still held: sealed with no value, its file is gone and the removal is an event", () => {
    expect(seen.address, "a key sealed for the custom address goes with its list, and its read is recorded").toEqual({
      listedWith: ["Bearer fake-address-key"],
      block: { url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u), secret: "address" },
      requests: [{ at_ms: expect.any(Number), secret: "address", op: "get", lane: "models", task: "list", ok: true }],
    });
    const forgot = seen.forgot as { answers: unknown[]; file: boolean; events: unknown[] };
    expect(forgot.answers).toEqual([{ removed: "openrouter" }, { removed: "openrouter" }]);
    expect(forgot.file).toBe(false);
    expect(forgot.events.at(-1)).toEqual({ removed: true });
  });

  it("a rotated provider token is lost, or written plain", () => {
    for (const name of ["fake-poll", "fake-poll-two"]) {
      const stored = readFileSync(join(root, "config", "secrets", name), "utf8");
      expect(stored.startsWith(`lifestream-sealed:v1:${keyId(vaultKey)}:`), name).toBe(true);
      expect(statSync(join(root, "config", "secrets", name)).mode & 0o777).toBe(0o600);
      expect(homeSecrets(join(root, "config", "secrets"), { key: vaultKey }).get(name)).toMatch(/^synthetic-token-\d+$/u);
    }
    expect(seen.tokenWhileLocked).toBe(true);
  });

  it("a helper is answered a secret its lane does not name", () => {
    expect(seen.stolen).toMatch(new RegExp(`${PASSWORD.replace(".", "\\.")} is not a secret of fake-poll-two`, "u"));
  });

  it("a secret request goes unlogged, or logged with its value", () => {
    const requests = seen.requests as { secret: string; lane: string; task: string; ok: boolean }[];
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ secret: PASSWORD, lane: "fake-poll", task: "poll:fake-poll", ok: true }),
      expect.objectContaining({ secret: PASSWORD, lane: "fake-poll-two", task: "poll:fake-poll-two", ok: false }),
      expect.objectContaining({ secret: "fake-poll-two", lane: "fake-poll-two", task: "poll:fake-poll-two", ok: true }),
    ]));
    expect(requests.length).toBeLessThanOrEqual(20);
    const logged = logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.secret !== undefined && line.task !== undefined);
    expect(logged.some((line) => line.secret === PASSWORD && line.lane === "fake-poll-two" && line.ok === false)).toBe(true);
    expect((seen.vaultStatus as { out: string }).out).toMatch(/x\.password fake-poll poll:fake-poll ok/u);
  });

  it("a lane that waits for the vault raises a \"has failed\" notice, or the unlock leaves one that waited unqueued (15, 16)", () => {
    expect(seen.waitNeeds).toEqual([]);
    expect(seen.queuedByUnlock).toEqual([{ key: "fake-poll", woken: true }, { key: "fake-poll-two", woken: true }]);
  });

  it("a locked home raises no notice, or keeps it once unlocked", () => {
    expect(seen.lockedNeeds).toContain("vault:locked");
    expect(seen.unlocked).toEqual({ key_id: keyId(vaultKey) });
    expect(seen.unlockedNeeds).toEqual([]);
  });

  it("a password sealed by another key is filled, or the person is not asked to type it again", () => {
    expect(seen.again).toEqual([expect.objectContaining({ id: `password:${PASSWORD}`, state: "needs-you", reason: "password", words: expect.stringMatching(/^Type your .* password/u) })]);
    expect(seen.cleared).toEqual([]);
    expect(seen.typed).toEqual({ sealed: PASSWORD, key: keyId(vaultKey) });
  });

  it("a password sealed and asked for again is the same need as before, so the window that asked never asks again", () => {
    const { first, ended, second, sealed_ms } = seen.refusedAgain as { first?: Need; ended?: { kind: string; outcome: string | null }; second?: Need; sealed_ms: number };
    expect(first).toMatchObject({ state: "needs-you", reason: "password", words: "Type your Example password" });
    expect(ended).toEqual({ kind: "attempt", outcome: null });
    expect(second).toMatchObject({ id: first!.id, reason: "password", since_ms: sealed_ms });
    expect(second!.since_ms).not.toBe(first!.since_ms);
  });

  it("a password or the vault key reaches a log, an event, the status, home.db, the list, or a helper", () => {
    const secrets = [FIRST, SECOND, THIRD, FOURTH, vaultKey.toString("base64"), vaultKey.toString("hex"), slot.toString("base64"), slot.toString("hex")];
    const events = readHome(root, (db) => JSON.stringify(db.prepare("SELECT * FROM events").all()));
    const files = readdirSync(root).filter((name) => name.startsWith("home.db")).map((name) => readFileSync(join(root, name)).toString("latin1"));
    const exposed = readFileSync(join(exposure, "helper.jsonl"), "utf8");
    expect(exposed).toContain("\"root\"");
    expect(posted.length).toBeGreaterThan(0);
    for (const [where, text] of Object.entries({ posted: posted.join("\n"), logs: logs.join("\n"), events, status: JSON.stringify(seen.status), list: JSON.stringify(seen.list), vault: JSON.stringify(seen.vaultStatus), db: files.join(""), helper: exposed })) {
      for (const secret of secrets) expect(text.includes(secret), `${where} holds a secret`).toBe(false);
    }
    expect(seen.list).toEqual({ status: 0, out: `${JSON.stringify(["fake-poll", "fake-poll-two", PASSWORD].map((name) => ({ name, sealed: keyId(vaultKey) })))}\n` });
  });
});

describe("passwords: a vault with no machine slot answers no secret until its recovery key is confirmed", () => {
  let root: string;
  let home: Home | undefined;
  const now = Date.now();
  const seen: Record<string, unknown> = {};
  const token = () => readFileSync(join(root, "config", "secrets", "fake-poll-two"), "utf8");
  const pollSaid = () => readHome(root, (db) => db.prepare("SELECT outcome || ' ' || coalesce(reason, '') FROM attempts WHERE target = 'fetch:fake-poll-two' ORDER BY at_ms DESC LIMIT 1").pluck().get() as string | undefined);

  beforeAll(async () => {
    root = makeRoot("lifestream-passwords-unkept-", {
      sources: { "apple-notes:local:poll-two": "fake-rows", "apple-notes:local:mac-0001": "fake-rows" }, clocks: false,
      settings: {
        "connectors.fake-poll-two": { refresh: "1s", rotates: true },
        "model.defaults.pictures": "openrouter:google/gemini-3.8-flash",
      },
    });
    mkdirSync(join(root, "config", "secrets"), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "config", "secrets", "fake-poll-two"), "fake-token-plain\n", { mode: 0o600 });
    writeFileSync(join(root, "config", "secrets", "openrouter"), "fake-model-secret", { mode: 0o600 });
    const handed = join(root, "handed.jsonl");
    const call = join(root, "call.mjs");
    writeFileSync(call, [
      'import { appendFileSync, readFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(handed)}, readFileSync(0, "utf8") + "\\n");`,
      "process.exit(75);",
    ].join("\n"));
    const on = testMachine();
    home = await startHome(root, { stopGraceMs: 50, registry: FAKES, clock: () => now, machine: on, slot: null, log: () => undefined, call: [process.execPath, call] });
    const sock = testSocket(root, on.dir);
    const made = (await ask(sock, { verb: "vault-init" })) as { recovery: string };
    await expect(ask(sock, { verb: "seal", secret: "fake-poll-two", value: "replacement" })).rejects.toThrow(/locked/iu);
    expect(await ask(sock, { verb: "account-connect", connector: "github", route: "github-api", values: {} })).toEqual({ refused: expect.stringMatching(/^Unlock Lifestream on .+ first\.$/u) });
    await askHome(sock, "run", ["poll", "fake-poll-two"]);
    await until("the explicit poll waits for the recovery key", () => pollSaid() === "wait vault");
    const vault = await ask(sock, { verb: "vault" }) as { requests: { secret: string; ok: boolean }[] };
    expect(vault.requests).toContainEqual(expect.objectContaining({ secret: "fake-poll-two", ok: false }));
    seen.unconfirmed = { token: token(), said: pollSaid() };
    const at = now - 1_000;
    await ship(root, { source: "apple-notes:local:mac-0001", fetched_ms: at, rows: [{ kind: "note", key: "photo", content: { text: "synthetic", at, photo: true }, at }] }, { machineDir: on.dir });
    await until("the caption owed by OpenRouter's route", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM asks WHERE state = 'pending'").pluck().get()) === 1);
    const ticks = home!.stats().ticks.count;
    await until("two ticks after", () => home!.stats().ticks.count > ticks + 1);
    seen.model = existsSync(handed);
    expect(seen.model).toBe(false);
    await ask(sock, { verb: "vault-confirm", recovery: made.recovery });
    await until("the poll runs once the recovery key is confirmed", () => pollSaid() === "ok ");
    seen.confirmed = { sealed: token().startsWith("lifestream-sealed:v1:") };
    artifact(root, "passwords-unkept", seen);
    await home.stop();
    home = undefined;
  });

  afterAll(async () => {
    await home?.stop();
    removeRoot(root);
  });

  it("a provider spends a plain token while the only key that seals its new one could be lost", () => {
    expect(seen.unconfirmed).toEqual({ token: "fake-token-plain\n", said: "wait vault" });
    expect(seen.confirmed).toEqual({ sealed: true });
  });
});
