import { healthOf, NO_READERS, readImports, type ExportRow } from "./imports-report.js";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import type Database from "better-sqlite3";
import {
  chromeSites, connectorGives, connectorIcon, connectorName, formOf, imports as declaredImports, isLibrary, PHONE_SCREENS, productName, productsOf, roadsOf, routeId, routeOf, runningOf, setsOf, signinSets, siteFormOf, siteOrigins, unitOf,
  type Connector, type Field, type HeldSite, type RefusedStation, type Road, type SignIn,
} from "@lifestreamprotocol/connect";
import {
  addDays, canonical, civilDay, handleOf, homeSecrets, dayBounds, heldOf, itemSpanOf, readPersonRecord, readTables, readText, REST, roomOf, selects, SETTLED, sourceName, spansOf, TYPES, UNREAD, WEEK_DAYS, weekOf,
  weeksOf, type DaySettings, type HomeFolder, type Json, type JsonObject, type SourceRow, type Type, type Weeks,
} from "@lifestreamprotocol/core";
import { ownProductsIn, PEOPLE_SOURCES, pagesShown, PHOTOS_FAMILY, WEB_FAMILY, wantedUnits, type Coming, type Family, type WantedContent, type WebHour } from "@lifestreamprotocol/families";
import { catalogOf, declaredOf, laneSources, offeredSource, partsOf, switchOf, type Catalog, type Switch } from "./catalog.js";
import { BACKUP_PHONE, nameKey, type DeviceKind } from "./devices.js";
import { foldConnector, foldCopy, ranState, worst, type CopyFacts, type Folded, type Ran } from "./fold.js";
import { WINDOWS, type BrokenReason, type Health, type Outcome, type Reason, type Requirement } from "./health.js";
import { historyGate, pauses, POLL_PARKED, readerWords, type Pause } from "./jobs.js";
import { FEEDBACK_URL } from "./feedback.js";
import { extensionFolder, machine } from "./machine.js";
import { REPORT_WORDS } from "./page-feedback.js";
import { peopleFileOf, readQuiet } from "./people.js";
import { readPrincipals, replacedAt, type Principal } from "./principals.js";
import type { Registry } from "./registry.js";
import { connectorSettings, processingMembers, runningSettings, type Member, type Running, type Settings } from "./settings.js";
import { startOf, type Start, type StartSettings } from "./start.js";
import type { Ledger } from "@lifestreamprotocol/model";
import { storedModels, WORK_MEMBER } from "./models.js";
import { PRIVACY_MEMBER } from "@lifestreamprotocol/privacy";
import { readProcessing, type ProcessingInput, type StreamProcessing } from "./processing.js";
import { refreshOf } from "./refresh-now.js";
import { recorderOf, SENDING_MS, type Stated, type Statement } from "./stated.js";
import { keptKey, keptOf, type Kept, type Left } from "./through.js";
import { isStoreGrant, storeGrant, storeNeeds, storeStateOf } from "./stores.js";
import { addingOf } from "./command.js";
import { freshnessOf, toldBy, type SourceFresh } from "./freshness.js";
import { deviceStreams } from "./device-streams.js";
import type { When } from "./pages.js";
import type {
  AccountRow, Act, ConnectorReport, Control, Copy, DeviceRow, ExtensionRow, History, HomeRow, Joins, LineParts, MemberState, Need, NeedKind, Panel, Raised, PauseState, RouteState, Shown, Step,
  StreamPause, StreamsReport, Waiting, Way, Weight,
} from "./streams-report.js";
import {
  aboutLeft, addWords, amount, CAP, cappedWords, filesWords, progressWords, stepLine, whereWords, dayWords, durationWords, everyWords, holdsWords, ladderOf, leftWords, listWords, metWords, monthNamed, monthWords, number, OFF_WORD,
  paceWords, pausedWords, reasonLine, reasonWords, RECORDER_WORDS, recorderWords, sentence, startWords, SESSION_LOG_UNREADABLE, unitOf as durationOf, when, wordsOf, whenItem, zoneWords, type Words,
} from "./stream-words.js";

export type { Shown } from "./streams-report.js";

export const skipKey = (unit: string, step: string): string => `setup:${unit}:${step}`;
export const atKey = (unit: string): string => `setup-at:${unit}`;

export function accountMembers(connector: Connector): Set<string> {
  const signed = signinSets(connector);
  const fields = connector.fields ?? {};
  const form = formOf(connector).filter((name) => fields[name]!.kind !== "path");
  const secrets = Object.keys(fields).filter((name) => fields[name]!.kind === "secret" && !signed.has(name));
  return new Set([...signed, ...form, ...secrets]);
}

const CONTROL_OF: Readonly<Record<Exclude<Field["kind"], "choice" | "duration">, Control>> = {
  number: "stepper", toggle: "toggle", path: "path", list: "list", email: "email", text: "text", date: "date", zone: "zone", secret: "secret",
};
const ITEMS = ["item", "items"] as const;

export interface ConnectorsInput {
  folder: HomeFolder;
  now_ms: number;
  settings: Pick<Settings, "day" | "history" | "sources" | "sites" | "door" | "unit" | "connectors" | "clients" | "defaults" | "runners" | "helpers" | "model" | "privacy">;
  registry: { readonly connectors: Registry["connectors"]; readonly clients?: Registry["clients"]; readonly families: readonly (ProcessingInput["families"][number] & Pick<Family, "adapters">)[] };
  ledger?: Pick<Ledger, "rates"> | null;
  machine: string;
  sites: readonly Pick<HeldSite, "origin" | "checking" | "choosing" | "stations">[] | null;
  present: readonly string[];
  refused?: readonly RefusedStation[];
  stated?: Stated | null;
  unit?: string;
  needs: readonly Raised[];
  free_bytes: number;
  photos: Pick<Coming, "libraries">;
  asked?: readonly { unit: string; source: string }[];
  feedback?: boolean;
}

export type FoldInput = Omit<ConnectorsInput, "needs" | "machine" | "present" | "sites" | "ledger" | "registry"> & { registry: Pick<ConnectorsInput["registry"], "connectors"> };

type Row = Omit<SourceRow, "added_ms" | "read_through_ms">;

interface Device {
  model: string;
  retired: boolean;
  retired_ms: number | null;
}

type Applied = ((member: string, value: Json | null) => { stated: boolean; waiting: string[]; only: string[] }) | null;

interface AttemptRead {
  target: string;
  source: string;
  outcome: Outcome;
  reason: Reason | null;
  facts: JsonObject;
  detail: string | null;
  since_ms: number;
  contact_ms: number | null;
  fails: number;
}

function hasYou(db: Database.Database, sources: readonly SourceRow[], families: readonly Pick<Family, "adapters">[]): boolean {
  const products = ownProductsIn(families);
  const read = db.prepare("SELECT v.text FROM heads h JOIN versions v ON v.id = h.version WHERE h.source = ? AND h.kind = 'person'").pluck();
  return sources.some((source) => products.includes(source.product) && handleOf(source.account) !== null)
    || sources.some((source) => selects(PEOPLE_SOURCES, source) && (read.all(source.id) as (string | Buffer)[]).some((text) => readPersonRecord((JSON.parse(readText(text)) as { content: Json }).content)?.me === true));
}

const lined = (state: string, reason: string | null, words: Words): { line?: string } => {
  const line = reasonLine(state, reason, words);
  return line === undefined ? {} : { line };
};

export function readConnectors(db: Database.Database, input: ConnectorsInput): StreamsReport {
  const { folder, now_ms, settings, registry } = input;
  const { root } = folder;
  const day = settings.day;
  const everyPass = readPrincipals(folder).principals;
  const principals = everyPass.filter((principal) => principal.revoked_at === null);
  const kindOf = new Map(everyPass.map((principal) => [principal.unit, principal.kind]));
  const macs = [...new Set(principals.filter((principal) => principal.kind === "mac").map((principal) => principal.unit))];
  const marking = input.unit !== undefined && kindOf.get(input.unit) !== "phone" ? input.unit : macs.length === 1 ? macs[0]! : null;
  const asking = input.unit === undefined ? macs.length === 1 ? macs[0]! : null : kindOf.get(input.unit) === "mac" ? input.unit : null;
  return db.transaction((): StreamsReport => {
    const folded = foldStreams(db, input, everyPass);
    const weeks = weeksOf(db, folded.connectors.flatMap(({ connector, live }) => (connector.counted_by === "web" ? [] : live.flatMap((copy) => copy.kinds.map((kind) => [copy.row.id, kind] as const)))), day, now_ms);
    const stored = new Set(homeSecrets(join(root, "config", "secrets")).list().map((item) => item.name));
    const tables = readTables(db);
    const processing = readProcessing(tables, input.ledger?.rates(now_ms) ?? null, {
      connectors: registry.connectors, families: registry.families, histories: historiesOf(folded.connectors), blocks: settings.connectors, defaults: settings.defaults, runners: settings.runners, day, now_ms,
      privacy: settings.privacy,
    });
    const grouped = (connector: Connector) => Object.values(connector.fields ?? {}).some((field) => field.home === true);
    const quiet = registry.connectors.some(grouped) ? readQuiet(folder, peopleFileOf(root, input.machine)) as Readonly<Record<string, number>> | undefined : undefined;
    const connectors = pageOrder(joined(folded.connectors.map((each) => {
      const report = reportOf(db, each, input, everyPass, folded.nameOf, folded.held, processing.get(each.connector.id), asking, stored, weeks);
      return grouped(each.connector) ? { ...report, quiet: quiet?.[each.connector.product] ?? null } : report;
    }), registry.connectors));
    const paused = pauses(db).filter((pause) => {
      const [kind, id] = pause.target.split(":");
      return kind !== "pause" || !folded.hidden.has(id!);
    });
    const deviceName = db.prepare("SELECT model FROM devices WHERE unit = ?").pluck();
    const runners = new Map(storedModels(tables.meta).runners.map((runner) => [runner.unit, runner.name]));
    const setup = marking === null ? null : {
      skipped: [...metaUnder(db, skipKey(marking, "")).keys()],
      at: (db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(atKey(marking)) as string | undefined) ?? null,
      you: hasYou(db, tables.sources.list(), registry.families),
    };
    const browsers = [...new Set(input.present.map((unit) => deviceName.get(unit) as string | undefined).filter((name) => name !== undefined))].sort();
    const present = input.present.length > 0;
    const outdated = folded.outdated[0];
    const extension: ExtensionRow = {
      name: "Chrome extension", placed: existsSync(join(extensionFolder(input.machine), "manifest.json")), present, browsers,
      health: outdated !== undefined ? healthOf(outdated)
        : present ? sided("ok", browsers.length > 0 ? `Running in ${listWords(browsers)}` : "Running") : sided("setup", "Not installed"),
    };
    const imported = readImports(db, {
      folder, now_ms, connectors: registry.connectors, free_bytes: input.free_bytes, max_bundle_bytes: settings.door.max_bundle_bytes,
      day, stated: input.stated ?? null,
    });
    const away = paused.find((pause) => pause.target === "home");
    const mac = folded.nameOf(settings.unit);
    const home: HomeRow = {
      name: "Lifestream",
      health: away !== undefined ? { ...sided("paused", away.reason === "" ? "Paused" : sentence(away.reason)), since_ms: away.at_ms }
        : sided("ok", folded.contact_ms === null ? "Nothing yet" : mac === settings.unit ? "Running" : `Running on ${mac}`),
      settings: runningSettings(settings, machine().helpers),
    };
    const needs = shownNeeds(listed(db, folded.needs, imported.needs, input.needs));
    const reports = connectors.map((each) => fedOf(each, registry.connectors, imported.fed));
    return {
      at_ms: now_ms, day: civilDay(now_ms, day), products: productsOf(registry.connectors).digest, needs,
      disk: { free_bytes: input.free_bytes, max_bundle_bytes: settings.door.max_bundle_bytes },
      paused: paused.map((pause) => pauseState(pause, registry.connectors, (unit) => runners.get(unit) ?? unit, now_ms, day)),
      home, devices: folded.devices.map((device) => ({ ...device, streams: deviceStreams(device, reports, needs, registry.connectors) })), extension,
      connectors: reports, setup, off: [...settings.sources.off], imports: imported.imports,
      adding: addingOf(input.machine),
    };
  })();
}

