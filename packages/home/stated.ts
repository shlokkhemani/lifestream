import { join } from "node:path";
import { canonical, isObject, sourceName, textHead, type HomeFolder, type Json, type Room, type StoreKind } from "@lifestreamprotocol/core";
import { readPrincipals, type Principal } from "./principals.js";
import { refuse } from "./refusal.js";
import { ask, type HomeSocket } from "./socket.js";
import type { StoresStated } from "./stores.js";
import { monthsIn, type Value } from "./through.js";

export const ALLOWED = ["on", "limited", "off", "not-now", "not-asked", "asked", "asking"] as const;
export type Allowed = (typeof ALLOWED)[number];
export type Grants = Readonly<Record<string, Allowed>>;
export type Applies = Readonly<Record<string, Readonly<Record<string, Json>>>>;
export type SendFailure = {
  readonly since_ms: number;
  readonly code: string;
  readonly message: string;
};
export type Sending = {
  readonly sources?: Readonly<Record<string, SendFailure>>;
  readonly send?: SendFailure;
};
export type MacImportFile = {
  readonly id: string;
  readonly name: string;
  readonly bytes: number;
  readonly state: "checking" | "refused" | "waiting" | "sending" | "already" | "sent" | "missing";
  readonly why: "damaged" | "not-this-kind" | "nothing-read" | "too-large" | "turn" | "mac-room" | "home-room" | "battery" | null;
  readonly sha256: string | null;
  readonly seal: number | null;
  readonly pass: string | null;
  readonly sent_bytes: number | null;
};
export type MacImport = {
  readonly kind: string;
  readonly files: MacImportFile[];
};
const ROOMS: readonly Room[] = ["ok", "low", "full"];
export const NETWORKS = ["all", "now", "small", "low-data"] as const;
export type Network = (typeof NETWORKS)[number];
export const CAUSES = ["disk", "permission", "browser", "capture", "away", "private"] as const;
export type Cause = (typeof CAUSES)[number];
export const RECORDER_STATES = ["recording", "starting", "paused"] as const;
export type RecorderState = (typeof RECORDER_STATES)[number];
export type Recorder =
  | { readonly state: RecorderState }
  | { readonly state: "interrupted"; readonly cause: Cause };
export function recorderOf(statements: readonly Statement[], now_ms: number): Since<Recorder> | null {
  const heard = statements.filter((own) => own.recorder !== null && now_ms - own.heard_ms <= RECORDER_HEARD_MS);
  return heard.reduce<Statement | null>((newest, own) => (newest === null || own.heard_ms > newest.heard_ms ? own : newest), null)?.recorder ?? null;
}
export type Since<T> = { readonly value: T; readonly since_ms: number };

export type Statement = {
  readonly pass: string;
  readonly grants: Grants | null;
  readonly found: string[] | null;
  readonly imports: MacImport[] | null;
  readonly settings: Applies | null;
  readonly sending: Sending;
  readonly room: Since<Room> | null;
  readonly network: Since<Network> | null;
  readonly recorder: Since<Recorder> | null;
  readonly stores: StoresStated | null;
  readonly heard_ms: number;
  readonly waiting_since_ms: number | null;
};
export type Stated = Readonly<Record<string, Statement>>;

export const STATED_ROUTE = "/v1/stated";
const ASKING_MS = 2 * 60_000;
const HEARD_MS = 60_000;
const MAC_KNOCK_MS = 60_000;
const RECORDER_HEARD_MS = MAC_KNOCK_MS + HEARD_MS + MAC_KNOCK_MS;
const RECORDER_MS = 60_000;
const SHAPE = 5;
export const SENDING_MS = 60 * 60_000;
const GRANT = /^[a-z][A-Za-z-]{0,63}$/u;
const MAX_GRANTS = 64;
const CONNECTOR = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const MEMBER = /^[a-z][a-z0-9_]{0,63}$/u;
const MAX_CONNECTORS = 128;
const MAX_FAILING = 128;
const NAME_CHARS = 255;
const MAX_MEMBERS = 64;
const CODE_CHARS = 64;
const MESSAGE_CHARS = 1_000;
const TELL_MS = 30_000;
const NONE = canonical({});

export type Said = {
  grants?: Grants | undefined; found?: readonly string[] | undefined; imports?: readonly MacImport[] | undefined; settings?: Applies | undefined; sending: Sending;
  room?: Room | undefined; network?: Network | undefined; recorder?: Recorder | undefined; stores?: StoresStated | undefined;
};

export interface StatedStore {
  heard(pass: Principal): void;
  delivered(pass: Principal): void;
  exchange(pass: Principal, said: Said | undefined): void;
  held(): Stated;
  close(): void;
}

