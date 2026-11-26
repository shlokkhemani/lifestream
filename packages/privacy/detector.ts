import type { DetailType } from "@lifestreamprotocol/core";

export interface DetectorModel {
  id: string;
  file: string;
  decode: string;
}

export interface PassageMark {
  start: number;
  end: number;
  type: DetailType;
}

export type DetectorState =
  | { state: "ready"; model: DetectorModel }
  | { state: "downloading"; bytes: number; total: number }
  | { state: "absent"; why: string }
  | { state: "off" };

export type FindFor = "hide" | "mark";

export interface Detector {
  find(passages: readonly string[], by?: FindFor): Promise<{ model: DetectorModel; marks: (PassageMark[] | null)[] }>;
  state(): DetectorState;
}

export function waitLine(state: Exclude<DetectorState, { state: "ready" }>): string {
  if (state.state === "off") return "No model is chosen for Hiding details";
  if (state.state === "absent") return state.why;
  const mb = (bytes: number) => Math.round(bytes / 1_000_000);
  return `Downloading the hiding model: ${mb(state.bytes)} of ${mb(state.total)} MB`;
}
