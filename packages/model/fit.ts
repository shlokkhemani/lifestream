import type { Abilities, Input, Output } from "./transport.js";

export interface UseNeed {
  input: readonly Input[];
  output: Output;
  tools?: true;
  timed?: true;
  context_tokens?: number;
  stays?: true;
}

export type Unfit = { input: Input } | "output" | "tools" | "timed" | "context" | "leaves";

export function unfit(model: Abilities & { leaves: string | null }, need: UseNeed): Unfit | null {
  if (model.output !== need.output) return "output";
  const missing = need.input.find((input) => !model.input.includes(input));
  if (missing !== undefined) return { input: missing };
  if (need.tools === true && !model.tools) return "tools";
  if (need.timed === true && !model.timed) return "timed";
  if (need.context_tokens !== undefined && model.context_tokens !== null && model.context_tokens < need.context_tokens) return "context";
  if (need.stays === true && model.leaves !== null) return "leaves";
  return null;
}
