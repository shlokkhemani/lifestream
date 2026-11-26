import { createHash, type Hash } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { BLOB_FILE, flush, makeUnder, type BlobReader, type HomeFolder, type KeptFile, type WriteKind } from "@lifestreamprotocol/core";
import { BLOB_NAME, IDLE_MS } from "./ask-files.js";
import type { Lane } from "./inbox.js";
import { refuse } from "./refusal.js";
import { moving } from "./silence.js";


export type Put = { readonly held: true } | { readonly landed: true } | { readonly cut: { readonly offset: number; readonly held: number } };

export interface AdmittedBody {
  readonly kind: WriteKind;
  need: number;
  landed: number;
}

export interface Receiving {
  readonly stored: Pick<BlobReader, "has">;
  readonly admitted: Set<AdmittedBody>;
  readonly inBody: Set<IncomingMessage>;
  readonly silentMs: number;
  readonly recheckBytes: number;
  room(kind: WriteKind, more: number): void;
  received(request: IncomingMessage, bytes: number): void;
  mark(): void;
}

export interface Stated {
  readonly offset: number;
  readonly length: number;
  readonly kind: WriteKind;
}

export interface Carried {
  readonly carried: string[];
  sealed(): void;
  undo(): void;
}

export interface StagedFiles {
  held(names: readonly string[]): { staged: string[]; partly: Record<string, number> };
  put(name: string, request: IncomingMessage, stated: Stated): Promise<Put>;
  carry(named: readonly string[], lane: Lane): Promise<Carried>;
  spare(bytes: number): number;
  sweep(stored: Pick<BlobReader, "has">): number;
  erase(names: readonly string[]): string[];
}

interface Busy {
  end: (() => void) | undefined;
  readonly done: Promise<void>;
}

interface Part {
  readonly start: number;
  readonly file: KeptFile;
  readonly size: number;
}

interface Droppable {
  readonly touched: number;
  readonly bytes: number;
  drop(): void;
}

const PIECE = /^(?:0|[1-9][0-9]*)$/u;
const SHARD = /^[0-9a-f]{2}$/u;
const EMPTY = createHash("sha256").digest("hex");

class NotItsName extends Error {}

