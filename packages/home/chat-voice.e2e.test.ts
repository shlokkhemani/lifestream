import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openHomeFolder, readTables, sha256, type DaySettings, type JsonObject } from "@lifestreamprotocol/core";
import { voiceItem } from "@lifestreamprotocol/families";
import { type RunnerEnded, type RunnerFile } from "@lifestreamprotocol/model";
import { openStage, stagedFile } from "./ask-files.js";
import { ChatVoice, NO_VOICE, NOT_WRITTEN, WARM_AGAIN_MS, type ChatVoiceOptions } from "./chat-voice.js";
import { sentLevel } from "./copies.js";
import { serveDoor, type Door } from "./door.js";
import { startHome, type Home } from "./home.js";
import { AS_IS_WHERE, MODELS_META, placeOf, routingOf, type ModelRoute, type Routing, type RoutingInput } from "./models.js";
import { mintPrincipal } from "./principals.js";
import { RESERVED_MS } from "./runners.js";
import { memberWords, readProcessing } from "./processing.js";
import { connectors } from "./registry-home.js";
import { ask } from "./socket.js";
import { effective } from "./settings.js";
import { acquisitionBundle } from "./test/support.js";
import { artifact, FAKE_ROUTE, makeRoot, readHome, readLedger, removeRoot, until, TICK_MS } from "./test/harness-root.js";
import { editSettings, testSocket } from "./test/folder.js";

const REGISTRY = new URL("./test/ask-registry.ts", import.meta.url);
const HOME_UNIT = "macbook-pro-0001";
const ASK = `ask:local:${HOME_UNIT}`;
const RUNNER = "runner-macbook-pro-0001";
const OTHER = "runner-mac-mini-bb01";
const PARAKEET = "parakeet-unified-en-0.6b";
const PARAKEET_ROUTE = `runner:${RUNNER}/${PARAKEET}`;
const CLOUD_ROUTE = "openrouter-voice:elevenlabs/scribe-v2";
const WORK = "ask/voice";
const DAY: DaySettings = { zone: "UTC", day_start_hour: 4 };
const NOW = Date.parse("2026-11-16T10:00:00Z");
const NOTE_A = "a".repeat(32);
const NOTE_B = "b".repeat(32);
const READER = "synthetic-token-reader".padEnd(43, "r");
const FLOORS = { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" };
const WORDS = "Synthetic lighthouse note";

function wav(samples: number): Buffer {
  const data = samples * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data, 40);
  return Buffer.concat([header, Buffer.alloc(data, 7)]);
}

const parakeet = (state: RunnerFile["state"]): RunnerFile => ({
  id: PARAKEET, name: "Parakeet", input: ["audio"], output: "text", tools: false, context_tokens: null, thinking: [], bytes: 700_000_000, languages: ["en"], memory_gb: 2, state, fetched_bytes: 0, failure: null,
});
const route = (over: Partial<ModelRoute> & Pick<ModelRoute, "id" | "transport" | "model">): ModelRoute => ({
  name: over.model, input: ["audio"], output: "text", tools: false, context_tokens: null, thinking: [], chat: null, offered: true, runner: null, leaves: null, where: "Stays on this computer", cost: "free",
  request: { effort: "none", sampling: null, timeout_ms: 120_000 }, state: "ready", line: null, ...over,
} as ModelRoute);
const onRunner = (state: ModelRoute["state"] = "ready", unit = RUNNER): ModelRoute => route({
  id: `runner:${unit}/${PARAKEET}`, transport: "runner", model: PARAKEET, runner: { unit, name: "Synthetic Mac", battery: false }, where: "Stays on Synthetic Mac",
  ...(state === "ready" ? { state, line: null } : { state, line: "Synthetic Mac's runner is not running" }),
});
const cloud = (held: boolean): ModelRoute => route({
  id: CLOUD_ROUTE, transport: "openrouter-voice", model: "elevenlabs/scribe-v2", leaves: "OpenRouter", where: "Sent to OpenRouter", cost: "priced",
  ...(held ? { state: "ready", line: null } : { state: "unavailable", line: "Add the key for OpenRouter" }),
});

