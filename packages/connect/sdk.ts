
/** The versions of the connector contract this home serves. */
export const CONTRACTS: readonly number[] = [3];

export type { Check, Client, Connector, Field, GuideStep, ImportProductOf, KindExport, MacStore, OwnExport, Probe, SignIn, SqliteStore, Test, ValueRule, Work } from "./declaration.js";
export type { Acquirer, Fetched, FetchedFile, FetchedNew, FetchedPage, ImportStated, Lent, Memory, OpenPage, Reader, ReaderView, Secrets, SignedIn, SignInChecked, SignInGiven, ViewHead, ViewVersion } from "./seams.js";
export type { AcquirerSettings, Dependencies, ImapClient, ImapConnection, ImapMailbox, ImapMessage, ImapQuery, ImapSizeQuery } from "./shared/dependencies.js";
export type { Recipe } from "./shared/recipe.js";
export type {
  Activity, Adapter, Adapters, AdapterSource, AdapterVersion, AiAdapter, AiFile, AiLine, AiSaid, AiSession, AiTurn, CalendarAdapter, CalendarCopy, CalendarEvent, CalendarParty,
  CalendarWords, Call, CallAudioAdapter, CallAudioPart, CallLoudness, CallOutput, CallParty, CallsAdapter, CallTrack, Copy, Cycle, DaySummary, Dictation, Fix, Focus, HealthAdapter, HealthItem, How, InputRecord,
  InstrumentWorkout, LabelsAdapter, Line, LineAdapter, ListeningAdapter, MailAdapter, MailItem, Meeting, MessageFact, MessageImages, MessageLabel,
  MessagePart, MessageParty, MessagesAdapter, MoneyAdapter, Months, Motion, Note, NotesAdapter, PartyKind, PhoneAdapter, PhotoFile, PhotoHead, PhotoPosition,
  PhotoResource, PhotosAdapter, PhotoView, PhysioDay, Play, PlayEntry, PlayHeard, PlayItem, Recording, Recovery, RecoveryFacts, Reminder, Report,
  Sample, ScreenAdapter, Sleep, SleepFacts, SourceRecords, Stage, Strain, Trial, Txn, Usage, Vigilance, Visit, VoiceAdapter, WebAdapter, WebItem,
  WebVisit, Witness, Workout,
} from "@lifestreamprotocol/core";

export type {
  FakeElement, FakeFolder, FakeMailbox, FakePage, Files, Fixture, FixtureDelivery, ItemOf, Provider, Scenario, Site, SiteAnswer, SiteRequest, Spoiled,
} from "./shared/dependencies.js";

export { movedEarlier, NeedsYou, NotYet } from "./seams.js";
export { Refused } from "./shared/refused.js";

export * as works from "./works.js";
export { issuerOf, MAC_REFRESH, ROAD_PACE, routeNamed } from "./declaration.js";

export {
  databaseWindow, openDeliveredSqlite, requireColumns, rowJson, type Sqlite, type SqliteRow, type SqliteValue,
} from "./shared/sqlite.js";
export { blobIndex } from "./shared/blob-index.js";
export { blobRef, listedBlobs } from "./shared/blobs.js";
export { blobChunks, fileSha256 } from "./shared/chunks.js";
export { asJson, jsonAt, jsonElements, readJson, utf8, type JsonAtPart, type JsonShaped } from "./shared/json.js";
export { csvRows, type CsvLimits, type CsvRow } from "./shared/csv.js";
export { CONSUMED, MEDIA_HEAD, mediaTypeOf, UNDATED } from "@lifestreamprotocol/core";
export * as ics from "./shared/ics.js";
export { BYTES_LIMIT, openDeliveredZip, openZip, type Zip, type ZipEntry, type ZipSource } from "./shared/zip.js";
export { isTgz, openTgz, type TarEntry, type Tgz } from "./shared/tar.js";
export {
  archive, consuming, fileMember, stored, wholeFiles, zipped, type Member, type Stored, type Streamed,
} from "./shared/members.js";
export { forThisAccount } from "./shared/exported.js";
export { accountsNamed, type AccountsNamed, type ImportAccount } from "./shared/import-account.js";
export { matches } from "./shared/patterns.js";
export { basicInstant, carriesNothing, deliveredLines, parseLine, unitOf } from "./shared/lanes.js";
export { lineText } from "./shared/lines.js";
export { abbreviatedInstantOf, appleInstant, instantMs, spanOf, tryInstant } from "./shared/delivery.js";
export { cardCount, streamCards, type SlicedCard } from "./shared/vcard.js";
export { isMboxDelimiter, mboxMessages, readHeaders, type Header, type Headers } from "./shared/email.js";
export { fingerprint } from "./shared/fingerprint.js";
export { attempt, each, refuse, refusedFile } from "./shared/refused.js";
export { inOrder, ordered, together } from "./shared/order.js";
export * as checks from "./shared/checks.js";

export {
  afterStop, answered, isStop, request, retryAfter, Stopped, type Budget, type RequestOptions, type Stop,
} from "./shared/http.js";
export { feeds, instantOf, rfc3339 } from "./shared/delivery.js";
export { offline } from "./shared/offline.js";
export {
  clientRefresher, credentialText, oauthCredential, oauthFresh, oauthRefresher, tokenRefresher, type OAuthCredential, type OAuthIssuer, type Refresher,
} from "./shared/oauth.js";
export {
  onSite, readBody, type OnSite, type Pull, type SiteConnector, type SiteDependencies, type SiteLane, type SiteVisit,
} from "./shared/site-lane.js";
export { tabRead, TOKEN, whoIs, type PageRead, type Who } from "./shared/setup.js";
export {
  browserAcquirer, exportedFiles, newer, readable, unread, type BrowserSettings, type ListPage, type Recipe as BrowserRecipe,
} from "./shared/browser.js";
export { RecipeBroken, runSteps, type StepOptions } from "./shared/recipe.js";
export { Limited, StationFailed } from "./shared/station.js";
export type {
  Cookie, Errand, ErrandSpec, FileAnswer, FileRef, Found, Held, Locator, Outline, PageRequest, PageResponse, Secret, Signals, Stations, Tab, Value,
  WaitFor,
} from "./shared/station.js";

export {
  addDays, canonical, civilDay, dayBounds, digest, duration, instant, isObject, parse, render, sourceName, span, textHead, TimeError,
  type BlobReader, type Delivery, type DeliveryFile, type Guard, type Instant, type Json, type JsonObject, type ReaderOutput, type RecordRef,
} from "@lifestreamprotocol/core";
