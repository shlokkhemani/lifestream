import { describe, expect, it } from "vitest";
import type { UseId, WorkKind } from "@lifestreamprotocol/model";
import { ADDRESS_WINDOW, foundOf, inUseOf, MENU, menuOf, modelList, modelsRead, UPDATE_RUNNER, type ModelsAt } from "./models-read.js";
import type { Defaults, ModelRoute, StoredRunner } from "./models.js";
import type { ModelMenu } from "./pages.js";
import { memberWords } from "./processing.js";

const ROUTE: ModelRoute = {
  id: "fake/fake-model", transport: "fake", model: "fake-model", name: "Fake model", input: ["text", "image", "audio"], output: "text", tools: false, context_tokens: null, thinking: [], chat: null, suggested: [], offered: true, runner: null,
  leaves: "Fake", where: "Sent to Fake", cost: "free", request: { effort: "low", sampling: null, timeout_ms: 120_000 }, state: "ready", line: null,
};
const UNIT = "runner-macbook-pro-0001";
const RUNNER: StoredRunner = { unit: UNIT, name: "MacBook Pro", present: true, power: "mains", memory_gb: 16, files: [], below: null };
const onRunner = (model: string, name: string, more: Partial<ModelRoute>): ModelRoute => ({
  ...ROUTE, id: `runner:${UNIT}/${model}`, transport: "runner", model, name, chat: "door", runner: { unit: UNIT, name: "MacBook Pro", battery: false }, leaves: null, where: "Stays on MacBook Pro", ...more,
} as ModelRoute);
const QWEN = onRunner("qwen3.5-4b", "Qwen 3.5", { input: ["text", "image"], suggested: ["pictures", "text"] });
const FILTER = onRunner("privacy-filter", "Privacy Filter", { input: ["text"], output: "marks", state: "unavailable", line: "Not downloaded" });
const HAIKU: ModelRoute = {
  ...ROUTE, id: "claude:claude-haiku-5-5", transport: "claude", model: "claude-haiku-5-5", name: "Claude Haiku 5.5", input: ["text", "image"], tools: true, chat: "program", suggested: ["pictures", "text"],
  leaves: "Anthropic", where: "Sent to Anthropic", cost: "plan", state: "unavailable", line: "Sign in to Claude again",
};
const OPUS: ModelRoute = { ...HAIKU, id: "claude:claude-opus-5-5", model: "claude-opus-5-5", name: "Claude Opus 5.5", thinking: ["low", "medium", "high"], suggested: ["chat"] };
const GONE: ModelRoute = { ...ROUTE, id: "openrouter:vendor-a/gone-1", transport: "openrouter", model: "vendor-a/gone-1", name: "Gone One", input: [], offered: false, leaves: null, where: null, cost: null, request: null, state: "unavailable", line: "Gone One isn't offered now" };
const NONE: Record<UseId, string | null> = { pictures: null, audio: null, text: null, chat: null, search: null, hiding: null };
const AT: ModelsAt = { defaults: NONE, thinking: { chat: null }, address: undefined, blocks: {} };

