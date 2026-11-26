import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { openHomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import { defaultAccess } from "./access.js";
import { openStage } from "./ask-files.js";
import { CODE_MS } from "./pairing.js";
import { ACTS, serveDoor, type Act } from "./door.js";
import { clockConnectors, ranOf } from "./test/clock-fakes.js";
import { NO_ANSWER, Refusal, STARTING, STILL_WORKING } from "./refusal.js";
import { mintPrincipal, readPrincipals } from "./principals.js";
import { settingsPath } from "./settings.js";
import { startHome } from "./home.js";
import { ask, askHome, serveSocket } from "./socket.js";
import { fakeDeclarations } from "./test/fakes.js";
import { editSettings, TEST_UNIT, testSocket } from "./test/folder.js";
import { FAKES, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { machine } from "./machine.js";
import { inboxLane } from "./inbox.js";
import { DEVICE, makeHome, makeHomeDb, NOW_MS, PHONE_UNIT, REPO } from "./test/support.js";


const report: Record<string, unknown> = {};

const RELAYED: Record<Act, { again: boolean; wait_ms: number; streams?: true }> = {
  "POST /v1/pair": { again: true, wait_ms: 30_000 },
  "POST /v1/act": { again: false, wait_ms: 30_000 },
  "POST /v1/refresh": { again: true, wait_ms: 30_000 },
  "POST /v1/account": { again: true, wait_ms: 30_000 },
  "POST /v1/settings": { again: true, wait_ms: 30_000 },
  "POST /v1/seal": { again: false, wait_ms: 30_000 },
  "POST /v1/signin/<way>": { again: false, wait_ms: 30_000 },
  "POST /v1/process": { again: true, wait_ms: 30_000 },
  "POST /v1/connectors/<id>": { again: true, wait_ms: 30_000 },
  "POST /v1/owner/act": { again: true, wait_ms: 30_000 },
  "POST /v1/exchange drained": { again: false, wait_ms: 30_000 },
  "POST /v1/stations/exchange": { again: true, wait_ms: 30_000 },
  "POST /v1/feedback": { again: false, wait_ms: 30_000 },
  "POST /v1/feedback/draft": { again: true, wait_ms: 30_000 },
  "POST /v1/feedback/screenshot": { again: true, wait_ms: 30_000 },
  "POST /v1/feedback/send": { again: true, wait_ms: 30_000 },
  "POST /v1/subscriptions/<name>": { again: true, wait_ms: 30_000 },
  "GET /v1/subscriptions": { again: true, wait_ms: 30_000 },
  "GET /v1/secrets/openrouter": { again: true, wait_ms: 30_000 },
  "POST /v1/chat/completions": { again: false, wait_ms: 5_000, streams: true },
  "POST /v1/ask/words": { again: true, wait_ms: 15_000 },
  "GET /v1/places/suggest": { again: false, wait_ms: 5_000 },
  "POST /v1/agents/request": { again: false, wait_ms: 30_000 },
  "GET /v1/agents/request/<id>": { again: true, wait_ms: 30_000 },
  "POST /v1/agents/grant": { again: false, wait_ms: 30_000 },
  "POST /v1/agents/refresh": { again: false, wait_ms: 30_000 },
  "POST /v1/agents/revoke": { again: true, wait_ms: 30_000 },
  "GET /v1/agents/waiting": { again: true, wait_ms: 30_000 },
  "GET /v1/agents/signins/<id>": { again: true, wait_ms: 30_000 },
  "POST /v1/agents/answer": { again: false, wait_ms: 30_000 },
  "POST /v1/agents/<id>/disconnect": { again: true, wait_ms: 30_000 },
  "GET /v1/agents/address": { again: true, wait_ms: 30_000 },
  "POST /v1/agents/address": { again: true, wait_ms: 30_000 },
  "POST /v1/agents/keys": { again: false, wait_ms: 30_000 },
};
const SUGGEST = "GET /v1/places/suggest" satisfies Act;
const WAIT_MS = 3_000;
const WAITED = { "lifestream-wait": String(WAIT_MS) };

afterAll(() => {
  const directory = join(REPO, "packages", "home", ".build", "e2e");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "relay.json"), `${JSON.stringify(report, null, 2)}\n`);
});

