import { isDetailType, isObject, type DetailType, type JsonObject } from "@lifestreamprotocol/core";
import type { ArtifactError } from "./artifacts.js";
import { MODEL_INPUTS, MODEL_OUTPUTS, type Abilities } from "./transport.js";


export const RUNNER_WIRE_VERSION = "5";

export const RUNNER_EXCHANGE = "/v1/runners/exchange";
export const RUNNER_CALLS = "/v1/runners/calls";
export const RUNNERS = "/v1/runners";

export const POLL_MS = 25_000;
export const PRESENCE_MS = 90_000;
export const FETCHING_MS = 1_000;
export const BEAT_MS = 20_000;
export const CALL_BYTES = 32 * 1024 * 1024;
export const EXCHANGE_BYTES = 1024 * 1024;
export const CALL_SILENT_MS = 30_000;
export const EXCHANGE_SILENT_MS = 60_000;
export const MOST_FILES = 32;
export const FIND_PASSAGES = 32;

export const FIND_HANDED = "handed\n";

export const FIND_LINES = ["hide", "send", "mark"] as const;
export type FindLine = (typeof FIND_LINES)[number];

export const CHAT_LINE = "chat";
export type CallLine = FindLine | typeof CHAT_LINE;

export const STOP_MS = 1_000;

export const EMBED_TEXTS = 32;

export const DOCUMENT_IDLE_S = 120;

export const EMBED_ROLES = ["query", "document"] as const;
export type EmbedRole = (typeof EMBED_ROLES)[number];

export interface EmbedAsk {
  readonly role: EmbedRole;
  readonly texts: readonly string[];
}

export interface EmbedAnswer {
  readonly dimensions: number;
  readonly vectors: readonly string[];
}

export function embedAskOf(input: string): EmbedAsk | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  if (!isObject(parsed) || !(EMBED_ROLES as readonly unknown[]).includes(parsed.role)) return null;
  const { texts } = parsed;
  return Array.isArray(texts) && texts.length >= 1 && texts.length <= EMBED_TEXTS && texts.every((each) => typeof each === "string")
    ? { role: parsed.role as EmbedRole, texts } : null;
}

export function vectorText(vector: Float32Array): string {
  const bytes = Buffer.alloc(vector.length * 4);
  vector.forEach((value, at) => bytes.writeFloatLE(value, at * 4));
  return bytes.toString("base64");
}

export function vectorOf(text: string, dimensions: number): Float32Array | null {
  const bytes = Buffer.from(text, "base64");
  if (bytes.length !== dimensions * 4 || bytes.toString("base64") !== text) return null;
  const vector = new Float32Array(dimensions);
  for (let at = 0; at < dimensions; at++) vector[at] = bytes.readFloatLE(at * 4);
  return vector.every(Number.isFinite) ? vector : null;
}

export function embedAnswerOf(text: string, texts: number): Float32Array[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(parsed) || !Number.isSafeInteger(parsed.dimensions) || (parsed.dimensions as number) < 1 || !Array.isArray(parsed.vectors) || parsed.vectors.length !== texts) return null;
  const vectors = parsed.vectors.map((each) => (typeof each === "string" ? vectorOf(each, parsed.dimensions as number) : null));
  return vectors.every((each) => each !== null) ? vectors : null;
}

export interface DetectorKey {
  readonly file: string;
  readonly decode: string;
}

export interface FindMark {
  readonly start: number;
  readonly end: number;
  readonly type: DetailType;
}

export interface FindAnswer extends DetectorKey {
  readonly marks: readonly (readonly FindMark[] | null)[];
}

export type RunnerFileState = "absent" | "fetching" | "ready" | "failed";

export type FileFailure = ArtifactError["reason"] | "untrusted" | "failed";
const FILE_FAILURES: Readonly<Record<FileFailure, true>> = { offline: true, refused: true, hash: true, full: true, disk: true, untrusted: true, failed: true };

export interface RunnerFile extends Readonly<Abilities> {
  readonly id: string;
  readonly name: string;
  readonly bytes: number;
  readonly languages: readonly string[];
  readonly memory_gb: number;
  readonly state: RunnerFileState;
  readonly fetched_bytes: number;
  readonly failure: FileFailure | null;
  readonly detector?: DetectorKey;
}

export type RunnerThermal = "nominal" | "elevated";

export interface RunnerInfo {
  readonly unit: string;
  readonly name: string;
  readonly version: string;
  readonly boot: string;
  readonly slots: number;
  readonly power: "mains" | "battery" | null;
  readonly idle_s: number | null;
  readonly thermal: RunnerThermal | null;
  readonly memory_gb: number;
  readonly running: readonly string[];
  readonly files: readonly RunnerFile[];
}

export type RunnerListing = RunnerInfo & { readonly present: boolean };

