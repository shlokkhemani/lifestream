import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { civilDay, LEFT_MARK, NEWEST, openHome, openHomeFolder, readTables, tryLock, trySharedLock, type Ask, type AskRow, type JsonObject } from "@lifestreamprotocol/core";
import { readPrivacySettings } from "@lifestreamprotocol/privacy";
import { callLock, callsLock, listRunners, openAsker, openLedger, type AttemptRef, type Candidate, type Rest, type RunnerListing, type WorkKind } from "@lifestreamprotocol/model";
import { startHome, type Home } from "./home.js";
import { LANE, type Main } from "./jobs.js";
import { machine } from "./machine.js";
import { BATTERY_HELD, modelsRead } from "./models-read.js";
import { chooseFor } from "./made.js";
import { Models, MODELS_META, routed, routingOf as resolveRouting, serving, SINCE, type ModelRoute, type Routing, type RoutingInput, type StoredModels, type WorkRouting } from "./models.js";
import { Calls } from "./pick.js";
import { sendKind, stands, type SentAsk } from "./asks.js";
import { readProcessing } from "./processing.js";
import { readHistories } from "./status.js";
import { effective, personal } from "./settings.js";
import { askHome } from "./socket.js";
import { mintPrincipal } from "./principals.js";
import { peopleFileOf } from "./people.js";
import { PEOPLE, writePrepared } from "./prepared.js";
import { artifact, FAKE_OFFER, FAKE_ROUTE, FAKES, makeRoot, readHome, readLedger, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { doorHere } from "./test/harness-door.js";
import { statusOf } from "./test/harness-status.js";
import { editSettings, testSocket } from "./test/folder.js";
import { DEVICE } from "./test/support.js";
import { readOpsSettings } from "./verbs/context.js";
import fakeRegistry, { FAKE_CONNECTORS, fakeDeclarations, notes } from "./test/fakes.js";
import { declarations, vendorOf } from "@lifestreamprotocol/connect";
import { homeOf } from "./registry.js";

const SOURCE = "apple-notes:local:device-a";
const WORK = "fake-poll/photos";
const DAY = 86_400_000;
const PRIVACY = readPrivacySettings({});
const SEARCH_OFF = { meaning: "off", model: "embeddinggemma-2-q8-512" };
const D1 = Date.UTC(2026, 5, 1, 12, 0);
const OTHER_OFFER = { ...FAKE_OFFER, model: "fake-other", name: "Fake other" };
const OTHER_ROUTE = "fake:fake-other";
const OFFERS = [FAKE_OFFER, OTHER_OFFER];
const unitOf = (at: number): string => `${SOURCE}/${new Date(at).toISOString().slice(0, 10)}`;
const note = (key: string, at: number, extra: JsonObject = {}) => ({ kind: "note", key, content: { text: `synthetic note ${key}`, at, photo: true, ...extra }, at });

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) removeRoot(root);
});

const count = (root: string, sql: string, ...params: unknown[]): number => readHome(root, (db) => db.prepare(sql).pluck().get(...params) as number);
const quiet = (root: string): boolean => count(root, "SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')") === 0;
const sent = (root: string): { item: string; model: string; attempts: string[] }[] => readLedger(root, (db) =>
  (db.prepare("SELECT key, unit, model FROM requests ORDER BY rowid").all() as { key: string; unit: string; model: string }[]).map((row) => ({
    item: row.unit, model: row.model,
    attempts: (db.prepare("SELECT transport || ' ' || state FROM attempts WHERE key = ? ORDER BY id").pluck().all(row.key) as string[]),
  }))) ?? [];
const pending = (root: string) => readHome(root, (db) => db.prepare("SELECT item, unit, at_key, work_id, waits FROM asks WHERE state = 'pending' ORDER BY item").all()) as
  { item: string; unit: string; at_key: number; work_id: string | null; waits: string | null }[];
const done = (root: string) => readHome(root, (db) => db.prepare("SELECT item, content FROM enrichments WHERE state = 'done' ORDER BY item").all()) as { item: string; content: string }[];
const plans = (root: string): number => count(root, "SELECT count(*) FROM runs WHERE kind = 'plan'");
const job = (root: string, kind: string, key: string) =>
  readHome(root, (db) => db.prepare("SELECT state FROM jobs WHERE kind = ? AND key = ?").pluck().get(kind, key)) as string | undefined;

function folder(prefix: string, options: { defaults?: boolean; fake?: JsonObject; helpers?: number; settings?: JsonObject } = {}) {
  const root = makeRoot(prefix, {
    sources: { [SOURCE]: "fake-rows" }, cap: 4, defaults: options.defaults ?? false, fake: { models: OFFERS, ...options.fake },
    ...(options.helpers === undefined ? {} : { helpers: options.helpers }), ...(options.settings === undefined ? {} : { settings: options.settings }),
  });
  roots.push(root);
  const verb = (name: string, args: string[]) => askHome(testSocket(root), name, args);
  return { root, verb, set: (member: string, value: string) => verb("connectors", ["set", "fake-poll", member, value]) };
}

async function picked(root: string, home: Home): Promise<void> {
  const at = home.stats().ticks.count;
  await until("a tick, and nothing left to run", () => home.stats().ticks.count > at && quiet(root));
}

async function start(root: string, clock?: () => number): Promise<Home> {
  const home = await startHome(root, { registry: FAKES, log: () => undefined, tickMs: TICK_MS, ...(clock === undefined ? {} : { clock }) });
  await until("the home's models stored", () => readHome(root, (db) => db.prepare("SELECT 1 FROM meta WHERE key = ?").get(MODELS_META)) !== undefined);
  return home;
}

function choose(root: string, item: string, route: string, prompt = "fake-caption"): void {
  const db = openHome(openHomeFolder(root), "migrate");
  try {
    db.commit((tx) => tx.tables.itemRoutes.set({ family: "notes", item, prompt, route, model: route.slice(route.indexOf(":") + 1) }));
  } finally {
    db.close();
  }
}

const answers = (root: string): [string, string][] => done(root).map((row) => [row.item, JSON.parse(row.content) as string]);
const dayOne = (root: string): string => readFileSync(join(root, "days", "2026-06-01.day.txt"), "utf8");
const stored = (root: string): Record<string, string> => Object.fromEntries(((JSON.parse(readHome(root, (db) =>
  db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(MODELS_META)) as string ?? "{\"routes\":[]}") as { routes: ModelRoute[] }).routes)
  .map((route) => [route.id, route.offered ? route.state : "not offered"]));

const fakeRoute = (model: string): Parameters<typeof routed>[1] => ({ transport: "fake", model, runner: null, request: { effort: "low", sampling: null, timeout_ms: 120_000 } });
const FAKE_CHOICE = fakeRoute("fake-model");
const captionAsk = (item: string, text: string, source = SOURCE): Ask =>
  ({ family: "notes", item, prompt: "fake-caption", input: [{ text: `Caption the photo of note ${text}.` }], work: "photos", source });

const ledgerPath = (root: string): string => join(root, "replies", "replies.db");

function seed<T>(root: string, use: (ledger: ReturnType<typeof openLedger>, asker: ReturnType<typeof openAsker>) => T): T {
  const ledger = openLedger(openHomeFolder(root), { mode: "migrate" });
  try {
    return use(ledger, openAsker({ ledger, prompt: (name) => notes.prompts![name]!, blobs: openHomeFolder(root).blobs(join(root, "blobs"), { reading: true }) }));
  } finally {
    ledger.close();
  }
}