type Mode = "silent" | "begins" | "closed" | "refuses" | "throws";

async function standIn(path: string): Promise<{ mode: Mode; heard: JsonObject[]; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const state = { mode: "silent" as Mode, heard: [] as JsonObject[] };
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk.toString("utf8");
      const end = text.indexOf("\n");
      if (end < 0) return;
      state.heard.push(JSON.parse(text.slice(0, end)) as JsonObject);
      if (state.mode === "begins") socket.write(`${JSON.stringify({ began: true })}\n`);
      if (state.mode === "closed") socket.destroy();
      if (state.mode === "refuses") socket.end(`${JSON.stringify({ error: "[STAND_IN] refused", refusal: { status: 409, code: "STAND_IN", words: "The stand-in refused this.", retryAfter: 7, extra: {} } })}\n`);
      if (state.mode === "throws") socket.end(`${JSON.stringify({ error: "the stand-in failed at /private/stand-in/home.db" })}\n`);
    });
  });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return Object.assign(state, {
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  });
}

async function call(url: string, method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const response = await fetch(`${url}${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, retry: response.headers.get("retry-after"), body: await response.json() as JsonObject };
}

describe("the home's refusal on its socket", () => {
  it("is carried whole, every member the home refused with read back by the door (R3)", async () => {
    const root = makeRoot("lifestream-relay-socket-", { sources: {} });
    onTestFinished(() => removeRoot(root));
    const home = testSocket(root);
    const { path } = home;
    const served = await serveSocket(path, async () => { throw new Refusal(503, "NOT_NOW", "Your people are being prepared.", 5, { detail: "synthetic" }); });
    onTestFinished(() => served.close());
    const refused = await ask(home, { verb: "owner-act" }).then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(Refusal);
    const { status, code, words, retryAfter, extra } = refused as Refusal;
    expect({ status, code, words, retryAfter, extra }).toEqual({ status: 503, code: "NOT_NOW", words: "Your people are being prepared.", retryAfter: 5, extra: { detail: "synthetic" } });
  });

  it("says a refusal's words alone as its line's error, which the Mac shows as it is, its code only in the refusal; any other failure as its text (R3)", async () => {
    const root = makeRoot("lifestream-relay-words-", { sources: {} });
    onTestFinished(() => removeRoot(root));
    const home = testSocket(root);
    const { path } = home;
    const served = await serveSocket(path, async (request) => {
      if (request.verb === "refused") throw new Refusal(503, "NOT_NOW", STARTING, 5);
      throw new Error("a synthetic failure");
    });
    onTestFinished(() => served.close());
    const line = (verb: string) => new Promise<JsonObject>((resolve, reject) => {
      const socket = createConnection(path);
      let text = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => { text += chunk; });
      socket.on("end", () => resolve(JSON.parse(text.trim()) as JsonObject));
      socket.on("error", reject);
      socket.write(`${JSON.stringify({ verb, args: [] })}\n`);
    });
    expect(await line("refused")).toEqual({ error: STARTING, refusal: { status: 503, code: "NOT_NOW", words: STARTING, retryAfter: 5, extra: {} } });
    expect(await line("failed")).toEqual({ error: "a synthetic failure" });
    const refused = await ask(home, { verb: "refused" }).then(() => undefined, (error: unknown) => error);
    expect((refused as Refusal).message).toBe(`[NOT_NOW] ${STARTING}`);
  });
});

const RETIRED_UNIT = "synthetic-iphone-5a50";
const REPORT_ID = "00000000-0000-4000-8000-000000000001";

describe("one relay, every route", () => {
  it("answers each relayed route one of five: never reached, begun and not answered, not answered, refused, failed; the home given its deadline from the route's wait and the device's (R1-R5)", async () => {
    const people = `people:local:${TEST_UNIT}`;
    const at = makeHome({
      mac: { kind: "mac", scopes: ["deliver"], sources: ["machine:local:mac"] },
      phone: { kind: "phone", scopes: ["deliver", "read"], sources: [people], unit: PHONE_UNIT },
      retired: { kind: "phone", scopes: ["deliver", "read"], sources: [people], unit: RETIRED_UNIT },
      reader: { scopes: ["read"] },
      mcp: { scopes: ["admit"] },
      station: { kind: "extension", scopes: ["station"], unit: "chrome-0000aa01" },
      ask: { scopes: ["deliver"], sources: [`ask:local:${TEST_UNIT}`], unit: "ask" },
    }, []);
    mkdirSync(join(machine().dir, "ask"), { recursive: true });
    writeFileSync(join(machine().dir, "ask", "door-token"), `${at.tokens.ask}\n`);
    const agent = mintPrincipal(openHomeFolder(at.root), {
      unit: "agent", kind: "agent", scopes: ["read"], now_ms: NOW_MS, granted: { agent: { name: "Synthetic agent", via: "pass", from: null, checked: false, client_id: null, resource: null } },
    }).principal.id;
    const stage = openStage(openHomeFolder(at.root));
    await stage.second("0123456789abcdef0123456789abcdef", 0, Buffer.alloc(2_000, 1));
    const joined = (await stage.join("0123456789abcdef0123456789abcdef", 1)).audio;
    await stage.carry([joined], inboxLane(openHomeFolder(at.root), `ask:local:${TEST_UNIT}`), { has: () => false, materialise: () => Promise.reject(new Error("the store holds none")) });
    const audio = joined.slice(7);
    onTestFinished(() => rmSync(at.root, { recursive: true, force: true }));
    const db = makeHomeDb(join(at.root, "home.db"));
    db.prepare("INSERT INTO devices (unit, model, added_ms, retired_ms) VALUES (?, 'iPhone 17 Pro', ?, ?)").run(RETIRED_UNIT, NOW_MS - 1, NOW_MS);
    db.close();
    const logs: string[] = [];
    let codesSpent = 0;
    const door = await serveDoor(at.root, { port: 0, max_bundle_bytes: 1 << 30 }, {
      clock: () => Date.now() + codesSpent, log: (line) => logs.push(line), floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" }, connectors: fakeDeclarations(), tellMs: 250, feedbackOpen: true,
    });
    onTestFinished(() => door.close());
    const url = `http://127.0.0.1:${door.port}`;
    const as = (who: string) => ({
      authorization: `Bearer ${at.tokens[who]}`, ...(who === "mac" ? DEVICE.mac : who === "phone" || who === "retired" ? DEVICE.phone : who === "station" ? DEVICE.extension : {}), ...WAITED,
    });

    const routes: Record<Exclude<Act, typeof SUGGEST>, () => ReturnType<typeof call>> = {
      "POST /v1/pair": () => call(url, "POST", "/v1/pair", { ...DEVICE.mac, ...WAITED }, { code: "12345678", pass: randomBytes(32).toString("base64url"), kind: "mac", model: "MacBook Pro", serial4: "0001" }),
      "POST /v1/act": () => call(url, "POST", "/v1/act", as("reader"), { need: "fetch:fake-clock", do: "try" }),
      "POST /v1/refresh": () => call(url, "POST", "/v1/refresh", as("reader"), { connector: "location" }),
      "POST /v1/account": () => call(url, "POST", "/v1/account", as("phone"), { account: "person-a@example.com" }),
      "POST /v1/settings": () => call(url, "POST", "/v1/settings", as("phone"), { connector: "location", member: "precision", value: "battery", was: "precise" }),
      "POST /v1/seal": () => call(url, "POST", "/v1/seal", as("phone"), { connector: "whoop", member: "password", value: "synthetic-password-0" }),
      "POST /v1/signin/<way>": () => call(url, "POST", "/v1/signin/client/finish", as("phone"), { connector: "whoop", route: "whoop-api", attempt: {}, address: "http://127.0.0.1:50000/?state=s&code=c" }),
      "POST /v1/process": () => call(url, "POST", "/v1/process", as("phone"), { family: "photos", item: "photo:a1", prompt: "photo-caption", route: "fake:fake-caption" }),
      "POST /v1/connectors/<id>": () => call(url, "POST", "/v1/connectors/location", as("phone"), { paused: true }),
      "POST /v1/owner/act": () => call(url, "POST", "/v1/owner/act", as("phone"), { of: "people", kind: "confirm", request: "request-1", id: "person:person-a", relationship: "friend" }),
      "POST /v1/exchange drained": () => call(url, "POST", "/v1/exchange", as("retired"), { drained: true }),
      "POST /v1/stations/exchange": () => call(url, "POST", "/v1/stations/exchange", as("station"), {
        results: [], station: { unit: "chrome-0000aa01", version: "1.0.0", slots: 1, errands: [], boot: "boot-a", running: [], pressed: { choose: ["chat"], stop: [] }, allowing: [], opened: [], acted: [] },
      }),
      "POST /v1/feedback": () => call(url, "POST", "/v1/feedback", as("reader"), { category: "missing", message: "a synthetic note" }),
      "POST /v1/feedback/draft": () => call(url, "POST", "/v1/feedback/draft", as("reader"), { id: REPORT_ID, about: { kind: "menu" } }),
      "POST /v1/feedback/screenshot": () => call(url, "POST", `/v1/feedback/screenshot?id=${REPORT_ID}`, as("reader"), { bytes: "a synthetic screenshot, never landed" }),
      "POST /v1/feedback/send": () => call(url, "POST", "/v1/feedback/send", as("reader"), { id: REPORT_ID, text: "A synthetic report.", email: null, keep: ["app"] }),
      "POST /v1/subscriptions/<name>": () => call(url, "POST", "/v1/subscriptions/codex", as("mac")),
      "GET /v1/subscriptions": () => call(url, "GET", "/v1/subscriptions", as("mac")),
      "GET /v1/secrets/openrouter": () => call(url, "GET", "/v1/secrets/openrouter", as("ask")),
      "POST /v1/chat/completions": () => call(url, "POST", "/v1/chat/completions", as("ask"), { model: "fake:fake-model", messages: [{ role: "user", content: "a synthetic question" }] }),
      "POST /v1/ask/words": () => call(url, "POST", "/v1/ask/words", as("reader"), { audio: `sha256:${audio}` }),
      "POST /v1/agents/request": () => call(url, "POST", "/v1/agents/request", as("mcp"), { name: "Synthetic agent", checked: true, host: "example.com" }),
      "GET /v1/agents/request/<id>": () => call(url, "GET", "/v1/agents/request/request-1", as("mcp")),
      "POST /v1/agents/grant": () => call(url, "POST", "/v1/agents/grant", as("mcp"), { id: "request-1", client_id: "client", resource: "http://127.0.0.1:4681/mcp" }),
      "POST /v1/agents/refresh": () => call(url, "POST", "/v1/agents/refresh", as("mcp"), { refresh_token: "token", client_id: "client", resource: "http://127.0.0.1:4681/mcp" }),
      "POST /v1/agents/revoke": () => call(url, "POST", "/v1/agents/revoke", as("mcp"), { grant: "grant-1" }),
      "GET /v1/agents/waiting": () => call(url, "GET", "/v1/agents/waiting", as("phone")),
      "GET /v1/agents/signins/<id>": () => call(url, "GET", "/v1/agents/signins/AAAAAAAAAAAAAAAAAAAAAA", as("phone")),
      "POST /v1/agents/answer": () => call(url, "POST", "/v1/agents/answer", as("phone"), { id: "request-1", answer: "deny" }),
      "POST /v1/agents/<id>/disconnect": () => call(url, "POST", `/v1/agents/${agent}/disconnect`, as("phone"), {}),
      "GET /v1/agents/address": () => call(url, "GET", "/v1/agents/address", as("phone")),
      "POST /v1/agents/address": () => call(url, "POST", "/v1/agents/address", as("phone"), { on: true }),
      "POST /v1/agents/keys": () => call(url, "POST", "/v1/agents/keys", as("phone"), { app: "instinct", access: defaultAccess() }),
    };
    expect(Object.keys(routes).sort()).toEqual(Object.keys(ACTS).filter((act) => act !== SUGGEST).sort());
    expect(ACTS).toEqual(RELAYED);

    const answers: Record<string, unknown> = {};
    const sock = testSocket(at.root);
    for (const [act, send] of Object.entries(routes)) {
      const answer = await send();
      expect([answer.status, answer.body.code, answer.body.message, answer.retry], act).toEqual([503, "NOT_NOW", STARTING, "5"]);
      answers[act] = { never: answer.body };
    }
    const home = await standIn(sock.path);
    onTestFinished(() => home.close());
    for (const mode of ["silent", "begins", "closed", "refuses", "throws"] as const) {
      home.mode = mode;
      codesSpent += CODE_MS;
      const before = home.heard.length;
      const sent = await Promise.all((Object.entries(routes) as [Act, () => ReturnType<typeof call>][]).map(async ([act, send]) => [act, await send()] as const));
      expect(home.heard.length - before, `${mode}: each route reached the home once`).toBe(sent.length);
      for (const heard of home.heard.slice(before)) {
        expect((heard.deadline_ms as number) - (heard.sent_ms as number), `${String(heard.verb)} ${mode}: begun by its wait less 2 s`).toBeLessThanOrEqual(WAIT_MS - 2_000);
      }
      for (const [act, answer] of sent) {
        const kept = answers[act] as Record<string, unknown>;
        if (mode === "silent" || mode === "closed" || mode === "begins") {
          const began = mode === "begins";
          expect([answer.status, answer.body.code, answer.body.message, answer.retry, answer.body.again, answer.body.began], `${act} ${mode}`)
            .toEqual([503, "OUTCOME_UNKNOWN", began ? STILL_WORKING : NO_ANSWER, "5", RELAYED[act].again, began]);
        } else if (mode === "refuses") {
          expect([answer.status, answer.body.code, answer.body.message, answer.retry], `${act} ${mode}`).toEqual([409, "STAND_IN", "The stand-in refused this.", "7"]);
        } else {
          expect([answer.status, answer.body.code], `${act} ${mode}`).toEqual([500, "HOME_FAILED"]);
          expect(JSON.stringify(answer.body)).not.toContain("/private/stand-in");
        }
        kept[mode] = answer.body;
      }
    }
    for (const mode of ["silent", "closed", "refuses", "throws"] as const) {
      home.mode = mode;
      const before = home.heard.length;
      const answer = await call(url, "POST", "/v1/exchange", as("mac"), { offers: ["apple-calls:person-a@example.com:mac"] });
      expect([answer.status, home.heard.length - before], `offers ${mode}`).toEqual([200, 1]);
    }

    home.mode = "refuses";
    const waited = async (wait: string | null) => {
      const before = home.heard.length;
      const { authorization } = as("reader");
      const answer = await call(url, "POST", "/v1/act", { authorization, ...(wait === null ? {} : { "lifestream-wait": wait }) }, { need: "fetch:fake-clock", do: "try" });
      const heard = home.heard.slice(before);
      return { answer, heard: heard.length, begin_within: heard.length === 0 ? null : (heard[0]!.deadline_ms as number) - (heard[0]!.sent_ms as number) };
    };
    const unsaid = await waited(null);
    expect([unsaid.answer.body.code, unsaid.heard]).toEqual(["STAND_IN", 1]);
    expect(unsaid.begin_within, "no header: the route's wait").toBeLessThanOrEqual(RELAYED["POST /v1/act"].wait_ms - 2_000);
    expect(unsaid.begin_within).toBeGreaterThan(RELAYED["POST /v1/act"].wait_ms - 7_000);
    const capped = await waited("600000");
    expect(capped.begin_within, "a longer wait than the route's is the route's").toBeLessThanOrEqual(RELAYED["POST /v1/act"].wait_ms - 2_000);
    for (const wrong of ["soon", "0", "-5", "1.5", String(WAIT_MS - 1)]) {
      const refused = await waited(wrong);
      expect([refused.answer.status, refused.answer.body.code, refused.heard], wrong).toEqual([422, "BAD_REQUEST", 0]);
    }
    const typed = home.heard.length;
    await call(url, "GET", "/v1/places/suggest?q=synthetic%20bakery&latitude=12.5&longitude=77.5", { authorization: as("reader").authorization, "lifestream-wait": "60000" });
    const searched = home.heard.slice(typed).filter((each) => each.verb === "places-search");
    expect(searched, "the typed search goes through the relay").toHaveLength(1);
    expect((searched[0]!.deadline_ms as number) - (searched[0]!.sent_ms as number), "the typed search's wait is its row's").toBeLessThanOrEqual(RELAYED[SUGGEST].wait_ms - 2_000);
    report.routes = answers;
  });
});

