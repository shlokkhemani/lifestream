import { digest, type DaySettings, type Json } from "@lifestreamprotocol/core";
import { MODEL_USES, unfit, unfitWords, USE_IDS, workNeed, type RunnerFile, type UseId } from "@lifestreamprotocol/model";
import type { Pause } from "./jobs.js";
import { runnerUnit } from "./lifecycle.js";
import { CHOOSE_MODEL, connectionOf, foundOf, MENU, modelList, modelsAt, modelsRead, runnerConnection, storedRunnerLine, usable, type ModelsRead, type ReadModel } from "./models-read.js";
import { fileLine, gigabytes, itemUsesOf, opening, runnerPause, savesBattery, WORK_MEMBER, type ModelRoute, type StoredModels, type StoredRunner, type WorkNeeds } from "./models.js";
import { refuse } from "./refusal.js";
import type { AnswerOf, Body, PageAsk, PageHandler } from "./pages.js";
import type { Settings } from "./settings.js";
import { pausedWords, when } from "./stream-words.js";

export type ModelsPage = Body<AnswerOf<"models">>;
export type ModelsFound = Body<AnswerOf<"modelsFind">>;
type Use = ModelsPage["uses"][number];
type Place = Use["places"][number];
type Thinking = NonNullable<Use["thinking"]>;
type Connection = ModelsPage["connections"][number];
type File = Extract<Connection, { kind: "runner" }>["files"][number];

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
  thisMac: "On this Mac",
  on: (name: string) => `On ${name}`,
  connect: (name: string) => `Connect ${name} first`,
  download: (name: string, size: string) => `Download ${name} · ${size}`,
  suggestedFor: (where: string, memory_gb: number) => `suggested for ${where}'s ${memory_gb} GB`,
  needs: (memory_gb: number) => `Needs a Mac with ${memory_gb} GB`,
  saveBattery: "Runs only today's and yesterday's items on battery; the rest wait until it's plugged in.",
  batteryHeld: "On battery · older items wait until it's plugged in",
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

function aboutFile(file: RunnerFile, runner: Pick<StoredRunner, "memory_gb">, suggested: boolean, where: string): string {
  const said = file.output === "vectors" ? [WORDS.finds] : file.output === "marks" ? [WORDS.marks]
    : itemUsesOf({ ...file, leaves: null }).map((kind) => kind === "audio" && file.languages.length > 0 ? `${DOES.audio} in ${languageWords(file.languages)}` : DOES[kind]);
  const fits = runner.memory_gb >= file.memory_gb;
  return [opening(listed(said)), ...suggested && fits ? [WORDS.suggestedFor(where, runner.memory_gb)] : [], ...fits ? [] : [WORDS.needs(file.memory_gb)]].join(" · ");
}

function actsOf(file: RunnerFile, fits: boolean): File["acts"] {
  switch (file.state) {
    case "absent": return fits ? ["fetch"] : [];
    case "fetching": return ["cancel"];
    case "ready": return ["remove"];
    case "failed": return ["fetch"];
  }
}

function pickOf(row: ReadModel, stored: StoredModels): Pick<Place, "line" | "ready"> | null {
  const runner = stored.runners.find((each) => runnerConnection(each.unit) === row.connection);
  const file = runner?.files.find((each) => each.id === row.model);
  if (runner === undefined || file === undefined || file.state === "ready") return null;
  if (runner.memory_gb < file.memory_gb) return { line: WORDS.needs(file.memory_gb), ready: false };
  const held = storedRunnerLine(runner);
  if (held !== null) return { line: held, ready: false };
  return { line: file.state === "absent" ? WORDS.download(file.name, gigabytes(file.bytes)) : row.line, ready: true };
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
      return [{ place: connection.name, value: row.id, line: ready ? null : WORDS.connect(connection.name), ready, leaves: row.leaves !== null }];
    }
    const runner = stored.runners.find((each) => runnerConnection(each.unit) === connection.id)!;
    const pick = pickOf(row, stored) ?? { line: row.state === "ready" ? null : row.line, ready: runner.present && runner.below === null };
    return [{ place: placeOf(runner, here), value: row.id, ...pick, leaves: row.leaves !== null }];
  });
}

