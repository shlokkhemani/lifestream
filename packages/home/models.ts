import type { Connector } from "@lifestreamprotocol/connect";
import { addDays, civilDay, dayBounds, type Ask, type AskRow, type DaySettings, type JsonObject, type ReadTables, type SourceRow, type Tx } from "@lifestreamprotocol/core";
import type { Family } from "@lifestreamprotocol/families";
import {
  CLOUD_VOICE, MODEL_USES, OPENROUTER_SECRET, readRouteId, restsOf, routeId, transportsOf, unfit, WORK_KINDS, workNeed, type Abilities, type CallRoute, type ChatEffort, type Found, type Ledger, type ListedModel, type ModelSettings,
  type Rest, type RoutedAsk, type FileFailure, type RunnerFile, type RunnerListing, type RunnersListed, type Sampling, type Transport, type Unavailable, type WorkKind,
} from "@lifestreamprotocol/model";
import { catalogOf } from "./catalog.js";
import type { PrivacySettings } from "@lifestreamprotocol/privacy";
import { sentLevel } from "./copies.js";
import { askingFamilies, planAgain } from "./prompts.js";
import { wantedOn } from "./runners.js";
import { when } from "./stream-words.js";

export const ROUTE_ID = /^[a-z][a-z0-9-]*:.+$/u;
export const WORK_MEMBER = "llm.";
export const RANGE_MEMBER = "llm.range";
const READ_EVERY_MS = 30_000;
const FETCHING_EVERY_MS = 2_000;
export const SINCE = "llm:since";
export const MODELS_META = "llm:models";
const HIDING_UNDER = "llm:hiding";
type HidingUnder = Record<string, [route: string | null, leaves: string | null, level: string]>;
const BACK_DAYS = 30;
const BATTERY_DAYS = 2;

export interface RouteRequest {
  effort: string;
  sampling: Sampling | null;
  timeout_ms: number;
}

export type ModelRoute = Abilities & {
  id: string;
  transport: string;
  model: string;
  name: string;
  chat: Transport["chat"];
  offered: boolean;
  runner: { unit: string; name: string; battery: boolean } | null;
  leaves: string | null;
  where: string | null;
  cost: Transport["cost"] | null;
  request: RouteRequest | null;
} & (
  | { state: "ready"; line: null }
  | { state: "waiting" | "unavailable"; line: string }
);

export type Defaults = Readonly<Record<WorkKind, string | null>>;

export const FILLED: readonly WorkKind[] = ["text"];

export interface WorkRouting {
  kind: WorkKind;
  text_chars: number | null;
  value: string;
  route: string | null;
  suggests: string | null;
  start_ms: number | null;
  power_ms: number | null;
  as_is?: true;
}

export interface Routing {
  routes: Readonly<Record<string, ModelRoute>>;
  works: Readonly<Record<string, WorkRouting>>;
}

export type Serving = { route: ModelRoute } | { none: "off" | "older" | "power" | "needs" | "unknown" };

export interface RoutingAt {
  connectors: readonly Connector[];
  blocks: Readonly<Record<string, JsonObject>>;
  defaults: Defaults;
  runners: Readonly<Record<string, { save_battery?: boolean }>>;
  now_ms: number;
  day: DaySettings;
}

export function savesBattery(runners: RoutingAt["runners"], unit: string): boolean {
  return runners[unit]?.save_battery !== false;
}

export interface RoutingInput extends RoutingAt {
  routes: readonly ModelRoute[];
  names?: ReadonlyMap<string, string>;
  chosen: readonly string[];
  sources: readonly Pick<SourceRow, "id" | "connector" | "options" | "added_ms">[];
  since: string;
  listed?: readonly Pick<StoredRunner, "unit" | "present" | "files">[];
}

export function workId(connector: string, work: string): string {
  return `${connector}/${work}`;
}

export interface WorkNeeds {
  kind: WorkKind;
  text_chars?: number | null | undefined;
}

