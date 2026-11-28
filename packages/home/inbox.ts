import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join, posix, sep } from "node:path";
import { BLOB_FILE, flush, instant, isObject, makeUnder, TimeError, type BlobFile, type Delivery, type FileKind, type HomeFolder, type JsonObject, type KeptFile } from "@lifestreamprotocol/core";
import { statedAt } from "@lifestreamprotocol/connect";
import { failpoint } from "./failpoint.js";

export { failpoint };

export const MANIFEST_FORMAT = "org.lifestreamprotocol.acquisition/1";
export const MANIFEST_FILE = "manifest.json";
export const SWEPT_FILE = "swept.json";
export const BLOBS_DIRECTORY = "blobs";
export const UPLOAD: FileKind = { role: "upload", passing: true };
const MANIFEST: FileKind = { role: "inbox-manifest" };
const SWEPT: FileKind = { role: "inbox-swept" };
const LANE_FILE = "lane";
const LANE: FileKind = { role: "inbox-lane" };
const DELIVERY = "/delivery";

export interface ManifestFile {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface Manifest {
  readonly format: typeof MANIFEST_FORMAT;
  readonly source_id: string;
  readonly feeder: string;
  readonly fetched_at: string;
  readonly complete: boolean;
  readonly files: ManifestFile[];
  readonly facts: JsonObject;
  readonly pass?: string;
  readonly sealed_at?: string;
  readonly custody?: Custody;
  readonly received?: Received;
  readonly staged_blobs?: readonly string[];
}

export type Received = Readonly<Record<string, Readonly<Record<string, number>>>>;

export interface Lost {
  readonly items: number;
  readonly what: string;
}

export interface Stated {
  readonly seal: number;
  readonly lost?: readonly Lost[];
  readonly history_through?: string;
  readonly types?: readonly string[];
}

export type Custody = Readonly<Record<string, Stated>>;

export interface SealedDelivery extends Delivery {
  readonly feeder: string;
  readonly fetched_at: string;
  readonly pass: string | null;
  readonly stamped_ms: number | null;
  readonly custody: Custody;
  readonly received: Received;
}

export interface DoorStamp {
  readonly pass: string;
  readonly sealed_at: string;
  readonly custody?: Custody;
  readonly received?: Received;
}

export class InboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxError";
  }
}

function bad(message: string): never {
  throw new InboxError(message);
}

const UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/u;
const BASIC = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\.\d{1,9})?Z$/u;
const HEX = /^[0-9a-f]{64}$/u;
const STAGED_BLOB = /^sha256:[0-9a-f]{64}$/u;

export function isSegment(text: string): boolean {
  return text.length > 0 && text !== "." && text !== ".." && !/[/\\\0]/u.test(text);
}

export function timestampMs(text: unknown): number | null {
  if (typeof text !== "string") return null;
  try {
    return instant(text, "rfc3339").start_ms;
  } catch (error) {
    if (error instanceof TimeError) return null;
    throw error;
  }
}

export function basicInstant(instant: string): string {
  if (!UTC_INSTANT.test(instant) || timestampMs(instant) === null) bad(`${JSON.stringify(instant)} is not a full RFC 3339 UTC instant`);
  return instant.replace(/[-:]/gu, "");
}

