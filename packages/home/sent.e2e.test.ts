import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openHomeFolder, readTables, type JsonObject } from "@lifestreamprotocol/core";
import { readPrivacySettings } from "@lifestreamprotocol/privacy";
import { startHome, type Home } from "./home.js";
import { machine } from "./machine.js";
import { MODELS_META } from "./models.js";
import { peopleFileOf } from "./people.js";
import { PEOPLE, writePrepared } from "./prepared.js";
import { readProcessing } from "./processing.js";
import { report } from "./report.js";
import { effective } from "./settings.js";
import { askHome } from "./socket.js";
import { renderStatus, SHARE_LINE } from "./status.js";
import { artifact, FAKE_OFFER, FAKE_ROUTE, FAKES, makeRoot, readHome, readLedger, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { statusOf } from "./test/harness-status.js";
import fakeRegistry, { fakeDeclarations } from "./test/fakes.js";
import { readOpsSettings } from "./verbs/context.js";
import { homeOf } from "./registry.js";
import { testSocket } from "./test/folder.js";

const SOURCE = "apple-notes:local:device-a";
const RECEIVER = "Example Cloud";
const D1 = Date.UTC(2026, 5, 1, 12, 0);
const DAY = 86_400_000;
const DETAILS = ["Ada", "person-a@example.com", "+15550000001", "15550000001"];
const NAMES = {
  owner: null,
  people: [{ who: "p-ada", is: "human", shown: "Ada Example", names: ["Ada Example", "Ada"], accounts: ["person-a@example.com", "+15550000001"] }],
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) removeRoot(root);
});

const count = (root: string, sql: string, ...params: unknown[]): number => readHome(root, (db) => db.prepare(sql).pluck().get(...params) as number);
const quiet = (root: string): boolean => count(root, "SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')") === 0;
const note = (key: string, n: number, text: string) => ({ kind: "note", key, content: { text, at: D1 + n * DAY, photo: true }, at: D1 + n * DAY });
const answered = (root: string): Record<string, string> => Object.fromEntries((readHome(root, (db) => db.prepare("SELECT item, content FROM enrichments WHERE family = 'notes' AND state = 'done'").all()) as { item: string; content: string }[])
  .map((row) => [row.item, JSON.parse(row.content) as string]));

function writeNames(root: string, machineDir: string): void {
  writePrepared(openHomeFolder(root), peopleFileOf(root, machineDir), PEOPLE, { rows: new Map([["names", new Map([["table", NAMES as unknown as JsonObject]])]]), position: "names-1" });
}