type Between = { losing: boolean; holding: boolean; began: number; held: (() => void)[]; close(): Promise<void> };

async function losingSocket(root: string): Promise<Between> {
  const door = testSocket(root).path;
  const real = join(root, "real.sock");
  renameSync(door, real);
  const state = { losing: false, holding: false, began: 0, held: [] as (() => void)[] };
  const sockets = new Set<Socket>();
  const server = createServer((from) => {
    sockets.add(from);
    from.on("close", () => sockets.delete(from));
    const to = createConnection(real);
    sockets.add(to);
    to.on("close", () => sockets.delete(to));
    const lose = state.losing;
    const hold = state.holding;
    from.pipe(to);
    let answer = "";
    let kept = "";
    to.on("data", (chunk) => {
      if (!lose && !hold) {
        from.write(chunk);
        return;
      }
      answer += chunk.toString("utf8");
      if (lose) {
        if (answer.split("\n").some((line) => /"result"|"error"/u.test(line))) from.destroy();
        return;
      }
      for (let end = answer.indexOf("\n"); end >= 0; end = answer.indexOf("\n")) {
        const line = answer.slice(0, end + 1);
        answer = answer.slice(end + 1);
        if ((JSON.parse(line) as JsonObject).began !== true) kept += line;
        else {
          from.write(line);
          state.began++;
        }
      }
    });
    to.on("end", () => {
      if (hold) state.held.push(() => from.end(kept));
      else from.end();
    });
    to.on("error", () => from.destroy());
    from.on("error", () => to.destroy());
  });
  await new Promise<void>((resolve) => server.listen(door, resolve));
  return Object.assign(state, {
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => {
        rmSync(door, { force: true });
        renameSync(real, door);
        resolve();
      });
    }),
  });
}

