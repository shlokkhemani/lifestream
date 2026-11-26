import type { ItemRoute, ReadTables } from "@lifestreamprotocol/core";
import { CALLAUDIO_FAMILY, stretchUnit } from "@lifestreamprotocol/families";
import { ADDRESS_SECRET, MODEL_USES, unfit, unfitWords, USE_IDS, type UseId } from "@lifestreamprotocol/model";
import { chooseFor } from "../made.js";
import { CHOOSE_MODEL, modelsAt, modelsRead, OFF_STEP, type ModelsRead } from "../models-read.js";
import { itemUsesOf, readRouting, runnerPause, storedModels, type Routing, type StoredModels } from "../models.js";
import { heldRunners } from "../principals.js";
import { refuse } from "../refusal.js";
import { effective, personal, planned, reset } from "../settings.js";
import { readArgs } from "./args.js";
import { fail, type VerbContext } from "./context.js";
import { lift, stand } from "./loop.js";
import { CLI } from "../cli-name.js";

const USAGE = `models | models default <${USE_IDS.join("|")}> <model|none> [--thinking <level>] | models file <runner unit> <file id> fetch|remove | `
  + "models runner <runner unit> pause [--reason <words>] | models runner <runner unit> resume | models battery <runner unit> save|spend | "
  + "models address <url> [text|text,image] [--key] | models address none | models process <family> <item> <prompt> <route>";

const PROCESS_REFUSED = "PROCESS_REFUSED";
const NO_RUNNER = "That runner isn't connected.";
export const CHAT_NEEDS_MODEL = "Chat always has a model: choose one to answer in Chat.";

export async function models(ctx: VerbContext, args: readonly string[]) {
  const { positionals, values } = readArgs("models", args, { reason: { type: "string" }, thinking: { type: "string" }, key: { type: "boolean" } }, USAGE, { min: 0, max: 5 });
  const [action, ...rest] = positionals;
  const usage = (): never => fail(`usage: ${CLI} ${USAGE}`);
  if (values.reason !== undefined && !(action === "runner" && rest[1] === "pause")) fail("--reason states why a runner's calls pause: models runner <runner unit> pause --reason <words>");
  if (values.thinking !== undefined && !(action === "default" && rest[0] === "chat" && rest[1] !== OFF_STEP.value)) fail("--thinking states the level Chat's model thinks at: models default chat <model> --thinking <level>");
  if (values.key === true && !(action === "address" && rest[0] !== "none")) fail(`--key sends the key sealed as ${ADDRESS_SECRET} to the address: models address <url> --key`);
  switch (action) {
    case undefined:
      return printed(ctx, readOf(ctx));
    case "default": {
      const [use, value, ...more] = rest;
      if (use === undefined || value === undefined || more.length > 0) return usage();
      if (!USE_IDS.includes(use as UseId)) fail(`models default takes a use: ${USE_IDS.join(", ")}`);
      if (use === "chat" && value === OFF_STEP.value) fail(CHAT_NEEDS_MODEL);
      const members: Record<string, string | null> = { [`model.defaults.${use}`]: value === OFF_STEP.value ? null : value };
      if (value !== OFF_STEP.value) {
        const routes = storedOf(ctx).routes.filter((each) => each.offered);
        const route = routes.find((each) => each.id === value) ?? fail(`no model ${value}; the home reaches ${routes.map((each) => each.id).join(", ") || "none"}`);
        const why = unfit(route, MODEL_USES[use as UseId].need);
        if (why !== null) fail(`${unfitWords(route.name, why)}: it can't be the ${MODEL_USES[use as UseId].label} model`);
        if (values.thinking !== undefined) {
          if (!route.thinking.includes(values.thinking)) fail(`${route.name} thinks at ${route.thinking.join(", ") || "no level"}, not ${values.thinking}`);
          members[`model.thinking.${use}`] = values.thinking;
        }
      }
      planned(ctx.folder, members).write();
      break;
    }
    case "file": {
      const [unit, id, act, ...more] = rest;
      if (unit === undefined || id === undefined || (act !== "fetch" && act !== "remove") || more.length > 0) return usage();
      const key = `model.runners.${unit}.files`;
      const held = personal(ctx.folder)[key];
      const files = Array.isArray(held) ? held.filter((each): each is string => typeof each === "string") : [];
      if (!(act === "remove" && files.includes(id))) {
        if (!storedOf(ctx).runners.some((each) => each.unit === unit)) await ctx.readModels?.();
        const runner = storedOf(ctx).runners.find((each) => each.unit === unit) ?? fail(NO_RUNNER);
        const file = runner.files.find((each) => each.id === id) ?? fail(`${runner.name}'s runner doesn't have ${id}.`);
        if (file.detector !== undefined) fail(`${id} is the hiding model: it downloads while Hiding details names it (${CLI} models default hiding runner:${unit}/${id}), and is removed when it does not.`);
      }
      const next = act === "fetch" ? [...new Set([...files, id])] : files.filter((each) => each !== id);
      if (next.length === 0) reset(ctx.folder, key);
      else planned(ctx.folder, { [key]: next }).write();
      break;
    }
    case "runner": {
      const [unit, act, ...more] = rest;
      if (unit === undefined || (act !== "pause" && act !== "resume") || more.length > 0) return usage();
      if (act === "resume") lift(ctx, runnerPause(unit), true);
      else {
        if (!heldRunners(ctx.folder).has(unit)) fail(NO_RUNNER);
        stand(ctx, runnerPause(unit), values.reason);
      }
      return printed(ctx, readOf(ctx));
    }
    case "battery": {
      const [unit, act, ...more] = rest;
      if (unit === undefined || (act !== "save" && act !== "spend") || more.length > 0) return usage();
      const key = `model.runners.${unit}.save_battery`;
      if (act === "save") reset(ctx.folder, key);
      else {
        if (!heldRunners(ctx.folder).has(unit)) fail(NO_RUNNER);
        planned(ctx.folder, { [key]: false }).write();
      }
      break;
    }
    case "address": {
      const [url, input, ...more] = rest;
      if (url === "none" && input === undefined) {
        reset(ctx.folder, "model.transports.address");
        break;
      }
      if (url === undefined || more.length > 0) return usage();
      planned(ctx.folder, { "model.transports.address": {
        url,
        ...(input === undefined ? {} : { input: input.split(",").map((each) => each.trim()).filter((each) => each !== "") }),
        ...(values.key === true ? { secret: ADDRESS_SECRET } : {}),
      } }).write();
      break;
    }
    case "process": {
      const [family, item, prompt, route, ...more] = rest;
      if (family === undefined || item === undefined || prompt === undefined || route === undefined || more.length > 0) return usage();
      const { settings } = effective(ctx.folder);
      const registry = await ctx.registry();
      const chosen = ctx.db.commit((tx) => {
        const routing = readRouting(tx.tables, { connectors: registry.connectors, blocks: settings.connectors, defaults: settings.defaults, runners: settings.runners, now_ms: ctx.now(), day: settings.day });
        const found = processChoices(tx.tables, routing, { family, item, prompt, route });
        if ("refused" in found) refuse(422, PROCESS_REFUSED, found.refused);
        for (const choice of found.choices) tx.tables.itemRoutes.set(choice);
        return { family, item, prompt, route: found.choices[0]!.route };
      });
      ctx.out(`${family} ${item} ${prompt}: ${chosen.route}`);
      return { chosen };
    }
    default:
      return usage();
  }
  ctx.settingsChanged?.();
  return printed(ctx, readOf(ctx));
}
models.usage = USAGE;

