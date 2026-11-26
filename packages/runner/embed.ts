import { vectorText, type EmbedAnswer, type EmbedRole } from "@lifestreamprotocol/model";
import { Failed } from "./library.js";


export interface Embedder {
  readonly dimensions: number;
  readonly prompts: Readonly<Record<EmbedRole, string>>;
}

export function cut(values: readonly number[], dimensions: number): Float32Array {
  if (values.length < dimensions) throw new Failed("failed", `a vector of ${values.length} dimensions cannot be cut to ${dimensions}`);
  const vector = Float32Array.from(values.slice(0, dimensions));
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) throw new Failed("failed", "a vector with no length cannot be made unit length");
  for (let at = 0; at < dimensions; at++) vector[at]! /= norm;
  return vector;
}

export function embedAnswer(vectors: readonly (readonly number[])[], dimensions: number): string {
  const answer: EmbedAnswer = { dimensions, vectors: vectors.map((values) => vectorText(cut(values, dimensions))) };
  return JSON.stringify(answer);
}

export const EMBEDDINGGEMMA_2_EMBEDS: Embedder = {
  dimensions: 512,
  prompts: { query: "task: search result | query: ", document: "title: none | text: " },
};