describe("LLM processing: an item goes only where its stream sends it", () => {
  it("the journey: a declared work, its stream's setting, the plan, the pick, the send to a fake route, the answer landed, judged and printed", async () => {
    const { root, set } = folder("lifestream-processing-journey-");
    const home = await start(root);
    try {
      await set("llm.photos", FAKE_ROUTE);
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("n1", D1)] });
      await until("the caption answered", () => quiet(root) && done(root).length === 1);
      const day = readFileSync(join(root, "days", "2026-06-01.day.txt"), "utf8");
      const [answer] = done(root);
      expect(answer!.item).toBe("photo:n1");
      expect(day).toContain(`synthetic note n1 [${JSON.parse(answer!.content) as string}]`);
      expect(sent(root)).toEqual([{ item: "photo:n1", model: "fake-model", attempts: ["fake replied"] }]);
      expect(readLedger(root, (db) => db.prepare("SELECT validation FROM replies").pluck().all())).toEqual(["accepted"]);
      expect(pending(root)).toEqual([]);
      artifact(root, "processing-journey", { day, sent: sent(root) });
    } finally {
      await home.stop();
    }
  });

  it("an item reaches a model its stream did not choose: none, off, before its range; a default changed sends an old ask again or a new one by the old route; connectors set takes what no route is", async () => {
    const { root, verb, set } = folder("lifestream-processing-chooses-");
    const home = await start(root);
    try {
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("n1", D1), note("n2", D1 + DAY), note("n3", D1 + 2 * DAY)] });
      await until("three asks owed", () => quiet(root) && pending(root).length === 3);
      expect(pending(root).map((row) => [row.item, row.work_id, row.waits])).toEqual([["photo:n1", WORK, null], ["photo:n2", WORK, null], ["photo:n3", WORK, null]]);
      await picked(root, home);
      expect(sent(root)).toEqual([]);

      await expect(set("llm.photos", "fake:nope")).rejects.toThrow();
      await expect(set("llm.photos", "everything")).rejects.toThrow();
      await expect(set("llm.range", "June")).rejects.toThrow();

      await set("llm.range", "2026-06-02");
      await verb("models", ["default", "pictures", FAKE_ROUTE]);
      await until("days 2 and 3 answered", () => quiet(root) && done(root).length === 2);
      await picked(root, home);
      expect(sent(root).map((each) => [each.item, each.model])).toEqual(expect.arrayContaining([["photo:n2", "fake-model"], ["photo:n3", "fake-model"]]));
      expect(sent(root)).toHaveLength(2);
      expect(pending(root).map((row) => row.item)).toEqual(["photo:n1"]);

      await set("llm.photos", "off");
      await set("llm.range", "all");
      await picked(root, home);
      await picked(root, home);
      expect(sent(root)).toHaveLength(2);
      expect(pending(root).map((row) => [row.item, row.waits])).toEqual([["photo:n1", null]]);

      const answers = done(root);
      await verb("models", ["default", "pictures", OTHER_ROUTE]);
      await set("llm.photos", "default");
      await until("day 1 answered", () => quiet(root) && done(root).length === 3);
      await picked(root, home);
      expect(sent(root).map((each) => [each.item, each.model])).toEqual([
        ...sent(root).slice(0, 2).map((each) => [each.item, "fake-model"]), ["photo:n1", "fake-other"],
      ]);
      expect(done(root).filter((row) => row.item !== "photo:n1")).toEqual(answers);
      artifact(root, "processing-chooses", { sent: sent(root), done: done(root) });
    } finally {
      await home.stop();
    }
  });

  it.each(["off", "range", "route"] as const)("a setting changed between pick and send (%s) sends by the old setting, or leaves the unit unplanned", async (way) => {
    const { root, verb, set } = folder(`lifestream-processing-between-${way}-`, { defaults: true, fake: { unavailable: "a synthetic outage" } });
    const gate = join(root, "plan-gate");
    const home = await start(root);
    try {
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("n1", D1, { plan_hold: gate })] });
      await until("the ask owed", () => quiet(root) && pending(root).length === 1);
      writeFileSync(gate, "");
      await verb("settings", ["set", "model.transports.fake", JSON.stringify({ delay_ms: 100, models: OFFERS })]);
      await until("the send run planning, held", () => existsSync(`${gate}.held`) && job(root, "send", "notes") === "running");
      const before = plans(root);
      if (way === "off") await set("llm.photos", "off");
      if (way === "range") await set("llm.range", "2026-06-10");
      if (way === "route") await set("llm.photos", OTHER_ROUTE);
      rmSync(gate);
      if (way === "route") await until("the caption answered by the new route", () => quiet(root) && done(root).length === 1);
      await picked(root, home);
      await picked(root, home);
      expect(sent(root).filter((each) => each.model === "fake-model")).toEqual([{ item: "photo:n1", model: "fake-model", attempts: [] }]);
      expect(plans(root)).toBeGreaterThan(before);
      expect(sent(root).filter((each) => each.attempts.length > 0)).toEqual(way === "route" ? [{ item: "photo:n1", model: "fake-other", attempts: ["fake replied"] }] : []);
      if (way !== "route") expect(pending(root).map((row) => row.item)).toEqual(["photo:n1"]);
      artifact(root, `processing-between-${way}`, { sent: sent(root), pending: pending(root) });
    } finally {
      rmSync(gate, { force: true });
      await home.stop();
    }
  });

  it("a route that stops is replaced by another, or a setting changed needs a restart to be followed", async () => {
    const stopped = [{ ...FAKE_OFFER, ready: false }, OTHER_OFFER];
    const { root, verb, set } = folder("lifestream-processing-stopped-", { fake: { models: stopped } });
    const home = await start(root);
    try {
      await set("llm.photos", FAKE_ROUTE);
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("n1", D1)] });
      await until("the ask owed", () => quiet(root) && pending(root).length === 1);
      await picked(root, home);
      await picked(root, home);
      expect(sent(root)).toEqual([]);
      await verb("settings", ["set", "model.transports.fake", JSON.stringify({ delay_ms: 100, models: OFFERS })]);
      await until("the caption answered", () => quiet(root) && done(root).length === 1);
      expect(sent(root)).toEqual([{ item: "photo:n1", model: "fake-model", attempts: ["fake replied"] }]);
    } finally {
      await home.stop();
    }
  });

  it("a call that ends with no reply strands its ask: the provider's end, or a call killed, never wakes the unit waiting on it, and the ask is never sent again", async () => {
    const holding = (root: string, at: number) => {
      const { key, attempt } = seed(root, (ledger, asker) => {
        const key = (asker.request(routed(captionAsk("photo:n1", "synthetic note n1"), FAKE_CHOICE).ask) as { send: string }).send;
        return { key, attempt: (ledger.beginAttempt(key, at, "fake") as { attempt: AttemptRef }).attempt };
      });
      mkdirSync(dirname(callLock(openHomeFolder(root), key)), { recursive: true });
      const locks = [trySharedLock(callsLock(ledgerPath(root)))!, tryLock(callLock(openHomeFolder(root), key))!];
      return { key, attempt, release: () => { for (const lock of locks.splice(0)) lock.release(); } };
    };
    const failures = (root: string) => readLedger(root, (db) => db.prepare("SELECT reason FROM unit_failures").pluck().all());

    let now = Date.now();
    const first = folder("lifestream-processing-stranded-", { defaults: true });
    const call = holding(first.root, now);
    const home = await start(first.root, () => now);
    try {
      await ship(first.root, { source: SOURCE, fetched_ms: now - 60_000, rows: [note("n1", D1)] });
      await until("the ask waiting on the call in flight", () => quiet(first.root) && pending(first.root)[0]?.waits === call.key);
      const before = plans(first.root);
      seed(first.root, (ledger) => ledger.end(call.attempt, "fake", { until_ms: now + 5 * 60_000, resets_ms: null, cause: "provider", reason: "synthetic: the provider is busy" }, now));
      call.release();
      await until("the unit planned again, its ask waiting on no call", () => quiet(first.root) && plans(first.root) > before && pending(first.root)[0]?.waits === null);
      expect(sent(first.root)).toEqual([{ item: "photo:n1", model: "fake-model", attempts: ["fake unknown"] }]);
      now += 6 * 60_000;
      await until("the caption answered", () => quiet(first.root) && done(first.root).length === 1);
      expect(sent(first.root)).toEqual([{ item: "photo:n1", model: "fake-model", attempts: ["fake unknown", "fake replied"] }]);
      expect(failures(first.root)).toEqual([]);
    } finally {
      call.release();
      await home.stop();
    }

    let behind = 60 * 60_000;
    const clock = () => Date.now() - behind;
    const second = folder("lifestream-processing-killed-", { defaults: true });
    const killed = holding(second.root, clock());
    const other = await start(second.root, clock);
    try {
      await ship(second.root, { source: SOURCE, fetched_ms: clock() - 60_000, rows: [note("n1", D1)] });
      await until("the ask waiting on the call in flight", () => quiet(second.root) && pending(second.root)[0]?.waits === killed.key);
      const before = plans(second.root);
      killed.release();
      await until("the dead call ended a try, the unit planned again, its ask waiting on no call", () => quiet(second.root)
        && sent(second.root)[0]?.attempts.join() === "fake failed" && plans(second.root) > before && pending(second.root)[0]?.waits === null);
      expect(failures(second.root)).toEqual(["the call process died with no outcome"]);
      behind = 0;
      await until("the caption answered", () => quiet(second.root) && done(second.root).length === 1);
      expect(sent(second.root)).toEqual([{ item: "photo:n1", model: "fake-model", attempts: ["fake failed", "fake replied"] }]);
    } finally {
      killed.release();
      await other.stop();
    }
  });

  it("two routes of one model send through the first's transport, or an attempt does not say the transport it ran on", async () => {
    const reached: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      request.on("end", () => {
        reached.push((JSON.parse(body) as { model: string }).model);
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: "a caption by the address" } }] }));
      });
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const { root, set } = folder("lifestream-processing-two-routes-", { settings: { "model.transports.address": { url, model: "fake-model", kinds: ["pictures"] } } });
    const home = await start(root);
    try {
      await set("llm.photos", "address:fake-model");
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("n1", D1)] });
      await until("the first caption answered", () => quiet(root) && done(root).length === 1);
      await set("llm.photos", FAKE_ROUTE);
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 50_000, rows: [note("n2", D1 + DAY)] });
      await until("the second caption answered", () => quiet(root) && done(root).length === 2);
      expect(sent(root)).toEqual([
        { item: "photo:n1", model: "fake-model", attempts: ["address replied"] },
        { item: "photo:n2", model: "fake-model", attempts: ["fake replied"] },
      ]);
      expect(reached).toEqual(["fake-model"]);
      expect(done(root).map((row) => [row.item, JSON.parse(row.content) as string])).toEqual([
        ["photo:n1", "a caption by the address"], ["photo:n2", expect.stringMatching(/^fake reply /u)],
      ]);
      artifact(root, "processing-two-routes", { sent: sent(root), reached });
    } finally {
      await home.stop();
      await new Promise((closed) => server.close(closed));
    }
  });

  it("a model changed sends an ask again while its call is in flight, or sends one request twice for two items that share it, or loses those calls' replies", async () => {
    const OTHER_SOURCE = "apple-notes:local:device-b";
    const { root, set } = folder("lifestream-processing-in-flight-", { defaults: true });
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => tx.tables.sources.add({ id: OTHER_SOURCE, vendor: vendorOf(declarations(), OTHER_SOURCE), connector: "fake-rows", options: { lane: "fake-poll-two" }, added_ms: 0 }));
    db.close();
    const shared = "a shared photo";
    const asks = [captionAsk("photo:n1", "synthetic note n1"), captionAsk("photo:n2", "synthetic note n2"), captionAsk("photo:n3", "synthetic note n3"), captionAsk("photo:s1", shared)];
    const flying = seed(root, (ledger, asker) => asks.map((ask) => {
      const key = (asker.request(routed(ask, FAKE_CHOICE).ask) as { send: string }).send;
      return { key, attempt: (ledger.beginAttempt(key, Date.now(), "fake") as { attempt: Parameters<typeof ledger.land>[0] }).attempt };
    }));
    const seeded = sent(root);
    expect(seeded.map((each) => each.attempts)).toEqual([["fake sending"], ["fake sending"], ["fake sending"], ["fake sending"]]);
    const living = [trySharedLock(callsLock(ledgerPath(root)))!, ...flying.map(({ key }) => {
      mkdirSync(dirname(callLock(openHomeFolder(root), key)), { recursive: true });
      return tryLock(callLock(openHomeFolder(root), key))!;
    })];
    const home = await start(root);
    try {
      await set("llm.photos", OTHER_ROUTE);
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("n1", D1), note("n2", D1 + DAY), note("n3", D1 + 2 * DAY), note("s1", D1, { text: shared })] });
      await ship(root, { source: OTHER_SOURCE, fetched_ms: Date.now() - 50_000, rows: [note("s2", D1, { text: shared })] });
      await until("five asks waiting on the calls in flight", () => quiet(root) && pending(root).length === 5 && pending(root).every((row) => row.waits !== null));
      await picked(root, home);
      await picked(root, home);
      expect(pending(root).map((row) => [row.item, row.waits])).toEqual([
        ["photo:n1", flying[0]!.key], ["photo:n2", flying[1]!.key], ["photo:n3", flying[2]!.key], ["photo:s1", flying[3]!.key], ["photo:s2", flying[3]!.key],
      ]);
      expect(sent(root)).toEqual(seeded);

      seed(root, (ledger) => flying.forEach(({ attempt }, n) => ledger.land(attempt, { text: `a caption in flight ${n}`, model: "fake-model", transport: "fake" }, Date.now())));
      for (const lock of living.splice(0)) lock.release();
      await until("every caption answered", () => quiet(root) && done(root).length === 5);
      expect(done(root).map((row) => [row.item, JSON.parse(row.content) as string])).toEqual([
        ["photo:n1", "a caption in flight 0"], ["photo:n2", "a caption in flight 1"], ["photo:n3", "a caption in flight 2"],
        ["photo:s1", "a caption in flight 3"], ["photo:s2", "a caption in flight 3"],
      ]);
      expect(sent(root).map((each) => [each.item, each.model, each.attempts])).toEqual(seeded.map((each) => [each.item, each.model, ["fake replied"]]));
      artifact(root, "processing-in-flight", { sent: sent(root), done: done(root) });
    } finally {
      for (const lock of living) lock.release();
      await home.stop();
    }
  });

  it("a model changed asks again, or loses, an answer a retry won after a refusal", async () => {
    const { root, set } = folder("lifestream-processing-retry-won-");
    const ask = captionAsk("photo:n1", "synthetic note n1");
    seed(root, (ledger, asker) => {
      const answer = (text: string) => {
        const key = (asker.request(routed(ask, FAKE_CHOICE).ask) as { send: string }).send;
        const begun = ledger.beginAttempt(key, Date.now(), "fake") as { attempt: Parameters<typeof ledger.land>[0] };
        ledger.land(begun.attempt, { text, model: "fake-model", transport: "fake" }, Date.now());
        return key;
      };
      const first = answer("a caption its family refused");
      asker.refuse(ask, asker.answer(ask) as Candidate, "a synthetic refusal");
      expect(answer("the retry's caption")).not.toBe(first);
    });
    expect(sent(root).map((each) => [each.model, each.attempts])).toEqual([["fake-model", ["fake replied"]], ["fake-model", ["fake replied"]]]);
    const home = await start(root);
    try {
      await set("llm.photos", OTHER_ROUTE);
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("n1", D1)] });
      await until("the caption answered", () => quiet(root) && done(root).length === 1);
      expect(JSON.parse(done(root)[0]!.content)).toBe("the retry's caption");
      expect(sent(root)).toHaveLength(2);
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 50_000, rows: [note("n2", D1 + 60 * 60_000)] });
      await until("the second caption answered", () => quiet(root) && done(root).length === 2);
      expect(done(root).map((row) => [row.item, JSON.parse(row.content) as string])).toEqual([["photo:n1", "the retry's caption"], ["photo:n2", expect.stringMatching(/^fake reply /u)]]);
      expect(sent(root).map((each) => [each.item, each.model])).toEqual([["photo:n1", "fake-model"], ["photo:n1", "fake-model"], ["photo:n2", "fake-other"]]);
      artifact(root, "processing-retry-won", { sent: sent(root), done: done(root) });
    } finally {
      await home.stop();
    }
  });

  it("a chosen item (models process, the door's POST /v1/process) on a work that is off waits behind the work, or goes by another route than the one named; a choice of another model hides the answer it had until that model answers; a choice of the model that answered calls again or shows another's; or the item erased keeps its choice", async () => {
    const { root, set, verb } = folder("lifestream-processing-chosen-");
    const act = (item: string, route: string) => verb("models", ["process", "notes", item, "fake-caption", route]);
    const caption = "a caption by the fake model";
    seed(root, (ledger, asker) => {
      const key = (asker.request(routed(captionAsk("photo:n1", "synthetic note n1"), FAKE_CHOICE).ask) as { send: string }).send;
      const begun = ledger.beginAttempt(key, Date.now(), "fake") as { attempt: Parameters<typeof ledger.land>[0] };
      ledger.land(begun.attempt, { text: caption, model: "fake-model", transport: "fake" }, Date.now());
    });
    const home = await start(root);
    try {
      await set("llm.photos", "off");
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("n1", D1), note("n2", D1 + DAY)] });
      await until("n1 answered by the ledger, n2 owed", () => quiet(root) && done(root).length === 1 && pending(root).length === 1);
      expect(answers(root)).toEqual([["photo:n1", caption]]);

      expect(await act("photo:n2", FAKE_ROUTE)).toEqual({ chosen: { family: "notes", item: "photo:n2", prompt: "fake-caption", route: FAKE_ROUTE } });
      await until("the chosen item answered", () => quiet(root) && done(root).length === 2);
      expect(sent(root).map((each) => [each.item, each.model, each.attempts])).toEqual([["photo:n1", "fake-model", ["fake replied"]], ["photo:n2", "fake-model", ["fake replied"]]]);

      const away = [FAKE_OFFER, { ...OTHER_OFFER, ready: false }];
      await verb("settings", ["set", "model.transports.fake", JSON.stringify({ delay_ms: 100, models: away })]);
      await until("the other model not ready", () => stored(root)[OTHER_ROUTE] === "unavailable");
      await act("photo:n1", OTHER_ROUTE);
      await until("n1 owed by its choice", () => quiet(root) && pending(root).some((row) => row.item === "photo:n1"));
      await picked(root, home);
      expect([answers(root).find(([item]) => item === "photo:n1"), sent(root).length]).toEqual([["photo:n1", caption], 2]);
      expect(dayOne(root)).toContain(`[${caption}]`);
      await verb("settings", ["set", "model.transports.fake", JSON.stringify({ delay_ms: 100, models: OFFERS })]);
      await until("n1 answered by the other model", () => quiet(root) && answers(root).some(([item, text]) => item === "photo:n1" && text !== caption));
      const other = answers(root).find(([item]) => item === "photo:n1")![1];
      expect(sent(root).map((each) => [each.item, each.model, each.attempts]).at(-1)).toEqual(["photo:n1", "fake-other", ["fake replied"]]);
      await until("the day showing the other model's answer", () => quiet(root) && dayOne(root).includes(`[${other}]`));

      await act("photo:n1", FAKE_ROUTE);
      await until("n1 shows the fake model's answer again", () => quiet(root) && answers(root).some(([item, text]) => item === "photo:n1" && text === caption));
      await picked(root, home);
      await picked(root, home);
      expect(sent(root)).toHaveLength(3);
      await until("the day showing the fake model's answer", () => quiet(root) && dayOne(root).includes(`[${caption}]`));
      artifact(root, "processing-chosen", { sent: sent(root), done: done(root) });

      await verb("erase", ["notes", "n1", "--apply"]);
      await until("the erasure done", () => quiet(root) && count(root, "SELECT count(*) FROM enrichments WHERE item = 'photo:n1'") === 0);
      expect(count(root, "SELECT count(*) FROM item_routes WHERE item = 'photo:n1'")).toBe(0);
    } finally {
      await home.stop();
    }
  });

  it("a choice is taken by a route the home does not reach, one that cannot serve the item's kind, or of an item nothing asks, or names no route, or through the door on a pass that is no device's, or of an item that begins with a dash read as an option; a default set by the models act says nothing on the feed", async () => {
    const text = { ...FAKE_OFFER, model: "fake-text", name: "Fake text", input: ["text"] };
    const { root, set, verb } = folder("lifestream-processing-chosen-act-", { fake: { models: [...OFFERS, text] } });
    const act = (item: string, route?: string) => verb("models", ["process", "notes", item, "fake-caption", ...(route === undefined ? [] : [route])]);
    const home = await start(root);
    try {
      await set("llm.photos", "off");
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("n1", D1)] });
      await until("the ask owed", () => quiet(root) && pending(root).length === 1);
      await expect(act("photo:n1")).rejects.toThrow("usage: lifestream models");
      await expect(act("photo:n1", "fake:nope")).rejects.toThrow("That model isn't connected.");
      await expect(act("photo:n1", "fake:fake-text")).rejects.toThrow("Fake text can't see photos.");
      await expect(act("photo:none", FAKE_ROUTE)).rejects.toThrow("Nothing is asked of this item.");
      await picked(root, home);
      expect([count(root, "SELECT count(*) FROM item_routes"), sent(root)]).toEqual([0, []]);

      const events = count(root, "SELECT count(*) FROM events WHERE kind = 'models'");
      const read = await verb("models", ["default", "pictures", OTHER_ROUTE]) as { defaults: { pictures: { value: string | null } } };
      expect(read.defaults.pictures.value).toBe(OTHER_ROUTE);
      await until("a models event on the feed", () => count(root, "SELECT count(*) FROM events WHERE kind = 'models'") > events);
      const passes = openHomeFolder(root);
      const mac = mintPrincipal(passes, { unit: "macbook-pro-0001", kind: "mac", scopes: ["deliver"], sources: ["screen:local:macbook-pro-0001"], now_ms: Date.now() });
      const reader = mintPrincipal(passes, { unit: "reader-0001", scopes: ["read"], now_ms: Date.now() });
      const door = await doorHere(root);
      try {
        const post = async (token: string, body: JsonObject) => {
          const response = await fetch(`${door.url}/v1/process`, {
            method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...DEVICE.mac }, body: JSON.stringify(body),
          });
          return [response.status, await response.json()] as const;
        };
        const choice = { family: "notes", item: "photo:n1", prompt: "fake-caption", route: OTHER_ROUTE };
        expect((await post(reader.token, choice))[0]).toBe(403);
        expect(await post(mac.token, { family: "notes", item: "photo:n1", prompt: "fake-caption" }))
          .toEqual([422, { code: "BAD_REQUEST", message: "process names a family, an item, a prompt and a route" }]);
        expect(await post(mac.token, { ...choice, route: "fake:nope" })).toEqual([422, { code: "PROCESS_REFUSED", message: "That model isn't connected." }]);
        expect(await post(mac.token, { ...choice, item: "--photo:n1" })).toEqual([422, { code: "PROCESS_REFUSED", message: "Nothing is asked of this item." }]);
        expect(count(root, "SELECT count(*) FROM item_routes")).toBe(0);
        expect(await post(mac.token, choice)).toEqual([200, { chosen: choice }]);
      } finally {
        await door.stop();
      }
      await until("the chosen item answered", () => quiet(root) && done(root).length === 1);
      expect(sent(root)).toEqual([{ item: "photo:n1", model: "fake-other", attempts: ["fake replied"] }]);
    } finally {
      await home.stop();
    }
  });

  it("a plan run that read the settings before its work was given a route lands its rows with no route, and nothing sends them", async () => {
    const { root, set } = folder("lifestream-processing-stale-plan-");
    const gate = join(root, "plan-gate");
    writeFileSync(gate, "");
    const home = await start(root);
    try {
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("n1", D1, { plan_hold: gate }), note("n2", D1 + DAY)] });
      await until("the plan run planning under no route, held", () => existsSync(`${gate}.held`));
      await set("llm.photos", FAKE_ROUTE);
      rmSync(gate);
      await until("both captions answered", () => quiet(root) && done(root).length === 2);
      expect(sent(root).map((each) => [each.item, each.model]).sort()).toEqual([["photo:n1", "fake-model"], ["photo:n2", "fake-model"]]);
      expect(pending(root)).toEqual([]);
      artifact(root, "processing-stale-plan", { sent: sent(root) });
    } finally {
      rmSync(gate, { force: true });
      await home.stop();
    }
  });

  it("a choice made while the send run plans is not honoured: the call goes by the route the ask was picked for", async () => {
    const { root, verb } = folder("lifestream-processing-chosen-between-", { defaults: true, fake: { unavailable: "a synthetic outage" } });
    const gate = join(root, "plan-gate");
    const home = await start(root);
    try {
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("n1", D1, { plan_hold: gate })] });
      await until("the ask owed", () => quiet(root) && pending(root).length === 1);
      writeFileSync(gate, "");
      await verb("settings", ["set", "model.transports.fake", JSON.stringify({ delay_ms: 100, models: OFFERS })]);
      await until("the send run planning, held", () => existsSync(`${gate}.held`) && job(root, "send", "notes") === "running");
      choose(root, "photo:n1", OTHER_ROUTE);
      rmSync(gate);
      await until("the caption answered", () => quiet(root) && done(root).length === 1);
      await picked(root, home);
      expect(sent(root).filter((each) => each.attempts.length > 0)).toEqual([{ item: "photo:n1", model: "fake-other", attempts: ["fake replied"] }]);
      artifact(root, "processing-chosen-between", { sent: sent(root) });
    } finally {
      rmSync(gate, { force: true });
      await home.stop();
    }
  });

  it("a paused runner's work is picked, or one picked before the pause lands is sent, or a route of another runs no more; resumed, it waits on", async () => {
    const UNIT = "runner-macbook-pro-0001";
    const RUNNER_OFFER = { ...FAKE_OFFER, runner: { unit: UNIT, name: "MacBook Pro", battery: false } };
    const RUNNER_ROUTE = `fake:${UNIT}/fake-model`;
    const { root, verb, set } = folder("lifestream-processing-runner-paused-", { fake: { models: [RUNNER_OFFER, OTHER_OFFER] } });
    const gate = join(root, "plan-gate");
    const home = await start(root);
    try {
      await until("the runner's route read", () => stored(root)[RUNNER_ROUTE] === "ready");
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("n1", D1, { plan_hold: gate }), note("n2", D1 + DAY)] });
      await until("both asks owed, no model set", () => quiet(root) && pending(root).length === 2);
      writeFileSync(gate, "");
      await set("llm.photos", RUNNER_ROUTE);
      await until("the send run planning, held", () => existsSync(`${gate}.held`) && job(root, "send", "notes") === "running");
      expect(await verb("pause", [`runner:${UNIT}`, "--reason", "the laptop is busy"])).toEqual({ paused: `runner:${UNIT}`, by: "terminal" });
      rmSync(gate);
      await until("the send run ended", () => quiet(root));
      await picked(root, home);
      expect(sent(root).filter((each) => each.attempts.length > 0)).toEqual([]);
      expect(stored(root)[RUNNER_ROUTE]).toBe("waiting");
      const planned = plans(root);
      await picked(root, home);
      await picked(root, home);
      expect([plans(root), sent(root).filter((each) => each.attempts.length > 0)]).toEqual([planned, []]);
      choose(root, "photo:n2", OTHER_ROUTE);
      await until("n2 answered by the other model", () => answers(root).some(([item]) => item === "photo:n2"));
      expect(answers(root).map(([item]) => item)).toEqual(["photo:n2"]);
      await verb("resume", [`runner:${UNIT}`]);
      await until("n1 answered", () => quiet(root) && done(root).length === 2);
      expect(sent(root).filter((each) => each.attempts.length > 0).sort((a, b) => a.item.localeCompare(b.item))).toEqual([
        { item: "photo:n1", model: "fake-model", attempts: ["fake replied"] }, { item: "photo:n2", model: "fake-other", attempts: ["fake replied"] },
      ]);
      artifact(root, "processing-runner-paused", { sent: sent(root) });
    } finally {
      rmSync(gate, { force: true });
      await home.stop();
    }
  });

  it("a paused runner's ask picked before the pause, whose send run begins after it, has no request written", async () => {
    const UNIT = "runner-macbook-pro-0001";
    const RUNNER_OFFER = { ...FAKE_OFFER, runner: { unit: UNIT, name: "MacBook Pro", battery: false } };
    const RUNNER_ROUTE = `fake:${UNIT}/fake-model`;
    const { root, verb, set } = folder("lifestream-processing-runner-paused-begin-", { fake: { models: [RUNNER_OFFER] }, helpers: 3 });
    const gate = join(root, "plan-gate");
    const home = await start(root);
    const plannedSince = (after: number) => count(root, "SELECT coalesce(sum(json_extract(counts, '$.planned')), 0) FROM runs WHERE kind = 'plan' AND id > ?", after);
    try {
      await until("the runner's route read", () => stored(root)[RUNNER_ROUTE] === "ready");
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("n1", D1, { plan_hold: gate })] });
      await until("n1's ask owed, no model set", () => quiet(root) && pending(root).length === 1);
      writeFileSync(gate, "");
      await set("llm.photos", RUNNER_ROUTE);
      await until("the send run planning n1, held", () => existsSync(`${gate}.held`) && job(root, "send", "notes") === "running");
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("n2", D1 + DAY)] });
      await until("n2's ask owed, its unit planned", () => pending(root).some((each) => each.item === "photo:n2") && count(root, "SELECT count(*) FROM dirty_units WHERE family = 'notes'") === 0);
      const at = home.stats().ticks.count;
      await until("two ticks picked n2", () => home.stats().ticks.count >= at + 2);
      const before = count(root, "SELECT coalesce(max(id), 0) FROM runs");
      expect(await verb("pause", [`runner:${UNIT}`, "--reason", "the laptop is busy"])).toEqual({ paused: `runner:${UNIT}`, by: "terminal" });
      rmSync(gate);
      await until("both send runs ended", () => quiet(root));
      expect(sent(root)).toEqual([{ item: "photo:n1", model: "fake-model", attempts: [] }]);
      expect(pending(root).map((each) => each.item)).toEqual(["photo:n1", "photo:n2"]);
      expect(plannedSince(before)).toBe(2);
      artifact(root, "processing-runner-paused-begin", { sent: sent(root) });
    } finally {
      rmSync(gate, { force: true });
      await home.stop();
    }
  });

  it("a choice saved under an older prompt holds the item from its work's route forever, or sends it by that choice", async () => {
    const { root, set } = folder("lifestream-processing-chosen-old-prompt-");
    const home = await start(root);
    try {
      await set("llm.photos", "off");
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("n1", D1)] });
      await until("the ask owed", () => quiet(root) && pending(root).length === 1);
      choose(root, "photo:n1", OTHER_ROUTE, "fake-old-caption");
      await picked(root, home);
      await set("llm.photos", FAKE_ROUTE);
      await until("the caption answered", () => quiet(root) && done(root).length === 1);
      expect(sent(root)).toEqual([{ item: "photo:n1", model: "fake-model", attempts: ["fake replied"] }]);
    } finally {
      await home.stop();
    }
  });

  it("a route that leaves the offers and comes back plans its work's units again, renders a day, says its work needs a model, or sends while away", async () => {
    const away = { delay_ms: 100, unavailable: "a synthetic outage", models: [OTHER_OFFER] };
    const { root, verb, set } = folder("lifestream-processing-route-away-", { fake: { unavailable: "a synthetic outage" } });
    const home = await start(root);
    try {
      await set("llm.photos", FAKE_ROUTE);
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("n1", D1), note("n2", D1 + DAY)] });
      await until("two asks owed", () => quiet(root) && pending(root).length === 2);
      await picked(root, home);
      const rendered = () => count(root, "SELECT count(*) FROM runs WHERE kind = 'render'");
      const before = { plans: plans(root), pending: pending(root), rendered: rendered() };
      await verb("settings", ["set", "model.transports.fake", JSON.stringify(away)]);
      await until("the route gone from the offers", () => stored(root)[FAKE_ROUTE] === "not offered");
      await picked(root, home);
      await picked(root, home);
      expect(statusOf(root, { now_ms: Date.now(), settings: readOpsSettings(root) }).works.filter((work) => work.connector === "fake-poll" && work.member === "llm.photos").map(({ member, shape, line }) => [member, shape, line]))
        .toEqual([["llm.photos", "waiting", "Fake model isn't offered now"]]);
      await verb("settings", ["set", "model.transports.fake", JSON.stringify({ ...away, models: OFFERS })]);
      await until("the route offered again", () => stored(root)[FAKE_ROUTE] === "unavailable");
      await picked(root, home);
      await picked(root, home);
      expect({ plans: plans(root), pending: pending(root), rendered: rendered() }).toEqual(before);
      expect(sent(root)).toEqual([]);
      await verb("settings", ["set", "model.transports.fake", JSON.stringify({ delay_ms: 100, models: OFFERS })]);
      await until("both answered", () => quiet(root) && done(root).length === 2);
      expect(sent(root).map((each) => each.model)).toEqual(["fake-model", "fake-model"]);
    } finally {
      await home.stop();
    }
  });

  it("a screen's sitting is kept from a route that leaves, or sent to it as it is under `all`: no sent copy, plain screen text; its menu holds that route back; or it goes as it is under `none` the person did not choose; or the home's level changed is never read by the send run", async () => {
    const SCREEN = "screen:local:mac-0001";
    const RECEIVER = "Example Cloud";
    const root = makeRoot("lifestream-processing-screen-leaves-", { sources: { [SCREEN]: "fake-rows" }, fake: { models: OFFERS, leaves: RECEIVER } });
    roots.push(root);
    const log = join(root, "received.jsonl");
    const verb = (name: string, args: string[]) => askHome(testSocket(root), name, args);
    const received = (): string[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => (JSON.parse(line) as { input: string }).input) : []);
    const copies = () => readLedger(root, (db) => db.prepare("SELECT level, body FROM sent_copies ORDER BY id").all()) as { level: string; body: string | null }[];
    const home = await start(root);
    try {
      await verb("settings", ["set", "model.transports.fake", JSON.stringify({ delay_ms: 100, models: OFFERS, leaves: RECEIVER, log, reply: "Reading mail." })]);
      await until("People's first run done", () => quiet(root));
      writePrepared(openHomeFolder(root), peopleFileOf(root, machine().dir), PEOPLE, { rows: new Map([["names", new Map([["table", {
        owner: null, people: [{ who: "p-ada", is: "human", shown: "Ada Example", names: ["Ada Example"], accounts: ["person-a@example.com", "+15550000001"] }],
      } as unknown as JsonObject]])]]), position: "names-1" });
      const sitting = async (key: string, minutes: number, text: string) => {
        const at = Date.now() - minutes * 60_000;
        await ship(root, { source: SCREEN, fetched_ms: at + 1_000, rows: [{ kind: "frame", key, content: { at, text }, at }] });
        await ship(root, { source: SCREEN, fetched_ms: at + 330_000, rows: [], facts: { read_through: new Date(at + 301_000).toISOString() } });
      };
      const answeredScreen = (n: number) => () => quiet(root) && count(root, "SELECT count(*) FROM enrichments WHERE family = 'screen' AND state = 'done'") === n;

      await sitting("f1", 60, "Inbox: Ada Example wrote from person-a@example.com, call +15550000001");
      await until("the first sitting answered", answeredScreen(1));
      expect(received()).toHaveLength(1);
      expect(received()[0]).toContain("Inbox: [[Person 1]] wrote from [[Email 1]], call [[Phone 1]]");
      for (const detail of ["Ada", "person-a@example.com", "15550000001"]) expect(received()[0]).not.toContain(detail);
      expect(copies()).toEqual([{ level: "all", body: expect.stringContaining("[[Email 1]]") }]);

      const { settings } = effective(root);
      const menu = readHome(root, (db) => readProcessing(readTables(db), null, { connectors: fakeDeclarations(), families: fakeRegistry(settings, homeOf(openHomeFolder(root))).families, histories: new Map(), blocks: settings.connectors, defaults: settings.defaults, runners: settings.runners, day: settings.day, now_ms: Date.now(), privacy: settings.privacy, home: settings.unit }))
        .get("fake-poll")!.members.get("llm.screen")!.steps;
      expect(menu.slice(0, 2).map((step) => step.note)).toEqual([null, "Fake model"]);
      expect(menu.slice(2)).toEqual(expect.arrayContaining([{ value: FAKE_ROUTE, words: "Fake model", note: `Sent to ${RECEIVER}` }, { value: OTHER_ROUTE, words: "Fake other", note: `Sent to ${RECEIVER}` }]));
      await verb("connectors", ["set", "fake-poll", "llm.screen", OTHER_ROUTE]);
      const item = readHome(root, (db) => db.prepare("SELECT item FROM asks WHERE family = 'screen'").pluck().get()) as string;
      await verb("models", ["process", "screen", item, "fake-sitting", FAKE_ROUTE]);

      await verb("connectors", ["set", "fake-poll", "privacy.screen", "none"]);
      await sitting("f2", 40, "Bank: account of Ada Example");
      await until("the second sitting answered", answeredScreen(2));
      expect(received()[1]).toContain("Bank: account of Ada Example");
      expect(copies()[1]).toEqual({ level: "none", body: null });

      await verb("connectors", ["set", "fake-poll", "privacy.screen", "default"]);
      await verb("settings", ["set", "privacy.level", "none"]);
      await sitting("f3", 20, "Inbox: Ada Example wrote again");
      await until("the third sitting answered under the home's new level", answeredScreen(3));
      expect(received()[2]).toContain("Inbox: Ada Example wrote again");
      expect(copies()[2]).toEqual({ level: "none", body: null });
      await verb("settings", ["set", "privacy.level", "all"]);
      await sitting("f4", 10, "Inbox: Ada Example wrote a fourth time");
      await until("the fourth sitting answered under the home's level again", answeredScreen(4));
      expect(received()[3]).toContain("Inbox: [[Person 1]] wrote a fourth time");
      expect(copies()[3]).toEqual({ level: "all", body: expect.stringContaining("[[Person 1]]") });
      artifact(root, "processing-screen-leaves", { menu, received: received(), copies: copies() });
    } finally {
      await home.stop();
    }
  });

  it("pictures and audio stay off with a route ready until the person picks one; a text default the person cleared is filled again, at a start or when its route is ready again; or the first filling is not written", async () => {
    const { root, verb } = folder("lifestream-processing-first-default-");
    editSettings(root, { "model.defaults.pictures": null, "model.defaults.audio": null, "model.defaults.text": null });
    const defaults = () => Object.fromEntries(Object.entries(personal(root)).filter(([key]) => key.startsWith("model.defaults.")));
    const values = async () => {
      const read = await verb("models", []) as { defaults: Record<WorkKind, { value: string | null }> };
      return { pictures: read.defaults.pictures.value, audio: read.defaults.audio.value, text: read.defaults.text.value };
    };
    let home = await start(root);
    try {
      expect(stored(root)[FAKE_ROUTE]).toBe("ready");
      expect(defaults()).toEqual({ "model.defaults.text": FAKE_ROUTE });
      expect(await values()).toEqual({ pictures: "none", audio: "none", text: FAKE_ROUTE });
      await home.stop();
      home = await start(root);
      await picked(root, home);
      expect(await values()).toEqual({ pictures: "none", audio: "none", text: FAKE_ROUTE });
      await verb("models", ["default", "pictures", FAKE_ROUTE]);
      await verb("models", ["default", "audio", FAKE_ROUTE]);
      expect(await values()).toEqual({ pictures: FAKE_ROUTE, audio: FAKE_ROUTE, text: FAKE_ROUTE });
      await verb("models", ["default", "pictures", "none"]);
      await verb("models", ["default", "text", "none"]);
      await picked(root, home);
      await home.stop();
      home = await start(root);
      await picked(root, home);
      expect(defaults()).toEqual({ "model.defaults.audio": FAKE_ROUTE, "model.defaults.pictures": null, "model.defaults.text": null });
      await verb("settings", ["set", "model.transports.fake", JSON.stringify({ delay_ms: 100, unavailable: "a synthetic outage", models: OFFERS })]);
      await until("the route not ready", () => stored(root)[FAKE_ROUTE] === "unavailable");
      await verb("settings", ["set", "model.transports.fake", JSON.stringify({ delay_ms: 100, models: OFFERS })]);
      await until("the route ready again", () => stored(root)[FAKE_ROUTE] === "ready");
      await picked(root, home);
      expect(defaults()).toEqual({ "model.defaults.audio": FAKE_ROUTE, "model.defaults.pictures": null, "model.defaults.text": null });
    } finally {
      await home.stop();
    }
  });

  it("a home whose settings cannot be written stops, or never fills the default again, when it fills a default", async () => {
    const { root } = folder("lifestream-processing-defaults-unwritten-");
    editSettings(root, { "model.defaults.pictures": null, "model.defaults.audio": null, "model.defaults.text": null });
    const begun = Date.now();
    seed(root, (ledger) => ledger.rest("fake", { until_ms: begun + 60_000, resets_ms: null, cause: "provider", reason: "a synthetic rest" }, begun));
    const lines: string[] = [];
    let ahead = 0;
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: (line) => lines.push(line), tickMs: TICK_MS, clock: () => Date.now() + ahead });
    try {
      expect(Object.keys(personal(root)).filter((key) => key.startsWith("model.defaults."))).toEqual([]);
      chmodSync(join(root, "config"), 0o555);
      ahead = 120_000;
      await until("the defaults' write refused", () => lines.some((line) => line.includes("defaults not written")));
      const at = home.stats().ticks.count;
      await until("two more ticks", () => home.stats().ticks.count > at + 1);
      expect(Object.keys(personal(root)).filter((key) => key.startsWith("model.defaults."))).toEqual([]);
      chmodSync(join(root, "config"), 0o755);
      ahead = 240_000;
      await until("the text default filled", () => personal(root)["model.defaults.text"] === FAKE_ROUTE);
      expect(Object.keys(personal(root)).filter((key) => key.startsWith("model.defaults."))).toEqual(["model.defaults.text"]);
    } finally {
      chmodSync(join(root, "config"), 0o755);
      await home.stop();
    }
  });

  it("connectors set or a kind's default takes a route that cannot serve the work, settings set writes a default beside its act, or a model whose name has a space is refused", async () => {
    const text = { ...FAKE_OFFER, model: "fake-text", name: "Fake text", input: ["text"] };
    const spaced = { ...FAKE_OFFER, model: "fake spaced model", name: "Fake spaced" };
    const { root, verb, set } = folder("lifestream-processing-serves-", { fake: { models: [FAKE_OFFER, text, spaced] } });
    const home = await start(root);
    try {
      await expect(set("llm.photos", "fake:fake-text")).rejects.toThrow("names a model route that cannot serve photo descriptions");
      await expect(verb("models", ["default", "pictures", "fake:fake-text"])).rejects.toThrow("Fake text does not take pictures");
      await expect(verb("models", ["default", "pictures", "fake:nope"])).rejects.toThrow("no model fake:nope");
      await expect(verb("settings", ["set", "model.defaults.text", "fake:fake-text"])).rejects.toThrow("use lifestream models default text <route|none>");
      await verb("models", ["default", "text", "fake:fake-text"]);
      expect(personal(root)["model.defaults.text"]).toBe("fake:fake-text");
      await set("llm.photos", "fake:fake spaced model");
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("n1", D1)] });
      await until("the caption answered", () => quiet(root) && done(root).length === 1);
      expect(sent(root)).toEqual([{ item: "photo:n1", model: "fake spaced model", attempts: ["fake replied"] }]);
    } finally {
      await home.stop();
    }
  });

  it("a started unit waits behind an unstarted one", async () => {
    const { root, verb, set } = folder("lifestream-processing-started-", { fake: { unavailable: "a synthetic outage", concurrency: 1 } });
    seed(root, (ledger, asker) => {
      const key = (asker.request(routed(captionAsk("photo:a1", "synthetic note a1"), FAKE_CHOICE).ask) as { send: string }).send;
      const begun = ledger.beginAttempt(key, Date.now(), "fake") as { attempt: Parameters<typeof ledger.land>[0] };
      ledger.land(begun.attempt, { text: "a caption by the fake model", model: "fake-model", transport: "fake" }, Date.now());
    });
    const home = await start(root);
    try {
      await set("llm.photos", FAKE_ROUTE);
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("a1", D1), note("a2", D1 + 60_000), note("b1", D1 + DAY), note("c1", D1 + 2 * DAY)] });
      await until("three asks owed, day 1 started", () => quiet(root) && done(root).length === 1 && pending(root).length === 3 &&
        count(root, "SELECT started FROM asks WHERE item = 'photo:a2'") === 1);
      await verb("settings", ["set", "model.transports.fake", JSON.stringify({ delay_ms: 100, models: OFFERS, concurrency: 1 })]);
      await until("every ask answered", () => quiet(root) && done(root).length === 4);
      expect(sent(root).map((each) => each.item)).toEqual(["photo:a1", "photo:a2", "photo:c1", "photo:b1"]);
    } finally {
      await home.stop();
    }
  });

  it("an owed ask the plan no longer makes outlives the plan, or is picked: an older prompt's, a photo dropped, a note gone, a day whose end moved", async () => {
    const { root, set } = folder("lifestream-processing-owned-");
    const rows = () => readHome(root, (db) => db.prepare("SELECT item, prompt, at_key FROM asks WHERE state = 'pending' ORDER BY item, prompt").all()) as
      { item: string; prompt: string; at_key: number }[];
    const HOUR = 3_600_000;
    let home = await start(root);
    try {
      await set("llm.photos", "off");
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("n1", D1), note("m1", D1 + DAY)] });
      await until("two asks owed", () => quiet(root) && pending(root).length === 2);
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 50_000, rows: [note("n2", D1 + HOUR, { photo: false })] });
      await until("the ask at the day's new end", () => quiet(root) && pending(root).find((row) => row.item === "photo:n1")?.at_key === D1 + HOUR);
      expect(pending(root)).toHaveLength(2);
      await home.stop();
      const db = openHome(openHomeFolder(root), "migrate");
      db.commit((tx) => tx.tables.asks.put({
        family: "notes", item: "photo:n1", prompt: "fake-old-caption", version: 1, input_hash: "h0", unit: unitOf(D1), work_id: WORK, at_key: D1 + HOUR,
        started: false, waits: "revision-v0", retry_ms: null, given_up: null, unhideable: null, state: "pending",
      }));
      db.close();
      home = await start(root);
      expect(rows().map((row) => [row.item, row.prompt])).toEqual([["photo:m1", "fake-caption"], ["photo:n1", "fake-caption"], ["photo:n1", "fake-old-caption"]]);
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 40_000, rows: [note("n3", D1 + 2 * HOUR, { photo: false })] });
      await until("the older prompt's row gone", () => quiet(root) && !rows().some((row) => row.prompt === "fake-old-caption"));
      expect(rows().map((row) => [row.item, row.at_key])).toEqual([["photo:m1", D1 + DAY], ["photo:n1", D1 + 2 * HOUR]]);
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 30_000, rows: [note("n1", D1, { photo: false }), { kind: "note", key: "m1", content: null, gone: true }] });
      await until("nothing owed", () => quiet(root) && pending(root).length === 0 && count(root, "SELECT count(*) FROM extracts WHERE unit = ?", unitOf(D1 + DAY)) === 0);
      await set("llm.photos", FAKE_ROUTE);
      await picked(root, home);
      await picked(root, home);
      expect(sent(root)).toEqual([]);
      expect([count(root, "SELECT count(*) FROM enrichments"), count(root, "SELECT count(*) FROM asks")]).toEqual([0, 0]);
      artifact(root, "processing-owned", { rows: rows() });
    } finally {
      await home.stop();
    }
  });

  it("an extract an older code built is planned or sent by the new code before its rebuild publishes, or its answer stops printing", async () => {
    const notesCode = (code: string) => ({ "families.notes": { code, per: "day" } });
    const { root, verb, set } = folder("lifestream-processing-code-", { settings: notesCode("1"), fake: { unavailable: "a synthetic outage" } });
    const code = (): string => readHome(root, (db) => db.prepare("SELECT code FROM extracts WHERE family = 'notes' AND unit = ?").pluck().get(unitOf(D1)) as string);
    const idle = (): boolean => count(root, "SELECT count(*) FROM jobs WHERE (kind = 'send' AND state IN ('queued', 'running')) OR (kind = 'plan' AND state = 'running')") === 0;
    const gate = join(root, "rebuild-gate");
    const caption = "a caption by the fake model";
    seed(root, (ledger, asker) => {
      const key = (asker.request(routed(captionAsk("photo:n1", "synthetic note n1"), FAKE_CHOICE).ask) as { send: string }).send;
      const begun = ledger.beginAttempt(key, Date.now(), "fake") as { attempt: Parameters<typeof ledger.land>[0] };
      ledger.land(begun.attempt, { text: caption, model: "fake-model", transport: "fake" }, Date.now());
    });
    let home = await start(root);
    try {
      await set("llm.photos", FAKE_ROUTE);
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [{ ...note("h0", D1 - DAY), content: { text: "the held note", at: D1 - DAY, hold: gate } }] });
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 50_000, rows: [note("n1", D1), note("n2", D1 + 60_000)] });
      await until("n1 answered, n2 owed", () => quiet(root) && done(root).length === 1 && pending(root).length === 1);
      const answer = done(root)[0]!;
      expect(pending(root).map((row) => row.item)).toEqual(["photo:n2"]);
      expect(dayOne(root)).toContain(`[${caption}]`);
      await home.stop();

      writeFileSync(gate, "");
      editSettings(root, notesCode("2"));
      home = await start(root);
      await until("the rebuild held at its first unit", () => existsSync(`${gate}.held`));
      expect(code()).toBe("1");
      const before = { plans: plans(root), day: dayOne(root) };
      await verb("settings", ["set", "model.transports.fake", JSON.stringify({ delay_ms: 100, models: OFFERS })]);
      await until("the old ask gone, nothing sending or planning", () => pending(root).length === 0 && plans(root) > before.plans && idle());
      const at = home.stats().ticks.count;
      await until("two more ticks, nothing planned or sent", () => home.stats().ticks.count > at + 1 && idle());
      const during = { pending: pending(root), done: done(root), sent: sent(root), code: code(), day: dayOne(root) };
      expect(during.pending).toEqual([]);
      expect(during.done).toEqual([answer]);
      expect(during.sent).toEqual([{ item: "photo:n1", model: "fake-model", attempts: ["fake replied"] }]);
      expect(during.code).toBe("1");
      expect(during.day).toBe(before.day);

      rmSync(gate);
      await until("the other photo answered under the new code", () => quiet(root) && done(root).length === 2);
      const after = { pending: pending(root), done: done(root), sent: sent(root), code: code(), day: dayOne(root) };
      expect(after.code).toBe("2");
      expect(after.pending).toEqual([]);
      expect(after.sent).toEqual([{ item: "photo:n1", model: "fake-model", attempts: ["fake replied"] }, { item: "photo:n2", model: "fake-model", attempts: ["fake replied"] }]);
      expect(after.done.find((row) => row.item === "photo:n1")).toEqual(answer);
      await until("the day printing both", () => quiet(root) && answers(root).every(([, text]) => dayOne(root).includes(`[${text}]`)));
      artifact(root, "processing-code-change", { before, during, after });
    } finally {
      rmSync(gate, { force: true });
      await home.stop();
    }
  });

  it("the first start of LLM processing on a home fails, or sends older than thirty days, or loses an answer, or moves its range at the next start", async () => {
    const now = Date.now();
    const [old, recent, answered] = [now - 60 * DAY, now - DAY, now - 90 * DAY];
    const { root, set } = folder("lifestream-processing-first-", { defaults: true });
    let home = await start(root);
    try {
      await ship(root, { source: SOURCE, fetched_ms: now - 60_000, rows: [note("a", answered)] });
      await until("the old caption answered", () => quiet(root) && done(root).length === 1);
      await set("llm.photos", "off");
      await ship(root, { source: SOURCE, fetched_ms: now - 50_000, rows: [note("o", old), note("r", recent)] });
      await until("two asks owed", () => quiet(root) && pending(root).length === 2);
    } finally {
      await home.stop();
    }
    const answer = done(root);
    const db = new Database(join(root, "home.db"));
    db.prepare("DELETE FROM asks").run();
    db.prepare("DELETE FROM asks_left").run();
    db.prepare("DELETE FROM meta WHERE key IN (?, ?)").run(SINCE, MODELS_META);
    db.close();
    editSettings(root, { "connectors.fake-poll": null });

    home = await start(root);
    try {
      const since = readHome(root, (read) => read.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(SINCE)) as string;
      expect(since).toBe(civilDay(Date.now(), readOpsSettings(root).day));
      await until("the recent caption answered", () => quiet(root) && done(root).some((row) => row.item === "photo:r"));
      await picked(root, home);
      expect(pending(root).map((row) => [row.item, row.work_id])).toEqual([["photo:o", WORK]]);
      expect(sent(root).map((each) => each.item)).toEqual(["photo:a", "photo:r"]);
      expect(done(root).find((row) => row.item === "photo:a")).toEqual(answer[0]);
    } finally {
      await home.stop();
    }
    home = await start(root, () => Date.now() + 40 * DAY);
    try {
      await picked(root, home);
      await picked(root, home);
      expect(readHome(root, (read) => read.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(SINCE))).toBe(civilDay(now, readOpsSettings(root).day));
      expect(sent(root).map((each) => each.item)).toEqual(["photo:a", "photo:r"]);
      expect(pending(root).map((row) => row.item)).toEqual(["photo:o"]);
      artifact(root, "processing-first-start", { sent: sent(root), pending: pending(root), done: done(root) });
    } finally {
      await home.stop();
    }
  });
});