export function processChoices(tables: Pick<ReadTables, "asks">, routing: Routing, asked: { family: string; item: string; prompt: string; route: string }): { choices: ItemRoute[] } | { refused: string } {
  const choices: ItemRoute[] = [];
  for (const item of processedItems(tables, asked)) {
    const found = chooseFor(tables, routing, { ...asked, item });
    if ("refused" in found) return found;
    choices.push(found.choice);
  }
  return { choices };
}

function processedItems(tables: Pick<ReadTables, "asks">, asked: { family: string; item: string; prompt: string }): string[] {
  const unit = asked.family === CALLAUDIO_FAMILY ? stretchUnit(asked.item) : null;
  if (unit === null) return [asked.item];
  const parts = tables.asks.ofUnit(asked.family, unit).filter((row) => row.prompt === asked.prompt);
  const left = parts.filter((row) => row.state !== "done");
  const chosen = left.length > 0 ? left : parts;
  return chosen.length === 0 ? [asked.item] : chosen.map((row) => row.item);
}

export function storedOf(ctx: Pick<VerbContext, "db">): StoredModels {
  const view = ctx.db.view();
  try {
    return storedModels(view.tables.meta);
  } finally {
    view.close();
  }
}

function readOf(ctx: VerbContext): ModelsRead {
  const { settings } = effective(ctx.folder);
  return modelsRead(storedOf(ctx), modelsAt(settings));
}

function printed(ctx: VerbContext, read: ModelsRead): ModelsRead {
  const routes = storedOf(ctx).routes.filter((each) => each.offered);
  for (const route of routes) ctx.out(`${route.id}  ${route.name} · ${itemUsesOf(route).join(", ")} · ${route.line ?? route.where}`);
  if (routes.length === 0) ctx.out("no model the home reaches");
  for (const use of USE_IDS) {
    const { value, thinking } = read.uses[use];
    const name = value === null ? use === "chat" ? CHOOSE_MODEL : OFF_STEP.words : read.models[value]?.name ?? value;
    ctx.out(`${use}: ${name}${thinking !== null && value !== null ? ` · thinks at ${thinking}` : ""}`);
  }
  for (const connection of read.connections) ctx.out(`${connection.name}: ${connection.line ?? "ready"}`);
  return read;
}
