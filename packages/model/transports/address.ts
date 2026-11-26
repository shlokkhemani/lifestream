import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { SendFailed, type Input, type Transport } from "../transport.js";
import type { WorkKind } from "../uses.js";
import { complete, keyHeaders } from "./completions.js";

export interface AddressSettings {
  url: string;
  model: string;
  kinds: readonly WorkKind[];
  secret?: string;
}

export interface AddressOptions extends AddressSettings {
  held: () => boolean;
  key: () => string | undefined;
  fetch?: typeof fetch;
}

export function addressTransport(options: AddressOptions): Transport {
  const fetcher = options.fetch ?? fetch;
  const endpoint = `${options.url.replace(/\/+$/u, "")}/chat/completions`;
  const host = new URL(options.url).hostname;
  return {
    name: "address",
    provider: "the custom address",
    cost: "free",
    leaves: loopback(host) ? null : host,
    chat: "door",
    defaults: { effort: "none", sampling: { temperature: 0 }, timeout_ms: 120_000, concurrency: 1 },
    models: async () => [{ model: options.model, name: options.model, input: inputOf(options.kinds), output: "text", tools: true, context_tokens: null, thinking: [], ready: true }],
    reach: () => ({ url: endpoint, headers: keyHeaders(options.key()), effort: "reasoning_effort" }),
    async available() {
      return options.held() ? { ok: true } : { ok: false, reason: "no_key", detail: `the address's key ${options.secret} is not set` };
    },
    async send(request, attachments) {
      const key = options.key();
      if (options.secret !== undefined && (key === undefined || key.length === 0)) throw new SendFailed("address", `the address's key ${options.secret} is not set`, null);
      const refused = attachments.find((file) => !file.media_type.startsWith("image/"));
      if (refused !== undefined) throw new Error(`the address takes images only, not ${refused.media_type}`);
      const answer = await complete({
        transport: "address", endpoint, fetch: fetcher, signal: request.signal,
        headers: keyHeaders(key),
        body: {
          model: request.model,
          ...(request.sampling === undefined ? {} : { temperature: request.sampling.temperature }),
          ...(request.sampling?.seed === undefined ? {} : { seed: request.sampling.seed }),
          ...(request.effort === "none" ? {} : { reasoning_effort: request.effort }),
          messages: [{
            role: "user",
            content: [
              ...attachments.map((file) => ({ type: "image_url", image_url: { url: `data:${file.media_type};base64,${readFileSync(file.path).toString("base64")}` } })),
              { type: "text", text: request.input },
            ],
          }],
        },
      });
      return { ...answer, model: request.model };
    },
  };
}

function inputOf(kinds: readonly WorkKind[]): Input[] {
  return kinds.includes("pictures") ? ["text", "image"] : ["text"];
}

function loopback(host: string): boolean {
  return host === "localhost" || host === "[::1]" || (isIP(host) === 4 && host.startsWith("127."));
}
