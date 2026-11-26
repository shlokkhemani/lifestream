import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { setImmediate as yieldTurn, setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { chromeSites, googlePlaces, routeOf, secretFieldOf, stationsOver, survey, verdictOf, type Accounts } from "@lifestreamprotocol/connect";
import {
  civilDay, damaged, HOME_DB, isObject, LEDGER_DB, makeUnder, writeDurably, openHome, openHomeFolder, outOfRoom, RELEASE, roomAt, SecretError, SETTINGS_MOVE, tryLock, type AttemptRow, type BlobStore, type FileLock, type Form, type HandedFolder, type HomeDb, type HomeFolder, type JobRow, type Json, type JsonObject, type Room, type SourceRow, type Tx, walkPlace,
} from "@lifestreamprotocol/core";
import type { Family } from "@lifestreamprotocol/families";
import { CALL_PASS, callCopiesOf, LEDGER_DAMAGED_EXIT, listRunners, MODEL_USES, openAsker, openLedger, OPENROUTER_SECRET, readRouteId, transportSecret, USE_IDS, warmRunner, WORK_KINDS, type Ledger, type ProgramAt, type UseId } from "@lifestreamprotocol/model";
import { openHider, openMarks, type Hider, type MarksStore } from "@lifestreamprotocol/privacy";
import { HIDING_META, hidingWaits, openCopies, sentLevel, type CopyAnswer, type Copies } from "./copies.js";
import { driveHalf, hidingPick, openDetector } from "./detector.js";
import { restingOf } from "./embedder.js";
import { findingsDirOf, openEnginePictures, scannedFaces } from "./engine-pictures.js";
import { markingQueues } from "./index-job.js";
import { SCREEN_INDEX } from "./screen-job.js";
import { marksFileOf, openMarking, type Marking } from "./marking.js";
import { meaningSettingsOf, ScreenIndex, screenFileOf } from "./screen-index.js";
import { searchFileOf } from "./search-index.js";
import { meaningModel } from "./search-route.js";
import { peopleFileOf, readNameTable } from "./people.js";
import { Models, MODELS_META, unfilled, type ModelReach, type Routing } from "./models.js";
import { NO_MODEL_WORDS } from "./chat-route.js";
import { promptsOf, startPrompts } from "./prompts.js";
import { stagedFile } from "./ask-files.js";
import { ChatVoice, voiceWorkOf } from "./chat-voice.js";
import { aboutOf, FEEDBACK_KINDS, FEEDBACK_URL, openFeedback, type DeviceSaid, type Feedback, type FeedbackKind } from "./feedback.js";
import { appFactsOf, connectorFactsOf, failedRuns, macosVersion, turnOf } from "./feedback-seams.js";
import type { StreamRow } from "./pages.js";
import { Calls } from "./pick.js";
import { callCommand, faceEngine, homeCommand } from "./programs.js";
import { commandFile, linked } from "./command.js";
import { fingerprintKey, readDays, rebuildCursor, sweepDayTemporaries, type Listed } from "./derive.js";
import { Due } from "./due.js";
import { isProgramName, Programs, type ProgramsOptions } from "./subscriptions.js";
import { failpoint } from "./failpoint.js";
import { upgradeImports } from "./imports-upgrade.js";
import { BY_HAND, chromeCame, indexNudged, lookAtInbox, parkPoll, POLL_READ, pollsCut, pollsDue, queuePoll, unparkPoll, type Call, type PollDue } from "./import.js";
import { needsMet, outcomesOf, targetOf } from "./attempts.js";
import { devicesDrafter } from "./devices-draft.js";
import { OwnerWriter } from "./owner-act.js";
import { peopleDrafter } from "./people-draft.js";
import { placesDrafter } from "./places-draft.js";
import { accountsOf, switchOf } from "./catalog.js";
import { KINDS, unpausable, unrun } from "./kinds.js";
import { STORED_KEY, STORED_REST, storedMark } from "./stored.js";
import { HELD_KEY, LEFT_KEY, TALLY_KEY } from "./tally.js";
import { LEFT_FOLDED, QUIET_DONE, QUIET_KEY } from "./quiet.js";
import { connectorOfJob, covers, errorText, heldBy, homeNetwork, jobError, LANE, nextRun, pauseTarget, POLL_PARKED, servedLane, storageError, type Kind, type Main, type Running, type Slice } from "./jobs.js";
import { Pool, READ_QUIET_MS } from "./pool.js";
import { DOOR_AWAY, LOCKED, LOCKED_WORDS, notNow, Refusal, RETRY_S, RETRY_SOON_S } from "./refusal.js";
import { CUT_MOST, type Removed } from "./erasable-streams.js";
import { checkFiles } from "./home-file.js";
import { awayWords, closeFolders, copyRefusal, ensureStartPasses, HomeRoot, LifecycleError, LOOK_MS, LOOSE_META, ownUnit, realPath, passesAtStart, rememberRevoked, retire, standing, startingSettings, STOP_LOCK, type LooseFolder } from "./lifecycle.js";
import { hold, holdLine, readHold, type HomeDatabase } from "./hold.js";
import { due as checkDue, run as runCheck, stale, stopped } from "./hold-check.js";
import { machine, pointedAt, type Machine } from "./machine.js";
import { KNOCKS } from "./knocks.js";
import { Pairing } from "./pairing.js";
import { Agents } from "./agents.js";
import type { Existing } from "./access.js";
import { settleAccess } from "./access-move.js";
import { offeredOf } from "./access-routes.js";
import { heldRunners, mintOwnPair, readPrincipals, retireUnit, revokePrincipal } from "./principals.js";
import { homeOf, loadRegistry, type Loaded } from "./registry.js";
import { connectorsFolder, FOLDER_UNLOADED, hand, handed, homeLeft, loadGeneration, READ_FOLDER } from "./folders.js";
import { guidePath } from "./verbs/connectors-folder.js";
import { facesRun, lookupRow } from "./registry-home.js";
import { checkConnectors, chosenFor, connectorOf, connectorSettings, effective, effectiveOf, personal, planned, replaced, runsAt, sealStrays, settingsPath, type Settings } from "./settings.js";
import { movedSettings } from "./models-move.js";
import { CATCH_UP, FREE_BYTES, keepDay, LOG_BEHIND, POLL_STARTED, readDisk, type FreeDay, type LogBehind } from "./status.js";
import { relayConnectors, sitesTurned } from "./verbs/connectors.js";
import { relayStatus } from "./verbs/status.js";
import { VerbError } from "./verbs/context.js";
import type { RefreshAnswer } from "./wire.js";
import { accountConnect, clientFinish, clientStart, devicePoll, deviceStart, sealField, SIGNIN_MS, type Sealing } from "./verbs/signin.js";
import { ClientListeners } from "./client-listener.js";
import { claimSocket, serveSocket, socketPath, type Call as SocketCall, type Dispatch, type KeptRead, type Out } from "./socket.js";
import { openTurns, type Part, type Polled, type Truncated, type Turns } from "./turns.js";
import { openCopier, type Copier, type CopierAnswer } from "./copiers.js";
import { answerForm } from "./verbs/args.js";
import { readStated, type Stated } from "./stated.js";
import { applyThrough, type Received, type Value } from "./through.js";
import { maintenance, VERBS, type VerbContext } from "./verbs/index.js";
import { INTENT_META, resumeErasure, standingIntent, streamsCut } from "./verbs/erase.js";
import { holdMissing, missingFiles } from "./verbs/verify.js";
import { LOG_DRAIN, WriteLog, type CopyEnd } from "./write-log.js";
import { actionable, keepPublic, noteReach, reachIdle, type Kept } from "./funnel.js";
import { AT_REST_META, carry, readAtRest, type AtRest, type RestReader } from "./at-rest.js";
import { LOCKED_SINCE, NO_SLOT_KEY, REFUSED_AT, takeSlotKey, UNSEALED, Vault, VAULT_KEY, VaultError, type FolderKeys, type NewMachineSlot, type SlotHanded, type SlotStore } from "./vault.js";
import type { SecretAnswer, SecretAsked } from "./helper.js";
import { CLI } from "./cli-name.js";


export interface HomeOptions {
  registry: string | URL;
  clock?: () => number;
  tickMs?: number;
  call?: readonly string[];
  log?: (line: string) => void;
  machine?: Machine;
  slot?: Buffer | null;
  lookMs?: number;
  verify?: readonly string[];
  signal?: AbortSignal;
  quietMs?: number;
  stopGraceMs?: number;
  slowMs?: number;
  drainPages?: number;
  logTurnMs?: number;
  signinMs?: number;
  random?: (bytes: number) => Buffer;
  programs?: Pick<ProgramsOptions, "rows" | "signed" | "retryMs">;
  erasureCallsMs?: number;
  rest?: RestReader;
  feedbackUrl?: string | null;
}

export interface Home {
  readonly root: string;
  readonly settings: Settings;
  stats(): { jobs: number; calls: number; helpers: { size: number; busy: number; ending: number }; ticks: { count: number; at_ms: number | null } };
  stop(): Promise<void>;
  readonly stopped: Promise<string>;
}

const ONE_HELPER = LANE.history;
const NOT_LAST = "kind:import";
const CHECKPOINT_EVERY_MS = 5 * 60_000;

const PRUNE_EVERY_MS = 3_600_000;
const UNTAKEN_MS = 60 * 60_000;
const TICK_MS = 1_000;
const ROOM_WAIT_MS = 60_000;
const NETWORK_ASK_MS = 60_000;
const REACH_LOOK_MS = 5 * 60_000;
const REST_LOOK_MS = 6 * 60 * 60_000;
const CHANGE_STATE_WAIT_MS = 2_000;
const TICK_STATE_WAIT_MS = 20;
const REQUESTS_KEPT = 20;
const POLL_FOLDER = "poll-folder:";
const SETTINGS_EVENT = "settings";
const SEARCH_LOG_MS = 60_000;

export async function startHome(root: string | null, options: HomeOptions): Promise<Home> {
  const handed = options.slot === undefined ? takeSlotKey() : options.slot === null ? NO_SLOT_KEY : { key: options.slot, why: null };
  const at = options.machine ?? machine();
  const named = root === null ? null : resolve(root);
  const first = named ?? pointedAt(at);
  if (first === null) throw new LifecycleError(`this machine holds no home: ${CLI} adopt <folder> makes one`);
  const { home, folder, lock, opened } = await waitToStart(named, first, at, handed, options);
  const clock = options.clock ?? Date.now;
  let running: HomeProcess | undefined;
  try {
    if ("unread" in opened) throw opened.unread;
    const handle = openHomeFolder(home, { machine: at.dir, program: "home", ...opened.keys });
    handle.emptyWork();
    await claimSocket(socketPath(at.dir, folder.id));
    const { vault } = opened;
    const locked = opened.keys === undefined ? vault.start(handed, clock()) : null;
    const { loose } = closeFolders(home, at);
    const say = options.log ?? ((text: string) => { process.stdout.write(`${text}\n`); });
    const sealed = sealStrays(handle);
    if (sealed.length > 0) say(JSON.stringify({ at: new Date(clock()).toISOString(), settings: "sealed", keys: sealed }));
    ownUnit(handle, at);
    const settings = effectiveOf(startingSettings(handle, at), settingsPath(handle.root)).settings;
    const module = options.registry instanceof URL ? options.registry.href : options.registry.startsWith("file:") ? options.registry : pathToFileURL(resolve(options.registry)).href;
    hand(await loadGeneration({ root: home, machineDir: at.dir }));
    const registry = await loadRegistry(module, settings, homeOf(handle));
    for (const notice of checkConnectors(registry, settings)) say(JSON.stringify({ at: new Date(clock()).toISOString(), settings: notice.key, what: notice.what }));
    running = new HomeProcess(handle, folder, settings, registry, module, lock, options, at, vault);
    await running.start(locked, loose);
    return running.handle();
  } catch (error) {
    homeLeft(home);
    await running?.close();
    await holdOn(at, folder, running?.damage ?? damageIn(error, clock()), clock, options.lookMs);
    folder.close();
    try {
      lock.release();
    } catch {
    }
    throw error;
  }
}

const VERB_HOLDS = "a move or a verb holds the home: it starts when that ends";

function unasked(folder: string): FileLock | null {
  const intent = tryLock(join(folder, STOP_LOCK));
  if (intent === null) return null;
  try {
    return tryLock(join(folder, "home.lock"));
  } finally {
    intent.release();
  }
}

type Judged = { form: "plain"; vault: Vault } | { form: "keyed"; keys: FolderKeys; vault: Vault } | { form: "locked"; why: string } | { form: "unread"; error: unknown };

type Opened = { readonly vault: Vault; readonly keys?: FolderKeys } | { readonly unread: unknown };

interface Started {
  readonly home: string;
  readonly folder: HomeRoot;
  readonly lock: FileLock;
  readonly opened: Opened;
}

class KeyWait {
  #vaulted: { folder: string; id: string; vault: Vault; started: { why: string | null } | null } | null = null;
  #kept: { folder: string; lock: FileLock; socket: { close(): Promise<void> } } | null = null;
  #wake = new AbortController();
  #ended: string | null = null;

  constructor(
    private readonly at: Machine,
    private readonly handed: SlotHanded,
    private readonly clock: () => number,
    private readonly log: (line: Record<string, Json>) => void,
  ) {}

  get woken(): AbortSignal {
    return this.#wake.signal;
  }

  rested(): void {
    if (this.#wake.signal.aborted) this.#wake = new AbortController();
  }

  get ended(): string | null {
    return this.#ended;
  }

  #end(why: string): void {
    this.#ended ??= why;
    this.#wake.abort();
  }

  lock(folder: string): FileLock | null {
    return this.#kept?.folder === folder ? this.#kept.lock : unasked(folder);
  }

  async release(lock: FileLock): Promise<void> {
    if (this.#kept?.lock === lock) await this.letGo();
    else lock.release();
  }

  async letGo(): Promise<void> {
    const kept = this.#kept;
    this.#kept = null;
    try {
      await kept?.socket.close();
    } finally {
      kept?.lock.release();
    }
  }

  why(): string | null {
    const vaulted = this.#vaulted;
    return vaulted === null || vaulted.vault.key !== null ? null : vaulted.started?.why ?? "no key has opened the vault";
  }

  formOf(folder: string, id: string): Form {
    return this.#vaultOf(folder, id).form;
  }

  async judge(folder: string, id: string, lock: FileLock): Promise<Judged> {
    if (this.#kept !== null && this.#kept.lock !== lock) await this.letGo();
    const vault = this.#vaultOf(folder, id);
    let form: Form;
    try {
      form = vault.form;
    } catch (error) {
      await this.#handBack();
      return { form: "unread", error };
    }
    if (form === "plain") {
      await this.#handBack();
      return { form, vault };
    }
    await this.#started(id);
    const keys = vault.folderKeys;
    if (keys !== undefined) {
      await this.#handBack();
      return { form, keys, vault };
    }
    const why = this.why()!;
    if (this.#kept === null) {
      const socket = await serveSocket(socketPath(this.at.dir, id), lockedAnswers({ folder, vault, why, now: this.clock, log: this.log, woken: () => this.#wake.abort(), end: (ended) => this.#end(ended) }));
      this.#kept = { folder, lock, socket };
      this.log({ home: "locked", why });
    }
    return { form: "locked", why };
  }

  opened(judged: Exclude<Judged, { form: "locked" }>): Opened {
    if (judged.form === "unread") return { unread: judged.error };
    return judged.form === "plain" ? { vault: judged.vault } : { vault: judged.vault, keys: judged.keys };
  }

  #vaultOf(folder: string, id: string): Vault {
    if (this.#vaulted === null || this.#vaulted.folder !== folder || this.#vaulted.id !== id) {
      this.#vaulted = { folder, id, vault: new Vault({ root: folder, machine: this.at.dir, home: id }, this.log), started: null };
    }
    return this.#vaulted.vault;
  }

  async #started(id: string): Promise<string | null> {
    const vaulted = this.#vaulted!;
    if (vaulted.started === null) {
      await claimSocket(socketPath(this.at.dir, id));
      vaulted.started = { why: vaulted.vault.start(this.handed, this.clock()) };
    }
    return vaulted.started.why;
  }

  async #handBack(): Promise<void> {
    const socket = this.#kept?.socket;
    this.#kept = null;
    await socket?.close();
  }
}

async function waitToStart(named: string | null, first: string, at: Machine, handed: SlotHanded, options: HomeOptions): Promise<Started> {
  const clock = options.clock ?? Date.now;
  const log = (line: Record<string, Json>) => (options.log ?? ((text) => { process.stdout.write(`${text}\n`); }))(JSON.stringify({ at: new Date(clock()).toISOString(), ...line }));
  let said: string | null = null;
  let last = first;
  let failed: number | null = null;
  let left: HomeRoot | null = null;
  const keyed = new KeyWait(at, handed, clock, log);
  const refuseCopy = (folder: string): void => {
    const copy = named === null ? null : copyRefusal(folder, { ...at, home: pointedAt(at) });
    if (copy !== null) throw new LifecycleError(copy);
  };
  const lockedLine = (folder: string, why: string): string => `${folder} is encrypted, and locked until a key opens it: it takes unlock or recover (${why})`;
  const rest = async (): Promise<void> => {
    const woken = keyed.woken;
    try {
      await delay(options.lookMs ?? LOOK_MS, undefined, { signal: options.signal === undefined ? woken : AbortSignal.any([options.signal, woken]) });
    } catch (error) {
      if (!woken.aborted) throw error;
    }
    keyed.rested();
  };
  const keysToCheck = async (folder: string, id: string): Promise<{ handed?: HandedFolder } | { waits: string; locked?: true }> => {
    let form: Form;
    try {
      form = keyed.formOf(folder, id);
    } catch {
      return {};
    }
    if (form === "plain") return {};
    const lock = keyed.lock(folder);
    if (lock === null) return { waits: VERB_HOLDS };
    let judged: Judged;
    try {
      refuseCopy(folder);
      judged = await keyed.judge(folder, id, lock);
    } catch (error) {
      await keyed.release(lock);
      throw error;
    }
    if (judged.form === "locked") return { waits: lockedLine(folder, judged.why), locked: true };
    await keyed.release(lock);
    return judged.form === "keyed" ? { handed: { root: folder, form: "keyed", machine: at.dir, program: "home", keys: judged.keys.keys.hand() } } : {};
  };
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      if (keyed.ended !== null) {
        log({ home: "stopped", why: keyed.ended });
        throw new LifecycleError(keyed.ended);
      }
      last = named ?? pointedAt(at) ?? last;
      const now = standing(last, at);
      let waits = "away" in now ? now.away : "refused" in now ? now.refused : now.hold !== null ? holdLine(now.hold, now.folder) : null;
      let locked = false;
      if ("folder" in now && now.hold !== null) {
        let held = now.hold;
        if (stale(held)) {
          log({ home: "checked", checked: "stopped", said: ["the check's process is gone"] });
          held = stopped(at, now.home.id, held);
        }
        const back = left !== null && !left.look();
        if (back || checkDue(at, now.home.id, held, failed === held.since_ms)) {
          const keys = await keysToCheck(now.folder, now.home.id);
          if ("waits" in keys) {
            waits = keys.waits;
            locked = keys.locked === true;
          } else {
            let opened: HomeRoot;
            try {
              opened = HomeRoot.open(now.folder, options.clock);
            } catch {
              await delay(options.lookMs ?? LOOK_MS, undefined, { signal: options.signal });
              continue;
            }
            left?.close();
            left = null;
            log({ home: "checking", why: holdLine(held, now.folder) });
            let result: Awaited<ReturnType<typeof runCheck>>;
            try {
              result = await runCheck(at, now.folder, now.home.id, options.verify ?? homeCommand(), options.signal, keys.handed);
            } catch (error) {
              opened.close();
              throw error;
            }
            log({ home: "checked", checked: result.checked, said: result.said });
            if (result.checked === "drive") left = opened;
            else opened.close();
            failed = result.checked === "whole" || result.checked === "found" ? null : held.since_ms;
            said = null;
            continue;
          }
        }
      }
      if (waits === null && "folder" in now) {
        const lock = keyed.lock(now.folder);
        if (lock === null) waits = VERB_HOLDS;
        else {
          try {
            const again = standing(named ?? pointedAt(at) ?? last, at);
            if (!("folder" in again) || again.folder !== now.folder || again.hold !== null) {
              await keyed.release(lock);
              continue;
            }
            refuseCopy(now.folder);
            const missing = missingFiles(now.folder);
            if (missing.length > 0) waits = holdLine(holdMissing(at, now.home.id, missing), now.folder);
            else {
              const judged = await keyed.judge(now.folder, now.home.id, lock);
              if (judged.form === "locked") {
                waits = lockedLine(now.folder, judged.why);
                locked = true;
              } else return { home: now.folder, folder: HomeRoot.open(now.folder, options.clock), lock, opened: keyed.opened(judged) };
            }
          } catch (error) {
            await keyed.release(lock);
            throw error;
          }
          if (!locked) await keyed.release(lock);
        }
      }
      if (!locked) await keyed.letGo();
      if (waits !== said) log({ home: "waiting", why: waits });
      said = waits;
      await rest();
    }
  } finally {
    left?.close();
    await keyed.letGo();
  }
}

function refuseOtherFolder(root: string, realRoot: string, folder: unknown): void {
  if (typeof folder !== "string") throw new Refusal(400, "BAD_CALL", "a request names the folder of the home it asks (folder)");
  if (realPath(resolve(folder)) === realRoot) return;
  throw new Refusal(409, "OTHER_HOME", `the home answering here is ${root}, not ${folder}: a copy of a home answers for it while the home runs`);
}

interface LockedHome {
  readonly folder: string;
  readonly vault: Vault;
  readonly why: string;
  now(): number;
  log(line: Record<string, Json>): void;
  woken(): void;
  end(why: string): void;
}

function lockedAnswers(home: LockedHome): Dispatch {
  const { folder, vault, why } = home;
  const real = realPath(folder);
  const ending = (ended: string): void => void setTimeout(() => home.end(ended), 0);
  return async (request, out) => {
    refuseOtherFolder(folder, real, request.folder);
    switch (request.verb) {
      case "vault":
        return { ...vault.state(), requests: [] };
      case "vault-check":
        return vault.check(textOf(request.recovery));
      case "vault-discard": {
        const discarded = vault.discard();
        if (discarded.dropped.length > 0) home.log({ vault: "discarded", dropped: discarded.dropped });
        return discarded;
      }
      case "unlock": {
        const key_id = vault.unlock(keyOf(request.slot_key, "slot_key"), home.now());
        home.log({ vault: "unlocked", slot: vault.opened?.slot ?? null });
        home.woken();
        return { key_id };
      }
      case "recover": {
        const { recovery: _confirmed, ...recovered } = vault.recover(textOf(request.recovery), newSlotOf(request, () => runsAt(folder, "unit") as string), home.now());
        home.log({ vault: "recovered", slot: recovered.slot });
        home.woken();
        return recovered;
      }
      case "generation":
        return { locked: why };
      case "status":
        out(`${LOCKED_WORDS} (${why})`);
        return { locked: why };
      case "stop":
        ending("stopped: a move or a verify asked");
        return { stopping: true };
      case "retire": {
        const retired = retire(folder, home.now());
        ending(`retired: ${folder} holds RETIRED.json`);
        return retired;
      }
      default:
        throw new Refusal(503, LOCKED, LOCKED_WORDS, RETRY_S, { why });
    }
  };
}

interface Damage {
  error: unknown;
  met: HomeDatabase;
  at_ms: number;
}

function damageIn(error: unknown, at_ms: number): Damage | null {
  if (!storageError(error) || error.database === undefined || !damaged(error)) return null;
  return { error, met: error.database === HOME_DB ? "home.db" : "the ledger", at_ms };
}

async function holdOn(at: Machine, folder: HomeRoot, met: Damage | null, now: () => number, look_ms: number = LOOK_MS): Promise<void> {
  if (met === null) return;
  const left = Math.min(look_ms, met.at_ms + look_ms - now());
  if (left > 0) await delay(left);
  if (!folder.look()) return;
  try {
    hold(at, folder.id, { since_ms: met.at_ms, cause: { met: met.met, error: errorText(met.error) }, check: null });
  } catch {
  }
}

interface SecretRequest {
  at_ms: number;
  secret: string;
  op: SecretAsked["op"];
  lane: string;
  task: string;
  ok: boolean;
}

interface Item extends Slice {
  job: number;
  side: "chunk" | "done" | "fail";
}

export function takeCommit<T extends { job: number }>(queue: T[], running: (job: number) => Running | undefined): T | undefined {
  let kept = 0;
  for (const item of queue) if (running(item.job) !== undefined) queue[kept++] = item;
  queue.length = kept;
  let best = -1;
  let lane = Infinity;
  for (let index = 0; index < queue.length; index++) {
    const served = servedLane(running(queue[index]!.job)!);
    if (served < lane) [best, lane] = [index, served];
  }
  return best < 0 ? undefined : queue.splice(best, 1)[0];
}

interface Active {
  running: Running;
  kind: Kind;
  handed?: Map<string, string>;
  unanswered?: Set<string>;
}

class HomeProcess implements Main {
  readonly families: ReadonlyMap<string, Family>;
  readonly now: () => number;
  readonly #log: (line: string) => void;
  readonly #active = new Map<number, Active>();
  #queue: Item[] = [];
  #db!: HomeDb;
  #blobs!: BlobStore;
  #ledger!: Ledger;
  #due!: Due;
  #calls!: Calls;
  #chatVoice!: ChatVoice;
  #feedback!: Feedback;
  #models!: Models;
  #pool!: Pool;
  #socket!: { close(): Promise<void> };
  #realRoot: string | undefined;
  #pairing!: Pairing;
  #agents!: Agents;
  #programs: Programs | undefined;
  #writer!: OwnerWriter;
  #drive!: string;
  #call!: string;
  #marks: MarksStore | undefined;
  #hider: Hider | undefined;
  #meaningReady = false;
  #meaningStated: string | undefined;
  #copies: Copies | undefined;
  #marking: Marking | undefined;
  readonly #vault: Vault;
  #requests: SecretRequest[] = [];
  #refusedKeys = new Map<string, string>();
  #searchLogged: { seen: string; at_ms: number } | undefined;
  #loop!: Promise<void>;
  #stopping = false;
  #held = false;
  #connecting = false;
  readonly #listeners = new ClientListeners();
  #built: Promise<void> = Promise.resolve();
  #halted: string | null = null;
  #damage: Damage | null = null;
  readonly #turns: Turns;
  #writeLog!: WriteLog;
  #copier!: Copier;
  #room: Room = "ok";
  #stated: Stated | null = null;
  #pastWaits: boolean | null = null;
  #network: { reading: boolean; again: boolean; next_ms: number } = { reading: false, again: false, next_ms: 0 };
  #reachNext_ms = 0;
  #restNext_ms = 0;
  #controls = new Set<string>();
  #prompted = new Set<string>();
  #wake: (() => void) | null = null;
  #jobs = 0;
  #ticks: { count: number; at_ms: number | null } = { count: 0, at_ms: null };
  #nextCheckpoint = 0;
  #nextPrune = 0;
  readonly #surveying = new Map<string, { again: boolean; granted: Set<string>; done: Promise<void> }>();
  #surveyNumber = Date.now();
  readonly #leaving = new AbortController();
  #commitWaits: (() => void)[] = [];
  readonly #doorFetch: typeof fetch = (input, init) =>
    fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, this.#leaving.signal]) : this.#leaving.signal });
  #dailyDone: string | null = null;
  readonly #helpers: number;
  #why = "stopped";
  #stopped!: () => void;
  readonly #ended = new Promise<void>((resolve) => { this.#stopped = resolve; });

  readonly root: string;

  constructor(
    readonly folder: HomeFolder,
    private readonly homeRoot: HomeRoot,
    public settings: Settings,
    public registry: Loaded,
    private readonly module: string,
    private readonly lock: FileLock,
    private readonly options: HomeOptions,
    private readonly machine: Machine,
    vault: Vault,
  ) {
    this.root = folder.root;
    this.#vault = vault;
    this.#helpers = settings.helpers === "auto" ? machine.helpers : settings.helpers;
    this.families = new Map(registry.families.map((family) => [family.name, family]));
    this.now = options.clock ?? Date.now;
    this.#log = options.log ?? ((line) => { process.stdout.write(`${line}\n`); });
    this.#turns = openTurns({ log: (line) => this.log(line as Record<string, Json>), ...(options.slowMs === undefined ? {} : { slow_ms: options.slowMs }) });
  }

  get blobs(): BlobStore {
    return this.#blobs;
  }

  get ending(): number {
    return this.#pool.ending;
  }

  get room(): Room {
    return this.#room;
  }

  get stated(): Stated | null {
    return this.#stated;
  }

  get calls(): Calls {
    return this.#calls;
  }

  get copies(): Main["copies"] {
    return { level: (work_id) => sentLevel(this.settings, this.registry.connectors, work_id), drop: (id) => this.#ledger.sent.drop(id) };
  }

  get damage(): Damage | null {
    return this.#damage;
  }

  log(line: Record<string, Json>): void {
    this.#log(JSON.stringify({ at: new Date(this.now()).toISOString(), ...line }));
  }


  #forget(tx: Tx): string[] {
    const built = new Set((this.registry.acquirers ?? []).map((acquirer) => acquirer.name));
    const sources = new Set(tx.tables.sources.list().map((source) => source.id));
    const forgot: string[] = [];
    const admitted = new Set(this.registry.connectors.map((connector) => connector.id));
    const generation = handed(this.root);
    const folderOf = new Map(generation?.folders.flatMap((folder) => folder.ids.map((id) => [id, folder.name] as const)) ?? []);
    const readFrom = new Map<string, string>();
    const releaseReads = new Set<string>();
    for (const connector of this.registry.connectors) {
      const folder = folderOf.get(connector.id);
      const reads = connector.sources.flatMap((source) => [source.read, ...source.feeders ?? []]);
      if (folder === undefined) {
        for (const read of reads) releaseReads.add(read);
        continue;
      }
      for (const acquirer of connector.acquirers ?? []) {
        if (tx.tables.meta.get(`${POLL_FOLDER}${acquirer}`) !== connector.id) tx.tables.meta.set(`${POLL_FOLDER}${acquirer}`, connector.id);
      }
      for (const read of reads) {
        readFrom.set(read, folder);
        if (tx.tables.meta.get(`${READ_FOLDER}${read}`) !== folder) tx.tables.meta.set(`${READ_FOLDER}${read}`, folder);
      }
    }
    if (generation !== null) {
      const refused = new Set(generation.refused.map((each) => each.name));
      for (const read of tx.tables.meta.under(READ_FOLDER)) {
        const folder = tx.tables.meta.get(`${READ_FOLDER}${read}`)!;
        const kept = readFrom.get(read) === folder || (refused.has(folder) && !releaseReads.has(read));
        if (!kept) tx.tables.meta.delete(`${READ_FOLDER}${read}`);
      }
    }
    const away = (acquirer: string): boolean => {
      const of = tx.tables.meta.get(`${POLL_FOLDER}${acquirer}`);
      return of !== undefined && !admitted.has(of);
    };
    this.#parkRoutes(tx, built);
    const routes = this.#routes();
    const holding = new Set([
      ...tx.tables.polls.list().map((row) => row.acquirer), ...tx.tables.polls.holding(), ...tx.tables.meta.under(POLL_PARKED),
    ]);
    for (const acquirer of [...new Set([...holding, ...tx.tables.meta.under(POLL_FOLDER)])].sort()) {
      if (built.has(acquirer) || routes.has(acquirer)) continue;
      if (away(acquirer)) {
        parkPoll(tx, acquirer);
        continue;
      }
      const declared = this.registry.connectors.some((connector) => (connector.acquirers ?? []).includes(acquirer));
      if (!declared) tx.tables.meta.delete(`${POLL_FOLDER}${acquirer}`);
      if (!holding.has(acquirer)) continue;
      tx.tables.polls.forget(acquirer);
      tx.tables.meta.delete(`${POLL_PARKED}${acquirer}`);
      tx.tables.meta.delete(`${POLL_READ}${acquirer}`);
      tx.tables.attempts.delete(targetOf("fetch", acquirer));
      tx.tables.attempts.delete(targetOf("page", acquirer));
      tx.tables.meta.delete(`${POLL_STARTED}${acquirer}`);
      forgot.push(`poll ${acquirer}`);
    }
    const labelers = new Set((this.registry.labelers ?? []).map((labeler) => targetOf("label", labeler.name)));
    for (const target of tx.tables.attempts.targets()) if (target.startsWith("label:") && !labelers.has(target)) tx.tables.attempts.delete(target);
    for (const job of tx.tables.jobs.open()) {
      if (unrun(this.registry, sources, job.kind, job.key) === null) continue;
      tx.tables.jobs.delete(job.id);
      forgot.push(`${job.kind} ${job.key}`);
    }
    const families = new Set(this.registry.families.map((family) => family.name));
    for (const row of tx.tables.cursors.list(rebuildCursor(""))) {
      const family = row.name.slice(rebuildCursor("").length);
      if (families.has(family)) continue;
      const flagged = row.seq !== 0;
      if (flagged) tx.tables.cursors.move(row.name, { seq: 0, at_ms: this.now() });
      const placed = tx.tables.meta.get(walkPlace(family)) !== undefined;
      if (placed) tx.tables.meta.delete(walkPlace(family));
      const kept = tx.tables.meta.get(fingerprintKey(family)) !== undefined;
      if (kept) tx.tables.meta.delete(fingerprintKey(family));
      if (tx.derived.next.clear(family) > 0 || flagged || placed || kept) forgot.push(`rebuild ${family}`);
    }
    for (const family of new Set(tx.derived.extracts.aside.list().map((row) => row.family))) {
      if (families.has(family)) continue;
      tx.derived.extracts.aside.clear(family);
      forgot.push(`set aside ${family}`);
    }
    const runners = heldRunners(this.folder);
    for (const control of tx.tables.controls.list()) {
      if (unpausable(this.registry, sources, control.target, runners) === null) continue;
      forgot.push(`pause ${control.target}`);
      tx.tables.controls.clear(control.target);
    }
    return [...new Set(forgot)];
  }

  async start(locked: string | null, loose: readonly LooseFolder[] = []): Promise<void> {
    sweepDayTemporaries(this.root);
    makeUnder(this.root, join(this.root, "tools"));
    try {
      connectorsGuide(this.root, this.machine);
    } catch (error) {
      this.log({ home: "connectors/README.md not written", error: errorText(error) });
    }
    checkFiles(this.folder);
    this.#db = this.#open();
    this.#settingsMoved();
    this.#copier = this.#openCopier();
    const passes = passesAtStart(this.machine, this.folder, this.now());
    if (passes.revoked.length > 0) this.log({ home: "revoked again", passes: passes.revoked });
    if (passes.restored !== null) this.log({ home: "passes restored", ...passes.restored });
    const devices = this.#db.view();
    let retired: [string, number][];
    try {
      retired = [...new Set(readPrincipals(this.folder).principals.filter((row) => row.kind !== null && row.kind !== "agent" && row.retired_at === undefined).map((row) => row.unit))]
        .flatMap((unit) => { const at = devices.tables.devices.get(unit)?.retired_ms ?? null; return at === null ? [] : [[unit, at] as [string, number]]; });
    } finally {
      devices.close();
    }
    const stamped = retired.flatMap(([unit, at]) => retireUnit(this.folder, unit, at));
    if (stamped.length > 0) this.log({ home: "retired passes stamped", passes: stamped });
    this.#ledger = openLedger(this.folder, { mode: "migrate", log: (line) => this.log(line) });
    const reaped = this.#ledger.reapQuiet(this.now(), callCopiesOf(this.machine.dir, this.homeRoot.id));
    if (reaped !== null && reaped > 0) this.log({ home: "dead calls ended", attempts: reaped });
    const swept = this.#ledger.sent.sweep(this.now(), 0);
    if (swept > 0) this.log({ home: "sent copies swept", copies: swept });
    const settled = settleAccess({ folder: this.folder, access: this.#ledger.access, existing: () => this.#accounts(), now_ms: this.now() });
    if (settled.moved || settled.removed.length > 0) this.log({ home: "access settled", ...settled });
    this.#blobs = this.folder.blobs(join(this.root, "blobs"));
    this.#due = new Due(this);
    const ownPasses = mintOwnPair(this.folder, this.now());
    this.#drive = ownPasses.drive;
    this.#call = ownPasses.call;
    this.#models = new Models({
      settings: () => this.settings, registry: () => this.registry, ledger: this.#ledger, clock: this.now, day: () => this.settings.day,
      found: () => ({ programs: this.#programsAt(), door: this.#door, held: (name) => this.#vault.held(name) }),
      runners: () => listRunners(this.#door, this.#drive, this.#doorFetch),
      paired: () => heldRunners(this.folder),
      unset: () => unfilled(personal(this.folder)),
      fill: (taken) => this.#fillDefaults(taken),
    });
    this.#calls = new Calls({
      root: this.root, machine: this.machine.dir, home: this.homeRoot.id, handOver: (labels) => this.folder.handOver(labels, "call"), command: this.options.call ?? callCommand(), ledger: this.#ledger, model: () => this.settings.model, models: this.#models,
      programs: () => this.#programsAt(), door: () => this.#door, secret: (name, key) => this.#callSecret(name, key), exited: (code) => this.#callEnded(code),
      hiding: (work_id) => {
        const level = sentLevel(this.settings, this.registry.connectors, work_id);
        return level === "none" || this.#hider?.ready(level) === true;
      },
    });
    this.#chatVoice = this.#openChatVoice();
    await this.#finishErasure();
    if (this.#ledger.placeholders.epoch().erasing) {
      const ctx = this.#context((line) => this.log({ home: "erasure", line }), this.root, null, "erase");
      if (await streamsCut(ctx, { all: true })) {
        this.#ledger.placeholders.endErasure();
        this.log({ home: "erasure mark cleared", epoch: this.#ledger.placeholders.epoch().epoch });
      } else this.log({ home: "erasure mark stands", why: "the door's streams are owed a cut" });
    }
    let held: ReturnType<typeof startPrompts> | undefined;
    const read = readDays(this.folder);
    const began = performance.now();
    const parts: Record<string, number> = {};
    const timed = <T>(part: string, work: () => T): T => {
      const at = performance.now();
      try {
        return work();
      } finally {
        parts[`${part}_ms`] = Math.round(performance.now() - at);
      }
    };
    let listed: Listed | undefined;
    try {
      listed = this.#commit((tx) => {
        const now = this.now();
        const requeued = timed("recover", () => tx.tables.jobs.recover());
        const interrupted = timed("interrupt", () => tx.tables.runs.interrupt(now));
        const revived = timed("revive", () => tx.tables.jobs.revive(now));
        const upgraded = upgradeImports(tx);
        if (upgraded.length > 0) this.log({ home: "imports upgraded", moved: upgraded });
        const forgot = timed("forget", () => this.#forget(tx));
        if (forgot.length > 0) this.log({ forgot });
        const cut = pollsCut(this, tx);
        if (cut.length > 0) this.log({ polls: "cut short", acquirers: cut });
        if (loose.length > 0) tx.tables.meta.set(LOOSE_META, JSON.stringify(loose));
        else tx.tables.meta.delete(LOOSE_META);
        this.#enqueue(tx, "index-inbox", "inbox", LANE.polls);
        if (tx.tables.meta.get(QUIET_DONE) === undefined) {
          if (tx.tables.deliveries.walk("", 1).length === 0) {
            if (tx.tables.meta.get(LEFT_FOLDED) === undefined) tx.tables.meta.set(LEFT_FOLDED, String(now));
            tx.tables.meta.set(QUIET_DONE, String(now));
          } else {
            this.#enqueue(tx, "quiet", QUIET_KEY, LANE.polls);
          }
        }
        timed("tally", () => {
          tx.tally.prune(this.settings.day, now);
          const tallied = tx.tally.mark();
          if (tallied === null || !("complete" in tallied)) {
            if (tx.tally.chunks(this.settings.day).length === 0) tx.tally.complete();
            else this.#enqueue(tx, "tally", TALLY_KEY, LANE.backfill);
          }
        });
        timed("held", () => {
          const holding = tx.records.heldMark();
          if (holding === null || !("complete" in holding)) {
            if (tx.records.top() === 0) tx.records.fillHeld();
            else this.#enqueue(tx, "held", HELD_KEY, LANE.backfill);
          }
        });
        timed("left", () => {
          if (tx.tables.asks.filling()) this.#enqueue(tx, "left", LEFT_KEY, LANE.planning);
        });
        timed("stored", () => {
          const daily = this.settings.clocks && tx.tables.meta.get("clock:sweep") !== civilDay(now, this.settings.day);
          if (!("complete" in storedMark(tx)) || (tx.tables.meta.get(STORED_REST) === undefined && !daily)) this.#enqueue(tx, "stored", STORED_KEY, LANE.planning);
        });
        tx.tables.events.append({ at_ms: now, kind: "home", key: "start", detail: { pid: process.pid, requeued, interrupted, revived, forgot } });
        if (passes.restored !== null) tx.tables.events.append({ at_ms: now, kind: "passes", key: "restored", detail: { ...passes.restored } });
        if (locked !== null) {
          tx.tables.meta.set(LOCKED_SINCE, String(now));
          tx.tables.events.append({ at_ms: now, kind: "vault", key: "locked", detail: { why: locked } });
        } else {
          tx.tables.meta.delete(LOCKED_SINCE);
          tx.tables.meta.delete(REFUSED_AT);
          tx.tables.events.append({ at_ms: now, kind: "vault", key: "opened", detail: { by: this.#vault.opened!.by, slot: this.#vault.opened!.slot } });
        }
        tx.tables.meta.delete(KNOCKS);
        held = timed("prompts", () => startPrompts(tx, this.registry.families, this.#ledger.promptTypes()));
        timed("models", () => this.#models.start(tx));
        return this.#due.start(tx, read, parts);
      }, "start");
    } finally {
      const start = { ms: Math.round(performance.now() - began), read_days_ms: "error" in read ? null : read.ms, ...parts };
      this.log(listed === undefined ? { start: { ...start, failed: true } } : {
        start, days: "error" in listed ? { error: listed.error } : { listed: listed.days.length, changed: listed.changed, unread: listed.unread },
      });
    }
    this.#prompted = new Set([...held!.values()].flatMap(({ family }) => [`plan:${family}`, `send:${family}`]));
    if (held!.size > 0) this.log({ prompts: "held", held: Object.fromEntries(held!) });
    this.#sealPlain();
    this.#applyControls();
    const replacedPasses = await ensureStartPasses(this.machine, this.folder, this.settings.unit, this.now());
    if (replacedPasses.length > 0) {
      this.#commit((tx) => {
        for (const replaced of replacedPasses) tx.tables.events.append({ at_ms: this.now(), kind: "pass-revoked", key: replaced.id, detail: { unit: replaced.unit } });
      });
    }
    this.#pool = this.#newPool();
    this.#pairing = new Pairing({ folder: this.folder, home: this.settings.unit, commit: (work) => this.#commit(work), view: () => this.#db.view(), now: this.now, connectors: this.registry.connectors });
    this.#agents = new Agents({
      folder: this.folder, machine: this.machine, commit: (work) => this.#commit(work), tables: this.#ledger.placeholders, access: this.#ledger.access,
      existing: () => this.#accounts(), now: this.now, random: this.options.random ?? randomBytes, log: (line) => this.log(line),
    });
    this.#pairing.ensureAll();
    this.#programs = new Programs({
      dir: this.machine.dir, overridden: (name) => this.machine.overridden(name), log: (line) => this.log(line), ready: () => this.#models.poke(), ...this.options.programs,
    });
    this.#programs.start();
    const home = this;
    this.#writer = new OwnerWriter({
      folder: this.folder, now: this.now, machine: this.machine.dir,
      get settings() { return home.settings; },
      get registry() { return home.registry; },
      get blobs() { return home.#blobs; },
      log: (line) => this.log(line),
      view: () => this.#db.view(),
      commit: (work) => this.#commit(work, "owner"),
      turn: (of, work, under) => this.#turns.run(of, work, under),
    }, { people: peopleDrafter, places: placesDrafter, devices: devicesDrafter }, () => this.#held || this.#stopping || this.#halted !== null);
    const recovered = this.#writer.recover();
    if (recovered.length > 0) this.log({ owner: "recovered", deliveries: recovered });
    this.#socket = await serveSocket(socketPath(this.machine.dir, this.homeRoot.id), (request, out, call) => this.#turns.request(request.verb as string, call, (begun) => this.#dispatch(request, out, begun)).catch((error: unknown) => {
      this.#storageFailed(error);
      throw error;
    }), (request) => this.#kept(request), (verb, sent_ms, answer) => this.#turns.answeredAtArrival(verb, sent_ms, answer));
    const now = this.now();
    this.#nextCheckpoint = now + CHECKPOINT_EVERY_MS;
    this.#nextPrune = now;
    this.#writeLog = this.#newWriteLog();
    this.#openMarking();
    this.#feedback = this.#openFeedback();
    this.#loop = this.#run();
    void this.#surveyPresent().catch((error: unknown) => this.log({ survey: "present", failed: errorText(error) }));
    this.log({ home: "started", root: this.root, release: RELEASE, helpers: this.#helpers, codex: this.machine.codex?.binary ?? null, claude: this.machine.claude?.binary ?? null, vault: locked === null ? { opened: this.#vault.opened!.slot } : { locked } });
  }

  handle(): Home {
    const home = this;
    return {
      root: this.root,
      get settings() {
        return home.settings;
      },
      stats: () => ({ jobs: this.#jobs, calls: this.#calls.started, helpers: { size: this.#pool.size, busy: this.#pool.busy, ending: this.#pool.ending }, ticks: { ...this.#ticks } }),
      stop: () => this.stop(),
      stopped: this.#ended.then(() => this.#why),
    };
  }

  async stop(): Promise<void> {
    if (this.#stopping) return this.#ended;
    this.#stopping = true;
    void this.#marking?.stop();
    this.#writer?.close("Lifestream is stopping: try again in a moment.");
    this.#leaving.abort();
    this.#poke();
    await this.#loop;
    await reachIdle(this.machine);
    await this.close();
    await reachIdle(this.machine);
    await holdOn(this.machine, this.homeRoot, this.#damage, this.now, this.options.lookMs);
    this.homeRoot.close();
    homeLeft(this.root);
    this.#closing("home.lock", () => this.lock.release());
    this.log({ home: "stopped", why: this.#why });
    this.#stopped();
  }

  async close(): Promise<void> {
    this.#listeners.close();
    await Promise.all([
      this.#programs?.close(),
      (this.#marking?.stop() ?? Promise.resolve()).then(() => this.#closing("marks", () => this.#marks?.close())),
      this.#pool?.close(),
      this.#copier?.close(),
    ]);
    await this.#socket?.close();
    this.#closing("due", () => this.#due?.close());
    this.#closing("ledger", () => this.#ledger?.close());
    this.#closing("home.db", () => this.#db?.close());
  }

  #closing(what: string, close: () => void): void {
    try {
      close();
    } catch (error) {
      this.log({ close: what, failed: errorText(error) });
    }
  }

  #settingsMoved(): void {
    const view = this.#db.view();
    let stored: string | null;
    try {
      if (view.tables.meta.get(SETTINGS_MOVE.key) === undefined) return;
      stored = view.tables.meta.get(MODELS_META) ?? null;
    } finally {
      view.close();
    }
    const held = personal(this.folder);
    const move = movedSettings(held, stored);
    const keys = [...new Set([...Object.keys(held), ...Object.keys(move)])].filter((key) => JSON.stringify([Object.hasOwn(held, key), held[key]]) !== JSON.stringify([Object.hasOwn(move, key), move[key]])).sort();
    if (keys.length > 0) {
      replaced(this.folder, move);
      this.log({ settings: "moved", keys });
    }
    this.#db.commit((tx) => { tx.tables.meta.delete(SETTINGS_MOVE.key); });
  }

  #open(): HomeDb {
    return openHome(this.folder, "migrate", {
      ownCheckpoints: true, log: (line) => this.log(line), clock: () => this.now(), day: () => this.settings.day,
    });
  }

  #newPool(): Pool {
    const stations = { door: this.#door, pass: this.#drive };
    const runners = { door: this.#door, call: this.#call, drive: this.#drive };
    return new Pool(this.#helpers, { folder: this.folder, registry: this.module, stations, runners, settings: this.settings, machine: this.machine.dir }, {
      chunk: (job, chunk) => this.#onChunk(job, chunk),
      done: (job, result) => this.#onDone(job, result),
      error: (job, error) => this.#onError(job, error),
      copy: (job, asked) => this.#copy(job, asked),
      secret: (job, asked) => {
        try {
          return this.#secret(job, asked);
        } catch (error) {
          this.#storageFailed(error);
          return { error: { message: errorText(error), reason: "refused" } };
        }
      },
      quiet: (job, rows) => {
        const active = this.#active.get(job);
        if (active === undefined) return;
        const result = active.kind.quiet?.(active.running, rows) ?? null;
        if (result === null) this.#onError(job, { message: "its reader gave no row for ten minutes the home ran" });
        else this.#onDone(job, result);
      },
    }, { quiet_ms: this.options.quietMs ?? READ_QUIET_MS, ...(this.options.stopGraceMs === undefined ? {} : { stop_grace_ms: this.options.stopGraceMs }), now: this.now, turn: (of, work) => this.#turns.run(of, work) });
  }

  #enqueue(tx: Tx, kind: string, key: string, lane: number, not_before_ms?: number): void {
    const now = this.now();
    tx.tables.jobs.enqueue({ kind, key, connector: connectorOfJob(this.registry, tx.tables, kind, key), lane, not_before_ms: not_before_ms ?? now, now_ms: now });
  }

  #enqueuePoll(tx: Tx, name: string, calls: readonly Call[]): void {
    queuePoll(tx, this.registry.connectors, name, this.now(), this.#controls, calls);
  }


  async #run(): Promise<void> {
    const tick = this.#tickMs();
    let ticked = 0;
    while (!this.#stopping) {
      if (this.#halted !== null) {
        void this.stop();
        break;
      }
      try {
        if (this.#held) {
          await this.#sleep(tick);
          continue;
        }
        if (Date.now() - ticked >= tick) {
          ticked = Date.now();
          if (!this.#turns.run("tick", (part) => this.#tick(part))) continue;
        }
        const more = this.#turns.run("take and begin", () => this.#startJobs());
        if (this.#queue.length > 0 || more) {
          if (this.#queue.length > 0) this.#turns.run("queued commit", () => this.#commitNext());
          await yieldTurn();
          continue;
        }
      } catch (error) {
        if (!this.#storageFailed(error)) {
          const { database } = jobError(error);
          this.log({ loop: "failed", ...(database === undefined ? {} : { database }), error: errorText(error) });
        }
      }
      if (!this.#stopping) await this.#sleep(Math.max(1, tick - (Date.now() - ticked)));
    }
  }

  #tickMs(): number {
    return Number.isFinite(this.options.tickMs) && this.options.tickMs! > 0 ? this.options.tickMs! : TICK_MS;
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.#wake = () => {
        this.#wake = null;
        done();
      };
    });
  }

  #poke(): void {
    this.#wake?.();
  }

  #commitNext(): void {
    const item = takeCommit(this.#queue, (job) => this.#active.get(job)?.running);
    if (item === undefined) return;
    const { job } = this.#active.get(item.job)!.running;
    try {
      item.settle?.();
      this.#commit(item.work, `${job.kind} ${job.key} ${item.side}`);
    } catch (error) {
      this.#fail(item.job, error);
      return;
    }
    if (this.#active.get(item.job)?.running.stale === true) {
      this.#abandon(item.job);
      return;
    }
    item.after?.();
  }

  #commit<T>(work: (tx: Tx) => T, of = "other", options: { secure?: boolean } = {}): T {
    if (this.#halted !== null) throw new Error(`the home is stopping: ${this.#halted}`);
    return this.#turns.run(of, (part) => {
      const started = performance.now();
      let worked = started;
      let dued = started;
      try {
        part("work");
        const result = this.#db.commit((tx) => {
          const done = work(tx);
          worked = performance.now();
          part("due");
          this.#due.after(tx);
          dued = performance.now();
          part("commit");
          return done;
        }, options);
        this.#turns.committed(performance.now() - started, dued - worked);
        for (const answer of this.#commitWaits.splice(0)) answer();
        return result;
      } catch (error) {
        this.#storageFailed(error);
        throw error;
      }
    });
  }

  #storageFailed(error: unknown): boolean {
    if (!storageError(error) || error.database === undefined) return false;
    if (!this.homeRoot.look()) {
      if (this.#halted === null) this.#halt(awayWords(this.root));
      return true;
    }
    this.#damage ??= damageIn(error, this.now());
    if (this.#halted !== null) return true;
    this.log({ storage: "failed", database: error.database, error: errorText(error) });
    this.#halt(`storage: ${errorText(error)}`);
    return true;
  }

  #generationFailed(error: unknown): boolean {
    if ((error as { code?: unknown } | null)?.code !== FOLDER_UNLOADED) return false;
    if (this.#halted !== null) return true;
    this.log({ generation: "failed", error: errorText(error) });
    this.#halt(`generation: ${errorText(error)}`);
    return true;
  }

  #callEnded(code: number | null): void {
    if (code === LEDGER_DAMAGED_EXIT) {
      this.#storageFailed(Object.assign(new Error("a call process met the ledger damaged (logs/calls.log says how)"), { code: "SQLITE_CORRUPT", database: LEDGER_DB }));
    }
    this.#chatVoice.wake();
    this.#poke();
  }

  #openChatVoice(): ChatVoice {
    const source = () => `ask:local:${this.settings.unit}`;
    return new ChatVoice({
      source,
      work: () => voiceWorkOf(this.registry.connectors, source()),
      routing: () => {
        const view = this.#db.view();
        try {
          return this.#models.routing(view);
        } finally {
          view.close();
        }
      },
      asker: (blobs) => {
        const prompts = promptsOf(this.registry.families);
        return openAsker({
          ledger: this.#ledger, blobs, clock: this.now,
          prompt: (name) => {
            const found = prompts.get(name);
            if (found === undefined) throw new Error(`no family states prompt ${name}`);
            return found.prompt;
          },
        });
      },
      blobs: this.#blobs, folder: this.folder,
      epoch: () => this.#ledger.placeholders.epoch().epoch,
      copy: (asked) => (this.#copies === undefined ? Promise.resolve({ wait: "Lifestream is starting" }) : this.#copies.make(asked)),
      calls: this.#calls,
      warm: (runner, model, signal) => warmRunner(this.#door, this.#drive, runner, model, signal, this.#doorFetch),
      log: (line) => this.log(line),
      clock: this.now,
    });
  }

  #readNetwork(): void {
    if (this.#network.reading) {
      this.#network.again = true;
      return;
    }
    this.#network = { ...this.#network, reading: true, again: false };
    void readStated(`http://127.0.0.1:${this.settings.door.port}`, this.#drive).then((stated) => {
      if (stated === null || this.#stopping) return;
      this.#stated = stated;
      const view = this.#db.view();
      let pastWaits: boolean;
      try {
        pastWaits = homeNetwork(view.tables, stated).pastWaits;
      } finally {
        view.close();
      }
      if (pastWaits === this.#pastWaits) return;
      this.#pastWaits = pastWaits;
      this.#log(JSON.stringify({ at: new Date(this.now()).toISOString(), past: pastWaits ? "waits" : "moves" }));
    }).catch(() => undefined).finally(() => {
      const again = this.#network.again;
      this.#network = { ...this.#network, reading: false, again: false };
      if (again && !this.#stopping) this.#readNetwork();
    });
  }

  #keepReach(): void {
    const live = () => !this.#stopping && this.#halted === null;
    void keepPublic(this.machine, { live, note: (kept) => this.#keptReach(kept) })
      .catch((error: unknown) => this.log({ reach: "not kept", error: errorText(error) }));
  }

  #readRest(reader: RestReader): void {
    void readAtRest(this.root, this.machine.dir, reader, this.now()).then((read) => {
      if (this.#stopping || this.#halted !== null) return;
      this.#commit((tx) => {
        const kept = tx.tables.meta.get(AT_REST_META);
        const was = kept === undefined ? null : JSON.parse(kept) as AtRest;
        const rest = carry(read, was);
        if (was === null || JSON.stringify({ ...was, at_ms: rest.at_ms }) !== JSON.stringify(rest)) tx.tables.meta.set(AT_REST_META, JSON.stringify(rest));
      });
    }).catch((error: unknown) => this.log({ rest: "not read", error: errorText(error) }));
  }

  #keptReach(kept: Kept): void {
    const now = this.now();
    this.#commit((tx) => noteReach(tx.tables.meta, kept.state, now));
    const state = kept.state;
    if (kept.restored !== null) this.log({ reach: "restored", found: kept.restored });
    else if (state !== null && state.state === "blocked" && !actionable(state)) this.log({ reach: "not kept", why: state.why });
  }

  #halt(why: string): void {
    this.#halted = why;
    this.#why = why;
    this.#poke();
  }

  #tick(part: Part): boolean {
    part("hold");
    if (!this.homeRoot.held()) {
      this.#halt(awayWords(this.root));
      return false;
    }
    const held = readHold(this.machine, this.homeRoot.id);
    if (held !== null) {
      this.#halt(holdLine(held, this.root));
      return false;
    }
    const now = this.now();
    this.#ticks = { count: this.#ticks.count + 1, at_ms: now };
    part("controls");
    this.#applyControls();
    part("pairing");
    this.#pairing.prune();
    part("room");
    this.#room = roomAt(this.root);
    part("models");
    if (this.#models.due(now)) void this.#models.read().catch((error: unknown) => this.log({ models: "not read", error: errorText(error) }));
    part("reap");
    const reaped = this.#ledger.reap(now);
    if (reaped > 0) this.log({ home: "dead calls ended", attempts: reaped });
    part("voice");
    this.#chatVoice.wake();
    part("meaning");
    this.#stateMeaning(TICK_STATE_WAIT_MS);
    part("pick");
    this.#commit((tx) => {
      this.#due.watch(tx);
      const routing = this.#models.tick(tx);
      const meaning = meaningModel(this.settings);
      const ready = meaning !== null && this.#models.fileReady(meaning.unit, meaning.file);
      if (ready && !this.#meaningReady) this.#due.queueNow(tx, "index", SCREEN_INDEX.name, LANE.backfill);
      this.#meaningReady = ready;
      if (this.#hider !== undefined) {
        const waits = JSON.stringify(hidingWaits(this.#hider));
        if (tx.tables.meta.get(HIDING_META) !== waits) tx.tables.meta.set(HIDING_META, waits);
      }
      const paused = (family: string) => covers(this.#controls, { kind: "send", key: family, connector: null }) !== null;
      if (!this.#paused()) for (const family of this.#calls.pick(tx, now, routing, paused)) this.#due.queue(tx, "send", family, LANE.live);
    }, "tick commit");
    part("network");
    if (now >= this.#network.next_ms) {
      this.#network.next_ms = now + NETWORK_ASK_MS;
      this.#readNetwork();
    }
    part("reach");
    if (now >= this.#reachNext_ms) {
      this.#reachNext_ms = now + REACH_LOOK_MS;
      this.#keepReach();
    }
    part("rest");
    if (this.options.rest !== undefined && now >= this.#restNext_ms) {
      this.#restNext_ms = now + REST_LOOK_MS;
      this.#readRest(this.options.rest);
    }
    if (this.settings.clocks) {
      part("polls");
      this.#polls(now);
      part("daily");
      this.#daily(now);
      part("prune");
      if (now >= this.#nextPrune) {
        this.#nextPrune = now + PRUNE_EVERY_MS;
        this.#commit((tx) => {
          tx.tables.events.prune(now);
          tx.tables.jobs.prune(now);
        });
      }
    }
    part("checkpoint");
    this.#checkpoint(now);
    part("marking");
    void this.#marking?.poke();
    part("feedback");
    void this.#feedback.due(now).catch((error: unknown) => this.log({ feedback: "not tried", error: errorText(error) }));
    return true;
  }

  #openFeedback(): Feedback {
    const viewing = <T>(read: (view: ReturnType<HomeDb["view"]>) => T): T => {
      const view = this.#db.view();
      try {
        return read(view);
      } finally {
        view.close();
      }
    };
    return openFeedback({
      folder: this.folder, hider: this.#hider!,
      records: { turn: (chat, n) => viewing((view) => turnOf(view, `ask:local:${this.settings.unit}`, chat, n)) },
      health: {
        connector: async (id) => {
          const connector = this.registry.connectors.find((each) => each.id === id);
          if (connector === undefined) return null;
          let rows: StreamRow[] = [];
          try {
            rows = (await this.#askDoor("/v1/connectors")).rows as unknown as StreamRow[];
          } catch (error) {
            this.log({ feedback: "connector unread", connector: id, error: errorText(error) });
          }
          return connectorFactsOf(connector, rows.find((row) => row.ids.includes(id)), viewing((view) => failedRuns(view.tables.runs, connector)));
        },
      },
      devices: {
        app: (by, said) => appFactsOf(said, this.folder.form === "keyed", {
          macos: macosVersion(), model: viewing((view) => view.tables.devices.get(by)?.model ?? view.tables.devices.get(this.settings.unit)?.model ?? "not stated"),
        }),
      },
      ledger: { once: (row) => void this.#ledger.outbound.once(row) },
      stage: {
        staged: (hash) => {
          const bytes = stagedFile(this.folder, hash).read();
          return bytes === undefined ? undefined : { bytes: () => bytes };
        },
        drop: (hash) => void stagedFile(this.folder, hash).remove(),
      },
      erasing: () => viewing((view) => view.tables.meta.get(INTENT_META) !== undefined),
      url: this.options.feedbackUrl === undefined ? FEEDBACK_URL : this.options.feedbackUrl,
      fetch: this.#doorFetch, clock: this.now, log: (line) => this.log(line),
    });
  }

  async #feedbackVerb(request: JsonObject): Promise<JsonObject> {
    const feedback = this.#feedback;
    if (!feedback.open) return { closed: true };
    const { id, call } = request;
    if (typeof id !== "string") throw new TypeError("feedback names a report's id");
    const gone = { gone: "no draft is held under this id: draft again" };
    if (call === "held") return feedback.held(id) ? { held: true } : gone;
    if (call === "draft") {
      const about = aboutOf(request.about);
      const said = request.device as DeviceSaid | undefined;
      if (about === null || typeof request.by !== "string" || !isObject(said)) throw new TypeError("feedback's draft names its about, its pass's unit and its device");
      return await feedback.draft(id, about, request.by, { kind: said.kind === "mac" || said.kind === "phone" ? said.kind : null, version: typeof said.version === "string" ? said.version : null }) as unknown as JsonObject;
    }
    if (call === "screenshot") {
      const { hash, width, height } = request;
      if (typeof hash !== "string" || typeof width !== "number" || typeof height !== "number") throw new TypeError("feedback's screenshot names its staged hash and its size");
      return feedback.screenshot(id, { hash, width, height }) ? { held: true } : gone;
    }
    if (call === "send") {
      const { text, email, keep, by } = request;
      const kinds = FEEDBACK_KINDS as readonly string[];
      if (typeof text !== "string" || !(email === null || typeof email === "string") || !Array.isArray(keep) || keep.some((kind) => typeof kind !== "string" || !kinds.includes(kind)) || typeof by !== "string") {
        throw new TypeError("feedback's send names its text, email, the kinds kept and its pass's unit");
      }
      return feedback.send(id, { text, email, keep: keep as FeedbackKind[] }, by) as JsonObject;
    }
    throw new TypeError("feedback's call is held, draft, screenshot or send");
  }

  #openMarking(): void {
    const privacy = () => this.settings.privacy;
    this.#marks = openMarks(this.folder, marksFileOf(this.root, this.machine.dir));
    const drive = driveHalf(this.#door, { call: () => this.#call, drive: () => this.#drive }, this.#doorFetch);
    const chosen = () => chosenFor(this.settings, "hiding");
    const detector = openDetector({ chosen, line: "send", drive });
    const pictures = openEnginePictures({
      engine: this.registry.faceEngine ?? faceEngine(), blobs: this.#blobs, findings: findingsDirOf(this.folder, this.machine.dir),
      faces: (blob) => {
        const view = this.#db.view();
        try {
          return scannedFaces(view, blob);
        } finally {
          view.close();
        }
      },
    });
    this.#hider = openHider({ people: () => readNameTable(this.folder, peopleFileOf(this.root, this.machine.dir)), settings: privacy, detector, pictures, marks: this.#marks });
    this.#copies = openCopies({ ledger: this.#ledger, hider: () => this.#hider!, clock: this.now });
    this.#marking = openMarking({
      queues: markingQueues(this.folder, this.machine.dir), hider: this.#hider, detector, marks: this.#marks, chosen: () => detector.state().state !== "off", log: (line) => this.log(line),
      resting: async () => {
        const id = chosen();
        const unit = id === null ? null : hidingPick(id)?.unit;
        const runner = (await drive.list().catch(() => [])).find((each) => each.unit === unit);
        return runner !== undefined && restingOf(runner).go;
      },
    });
  }

  #polls(now: number): void {
    const view = this.#db.view();
    let due: PollDue[];
    try {
      due = pollsDue(this, view.tables, now);
    } finally {
      view.close();
    }
    if (due.length === 0) return;
    const siteOf = (name: string) => chromeSites(this.registry.connectors).find((site) => site.lanes.includes(name));
    const chosen = new Set(this.settings.sites.chosen);
    const enqueue = (lanes: readonly PollDue[]) => {
      if (lanes.length > 0 && !this.#stopping) this.#commit((tx) => { for (const { name, calls } of lanes) this.#enqueuePoll(tx, name, calls); });
    };
    enqueue(due.filter(({ name }) => siteOf(name) === undefined));
    const sited = due.filter(({ name }) => chosen.has(siteOf(name)?.id ?? "")).sort((a, b) => a.due_ms - b.due_ms);
    if (this.#surveying.size === 0) enqueue(sited);
  }

  #stations() {
    return stationsOver(this.#door, this.#drive, { fetch: this.#doorFetch });
  }

  #survey(station: string, granted: readonly string[] = []): { queued: boolean; covers: number; done: Promise<void> } {
    const covers = this.#surveyNumber + 1;
    const running = this.#surveying.get(station);
    if (running !== undefined) {
      running.again = true;
      for (const id of granted) running.granted.add(id);
      return { queued: true, covers, done: running.done };
    }
    const state = { again: false, granted: new Set(granted), done: Promise.resolve() };
    state.done = (async () => {
      try {
        do {
          state.again = false;
          const probes = stationsOver(this.#door, this.#drive, { station, wait_ms: 0, survey: ++this.#surveyNumber, fetch: this.#doorFetch });
          await this.#surveyed(probes, station).catch((error: unknown) => {
            if (!this.#stopping) this.log({ survey: station, failed: errorText(error) });
          });
        } while (state.again);
      } finally {
        this.#surveying.delete(station);
        if (!this.#stopping) this.#commit((tx) => chromeCame(tx, this.registry.connectors, this.settings.sites.chosen, state.granted, this.now(), this.#controls));
        this.#poke();
      }
    })();
    this.#surveying.set(station, state);
    return { queued: false, covers, done: state.done };
  }

  async #surveyed(probes: ReturnType<typeof stationsOver>, station: string): Promise<void> {
    const told = (detail: JsonObject) => {
      if (!this.#stopping) this.#commit((tx) => tx.tables.events.append({ at_ms: this.now(), kind: "sites", key: station, detail }));
    };
    told({ checking: true });
    let changed: Record<string, boolean | null> = {};
    try {
      const off = switchOf(this.registry.connectors, this.settings.sources.off);
      const sites = chromeSites(this.registry.connectors, this.registry.acquirers ?? []);
      const view = this.#db.view();
      let accounts: Map<string, Accounts>;
      try {
        const sources = view.sources();
        accounts = new Map(sites.map((site) => [site.id, accountsOf(this.registry.connectors, sources, site.lanes, off, view.tables.deliveries.fedBy)]));
      } finally {
        view.close();
      }
      ({ changed } = await survey(probes, sites, (site, id) => verdictOf(accounts.get(site.id)!, id)));
      const moved = sites.filter((site) => site.id in changed);
      if (moved.length > 0 && !this.#stopping) {
        const lanes = moved.filter((site) => this.settings.sites.chosen.includes(site.id)).flatMap((site) => site.lanes);
        if (lanes.length > 0 && !this.#stopping) this.#commit((tx) => { for (const lane of lanes) this.#enqueuePoll(tx, lane, ["fetch"]); });
      }
    } finally {
      told({ signed_in: changed });
    }
  }

  async #surveyPresent(): Promise<string[]> {
    const units = [...(await this.#stations().present())];
    for (const unit of units) await this.#survey(unit).done;
    return units;
  }

  #daily(now: number): void {
    const today = civilDay(now, this.settings.day);
    if (this.#dailyDone === today) return;
    const disk = readDisk(this.root, now);
    this.#commit((tx) => {
      if (tx.tables.meta.get("clock:sweep") === today) return;
      tx.tables.meta.set("clock:sweep", today);
      this.#enqueue(tx, "sweep", today, LANE.polls);
      this.#enqueue(tx, "index-inbox", "inbox", LANE.polls);
      tx.tally.prune(this.settings.day, now);
      this.#due.queue(tx, "places", "places", LANE.live);
      this.#enqueue(tx, "stored", STORED_KEY, LANE.planning);
      const revived = tx.tables.jobs.revive(now);
      if (revived.length > 0) tx.tables.events.append({ at_ms: now, kind: "revived", key: today, detail: { jobs: revived } });
      const catch_up = Number(tx.tables.meta.get(CATCH_UP) ?? 0);
      tx.tables.meta.set(CATCH_UP, "0");
      tx.tables.meta.set(FREE_BYTES, JSON.stringify(keepDay(JSON.parse(tx.tables.meta.get(FREE_BYTES) ?? "[]") as FreeDay[], { day: today, ...disk, catch_up })));
    });
    const swept = this.#ledger.sent.sweep(now, UNTAKEN_MS);
    if (swept > 0) this.log({ home: "sent copies swept", copies: swept });
    if (this.#dailyDone !== null) void this.#surveyPresent().catch((error: unknown) => this.log({ survey: "present", failed: errorText(error) }));
    this.#dailyDone = today;
  }

  #checkpoint(now: number): void {
    const clock = this.settings.clocks && now >= this.#nextCheckpoint;
    if (clock) this.#nextCheckpoint = now + CHECKPOINT_EVERY_MS;
    this.#writeLog.tick(clock, new Set(this.#active.keys()));
    if (clock) this.log({ layer: this.#turns.line() });
  }

  #newWriteLog(): WriteLog {
    const view = this.#db.view();
    let kept: string | undefined;
    try {
      kept = view.tables.meta.get(LOG_BEHIND);
    } finally {
      view.close();
    }
    const raised = kept === undefined ? null : (JSON.parse(kept) as LogBehind).since_ms;
    return new WriteLog({
      now: this.now,
      look: () => (this.#walBytes() > 0 ? this.#db.checkpoint("noop") : { busy: 0, log: 0, checkpointed: 0 }),
      copy: () => this.#copier.copy(),
      truncate: (wait_ms) => this.#truncate(wait_ms),
      began: (frames, jobs) => this.log({ log: "draining", frames, jobs }),
      ended: ({ at_ms, end, ...drain }) => {
        this.log({ log: "drained", end, ...drain });
        this.#commit((tx) => tx.tables.events.append({ at_ms, kind: LOG_DRAIN, key: end, detail: drain }));
      },
      need: (since_ms) => {
        const now = this.now();
        const key = since_ms === null ? "end" : "start";
        const bytes = this.#walBytes();
        this.#commit((tx) => {
          if (since_ms === null) tx.tables.meta.delete(LOG_BEHIND);
          else tx.tables.meta.set(LOG_BEHIND, JSON.stringify({ since_ms } satisfies LogBehind));
          tx.tables.events.append({ at_ms: now, kind: LOG_BEHIND, key, detail: { bytes } });
        });
        this.log({ log: "behind", key, bytes });
      },
    }, { ...(this.options.drainPages === undefined ? {} : { drain_pages: this.options.drainPages }), turn_ms: this.options.logTurnMs ?? this.#tickMs() }, raised);
  }

  #walBytes(): number {
    try {
      return statSync(join(this.root, "home.db-wal")).size;
    } catch {
      return 0;
    }
  }

  #openCopier(): Copier {
    return openCopier(this.folder.handOver(["store:home"]), (answer) => this.#copied(answer));
  }

  #copied(answer: CopierAnswer): void {
    if (answer !== "closed" && "lost" in answer) {
      if (this.#storageFailed(answer.lost)) return;
      this.log({ copier: "failed", error: errorText(answer.lost) });
      this.#copyEnded("lost");
    } else this.#copyEnded(answer);
  }

  #copyEnded(end: CopyEnd): void {
    try {
      this.#turns.run("checkpoint", () => {
        if (typeof end === "object") this.#turns.copied(end.ms);
        this.#writeLog.copied(end, new Set(this.#active.keys()));
      });
    } catch (error) {
      if (!this.#storageFailed(error)) {
        const { database } = jobError(error);
        this.log({ checkpoint: "failed", ...(database === undefined ? {} : { database }), error: errorText(error) });
      }
    }
  }

  #truncate(wait_ms: number): Truncated {
    return this.#turns.run("truncate", () => {
      const started = performance.now();
      const result = this.#db.checkpoint("truncate", wait_ms);
      this.#turns.checkpointed(wait_ms === 0 ? performance.now() - started : null, result);
      return result;
    });
  }

  #applyControls(): void {
    const view = this.#db.view();
    let rows: Map<string, ReturnType<typeof view.tables.sources.list>[number]>;
    try {
      this.#controls = new Set([...view.tables.controls.list().map((control) => control.target), ...this.#prompted]);
      rows = new Map(view.tables.sources.list().map((row) => [row.id, row]));
    } finally {
      view.close();
    }
    const off = switchOf(this.registry.connectors, this.settings.sources.off);
    for (const [job, { running }] of [...this.#active]) {
      const { connector } = running.job;
      const paging = running.job.kind === "poll" && connector !== null && (running.state as { call?: unknown } | undefined)?.call === "page";
      const target = covers(this.#controls, running.job) ?? (paging && this.#controls.has(pauseTarget(connector!, true)) ? pauseTarget(connector!, true) : null);
      const labelled = running.job.kind === "label" ? this.registry.labelers?.find((labeler) => labeler.name === running.job.key)?.source : undefined;
      if (target !== null) this.#stopJob(job, `paused by ${target}`);
      else if (labelled !== undefined && off.source(rows.get(labelled) ?? { id: labelled })) this.#stopJob(job, `${labelled} is turned off`);
    }
  }

  #paused(): boolean {
    return this.#controls.has("home");
  }

  #startJobs(): boolean {
    if (this.#stopping || this.#held || !this.#writeLog.mayStart(new Set(this.#active.keys())) || this.#room === "full") return false;
    const free = () => this.#pool.size - this.#active.size;
    while (!this.#stopping && !this.#held && !this.#paused() && free() > 0) {
      const last = free() === 1;
      const history = this.#room !== "ok" || [...this.#active.values()].some((active) => active.running.job.lane === ONE_HELPER);
      const lanes = last ? [LANE.live] : Object.values(LANE).filter((lane) => !(lane === ONE_HELPER && history));
      const skip = [...this.#controls, ...heldBy([...this.#active.values()].map((active) => active.running)), ...(last ? [NOT_LAST] : [])];
      const now = this.now();
      if (!this.#ready(now, lanes, skip)) return false;
      const job = this.#commit((tx) => tx.tables.jobs.take(now, lanes, skip), "take");
      if (job === undefined) return false;
      this.#jobs++;
      if (!this.#begin(job)) return true;
    }
    return false;
  }

  #ready(now: number, lanes: readonly number[], skip: readonly string[]): boolean {
    const view = this.#db.view();
    try {
      return view.tables.jobs.next(now, lanes, skip) !== undefined;
    } finally {
      view.close();
    }
  }

  #begin(job: JobRow): boolean {
    const kind = KINDS[job.kind];
    if (kind === undefined) {
      this.#commit((tx) => { tx.tables.jobs.fail(job.id, `no kind ${job.kind} is known`, this.now()); });
      return false;
    }
    let begun: { data: unknown; state: unknown; holds?: readonly string[] } | null;
    try {
      begun = this.#commit((tx) => {
        const begun = kind.begin === undefined ? { data: undefined, state: undefined } : kind.begin(this, tx, job);
        if (begun === null) this.#finish(tx, { job, state: undefined });
        return begun;
      }, `begin ${job.kind} ${job.key}`);
    } catch (error) {
      if (this.#storageFailed(error)) return false;
      this.#commit((tx) => this.#failed(tx, kind, job, undefined, error));
      return false;
    }
    if (begun === null) return false;
    const running: Running = { job, state: begun.state, ...(begun.holds === undefined ? {} : { holds: begun.holds }) };
    this.#active.set(job.id, { running, kind });
    this.#pool.run({ job: job.id, kind: job.kind, key: job.key, lane: job.lane, now_ms: this.now(), data: begun.data });
    return true;
  }

  #finish(tx: Tx, running: Running): void {
    tx.tables.jobs.finish(running.job.id, this.now());
    const next = nextRun(running);
    if (next !== null) this.#enqueue(tx, running.job.kind, running.job.key, next.lane, next.at_ms);
  }

  running(job: number): Running | undefined {
    return this.#active.get(job)?.running;
  }

  #failed(tx: Tx, kind: Kind, job: JobRow, state: unknown, error: unknown): void {
    const message = errorText(error);
    if (outOfRoom(error)) {
      if (state !== undefined) kind.stopped?.(this, tx, { job, state });
      tx.tables.jobs.stop(job.id, this.now() + ROOM_WAIT_MS);
      this.log({ job: job.kind, key: job.key, waits: "room", error: message });
      return;
    }
    kind.failed?.(this, tx, job, state, message);
    const now = kind.dies ? tx.tables.jobs.fail(job.id, message, this.now()) : tx.tables.jobs.finish(job.id, this.now());
    this.log({ job: job.kind, key: job.key, failed: message, now });
  }


  #onChunk(job: number, chunk: unknown): void {
    const active = this.#active.get(job);
    if (active === undefined || active.kind.chunk === undefined) return;
    failpoint(`home.chunk.${active.running.job.kind}`);
    let slices: Slice[];
    try {
      slices = active.kind.chunk(this, active.running, chunk);
    } catch (error) {
      this.#fail(job, error);
      return;
    }
    if (slices.length === 0) this.#pool.ack(job);
    slices.forEach((slice, index) => {
      const last = index === slices.length - 1;
      this.#queue.push({
        job, side: "chunk", work: slice.work,
        ...(slice.settle === undefined ? {} : { settle: slice.settle }),
        after: () => {
          slice.after?.();
          if (last) this.#pool.ack(job);
        },
      });
    });
    this.#poke();
  }

  #onDone(job: number, result: unknown): void {
    const active = this.#active.get(job);
    if (active === undefined) return;
    const { running, kind } = active;
    this.#queue.push({
      job, side: "done",
      work: (tx) => {
        kind.done(this, tx, running, result);
        this.#finish(tx, running);
      },
      after: () => {
        if (running.refused === true) for (const [name, value] of active.handed ?? []) this.#refusedKeys.set(name, value);
        this.#active.delete(job);
        this.#poke();
      },
    });
    this.#poke();
  }

  #onError(job: number | null, error: unknown): void {
    if (this.#storageFailed(error) || this.#generationFailed(error) || job === null) return;
    const active = this.#active.get(job);
    if (active === undefined) return;
    this.#queue.push({
      job, side: "fail",
      work: (tx) => this.#failed(tx, active.kind, active.running.job, active.running.state, error),
      after: () => {
        this.#active.delete(job);
        this.#poke();
      },
    });
    this.#poke();
  }

  #drop(job: number): Active | undefined {
    this.#queue = this.#queue.filter((item) => item.job !== job);
    const active = this.#active.get(job);
    this.#active.delete(job);
    if (active !== undefined) this.#pool.stop(job);
    return active;
  }

  #stateMeaning(waitMs: number): void {
    const settings = meaningSettingsOf(meaningModel(this.settings));
    if (settings === this.#meaningStated) return;
    if (ScreenIndex.stateMeaning(this.folder, screenFileOf(searchFileOf(this.root, this.machine.dir)), settings, waitMs)) this.#meaningStated = settings;
  }

  #stopJob(job: number, why: string): void {
    const active = this.#drop(job);
    if (active === undefined) return;
    try {
      this.#commit((tx) => {
        active.kind.stopped?.(this, tx, active.running);
        tx.tables.jobs.stop(job, this.now());
      });
    } catch (error) {
      this.log({ job: active.running.job.kind, key: active.running.job.key, stopped: why, unrecorded: errorText(error) });
      return;
    }
    this.log({ job: active.running.job.kind, key: active.running.job.key, stopped: why });
  }

  #fail(job: number, error: unknown): void {
    if (this.#storageFailed(error)) return;
    const message = errorText(error);
    const active = this.#drop(job);
    if (active === undefined) return;
    try {
      this.#commit((tx) => this.#failed(tx, active.kind, active.running.job, active.running.state, error));
    } catch (error) {
      this.log({ job: active.running.job.kind, key: active.running.job.key, failed: message, unrecorded: errorText(error) });
    }
  }

  #abandon(job: number): void {
    const active = this.#drop(job);
    if (active === undefined) return;
    this.#commit((tx) => this.#finish(tx, active.running));
    this.log({ job: active.running.job.kind, key: active.running.job.key, abandoned: "its cursor was reset under it" });
    this.#poke();
  }


  #seal(secret: unknown, value: unknown): { sealed: string; key: string } {
    if (typeof secret !== "string" || typeof value !== "string") throw new TypeError("seal names a secret and its value");
    const id = this.#vault.seal(secret, value);
    this.#commit((tx) => {
      tx.tables.events.append({ at_ms: this.now(), kind: "secret", key: secret, detail: { sealed: id } });
      this.#pollAgain(tx, (row) => row.outcome === "need" && row.reason === "password" && row.facts.secret === secret, true);
      this.#pollRunningAgain(tx, (name) => name === secret);
      for (const labeler of this.registry.labelers ?? []) if (labeler.secrets?.includes(secret) === true) this.#due.queue(tx, "label", labeler.name, LANE.live);
    });
    this.log({ secret: "sealed", name: secret, key: id });
    this.#poke();
    return { sealed: secret, key: id };
  }

  #unseal(secret: string): void {
    this.#vault.remove(secret);
    this.#commit((tx) => tx.tables.events.append({ at_ms: this.now(), kind: "secret", key: secret, detail: { removed: true } }));
    this.log({ secret: "removed", name: secret });
  }

  #copy(job: number, asked: Parameters<Copies["make"]>[0]): Promise<CopyAnswer> {
    if (this.#active.get(job)?.running.job.kind !== "send" || this.#copies === undefined) return Promise.resolve({ wait: "Only a send run is handed a sent copy" });
    return this.#copies.make(asked).catch((error: unknown): CopyAnswer => {
      this.#storageFailed(error);
      return { error: `the sent copy was not made: ${errorText(error)}` };
    });
  }

  #secret(job: number, asked: SecretAsked): SecretAnswer {
    const running = this.#active.get(job)?.running.job;
    const task = running === undefined ? `job:${job}` : `${running.kind}:${running.key}`;
    const lane = running?.kind === "poll" ? running.key : task;
    let answer: SecretAnswer;
    let quarantined: string | null = null;
    const allowed = running?.kind === "poll" ? this.#pollSecrets(running.key)
      : running?.kind === "label" ? new Set((this.registry.labelers ?? []).find((each) => each.name === running.key)?.secrets ?? []) : new Set<string>();
    if (!allowed.has(asked.name)) {
      answer = { error: { message: `${asked.name} is not a secret of ${lane}: refused`, reason: "refused" } };
    } else if ((quarantined = this.#quarantined(asked.name, lane)) !== null) {
      answer = { error: { message: `${asked.name} is ${quarantined}'s, which is signed out: ${lane} uses it once ${quarantined} is signed in again`, reason: "refused" } };
    } else {
      try {
        if (asked.op === "get") {
          const value = this.#vault.get(asked.name) ?? null;
          if (value !== null && this.#refusedKeys.get(asked.name) === value) {
            answer = { error: { message: `${asked.name} was refused by its company: it is used again once another is sealed`, reason: "refused" } };
          } else {
            answer = { value };
            const active = this.#active.get(job);
            if (value !== null && active !== undefined) (active.handed ??= new Map()).set(asked.name, value);
            if (value === null && active !== undefined) (active.unanswered ??= new Set()).add(asked.name);
          }
        } else {
          this.#vault.rotate(asked.name, asked.value);
          answer = {};
        }
      } catch (error) {
        answer = { error: { message: errorText(error), reason: error instanceof SecretError ? error.reason : "refused" } };
        const active = this.#active.get(job);
        if (answer.error!.reason === "locked" && active !== undefined) (active.unanswered ??= new Set()).add(asked.name);
      }
    }
    this.#record({ at_ms: this.now(), secret: asked.name, op: asked.op, lane, task, ok: answer.error === undefined });
    return answer;
  }

  #pollSecrets(name: string): Set<string> {
    const acquirer = (this.registry.acquirers ?? []).find((each) => each.name === name);
    const connector = connectorOf(this.registry.connectors, name);
    const { fields } = connectorSettings(connector, this.settings.connectors[connector.id]);
    const named = Object.entries(connector.fields ?? {}).flatMap(([field, declared]) => (declared.kind === "secret" && typeof fields[field] === "string" ? [fields[field] as string] : []));
    return new Set([...named, ...(acquirer?.secrets ?? [])]);
  }

  #quarantined(name: string, asking: string): string | null {
    const view = this.#db.view();
    try {
      for (const connector of this.registry.connectors) {
        const block = this.settings.connectors[connector.id];
        const route = routeOf(connector, block);
        if (route === null || route.acquirer === asking) continue;
        if (outcomesOf(view.tables, route.acquirer, (row) => row.outcome === "need" && row.reason === "signed-out").length === 0) continue;
        if (connectorSettings(connector, block).fields[secretFieldOf(connector, route)] === name) return route.acquirer;
      }
      return null;
    } finally {
      view.close();
    }
  }

  #accounts(): Existing[] {
    const view = this.#db.view();
    try {
      return offeredOf(view.sources(), this.registry.connectors, this.registry.families).map(({ account, category }) => ({ account, category }));
    } finally {
      view.close();
    }
  }

  get #door(): string {
    return `http://127.0.0.1:${this.settings.door.port}`;
  }

  async #askDoor(route: string, body?: JsonObject): Promise<JsonObject> {
    let response: Response;
    try {
      const authorization = { authorization: `Bearer ${this.#drive}` };
      response = await this.#doorFetch(`${this.#door}${route}`, body === undefined ? { headers: authorization }
        : { method: "POST", headers: { ...authorization, "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (error) {
      if (error instanceof TypeError) notNow("busy", DOOR_AWAY, RETRY_SOON_S);
      throw error;
    }
    const answer = await response.json() as JsonObject;
    if (response.ok) return answer;
    const { code, message, ...extra } = answer;
    const words = typeof message === "string" ? message : `the door answered ${response.status}`;
    if (typeof code !== "string") throw new Error(words);
    const retry = Number(response.headers.get("retry-after") ?? NaN);
    throw new Refusal(response.status, code, words, Number.isFinite(retry) ? retry : undefined, extra);
  }

  async #cutStreams(removed: Removed): Promise<void> {
    const { blobs = [], ...rest } = removed;
    for (let at = 0; at === 0 || at < blobs.length; at += CUT_MOST) {
      const part = blobs.slice(at, at + CUT_MOST);
      const answer = await this.#askDoor("/v1/streams/leaving", { ...at === 0 ? rest as JsonObject : {}, ...part.length === 0 ? {} : { blobs: [...part] } });
      if (typeof answer.cut !== "number") throw new Error("the door did not say it cut the streams");
    }
  }

  #callSecret(name: string, key: string): Record<string, string> {
    if (name === CALL_PASS) return { [name]: this.#call };
    const value = this.#vaultRead(name);
    this.#record({ at_ms: this.now(), secret: name, op: "get", lane: "model", task: `call:${key}`, ok: value !== undefined });
    return value === undefined ? {} : { [name]: value };
  }

  #vaultRead(name: string): string | undefined {
    try {
      return this.#vault.get(name);
    } catch {
      return undefined;
    }
  }

  routing(tx: Tx): Routing {
    return this.#models.routing(tx);
  }

  #programsAt(): Record<string, ProgramAt> {
    const { codex, claude } = this.machine;
    return { ...(codex === null ? {} : { codex }), ...(claude === null ? {} : { claude }) };
  }

  #fillDefaults(taken: Partial<Record<UseId, string>>): void {
    const ids = Object.fromEntries(Object.entries(taken).flatMap(([use, id]) => id === undefined ? [] : [[use, id]])) as Partial<Record<UseId, string>>;
    const members: JsonObject = {};
    for (const [use, id] of Object.entries(ids) as [UseId, string][]) {
      members[`model.defaults.${use}`] = id;
      const thinking = MODEL_USES[use].fill?.thinking ?? null;
      if (thinking !== null) members[`model.thinking.${use}`] = thinking;
    }
    try {
      planned(this.folder, members).write();
      const { defaults, thinking } = effective(this.folder).settings;
      this.settings = { ...this.settings, defaults, thinking };
      this.log({ models: "defaults", taken: ids });
    } catch (error) {
      this.log({ models: "defaults not written", error: errorText(error) });
    }
  }

  #modelReach(model: unknown): Extract<ModelReach, { url: string }> {
    const named = typeof model === "string" ? readRouteId(model) : null;
    if (typeof model !== "string" || named === null) throw new TypeError("model-reach names a model by its id");
    const view = this.#db.view();
    let reach: ModelReach;
    try {
      reach = this.#models.reach(view, model, (name) => this.#vaultRead(name));
    } finally {
      view.close();
    }
    if ("refused" in reach) {
      if (reach.refused === "NO_MODEL") throw new Refusal(404, "NO_MODEL", NO_MODEL_WORDS);
      throw new Refusal(409, "NOT_READY", reach.line, undefined, { line: reach.line });
    }
    const secret = transportSecret(named.transport, this.settings.model.transports);
    if (secret !== null) this.#record({ at_ms: this.now(), secret, op: "get", lane: "door", task: "chat", ok: Object.keys(reach.headers).length > 0 });
    return reach;
  }

  async #placesSearch(request: JsonObject): Promise<googlePlaces.TypedAnswer> {
    const { latitude, longitude, q } = request;
    if (typeof latitude !== "number" || typeof longitude !== "number" || typeof q !== "string") throw new TypeError("places-search names a latitude, a longitude and the words typed, q");
    const search = this.registry.placesSearch;
    let stored: string | undefined;
    try {
      stored = search === undefined ? undefined : this.#vault.get(search.secret);
    } catch {
      stored = undefined;
    }
    const key = stored?.trim();
    const held = key !== undefined && key !== "";
    const refused = held && this.#refusedKeys.get(search!.secret) === stored;
    if (search !== undefined) {
      const seen = !held ? "no key" : `${refused ? "refused" : "key"}:${createHash("sha256").update(stored!).digest("hex")}`;
      const now = this.now();
      if (this.#searchLogged === undefined || this.#searchLogged.seen !== seen || now - this.#searchLogged.at_ms >= SEARCH_LOG_MS) {
        this.#searchLogged = { seen, at_ms: now };
        this.#record({ at_ms: now, secret: search.secret, op: "get", lane: "door", task: "places-search", ok: held && !refused });
      }
    }
    if (!held) return { google: "no key" };
    if (refused) return { google: "refused" };
    let answer: googlePlaces.TypedAnswer;
    try {
      answer = await googlePlaces.typedSearch({ key: key!, endpoint: search!.endpoint, lookup: (sent) => void this.#ledger.outbound.write(lookupRow("places-search", sent, this.now())) }, { latitude, longitude }, q);
    } catch (error) {
      if (error instanceof RangeError) throw error;
      this.log({ search: "unwritten", error: errorText(error) });
      return { google: "unreachable" };
    }
    if (answer.google === "refused") this.#refusedKeys.set(search!.secret, stored!);
    return answer;
  }

  #record(request: SecretRequest): void {
    this.#requests = [...this.#requests.slice(-(REQUESTS_KEPT - 1)), request];
    this.log({ ...request });
  }

  #sealPlain(): void {
    const tried = this.#vault.sealPlain();
    if (tried === null) return;
    const { sealed, failed } = tried;
    this.#commit((tx) => {
      if (sealed.length > 0) tx.tables.events.append({ at_ms: this.now(), kind: "vault", key: "sealed", detail: { items: sealed } });
      if (failed.length > 0) tx.tables.meta.set(UNSEALED, JSON.stringify(failed.map((item) => item.name)));
      else tx.tables.meta.delete(UNSEALED);
    });
    if (sealed.length > 0 || failed.length > 0) this.log({ vault: "sealed", items: sealed, unsealed: failed });
  }

  #vaultVerb(verb: string, request: JsonObject): unknown {
    const now = this.now();
    const held = this.#vault.key !== null;
    const kept = this.#vault.kept;
    let answer: unknown;
    let event: { key: string; detail: Record<string, Json> };
    try {
      switch (verb) {
        case "vault-init": {
          const made = this.#vault.init({ machine: this.#newSlot(request), key: request.key === undefined ? null : keyOf(request.key, "key") }, now);
          answer = made;
          event = { key: "init", detail: { key_id: made.key_id, slot: made.slot } };
          break;
        }
        case "vault-new": {
          const outcome = this.#vault.newVault(this.#newSlot(request), now);
          if ("opened" in outcome) {
            answer = outcome;
            event = { key: "unlocked", detail: { slot: this.#vault.opened?.slot ?? null } };
            break;
          }
          answer = outcome.made;
          event = { key: "new", detail: { key_id: outcome.made.key_id, slot: outcome.made.slot, removed: outcome.removed } };
          break;
        }
        case "vault-confirm": {
          const confirmed = this.#vault.confirm(textOf(request.recovery), now);
          answer = { confirmed };
          event = { key: "confirmed", detail: { slot: confirmed } };
          break;
        }
        case "vault-recovery": {
          const made = this.#vault.newRecovery(now, request.recovery);
          answer = "recovery" in made ? made : { slot: made.number, day: civilDay(made.made_ms, { zone: this.settings.day.zone, day_start_hour: 0 }) };
          event = { key: "recovery", detail: { slot: made.recovery_slot } };
          break;
        }
        case "unlock": {
          answer = { key_id: this.#vault.unlock(keyOf(request.slot_key, "slot_key"), now) };
          if (held) return answer;
          event = { key: "unlocked", detail: { slot: this.#vault.opened?.slot ?? null } };
          break;
        }
        case "recover": {
          const { recovery: _confirmed, ...recovered } = this.#vault.recover(textOf(request.recovery), this.#newSlot(request), now);
          answer = recovered;
          event = { key: "recovered", detail: { slot: recovered.slot } };
          break;
        }
        case "vault-discard": {
          const discarded = this.#vault.discard();
          if (discarded.dropped.length === 0) return discarded;
          answer = discarded;
          event = { key: "discarded", detail: { dropped: discarded.dropped } };
          break;
        }
        case "vault-slot": {
          const machine = this.#newSlot(request);
          if (machine === null) throw new TypeError("vault-slot hands this Mac's new slot key, slot_key");
          const added = this.#vault.addSlot(machine, now);
          answer = added;
          event = { key: "slot", detail: added };
          break;
        }
        default:
          throw new TypeError(`${verb} is not a verb of the vault`);
      }
    } catch (error) {
      const why = error instanceof Refusal && error.code === VAULT_KEY ? error.words : error instanceof VaultError ? error.message : null;
      if (verb === "unlock" && why !== null) {
        const first = this.#commit((tx) => {
          if (tx.tables.meta.get(REFUSED_AT) !== undefined) return false;
          tx.tables.meta.set(REFUSED_AT, String(now));
          tx.tables.events.append({ at_ms: now, kind: "vault", key: "refused", detail: { why } });
          return true;
        });
        if (first) this.log({ vault: "refused", why });
      }
      throw error;
    }
    const opened = !held && this.#vault.key !== null;
    this.#commit((tx) => {
      tx.tables.events.append({ at_ms: now, kind: "vault", key: event.key, detail: event.detail });
      if (!kept && this.#vault.kept) {
        this.#pollAgain(tx, (row) => row.outcome === "wait" && row.reason === "vault");
        this.#pollRunningAgain(tx, () => true);
      }
      if (!opened) return;
      tx.tables.meta.delete(LOCKED_SINCE);
      tx.tables.meta.delete(REFUSED_AT);
      tx.tables.events.append({ at_ms: now, kind: "vault", key: "opened", detail: { by: this.#vault.opened!.by, slot: this.#vault.opened!.slot } });
    });
    this.log({ vault: event.key, ...event.detail });
    this.#sealPlain();
    this.#poke();
    return answer;
  }

  #newSlot(request: JsonObject): NewMachineSlot | null {
    return newSlotOf(request, () => this.settings.unit);
  }

  #pollRunningAgain(tx: Tx, answerable: (secret: string) => boolean): void {
    for (const { running, unanswered } of this.#active.values()) {
      if (running.job.kind === "poll" && [...unanswered ?? []].some(answerable)) this.#enqueuePoll(tx, running.job.key, BY_HAND);
    }
  }

  #pollAgain(tx: Tx, waits: (row: AttemptRow) => boolean, clear = false): void {
    for (const acquirer of this.registry.acquirers ?? []) {
      const rows = outcomesOf(tx.tables, acquirer.name, waits);
      if (rows.length === 0) continue;
      this.#enqueuePoll(tx, acquirer.name, BY_HAND);
      if (clear) needsMet(tx, rows, this.now());
    }
  }


  async #finishErasure(): Promise<void> {
    const ctx = this.#context((line) => this.log({ home: "erasure", line }), this.root, null, "erase");
    const intent = standingIntent(ctx);
    if (intent === null) return;
    try {
      const applied = await resumeErasure(ctx, intent);
      if (applied === null) this.log({ home: "erasure ended", family: intent.family, why: "names no record" });
      else this.log({ home: "erasure finished", family: intent.family, run: applied.run });
    } catch (error) {
      if (storageError(error)) throw error;
      this.log({ home: "erasure unfinished", family: intent.family, step: standingIntent(ctx)?.step ?? null });
    }
  }

  #context(out: Out, cwd: string, by: string | null, verb: string, left?: AbortSignal): VerbContext {
    const db = this.#db;
    return {
      folder: this.folder,
      machine: this.machine,
      cwd,
      by,
      db: { path: db.path, mode: db.mode, migrated: db.migrated, commit: (work, options) => this.#commit(work, `verb ${verb}`, options), view: () => this.#db.view(), checkpoint: (mode, wait_ms) => this.#db.checkpoint(mode, wait_ms), close: () => this.#db.close() },
      blobs: this.#blobs,
      ledger: this.#ledger,
      settings: this.settings,
      registry: async () => {
        await this.#built;
        return this.registry;
      },
      now: this.now,
      out: (line) => out(line),
      going: (line) => out(line, true),
      calls: {
        ...(this.options.erasureCallsMs === undefined ? {} : { limit_ms: this.options.erasureCallsMs }),
        signal: AbortSignal.any([this.#leaving.signal, ...(this.options.signal === undefined ? [] : [this.options.signal]), ...(left === undefined ? [] : [left])]),
      },
      cutStreams: (blobs) => this.#cutStreams(blobs),
      background: () => this.#commit((tx) => this.#enqueue(tx, "sweep", civilDay(this.now(), this.settings.day), LANE.polls)),
      committed: () => new Promise<void>((resolve, reject) => {
        const ended = AbortSignal.any([this.#leaving.signal, ...(left === undefined ? [] : [left])]);
        if (ended.aborted) return reject(new Error("the home is stopping"));
        ended.addEventListener("abort", () => reject(new Error("the home is stopping")), { once: true });
        this.#commitWaits.push(resolve);
      }),
      pairing: this.#pairing,
      agents: this.#agents,
      ...(this.#feedback === undefined ? {} : { feedback: this.#feedback }),
      door: (route, body) => this.#askDoor(route, body),
      stations: () => this.#stations(),
      stated: () => readStated(this.#door, this.#drive),
      readModels: async () => {
        await this.#models.read();
        this.#commit((tx) => { this.#models.tick(tx); });
      },
      survey: () => this.#surveyPresent(),
      refreshAll: async (connector) => await this.#askDoor("/v1/refresh", { connector }) as unknown as RefreshAnswer,
      settingsChanged: (keys = []) => {
        this.#commit((tx) => {
          for (const key of keys.length === 0 ? [SETTINGS_EVENT] : keys) tx.tables.events.append({ at_ms: this.now(), kind: SETTINGS_EVENT, key });
        });
        const written = effective(this.folder).settings;
        const faces = facesRun(this.settings, this.root);
        const offBefore = this.settings.sources.off;
        const off = offBefore.join("\0");
        const grouped = (blocks: Settings["connectors"]) => JSON.stringify(this.registry.connectors.map((connector) =>
          Object.entries(blocks[connector.id] ?? {}).filter(([member]) => connector.fields?.[member]?.home === true).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)));
        const groupsBefore = grouped(this.settings.connectors);
        const moved = JSON.stringify(written.connectors) !== JSON.stringify(this.settings.connectors);
        const transports = JSON.stringify(written.model.transports ?? {}) !== JSON.stringify(this.settings.model.transports ?? {});
        const runners = JSON.stringify(written.runners) !== JSON.stringify(this.settings.runners);
        const privacy = JSON.stringify(written.privacy) !== JSON.stringify(this.settings.privacy);
        const [meaningWritten, meaningRunning] = [meaningModel(written), meaningModel(this.settings)];
        const search = JSON.stringify(meaningWritten) !== JSON.stringify(meaningRunning);
        const meaningMoved = meaningWritten?.unit !== meaningRunning?.unit || meaningWritten?.file !== meaningRunning?.file;
        const started = written.history.start !== this.settings.history.start;
        this.settings = {
          ...this.settings, sources: written.sources, sites: written.sites, connectors: written.connectors, clients: written.clients, model: written.model,
          defaults: written.defaults, thinking: written.thinking, runners: written.runners, privacy: written.privacy, search: written.search, history: written.history,
        };
        if (transports || runners) this.#models.poke();
        if (moved || search || started) {
          this.#pool.settings(this.settings);
          if (moved) this.#built = this.#lanesChanged().catch((error: unknown) => this.#log(JSON.stringify({ at: new Date(this.now()).toISOString(), registry: "not built again", error: errorText(error) })));
        } else if (privacy) {
          this.#pool.privacy(this.settings.privacy);
        }
        if (search) {
          if (meaningMoved) {
            this.#stateMeaning(CHANGE_STATE_WAIT_MS);
            for (const [job, { running }] of [...this.#active]) if (running.job.kind === "index" && running.job.key === SCREEN_INDEX.name) this.#stopJob(job, "search by meaning changed");
          }
          this.#commit((tx) => this.#due.queueNow(tx, "index", SCREEN_INDEX.name, LANE.backfill));
        }
        if (facesRun(this.settings, this.root) !== faces) this.#commit((tx) => this.facesTurned(tx));
        const turned = this.settings.sources.off.join("\0") !== off;
        if (turned || grouped(this.settings.connectors) !== groupsBefore) {
          const was = switchOf(this.registry.connectors, offBefore);
          const is = switchOf(this.registry.connectors, this.settings.sources.off);
          this.#commit((tx) => {
            this.#due.queue(tx, "people", "people", LANE.live);
            if (!turned) return;
            for (const labeler of this.registry.labelers ?? []) {
              const row = tx.tables.sources.get(labeler.source) ?? { id: labeler.source };
              if (was.source(row) && !is.source(row)) this.#due.queue(tx, "label", labeler.name, LANE.live);
            }
          });
        }
      },
      hold: (work) => this.#quiet(work),
    };
  }

  facesTurned(tx: Tx): void {
    this.#pool.settings(this.settings);
    tx.tables.dirty.units("photos", tx.derived.extracts.units("photos").map((row) => row.unit));
  }

  polled(left: Polled | null): void {
    this.#turns.polled(left);
  }

  async #quiet<T>(work: () => Promise<T> | T): Promise<T> {
    if (this.#held) throw new Error("the home is already held");
    this.#held = true;
    try {
      const copierClosed = this.#copier.close();
      await this.#pool.close();
      for (const job of [...this.#active.keys()]) this.#stopJob(job, "the home is held");
      sweepDayTemporaries(this.root);
      await copierClosed;
      return await work();
    } finally {
      if (this.#halted === null) {
        this.#pool = this.#newPool();
        this.#copier = this.#openCopier();
      }
      this.#held = false;
      this.#writer.drain();
      this.#poke();
    }
  }

  async #exclusive<T>(work: () => Promise<T> | T): Promise<T> {
    return this.#quiet(async () => {
      this.#db.close();
      try {
        return await work();
      } finally {
        try {
          this.#db = this.#open();
        } catch (error) {
          if (!this.#storageFailed(error)) this.#halt(`home.db did not open again: ${errorText(error)}`);
          throw error;
        }
      }
    });
  }

  #kept(request: JsonObject): ReturnType<KeptRead> {
    if (request.verb !== "owner-act") return null;
    try {
      const answer = this.#writer.answered(request.action);
      return answer === null ? null : { kept: answer };
    } catch (error) {
      return { unreadable: error };
    }
  }

  async #oneConnect<T>(connect: () => Promise<T>): Promise<T> {
    if (this.#connecting) throw new VerbError("An account is connecting already: wait for its answer");
    this.#connecting = true;
    try {
      return await connect();
    } finally {
      this.#connecting = false;
    }
  }

  async #lanesChanged(): Promise<void> {
    const { acquirers, labelers, placesSearch } = await loadRegistry(this.module, this.settings, homeOf(this.folder));
    const { placesSearch: _was, ...held } = this.registry;
    this.registry = { ...held, acquirers: acquirers ?? [], labelers: labelers ?? [], ...(placesSearch === undefined ? {} : { placesSearch }) };
    this.#commit((tx) => this.#parkRoutes(tx, new Set((this.registry.acquirers ?? []).map((acquirer) => acquirer.name))));
  }

  #parkRoutes(tx: Tx, built: ReadonlySet<string>): void {
    const routes = this.#routes();
    for (const row of tx.tables.polls.list()) if (!built.has(row.acquirer) && routes.has(row.acquirer)) parkPoll(tx, row.acquirer);
    for (const acquirer of this.registry.acquirers ?? []) if (built.has(acquirer.name)) unparkPoll(tx, acquirer);
  }

  #routes(): Set<string> {
    return new Set(this.registry.connectors.flatMap((connector) => (connector.signin ?? []).map((route) => route.acquirer)));
  }

  async #dispatch(request: JsonObject, out: Out, call: SocketCall): Promise<unknown> {
    this.#realRoot ??= realPath(this.root);
    refuseOtherFolder(this.root, this.#realRoot, request.folder);
    const verb = request.verb as string;
    if (verb !== "owner-act") call.began();
    if (verb === "retire") {
      const retired = retire(this.root, this.now());
      this.#why = `retired: ${this.root} holds RETIRED.json`;
      setTimeout(() => void this.stop(), 0);
      return retired;
    }
    if (verb === "generation") return handed(this.root);
    if (verb === "stop") {
      if (this.#why === "stopped") this.#why = "stopped: a move or a verify asked";
      setTimeout(() => void this.stop(), 0);
      return { stopping: true };
    }
    if (verb === "sealed") {
      if (request.delivery === undefined) {
        this.#commit((tx) => lookAtInbox(tx, this.now()));
        this.#poke();
        return { looking: true };
      }
      if (typeof request.delivery !== "string") throw new TypeError("sealed names a delivery, or none");
      failpoint("home.nudged");
      const added = this.#commit((tx) => indexNudged(this, tx, request.delivery as string));
      this.#poke();
      return { indexed: added };
    }
    if (verb === "vault") return { ...this.#vault.state(), requests: this.#requests };
    if (verb === "vault-check") return this.#vault.check(textOf(request.recovery));
    if (verb === "vault-init" || verb === "vault-new" || verb === "vault-confirm" || verb === "vault-recovery" || verb === "vault-discard" || verb === "vault-slot" || verb === "unlock" || verb === "recover") {
      try {
        return this.#vaultVerb(verb, request);
      } finally {
        this.#models.poke();
      }
    }
    if (verb === "seal") {
      try {
        if (request.value !== null) return this.#seal(request.secret, request.value);
        if (typeof request.secret !== "string") throw new TypeError("seal names a secret and its value");
        this.#unseal(request.secret);
        return { removed: request.secret };
      } finally {
        this.#models.poke();
      }
    }
    if (verb === "chat-voice") {
      try {
        return await this.#chatVoice.verb(request);
      } finally {
        this.#poke();
      }
    }
    if (verb === "model-reach") return this.#modelReach(request.model);
    if (verb === "models-list") return { listing: this.#models.listStale() };
    if (verb === "models-read") {
      await this.#models.readAgain();
      this.#commit((tx) => { this.#models.tick(tx); });
      return { read: true };
    }
    if (verb === "subscriptions") {
      const name = request.choose;
      if (name === undefined) return { programs: this.#programs!.state() };
      if (!isProgramName(name)) throw new TypeError("subscriptions chooses a program by its name");
      return { programs: this.#programs!.choose(name) };
    }
    if (verb === "owner-act") {
      if (typeof request.device !== "string" || request.device === "") throw new TypeError("owner-act names the device that acted, and the action");
      try {
        return await this.#writer.act(request.device, request.action, call);
      } finally {
        this.#poke();
      }
    }
    if (verb === "places-search") return this.#placesSearch(request);
    if (verb === "account-connect" || verb === "device-start" || verb === "device-poll" || verb === "client-start" || verb === "client-finish" || verb === "seal-field") {
      const context = this.#context(out, this.root, "you", verb);
      const vault: Sealing = {
        sealable: () => this.#vault.sealable(), seal: (secret, value) => this.#seal(secret, value), names: () => this.#vault.names(), read: (secret) => this.#vault.get(secret),
        remove: (secret) => {
          try {
            this.#unseal(secret);
          } catch (error) {
            this.log({ secret: "not removed", name: secret, error: errorText(error) });
          }
        },
      };
      const within = this.options.signinMs ?? SIGNIN_MS;
      if (verb === "device-start") return deviceStart(context, request, vault, within);
      if (verb === "client-start") return clientStart(context, request, vault, (state) => this.#listeners.open(state), within);
      return this.#oneConnect(async () => {
        const answer = verb === "seal-field" ? await sealField(context, request, vault, within)
          : verb === "account-connect" ? await accountConnect(context, request, vault, within)
            : verb === "client-finish" ? await clientFinish(context, request, vault, this.#listeners, within) : await devicePoll(context, request, vault, within);
        await this.#built;
        return answer;
      }).catch((error: unknown) => {
        if (error instanceof VerbError) return { refused: error.message };
        throw error;
      });
    }
    if (verb === "stations") {
      const ids = (named: unknown): string[] => (Array.isArray(named) ? named.filter((id): id is string => typeof id === "string") : []);
      const stopped = new Set(ids(request.stop));
      const context = this.#context(out, this.root, "you", verb);
      const turned = await sitesTurned(context, ids(request.choose), [...stopped]);
      this.#commit((tx) => {
        for (const site of chromeSites(this.registry.connectors)) {
          if (stopped.has(site.id)) for (const lane of site.lanes) needsMet(tx, outcomesOf(tx.tables, lane, () => true), this.now());
        }
      });
      const granted = ids(request.granted);
      const unit = typeof request.unit === "string" && (request.first === true || request.survey === true || granted.length > 0) ? request.unit : null;
      const asked = unit === null ? null : this.#survey(unit, granted);
      this.#poke();
      return { turned, survey: asked === null ? "none" : asked.queued ? "after" : "now", ...(asked === null ? {} : { covers: asked.covers }) };
    }
    if (verb === "redeem") {
      return this.#pairing.redeem(request.pairing, typeof request.browser === "string" ? request.browser : null);
    }
    if (verb === "opened") {
      if (typeof request.unit !== "string" || !Array.isArray(request.ids)) throw new TypeError("opened names a station's unit and the notices opened");
      const ids = request.ids.filter((id): id is string => typeof id === "string");
      this.#commit((tx) => {
        for (const id of ids) tx.tables.events.append({ at_ms: this.now(), kind: "opened", key: id, detail: { unit: request.unit as string } });
        const polls = new Set(ids.flatMap((id) => /^(?:fetch|page):([^:]+)/u.exec(id)?.[1] ?? []));
        for (const acquirer of this.registry.acquirers ?? []) if (polls.has(acquirer.name)) this.#enqueuePoll(tx, acquirer.name, BY_HAND);
      });
      this.#poke();
      return { opened: ids.length };
    }
    if (verb === "stated") {
      if (typeof request.unit !== "string") throw new TypeError("stated names a unit");
      this.#commit((tx) => tx.tables.events.append({ at_ms: this.now(), kind: "stated", key: request.unit as string }));
      this.#readNetwork();
      this.#poke();
      return { stated: request.unit };
    }
    if (verb === "drained") {
      if (typeof request.pass !== "string") throw new TypeError("drained names a pass");
      const pass = readPrincipals(this.folder).principals.find((row) => row.id === request.pass);
      if (pass === undefined || pass.kind === null) throw new TypeError(`no device pass ${request.pass}`);
      if (pass.revoked_at === null) {
        rememberRevoked(this.machine, this.root, [pass.id]);
        revokePrincipal(this.folder, pass.id, this.now());
        this.#commit((tx) => tx.tables.events.append({ at_ms: this.now(), kind: "pass-drained", key: pass.id, detail: { unit: pass.unit } }));
      }
      return { revoked: pass.id };
    }
    if (verb === "agent") return this.#agents.call(request.call, request.body, request.pass);
    if (verb === "feedback") return this.#feedbackVerb(request);
    if (verb === "agents-call") return this.#agents.callPass();
    if (verb === "account") {
      if (typeof request.pass !== "string") throw new TypeError("account names a pass and the account");
      return this.#pairing.stateAccount(request.pass, request.account);
    }
    if (verb === "offers") {
      if (typeof request.pass !== "string" || !Array.isArray(request.offers)) throw new TypeError("offers names a pass and its offers");
      return { made: this.#pairing.offer(request.pass, request.offers.filter((offer): offer is string => typeof offer === "string")) };
    }
    if (verb === "through") {
      if (!isObject(request.values)) throw new TypeError("through names each source's value and its received");
      const values = Object.entries(request.values as unknown as Record<string, { value: Value; received: Received }>);
      return { through: this.#commit((tx) => Object.fromEntries(values.filter(([source]) => tx.tables.sources.get(source) !== undefined)
        .map(([source, { value, received }]) => [source, applyThrough(tx, source, { value, received, at_ms: this.now() }, this.now())]))) };
    }
    const form = answerForm(Array.isArray(request.args) ? request.args.map(String) : []);
    const args = form.args;
    if (form.json) out = () => undefined;
    const cwd = typeof request.cwd === "string" ? request.cwd : this.root;
    if (verb === "maintenance") return await this.#exclusive(() => maintenance(this.folder, args));
    const relayed = verb === "status" ? relayStatus(args, (route) => this.#askDoor(route), out, this.settings.day)
      : verb === "connectors" ? relayConnectors(args, (route) => this.#askDoor(route), out, this.registry.connectors) : null;
    if (relayed !== null) return await relayed;
    const handler = VERBS[verb];
    if (handler === undefined) throw new TypeError(`no verb is named ${verb}`);
    const by = typeof request.by === "string" && request.by !== "" ? request.by : null;
    try {
      return await handler(this.#context(out, cwd, by, verb, call.left), args);
    } finally {
      if (this.#halted === null) this.#applyControls();
      this.#poke();
    }
  }
}

export function connectorsGuide(root: string, at: Machine): void {
  const folder = connectorsFolder(root);
  const command = commandFile(at.dir);
  const where = linked(at.dir)
    ? `Where your shell finds no \`${CLI}\`, run \`~/.local/bin/${CLI}\`, a link to the command. Without the link, the command is ${command}.`
    : `Where your shell finds no \`${CLI}\`, the command is ${command}.`;
  const text = [
    "# Connectors",
    "",
    "Each folder here is a connector of your own that this home runs, loaded at the home's start. A name beginning with a dot",
    "is never loaded.",
    "",
    `- \`.drafts/<id>\`: a draft, which no start loads. \`${CLI} connectors new <kind> <id>\` writes one there.`,
    `- \`.removed/\`: each folder \`${CLI} connectors remove <id>\` took out. Installing it again brings it back.`,
    `- \`.installed.json\`: where each installed folder was installed from and the ids it was installed with, which \`${CLI} connectors install\` reads.`,
    `- \`.loading.json\`: the folders \`${CLI} connectors install\` and \`remove\` restarted the home to load, so their change asks for no restart.`,
    "",
    `To add a connector, run \`${CLI} help connectors\`: the verbs, the kinds a folder can be, and the guide, ${guidePath(at)}.`,
    where,
    "",
    "The home writes this file at each start: an edit to it is lost.",
    "",
  ].join("\n");
  const path = join(folder, "README.md");
  if (existsSync(path) && readFileSync(path, "utf8") === text) return;
  makeUnder(root, folder);
  writeDurably(path, text);
}

function newSlotOf(request: JsonObject, unit: () => string): NewMachineSlot | null {
  if (request.slot_key === undefined) return null;
  const store = request.store;
  if (store !== "keychain-login" && store !== "keychain-data-protection" && store !== "systemd-tpm2") throw new TypeError("a machine slot names its store: keychain-login, keychain-data-protection or systemd-tpm2");
  return { key: keyOf(request.slot_key, "slot_key"), store: store satisfies SlotStore, unit: typeof request.unit === "string" ? request.unit : unit() };
}

function keyOf(stated: unknown, name: string): Buffer {
  const key = typeof stated === "string" ? Buffer.from(stated, "base64") : Buffer.alloc(0);
  if (key.length !== 32 || key.toString("base64") !== stated) throw new TypeError(`${name} is base64 of 32 bytes`);
  return key;
}

function textOf(stated: unknown): string {
  if (typeof stated !== "string") throw new TypeError("recovery is the recovery key, as typed");
  return stated;
}