function fedOf(report: ConnectorReport, declared: readonly Connector[], fed: (connector: Connector) => ExportRow | null): ConnectorReport {
  const connector = declared.find((each) => each.id === report.id);
  const by = connector === undefined ? null : fed(connector);
  if (by === null) return report;
  const opens = !report.set_up && declaredImports.importOf(connector!) !== null && report.roads.every((road) => road === "upload");
  return { ...report, export: { ...by, opens }, ...opens ? { line: `Import a ${by.name}`, lead: null } : {} };
}

export function oneList(...lists: readonly (readonly Raised[])[]): Raised[] {
  const seen = new Set<string>();
  return lists.flat().filter((need) => !seen.has(need.id) && seen.add(need.id) !== undefined);
}

export const DISMISSED = "dismissed:";

export const stampOf = (need: Pick<Raised, "since_ms" | "words">): string => (need.since_ms === null ? need.words : String(need.since_ms));

const STOPS_KEEPING: Readonly<Record<BrokenReason, boolean>> = { failing: true, import: true, "provider-changed": true, "missing-file": false };

const stopsKeeping = (reason: Reason | null): boolean => (reason === null ? true : (STOPS_KEEPING as Partial<Record<Reason, boolean>>)[reason] ?? true);

export function weighed(need: Pick<Raised, "state" | "reason" | "connector" | "unit" | "copy">): Pick<Need, "weight" | "banner"> {
  const weight: Weight = need.state === "broken" && stopsKeeping(need.reason) ? "stopped" : "advice";
  return { weight, banner: weight === "stopped" && need.connector === null && need.unit === null && need.copy === null };
}

const heaviness = (need: Pick<Need, "weight" | "banner">): number => (need.banner ? 0 : need.weight === "stopped" ? 1 : 2);

const KIND_ABOUT: Readonly<Record<NeedKind, string | null>> = {
  password: "Lifestream keeps it locked with your other passwords.",
  connect: "Connect it if you just added the extension",
  notice: null,
};

export function kindOf(need: Pick<Raised, "connector" | "acts">): Pick<Need, "kind" | "about"> {
  const kind: NeedKind = need.connector !== null && need.acts.some((act) => act.do === "set") ? "password"
    : need.acts.some((act) => act.do === "browser") ? "connect" : "notice";
  return { kind, about: KIND_ABOUT[kind] };
}

export const shownNeeds = (needs: readonly Need[]): Need[] => needs.filter((need) => !need.dismissed);

export function listed(db: Database.Database | null, ...lists: readonly (readonly Raised[])[]): Need[] {
  const kept = db === null ? new Map<string, string>() : metaUnder(db, DISMISSED);
  return oneList(...lists)
    .map((need): Need => {
      const weighs = weighed(need);
      return { ...need, ...weighs, dismissed: weighs.weight === "advice" && kept.get(need.id) === stampOf(need), ...kindOf(need) };
    })
    .sort((left, right) => heaviness(left) - heaviness(right));
}

export const STANDING = `${UNREAD} AND state = 'imported' AND json_extract(facts, '$.import') IS NULL`;

export function standingOf(db: Database.Database, source: string): string[] {
  return db.prepare(`SELECT id FROM deliveries INDEXED BY deliveries_unread WHERE source = ? AND ${STANDING} ORDER BY id`).pluck().all(source) as string[];
}

const sided = (state: "ok" | "setup" | "paused", words: string): Health<Act> => ({ state, reason: null, words, since_ms: null, next_ms: null, acts: [], detail: null });

export function streamFold(db: Database.Database, input: FoldInput): { needs: Raised[]; histories: Map<string, History> } {
  const folded = foldStreams(db, input, readPrincipals(input.folder).principals);
  return { needs: folded.needs, histories: historiesOf(folded.connectors) };
}

const historiesOf = (connectors: readonly ConnectorFolded[]): Map<string, History> =>
  new Map(connectors.flatMap((each) => (each.history === null ? [] : [[each.connector.id, each.history.history] as const])));

export function streamActs(db: Database.Database, input: FoldInput): Act[] {
  const folded = foldStreams(db, input, readPrincipals(input.folder).principals);
  return [...folded.needs, ...folded.connectors.flatMap((each) => [each.said, ...each.copies.map((copy) => copy.said)])].flatMap((health) => health.acts);
}

interface CopyFolded {
  row: Row;
  road: Road;
  unit: string | null;
  retired: boolean;
  facts: CopyFacts;
  folded: ReturnType<typeof foldCopy>;
  span: { oldest_ms: number | null; newest_ms: number | null; newest_dated: boolean };
  history: CopyHistory | null;
  contact_ms: number | null;
  arrived_ms: number | null;
  held: number | null;
  held_once: boolean;
  kinds: readonly string[];
  said: Health<Act>;
}

interface Required {
  kind: Requirement;
  met: boolean;
  facts: JsonObject;
  act: Act | null;
}

interface ConnectorFolded {
  connector: Connector;
  running: Running;
  name: string;
  noun: [string, string] | null;
  copies: CopyFolded[];
  live: CopyFolded[];
  on: boolean;
  ways: { road: Road; requirements: Required[] }[];
  set_up: boolean;
  ranHere: (road: Road) => boolean;
  pauses: StreamPause[];
  health: Folded;
  said: Health<Act>;
  history: { history: History; line: string } | null;
  start: Start | null;
  applied: Applied;
  trouble: string | null;
  waiting: number;
  paging: boolean;
}

const UNSTATED: Statement = {
  pass: "", grants: null, found: null, imports: null, settings: null, sending: {}, room: null, network: null, recorder: null, stores: null, heard_ms: 0, waiting_since_ms: null,
};