export function itemUsesOf(model: Abilities & { leaves: string | null }): WorkKind[] {
  return WORK_KINDS.filter((kind) => unfit(model, MODEL_USES[kind].need) === null);
}

export function routingOf(input: RoutingInput): Routing {
  const routes: Record<string, ModelRoute> = Object.fromEntries(input.routes.map((route) => [route.id, route]));
  const named = (id: string | null): string | null => {
    if (id !== null && routes[id] === undefined && ROUTE_ID.test(id)) routes[id] = unoffered(id, input.names?.get(id));
    return id;
  };
  for (const kind of Object.keys(input.defaults) as WorkKind[]) named(input.defaults[kind]);
  for (const id of input.chosen) named(id);
  const setUp = setUpOf(input.connectors, input.sources);
  const today = civilDay(input.now_ms, input.day);
  const battery_ms = dayBounds(addDays(today, 1 - BATTERY_DAYS), input.day).start_ms;
  const serves = (id: string | null, work: WorkNeeds): id is string => {
    const route = id === null ? undefined : routes[id];
    return route !== undefined && (!route.offered || unfit(route, workNeed(work)) === null);
  };
  const works: Record<string, WorkRouting> = {};
  for (const connector of input.connectors) {
    const block = input.blocks[connector.id];
    const start_ms = rangeStart(block, setUp.get(connector.id) ?? null, input.since, today, input.day);
    for (const [name, work] of Object.entries(connector.processing ?? {})) {
      const value = workValue(block, name);
      const id = named(value === "off" ? null : value === "default" ? (work.prefers === undefined ? input.defaults[work.kind] : preferred(work.prefers, input.listed ?? [], routes)) : value);
      const route = serves(id, work) ? id : null;
      const fallback = input.defaults[work.kind];
      works[workId(connector.id, name)] = {
        kind: work.kind, text_chars: work.text_chars ?? null, value, route,
        suggests: route ?? (serves(fallback, work) ? fallback : null), start_ms,
        power_ms: route !== null && heldByBattery(routes[route]!.runner, input.runners) ? battery_ms : null,
        ...(work.as_is === true ? { as_is: true as const } : {}),
      };
    }
  }
  return { routes, works };
}

