import { DOCUMENT_IDLE_S, EMBED_TEXTS, embedAnswerOf, type EmbedRole, type RunnerCode, type RunnerEnded, type RunnerError, type RunnerListing } from "@lifestreamprotocol/model";
import { DriveRefused, type DriveHalf } from "./detector.js";
import { fileLine, runnerLine } from "./models.js";
import type { EmbedWaits } from "./screen-index.js";
import { Refusal } from "./refusal.js";
import type { MeaningModel } from "./search-route.js";


export type EmbedderCode = RunnerCode | "OFF" | "TIMEOUT" | "NO_DOOR" | "REFUSED" | "BAD_ANSWER";

export class EmbedderError extends Error {
  override name = "EmbedderError";

  constructor(readonly code: EmbedderCode, message: string, readonly reason?: RunnerError["reason"]) {
    super(message);
  }
}

export function routes(code: EmbedderCode): boolean {
  return code !== "FAILED" && code !== "BAD_ANSWER";
}

export const IDLE_S = DOCUMENT_IDLE_S;

export type EmbedWait = "off" | "no_runner" | "not_ready" | "battery" | "in_use" | "warm";

export type Admission = { readonly go: true } | { readonly go: false; readonly why: EmbedWait; readonly words: string };

export function admission(runners: readonly RunnerListing[], unit: string, model: string, role: EmbedRole): Admission {
  const runner = runners.find((each) => each.unit === unit);
  const away = runner === undefined ? "The machine chosen to search by meaning has not been heard from" : runnerLine(runner);
  if (runner === undefined || away !== null) return { go: false, why: "no_runner", words: away! };
  const file = runner.files.find((each) => each.id === model);
  if (file === undefined) return { go: false, why: "not_ready", words: `${runner.name} cannot run the meaning model` };
  if (file.state !== "ready") return { go: false, why: "not_ready", words: `Meaning model on ${runner.name}: ${fileLine(file) ?? "downloading"}` };
  if (role === "query") return { go: true };
  return restingOf(runner);
}

export function restingOf(runner: RunnerListing): Admission {
  if (runner.power === "battery") return { go: false, why: "battery", words: `Waiting for ${runner.name} to be plugged in` };
  if (runner.idle_s === null || runner.idle_s < IDLE_S) return { go: false, why: "in_use", words: `Waiting for ${runner.name} to be idle` };
  if (runner.thermal !== "nominal") return { go: false, why: "warm", words: `Waiting for ${runner.name} to cool down` };
  return { go: true };
}

export function waitsOfAdmission(admitted: Admission & { go: false }): EmbedWaits | null {
  const word = ({ off: null, no_runner: "no_runner", not_ready: "downloading", battery: "battery", in_use: "in_use", warm: "warm" } as const)[admitted.why];
  return word === null ? null : { waits: word, line: admitted.words };
}

export function waitsOfError(error: EmbedderError): EmbedWaits | null {
  switch (error.code) {
    case "OFF":
      return null;
    case "BUSY":
      if (error.reason === "battery") return { waits: "battery", line: "Waiting for the machine meaning runs on to be plugged in" };
      if (error.reason === "in_use") return { waits: "in_use", line: "Waiting for the machine meaning runs on to be idle" };
      return { waits: "busy", line: "The meaning model is busy with a search; it goes on after" };
    case "NOT_READY":
      return { waits: "downloading", line: "The meaning model is not ready on its machine" };
    case "NO_RUNNER":
    case "INTERRUPTED":
    case "NO_DOOR":
    case "REFUSED":
      return { waits: "no_runner", line: `The machine meaning runs on cannot be reached: ${error.message}` };
    default:
      return { waits: "failing", line: `The meaning model fails: ${error.message}` };
  }
}

export interface EmbedderOptions {
  meaning: () => Pick<MeaningModel, "unit" | "file"> | null;
  drive: DriveHalf;
  timeout_ms?: number;
}

export interface Embedder {
  admits(role: EmbedRole): Promise<Admission>;
  embed(texts: readonly string[], role: EmbedRole, signal?: AbortSignal): Promise<{ model: string; vectors: Float32Array[] }>;
}

const TIMEOUT_MS = 2 * 60_000;
const OFF = "Search by meaning is off: no model is chosen for it.";
const text = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function openEmbedder(options: EmbedderOptions): Embedder {
  const timeoutMs = options.timeout_ms ?? TIMEOUT_MS;
  return {
    async admits(role) {
      const chosen = options.meaning();
      if (chosen === null) return { go: false, why: "off", words: OFF };
      let runners: readonly RunnerListing[];
      try {
        runners = await options.drive.list();
      } catch (error) {
        return { go: false, why: "no_runner", words: `Lifestream cannot list its runners: ${text(error)}` };
      }
      return admission(runners, chosen.unit, chosen.file, role);
    },
    async embed(texts, role, signal) {
      if (texts.length < 1 || texts.length > EMBED_TEXTS) throw new RangeError(`an embedding takes 1 to ${EMBED_TEXTS} texts, and was given ${texts.length}`);
      const chosen = options.meaning();
      if (chosen === null) throw new EmbedderError("OFF", OFF);
      const { unit, file: model } = chosen;
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(new EmbedderError("TIMEOUT", `the meaning model did not answer within ${Math.round(timeoutMs / 1_000)} s`)), timeoutMs);
      const gone = () => stop.abort(new EmbedderError("INTERRUPTED", "the embedding was stopped"));
      signal?.addEventListener("abort", gone, { once: true });
      let end: RunnerEnded;
      try {
        if (signal?.aborted === true) gone();
        end = await options.drive.place({ runner: unit, model, input: JSON.stringify({ role, texts }), attachments: [] }, stop.signal, () => undefined);
      } catch (error) {
        if (stop.signal.aborted) throw stop.signal.reason;
        if (error instanceof EmbedderError) throw error;
        if (error instanceof DriveRefused) throw new EmbedderError("REFUSED", `the door refused the embedding: ${error.status} ${error.words}`);
        if (error instanceof Refusal) throw new EmbedderError("REFUSED", `the door refused the embedding: ${error.status} ${error.code}, ${error.words}`);
        throw new EmbedderError("NO_DOOR", `the embedding did not reach the door: ${text(error)}`);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", gone);
      }
      if (stop.signal.aborted) throw stop.signal.reason;
      if ("error" in end) {
        const { code, reason } = end.error;
        throw new EmbedderError(code, `the embedding ended ${code}${reason === undefined ? "" : ` (${reason})`}`, reason);
      }
      const vectors = end.ok.model === model ? embedAnswerOf(end.ok.text, texts.length) : null;
      if (vectors === null) throw new EmbedderError("BAD_ANSWER", "the meaning model answered what no embedding of these texts answers");
      return { model, vectors };
    },
  };
}
