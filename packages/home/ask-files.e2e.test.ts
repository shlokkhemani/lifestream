import { createHash } from "node:crypto";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { ask as askConnector } from "@lifestreamprotocol/connect";
import { openHomeFolder, type BlobReader, type JsonObject } from "@lifestreamprotocol/core";
import { voiceItem } from "@lifestreamprotocol/families";
import { openLedger } from "@lifestreamprotocol/model";
import type { Pictures } from "@lifestreamprotocol/privacy";
import { IDLE_MS, openStage, PHOTO_BYTES, SECOND_BYTES, STAGE_BYTES, stageDirOf, stagedFile, stagedOrStored } from "./ask-files.js";
import { serveDoor, type DoorOptions, type Match } from "./door.js";
import { findingsDirOf } from "./engine-pictures.js";
import { startHome, type Home as RunningHome } from "./home.js";
import { machine } from "./machine.js";
import { MODELS_META } from "./models.js";
import { peopleFileOf } from "./people.js";
import { PEOPLE, writePrepared } from "./prepared.js";
import { Refusal } from "./refusal.js";
import { askHome, serveSocket } from "./socket.js";
import { requests } from "./test/erasures.js";
import { editSettings, TEST_UNIT, testSocket } from "./test/folder.js";
import { FAKE_ROUTE, LOOK_MS, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { acquisitionBundle, holdModels, LUNA_ROUTE, makeHome, makeHomeDb, NOW_MS, REPO, type Home } from "./test/support.js";
import { inboxLane, UPLOAD } from "./inbox.js";

const ASK = `ask:local:${TEST_UNIT}`;
const FLOORS = { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" };
const CHAT = "1788840000000-3fa9c2";
const OTHER = "1788840000000-b0b0b0";
const NOTE = "0123456789abcdef0123456789abcdef";
const RUNNER = "runner-macbook-pro-0001";
const report: Record<string, unknown> = {};
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  const directory = join(REPO, "packages", "home", ".build", "e2e");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "ask-files.json"), `${JSON.stringify(report, null, 2)}\n`);
});

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const jpeg = (words: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(words)]);
function exifJpeg(time: string, offset?: string, point?: readonly [number, number]): Buffer {
  const u16 = (value: number) => { const bytes = Buffer.alloc(2); bytes.writeUInt16BE(value); return bytes; };
  const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
  const text = (words: string) => Buffer.from(`${words}\0`, "latin1");
  const entry = (tag: number, type: number, count: number, value: Buffer) => Buffer.concat([u16(tag), u16(type), u32(count), value]);
  const ifd0At = 8;
  const exifAt = ifd0At + 2 + (point === undefined ? 1 : 2) * 12 + 4;
  const gpsAt = exifAt + 2 + (offset === undefined ? 1 : 2) * 12 + 4;
  let dataAt = gpsAt + (point === undefined ? 0 : 2 + 4 * 12 + 4);
  const data: Buffer[] = [];
  const put = (bytes: Buffer): number => { const at = dataAt; data.push(bytes); dataAt += bytes.length; return at; };
  const dms = (value: number) => Buffer.concat([u32(Math.floor(value)), u32(1), u32(Math.round((value % 1) * 60)), u32(1), u32(0), u32(1)]);
  const exif = [entry(0x9003, 2, time.length + 1, u32(put(text(time)))), ...offset === undefined ? [] : [entry(0x9011, 2, offset.length + 1, u32(put(text(offset))))]];
  const gps = point === undefined ? [] : [
    entry(0x0001, 2, 2, Buffer.from("N\0\0\0", "latin1")), entry(0x0002, 5, 3, u32(put(dms(point[0])))),
    entry(0x0003, 2, 2, Buffer.from("E\0\0\0", "latin1")), entry(0x0004, 5, 3, u32(put(dms(point[1])))),
  ];
  const ifd0 = [entry(0x8769, 4, 1, u32(exifAt)), ...point === undefined ? [] : [entry(0x8825, 4, 1, u32(gpsAt))]];
  const tiff = Buffer.concat([
    Buffer.from("MM\0*", "latin1"), u32(ifd0At), u16(ifd0.length), ...ifd0, u32(0), u16(exif.length), ...exif, u32(0),
    ...point === undefined ? [] : [u16(gps.length), ...gps, u32(0)], ...data,
  ]);
  const app1 = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), u16(app1.length + 2), app1, Buffer.from([0xff, 0xd9])]);
}
const pcm = (bytes: number, level = 1) => Buffer.alloc(bytes, level);
function wav(seconds: readonly Buffer[]): Buffer {
  const data = Buffer.concat(seconds);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(data.length + 36, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function refusal(run: () => unknown): Promise<[number, string] | "answered"> {
  try {
    await run();
    return "answered";
  } catch (error) {
    if (error instanceof Refusal) return [error.status, error.code];
    throw error;
  }
}

async function patched<K extends "rmSync" | "readdirSync" | "readFileSync" | "renameSync">(name: K, wrap: (real: (typeof fs)[K]) => (typeof fs)[K], run: () => unknown): Promise<void> {
  const real = fs[name];
  fs[name] = wrap(real);
  syncBuiltinESMExports();
  try {
    await run();
  } finally {
    fs[name] = real;
    syncBuiltinESMExports();
  }
}

function stagedBlobs(root: string): string[] {
  const dir = stageDirOf(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((shard) => /^[0-9a-f]{2}$/u.test(shard)).flatMap((shard) => readdirSync(join(dir, shard)).map((name) => `sha256:${name}`)).sort();
}

describe("the stage, in this process", () => {
  const stageAt = () => {
    const root = mkdtempSync(join(tmpdir(), "ask-files-"));
    roots.push(root);
    let now = NOW_MS;
    const stage = openStage(openHomeFolder(root), () => now);
    const put = async (bytes: Buffer): Promise<string> => {
      const path = join(root, `upload-${sha(bytes)}`);
      writeFileSync(path, bytes);
      await stage.adopt(openHomeFolder(root).file(UPLOAD, path), sha(bytes));
      return `sha256:${sha(bytes)}`;
    };
    return { root, stage, put, lane: inboxLane(openHomeFolder(root), ASK), at: (ms: number) => { now = ms; } };
  };

  it("S2, S8, S17: takes each photo kind by its first bytes and a second only of its shape; a note's middle second short is asked for again at its join, and written over", async () => {
    const heif = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic")]);
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 0, 0, 0]), Buffer.from("WEBP")]);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    expect([jpeg("a"), png, heif, webp, Buffer.from("a synthetic note"), Buffer.from("%PDF-1.7 synthetic")].map((head) => askConnector.isPhoto(head.subarray(0, 12))))
      .toEqual([true, true, true, true, false, false]);
    const { stage } = stageAt();
    expect(await refusal(() => stage.second(NOTE, 0, pcm(31_999)))).toEqual([422, "NOTE_BAD"]);
    expect(await refusal(() => stage.second(NOTE, 0, pcm(SECOND_BYTES + 2)))).toEqual([422, "NOTE_BAD"]);
    expect(await refusal(() => stage.second(NOTE, 600, pcm(2)))).toEqual([422, "NOTE_BAD"]);
    expect(await refusal(() => stage.second("not-a-note", 0, pcm(2)))).toEqual([422, "NOTE_BAD"]);
    expect(await stage.second(NOTE, 0, pcm(SECOND_BYTES))).toBe("kept");
    expect(await stage.second(NOTE, 0, pcm(SECOND_BYTES))).toBe("held");
    expect(await stage.second(NOTE, 1, pcm(1_000))).toBe("kept");
    expect(await stage.second(NOTE, 2, pcm(SECOND_BYTES))).toBe("kept");
    await expect(stage.join(NOTE, 3)).rejects.toThrow(expect.objectContaining({ status: 409, code: "FILES_MISSING", extra: { missing: { seconds: [1] } } }));
    expect(stage.closed(NOTE)).toBe(false);
    expect(await stage.second(NOTE, 1, pcm(SECOND_BYTES))).toBe("kept");
    expect((await stage.join(NOTE, 3)).ms).toBe(3_000);
    expect(await refusal(() => stage.join(NOTE, 601))).toEqual([422, "NOTE_BAD"]);
    expect(await refusal(() => stage.join(NOTE, 0))).toEqual([422, "NOTE_BAD"]);
  });

  it("S17: a second a power cut left empty or short is asked for again at the join, and the client's send of it writes it over", async () => {
    const { root, stage } = stageAt();
    for (let k = 0; k < 3; k++) await stage.second(NOTE, k, pcm(SECOND_BYTES, k + 1));
    truncateSync(join(stageDirOf(root), "notes", NOTE, "0"), 0);
    truncateSync(join(stageDirOf(root), "notes", NOTE, "2"), 1);
    await expect(stage.join(NOTE, 3)).rejects.toThrow(expect.objectContaining({ code: "FILES_MISSING", extra: { missing: { seconds: [0, 2] } } }));
    expect(await stage.second(NOTE, 0, pcm(SECOND_BYTES, 1))).toBe("kept");
    expect(await stage.second(NOTE, 2, pcm(SECOND_BYTES, 3))).toBe("kept");
    expect(await stage.second(NOTE, 2, pcm(SECOND_BYTES, 3))).toBe("held");
    expect((await stage.join(NOTE, 3)).audio).toBe(`sha256:${sha(wav([pcm(SECOND_BYTES, 1), pcm(SECOND_BYTES, 2), pcm(SECOND_BYTES, 3)]))}`);
  });

  it("S15: a note's join is named before its seconds go: a crash as they go leaves a join asked again the join", async () => {
    const { root, stage } = stageAt();
    const seconds = [pcm(SECOND_BYTES, 1), pcm(800, 2)];
    for (const [k, second] of seconds.entries()) await stage.second(NOTE, k, second);
    const folder = join(stageDirOf(root), "notes", NOTE);
    await patched("rmSync", (real) => ((path, options) => {
      real(path, options);
      if (path === folder) throw new Error("a crash as the seconds went");
    }) as typeof real, async () => {
      await expect(stage.join(NOTE, 2)).rejects.toThrow("a crash as the seconds went");
    });
    expect(existsSync(folder)).toBe(false);
    expect((await openStage(openHomeFolder(root)).join(NOTE, 2)).audio).toBe(`sha256:${sha(wav(seconds))}`);
  });

  it("S1, S8: a note's join is named by its bytes' hash and states its length; its seconds go, and a second after is refused; the same note joined again answers the same", async () => {
    const { root, stage } = stageAt();
    const seconds = [pcm(SECOND_BYTES, 1), pcm(SECOND_BYTES, 2), pcm(1_000, 3)];
    for (const [k, second] of seconds.entries()) await stage.second(NOTE, k, second);
    await expect(stage.join(NOTE, 5)).rejects.toThrow(expect.objectContaining({ code: "FILES_MISSING", extra: { missing: { seconds: [2, 3, 4] } } }));
    const joined = await stage.join(NOTE, 3);
    const bytes = wav(seconds);
    expect(joined).toEqual({ audio: `sha256:${sha(bytes)}`, ms: Math.ceil((32_500 * 1_000) / 16_000) });
    expect(stage.staged(joined.audio)!.bytes().equals(bytes)).toBe(true);
    expect(existsSync(join(stageDirOf(root), "notes", NOTE))).toBe(false);
    expect(await refusal(() => stage.second(NOTE, 3, pcm(2)))).toEqual([409, "NOTE_CLOSED"]);
    expect(await stage.join(NOTE, 3)).toEqual(joined);
    const other = "fedcba9876543210fedcba9876543210";
    await stage.second(other, 0, pcm(SECOND_BYTES));
    await stage.cancel(other);
    expect(existsSync(join(stageDirOf(root), "notes", other))).toBe(false);
    expect(await refusal(() => stage.second(other, 1, pcm(2)))).toEqual([409, "NOTE_CLOSED"]);
    expect(await refusal(() => stage.open(other))).toEqual([409, "NOTE_CLOSED"]);
    await expect(stage.join(other, 1)).rejects.toThrow(expect.objectContaining({ code: "FILES_MISSING", extra: { missing: { seconds: [0] } } }));
  });

  it("S7, S16: past 2 GB in all, an upload's room and a second are 507 STAGE_FULL; the room of uploads still landing counts until they end, however they end; room freed elsewhere is found", async () => {
    const { root, stage, put } = stageAt();
    await put(jpeg("a photo waiting"));
    const filler = join(stageDirOf(root), "ff", "f".repeat(64));
    mkdirSync(join(stageDirOf(root), "ff"), { recursive: true });
    writeFileSync(filler, "");
    truncateSync(filler, STAGE_BYTES - 2 * 1024 ** 2);
    expect(await refusal(() => stage.admit(1_000, () => undefined))).toBe("answered");
    let land!: () => void;
    const first = stage.admit(1.5 * 1024 ** 2, () => new Promise<void>((resolve) => { land = resolve; }));
    expect(await refusal(() => stage.admit(1.5 * 1024 ** 2, () => undefined))).toEqual([507, "STAGE_FULL"]);
    land();
    await first;
    stage.admit(1.5 * 1024 ** 2, () => undefined);
    await expect(stage.admit(1.5 * 1024 ** 2, async () => { throw new Error("a body cut short"); })).rejects.toThrow("a body cut short");
    expect(() => stage.admit(1.5 * 1024 ** 2, () => { throw new Error("a kind refused"); })).toThrow("a kind refused");
    stage.admit(1.5 * 1024 ** 2, () => undefined);
    let landed!: () => void;
    const landing = stage.admit(2 * 1024 ** 2 - 10_000, () => new Promise<void>((resolve) => { landed = resolve; }));
    expect(await refusal(() => stage.admit(20_000, () => undefined))).toEqual([507, "STAGE_FULL"]);
    expect(await refusal(() => stage.second(NOTE, 0, pcm(SECOND_BYTES)))).toEqual([507, "STAGE_FULL"]);
    rmSync(filler);
    expect(await stage.second(NOTE, 0, pcm(SECOND_BYTES))).toBe("kept");
    landed();
    await landing;
  });

  it("S7, S16: a note's join and a seal's copy of a stored file are past the bound like an upload: a near-full stage refuses them 507 STAGE_FULL, the note's seconds kept, and takes them once room is found", async () => {
    const { root, stage, lane } = stageAt();
    const filler = join(stageDirOf(root), "ff", "f".repeat(64));
    mkdirSync(join(stageDirOf(root), "ff"), { recursive: true });
    writeFileSync(filler, "");
    truncateSync(filler, STAGE_BYTES - SECOND_BYTES - 1_000);
    expect(await stage.second(NOTE, 0, pcm(SECOND_BYTES))).toBe("kept");
    expect(await refusal(() => stage.join(NOTE, 1))).toEqual([507, "STAGE_FULL"]);
    expect(stage.closed(NOTE)).toBe(false);
    expect(readdirSync(join(stageDirOf(root), "notes", NOTE))).toEqual(["0"]);
    const photo = jpeg("a stored photo sent again".padEnd(20_000, "."));
    const copy = join(root, "stored-copy");
    writeFileSync(copy, photo);
    const file = `sha256:${sha(photo)}`;
    const store = { has: (blob: string) => blob === file, materialise: async () => ({ path: copy, dispose: () => undefined }) };
    await expect(stage.carry([file], lane, store)).rejects.toMatchObject({ status: 507, code: "STAGE_FULL" });
    expect([stage.has(file), existsSync(lane.blob(sha(photo)).path)]).toEqual([false, false]);
    rmSync(filler);
    expect((await stage.join(NOTE, 1)).audio).toBe(`sha256:${sha(wav([pcm(SECOND_BYTES)]))}`);
    expect((await stage.carry([file], lane, store)).carried).toEqual([file]);
    expect(stage.has(file)).toBe(true);
  });

  it("R12: a second written over is admitted at its full size while the one it replaces stands: a near-full stage refuses it 507 STAGE_FULL, the short one kept, and counts only the net once it lands", async () => {
    const { root, stage } = stageAt();
    const filler = join(stageDirOf(root), "ff", "f".repeat(64));
    mkdirSync(join(stageDirOf(root), "ff"), { recursive: true });
    writeFileSync(filler, "");
    truncateSync(filler, STAGE_BYTES - 16_000 - 20_000);
    expect(await stage.second(NOTE, 0, pcm(16_000))).toBe("kept");
    expect(await refusal(() => stage.second(NOTE, 0, pcm(SECOND_BYTES)))).toEqual([507, "STAGE_FULL"]);
    expect(readdirSync(join(stageDirOf(root), "notes", NOTE))).toEqual(["0"]);
    expect(statSync(join(stageDirOf(root), "notes", NOTE, "0")).size).toBe(16_000);
    truncateSync(filler, STAGE_BYTES - 16_000 - SECOND_BYTES);
    expect(await stage.second(NOTE, 0, pcm(SECOND_BYTES))).toBe("kept");
    expect(await refusal(() => stage.admit(16_000, () => undefined))).toBe("answered");
    expect(await refusal(() => stage.admit(16_001, () => undefined))).toEqual([507, "STAGE_FULL"]);
  });

  it("R12: a second whose write fails leaves nothing in the stage and gives its room back: the next second takes it, the stage within its bound", async () => {
    const { root, stage } = stageAt();
    const filler = join(stageDirOf(root), "ff", "f".repeat(64));
    mkdirSync(join(stageDirOf(root), "ff"), { recursive: true });
    writeFileSync(filler, "");
    truncateSync(filler, STAGE_BYTES - SECOND_BYTES);
    await patched("renameSync", (real) => ((from: string, to: string) => {
      if (String(from).endsWith(".partial")) throw Object.assign(new Error("the disk failed the rename"), { code: "EIO" });
      return real(from, to);
    }) as typeof real, async () => {
      await expect(stage.second(NOTE, 0, pcm(SECOND_BYTES))).rejects.toThrow("the disk failed the rename");
    });
    expect(readdirSync(stageDirOf(root)).filter((name) => name.startsWith("."))).toEqual([]);
    expect(await refusal(() => stage.admit(SECOND_BYTES, () => undefined))).toBe("answered");
    expect(await stage.second(NOTE, 0, pcm(SECOND_BYTES))).toBe("kept");
    expect(await refusal(() => stage.admit(1, () => undefined))).toEqual([507, "STAGE_FULL"]);
  });

  it("S16: the stage counts its bytes once, not at every second; a note's words read and hash its file once", async () => {
    const { root, stage } = stageAt();
    const dir = stageDirOf(root);
    let walks = 0;
    await patched("readdirSync", (real) => ((path: string, ...rest: unknown[]) => {
      if (path === dir) walks++;
      return (real as (...args: unknown[]) => unknown)(path, ...rest);
    }) as unknown as typeof real, async () => {
      for (let k = 0; k < 20; k++) await stage.second(NOTE, k, pcm(SECOND_BYTES));
    });
    expect(walks).toBe(1);
    const { audio } = await stage.join(NOTE, 20);
    const store: BlobReader = {
      has: () => false, bytes: () => { throw new Error("the store holds none"); }, text: () => "", prefix: () => Buffer.alloc(0),
      materialise: () => Promise.reject(new Error("the store holds none")),
    };
    let reads = 0;
    await patched("readFileSync", (real) => ((path: string, ...rest: unknown[]) => {
      if (typeof path === "string" && path === stagedFile(openHomeFolder(root), audio).path) reads++;
      return (real as (...args: unknown[]) => unknown)(path, ...rest);
    }) as unknown as typeof real, () => {
      const blobs = stagedOrStored(store, openStage(openHomeFolder(root)));
      expect(blobs.has(audio)).toBe(true);
      expect(blobs.bytes(audio).length).toBe(44 + 20 * SECOND_BYTES);
      expect(blobs.bytes(audio).length).toBe(44 + 20 * SECOND_BYTES);
    });
    expect(reads).toBe(1);
  });

  it("S4: the sweep keeps a file an Ask lane holds, whatever the store holds; it takes one the store holds, one unused for 24 hours, a note's seconds a day after the last, and a sealed file once its lane copy goes", async () => {
    const { root, stage, put, lane, at } = stageAt();
    const sealed = await put(jpeg("sealed"));
    const idle = await put(jpeg("never sealed"));
    const stored = await put(jpeg("stored by the home"));
    await stage.second(NOTE, 0, pcm(SECOND_BYTES));
    expect((await stage.carry([sealed], lane, { has: () => false, materialise: () => Promise.reject(new Error("the store holds none")) })).carried).toEqual([sealed]);
    expect(stage.laned(sealed)).toBe(true);
    const store = { has: (blob: string) => blob === stored || blob === sealed };
    expect(stage.sweep(store)).toEqual([stored]);
    at(NOW_MS + IDLE_MS - 1);
    expect(stage.sweep(store)).toEqual([]);
    at(NOW_MS + IDLE_MS);
    expect(stage.sweep(store)).toEqual([idle]);
    expect(stagedBlobs(root)).toEqual([sealed]);
    expect(existsSync(join(stageDirOf(root), "notes", NOTE))).toBe(false);
    at(NOW_MS + 7 * IDLE_MS);
    expect(stage.sweep(store)).toEqual([]);
    rmSync(lane.blob(sealed.slice(7)).path);
    expect(stage.laned(sealed)).toBe(false);
    expect(stage.sweep(store)).toEqual([sealed]);
    expect(stagedBlobs(root)).toEqual([]);
  });

  it("S10: an erasure marks its conversations and removes the stage's copies no Ask lane holds; it pins nothing", async () => {
    const { root, stage, put, lane } = stageAt();
    const shared = await put(jpeg("the same bytes on two devices"));
    const own = await put(jpeg("only the erased conversation's"));
    await stage.second(NOTE, 0, pcm(4_000));
    const { audio } = await stage.join(NOTE, 1);
    await stage.carry([shared], lane, { has: () => false, materialise: () => Promise.reject(new Error("the store holds none")) });
    const erasure = openStage(openHomeFolder(root));
    erasure.erasing([CHAT]);
    expect([stage.erased(CHAT), stage.erased(OTHER)]).toEqual([true, false]);
    const erased = erasure.erase([shared, own, audio]);
    expect(erased.removed.sort()).toEqual([own, audio].sort());
    expect(erased.folders.sort()).toEqual([own, audio].map((blob) => join(stageDirOf(root), blob.slice(7, 9))).sort());
    expect(stagedBlobs(root)).toEqual([shared]);
    rmSync(lane.blob(shared.slice(7)).path);
    expect(openStage(openHomeFolder(root)).erase([shared]).removed).toEqual([shared]);
    expect(stagedBlobs(root)).toEqual([]);
  });

  it("S5, S13: a seal links each file into its lane from the stage, a file only the store holds kept in the stage first; one neither holds is missing; its undo removes only the links it made", async () => {
    const { root, stage, put, lane } = stageAt();
    const staged = await put(jpeg("a staged photo"));
    const photo = jpeg("a photo the store holds");
    const file = `sha256:${sha(photo)}`;
    const copy = join(root, "a stored copy");
    writeFileSync(copy, photo);
    const store = { has: (blob: string) => blob === file, materialise: async () => ({ path: copy, dispose: () => undefined }) };
    const stray = `sha256:${sha("a photo the home never saw")}`;
    const first = await stage.carry([staged, file, stray, staged], lane, store);
    expect([first.carried, first.missing]).toEqual([[staged, file], [stray]]);
    expect(stagedBlobs(root)).toEqual([staged, file].sort());
    expect(readFileSync(lane.blob(sha(photo)).path).equals(photo)).toBe(true);
    expect(statSync(lane.blob(sha(photo)).path).ino).toBe(statSync(stagedFile(openHomeFolder(root), file).path).ino);
    first.undo();
    expect([existsSync(lane.blob(staged.slice(7)).path), existsSync(lane.blob(sha(photo)).path)]).toEqual([false, false]);
    expect((await stage.carry([staged], lane, store)).carried).toEqual([staged]);
    const again = await stage.carry([staged], lane, store);
    again.undo();
    expect(existsSync(lane.blob(staged.slice(7)).path)).toBe(true);
  });
});