function foldStreams(db: Database.Database, input: FoldInput, everyPass: readonly Principal[]):
  { connectors: ConnectorFolded[]; hidden: ReadonlySet<string>; devices: Omit<DeviceRow, "streams">[]; needs: Raised[]; outdated: Raised[]; nameOf: (unit: string) => string; held: ReadonlyMap<string, Device>; contact_ms: number | null } {
  const { now_ms, settings, registry } = input;
  const day = settings.day;
  const principals = everyPass.filter((principal) => principal.revoked_at === null);
  const stated = input.stated ?? null;
  const reportable = input.feedback ?? FEEDBACK_URL !== null;
  const catalog = catalogOf(registry.connectors);
  const off = switchOf(registry.connectors, settings.sources.off);
  const read = reader(db, now_ms, registry.connectors);
  const fresh = freshnessOf(db, { connectors: registry.connectors, now_ms, read });
  const gate = historyGate(readTables(db), stated, roomOf(input.free_bytes));
  const names = metaUnder(db, nameKey(""));
  const nameOf = (unit: string): string => names.get(unit) ?? read.devices.get(unit)?.model ?? unit;
  const chromeSiteList = chromeSites(registry.connectors);
  const chosenSite = (connector: Connector) => {
    const site = chromeSiteList.find((each) => each.origin === connector.chrome?.origin);
    return site !== undefined && settings.sites.chosen.includes(site.id);
  };
  const stations = principals.some((principal) => principal.kind === "extension");
  const delivering = new Map<string, Set<string>>();
  for (const principal of principals) delivering.set(principal.unit, new Set([...delivering.get(principal.unit) ?? [], ...principal.sources]));

  const deviceRows = deviceRowsOf(db, read, fresh, everyPass, stated, off, nameOf, now_ms, day);
  const troubleOf = new Map(deviceRows.map((row) => [row.unit, row.trouble]));
  const liveUnits = (kind: "mac" | "phone") => deviceRows.filter((row) => row.kind === kind && row.pass !== null && !row.retired && row.health.state !== "off").map((row) => row.unit);
  const stating = (kind: "mac" | "phone") => liveUnits(kind).flatMap((unit) => {
    const own = stated?.[unit];
    return own === undefined ? [] : [{ unit, own }];
  });

  const hidden = new Set(registry.connectors.filter((connector) => connector.hidden === true).map((connector) => connector.id));
  const needs: Raised[] = [];
  const connectors = registry.connectors.filter((connector) => !hidden.has(connector.id)).map((connector): ConnectorFolded => {
    const block = settings.connectors[connector.id];
    const running = connectorSettings(connector, block);
    const name = connectorName(connector);
    const noun = connector.noun === undefined ? null : [...connector.noun] as [string, string];
    const counts = connector.counts ?? null;
    const roads = connectorRoads(connector);
    const say = (facts: Words["facts"]): Words => wordsOf(name, noun, now_ms, day, facts);
    const rows = read.rows.filter((row) => catalog.of(row) === connector);
    const acquirers = new Set(connector.acquirers ?? []);
    const labeler = connector.label?.labeler;
    const told = toldBy(connector);
    const start = running.backfill === null ? null : startOf(settings, connector, now_ms);
    const holding = new Set(rows.filter((row) => !off.source(row)).map((row) => row.copy));
    const applied = appliedOf(connector, catalog, principals, stated, (unit) => read.devices.get(unit)?.retired === true, (unit) => holding.has(unit), input.unit ?? null);
    const sensor = connector.mac?.sensor === true;
    const expect_ms = connector.expect === undefined ? null : durationOf(connector.expect)?.ms ?? null;

    const copies = rows.map((row): CopyFolded => {
      const road = roadsOf(declaredOf(connector, row))[0]!;
      const sent = road === "mac" || road === "phone";
      const device = sent ? read.devices.get(row.copy) : undefined;
      const unit = device === undefined ? null : row.copy;
      const own = fresh.get(row.id)!;
      const spans = (read.spans.get(row.id) ?? []).filter((each) => counts === null || counts.includes(each.kind));
      const all = itemSpanOf(spans);
      const span = { oldest_ms: all.newest_ms !== null && own.item_ms === null ? null : all.oldest_ms, newest_ms: own.item_ms, newest_dated: own.item_dated };
      const attempts = read.attempts(row.id).filter(told);
      const outcomes: Ran[] = [...attempts.map((each) => read.ran(each, connector)), ...read.imports(row.id, road === "upload", sent),
        ...unit === null ? [] : read.sending(stated?.[unit], row.id, nameOf(unit))];
      const contact_ms = own.synced_ms;
      const files = isLibrary(registry.connectors, row.id) ? input.photos.libraries[row.id] ?? 0 : read.wanted(row.id);
      const history = historyOf(read, row.id, road, sensor, start, running.backfill?.pace_ms ?? null, now_ms, files);
      const facts: CopyFacts = {
        road, on: !off.source(row), outcomes, contact_ms, device: sent ? { trouble: unit === null ? null : troubleOf.get(unit) ?? null } : null, newest_ms: span.newest_ms,
        refresh_ms: connector.refresh === undefined ? null : running.refresh_ms, expect_ms, owed: history?.owed === true,
        disk: gate.disk && road !== "label" && history?.owed === true,
        metered: gate.metered && (road === "poll" || road === "chrome") && history?.paged?.owed === true,
      };
      return {
        row, road, unit, retired: device?.retired === true, facts, folded: foldCopy(facts, now_ms), span, history, contact_ms,
        arrived_ms: read.arrived(row.id, spans.map((each) => each.kind)),
        held: heldOf(spans), held_once: spans.length > 0, kinds: spans.map((each) => each.kind), said: sided("ok", ""),
      };
    });
    const live = copies.filter((copy) => copy.facts.on && !copy.retired);
    const on = !settings.sources.off.includes(connector.id) && (copies.length === 0 || copies.some((copy) => copy.facts.on));

    const ownRoad: Road = roads.find((road) => road === "poll" || road === "chrome" || road === "label") ?? roads[0] ?? "poll";
    const ownFolded = read.attempts("").filter(told).flatMap((each) => ranState(read.ran(each, connector), ownRoad, now_ms) ?? []);

    const route = routeOf(connector, block);
    const ranHere = (road: Road): boolean => {
      if (road === "poll") return [...acquirers].some((acquirer) => read.polls.has(acquirer) || read.parked.has(acquirer));
      if (road === "mac" || road === "phone" || road === "label") return live.some((copy) => copy.road === road && copy.held_once);
      return false;
    };
    const ways = roads.map((road): { road: Road; requirements: Required[] } => {
      const requirement = (kind: Requirement, met: boolean, facts: JsonObject = {}, act: Act | null = null): Required => ({ kind, met, facts, act });
      const formRequired = (unset: readonly string[], label: (key: string) => string): Required[] => {
        const first = unset[0];
        if (first === undefined) return [];
        const field = connector.fields?.[first];
        return [requirement("form", false, field?.kind === "path" ? { choose: field.label } : {}, { do: "set", label: label(first), member: first })];
      };
      const roadHeld = copies.some((copy) => copy.road === road && copy.facts.on && !copy.retired);
      const holds = (unit: string) => copies.some((copy) => copy.road === road && copy.facts.on && !copy.retired
        && (copy.unit === unit || delivering.get(unit)?.has(copy.row.id) === true));
      const perDevice = (devices: readonly { unit: string; own: Statement }[], each: (unit: string, own: Statement, held: boolean) => Required[]): Required[] => {
        const unsaid = (held: boolean) => each("", UNSTATED, held)
          .map((required) => ({ ...required, facts: Object.fromEntries(Object.entries(required.facts).filter(([key]) => key !== "device")), act: required.kind === "grant" ? null : required.act }));
        if (devices.length === 0) return unsaid(roadHeld);
        const found = devices.map(({ unit, own }) => each(unit, own, holds(unit)));
        const ready = found.find((requirements) => requirements.every((required) => required.met));
        if (ready !== undefined) return ready;
        const silent = copies.some((copy) => copy.unit !== null && copy.road === road && holds(copy.unit) && !devices.some((device) => device.unit === copy.unit));
        return silent ? unsaid(true) : found[0]!;
      };
      const grantOf = (grant: string, unit: string, own: Statement, held: boolean): Required => {
        const allowed = own.grants?.[grant];
        return requirement("grant", allowed === undefined || allowed === "asked" ? held : allowed === "on" || allowed === "limited", { grant, device: nameOf(unit) },
          { do: "grant", label: "Allow", unit, grant });
      };
      switch (road) {
        case "poll": {
          const unset = running.unset.filter((key) => formOf(connector).includes(key));
          const named = accountOf(connector, running).named;
          const first = connector.signin?.[0];
          return { road, requirements: [
            ...formRequired(unset, (key) => setLabel(connector, key)),
            ...first === undefined ? [] : [requirement("sign-in", route !== null, { way: first.way, ...named === undefined ? {} : { account: named } },
              { do: "signin", label: first.way === "key" ? "Set up" : "Sign in", of: first.acquirer })],
          ] };
        }
        case "chrome": {
          const unset = running.unset.filter((key) => siteFormOf(connector).includes(key));
          return { road, requirements: [
            ...formRequired(unset, () => "Set up"),
            requirement("choose", chosenSite(connector), { extension: stations },
              stations ? { do: "turn", label: "Connect", ids: [connector.id] } : { do: "extension", label: "Add to Chrome" }),
          ] };
        }
        case "mac": {
          const app = connector.mac?.app;
          const stored = connector.mac?.store !== undefined;
          const heard = stating("mac");
          const macs = heard.length > 0 ? heard : liveUnits("mac").map((unit) => ({ unit, own: UNSTATED }));
          return { road, requirements: perDevice(macs, (unit, own, held) => {
            const store = stored ? storeStateOf(own, connector.id) : null;
            const grants = (connector.mac?.grants ?? []).map((each) => grantOf(each, unit, own, held));
            if (store !== null && store !== "allowed") {
              const grant = storeGrant(connector.id);
              return [requirement("grant", false, { grant, device: nameOf(unit), ...store === "unsafe" ? { unsafe: true } : {} },
                store === "unsafe" ? null : { do: "grant", label: "Allow", unit, grant }), ...grants];
            }
            const found = stored && own.stores !== null && store === null ? null : own.found;
            return [
              requirement("app", found === null ? held : found.includes(connector.id),
                { ...app === undefined ? {} : { app }, device: nameOf(unit), ...found === null && unit !== "" ? { looked: false } : {} }),
              ...grants,
            ];
          }) };
        }
        case "phone": {
          const paired = liveUnits("phone");
          return { road, requirements: [
            requirement("pair", paired.length > 0, paired[0] === undefined ? {} : { device: nameOf(paired[0]) }, { do: "pair", label: "Pair" }),
            ...perDevice(stating("phone"), (unit, own, held) => (connector.phone?.grants ?? []).map((grant) => grantOf(grant, unit, own, held))),
          ] };
        }
        case "upload": {
          const handedIn = copies.filter((copy) => copy.road === "upload" && (copy.held_once || copy.contact_ms !== null));
          const handed = handedIn.flatMap((copy) => (copy.contact_ms === null ? [] : [copy.contact_ms]));
          const unset = handedIn.length > 0 ? [] : running.unset.filter((key) => formOf(connector).includes(key));
          const kind = importKindOfConnector(connector);
          const act: Act = kind !== null ? { do: "import", label: "Show", kind } : { do: "upload", label: "Upload" };
          return { road, requirements: [...formRequired(unset, (key) => setLabel(connector, key)),
            requirement("export", handedIn.length > 0, handed.length === 0 ? {} : { at_ms: Math.max(...handed) }, act)] };
        }
        case "label": {
          const install = connector.label?.install;
          const runs = [...read.attempts(""), ...rows.flatMap((row) => read.attempts(row.id))].filter((each) => each.target === `label:${labeler}`);
          const installed = runs.some((each) => each.reason !== "install") || (!runs.some((each) => each.reason === "install") && copies.some((copy) => copy.road === road && copy.held_once));
          return { road, requirements: install === undefined ? [] : [requirement("install", installed, { install }, { do: "install", label: "Install" })] };
        }
        default:
          return { road, requirements: [] };
      }
    });
    const set_up = ways.some((way) => way.requirements.every((each) => each.met));
    const unmetIn = (way: (typeof ways)[number]) => way.requirements.find((each) => !each.met);
    const againIn = (way: (typeof ways)[number]) => way.requirements.find((each) => !each.met && !(set_up && (each.kind === "grant" || each.kind === "app")));
    const again = ways.find((way) => ranHere(way.road) && againIn(way) !== undefined);
    const first = ways.find((way) => unmetIn(way) !== undefined);
    const firstUnmet = again !== undefined ? againIn(again) : set_up || first === undefined ? undefined : unmetIn(first);
    const grantAgain = again !== undefined && firstUnmet?.act?.do === "grant" ? firstUnmet.act : null;
    const unmet: Folded | null = firstUnmet === undefined ? null : {
      state: again !== undefined ? "needs-you" : "setup", reason: firstUnmet.kind, since_ms: null, next_ms: null, facts: { ...firstUnmet.facts, again: again !== undefined },
      id: grantAgain !== null ? `grant:${grantAgain.grant}:${grantAgain.unit}` : again !== undefined ? `setup:${connector.id}:${firstUnmet.kind}` : null, act: null, detail: null,
    };

    const required = (folded: Folded) => ways.some((way) => way.requirements.some((each) => !each.met && each.kind === folded.reason));

    const paused = read.pauses(connector.id);
    const whole = paused.find((pause) => pause.scope === "all") ?? null;
    const health = foldConnector({ on, unmet, paused_ms: whole?.at_ms ?? null, copies: [...live.map((copy) => copy.folded.health), ...ownFolded.filter((folded) => !required(folded))] });
    const acted = (folded: Folded, copy: CopyFolded | null): Act[] => {
      if (folded === unmet) return firstUnmet?.act === null || firstUnmet === undefined ? [] : [firstUnmet.act];
      if (folded.state === "off") return [{ do: "turn", label: "Connect", ids: [connector.id, ...copies.map((each) => each.row.id)] }];
      return actsOf(folded, connector, running, routeOf(connector, settings.connectors[connector.id]), copy?.road ?? ownRoad, read);
    };
    const worded = (folded: Folded, copy: CopyFolded | null): Health<Act> => {
      const words = say({
        ...folded.since_ms === null ? {} : { since_ms: folded.since_ms }, ...folded.facts, road: copy?.road ?? ownRoad, ...folded.next_ms === null ? {} : { next_ms: folded.next_ms },
        ...copy?.unit == null ? {} : { device: nameOf(copy.unit) },
      });
      return {
        state: folded.state, reason: folded.reason, since_ms: folded.since_ms, next_ms: folded.next_ms, acts: acted(folded, copy), detail: folded.detail,
        words: reasonWords(folded.state, folded.reason, words), ...lined(folded.state, folded.reason, words),
      };
    };
    for (const copy of copies) copy.said = worded(copy.folded.health, copy);
    const copyOf = (folded: Folded) => live.find((copy) => copy.folded.health === folded || copy.folded.troubles.includes(folded)) ?? null;
    const trouble = worst(live.flatMap((copy) => copy.folded.troubles));

    const raise = (folded: Folded, copy: CopyFolded | null) => {
      if (folded.id === null) return;
      const { site, open, errand } = folded.facts;
      const grant = folded === unmet ? grantAgain : null;
      needs.push({
        id: folded.id, connector: connector.id, ...grant === null ? {} : { streams: [connector.id] }, copy: copy?.row.id ?? null, unit: copy?.unit ?? grant?.unit ?? null,
        ...worded(folded, copy), state: folded.state as Raised["state"],
        at: typeof site === "string" ? { site, open: typeof open === "string" ? open : null, errand: typeof errand === "string" ? errand : null } : null,
      });
    };
    const offFor = (unit: string) => off.unit(unit) || settings.sources.off.some((id) => {
      const parts = partsOf(id);
      return parts !== null && parts.product === connector.product && parts.copy === unit;
    });
    if (on) {
      needs.push(...storeNeeds(connector, name, stating("mac"), offFor, nameOf));
      if (unmet?.state === "needs-you" && !isStoreGrant(unmet.facts.grant)) raise(unmet, null);
      for (const each of ownFolded.filter((folded) => (folded.state === "needs-you" || folded.state === "broken") && !required(folded))) raise(each, null);
      for (const copy of live) for (const each of copy.folded.troubles.filter((folded) => !required(folded))) raise(each, copy);
      if (set_up) {
        for (const kind of ["mac", "phone"] as const) {
          if (!roads.includes(kind)) continue;
          const grants = (kind === "mac" ? connector.mac?.grants : connector.phone?.grants) ?? [];
          for (const { unit, own } of stating(kind)) {
            if (offFor(unit) || (kind === "mac" && own.found !== null && !own.found.includes(connector.id))) continue;
            const grant = grants.find((each) => own.grants?.[each] === "off" || own.grants?.[each] === "limited");
            if (grant === undefined) continue;
            needs.push({
              id: `grant:${grant}:${unit}`, connector: connector.id, streams: [connector.id], copy: null, unit, state: "needs-you", reason: "grant", since_ms: null, next_ms: null, detail: null, at: null,
              words: reasonWords("needs-you", "grant", say({ grant, allowed: own.grants![grant]!, device: nameOf(unit) })),
              ...lined("needs-you", "grant", say({ grant, device: nameOf(unit) })), acts: [{ do: "grant", label: "Allow", unit, grant }],
            });
          }
        }
      }
    }

    const shown = worded(health, copyOf(health));
    const card = reportable && shown.state === "broken" ? { ...shown, acts: [...shown.acts, { do: "report" as const, label: REPORT_WORDS.act, of: connector.id }] } : shown;
    return {
      connector, running, name, noun, copies, live, on, ways, set_up, ranHere, pauses: paused, health, said: card,
      history: connectorHistory(live, connector, start, now_ms, day), start, applied,
      trouble: trouble === null ? null : worded(trouble, copyOf(trouble)).words,
      waiting: whole === null ? 0 : read.waiting(live.map((copy) => copy.row.id)),
      paging: [...acquirers].some((acquirer) => read.polls.get(acquirer)?.pages === 1),
    };
  });
  const order = new Map(pageOrder(connectors.map((each) => ({ id: each.connector.id, type: typeOf(each.connector), name: each.name }))).map((each, index) => [each.id, index]));
  const contact_ms = [...connectors.flatMap((each) => each.copies.map((copy) => copy.contact_ms)), ...deviceRows.map((row) => row.contact_ms)]
    .reduce<number | null>((best, at) => (at !== null && (best === null || at > best) ? at : best), null);
  const outdated = (input.refused ?? []).map((station): Raised => ({
    id: `extension:${station.unit}`, connector: null, copy: null, unit: station.unit, state: "needs-you", reason: null, since_ms: station.since_ms, next_ms: null, acts: [],
    words: `${station.development ? "Reload" : "Update"} the Lifestream extension in ${read.devices.get(station.unit)?.model ?? "Chrome"}`,
    detail: `it states ${station.version}, below the home's floor`, at: null,
  }));
  return {
    connectors, hidden, nameOf, contact_ms, held: read.devices, outdated,
    devices: deviceRows.map(({ need: _, trouble: __, ...row }) => row),
    needs: oneList(sharedGrants(needs.sort((a, b) => order.get(a.connector ?? "")! - order.get(b.connector ?? "")!)), deviceRows.flatMap((row) => (row.need === null ? [] : [row.need])), outdated),
  };
}

