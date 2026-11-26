import { chromeSites, declarations, faces, googlePlaces, roadsOf, routeId, runningOf, type Acquirer, type Client, type Connector, type Entry, type Labeler, type Reader, type SignedIn } from "@lifestreamprotocol/connect";
import type { Dependencies } from "@lifestreamprotocol/connect/sdk";
import { join } from "node:path";
import { digest, openMemo, type Adapter, type Adapters, type JsonObject } from "@lifestreamprotocol/core";
import { openLedger, type NewOutbound } from "@lifestreamprotocol/model";
import {
  aiFamily, calendarFamily, callsFamily, healthFamily, labelsFamily, listeningFamily, mailFamily, messagesFamily, moneyFamily, notesFamily, phoneFamily, photosFamily,
  bigHints, fedNone, made, physicalFamily, plainFamily, screenFamily, voiceFamily, webFamily, type Family, type Fed, type Given, type Maker,
} from "@lifestreamprotocol/families";
import { switchOf } from "./catalog.js";
import { HOME_DEPENDENCIES } from "./dependencies.js";
import { admittedSet, declaredOf, releaseAdmitted, type AdmittedFolder } from "./folders.js";
import { readHome } from "./lifecycle.js";
import { machine as thisMachine } from "./machine.js";
import { peopleFileOf, readGroups } from "./people.js";
import { placesFileOf, readOwed } from "./places.js";
import { faceEngine, repoRoot } from "./programs.js";
import type { Registry, RegistryHome } from "./registry.js";
import { connectorSettings, type Settings } from "./settings.js";



function adaptersOf(set: readonly AdmittedFolder[]): FolderAdapters[] {
  return set.map((each) => ({ connectors: each.entry.connectors, ...(each.entry.adapters === undefined ? {} : { adapters: each.entry.adapters }), ...(each.digest === undefined ? {} : { digest: each.digest }) }));
}

async function modulesOf(folder: string): Promise<readonly Entry[]> {
  return (await admittedSet(folder)).map((each) => each.entry);
}

type Factory = (settings: never, dependencies?: Dependencies) => Acquirer;

const factoriesOf = (modules: readonly Entry[]): Readonly<Record<string, Factory>> => Object.assign({}, ...modules.map((module) => module.acquirers ?? {}));

const labelersOf = (modules: readonly Entry[]): Readonly<Record<string, (settings: never) => Labeler>> => Object.assign({}, ...modules.map((module) => module.labelers ?? {}));

const signinsOf = (modules: readonly Entry[]): Readonly<Record<string, SignedIn>> => Object.assign({}, ...modules.map((module) => module.signins ?? {}));

export const clientsOf = (modules: readonly Entry[]): readonly Client[] => modules.flatMap((module) => module.clients ?? []).sort((a, b) => a.id.localeCompare(b.id));

export const adaptersBy = (modules: readonly Entry[]): Readonly<Record<string, Adapters>> => Object.assign({}, ...modules.map((module) => module.adapters ?? {}));

export default async function homeRegistry(settings: Settings, home: RegistryHome): Promise<Registry> {
  const folder = home.root;
  const modules = await modulesOf(folder);
  const declared = declaredOf(modules);
  const folders = adaptersOf(await admittedSet(folder));
  return {
    connectors: declared, families: families(settings, folder, folders), readers: modules.flatMap((module) => module.readers), acquirers: acquirers(declared, factoriesOf(modules), settings, home),
    signins: signinsOf(modules), clients: clientsOf(modules), adapters: adaptersBy(modules), labelers: labelers(declared, labelersOf(modules), settings, home, fedBy(folders)), feeders: feedersOf(declared),
    placesSearch: { secret: placesKey(settings), endpoint: googlePlaces.GOOGLE },
  };
}

export function connectors(): readonly Connector[] {
  releaseAdmitted();
  return declarations();
}

export function connectorsWith(own: readonly Connector[]): readonly Connector[] {
  const release = connectors();
  const ids = new Set(release.map((connector) => connector.id));
  return [...release.map((connector) => own.find((each) => each.id === connector.id) ?? connector), ...own.filter((each) => !ids.has(each.id))];
}


