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

describe("Settings › AI models through the door", () => {
  const roots: string[] = [];
  afterAll(() => roots.forEach(removeRoot));

  it("answers the page from what the home holds, Photos on the person's pick, the plans and this Mac as places; never to a model's pass", async () => {
    const root = makeRoot("lifestream-page-models-", { sources: {}, defaults: false });
    roots.push(root);
    mintPrincipal(openHomeFolder(root), { unit: "reader", scopes: ["read"], sources: [], token: TOKEN, now_ms: 0 });
    const unit = `runner-${effective(root).settings.unit}`;
    const request = { effort: "low", sampling: null, timeout_ms: 120_000 };
    const qwen: ModelRoute = {
      id: `runner:${unit}/qwen3.5-4b`, transport: "runner", model: "qwen3.5-4b", name: "Qwen 3.5 4B", input: ["text", "image"], output: "text", tools: false, context_tokens: 4_000, thinking: [],
      chat: "door", suggested: ["pictures", "text"], offered: true, runner: { unit, name: "MacBook Pro", battery: false }, leaves: null, where: "Stays on MacBook Pro", cost: "free",
      request, state: "unavailable", line: "Not downloaded",
    };
    const luna: ModelRoute = {
      id: "codex:gpt-6-luna", transport: "codex", model: "gpt-6-luna", name: "GPT-6 Luna", input: ["text", "image"], output: "text", tools: true, context_tokens: null, thinking: [],
      chat: "program", suggested: ["pictures", "text"], offered: true, runner: null, leaves: "OpenAI", where: "Sent to OpenAI", cost: "plan", request, state: "ready", line: null,
    };
    const stored: StoredModels = {
      routes: [qwen, luna],
      runners: [{
        unit, name: "MacBook Pro", present: true, power: "mains", memory_gb: 16, below: null, files: [{
          id: "qwen3.5-4b", name: "Qwen 3.5 4B", input: ["text", "image"], output: "text", tools: false, context_tokens: 4_000, thinking: [], bytes: 4_000_000_000, languages: [], memory_gb: 16,
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
    editSettings(root, { "model.defaults.pictures": luna.id });

    const { url } = await openDoor(root, { clock: () => NOW });
    const get = (headers: Record<string, string> = {}) => fetch(`${url}${PAGES.models.route}`, { headers: { authorization: `Bearer ${TOKEN}`, ...headers } });
    const response = await get();
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const page = PAGES.models.shape.parse(JSON.parse(text));
    const pictures = page.uses.find((each) => each.use === "pictures")!;
    expect([pictures.value, pictures.words]).toEqual([luna.id, "GPT-6 Luna"]);
    expect([...pictures.menu.rows, ...pictures.menu.local?.rows ?? [], pictures.menu.off].map((each) => [each?.value, each?.chosen])).toEqual([[luna.id, true], [qwen.id, false], ["none", false]]);
    expect(pictures.places).toEqual([
      { place: WORDS.thisMac, value: qwen.id, line: WORDS.download("Qwen 3.5 4B", "4 GB"), ready: true, leaves: false },
      { place: "ChatGPT", value: luna.id, line: null, ready: true, leaves: true },
    ]);
    expect(page.connections.map((each) => [each.kind, each.id])).toEqual([["runner", `runner:${unit}`], ["plan", "codex"], ["address", "address"]]);

    const refused = await get({ "lifestream-reader": "model" });
    expect([refused.status, ((await refused.json()) as { code: string }).code]).toEqual([403, "PRINCIPAL_SCOPE"]);
    artifact(root, "page-models", { page });
  });
});