function sharedGrants(needs: readonly Raised[]): Raised[] {
  const kept = new Map<string, Raised>();
  return needs.flatMap((need) => {
    if (need.streams === undefined) return [need];
    const first = kept.get(need.id);
    if (first === undefined) {
      kept.set(need.id, { ...need, streams: [...need.streams] });
      return [kept.get(need.id)!];
    }
    first.streams!.push(...need.streams.filter((stream) => !first.streams!.includes(stream)));
    first.connector = null;
    return [];
  });
}

function reportOf(db: Database.Database, folded: ConnectorFolded, input: ConnectorsInput, everyPass: readonly Principal[], nameOf: (unit: string) => string,
  table: ReadonlyMap<string, Device>, processing: StreamProcessing | undefined, asking: string | null, stored: ReadonlySet<string>, weeks: Weeks | null): ConnectorReport {
  const { now_ms, settings } = input;
  const day = settings.day;
  const { connector, running, name, noun, copies, live, history, set_up, ranHere } = folded;
  const say = (facts: Words["facts"]): Words => wordsOf(name, noun, now_ms, day, facts);
  const nouns = noun ?? ITEMS;
  const copyNames = sourceNames(copies.map((copy) => ({ ...copy.row, road: copy.road })), table, connector, (product) => productName(input.registry.connectors, product),
    (row) => roadsOf(declaredOf(connector, row)).some((road) => road === "mac" || road === "phone"));

  const week = connector.counted_by === "web" ? weekOfPages(db, live, day, now_ms) : weekOfCopies(weeks, live, connector.mirror === true);
  const today = week === null ? null : week.at(-1)!;
  const checked = live.reduce<number | null>((best, copy) => (copy.contact_ms !== null && (best === null || copy.contact_ms > best) ? copy.contact_ms : best), null);
  const latest = live.reduce<CopyFolded | null>((best, copy) => (copy.span.newest_ms !== null && (best === null || copy.span.newest_ms > best.span.newest_ms!) ? copy : best), null);
  const newest = latest?.span.newest_ms ?? null;
  const arrived = live.reduce<number | null>((best, copy) => (copy.arrived_ms !== null && (best === null || copy.arrived_ms > best) ? copy.arrived_ms : best), null);
  const oldest = live.reduce<number | null>((best, copy) => (copy.span.oldest_ms !== null && (best === null || copy.span.oldest_ms < best) ? copy.span.oldest_ms : best), null);
  const heldAll = live.every((copy) => copy.held !== null) ? sumOver(live, connector.mirror === true, (copy) => copy.held) : null;
  const whole = folded.pauses.find((pause) => pause.scope === "all") ?? null;
  const lead = folded.health.state === "syncing" ? "Catching up" : null;
  const sensor = connector.mac?.sensor === true;
  const recorder = connector.mac?.recorder === true
    ? recorderOf(live.flatMap((copy) => (copy.unit === null ? [] : [input.stated?.[copy.unit]].filter((own) => own !== undefined))), now_ms)
    : undefined;
  const parts = lineOf(folded.health.state, folded.said.words, {
    today, newest, oldest, dated: latest?.span.newest_dated === true, held: heldAll, nouns, sensor, recording: recorder === undefined ? "Recording" : recorder === null ? null : recorderWords(recorder.value), owed: history?.line ?? null, now_ms, day, pause: whole, nameOf,
    waiting: folded.waiting, trouble: folded.trouble,
  });

  const counted = (count: number | null) => (count === null ? null : amount(count, nouns));
  const site = connector.chrome === undefined || input.sites === null ? undefined : input.sites.find((each) => each.origin === connector.chrome!.origin);
  const views = connector.chrome === undefined ? [] : site?.stations ?? [];
  const view = views.find((each) => each.signed_in === true) ?? views[0];
  const stations = everyPass.some((pass) => pass.revoked_at === null && pass.kind === "extension");
  const member = (key: string) => running.members.find((each) => each.member === key);
  const chosen = connector.chrome === undefined ? null : folded.ways.find((way) => way.road === "chrome")?.requirements[0]?.met ?? null;
  const signedIn = routeOf(connector, settings.connectors[connector.id]);
  const members = membersOf(connector, running, folded.applied,
    { start: folded.start, paceless: history?.history.state === "done" || !folded.paging },
    (unit) => ({ name: nameOf(unit), kind: everyPass.find((pass) => pass.unit === unit)?.kind === "phone" ? "phone" : "mac" }), now_ms, processing,
    { unit: settings.unit, name: nameOf(settings.unit) }, stored);
  const identity = accountMembers(connector).size > 0 && (set_up || members.some((each) => each.panel === "account"
    && (each.kind === "secret" ? each.held === true : each.from === "person")));
  const days = members.filter((each) => each.panel === "account" && each.kind === "date" && each.from !== "unset").map((each) => `${each.label} ${each.words}`);
  const importing = importKindOfConnector(connector);
  const kind = importing === null ? undefined : declaredImports.importKind(declaredImports.importKinds(input.registry.connectors, NO_READERS), importing);
  return {
    id: connector.id, type: typeOf(connector), icon: connectorIcon(connector), name, product: connector.product, noun, starter: connector.starter === true,
    roads: connectorRoads(connector), shown: shownOf(connector), records: connector.records, gives: connectorGives(connector), before: [...connector.before ?? []], sensor,
    phone_screen: phoneScreenOf(connector), recorder: connector.mac?.recorder === true, mac_grants: [...connector.mac?.grants ?? []],
    mac_copy: asking === null ? null : connector.sources.find((source) => roadsOf(source).includes("mac"))?.id.replace("<unit>", asking) ?? null,
    health: folded.said, line: lineText(parts, now_ms, day), lead, line_parts: parts,
    figure: !set_up || live.length === 0 ? null : {
      today, week, checked_ms: checked, words: checked === null ? "Not checked yet" : `Checked ${when(checked, now_ms, day)}`,
      last_ms: arrived, last: arrived === null ? null : when(arrived, now_ms, day),
    },
    history: history?.history ?? null,
    copies: copies.map((copy, index): Copy => {
      const own = copy.held;
      return {
        id: copy.row.id, name: copyNames[index]!, road: copy.road, unit: copy.unit, on: copy.facts.on, retired: copy.retired, health: copy.said,
        held: own, newest_ms: copy.span.newest_ms, oldest_ms: copy.span.oldest_ms,
        store: copy.road === "mac" && copy.unit !== null && connector.mac?.store !== undefined ? storeStateOf(input.stated?.[copy.unit], connector.id) : null,
        line: !copy.facts.on ? "Off" : [
          own === null ? copy.span.newest_ms === null ? nothingYet(copy) : `Last ${nouns[0]} ${whenItem(copy.span.newest_ms, copy.span.newest_dated, now_ms, day)}`
            : own === 0 ? nothingYet(copy) : copy.span.newest_ms === null ? counted(own)! : `${counted(own)!} · last ${whenItem(copy.span.newest_ms, copy.span.newest_dated, now_ms, day)}`,
          declaredOf(connector, copy.row).lacks === undefined ? "" : `without ${declaredOf(connector, copy.row).lacks}`,
        ].filter(Boolean).join(" · "),
      };
    }),
    account: identity ? accountRow(connector, running, copies, nouns, days) : null,
    export: null,
    ways: folded.ways.map((way): Way => ({
      road: way.road, ready: way.requirements.every((each) => each.met),
      requirements: way.requirements.map((each) => ({
        kind: each.kind, met: each.met, act: each.met ? null : each.act,
        words: each.met ? metWords(each.kind, say(each.facts)) : reasonWords("setup", each.kind, say({ ...each.facts, again: ranHere(way.road) })),
        line: each.met ? null : stepLine(each.kind, say(each.facts), { road: way.road, app: connector.mac?.app ?? null, note: connector.signin?.[0]?.note ?? null, takes: kind?.takes ?? null }),
      })),
    })),
    where: whereWords({
      name, roads: connectorRoads(connector), app: connector.mac?.app ?? null, store: connector.mac?.store !== undefined, library: connector.mac?.library === true,
      every: typeof member("refresh")?.value === "string" ? everyWords(member("refresh")!.value as string) : null, file: kind?.file ?? null,
    }),
    set_up,
    pauses: folded.pauses,
    on: folded.on,
    members,
    processing: processing?.part ?? null,
    backfill_about: connector.backfill?.about ?? null,
    routes: routesOf(connector, input.registry.clients, settings.clients), route: signedIn === null ? null : routeId(signedIn),
    refresh_now: refreshOf(readTables(db), folded, input, nameOf),
    origin: connector.chrome?.origin ?? null,
    origins: connector.chrome === undefined ? null : siteOrigins(chromeSites(input.registry.connectors).find((each) => each.origin === connector.chrome!.origin)!),
    browser: view === undefined ? null : { unit: view.unit, name: nameOf(view.unit) },
    signed_in: connector.chrome === undefined ? null : view?.signed_in ?? null,
    allowed: connector.chrome === undefined ? null : view?.allowed ?? null,
    chrome_account: connector.chrome === undefined ? null : view?.account ?? null,
    chosen,
    checking: connector.chrome === undefined ? null : stations && site?.checking === true,
    choosing: stations ? site?.choosing ?? null : null,
    quiet: null,
    joins: null,
  };
}

function phoneScreenOf(connector: Connector): number | null {
  const screens = (connector.phone?.grants ?? []).map((grant) => PHONE_SCREENS.indexOf(grant)).filter((at) => at >= 0);
  return screens.length === 0 ? null : Math.min(...screens);
}

function sumOver(copies: readonly CopyFolded[], mirror: boolean, value: (copy: CopyFolded) => number | null): number {
  const accounts = new Map<string, number>();
  for (const copy of copies) {
    const account = mirror ? copy.row.account : copy.row.id;
    accounts.set(account, Math.max(accounts.get(account) ?? 0, value(copy) ?? 0));
  }
  return [...accounts.values()].reduce((sum, each) => sum + each, 0);
}

const setLabel = (connector: Connector, key: string): string => (connector.fields?.[key]?.kind === "path" ? "Choose" : "Set");

