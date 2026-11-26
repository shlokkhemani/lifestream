import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonical, flush, GONE, HOME_DB, isObject, LEDGER_DB, sourceName, tryLock, type FileLock, type HomeFolder, type Json, type OpenView, type RecordRef } from "@lifestreamprotocol/core";
import { AI_FAMILY, LABELS_FAMILY, labelsFrom, voiceItem, type Change, type Family } from "@lifestreamprotocol/families";
import { holdCalls, type Scrub } from "@lifestreamprotocol/model";
import { scrub } from "@lifestreamprotocol/privacy";
import { readRef } from "../refs.js";
import { openStage, stagedFile } from "../ask-files.js";
import { openStagedFiles } from "../staged-files.js";
import { findingsDirOf, forgetFindings } from "../engine-pictures.js";
import { dayFile } from "../derive.js";
import { DOOR_LOCK, type Removed } from "../erasable-streams.js";
import { failpoint, holdpoint } from "../failpoint.js";
import { deliveryReader } from "../import.js";
import { deliveredFile, deliveriesOf, deliveryAt, inboxLane, lanes, readDelivery, readSealed, receiptOf, removeDelivery, removeMembers } from "../inbox.js";
import { errorText } from "../jobs.js";
import { quietOf } from "../quiet.js";
import { readerFor, type Registry } from "../registry.js";
import { forgetMarks, marksFileOf } from "../marking.js";
import { forgetPeopleUndo } from "../people-draft.js";
import { callCopiesAt } from "../pick.js";
import { forgetPictures, picturesDirOf } from "../pictures.js";
import { discardPrepared, preparedDirOf, preparedFileOf } from "../prepared.js";
import type { Forgetting } from "../index-file.js";
import { reportsOnDisk } from "../feedback.js";
import { INDEXES } from "../index-job.js";
import { searchFileOf } from "../search-index.js";
import { readArgs } from "./args.js";
import { fail, familyOf, holdHome, readersOf, type ErasureContext, type VerbContext } from "./context.js";
import { CLI } from "../cli-name.js";

const USAGE = "erase <family> <thing> [--reason <why>] [--purge-deliveries] [--apply]";
const LOG_WAIT_MS = 1_000;
const MEMO_FILE = "memo.db";
const CALLS_LIMIT_MS = 6 * 60_000;
const ERROR_CHARS = 500;
const OWNERS = "the owner's erasure";

export const INTENT_META = "erasure";

export type ErasureStep = "plan" | "calls" | "access" | "remove" | "commit";

export interface Intent {
  family: string;
  thing: string;
  reason: string | null;
  purge: boolean;
  deliveries: string[];
  at_ms: number;
  error?: string;
  step?: ErasureStep;
  failed_ms?: number;
}

export function intentOf(value: string | undefined): Intent | null {
  return value === undefined ? null : JSON.parse(value) as Intent;
}

export function standingIntent(ctx: Pick<ErasureContext, "db">): Intent | null {
  const view = ctx.db.view();
  try {
    return intentOf(view.tables.meta.get(INTENT_META));
  } finally {
    view.close();
  }
}

function keepsOf(said: { purge: boolean; rebuilding: boolean; sent: boolean }): string[] {
  return [
    "Delete it on your devices and at the provider too: each device's next delivery brings a copy into the inbox, where it is never shown.",
    ...(said.purge ? [] : ["A delivery that holds it inside a larger file stays, unless you add --purge-deliveries."]),
    ...(said.rebuilding ? ["A rebuild under way may keep it in rows it has not published, until it empties them."] : []),
    ...(said.sent ? ["Each outbound row stays, with its receiver, time and counts; nothing in it names the thing any more."] : []),
    "Chat starts a new context, and every agent sees new numbers.",
    "A kept answer of Ask's stays as it was said: its words and the titles it cited stay, and what it cited opens nothing.",
    "The search and screen indexes keep the erased words' bytes, found by no search, until their segments merge.",
    "On the disk: home.db's free space that was never written over, such as whole pages freed by ordinary work before the erasure, "
      + "until they are reused; the drive's freed blocks and its own copies; and any copy of the folder.",
    "Ask's Codex keeps its own log of tool answers for up to 10 days; it trims it itself.",
  ];
}

