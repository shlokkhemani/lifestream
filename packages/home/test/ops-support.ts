import { createHash } from "node:crypto";
import { constants, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHome, openHomeFolder, type BlobStore, type Guard, type HomeDb, type HomeFolder, type Json, type Landed, type ReaderOutput, type RecordRef } from "@lifestreamprotocol/core";
import { linesOnly, type Family } from "@lifestreamprotocol/families";
import { openLedger, type Ledger } from "@lifestreamprotocol/model";
import { openSealing } from "../inbox.js";
import { machine } from "../machine.js";
import type { OpsSettings, VerbContext } from "../verbs/context.js";
import { connectors } from "../registry-home.js";
import { declarations, vendorOf } from "@lifestreamprotocol/connect";
import { readPrivacySettings } from "@lifestreamprotocol/privacy";
import { effectiveOf } from "../settings.js";

export { writeFolder } from "./folder.js";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const T0 = Date.UTC(2026, 8, 1, 8);
export const ARTIFACTS = join(tmpdir(), "lifestream-home-ops-e2e");
export const SETTINGS: OpsSettings = {
  day: { zone: "UTC", day_start_hour: 4 }, history: { start: "all" }, connectors: {}, clients: {}, sources: { off: [] }, sites: { chosen: [] }, unit: "macbook-pro-0001", defaults: { pictures: null, audio: null, text: null, chat: null, search: null, hiding: null }, runners: {},
  door: { port: 0, max_bundle_bytes: 1 << 30 }, model: effectiveOf({ "day.zone": "UTC", unit: "macbook-pro-0001" }, "").settings.model, helpers: 2,
  privacy: readPrivacySettings({}), screen_cutover_ms: effectiveOf({ "day.zone": "UTC", unit: "macbook-pro-0001" }, "").settings.screen_cutover_ms,
};

const object: Guard = (content) => (typeof content === "object" && content !== null && !Array.isArray(content) ? [] : ["content is not an object"]);
export const GUARDS: Record<string, Guard> = { msg: object, photo: object, sample: object, recorder: object, gap: object };
const CODE = "sha256:ops-support-code";

export function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `lifestream-${name}-`));
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface TestHome {
  root: string;
  folder: HomeFolder;
  db: HomeDb;
  blobs: BlobStore;
  close(): void;
}

let opsTemplateDir: string | undefined;

