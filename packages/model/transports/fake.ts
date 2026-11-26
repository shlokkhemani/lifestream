import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { SendFailed, type ChatEffort, type ListedModel, type RequestDefaults, type SendAttachment, type SendRequest, type Sent, type Transport, type Unavailable } from "../transport.js";
import { keyHeaders } from "./completions.js";

export interface FakeOptions {
  provider?: string;
  leaves?: string;
  reply?: string | ((request: SendRequest, attachments: SendAttachment[]) => string | Promise<string>);
  delay_ms?: number;
  cost_usd?: number;
  cost?: Transport["cost"];
  fail?: string;
  status?: number;
  unavailable?: string;
  reason?: Unavailable;
  until_ms?: number;
  models?: ListedModel[];
  log?: string;
  reach?: { url: string; effort: ChatEffort; key?: string };
}

const DEFAULTS: RequestDefaults = { effort: "low", timeout_ms: 120_000, concurrency: 8 };

export function fakeTransport(options: FakeOptions = {}): Transport {
  const reach = options.reach;
  return {
    name: "fake",
    provider: options.provider ?? "the test model",
    cost: options.cost ?? (options.cost_usd === undefined ? "free" : "priced"),
    leaves: options.leaves ?? null,
    chat: reach === undefined ? null : "door",
    defaults: DEFAULTS,
    models: async () => [...options.models ?? []],
    ...(reach === undefined ? {} : { reach: () => ({ url: reach.url, headers: keyHeaders(reach.key), effort: reach.effort }) }),
    async available() {
      if (options.unavailable === undefined) return { ok: true };
      return { ok: false, reason: options.reason ?? "away", detail: options.unavailable, ...(options.until_ms === undefined ? {} : { until_ms: options.until_ms }) };
    },
    async send(request, attachments): Promise<Sent> {
      if (options.unavailable !== undefined) throw new SendFailed("fake", options.unavailable, null);
      if (options.delay_ms !== undefined) await sleep(options.delay_ms, request.signal);
      if (options.fail !== undefined) throw options.status === undefined ? new Error(options.fail) : new SendFailed("fake", options.fail, options.status);
      if (options.log !== undefined) {
        const files = attachments.map((file) => ({ media_type: file.media_type, bytes: readFileSync(file.path).toString("base64") }));
        appendFileSync(options.log, `${JSON.stringify({ model: request.model, input: request.input, attachments: files })}\n`);
      }
      const reply = options.reply;
      const said = `fake reply ${createHash("sha256").update(request.input).digest("hex").slice(0, 12)}`;
      const text = reply !== undefined ? typeof reply === "string" ? reply : await reply(request, attachments)
        : request.schema === undefined ? said : JSON.stringify(smallest(JSON.parse(readFileSync(request.schema, "utf8")) as Schema, said));
      return { text, model: request.model, ...(options.cost_usd === undefined ? {} : { cost: options.cost_usd }) };
    },
  };
}

interface Schema { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; enum?: unknown[]; const?: unknown }

function smallest(schema: Schema, said: string): unknown {
  if ("const" in schema) return schema.const;
  if (schema.enum !== undefined) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "object") return Object.fromEntries((schema.required ?? []).map((key) => [key, smallest(schema.properties?.[key] ?? {}, said)]));
  if (type === "array") return [];
  if (type === "number" || type === "integer") return 0;
  if (type === "boolean") return false;
  if (type === "null") return null;
  return said;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
}
