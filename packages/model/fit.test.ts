import { describe, expect, it } from "vitest";
import { unfit, type Unfit } from "./fit.js";
import type { Abilities, ListedModel, Transport } from "./transport.js";
import { claudeTransport } from "./transports/claude.js";
import { codexTransport } from "./transports/codex.js";
import { openRouterTransport } from "./transports/openrouter.js";
import { MODEL_USES, USE_IDS, workNeed, type UseId } from "./uses.js";

type Row = Abilities & { leaves: string | null };

const local = (abilities: Partial<Abilities> & Pick<Abilities, "input">): Row =>
  ({ output: "text", tools: false, context_tokens: null, thinking: [], leaves: null, ...abilities });

const RUNNER_ROWS: Readonly<Record<string, Row>> = {
  "Qwen 3.5": local({ input: ["text", "image"], context_tokens: 4_000 }),
  Parakeet: local({ input: ["audio"] }),
  "Nemotron Speech": local({ input: ["audio"] }),
  "EmbeddingGemma 2": local({ input: ["text"], output: "vectors", context_tokens: 2_048 }),
  "Privacy Filter": local({ input: ["text"], output: "marks", context_tokens: 8_000 }),
};

const OPENROUTER = { held: () => true, key: () => "synthetic-openrouter-key" };
const TRANSPORTS: readonly Transport[] = [
  claudeTransport({ claude: undefined }),
  codexTransport({ codex: undefined }),
  openRouterTransport(OPENROUTER),
];

async function declaredRows(): Promise<Record<string, Row>> {
  const rows = await Promise.all(TRANSPORTS.map(async (transport) =>
    (await transport.models()).map((model: ListedModel) => [`${transport.name}:${model.model}`, { ...model, leaves: transport.leaves }] as const)));
  return Object.fromEntries(rows.flat());
}

function table(rows: Readonly<Record<string, Row>>): Record<string, Record<UseId, Unfit | null>> {
  return Object.fromEntries(Object.entries(rows).map(([name, row]) =>
    [name, Object.fromEntries(USE_IDS.map((use) => [use, unfit(row, MODEL_USES[use].need)])) as Record<UseId, Unfit | null>]));
}

const fits = (overrides: Partial<Record<UseId, Unfit>>): Record<UseId, Unfit | null> =>
  ({ pictures: null, audio: null, text: null, chat: null, search: null, hiding: null, ...overrides });

describe("the fit of a model to a use", () => {
  it("takes each runner row for the uses it can do, and refuses it every other with the first need it misses", () => {
    const speech = fits({ pictures: { input: "text" }, text: { input: "text" }, chat: { input: "text" }, search: "output", hiding: "output" });
    expect(table(RUNNER_ROWS)).toEqual({
      "Qwen 3.5": fits({ audio: { input: "audio" }, chat: "tools", search: "output", hiding: "output" }),
      Parakeet: speech,
      "Nemotron Speech": speech,
      "EmbeddingGemma 2": fits({ pictures: "output", audio: "output", text: "output", chat: "output", hiding: "output" }),
      "Privacy Filter": fits({ pictures: "output", audio: "output", text: "output", chat: "output", search: "output" }),
    });
  });

  it("takes each declared row for the uses it can do, and keeps search and hiding on a machine", async () => {
    const plan = fits({ audio: { input: "audio" }, search: "output", hiding: "output" });
    expect(table(await declaredRows())).toEqual({
      "claude:claude-haiku-5-5": plan,
      "claude:claude-opus-5-5": plan,
      "codex:gpt-6-luna": plan,
      "codex:gpt-6.2-sol": plan,
      "openrouter:elevenlabs/scribe-v2": fits({ pictures: { input: "text" }, text: { input: "text" }, chat: { input: "text" }, search: "output", hiding: "output" }),
      "openrouter:google/gemini-3.8-flash": fits({ search: "output", hiding: "output" }),
      "openrouter:openai/gpt-6-luna": plan,
    });
  });

  it("refuses a model that sends its text away for a use that stays, and states the output before the input it misses", () => {
    const vectors = local({ input: ["text"], output: "vectors" });
    expect(unfit(vectors, MODEL_USES.search.need)).toBeNull();
    expect(unfit({ ...vectors, leaves: "OpenRouter" }, MODEL_USES.search.need)).toBe("leaves");
    expect(unfit({ ...vectors, input: ["audio"] }, MODEL_USES.text.need)).toBe("output");
  });

  it("measures a work's characters against a model's tokens, four characters to a token, and takes a window the provider states none of as enough", () => {
    const qwen = RUNNER_ROWS["Qwen 3.5"]!;
    expect(unfit(qwen, workNeed({ kind: "text", text_chars: 500_000 }))).toBe("context");
    expect(unfit(qwen, workNeed({ kind: "text" }))).toBeNull();
    expect(unfit(qwen, workNeed({ kind: "text", text_chars: 16_000 }))).toBeNull();
    expect(unfit(qwen, workNeed({ kind: "text", text_chars: 16_001 }))).toBe("context");
    expect(unfit({ ...qwen, context_tokens: null }, workNeed({ kind: "text", text_chars: 500_000 }))).toBeNull();
    expect(workNeed({ kind: "pictures", text_chars: null })).toEqual(MODEL_USES.pictures.need);
  });
});