function opsTemplate(): string {
  if (opsTemplateDir !== undefined && existsSync(opsTemplateDir)) return opsTemplateDir;
  const dir = mkdtempSync(join(tmpdir(), "lifestream-ops-template-"));
  mkdirSync(join(dir, "replies"), { recursive: true });
  const folder = openHomeFolder(dir);
  openHome(folder, "migrate").close();
  openLedger(folder, { mode: "migrate" }).close();
  opsTemplateDir = dir;
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function openTestHome(root: string, folder: HomeFolder = openHomeFolder(root)): TestHome {
  if (folder.form === "plain" && !existsSync(join(root, "home.db")) && !existsSync(join(root, "replies", "replies.db"))) {
    cpSync(opsTemplate(), root, { recursive: true, mode: constants.COPYFILE_FICLONE });
    const db = openHome(folder, "write");
    return { root, folder, db, blobs: folder.blobs(join(root, "blobs")), close: () => db.close() };
  }
  mkdirSync(join(root, "replies"), { recursive: true });
  const db = openHome(folder, "migrate");
  openLedger(folder, { mode: "migrate" }).close();
  return { root, folder, db, blobs: folder.blobs(join(root, "blobs")), close: () => db.close() };
}

export function land(
  db: HomeDb,
  input: { source: string; stated_ms: number; rows: ReaderOutput[]; name?: string; ended_ms?: number },
): { run: number; landed: Landed; delivery: string } {
  const name = input.name ?? new Date(input.stated_ms).toISOString().replace(/[-:]/gu, "");
  const id = `${input.source}/${name}`;
  return db.commit((tx) => {
    if (tx.tables.sources.get(input.source) === undefined) tx.tables.sources.add({ id: input.source, vendor: vendorOf(declarations(), input.source), connector: "synthetic", added_ms: input.stated_ms });
    tx.tables.deliveries.add({ id, source: input.source, sealed_ms: input.stated_ms, stated_ms: input.stated_ms, facts: {} });
    const run = tx.tables.runs.start({ kind: "import", subject: input.source, started_ms: input.stated_ms });
    const landed = tx.records.land(run, { id, source: input.source, stated_ms: input.stated_ms }, input.rows, GUARDS, { has: () => true });
    const { changedPaths, refusals: _refusals, refusedMembers: _members, ...counts } = landed;
    tx.tables.runs.end(run, { ended_ms: input.ended_ms ?? input.stated_ms, outcome: "ok", counts, changed_paths: changedPaths });
    tx.tables.deliveries.move(id, input.source, { move: "land", run, refused: landed.refused, error: null, code: CODE });
    tx.tables.sources.advance(input.source, input.stated_ms);
    return { run, landed, delivery: id };
  });
}

export function sealDelivery(root: string, source: string, name: string, files: Record<string, Buffer>, facts: Record<string, Json> = {}): string {
  const sealing = openSealing(openHomeFolder(root), { source, name, feeder: "synthetic", fetched_at: "2026-09-01T08:00:00.000Z" });
  for (const [file, bytes] of Object.entries(files)) sealing.put(file, bytes);
  sealing.seal(facts);
  return sealing.directory;
}

export const messages: Family = {
  name: "messages",
  type: "messages",
  code: "1",
  inputs: [{ sources: { product: ["imessage"] }, kinds: ["msg"], role: "evidence" }],
  touched: (changes) => changes.flatMap((change) => {
    const content = (change.after ?? change.before)?.content as { chat: string; date: string } | undefined;
    return content === undefined ? [] : [{ unit: `${content.chat}/${content.date}` }];
  }),
  extract: () => null,
  days: (extract) => extract.days,
  day: linesOnly(() => []),
  replicas: (thing, view) => {
    const records: RecordRef[] = [];
    for (const source of view.sources({ product: ["imessage"] })) {
      const record = { source: source.id, kind: "msg", key: thing };
      if (view.head(record) !== undefined) records.push(record);
    }
    return { records, items: [thing] };
  },
  items: (extract) => ((extract.content as { images?: string[] }).images ?? []).map((item) => ({ item, prompt: "chat-image" })),
};

export const photos: Family = {
  name: "photos",
  type: "photos",
  code: "1",
  inputs: [{ sources: { product: ["apple-photos"] }, kinds: ["photo"], role: "evidence" }],
  touched: (changes) => changes.map((change) => ({ unit: change.record.key })),
  extract: () => null,
  days: (extract) => extract.days,
  day: linesOnly(() => []),
  items: (extract) => ((extract.content as { photos: string[] }).photos).map((item) => ({ item, prompt: "photo-caption" })),
};

export function context(home: TestHome, options: { families?: Family[]; settings?: OpsSettings; now?: number; out?: string[] } = {}): VerbContext & { ledger: Ledger; close(): void } {
  const ledger = openLedger(home.folder, { mode: "migrate" });
  const out = options.out ?? [];
  return {
    folder: home.folder, machine: machine(), cwd: home.root, by: "terminal", db: home.db, blobs: home.blobs, ledger, settings: options.settings ?? SETTINGS,
    registry: async () => ({ families: options.families ?? [messages, photos], connectors: connectors(), readers: [], code: "code-test" }),
    now: () => options.now ?? T0, out: (line) => out.push(line), going: (line) => out.push(line),
    close: () => ledger.close(),
  };
}

export function answered(ledger: Ledger, input: { key: string; family: string; unit: string; at_ms: number; cost?: number; attachment?: Buffer }): void {
  const attachments = input.attachment === undefined ? [] : [{ kind: "image" as const, sha256: ledger.keep(input.attachment), extension: ".jpg" }];
  ledger.request({
    key: input.key, family: input.family, unit: input.unit, revision: input.key, model: "fake-model", effort: "low",
    prompt: { name: "describe", version: 1, text: "Describe the item.", type: "text" }, input_hash: sha256(input.key), body: `synthetic input for ${input.unit}`, attachments,
  }, input.at_ms);
  const begun = ledger.beginAttempt(input.key, input.at_ms, "fake");
  if (!("attempt" in begun)) throw new Error(`no attempt for ${input.key}`);
  ledger.land(begun.attempt, { text: `a synthetic reply about ${input.unit}`, model: "fake-model", transport: "fake", ...(input.cost === undefined ? {} : { cost: input.cost }) }, input.at_ms + 1_000);
}

export function recordsOf(db: HomeDb, source: string, kind: string): Json {
  const view = db.view();
  try {
    const heads = [...view.heads(source, kind)].map((head) => ({ key: head.key, version: head.version, stated_ms: head.stated_ms }));
    const history = heads.map((head) => view.history({ source, kind, key: head.key }).map((statement) => ({ version: statement.version, origin: statement.origin, run: statement.run })));
    return { heads, history } as unknown as Json;
  } finally {
    view.close();
  }
}

export function writeArtifact(name: string, value: unknown): string {
  mkdirSync(ARTIFACTS, { recursive: true });
  const path = join(ARTIFACTS, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}
