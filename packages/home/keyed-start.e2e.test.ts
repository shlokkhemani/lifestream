import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs, { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync, type PathLike } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { declarations, vendorOf } from "@lifestreamprotocol/connect";
import { HOME_STORE, openHandedFolder, openHome, openHomeFolder, tryLock, trySharedLock, type Keys, type Program } from "@lifestreamprotocol/core";
import { callsLock, ledgerFileOf, openLedger } from "@lifestreamprotocol/model";
import { startHome, type Home } from "./home.js";
import { runCli } from "./cli.js";
import { askGeneration, serveDoor } from "./door.js";
import { asked, hold, readHold } from "./hold.js";
import { adopt, ONLY_THE_HOME, readHome } from "./lifecycle.js";
import { handedOnInput, KEYS_ON_INPUT, running } from "./hold-check.js";
import { folderVerb } from "./verbs/connectors-folder.js";
import { machine } from "./machine.js";
import { mintPrincipal, readPrincipals } from "./principals.js";
import { SINCE } from "./models.js";
import { callCommand, homeCommand } from "./programs.js";
import { ask, type HomeSocket } from "./socket.js";
import { draftRecovery, LOCKED_SINCE, readHandoff, Vault } from "./vault.js";
import { ship } from "./test/harness-deliveries.js";
import { FAKE_OFFER, FAKE_ROUTE, FAKES, LOOK_MS, makeRoot, TICK_MS, until } from "./test/harness-root.js";
import { testSocket, writeFolder } from "./test/folder.js";
import { statusOf } from "./test/harness-status.js";

const SOURCE = "apple-notes:local:mac-0001";
const PLAIN_HEADER = Buffer.from("SQLite format 3\0", "latin1");
const LABELS = ["store:home", "store:ledger", "store:custody", "store:prepared", "store:search", "store:screen", "files", "names", "ask-pending"] as const;
const SOCKET_VERBS = [
  "generation", "vault", "vault-check", "vault-init", "vault-new", "vault-confirm", "vault-recovery", "vault-discard", "vault-slot", "unlock", "recover", "sealed", "seal", "chat-voice", "ask-key", "model-reach",
  "subscriptions", "owner-act", "places-search", "account-connect", "device-start", "device-poll", "client-start", "client-finish", "seal-field", "stations", "redeem", "opened",
  "stated", "drained", "agent", "agents-call", "account", "offers", "through", "maintenance",
  "status", "report", "outbound", "codex", "claude", "settings", "repair", "undo", "rebuild", "erase", "drop", "act", "import", "source", "device", "setup", "pair", "connect",
  "connectors", "models", "agents", "faces", "principals", "sweep", "rehydrate", "run", "pause", "resume",
] as const;
const PLAIN_START = fileURLToPath(new URL("./test/plain-start.ts", import.meta.url));
const temps: string[] = [];
const at = machine();

afterAll(() => {
  if (process.env.LIFESTREAM_KEEP_ARTIFACTS !== "1") for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const made = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(made);
  return made;
}

interface KeyedHome {
  root: string;
  id: string;
  slot: Buffer;
  recovery: string;
  keys: Keys;
  secrets: string[];
}

async function keyedHome(): Promise<KeyedHome> {
  const root = join(temp("lifestream-keyed-start-"), "home");
  const id = randomUUID();
  const slot = randomBytes(32);
  const recovery = draftRecovery(1).recovery;
  await adopt(root, { machine: at, keyed: readHandoff(JSON.stringify({ home_id: id, slot_key: slot.toString("hex"), recovery })), fileSystem: () => "apfs", platform: "darwin" });
  writeFolder(root, {
    helpers: 2, clocks: false, "model.cap": 64, "model.defaults.pictures": FAKE_ROUTE, "model.defaults.audio": FAKE_ROUTE, "model.defaults.text": FAKE_ROUTE,
    "model.transports.fake": { delay_ms: 100, models: [FAKE_OFFER] },
  });
  const vault = new Vault({ root, machine: at.dir, home: id });
  expect(vault.start({ key: slot, why: null }, 1)).toBeNull();
  const keys = vault.keys!;
  const folder = openHomeFolder(root, { machine: at.dir, program: "home", keys });
  const db = openHome(folder, "migrate");
  db.commit((tx) => {
    tx.tables.sources.add({ id: SOURCE, vendor: vendorOf(declarations(), SOURCE), connector: "fake-rows", added_ms: 0 });
    tx.tables.meta.set(SINCE, "1970-01-31");
  });
  db.close();
  mkdirSync(join(root, "replies"), { recursive: true });
  openLedger(folder, { mode: "migrate" }).close();
  const data = Buffer.from((keys.hand() as { data: string }).data, "hex");
  const derived = Object.values((keys.only(LABELS).hand() as { keys: Record<string, string> }).keys).map((hex) => Buffer.from(hex, "hex"));
  const secrets = [data, ...derived, slot].flatMap((key) => [key.toString("hex"), key.toString("base64")]);
  return { root, id, slot, recovery, keys, secrets };
}

interface Handed {
  argv: string[];
  env: Record<string, string>;
  stdin: string;
}

function recorder(name: string, real: readonly string[]): { command: string[]; handed(): Handed[] } {
  const dir = temp(`lifestream-keyed-${name}-`);
  const script = join(dir, "record.mjs");
  const log = join(dir, "handed.jsonl");
  writeFileSync(script, [
    'import { spawn } from "node:child_process";',
    'import { appendFileSync } from "node:fs";',
    "const [log, command, ...rest] = process.argv.slice(2);",
    "const real = JSON.parse(command);",
    "const chunks = [];",
    "process.stdin.on(\"data\", (chunk) => chunks.push(chunk));",
    "process.stdin.on(\"end\", () => {",
    "  const stdin = Buffer.concat(chunks).toString(\"utf8\");",
    "  appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), env: process.env, stdin }) + \"\\n\");",
    "  const child = spawn(real[0], [...real.slice(1), ...rest], { stdio: [\"pipe\", \"inherit\", \"inherit\"] });",
    "  child.stdin.end(stdin);",
    "  child.on(\"exit\", (code) => process.exit(code ?? 1));",
    "});",
  ].join("\n"));
  return {
    command: [process.execPath, script, log, JSON.stringify(real)],
    handed: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Handed) : [],
  };
}

