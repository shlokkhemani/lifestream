import { join } from "node:path";
import { civilDay, GONE, openHome, type HomeFolder, type OpenView, type Statement } from "@lifestreamprotocol/core";
import { EMBED_TEXTS } from "@lifestreamprotocol/model";
import { EmbedderError, openEmbedder, routes, waitsOfAdmission, waitsOfError, type Embedder } from "./embedder.js";
import { failpoint } from "./failpoint.js";
import type { Index, IndexCursor, IndexState } from "./index-file.js";
import type { HelperEnv } from "./jobs.js";
import { screenQueue } from "./marking.js";
import { meaningSettingsOf, ScreenIndex, screenFileOf, screenProgress, screenStanding, SEGMENT_MS, type EmbedWaits, type ScreenStanding } from "./screen-index.js";
import { bucketOf, erasedStretches, erasedTexts, frameSources, screenRoles, ViewScreenSource, withoutRecords } from "./screen-source.js";
import { searchFileOf, statementName } from "./search-index.js";
import { meaningModel } from "./search-route.js";


export const SCREEN_READS = "1";
const CHUNK_STATEMENTS = 2_000;
const RUN_STATEMENTS = 50_000;
const RUN_MS = 60_000;
const GRACE_MS = 10 * 60_000;
const FRAME_KINDS = ["frame", "ax"];
export const SCREEN_KINDS = [...FRAME_KINDS, "recorder"];
const EMBED_AGAIN_MS = 60_000;

interface ScreenPosition {
  seq: number;
  statement: string | null;
  reread: number;
  reads: string;
}

interface ScreenResult extends Embedded {
  walked: number;
  statements: number;
  appended: number;
  rebuilt: number;
  held: number;
  open: number;
  closes_ms: number | null;
  queued: number;
  compacted: number;
}

export interface Embedded {
  embedded: number;
  dropped: number;
  skipped: number;
  waits: EmbedWaits["waits"] | null;
  more: boolean;
}

interface Touched {
  machine: string;
  day: string;
  bucket: number;
  first?: number;
  emptied: boolean;
}