export interface Plan {
  family: Family;
  records: RecordRef[];
  items: string[];
  units: { family: string; unit: string }[];
  days: string[];
  rebuilding: boolean;
  candidates: { id: string; source: string; stated: boolean }[];
  rows: Map<string, string[]>;
}

interface Purged {
  id: string;
  directory: string;
  unheld: string[];
}

interface Asked {
  family: Family;
  thing: string;
  reason: string | null;
  purge: boolean;
  apply: boolean;
}

type Planned = { standing: Intent } | { plan: Plan; registry: Registry; plan_ms: number };

export async function erase(ctx: VerbContext, args: readonly string[]) {
  const { values, positionals } = readArgs("erase", args, {
    reason: { type: "string" }, "purge-deliveries": { type: "boolean" }, apply: { type: "boolean" },
  }, USAGE, 2);
  const [familyName, thing] = positionals as [string, string];
  const family = await familyOf(ctx, familyName);
  if (family.replicas === undefined) fail(`family ${family.name} cannot name a thing's replicas, so it cannot erase`);
  const asked: Asked = { family, thing, reason: values.reason ?? null, purge: values["purge-deliveries"] === true, apply: values.apply === true };
  if (!asked.apply && !asked.purge) return await answered(ctx, asked, await planAsked(ctx, asked));
  await planAsked(ctx, asked);
  return await holdHome(ctx, async () => await answered(ctx, asked, await planAsked(ctx, asked)));
}
erase.usage = USAGE;

async function planAsked(ctx: VerbContext, asked: Asked): Promise<Planned> {
  const { family, thing } = asked;
  if (asked.apply) {
    const standing = standingIntent(ctx);
    if (standing !== null && (standing.family !== family.name || standing.thing !== thing)) fail(`an erasure that did not finish stands: run \`${CLI} act erasure try\` first`);
    if (standing !== null) return { standing };
  }
  const registry = await ctx.registry();
  const clock = timer();
  const plan = planOf(ctx, registry, family, thing);
  if (plan.records.length === 0) fail(`family ${family.name} names no record for ${thing}`);
  return { plan, registry, plan_ms: clock() };
}

async function answered(ctx: VerbContext, asked: Asked, planned: Planned) {
  const { family, thing, purge } = asked;
  if ("standing" in planned) return await resumeErasure(ctx, planned.standing) ?? fail(`family ${family.name} names no record for ${thing}`);
  const { plan, registry } = planned;
  const clock = timer();
  const ms: Record<string, number> = { plan: planned.plan_ms };
  const { deliveries, unreadable } = purge ? await holding(ctx, registry, plan) : { deliveries: [], unreadable: [] };
  if (purge) ms.reads = planned.plan_ms + clock();
  if (!asked.apply) {
    const sent = ctx.ledger.outbound.sentOf({ records: plan.records, items: plan.items, days: plan.days }, ctx.settings.day);
    return {
      applied: false, family: family.name, thing, records: plan.records, items: plan.items, units: plan.units,
      sent, keeps: keepsOf({ purge, rebuilding: plan.rebuilding, sent: sent.length > 0 }),
      ...(purge ? { deliveries, unreadable } : {}),
    };
  }
  const intent: Intent = { family: family.name, thing, reason: asked.reason, purge, deliveries, at_ms: ctx.now() };
  const applied = await applyErasure(ctx, intent, plan);
  return { ...applied, ...(purge ? { unreadable } : {}), ms: { ...ms, ...applied.ms } };
}

