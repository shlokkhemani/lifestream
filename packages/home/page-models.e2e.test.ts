import { join } from "node:path";
import Database from "better-sqlite3";
import { openHomeFolder } from "@lifestreamprotocol/core";
import { afterAll, describe, expect, it } from "vitest";
import { MODELS_META, type ModelRoute, type StoredModels } from "./models.js";
import { WORDS } from "./page-models.js";
import { PAGES } from "./pages.js";
import { mintPrincipal } from "./principals.js";
import { effective } from "./settings.js";
import { editSettings } from "./test/folder.js";
import { artifact, makeRoot, removeRoot } from "./test/harness-root.js";
import { openDoor } from "./test/harness-door.js";

const TOKEN = "synthetic-models-reader".padEnd(43, "r");
const NOW = Date.parse("2026-11-25T12:00:00Z");

describe("Settings › Default models and Providers through the door", () => {
  const roots: string[] = [];
  afterAll(() => roots.forEach(removeRoot));

  it("answers both pages from what the home holds, Photos on the person's pick, a file the person asked for downloading before its runner says so; never to a model's pass", async () => {
    const root = makeRoot("lifestream-page-models-", { sources: {}, defaults: false });
    roots.push(root);
    mintPrincipal(openHomeFolder(root), { unit: "reader", scopes: ["read"], sources: [], token: TOKEN, now_ms: 0 });
    const unit = `runner-${effective(root).settings.unit}`;
    const request = { effort: "low", sampling: null, timeout_ms: 120_000 };
    const qwen: ModelRoute = {
      id: `runner:${unit}/qwen3.5-4b`, transport: "runner", model: "qwen3.5-4b", name: "Qwen 3.5 4B", input: ["text", "image"], output: "text", tools: false, timed: false, context_tokens: 4_000, thinking: [],
      chat: "door", suggested: ["pictures", "text"], offered: true, runner: { unit, name: "MacBook Pro", battery: false }, leaves: null, where: "Stays on MacBook Pro", cost: "free",
      request, state: "unavailable", line: "Not downloaded",
    };
    const luna: ModelRoute = {
      id: "codex:gpt-6-luna", transport: "codex", model: "gpt-6-luna", name: "GPT-6 Luna", input: ["text", "image"], output: "text", tools: true, timed: false, context_tokens: null, thinking: [],
      chat: "program", suggested: ["pictures", "text"], offered: true, runner: null, leaves: "OpenAI", where: "Sent to OpenAI", cost: "plan", request, state: "ready", line: null,
    };
    const stored: StoredModels = {
      routes: [qwen, luna],
      runners: [{
        unit, name: "MacBook Pro", present: true, power: "mains", memory_gb: 16, below: null, files: [{
          id: "qwen3.5-4b", name: "Qwen 3.5 4B", input: ["text", "image"], output: "text", tools: false, timed: false, context_tokens: 4_000, thinking: [], bytes: 4_000_000_000, languages: [], memory_gb: 16,
          state: "absent", fetched_bytes: 0, failure: null,
        }],
      }],
      connections: {},
    };
    const db = new Database(join(root, "home.db"));
    try {
      db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(MODELS_META, JSON.stringify(stored));
    } finally {
      db.close();
    }
    editSettings(root, { "model.defaults.pictures": luna.id, [`model.runners.${unit}.files`]: ["qwen3.5-4b"] });

    const { url } = await openDoor(root, { clock: () => NOW });
    const get = (route: string, headers: Record<string, string> = {}) => fetch(`${url}${route}`, { headers: { authorization: `Bearer ${TOKEN}`, ...headers } });
    const response = await get(PAGES.modelDefaults.route);
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const page = PAGES.modelDefaults.shape.parse(JSON.parse(text));
    const pictures = page.uses.find((each) => each.use === "pictures")!;
    expect([pictures.value, pictures.words]).toEqual([luna.id, "GPT-6 Luna"]);
    expect([...pictures.menu.rows, ...pictures.menu.local?.rows ?? [], pictures.menu.off].map((each) => [each?.value, each?.chosen])).toEqual([[luna.id, true], [qwen.id, false], ["none", false]]);
    expect([pictures.line, pictures.working, pictures.leaves]).toEqual([null, false, true]);
    const served = await get(PAGES.modelProviders.route);
    const said = await served.text();
    expect(served.status, said).toBe(200);
    const providers = PAGES.modelProviders.shape.parse(JSON.parse(said));
    expect(providers.connections.map((each) => [each.kind, each.id])).toEqual([["plan", "codex"], ["runner", `runner:${unit}`], ["address", "address"]]);
    const runner = providers.connections.find((each) => each.kind === "runner");
    expect(runner?.kind === "runner" ? runner.files.map((each) => [each.state, each.line, each.working, each.acts.map((act) => act.words)]) : null,
      "the home's stored file is absent; the person's Download stands until the runner reports").toEqual([["fetching", "Downloading", true, [WORDS.cancel]]]);

    for (const route of [PAGES.modelDefaults.route, PAGES.modelProviders.route]) {
      const refused = await get(route, { "lifestream-reader": "model" });
      expect([refused.status, ((await refused.json()) as { code: string }).code], route).toEqual([403, "PRINCIPAL_SCOPE"]);
    }
    artifact(root, "page-models", { page, providers });
  });
});
