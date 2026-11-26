import type { Sampling } from "./digest.js";
import type { UseId } from "./uses.js";

export type Input = "text" | "image" | "audio";
export type Output = "text" | "vectors" | "marks";

export const MODEL_INPUTS: readonly Input[] = ["text", "image", "audio"];
export const MODEL_OUTPUTS: readonly Output[] = ["text", "vectors", "marks"];

export interface Abilities {
  input: readonly Input[];
  output: Output;
  tools: boolean;
  context_tokens: number | null;
  thinking: readonly string[];
}

export interface ListedModel extends Abilities {
  model: string;
  name: string;
  ready: boolean;
  suggested?: readonly UseId[];
  runner?: { unit: string; name: string; battery: boolean };
}

export type ChatEffort = "reasoning_effort" | "reasoning";

export type ChatReach = { url: string; headers: Record<string, string>; effort: ChatEffort } | { runner: string; file: string };

export interface Transport {
  readonly name: string;
  readonly provider: string;
  readonly cost: "plan" | "priced" | "free";
  readonly leaves: string | null;
  readonly chat: "door" | "program" | null;
  readonly defaults: RequestDefaults;
  models(): Promise<ListedModel[]>;
  available(): Promise<{ ok: true } | { ok: false; reason: Unavailable; detail: string; until_ms?: number }>;
  send(request: SendRequest, attachments: SendAttachment[]): Promise<Sent>;
  reach?(model: string, runner?: string): ChatReach;
}

export type Unavailable = "no_program" | "unusable" | "signed_out" | "no_key" | "away";

export interface RequestDefaults {
  effort: string;
  sampling?: Sampling;
  timeout_ms: number;
  concurrency: number;
}

export interface SendRequest {
  model: string;
  effort: string;
  sampling?: Sampling;
  input: string;
  schema?: string;
  runner?: string;
  line?: "chat";
  signal: AbortSignal;
}

export interface SendAttachment {
  path: string;
  media_type: string;
}

export interface Sent {
  text: string;
  model: string;
  cost?: number;
  input_tokens?: number;
  output_tokens?: number;
}

export class SendFailed extends Error {
  readonly limit?: { readonly resets_ms?: number };
  readonly until_ms?: number;
  readonly scope?: "runner" | "route";
  readonly yielded?: true;
  constructor(
    readonly transport: string,
    message: string,
    readonly status: number | null,
    options?: { cause?: unknown; limit?: { resets_ms?: number }; until_ms?: number; scope?: "runner" | "route"; yielded?: true },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SendFailed";
    if (options?.limit !== undefined) this.limit = options.limit;
    if (options?.until_ms !== undefined) this.until_ms = options.until_ms;
    if (options?.scope !== undefined) this.scope = options.scope;
    if (options?.yielded === true) this.yielded = true;
  }
}

export const NO_SPEECH = "[no speech]";

export function transcript(text: string): string {
  return text.trim() === "" ? NO_SPEECH : text;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const REASON_CHARS = 300;

export function bounded(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  const chars = [...line];
  return chars.length <= REASON_CHARS ? line : `…${chars.slice(chars.length - REASON_CHARS + 1).join("").trimStart()}`;
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/heic": ".heic", "image/gif": ".gif", "image/webp": ".webp",
  "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav",
  "audio/ogg": ".ogg", "audio/aac": ".aac", "audio/flac": ".flac", "audio/opus": ".opus", "audio/x-caf": ".caf",
};

export function extensionOf(mediaType: string): string {
  const extension = EXTENSIONS[mediaType.toLowerCase()];
  if (extension === undefined) throw new TypeError(`no file extension is known for ${mediaType}`);
  return extension;
}

export function mediaTypeOf(kind: "image" | "audio", extension: string): string {
  const lower = extension.toLowerCase();
  const known = Object.entries(EXTENSIONS).find(([type, ext]) => ext === lower && type.startsWith(`${kind}/`));
  return known?.[0] ?? (lower === ".jpeg" ? "image/jpeg" : `${kind}/${lower.slice(1)}`);
}