export async function resumeErasure(ctx: ErasureContext, intent: Intent): Promise<Answered | null> {
  const clock = timer();
  let plan: Plan;
  try {
    const registry = await ctx.registry();
    const family = registry.families.find((each) => each.name === intent.family) ?? fail(`no family ${intent.family}`);
    plan = planOf(ctx, registry, family, intent.thing);
  } catch (error) {
    recordFailure(ctx, "plan", error);
    throw error;
  }
  if (plan.records.length === 0) {
    ctx.db.commit((tx) => tx.tables.meta.delete(INTENT_META), { secure: true });
    return null;
  }
  const ms = { plan: clock() };
  const applied = await applyErasure(ctx, intent, plan);
  return { ...applied, ms: { ...ms, ...applied.ms } };
}

function planOf(ctx: ErasureContext, registry: Registry, family: Family, thing: string): Plan {
  if (family.replicas === undefined) fail(`family ${family.name} cannot name a thing's replicas, so it cannot erase`);
  const units = new Map<string, { family: string; unit: string }>();
  const candidates: Plan["candidates"] = [];
  const rows = new Map<string, string[]>();
  const days = new Set<string>();
  const view = ctx.db.view();
  try {
    const labels = labelsFrom((unit) => view.extract(LABELS_FAMILY, unit), ctx.settings.day);
    const { records, items } = wholeChats(family.replicas(thing, view, labels), (key) => family.replicas!(key, view, labels), view);
    if (records.length === 0) return { family, records, items, units: [], days: [], rebuilding: false, candidates, rows };
    const runs = new Set<number>();
    const changes = new Map<Family, Change[]>();
    for (const record of records) {
      const history = view.history(record);
      for (const statement of history) runs.add(statement.run);
      const gone = [...new Set(history.map((statement) => statement.version))].filter((id) => id !== GONE).map((id) => ({ record, before: view.version(id) }));
      for (const reader of readersOf(registry, view.source(record.source), record.kind)) {
        const list = changes.get(reader) ?? [];
        list.push(...gone);
        changes.set(reader, list);
      }
    }
    for (const [reader, gone] of changes) {
      for (const touched of reader.touched(gone, view)) {
        for (const unit of [touched.unit, touched.previous]) if (unit !== undefined) units.set(`${reader.name}\0${unit}`, { family: reader.name, unit });
      }
    }
    for (const { family: name, unit } of units.values()) {
      for (const day of view.extract(name, unit)?.days ?? []) days.add(day);
      for (const { day } of view.dayUnits(name, unit)) days.add(day);
    }
    const rebuilding = [...new Set([...units.values()].map((unit) => unit.family))].some((name) => view.derived.next.units(name, null, 1).length > 0);
    const sources = new Set(records.map((record) => record.source));
    for (const row of view.tables.deliveries.list()) {
      rows.set(row.id, [...rows.get(row.id) ?? [], row.source]);
      if (row.run !== null && sources.has(row.source)) candidates.push({ id: row.id, source: row.source, stated: runs.has(row.run) });
    }
    return { family, records, items, units: [...units.values()], days: [...days], rebuilding, candidates, rows };
  } finally {
    view.close();
  }
}

export type Answered = Omit<Applied, "ms"> & { ms: Record<string, number | Record<string, number>> };

export interface Applied {
  applied: true;
  run: number;
  records: number;
  statements: number;
  versions: number;
  blobs: number;
  enrichments: number;
  units: number;
  days: string[];
  inbox_files: number;
  deliveries_purged: number;
  delivery_blobs: number;
  ledger: ReturnType<ErasureContext["ledger"]["forget"]>;
  streams: "cut" | "owed";
  logs_kept: string[];
  ms: { calls: number; commit: number; logs: number; parts: Record<string, number> };
}