export function openStagedFiles(folder: HomeFolder, opened: { readonly clock?: () => number; readonly receiving?: Receiving } = {}): StagedFiles {
  const clock = opened.clock ?? Date.now;
  const { root } = folder;
  const dir = join(root, "door", "files");
  const partsDir = join(dir, "parts");
  const states = new Map<string, Busy>();
  const hexOf = (name: string): string | undefined => BLOB_NAME.exec(name)?.[1];
  const whole = (name: string): KeptFile => folder.blobFile(dir, name, { sharded: true });
  const partsAt = (name: string): string => join(partsDir, folder.placeName("parts", hexOf(name)!));
  const statOf = (file: KeptFile) => {
    try {
      return file.stat();
    } catch {
      return undefined;
    }
  };
  const touch = (file: KeptFile): void => {
    try { file.touch(clock()); } catch {}
  };
  const flushed = (path: string): void => {
    if (existsSync(path)) flush(path);
  };
  const partsOf = (at: string): Part[] => {
    let names: string[];
    try { names = folder.names(at); } catch { return []; }
    return names.filter((name) => PIECE.test(name)).flatMap((name) => {
      const file = folder.file(BLOB_FILE, join(at, name));
      const size = statOf(file)?.size;
      return size === undefined ? [] : [{ start: Number(name), file, size }];
    }).sort((a, b) => a.start - b.start);
  };
  const dropParts = (at: string): boolean => {
    if (!existsSync(at)) return false;
    rmSync(at, { recursive: true, force: true });
    flushed(partsDir);
    return true;
  };
  const heldAt = (at: string): number => {
    let held = 0;
    for (const part of partsOf(at)) {
      if (part.start !== held) {
        dropParts(at);
        return 0;
      }
      held += part.size;
    }
    return held;
  };
  const placeWhole = async (name: string, part: KeptFile, at: string): Promise<void> => {
    const target = whole(name);
    try {
      await target.link(part);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    flushed(dirname(target.path));
    dropParts(at);
  };
  const bad = (name: string, at: string, digest: string): never => {
    dropParts(at);
    return refuse(422, "FILE_BAD", `the bytes' SHA-256 is sha256:${digest}, not ${name}`);
  };
  const joinParts = async (name: string, at: string): Promise<void> => {
    const hex = hexOf(name)!;
    const digest = createHash("sha256");
    const target = whole(name);
    const parts = partsOf(at);
    try {
      await target.writing((async function* () {
        for (const { file } of parts) {
          for await (const chunk of file.reading() as AsyncIterable<Buffer>) {
            digest.update(chunk);
            yield chunk;
          }
        }
        if (digest.copy().digest("hex") !== hex) throw new NotItsName();
      })());
    } catch (error) {
      if (error instanceof NotItsName) bad(name, at, digest.digest("hex"));
      throw error;
    }
    flushed(dirname(target.path));
    dropParts(at);
  };
  const shards = (): string[] => safeList(dir).filter((name) => SHARD.test(name)).map((name) => join(dir, name));
  const wholes = () => shards().flatMap((shard) => folder.blobFiles(shard));
  const partDirs = (): string[] => safeList(partsDir).map((name) => join(partsDir, name));
  const busyParts = (): Set<string> => new Set([...states.keys()].map(partsAt));
  const idleSince = (at: string): number => {
    const parts = partsOf(at);
    return parts.length === 0 ? modifiedOf(at) : Math.max(...parts.map((part) => statOf(part.file)?.modified_ms ?? 0));
  };

  const receive = async (request: IncomingMessage, at: string, start: number, body: AdmittedBody, door: Receiving, digest: Hash | undefined): Promise<number> => {
    let read = 0;
    let checked = 0;
    const arriving = moving(request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>, door.silentMs, () => request.destroy())[Symbol.asyncIterator]();
    const next = async (): Promise<Buffer | undefined> => {
      let step: IteratorResult<Buffer>;
      try {
        step = await arriving.next();
      } catch {
        return undefined;
      }
      if (step.done === true) return undefined;
      read += step.value.byteLength;
      body.landed = read;
      door.received(request, read);
      if (read - checked >= door.recheckBytes) {
        checked = read;
        door.room(body.kind, 0);
      }
      digest?.update(step.value);
      return step.value;
    };
    door.inBody.add(request);
    door.mark();
    try {
      const first = await next();
      if (first === undefined) return 0;
      makeUnder(root, at);
      await folder.file(BLOB_FILE, join(at, String(start))).writing((async function* () {
        for (let chunk: Buffer | undefined = first; chunk !== undefined; chunk = await next()) yield chunk;
      })());
      flush(at);
      return read;
    } finally {
      door.inBody.delete(request);
      void arriving.return?.(undefined);
    }
  };

  if (opened.receiving !== undefined) {
    for (const at of [dir, partsDir, ...shards(), ...partDirs()]) {
      for (const name of safeList(at)) if (name.startsWith(".") || name.endsWith(".tmp")) rmSync(join(at, name), { recursive: true, force: true });
    }
    for (const { blob } of wholes()) dropParts(partsAt(blob));
  }

  return {
    held(names) {
      const staged: string[] = [];
      const partly: Record<string, number> = {};
      for (const name of new Set(names)) {
        if (hexOf(name) === undefined) continue;
        const file = whole(name);
        if (statOf(file) !== undefined) {
          touch(file);
          staged.push(name);
          continue;
        }
        const held = heldAt(partsAt(name));
        if (held > 0) partly[name] = held;
      }
      return { staged, partly };
    },

    async put(name, request, stated) {
      const door = opened.receiving ?? (() => { throw new Error("a staged file takes a body only in the door"); })();
      if (hexOf(name) === undefined) throw new TypeError(`${name} is no sha256:<64 hex>`);
      for (;;) {
        const file = whole(name);
        if (door.stored.has(name) || statOf(file) !== undefined) {
          touch(file);
          return { held: true };
        }
        const busy = states.get(name);
        if (busy === undefined) break;
        busy.end?.();
        await busy.done;
      }
      const at = partsAt(name);
      const held = heldAt(at);
      if (stated.offset !== held) refuse(409, "UPLOAD_OFFSET", `Lifestream holds ${held} bytes of this file: send it from there.`, undefined, { held });
      const size = stated.offset + stated.length;
      const body: AdmittedBody = { kind: stated.kind, need: stated.offset === 0 ? stated.length : stated.length + size, landed: 0 };
      let finish!: () => void;
      const busy: Busy = { end: () => request.destroy(), done: new Promise((resolve) => { finish = resolve; }) };
      states.set(name, busy);
      try {
        door.room(stated.kind, body.need);
        door.admitted.add(body);
        if (stated.length === 0 && stated.offset === 0) {
          if (hexOf(name) !== EMPTY) bad(name, at, EMPTY);
          whole(name).write(Buffer.alloc(0));
          return { landed: true };
        }
        const digest = stated.offset === 0 ? createHash("sha256") : undefined;
        const read = stated.length === 0 ? 0 : await receive(request, at, stated.offset, body, door, digest);
        if (read < stated.length) return { cut: { offset: stated.offset, held: stated.offset + read } };
        busy.end = undefined;
        if (digest === undefined) await joinParts(name, at);
        else {
          const landed = digest.digest("hex");
          if (landed !== hexOf(name)) bad(name, at, landed);
          await placeWhole(name, folder.file(BLOB_FILE, join(at, "0")), at);
        }
        return { landed: true };
      } finally {
        door.admitted.delete(body);
        if (states.get(name) === busy) states.delete(name);
        finish();
      }
    },

    async carry(named, lane) {
      const carried: string[] = [];
      const linked: string[] = [];
      try {
        for (const name of new Set(named)) {
          const hex = hexOf(name);
          if (hex === undefined) continue;
          const file = whole(name);
          if (statOf(file) === undefined) continue;
          const target = lane.placed(hex);
          if (target.stat() === undefined) {
            await target.link(file);
            linked.push(name);
          }
          carried.push(name);
        }
        if (linked.length > 0) lane.flush();
      } catch (error) {
        lane.removeBlobs(linked);
        throw error;
      }
      return {
        carried,
        sealed() {
          const at = new Set<string>();
          for (const name of carried) {
            const file = whole(name);
            if (file.remove()) at.add(dirname(file.path));
          }
          for (const shard of at) flushed(shard);
        },
        undo() {
          lane.removeBlobs(linked);
        },
      };
    },

    spare(bytes) {
      if (!(bytes > 0)) return 0;
      const busy = busyParts();
      const idle: Droppable[] = [
        ...wholes().filter(({ blob }) => !states.has(blob)).flatMap(({ file }): Droppable[] => {
          const stat = statOf(file);
          return stat === undefined ? [] : [{ touched: stat.modified_ms, bytes: stat.size, drop: () => void file.remove() }];
        }),
        ...partDirs().filter((at) => !busy.has(at)).map((at): Droppable => ({
          touched: idleSince(at), bytes: partsOf(at).reduce((sum, part) => sum + part.size, 0), drop: () => void rmSync(at, { recursive: true, force: true }),
        })),
      ].sort((a, b) => a.touched - b.touched);
      let freed = 0;
      for (const each of idle) {
        if (freed >= bytes) break;
        each.drop();
        freed += each.bytes;
      }
      if (freed > 0) for (const at of [partsDir, ...shards()]) flushed(at);
      return freed;
    },

    sweep(stored) {
      const now = clock();
      const busy = busyParts();
      let removed = 0;
      for (const { blob, file } of wholes()) {
        if (states.has(blob)) continue;
        const touched = statOf(file)?.modified_ms;
        if (stored.has(blob) || (touched !== undefined && now - touched >= IDLE_MS)) {
          if (file.remove()) removed++;
        }
      }
      for (const at of partDirs()) {
        if (busy.has(at) || now - idleSince(at) < IDLE_MS) continue;
        rmSync(at, { recursive: true, force: true });
        removed++;
      }
      if (removed > 0) for (const at of [partsDir, ...shards()]) flushed(at);
      return removed;
    },

    erase(names) {
      const removed: string[] = [];
      for (const name of new Set(names)) {
        if (hexOf(name) === undefined) continue;
        const file = whole(name);
        const went = file.remove();
        if (went) flushed(dirname(file.path));
        if (dropParts(partsAt(name)) || went) removed.push(name);
      }
      return removed;
    },
  };
}

function safeList(at: string): string[] {
  try { return readdirSync(at); } catch { return []; }
}

function modifiedOf(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}