describe("the models read", () => {
  it("lists each connection once, the runners first, then each transport in its routes' order, then the address, set or not, its line Chat's window", () => {
    const read = modelsRead({ routes: [QWEN, FILTER, HAIKU, OPUS, ROUTE], runners: [RUNNER, { ...RUNNER, unit: "runner-mac-mini-0002", name: "Mac mini", present: false, below: "0.1.0" }], connections: {} },
      { ...AT, address: { url: "http://127.0.0.1:1234/v1" } });
    expect(read.connections).toEqual([
      { id: `runner:${UNIT}`, kind: "runner", name: "MacBook Pro", line: null },
      { id: "runner:runner-mac-mini-0002", kind: "runner", name: "Mac mini", line: UPDATE_RUNNER },
      { id: "claude", kind: "plan", name: "Claude", line: "Sign in to Claude again" },
      { id: "fake", kind: "key", name: "fake", line: null },
      { id: "address", kind: "address", name: "Custom address", line: ADDRESS_WINDOW },
    ]);
    expect(ADDRESS_WINDOW).toBe("Chat needs the server to run a context window of 32,000 tokens or more");
    expect(modelsRead({ routes: [ROUTE], runners: [], connections: {} }, AT).connections).toEqual([
      { id: "fake", kind: "key", name: "fake", line: null },
      { id: "address", kind: "address", name: "Custom address", line: null },
    ]);
  });

  it("a use's fits are the models that fit it, those suggested for it first, then the connections' order; ready or not; value and thinking are the settings'", () => {
    const read = modelsRead({ routes: [QWEN, FILTER, HAIKU, OPUS, ROUTE, GONE], runners: [RUNNER], connections: {} },
      { ...AT, defaults: { ...NONE, chat: OPUS.id, text: GONE.id }, thinking: { chat: "medium" } });
    expect(read.uses.pictures.fits).toEqual([QWEN.id, HAIKU.id, OPUS.id, ROUTE.id]);
    expect(read.uses.text.fits).toEqual([QWEN.id, HAIKU.id, OPUS.id, ROUTE.id]);
    expect(read.uses.audio.fits).toEqual([ROUTE.id]);
    expect(read.uses.chat.fits).toEqual([OPUS.id, HAIKU.id]);
    expect(read.uses.hiding.fits).toEqual([FILTER.id]);
    expect(read.uses.search.fits).toEqual([]);
    expect([read.uses.chat.value, read.uses.chat.thinking, read.uses.chat.fits]).toEqual([OPUS.id, "medium", [OPUS.id, HAIKU.id]]);
    expect([read.uses.text.value, read.uses.text.thinking, read.uses.pictures.value]).toEqual([GONE.id, null, null]);
  });

  it("each row carries its connection, its account, its suggested uses, its state and line; a model no connection offers keeps its last name and its line", () => {
    const read = modelsRead({ routes: [QWEN, HAIKU, GONE], runners: [RUNNER], connections: {} }, AT);
    expect(read.models[QWEN.id]).toEqual({
      id: QWEN.id, connection: `runner:${UNIT}`, model: "qwen3.5-4b", name: "Qwen 3.5", input: ["text", "image"], tools: false, thinking: [], context_tokens: null, chat: "door",
      suggested: ["pictures", "text"], group: "MacBook Pro", leaves: null, state: "ready", line: null,
    });
    expect([read.models[HAIKU.id]!.connection, read.models[HAIKU.id]!.group, read.models[HAIKU.id]!.state, read.models[HAIKU.id]!.line])
      .toEqual(["claude", "Claude", "unavailable", "Sign in to Claude again"]);
    expect([read.models[GONE.id]!.name, read.models[GONE.id]!.connection, read.models[GONE.id]!.line]).toEqual(["Gone One", "openrouter", "Gone One isn't offered now"]);
    expect(Object.values(read.uses).some((use) => use.fits.includes(GONE.id))).toBe(false);
  });
});

const many = (count: number): ModelRoute[] => Array.from({ length: count }, (_, at) => ({
  ...ROUTE, id: `openrouter:vendor-b/model-${at}`, transport: "openrouter", model: `vendor-b/model-${at}`, name: `Model ${at}`, input: ["text"], tools: true, chat: "door", context_tokens: 64_000,
}));

const listed = (menu: Pick<ModelMenu, "rows" | "local">): string[] => [...menu.rows, ...menu.local?.rows ?? []].map((row) => row.value);
const READY_OPUS: ModelRoute = { ...OPUS, state: "ready", line: null };