export interface RunnerBelow {
  readonly unit: string;
  readonly version: string;
}

export interface RunnersListed {
  readonly runners: readonly RunnerListing[];
  readonly below: readonly RunnerBelow[];
}

export type RunnerStated = Omit<RunnerInfo, "unit">;

export interface RunnerAttachment {
  readonly media_type: string;
  readonly base64: string;
}

export interface RunnerCall {
  readonly id: string;
  readonly model: string;
  readonly input: string;
  readonly schema?: JsonObject;
  readonly attachments: readonly RunnerAttachment[];
  readonly warm?: true;
}

export interface RunnerAnswer {
  readonly text: string;
  readonly model: string;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
}

export const NOT_THE_REQUESTS = ["NO_RUNNER", "NOT_READY", "BUSY", "INTERRUPTED"] as const;
export type RunnerCode = (typeof NOT_THE_REQUESTS)[number] | "FAILED";

export type RunnerFailure = "unreadable" | "too_long" | "cut" | "failed";
const RUNNER_FAILURES: Readonly<Record<RunnerFailure, true>> = { unreadable: true, too_long: true, cut: true, failed: true };
export type RunnerInterruption = "closed" | "restarted" | "driver_gone" | "preempted";
export type RunnerWait = "battery" | "in_use";
const RUNNER_WAITS: Readonly<Record<RunnerWait, true>> = { battery: true, in_use: true };

export interface RunnerError {
  readonly code: RunnerCode;
  readonly model?: string;
  readonly runner?: string;
  readonly reason?: RunnerFailure | RunnerInterruption | RunnerWait;
  readonly seconds?: number;
}

export type RunnerResult = { readonly id: string; readonly ok: RunnerAnswer } | { readonly id: string; readonly error: RunnerError & { readonly code: "FAILED" | "NOT_READY" | "BUSY" } };

export interface RunnerExchange {
  readonly runner: RunnerStated;
  readonly results: readonly RunnerResult[];
}

export interface RunnerHanded {
  readonly calls: readonly RunnerCall[];
  readonly cancel: readonly string[];
  readonly files: readonly string[];
}

export interface RunnerPlaced {
  readonly runner: string;
  readonly model: string;
  readonly input: string;
  readonly schema?: JsonObject;
  readonly attachments: readonly RunnerAttachment[];
  readonly line?: CallLine;
  readonly warm?: true;
}

export type RunnerEnded = { readonly ok: RunnerAnswer } | { readonly error: RunnerError };

const text = (value: unknown, limit: number): value is string => typeof value === "string" && value !== "" && value.length <= limit;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 1_000 && value.every((id) => text(id, 100));
const LANGUAGE = /^[a-z]{2,3}$/u;
const languages = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 200 && value.every((code) => typeof code === "string" && LANGUAGE.test(code));
const among = <T extends string>(set: Readonly<Record<T, true>>, value: unknown): value is T => typeof value === "string" && Object.hasOwn(set, value);

function isAttachment(value: unknown): value is RunnerAttachment {
  return isObject(value) && text(value.media_type, 200) && typeof value.base64 === "string";
}

const isKey = (value: unknown): value is DetectorKey => isObject(value) && text(value.file, 100) && text(value.decode, 40);

const isAbilities = (value: Record<string, unknown>): boolean => Array.isArray(value.input) && value.input.length === new Set(value.input).size
  && value.input.every((input) => (MODEL_INPUTS as readonly unknown[]).includes(input)) && (MODEL_OUTPUTS as readonly unknown[]).includes(value.output)
  && typeof value.tools === "boolean" && (value.context_tokens === null || count(value.context_tokens))
  && Array.isArray(value.thinking) && value.thinking.length <= 10 && value.thinking.every((level) => text(level, 40));

function isFile(value: unknown): value is RunnerFile {
  return isObject(value) && text(value.id, 100) && text(value.name, 200) && isAbilities(value) && count(value.bytes)
    && languages(value.languages) && typeof value.memory_gb === "number" && ["absent", "fetching", "ready", "failed"].includes(value.state as string) && count(value.fetched_bytes)
    && (value.failure === null || among(FILE_FAILURES, value.failure)) && (value.detector === undefined || isKey(value.detector));
}

export function isStated(value: unknown): value is RunnerStated {
  return isObject(value) && text(value.name, 200) && text(value.version, 40) && text(value.boot, 100) && Number.isSafeInteger(value.slots) && (value.slots as number) >= 1
    && (value.slots as number) <= 64 && (value.power === "mains" || value.power === "battery" || value.power === null) && (value.idle_s === null || count(value.idle_s))
    && (value.thermal === "nominal" || value.thermal === "elevated" || value.thermal === null) && typeof value.memory_gb === "number"
    && ids(value.running) && Array.isArray(value.files) && value.files.length <= MOST_FILES && value.files.every(isFile);
}

