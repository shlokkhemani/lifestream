import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIPv4, Server as NetServer, type AddressInfo, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  canonical, civilDay, diskFailed, fits, freeOf, GENERATION, instant, isObject, KeyError, LEVEL_NAMES, lineOf, makeUnder, outOfRoom, readExif, RECHECK_BYTES, RELEASE, roomAt, TimeError, tryLock, trySharedLock,
  type BlobReader, type FileLock, type Delivery, type HomeFolder, type Json, type JsonObject, type KeptFile, type LevelName, type WriteKind,
} from "@lifestreamprotocol/core";
import { ask as askConnector, chromeSites, extensionOf, faces, iosDomainOf, isLibrary, siteOrigins, googlePlaces, ownerReaders, Refused, STATEMENTS_FILE, statedAt, tabClaim, type Connector, type OwnerReader, type Pictures, type TabClaim } from "@lifestreamprotocol/connect";
import { fedNone } from "@lifestreamprotocol/families";
import { BLOB_NAME, CHAT_ID, missingFiles, NOTE_ID, openStage, PHOTO_BYTES, PHOTO_TOO_LARGE, SECOND_BYTES, stagedOrStored, type Taken } from "./ask-files.js";
import { openAcquisitionBundle, sealAcquisitionBundle, type AcquisitionBundle } from "./bundle.js";
import { allowExtension, connectFrom } from "./connecting.js";
import { catalogOf } from "./catalog.js";
import { CLOCK_AHEAD_MS, openCustody, type Custody, type Serving } from "./custody.js";
import { belowFloor, deviceHeader, isDeviceKind, isOwnerProduct, laneOf, offered, ownerProductOf, ownerSource, releaseFloors, type Floors } from "./devices.js";
import { openFeed, type Beat, type Feed, type Page, type Position } from "./feed.js";
import { HomeFile } from "./home-file.js";
import { listenLan, pathOf, reach } from "./lan.js";
import { errorText } from "./jobs.js";
import { shownOf } from "./connectors.js";
import { basicInstant, deliveryDirectory, InboxError, inboxLane, isSegment, makeInbox, openSealing, readCustody, readSealed, statedMs, UPLOAD } from "./inbox.js";
import { callsLock, RUNNER_CALLS, RUNNER_EXCHANGE, RUNNERS, type ReaderCallBegun } from "@lifestreamprotocol/model";
import { admitAsk, asked, type Hold, holdLine, holdWords, readHold } from "./hold.js";
import { admittedSet, connectorsNow, handed, handHeard, homeFolders, type Generation } from "./folders.js";
import { awayWords, driveOf, HOME_FILE, HomeRoot, homeSocket, isAskPass, LifecycleError, LOOK_MS, realPath, retired, slotFolder, standing, stationsPass } from "./lifecycle.js";
import type { AgentCall, MintedKey, SignInAnswered, SignInHeld, Waiting as SignInWaiting } from "./agents.js";
import type { PublicState } from "./funnel.js";
import { machine, pointedAt, tailnetOf, type Interfaces, type Machine } from "./machine.js";
import { isProgramName } from "./subscriptions.js";
import { routeOf } from "./log-route.js";
import { PeerGuesses, type PairRefusal } from "./pairing.js";
import { sealPhoneBundle } from "./phone.js";
import { assertAllowed, assertThroughServer, authenticate, deviceOf, hiddenReader, readPrincipals, SERVER_HEADER, tokenTag, turnPasses, type HiddenReader, type Principal, type Reach } from "./principals.js";
import { refreshRoute } from "./door-refresh.js";
import type { Ran, Short, Timed } from "./reader.js";
import { readSettled, type Bound, type Settling } from "./settled.js";
import { openReaders, ReadFailed, type ReadBound } from "./readers.js";
import { openWriter, type Writer } from "./writers.js";
import { CUT_MOST, DOOR_LOCK, ErasableStreams, type Removed } from "./erasable-streams.js";
import type { Maker } from "./pictures.js";
import { READER_HEADER } from "./call.js";
import { homeClock } from "./home-clock.js";
import { DESCRIBE_ROUTE, openReads, stepKey, type HeldPhotos, type Reply } from "./reads.js";
import { TOOL_ROUTES, type DescribeAnswer } from "./search-contract.js";
import { restoredSources } from "./restore.js";
import { importsIn, foundIn, grantsIn, networkIn, openStated, recorderIn, roomIn, sendingIn, settingsIn, STATED_ROUTE, throughIn, type StatedStore, type ThroughStated } from "./stated.js";
import { storesIn } from "./stores.js";
import { HOME_FAILED, homeFailed, LOCKED, LOCKED_WORDS, NOT_NOW, OUTCOME_UNKNOWN, notNow, notNowRefusal, notReadable, outcomeUnknown, refuse, Refusal, RETRY_FULL_S, RETRY_S, RETRY_SOON_S, type Said, STARTING, STARTING_SAID, starting, waitBody, type Wait } from "./refusal.js";
import { chosenFor, effectiveOf, lastGood, personal, settingsPath, type DoorAddress } from "./settings.js";
import { movedSettings } from "./models-move.js";
import type { DiskSpace } from "./status.js";
import { startOf } from "./start.js";
import { fieldRoutes, isFieldRoute } from "./field-routes.js";
import { isSignInRoute, signinRoutes } from "./signin-routes.js";
import { ask, askHome, NoHomeError, socketPath, type HomeSocket } from "./socket.js";
import { nudges, type Nudges } from "./nudges.js";
import { NO_SLOT_KEY, type SlotHanded } from "./vault.js";
import { chatRoute, CHAT_BODY_BYTES, CHAT_ROUTE, type Reached } from "./chat-route.js";
import { bodyOf, CutShort, LINGER_MS, moving, refuseCut, refusedOn } from "./silence.js";
import { openStations, type Stations } from "./stations.js";
import type { PeerWire } from "./peers.js";
import { openRunners, wantedOn } from "./runners.js";
import { hidingFile, openDetector } from "./detector.js";
import { EmbedderError, openEmbedder } from "./embedder.js";
import { askedOf, ASK_CHARS, type AskedMeaning, type HeldMeaning } from "./screen-reads.js";
import { meaningAsked, meaningModel } from "./search-route.js";
import { ENGINE_MS, findingsDirOf, forgetFindings, keepMatch, matchesForgotten, openEnginePictures } from "./engine-pictures.js";
import { facesRun, facesSettings, workIn } from "./registry-home.js";
import { homeOf } from "./registry.js";
import { openHiding, within, type ToolRoute } from "./hiding.js";
import { ASK_READER as CHAT_READER, CHAT_NAME, readerOf } from "./access.js";
import { GUIDES_ROUTE, howOf, openPersonAccess, WAITING_ROUTE, type Asker, type ReaderEntry } from "./access-routes.js";
import { aboutOf, FEEDBACK_KINDS, FEEDBACK_URL, isShot, reportOfRow, sentOf, SHOT_BYTES, shotSize, UUID_V4, type FeedbackKind } from "./feedback.js";
import { guidesPage, waitingPage } from "./page-agents.js";
import { feedbackPage, REPORT_WORDS } from "./page-feedback.js";
import { PAGES } from "./pages.js";
import { servePage } from "./page-serve.js";
import type { EditorAccount } from "./access-edit.js";
import { marksFileOf, type MarkingProgress } from "./marking.js";
import { faceEngine } from "./programs.js";
import { openMarks, type Face, type Pictures as HidingPictures } from "@lifestreamprotocol/privacy";
import { CLI } from "./cli-name.js";


export interface DoorOptions {
  readonly clock?: () => number;
  readonly space?: DiskSpace;
  readonly log?: (line: string) => void;
  readonly machine?: Machine;
  readonly floors?: Floors;
  readonly registry?: string | URL;
  readonly connectors?: readonly Connector[];
  readonly generation?: (folder: string, machineDir: string) => Promise<Generated>;
  readonly slot?: SlotHanded;
  readonly ask?: string;
  readonly lookMs?: number;
  readonly needsMs?: number;
  readonly silentMs?: number;
  readonly lingerMs?: number;
  readonly lockWaitMs?: number;
  readonly recheckBytes?: number;
  readonly maker?: Maker;
  readonly statements?: (ran: Ran[]) => void;
  readonly readBound?: ReadBound;
  readonly readWaitMs?: number;
  readonly drain?: () => Promise<void>;
  readonly beats?: { readonly feed?: Beat; readonly minute?: Beat; readonly stage?: (tick: () => Promise<void>) => () => void; readonly settled?: Bound };
  readonly interfaces?: () => Interfaces;
  readonly slowMs?: number;
  readonly tellMs?: number;
  readonly feedbackOpen?: boolean;
  readonly hiding?: { readonly pictures?: HidingPictures; readonly engine?: string; readonly boundMs?: number; readonly writes?: (writer: Writer) => Writer; readonly match?: Match };
}

export type Match = (path: string, signal: AbortSignal) => Promise<{ width: number; height: number; faces: Face[] } | { cannot: true } | null>;

interface Stated {
  readonly facts: JsonObject;
  readonly files: readonly string[];
  readonly audio: readonly string[];
  readonly kept: Pick<BlobReader, "has" | "materialise">;
  readonly chats: readonly string[];
}

const ASK_READER = "ask-home";

export interface Door {
  readonly port: number;
  close(): Promise<void>;
  readonly closed: Promise<string>;
}

const OWNER_ACT_ROUTE = "/v1/owner/act";
const MODELS_ROUTE = "/v1/models";
const MODELS_READ_ROUTE = "/v1/models/read";
const WAIT_MS = 30_000;
const TELL_MS = 30_000;
const SECOND_MS = 1_000;
const LEAST_WAIT_MS = 3 * SECOND_MS;
const WAIT_HEADER = "lifestream-wait";
type Relayed = { readonly again: boolean; readonly wait_ms: number; readonly streams?: true };
const OWN_ACTS = {
  "POST /v1/pair": { again: true, wait_ms: WAIT_MS },
  "POST /v1/act": { again: false, wait_ms: WAIT_MS },
  "POST /v1/refresh": { again: true, wait_ms: WAIT_MS },
  "POST /v1/account": { again: true, wait_ms: WAIT_MS },
  "POST /v1/settings": { again: true, wait_ms: WAIT_MS },
  "POST /v1/seal": { again: false, wait_ms: WAIT_MS },
  "POST /v1/signin/<way>": { again: false, wait_ms: WAIT_MS },
  "POST /v1/process": { again: true, wait_ms: WAIT_MS },
  "POST /v1/connectors/<id>": { again: true, wait_ms: WAIT_MS },
  "POST /v1/owner/act": { again: true, wait_ms: WAIT_MS },
  "POST /v1/exchange drained": { again: false, wait_ms: WAIT_MS },
  "POST /v1/stations/exchange": { again: true, wait_ms: WAIT_MS },
  "POST /v1/feedback": { again: false, wait_ms: WAIT_MS },
  "POST /v1/feedback/draft": { again: true, wait_ms: WAIT_MS },
  "POST /v1/feedback/screenshot": { again: true, wait_ms: WAIT_MS },
  "POST /v1/feedback/send": { again: true, wait_ms: WAIT_MS },
  "POST /v1/subscriptions/<name>": { again: true, wait_ms: WAIT_MS },
  "GET /v1/subscriptions": { again: true, wait_ms: WAIT_MS },
  "POST /v1/chat/completions": { again: false, wait_ms: 5_000, streams: true },
  "POST /v1/ask/words": { again: true, wait_ms: 15_000 },
  "POST /v1/models/read": { again: true, wait_ms: WAIT_MS },
  "GET /v1/places/suggest": { again: false, wait_ms: 5_000 },
  "GET /v1/agents/waiting": { again: true, wait_ms: WAIT_MS },
  "GET /v1/agents/signins/<id>": { again: true, wait_ms: WAIT_MS },
  "POST /v1/agents/answer": { again: false, wait_ms: WAIT_MS },
  "POST /v1/agents/<id>/disconnect": { again: true, wait_ms: WAIT_MS },
  "GET /v1/agents/address": { again: true, wait_ms: WAIT_MS },
  "POST /v1/agents/address": { again: true, wait_ms: WAIT_MS },
  "POST /v1/agents/keys": { again: false, wait_ms: WAIT_MS },
} as const satisfies Record<string, Relayed>;
const AGENT_ROUTES = {
  "POST /v1/agents/request": { call: "request", again: false, wait_ms: WAIT_MS },
  "GET /v1/agents/request/<id>": { call: "state", again: true, wait_ms: WAIT_MS },
  "POST /v1/agents/grant": { call: "grant", again: false, wait_ms: WAIT_MS },
  "POST /v1/agents/refresh": { call: "refresh", again: false, wait_ms: WAIT_MS },
  "POST /v1/agents/revoke": { call: "revoke", again: true, wait_ms: WAIT_MS },
} as const satisfies Record<string, Relayed & { call: AgentCall }>;
type AgentAct = keyof typeof AGENT_ROUTES;
export type Act = keyof typeof OWN_ACTS | AgentAct;
export const ACTS: Readonly<Record<Act, Relayed>> = {
  ...OWN_ACTS,
  ...Object.fromEntries(Object.entries(AGENT_ROUTES).map(([act, { again, wait_ms }]) => [act, { again, wait_ms }])) as Record<AgentAct, Relayed>,
};
const isAgentAct = (key: string): key is AgentAct => Object.hasOwn(AGENT_ROUTES, key);
const ACQUISITION_ROUTE = /^\/v1\/acquisitions\/([^/]+)\/(\d{8}T\d{6}(?:\.\d{1,9})?Z)(?:\.([0-9a-f]{12}))?$/u;
const PHONE_ROUTE = /^\/v1\/bundles\/(sha256:[a-f0-9]{64})$/u;
const STREAM_ROUTE = /^\/v1\/connectors\/([^/]+)$/u;
const DELIVERING = (method: string | undefined, pathname: string): boolean =>
  (method === "POST" && (pathname === "/v1/exchange" || pathname === HELD_ROUTE || pathname === IMPORTS_HELD_ROUTE)) || (method === "PUT" && (PHONE_ROUTE.test(pathname) || ACQUISITION_ROUTE.test(pathname)));
const KIND_HEADER = "lifestream-kind";
interface LandRule {
  readonly what: string;
  readonly most: number;
  readonly large: string;
  readonly head: number;
  kind(head: Buffer): boolean;
  readonly kindWords: string;
}
interface AdmittedBody {
  readonly kind: WriteKind;
  need: number;
  landed: number;
}
export const QUIET = "Lifestream is stopped for a move or a check of its files: try again in a minute.";
const REQUEST_TIMEOUT_MS = 6 * 3_600_000;
const SILENT_MS = 5 * 60_000;
const SLOW_MS = 1_000;
const SILENT = "The upload stopped arriving: send it again.";
export const MOVED_AWAY = "Lifestream has moved to another machine: keep the bundle, and send it to its new address later.";
const LOOP_MS = 60_000;
const DRAIN_MS = 20_000;
const STALL_MS = 250;
const NOT_READY = "Lifestream is not ready: try again in a moment.";
const BODY_BYTES = 2 * 1024 * 1024;
const EVERY_ADDRESS = "0.0.0.0";
const DRIVEN_REPORTS = ["/v1/status", "/v1/connectors"];
const ASK_CONNECTORS_ROUTE = "/v1/connectors";
const WANTED_ROUTE = "/v1/photos/wanted";
const HELD_ROUTE = "/v1/blobs/held";
const LEAVING_ROUTE = "/v1/streams/leaving";
const HELD_MOST = 5_000;
const IMPORTS_HELD_ROUTE = "/v1/imports/held";
const DIGEST = /^[0-9a-f]{64}$/u;
const DAY_NAME = /^\d{4}-\d{2}-\d{2}$/u;
const SUGGEST_ROUTE = "/v1/places/suggest";
const MEANING_ASK_MS = 15_000;
const MAC_QUIET_MS = 3_600_000;
const ASK_ROUTE = /^\/v1\/ask(?:\/stop|\/login|\/chats(?:\/[^/]+(?:\/events)?)?)?$/u;
const ASK_FILES_ROUTE = "/v1/ask/files";
const ASK_FILE_ROUTE = /^\/v1\/ask\/files\/([^/]+)$/u;
const ASK_NOTE_ROUTE = /^\/v1\/ask\/notes\/([^/]+)(?:\/([^/]+))?$/u;
const ASK_WORDS_ROUTE = "/v1/ask/words";
const ASK_TAKEN_ROUTE = "/v1/ask/taken";
const TAKEN_MAX = 1_000;
const ASK_ERASED_ROUTE = "/v1/ask/erased";
const ERASED_MAX = 100;
const STAGE_SWEEP_MS = 3_600_000;
const PICK_RUNS = 2;
const ME_ROUTE = "/v1/me";
const FEEDBACK_ROUTE = "/v1/feedback";
const REPORT_ROUTE = /^\/v1\/feedback\/(draft|screenshot|send)$/u;
const SHOT_HEAD = 8;
const SHOT_TOO_LARGE = `A screenshot is at most ${SHOT_BYTES / 1024 ** 2} MiB.`;
const SHOT_RULE: LandRule = { what: "a screenshot", most: SHOT_BYTES, large: SHOT_TOO_LARGE, head: SHOT_HEAD, kind: isShot, kindWords: "Lifestream takes a screenshot here: a JPEG or PNG." };
const VERIFY_ROUTE = "/v1/home/verify";
const OUTBOUND_ROUTE = "/v1/outbound";
const HIDE_ROUTE = "/v1/hide-details";
const RESTORE_ROUTE = "/v1/restore-details";
const PRIVACY_ROUTE = "/v1/privacy";
const CHAT_PRIVACY_ROUTE = /^\/v1\/privacy\/chat\/([^/]+)$/u;
const KEEP_ROUTE = "/v1/privacy/keep";
const ACCESS_ROUTE = "/v1/access";
const ACCESS_REQUEST_ROUTE = "/v1/access/request";
const ACCESS_DROP_ROUTE = "/v1/access/drop";
const PLACEHOLDER = /\[\[[^[\]\n]*\]\]/u;
const SESSION_HEADER = "lifestream-session";
interface ModelReach {
  readonly method: "GET" | "POST";
  readonly path: string | RegExp;
  readonly agent?: true | "alone";
  readonly own?: true;
  readonly asked?: Readonly<Record<string, string>>;
}
const MODEL_REACHES: readonly ModelReach[] = [
  ...TOOL_ROUTES.map((path) => ({ method: "POST" as const, path, agent: true as const })),
  { method: "POST", path: HIDE_ROUTE, own: true },
  { method: "POST", path: RESTORE_ROUTE, agent: true, own: true },
  { method: "POST", path: FEEDBACK_ROUTE, agent: true },
  { method: "GET", path: ME_ROUTE, agent: true },
  { method: "GET", path: ACCESS_ROUTE, agent: "alone" },
  { method: "POST", path: ACCESS_REQUEST_ROUTE, agent: "alone" },
  { method: "POST", path: ACCESS_DROP_ROUTE, agent: "alone" },
  { method: "GET", path: "/v1/agents" },
  { method: "GET", path: /^\/v1\/agents\/(?:ask|p-[0-9a-f]{8})(?:\/history|\/reads\/call-[0-9a-f]{16})?$/u },
  { method: "POST", path: /^\/v1\/agents\/(?:ask|p-[0-9a-f]{8})\/propose$/u },
  { method: "GET", path: PRIVACY_ROUTE },
  { method: "GET", path: CHAT_PRIVACY_ROUTE, own: true },
  { method: "POST", path: KEEP_ROUTE, own: true },
  { method: "POST", path: OUTBOUND_ROUTE },
  { method: "GET", path: "/v1/clock" },
  { method: "GET", path: MODELS_ROUTE },
  { method: "GET", path: "/v1/people", asked: { id: "me" } },
  { method: "GET", path: "/v1/sources" },
  { method: "GET", path: "/v1/record" },
  { method: "GET", path: "/v1/records" },
];