function holdsNone(what: string, text: string, secrets: readonly string[]): void {
  for (const secret of secrets) expect(text.includes(secret), `${what} holds a key`).toBe(false);
}

function tree(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (folder: string) => {
    if (!existsSync(folder)) return;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (!/\.lock(-journal)?$/u.test(entry.name)) found[path] = `${statSync(path).size}:${statSync(path).mtimeMs}`;
    }
  };
  walk(dir);
  return found;
}

function head(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(PLAIN_HEADER.length);
    readSync(fd, bytes, 0, bytes.length, 0);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

const answers = async (sock: HomeSocket): Promise<boolean> => {
  try {
    await ask(sock, { verb: "vault" });
    return true;
  } catch {
    return false;
  }
};

function opensBy(root: string, keys: Keys, machineDir: string): unknown[] {
  const db = openHomeFolder(root, { machine: machineDir, program: "home", keys }).store(HOME_STORE, join(root, "home.db"), { mode: "read", mustExist: true });
  try {
    return (db.prepare("SELECT kind, key, detail FROM events WHERE kind IN ('vault', 'passes') ORDER BY seq").all() as { kind: string; key: string; detail: string }[])
      .map((row) => ({ kind: row.kind, key: row.key, ...JSON.parse(row.detail) as object }));
  } finally {
    db.close();
  }
}

async function cli(args: string[]): Promise<{ status: number; out: string }> {
  let out = "";
  const status = await runCli(args, { write: (text) => { out += text; }, going: (text) => { out += text; } });
  return { status, out };
}

describe("an encrypted home's start: one road, which waits at one point for a key", () => {
  for (const by of ["unlock", "recover"] as const) {
    it(`with no key it waits with its socket open, opening no store and making no file, takes ${by}, and starts in the same process`, async () => {
      const keyed = await keyedHome();
      const before = { home: tree(keyed.root), scratch: tree(join(at.dir, "scratch")) };
      const logs: string[] = [];
      const sock = testSocket(keyed.root, at.dir);
      const stop = new AbortController();
      const starting = startHome(keyed.root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, machine: at, slot: null, log: (line) => logs.push(line), lookMs: 50, signal: stop.signal });
      let home: Home | undefined;
      try {
        await until("the locked home answers on its socket", () => answers(sock));
        expect({ home: tree(keyed.root), scratch: tree(join(at.dir, "scratch")) }).toEqual(before);
        expect(await ask(sock, { verb: "vault" })).toMatchObject({ keyed: true, locked: true });
        expect(await ask(sock, { verb: "status" })).toEqual({ locked: "no machine slot's key was handed at start" });
        expect((await cli(["status", "--root", keyed.root])).out).toContain("Lifestream is locked: unlock it on your Mac.");
        const opened = by === "unlock" ? await ask(sock, { verb: "unlock", slot_key: keyed.slot.toString("base64") }) : await ask(sock, { verb: "recover", recovery: keyed.recovery });
        expect(opened).toMatchObject({ key_id: expect.any(String) });
        home = await starting;
      } finally {
        if (home === undefined) stop.abort();
        await (home ?? await starting.catch(() => undefined))?.stop();
      }
      const said = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
      const order = said.flatMap((line) => line.home === "locked" ? ["locked"] : line.vault === "unlocked" || line.vault === "recovered" ? [String(line.vault)] : line.home === "started" ? ["started"] : []);
      expect(order).toEqual(["locked", by === "unlock" ? "unlocked" : "recovered", "started"]);
      expect(said.filter((line) => line.home === "locked")).toHaveLength(1);
      expect(opensBy(keyed.root, keyed.keys, at.dir)).toEqual([expect.objectContaining({ kind: "vault", key: "opened", by })]);
      holdsNone("the home's log", logs.join("\n"), keyed.secrets);
    });
  }

  it("a copy of a keyed folder with the same id, started beside the running home, is refused before it writes anything, this Mac's copy of the vault included", async () => {
    const keyed = await keyedHome();
    const copy = join(temp("lifestream-keyed-copy-"), "home");
    cpSync(keyed.root, copy, { recursive: true });
    const vaultFile = JSON.parse(readFileSync(join(copy, "config", "vault.json"), "utf8")) as { counter: number };
    writeFileSync(join(copy, "config", "vault.json"), `${JSON.stringify({ ...vaultFile, counter: vaultFile.counter + 1 })}\n`);
    await keyedHome();
    const home = await startHome(keyed.root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, machine: at, slot: keyed.slot, log: () => undefined });
    try {
      const before = { copy: tree(copy), vaults: tree(join(at.dir, "vaults")) };
      expect(Object.keys(before.vaults).length).toBeGreaterThan(0);
      await expect(startHome(copy, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, machine: at, slot: keyed.slot, log: () => undefined })).rejects.toThrow(/already runs on this machine/u);
      expect({ copy: tree(copy), vaults: tree(join(at.dir, "vaults")) }).toEqual(before);
    } finally {
      await home.stop();
    }
  });

  it("with its key it runs keyed: a model call answered, the call handed three keys on its standard input, and no key in any child's argv or environment, the log, or the process's environment", async () => {
    const keyed = await keyedHome();
    const calls = recorder("call", callCommand());
    const logs: string[] = [];
    let home: Home | undefined;
    try {
      home = await startHome(keyed.root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, machine: at, slot: keyed.slot, log: (line) => logs.push(line), call: calls.command });
      expect(head(join(keyed.root, "home.db")).equals(PLAIN_HEADER)).toBe(false);
      const now = Date.now();
      await ship(openHomeFolder(keyed.root, { machine: at.dir, program: "home", keys: keyed.keys }), { source: SOURCE, fetched_ms: now - 1_000, rows: [{ kind: "note", key: "photo-1", content: { text: "synthetic", at: now - 1_000, photo: true }, at: now - 1_000 }] }, { machineDir: at.dir });
      const called = join(keyed.root, "logs", "calls.log");
      await until("the call process answers on the keyed ledger", () => existsSync(called) && readFileSync(called, "utf8").includes('"outcome":"replied"'));
    } finally {
      await home?.stop();
    }
    const handed = calls.handed();
    expect(handed.length).toBeGreaterThan(0);
    for (const call of handed) {
      holdsNone("a call's argv", call.argv.join(" "), keyed.secrets);
      holdsNone("a call's environment", JSON.stringify(call.env), keyed.secrets);
      const [secrets, keys, ...more] = call.stdin.split("\n");
      expect(more).toEqual([]);
      expect(JSON.parse(secrets!)).toEqual({});
      expect(JSON.parse(keys!)).toEqual({ root: keyed.root, form: "keyed", machine: at.dir, program: "call", keys: keyed.keys.only(["store:ledger", "files", "names"]).hand() });
    }
    holdsNone("the home's log", logs.join("\n"), keyed.secrets);
    holdsNone("the process's environment", JSON.stringify(process.env), keyed.secrets);
    holdsNone("the calls' log", readFileSync(join(keyed.root, "logs", "calls.log"), "utf8"), keyed.secrets);
  });

  it("settings left in the plain file are sealed at the start that holds its key, before any is read, said in one line by their keys and never their values", async () => {
    const keyed = await keyedHome();
    const logs: string[] = [];
    const home = await startHome(keyed.root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, machine: at, slot: keyed.slot, log: (line) => logs.push(line) });
    try {
      expect([home.settings.helpers, home.settings.clocks, home.settings.model.cap]).toEqual([2, false, 64]);
    } finally {
      await home.stop();
    }
    const said = logs.filter((line) => line.includes('"settings":"sealed"'));
    expect(said.map((line) => (JSON.parse(line) as { keys: string[] }).keys)).toEqual([
      ["clocks", "helpers", "model.cap", "model.defaults.audio", "model.defaults.pictures", "model.defaults.text", "model.transports.fake"],
    ]);
    expect(said[0]).not.toContain(FAKE_ROUTE);
    expect(said[0]).not.toContain("delay_ms");
    expect(Object.keys(JSON.parse(readFileSync(join(keyed.root, "config", "settings.json"), "utf8")) as object).sort()).toEqual(["day.zone", "door.lan_port", "door.port", "unit"]);
  });

  it("held, with its key, it runs its check keyed: the verify child is handed the keys once on its standard input, none in its argv or environment", async () => {
    const keyed = await keyedHome();
    hold(at, keyed.id, { since_ms: Date.now(), cause: { met: "home.db", error: "a synthetic fault" }, check: null });
    const verify = recorder("verify", homeCommand());
    const logs: string[] = [];
    const home = await startHome(keyed.root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, machine: at, slot: keyed.slot, log: (line) => logs.push(line), verify: verify.command, lookMs: 50 });
    await home.stop();
    expect(readHold(at, keyed.id)).toBeNull();
    expect(logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.home === "checked").map((line) => line.checked)).toEqual(["whole"]);
    const handed = verify.handed();
    expect(handed).toHaveLength(1);
    expect(handed[0]!.argv.slice(2)).toEqual(["verify", "--root", keyed.root, KEYS_ON_INPUT]);
    holdsNone("the check's argv", handed[0]!.argv.join(" "), keyed.secrets);
    holdsNone("the check's environment", JSON.stringify(handed[0]!.env), keyed.secrets);
    expect(JSON.parse(handed[0]!.stdin)).toEqual({ root: keyed.root, form: "keyed", machine: at.dir, program: "home", keys: keyed.keys.hand() });
  });

  it("started again while it runs, it claims the socket, or writes a vault file or another home's half-written copy, where a plain one waits on the home's lock", async () => {
    const keyed = await keyedHome();
    const home = await startHome(keyed.root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, machine: at, slot: keyed.slot, log: () => undefined });
    const another = join(at.dir, "vaults", `${randomUUID()}.json.0a0b0c0d.tmp`);
    writeFileSync(another, "half");
    const vaults = () => ({ folder: readFileSync(join(keyed.root, "config", "vault.json"), "utf8"), copies: tree(join(at.dir, "vaults")) });
    const before = vaults();
    const logs: string[] = [];
    const stop = new AbortController();
    const second = startHome(keyed.root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, machine: at, slot: keyed.slot, log: (line) => logs.push(line), lookMs: 50, signal: stop.signal });
    try {
      await until("the second start waits on the home's lock", () => logs.some((line) => (JSON.parse(line) as { why?: string }).why === "a move or a verb holds the home: it starts when that ends"));
      expect(vaults()).toEqual(before);
      expect(await ask(testSocket(keyed.root, at.dir), { verb: "vault" })).toMatchObject({ keyed: true, locked: false });
    } finally {
      stop.abort();
      await second.catch(() => undefined);
      await home.stop();
    }
    expect(logs.some((line) => line.includes("already runs"))).toBe(false);
  });

  it("started again while a call sends and the door takes an upload, it empties its own work and leaves theirs", async () => {
    const keyed = await keyedHome();
    const handed = (program: Program) => openHandedFolder({ root: keyed.root, form: "keyed", machine: at.dir, program, keys: keyed.keys.only(["files"]).hand() });
    const call = handed("call").work("call", { own: join(at.dir, "calls", keyed.id, "a".repeat(64)) });
    const upload = handed("door").work(`ask-${randomUUID()}`, join(keyed.root, "door", "ask"));
    writeFileSync(join(call.path, "attachment-0.jpg"), "a synthetic attachment in flight");
    writeFileSync(join(upload.path, ".upload.partial"), "a synthetic upload in flight");
    const crashed = handed("home").work("materialise");
    writeFileSync(join(crashed.path, "copy.jpg"), "left by a home that crashed");
    const sending = trySharedLock(callsLock(ledgerFileOf(keyed.root)))!;
    const home = await startHome(keyed.root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, machine: at, slot: keyed.slot, log: () => undefined });
    try {
      expect({ call: readdirSync(call.path), upload: readdirSync(upload.path), crashed: existsSync(crashed.path) }).toEqual({ call: ["attachment-0.jpg"], upload: [".upload.partial"], crashed: false });
    } finally {
      await home.stop();
      sending.release();
      call.empty();
      upload.empty();
    }
  });

  it("no socket verb's answer, streamed line or refusal holds a key, locked or running", async () => {
    const keyed = await keyedHome();
    const sock = testSocket(keyed.root, at.dir);
    const heard: string[] = [];
    const every = async (verbs: readonly string[]) => {
      for (const verb of verbs) {
        try {
          heard.push(`${verb}: ${JSON.stringify(await ask(sock, { verb }, (line) => heard.push(`${verb} said: ${line}`)))}`);
        } catch (error) {
          heard.push(`${verb} refused: ${(error as Error).message} ${JSON.stringify(error)}`);
        }
      }
    };
    const stop = new AbortController();
    const ended = startHome(keyed.root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, machine: at, slot: null, log: () => undefined, lookMs: 50, signal: stop.signal }).then(() => "started", (error: Error) => error.message);
    try {
      await until("the locked home answers on its socket", () => answers(sock));
      await every([...SOCKET_VERBS, "stop"]);
      expect(await ended).toBe("stopped: a move or a verify asked");
    } finally {
      stop.abort();
      await ended;
    }
    const home = await startHome(keyed.root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, machine: at, slot: keyed.slot, log: () => undefined });
    try {
      expect(Object.keys(await ask(sock, { verb: "generation" }) as object)).toEqual(expect.arrayContaining(["start", "folders"]));
      expect(Object.keys(await ask(sock, { verb: "generation" }) as object)).not.toContain("keys");
      await every(SOCKET_VERBS);
    } finally {
      await home.stop();
    }
    expect(heard.length).toBeGreaterThan(2 * SOCKET_VERBS.length);
    holdsNone("the socket's answers", heard.join("\n"), keyed.secrets);
  });

  it("a terminal verify, while the home's own check runs, waits on its standard input, or takes the keys from a terminal or echoes what it was handed", async () => {
    const keyed = await keyedHome();
    hold(at, keyed.id, { since_ms: Date.now(), cause: { met: "home.db", error: "a synthetic fault" }, check: running() });
    const asked = await cli(["verify", "--root", keyed.root, "--json"]);
    expect([asked.status, JSON.parse(asked.out) as unknown]).toEqual([0, { asked: "checking" }]);
    await expect(handedOnInput(Object.assign(Readable.from([]), { isTTY: true }))).rejects.toMatchObject({ code: "LOCKED" });
    const data = (keyed.keys.hand() as { data: string }).data;
    const refused = await handedOnInput(Readable.from([Buffer.from(`{"root":"${keyed.root}","form":"keyed","machine":"${at.dir}","keys":{"form":"lifestream-keys:v1","data":"${data}"}`)])).then(() => "read", (error: Error) => error.message);
    expect(refused).toBe("a handed folder does not read as JSON");
  });

  it("held, with no key, it opens its socket, takes recover, then runs its check and starts", async () => {
    const keyed = await keyedHome();
    hold(at, keyed.id, { since_ms: Date.now(), cause: { met: "home.db", error: "a synthetic fault" }, check: null });
    const logs: string[] = [];
    const sock = testSocket(keyed.root, at.dir);
    const starting = startHome(keyed.root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, machine: at, slot: null, log: (line) => logs.push(line), verify: homeCommand(), lookMs: 50 });
    let home: Home | undefined;
    try {
      await until("the held, locked home answers on its socket", () => answers(sock));
      expect(readHold(at, keyed.id)?.check).toBeNull();
      expect(await ask(sock, { verb: "status" })).toEqual({ locked: "no machine slot's key was handed at start" });
      expect(await ask(sock, { verb: "vault-check", recovery: keyed.recovery })).toMatchObject({ opens: true });
      expect(await ask(sock, { verb: "recover", recovery: keyed.recovery })).toMatchObject({ slot: null, key_id: expect.any(String) });
      home = await starting;
    } finally {
      await (home ?? await starting.catch(() => undefined))?.stop();
    }
    expect(readHold(at, keyed.id)).toBeNull();
    const said = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    const order = said.flatMap((line) => line.vault === "recovered" ? ["recovered"] : line.home === "checked" ? [`checked ${String(line.checked)}`] : line.home === "started" ? ["started"] : []);
    expect(order).toEqual(["recovered", "checked whole", "started"]);
    holdsNone("the home's log", logs.join("\n"), keyed.secrets);
  });
});

