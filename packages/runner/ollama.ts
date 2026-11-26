import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { flushed, textHead } from "@lifestreamprotocol/core";
import { ArtifactError, embedAskOf, ensureArtifact, fetchDocument, holdsArtifact, removeArtifact, type RunnerAnswer } from "@lifestreamprotocol/model";
import { embedAnswer } from "./embed.js";
import type { OllamaRow, Row } from "./files.js";
import { Failed, NotReady, type Library } from "./library.js";
import type { OllamaChild } from "./ollama-child.js";


const PICTURE_TOKENS = 2_304;
const ANSWER_TOKENS = 1_024;
const KEEP_ALIVE = "5m";

function contextOf(row: Row): number {
  const tokens = (row.context_tokens ?? 0) + PICTURE_TOKENS + ANSWER_TOKENS;
  return Math.ceil(tokens / 1_024) * 1_024;
}

export interface OllamaLayer {
  readonly mediaType: string;
  readonly digest: string;
  readonly size: number;
}

export interface OllamaManifest {
  readonly schemaVersion: 2;
  readonly config: OllamaLayer;
  readonly layers: readonly OllamaLayer[];
}

const MANIFEST_TYPE = "application/vnd.docker.distribution.manifest.v2+json";
const MANIFEST_MOST_BYTES = 4 * 1024 * 1024;
const MANIFEST_MS = 30_000;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const PARTIAL = ".manifest.partial";
const BLOB = /^sha256-[0-9a-f]{64}$/u;

const isLayer = (value: unknown): value is OllamaLayer => typeof value === "object" && value !== null
  && typeof (value as OllamaLayer).mediaType === "string" && typeof (value as OllamaLayer).digest === "string" && DIGEST.test((value as OllamaLayer).digest)
  && Number.isSafeInteger((value as OllamaLayer).size) && (value as OllamaLayer).size >= 0;

function manifestOf(bytes: Buffer): OllamaManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  const manifest = value as OllamaManifest;
  if (typeof value !== "object" || value === null || manifest.schemaVersion !== 2 || !isLayer(manifest.config)) return null;
  return Array.isArray(manifest.layers) && manifest.layers.every(isLayer) ? manifest : null;
}

const layersOf = (manifest: OllamaManifest): readonly OllamaLayer[] => [manifest.config, ...manifest.layers];
const sizeOf = (manifest: OllamaManifest): number => layersOf(manifest).reduce((sum, layer) => sum + layer.size, 0);
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

interface Held {
  readonly manifest: OllamaManifest;
  readonly bytes: Buffer;
}

function heldIn(file: string): Held | null {
  if (!existsSync(file)) return null;
  const bytes = readFileSync(file);
  const manifest = manifestOf(bytes);
  return manifest === null ? null : { manifest, bytes };
}

async function onDisk(file: string, step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    throw new ArtifactError(code === "ENOSPC" || code === "EDQUOT" ? "full" : "disk", `${file} could not be written: ${error instanceof Error ? error.message : String(error)}`, undefined, { cause: error });
  }
}

