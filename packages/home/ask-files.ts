import { createHash, randomUUID, type Hash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, linkSync, openSync, readdirSync, rmSync, statSync, utimesSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { ask as askConnector } from "@lifestreamprotocol/connect";
import { BLOB_FILE, flush, isObject, makeUnder, sha256, type BlobReader, type FileKind, type HomeFolder, type KeptFile, type OpenedFile, type OpenView } from "@lifestreamprotocol/core";
import { inboxLane, lanes, type Lane } from "./inbox.js";
import { refuse } from "./refusal.js";


export const STAGE_BYTES = 2 * 1024 ** 3;
export const PHOTO_BYTES = 25 * 1024 ** 2;
export const PHOTO_TOO_LARGE = `A photo is at most ${PHOTO_BYTES / 1024 ** 2} MB.`;
export const SECOND_BYTES = 32_000;
export const NOTE_SECONDS = askConnector.VOICE_MS_MAX / 1_000;
export const IDLE_MS = 24 * 3_600_000;
export const STAGE_FULL = "Lifestream has too many unsent photos: send or remove some.";

export const BLOB_NAME = /^sha256:([0-9a-f]{64})$/u;
export const NOTE_ID = /^[0-9a-f]{32}$/u;
export const CHAT_ID = /^[0-9]{13}-[0-9a-f]{6}$/u;
const HEX = /^[0-9a-f]{64}$/u;
const CLOSED = ".closed";
export const ASK_FILE: FileKind = { role: "ask-file" };

export function stageDirOf(root: string): string {
  return join(root, "door", "ask-files");
}

export function stagedFile(folder: HomeFolder, blob: string): KeptFile {
  return folder.blobFile(stageDirOf(folder.root), blob.startsWith("sha256:") ? blob : `sha256:${blob}`, { sharded: true });
}

export function stagedOrStored(store: BlobReader, stage: Pick<Stage, "staged" | "materialise">): BlobReader {
  let last: { hash: string; bytes: Buffer | undefined } | undefined;
  const staged = (hash: string): Buffer | undefined => {
    if (last?.hash !== hash) {
      const bytes = stage.staged(hash)?.bytes();
      last = { hash, bytes: bytes !== undefined && sha256(bytes) === hash ? bytes : undefined };
    }
    return last.bytes;
  };
  const bytes = (hash: string): Buffer => (store.has(hash) ? store.bytes(hash) : staged(hash) ?? store.bytes(hash));
  return {
    has: (hash) => store.has(hash) || stage.staged(hash) !== undefined,
    bytes,
    text: (hash) => bytes(hash).toString("utf8"),
    prefix: (hash, count) => (store.has(hash) ? store.prefix(hash, count) : stage.staged(hash)?.head(count) ?? store.prefix(hash, count)),
    materialise: (hash) => (store.has(hash) ? store.materialise(hash) : stage.materialise(hash)),
  };
}

export function voicedAudio(view: Pick<OpenView, "linked" | "version">, source: string, audio: readonly string[]): string[] {
  const wanted = new Set(audio);
  const found = new Set<string>();
  if (wanted.size === 0) return [];
  for (const { head, blobs } of view.linked(source, "msg")) {
    if (!blobs.some((blob) => wanted.has(blob))) continue;
    const content = view.version(head.version).content;
    const voice = isObject(content) && isObject(content.voice) ? content.voice.audio : undefined;
    if (typeof voice === "string" && wanted.has(voice)) found.add(voice);
  }
  return [...found];
}

export interface Taken {
  readonly ms: number;
  readonly offset_min?: number;
  readonly at?: readonly [number, number];
}

export interface Missing {
  readonly photos?: readonly string[];
  readonly audio?: readonly string[];
  readonly seconds?: readonly number[];
  readonly files?: readonly string[];
}

export const QUESTION_FILES = "The question's files are not all in Lifestream: send them, then ask again.";

export function missingFiles(missing: Missing, words: string): never {
  const named = Object.fromEntries(Object.entries(missing).filter(([, list]) => list !== undefined && list.length > 0));
  return refuse(409, "FILES_MISSING", words, undefined, { missing: named });
}

export interface Staged {
  readonly size: number;
  head(length: number): Buffer;
  bytes(): Buffer;
  stream(range?: { start: number; end: number }): Readable;
}

export interface StageErased {
  readonly removed: string[];
  readonly folders: string[];
}

export interface Stage {
  readonly dir: string;
  has(blob: string): boolean;
  staged(blob: string): Staged | undefined;
  materialise(blob: string): Promise<{ path: string; dispose(): void }>;
  admit<T>(bytes: number, work: () => T): T;
  adopt(from: KeptFile, hex: string): Promise<void>;
  drop(blob: string): boolean;
  second(note: string, k: number, bytes: Buffer): Promise<"kept" | "held">;
  open(note: string): void;
  cancel(note: string): Promise<void>;
  close(note: string): Promise<void>;
  closed(note: string): boolean;
  erased(chat: string): boolean;
  laned(blob: string): boolean;
  join(note: string, seconds: number): Promise<{ audio: string; ms: number }>;
  carry(named: readonly string[], lane: Lane, stored: Pick<BlobReader, "has" | "materialise">): Promise<{ carried: string[]; missing: string[]; undo(): void }>;
  sweep(stored: Pick<BlobReader, "has">): string[];
  erasing(chats: readonly string[]): void;
  erase(blobs: readonly string[]): StageErased;
}

export function openStage(folder: HomeFolder, clock: () => number = Date.now): Stage {
  const { root } = folder;
  const dir = stageDirOf(root);
  const notes = join(dir, "notes");
  const erasedDir = join(dir, "erased");
  const made = (path: string) => makeUnder(root, path);
  const fileOf = (hex: string) => stagedFile(folder, hex);
  const hexOf = (blob: string): string | undefined => BLOB_NAME.exec(blob)?.[1];
  const noted = (path: string) => folder.file(ASK_FILE, path);
  const sizeOf = (file: KeptFile): number | undefined => {
    try {
      return file.stat()?.size;
    } catch {
      return undefined;
    }
  };
  const touch = (file: KeptFile) => {
    try { file.touch(clock()); } catch {}
  };
  const touchFolder = (path: string) => {
    const now = new Date(clock());
    try { utimesSync(path, now, now); } catch {}
  };
  const listed = (at: string): string[] => {
    try { return folder.names(at); } catch { return []; }
  };
  const located = (blob: string): KeptFile | undefined => {
    const hex = hexOf(blob);
    if (hex === undefined) return undefined;
    const file = fileOf(hex);
    return sizeOf(file) === undefined ? undefined : file;
  };
  const askLanes = (): Lane[] => lanes(folder).filter((source) => source.startsWith("ask:")).map((source) => inboxLane(folder, source));
  const laned = (hex: string, lanes: readonly Lane[]) => lanes.some((lane) => lane.blob(hex).stat() !== undefined);
  const closedFile = (note: string) => noted(join(notes, `${note}${CLOSED}`));
  const closedOf = (note: string): string | undefined => {
    try {
      return closedFile(note).read()?.toString("utf8").trim();
    } catch {
      return undefined;
    }
  };
  const bytesOf = (file: KeptFile): Buffer => file.read() ?? gone(file.path);
  const markClosed = async (note: string, audio = "") => {
    const bytes = Buffer.from(audio);
    await write(bytes.length, (temporary) => fill(temporary, [bytes]), () => ({ file: closedFile(note) }));
  };
  const walk = (at: string, each: (path: string, size: number) => void) => {
    let names: string[];
    try { names = readdirSync(at); } catch { return; }
    for (const name of names) {
      const path = join(at, name);
      let stat;
      try { stat = statSync(path); } catch { continue; }
      if (stat.isDirectory()) {
        if (path !== erasedDir) walk(path, each);
      } else each(path, stat.size);
    }
  };
  const bytes = () => {
    let sum = 0;
    walk(dir, (_path, size) => { sum += size; });
    return sum;
  };
  let total: number | undefined;
  const counted = (delta: number) => {
    if (total !== undefined) total = Math.max(0, total + delta);
  };
  const held = new Set<{ bytes: number }>();
  const heldBytes = () => [...held].reduce((sum, each) => sum + each.bytes, 0);
  const room = (more: number) => {
    if ((total ??= bytes()) + heldBytes() + more <= STAGE_BYTES) return;
    total = bytes();
    if (total + heldBytes() + more > STAGE_BYTES) refuse(507, "STAGE_FULL", STAGE_FULL);
  };
  const admit = <T>(more: number, work: () => T): T => {
    if (more > 0) room(more);
    const holding = { bytes: Math.max(0, more) };
    held.add(holding);
    let result: T;
    try {
      result = work();
    } catch (error) {
      held.delete(holding);
      throw error;
    }
    if (result instanceof Promise) return result.finally(() => held.delete(holding)) as T;
    held.delete(holding);
    return result;
  };
  const land = async (temporary: string, file: KeptFile, keep: boolean) => {
    const at = dirname(file.path);
    made(at);
    const was = sizeOf(file);
    if (keep && was !== undefined) rmSync(temporary, { force: true });
    else {
      const size = diskSize(temporary) ?? 0;
      await file.adopt(temporary);
      counted(size - (was ?? 0));
      flush(at);
    }
    touch(file);
  };
  const landing = async (from: KeptFile, file: KeptFile) => {
    const at = dirname(file.path);
    made(at);
    if (sizeOf(file) !== undefined) from.remove();
    else {
      const size = from.stat()?.size ?? 0;
      await file.adopt(from);
      counted(size);
      flush(at);
    }
    touch(file);
  };
  const write = <T>(bytes: number, writing: (temporary: string) => T, target: (filled: T) => { file: KeptFile; keep?: boolean }): Promise<T> => admit(bytes, async () => {
    made(dir);
    const name = randomUUID();
    const work = folder.work(`ask-${name}`, dir);
    const temporary = join(work.path, `.${name}.partial`);
    try {
      const filled = writing(temporary);
      const { file, keep = false } = target(filled);
      await land(temporary, file, keep);
      return filled;
    } finally {
      rmSync(temporary, { force: true });
      work.empty();
    }
  });
  const fill = (temporary: string, chunks: Iterable<Buffer>, digest?: Hash) => {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      for (const chunk of chunks) {
        digest?.update(chunk);
        for (let at = 0; at < chunk.length;) at += writeSync(fd, chunk, at, chunk.length - at);
      }
    } finally {
      closeSync(fd);
    }
  };
  const remove = (file: KeptFile) => {
    const size = sizeOf(file);
    file.remove();
    if (size !== undefined) counted(-size);
  };
  const secondOf = (note: string, k: number) => noted(join(notes, note, String(k)));

  const unjoinable = (note: string, seconds: number): number[] => Array.from({ length: seconds }, (_, k) => k).filter((k) => {
    const size = sizeOf(secondOf(note, k));
    return size === undefined || (k < seconds - 1 ? size !== SECOND_BYTES : size < 2 || size % 2 !== 0);
  });

  const joinNote = async (note: string, seconds: number): Promise<{ audio: string; ms: number }> => {
    const at = join(notes, note);
    const data = Array.from({ length: seconds }, (_, k) => sizeOf(secondOf(note, k))!).reduce((sum, size) => sum + size, 0);
    const hex = await write(askConnector.WAV_HEADER + data, (temporary) => {
      const digest = createHash("sha256");
      fill(temporary, (function* () {
        yield askConnector.wavHeader(data);
        for (let k = 0; k < seconds; k++) yield bytesOf(secondOf(note, k));
      })(), digest);
      return digest.digest("hex");
    }, (hex) => ({ file: fileOf(hex), keep: true }));
    await markClosed(note, `sha256:${hex}`);
    counted(-data);
    rmSync(at, { recursive: true, force: true });
    return { audio: `sha256:${hex}`, ms: askConnector.voiceMs(data / 2) };
  };

  const has = (blob: string) => located(blob) !== undefined;
  const used = (blob: string) => {
    const file = located(blob);
    if (file !== undefined) touch(file);
  };
  const erased = (chat: string) => CHAT_ID.test(chat) && noted(join(erasedDir, chat)).exists();
  const msOf = (blob: string) => {
    const file = located(blob);
    const size = (file === undefined ? undefined : sizeOf(file)) ?? askConnector.WAV_HEADER;
    return askConnector.voiceMs(Math.max(0, size - askConnector.WAV_HEADER) / 2);
  };
  const checkNote = (note: string) => {
    if (!NOTE_ID.test(note)) refuse(422, "NOTE_BAD", "a note's id is 32 hex");
  };

  return {
    dir,
    has,
    staged(blob) {
      const file = located(blob);
      if (file === undefined) return undefined;
      const size = sizeOf(file)!;
      return {
        size,
        head(length) {
          const opened = file.opened() ?? gone(file.path);
          try {
            const buffer = Buffer.alloc(Math.min(length, size));
            return buffer.subarray(0, buffer.length === 0 ? 0 : readAll(opened, buffer));
          } finally {
            opened.close();
          }
        },
        bytes: () => bytesOf(file),
        stream: (range) => file.reading(range),
      };
    },
    async materialise(blob) {
      const file = located(blob);
      if (file === undefined) throw new Error(`${blob} is not staged`);
      touch(file);
      return file.materialise();
    },
    admit,
    async adopt(from, hex) {
      if (!HEX.test(hex)) throw new TypeError(`${hex} is no SHA-256`);
      await landing(from, fileOf(hex));
    },
    drop(blob) {
      const file = located(blob);
      if (file === undefined || laned(hexOf(blob)!, askLanes())) return false;
      remove(file);
      return true;
    },
    async second(note, k, body) {
      checkNote(note);
      if (!Number.isSafeInteger(k) || k < 0 || k >= NOTE_SECONDS) refuse(422, "NOTE_BAD", `a note's second is 0 to ${NOTE_SECONDS - 1}`);
      if (body.length < 2 || body.length > SECOND_BYTES || body.length % 2 !== 0) {
        refuse(422, "NOTE_BAD", `a second is ${SECOND_BYTES} bytes of 16 kHz mono 16-bit PCM, the last 2 to ${SECOND_BYTES}, even`);
      }
      if (closedOf(note) !== undefined) refuse(409, "NOTE_CLOSED", "This voice note was sent or cancelled.");
      const at = join(notes, note);
      const file = secondOf(note, k);
      const was = sizeOf(file);
      if (was === body.length) {
        touch(file);
        return "held";
      }
      await write(body.length, (temporary) => fill(temporary, [body]), () => ({ file }));
      touchFolder(at);
      return "kept";
    },
    open(note) {
      checkNote(note);
      if (closedOf(note) !== undefined) refuse(409, "NOTE_CLOSED", "This voice note was sent or cancelled.");
      made(join(notes, note));
      touchFolder(join(notes, note));
    },
    async cancel(note) {
      checkNote(note);
      for (const name of listed(join(notes, note))) counted(-(sizeOf(noted(join(notes, note, name))) ?? 0));
      rmSync(join(notes, note), { recursive: true, force: true });
      if (closedOf(note) === undefined) await markClosed(note);
    },
    async close(note) {
      if (NOTE_ID.test(note) && closedOf(note) === undefined) await markClosed(note);
    },
    closed: (note) => NOTE_ID.test(note) && closedOf(note) !== undefined,
    erased,
    laned: (blob) => hexOf(blob) !== undefined && laned(hexOf(blob)!, askLanes()),
    async join(note, seconds) {
      checkNote(note);
      if (!Number.isSafeInteger(seconds) || seconds < 1) refuse(422, "NOTE_BAD", "seconds is 1 or more");
      if (seconds > NOTE_SECONDS) refuse(422, "NOTE_BAD", `a note lasts at most ${NOTE_SECONDS} seconds`);
      const joinedAs = closedOf(note);
      if (joinedAs !== undefined && joinedAs !== "" && has(joinedAs)) {
        used(joinedAs);
        return { audio: joinedAs, ms: msOf(joinedAs) };
      }
      const short = unjoinable(note, seconds);
      if (short.length > 0) missingFiles({ seconds: short }, QUESTION_FILES);
      return joinNote(note, seconds);
    },
    async carry(named, lane, stored) {
      const carried: string[] = [];
      const missing: string[] = [];
      const linked: string[] = [];
      const undo = () => {
        lane.removeBlobs(linked);
      };
      try {
        for (const blob of new Set(named)) {
          const hex = hexOf(blob);
          if (hex === undefined || (located(blob) === undefined && !stored.has(blob))) {
            missing.push(blob);
            continue;
          }
          if (located(blob) === undefined) {
            const copy = await stored.materialise(blob);
            try {
              await write(diskSize(copy.path) ?? 0, (temporary) => linkOrCopy(copy.path, temporary), () => ({ file: fileOf(hex), keep: true }));
            } finally {
              copy.dispose();
            }
          }
          const file = located(blob)!;
          touch(file);
          const target = lane.placed(hex);
          if (target.stat() === undefined) {
            await target.link(file);
            linked.push(blob);
          }
          carried.push(blob);
        }
        if (linked.length > 0) lane.flush();
      } catch (error) {
        undo();
        throw error;
      }
      return { carried, missing, undo };
    },
    sweep(stored) {
      const now = clock();
      const lanes = askLanes();
      const removed: string[] = [];
      const idle = (path: string) => {
        try { return now - statSync(path).mtimeMs >= IDLE_MS; } catch { return false; }
      };
      const idleKept = (file: KeptFile) => {
        try {
          const modified_ms = file.stat()?.modified_ms;
          return modified_ms !== undefined && now - modified_ms >= IDLE_MS;
        } catch {
          return false;
        }
      };
      for (const shard of safeList(dir)) {
        const at = join(dir, shard);
        if (shard.startsWith(".")) {
          if (idle(at)) rmSync(at, { force: true });
          continue;
        }
        if (!/^[0-9a-f]{2}$/u.test(shard)) continue;
        let went = false;
        const named = folder.blobFiles(at);
        const blobs = new Set(named.map(({ file }) => basename(file.path)));
        for (const name of listed(at)) {
          const stray = folder.file(BLOB_FILE, join(at, name));
          if (!blobs.has(name) && idleKept(stray)) stray.remove();
        }
        for (const { blob, file } of named) {
          if (!laned(hexOf(blob)!, lanes) && (stored.has(blob) || idleKept(file))) {
            file.remove();
            removed.push(blob);
            went = true;
          }
        }
        if (went) flush(at);
      }
      for (const name of listed(notes)) {
        const path = join(notes, name);
        if (name.endsWith(CLOSED)) {
          if (idleKept(noted(path))) noted(path).remove();
        } else if (idle(path) && listed(path).every((each) => idleKept(noted(join(path, each))))) rmSync(path, { recursive: true, force: true });
      }
      total = bytes();
      return removed;
    },
    erasing(chats) {
      const keyed = chats.filter((chat) => CHAT_ID.test(chat));
      if (keyed.length > 0) made(erasedDir);
      for (const chat of keyed) noted(join(erasedDir, chat)).write(Buffer.from(`${chat}\n`));
    },
    erase(blobs) {
      const folders = new Set<string>();
      const lanes = askLanes();
      const removed: string[] = [];
      for (const blob of new Set(blobs)) {
        const hex = hexOf(blob);
        if (hex === undefined || laned(hex, lanes)) continue;
        const shard = dirname(fileOf(hex).path);
        if (existsSync(shard)) folders.add(shard);
        const file = located(blob);
        if (file === undefined) continue;
        remove(file);
        removed.push(blob);
      }
      return { removed, folders: [...folders] };
    },
  };
}

function linkOrCopy(path: string, target: string): void {
  try {
    linkSync(path, target);
  } catch {
    copyFileSync(path, target);
  }
}

function safeList(at: string): string[] {
  try { return readdirSync(at); } catch { return []; }
}

function readAll(opened: OpenedFile, buffer: Buffer): number {
  let at = 0;
  for (;;) {
    const read = opened.read(buffer.subarray(at), at);
    if (read === 0 || (at += read) >= buffer.length) return at;
  }
}

function diskSize(path: string): number | undefined {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

function gone(path: string): never {
  throw Object.assign(new Error(`ENOENT: ${path} left the stage as it was read`), { code: "ENOENT" });
}