describe("a locked home: it says so everywhere it is read", () => {
  const LOCKED_BODY = { code: "LOCKED", message: "Lifestream is locked: unlock it on your Mac." };
  const WHY = "no machine slot's key was handed at start";

  it("a home.db that does not open under its key holds the home, named as damaged, and ends its start, as a plain home's damage does", async () => {
    const keyed = await keyedHome();
    const fd = openSync(join(keyed.root, "home.db"), "r+");
    try {
      writeSync(fd, randomBytes(4096), 0, 4096, 0);
    } finally {
      closeSync(fd);
    }
    await expect(startHome(keyed.root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, machine: at, slot: keyed.slot, log: () => undefined, lookMs: 50 })).rejects.toMatchObject({ code: "STORE_KEY" });
    expect(readHold(at, keyed.id)).toMatchObject({ cause: { met: "home.db", error: expect.stringContaining("does not open under this home's key") }, check: null });
    expect((await cli(["status", "--root", keyed.root])).out).toContain("Lifestream is checking its database");
    const logs: string[] = [];
    const stop = new AbortController();
    const waiting = startHome(keyed.root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, machine: at, slot: keyed.slot, log: (line) => logs.push(line), verify: homeCommand(), lookMs: 50, signal: stop.signal });
    try {
      await until("the waiting start checked home.db under its key and found it damaged", () => logs.some((line) => (JSON.parse(line) as { checked?: string }).checked === "found"));
      expect(readHold(at, keyed.id)).toMatchObject({ cause: { met: "home.db" }, check: { found: [expect.stringMatching(/^home\.db /u)] } });
      expect((await cli(["status", "--root", keyed.root])).out).toContain("Lifestream's database is damaged");
    } finally {
      stop.abort();
      await waiting.catch(() => undefined);
    }
    holdsNone("the home's log", logs.join("\n"), keyed.secrets);
  });

  it("vault, asked of a locked home, answers no why for a person, or the same why whether this Mac handed no key or a key that opens nothing", async () => {
    const keyed = await keyedHome();
    const sock = testSocket(keyed.root, at.dir);
    const whyOf = async (slot: Buffer | null): Promise<unknown> => {
      const stop = new AbortController();
      const starting = startHome(keyed.root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, machine: at, slot, log: () => undefined, lookMs: 50, signal: stop.signal });
      try {
        await until("the locked home answers on its socket", () => answers(sock));
        const state = await ask(sock, { verb: "vault" }) as { locked: boolean; why?: string };
        return { locked: state.locked, why: state.why };
      } finally {
        stop.abort();
        await starting.catch(() => undefined);
      }
    };
    expect(await whyOf(null)).toEqual({ locked: true, why: "This Mac didn't hand Lifestream its key when it started." });
    expect(await whyOf(randomBytes(32))).toEqual({ locked: true, why: "This Mac's key doesn't open Lifestream." });
    const home = await startHome(keyed.root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, machine: at, slot: keyed.slot, log: () => undefined });
    try {
      expect(await ask(sock, { verb: "vault" })).not.toHaveProperty("why");
    } finally {
      await home.stop();
    }
  });

  it("a key made and not saved still opens the home after the person discards it, locked or running, or vault-discard drops a saved key", async () => {
    const keyed = await keyedHome();
    const sock = testSocket(keyed.root, at.dir);
    const copy = join(at.dir, "vaults", `${keyed.id}.json`);
    const recoveries = (path: string) => (JSON.parse(readFileSync(path, "utf8")) as { slots: { id: string; kind: string }[] }).slots.filter((slot) => slot.kind === "recovery").map((slot) => slot.id);
    const drafted = draftRecovery(Date.now()).recovery;
    const home = await startHome(keyed.root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, machine: at, slot: keyed.slot, log: () => undefined });
    try {
      expect(await ask(sock, { verb: "vault-discard" })).toEqual({ dropped: [] });
      await ask(sock, { verb: "vault-recovery", recovery: drafted });
      expect(await ask(sock, { verb: "vault" })).toMatchObject({ recovery: "confirmed" });
      expect(await ask(sock, { verb: "vault-discard" })).toEqual({ dropped: [2] });
      expect(await ask(sock, { verb: "vault-check", recovery: drafted })).toMatchObject({ opens: false });
      expect(await ask(sock, { verb: "vault-check", recovery: keyed.recovery })).toMatchObject({ opens: true, slot: "r-1" });
      expect([recoveries(join(keyed.root, "config", "vault.json")), recoveries(copy)]).toEqual([["r-1"], ["r-1"]]);
      await ask(sock, { verb: "vault-recovery", recovery: drafted });
    } finally {
      await home.stop();
    }
    const stop = new AbortController();
    const starting = startHome(keyed.root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, machine: at, slot: null, log: () => undefined, lookMs: 50, signal: stop.signal });
    let opened: Home | undefined;
    try {
      await until("the locked home answers on its socket", () => answers(sock));
      expect(await ask(sock, { verb: "vault-discard" })).toEqual({ dropped: [2] });
      await expect(ask(sock, { verb: "recover", recovery: drafted })).rejects.toThrow(/That isn't your recovery key/u);
      expect(await ask(sock, { verb: "recover", recovery: keyed.recovery })).toMatchObject({ key_id: expect.any(String) });
      opened = await starting;
    } finally {
      if (opened === undefined) stop.abort();
      await (opened ?? await starting.catch(() => undefined))?.stop();
    }
    expect([recoveries(join(keyed.root, "config", "vault.json")), recoveries(copy)]).toEqual([["r-1"], ["r-1"]]);
  });

  it("makes no recovery key: vault-recovery takes the key the app drafted and answers its number and day, never a key", async () => {
    const keyed = await keyedHome();
    const sock = testSocket(keyed.root, at.dir);
    const home = await startHome(keyed.root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, machine: at, slot: keyed.slot, log: () => undefined });
    try {
      await expect(ask(sock, { verb: "vault-recovery" })).rejects.toThrow(/drafted/u);
      const drafted = draftRecovery(Date.now()).recovery;
      const answer = await ask(sock, { verb: "vault-recovery", recovery: drafted });
      expect(answer).toEqual({ slot: 2, day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u) });
      expect(await ask(sock, { verb: "vault-check", recovery: drafted })).toMatchObject({ opens: true, slot: "r-2" });
      expect(await ask(sock, { verb: "vault-check", recovery: keyed.recovery })).toMatchObject({ opens: true, slot: "r-1" });
      expect(await ask(sock, { verb: "vault-confirm", recovery: drafted })).toEqual({ confirmed: "r-2" });
      expect(await ask(sock, { verb: "vault-check", recovery: keyed.recovery })).toMatchObject({ opens: false });
      let said = "";
      const status = await runCli(["vault", "init", "--root", keyed.root], { machine: { ...at, macApp: false }, write: (text) => { said += text; } });
      expect([status, said]).toEqual([1, expect.stringMatching(/^this home is encrypted: a new recovery key is made in the Lifestream app/u)]);
    } finally {
      await home.stop();
    }
  });

  it("generation answers locked and why, status says it, and the door answers every route 503 LOCKED with Retry-After 60, reading no passes file and opening no store, until the home opens", async () => {
    const keyed = await keyedHome();
    const sock = testSocket(keyed.root, at.dir);
    const stop = new AbortController();
    const starting = startHome(keyed.root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, machine: at, slot: null, log: () => undefined, lookMs: 50, signal: stop.signal });
    const read: string[] = [];
    const openFile = fs.openSync;
    const readFile = fs.readFileSync;
    const touched = (path: unknown): void => {
      if (String(path).startsWith(keyed.root)) read.push(String(path).slice(keyed.root.length + 1));
    };
    let home: Home | undefined;
    const doorLog: string[] = [];
    let door: Awaited<ReturnType<typeof serveDoor>> | undefined;
    try {
      await until("the locked home answers on its socket", () => answers(sock));
      expect(await ask(sock, { verb: "generation" })).toEqual({ locked: WHY });
      expect(await askGeneration(keyed.root, at.dir)).toEqual({ locked: WHY });
      const lines: string[] = [];
      expect(await ask(sock, { verb: "status" }, (line) => lines.push(line))).toEqual({ locked: WHY });
      expect(lines).toEqual([`Lifestream is locked: unlock it on your Mac. (${WHY})`]);
      const shown = await cli(["status", "--root", keyed.root]);
      expect(shown).toEqual({ status: 0, out: `Lifestream is locked: unlock it on your Mac. (${WHY})\n` });
      expect(JSON.parse((await cli(["status", "--root", keyed.root, "--json"])).out)).toEqual({ locked: WHY });
      fs.openSync = ((path: PathLike, ...rest: never[]) => {
        touched(path);
        return (openFile as (...args: unknown[]) => number)(path, ...rest);
      }) as typeof fs.openSync;
      fs.readFileSync = ((path: PathLike, ...rest: never[]) => {
        touched(path);
        return (readFile as (...args: unknown[]) => unknown)(path, ...rest);
      }) as typeof fs.readFileSync;
      syncBuiltinESMExports();
      door = await serveDoor(keyed.root, { port: 0, max_bundle_bytes: 1 << 30 }, {
        registry: FAKES, machine: at, generation: askGeneration, lookMs: 50, log: (line) => doorLog.push(line),
        slot: { key: keyed.slot, why: null },
      });
      const base = `http://127.0.0.1:${door.port}`;
      const asked: [string, string, Record<string, string>][] = [
        ["GET", "/v1/status", {}], ["GET", "/v1/me", { authorization: "Bearer not-a-pass" }], ["GET", "/v1/days", {}], ["GET", "/v1/feed", {}],
        ["POST", "/v1/home/verify", { authorization: "Bearer not-a-pass" }], ["POST", "/v1/streams/leaving", {}], ["PUT", `/v1/acquisitions/${encodeURIComponent(SOURCE)}`, {}],
        ["GET", "/no/such/route", {}],
      ];
      for (const [method, path, headers] of asked) {
        const response = await fetch(`${base}${path}`, { method, headers, ...(method === "GET" ? {} : { body: "{}" }) });
        expect([method, path, response.status, response.headers.get("retry-after"), await response.json()]).toEqual([method, path, 503, "60", LOCKED_BODY]);
      }
      fs.openSync = openFile;
      fs.readFileSync = readFile;
      syncBuiltinESMExports();
      expect(read).toContain("HOME.json");
      expect(read.filter((path) => path.endsWith("principals.json") || path.endsWith(".db"))).toEqual([]);
      expect(doorLog.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.code === "LOCKED")).toHaveLength(asked.length);
      expect(await ask(sock, { verb: "unlock", slot_key: keyed.slot.toString("base64") })).toMatchObject({ key_id: expect.any(String) });
      home = await starting;
      await until("the door opens the unlocked home", async () => (await fetch(`${base}/v1/status`)).status === 401);
    } finally {
      fs.openSync = openFile;
      fs.readFileSync = readFile;
      syncBuiltinESMExports();
      await door?.close();
      if (home === undefined) stop.abort();
      await (home ?? await starting.catch(() => undefined))?.stop();
    }
    holdsNone("the door's log", doorLog.join("\n"), keyed.secrets);
  });

  it("stop ends its wait and lets go of its socket and home.lock; retire writes RETIRED.json and ends it too, from the terminal", async () => {
    const keyed = await keyedHome();
    const sock = testSocket(keyed.root, at.dir);
    const logs: string[] = [];
    const stopping = startHome(keyed.root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, machine: at, slot: null, log: (line) => logs.push(line), lookMs: 50 });
    await until("the locked home answers on its socket", () => answers(sock));
    expect(tryLock(join(keyed.root, "home.lock"))).toBeNull();
    const stopped = expect(stopping).rejects.toThrow("stopped: a move or a verify asked");
    expect(await ask(sock, { verb: "stop" })).toEqual({ stopping: true });
    await stopped;
    expect(await answers(sock)).toBe(false);
    const free = tryLock(join(keyed.root, "home.lock"));
    expect(free).not.toBeNull();
    free!.release();
    expect(logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.home === "stopped")).toEqual([expect.objectContaining({ why: "stopped: a move or a verify asked" })]);

    const retiring = startHome(keyed.root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, machine: at, slot: null, log: () => undefined, lookMs: 50 });
    const ended = retiring.then(() => "started", (error: Error) => error.message);
    await until("the locked home answers on its socket again", () => answers(sock));
    const retired = await cli(["retire", "--root", keyed.root, "--json"]);
    expect(retired.status, retired.out).toBe(0);
    expect(JSON.parse(retired.out)).toEqual({ retired: expect.any(String) });
    expect(existsSync(join(keyed.root, "RETIRED.json"))).toBe(true);
    expect(await ended).toBe(`retired: ${keyed.root} holds RETIRED.json`);
  });
});

