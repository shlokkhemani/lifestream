import { describe, expect, it } from "vitest";
import type { RunnerFile, UseId } from "@lifestreamprotocol/model";
import { ADDRESS_WINDOW, CHOOSE_MODEL, MENU } from "./models-read.js";
import type { ModelRoute, StoredModels, StoredRunner } from "./models.js";
import { modelsFindHandler, modelsFound, modelsHandler, modelsPage, WORDS, type FoundWork, type ModelsInputs, type ModelsSettings } from "./page-models.js";
import { servePages } from "./page-serve.js";
import { PAGES, type ModelMenu } from "./pages.js";
import type { Ask } from "./reads.js";
import { clientFixture } from "./test/harness-root.js";

const DAY = { zone: "UTC", day_start_hour: 4 };
const NOW = Date.UTC(2026, 5, 1, 12, 0);
const HOME = "macbook-pro-0001";
const UNIT = `runner-${HOME}`;
const OTHER = "runner-mac-mini-0002";

const file = (id: string, name: string, more: Partial<RunnerFile>): RunnerFile => ({
  id, name, input: ["text"], output: "text", tools: false, context_tokens: 4_000, thinking: [], bytes: 4_000_000_000, languages: [], memory_gb: 16, state: "absent", fetched_bytes: 0, failure: null, ...more,
});
const QWEN = file("qwen3.5-4b", "Qwen 3.5 4B", { input: ["text", "image"] });
const PARAKEET = file("parakeet-unified-en-0.6b", "Parakeet", { input: ["audio"], bytes: 731_357_568, languages: ["en"], memory_gb: 8, state: "ready" });
const NEMOTRON = file("nemotron-3.5-asr-0.6b", "Nemotron Speech", { input: ["audio"], bytes: 751_094_240, languages: ["en", "hi", "es", "fr"], memory_gb: 8 });
const BIG = file("qwen3.5-35b-a3b", "Qwen 3.5 35B-A3B", { input: ["text", "image"], memory_gb: 48, bytes: 22_000_000_000 });
const GEMMA = file("embeddinggemma-2-q8-512", "EmbeddingGemma 2", { output: "vectors", bytes: 480_000_000, memory_gb: 8 });
const FILTER = file("privacy-filter", "Privacy Filter", { output: "marks", memory_gb: 8, detector: { file: "model.onnx", decode: "viterbi" } });

const RUNNER: StoredRunner = { unit: UNIT, name: "MacBook Pro", present: true, power: "battery", memory_gb: 16, files: [QWEN, PARAKEET, NEMOTRON, BIG, GEMMA, FILTER], below: null };
const MINI: StoredRunner = { unit: OTHER, name: "Mac mini", present: true, power: null, memory_gb: 16, files: [PARAKEET], below: null };

const BASE = { output: "text", tools: false, context_tokens: null, thinking: [], offered: true, request: { effort: "low", sampling: null, timeout_ms: 120_000 } } as const;
const onRunner = (runner: StoredRunner, each: RunnerFile, suggested: UseId[]): ModelRoute => ({
  ...BASE, id: `runner:${runner.unit}/${each.id}`, transport: "runner", model: each.id, name: each.name, input: each.input, output: each.output, chat: "door", suggested,
  runner: { unit: runner.unit, name: runner.name, battery: false }, leaves: null, where: `Stays on ${runner.name}`, cost: "free",
  ...(each.state === "ready" ? { state: "ready" as const, line: null } : { state: "unavailable" as const, line: each.state === "absent" ? "Not downloaded" : "Downloading" }),
});
const plan = (transport: string, model: string, name: string, suggested: UseId[], signed: boolean, more: Partial<ModelRoute> = {}): ModelRoute => ({
  ...BASE, id: `${transport}:${model}`, transport, model, name, input: ["text", "image"], tools: true, chat: "program", suggested, runner: null,
  leaves: transport === "claude" ? "Anthropic" : "OpenAI", where: `Sent to ${transport === "claude" ? "Anthropic" : "OpenAI"}`, cost: "plan",
  ...(signed ? { state: "ready" as const, line: null } : { state: "unavailable" as const, line: `Sign in to ${transport === "claude" ? "Claude" : "ChatGPT"} again` }), ...more,
} as ModelRoute);