function routingWith(routes: ModelRoute[], listed: RoutingInput["listed"] = [], blocks: Record<string, JsonObject> = {}): Routing {
  return routingOf({
    connectors: connectors(), blocks, defaults: { pictures: null, audio: null, text: null }, runners: {}, now_ms: NOW, day: DAY,
    routes, chosen: [], sources: [{ id: ASK, connector: "ask-home", options: {}, added_ms: 0 }], since: "2026-10-01", listed,
  });
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) removeRoot(root);
});

describe("the voice work's route and level", () => {
  it("serves an unset voice work by Parakeet wherever installed, ready or not, else the cloud voice route only where its key is held, else none", () => {
    const listed = (present: boolean, state: RunnerFile["state"] = "ready") => [{ unit: RUNNER, present, files: [parakeet(state)] }];
    const routeOf = (routing: Routing) => routing.works[WORK]!.route;
    expect(routeOf(routingWith([onRunner(), cloud(true)], listed(true)))).toBe(PARAKEET_ROUTE);
    const away = routingWith([onRunner("waiting"), cloud(true)], listed(false));
    expect(routeOf(away)).toBe(PARAKEET_ROUTE);
    expect(away.routes[PARAKEET_ROUTE]!.state).toBe("waiting");
    expect(routeOf(routingWith([onRunner("waiting", OTHER), onRunner(), cloud(true)], [{ unit: OTHER, present: false, files: [parakeet("ready")] }, { unit: RUNNER, present: true, files: [parakeet("ready")] }]))).toBe(PARAKEET_ROUTE);
    expect(routeOf(routingWith([onRunner(), cloud(true)], listed(true, "fetching")))).toBe(CLOUD_ROUTE);
    expect(routeOf(routingWith([cloud(true)], []))).toBe(CLOUD_ROUTE);
    expect(routeOf(routingWith([cloud(false)], []))).toBeNull();
    expect(routeOf(routingWith([onRunner(), cloud(true)], listed(true), { ask: { "llm.voice": CLOUD_ROUTE } }))).toBe(CLOUD_ROUTE);
    expect(routingWith([onRunner(), cloud(true)], listed(true)).works["ask/chats"]!.route).toBeNull();
  });

  it("states the route its member resolves to and each runner's step's runner as data: two runners offering Parakeet, the second's installed, names the second, and its runner away still names it", () => {
    const work = connectors().find((each) => each.id === "ask")!.processing!.voice!;
    const named = (unit: string, name: string, state: ModelRoute["state"] = "ready"): ModelRoute => ({ ...onRunner(state, unit), runner: { unit, name, battery: false } });
    const routes = [named(RUNNER, "MacBook Pro"), named(OTHER, "Mac mini")];
    const member = (routing: Routing) => {
      const at = routing.works[WORK]!;
      return memberWords(work, at, at.route === null ? null : routing.routes[at.route]!, Object.values(routing.routes), { pictures: null, audio: null, text: null }, HOME_UNIT);
    };
    const second = member(routingWith(routes, [{ unit: RUNNER, present: true, files: [] }, { unit: OTHER, present: true, files: [parakeet("ready")] }]));
    expect(second.route).toBe(`runner:${OTHER}/${PARAKEET}`);
    expect(second.steps.filter((step) => step.runner !== undefined).map((step) => [step.value, step.words, step.runner])).toEqual([
      [PARAKEET_ROUTE, PARAKEET, { unit: RUNNER, name: "MacBook Pro", home: true }],
      [`runner:${OTHER}/${PARAKEET}`, PARAKEET, { unit: OTHER, name: "Mac mini", home: false }],
    ]);
    const away = member(routingWith([routes[0]!, named(OTHER, "Mac mini", "waiting")],
      [{ unit: RUNNER, present: true, files: [] }, { unit: OTHER, present: false, files: [parakeet("ready")] }]));
    expect(away.route).toBe(`runner:${OTHER}/${PARAKEET}`);
    expect(away.steps.find((step) => step.value === away.route)!.runner).toEqual({ unit: OTHER, name: "Mac mini", home: false });
    expect(member(routingWith(routes, [], { ask: { "llm.voice": "off" } })).route).toBeNull();
  });

  it("sends an as_is work under none whatever its level, says its route that leaves sends it as it is, and every other work under its level", () => {
    const settings = { privacy: { level: "all" as const, detector: "off", always: [], never: [] }, connectors: {} } as unknown as Parameters<typeof sentLevel>[0];
    expect(sentLevel(settings, connectors(), WORK)).toBe("none");
    expect(sentLevel(settings, connectors(), "ask/chats")).toBe("all");
    const routing = routingWith([cloud(true)]);
    expect(placeOf(routing.routes[CLOUD_ROUTE]!, routing.works[WORK])).toBe(AS_IS_WHERE);
    expect(placeOf(routing.routes[CLOUD_ROUTE]!, routing.works["ask/chats"])).toBe("Sent to OpenRouter");
    expect(placeOf(onRunner(), routing.works[WORK])).toBe("Stays on Synthetic Mac");
  });
});

