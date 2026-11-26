import type { RunnerAnswer, RunnerCall, RunnerFailure } from "@lifestreamprotocol/model";
import type { Row } from "./files.js";

export interface Library {
  fetch(row: Row, progress: (fetched: number, bytes?: number) => void, signal: AbortSignal): Promise<void>;
  remove(row: Row, signal: AbortSignal): Promise<void>;
  run(row: Row, call: RunnerCall, signal: AbortSignal): Promise<RunnerAnswer>;
  close(): Promise<void>;
}

export class NotReady extends Error {
  override name = "NotReady";
}

export class Failed extends Error {
  override name = "Failed";
  constructor(readonly reason: RunnerFailure, message: string, readonly seconds?: number) {
    super(message);
  }
}
