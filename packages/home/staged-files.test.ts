import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { BLOB_FILE, openHomeFolder, type HomeFolder, type WriteKind } from "@lifestreamprotocol/core";
import { keyedFolder, testMachine } from "@lifestreamprotocol/core/test/keyed";
import { IDLE_MS } from "./ask-files.js";
import { inboxLane } from "./inbox.js";
import { refuse, Refusal } from "./refusal.js";
import { openStagedFiles, type AdmittedBody, type Receiving, type StagedFiles } from "./staged-files.js";

const NOW = Date.UTC(2026, 10, 26, 12);
const LANE = "phone:iphone-0001";
const made: string[] = [];

afterAll(() => {
  for (const each of made) rmSync(each, { recursive: true, force: true });
});

const nameOf = (bytes: Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const fileBytes = (label: string, size = 4_096): Buffer => Buffer.alloc(size, label);

interface Rig {
  readonly folder: HomeFolder;
  readonly files: StagedFiles;
  readonly stored: Set<string>;
  readonly rooms: { kind: WriteKind; more: number }[];
  readonly admitted: Set<AdmittedBody>;
  clock: number;
  refuseRoom: ((more: number) => boolean) | undefined;
  arrived(request: IncomingMessage, bytes: number): Promise<void>;
  reopen(): StagedFiles;
}

function rigOf(form: "plain" | "keyed", recheckBytes = Number.MAX_SAFE_INTEGER): Rig {
  const root = mkdtempSync(join(tmpdir(), `lifestream-staged-${form}-`));
  made.push(root);
  const folder = form === "plain" ? openHomeFolder(root) : keyedFolder(root, testMachine());
  const waiting = new Map<IncomingMessage, { bytes: number; resolve: () => void }[]>();
  const landed = new WeakMap<IncomingMessage, number>();
  const rig: Rig = {
    folder, stored: new Set(), rooms: [], admitted: new Set(), clock: NOW, refuseRoom: undefined,
    files: undefined as unknown as StagedFiles,
    arrived(request, bytes) {
      if ((landed.get(request) ?? 0) >= bytes) return Promise.resolve();
      return new Promise((resolve) => waiting.set(request, [...waiting.get(request) ?? [], { bytes, resolve }]));
    },
    reopen() {
      const receiving: Receiving = {
        stored: { has: (blob) => rig.stored.has(blob) }, admitted: rig.admitted, inBody: new Set(), silentMs: 30_000, recheckBytes,
        room(kind, more) {
          rig.rooms.push({ kind, more });
          if (rig.refuseRoom?.(more) === true) refuse(503, "DISK_LOW", "the synthetic disk is full");
        },
        received(request, bytes) {
          landed.set(request, bytes);
          const left = (waiting.get(request) ?? []).filter((each) => {
            if (each.bytes > bytes) return true;
            each.resolve();
            return false;
          });
          waiting.set(request, left);
        },
        mark: () => undefined,
      };
      return (rig as { files: StagedFiles }).files = openStagedFiles(folder, { clock: () => rig.clock, receiving });
    },
  };
  rig.reopen();
  return rig;
}

function body(...chunks: Buffer[]): { request: IncomingMessage; stream: PassThrough } {
  const stream = new PassThrough();
  for (const chunk of chunks) stream.write(chunk);
  return { request: stream as unknown as IncomingMessage, stream };
}

function whole(...chunks: Buffer[]): IncomingMessage {
  const { request, stream } = body(...chunks);
  stream.end();
  return request;
}

const stated = (offset: number, length: number) => ({ offset, length, kind: "new" as const });

function partsDir(rig: Rig, name: string): string {
  return join(rig.folder.root, "door", "files", "parts", rig.folder.placeName("parts", name.slice("sha256:".length)));
}

function writePart(rig: Rig, name: string, start: number, bytes: Buffer): void {
  rig.folder.file(BLOB_FILE, join(partsDir(rig, name), String(start))).write(bytes);
}

function stagedWhole(rig: Rig, name: string) {
  return rig.folder.blobFile(join(rig.folder.root, "door", "files"), name, { sharded: true });
}

function pathsUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? [path, ...pathsUnder(path)] : [path];
  });
}