describe("terminal verbs on an encrypted home's folder", () => {
  it("with no home running, each verb that needs a store is refused, saying only the running home opens it, before it opens one; verify, move and connectors remove say theirs", async () => {
    const keyed = await keyedHome();
    mkdirSync(join(keyed.root, "connectors", "made-here"), { recursive: true });
    const before = tree(keyed.root);
    for (const verb of [["status"], ["repair"], ["undo"], ["maintenance"], ["report"], ["agents", "add", "Hermes"]]) {
      const { status, out } = await cli([...verb, "--root", keyed.root]);
      expect([verb[0], status, out.trim()]).toEqual([verb[0], 1, ONLY_THE_HOME]);
    }
    const verify = await cli(["verify", "--root", keyed.root]);
    expect([verify.status, verify.out]).toEqual([1, expect.stringContaining("it is not held, so there is nothing to check")]);
    const moved = await cli(["move", join(temp("lifestream-keyed-move-"), "there")]);
    expect([moved.status, moved.out]).toEqual([1, expect.stringContaining("holds an encrypted Lifestream, and lifestream move works only on one that is not encrypted: nothing changed")]);
    const removed = await cli(["connectors", "remove", "made-here", "--root", keyed.root]);
    expect([removed.status, removed.out]).toEqual([1, expect.stringContaining("holds an encrypted Lifestream, and lifestream connectors remove works only on one that is not encrypted: nothing changed")]);
    expect(tree(keyed.root)).toEqual(before);
    hold(at, keyed.id, { since_ms: Date.now(), cause: { met: "home.db", error: "a synthetic fault" }, check: { unfinished: "stopped", at_ms: Date.now() } });
    const asking = await cli(["verify", "--root", keyed.root, "--json"]);
    expect([asking.status, JSON.parse(asking.out) as unknown]).toEqual([0, { asked: "asked" }]);
    expect(asked(at, keyed.id)).toBe(true);
    expect(tree(keyed.root)).toEqual(before);
  });

  it("with the home running, they ask it over the socket and it answers with its keys", async () => {
    const keyed = await keyedHome();
    const home = await startHome(keyed.root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, machine: at, slot: keyed.slot, log: () => undefined });
    try {
      const report = await cli(["report", "--root", keyed.root, "--json"]);
      expect(report.status, report.out).toBe(0);
      const repair = await cli(["repair", "--root", keyed.root]);
      expect([repair.status, repair.out]).toEqual([1, expect.stringMatching(/^--source is required\nusage: lifestream repair/u)]);
      const verify = await cli(["verify", "--root", keyed.root]);
      expect([verify.status, verify.out]).toEqual([1, expect.stringContaining("it is not held, so there is nothing to check")]);
    } finally {
      await home.stop();
    }
  });
});