export function runnerInfo(unit: string, stated: RunnerStated): RunnerInfo {
  return {
    unit, name: stated.name, version: stated.version, boot: stated.boot, slots: stated.slots, power: stated.power, idle_s: stated.idle_s, thermal: stated.thermal,
    memory_gb: stated.memory_gb, running: [...stated.running],
    files: stated.files.map((file) => ({
      id: file.id, name: file.name, input: [...file.input], output: file.output, tools: file.tools, context_tokens: file.context_tokens, thinking: [...file.thinking],
      bytes: file.bytes, languages: [...file.languages], memory_gb: file.memory_gb,
      state: file.state, fetched_bytes: file.fetched_bytes, failure: file.failure, ...(file.detector === undefined ? {} : { detector: { file: file.detector.file, decode: file.detector.decode } }),
    })),
  };
}

export function isResult(value: unknown): value is RunnerResult {
  if (!isObject(value) || !text(value.id, 100) || (value.ok === undefined) === (value.error === undefined)) return false;
  if (value.ok !== undefined) {
    const { ok } = value;
    return isObject(ok) && typeof ok.text === "string" && text(ok.model, 100) && (ok.input_tokens === undefined || count(ok.input_tokens))
      && (ok.output_tokens === undefined || count(ok.output_tokens));
  }
  const { error } = value;
  if (!isObject(error) || error.runner !== undefined || (error.model !== undefined && !text(error.model, 100))) return false;
  if (error.code === "NOT_READY") return error.reason === undefined && error.seconds === undefined;
  if (error.code === "BUSY") return among(RUNNER_WAITS, error.reason) && error.seconds === undefined;
  return error.code === "FAILED" && among(RUNNER_FAILURES, error.reason) && (error.seconds === undefined || (error.reason === "too_long" && count(error.seconds)));
}

export function endedOf(result: RunnerResult): RunnerEnded {
  if ("ok" in result) {
    const { text, model, input_tokens, output_tokens } = result.ok;
    return { ok: { text, model, ...(input_tokens === undefined ? {} : { input_tokens }), ...(output_tokens === undefined ? {} : { output_tokens }) } };
  }
  const { code, model, reason, seconds } = result.error;
  return { error: { code, ...(model === undefined ? {} : { model }), ...(reason === undefined ? {} : { reason }), ...(seconds === undefined ? {} : { seconds }) } };
}

export function isPlaced(value: unknown): value is RunnerPlaced {
  if (!(isObject(value) && text(value.runner, 100) && text(value.model, 100) && typeof value.input === "string" && (value.schema === undefined || isObject(value.schema))
    && Array.isArray(value.attachments) && value.attachments.every(isAttachment))) return false;
  if (value.warm !== undefined) return value.warm === true && value.line === CHAT_LINE && value.input === "" && value.schema === undefined && value.attachments.length === 0;
  if (value.line === undefined || value.line === CHAT_LINE) return true;
  return (FIND_LINES as readonly unknown[]).includes(value.line) && value.attachments.length === 0 && findPassages(value.input) !== null;
}

export function findPassages(input: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  return Array.isArray(parsed) && parsed.length >= 1 && parsed.length <= FIND_PASSAGES && parsed.every((passage) => typeof passage === "string") ? parsed : null;
}

export function findAnswerOf(text: string, passages: readonly string[]): FindAnswer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isKey(parsed) || !Array.isArray((parsed as unknown as { marks?: unknown }).marks)) return null;
  const marks = (parsed as unknown as { marks: unknown[] }).marks;
  if (marks.length !== passages.length) return null;
  const isMark = (mark: unknown, passage: string): mark is FindMark => isObject(mark) && isDetailType(mark.type) && Number.isSafeInteger(mark.start)
    && Number.isSafeInteger(mark.end) && (mark.start as number) >= 0 && (mark.end as number) > (mark.start as number) && (mark.end as number) <= passage.length;
  const read = marks.map((list, index) => list === null ? { list: null } : Array.isArray(list) && list.every((mark) => isMark(mark, passages[index]!))
    ? { list: (list as FindMark[]).map((mark) => ({ start: mark.start, end: mark.end, type: mark.type })) } : undefined);
  return read.every((each) => each !== undefined) ? { file: parsed.file, decode: parsed.decode, marks: read.map((each) => each!.list) } : null;
}

export function isHanded(value: unknown): value is RunnerHanded {
  return isObject(value) && Array.isArray(value.calls) && value.calls.every((call) => isObject(call) && text(call.id, 100) && text(call.model, 100)
    && typeof call.input === "string" && Array.isArray(call.attachments) && call.attachments.every(isAttachment) && (call.warm === undefined || call.warm === true))
    && ids(value.cancel) && ids(value.files);
}
