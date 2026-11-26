import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { LIST_MS, SendFailed, transcript, withListed, type Input, type ListedModel, type SendAttachment, type SendRequest, type Sent, type Transport } from "../transport.js";
import { complete, getList, keyHeaders, post, record } from "./completions.js";

const API = "https://openrouter.ai/api/v1";
const ENDPOINT = `${API}/chat/completions`;

export const OPENROUTER_SECRET = "openrouter";

const THINKING = ["low", "medium", "high"] as const;

type Endpoint = "/chat/completions" | "/audio/transcriptions";

const DECLARED: readonly (ListedModel & { endpoint: Endpoint })[] = [
  {
    model: "elevenlabs/scribe-v2", name: "Scribe v2", input: ["audio"], output: "text", tools: false, context_tokens: null,
    thinking: [], ready: true, suggested: ["audio"], request: { effort: "none" }, endpoint: "/audio/transcriptions",
  },
  {
    model: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash", input: ["text", "image", "audio"], output: "text", tools: true, context_tokens: null,
    thinking: THINKING, ready: true, suggested: ["pictures", "text"], endpoint: "/chat/completions",
  },
  {
    model: "openai/gpt-6-luna", name: "GPT-6 Luna", input: ["text", "image"], output: "text", tools: true, context_tokens: null,
    thinking: THINKING, ready: true, suggested: ["pictures", "text", "chat"], endpoint: "/chat/completions",
  },
];

export interface OpenRouterOptions {
  held: () => boolean;
  key: () => string | undefined;
  listed?: readonly ListedModel[];
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
    models: async () => withListed(DECLARED.map(({ endpoint: _, ...row }) => row), options.listed ?? []),
    list: async () => catalog(await getList("openrouter", `${API}/models`, fetcher, {})),
    reach: () => ({ url: ENDPOINT, headers: keyHeaders(options.key()), effort: "reasoning" }),
    async available() {
      return options.held() ? { ok: true } : { ok: false, reason: "no_key", detail: "openrouter has no API key" };
    },
    async send(request, attachments) {
      const key = options.key();
      if (key === undefined || key.length === 0) throw new SendFailed("openrouter", "openrouter has no API key", null);
      const endpoint = DECLARED.find((row) => row.model === request.model)?.endpoint ?? "/chat/completions";
      return endpoint === "/audio/transcriptions" ? transcribed(fetcher, key, request, attachments) : completed(fetcher, key, request, attachments);
    },
  };
}

const MODALITIES: readonly Input[] = ["text", "image", "audio"];

function catalog(root: Record<string, unknown>): ListedModel[] {
  if (!Array.isArray(root.data)) throw new Error("openrouter's list states no data");
  return root.data.flatMap((each): ListedModel[] => {
    const model = record(each);
    if (typeof model?.id !== "string" || model.id === "") return [];
    const architecture = record(model.architecture);
    const stated = (value: unknown) => Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : null;
    const inputs = stated(architecture?.input_modalities) ?? ["text"];
    const outputs = stated(architecture?.output_modalities) ?? ["text"];
    if (!inputs.includes("text") || !outputs.includes("text")) return [];
    const parameters = stated(model.supported_parameters) ?? [];
    const context = model.context_length;
    return [{
      model: model.id, name: typeof model.name === "string" && model.name !== "" ? model.name : model.id,
      input: MODALITIES.filter((modality) => inputs.includes(modality)), output: "text", tools: parameters.includes("tools"),
      context_tokens: typeof context === "number" && Number.isSafeInteger(context) && context > 0 ? context : null,
      thinking: parameters.includes("reasoning") ? THINKING : [], ready: true,
    }];
  });
}

async function completed(fetcher: typeof fetch, key: string, request: SendRequest, attachments: SendAttachment[]): Promise<Sent> {
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
}

async function transcribed(fetcher: typeof fetch, key: string, request: SendRequest, attachments: SendAttachment[]): Promise<Sent> {
  const audio = attachments.filter((file) => file.media_type.startsWith("audio/"));
  const other = attachments.find((file) => !file.media_type.startsWith("audio/"));
  if (audio.length !== 1 || other !== undefined) {
    throw new Error(`openrouter writes out one audio file with ${request.model}, not ${other?.media_type ?? `${audio.length} audio files`}`);
  }
  const note = audio[0]!;
  const text = await post({
    transport: "openrouter", endpoint: `${API}/audio/transcriptions`, fetch: fetcher, signal: request.signal,
    headers: { Authorization: `Bearer ${key}` },
    body: { model: request.model, input_audio: { data: readFileSync(note.path).toString("base64"), format: extname(note.path).slice(1).toLowerCase() } },
  });
  return { ...transcriptOf(text), model: request.model };
}

function transcriptOf(text: string): { text: string; cost?: number; input_tokens?: number; output_tokens?: number } {
  let root: unknown;
  try { root = JSON.parse(text); } catch { throw new Error("openrouter reply is not JSON"); }
  const object = record(root);
  const usage = record(object?.usage);
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const input = count(usage?.input_tokens);
  const output = count(usage?.output_tokens);
  const cost = usage?.cost;
  if (typeof object?.text !== "string") throw new Error("openrouter reply states no text");
  return {
    text: transcript(object.text),
    ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { cost } : {}),
    ...(input === undefined ? {} : { input_tokens: input }),
    ...(output === undefined ? {} : { output_tokens: output }),
  };
}