describe("LLM processing: what a stream counts", () => {
  const counting = (root: string) => readHome(root, (db) => db.transaction(() => {
    const { settings } = effective(root);
    const [connectors, families, now_ms] = [fakeDeclarations(), fakeRegistry(settings, homeOf(openHomeFolder(root))).families, D1 + 10 * DAY];
    const read = readProcessing(readTables(db), null, {
      connectors, families, histories: readHistories(db, { folder: openHomeFolder(root), now_ms, settings, connectors, families, ledger: null }),
      blocks: settings.connectors, defaults: settings.defaults, runners: settings.runners, day: settings.day, now_ms, privacy: settings.privacy, home: settings.unit,
    }).get("fake-poll")!;
    const [photos] = read.part.rows;
    return { line: [photos!.shape, photos!.line], notes: read.members.get("llm.range")!.steps.map((step) => step.note) };
  })());

  it("a count read while its unit's extract or plan still runs is said as the whole (Nothing to read, Up to date), or one planned is still said to count, or a start's extract queued with nothing to read holds a count open", async () => {
    const { root, set } = folder("lifestream-processing-counting-");
    const extracting = join(root, "extract-gate");
    const planning = join(root, "plan-gate");
    writeFileSync(extracting, "");
    writeFileSync(planning, "");
    let home = await start(root);
    try {
      await set("llm.photos", FAKE_ROUTE);
      await set("llm.range", "all");
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("n1", D1, { hold: extracting, plan_hold: planning })] });
      await until("the extract held", () => existsSync(`${extracting}.held`));
      expect(counting(root)).toEqual({ line: ["running", "Counting what's left"], notes: ["Counting…", "Counting…", "Counting…", "Counting…"] });
      rmSync(extracting);
      await until("the plan held", () => existsSync(`${planning}.held`));
      expect(counting(root)).toEqual({ line: ["running", "Counting what's left"], notes: ["Nothing to read", "Counting…", "Counting…", "Counting…"] });
      rmSync(planning);
      await until("the caption answered", () => quiet(root) && done(root).length === 1);
      const WHOLE = { line: ["done", "Up to date"], notes: ["Nothing to read", "Nothing to read", "Nothing to read", "Nothing to read"] };
      expect(counting(root)).toEqual(WHOLE);
      await askHome(testSocket(root), "pause", ["extract:notes", "--reason", "held by the test"]);
      await home.stop();
      home = await start(root);
      await until("the start's extract of notes queued", () => job(root, "extract", "notes") === "queued");
      expect(counting(root)).toEqual(WHOLE);
    } finally {
      rmSync(extracting, { force: true });
      rmSync(planning, { force: true });
      await home.stop();
    }
  });

  it("a count read while what each work has left is filled is said as the whole, or the home's start does not fill it", async () => {
    const calm = (root: string) => count(root, "SELECT count(*) FROM jobs WHERE state IN ('queued', 'running') AND kind <> 'send'") === 0;
    const { root, set } = folder("lifestream-processing-left-fill-");
    let home = await start(root);
    let whole: ReturnType<typeof counting>;
    try {
      await askHome(testSocket(root), "pause", ["send:notes", "--reason", "held by the test"]);
      await set("llm.photos", FAKE_ROUTE);
      await set("llm.range", "all");
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("n1", D1), note("n2", D1 + DAY), note("n3", D1 + 2 * DAY)] });
      await until("three asks owed, nothing but the held send to run", () => calm(root) && pending(root).length === 3);
      whole = counting(root);
      expect(whole.line).toEqual(["running", expect.stringMatching(/^3\b/u)]);
    } finally {
      await home.stop();
    }
    const db = new Database(join(root, "home.db"));
    db.prepare("DELETE FROM asks_left").run();
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(LEFT_MARK, JSON.stringify({ at: null }));
    db.close();
    expect(counting(root)).toEqual({ line: ["running", "Counting what's left"], notes: ["Counting…", "Counting…", "Counting…", "Counting…"] });
    home = await start(root);
    try {
      await until("the fill ended", () => calm(root) && readHome(root, (read) => read.prepare("SELECT count(*) FROM meta WHERE key = ?").pluck().get(LEFT_MARK)) === 0);
      expect(job(root, "left", "asks")).toBe("done");
      expect(readHome(root, (read) => read.prepare("SELECT lane FROM jobs WHERE kind = 'left' AND key = 'asks'").pluck().get())).toBe(LANE.planning);
      expect(counting(root)).toEqual(whole);
    } finally {
      await home.stop();
    }
  });
});