async function doorOf(more: DoorOptions = {}, voice: { readonly runner: string | null; readonly words?: () => Promise<JsonObject> } = { runner: null }) {
  const at: Home = makeHome({
    reader: { scopes: ["read"] }, ask: { scopes: ["deliver"], sources: [ASK], unit: "ask" },
    runner: { scopes: ["run"], kind: "runner", unit: RUNNER }, call: { scopes: ["call"], unit: "home" }, admit: { scopes: ["admit"] },
  }, roots);
  const db = makeHomeDb(join(at.root, "home.db"));
  holdModels(db, [LUNA_ROUTE]);
  db.close();
  mkdirSync(join(machine().dir, "ask"), { recursive: true });
  writeFileSync(join(machine().dir, "ask", "door-token"), `${at.tokens.ask}\n`);
  const heard: JsonObject[] = [];
  const home = await serveSocket(testSocket(at.root).path, async (request) => {
    heard.push(request);
    if (request.verb === "chat-voice" && typeof request.words === "string") return await voice.words?.() ?? { words: "a synthetic note's words" };
    if (request.verb === "chat-voice" && typeof request.open === "string") return { runner: voice.runner };
    return {};
  });
  onTestFinished(() => home.close());
  let now = NOW_MS;
  let sweep: () => Promise<void> = async () => undefined;
  const logs: string[] = [];
  const door = await serveDoor(at.root, { port: 0, max_bundle_bytes: 1 << 30 }, { lookMs: LOOK_MS,
    log: (line) => logs.push(line), clock: () => now, floors: FLOORS,
    beats: { stage: (tick) => { sweep = tick; return () => undefined; } }, ...more,
  });
  onTestFinished(() => door.close());
  const url = `http://127.0.0.1:${door.port}`;
  const as = (who: string) => ({ authorization: `Bearer ${at.tokens[who]}` });
  const call = async (method: string, path: string, who: string, body?: unknown, type = "application/json") => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { ...as(who), ...(body === undefined ? {} : { "content-type": type }) },
      ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const chatVoice = () => heard.filter((request) => request.verb === "chat-voice").map(({ verb: _verb, ...rest }) => rest);
  return { at, url, logs, heard, chatVoice, call, as, sweep: () => sweep(), at_ms: (ms: number) => { now = ms; } };
}