const R_QWEN = onRunner(RUNNER, QWEN, ["pictures", "text"]);
const R_PARAKEET = onRunner(RUNNER, PARAKEET, ["audio"]);
const R_NEMOTRON = onRunner(RUNNER, NEMOTRON, []);
const R_BIG = onRunner(RUNNER, BIG, []);
const R_GEMMA = onRunner(RUNNER, GEMMA, ["search"]);
const R_FILTER = onRunner(RUNNER, FILTER, ["hiding"]);
const M_PARAKEET = onRunner(MINI, PARAKEET, ["audio"]);
const HAIKU = plan("claude", "claude-haiku-5-5", "Claude Haiku 5.5", ["pictures", "text"], false);
const OPUS = plan("claude", "claude-opus-5-5", "Claude Opus 5.5", ["chat"], false, { thinking: ["low", "medium", "high"] });
const LUNA = plan("codex", "gpt-6-luna", "GPT-6 Luna", ["pictures", "text"], true);
const SOL = plan("codex", "gpt-6.2-sol", "GPT-6.2 Sol", ["chat"], true);
const SCRIBE: ModelRoute = {
  ...BASE, id: "openrouter:elevenlabs/scribe-v2", transport: "openrouter", model: "elevenlabs/scribe-v2", name: "Scribe", input: ["audio"], chat: null, suggested: ["audio"], runner: null,
  leaves: "OpenRouter", where: "Sent to OpenRouter", cost: "priced", state: "unavailable", line: "Add the key for OpenRouter",
};
const GONE: ModelRoute = {
  ...BASE, id: "openrouter:vendor-a/gone-1", transport: "openrouter", model: "vendor-a/gone-1", name: "Gone One", input: [], chat: null, suggested: [], offered: false, runner: null,
  leaves: null, where: null, cost: null, request: null, state: "unavailable", line: "Gone One isn't offered now",
};
const ROUTES = [R_QWEN, R_PARAKEET, R_NEMOTRON, R_BIG, R_GEMMA, R_FILTER, M_PARAKEET, HAIKU, OPUS, LUNA, SOL, SCRIBE, GONE];
const STORED: StoredModels = { routes: ROUTES, runners: [MINI, RUNNER], connections: {} };
const NONE: Record<UseId, string | null> = { pictures: null, audio: null, text: null, chat: null, search: null, hiding: null };
const SETTINGS: ModelsSettings = { defaults: NONE, thinking: { chat: null }, model: { cap: 4 }, runners: {}, connectors: {}, unit: HOME };

const page = (settings: Partial<ModelsSettings> = {}, more: Partial<ModelsInputs> = {}) =>
  modelsPage({ stored: STORED, settings: { ...SETTINGS, ...settings }, pauses: [], now_ms: NOW, day: DAY, ...more });
const useOf = (answer: ReturnType<typeof page>, use: UseId) => answer.uses.find((each) => each.use === use)!;
const listed = (menu: Pick<ModelMenu, "rows" | "local">): string[] => [...menu.rows, ...menu.local?.rows ?? []].map((row) => row.value);

async function served(inputs: ModelsInputs): Promise<unknown> {
  const routes = servePages({ models: modelsHandler({ read: () => ({ position: "7:1", inputs }) }) }, () => DAY);
  const ask = { url: PAGES.models.route, now_ms: NOW, held: { machine: "machine-0001" } } as unknown as Ask;
  return JSON.parse((await routes.get(PAGES.models.route)!(ask)).body as string) as unknown;
}

