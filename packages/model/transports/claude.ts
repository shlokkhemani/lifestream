import { mkdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { errorText, LIST_MS, SendFailed, withListed, type ListedModel, type Transport } from "../transport.js";
import { checkProgram, converse, run, UNAVAILABLE, type Judging, type ProgramAt, type ProgramCheck } from "./program.js";

export const CLAUDE_ITEM_MODEL = "claude-haiku-5-5";

export const CLAUDE_CHAT_MODEL = "claude-opus-5-5";

const CONTEXT_TOKENS = 200_000;

const DECLARED: readonly ListedModel[] = [
  {
    model: CLAUDE_ITEM_MODEL, name: "Claude Haiku 5.5", input: ["text", "image"], output: "text", tools: true, context_tokens: CONTEXT_TOKENS,
    thinking: ["low", "medium", "high"], ready: true, suggested: ["pictures", "text"],
  },
  {
    model: CLAUDE_CHAT_MODEL, name: "Claude Opus 5.5", input: ["text", "image"], output: "text", tools: true, context_tokens: CONTEXT_TOKENS,
    thinking: ["low", "medium", "high"], ready: true, suggested: ["chat"],
  },
];

const NOT_FOUND = "Claude Code is not on this Mac yet: it is downloaded once Claude is chosen, and is downloading if it was";

const IMAGES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export function claudeEnv(home: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const { ANTHROPIC_API_KEY: _key, ANTHROPIC_AUTH_TOKEN: _token, ANTHROPIC_BASE_URL: _url, CLAUDE_CODE_OAUTH_TOKEN: _oauth, ...rest } = env;
  return {
    ...rest,
    CLAUDE_CONFIG_DIR: home,
    USER: rest.USER === undefined || rest.USER === "" ? userInfo().username : rest.USER,
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  };
}

const CLAUDE_FLAGS = [
  "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence",
  "--permission-mode", "dontAsk", "--system-prompt", "",
] as const;

export interface ClaudeOptions {
  claude: ProgramAt | undefined;
  listed?: readonly ListedModel[];
}

export function claudeTransport(options: ClaudeOptions): Transport {
  const claude = options.claude;
  return {
    name: "claude",
    provider: "Claude",
    cost: "plan",
    leaves: "Anthropic",
    chat: "program",
    defaults: { effort: "low", timeout_ms: 120_000, concurrency: 2 },
    models: async () => withListed(DECLARED, options.listed ?? []),
    async list() {
      if (claude === undefined) throw new SendFailed("claude", NOT_FOUND, null);
      return listedClaude(await converse("claude", claude, CLAUDE_FLAGS, {
        env: claudeEnv(claude.home), cwd: claude.home, bound_ms: LIST_MS,
        opening: [{ type: "control_request", request_id: LIST_REQUEST, request: { subtype: "initialize" } }],
        heard: (message) => {
          const response = record(message.response);
          if (message.type !== "control_response" || response?.request_id !== LIST_REQUEST) return undefined;
          const listed = record(response.response)?.models;
          if (!Array.isArray(listed)) throw new Error("claude answered with no list of its models");
          return listed;
        },
      }));
    },
    async available() {
      const check = await checkClaude(claude);
      return check.state === "signed_in" ? { ok: true } : { ok: false, reason: UNAVAILABLE[check.state], detail: check.why };
    },
    async send(request, attachments) {
      if (claude === undefined) throw new SendFailed("claude", NOT_FOUND, null);
      const refused = attachments.find((file) => !IMAGES.has(file.media_type));
      if (refused !== undefined) throw new Error(`claude takes JPEG, PNG, GIF and WebP images only, not ${refused.media_type}`);
      if (request.sampling !== undefined) throw new Error("claude takes no sampling");
      const message = {
        type: "user",
        message: {
          role: "user",
          content: [
            ...attachments.map((file) => ({ type: "image", source: { type: "base64", media_type: file.media_type, data: readFileSync(file.path).toString("base64") } })),
            { type: "text", text: request.input },
          ],
        },
      };
      const args = [
        ...CLAUDE_FLAGS, "--model", request.model, "--effort", request.effort,
        ...request.schema === undefined ? [] : ["--json-schema", readFileSync(request.schema, "utf8")],
      ];
      const read: Read = {};
      const ran = await run("claude", claude, args, {
        env: claudeEnv(claude.home), cwd: claude.home, stdin: `${JSON.stringify(message)}\n`, signal: request.signal, line: (line) => take(read, line),
      }).catch((error: unknown) => {
        if (read.hit !== undefined) throw limitMet(read.hit, `claude -p ended after it stated the plan's limit met: ${errorText(error)}`);
        throw error;
      });
      return answered(ran, read, request.schema !== undefined, request.model);
    },
  };
}

const LIST_REQUEST = "list";

export function listedClaude(listed: readonly unknown[]): ListedModel[] {
  const rows = new Map<string, ListedModel>();
  const standing = (each: unknown) => record(each)?.value === "default";
  for (const each of [...listed.filter((one) => !standing(one)), ...listed.filter(standing)]) {
    const alias = record(each);
    const model = typeof alias?.resolvedModel === "string" && alias.resolvedModel !== "" ? alias.resolvedModel : alias?.value;
    if (typeof model !== "string" || model === "" || rows.has(model)) continue;
    const efforts = Array.isArray(alias?.supportedEffortLevels) ? alias.supportedEffortLevels.filter((level): level is string => typeof level === "string") : [];
    rows.set(model, {
      model, name: typeof alias?.displayName === "string" && alias.displayName !== "" ? alias.displayName : model,
      input: ["text", "image"], output: "text", tools: true, context_tokens: CONTEXT_TOKENS, thinking: efforts, ready: true,
    });
  }
  return [...rows.values()];
}

interface Read {
  result?: Record<string, unknown>;
  hit?: Record<string, unknown>;
}

function take(read: Read, line: string): void {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return; }
  const each = record(value);
  if (each?.type === "result") read.result = each;
  else if (each?.type === "rate_limit_event") {
    const limit = record(each.rate_limit_info);
    if (limit !== undefined && limitHit(limit.status)) read.hit = limit;
  }
}

