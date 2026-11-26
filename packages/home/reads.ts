import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import type { ErasableStreams } from "./erasable-streams.js";
import { gzipSync } from "node:zlib";
import type Database from "better-sqlite3";
import {
  addDays, civilDay, dayBounds, DAYS_MARK, digest, GONE, isPlainWord, isSqliteError, parse, readTables, selects, sha256, TimeError, wellFormedJson, type BlobReader, type BlobStore, type DaySettings, type EnrichmentRow, type ExtractAfter, type ExtractRow,
  type ExtractSelect, type Head, type HeadAfter, type HomeFolder, type Json, type OpenView, type RecordRef, type Room, type Version,
} from "@lifestreamprotocol/core";
import {
  areaNames, areaOf, BEFORE_MS, findPeople, listEntry, candidatesOf, conversationOn, dayAtoms, distanceMeters, LABELS_FAMILY, labelsFrom, labelTable, MESSAGES_FAMILY, messagesUnit, networksIn,
  NAME_SHARE, namesOf, phrasesOf, PHYSICAL, PLACE_REACH_M, placeTable, REACH_DAYS, readCameras, resolveChat, resolvedChat, resolvedName, resolvedPlace,
  SCREEN_ACCOUNT, servedTable, suggest, SUGGESTIONS_LIMIT, SUGGESTIONS_MAX, summarise,
  photoRoutesIn, AI_FAMILY, aiChatsIn, namedCopyOf, type DayDocument, textFamilyOf, wanted, where, wordsOf as suggestedWords, type Answers, type GooglePlace, type Labels, type Piece, type Searched,
  type ServedPhoto, type PlaceTable, type Point, type RecordRead as FamilyRecordRead, type RecordText, type Said, type Where, type Words as SuggestWords, isRecording, unshownReader, VOICE_FAMILY, voiceItems, voiceItem,
} from "@lifestreamprotocol/families";
import { googlePlaces, productName, productsOf, type cameras, type Connector, type HeldSite, type RefusedStation } from "@lifestreamprotocol/connect";
import type { Ledger } from "@lifestreamprotocol/model";
import { categoryOf, type Access } from "@lifestreamprotocol/privacy";
import { offeredOf } from "./access-routes.js";
import { DAY_FILES, dayFile, readDayHead } from "./derive.js";
import { cameraNamed, type DeviceKind } from "./devices.js";
import { newest, type Feed } from "./feed.js";
import { freshSourcesOf } from "./freshness.js";
import { photoNamed, photoOfRecord, preparedFile, readPhoto, unheldWords, type PreparedFile } from "./photo.js";
import { modelsAt, modelsRead } from "./models-read.js";
import { modelsFindHandler, modelsHandler, type ModelsReads } from "./page-models.js";
import { storedModels } from "./models.js";
import { NOTHING_MADE, openMade, type MadeInput } from "./made.js";
import type { Made } from "./streams-report.js";
import { readProcessing } from "./processing.js";
import { peopleJoined } from "./people.js";
import { namesHeld, peoplePage, photoOf, searchedIn, youRow } from "./page-people.js";
import { findPage, groupPage, personPage, profilesOf, type Mail, type PersonReads } from "./page-person.js";
import { placeEditPage, placePage, placesPage, yearPage, type PlacesReads } from "./page-places.js";
import { searchKindPage, searchPage, type SearchReads } from "./page-search.js";
import { machine as thisMachine } from "./machine.js";
import { servePages } from "./page-serve.js";
import { settingsHandler, settingsPageHandler, type SettingsReads } from "./page-settings.js";
import { storageHandler, type StorageReads } from "./page-storage.js";
import { openAsks, streamsPage, type StreamsReads } from "./page-streams.js";
import { dayPageOf, daysPage, momentPage, threadPage, LISTING, type DaysReads } from "./page-days.js";
import { placesJoined } from "./places.js";
import { stagedOrStored, type Stage } from "./ask-files.js";
import type { HomeFile } from "./home-file.js";
import { readTime, timeParameter, type HomeClock } from "./home-clock.js";
import { historyGate, pauses } from "./jobs.js";
import type { Reach } from "./principals.js";
import { fromBlob, fromBytes, openPictures, picturesDirOf, RECIPE, SIZES, type Maker, type Pictures, type PictureSize } from "./pictures.js";
import { damaged, discardPrepared, openPrepared, PEOPLE, PLACES, preparedDirOf, preparedFileOf, readPrepared, type PreparedRead, type Shape as PreparedShape } from "./prepared.js";
import { NOT_NOW, notNow, notReadable, refuse, refused, Refusal, RETRY_SOON_S, SEARCH_REFUSALS, starting } from "./refusal.js";
import { screenFileOf } from "./screen-index.js";
import { screenAccounts, screenReads, screenSource, type HeldMeaning } from "./screen-reads.js";
import { indexAnswer, recordHold, recordRead, screenHold, type ScreenRead } from "./index-file.js";
import { Call, StoreDamaged, type CallStores, type KeptOut, type Reader } from "./call.js";
import { peopleMapOf, peopleSearchAnswer, type SealedPeople } from "./people-search.js";
import { busy } from "./screen-index.js";
import { searchFileOf, type RecordRead } from "./search-index.js";
import { PAGE_ROWS } from "./search-scan.js";
import { refsLeaving } from "./way-out.js";
import { GUARDED } from "./work.js";
import { meaningModel, recordPartOf, screenAnswerOf, searchAnswerOf, searchAskedOf, type Lent } from "./search-route.js";
import { kindsOf } from "./search-kinds.js";
import { kindsAnswer, kindsPage, kindsParams } from "./kinds-contract.js";
import { answerOf, argsOf, either, REFS_CHARS, REFS_MOST, ROUTES, type Citation, type ContractPath, type Of, type ReadParams, type Shape } from "./search-contract.js";
import type { Admission } from "./counting.js";
import {
  collectionsOf, countAskedOf, countAskOf, countIn, countShown, countWithAlso, readsOf, rowResolved, SnapshotMoved, plainCount,
  type Candidates, type Snapshot,
} from "./count.js";
import { describedOf, READ_ROWS, readAnswerOf, servedRefOf, type ReadSources, type ScreenSource } from "./read.js";
import type { Registry } from "./registry.js";
import { runningSettings, UNIT, type Settings } from "./settings.js";
import { homeSocket } from "./lifecycle.js";
import { askHome } from "./socket.js";
import type { Stated } from "./stated.js";
import { readHistories, readStatus, readStreams, withLedger, type DiskSpace } from "./status.js";
import { readStorage } from "./storage-read.js";
import { costView, priceStops } from "./estimate.js";
import { catalogOf } from "./catalog.js";
import { readRef } from "./refs.js";
import { paramsOf } from "./search-contract.js";
import { presenceAttached, presenceOver, type Presence, type PresenceSource } from "./presence.js";
import { isDated, recordBuilding } from "./search.js";
import { chatOpen, recordOpen } from "./open-in.js";
import { ownerOf, readsSource } from "./sources-read.js";
import type { Open } from "./wire.js";


type ReadRoute = (request: IncomingMessage, response: ServerResponse, held: Pick<Held, "machine"> & { still: () => boolean; stage?: Pick<Stage, "staged" | "materialise"> }) => void | Promise<void>;

export interface Ask {
  readonly url: string;
  readonly if_none_match?: string;
  readonly gzip?: boolean;
  readonly now_ms: number;
  readonly device?: { readonly kind: DeviceKind; readonly unit: string | null };
  readonly held: Held;
  readonly epoch?: number;
  readonly reader?: Reader;
  readonly step?: Step;
}

export interface Lends extends Lent {
  readonly pieces: true;
}

export interface Carries {
  readonly access?: Access;
  readonly sealed?: SealedPeople;
}

export type Step = (
  | { readonly ask: unknown; readonly lends?: Lends }
  | { readonly candidates: unknown }
  | { readonly counted: unknown; readonly admission: Admission; readonly snapshot: Snapshot }
) & Carries;

export function stepKey(path: string, step: Step, meaning: unknown): string {
  return JSON.stringify([path, step, meaning ?? null]);
}

export type Stepped = { candidates: Candidates } | { answer: unknown } | { moved: true };

const lent = (ask: Ask): Lends | undefined => (ask.step !== undefined && "ask" in ask.step ? ask.step.lends : undefined);

export interface Held {
  readonly machine: string;
  readonly sites: readonly HeldSite[];
  readonly present: readonly string[];
  readonly refused: readonly RefusedStation[];
  readonly stated: Stated;
  readonly asked?: readonly { unit: string; source: string }[];
  readonly photos?: HeldPhotos;
  readonly typed?: googlePlaces.TypedAnswer;
  readonly meaning?: HeldMeaning;
}

export interface TypedProvider {
  name: string;
  need: { words: string; act: { do: "set"; label: string; connector: string; member: string } } | null;
}

function typedProvider(connectors: readonly Connector[], typed: googlePlaces.TypedAnswer): TypedProvider {
  const declared = googlePlaces.connectors[0]!;
  const connector = connectors.find((each) => each.id === declared.id) ?? declared;
  const member = Object.entries(connector.fields ?? {}).find(([, field]) => field.kind === "secret")?.[0] ?? null;
  const act = (label: string) => ({ do: "set" as const, label, connector: connector.id, member: member! });
  if (member === null || (typed.google !== "no key" && typed.google !== "refused")) return { name: connector.name, need: null };
  return {
    name: connector.name,
    need: typed.google === "no key" ? { words: `Names from ${connector.name} come once Lifestream holds a key`, act: act("Add key") }
      : { words: `Your ${connector.name} key was refused`, act: act("Change key") },
  };
}

interface SpotSpans {
  latitude: number;
  longitude: number;
  photos: boolean;
  spans: { start_ms: number; end_ms: number; by: string }[];
}

export interface HeldPhotos {
  readonly source: string;
  readonly connector: string | null;
  readonly asking: readonly string[];
  readonly room: Room;
  readonly reach: Reach;
  readonly start_ms: number | null;
}

export interface Reply {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string | Uint8Array;
  readonly code?: string;
  readonly screen_ms?: number;
  readonly withheld?: KeptOut;
  readonly counting?: true;
}

type ReplyRoute = (ask: Ask) => Reply | Promise<Reply>;

export type PreparedAsk = Omit<Ask, "held"> & { readonly held: Pick<Held, "machine"> };

type PreparedRoute = (ask: PreparedAsk) => Reply | undefined;

interface Reads {
  reply(pathname: string): ReplyRoute | undefined;
  prepared(pathname: string): PreparedRoute | undefined;
  card(machine: string, hash: string): Card | undefined;
  route(pathname: string): ReadRoute | undefined;
}

const DEFAULT_LIMIT = 256;
const MAX_LIMIT = 1024;
const PAGE_BYTES = 8 << 20;
const MAX_ITEMS = 256;
const MAX_KINDS = 16;
const EXTRACT_CHUNK = 32;
const PHOTOS_PAGE = 60;
const PHOTOS_MOST = 120;
const PREPARING_S = 2;
const GRAINS = ["day", "month", "year"] as const;
const WHERE_DAYS = 366;
const DESCRIBING = "Lifestream's index is being written: ask again in a moment.";
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const BLOB = /^sha256:[0-9a-f]{64}$/u;
const CLOCK_ROUTE = "/v1/clock";
const SCREEN = "screen";
const TIMES_MOST = 2;
const PICTURES_ROUTE = "/v1/pictures";
const PHOTO_ROUTE = "/v1/photos/";
const SEARCH_ROUTE = "/v1/search";
const PERSON_MAILS = 6;
const KINDS_ROUTE = "/v1/search/kinds";
const COUNT_ROUTE = "/v1/count";
const PEOPLE_SEARCH_ROUTE = "/v1/people/search";
export const READ_ROUTE = "/v1/read";
export const DESCRIBE_ROUTE = "/v1/describe";
const PERSONAL_CACHE = "private, max-age=86400";
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/u;
const DAY_TYPES: Record<keyof typeof DAY_FILES, string> = {
  json: "application/json", txt: "text/plain; charset=utf-8", lines: "application/json",
};

interface Card {
  readonly type: string;
  readonly bytes: Uint8Array;
}

interface Shapes<Params, Answer> {
  params: Shape<Params>;
  answer: Shape<Answer>;
}

export function served(view: Pick<OpenView, "holds">, blobs: Pick<BlobReader, "has">, blob: string): boolean {
  return view.holds(blob) && blobs.has(blob);
}