export function basicMs(name: string): number | null {
  const match = BASIC.exec(name);
  return match === null ? null : timestampMs(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${match[7] ?? ""}Z`);
}

export function statedMs(manifest: Pick<Manifest, "facts" | "fetched_at">): number {
  return statedAt({ ...manifest.facts, fetched_at: manifest.fetched_at });
}

export function parseManifest(text: string, where: string): Manifest {
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { return bad(`${where}: ${(error as Error).message}`); }
  if (!isObject(value)) bad(`${where}: a manifest is a JSON object`);
  if (value.format !== MANIFEST_FORMAT) bad(`${where}: format must be ${MANIFEST_FORMAT}`);
  const source = text_(value.source_id, `${where}: source_id`);
  if (!isSegment(source)) bad(`${where}: source_id ${JSON.stringify(source)} cannot name a directory`);
  const fetchedAt = text_(value.fetched_at, `${where}: fetched_at`);
  basicInstant(fetchedAt);
  if (typeof value.complete !== "boolean") bad(`${where}: complete must be a boolean`);
  if (!Array.isArray(value.files)) bad(`${where}: files must be an array`);
  if (!isObject(value.facts)) bad(`${where}: facts must be a JSON object`);
  const seen = new Set<string>();
  const files = value.files.map((entry: unknown, index: number): ManifestFile => {
    const label = `${where}: files[${index}]`;
    if (!isObject(entry)) bad(`${label} must be a JSON object`);
    const file = text_(entry.file, `${label}.file`);
    if (seen.has(file)) bad(`${label}.file ${JSON.stringify(file)} is listed twice`);
    seen.add(file);
    insideFile(file);
    if (typeof entry.sha256 !== "string" || !HEX.test(entry.sha256)) bad(`${label}.sha256 must be 64 lowercase hex digits`);
    if (typeof entry.bytes !== "number" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) bad(`${label}.bytes must be a whole number`);
    return { ...entry, file, sha256: entry.sha256, bytes: entry.bytes };
  });
  if (value.pass !== undefined && (typeof value.pass !== "string" || !/^p-[0-9a-f]{8}$/u.test(value.pass))) bad(`${where}: pass must be a pass id`);
  if (value.sealed_at !== undefined) basicInstant(text_(value.sealed_at, `${where}: sealed_at`));
  return {
    ...value, format: MANIFEST_FORMAT, source_id: source, feeder: text_(value.feeder, `${where}: feeder`), fetched_at: fetchedAt,
    complete: value.complete, files, facts: value.facts as JsonObject,
    ...(value.custody === undefined ? {} : { custody: readCustody(value.custody, `${where}: custody`) }),
    ...(value.received === undefined ? {} : { received: readReceived(value.received, `${where}: received`) }),
    ...(value.staged_blobs === undefined ? {} : { staged_blobs: readStagedBlobs(value.staged_blobs, `${where}: staged_blobs`) }),
  };
}

function readStagedBlobs(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) bad(`${where} must be an array of sha256:<64 hex>`);
  const seen = new Set<string>();
  for (const [index, hash] of value.entries()) {
    if (typeof hash !== "string" || !STAGED_BLOB.test(hash)) bad(`${where}[${index}] must be sha256:<64 hex>`);
    if (seen.has(hash)) bad(`${where}[${index}] ${hash} is listed twice`);
    seen.add(hash);
  }
  return [...seen];
}

function readReceived(value: unknown, where: string): Received {
  if (!isObject(value)) bad(`${where} must be an object of sources`);
  for (const [source, passes] of Object.entries(value)) {
    if (!isSegment(source) || !isObject(passes)) bad(`${where}[${JSON.stringify(source)}] must be an object of passes`);
    for (const [pass, seal] of Object.entries(passes)) {
      if (!/^p-[0-9a-f]{8}$/u.test(pass) || !Number.isSafeInteger(seal) || (seal as number) < 1) bad(`${where}[${JSON.stringify(source)}][${JSON.stringify(pass)}] must be a seal, a whole number from 1`);
    }
  }
  return value as Received;
}

export function readCustody(value: unknown, where: string): Custody {
  if (!isObject(value)) bad(`${where} must be an object of sources`);
  const custody: Record<string, Stated> = {};
  for (const [source, stated] of Object.entries(value)) {
    const label = `${where}[${JSON.stringify(source)}]`;
    if (!isSegment(source)) bad(`${label} cannot name a source`);
    if (!isObject(stated)) bad(`${label} must be an object`);
    if (!Number.isSafeInteger(stated.seal) || (stated.seal as number) < 1) bad(`${label}.seal must be a whole number from 1`);
    if (stated.lost !== undefined) {
      if (!Array.isArray(stated.lost)) bad(`${label}.lost must be an array`);
      for (const [index, lost] of stated.lost.entries()) {
        if (!isObject(lost) || !Number.isSafeInteger(lost.items) || (lost.items as number) < 0 || typeof lost.what !== "string" || lost.what === "") {
          bad(`${label}.lost[${index}] must state items, a whole number, and what, in words`);
        }
      }
    }
    if (stated.history_through !== undefined && (typeof stated.history_through !== "string" || !Number.isFinite(Date.parse(stated.history_through)))) {
      bad(`${label}.history_through must be an instant`);
    }
    if (stated.types !== undefined && (stated.history_through === undefined || !Array.isArray(stated.types) || stated.types.some((type) => typeof type !== "string" || type === ""))) {
      bad(`${label}.types must be type names, beside a history_through`);
    }
    custody[source] = stated as unknown as Stated;
  }
  return custody;
}

export function manifestOf(folder: HomeFolder, directory: string): KeptFile {
  return folder.file(MANIFEST, join(directory, MANIFEST_FILE));
}

export function receiptOf(folder: HomeFolder, directory: string): KeptFile {
  return folder.file(SWEPT, join(directory, SWEPT_FILE));
}

export function deliveredFile(folder: HomeFolder, directory: string, file: string): KeptFile {
  return folder.file(BLOB_FILE, memberPath(folder, directory, file));
}

export function newMember(folder: HomeFolder, directory: string, file: string): KeptFile {
  const path = memberPath(folder, directory, file);
  makeUnder(directory, dirname(path));
  return folder.file(BLOB_FILE, path);
}

export function removeMembers(folder: HomeFolder, directory: string, files: readonly string[]): number {
  const touched = new Set<string>();
  let removed = 0;
  for (const file of files) {
    const path = memberPath(folder, directory, file);
    if (folder.file(BLOB_FILE, path).remove()) removed++;
    touched.add(pruned(dirname(path), directory));
  }
  for (const at of touched) if (existsSync(at)) flush(at);
  return removed;
}

export function isMember(file: string): boolean {
  return memberName(file) !== undefined;
}

export function makeInbox(folder: HomeFolder): void {
  makeUnder(folder.root, inboxOf(folder));
}

export function lanes(folder: HomeFolder, at: { required?: true; unreadable?: (why: string) => void } = {}): string[] {
  const inbox = inboxOf(folder);
  const found = directoriesIn(inbox, at.required !== true);
  if (folder.form === "plain") return found;
  return found.flatMap((name) => {
    let source: string | undefined;
    try {
      source = folder.file(LANE, join(inbox, name, LANE_FILE)).read()?.toString("utf8");
    } catch (error) {
      at.unreadable?.(`lane ${name}: ${(error as Error).message}`);
      return [];
    }
    if (source !== undefined && isSegment(source) && laneDirectory(folder, source) === join(inbox, name)) return [source];
    at.unreadable?.(`lane ${name}: ${source === undefined ? "its lane file is missing" : "its lane file names another lane"}`);
    return [];
  }).sort();
}

export interface Lane {
  readonly source: string;
  blob(hash: string): KeptFile;
  placed(hash: string): KeptFile;
  blobs(): BlobFile[];
  has(hex: string): "file" | "absent" | "other";
  store(hex: string, input: AsyncIterable<Uint8Array>, bytes: number): Promise<boolean>;
  removeBlobs(hashes: Iterable<string>): number;
  flush(): void;
  remove(): void;
}

class NotItsName extends Error {}

export function inboxLane(folder: HomeFolder, source: string): Lane {
  const directory = laneDirectory(folder, source);
  const blobs = join(directory, BLOBS_DIRECTORY);
  const blob = (hash: string) => folder.blobFile(blobs, hash.startsWith("sha256:") ? hash : `sha256:${hash}`);
  const placed = (hash: string) => {
    makeLane(folder, source);
    makeUnder(directory, blobs);
    return blob(hash);
  };
  return {
    source,
    blob,
    placed,
    blobs: () => (existsSync(blobs) ? folder.blobFiles(blobs) : []),
    has(hex) {
      const kept = blob(hex);
      return kept.stat() !== undefined ? "file" : kept.exists() ? "other" : "absent";
    },
    async store(hex, input, bytes) {
      if (!HEX.test(hex)) bad(`${JSON.stringify(hex)} is not a hex SHA-256`);
      const kept = placed(hex);
      const digest = createHash("sha256");
      if (kept.stat()?.size === bytes) {
        for await (const chunk of input) digest.update(chunk);
        return digest.digest("hex") === hex;
      }
      try {
        await kept.writing((async function* () {
          for await (const chunk of input) { digest.update(chunk); yield chunk; }
          if (digest.digest("hex") !== hex) throw new NotItsName();
        })());
      } catch (error) {
        if (error instanceof NotItsName) return false;
        throw error;
      }
      flush(blobs);
      return true;
    },
    removeBlobs(hashes) {
      const asked = [...hashes];
      const removed = asked.filter((hash) => blob(hash).remove()).length;
      if (asked.length > 0 && existsSync(blobs)) flush(blobs);
      return removed;
    },
    flush: () => flush(blobs),
    remove() {
      rmSync(directory, { recursive: true, force: true });
      if (existsSync(inboxOf(folder))) flush(inboxOf(folder));
    },
  };
}

export function deliveryDirectory(folder: HomeFolder, source: string, name: string): string {
  if (!isSegment(name) || name === BLOBS_DIRECTORY) bad(`${source}/${name} cannot name a delivery`);
  return join(laneDirectory(folder, source), name);
}

export function deliveryAt(folder: HomeFolder, id: string): string {
  const parts = id.split("/");
  if (parts.length !== 2) bad(`${JSON.stringify(id)} is not <source>/<name>`);
  return deliveryDirectory(folder, parts[0]!, parts[1]!);
}

export function deliveriesOf(folder: HomeFolder, source: string): string[] {
  return directoriesIn(laneDirectory(folder, source)).filter((name) => name !== BLOBS_DIRECTORY);
}

export function removeDelivery(folder: HomeFolder, directory: string, at: { point?: string } = {}): void {
  if (!existsSync(directory)) return;
  for (const [index, name] of readdirSync(directory).entries()) {
    rmSync(join(directory, name), { recursive: true, force: true });
    if (index === 0 && at.point !== undefined) failpoint(at.point);
  }
  rmdirSync(directory);
  flush(dirname(directory));
}

function inboxOf(folder: HomeFolder): string {
  return join(folder.root, "inbox");
}

function laneDirectory(folder: HomeFolder, source: string): string {
  if (!isSegment(source)) bad(`${JSON.stringify(source)} cannot name a source`);
  return join(inboxOf(folder), folder.placeName("lane", source));
}

function makeLane(folder: HomeFolder, source: string): string {
  const lane = laneDirectory(folder, source);
  makeUnder(folder.root, lane);
  if (folder.form === "keyed") {
    const named = folder.file(LANE, join(lane, LANE_FILE));
    if (!named.exists()) named.write(Buffer.from(source, "utf8"));
  }
  return lane;
}

function memberPath(folder: HomeFolder, directory: string, file: string): string {
  const name = memberName(file) ?? bad(`file name ${JSON.stringify(file)} leaves the delivery`);
  return join(directory, folder.form === "plain" ? name : folder.placeName("member", name));
}

function memberName(file: string): string | undefined {
  if (file.includes("\0")) return undefined;
  const path = posix.join(DELIVERY, file);
  if (!path.startsWith(`${DELIVERY}/`)) return undefined;
  const name = path.slice(DELIVERY.length + 1).replace(/\/$/u, "");
  return name === "" || [MANIFEST_FILE, SWEPT_FILE].includes(name) ? undefined : name;
}

function pruned(directory: string, root: string): string {
  let current = directory;
  for (; current !== root && current.startsWith(`${root}${sep}`); current = dirname(current)) {
    if (!existsSync(current)) continue;
    if (readdirSync(current).length > 0) return current;
    rmdirSync(current);
  }
  return current;
}

function directoriesIn(path: string, absent = true): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (absent && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function readSealed(folder: HomeFolder, directory: string): Manifest | null {
  const file = manifestOf(folder, directory);
  let bytes: Buffer | undefined;
  try { bytes = file.read(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw error;
  }
  if (bytes === undefined) return null;
  const manifest = parseManifest(bytes.toString("utf8"), file.path);
  return manifest.complete ? manifest : null;
}

export function readDelivery(folder: HomeFolder, source: string, name: string): SealedDelivery | null {
  const manifest = readSealed(folder, deliveryDirectory(folder, source, name));
  if (manifest === null) return null;
  return {
    id: `${source}/${name}`, source, sealed_ms: timestampMs(manifest.fetched_at)!, stated_ms: statedMs(manifest),
    feeder: manifest.feeder, fetched_at: manifest.fetched_at, facts: manifest.facts,
    files: manifest.files.map((entry) => ({ path: entry.file, blob: `sha256:${entry.sha256}`, size: entry.bytes })),
    pass: manifest.pass ?? null, stamped_ms: manifest.sealed_at === undefined ? null : timestampMs(manifest.sealed_at), custody: manifest.custody ?? {},
    received: manifest.received ?? {},
  };
}

export interface Sealing {
  readonly directory: string;
  write(file: string, input: AsyncIterable<Uint8Array>): Promise<ManifestFile>;
  put(file: string, bytes: Uint8Array): ManifestFile;
  adopt(file: string, from: string, measured: { sha256: string; bytes: number }): Promise<ManifestFile>;
  seal(facts: JsonObject, stated?: Manifest, stamp?: DoorStamp): Manifest;
  abandon(): void;
}

export interface SealDisk {
  readonly platform: NodeJS.Platform;
  flush(path: string): void;
}

const SEAL_DISK: SealDisk = { platform: process.platform, flush };

export function openSealing(folder: HomeFolder, input: { source: string; name: string; feeder: string; fetched_at: string }, disk: SealDisk = SEAL_DISK): Sealing {
  basicInstant(input.fetched_at);
  const directory = deliveryDirectory(folder, input.source, input.name);
  if (readSealed(folder, directory) !== null) bad(`${input.source}/${input.name} is already sealed`);
  rmSync(directory, { recursive: true, force: true });
  const lane = makeLane(folder, input.source);
  makeUnder(lane, directory);
  const files: ManifestFile[] = [];
  const listed = new Set<string>();
  const inside = new Set<string>();
  let sealed = false;
  const place = (file: string): string => {
    if (sealed) bad(`${input.source}/${input.name} is sealed`);
    if (listed.has(file)) bad(`${JSON.stringify(file)} is listed twice`);
    listed.add(file);
    insideFile(file);
    const path = memberPath(folder, directory, file);
    makeUnder(directory, dirname(path));
    for (let at = dirname(path); at !== directory; at = dirname(at)) inside.add(at);
    return path;
  };
  return {
    directory,
    async write(file, input) {
      const kept = folder.file(BLOB_FILE, place(file));
      const digest = createHash("sha256");
      let bytes = 0;
      await kept.writing((async function* () {
        for await (const chunk of input) { digest.update(chunk); bytes += chunk.byteLength; yield chunk; }
      })());
      const entry = { file, sha256: digest.digest("hex"), bytes };
      files.push(entry);
      return entry;
    },
    put(file, bytes) {
      folder.file(BLOB_FILE, place(file)).write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      const entry = { file, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
      files.push(entry);
      return entry;
    },
    async adopt(file, from, measured) {
      const kept = folder.file(BLOB_FILE, place(file));
      await kept.adopt(from);
      if (kept.stat()?.size !== measured.bytes) bad(`${JSON.stringify(file)} changed size while it was moved`);
      const entry = { file, sha256: measured.sha256, bytes: measured.bytes };
      files.push(entry);
      return entry;
    },
    seal(facts, stated, stamp) {
      if (sealed) bad(`${input.source}/${input.name} is already sealed`);
      const listed = new Map(stated?.files.map((entry) => [entry.file, entry]));
      const { received: _said, ...said } = stated ?? {};
      const manifest: Manifest = {
        ...said, format: MANIFEST_FORMAT, source_id: input.source, feeder: input.feeder, fetched_at: input.fetched_at,
        complete: true, files: files.map((entry) => ({ ...listed.get(entry.file), ...entry })), facts,
        ...(stamp === undefined ? {} : {
          pass: stamp.pass, sealed_at: stamp.sealed_at, ...(stamp.custody === undefined ? {} : { custody: stamp.custody }),
          ...(stamp.received === undefined ? {} : { received: stamp.received }),
        }),
      };
      parseManifest(JSON.stringify(manifest), "seal");
      failpoint("seal.manifest");
      const mac = disk.platform === "darwin";
      if (!mac) for (const at of [...inside].sort((left, right) => right.length - left.length)) disk.flush(at);
      manifestOf(folder, directory).write(Buffer.from(`${JSON.stringify(manifest)}\n`));
      sealed = true;
      if (!mac) {
        disk.flush(lane);
        disk.flush(inboxOf(folder));
      }
      return manifest;
    },
    abandon() {
      if (!sealed) rmSync(directory, { recursive: true, force: true });
    },
  };
}

function insideFile(file: string): void {
  if ([MANIFEST_FILE, SWEPT_FILE].includes(file) || file.startsWith("/") || file.includes("\\") || file.includes("\0") ||
      file.split("/").some((part) => part === "" || part === "." || part === "..")) {
    bad(`file name ${JSON.stringify(file)} must be a relative, /-separated path`);
  }
}

function text_(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) bad(`${label} must be a non-empty string`);
  return value;
}