export const STATED_STORE: StoreKind = { role: "stated", remade: true };

export function openStated(folder: HomeFolder, socket: HomeSocket, clock: () => number, log: (line: string) => void, replaced: (pass: Principal) => boolean,
  timed: <T>(name: string, work: () => T) => T = (_name, work) => work()): StatedStore {
  const sync = <T>(work: () => T): T => timed("stated.db", work);
  const db = folder.store(STATED_STORE, join(folder.root, "door", "stated.db"), { sync: "NORMAL" });
  if ((db.pragma("user_version", { simple: true }) as number) !== SHAPE) {
    db.exec("DROP TABLE IF EXISTS stated");
    db.pragma(`user_version = ${SHAPE}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS stated (pass TEXT PRIMARY KEY, unit TEXT NOT NULL, grants TEXT, found TEXT, imports TEXT, settings TEXT, sending TEXT NOT NULL,
    room TEXT, network TEXT, recorder TEXT, stores TEXT, grants_ms INTEGER, room_ms INTEGER, network_ms INTEGER, recorder_ms INTEGER,
    at_ms INTEGER NOT NULL, told INTEGER NOT NULL, heard_ms INTEGER NOT NULL, waiting_since_ms INTEGER) WITHOUT ROWID`);
  const COLUMNS = "unit, grants, found, imports, settings, sending, room, network, recorder, stores, grants_ms, room_ms, network_ms, recorder_ms, at_ms, told, heard_ms, waiting_since_ms";
  const rowOf = db.prepare(`SELECT ${COLUMNS} FROM stated WHERE pass = ?`);
  const hear = db.prepare(`INSERT INTO stated (pass, unit, sending, at_ms, told, heard_ms, waiting_since_ms) VALUES (@pass, @unit, '${NONE}', 0, 1, @now, @now)
    ON CONFLICT (pass) DO UPDATE SET heard_ms = @now,
      waiting_since_ms = CASE WHEN waiting_since_ms IS NULL OR @now - heard_ms >= ${SENDING_MS} THEN @now ELSE waiting_since_ms END`);
  const put = db.prepare(`INSERT INTO stated (pass, unit, grants, found, imports, settings, sending, room, network, recorder, stores, grants_ms, room_ms, network_ms, recorder_ms, at_ms, told, heard_ms, waiting_since_ms)
    VALUES (@pass, @unit, @grants, @found, @imports, @settings, @sending, @room, @network, @recorder, @stores, @grants_ms, @room_ms, @network_ms, @recorder_ms, @at, 0, @at, @at)
    ON CONFLICT (pass) DO UPDATE SET grants = @grants, found = @found, imports = @imports, settings = @settings, sending = @sending, room = @room, network = @network,
      recorder = @recorder, stores = @stores, grants_ms = @grants_ms, room_ms = @room_ms, network_ms = @network_ms, recorder_ms = @recorder_ms, at_ms = @at, told = 0`);
  const clear = db.prepare("UPDATE stated SET waiting_since_ms = NULL WHERE pass = ?");
  const markTold = db.prepare("UPDATE stated SET told = 1 WHERE pass = ? AND at_ms = ?");
  const every = db.prepare(`SELECT pass, ${COLUMNS} FROM stated ORDER BY unit, at_ms DESC, heard_ms DESC, pass`);
  const drop = db.prepare("DELETE FROM stated WHERE pass = ?");
  const principals = folder;
  const telling = new Set<string>();
  const asked = new Map<string, number>();
  const quiet = new Set<string>();
  let closed = false;
  type Row = {
    unit: string; grants: string | null; found: string | null; imports: string | null; settings: string | null; sending: string; room: Room | null; network: string | null;
    recorder: string | null; stores: string | null; grants_ms: number | null; room_ms: number | null; network_ms: number | null; recorder_ms: number | null; at_ms: number; told: number; heard_ms: number;
    waiting_since_ms: number | null;
  };

  const tell = (pass: string): void => {
    const row = rowOf.get(pass) as Row | undefined;
    if (closed || telling.has(pass) || row === undefined || row.told === 1) return;
    if (quiet.has(pass) && clock() - (asked.get(pass) ?? -Infinity) < RECORDER_MS) return;
    quiet.delete(pass);
    asked.set(pass, clock());
    telling.add(pass);
    void ask(socket, { verb: "stated", unit: row.unit }, undefined, TELL_MS).then(() => {
      telling.delete(pass);
      if (closed) return;
      sync(() => {
        markTold.run(pass, row.at_ms);
        tell(pass);
      });
    }, (error: unknown) => {
      telling.delete(pass);
      log(JSON.stringify({ at: new Date(clock()).toISOString(), stated: row.unit, lost: (error as Error).message }));
    });
  };

  const store: StatedStore = {
    heard({ id, unit }) {
      const row = rowOf.get(id) as Row | undefined;
      const now = clock();
      if (row !== undefined && row.waiting_since_ms !== null && now - row.heard_ms < HEARD_MS) return;
      hear.run({ pass: id, unit, now });
    },
    delivered({ id }) {
      clear.run(id);
    },
    exchange({ id, unit }, said) {
      if (said !== undefined) {
        const own = rowOf.get(id) as Row | undefined;
        const grants = said.grants === undefined ? own?.grants ?? null : canonical({ ...said.grants });
        const found = said.found === undefined ? own?.found ?? null : canonical([...new Set(said.found)].sort());
        const imports = said.imports === undefined ? own?.imports ?? null : canonical(said.imports as unknown as Json);
        const settings = said.settings === undefined ? own?.settings ?? null : canonical(said.settings as Json);
        const sending = canonical(said.sending as Json);
        const room = said.room ?? own?.room ?? null;
        const network = said.network ?? own?.network ?? null;
        const recorder = said.recorder === undefined ? own?.recorder ?? null : canonical(said.recorder as unknown as Json);
        const stores = said.stores === undefined ? own?.stores ?? null : canonical(said.stores as unknown as Json);
        const others = own === undefined || grants !== own.grants || found !== own.found || imports !== own.imports || settings !== own.settings || sending !== own.sending
          || room !== own.room || network !== own.network || stores !== own.stores;
        if (others || recorder !== own.recorder) {
          const at = Math.max(clock(), (own?.at_ms ?? -Infinity) + 1);
          put.run({
            pass: id, unit, grants, found, imports, settings, sending, room, network, recorder, stores, at,
            grants_ms: own !== undefined && grants === own.grants ? own.grants_ms : at,
            room_ms: own !== undefined && room === own.room ? own.room_ms : at,
            network_ms: own !== undefined && network === own.network ? own.network_ms : at,
            recorder_ms: own !== undefined && recorder === own.recorder ? own.recorder_ms : at,
          });
          if (!others && (own!.told === 1 || quiet.has(id) || telling.has(id))) quiet.add(id);
          else quiet.delete(id);
        }
      }
      tell(id);
    },
    held() {
      const live = readPrincipals(principals).principals.filter((pass) => pass.revoked_at === null);
      const ids = new Set(live.map((pass) => pass.id));
      const rows = (every.all() as (Row & { pass: string })[]).filter((row) => {
        if (!ids.has(row.pass)) drop.run(row.pass);
        return ids.has(row.pass);
      });
      const holding = new Set(rows.map((row) => row.pass));
      const current = new Map<string, string>();
      for (const unit of new Set(rows.map((row) => row.unit))) {
        const newest = live.filter((pass) => pass.unit === unit && !replaced(pass))
          .reduce<Principal | undefined>((best, pass) => (best === undefined || Date.parse(pass.minted_at) > Date.parse(best.minted_at) ? pass : best), undefined);
        if (newest !== undefined && holding.has(newest.id)) current.set(unit, newest.id);
      }
      const now = clock();
      const held: Record<string, Statement> = {};
      for (const row of rows) {
        if (held[row.unit] !== undefined || (current.has(row.unit) && current.get(row.unit) !== row.pass)) continue;
        const asking = now - row.grants_ms! <= ASKING_MS;
        held[row.unit] = {
          pass: row.pass,
          grants: row.grants === null ? null : Object.fromEntries(Object.entries(JSON.parse(row.grants) as Grants).filter(([, state]) => state !== "asking" || asking)),
          found: row.found === null ? null : JSON.parse(row.found) as string[],
          imports: row.imports === null ? null : JSON.parse(row.imports) as MacImport[],
          settings: row.settings === null ? null : JSON.parse(row.settings) as Applies,
          sending: JSON.parse(row.sending) as Sending,
          room: row.room === null ? null : { value: row.room, since_ms: row.room_ms! },
          network: networkIn(row.network) === undefined ? null : { value: row.network as Network, since_ms: row.network_ms! },
          recorder: row.recorder === null ? null : { value: JSON.parse(row.recorder) as Recorder, since_ms: row.recorder_ms! },
          stores: row.stores === null ? null : JSON.parse(row.stores) as StoresStated,
          heard_ms: row.heard_ms,
          waiting_since_ms: row.waiting_since_ms,
        };
      }
      return held;
    },
    close() {
      closed = true;
      db.close();
    },
  };
  return {
    heard: (pass) => sync(() => store.heard(pass)),
    delivered: (pass) => sync(() => store.delivered(pass)),
    exchange: (pass, said) => sync(() => store.exchange(pass, said)),
    held: () => sync(() => store.held()),
    close: () => sync(() => store.close()),
  };
}

export function grantsIn(value: unknown): Grants | undefined {
  if (value === undefined) return undefined;
  const entries = typeof value === "object" && value !== null && !Array.isArray(value) ? Object.entries(value) : null;
  if (entries === null || entries.length > MAX_GRANTS || entries.some(([grant, state]) => !GRANT.test(grant) || !(ALLOWED as readonly unknown[]).includes(state))) {
    refuse(422, "BAD_REQUEST", `grants names each grant with its state: ${ALLOWED.join(", ")}`);
  }
  return value as Grants;
}

export function foundIn(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_CONNECTORS || value.some((id) => typeof id !== "string" || !CONNECTOR.test(id))) {
    refuse(422, "BAD_REQUEST", "found lists the Mac connectors whose source the Mac finds, each by its id");
  }
  return value as string[];
}

