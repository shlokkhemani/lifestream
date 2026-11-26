import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import Database from "better-sqlite3";
import { homeSchema, openHomeFolder, type Tx } from "@lifestreamprotocol/core";
import { openLedger } from "@lifestreamprotocol/model";
import { releaseFloors, type DeviceKind } from "../devices.js";
import { MODELS_META, type ModelRoute } from "../models.js";
import { mintPrincipal, type Scope } from "../principals.js";
import { checkoutProgram } from "../programs.js";
import { VAULT_FD } from "../vault.js";
import { editSettings, writeFolder } from "./folder.js";

export const REPO = fileURLToPath(new URL("../../../", import.meta.url));
export const NOW_MS = Date.UTC(2026, 8, 8, 4, 0, 0);
export const INSTALL_ONE = "00000000-0000-0000-0000-000000000001";
export const INSTALL_TWO = "00000000-0000-0000-0000-000000000002";
export const PHONE_MODEL = "Synthetic iPhone";
export const PHONE_UNIT = "synthetic-iphone-5a49";
export const PHONE_SOURCE = `phone:${PHONE_UNIT}`;
export const DEVICE = {
  mac: { "lifestream-device": `mac/${releaseFloors().mac}` },
  phone: { "lifestream-device": "phone/1.0.0" },
  extension: { "lifestream-device": "extension/1.0.0" },
} as const;