export async function applyErasure(ctx: ErasureContext, intent: Intent, plan: Plan): Promise<Applied> {
  const { family, records, items, units, rows } = plan;
  const registry = await ctx.registry();
  const clock = timer();
  const dir = ctx.machine.dir;
  const resuming = standingIntent(ctx) !== null;
  let written = resuming;
  let step: ErasureStep = "calls";
  let calls: FileLock | undefined;
  try {
    calls = await holdCalls(join(ctx.folder.root, "replies", "replies.db"), {
      limit_ms: ctx.calls?.limit_ms ?? CALLS_LIMIT_MS, ...(ctx.calls?.signal === undefined ? {} : { signal: ctx.calls.signal }),
      waiting: () => ctx.going("waiting for model calls to end"),
    });
    const waited = clock();
    await holdpoint("erase.held", "calls.lock held");
    if (!resuming) await owedCutSettled(ctx);
    step = "remove";
    const asked = { family: intent.family, thing: intent.thing, reason: intent.reason, purge: intent.purge, deliveries: intent.deliveries, at_ms: intent.at_ms };
    ctx.db.commit((tx) => tx.tables.meta.set(INTENT_META, canonical(asked)), { secure: true });
    written = true;
    failpoint("erase.intent");
    const purged = purgedOf(ctx, intent.deliveries);
    const now = intent.at_ms;
    const chats = chatsOf(records);
    const pending = await chatPending(ctx, registry, chats);
    const reached = [...records, ...pending.records];
    await (ctx.feedback ?? reportsOnDisk(ctx.folder, { drop: (hash) => void stagedFile(ctx.folder, hash).remove() }, (line) => ctx.going(JSON.stringify(line)))).forget(reached);
    const forgotten = [
      ...items.map((item) => ({ family: family.name, item })),
      ...pending.items.map((item) => ({ family: AI_FAMILY, item })),
    ];

    const logsKept: string[] = [];
    const parts: Record<string, number> = {};
    const gone: { blobs: string[]; days: string[]; people: boolean } = { blobs: [], days: [], people: false };
    const { value: applied, streams } = await marked(ctx, () => (resuming ? { all: true } : gone), () => ctx.db.commit((tx) => {
      const part = timer();
      const removed = new Set<string>();
      const blobDirs = new Set<string>();
      const run = tx.tables.runs.start({ kind: "erase", subject: family.name, started_ms: now });
      const erased = tx.records.erase({
        records: reached, items: forgotten,
        units, reason: intent.reason ?? OWNERS, at_ms: now,
      });
      tx.tables.meta.delete(INTENT_META);
      for (const { id } of purged) {
        for (const source of rows.get(id) ?? []) {
          const why = `purged by erasure run ${run}`;
          tx.tables.deliveries.move(id, source, { move: "purge", why });
          const row = tx.tables.deliveries.get(id, source);
          if (row?.state === "dead") tx.tables.deliveries.move(id, source, { move: "supersede", why });
          else if (row?.state === "imported" && row.refused > 0) tx.tables.deliveries.move(id, source, { move: "reread", code: registry.code, refused: 0, error: why });
        }
      }
      if (records.some((record) => ["people", "faces"].includes(sourceName(record.source).product))) forgetPeopleUndo(tx);
      const counts = { records: erased.records, statements: erased.statements, versions: erased.versions.length, blobs: erased.blobs.length, enrichments: erased.enrichments, units: erased.extracts.length };
      tx.tables.runs.end(run, { ended_ms: now, outcome: "ok", counts });
      tx.tables.events.append({ at_ms: now, kind: "erase", key: String(run), detail: { run, ...counts } });
      for (const name of new Set(erased.extracts.map((each) => each.family))) {
        const taken = erased.extracts.filter((each) => each.family === name).map((each) => each.unit);
        tx.tables.events.append({ at_ms: now, kind: "extract", key: name, detail: { units: taken.slice(0, 50), count: taken.length } });
      }
      parts.records = part();
      failpoint("erase.cleanup");

      step = "access";
      const ledger = ctx.ledger.forget(forgotten.map(({ item }) => item), reached, { scrub: erasedIn(reached), at_ms: now }, erased.days);
      step = "remove";
      if (!ctx.ledger.truncateLog(LOG_WAIT_MS)) logsKept.push(LEDGER_DB);
      ctx.folder.emptyWork({ program: "call", plain: callCopiesAt(ctx.folder.root, dir) });
      parts.ledger = part();
      failpoint("erase.ledger");

      for (const day of erased.days) {
        gone.days.push(day);
        for (const file of ["json", "txt", "lines"] as const) dayFile(ctx.folder, day, file).remove();
        removed.add(join(ctx.folder.root, "days"));
        if (tx.derived.days.delete(day)) tx.tables.events.append({ at_ms: now, kind: "day", key: day, detail: { inputs: null } });
      }
      removed.add(dirname(searchFileOf(ctx.folder.root, dir)));
      const forgetting: Forgetting = {
        folder: ctx.folder, machine: dir, blobs: ctx.blobs, settings: ctx.settings, families: registry.families,
        forgetMarks: (texts) => forgetMarks(ctx.folder, marksFileOf(ctx.folder.root, dir), texts), wait_ms: LOG_WAIT_MS, kept: logsKept,
      };
      for (const index of INDEXES) {
        index.forget(forgetting, records, erased.days);
        failpoint(`erase.forgot.${index.name}`);
      }
      gone.people = true;
      for (const name of ["people", "places"] as const) {
        const directory = preparedDirOf(ctx.folder.root, dir, name);
        discardPrepared(preparedFileOf(directory, name));
        discardPrepared(join(directory, MEMO_FILE));
        removed.add(directory);
      }
      parts.search = part();
      failpoint("erase.search");
      const erasedBlobs = new Set(erased.blobs);
      const stored = (blob: string) => pending.held.has(blob) && !erasedBlobs.has(blob);
      const sealedIn = (source: string, blob: string) => pending.others.has(`${source}\0${blob}`);
      const going = [...new Set([...erased.blobs, ...pending.files])].filter((blob) => !stored(blob));
      gone.blobs.push(...going);
      for (const hash of going) {
        ctx.blobs.remove(hash);
        blobDirs.add(ctx.blobs.directory(hash));
      }
      const hexes = new Set(erased.blobs.filter((blob) => !stored(blob)).map((hash) => hash.replace(/^sha256:/u, "")));
      let inboxFiles = 0;
      for (const id of new Set(plan.candidates.map((delivery) => delivery.id))) inboxFiles += removeFiles(ctx.folder, deliveryAt(ctx.folder, id), hexes, now);
      for (const { source, blob } of pending.carried.filter((each) => !stored(each.blob) && !sealedIn(each.source, each.blob))) {
        inboxFiles += inboxLane(ctx.folder, source).removeBlobs([blob]);
      }
      if (hexes.size > 0) {
        for (const source of lanes(ctx.folder)) {
          inboxFiles += inboxLane(ctx.folder, source).removeBlobs([...hexes].filter((hex) => !sealedIn(source, `sha256:${hex}`)));
        }
      }
      const stage = openStage(ctx.folder);
      const staged = stage.erase([...erased.blobs, ...pending.files]);
      openStagedFiles(ctx.folder).erase([...erased.blobs, ...pending.files]);
      for (const directory of staged.folders) removed.add(directory);
      parts.blobs = part();
      failpoint("erase.blobs");
      const pictures = picturesDirOf(ctx.folder, dir);
      const findings = findingsDirOf(ctx.folder, dir);
      const held = { has: (hash: string) => ctx.blobs.has(hash) || stage.has(hash) };
      const forgetMade = (hash: string) => {
        for (const directory of [...forgetPictures(pictures, hash), ...forgetFindings(findings, hash, held)]) removed.add(directory);
      };
      for (const hash of new Set([...going, ...staged.removed])) forgetMade(hash);

      const unheld = [...new Set(purged.flatMap((delivery) => delivery.unheld))];
      gone.blobs.push(...unheld);
      let deliveryBlobs = 0;
      for (const hash of unheld.filter((blob) => !stored(blob))) {
        if (ctx.blobs.remove(hash)) deliveryBlobs++;
        blobDirs.add(ctx.blobs.directory(hash));
        forgetMade(hash);
      }
      parts.purge = part();
      failpoint("erase.purge");
      for (const directory of new Set([...blobDirs, ...removed])) if (existsSync(directory)) flush(directory);
      for (const delivery of purged) removeDelivery(ctx.folder, delivery.directory, { point: "erase.delivery" });
      parts.deliveries = part();
      step = "commit";
      return {
        applied: true as const, run, records: erased.records, statements: erased.statements, versions: erased.versions.length, blobs: erased.blobs.length,
        enrichments: erased.enrichments, units: erased.extracts.length, days: erased.days, inbox_files: inboxFiles,
        deliveries_purged: purged.length, delivery_blobs: deliveryBlobs, ledger,
      };
    }, { secure: true }));
    const committed = clock();
    if (ctx.db.checkpoint("truncate", LOG_WAIT_MS).busy !== 0) logsKept.push(HOME_DB);
    return { ...applied, streams, logs_kept: logsKept, ms: { calls: waited, commit: committed, logs: clock(), parts } };
  } catch (error) {
    if (written) recordFailure(ctx, step, error);
    throw error;
  } finally {
    calls?.release();
  }
}