export function importsIn(value: unknown): readonly MacImport[] | undefined {
  if (value === undefined) return undefined;
  const bad = (): never => refuse(422, "BAD_REQUEST", "imports states per kind: kind and files, each file id, name, bytes, state, why, and sha256, seal and sent_bytes where known");
  const object = (stated: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> => {
    if (!isObject(stated as Json)) bad();
    const own = Object.keys(stated as object);
    if (!keys.every((key) => own.includes(key)) || !own.every((key) => keys.includes(key) || optional.includes(key))) bad();
    return stated as Record<string, unknown>;
  };
  const list = <T>(stated: unknown, each: (item: unknown) => T): T[] => (Array.isArray(stated) ? stated.map(each) : bad());
  const text = (stated: unknown): string => (typeof stated === "string" && stated !== "" && stated.length <= NAME_CHARS ? stated : bad());
  const whole = (stated: unknown): number => (typeof stated === "number" && Number.isSafeInteger(stated) && stated >= 0 ? stated : bad());
  const one = <T extends string>(stated: unknown, of: readonly T[]): T => ((of as readonly unknown[]).includes(stated) ? stated as T : bad());
  const STATES = ["checking", "refused", "waiting", "sending", "already", "sent", "missing"] as const;
  const WHYS = ["damaged", "not-this-kind", "nothing-read", "too-large", "turn", "mac-room", "home-room", "battery"] as const;
  return list(value, (stated) => {
    const kind = object(stated, ["kind", "files"]);
    return {
      kind: typeof kind.kind === "string" && CONNECTOR.test(kind.kind) ? kind.kind : bad(),
      files: list(kind.files, (file) => {
        const said = object(file, ["id", "name", "bytes", "state", "why"], ["sha256", "seal", "pass", "sent_bytes"]);
        const sha = said.sha256 === undefined ? undefined : typeof said.sha256 === "string" && /^[0-9a-f]{64}$/u.test(said.sha256) ? said.sha256 : bad();
        return {
          id: text(said.id), name: text(said.name), bytes: whole(said.bytes), state: one(said.state, STATES), why: said.why === null ? null : one(said.why, WHYS),
          sha256: sha ?? null, seal: said.seal === undefined ? null : whole(said.seal), pass: said.pass === undefined ? null : text(said.pass),
          sent_bytes: said.sent_bytes === undefined ? null : whole(said.sent_bytes),
        };
      }),
    };
  });
}

export function settingsIn(value: unknown): Applies | undefined {
  if (value === undefined) return undefined;
  const connectors = isObject(value as Json) ? Object.entries(value as Record<string, unknown>) : null;
  const good = connectors !== null && connectors.length <= MAX_CONNECTORS && connectors.every(([id, members]) => {
    const each = isObject(members as Json) ? Object.keys(members as object) : null;
    return CONNECTOR.test(id) && each !== null && each.length <= MAX_MEMBERS && each.every((member) => MEMBER.test(member));
  });
  if (!good) refuse(422, "BAD_REQUEST", "settings names each connector by its id, and each member it applies with its value");
  return value as Applies;
}

export function sendingIn(value: unknown): Sending {
  if (value === undefined) return {};
  const bad = (): never => refuse(422, "BAD_REQUEST", "sending states sources (per source id, {since_ms, code, message}) and send, each optional");
  const instant = (ms: unknown): number => (typeof ms === "number" && Number.isSafeInteger(ms) && ms >= 0 ? ms : bad());
  const failure = (stated: unknown): SendFailure => {
    if (!isObject(stated as Json)) return bad();
    const { since_ms, code, message, ...rest } = stated as Record<string, unknown>;
    if (Object.keys(rest).length > 0 || typeof code !== "string" || code === "" || typeof message !== "string") return bad();
    return { since_ms: instant(since_ms), code: textHead(code, CODE_CHARS), message: textHead(message, MESSAGE_CHARS) };
  };
  if (!isObject(value as Json)) return bad();
  const { sources, send, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) bad();
  const failing = sources === undefined ? [] : isObject(sources as Json) ? Object.entries(sources as Record<string, unknown>) : bad();
  if (failing.length > MAX_FAILING || failing.some(([id]) => !isSource(id))) bad();
  return {
    ...(failing.length === 0 ? {} : { sources: Object.fromEntries(failing.map(([id, stated]) => [id, failure(stated)])) }),
    ...(send === undefined ? {} : { send: failure(send) }),
  };
}

export function roomIn(value: unknown): Room | undefined {
  if (value === undefined) return undefined;
  return (ROOMS as readonly unknown[]).includes(value) ? value as Room : refuse(422, "BAD_REQUEST", `room is the level of the device's own disk: ${ROOMS.join(", ")}`);
}

export function networkIn(value: unknown): Network | undefined {
  return (NETWORKS as readonly unknown[]).includes(value) ? value as Network : undefined;
}

export function recorderIn(value: unknown): Recorder | undefined {
  if (value === undefined) return undefined;
  const said = isObject(value) ? value as Record<string, unknown> : {};
  const keys = Object.keys(said).sort().join();
  if (keys === "state" && (RECORDER_STATES as readonly unknown[]).includes(said.state)) return { state: said.state as RecorderState };
  if (keys === "cause,state" && said.state === "interrupted" && (CAUSES as readonly unknown[]).includes(said.cause)) return { state: "interrupted", cause: said.cause as Cause };
  return refuse(422, "BAD_REQUEST", `recorder is {state}, a state of ${RECORDER_STATES.join(", ")}, or {state: "interrupted", cause}, a cause of ${CAUSES.join(", ")}`);
}

export type ThroughStated = Value & { readonly seal?: number };

export function throughIn(value: unknown): Readonly<Record<string, ThroughStated>> | undefined {
  if (value === undefined) return undefined;
  const bad = (): never => refuse(422, "BAD_REQUEST",
    "through states per source id {read_through, stated_at, left?, start_ms?, months?, seal?}: two RFC 3339 instants, a whole number, an instant in ms or null, "
    + "{\"<YYYY-MM>\" or \"undated\": [items, bytes or null]} and a seal number of 1 or more");
  const sources = isObject(value as Json) ? Object.entries(value as Record<string, unknown>) : bad();
  if (sources.length > MAX_CONNECTORS) bad();
  return Object.fromEntries(sources.map(([source, stated]) => {
    if (!isSource(source) || !isObject(stated as Json)) bad();
    const { read_through, stated_at, left, start_ms, months, seal, ...rest } = stated as Record<string, unknown>;
    if (Object.keys(rest).length > 0 || !isInstant(read_through) || !isInstant(stated_at)) bad();
    if (left !== undefined && !(typeof left === "number" && Number.isSafeInteger(left) && left >= 0)) bad();
    if (start_ms !== undefined && start_ms !== null && !(typeof start_ms === "number" && Number.isSafeInteger(start_ms))) bad();
    if (seal !== undefined && !(typeof seal === "number" && Number.isSafeInteger(seal) && seal >= 1)) bad();
    const counted = months === undefined ? undefined : monthsIn(months) ?? bad();
    const read: ThroughStated = {
      read_through_ms: Date.parse(read_through as string), stated_ms: Date.parse(stated_at as string),
      ...(left === undefined ? {} : { left: left as number }), ...(start_ms === undefined ? {} : { start_ms: start_ms as number | null }),
      ...(counted === undefined ? {} : { months: counted }), ...(seal === undefined ? {} : { seal: seal as number }),
    };
    return [source, read];
  }));
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && !Number.isNaN(Date.parse(value));
}

function isSource(id: string): boolean {
  try {
    sourceName(id);
    return true;
  } catch {
    return false;
  }
}

export async function readStated(door: string, pass: string): Promise<Stated | null> {
  try {
    const response = await fetch(`${door}${STATED_ROUTE}`, { headers: { authorization: `Bearer ${pass}` } });
    return response.ok ? ((await response.json()) as { stated: Stated }).stated : null;
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}