describe("a note's hold of its runner", () => {
  function voice(routing: () => Routing, answers = true) {
    let now = NOW;
    const warmed: { runner: string; model: string; stopped: boolean }[] = [];
    const root = mkdtempSync(join(tmpdir(), "chat-voice-hold-"));
    roots.push(root);
    const options: ChatVoiceOptions = {
      source: () => ASK, work: () => WORK, routing, folder: openHomeFolder(root),
      asker: () => { throw new Error("no ask in this test"); },
      blobs: { has: () => false, bytes: () => Buffer.alloc(0), text: () => "", prefix: () => Buffer.alloc(0), materialise: () => Promise.reject(new Error("none")) },
      epoch: () => 0, copy: () => Promise.resolve({ wait: "none" }), calls: { now: () => true, holds: () => false },
      warm: (runner, model, signal) => {
        const each = { runner, model, stopped: false };
        warmed.push(each);
        signal.addEventListener("abort", () => { each.stopped = true; });
        return answers ? Promise.resolve<RunnerEnded>({ ok: { text: "", model } }) : new Promise<RunnerEnded>(() => undefined);
      },
      log: () => undefined, clock: () => now,
    };
    return { root, chat: new ChatVoice(options), warmed, step: (ms: number) => { now += ms; } };
  }
  const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
  const installed = () => routingWith([onRunner(), cloud(true)], [{ unit: RUNNER, present: true, files: [parakeet("ready")] }]);

  it("holds and warms the note's runner from the mic's tap, keeps a three-minute recording held and warm, and lets it go at its words, its cancel or a minute's silence", async () => {
    const { chat, warmed, step } = voice(installed);
    expect(chat.open(NOTE_A)).toEqual({ runner: RUNNER });
    await settled();
    expect(warmed).toEqual([{ runner: RUNNER, model: PARAKEET, stopped: false }]);
    for (let second = 1; second <= 180; second++) {
      step(1_000);
      chat.open(NOTE_A);
      await settled();
    }
    expect(warmed.length).toBe(1 + 180_000 / WARM_AGAIN_MS);
    expect(await chat.words(`sha256:${"0".repeat(64)}`, NOTE_A)).toEqual({ failed: NOT_WRITTEN });
    chat.open(NOTE_A);
    await settled();
    expect(warmed.length).toBe(2 + 180_000 / WARM_AGAIN_MS);
    chat.open(NOTE_B);
    await settled();
    chat.cancel(NOTE_B);
    chat.open(NOTE_B);
    await settled();
    expect(warmed.length).toBe(4 + 180_000 / WARM_AGAIN_MS);
    const slow = voice(installed, false);
    slow.chat.open(NOTE_A);
    slow.step(RESERVED_MS - 1);
    slow.chat.wake();
    expect(slow.warmed.map((each) => each.stopped)).toEqual([false]);
    slow.step(1);
    slow.chat.wake();
    expect(slow.warmed.map((each) => each.stopped)).toEqual([true]);
  });

  it("keeps each note's hold its own: one note's end leaves the other's", () => {
    const { chat, warmed } = voice(installed, false);
    chat.open(NOTE_A);
    chat.open(NOTE_B);
    chat.cancel(NOTE_A);
    expect(warmed.map((each) => each.stopped)).toEqual([true, false]);
    chat.cancel(NOTE_B);
    expect(warmed.map((each) => each.stopped)).toEqual([true, true]);
  });

  it("holds and warms nothing for a route that leaves, holds a runner away without warming it, and stops a cancelled note's warm call", async () => {
    let routing = routingWith([cloud(true)]);
    const { chat, warmed } = voice(() => routing);
    expect(chat.open(NOTE_A)).toEqual({ runner: null });
    await settled();
    expect(warmed).toEqual([]);
    routing = routingWith([onRunner("waiting"), cloud(true)], [{ unit: RUNNER, present: false, files: [parakeet("ready")] }]);
    expect(chat.open(NOTE_B)).toEqual({ runner: RUNNER });
    await settled();
    expect(warmed).toEqual([]);
    const slow = voice(installed, false);
    slow.chat.open(NOTE_A);
    slow.chat.cancel(NOTE_A);
    expect(slow.warmed.map((each) => each.stopped)).toEqual([true]);
  });

  it("an open that reaches the home after the door closed the note (its words asked, its cancel) holds and warms nothing, and ends a hold it finds", async () => {
    const { root, chat, warmed } = voice(installed, false);
    expect(chat.open(NOTE_A)).toEqual({ runner: RUNNER });
    await openStage(openHomeFolder(root)).close(NOTE_A);
    expect(chat.open(NOTE_A)).toEqual({ runner: null });
    expect(warmed.map((each) => each.stopped)).toEqual([true]);
    await openStage(openHomeFolder(root)).cancel(NOTE_B);
    expect(chat.open(NOTE_B)).toEqual({ runner: null });
    await settled();
    expect(warmed.length).toBe(1);
  });
});

