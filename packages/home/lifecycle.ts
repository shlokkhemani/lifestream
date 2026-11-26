import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { type } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { diskSpace, flushed, formOf, isObject, KeyError, openHomeFolder, plainFolder, tryLock, writeDurably, type FileLock, type Form, type HomeFolder, type JsonObject, type Program } from "@lifestreamprotocol/core";
import { homeSources, unitId } from "./devices.js";
import { readHold, type Hold } from "./hold.js";
import { machine, pointAt, type Machine } from "./machine.js";
import { hashToken, mintIn, mintPrincipal, passOf, readPrincipals, revokeIn, revokePrincipal, widen, widenIn, writePrincipals, type Mint, type Principal, type PrincipalsFile, type Scope } from "./principals.js";
import { change, firstSettings, membersBeforeKey, personal, runsAt } from "./settings.js";
import { socketPath, type HomeSocket } from "./socket.js";
import { settingsMove } from "./models-move.js";
import { madeStart } from "./start.js";
import { makeKeyedVault, Vault, type KeyedHandoff, type MadeKeyed, type SlotHanded } from "./vault.js";
import { CLI } from "./cli-name.js";


export const HOME_FILE = "HOME.json";
export const STOP_LOCK = "stop.lock";
export const RETIRED_FILE = "RETIRED.json";
export const HOME_FORMAT = "org.lifestreamprotocol.home/1";
const REVOKED_DIRECTORY = "revoked";
const HOME_ID_FILE = "home-id";
const A_HOME = [HOME_FILE, "home.db", "blobs", "days"];
const WITNESS_DIRECTORY = "witness";
const NETWORK = new Set(["smbfs", "afpfs", "nfs", "nfs4", "webdav", "cifs", "smb3", "ftp", "fuse.sshfs", "sshfs"]);

export interface HomeJson {
  format: typeof HOME_FORMAT;
  id: string;
  created: string;
}

export class LifecycleError extends Error {
  override name = "LifecycleError";
}

export const ONLY_THE_HOME = "Lifestream is encrypted, and only Lifestream opens it while it runs. Open Lifestream, then run this again.";

export function folderHere(root: string): HomeFolder {
  return plainFolder(root) ?? fail(ONLY_THE_HOME);
}

export function slotFolder(root: string, machineDir: string, program: Program, slot: SlotHanded, now_ms: number): HomeFolder {
  const opening = new Vault({ root, machine: machineDir, get home() { return readHome(root).id; } }).open(slot, now_ms);
  if (opening.form === "locked") throw new KeyError("LOCKED", `${root} is an encrypted home, and the key handed opens none of it: ${opening.why}`);
  return opening.form === "plain" ? openHomeFolder(root, { machine: machineDir, program }) : openHomeFolder(root, { machine: machineDir, program, keys: opening.keys, vault: opening.vault });
}

export function notBuiltKeyed(root: string, verb: string): void {
  if (plainFolder(root) === null) fail(`${root} holds an encrypted Lifestream, and ${CLI} ${verb} works only on one that is not encrypted: nothing changed`);
}

function fail(message: string): never {
  throw new LifecycleError(message);
}

export function readHome(folder: string): HomeJson {
  const path = join(folder, HOME_FILE);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      fail(existsSync(folder) ? `${folder} is not Lifestream's folder: it holds no ${HOME_FILE} (${CLI} adopt <folder> makes one)` : awayWords(folder));
    }
    fail(`${path}: ${(error as Error).message}`);
  }
  if (!isObject(value) || value.format !== HOME_FORMAT || typeof value.id !== "string" || value.id === "" || typeof value.created !== "string") {
    fail(`${path} is not Lifestream's: it states format ${HOME_FORMAT}, an id and created`);
  }
  return { format: HOME_FORMAT, id: value.id, created: value.created };
}

const HELD_MS = 1_000;
export const LOOK_MS = 5_000;

export const driveOf = (folder: string): string | null => /^\/Volumes\/([^/]+)(?:\/|$)/u.exec(folder)?.[1] ?? null;

