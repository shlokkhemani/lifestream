import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonObject } from "@lifestreamprotocol/core";
import { readRouteId, type ChatEffort } from "@lifestreamprotocol/model";
import { errorText } from "./jobs.js";
import { refuse } from "./refusal.js";

export const CHAT_ROUTE = "/v1/chat/completions";
export const CHAT_BODY_BYTES = 32 * 1024 * 1024;
export const REACH_KEPT_MS = 60_000;
export const HIDDEN = "[hidden]";
export const NO_MODEL_WORDS = "No connection offers this model to Chat.";
export const MOVED_WORDS = "This model's connection changed: ask again.";

export interface Reached {
  url: string;
  headers: Record<string, string>;
  effort: ChatEffort;
  model: string;
  leaves: string | null;
}

export interface ChatRouteOptions {
  reach(model: string, request: IncomingMessage): Promise<Reached>;
  leavesOf(model: string): Promise<string | null | undefined>;
  clock(): number;
  fetch?: typeof fetch;
}

export type ChatRoute = (body: JsonObject, request: IncomingMessage, response: ServerResponse, own: () => void) => Promise<void>;

export function chatRoute(options: ChatRouteOptions): ChatRoute {
  const fetcher = options.fetch ?? fetch;
  const held = new Map<string, { reached: Reached; until_ms: number }>();
  const kept = async (model: string, request: IncomingMessage): Promise<Reached> => {
    const now = options.clock();
    for (const [key, each] of held) if (each.until_ms <= now) held.delete(key);
    const known = held.get(model);
    if (known !== undefined) return known.reached;
    const reached = await options.reach(model, request);
    held.set(model, { reached, until_ms: options.clock() + REACH_KEPT_MS });
    return reached;
  };
  const hiddenFor = async (model: string, request: IncomingMessage): Promise<Reached> => {
    const leaves = await options.leavesOf(model);
    const known = await kept(model, request);
    if (known.leaves === leaves) return known;
    held.delete(model);
    const reached = await kept(model, request);
    if (reached.leaves !== leaves) refuse(409, "NOT_READY", MOVED_WORDS, undefined, { line: MOVED_WORDS });
    return reached;
  };
  return async (body, request, response, own) => {
    const model = body.model;
    if (typeof model !== "string" || model === "") refuse(422, "BAD_REQUEST", "a chat call names its model by the model's id");
    if (readRouteId(model) === null) refuse(404, "NO_MODEL", NO_MODEL_WORDS);
    const reached = await hiddenFor(model, request);
    own();
    const secrets = secretsOf(reached.headers);
    const ended = new AbortController();
    response.once("close", () => ended.abort());
    let upstream: Response;
    try {
      upstream = await fetcher(reached.url, {
        method: "POST", headers: { ...reached.headers, "content-type": "application/json" }, body: JSON.stringify(providerBody(body, reached)), redirect: "error", signal: ended.signal,
      });
    } catch (error) {
      if (ended.signal.aborted) return;
      return refuse(502, "PROVIDER_UNREACHABLE", hideText(`The model's provider could not be reached: ${errorText(error)}`, secrets));
    }
    const type = upstream.headers.get("content-type") ?? "application/json";
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      response.writeHead(upstream.status, { "content-type": type });
      response.end(hideText(text, secrets));
      return;
    }
    response.writeHead(upstream.status, { "content-type": type, "cache-control": "no-cache" });
    try {
      if (upstream.body !== null) {
        for await (const chunk of upstream.body) {
          if (!response.write(hideBytes(Buffer.from(chunk), secrets))) await once(response, "drain", { signal: ended.signal });
        }
      }
      response.end();
    } catch (error) {
      if (ended.signal.aborted) return;
      throw new Error(hideText(`the model's answer was cut: ${errorText(error)}`, secrets), { cause: error });
    }
  };
}

export function providerBody(body: JsonObject, reached: Pick<Reached, "model" | "effort">): JsonObject {
  const { reasoning_effort: effort, ...rest } = body;
  const sent: JsonObject = { ...rest, model: reached.model };
  if (effort === undefined) return sent;
  return reached.effort === "reasoning" ? { ...sent, reasoning: { effort } } : { ...sent, reasoning_effort: effort };
}

export function secretsOf(headers: Readonly<Record<string, string>>): string[] {
  const values = Object.values(headers).flatMap((value) => {
    const token = /^\S+\s+(\S+)$/u.exec(value)?.[1];
    return token === undefined ? [value] : [value, token];
  });
  return [...new Set(values.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]).filter((value) => value.length > 0))];
}

export function hideText(text: string, secrets: readonly string[]): string {
  return secrets.reduce((hidden, secret) => hidden.replaceAll(secret, HIDDEN), text);
}

export function hideBytes(bytes: Buffer, secrets: readonly string[]): Buffer {
  const mark = Buffer.from(HIDDEN);
  return secrets.reduce((out, secret) => replaced(out, Buffer.from(secret), mark), bytes);
}

function replaced(bytes: Buffer, needle: Buffer, mark: Buffer): Buffer {
  let at = bytes.indexOf(needle);
  if (at < 0) return bytes;
  const parts: Buffer[] = [];
  let from = 0;
  while (at >= 0) {
    parts.push(bytes.subarray(from, at), mark);
    from = at + needle.length;
    at = bytes.indexOf(needle, from);
  }
  parts.push(bytes.subarray(from));
  return Buffer.concat(parts);
}