function preferred(file: string, listed: readonly Pick<StoredRunner, "unit" | "present" | "files">[], routes: Readonly<Record<string, ModelRoute>>): string | null {
  const installed = listed.filter((runner) => runner.files.some((each) => each.id === file && each.state === "ready"))
    .sort((a, b) => Number(b.present) - Number(a.present) || (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
  if (installed.length > 0) return routeId({ transport: "runner", runner: installed[0]!.unit, model: file });
  const cloud = routes[routeId(CLOUD_VOICE)];
  return cloud !== undefined && cloud.offered && !(cloud.state === "unavailable") ? cloud.id : null;
}

function heldByBattery(runner: ModelRoute["runner"], runners: RoutingAt["runners"]): boolean {
  return runner !== null && runner.battery && savesBattery(runners, runner.unit);
}

export function serving(routing: Routing, ask: { work_id: string | null; chosen: string | null; at_key: number }): Serving {
  const work = ask.work_id === null ? undefined : routing.works[ask.work_id];
  if (work === undefined) return { none: "unknown" };
  if (ask.chosen !== null) {
    const route = routing.routes[ask.chosen];
    if (route === undefined) return { none: "unknown" };
    return route.offered && unfit(route, workNeed(work)) !== null ? { none: "needs" } : { route };
  }
  if (work.value === "off") return { none: "off" };
  if (work.start_ms !== null && ask.at_key < work.start_ms) return { none: "older" };
  const route = work.route === null ? undefined : routing.routes[work.route];
  if (route === undefined) return { none: "needs" };
  if (work.power_ms !== null && ask.at_key < work.power_ms) return { none: "power" };
  return { route };
}

export function sendingBy(routing: Routing, ask: { work_id: string | null; chosen: string | null; at_key: number }, picked: string): ReadyRoute | null {
  const now = serving(routing, ask);
  return "route" in now && now.route.id === picked && isReady(now.route) ? now.route : null;
}

export type ReadyRoute = ModelRoute & { request: RouteRequest };
const isReady = (route: ModelRoute): route is ReadyRoute => route.state === "ready" && route.request !== null;

export function routed(ask: Ask, route: Pick<ModelRoute, "transport" | "model" | "runner"> & { request: RouteRequest }): { ask: RoutedAsk; call: CallRoute } {
  const { effort, sampling, timeout_ms } = route.request;
  return {
    ask: { ...ask, model: route.model, effort: ask.needs?.effort ?? effort, ...(sampling === null ? {} : { sampling }) },
    call: { transport: route.transport, ...(route.runner === null ? {} : { runner: route.runner.unit }), timeout_ms: ask.needs?.timeout_ms ?? timeout_ms },
  };
}

export type RoutingTables = Pick<ReadTables, "meta" | "sources" | "itemRoutes">;

export type HeldRunner = RunnerListing & { below: string | null };

export type StoredRunner = Pick<HeldRunner, "unit" | "name" | "present" | "power" | "memory_gb" | "files" | "below">;

export const UNNAMED_RUNNER = "A runner";

export interface StoredModels {
  routes: ModelRoute[];
  runners: StoredRunner[];
  openrouter: { connected: boolean };
}

export function storedModels(meta: ReadTables["meta"]): StoredModels {
  const value = meta.get(MODELS_META);
  return value === undefined ? { routes: [], runners: [], openrouter: { connected: false } } : JSON.parse(value) as StoredModels;
}

export function readRouting(tables: RoutingTables, at: RoutingAt, live?: { routes: readonly ModelRoute[]; names: ReadonlyMap<string, string>; listed: readonly StoredRunner[] }): Routing {
  const stored = live === undefined ? storedModels(tables.meta) : undefined;
  return routingOf({
    ...at, routes: live?.routes ?? stored!.routes, ...(live === undefined ? {} : { names: live.names }), listed: live?.listed ?? stored!.runners,
    chosen: tables.itemRoutes.list().map((choice) => choice.route), sources: tables.sources.list(), since: tables.meta.get(SINCE) ?? civilDay(at.now_ms, at.day),
  });
}

function workValue(block: JsonObject | undefined, work: string): string {
  const value = block?.[`${WORK_MEMBER}${work}`];
  return typeof value === "string" && (value === "default" || value === "off" || ROUTE_ID.test(value)) ? value : "default";
}

function rangeStart(block: JsonObject | undefined, set_up_ms: number | null, since: string, today: string, day: DaySettings): number | null {
  const range = block?.[RANGE_MEMBER];
  if (range === "all") return null;
  if (typeof range === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(range)) return dayBounds(range, day).start_ms;
  const setUp = set_up_ms === null ? today : civilDay(set_up_ms, day);
  return dayBounds(addDays(setUp > since ? setUp : since, -BACK_DAYS), day).start_ms;
}

export function heldBy<Row extends RoutingInput["sources"][number]>(connectors: readonly Connector[], sources: readonly Row[]): Map<string, Row[]> {
  const catalog = catalogOf(connectors);
  const held = new Map<string, Row[]>();
  for (const source of sources) {
    const id = catalog.of(source)?.id;
    if (id !== undefined) held.set(id, [...held.get(id) ?? [], source]);
  }
  return held;
}

function setUpOf(connectors: readonly Connector[], sources: RoutingInput["sources"]): Map<string, number> {
  return new Map([...heldBy(connectors, sources)].map(([id, held]) => [id, Math.min(...held.map((source) => source.added_ms))]));
}

function unoffered(id: string, last: string | undefined): ModelRoute {
  const read = readRouteId(id) ?? { transport: id.slice(0, id.indexOf(":")), model: id.slice(id.indexOf(":") + 1) };
  const name = last ?? read.model.slice(read.model.lastIndexOf("/") + 1);
  return {
    id, transport: read.transport, model: read.model, name, input: [], output: "text", tools: false, context_tokens: null, thinking: [], chat: null, offered: false, runner: null, leaves: null, where: null,
    cost: null, request: null, state: "unavailable", line: `${name} isn't offered now`,
  };
}


export const opening = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1);

export const NO_MODEL = "No model yet";

export function routeWords(route: Pick<ModelRoute, "name" | "leaves" | "runner" | "offered">): string {
  return route.offered ? `${route.name} · ${route.leaves ?? route.runner?.name ?? "This computer"}` : route.name;
}

function unavailableWords(provider: string, reason: Unavailable): string {
  switch (reason) {
    case "signed_out": return `Sign in to ${provider} again`;
    case "no_key": return `Add the key for ${provider}`;
    case "no_program": return `${opening(provider)} isn't set up on this Mac yet`;
    case "unusable": return `${opening(provider)} can't run on this Mac`;
    case "away": return `${opening(provider)} isn't available`;
  }
}

function restWords(read: TransportRead, runner: ModelRoute["runner"], rest: Rest, now_ms: number, day: DaySettings): string {
  const who = runner === null ? read.provider : `${runner.name}'s runner`;
  if (rest.cause === "unavailable") return `${opening(who)} isn't available for now`;
  if (rest.cause === "provider") return `Waiting for ${who}`;
  const met = read.cost === "plan" ? `Your ${read.provider} plan is used up` : `${opening(read.provider)} is at its limit`;
  return rest.resets_ms === null ? `${met} for now` : `${met} · resets ${when(rest.resets_ms, now_ms, day)}`;
}

export const AS_IS_WHERE = "Sent as it is";

export function placeOf(route: Pick<ModelRoute, "where" | "leaves">, work: Pick<WorkRouting, "as_is"> | undefined): string | null {
  return work?.as_is === true && route.leaves !== null ? AS_IS_WHERE : route.where;
}

function whereWords(leaves: string | null, runner: ModelRoute["runner"]): string {
  return leaves !== null ? `Sent to ${leaves}` : `Stays on ${runner?.name ?? "this computer"}`;
}

export function runnerLine(runner: Pick<RunnerListing, "name" | "present">): string | null {
  return runner.present ? null : `${runner.name}'s runner is not running`;
}

export const runnerPause = (unit: string): string => `runner:${unit}`;

function pausedRunners(controls: readonly { target: string }[]): Set<string> {
  const prefix = runnerPause("");
  return new Set(controls.filter((each) => each.target.startsWith(prefix)).map((each) => each.target.slice(prefix.length)));
}

const FAILURE_WORDS: Readonly<Record<FileFailure, string>> = {
  offline: "Couldn't download: no internet",
  refused: "Couldn't download: the server refused it",
  hash: "The download was damaged",
  full: "Not enough disk space",
  disk: "Couldn't save the download",
  untrusted: "Couldn't verify the download",
  failed: "Couldn't download",
};

export function fileLine(file: Pick<RunnerFile, "state" | "bytes" | "fetched_bytes" | "failure">): string | null {
  switch (file.state) {
    case "ready": return null;
    case "absent": return "Not downloaded";
    case "fetching": return `Downloading, ${gigabytes(file.fetched_bytes, false)} of ${gigabytes(file.bytes)}`;
    case "failed": return FAILURE_WORDS[file.failure ?? "failed"];
  }
}

export function gigabytes(bytes: number, unit = true): string {
  const rounded = Math.round(bytes / 1e8) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}${unit ? " GB" : ""}`;
}

interface TransportRead {
  name: string;
  provider: string;
  cost: Transport["cost"];
  leaves: string | null;
  defaults: Transport["defaults"];
  available: Awaited<ReturnType<Transport["available"]>>;
  chat: Transport["chat"];
  models: ListedModel[];
}

function offeredRoute(read: TransportRead, offer: ListedModel, runners: readonly RunnerListing[], resting: ReadonlyMap<string, Rest>, paused: ReadonlySet<string>, now_ms: number, day: DaySettings): ModelRoute {
  const runner = offer.runner ?? null;
  const on = restsOf({ transport: read.name, model: offer.model, runner: runner?.unit });
  let rest: Rest | null = null;
  for (const key of [on.transport, on.runner, on.route]) {
    const each = key === null ? undefined : resting.get(key);
    if (each !== undefined && (rest === null || each.until_ms > rest.until_ms)) rest = each;
  }
  const route = {
    id: on.route, transport: read.name, model: offer.model, name: offer.name, input: offer.input, output: offer.output, tools: offer.tools,
    context_tokens: offer.context_tokens, thinking: offer.thinking, chat: read.chat, offered: true, runner,
    leaves: read.leaves, where: whereWords(read.leaves, runner), cost: read.cost,
    request: { effort: read.defaults.effort, sampling: read.defaults.sampling ?? null, timeout_ms: read.defaults.timeout_ms },
  };
  if (!read.available.ok) return { ...route, state: read.available.until_ms === undefined ? "unavailable" : "waiting", line: unavailableWords(read.provider, read.available.reason) };
  if (!offer.ready) {
    const listed = runner === null ? undefined : runners.find((each) => each.unit === runner.unit);
    const file = listed?.files.find((each) => each.id === offer.model);
    if (listed !== undefined && !listed.present) return { ...route, state: "waiting", line: runnerLine(listed)! };
    return { ...route, state: "unavailable", line: (file === undefined ? null : fileLine(file)) ?? `${offer.name} isn't ready` };
  }
  if (runner !== null && paused.has(runner.unit)) return { ...route, state: "waiting", line: "Paused" };
  if (rest !== null) return { ...route, state: "waiting", line: restWords(read, runner, rest, now_ms, day) };
  return { ...route, state: "ready", line: null };
}