export function awayWords(folder: string): string {
  return `Lifestream's folder is not there: Lifestream waits for ${folder}. If its drive shows under another name, eject it and plug it in again.`;
}

export type Standing = { away: string } | { refused: string } | { folder: string; home: HomeJson; hold: Hold | null };

export function standing(folder: string, at: Machine): Standing {
  let home: HomeJson;
  try {
    home = readHome(folder);
  } catch (error) {
    if (error instanceof LifecycleError) return { away: error.message };
    throw error;
  }
  if (retired(folder)) return { refused: `Lifestream moved away: ${folder} holds ${RETIRED_FILE} (${CLI} adopt ${folder} takes it back here)` };
  return { folder, home, hold: readHold(at, home.id) };
}

export class HomeRoot {
  static reads: (fd: number) => boolean = (fd) => {
    try {
      fstatSync(fd);
      return true;
    } catch {
      return false;
    }
  };

  #looked = -Infinity;
  #held = true;
  #fd: number | null;

  private constructor(private readonly path: string, readonly id: string, private readonly dev: bigint, private readonly ino: bigint, fd: number, private readonly clock: () => number) {
    this.#fd = fd;
  }

  static open(path: string, clock: () => number = Date.now): HomeRoot {
    const { id } = readHome(path);
    const fd = openSync(join(path, HOME_FILE), "r");
    try {
      const { dev, ino } = statSync(path, { bigint: true });
      return new HomeRoot(path, id, dev, ino, fd, clock);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  held(): boolean {
    const now = this.clock();
    if (now - this.#looked < HELD_MS) return this.#held;
    this.#looked = now;
    return this.look();
  }

  look(): boolean {
    if (this.#fd === null) return (this.#held = false);
    try {
      const { dev, ino } = statSync(this.path, { bigint: true });
      this.#held = dev === this.dev && ino === this.ino && HomeRoot.reads(this.#fd);
    } catch {
      this.#held = false;
    }
    return this.#held;
  }

  close(): void {
    const fd = this.#fd;
    this.#fd = null;
    this.#held = false;
    if (fd === null) return;
    try {
      closeSync(fd);
    } catch {
    }
  }
}

export function homeFolder(named: string | undefined, at: Machine = machine()): string {
  const folder = named === undefined ? at.home ?? fail(`this machine holds no home: ${CLI} adopt <folder> makes one, or name one with --root`) : resolve(named);
  readHome(folder);
  return folder;
}

export function homeSocket(folder: string, machineDir: string = machine().dir): HomeSocket {
  return { path: socketPath(machineDir, readHome(folder).id), folder };
}

export function retired(folder: string): boolean {
  return existsSync(join(folder, RETIRED_FILE));
}

export function sameHome(one: string, other: string): boolean {
  try {
    return readHome(one).id === readHome(other).id;
  } catch {
    return false;
  }
}

export interface AdoptOptions {
  machine?: Machine;
  now?: () => number;
  fileSystem?: (path: string) => string | null;
  platform?: NodeJS.Platform;
  replace?: boolean;
  model?: string;
  serial4?: string;
  keyed?: KeyedHandoff;
}

export interface Adopted {
  folder: string;
  id: string;
  as: "new" | "moved" | "restored" | "kept";
  passes: { kept: string[]; revoked: string[]; suspended: string[] };
  machine: { dir: string; codex: string | null; claude: string | null };
  vault?: MadeKeyed;
  owed?: PassesOwed | null;
}

export type PassesOwed = "restored" | "revoked again";

type Noted = "restored" | "noted";

interface RevokedRecord {
  revoked: string[];
  owed?: Noted;
  unit?: string;
}

type Refusal = { refused: string } | { refused: null; before: HomeJson | null; id: string; folderLock: FileLock | null; currentLock: FileLock | null };

function refusalOf(folder: string, at: Machine, options: AdoptOptions): Refusal {
  const held: FileLock[] = [];
  const refused = (why: string): Refusal => {
    for (const lock of held) lock.release();
    return { refused: why };
  };
  try {
    const place = placeRefusal(folder, at, options.fileSystem, options.platform);
    if (place !== null) return refused(place);
    if (options.keyed !== undefined && holdsHome(folder)) return refused("this folder holds Lifestream already; it stays as it is");
    const copy = options.replace === true ? null : copyRefusal(folder, at);
    if (copy !== null) return refused(copy);
    const take = (home: string): FileLock | null | "running" => {
      if (!existsSync(join(home, "home.lock"))) return null;
      const lock = tryLock(join(home, "home.lock"));
      if (lock === null) return "running";
      held.push(lock);
      return lock;
    };
    const folderLock = take(folder);
    if (folderLock === "running") return refused(`Lifestream runs on ${folder}: stop it first`);
    const current = at.home !== null && existsSync(at.home) && realPath(at.home) !== folder ? take(at.home) : null;
    if (current === "running") return refused(`Lifestream runs on ${at.home}: stop it first`);
    const before = existsSync(join(folder, HOME_FILE)) ? readHome(folder) : null;
    const id = before?.id ?? options.keyed?.home_id ?? randomUUID();
    socketPath(at.dir, id);
    return { refused: null, before, id, folderLock, currentLock: current };
  } catch (error) {
    if (error instanceof Error) return refused(error.message);
    throw error;
  }
}

export function placeRefusal(
  folder: string, at: Machine, fileSystem: (path: string) => string | null = mountedFileSystem, platform: NodeJS.Platform = process.platform,
): string | null {
  const place = refusedPlace(folder, realPath(at.user), fileSystem, platform);
  if (place !== null) return place;
  const there = nearestExisting(folder);
  try {
    accessSync(there, constants.W_OK);
  } catch {
    return `${there} is not writable by this user: choose a folder of your own, such as ~/Lifestream`;
  }
  return null;
}

export function copyRefusal(folder: string, at: Machine): string | null {
  if (at.home === null || !existsSync(at.home) || realPath(at.home) === folder || !sameHome(folder, at.home)) return null;
  return `${folder} is a copy of the Lifestream folder this machine runs, which is at ${at.home}: a move cut part way, or the folder a move left. `
    + `${CLI} adopt ${folder} --replace takes this copy instead, and gives up whatever the folder at ${at.home} holds that this copy does not`;
}

export async function adopt(path: string, options: AdoptOptions = {}): Promise<Adopted> {
  const at = options.machine ?? machine();
  const now = options.now ?? Date.now;
  const folder = realPath(resolve(path));
  const checked = refusalOf(folder, at, options);
  if (checked.refused !== null) fail(checked.refused);
  const { before, id, currentLock: current } = checked;
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const lock = checked.folderLock ?? tryLock(join(folder, "home.lock"));
  if (lock === null) {
    current?.release();
    fail(`Lifestream runs on ${folder}: stop it first`);
  }
  const passes: Adopted["passes"] = { kept: [], revoked: [], suspended: [] };
  const sealed = before !== null && plainFolder(folder) === null;
  const thisMac = options.model !== undefined && options.serial4 !== undefined ? unitId(options.model, options.serial4) : null;
  let owed: PassesOwed | null = null;
  let as: Adopted["as"];
  let vault: MadeKeyed | undefined;
  try {
    if (before === null) {
      as = "new";
      const held = membersBeforeKey(folder);
      const unit = held.unit === undefined ? newUnit(at, options) : null;
      const zone = held["day.zone"] === undefined ? at.zone : String(held["day.zone"]);
      const day = { zone, day_start_hour: (held["day.day_start_hour"] ?? runsAt(null, "day.day_start_hour")) as number };
      firstSettings(folder, { ...(held["day.zone"] === undefined ? { "day.zone": zone } : {}), ...(unit === null ? {} : { unit }), "history.start": madeStart(now(), day) });
      if (options.keyed !== undefined) vault = makeKeyedVault({ root: folder, machine: at.dir, home: id }, options.keyed, unit ?? String(held.unit), now());
      writeDurably(join(folder, HOME_FILE), `${JSON.stringify({ format: HOME_FORMAT, id, created: new Date(now()).toISOString() } satisfies HomeJson, null, 2)}\n`);
    } else if (retired(folder)) {
      as = "moved";
      rmSync(join(folder, RETIRED_FILE), { force: true });
    } else {
      const seen = readRevoked(at, id);
      as = seen !== null ? "kept" : "restored";
      if (sealed) owed = seen === null || seen.owed === "restored" ? "restored" : "revoked again";
      else Object.assign(passes, seen !== null ? revokeAgain(openHomeFolder(folder), seen.revoked, now()) : restorePasses(openHomeFolder(folder), now(), thisMac));
    }
    const plain = plainFolder(folder);
    if (plain !== null && (as === "new" || as === "moved")) passes.kept = readPrincipals(plain).principals.filter((row) => row.revoked_at === null).map((row) => row.id);
    if (readRevoked(at, id) === null) {
      if (!sealed) writeRevoked(at, id, { revoked: plain === null ? [] : revokedIn(plain, []) });
      else writeRevoked(at, id, owed === "restored" ? { revoked: [], owed, ...(thisMac === null ? {} : { unit: thisMac }) } : { revoked: [], owed: "noted" });
    }
    writeDurably(join(at.dir, HOME_ID_FILE), `${id}\n`);
    pointAt(at, folder);
  } finally {
    current?.release();
    lock.release();
  }
  return {
    folder, id, as, passes, machine: { dir: at.dir, codex: at.codex?.binary ?? null, claude: at.claude?.binary ?? null },
    ...(vault === undefined ? {} : { vault }), ...(sealed ? { owed } : {}),
  };
}

function holdsHome(folder: string): boolean {
  return A_HOME.some((part) => existsSync(join(folder, part)));
}

function newUnit(at: Machine, options: Pick<AdoptOptions, "model" | "serial4">): string {
  if (options.model !== undefined) return unitId(options.model, options.serial4) ?? fail(`--model ${options.model} names no unit: give the Mac's marketing name`);
  return at.unit ?? unitId(type(), undefined)!;
}

function startingUnit(folder: HomeFolder | null, at: Machine): string {
  const macs = folder === null ? [] : readPrincipals(folder).principals.filter((row) => row.kind === "mac" && row.revoked_at === null);
  return macs.length === 1 ? macs[0]!.unit : at.unit ?? unitId(type(), undefined)!;
}

export function startingSettings(folder: HomeFolder | string, at: Machine): JsonObject {
  const held = typeof folder === "string" ? membersBeforeKey(folder) : settingsMove(folder) ?? personal(folder);
  return held.unit === undefined ? { ...held, unit: startingUnit(typeof folder === "string" ? plainFolder(folder) : folder, at) } : held;
}

export function ownUnit(folder: HomeFolder, at: Machine): void {
  if (runsAt(folder, "unit") === null) change(folder, "unit", startingUnit(folder, at));
}

export interface LooseFolder {
  which: "home" | "machine";
  path: string;
  why: "owner" | "permissions";
}

export const LOOSE_META = "loose-folders";

export interface FolderModes {
  mode(path: string): number;
  chmod(path: string, mode: number): void;
}

const systemModes: FolderModes = { mode: (path) => statSync(path).mode, chmod: chmodSync };

export function closeFolders(folder: string, at: Machine, modes: FolderModes = systemModes): { closed: string[]; loose: LooseFolder[] } {
  const closed: string[] = [];
  const loose: LooseFolder[] = [];
  for (const [which, path] of [["home", folder], ["machine", at.dir]] as const) {
    let mode: number;
    try {
      mode = modes.mode(path);
    } catch {
      continue;
    }
    if ((mode & 0o077) === 0) continue;
    try {
      modes.chmod(path, 0o700);
      closed.push(path);
    } catch (error) {
      loose.push({ which, path, why: (error as NodeJS.ErrnoException).code === "EPERM" ? "owner" : "permissions" });
    }
  }
  return { closed, loose };
}

export const DASHBOARD_UNIT = "dashboard";
export const ASK_UNIT = "ask";
export const MCP_UNIT = "mcp";
export const STATIONS_UNIT = "stations";
export const runnerUnit = (unit: string): string => `runner-${unit}`;

export function passDashboard(at: Machine, folder: HomeFolder, home: string, now_ms: number): void {
  const sources = homeSources(home).map((source) => source.id).filter((id) => id !== `stations:local:${home}`);
  const scopes: Scope[] = ["read", "deliver"];
  const row = heldPass(at, folder, "dashboard");
  if (row !== undefined && row.revoked_at === null && row.suspended_at === null) {
    widen(folder, row.id, scopes, sources);
    return;
  }
  storePass(at, "dashboard", mintPrincipal(folder, { unit: DASHBOARD_UNIT, scopes, sources, now_ms }).token);
}

export function passAsk(at: Machine, folder: HomeFolder, home: string, now_ms: number): Principal | null {
  return passDelivering(at, folder, "ask", ASK_UNIT, `ask:local:${home}`, now_ms);
}

export function passStations(at: Machine, folder: HomeFolder, home: string, now_ms: number): Principal | null {
  return passDelivering(at, folder, "stations", STATIONS_UNIT, `stations:local:${home}`, now_ms);
}

function passDelivering(at: Machine, folder: HomeFolder, reader: string, unit: string, source: string, now_ms: number): Principal | null {
  return keptPass(at, folder, reader, (row) => delivering(row, unit, source), { unit, scopes: ["deliver"], sources: [source], now_ms });
}

export function stationsPass(at: Machine, folder: HomeFolder): Principal | undefined {
  const row = heldPass(at, folder, "stations");
  return row === undefined || row.revoked_at !== null || row.suspended_at !== null ? undefined : row;
}

export function isAskPass(at: Machine, folder: HomeFolder, home: string, token: string): boolean {
  const row = heldPass(at, folder, "ask");
  return row !== undefined && row.token_sha256 === hashToken(token) && delivering(row, ASK_UNIT, `ask:local:${home}`);
}

function delivering(row: Principal, unit: string, source: string): boolean {
  return row.revoked_at === null && row.suspended_at === null && row.unit === unit && row.kind === null && row.agent === undefined
    && row.expires_at === undefined && row.scopes.join() === "deliver" && row.sources.join("\n") === source;
}

export function passMcp(at: Machine, folder: HomeFolder, now_ms: number): Principal | null {
  return keptPass(at, folder, "mcp", (row) => row.unit === MCP_UNIT && row.kind === null && row.scopes.join() === "admit", { unit: MCP_UNIT, scopes: ["admit"], now_ms });
}

export function passRunner(at: Machine, folder: HomeFolder, unit: string, now_ms: number): Principal | null {
  const runner = runnerUnit(unit);
  return keptPass(at, folder, "runner", (row) => row.unit === runner && row.kind === "runner" && row.scopes.join() === "run", { unit: runner, scopes: ["run"], kind: "runner", now_ms });
}

function keptPass(at: Machine, folder: HomeFolder, reader: string, fits: (row: Principal) => boolean, mint: Mint): Principal | null {
  const row = heldPass(at, folder, reader);
  const live = row !== undefined && row.revoked_at === null && row.suspended_at === null;
  if (live && fits(row)) return null;
  if (live) rememberRevoked(at, folder.root, [row.id]);
  const revoked = live ? revokePrincipal(folder, row.id, mint.now_ms) : null;
  storePass(at, reader, mintPrincipal(folder, mint).token);
  return revoked;
}

function heldPass(at: Machine, folder: HomeFolder, reader: string): Principal | undefined {
  const file = join(at.dir, reader, "door-token");
  const held = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  return held === "" ? undefined : passOf(folder, held);
}

function storePass(at: Machine, reader: string, token: string): void {
  const file = join(at.dir, reader, "door-token");
  mkdirSync(dirname(file), { recursive: true });
  writeDurably(file, `${token}\n`, 0o600);
}

async function storePassAsync(at: Machine, reader: string, token: string): Promise<void> {
  const file = join(at.dir, reader, "door-token");
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${token}\n`, { mode: 0o600, flag: "wx" });
    await flushed(temporary);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  await flushed(dirname(file));
}

function heldPassIn(at: Machine, file: PrincipalsFile, reader: string): Principal | undefined {
  const path = join(at.dir, reader, "door-token");
  const held = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  if (held === "") return undefined;
  const hash = hashToken(held);
  return file.principals.find((row) => row.token_sha256 === hash);
}

export async function ensureStartPasses(at: Machine, folder: HomeFolder, home: string, now_ms: number): Promise<Principal[]> {
  let file = readPrincipals(folder);
  let changed = false;
  const replaced: Principal[] = [];
  const toStore: [string, string][] = [];
  const revokedIds: string[] = [];

  const dashSources = homeSources(home).map((source) => source.id).filter((id) => id !== `stations:local:${home}`);
  const dashScopes: Scope[] = ["read", "deliver"];
  const dashRow = heldPassIn(at, file, "dashboard");
  if (dashRow !== undefined && dashRow.revoked_at === null && dashRow.suspended_at === null) {
    const widened = widenIn(file, dashRow.id, dashScopes, dashSources);
    if (widened.changed) {
      file = widened.file;
      changed = true;
    }
  } else {
    const minted = mintIn(file, { unit: DASHBOARD_UNIT, scopes: dashScopes, sources: dashSources, now_ms });
    file = minted.file;
    changed = true;
    toStore.push(["dashboard", minted.token]);
  }

  const keep = (reader: string, fits: (row: Principal) => boolean, mint: Mint): void => {
    const row = heldPassIn(at, file, reader);
    const live = row !== undefined && row.revoked_at === null && row.suspended_at === null;
    if (live && fits(row)) return;
    if (live) {
      revokedIds.push(row.id);
      const revoked = revokeIn(file, row.id, mint.now_ms);
      file = revoked.file;
      replaced.push(revoked.principal);
    }
    const minted = mintIn(file, mint);
    file = minted.file;
    changed = true;
    toStore.push([reader, minted.token]);
  };

  const askSource = `ask:local:${home}`;
  keep("ask", (row) => delivering(row, ASK_UNIT, askSource), { unit: ASK_UNIT, scopes: ["deliver"], sources: [askSource], now_ms });
  keep("mcp", (row) => row.unit === MCP_UNIT && row.kind === null && row.scopes.join() === "admit", { unit: MCP_UNIT, scopes: ["admit"], now_ms });
  const stationsSource = `stations:local:${home}`;
  keep("stations", (row) => delivering(row, STATIONS_UNIT, stationsSource), { unit: STATIONS_UNIT, scopes: ["deliver"], sources: [stationsSource], now_ms });
  const runner = runnerUnit(home);
  keep("runner", (row) => row.unit === runner && row.kind === "runner" && row.scopes.join() === "run", { unit: runner, scopes: ["run"], kind: "runner", now_ms });

  if (revokedIds.length > 0) rememberRevoked(at, folder.root, revokedIds);
  if (changed) writePrincipals(folder, file);
  if (toStore.length > 0) await Promise.all(toStore.map(([reader, token]) => storePassAsync(at, reader, token)));
  return replaced;
}

export interface Look {
  dir: string;
  home: string | null;
  folder: {
    path: string;
    refused: string | null;
    free_bytes: number;
    door: string;
    form: Form | "empty";
    id: string | null;
  } | null;
}

export function look(path: string | null, options: AdoptOptions = {}): Look {
  const at = options.machine ?? machine();
  if (path === null) return { dir: at.dir, home: at.home, folder: null };
  const folder = realPath(resolve(path));
  const checked = refusalOf(folder, at, options);
  if (checked.refused === null) {
    checked.folderLock?.release();
    checked.currentLock?.release();
  }
  let refused = checked.refused;
  let door = (key: string) => runsAt(folder, key) as number;
  try {
    door("door.port");
  } catch (error) {
    refused ??= (error as Error).message;
    door = (key) => runsAt(null, key) as number;
  }
  let id: string | null = null;
  try {
    id = existsSync(join(folder, HOME_FILE)) ? readHome(folder).id : null;
  } catch {
  }
  let form: Form | "empty" = "empty";
  try {
    if (holdsHome(folder)) form = formOf(folder);
  } catch (error) {
    refused ??= `${folder} does not read: ${(error as Error).message}`;
  }
  return {
    dir: at.dir, home: at.home,
    folder: { path: folder, refused, free_bytes: diskSpace(nearestExisting(folder)).free_bytes, door: `http://127.0.0.1:${door("door.port")}`, form, id },
  };
}

export function retire(folder: string, now_ms: number = Date.now()): { retired: string } {
  readHome(folder);
  const marker = { retired: new Date(now_ms).toISOString() };
  writeDurably(join(folder, RETIRED_FILE), `${JSON.stringify(marker)}\n`);
  return marker;
}

function restorePasses(folder: HomeFolder, now_ms: number, thisMac: string | null): Adopted["passes"] {
  const passes: Adopted["passes"] = { kept: [], revoked: [], suspended: [] };
  const file = readPrincipals(folder);
  if (file.principals.length === 0) return passes;
  const at = new Date(now_ms).toISOString();
  const rows = file.principals.map((row) => {
    if (row.revoked_at !== null) return row;
    if (row.unit === thisMac || (row.kind === null && (row.scopes.includes("read") || row.scopes.includes("admit") || row.scopes.includes("find")))) {
      passes.revoked.push(row.id);
      return { ...row, revoked_at: at };
    }
    if (row.scopes.includes("station") || row.kind === "agent") {
      passes.suspended.push(row.id);
      return row.suspended_at === null ? { ...row, suspended_at: at } : row;
    }
    passes.kept.push(row.id);
    return row;
  });
  writePrincipals(folder, { ...file, principals: rows });
  return passes;
}

function revokeAgain(folder: HomeFolder, revoked: readonly string[], now_ms: number): Adopted["passes"] {
  const passes: Adopted["passes"] = { kept: [], revoked: [], suspended: [] };
  const file = readPrincipals(folder);
  const at = new Date(now_ms).toISOString();
  const gone = new Set(revoked);
  const rows = file.principals.map((row) => {
    if (row.revoked_at !== null) return row;
    if (gone.has(row.id)) {
      passes.revoked.push(row.id);
      return { ...row, revoked_at: at };
    }
    passes.kept.push(row.id);
    return row;
  });
  if (passes.revoked.length > 0) writePrincipals(folder, { ...file, principals: rows });
  return passes;
}

function revokedIn(folder: HomeFolder, seen: readonly string[]): string[] {
  const held = readPrincipals(folder).principals.filter((row) => row.revoked_at !== null).map((row) => row.id);
  return [...new Set([...seen, ...held])].sort();
}

export function passesAtStart(at: Machine, folder: HomeFolder, now_ms: number): { restored: Adopted["passes"] | null; revoked: string[] } {
  const id = readHome(folder.root).id;
  const seen = readRevoked(at, id);
  if (seen === null) return { restored: null, revoked: [] };
  const restored = seen.owed === "restored" ? restorePasses(folder, now_ms, seen.unit ?? null) : null;
  const { revoked } = revokeAgain(folder, seen.revoked, now_ms);
  if (seen.owed !== undefined) writeRevoked(at, id, { revoked: revokedIn(folder, seen.revoked) });
  return { restored, revoked };
}

export function rememberRevoked(at: Machine, folder: string, ids: readonly string[]): void {
  const id = readHome(folder).id;
  const seen = readRevoked(at, id);
  if (seen !== null) writeRevoked(at, id, { ...seen, revoked: [...new Set([...seen.revoked, ...ids])].sort() });
}

function readRevoked(at: Machine, id: string): RevokedRecord | null {
  for (const path of [revokedPath(at, id), join(at.dir, WITNESS_DIRECTORY, `${id}.json`)]) {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      fail(`${path} cannot be read (${(error as Error).message}): remove it, and adopt the folder again`);
    }
    const revoked = isObject(value) ? value.revoked ?? [] : undefined;
    if (!Array.isArray(revoked) || !revoked.every((each) => typeof each === "string")) fail(`${path} states no revoked: remove it, and adopt the folder again`);
    const owed = isObject(value) ? value.owed : undefined;
    if (owed !== undefined && owed !== "restored" && owed !== "noted") fail(`${path} states owed passes it does not name: remove it, and adopt the folder again`);
    const unit = isObject(value) ? value.unit : undefined;
    if (unit !== undefined && (typeof unit !== "string" || unit === "")) fail(`${path} states a unit that is not one: remove it, and adopt the folder again`);
    return { revoked: revoked as string[], ...(owed === undefined ? {} : { owed }), ...(unit === undefined ? {} : { unit }) };
  }
  return null;
}

function writeRevoked(at: Machine, id: string, record: RevokedRecord): void {
  mkdirSync(join(at.dir, REVOKED_DIRECTORY), { recursive: true });
  writeDurably(revokedPath(at, id), `${JSON.stringify(record)}\n`);
}

function revokedPath(at: Machine, id: string): string {
  return join(at.dir, REVOKED_DIRECTORY, `${id}.json`);
}

export function nearestExisting(folder: string): string {
  let there = folder;
  while (!existsSync(there) && dirname(there) !== there) there = dirname(there);
  return there;
}

function refusedPlace(folder: string, home: string, fileSystem: (path: string) => string | null, platform: NodeJS.Platform): string | null {
  const drive = driveOf(folder);
  if (drive !== null) {
    const table = mountTable();
    if (table?.some((mount) => mount.point === `/Volumes/${drive}`) !== true) {
      return `the drive ${drive} is not connected${table === null ? " (the mount table cannot be read)" : ""}: connect it, then adopt the folder on it`;
    }
  }
  const within = (place: string) => folder === place || folder.startsWith(`${place}${sep}`);
  for (const place of ["Desktop", "Documents", "Downloads"]) {
    if (within(join(home, place))) return `${folder} is in ~/${place}, which iCloud may sync and the system may tidy: choose a folder of its own, such as ~/Lifestream`;
  }
  for (const synced of [join(home, "Library", "Mobile Documents"), join(home, "Library", "CloudStorage")]) {
    if (within(synced)) return `${folder} is in a place a cloud service syncs (${synced}): choose a folder of its own, such as ~/Lifestream`;
  }
  const type = fileSystem(folder);
  if (type !== null && NETWORK.has(type)) return `${folder} is on a network volume (${type}): Lifestream's database needs a local disk`;
  if (platform === "darwin" && type !== "apfs") return `${folder} is on a ${type ?? "unknown"} disk; Lifestream needs APFS: format the disk APFS in Disk Utility`;
  return null;
}

export function realPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(realPath(parent), basename(path));
}

function mountTable(): { point: string; type: string }[] | null {
  try {
    if (process.platform === "linux") {
      return readFileSync("/proc/mounts", "utf8").split("\n").flatMap((line) => {
        const [, point, type] = line.split(" ");
        return point === undefined || type === undefined ? [] : [{ point: point.replace(/\\040/gu, " "), type }];
      });
    }
    return execFileSync("mount", { encoding: "utf8" }).split("\n").flatMap((line) => {
      const match = /^.+? on (.+) \(([^,)]+)/u.exec(line);
      return match === null ? [] : [{ point: match[1]!, type: match[2]! }];
    });
  } catch {
    return null;
  }
}

export function mountedFileSystem(path: string): string | null {
  const table = mountTable();
  if (table === null) return null;
  let found: { point: string; type: string } | null = null;
  for (const mount of table) {
    const holds = mount.point === "/" || path === mount.point || path.startsWith(`${mount.point}${sep}`);
    if (holds && (found === null || mount.point.length > found.point.length)) found = mount;
  }
  return found?.type ?? null;
}
