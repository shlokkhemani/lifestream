import { describe, expect, it } from "vitest";
import type { RunnerFile, UseId } from "@lifestreamprotocol/model";
import { ADDRESS_WINDOW, CHOOSE_MODEL, MENU } from "./models-read.js";
import { leftWords, routeName, secondsLeft, type ModelRoute, type StoredModels, type StoredRunner } from "./models.js";
import { modelDefaults, modelDefaultsHandler, modelProviders, modelProvidersHandler, modelsFindHandler, modelsFound, WORDS, type FoundWork, type ModelsInputs, type ModelsSettings } from "./page-models.js";
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

const inputsOf = (settings: Partial<ModelsSettings> = {}, more: Partial<ModelsInputs> = {}): ModelsInputs =>
  ({ stored: STORED, settings: { ...SETTINGS, ...settings }, pauses: [], now_ms: NOW, day: DAY, ...more });
const page = (settings: Partial<ModelsSettings> = {}, more: Partial<ModelsInputs> = {}) => modelDefaults(inputsOf(settings, more));
const providers = (settings: Partial<ModelsSettings> = {}, more: Partial<ModelsInputs> = {}) => modelProviders(inputsOf(settings, more));
const KEY_FIELD = { label: WORDS.keyField("OpenRouter"), placeholder: WORDS.keyPlaceholder, add: WORDS.addKey, remove: WORDS.remove };
const SERVER_WORDS = { about: WORDS.serverAbout, add: WORDS.addServer, remove: WORDS.remove, field: WORDS.serverField, placeholder: WORDS.serverPlaceholder, save: WORDS.save };
const useOf = (answer: ReturnType<typeof page>, use: UseId) => answer.uses.find((each) => each.use === use)!;
const listed = (menu: Pick<ModelMenu, "rows" | "local">): string[] => [...menu.rows, ...menu.local?.rows ?? []].map((row) => row.value);

async function served(name: "modelDefaults" | "modelProviders", inputs: ModelsInputs): Promise<unknown> {
  const read = { read: () => ({ position: "7:1", inputs }) };
  const routes = servePages({ modelDefaults: modelDefaultsHandler(read), modelProviders: modelProvidersHandler(read) }, () => DAY);
  const ask = { url: PAGES[name].route, now_ms: NOW, held: { machine: "machine-0001" } } as unknown as Ask;
  return JSON.parse((await routes.get(PAGES[name].route)!(ask)).body as string) as unknown;
}

