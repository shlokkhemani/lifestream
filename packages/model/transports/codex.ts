import { mkdirSync } from "node:fs";
import { errorText, LIST_MS, SendFailed, withListed, type Input, type ListedModel, type Transport } from "../transport.js";
import { checkProgram, converse, run, UNAVAILABLE, type Judging, type ProgramAt, type ProgramCheck } from "./program.js";

export const CODEX_ITEM_MODEL = "gpt-6-luna";

export const CODEX_CHAT_MODEL = "gpt-6.2-sol";

const CONTEXT_TOKENS = 1_050_000;

const DECLARED: readonly ListedModel[] = [
  {
    model: CODEX_ITEM_MODEL, name: "GPT-6 Luna", input: ["text", "image"], output: "text", tools: true, timed: false, context_tokens: CONTEXT_TOKENS,
    thinking: ["low", "medium", "high"], ready: true, suggested: ["pictures", "text"],
  },
  {
    model: CODEX_CHAT_MODEL, name: "GPT-6.2 Sol", input: ["text", "image"], output: "text", tools: true, timed: false, context_tokens: CONTEXT_TOKENS,
    thinking: ["low", "medium", "high"], ready: true, suggested: ["chat"],
  },
];

const NOT_FOUND = "Codex is not on this Mac yet: it is downloaded once ChatGPT is chosen, and is downloading if it was";

export function codexEnv(home: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const { OPENAI_API_KEY: _openai, CODEX_API_KEY: _codex, ...rest } = env;
  return { ...rest, CODEX_HOME: home, HOME: home };
}

const CODEX_FLAGS = ["-c", "check_for_update_on_startup=false", "-c", "analytics.enabled=false"] as const;

export interface CodexOptions {
  codex: ProgramAt | undefined;
  listed?: readonly ListedModel[];
}

export function codexTransport(options: CodexOptions): Transport {
  const codex = options.codex;
  return {
    name: "codex",
    provider: "ChatGPT",
    cost: "plan",
    leaves: "OpenAI",
    chat: "program",
    defaults: { effort: "low", timeout_ms: 120_000, concurrency: 2 },
    models: async () => withListed(DECLARED, options.listed ?? []),
    async list() {
      if (codex === undefined) throw new SendFailed("codex", NOT_FOUND, null);
      return listedCodex(await converse("codex", codex, ["app-server", ...CODEX_FLAGS], {
        env: codexEnv(codex.home), cwd: codex.home, bound_ms: LIST_MS,
        opening: [{ id: STARTED, method: "initialize", params: { clientInfo: { name: "lifestream-home", title: "Lifestream", version: "1" }, capabilities: { experimentalApi: true } } }],
        heard: (message, write) => {
          if (message.id === STARTED) {
            if (message.error !== undefined) throw new Error("codex refused to start its app server");
            write({ method: "initialized" });
            write({ id: LISTED, method: "model/list", params: {} });
            return undefined;
          }
          if (message.id !== LISTED) return undefined;
          const listed = record(message.result)?.data;
          if (!Array.isArray(listed)) throw new Error("codex answered with no list of its models");
          return listed;
        },
      }));
    },
    async available() {
      const check = await checkCodex(codex);
      return check.state === "signed_in" ? { ok: true } : { ok: false, reason: UNAVAILABLE[check.state], detail: check.why };
    },
    async send(request, attachments) {
      if (codex === undefined) throw new SendFailed("codex", NOT_FOUND, null);
      if (attachments.some((file) => !file.media_type.startsWith("image/"))) {
        throw new Error("codex takes image attachments only");
      }
      if (request.sampling !== undefined) throw new Error("codex takes no sampling");
      const args = [
        "exec",
        ...CODEX_FLAGS,
        "--ephemeral",
        "-m", request.model,
        "-c", `model_reasoning_effort=${request.effort}`,
        "-s", "read-only",
        "--skip-git-repo-check",
        ...request.schema === undefined ? [] : ["--output-schema", request.schema],
        ...attachments.flatMap((file) => ["-i", file.path]),
        "-",
      ];
      const result = await run("codex", codex, args, { env: codexEnv(codex.home), stdin: request.input, signal: request.signal });
      if (result.code !== 0) {
        const failed = `codex exec failed: ${result.stderr.trim() || `exit ${result.code}`}`;
        const status = reported(result.stderr);
        throw status === undefined ? new Error(failed) : new SendFailed("codex", failed, status, status === 429 ? { limit: {} } : undefined);
      }
      return { text: result.stdout, model: request.model };
    },
  };
}

const STARTED = 1;
const LISTED = 2;

const INPUTS: readonly Input[] = ["text", "image", "audio"];

export function listedCodex(listed: readonly unknown[]): ListedModel[] {
  const rows = new Map<string, ListedModel>();
  for (const each of listed) {
    const model = record(each);
    if (model === undefined || model.hidden === true || typeof model.id !== "string" || model.id === "" || rows.has(model.id)) continue;
    const modalities = Array.isArray(model.inputModalities) ? model.inputModalities : ["text", "image"];
    const efforts = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.map((effort) => record(effort)?.reasoningEffort) : [];
    rows.set(model.id, {
      model: model.id, name: typeof model.displayName === "string" && model.displayName !== "" ? model.displayName : model.id,
      input: INPUTS.filter((input) => modalities.includes(input)), output: "text", tools: true, timed: false, context_tokens: CONTEXT_TOKENS,
      thinking: efforts.filter((effort): effort is string => typeof effort === "string"), ready: true,
    });
  }
  return [...rows.values()].filter((row) => row.input.includes("text"));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function reported(stderr: string): number | null | undefined {
  const status = /(?:last status:|unexpected status) (\d{3})\b/u.exec(stderr);
  if (status !== null) return Number(status[1]);
  if (/usage limit/iu.test(stderr)) return 429;
  return /stream disconnected before completion|error sending request/iu.test(stderr) ? null : undefined;
}

const JUDGING: Judging = {
  name: "codex",
  missing: NOT_FOUND,
  env: (home) => codexEnv(home),
  signIn: {
    args: ["login", "status"],
    judge: (login) => login.error === null
      ? null
      : `Codex is not signed in to ChatGPT: ${`${login.stdout}\n${login.stderr}`.replace(/\s+/gu, " ").trim() || errorText(login.error)}; sign in from Lifestream's Settings`,
  },
};

export function checkCodex(codex: ProgramAt | undefined): Promise<ProgramCheck> {
  return checkProgram(codex, JUDGING);
}
