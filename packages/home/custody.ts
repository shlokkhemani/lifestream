import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type Database from "better-sqlite3";
import type { Connector, RefusedStation } from "@lifestreamprotocol/connect";
import { GENERATION, readTables, RELEASE, roomAt, sourceName, type HomeFolder, type JsonObject, type StoreKind } from "@lifestreamprotocol/core";
import { catalogOf, switchOf } from "./catalog.js";
import { deviceSettings, shownNeeds, skipKey } from "./connectors.js";
import { DEVICES, ownerSource, type Floors } from "./devices.js";
import { failpoint } from "./failpoint.js";
import type { HomeClock } from "./home-clock.js";
import type { HomeFile } from "./home-file.js";
import { historyGate } from "./jobs.js";
import { type Custody as Stated, deliveriesOf, deliveryDirectory, type DoorStamp, lanes as inboxLanes, MANIFEST_FORMAT, readSealed, type Received, type Stated as SourceSeal, timestampMs } from "./inbox.js";
import { readHome } from "./lifecycle.js";
import { deviceOf, readPrincipals, replacedAt, type Principal, type Reach } from "./principals.js";
import { BUSY_WORDS, type Readers } from "./readers.js";
import { notNowRefusal, notReadable, Refusal, refuse, RETRY_S } from "./refusal.js";
import { mobileDataOf, type Settings } from "./settings.js";
import type { Stated as Statements } from "./stated.js";
import { needs, type Need, type StatusOptions } from "./status.js";
import type { ExchangeAnswerAdds } from "./wire.js";
import { declaredStores } from "./stores.js";


const RUN = randomBytes(8).toString("hex");
let answered = 0;
export const REFRESH_ASKED_MS = 2 * 60_000;
export const CLOCK_AHEAD_MS = 10 * 60_000;
const CACHE = "custody.db";
const CACHE_SHAPE = 2;

export interface Sealable {
  readonly lane: string;
  readonly name: string;
  readonly custody: Stated | undefined;
  readonly only?: string;
  readonly carried: readonly string[];
  readonly quiet: readonly string[];
  readonly stated_ms: number;
  write(stamp: DoorStamp): Promise<void>;
}

export interface Custody {
  answer(pass: Principal, reach: Reach): Promise<JsonObject>;
  pairing(pass: Principal, reach: Reach): Promise<JsonObject>;
  needs(): Promise<Need[]>;
  delivers(pass: Principal): string[];
  replaced(pass: Principal): boolean;
  throughOf(source: string): Readonly<Record<string, number>>;
  seal(pass: Principal, reach: Reach, delivery: Sealable): Promise<void>;
  importing(sources: readonly string[]): Promise<string[]>;
  readPoints(unit: string, sources: readonly string[]): Promise<Record<string, ReadPoint | null>>;
  askRefresh(connector: string, asking: string | null): string[];
  asked(): { unit: string; source: string }[];
  close(): void;
}

export interface ReadPoint {
  readonly at_ms: number;
  readonly types: readonly string[] | null;
}

export interface Serving {
  readonly readers: Pick<Readers, "read" | "deadline">;
  readonly connectors: readonly Connector[];
  readonly settings: () => Settings;
  readonly clock: HomeClock;
  readonly refused: () => readonly RefusedStation[];
}

export interface CustodyOptions {
  readonly folder: string;
  readonly home: HomeFile;
  readonly clock: () => number;
  readonly floors: Floors;
  readonly serving: () => Serving;
  readonly where: () => string[];
  readonly log: (line: JsonObject) => void;
  readonly stated: () => Statements;
  readonly timed?: <T>(name: string, work: () => T) => T;
}

export interface AnswerAsk {
  readonly pass: string;
  readonly unit: string;
  readonly sources: readonly string[];
  readonly reach: Reach;
  readonly applying: readonly string[];
  readonly device: boolean;
  readonly found: string | null;
  readonly now_ms: number;
  readonly stated: Statements;
  readonly refused: readonly RefusedStation[];
}

