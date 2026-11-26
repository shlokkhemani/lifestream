import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { runnerInfo, unfit, USE_IDS, workNeed, type RunnerStated, type StatedFile, type UseId } from "@lifestreamprotocol/model";
import { readPrivacySettings } from "@lifestreamprotocol/privacy";
import { LIST_EVERY_MS, Models } from "./models.js";
import { until } from "./test/harness-root.js";

const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 10, 2, 12);
const LISTED = { value: "sonnet", displayName: "Sonnet", resolvedModel: "claude-sonnet-5-5", supportedEffortLevels: ["low", "medium", "high"] };

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function countedClaude() {
  const dir = mkdtempSync(join(tmpdir(), "lifestream-models-list-"));
  dirs.push(dir);
  const binary = join(dir, "claude");
  const runs = join(dir, "runs");
  const signed = join(dir, "signed-in");
  const answer = JSON.stringify({ type: "control_response", response: { request_id: "list", response: { models: [LISTED] } } });
  writeFileSync(binary, [
    "#!/bin/sh",
    'case "$1" in',
    '  --version) echo "5.0.0 (Claude Code)"; exit 0;;',
    `  auth) if [ -f ${signed} ]; then echo '{"loggedIn":true}'; else echo '{"loggedIn":false}'; fi; exit 0;;`,
    "esac",
    `n=$(cat ${runs} 2>/dev/null || echo 0); echo $((n + 1)) > ${runs}`,
    "read line",
    `echo '${answer}'`,
    "cat > /dev/null",
    "",
  ].join("\n"), { mode: 0o755 });
  writeFileSync(signed, "");
  return {
    at: { binary, home: join(dir, "home") },
    runs: () => (existsSync(runs) ? Number(readFileSync(runs, "utf8").trim()) : 0),
    signOut: () => rmSync(signed),
    signIn: () => writeFileSync(signed, ""),
  };
}