export function modelReaches(pass: Pick<Principal, "kind" | "turn">, method: string | undefined, url: URL): boolean {
  const own = pass.turn?.chat ?? null;
  return MODEL_REACHES.some((each) => {
    if (each.method !== method || (pass.kind === "agent" ? each.agent === undefined : each.agent === "alone")) return false;
    const matched = typeof each.path === "string" ? (url.pathname === each.path ? [] : null) : each.path.exec(url.pathname)?.slice(1) ?? null;
    if (matched === null) return false;
    if (each.own === true && pass.kind !== "agent" && (own === null || matched.some((segment) => decodeSegment(segment) !== own))) return false;
    return Object.entries(each.asked ?? {}).every(([name, value]) => url.searchParams.get(name) === value);
  });
}
const OUTBOUND_SEQ = /^[1-9]\d{0,14}$/u;
const OUTBOUND_ROW = /^\/v1\/outbound\/([1-9]\d{0,14})$/u;
const AGENTS_PREFIX = "/v1/agents/";
const SUBSCRIPTIONS_ROUTE = /^\/v1\/subscriptions(?:\/([^/]+))?$/u;
const AGENT_STATE_ROUTE = /^request\/([^/]+)$/u;
const ASK_SERVER = "http://127.0.0.1:4681";
const ASK_SENT = ["lifestream-device", "content-type", "content-length", "accept"];
const ASK_CHAT = /^[A-Za-z0-9-]{1,64}$/u;
const CHAT_HEADER = "lifestream-chat";
const ASK_ANSWERED = ["content-type", "cache-control", "allow", "www-authenticate", "retry-after"];

function forwardAsk(server: string, path: string, authorization: string, request: IncomingMessage, response: ServerResponse, stopping: AbortSignal,
  { read, follow, ended }: { read?: Buffer; follow: boolean; ended: () => void }): Promise<void> {
  const pick = (headers: IncomingMessage["headers"], names: string[]) =>
    Object.fromEntries(names.flatMap((name) => headers[name] === undefined ? [] : [[name, headers[name]!]]));
  const headers = { ...pick(request.headers, ASK_SENT), authorization, ...(read === undefined ? {} : { "content-length": String(read.length) }) };
  let left = false;
  return new Promise((done, fail) => {
    const onward = httpRequest(new URL(path, server), { method: request.method, headers, signal: stopping }, (answer) => {
      if (!left) {
        response.writeHead(answer.statusCode ?? 502, pick(answer.headers, ASK_ANSWERED));
        response.flushHeaders();
      }
      answer.on("data", (chunk: Buffer) => { if (!left) response.write(chunk); });
      answer.once("end", () => { if (!left) response.end(); });
      answer.once("close", () => {
        if (!answer.complete && !left) response.destroy();
        done();
      });
    });
    onward.once("close", ended);
    response.once("close", () => {
      left = true;
      if (!follow) onward.destroy();
      done();
    });
    onward.once("error", (error) => {
      if (response.headersSent || response.destroyed || left) {
        response.destroy();
        done();
      } else fail(new Refusal(503, "ASK_DOWN", `Ask is not answering on the Mac Lifestream runs on (${errorText(error)}): the MCP server runs it`, RETRY_SOON_S));
    });
    if (read === undefined) request.pipe(onward);
    else onward.end(read);
  });
}

function admits(socket: Socket, tailnet: (address: string) => boolean): Reach | null {
  const local = socket.localAddress ?? "";
  const reach = !isIPv4(local) ? null : local.startsWith("127.") ? "loopback" : tailnet(local) ? "tailscale" : null;
  if (reach === null) socket.destroy();
  return reach;
}

const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/iu;

function isLoopbackHost(host: string | undefined, port: number | undefined): boolean {
  const named = LOOPBACK_HOST.exec(host ?? "");
  return named !== null && Number(named[1]) === port;
}

function isJsonType(type: string | undefined): boolean {
  return type !== undefined && type.split(";")[0]!.trim().toLowerCase() === "application/json";
}

function countedNoGuess(error: unknown): boolean {
  return error instanceof Refusal && ![OUTCOME_UNKNOWN, HOME_FAILED, "PAIR_CODE"].includes(error.code);
}

