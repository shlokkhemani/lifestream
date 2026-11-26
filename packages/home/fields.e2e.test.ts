import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { declarations, withRoadDefaults, type Connector } from "@lifestreamprotocol/connect";
import { homeSecrets, openHome, openHomeFolder, type Json } from "@lifestreamprotocol/core";
import { readConnectors, type ConnectorsInput } from "./connectors.js";
import { nameKey } from "./devices.js";
import { startHome, type Home } from "./home.js";
import { mintPrincipal } from "./principals.js";
import { homeRegistryModule } from "./programs.js";
import { blockOf, checkMember, connectorSettings, effective, SettingsError } from "./settings.js";
import { ask } from "./socket.js";
import { photosComing, photosStart, withLedger } from "./status.js";
import type { ConnectorReport, MemberState, StreamsReport } from "./streams-report.js";
import { editSettings, testSocket } from "./test/folder.js";
import { makeRoot, readHome, REPO, removeRoot } from "./test/harness-root.js";
import { openDoor } from "./test/harness-door.js";
import { exampleBank } from "./test/proof/example-bank/connector.js";
import { exampleLog } from "./test/proof/example-log/connector.js";
import { DEVICE } from "./test/support.js";
import { openWith, readVault, recoveryKey } from "./vault.js";

const report: Record<string, unknown> = {};
afterAll(() => {
  const directory = join(REPO, "packages", "home", ".build", "e2e");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "fields.json"), `${JSON.stringify(report, null, 2)}\n`);
});

const HOME_MAC = "macbook-pro-0001";
const HOME_MAC_NAME = "Desk Mac";
const OTHER_MAC = "macbook-air-bb07";
const NOW = Date.UTC(2026, 10, 11, 9, 30);
const PASSWORD = "synthetic-whoop-password-0";

const DECLARED = [...declarations(), withRoadDefaults(exampleBank), withRoadDefaults(exampleLog)];
const BANK = join(REPO, "packages", "home", "test", "proof", "example-bank");
const LOG = join(REPO, "packages", "home", "test", "proof", "example-log");
const declared = (id: string): Connector => DECLARED.find((each) => each.id === id)!;

function scratch(prefix: string, settings: Record<string, Json> = {}): string {
  const root = makeRoot(prefix, { sources: {}, settings: { "day.zone": "UTC", unit: HOME_MAC, ...settings } });
  onTestFinished(() => removeRoot(root));
  const home = openHome(openHomeFolder(root), "migrate");
  home.commit((tx) => tx.tables.meta.set(nameKey(HOME_MAC), HOME_MAC_NAME));
  home.close();
  return root;
}

function reportOf(root: string): StreamsReport {
  const db = new Database(join(root, "home.db"), { readonly: true, fileMustExist: true });
  try {
    return withLedger(openHomeFolder(root), (ledger) => readConnectors(db, {
      folder: openHomeFolder(root), now_ms: NOW, settings: { ...effective(root).settings, sites: { chosen: [] } } as ConnectorsInput["settings"], registry: { connectors: DECLARED, families: [] },
      machine: mkdtempSync(join(tmpdir(), "fields-machine-")), sites: null, present: [], needs: [], free_bytes: 400_000_000_000, ledger,
      photos: photosComing(db, photosStart(effective(root).settings, DECLARED, NOW)),
    }));
  } finally {
    db.close();
  }
}

const rowOf = (report: StreamsReport, id: string): ConnectorReport => report.connectors.find((each) => each.id === id)!;
const memberOf = (row: ConnectorReport, key: string): MemberState => row.members.find((each) => each.key === key)!;

