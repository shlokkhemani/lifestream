import type { JsonObject } from "@lifestreamprotocol/core";
import { MODEL_USES, readRouteId, unfit, USE_IDS, type Input, type Transport, type UseId } from "@lifestreamprotocol/model";
import { ADDRESS, ROUTE_ID, runnerLine, WORK_MEMBER, type ModelRoute, type StoredModels, type StoredRunner } from "./models.js";
import { MODELS_FOUND, type ModelLocal, type ModelMenu, type ModelRow } from "./pages.js";
import { chosenFor, type Settings, type UseDefaults } from "./settings.js";
import type { Step } from "./streams-report.js";

export interface ConnectionRead {
  id: string;
  kind: "plan" | "key" | "runner" | "address";
  name: string;
  line: string | null;
}

export interface UseRead {
  value: string | null;
  thinking: string | null;
  fits: string[];
  menu: ModelMenu;
}

export interface ReadModel {
  id: string;
  connection: string;
  model: string;
  name: string;
  input: readonly Input[];
  tools: boolean;
  thinking: readonly string[];
  context_tokens: number | null;
  chat: Transport["chat"];
  suggested: readonly UseId[];
  group: string;
  leaves: string | null;
  state: "ready" | "waiting" | "unavailable";
  line: string | null;
}

export interface ModelsRead {
  connections: ConnectionRead[];
  uses: Record<UseId, UseRead>;
  models: Record<string, ReadModel>;
}

export interface ModelsAt {
  defaults: UseDefaults;
  thinking: { chat: string | null };
  address: { url: string } | undefined;
  blocks: Readonly<Record<string, JsonObject>>;
  chat?: string;
}

export const MENU = {
  local: "Local",
  more: "More",
  search: "Search",
  none: "No matches",
  off: "Off",
  default: (name: string | null) => `Default · ${name ?? "None"}`,
} as const;

export const CHOOSE_MODEL = "Choose a model";

export function modelsAt(settings: Pick<Settings, "defaults" | "thinking" | "model" | "connectors">): ModelsAt {
  return { defaults: settings.defaults, thinking: settings.thinking, address: settings.model.transports?.address, blocks: settings.connectors };
}

export const UPDATE_RUNNER = "Update this runner";

export const ADDRESS_WINDOW = `Chat needs the server to run a context window of ${MODEL_USES.chat.need.context_tokens!.toLocaleString("en-US")} tokens or more`;

export const OFF_STEP: Step = { value: "none", words: MENU.off, note: null };

const NAMES: Readonly<Record<string, string>> = { claude: "Claude", codex: "ChatGPT", openrouter: "OpenRouter", [ADDRESS]: "Custom address" };

export const runnerConnection = (unit: string): string => `runner:${unit}`;

const unitOf = (route: Pick<ModelRoute, "id" | "runner">): string | undefined => route.runner?.unit ?? readRouteId(route.id)?.runner;

export function connectionOf(route: Pick<ModelRoute, "id" | "transport" | "runner">): string {
  const unit = unitOf(route);
  return unit === undefined ? route.transport : runnerConnection(unit);
}

export function storedRunnerLine(runner: Pick<StoredRunner, "name" | "present" | "below">): string | null {
  return runner.below !== null ? UPDATE_RUNNER : runnerLine(runner);
}

function kindOf(route: Pick<ModelRoute, "transport" | "cost">): ConnectionRead["kind"] {
  if (route.transport === ADDRESS) return "address";
  return route.cost === "plan" ? "plan" : "key";
}

function sharedLine(rows: readonly Pick<ModelRoute, "line">[]): string | null {
  const lines = new Set(rows.map((row) => row.line));
  return lines.size === 1 ? [...lines][0]! : null;
}

function connectionsOf(stored: StoredModels, offered: readonly ModelRoute[], at: ModelsAt): ConnectionRead[] {
  const runners = stored.runners.map((runner): ConnectionRead => ({ id: runnerConnection(runner.unit), kind: "runner", name: runner.name, line: storedRunnerLine(runner) }));
  const others = new Map<string, ModelRoute[]>();
  for (const route of offered) if (route.runner === null) others.set(route.transport, [...others.get(route.transport) ?? [], route]);
  const listed = [...others].map(([transport, rows]): ConnectionRead => ({
    id: transport, kind: kindOf(rows[0]!), name: NAMES[transport] ?? transport, line: sharedLine(rows) ?? (transport === ADDRESS ? ADDRESS_WINDOW : null),
  }));
  const address = others.has(ADDRESS) ? [] : [{ id: ADDRESS, kind: "address" as const, name: NAMES[ADDRESS]!, line: at.address === undefined ? null : ADDRESS_WINDOW }];
  return [...runners, ...listed, ...address];
}

function accountOf(route: Pick<ModelRoute, "id" | "transport" | "runner">, runners: readonly Pick<StoredRunner, "unit" | "name">[]): string {
  const unit = unitOf(route);
  return unit === undefined ? NAMES[route.transport] ?? route.transport : route.runner?.name ?? runners.find((each) => each.unit === unit)?.name ?? unit;
}

function rowOf(route: ModelRoute, stored: StoredModels): ReadModel {
  return {
    id: route.id, connection: connectionOf(route), model: route.model, name: route.name, input: route.input, tools: route.tools, thinking: route.thinking,
    context_tokens: route.context_tokens, chat: route.chat, suggested: route.suggested, group: accountOf(route, stored.runners), leaves: route.leaves, state: route.state, line: route.line,
  };
}

