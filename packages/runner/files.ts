import { createHash } from "node:crypto";
import type { Abilities, Artifact, Build } from "@lifestreamprotocol/model";
import { DECODE } from "./decode.js";
import { EMBEDDINGGEMMA_2_EMBEDS, EMBEDDINGGEMMA_2_Q8, type Embedder } from "./embed.js";
import { QWEN_3_5_4B } from "./qwen.js";


interface Shared extends Readonly<Abilities> {
  readonly id: string;
  readonly name: string;
  readonly platforms: readonly string[];
  readonly languages: readonly string[];
  readonly memory_gb: number;
  readonly bytes: number;
}

export interface SpeechRow extends Shared {
  readonly library: "speech";
  readonly source: Artifact;
}

export interface OllamaLayer {
  readonly mediaType: string;
  readonly digest: string;
  readonly size: number;
  readonly name?: string;
  readonly from?: string;
}

export interface OllamaManifest {
  readonly schemaVersion: 2;
  readonly mediaType: string;
  readonly config: OllamaLayer;
  readonly layers: readonly OllamaLayer[];
  readonly runner?: string;
  readonly format?: string;
}

export interface OllamaRow extends Shared {
  readonly library: "ollama";
  readonly source: { readonly model: string; readonly registry: string; readonly manifest: OllamaManifest };
  readonly embed?: Embedder;
}

export interface DetectorFiles {
  readonly graph: Artifact;
  readonly weights: Artifact;
  readonly tokenizer: Artifact;
  readonly tokenizer_config: Artifact;
  readonly config: Artifact;
}

export interface DetectorRow extends Shared {
  readonly library: "detector";
  readonly source: DetectorFiles;
  readonly key: { readonly file: string; readonly decode: string };
}

export type Row = SpeechRow | OllamaRow | DetectorRow;
export type LibraryName = Row["library"];

export const OLLAMA: Build = {
  name: "ollama",
  version: "0.40.16",
  artifact: {
    url: "https://github.com/ollama/ollama/releases/download/v0.40.16/ollama-darwin.tgz",
    bytes: 186_116_182, sha256: "a743717494315da7cd352982b805f6b992d4b4452ca117fd5fbf86c4ee46fca0",
  },
  entry: "ollama",
  team: "3MU9H2V9Y9",
};

const hugging = (repo: string, revision: string, file: string): string => `https://huggingface.co/${repo}/resolve/${revision}/${file}`;

const SPEECH_PLATFORMS: readonly string[] = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"];

export const speechRow = (row: Omit<SpeechRow, "library" | "bytes">): SpeechRow => ({ ...row, library: "speech", bytes: row.source.bytes });

export const ollamaRow = (row: Omit<OllamaRow, "library" | "bytes">): OllamaRow => ({
  ...row, library: "ollama", bytes: [row.source.manifest.config, ...row.source.manifest.layers].reduce((sum, layer) => sum + layer.size, OLLAMA.artifact.bytes),
});

export const DETECTOR_FILES: readonly (keyof DetectorFiles)[] = ["config", "tokenizer_config", "tokenizer", "graph", "weights"];

export const detectorRow = (row: Omit<DetectorRow, "library" | "bytes" | "key">): DetectorRow => {
  const files = DETECTOR_FILES.map((name) => row.source[name]);
  const named = [...DETECTOR_FILES].sort().map((name) => `${name} ${row.source[name].sha256}`);
  const file = `sha256:${createHash("sha256").update(named.join("\n")).digest("hex")}`;
  return { ...row, library: "detector", bytes: files.reduce((sum, each) => sum + each.bytes, 0), key: { file, decode: DECODE } };
};

const PRIVACY_FILTER = (file: string) => hugging("openai/privacy-filter", "7ffa9a043d54d1be65afb281eddf0ffbe629385b", file);

const ONNX_PLATFORMS: readonly string[] = ["darwin-arm64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"];