describe("fields in the report", () => {
  it("F1 F2 a member carries no control, another than its kind's, or a path names no device or another than the home's Mac", () => {
    const got = reportOf(scratch("lifestream-fields-controls-"));
    const members = got.connectors.flatMap((row) => row.members.map((member) => ({ row, member })));
    expect(members.length).toBeGreaterThan(20);
    const KIND: Record<string, string> = { number: "stepper", toggle: "toggle", path: "path", list: "list", email: "email", text: "text", date: "date", zone: "zone", secret: "secret" };
    for (const { row, member } of members) {
      const at = `${row.id}.${member.key}`;
      const expected = member.steps !== null || member.menu !== undefined ? "menu" : member.kind === "start" ? "date" : KIND[member.kind];
      expect(member.control, at).toBe(expected);
      expect(member.where, at).toEqual(member.kind === "path" ? { unit: HOME_MAC, name: HOME_MAC_NAME } : null);
    }
    const drawn = new Set(members.map(({ member }) => member.control));
    for (const control of ["menu", "toggle", "stepper", "path", "list", "text", "email", "date", "zone", "secret"]) expect(drawn, control).toContain(control);
    report.controls = Object.fromEntries(members.map(({ row, member }) => [`${row.id}.${member.key}`, [member.control, member.where?.name ?? null]]));
  });

  it("F3 the form is off the account panel, a path of it leaves its own row, a field a route sets leaves the account, or the account row says otherwise", () => {
    const got = reportOf(scratch("lifestream-fields-panels-"));
    const panels = (id: string) => Object.fromEntries(rowOf(got, id).members.filter((member) => member.panel !== null).map((member) => [member.key, [member.panel, member.control]]));
    const seen = { "example-bank": panels("example-bank"), whoop: panels("whoop"), "google-places": panels("google-places"), github: panels("github") };
    expect(seen["example-bank"]).toEqual({ since: ["account", "date"], nickname: ["account", "text"] });
    expect(seen.whoop).toMatchObject({ email: ["account", "email"], password: ["account", "secret"], timezone: ["settings", "zone"], heart_rate_step: ["settings", "menu"] });
    expect(seen["google-places"]).toMatchObject({ key: ["account", "secret"] });
    expect(seen.github).toMatchObject({ login: ["account", "text"], token: ["account", "secret"] });
    report.panels = seen;
  });

  it("F3 a date of the form filled reads otherwise than as its day, or a text otherwise than as itself", () => {
    const root = scratch("lifestream-fields-account-", { "connectors.example-bank": { since: "2025-04-01", nickname: "Synthetic savings" } });
    const got = reportOf(root);
    const rows = Object.fromEntries(["example-bank"].map((id) => [id, rowOf(got, id)]));
    expect(memberOf(rows["example-bank"]!, "since")).toMatchObject({ value: "2025-04-01", words: "1 Apr 2025", from: "person", control: "date" });
    expect(memberOf(rows["example-bank"]!, "nickname")).toMatchObject({ value: "Synthetic savings", words: "Synthetic savings", from: "person", control: "text" });
    expect(memberOf(reportOf(scratch("lifestream-fields-unfilled-")).connectors.find((row) => row.id === "example-bank")!, "since")).toMatchObject({ value: null, words: "Not set yet" });
    report.filled = Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, row.members.filter((member) => member.panel === "account")]));
  });

  it("F4 a date that is no day, does not exist or is past its bound is set; one of the wrong kind in the file runs or stops it", () => {
    const bank = declared("example-bank");
    const refusal = (value: Json): string | null => {
      try {
        checkMember(bank, "since", value, []);
        return null;
      } catch (error) {
        if (!(error instanceof SettingsError)) throw error;
        return error.message;
      }
    };
    const said = { day: refusal("2025-04-01"), text: refusal("April 2025"), none: refusal("2025-02-30"), number: refusal(20250401) };
    expect(said).toEqual({ day: null, text: "connectors.example-bank.since is a date (2019-03-01)", none: "connectors.example-bank.since is a date (2019-03-01)", number: "connectors.example-bank.since is a date (2019-03-01)" });
    const bounded: Connector = { ...bank, fields: { ...bank.fields, since: { kind: "date", label: "Statements since", min: "2019-01-01", max: "2026-12-31" } } };
    expect(() => checkMember(bounded, "since", "2018-12-31", [])).toThrow("connectors.example-bank.since runs from 2019-01-01 to 2026-12-31");
    expect(() => checkMember(bounded, "since", "2019-01-01", [])).not.toThrow();
    const early = connectorSettings(bounded, { since: "2010-05-05" });
    expect([early.fields.since, early.notices.map((each) => each.what)]).toEqual(["2019-01-01", ["connectors.example-bank.since is 2010-05-05, past its bound: it runs at 2019-01-01, and stays written"]]);
    const kept = connectorSettings(bank, { since: "last April" });
    expect([kept.fields.since, kept.unset, kept.notices.length]).toEqual([undefined, ["since", "nickname"], 1]);
    report.dates = { said, early: early.notices, kept: kept.notices };
  });
});