function limitHit(status: unknown): boolean {
  return typeof status === "string" && !status.startsWith("allowed");
}

function limitMet(hit: Record<string, unknown> | undefined, said: string): SendFailed {
  return new SendFailed("claude", said, 429, { limit: typeof hit?.resetsAt === "number" ? { resets_ms: hit.resetsAt * 1000 } : {} });
}

function answered(ran: { code: number; stderr: string }, read: Read, shaped: boolean, asked: string) {
  const result = read.result;
  if (result === undefined) {
    const said = `claude -p gave no result: ${ran.stderr.trim() || `exit ${ran.code}`}`;
    if (read.hit !== undefined) throw limitMet(read.hit, said);
    throw new Error(said);
  }
  if (result.is_error === true) {
    const said = `claude -p failed: ${typeof result.result === "string" && result.result !== "" ? result.result : String(result.terminal_reason ?? `exit ${ran.code}`)}`;
    const status = result.api_error_status;
    if (read.hit !== undefined || status === 429) throw limitMet(read.hit, said);
    if (typeof status === "number") throw new SendFailed("claude", said, status);
    if (result.terminal_reason === "api_error") throw new SendFailed("claude", said, null);
    throw new Error(said);
  }
  let text: string;
  if (shaped) {
    if (result.structured_output === undefined || result.structured_output === null) throw new Error("claude answered no structured_output for the schema stated");
    text = JSON.stringify(result.structured_output);
  } else {
    text = typeof result.result === "string" ? result.result : "";
  }
  const usage = record(result.usage);
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const models = Object.entries(record(result.modelUsage) ?? {}).sort(([, a], [, b]) => count(record(b)?.outputTokens) - count(record(a)?.outputTokens));
  return {
    text,
    model: models[0]?.[0] ?? asked,
    ...(usage === undefined ? {} : {
      input_tokens: count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens),
      output_tokens: count(usage.output_tokens),
    }),
  };
}

const JUDGING: Judging = {
  name: "claude",
  missing: NOT_FOUND,
  env: (home) => claudeEnv(home),
  signIn: {
    args: ["auth", "status"],
    judge: (status) => {
      let signedIn = false;
      try { signedIn = record(JSON.parse(status.stdout))?.loggedIn === true; } catch { signedIn = false; }
      return status.error === null && signedIn ? null : "Claude Code is not signed in to Claude; sign in from Lifestream's Settings";
    },
  },
};

export function checkClaude(claude: ProgramAt | undefined): Promise<ProgramCheck> {
  return checkProgram(claude, JUDGING);
}

export async function signOutClaude(at: ProgramAt, signal: AbortSignal): Promise<string | null> {
  try {
    const ran = await run("claude", at, ["auth", "logout"], { env: claudeEnv(at.home), stdin: "", signal });
    return ran.code === 0 ? null : `it ended with exit ${ran.code}`;
  } catch {
    return signal.aborted ? "it did not end in time" : "it could not start";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