const written = (file: string, bytes: Buffer): Promise<void> => onDisk(file, async () => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.writing`, bytes);
  await flushed(`${file}.writing`);
  renameSync(`${file}.writing`, file);
  await flushed(dirname(file));
});

const placed = (from: string, file: string): Promise<void> => onDisk(file, async () => {
  mkdirSync(dirname(file), { recursive: true });
  renameSync(from, file);
  await flushed(dirname(file));
});

function oneAtATime(): <T>(signal: AbortSignal, work: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return async (signal, work) => {
    const before = tail;
    let release = (): void => undefined;
    tail = new Promise((resolve) => { release = resolve; });
    try {
      await before;
      signal.throwIfAborted();
      return await work();
    } finally {
      release();
    }
  };
}

export function ollamaLibrary(child: OllamaChild): Library {
  const manifests = join(child.models, "manifests");
  const fileOf = (model: string): string => {
    const [name, tag] = model.split(":");
    return join(manifests, "registry.ollama.ai", "library", name!, tag!);
  };
  const partialOf = (row: Row): string => join(child.models, `${row.id}${PARTIAL}`);
  const blobOf = (layer: OllamaLayer): string => join(child.models, "blobs", layer.digest.replace(":", "-"));
  const artifactOf = (row: OllamaRow, layer: OllamaLayer) => ({ url: `${row.source.registry}/blobs/${layer.digest}`, bytes: layer.size, sha256: layer.digest.slice("sha256:".length) });
  const digests = new Map<string, string>();
  const locked = oneAtATime();
  const named = (): Set<string> => {
    const files = [
      ...existsSync(manifests) ? readdirSync(manifests, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)) : [],
      ...existsSync(child.models) ? readdirSync(child.models).filter((name) => name.endsWith(PARTIAL)).map((name) => join(child.models, name)) : [],
    ];
    return new Set(files.flatMap((file) => {
      const held = heldIn(file);
      return held === null ? [] : layersOf(held.manifest).map((layer) => layer.digest);
    }));
  };
  const sweep = async (signal: AbortSignal): Promise<void> => {
    const blobs = join(child.models, "blobs");
    if (!existsSync(blobs)) return;
    const left = named();
    const loose = new Set(readdirSync(blobs, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name.split(".")[0]!).filter((name) => BLOB.test(name) && !left.has(name.replace("-", ":"))));
    for (const name of loose) await removeArtifact(join(blobs, name), signal);
  };
  const drop = async (file: string, signal: AbortSignal): Promise<void> => {
    rmSync(file, { force: true });
    await sweep(signal);
  };
  const prune = (file: string): void => {
    for (let folder = dirname(file); folder.startsWith(`${manifests}${sep}`); folder = dirname(folder)) {
      if (!existsSync(folder) || readdirSync(folder).length > 0) return;
      rmdirSync(folder);
    }
  };

  async function whole(row: OllamaRow, held: Held, signal: AbortSignal): Promise<boolean> {
    for (const layer of layersOf(held.manifest)) if (!await holdsArtifact(artifactOf(row, layer), blobOf(layer), signal)) return false;
    return true;
  }

  async function resolve(row: OllamaRow, signal: AbortSignal): Promise<Held> {
    const tag = row.source.model.slice(row.source.model.indexOf(":") + 1);
    const address = `${row.source.registry}/manifests/${tag}`;
    // external: registry.ollama.ai answers a User-Agent of ollama/<version> with 401 and a challenge only a signed Ollama key answers (412 for an old version), and any other with the manifest
    const bytes = await fetchDocument(address, { accept: MANIFEST_TYPE, most_bytes: MANIFEST_MOST_BYTES, deadline_ms: MANIFEST_MS, signal });
    const manifest = manifestOf(bytes);
    if (manifest === null) throw new ArtifactError("refused", `${address} answered no manifest Ollama reads`);
    const foreign = [...new Set(layersOf(manifest).map((layer) => layer.mediaType))].filter((type) => !row.source.layers.includes(type));
    if (foreign.length > 0) throw new Failed("failed", `${address} answered a build with ${foreign.join(", ")} layers, which the pinned Ollama is not known to run for ${row.id}`);
    return { manifest, bytes };
  }

  return {
    async fetch(row, progress, signal) {
      const ollama = row as OllamaRow;
      const build = await child.build(signal, progress);
      progress(build);
      const file = fileOf(ollama.source.model);
      const held = heldIn(file);
      if (held !== null && await whole(ollama, held, signal)) {
        await locked(signal, () => drop(partialOf(row), signal));
        digests.set(row.id, sha256(held.bytes));
        progress(build + sizeOf(held.manifest), build + sizeOf(held.manifest));
        return;
      }
      const { manifest, bytes } = await resolve(ollama, signal);
      const total = build + sizeOf(manifest);
      await locked(signal, async () => {
        await written(partialOf(row), bytes);
        await sweep(signal);
      });
      let fetched = build;
      progress(fetched, total);
      for (const layer of layersOf(manifest)) {
        await ensureArtifact(artifactOf(ollama, layer), blobOf(layer), { signal, progress: (landed) => progress(fetched + landed, total) });
        fetched += layer.size;
        progress(fetched, total);
      }
      await locked(signal, async () => {
        await placed(partialOf(row), file);
        digests.set(row.id, sha256(bytes));
        await sweep(signal);
      });
    },
    async remove(row, signal) {
      const ollama = row as OllamaRow;
      await locked(signal, async () => {
        digests.delete(row.id);
        await drop(partialOf(row), signal);
        await drop(fileOf(ollama.source.model), signal);
        prune(fileOf(ollama.source.model));
        if (named().size === 0) await child.remove();
      });
    },
    async run(row, request, signal): Promise<RunnerAnswer> {
      const { source, embed } = row as OllamaRow;
      const ask = embed === undefined ? null : embedAskOf(request.input);
      if (embed !== undefined && (ask === null || request.attachments.length > 0)) throw new Failed("failed", `${row.id} embeds texts alone, and the call is no embedding`);
      const images = request.attachments.map((attachment) => {
        if (!attachment.media_type.startsWith("image/")) throw new Failed("unreadable", `${row.id} reads pictures and text, not ${attachment.media_type}`);
        return attachment.base64;
      });
      const url = await child.url(signal);
      try {
        const listed = await call<{ models?: { name: string; digest: string }[] }>(url, "GET", "/api/tags", undefined, signal);
        const digest = digests.get(row.id);
        if (digest === undefined || listed.models?.find((each) => each.name === source.model)?.digest !== digest) throw new NotReady(`${row.id} is not held under the manifest it fetched`);
        if (embed !== undefined && ask !== null) {
          const embedded = await call<{ embeddings?: number[][]; prompt_eval_count?: number }>(url, "POST", "/api/embed", {
            model: source.model, keep_alive: KEEP_ALIVE, truncate: true, input: ask.texts.map((text) => embed.prompts[ask.role] + text),
            options: { num_ctx: row.context_tokens ?? 0 },
          }, signal);
          if (embedded.embeddings?.length !== ask.texts.length) throw new Failed("failed", `${row.id} answered ${embedded.embeddings?.length ?? 0} vectors for ${ask.texts.length} texts`);
          return {
            text: embedAnswer(embedded.embeddings, embed.dimensions), model: row.id,
            ...(embedded.prompt_eval_count === undefined ? {} : { input_tokens: embedded.prompt_eval_count }),
          };
        }
        const answer = await call<{ message?: { content?: string }; done_reason?: string; prompt_eval_count?: number; eval_count?: number }>(url, "POST", "/api/chat", {
          model: source.model, stream: false, think: false, keep_alive: KEEP_ALIVE,
          messages: [{ role: "user", content: request.input, ...(images.length > 0 ? { images } : {}) }],
          options: { temperature: 0, num_ctx: contextOf(row), num_predict: ANSWER_TOKENS },
          ...(request.schema === undefined ? {} : { format: request.schema }),
        }, signal);
        if (answer.done_reason === "length") throw new Failed("cut", `${row.id}'s answer reached ${ANSWER_TOKENS} tokens`);
        return {
          text: answer.message?.content ?? "", model: row.id,
          ...(answer.prompt_eval_count === undefined ? {} : { input_tokens: answer.prompt_eval_count }),
          ...(answer.eval_count === undefined ? {} : { output_tokens: answer.eval_count }),
        };
      } catch (error) {
        if (signal.aborted) void child.heal();
        throw error;
      }
    },
    close: () => child.close(),
  };
}

async function call<T>(url: string, method: string, path: string, body: unknown, signal: AbortSignal): Promise<T> {
  const response = await fetch(new URL(path, url), { method, signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  if (!response.ok) throw new Error(`Ollama answered ${response.status}: ${textHead(text, 500)}`);
  return (text === "" ? {} : JSON.parse(text)) as T;
}