async function post(url: string, path: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function running(prefix: string) {
  const root = scratch(prefix);
  cpSync(BANK, join(root, "connectors", "example-bank"), { recursive: true });
  cpSync(LOG, join(root, "connectors", "example-log"), { recursive: true });
  editSettings(root, { "door.port": 0 });
  const opened = await openDoor(root, { floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" }, settings: effective(root).settings.door, connectors: DECLARED });
  editSettings(root, { "door.port": opened.door.port });
  const homeLogs: string[] = [];
  const start = (slot: Buffer | null) => startHome(root, { stopGraceMs: 50, registry: homeRegistryModule(), slot, log: (line) => homeLogs.push(line) });
  const at: { home: Home | null } = { home: await start(null) };
  onTestFinished(async () => {
    await at.home?.stop();
  });
  const sock = testSocket(root);
  const slot = randomBytes(32);
  const made = (await ask(sock, { verb: "vault-init", slot_key: slot.toString("base64"), store: "keychain-login" })) as { recovery: string };
  await ask(sock, { verb: "vault-confirm", recovery: made.recovery });
  const key = openWith(readVault(root)!, "recovery", recoveryKey.parse(made.recovery))!.key;
  const principals = openHomeFolder(root);
  const pass = (unit: string, kind: "mac" | "phone" | null) => {
    const { token } = mintPrincipal(principals, { unit, ...(kind === null ? {} : { kind }), scopes: ["read"], now_ms: Date.now() });
    return { authorization: `Bearer ${token}`, ...(kind === null ? {} : DEVICE[kind]) };
  };
  const passes = {
    phone: pass("synthetic-iphone-5a49", "phone"), mac: pass(HOME_MAC, "mac"), other: pass(OTHER_MAC, "mac"), reader: pass("reader", null),
  };
  return {
    root, sock, url: opened.url, passes,
    logs: () => [...opened.logs, ...homeLogs.map((line) => (typeof line === "string" ? line : JSON.stringify(line)))].join("\n"),
    secrets: () => Object.fromEntries(homeSecrets(join(root, "config", "secrets"), { key }).list().map((each) => [each.name, homeSecrets(join(root, "config", "secrets"), { key }).get(each.name)])),
    set: (headers: Record<string, string>, body: unknown) => post(opened.url, "/v1/settings", headers, body),
    seal: (headers: Record<string, string>, body: unknown) => post(opened.url, "/v1/seal", headers, body),
    async lock() {
      await at.home!.stop();
      at.home = await start(null);
    },
  };
}

function settingEvents(root: string): string[] {
  return readHome(root, (db) => db.prepare("SELECT key FROM events WHERE kind = 'settings' ORDER BY seq").pluck().all() as string[]);
}

function config(root: string): Record<string, string> {
  const each = (dir: string): [string, string][] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? each(join(dir, entry.name)) : [[join(dir, entry.name), readFileSync(join(dir, entry.name), "base64")] as [string, string]]);
  return Object.fromEntries(each(join(root, "config")));
}

describe("fields through the door", () => {
  it("F5 F6 F7 a phone cannot set a text or a date, a refused set does not say why by member, or the home's Mac cannot choose a path", async () => {
    const home = await running("lifestream-fields-set-");
    const { phone, mac, other } = home.passes;
    expect(await home.set(phone, { connector: "example-bank", member: "nickname", value: "Synthetic savings" })).toEqual({ status: 200, body: { landed: { connector: "example-bank", member: "nickname", value: "Synthetic savings" } } });
    expect(await home.set(phone, { connector: "example-bank", member: "since", value: "2025-04-01" })).toEqual({ status: 200, body: { landed: { connector: "example-bank", member: "since", value: "2025-04-01" } } });
    expect(blockOf(home.root, "example-bank")).toEqual({ nickname: "Synthetic savings", since: "2025-04-01" });
    const refused = {
      date: await home.set(phone, { connector: "example-bank", member: "since", value: "2025-02-30" }),
      secret: await home.set(phone, { connector: "whoop", member: "password", value: "lifestream-whoop-password" }),
      phonePath: await home.set(phone, { connector: "example-log", member: "file", value: "/tmp/synthetic.log" }),
      otherMacPath: await home.set(other, { connector: "example-log", member: "file", value: "/tmp/synthetic.log" }),
    };
    expect(refused).toEqual({
      date: { status: 422, body: { code: "SETTING_REFUSED", message: "connectors.example-bank.since is a date (2019-03-01)" } },
      secret: { status: 403, body: { code: "PRINCIPAL_SCOPE", message: "whoop's password is a secret: it is sealed (POST /v1/seal), never set" } },
      phonePath: { status: 403, body: { code: "PRINCIPAL_SCOPE", message: "example-log's file names a file on the Mac Lifestream runs on: it is chosen there" } },
      otherMacPath: { status: 403, body: { code: "PRINCIPAL_SCOPE", message: "example-log's file names a file on the Mac Lifestream runs on: it is chosen there" } },
    });
    expect(blockOf(home.root, "example-bank")).toEqual({ nickname: "Synthetic savings", since: "2025-04-01" });
    expect(await home.set(mac, { connector: "example-log", member: "file", value: "/tmp/synthetic.log" })).toEqual({ status: 200, body: { landed: { connector: "example-log", member: "file", value: "/tmp/synthetic.log" } } });
    expect(blockOf(home.root, "example-log")).toEqual({ file: "/tmp/synthetic.log" });
    report.set = refused;
  });

  it("F11 a phone sets a key its row allows and no other, one key a body, and the write appends a settings event", async () => {
    const home = await running("lifestream-fields-home-setting-");
    const { phone } = home.passes;
    const before = settingEvents(home.root);
    expect(await home.set(phone, { "model.cap": 16 })).toEqual({ status: 200, body: {} });
    expect(effective(home.root).settings.model.cap).toBe(16);
    expect(settingEvents(home.root)).toEqual([...before, "model.cap"]);
    const refused = {
      port: await home.set(phone, { "door.port": 4999 }),
      none: await home.set(phone, { "nothing.here": 1 }),
      two: await home.set(phone, { "model.cap": 4, "history.start": "all" }),
      empty: await home.set(phone, {}),
      rule: await home.set(phone, { "model.cap": "many" }),
    };
    expect(refused).toEqual({
      port: { status: 403, body: { code: "PRINCIPAL_SCOPE", message: "door.port is set on the Mac Lifestream runs on, never by a device's pass" } },
      none: { status: 403, body: { code: "PRINCIPAL_SCOPE", message: "nothing.here is set on the Mac Lifestream runs on, never by a device's pass" } },
      two: { status: 422, body: { code: "BAD_REQUEST", message: "a body naming no connector names one setting and its value" } },
      empty: { status: 422, body: { code: "BAD_REQUEST", message: "a body naming no connector names one setting and its value" } },
      rule: { status: 422, body: { code: "SETTING_REFUSED", message: expect.stringContaining("model.cap") } },
    });
    expect(effective(home.root).settings.model.cap).toBe(16);
    expect(effective(home.root).settings.door.port).not.toBe(4999);
    expect(settingEvents(home.root)).toEqual([...before, "model.cap"]);
    report.homeSetting = refused;
  });

  it("F8 F9 a phone's seal leaves the vault without it, the block naming another or the old generation behind, its value in a log, or a refused one writes anything", async () => {
    const home = await running("lifestream-fields-seal-");
    const { phone, mac, reader } = home.passes;
    expect(await home.seal(phone, { connector: "whoop", member: "password", value: PASSWORD })).toEqual({ status: 200, body: { sealed: true } });
    expect([blockOf(home.root, "whoop"), home.secrets()]).toEqual([{ password: "lifestream-whoop-password.1" }, { "lifestream-whoop-password.1": PASSWORD }]);
    expect(await home.seal(mac, { connector: "whoop", member: "password", value: `${PASSWORD}-again` })).toEqual({ status: 200, body: { sealed: true } });
    expect([blockOf(home.root, "whoop"), home.secrets()]).toEqual([{ password: "lifestream-whoop-password.2" }, { "lifestream-whoop-password.2": `${PASSWORD}-again` }]);
    expect(home.logs()).not.toContain(PASSWORD);
    const before = config(home.root);
    const refused = {
      routed: await home.seal(phone, { connector: "github", member: "token", value: "ghp_synthetic_a" }),
      noSecret: await home.seal(phone, { connector: "whoop", member: "email", value: "person-a@example.com" }),
      empty: await home.seal(phone, { connector: "whoop", member: "password", value: "   " }),
      unknown: await home.seal(phone, { connector: "nothing", member: "password", value: PASSWORD }),
      shape: await home.seal(phone, { connector: "whoop", member: "password" }),
      reader: await home.seal(reader, { connector: "whoop", member: "password", value: PASSWORD }),
    };
    expect(refused).toEqual({
      routed: { status: 200, body: { refused: "GitHub's token is set by signing in.", field: "token" } },
      noSecret: { status: 200, body: { refused: "WHOOP has no secret email to type." } },
      empty: { status: 200, body: { refused: "Type your WHOOP password.", field: "password" } },
      unknown: { status: 403, body: { code: "PRINCIPAL_SCOPE", message: "the home declares no connector nothing" } },
      shape: { status: 422, body: { code: "BAD_REQUEST", message: "seal names a connector, a member and the secret's value" } },
      reader: { status: 403, body: { code: "PRINCIPAL_SCOPE", message: expect.stringContaining("is no device's") } },
    });
    expect(config(home.root)).toEqual(before);
    expect(home.logs()).not.toContain(PASSWORD);
    report.seal = refused;
  });

  it("F10 a locked vault takes a seal, or refuses it in words a phone cannot act on", async () => {
    const home = await running("lifestream-fields-locked-");
    await home.lock();
    const before = config(home.root);
    const answer = await home.seal(home.passes.phone, { connector: "whoop", member: "password", value: PASSWORD });
    expect(answer).toEqual({ status: 200, body: { refused: `Unlock Lifestream on ${HOME_MAC_NAME} first.` } });
    expect(config(home.root)).toEqual(before);
    report.locked = answer.body;
  });
});
