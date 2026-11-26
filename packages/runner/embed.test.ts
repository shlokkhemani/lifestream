import { describe, expect, it } from "vitest";
import { EMBED_TEXTS, embedAnswerOf, embedAskOf, vectorOf, vectorText } from "@lifestreamprotocol/model";
import { cut, embedAnswer, EMBEDDINGGEMMA_2_EMBEDS } from "./embed.js";
import { FILES, OLLAMA, type OllamaRow } from "./files.js";
import { fakeLibrary } from "./test/fake-library.js";

const ROW = FILES.find((row) => row.id === "embeddinggemma-2-q8-512") as OllamaRow;
const signal = new AbortController().signal;
const dot = (a: Float32Array, b: Float32Array): number => a.reduce((sum, value, at) => sum + value * b[at]!, 0);

describe("the embedding row", () => {
  it("names EmbeddingGemma 2's q8_0 text tag on Apple silicon, the layer types its pinned Ollama runs, its bytes the build's and its manifest's as the registry served it", () => {
    expect([ROW.library, ROW.platforms, ROW.input, ROW.output, ROW.context_tokens, ROW.source.model, ROW.source.registry, ROW.source.layers]).toEqual([
      "ollama", ["darwin-arm64"], ["text"], "vectors", 2_048, "embeddinggemma-2:270m-q8_0-text", "https://registry.ollama.ai/v2/library/embeddinggemma-2",
      ["application/vnd.docker.container.image.v1+json", "application/vnd.ollama.image.model"],
    ]);
    expect(ROW.bytes).toBe(OLLAMA.artifact.bytes + 158 + 303_957_280);
    expect(ROW.embed).toEqual({ dimensions: 512, prompts: { query: "task: search result | query: ", document: "title: none | text: " } });
    expect(ROW.embed).toBe(EMBEDDINGGEMMA_2_EMBEDS);
  });
});

describe("a vector's cut", () => {
  it("keeps the leading dimensions and makes them unit length", () => {
    const vector = cut([3, 4, 12, 100], 2);
    expect([...vector]).toEqual([Math.fround(0.6), Math.fround(0.8)]);
    const long = cut(Array.from({ length: 768 }, (_, at) => Math.sin(at + 1)), 512);
    expect(long).toHaveLength(512);
    expect(dot(long, long)).toBeCloseTo(1, 5);
  });

  it("refuses a vector shorter than the cut, or one with no length", () => {
    expect(() => cut([1, 2], 3)).toThrow(expect.objectContaining({ name: "Failed", reason: "failed" }));
    expect(() => cut([0, 0, 5], 2)).toThrow(expect.objectContaining({ name: "Failed", reason: "failed" }));
  });
});

describe("the embedding's wire", () => {
  it("takes an ask of a role and 1 to a batch of texts, and nothing else", () => {
    expect(embedAskOf(JSON.stringify({ role: "query", texts: ["power bill"] }))).toEqual({ role: "query", texts: ["power bill"] });
    expect(embedAskOf(JSON.stringify({ role: "document", texts: Array(EMBED_TEXTS).fill("a") }))?.texts).toHaveLength(EMBED_TEXTS);
    for (const input of [
      JSON.stringify({ role: "document", texts: Array(EMBED_TEXTS + 1).fill("a") }), JSON.stringify({ role: "document", texts: [] }),
      JSON.stringify({ role: "title", texts: ["a"] }), JSON.stringify({ role: "query", texts: [1] }), JSON.stringify(["a"]), "not json",
    ]) expect(embedAskOf(input)).toBeNull();
  });

  it("carries each vector as little-endian float32 in base64, read back whole, and refuses an answer of another count, dimension or bytes", () => {
    const vector = cut([1, 2, 3, 4], 4);
    expect(Buffer.from(vectorText(vector), "base64").readFloatLE(4)).toBe(vector[1]);
    expect(vectorOf(vectorText(vector), 4)).toEqual(vector);
    const text = embedAnswer([[1, 0, 0, 9], [0, 2, 0, 9]], 3);
    expect(JSON.parse(text)).toMatchObject({ dimensions: 3 });
    expect(embedAnswerOf(text, 2)?.map((each) => [...each])).toEqual([[1, 0, 0], [0, 1, 0]]);
    expect(embedAnswerOf(text, 1)).toBeNull();
    expect(embedAnswerOf(JSON.stringify({ dimensions: 4, vectors: JSON.parse(text).vectors }), 2)).toBeNull();
    expect(embedAnswerOf(JSON.stringify({ dimensions: 3, vectors: ["not base64!"] }), 1)).toBeNull();
    expect(embedAnswerOf(JSON.stringify({ dimensions: 1, vectors: [vectorText(Float32Array.of(Number.NaN))] }), 1)).toBeNull();
  });
});

describe("the fake library's embeddings", () => {
  it("answers each text a unit vector of the row's dimensions, the same text the same, another text or role another; and no embedding at all is refused", async () => {
    const library = fakeLibrary();
    const ask = (role: string, texts: string[]) => library.run(ROW, { id: "e", model: ROW.id, input: JSON.stringify({ role, texts }), attachments: [] }, signal);
    const answer = await ask("document", ["one", "two", "one"]);
    expect(answer.model).toBe(ROW.id);
    const [one, two, again] = embedAnswerOf(answer.text, 3)!;
    expect(one).toHaveLength(512);
    expect(dot(one!, one!)).toBeCloseTo(1, 5);
    expect(again).toEqual(one);
    expect(two).not.toEqual(one);
    const [asked] = embedAnswerOf((await ask("query", ["one"])).text, 1)!;
    expect(asked).not.toEqual(one);
    await expect(library.run(ROW, { id: "x", model: ROW.id, input: "Describe this photo.", attachments: [] }, signal)).rejects.toMatchObject({ name: "Failed", reason: "failed" });
  });
});