function hidingReady(root: string): void {
  mkdirSync(join(root, "replies"), { recursive: true });
  openLedger(openHomeFolder(root), { mode: "migrate" }).close();
  editSettings(root, { "model.defaults.hiding": null });
  writePrepared(openHomeFolder(root), peopleFileOf(root, machine().dir), PEOPLE, { rows: new Map([["names", new Map([["table", {
    owner: { who: "p-owner", shown: "Owner Example" },
    people: [{ who: "p-owner", is: "human", shown: "Owner Example", names: ["Owner Example"], accounts: [] }],
  } as unknown as JsonObject]])]]), position: "p1" });
}

function playedPictures() {
  const cannot = new Set<string>();
  const crashOnce = new Set<string>();
  const reads: string[] = [];
  const pictures: Pictures = {
    async read(blob) {
      reads.push(blob);
      if (cannot.has(blob)) return { cannot: "This picture cannot be hidden: not an image the engine decodes." };
      if (crashOnce.delete(blob)) throw new Error("the face engine crashed");
      return { lines: [], faces: [] };
    },
    async make(draft) {
      return { jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), recipe: { blob: draft.blob, filled: [], covered: [], written: [], engine: "played 1" } };
    },
  };
  return { pictures, cannot, crashOnce, reads };
}

function stated(url: string, path: string, headers: Record<string, string>, length: number, sent: Buffer): { answer: Promise<{ status: number; body: JsonObject } | "cut">; end(): void } {
  const request = httpRequest(`${url}${path}`, { method: "POST", headers: { ...headers, "content-length": String(length) } });
  const answer = new Promise<{ status: number; body: JsonObject } | "cut">((resolve) => {
    request.on("response", (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as JsonObject }));
      response.on("error", () => resolve("cut"));
    });
    request.on("error", () => resolve("cut"));
  });
  request.write(sent);
  return { answer, end: () => request.destroy() };
}

function turn(made_ms: number, lines: unknown[]): { path: string; bytes: Buffer; id: string } {
  const text = Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  return acquisitionBundle({
    source: ASK, feeder: "owner-statements", fetched_ms: made_ms, files: [["statements.ndjson", text]],
    manifest: (manifest) => ({ ...manifest, facts: { statements: lines.length, blobs_carried: 0 } }),
  });
}
const shell = (chat: string, at_ms: number) => ({ kind: "chat", key: chat, content: { type: "ask.chat", title: "Synthetic", at_ms } });
const question = (chat: string, n: number, at_ms: number, more: JsonObject) => ({
  kind: "msg", key: `${chat}:${String(n).padStart(4, "0")}`, content: { type: "ask.msg", chat, n, at_ms, role: "user", text: "Where was this?", ...more },
});
async function sealed(url: string, token: string, audio: string): Promise<void> {
  const sent = turn(NOW_MS, [shell(CHAT, NOW_MS), question(CHAT, 1, NOW_MS, { text: "", voice: { audio, ms: 125 } })]);
  const response = await fetch(`${url}${sent.path}`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: sent.bytes });
  expect(response.status, await response.text()).toBe(201);
}