const isLocal = (route: Pick<ModelRoute, "id" | "transport" | "runner">): boolean => route.transport === ADDRESS || unitOf(route) !== undefined;

export function usable(route: ModelRoute, runners: readonly StoredRunner[]): boolean {
  if (!route.offered) return false;
  if (route.state === "ready") return true;
  const runner = runners.find((each) => runnerConnection(each.unit) === connectionOf(route));
  const file = runner?.files.find((each) => each.id === route.model);
  return runner !== undefined && file !== undefined && file.state !== "ready" && runner.memory_gb >= file.memory_gb && storedRunnerLine(runner) === null;
}

export const callable = (route: Pick<ModelRoute, "chat">, use: UseId): boolean => use !== "chat" || route.chat !== null;

export function modelList(routes: readonly ModelRoute[], runners: readonly StoredRunner[], chosen: string | null): { rows: ModelRow[]; local: ModelLocal | null } {
  const shown = routes.filter((route) => usable(route, runners));
  const twice = new Set(shown.map((route) => route.name).filter((name, at, names) => names.indexOf(name) !== at));
  const rowOf = (route: ModelRoute): ModelRow => ({ value: route.id, name: route.name, account: twice.has(route.name) ? accountOf(route, runners) : null, chosen: route.id === chosen });
  const local = shown.filter(isLocal).map(rowOf);
  return { rows: shown.filter((route) => !isLocal(route)).map(rowOf), local: local.length === 0 ? null : { label: MENU.local, rows: local } };
}

export interface MenuOf {
  use: UseId;
  work: string | null;
  chosen: string | null;
  defaulted?: { value: string; name: string | null };
  off: string | null;
}

const endRow = (value: string, name: string, chosen: string | null): ModelRow => ({ value, name, account: null, chosen: value === chosen });

export function modelMenu(routes: readonly ModelRoute[], runners: readonly StoredRunner[], menu: MenuOf): ModelMenu {
  const { use, work, chosen, defaulted, off } = menu;
  return {
    default: defaulted === undefined ? null : endRow(defaulted.value, MENU.default(defaulted.name), chosen),
    ...modelList(routes.filter((route) => callable(route, use)), runners, chosen),
    more: { words: MENU.more, use, work },
    off: off === null ? null : endRow(off, MENU.off, chosen),
  };
}

export function fitsOf(offered: readonly ModelRoute[], use: UseId): string[] {
  const fit = offered.filter((route) => unfit(route, MODEL_USES[use].need) === null);
  return [...fit.filter((route) => route.suggested.includes(use)), ...fit.filter((route) => !route.suggested.includes(use))].map((route) => route.id);
}

export function inUseOf(at: { defaults: Readonly<Record<string, string | null>>; blocks: ModelsAt["blocks"] }): Set<string> {
  const picks = Object.values(at.blocks).flatMap((block) => Object.entries(block).flatMap(([member, value]) =>
    member.startsWith(WORK_MEMBER) && typeof value === "string" && ROUTE_ID.test(value) ? [value] : []));
  return new Set([...Object.values(at.defaults).filter((value): value is string => value !== null), ...picks]);
}

export function menuOf(offered: readonly ModelRoute[], use: UseId, held: ReadonlySet<string>): string[] {
  const listed = new Set(offered.filter((route) => route.suggested.includes(use) || held.has(route.id)).map((route) => route.id));
  return fitsOf(offered, use).filter((id) => listed.has(id));
}

export function foundOf(offered: readonly ModelRoute[], use: UseId, typed: string): ModelRoute[] {
  const words = typed.trim().toLowerCase();
  if (words === "") return [];
  const byId = new Map(offered.map((route) => [route.id, route]));
  const exact = (route: ModelRoute) => route.id.toLowerCase() === words || route.model.toLowerCase() === words;
  const found = fitsOf(offered, use).map((id) => byId.get(id)!).filter((route) => callable(route, use)
    && [route.name, route.model, route.id].some((each) => each.toLowerCase().includes(words)));
  return [...found.filter(exact), ...found.filter((route) => !exact(route))].slice(0, MODELS_FOUND);
}

export function modelsRead(stored: StoredModels, at: ModelsAt): ModelsRead {
  const offered = stored.routes.filter((route) => route.offered);
  const byId = new Map(offered.map((route) => [route.id, route]));
  const held = inUseOf(at);
  const uses = Object.fromEntries(USE_IDS.map((use): [UseId, UseRead] => {
    const value = chosenFor(at, use);
    const fits = fitsOf(offered, use);
    const pick = use === "chat" && at.chat !== undefined && fits.includes(at.chat) ? at.chat : null;
    const listed = menuOf(offered, use, pick === null ? held : new Set([...held, pick])).map((id) => byId.get(id)!);
    const off = use === "chat" ? null : OFF_STEP.value;
    return [use, {
      value, thinking: use === "chat" ? at.thinking.chat : null, fits,
      menu: modelMenu(listed, stored.runners, { use, work: null, chosen: pick ?? value ?? off, off }),
    }];
  })) as Record<UseId, UseRead>;
  return {
    connections: connectionsOf(stored, offered, at),
    uses,
    models: Object.fromEntries(stored.routes.map((route) => [route.id, rowOf(route, stored)])),
  };
}
