import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { startHome } from "./home.js";
import { WORDS } from "./page-models.js";
import { checkoutProgram } from "./programs.js";
import { askHome } from "./socket.js";
import { artifact, FAKES, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { doorHere } from "./test/harness-door.js";
import { REPO } from "./test/support.js";
import { testSocket } from "./test/folder.js";
import { modelsPageOf, runnerOf } from "./test/harness-status.js";

const RUNNER = "runner-macbook-pro-0001";
const MODEL = "qwen3.5-4b";
const DAY = 86_400_000;
const homes: string[] = [];
afterAll(() => {
  for (const root of homes) removeRoot(root);
});

describe("a runner's Save battery", () => {
  it("holds a runner's older work while its machine is on battery and Save battery is on, and runs it once Save battery is off", async () => {
    const SOURCE = "apple-notes:local:device-a";
    const root = makeRoot("lifestream-runner-battery-", { sources: { [SOURCE]: "fake-rows" }, defaults: false });
    homes.push(root);
    const power = join(root, "runner-power");
    writeFileSync(power, "battery");
    const door = await doorHere(root, { registry: FAKES });
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    const verb = (name: string, args: string[]) => askHome(testSocket(root), name, args);
    const route = `runner:${RUNNER}/${MODEL}`;
    const stored = () => (JSON.parse(readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = 'llm:models'").pluck().get() as string)) as
      { routes: { id: string; state: string }[] });
    const done = () => readHome(root, (db) => db.prepare("SELECT item FROM enrichments WHERE state = 'done' ORDER BY item").pluck().all() as string[]);
    const line = async () => ((await verb("status", ["--json"])) as { works: { connector: string; line: string }[] }).works.find((work) => work.connector === "fake-poll")?.line ?? "";
    const passFile = join(process.env.LIFESTREAM_MACHINE_DIR!, "runner", "door-token");
    const program = spawn(process.execPath, [...checkoutProgram(join(REPO, "packages", "runner", "test", "fake-runner.ts")), "--door", door.url, "--pass", passFile, "--power", power],
      { cwd: REPO, stdio: ["ignore", "ignore", "pipe"] });
    const said: string[] = [];
    program.stderr!.on("data", (chunk: Buffer) => said.push(chunk.toString("utf8")));
    const exited = new Promise<void>((resolve) => program.once("exit", () => resolve()));
    try {
      await until("the door holds the runner: its file is asked for", () => verb("models", ["file", RUNNER, MODEL, "fetch"]).then(() => true, (error: Error) => {
        if (error.message.includes("That runner isn't connected.")) return false;
        throw error;
      }));
      await until("the runner's file a ready route of the home", () => stored().routes.some((each) => each.id === route && each.state === "ready"))
        .catch((error: Error) => { throw new Error(`${error.message}; the home stored ${JSON.stringify(stored())}; the runner said ${said.join("")}`); });
      const battery = () => runnerOf(modelsPageOf(root), RUNNER).battery;
      expect(battery()).toEqual({ on: true, line: WORDS.batteryHeld });

      await verb("connectors", ["set", "fake-poll", "llm.photos", route]);
      await verb("connectors", ["set", "fake-poll", "llm.range", "all"]);
      const now = Date.now();
      await ship(root, { source: SOURCE, fetched_ms: now - 30_000, rows: [
        { kind: "note", key: "old", content: { text: "synthetic note old", at: now - 10 * DAY, photo: true }, at: now - 10 * DAY },
        { kind: "note", key: "new", content: { text: "synthetic note new", at: now - 60_000, photo: true }, at: now - 60_000 },
      ] });
      await until("the new photo answered", () => done().length === 1);
      await until("the older photo said to wait for power", async () => /1\s+photo waiting until .+ is plugged in/u.test(await line()))
        .catch(async (error: Error) => { throw new Error(`${error.message}; the line said ${JSON.stringify(await line())}; answered ${JSON.stringify(done())}`); });
      const held = { done: done(), line: await line() };
      expect(held.done).toHaveLength(1);

      await verb("models", ["battery", RUNNER, "spend"]);
      const spent = battery();
      expect(spent).toEqual({ on: false, line: WORDS.saveBattery });
      await until("the older photo answered on battery", () => done().length === 2);
      expect(await line()).not.toMatch(/plugged in/u);
      await expect(verb("models", ["battery", "runner-nobody-0000", "spend"])).rejects.toThrow("That runner isn't connected.");
      await verb("models", ["battery", RUNNER, "save"]);
      expect(battery()).toEqual({ on: true, line: WORDS.batteryHeld });
      artifact(root, "runner-battery", { held, spent, done: done() });
    } finally {
      program.kill("SIGTERM");
      await exited;
      await home.stop();
      await door.stop();
    }
  });
});