export function recordFailure(ctx: Pick<ErasureContext, "db" | "now">, step: ErasureStep, error: unknown): void {
  try {
    ctx.db.commit((tx) => {
      const intent = intentOf(tx.tables.meta.get(INTENT_META));
      if (intent === null) return;
      tx.tables.meta.set(INTENT_META, canonical({ ...intent, error: errorText(error).slice(0, ERROR_CHARS), step, failed_ms: ctx.now() }));
    }, { secure: true });
  } catch {
  }
}

function timer(): () => number {
  let last = performance.now();
  return () => {
    const at = performance.now();
    const took = Math.round(at - last);
    last = at;
    return took;
  };
}

async function marked<T>(ctx: ErasureContext, removed: () => Removed, work: () => T): Promise<{ value: T; streams: "cut" | "owed" }> {
  ctx.ledger.placeholders.beginErasure();
  let cut = false;
  try {
    let value: T;
    try {
      value = work();
    } finally {
      cut = await streamsCut(ctx, removed());
    }
    failpoint("erase.committed");
    return { value, streams: cut ? "cut" : "owed" };
  } finally {
    if (!cut) ctx.going("The erasure's mark stands until the door's streams are cut: Chat and agents wait until the home's next start cuts every stream at the door.");
    else {
      try {
        ctx.ledger.placeholders.endErasure();
      } catch (error) {
        ctx.going(`The ledger's erasure mark stands (${(error as Error).message}): Chat and agents wait until the home's next start clears it.`);
      }
    }
  }
}