function actsOf(folded: Folded, connector: Connector, running: Running, signed: SignIn | null, road: Road, read: Reader): Act[] {
  const key = folded.act;
  const polled = key?.startsWith("poll:") === true ? key.slice("poll:".length) : null;
  switch (folded.reason) {
    case "failing": return key === null || key.startsWith("job:") ? [] : [{ do: "try", label: "Try now", need: key }];
    case "power": return key?.startsWith("label:") === true ? [{ do: "try", label: "Scan now", need: key }] : [];
    case "import": return key?.startsWith("job:import:") === true || key?.startsWith("unread:") === true ? [{ do: "skip", label: "Skip it", need: key }] : [];
    case "signed-out": {
      if (road === "chrome" && connector.chrome !== undefined) {
        return [{ do: "open", label: "Open", url: connector.chrome.origin }, ...(polled === null ? [] : [{ do: "try" as const, label: "Try now", need: key! }])];
      }
      const route = [signed, ...connector.signin ?? []].find((each) => each !== null && each.acquirer === polled) ?? connector.signin?.[0];
      if (route !== undefined && route !== null) return [{ do: "signin", label: "Sign in", of: routeId(route) }];
      const secret = running.members.find((each) => each.kind === "secret");
      return secret === undefined ? [] : [{ do: "set", label: "Set", member: secret.member }];
    }
    case "other-account": {
      const offered = polled === null ? null : read.offered(polled, folded.facts.offered ?? folded.facts.account);
      return offered === null || key === null ? [] : [{ do: "read", label: "Read it too", need: key, of: offered }, { do: "ignore", label: "Not this one", need: key, of: offered }];
    }
    case "password": {
      const secret = running.members.find((each) => each.kind === "secret" && (folded.facts.secret === undefined || each.value === folded.facts.secret))
        ?? running.members.find((each) => each.kind === "secret");
      return secret === undefined ? [] : [{ do: "set", label: "Set", member: secret.member }];
    }
    case "confirm": return typeof folded.facts.open === "string" ? [{ do: "open", label: "Open", url: folded.facts.open }] : [];
    default: return [];
  }
}

export function lineOf(state: string, words: string, is: {
  today: number | null; newest: number | null; oldest: number | null; dated: boolean; held: number | null; nouns: readonly [string, string]; sensor: boolean; recording: string | null; owed: string | null; now_ms: number;
  day: DaySettings; pause: StreamPause | null; nameOf: (unit: string) => string; waiting: number; trouble: string | null;
}): LineParts {
  const { nouns, now_ms, day } = is;
  const plain = (line: string): LineParts => ({ words: line, time: null, more: [] });
  const recording = (line: LineParts): LineParts => (is.sensor && is.recording !== null && is.recording !== RECORDER_WORDS.recording ? { ...line, words: `${is.recording} · ${line.words}` } : line);
  switch (state) {
    case "ok":
      if (is.today !== null && is.today > 0) return recording({ words: amount(is.today, nouns), time: { kind: "day", day: civilDay(now_ms, day) }, more: [] });
      if (is.newest !== null) return recording({ words: `Last ${nouns[0]}`, time: itemTime(is.newest, is.dated), more: [] });
      return plain(is.held !== null && is.held > 0 ? amount(is.held, nouns) : is.sensor && is.recording !== null ? is.recording : "Nothing yet");
    case "syncing":
      return is.oldest !== null ? { words: "back to", time: { kind: "month", month: civilDay(is.oldest, day).slice(0, 7) }, more: [] }
        : plain(is.held !== null && is.held > 0 ? amount(is.held, nouns) : is.owed ?? "Nothing yet");
    case "paused": {
      const pause = is.pause!;
      const own = pause.by === "you" || pause.by === "terminal";
      const more = [is.waiting > 0 ? cappedWords(is.waiting, ["waiting", "waiting"]) : "", is.trouble ?? ""].filter(Boolean);
      const paused = pausedWords(pause.by, own ? null : is.nameOf(pause.by), null, is.sensor);
      return own ? { words: paused, time: { kind: "at", at_ms: pause.at_ms }, more } : plain([paused, ...more].join(" · "));
    }
    case "off":
      return plain(OFF_WORD);
    default:
      return plain(words);
  }
}

const itemTime = (ms: number, dated: boolean): When => (dated ? { kind: "day", day: new Date(ms).toISOString().slice(0, 10) } : { kind: "at", at_ms: ms });

export function timeWords(time: When, now_ms: number, day: DaySettings): string {
  switch (time.kind) {
    case "day":
      return whenItem(Date.parse(time.day), true, now_ms, day);
    case "at":
    case "clock":
      return when(time.at_ms, now_ms, day);
    case "month":
      return monthNamed(time.month);
  }
}

export const lineText = (line: LineParts, now_ms: number, day: DaySettings): string =>
  [line.time === null ? line.words : `${line.words} ${timeWords(line.time, now_ms, day)}`, ...line.more].join(" · ");

interface CopyHistory {
  owed: boolean;
  paged: { owed: boolean; left: number | null; rate: number | null } | null;
  files: number;
  traversal: boolean | null;
  stated: number | null;
  label: number | null;
}

function historyOf(read: Reader, id: string, road: Road, sensor: boolean, start: Start | null, pace_ms: number | null, now_ms: number, files: number): CopyHistory | null {
  const page = read.backfill(id);
  const paged = page === undefined ? null : ((here) => {
    const left = here ? page.left : null;
    const landed = here && page.landed === 1;
    return { owed: left === null || left > 0 || !landed, left, rate: here && pace_ms !== null ? pagedRate(JSON.parse(page.recent) as { at_ms: number; left: number | null }[], pace_ms, now_ms) : null };
  })(start !== null && page.start_ms === start.ms);
  const stated = (road === "mac" || road === "phone") && !sensor ? read.left(id) : null;
  const traversal = stated === null ? null : !((start === null || stated.start_ms === start.ms) && stated.left === 0);
  const owing = road === "label" ? read.owed(id) : null;
  if (paged === null && files === 0 && traversal === null && owing === null) return null;
  return { owed: paged?.owed === true || files > 0 || traversal === true || (owing ?? 0) > 0, paged, files, traversal, stated: traversal === true ? stated!.left : null, label: owing };
}

const nothingYet = (copy: CopyFolded): string => (unreading(copy) ? copy.said.words : "Nothing yet");

const unreading = (copy: CopyFolded): boolean => copy.facts.outcomes.some((each) => each.reason === "import" && each.facts.unread === true);

function connectorHistory(live: readonly CopyFolded[], connector: Connector, start: Start | null, now_ms: number, day: DaySettings): { history: History; line: string } | null {
  const known = live.flatMap((copy) => (copy.history === null ? [] : [copy.history]));
  if (known.length === 0) return null;
  const oldest = live.reduce<number | null>((best, copy) => (copy.span.oldest_ms !== null && (best === null || copy.span.oldest_ms < best) ? copy.span.oldest_ms : best), null);
  const back = oldest === null ? "" : `Back to ${monthWords(oldest, day)}`;
  const owing = known.filter((each) => each.owed);
  const nouns = connector.noun ?? ITEMS;
  const from = start === null ? null : { day: start.day, own: start.own };
  if (owing.length === 0) {
    if (live.some(unreading)) return null;
    const words = [back, start === null || start.day === null ? "" : startWords(start.day)].filter(Boolean).join(" · ") || "Complete";
    return { history: { state: "done", back_to_ms: oldest, left: null, unit: null, eta_ms: null, done: null, total: null, progress: null, words, arriving: words, start: from }, line: words };
  }
  const paged = owing.flatMap((each) => (each.paged?.owed === true ? [each.paged] : []));
  const files = Math.min(owing.reduce((sum, each) => sum + each.files, 0), CAP + 1);
  const labels = owing.reduce((sum, each) => sum + (each.label ?? 0), 0);
  let left: number | null = null;
  let unit: [string, string] | null = null;
  let eta_ms: number | null = null;
  let ahead: number | null = null;
  let what: string;
  if (paged.length > 0 && paged.every((each) => each.left !== null)) {
    left = paged.reduce((sum, each) => sum + each.left!, 0);
    unit = [...unitOf(connector) ?? nouns] as [string, string];
    const rates = paged.filter((each) => each.left! > 0);
    const waits = live.some((copy) => copy.facts.disk || copy.facts.metered);
    if (!waits && rates.length > 0 && rates.every((each) => each.rate !== null)) eta_ms = now_ms + Math.round(60_000 * left / rates.reduce((sum, each) => sum + each.rate!, 0));
    what = leftWords(left, unit);
    if (unit[1] === nouns[1]) ahead = left;
  } else if (files > 0) {
    left = files;
    unit = ["file", "files"];
    what = `${filesWords(files)} left`;
  } else if (labels > 0) {
    left = labels;
    unit = [...nouns] as [string, string];
    what = leftWords(left, unit);
  } else {
    what = `reading older ${nouns[1]}`;
    if (owing.every((each) => each.stated !== null)) ahead = owing.reduce((sum, each) => sum + each.stated!, 0);
  }
  const owingCopies = live.filter((copy) => copy.history?.owed === true);
  const done = ahead === null || owingCopies.some((copy) => copy.held === null) ? null : sumOver(owingCopies, connector.mirror === true, (copy) => copy.held);
  const total = done === null ? null : done + ahead!;
  const progress = total === null ? null : progressWords(done!, total);
  const eta = eta_ms === null ? "" : aboutLeft((eta_ms - now_ms) / 60_000);
  const said = progress === null || left === null ? [what, eta] : [eta === "" ? "" : `${eta} left`];
  return {
    history: {
      state: "syncing", back_to_ms: oldest, left, unit, eta_ms, done, total, progress,
      words: [back, ...said].filter(Boolean).join(" · "), arriving: left === null ? back || what : [back, what].filter(Boolean).join(" · "), start: from,
    },
    line: [progress ?? "", ...said].filter(Boolean).join(" · "),
  };
}

function weekOfCopies(weeks: Weeks | null, live: readonly { row: Row }[], mirror: boolean): number[] | null {
  if (weeks === null) return null;
  const accounts = new Map<string, number[][]>();
  for (const { row } of live) {
    const week = weekOf(weeks, row.id);
    const account = mirror ? row.account : row.id;
    accounts.set(account, [...accounts.get(account) ?? [], week]);
  }
  const sum = new Array<number>(7).fill(0);
  for (const weeks of accounts.values()) weeks[0]!.forEach((_, at) => { sum[at] = sum[at]! + Math.max(...weeks.map((week) => week[at]!)); });
  return live.length === 0 ? null : sum;
}

function weekOfPages(db: Database.Database, live: readonly { row: Row }[], day: DaySettings, now_ms: number): number[] | null {
  if (live.length === 0) return null;
  const today = civilDay(now_ms, day);
  const starts = Array.from({ length: WEEK_DAYS + 1 }, (_, index) => dayBounds(addDays(today, index - WEEK_DAYS + 1), day).start_ms);
  const rows = db.prepare("SELECT content FROM extracts WHERE family = ? AND start_ms >= ? AND start_ms < ?").pluck()
    .all(WEB_FAMILY, starts[0]! - 3_600_000, starts[WEEK_DAYS]!) as (string | Buffer)[];
  return pagesShown(rows.map((content) => JSON.parse(readText(content)) as WebHour), new Set(live.map(({ row }) => row.id)), starts);
}

type DeviceFolded = Omit<DeviceRow, "streams"> & { need: Raised | null; trouble: Folded | null };

