import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { SendFailed, type ListedModel, type Transport } from "../transport.js";
import { complete, keyHeaders } from "./completions.js";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export const OPENROUTER_SECRET = "openrouter";

const THINKING = ["low", "medium", "high"] as const;

const DECLARED: readonly ListedModel[] = [
  {
    model: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash", input: ["text", "image", "audio"], output: "text", tools: true, context_tokens: null,
    thinking: THINKING, ready: true, suggested: ["pictures", "text"],
  },
  {
    model: "openai/gpt-6-luna", name: "GPT-6 Luna", input: ["text", "image"], output: "text", tools: true, context_tokens: null,
    thinking: THINKING, ready: true, suggested: ["pictures", "text", "chat"],
  },
];

export interface OpenRouterOptions {
  held: () => boolean;
  key: () => string | undefined;
  fetch?: typeof fetch;
}

export function openRouterTransport(options: OpenRouterOptions): Transport {
  const fetcher = options.fetch ?? fetch;
  return {
    name: "openrouter",
    provider: "OpenRouter",
    cost: "priced",
    leaves: "OpenRouter",
    chat: "door",
    defaults: { effort: "low", sampling: { temperature: 0 }, timeout_ms: 120_000, concurrency: 4 },
    models: async () => [...DECLARED],
    reach: () => ({ url: ENDPOINT, headers: keyHeaders(options.key()), effort: "reasoning" }),
    async available() {
      return options.held() ? { ok: true } : { ok: false, reason: "no_key", detail: "openrouter has no API key" };
    },
    async send(request, attachments) {
      const key = options.key();
      if (key === undefined || key.length === 0) throw new SendFailed("openrouter", "openrouter has no API key", null);
      if (request.sampling === undefined) throw new Error("openrouter needs sampling with a finite temperature");
      const content = [
        ...attachments.filter((file) => file.media_type.startsWith("audio/")).map((file) => ({
          type: "input_audio",
          input_audio: { data: readFileSync(file.path).toString("base64"), format: extname(file.path).slice(1).toLowerCase() },
        })),
        ...attachments.filter((file) => file.media_type.startsWith("image/")).map((file) => ({
          type: "image_url",
          image_url: { url: `data:${file.media_type};base64,${readFileSync(file.path).toString("base64")}` },
        })),
        { type: "text", text: request.input },
      ];
      const answer = await complete({
        transport: "openrouter", endpoint: ENDPOINT, fetch: fetcher, signal: request.signal,
        headers: { Authorization: `Bearer ${key}` },
        body: {
          model: request.model,
          usage: { include: true },
          temperature: request.sampling.temperature,
          ...(request.sampling.seed === undefined ? {} : { seed: request.sampling.seed }),
          ...(request.effort === "none" ? {} : { reasoning: { effort: request.effort } }),
          messages: [{ role: "user", content }],
        },
      });
      return { ...answer, model: request.model };
    },
  };
}