describe("the short menu and More", () => {
  it("a use's menu holds the models suggested for it, then every model in use, any use's default or any stream's pick, in the fits' order, only those usable now", () => {
    const routes = [QWEN, HAIKU, OPUS, ...many(300)];
    const read = modelsRead({ routes, runners: [RUNNER], connections: {} },
      { ...AT, defaults: { ...NONE, text: "openrouter:vendor-b/model-7" }, blocks: { "connector-a": { "llm.text": "openrouter:vendor-b/model-9", "llm.pictures": "default", other: "openrouter:vendor-b/model-11" } } });
    expect(read.uses.chat.fits).toHaveLength(302);
    expect(listed(read.uses.chat.menu)).toEqual(["openrouter:vendor-b/model-7", "openrouter:vendor-b/model-9"]);
    expect(listed(read.uses.text.menu)).toEqual(["openrouter:vendor-b/model-7", "openrouter:vendor-b/model-9", QWEN.id]);
    expect(inUseOf({ defaults: { ...NONE, chat: OPUS.id }, blocks: { "connector-a": { "llm.text": "off", "llm.audio": "default" } } })).toEqual(new Set([OPUS.id]));
    expect(menuOf(routes, "text", new Set(["openrouter:vendor-b/model-200"]))).toEqual([QWEN.id, HAIKU.id, "openrouter:vendor-b/model-200"]);
  });

  it("a row is its name: local models under Local, the rest above with no header; an account only beside a name the menu holds twice; More, then Off but for Chat", () => {
    const routed: ModelRoute = { ...READY_OPUS, id: "openrouter:vendor-c/opus", transport: "openrouter", model: "vendor-c/opus", suggested: ["chat", "text"] };
    const read = modelsRead({ routes: [QWEN, READY_OPUS, routed], runners: [RUNNER], connections: {} }, { ...AT, defaults: { ...NONE, chat: routed.id } });
    expect(read.uses.chat.menu).toEqual({
      default: null,
      rows: [{ value: READY_OPUS.id, name: "Claude Opus 5.5", account: "Claude", chosen: false }, { value: routed.id, name: "Claude Opus 5.5", account: "OpenRouter", chosen: true }],
      local: null, more: { words: MENU.more, use: "chat", work: null }, off: null,
    });
    expect(read.uses.text.menu).toEqual({
      default: null, rows: [{ value: routed.id, name: "Claude Opus 5.5", account: null, chosen: false }],
      local: { label: MENU.local, rows: [{ value: QWEN.id, name: "Qwen 3.5", account: null, chosen: false }] },
      more: { words: MENU.more, use: "text", work: null }, off: { value: "none", name: MENU.off, account: null, chosen: true },
    });
  });

  it("leaves out a model whose account is out, whose Mac is too small or whose runner is not running; one the Mac fits but has not downloaded is listed", () => {
    const absent = { id: "qwen3.5-4b", state: "absent", memory_gb: 8 } as StoredRunner["files"][number];
    const big = onRunner("qwen3.5-27b", "Qwen 3.5 27B", { state: "unavailable", line: "Needs a Mac with 32 GB", suggested: ["text"] });
    const waiting = { ...QWEN, state: "unavailable", line: "Download Qwen 3.5 · 3 GB" } as ModelRoute;
    const runner = { ...RUNNER, files: [absent, { ...absent, id: "qwen3.5-27b", memory_gb: 32 }] };
    expect(modelList([waiting, big, HAIKU], [runner], null).local?.rows.map((row) => row.value)).toEqual([QWEN.id]);
    expect(modelList([waiting, big, HAIKU], [{ ...runner, present: false }], null)).toEqual({ rows: [], local: null });
  });

  it("holds Chat's conversation pick in Chat's menu, chosen, when it fits Chat; the use's value stays the default", () => {
    const routes = [READY_OPUS, ...many(30)];
    const read = modelsRead({ routes, runners: [], connections: {} }, { ...AT, defaults: { ...NONE, chat: READY_OPUS.id }, chat: "openrouter:vendor-b/model-20" });
    expect(read.uses.chat.value).toBe(READY_OPUS.id);
    expect(read.uses.chat.menu.rows.map((row) => [row.value, row.chosen])).toEqual([[READY_OPUS.id, false], ["openrouter:vendor-b/model-20", true]]);
    expect(listed(modelsRead({ routes, runners: [], connections: {} }, { ...AT, chat: "claude:gone" }).uses.chat.menu)).toEqual([READY_OPUS.id]);
  });

  it("finds the models that fit the use by name, model or id, any case, an exact id first, at most 20; nothing for blank words or a model that does not fit", () => {
    const routes = [QWEN, HAIKU, OPUS, ...many(300)];
    expect(foundOf(routes, "chat", "  ")).toEqual([]);
    expect(foundOf(routes, "chat", "MODEL 1").map((each) => each.id)).toHaveLength(20);
    expect(foundOf(routes, "chat", "vendor-b/model-12")[0]!.id).toBe("openrouter:vendor-b/model-12");
    expect(foundOf(routes, "chat", "openrouter:vendor-b/model-3")[0]!.id).toBe("openrouter:vendor-b/model-3");
    expect(foundOf(routes, "chat", "opus").map((each) => each.id)).toEqual([OPUS.id]);
    expect(foundOf(routes, "chat", "qwen")).toEqual([]);
    expect(foundOf(routes, "pictures", "qwen").map((each) => each.id)).toEqual([QWEN.id]);
  });
});

describe("a connector's AI menu", () => {
  const unpicked: Defaults = { pictures: null, audio: null, text: null };
  const work = (kind: WorkKind) => ({ kind, id: `connector-a/${kind}` });

  it("Default first, then the use's short menu: suggested, in use or the member's own pick, never every fitting model; More; Off last", () => {
    const routes = [QWEN, HAIKU, ...many(50)];
    const said = memberWords(work("text"), { value: "default" }, null, routes, unpicked, [RUNNER], new Set(["openrouter:vendor-b/model-4"]));
    expect([said.menu.default?.value, ...listed(said.menu), said.menu.off?.value]).toEqual(["default", "openrouter:vendor-b/model-4", QWEN.id, "off"]);
    expect(said.menu.more).toEqual({ words: MENU.more, use: "text", work: "connector-a/text" });
    expect(listed(memberWords(work("text"), { value: "openrouter:vendor-b/model-30" }, routes[32]!, routes, unpicked, [RUNNER], new Set()).menu))
      .toEqual(["openrouter:vendor-b/model-30", QWEN.id]);
  });

  it("the Default row names the default, or None with no default set", () => {
    const member = (kind: WorkKind, defaults = unpicked) => memberWords(work(kind), { value: "default" }, null, [ROUTE], defaults, [], new Set());
    for (const kind of ["pictures", "audio"] as WorkKind[]) {
      const said = member(kind);
      expect(said.words).toBe("Off");
      expect(said.menu.default).toEqual({ value: "default", name: MENU.default(null), account: null, chosen: true });
    }
    expect(MENU.default(null)).toBe("Default · None");
    expect(member("text").words).toBe("No model yet");
    expect(member("pictures", { ...unpicked, pictures: ROUTE.id }).menu.default?.name).toBe("Default · Fake model");
  });
});