export function openReads(input: {
  folder: HomeFolder; home: HomeFile; blobs: BlobStore; settings: () => Settings; registry?: Registry;
  streams?: {
    feed: Feed; serves(hash: string): Promise<boolean>; card(machine: string, hash: string): Promise<Card | undefined>;
    open: ErasableStreams;
    checked<T>(name: string, read: () => Promise<T>): Promise<T>;
  };
  maker?: Maker;
  clock?: HomeClock;
  space?: DiskSpace;
  readWaitMs?: number;
}): Reads {
  const { folder, home, blobs, streams, clock } = input;
  const { root } = folder;
  const networks = networksIn(input.registry?.families ?? []);
  const messagesFamily = input.registry?.families.find((family) => family.name === MESSAGES_FAMILY);
  const photoRoutes = photoRoutesIn(input.registry?.families ?? []);
  const aiChats = aiChatsIn(input.registry?.families ?? []);
  const filesOf = new Map<string, { search: string; people: string; places: string; pictures: Pictures }>();
  const files = (machine: string) => {
    let held = filesOf.get(machine);
    if (held === undefined) {
      filesOf.set(machine, held = {
        search: searchFileOf(root, machine), people: preparedFileOf(preparedDirOf(root, machine, "people"), "people"), places: preparedFileOf(preparedDirOf(root, machine, "places"), "places"),
        pictures: openPictures(picturesDirOf(folder, machine), input.maker),
      });
    }
    return held;
  };
  const runAgain = (machine: string, job: string): void => {
    void Promise.resolve().then(() => askHome(homeSocket(root, machine), "run", [job, job])).catch(() => undefined);
  };

  const wantsText = (query: Query): boolean => {
    const text = query.text("text");
    if (text !== undefined && text !== "1") bad("text", "is 1 or absent");
    if (text === "1" && input.registry === undefined) refuse(503, "TEXT_UNAVAILABLE", "this door reads no family, so it cannot give a record's words");
    return text === "1";
  };
  const textOf = (view: OpenView, ref: { source: string; kind: string; key: string }, version: Version): RecordText | null => {
    const row = view.source(ref.source);
    const family = row === undefined ? undefined : textFamilyOf(input.registry!.families, row, ref.kind);
    try {
      return family?.text?.of(ref, version, blobs, view) ?? null;
    } catch {
      return null;
    }
  };
  const spokenOf = (view: OpenView, ref: { source: string; kind: string; key: string }, version: Version): string | undefined => {
    const row = view.source(ref.source);
    if (input.registry === undefined || row === undefined || textFamilyOf(input.registry.families, row, ref.kind)?.name !== AI_FAMILY) return undefined;
    const content = version.content;
    const voice = typeof content === "object" && content !== null && !Array.isArray(content) ? content.voice : undefined;
    const audio = typeof voice === "object" && voice !== null && !Array.isArray(voice) ? voice.audio : undefined;
    return typeof audio === "string" ? audio : undefined;
  };
  const transcribedOf = (view: OpenView, ref: RecordRef, version: Version, now_ms: number): Made | undefined => {
    const extract = view.extract(VOICE_FAMILY, `${ref.source}/${ref.key}`);
    if (extract !== undefined && isRecording(extract)) {
      const asked = voiceItems(extract)[0];
      if (asked === undefined) return NOTHING_MADE;
      return withLedger(folder, (ledger) => openMade(view, madeInputOf(ledger, now_ms))({ family: VOICE_FAMILY, item: asked.item }));
    }
    const spoken = spokenOf(view, ref, version);
    return spoken === undefined ? undefined : withLedger(folder, (ledger) => openMade(view, madeInputOf(ledger, now_ms))({ family: AI_FAMILY, item: voiceItem(spoken) }));
  };
  const { settings } = input;
  const openOfRecord = (view: OpenView, ref: { source: string; kind: string; key: string }, version: Version | undefined): Open | null => {
    const row = view.source(ref.source);
    if (input.registry === undefined || row === undefined) return null;
    return recordOpen(catalogOf(input.registry.connectors).of(row), ref.kind, { account: row.account, key: ref.key, content: version?.content });
  };
  const openOfChat = (key: string, group: boolean): Open | null => {
    const at = key.indexOf(":");
    const connector = input.registry?.connectors.find((each) => each.product === key.slice(0, at));
    return chatOpen(connector, key.slice(at + 1), group);
  };

  const guarded = <R>(open: <T>(read: (on: R) => T) => T | undefined) => <T>(work: (on: R) => T): T => {
    let reading = false;
    let read: { value: T } | undefined;
    try {
      read = open((on) => {
        reading = true;
        return { value: work(on) };
      });
    } catch (error) {
      if (reading && !isSqliteError(error)) throw error;
      return notReadable(error);
    }
    if (read === undefined) starting();
    return read.value;
  };
  const viewed = guarded<OpenView>((read) => home.view(read));
  const raw = guarded<Database.Database>((read) => home.read(read));

  const storesOf = (machine: string): CallStores => ({
    view: () => {
      let held: ReturnType<HomeFile["open"]>;
      try {
        held = home.open();
      } catch (error) {
        return notReadable(error);
      }
      if (held === undefined) return starting();
      return { read: held.view, end: held.end };
    },
    index: (within) => recordHold(folder, files(machine).search, presenceAttached(presenceOf(machine)), within, input.readWaitMs),
    screen: () => screenHold(folder, screenFileOf(files(machine).search)),
    prepared: (which) => openPrepared(folder, files(machine)[which], (which === "people" ? PEOPLE : PLACES).format),
    damaged: (which) => {
      discardPrepared(files(machine)[which]);
      runAgain(machine, which);
    },
    presence: presenceOf(machine),
    peopleMap: (file) => peopleMapOf(file),
    labels: (view) => labelsFrom((unit) => view.extract(LABELS_FAMILY, unit), settings().day),
    chat: (asked, labels) => chatResolved(asked, labels),
    settings: () => settings().day,
    families: input.registry?.families ?? [],
    networks,
    screenAccounts: (view) => screenAccounts(view(), input.registry?.families ?? []),
    categories: (view) => categoryOf(offeredOf(view().sources(), input.registry?.connectors ?? [], input.registry?.families ?? [])),
  });
  const contractRoute = <P extends ContractPath>(
    path: P, budget: number, answer: (params: Of<(typeof ROUTES)[P]["params"]>, call: Call, ask: Ask) => Of<(typeof ROUTES)[P]["answer"]> | Promise<Of<(typeof ROUTES)[P]["answer"]>>,
  ): ReplyRoute => shapedRoute(path, ROUTES[path] as unknown as Shapes<Of<(typeof ROUTES)[P]["params"]>, Of<(typeof ROUTES)[P]["answer"]>>, budget, answer);
  const shapedRoute = <Params, Answer>(
    path: string, shapes: Shapes<Params, Answer>, budget: number, answer: (params: Params, call: Call, ask: Ask) => Answer | Promise<Answer>,
  ): ReplyRoute => (ask) => {
    const refusedAs = (error: unknown): never => {
      const refusal = busy(error) ? new Refusal(SEARCH_REFUSALS.NOT_NOW, "NOT_NOW", "Lifestream's index is being written: ask again in a moment", RETRY_SOON_S) : error;
      if (GUARDED && refusal instanceof Refusal) answerOf(SEARCH_ROUTE, refusal.status, { code: refusal.code, message: refusal.words, ...refusal.extra });
      throw refusal;
    };
    const missing = new Set<"people" | "places">();
    const step = ask.step;
    const attempt = (params: Params): Reply | Promise<Reply> => {
      const call = new Call(storesOf(ask.held.machine), ask.now_ms, ask.epoch ?? null, budget, missing, ask.reader ?? "person", step?.access, step?.sealed);
      const answered = (value: Answer): Reply => {
        if (step !== undefined) {
          if (GUARDED) call.guard(refsLeaving(value), servedRefOf(readSourcesOf(call, ask)));
          return { ...ok(JSON.stringify(value)), ...call.log };
        }
        if (GUARDED) shapes.answer.parse(value);
        const reply = ok(wellFormedJson(value));
        const etag = `"${digest(reply.body as string).slice("sha256:".length)}"`;
        if (ask.if_none_match === etag) return { status: 304, headers: { etag }, body: "", ...call.log };
        return { ...reply, headers: { ...reply.headers, etag }, ...call.log };
      };
      const failed = (error: unknown): Reply | Promise<Reply> => {
        if (!(error instanceof StoreDamaged) || missing.has(error.which)) throw error;
        call.damaged(error.which);
        missing.add(error.which);
        return attempt(params);
      };
      let value: ReturnType<typeof answer>;
      try {
        value = step !== undefined && !("ask" in step) ? stepped(path as ContractPath, params, call, ask, step) as Answer : answer(params, call, ask);
      } catch (error) {
        call.end();
        return failed(error);
      }
      if (value instanceof Promise) return value.then((each) => answered(each), failed).finally(() => call.end());
      try {
        return answered(value);
      } finally {
        call.end();
      }
    };
    try {
      const replied = attempt(step === undefined ? paramsOf(shapes.params, new URL(ask.url, "http://door").searchParams)
        : argsOf(shapes.params, "ask" in step ? step.ask : "candidates" in step ? step.candidates : step.counted));
      return replied instanceof Promise ? replied.catch(refusedAs) : replied;
    } catch (error) {
      return refusedAs(error);
    }
  };

  const json = (names: readonly string[], work: (query: Query, view: OpenView, ask: Ask) => Record<string, string>): ReplyRoute => (ask) => {
    const query = new Query(ask.url, names);
    return ok(viewed((view) => members({ position: JSON.stringify(view.position()), ...work(query, view, ask) })));
  };

  const days = json(["from", "to", "after", "limit"], (query, view) => {
    const from = query.day("from"), to = query.day("to");
    const after = query.after("after", (key) => typeof key === "string" && isDay(key) ? key : undefined);
    const limit = query.limit();
    if (view.tables.meta.get(DAYS_MARK) === undefined) notNow("busy", LISTING, RETRY_SOON_S);
    return paged("days", view.derived.days.page(from, to, after, limit + 1), limit, (entry) => entry.day);
  });

  const sources = json(["product", "family", "after", "limit"], (query, view) => {
    const product = query.text("product");
    const named = query.text("family");
    const family = named === undefined ? undefined : input.registry?.families.find((each) => each.name === named) ?? bad("family", "names no family this home reads");
    const after = query.after("after", (key) => typeof key === "string" ? key : undefined);
    const limit = query.limit();
    const rows = view.sources(product === undefined ? undefined : { product: [product] })
      .filter((row) => (after === undefined || row.id > after) && (family === undefined || readsSource(family, row)));
    const owner = ownerOf(input.registry);
    return paged("sources", rows, limit, (row) => row.id, (row) => ({ ...row, kinds: view.kinds(row.id), ...owner(row) ? { owner: true } : {} }));
  });

  const records = json(["source", "kind", "from_ms", "to_ms", "after", "limit", "text"], (query, view) => {
    const source = query.required("source"), kind = query.required("kind");
    const day = settings().day;
    const from_ms = query.time("from_ms", "start", day), to_ms = query.time("to_ms", "end", day);
    if (from_ms !== undefined && to_ms !== undefined && to_ms < from_ms) bad("to_ms", "is not before from_ms");
    const range = from_ms === undefined && to_ms === undefined ? undefined
      : { ...(from_ms === undefined ? {} : { start_ms: from_ms }), ...(to_ms === undefined ? {} : { end_ms: to_ms }) };
    const after = query.after("after", (key): HeadAfter | undefined => range === undefined
      ? (typeof key === "string" ? { key, start_ms: null } : undefined)
      : (isPair(key) ? { start_ms: key[0], key: key[1] } : undefined));
    const limit = query.limit();
    const text = wantsText(query);
    if (view.tables.sources.get(source) === undefined) refuse(404, "SOURCE_UNKNOWN", `no source ${source}`);
    return paged("records", view.records(source, kind, range, after), limit,
      ({ head }) => range === undefined ? head.key : [head.start_ms!, head.key],
      ({ head, version }) => ({
        source, kind, key: head.key, head: headOf(head, version), content: version.content,
        ...(text ? { text: textOf(view, { source, kind, key: head.key }, version) } : {}),
      }));
  });

  const counts = json(["source", "kind"], (query, view) => {
    const source = query.required("source");
    const kinds = [...new Set(query.all("kind"))];
    if (kinds.length === 0 || kinds.length > MAX_KINDS) bad("kind", `is named from 1 to ${MAX_KINDS} times`);
    if (view.tables.sources.get(source) === undefined) refuse(404, "SOURCE_UNKNOWN", `no source ${source}`);
    return { counts: JSON.stringify(Object.fromEntries(kinds.map((kind) => [kind, view.count(source, kind)]))) };
  });

  const record = json(["source", "kind", "key", "history", "text"], (query, view, ask) => {
    const ref = { source: query.required("source"), kind: query.required("kind"), key: query.required("key") };
    const history = query.text("history");
    if (history !== undefined && history !== "1") bad("history", "is 1 or absent");
    const text = wantsText(query);
    const head = view.head(ref) ?? refuse(404, "RECORD_UNKNOWN", `no record ${ref.source} ${ref.kind} ${ref.key}`);
    const version = head.version === GONE ? undefined : view.version(head.version);
    const transcribed = version === undefined ? undefined : transcribedOf(view, ref, version, ask.now_ms);
    return {
      source: JSON.stringify(ref.source), kind: JSON.stringify(ref.kind), key: JSON.stringify(ref.key), head: JSON.stringify(headOf(head, version)),
      version: JSON.stringify(version === undefined ? null : versionOf(version)),
      blobs: JSON.stringify(version === undefined ? [] : view.blobsOf(version.id)),
      open: JSON.stringify(openOfRecord(view, ref, version)),
      ...(text ? { text: JSON.stringify(version === undefined ? null : textOf(view, ref, version)) } : {}),
      ...(history === undefined ? {} : {
        history: JSON.stringify(view.history(ref).map(({ source: _source, kind: _kind, key: _key, ...statement }) => statement)),
      }),
      ...(transcribed === undefined ? {} : { transcribed: JSON.stringify(transcribed) }),
    };
  });

  const extracts = json(["family", "unit", "day", "from_ms", "to_ms", "after", "limit", "shown"], (query, view) => {
    const family = query.required("family");
    const days = settings().day;
    const unit = query.text("unit"), day = query.day("day"), from_ms = query.time("from_ms", "start", days), to_ms = query.time("to_ms", "end", days);
    if ((from_ms === undefined) !== (to_ms === undefined)) bad(from_ms === undefined ? "from_ms" : "to_ms", "comes with from_ms and to_ms both");
    if ([unit, day, from_ms].filter((value) => value !== undefined).length !== 1) bad("unit", "or day, or from_ms and to_ms: exactly one");
    const limit = query.limit();
    const shown = query.text("shown");
    if (shown !== undefined && shown !== "1") bad("shown", "is 1 or absent");
    const shape = shown === undefined ? extractOf : (row: ExtractRow & { items: string[] }) => ({ ...extractOf(row), ...shownOf(row, view) });
    if (unit !== undefined) {
      if (query.text("after") !== undefined) bad("after", "pages a day or a range, never one unit");
      const [row] = view.extractPage(family, { unit }, null, 1);
      if (row === undefined) refuse(404, "EXTRACT_UNKNOWN", `no ${family} extract ${unit}`);
      return { extracts: `[${JSON.stringify(shape(row))}]` };
    }
    const select: ExtractSelect = day !== undefined ? { day } : { start_ms: from_ms!, end_ms: to_ms! };
    const after = query.after("after", (key): ExtractAfter | undefined => day !== undefined
      ? (typeof key === "string" ? { unit: key, start_ms: null } : undefined)
      : (isPair(key) ? { start_ms: key[0], unit: key[1] } : undefined));
    function* rows() {
      for (let from = after ?? null, left = limit + 1; left > 0;) {
        const want = Math.min(EXTRACT_CHUNK, left);
        const chunk = view.extractPage(family, select, from, want);
        yield* chunk;
        if (chunk.length < want) return;
        left -= want;
        from = chunk.at(-1)!;
      }
    }
    return paged("extracts", rows(), limit, (row) => day !== undefined ? row.unit : [row.start_ms!, row.unit], shape);
  });

  const enrichments = json(["family", "prompt", "item"], (query, view) => {
    const family = query.required("family"), prompt = query.required("prompt");
    const items = query.all("item");
    if (items.length === 0 || items.length > MAX_ITEMS) bad("item", `is named from 1 to ${MAX_ITEMS} times`);
    const found = [...new Set(items)].flatMap((item) => {
      const row = view.enrichment(family, item, prompt);
      return row === undefined ? [] : [JSON.stringify({ family, item, prompt, state: row.state, content: row.content })];
    });
    return { enrichments: `[${found.join(",")}]` };
  });

  const labels = json(["id", "chat", "point"], (query, view) => {
    const [ids, chats, points] = (["id", "chat", "point"] as const).map((name) => {
      const values = [...new Set(query.all(name))];
      if (values.length > MAX_ITEMS) bad(name, `is named at most ${MAX_ITEMS} times`);
      return values;
    }) as [string[], string[], string[]];
    const located = points.map((point) => readPoint(point) ?? bad("point", "is <latitude>,<longitude> in decimal degrees, then ,<id> when the point states a place's provider id"));
    if (ids.length + chats.length + points.length === 0) {
      const table = servedTable(labelTable(view.extracts(LABELS_FAMILY)));
      return { version: JSON.stringify(digest(table)), labels: JSON.stringify(table) };
    }
    const read = labelsFrom((unit) => view.extract(LABELS_FAMILY, unit), settings().day);
    return {
      names: JSON.stringify(ids.map((id) => resolvedName(id, read, networks))),
      chats: JSON.stringify(chats.map((chat) => {
        const [key, title, group] = resolvedChat(chat, read, networks) ?? bad("chat", `is <network>:<chat id>, the network one of ${networks.products.join(", ")}`);
        return [key, title, group, openOfChat(key, group)];
      })),
      places: JSON.stringify(located.map((point) => resolvedPlace(point, read))),
    };
  });

  const chatAsked = (asked: string): { network: string; id: string } => {
    const colon = asked.indexOf(":");
    const network = asked.slice(0, colon);
    if (colon < 0 || networks.of(network) === undefined || colon === asked.length - 1) bad("chat", `is <network>:<chat id>, the network one of ${networks.products.join(", ")}`);
    return { network, id: asked.slice(colon + 1) };
  };
  const chatSaid = (view: OpenView, network: string, chat: string, keys: readonly string[], labels: Labels, day: string) => {
    const day_settings = settings().day;
    const window = dayBounds(day, day_settings);
    const extracts: ExtractRow[] = [];
    const utcDay = (ms: number) => civilDay(ms, { zone: "UTC", day_start_hour: 0 });
    for (let utc = utcDay(window.start_ms); utc <= utcDay(window.end_ms - 1); utc = addDays(utc, 1)) {
      for (const key of keys) {
        const row = view.extract(MESSAGES_FAMILY, messagesUnit({ day: utc, network, chat: key }));
        if (row !== undefined && row.days.includes(day)) extracts.push(row);
      }
    }
    if (extracts.length === 0) return { window, said: null };
    const enrichments = new Map<string, EnrichmentRow>();
    for (const extract of extracts) {
      for (const { item, prompt } of messagesFamily?.items?.(extract) ?? []) {
        const row = enrichments.has(item) ? undefined : view.enrichment(MESSAGES_FAMILY, item, prompt);
        if (row !== undefined) enrichments.set(item, row);
      }
    }
    const sources = new Map(view.sources().map((row) => [row.id, row]));
    return { window, said: conversationOn({ day, settings: day_settings, extracts, enrichments, labels, sources, device: (unit) => unit }, `${network}:${chat}`, networks) };
  };
  const chatDay = (view: OpenView, ask: Pick<Ask, "now_ms">, network: string, chat: string, keys: readonly string[], labels: Labels, day: string) => {
    const { window, said } = chatSaid(view, network, chat, keys, labels, day);
    if (said === null) return { window, title: null, atoms: [], messages: [] };
    return {
      window, title: said.title,
      atoms: dayAtoms(day, settings().day, MESSAGES_FAMILY, said.messages.map((message) => message.line)),
      messages: withLedger(folder, (ledger) => {
        const made = openMade(view, madeInputOf(ledger, ask.now_ms));
        return said.messages.map(({ fact }) => fact.parts?.some(isVoiceNote) === true
          ? { ...fact, parts: fact.parts.map((part) => isVoiceNote(part) ? { ...part, transcribed: made({ family: MESSAGES_FAMILY, item: part.blob }) } : part) }
          : fact);
      }),
    };
  };
  const chatKeys = (network: string, chat: string, labels: Labels): string[] =>
    [chat, ...(networks.of(network)?.shown === undefined ? [] : labels.provider?.(chat)?.aliases ?? [])]
      .filter((key, index, all) => all.indexOf(key) === index && resolveChat(networks, network, key, labels) === chat);

  const conversation = json(CONVERSATION_PARAMETERS, (query, view, ask) => {
    const day = query.day("day") ?? bad("day", "is required");
    const { network, id } = chatAsked(query.required("chat"));
    const day_settings = settings().day;
    const labels = labelsFrom((unit) => view.extract(LABELS_FAMILY, unit), day_settings);
    const chat = resolveChat(networks, network, id, labels);
    const read = chatDay(view, ask, network, chat, chatKeys(network, chat, labels), labels, day);
    return {
      chat: JSON.stringify(`${network}:${chat}`), day: JSON.stringify(day), window: JSON.stringify(read.window), title: JSON.stringify(read.title),
      atoms: JSON.stringify(read.atoms), messages: JSON.stringify(read.messages),
    };
  });
  const aiChatOf = (view: OpenView, record: { source: string; kind: string; key: string }): string | undefined => {
    const named = namedCopyOf(aiChats, record.source);
    const colon = record.key.indexOf(":");
    if (named === null || record.kind !== "msg" || colon <= 0) return undefined;
    const chat = `${named}/${record.key.slice(0, colon)}`;
    return isAiChat(view, chat) ? chat : undefined;
  };
  const isAiChat = (view: OpenView, chat: string): boolean => {
    if (!/^[^/]+\/[^/]+$/u.test(chat)) return false;
    for (const _ of view.extractReadings(AI_FAMILY, `${chat}/`)) return true;
    return false;
  };

  const chatResolved = (asked: string, labels: () => Labels): string => {
    const colon = asked.indexOf(":");
    const network = asked.slice(0, colon);
    if (colon < 0 || networks.of(network) === undefined || colon === asked.length - 1) bad("chat", `is <network>:<chat id>, the network one of ${networks.products.join(", ")}`);
    return `${network}:${resolveChat(networks, network, asked.slice(colon + 1), labels())}`;
  };

  const search = contractRoute(SEARCH_ROUTE, PAGE_ROWS, async (params, call, ask) => {
    const asked = searchAskedOf(params);
    if (asked.lists.includes("screen")) call.screenIfReady();
    const lends = lent(ask);
    const record = asked.lists.includes("record") || asked.lists.includes("goto") ? recordPartOf(asked, call, lends) : undefined;
    const started = performance.now();
    const screen = asked.lists.includes("screen") ? await screenAnswerOf(asked, call, {
      meaningModel: meaningModel(settings()), file: screenFileOf(files(ask.held.machine).search), ...(ask.held.meaning === undefined ? {} : { meaning: ask.held.meaning }),
      ...(lends === undefined ? {} : { lent: lends }), ...(record?.copies === undefined ? {} : { copies: record.copies }),
    }) : undefined;
    if (screen !== undefined) call.log.screen_ms = Math.round(performance.now() - started);
    return searchAnswerOf(asked, call, record?.answer, screen);
  });
  const countRoute = contractRoute(COUNT_ROUTE, Infinity, (params, call, ask) => {
    const asked = countAskedOf(params, collectionsOf(call.families));
    return countShown(countIn(call, asked, (read, counted, context) => countWithAlso(read, counted, context)), asked, lent(ask)?.pieces === true);
  });
  const stepped = (path: ContractPath, params: unknown, call: Call, ask: Ask, step: Exclude<Step, { ask: unknown }>): Stepped => {
    if (path === COUNT_ROUTE) {
      const asked = countAskedOf(params as Of<(typeof ROUTES)[typeof COUNT_ROUTE]["params"]>, collectionsOf(call.families));
      if ("candidates" in step) {
        return { candidates: countIn(call, asked, (read, counted, context) => readsOf(read, context).resolve(counted, { passages: true }) as Candidates) };
      }
      const answer = countIn(call, asked, (read, counted, context) => readsOf(read, context).count(counted, step.admission, step.snapshot) as ReturnType<typeof plainCount> | null);
      return answer === null ? { moved: true } : { answer: countShown(answer, asked, true) };
    }
    if (path !== READ_ROUTE) return refused("BAD_PARAMETER", `${path} is asked whole: it admits nothing apart`);
    const read = params as ReadParams;
    if ("candidates" in step) {
      const given = typeof read.ref === "string" ? read.ref : read.ref?.length === 1 ? read.ref[0]! : undefined;
      const row = given === undefined ? undefined : readRef(given, "ref");
      if (row?.kind !== "row") return refused("BAD_PARAMETER", "a row's candidates are read by its ref alone");
      return { candidates: rowResolved(call, countAskOf(row.parts.ask, collectionsOf(call.families)), row.parts.scope) };
    }
    try {
      return { answer: readAnswerOf(read, { ...readSourcesOf(call, ask), admitted: { admission: step.admission, snapshot: step.snapshot } }) };
    } catch (error) {
      if (error instanceof SnapshotMoved) return { moved: true };
      throw error;
    }
  };
  const imageOf = (call: Call, record: RecordRef): string | undefined => {
    const view = call.view();
    const head = view.head(record);
    if (head === undefined || head.version === GONE) return undefined;
    const naming = { day: call.clock(), networks, photos: photoRoutes };
    return photoOfRecord(view, head.version, (hex) => (photoNamed(view, hex, naming) === undefined ? undefined : `sha256:${hex}`));
  };
  const kindsShapes = { params: kindsParams, answer: either(kindsAnswer, kindsPage) };
  const kindsRoute = shapedRoute(KINDS_ROUTE, kindsShapes, PAGE_ROWS, (params, call) => kindsOf(params, call, { photo: (record) => imageOf(call, record) }));
  const readRoute = contractRoute(READ_ROUTE, READ_ROWS, (params, call, ask) => readAnswerOf(params, readSourcesOf(call, ask)));
  const describeRoute = contractRoute(DESCRIBE_ROUTE, READ_ROWS, (params, call, ask) => describedOf(params, readSourcesOf(call, ask)));
  function readSourcesOf(call: Call, ask: Ask): ReadSources {
    const families = input.registry?.families ?? [];
    let unshown: ReturnType<typeof unshownReader> | undefined;
    const screenOf = (screen: ScreenRead): ScreenSource => ({
      ...screenSource(screen, call.view(), families, blobs, settings().screen_cutover_ms), clock: screen.clock, file: screen.file,
      as_of: call.asOf(screen.seq, screen.clock.zone),
    });
    return {
      call,
      chatDay: (network, chat, keys, on) => chatDay(call.view(), ask, network, chat, keys, call.labels(), on) as ReturnType<ReadSources["chatDay"]>,
      chatKeys: (network, chat) => chatKeys(network, chat, call.labels()),
      aiChatOf: (record) => aiChatOf(call.view(), record),
      isAiChat: (chat) => isAiChat(call.view(), chat),
      productName: (product) => productName(input.registry?.connectors ?? [], product),
      isProduct: (product) => productsOf(input.registry?.connectors ?? []).products[product] !== undefined,
      recordOf: (record, versionId) => {
        const view = call.view();
        const row = view.source(record.source);
        const text = row === undefined ? undefined : textFamilyOf(families, row, record.kind);
        const named = row === undefined ? undefined
          : (text ?? families.find((family) => family.inputs.some((each) => each.kinds.includes(record.kind) && selects(each.sources, row))))?.name;
        const version = versionId ?? view.head(record)?.version;
        const stated = version === undefined || version === GONE || input.registry === undefined ? undefined : view.version(version);
        let read: FamilyRecordRead | null = null;
        try {
          read = stated === undefined ? null : text?.read?.of(record, stated, blobs, view) ?? null;
        } catch {
          read = null;
        }
        return { family: named, read, product: row?.product, dated: isDated(stated?.time) };
      },
      name: (id) => resolvedName(id, call.labels(), networks)[1] ?? id,
      ...(lent(ask)?.pieces === true ? { pieces: true } : {}),
      photo: (hex) => {
        const people: PreparedFile = (read) => {
          const file = call.peopleFileIfReady();
          return file === undefined ? undefined : read(file);
        };
        const places: PreparedFile = (read) => {
          const file = call.placesIfReady();
          return file === undefined ? undefined : read(file);
        };
        return withLedger(folder, (ledger) => readPhoto(call.view(), hex, { unit: settings().unit, day: call.clock(), now_ms: ask.now_ms, people, places, made: madeInputOf(ledger, ask.now_ms), networks, photos: photoRoutes }));
      },
      unheld: (of) => {
        unshown ??= unshownReader(call.view(), photoRoutes);
        const photo = unshown(of);
        return photo === null ? null : unheldWords(call.view(), ask.held.stated, photo);
      },
      held: (blob) => served(call.view(), blobs, blob),
      dayDocument: (on) => {
        const kept = dayFile(folder, on, "json").read();
        return kept === undefined ? undefined : JSON.parse(kept.toString("utf8")) as DayDocument;
      },
      freshness: () => raw((db) => db.transaction(() => freshSourcesOf(db, {
        connectors: input.registry?.connectors ?? [], families: input.registry?.families ?? [], off: settings().sources.off, now_ms: call.now_ms,
      }))()),
      screen: () => screenOf(call.screen()),
      screenIfReady: () => {
        const screen = call.screenIfReady();
        return screen === "busy" ? screen : screen === "none" ? undefined : screenOf(screen);
      },
    };
  }
  const wheres = new Map<string, Presence>();
  const presenceOf = (machine: string): PresenceSource => {
    const file = files(machine).places;
    return {
      file,
      held: (version, load) => {
        const held = wheres.get(machine);
        if (held?.version === version) return held;
        const made = presenceOver(load());
        wheres.set(machine, made);
        return made;
      },
      damaged: () => {
        discardPrepared(file);
        runAgain(machine, "places");
      },
    };
  };

  const suggestRoute: ReplyRoute = (ask) => {
    const query = new Query(ask.url, ["spot", "latitude", "longitude", "from_ms", "to_ms", "q", "limit"]);
    const spot = query.text("spot");
    const q = query.text("q");
    if (q !== undefined && q.trim().length > googlePlaces.TYPED_MAX) bad("q", `is at most ${googlePlaces.TYPED_MAX} characters`);
    const limit = suggestLimit(query);
    const { day } = settings();
    let asked: { latitude: number; longitude: number; spans: { start_ms: number; end_ms: number }[]; photos: boolean };
    if (spot !== undefined) {
      for (const name of ["latitude", "longitude", "from_ms", "to_ms"]) if (query.text(name) !== undefined) bad(name, "is not named with spot");
      const row = placesRead(ask, (file) => file.value<SpotSpans>("spans", spot)) ?? refuse(404, "SPOT_UNKNOWN", `no spot ${spot}: read the places list again`);
      asked = { latitude: row.latitude, longitude: row.longitude, spans: row.spans.map(({ start_ms, end_ms }) => ({ start_ms, end_ms })), photos: row.photos };
    } else {
      const latitude = degrees(query, "latitude", 90), longitude = degrees(query, "longitude", 180);
      const from_ms = query.time("from_ms", "start", day) ?? bad("from_ms", "is required"), to_ms = query.time("to_ms", "end", day) ?? bad("to_ms", "is required");
      if (to_ms < from_ms) bad("to_ms", "is before from_ms");
      asked = { latitude, longitude, spans: [{ start_ms: from_ms, end_ms: to_ms }], photos: false };
    }
    const point = { latitude: asked.latitude, longitude: asked.longitude };
    const typed: googlePlaces.TypedAnswer = q === undefined ? { google: "answered", places: [] } : ask.held.typed ?? { google: "unreachable" };
    return ok(viewed((view) => {
      const table = placeTable(view, settings().unit);
      const windows = asked.spans.map((span) => ({ start_ms: span.start_ms - BEFORE_MS, end_ms: span.end_ms + 1 }));
      const maps = new Map<string, Said>();
      for (const row of view.sources({ product: ["google-maps"] }).filter((each) => each.copy !== "lookup")) {
        for (const kind of MAPS_KINDS) {
          for (const window of windows) {
            for (const { head, version } of view.records(row.id, kind, window)) {
              const content = version.content as { title?: unknown; titleUrl?: unknown };
              maps.set(`${row.id}\0${kind}\0${head.key}`, {
                at_ms: head.start_ms ?? 0, product: "google-maps", family: MAPS_FAMILY, kind, text: typeof content.title === "string" ? content.title : "",
                ...(typeof content.titleUrl === "string" ? { url: content.titleUrl } : {}),
              });
            }
          }
        }
      }
      const suggested = (read: RecordRead | undefined) => {
        const words = suggestWords(view, point, table, read);
        const candidates = candidatesOf(point, storedAnswers(view, point), table.places, table.google, [...maps.values()], words, {
          photos: asked.photos, ...(q === undefined ? {} : { q }), typed: typed.google === "answered" ? typed.places : [],
        });
        const phrases = phrasesOf(candidates, words);
        const mentioned = new Map<string, Said>();
        if (read !== undefined) {
          for (const window of windows) {
            for (const found of read.mentions(phrases, { from_ms: window.start_ms, to_ms: window.end_ms }, leftOut(input.registry?.connectors ?? []))) {
              mentioned.set(`${found.record.source}\0${found.record.kind}\0${found.record.key}`, {
                at_ms: found.start_ms, product: found.product, family: found.family, kind: found.record.kind, text: [found.title, found.text].filter((part) => part !== "").join("\n"),
              });
            }
          }
        }
        const suggestions = suggest(asked.spans, candidates, [...maps.values(), ...mentioned.values()], words, day.zone, limit).map((each) =>
          each.why === undefined ? each : { ...each, why: { ...each.why, product: productName(input.registry?.connectors ?? [], each.why.product) } });
        return members({ position: JSON.stringify(view.position()), suggestions: JSON.stringify(suggestions),
          ...(q === undefined ? {} : { provider: JSON.stringify(typedProvider(input.registry?.connectors ?? [], typed)) }) });
      };
      const answer = recordRead(folder, files(ask.held.machine).search, {}, suggested, input.readWaitMs);
      return answer === "none" ? suggested(undefined) : indexAnswer(answer, "search");
    }));
  };

  const prepared = <T>(machine: string, file: string, shape: PreparedShape, job: "people" | "places", busy: string, read: (file: PreparedRead) => T, missing: () => T): T => {
    let found: { value: T } | undefined;
    try {
      found = readPrepared(folder, file, shape.format, read);
    } catch (error) {
      if (isSqliteError(error) && error.code === "SQLITE_BUSY") notNow("busy", busy, PREPARING_S);
      if (!damaged(error)) throw error;
      discardPrepared(file);
      runAgain(machine, job);
      return missing();
    }
    return found === undefined ? missing() : found.value;
  };
  const peopleBusy = "Your people are being written.";
  const placesBusy = "Your places are being written.";
  const peopleRead = <T>(ask: Pick<PreparedAsk, "held">, read: (file: PreparedRead) => T): T =>
    prepared(ask.held.machine, files(ask.held.machine).people, PEOPLE, "people", peopleBusy, read, () => notNow("busy", "Your people are being prepared.", PREPARING_S));
  const placesRead = <T>(ask: Pick<PreparedAsk, "held">, read: (file: PreparedRead) => T, missing: () => T = () => notNow("busy", "Your places are being prepared.", PREPARING_S)): T =>
    prepared(ask.held.machine, files(ask.held.machine).places, PLACES, "places", placesBusy, read, missing);
  const joinedPlaces = <T>(ask: PreparedAsk, read: (joined: ReturnType<typeof placesJoined>, file: PreparedRead | null) => T): { position: string; value: T } => viewed((view) => {
    const { unit, day } = settings();
    const join = (file: PreparedRead | null) => read(placesJoined(view, unit, file, { now_ms: ask.now_ms, day }), file);
    return { position: view.position(), value: placesRead(ask, join, () => join(null)) };
  });
  const rowReply = (ask: PreparedAsk, file: PreparedRead, table: string, key: string, position: string): Reply | undefined => {
    const etag = file.etag(table, key);
    if (etag === undefined) return undefined;
    if (ask.if_none_match === etag) return { status: 304, headers: { etag, [POSITION_HEADER]: position }, body: "" };
    const { body, headers } = file.answer(table, key, ask.gzip === true, position)!;
    return { status: 200, headers: { ...JSON_HEADERS, etag, vary: "accept-encoding", [POSITION_HEADER]: position, ...headers }, body };
  };
  const madeReply = (ask: PreparedAsk, position: string, answer: Record<string, unknown>, tag?: string): Reply => {
    const text = JSON.stringify(answer);
    const etag = tag ?? `"${sha256(text).slice("sha256:".length)}"`;
    if (ask.if_none_match === etag) return { status: 304, headers: { etag, [POSITION_HEADER]: position }, body: "" };
    const body = `${text.slice(0, -1)},"position":${JSON.stringify(position)}}`;
    return { status: 200, headers: { ...JSON_HEADERS, etag, vary: "accept-encoding", [POSITION_HEADER]: position, ...(ask.gzip === true ? { "content-encoding": "gzip" } : {}) }, body: ask.gzip === true ? gzipSync(body) : body };
  };
  const counted = (reply: Reply, counting: boolean): Reply => counting ? { ...reply, counting: true } : reply;
  const people = (ask: PreparedAsk): Reply => {
    const query = new Query(ask.url, ["id", "q", "settled"]);
    const id = query.text("id"), q = query.text("q");
    if (id !== undefined && q !== undefined) bad("q", "is not named with id");
    if (q !== undefined && q.trim() === "") bad("q", "names no word to find");
    const families = input.registry?.families ?? [];
    return viewed((view) => peopleRead(ask, (file) => {
      const joined = peopleJoined(view, file, families);
      if (id !== undefined) {
        const found = joined.person(id) ?? refuse(404, "PERSON_UNKNOWN", `no person ${id}`);
        return "row" in found ? rowReply(ask, file, "person", found.row, view.position())! : counted(madeReply(ask, view.position(), { person: found.person }), found.person.counting === true);
      }
      if (q === undefined) {
        if (joined.same) return rowReply(ask, file, "answer", "list", view.position())!;
        const list = joined.list();
        return counted(madeReply(ask, view.position(), { ...list }), [list.you, ...list.people].some((entry) => entry !== null && "counting" in entry));
      }
      const found = findPeople(file.value<{ people: Searched[] }>("names", "all")?.people ?? [], q).flatMap((each) => {
        const shown = joined.detail(each);
        return shown === undefined ? [] : [listEntry(shown)];
      });
      const people = [...new Map(found.map((entry) => [entry.id, entry])).values()];
      return counted(madeReply(ask, view.position(), { people, profiles: profilesOf(q) }), people.some((entry) => entry.counting === true));
    }));
  };
  const peopleRow: PreparedRoute = (ask) => {
    const params = new URL(ask.url, "http://door").searchParams;
    return params.has("q") ? undefined : people(ask);
  };
  const peopleSearch = contractRoute(PEOPLE_SEARCH_ROUTE, Infinity, (params, call, ask) => peopleSearchAnswer(call, params, lent(ask)?.pieces === true));
  const peoplePhotos: ReplyRoute = (ask) => {
    const query = new Query(ask.url, ["id", "after", "at", "limit", "settled"]);
    const id = query.required("id");
    const after = query.after("after", (key) => Array.isArray(key) && key.length === 2 && (key[0] === null || Number.isSafeInteger(key[0])) && typeof key[1] === "string"
      ? { at_ms: key[0] as number | null, face: key[1] } : undefined);
    const { at, limit } = query.photoPage(after !== undefined);
    const families = input.registry?.families ?? [];
    return viewed((view) => peopleRead(ask, (file) => {
      const joined = peopleJoined(view, file, families);
      const person = joined.stands(id);
      if (person === undefined) refuse(404, "PERSON_UNKNOWN", `no person ${id}`);
      const found = (person === null ? undefined : file.value<{ photos: ServedPhoto[] }>("photos", person)) ?? { photos: [] };
      const later = (photo: { at_ms: number | null; face: string }) => after === undefined ? true
        : (photo.at_ms ?? -Infinity) < (after.at_ms ?? -Infinity) || ((photo.at_ms ?? -Infinity) === (after.at_ms ?? -Infinity) && photo.face > after.face);
      const rest = after === undefined ? found.photos.slice(at) : found.photos.filter(later);
      const page = rest.slice(0, limit);
      const last = page.at(-1);
      return counted(madeReply(ask, view.position(), {
        photos: page, total: found.photos.length,
        ...(rest.length > limit && last !== undefined ? { next: Buffer.from(JSON.stringify([last.at_ms, last.face])).toString("base64url") } : {}),
      }), !joined.same && joined.detail(id)?.counting === true);
    }));
  };
  const cardOf = (ask: Pick<PreparedAsk, "held">, hash: string) =>
    peopleRead(ask, (file) => file.db.prepare("SELECT type, bytes FROM card WHERE key = ?").get(hash) as Card | undefined);
  const peopleCard: PreparedRoute = (ask) => {
    const hash = new Query(ask.url, ["hash"]).required("hash");
    if (!BLOB.test(hash)) bad("hash", "is sha256: and 64 lowercase hex digits");
    const found = cardOf(ask, hash) ?? refuse(404, "CARD_UNKNOWN", `no card photo ${hash}`);
    const etag = `"${hash}"`;
    if (ask.if_none_match === etag) return { status: 304, headers: { etag, "cache-control": PERSONAL_CACHE }, body: "" };
    return { status: 200, headers: { "content-type": found.type, "cache-control": PERSONAL_CACHE, etag }, body: found.bytes };
  };
  const places: PreparedRoute = (ask) => {
    const slug = new Query(ask.url, ["slug", "settled"]).text("slug");
    const { position, value } = joinedPlaces(ask, (joined) => {
      if (slug !== undefined) {
        const place = joined.place(slug) ?? refuse(404, "PLACE_UNKNOWN", `no place ${slug}`);
        return { answer: { place }, counting: place.counting === true };
      }
      const list = joined.list();
      return { answer: list, counting: "counting" in list || [...list.places, ...list.hidden].some((entry) => "counting" in entry) };
    });
    return counted(madeReply(ask, position, value.answer), value.counting);
  };
  const placePhotos: PreparedRoute = (ask) => {
    const query = new Query(ask.url, ["slug", "after", "at", "limit", "settled"]);
    const slug = query.required("slug");
    const after = query.after("after", (key) => isPair(key) ? { at_ms: key[0], image: key[1] } : undefined);
    const { at, limit } = query.photoPage(after !== undefined);
    const first = after === undefined && at === 0 && limit === PHOTOS_PAGE;
    const none = (): Reply => {
      const { position, value: place } = joinedPlaces(ask, (joined) => joined.place(slug) ?? refuse(404, "PLACE_UNKNOWN", `no place ${slug}`));
      return counted(madeReply(ask, position, { photos: [], total: 0, ...(place.counting === true ? { counting: true } : {}) }), place.counting === true);
    };
    const served = placesRead(ask, (file) => {
      const listed = file.db.prepare("SELECT etag FROM photo_list WHERE slug = ?").pluck().get(slug) as string | undefined;
      if (listed === undefined) return undefined;
      if (first && ask.if_none_match === listed) return { status: 304, headers: { etag: listed, [POSITION_HEADER]: file.position }, body: "" };
      const rows = (after === undefined
        ? file.db.prepare("SELECT image, at_ms FROM photo WHERE slug = ? ORDER BY at_ms DESC, image LIMIT ? OFFSET ?").all(slug, limit + 1, at)
        : file.db.prepare("SELECT image, at_ms FROM photo WHERE slug = ? AND (at_ms < ? OR (at_ms = ? AND image > ?)) ORDER BY at_ms DESC, image LIMIT ?")
          .all(slug, after.at_ms, after.at_ms, after.image, limit + 1)) as { image: string; at_ms: number }[];
      const total = file.db.prepare("SELECT count(*) FROM photo WHERE slug = ?").pluck().get(slug) as number;
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return madeReply(ask, file.position, { photos: page, total, ...(rows.length > limit && last !== undefined ? { next: Buffer.from(JSON.stringify([last.at_ms, last.image])).toString("base64url") } : {}) },
        first ? listed : undefined);
    }, () => undefined);
    if (served === undefined) return none();
    return query.text("settled") === undefined ? served : counted(served, joinedPlaces(ask, (joined) => joined.place(slug)?.counting === true).value);
  };
  const year: PreparedRoute = (ask) => {
    const params = new URL(ask.url, "http://door").searchParams;
    const named = [...params.keys()];
    const from = params.get("from") ?? "", to = params.get("to");
    const asked = /^(\d{4})-01-01$/u.exec(from)?.[1];
    if (named.length !== 3 || new Set(named).size !== 3 || params.get("grain") !== "year" || asked === undefined || to !== `${asked}-12-31`) return undefined;
    return placesRead(ask, (file) => rowReply(ask, file, "year", asked, file.position), () => undefined);
  };

  const devices = json([], (_query, view, ask) => {
    const { unit, day } = settings();
    const cameras = readCameras(view, unit).map(({ camera, label, counted }) => {
      const count = counted as unknown as cameras.Camera | undefined;
      const { name, mine, why, rule } = cameraNamed(view, camera, label, count, ask.now_ms, day);
      return {
        camera, name, make: count?.make ?? null, model: count?.model ?? null, photos: count?.photos ?? 0, first_ms: count?.first_ms ?? null, last_ms: count?.last_ms ?? null,
        sample: count?.sample ?? null, phones: count?.phones ?? [], word: label.word ?? null, mine, why, rule,
      };
    });
    return { cameras: JSON.stringify(cameras) };
  });

  const photo: PreparedRoute = (ask) => {
    new Query(ask.url, []);
    let hash: string;
    try {
      hash = decodeURIComponent(new URL(ask.url, "http://door").pathname.slice(PHOTO_ROUTE.length));
    } catch {
      hash = "";
    }
    if (!BLOB.test(hash)) bad("hash", "is sha256: and 64 lowercase hex digits");
    const { unit, day } = settings();
    const { people, places } = files(ask.held.machine);
    const { position, found } = withLedger(folder, (ledger) => viewed((view) => ({
      position: view.position(),
      found: readPhoto(view, hash.slice("sha256:".length), {
        unit, day, now_ms: ask.now_ms, people: preparedFile(folder, people, "people"), places: preparedFile(folder, places, "places"), made: madeInputOf(ledger, ask.now_ms), networks, photos: photoRoutes,
      })?.photo,
    })));
    return madeReply(ask, position, { photo: found ?? refuse(404, "PHOTO_UNKNOWN", `no photo ${hash}`) });
  };

  const photosWanted = json(["source", "files"], (query, view, ask) => {
    const held = ask.held.photos ?? refuse(403, "PRINCIPAL_SCOPE", "only a pass that delivers a photos library asks for wanted photos");
    if (query.text("files") !== "1") bad("files", "is 1");
    const answer = wanted(view, photoRoutes, held.source, new Set(held.asking), held.start_ms);
    const may = historyGate(view.tables, ask.held.stated, held.room).may(held.connector, held.reach);
    return { photos: JSON.stringify(may ? answer.photos : []), left: JSON.stringify(answer.left), ...(may ? {} : { paused: "true" }) };
  });

  const spotsOf = (machine: string) => (pieces: readonly Piece[]): (string | null)[] => {
    const none = pieces.map(() => null);
    const file = files(machine).places;
    try {
      return readPrepared(folder, file, PLACES.format, (read) => {
        const find = read.db.prepare("SELECT key FROM spotted WHERE unit = ? AND latitude = ? AND longitude = ? AND start_ms < ? AND end_ms >= ? ORDER BY start_ms LIMIT 1").pluck();
        return pieces.map((piece) => piece.kind !== "stay" || piece.level !== "place" || piece.point === null ? null
          : (find.get(piece.units[0], piece.point.latitude, piece.point.longitude, piece.end_ms, piece.start_ms) as string | undefined) ?? null);
      })?.value ?? none;
    } catch (error) {
      if (isSqliteError(error) && error.code === "SQLITE_BUSY") return none;
      if (!damaged(error)) throw error;
      discardPrepared(file);
      runAgain(machine, "places");
      return none;
    }
  };

  const whereRoute: ReplyRoute = (ask) => {
    const query = new Query(ask.url, ["at", "from", "to", "grain"]);
    const day = settings().day;
    const at = query.text("at");
    const grain = oneOf(query, "grain", GRAINS);
    const now = ask.now_ms;
    let span: { start_ms: number; end_ms: number };
    if (at !== undefined) {
      for (const name of ["from", "to", "grain"]) if (query.text(name) !== undefined) bad(name, "is not named with at");
      const ms = query.time("at", "moment", day)!;
      if (ms >= now) bad("at", "is in the past");
      span = { start_ms: ms, end_ms: ms + 1 };
    } else {
      const start_ms = query.time("from", "start", day) ?? bad("from", "and to are both named, or at");
      const end_ms = query.time("to", "end", day) ?? bad("to", "and from are both named, or at");
      if (end_ms <= start_ms) bad("to", "is after from");
      if (start_ms >= now) bad("from", "is in the past");
      span = { start_ms, end_ms: Math.min(end_ms, now) };
    }
    const [first, last] = [civilDay(span.start_ms, day), civilDay(span.end_ms - 1, day)];
    if (addDays(first, WHERE_DAYS - 1) < last) bad("to", `is at most ${WHERE_DAYS} civil days after from: ask a longer range a year at a time`);
    const { position, answer } = viewed((view) => {
      const { evidence, labels } = whereReading(view, first, last, day);
      let answer: Record<string, unknown>;
      if (at !== undefined) {
        const reach = { start_ms: dayBounds(addDays(first, -REACH_DAYS), day).start_ms, end_ms: Math.min(dayBounds(addDays(last, REACH_DAYS), day).end_ms, now) };
        const pieces = where(evidence, reach, labels, 0, day);
        const index = pieces.findIndex((piece) => piece.start_ms <= span.start_ms && span.start_ms < piece.end_ms);
        const piece = pieces[index]!;
        const evidenceAt = (step: -1 | 1) => {
          for (let each = index + step; each >= 0 && each < pieces.length; each += step) if (pieces[each]!.kind !== "gap") return pieces[each]!;
          return null;
        };
        const [before, after] = piece.kind === "gap" ? [evidenceAt(-1), evidenceAt(1)] : [null, null];
        const [named, beforeNamed, afterNamed] = withNames([piece, before, after], labels, spotsOf(ask.held.machine));
        answer = { at_ms: span.start_ms, piece: named, ...(piece.kind === "gap" ? { before: beforeNamed, after: afterNamed } : {}) };
      } else {
        const pieces = where(evidence, span, labels, REACH_DAYS, day);
        answer = { from_ms: span.start_ms, to_ms: span.end_ms, ...(grain === undefined
          ? { pieces: withNames(pieces, labels, spotsOf(ask.held.machine)) }
          : { grain, summaries: summarise(pieces, span, grain, day, labels) }) };
      }
      return { position: view.position(), answer };
    });
    const etag = `"${digest({ asked: ask.url, answer: answer as Json })}"`;
    if (ask.if_none_match === etag) return { status: 304, headers: { etag }, body: "" };
    return { status: 200, headers: { ...JSON_HEADERS, etag }, body: JSON.stringify({ position, ...answer }) };
  };

  const madeInputOf = (ledger: Ledger | null, now_ms: number): MadeInput => {
    const now = settings();
    return { connectors: input.registry?.connectors ?? [], blocks: now.connectors, defaults: now.defaults, runners: now.runners, day: now.day, now_ms, reply: (key) => ledger?.reply(key) };
  };

  const reported = <T>(read: (db: Database.Database, ledger: Ledger | null) => T): { position: string; report: T } =>
    raw((db) => withLedger(folder, (ledger) => db.transaction(() => {
      const at = newest(db);
      return { position: `${at.seq}:${at.at_ms}`, report: read(db, ledger) };
    })()));

  const status: ReplyRoute = (ask) => {
    new Query(ask.url, []);
    const { position, report } = reported((db, ledger) => readStatus(db, { folder, now_ms: ask.now_ms, settings: settings(), connectors: input.registry?.connectors ?? [], families: input.registry?.families ?? [], ledger, door: null, stated: ask.held.stated, refused: ask.held.refused }));
    return ok(members({ position: JSON.stringify(position), ...Object.fromEntries(Object.entries(report).map(([name, value]) => [name, JSON.stringify(value)])) }));
  };

  const productsRoute: ReplyRoute = (ask) => {
    new Query(ask.url, []);
    const registry = input.registry ?? refuse(503, "CONNECTORS_UNAVAILABLE", "this door reads no registry, so it holds no connector's declaration");
    return ok(JSON.stringify(productsOf(registry.connectors)));
  };

  const streamsRead: StreamsReads = {
    read(ask, unit) {
      if (unit !== null && !UNIT.test(unit)) bad("unit", "is a device's unit");
      const { machine, sites, present, refused, stated, asked } = ask.held;
      const registry = input.registry ?? refuse(503, "CONNECTORS_UNAVAILABLE", "this door reads no registry, so it holds no connector's declaration");
      const { position, report } = reported((db, ledger) => ({
        report: readStreams(db, { folder, now_ms: ask.now_ms, settings: settings(), registry, ledger, machine, sites, present, refused, stated, ...(asked === undefined ? {} : { asked }), ...(unit === null ? {} : { unit }), ...(input.space === undefined ? {} : { space: input.space }) }),
        asks: ledger === null ? 0 : openAsks(ledger, folder, ask.now_ms),
      }));
      return { position, ...report };
    },
  };

  const modelsHeld: ModelsReads = {
    read(ask) {
      const now = settings();
      const { position, stored, paused } = raw((db) => db.transaction(() => {
        const at = newest(db);
        return { position: `${at.seq}:${at.at_ms}`, stored: storedModels(readTables(db).meta), paused: pauses(db) };
      })());
      return { position, inputs: { stored, settings: now, pauses: paused, now_ms: ask.now_ms, day: now.day } };
    },
  };

  const modelsRoute: ReplyRoute = (ask) => {
    const chat = new Query(ask.url, ["chat"]).text("chat");
    const { position, inputs } = modelsHeld.read(ask);
    const { settings: now } = inputs;
    return ok(JSON.stringify({ position, ...modelsRead(inputs.stored, { ...modelsAt(now), ...chat === undefined ? {} : { chat } }) }));
  };

  const storageReads: StorageReads = {
    read(ask) {
      const registry = input.registry ?? refuse(503, "CONNECTORS_UNAVAILABLE", "this door reads no registry, so it holds no connector's declaration");
      const { position, read } = raw((db) => db.transaction(() => {
        const at = newest(db);
        return { position: `${at.seq}:${at.at_ms}`, read: readStorage(db, { root, now_ms: ask.now_ms, settings: settings(), connectors: registry.connectors }) };
      })());
      return { position, read, connectors: registry.connectors };
    },
  };

  const storage: ReplyRoute = (ask) => {
    new Query(ask.url, []);
    const { position, read } = storageReads.read(ask);
    return ok(JSON.stringify({ position, ...read }));
  };

  const startCost: ReplyRoute = (ask) => {
    new Query(ask.url, []);
    const registry = input.registry ?? refuse(503, "CONNECTORS_UNAVAILABLE", "this door reads no registry, so it holds no connector's declaration");
    const { position, view } = raw((db) => db.transaction(() => {
      const at = newest(db);
      return { position: `${at.seq}:${at.at_ms}`, view: costView(db, folder, ask.held.stated) };
    })());
    return ok(JSON.stringify({ position, ...priceStops(view, settings(), registry, ask.now_ms) }));
  };

  const processingRange: ReplyRoute = (ask) => {
    const query = new Query(ask.url, ["connector", "value"]);
    const id = query.required("connector");
    const value = query.day("value") ?? bad("value", "is a civil day, YYYY-MM-DD");
    const registry = input.registry ?? refuse(503, "CONNECTORS_UNAVAILABLE", "this door reads no registry, so it holds no connector's declaration");
    const connector = registry.connectors.find((each) => each.id === id) ?? refuse(404, "CONNECTOR_UNKNOWN", `no connector ${id}`);
    if (Object.keys(connector.processing ?? {}).length === 0) refuse(404, "NO_PROCESSING", `${id} declares no LLM processing`);
    const now = settings();
    const { position, report } = reported((db, ledger) => readProcessing(readTables(db), ledger?.rates(ask.now_ms) ?? null, {
      connectors: [connector], families: registry.families, blocks: now.connectors, defaults: now.defaults, runners: now.runners, day: now.day, now_ms: ask.now_ms, typed: value,
      histories: readHistories(db, { folder, now_ms: ask.now_ms, settings: now, connectors: registry.connectors, families: registry.families, ledger: null, stated: ask.held.stated, refused: ask.held.refused }),
      privacy: now.privacy,
    }).get(id)!.typed);
    return ok(JSON.stringify({ position, value, note: report }));
  };

  const dayRoute = (day: string): ReadRoute => async (request, response) => {
    const query = new Query(request.url ?? "/", ["file"]);
    const file = query.text("file") ?? "json";
    if (!Object.hasOwn(DAY_FILES, file)) bad("file", "is json, txt or lines");
    if (!isDay(day)) bad("day", "is a civil day, YYYY-MM-DD");
    const head = readDayHead(folder, day) ?? refuse(404, "DAY_UNKNOWN", `no files for ${day}`);
    const etag = `"${head.inputs}"`;
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, { etag });
      response.end();
      return;
    }
    await streams!.open.send({ day }, async (signal) => {
      const opened = await dayFile(folder, day, file as keyof typeof DAY_FILES).open() ?? refuse(404, "DAY_UNKNOWN", `no files for ${day}`);
      try {
        response.writeHead(200, { "content-type": DAY_TYPES[file as keyof typeof DAY_FILES], "content-length": String(opened.size), etag, "cache-control": "no-cache" });
        await pipeline(opened.reading(), response, { signal });
      } finally {
        await opened.close();
      }
    });
  };

  const blob = (hash: string): ReadRoute => async (request, response, held) => {
    new Query(request.url ?? "/", []);
    if (!BLOB.test(hash)) bad("blob", "is sha256: and 64 lowercase hex digits");
    const staged = await streams!.serves(hash) ? undefined : held.stage?.staged(hash) ?? refuse(404, "BLOB_UNKNOWN", `no blob ${hash}`);
    const etag = `"${hash}"`;
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, { etag });
      response.end();
      return;
    }
    const size = staged === undefined ? blobs.size(hash) : staged.size;
    const range = byteRange(request.headers.range, size);
    const headers = { "content-type": "application/octet-stream", "accept-ranges": "bytes", etag };
    if (range === "unsatisfiable") {
      response.writeHead(416, { ...headers, "content-range": `bytes */${size}` });
      response.end();
      return;
    }
    await streams!.open.send({ blob: hash }, async (signal) => {
      if (range === null) response.writeHead(200, { ...headers, ...(size === undefined ? {} : { "content-length": String(size) }) });
      else response.writeHead(206, { ...headers, "content-length": String(range.end - range.start), "content-range": `bytes ${range.start}-${range.end - 1}/${size}` });
      await pipeline(staged === undefined ? blobs.stream(hash, range ?? undefined) : staged.stream(range ?? undefined), response, { signal });
    });
  };

  const picture = (hash: string): ReadRoute => async (request, response, held) => {
    const leaving = new AbortController();
    response.once("close", () => leaving.abort());
    const query = new Query(request.url ?? "/", ["size", "recipe"]);
    const size = query.text("size");
    if (size === undefined || !Object.hasOwn(SIZES, size)) bad("size", "is tile, screen or full");
    const recipe = query.text("recipe");
    if (recipe !== undefined && !/^\d{1,9}$/u.test(recipe)) bad("recipe", "is a whole number");
    if (!BLOB.test(hash)) bad("picture", "is sha256: and 64 lowercase hex digits");
    const holder = async () => {
      if (await streams!.serves(hash)) return undefined;
      const staged = held.stage?.staged(hash);
      if (staged !== undefined) return { staged };
      const card = await streams!.card(held.machine, hash);
      return card === undefined ? refuse(404, "BLOB_UNKNOWN", `no blob ${hash}`) : { card: Buffer.from(card.bytes) };
    };
    const { pictures } = files(held.machine);
    const first = await holder();
    const original = first === undefined ? fromBlob(blobs, hash)
      : "staged" in first ? fromBlob(stagedOrStored(blobs, held.stage!), hash)
        : fromBytes(first.card, pictures.cache, async () => await streams!.card(held.machine, hash) !== undefined);
    if (original.type === null) refuse(404, "NOT_A_PICTURE", `${hash} is no picture`);
    const etag = `"${hash.slice("sha256:".length)}-${size}-${RECIPE}"`;
    const headers = recipe === String(RECIPE) ? { etag, "cache-control": PERSONAL_CACHE } : { "cache-control": "no-store" };
    if (recipe === String(RECIPE) && request.headers["if-none-match"] === etag) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
    let made;
    try {
      made = await pictures.picture(hash, size as PictureSize, original, leaving.signal);
    } catch {
      if (leaving.signal.aborted) return;
      await holder();
      notNow("busy", "Lifestream could not make this picture just now: it tries again at the next ask.", RETRY_SOON_S);
    }
    const now = await holder();
    const served = made ?? refuse(404, "NOT_A_PICTURE", `${hash} is no picture`);
    const stagedNow = now !== undefined && "staged" in now ? now.staged : undefined;
    if (served.kept === null && now !== undefined && "card" in now) {
      response.writeHead(200, { ...headers, "content-type": served.type, "content-length": String(now.card.length) });
      response.end(now.card);
      return;
    }
    const sending = async (signal?: AbortSignal) => {
      if (served.kept === null) {
        const length = stagedNow === undefined ? blobs.size(hash) : stagedNow.size;
        response.writeHead(200, { ...headers, "content-type": served.type, ...(length === undefined ? {} : { "content-length": String(length) }) });
        await pipeline(stagedNow === undefined ? blobs.stream(hash) : stagedNow.stream(), response, ...signal === undefined ? [] : [{ signal }]);
        return;
      }
      const opened = await served.kept.open();
      if (opened === undefined) throw new Error(`the kept picture of ${hash} is gone`);
      try {
        response.writeHead(200, { ...headers, "content-type": served.type, "content-length": String(opened.size) });
        await pipeline(opened.reading(), response, ...signal === undefined ? [] : [{ signal }]);
      } finally {
        await opened.close();
      }
    };
    await streams!.open.send(now !== undefined && "card" in now ? { people: true } : { blob: hash }, sending);
  };

  const picturesRoute: ReadRoute = (request, response) => {
    new Query(request.url ?? "/", []);
    response.writeHead(200, JSON_HEADERS);
    response.end(JSON.stringify({ recipe: RECIPE }));
  };

  const timeRoute: ReplyRoute = (ask) => {
    const query = new Query(ask.url, ["at", "in"]);
    const at = query.all("at");
    if (at.length === 0 || at.length > TIMES_MOST) bad("at", "is named once or twice");
    const within = query.day("in");
    const { day } = settings();
    return ok(JSON.stringify({ times: at.map((value) => {
      const { start_ms, end_ms } = readTime("at", value, day, within);
      return { start_ms, end_ms };
    }) }));
  };

  const clockRoute = (clock: HomeClock): ReadRoute => (request, response) => {
    new Query(request.url ?? "/", []);
    const etag = `"${clock.id}"`;
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, { etag });
      response.end();
      return;
    }
    response.writeHead(200, { ...JSON_HEADERS, etag });
    response.end(JSON.stringify(clock));
  };

  const callsCounted = (machine: string, now_ms: number, handle: string, from: string, to: string): number | null => {
    const call = new Call(storesOf(machine), now_ms, null, Infinity, new Set(), "person");
    try {
      const collections = collectionsOf(call.families);
      if (!collections.has("calls")) return null;
      const asked = countAskedOf({ of: "calls", person: [handle], from, to }, collections);
      const shown = countShown(countIn(call, asked, (read, counted, context) => countWithAlso(read, counted, context)), asked);
      return "population" in shown ? shown.total?.n ?? shown.population.facts : null;
    } catch (error) {
      if (error instanceof Refusal || error instanceof StoreDamaged || busy(error)) return null;
      throw error;
    } finally {
      call.end();
    }
  };
  const mailsOf = (machine: string, now_ms: number, person: string, to: string): Mail[] | null => {
    const call = new Call(storesOf(machine), now_ms, null, Infinity, new Set(), "person");
    try {
      const params = paramsOf(ROUTES[SEARCH_ROUTE].params, new URLSearchParams([
        ["person", person], ["families", "mail"], ["families", "calendar"], ["lists", "record"], ["order", "newest"], ["to", to], ["limit", String(PERSON_MAILS)],
      ]));
      return (recordPartOf(searchAskedOf(params), call).answer.record?.hits ?? []).map((hit): Mail => ({
        family: hit.family === "calendar" ? "calendar" : "mail", title: hit.title ?? null, from: typeof hit.from === "string" ? hit.from : null, day: hit.day ?? null,
      }));
    } catch (error) {
      if (error instanceof Refusal && error.code === "INDEX_BUILDING") return null;
      if (error instanceof Refusal || error instanceof StoreDamaged || busy(error)) return [];
      throw error;
    } finally {
      call.end();
    }
  };
  const personReads: PersonReads = {
    joined: (machine, use) => viewed((view) => peopleRead({ held: { machine } }, (file) => use(peopleJoined(view, file, input.registry?.families ?? []), file, view))),
    day: () => settings().day,
    dayHead: (day) => readDayHead(folder, day)?.inputs ?? null,
    dayFile: (day) => {
      const kept = dayFile(folder, day, "json").read();
      return kept === undefined ? null : JSON.parse(kept.toString("utf8")) as DayDocument;
    },
    heard: (view, asked, day) => {
      const colon = asked.indexOf(":");
      const network = asked.slice(0, colon);
      if (colon < 0 || networks.of(network) === undefined) return null;
      const labels = labelsFrom((unit) => view.extract(LABELS_FAMILY, unit), settings().day);
      const chat = resolveChat(networks, network, asked.slice(colon + 1), labels);
      return chatSaid(view, network, chat, chatKeys(network, chat, labels), labels, day).said;
    },
    calls: callsCounted,
    product: (id) => productName(input.registry?.connectors ?? [], id),
    mails: mailsOf,
  };
  const mailFamily = input.registry?.families.find((family) => family.name === "mail");
  const owner = ownerOf(input.registry);
  const daysReads: DaysReads = {
    viewed,
    people: (machine, view, use) => prepared(machine, files(machine).people, PEOPLE, "people", peopleBusy, (file) => {
      const joined = peopleJoined(view, file, input.registry?.families ?? []);
      const rejoined = joined.same ? null : joined.list();
      const list = () => (rejoined ?? joined.list()).people.map((person) => ({
        id: person.id, name: person.name, photo: person.photo, chats: person.chats.map(({ key }) => ({ key })), handles: person.handles.map(({ id, kind }) => ({ id, kind })),
      }));
      const kept = rejoined === null ? file.etag("answer", "list") : undefined;
      return use({ tag: kept ?? sha256(JSON.stringify(rejoined ?? joined.list())), list });
    }, () => use(null)),
    day: () => settings().day,
    dayHead: (day) => readDayHead(folder, day)?.inputs ?? null,
    dayFile: (day) => {
      const kept = dayFile(folder, day, "json").read();
      return kept === undefined ? null : JSON.parse(kept.toString("utf8")) as DayDocument;
    },
    products: () => productsOf(input.registry?.connectors ?? []),
    labels: (view) => labelsFrom((unit) => view.extract(LABELS_FAMILY, unit), settings().day),
    evidence: (view, day) => whereEvidence(view, day, day),
    places: (view) => placeTable(view, settings().unit).places.map(({ slug, home, radius_m }) => ({ slug, radius_m, ...(home === true ? { home } : {}) })),
    spots: (machine, pieces) => spotsOf(machine)(pieces),
    group: (labels, chat) => resolvedChat(chat, labels, networks)?.[2] === true,
    owners: (view) => new Map(view.sources().filter((row) => mailFamily !== undefined && readsSource(mailFamily, row) && owner(row)).map((row) => [row.id, String(row.account)])),
    text: (view, ref) => {
      const head = view.head(ref);
      const version = head === undefined || head.version === GONE ? undefined : view.version(head.version);
      return version === undefined || input.registry === undefined ? null : textOf(view, ref, version);
    },
    account: (view, item) => {
      const row = view.enrichment(SCREEN, item, SCREEN_ACCOUNT);
      return row?.state === "done" ? row.content : null;
    },
    transcribed: (view, ref, now_ms) => {
      const head = view.head(ref);
      const version = head === undefined || head.version === GONE ? undefined : view.version(head.version);
      return version === undefined ? null : transcribedOf(view, ref, version, now_ms) ?? null;
    },
    open: (labels, chat) => {
      const resolved = resolvedChat(chat, labels, networks);
      return resolved === null ? null : openOfChat(resolved[0], resolved[2]);
    },
    chat: (view, asked, day) => {
      const { network, id } = chatAsked(asked);
      const labels = labelsFrom((unit) => view.extract(LABELS_FAMILY, unit), settings().day);
      const chat = resolveChat(networks, network, id, labels);
      return { chat: `${network}:${chat}`, conversation: chatSaid(view, network, chat, chatKeys(network, chat, labels), labels, day).said };
    },
  };
  const placesReads: PlacesReads = {
    joined: (machine, now_ms, use) => viewed((view) => {
      const { unit, day } = settings();
      const join = (file: PreparedRead | null) => use(placesJoined(view, unit, file, { now_ms, day }), view.position());
      return placesRead({ held: { machine } }, join, () => join(null));
    }),
    kept: (machine, use) => placesRead({ held: { machine } }, use),
    day: () => settings().day,
  };
  const answered = async (reply: Reply | Promise<Reply>): Promise<unknown> => {
    const { body } = await reply;
    return JSON.parse(typeof body === "string" ? body : Buffer.from(body).toString("utf8")) as unknown;
  };
  const searchReads: SearchReads = {
    position: () => viewed((view) => view.position()),
    kinds: async (ask, query) => kindsShapes.answer.parse(await answered(kindsRoute({ url: `${KINDS_ROUTE}?${query}`, now_ms: ask.now_ms, held: ask.held }))),
    described: async (ask, refs) => {
      const cited = new Map<string, Citation>();
      for (const each of refBatches([...new Set(refs)])) {
        const query = new URLSearchParams(each.map((ref): [string, string] => ["ref", ref]));
        const answer = ROUTES[DESCRIBE_ROUTE].answer.parse(await answered(describeRoute({ url: `${DESCRIBE_ROUTE}?${query}`, now_ms: ask.now_ms, held: ask.held })));
        if (answer.unopened !== undefined) notNow("busy", DESCRIBING, RETRY_SOON_S);
        for (const [n, citation] of answer.described.entries()) cited.set(each[n]!, citation);
      }
      return cited;
    },
    people: (ask, handles) => personReads.joined(ask.machine, (joined) => {
      const listed = new Map<string, { id: string; photo: string | null }>();
      for (const handle of handles) {
        const person = joined.detail(handle);
        if (person !== undefined) listed.set(handle, { id: person.id, photo: photoOf(person) });
      }
      return listed;
    }),
    building: (machine) => recordBuilding(folder, files(machine).search, viewed((view) => view.through)),
    product: (id) => productName(input.registry?.connectors ?? [], id),
    newestDay: (month, today) => {
      const last = addDays(`${addDays(`${month}-28`, 4).slice(0, 7)}-01`, -1);
      for (let day = last < today ? last : today; day.startsWith(month); day = addDays(day, -1)) if (readDayHead(folder, day) !== null) return day;
      return null;
    },
  };
  const settingsReads: SettingsReads = {
    report: (ask) => streamsRead.read(ask, null),
    you: (machine) => {
      try {
        return personReads.joined(machine, (joined, file) => youRow(joined.list(), namesHeld(searchedIn(file))));
      } catch (error) {
        if (error instanceof Refusal && error.code === NOT_NOW) return null;
        throw error;
      }
    },
    running: () => {
      const now = settings();
      return { position: viewed((view) => view.position()), settings: runningSettings(now, thisMachine().helpers), max_bundle_bytes: now.door.max_bundle_bytes };
    },
  };
  const pages = servePages({
    people: peoplePage(personReads),
    person: personPage(personReads),
    group: groupPage(personReads),
    peopleFind: findPage(personReads),
    connectors: streamsPage(streamsRead),
    places: placesPage(placesReads),
    place: placePage(placesReads),
    placeEdit: placeEditPage(placesReads),
    year: yearPage(placesReads),
    days: daysPage(daysReads),
    day: dayPageOf(daysReads),
    thread: threadPage(daysReads),
    search: searchPage(searchReads),
    searchKind: searchKindPage(searchReads),
    moment: momentPage(daysReads),
    settings: settingsHandler(settingsReads),
    settingsPage: settingsPageHandler(settingsReads),
    storage: storageHandler(storageReads),
    models: modelsHandler(modelsHeld),
    modelsFind: modelsFindHandler({
      ...modelsHeld,
      work: (id) => {
        const at = id.lastIndexOf("/");
        const work = input.registry?.connectors.find((each) => each.id === id.slice(0, at))?.processing?.[id.slice(at + 1)];
        return work === undefined ? undefined : { id, kind: work.kind, text_chars: work.text_chars ?? null };
      },
    }),
  }, () => settings().day);

  const screen = screenReads({
    folder, settings, blobs, families: input.registry?.families ?? [], viewed, file: (machine) => screenFileOf(files(machine).search), record: (machine) => files(machine).search,
  });
  const computed = new Map<string, ReplyRoute>([
    ...screen,
    ...pages,
    ["/v1/days", days], ["/v1/sources", sources], ["/v1/records", records], ["/v1/counts", counts], ["/v1/record", record], ["/v1/extracts", extracts],
    ["/v1/enrichments", enrichments], ["/v1/labels", labels], ["/v1/conversation", conversation], ["/v1/people", people], [PEOPLE_SEARCH_ROUTE, peopleSearch], ["/v1/people/photos", peoplePhotos], ["/v1/places/suggest", suggestRoute], ["/v1/devices", devices], ["/v1/where", whereRoute], ["/v1/status", status], ["/v1/products", productsRoute], [SEARCH_ROUTE, search], [KINDS_ROUTE, kindsRoute], [COUNT_ROUTE, countRoute], [READ_ROUTE, readRoute], [DESCRIBE_ROUTE, describeRoute],
    ["/v1/time", timeRoute], ["/v1/models", modelsRoute], ["/v1/processing/range", processingRange], ["/v1/storage", storage], ["/v1/start/cost", startCost],
    ["/v1/photos/wanted", photosWanted],
  ]);
  const preparedRoutes = new Map<string, PreparedRoute>([
    ["/v1/people", peopleRow], ["/v1/people/card", peopleCard], ["/v1/places", places], ["/v1/places/photos", placePhotos], ["/v1/where", year],
  ]);
  const segmented: [string, (segment: string) => ReadRoute][] = [["/v1/days/", dayRoute], ["/v1/blobs/", blob], ["/v1/pictures/", picture]];

  return {
    reply: (pathname) => computed.get(pathname),
    prepared: (pathname) => preparedRoutes.get(pathname) ?? (pathname.startsWith(PHOTO_ROUTE) && !computed.has(pathname) ? photo : undefined),
    card: (machine, hash) => cardOf({ held: { machine } }, hash),
    route(pathname) {
      if (pathname === CLOCK_ROUTE) return clock === undefined ? undefined : clockRoute(clock);
      if (pathname === PICTURES_ROUTE) return picturesRoute;
      if (streams === undefined) return undefined;
      if (pathname === "/v1/feed") return (request, response, held) => streams.feed.follow(request, response, held.still);
      for (const [prefix, make] of segmented) {
        if (!pathname.startsWith(prefix)) continue;
        let segment: string;
        try {
          segment = decodeURIComponent(pathname.slice(prefix.length));
        } catch {
          segment = "";
        }
        return make(segment);
      }
      return undefined;
    },
  };
}