describe("the stage through the door", () => {
  it("S1, S2, S3, S7, S9: a photo staged under its stream's hash and read, a cut body leaving nothing, each refused shape refused, an undecodable photo let go, a crashed read answered read: false and read again; a client's route on the Ask server's pass refused", async () => {
    const played = playedPictures();
    const placed: string[] = [];
    const match: Match = async (path) => {
      placed.push(sha(readFileSync(path)));
      return { width: 640, height: 480, faces: [{ box: { x: 1, y: 2, width: 30, height: 40 }, who: "person:person-a" }] };
    };
    const { at, url, call, logs, as } = await doorOf({ hiding: { pictures: played.pictures, match } });
    hidingReady(at.root);
    const answers: Record<string, unknown> = {};
    const photo = jpeg("a synthetic photo");
    const file = `sha256:${sha(photo)}`;
    const staged = await call("POST", "/v1/ask/files", "reader", photo, "image/jpeg");
    answers.staged = staged;
    expect(staged).toEqual({ status: 200, body: { file, kind: "photo", width: 640, height: 480 } });
    expect(stagedBlobs(at.root)).toEqual([file]);
    expect(readFileSync(join(stageDirOf(at.root), sha(photo).slice(0, 2), sha(photo))).equals(photo)).toBe(true);
    expect(placed).toEqual([sha(photo)]);
    const kept = JSON.parse(readFileSync(join(findingsDirOf(openHomeFolder(at.root), machine().dir).dir, sha(photo).slice(0, 2), `${sha(photo)}.match.json`), "utf8")) as JsonObject;
    expect(kept).toEqual({ faces: [{ box: [1, 2, 31, 42], who: "person:person-a" }] });
    expect(await call("POST", "/v1/ask/files", "reader", photo, "image/jpeg")).toEqual(staged);

    const damaged = jpeg("a damaged synthetic photo");
    played.cannot.add(`sha256:${sha(damaged)}`);
    expect(await call("POST", "/v1/ask/files", "reader", damaged, "image/jpeg")).toMatchObject({ status: 422, body: { code: "PICTURE_UNREADABLE", message: "Lifestream can't read this picture." } });
    expect(stagedBlobs(at.root)).toEqual([file]);
    expect(placed).toContain(sha(damaged));
    expect(existsSync(join(findingsDirOf(openHomeFolder(at.root), machine().dir).dir, sha(damaged).slice(0, 2), `${sha(damaged)}.match.json`))).toBe(false);
    const crashed = jpeg("a synthetic photo whose read crashes");
    played.crashOnce.add(`sha256:${sha(crashed)}`);
    const unread = await call("POST", "/v1/ask/files", "reader", crashed, "image/jpeg");
    answers.unread = unread;
    expect(unread).toMatchObject({ status: 200, body: { file: `sha256:${sha(crashed)}`, kind: "photo", read: false } });
    expect(stagedBlobs(at.root)).toContain(`sha256:${sha(crashed)}`);
    expect(logs.some((line) => line.includes("a photo's read failed"))).toBe(true);
    expect(await call("POST", "/v1/hide-details", "reader", { table: "chat:c1", to: "codex:gpt-6-luna", what: "text", epoch: 0, texts: [{ picture: `sha256:${sha(crashed)}`, tags: true }] }))
      .toMatchObject({ status: 200 });
    expect(played.reads.filter((blob) => blob === `sha256:${sha(crashed)}`).length).toBe(2);

    expect(await call("POST", "/v1/ask/files", "reader", Buffer.from("a synthetic note, no photo"), "text/plain")).toMatchObject({ status: 415, body: { code: "FILE_KIND" } });
    const large = stated(url, "/v1/ask/files", { authorization: `Bearer ${at.tokens.reader}` }, PHOTO_BYTES + 1, Buffer.alloc(0));
    expect(await large.answer).toMatchObject({ status: 413, body: { code: "FILE_TOO_LARGE" } });
    large.end();
    const uploads = join(at.root, "door", "uploads");
    const cut = stated(url, "/v1/ask/files", { authorization: `Bearer ${at.tokens.reader}` }, 100_000, jpeg("the start of a photo"));
    await until("the cut photo's body landing", () => readdirSync(uploads).length > 0);
    cut.end();
    expect(await cut.answer).toBe("cut");
    await until("the cut photo's partial gone", () => readdirSync(uploads).length === 0);
    expect(stagedBlobs(at.root)).toEqual([file, `sha256:${sha(crashed)}`].sort());

    expect((await call("POST", "/v1/ask/files", "ask", photo, "image/jpeg")).status).toBe(403);
    expect(await call("POST", `/v1/ask/notes/${NOTE}/join`, "reader", { seconds: 1 })).toMatchObject({ status: 403, body: { code: "PRINCIPAL_SCOPE" } });
    expect((await call("POST", "/v1/ask/claims", "ask", { turn: `${CHAT}:1`, photos: [file] })).status).toBe(404);

    const blob = async (headers: Record<string, string>, name = file) => {
      const response = await fetch(`${url}/v1/blobs/${name}`, { headers });
      return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
    };
    const whole = await blob(as("reader"));
    expect([whole.status, whole.bytes.equals(photo)]).toEqual([200, true]);
    const part = await blob({ ...as("reader"), range: "bytes=1-3" });
    expect([part.status, part.bytes.equals(photo.subarray(1, 4))]).toEqual([206, true]);
    expect((await blob(as("reader"), `sha256:${sha(damaged)}`)).status).toBe(404);
    const { mintPrincipal } = await import("./principals.js");
    const agentToken = "synthetic-token-agent".padEnd(43, "x");
    mintPrincipal(openHomeFolder(at.root), {
      unit: "agent-a", kind: "agent", scopes: ["read"], token: agentToken, now_ms: NOW_MS,
      granted: { agent: { name: "Agent A", via: "pass", from: null, checked: false, client_id: null, resource: null } },
    });
    expect((await blob({ authorization: `Bearer ${agentToken}`, "lifestream-server": at.tokens.admit! })).status).toBe(403);
    answers.served = { whole: whole.status, part: part.status };
    report.files = answers;
  });

  it("S4, S5, S8: a note's seconds joined and a photo sealed with both linked into the lane, kept past a day while the lane holds them; a file neither staged nor held refused 409 FILES_MISSING; the home told of each note", async () => {
    const played = playedPictures();
    const { at, url, call, chatVoice, sweep, at_ms } = await doorOf({ hiding: { pictures: played.pictures, match: async () => null } });
    const answers: Record<string, unknown> = {};
    const photo = jpeg("a synthetic photo to send");
    const file = `sha256:${sha(photo)}`;
    expect((await call("POST", "/v1/ask/files", "reader", photo, "image/jpeg")).status).toBe(200);
    const seconds = [pcm(SECOND_BYTES, 4), pcm(4_000, 5)];
    expect(await call("POST", `/v1/ask/notes/${NOTE}`, "reader")).toEqual({ status: 200, body: { note: NOTE } });
    expect(await call("PUT", `/v1/ask/notes/${NOTE}/0`, "reader", seconds[0], "application/octet-stream")).toEqual({ status: 200, body: { note: NOTE, second: 0, held: false } });
    expect(await call("PUT", `/v1/ask/notes/${NOTE}/0`, "reader", seconds[0], "application/octet-stream")).toEqual({ status: 200, body: { note: NOTE, second: 0, held: true } });
    expect((await call("PUT", `/v1/ask/notes/${NOTE}/1`, "reader", pcm(3), "application/octet-stream")).body.code).toBe("NOTE_BAD");
    expect((await call("PUT", `/v1/ask/notes/${NOTE}/600`, "reader", pcm(2), "application/octet-stream")).body.code).toBe("NOTE_BAD");
    await until("the home told of the open and each second", () => chatVoice().length === 3);
    expect(chatVoice()).toEqual([{ open: NOTE, folder: at.root }, { open: NOTE, folder: at.root }, { open: NOTE, folder: at.root }]);

    const joinOf = (body: unknown, who = "ask") => call("POST", `/v1/ask/notes/${NOTE}/join`, who, body);
    const missing = await joinOf({ seconds: 2 });
    answers.missing = missing;
    expect(missing).toMatchObject({ status: 409, body: { code: "FILES_MISSING", missing: { seconds: [1] } } });
    for (const body of [{ seconds: 601 }, { seconds: 0 }, { seconds: 2, turn: `${CHAT}:1` }, {}]) expect((await joinOf(body)).body.code).toBe("NOTE_BAD");
    expect((await call("PUT", `/v1/ask/notes/${NOTE}/1`, "reader", seconds[1], "application/octet-stream")).status).toBe(200);
    const audio = `sha256:${sha(wav(seconds))}`;
    const joined = await joinOf({ seconds: 2 });
    answers.joined = joined;
    expect(joined).toEqual({ status: 200, body: { audio, ms: 1_125 } });
    expect(await joinOf({ seconds: 2 })).toEqual(joined);
    expect((await call("PUT", `/v1/ask/notes/${NOTE}/2`, "reader", pcm(2), "application/octet-stream")).body.code).toBe("NOTE_CLOSED");

    const stray = `sha256:${sha("a photo the home never saw")}`;
    const strayAudio = `sha256:${sha("a note the home never joined")}`;
    const put = async (sent: ReturnType<typeof turn>) => {
      const response = await fetch(`${url}${sent.path}`, { method: "PUT", headers: { authorization: `Bearer ${at.tokens.ask}` }, body: sent.bytes });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const strayAnswer = await put(turn(NOW_MS, [shell(CHAT, NOW_MS), question(CHAT, 7, NOW_MS, { text: "", photos: [file, stray], voice: { audio: strayAudio, ms: 1_000 } })]));
    answers.stray = strayAnswer;
    expect(strayAnswer).toMatchObject({ status: 409, body: { code: "FILES_MISSING", missing: { photos: [stray], audio: [strayAudio] } } });
    expect(existsSync(join(at.root, "inbox", ASK))).toBe(false);
    expect(await call("POST", "/v1/ask/words", "reader", { audio })).toMatchObject({ status: 409, body: { code: "CHAT_ERASED" } });

    const sent = turn(NOW_MS, [shell(CHAT, NOW_MS), question(CHAT, 1, NOW_MS, { text: "", photos: [file], voice: { audio, ms: 1_125 } })]);
    const sealed = await put(sent);
    answers.sealed = sealed.status;
    expect(sealed.status).toBe(201);
    const delivery = join(at.root, "inbox", ...sent.id.split("/"));
    const manifest = JSON.parse(readFileSync(join(delivery, "manifest.json"), "utf8")) as { facts: JsonObject };
    expect(manifest.facts).toMatchObject({ statements: 2, blobs_carried: 2 });
    const lane = join(at.root, "inbox", ASK, "blobs");
    expect(readdirSync(lane).sort()).toEqual([file, audio].map((blob) => blob.slice(7)).sort());
    expect(await call("POST", "/v1/ask/words", "ask", { audio, note: NOTE })).toEqual({ status: 200, body: { words: "a synthetic note's words" } });

    at_ms(NOW_MS + 2 * IDLE_MS);
    await sweep();
    expect(stagedBlobs(at.root)).toEqual([file, audio].sort());
    const store = openHomeFolder(at.root).blobs(join(at.root, "blobs"));
    store.put(photo);
    store.put(wav(seconds));
    await sweep();
    expect(stagedBlobs(at.root)).toEqual([file, audio].sort());
    for (const name of readdirSync(lane)) rmSync(join(lane, name));
    await sweep();
    expect(stagedBlobs(at.root)).toEqual([]);

    const other = "fedcba9876543210fedcba9876543210";
    expect((await call("PUT", `/v1/ask/notes/${other}/0`, "reader", pcm(SECOND_BYTES), "application/octet-stream")).status).toBe(200);
    expect(await call("DELETE", `/v1/ask/notes/${other}`, "reader")).toEqual({ status: 200, body: { note: other } });
    expect(existsSync(join(stageDirOf(at.root), "notes", other))).toBe(false);
    expect((await call("PUT", `/v1/ask/notes/${other}/1`, "reader", pcm(2), "application/octet-stream")).body.code).toBe("NOTE_CLOSED");
    await until("the home told of the cancel", () => chatVoice().some((request) => request.cancel === other));
    report.seal = answers;
  });

  it("the model's picture is staged by the Ask server alone under its own hash, never read nor face-matched; the same again answers the same; a hash unlike its bytes keeps nothing", async () => {
    const played = playedPictures();
    const matched: string[] = [];
    const { at, call } = await doorOf({ hiding: { pictures: played.pictures, match: async (path) => { matched.push(path); return null; } } });
    const picture = jpeg("the synthetic picture the model got");
    const file = `sha256:${sha(picture)}`;
    expect((await call("PUT", `/v1/ask/files/${file}`, "reader", picture, "image/jpeg")).body.code).toBe("PRINCIPAL_SCOPE");
    expect(stagedBlobs(at.root)).toEqual([]);
    const other = `sha256:${sha(jpeg("other bytes"))}`;
    expect(await call("PUT", `/v1/ask/files/${other}`, "ask", picture, "image/jpeg")).toMatchObject({ status: 422, body: { code: "FILE_BAD" } });
    expect((await call("PUT", `/v1/ask/files/${file.slice(7)}`, "ask", picture, "image/jpeg")).body.code).toBe("FILE_BAD");
    expect((await call("PUT", `/v1/ask/files/${file}`, "ask", Buffer.from("no photo at all"), "image/jpeg")).body.code).toBe("FILE_KIND");
    expect(stagedBlobs(at.root)).toEqual([]);
    expect(await call("PUT", `/v1/ask/files/${file}`, "ask", picture, "image/jpeg")).toEqual({ status: 200, body: { file } });
    expect(await call("PUT", `/v1/ask/files/${file}`, "ask", picture, "image/jpeg")).toEqual({ status: 200, body: { file } });
    expect(stagedBlobs(at.root)).toEqual([file]);
    expect([played.reads, matched]).toEqual([[], []]);
  });

  it("a staged file is dropped by the Ask server alone, by its name, and never once a sealed statement names it", async () => {
    const { url, at, call } = await doorOf({ hiding: { pictures: playedPictures().pictures, match: async () => null } });
    const loose = jpeg("a synthetic picture nobody will name");
    const file = `sha256:${sha(loose)}`;
    expect((await call("PUT", `/v1/ask/files/${file}`, "ask", loose, "image/jpeg")).status).toBe(200);
    expect((await call("DELETE", `/v1/ask/files/${file}`, "reader")).body.code).toBe("PRINCIPAL_SCOPE");
    expect((await call("DELETE", `/v1/ask/files/${file.slice(7)}`, "ask")).body.code).toBe("FILE_BAD");
    expect(await call("DELETE", `/v1/ask/files/${file}`, "ask")).toEqual({ status: 200, body: { dropped: true } });
    expect(await call("DELETE", `/v1/ask/files/${file}`, "ask")).toEqual({ status: 200, body: { dropped: false } });
    expect(stagedBlobs(at.root)).toEqual([]);
    const photo = jpeg("a synthetic photo a question names");
    const named = `sha256:${sha(photo)}`;
    expect((await call("PUT", `/v1/ask/files/${named}`, "ask", photo, "image/jpeg")).status).toBe(200);
    const sent = turn(NOW_MS, [shell(CHAT, NOW_MS), question(CHAT, 1, NOW_MS, { photos: [named] })]);
    const response = await fetch(`${url}${sent.path}`, { method: "PUT", headers: { authorization: `Bearer ${at.tokens.ask}` }, body: sent.bytes });
    expect(response.status, await response.text()).toBe(201);
    expect(await call("DELETE", `/v1/ask/files/${named}`, "ask")).toEqual({ status: 200, body: { dropped: false } });
    expect(stagedBlobs(at.root)).toEqual([named]);
  });

  it("S11: a photo's facts state when and where its EXIF says it was taken: the instant its offset states, else its wall clock in the home's zone; one stating no time, none; of any photo staged or stored, asked by the Ask server alone", async () => {
    const { at, call } = await doorOf({ hiding: { pictures: playedPictures().pictures, match: async () => null } });
    const stamped = exifJpeg("2026:10:23 09:59:07", "+05:30", [10.5, 20.25]);
    const local = exifJpeg("2026:10:23 09:59:07");
    const plain = jpeg("a synthetic photo with no EXIF");
    for (const photo of [stamped, local, plain]) expect((await call("POST", "/v1/ask/files", "reader", photo, "image/jpeg")).status).toBe(200);
    const files = [stamped, local, plain].map((photo) => `sha256:${sha(photo)}`);
    const own = await call("POST", "/v1/ask/taken", "ask", { photos: files });
    report.taken = own;
    expect(own).toEqual({ status: 200, body: { photos: [
      { file: files[0], taken: { ms: Date.UTC(2026, 9, 23, 4, 29, 7), offset_min: 330, at: [10.5, 20.25] } },
      { file: files[1], taken: { ms: Date.UTC(2026, 9, 23, 9, 59, 7) } },
      { file: files[2] },
    ] } });
    const stored = exifJpeg("2026:10:22 18:00:00", "-04:00", [40.25, 3.5]);
    const kept = openHomeFolder(at.root).blobs(join(at.root, "blobs")).put(stored);
    const unheld = `sha256:${sha(jpeg("a synthetic photo nobody sent"))}`;
    const taken = await call("POST", "/v1/ask/taken", "ask", { photos: [files[1], kept, unheld, files[0], files[2]] });
    report.facts = taken;
    expect(taken).toEqual({ status: 200, body: { photos: [
      own.body.photos[1], { file: kept, taken: { ms: Date.UTC(2026, 9, 22, 22, 0, 0), offset_min: -240, at: [40.25, 3.5] } }, { file: unheld },
      own.body.photos[0], own.body.photos[2],
    ] } });
    expect((await call("POST", "/v1/ask/taken", "reader", { photos: [kept] })).body.code).toBe("PRINCIPAL_SCOPE");
    expect((await call("GET", "/v1/connectors", "ask")).body.code).not.toBe("PRINCIPAL_SCOPE");
    expect((await call("GET", "/v1/connectors?unit=macbook-pro-0001", "ask")).body.code).toBe("PRINCIPAL_SCOPE");
    expect((await call("GET", "/v1/status", "ask")).body.code).toBe("PRINCIPAL_SCOPE");
    for (const photos of [kept, [kept.slice(7)], Array.from({ length: 1_001 }, () => kept)]) expect((await call("POST", "/v1/ask/taken", "ask", { photos })).body.code).toBe("TAKEN_BAD");
  });

  it("S12: a note's runner is reserved from the home's answer to its open until its words or its cancel: a background call waits for both of two notes, then is handed", async () => {
    const { at, url, call, logs } = await doorOf({ hiding: { pictures: playedPictures().pictures, match: async () => null } }, { runner: RUNNER });
    const auth = (who: string) => ({ authorization: `Bearer ${at.tokens[who]}` });
    const stated = { name: "Synthetic Mac", version: "1", boot: "boot-a", slots: 1, power: "mains", idle_s: 300, thermal: "nominal", memory_gb: 32, running: [], files: [{
      id: "synthetic-model", name: "synthetic-model", input: ["text", "image"], output: "text", tools: false, context_tokens: 4_000, thinking: [], bytes: 1_000, languages: [], memory_gb: 16, state: "ready", fetched_bytes: 1_000, failure: null,
    }] };
    const exchange = async (results: unknown[] = []) => {
      const response = await fetch(`${url}/v1/runners/exchange`, { method: "POST", headers: { ...auth("runner"), "lifestream-device": "runner/1" }, body: JSON.stringify({ runner: stated, results }) });
      return await response.json() as { calls: { id: string; input: string }[] };
    };
    expect((await exchange()).calls).toEqual([]);
    const holds = (note: string) => logs.some((line) => line.includes("a voice note holds a runner") && line.includes(note));
    const other = "fedcba9876543210fedcba9876543210";
    expect((await call("POST", `/v1/ask/notes/${NOTE}`, "reader")).status).toBe(200);
    await until("the first note's runner reserved", () => holds(NOTE));
    expect((await call("PUT", `/v1/ask/notes/${other}/0`, "reader", pcm(SECOND_BYTES), "application/octet-stream")).status).toBe(200);
    await until("the second note's runner reserved", () => holds(other));
    const background = fetch(`${url}/v1/runners/calls`, { method: "POST", headers: auth("call"), body: JSON.stringify({ runner: RUNNER, model: "synthetic-model", input: "batch", attachments: [] }) }).then((response) => response.text());
    let handed: { calls: { id: string; input: string }[] } | undefined;
    const held = exchange().then((answer) => { handed = answer; return answer; });
    const photo = jpeg("a synthetic photo, the stage's");
    expect((await call("POST", "/v1/ask/files", "reader", photo, "image/jpeg")).status).toBe(200);
    expect(await call("POST", "/v1/ask/words", "reader", { audio: `sha256:${sha(photo)}` })).toMatchObject({ status: 409, body: { code: "CHAT_ERASED" } });
    expect((await call("PUT", `/v1/ask/notes/${NOTE}/0`, "reader", pcm(4_000), "application/octet-stream")).status).toBe(200);
    const audio = (await call("POST", `/v1/ask/notes/${NOTE}/join`, "ask", { seconds: 1 })).body.audio as string;
    await sealed(url, at.tokens.ask!, audio);
    expect(await call("POST", "/v1/ask/words", "reader", { audio, note: NOTE })).toEqual({ status: 200, body: { words: "a synthetic note's words" } });
    expect(handed).toBeUndefined();
    expect((await call("DELETE", `/v1/ask/notes/${other}`, "reader")).status).toBe(200);
    const answer = await held;
    expect(answer.calls.map((each) => each.input)).toEqual(["batch"]);
    void exchange([{ id: answer.calls[0]!.id, ok: { text: "synthetic answer", model: "synthetic-model" } }]).catch(() => undefined);
    expect(await background).toContain("synthetic answer");
  });

  it("S12: a note's runner stays its own while its words are asked, and is let go once the home has answered them", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const { at, url, call, heard, logs } = await doorOf({ hiding: { pictures: playedPictures().pictures, match: async () => null } }, {
      runner: RUNNER, words: async () => { await gate; return { words: "a synthetic note's words" }; },
    });
    const auth = (who: string) => ({ authorization: `Bearer ${at.tokens[who]}` });
    const stated = { name: "Synthetic Mac", version: "1", boot: "boot-a", slots: 1, power: "mains", idle_s: 300, thermal: "nominal", memory_gb: 32, running: [], files: [{
      id: "synthetic-model", name: "synthetic-model", input: ["text", "image"], output: "text", tools: false, context_tokens: 4_000, thinking: [], bytes: 1_000, languages: [], memory_gb: 16, state: "ready", fetched_bytes: 1_000, failure: null,
    }] };
    const exchange = async (results: unknown[] = []) => {
      const response = await fetch(`${url}/v1/runners/exchange`, { method: "POST", headers: { ...auth("runner"), "lifestream-device": "runner/1" }, body: JSON.stringify({ runner: stated, results }) });
      return await response.json() as { calls: { id: string; input: string }[] };
    };
    expect((await exchange()).calls).toEqual([]);
    expect((await call("PUT", `/v1/ask/notes/${NOTE}/0`, "reader", pcm(4_000), "application/octet-stream")).status).toBe(200);
    await until("the note's runner reserved", () => logs.some((line) => line.includes("a voice note holds a runner")));
    const audio = (await call("POST", `/v1/ask/notes/${NOTE}/join`, "ask", { seconds: 1 })).body.audio as string;
    await sealed(url, at.tokens.ask!, audio);
    const background = fetch(`${url}/v1/runners/calls`, { method: "POST", headers: auth("call"), body: JSON.stringify({ runner: RUNNER, model: "synthetic-model", input: "batch", attachments: [] }) }).then((response) => response.text());
    let handed: { calls: { id: string; input: string }[] } | undefined;
    const held = exchange().then((answer) => { handed = answer; return answer; });
    const words = call("POST", "/v1/ask/words", "reader", { audio, note: NOTE });
    await until("the home asked the note's words", () => heard.some((request) => request.verb === "chat-voice" && request.words === audio));
    expect((await call("GET", `/v1/ask/erased?chat=${CHAT}`, "ask")).status).toBe(200);
    expect(handed).toBeUndefined();
    open();
    expect(await words).toEqual({ status: 200, body: { words: "a synthetic note's words" } });
    const answer = await held;
    expect(answer.calls.map((each) => each.input)).toEqual(["batch"]);
    void exchange([{ id: answer.calls[0]!.id, ok: { text: "synthetic answer", model: "synthetic-model" } }]).catch(() => undefined);
    expect(await background).toContain("synthetic answer");
  });

  it("S16: uploads side by side cannot pass the stage's bound together: the room of one still landing refuses the next, and is let go with it", async () => {
    const { at, url, call, sweep } = await doorOf({ hiding: { pictures: playedPictures().pictures, match: async () => null } });
    const size = 1024 ** 2;
    const filler = join(stageDirOf(at.root), "ff", "f".repeat(64));
    mkdirSync(join(stageDirOf(at.root), "ff"), { recursive: true });
    writeFileSync(filler, "");
    truncateSync(filler, STAGE_BYTES - 1.5 * size);
    await sweep();
    const uploads = join(at.root, "door", "uploads");
    const auth = { authorization: `Bearer ${at.tokens.reader}` };
    const first = stated(url, "/v1/ask/files", auth, size, jpeg("the start of the first photo"));
    await until("the first photo's body landing", () => existsSync(uploads) && readdirSync(uploads).length > 0);
    const second = stated(url, "/v1/ask/files", auth, size, jpeg("the start of the second photo"));
    expect(await second.answer).toMatchObject({ status: 507, body: { code: "STAGE_FULL" } });
    second.end();
    first.end();
    expect(await first.answer).toBe("cut");
    await until("the first photo's partial gone", () => readdirSync(uploads).length === 0);
    const photo = Buffer.concat([jpeg("a whole photo"), Buffer.alloc(size - jpeg("a whole photo").length, 1)]);
    expect((await call("POST", "/v1/ask/files", "reader", photo, "image/jpeg")).status).toBe(200);
  });

  it("S19: the photos picked together start at most two face-engine runs at once, the rest in line, each answered", async () => {
    let running = 0;
    let most = 0;
    const waiting: (() => void)[] = [];
    const run = async () => {
      running++;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => waiting.push(resolve));
      running--;
    };
    const read = new Set<string>();
    const pictures: Pictures = {
      async read(blob) {
        if (!read.has(blob)) {
          read.add(blob);
          await run();
        }
        return { lines: [], faces: [] };
      },
      async make() { throw new Error("nothing is made in this test"); },
    };
    const { call } = await doorOf({ hiding: { pictures, match: async () => { await run(); return null; } } });
    const photos = Array.from({ length: 5 }, (_, n) => jpeg(`a synthetic photo picked with four others, ${n}`));
    const answers = Promise.all(photos.map((photo) => call("POST", "/v1/ask/files", "reader", photo, "image/jpeg")));
    for (let n = 1; n <= 10; n++) {
      await until(`engine run ${n} started`, () => waiting.length > 0);
      waiting.shift()!();
    }
    expect((await answers).map((answer) => answer.status)).toEqual([200, 200, 200, 200, 200]);
    expect(most).toBeLessThanOrEqual(2);
    report.pick = { most };
  });

  it("S6: a sealed photo is read and made by a hide before its import, from the stage", async () => {
    const engineDir = mkdtempSync(join(tmpdir(), "ask-files-engine-"));
    roots.push(engineDir);
    writeFileSync(join(engineDir, "engine.json"), JSON.stringify({}));
    const program = join(engineDir, "face-engine");
    writeFileSync(program, `#!/bin/sh\nFAKE_ENGINE_DIR='${engineDir}' exec '${process.execPath}' '${join(REPO, "packages", "connect", "labelers", "faces", "test", "fake-engine.mjs")}' "$@"\n`);
    chmodSync(program, 0o755);
    const { at, url, call } = await doorOf({ hiding: { engine: program, match: async () => null } });
    hidingReady(at.root);
    const photo = jpeg("a synthetic photo sent to Chat");
    const file = `sha256:${sha(photo)}`;
    expect((await call("POST", "/v1/ask/files", "reader", photo, "image/jpeg")).status).toBe(200);
    const sent = turn(NOW_MS, [shell(CHAT, NOW_MS), question(CHAT, 1, NOW_MS, { photos: [file] })]);
    const response = await fetch(`${url}${sent.path}`, { method: "PUT", headers: { authorization: `Bearer ${at.tokens.ask}` }, body: sent.bytes });
    expect(response.status).toBe(201);
    expect(openHomeFolder(at.root).blobs(join(at.root, "blobs"), { reading: true }).has(file)).toBe(false);
    const hidden = await call("POST", "/v1/hide-details", "reader", { table: "chat:c1", to: "codex:gpt-6-luna", what: "text", epoch: 0, texts: [{ picture: file, tags: true }] });
    expect(hidden.status, JSON.stringify(hidden.body)).toBe(200);
    expect(Buffer.from(hidden.body.texts[0].jpeg, "base64").toString("latin1")).toContain(`made ${sha(photo)}`);
  });
});

