import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { JsonObject } from "@lifestreamprotocol/core";
import { openMarks } from "@lifestreamprotocol/privacy";
import { startHome, type Home } from "./home.js";
import { machine } from "./machine.js";
import { markingQueues } from "./index-job.js";
import { markingProgress, marksFileOf } from "./marking.js";
import { MODELS_META } from "./models.js";
import { peopleFileOf } from "./people.js";
import { PEOPLE, writePrepared } from "./prepared.js";
import { mintPrincipal } from "./principals.js";
import { checkoutProgram } from "./programs.js";
import { askHome } from "./socket.js";
import { editSettings, TEST_UNIT, testSocket } from "./test/folder.js";
import { artifact, FAKE_OFFER, FAKES, makeRoot, readHome, readLedger, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { doorHere } from "./test/harness-door.js";
import { REPO } from "./test/support.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

const SOURCE = "apple-notes:local:device-a";
const RECEIVER = "Example Cloud";
const RUNNER = `runner-${TEST_UNIT}`;
const READER = "synthetic-token-chat-reader".padEnd(43, "x").slice(0, 43);
const NAMES = { owner: null, people: [{ who: "p-ada", is: "human", shown: "Ada Example", names: ["Ada Example", "Ada"], accounts: ["person-a@example.com"] }] };

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) removeRoot(root);
});

const quiet = (root: string): boolean => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get() as number) === 0;
const note = (key: string, at: number, text: string) => ({ kind: "note", key, content: { text, at, photo: true }, at });
const answered = (root: string, item: string): boolean => readHome(root, (db) => db.prepare("SELECT 1 FROM enrichments WHERE family = 'notes' AND item = ? AND state = 'done'").get(item)) !== undefined;

describe("a hiding model chosen before its file is there", () => {
  it("sends meanwhile hidden by the rules and People's names, naming no model, and Chat is answered; once the model is ready the next ask uses it and names it", async () => {
    const root = makeRoot("lifestream-model-late-", { sources: { [SOURCE]: "fake-rows" }, cap: 4, fake: { models: [FAKE_OFFER], leaves: RECEIVER }, settings: { "families.notes": { text: "1" } } });
    roots.push(root);
    editSettings(root, { [`model.runners.${RUNNER}.files`]: ["privacy-filter"], "privacy.detector": RUNNER });
    mintPrincipal(openHomeFolder(root), { unit: "chat-reader", scopes: ["read"], token: READER, now_ms: Date.now() });
    const log = join(root, "received.jsonl");
    const received = (): string[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => (JSON.parse(line) as { input: string }).input) : []);
    const copies = () => readLedger(root, (db) => db.prepare("SELECT detector FROM sent_copies ORDER BY id").pluck().all()) as (string | null)[];
    const asks = () => readLedger(root, (db) => db.prepare("SELECT detector FROM outbound WHERE what = 'ask' ORDER BY seq").pluck().all()) as (string | null)[];
    const door = await doorHere(root);
    const home: Home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    const ask = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${door.url}${path}`, {
        method, headers: { authorization: `Bearer ${READER}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const dir = mkdtempSync(join(tmpdir(), "model-late-runner-"));
    let program: ReturnType<typeof spawn> | undefined;
    const said: string[] = [];
    try {
      await askHome(testSocket(root), "settings", ["set", "model.transports.fake", JSON.stringify({ delay_ms: 50, models: [FAKE_OFFER], leaves: RECEIVER, log, reply: "[[Person 1]] in the photo." })]);
      await until("the home's models stored", () => readHome(root, (db) => db.prepare("SELECT 1 FROM meta WHERE key = ?").get(MODELS_META)) !== undefined);
      await until("People's first run done", () => quiet(root));
      writePrepared(openHomeFolder(root), peopleFileOf(root, machine().dir), PEOPLE, { rows: new Map([["names", new Map([["table", NAMES as unknown as JsonObject]])]]), position: "names-1" });

      const at = Date.now() - 60_000;
      await ship(root, { source: SOURCE, fetched_ms: at, rows: [note("n1", at, "lunch with Ada Example and Quorvel Example, write to person-a@example.com")] });
      await until("the first caption answered", () => quiet(root) && answered(root, "photo:n1"));
      expect(received()).toHaveLength(1);
      expect(received()[0]).toContain("lunch with [[Person 1]] and Quorvel Example, write to [[Email 1]]");
      expect(received()[0]).not.toMatch(/Ada|person-a@example\.com/u);
      expect([copies(), asks()]).toEqual([[null], [null]]);

      const privacy = await ask("GET", "/v1/privacy");
      expect(privacy.body).toMatchObject({ ready: true, line: null, detector: { runner: RUNNER, state: "absent" } });
      const chat = await ask("POST", "/v1/hide-details", {
        table: "chat:c1", to: "codex:gpt-6-luna", what: "text", epoch: privacy.body.epoch, texts: [[{ text: "Did Ada Example meet Quorvel Example?", free: true }]],
      });
      expect(chat).toMatchObject({ status: 200, body: { level: "all", texts: ["Did [[Person 1]] meet Quorvel Example?"] } });
      const rows = (await ask("GET", "/v1/outbound")).body.rows as { what: string; detector: string | null }[];
      expect(rows.find((row) => row.what === "text")).toMatchObject({ detector: null });

      writeFileSync(join(dir, "script.json"), JSON.stringify({ words: { "Quorvel Example": "person" } }));
      program = spawn(process.execPath, [...checkoutProgram(join(REPO, "packages", "runner", "test", "fake-runner.ts")), "--door", door.url, "--pass", join(machine().dir, "runner", "door-token"), "--script", join(dir, "script.json")], { cwd: REPO, stdio: ["ignore", "ignore", "pipe"] });
      program.stderr!.on("data", (chunk: Buffer) => said.push(chunk.toString("utf8")));
      const marks = openMarks(openHomeFolder(root), marksFileOf(root, machine().dir));
      try {
        const progress = () => markingProgress(markingQueues(openHomeFolder(root), machine().dir), marks, null)!;
        await until("the home's marking job marks the record on the runner", () => {
          const now = progress();
          return now.total >= 1 && now.marked === now.total;
        }).catch((error: Error) => { throw new Error(`${error.message}; progress ${JSON.stringify(progress())}; the runner said ${said.join("")}`); });
      } finally {
        marks.close();
      }

      await ship(root, { source: SOURCE, fetched_ms: at + 1, rows: [note("n2", at + 60_000, "tea with Quorvel Example and Ada Example")] });
      await until("the second caption answered", () => quiet(root) && answered(root, "photo:n2"));
      expect(received()[1]).toContain("tea with [[Person 1]] and [[Person 2]]");
      expect(received()[1]).not.toMatch(/Quorvel|Ada/u);
      const [, modelled] = copies();
      expect(modelled).toEqual(expect.any(String));
      expect(asks()).toEqual([null, modelled]);
      artifact(root, "model-not-ready", { received: received(), copies: copies(), asks: asks(), chat: chat.body });
    } finally {
      program?.kill("SIGTERM");
      if (program !== undefined && program.exitCode === null) await new Promise<void>((resolve) => program!.once("exit", () => resolve()));
      rmSync(dir, { recursive: true, force: true });
      await home.stop();
      await door.stop();
    }
  });
});
