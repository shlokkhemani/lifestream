import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { textHead } from "@lifestreamprotocol/core";
import { embedAskOf, ensureArtifact, removeArtifact, type RunnerAnswer } from "@lifestreamprotocol/model";
import { embedAnswer } from "./embed.js";
import type { OllamaLayer, OllamaManifest, OllamaRow, Row } from "./files.js";
import { Failed, NotReady, type Library } from "./library.js";
import type { OllamaChild } from "./ollama-child.js";


const PICTURE_TOKENS = 2_304;
const ANSWER_TOKENS = 1_024;
const KEEP_ALIVE = "5m";

function contextOf(row: Row): number {
  const tokens = (row.context_tokens ?? 0) + PICTURE_TOKENS + ANSWER_TOKENS;
  return Math.ceil(tokens / 1_024) * 1_024;
}

const bytesOf = (manifest: OllamaManifest): string => JSON.stringify(manifest);
const digests = new WeakMap<OllamaManifest, string>();
function digestOf(manifest: OllamaManifest): string {
  let digest = digests.get(manifest);
  if (digest === undefined) {
    digest = createHash("sha256").update(bytesOf(manifest)).digest("hex");
    digests.set(manifest, digest);
  }
  return digest;
}

const layersOf = (row: OllamaRow): readonly OllamaLayer[] => [row.source.manifest.config, ...row.source.manifest.layers];

export function ollamaLibrary(child: OllamaChild): Library {
  const manifests = join(child.models, "manifests");
  const manifestOf = (model: string): string => {
    const [name, tag] = model.split(":");
    return join(manifests, "registry.ollama.ai", "library", name!, tag!);
  };
  const blobOf = (layer: OllamaLayer): string => join(child.models, "blobs", layer.digest.replace(":", "-"));
  const held = (): Set<string>[] => (existsSync(manifests) ? readdirSync(manifests, { recursive: true, withFileTypes: true }) : []).filter((entry) => entry.isFile()).map((entry) => {
    try {
      const manifest = JSON.parse(readFileSync(join(entry.parentPath, entry.name), "utf8")) as OllamaManifest;
      return new Set([manifest.config, ...manifest.layers].map((layer) => layer.digest));
    } catch {
      return new Set<string>();
    }
  });

  return {
    async fetch(row, progress, signal) {
      const ollama = row as OllamaRow;
      let fetched = await child.build(signal, progress);
      progress(fetched);
      for (const layer of layersOf(ollama)) {
        const artifact = { url: `${ollama.source.registry}/blobs/${layer.digest}`, bytes: layer.size, sha256: layer.digest.slice("sha256:".length) };
        await ensureArtifact(artifact, blobOf(layer), { signal, progress: (bytes) => progress(fetched + bytes) });
        fetched += layer.size;
        progress(fetched);
      }
      const file = manifestOf(ollama.source.model);
      const partial = join(child.models, `${row.id}.manifest.partial`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(partial, bytesOf(ollama.source.manifest));
      renameSync(partial, file);
    },
    async remove(row, signal) {
      const ollama = row as OllamaRow;
      rmSync(manifestOf(ollama.source.model), { force: true });
      rmSync(join(child.models, `${row.id}.manifest.partial`), { force: true });
      const left = held();
      for (const layer of layersOf(ollama)) if (!left.some((named) => named.has(layer.digest))) await removeArtifact(blobOf(layer), signal);
      if (left.length === 0) await child.remove();
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
        if (listed.models?.find((each) => each.name === source.model)?.digest !== digestOf(source.manifest)) throw new NotReady(`${row.id} is not held under its manifest's digest`);
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
