import type { Unfit, UseNeed } from "./fit.js";
import type { Input } from "./transport.js";

export type WorkKind = "pictures" | "audio" | "text";
export const WORK_KINDS: readonly WorkKind[] = ["pictures", "audio", "text"];

export type UseId = WorkKind | "chat" | "search" | "hiding";

export interface Use {
  label: string;
  need: UseNeed;
  fill: { thinking: string | null; order?: readonly string[] } | null;
}

export const MODEL_USES: Readonly<Record<UseId, Use>> = {
  pictures: { label: "Photos", need: { input: ["text", "image"], output: "text" }, fill: null },
  audio: { label: "Voice notes", need: { input: ["audio"], output: "text" }, fill: null },
  text: { label: "Text", need: { input: ["text"], output: "text" }, fill: { thinking: null } },
  chat: { label: "Chat", need: { input: ["text"], output: "text", tools: true, context_tokens: 32_000 }, fill: { thinking: "medium", order: ["claude", "codex", "runner", "openrouter"] } },
  search: { label: "Search by meaning", need: { input: ["text"], output: "vectors", stays: true }, fill: null },
  hiding: { label: "Hiding details", need: { input: ["text"], output: "marks", stays: true }, fill: null },
};

export const USE_IDS = Object.keys(MODEL_USES) as readonly UseId[];

export const CHARS_A_TOKEN = 4;

export function workNeed(work: { kind: WorkKind; text_chars?: number | null | undefined }): UseNeed {
  const { need } = MODEL_USES[work.kind];
  return work.text_chars === undefined || work.text_chars === null ? need : { ...need, context_tokens: Math.ceil(work.text_chars / CHARS_A_TOKEN) };
}

const INPUT_WORDS: Readonly<Record<Input, string>> = {
  audio: "can't hear audio",
  image: "can't see photos",
  text: "only writes out audio",
};

const WORDS: Readonly<Record<Exclude<Unfit, { input: unknown }>, string>> = {
  tools: "can't search your record",
  context: "holds too little text for this",
  leaves: "sends text off this Mac",
  output: "doesn't do this",
};

export function unfitWords(name: string, why: Unfit): string {
  return `${name} ${typeof why === "string" ? WORDS[why] : INPUT_WORDS[why.input]}`;
}
