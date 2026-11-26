import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHome, openHomeFolder } from "@lifestreamprotocol/core";
import { afterAll, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { serveDoor } from "./door.js";
import { startHome } from "./home.js";
import { mintPrincipal } from "./principals.js";
import { basicInstant, openSealing, readDelivery } from "./inbox.js";
import { ask, askHome } from "./socket.js";
import type { Pause } from "./jobs.js";
import { KINDS } from "./kinds.js";
import type { ModelsPage } from "./page-models.js";
import { MODELS_META, type StoredModels } from "./models.js";
import { editSettings, testSocket } from "./test/folder.js";
import { artifact, FAKE_OFFER, FAKES, makeRoot, makeVault, readHome, readLedger, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { doorHere } from "./test/harness-door.js";
import { modelsPageOf, runnerOf, statusOf, streamsOf } from "./test/harness-status.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SOURCE = "apple-notes:local:device-a";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) removeRoot(root);
});

const count = (root: string, sql: string, ...params: unknown[]): number => readHome(root, (db) => db.prepare(sql).pluck().get(...params) as number);
const job = (root: string, kind: string, key: string) =>
  readHome(root, (db) => db.prepare("SELECT state, attempts, requeue FROM jobs WHERE kind = ? AND key = ?").get(kind, key)) as { state: string; attempts: number; requeue: number } | undefined;
const delivered = (root: string, source: string): number => count(root, "SELECT count(*) FROM deliveries WHERE source = ? AND state <> 'superseded'", source);
const voided = (root: string, source: string): number => count(root, "SELECT count(*) FROM deliveries WHERE source = ? AND state = 'superseded'", source);
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pidIn = (path: string): number => Number(readFileSync(path, "utf8"));
const note = (key: string, text: string, at: number, extra: Record<string, unknown> = {}) => ({ kind: "note", key, content: { text, at, ...extra }, at });

interface Status { needs: { id: string; reason: string | null; words: string }[]; paused: { target: string }[] }

async function anotherJobRan(root: string, verb: (name: string, args: string[]) => Promise<unknown>): Promise<void> {
  await verb("run", ["index-inbox", "inbox"]);
  await until("another job run", () => job(root, "index-inbox", "inbox")?.state === "done");
}

async function sealDespiteStop(root: string, lane: string, feeder: string, fetched_ms: number): Promise<void> {
  const fetched_at = new Date(fetched_ms).toISOString();
  if (readDelivery(openHomeFolder(root), lane, basicInstant(fetched_at)) !== null) return;
  const sealing = openSealing(openHomeFolder(root), { source: lane, name: basicInstant(fetched_at), feeder, fetched_at });
  const row = note(`${feeder}-late`, "sealed despite the stop", fetched_ms);
  await sealing.write("rows.ndjson", (async function* () { yield Buffer.from(`${JSON.stringify(row)}\n`); })());
  sealing.seal({});
}

function standingClock(at: number): { now: () => number; run(): void; stand(): number } {
  let standing: number | null = at;
  return { now: () => standing ?? Date.now(), run: () => { standing = null; }, stand: () => (standing = Date.now()) };
}

async function open(prefix: string, options: Parameters<typeof makeRoot>[1], before?: (root: string) => void, clock?: () => number) {
  const root = makeRoot(prefix, options);
  roots.push(root);
  before?.(root);
  const home = await startHome(root, { registry: FAKES, log: () => undefined, tickMs: TICK_MS, ...(clock === undefined ? {} : { clock }) });
  const steps: Record<string, unknown> = {};
  const verb = (name: string, args: string[]) => askHome(testSocket(root), name, args);
  const status = async (step: string): Promise<Status> => {
    const report = statusOf(root, clock === undefined ? {} : { now_ms: clock() }) as Status;
    steps[step] = { needs: report.needs, paused: report.paused };
    return report;
  };
  return { root, home, verb, status, steps };
}