export type ModelReach =
  | { url: string; headers: Record<string, string>; effort: ChatEffort; model: string; leaves: string | null }
  | { refused: "NO_MODEL" }
  | { refused: "NOT_READY"; line: string };

export const RUNNER_CHAT_LATER = "Chat can't use a runner's models yet";

export interface ModelsOptions {
  settings(): {
    model: ModelSettings; defaults: Defaults; connectors: Readonly<Record<string, JsonObject>>; runners: Readonly<Record<string, { files?: readonly string[]; save_battery?: boolean }>>;
    privacy: PrivacySettings;
    search: { meaning: string; model: string };
  };
  registry(): { connectors: readonly Connector[]; families: readonly Family[] };
  ledger: Pick<Ledger, "resting">;
  found(): Omit<Found, "runners" | "secret">;
  runners(): Promise<RunnersListed>;
  paired(): ReadonlySet<string>;
  clock(): number;
  day(): DaySettings;
  unset(): readonly WorkKind[];
  fill(taken: Partial<Record<WorkKind, string>>): void;
}

export class Models {
  #reads: TransportRead[] = [];
  #runners: readonly HeldRunner[] = [];
  #held = false;
  #read_ms = -Infinity;
  #reading: Promise<void> | null = null;
  readonly #names = new Map<string, string>();
  #stored: string | null = null;
  #said: string | null = null;
  #served: Map<string, string | null> | null = null;
  #hiding: HidingUnder | null = null;