export function readers(): Reader[] {
  return releaseAdmitted().entries.flatMap((each) => [...each.entry.readers]);
}

export function feedersOf(declared: readonly Connector[]): Record<string, string> {
  return Object.fromEntries(declared.flatMap((connector) => connector.sources.flatMap((source) => (source.feeders ?? []).map((feeder) => [feeder, source.read]))));
}


export function families(settings: Settings, folder: string, folders: readonly FolderAdapters[] = adaptersOf(releaseAdmitted().entries)): Family[] {
  const fed = fedBy(folders);
  const screen = coded(screenFamily({ zone: settings.day.zone, cutover_ms: settings.screen_cutover_ms }), digest({ cutover_ms: settings.screen_cutover_ms, zone: settings.day.zone }));
  const books = { books: fed.labels };
  return made({
    messages: messagesFamily(books), mail: mailFamily(books), ai: aiFamily, screen, photos: photosFamily({ faces: facesRun(settings, folder) }), voice: voiceFamily, calendar: calendarFamily(books),
    notes: notesFamily, money: moneyFamily, calls: callsFamily({ ...books, messages: fed.messages }), health: healthFamily, listening: listeningFamily, web: webFamily({ cutover_ms: settings.screen_cutover_ms, screen: fed.screen }),
    phone: phoneFamily({}), physical: physicalFamily({ photos: fed.photos }), labels: labelsFamily({ home: settings.unit, messages: fed.messages, mail: fed.mail }), line: plainFamily,
  }, fed);
}

export interface FolderAdapters {
  readonly connectors: readonly Connector[];
  readonly adapters?: Readonly<Record<string, Adapters>>;
  readonly digest?: string;
}

export function fedBy(folders: readonly FolderAdapters[]): Fed {
  const fed = fedNone() as unknown as Record<keyof Adapters, Given[]>;
  for (const each of folders) {
    for (const [id, adapters] of Object.entries(each.adapters ?? {})) {
      const connector = each.connectors.find((declared) => declared.id === id);
      if (connector === undefined) continue;
      for (const [family, adapter] of Object.entries(adapters) as [keyof Adapters, Adapter][]) {
        for (const [product, { name, vendor }] of [[connector.product, connector], ...Object.entries(connector.products ?? {})] as const) {
          fed[family].push({ product, name, vendor, type: connector.type ?? null, adapter, ...(each.digest === undefined ? {} : { digest: each.digest }) });
        }
      }
    }
  }
  for (const list of Object.values(fed)) list.sort((left, right) => (left.product < right.product ? -1 : left.product > right.product ? 1 : 0));
  return fed as unknown as Fed;
}

function coded<A extends Adapter>(maker: Maker<A>, options: string): Maker<A> {
  return (given) => {
    const family = maker(given);
    return { ...family, code: `${family.code}:${options}` };
  };
}


export function acquirers(declared: readonly Connector[], factories: Readonly<Record<string, Factory>>, settings: Settings, home: RegistryHome): Acquirer[] {
  return declared.flatMap((connector) => {
    const block = settings.connectors[connector.id];
    const running = connectorSettings(connector, block);
    const make = (name: string) => factories[name]!(working({
      ...running.built, zone: settings.day.zone, unit: settings.unit,
    }, workOf(home, name)) as never, HOME_DEPENDENCIES);
    return (connector.acquirers ?? []).flatMap((name) => (builds(declared, connector, block, name) ? [make(name)] : []));
  });
}

export function builds(declared: readonly Connector[], connector: Connector, block: JsonObject | undefined, name: string): boolean {
  if (chromeSites(declared).some((site) => site.lanes.includes(name))) return true;
  if (block === undefined || !runningOf(connector, block).includes(name)) return false;
  if (connectorSettings(connector, block).unset.length === 0) return true;
  const polled = connector.sources.some((source) => roadsOf(source).includes("poll"));
  return !polled && connector.refresh !== undefined;
}