export const wordsOnly = (words: string): unknown[] => [{ kind: "words", words }];
export const wordsAt = (words: string, at_ms: unknown): unknown[] => [{ kind: "words", words }, { kind: "time", time: { kind: "clock", at_ms } }];

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function zip(members: ReadonlyArray<readonly [string, Uint8Array]>, options: { deflate?: ReadonlySet<string>; zip64?: boolean } = {}): Buffer {
  const wide = options.zip64 === true;
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, input] of members) {
    const bytes = Buffer.from(input), nameBytes = Buffer.from(name, "utf8");
    const method = options.deflate?.has(name) === true ? 8 : 0;
    const data = method === 8 ? deflateRawSync(bytes) : bytes;
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(wide ? 45 : 20, 4); local.writeUInt16LE(1 << 11, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(wide ? 0xffffffff : data.length, 18); local.writeUInt32LE(wide ? 0xffffffff : bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const localExtra = Buffer.alloc(wide ? 20 : 0);
    if (wide) {
      localExtra.writeUInt16LE(1, 0); localExtra.writeUInt16LE(16, 2);
      localExtra.writeBigUInt64LE(BigInt(bytes.length), 4); localExtra.writeBigUInt64LE(BigInt(data.length), 12);
    }
    local.writeUInt16LE(localExtra.length, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(wide ? 45 : 20, 4); central.writeUInt16LE(wide ? 45 : 20, 6);
    central.writeUInt16LE(1 << 11, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(wide ? 0xffffffff : data.length, 20); central.writeUInt32LE(wide ? 0xffffffff : bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(wide ? 0xffffffff : offset, 42);
    const centralExtra = Buffer.alloc(wide ? 28 : 0);
    if (wide) {
      centralExtra.writeUInt16LE(1, 0); centralExtra.writeUInt16LE(24, 2); centralExtra.writeBigUInt64LE(BigInt(bytes.length), 4);
      centralExtra.writeBigUInt64LE(BigInt(data.length), 12); centralExtra.writeBigUInt64LE(BigInt(offset), 20);
    }
    central.writeUInt16LE(centralExtra.length, 30);
    locals.push(local, nameBytes, localExtra, data);
    centrals.push(central, nameBytes, centralExtra);
    offset += 30 + nameBytes.length + localExtra.length + data.length;
  }
  const centralBytes = centrals.reduce((sum, part) => sum + part.length, 0);
  const tail: Buffer[] = [];
  if (wide) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0); record.writeBigUInt64LE(44n, 4); record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(members.length), 24); record.writeBigUInt64LE(BigInt(members.length), 32);
    record.writeBigUInt64LE(BigInt(centralBytes), 40); record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(BigInt(offset + centralBytes), 8); locator.writeUInt32LE(1, 16);
    tail.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(wide ? 0xffff : members.length, 8); end.writeUInt16LE(wide ? 0xffff : members.length, 10);
  end.writeUInt32LE(wide ? 0xffffffff : centralBytes, 12); end.writeUInt32LE(wide ? 0xffffffff : offset, 16);
  return Buffer.concat([...locals, ...centrals, ...tail, end]);
}

export function basic(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/gu, "");
}

export interface AcquisitionInput {
  readonly source: string;
  readonly feeder?: string;
  readonly fetched_ms: number;
  readonly files: ReadonlyArray<readonly [string, Uint8Array]>;
  readonly blobs?: readonly Uint8Array[];
  readonly facts?: Record<string, unknown>;
  readonly manifest?: (manifest: Record<string, unknown>) => Record<string, unknown>;
  readonly extra?: ReadonlyArray<readonly [string, Uint8Array]>;
  readonly deflate?: ReadonlySet<string>;
  readonly custody?: Readonly<Record<string, { seal: number; lost?: { items: number; what: string }[] }>> | undefined;
}

export function acquisitionBundle(input: AcquisitionInput): { id: string; bytes: Buffer; path: string } {
  const fetched_at = new Date(input.fetched_ms).toISOString();
  const blobs = input.blobs ?? [];
  const statements = input.feeder === "owner-statements" ? input.files.find(([file]) => file === "statements.ndjson")?.[1] : undefined;
  const manifest = {
    format: "org.lifestreamprotocol.acquisition/1", source_id: input.source, feeder: input.feeder ?? "machine-events", fetched_at,
    complete: true, files: input.files.map(([file, bytes]) => ({ file, sha256: sha256(bytes), bytes: bytes.length })),
    facts: { ...(statements === undefined ? { snapshot_taken_at: fetched_at } : {}), ...input.facts, blobs_carried: blobs.length },
    ...(input.custody === undefined ? {} : { custody: input.custody }),
  };
  const stated = input.manifest?.(manifest) ?? manifest;
  const bytes = zip([...input.files, ...blobs.map((blob) => [`blobs/${sha256(blob)}`, blob] as const), ...(input.extra ?? []),
    ["manifest.json", Buffer.from(`${JSON.stringify(stated)}\n`)]], input.deflate === undefined ? {} : { deflate: input.deflate });
  const name = statements === undefined ? basic(input.fetched_ms) : `${basic(input.fetched_ms)}.${sha256(statements).slice(0, 12)}`;
  return { id: `${input.source}/${name}`, bytes, path: `/v1/acquisitions/${encodeURIComponent(input.source)}/${name}` };
}

export interface PhoneInput {
  readonly domains?: Readonly<Record<string, readonly number[]>>;
  readonly entries?: Readonly<Record<string, readonly { sequence: number }[]>>;
  readonly install?: string;
  readonly second?: number;
  readonly blobs?: readonly Uint8Array[];
  readonly names?: Readonly<Record<number, string>>;
  readonly declaredHash?: string;
  readonly custody?: Readonly<Record<string, { seal: number; lost?: { items: number; what: string }[]; history_through?: string; types?: string[] }>>;
  readonly range?: { readonly start: string; readonly end: string };
  readonly satOut?: readonly string[];
}

export function phoneLine(domain: string, sequence: number, blob?: string): string {
  return JSON.stringify({
    domain: domain.replace(/\.jsonl$/u, ""), kind: "synthetic", sequence, captured: { wall_rfc3339: "2026-08-31T10:00:00.125+05:30" },
    payload: { latitude: 0, longitude: 0, ...(blob === undefined ? {} : { blob: { hash: blob, type: "application/octet-stream" } }) },
  });
}

export function healthLine(sequence: number): { sequence: number } {
  return { domain: "health", kind: "recorder_event", sequence, captured: { wall_rfc3339: "2026-08-31T10:00:00.125+05:30" }, payload: { event: "synthetic_sweep_completed", detail: { sequence } } } as { sequence: number };
}

export function photoLine(sequence: number, blob: Uint8Array): { sequence: number } {
  return {
    domain: "photos", kind: "asset", sequence, captured: { wall_rfc3339: "2026-08-31T10:00:00.125+05:30" },
    payload: {
      local_identifier: `SYNTHETIC-ASSET-${sequence}`, modification_date: null, creation_date: "2026-08-31T09:00:00Z", media_type: "image",
      media_subtypes: 0, pixel_width: 4, pixel_height: 3, location: null, favorite: false, hidden: false,
      resources: [{ type: "photo", type_raw: 1, uti: "public.jpeg", original_filename: `IMG_${sequence}.JPG`,
        blob: { hash: `sha256:${sha256(blob)}`, bytes: blob.length, type: "image/jpeg", role: "original" } }],
    },
  } as { sequence: number };
}

export function phoneBundle(input: PhoneInput): { id: string; bytes: Buffer } {
  const members: [string, Buffer][] = [];
  const files: Record<string, unknown> = {};
  const domains: [string, string[], number[]][] = [
    ...Object.entries(input.domains ?? {}).map(([name, sequences]): [string, string[], number[]] =>
      [name, sequences.map((sequence) => phoneLine(name, sequence, input.names?.[sequence])), [...sequences]]),
    ...Object.entries(input.entries ?? {}).map(([name, entries]): [string, string[], number[]] =>
      [name, entries.map((entry) => JSON.stringify(entry)), entries.map((entry) => entry.sequence)]),
  ];
  for (const [name, lines, sequences] of domains) {
    const text = lines.map((line) => `${line}\n`).join("");
    const bytes = Buffer.from(text);
    members.push([name, bytes]);
    files[name] = {
      sha256: input.declaredHash !== undefined && members.length === 1 ? input.declaredHash : `sha256:${sha256(bytes)}`,
      bytes: bytes.length, observations: sequences.length,
      ...(sequences.length === 0 ? {} : { first_sequence: sequences[0], last_sequence: sequences.at(-1) }),
    };
  }
  for (const blob of input.blobs ?? []) {
    const name = `blobs/${sha256(blob)}`;
    members.push([name, Buffer.from(blob)]);
    files[name] = { sha256: `sha256:${sha256(blob)}`, bytes: blob.length, observations: 0 };
  }
  const manifest: Record<string, unknown> = {
    schema_version: 3,
    device: {
      machine_model: "iPhoneSynthetic,1", marketing_name: PHONE_MODEL, os_version: "SyntheticOS 1.0",
      install_id: input.install ?? INSTALL_ONE, enrolled_at: "2026-08-31T09:00:00+05:30",
    },
    app_version: "1.0.0-synthetic",
    created_at: `2026-08-31T10:00:${String(input.second ?? 1).padStart(2, "0")}+05:30`,
    time_range_covered: input.range ?? { start: "2026-08-31T09:59:00+05:30", end: "2026-08-31T10:01:00+05:30" },
    files,
    ...(input.custody === undefined ? {} : { custody: input.custody }),
    ...(input.satOut === undefined ? {} : { sat_out: input.satOut }),
  };
  const id = `sha256:${sha256(Buffer.from(sorted(manifest)))}`;
  return { id, bytes: zip([["manifest.json", Buffer.from(JSON.stringify({ ...manifest, bundle_id: id }))], ...members], { zip64: true }) };
}

function sorted(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sorted).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${sorted(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface Home {
  readonly root: string;
  readonly tokens: Readonly<Record<string, string>>;
  readonly ids: Readonly<Record<string, string>>;
}

let emptyLedgerTemplate: string | undefined;

function ledgerTemplate(): string {
  if (emptyLedgerTemplate !== undefined && existsSync(emptyLedgerTemplate)) return emptyLedgerTemplate;
  const dir = mkdtempSync(join(tmpdir(), "lifestream-ledger-template-"));
  mkdirSync(join(dir, "replies"), { recursive: true });
  openLedger(openHomeFolder(dir), { mode: "migrate" }).close();
  emptyLedgerTemplate = dir;
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let emptyHomeDbTemplate: string | undefined;

function homeDbTemplate(): string {
  if (emptyHomeDbTemplate !== undefined && existsSync(emptyHomeDbTemplate)) return emptyHomeDbTemplate;
  const dir = mkdtempSync(join(tmpdir(), "lifestream-homedb-template-"));
  const file = join(dir, "home.db");
  const db = new Database(file);
  homeSchema.open(db, "migrate");
  db.close();
  emptyHomeDbTemplate = file;
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return file;
}

export function makeHome(principals: Readonly<Record<string, { scopes: Scope[]; sources?: string[]; unit?: string; kind?: DeviceKind }>>, roots: string[]): Home {
  const root = mkdtempSync(join(tmpdir(), "door-e2e-"));
  roots.push(root);
  cpSync(ledgerTemplate(), root, { recursive: true, mode: constants.COPYFILE_FICLONE });
  writeFolder(root);
  const tokens: Record<string, string> = {}, ids: Record<string, string> = {};
  Object.entries(principals).forEach(([name, grant], index) => {
    const token = `synthetic-token-${name}`.padEnd(43, "x").slice(0, 43);
    const minted = mintPrincipal(openHomeFolder(root), {
      unit: grant.unit ?? name, kind: grant.kind ?? null, scopes: grant.scopes, sources: grant.sources ?? [], token, now_ms: NOW_MS,
    }, (bytes) => Buffer.alloc(bytes, index + 1));
    tokens[name] = token;
    ids[name] = minted.principal.id;
  });
  return { root, tokens, ids };
}

export const LUNA_ROUTE: ModelRoute = {
  id: "codex:gpt-6-luna", transport: "codex", model: "gpt-6-luna", name: "GPT-6 Luna", input: ["text", "image"], output: "text", tools: true, timed: false, context_tokens: null, thinking: [],
  chat: "program", suggested: [], offered: true, runner: null, leaves: "OpenAI", where: "Sent to OpenAI", cost: "plan",
  request: { effort: "low", sampling: null, timeout_ms: 120_000 }, state: "ready", line: null,
};

export function holdModels(db: Database.Database, routes: readonly ModelRoute[]): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(MODELS_META, JSON.stringify({ routes, runners: [], connections: {} }));
}

export function makeHomeDb(path: string): Database.Database {
  const fresh = !existsSync(path);
  if (fresh) copyFileSync(homeDbTemplate(), path, constants.COPYFILE_FICLONE);
  const db = new Database(path);
  homeSchema.open(db, fresh ? "write" : "migrate");
  return db;
}

export const TEST_CODE = "sha256:test-code";

export function reach(tx: Tx, id: string, source: string, state: "imported" | "failed" | "dead"): void {
  const row = tx.tables.deliveries.get(id, source);
  if (state === "imported") {
    tx.tables.deliveries.move(id, source, row?.state === "importing" && row.run !== null ? { move: "land", run: row.run, refused: 0, error: null, code: TEST_CODE } : { move: "pass" });
  } else if (state === "failed") {
    tx.tables.deliveries.move(id, source, { move: "begin", run: tx.tables.runs.start({ kind: "import", subject: `${source} ${id}`, started_ms: 0 }) });
    tx.tables.deliveries.move(id, source, { move: "fail", error: "synthetic failure" });
  } else tx.tables.deliveries.move(id, source, { move: "give-up", code: TEST_CODE });
}

export type Run = [string, string, number][];

export function custodyRun(db: Database.Database): Run {
  const rows = db.prepare("SELECT id, facts, state, pass, source, seal FROM deliveries").all() as
    { id: string; facts: string; state: string; pass: string | null; source: string; seal: number | null }[];
  const read = (state: string) => state === "imported" || state === "superseded";
  const unread = new Set(rows.filter((row) => !read(row.state)).map((row) => row.id));
  const settled = new Map<string, Set<number>>();
  for (const row of rows) {
    if (row.pass === null || row.seal === null) continue;
    const archive = (JSON.parse(row.facts) as Record<string, unknown>).archive != null;
    if (archive ? !(read(row.state) && !unread.has(row.id)) : !(read(row.state) || row.state === "dead")) continue;
    const key = JSON.stringify([row.pass, row.source]);
    settled.set(key, (settled.get(key) ?? new Set()).add(row.seal));
  }
  const run: Run = [];
  for (const [key, seals] of settled) {
    let n = 0;
    while (seals.has(n + 1)) n++;
    if (n > 0) run.push([...(JSON.parse(key) as [string, string]), n]);
  }
  return run.sort((a, b) => (a.join("\0") < b.join("\0") ? -1 : 1));
}

export function custodyKept(db: Database.Database): Run {
  return (db.prepare("SELECT pass, source, imported FROM custody WHERE imported > 0 ORDER BY pass, source").raw().all() as Run);
}

export function inboxTree(root: string): Record<string, string> {
  const tree: Record<string, string> = {};
  const inbox = join(root, "inbox");
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else tree[relative(inbox, path)] = `${statSync(path).size} ${sha256(readFileSync(path)).slice(0, 12)}`;
    }
  };
  try { walk(inbox); } catch {}
  return tree;
}

export interface DoorProcess {
  readonly url: string;
  readonly lan: number | null;
  readonly logs: string[];
  readonly exited: Promise<string | number | null>;
  readonly child: ChildProcess;
  stop(): Promise<string | number | null>;
}

export async function startDoor(home: Home, env: Record<string, string> = {}, port?: number, fakes = false, slot?: Buffer): Promise<DoorProcess> {
  const lan = (JSON.parse(readFileSync(join(home.root, "config", "settings.json"), "utf8")) as Record<string, unknown>)["door.lan_port"];
  editSettings(home.root, { "door.port": port ?? 0 });
  const program = fakes ? [...checkoutProgram(join(REPO, "packages", "home", "test", "door-child.ts")), home.root] : [...checkoutProgram(join(REPO, "packages", "home", "door-main.ts")), "serve", "--root", home.root];
  const child = spawn(process.execPath, program, {
    cwd: REPO, env: { ...process.env, ...env, ...(slot === undefined ? {} : { [VAULT_FD]: "3" }) }, stdio: ["ignore", "pipe", "pipe", ...(slot === undefined ? [] : ["pipe" as const])],
  });
  if (slot !== undefined) (child.stdio[3] as Writable).end(slot);
  const logs: string[] = [], errors: string[] = [];
  let pending = "";
  let opened!: (line: { port: number; lan?: number }) => void;
  const open = new Promise<{ port: number; lan?: number }>((resolve) => { opened = resolve; });
  child.stdout!.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop()!;
    for (const line of lines) {
      logs.push(line);
      if (line.includes('"door":"open"')) opened(JSON.parse(line) as { port: number; lan?: number });
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => { errors.push(chunk.toString("utf8")); });
  const exited = new Promise<string | number | null>((resolve) => { child.once("exit", (code, signal) => resolve(signal ?? code)); });
  const started = await Promise.race([open, exited.then(() => null)]);
  if (started === null) throw new Error(`the door exited: ${errors.join("")}`);
  editSettings(home.root, { "door.port": started.port, ...(lan === 0 && started.lan !== undefined ? { "door.lan_port": started.lan } : {}) });
  return {
    url: `http://127.0.0.1:${started.port}`, lan: started.lan ?? null, logs, exited, child,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      return exited;
    },
  };
}

export function cleanup(roots: string[]): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
