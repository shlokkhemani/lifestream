import { digest, type DaySettings, type Json } from "@lifestreamprotocol/core";
import { MODEL_USES, unfit, unfitWords, USE_IDS, workNeed, type RunnerFile, type UseId } from "@lifestreamprotocol/model";
import type { Pause } from "./jobs.js";
import { runnerUnit } from "./lifecycle.js";
import { CHOOSE_MODEL, connectionOf, foundOf, MENU, modelGroups, modelsAt, modelsRead, runnerConnection, storedRunnerLine, usable, type ModelsRead, type ReadModel } from "./models-read.js";
import { fileLine, gigabytes, itemUsesOf, opening, runnerPause, savesBattery, WORK_MEMBER, type ModelRoute, type StoredModels, type StoredRunner, type WorkNeeds } from "./models.js";
import { refuse } from "./refusal.js";
import type { AnswerOf, Body, PageAsk, PageHandler } from "./pages.js";
import type { Settings } from "./settings.js";

export type ModelDefaults = Body<AnswerOf<"modelDefaults">>;
export type ModelProviders = Body<AnswerOf<"modelProviders">>;
export type ModelsFound = Body<AnswerOf<"modelsFind">>;
type Use = ModelDefaults["uses"][number];
type Place = Use["places"][number];
type Thinking = NonNullable<Use["thinking"]>;
type Connection = ModelProviders["connections"][number];
type Runner = Extract<Connection, { kind: "runner" }>;
type File = Runner["files"][number];

export type ModelsSettings = Pick<Settings, "defaults" | "thinking" | "model" | "runners" | "connectors" | "unit">;

export interface ModelsInputs {
  stored: StoredModels;
  settings: ModelsSettings;
  pauses: readonly Pick<Pause, "target" | "by" | "at_ms">[];
  now_ms: number;
  day: DaySettings;
}

export const WORDS = {
  off: MENU.off,
  thinking: "Thinking",
  accounts: "Accounts",
  local: "Local models",
  localOn: (name: string) => `Local models on ${name}`,
  thisMac: "On this Mac",
  on: (name: string) => `On ${name}`,
  connect: (name: string) => `Connect ${name} first`,
  download: (name: string, size: string) => `Download ${name} · ${size}`,
  recommended: "Recommended",
  needs: (memory_gb: number) => `Needs ${memory_gb} GB of memory`,
  run: "Run local models",
  runOff: "Local work waits until you turn this on.",
  saveBattery: "Save battery",
  batteryLine: "On battery, only recent items run.",
  none: "No models on this machine yet.",
  downloaded: "Downloaded",
  fetch: "Download",
  again: "Try again",
  remove: "Remove",
  cancel: "Cancel",
  signed: "Signed in",
  unsigned: "Not signed in",
  keyLine: "Hundreds of models with one key.",
  connected: "Connected",
  keyField: (name: string) => `${name} key`,
  keyPlaceholder: "sk-or-…",
  addKey: "Add key",
  server: "Other server",
  serverAbout: "Any OpenAI-compatible server, like vLLM or another Mac.",
  addServer: "Add server",
  serverField: "Server URL",
  serverPlaceholder: "http://localhost:11434/v1",
  save: "Save",
  finds: "search by meaning",
  marks: "finds personal details to hide",
} as const;

const LEVELS: Readonly<Record<string, string>> = {
  off: "No thinking", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max",
};

const levelWords = (level: string): string => LEVELS[level] ?? level;

const DOES: Readonly<Record<"pictures" | "audio" | "text", string>> = { pictures: "describes photos", audio: "transcribes voice notes", text: "sums up text" };

const NAMED: readonly (readonly [code: string, name: string])[] = [["en", "English"], ["hi", "Hindi"]];