async function owedCutSettled(ctx: ErasureContext): Promise<void> {
  if (!ctx.ledger.placeholders.epoch().erasing) return;
  if (!await streamsCut(ctx, { all: true })) {
    fail("an earlier erasure's cut of the door's streams is still owed, and the door did not cut them now: this erasure waits until it does (the home's next start, or this erasure asked again once the door answers)");
  }
  ctx.ledger.placeholders.endErasure();
}

export async function streamsCut(ctx: Pick<ErasureContext, "folder" | "cutStreams" | "going">, removed: Removed): Promise<boolean> {
  if (removed.all !== true && (removed.blobs?.length ?? 0) === 0 && (removed.days?.length ?? 0) === 0 && removed.people !== true) return true;
  if (!doorServes(ctx.folder.root)) return true;
  if (ctx.cutStreams === undefined) {
    ctx.going("A door serves this home's files and no home runs to ask it to cut their streams: the home's start cuts them.");
    return false;
  }
  try {
    await ctx.cutStreams(removed);
    return true;
  } catch (error) {
    ctx.going(`The door did not cut the streams of what the erasure removed (${(error as Error).message}): the home's next start cuts every one.`);
    return false;
  }
}

function doorServes(root: string): boolean {
  const path = join(root, DOOR_LOCK);
  if (!existsSync(path)) return false;
  const lock = tryLock(path);
  if (lock === null) return true;
  lock.release();
  return false;
}