async function* screenRun(env: HelperEnv, from: IndexCursor): AsyncGenerator<IndexCursor, ScreenResult, undefined> {
  const result: ScreenResult = { walked: 0, statements: 0, appended: 0, rebuilt: 0, held: 0, open: 0, closes_ms: null, queued: 0, compacted: 0, embedded: 0, dropped: 0, skipped: 0, waits: null, more: false };
  const roles = screenRoles(env.registry.families);
  if (roles === undefined) return result;
  const began = performance.now();
  const late = () => performance.now() - began >= RUN_MS;
  const reads = `${SCREEN_READS}/${env.settings.screen_cutover_ms}`;
  const days = env.settings.day;
  const look = env.db.view();
  let index: ScreenIndex;
  let rereads: number;
  try {
    rereads = look.newestReread();
    const fits = (position: unknown, building: boolean): boolean => {
      const at = position as ScreenPosition | null;
      if (at === null) return building;
      if (at.reads !== reads || at.reread > rereads) return false;
      if (at.seq === 0) return true;
      if (!building && from.seq === 0) return false;
      if (at.statement === null) return at.seq <= look.through;
      const stated = look.statementAt(at.seq);
      return stated !== undefined && statementName(stated) === at.statement;
    };
    const chosen = meaningModel(env.settings);
    index = ScreenIndex.write(env.folder, screenFileOf(searchFileOf(env.folder.root, env.machine)), { days, meaning: chosen?.file ?? false, settings: meaningSettingsOf(chosen) }, fits);
  } finally {
    look.close();
  }
  try {
    result.walked = index.walkMeaning(() => !late());
    const view = env.db.view();
    try {
      const source = new ViewScreenSource(view, roles, env.blobs, env.settings.screen_cutover_ms, days);
      const machines = frameSources(view, roles);
      const held = index.position() as ScreenPosition | null;
      let at: ScreenPosition = held ?? { seq: 0, statement: null, reread: rereads, reads };
      if (at.seq !== from.seq || at.reread !== from.reread) yield { seq: at.seq, reread: at.reread };
      const pending = new Map<string, Touched>();
      const touch = (machine: string, t: number, first: number | undefined, emptied: boolean) => {
        const day = civilDay(t, days);
        const bucket = bucketOf(t);
        const name = `${machine}\0${day}\0${bucket}`;
        const known = pending.get(name);
        if (known === undefined) pending.set(name, { machine, day, bucket, ...(first === undefined ? {} : { first }), emptied });
        else {
          if (first !== undefined && (known.first === undefined || first < known.first)) known.first = first;
          known.emptied ||= emptied;
        }
      };
      const statements = machines.size === 0 ? [][Symbol.iterator]() : view.statements(at.seq, { sources: [...machines.keys()], kinds: SCREEN_KINDS })[Symbol.iterator]();
      let scanned = at.seq;
      let rereadAt = at.reread;
      for (;;) {
        let count = 0;
        let last: Statement | undefined;
        while (count < CHUNK_STATEMENTS) {
          const next = statements.next();
          if (next.done === true) break;
          const statement: Statement = next.value;
          count++;
          last = statement;
          if (!FRAME_KINDS.includes(statement.kind)) continue;
          const t = frameStart(view, statement.source, statement.key);
          if (t !== undefined) touch(machines.get(statement.source)!, t, statement.seq, statement.version === GONE);
        }
        const again = view.rereads(rereadAt, CHUNK_STATEMENTS);
        for (const each of again) {
          if (!("record" in each)) continue;
          const machine = machines.get(each.record.source);
          if (machine === undefined || !FRAME_KINDS.includes(each.record.kind)) continue;
          const t = frameStart(view, each.record.source, each.record.key);
          if (t !== undefined) touch(machine, t, undefined, true);
        }
        const full = count >= CHUNK_STATEMENTS;
        scanned = full ? last!.seq : view.through;
        rereadAt = again.at(-1)?.seq ?? rereadAt;
        const now = Date.now();
        const segments = [];
        const emptied = new Set<string>();
        let hold = Number.POSITIVE_INFINITY;
        for (const [name, bucket] of pending) {
          const end = bucket.bucket + SEGMENT_MS;
          if (end + GRACE_MS > now && !frameAfter(view, machines, bucket.machine, end)) {
            if (bucket.first !== undefined) hold = Math.min(hold, bucket.first - 1);
            continue;
          }
          pending.delete(name);
          const segment = source.segment(bucket.machine, bucket.bucket, bucket.day);
          if (segment !== undefined) segments.push(segment);
          else if (bucket.emptied) emptied.add(`${bucket.machine}\0${bucket.day}`);
        }
        const seq = Math.min(scanned, hold);
        const stated = seq === 0 ? undefined : view.statementAt(seq);
        const position: ScreenPosition = { seq, statement: stated === undefined ? null : statementName(stated), reread: rereadAt, reads };
        const moved = position.seq !== at.seq || position.reread !== at.reread;
        if (segments.length > 0 || emptied.size > 0 || moved) {
          const applied = index.apply(segments, source, position, emptied);
          result.appended += applied.appended;
          result.rebuilt += applied.rebuilt.length;
          result.held += applied.held;
          failpoint("screen.indexed");
        }
        result.statements += count;
        result.open = pending.size;
        result.closes_ms = closesAt(pending.values(), now);
        if (moved) {
          at = position;
          yield { seq: position.seq, reread: position.reread };
        }
        if (!full && again.length < CHUNK_STATEMENTS) break;
        if (result.statements >= RUN_STATEMENTS || late()) {
          result.more = true;
          break;
        }
      }
    } finally {
      view.close();
    }
    const walking = index.walking;
    if (!result.more && index.building) {
      const embeds = index.meaning;
      index.finish();
      result.more = embeds;
    } else if (!result.more && index.meaning) {
      const model = index.vectorModel()!;
      const embedder = openEmbedder({ meaning: () => { const chosen = meaningModel(env.settings); return chosen === null ? null : { unit: chosen.unit, file: model }; }, drive: env.drive() });
      Object.assign(result, await embedPass(index, embedder, () => !late(), env.signal));
      result.compacted = index.compact().length;
      result.queued = index.queueLength();
    }
    if (walking) result.more = true;
    return result;
  } finally {
    index.close();
  }
}

export async function embedPass(index: ScreenIndex, embedder: Embedder, may: () => boolean, signal?: AbortSignal): Promise<Embedded> {
  const out: Embedded = { embedded: 0, dropped: 0, skipped: 0, waits: null, more: false };
  const model = index.vectorModel();
  if (model === null) return out;
  const embedded = async (batch: readonly { textHash: string; text: string }[]): Promise<{ landed: boolean } | { error: EmbedderError } | { stopped: true }> => {
    const asked = { model, generation: index.generation() };
    let vectors: Float32Array[];
    try {
      ({ vectors } = await embedder.embed(batch.map((each) => each.text), "document", signal));
    } catch (error) {
      if (signal?.aborted === true) return { stopped: true };
      if (!(error instanceof EmbedderError)) throw error;
      return { error };
    }
    if (signal?.aborted === true) return { stopped: true };
    const landed = index.land(asked, batch.map((each, at) => ({ textHash: each.textHash, vector: vectors[at]! })));
    out.embedded += landed.landed;
    out.dropped += landed.dropped;
    return { landed: landed.landed > 0 };
  };
  const waits = await (async (): Promise<EmbedWaits | null> => {
    for (;;) {
      const batch = index.queued(EMBED_TEXTS);
      if (batch.length === 0 || signal?.aborted === true) return null;
      if (!may()) {
        out.more = true;
        return null;
      }
      const admitted = await embedder.admits("document");
      if (!admitted.go) return waitsOfAdmission(admitted);
      const whole = await embedded(batch);
      if ("stopped" in whole) return null;
      if ("landed" in whole) {
        if (!whole.landed) return null;
        continue;
      }
      if (routes(whole.error.code)) return waitsOfError(whole.error);
      const failed: string[] = [];
      let any = false;
      let last = whole.error;
      for (const each of batch) {
        if (!may()) {
          out.more = true;
          return null;
        }
        const alone = await embedded([each]);
        if ("stopped" in alone) return null;
        if ("landed" in alone) {
          any = true;
          continue;
        }
        if (routes(alone.error.code)) return waitsOfError(alone.error);
        failed.push(each.textHash);
        last = alone.error;
      }
      if (!any) return waitsOfError(last);
      index.skip(failed);
      out.skipped += failed.length;
    }
  })();
  out.waits = waits?.waits ?? null;
  if (signal?.aborted !== true) index.setWaits(waits);
  return out;
}

