import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { emptyTable, openHome, openHomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import { declarations, vendorOf } from "@lifestreamprotocol/connect";
import type { NameTable } from "@lifestreamprotocol/privacy";
import { driveHalf, openDetector } from "../packages/home/detector.js";
import { peopleFileOf } from "../packages/home/people.js";
import { PEOPLE, writePrepared } from "../packages/home/prepared.js";
import { checkoutProgram } from "../packages/home/programs.js";
import { until } from "../packages/home/test/harness-root.js";
import { doorHere } from "../packages/home/test/harness-door.js";
import { editSettings } from "../packages/home/test/folder.js";
import { makeHome, NOW_MS, REPO } from "../packages/home/test/support.js";
import { fakeDetector } from "../packages/privacy/test/fake-detector.js";
import { bench, hiddenSpans, NOT_USED, itemOf, readTruths, render, type BenchInput, type Measured, type TruthItem } from "./privacy-bench.js";

const KEEP = process.env.LIFESTREAM_KEEP_ARTIFACTS === "1";
const ROOT = mkdtempSync(join(tmpdir(), "privacy-bench-test-"));
afterAll(() => {
  if (KEEP) process.stdout.write(`privacy-bench artifacts: ${ROOT}\n`);
  else rmSync(ROOT, { recursive: true, force: true });
});

const RUNNER = "runner-macbook-pro-0001";
const NOTES = "apple-notes:local:device-a";

const NAMES: NameTable = {
  version: "names-1", owner: null, people: [
    { who: "person:ada", is: "human", shown: "Ada Example", names: ["Ada Example", "Ada", "Example"], accounts: ["+15550000142"] },
    { who: "person:will", is: "human", shown: "Will Example", names: ["Will Example", "Will", "Example"], accounts: [] },
    { who: "person:raj", is: "human", shown: "Raj Example", names: ["Raj Example", "Raj", "Example"], accounts: [] },
  ],
};

const RECORDS: Record<string, { title?: string; text: string }> = {
  "note-1": { title: "Lunch with Ada Example", text: "Call Ada Example 555 000 0142 or write to person-a@example.com about Monday." },
  "note-2": { text: "Zed Sample will call Raj. I will be late, says [[Person 2]]." },
  "note-3": { text: "Unspellable passage that names Ada Example." },
};

const TRUTHS: TruthItem[] = [
  { source: NOTES, kind: "note", key: "note-1", details: [{ type: "person", text: "Ada Example" }, { type: "phone", text: "555 000 0142" }, { type: "email", text: "person-a@example.com" }] },
  { source: NOTES, kind: "note", key: "note-2", details: [{ type: "person", text: "Zed Sample" }, { type: "person", text: "Raj" }] },
  { source: NOTES, kind: "note", key: "note-3", details: [{ type: "person", text: "Ada Example" }] },
];

const WORDS = { "Zed Sample": "person", Monday: "person" } as const;
const UNREAD = "Unspellable";

const items = () => TRUTHS.map((truth, index) => itemOf(truth, RECORDS[truth.key]!, index + 1));
const loose = { name: "loose", plain: (word: string) => ["call", "late"].includes(word) };
const strict = { name: "strict", plain: (word: string) => ["will", "raj", "call", "late"].includes(word) };

function scratch(): string {
  const folder = mkdtempSync(join(ROOT, "scratch-"));
  onTestFinished(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}

function measured(report: Awaited<ReturnType<typeof bench>>, choice: string): Measured {
  const row = report.choices.find((each) => each.choice === choice)!;
  if (!("items" in row)) throw new Error(`${choice} was not measured: ${row.why}`);
  return row;
}

describe("the bench's measures", () => {
  it("reads back where each placeholder stands: two details one space apart whole, two with nothing between, a placeholder over a weekday", () => {
    const table = { ...emptyTable("t"), entries: [
      { placeholder: "[[Person 1]]", type: "person" as const, detail: "Ada Example", who: "person:ada", shown: "Ada Example" },
      { placeholder: "[[Phone 1]]", type: "phone" as const, detail: "555 000 0142", who: "person:ada" },
      { placeholder: "[[Person 2]]", type: "person" as const, detail: "Bo" },
    ] };
    expect(hiddenSpans("Call Ada Example 555 000 0142 now", "Call [[Person 1]] [[Phone 1]] now", table))
      .toEqual([{ start: 5, end: 16, type: "person" }, { start: 17, end: 29, type: "phone" }]);
    expect(hiddenSpans("AdaBo", "[[Person 1]][[Person 2]]", { ...table, entries: [{ ...table.entries[0]!, detail: "Ada", shown: "Ada" }, table.entries[2]!] }))
      .toEqual([{ start: 0, end: 3, type: "person" }, { start: 3, end: 5, type: "person" }]);
    expect(hiddenSpans("Left [[Person 2]] as written.", "Left [[Person 2]] as written.", table)).toEqual([]);
    expect(() => hiddenSpans("Call Ada now", "Ring [[Person 1]] now", table)).toThrow(/not its original/u);
  });

  it("measures each choice: nothing under Don't hide, the rules alone with an empty name table, the names and the detector with a hiding model; a wrong hide by type; a text the detector cannot read apart", async () => {
    const detector = fakeDetector(WORDS);
    detector.unread(UNREAD);
    const input: BenchInput = { items: items(), names: NAMES, detector: { detector }, lists: [loose, strict], scratch: scratch() };
    const report = await bench(input);

    expect(measured(report, "Don't hide")).toMatchObject({ items: 3, cannot: 0, found: { found: 0, of: 7 }, wrong: 0 });
    const known = measured(report, "Hide what the home knows");
    expect(known).toMatchObject({ found: { found: 3, of: 7 }, wrong: 1, wrongTypes: { word: 1 }, cannot: 0 });
    expect(known.types).toEqual({ person: { found: 1, of: 5 }, phone: { found: 1, of: 1 }, email: { found: 1, of: 1 } });
    const model = measured(report, "Hide with a hiding model");
    expect(model).toMatchObject({ found: { found: 6, of: 6 }, wrong: 2, wrongTypes: { person: 1, word: 1 }, cannot: 1 });
    expect(model.types.person).toEqual({ found: 4, of: 4 });
    expect(model.sources).toEqual({ "apple-notes": { found: 6, of: 6 } });
    expect(model.characters).toBe(Object.values(RECORDS).reduce((sum, record) => sum + (record.title?.length ?? 0) + record.text.length, 0));
    expect(detector.calls.flat().some((passage) => passage.includes("Zed Sample"))).toBe(true);

    expect(report.lists).toEqual([
      { list: "loose", names: 4, kept: [], ordinary: 2, words: ["will"] },
      { list: "strict", names: 4, kept: ["raj", "will"], ordinary: 0, words: [] },
    ]);

    const printed = render(report);
    expect(printed).toMatch(/\nHide with a hiding model\s+6 of 6 \(100\.0%\)\s+2\s+\d+\.\d\s+[\d,]+\s+1\n/u);
    expect(printed).toMatch(/\nHide what the home knows\s+3 of 7 \(42\.9%\)\s+1\s+\d+\.\d\s/u);
    expect(printed).toContain("\n  loose: kept 0 of 4; ordinary words marked 2 (will)\n");
    expect(printed).toContain("\n  strict: kept 2 of 4 (raj, will); ordinary words marked 0\n");
  });

  it("counts half a detail hidden as missed, and prints a choice it cannot run as not measured, with why, the others measured", async () => {
    const half = itemOf({ source: NOTES, kind: "note", key: "half", details: [{ type: "person", text: "Zed Sample" }] }, { text: "Zed Sample wrote." }, 1);
    const found = await bench({ items: [half], names: NAMES, detector: { detector: fakeDetector({ Zed: "person" }) }, lists: [], scratch: scratch() });
    expect(measured(found, "Hide with a hiding model")).toMatchObject({ found: { found: 0, of: 1 }, wrong: 0 });

    const absent = await bench({ items: [half], names: NAMES, detector: { why: "no runner named (--detector runner-<unit>)" }, lists: [], scratch: scratch() });
    expect(absent.choices.at(-1)).toEqual({ choice: "Hide with a hiding model", why: "no runner named (--detector runner-<unit>)" });
    expect(measured(absent, "Hide what the home knows").found).toEqual({ found: 0, of: 1 });
    expect(render(absent)).toContain("\nHide with a hiding model    not measured: no runner named (--detector runner-<unit>)\n");

    const other = itemOf({ source: NOTES, kind: "note", key: "other", details: [{ type: "person", text: "Zed Sample" }] }, { text: "Then Zed Sample came." }, 2);
    const lost = fakeDetector({ "Zed Sample": "person" });
    lost.fail();
    const once = await bench({ items: [half, other], names: NAMES, detector: { detector: lost }, lists: [], scratch: scratch() });
    expect(measured(once, "Hide with a hiding model")).toMatchObject({ items: 1, found: { found: 1, of: 1 }, fallbacks: [{ item: 1, why: "the fake detector failed, as scripted" }] });
    expect(measured(once, "Hide what the home knows")).toMatchObject({ items: 2, fallbacks: [] });
    expect(render(once)).toContain("\nHide with a hiding model: the hiding model answered 1 of 2 items; fell back on item 1: the fake detector failed, as scripted\n");
    const away = fakeDetector({});
    away.set({ state: "absent", why: "The hiding model's runner is not heard from." });
    const failed = await bench({ items: [half, other], names: NAMES, detector: { detector: away }, lists: [], scratch: scratch() });
    expect(failed.choices.at(-1)).toEqual({ choice: "Hide with a hiding model", why: NOT_USED });
  });

  it("reads the truths and each item from the record's words: refuses a malformed file or a detail the record does not hold, and counts only the occurrences named", () => {
    const write = (value: unknown) => {
      const file = join(scratch(), "truths.json");
      writeFileSync(file, JSON.stringify(value));
      return file;
    };
    expect(() => readTruths(write({ items: [] }))).toThrow(/holds no items/u);
    expect(() => readTruths(write({ items: [{ source: NOTES, kind: "note", details: [] }] }))).toThrow(/item 1 must state source, kind, key and details/u);
    expect(() => readTruths(write({ items: [{ source: NOTES, kind: "note", key: "k", details: [{ type: "name", text: "Ada" }] }] }))).toThrow(/item 1 detail 1 must state a type of detail/u);
    expect(() => readTruths(write({ items: [{ source: NOTES, kind: "note", key: "k", details: [{ type: "person", text: "Ada", occurrences: [-1] }] }] }))).toThrow(/item 1 detail 1/u);
    expect(readTruths(write({ items: TRUTHS }))).toEqual(TRUTHS);

    const truth: TruthItem = { source: NOTES, kind: "note", key: "rose", details: [{ type: "person", text: "Rose", occurrences: [1] }] };
    expect(itemOf(truth, { title: "A Rose for you", text: "Rose sent it." }, 4)).toEqual({ product: "apple-notes", texts: ["A Rose for you", "Rose sent it."], details: [{ type: "person", text: 1, start: 0, end: 4 }] });
    expect(() => itemOf(truth, null, 4)).toThrow(/item 4: the home gives no words/u);
    expect(() => itemOf(truth, { text: "A tulip." }, 4)).toThrow(/item 4 detail 1 is not in its record's words/u);
    expect(() => itemOf(truth, { text: "Rose." }, 4)).toThrow(/names occurrence 1, and its record's words hold it 1 times/u);
  });
});

function command(args: readonly string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(REPO, "tools", "privacy-bench.ts"), ...args], { cwd: REPO, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    onTestFinished(() => { child.kill(); });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("the bench against a home, through its door", () => {
  it("prints each choice's figures over the home's records, the third's finds placed on the door's line to the runner, and writes nothing of the home's", async () => {
    const home = makeHome({
      reader: { scopes: ["read"] },
      runner: { scopes: ["run"], kind: "runner", unit: RUNNER },
      drive: { scopes: ["drive"], unit: "home" },
      call: { scopes: ["call"], unit: "home" },
      find: { scopes: ["find"], unit: "privacy-bench" },
    }, []);
    onTestFinished(() => rmSync(home.root, { recursive: true, force: true }));
    editSettings(home.root, { [`model.runners.${RUNNER}.files`]: ["privacy-filter"] });
    const db = openHome(openHomeFolder(home.root), "migrate");
    db.commit((tx) => {
      tx.tables.sources.add({ id: NOTES, vendor: vendorOf(declarations(), NOTES), connector: "fake-rows", added_ms: 0 });
      const run = tx.tables.runs.start({ kind: "import", subject: NOTES, started_ms: NOW_MS });
      tx.records.land(run, { id: `${NOTES}/seed`, source: NOTES, stated_ms: NOW_MS },
        Object.entries(RECORDS).map(([key, content]) => ({ kind: "note", key, content })), { note: () => [] }, { has: () => true });
      tx.tables.runs.end(run, { ended_ms: NOW_MS, outcome: "ok" });
    });
    db.close();
    const registry = join(home.root, "notes-registry.mjs");
    writeFileSync(registry, `export default () => ({ connectors: [], readers: [], families: [{ name: "notes", inputs: [{ sources: { product: ["apple-notes"] }, kinds: ["note"] }],
  text: { kinds: ["note"], of: (_ref, version) => ({ ...(version.content.title === undefined ? {} : { title: version.content.title }), text: version.content.text }) } }] });
`);
    const door = await doorHere(home.root, { registry: pathToFileURL(registry) });
    onTestFinished(() => door.stop());

    const machine = mkdtempSync(join(ROOT, "machine-"));
    writePrepared(openHomeFolder(home.root), peopleFileOf(home.root, machine), PEOPLE, { rows: new Map([["names", new Map([["table", { owner: NAMES.owner, people: NAMES.people } as unknown as JsonObject]])]]), position: "1" });

    const dir = mkdtempSync(join(ROOT, "runner-"));
    writeFileSync(join(dir, "door-token"), `${home.tokens.runner}\n`, { mode: 0o600 });
    writeFileSync(join(dir, "script.json"), JSON.stringify({ words: WORDS, unread: UNREAD }));
    const said: string[] = [];
    const runner = spawn(process.execPath, [...checkoutProgram(join(REPO, "packages", "runner", "test", "fake-runner.ts")), "--door", door.url, "--pass", join(dir, "door-token"), "--script", join(dir, "script.json")], { cwd: REPO, stdio: ["ignore", "ignore", "pipe"] });
    runner.stderr!.on("data", (chunk: Buffer) => said.push(chunk.toString("utf8")));
    const exited = new Promise<void>((resolve) => runner.once("exit", () => resolve()));
    onTestFinished(async () => {
      runner.kill("SIGTERM");
      await exited;
    });
    const watching = openDetector({ chosen: () => `runner:${RUNNER}/privacy-filter`, line: "mark", drive: driveHalf(door.url, { call: () => home.tokens.call, drive: () => home.tokens.drive }), fresh_ms: 0 });
    await until("the detector is ready on the runner", () => watching.state().state === "ready")
      .catch((error: Error) => { throw new Error(`${error.message}; the state is ${JSON.stringify(watching.state())}; the runner said ${said.join("")}`); });

    const truths = join(ROOT, "truths.json");
    writeFileSync(truths, JSON.stringify({ items: TRUTHS }));
    const list = join(ROOT, "strict.txt");
    writeFileSync(list, "will\nRaj\ncall\nlate\n");
    const args = ["--truths", truths, "--home", home.root, "--detector", RUNNER, "--list", `strict=${list}`];
    const env = { LIFESTREAM_DOOR: door.url, LIFESTREAM_DOOR_TOKEN: home.tokens.reader!, LIFESTREAM_MACHINE_DIR: machine };

    const inside = await command(["--truths", join(REPO, "tools", "privacy-bench.ts"), "--home", home.root], env);
    expect([inside.code, inside.stdout, inside.stderr]).toEqual([1, "", expect.stringMatching(/^the truths file names the person's details: keep it outside /u)]);

    const unpassed = await command(args, env);
    expect(unpassed.stderr).toBe("");
    expect(unpassed.code).toBe(0);
    expect(unpassed.stdout).toContain("\nHide with a hiding model    not measured: no find pass handed (LIFESTREAM_FIND_TOKEN, from lifestream principals mint --unit <name> --scope find)\n");
    expect(unpassed.stdout).toMatch(/\nHide what the home knows\s+3 of 7 \(42\.9%\)\s+1\s/u);

    const ran = await command(args, { ...env, LIFESTREAM_FIND_TOKEN: home.tokens.find! });
    expect(ran.stderr).toBe("");
    expect(ran.code).toBe(0);
    const printed = ran.stdout;
    writeFileSync(join(ROOT, "privacy-bench.txt"), printed);
    expect(printed).toMatch(/\nDon't hide\s+0 of 7 \(0\.0%\)\s+0\s+0\.0\s/u);
    expect(printed).toMatch(/\nHide what the home knows\s+3 of 7 \(42\.9%\)\s+1\s+\d+\.\d\s/u);
    expect(printed).toMatch(/\nHide with a hiding model\s+6 of 6 \(100\.0%\)\s+2\s+\d+\.\d\s+[\d,]+\s+1\n/u);
    expect(printed).toContain("\nItems 3, characters ");
    expect(printed).toMatch(/\n {2}apple-notes\s+0 of 7 \(0\.0%\)\s+3 of 7 \(42\.9%\)\s+6 of 6 \(100\.0%\)\n/u);
    expect(printed).toContain("\n  bundled: kept 3 of 4 (example, raj, will); ordinary words marked 0\n");
    expect(printed).toContain("\n  strict: kept 2 of 4 (raj, will); ordinary words marked 0\n");

    expect(readdirSync(machine)).toEqual(["people"]);
    expect(existsSync(join(machine, "privacy"))).toBe(false);
  });
});