async function holding(ctx: ErasureContext, registry: Registry, plan: Plan): Promise<{ deliveries: string[]; unreadable: { delivery: string; error: string }[] }> {
  const decided = new Map<string, boolean>();
  const unreadable: { delivery: string; error: string }[] = [];
  const view = ctx.db.view();
  try {
    for (const { id, source, stated } of plan.candidates) {
      if (decided.get(id) === true) continue;
      if (stated && readSealed(ctx.folder, deliveryAt(ctx.folder, id)) !== null) {
        decided.set(id, true);
        continue;
      }
      const keys = new Set(plan.records.filter((record) => record.source === source).map((record) => `${record.kind}\0${record.key}`));
      try {
        decided.set(id, await holds(ctx, registry, view, id, source, keys));
      } catch (error) {
        unreadable.push({ delivery: id, error: (error as Error).message });
      }
    }
    return { deliveries: [...decided].filter(([, held]) => held).map(([id]) => id), unreadable };
  } finally {
    view.close();
  }
}

function purgedOf(ctx: ErasureContext, ids: readonly string[]): Purged[] {
  const view = ctx.db.view();
  try {
    return ids.map((id) => {
      const directory = deliveryAt(ctx.folder, id);
      const files = readSealed(ctx.folder, directory)?.files ?? [];
      return { id, directory, unheld: [...new Set(files.map((entry) => `sha256:${entry.sha256}`))].filter((hash) => !view.holds(hash)) };
    });
  } finally {
    view.close();
  }
}

async function holds(ctx: ErasureContext, registry: Registry, view: OpenView, id: string, source: string, keys: ReadonlySet<string>): Promise<boolean> {
  const at = id.indexOf("/");
  const delivery = view.tables.deliveries.get(id, source);
  if (delivery !== undefined && quietOf(delivery) !== undefined) return false;
  const sealed = readDelivery(ctx.folder, id.slice(0, at), id.slice(at + 1));
  if (sealed === null) return false;
  const row = view.tables.sources.get(source);
  const connector = (row === undefined ? undefined : readerFor(registry, row))
    ?? fail(`no connector reads ${source}, so delivery ${id} cannot be read to know whether it holds the thing`);
  for await (const each of connector.read({ ...sealed, source }, ctx.blobs, view)) if (keys.has(`${each.kind}\0${each.key}`)) return true;
  return false;
}

interface ChatPending {
  records: RecordRef[];
  items: string[];
  carried: { source: string; blob: string }[];
  files: string[];
  others: Set<string>;
  held: Set<string>;
}

const UNREAD = new Set(["sealed", "importing", "failed", "dead"]);

async function chatPending(ctx: ErasureContext, registry: Registry, chats: readonly string[]): Promise<ChatPending> {
  const erasedChats = new Set(chats);
  if (erasedChats.size === 0) return { records: [], items: [], carried: [], files: [], others: new Set(), held: new Set() };
  const stage = openStage(ctx.folder);
  stage.erasing(chats);
  const sealed: { source: string; key: string; files: string[]; audio: string | undefined; erased: boolean }[] = [];
  const view = ctx.db.view();
  try {
    for (const source of lanes(ctx.folder)) {
      if (!/^ask:/u.test(source)) continue;
      const row = view.tables.sources.get(source);
      const connector = row === undefined ? undefined : readerFor(registry, row);
      if (connector === undefined) continue;
      for (const name of deliveriesOf(ctx.folder, source)) {
        const delivery = view.tables.deliveries.get(`${source}/${name}`, source);
        if (delivery !== undefined && (!UNREAD.has(delivery.state) || quietOf(delivery) !== undefined)) continue;
        const read = readDelivery(ctx.folder, source, name);
        if (read === null) continue;
        try {
          const directory = deliveryAt(ctx.folder, `${source}/${name}`);
          const own = new Map(read.files.map((file) => [file.blob, deliveredFile(ctx.folder, directory, file.path)] as const));
          for await (const each of connector.read({ ...read, source }, deliveryReader(ctx.blobs, inboxLane(ctx.folder, source), own), view)) {
            const content = each.content;
            if (each.kind !== "msg" || !isObject(content) || typeof content.chat !== "string") continue;
            const audio = isObject(content.voice) && typeof content.voice.audio === "string" ? content.voice.audio : undefined;
            const photos = Array.isArray(content.photos) ? content.photos.filter((photo): photo is string => typeof photo === "string") : [];
            sealed.push({ source, key: each.key, files: [...photos, ...(audio === undefined ? [] : [audio])], audio, erased: erasedChats.has(content.chat) });
          }
        } catch {
        }
      }
    }
    const mine = sealed.filter((question) => question.erased);
    const theirs = sealed.filter((question) => !question.erased);
    const files = [...new Set(mine.flatMap((question) => question.files))];
    const held = new Set(files.filter((blob) => view.holds(blob)));
    const notes = new Set(mine.flatMap((question) => (question.audio === undefined ? [] : [question.audio])));
    return {
      records: mine.map((question) => ({ source: question.source, kind: "msg", key: question.key })),
      items: [...notes].filter((audio) => !held.has(audio)).map(voiceItem).sort(),
      carried: [...new Map(mine.flatMap((question) => question.files.map((blob) => [`${question.source}\0${blob}`, { source: question.source, blob }]))).values()],
      files, held,
      others: new Set(theirs.flatMap((question) => question.files.map((blob) => `${question.source}\0${blob}`))),
    };
  } finally {
    view.close();
  }
}

