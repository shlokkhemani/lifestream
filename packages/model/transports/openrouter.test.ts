import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SendFailed } from "../transport.js";
import { TIMED_TRANSCRIPT } from "../transcript.js";
import { OPENROUTER_SECRET, openRouterTransport } from "./openrouter.js";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const KEY = "synthetic-openrouter-key";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

function played() {
  const posts: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    posts.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return Response.json({ choices: [{ message: { content: "a synthetic answer" } }], usage: { prompt_tokens: 12, completion_tokens: 4, cost: 0.0002 } });
  }) as typeof fetch;
  return { posts, fetcher };
}

describe("the OpenRouter transport", () => {
  it("lists its declared rows with their abilities and asks OpenRouter for nothing to list them", async () => {
    const { posts, fetcher } = played();
    const transport = openRouterTransport({ held: () => true, key: () => KEY, fetch: fetcher });
    expect([transport.name, transport.cost, transport.leaves, transport.chat, OPENROUTER_SECRET]).toEqual(["openrouter", "priced", "OpenRouter", "door", "openrouter"]);
    expect((await transport.models()).map(({ model, input, output, tools, timed, context_tokens, ready }) => ({ model, input, output, tools, timed, context_tokens, ready }))).toEqual([
      { model: "elevenlabs/scribe-v2", input: ["audio"], output: "text", tools: false, timed: false, context_tokens: null, ready: true },
      { model: "google/gemini-3.8-flash", input: ["text", "image", "audio"], output: "text", tools: true, timed: true, context_tokens: null, ready: true },
      { model: "openai/gpt-6-luna", input: ["text", "image"], output: "text", tools: true, timed: false, context_tokens: null, ready: true },
    ]);
    expect(posts).toEqual([]);
  });

  it("sends Gemini a photo and a voice note on the chat endpoint, under its one key, and answers with what it cost", async () => {
    const folder = mkdtempSync(join(tmpdir(), "lifestream-openrouter-"));
    folders.push(folder);
    writeFileSync(join(folder, "photo.jpg"), "synthetic jpeg bytes");
    writeFileSync(join(folder, "note.m4a"), "synthetic m4a bytes");
    const { posts, fetcher } = played();
    const transport = openRouterTransport({ held: () => true, key: () => KEY, fetch: fetcher });
    const sent = await transport.send(
      { model: "google/gemini-3.8-flash", effort: "low", sampling: { temperature: 0 }, input: "Describe this.", signal: new AbortController().signal },
      [{ path: join(folder, "photo.jpg"), media_type: "image/jpeg" }, { path: join(folder, "note.m4a"), media_type: "audio/mp4" }],
    );
    expect(sent).toEqual({ text: "a synthetic answer", model: "google/gemini-3.8-flash", cost: 0.0002, input_tokens: 12, output_tokens: 4 });
    expect(posts).toEqual([{
      url: ENDPOINT,
      headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: {
        model: "google/gemini-3.8-flash", usage: { include: true }, temperature: 0, reasoning: { effort: "low" },
        messages: [{ role: "user", content: [
          { type: "input_audio", input_audio: { data: Buffer.from("synthetic m4a bytes").toString("base64"), format: "m4a" } },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from("synthetic jpeg bytes").toString("base64")}` } },
          { type: "text", text: "Describe this." },
        ] }],
      },
    }]);
  });

  it("sends Gemini a timed request as any JSON prompt, the schema left to the prompt's words, and answers the timed transcript's JSON as the model wrote it", async () => {
    const folder = mkdtempSync(join(tmpdir(), "lifestream-openrouter-"));
    folders.push(folder);
    writeFileSync(join(folder, "part.m4a"), "synthetic m4a bytes");
    writeFileSync(join(folder, "schema.json"), JSON.stringify(TIMED_TRANSCRIPT));
    const answer = JSON.stringify({ segments: [{ start_s: 0.4, end_s: 2.1, text: "A synthetic sentence." }] });
    const posts: Record<string, unknown>[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ choices: [{ message: { content: answer } }] });
    }) as typeof fetch;
    const transport = openRouterTransport({ held: () => true, key: () => KEY, fetch: fetcher });
    const sent = await transport.send(
      { model: "google/gemini-3.8-flash", effort: "low", sampling: { temperature: 0 }, input: "Transcribe this.", schema: join(folder, "schema.json"), signal: new AbortController().signal },
      [{ path: join(folder, "part.m4a"), media_type: "audio/mp4" }],
    );
    expect(sent.text).toBe(answer);
    expect(posts.map((body) => Object.keys(body).sort())).toEqual([["messages", "model", "reasoning", "temperature", "usage"]]);
  });

  it("sends Scribe v2, named by its model alone, a voice note on the transcriptions endpoint, asked at no effort, and every other model on the chat endpoint", async () => {
    const folder = mkdtempSync(join(tmpdir(), "lifestream-openrouter-"));
    folders.push(folder);
    writeFileSync(join(folder, "note.m4a"), "synthetic m4a bytes");
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return url.endsWith("/audio/transcriptions")
        ? Response.json({ text: "a synthetic note's words", usage: { cost: 0.0015 } })
        : Response.json({ choices: [{ message: { content: "a synthetic answer" } }] });
    }) as typeof fetch;
    const transport = openRouterTransport({ held: () => true, key: () => KEY, fetch: fetcher });
    expect((await transport.models()).find((model) => model.model === "elevenlabs/scribe-v2")?.request).toEqual({ effort: "none" });
    const note = [{ path: join(folder, "note.m4a"), media_type: "audio/mp4" }];
    const signal = new AbortController().signal;
    expect(await transport.send({ model: "elevenlabs/scribe-v2", effort: "none", input: "", signal }, note))
      .toEqual({ text: "a synthetic note's words", model: "elevenlabs/scribe-v2", cost: 0.0015 });
    await transport.send({ model: "google/gemini-3.8-flash", effort: "low", sampling: { temperature: 0 }, input: "Write this out.", signal }, note);
    await transport.send({ model: "synthetic/listed-model", effort: "low", sampling: { temperature: 0 }, input: "Sum this up.", signal }, []);
    expect(posts.map((post) => [post.url, post.body.model])).toEqual([
      ["https://openrouter.ai/api/v1/audio/transcriptions", "elevenlabs/scribe-v2"],
      [ENDPOINT, "google/gemini-3.8-flash"],
      [ENDPOINT, "synthetic/listed-model"],
    ]);
    expect(posts[0]!.body).toEqual({ model: "elevenlabs/scribe-v2", input_audio: { data: Buffer.from("synthetic m4a bytes").toString("base64"), format: "m4a" } });
  });

  it("tells Chat where a model is reached with the key, that its thinking level is OpenRouter's reasoning member, and sends nothing without one", async () => {
    const { posts, fetcher } = played();
    const keyed = openRouterTransport({ held: () => true, key: () => KEY, fetch: fetcher });
    expect(keyed.reach?.("openai/gpt-6-luna")).toEqual({ url: ENDPOINT, headers: { Authorization: `Bearer ${KEY}` }, effort: "reasoning" });
    const keyless = openRouterTransport({ held: () => false, key: () => undefined, fetch: fetcher });
    expect(await keyless.available()).toEqual({ ok: false, reason: "no_key", detail: "openrouter has no API key" });
    await expect(keyless.send({ model: "openai/gpt-6-luna", effort: "low", sampling: { temperature: 0 }, input: "Sum this up.", signal: new AbortController().signal }, []))
      .rejects.toBeInstanceOf(SendFailed);
    expect(posts).toEqual([]);
  });

  it("lists OpenRouter's catalog: abilities from its fields, text only where a field is unknown, no model that takes no text, and a declared row over a listed one", async () => {
    const asked: string[] = [];
    const catalog = {
      data: [
        { id: "vendor-a/seeing-1", name: "Vendor A: Seeing One", context_length: 128_000, architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] }, supported_parameters: ["tools", "reasoning", "temperature"] },
        { id: "vendor-b/plain-1", name: "Vendor B: Plain One", shape: "a field no reader knows" },
        { id: "vendor-c/drawing-1", name: "Vendor C: Drawing One", architecture: { input_modalities: ["image"], output_modalities: ["image"] } },
        { id: "openai/gpt-6-luna", name: "OpenAI: GPT-6 Luna", context_length: 400_000, architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: [] },
        { id: "vendor-d/hearing-1", name: "Vendor D: Hearing One", architecture: { input_modalities: ["text", "audio"], output_modalities: ["text"] } },
      ],
    };
    const fetcher = (async (url: string) => { asked.push(url); return Response.json(catalog); }) as typeof fetch;
    const listed = await openRouterTransport({ held: () => true, key: () => KEY, fetch: fetcher }).list!();
    expect(asked).toEqual(["https://openrouter.ai/api/v1/models"]);
    expect(listed.map(({ model, input, tools, timed, context_tokens, thinking }) => ({ model, input, tools, timed, context_tokens, thinking }))).toEqual([
      { model: "vendor-a/seeing-1", input: ["text", "image"], tools: true, timed: false, context_tokens: 128_000, thinking: ["low", "medium", "high"] },
      { model: "vendor-b/plain-1", input: ["text"], tools: false, timed: false, context_tokens: null, thinking: [] },
      { model: "openai/gpt-6-luna", input: ["text"], tools: false, timed: false, context_tokens: 400_000, thinking: [] },
      { model: "vendor-d/hearing-1", input: ["text", "audio"], tools: false, timed: true, context_tokens: null, thinking: [] },
    ]);
    const models = await openRouterTransport({ held: () => true, key: () => KEY, fetch: fetcher, listed }).models();
    expect(models.map((model) => model.model)).toEqual(["elevenlabs/scribe-v2", "google/gemini-3.8-flash", "openai/gpt-6-luna", "vendor-a/seeing-1", "vendor-b/plain-1", "vendor-d/hearing-1"]);
    expect(models.find((model) => model.model === "openai/gpt-6-luna")).toMatchObject({ input: ["text", "image"], tools: true, suggested: ["pictures", "text", "chat"] });
  });

  it("a list that fails says so, and its rows stay the declared three", async () => {
    const down = (async () => new Response("a synthetic outage", { status: 503 })) as unknown as typeof fetch;
    await expect(openRouterTransport({ held: () => true, key: () => KEY, fetch: down }).list!()).rejects.toThrow("HTTP 503");
    const shapeless = (async () => Response.json({ models: [] })) as unknown as typeof fetch;
    await expect(openRouterTransport({ held: () => true, key: () => KEY, fetch: shapeless }).list!()).rejects.toThrow("states no data");
    expect((await openRouterTransport({ held: () => true, key: () => KEY, fetch: down }).models()).map((model) => model.model)).toEqual(["elevenlabs/scribe-v2", "google/gemini-3.8-flash", "openai/gpt-6-luna"]);
  });
});