describe("LLM processing: what a refused reply is", () => {
  it("a reply its family refused answers the ask under another route, or charges no try to its revision", () => {
    const root = makeRoot("lifestream-processing-refused-", { sources: {} });
    roots.push(root);
    const ledger = openLedger(openHomeFolder(root), { mode: "migrate" });
    try {
      const asker = openAsker({ ledger, prompt: (name) => notes.prompts![name]!, blobs: openHomeFolder(root).blobs(join(root, "blobs"), { reading: true }) });
      const ask: Ask = { family: "notes", item: "photo:n1", prompt: "fake-caption", input: [{ text: "Caption the photo of note one." }], work: "photos", source: SOURCE };
      const route = fakeRoute;
      const first = routed(ask, route("fake-model")).ask;
      const sent = asker.request(first) as { send: string };
      const begun = ledger.beginAttempt(sent.send, Date.now(), "fake") as { attempt: Parameters<typeof ledger.land>[0] };
      ledger.land(begun.attempt, { text: "not a caption", model: "fake-model", transport: "fake" }, Date.now());
      const candidate = asker.answer(ask) as Candidate;
      expect(candidate.reply.text).toBe("not a caption");
      asker.refuse(ask, candidate, "the reply is no caption");
      expect(asker.answer(ask)).toBeNull();
      expect(asker.state(first)).toEqual({ pending: "unasked" });
      expect(asker.state(routed(ask, route("fake-other")).ask)).toEqual({ pending: "unasked" });
      expect(readLedger(root, (db) => db.prepare("SELECT validation FROM replies").pluck().all())).toEqual(["refused"]);
    } finally {
      ledger.close();
    }
  });
});