async function erasureHome(options: { fake?: string; engine?: string; ahead?: () => number } = {}) {
  const root = makeRoot("lifestream-ask-erase-", { sources: {}, ...(options.fake === undefined ? {} : { defaults: false, fake: { leaves: "the test cloud", reply: options.fake, delay_ms: 0 } }) });
  onTestFinished(() => removeRoot(root));
  if (options.fake !== undefined) editSettings(root, { "privacy.level": "all", "connectors.ask": { "llm.voice": FAKE_ROUTE } });
  const registry = new URL("./test/ask-registry.ts", import.meta.url);
  let sweep: () => Promise<void> = async () => undefined;
  const door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { lookMs: LOOK_MS,
    log: () => undefined, registry, floors: FLOORS,
    hiding: options.engine === undefined ? { pictures: playedPictures().pictures, match: async () => null } : { engine: options.engine, match: async () => null },
    beats: { stage: (tick) => { sweep = tick; return () => undefined; } }, ...(options.ahead === undefined ? {} : { clock: () => Date.now() + options.ahead!() }),
  });
  onTestFinished(() => door.close());
  editSettings(root, { "door.port": door.port });
  const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry, log: () => undefined });
  onTestFinished(() => home.stop());
  await until("the home read its routes", () => readHome(root, (db) => String(db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(MODELS_META) ?? "")).includes(`"id":"${FAKE_ROUTE}"`));
  const url = `http://127.0.0.1:${door.port}`;
  const sock = testSocket(root);
  const askToken = readFileSync(join(machine().dir, "ask", "door-token"), "utf8").trim();
  const reader = "synthetic-token-reader".padEnd(43, "r");
  const { mintPrincipal } = await import("./principals.js");
  mintPrincipal(openHomeFolder(root), { unit: "reader", scopes: ["read"], sources: [], token: reader, now_ms: 0 });
  const call = async (method: string, path: string, token: string, body?: unknown, type = "application/json") => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": type }) },
      ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const put = async (sent: ReturnType<typeof turn>) => {
    const response = await fetch(`${url}${sent.path}`, { method: "PUT", headers: { authorization: `Bearer ${askToken}` }, body: sent.bytes });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const laneHolds = (blob: string) => existsSync(join(root, "inbox", ASK, "blobs", blob.slice("sha256:".length)));
  const inboxSwept = async (...blobs: string[]) => {
    await askHome(sock, "sweep");
    await until("the inbox sweep took the lane's copies", () => blobs.every((blob) => !laneHolds(blob)));
  };
  return {
    root, url, sock, askToken, reader, call, put, laneHolds, inboxSwept, sweep: () => sweep(),
    heads: () => readHome(root, (db) => db.prepare("SELECT key FROM heads WHERE source = ? ORDER BY key").pluck().all(ASK) as string[]),
    store: () => openHomeFolder(root).blobs(join(root, "blobs"), { reading: true }),
  };
}
const asked = (chat: string, n: number) => `${chat}:${String(n).padStart(4, "0")}`;