function deviceRowsOf(db: Database.Database, read: Reader, fresh: ReadonlyMap<string, SourceFresh>, everyPass: readonly Principal[], stated: Stated | null, off: Switch, nameOf: (unit: string) => string, now_ms: number, day: DaySettings): DeviceFolded[] {
  const delivered = db.prepare("SELECT 1 FROM deliveries WHERE pass = ? AND seal IS NOT NULL LIMIT 1").pluck();
  const firstSealed = db.prepare("SELECT sealed_ms FROM deliveries WHERE pass = ? AND seal IS NOT NULL ORDER BY sealed_ms LIMIT 1").pluck();
  const backups = new Set(metaUnder(db, BACKUP_PHONE).values());
  const rows: DeviceFolded[] = [];
  for (const [unit, device] of read.devices) {
    const passes = everyPass.filter((pass) => pass.unit === unit);
    if (passes.length === 0 && backups.has(unit)) continue;
    const copies = read.rows.filter((row) => row.copy === unit);
    const kind = passes.find((pass) => pass.kind === "mac" || pass.kind === "phone")?.kind
      ?? (passes.length > 0 ? null : /phone/iu.test(device.model) ? "phone" : copies.length > 0 ? "mac" : null);
    if (kind !== "mac" && kind !== "phone") continue;
    const retired_ms = device.retired_ms;
    const replaced = passes.filter((pass) => pass.revoked_at === null && replacedAt(pass, passes, (id) => (firstSealed.get(id) as number | undefined) ?? null, retired_ms) !== null)
      .map((pass) => pass.id);
    const live = passes.find((pass) => pass.revoked_at === null && pass.kind === kind && !replaced.includes(pass.id))
      ?? passes.find((pass) => pass.revoked_at === null && pass.kind === kind) ?? null;
    const own = stated?.[unit];
    const contact_ms = Math.max(own?.heard_ms ?? 0, ...copies.map((row) => fresh.get(row.id)?.heard_ms ?? 0)) || null;
    const name = nameOf(unit);
    const say = (facts: JsonObject = {}) => wordsOf(name, null, now_ms, day, { device: name, ...facts });
    const health = (folded: Folded, acts: Act[] = []): DeviceRow["health"] =>
      ({ state: folded.state, reason: folded.reason, since_ms: folded.since_ms, next_ms: folded.next_ms, acts, detail: folded.detail, words: reasonWords(folded.state, folded.reason, say(folded.facts as JsonObject)), ...lined(folded.state, folded.reason, say(folded.facts as JsonObject)) });
    const said = (state: Folded["state"], words: string): DeviceRow["health"] => ({ state, reason: null, words, since_ms: null, next_ms: null, acts: [], detail: null });
    const failing = own?.sending.send;
    const answering = failing === undefined && own !== undefined && own.waiting_since_ms !== null && own.heard_ms - own.waiting_since_ms >= SENDING_MS
      && now_ms - own.heard_ms < SENDING_MS && live !== null && delivered.get(live.id) !== undefined;
    const sending: Folded | null = failing !== undefined ? ranState({ outcome: "fail", reason: "failing", since_ms: failing.since_ms, fails: 1, next_ms: null,
      facts: { code: failing.code }, act: null, id: `send:${unit}`, detail: failing.message }, kind, now_ms)
      : answering ? ranState({ outcome: "fail", reason: "failing", since_ms: own!.waiting_since_ms!, fails: 1, next_ms: null, facts: { answering: true }, act: null, id: `answering:${unit}`, detail: null }, kind, now_ms)
        : null;
    let row: DeviceRow["health"];
    let need: Raised | null = null;
    let trouble: Folded | null = null;
    if (device.retired) row = said("off", "Removed · data kept");
    else if (off.unit(unit)) row = said("off", "Off");
    else if (live === null && passes.length > 0) {
      row = health({ state: "needs-you", reason: "pair", since_ms: null, next_ms: null, facts: {}, id: null, act: null, detail: null }, [{ do: "pair", label: "Pair" }]);
      need = { id: `pair:${unit}`, connector: null, copy: null, unit, ...row, state: "needs-you", at: null };
    } else if (sending !== null) {
      row = health(sending);
      trouble = sending;
      if (sending.state === "broken") need = { id: sending.id!, connector: null, copy: null, unit, ...row, state: "broken", at: null };
    } else if (contact_ms !== null && now_ms - contact_ms > (WINDOWS[kind].quiet_ms as number)) {
      trouble = { state: "quiet", reason: "device", since_ms: contact_ms, next_ms: null, facts: { since_ms: contact_ms }, id: null, act: null, detail: null };
      row = health(trouble);
    } else {
      row = said("ok", contact_ms === null ? "Nothing yet" : `Checked ${when(contact_ms, now_ms, day)}`);
    }
    rows.push({ unit, kind, name, health: row, contact_ms, grants: own?.grants ?? null, found: kind === "mac" && own?.found ? [...own.found] : null, pass: live?.id ?? null, replaced, retired: device.retired, need, trouble });
  }
  return rows.sort((a, b) => Number(a.retired) - Number(b.retired) || Number(a.kind === "phone") - Number(b.kind === "phone") || a.name.localeCompare(b.name) || a.unit.localeCompare(b.unit));
}

function pageOrder<T extends Pick<ConnectorReport, "type" | "name"> & { joins?: Joins | null }>(connectors: readonly T[]): T[] {
  const types: string[] = [...new Set(connectors.map((each) => each.type?.key ?? ""))];
  const rank = (key: string) => types.indexOf(key);
  const collator = new Intl.Collator("en", { numeric: true });
  const named = (each: T) => each.joins?.name ?? each.name;
  return [...connectors].sort((a, b) => rank(a.type?.key ?? "") - rank(b.type?.key ?? "") || collator.compare(named(a), named(b)) || collator.compare(a.name, b.name));
}

function joined(reports: readonly ConnectorReport[], declared: readonly Connector[]): ConnectorReport[] {
  const rows = new Map<string, Connector[]>();
  for (const connector of declared) if (connector.joins !== undefined) rows.set(connector.joins.name, [...rows.get(connector.joins.name) ?? [], connector]);
  return reports.map((report) => {
    const own = declared.find((each) => each.id === report.id)?.joins;
    if (own === undefined) return report;
    const members = rows.get(own.name)!;
    const host = members.find((each) => each.name === own.name) ?? members[0]!;
    const shown = reports.filter((each) => members.some((member) => member.id === each.id));
    const apps = shown.filter((each) => each.set_up || each.ways.some((way) => way.requirements.some((need) => need.kind === "app" && need.met))).map((each) => each.name);
    const row = host.joins!;
    return { ...report, type: typeOf(host), joins: { name: row.name, icon: row.icon ?? connectorIcon(host), gives: row.gives, apps } };
  });
}

const connectorRoads = (connector: Connector): Road[] => [...new Set(connector.sources.flatMap((source) => roadsOf(source)))];

function accountOf(connector: Connector, running: Running): { named: string | undefined; unset: boolean } {
  const panel = accountMembers(connector);
  const shown = running.members.filter((each) => panel.has(each.member) && each.kind !== "secret");
  const named = shown.find((each) => (each.kind === "email" || each.kind === "text") && typeof each.value === "string" && each.value !== "")?.value as string | undefined;
  return { named, unset: shown.some((each) => each.value === null || each.value === "") };
}

function accountRow(connector: Connector, running: Running, copies: readonly CopyFolded[], nouns: readonly [string, string], days: readonly string[]): AccountRow {
  const { named, unset } = accountOf(connector, running);
  const account = "Account";
  const spelled = named?.trim().toLowerCase();
  const its = spelled === undefined ? [] : copies.filter((copy) => [copy.row.account, accountWords(copy.row, connector)].some((each) => each.toLowerCase() === spelled));
  const held = its.length === 1 ? its[0]!.held : null;
  const count = held === null ? "" : amount(held, nouns);
  return {
    name: named ?? account,
    line: named === undefined && unset && days.length === 0 ? "Not signed in" : [named !== undefined ? account : "", count, ...days].filter(Boolean).join(" · "),
    copy: its.length === 1 ? its[0]!.row.id : null,
  };
}

interface KeptRefusal { kind?: string; key?: string; violations?: unknown[] }

export function refusedWords(refusals: readonly KeptRefusal[]): string | null {
  const said = (refusal: KeptRefusal | undefined) => refusal?.violations?.find((each): each is string => typeof each === "string" && each.trim() !== "")?.trim() ?? null;
  const whole = refusals.filter((each) => each.kind === "delivery").map(said).map((each) => (each === null ? null : readerWords(each))).find((each) => each !== null);
  return whole ?? said(refusals.find((each) => each.kind === "file"));
}

function pauseState(pause: Pause, connectors: readonly Connector[], runnerName: (unit: string) => string, now_ms: number, day: DaySettings): PauseState {
  const kinds: Record<string, string> = { poll: "every account", import: "every import", ask: "the model’s questions", render: "the day files", label: "naming faces and places" };
  const named = (id: string) => {
    const connector = connectors.find((each) => each.id === id);
    return connector === undefined ? id : connectorName(connector);
  };
  const [kind, ...rest] = pause.target.split(":");
  const what = pause.target === "home" ? "everything" : kind === "kind" ? kinds[rest[0]!] ?? rest[0]!
    : kind === "pause" ? rest[1] === "history" ? `${named(rest[0]!)}’s history` : named(rest[0]!)
    : kind === "runner" ? `model calls on ${runnerName(rest.join(":"))}` : pause.target;
  const holds = pause.holds === undefined ? "" : pause.holds.length === 0 ? "holds nothing" : `holds ${amount(pause.holds.length, ["source", "sources"])}`;
  return {
    target: pause.target, by: pause.by, reason: pause.reason, at_ms: pause.at_ms, holds: pause.holds ?? null,
    title: `Paused: ${what}`, line: [pause.reason, `since ${when(pause.at_ms, now_ms, day)}`, holds].filter(Boolean).join(" · "),
  };
}

interface Backfill {
  acquirer: string;
  left: number | null;
  start_ms: number | null;
  recent: string;
  last: string | null;
  landed: number | null;
}

type Reader = ReturnType<typeof reader>;

export function photoUnits(db: Database.Database): WantedContent[] {
  const content = (stored: string | Buffer): Json => JSON.parse(typeof stored === "string" ? stored : zstdDecompressSync(stored).toString("utf8")) as Json;
  return [...wantedUnits({
    contents: (prefix) => (db.prepare("SELECT content FROM extracts WHERE family = ? AND unit >= ? AND unit < ?").pluck()
      .all(PHOTOS_FAMILY, prefix, `${prefix.slice(0, -1)}0`) as (string | Buffer)[]).map(content),
  })];
}

