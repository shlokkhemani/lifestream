import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { civilDay, DAYS_MARK, hideDetails, openHome, openHomeFolder, wantedOf, type DaySettings, type Json, type JsonObject, type Marked } from "@lifestreamprotocol/core";
import { openLedger, type Ledger } from "@lifestreamprotocol/model";
import type { Access } from "@lifestreamprotocol/privacy";
import { defaultAccess, fullAccess } from "./access.js";
import { requestIn } from "./access-ledger.js";
import { settleAccess } from "./access-move.js";
import type { AgentAsk, HistoryPage, OwnAccess, OwnDrop, OwnRequest, WaitingList } from "./access-routes.js";
import { Agents, type Granted } from "./agents.js";
import { serveDoor } from "./door.js";
import { machine } from "./machine.js";
import { peopleFileOf } from "./people.js";
import { PEOPLE, writePrepared } from "./prepared.js";
import { mintPrincipal, readPrincipals } from "./principals.js";
import { SearchIndex, searchFileOf, type AtomEntry, type RecordEntry } from "./search-index.js";
import { serveSocket } from "./socket.js";
import { editSettings, testSocket } from "./test/folder.js";
import { cleanup, DEVICE, makeHome, NOW_MS, REPO, wordsAt, wordsOnly } from "./test/support.js";

const roots: string[] = [];
afterAll(() => cleanup(roots));

const REGISTRY = new URL("./test/access-registry.ts", import.meta.url);
const UTC: DaySettings = { zone: "UTC", day_start_hour: 0 };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WORK = "gmail:person-a@example.com";
const HOME_MAIL = "gmail:person-b@example.com";
const HEALTH = "whoop:person-a@example.com";
const ACCOUNTS = [{ account: WORK, category: "mail" }, { account: HOME_MAIL, category: "mail" }, { account: HEALTH, category: "health" }] as const;

const RECORDS: { account: string; key: string; text: string; family: string }[] = [
  { account: WORK, key: "m1", text: "the garden invoice from work", family: "mail" },
  { account: HOME_MAIL, key: "h1", text: "the garden plan for the flat", family: "mail" },
  { account: HEALTH, key: "s1", text: "garden walk heart rate", family: "health" },
];
const refOf = (account: string, key: string) => ({ source: `${account}:cloud`, kind: "item", key });

