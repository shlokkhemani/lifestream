import type { DaySettings } from "@lifestreamprotocol/core";
import type { ModelSettings, RunnerFile, WorkKind } from "@lifestreamprotocol/model";
import type { Pause } from "./jobs.js";
import { FILLED, fileLine, gigabytes, itemUsesOf, NO_MODEL, opening, routeWords, runnerLine, runnerPause, savesBattery, type Defaults, type RoutingAt, type StoredModels, type StoredRunner } from "./models.js";
import { pausedWords, when } from "./stream-words.js";
import type { Step } from "./streams-report.js";

export interface ModelsFile {
  id: string;
  name: string;
  about: string;
  state: RunnerFile["state"];
  line: string | null;
  suggested: boolean;
  fits: boolean;
}

export interface ModelsRead {
  defaults: Record<WorkKind, { value: string | null; words: string; steps: Step[] }>;
  runners: { unit: string; name: string; line: string | null; paused: string | null; battery: { on: boolean; held: string | null } | null; files: ModelsFile[] }[];
  openrouter: { connected: boolean };
  address: { url: string; model: string; words: string; takes: string } | null;
}

const TAKES: Readonly<Record<string, string>> = { "pictures,text": "Takes pictures and text", text: "Takes text", pictures: "Takes pictures" };

const DOES: Readonly<Record<WorkKind, string>> = { pictures: "describes photos", audio: "transcribes voice notes", text: "sums up text" };

const FINDS = "search by meaning";

export const UPDATE_RUNNER = "Update this runner";

const fileUses = (file: RunnerFile): WorkKind[] => itemUsesOf({ ...file, leaves: null });

const NAMED: readonly (readonly [code: string, name: string])[] = [["en", "English"], ["hi", "Hindi"]];

const listed = (words: readonly string[]): string => words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)!}`;

function languageWords(codes: readonly string[]): string {
  const named = NAMED.filter(([code]) => codes.includes(code)).map(([, name]) => name);
  const rest = codes.length - named.length;
  if (rest === 0) return listed(named);
  const counted = `${rest}${named.length === 0 ? "" : " more"} language${rest === 1 ? "" : "s"}`;
  return listed([...named, counted]);
}

export interface PausesAt {
  pauses: readonly Pick<Pause, "target" | "by" | "at_ms">[];
  runners: RoutingAt["runners"];
  now_ms: number;
  day: DaySettings;
}

function aboutFile(file: RunnerFile, runner: Pick<StoredRunner, "memory_gb" | "files">): string {
  const kinds = fileUses(file);
  const said = kinds.length === 0 ? [FINDS]
    : kinds.map((kind) => kind === "audio" && file.languages.length > 0 ? `${DOES.audio} in ${languageWords(file.languages)}` : DOES[kind]);
  const fits = (each: Pick<RunnerFile, "memory_gb">) => runner.memory_gb >= each.memory_gb;
  const first = kinds.some((kind) => runner.files.find((each) => fits(each) && fileUses(each).includes(kind)) === file);
  const recommended = fits(file) && first && !runner.files.every(fits);
  const needs = fits(file) ? [] : [`Needs ${file.memory_gb} GB of memory`];
  return [opening(listed(said)), gigabytes(file.bytes), ...recommended ? ["Recommended for this Mac"] : [], ...needs].join(" · ");
}

function runnerRows(runners: readonly StoredRunner[], defaults: Defaults, at: PausesAt): ModelsRead["runners"] {
  const suggested = new Set<string>();
  for (const kind of Object.keys(defaults) as WorkKind[]) {
    if (defaults[kind] !== null) continue;
    for (const runner of runners) {
      const files = runner.files.filter((each) => fileUses(each).includes(kind));
      if (files.some((each) => each.state === "ready")) continue;
      const fetching = files.filter((each) => each.state === "fetching");
      for (const file of fetching.length > 0 ? fetching : files.filter((each) => runner.memory_gb >= each.memory_gb)) suggested.add(`${runner.unit}/${file.id}`);
    }
  }
  const pausedOf = (unit: string): string | null => {
    const pause = at.pauses.find((each) => each.target === runnerPause(unit));
    return pause === undefined ? null : pausedWords(pause.by, null, when(pause.at_ms, at.now_ms, at.day));
  };
  const batteryOf = (runner: StoredRunner): ModelsRead["runners"][number]["battery"] => {
    if (runner.power === null || !runner.present) return null;
    const on = savesBattery(at.runners, runner.unit);
    return { on, held: on && runner.power === "battery" ? BATTERY_HELD : null };
  };
  return runners.map((runner) => ({
    unit: runner.unit, name: runner.name, line: runner.below !== null ? UPDATE_RUNNER : runnerLine(runner), paused: pausedOf(runner.unit), battery: batteryOf(runner),
    files: runner.files.filter((file) => file.detector === undefined).map((file) => ({
      id: file.id, name: file.name, about: aboutFile(file, runner), state: file.state, line: fileLine(file), suggested: suggested.has(`${runner.unit}/${file.id}`),
      fits: runner.memory_gb >= file.memory_gb,
    })),
  }));
}

export const OFF_STEP: Step = { value: "none", words: "Off", note: null };

export const BATTERY_HELD = "On battery · older items wait until it's plugged in";

export function modelsRead(stored: StoredModels, model: ModelSettings, defaults: Defaults, at: PausesAt): ModelsRead {
  const member = (kind: WorkKind): ModelsRead["defaults"][WorkKind] => {
    const value = defaults[kind];
    const route = stored.routes.find((each) => each.id === value);
    const words = route === undefined ? NO_MODEL : routeWords(route);
    const steps = stored.routes.filter((each) => itemUsesOf(each).includes(kind)).map((each) => ({ value: each.id, words: each.name, note: each.state === "ready" ? each.where : each.line }));
    if (FILLED.includes(kind)) return { value, words, steps };
    return value === null ? { value: OFF_STEP.value, words: OFF_STEP.words, steps: [OFF_STEP, ...steps] } : { value, words, steps: [OFF_STEP, ...steps] };
  };
  const address = model.transports?.address;
  return {
    defaults: { pictures: member("pictures"), audio: member("audio"), text: member("text") },
    runners: runnerRows(stored.runners, defaults, at),
    openrouter: stored.openrouter,
    address: address === undefined ? null
      : { url: address.url, model: address.model, words: `${address.model} at ${address.url}`, takes: TAKES[[...address.kinds].sort().join(",")] ?? "" },
  };
}