describe("an encrypted home's vault needs", () => {
  it("say passwords, where a lost key or a locked Mac loses the whole home", async () => {
    const keyed = await keyedHome();
    for (const path of [join(keyed.root, "config", "vault.json"), join(at.dir, "vaults", `${keyed.id}.json`)]) {
      const vault = JSON.parse(readFileSync(path, "utf8")) as { slots: { kind: string; confirmed_ms?: number }[] };
      for (const slot of vault.slots) if (slot.kind === "recovery") delete slot.confirmed_ms;
      writeFileSync(path, `${JSON.stringify(vault, null, 2)}\n`);
    }
    const folder = openHomeFolder(keyed.root, { machine: at.dir, program: "home", keys: keyed.keys });
    const db = openHome(folder, "migrate");
    db.commit((tx) => tx.tables.meta.set(LOCKED_SINCE, "1"));
    db.close();
    const needs = statusOf(keyed.root, {}, folder).needs.filter((need) => need.id.startsWith("vault:")).map((need) => ({ id: need.id, what: need.words, line: need.line }));
    expect(needs).toEqual(expect.arrayContaining([
      { id: "vault:locked", what: "Lifestream is locked on this Mac", line: "Unlock it with your recovery key" },
      { id: "vault:unsaved", what: "Recovery key not saved", line: "Without it, a lost Mac loses everything in Lifestream" },
    ]));
    expect(JSON.stringify(needs)).not.toMatch(/[Pp]assword/u);
  });
});