describe("what a pick reads", () => {
  function counted<T>(work: () => T): { result: T; statements: number; home: number; scans: string[]; seeks: string[] } {
    const probe = new Database(":memory:");
    const statement = Object.getPrototypeOf(probe.prepare("SELECT 1")) as Record<string, (...args: unknown[]) => unknown>;
    probe.close();
    const originals = Object.fromEntries((["run", "get", "all", "iterate"] as const).map((name) => [name, statement[name]!]));
    const ran: { database: Database.Database; source: string; args: unknown[] }[] = [];
    for (const [name, original] of Object.entries(originals)) {
      statement[name] = function (this: Database.Statement, ...args: unknown[]) {
        ran.push({ database: this.database, source: this.source, args });
        return original.apply(this, args);
      };
    }
    let result: T;
    try {
      result = work();
    } finally {
      Object.assign(statement, originals);
    }
    const planOf = ({ database, source, args }: (typeof ran)[number]) => (database.prepare(`EXPLAIN QUERY PLAN ${source}`).all(...args) as { detail: string }[]).map((step) => step.detail);
    const scans = ran.flatMap((each) => planOf(each).filter((detail) => /^SCAN |TEMP B-TREE/u.test(detail)).map((detail) => `${detail}: ${each.source.replace(/\s+/gu, " ")}`));
    const seeks = [...new Set(ran.filter((each) => /INDEXED BY asks_pick\b/u.test(each.source)).flatMap(planOf))];
    return { result, statements: ran.length, home: ran.filter((each) => each.database.name.endsWith("home.db")).length, scans, seeks };
  }

  const ROUTE: ModelRoute = {
    id: FAKE_ROUTE, transport: "fake", model: "fake-model", name: "Fake model", input: ["text", "image", "audio"], output: "text", tools: false, context_tokens: null, thinking: [], chat: null, offered: true, runner: null, leaves: null,
    where: "Stays on this computer", cost: "free", request: { effort: "low", sampling: null, timeout_ms: 120_000 }, state: "ready", line: null,
  };
  const OTHER: ModelRoute = { ...ROUTE, id: OTHER_ROUTE, model: "fake-other", name: "Fake other" };
  const resting = (route: ModelRoute): ModelRoute => ({ ...route, state: "waiting", line: "Waiting for the test model" });
  const workOn = (route: string): WorkRouting => ({ kind: "pictures", text_chars: null, value: route, route, suggests: route, start_ms: null, power_ms: null });
  const WORK_TWO = "fake-poll-two/photos";
  const routingOf = (routes: ModelRoute[] = [ROUTE, OTHER], works: Record<string, WorkRouting> = { [WORK]: workOn(ROUTE.id) }): Routing =>
    ({ routes: Object.fromEntries(routes.map((route) => [route.id, route])), works });
  const ROUTING = routingOf([ROUTE]);
  const TWO = routingOf([ROUTE, OTHER], { [WORK]: workOn(ROUTE.id), [WORK_TWO]: workOn(OTHER.id) });
  const NOW = D1 + 400 * DAY;
  const unit = (n: number) => `${SOURCE}/u${String(n).padStart(6, "0")}`;
  const owed = (n: number) => Array.from({ length: n }, (_, at) => ({ item: `photo:p${at}`, work: WORK, input_hash: `h${at}`, at_key: D1 + at * 60_000, unit: unit(at) }));

  function picking(prefix: string) {
    const root = makeRoot(prefix, { sources: { [SOURCE]: "fake-rows" }, defaults: false, cap: 8 });
    roots.push(root);
    const settings = effective(root).settings;
    const db = openHome(openHomeFolder(root), "migrate");
    const ledger = openLedger(openHomeFolder(root), { mode: "migrate" });
    const asker = openAsker({ ledger, prompt: (name) => notes.prompts![name]!, blobs: openHomeFolder(root).blobs(join(root, "blobs"), { reading: true }) });
    const owe = (rows: { item: string; work: string; input_hash: string; at_key: number; unit: string; version?: number; family?: string }[]) => db.commit((tx) => {
      for (const row of rows) {
        tx.tables.asks.put({
          family: row.family ?? "notes", item: row.item, prompt: "fake-caption", version: row.version ?? 1, input_hash: row.input_hash, unit: row.unit,
          work_id: row.work, at_key: row.at_key, started: false, waits: null, retry_ms: null, given_up: null, unhideable: null, state: "pending",
        });
      }
    });
    const calls = (options: { concurrency?: number; cap?: number } = {}) => new Calls({
      root, machine: join(root, "machine"), home: "home-test", handOver: () => ({ root, form: "plain" }), command: ["true"], ledger, model: () => ({ ...settings.model, cap: options.cap ?? settings.model.cap }),
      models: { concurrency: () => options.concurrency ?? 8 }, programs: () => ({}), door: () => "http://127.0.0.1:9", secret: () => ({}), exited: () => undefined, hiding: () => true,
    });
    const pick = (options: { routing?: Routing; concurrency?: number; cap?: number } = {}) => {
      const each = calls(options);
      const run = counted(() => db.commit((tx) => each.pick(tx, NOW, options.routing ?? ROUTING, () => false)));
      return { ...run, taken: each.take("notes").map((taken) => [taken.item, taken.route]) };
    };
    return { root, db, ledger, asker, owe, pick, calls, close: () => { ledger.close(); db.close(); } };
  }

  function measure(size: number) {
    const home = picking(`lifestream-processing-pick-${size}-`);
    try {
      home.owe(owed(size));
      const raw = new Database(join(home.root, "home.db"));
      const mark = raw.prepare("INSERT INTO dirty_units (family, unit, end_ms) VALUES ('notes', ?, ?)");
      raw.transaction(() => { for (let n = 1; n < size; n++) mark.run(unit(n), D1 + n * 60_000); })();
      raw.close();
      const calls = home.calls();
      const picks: { statements: number; scans: string[]; seeks: string[]; taken: string[] }[] = [];
      for (let tick = 0; tick < 1 + Math.ceil(size / 256) && !picks.some((pick) => pick.taken.length > 0); tick++) {
        const pick = counted(() => home.db.commit((tx) => calls.pick(tx, NOW, ROUTING, () => false)));
        picks.push({ statements: pick.statements, scans: pick.scans, seeks: pick.seeks, taken: calls.take("notes").map((each) => each.item) });
      }
      return { owed: size, picks };
    } finally {
      home.close();
    }
  }

  it("a pick reads the whole backlog, or walks it, or more when more waits; a sendable row behind thousands owed a plan waits past one round", () => {
    const small = measure(1_000);
    const large = measure(3_000);
    artifact(roots.at(-1)!, "pick-cost", { small, large });
    expect(new Set([...small.picks.slice(0, -1), ...large.picks.slice(0, -1)].map((pick) => pick.statements)).size).toBe(1);
    for (const pick of [...small.picks, ...large.picks]) expect(pick.scans.filter((scan) => !/^SCAN item_routes\b/u.test(scan))).toEqual([]);
    expect(new Set([...small.picks, ...large.picks].flatMap((pick) => pick.seeks))).toEqual(new Set([
      "SEARCH asks USING INDEX asks_pick (work_id=?)",
      "SEARCH asks USING INDEX asks_pick (work_id=? AND (started,at_key,unit,item,prompt,family)<(?,?,?,?,?,?))",
      "CORRELATED SCALAR SUBQUERY 1", "CORRELATED SCALAR SUBQUERY 2", "SEARCH u USING PRIMARY KEY (family=? AND item=? AND prompt=?)",
    ]));
    expect(small.picks.at(-1)!.taken).toEqual(["photo:p0"]);
    expect(large.picks.at(-1)!.taken).toEqual(["photo:p0"]);
    expect(large.picks.length).toBeLessThanOrEqual(1 + Math.ceil(3_000 / 256));
  });

  it("a pick with no free slot reads home.db, or one whose every route rests reads a work's rows", () => {
    const home = picking("lifestream-processing-no-slot-");
    try {
      home.owe(owed(10));
      const bare = counted(() => home.db.commit(() => undefined)).home;
      const full = home.pick({ cap: 0 });
      expect(full.taken).toEqual([]);
      expect(full.home).toBe(bare);
      const rest = home.pick({ routing: routingOf([resting(ROUTE), resting(OTHER)]) });
      expect(rest.taken).toEqual([]);
      expect(rest.seeks).toEqual([]);
      expect(home.pick().taken).toHaveLength(8);
    } finally {
      home.close();
    }
  });

  it("a pick sends an ask whose call is in flight under another route's key", () => {
    const home = picking("lifestream-processing-pick-in-flight-");
    try {
      const first = captionAsk("photo:s1", "a shared photo");
      const second = captionAsk("photo:s2", "a shared photo", "apple-notes:local:device-b");
      const key = (home.asker.request(routed(first, FAKE_CHOICE).ask) as { send: string }).send;
      expect(home.ledger.beginAttempt(key, NOW, "fake")).toMatchObject({ attempt: expect.anything() });
      const { version, input_hash } = home.asker.known(first);
      expect(home.asker.known(second)).toEqual({ prompt: "fake-caption", version, input_hash });
      home.owe([
        { item: "photo:s1", work: WORK, version, input_hash, at_key: D1, unit: unit(1) },
        { item: "photo:s2", work: WORK_TWO, version, input_hash, at_key: D1, unit: unit(2) },
      ]);
      expect(home.pick({ routing: TWO }).taken).toEqual([]);
    } finally {
      home.close();
    }
  });

  it("a chosen item whose work no connector declares now is sent by its choice, or a choice of it is taken", () => {
    const home = picking("lifestream-processing-pick-unknown-");
    try {
      home.owe([{ item: "photo:g1", work: "gone/photos", input_hash: "g1", at_key: NOW - DAY, unit: unitOf(NOW - DAY) }]);
      home.db.commit((tx) => tx.tables.itemRoutes.set({ family: "notes", item: "photo:g1", prompt: "fake-caption", route: FAKE_ROUTE, model: "fake-model" }));
      expect(home.pick().taken).toEqual([]);
      expect(home.db.commit((tx) => chooseFor(tx.tables, ROUTING, { family: "notes", item: "photo:g1", prompt: "fake-caption", route: FAKE_ROUTE })))
        .toEqual({ refused: "Nothing is asked of this item." });
    } finally {
      home.close();
    }
  });

  it("a work's row is picked before a chosen item, or a chosen item goes by its work's route", () => {
    const home = picking("lifestream-processing-pick-chosen-");
    try {
      home.owe(owed(3));
      home.db.commit((tx) => tx.tables.itemRoutes.set({ family: "notes", item: "photo:p0", prompt: "fake-caption", route: OTHER_ROUTE, model: "fake-other" }));
      expect(home.pick({ routing: routingOf(), concurrency: 1 }).taken).toEqual([["photo:p0", OTHER_ROUTE]]);
      expect(home.pick({ routing: routingOf([ROUTE, resting(OTHER)]) }).taken).toEqual([["photo:p2", FAKE_ROUTE], ["photo:p1", FAKE_ROUTE]]);
    } finally {
      home.close();
    }
  });

  it("two works on one transport's one slot take turns, or the work whose id sorts first takes every call", () => {
    const home = picking("lifestream-processing-pick-turns-");
    try {
      const asks = (work: string, letter: string) => Array.from({ length: 8 }, (_, at) =>
        ({ item: `photo:${letter}${at}`, work, input_hash: `${letter}${at}`, at_key: D1 + at * 60_000, unit: unit(at) }));
      home.owe([...asks(WORK, "a"), ...asks(WORK_TWO, "b")]);
      const routing = routingOf([ROUTE], { [WORK]: workOn(ROUTE.id), [WORK_TWO]: workOn(ROUTE.id) });
      const calls = home.calls({ concurrency: 1 });
      const turns: string[] = [];
      for (let tick = 0; tick < 6; tick++) {
        home.db.commit((tx) => calls.pick(tx, NOW, routing, () => false));
        const taken = calls.take("notes");
        expect(taken).toHaveLength(1);
        turns.push(taken[0]!.item.slice("photo:".length, "photo:".length + 1));
        calls.release("notes");
      }
      const first = WORK_TWO < WORK ? "b" : "a";
      const second = first === "a" ? "b" : "a";
      expect(turns).toEqual([first, second, first, second, first, second]);
    } finally {
      home.close();
    }
  });

  it("a work holding a call in flight waits while one holding none takes the freed slot, though the one holding was served less recently", () => {
    const home = picking("lifestream-processing-pick-turns-holding-");
    try {
      const asks = (work: string, letter: string) => Array.from({ length: 4 }, (_, at) =>
        ({ item: `photo:${letter}${at}`, work, input_hash: `${letter}${at}`, at_key: D1 + at * 60_000, unit: unit(at), family: `${letter}${at}` }));
      const [first, second] = WORK < WORK_TWO ? [WORK, WORK_TWO] : [WORK_TWO, WORK];
      home.owe([...asks(first, "f"), ...asks(second, "s")]);
      const routing = routingOf([ROUTE], { [WORK]: workOn(ROUTE.id), [WORK_TWO]: workOn(ROUTE.id) });
      const calls = home.calls({ concurrency: 2 });
      const pick = () => home.db.commit((tx) => calls.pick(tx, NOW, routing, () => false));
      const took = (family: string) => calls.take(family).length === 1;
      const of = (families: string[]) => families.map((family) => family[0]!);
      const both = pick();
      expect(of(both)).toEqual(["f", "f"]);
      expect(both.map(took)).toEqual([true, true]);
      calls.release(both[0]!);
      const [other] = pick();
      expect([of([other!]), took(other!)]).toEqual([["s"], true]);
      calls.release(other!);
      expect(of(pick())).toEqual(["s"]);
    } finally {
      home.close();
    }
  });
});