function peerOf(socket: Socket): string {
  const address = socket.remoteAddress ?? "";
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

function deviceLine(request: IncomingMessage, reach: Reach): JsonObject {
  const named = deviceHeader(request.headers["lifestream-device"]);
  return named === null ? {} : { device: `${named.kind}/${named.version}`, reach };
}

export function surveyed(connectors: readonly Connector[]): string[] {
  return chromeSites(connectors).filter((site) => site.probe !== null || site.lanes.length > 0).map((site) => site.id);
}

export function stalls(log: (line: JsonObject) => void, now: () => number = () => performance.now()): {
  timed<T>(name: string, work: () => T): T;
} {
  return {
    timed(name, work) {
      const started = now();
      try {
        return work();
      } finally {
        const ms = now() - started;
        if (ms > STALL_MS) log({ stall: name, ms: Math.round(ms) });
      }
    },
  };
}

interface Admitted {
  readonly wire: PeerWire;
  readonly noun: string;
  readonly alone: boolean;
  readonly exchange: string;
  readonly listing: string;
  readonly peer: (principal: Principal) => boolean;
  readonly drives: (principal: Principal) => boolean;
  readonly below?: (unit: string, version: string, request: IncomingMessage) => Promise<void>;
}

interface Opened {
  readonly root: HomeRoot;
  handle(request: IncomingMessage, response: ServerResponse): void;
  close(words: string, how: "cut" | "answer" | "drain"): Promise<void>;
  cut(words: string): Cut | null;
  counts(): { feeds: number; uploads: number };
  peak(): number;
}

interface Cut {
  uploads: number;
  feeds: number;
  polls: number;
  other: number;
}

interface Intake {
  readonly folder: string;
  readonly handle: HomeFolder;
  readonly erasable: ErasableStreams;
  readonly root: HomeRoot;
  readonly custody: Custody;
  readonly stated: StatedStore;
  readonly nudges: Nudges;
  readonly socket: HomeSocket;
  readonly active: Set<string>;
  readonly admitted: Set<AdmittedBody>;
  readonly inBody: Set<IncomingMessage>;
  readonly guesses: PeerGuesses;
  serve(serving: Serving): () => void;
  close(): void;
}

export class AnotherDoor extends Error {}

const DOOR_LOCK_WAIT_MS = 2_000;


function openIntake(folder: string, options: DoorOptions, where: () => string[], erasable: ErasableStreams): Intake {
  const clock = options.clock ?? Date.now;
  const log = options.log ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const say = (line: JsonObject) => log(JSON.stringify({ at: new Date(clock()).toISOString(), ...line }));
  const stall = stalls(say);
  const root = HomeRoot.open(folder, clock);
  let doorLock: FileLock | null = null;
  try {
    const at = (options.machine ?? machine()).dir;
    const handle = slotFolder(folder, at, "door", options.slot ?? NO_SLOT_KEY, clock());
    makeUnder(folder, join(folder, "door"));
    doorLock = tryLock(join(folder, DOOR_LOCK), options.lockWaitMs ?? DOOR_LOCK_WAIT_MS);
    if (doorLock === null) throw new AnotherDoor(`another door serves the home at ${folder}: this one does not`);
    handle.emptyWork();
    const lock = doorLock;
    const socket: HomeSocket = { path: socketPath((options.machine ?? machine()).dir, root.id), folder };
    makeInbox(handle);
    makeUnder(folder, join(folder, "replies"));
    const uploads = join(folder, "door", "uploads");
    rmSync(uploads, { recursive: true, force: true });
    makeUnder(folder, uploads);
    const seated: Serving[] = [];
    let stated: StatedStore | undefined;
    const custody = openCustody({
      folder, home: new HomeFile(handle), clock, floors: options.floors ?? releaseFloors(), serving: () => seated.at(-1) ?? starting(), where,
      stated: () => stated!.held(), log: say, timed: stall.timed,
    });
    try {
      stated = openStated(handle, socket, clock, log, (pass) => custody.replaced(pass), stall.timed);
    } catch (error) {
      custody.close();
      throw error;
    }
    const nudged = nudges(socket, say);
    nudged.owe();
    const held = stated;
    return {
      folder, handle, erasable, root, custody, stated: held, nudges: nudged, socket, active: new Set(), admitted: new Set(), inBody: new Set(), guesses: new PeerGuesses(clock),
      serve(serving) {
        seated.push(serving);
        return () => {
          const at = seated.indexOf(serving);
          if (at !== -1) seated.splice(at, 1);
        };
      },
      close() {
        nudged.close();
        try {
          custody.close();
          held.close();
        } finally {
          lock.release();
          root.close();
        }
      },
    };
  } catch (error) {
    doorLock?.release();
    root.close();
    throw error;
  }
}

function openFolder(intake: Intake, folder: string, settings: DoorAddress, options: DoorOptions, failed: (why: string) => void,
  reachOf: (socket: Socket) => Reach, mark: () => void, asked: (pass: string) => void): Opened {
  const { handle, root, custody, stated, active, admitted, inBody, guesses, nudges: nudged, erasable, socket } = intake;
  const clock = options.clock ?? Date.now;
  const at = options.machine ?? machine();
  const uploads = join(folder, "door", "uploads");
  const floors = options.floors ?? releaseFloors();
  const silentMs = options.silentMs ?? SILENT_MS;
  const lingerMs = options.lingerMs ?? LINGER_MS;
  const slowMs = options.slowMs ?? SLOW_MS;
  const recheckBytes = options.recheckBytes ?? RECHECK_BYTES;
  const log = options.log ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const askServer = options.ask ?? (process.env.LIFESTREAM_MCP || ASK_SERVER);
  const turns = turnPasses();
  const stall = stalls((line) => log(JSON.stringify({ at: new Date(clock()).toISOString(), ...line })));
  const stopping = new AbortController();
  const calls = callsLock(join(folder, "replies", "replies.db"));
  const home = new HomeFile(handle);
  const stored = handle.blobs(join(folder, "blobs"), { reading: true });
  const settingsNow = lastGood(handle, effectiveOf(movedSettings(personal(handle), null), settingsPath(folder)).settings);
  const read: typeof settingsNow = () => stall.timed("settings", settingsNow);
  const dayClock = homeClock(settingsNow().day);
  const undo: (() => unknown)[] = [];
  const opening = <T>(open: () => T, close: (value: T) => unknown): T => {
    try {
      const value = open();
      undo.unshift(() => close(value));
      return value;
    } catch (error) {
      for (const each of undo) {
        try { void Promise.resolve(each()).catch(() => undefined); } catch {}
      }
      throw error;
    }
  };
  const connectors = options.connectors ?? connectorsNow(folder);
  const readers = opening(() => openReaders(handle, at.dir, options.registry === undefined ? undefined
    : options.registry instanceof URL ? options.registry.href : pathToFileURL(resolve(options.registry)).href,
  (line) => log(JSON.stringify({ at: new Date(clock()).toISOString(), ...line })), () => writer.epoch(), options.statements, options.readBound, options.readWaitMs), (opened) => opened.close(new Error("the door's part did not open")));
  const writer: Writer = opening(() => openWriter(handle, at.dir, QUIET, (line) => log(JSON.stringify({ at: new Date(clock()).toISOString(), ...line }))), (opened) => opened.close());
  let stations: Stations;
  const replacedPass = (pass: Principal): boolean => (pass.kind === "phone" || pass.kind === "mac") && custody.replaced(pass);
  const runners = opening(() => openRunners({ wanted: (runner) => wantedOn(read(), runner) }), (opened) => opened.close());
  const marks = opening(() => openMarks(handle, marksFileOf(folder, at.dir)), (opened) => opened.close());
  const detector = openDetector({ chosen: () => chosenFor(read(), "hiding"), line: "hide", drive: { place: (placed, signal, handed) => runners.place(placed, signal, handed), list: async () => runners.listing() } });
  const embedder = openEmbedder({
    meaning: () => meaningModel(read()), timeout_ms: MEANING_ASK_MS,
    drive: { place: (placed, signal, handed) => runners.place(placed, signal, handed, true), list: async () => runners.listing() },
  });
  const stage = openStage(handle, clock);
  const findings = findingsDirOf(handle, at.dir);
  const held = stagedOrStored(stored, stage);
  const pictures = options.hiding?.pictures ?? openEnginePictures({
    engine: options.hiding?.engine ?? faceEngine(), blobs: held, findings, faces: (blob) => readers.read({ faces: blob }), signal: stopping.signal,
    merged: () => readers.read<Record<string, string>>({ merged: read().unit }),
  });
  const matchWork = workIn(homeOf(handle), join(folder, "door", "faces-match"), "faces-match");
  const match: Match = options.hiding?.match ?? (async (path, signal) => {
    const now = read();
    if (!facesRun(now, folder)) return null;
    const labeler = faces.facesLabeler({ ...facesSettings(now, homeOf(handle), fedNone(), matchWork), timeoutMs: ENGINE_MS });
    const anchors = await readers.read<faces.FaceAnchors>({ anchors: now.unit });
    const placed = await labeler.matchOne(path, anchors, signal);
    if (placed.status !== "ok") return { cannot: true };
    return {
      width: placed.width, height: placed.height,
      faces: placed.faces.map(({ box: [x1, y1, x2, y2], who }) => ({ box: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, ...(who === null ? {} : { who }) })),
    };
  });
  const sweepStage = async (): Promise<void> => {
    try {
      const removed = stage.sweep(stored);
      for (const blob of removed) forgetFindings(findings, blob, held);
      if (removed.length > 0) log(JSON.stringify({ at: new Date(clock()).toISOString(), stage: "swept", removed: removed.length }));
    } catch (error) {
      log(JSON.stringify({ at: new Date(clock()).toISOString(), stage: "sweep failed", error: errorText(error) }));
    }
  };
  void sweepStage();
  const sweeping = opening(() => (options.beats?.stage ?? ((tick: () => Promise<void>) => {
    const every = setInterval(() => void tick(), STAGE_SWEEP_MS);
    return () => clearInterval(every);
  }))(sweepStage), (stop) => stop());
  const describe = async (refs: readonly string[]): Promise<DescribeAnswer> => {
    const url = `${DESCRIBE_ROUTE}?${new URLSearchParams(refs.map((ref): [string, string] => ["ref", ref]))}`;
    const { reply } = await readers.ask(DESCRIBE_ROUTE, { computed: { key: JSON.stringify([url, false, null, null, null, null]), ask: () => ({
      url, now_ms: clock(), gzip: false,
      held: { machine: at.dir, sites: stations.sites(), present: stations.present(), refused: stations.refused(), stated: stated.held() },
    }) } }, stopping.signal);
    const said = JSON.parse(typeof reply.body === "string" ? reply.body : Buffer.from(reply.body).toString("utf8")) as JsonObject;
    if (reply.status !== 200) {
      const retry = Number(reply.headers["retry-after"]);
      refuse(reply.status, typeof said.code === "string" ? said.code : "DESCRIBE_REFUSED", typeof said.message === "string" ? said.message : "the refs could not be described", Number.isFinite(retry) ? retry : undefined);
    }
    return said as unknown as DescribeAnswer;
  };
  const storedLeaves = async (model: string): Promise<string | null | undefined> => (await readers.read<{ leaves: string | null } | null>({ leaves: model }))?.leaves;
  const hiding = openHiding({
    settings: () => read().privacy,
    names: (known) => readers.read({ names: { machine: at.dir, known } }),
    detector,
    chosen: () => chosenFor(read(), "hiding"),
    hidingFile: () => hidingFile(runners.listing(), chosenFor(read(), "hiding")),
    pictures,
    marks, writer: options.hiding?.writes?.(writer) ?? writer, progress: () => {
      const now = detector.state();
      return readers.read<MarkingProgress | null>({ marking: { machine: at.dir, store: marks.id, model: now.state === "ready" ? now.model : null } });
    }, day: () => read().day, clock,
    voice: () => readers.read<string | null>({ voice: { now_ms: clock() } }),
    leavesOf: storedLeaves,
    ...(options.hiding?.boundMs === undefined ? {} : { bound: within(options.hiding.boundMs) }),
    log: (line) => log(JSON.stringify({ at: new Date(clock()).toISOString(), ...line })),
    existing: () => viewed<EditorAccount[]>({ offered: true }),
    route: async (path, step) => {
      const meaning = path === "/v1/search" && "ask" in step ? await searchMeaning(meaningAsked(step.ask as object, step.lends?.meaning), stopping.signal) : undefined;
      const { reply, epoch } = await readers.ask(path, { computed: { key: stepKey(path, step, meaning), ask: () => ({
        url: path, now_ms: clock(), gzip: false, reader: "model" as const, step,
        held: { machine: at.dir, sites: stations.sites(), present: stations.present(), refused: stations.refused(), stated: stated.held(), ...(meaning === undefined ? {} : { meaning }) },
      }) } }, stopping.signal);
      return {
        status: reply.status, value: JSON.parse(typeof reply.body === "string" ? reply.body : Buffer.from(reply.body).toString("utf8")), epoch,
        ...(reply.withheld === undefined ? {} : { withheld: reply.withheld }),
      };
    },
    describe,
  });
  const passOf = (id: string) => readPrincipals(handle).principals.find((row) => row.id === id);
  const person = openPersonAccess({
    writer, clock, day: () => read().day,
    signIns: {
      waiting: async (http) => await relay({ verb: "agent", call: "waiting", body: {} }, "GET /v1/agents/waiting", http) as { requests: SignInWaiting[] },
      read: async (id, http) => await relay({ verb: "agent", call: "signin", body: { id } }, "GET /v1/agents/signins/<id>", http) as SignInHeld,
      answer: async (answer, http) => await relay({ verb: "agent", call: "answer", body: answer as unknown as JsonObject }, "POST /v1/agents/answer", http) as SignInAnswered,
    },
    offered: () => viewed<EditorAccount[]>({ offered: true }),
    readers: () => [
      { id: CHAT_READER, name: CHAT_NAME, kind: "chat", how: howOf(null, 0, read().day.zone), via: null, from: null, app: null, anywhere: false, made_ms: 0, disconnected_ms: null, listed: true },
      ...readPrincipals(handle).principals.filter((row) => row.kind === "agent" && row.agent !== undefined).map((row): ReaderEntry => ({
        id: row.id, name: row.agent!.name, kind: "agent", how: howOf(row.agent!, Date.parse(row.minted_at), read().day.zone), via: row.agent!.via,
        from: row.agent!.from, app: row.agent!.app ?? null, anywhere: row.agent!.anywhere === true, made_ms: Date.parse(row.minted_at),
        disconnected_ms: row.revoked_at === null ? null : Date.parse(row.revoked_at), listed: row.agent!.own !== true,
      })),
    ],
    disconnect: async (id, device, http) => {
      await relay({ verb: "agent", call: "disconnect", body: { id, device } }, "POST /v1/agents/<id>/disconnect", http);
    },
    address: async (asked, http) => asked === null
      ? await relay({ verb: "agent", call: "address", body: {} }, "GET /v1/agents/address", http) as PublicState
      : await relay({ verb: "agent", call: "address", body: { on: true, ...(asked.reader === null ? {} : { reader: asked.reader }) } }, "POST /v1/agents/address", http) as PublicState,
    key: async (asked, http) => await relay({ verb: "agent", call: "key", body: asked as unknown as JsonObject }, "POST /v1/agents/keys", http) as MintedKey,
    describe,
    device: (pass) => {
      const row = passOf(pass);
      return row?.kind === "phone" ? "iPhone" : row?.kind === "mac" || row?.scopes.includes("drive") === true ? "Mac" : null;
    },
  });
  const feed: Feed = opening(() => openFeed({
    head: () => readers.read<Position | undefined>({ feed: "head" }), page: (after) => readers.read<Page | undefined>({ feed: { after } }),
  }, log, options.beats?.feed, mark), (opened) => opened.close());
  const settling: Settling = { feed, ...(options.beats?.settled === undefined ? {} : { bound: options.beats.settled }) };
  const received = new WeakMap<IncomingMessage, number>();
  const viewed = async <T>(short: Short): Promise<T> => {
    let read: T | null;
    try {
      read = await readers.read<T | null>(short);
    } catch (error) {
      if (error instanceof Refusal) throw error;
      notReadable(error);
    }
    return read === null ? starting() : read;
  };
  const reads = opening(() => openReads({
    folder: handle, home, blobs: stored, settings: read, clock: dayClock, ...(options.maker === undefined ? {} : { maker: options.maker }),
    ...(options.space === undefined ? {} : { space: options.space }),
    streams: {
      feed, serves: async (hash) => (await viewed<string[]>({ served: [hash] })).length > 0, card: (machine, hash) => readers.leaving({ card: { machine, hash } }),
      open: erasable, checked: (name, read) => readers.here(name, read),
    },
  }), () => undefined);

  const arrived = new WeakMap<IncomingMessage, number>();
  const waitOf = (act: Act, http: IncomingMessage | null): number => {
    const most = ACTS[act].wait_ms;
    const said = http?.headers[WAIT_HEADER];
    if (said === undefined) return most;
    if (typeof said !== "string" || !/^[1-9]\d{0,8}$/u.test(said) || Number(said) < LEAST_WAIT_MS) {
      refuse(422, "BAD_REQUEST", `Lifestream-Wait is the milliseconds this try waits, a whole number of at least ${LEAST_WAIT_MS}`);
    }
    return Math.min(Number(said), most);
  };

  const relay = async (request: JsonObject, act: Act, http: IncomingMessage | null): Promise<unknown> => {
    const wait_ms = waitOf(act, http);
    const read_ms = (http === null ? undefined : arrived.get(http)) ?? Date.now();
    const left_ms = read_ms + wait_ms - SECOND_MS - Date.now();
    if (left_ms <= 0) outcomeUnknown(ACTS[act].again, false);
    try {
      return await ask(socket, { ...request, deadline_ms: read_ms + wait_ms - 2 * SECOND_MS }, undefined, left_ms);
    } catch (error) {
      if (error instanceof Refusal) throw error;
      if (error instanceof NoHomeError && !error.asked) starting();
      const began = error instanceof NoHomeError && error.began;
      log(JSON.stringify({ at: new Date(clock()).toISOString(), relay: request.verb, act, wait_ms, began, lost: errorText(error) }));
      if (error instanceof NoHomeError) outcomeUnknown(ACTS[act].again, began);
      return homeFailed();
    }
  };

  const tellMs = options.tellMs ?? TELL_MS;
  const tell = async (request: JsonObject): Promise<unknown> => {
    try {
      return await ask(socket, request, undefined, tellMs);
    } catch (error) {
      log(JSON.stringify({ at: new Date(clock()).toISOString(), told: request, lost: errorText(error) }));
      return undefined;
    }
  };

  stations = opening(() => openStations({
    files: { folder: handle, dir: join(folder, "door", "stations") },
    clock,
    home: { version: RELEASE, generation: GENERATION },
    sites: chromeSites(connectors).map((site) => ({ id: site.id, name: site.name, origin: site.origin, ...(site.form ? { form: true as const } : {}), origins: siteOrigins(site) })),
    chosen: () => read().sites.chosen,
    probed: surveyed(connectors),
    needs: async () => (await custody.needs()).filter((need) => need.at !== null),
    opened(unit, ids) {
      void tell({ verb: "opened", unit, ids: [...ids] });
    },
    acted(_unit, acts) {
      for (const each of acts) void tell({ verb: "act", args: [each.need, each.do, ...(each.of === undefined ? [] : [each.of])], by: "you" });
    },
    async changed(change, request) {
      const answer = await relay({
        verb: "stations", unit: change.unit, first: change.first, survey: change.survey, choose: [...change.pressed.choose], stop: [...change.pressed.stop], granted: [...change.granted],
      }, "POST /v1/stations/exchange", request).catch((error: unknown) => {
        log(JSON.stringify({ at: new Date(clock()).toISOString(), stations: change.unit, lost: (error as Error).message }));
        throw error;
      });
      const { covers } = (answer ?? {}) as { covers?: unknown };
      return typeof covers === "number" ? { covers } : {};
    },
    ...(options.needsMs === undefined ? {} : { needs_ms: options.needsMs }),
    log: (entry) => log(JSON.stringify({ at: new Date(clock()).toISOString(), transcript: entry })),
    told: (line) => log(JSON.stringify({ at: new Date(clock()).toISOString(), ...line })),
    claimed: (claim) => sealClaim(claim).catch((error: unknown) => {
      log(JSON.stringify({ at: new Date(clock()).toISOString(), claim: claim.errand, tab: claim.tab, lost: (error as Error).message }));
    }),
  }), (opened) => opened.close());

  const peerWires: readonly Admitted[] = [
    {
      wire: stations, noun: "station", alone: false, exchange: "POST /v1/stations/exchange", listing: "GET /v1/stations",
      peer: (principal) => principal.kind === "extension" && principal.scopes.includes("station"),
      drives: (principal) => principal.scopes.includes("drive"),
      below: (unit, version, request) => stations.below(unit, version, request),
    },
    {
      wire: runners, noun: "runner", alone: true, exchange: `POST ${RUNNER_EXCHANGE}`, listing: `GET ${RUNNERS}`,
      peer: (principal) => principal.scopes.includes("run"),
      drives: (principal) => principal.scopes.includes("drive") || principal.scopes.includes("call") || principal.scopes.includes("find"),
      below: async (unit, version) => runners.below(unit, version),
    },
  ];

  const device = (pass: Principal["kind"], request: IncomingMessage): void => {
    const kind = deviceOf({ kind: pass });
    if (kind === null) return;
    const stated = deviceHeader(request.headers["lifestream-device"]);
    if (stated === null || belowFloor(floors, stated.kind, stated.version)) {
      const floor = floors[stated?.kind ?? kind];
      refuse(426, "DEVICE_TOO_OLD", `this ${stated?.kind ?? kind} is older than the home serves (${stated === null ? "it states no Lifestream-Device" : stated.version}): update it to ${floor} or later`,
        undefined, { floor });
    }
    if (stated.kind !== kind) refuse(403, "PRINCIPAL_SCOPE", `this pass is a ${kind}'s, not a ${stated.kind}'s`);
  };

  const photoAsks = new Map<string, number>();
  const opened_ms = clock();
  const wantedAsk = (principal: Principal, reach: Reach, url: URL): HeldPhotos => {
    const named = url.searchParams.getAll("source");
    if (named.length !== 1) refuse(422, "BAD_PARAMETER", "source names the photos library asking, once");
    const source = named[0]!;
    if (!isLibrary(connectors, source) || !custody.delivers(principal).includes(source)) refuse(403, "PRINCIPAL_SCOPE", `principal ${principal.id} delivers no photos library ${source}`);
    assertAllowed(principal, "deliver", source);
    const now = clock();
    if (principal.kind === "mac") photoAsks.set(source, now);
    const asking = readPrincipals(handle).principals
      .filter((pass) => pass.kind === "mac" && pass.revoked_at === null)
      .flatMap((pass) => pass.sources.filter((library) => isLibrary(connectors, library) && now - (photoAsks.get(library) ?? opened_ms) < MAC_QUIET_MS));
    const connector = catalogOf(connectors).of({ id: source });
    return { source, connector: connector?.id ?? null, asking, room: roomAt(folder), reach, start_ms: connector === undefined ? null : startOf(read(), connector, now).ms };
  };

  const heldBlobs = async (principal: Principal, request: IncomingMessage): Promise<[number, JsonObject]> => {
    if (principal.kind !== "mac" && principal.kind !== "phone") refuse(403, "PRINCIPAL_SCOPE", `pass ${principal.id} is no device's: a device asks which files the home holds`);
    const asked = (await body(request)).blobs;
    if (!Array.isArray(asked) || asked.some((blob) => typeof blob !== "string" || !BLOB_NAME.test(blob))) refuse(422, "BAD_REQUEST", "blobs is a list of sha256:<64 hex>");
    if (asked.length > HELD_MOST) refuse(422, "BAD_REQUEST", `at most ${HELD_MOST} blobs a request`);
    return [200, { held: [...new Set(asked as string[])].filter((blob) => stored.has(blob)) }];
  };

  const heldImports = async (principal: Principal, request: IncomingMessage): Promise<[number, JsonObject]> => {
    if (principal.kind !== "mac") refuse(403, "PRINCIPAL_SCOPE", `pass ${principal.id} is no Mac's: a Mac asks which of its files the home took in`);
    const asked = (await body(request)).files;
    const valid = (each: unknown): each is { kind: string; digest: string } => typeof each === "object" && each !== null && !Array.isArray(each)
      && typeof (each as JsonObject).kind === "string" && (each as JsonObject).kind !== "" && !String((each as JsonObject).kind).includes("/")
      && typeof (each as JsonObject).digest === "string" && DIGEST.test((each as JsonObject).digest as string);
    if (!Array.isArray(asked) || !asked.every(valid)) refuse(422, "BAD_REQUEST", "files is a list of {kind, digest: <64 hex>}");
    if (asked.length > HELD_MOST) refuse(422, "BAD_REQUEST", `at most ${HELD_MOST} files a request`);
    const keys = [...new Set((asked as { kind: string; digest: string }[]).map((each) => `${each.kind}/${each.digest}`))];
    return [200, { held: keys.length === 0 ? [] : await viewed<{ kind: string; digest: string; state: "in" | "refused" | "let-go" }[]>({ looked: keys }) }];
  };

  const typedAsk = async (url: URL, http: IncomingMessage): Promise<googlePlaces.TypedAnswer | undefined> => {
    const q = url.searchParams.get("q");
    if (q === null || q.trim().length > googlePlaces.TYPED_MAX) return undefined;
    const spot = url.searchParams.get("spot");
    const centre = spot === null ? undefined
      : await readers.leaving<{ latitude: number; longitude: number } | undefined>({ centre: { machine: at.dir, spot } }).catch(() => undefined);
    const [latitude, longitude] = spot !== null ? [centre?.latitude ?? NaN, centre?.longitude ?? NaN]
      : [url.searchParams.get("latitude"), url.searchParams.get("longitude")].map((value) => value === null || value.trim() === "" ? NaN : Number(value));
    if (!(Math.abs(latitude!) <= 90 && Math.abs(longitude!) <= 180)) return undefined;
    try {
      return await relay({ verb: "places-search", latitude: latitude!, longitude: longitude!, q }, "GET /v1/places/suggest", http) as googlePlaces.TypedAnswer;
    } catch (error) {
      if (error instanceof Refusal && error.code === "BAD_REQUEST") throw error;
      return { google: "unreachable" };
    }
  };

  const meaningAsk = async (asked: string, signal: AbortSignal): Promise<AskedMeaning | undefined> => {
    const q = asked.trim();
    if (meaningModel(read()) === null || q === "" || q.length > ASK_CHARS) return undefined;
    const admitted = await embedder.admits("query");
    if (!admitted.go) refuse(503, "MEANING_NOT_NOW", admitted.words, RETRY_SOON_S);
    try {
      const { model, vectors } = await embedder.embed([q], "query", signal);
      return askedOf(model, vectors[0]!);
    } catch (error) {
      if (!(error instanceof EmbedderError)) throw error;
      refuse(503, "MEANING_NOT_NOW", `Search by meaning could not read the ask: ${error.message}`, RETRY_SOON_S);
    }
  };

  const searchMeaning = async (q: string | undefined, signal: AbortSignal): Promise<HeldMeaning | undefined> => {
    if (q === undefined) return undefined;
    try {
      return await meaningAsk(q, signal);
    } catch (error) {
      if (error instanceof Refusal && error.code === "MEANING_NOT_NOW") return { waits: error.message };
      throw error;
    }
  };

  const delivers = (principal: Principal, source: string): void => {
    assertAllowed(principal, "deliver", source);
    if (!custody.delivers(principal).includes(source)) refuse(403, "PRINCIPAL_SCOPE", `${source} is turned off: the home takes none of it`);
  };

  const taken = (): number => [...admitted].reduce((sum, body) => sum + body.need - body.landed, 0);
  const room = (kind: WriteKind, more: number): void => {
    const free = freeOf(folder);
    if (fits(free, kind, taken() + more)) return;
    refuse(503, "DISK_LOW", `${free ?? "unknown"} bytes free, ${taken() + more} taken by the bodies landing; a ${kind} upload keeps ${lineOf(kind)} free`,
      RETRY_FULL_S);
  };

  const admit = (request: IncomingMessage): AdmittedBody => {
    const length = request.headers["content-length"];
    if (length === undefined) refuse(411, "LENGTH_REQUIRED", "an upload states its length (Content-Length)");
    const stated = Number(length);
    if (stated > settings.max_bundle_bytes) refuse(413, "BUNDLE_TOO_LARGE", `the bundle states ${stated} bytes; the door takes at most ${settings.max_bundle_bytes}`);
    const kind: WriteKind = request.headers[KIND_HEADER] === "new" ? "new" : "later";
    room(kind, 2 * stated);
    const body: AdmittedBody = { kind, need: 2 * stated, landed: 0 };
    admitted.add(body);
    return body;
  };

  const receive = async (request: IncomingMessage, path: string, body: AdmittedBody): Promise<{ sha256: string; bytes: number }> => {
    const file = handle.file(UPLOAD, path);
    file.remove();
    const digest = createHash("sha256");
    let checked = 0;
    let silent = false;
    inBody.add(request);
    mark();
    try {
      await file.writing((async function* () {
        try {
          for await (const chunk of moving(request as AsyncIterable<Buffer>, silentMs, () => { silent = true; request.destroy(); })) {
            body.landed += chunk.byteLength;
            received.set(request, body.landed);
            if (body.landed - checked >= recheckBytes) {
              checked = body.landed;
              room(body.kind, 0);
            }
            digest.update(chunk);
            yield chunk;
          }
        } catch (error) {
          if (!silent) throw error;
        }
      })());
    } finally {
      inBody.delete(request);
    }
    if (silent) notNow("busy", SILENT);
    room(body.kind, 0);
    return { sha256: digest.digest("hex"), bytes: body.landed };
  };

  const lands = (body: AdmittedBody, members: number): void => {
    body.need = body.landed + members;
    room(body.kind, 0);
  };

  const body = async (request: IncomingMessage, limit = BODY_BYTES): Promise<JsonObject> => {
    const text = (await bodyOf(request, limit, silentMs, (bytes) => received.set(request, bytes))).toString("utf8").trim();
    if (text === "") return {};
    let value: unknown;
    try { value = JSON.parse(text); } catch { return refuse(422, "BAD_REQUEST", "the body is a JSON object"); }
    if (typeof value !== "object" || value === null || Array.isArray(value)) refuse(422, "BAD_REQUEST", "the body is a JSON object");
    return value as JsonObject;
  };

  const sealing = async <T>(work: () => Promise<T>): Promise<T> => {
    const lock = trySharedLock(calls) ?? notNow("busy", QUIET);
    try {
      const pointing = pointedAt(at);
      if (pointing !== null && realPath(pointing) !== realPath(folder)) notNow("busy", QUIET);
      if (retired(folder)) notNow("busy", MOVED_AWAY, RETRY_FULL_S);
      return await work();
    } finally {
      lock.release();
    }
  };

  const upload = async <T>(id: string, partial: string, request: IncomingMessage, work: (body: AdmittedBody) => Promise<T>): Promise<T> => {
    if (active.has(id)) refuse(409, "UPLOAD_ACTIVE", "bundle upload is active", RETRY_S);
    const body = admit(request);
    active.add(id);
    try {
      return await work(body);
    } catch (error) {
      if (outOfRoom(error)) refuse(503, "DISK_LOW", `the disk filled as the bundle landed: ${(error as Error).message}`, RETRY_FULL_S);
      throw error;
    } finally {
      admitted.delete(body);
      active.delete(id);
      handle.file(UPLOAD, partial).remove();
    }
  };

  const current = (principal: Principal): Principal => stall.timed("principals", () => readPrincipals(handle)).principals.find((row) => row.id === principal.id) ?? principal;

  const pair = async (request: IncomingMessage, reach: Reach): Promise<[number, JsonObject]> => {
    if (request.headers.origin !== undefined && extensionOf(request.headers.origin) === null) {
      refuse(403, "PAIR_ORIGIN", "a web page or another extension does not pair with the home: a device does, or the Lifestream extension");
    }
    if (!isJsonType(request.headers["content-type"])) refuse(415, "PAIR_CONTENT_TYPE", "a pairing is sent as application/json");
    const pairing = await body(request);
    const browser = pairing.connect === true ? await connectFrom(request, reach) : undefined;
    if (isDeviceKind(pairing.kind)) device(pairing.kind, request);
    const taken = typeof pairing.code === "string" ? guesses.take(peerOf(request.socket)) : null;
    if (taken !== null && "wait" in taken) {
      refuse(429, "PAIR_SLOW_DOWN", "too many codes that do not pair came from here: wait, then type the code the Mac shows", taken.wait);
    }
    let redeemed: { unit: string; pass: string } | { pending: string } | { refused: PairRefusal };
    try {
      redeemed = await relay({ verb: "redeem", pairing, ...(browser === undefined ? {} : { browser }) }, "POST /v1/pair", request) as typeof redeemed;
    } catch (error) {
      if (countedNoGuess(error)) taken?.giveBack();
      throw error;
    }
    if (!("refused" in redeemed && redeemed.refused.code === "PAIR_CODE")) taken?.giveBack();
    if ("pending" in redeemed) return [202, { pending: redeemed.pending }];
    if ("refused" in redeemed) {
      const { status, code, message, phones } = redeemed.refused;
      refuse(status, code, message, undefined, phones === undefined ? undefined : { phones: phones.map((phone) => ({ ...phone })) });
    }
    const pass = readPrincipals(handle).principals.find((row) => row.id === redeemed.pass)!;
    return [200, { unit: redeemed.unit, answer: await custody.pairing(pass, reach) }];
  };

  const act = async (principal: Principal, request: IncomingMessage): Promise<[number, JsonObject]> => {
    assertAllowed(principal, "read");
    const { need, do: chosen, of, account } = await body(request);
    if (typeof need !== "string" || !["try", "skip", "read", "ignore", "dismiss", "choose", "let-go"].includes(chosen as string)) {
      refuse(422, "BAD_REQUEST", "act names a need and what to do: try, skip, read, ignore, dismiss, choose or let-go");
    }
    if (chosen === "choose") {
      if (typeof account !== "string" || account.trim() === "" || of !== undefined) refuse(422, "BAD_REQUEST", "choose names the account (account)");
      return [200, await relay({ verb: "act", args: [need, "choose", account as string], by: "you" }, "POST /v1/act", request) as JsonObject];
    }
    if (account !== undefined) refuse(422, "BAD_REQUEST", "only choose names an account");
    const answers = chosen === "read" || chosen === "ignore";
    if (answers ? typeof of !== "string" || of === "" : of !== undefined) refuse(422, "BAD_REQUEST", "read and ignore name the source the offer makes (of); no other act does");
    if (need === "erasure") refuse(409, "NOT_OFFERED", `an erasure is run again from the terminal: ${CLI} act erasure try`);
    return [200, await relay({ verb: "act", args: [need, chosen as string, ...(answers ? [of as string] : [])], by: "you" }, "POST /v1/act", request) as JsonObject];
  };

  const stateAccount = async (principal: Principal, request: IncomingMessage): Promise<[number, JsonObject]> => {
    const { account } = await body(request);
    const answered = await relay({ verb: "account", pass: principal.id, account: account ?? null }, "POST /v1/account", request) as { account: string; made: string[] } | { refused: PairRefusal };
    if ("refused" in answered) refuse(answered.refused.status, answered.refused.code, answered.refused.message);
    return [200, { account: answered.account, made: answered.made }];
  };

  const fields = fieldRoutes({ connectors, homeUnit: () => read().unit, body, relay });
  const signins = signinRoutes({ connectors, homeUnit: () => read().unit, body, relay });

  const chooseItem = async (principal: Principal, request: IncomingMessage): Promise<[number, JsonObject]> => {
    if (principal.kind !== "mac" && principal.kind !== "phone") refuse(403, "PRINCIPAL_SCOPE", `pass ${principal.id} is no device's: a model is chosen for an item on a Mac or a phone`);
    const { family, item, prompt, route } = await body(request);
    if (typeof family !== "string" || typeof item !== "string" || typeof prompt !== "string" || typeof route !== "string") {
      refuse(422, "BAD_REQUEST", "process names a family, an item, a prompt and a route");
    }
    return [200, await relay({ verb: "models", args: ["--", "process", family, item, prompt, route], by: "you" }, "POST /v1/process", request) as JsonObject];
  };

  const stream = async (principal: Principal, id: string | null, request: IncomingMessage): Promise<[number, JsonObject]> => {
    if (principal.kind !== "mac" && principal.kind !== "phone") refuse(403, "PRINCIPAL_SCOPE", `pass ${principal.id} is no device's: a stream is turned off or paused on a Mac or a phone`);
    const declared = connectors.find((each) => each.id === id) ?? refuse(404, "CONNECTOR_UNKNOWN", `the home declares no connector ${id ?? ""}`);
    const shown = shownOf(declared);
    if (shown === "home") refuse(403, "PRINCIPAL_SCOPE", `${declared.id} is the home's own: it is turned off on the Mac`);
    if (shown === null) refuse(403, "PRINCIPAL_SCOPE", `${declared.id} has no switch: it is never turned off`);
    const said = await body(request);
    const keys = Object.keys(said).sort().join(",");
    const paused = said.paused === true ? "pause" : said.paused === false ? "resume" : undefined;
    const args = keys === "on" && said.on === false ? ["off", declared.id]
      : keys === "paused" && paused !== undefined ? [paused, declared.id]
      : keys === "history,paused" && said.history === true && paused !== undefined ? ["backfill", declared.id, paused]
      : refuse(422, "BAD_REQUEST", "a stream's body is {on: false}, or {paused: true | false}, with history: true for its past alone");
    if (args[0] === "backfill" && declared.backfill === undefined) refuse(422, "BAD_REQUEST", `${declared.id} has no history to pause apart`);
    await relay({ verb: "connectors", args: ["--", ...args], by: "you" }, "POST /v1/connectors/<id>", request);
    return [200, {}];
  };

  const agentsRoute = async (principal: Principal, reach: Reach, request: IncomingMessage, pathname: string): Promise<[number, JsonObject]> => {
    const rest = pathname.slice(AGENTS_PREFIX.length);
    const state = request.method === "GET" ? AGENT_STATE_ROUTE.exec(rest) : null;
    const act = state !== null ? "GET /v1/agents/request/<id>" : `${request.method} ${pathname}`;
    if (!isAgentAct(act)) return [404, { message: "unknown endpoint" }];
    const route = AGENT_ROUTES[act];
    if (!(principal.scopes.includes("admit") && reach === "loopback")) refuse(403, "PRINCIPAL_SCOPE", `principal ${principal.id} does not ask for agents' sign-ins`);
    const said = state !== null ? { id: decodeSegment(state[1]!) ?? "" } : request.method === "GET" ? {} : await body(request);
    return [200, await relay({ verb: "agent", call: route.call, body: said }, act, request) as JsonObject];
  };

  const personAsker = (principal: Principal, reach: Reach, request: IncomingMessage): Asker => {
    const own = (principal.kind === "mac" || principal.scopes.includes("drive")) && reach === "loopback";
    if (!(principal.kind === "phone" || own || (principal.kind === null && principal.scopes.includes("read")))) {
      refuse(403, "PRINCIPAL_SCOPE", `principal ${principal.id} is not the person's: agents' access is read and changed by the person`);
    }
    const chat = request.headers[CHAT_HEADER];
    const ask = readerOf(principal, typeof chat === "string" && ASK_CHAT.test(chat) ? chat : null).kind === "ask";
    const beside = request.headers[SERVER_HEADER] !== undefined;
    return { pass: principal, ask, widen: !ask && !beside && (principal.kind === "phone" || own) };
  };

  const personRoute = async (principal: Principal, reach: Reach, request: IncomingMessage, url: URL): Promise<[number, JsonObject]> =>
    person.serve(personAsker(principal, reach, request), request, url, body);

  const waitingRoute = async (principal: Principal, reach: Reach, request: IncomingMessage): Promise<Reply> => {
    const asker = personAsker(principal, reach, request);
    const head = await viewed<Position | undefined>({ feed: "head" });
    const list = await person.waiting(asker, request);
    const etag = request.headers["if-none-match"];
    return servePage("agentsWaiting", waitingPage(list, head === undefined ? "0:0" : `${head.seq}:${head.at_ms}`), {
      url: request.url ?? "/", now_ms: clock(), gzip: /\bgzip\b/u.test(request.headers["accept-encoding"] ?? ""), ...(etag === undefined ? {} : { if_none_match: etag }),
      held: { machine: at.dir, sites: stations.sites(), present: stations.present(), refused: stations.refused(), stated: stated.held() },
    }, read().day);
  };

  const guidesRoute = async (principal: Principal, reach: Reach, request: IncomingMessage): Promise<Reply> => {
    const held = await person.guides(personAsker(principal, reach, request));
    const head = await viewed<Position | undefined>({ feed: "head" });
    const etag = request.headers["if-none-match"];
    const said = deviceHeader(request.headers["lifestream-device"]);
    return servePage("agentGuides", guidesPage(held, head === undefined ? "0:0" : `${head.seq}:${head.at_ms}`), {
      url: request.url ?? "/", now_ms: clock(), gzip: /\bgzip\b/u.test(request.headers["accept-encoding"] ?? ""), ...(etag === undefined ? {} : { if_none_match: etag }),
      ...(said === null ? {} : { device: { kind: said.kind, unit: said.kind === principal.kind ? principal.unit : null } }),
      held: { machine: at.dir, sites: stations.sites(), present: stations.present(), refused: stations.refused(), stated: stated.held() },
    }, read().day);
  };

  const subscriptions = async (principal: Principal, reach: Reach, request: IncomingMessage, pathname: string): Promise<[number, JsonObject]> => {
    if (!(principal.kind === "mac" && reach === "loopback")) refuse(403, "PRINCIPAL_SCOPE", "a model's program is chosen from Lifestream on the home's Mac");
    const named = SUBSCRIPTIONS_ROUTE.exec(pathname)![1];
    const asked = request.method === "GET" && named === undefined ? {} : request.method === "POST" && isProgramName(named) ? { choose: named } : null;
    if (asked === null) return [404, { message: "unknown endpoint" }];
    return [200, await relay({ verb: "subscriptions", ...asked }, "choose" in asked ? "POST /v1/subscriptions/<name>" : "GET /v1/subscriptions", request) as JsonObject];
  };

  const relayChat = chatRoute({ clock, leavesOf: storedLeaves, reach: async (model, http) => await relay({ verb: "model-reach", model }, "POST /v1/chat/completions", http) as Reached });
  const chatting = async (principal: Principal, request: IncomingMessage, response: ServerResponse, reach: Reach): Promise<void> => {
    const own = () => askServerOnly(principal, request, reach, "a model is reached for Chat's own loop alone, on the home's Mac");
    own();
    await relayChat(await body(request, CHAT_BODY_BYTES), request, response, own);
  };

  const askPassAt = (request: IncomingMessage, reach: Reach): boolean =>
    reach === "loopback" && isAskPass(at, handle, read().unit, /^Bearer\s+(\S+)$/u.exec(request.headers.authorization ?? "")?.[1] ?? "");
  const askServerOnly = (principal: Principal, request: IncomingMessage, reach: Reach, why: string): void => {
    if (!askPassAt(request, reach)) refuse(403, "PRINCIPAL_SCOPE", `principal ${principal.id} is not the Ask server's: ${why}`);
  };

  const PHOTO_RULE: LandRule = { what: "a photo", most: PHOTO_BYTES, large: PHOTO_TOO_LARGE, head: askConnector.PHOTO_HEAD, kind: askConnector.isPhoto, kindWords: "Lifestream takes a photo here: a JPEG, PNG, HEIC or WebP." };
  const landAskFile = (request: IncomingMessage, named?: string, rule: LandRule = PHOTO_RULE): Promise<string> => {
    const length = request.headers["content-length"];
    if (length === undefined) refuse(411, "LENGTH_REQUIRED", `${rule.what} states its length (Content-Length)`);
    const stated = Number(length);
    if (stated > rule.most) refuse(413, "FILE_TOO_LARGE", rule.large);
    return stage.admit(stated, async () => {
      room("new", stated);
      const body: AdmittedBody = { kind: "new", need: stated, landed: 0 };
      admitted.add(body);
      const partial = join(uploads, `ask-file-${randomUUID()}.partial`);
      try {
        const { sha256 } = await receive(request, partial, body);
        const landed = `sha256:${sha256}`;
        const kept = handle.file(UPLOAD, partial);
        if (!rule.kind(headOf(kept, rule.head))) refuse(415, "FILE_KIND", rule.kindWords);
        if (named !== undefined && landed !== named) refuse(422, "FILE_BAD", `the bytes' SHA-256 is ${landed}, not ${named}`);
        await stage.adopt(kept, sha256);
        return landed;
      } catch (error) {
        if (outOfRoom(error)) refuse(503, "DISK_LOW", `the disk filled as ${rule.what} landed: ${(error as Error).message}`, RETRY_FULL_S);
        throw error;
      } finally {
        admitted.delete(body);
        handle.file(UPLOAD, partial).remove();
      }
    });
  };

  const askFile = async (principal: Principal, request: IncomingMessage): Promise<[number, JsonObject]> => {
    assertAllowed(principal, "read");
    const file = await landAskFile(request);
    const [seen, placed] = await Promise.all([pickWork(() => readPicture(file)), pickWork(() => matchPicture(file))]);
    if (seen === "cannot") {
      if (stage.drop(file)) forgetFindings(findings, file, held);
      refuse(422, "PICTURE_UNREADABLE", "Lifestream can't read this picture.");
    }
    const size = placed !== null && "width" in placed ? { width: placed.width, height: placed.height } : undefined;
    if (seen === "read") setImmediate(() => void hiding.warm(file));
    return [200, { file, kind: "photo", ...(size === undefined ? {} : { width: size.width, height: size.height }), ...(seen === "failed" ? { read: false } : {}) }];
  };

  const stageAskFile = async (principal: Principal, request: IncomingMessage, reach: Reach, file: string): Promise<[number, JsonObject]> => {
    askServerOnly(principal, request, reach, "the picture the model got is staged by the Ask server, on the home's Mac");
    if (!BLOB_NAME.test(file)) refuse(422, "FILE_BAD", "a file is named sha256:<64 hex>");
    return [200, { file: await landAskFile(request, file) }];
  };

  const dropAskFile = (principal: Principal, request: IncomingMessage, reach: Reach, file: string): [number, JsonObject] => {
    askServerOnly(principal, request, reach, "the picture the model got is dropped by the Ask server, on the home's Mac");
    if (!BLOB_NAME.test(file)) refuse(422, "FILE_BAD", "a file is named sha256:<64 hex>");
    const dropped = stage.drop(file);
    if (dropped) forgetFindings(findings, file, held);
    return [200, { dropped }];
  };

  const pickWork = workLine(PICK_RUNS);

  const readPicture = async (file: string): Promise<"read" | "cannot" | "failed"> => {
    try {
      return "cannot" in await pictures.read(file) ? "cannot" : "read";
    } catch (error) {
      if (stopping.signal.aborted) throw error;
      log(JSON.stringify({ at: new Date(clock()).toISOString(), ask: "a photo's read failed", error: errorText(error) }));
      return "failed";
    }
  };

  const matchPicture = async (file: string): Promise<Awaited<ReturnType<Match>>> => {
    try {
      const forgotten = matchesForgotten(findings);
      const picture = await held.materialise(file);
      try {
        const placed = await match(picture.path, stopping.signal);
        if (placed !== null && "faces" in placed) keepMatch(findings, file, placed.faces, held, forgotten);
        return placed;
      } finally {
        picture.dispose();
      }
    } catch (error) {
      if (stopping.signal.aborted) throw error;
      log(JSON.stringify({ at: new Date(clock()).toISOString(), ask: "a photo's faces were not matched", error: errorText(error) }));
      return null;
    }
  };

  const askNote = async (principal: Principal, request: IncomingMessage, reach: Reach, note: string, second: string | undefined): Promise<[number, JsonObject]> => {
    if (second === "join" && request.method === "POST") return askJoin(principal, request, reach, note);
    assertAllowed(principal, "read");
    if (!NOTE_ID.test(note)) refuse(422, "NOTE_BAD", "a note's id is 32 hex");
    if (second === undefined && request.method === "POST") {
      stage.open(note);
      openNote(note);
      return [200, { note }];
    }
    if (second === undefined && request.method === "DELETE") {
      await stage.cancel(note);
      runners.release(note);
      void tell({ verb: "chat-voice", cancel: note });
      return [200, { note }];
    }
    if (second === undefined || request.method !== "PUT") return [404, { message: "unknown endpoint" }];
    if (!/^\d{1,3}$/u.test(second)) refuse(422, "NOTE_BAD", "a note's second is 0 to 599");
    room("new", SECOND_BYTES);
    const bytes = await bodyOf(request, SECOND_BYTES, silentMs, (landed) => received.set(request, landed));
    const kept = await stage.second(note, Number(second), bytes);
    openNote(note);
    return [200, { note, second: Number(second), held: kept === "held" }];
  };

  const openNote = (note: string): void => {
    void tell({ verb: "chat-voice", open: note }).then((answer) => {
      if (typeof answer !== "object" || answer === null || !("runner" in answer)) return;
      const { runner } = answer as { runner: unknown };
      if (typeof runner !== "string" || stage.closed(note)) return runners.release(note);
      if (runners.reserve(note, runner)) log(JSON.stringify({ at: new Date(clock()).toISOString(), ask: "a voice note holds a runner", note, runner }));
    });
  };

  const askJoin = async (principal: Principal, request: IncomingMessage, reach: Reach, note: string): Promise<[number, JsonObject]> => {
    askServerOnly(principal, request, reach, "a note's join is the Ask server's, on the home's Mac");
    const said = await body(request);
    if (Object.keys(said).some((key) => key !== "seconds")) refuse(422, "NOTE_BAD", "a note's join is asked as {seconds}");
    return [200, await sealing(async () => stage.join(note, said.seconds as number))];
  };

  const takenOf = (file: string): Taken | undefined => {
    const facts = readExif((bytes) => held.prefix(file, bytes));
    if (facts?.taken === undefined) return undefined;
    let time;
    try {
      time = instant(facts.taken.clock, "local", facts.taken.offset === undefined ? { zone: read().day.zone } : { offset: facts.taken.offset });
    } catch (error) {
      if (error instanceof TimeError) return undefined;
      throw error;
    }
    return {
      ms: time.start_ms, ...(time.offset_min === undefined ? {} : { offset_min: time.offset_min }),
      ...(facts.gps === undefined ? {} : { at: [facts.gps.latitude, facts.gps.longitude] as const }),
    };
  };

  const askTaken = async (principal: Principal, request: IncomingMessage, reach: Reach): Promise<[number, JsonObject]> => {
    askServerOnly(principal, request, reach, "a photo's facts are the Ask server's, on the home's Mac");
    const { photos } = await body(request);
    if (!Array.isArray(photos) || photos.length > TAKEN_MAX || !photos.every((photo) => typeof photo === "string" && BLOB_NAME.test(photo))) {
      refuse(422, "TAKEN_BAD", `photos is a list of at most ${TAKEN_MAX} blobs, sha256:<64 hex>`);
    }
    return [200, { photos: (photos as string[]).map((file) => {
      const taken = held.has(file) ? takenOf(file) : undefined;
      return taken === undefined ? { file } : { file, taken: takenAnswer(taken) };
    }) }];
  };

  const modelsRead = async (principal: Principal, request: IncomingMessage, reach: Reach): Promise<[number, JsonObject]> => {
    askServerOnly(principal, request, reach, "the models are read again for Chat's sign-ins and turns alone, on the home's Mac");
    return [200, await relay({ verb: "models-read" }, "POST /v1/models/read", request) as JsonObject];
  };

  const askErased = (principal: Principal, request: IncomingMessage, reach: Reach, chats: readonly string[]): [number, JsonObject] => {
    askServerOnly(principal, request, reach, "whether a conversation is erased is the Ask server's to ask, on the home's Mac");
    if (chats.length === 0 || chats.length > ERASED_MAX || !chats.every((chat) => CHAT_ID.test(chat))) {
      refuse(422, "ERASED_BAD", `chat is named 1 to ${ERASED_MAX} times, each <13 digits>-<6 hex>`);
    }
    return [200, { erased: [...new Set(chats)].filter((chat) => stage.erased(chat)) }];
  };

  const voicedOf = (audio: readonly string[]): Promise<string[]> => viewed<string[]>({ voiced: { source: `ask:local:${read().unit}`, audio } });

  const askWords = async (principal: Principal, request: IncomingMessage, reach: Reach): Promise<[number, JsonObject]> => {
    if (!askPassAt(request, reach)) assertAllowed(principal, "read");
    const said = await body(request);
    const { audio, note } = said;
    if (typeof audio !== "string" || !BLOB_NAME.test(audio) || (note !== undefined && (typeof note !== "string" || !NOTE_ID.test(note))) || Object.keys(said).some((key) => key !== "audio" && key !== "note")) {
      refuse(422, "BAD_REQUEST", "a note's words are asked as {audio: \"sha256:<64 hex>\", note?: \"<32 hex>\"}");
    }
    if (!stage.laned(audio) && (await voicedOf([audio])).length === 0) refuse(409, "CHAT_ERASED", "This conversation was erased.");
    if (typeof note === "string") await stage.close(note);
    try {
      return [200, await relay({ verb: "chat-voice", words: audio, ...(note === undefined ? {} : { note }) }, "POST /v1/ask/words", request) as JsonObject];
    } finally {
      if (typeof note === "string") runners.release(note);
    }
  };

  const feedback = async (principal: Principal, request: IncomingMessage): Promise<[number, JsonObject]> => {
    assertAllowed(principal, "read");
    const said = await body(request);
    const noted = async (): Promise<[number, JsonObject]> => [200, await relay({ verb: "agent", call: "feedback", body: said, pass: principal.id }, "POST /v1/feedback", request) as JsonObject];
    return principal.kind === "agent" || principal.turn !== undefined ? await modelCall(principal, request, "feedback", said, noted) : await noted();
  };

  const feedbackOpen = options.feedbackOpen ?? FEEDBACK_URL !== null;
  const personOnly = (principal: Principal, request: IncomingMessage): void => {
    const person = principal.kind === null || principal.kind === "mac" || principal.kind === "phone";
    if (!person || principal.turn !== undefined || request.headers[SERVER_HEADER] !== undefined || request.headers[READER_HEADER] === "model") {
      refuse(403, "PRINCIPAL_SCOPE", `principal ${principal.id} is not the person's: only you send feedback, from Lifestream`);
    }
    assertAllowed(principal, "read");
  };
  const reportAnswer = (answer: JsonObject): [number, JsonObject] => {
    if (answer.closed === true || typeof answer.gone === "string") refuse(404, "NOT_FOUND", typeof answer.gone === "string" ? answer.gone : "unknown endpoint");
    if (typeof answer.refused === "string") refuse(422, "BAD_REQUEST", answer.refused);
    return [200, answer];
  };

  const report = async (principal: Principal, request: IncomingMessage, url: URL, call: string): Promise<[number, JsonObject]> => {
    if (!feedbackOpen || request.method !== "POST") return [404, { message: "unknown endpoint" }];
    personOnly(principal, request);
    const act = `POST /v1/feedback/${call}` as Act;
    if (call === "screenshot") {
      const id = url.searchParams.get("id");
      if (id === null || !UUID_V4.test(id) || [...url.searchParams.keys()].some((key) => key !== "id")) refuse(422, "BAD_REQUEST", "a screenshot is sent as ?id=<the draft's id, a UUID v4>");
      if (request.headers["content-length"] === undefined) refuse(411, "LENGTH_REQUIRED", "a screenshot states its length (Content-Length)");
      if (Number(request.headers["content-length"]) > SHOT_BYTES) refuse(413, "FILE_TOO_LARGE", SHOT_TOO_LARGE);
      reportAnswer(await relay({ verb: "feedback", call: "held", id }, act, request) as JsonObject);
      const hash = await landAskFile(request, undefined, SHOT_RULE);
      const size = shotSize(stage.staged(hash)?.bytes() ?? Buffer.alloc(0));
      if (size === null) {
        stage.drop(hash);
        refuse(415, "FILE_KIND", "Lifestream can't read this screenshot's size.");
      }
      const [status, answer] = reportAnswer(await relay({ verb: "feedback", call: "screenshot", id, hash, ...size }, act, request) as JsonObject);
      return [status, answer.held === true ? size : answer];
    }
    const said = await body(request);
    if (typeof said.id !== "string" || !UUID_V4.test(said.id)) refuse(422, "BAD_REQUEST", "a report's id is a UUID v4, minted when the form opens");
    if (call === "draft") {
      const about = aboutOf(said.about);
      if (about === null || Object.keys(said).some((key) => key !== "id" && key !== "about")) {
        refuse(422, "BAD_REQUEST", "a draft is asked as {id, about}, about {kind: \"menu\"}, {kind: \"chat\", chat, n} or {kind: \"connector\", connector}");
      }
      const version = deviceHeader(request.headers["lifestream-device"])?.version ?? null;
      const kind = principal.kind === "mac" || principal.kind === "phone" ? principal.kind : null;
      return reportAnswer(await relay({ verb: "feedback", call: "draft", id: said.id, about: { ...about }, by: principal.unit, device: { kind, version } }, act, request) as JsonObject);
    }
    const { text, email, keep } = said;
    const kinds = FEEDBACK_KINDS as readonly string[];
    if (typeof text !== "string" || !(email === null || typeof email === "string") || !Array.isArray(keep) || keep.some((kind) => typeof kind !== "string" || !kinds.includes(kind))
      || new Set(keep).size !== keep.length || Object.keys(said).some((key) => !["id", "text", "email", "keep"].includes(key))) {
      refuse(422, "BAD_REQUEST", `a report is sent as {id, text, email: string or null, keep: kinds of ${FEEDBACK_KINDS.join(", ")}}`);
    }
    return reportAnswer(await relay({ verb: "feedback", call: "send", id: said.id, text, email, keep: keep as FeedbackKind[], by: principal.unit }, act, request) as JsonObject);
  };

  const feedbackPageRoute = (principal: Principal, request: IncomingMessage): Promise<Reply> | Reply => {
    personOnly(principal, request);
    const etag = request.headers["if-none-match"];
    return servePage("feedback", feedbackPage(feedbackOpen), {
      url: request.url ?? "/", now_ms: clock(), gzip: /\bgzip\b/u.test(request.headers["accept-encoding"] ?? ""), ...(etag === undefined ? {} : { if_none_match: etag }),
      held: { machine: at.dir, sites: stations.sites(), present: stations.present(), refused: stations.refused(), stated: stated.held() },
    }, read().day);
  };

  const modelCall = async (principal: Principal, request: IncomingMessage, tool: string, sent: Json,
    work: (begun: ReaderCallBegun) => Promise<[number, JsonObject] | [number, JsonObject, Json]>): Promise<[number, JsonObject]> => {
    const at_ms = clock();
    const begun = await writer.begin({
      reader: principal.kind === "agent" ? principal.id : CHAT_READER, tool, sent, at_ms,
      initialize: request.headers[SESSION_HEADER] === "new", existing: await viewed<EditorAccount[]>({ offered: true }),
    });
    if ("moved" in begun) return starting();
    let result: [number, JsonObject] | [number, JsonObject, Json];
    try {
      result = await work(begun);
    } catch (error) {
      await writer.end({ id: begun.id, ...(error instanceof Refusal ? { result: "refused", code: error.code, words: error.words } : { result: "failed", words: "The door failed." }), ms: clock() - at_ms, withheld: [] }).catch(() => false);
      throw error;
    }
    const [status, answer, read] = result;
    await writer.end({ id: begun.id, result: "answered", words: null, ms: clock() - at_ms, withheld: [], ...(read === undefined ? {} : { read }) }).catch(() => false);
    return [status, answer];
  };

  const ownAccess = async (principal: Principal, request: IncomingMessage, pathname: string): Promise<[number, JsonObject]> => {
    if (principal.kind !== "agent") refuse(403, "PRINCIPAL_SCOPE", `principal ${principal.id} is no agent's: an agent reads and changes its own access here`);
    if (request.method === "GET") {
      return await modelCall(principal, request, "access", null, async (begun) => [200, await person.own(principal.id, begun.access) as unknown as JsonObject]);
    }
    const said = await body(request);
    if (pathname === ACCESS_DROP_ROUTE) {
      return await modelCall(principal, request, "access", said, async () => {
        const { answer, read } = await person.drop(principal.id, said);
        return [200, answer as unknown as JsonObject, read];
      });
    }
    return await modelCall(principal, request, "access", said, async () => {
      const { answer, read } = await person.request(principal.id, said, (value) => putBack(principal, value));
      return [200, answer as unknown as JsonObject, read];
    });
  };

  const putBack = async (principal: Principal, value: string): Promise<string> => {
    if (!PLACEHOLDER.test(value)) return value;
    const answer = await hiding.restore(hiddenReader(principal), { params: [{ value }] }) as { params: { value: string; unknown: string[] }[] };
    const [back] = answer.params;
    if (back === undefined || back.unknown.length > 0) {
      refuse(422, "BAD_REQUEST", `${(back?.unknown ?? [value]).join(", ")}: not a placeholder you were given: pass each exactly as an answer gave it.`);
    }
    return back.value;
  };

  const exchange = async (principal: Principal, reach: Reach, request: IncomingMessage): Promise<[number, JsonObject]> => {
    if (principal.kind !== "mac" && principal.kind !== "phone") refuse(403, "PRINCIPAL_SCOPE", `pass ${principal.id} is no device's: an exchange is a Mac's or an iPhone's`);
    const { offers, drained, grants, settings: applies, sending, found, imports, room, network, recorder, stores, through } = await body(request);
    if (offers !== undefined && (!Array.isArray(offers) || offers.some((offer) => typeof offer !== "string"))) refuse(422, "BAD_REQUEST", "offers is a list of source ids");
    if (drained !== undefined && drained !== true) refuse(422, "BAD_REQUEST", "drained is true or absent");
    const told = {
      grants: grantsIn(grants), settings: settingsIn(applies), sending: sendingIn(sending), found: foundIn(found), imports: importsIn(imports),
      room: roomIn(room), network: networkIn(network), recorder: recorderIn(recorder), stores: storesIn(stores),
    };
    const values = throughIn(through);
    if (drained === true) return handedOver(current(principal), reach, request);
    const kind = deviceOf(principal);
    const own = { ...told, network: kind === "mac" && reach === "loopback" ? told.network : undefined, recorder: kind === "mac" ? told.recorder : undefined,
      stores: kind === "mac" ? told.stores : undefined };
    if (kind !== null) stated.exchange(principal, custody.replaced(principal) ? undefined : own);
    const fresh = kind === null ? [] : ((offers ?? []) as string[]).filter((id) => !principal.sources.includes(id) && offered(kind, principal.unit, id, connectors) !== null);
    const { taken, news } = values === undefined ? { taken: {}, news: false } : takeThrough(principal, values);
    if (news) stated.delivered(principal);
    if (Object.keys(taken).length > 0) void tell({ verb: "through", values: taken });
    if (fresh.length > 0) {
      await tell({ verb: "offers", pass: principal.id, offers: fresh });
    }
    return [200, await custody.answer(current(principal), reach)];
  };

  const leftOut = new Map<string, string>();
  const newest = new Map<string, number>();

  const takeThrough = (principal: Principal, values: Readonly<Record<string, ThroughStated>>): { taken: JsonObject; news: boolean } => {
    if (custody.replaced(principal)) return { taken: {}, news: false };
    const named = new Set(custody.delivers(principal).filter((source) => ownerSource(source, read().unit) === null));
    const now = clock();
    const taken: JsonObject = {};
    let news = false;
    for (const [source, { seal, ...value }] of Object.entries(values)) {
      const byPass = named.has(source) ? custody.throughOf(source) : {};
      const fault = !named.has(source) ? "not-delivered" : value.stated_ms > now + CLOCK_AHEAD_MS ? "clock-ahead"
        : value.read_through_ms > value.stated_ms ? "read-after-stated" : seal !== undefined && seal > (byPass[principal.id] ?? 0) ? "seal-ahead" : null;
      if (fault === null) {
        leftOut.delete(source);
        taken[source] = { value, received: byPass };
        const key = `${principal.id} ${source}`;
        if (value.stated_ms > (newest.get(key) ?? -Infinity)) {
          newest.set(key, value.stated_ms);
          news = true;
        }
      } else if (leftOut.get(source) !== fault) {
        leftOut.set(source, fault);
        log(JSON.stringify({ at: new Date(now).toISOString(), through: source, pass: principal.id, left_out: fault }));
      }
    }
    return { taken, news };
  };

  const handedOver = async (principal: Principal, reach: Reach, request: IncomingMessage): Promise<[number, JsonObject]> => {
    const answer = await custody.answer(principal, reach);
    const sources = Object.values(answer.sources as Record<string, { received: number; imported: number }>);
    if (answer.replaced === undefined) refuse(409, "NOT_DRAINED", `pass ${principal.id} is its unit's to record with: it is not replaced`, undefined, { answer });
    if (sources.some((source) => source.imported !== source.received)) {
      refuse(409, "NOT_DRAINED", "the home has not imported every seal this pass delivered: ship on, and say so again", undefined, { answer });
    }
    await relay({ verb: "drained", pass: principal.id }, "POST /v1/exchange drained", request);
    return [200, answer];
  };

  const modelReader = async (principal: Principal, chat: string | string[] | undefined): Promise<HiddenReader> => {
    const reader = hiddenReader(principal);
    if (principal.kind === "agent" || principal.turn !== undefined || typeof chat !== "string" || !ASK_CHAT.test(chat)) return reader;
    return { ...reader, agent: null, turn: { table: `chat:${chat}`, level: (await hiding.chat(chat)).level as LevelName } };
  };

  const chatPrivacy = async (principal: Principal, request: IncomingMessage, reach: Reach, id: string | null): Promise<JsonObject> => {
    if (!askPassAt(request, reach)) assertAllowed(principal, "read");
    if (id === null) refuse(422, "BAD_REQUEST", "a conversation's id is one path segment");
    const pinned = principal.turn?.chat === id ? principal.turn.level ?? undefined : undefined;
    return await hiding.chat(id, pinned);
  };

  const keepLevel = async (principal: Principal): Promise<JsonObject> => {
    const turn = principal.turn;
    if (turn === undefined || turn.chat === null || turn.level === null) {
      refuse(403, "PRINCIPAL_SCOPE", `principal ${principal.id}: a conversation's level is kept on its question's turn pass alone, by Ask`);
    }
    const kept = await hiding.keep(`chat:${turn.chat}`, turn.level, turn.pick ?? undefined);
    turns.pin(turn.id, kept);
    return { chat: turn.chat, level: kept };
  };

  const askQuestion = async (principal: Principal, request: IncomingMessage): Promise<{ chat: string; level: LevelName; pick?: LevelName; read: Buffer }> => {
    const { level, ...said } = await body(request);
    if (said.chat !== undefined && (typeof said.chat !== "string" || !ASK_CHAT.test(said.chat))) refuse(422, "BAD_REQUEST", "chat is a conversation's id, as its chat event named it");
    if (level !== undefined) {
      const person = principal.kind === null || principal.kind === "mac" || principal.kind === "phone";
      if (!person || request.headers[SERVER_HEADER] !== undefined) {
        refuse(403, "PRINCIPAL_SCOPE", `principal ${principal.id} is not the person's: only you pick a conversation's privacy, in Chat`);
      }
      if (!LEVEL_NAMES.includes(level as LevelName)) refuse(422, "BAD_REQUEST", `a conversation's level is ${LEVEL_NAMES.join(", ")}`);
    }
    const chat = typeof said.chat === "string" ? said.chat : `${clock()}-${randomBytes(3).toString("hex")}`;
    const pick = level as LevelName | undefined;
    const pinned = pick ?? (await hiding.chat(chat)).level as LevelName;
    return { chat, level: pinned, ...(pick === undefined ? {} : { pick }), read: Buffer.from(JSON.stringify(said)) };
  };

  const reported = <R extends { what: string; key: string | null }>(row: R, sent: boolean): R | (R & JsonObject) => {
    if (row.what !== "feedback") return row;
    const kept = reportOfRow(handle, row.key);
    const report = kept === undefined ? null : { state: kept.state, words: REPORT_WORDS.states[kept.state], receiver: REPORT_WORDS.receiver, erased: kept.sent_before_erasure ? REPORT_WORDS.erased : null };
    return { ...row, report, ...(sent ? { sent: kept === undefined ? null : sentOf(kept) } : {}) } as R & JsonObject;
  };

  const outboundRoute = async (principal: Principal, pathname: string, url: URL): Promise<[number, JsonObject]> => {
    if (principal.kind === "agent") refuse(403, "PRINCIPAL_SCOPE", `principal ${principal.id} is an agent's: what left the home is the person's to read`);
    assertAllowed(principal, "read");
    const day = read().day;
    const one = OUTBOUND_ROW.exec(pathname);
    if (one !== null) {
      const row = await writer.row(Number(one[1]), day);
      return row === null ? refuse(404, "NOT_FOUND", `no outbound row ${one[1]}`) : [200, reported(row, true) as unknown as JsonObject];
    }
    const param = (name: string) => url.searchParams.get(name) ?? undefined;
    const [source, kind, key, family, item] = (["source", "kind", "key", "family", "item"] as const).map(param);
    const byRecord = source !== undefined || kind !== undefined || key !== undefined;
    const byItem = family !== undefined || item !== undefined;
    if (byRecord || byItem) {
      if (byRecord && byItem) refuse(422, "BAD_REQUEST", "one record (source, kind, key) or one item (family, item), never both");
      if (byRecord && (source === undefined || kind === undefined || key === undefined)) refuse(422, "BAD_REQUEST", "a record is named by its source, kind and key together");
      if (byItem && (family === undefined || item === undefined)) refuse(422, "BAD_REQUEST", "an item is named by its family and item together");
      if (["from", "to", "receiver", "before"].some((name) => url.searchParams.has(name))) refuse(422, "BAD_REQUEST", "where one record or item went is read whole: it takes no range, receiver or page");
      const rows = byRecord ? await writer.carried({ source: source!, kind: kind!, key: key! }, day) : await writer.asked({ family: family!, item: item! }, day);
      return [200, { rows: rows.map((row) => reported(row, false)) } as unknown as JsonObject];
    }
    const before = param("before");
    if (before !== undefined && !OUTBOUND_SEQ.test(before)) refuse(422, "BAD_REQUEST", "before is an outbound row's seq");
    const from = param("from") ?? civilDay(clock(), day);
    const receiver = param("receiver");
    const list = await writer.list({ from, to: param("to") ?? from, day, ...(receiver === undefined ? {} : { receiver }), ...(before === undefined ? {} : { before: Number(before) }) });
    return [200, { ...list, rows: list.rows.map((row) => reported(row, false)) } as unknown as JsonObject];
  };

  const restoring = async (principal: Principal): Promise<[number, JsonObject]> => {
    if (principal.kind !== "phone") refuse(403, "PRINCIPAL_SCOPE", `pass ${principal.id} is no phone's`);
    const delivers = custody.delivers(principal);
    const importing = await custody.importing(restoredSources(connectors, principal.unit, delivers));
    if (importing.length > 0) notNow("busy", `Lifestream is still importing ${importing.join(", ")}: ask again in a moment.`, RETRY_SOON_S);
    const points = await custody.readPoints(principal.unit, delivers);
    return [200, await viewed<JsonObject>({ restore: { pass: principal, delivers, points } })];
  };

  const statements = async (connector: OwnerReader, principal: Principal, bundle: AcquisitionBundle, id: string, hash: string | undefined): Promise<Stated> => {
    const { manifest } = bundle;
    if (manifest.custody !== undefined) refuse(422, "ACQUISITION_MANIFEST", `${manifest.source_id} is the owner's: a bundle of its statements states no custody`);
    if (hash !== undefined && !manifest.files.some((file) => file.sha256.startsWith(hash))) {
      refuse(422, "ACQUISITION_ID_MISMATCH", `the id's ${hash} is not the start of the SHA-256 of the statements the bundle lists`);
    }
    const facts = { ...manifest.facts, device: principal.unit };
    const entries = new Map(manifest.files.map((file) => [`sha256:${file.sha256}`, bundle.files.get(file.file)!]));
    const bytes = (blob: string) => entries.get(blob)!.bytes(settings.max_bundle_bytes);
    const files: BlobReader = {
      has: (blob) => entries.has(blob), bytes, text: (blob) => bytes(blob).toString("utf8"), prefix: (blob, length) => bytes(blob).subarray(0, length),
      materialise: () => Promise.reject(new Error("an owner-statements bundle is read whole")),
    };
    const delivery: Delivery = {
      id, source: manifest.source_id, sealed_ms: statedMs(manifest), stated_ms: statedMs(manifest), facts,
      files: manifest.files.map((file) => ({ path: file.file, blob: `sha256:${file.sha256}`, size: file.bytes })),
    };
    const named = new Set<string>();
    const checked: { locator: string; content: JsonObject; rule: (content: JsonObject, pictures: Pictures) => string | undefined }[] = [];
    const asks = connector.name === ASK_READER;
    const chats = new Set<string>();
    const audio = new Set<string>();
    try {
      for await (const row of connector.read(delivery, files)) {
        if (row.refused !== undefined) refuse(422, "STATEMENTS_BAD", row.refused);
        const rule = connector.statements[row.kind]?.picture;
        if (row.gone !== true && rule !== undefined) checked.push({ locator: row.locator!, content: row.content as JsonObject, rule });
        for (const blob of row.blobs ?? []) named.add(blob);
        if (asks) {
          const content = row.content as JsonObject | null;
          const chat = row.kind === "chat" ? row.key : typeof content?.chat === "string" ? content.chat : row.key.split(":")[0]!;
          chats.add(chat);
          const voice = row.kind === "msg" && content?.role === "user" && isObject(content.voice) ? content.voice.audio : undefined;
          if (typeof voice === "string") audio.add(voice);
        }
      }
    } catch (error) {
      if (error instanceof Refused) refuse(422, "STATEMENTS_BAD", error.message);
      throw error;
    }
    if ([...chats].some((chat) => stage.erased(chat))) refuse(422, "CHAT_ERASED", "This conversation was erased.");
    const asked = [...new Set(checked.flatMap(({ content }) => blobsIn(content)))];
    const holds = new Set(asked.length === 0 ? [] : await viewed<string[]>({ served: asked }));
    const kept = { has: (blob: string) => holds.has(blob), materialise: (blob: string) => stored.materialise(blob) };
    if (asks) {
      const unstaged = [...audio].filter((blob) => !stage.has(blob) && !bundle.blobs.has(blob.slice(7)));
      const voiced = new Set(unstaged.length === 0 ? [] : await voicedOf(unstaged));
      for (const blob of unstaged) if (!voiced.has(blob)) holds.delete(blob);
      const missing = [...named].filter((blob) => !bundle.blobs.has(blob.slice(7)) && !stage.has(blob) && !kept.has(blob));
      if (missing.length > 0) missingFiles({ photos: missing.filter((blob) => !audio.has(blob)), audio: missing.filter((blob) => audio.has(blob)) });
    }
    const pictures: Pictures = {
      carried: (blob) => {
        const entry = bundle.blobs.get(blob.replace(/^sha256:/u, ""));
        return entry === undefined ? undefined : { size: entry.size, bytes: () => entry.bytes(settings.max_bundle_bytes) };
      },
      held: kept.has,
      ...(asks ? { staged: (blob: string) => stage.staged(blob) } : {}),
    };
    for (const { locator, content, rule } of checked) {
      const fault = rule(content, pictures);
      if (fault !== undefined) refuse(422, "STATEMENTS_BAD", `${locator.replace(":", " line ")}: ${fault}`);
    }
    const stray = [...bundle.blobs.keys()].find((hex) => !named.has(`sha256:${hex}`));
    if (stray !== undefined) refuse(422, "STATEMENTS_BAD", `the bundle carries blob sha256:${stray}, which no statement's picture is`);
    return { facts, files: asks ? [...named].filter((blob) => !bundle.blobs.has(blob.slice(7))) : [], audio: [...audio], kept, chats: [...chats] };
  };

  const ownerAct = async (principal: Principal, request: IncomingMessage): Promise<[number, JsonObject]> => {
    let action: unknown;
    try { action = JSON.parse((await bodyOf(request, BODY_BYTES, silentMs, (bytes) => received.set(request, bytes))).toString("utf8")); } catch (error) {
      if (error instanceof Refusal) throw error;
      action = undefined;
    }
    if (typeof action !== "object" || action === null || Array.isArray(action)) refuse(400, "BAD_ACTION", "An action is a JSON object.");
    const of = (action as JsonObject).of;
    if (!isOwnerProduct(of)) refuse(400, "BAD_ACTION", "An action says what it changes: of people, places or devices.");
    delivers(principal, `${of as string}:local:${read().unit}`);
    return [200, await relay({ verb: "owner-act", device: principal.unit, action: action as JsonObject }, "POST /v1/owner/act", request) as JsonObject];
  };

  const sealClaim = async (claim: TabClaim): Promise<void> => {
    const pass = stationsPass(at, handle) ?? notNow("starting", "the door holds no pass to seal a claim with: the home has not started on this release", RETRY_SOON_S);
    const source = pass.sources[0]!;
    const bytes = Buffer.from(`${canonical(tabClaim(claim))}\n`);
    const made_ms = clock();
    const fetched_at = new Date(made_ms).toISOString();
    const name = `${basicInstant(fetched_at)}.${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`;
    await custody.seal(pass, "loopback", {
      lane: source, name, custody: undefined, only: source, carried: [], quiet: [], stated_ms: made_ms,
      write: (stamp) => sealing(async () => {
        const sealed = openSealing(handle, { source, name, feeder: "owner-statements", fetched_at });
        try {
          await sealed.write(STATEMENTS_FILE, Readable.from([bytes]));
          sealed.seal({ statements: 1, blobs_carried: 0, device: pass.unit }, undefined, stamp);
        } catch (error) {
          sealed.abandon();
          throw error;
        }
      }),
    });
    nudged.owe(`${source}/${name}`);
  };

  const putAcquisition = async (principal: Principal, reach: Reach, source: string, basic: string, hash: string | undefined, request: IncomingMessage): Promise<[number, JsonObject]> => {
    const edited = ownerProductOf(ownerSource(source, read().unit)?.connector);
    if (edited !== null) refuse(403, "PRINCIPAL_SCOPE", `the owner's ${edited} are changed through POST /v1/owner/act`);
    delivers(principal, source);
    const owner = ownerReaders().find((connector) => connector.name === ownerSource(source, read().unit)?.connector);
    if (hash !== undefined && owner === undefined) refuse(422, "ACQUISITION_ID_MISMATCH", `only the owner's statements name their hash in the id; ${source} is no owner source`);
    if (hash === undefined && owner !== undefined) refuse(422, "ACQUISITION_ID_MISMATCH", `${source} is the owner's: its id is <made-at>.<the first 12 hex of the statements' SHA-256>`);
    const name = owner === undefined ? basic : `${basic}.${hash}`;
    const id = `${source}/${name}`;
    if (readSealed(handle, deliveryDirectory(handle, source, name)) !== null) return [200, await custody.answer(principal, reach)];
    const partial = join(uploads, `${randomUUID()}.zip.partial`);
    await upload(id, partial, request, async (body) => {
      await receive(request, partial, body);
      const bundle = openAcquisitionBundle(handle.file(UPLOAD, partial));
      try {
        if (bundle.id !== `${source}/${basic}`) refuse(422, "ACQUISITION_ID_MISMATCH", `path id ${id} differs from manifest ${bundle.id}`);
        const members = [...bundle.files.values(), ...bundle.blobs.values()];
        if (members.length === 0 && principal.kind !== null && owner === undefined) refuse(422, "ACQUISITION_MANIFEST", `${id} holds no file and no blob: a device's bundle carries what it seals`);
        lands(body, members.reduce((sum, member) => sum + member.size, 0));
        const { manifest } = bundle;
        if (Object.hasOwn(manifest.facts, "archive")) refuse(422, "ACQUISITION_MANIFEST", "Update Lifestream on this Mac to go on");
        const owned = owner === undefined ? undefined : await statements(owner, principal, bundle, id, hash);
        await custody.seal(principal, reach, {
          lane: source, name, custody: manifest.custody, only: source, carried: [source], quiet: [],
          stated_ms: statedMs(manifest), write: (stamp) => sealing(async () => {
            if (owned === undefined) return void await sealAcquisitionBundle(handle, bundle, stamp, { name, facts: manifest.facts });
            if (owned.chats.some((chat) => stage.erased(chat))) refuse(422, "CHAT_ERASED", "This conversation was erased.");
            const carried = await stage.carry(owned.files, inboxLane(handle, source), owned.kept);
            if (carried.missing.length > 0) {
              carried.undo();
              missingFiles({ photos: carried.missing.filter((blob) => !owned.audio.includes(blob)), audio: carried.missing.filter((blob) => owned.audio.includes(blob)) });
            }
            try {
              await sealAcquisitionBundle(handle, bundle, stamp, { name, facts: { ...owned.facts, blobs_carried: bundle.blobs.size + carried.carried.length } });
            } catch (error) {
              carried.undo();
              throw error;
            }
          }),
        });
        if (owner === undefined && principal.kind !== null) stated.delivered(principal);
      } finally { bundle.close(); }
    });
    nudged.owe(id);
    return [201, await custody.answer(principal, reach)];
  };

  const putPhone = async (principal: Principal, reach: Reach, bundleId: string, request: IncomingMessage): Promise<[number, JsonObject]> => {
    const lane = principal.kind === "phone" ? laneOf("phone", principal.unit)! : refuse(403, "PRINCIPAL_SCOPE", `pass ${principal.id} is no phone's`);
    assertAllowed(principal, "deliver", lane);
    const id = `${lane}/${bundleId}`;
    if (readSealed(handle, deliveryDirectory(handle, lane, bundleId)) !== null) return [200, await custody.answer(principal, reach)];
    const partial = join(uploads, `${randomUUID()}.zip.partial`);
    await upload(id, partial, request, async (body) => {
      await receive(request, partial, body);
      const bundle = await readers.bundle(partial);
      if (bundle.bundle_id !== bundleId) refuse(422, "IOS_BUNDLE_ID_MISMATCH", `path id ${bundleId} differs from manifest ${bundle.bundle_id}`);
      lands(body, Object.values(bundle.files).reduce((sum, file) => sum + file.bytes, 0));
      let seals;
      try {
        seals = bundle.manifest.custody === undefined || (bundle.manifest.custody !== null && typeof bundle.manifest.custody === "object" && !Array.isArray(bundle.manifest.custody) && Object.keys(bundle.manifest.custody).length === 0) ? undefined : readCustody(bundle.manifest.custody, "manifest.custody");
      } catch (error) {
        if (error instanceof InboxError) refuse(422, "IOS_BUNDLE_BAD_MANIFEST", error.message);
        throw error;
      }
      for (const source of bundle.sat_out) {
        if (seals?.[source] !== undefined) refuse(422, "IOS_BUNDLE_BAD_MANIFEST", `${source} sits this bundle out, and its custody states seal ${seals[source]!.seal}`);
        if (!principal.sources.includes(source)) refuse(422, "IOS_BUNDLE_BAD_MANIFEST", `${source} sits this bundle out, and pass ${principal.id} does not deliver it`);
      }
      const carried = principal.sources.filter((source) => bundle.domains.some(({ domain }) => domain === iosDomainOf(source)));
      await custody.seal(principal, reach, {
        lane, name: bundleId, custody: seals, carried,
        quiet: principal.sources.filter((source) => iosDomainOf(source) !== null && !carried.includes(source) && !bundle.sat_out.includes(source)),
        stated_ms: statedAt({ created_at: bundle.created_at }),
        write: (stamp) => sealing(async () => {
          const delivery = openSealing(handle, { source: lane, name: bundleId, feeder: "ios-bundle", fetched_at: stamp.sealed_at });
          try {
            await sealPhoneBundle(handle, partial, bundle, delivery, { lane: inboxLane(handle, lane), home: stored, custody: seals, stamp });
          } catch (error) { delivery.abandon(); throw error; }
        }),
      });
      stated.delivered(principal);
    });
    nudged.owe(id);
    return [201, await custody.answer(principal, reach)];
  };

  const working = new Map<Promise<unknown>, { socket: Socket; kind: () => keyof Cut; unanswered: () => boolean }>();
  const listener = (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const started = performance.now();
    arrived.set(request, Date.now());
    const url = new URL(request.url ?? "/", "http://door");
    const pathname = url.pathname;
    const reach = reachOf(request.socket);
    let principal: Principal | undefined;
    let logged = false;
    const line = (status: number, extra: JsonObject = {}): void => {
      if (logged) return;
      logged = true;
      log(JSON.stringify({
        at: new Date(clock()).toISOString(), method: request.method ?? "-", path: routeOf(pathname), principal: principal?.id ?? "-",
        status, bytes: received.get(request) ?? 0, milliseconds: Math.round(performance.now() - started), ...deviceLine(request, reach), ...extra,
      }));
    };
    const readOf = (timed: Timed | null, queued_ms?: number): JsonObject => ({
      rows: timed?.rows ?? 0,
      ...(performance.now() - started <= slowMs ? {} : {
        ...(queued_ms === undefined ? {} : { queued_ms: Math.round(queued_ms) }),
        ...(timed === null ? {} : { slowest: { sql: timed.slowest.sql, ms: Math.round(timed.slowest.ms) }, statements: timed.statements, statements_ms: Math.round(timed.ms) }),
      }),
    });
    const answer = (status: number, body: JsonObject, retryAfter?: number, cut = false): void => {
      const headers = { "content-type": "application/json", ...(retryAfter === undefined ? {} : { "retry-after": String(retryAfter) }) };
      if (cut) return refuseCut(request, response, status, headers, JSON.stringify(body), lingerMs);
      response.writeHead(status, headers);
      response.end(JSON.stringify(body));
    };
    return (async () => {
      try {
        let result: [number, JsonObject];
        if (request.method === "POST" && pathname === "/v1/pair") result = await pair(request, reach);
        else {
          const admit = (): Principal => stall.timed("principals", () =>
            authenticate(handle, request.headers.authorization, reach, { now_ms: clock(), public: request.headers["lifestream-reach"] === "public", turns }));
          principal = admit();
          asked(principal.id);
          if (!DELIVERING(request.method, pathname) && replacedPass(principal)) {
            refuse(403, "PRINCIPAL_SCOPE", `pass ${principal.id} is replaced: its device delivers what it holds, and reads nothing`);
          }
          const noting = request.method === "POST" && pathname === FEEDBACK_ROUTE;
          const hidden = request.method === "POST" && (pathname === HIDE_ROUTE || pathname === RESTORE_ROUTE);
          const modelRead = request.method === "POST" && (TOOL_ROUTES as readonly string[]).includes(pathname);
          if ((principal.kind === "agent" || principal.turn !== undefined) && !modelReaches(principal, request.method, url)) {
            refuse(403, "PRINCIPAL_SCOPE", `principal ${principal.id} reads for a model, which does not reach ${request.method} ${pathname}`);
          }
          const owning = (request.method === "GET" && pathname === ACCESS_ROUTE) || (request.method === "POST" && (pathname === ACCESS_REQUEST_ROUTE || pathname === ACCESS_DROP_ROUTE));
          if (hidden || modelRead || owning) assertThroughServer(handle, principal, request.headers[SERVER_HEADER], reach, clock());
          const wire = peerWires.find((each) => each.wire.half(request.method, pathname) !== null);
          const half = wire?.wire.half(request.method, pathname) ?? null;
          const alone = peerWires.find((each) => each.alone && each.peer(principal!));
          if (alone !== undefined && !(wire === alone && half === "peer")) {
            refuse(403, "PRINCIPAL_SCOPE", `principal ${principal.id} is a ${alone.noun}'s: it reaches its exchange, and nothing else`);
          }
          const placing = `${request.method} ${pathname}` === `POST ${RUNNER_CALLS}`;
          const finds = principal.scopes.includes("find");
          if (finds && !(wire?.wire === runners && half === "drive")) {
            refuse(403, "PRINCIPAL_SCOPE", `principal ${principal.id} is a find pass: it lists the runners and places a find in the mark line, and nothing else`);
          }
          if (!finds && principal.scopes.includes("call") !== placing) {
            if (placing) refuse(403, "PRINCIPAL_SCOPE", `principal ${principal.id} is no model call's: a runner call is placed on the pass the home hands that call`);
            refuse(403, "PRINCIPAL_SCOPE", `principal ${principal.id} is a model call's: it places a call on a runner, and nothing else`);
          }
          if ((principal.kind === "phone" || principal.kind === "mac") && principal.turn === undefined) stated.heard(principal);
          if (ASK_ROUTE.test(pathname)) {
            if (pathname !== "/v1/ask/login") assertAllowed(principal, "read");
            else if (!(principal.kind === "mac" && reach === "loopback")) refuse(403, "PRINCIPAL_SCOPE", "Ask is signed in from Lifestream on the Mac it runs on");
            device(principal.kind, request);
            const onward = pathname.slice("/v1".length);
            const question = request.method === "POST" && pathname === "/v1/ask";
            let authorization = request.headers.authorization ?? "";
            let read: Buffer | undefined;
            let ended = (): void => undefined;
            if (pathname !== "/v1/ask/login") {
              const asked = question ? await askQuestion(principal, request) : null;
              read = asked?.read;
              const made = turns.open(principal, asked === null ? null : { chat: asked.chat, level: asked.level, pick: asked.pick ?? null }, `${request.method} ${onward}`);
              authorization = `Bearer ${made.token}`;
              ended = () => turns.forget(made.turn);
            }
            response.on("close", () => line(response.statusCode));
            await forwardAsk(askServer, `${onward}${url.search}`, authorization, request, response, stopping.signal,
              { ...(read === undefined ? {} : { read }), follow: question, ended });
            return;
          }
          if (wire !== undefined && half !== null) {
            if (half === "drive" && !(wire.drives(principal) && reach === "loopback")) refuse(403, "PRINCIPAL_SCOPE", `principal ${principal.id} does not drive ${wire.noun}s from here`);
            const said = `${request.method} ${pathname}`;
            if (half === "peer") {
              if (!wire.peer(principal)) refuse(403, "PRINCIPAL_SCOPE", `principal ${principal.id} is no ${wire.noun}'s`);
              const named = deviceHeader(request.headers["lifestream-device"]);
              if (said === wire.exchange && wire.below !== undefined && named?.kind === principal.kind && belowFloor(floors, named.kind, named.version)) await wire.below(principal.unit, named.version, request);
              device(principal.kind, request);
            }
            const quiet = said === wire.exchange || said === wire.listing;
            response.on("close", () => {
              if (!quiet || response.statusCode !== 200) line(response.statusCode);
            });
            await wire.wire.serve(half === "peer" ? { peer: principal.unit } : { drive: true, ...(finds ? { line: "mark" as const } : {}) }, request, response);
            return;
          }
          const photos = request.method === "GET" && pathname === WANTED_ROUTE ? wantedAsk(principal, reach, url) : undefined;
          const prepared = request.method === "GET" ? reads.prepared(pathname) : undefined;
          const computed = request.method === "GET" ? reads.reply(pathname) : undefined;
          const route = request.method === "GET" && computed === undefined && prepared === undefined ? reads.route(pathname) : undefined;
          if (prepared !== undefined || computed !== undefined || route !== undefined) {
            const back = principal.scopes.includes("deliver") && url.search === "" && principal.sources.some((source) => ownerSource(source, read().unit)?.route === pathname);
            const driven = principal.scopes.includes("drive") && reach === "loopback" && DRIVEN_REPORTS.includes(pathname);
            const asked = pathname === ASK_CONNECTORS_ROUTE && url.search === "" && askPassAt(request, reach);
            if (!back && !driven && !asked && photos === undefined) assertAllowed(principal, "read");
            device(principal.kind, request);
            if (pathname === MODELS_ROUTE || pathname === PAGES.modelDefaults.route || pathname === PAGES.modelProviders.route) void tell({ verb: "models-list" });
            const gzip = /\bgzip\b/u.test(request.headers["accept-encoding"] ?? "");
            const etag = request.headers["if-none-match"];
            const reader = principal.kind === "agent" || principal.turn !== undefined || request.headers[READER_HEADER] === "model" ? "model" as const : undefined;
            const kindSaid = deviceHeader(request.headers["lifestream-device"])?.kind;
            const asking = kindSaid === undefined ? undefined : { kind: kindSaid, unit: kindSaid === principal.kind ? principal.unit : null };
            const ask = <H>(held: H) => ({ url: request.url ?? "/", now_ms: clock(), gzip, ...(etag === undefined ? {} : { if_none_match: etag }), ...(reader === undefined ? {} : { reader }), ...(asking === undefined ? {} : { device: asking }), held });
            if (prepared !== undefined || computed !== undefined) {
              stopping.signal.throwIfAborted();
              const ends = new AbortController();
              const stop = () => ends.abort(stopping.signal.reason);
              response.once("close", () => ends.abort());
              stopping.signal.addEventListener("abort", stop, { once: true });
              try {
                const typed = computed !== undefined && pathname === SUGGEST_ROUTE ? await typedAsk(url, request) : undefined;
                const meaning = computed !== undefined && pathname === "/v1/search" ? await searchMeaning(meaningAsked(url.searchParams), ends.signal) : undefined;
                const key = JSON.stringify([request.url, gzip, etag ?? null, photos ?? null, typed ?? null, meaning ?? null, reader ?? null, asking ?? null]);
                const { reply, read: computedRead } = await readSettled(pathname, url.searchParams, settling, (signal) => readers.ask(pathname, {
                  ...(prepared === undefined ? {} : { prepared: () => ask({ machine: at.dir }) }),
                  ...(computed === undefined ? {} : {
                    computed: {
                      key, ask: () => ask({
                        machine: at.dir, sites: stations.sites(), present: stations.present(), refused: stations.refused(), stated: stated.held(), asked: custody.asked(), ...(photos === undefined ? {} : { photos }), ...(typed === undefined ? {} : { typed }),
                        ...(meaning === undefined ? {} : { meaning }),
                      }),
                    },
                  }),
                }, signal), ends.signal);
                response.writeHead(reply.status, reply.headers);
                response.end(reply.body);
                line(reply.status, computedRead === undefined ? {} : {
                  ...(reply.code === undefined ? {} : { code: reply.code }), ...(reply.screen_ms === undefined ? {} : { screen_ms: reply.screen_ms }), ...readOf(computedRead.timed, computedRead.queued_ms),
                });
                return;
              } catch (error) {
                if (!response.destroyed) throw error;
                return;
              } finally { stopping.signal.removeEventListener("abort", stop); }
            }
            response.on("close", () => line(response.statusCode));
            const still = (): boolean => {
              try {
                return !replacedPass(admit());
              } catch {
                return false;
              }
            };
            await route!(request, response, { machine: at.dir, still, ...(principal.kind === "agent" ? {} : { stage }) });
            return;
          }
          device(principal.kind, request);
          if (request.method === "PUT" && retired(folder)) notNow("busy", MOVED_AWAY, RETRY_FULL_S);
          const phone = request.method === "PUT" ? PHONE_ROUTE.exec(pathname) : null;
          const streamed = request.method === "POST" ? STREAM_ROUTE.exec(pathname) : null;
          const acquisition = request.method === "PUT" ? ACQUISITION_ROUTE.exec(pathname) : null;
          const source = acquisition === null ? null : decodeSegment(acquisition[1]!);
          if (request.method === "POST" && pathname === CHAT_ROUTE) {
            response.once("close", () => line(response.statusCode));
            await chatting(principal, request, response, reach);
            return;
          }
          if (request.method === "GET" && (pathname === WAITING_ROUTE || pathname === GUIDES_ROUTE || pathname === PAGES.feedback.route)) {
            const reply = pathname === PAGES.feedback.route ? await feedbackPageRoute(principal, request) : await (pathname === WAITING_ROUTE ? waitingRoute : guidesRoute)(principal, reach, request);
            response.writeHead(reply.status, reply.headers);
            response.end(reply.body);
            line(reply.status);
            return;
          }
          if (request.method === "GET" && pathname === ME_ROUTE) {
            const turn = principal.turn === undefined ? {} : { turn: { chat: principal.turn.chat, relayed: turns.relayed(principal.turn.id) } };
            result = [200, { id: principal.id, kind: principal.kind, resource: principal.agent?.resource ?? null, ...turn, ...(handle.form === "keyed" ? { keyed: true } : {}) }];
          }
          else if (person.routes(request.method, pathname)) result = await personRoute(principal, reach, request, url);
          else if (pathname.startsWith(AGENTS_PREFIX)) result = await agentsRoute(principal, reach, request, pathname);
          else if (SUBSCRIPTIONS_ROUTE.test(pathname)) result = await subscriptions(principal, reach, request, pathname);
          else if (request.method === "POST" && pathname === ASK_FILES_ROUTE) result = await askFile(principal, request);
          else if (request.method === "PUT" && ASK_FILE_ROUTE.test(pathname)) result = await stageAskFile(principal, request, reach, decodeSegment(ASK_FILE_ROUTE.exec(pathname)![1]!) ?? "");
          else if (request.method === "DELETE" && ASK_FILE_ROUTE.test(pathname)) result = dropAskFile(principal, request, reach, decodeSegment(ASK_FILE_ROUTE.exec(pathname)![1]!) ?? "");
          else if (ASK_NOTE_ROUTE.test(pathname)) result = await askNote(principal, request, reach, ASK_NOTE_ROUTE.exec(pathname)![1]!, ASK_NOTE_ROUTE.exec(pathname)![2]);
          else if (request.method === "POST" && pathname === ASK_WORDS_ROUTE) result = await askWords(principal, request, reach);
          else if (request.method === "POST" && pathname === ASK_TAKEN_ROUTE) result = await askTaken(principal, request, reach);
          else if (request.method === "POST" && pathname === MODELS_READ_ROUTE) result = await modelsRead(principal, request, reach);
          else if (request.method === "GET" && pathname === ASK_ERASED_ROUTE) result = askErased(principal, request, reach, url.searchParams.getAll("chat"));
          else if (noting) result = await feedback(principal, request);
          else if (REPORT_ROUTE.test(pathname)) result = await report(principal, request, url, REPORT_ROUTE.exec(pathname)![1]!);
          else if (owning) result = await ownAccess(principal, request, pathname);
          else if (request.method === "POST" && pathname === "/v1/exchange") result = await exchange(principal, reach, request);
          else if (request.method === "POST" && pathname === HELD_ROUTE) result = await heldBlobs(principal, request);
          else if (request.method === "POST" && pathname === IMPORTS_HELD_ROUTE) result = await heldImports(principal, request);
          else if (request.method === "POST" && pathname === "/v1/act") result = await act(principal, request);
          else if (request.method === "POST" && pathname === "/v1/refresh") result = await refreshRoute({ connectors, custody, body, relay: (asked) => relay(asked, "POST /v1/refresh", request) })(principal, request, reach);
          else if (request.method === "POST" && pathname === OWNER_ACT_ROUTE) result = await ownerAct(principal, request);
          else if (request.method === "POST" && pathname === "/v1/account") result = await stateAccount(principal, request);
          else if (request.method === "POST" && isFieldRoute(pathname)) result = await fields(principal, pathname, request);
          else if (request.method === "POST" && isSignInRoute(pathname)) result = await signins(principal, pathname, request);
          else if (request.method === "POST" && pathname === "/v1/process") result = await chooseItem(principal, request);
          else if (streamed !== null) result = await stream(principal, decodeSegment(streamed[1]!), request);
          else if (request.method === "GET" && pathname === "/v1/restore") result = await restoring(principal);
          else if (request.method === "GET" && (pathname === OUTBOUND_ROUTE || OUTBOUND_ROW.test(pathname))) result = await outboundRoute(principal, pathname, url);
          else if (modelRead) {
            assertAllowed(principal, "read");
            const { status, value } = await hiding.read(await modelReader(principal, request.headers[CHAT_HEADER]), pathname as ToolRoute, await body(request), request.headers[SESSION_HEADER] === "new");
            result = [status, value];
          }
          else if (hidden || (request.method === "POST" && pathname === OUTBOUND_ROUTE) || (request.method === "GET" && pathname === PRIVACY_ROUTE)) {
            assertAllowed(principal, "read");
            const reader = hiddenReader(principal);
            if (request.method === "GET") {
              result = [200, await hiding.state()];
            }
            else {
              const said = await body(request);
              result = [200, await (pathname === HIDE_ROUTE ? hiding.hide(reader, said) : pathname === RESTORE_ROUTE ? hiding.restore(reader, said)
                : hiding.link(reader, said))];
            }
          }
          else if (request.method === "POST" && pathname === KEEP_ROUTE) result = [200, await keepLevel(principal)];
          else if (CHAT_PRIVACY_ROUTE.test(pathname) && request.method === "GET") {
            result = [200, await chatPrivacy(principal, request, reach, decodeSegment(CHAT_PRIVACY_ROUTE.exec(pathname)![1]!))];
          }
          else if (request.method === "GET" && pathname === STATED_ROUTE) {
            if (!(principal.scopes.includes("drive") && reach === "loopback")) refuse(403, "PRINCIPAL_SCOPE", `principal ${principal.id} does not read what the devices stated from here`);
            result = [200, { stated: stated.held() }];
          }
          else if (phone !== null) result = await putPhone(principal, reach, phone[1]!, request);
          else if (source !== null) result = await putAcquisition(principal, reach, source, acquisition![2]!, acquisition![3], request);
          else result = [404, { message: "unknown endpoint" }];
        }
        answer(...result);
        line(result[0]);
      } catch (caught) {
        const error = threads !== undefined && endedByCut(caught) ? stopping.signal.reason as Error : caught;
        if (diskFailed(error)) {
          const fail = () => failed(`storage: ${errorText(error)}`);
          if (response.closed) fail();
          else response.once("close", fail);
        }
        if (response.headersSent) {
          response.destroy();
          line(response.statusCode, { message: scrub((error as Error).message ?? String(error)) });
        } else if (error instanceof Refusal) {
          answer(error.status, { code: error.code, message: error.words, ...error.extra }, error.retryAfter, error instanceof CutShort);
          line(error.status, { code: error.code, ...(error.status === 503 ? { message: scrub(error.words) } : {}),
            ...(error.status === 401 ? { token: tokenTag(request.headers.authorization) } : {}) });
        } else {
          answer(500, { message: "door failed" });
          line(500, { message: scrub((error as Error).message ?? String(error)), ...(error instanceof ReadFailed ? readOf(error.timed) : {}) });
        }
      }
    })();
  };

  const closing = (words: string): Refusal => notNowRefusal("starting", words, RETRY_SOON_S);
  let threads: Promise<void> | undefined;
  let left: Cut | null = null;
  let seated: (() => void) | undefined;
  const cut = (words: string): Cut | null => {
    if (threads !== undefined) return left;
    seated?.();
    if (working.size > 0) {
      left = { uploads: 0, feeds: 0, polls: 0, other: 0 };
      for (const each of working.values()) left[each.kind()]++;
    }
    if (!stopping.signal.aborted) stopping.abort(closing(words));
    threads = readers.close(stopping.signal.reason as Error);
    for (const each of working.values()) if (!each.unanswered()) each.socket.destroy();
    return left;
  };

  seated = intake.serve({ readers, connectors, settings: read, clock: dayClock, refused: () => stations.refused() });
  return {
    root,
    handle(request, response) {
      const answered = new Promise<void>((resolve) => response.once("close", () => resolve()));
      const done = Promise.all([answered, listener(request, response).catch(() => undefined)]);
      const pathname = new URL(request.url ?? "/", "http://door").pathname;
      const peer = peerWires.some((each) => each.wire.half(request.method, pathname) !== null);
      working.set(done, {
        socket: request.socket,
        kind: () => inBody.has(request) ? "uploads" : pathname === "/v1/feed" ? "feeds" : peer ? "polls" : "other",
        unanswered: () => !peer && pathname !== "/v1/feed" && (request.method === "GET" || request.method === "HEAD") && !response.headersSent,
      });
      void done.then(() => working.delete(done));
    },
    counts: () => ({ feeds: feed.following(), uploads: inBody.size }),
    peak: () => readers.peak(),
    cut,
    async close(words, how) {
      feed.close();
      stations.close();
      runners.close();
      sweeping();
      if (how === "cut") cut(words);
      else if (how === "answer") stopping.abort(closing(words));
      await Promise.all(working.keys());
      if (!stopping.signal.aborted) stopping.abort(closing(words));
      seated?.();
      await (threads ?? readers.close(closing(words)));
      await writer.close();
      marks.close();
    },
  };
}

type Waiting = { readonly wait: Wait; readonly words: string; readonly log?: string; readonly said: Said; readonly retry: number; readonly locked?: true };
const soon = (words: string): Waiting => ({ wait: "starting", words, said: STARTING_SAID, retry: RETRY_SOON_S });
const needs = (words: string, title: string, line: string, retry = RETRY_S, acts: Said["acts"] = []): Waiting =>
  ({ wait: "needs", words, said: { title, line, acts }, retry });
const away = (folder: string): Waiting => {
  const drive = driveOf(folder);
  return drive === null
    ? needs(awayWords(folder), "Lifestream's folder isn't there", `Lifestream waits for it at ${folder}`)
    : needs(awayWords(folder), "Lifestream's drive isn't connected", `Connect ${drive} and it starts again`);
};
const moved = (words: string): Waiting => needs(words, "Lifestream runs on another Mac now", "Pair with it");
const heldBy = (hold: Hold, folder: string, asking = false): Waiting => {
  const { message, detail, acts } = holdWords(hold, asking);
  return { ...needs(`${message}: ${detail}`, message, detail, RETRY_S, acts), log: holdLine(hold, folder) };
};
const CONNECTORS_UNLOADED = "Lifestream can't load its connectors";
const unopened = (words: string, title: string): Waiting => needs(words, title, "It tries again in a moment. Its log says why", RETRY_SOON_S);
const lockedBy = (why: string): Waiting => ({ ...needs(LOCKED_WORDS, "Lifestream is locked", "Unlock it on your Mac"), log: `locked: ${why}`, locked: true });
const UNTOLD: Waiting = { wait: "starting", words: NOT_READY, said: { title: "Lifestream isn't ready", line: null, acts: [] }, retry: RETRY_S };

export async function serveDoor(named: string | null, settings: DoorAddress, options: DoorOptions = {}): Promise<Door> {
  const clock = options.clock ?? Date.now;
  const at = options.machine ?? machine();
  const log = options.log ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const say = (line: JsonObject) => log(JSON.stringify({ at: new Date(clock()).toISOString(), ...line }));
  const stall = stalls(say);
  const tailnet = tailnetOf(options.interfaces);
  let opened: Opened | null = null;
  let why: Waiting = soon(STARTING);
  let heldHome: string | null = null;
  let lan: Awaited<ReturnType<typeof listenLan>> = null;
  const wanted = (): string | null => pointedAt(at) ?? named;
  let folder = wanted() ?? (() => { throw new LifecycleError(`this machine holds no home: ${CLI} adopt <folder> makes one`); })();
  let home: string | null = null;
  let intake: Intake | null = null;
  let turns: Promise<void> = Promise.resolve();
  const parting = new Set<Opened>();
  const retiring = new WeakMap<Opened, Promise<void>>();
  let built: string | null = null;
  let asking = false;
  const erasable = new ErasableStreams();

  const wait = (reason: Waiting, held: string | null = null): void => {
    if (reason.words !== why.words) say({ door: "waiting", why: reason.log ?? reason.words });
    why = reason;
    heldHome = held;
  };
  const unseat = (reason: Waiting, how: "cut" | "answer" | "swap", held: string | null = null): void => {
    const part = opened;
    if (part === null) return;
    opened = null;
    wait(reason, held);
    retire(part, reason.words, how === "swap" ? "answer" : how);
    if (how !== "swap") leave(reason.words, how);
  };
  const retire = (part: Opened, words: string, how: "cut" | "answer" | "drain"): Promise<void> => {
    const begun = retiring.get(part);
    if (begun !== undefined) {
      if (how === "cut") part.cut(words);
      return begun;
    }
    parting.add(part);
    const done = part.close(words, how).catch((error: unknown) => say({ door: "closing failed", error: errorText(error) })).finally(() => departed(part));
    retiring.set(part, done);
    return done;
  };
  const locked = (why: string): void => {
    leave(LOCKED_WORDS, "cut");
    wait(lockedBy(why));
  };
  const leave = (words: string, how: "cut" | "answer" | "drain"): void => {
    const leaving = intake;
    if (leaving === null) return;
    intake = null;
    const parts = [...parting].filter((part) => part.root === leaving.root);
    turns = turns.then(async () => {
      await Promise.all(parts.map((part) => retire(part, words, how)));
      leaving.close();
    }).catch((error: unknown) => say({ door: "closing failed", error: errorText(error) }));
  };
  const departed = (part: Opened): void => {
    parting.delete(part);
    high.queue = Math.max(high.queue, part.peak());
  };
  const serving = (): Opened | null => {
    if (opened === null) return null;
    if (!opened.root.held()) unseat(away(folder), "cut");
    else {
      const held = stall.timed("hold", () => readHold(at, opened!.root.id));
      if (held !== null) unseat(heldBy(held, folder), "cut", opened.root.id);
    }
    return opened;
  };
  const open = async (): Promise<boolean> => {
    folder = wanted() ?? folder;
    if (intake !== null && realPath(intake.folder) !== realPath(folder)) {
      leave(`Lifestream moved to ${folder}: the door opens it.`, "answer");
      return false;
    }
    const now = standing(folder, at);
    if ("home" in now && home !== null && now.home.id !== home) throw new LifecycleError(`another home is at ${now.folder}: the door serves ${home}`);
    const kept = "away" in now ? away(folder) : "refused" in now ? moved(now.refused) : now.hold === null ? null : heldBy(now.hold, now.folder);
    if (kept !== null) {
      leave(kept.words, "cut");
      wait(kept, "folder" in now ? now.home.id : null);
      return false;
    }
    let key = EMPTY_GENERATION;
    try {
      const asked = options.generation === undefined ? EMPTY_GENERATION : await options.generation(folder, at.dir);
      if (asked !== null && typeof asked === "object") {
        locked(asked.locked);
        return false;
      }
      key = asked ?? (homeFolders(folder).length === 0 ? EMPTY_GENERATION : "");
    } catch (error) {
      wait(unopened(`The door cannot load Lifestream's connectors now (${errorText(error)}): it tries again in a moment.`, CONNECTORS_UNLOADED));
      return false;
    }
    if (key === "") {
      wait(soon(STARTING));
      return false;
    }
    if (closing !== undefined) return false;
    const reused = intake;
    let seat: Intake | null = reused;
    let part: Opened | null = null;
    try {
      seat ??= openIntake(folder, options, () => reach(at, lan?.port ?? null), erasable);
      const mine = seat;
      part = openFolder(mine, folder, settings, options, (failed) => {
        if (intake !== mine) return say({ door: "storage failed", why: failed });
        const words = `The door's files in Lifestream's folder failed (${failed}): it opens them again in a moment.`;
        if (opened !== null) unseat(unopened(words, "Lifestream's files failed"), "cut");
        else leave(words, "cut");
      }, (socket) => sockets.get(socket) ?? "lan", mark, (pass) => askedBy.set(pass, (askedBy.get(pass) ?? 0) + 1));
    } catch (error) {
      if (reused === null) seat?.close();
      if (error instanceof AnotherDoor) throw error;
      if (error instanceof KeyError && error.code === "LOCKED") {
        locked(error.message);
        return false;
      }
      wait(unopened(`The door cannot open Lifestream's folder now (${errorText(error)}): it tries again in a moment.`, "Lifestream's folder can't be opened"));
      return false;
    }
    intake = seat;
    opened = part;
    home = part.root.id;
    built = key;
    return true;
  };
  const follow = (): void => {
    const part = opened;
    if (options.generation === undefined || asking || part === null) return;
    asking = true;
    void options.generation(folder, at.dir).then((key) => {
      if (key !== null && typeof key === "object") {
        if (opened === part) unseat(lockedBy(key.locked), "cut");
        return;
      }
      if (key !== null && opened === part && key !== built) {
        unseat(soon("Lifestream started again: the door opens its connectors."), "swap");
        look();
      }
    }, (error: unknown) => {
      if (opened === part) unseat(unopened(`The door cannot load Lifestream's connectors now (${errorText(error)}): it tries again in a moment.`, CONNECTORS_UNLOADED), "swap");
    }).finally(() => { asking = false; });
  };
  const look = (): void => {
    const pointing = wanted();
    if (opened !== null && pointing !== null && realPath(pointing) !== realPath(folder)) unseat(soon(`Lifestream moved to ${pointing}: the door opens it.`), "answer");
    if (closing !== undefined) return;
    if (serving() !== null) return follow();
    turns = turns.then(async () => {
      if (closing === undefined && opened === null && await open()) say({ door: "serving", home });
    }).catch((error: unknown) => stopDoor(errorText(error)));
  };

  const stopDoor = (reason: string): void => {
    if (closing !== undefined) return;
    closedFor = reason;
    void close();
  };

  const askVerify = (request: IncomingMessage, response: ServerResponse): void => {
    let principal = "-";
    let status: number;
    let body: JsonObject;
    let retry: number | undefined;
    try {
      const pass = authenticate(passFolder(folder), request.headers.authorization, sockets.get(request.socket) ?? "lan",
        { now_ms: clock(), public: request.headers["lifestream-reach"] === "public" });
      principal = pass.id;
      if (pass.kind !== "mac" && pass.kind !== "phone") refuse(403, "PRINCIPAL_SCOPE", `pass ${pass.id} is no device's: a check is asked on the person's Mac or iPhone`);
      const now = standing(folder, at);
      const admitted = "folder" in now ? admitAsk(at, now.home.id) : "free";
      if (admitted === "free") refuse(409, "NOT_HELD", "Lifestream is running: there is nothing to check.");
      if (admitted === "checking") refuse(409, "CHECKING", "Lifestream is already checking its database.");
      [status, body] = [202, { asked: true }];
    } catch (error) {
      if (error instanceof Refusal) [status, body, retry] = [error.status, { code: error.code, message: error.words, ...error.extra }, error.retryAfter];
      else {
        [status, body] = [500, { message: "door failed" }];
        say({ door: "verify ask failed", error: errorText(error) });
      }
    }
    response.writeHead(status, { "content-type": "application/json", ...(retry === undefined ? {} : { "retry-after": String(retry) }) });
    response.end(JSON.stringify(body));
    say({ method: "POST", path: VERIFY_ROUTE, principal, status, ...(typeof body.code === "string" ? { code: body.code } : {}) });
  };

  const askLeaving = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let principal = "-";
    let status: number;
    let body: JsonObject;
    let retry: number | undefined;
    try {
      const reach = sockets.get(request.socket) ?? "lan";
      const pass = authenticate(passFolder(wanted() ?? folder), request.headers.authorization, reach,
        { now_ms: clock(), public: request.headers["lifestream-reach"] === "public" });
      principal = pass.id;
      if (!(pass.scopes.includes("drive") && reach === "loopback")) refuse(403, "PRINCIPAL_SCOPE", `principal ${pass.id} does not cut the door's streams from here`);
      let said: unknown;
      try {
        const text = (await bodyOf(request, BODY_BYTES, options.silentMs ?? SILENT_MS)).toString("utf8").trim();
        said = text === "" ? {} : JSON.parse(text);
      } catch (error) {
        if (error instanceof Refusal) throw error;
        refuse(422, "BAD_REQUEST", "the body is a JSON object");
      }
      if (typeof said !== "object" || said === null || Array.isArray(said)) refuse(422, "BAD_REQUEST", "the body is a JSON object");
      const { blobs, days, people, all } = said as JsonObject;
      const list = (value: unknown, shape: RegExp) => value === undefined || (Array.isArray(value) && value.every((each) => typeof each === "string" && shape.test(each)));
      if (!list(blobs, BLOB_NAME) || (blobs as unknown[] | undefined ?? []).length > CUT_MOST) refuse(422, "BAD_REQUEST", `blobs is a list of at most ${CUT_MOST} sha256:<64 hex>`);
      if (!list(days, DAY_NAME)) refuse(422, "BAD_REQUEST", "days is a list of civil days, YYYY-MM-DD");
      if (![undefined, true].includes(people as never) || ![undefined, true].includes(all as never)) refuse(422, "BAD_REQUEST", "people and all are true when given");
      const removed: Removed = { ...blobs === undefined ? {} : { blobs: blobs as string[] }, ...days === undefined ? {} : { days: days as string[] }, ...people === true ? { people: true } : {}, ...all === true ? { all: true } : {} };
      [status, body] = [200, { cut: await erasable.cut(removed) }];
    } catch (error) {
      if (error instanceof Refusal) [status, body, retry] = [error.status, { code: error.code, message: error.words, ...error.extra }, error.retryAfter];
      else {
        [status, body] = [500, { message: "door failed" }];
        say({ door: "cut failed", error: errorText(error) });
      }
    }
    if (!response.destroyed) {
      response.writeHead(status, { "content-type": "application/json", ...(retry === undefined ? {} : { "retry-after": String(retry) }) });
      response.end(JSON.stringify(body));
    }
    say({ method: "POST", path: LEAVING_ROUTE, principal, status, ...(typeof body.code === "string" ? { code: body.code } : {}) });
  };

  const sockets = new Map<Socket, Reach>(), busy = new Set<Socket>();
  let closing: Promise<void> | undefined;
  let closedFor = "closed";
  const fresh = () => ({ loopback: 0, tailscale: 0, lan: 0, feeds: 0, uploads: 0, queue: 0 });
  let high = fresh();
  let askedBy = new Map<string, number>();
  const mark = (): void => {
    const now = { ...fresh(), ...opened?.counts() };
    for (const reach of sockets.values()) now[reach]++;
    for (const key of Object.keys(high) as (keyof typeof high)[]) high[key] = Math.max(high[key], now[key]);
  };
  const keep = (socket: Socket, reach: Reach): void => {
    sockets.set(socket, reach);
    socket.on("close", () => sockets.delete(socket));
    mark();
  };
  const passFolders = new Map<string, HomeFolder>();
  const passFolder = (root: string): HomeFolder => {
    if (intake !== null && intake.handle.root === root) return intake.handle;
    const held = passFolders.get(root);
    if (held !== undefined) return held;
    let opening: HomeFolder;
    try {
      opening = slotFolder(root, at.dir, "door", options.slot ?? NO_SLOT_KEY, clock());
    } catch (error) {
      if (error instanceof KeyError && error.code === "LOCKED") refuse(503, LOCKED, LOCKED_WORDS, RETRY_S);
      throw error;
    }
    if (existsSync(join(root, HOME_FILE))) passFolders.set(root, opening);
    return opening;
  };
  const passes = (request: IncomingMessage): boolean => {
    try {
      stall.timed("principals", () => authenticate(passFolder(folder), request.headers.authorization, "lan",
        { now_ms: clock(), public: request.headers["lifestream-reach"] === "public" }));
      return true;
    } catch {
      return false;
    }
  };
  const answerLocked = (request: IncomingMessage, response: ServerResponse): void => {
    response.writeHead(503, { "content-type": "application/json", "retry-after": String(RETRY_S) });
    response.end(JSON.stringify({ code: LOCKED, message: LOCKED_WORDS }));
    say({ method: request.method ?? "-", path: routeOf(new URL(request.url ?? "/", "http://door").pathname), principal: "-", status: 503,
      ...deviceLine(request, sockets.get(request.socket) ?? "lan"), code: LOCKED });
  };
  const server: Server = createServer({ requestTimeout: REQUEST_TIMEOUT_MS }, (request, response) => {
    if (refusedOn(request.socket)) return;
    busy.add(request.socket);
    mark();
    response.on("close", () => {
      busy.delete(request.socket);
      if (closing !== undefined) request.socket.destroySoon();
    });
    allowExtension(request, response);
    if (pathOf(request) === null) {
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ code: "BAD_PATH", message: "the request's target is not a path" }));
      say({ method: request.method ?? "-", path: "-", principal: "-", status: 400, code: "BAD_PATH" });
      return;
    }
    if (sockets.get(request.socket) === "loopback" && !isLoopbackHost(request.headers.host, request.socket.localPort)) {
      response.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ code: "HOST_REFUSED", message: "the door at loopback answers 127.0.0.1, localhost or [::1] at its port" }));
      say({ method: request.method ?? "-", path: routeOf(new URL(request.url ?? "/", "http://door").pathname), principal: "-", status: 403, code: "HOST_REFUSED" });
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (opened === null && why.locked === true) return answerLocked(request, response);
    if (request.method === "POST" && new URL(request.url ?? "/", "http://door").pathname === VERIFY_ROUTE && closing === undefined) return askVerify(request, response);
    if (request.method === "POST" && new URL(request.url ?? "/", "http://door").pathname === LEAVING_ROUTE) return void askLeaving(request, response);
    const part = serving();
    if (part !== null) return part.handle(request, response);
    const told = (sockets.get(request.socket) ?? "lan") !== "lan" || passes(request);
    const held = !told || heldHome === null || closing !== undefined ? null : stall.timed("hold", () => readHold(at, heldHome!));
    const said = !told ? UNTOLD : heldHome === null || closing !== undefined ? why
      : held === null ? soon(STARTING) : heldBy(held, folder, asked(at, heldHome));
    response.writeHead(503, { "content-type": "application/json", "retry-after": String(said.retry) });
    response.end(JSON.stringify({ code: NOT_NOW, message: said.words, ...waitBody(said.wait, said.said) }));
    say({ method: request.method ?? "-", path: routeOf(new URL(request.url ?? "/", "http://door").pathname), principal: "-", status: 503,
      ...deviceLine(request, sockets.get(request.socket) ?? "lan"), code: NOT_NOW, wait: said.wait, message: scrub(said.log ?? said.words) });
  });
  server.prependListener("connection", (socket: Socket) => {
    const reach = admits(socket, tailnet);
    if (reach !== null) keep(socket, reach);
  });
  await open();
  let port: number;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(settings.port, EVERY_ADDRESS, () => { server.off("error", reject); resolve(); });
    });
    port = (server.address() as AddressInfo).port;
  } catch (error) {
    server.close();
    const part = opened as Opened | null;
    if (part !== null) retire(part, "The door did not start.", "answer");
    leave("The door did not start.", "answer");
    await turns;
    throw error;
  }
  lan = await listenLan(server, settings, at, () => folder, say, keep);
  say({ door: "open", host: EVERY_ADDRESS, port, ...(lan === null ? {} : { lan: lan.port }), ...((opened as Opened | null) === null ? { waiting: why.words } : {}) });
  const looks = setInterval(look, options.lookMs ?? LOOK_MS);
  const delay = monitorEventLoopDelay();
  delay.enable();
  let wall = Date.now(), steady = performance.now();
  const minute = options.beats?.minute ?? ((tick: () => void) => {
    const every = setInterval(tick, LOOP_MS);
    return () => clearInterval(every);
  });
  const loops = minute(() => {
    mark();
    for (const part of [opened, ...parting]) if (part !== null) high.queue = Math.max(high.queue, part.peak());
    const [wallNow, steadyNow] = [Date.now(), performance.now()];
    say({ loop: { max_ms: Math.round(delay.max / 1e6), p99_ms: Math.round(delay.percentile(99) / 1e6), clock_gap_ms: Math.round((wallNow - wall) - (steadyNow - steady)), high,
      passes: Object.fromEntries(askedBy) } });
    [wall, steady] = [wallNow, steadyNow];
    delay.reset();
    high = fresh();
    askedBy = new Map();
    mark();
  });

  let ended!: () => void;
  const settled = new Promise<void>((resolve) => { ended = resolve; });
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const begun = performance.now();
      clearInterval(looks);
      loops();
      delay.disable();
      const closed = Promise.all([new Promise<void>((resolve) => NetServer.prototype.close.call(server, () => resolve())), lan?.close()]);
      const part = opened;
      opened = null;
      why = soon("The door is closing: try again in a moment.");
      let timer: NodeJS.Timeout | undefined;
      const drained = options.drain?.() ?? new Promise<void>((resolve) => { timer = setTimeout(resolve, DRAIN_MS); });
      if (part !== null) retire(part, why.words, "drain");
      leave(why.words, "drain");
      for (const socket of sockets.keys()) if (!busy.has(socket)) socket.destroy();
      await Promise.race([drained, Promise.all([closed, turns])]);
      clearTimeout(timer);
      const sockets_cut = [...sockets.keys()].filter((socket) => !socket.destroyed).length;
      let cut: Cut | null = null;
      for (const each of parting) {
        const left = each.cut(why.words);
        if (left === null) continue;
        cut ??= { uploads: 0, feeds: 0, polls: 0, other: 0 };
        for (const kind of Object.keys(left) as (keyof Cut)[]) cut[kind] += left[kind];
      }
      for (const socket of sockets.keys()) socket.destroy();
      await Promise.all([closed, turns]);
      server.close();
      lan?.end();
      say({ door: "closed", why: closedFor, ms: Math.round(performance.now() - begun), ...(cut === null && sockets_cut === 0 ? {} : { cut: { ...cut ?? { uploads: 0, feeds: 0, polls: 0, other: 0 }, sockets: sockets_cut } }) });
      ended();
    })();
    return closing;
  };
  return { port, close, closed: settled.then(() => closedFor) };
}