describe("adopting a keyed folder that exists", () => {
  it("touches no file of the folder and records the passes owed in this Mac's directory; the first start that holds keys applies them in its start", async () => {
    const keyed = await keyedHome();
    const passes = openHomeFolder(keyed.root, { machine: at.dir, program: "home", keys: keyed.keys });
    const reader = mintPrincipal(passes, { unit: "macbook-pro-0001", scopes: ["read"], kind: null, now_ms: 1 }).principal.id;
    const before = tree(keyed.root);
    const adopting = () => adopt(keyed.root, { machine: at, fileSystem: () => "apfs", platform: "darwin" });
    expect(await adopting()).toMatchObject({ as: "kept", owed: "revoked again", passes: { kept: [], revoked: [] } });
    expect(tree(keyed.root)).toEqual(before);
    const record = join(at.dir, "revoked", `${keyed.id}.json`);
    rmSync(record);
    expect(await adopting()).toMatchObject({ as: "restored", owed: "restored", passes: { kept: [], revoked: [], suspended: [] } });
    expect(tree(keyed.root)).toEqual(before);
    expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ revoked: [], owed: "restored" });
    expect(await adopting()).toMatchObject({ as: "kept", owed: "restored" });
    expect(tree(keyed.root)).toEqual(before);
    const home = await startHome(keyed.root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, machine: at, slot: keyed.slot, log: () => undefined });
    await home.stop();
    expect(readPrincipals(passes).principals.find((row) => row.id === reader)?.revoked_at).toEqual(expect.any(String));
    expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ revoked: [reader] });
    expect(opensBy(keyed.root, keyed.keys, at.dir)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "passes", key: "restored", revoked: [reader] })]));
  });

  it("set up again on the Mac it was taken from, this Mac's old pass stays live after the first start, so it cannot pair as itself", async () => {
    const keyed = await keyedHome();
    const passes = openHomeFolder(keyed.root, { machine: at.dir, program: "home", keys: keyed.keys });
    const mint = (unit: string, kind: "mac" | "phone") => mintPrincipal(passes, { unit, kind, scopes: ["deliver"], sources: [SOURCE], now_ms: 1 }).principal.id;
    const mac = mint("macbook-pro-ab12", "mac");
    const phone = mint("iphone-17-pro-aa01", "phone");
    rmSync(join(at.dir, "revoked", `${keyed.id}.json`));
    expect(await adopt(keyed.root, { machine: at, model: "MacBook Pro", serial4: "ab12", fileSystem: () => "apfs", platform: "darwin" })).toMatchObject({ as: "restored", owed: "restored" });
    expect(readPrincipals(passes).principals.find((row) => row.id === mac)?.revoked_at).toBeNull();
    const home = await startHome(keyed.root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, machine: at, slot: keyed.slot, log: () => undefined });
    await home.stop();
    const live = readPrincipals(passes).principals.filter((row) => row.revoked_at === null).map((row) => row.id);
    expect(live).not.toContain(mac);
    expect(live).toContain(phone);
    expect(opensBy(keyed.root, keyed.keys, at.dir)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "passes", key: "restored", revoked: [mac] })]));
  });
});