function homeWithRecords() {
  const home = makeHome({ admit: { scopes: ["admit"] }, reader: { scopes: ["read"] }, phone: { kind: "phone", scopes: ["deliver", "read"], sources: ["location:local:iphone-17-pro-aa01"], unit: "iphone-17-pro-aa01" } }, roots);
  const folder = openHomeFolder(home.root);
  const db = openHome(folder, "migrate");
  db.commit((tx) => {
    tx.tables.meta.set(DAYS_MARK, "test");
    for (const { account } of ACCOUNTS) tx.tables.sources.add({ id: `${account}:cloud`, vendor: account.split(":")[0] === "gmail" ? "google" : "whoop", connector: account.split(":")[0]!, added_ms: NOW_MS });
  });
  db.close();
  editSettings(home.root, { "model.defaults.hiding": null });
  writePrepared(folder, peopleFileOf(home.root, machine().dir), PEOPLE, { rows: new Map([["names", new Map([["table", {
    owner: { who: "p-owner", shown: "Owner Example" },
    people: [{ who: "p-owner", is: "human", shown: "Owner Example", names: ["Owner Example"], accounts: [] }],
  } as unknown as JsonObject]])]]), position: "p1" });
  const file = searchFileOf(home.root, machine().dir);
  mkdirSync(join(file, ".."), { recursive: true });
  const built = SearchIndex.write(folder, file, () => true, 0, UTC);
  built.records([], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
  built.finish();
  const index = SearchIndex.write(folder, file, () => true, 0, UTC);
  const at = NOW_MS - 2 * HOUR;
  const entries: RecordEntry[] = RECORDS.map(({ account, key, text, family }) => ({
    record: refOf(account, key), family, version: `v-${key}`, start_ms: at, end_ms: null, title: "", text, who: [], link: null,
  }));
  index.records(entries, [], { position: { seq: 2, statement: "s-2", reread: 0 } });
  const atoms: AtomEntry[] = entries.map((entry, n) => ({ n: n + 1, family: entry.family, unit: `${entry.family}:${entry.record.key}`, record: entry.record, start_ms: at, end_ms: null, text: entry.text }));
  index.day(civilDay(at, UTC), { inputs: "in-1", mtime_us: 1, atoms });
  index.close();
  return home;
}

async function journey() {
  const home = homeWithRecords();
  const folder = openHomeFolder(home.root);
  const ledger: Ledger = openLedger(folder, { mode: "write" });
  onTestFinished(() => ledger.close());
  const old = (name: string, level: Json) => {
    const token = `synthetic-token-${name}`.padEnd(43, "x");
    const id = mintPrincipal(folder, {
      unit: "agent", kind: "agent", scopes: ["read"], token, now_ms: NOW_MS,
      granted: { agent: { name, via: "pass", from: null, checked: false, client_id: null, resource: null, level } as never },
    }).principal.id;
    return { id, token };
  };
  const instinct = old("Instinct", "none");
  const claude = old("Claude", "all");
  expect(settleAccess({ folder, access: ledger.access, existing: () => ACCOUNTS, now_ms: NOW_MS })).toEqual({ moved: true, removed: [] });
  let now = NOW_MS;
  const door = await serveDoor(home.root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, clock: () => now, registry: REGISTRY });
  onTestFinished(() => door.close());
  const url = `http://127.0.0.1:${door.port}`;
  const agents = new Agents({
    folder, machine: machine(), commit: () => { throw new Error("no home.db write in this journey"); }, tables: ledger.placeholders, access: ledger.access,
    existing: () => ACCOUNTS, now: () => now,
  });
  const hermes = agents.add("Hermes", url, false, defaultAccess(), null);
  const sock = await serveSocket(testSocket(home.root, machine().dir).path, async (request) => {
    if (request.verb !== "agent") throw new Error(`no ${String(request.verb)} in this journey`);
    return agents.call(request.call, request.body, request.pass);
  });
  onTestFinished(() => sock.close());
  const call = async (token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: JsonObject }> => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, "lifestream-server": home.tokens.admit!, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as JsonObject };
  };
  const search = async (token: string) => {
    const answer = await call(token, "POST", "/v1/search", { args: { query: "garden", lists: ["record"] } });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const list = answer.body.record as { hits: unknown[] };
    return { hits: list.hits.length, outside: answer.body.outside === true };
  };
  const person = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { authorization: `Bearer ${home.tokens.reader!}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as JsonObject };
  };
  const chat = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { authorization: `Bearer ${home.tokens.reader!}`, "lifestream-chat": "chat-1", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as JsonObject };
  };
  const phone = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { authorization: `Bearer ${home.tokens.phone!}`, ...DEVICE.phone, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as JsonObject };
  };
  const signIn = async (name: string) => {
    const asked = await call(home.tokens.admit!, "POST", "/v1/agents/request", { name, checked: false, host: null });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    return asked.body as { id: string; number: number };
  };
  const grant = async (id: string) => {
    const granted = await call(home.tokens.admit!, "POST", "/v1/agents/grant", { id, client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata", resource: `${url}/mcp` });
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    return granted.body as unknown as Granted;
  };
  return {
    home, ledger, door, url, instinct, claude, hermes: { id: hermes.agent.id, token: hermes.pass }, call, search, person, chat, phone, signIn, grant, agents,
    tick: (ms: number) => { now += ms; },
    now: () => now,
  };
}

describe("an agent reads only what its access allows, through the door", () => {
  it("the move keeps each existing agent's level as a full access; a new agent gets the default and reads no Health; GET /v1/access states its lines", async () => {
    const at = await journey();
    expect(at.ledger.access.get(at.instinct.id)).toMatchObject({ version: 1, lines: fullAccess("none") });
    expect(at.ledger.access.get(at.claude.id)).toMatchObject({ version: 1, lines: fullAccess("all") });
    expect(readPrincipals(openHomeFolder(at.home.root)).principals.every((row) => row.agent === undefined || !Object.hasOwn(row.agent, "level"))).toBe(true);
    expect(at.ledger.access.get(at.hermes.id)).toMatchObject({ version: 1, lines: defaultAccess() });

    expect(await at.search(at.instinct.token), "a full access: every record, nothing said withheld").toEqual({ hits: 3, outside: false });
    expect(await at.search(at.hermes.token), "the default: the mail, and the health record withheld").toEqual({ hits: 2, outside: true });

    const own = await at.call(at.hermes.token, "GET", "/v1/access");
    expect(own.status).toBe(200);
    const read = own.body as unknown as OwnAccess;
    expect(read).toMatchObject({ version: 1, lines: ["1. Everything but Health and Money · all time", "2. details hidden"], outside: ["WHOOP"], request: null, answer: null });
    expect(read.text).toContain("Also in this Lifestream, outside your access: WHOOP.");
    expect(Object.keys(read).sort(), "the notice is the MCP server's line: the door serves no copy").toEqual(["access", "answer", "lines", "outside", "request", "text", "version"]);
    expect((await at.call(at.claude.token, "GET", "/v1/access")).body).toMatchObject({ lines: ["1. Everything · all time", "2. names and details hidden"], outside: [] });
    expect((await at.person("GET", "/v1/access")).status, "the person has no access of an agent's").toBe(403);
  });

  it("a narrowing applies at the next read; a one-off ends at its time; each call's row holds what it sent, its result and its withheld counts", async () => {
    const at = await journey();
    expect(await at.search(at.hermes.token)).toEqual({ hits: 2, outside: true });
    const narrowed: Access = { ...defaultAccess(), allow: [{ reach: { account: WORK, but: [] }, window: null, until_ms: null }] };
    const saved = await at.person("POST", `/v1/agents/${at.hermes.id}/access`, { access: narrowed, expect: 1 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(await at.search(at.hermes.token), "the narrowing holds from the next read").toEqual({ hits: 1, outside: true });

    const once: Access = { ...defaultAccess(), allow: [{ reach: { all: true, but: [] }, window: null, until_ms: at.now() + HOUR }] };
    at.ledger.access.change(at.hermes.id, { from: 2, what: "widened", lines: once as unknown as Json, covers: ACCOUNTS.map((each) => each.account) }, { at_ms: at.now(), by: "person", device: "iPhone" });
    expect(await at.search(at.hermes.token), "everything for an hour").toEqual({ hits: 3, outside: false });
    at.tick(HOUR);
    expect(await at.search(at.hermes.token), "at its end, nothing").toEqual({ hits: 0, outside: true });

    const calls = at.ledger.access.calls(at.hermes.id, { limit: 10 }).reverse();
    expect(calls.map(({ tool, result, access_version, session }) => ({ tool, result, access_version, session }))).toEqual([
      { tool: "search", result: "answered", access_version: 1, session: 1 },
      { tool: "search", result: "answered", access_version: 2, session: 1 },
      { tool: "search", result: "answered", access_version: 3, session: 1 },
      { tool: "search", result: "answered", access_version: 3, session: 2 },
    ]);
    expect(calls.map((each) => each.withheld)).toEqual([
      [{ line: "no-line", n: 1, least: false }],
      [{ line: "no-line", n: 2, least: false }],
      [],
      [{ line: "no-line", n: 3, least: false }],
    ]);
    expect(calls[0]!.sent).toEqual({ query: "garden", lists: ["record"] });
    expect(JSON.stringify(calls[0]!.read)).toContain("garden");
    expect(calls.every((each) => each.outbound.length === 1 && each.ms !== null), "each call names its outbound row").toBe(true);
  });

  it("the person answers on the phone: a sign-in as asked and after Change; a request For 1 hour reads for its hour, Always stays, No holds the same want a day and twice until the access changes; a stale answer is refused", async () => {
    const at = await journey();
    const waiting = async () => {
      const read = await at.phone("GET", "/v1/agents/waiting");
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      return read.body as unknown as WaitingList;
    };

    const asAsked = await at.signIn("Claude");
    expect((await waiting()).requests).toEqual([expect.objectContaining({ id: asAsked.id, name: "Claude", access: defaultAccess() })]);
    expect((await at.phone("POST", "/v1/agents/answer", { id: asAsked.id, answer: asAsked.number })).body).toEqual({ state: "approved", version: null, outcome: wordsAt("Allowed on iPhone,", expect.any(Number)), reader: null, connected: null });
    const claude = await at.grant(asAsked.id);
    expect(at.ledger.access.get(claude.grant), "allowed as asked: the default").toMatchObject({ version: 1, lines: defaultAccess() });
    expect(await at.search(claude.access_token)).toEqual({ hits: 2, outside: true });

    const changed = await at.signIn("Mistral");
    const workOnly: Access = { ...defaultAccess(), allow: [{ reach: { account: WORK, but: [] }, window: null, until_ms: null }] };
    expect((await at.phone("POST", "/v1/agents/answer", { id: changed.id, answer: changed.number, access: workOnly })).body).toMatchObject({ state: "approved" });
    const mistral = await at.grant(changed.id);
    expect(at.ledger.access.get(mistral.grant), "allowed after Change: the access the answer carried").toMatchObject({ version: 1, lines: workOnly });
    expect(await at.search(mistral.access_token)).toEqual({ hits: 1, outside: true });
    expect((await waiting()).requests).toEqual([]);

    const ask = (reader: string, want: Parameters<typeof requestIn>[1]["want"], for_ms: number | null) => requestIn(at.ledger, { reader, want, reason: "Your sleep this week.", for_ms, now_ms: at.now() });
    const health = { read: { category: "health" }, window: null } as const;
    const hour = ask(at.hermes.id, health, HOUR);
    if (!("request" in hour)) throw new Error("the request was held");
    const card = (await waiting()).asks;
    expect(card.map((each) => [each.id, each.head, each.default])).toEqual([[hour.request.id, "Hermes asks to see Health for 1 hour", "once"]]);
    const once = await at.phone("POST", "/v1/agents/answer", { id: hour.request.id, answer: "once", expect: card[0]!.version });
    expect(once.body).toMatchObject({ state: "allowed", version: 2 });
    expect((await waiting()).asks, "an answered request leaves the list").toEqual([]);
    expect(await at.search(at.hermes.token), "For 1 hour: Health too").toEqual({ hits: 3, outside: false });
    at.tick(HOUR);
    expect(await at.search(at.hermes.token), "its hour over, Health withheld again").toEqual({ hits: 2, outside: true });

    const always = ask(at.hermes.id, health, null);
    if (!("request" in always)) throw new Error("the request was held");
    const alwaysCard = (await at.phone("GET", `/v1/agents/asks/${always.request.id}`)).body as unknown as AgentAsk;
    expect((await at.phone("POST", "/v1/agents/answer", { id: always.request.id, answer: "always", expect: alwaysCard.version })).body).toMatchObject({ state: "allowed", version: 3 });
    at.tick(DAY);
    expect(await at.search(at.hermes.token), "Always: Health a day on").toEqual({ hits: 3, outside: false });

    const mail = { read: { account: HOME_MAIL }, window: null } as const;
    const first = ask(mistral.grant, mail, HOUR);
    if (!("request" in first)) throw new Error("the request was held");
    expect((await at.phone("POST", "/v1/agents/answer", { id: first.request.id, answer: "no" })).body).toEqual({ state: "declined", version: 1, outcome: wordsAt("Not allowed on iPhone,", expect.any(Number)), reader: null, connected: null });
    expect(at.ledger.access.get(mistral.grant)?.version, "a No leaves the access").toBe(1);
    expect(ask(mistral.grant, mail, HOUR), "the same want, held a day").toEqual({ held: { declined_ms: at.now(), until_ms: at.now() + DAY } });
    expect(ask(mistral.grant, mail, null), "however long it asks for").toMatchObject({ held: { until_ms: at.now() + DAY } });
    at.tick(HOUR);
    const other = ask(mistral.grant, { read: { category: "health" }, window: null }, HOUR);
    expect("request" in other, "another want is asked").toBe(true);
    at.tick(DAY - HOUR);
    const second = ask(mistral.grant, mail, HOUR);
    if (!("request" in second)) throw new Error("a day on, the same want is asked again");
    expect(at.ledger.access.request((other as { request: { id: string } }).request.id, at.now())?.state, "one open request: the new one replaced it").toBe("replaced");
    expect((await at.phone("POST", "/v1/agents/answer", { id: second.request.id, answer: "no" })).body).toMatchObject({ state: "declined" });
    at.tick(2 * DAY);
    expect(ask(mistral.grant, mail, HOUR), "declined twice: held until the person changes the access").toMatchObject({ held: { until_ms: null } });
    const narrowed: Access = { ...workOnly, window: { past_ms: 30 * DAY } };
    expect((await at.phone("POST", `/v1/agents/${mistral.grant}/access`, { access: narrowed, expect: 1 })).status).toBe(200);
    const after = ask(mistral.grant, mail, HOUR);
    expect("request" in after, "the person changed the access: the want is asked again").toBe(true);

    const drawn = (await waiting()).asks.find((each) => each.reader === mistral.grant)!;
    expect(drawn.version).toBe(2);
    expect((await at.phone("POST", `/v1/agents/${mistral.grant}/access`, { access: { ...narrowed, window: { past_ms: 7 * DAY } }, expect: 2 })).status).toBe(200);
    const stale = await at.phone("POST", "/v1/agents/answer", { id: drawn.id, answer: "once", expect: drawn.version });
    expect([stale.status, stale.body.code, at.ledger.access.get(mistral.grant)?.version], "a card drawn before a change is refused, nothing written").toEqual([409, "ACCESS_CHANGED", 3]);
    expect((await waiting()).asks.map((each) => each.id), "still waiting, to be drawn again").toEqual([drawn.id]);
    at.tick(DAY);
    expect((await waiting()).asks, "a day on, it lapsed and left the list").toEqual([]);
    const lapsed = await at.phone("POST", "/v1/agents/answer", { id: drawn.id, answer: "once", expect: 3 });
    expect([lapsed.status, lapsed.body], "an answer to a lapsed request writes nothing").toEqual([200, { state: "lapsed", version: 3, outcome: wordsOnly("This request is over."), reader: null, connected: null }]);
  });
});

const OWN_FIXTURES = join(REPO, "homelink", "Tests", "Fixtures", "agents", "own");
const WRITE = process.env.LIFESTREAM_FIXTURES === "write";

function ownContract() {
  const files = new Map<string, string>();
  return {
    write(file: string, route: string, request: unknown, answer: { status: number; body: JsonObject }) {
      const seen = new Map<string, string>();
      const text = JSON.stringify({ route, request: request ?? null, status: answer.status, answer: answer.body }, null, 2)
        .replace(/\brq-[0-9a-f]{16}\b/gu, (id) => {
          if (!seen.has(id)) seen.set(id, `rq-${(seen.size + 1).toString(16).padStart(16, "0")}`);
          return seen.get(id)!;
        });
      expect(files.has(file), `one case, one file: ${file}`).toBe(false);
      files.set(file, `${text}\n`);
    },
    settle() {
      if (WRITE) {
        rmSync(OWN_FIXTURES, { recursive: true, force: true });
        mkdirSync(OWN_FIXTURES, { recursive: true });
        for (const [file, text] of files) writeFileSync(join(OWN_FIXTURES, `${file}.json`), text);
        return;
      }
      const held = existsSync(OWN_FIXTURES) ? readdirSync(OWN_FIXTURES).filter((file) => file.endsWith(".json")).sort() : [];
      expect(held, "homelink/Tests/Fixtures/agents/own/ holds these cases: LIFESTREAM_FIXTURES=write writes them").toEqual([...files.keys()].map((file) => `${file}.json`).sort());
      for (const [file, text] of files) expect(readFileSync(join(OWN_FIXTURES, `${file}.json`), "utf8"), `agents/own/${file}.json is this answer: LIFESTREAM_FIXTURES=write writes it`).toBe(text);
    },
  };
}

describe("an agent asks for more, and drops what it reads, with its own pass", () => {
  const files = ownContract();
  afterAll(() => files.settle());

  it("a request draws its card on the waiting list; allowed for its hour, always or not, the next `access` says so and the next read is under the access that answer left; the same want declined is held a day, twice until the person changes the access; replaced, dropped and lapsed requests read so", async () => {
    const at = await journey();
    const hermes = at.hermes;
    const own = async () => (await at.call(hermes.token, "GET", "/v1/access")).body as unknown as OwnAccess;
    const asking = async (body: JsonObject) => await at.call(hermes.token, "POST", "/v1/access/request", body);
    const waiting = async () => ((await at.phone("GET", "/v1/agents/waiting")).body as unknown as WaitingList).asks;
    const health = { request: { read: { category: "health" } }, reason: "Your sleep this week." };

    const asked = await asking(health);
    expect(asked).toEqual({ status: 200, body: {
      state: "asked", words: "Asked. Your person will see it on their Mac or iPhone. Call `access` to see their answer.",
      request: { id: expect.stringMatching(/^rq-/u), wants: "Health for 1 hour", at_ms: at.now(), until_ms: at.now() + DAY },
    } });
    files.write("request-asked", "POST /v1/access/request", health, asked);
    const [card] = await waiting();
    expect(card).toMatchObject({ reader: hermes.id, head: "Hermes asks to see Health for 1 hour", reason: "Your sleep this week.", default: "once", state: "open" });
    const open = await at.call(hermes.token, "GET", "/v1/access");
    expect((open.body as unknown as OwnAccess).request).toMatchObject({ wants: "Health for 1 hour" });
    expect((open.body as unknown as OwnAccess).text).toContain("Your request (Health for 1 hour) waits for your person's answer.\nAsk for more, or drop a line, with `access`.");
    files.write("access-open", "GET /v1/access", null, open);

    expect((await at.phone("POST", "/v1/agents/answer", { id: card!.id, answer: "once", expect: card!.version })).body).toMatchObject({ state: "allowed" });
    const allowed = await at.call(hermes.token, "GET", "/v1/access");
    expect((allowed.body as unknown as OwnAccess)).toMatchObject({ request: null, answer: { state: "allowed", wants: "Health for 1 hour" } });
    expect((allowed.body as unknown as OwnAccess).text).toContain("Your request (Health for 1 hour) was allowed.");
    files.write("access-allowed", "GET /v1/access", null, allowed);
    expect(await at.search(hermes.token), "allowed for its hour: Health too").toEqual({ hits: 3, outside: false });
    const again = await asking(health);
    expect(again.body, "what the access allows is not asked").toEqual({ state: "already", words: "Your access already allows this: nothing was asked.", request: null });
    files.write("request-already", "POST /v1/access/request", health, again);
    at.tick(HOUR);
    expect(await at.search(hermes.token), "its hour over").toEqual({ hits: 2, outside: true });

    const always = { ...health, for: "always" };
    expect((await asking(always)).body).toMatchObject({ state: "asked", request: { wants: "Health" } });
    const [alwaysCard] = await waiting();
    expect(alwaysCard).toMatchObject({ head: "Hermes asks to see Health", default: "always" });
    expect((await at.phone("POST", "/v1/agents/answer", { id: alwaysCard!.id, answer: "always", expect: alwaysCard!.version })).body).toMatchObject({ state: "allowed" });
    at.tick(DAY);
    expect(await at.search(hermes.token), "always: Health a day on").toEqual({ hits: 3, outside: false });

    const { lines, version: read } = await own();
    expect(lines).toEqual(["1. Everything but Health and Money · all time", `2. Health · all time · ended ${dayMonth(NOW_MS + HOUR)} ${clockOf(NOW_MS + HOUR)}`, "3. Health · all time", "4. details hidden"]);
    const noVersion = await at.call(hermes.token, "POST", "/v1/access/drop", { drop: 3 });
    expect([noVersion.status, noVersion.body]).toEqual([422, { code: "BAD_REQUEST", message: "dropping a line names the version you read: drop and version, as `access` gave them" }]);
    files.write("drop-no-version", "POST /v1/access/drop", { drop: 3 }, noVersion);
    const drop = await at.call(hermes.token, "POST", "/v1/access/drop", { drop: 3, version: read });
    expect(drop.status, JSON.stringify(drop.body)).toBe(200);
    expect((drop.body as unknown as OwnDrop).words).toBe("Dropped line 3.");
    expect((drop.body as unknown as OwnDrop).now.lines).toEqual([lines[0], lines[1], "3. details hidden"]);
    files.write("drop-line", "POST /v1/access/drop", { drop: 3, version: read }, drop);
    expect(await at.search(hermes.token), "a drop narrows at once").toEqual({ hits: 2, outside: true });
    expect(at.ledger.access.changes(hermes.id, { limit: 1 })[0]).toMatchObject({ what: "narrowed", by: "agent" });
    const stale = await at.call(hermes.token, "POST", "/v1/access/drop", { drop: 1, version: read });
    expect([stale.status, stale.body], "line 1 of the access it read is not line 1 of the access now").toEqual([409, {
      code: "ACCESS_CHANGED", message: "Your access changed since you read it: call `access` again, and drop by the numbers and version it gives.",
    }]);
    files.write("drop-stale", "POST /v1/access/drop", { drop: 1, version: read }, stale);
    const now = (await own()).version;
    for (const [file, line, words] of [
      ["drop-hide-refused", 3, "Line 3 says what stays hidden: dropping it would widen your access. Drop a line that allows a read."],
      ["drop-no-line", 5, "Your access has no line 5: its lines are 1 to 3."],
    ] as const) {
      const refused = await at.call(hermes.token, "POST", "/v1/access/drop", { drop: line, version: now });
      expect([refused.status, refused.body]).toEqual([422, { code: "BAD_REQUEST", message: words }]);
      files.write(file, "POST /v1/access/drop", { drop: line, version: now }, refused);
    }

    const mail = { request: { read: { account: HOME_MAIL } }, reason: "The home mailbox." };
    expect((await at.call(hermes.token, "POST", "/v1/access/drop", { drop: "everything" })).body).toMatchObject({ words: "Dropped everything you read.", now: { lines: ["1. details hidden"] } });
    expect(await at.search(hermes.token)).toEqual({ hits: 0, outside: true });
    const first = await asking(mail);
    expect((await asking({ ...mail, for: "30m" })).body, "a second request replaces the first").toMatchObject({ state: "asked", request: { wants: "your Gmail for 30 minutes" } });
    expect(at.ledger.access.request((first.body as unknown as OwnRequest).request!.id, at.now())?.state).toBe("replaced");
    const dropRequest = await at.call(hermes.token, "POST", "/v1/access/drop", { drop: "request" });
    expect((dropRequest.body as unknown as OwnDrop)).toMatchObject({ words: "Dropped your request.", now: { request: null, answer: { state: "dropped" } } });
    expect((dropRequest.body as unknown as OwnDrop).now.text).toContain("Your request (your Gmail for 30 minutes) was dropped.");
    files.write("drop-request", "POST /v1/access/drop", { drop: "request" }, dropRequest);
    expect(await waiting(), "a dropped request leaves the list").toEqual([]);
    const none = await at.call(hermes.token, "POST", "/v1/access/drop", { drop: "request" });
    expect([none.status, none.body]).toEqual([404, { code: "AGENT_REQUEST_GONE", message: "You have no open request to drop." }]);
    files.write("drop-nothing-open", "POST /v1/access/drop", { drop: "request" }, none);

    await asking(mail);
    at.tick(DAY);
    expect(await waiting(), "a day on, it lapsed").toEqual([]);
    expect((await own()).text).toContain("Your request (your Gmail for 1 hour) lapsed with no answer.");

    await asking(mail);
    const [mailCard] = await waiting();
    expect((await at.phone("POST", "/v1/agents/answer", { id: mailCard!.id, answer: "no" })).body).toMatchObject({ state: "declined" });
    const declined = await at.call(hermes.token, "GET", "/v1/access");
    expect((declined.body as unknown as OwnAccess).text).toContain("Your request (your Gmail for 1 hour) was declined.");
    files.write("access-declined", "GET /v1/access", null, declined);
    expect(await at.search(hermes.token), "a No leaves the access").toEqual({ hits: 0, outside: true });
    const held = await asking(mail);
    expect(held.body).toEqual({ state: "held", words: `Declined on ${dayMonth(at.now())}. You can ask again after ${dayMonth(at.now() + DAY)} ${clockOf(at.now())}.`, request: null });
    files.write("request-held", "POST /v1/access/request", mail, held);
    at.tick(DAY);
    await asking(mail);
    const [secondCard] = await waiting();
    await at.phone("POST", "/v1/agents/answer", { id: secondCard!.id, answer: "no" });
    at.tick(3 * DAY);
    const twice = await asking(mail);
    expect(twice.body).toEqual({ state: "held", words: "Declined twice. Your person can change your access in Lifestream.", request: null });
    files.write("request-held-twice", "POST /v1/access/request", mail, twice);
    const version = at.ledger.access.get(hermes.id)!.version;
    expect((await at.phone("POST", `/v1/agents/${hermes.id}/access`, { access: { ...defaultAccess(), allow: [], window: { past_ms: 30 * DAY } }, expect: version })).status).toBe(200);
    expect((await asking(mail)).body, "the person changed the access: the want is asked again").toMatchObject({ state: "asked" });

    const calls = at.ledger.access.calls(hermes.id, { limit: 100 }).filter((each) => each.tool === "access" && each.sent !== null);
    expect(calls.every((each) => each.result !== "running"), "each request and drop is a call's row").toBe(true);
    expect(calls[0]).toMatchObject({ sent: mail, result: "answered" });
  });

  it("a product's request allows its accounts of that day; a placeholder is put back; what cannot be asked is refused at once in words, and a pass not an agent's reaches neither route", async () => {
    const at = await journey();
    const hermes = at.hermes;
    const product = { request: { read: { product: "gmail" }, past: "7d" }, for: "2h", reason: "Mail about the garden." };
    await at.call(hermes.token, "POST", "/v1/access/drop", { drop: "everything" });
    const asked = await at.call(hermes.token, "POST", "/v1/access/request", product);
    expect(asked.body).toMatchObject({ state: "asked", request: { wants: "all of Gmail from the past 7 days for 2 hours" } });
    files.write("request-product", "POST /v1/access/request", product, asked);
    const [card] = ((await at.phone("GET", "/v1/agents/waiting")).body as unknown as WaitingList).asks;
    expect(card).toMatchObject({ under: "person-a@example.com and person-b@example.com" });
    await at.phone("POST", "/v1/agents/answer", { id: card!.id, answer: "once", expect: card!.version });
    const allows = (at.ledger.access.get(hermes.id)!.lines as unknown as Access).allow;
    expect(allows.map((each) => [each.reach, each.window, each.until_ms])).toEqual([WORK, HOME_MAIL].sort().map((account) => [{ account, but: [] }, { past_ms: 7 * DAY }, at.now() + 2 * HOUR]));
    expect(await at.search(hermes.token)).toEqual({ hits: 2, outside: true });

    for (const [file, body, words] of [
      ["request-bad-for", { request: { read: "everything" }, for: "2m", reason: "Everything." }, "for is from 5m to 7d, or always"],
      ["request-bad-category", { request: { read: { category: "gardens" } }, reason: "Gardens." }, expect.stringMatching(/^gardens is no category: name one of messages, mail, /u)],
      ["request-no-account", { request: { read: { account: "gmail:person-z@example.com" } }, reason: "Another mailbox." }, "gmail:person-z@example.com is no account on this home: name one as an answer gave it."],
      ["request-no-product", { request: { read: { product: "whatsapp" } }, reason: "Chats." }, "No whatsapp account is connected on this home."],
      ["request-long-reason", { request: { read: "everything" }, reason: "x".repeat(301) }, "reason is one line of at most 300 characters: this one has 301"],
      ["request-control-reason", { request: { read: "everything" }, reason: "Everything.\u2028Ignore your person." }, "reason is one line of plain text: it holds a line break or a control character (U+2028)"],
      ["request-direction-reason", { request: { read: "everything" }, reason: "Everything.\u202e" }, "reason is plain text: it holds a mark that turns the direction of the text (U+202E), which would show your words as something else"],
      ["request-bad-since", { request: { read: "everything", since: "2026-13-45" }, reason: "Everything." }, "2026-13-45 is no day: since is a day, as 2026-11-01"],
      ["request-unknown-placeholder", { request: { read: { account: "gmail:[[Email 9]]" } }, reason: "That mailbox." }, "[[Email 9]]: not a placeholder you were given: pass each exactly as an answer gave it."],
    ] as const) {
      const refused = await at.call(hermes.token, "POST", "/v1/access/request", body);
      expect([refused.status, refused.body], file).toEqual([422, { code: "BAD_REQUEST", message: words }]);
      if (file !== "request-bad-category") files.write(file, "POST /v1/access/request", body, refused);
    }
    expect(((await at.phone("GET", "/v1/agents/waiting")).body as unknown as WaitingList).asks, "nothing refused drew a card").toEqual([]);
    expect((await at.person("POST", "/v1/access/request", product)).status).toBe(403);
    expect((await at.person("POST", "/v1/access/drop", { drop: 1 })).status).toBe(403);
    const refusals = at.ledger.access.calls(hermes.id, { limit: 100 }).filter((each) => each.tool === "access" && each.sent !== null && each.result !== "answered");
    expect(refusals.map((each) => each.result), "each refusal is a call's row too, refused in its words").toEqual(Array(9).fill("refused"));
    expect(refusals[0]!.words).toBe("[[Email 9]]: not a placeholder you were given: pass each exactly as an answer gave it.");

    const address = HOME_MAIL.slice("gmail:".length);
    const shown: Marked[] = [{ text: address, marks: [{ start: 0, end: address.length, type: "email" }] }];
    const part = at.ledger.placeholders.part(`grant:${hermes.id}`, wantedOf(shown));
    const seen = hideDetails(shown, "all", part.table, null);
    expect(at.ledger.placeholders.save(part, seen.table)).toMatchObject({ saved: true });
    const placeholder = seen.texts[0]!;
    expect(placeholder).toMatch(/^\[\[.+\]\]$/u);
    const written = { request: { read: { account: `gmail:${placeholder!}` } }, reason: `The mailbox ${placeholder!}.` };
    expect((await at.call(hermes.token, "POST", "/v1/access/request", written)).body).toMatchObject({ state: "asked" });
    const [put] = ((await at.phone("GET", "/v1/agents/waiting")).body as unknown as WaitingList).asks;
    expect(put, "the placeholder is put back; the reason stays as written").toMatchObject({ reason: written.reason, under: "person-b@example.com" });
    expect(at.ledger.access.calls(hermes.id, { limit: 1 })[0]).toMatchObject({ sent: written, read: { want: { read: { account: HOME_MAIL }, window: null }, for_ms: HOUR } });
    const emoji = { request: { read: { category: "health" } }, reason: "😴".repeat(300) };
    expect((await at.call(hermes.token, "POST", "/v1/access/request", emoji)).body, "300 emoji are 300 characters, at the door as in the ledger").toMatchObject({ state: "asked" });
  });
});

describe("an agent's own request and Chat's proposal for it stand apart", () => {
  it("the agent drops a line; with Chat's proposal open then, the agent reads its access, asks and drops its request, all answered, and Chat's proposal stays; the waiting list shows both, each in its own words; Chat's narrowing never lifts a want declined twice", async () => {
    const at = await journey();
    const hermes = at.hermes;
    const own = async () => {
      const read = await at.call(hermes.token, "GET", "/v1/access");
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      return read.body as unknown as OwnAccess;
    };
    const waiting = async () => ((await at.phone("GET", "/v1/agents/waiting")).body as unknown as WaitingList).asks;
    const dropped = await at.call(hermes.token, "POST", "/v1/access/drop", { drop: 1, version: (await own()).version });
    expect([dropped.status, (dropped.body as unknown as OwnDrop).words]).toEqual([200, "Dropped line 1."]);
    const held = at.ledger.access.get(hermes.id)!;
    const now = held.lines as unknown as Access;
    const widened: Access = { ...now, allow: [...now.allow, { reach: { type: "health", but: [] }, window: null, until_ms: null }] };
    const proposed = await at.chat("POST", `/v1/agents/${hermes.id}/propose`, { access: widened, expect: held.version });
    expect(proposed.body, JSON.stringify(proposed.body)).toMatchObject({ kind: "asked", snapshot: { by: "chat", head: "Let Hermes also read Health?", reason: null } });
    const proposal = (proposed.body as { id: string }).id;

    const first = await own();
    expect([first.request, first.answer], "Chat's proposal is not the agent's request").toEqual([null, null]);
    expect(first.text).not.toContain("Your request");
    const health = { request: { read: { category: "health" } }, reason: "Your sleep this week." };
    const asked = await at.call(hermes.token, "POST", "/v1/access/request", health);
    expect(asked.body).toMatchObject({ state: "asked", request: { wants: "Health for 1 hour" } });
    expect(at.ledger.access.request(proposal, at.now())?.state, "the agent's request replaced nothing of Chat's").toBe("open");
    const both = await waiting();
    expect(both.map((each) => [each.by, each.head, each.reason])).toEqual([
      ["chat", "Let Hermes also read Health?", null],
      ["agent", "Hermes asks to see Health for 1 hour", "Your sleep this week."],
    ]);
    expect((await own()).request).toMatchObject({ id: (asked.body as unknown as OwnRequest).request!.id, wants: "Health for 1 hour" });
    const dropRequest = await at.call(hermes.token, "POST", "/v1/access/drop", { drop: "request" });
    expect(dropRequest.body).toMatchObject({ words: "Dropped your request.", now: { request: null, answer: { state: "dropped", wants: "Health for 1 hour" } } });
    const none = await at.call(hermes.token, "POST", "/v1/access/drop", { drop: "request" });
    expect([none.status, none.body.message], "Chat's proposal is not the agent's to drop").toEqual([404, "You have no open request to drop."]);
    expect((await waiting()).map((each) => [each.id, each.by])).toEqual([[proposal, "chat"]]);
    expect(at.ledger.access.request(proposal, at.now())?.state).toBe("open");

    const mail = { request: { read: { account: HOME_MAIL } }, reason: "The home mailbox." };
    for (let n = 0; n < 2; n++) {
      expect((await at.call(hermes.token, "POST", "/v1/access/request", mail)).body).toMatchObject({ state: "asked" });
      const card = (await waiting()).find((each) => each.by === "agent")!;
      expect((await at.phone("POST", "/v1/agents/answer", { id: card.id, answer: "no" })).body).toMatchObject({ state: "declined" });
      at.tick(DAY);
    }
    expect(at.ledger.access.request(proposal, at.now())?.state, "a day on, Chat's proposal lapsed").toBe("lapsed");
    const before = at.ledger.access.get(hermes.id)!;
    const narrowed = await at.chat("POST", `/v1/agents/${hermes.id}/propose`, { access: { ...(before.lines as unknown as Access), window: { past_ms: 30 * DAY } }, expect: before.version });
    expect(narrowed.body).toMatchObject({ kind: "narrowed" });
    expect(at.ledger.access.changes(hermes.id, { limit: 1 })[0]).toMatchObject({ what: "narrowed", by: "chat" });
    expect((await at.call(hermes.token, "POST", "/v1/access/request", mail)).body, "Chat's change is not the person's: the want stays held")
      .toEqual({ state: "held", words: "Declined twice. Your person can change your access in Lifestream.", request: null });
    const after = at.ledger.access.get(hermes.id)!;
    expect((await at.phone("POST", `/v1/agents/${hermes.id}/access`, { access: { ...(after.lines as unknown as Access), window: { past_ms: 60 * DAY } }, expect: after.version })).status).toBe(200);
    expect((await at.call(hermes.token, "POST", "/v1/access/request", mail)).body, "the person's change lifts it").toMatchObject({ state: "asked" });

    const history = (await at.phone("GET", `/v1/agents/${hermes.id}/history`)).body as unknown as HistoryPage;
    const drawn = history.sessions.flatMap((each) => each.lines).flatMap((each) => (each.kind === "fold" ? each.lines : [each]));
    const said = drawn.map((each) => each.words);
    expect(said.filter((words) => words === "Asked to see Health for 1 hour"), "one act, one line").toHaveLength(1);
    expect(said).toContain("Took back its ask");
    expect(drawn.filter((each) => each.kind === "call").map((each) => each.words)).toContain("Read its access");
    expect(said.filter((words) => words.startsWith("It gave up")), said.join(" | ")).toHaveLength(1);

    const last = at.ledger.access.get(hermes.id)!;
    const lines = last.lines as unknown as Access;
    const money: Access = { ...lines, allow: [...lines.allow, { reach: { type: "money", but: [] }, window: null, until_ms: null }] };
    const erasing = await at.chat("POST", `/v1/agents/${hermes.id}/propose`, { access: money, expect: last.version });
    const erased = (erasing.body as { id: string }).id;
    const file = new Database(join(at.home.root, "replies", "replies.db"));
    try {
      file.prepare("UPDATE access_requests SET want = NULL, want_key = NULL WHERE id = ?").run(erased);
    } finally {
      file.close();
    }
    expect((await at.phone("GET", `/v1/agents/asks/${erased}`)).body, "an erased proposal of Chat's still reads as Chat's")
      .toMatchObject({ by: "chat", head: "What this asked for was erased.", reason: null, choices: [{ answer: "no", words: "Don’t allow" }] });
  });
});

function dayMonth(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(ms);
}

function clockOf(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }).format(ms);
}