function frameStart(view: OpenView, source: string, key: string): number | undefined {
  const ref = { source, kind: "frame", key };
  const start = view.head(ref)?.start_ms;
  if (start !== undefined && start !== null) return start;
  for (const statement of view.history(ref).reverse()) {
    if (statement.version !== GONE) return view.version(statement.version).time?.start_ms ?? undefined;
  }
  return undefined;
}

function frameAfter(view: OpenView, machines: ReadonlyMap<string, string>, machine: string, end_ms: number): boolean {
  for (const [source, copy] of machines) {
    if (copy !== machine) continue;
    for (const head of view.heads(source, "frame", { start_ms: end_ms })) {
      if (head.start_ms !== null && head.start_ms >= end_ms) return true;
    }
    for (const head of view.heads(source, "recorder", { start_ms: end_ms })) {
      if ((head.end_ms ?? head.start_ms ?? Number.NEGATIVE_INFINITY) >= end_ms) return true;
    }
  }
  return false;
}

export function closesAt(open: Iterable<{ bucket: number }>, now: number): number | null {
  let first: number | null = null;
  for (const { bucket } of open) {
    const end = bucket + SEGMENT_MS;
    const at = end > now ? end : end + GRACE_MS;
    if (first === null || at < first) first = at;
  }
  return first;
}

export const SCREEN_INDEX: Index<ScreenResult> = {
  name: "screen",
  fileOf: (root, machine) => screenFileOf(searchFileOf(root, machine)),
  take: screenRun,
  settled(result) {
    const { more, closes_ms, ...counts } = result;
    const worked = counts.walked > 0 || counts.statements > 0 || counts.appended > 0 || counts.rebuilt > 0 || counts.embedded > 0 || counts.skipped > 0 || counts.compacted > 0;
    return {
      more,
      again_in_ms: !more && counts.waits !== null && counts.queued > 0 ? EMBED_AGAIN_MS : null,
      again_at_ms: more ? null : closes_ms,
      counts: worked ? { ...counts } : null,
    };
  },
  unmarked: (folder, machine) => screenQueue(folder, SCREEN_INDEX.fileOf(folder.root, machine)),
  state(folder, file, of) {
    try {
      return screenState(folder, screenStanding(folder, file), file, of);
    } catch {
      return null;
    }
  },
  build: (tx, now_ms) => tx.tables.cursors.reset("screen", null, now_ms),
  forget(on, records) {
    const roles = screenRoles(on.families);
    if (roles === undefined) return;
    const db = openHome(on.folder, "read");
    try {
      const view = db.view();
      try {
        const stretches = erasedStretches(view, roles, records);
        if (stretches.length === 0) return;
        on.forgetMarks(erasedTexts(view, roles, on.blobs, on.settings.screen_cutover_ms, stretches, records));
        const source = new ViewScreenSource(withoutRecords(view, records), roles, on.blobs, on.settings.screen_cutover_ms, on.settings.day);
        on.kept.push(...ScreenIndex.erase(on.folder, SCREEN_INDEX.fileOf(on.folder.root, on.machine), stretches, source, on.forgetMarks, on.wait_ms));
      } finally {
        view.close();
      }
    } finally {
      db.close();
    }
  },
};

export function screenState(folder: HomeFolder, standing: ScreenStanding | undefined, file: string, of: number): IndexState {
  const at = (standing?.position ?? null) as ScreenPosition | null;
  const seq = at?.seq ?? 0;
  return { seq, behind: Math.max(0, of - seq), building: screenBuilding(folder, file, of), bytes: standing?.bytes ?? 0 };
}

export function screenBuilding(folder: HomeFolder, file: string, of: number, waitMs?: number): IndexState["building"] {
  const build = screenProgress(folder, file, waitMs);
  return build === undefined ? null : { done: build.read, of };
}