describe("what a route says", () => {
  const DAY_SETTINGS = { zone: "UTC", day_start_hour: 4 };
  const HOUR = 3_600_000;
  function models(fake: JsonObject, now: () => number, rest: () => Rest | null = () => null): Models {
    return new Models({
      settings: () => ({
        model: { cap: 1, transports: { fake: { models: [FAKE_OFFER], ...fake } } } as unknown as ReturnType<typeof effective>["settings"]["model"],
        defaults: { pictures: null, audio: null, text: null }, connectors: {}, runners: {}, privacy: PRIVACY, search: SEARCH_OFF,
      }),
      registry: () => ({ connectors: [], families: [] }),
      ledger: { resting: () => new Map(rest() === null ? [] : [["fake", rest()!]]) },
      found: () => ({ programs: {}, held: () => false }), runners: async () => ({ runners: [], below: [] }), paired: () => new Set(), clock: now, day: () => DAY_SETTINGS, unset: () => [], fill: () => undefined,
    });
  }
  const said = (each: Models) => {
    const route = each.list(new Set()).find((one) => one.id === FAKE_ROUTE)!;
    return { state: route.state, line: route.line };
  };

  it("a limit is said by the reset its provider stated, never by the hour the home tries again; met again within that hour, the same; a limit with no time, with none", async () => {
    let now = D1;
    let rest: Rest | null = null;
    const each = models({}, () => now, () => rest);
    await each.read();
    expect(said(each)).toEqual({ state: "ready", line: null });
    const resets = D1 + 26 * HOUR;
    rest = { until_ms: now + HOUR, resets_ms: resets, cause: "limit", reason: "synthetic: the limit is met" } as Rest;
    const first = said(each);
    expect(first).toEqual({ state: "waiting", line: "The test model is at its limit · resets tomorrow 14:00" });
    now = D1 + HOUR;
    rest = { until_ms: now + HOUR, resets_ms: resets, cause: "limit", reason: "synthetic: the limit is met" } as Rest;
    expect(said(each)).toEqual(first);
    rest = { until_ms: now + HOUR, resets_ms: null, cause: "limit", reason: "synthetic: limited, no time" } as Rest;
    expect(said(each).line).toBe("The test model is at its limit for now");
  });

  it("each cause is worded by its own sentence, by the transport's code and cost: a plan used up, its provider failing, its route away; a transport that cannot run, what it needs; a model not ready, the home's words", async () => {
    const line = async (fake: JsonObject, rest: { cause: "limit" | "unavailable" | "provider"; resets_ms: number | null } | null = null) => {
      const each = models({ provider: "Claude", ...fake }, () => D1, () => rest === null ? null : { until_ms: D1 + HOUR, reason: "synthetic", ...rest } as Rest);
      await each.read();
      return said(each).line;
    };
    expect([
      await line({ cost: "plan" }, { cause: "limit", resets_ms: D1 + 2 * HOUR }), await line({ cost: "plan" }, { cause: "limit", resets_ms: null }),
      await line({ cost: "priced" }, { cause: "limit", resets_ms: D1 + 2 * HOUR }), await line({}, { cause: "provider", resets_ms: null }),
      await line({}, { cause: "unavailable", resets_ms: null }),
      await line({ unavailable: "synthetic", reason: "signed_out" }), await line({ unavailable: "synthetic", reason: "no_key" }),
      await line({ unavailable: "synthetic", reason: "no_program" }), await line({ unavailable: "synthetic", reason: "unusable" }),
      await line({ unavailable: "synthetic" }), await line({ models: [{ ...FAKE_OFFER, ready: false }] }), await line({}),
    ]).toEqual([
      "Your Claude plan is used up · resets 14:00", "Your Claude plan is used up for now", "Claude is at its limit · resets 14:00",
      "Waiting for Claude", "Claude isn't available for now",
      "Sign in to Claude again", "Add the key for Claude", "Claude isn't set up on this Mac yet", "Claude can't run on this Mac",
      "Claude isn't available", `${FAKE_OFFER.name} isn't ready`, null,
    ]);
  });
});

describe("what a tick opens again", () => {
  it("a given-up ask is asked again when its work's route moves, never by the route it was given up under, and a chosen one is the choice's", async () => {
    const root = makeRoot("lifestream-processing-reopen-", { sources: {}, defaults: false });
    roots.push(root);
    let block: JsonObject = { "llm.photos": FAKE_ROUTE, "llm.range": "all" };
    const models = new Models({
      settings: () => ({
        model: { cap: 4, transports: { fake: { models: OFFERS } } } as unknown as ReturnType<typeof effective>["settings"]["model"],
        defaults: { pictures: null, audio: null, text: null }, connectors: { "fake-poll": block }, runners: {}, privacy: PRIVACY, search: SEARCH_OFF,
      }),
      registry: () => ({ connectors: FAKE_CONNECTORS, families: [] }), ledger: { resting: () => new Map() },
      found: () => ({ programs: {}, held: () => false }), runners: async () => ({ runners: [], below: [] }), paired: () => new Set(), clock: () => D1, day: () => ({ zone: "UTC", day_start_hour: 4 }),
      unset: () => [], fill: () => undefined,
    });
    const states = () => readHome(root, (db) => db.prepare("SELECT item, state, given_up FROM asks ORDER BY item").all());
    const db = openHome(openHomeFolder(root), "migrate");
    try {
      db.commit((tx) => {
        for (const item of ["photo:g1", "photo:g2"]) {
          tx.tables.asks.put({
            family: "notes", item, prompt: "fake-caption", version: 1, input_hash: item, unit: unitOf(D1), work_id: WORK, at_key: D1,
            started: true, waits: null, retry_ms: null, given_up: null, unhideable: null, state: "pending",
          });
          tx.tables.asks.giveUp("notes", item, "fake-caption", FAKE_ROUTE);
        }
      });
      await models.read();
      db.commit((tx) => models.tick(tx));
      expect(states()).toEqual([
        { item: "photo:g1", state: "given-up", given_up: FAKE_ROUTE }, { item: "photo:g2", state: "given-up", given_up: FAKE_ROUTE },
      ]);
      db.commit((tx) => tx.tables.itemRoutes.set({ family: "notes", item: "photo:g2", prompt: "fake-caption", route: FAKE_ROUTE, model: "fake-model" }));
      db.commit((tx) => tx.tables.asks.giveUp("notes", "photo:g2", "fake-caption", FAKE_ROUTE));
      block = { "llm.photos": OTHER_ROUTE, "llm.range": "all" };
      db.commit((tx) => models.tick(tx));
      expect(states()).toEqual([
        { item: "photo:g1", state: "pending", given_up: null }, { item: "photo:g2", state: "given-up", given_up: FAKE_ROUTE },
      ]);
    } finally {
      db.close();
    }
  });
});