function thinkingOf(row: ReadModel | undefined, wanted: string | null): Thinking | null {
  if (row === undefined || row.thinking.length === 0) return null;
  const start = MODEL_USES.chat.fill?.thinking ?? null;
  const suggested = start !== null && row.thinking.includes(start) ? start : row.thinking[0]!;
  const value = wanted !== null && row.thinking.includes(wanted) ? wanted : suggested;
  return {
    value, words: levelWords(value),
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

function runnerOf(runner: StoredRunner, inputs: ModelsInputs, routes: readonly ModelRoute[], here: string): Connection {
  const pause = inputs.pauses.find((each) => each.target === runnerPause(runner.unit));
  const where = runner.unit === here ? "this Mac" : runner.name;
  const suggestedOf = (file: RunnerFile) => routes.some((route) => connectionOf(route) === runnerConnection(runner.unit) && route.model === file.id && route.suggested.length > 0);
  const on = savesBattery(inputs.settings.runners, runner.unit);
  return {
    kind: "runner", id: runnerConnection(runner.unit), unit: runner.unit, place: placeOf(runner, here), name: runner.name,
    line: storedRunnerLine(runner) ?? (pause === undefined ? null : pausedWords(pause.by, null, when(pause.at_ms, inputs.now_ms, inputs.day))),
    files: runner.files.filter((file) => file.detector === undefined).map((file): File => {
      const fits = runner.memory_gb >= file.memory_gb;
      const suggested = suggestedOf(file);
      return {
        id: file.id, name: file.name, about: aboutFile(file, runner, suggested, where), size: gigabytes(file.bytes), state: file.state, line: fileLine(file),
        suggested, fits, acts: actsOf(file, fits),
      };
    }),
    found: [],
    battery: runner.power === null || !runner.present ? null : { on, line: on && runner.power === "battery" ? WORDS.batteryHeld : WORDS.saveBattery },
    paused: pause !== undefined,
  };
}

function connectionsOf(read: ModelsRead, inputs: ModelsInputs, here: string): Connection[] {
  const { stored } = inputs;
  const rows = Object.values(read.models);
  const ready = (id: string) => rows.some((row) => row.connection === id && row.state !== "unavailable");
  const runners = hereFirst(read.connections.filter((each) => each.kind === "runner"), here)
    .map((connection) => runnerOf(stored.runners.find((each) => runnerConnection(each.unit) === connection.id)!, inputs, stored.routes, here));
  const others = read.connections.flatMap((connection): Connection[] => {
    switch (connection.kind) {
      case "runner": return [];
      case "plan": return [{ kind: "plan", id: connection.id, name: connection.name, line: connection.line, signed: ready(connection.id) }];
      case "key": return [{ kind: "key", id: connection.id, name: connection.name, line: connection.line, held: ready(connection.id) }];
      case "address": return [{ kind: "address", id: connection.id, url: inputs.settings.model.transports?.address?.url ?? null, line: connection.line }];
    }
  });
  return [...runners, ...others.filter((each) => each.kind === "plan"), ...others.filter((each) => each.kind === "key"), ...others.filter((each) => each.kind === "address")];
}

export function modelsPage(inputs: ModelsInputs): ModelsPage {
  const { settings } = inputs;
  const read = modelsRead(inputs.stored, modelsAt(settings));
  const here = runnerUnit(settings.unit);
  return {
    uses: USE_IDS.map((use) => useOf(use, read, inputs, here)),
    connections: connectionsOf(read, inputs, here),
  };
}

export interface ModelsReads {
  read(ask: Pick<PageAsk, "now_ms">): { position: string; inputs: ModelsInputs };
}

export function modelsHandler(reads: ModelsReads): PageHandler<AnswerOf<"models">> {
  return {
    params: [],
    open(ask, use) {
      const { position, inputs } = reads.read(ask);
      const body = modelsPage(inputs);
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
  const read = modelsRead(stored, modelsAt(inputs.settings));
  const chosen = work === undefined ? read.uses[use].value : workValueOf(inputs.settings, work.id);
  const offered = stored.routes.filter((route) => usable(route, stored.runners) && (work === undefined || unfit(route, workNeed(work)) === null));
  const found = modelList(foundOf(offered, use, typed), stored.runners, chosen);
  const none = found.rows.length === 0 && found.local === null && typed.trim() !== "" ? MENU.none : null;
  return { placeholder: MENU.search, ...found, none };
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
