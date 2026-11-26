import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { SendFailed, type Input, type ListedModel, type Transport } from "../transport.js";
import { complete, getList, keyHeaders, record } from "./completions.js";

export const ADDRESS_SECRET = "address";

export interface AddressSettings {
  url: string;
  secret?: string;
  input?: readonly Input[];
  model?: string;
}

export interface AddressOptions extends AddressSettings {
  listed?: readonly ListedModel[];
  held: () => boolean;
  key: () => string | undefined;
  fetch?: typeof fetch;
}

export function addressTransport(options: AddressOptions): Transport {
  const fetcher = options.fetch ?? fetch;
  const base = options.url.replace(/\/+$/u, "");
  const endpoint = `${base}/chat/completions`;
  const input = options.input ?? ["text"];
  const host = new URL(options.url).hostname;
  return {
    name: "address",
    provider: "the custom address",
    cost: "free",
    leaves: loopback(host) ? null : host,
    chat: "door",
    defaults: { effort: "none", sampling: { temperature: 0 }, timeout_ms: 120_000, concurrency: 1 },
    models: async () => declaredFirst(options.model, options.listed ?? []).map((row) => ({ ...row, input })),
    list: async () => namesOf(await getList("address", `${base}/models`, fetcher, keyHeaders(options.key())), input),
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

function namesOf(root: Record<string, unknown>, input: readonly Input[]): ListedModel[] {
  if (!Array.isArray(root.data)) throw new Error("the address's list states no data");
  const ids = root.data.map((each) => record(each)?.id).filter((id): id is string => typeof id === "string" && id !== "");
  return [...new Set(ids)].map((id) => rowOf(id, input));
}

function rowOf(id: string, input: readonly Input[]): ListedModel {
  return { model: id, name: id, input, output: "text", tools: true, timed: false, context_tokens: null, thinking: [], ready: true };
}

function declaredFirst(model: string | undefined, listed: readonly ListedModel[]): readonly ListedModel[] {
  return model === undefined ? listed : [rowOf(model, ["text"]), ...listed.filter((row) => row.model !== model)];
}

function loopback(host: string): boolean {
  return host === "localhost" || host === "[::1]" || (isIP(host) === 4 && host.startsWith("127."));
}