describe("what a tick opens again, of what could not be hidden", () => {
  it("an unhideable ask opens when its work's level or route moves, never at a start or a privacy setting that moves neither", async () => {
    const root = makeRoot("lifestream-processing-unhideable-", { sources: {}, defaults: false });
    roots.push(root);
    let block: JsonObject = { "llm.photos": FAKE_ROUTE, "llm.range": "all" };
    let privacy = PRIVACY;
    const models = () => new Models({
      settings: () => ({
        model: { cap: 4, transports: { fake: { models: OFFERS } } } as unknown as ReturnType<typeof effective>["settings"]["model"],
        defaults: { pictures: null, audio: null, text: null }, connectors: { "fake-poll": block }, runners: {}, privacy, search: SEARCH_OFF,
      }),
      registry: () => ({ connectors: FAKE_CONNECTORS, families: [] }), ledger: { resting: () => new Map() },
      found: () => ({ programs: {}, held: () => false }), runners: async () => ({ runners: [], below: [] }), paired: () => new Set(), clock: () => D1, day: () => ({ zone: "UTC", day_start_hour: 4 }),
      unset: () => [], fill: () => undefined,
    });
    const why = () => readHome(root, (db) => db.prepare("SELECT why FROM asks_unhideable WHERE item = 'photo:u1'").pluck().get() ?? null) as string | null;
    const db = openHome(openHomeFolder(root), "write");
    try {
      const unhideable = () => db.commit((tx) => tx.tables.asks.unhideable("notes", "photo:u1", "fake-caption", "This picture cannot be read"));
      db.commit((tx) => tx.tables.asks.put({
        family: "notes", item: "photo:u1", prompt: "fake-caption", version: 1, input_hash: "photo:u1", unit: unitOf(D1), work_id: WORK, at_key: D1,
        started: true, waits: null, retry_ms: null, given_up: null, unhideable: null, state: "pending",
      }));
      unhideable();
      let running = models();
      await running.read();
      db.commit((tx) => running.tick(tx));
      expect(why()).toBeNull();
      unhideable();
      db.commit((tx) => running.tick(tx));
      running = models();
      await running.read();
      db.commit((tx) => running.tick(tx));
      privacy = { ...PRIVACY, never: ["Example"] };
      db.commit((tx) => running.tick(tx));
      expect(why()).toBe("This picture cannot be read");
      block = { ...block, "privacy.photos": "none" };
      db.commit((tx) => running.tick(tx));
      expect(why()).toBeNull();
      unhideable();
      block = { ...block, "llm.photos": OTHER_ROUTE };
      db.commit((tx) => running.tick(tx));
      expect(why()).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("what the hand-off writes", () => {
  const RECEIVER = "Example Cloud";
  const LEAVING: ModelRoute = {
    id: FAKE_ROUTE, transport: "fake", model: "fake-model", name: "Fake model", input: ["text", "image", "audio"], output: "text", tools: false, context_tokens: null, thinking: [], chat: null, offered: true, runner: null, leaves: RECEIVER,
    where: "Sent to Example Cloud", cost: "free", request: { effort: "low", sampling: null, timeout_ms: 120_000 }, state: "ready", line: null,
  };
  const workOn = (route: string): WorkRouting => ({ kind: "pictures", text_chars: null, value: route, route, suggests: route, start_ms: null, power_ms: null });
  const routingWith = (route: ModelRoute): Routing => ({ routes: { [route.id]: route }, works: { [WORK]: workOn(route.id) } });
  const ask = (item: string, copy: SentAsk["copy"]): SentAsk => ({
    item, prompt: "fake-caption", known: item, key: `sha256:${item}`, route: FAKE_ROUTE, call: { transport: "fake", timeout_ms: 120_000 }, work_id: WORK, at_key: D1, copy,
  });

  function handOff(routing: Routing, level: "all" | "names" | "none", found: Parameters<NonNullable<typeof sendKind.chunk>>[2]) {
    const root = makeRoot("lifestream-processing-handoff-", { sources: {}, defaults: false });
    roots.push(root);
    const db = openHome(openHomeFolder(root), "write");
    const handed: string[] = [];
    const dropped: number[] = [];
    try {
      db.commit((tx) => {
        for (const item of ["photo:h1", "photo:h2"]) {
          tx.tables.asks.put({
            family: "notes", item, prompt: "fake-caption", version: 1, input_hash: item, unit: unitOf(D1), work_id: WORK, at_key: D1,
            started: true, waits: null, retry_ms: null, given_up: null, unhideable: null, state: "pending",
          });
        }
      });
      const main = {
        routing: () => routing,
        copies: { level: () => level, drop: (id: number) => dropped.push(id) },
        calls: { sent: (_family: string, _unit: string, sent: SentAsk[]) => handed.push(...sent.map((each) => each.item)) },
      } as unknown as Main;
      const running = { job: { key: "notes" }, state: undefined } as unknown as Parameters<NonNullable<typeof sendKind.chunk>>[1];
      for (const slice of sendKind.chunk!(main, running, found)) {
        db.commit((tx) => slice.work(tx));
        slice.after?.();
      }
      const rows = readHome(root, (read) => read.prepare("SELECT a.item, u.why AS unhideable FROM asks a LEFT JOIN asks_unhideable u ON u.family = a.family AND u.item = a.item AND u.prompt = a.prompt ORDER BY a.item").all()) as { item: string; unhideable: string | null }[];
      return { handed, dropped, unhideable: Object.fromEntries(rows.map((row) => [row.item, row.unhideable])) };
    } finally {
      db.close();
    }
  }

  it("a copy made for another receiver or under another level is deleted and not handed; one that stands is handed", () => {
    const copy = (id: number, receiver: string, level: "all" | "names" | "none") => ({ id, receiver, level });
    const found = [{ unit: unitOf(D1), picked: 2, sent: [ask("photo:h1", copy(1, RECEIVER, "all")), ask("photo:h2", copy(2, RECEIVER, "names"))], found: [] }];
    expect(handOff(routingWith(LEAVING), "all", found)).toMatchObject({ handed: ["photo:h1"], dropped: [2] });
    expect(handOff(routingWith({ ...LEAVING, leaves: "Another Cloud" }), "all", found)).toMatchObject({ handed: [], dropped: [1, 2] });
    expect(handOff(routingWith(LEAVING), "all", [{ unit: unitOf(D1), picked: 1, sent: [ask("photo:h1", null)], found: [] }])).toMatchObject({ handed: [], dropped: [] });
    expect(stands({ leaves: null }, { leaves: null, level: null }, "all")).toBe(true);
    expect(stands(null, { leaves: RECEIVER, level: "all" }, "all")).toBe(false);
  });

  it("an item found unhideable is written so only while the receiver and the level it was found for stand", () => {
    const found = (level: "all" | "names") => [{
      unit: unitOf(D1), picked: 1, sent: [],
      found: [{ item: "photo:h1", prompt: "fake-caption", unhideable: "This picture cannot be read", ask: ask("photo:h1", null), leaves: RECEIVER, level }],
    }];
    expect(handOff(routingWith(LEAVING), "all", found("all")).unhideable).toEqual({ "photo:h1": "This picture cannot be read", "photo:h2": null });
    expect(handOff(routingWith(LEAVING), "none", found("all")).unhideable).toEqual({ "photo:h1": null, "photo:h2": null });
    expect(handOff(routingWith({ ...LEAVING, leaves: "Another Cloud" }), "all", found("all")).unhideable).toEqual({ "photo:h1": null, "photo:h2": null });
  });
});

describe("what a work with asks that could not be hidden reads", () => {
  it("a work whose only pending asks could not be hidden is up to date, with them counted on its line, never left", () => {
    const root = makeRoot("lifestream-processing-unhidden-", { sources: { [SOURCE]: "fake-rows" }, defaults: false });
    roots.push(root);
    const db = openHome(openHomeFolder(root), "write");
    try {
      db.commit((tx) => {
        tx.tables.asks.put({
          family: "notes", item: "photo:x1", prompt: "fake-caption", version: 1, input_hash: "photo:x1", unit: unitOf(D1), work_id: WORK, at_key: D1,
          started: true, waits: null, retry_ms: null, given_up: null, unhideable: null, state: "pending",
        });
        tx.tables.asks.unhideable("notes", "photo:x1", "fake-caption", "This picture cannot be read");
      });
    } finally {
      db.close();
    }
    expect(readHome(root, (read) => readTables(read).asks.left(WORK, []))).toEqual([]);
    expect(readHome(root, (read) => readTables(read).asks.unhideables(WORK))).toEqual([{ why: "This picture cannot be read", count: 1 }]);
  });
});

describe("a runner's files", () => {
  const DAY_SETTINGS = { zone: "UTC", day_start_hour: 4 };
  const UNIT = "runner-macbook-pro-0001";
  const PASS = "synthetic-drive-pass";
  type Listed = RunnerListing["files"][number];
  const qwen = (state: Listed["state"], fetched_bytes = 0): Listed => ({
    id: "qwen3.5-4b", name: "Qwen 3.5", input: ["text", "image"], output: "text", tools: false, context_tokens: 4_000, thinking: [], bytes: 4_200_000_000, languages: [], memory_gb: 16, state, fetched_bytes, failure: null,
  });
  const parakeet = (state: Listed["state"]): Listed => ({
    id: "parakeet-unified-en-0.6b", name: "Parakeet", input: ["audio"], output: "text", tools: false, context_tokens: null, thinking: [], bytes: 731_357_568, languages: ["en"], memory_gb: 8, state, fetched_bytes: 0, failure: null,
  });
  const nemotron = (state: Listed["state"]): Listed => ({
    id: "nemotron-3.5-asr-0.6b", name: "Nemotron Speech", input: ["audio"], output: "text", tools: false, context_tokens: null, thinking: [], bytes: 751_094_240, memory_gb: 8, state, fetched_bytes: 0, failure: null,
    languages: ["en", "es", "fr", "it", "pt", "nl", "de", "tr", "ru", "ar", "hi", "ja", "ko", "vi", "uk", "pl", "sv", "cs", "nb", "da", "bg", "fi", "hr", "sk", "zh", "hu", "ro", "et"],
  });
  const gemma = (state: Listed["state"]): Listed => ({
    id: "embeddinggemma-2-q8-512", name: "EmbeddingGemma 2", input: ["text"], output: "vectors", tools: false, context_tokens: 2_048, thinking: [], bytes: 480_000_000, languages: [], memory_gb: 8, state, fetched_bytes: 0, failure: null,
  });
  const runner = (present: boolean, files: Listed[]): RunnerListing => ({
    unit: UNIT, name: "MacBook Pro", version: "1", boot: "boot-a", slots: 1, power: "mains", idle_s: null, thermal: null, memory_gb: 16, running: [], files, present,
  });

  async function door(listed: () => RunnerListing[]): Promise<{ url: string; close(): Promise<void> }> {
    const server = createServer((request, response) => {
      const ok = request.url === "/v1/runners" && request.headers.authorization === `Bearer ${PASS}`;
      response.writeHead(ok ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify(ok ? { runners: listed(), below: [] } : { code: "PRINCIPAL_UNKNOWN" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
  }

  it("text with no default is filled by a fetching file, or by another route ready with a runner's, and pictures and audio never are; a runner's route names its machine in its key; the models read misses a runner, its files' state or the file a kind is offered", async () => {
    let listed = [runner(true, [qwen("fetching", 1_200_000_000), parakeet("absent")])];
    let transports: JsonObject = {};
    const filled: Partial<Record<WorkKind, string>>[] = [];
    const at = await door(() => listed);
    try {
      const models = new Models({
        settings: () => ({
          model: { cap: 4, transports } as unknown as ReturnType<typeof effective>["settings"]["model"], defaults: { pictures: null, audio: null, text: null }, connectors: {}, runners: {}, privacy: PRIVACY, search: SEARCH_OFF,
        }),
        registry: () => ({ connectors: [], families: [] }), ledger: { resting: () => new Map() },
        found: () => ({ programs: {}, door: at.url, held: () => false }),
        runners: () => listRunners(at.url, PASS), paired: () => new Set([UNIT]), clock: () => D1, day: () => DAY_SETTINGS, unset: () => ["pictures", "audio", "text"], fill: (taken) => filled.push(taken),
      });
      await models.read();
      expect(filled).toEqual([]);
      const routes = () => Object.fromEntries(models.list(new Set()).filter((route) => route.transport === "runner").map((route) => [route.id, [route.state, route.line ?? route.where]]));
      expect(routes()).toEqual({
        [`runner:${UNIT}/qwen3.5-4b`]: ["unavailable", "Downloading, 1.2 of 4.2 GB"], [`runner:${UNIT}/parakeet-unified-en-0.6b`]: ["unavailable", "Not downloaded"],
      });
      const read = () => modelsRead({ routes: models.list(new Set()), runners: listed.map((each) => ({ ...each, below: null })), openrouter: { connected: false } }, { cap: 4 }, { pictures: null, audio: null, text: null }, { pauses: [], runners: {}, now_ms: D1, day: DAY_SETTINGS }).runners;
      expect(read()).toEqual([{
        unit: UNIT, name: "MacBook Pro", line: null, paused: null, battery: { on: true, held: null }, files: [
          { id: "qwen3.5-4b", name: "Qwen 3.5", about: "Describes photos and sums up text · 4.2 GB", state: "fetching", line: "Downloading, 1.2 of 4.2 GB", suggested: true, fits: true },
          { id: "parakeet-unified-en-0.6b", name: "Parakeet", about: "Transcribes voice notes in English · 0.7 GB", state: "absent", line: "Not downloaded", suggested: true, fits: true },
        ],
      }]);
      listed = [runner(false, [qwen("ready")])];
      await models.read();
      expect(routes()).toEqual({ [`runner:${UNIT}/qwen3.5-4b`]: ["waiting", "MacBook Pro's runner is not running"] });
      expect(read()[0]!.line).toBe("MacBook Pro's runner is not running");
      expect(filled).toEqual([]);
      listed = [runner(true, [qwen("ready"), parakeet("fetching")])];
      transports = { fake: { models: [FAKE_OFFER] } };
      await models.read();
      const id = `runner:${UNIT}/qwen3.5-4b`;
      expect(filled).toEqual([{ text: id }]);
      const qwenRoute = models.list(new Set()).find((route) => route.id === id)!;
      expect([qwenRoute.where, qwenRoute.model, qwenRoute.runner, models.concurrency("runner")]).toEqual(["Stays on MacBook Pro", "qwen3.5-4b", { unit: UNIT, name: "MacBook Pro", battery: false }, 1]);
      const sent = routed(captionAsk("photo:n1", "n1"), { ...qwenRoute, request: qwenRoute.request! });
      expect([sent.ask.model, sent.call]).toEqual(["qwen3.5-4b", { transport: "runner", runner: UNIT, timeout_ms: 300_000 }]);
    } finally {
      await at.close();
    }
  });

  it("a runner's Save battery: none where its machine states no battery or it is away; on unless turned off; while on battery and on, why its older work waits", () => {
    const battery = (power: RunnerListing["power"], runners: Record<string, { save_battery?: boolean }> = {}, present = true) =>
      modelsRead({ routes: [], runners: [{ ...runner(present, []), power, below: null }], openrouter: { connected: false } }, { cap: 4 }, { pictures: null, audio: null, text: null },
        { pauses: [], runners, now_ms: D1, day: DAY_SETTINGS }).runners[0]!.battery;
    const OFF = { [UNIT]: { save_battery: false } };
    expect([battery(null), battery("mains"), battery("battery"), battery("mains", OFF), battery("battery", OFF)]).toEqual([
      null, { on: true, held: null }, { on: true, held: BATTERY_HELD }, { on: false, held: null }, { on: false, held: null },
    ]);
    expect(battery("battery", {}, false)).toBeNull();
    expect(BATTERY_HELD).toBe("On battery · older items wait until it's plugged in");
  });

  it("a kind with no default suggests every file of it the machine runs, the one fetching alone once one is, none once one is ready or the kind has a default; a speech file's words name its languages; only the first file of a kind that fits says it is recommended, and only where another does not fit, which says what it needs", () => {
    const read = (files: Listed[], audio: string | null = null, memory_gb = 16) => {
      const runners = [{ ...runner(true, files), memory_gb, below: null }];
      return Object.fromEntries(modelsRead({ routes: [], runners, openrouter: { connected: false } }, { cap: 4 }, { pictures: FAKE_ROUTE, audio, text: FAKE_ROUTE }, { pauses: [], runners: {}, now_ms: D1, day: DAY_SETTINGS }).runners[0]!.files
        .map((file) => [file.id, [file.about, file.suggested]]));
    };
    const ENGLISH = "Transcribes voice notes in English · 0.7 GB";
    const MANY = "Transcribes voice notes in English, Hindi and 26 more languages · 0.8 GB";
    expect(read([parakeet("absent"), nemotron("absent")])).toEqual({ "parakeet-unified-en-0.6b": [ENGLISH, true], "nemotron-3.5-asr-0.6b": [MANY, true] });
    expect(read([parakeet("absent"), nemotron("fetching")])).toEqual({ "parakeet-unified-en-0.6b": [ENGLISH, false], "nemotron-3.5-asr-0.6b": [MANY, true] });
    expect(read([parakeet("ready"), nemotron("absent")])).toEqual({ "parakeet-unified-en-0.6b": [ENGLISH, false], "nemotron-3.5-asr-0.6b": [MANY, false] });
    expect(read([parakeet("absent"), nemotron("absent")], FAKE_ROUTE)).toEqual({ "parakeet-unified-en-0.6b": [ENGLISH, false], "nemotron-3.5-asr-0.6b": [MANY, false] });
    expect(read([parakeet("absent"), nemotron("absent")], null, 4)).toEqual({ "parakeet-unified-en-0.6b": [`${ENGLISH} · Needs 8 GB of memory`, false], "nemotron-3.5-asr-0.6b": [`${MANY} · Needs 8 GB of memory`, false] });
    expect(read([qwen("absent"), parakeet("absent"), nemotron("absent")], null, 8)).toEqual({
      "qwen3.5-4b": ["Describes photos and sums up text · 4.2 GB · Needs 16 GB of memory", false],
      "parakeet-unified-en-0.6b": [`${ENGLISH} · Recommended for this Mac`, true], "nemotron-3.5-asr-0.6b": [MANY, true],
    });
    expect(read([gemma("absent")])).toEqual({ "embeddinggemma-2-q8-512": ["Search by meaning · 0.5 GB", false] });
  });

  const UNIT_TWO = "runner-mac-mini-bb17";
  const NONE = { pictures: null, audio: null, text: null };
  const runnerModels = (list: () => Promise<RunnerListing[]>, resting: () => ReadonlyMap<string, Rest> = () => new Map(), paired: () => ReadonlySet<string> = () => new Set([UNIT, UNIT_TWO])) => new Models({
    settings: () => ({ model: { cap: 4, transports: {} } as unknown as ReturnType<typeof effective>["settings"]["model"], defaults: NONE, connectors: {}, runners: {}, privacy: PRIVACY, search: SEARCH_OFF }),
    registry: () => ({ connectors: [], families: [] }), ledger: { resting: () => new Map(resting()) },
    found: () => ({ programs: {}, door: "http://127.0.0.1:9", held: () => false }),
    runners: () => list().then((runners) => ({ runners, below: [] })), paired, clock: () => D1, day: () => DAY_SETTINGS, unset: () => [], fill: () => undefined,
  });
  const states = (models: Models) => Object.fromEntries(models.list(new Set()).filter((route) => route.transport === "runner").map((route) => [route.id, route.line ?? route.state]));

  it("a rest holds what failed and nothing wider: a route's rest holds another file of its runner, or a runner's another runner's files", async () => {
    let rest: [string, Rest] | null = null;
    const listed = [runner(true, [qwen("ready"), parakeet("ready")]), { ...runner(true, [qwen("ready")]), unit: UNIT_TWO, name: "Mac mini" }];
    const models = runnerModels(async () => listed, () => new Map(rest === null ? [] : [rest]));
    await models.read();
    const [qwenOne, parakeetOne, qwenTwo] = [`runner:${UNIT}/qwen3.5-4b`, `runner:${UNIT}/parakeet-unified-en-0.6b`, `runner:${UNIT_TWO}/qwen3.5-4b`];
    const away = (reason: string): Rest => ({ until_ms: D1 + 15_000, resets_ms: null, cause: "unavailable", reason });
    rest = [qwenOne, away("synthetic: the file is not ready")];
    expect(states(models)).toEqual({ [qwenOne]: "MacBook Pro's runner isn't available for now", [parakeetOne]: "ready", [qwenTwo]: "ready" });
    rest = [`runner:${UNIT}`, away("synthetic: the runner restarted")];
    expect(states(models)).toEqual({ [qwenOne]: "MacBook Pro's runner isn't available for now", [parakeetOne]: "MacBook Pro's runner isn't available for now", [qwenTwo]: "ready" });
    rest = ["runner", away("synthetic: the door did not answer")];
    expect(Object.values(states(models))).toEqual(["MacBook Pro's runner isn't available for now", "MacBook Pro's runner isn't available for now", "Mac mini's runner isn't available for now"]);
  });

  it("a paused runner's routes wait, \"Paused\", where they would run or rest, and every other route runs; a runner away or a file not there says that still; resumed, they are ready; the routing reads the pause from controls", async () => {
    let rest: [string, Rest] | null = null;
    const listed = [runner(true, [qwen("ready"), parakeet("absent")]), { ...runner(true, [qwen("ready")]), unit: UNIT_TWO, name: "Mac mini" }];
    const models = runnerModels(async () => listed, () => new Map(rest === null ? [] : [rest]));
    await models.read();
    const [qwenOne, parakeetOne, qwenTwo] = [`runner:${UNIT}/qwen3.5-4b`, `runner:${UNIT}/parakeet-unified-en-0.6b`, `runner:${UNIT_TWO}/qwen3.5-4b`];
    const paused = new Set([UNIT]);
    const said = (each: ModelRoute[]) => Object.fromEntries(each.filter((route) => route.transport === "runner").map((route) => [route.id, [route.state, route.line]]));
    expect(said(models.list(paused))).toEqual({ [qwenOne]: ["waiting", "Paused"], [parakeetOne]: ["unavailable", "Not downloaded"], [qwenTwo]: ["ready", null] });
    rest = [`runner:${UNIT}`, { until_ms: D1 + 15_000, resets_ms: null, cause: "unavailable", reason: "synthetic: the runner restarted" }];
    expect(said(models.list(paused))[qwenOne]).toEqual(["waiting", "Paused"]);
    rest = null;
    expect(said(models.list(new Set()))[qwenOne]).toEqual(["ready", null]);
    listed[0] = runner(false, [qwen("ready")]);
    await models.read();
    expect(said(models.list(paused))[qwenOne]).toEqual(["waiting", "MacBook Pro's runner is not running"]);
    listed[0] = runner(true, [qwen("ready")]);
    await models.read();
    const root = makeRoot("lifestream-processing-runner-paused-", { sources: {}, defaults: false });
    roots.push(root);
    const db = openHome(openHomeFolder(root), "migrate");
    try {
      const state = () => db.commit((tx) => models.routing(tx)).routes[qwenOne]!.line ?? "ready";
      expect(state()).toBe("ready");
      db.commit((tx) => tx.tables.controls.set({ target: `runner:${UNIT}`, reason: "the laptop is busy", at_ms: D1, by: "terminal" }));
      expect([state(), db.commit((tx) => models.routing(tx)).routes[qwenTwo]!.state]).toEqual(["Paused", "ready"]);
      db.commit((tx) => tx.tables.controls.clear(`runner:${UNIT}`));
      expect(state()).toBe("ready");
    } finally {
      db.close();
    }
  });

  it("a listing that fails says each runner the home held not running; a start reads what the home last stored and waits on no listing; a runner's running file or slots move no models event, its power does", async () => {
    const root = makeRoot("lifestream-processing-listing-", { sources: {}, defaults: false });
    roots.push(root);
    const events = () => count(root, "SELECT count(*) FROM events WHERE kind = 'models'");
    const meta = () => readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(MODELS_META)) as string | undefined;
    let listing: () => Promise<RunnerListing[]> = async () => [runner(true, [qwen("ready")])];
    const db = openHome(openHomeFolder(root), "migrate");
    try {
      const models = runnerModels(() => listing());
      db.commit((tx) => models.start(tx));
      db.commit((tx) => models.tick(tx));
      expect([meta(), events()]).toEqual([undefined, 0]);
      await models.read();
      db.commit((tx) => models.tick(tx));
      const first = meta();
      const runnerRoutes = (stored: string) => (JSON.parse(stored) as StoredModels).routes.filter((route) => route.transport === "runner");
      expect([runnerRoutes(first!).map((route) => [route.id, route.state]), events()]).toEqual([[[`runner:${UNIT}/qwen3.5-4b`, "ready"]], 0]);
      listing = async () => [{ ...runner(true, [qwen("ready")]), running: ["qwen3.5-4b"], slots: 2, boot: "boot-b" }];
      await models.read();
      db.commit((tx) => models.tick(tx));
      expect([meta(), events()]).toEqual([first, 0]);
      listing = async () => [{ ...runner(true, [qwen("ready")]), power: "battery" }];
      await models.read();
      db.commit((tx) => models.tick(tx));
      expect([runnerRoutes(meta()!)[0]!.runner!.battery, events()]).toEqual([true, 1]);
      listing = () => Promise.reject(new Error("synthetic: the door answered 503"));
      await models.read();
      expect(states(models)).toEqual({ [`runner:${UNIT}/qwen3.5-4b`]: "MacBook Pro's runner is not running" });
      db.commit((tx) => models.tick(tx));
      expect([JSON.parse(meta()!).runners.map((each: { present: boolean }) => each.present), events()]).toEqual([[false], 2]);
      const held = meta();

      const next = runnerModels(() => new Promise<RunnerListing[]>(() => undefined));
      db.commit((tx) => next.start(tx));
      void next.read();
      const routing = db.commit((tx) => next.tick(tx));
      expect([meta(), events(), Object.keys(routing.routes)]).toEqual([held, 2, []]);
    } finally {
      db.close();
    }
  });

  it("a listing that does not name a runner the home held (the door started again, the runner not dialled yet) keeps it as last listed, not running, its Parakeet installed, while its pass stands; it reporting again replaces it; its pass revoked, it is gone", async () => {
    let listing: RunnerListing[] = [runner(true, [qwen("ready"), parakeet("ready")])];
    let paired = new Set([UNIT, UNIT_TWO]);
    const models = runnerModels(async () => listing, () => new Map(), () => paired);
    const [qwenOne, parakeetOne, qwenTwo] = [`runner:${UNIT}/qwen3.5-4b`, `runner:${UNIT}/parakeet-unified-en-0.6b`, `runner:${UNIT_TWO}/qwen3.5-4b`];
    const away = "MacBook Pro's runner is not running";
    const said = () => Object.fromEntries(models.list(new Set()).filter((route) => route.transport === "runner").map((route) => [route.id, [route.state, route.line]]));
    await models.read();
    expect(said()).toEqual({ [qwenOne]: ["ready", null], [parakeetOne]: ["ready", null] });
    listing = [];
    await models.read();
    expect(said()).toEqual({ [qwenOne]: ["waiting", away], [parakeetOne]: ["waiting", away] });
    listing = [{ ...runner(true, [qwen("ready")]), unit: UNIT_TWO, name: "Mac mini" }];
    await models.read();
    expect(said()).toEqual({ [qwenTwo]: ["ready", null], [qwenOne]: ["waiting", away], [parakeetOne]: ["waiting", away] });
    listing = [runner(true, [qwen("ready"), parakeet("absent")]), { ...runner(true, [qwen("ready")]), unit: UNIT_TWO, name: "Mac mini" }];
    await models.read();
    expect(said()).toEqual({ [qwenOne]: ["ready", null], [parakeetOne]: ["unavailable", "Not downloaded"], [qwenTwo]: ["ready", null] });
    paired = new Set([UNIT]);
    listing = [runner(true, [qwen("ready")])];
    await models.read();
    expect(Object.keys(said())).toEqual([qwenOne]);
  });

  it("a runner on battery, its Save battery on (unset), serves its work's asks of the last two days and a person's choice of any day; on mains or Save battery off, its whole range", () => {
    const id = `runner:${UNIT}/qwen3.5-4b`;
    const route = (battery: boolean): ModelRoute => ({
      id, transport: "runner", model: "qwen3.5-4b", name: "Qwen 3.5", input: ["text", "image"], output: "text", tools: false, context_tokens: 4_000, thinking: [], chat: "door", offered: true,
      runner: { unit: UNIT, name: "MacBook Pro", battery }, leaves: null, where: "Stays on MacBook Pro", cost: "free",
      request: { effort: "none", sampling: null, timeout_ms: 300_000 }, state: "ready", line: null,
    });
    const at = (battery: boolean, runners: RoutingInput["runners"] = {}) => resolveRouting({
      connectors: FAKE_CONNECTORS, blocks: { "fake-poll": { "llm.photos": id, "llm.range": "all" } }, defaults: NONE, runners, now_ms: D1, day: DAY_SETTINGS,
      routes: [route(battery)], chosen: [], sources: [], since: "2026-06-01",
    });
    const served = (battery: boolean, at_key: number, chosen: string | null = null, runners: RoutingInput["runners"] = {}) => {
      const now = serving(at(battery, runners), { work_id: WORK, chosen, at_key });
      return "route" in now ? now.route.id : now.none;
    };
    expect(at(true).works[WORK]!.power_ms).toBe(Date.UTC(2026, 4, 31, 4));
    expect([served(true, D1), served(true, Date.UTC(2026, 4, 31, 4)), served(true, Date.UTC(2026, 4, 31, 3, 59)), served(true, D1 - 30 * DAY, id)])
      .toEqual([id, id, "power", id]);
    expect([at(false).works[WORK]!.power_ms, served(false, D1 - 30 * DAY)]).toEqual([null, id]);
    expect(at(true, { [UNIT]: { save_battery: true }, "runner-mac-mini-bb17": { save_battery: false } }).works[WORK]!.power_ms).toBe(Date.UTC(2026, 4, 31, 4));
    const spends = { [UNIT]: { files: ["qwen3.5-4b"], save_battery: false } };
    expect([at(true, spends).works[WORK]!.power_ms, served(true, D1 - 30 * DAY, null, spends)]).toEqual([null, id]);
  });
});