describe("the default models page", () => {
  it("is the page's shape, its six uses in the order Settings draws them", () => {
    const answer = page();
    PAGES.modelDefaults.shape.parse({ position: "1:1", today: "2026-06-01", ...answer });
    PAGES.modelProviders.shape.parse({ position: "1:1", today: "2026-06-01", ...providers() });
    expect(answer.uses.map((each) => [each.use, each.label])).toEqual([
      ["chat", "Chat"], ["pictures", "Photos"], ["audio", "Voice notes"], ["text", "Text"], ["search", "Search by meaning"], ["hiding", "Hiding details"],
    ]);
    for (const [name, route] of [["modelDefaults", "/v1/page/models/defaults"], ["modelProviders", "/v1/page/models/providers"]] as const) {
      expect([PAGES[name].route, PAGES[name].device, PAGES[name].models, PAGES[name].moves], name).toEqual([route, false, false, ["streams"]]);
    }
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
    expect(chat.thinking).toEqual({ label: WORDS.thinking, value: "high", words: "High", levels: [
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
      { place: WORDS.thisMac, value: R_QWEN.id, line: WORDS.download("Qwen 3.5 4B", "4 GB"), working: false, ready: true, leaves: false },
      { place: "Claude", value: HAIKU.id, line: WORDS.connect("Claude"), working: false, ready: false, leaves: true },
      { place: "ChatGPT", value: LUNA.id, line: null, working: false, ready: true, leaves: true },
    ]);
    expect(useOf(page(), "audio").places).toEqual([
      { place: WORDS.thisMac, value: R_PARAKEET.id, line: null, working: false, ready: true, leaves: false },
      { place: WORDS.on("Mac mini"), value: M_PARAKEET.id, line: null, working: false, ready: true, leaves: false },
    ]);
    expect(useOf(page(), "chat").places.map((each) => each.value)).toEqual([OPUS.id, SOL.id]);
    const fetching = { ...QWEN, state: "fetching" as const, fetched_bytes: 1_000_000_000 };
    const runner = { ...RUNNER, files: [fetching, ...RUNNER.files.slice(1)], left: { [QWEN.id]: 170 } };
    expect(useOf(page({}, { stored: { ...STORED, runners: [MINI, runner] } }), "pictures").places[0]).toMatchObject({ line: "Downloading · 3 min left", working: true });
  });
});

describe("the providers page", () => {
  it("lists the accounts, then each runner's local models, then the other server; every word is the home's", () => {
    const answer = providers({ model: { cap: 4, transports: { address: { url: "http://127.0.0.1:1234/v1" } } } as ModelsSettings["model"], runners: {} },
      { pauses: [{ target: `runner:${OTHER}`, by: "you", at_ms: NOW - 60_000 }] });
    expect(answer.accounts).toBe(WORDS.accounts);
    expect(answer.connections.map((each) => [each.kind, each.id])).toEqual([
      ["plan", "claude"], ["plan", "codex"], ["key", "openrouter"], ["runner", `runner:${UNIT}`], ["runner", `runner:${OTHER}`], ["address", "address"],
    ]);
    const [claude, codex, openrouter, mine, mini, address] = answer.connections;
    expect([claude, codex, openrouter, address]).toEqual([
      { kind: "plan", id: "claude", name: "Claude", line: "Sign in to Claude again", signed: false, words: WORDS.unsigned },
      { kind: "plan", id: "codex", name: "ChatGPT", line: null, signed: true, words: WORDS.signed },
      { kind: "key", id: "openrouter", name: "OpenRouter", line: WORDS.keyLine, held: false, words: null, key: KEY_FIELD },
      { kind: "address", id: "address", label: WORDS.server, url: "http://127.0.0.1:1234/v1", line: ADDRESS_WINDOW, words: SERVER_WORDS },
    ]);
    expect(providers().connections.filter((each) => each.kind === "address"), "the server is stated unset, so Settings can add one").toEqual([
      { kind: "address", id: "address", label: WORDS.server, url: null, line: null, words: SERVER_WORDS },
    ]);
    if (mine?.kind !== "runner" || mini?.kind !== "runner") throw new Error("the runners follow the accounts");
    expect([mine.unit, mine.place, mini.unit, mini.place]).toEqual([UNIT, WORDS.localOn("MacBook Pro"), OTHER, WORDS.localOn("Mac mini")]);
    expect([mine.line, mine.paused, mine.run, mine.battery, mine.none]).toEqual([null, false, { label: WORDS.run, on: true, line: null },
      { label: WORDS.saveBattery, on: true, line: WORDS.batteryLine }, null]);
    expect([mini.line, mini.paused, mini.run, mini.battery]).toEqual([null, true, { label: WORDS.run, on: false, line: WORDS.runOff }, null]);
    expect(mine.files.map((each) => [each.id, each.line, each.working, each.fits, each.words, each.acts.map((act) => [act.act, act.words])])).toEqual([
      ["qwen3.5-4b", `Describes photos and sums up text · 4 GB · ${WORDS.recommended}`, false, true, null, [["fetch", WORDS.fetch]]],
      ["parakeet-unified-en-0.6b", `Transcribes voice notes in English · 0.7 GB · ${WORDS.recommended}`, false, true, WORDS.downloaded, [["remove", WORDS.remove]]],
      ["nemotron-3.5-asr-0.6b", "Transcribes voice notes in English, Hindi and 2 more languages · 0.8 GB", false, true, null, [["fetch", WORDS.fetch]]],
      ["qwen3.5-35b-a3b", WORDS.needs(48), false, false, null, []],
      ["embeddinggemma-2-q8-512", `Search by meaning · 0.5 GB · ${WORDS.recommended}`, false, true, null, [["fetch", WORDS.fetch]]],
    ]);
    expect(mine.found).toEqual([]);
    const alone = providers({}, { stored: { ...STORED, runners: [RUNNER] } }).connections.find((each) => each.kind === "runner");
    expect(alone?.kind === "runner" ? alone.place : null, "one Mac's runner is plain Local models").toBe(WORDS.local);
  });

  it("a downloading file reads Downloading and the time left the home measured, working, with Cancel; a runner away holds every act", () => {
    const fetching = { ...QWEN, state: "fetching" as const, fetched_bytes: 1_000_000_000 };
    const fileOf = (runner: StoredRunner) => {
      const mine = providers({}, { stored: { ...STORED, runners: [runner] } }).connections.find((each) => each.kind === "runner");
      return mine?.kind === "runner" ? mine.files[0]! : null;
    };
    expect(fileOf({ ...RUNNER, files: [fetching] })).toMatchObject({ line: "Downloading", working: true, acts: [{ act: "cancel", words: WORDS.cancel }] });
    expect(fileOf({ ...RUNNER, files: [fetching], left: { [QWEN.id]: 170 } })?.line).toBe("Downloading · 3 min left");
    expect(fileOf({ ...RUNNER, files: [fetching], present: false })?.acts).toEqual([]);
    expect([30, 60, 170, 3_599, 7_200].map(leftWords)).toEqual(["less than a minute left", "1 min left", "3 min left", "about 1 hr left", "about 2 hr left"]);
    expect([
      secondsLeft({ bytes: 1_000, fetched_bytes: 600 }, { at_ms: 0, bytes: 200 }, 4_000),
      secondsLeft({ bytes: 1_000, fetched_bytes: 200 }, { at_ms: 0, bytes: 200 }, 4_000),
      secondsLeft({ bytes: 1_000, fetched_bytes: 600 }, { at_ms: 4_000, bytes: 200 }, 4_000),
    ]).toEqual([4, undefined, undefined]);
  });

  it("pins a full answer and an empty one, which the apps decode", async () => {
    const address = { cap: 4, transports: { address: { url: "http://127.0.0.1:1234/v1" } } } as ModelsSettings["model"];
    const full: ModelsInputs = {
      stored: { ...STORED, runners: [MINI, { ...RUNNER, files: RUNNER.files.map((each) => each.id === NEMOTRON.id ? { ...each, state: "fetching", fetched_bytes: 300_000_000 } : each), left: { [NEMOTRON.id]: 170 } }] },
      pauses: [{ target: `runner:${OTHER}`, by: "you", at_ms: NOW - 60_000 }], now_ms: NOW, day: DAY,
      settings: { ...SETTINGS, model: address, defaults: { ...NONE, pictures: LUNA.id, audio: R_PARAKEET.id, text: GONE.id, chat: OPUS.id, search: R_GEMMA.id, hiding: R_PARAKEET.id }, thinking: { chat: "high" } },
    };
    const empty: ModelsInputs = { stored: { routes: [], runners: [], connections: {} }, settings: SETTINGS, pauses: [], now_ms: NOW, day: DAY };
    const pinned = {
      "modelDefaults.full": await served("modelDefaults", full),
      "modelDefaults.empty": await served("modelDefaults", empty),
      "modelProviders.full": await served("modelProviders", full),
      "modelProviders.empty": await served("modelProviders", empty),
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

  it("answers the usable models that fit the use and match the words, grouped under where each comes from; nothing for blank words, and No matches when nothing matches", () => {
    const chat = modelsFound(inputs({ defaults: { ...NONE, chat: SOL.id } }), "chat", undefined, "GPT");
    expect(chat).toEqual({
      placeholder: MENU.search,
      groups: [{ label: "ChatGPT", rows: [{ value: SOL.id, name: "GPT-6.2 Sol", account: null, chosen: true }, { value: LUNA.id, name: "GPT-6 Luna", account: null, chosen: false }] }],
      none: null,
    });
    expect(modelsFound(inputs(), "chat", undefined, " ")).toEqual({ placeholder: MENU.search, groups: [], none: null });
    expect(modelsFound(inputs(), "chat", undefined, "claude")).toEqual({ placeholder: MENU.search, groups: [], none: MENU.none });
    const local = modelsFound(inputs(), "audio", undefined, "parakeet").groups;
    expect(local.map((group) => [group.label, group.rows.map((each) => [each.value, each.account])]), "one name on two Macs under Local says each Mac")
      .toEqual([[MENU.local, [[R_PARAKEET.id, "MacBook Pro"], [M_PARAKEET.id, "Mac mini"]]]]);
  });

  it("groups come in order: the plans, Claude then ChatGPT, then OpenRouter, then Local", () => {
    const vision: ModelRoute = { ...SCRIBE, id: "openrouter:vendor-a/vision-1", model: "vendor-a/vision-1", name: "Vision One", input: ["text", "image"], suggested: ["pictures"], state: "ready", line: null };
    const routes = [...ROUTES.map((each) => each.transport === "claude" ? { ...each, state: "ready", line: null } as ModelRoute : each), vision];
    const found = modelsFound({ ...inputs(), stored: { ...STORED, routes } }, "pictures", undefined, "a");
    expect(found.groups.map((group) => group.label)).toEqual(["Claude", "ChatGPT", "OpenRouter", MENU.local]);
    expect(found.groups.filter((group) => group.label !== MENU.local).flatMap((group) => group.rows).map((row) => row.account), "the header names the account").not.toContain("Claude");
  });

  it("a stream's work marks the work's own pick", () => {
    const found = modelsFound(inputs({ connectors: { "connector-a": { "llm.voice": M_PARAKEET.id } } }), "audio", VOICE, "parakeet");
    expect(found.groups[0]?.rows.map((each) => [each.value, each.chosen])).toEqual([[R_PARAKEET.id, false], [M_PARAKEET.id, true]]);
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
    expect((found as { groups: { label: string; rows: { value: string }[] }[] }).groups.map((each) => [each.label, each.rows.map((row) => row.value)])).toEqual([["Claude", [OPUS.id, HAIKU.id]]]);
    expect(await asked("work=connector-a/voice&q=parakeet")).toMatchObject({ groups: [{ label: MENU.local, rows: [{ value: R_PARAKEET.id }, { value: M_PARAKEET.id }] }] });
    expect([await asked("use=films&q=a"), await asked("use=chat&work=connector-a/voice&q=a"), await asked("q=a"), await asked("work=connector-b/voice&q=a")])
      .toEqual(["BAD_PARAMETER", "BAD_PARAMETER", "BAD_PARAMETER", "WORK_UNKNOWN"]);
    const fixture = clientFixture("pages/modelsFind.claude", found);
    expect(fixture.held, "homelink/Tests/Fixtures/pages/modelsFind.claude.json is this answer: LIFESTREAM_FIXTURES=write writes it").toBe(fixture.written);
  });
});

describe("an OpenRouter model's name", () => {
  it("drops the maker OpenRouter puts before it; another provider's name is kept whole", () => {
    expect([routeName("openrouter", "Qwen: Qwen4 Max"), routeName("openrouter", "Vision One"), routeName("claude", "Claude: Opus")]).toEqual(["Qwen4 Max", "Vision One", "Claude: Opus"]);
  });
});