describe("a Chat note's words through the home", () => {
  async function voiceHome(fake: JsonObject) {
    const root = makeRoot("lifestream-chat-voice-", { sources: {}, defaults: false, fake: { leaves: "the test cloud", reply: WORDS, delay_ms: 50, ...fake } });
    roots.push(root);
    editSettings(root, { "privacy.level": "all", "connectors.ask": { "llm.voice": FAKE_ROUTE } });
    const read = () => until("the home read its routes", () => readHome(root, (db) => String(db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(MODELS_META) ?? "")).includes(`"id":"${FAKE_ROUTE}"`));
    let home: Home | undefined = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: REGISTRY });
    await read();
    const verb = (request: JsonObject) => ask(testSocket(root), { verb: "chat-voice", ...request }) as Promise<JsonObject>;
    const audio = wav(16_000);
    const blob = sha256(audio);
    const staged = stagedFile(openHomeFolder(root), blob).path;
    mkdirSync(dirname(staged), { recursive: true });
    writeFileSync(staged, audio);
    const ledger = () => readLedger(root, (db) => ({
      requests: db.prepare("SELECT family, unit FROM requests WHERE unit = ?").all(voiceItem(blob)),
      transports: db.prepare("SELECT DISTINCT a.transport FROM attempts a JOIN requests r ON r.key = a.key WHERE r.unit = ?").pluck().all(voiceItem(blob)),
      attempts: db.prepare("SELECT a.state FROM attempts a JOIN requests r ON r.key = a.key WHERE r.unit = ? ORDER BY a.id").pluck().all(voiceItem(blob)),
      outbound: db.prepare("SELECT what, level, receiver FROM outbound ORDER BY seq").all(),
    }))!;
    return {
      root, audio, blob, verb, ledger,
      async restart() {
        await home?.stop();
        home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: REGISTRY });
        await read();
      },
      async stop() {
        await home?.stop();
        home = undefined;
      },
    };
  }

  it("writes a note out at once on a route that leaves, as it is with one outbound row under none, once however often it is asked, and reads its words and its state once its question lands", async () => {
    const log = join(makeRoot("lifestream-chat-voice-log-", { sources: {} }), "sent.ndjson");
    roots.push(dirname(log));
    const at = await voiceHome({ log });
    const report: Record<string, unknown> = {};
    let door: Door | undefined;
    try {
      const processing = readHome(at.root, (db) => {
        const { settings } = effective(at.root);
        return readProcessing(readTables(db), null, {
          connectors: connectors(), families: [], histories: new Map(), blocks: settings.connectors, defaults: settings.defaults, runners: settings.runners, day: settings.day, now_ms: Date.now(), privacy: settings.privacy, home: settings.unit,
        }).get("ask")!;
      })!;
      report.processing = processing.part.rows;
      const dialog = new Map(processing.part.rows.map((row) => [row.member, row]));
      expect(dialog.get("llm.voice")!.privacy).toMatchObject({ member: "privacy.voice", words: "Sent as it is" });
      expect(processing.members.get("privacy.voice")!.words).toBe("Sent as it is");
      expect(processing.members.get("llm.voice")!.steps.find((step) => step.value === FAKE_ROUTE)!.note).toBe(AS_IS_WHERE);
      expect(processing.members.get("privacy.chats")!.words).toBe("Personal details hidden");
      expect(await at.verb({ open: NOTE_A })).toEqual({ runner: null });
      const words = await at.verb({ words: at.blob, note: NOTE_A });
      report.words = words;
      expect(words).toEqual({ words: WORDS });
      const sent = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { attachments: { media_type: string; bytes: string }[] });
      expect(sent.map((each) => each.attachments.map((file) => [file.media_type, sha256(Buffer.from(file.bytes, "base64"))]))).toEqual([[["audio/wav", at.blob]]]);
      expect(await at.verb({ words: at.blob })).toEqual({ words: WORDS });
      let rows = at.ledger();
      report.ledger = rows;
      expect(rows.requests).toEqual([{ family: "ai", unit: voiceItem(at.blob) }]);
      expect(rows.transports).toEqual(["fake"]);
      expect(rows.attempts).toEqual(["replied"]);
      expect(rows.outbound).toEqual([{ what: "ask", level: "none", receiver: "the test cloud" }]);

      mintPrincipal(openHomeFolder(at.root), { unit: "reader", scopes: ["read"], sources: [], token: READER, now_ms: 0 });
      door = await serveDoor(at.root, { port: 0, lan_port: 0, max_bundle_bytes: 1 << 30 }, { registry: REGISTRY, floors: FLOORS, log: () => undefined });
      const url = `http://127.0.0.1:${door.port}`;
      const token = readFileSync(join(process.env.LIFESTREAM_MACHINE_DIR!, "ask", "door-token"), "utf8").trim();
      const T0 = Date.parse("2026-10-01T14:00:00Z");
      const chat = `${T0}-3fa9c2`;
      const key = `${chat}:0001`;
      const lines = [
        { kind: "chat", key: chat, content: { type: "ask.chat", title: "A voice note", at_ms: T0 } },
        { kind: "msg", key, content: { type: "ask.msg", chat, n: 1, at_ms: T0, role: "user", text: "", voice: { audio: at.blob, ms: 1_000 } } },
      ];
      const text = Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
      const bundle = acquisitionBundle({ source: ASK, feeder: "owner-statements", fetched_ms: T0 + 1_000, files: [["statements.ndjson", text]], blobs: [at.audio] });
      const put = await fetch(`${url}${bundle.path}`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: bundle.bytes });
      expect(put.status, await put.text()).toBe(201);
      const read = async () => (await (await fetch(`${url}/v1/record?source=${encodeURIComponent(ASK)}&kind=msg&key=${encodeURIComponent(key)}&text=1`, { headers: { authorization: `Bearer ${READER}` } })).json()) as JsonObject;
      await until("the question landed and its plan read its words", async () => {
        const record = await read().catch(() => ({} as JsonObject));
        return (record.transcribed as { state?: string } | undefined)?.state === "done";
      });
      const record = await read();
      report.record = record;
      expect(record.text).toMatchObject({ text: WORDS });
      expect(record.transcribed).toMatchObject({ state: "done", ask: { family: "ai", item: voiceItem(at.blob), prompt: "ask-voice" } });
      rows = at.ledger();
      expect(rows.requests.length).toBe(1);
      expect(rows.attempts).toEqual(["replied"]);
      await until("Find finds the note's words", async () => {
        const found = await (await fetch(`${url}/v1/search?query=lighthouse&lists=record`, { headers: { authorization: `Bearer ${READER}` } })).json() as { record?: { hits?: { product?: string; day?: string }[] } };
        report.search = found;
        return (found.record?.hits ?? []).some((hit) => hit.product === "ask" && hit.day === "2026-10-01");
      });
    } finally {
      artifact(at.root, "chat-voice", report);
      await door?.close();
      await at.stop();
    }
  });

  it("asks a cancelled note of nothing, and tries a failed try again at once while asked, three times, then answers failed with its line", async () => {
    const at = await voiceHome({ fail: "synthetic failure of the request" });
    try {
      expect(await at.verb({ open: NOTE_A })).toEqual({ runner: null });
      expect(await at.verb({ cancel: NOTE_A })).toEqual({ cancelled: NOTE_A });
      expect(at.ledger()).toEqual({ requests: [], transports: [], attempts: [], outbound: [] });
      expect(await at.verb({ words: at.blob, note: NOTE_B })).toEqual({ failed: NOT_WRITTEN });
      const none = { what: "ask", level: "none", receiver: "the test cloud" };
      expect(at.ledger()).toMatchObject({ requests: [{ family: "ai", unit: voiceItem(at.blob) }], attempts: ["failed", "failed", "failed"], outbound: [none, none, none] });
      expect(await at.verb({ words: at.blob })).toEqual({ failed: NOT_WRITTEN });
      expect(at.ledger().attempts).toEqual(["failed", "failed", "failed"]);
    } finally {
      await at.stop();
    }
  });

  it("answers the words asked after a restart under the note's call once the call's end is read", async () => {
    const at = await voiceHome({ delay_ms: 3_000 });
    try {
      const first = at.verb({ words: at.blob }).catch(() => null);
      await until("the note's call is sending", () => at.ledger().attempts.includes("sending"));
      await at.restart();
      await first;
      expect(await at.verb({ words: at.blob })).toEqual({ words: WORDS });
      expect(at.ledger().requests.length).toBe(1);
      expect(at.ledger().attempts).toEqual(["replied"]);
    } finally {
      await at.stop();
    }
  });

  it("answers a home with no voice route the one fix", async () => {
    const root = makeRoot("lifestream-chat-voice-none-", { sources: {}, defaults: false });
    roots.push(root);
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: REGISTRY });
    try {
      const blob = sha256(wav(16));
      mkdirSync(dirname(stagedFile(openHomeFolder(root), blob).path), { recursive: true });
      writeFileSync(stagedFile(openHomeFolder(root), blob).path, wav(16));
      expect(await ask(testSocket(root), { verb: "chat-voice", words: blob })).toEqual({ failed: NO_VOICE });
    } finally {
      await home.stop();
    }
  });
});