function isVoiceNote(part: { what: string; blob?: string }): part is { what: string; blob: string } {
  return part.what === "voice note" && part.blob !== undefined;
}


class Query {
  readonly #params: URLSearchParams;

  constructor(url: string, names: readonly string[]) {
    this.#params = new URL(url, "http://door").searchParams;
    for (const name of new Set(this.#params.keys())) {
      if (!names.includes(name)) bad(name, "is not a parameter of this route");
    }
  }

  text(name: string): string | undefined {
    const values = this.#params.getAll(name);
    if (values.length > 1) bad(name, "is stated once");
    return values[0];
  }

  required(name: string): string {
    const value = this.text(name);
    if (value === undefined || value === "") bad(name, "is required");
    return value;
  }

  all(name: string): string[] {
    return this.#params.getAll(name);
  }

  day(name: string): string | undefined {
    const value = this.text(name);
    if (value !== undefined && !isDay(value)) bad(name, "is a civil day, YYYY-MM-DD");
    return value;
  }

  time(name: string, edge: "start" | "end" | "moment", day: DaySettings): number | undefined {
    const value = this.text(name);
    return value === undefined ? undefined : timeParameter(name, value, day, edge);
  }

  limit(): number {
    const value = this.text("limit");
    if (value === undefined) return DEFAULT_LIMIT;
    const limit = /^\d{1,4}$/u.test(value) ? Number(value) : NaN;
    if (!(limit >= 1 && limit <= MAX_LIMIT)) bad("limit", `is a whole number from 1 to ${MAX_LIMIT}`);
    return limit;
  }

  photoPage(after: boolean): { at: number; limit: number } {
    const whole = (name: string, least: number, most: number): number | undefined => {
      const value = this.text(name);
      if (value === undefined) return undefined;
      const number = /^\d{1,9}$/u.test(value) ? Number(value) : NaN;
      if (!(number >= least && number <= most)) bad(name, `is a whole number from ${least} to ${most}`);
      return number;
    };
    const at = whole("at", 0, 999_999_999);
    if (at !== undefined && after) bad("at", "is not named with after");
    return { at: at ?? 0, limit: whole("limit", 1, PHOTOS_MOST) ?? PHOTOS_PAGE };
  }

  after<T>(name: string, read: (key: Json) => T | undefined): T | undefined {
    const value = this.text(name);
    if (value === undefined) return undefined;
    let key: Json;
    try {
      key = parse(Buffer.from(value, "base64url").toString("utf8"));
    } catch {
      return bad(name, "is a page's next, as the door stated it");
    }
    return read(key) ?? bad(name, "is a page's next, as the door stated it");
  }
}

function paged<T>(name: string, items: Iterable<T>, limit: number, key: (item: T) => Json, shape: (item: T) => unknown = (item) => item): Record<string, string> {
  const texts: string[] = [];
  let bytes = 0;
  let last: T | undefined;
  let next: string | undefined;
  for (const item of items) {
    if (texts.length === limit || bytes >= PAGE_BYTES) {
      next = Buffer.from(JSON.stringify(key(last!))).toString("base64url");
      break;
    }
    const text = JSON.stringify(shape(item));
    texts.push(text);
    bytes += text.length;
    last = item;
  }
  return { [name]: `[${texts.join(",")}]`, ...(next === undefined ? {} : { next: JSON.stringify(next) }) };
}

function members(texts: Record<string, string>): string {
  return `{${Object.entries(texts).map(([name, text]) => `${JSON.stringify(name)}:${text}`).join(",")}}`;
}

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-cache" } as const;
const POSITION_HEADER = "lifestream-position";

function ok(text: string): Reply {
  return { status: 200, headers: { ...JSON_HEADERS }, body: text };
}

export function refusalReply(refusal: Refusal): Reply {
  return {
    status: refusal.status, code: refusal.code, body: JSON.stringify({ code: refusal.code, message: refusal.words, ...refusal.extra }),
    headers: { "content-type": "application/json", ...(refusal.retryAfter === undefined ? {} : { "retry-after": String(refusal.retryAfter) }) },
  };
}

function headOf(head: Head, version: Version | undefined) {
  return {
    version: head.version, stated_ms: head.stated_ms, since_ms: head.since_ms, start_ms: head.start_ms, end_ms: head.end_ms,
    precision: version?.time?.precision ?? null,
  };
}

function versionOf(version: Version) {
  const time = version.time;
  return {
    id: version.id, content: version.content, start_ms: time?.start_ms ?? null, end_ms: time?.end_ms ?? null,
    offset_min: time?.offset_min ?? null, precision: time?.precision ?? null,
  };
}

function extractOf(row: ExtractRow & { items: string[] }) {
  return { family: row.family, unit: row.unit, reading: row.reading, code: row.code, content: row.content, start_ms: row.start_ms, end_ms: row.end_ms, days: row.days, items: row.items };
}

function byteRange(header: string | undefined, size: number | undefined): { start: number; end: number } | "unsatisfiable" | null {
  if (header === undefined || size === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (match === null || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    return suffix === 0 || size === 0 ? "unsatisfiable" : { start: Math.max(size - suffix, 0), end: size };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size : Math.min(Number(match[2]) + 1, size);
  return start >= size || end <= start ? "unsatisfiable" : { start, end };
}

function isDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  try {
    return addDays(value, 0) === value;
  } catch (error) {
    if (error instanceof TimeError) return false;
    throw error;
  }
}

function readPoint(text: string): Where | null {
  const [lat = "", lon = "", ...rest] = text.split(",");
  const id = rest.join(",");
  if (![lat, lon].every((part) => NUMBER.test(part)) || (rest.length > 0 && id === "")) return null;
  const [latitude, longitude] = [Number(lat), Number(lon)];
  return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude, ...(rest.length > 0 ? { id } : {}) } : null;
}

function shownOf(row: ExtractRow, view: OpenView): { shown_on: string[]; unrendered_on: string[] } {
  const read = new Map(view.dayUnits(row.family, row.unit).map((entry) => [entry.day, entry]));
  const current = (day: string) => {
    const entry = read.get(day);
    return entry !== undefined && entry.reading === row.reading && entry.code === row.code ? entry : undefined;
  };
  return { shown_on: row.days.filter((day) => current(day)?.shown === true), unrendered_on: row.days.filter((day) => current(day) === undefined) };
}

function isPair(key: Json): key is [number, string] {
  return Array.isArray(key) && key.length === 2 && Number.isSafeInteger(key[0]) && typeof key[1] === "string";
}

function whereReading(view: OpenView, first: string, last: string, day: DaySettings): { evidence: ExtractRow[]; labels: Labels } {
  return { evidence: whereEvidence(view, first, last), labels: labelsFrom((unit) => view.extract(LABELS_FAMILY, unit), day) };
}

function whereEvidence(view: OpenView, first: string, last: string): ExtractRow[] {
  const rows = new Map<string, ExtractRow>();
  for (let each = addDays(first, -REACH_DAYS), end = addDays(last, REACH_DAYS); each <= end; each = addDays(each, 1)) {
    for (const row of view.extractsOn(PHYSICAL, each)) rows.set(row.unit, row);
  }
  return [...rows.values()];
}

function withNames(pieces: readonly (Piece | null)[], labels: Labels, spots: (pieces: readonly Piece[]) => (string | null)[]): unknown[] {
  const held = pieces.filter((piece): piece is Piece => piece !== null);
  const names = namesOf(held, labels);
  const keys = spots(held);
  let next = 0;
  return pieces.map((piece) => {
    if (piece === null) return null;
    const at = next++;
    return { ...piece, names: names[at], ...(piece.kind === "stay" ? { spot: keys[at] } : {}) };
  });
}

function oneOf<T extends string>(query: Query, name: string, words: readonly T[]): T | undefined {
  const value = query.text(name);
  if (value !== undefined && !words.includes(value as T)) bad(name, `is ${words.join(", ")} or absent`);
  return value as T | undefined;
}


function bad(name: string, rule: string): never {
  return refuse(422, "BAD_PARAMETER", `${name} ${rule}`);
}

const MAPS_KINDS = ["search", "directions", "place-view", "activity"];
const MAPS_FAMILY = "maps";
const LEFT_OUT = { families: ["screen"], kinds: ["agent-turn", "prompt"], words: ["lifestream"] };
function leftOut(connectors: readonly Connector[]): typeof LEFT_OUT & { products: readonly string[] } {
  return { ...LEFT_OUT, products: connectors.filter((connector) => connector.mentions === false).map((connector) => connector.product) };
}
const AREA_KM = 50;
const RECORDS_FLOOR = 10_000;

function suggestWords(view: OpenView, point: Point, table: PlaceTable, index: RecordRead | undefined): SuggestWords {
  const people = new Set(labelTable(view.extracts(LABELS_FAMILY)).people.flatMap((row) => suggestedWords(row[3])));
  const areas = new Set([...areaNames(point, AREA_KM), ...table.places.flatMap((place) => {
    const { city, region, country } = areaOf(place);
    return [city, region, country].filter((name): name is string => name !== null);
  })].flatMap((name) => suggestedWords(name)));
  const shares = new Map<string, number>();
  const weighed = index === undefined ? RECORDS_FLOOR : Math.max(index.recordCount(), RECORDS_FLOOR);
  return {
    plain: isPlainWord,
    person: (word) => people.has(word),
    area: (word) => areas.has(word),
    share(word) {
      if (index === undefined) return 1;
      let share = shares.get(word);
      if (share === undefined) {
        share = index.holding(word, Math.ceil(weighed * NAME_SHARE) + 1) / weighed;
        shares.set(word, share);
      }
      return share;
    },
  };
}

function storedAnswers(view: OpenView, point: Point): Answers {
  const best = new Map<googlePlaces.Request, { distance: number; at_ms: number; version: string }>();
  for (const row of view.sources({ product: ["google-places"] })) {
    for (const head of view.heads(row.id, googlePlaces.ANSWER_KIND)) {
      const asked = googlePlaces.readAnswerKey(head.key);
      if (asked === undefined) continue;
      const distance = distanceMeters(point, asked);
      const held = best.get(asked.request);
      const at_ms = head.start_ms ?? 0;
      if (distance > ANSWERED_M || (held !== undefined && (held.distance < distance || (held.distance === distance && held.at_ms >= at_ms)))) continue;
      best.set(asked.request, { distance, at_ms, version: head.version });
    }
  }
  const places = (request: googlePlaces.Request): GooglePlace[] => {
    const held = best.get(request);
    const content = held === undefined ? undefined : view.version(held.version).content as { places?: unknown };
    return Array.isArray(content?.places) ? content.places as GooglePlace[] : [];
  };
  return { nearby: places("nearby"), venues: places("venues"), big: { airport: places("airport"), beach: places("beach") } };
}

const ANSWERED_M = PLACE_REACH_M + googlePlaces.ANSWER_REACH_M;

function suggestLimit(query: Query): number {
  const value = query.text("limit");
  if (value === undefined) return SUGGESTIONS_MAX;
  const limit = /^\d{1,3}$/u.test(value) ? Number(value) : NaN;
  if (!(limit >= 1 && limit <= SUGGESTIONS_LIMIT)) bad("limit", `must be a whole number from 1 to ${SUGGESTIONS_LIMIT}`);
  return limit;
}

function degrees(query: Query, name: string, limit: number): number {
  const value = query.text(name);
  const number = value !== undefined && NUMBER.test(value) ? Number(value) : NaN;
  if (!(Math.abs(number) <= limit)) bad(name, `is required, decimal degrees within ${limit}`);
  return number;
}

const CONVERSATION_PARAMETERS = ["chat", "day"];

function refBatches(refs: readonly string[]): string[][] {
  const batches: string[][] = [];
  let chars = 0;
  for (const ref of refs) {
    const held = batches.at(-1);
    if (held === undefined || held.length === REFS_MOST || chars + ref.length > REFS_CHARS) {
      batches.push([ref]);
      chars = ref.length;
    } else {
      held.push(ref);
      chars += ref.length;
    }
  }
  return batches;
}