describe("a request whose route leaves the machine", () => {
  it("is sent hidden under its work's level, never as it is: no detail a level hides reaches the receiver, the reply comes back restored, and each send has its ask row", async () => {
    const root = makeRoot("lifestream-sent-", {
      sources: { [SOURCE]: "fake-rows" }, cap: 4,
      fake: { models: [FAKE_OFFER], leaves: RECEIVER },
    });
    roots.push(root);
    const log = join(root, "received.jsonl");
    const verb = (name: string, args: string[]) => askHome(testSocket(root), name, args);
    const setFake = (more: JsonObject) => verb("settings", ["set", "model.transports.fake", JSON.stringify({ delay_ms: 100, models: [FAKE_OFFER], leaves: RECEIVER, log, ...more })]);
    const received = (): { input: string }[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { input: string }) : []);
    const rows = () => (readLedger(root, (db) => db.prepare("SELECT receiver, route, what, level, counts, key, attempt FROM outbound ORDER BY seq").all()) as
      { receiver: string; route: string; what: string; level: string; counts: string; key: string | null; attempt: number | null }[]).map((row) => ({ ...row, counts: JSON.parse(row.counts) as JsonObject }));
    const home: Home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    try {
      await setFake({ reply: "[[Person 1]] in the photo." });
      await until("the home's models stored", () => readHome(root, (db) => db.prepare("SELECT 1 FROM meta WHERE key = ?").get(MODELS_META)) !== undefined);
      await until("People's first run done", () => quiet(root));
      writeNames(root, machine().dir);

      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("n1", 0, "lunch with Ada Example, write to person-a@example.com or call +15550000001")] });
      await until("the first caption answered", () => quiet(root) && answered(root)["photo:n1"] !== undefined);
      expect(received()).toHaveLength(1);
      expect(received()[0]!.input).toContain("lunch with [[Person 1]], write to [[Email 1]] or call [[Phone 1]]");
      for (const detail of DETAILS) expect(JSON.stringify(received())).not.toContain(detail);
      expect(answered(root)["photo:n1"]).toBe("Ada Example in the photo.");
      expect(rows()).toEqual([{ receiver: RECEIVER, route: FAKE_ROUTE, what: "ask", level: "all", counts: { email: 1, person: 1, phone: 1 }, key: expect.any(String), attempt: expect.any(Number) }]);

      await expect(verb("connectors", ["set", "fake-poll", "privacy.photos", "everything"])).rejects.toThrow(/privacy\.photos/u);
      await verb("connectors", ["set", "fake-poll", "privacy.photos", "names"]);
      await setFake({ reply: "Ada Example by the sea." });
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("n2", 1, "a walk with Ada Example, write to person-a@example.com")] });
      await until("the second caption answered", () => quiet(root) && answered(root)["photo:n2"] !== undefined);
      expect(received()[1]!.input).toContain("a walk with Ada Example, write to [[Email 1]]");
      expect(received()[1]!.input).not.toContain("person-a@example.com");
      expect(rows()[1]).toMatchObject({ level: "names", counts: { email: 1 } });
      expect(count(root, "SELECT count(*) FROM runs WHERE kind = 'poll'")).toBe(0);

      await verb("connectors", ["set", "fake-poll", "privacy.photos", "none"]);
      await setFake({ reply: "A swim." });
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("n3", 2, "a swim with Ada Example, call +15550000001")] });
      await until("the third caption answered", () => quiet(root) && answered(root)["photo:n3"] !== undefined);
      expect(received()[2]!.input).toContain("a swim with Ada Example, call +15550000001");
      expect(rows()[2]).toMatchObject({ level: "none", counts: {} });

      await verb("connectors", ["set", "fake-poll", "privacy.photos", "all"]);
      await setFake({ reply: "[[Person 4]] waves." });
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("n4", 3, "a wave from Ada Example")] });
      await until("the fourth caption refused", () => quiet(root) && count(root, "SELECT count(*) FROM asks WHERE item = 'photo:n4' AND state = 'pending'") === 1
        && (readLedger(root, (db) => db.prepare("SELECT count(*) FROM replies WHERE validation = 'refused'").pluck().get() as number) ?? 0) >= 1);
      expect(answered(root)["photo:n4"]).toBeUndefined();
      for (const detail of DETAILS) expect(JSON.stringify(received())).not.toMatch(new RegExp(`"input":"[^"]*wave[^"]*${detail.replace(/[+.]/gu, "\\$&")}`, "u"));

      const { settings } = effective(root);
      const processing = readHome(root, (db) => readProcessing(readTables(db), null, {
        connectors: fakeDeclarations(), families: fakeRegistry(settings, homeOf(openHomeFolder(root))).families, histories: new Map(), blocks: settings.connectors, defaults: settings.defaults, runners: settings.runners,
        day: settings.day, now_ms: Date.now(), privacy: settings.privacy, home: settings.unit,
      })).get("fake-poll")!;
      const row = processing.part.rows.find((each) => each.member === "llm.photos")!;
      expect(row.privacy).toMatchObject({ member: "privacy.photos", value: "all", words: "Personal details hidden" });
      expect(row.privacy).not.toHaveProperty("found");
      expect(row.privacy!.steps.map((step) => step.value)).toEqual(["default", "all", "names", "none"]);
      artifact(root, "sent-leak", { received: received(), outbound: rows(), row });
    } finally {
      await home.stop();
    }
  });

  it("waits, sending nothing, while its work's hiding is not ready, and its row says why", async () => {
    const root = makeRoot("lifestream-sent-waits-", {
      sources: { [SOURCE]: "fake-rows" }, cap: 4, fake: { models: [FAKE_OFFER], leaves: RECEIVER, reply: "A caption." },
    });
    roots.push(root);
    const home: Home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    try {
      await until("the home's models stored", () => readHome(root, (db) => db.prepare("SELECT 1 FROM meta WHERE key = ?").get(MODELS_META)) !== undefined);
      await until("People's first run done", () => quiet(root));
      writePrepared(openHomeFolder(root), peopleFileOf(root, machine().dir), PEOPLE, { rows: new Map([["names", new Map()]]), position: "none" });
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [note("w1", 0, "tea with Ada Example")] });
      const ticks = home.stats().ticks.count;
      await until("three ticks with the ask owed", () => home.stats().ticks.count > ticks + 3 && quiet(root));
      expect(readLedger(root, (db) => db.prepare("SELECT count(*) FROM requests").pluck().get() as number)).toBe(0);
      const work = statusOf(root, { now_ms: Date.now(), settings: readOpsSettings(root) }).works.find((each) => each.member === "llm.photos");
      expect(work).toMatchObject({ shape: "waiting", line: expect.stringMatching(/People|names/u) });
    } finally {
      await home.stop();
    }
  });
});

describe("lifestream report and lifestream status", () => {
  it("the report states no detail any table holds, passed through the one function; status's last line names what to send", async () => {
    const root = makeRoot("lifestream-sent-report-", { sources: { [SOURCE]: "fake-rows" } });
    roots.push(root);
    const machineDir = join(root, "machine");
    writeNames(root, machineDir);
    const doorLog = join(root, "door.log");
    const at = new Date(D1).toISOString();
    writeFileSync(doorLog, [
      { at, method: "GET", path: "/v1/person-a@example.com/days", status: 404, milliseconds: 3, code: "Ada Example" },
      { at, method: "GET", path: "/v1/+15550000001", status: 200, milliseconds: 2 },
      { at, method: "GET", path: "/v1/person-a@example.com", status: 200, milliseconds: 4 },
      { at, method: "GET", path: "/v1/Person-A@Example.com", status: 200, milliseconds: 5 },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
    const reported = await report(openHomeFolder(root), { from_ms: D1 - DAY, to_ms: D1 + DAY, door_log: doorLog, machine: machineDir });
    const text = JSON.stringify(reported);
    for (const detail of DETAILS) expect(text).not.toContain(detail);
    expect(text).toContain("[[Email 1]]");
    expect(reported.reads.routes).toMatchObject({ "GET /v1/[[Phone 1]]": { requests: 1 } });
    const addressed = Object.entries(reported.reads.routes).filter(([name]) => name.startsWith("GET /v1/[[Email 1]]") && !name.includes("/*"));
    expect(addressed.map(([name, route]) => [name, route.requests])).toEqual([["GET /v1/[[Email 1]]", 1], ["GET /v1/[[Email 1]] (2)", 1]]);
    const status = renderStatus(statusOf(root, { now_ms: D1, settings: { ...readOpsSettings(root), privacy: readPrivacySettings({}) } }), { zone: "UTC", day_start_hour: 4 });
    expect(status.trimEnd().split("\n").at(-1)).toBe(SHARE_LINE);
  });
});