describe("an erasure reaches Chat's stage", () => {
  it("S10: a question erased within the day leaves nothing staged, in its lane or the store; a pending question of its conversation is refused, its words too; another conversation's question on the same bytes seals", async () => {
    const { root, call, put, heads, store, laneHolds, askToken, reader, sock } = await erasureHome();
    const at_ms = Date.now();
    const first = jpeg("the first question's synthetic photo");
    const firstFile = `sha256:${sha(first)}`;
    expect((await call("POST", "/v1/ask/files", reader, first, "image/jpeg")).status).toBe(200);
    expect((await put(turn(at_ms, [shell(CHAT, at_ms), question(CHAT, 1, at_ms, { photos: [firstFile] })]))).status).toBe(201);
    await until("the question imported", () => heads().includes(asked(CHAT, 1)));

    const shared = jpeg("a synthetic photo two devices send");
    const sharedFile = `sha256:${sha(shared)}`;
    expect((await call("POST", "/v1/ask/files", reader, shared, "image/jpeg")).status).toBe(200);
    expect((await call("PUT", `/v1/ask/notes/${NOTE}/0`, reader, pcm(2_000), "application/octet-stream")).status).toBe(200);
    const pending = await call("POST", `/v1/ask/notes/${NOTE}/join`, askToken, { seconds: 1 });
    expect(pending.status).toBe(200);

    const erasedOf = (token: string, query: string) => call("GET", `/v1/ask/erased?${query}`, token);
    expect((await erasedOf(askToken, `chat=${CHAT}&chat=${OTHER}`)).body).toEqual({ erased: [] });
    await askHome(sock, "erase", ["ai", asked(CHAT, 1), "--apply"]);
    expect(heads()).not.toContain(asked(CHAT, 1));
    expect(await erasedOf(askToken, `chat=${OTHER}&chat=${CHAT}&chat=${CHAT}`)).toEqual({ status: 200, body: { erased: [CHAT] } });
    expect((await erasedOf(reader, `chat=${CHAT}`)).body.code).toBe("PRINCIPAL_SCOPE");
    for (const query of ["", "chat=not-a-chat", Array.from({ length: 101 }, () => `chat=${CHAT}`).join("&")]) expect((await erasedOf(askToken, query)).body.code).toBe("ERASED_BAD");
    expect(stagedBlobs(root)).toEqual([sharedFile, pending.body.audio].sort());
    expect([store().has(firstFile), laneHolds(firstFile)]).toEqual([false, false]);

    const lane = () => existsSync(join(root, "inbox", ASK)) ? readdirSync(join(root, "inbox", ASK)).filter((name) => name !== "blobs").length : 0;
    const before = lane();
    expect((await put(turn(at_ms + 60_000, [shell(CHAT, at_ms), question(CHAT, 3, at_ms + 30_000, { text: "", photos: [sharedFile], voice: { audio: pending.body.audio, ms: pending.body.ms } })]))).body.code).toBe("CHAT_ERASED");
    expect(lane()).toBe(before);
    expect(await call("POST", "/v1/ask/words", reader, { audio: pending.body.audio })).toMatchObject({ status: 409, body: { code: "CHAT_ERASED" } });

    const other = turn(at_ms + 90_000, [shell(OTHER, at_ms), question(OTHER, 1, at_ms, { photos: [sharedFile] })]);
    expect((await put(other)).status).toBe(201);
    const manifest = JSON.parse(readFileSync(join(root, "inbox", ...other.id.split("/"), "manifest.json"), "utf8")) as { facts: JsonObject };
    expect(manifest.facts.blobs_carried).toBe(1);
    await until("the other question imported", () => heads().includes(asked(OTHER, 1)));
  });

  it("S20: one message of a Chat conversation erased erases the conversation whole: its own record and every question and answer go, another conversation's stay", async () => {
    const { put, heads, sock } = await erasureHome();
    const at_ms = Date.now();
    const answer = (chat: string, n: number, at: number) => ({ kind: "msg", key: asked(chat, n), content: { type: "ask.msg", chat, n, at_ms: at, role: "assistant", text: "A synthetic answer.", end: "done" } });
    for (const chat of [CHAT, OTHER]) {
      expect((await put(turn(at_ms, [shell(chat, at_ms + 3), question(chat, 1, at_ms, {}), answer(chat, 2, at_ms + 1), question(chat, 3, at_ms + 2, {}), answer(chat, 4, at_ms + 3)]))).status).toBe(201);
    }
    const all = [OTHER, ...[1, 2, 3, 4].map((n) => asked(OTHER, n)), CHAT, ...[1, 2, 3, 4].map((n) => asked(CHAT, n))];
    await until("both conversations imported", () => all.every((key) => heads().includes(key)));
    await askHome(sock, "erase", ["ai", asked(CHAT, 3), "--apply"]);
    expect(heads()).toEqual([OTHER, ...[1, 2, 3, 4].map((n) => asked(OTHER, n))].sort());
  });

  it("S13, S14: a photo the erasure takes is the seal's to ask for again; the erasure forgets a sealed note's ask and its words, and a question sealed before it lands erased, its files gone", async () => {
    const { root, call, put, heads, store, laneHolds, inboxSwept, sweep, askToken, reader, sock } = await erasureHome({ fake: "Synthetic lighthouse note" });
    const at_ms = Date.now();
    const answers: Record<string, unknown> = {};
    const first = jpeg("a synthetic photo sent once and again");
    const firstFile = `sha256:${sha(first)}`;
    expect((await call("POST", "/v1/ask/files", reader, first, "image/jpeg")).status).toBe(200);
    expect((await put(turn(at_ms, [shell(CHAT, at_ms), question(CHAT, 1, at_ms, { photos: [firstFile] })]))).status).toBe(201);
    await until("the question imported", () => heads().includes(asked(CHAT, 1)));
    await inboxSwept(firstFile);
    await sweep();
    expect(stagedBlobs(root)).toEqual([]);
    expect((await call("POST", "/v1/ask/files", reader, first, "image/jpeg")).status).toBe(200);
    expect(stagedBlobs(root)).toEqual([firstFile]);

    await askHome(sock, "pause", ["kind:import", "--reason", "a test holds the imports"]);
    expect((await call("PUT", `/v1/ask/notes/${NOTE}/0`, reader, pcm(2_000), "application/octet-stream")).status).toBe(200);
    const joined = await call("POST", `/v1/ask/notes/${NOTE}/join`, askToken, { seconds: 1 });
    const audio = joined.body.audio as string;
    expect((await put(turn(at_ms + 10_000, [shell(CHAT, at_ms), question(CHAT, 3, at_ms + 5_000, { text: "", voice: { audio, ms: joined.body.ms } })]))).status).toBe(201);
    answers.words = await call("POST", "/v1/ask/words", reader, { audio, note: NOTE });
    expect(answers.words).toEqual({ status: 200, body: { words: "Synthetic lighthouse note" } });
    expect(requests(root, voiceItem(audio))).toBe(1);
    const late = jpeg("a synthetic photo sealed before the erasure");
    const lateFile = `sha256:${sha(late)}`;
    expect((await call("POST", "/v1/ask/files", reader, late, "image/jpeg")).status).toBe(200);
    const sealed = turn(at_ms + 30_000, [shell(CHAT, at_ms), question(CHAT, 4, at_ms + 20_000, { photos: [lateFile] })]);
    expect((await put(sealed)).status).toBe(201);
    expect(laneHolds(lateFile)).toBe(true);

    answers.erased = await askHome(sock, "erase", ["ai", asked(CHAT, 1), "--apply"]);
    expect(store().has(firstFile)).toBe(false);
    expect(stagedBlobs(root)).toEqual([]);
    expect(requests(root, voiceItem(audio))).toBe(0);
    expect([laneHolds(lateFile), laneHolds(audio)]).toEqual([false, false]);
    expect(await call("POST", "/v1/ask/words", reader, { audio })).toMatchObject({ status: 409, body: { code: "CHAT_ERASED" } });

    const other = turn(at_ms + 60_000, [shell(OTHER, at_ms), question(OTHER, 1, at_ms, { photos: [firstFile] })]);
    answers.missing = await put(other);
    expect(answers.missing).toMatchObject({ status: 409, body: { code: "FILES_MISSING", missing: { photos: [firstFile] } } });
    expect((await call("POST", "/v1/ask/files", reader, first, "image/jpeg")).status).toBe(200);
    const otherSealed = await put(other);
    answers.other = otherSealed;
    expect(otherSealed.status).toBe(201);
    expect((JSON.parse(readFileSync(join(root, "inbox", ...other.id.split("/"), "manifest.json"), "utf8")) as { facts: JsonObject }).facts.blobs_carried).toBe(1);

    await askHome(sock, "resume", ["kind:import"]);
    const state = (id: string) => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id) as string | undefined);
    await until("the sealed question's delivery imported", () => state(sealed.id) === "imported");
    await until("the other question imported", () => heads().includes(asked(OTHER, 1)));
    expect(heads()).not.toContain(asked(CHAT, 4));
    expect(store().has(lateFile)).toBe(false);
    expect(store().has(firstFile)).toBe(true);
    report.erasure = answers;
  });

  it("S13: a question of another conversation sealed before the erasure, the stored photo kept in the stage by its seal, keeps it through a sweep and the erasure: a hide reads it, it imports with it, and the sweep takes the stage's once the inbox's is swept", async () => {
    const engineDir = mkdtempSync(join(tmpdir(), "ask-files-engine-"));
    roots.push(engineDir);
    writeFileSync(join(engineDir, "engine.json"), JSON.stringify({}));
    const program = join(engineDir, "face-engine");
    writeFileSync(program, `#!/bin/sh\nFAKE_ENGINE_DIR='${engineDir}' exec '${process.execPath}' '${join(REPO, "packages", "connect", "labelers", "faces", "test", "fake-engine.mjs")}' "$@"\n`);
    chmodSync(program, 0o755);
    const { root, call, put, heads, store, laneHolds, inboxSwept, sweep, reader, sock } = await erasureHome({ engine: program });
    hidingReady(root);
    const at_ms = Date.now();
    const photo = jpeg("a synthetic photo two conversations send");
    const file = `sha256:${sha(photo)}`;
    expect((await call("POST", "/v1/ask/files", reader, photo, "image/jpeg")).status).toBe(200);
    expect((await put(turn(at_ms, [shell(CHAT, at_ms), question(CHAT, 1, at_ms, { photos: [file] })]))).status).toBe(201);
    await until("the first question imported", () => heads().includes(asked(CHAT, 1)));
    await inboxSwept(file);
    await sweep();
    expect(stagedBlobs(root)).toEqual([]);

    await askHome(sock, "pause", ["kind:import", "--reason", "a test holds the imports"]);
    const other = turn(at_ms + 30_000, [shell(OTHER, at_ms), question(OTHER, 1, at_ms, { photos: [file] })]);
    expect((await put(other)).status).toBe(201);
    expect(laneHolds(file)).toBe(true);
    expect(stagedBlobs(root)).toEqual([file]);
    await sweep();
    expect(stagedBlobs(root)).toEqual([file]);

    await askHome(sock, "erase", ["ai", asked(CHAT, 1), "--apply"]);
    expect(heads()).not.toContain(asked(CHAT, 1));
    expect(store().has(file)).toBe(false);
    expect(laneHolds(file)).toBe(true);
    expect(stagedBlobs(root)).toEqual([file]);
    await sweep();
    expect(stagedBlobs(root)).toEqual([file]);

    hidingReady(root);
    const hide = (epoch: number) => call("POST", "/v1/hide-details", reader, { table: "chat:c1", to: FAKE_ROUTE, what: "text", epoch, texts: [{ picture: file, tags: true }] });
    const moved = await hide(0);
    expect(moved).toMatchObject({ status: 409, body: { code: "ERASED" } });
    const hidden = await hide(moved.body.epoch as number);
    expect(hidden.status, JSON.stringify(hidden.body)).toBe(200);
    expect(Buffer.from(hidden.body.texts[0].jpeg, "base64").toString("latin1")).toContain(`made ${sha(photo)}`);

    await askHome(sock, "resume", ["kind:import"]);
    await until("the other question imported", () => heads().includes(asked(OTHER, 1)));
    expect(store().has(file)).toBe(true);
    expect(sha(store().bytes(file))).toBe(sha(photo));
    await sweep();
    expect(stagedBlobs(root)).toEqual([file]);
    await inboxSwept(file);
    await sweep();
    expect(stagedBlobs(root)).toEqual([]);
  });

  it("S13: a question of another conversation sealed and unread across an inbox sweep keeps its lane's copy through the erasure of the record that stored its photo, and imports with it", async () => {
    const { root, call, put, heads, store, laneHolds, inboxSwept, sweep, reader, sock } = await erasureHome();
    const at_ms = Date.now();
    const photo = jpeg("a synthetic photo sent in two conversations");
    const file = `sha256:${sha(photo)}`;
    expect((await call("POST", "/v1/ask/files", reader, photo, "image/jpeg")).status).toBe(200);
    expect((await put(turn(at_ms, [shell(CHAT, at_ms), question(CHAT, 1, at_ms, { photos: [file] })]))).status).toBe(201);
    await until("the first question imported", () => heads().includes(asked(CHAT, 1)));
    await inboxSwept(file);
    await sweep();

    await askHome(sock, "pause", ["kind:import", "--reason", "a test holds the imports"]);
    const other = turn(at_ms + 30_000, [shell(OTHER, at_ms), question(OTHER, 1, at_ms, { photos: [file] })]);
    expect((await put(other)).status).toBe(201);
    expect(laneHolds(file)).toBe(true);
    const sweeps = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM events WHERE kind = 'sweep'").pluck().get()) as number;
    const before = sweeps();
    await askHome(sock, "sweep");
    await until("an inbox sweep with the question unread", () => sweeps() > before);
    expect(laneHolds(file)).toBe(true);
    await sweep();

    await askHome(sock, "erase", ["ai", asked(CHAT, 1), "--apply"]);
    expect(heads()).not.toContain(asked(CHAT, 1));
    expect(store().has(file)).toBe(false);
    expect(laneHolds(file)).toBe(true);

    await askHome(sock, "resume", ["kind:import"]);
    await until("the other question imported", () => heads().includes(asked(OTHER, 1)));
    expect(sha(store().bytes(file))).toBe(sha(photo));
  });

  it("R1: an erased question's photo and note leave no copy anywhere: the store's, the lane's and the stage's go, the note's ask too, and a question that names them after is 409 FILES_MISSING", async () => {
    let ahead = 0;
    const { root, call, put, heads, store, laneHolds, inboxSwept, sweep, askToken, reader, sock } = await erasureHome({ fake: "Synthetic harbour note", ahead: () => ahead });
    const at_ms = Date.now();
    const photo = jpeg("a synthetic photo two conversations share");
    const file = `sha256:${sha(photo)}`;
    expect((await call("POST", "/v1/ask/files", reader, photo, "image/jpeg")).status).toBe(200);
    expect((await call("PUT", `/v1/ask/notes/${NOTE}/0`, reader, pcm(2_000), "application/octet-stream")).status).toBe(200);
    const first = await call("POST", `/v1/ask/notes/${NOTE}/join`, askToken, { seconds: 1 });
    expect(first.status).toBe(200);
    const audio = first.body.audio as string;
    expect((await put(turn(at_ms, [shell(CHAT, at_ms), question(CHAT, 1, at_ms, { text: "", photos: [file], voice: { audio, ms: first.body.ms } })]))).status).toBe(201);
    expect(await call("POST", "/v1/ask/words", reader, { audio, note: NOTE })).toEqual({ status: 200, body: { words: "Synthetic harbour note" } });
    expect(requests(root, voiceItem(audio))).toBe(1);
    await until("the first question imported", () => heads().includes(asked(CHAT, 1)));
    await inboxSwept(file, audio);
    await sweep();
    expect(stagedBlobs(root)).toEqual([]);

    await askHome(sock, "erase", ["ai", asked(CHAT, 1), "--apply"]);
    expect(heads()).not.toContain(asked(CHAT, 1));
    expect([store().has(file), store().has(audio), laneHolds(file), laneHolds(audio)]).toEqual([false, false, false, false]);
    expect(requests(root, voiceItem(audio))).toBe(0);
    const other = turn(at_ms + 60_000, [shell(OTHER, at_ms), question(OTHER, 1, at_ms, { text: "", photos: [file], voice: { audio, ms: first.body.ms } })]);
    expect(await put(other)).toMatchObject({ status: 409, body: { code: "FILES_MISSING", missing: { photos: [file], audio: [audio] } } });
    ahead = IDLE_MS;
    await sweep();
    expect(stagedBlobs(root)).toEqual([]);
    expect([store().has(file), store().has(audio), laneHolds(file), laneHolds(audio)]).toEqual([false, false, false, false]);
  });
});