export const FILES: readonly Row[] = [
  ollamaRow({
    id: "qwen3.5-4b", name: "Qwen 3.5", input: ["text", "image"], output: "text", tools: false, context_tokens: 4_000, thinking: [], platforms: ["darwin-arm64"], languages: [], memory_gb: 16,
    source: { model: "qwen3.5:4b", registry: "https://registry.ollama.ai/v2/library/qwen3.5", manifest: QWEN_3_5_4B },
  }),
  ollamaRow({
    id: "embeddinggemma-2-q8-512", name: "EmbeddingGemma 2", input: ["text"], output: "vectors", tools: false, context_tokens: 2_048, thinking: [], platforms: ["darwin-arm64"], languages: [], memory_gb: 8,
    source: { model: "embeddinggemma-2:270m-q8_0-text", registry: "https://registry.ollama.ai/v2/library/embeddinggemma-2", manifest: EMBEDDINGGEMMA_2_Q8 },
    embed: EMBEDDINGGEMMA_2_EMBEDS,
  }),
  speechRow({
    id: "parakeet-unified-en-0.6b", name: "Parakeet", input: ["audio"], output: "text", tools: false, context_tokens: null, thinking: [], platforms: SPEECH_PLATFORMS, memory_gb: 8,
    languages: ["en"],
    source: {
      url: hugging("handy-computer/parakeet-unified-en-0.6b-gguf", "7e948f21b7bdbac698d3318db9d350f1096f3b6c", "parakeet-unified-en-0.6b-Q8_0.gguf"),
      bytes: 731_357_568, sha256: "4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795",
    },
  }),
  speechRow({
    id: "nemotron-3.5-asr-0.6b", name: "Nemotron Speech", input: ["audio"], output: "text", tools: false, context_tokens: null, thinking: [], platforms: SPEECH_PLATFORMS, memory_gb: 8,
    languages: ["en", "es", "fr", "it", "pt", "nl", "de", "tr", "ru", "ar", "hi", "ja", "ko", "vi", "uk", "pl", "sv", "cs", "nb", "da", "bg", "fi", "hr", "sk", "zh", "hu", "ro", "et"],
    source: {
      url: hugging("handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf", "53ce288f69326b415aeef030cfcb02a08a8096dd", "nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf"),
      bytes: 751_094_240, sha256: "b94545b313b3223fda7b2857a52681da813935c2127643d1e9ff0c23d988089c",
    },
  }),
  detectorRow({
    id: "privacy-filter", name: "Privacy Filter", input: ["text"], output: "marks", tools: false, context_tokens: 8_000, thinking: [], platforms: ONNX_PLATFORMS, languages: [], memory_gb: 8,
    source: {
      graph: { url: PRIVACY_FILTER("onnx/model_quantized.onnx"), bytes: 162_239, sha256: "a325fb5341567a73c94e91ec5e49060d38d9b16111f518ad34773039a0c9c098" },
      weights: { url: PRIVACY_FILTER("onnx/model_quantized.onnx_data"), bytes: 1_618_042_064, sha256: "50f4c8c7f3c27fbc1fe16d4f74f6f7c3b74ba8f18a262e8b6911854c64c33a6d" },
      tokenizer: { url: PRIVACY_FILTER("tokenizer.json"), bytes: 27_868_174, sha256: "0614fe83cadab421296e664e1f48f4261fa8fef6e03e63bb75c20f38e37d07d3" },
      tokenizer_config: { url: PRIVACY_FILTER("tokenizer_config.json"), bytes: 234, sha256: "6c14af9ce1a284d3c3c5146b26efe4cd589c68e1dd4e9d94455606ec911ba774" },
      config: { url: PRIVACY_FILTER("config.json"), bytes: 3_039, sha256: "b2b26a4a4a000639ad30b0c264adbefe365bdb567fbd7bb27303b8c438375bd1" },
    },
  }),
];

export const PLATFORM = `${process.platform}-${process.arch}`;

export const ROWS: readonly Row[] = FILES.filter((row) => row.platforms.includes(PLATFORM));