export interface AnswerRead {
  readonly imported: number[];
  readonly history: boolean[];
  readonly retired: number | null;
  readonly needs: Need[];
  readonly waits: boolean;
}

export interface NeedsAsk {
  readonly now_ms: number;
  readonly stated: Statements;
  readonly refused: readonly RefusedStation[];
}

export interface NeedsContext {
  readonly folder: HomeFolder;
  readonly settings: Settings;
  readonly connectors: readonly Connector[];
  readonly families: StatusOptions["families"];
}

export function openCustody(options: CustodyOptions): Custody {
  const { folder, home, clock, floors, serving, where, stated, log } = options;
  const readers = { read: <T>(...asked: Parameters<Readers["read"]>) => serving().readers.read<T>(...asked), deadline: (name: string) => serving().readers.deadline(name) };
  const settings = (): Settings => serving().settings();
  const refused = (): readonly RefusedStation[] => serving().refused();
  const sync = <T>(work: () => T): T => (options.timed === undefined ? work() : options.timed("custody.db", work));
  let declaredOf: { of: readonly Connector[]; declared: ReturnType<typeof declaredStores> } | null = null;
  const declaredNow = (): ReturnType<typeof declaredStores> => {
    const { connectors } = serving();
    if (declaredOf?.of !== connectors) declaredOf = { of: connectors, declared: declaredStores(connectors) };
    return declaredOf.declared;
  };
  const cache = openSeals(home.folder, join(folder, "door", CACHE));
  try {
    const started = performance.now();
    const rebuilt = reconcile(home.folder, cache);
    sealFloors(cache, home);
    log({ custody: "rebuilt", ms: Math.round(performance.now() - started), ...rebuilt });
  } catch (error) {
    cache.close();
    throw error;
  }
  const insertSealed = cache.prepare("INSERT OR REPLACE INTO sealed (lane, name, sealed_ms) VALUES (?, ?, ?)");
  const insertSeal = sealInsert(cache);
  const heads = headsOf(cache);
  const receivedOf = cache.prepare("SELECT seal FROM received WHERE source = ? AND pass = ?").pluck();
  const passesOf = cache.prepare("SELECT pass, seal AS received FROM received WHERE source = ?");
  const newestOf = cache.prepare("SELECT max(sealed_ms) FROM sealed INDEXED BY sealed_newest WHERE lane = ?").pluck();
  const firstSealed = cache.prepare("SELECT sealed_ms FROM first WHERE pass = ?").pluck();
  const principals = home.folder;
  const stamps = new Map<string, number>();
  const turns = new Map<string, Promise<void>>();

  const presses = new Map<string, { unit: string; asked_ms: number; carried: boolean }>();
  const live = (): [string, { unit: string; asked_ms: number; carried: boolean }][] => {
    const now = clock();
    for (const [source, stamp] of presses) if (now - stamp.asked_ms >= REFRESH_ASKED_MS) presses.delete(source);
    return [...presses].sort(([a], [b]) => a.localeCompare(b));
  };
  const received = (pass: string, source: string): number => (receivedOf.get(source, pass) as number | undefined) ?? 0;
  const throughOf = (source: string): Record<string, number> =>
    Object.fromEntries((passesOf.all(source) as { pass: string; received: number }[]).map(({ pass, received }) => [pass, received]));
  const sealedAt = (id: string) => (firstSealed.get(id) as number | undefined) ?? null;

  const importedOf = async (pairs: readonly { pass: string; source: string }[]): Promise<number[] | null> => {
    try {
      return await readers.read<number[] | null>({ imported: pairs.map(({ pass, source }) => [pass, source] as const) });
    } catch (error) {
      if (error instanceof Refusal) throw error;
      return notReadable(error);
    }
  };

  const delivers = (pass: Principal): string[] => {
    const off = switchOf(serving().connectors, settings().sources.off);
    if (off.unit(pass.unit)) return [];
    return pass.sources.filter((source) => isSource(source) && !off.source({ id: source })).sort();
  };

  const build = async (pass: Principal, reach: Reach, signal: AbortSignal): Promise<JsonObject> => {
    const before = sync(() => {
      const device = deviceOf(pass);
      const now = clock();
      const passes = readPrincipals(principals).principals;
      const on = delivers(pass);
      const owner = on.filter((source) => ownerSource(source, settings().unit) !== null);
      const held = on.filter((source) => !owner.includes(source)).map((source) => ({ source, received: received(pass.id, source) }));
      const applying = pass.sources.filter((source) => isSource(source) && ownerSource(source, settings().unit) === null);
      const mayWait = pass.kind === "mac" && !passes.some((each) => each.unit === pass.unit && sealedAt(each.id) !== null);
      const statements = stated();
      const asked: AnswerAsk = {
        pass: pass.id, unit: pass.unit, sources: held.map(({ source }) => source), reach, applying, device: pass.kind !== null,
        found: mayWait ? skipKey(pass.unit, "found") : null, now_ms: now, stated: statements, refused: refused(),
      };
      return { device, now, passes, owner, held, applying, statements, asked };
    });
    let read: AnswerRead;
    try {
      read = await readers.read<AnswerRead>({ answer: before.asked }, { signal });
    } catch (error) {
      if (error instanceof Refusal) throw error;
      notReadable(error);
    }
    return sync(() => {
      const { device, now, passes, owner, held, applying, statements } = before;
      const formats = [...(device === null ? [MANIFEST_FORMAT] : DEVICES[device].formats)];
      const own = statements[pass.unit];
      const declared = declaredNow();
      const stores = pass.kind === "mac" && (own?.pass !== pass.id || own.stores?.digest !== declared.digest) ? declared.stores : null;
      const sources: JsonObject = {};
      if (!read.waits) held.forEach(({ source, received }, index) => { sources[source] = { received, imported: Math.min(read.imported[index]!, received), formats, history: read.history[index]! }; });
      const replaced_ms = replacedAt(pass, passes, sealedAt, read.retired);
      const mine = pass.kind === "mac" ? live().filter(([, stamp]) => stamp.unit === pass.unit) : [];
      for (const [, stamp] of mine) stamp.carried = true;
      const adds: ExchangeAnswerAdds = {
        ...(mine.length === 0 ? {} : { refresh: Object.fromEntries(mine.map(([source, stamp]) => [source, stamp.asked_ms])) }),
        ...(stores === null ? {} : { stores }),
      };
      const applied = device === null ? {} : deviceSettings(serving().connectors, settings(), device, applying, now);
      return {
        home: { id: readHome(folder).id, version: RELEASE, generation: GENERATION, floors: { ...floors } }, clock: serving().clock.id, pass: pass.id, unit: pass.unit, sources, owner, needs: read.needs, calls: [], settings: applied,
        ...(pass.account === null ? {} : { account: pass.account }),
        ...(replaced_ms === null ? {} : { replaced: new Date(replaced_ms).toISOString() }),
        ...(pass.kind === "phone" ? { addresses: where() } : {}),
        ...(device === null ? {} : { mobile_data: mobileDataOf(settings(), pass.unit) }),
        ...adds as JsonObject,
        turn: { run: RUN, n: ++answered },
      };
    });
  };

  const askRefresh = (connector: string, asking: string | null): string[] => {
    const catalog = catalogOf(serving().connectors);
    const asked = new Set<string>();
    for (const pass of readPrincipals(principals).principals) {
      if (pass.kind !== "mac" || pass.revoked_at !== null || pass.unit === asking) continue;
      const sources = delivers(pass).filter((source) => ownerSource(source, settings().unit) === null && catalog.delivered("mac", source)?.id === connector);
      for (const source of sources) presses.set(source, { unit: pass.unit, asked_ms: clock(), carried: false });
      if (sources.length > 0) asked.add(pass.unit);
    }
    return [...asked].sort();
  };

  const asked = (): { unit: string; source: string }[] => live().filter(([, stamp]) => !stamp.carried).map(([source, stamp]) => ({ unit: stamp.unit, source }));

  const seal = async (pass: Principal, reach: Reach, delivery: Sealable): Promise<void> => {
    const stated = delivery.custody;
    const named = Object.keys(stated ?? {});
    const on = sync(() => {
      const owner = ownerSource(delivery.lane, settings().unit) !== null;
      if (delivery.only !== undefined && named.some((source) => source !== delivery.only)) {
        refuse(422, "CUSTODY_MISSING", `a bundle of ${delivery.only} states the custody of ${delivery.only} alone`);
      }
      const on = new Set(delivers(pass));
      const outside = named.find((source) => !on.has(source));
      if (outside !== undefined) refuse(403, "PRINCIPAL_SCOPE", `pass ${pass.id} does not deliver ${outside}`);
      const unnamed = pass.kind === null || owner ? undefined : delivery.carried.find((source) => stated?.[source] === undefined);
      if (unnamed !== undefined) refuse(422, "CUSTODY_MISSING", `the bundle carries data of ${unnamed}, and its custody states no seal of it`);
      if (delivery.stated_ms > clock() + CLOCK_AHEAD_MS) {
        refuse(422, "CLOCK_AHEAD", `the bundle is stated at ${new Date(delivery.stated_ms).toISOString()}, more than ten minutes past the home's clock (${new Date(clock()).toISOString()}): this device's clock is ahead`);
      }
      return on;
    });
    const previous = turns.get(delivery.lane) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => turn);
    turns.set(delivery.lane, queued);
    await previous;
    try {
      const stale = sync(() => named.filter((source) => stated![source]!.seal !== received(pass.id, source) + 1)
        .map((source) => `${source} states seal ${stated![source]!.seal}; the home has received ${received(pass.id, source)}`));
      if (stale.length > 0) refuse(409, "STALE", `${stale.join("; ")}: seal again from the answer`, undefined, { answer: await answer(pass, reach) });
      const { sealed_ms, quiet, through } = sync(() => {
        const sealed_ms = Math.max(clock(), (stamps.get(delivery.lane) ?? (newestOf.get(delivery.lane) as number | null) ?? -Infinity) + 1);
        const quiet = replaced(pass) ? [] : delivery.quiet.filter((source) => on.has(source));
        const through: Received = Object.fromEntries(quiet.map((source) => [source, throughOf(source)]));
        return { sealed_ms, quiet, through };
      });
      await delivery.write({
        pass: pass.id, sealed_at: new Date(sealed_ms).toISOString(), ...(stated === undefined ? {} : { custody: stated }),
        ...(quiet.length === 0 ? {} : { received: through }),
      });
      stamps.set(delivery.lane, sealed_ms);
      failpoint("door.sealed");
      sync(() => cache.transaction(() => {
        insertSealed.run(delivery.lane, delivery.name, sealed_ms);
        for (const source of named) insertSeal(delivery.lane, delivery.name, source, pass.id, stated![source]!);
        heads.sealed(pass.id, sealed_ms, named.map((source) => [source, stated![source]!.seal]));
      })());
    } finally {
      release();
      if (turns.get(delivery.lane) === queued) turns.delete(delivery.lane);
    }
  };

  const importing = async (sources: readonly string[]): Promise<string[]> => {
    const seals = sync(() => sources.flatMap((source) => (passesOf.all(source) as { pass: string; received: number }[]).map((seal) => ({ ...seal, source }))));
    if (seals.length === 0) return [];
    const kept = await importedOf(seals);
    const behind = new Set(seals.filter(({ received }, index) => kept === null || kept[index]! < received).map(({ source }) => source));
    return sources.filter((source) => behind.has(source));
  };

  const pointOf = cache.prepare(`SELECT history_through_ms AS at_ms, types FROM seals INDEXED BY seals_read
    WHERE pass = ? AND source = ? AND history_through_ms IS NOT NULL AND seal <= ? ORDER BY history_through_ms DESC LIMIT 1`);
  const readPoints = async (unit: string, sources: readonly string[]): Promise<Record<string, ReadPoint | null>> => {
    const seals = sync(() => {
      const own = new Set(readPrincipals(principals).principals.filter((row) => row.unit === unit).map((row) => row.id));
      return sources.flatMap((source) => (passesOf.all(source) as { pass: string; received: number }[]).filter(({ pass }) => own.has(pass)).map((seal) => ({ ...seal, source })));
    });
    const kept = seals.length === 0 ? [] : await importedOf(seals) ?? [];
    const points: Record<string, ReadPoint | null> = Object.fromEntries(sources.map((source) => [source, null]));
    sync(() => seals.forEach(({ pass, source, received }, index) => {
      const imported = kept[index];
      if (imported === undefined) return;
      const row = pointOf.get(pass, source, Math.min(imported, received)) as { at_ms: number; types: string | null } | undefined;
      const newest = points[source];
      if (row !== undefined && (newest == null || row.at_ms > newest.at_ms)) points[source] = { at_ms: row.at_ms, types: row.types === null ? null : JSON.parse(row.types) as string[] };
    }));
    return points;
  };

  const needsFor = (): Promise<Need[]> => readers.read<Need[]>({ needs: { now_ms: clock(), stated: stated(), refused: refused() } });

  const replaced = (pass: Principal): boolean =>
    replacedAt(pass, readPrincipals(principals).principals, sealedAt, pass.retired_at === undefined ? null : Date.parse(pass.retired_at)) !== null;

  let answering: Promise<unknown> = Promise.resolve();
  const answer = (pass: Principal, reach: Reach): Promise<JsonObject> => {
    const due = readers.deadline("custody answer");
    const late = new AbortController();
    void due.reached.then(() => late.abort(notNowRefusal("busy", BUSY_WORDS, RETRY_S)));
    const ahead = answering;
    const next = (async () => {
      await Promise.race([ahead, new Promise<void>((resolve) => late.signal.addEventListener("abort", () => resolve(), { once: true }))]);
      late.signal.throwIfAborted();
      return build(pass, reach, late.signal);
    })().finally(() => due.end());
    answering = Promise.allSettled([ahead, next]);
    return next;
  };

  const pairing = async (pass: Principal, reach: Reach): Promise<JsonObject> => ({
    ...await answer(pass, reach),
    ...(home.folder.form === "keyed" ? { keyed: true } : {}),
  });

  return {
    answer, pairing, needs: needsFor, seal, importing, readPoints,
    delivers: (pass) => sync(() => delivers(pass)),
    replaced: (pass) => sync(() => replaced(pass)),
    throughOf: (source) => sync(() => throughOf(source)),
    askRefresh: (connector, asking) => sync(() => askRefresh(connector, asking)),
    asked: () => sync(asked),
    close: () => sync(() => cache.close()),
  };
}

