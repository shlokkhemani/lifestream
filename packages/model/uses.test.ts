import { describe, expect, it } from "vitest";
import { unfit } from "./fit.js";
import type { RunnerFile, RunnerListing } from "./runner-wire.js";
import type { Transport } from "./transport.js";
import { claudeTransport } from "./transports/claude.js";
import { codexTransport } from "./transports/codex.js";
import { openRouterTransport } from "./transports/openrouter.js";
import { runnerTransport } from "./transports/runner.js";
import { MODEL_USES, unfitWords, USE_IDS, workNeed } from "./uses.js";

const OPENROUTER = { held: () => true, key: () => "synthetic-openrouter-key" };

const held = (id: string, file: Partial<RunnerFile>): RunnerFile => ({
  id, name: `Model ${id}`, input: ["text"], output: "text", tools: false, timed: false, context_tokens: null, thinking: [], bytes: 1_000_000_000, languages: [], memory_gb: 8,
  state: "ready", fetched_bytes: 0, failure: null, ...file,
});

const machine = (unit: string, files: RunnerFile[]): RunnerListing => ({
  unit, name: `Mac ${unit}`, version: "5", boot: "boot-a", slots: 1, power: "mains", idle_s: null, thermal: null, memory_gb: 16, running: [], files, present: true,
});

describe("the uses", () => {
  it("are six, each with its label and the need a model must meet", () => {
    expect(USE_IDS).toEqual(["pictures", "audio", "text", "chat", "search", "hiding"]);
    expect(Object.fromEntries(USE_IDS.map((use) => [use, MODEL_USES[use].label]))).toEqual({
      pictures: "Photos", audio: "Voice notes", text: "Text", chat: "Chat", search: "Search by meaning", hiding: "Hiding details",
    });
    expect(workNeed({ kind: "text", text_chars: 500_000 })).toEqual({ input: ["text"], output: "text", context_tokens: 125_000 });
    expect(workNeed({ kind: "audio" })).toEqual(MODEL_USES.audio.need);
    expect(workNeed({ kind: "audio", timed: true })).toEqual({ ...MODEL_USES.audio.need, timed: true });
  });

  it("fills Text with no thinking level and Chat at medium in its own order, and leaves Photos, Voice notes, Search and Hiding Off until picked", () => {
    expect(Object.fromEntries(USE_IDS.map((use) => [use, MODEL_USES[use].fill]))).toEqual({
      pictures: null, audio: null, text: { thinking: null }, chat: { thinking: "medium", order: ["claude", "codex", "runner", "openrouter"] }, search: null, hiding: null,
    });
  });

  it("each transport suggests a declared row only for a use it fits, and no plan suggests its small model for Chat", async () => {
    const transports: Transport[] = [
      claudeTransport({ claude: undefined }),
      codexTransport({ codex: undefined }),
      openRouterTransport(OPENROUTER),
    ];
    const suggested: Record<string, readonly string[]> = {};
    for (const transport of transports) {
      for (const model of await transport.models()) {
        for (const use of model.suggested ?? []) expect(unfit({ ...model, leaves: transport.leaves }, MODEL_USES[use].need), `${model.model} for ${use}`).toBeNull();
        suggested[`${transport.name}:${model.model}`] = model.suggested ?? [];
      }
    }
    expect(suggested).toEqual({
      "claude:claude-haiku-5-5": ["pictures", "text"],
      "claude:claude-opus-5-5": ["chat"],
      "codex:gpt-6-luna": ["pictures", "text"],
      "codex:gpt-6.2-sol": ["chat"],
      "openrouter:elevenlabs/scribe-v2": ["audio"],
      "openrouter:google/gemini-3.8-flash": ["pictures", "text"],
      "openrouter:openai/gpt-6-luna": ["pictures", "text", "chat"],
    });
  });

  it("a runner suggests, on each machine, the first file its memory holds that fits each use, fetched or not", async () => {
    const files = [
      held("qwen3.5-4b", { input: ["text", "image"], context_tokens: 4_000 }),
      held("parakeet-unified-en-0.6b", { input: ["audio"] }),
      held("nemotron-3.5-asr-0.6b", { input: ["audio"] }),
      held("embeddinggemma-2-q8-512", { output: "vectors", context_tokens: 2_048 }),
      held("privacy-filter", { output: "marks", context_tokens: 8_000, state: "fetching" }),
    ];
    const other = [held("parakeet-unified-en-0.6b", { input: ["audio"], state: "absent" }), held("nemotron-3.5-asr-0.6b", { input: ["audio"] })];
    const runner = runnerTransport({ door: "http://127.0.0.1:9", pass: () => undefined, runners: [machine("runner-a", files), machine("runner-b", other)] });
    expect((await runner.models()).map((model) => [model.runner?.unit, model.model, model.suggested ?? []])).toEqual([
      ["runner-a", "qwen3.5-4b", ["pictures", "text"]],
      ["runner-a", "parakeet-unified-en-0.6b", ["audio"]],
      ["runner-a", "nemotron-3.5-asr-0.6b", []],
      ["runner-a", "embeddinggemma-2-q8-512", ["search"]],
      ["runner-a", "privacy-filter", ["hiding"]],
      ["runner-b", "parakeet-unified-en-0.6b", ["audio"]],
      ["runner-b", "nemotron-3.5-asr-0.6b", []],
    ]);
  });

  it("a runner holding nothing suggests by its machine's memory: Qwen for Photos and Text on 16 GB, never on 8 GB, Parakeet for Voice notes on both", async () => {
    const absent = [
      held("qwen3.5-4b", { input: ["text", "image"], context_tokens: 4_000, memory_gb: 16, state: "absent" }),
      held("parakeet-unified-en-0.6b", { input: ["audio"], state: "absent" }),
    ];
    const suggested = async (memory_gb: number) => (await runnerTransport({ door: "http://127.0.0.1:9", pass: () => undefined, runners: [{ ...machine("runner-a", absent), memory_gb }] }).models())
      .map((model) => [model.model, model.ready, model.suggested ?? []]);
    expect(await suggested(16)).toEqual([["qwen3.5-4b", false, ["pictures", "text"]], ["parakeet-unified-en-0.6b", false, ["audio"]]]);
    expect(await suggested(8)).toEqual([["qwen3.5-4b", false, []], ["parakeet-unified-en-0.6b", false, ["audio"]]]);
  });

  it("says why a model does not fit, in one sentence with its name", () => {
    expect([
      unfitWords("GPT-6 Luna", { input: "audio" }),
      unfitWords("Qwen 3.5", { input: "image" }),
      unfitWords("Parakeet", { input: "text" }),
      unfitWords("Qwen 3.5", "tools"),
      unfitWords("Qwen 3.5", "context"),
      unfitWords("Gemini 3.8 Flash", "leaves"),
      unfitWords("EmbeddingGemma 2", "output"),
    ]).toEqual([
      "GPT-6 Luna can't hear audio",
      "Qwen 3.5 can't see photos",
      "Parakeet only writes out audio",
      "Qwen 3.5 can't search your record",
      "Qwen 3.5 holds too little text for this",
      "Gemini 3.8 Flash sends text off this Mac",
      "EmbeddingGemma 2 doesn't do this",
    ]);
  });
});
