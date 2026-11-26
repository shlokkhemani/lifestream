import { errorText, LIST_MS, SendFailed } from "../transport.js";

export interface Post {
  transport: string;
  endpoint: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
  fetch: typeof fetch;
}

export async function complete(options: Post): Promise<{ text: string; cost?: number; input_tokens?: number; output_tokens?: number }> {
  return parse(options.transport, await post(options));
}

export async function post(options: Post): Promise<string> {
  const { transport, signal } = options;
  let response: Response;
  try {
    response = await options.fetch(options.endpoint, {
      method: "POST",
      headers: { ...options.headers, "content-type": "application/json" },
      body: JSON.stringify(options.body),
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new SendFailed(transport, `${transport}: the connection failed: ${causeText(error)}`, null, { cause: error });
  }
  if (!response.ok) {
    throw new SendFailed(transport, `${transport} answered HTTP ${response.status}`, response.status, response.status === 429 ? { limit: {} } : undefined);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new Error(`${transport}: the answer was lost while it was read: ${causeText(error)}`, { cause: error });
  }
  return text;
}

function causeText(error: unknown): string {
  return errorText((error as { cause?: unknown } | null)?.cause ?? error);
}

function parse(transport: string, text: string): { text: string; cost?: number; input_tokens?: number; output_tokens?: number } {
  let root: unknown;
  try { root = JSON.parse(text); } catch { throw new Error(`${transport} reply is not JSON`); }
  const object = record(root);
  const choices = object?.choices;
  const message = record(record(Array.isArray(choices) ? choices[0] : undefined)?.message);
  const usage = record(object?.usage);
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const input = count(usage?.prompt_tokens);
  const output = count(usage?.completion_tokens);
  const cost = usage?.cost;
  return {
    text: typeof message?.content === "string" ? message.content : "",
    ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { cost } : {}),
    ...(input === undefined ? {} : { input_tokens: input }),
    ...(output === undefined ? {} : { output_tokens: output }),
  };
}

export async function getList(transport: string, url: string, fetcher: typeof fetch, headers: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetcher(url, { headers, redirect: "error", signal: AbortSignal.timeout(LIST_MS) });
  if (!response.ok) throw new Error(`${transport} answered its list with HTTP ${response.status}`);
  const root = record(await response.json());
  if (root === undefined) throw new Error(`${transport}'s list is no JSON object`);
  return root;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function keyHeaders(key: string | undefined): Record<string, string> {
  return key === undefined || key.length === 0 ? {} : { Authorization: `Bearer ${key}` };
}
