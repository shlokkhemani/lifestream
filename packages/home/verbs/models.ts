import { unfit, WORK_KINDS, workNeed, type WorkKind } from "@lifestreamprotocol/model";
import { chooseFor } from "../made.js";
import { modelsRead, OFF_STEP, type ModelsRead } from "../models-read.js";
import { itemUsesOf, readRouting, runnerPause, storedModels, type StoredModels } from "../models.js";
import { heldRunners } from "../principals.js";
import { refuse } from "../refusal.js";
import { effective, personal, planned, reset } from "../settings.js";
import { readArgs } from "./args.js";
import { fail, type VerbContext } from "./context.js";
import { lift, stand } from "./loop.js";
import { CLI } from "../cli-name.js";

const USAGE = "models | models default <pictures|audio|text> <route|none> | models file <runner unit> <file id> fetch|remove | "
  + "models runner <runner unit> pause [--reason <words>] | models runner <runner unit> resume | models battery <runner unit> save|spend | "
  + "models address <url> <model> <kinds,comma-separated> | models address none | models process <family> <item> <prompt> <route>";

const PROCESS_REFUSED = "PROCESS_REFUSED";
const NO_RUNNER = "That runner isn't connected.";

export async function models(ctx: VerbContext, args: readonly string[]) {
  const { positionals, values } = readArgs("models", args, { reason: { type: "string" } }, USAGE, { min: 0, max: 5 });
  const [action, ...rest] = positionals;
  const usage = (): never => fail(`usage: ${CLI} ${USAGE}`);
  if (values.reason !== undefined && !(action === "runner" && rest[1] === "pause")) fail("--reason states why a runner's calls pause: models runner <runner unit> pause --reason <words>");
  switch (action) {
    case undefined:
      return printed(ctx, readOf(ctx));
    case "default": {
      const [kind, value, ...more] = rest;
      if (kind === undefined || value === undefined || more.length > 0) return usage();
      if (!WORK_KINDS.includes(kind as WorkKind)) fail(`models default takes a kind: ${WORK_KINDS.join(", ")}`);
      if (value !== OFF_STEP.value) {
        const routes = storedOf(ctx).routes.filter((each) => each.offered);
        const route = routes.find((each) => each.id === value) ?? fail(`no model ${value}; the home reaches ${routes.map((each) => each.id).join(", ") || "none"}`);
        if (unfit(route, workNeed({ kind: kind as WorkKind })) !== null) fail(`${route.name} does not take ${kind}`);
      }
      planned(ctx.folder, { [`model.defaults.${kind}`]: value === OFF_STEP.value ? null : value }).write();
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
        if (file.detector !== undefined) fail(`${id} is the hiding model: it downloads while privacy.detector names this runner (${CLI} settings set privacy.detector ${unit}), and is removed when it does not.`);
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
      const [url, model, kinds, ...more] = rest;
      if (url === "none" && model === undefined) {
        reset(ctx.folder, "model.transports.address");
        break;
      }
      if (url === undefined || model === undefined || kinds === undefined || more.length > 0) return usage();
      planned(ctx.folder, { "model.transports.address": { url, model, kinds: kinds.split(",").map((kind) => kind.trim()).filter((kind) => kind !== "") } }).write();
      break;
    }
    case "process": {
      const [family, item, prompt, route, ...more] = rest;
      if (family === undefined || item === undefined || prompt === undefined || route === undefined || more.length > 0) return usage();
      const { settings } = effective(ctx.folder);
      const registry = await ctx.registry();
      const chosen = ctx.db.commit((tx) => {
        const routing = readRouting(tx.tables, { connectors: registry.connectors, blocks: settings.connectors, defaults: settings.defaults, runners: settings.runners, now_ms: ctx.now(), day: settings.day });
        const found = chooseFor(tx.tables, routing, { family, item, prompt, route });
        if ("refused" in found) refuse(422, PROCESS_REFUSED, found.refused);
        tx.tables.itemRoutes.set(found.choice);
        return { family, item, prompt, route: found.choice.route };
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
  const view = ctx.db.view();
  try {
    return modelsRead(storedModels(view.tables.meta), settings.model, settings.defaults, { pauses: view.tables.controls.list(), runners: settings.runners, now_ms: ctx.now(), day: settings.day });
  } finally {
    view.close();
  }
}

function printed(ctx: VerbContext, read: ModelsRead): ModelsRead {
  const routes = storedOf(ctx).routes.filter((each) => each.offered);
  for (const route of routes) ctx.out(`${route.id}  ${route.name} · ${itemUsesOf(route).join(", ")} · ${route.line ?? route.where}`);
  if (routes.length === 0) ctx.out("no model the home reaches");
  for (const kind of WORK_KINDS) ctx.out(`${kind}: ${read.defaults[kind].words}`);
  ctx.out(`OpenRouter: ${read.openrouter.connected ? "key held" : "no key"}`);
  if (read.address !== null) ctx.out(`address: ${read.address.words} · ${read.address.takes}`);
  return read;
}