describe("a plan's list", () => {
  it("is asked at the start and at each sign-in, and on a notice only when the list held is an hour old, never on a clock", async () => {
    const claude = countedClaude();
    let now = T0;
    const models = new Models({
      settings: () => ({
        model: { cap: 4 }, defaults: { pictures: null, audio: null, text: null, chat: null, search: null, hiding: null }, connectors: {}, runners: {}, privacy: readPrivacySettings({}),
      }),
      registry: () => ({ connectors: [], families: [] }), ledger: { resting: () => new Map() },
      found: () => ({ programs: { claude: claude.at }, held: () => false }),
      runners: async () => ({ runners: [], below: [] }), paired: () => new Set(), clock: () => now, day: () => ({ zone: "UTC", day_start_hour: 4 }),
      unset: () => [], fill: () => undefined,
    });
    const listed = () => models.list(new Set()).filter((route) => route.transport === "claude").map((route) => route.model);
    expect(listed()).toEqual([]);
    await models.read();
    expect(listed(), "the read answers the declared rows before the program lists").toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
    await until("the start's list landed", async () => {
      await models.read();
      return listed().includes("claude-sonnet-5-5");
    });
    expect(claude.runs()).toBe(1);

    now += LIST_EVERY_MS / 2;
    expect(models.listStale(), "a notice within the hour").toEqual([]);
    for (let hour = 1; hour <= 10; hour++) {
      now = T0 + hour * HOUR_MS;
      await models.read();
    }
    expect(claude.runs(), "ten reads an hour apart and no notice").toBe(1);

    expect(models.listStale(), "a notice past the hour").toEqual(["claude"]);
    expect(models.listStale(), "a notice while the list runs").toEqual([]);
    await until("the notice's list ran", () => claude.runs() === 2);
    await until("the notice's list landed, which asks for a read", () => models.due(now));

    claude.signOut();
    await models.read();
    claude.signIn();
    await models.read();
    await until("the sign-in's list ran", () => claude.runs() === 3);
    expect(listed()).toEqual(["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
  });
});

const NONE: Record<UseId, string | null> = { pictures: null, audio: null, text: null, chat: null, search: null, hiding: null };

async function listing(ids: readonly string[], held = false) {
  let asked = 0;
  const waiting: ServerResponse[] = [];
  const answer = (response: ServerResponse) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
  const server = createServer((request, response) => {
    asked++;
    if (held) waiting.push(response);
    else answer(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    asked: () => asked,
    open: () => { held = false; for (const response of waiting.splice(0)) answer(response); },
  };
}

function addressModels(at: { address: { url: string; model?: string }; defaults?: Record<UseId, string | null> }, filled: Partial<Record<UseId, string>>[] = []) {
  const models = new Models({
    settings: () => ({
      model: { cap: 4, transports: { address: at.address } }, defaults: at.defaults ?? NONE, connectors: {}, runners: {}, privacy: readPrivacySettings({}),
    }),
    registry: () => ({ connectors: [], families: [] }), ledger: { resting: () => new Map() },
    found: () => ({ programs: {}, held: () => false }),
    runners: async () => ({ runners: [], below: [] }), paired: () => new Set(), clock: () => T0, day: () => ({ zone: "UTC", day_start_hour: 4 }),
    unset: () => USE_IDS, fill: (taken) => filled.push(taken),
  });
  const ids = () => models.list(new Set()).filter((route) => route.transport === "address").map((route) => route.id);
  return { models, ids };
}

describe("a custom address", () => {
  it("suggests nothing, so it fills no use: an id it lists first that is no chat model never becomes Text's", async () => {
    const server = await listing(["nomic-embed-text", "llama3.2:latest"]);
    const filled: Partial<Record<UseId, string>>[] = [];
    const { models, ids } = addressModels({ address: { url: server.url } }, filled);
    await until("the address's list landed", async () => {
      await models.read();
      return ids().length > 0;
    });
    expect(ids()).toEqual(["address:nomic-embed-text", "address:llama3.2:latest"]);
    expect(filled).toEqual([]);
  });

  it("keeps the model typed for it as its first row, so a pick of it holds though the server lists it as name:latest", async () => {
    const server = await listing(["nomic-embed-text", "llama3.2:latest"]);
    const filled: Partial<Record<UseId, string>>[] = [];
    const at = { address: { url: server.url, model: "llama3.2" }, defaults: { ...NONE, text: "address:llama3.2" } };
    const { models, ids } = addressModels(at, filled);
    await until("the address's list landed", async () => {
      await models.read();
      return ids().includes("address:nomic-embed-text");
    });
    expect(ids()).toEqual(["address:llama3.2", "address:nomic-embed-text", "address:llama3.2:latest"]);
    expect(models.default("text", new Set())?.id).toBe("address:llama3.2");
    expect(filled).toEqual([]);
  });

  it("drops a list that lands after the address changed, and lists the new address", async () => {
    const before = await listing(["old-model"], true);
    const after = await listing(["new-model"]);
    const at = { address: { url: before.url } };
    const { models, ids } = addressModels(at);
    await models.read();
    await until("the first address was asked for its list", () => before.asked() === 1);
    at.address = { url: after.url };
    await models.read();
    before.open();
    await until("the late list landed, which asks for a read", () => models.due(T0));
    await models.read();
    expect(ids(), "the first address's models are not the new one's").toEqual([]);
    await until("the new address's list landed", async () => {
      await models.read();
      return ids().length > 0;
    });
    expect(ids()).toEqual(["address:new-model"]);
    expect([before.asked(), after.asked()]).toEqual([1, 1]);
  });

  it("a reach asked after the address moved, before the next read, says the new address's host is where the turn goes", async () => {
    const server = await listing([]);
    const at = { address: { url: server.url, model: "local-model" } };
    const { models } = addressModels(at);
    await models.read();
    const controls = { tables: { controls: { list: () => [] } } } as unknown as Parameters<Models["reach"]>[0];
    expect(models.reach(controls, "address:local-model", () => undefined)).toMatchObject({ url: `${server.url}/chat/completions`, leaves: null });
    at.address = { url: "http://192.0.2.7:11434/v1", model: "local-model" };
    expect(models.reach(controls, "address:local-model", () => undefined)).toMatchObject({ url: "http://192.0.2.7:11434/v1/chat/completions", leaves: "192.0.2.7" });
  });
});

describe("a timed work's models", () => {
  const RUNNER_UNIT = "runner-macbook-pro-0001";
  const OLDER_UNIT = "runner-mac-mini-0002";
  const parakeet = (timed?: boolean): StatedFile => ({
    id: "parakeet-unified-en-0.6b", name: "Parakeet", input: ["audio"], output: "text", tools: false, ...(timed === undefined ? {} : { timed }), context_tokens: null, thinking: [],
    bytes: 731_357_568, languages: ["en"], memory_gb: 8, state: "ready", fetched_bytes: 731_357_568, failure: null,
  });
  const stated = (file: StatedFile): RunnerStated => ({
    name: "MacBook Pro", version: "1", boot: "boot-a", slots: 1, power: "mains", idle_s: null, thermal: null, memory_gb: 16, running: [], files: [file],
  });

  it("builds a route from each offer with what it states of timing: a runner's timed file and Gemini are fit for a timed work; an older runner's file that states none, and Scribe, are not, and say so", async () => {
    const runners = [{ ...runnerInfo(RUNNER_UNIT, stated(parakeet(true))), present: true }, { ...runnerInfo(OLDER_UNIT, stated(parakeet())), present: true }];
    const models = new Models({
      settings: () => ({ model: { cap: 4 }, defaults: NONE, connectors: {}, runners: {}, privacy: readPrivacySettings({}) }),
      registry: () => ({ connectors: [], families: [] }), ledger: { resting: () => new Map() },
      found: () => ({ programs: {}, held: () => false }),
      runners: async () => ({ runners, below: [] }), paired: () => new Set(), clock: () => T0, day: () => ({ zone: "UTC", day_start_hour: 4 }),
      unset: () => [], fill: () => undefined,
    });
    await models.read();
    const calls = workNeed({ kind: "audio", timed: true });
    const hearing = models.list(new Set()).filter((route) => route.input.includes("audio"));
    expect(hearing.map((route) => [route.id, route.timed, unfit(route, calls)])).toEqual([
      [`runner:${RUNNER_UNIT}/parakeet-unified-en-0.6b`, true, null],
      [`runner:${OLDER_UNIT}/parakeet-unified-en-0.6b`, false, "timed"],
      ["openrouter:elevenlabs/scribe-v2", false, "timed"],
      ["openrouter:google/gemini-3.8-flash", true, null],
    ]);
    expect(hearing.map((route) => unfit(route, workNeed({ kind: "audio" })))).toEqual([null, null, null, null]);
  });
});