describe("the models page", () => {
  it("is the page's shape, its six uses in the order Settings draws them", () => {
    const answer = page();
    PAGES.models.shape.parse({ position: "1:1", today: "2026-06-01", ...answer });
    expect(answer.uses.map((each) => [each.use, each.label])).toEqual([
      ["pictures", "Photos"], ["audio", "Voice notes"], ["text", "Text"], ["chat", "Chat"], ["search", "Search by meaning"], ["hiding", "Hiding details"],
    ]);
    expect([PAGES.models.route, PAGES.models.device, PAGES.models.models, PAGES.models.moves]).toEqual(["/v1/page/models", false, false, ["streams"]]);
  });

  it("each use's menu is the models usable now, local ones under Local, each its name; then More, and Off last but for Chat", () => {
    const pictures = useOf(page({ defaults: { ...NONE, pictures: LUNA.id } }), "pictures");
    expect(pictures.menu).toEqual({
      default: null,
      rows: [{ value: LUNA.id, name: "GPT-6 Luna", account: null, chosen: true }],
      local: { label: MENU.local, rows: [{ value: R_QWEN.id, name: "Qwen 3.5 4B", account: null, chosen: false }] },
      more: { words: MENU.more, use: "pictures", work: null },
      off: { value: "none", name: MENU.off, account: null, chosen: false },
    });
    expect([pictures.value, pictures.words, pictures.line]).toEqual([LUNA.id, "GPT-6 Luna", null]);
    const off = useOf(page(), "pictures");
    expect([off.value, off.words, off.menu.off?.chosen]).toEqual([null, "Off", true]);
    expect(listed(useOf(page(), "search").menu)).toEqual([R_GEMMA.id]);
    expect(listed(useOf(page(), "hiding").menu)).toEqual([R_FILTER.id]);
    const chat = useOf(page(), "chat");
    expect([listed(chat.menu), chat.menu.off]).toEqual([[SOL.id], null]);
    expect([chat.value, chat.words]).toEqual([null, CHOOSE_MODEL]);
  });

  it("a runner model not downloaded is listed, picking it downloads it, when its runner runs, is not below its floor and has the memory; downloading, the use says how far", () => {
    const hiding = (runner: Partial<StoredRunner>) => listed(useOf(page({}, { stored: { ...STORED, runners: [MINI, { ...RUNNER, ...runner }] } }), "hiding").menu);
    expect(hiding({})).toEqual([R_FILTER.id]);
    expect([hiding({ below: "0.1.0" }), hiding({ present: false }), hiding({ memory_gb: 4 })]).toEqual([[], [], []]);
    const fetching = { ...FILTER, state: "fetching" as const, fetched_bytes: 1_000_000_000 };
    const routes = ROUTES.map((each) => each.id === R_FILTER.id ? onRunner(RUNNER, fetching, ["hiding"]) : each);
    const downloading = useOf(page({ defaults: { ...NONE, hiding: R_FILTER.id } }, { stored: { ...STORED, routes, runners: [MINI, { ...RUNNER, files: [...RUNNER.files.slice(0, -1), fetching] }] } }), "hiding");
    expect([downloading.line, downloading.menu.local?.rows[0]?.chosen]).toEqual(["Downloading", true]);
  });

  it("a chosen model that is not usable gives the use its line and is left out of the menu, its name still the use's words", () => {
    const chat = useOf(page({ defaults: { ...NONE, chat: OPUS.id } }), "chat");
    expect([chat.words, chat.line, listed(chat.menu)]).toEqual(["Claude Opus 5.5", "Sign in to Claude again", [SOL.id]]);
    const text = useOf(page({ defaults: { ...NONE, text: GONE.id } }), "text");
    expect([text.words, text.line, listed(text.menu)]).toEqual(["Gone One", "Gone One isn't offered now", [LUNA.id, R_QWEN.id]]);
  });

  it("Chat's use carries its chosen model's levels, worded, the one a pick starts at suggested; a kept level the model lacks reads as that start", () => {
    const chat = useOf(page({ defaults: { ...NONE, chat: OPUS.id }, thinking: { chat: "high" } }), "chat");
    expect(chat.thinking).toEqual({ value: "high", words: "High", levels: [
      { value: "low", name: "Low", chosen: false, suggested: false },
      { value: "medium", name: "Medium", chosen: false, suggested: true },
      { value: "high", name: "High", chosen: true, suggested: false },
    ] });
    const kept = useOf(page({ defaults: { ...NONE, chat: OPUS.id }, thinking: { chat: "xhigh" } }), "chat").thinking;
    expect([kept?.value, kept?.words]).toEqual(["medium", "Medium"]);
    expect(useOf(page({ defaults: { ...NONE, chat: SOL.id }, thinking: { chat: "high" } }), "chat").thinking).toBeNull();
    expect(useOf(page(), "chat").thinking).toBeNull();
    expect(page({ defaults: { ...NONE, chat: OPUS.id, text: OPUS.id } }).uses.filter((each) => each.thinking !== null).map((each) => each.use)).toEqual(["chat"]);
  });

  it("a use's own pick that no longer fits it gives the use its line, the reason, and is not listed; another use's model or a stream's pick is never listed under it", () => {
    const connectors = { "fake-poll": { "llm.photos": SOL.id, "llm.range": "all", "llm.notes": "default" } };
    const answer = page({ defaults: { ...NONE, audio: LUNA.id, text: R_PARAKEET.id }, connectors });
    const audio = useOf(answer, "audio");
    expect([audio.words, audio.line]).toEqual(["GPT-6 Luna", "GPT-6 Luna can't hear audio"]);
    expect(listed(audio.menu)).toEqual([R_PARAKEET.id, M_PARAKEET.id]);
    expect(audio.menu.local?.rows.map((each) => each.account)).toEqual(["MacBook Pro", "Mac mini"]);
    expect(useOf(answer, "text").line).toBe("Parakeet only writes out audio");
    for (const use of ["pictures", "chat"] as const) {
      expect(useOf(answer, use).line, use).toBeNull();
      expect(listed(useOf(answer, use).menu), use).not.toContain(R_PARAKEET.id);
    }
  });

  it("places name one model per place the first run offers: a plan's suggested model, disabled until signed in, and each runner's, this Mac by name", () => {
    expect(useOf(page(), "pictures").places).toEqual([
      { place: WORDS.thisMac, value: R_QWEN.id, line: WORDS.download("Qwen 3.5 4B", "4 GB"), ready: true, leaves: false },
      { place: "Claude", value: HAIKU.id, line: WORDS.connect("Claude"), ready: false, leaves: true },
      { place: "ChatGPT", value: LUNA.id, line: null, ready: true, leaves: true },
    ]);
    expect(useOf(page(), "audio").places).toEqual([
      { place: WORDS.thisMac, value: R_PARAKEET.id, line: null, ready: true, leaves: false },
      { place: WORDS.on("Mac mini"), value: M_PARAKEET.id, line: null, ready: true, leaves: false },
    ]);
    expect(useOf(page(), "chat").places.map((each) => each.value)).toEqual([OPUS.id, SOL.id]);
  });

  it("connections come this Mac first, then the other runners, the plans, the keys and the address; a runner's files carry the home's words and acts", () => {
    const answer = page({ model: { cap: 4, transports: { address: { url: "http://127.0.0.1:1234/v1" } } } as ModelsSettings["model"], runners: {} },
      { pauses: [{ target: `runner:${OTHER}`, by: "you", at_ms: NOW - 60_000 }] });
    expect(answer.connections.map((each) => [each.kind, each.id])).toEqual([
      ["runner", `runner:${UNIT}`], ["runner", `runner:${OTHER}`], ["plan", "claude"], ["plan", "codex"], ["key", "openrouter"], ["address", "address"],
    ]);
    const [mine, mini, claude, codex, openrouter, address] = answer.connections;
    expect([claude, codex, openrouter, address]).toEqual([
      { kind: "plan", id: "claude", name: "Claude", line: "Sign in to Claude again", signed: false },
      { kind: "plan", id: "codex", name: "ChatGPT", line: null, signed: true },
      { kind: "key", id: "openrouter", name: "OpenRouter", line: "Add the key for OpenRouter", held: false },
      { kind: "address", id: "address", url: "http://127.0.0.1:1234/v1", line: ADDRESS_WINDOW },
    ]);
    expect(page().connections.filter((each) => each.kind === "address"), "the address is stated unset, so Settings can add one").toEqual([
      { kind: "address", id: "address", url: null, line: null },
    ]);
    if (mine?.kind !== "runner" || mini?.kind !== "runner") throw new Error("the runners come first");
    expect([mine.unit, mine.place, mini.unit, mini.place]).toEqual([UNIT, WORDS.thisMac, OTHER, WORDS.on("Mac mini")]);
    expect([mine.line, mine.paused, mine.battery, mini.paused, mini.battery]).toEqual([null, false, { on: true, line: WORDS.batteryHeld }, true, null]);
    expect(mini.line).toMatch(/^Paused since /u);
    expect(mine.files.map((each) => [each.id, each.about, each.size, each.suggested, each.fits, each.acts])).toEqual([
      ["qwen3.5-4b", "Describes photos and sums up text · suggested for this Mac's 16 GB", "4 GB", true, true, ["fetch"]],
      ["parakeet-unified-en-0.6b", "Transcribes voice notes in English · suggested for this Mac's 16 GB", "0.7 GB", true, true, ["remove"]],
      ["nemotron-3.5-asr-0.6b", "Transcribes voice notes in English, Hindi and 2 more languages", "0.8 GB", false, true, ["fetch"]],
      ["qwen3.5-35b-a3b", `Describes photos and sums up text · ${WORDS.needs(48)}`, "22 GB", false, false, []],
      ["embeddinggemma-2-q8-512", "Search by meaning · suggested for this Mac's 16 GB", "0.5 GB", true, true, ["fetch"]],
    ]);
    expect(mine.found).toEqual([]);
  });

  it("pins a full answer and an empty one, which the apps decode", async () => {
    const address = { cap: 4, transports: { address: { url: "http://127.0.0.1:1234/v1" } } } as ModelsSettings["model"];
    const pinned = {
      "models.full": await served({
        stored: STORED, pauses: [{ target: `runner:${OTHER}`, by: "you", at_ms: NOW - 60_000 }], now_ms: NOW, day: DAY,
        settings: { ...SETTINGS, model: address, defaults: { ...NONE, pictures: LUNA.id, audio: R_PARAKEET.id, text: GONE.id, chat: OPUS.id, search: R_GEMMA.id, hiding: R_PARAKEET.id }, thinking: { chat: "high" } },
      }),
      "models.empty": await served({ stored: { routes: [], runners: [], connections: {} }, settings: SETTINGS, pauses: [], now_ms: NOW, day: DAY }),
    };
    for (const [name, answer] of Object.entries(pinned)) {
      const fixture = clientFixture(`pages/${name}`, answer);
      expect(fixture.held, `homelink/Tests/Fixtures/pages/${name}.json is this answer: LIFESTREAM_FIXTURES=write writes it`).toBe(fixture.written);
    }
  });
});