export function readAnswer(home: HomeFile, ask: AnswerAsk, context: NeedsContext): AnswerRead {
  const needsOf = (db: Database.Database | null): Need[] => ask.device ? needsWith(db, ask, context) : [];
  const historyOf = (db: Database.Database | null): boolean[] => {
    const catalog = catalogOf(context.connectors);
    const gate = historyGate(db === null ? null : readTables(db), ask.stated, roomAt(context.folder.root));
    const row = db?.prepare("SELECT connector, options FROM sources WHERE id = ?");
    return ask.sources.map((source) => {
      const stored = row?.get(source) as { connector: string; options: string } | undefined;
      const connector = catalog.of(stored === undefined ? { id: source } : { id: source, connector: stored.connector, options: JSON.parse(stored.options) as JsonObject });
      return gate.may(connector?.id ?? null, ask.reach);
    });
  };
  return home.read((db) => {
    db.exec("BEGIN");
    try {
      const kept = keptOf(db);
      const retiredAt = db.prepare("SELECT retired_ms FROM devices WHERE unit = ?").pluck();
      return {
        imported: ask.sources.map((source) => kept(ask.pass, source)),
        history: historyOf(db),
        retired: ask.device ? (retiredAt.get(ask.unit) as number | null | undefined) ?? null : null,
        needs: needsOf(db),
        waits: ask.found !== null && db.prepare("SELECT 1 FROM meta WHERE key = ?").get(ask.found) === undefined,
      };
    } finally {
      db.exec("COMMIT");
    }
  }) ?? { imported: ask.sources.map(() => 0), history: historyOf(null), retired: null, needs: needsOf(null), waits: false };
}