async function refusal(work: Promise<unknown>): Promise<Refusal> {
  try {
    await work;
  } catch (error) {
    if (error instanceof Refusal) return error;
    throw error;
  }
  throw new Error("the put was not refused");
}

describe.each(["plain", "keyed"] as const)("the staged files of a %s home", (form) => {
  it("lands a whole file in one put as a link of its one part, says it staged, and answers held to a second put with its body unread", async () => {
    const rig = rigOf(form);
    const bytes = fileBytes("a");
    const name = nameOf(bytes);
    expect(await rig.files.put(name, whole(bytes.subarray(0, 1_000), bytes.subarray(1_000)), stated(0, bytes.length))).toEqual({ landed: true });
    expect(rig.rooms).toEqual([{ kind: "new", more: bytes.length }]);
    expect(stagedWhole(rig, name).read()).toEqual(bytes);
    expect(stagedWhole(rig, name).stat()?.links).toBe(1);
    expect(existsSync(partsDir(rig, name))).toBe(false);
    expect(rig.files.held([name])).toEqual({ staged: [name], partly: {} });
    const unread = body(Buffer.from("never read"));
    expect(await rig.files.put(name, unread.request, stated(0, bytes.length))).toEqual({ held: true });
    expect(unread.stream.readableLength).toBe(10);
    rig.stored.add(nameOf(Buffer.from("in the store")));
    expect(await rig.files.put(nameOf(Buffer.from("in the store")), body().request, stated(0, 12))).toEqual({ held: true });
    expect(rig.rooms).toHaveLength(1);
  });

  it("writes no part for a body cut before its first byte, and keeps every byte read of one cut mid-body", async () => {
    const rig = rigOf(form);
    const bytes = fileBytes("b");
    const name = nameOf(bytes);
    const none = body();
    none.stream.destroy();
    expect(await rig.files.put(name, none.request, stated(0, bytes.length))).toEqual({ cut: { offset: 0, held: 0 } });
    expect(existsSync(partsDir(rig, name))).toBe(false);
    const half = body(bytes.subarray(0, 1_500));
    const putting = rig.files.put(name, half.request, stated(0, bytes.length));
    await rig.arrived(half.request, 1_500);
    half.stream.destroy();
    expect(await putting).toEqual({ cut: { offset: 0, held: 1_500 } });
    expect(rig.files.held([name])).toEqual({ staged: [], partly: { [name]: 1_500 } });
    expect(rig.admitted.size).toBe(0);
    expect(await rig.files.put(name, whole(bytes.subarray(1_500)), stated(1_500, bytes.length - 1_500))).toEqual({ landed: true });
    expect(rig.rooms.at(-1)).toEqual({ kind: "new", more: bytes.length - 1_500 + bytes.length });
    expect(stagedWhole(rig, name).read()).toEqual(bytes);
    expect(existsSync(partsDir(rig, name))).toBe(false);
  });

  it("joins three parts and checks them, and a 0-byte put joins parts that hold every byte of a file whose join was cut", async () => {
    const rig = rigOf(form);
    const bytes = fileBytes("c", 3_000);
    const name = nameOf(bytes);
    writePart(rig, name, 0, bytes.subarray(0, 1_000));
    writePart(rig, name, 1_000, bytes.subarray(1_000, 2_000));
    expect(rig.files.held([name]).partly).toEqual({ [name]: 2_000 });
    expect(await rig.files.put(name, whole(bytes.subarray(2_000)), stated(2_000, 1_000))).toEqual({ landed: true });
    expect(stagedWhole(rig, name).read()).toEqual(bytes);

    const other = fileBytes("d", 2_000);
    const joined = nameOf(other);
    writePart(rig, joined, 0, other.subarray(0, 700));
    writePart(rig, joined, 700, other.subarray(700));
    expect(rig.files.held([joined])).toEqual({ staged: [], partly: { [joined]: 2_000 } });
    expect(await rig.files.put(joined, whole(), stated(2_000, 0))).toEqual({ landed: true });
    expect(rig.rooms.at(-1)).toEqual({ kind: "new", more: 2_000 });
    expect(rig.files.held([joined])).toEqual({ staged: [joined], partly: {} });
  });

  it("lands the empty file, and refuses bytes that are not their name with every part gone", async () => {
    const rig = rigOf(form);
    const empty = nameOf(Buffer.alloc(0));
    expect(await rig.files.put(empty, whole(), stated(0, 0))).toEqual({ landed: true });
    expect(rig.files.held([empty]).staged).toEqual([empty]);

    const bytes = fileBytes("e");
    const name = nameOf(bytes);
    const wrong = await refusal(rig.files.put(name, whole(fileBytes("f")), stated(0, bytes.length)));
    expect([wrong.status, wrong.code]).toEqual([422, "FILE_BAD"]);
    expect(existsSync(partsDir(rig, name))).toBe(false);
    writePart(rig, name, 0, bytes.subarray(0, 100));
    const joinedWrong = await refusal(rig.files.put(name, whole(fileBytes("f", bytes.length - 100)), stated(100, bytes.length - 100)));
    expect([joinedWrong.status, joinedWrong.code]).toEqual([422, "FILE_BAD"]);
    expect(existsSync(partsDir(rig, name))).toBe(false);
    expect(stagedWhole(rig, name).exists()).toBe(false);
    expect(rig.files.held([name, empty])).toEqual({ staged: [empty], partly: {} });
  });

  it("refuses an offset the door does not hold with the bytes it holds, reserving nothing and sparing nothing", async () => {
    const rig = rigOf(form);
    const bytes = fileBytes("g");
    const name = nameOf(bytes);
    writePart(rig, name, 0, bytes.subarray(0, 512));
    const refused = await refusal(rig.files.put(name, whole(bytes.subarray(100)), stated(100, bytes.length - 100)));
    expect([refused.status, refused.code, refused.extra]).toEqual([409, "UPLOAD_OFFSET", { held: 512 }]);
    expect(rig.rooms).toEqual([]);
    expect(rig.files.held([name]).partly).toEqual({ [name]: 512 });
  });

  it("drops a file whose parts leave a gap", async () => {
    const rig = rigOf(form);
    const bytes = fileBytes("h");
    const name = nameOf(bytes);
    writePart(rig, name, 0, bytes.subarray(0, 100));
    writePart(rig, name, 200, bytes.subarray(200, 300));
    expect(rig.files.held([name])).toEqual({ staged: [], partly: {} });
    expect(existsSync(partsDir(rig, name))).toBe(false);
  });

  it("ends a put still in its body when a newer one comes, and the newer finds its bytes", async () => {
    const rig = rigOf(form);
    const bytes = fileBytes("i");
    const name = nameOf(bytes);
    const older = body(bytes.subarray(0, 800));
    const first = rig.files.put(name, older.request, stated(0, bytes.length));
    await rig.arrived(older.request, 800);
    const again = await refusal(rig.files.put(name, whole(bytes), stated(0, bytes.length)));
    expect(await first).toEqual({ cut: { offset: 0, held: 800 } });
    expect(older.stream.destroyed).toBe(true);
    expect([again.code, again.extra]).toEqual(["UPLOAD_OFFSET", { held: 800 }]);
    const second = body(bytes.subarray(800, 1_000));
    const going = rig.files.put(name, second.request, stated(800, bytes.length - 800));
    await rig.arrived(second.request, 200);
    expect(await rig.files.put(name, whole(bytes.subarray(1_000)), stated(1_000, bytes.length - 1_000))).toEqual({ landed: true });
    expect(await going).toEqual({ cut: { offset: 800, held: 1_000 } });
    expect(stagedWhole(rig, name).read()).toEqual(bytes);
  });

  it("makes a put that comes during a join wait for it and answer held", async () => {
    const rig = rigOf(form);
    const bytes = fileBytes("j");
    const name = nameOf(bytes);
    writePart(rig, name, 0, bytes);
    const joining = rig.files.put(name, whole(), stated(bytes.length, 0));
    const waiting = rig.files.put(name, whole(bytes), stated(0, bytes.length));
    expect(await Promise.all([joining, waiting])).toEqual([{ landed: true }, { held: true }]);
  });

  it("lets a refusal inside the body through as no cut, the part gone", async () => {
    const rig = rigOf(form, 1_000);
    const bytes = fileBytes("k");
    const name = nameOf(bytes);
    rig.refuseRoom = (more) => more === 0;
    const sending = body(bytes.subarray(0, 500));
    const putting = refusal(rig.files.put(name, sending.request, stated(0, bytes.length)));
    await rig.arrived(sending.request, 500);
    sending.stream.end(bytes.subarray(500));
    const refused = await putting;
    expect(refused.code).toBe("DISK_LOW");
    expect(rig.files.held([name])).toEqual({ staged: [], partly: {} });
    expect(rig.admitted.size).toBe(0);
  });

  it("removes the part when its link meets the whole file there already", async () => {
    const rig = rigOf(form);
    const bytes = fileBytes("l");
    const name = nameOf(bytes);
    const late = body(bytes.subarray(0, 100));
    const putting = rig.files.put(name, late.request, stated(0, bytes.length));
    await rig.arrived(late.request, 100);
    stagedWhole(rig, name).write(bytes);
    late.stream.end(bytes.subarray(100));
    expect(await putting).toEqual({ landed: true });
    expect(existsSync(partsDir(rig, name))).toBe(false);
    expect(stagedWhole(rig, name).read()).toEqual(bytes);
  });

  it("sweeps at its start the parts of a name it holds whole, and on a keyed home no path names a file's hex", async () => {
    const rig = rigOf(form);
    const bytes = fileBytes("m");
    const name = nameOf(bytes);
    stagedWhole(rig, name).write(bytes);
    writePart(rig, name, 0, bytes.subarray(0, 10));
    const half = fileBytes("n");
    writePart(rig, nameOf(half), 0, half.subarray(0, 10));
    rig.reopen();
    expect(existsSync(partsDir(rig, name))).toBe(false);
    expect(rig.files.held([name, nameOf(half)])).toEqual({ staged: [name], partly: { [nameOf(half)]: 10 } });
    if (form === "keyed") {
      const paths = pathsUnder(join(rig.folder.root, "door", "files")).map((path) => relative(rig.folder.root, path));
      expect(paths.filter((path) => path.includes(name.slice(7)) || path.includes(nameOf(half).slice(7)))).toEqual([]);
    }
  });

  it("spares idle files oldest touched first, never a name receiving or joining", async () => {
    const rig = rigOf(form);
    const [old, young, sending] = [fileBytes("o", 1_000), fileBytes("p", 1_000), fileBytes("q", 1_000)];
    stagedWhole(rig, nameOf(old)).write(old);
    stagedWhole(rig, nameOf(old)).touch(NOW - 3_000);
    writePart(rig, nameOf(young), 0, young.subarray(0, 600));
    rig.folder.file(BLOB_FILE, join(partsDir(rig, nameOf(young)), "0")).touch(NOW - 1_000);
    writePart(rig, nameOf(sending), 0, sending.subarray(0, 300));
    rig.folder.file(BLOB_FILE, join(partsDir(rig, nameOf(sending)), "0")).touch(NOW - 9_000);
    const live = body(sending.subarray(300, 400));
    const putting = rig.files.put(nameOf(sending), live.request, stated(300, 700));
    await rig.arrived(live.request, 100);
    expect(rig.files.spare(500)).toBe(1_000);
    expect(rig.files.held([nameOf(old), nameOf(young), nameOf(sending)])).toEqual({ staged: [], partly: { [nameOf(young)]: 600, [nameOf(sending)]: 300 } });
    expect(rig.files.spare(10_000)).toBe(600);
    live.stream.end(sending.subarray(400));
    expect(await putting).toEqual({ landed: true });
  });

  it("sweeps a file idle 24 hours and one the store holds at once", async () => {
    const rig = rigOf(form);
    const [kept, held, idle, idlePart] = [fileBytes("r"), fileBytes("s"), fileBytes("t"), fileBytes("u")];
    for (const each of [kept, held, idle]) stagedWhole(rig, nameOf(each)).write(each);
    for (const each of [kept, held, idle]) stagedWhole(rig, nameOf(each)).touch(NOW);
    writePart(rig, nameOf(idlePart), 0, idlePart.subarray(0, 10));
    rig.folder.file(BLOB_FILE, join(partsDir(rig, nameOf(idlePart)), "0")).touch(NOW + 1);
    rig.stored.add(nameOf(held));
    rig.clock = NOW + IDLE_MS - 1;
    expect(rig.files.sweep({ has: (blob) => rig.stored.has(blob) })).toBe(1);
    expect(rig.files.held([nameOf(kept), nameOf(held), nameOf(idle), nameOf(idlePart)])).toEqual({ staged: [nameOf(kept), nameOf(idle)], partly: { [nameOf(idlePart)]: 10 } });
    stagedWhole(rig, nameOf(idle)).touch(NOW);
    stagedWhole(rig, nameOf(kept)).touch(NOW + 10);
    rig.clock = NOW + IDLE_MS + 1;
    expect(rig.files.sweep({ has: () => false })).toBe(2);
    expect(rig.files.held([nameOf(kept), nameOf(idle), nameOf(idlePart)])).toEqual({ staged: [nameOf(kept)], partly: {} });
  });

  it("carries a staged file into a lane by a link: sealed drops the stage's, undo the lane's", async () => {
    const rig = rigOf(form);
    const [one, two] = [fileBytes("v"), fileBytes("w")];
    for (const each of [one, two]) stagedWhole(rig, nameOf(each)).write(each);
    const lane = inboxLane(rig.folder, LANE);
    const absent = nameOf(Buffer.from("never staged"));
    const sealed = await rig.files.carry([nameOf(one), absent, nameOf(one)], lane);
    expect(sealed.carried).toEqual([nameOf(one)]);
    expect(lane.blob(nameOf(one)).read()).toEqual(one);
    sealed.sealed();
    expect(rig.files.held([nameOf(one)]).staged).toEqual([]);
    expect(lane.blob(nameOf(one)).read()).toEqual(one);
    const undone = await rig.files.carry([nameOf(two)], lane);
    undone.undo();
    expect(lane.has(nameOf(two).slice(7))).toBe("absent");
    expect(rig.files.held([nameOf(two)]).staged).toEqual([nameOf(two)]);
  });

  it("erases a staged file and its parts", () => {
    const rig = rigOf(form);
    const [staged, part] = [fileBytes("x"), fileBytes("y")];
    stagedWhole(rig, nameOf(staged)).write(staged);
    writePart(rig, nameOf(part), 0, part.subarray(0, 10));
    const erasing = openStagedFiles(rig.folder);
    expect(erasing.erase([nameOf(staged), nameOf(part), nameOf(Buffer.from("none"))])).toEqual([nameOf(staged), nameOf(part)]);
    expect(rig.files.held([nameOf(staged), nameOf(part)])).toEqual({ staged: [], partly: {} });
  });
});