describe("an act sent again", () => {
  it("answers an act the table says may be sent again as the first time, its answer lost, and the home holds one change (R6)", async () => {
    const root = makeRoot("lifestream-relay-again-", { sources: {} });
    const address = { port: 0, max_bundle_bytes: 8 * 1024 ** 3 };
    const door = await serveDoor(root, address, { log: () => undefined, floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" }, registry: FAKES, connectors: fakeDeclarations() });
    editSettings(root, { "door.port": door.port });
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, slot: null, log: () => undefined });
    const sock = testSocket(root);
    const code = (await askHome(sock, "pair")) as { code: string };
    const losing = await losingSocket(root);
    onTestFinished(async () => {
      await door.close();
      await losing.close();
      await home.stop();
      removeRoot(root);
    });
    const url = `http://127.0.0.1:${door.port}`;
    const principals = () => readPrincipals(openHomeFolder(root)).principals;
    const repeats: Record<string, unknown> = {};

    const twice = async (name: string, send: () => ReturnType<typeof call>) => {
      losing.losing = true;
      const lost = await send();
      losing.losing = false;
      expect([lost.status, lost.body.code, lost.body.again], `${name}: its answer lost`).toEqual([503, "OUTCOME_UNKNOWN", true]);
      const again = await send();
      repeats[name] = { lost: lost.body, again: again.body };
      return again;
    };

    const pass = randomBytes(32).toString("base64url");
    const before = principals().length;
    const paired = await twice("redeem", () => call(url, "POST", "/v1/pair", DEVICE.phone, { code: code.code, pass, kind: "phone", model: "iPhone 17 Pro", new: true }));
    expect(paired.status, JSON.stringify(paired.body)).toBe(200);
    expect(principals().length).toBe(before + 1);
    const phone = { authorization: `Bearer ${pass}`, ...DEVICE.phone };

    const stated = await twice("account", () => call(url, "POST", "/v1/account", phone, { account: "person-a@example.com" }));
    const unit = paired.body.unit as string;
    const named = ["apple-health:person-a@example.com:cloud", `apple-contacts:person-a@example.com:${unit}`, `apple-photos:person-a@example.com:${unit}`];
    expect([stated.status, stated.body.account, [...(stated.body.made as string[])].sort()], JSON.stringify(stated.body)).toEqual([200, "person-a@example.com", named.sort()]);
    expect(principals().filter((row) => row.account === "person-a@example.com")).toHaveLength(1);

    const set = await twice("setting", () => call(url, "POST", "/v1/settings", phone, { connector: "location", member: "precision", value: "battery", was: "precise" }));
    expect([set.status, set.body], JSON.stringify(set.body)).toEqual([200, { landed: { connector: "location", member: "precision", value: "battery" } }]);
    const precision = (await askHome(sock, "connectors", ["show", "location"]) as { members: { member: string; value: unknown }[] }).members.find((each) => each.member === "precision");
    expect(precision?.value).toBe("battery");

    const events = (kind: string) => readHome(root, (db) => db.prepare("SELECT count(*) FROM events WHERE kind = ? AND key = 'pause:location'").pluck().get(kind)) as number;
    const paused = await twice("pause", () => call(url, "POST", "/v1/connectors/location", phone, { paused: true }));
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    expect(events("pause")).toBe(1);
    const resumed = await twice("resume", () => call(url, "POST", "/v1/connectors/location", phone, { paused: false }));
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect([events("pause"), events("resume")]).toEqual([1, 1]);
    const off = await twice("off", () => call(url, "POST", "/v1/connectors/location", phone, { on: false }));
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    const written = JSON.parse(readFileSync(settingsPath(root), "utf8")) as { "sources.off"?: string[] };
    expect(written["sources.off"]).toEqual(["location"]);
    report.repeats = repeats;
  });
});