export function readNeeds(home: HomeFile, ask: NeedsAsk, context: NeedsContext): Need[] {
  return home.read((db) => needsWith(db, ask, context)) ?? needsWith(null, ask, context);
}

export function readImported(home: HomeFile, pairs: readonly (readonly [pass: string, source: string])[]): number[] | null {
  return home.read((db) => {
    const kept = keptOf(db);
    return pairs.map(([pass, source]) => kept(pass, source));
  }) ?? null;
}

function needsWith(db: Database.Database | null, ask: NeedsAsk, context: NeedsContext): Need[] {
  return shownNeeds(needs(db, { folder: context.folder, now_ms: ask.now_ms, settings: context.settings, connectors: context.connectors, families: context.families, ledger: null, stated: ask.stated, refused: ask.refused }));
}

function keptOf(db: Database.Database): (pass: string, source: string) => number {
  const row = db.prepare("SELECT imported FROM custody WHERE pass = ? AND source = ?").pluck();
  return (pass, source) => (row.get(pass, source) as number | undefined) ?? 0;
}

export const CUSTODY_STORE: StoreKind = { role: "custody", remade: true };

function openSeals(folder: HomeFolder, path: string): Database.Database {
  const open = (): Database.Database => {
    const db = folder.store(CUSTODY_STORE, path, { sync: "NORMAL" });
    if (db.pragma("integrity_check(1)", { simple: true }) !== "ok") {
      db.close();
      throw new Error(`${path} fails its integrity check`);
    }
    if ((db.pragma("user_version", { simple: true }) as number) !== CACHE_SHAPE) {
      db.exec("DROP TABLE IF EXISTS sealed; DROP TABLE IF EXISTS seals; DROP TABLE IF EXISTS first; DROP TABLE IF EXISTS received;");
      db.pragma(`user_version = ${CACHE_SHAPE}`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS sealed (lane TEXT NOT NULL, name TEXT NOT NULL, sealed_ms INTEGER NOT NULL, PRIMARY KEY (lane, name)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS seals (lane TEXT NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL, pass TEXT NOT NULL, seal INTEGER NOT NULL,
        history_through_ms INTEGER, types TEXT, PRIMARY KEY (lane, name, source)) WITHOUT ROWID;
      DROP INDEX IF EXISTS seals_received;
      CREATE INDEX IF NOT EXISTS sealed_newest ON sealed (lane, sealed_ms);
      CREATE INDEX IF NOT EXISTS seals_read ON seals (pass, source, history_through_ms, seal) WHERE history_through_ms IS NOT NULL;
      CREATE TABLE IF NOT EXISTS first (pass TEXT NOT NULL PRIMARY KEY, sealed_ms INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS received (source TEXT NOT NULL, pass TEXT NOT NULL, seal INTEGER NOT NULL, PRIMARY KEY (source, pass)) WITHOUT ROWID;`);
    return db;
  };
  try {
    return open();
  } catch {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    return open();
  }
}

function reconcile(folder: HomeFolder, cache: Database.Database): { lanes: number; manifests_read: number } {
  const lanes = inboxLanes(folder, { required: true });
  const known = cache.prepare("SELECT name FROM sealed WHERE lane = ?").pluck();
  const forget = cache.prepare("DELETE FROM sealed WHERE lane = ? AND name = ?");
  const forgetSeals = cache.prepare("DELETE FROM seals WHERE lane = ? AND name = ?");
  const insertSealed = cache.prepare("INSERT OR REPLACE INTO sealed (lane, name, sealed_ms) VALUES (?, ?, ?)");
  const insertSeal = sealInsert(cache);
  const heads = headsOf(cache);
  let read = 0;
  cache.transaction(() => {
    const held = new Set(lanes);
    for (const lane of cache.prepare("SELECT DISTINCT lane FROM sealed").pluck().all() as string[]) {
      if (held.has(lane)) continue;
      cache.prepare("DELETE FROM sealed WHERE lane = ?").run(lane);
      cache.prepare("DELETE FROM seals WHERE lane = ?").run(lane);
    }
    for (const lane of lanes) {
      const names = new Set(deliveriesOf(folder, lane));
      for (const name of known.all(lane) as string[]) {
        if (names.delete(name)) continue;
        forget.run(lane, name);
        forgetSeals.run(lane, name);
      }
      for (const name of names) {
        let manifest;
        read++;
        try {
          manifest = readSealed(folder, deliveryDirectory(folder, lane, name));
        } catch {
          continue;
        }
        if (manifest === null) continue;
        insertSealed.run(lane, name, timestampMs(manifest.sealed_at ?? manifest.fetched_at));
        if (manifest.pass === undefined) continue;
        for (const [source, stated] of Object.entries(manifest.custody ?? {})) insertSeal(lane, name, source, manifest.pass, stated);
      }
    }
    heads.found();
  })();
  return { lanes: lanes.length, manifests_read: read };
}

function sealFloors(cache: Database.Database, home: HomeFile): void {
  const highest = home.read((db) => {
    const next = db.prepare(`SELECT pass, source FROM deliveries INDEXED BY deliveries_seal
      WHERE seal IS NOT NULL AND (pass, source, seal) > (?, ?, ?) ORDER BY pass, source, seal LIMIT 1`);
    const top = db.prepare("SELECT max(seal) FROM deliveries INDEXED BY deliveries_seal WHERE pass = ? AND source = ? AND seal IS NOT NULL").pluck();
    const found: [string, string, number][] = [];
    for (let at = next.get("", "", 0) as { pass: string; source: string } | undefined; at !== undefined; ) {
      const seal = top.get(at.pass, at.source) as number;
      found.push([at.source, at.pass, seal]);
      at = next.get(at.pass, at.source, seal) as typeof at;
    }
    return found;
  }) ?? [];
  const raise = cache.prepare("INSERT INTO received (source, pass, seal) VALUES (?, ?, ?) ON CONFLICT (source, pass) DO UPDATE SET seal = max(seal, excluded.seal)");
  cache.transaction(() => {
    for (const row of highest) raise.run(...row);
  })();
}

function headsOf(cache: Database.Database): { sealed(pass: string, sealed_ms: number, seals: readonly [string, number][]): void; found(): void } {
  const first = cache.prepare("INSERT INTO first (pass, sealed_ms) VALUES (?, ?) ON CONFLICT (pass) DO UPDATE SET sealed_ms = min(sealed_ms, excluded.sealed_ms)");
  const received = cache.prepare("INSERT INTO received (source, pass, seal) VALUES (?, ?, ?) ON CONFLICT (source, pass) DO UPDATE SET seal = max(seal, excluded.seal)");
  return {
    sealed(pass, sealed_ms, seals) {
      if (seals.length > 0) first.run(pass, sealed_ms);
      for (const [source, seal] of seals) received.run(source, pass, seal);
    },
    found() {
      cache.exec(`DELETE FROM first;
        INSERT INTO first (pass, sealed_ms) SELECT s.pass, min(d.sealed_ms) FROM seals s JOIN sealed d ON d.lane = s.lane AND d.name = s.name GROUP BY s.pass;
        DELETE FROM received;
        INSERT INTO received (source, pass, seal) SELECT source, pass, max(seal) FROM seals GROUP BY source, pass;`);
    },
  };
}

function sealInsert(cache: Database.Database): (lane: string, name: string, source: string, pass: string, stated: SourceSeal) => void {
  const insert = cache.prepare("INSERT OR REPLACE INTO seals (lane, name, source, pass, seal, history_through_ms, types) VALUES (?, ?, ?, ?, ?, ?, ?)");
  return (lane, name, source, pass, stated) => {
    insert.run(lane, name, source, pass, stated.seal, stated.history_through === undefined ? null : Date.parse(stated.history_through),
      stated.types === undefined ? null : JSON.stringify(stated.types));
  };
}

function isSource(id: string): boolean {
  try {
    sourceName(id);
    return true;
  } catch {
    return false;
  }
}