  constructor(private readonly options: ModelsOptions) {}

  list(paused: ReadonlySet<string>): ModelRoute[] {
    const now = this.options.clock();
    const resting = this.options.ledger.resting(now);
    return this.#reads.flatMap((read) => read.models.map((offer) => offeredRoute(read, offer, this.#runners, resting, paused, now, this.options.day())));
  }

  reach(tx: { readonly tables: Pick<ReadTables, "controls"> }, id: string, secret: (name: string) => string | undefined): ModelReach {
    const route = this.list(pausedRunners(tx.tables.controls.list())).find((each) => each.id === id);
    if (route === undefined || route.chat !== "door") return { refused: "NO_MODEL" };
    if (route.state !== "ready") return { refused: "NOT_READY", line: route.line };
    if (route.runner !== null) return { refused: "NOT_READY", line: RUNNER_CHAT_LATER };
    const found: Found = { ...this.options.found(), runners: this.#runners, secret };
    const reach = transportsOf(this.options.settings().model.transports, found).find((each) => each.name === route.transport)?.reach?.(route.model);
    if (reach === undefined || !("url" in reach)) return { refused: "NO_MODEL" };
    return { url: reach.url, headers: reach.headers, effort: reach.effort, model: route.model, leaves: route.leaves };
  }

  concurrency(transport: string): number {
    return this.#reads.find((read) => read.name === transport)?.defaults.concurrency ?? 0;
  }

  fileReady(unit: string, file: string): boolean {
    return this.#runners.some((runner) => runner.unit === unit && runner.present && runner.files.some((each) => each.id === file && each.state === "ready"));
  }

  due(now: number): boolean {
    const settings = this.options.settings();
    const coming = this.#runners.some((runner) => runner.present && runner.files.some((file) =>
      file.state === "fetching" || (file.state === "absent" && wantedOn(settings, runner).includes(file.id))));
    return this.#reading === null && now - this.#read_ms >= (coming ? FETCHING_EVERY_MS : READ_EVERY_MS);
  }

  poke(): void {
    this.#read_ms = -Infinity;
  }

  read(): Promise<void> {
    this.#reading ??= this.#read().finally(() => { this.#reading = null; });
    return this.#reading;
  }

  async #read(): Promise<void> {
    const { model } = this.options.settings();
    const { runners: listed, below } = await this.options.runners().catch((): RunnersListed => ({ runners: [], below: [] }));
    const reported = new Set(listed.map((runner) => runner.unit));
    const belowOf = new Map(below.map((each) => [each.unit, each.version]));
    const held = new Set(this.#runners.map((runner) => runner.unit));
    const paired = this.options.paired();
    const runners: HeldRunner[] = [
      ...listed.map((runner) => ({ ...runner, below: belowOf.get(runner.unit) ?? null })),
      ...this.#runners.filter((runner) => !reported.has(runner.unit) && (paired.has(runner.unit) || belowOf.has(runner.unit)))
        .map((runner) => notRunning({ ...runner, below: belowOf.get(runner.unit) ?? null })),
      ...below.filter((each) => !reported.has(each.unit) && !held.has(each.unit))
        .map((each) => notRunning({ unit: each.unit, name: UNNAMED_RUNNER, present: false, power: null, memory_gb: 0, files: [], below: each.version })),
    ];
    const found: Found = { ...this.options.found(), runners };
    this.#reads = await Promise.all(transportsOf(model.transports, found).map(async (transport): Promise<TransportRead> => {
      const [available, models] = await Promise.all([
        transport.available().catch((error: unknown) => ({ ok: false as const, reason: "away" as const, detail: error instanceof Error ? error.message : String(error) })),
        transport.models().catch((): ListedModel[] => []),
      ]);
      const { name } = transport;
      const narrowed = (model.transports as Record<string, { concurrency?: number } | undefined> | undefined)?.[name]?.concurrency;
      const defaults = narrowed === undefined ? transport.defaults : { ...transport.defaults, concurrency: Math.min(narrowed, transport.defaults.concurrency) };
      return { name, provider: transport.provider, cost: transport.cost, leaves: transport.leaves, chat: transport.chat, defaults, available, models };
    }));
    this.#runners = runners;
    this.#held = found.held?.(OPENROUTER_SECRET) === true;
    this.#read_ms = this.options.clock();
    const ready = this.list(new Set()).filter((route) => route.state === "ready");
    const taken: Partial<Record<WorkKind, string>> = {};
    for (const kind of this.options.unset().filter((each) => FILLED.includes(each))) {
      const route = ready.find((each) => unfit(each, workNeed({ kind })) === null);
      if (route !== undefined) taken[kind] = route.id;
    }
    if (Object.keys(taken).length > 0) this.options.fill(taken);
  }

  start(tx: Tx): void {
    const stored = storedModels(tx.tables.meta);
    if (this.#reads.length === 0) this.#runners = stored.runners.map(notRunning);
    for (const route of stored.routes) if (!this.#names.has(route.id)) this.#names.set(route.id, route.name);
    if (tx.tables.meta.get(SINCE) !== undefined) return;
    tx.tables.meta.set(SINCE, civilDay(this.options.clock(), this.options.day()));
    planAgain(tx, askingFamilies(this.options.registry().families));
  }

  routing(tx: { readonly tables: RoutingTables & Pick<ReadTables, "controls"> }): Routing {
    const settings = this.options.settings();
    return readRouting(tx.tables, {
      connectors: this.options.registry().connectors, blocks: settings.connectors, defaults: settings.defaults, runners: settings.runners, now_ms: this.options.clock(), day: this.options.day(),
    }, { routes: this.list(pausedRunners(tx.tables.controls.list())), names: this.#names, listed: this.#runners });
  }

  tick(tx: Tx): Routing {
    const routing = this.routing(tx);
    if (this.#reads.length === 0) return routing;
    for (const route of Object.values(routing.routes)) if (route.offered) this.#names.set(route.id, route.name);
    const runners = this.#runners.map(({ unit, name, present, power, memory_gb, files, below }): StoredRunner => ({ unit, name, present, power, memory_gb, files, below }));
    const stored = JSON.stringify({ routes: Object.values(routing.routes), runners, openrouter: { connected: this.#held } } satisfies StoredModels);
    if (stored !== this.#stored) {
      if (tx.tables.meta.get(MODELS_META) !== stored) tx.tables.meta.set(MODELS_META, stored);
      this.#stored = stored;
    }
    const settings = this.options.settings();
    const said = JSON.stringify({ stored, defaults: settings.defaults, runners: settings.runners, address: settings.model.transports?.address ?? null });
    if (said !== this.#said) {
      if (this.#said !== null) tx.tables.events.append({ at_ms: this.options.clock(), kind: "models", key: "models" });
      this.#said = said;
    }
    const served = new Map(Object.entries(routing.works).map(([work, each]) => [work, each.route]));
    for (const [work, route] of served) {
      if (this.#served !== null && this.#served.get(work) === route) continue;
      for (const row of tx.tables.asks.givenUp(work)) reopened(tx, routing, row);
    }
    this.#served = served;
    const connectors = this.options.registry().connectors;
    const hiding: HidingUnder = Object.fromEntries([...served].map(([work, route]) => [work, [route, route === null ? null : (routing.routes[route]?.leaves ?? null), sentLevel(settings, connectors, work)]]));
    const before = this.#hiding ?? JSON.parse(tx.tables.meta.get(HIDING_UNDER) ?? "null") as HidingUnder | null;
    for (const [work, under] of Object.entries(hiding)) {
      if (before !== null && JSON.stringify(before[work]) === JSON.stringify(under)) continue;
      for (const { family, unit } of tx.tables.asks.hideable(work)) tx.tables.dirty.units(family, [unit]);
    }
    if (JSON.stringify(before) !== JSON.stringify(hiding)) tx.tables.meta.set(HIDING_UNDER, JSON.stringify(hiding));
    this.#hiding = hiding;
    return routing;
  }
}

function notRunning(runner: StoredRunner): HeldRunner {
  return { ...runner, present: false, version: "", boot: "", slots: 0, power: null, idle_s: null, thermal: null, running: [] };
}

function reopened(tx: Tx, routing: Routing, row: AskRow): void {
  if (tx.tables.itemRoutes.get(row.family, row.item, row.prompt) !== undefined) return;
  const now = serving(routing, { work_id: row.work_id, chosen: null, at_key: row.at_key });
  if (!("route" in now) || now.route.id === row.given_up) return;
  if (tx.tables.asks.reopen(row.family, row.item, row.prompt)) tx.tables.dirty.units(row.family, [row.unit]);
}