function reader(db: Database.Database, now_ms: number, connectors: readonly Connector[]) {
  const tables = readTables(db);
  const rows = (db.prepare("SELECT id, vendor, connector, options FROM sources ORDER BY id").all() as { id: string; vendor: string; connector: string; options: string }[]).map((row): Row => ({
    id: row.id, ...sourceName(row.id), vendor: row.vendor, connector: row.connector, options: JSON.parse(row.options) as JsonObject,
  }));
  const devices = new Map((db.prepare("SELECT unit, model, retired_ms FROM devices ORDER BY unit").all() as { unit: string; model: string; retired_ms: number | null }[])
    .map((row) => [row.unit, { model: row.model, retired: row.retired_ms !== null, retired_ms: row.retired_ms }]));
  const attempts = new Map<string, AttemptRead[]>();
  for (const row of db.prepare("SELECT target, source, outcome, reason, facts, detail, since_ms, contact_ms, fails FROM attempts ORDER BY target, source").all() as
    (Omit<AttemptRead, "facts"> & { facts: string })[]) {
    attempts.set(row.source, [...attempts.get(row.source) ?? [], { ...row, facts: JSON.parse(row.facts) as JsonObject }]);
  }
  const pollsDue = db.prepare("SELECT key, state FROM jobs WHERE kind = 'poll' AND state IN ('queued', 'running')").all() as { key: string; state: string }[];
  const pollsRunning = new Set(pollsDue.filter((row) => row.state === "running").map((row) => row.key));
  const polls = new Map((db.prepare("SELECT acquirer, next_ms, held_ms, page_next_ms, pages FROM polls").all() as
    { acquirer: string; next_ms: number; held_ms: number | null; page_next_ms: number | null; pages: number | null }[]).map((row) => [row.acquirer, row]));
  const parked = new Set(metaUnder(db, POLL_PARKED).keys());
  const paused = new Map<string, StreamPause[]>();
  for (const row of db.prepare("SELECT target, reason, at_ms, by FROM controls WHERE target > 'pause:' AND target < 'pause;' ORDER BY target").all() as
    { target: string; reason: string; at_ms: number; by: string }[]) {
    const [id, scope] = row.target.slice("pause:".length).split(":") as [string, string | undefined];
    const pause: StreamPause = { scope: scope === "history" ? "history" : "all", by: row.by, reason: row.reason, at_ms: row.at_ms };
    paused.set(id, [...paused.get(id) ?? [], pause].sort((a, b) => Number(a.scope === "history") - Number(b.scope === "history")));
  }
  const stopped = new Set([...tables.deliveries.stopped(), ...db.prepare("SELECT key FROM jobs WHERE state = 'dead' AND kind = 'import'").pluck().all() as string[]]);
  const unread = new Map((db.prepare(`SELECT source, count(*) AS deliveries, min(sealed_ms) AS since_ms FROM deliveries INDEXED BY deliveries_unread WHERE ${STANDING} GROUP BY source`)
    .all() as { source: string; deliveries: number; since_ms: number }[]).map((row) => [row.source, row]));
  const newestRefusal = db.prepare(`SELECT (SELECT counts FROM runs WHERE id = d.run) FROM deliveries AS d INDEXED BY deliveries_unread
    WHERE source = ? AND ${STANDING} ORDER BY sealed_ms DESC LIMIT 1`).pluck();
  const refusedOf = (source: string): string | null => {
    const counts = newestRefusal.get(source) as string | null | undefined;
    return counts == null ? null : refusedWords((JSON.parse(counts) as { refusals?: KeptRefusal[] }).refusals ?? []);
  };
  const newestRead = db.prepare(`SELECT d.refused, (SELECT counts FROM runs WHERE id = d.run) AS counts FROM deliveries AS d INDEXED BY deliveries_lane
    WHERE d.source = ? AND d.state = 'imported' ORDER BY d.id DESC LIMIT 1`);
  const refusedWhole = (source: string): boolean => {
    const row = newestRead.get(source) as { refused: number; counts: string | null } | undefined;
    if (row === undefined || row.refused === 0 || row.counts === null) return false;
    return ((JSON.parse(row.counts) as { refusals?: KeptRefusal[] }).refusals ?? []).some((each) => each.kind === REST);
  };
  const perSource = <T>(value: string): Map<string, T> => new Map((db.prepare(`SELECT s.id, (${value}) AS value FROM sources s`).all() as { id: string; value: T }[])
    .map((row) => [row.id, row.value]));
  const arrivedBy = new Map<string, Map<string, number>>();
  for (const row of db.prepare(`SELECT p.source, p.kind, (SELECT coalesce(r.ended_ms, r.started_ms) FROM runs r WHERE r.id = (SELECT n.run FROM (SELECT st.run, st.version, st.origin
      FROM statements st INDEXED BY statements_source WHERE st.source = p.source AND st.kind = p.kind ORDER BY st.seq DESC LIMIT ${CAP}) n
      WHERE n.version <> 'gone' AND n.origin = 'source' LIMIT 1)) AS arrived_ms FROM spans p`).all() as
    { source: string; kind: string; arrived_ms: number | null }[]) {
    if (row.arrived_ms !== null) arrivedBy.set(row.source, (arrivedBy.get(row.source) ?? new Map()).set(row.kind, row.arrived_ms));
  }
  const kept = perSource<string | null>(`SELECT value FROM meta WHERE key = '${keptKey("")}' || s.id`);
  const keptBy = (source: string): Kept => keptOf({ get: () => kept.get(source) ?? undefined }, source);
  const owedStated = perSource<string | null>(
    "SELECT facts FROM deliveries INDEXED BY deliveries_owed WHERE source = s.id AND json_extract(facts, '$.owed') IS NOT NULL ORDER BY sealed_ms DESC LIMIT 1");
  const wanted = perSource<number>(`SELECT count(*) FROM (SELECT 1 FROM wanted_blobs INDEXED BY wanted_blobs_record WHERE source = s.id LIMIT ${CAP + 1})`);
  const lost = new Map((db.prepare(`SELECT s.id,
      (SELECT count(*) FROM (SELECT 1 FROM lost_files INDEXED BY lost_files_sealed WHERE source = s.id LIMIT ${CAP + 1})) AS files,
      (SELECT sealed_ms FROM lost_files INDEXED BY lost_files_sealed WHERE source = s.id ORDER BY sealed_ms LIMIT 1) AS since_ms
    FROM sources s`).all() as { id: string; files: number; since_ms: number | null }[]).map((row) => [row.id, row]));
  const importJob = db.prepare("SELECT state, not_before_ms, ended_ms FROM jobs WHERE kind = 'import' AND key = ?");
  const runStarted = db.prepare("SELECT started_ms FROM runs WHERE id = ?").pluck();
  const backfills = new Map((db.prepare(`SELECT source, acquirer, left, start_ms, recent, last,
      (SELECT state IN ${SETTLED} FROM deliveries WHERE id = b.last) AS landed FROM backfills b`).all() as (Backfill & { source: string })[]).map((row) => [row.source, row]));
  const sealedOf = perSource<number>(`SELECT count(*) FROM (SELECT 1 FROM deliveries INDEXED BY deliveries_source WHERE source = s.id AND state = 'sealed' LIMIT ${CAP + 1})`);
  const fedBy = db.prepare("SELECT id FROM sources s WHERE EXISTS (SELECT 1 FROM deliveries d INDEXED BY deliveries_lane WHERE d.source = s.id AND d.id > ? AND d.id < ?) ORDER BY id").pluck();
  return {
    rows,
    spans: spansOf(db),
    devices: devices as ReadonlyMap<string, Device>,
    polls,
    due: new Set(pollsDue.map((row) => row.key)) as ReadonlySet<string>,
    parked: parked as ReadonlySet<string>,
    pauses: (id: string): StreamPause[] => paused.get(id) ?? [],
    attempts: (source: string): readonly AttemptRead[] => attempts.get(source) ?? [],
    ran(attempt: AttemptRead, connector: Connector): Ran {
      const colon = attempt.target.indexOf(":");
      const [kind, name] = [attempt.target.slice(0, colon), attempt.target.slice(colon + 1)];
      const poll = polls.get(name);
      const next_ms = poll === undefined ? null : kind === "fetch" ? Math.max(poll.next_ms, poll.held_ms ?? 0) : kind === "page" ? poll.page_next_ms : null;
      const account = attempt.facts.offered ?? attempt.facts.account;
      const email = typeof attempt.facts.email === "string" ? attempt.facts.email : typeof account === "object" && account !== null && typeof (account as JsonObject).email === "string" ? (account as JsonObject).email : undefined;
      const trying = attempt.outcome === "fail" && kind === "fetch" && pollsRunning.has(name);
      return {
        outcome: trying ? "wait" : attempt.outcome, reason: trying ? "retrying" : attempt.reason, since_ms: attempt.since_ms, fails: attempt.fails, next_ms,
        facts: { ...attempt.facts, ...email === undefined ? {} : { email }, connector: connector.id }, detail: attempt.detail,
        id: attempt.reason === "password" && typeof attempt.facts.secret === "string" ? `password:${attempt.facts.secret}` : attempt.source === "" ? attempt.target : `${attempt.target}:${attempt.source}`,
        act: kind === "label" ? attempt.target : `poll:${name}`,
      };
    },
    imports(source: string, handed: boolean, sent: boolean): Ran[] {
      const ran: Ran[] = [];
      if (stopped.has(source)) {
        const at = tables.deliveries.blockedAt(source);
        const job = importJob.get(source) as { state: string; not_before_ms: number; ended_ms: number | null } | undefined;
        if (at !== undefined || job?.state === "dead") {
          const started = at?.run == null ? undefined : runStarted.get(at.run) as number | undefined;
          ran.push({ outcome: "fail", reason: "import", since_ms: started ?? job?.ended_ms ?? null, fails: Infinity, next_ms: job?.state === "queued" ? job.not_before_ms : null,
            facts: {}, id: `job:import:${source}`, act: `job:import:${source}`, detail: at?.error ?? null });
        }
      }
      const unreadOf = unread.get(source);
      if (unreadOf !== undefined && (handed || sent && refusedWhole(source))) {
        const why = refusedOf(source);
        ran.push({ outcome: "fail", reason: "import", since_ms: unreadOf.since_ms, fails: Infinity, next_ms: null,
          facts: { unread: true, deliveries: unreadOf.deliveries, ...why === null ? {} : { why } },
          id: `unread:${source}`, act: handed ? `unread:${source}` : null, detail: null });
      }
      const gone = lost.get(source);
      if (gone !== undefined && gone.files > 0) {
        ran.push({ outcome: "fail", reason: "missing-file", since_ms: gone.since_ms, fails: Infinity, next_ms: null, facts: { files: gone.files }, id: `lost:${source}`, act: null, detail: null });
      }
      return ran;
    },
    sending(own: Statement | undefined, source: string, device: string): Ran[] {
      const failure = own?.sending.sources?.[source];
      if (failure === undefined || now_ms < failure.since_ms) return [];
      const unreadable = failure.code === SESSION_LOG_UNREADABLE;
      return [{ outcome: unreadable ? "wait" : "fail", reason: unreadable ? "retrying" : "failing", since_ms: failure.since_ms, fails: 1, next_ms: null,
        facts: { device, code: failure.code }, id: `sending:${source}`, act: null, detail: failure.message }];
    },
    arrived(source: string, kinds: readonly string[]): number | null {
      const of = arrivedBy.get(source);
      return kinds.reduce<number | null>((best, kind) => {
        const at = of?.get(kind);
        return at !== undefined && (best === null || at > best) ? at : best;
      }, null);
    },
    left: (source: string): Left | null => keptBy(source).left,
    owed(source: string): number | null {
      const facts = owedStated.get(source) ?? null;
      const owed = facts === null ? undefined : (JSON.parse(facts) as JsonObject).owed;
      return typeof owed === "number" ? owed : null;
    },
    backfill: (source: string): Backfill | undefined => backfills.get(source),
    wanted: (source: string): number => wanted.get(source) ?? 0,
    waiting: (sources: readonly string[]): number => Math.min(sources.reduce((sum, source) => sum + (sealedOf.get(source) ?? 0), 0), CAP + 1),
    offered(acquirer: string, account: unknown): string | null {
      if (typeof account !== "object" || account === null || typeof (account as JsonObject).id !== "string") return null;
      return offeredSource(laneSources(connectors, rows, acquirer, fedBy.all(`${acquirer}/`, `${acquirer}0`) as string[]), { id: (account as JsonObject).id as string })?.id ?? null;
    },
  };
}


