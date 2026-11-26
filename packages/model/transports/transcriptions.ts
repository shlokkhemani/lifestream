import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { SendFailed, transcript, type ListedModel, type Transport } from "../transport.js";
import { post, record } from "./completions.js";
import { OPENROUTER_SECRET } from "./openrouter.js";


const ENDPOINT = "https://openrouter.ai/api/v1/audio/transcriptions";

export const CLOUD_VOICE = { transport: "openrouter-voice", model: "elevenlabs/scribe-v2" } as const;

const DECLARED: readonly ListedModel[] = [{
  model: CLOUD_VOICE.model, name: "Scribe v2", input: ["audio"], output: "text", tools: false, context_tokens: null, thinking: [], ready: true, suggested: ["audio"],
}];

export interface TranscriptionsOptions {
  held: () => boolean;
  key: () => string | undefined;
  fetch?: typeof fetch;
}

export function transcriptionsTransport(options: TranscriptionsOptions): Transport {
  const fetcher = options.fetch ?? fetch;
  const name = CLOUD_VOICE.transport;
  return {
    name,
    provider: "OpenRouter",
    cost: "priced",
    leaves: "OpenRouter",
    chat: null,
    defaults: { effort: "none", timeout_ms: 120_000, concurrency: 4 },
    models: async () => [...DECLARED],
    async available() {
      return options.held() ? { ok: true } : { ok: false, reason: "no_key", detail: `${name} has no OpenRouter key` };
    },
    async send(request, attachments) {
      const key = options.key();
      if (key === undefined || key.length === 0) throw new SendFailed(name, `${name} has no OpenRouter key`, null);
      const audio = attachments.filter((file) => file.media_type.startsWith("audio/"));
      const other = attachments.find((file) => !file.media_type.startsWith("audio/"));
      if (audio.length !== 1 || other !== undefined) {
        throw new Error(`${name} writes out one audio file, not ${other?.media_type ?? `${audio.length} audio files`}`);
      }
      const note = audio[0]!;
      const text = await post({
        transport: name, endpoint: ENDPOINT, fetch: fetcher, signal: request.signal,
        headers: { Authorization: `Bearer ${key}` },
        body: { model: request.model, input_audio: { data: readFileSync(note.path).toString("base64"), format: extname(note.path).slice(1).toLowerCase() } },
      });
      return { ...answerOf(name, text), model: request.model };
    },
  };
}

function answerOf(transport: string, text: string): { text: string; cost?: number; input_tokens?: number; output_tokens?: number } {
  let root: unknown;
  try { root = JSON.parse(text); } catch { throw new Error(`${transport} reply is not JSON`); }
  const object = record(root);
  const usage = record(object?.usage);
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const input = count(usage?.input_tokens);
  const output = count(usage?.output_tokens);
  const cost = usage?.cost;
  if (typeof object?.text !== "string") throw new Error(`${transport} reply states no text`);
  return {
    text: transcript(object.text),
    ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { cost } : {}),
    ...(input === undefined ? {} : { input_tokens: input }),
    ...(output === undefined ? {} : { output_tokens: output }),
  };
}