export function labelers(declared: readonly Connector[], factories: Readonly<Record<string, (settings: never) => Labeler>>, settings: Settings, home: RegistryHome, fed: Fed): Labeler[] {
  const lent = labelerLend(settings, home, fed);
  return declared.flatMap((connector) => connector.label === undefined ? [] : [factories[connector.label.labeler]!(working({
    ...connectorSettings(connector, settings.connectors[connector.id]).fields, ...lent,
    lookup: lookupWriter(home, connector.label.labeler), looked: lookupsOf(home, connector.label.labeler),
  }, workOf(home, connector.label.labeler)) as never)]);
}

export function lookupRow(by: string, sent: googlePlaces.Lookup, at_ms: number): NewOutbound {
  return {
    at_ms, receiver: sent.receiver, route: null, by, what: "lookup", tool: sent.request, level: "none", counts: sent.points > 0 ? { place: sent.points } : {}, detector: null,
    chars: sent.chars, pictures: 0, key: null, attempt: null,
  };
}

export function lookupWriter(home: RegistryHome, by: string): (sent: googlePlaces.Lookup) => void {
  return (sent) => {
    const ledger = openLedger(home.folder(), { mode: "write" });
    try {
      ledger.outbound.write(lookupRow(by, sent, Date.now()));
    } finally {
      ledger.close();
    }
  };
}

export function lookupsOf(home: RegistryHome, by: string): (since_ms: number) => number {
  return (since_ms) => {
    const ledger = openLedger(home.folder(), { mode: "read" });
    try {
      return ledger.outbound.lookups(by, since_ms);
    } finally {
      ledger.close();
    }
  };
}

function labelerLend(settings: Settings, home: RegistryHome, fed: Fed) {
  const folder = home.root;
  return {
    photos: fed.photos,
    messages: fed.messages,
    unit: settings.unit,
    zone: settings.day.zone,
    blobs: join(folder, "blobs"),
    engine: faceEngine(),
    models: faceModels(folder),
    memo: (version: string) => openMemo(home.folder(), facesMemo(folder, thisMachine().dir), version),
    fetch: join(repoRoot(), "faces", "fetch-models.sh"),
    reference: join(repoRoot(), "faces", "reference"),
    owed: () => readOwed(home.folder(), placesFileOf(folder, thisMachine().dir)),
    rows: () => readGroups(home.folder(), peopleFileOf(folder, thisMachine().dir)),
    hints: bigHints,
  };
}

export function facesSettings(settings: Settings, home: RegistryHome, fed: Fed, work: () => string = workOf(home, "faces")): faces.FacesSettings {
  const connector = faces.connectors[0]!;
  const lent = labelerLend(settings, home, fed);
  return working({ ...connectorSettings(connector, settings.connectors[connector.id]).fields, ...lent }, work) as unknown as faces.FacesSettings;
}

export function placesKey(settings: Pick<Settings, "connectors">): string {
  const connector = googlePlaces.connectors[0]!;
  return connectorSettings(connector, settings.connectors[connector.id]).fields.key as string;
}

export function facesRun(settings: Pick<Settings, "unit" | "sources">, folder: string): boolean {
  return !switchOf(faces.connectors, settings.sources.off).source({ id: `faces:local:${settings.unit}` }) && faces.modelsInstalled(faceModels(folder));
}

export function faceModels(root: string): string {
  return join(root, "tools", "faces", "models", "buffalo_l");
}

export function facesMemo(root: string, machineDir: string): string {
  return join(machineDir, "faces", readHome(root).id, "memo.db");
}

export function emptyFacesWork(home: RegistryHome): void {
  home.folder().emptyWork({ job: "faces-work", plain: workDirectory(home.root, "faces") });
}

export function workIn(home: RegistryHome, plain: string, job: string): () => string {
  let path: string | undefined;
  return () => (path ??= home.folder().work(job, plain).path);
}

function workOf(home: RegistryHome, name: string): () => string {
  return workIn(home, workDirectory(home.root, name), `${name}-work`);
}

function working<T extends object>(fields: T, work: () => string): T & { readonly work: string } {
  return Object.defineProperty(fields, "work", { get: work, enumerable: true }) as T & { readonly work: string };
}

function workDirectory(folder: string, name: string): string {
  return join(folder, "tools", `${name}-work`);
}