const GENERATION_ASK_MS = 10_000;
const EMPTY_GENERATION = "[]";

export type Generated = string | { readonly locked: string } | null;

export async function askGeneration(folder: string, machineDir: string): Promise<Generated> {
  let generation: Generation | { locked: unknown } | null;
  try {
    generation = await askHome(homeSocket(folder, machineDir), "generation", [], () => undefined, GENERATION_ASK_MS) as Generation | { locked: unknown } | null;
  } catch {
    return null;
  }
  if (generation === null) return null;
  if ("locked" in generation) return { locked: String(generation.locked) };
  const named = { ...generation, root: folder };
  if (JSON.stringify(handed(folder)) !== JSON.stringify(named)) handHeard(named);
  await admittedSet(folder);
  if (generation.folders.length === 0) return EMPTY_GENERATION;
  return JSON.stringify([generation.start, generation.folders.map((each) => [each.name, each.digest])]);
}

function takenAnswer(taken: Taken): JsonObject {
  return { ms: taken.ms, ...(taken.offset_min === undefined ? {} : { offset_min: taken.offset_min }), ...(taken.at === undefined ? {} : { at: [...taken.at] }) };
}

function headOf(file: KeptFile, length: number): Buffer {
  const opened = file.opened() ?? (() => { throw Object.assign(new Error(`${file.path} is gone`), { code: "ENOENT" }); })();
  try {
    const buffer = Buffer.alloc(length);
    let at = 0;
    for (let read = -1; read !== 0 && at < length; at += read) read = opened.read(buffer.subarray(at), at);
    return buffer.subarray(0, at);
  } finally {
    opened.close();
  }
}

function decodeSegment(text: string): string | null {
  try {
    const decoded = decodeURIComponent(text);
    return isSegment(decoded) ? decoded : null;
  } catch { return null; }
}

function blobsIn(value: unknown): string[] {
  if (typeof value === "string") return BLOB_NAME.test(value) ? [value] : [];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(blobsIn);
}

function endedByCut(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === "ECONNRESET" || code === "ERR_STREAM_PREMATURE_CLOSE";
}

function scrub(text: string): string {
  return text.replace(/[a-f0-9]{64}/gu, (hash) => hash.slice(0, 8));
}

function workLine(most: number): <T>(work: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (running >= most) await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next === undefined) running--;
      else next();
    }
  };
}