describe("a second copy of an act the table says may be sent again", () => {
  it("answers 2xx while the first copy is held after began, the first 2xx after it, and the home holds one change", async () => {
    const root = makeRoot("lifestream-relay-copy-", { sources: {} });
    const door = await serveDoor(root, { port: 0, max_bundle_bytes: 8 * 1024 ** 3 }, { log: () => undefined, floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" }, registry: FAKES, connectors: fakeDeclarations() });
    editSettings(root, { "door.port": door.port });
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, slot: null, log: () => undefined });
    const sock = testSocket(root);
    const code = (await askHome(sock, "pair")) as { code: string };
    const between = await losingSocket(root);
    onTestFinished(async () => {
      between.held.splice(0).forEach((release) => release());
      await door.close();
      await between.close();
      await home.stop();
      removeRoot(root);
    });
    const url = `http://127.0.0.1:${door.port}`;
    const principals = () => readPrincipals(openHomeFolder(root)).principals;
    const copies: Record<string, unknown> = {};

    const secondCopy = async (act: Act, send: () => ReturnType<typeof call>) => {
      expect(ACTS[act].again, act).toBe(true);
      const began = between.began;
      between.holding = true;
      const first = send();
      await until(`${act}: the first copy began`, () => between.began > began);
      between.holding = false;
      const second = await send();
      await until(`${act}: the first copy's answer held`, () => between.held.length > 0);
      between.held.splice(0).forEach((release) => release());
      const answered = await first;
      expect([Math.floor(second.status / 100), Math.floor(answered.status / 100)], `${act}: ${JSON.stringify([second.body, answered.body])}`).toEqual([2, 2]);
      copies[act] = { first: answered.body, second: second.body };
      return { first: answered, second };
    };

    const pass = randomBytes(32).toString("base64url");
    const before = principals().length;
    const paired = await secondCopy("POST /v1/pair", () => call(url, "POST", "/v1/pair", DEVICE.phone, { code: code.code, pass, kind: "phone", model: "iPhone 17 Pro", new: true }));
    expect(principals().length).toBe(before + 1);
    expect(paired.second.body.unit).toBe(paired.first.body.unit);
    const phone = { authorization: `Bearer ${pass}`, ...DEVICE.phone };

    await secondCopy("POST /v1/account", () => call(url, "POST", "/v1/account", phone, { account: "person-a@example.com" }));
    expect(principals().filter((row) => row.account === "person-a@example.com")).toHaveLength(1);

    await secondCopy("POST /v1/settings", () => call(url, "POST", "/v1/settings", phone, { connector: "location", member: "precision", value: "battery", was: "precise" }));
    const precision = (await askHome(sock, "connectors", ["show", "location"]) as { members: { member: string; value: unknown }[] }).members.find((each) => each.member === "precision");
    expect(precision?.value).toBe("battery");

    const events = (kind: string) => readHome(root, (db) => db.prepare("SELECT count(*) FROM events WHERE kind = ? AND key = 'pause:location'").pluck().get(kind)) as number;
    await secondCopy("POST /v1/connectors/<id>", () => call(url, "POST", "/v1/connectors/location", phone, { paused: true }));
    expect(events("pause")).toBe(1);

    const waiting = await secondCopy("GET /v1/agents/waiting", () => call(url, "GET", "/v1/agents/waiting", phone));
    expect(waiting.second.body).toEqual(waiting.first.body);
    report.copies = copies;
  });
});