const listed = (words: readonly string[]): string => words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)!}`;

function languageWords(codes: readonly string[]): string {
  const named = NAMED.filter(([code]) => codes.includes(code)).map(([, name]) => name);
  const rest = codes.length - named.length;
  if (rest === 0) return listed(named);
  const counted = `${rest}${named.length === 0 ? "" : " more"} language${rest === 1 ? "" : "s"}`;
  return listed([...named, counted]);
}

function doesOf(file: RunnerFile): string {
  const said = file.output === "vectors" ? [WORDS.finds] : file.output === "marks" ? [WORDS.marks]
    : itemUsesOf({ ...file, leaves: null }).map((kind) => kind === "audio" && file.languages.length > 0 ? `${DOES.audio} in ${languageWords(file.languages)}` : DOES[kind]);
  return opening(listed(said));
}

function fileLineOf(file: RunnerFile, runner: Pick<StoredRunner, "memory_gb" | "left">, recommended: boolean): string {
  if (runner.memory_gb < file.memory_gb) return WORDS.needs(file.memory_gb);
  const said = fileLine(file, runner.left?.[file.id]);
  if (said !== null && file.state !== "absent") return said;
  return [doesOf(file), gigabytes(file.bytes), ...recommended ? [WORDS.recommended] : []].join(" · ");
}

function actsOf(file: RunnerFile, fits: boolean): File["acts"] {
  switch (file.state) {
    case "absent": return fits ? [{ act: "fetch", words: WORDS.fetch }] : [];
    case "fetching": return [{ act: "cancel", words: WORDS.cancel }];
    case "ready": return [{ act: "remove", words: WORDS.remove }];
    case "failed": return [{ act: "fetch", words: WORDS.again }];
  }
}

function pickOf(row: ReadModel, stored: StoredModels): Pick<Place, "line" | "ready" | "working"> | null {
  const runner = stored.runners.find((each) => runnerConnection(each.unit) === row.connection);
  const file = runner?.files.find((each) => each.id === row.model);
  if (runner === undefined || file === undefined || file.state === "ready") return null;
  if (runner.memory_gb < file.memory_gb) return { line: WORDS.needs(file.memory_gb), ready: false, working: false };
  const held = storedRunnerLine(runner);
  if (held !== null) return { line: held, ready: false, working: false };
  if (file.state === "absent") return { line: WORDS.download(file.name, gigabytes(file.bytes)), ready: true, working: false };
  return { line: fileLine(file, runner.left?.[file.id]), ready: true, working: file.state === "fetching" };
}

const placeOf = (runner: Pick<StoredRunner, "unit" | "name">, here: string): string => runner.unit === here ? WORDS.thisMac : WORDS.on(runner.name);

const hereFirst = <T extends { id: string }>(each: readonly T[], here: string): T[] =>
  [...each].sort((a, b) => Number(b.id === runnerConnection(here)) - Number(a.id === runnerConnection(here)));

function placesOf(use: UseId, read: ModelsRead, stored: StoredModels, here: string): Place[] {
  return hereFirst(read.connections.filter((each) => each.kind === "plan" || each.kind === "runner"), here).flatMap((connection): Place[] => {
    const row = read.uses[use].fits.map((id) => read.models[id]!).find((each) => each.connection === connection.id && each.suggested.includes(use));
    if (row === undefined) return [];
    if (connection.kind === "plan") {
      const ready = row.state === "ready";
      return [{ place: connection.name, value: row.id, line: ready ? null : WORDS.connect(connection.name), working: false, ready, leaves: row.leaves !== null }];
    }
    const runner = stored.runners.find((each) => runnerConnection(each.unit) === connection.id)!;
    const pick = pickOf(row, stored) ?? { line: row.state === "ready" ? null : row.line, ready: runner.present && runner.below === null, working: false };
    return [{ place: placeOf(runner, here), value: row.id, ...pick, leaves: row.leaves !== null }];
  });
}

function thinkingOf(row: ReadModel | undefined, wanted: string | null): Thinking | null {
  if (row === undefined || row.thinking.length === 0) return null;
  const start = MODEL_USES.chat.fill?.thinking ?? null;
  const suggested = start !== null && row.thinking.includes(start) ? start : row.thinking[0]!;
  const value = wanted !== null && row.thinking.includes(wanted) ? wanted : suggested;
  return {
    label: WORDS.thinking, value, words: levelWords(value),
    levels: row.thinking.map((level) => ({ value: level, name: levelWords(level), chosen: level === value, suggested: level === suggested })),
  };
}

function misfitOf(route: ModelRoute | undefined, use: UseId): string | null {
  const why = route === undefined || !route.offered ? null : unfit(route, MODEL_USES[use].need);
  return why === null ? null : unfitWords(route!.name, why);
}

function useOf(use: UseId, read: ModelsRead, inputs: ModelsInputs, here: string): Use {
  const { value, menu, thinking } = read.uses[use];
  const chosen = value === null ? undefined : read.models[value];
  const misfit = misfitOf(inputs.stored.routes.find((each) => each.id === value), use);
  return {
    use, label: MODEL_USES[use].label,
    line: misfit ?? (chosen === undefined || chosen.state === "ready" ? null : chosen.line),
    words: value === null ? use === "chat" ? CHOOSE_MODEL : WORDS.off : chosen?.name ?? value,
    value,
    thinking: use === "chat" && value !== null ? thinkingOf(read.models[value], thinking) : null,
    menu,
    places: placesOf(use, read, inputs.stored, here),
  };
}

function runnerOf(runner: StoredRunner, inputs: ModelsInputs, routes: readonly ModelRoute[], label: string): Runner {
  const paused = inputs.pauses.some((each) => each.target === runnerPause(runner.unit));
  const line = storedRunnerLine(runner);
  const away = line !== null;
  const recommended = (file: RunnerFile) => routes.some((route) => connectionOf(route) === runnerConnection(runner.unit) && route.model === file.id && route.suggested.length > 0);
  const files = runner.files.filter((file) => file.detector === undefined).map((file): File => {
    const fits = runner.memory_gb >= file.memory_gb;
    return {
      id: file.id, name: file.name, line: fileLineOf(file, runner, recommended(file)), working: file.state === "fetching", state: file.state, fits,
      words: file.state === "ready" ? WORDS.downloaded : null, acts: away ? [] : actsOf(file, fits),
    };
  });
  const run = away || !(paused || files.some((file) => file.state === "ready")) ? null : { label: WORDS.run, on: !paused, line: paused ? WORDS.runOff : null };
  const on = savesBattery(inputs.settings.runners, runner.unit);
  return {
    kind: "runner", id: runnerConnection(runner.unit), unit: runner.unit, place: label, name: runner.name, line,
    none: files.length === 0 && run === null ? line ?? WORDS.none : null,
    run,
    battery: away || runner.power === null ? null : { label: WORDS.saveBattery, on, line: WORDS.batteryLine },
    files, found: [], paused,
  };
}

function connectionsOf(read: ModelsRead, inputs: ModelsInputs, here: string): Connection[] {
  const { stored } = inputs;
  const rows = Object.values(read.models);
  const ready = (id: string) => rows.some((row) => row.connection === id && row.state !== "unavailable");
  const listedRunners = hereFirst(read.connections.filter((each) => each.kind === "runner"), here);
  const runners = listedRunners.map((connection) => {
    const runner = stored.runners.find((each) => runnerConnection(each.unit) === connection.id)!;
    return runnerOf(runner, inputs, stored.routes, listedRunners.length > 1 ? WORDS.localOn(runner.name) : WORDS.local);
  });
  const others = read.connections.flatMap((connection): Connection[] => {
    switch (connection.kind) {
      case "runner": return [];
      case "plan": {
        const signed = ready(connection.id);
        return [{ kind: "plan", id: connection.id, name: connection.name, line: connection.line, signed, words: signed ? WORDS.signed : WORDS.unsigned }];
      }
      case "key": {
        const held = ready(connection.id);
        return [{
          kind: "key", id: connection.id, name: connection.name, line: held ? connection.line ?? WORDS.keyLine : WORDS.keyLine, held, words: held ? WORDS.connected : null,
          key: { label: WORDS.keyField(connection.name), placeholder: WORDS.keyPlaceholder, add: WORDS.addKey, remove: WORDS.remove },
        }];
      }
      case "address": return [{
        kind: "address", id: connection.id, label: WORDS.server, url: inputs.settings.model.transports?.address?.url ?? null, line: connection.line,
        words: { about: WORDS.serverAbout, add: WORDS.addServer, remove: WORDS.remove, field: WORDS.serverField, placeholder: WORDS.serverPlaceholder, save: WORDS.save },
      }];
    }
  });
  return [...others.filter((each) => each.kind === "plan"), ...others.filter((each) => each.kind === "key"), ...runners, ...others.filter((each) => each.kind === "address")];
}

const readOf = (inputs: ModelsInputs): ModelsRead => modelsRead(inputs.stored, modelsAt(inputs.settings));

export function modelDefaults(inputs: ModelsInputs): ModelDefaults {
  const read = readOf(inputs);
  const here = runnerUnit(inputs.settings.unit);
  return { uses: [...USE_IDS].sort((a, b) => Number(b === "chat") - Number(a === "chat")).map((use) => useOf(use, read, inputs, here)) };
}

export function modelProviders(inputs: ModelsInputs): ModelProviders {
  return { accounts: WORDS.accounts, connections: connectionsOf(readOf(inputs), inputs, runnerUnit(inputs.settings.unit)) };
}

export interface ModelsReads {
  read(ask: Pick<PageAsk, "now_ms">): { position: string; inputs: ModelsInputs };
}

export function modelDefaultsHandler(reads: ModelsReads): PageHandler<AnswerOf<"modelDefaults">> {
  return {
    params: [],
    open(ask, use) {
      const { position, inputs } = reads.read(ask);
      const body = modelDefaults(inputs);
      return use({ position, inputs: [digest(body as unknown as Json)], counting: false, build: () => body });
    },
  };
}

export function modelProvidersHandler(reads: ModelsReads): PageHandler<AnswerOf<"modelProviders">> {
  return {
    params: [],
    open(ask, use) {
      const { position, inputs } = reads.read(ask);
      const body = modelProviders(inputs);
      return use({ position, inputs: [digest(body as unknown as Json)], counting: false, build: () => body });
    },
  };
}

export interface FoundWork extends WorkNeeds {
  id: string;
}

export interface ModelsFindReads extends ModelsReads {
  work(id: string): FoundWork | undefined;
}

export function modelsFound(inputs: ModelsInputs, use: UseId, work: FoundWork | undefined, typed: string): ModelsFound {
  const { stored } = inputs;
  const read = readOf(inputs);
  const chosen = work === undefined ? read.uses[use].value : workValueOf(inputs.settings, work.id);
  const offered = stored.routes.filter((route) => usable(route, stored.runners) && (work === undefined || unfit(route, workNeed(work)) === null));
  const groups = modelGroups(foundOf(offered, use, typed), stored.runners, chosen);
  const none = groups.length === 0 && typed.trim() !== "" ? MENU.none : null;
  return { placeholder: MENU.search, groups, none };
}

function workValueOf(settings: ModelsSettings, work: string): string | null {
  const at = work.lastIndexOf("/");
  const value = settings.connectors[work.slice(0, at)]?.[`${WORK_MEMBER}${work.slice(at + 1)}`];
  return typeof value === "string" ? value : null;
}

export function modelsFindHandler(reads: ModelsFindReads): PageHandler<AnswerOf<"modelsFind">> {
  return {
    params: ["use", "work", "q"],
    open(ask, use) {
      const typed = ask.query.get("q") ?? "";
      const named = ask.query.get("work");
      const work = named === null ? undefined : reads.work(named) ?? refuse(404, "WORK_UNKNOWN", `no stream's work ${named}`);
      const asked = ask.query.get("use");
      if (asked !== null && !USE_IDS.includes(asked as UseId)) refuse(422, "BAD_PARAMETER", `use names one of ${USE_IDS.join(", ")}`);
      if (asked !== null && work !== undefined && asked !== work.kind) refuse(422, "BAD_PARAMETER", `${work.id} is ${work.kind} work, not ${asked}`);
      const of = work?.kind ?? (asked as UseId | null) ?? refuse(422, "BAD_PARAMETER", "use or work names what the model is for");
      const { position, inputs } = reads.read(ask);
      const body = modelsFound(inputs, of, work, typed);
      return use({ position, inputs: [digest(body as unknown as Json)], counting: false, build: () => body });
    },
  };
}
