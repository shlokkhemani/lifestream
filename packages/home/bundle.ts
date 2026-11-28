import type { BlobReader, HomeFolder, JsonObject, KeptFile } from "@lifestreamprotocol/core";
import { BUNDLE_ENTRIES, CodedRefused, openZip, Refused, type Zip, type ZipEntry, type ZipSource } from "@lifestreamprotocol/connect";
import { basicInstant, InboxError, inboxLane, MANIFEST_FILE, openSealing, parseManifest, statedMs, type DoorStamp, type Lane, type Manifest } from "./inbox.js";
import { missingFiles } from "./ask-files.js";
import { refuse } from "./refusal.js";
import type { Carried, StagedFiles } from "./staged-files.js";


export interface AcquisitionBundle {
  readonly id: string;
  readonly manifest: Manifest;
  readonly files: ReadonlyMap<string, ZipEntry>;
  readonly blobs: ReadonlyMap<string, ZipEntry>;
  close(): void;
}

const BLOB_MEMBER = /^blobs\/([0-9a-f]{64})$/u;
const MANIFEST_LIMIT = 16 * 1024 * 1024;

export const BUNDLE_FILES = "The home lacks files this bundle names: send them, then the bundle again.";

export interface StagedDoor {
  readonly home: Pick<BlobReader, "has">;
  readonly files: Pick<StagedFiles, "carry">;
}

function badManifest(message: string): never {
  return refuse(422, "ACQUISITION_MANIFEST", message);
}

function unreadable(error: unknown): never {
  if (error instanceof Refused) badManifest(error instanceof CodedRefused && error.code === "ZIP" ? `not a readable bundle: ${error.message}` : error.message);
  if (error instanceof InboxError) badManifest(error.message);
  throw error;
}

export function zipSourceOf(file: KeptFile): ZipSource {
  const opened = file.opened() ?? (() => { throw Object.assign(new Error(`${file.path} is gone`), { code: "ENOENT" }); })();
  return { size: opened.size, read: (into, at) => opened.read(into, at), reading: (range) => file.reading(range), close: () => opened.close() };
}

export function openAcquisitionBundle(file: KeptFile): AcquisitionBundle {
  let zip: Zip;
  try {
    zip = openZip(file.path, undefined, zipSourceOf(file));
  } catch (error) {
    unreadable(error);
  }
  try {
    if (zip.count > BUNDLE_ENTRIES) badManifest(`the bundle lists ${zip.count} members; a bundle holds at most ${BUNDLE_ENTRIES}`);
    const members = new Map<string, ZipEntry>();
    for (const entry of zip.entries()) {
      if (members.has(entry.name)) badManifest(`member ${JSON.stringify(entry.name)} is repeated`);
      members.set(entry.name, entry);
    }
    const member = members.get(MANIFEST_FILE) ?? badManifest(`the bundle has no ${MANIFEST_FILE}`);
    let manifest: Manifest;
    try {
      manifest = parseManifest(member.bytes(MANIFEST_LIMIT).toString("utf8"), MANIFEST_FILE);
      statedMs(manifest);
    } catch (error) {
      unreadable(error);
    }
    if (!manifest.complete) badManifest("a bundle is sealed; complete must be true");
    const files = new Map<string, ZipEntry>();
    for (const entry of manifest.files) {
      if (entry.file.startsWith("blobs/")) badManifest(`${JSON.stringify(entry.file)} is under blobs/; blobs are carried, never listed`);
      const found = members.get(entry.file) ?? badManifest(`listed file ${JSON.stringify(entry.file)} is not a member`);
      if (found.size !== entry.bytes) badManifest(`${JSON.stringify(entry.file)} has ${found.size} bytes, the manifest states ${entry.bytes}`);
      files.set(entry.file, found);
    }
    const blobs = new Map<string, ZipEntry>();
    for (const [name, entry] of members) {
      if (name === MANIFEST_FILE || files.has(name)) continue;
      const blob = BLOB_MEMBER.exec(name) ?? badManifest(`member ${JSON.stringify(name)} is neither listed nor a blob`);
      blobs.set(blob[1]!, entry);
    }
    const staged = manifest.staged_blobs ?? [];
    const both = staged.find((hash) => blobs.has(hash.slice("sha256:".length)));
    if (both !== undefined) badManifest(`${both} is both a member under blobs/ and a staged blob`);
    if (manifest.facts.blobs_carried !== blobs.size + staged.length)
      badManifest(`facts.blobs_carried states ${JSON.stringify(manifest.facts.blobs_carried)}, the bundle carries ${blobs.size} and stages ${staged.length}`);
    return { id: `${manifest.source_id}/${basicInstant(manifest.fetched_at)}`, manifest, files, blobs, close: () => zip.close() };
  } catch (error) {
    zip.close();
    unreadable(error);
  }
}

export async function sealAcquisitionBundle(folder: HomeFolder, bundle: AcquisitionBundle, stamp: DoorStamp, sealed: { name: string; facts: JsonObject }, door: StagedDoor): Promise<Manifest> {
  const { manifest } = bundle;
  const sealing = openSealing(folder, { source: manifest.source_id, name: sealed.name, feeder: manifest.feeder, fetched_at: manifest.fetched_at });
  try {
    const lane = inboxLane(folder, manifest.source_id);
    const staged = await carryStaged(lane, manifest.staged_blobs ?? [], door);
    let written: Manifest;
    try {
      const wrong: string[] = [];
      for (const entry of manifest.files) {
        const kept = await sealing.write(entry.file, bundle.files.get(entry.file)!.stream()).catch(unreadable);
        if (kept.sha256 !== entry.sha256 || kept.bytes !== entry.bytes) wrong.push(entry.file);
      }
      if (wrong.length > 0)
        refuse(422, "ACQUISITION_HASH_MISMATCH", `${wrong.length} listed file(s) do not hash as listed: ${wrong.slice(0, 3).join(", ")}`);
      for (const [hex, entry] of bundle.blobs) {
        if (!await lane.store(hex, entry.stream(), entry.size).catch(unreadable))
          refuse(422, "ACQUISITION_BLOB_MISMATCH", `blob ${hex} bytes do not match its name`);
      }
      written = sealing.seal(sealed.facts, manifest, stamp);
    } catch (error) {
      staged.undo();
      throw error;
    }
    staged.sealed();
    return written;
  } catch (error) {
    sealing.abandon();
    throw error;
  }
}

async function carryStaged(lane: Lane, named: readonly string[], door: StagedDoor): Promise<Carried> {
  const lacking: string[] = [];
  for (const hash of named) {
    const held = lane.has(hash.slice("sha256:".length));
    if (held === "other") refuse(422, "ACQUISITION_BLOB_MISMATCH", `blob ${hash} is not a file in the store`);
    if (held === "absent" && !door.home.has(hash)) lacking.push(hash);
  }
  const carried = await door.files.carry(lacking, lane);
  const missing = lacking.filter((hash) => !carried.carried.includes(hash));
  if (missing.length > 0) {
    carried.undo();
    missingFiles({ files: missing }, BUNDLE_FILES);
  }
  return carried;
}