describe("a setting through the real handler", () => {
  it("answers a valid change HOME_FAILED while another setting of the file is broken (R7), and a change sent again runs nothing again (R8)", async () => {
    const registry = fileURLToPath(new URL("./test/clock-fakes.ts", import.meta.url));
    const root = makeRoot("lifestream-relay-setting-", { clocks: true, sources: { "apple-notes:local:clock": "fake-rows" } });
    const start = Date.UTC(2026, 9, 1, 12, 0, 0);
    const clock = () => start + ranOf(root).length;
    const door = await serveDoor(root, { port: 0, max_bundle_bytes: 8 * 1024 ** 3 }, {
      log: () => undefined, floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" }, registry, connectors: clockConnectors(),
    });
    editSettings(root, { "door.port": door.port });
    const home = await startHome(root, { stopGraceMs: 50, registry, slot: null, log: () => undefined, clock, tickMs: TICK_MS });
    const sock = testSocket(root);
    const code = (await askHome(sock, "pair")) as { code: string };
    const losing = await losingSocket(root);
    onTestFinished(async () => {
      await door.close();
      await losing.close();
      await home.stop();
      removeRoot(root);
    });
    const url = `http://127.0.0.1:${door.port}`;
    const pass = randomBytes(32).toString("base64url");
    expect((await call(url, "POST", "/v1/pair", DEVICE.phone, { code: code.code, pass, kind: "phone", model: "iPhone 17 Pro", new: true })).status).toBe(200);
    const phone = { authorization: `Bearer ${pass}`, ...DEVICE.phone };
    const set = (member: string, value: string, was: string | null) => call(url, "POST", "/v1/settings", phone, { connector: "fake-clock", member, value, was });
    const ran = () => ranOf(root).filter((each) => each.name === "fake-clock").map(({ call: kind, n }) => `${kind} ${n}`);
    const pending = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE kind = 'poll' AND state <> 'done'").pluck().get()) as number;
    const settled = async (count: number) => {
      await until(`${count} calls of fake-clock`, () => ran().length >= count && pending() === 0);
      const at = home.stats().ticks.count;
      await until("three ticks", () => home.stats().ticks.count >= at + 3);
      expect(ran().length, JSON.stringify(ran())).toBe(count);
    };
    await settled(2);

    const file = settingsPath(root);
    editSettings(root, { "day.day_start_hour": 24 });
    const broken = readFileSync(file, "utf8");
    const failed = await set("refresh", "30m", "1h");
    expect([failed.status, failed.body.code], JSON.stringify(failed.body)).toEqual([500, "HOME_FAILED"]);
    expect(readFileSync(file, "utf8")).toBe(broken);
    const refused = await set("refresh", "5s", "1h");
    expect([refused.status, refused.body.code], JSON.stringify(refused.body)).toEqual([422, "SETTING_REFUSED"]);
    editSettings(root, { "day.day_start_hour": null });
    await settled(2);

    const twice = async (send: () => ReturnType<typeof call>) => {
      losing.losing = true;
      const lost = await send();
      losing.losing = false;
      expect([lost.status, lost.body.code, lost.body.again]).toEqual([503, "OUTCOME_UNKNOWN", true]);
      return { lost, again: await send() };
    };
    const refresh = await twice(() => set("refresh", "30m", "1h"));
    expect([refresh.again.status, refresh.again.body]).toEqual([200, { landed: { connector: "fake-clock", member: "refresh", value: "30m" } }]);
    await settled(3);
    expect(ran().at(-1)).toBe("fetch 2");
    const started = await twice(() => set("start", "2026-07-01", null));
    expect([started.again.status, started.again.body]).toEqual([200, { landed: { connector: "fake-clock", member: "start", value: "2026-07-01" } }]);
    await settled(5);
    expect(ran().slice(-2).sort()).toEqual(["fetch 3", "page 2"]);
    report.setting = { failed: failed.body, refused: refused.body, refresh, start: started, ran: ran() };
  });
});