describe("a plain home's start", () => {
  it("held, on a folder whose form does not read, throws out of its start where it waits and runs its check as before", async () => {
    const root = makeRoot("lifestream-plain-held-", { sources: { [SOURCE]: "fake-rows" } });
    temps.push(root);
    symlinkSync("loop", join(root, "loop"));
    const { id } = readHome(root);
    hold(at, id, { since_ms: Date.now(), cause: { met: "home.db", error: "a synthetic fault" }, check: null });
    const logs: string[] = [];
    const stop = new AbortController();
    const starting = startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, machine: at, log: (line) => logs.push(line), verify: [process.execPath, "-e", "process.exit(0)"], lookMs: 50, signal: stop.signal });
    let settled = false;
    const ended = starting.then(() => "started", (error: Error) => error.message).finally(() => { settled = true; });
    try {
      await until("the held home runs its check, or its start ends", () => settled || logs.some((line) => line.includes('"home":"checked"')));
    } finally {
      stop.abort();
    }
    expect(await ended).not.toMatch(/ELOOP/u);
    expect(logs.some((line) => line.includes('"home":"checked"'))).toBe(true);
  });

  it("on a brand-new home's first run, connectors remove in the same process opens a second descriptor of home.db", async () => {
    const root = join(temp("lifestream-plain-first-"), "home");
    await adopt(root, { machine: at, fileSystem: () => "apfs", platform: "darwin" });
    writeFolder(root, { helpers: 1, clocks: false });
    mkdirSync(join(root, "connectors", "made-here"), { recursive: true });
    expect(existsSync(join(root, "home.db"))).toBe(false);
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, machine: at, log: () => undefined });
    const opened: string[] = [];
    const openFile = fs.openSync;
    fs.openSync = ((path: PathLike, ...rest: never[]) => {
      if (String(path) === join(root, "home.db")) opened.push(String(path));
      return (openFile as (...args: unknown[]) => number)(path, ...rest);
    }) as typeof fs.openSync;
    syncBuiltinESMExports();
    try {
      await folderVerb({ root, cwd: root, out: () => undefined, machine: at, restart: () => false }, ["remove", "made-here"]).catch(() => undefined);
    } finally {
      fs.openSync = openFile;
      syncBuiltinESMExports();
      await home.stop();
    }
    expect(opened).toEqual([]);
  });

  it("is today's: home.db keeps SQLite's header, no stamp and no scratch are made, and no thread loads the cipher engine", async () => {
    const root = makeRoot("lifestream-plain-start-", { sources: { [SOURCE]: "fake-rows" } });
    temps.push(root);
    const machineDir = temp("lifestream-plain-start-machine-");
    writeFileSync(join(machineDir, "machine.json"), readFileSync(join(at.dir, "machine.json")));
    const { SQLITE_TMPDIR: _sorts, ...env } = process.env;
    const child = spawn(process.execPath, ["--import", "tsx", PLAIN_START, root, FAKES], { env: { ...env, LIFESTREAM_MACHINE_DIR: machineDir }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(code, out).toBe(0);
    const report = JSON.parse(out.trim().split("\n").at(-1)!) as { modules: number; binaries: number; started: boolean };
    expect(report).toEqual({ modules: 0, binaries: 0, started: true });
    expect(head(join(root, "home.db")).equals(PLAIN_HEADER)).toBe(true);
    expect(existsSync(join(root, "config", "stores.json"))).toBe(false);
    expect(existsSync(join(machineDir, "scratch"))).toBe(false);
  });
});