function membersOf(connector: Connector, running: Running, applied: Applied, { start, paceless }: { start: Start | null; paceless: boolean },
  device: (unit: string) => { name: string; kind: "mac" | "phone" }, now_ms: number, processing: StreamProcessing | undefined,
  home: { unit: string; name: string }, stored: ReadonlySet<string>): MemberState[] {
  const account = accountMembers(connector);
  const order = ["refresh", ...Object.keys(connector.fields ?? {}), "start", "pace", ...processingMembers(connector)];
  return order.flatMap((key): MemberState[] => {
    const member = running.members.find((each) => each.member === key);
    if (member === undefined) return [];
    if (key.startsWith(WORK_MEMBER) || key.startsWith(PRIVACY_MEMBER)) {
      const drawn = processing?.members.get(key);
      if (drawn === undefined) return [];
      return [{ key, kind: "choice", label: drawn.label, about: drawn.about, value: member.value, words: drawn.words, from: member.from, default: null, steps: drawn.steps, ...(drawn.menu === undefined ? {} : { menu: drawn.menu }), ...(drawn.route === undefined ? {} : { route: drawn.route }), ...(drawn.line === undefined ? {} : { line: drawn.line }), panel: null, control: drawn.steps === null && drawn.menu === undefined ? null : "menu", where: null }];
    }
    const field = connector.fields?.[key];
    const marks = applied === null || key === "start" || connector.fields?.[key]?.home === true ? null : applied(key, member.value);
    const drawn = marks === null || marks.stated;
    const value = member.value;
    const text = value === null ? "" : String(value);
    const kind: MemberState["kind"] = key === "refresh" || key === "pace" ? "duration" : key === "start" ? "start" : field!.kind;
    const ladder = (words: (word: string) => string): Step[] =>
      ladderOf(text, typeof member.default === "string" ? member.default : null, typeof member.min === "string" ? member.min : null, typeof member.max === "string" ? member.max : null)
        .map((step) => ({ value: step, words: words(step), note: null }));
    let words = "";
    let steps: Step[] | null = null;
    let panel: Panel | null = drawn ? "settings" : null;
    if (key === "refresh") {
      [words, steps] = [everyWords(text), ladder(everyWords)];
    } else if (key === "pace") {
      [words, steps] = [paceWords(text), ladder(paceWords)];
      if (paceless) panel = null;
      else if (panel !== null) panel = "backfill";
    } else if (key === "start") {
      words = startWords(start?.day ?? null);
      if (panel !== null) panel = "backfill";
    } else {
      const declared = field!;
      switch (declared.kind) {
        case "choice": {
          steps = Object.entries(declared.options).map(([option, said]) => (typeof said === "string" ? { value: option, words: said, note: null } : { value: option, words: said[0], note: said[1] }));
          words = steps.find((step) => step.value === text)?.words ?? (text || "Not set");
          break;
        }
        case "duration":
          [words, steps] = [text === "" ? "Not set" : durationWords(text), ladder(durationWords)];
          break;
        case "toggle":
          words = value === true ? "On" : "Off";
          break;
        case "number":
          words = number(typeof value === "number" ? value : Number(value ?? 0));
          break;
        case "list":
          words = holdsWords(value, declared.items === "modes", declared.empty);
          break;
        case "path":
          words = text === "" ? "Not chosen yet" : basename(text);
          break;
        case "date":
          words = text === "" ? "Not set yet" : dayWords(Date.parse(`${text}T12:00:00Z`), now_ms, { zone: "UTC", day_start_hour: 0 });
          break;
        case "zone":
          words = text === "" ? "Lifestream’s time zone" : zoneWords(text, now_ms);
          break;
        case "secret":
          words = "";
          break;
        default:
          words = text === "" ? "Not set yet" : text;
      }
      if (drawn) {
        panel = declared.home === true ? "groups" : account.has(key) ? "account" : declared.kind === "path" && text === "" && connectorRoads(connector).includes("mac") ? "comes-from" : "settings";
      }
    }
    const label = key === "refresh" ? connector.refresh?.label ?? "Check every" : key === "start" ? member.label! : key === "pace" ? "Catch up every" : field!.label;
    const about = key === "refresh" || key === "start" || key === "pace" ? null : field!.about ?? null;
    const shown: MemberState = {
      key, kind, label, about, value, words, from: member.from, default: member.default ?? null,
      ...kind === "number" && typeof member.min === "number" ? { min: member.min } : {}, ...kind === "number" && typeof member.max === "number" ? { max: member.max } : {},
      steps, panel,
      control: steps !== null ? "menu" : key === "start" ? "date" : field === undefined ? null : CONTROL_OF[field.kind as keyof typeof CONTROL_OF],
      where: field?.kind === "path" ? home : null,
    };
    if (field?.kind === "secret") Object.assign(shown, { secret: field.secret, held: typeof member.value === "string" && stored.has(member.value) });
    if (field?.kind === "path" && field.folder === true) shown.folder = true;
    if (field?.kind === "list") Object.assign(shown, field.items === "modes" ? { items: "modes" } : {}, { add: addWords(field.label) });
    if ((field?.kind === "email" || field?.kind === "text") && field.placeholder !== undefined) shown.placeholder = field.placeholder;
    if (marks !== null) {
      shown.waiting = marks.waiting.map((unit): Waiting => {
        const { name, kind: of } = device(unit);
        return { name, kind: of, line: of === "phone" ? `Waiting for ${name} · Open Lifestream on it to sync.` : `Waiting for ${name} · It takes it when Lifestream runs there.` };
      });
      shown.only = marks.only.length === 0 ? null : `On ${listWords(marks.only.map((unit) => device(unit).name))}`;
    }
    return [shown];
  });
}



export function shownOf(connector: Connector): Shown {
  const roads = new Set(connectorRoads(connector));
  if (connector.type === undefined) return Object.keys(connector.fields ?? {}).length > 0 || roads.has("mac") ? "home" : null;
  return ["poll", "chrome", "mac", "phone", "upload"].some((road) => roads.has(road as Road)) ? "stream" : null;
}

function routesOf(connector: Connector, clients: Registry["clients"], held: Settings["clients"]): RouteState[] {
  return (connector.signin ?? []).map((route): RouteState => {
    const client = route.way === "client" ? clients?.find((each) => each.id === route.client) : undefined;
    return {
      id: routeId(route), acquirer: route.acquirer, way: route.way, label: route.label,
      ...(route.about === undefined ? {} : { about: route.about }),
      steps: (route.steps ?? []).map((step) => ({ ...(step.title === undefined ? {} : { title: step.title }), words: step.words, ...(step.open === undefined ? {} : { open: { ...step.open } }) })),
      note: route.note ?? null,
      fields: route.way === "key" ? [...route.fields] : [], sets: setsOf(route, connector),
      client: client === undefined ? null : { id: client.id, name: client.name, held: Object.hasOwn(held, client.id), before: [...client.before] },
    };
  });
}

const SECTIONS: Readonly<Record<Type, { key: Type; name: string }>> = {
  "messages": { key: "messages", name: "Messages and calls" },
  "calls": { key: "messages", name: "Messages and calls" },
  "contacts": { key: "contacts", name: "Contacts" },
  "mail": { key: "mail", name: "Mail and calendar" },
  "plans": { key: "mail", name: "Mail and calendar" },
  "places": { key: "places", name: "Places" },
  "health": { key: "health", name: "Health" },
  "check-ins": { key: "health", name: "Health" },
  "device-activity": { key: "device-activity", name: "Activity" },
  "web": { key: "web", name: "Browsing" },
  "ai": { key: "ai", name: "AI" },
  "photos": { key: "photos", name: "Photos" },
  "notes": { key: "notes", name: "Notes and voice" },
  "voice": { key: "notes", name: "Notes and voice" },
  "listening": { key: "listening", name: "Listening and watching" },
  "watching": { key: "listening", name: "Listening and watching" },
  "money": { key: "money", name: "Money" },
  "social": { key: "social", name: "Social" },
  "code": { key: "code", name: "Code and work" },
};

function importKindOfConnector(connector: Connector): string | null {
  if (connector.export === undefined) return null;
  return "product" in connector.export ? declaredImports.importOf(connector)?.kind ?? null : connector.id;
}

function typeOf(connector: Connector): ConnectorReport["type"] {
  if (connector.type === undefined) return null;
  const section = SECTIONS[connector.type];
  return { key: section.key, name: section.name, icon: TYPES[section.key].icon };
}

export function deviceSettings(connectors: readonly Connector[], settings: StartSettings, kind: DeviceKind, sources: readonly string[], now_ms: number): Record<string, JsonObject> {
  const delivered = new Set<Connector>();
  for (const source of sources) {
    const connector = catalogOf(connectors).delivered(kind as Road, source);
    if (connector !== undefined) delivered.add(connector);
  }
  return Object.fromEntries([...delivered].map((connector) => {
    const running = connectorSettings(connector, settings.connectors[connector.id]);
    const homes = new Set(processingMembers(connector));
    const members = Object.fromEntries(running.members.filter((each) => each.kind !== "secret" && each.kind !== "start" && connector.fields?.[each.member]?.home !== true && !homes.has(each.member))
      .map((each) => [each.member, each.value]));
    return [connector.id, { ...members, start_ms: startOf(settings, connector, now_ms).ms }];
  }));
}


function appliedOf(connector: Connector, catalog: Catalog, passes: readonly Principal[], stated: Stated | null,
  retired: (unit: string) => boolean, holds: (unit: string) => boolean, asking: string | null): Applied {
  const kinds = new Set(connectorRoads(connector).filter((road): road is "mac" | "phone" => road === "mac" || road === "phone"));
  if (kinds.size === 0) return null;
  const delivering = [...new Set(passes.filter((pass) => pass.kind !== null && kinds.has(pass.kind as "mac" | "phone") && !retired(pass.unit)
    && pass.sources.some((id) => catalog.delivered(pass.kind as Road, id) === connector))
    .map((pass) => pass.unit))].sort();
  return (member, value) => {
    const stating = delivering.flatMap((unit) => {
      const own = stated?.[unit]?.settings?.[connector.id];
      return own !== undefined && Object.hasOwn(own, member) ? [{ unit, said: own[member]! }] : [];
    });
    return {
      stated: stating.length > 0,
      waiting: stating.filter((each) => each.unit !== asking && canonical(each.said) !== canonical(value)).map((each) => each.unit),
      only: delivering.some((unit) => holds(unit) && !stating.some((each) => each.unit === unit)) ? stating.map((each) => each.unit) : [],
    };
  };
}

function metaUnder(db: Database.Database, prefix: string): Map<string, string> {
  const rows = db.prepare("SELECT key, value FROM meta WHERE key >= ? AND key < ? ORDER BY key").all(prefix, `${prefix}￿`) as { key: string; value: string }[];
  return new Map(rows.map((row) => [row.key.slice(prefix.length), row.value]));
}


function sourceNames(
  rows: readonly (Row & { road: Road })[], devices: ReadonlyMap<string, Device>, connector: Pick<Connector, "chrome" | "cloud" | "mac">, productName: (product: string) => string,
  delivered: (row: Row) => boolean,
): string[] {
  const site = connector.chrome !== undefined;
  const said = (values: readonly string[]): readonly string[] => (new Set(values).size > 1 ? values : values.map(() => ""));
  const joined = (...parts: string[]) => parts.filter((part) => part !== "").join(" · ");
  const browser = rows.map((row) => (site && row.road === "chrome" && row.copy !== "export" ? accountWords(row, connector) : null));
  const product = said(rows.map((row) => productName(row.product)));
  const where = said(rows.map((row) => whereRead(row, devices, connector)));
  const names = rows.map((_, index) => browser[index] ?? joined(product[index]!, where[index]!));
  for (const name of new Set(names.filter((_, index) => browser[index] === null))) {
    const alike = names.flatMap((each, index) => (each === name && browser[index] === null ? [index] : []));
    if (alike.length < 2) continue;
    const accounts = said(alike.map((index) => accountWords(rows[index]!, connector)));
    alike.forEach((index, at) => {
      names[index] = joined(name, accounts[at]!);
    });
  }
  const bare = names.filter((each) => each === "").length > 1;
  const seen = new Map<string, number>();
  return names.map((each, index) => {
    const row = rows[index]!;
    const name = each !== "" ? each : (bare || ((delivered(row) || (row.road === "poll" && row.account === "local")) && devices.has(row.copy)) ? whereRead(row, devices, connector) : "") || productName(row.product);
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name} ${count}`;
  });
}

function whereRead(row: Row, devices: ReadonlyMap<string, Device>, connector: Pick<Connector, "chrome" | "cloud">): string {
  if (row.copy === "browser") return "Chrome";
  if (connector.chrome !== undefined || row.copy === "export") return "Export";
  const device = devices.get(row.copy);
  if (device !== undefined) return device.retired ? `Previous ${device.model}` : device.model;
  if (row.copy === "cloud") return connector.cloud ?? "Online";
  return "";
}

function accountWords(row: Row, connector: Pick<Connector, "mac">): string {
  const rule = connector.mac?.store?.account;
  if (typeof rule === "object" && "folders" in rule) return row.account.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  return typeof row.options.email === "string" ? row.options.email : typeof row.options.name === "string" ? row.options.name : row.account;
}


function pagedRate(recent: readonly { at_ms: number; left: number | null }[], pace_ms: number, now_ms: number): number | null {
  const points = recent.filter((point) => point.left !== null);
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined || last === first || last.at_ms < now_ms - 3 * pace_ms) return null;
  const owed = first.left! - last.left!;
  const minutes = (last.at_ms - first.at_ms) / 60_000;
  return owed > 0 && minutes > 0 ? owed / minutes : null;
}