describe("pausing one job", () => {
  it("holds one poll, stops it mid-fetch, and lets its prefix twin poll on", async () => {
    const hold = join(tmpdir(), `lifestream-pausing-hold-${process.pid}`);
    writeFileSync(hold, "");
    const fetched = Date.now();
    const clock = standingClock(fetched);
    const { root, home, verb, status, steps } = await open("lifestream-pausing-poll-", {
      sources: { "apple-notes:local:poll": "fake-rows", "apple-notes:local:poll-two": "fake-rows" }, clocks: true,
      settings: { "connectors.fake-poll": { refresh: "1h", hold }, "connectors.fake-poll-two": { refresh: "1s" } },
    }, undefined, clock.now);
    try {
      await until("fake-poll holds mid-fetch", () => existsSync(`${hold}.held`));
      expect(job(root, "poll", "fake-poll")?.state).toBe("running");
      clock.run();

      expect(await verb("pause", ["poll:fake-poll", "--reason", "a test"])).toEqual({ paused: "poll:fake-poll", by: "terminal" });
      expect(job(root, "poll", "fake-poll")).toEqual({ state: "queued", attempts: 0, requeue: 0 });
      rmSync(hold);
      await until("the stopped helper ended", () => home.stats().helpers.ending === 0);
      await sealDespiteStop(root, "apple-notes:local:poll", "fake-poll", fetched);
      const twin = delivered(root, "apple-notes:local:poll-two");
      await until("fake-poll-two polls on", () => delivered(root, "apple-notes:local:poll-two") >= twin + 3);
      expect(delivered(root, "apple-notes:local:poll")).toBe(0);
      expect(job(root, "poll", "fake-poll")?.state).toBe("queued");
      expect((await status("held")).paused.map((each) => each.target)).toEqual(["poll:fake-poll"]);

      expect(await verb("run", ["poll", "fake-poll"])).toMatchObject({ kind: "poll", key: "fake-poll", held: "poll:fake-poll" });

      await verb("pause", ["kind:poll", "--reason", "a test"]);
      await verb("resume", ["poll:fake-poll"]);
      await anotherJobRan(root, verb);
      expect(job(root, "poll", "fake-poll")?.state).toBe("queued");
      expect(delivered(root, "apple-notes:local:poll")).toBe(0);
      expect(voided(root, "apple-notes:local:poll")).toBe(1);
      await verb("source", ["add", "apple-notes:local:poll-copy", "--connector", "fake-rows", "--options", JSON.stringify({ lane: "apple-notes:local:poll" })]);
      await anotherJobRan(root, verb);
      expect([delivered(root, "apple-notes:local:poll-copy"), voided(root, "apple-notes:local:poll-copy")]).toEqual([0, 1]);
      await status("held by the kind");

      await verb("resume", ["kind:poll"]);
      await until("fake-poll delivers", () => delivered(root, "apple-notes:local:poll") === 1);
      await until("its delivery imported", () => count(root, "SELECT count(*) FROM heads WHERE source = 'apple-notes:local:poll'") === 1);
      await status("resumed");
      await expect(verb("resume", ["kind:poll"])).rejects.toThrow("no pause stands on kind:poll");

      clock.stand();
      rmSync(`${hold}.held`);
      writeFileSync(hold, "");
      await verb("run", ["poll", "fake-poll"]);
      await until("fake-poll holds mid-fetch again", () => existsSync(`${hold}.held`));
      await verb("pause", ["poll:fake-poll", "--reason", "a test"]);
      rmSync(hold);
      await until("the stopped helper ended", () => home.stats().helpers.ending === 0);
      await verb("resume", ["poll:fake-poll"]);
      await until("the next run done", () => job(root, "poll", "fake-poll")?.state === "done");
      expect([delivered(root, "apple-notes:local:poll"), voided(root, "apple-notes:local:poll")]).toEqual([2, 1]);
      clock.run();

      await expect(verb("pause", ["poll:fake-pol"])).rejects.toThrow(/no poll job fake-pol; the home's poll jobs: fake-poll, fake-poll-two/u);
      await expect(verb("run", ["poll", "fake-pol"])).rejects.toThrow(/no poll job fake-pol/u);
      await expect(verb("pause", ["import:apple-notes:local:nowhere"])).rejects.toThrow(/no source apple-notes:local:nowhere is added/u);
      await expect(verb("pause", ["sweep:2026-10-12"])).rejects.toThrow(/pause kind:sweep/u);
      await expect(verb("pause", ["render:day"])).rejects.toThrow(/the one render job's key is days/u);
      await expect(verb("pause", ["lane:1"])).rejects.toThrow(/a pause is home, kind:<kind>, <kind>:<key>, pause:<connector>, pause:<connector>:history or runner:<unit>/u);
    } finally {
      await home.stop();
      rmSync(hold, { force: true });
      artifact(root, "pausing-poll", steps);
    }
  });

  it("hides a paused poll's need, or loses it across the pause", async () => {
    const { root, home, verb, status, steps } = await open("lifestream-pausing-need-", {
      sources: {}, clocks: true, settings: { "connectors.fake-poll": { refresh: "1h", needs_first: true } },
    });
    try {
      const pollNeeds = (report: Status) => report.needs.filter((need) => need.id === "fetch:fake-poll").map((need) => need.words);
      await until("the poll waits on the person", () => count(root, "SELECT count(*) FROM attempts WHERE target = 'fetch:fake-poll' AND outcome = 'need'") === 1);
      expect(pollNeeds(await status("asked"))).toEqual(["Confirm it's you"]);

      await verb("pause", ["poll:fake-poll", "--reason", "a test"]);
      expect(pollNeeds(await status("paused"))).toEqual(["Confirm it's you"]);
      expect(count(root, "SELECT count(*) FROM attempts WHERE target = 'fetch:fake-poll' AND outcome = 'need'")).toBe(1);
      await verb("pause", ["kind:poll", "--reason", "a test"]);
      await verb("resume", ["poll:fake-poll"]);
      expect(pollNeeds(await status("paused by kind"))).toEqual(["Confirm it's you"]);

      await verb("resume", ["kind:poll"]);
      expect(pollNeeds(await status("resumed"))).toEqual(["Confirm it's you"]);
      artifact(root, "pausing-need", steps);
    } finally {
      await home.stop();
    }
  });

  it("hides a paused poll's password need, or asks it twice across the pause", async () => {
    const { root, home, verb, status, steps } = await open("lifestream-pausing-password-", {
      sources: {}, clocks: true, settings: { "connectors.fake-poll": { refresh: "1m", password: "x.password" } },
    });
    try {
      const asked = (report: Status) => report.needs.filter((need) => need.reason === "password").map((need) => need.id);
      const asks = () => count(root, "SELECT count(*) FROM attempts WHERE target = 'fetch:fake-poll' AND outcome = 'need' AND reason = 'password'");
      await makeVault(root);
      await until("the poll asks for its password", () => asks() === 1);
      expect(asked(await status("asked"))).toEqual(["password:x.password"]);

      await verb("pause", ["poll:fake-poll", "--reason", "a test"]);
      expect(asked(await status("paused"))).toEqual(["password:x.password"]);
      expect(asks()).toBe(1);
      await verb("resume", ["poll:fake-poll"]);
      expect(asked(await status("resumed"))).toEqual(["password:x.password"]);
      artifact(root, "pausing-password", steps);
    } finally {
      await home.stop();
    }
  });

  it("stops an import mid-delivery; resumed, it lands the delivery whole, once, in the same run", async () => {
    const hold = join(tmpdir(), `lifestream-pausing-import-${process.pid}`);
    writeFileSync(hold, "");
    const { root, home, verb, status, steps } = await open("lifestream-pausing-import-", { sources: { [SOURCE]: "fake-rows" } });
    try {
      const at = Date.now() - 10 * MINUTE;
      const rows: Record<string, unknown>[] = Array.from({ length: 5_000 }, (_, index) => note(`n${index}`, `note ${index}`, at + index));
      rows.splice(2_500, 0, { hold });
      await ship(root, { source: SOURCE, fetched_ms: at + 2_000, rows: rows as never });
      await until("the import holds mid-delivery", () => existsSync(`${hold}.held`));
      const run = count(root, "SELECT run FROM deliveries WHERE source = ?", SOURCE);
      await until("part of the delivery committed", () => count(root, "SELECT count(*) FROM heads WHERE source = ?", SOURCE) > 0);

      expect(await verb("pause", [`import:${SOURCE}`, "--reason", "a test"])).toEqual({ paused: `import:${SOURCE}`, by: "terminal" });
      expect(job(root, "import", SOURCE)).toEqual({ state: "queued", attempts: 0, requeue: 0 });
      expect(readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE source = ?").pluck().get(SOURCE))).toBe("importing");
      await status("stopped");
      const heads = count(root, "SELECT count(*) FROM heads WHERE source = ?", SOURCE);
      await anotherJobRan(root, verb);
      expect(count(root, "SELECT count(*) FROM heads WHERE source = ?", SOURCE)).toBe(heads);

      rmSync(`${hold}.held`);
      await verb("resume", [`import:${SOURCE}`]);
      await until("the resumed import holds at the same row", () => existsSync(`${hold}.held`));
      expect(count(root, "SELECT count(*) FROM heads WHERE source = ?", SOURCE)).toBeLessThan(5_000);
      rmSync(hold);
      await until("the delivery imported", () => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE source = ?").pluck().get(SOURCE)) === "imported");
      expect(count(root, "SELECT run FROM deliveries WHERE source = ?", SOURCE)).toBe(run);
      expect(count(root, "SELECT count(*) FROM heads WHERE source = ?", SOURCE)).toBe(5_000);
      expect(count(root, "SELECT count(*) FROM statements WHERE source = ?", SOURCE)).toBe(5_000);
      await status("imported");
    } finally {
      await home.stop();
      rmSync(hold, { force: true });
      artifact(root, "pausing-import", steps);
    }
  });

  it("gives back a stopped send's asks, which are sent once it is resumed", async () => {
    const hold = join(tmpdir(), `lifestream-pausing-send-${process.pid}`);
    const { root, home, verb, status, steps } = await open("lifestream-pausing-send-", { sources: { [SOURCE]: "fake-rows" }, fake: { unavailable: "a synthetic outage" } });
    try {
      const at = Date.now() - 10 * MINUTE;
      await ship(root, { source: SOURCE, fetched_ms: at + 1_000, rows: [note("n1", "a note with a photo", at, { photo: true, plan_hold: hold })] });
      await until("the caption owed", () => count(root, "SELECT count(*) FROM asks WHERE item = 'photo:n1' AND state = 'pending'") === 1
        && count(root, "SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')") === 0);
      writeFileSync(hold, "");
      await verb("settings", ["set", "model.transports.fake", JSON.stringify({ delay_ms: 100, models: [FAKE_OFFER] })]);
      await until("the send holds", () => existsSync(`${hold}.held`));
      expect(job(root, "send", "notes")?.state).toBe("running");

      await verb("pause", ["send:notes", "--reason", "a test"]);
      expect(job(root, "send", "notes")).toEqual({ state: "queued", attempts: 0, requeue: 0 });
      rmSync(hold);
      await status("stopped");

      await verb("resume", ["send:notes"]);
      await until("the caption sent and answered", () => count(root, "SELECT count(*) FROM enrichments WHERE item = 'photo:n1' AND state = 'done'") === 1);
      expect(readLedger(root, (db) => db.prepare("SELECT count(*) FROM attempts WHERE state = 'replied'").pluck().get())).toBe(1);
      await status("sent");
    } finally {
      await home.stop();
      rmSync(hold, { force: true });
      artifact(root, "pausing-send", steps);
    }
  });

  it("ends a stopped labeler's engine, and every engine when the home stops", async () => {
    const pid = join(tmpdir(), `lifestream-pausing-label-${process.pid}`);
    rmSync(pid, { force: true });
    const labels = "audio:local:labels";
    const fetched = Date.now();
    const clock = standingClock(fetched);
    const { root, home, verb, status, steps } = await open("lifestream-pausing-label-", { sources: { [labels]: "fake-rows" }, settings: { "connectors.fake-label": { pid } } }, undefined, clock.now);
    try {
      await until("the engine runs", () => existsSync(pid));
      clock.run();
      const first = pidIn(pid);
      expect(alive(first)).toBe(true);

      await verb("pause", ["label:fake-label", "--reason", "a test"]);
      expect(job(root, "label", "fake-label")).toEqual({ state: "queued", attempts: 0, requeue: 0 });
      await until("the engine is gone", () => !alive(first));
      await until("the stopped helper ended", () => home.stats().helpers.ending === 0);
      await sealDespiteStop(root, labels, "fake-label", fetched);
      await anotherJobRan(root, verb);
      expect([delivered(root, labels), voided(root, labels)]).toEqual([0, 1]);
      await status("stopped");

      rmSync(pid);
      await verb("resume", ["label:fake-label"]);
      await until("the engine runs again", () => existsSync(pid));
      const second = pidIn(pid);
      expect(alive(second)).toBe(true);
      await home.stop();
      await until("the home's stop ended it", () => !alive(second));
    } finally {
      await home.stop();
      artifact(root, "pausing-label", steps);
      rmSync(pid, { force: true });
    }
  });

  it("pauses fixed targets with an invalid connector setting, and refuses a second resume", async () => {
    const root = makeRoot("lifestream-pausing-invalid-", { sources: {}, settings: { "connectors.gmail": { account: 10000001 } } });
    roots.push(root);
    const lines: string[] = [];
    expect(await runCli(["run", "poll", "gmail-imap", "--root", root], { write: (text) => lines.push(text) })).toBe(1);
    expect(lines.at(-1)).toContain("no poll job gmail-imap");
    for (const target of ["home", "kind:poll", "render:days"]) {
      expect(await runCli(["pause", target, "--reason", "a test", "--root", root], { write: (text) => lines.push(text) })).toBe(0);
      expect(await runCli(["resume", target, "--root", root], { write: (text) => lines.push(text) })).toBe(0);
      expect(await runCli(["resume", target, "--root", root], { write: (text) => lines.push(text) })).toBe(1);
      expect(lines.at(-1)).toContain(`no pause stands on ${target}`);
    }
    artifact(root, "pausing-invalid", lines);
  });

  it("holds a job a pause written with no home running names, from the start", async () => {
    const root = makeRoot("lifestream-pausing-cold-", {
      sources: { "apple-notes:local:poll": "fake-rows", "apple-notes:local:poll-two": "fake-rows" },
      clocks: true, settings: { "connectors.fake-poll": { refresh: "1s" }, "connectors.fake-poll-two": { refresh: "1s" } },
    });
    roots.push(root);
    const lines: string[] = [];
    expect(await runCli(["pause", "import:apple-notes:local:poll", "--reason", "written cold", "--root", root], { write: (text) => lines.push(text) })).toBe(0);
    expect(lines.join("")).toContain('{"paused":"import:apple-notes:local:poll","by":"terminal"}');
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    try {
      const heads = (source: string) => count(root, "SELECT count(*) FROM heads WHERE source = ?", source);
      await until("both poll, and the free source imports", () => heads("apple-notes:local:poll-two") >= 3 && delivered(root, "apple-notes:local:poll") >= 3);
      expect(heads("apple-notes:local:poll")).toBe(0);
      artifact(root, "pausing-cold", { heads: { held: heads("apple-notes:local:poll"), free: heads("apple-notes:local:poll-two") } });
    } finally {
      await home.stop();
    }
  });
});

describe("what the home no longer runs", () => {
  it("is forgotten at the next start: its jobs, its poll's row and need, its pauses; what the home runs keeps its pauses, and every reader says what they hold", async () => {
    const root = makeRoot("lifestream-forgetting-", {
      sources: { "apple-notes:local:poll": "fake-rows", "apple-notes:local:poll-two": "fake-rows" }, clocks: true,
      settings: { "connectors.fake-poll": { refresh: "1h", needs_first: true }, "connectors.fake-poll-two": { refresh: "1h" }, "connectors.fake-label": { pid: join(tmpdir(), `lifestream-forgetting-${process.pid}`) } },
    });
    const pid = join(tmpdir(), `lifestream-forgetting-${process.pid}`);
    rmSync(pid, { force: true });
    roots.push(root);
    const steps: Record<string, unknown> = {};
    const polls = () => readHome(root, (db) => db.prepare("SELECT acquirer FROM polls ORDER BY acquirer").pluck().all()) as string[];
    const controls = () => readHome(root, (db) => db.prepare("SELECT target FROM controls ORDER BY target").pluck().all()) as string[];
    let home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    try {
      await until("fake-poll waits on the person", () => count(root, "SELECT count(*) FROM attempts WHERE target = 'fetch:fake-poll' AND outcome = 'need'") === 1);
      await until("the labeler's engine runs", () => existsSync(pid));
      const sock = testSocket(root);
      for (const target of ["poll:fake-poll", "poll:fake-poll-two", "label:fake-label", "kind:poll"]) await askHome(sock, "pause", [target, "--reason", "a test"]);
      await askHome(sock, "run", ["poll", "fake-poll"]);
      steps.before = { polls: polls(), controls: controls() };
    } finally {
      await home.stop();
    }
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => {
      const label = tx.tables.jobs.get("label", "fake-label")!;
      for (let tries = 0; tries < 5; tries++) tx.tables.jobs.fail(label.id, "a synthetic engine fault", 0);
      tx.tables.jobs.enqueue({ kind: "extract", key: "removed-family", lane: 5, not_before_ms: 0, now_ms: 0 });
      tx.tables.cursors.move("rebuild:removed-family", { seq: 42, at_ms: 0 });
      tx.tables.meta.set("walk:removed-family", JSON.stringify({ seq: 1, reread: 0, reads: [], next_ms: 0, aside: [] }));
      tx.derived.next.put({ family: "removed-family", unit: "u1", reading: "r", code: "1", content: {}, start_ms: null, end_ms: null, days: [], seq: 1 });
      tx.tables.polls.put({ acquirer: "old-lane", next_ms: 0 });
      tx.tables.attempts.put({ target: "fetch:old-lane", source: "", outcome: "fail", reason: "failing", facts: {}, detail: "no acquirer is named old-lane", since_ms: 0, at_ms: 0, contact_ms: null, fails: 1 });
    });
    db.close();
    expect(readHome(root, (read) => read.prepare("SELECT state FROM jobs WHERE kind = 'label'").pluck().get())).toBe("dead");
    editSettings(root, { "connectors.fake-poll": null, "connectors.fake-label": null });

    home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    let door: Awaited<ReturnType<typeof serveDoor>> | undefined;
    try {
      const start = readHome(root, (read) => JSON.parse(read.prepare("SELECT detail FROM events WHERE kind = 'home' AND key = 'start' ORDER BY seq DESC LIMIT 1").pluck().get() as string)) as { forgot: string[] };
      expect(count(root, "SELECT count(*) FROM cursors WHERE name = 'rebuild:removed-family' AND seq > 0")).toBe(0);
      expect(count(root, "SELECT count(*) FROM meta WHERE key = 'walk:removed-family'") + count(root, "SELECT count(*) FROM extracts_next WHERE family = 'removed-family'")).toBe(0);
      expect(start.forgot.sort()).toEqual(["extract removed-family", "label fake-label", "pause label:fake-label", "pause poll:fake-poll", "poll fake-poll", "poll old-lane", "rebuild removed-family"]);
      const running = ["fake-poll-two"];
      expect(polls()).toEqual(running);
      expect(count(root, "SELECT count(*) FROM jobs WHERE key IN ('fake-poll', 'fake-label') AND state <> 'done'")).toBe(0);
      expect(count(root, "SELECT count(*) FROM attempts WHERE target = 'fetch:fake-poll' AND outcome = 'need'")).toBe(0);
      expect(controls()).toEqual(["kind:poll", "poll:fake-poll-two"]);
      expect(count(root, "SELECT count(*) FROM attempts WHERE target = 'fetch:old-lane'")).toBe(0);

      const token = "synthetic-reader-token".padEnd(43, "x");
      mintPrincipal(openHomeFolder(root), { unit: "reader", scopes: ["read"], token, now_ms: 0 });
      door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: FAKES });
      const report = statusOf(root) as Status & { paused: Pause[] };
      const named = (needs: Status["needs"]) => needs.filter((need) => /fake-poll\b|old-lane|fake-label|no acquirer/u.test(need.words));
      expect(named(report.needs)).toEqual([]);
      const paused: Pause[] = [
        { target: "kind:poll", reason: "a test", at_ms: expect.any(Number) as number, by: "terminal", holds: running },
        { target: "poll:fake-poll-two", reason: "a test", at_ms: expect.any(Number) as number, by: "terminal" },
      ];
      expect(report.paused).toEqual(paused);
      const served = await (await fetch(`http://127.0.0.1:${door.port}/v1/status`, { headers: { authorization: `Bearer ${token}` } })).json() as Status & { paused: Pause[] };
      expect(served.needs.map((need) => need.id)).toEqual(report.needs.map((need) => need.id).filter((id) => id !== "door"));
      expect(served.paused).toEqual(report.paused);
      const window = streamsOf(root) as unknown as { paused: (Omit<Pause, "holds"> & { holds: string[] | null; title: string; line: string })[] };
      expect(window.paused.map(({ title: _title, line: _line, holds, ...pause }) => ({ ...pause, ...(holds === null ? {} : { holds }) }))).toEqual(report.paused);
      expect(window.paused.map((pause) => pause.title)).toEqual(["Paused: every account", "Paused: poll:fake-poll-two"]);
      steps.after = { forgot: start.forgot, polls: polls(), controls: controls(), paused: report.paused, needs: report.needs };
    } finally {
      await door?.close();
      await home.stop();
      rmSync(pid, { force: true });
      artifact(root, "forgetting", steps);
    }
  });

  it("polls a connector whose block sets no refresh at its declaration's, hourly from its first poll", async () => {
    const { root, home } = await open("lifestream-forgetting-refresh-", {
      sources: { "apple-notes:local:poll": "fake-rows" }, clocks: true, settings: { "connectors.fake-poll": {} },
    });
    try {
      await until("fake-poll delivers", () => delivered(root, "apple-notes:local:poll") === 1);
      const row = readHome(root, (db) => db.prepare("SELECT next_ms, at_ms FROM polls JOIN attempts ON target = 'fetch:' || acquirer WHERE acquirer = 'fake-poll' AND outcome = 'ok'").get()) as { next_ms: number; at_ms: number };
      expect(row.next_ms - row.at_ms).toBe(HOUR);
      artifact(root, "forgetting-refresh", row);
    } finally {
      await home.stop();
    }
  });
});

describe("pausing a runner's calls", () => {
  const UNIT = "runner-macbook-pro-0001";
  const OTHER = "runner-mac-mini-bb17";
  const listing = (root: string, units: string[]) => {
    const db = openHome(openHomeFolder(root), "migrate");
    try {
      const runners = units.map((unit) => ({ unit, name: "MacBook Pro", present: false, power: null, memory_gb: 16, files: [], below: null }));
      db.commit((tx) => tx.tables.meta.set(MODELS_META, JSON.stringify({ routes: [], runners, connections: {} } satisfies StoredModels)));
    } finally {
      db.close();
    }
  };
  const paired = (root: string, unit: string) => mintPrincipal(openHomeFolder(root), { unit, scopes: ["run"], kind: "runner", now_ms: 0 }).principal;
  const cli = async (root: string, args: string[]) => {
    const lines: string[] = [];
    const code = await runCli([...args, "--root", root], { write: (text) => lines.push(text) });
    return { code, said: lines.join("") };
  };
  const controls = (root: string) => readHome(root, (db) => db.prepare("SELECT target, by, reason FROM controls ORDER BY target").all());

  it("at the terminal: pause runner:<unit> writes the pause, its reason required; a runner with no pass is refused though the door lists it, never read as a job kind; resume lifts it once; models runner is the same row", async () => {
    const root = makeRoot("lifestream-pausing-runner-cli-", { sources: {} });
    roots.push(root);
    listing(root, [UNIT, OTHER]);
    paired(root, UNIT);
    const steps: Record<string, unknown> = {};
    expect(Object.hasOwn(KINDS, "runner")).toBe(false);
    const gone = await cli(root, ["pause", `runner:${OTHER}`, "--reason", "a test"]);
    expect([gone.code, gone.said]).toEqual([1, expect.stringContaining(`the door holds no runner ${OTHER}; it holds ${UNIT}`)]);
    expect(gone.said).not.toContain("no job kind");
    expect((await cli(root, ["pause", `runner:${UNIT}`])).said).toContain("--reason is required");
    const paused = await cli(root, ["pause", `runner:${UNIT}`, "--reason", "the laptop is busy"]);
    expect([paused.code, paused.said]).toEqual([0, `{"paused":"runner:${UNIT}","by":"terminal"}\n`]);
    expect(controls(root)).toEqual([{ target: `runner:${UNIT}`, by: "terminal", reason: "the laptop is busy" }]);
    steps.paused = controls(root);
    const resumed = await cli(root, ["resume", `runner:${UNIT}`]);
    expect([resumed.code, controls(root)]).toEqual([0, []]);
    expect((await cli(root, ["resume", `runner:${UNIT}`])).said).toContain(`no pause stands on runner:${UNIT}`);

    expect((await cli(root, ["models", "runner", UNIT, "pause"])).said).toContain("a pause from the terminal states why: --reason <words>");
    expect((await cli(root, ["models", "runner", OTHER, "pause", "--reason", "a test"])).said).toContain("That runner isn't connected.");
    for (const act of [["runner", UNIT, "resume"], ["default", "audio", "none"], []]) {
      expect((await cli(root, ["models", ...act, "--reason", "a test"])).said).toContain("--reason states why a runner's calls pause");
    }
    const pressed = await cli(root, ["models", "runner", UNIT, "pause", "--reason", "the laptop is busy", "--json"]);
    expect(pressed.code).toBe(0);
    expect(controls(root)).toEqual([{ target: `runner:${UNIT}`, by: "terminal", reason: "the laptop is busy" }]);
    const runner = runnerOf(modelsPageOf(root), UNIT);
    expect([runner.line, runner.paused]).toEqual(["MacBook Pro's runner is not running", true]);
    for (let press = 0; press < 2; press++) expect((await cli(root, ["models", "runner", UNIT, "resume"])).code).toBe(0);
    expect(controls(root)).toEqual([]);
    artifact(root, "pausing-runner-cli", steps);
  });

  it("from Settings: the press writes the row by you, the door's models read says who and since when, status lists it", async () => {
    const { root, home, verb, steps } = await open("lifestream-pausing-runner-home-", { sources: {} }, (at) => listing(at, [UNIT]));
    const sock = testSocket(root);
    const press = async (to: "pause" | "resume") => {
      await ask(sock, { verb: "models", args: ["--", "runner", UNIT, to], by: "you" });
      return runnerOf(modelsPageOf(root), UNIT);
    };
    const token = "synthetic-reader-token".padEnd(43, "x");
    mintPrincipal(openHomeFolder(root), { unit: "reader", scopes: ["read"], token, now_ms: 0 });
    const door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: FAKES });
    try {
      const answered = await press("pause");
      expect(controls(root)).toEqual([{ target: `runner:${UNIT}`, by: "you", reason: "" }]);
      expect(answered.paused).toBe(true);
      const served = await (await fetch(`http://127.0.0.1:${door.port}/v1/page/models`, { headers: { authorization: `Bearer ${token}` } })).json() as ModelsPage;
      const runners = served.connections.flatMap((each) => each.kind === "runner" ? [[each.id, each.paused, each.line]] : []);
      expect(runners).toEqual([[`runner:${UNIT}`, true, answered.line]]);
      const status = statusOf(root) as { paused: Pause[] };
      expect(status.paused).toEqual([{ target: `runner:${UNIT}`, by: "you", reason: "", at_ms: expect.any(Number) as number }]);
      steps.paused = { controls: controls(root), read: runners, status: status.paused };
      expect((await press("resume")).paused).toBe(false);
      expect((await press("resume")).paused).toBe(false);
      expect(controls(root)).toEqual([]);
    } finally {
      await door.close();
      await home.stop();
      artifact(root, "pausing-runner-home", steps);
    }
  });

  it("across starts, by the runner's pass: a paired runner the door has not heard since it started is paused and its pause outlives the door's and the home's restarts; its pass revoked, the next start forgets it and a new pause is refused", async () => {
    const root = makeRoot("lifestream-pausing-runner-start-", { sources: {} });
    roots.push(root);
    const pass = paired(root, OTHER);
    let door = await doorHere(root);
    let home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    const verb = (name: string, args: string[]) => askHome(testSocket(root), name, args);
    const stored = () => readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(MODELS_META) as string | undefined);
    const started = () => readHome(root, (read) => JSON.parse(read.prepare("SELECT detail FROM events WHERE kind = 'home' AND key = 'start' ORDER BY seq DESC LIMIT 1").pluck().get() as string)) as { forgot: string[] };
    const steps: Record<string, unknown> = {};
    try {
      await until("the home stores the models read from the door's listing", () => stored() !== undefined);
      expect((JSON.parse(stored()!) as StoredModels).runners.map((runner) => runner.unit)).not.toContain(OTHER);
      expect(await verb("pause", [`runner:${OTHER}`, "--reason", "the mini is busy"])).toEqual({ paused: `runner:${OTHER}`, by: "terminal" });

      await door.stop();
      door = await doorHere(root);
      await home.stop();
      home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
      expect([started().forgot, controls(root)]).toEqual([[], [{ target: `runner:${OTHER}`, by: "terminal", reason: "the mini is busy" }]]);
      steps.kept = controls(root);

      await verb("principals", ["revoke", pass.id]);
      await home.stop();
      home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
      expect([started().forgot, controls(root)]).toEqual([[`pause runner:${OTHER}`], []]);
      await expect(verb("pause", [`runner:${OTHER}`, "--reason", "a test"])).rejects.toThrow(`the door holds no runner ${OTHER}`);
      steps.forgot = started().forgot;
    } finally {
      await door.stop();
      await home.stop();
      artifact(root, "pausing-runner-start", steps);
    }
  });
});
