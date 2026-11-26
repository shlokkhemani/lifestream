import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SendFailed } from "../transport.js";
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
    expect((await transport.models()).map(({ model, input, output, tools, context_tokens, ready }) => ({ model, input, output, tools, context_tokens, ready }))).toEqual([
      { model: "google/gemini-3.8-flash", input: ["text", "image", "audio"], output: "text", tools: true, context_tokens: null, ready: true },
      { model: "openai/gpt-6-luna", input: ["text", "image"], output: "text", tools: true, context_tokens: null, ready: true },
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
});
