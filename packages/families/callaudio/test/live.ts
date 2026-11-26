import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { audioCallAudio } from "@lifestreamprotocol/connect";
import type { AdapterSource, CallAudioAdapter, Instant, Json, JsonObject } from "@lifestreamprotocol/core";
import { FED } from "../../test/fed.js";
import type { Part, Span } from "../rule.js";

export interface Head {
  readonly stated_ms: number;
  readonly start_ms: number | null;
  readonly end_ms: number | null;
  readonly precision: Instant["precision"] | null;
}

export interface LiveRecord {
  readonly source: string;
  readonly kind: string;
  readonly key: string;
  readonly head: Head;
  readonly content: Json;
}

export interface LivePart extends Part {
  readonly record: LiveRecord;
}

export interface Recorder {
  readonly source: AdapterSource;
  readonly parts: readonly LivePart[];
}

export interface LiveCall extends Span {
  readonly service: string;
}

export interface Live {
  readonly zone: string;
  readonly from_ms: number;
  readonly to_ms: number;
  readonly recorders: readonly Recorder[];
  readonly calls: readonly LiveCall[];
}

interface SourceRow extends AdapterSource {
  readonly kinds: readonly string[];
}

export async function door(route: string): Promise<JsonObject> {
  const machine = process.env.LIFESTREAM_MACHINE_DIR ?? join(homedir(), "Library/Application Support/Lifestream");
  const token = process.env.LIFESTREAM_DOOR_TOKEN ?? readFileSync(join(machine, "reader-token"), "utf8").trim();
  const response = await fetch(`${process.env.LIFESTREAM_DOOR ?? "http://127.0.0.1:4680"}${route}`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return (await response.json()) as JsonObject;
}

async function all<T>(route: string, member: string): Promise<T[]> {
  const items: T[] = [];
  let after: string | undefined;
  do {
    const page = await door(`${route}&limit=1024${after === undefined ? "" : `&after=${after}`}`);
    items.push(...((page[member] ?? []) as unknown as T[]));
    after = typeof page.next === "string" ? page.next : undefined;
  } while (after !== undefined);
  return items;
}

const recorderAdapter = (product: string): CallAudioAdapter | null => (product === "audio" ? audioCallAudio : null);

function versionOf(record: LiveRecord): { kind: string; key: string; content: Json; time?: Instant } {
  const { start_ms, end_ms, precision } = record.head;
  if (start_ms === null || precision === null) return { kind: record.kind, key: record.key, content: record.content };
  return { kind: record.kind, key: record.key, content: record.content, time: end_ms === null ? { start_ms, precision } : { start_ms, end_ms, precision } };
}

async function records(source: string, kind: string, from_ms: number, to_ms: number): Promise<LiveRecord[]> {
  return all<LiveRecord>(`/v1/records?source=${encodeURIComponent(source)}&kind=${encodeURIComponent(kind)}&from_ms=${from_ms}&to_ms=${to_ms}`, "records");
}

export async function readLive(from_ms: number, to_ms: number): Promise<Live> {
  const zone = String((await door("/v1/clock")).zone);
  const sources = (await door("/v1/sources")).sources as unknown as SourceRow[];
  const recorders: Recorder[] = [];
  const calls: LiveCall[] = [];
  for (const row of sources) {
    const source: AdapterSource = { id: row.id, connector: row.connector, product: row.product, account: row.account, copy: row.copy };
    const recorder = recorderAdapter(row.product);
    if (recorder !== null) {
      const parts: LivePart[] = [];
      for (const kind of recorder.kinds) {
        for (const record of await records(row.id, kind, from_ms, to_ms)) {
          const part = recorder.part({ source, version: versionOf(record) });
          if (part !== null) parts.push({ ...part, kind, key: record.key, record });
        }
      }
      recorders.push({ source, parts });
    }
    const caller = FED.calls.find((given) => given.product === row.product)?.adapter;
    if (caller === undefined) continue;
    for (const kind of caller.kinds) {
      for (const record of await records(row.id, kind, from_ms - 86_400_000, to_ms)) {
        const call = caller.call({ source, version: versionOf(record) });
        if (call !== null && call.outcome === "connected" && call.end_ms !== null) calls.push({ start_ms: call.start_ms, end_ms: call.end_ms, service: call.service });
      }
    }
  }
  return { zone, from_ms, to_ms, recorders, calls };
}