describe("the models find page", () => {
  const inputs = (settings: Partial<ModelsSettings> = {}): ModelsInputs => ({ stored: STORED, settings: { ...SETTINGS, ...settings }, pauses: [], now_ms: NOW, day: DAY });
  const VOICE: FoundWork = { id: "connector-a/voice", kind: "audio" };

  it("answers the usable models that fit the use and match the words, laid out as a menu's rows; nothing for blank words, and No matches when nothing matches", () => {
    const chat = modelsFound(inputs({ defaults: { ...NONE, chat: SOL.id } }), "chat", undefined, "GPT");
    expect(chat).toEqual({
      placeholder: MENU.search, rows: [{ value: SOL.id, name: "GPT-6.2 Sol", account: null, chosen: true }, { value: LUNA.id, name: "GPT-6 Luna", account: null, chosen: false }],
      local: null, none: null,
    });
    expect(modelsFound(inputs(), "chat", undefined, " ")).toEqual({ placeholder: MENU.search, rows: [], local: null, none: null });
    expect(modelsFound(inputs(), "chat", undefined, "claude")).toEqual({ placeholder: MENU.search, rows: [], local: null, none: MENU.none });
    expect(modelsFound(inputs(), "audio", undefined, "parakeet").local?.rows.map((each) => [each.value, each.account])).toEqual([[R_PARAKEET.id, "MacBook Pro"], [M_PARAKEET.id, "Mac mini"]]);
  });

  it("a stream's work marks the work's own pick", () => {
    const found = modelsFound(inputs({ connectors: { "connector-a": { "llm.voice": M_PARAKEET.id } } }), "audio", VOICE, "parakeet");
    expect(found.local?.rows.map((each) => [each.value, each.chosen])).toEqual([[R_PARAKEET.id, false], [M_PARAKEET.id, true]]);
  });

  it("is served with use or work and the words; a use it does not know, or a work of another use, is refused", async () => {
    const signed = { ...inputs(), stored: { ...STORED, routes: ROUTES.map((each) => each.transport === "claude" ? { ...each, state: "ready", line: null } as ModelRoute : each) } };
    const routes = servePages({ modelsFind: modelsFindHandler({ read: () => ({ position: "7:1", inputs: signed }), work: (id) => id === VOICE.id ? VOICE : undefined }) }, () => DAY);
    const asked = async (query: string): Promise<unknown> => {
      const ask = { url: `${PAGES.modelsFind.route}?${query}`, now_ms: NOW, held: { machine: "machine-0001" } } as unknown as Ask;
      try {
        return JSON.parse((await routes.get(PAGES.modelsFind.route)!(ask)).body as string) as unknown;
      } catch (error) {
        return (error as { code: string }).code;
      }
    };
    const found = await asked("use=chat&q=claude");
    PAGES.modelsFind.shape.parse(found);
    expect((found as { rows: { value: string }[] }).rows.map((each) => each.value)).toEqual([OPUS.id, HAIKU.id]);
    expect(await asked("work=connector-a/voice&q=parakeet")).toMatchObject({ local: { rows: [{ value: R_PARAKEET.id }, { value: M_PARAKEET.id }] } });
    expect([await asked("use=films&q=a"), await asked("use=chat&work=connector-a/voice&q=a"), await asked("q=a"), await asked("work=connector-b/voice&q=a")])
      .toEqual(["BAD_PARAMETER", "BAD_PARAMETER", "BAD_PARAMETER", "WORK_UNKNOWN"]);
    const fixture = clientFixture("pages/modelsFind.claude", found);
    expect(fixture.held, "homelink/Tests/Fixtures/pages/modelsFind.claude.json is this answer: LIFESTREAM_FIXTURES=write writes it").toBe(fixture.written);
  });
});