type Replicas = { records: RecordRef[]; items: string[] };

function wholeChats(named: Replicas, replicas: (key: string) => Replicas, view: OpenView): Replicas {
  const asked = named.records.filter((record) => sourceName(record.source).product === "ask");
  if (asked.length === 0) return named;
  const records = new Map(named.records.map((record) => [`${record.source}\0${record.kind}\0${record.key}`, record]));
  const items = new Set(named.items);
  const add = (record: RecordRef) => records.set(`${record.source}\0${record.kind}\0${record.key}`, record);
  for (const source of new Set(asked.map((record) => record.source))) {
    for (const chat of chatsOf(asked.filter((record) => record.source === source))) {
      const shell = { source, kind: "chat", key: chat };
      if (view.head(shell) !== undefined) add(shell);
      for (const { key } of view.keyedUnder(source, "msg", `${chat}:`)) {
        const each = replicas(key);
        each.records.forEach(add);
        each.items.forEach((item) => items.add(item));
      }
    }
  }
  return { records: [...records.values()], items: [...items].sort() };
}

function chatsOf(records: readonly RecordRef[]): string[] {
  const chats = records.filter((record) => sourceName(record.source).product === "ask" && (record.kind === "chat" || record.kind === "msg"))
    .map((record) => (record.kind === "chat" ? record.key : record.key.split(":")[0]!));
  return [...new Set(chats)];
}

function removeFiles(folder: HomeFolder, directory: string, hexes: ReadonlySet<string>, now_ms: number): number {
  if (hexes.size === 0) return 0;
  const manifest = readSealed(folder, directory);
  if (manifest === null) return 0;
  const listed = manifest.files.filter((entry) => hexes.has(entry.sha256));
  const gone = listed.filter((entry) => deliveredFile(folder, directory, entry.file).exists());
  const receipt = receiptOf(folder, directory);
  if (gone.length > 0 && !receipt.exists()) receipt.write(Buffer.from(`${JSON.stringify({ swept_ms: now_ms, done: false, removed: gone.map((entry) => entry.file), kept: [] })}\n`));
  return removeMembers(folder, directory, listed.map((entry) => entry.file));
}

export function erasedIn(records: readonly RecordRef[]): Scrub {
  const erased = scrub({ records });
  return { access: (lines) => erased.access(lines), names: (value) => erased.names(refsOpened(value)) };
}

function refsOpened(value: Json): Json {
  if (typeof value === "string") {
    if (!value.startsWith("record.")) return value;
    try {
      return { ...readRef(value, "ref", ["record"]).parts };
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(refsOpened);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, refsOpened(each)]));
}
