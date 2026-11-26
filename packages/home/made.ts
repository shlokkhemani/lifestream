import type { AskRow, ItemRoute, ReadTables } from "@lifestreamprotocol/core";
import type { Made, Step } from "./streams-report.js";
import { unfit, unfitWords, workNeed } from "@lifestreamprotocol/model";
import { placeOf, readRouting, serving, type ModelRoute, type Routing, type RoutingAt } from "./models.js";
import { needsWords, powerWords } from "./processing.js";
import { dayWords } from "./stream-words.js";

export interface MadeInput extends RoutingAt {
  reply(key: string): { model: string; created_ms: number } | undefined;
}

export interface MadeView {
  readonly tables: Pick<ReadTables, "meta" | "itemRoutes" | "sources" | "asks">;
  enrichment(family: string, item: string, prompt: string): { state: string; reply_key: string | null } | undefined;
}

export const NOTHING_MADE: Made = Object.freeze({ by: null, at_ms: null, state: "off", line: null, ask: null, choose: [] });

const QUEUED = "In the queue";
export const WRITING = "Writing it out";
const FAILED = "Could not be processed";

export function openMade(view: MadeView, input: MadeInput): (asked: { family: string; item: string }) => Made {
  const routing = readRouting(view.tables, input);
  const routes = Object.values(routing.routes);
  return ({ family, item }) => {
    const row = askOf(view.tables, family, item);
    if (row === undefined) return NOTHING_MADE;
    const step = (route: ModelRoute): Step => ({ value: route.id, words: route.name, note: placeOf(route, row.work_id === null ? undefined : routing.works[row.work_id]) });
    const shown = view.enrichment(family, item, row.prompt);
    const reply = shown?.state === "done" && shown.reply_key !== null ? input.reply(shown.reply_key) : undefined;
    const by = reply === undefined ? null : routes.find((route) => route.model === reply.model)?.name ?? reply.model;
    const at_ms = reply?.created_ms ?? null;
    const ask = { family, item, prompt: row.prompt };
    const made = (state: Made["state"], line: string | null, choose: Step[]): Made => ({ by, at_ms, state, line, ask, choose });
    const work = row.work_id === null ? undefined : routing.works[row.work_id];
    if (work === undefined) return made("off", null, []);
    const ready = (id: string): ModelRoute | null => {
      const now = serving(routing, { work_id: row.work_id, chosen: id, at_key: row.at_key });
      return "route" in now && now.route.state === "ready" ? now.route : null;
    };
    const others = (...not: (string | null | undefined)[]): Step[] =>
      routes.filter((route) => !not.includes(route.id) && route.model !== reply?.model && ready(route.id) !== null).map(step);
    const choice = view.tables.itemRoutes.get(family, item, row.prompt);
    if (row.state === "given-up" || shown?.state === "refused" || shown?.state === "given-up") return made("failed", FAILED, others(row.given_up, choice?.route));
    if (row.state === "pending" && row.unhideable !== null) return made("needs", row.unhideable, routes.filter((route) => route.leaves === null && ready(route.id) !== null).map(step));
    if (choice !== undefined && choice.model !== reply?.model) {
      if (ready(choice.route) !== null) return made("waiting", QUEUED, []);
      return made("waiting", routing.routes[choice.route]?.line ?? needsWords(work, routes), others(choice.route));
    }
    if (row.state === "done") return made("done", reply === undefined || by === null ? null : `${by} · ${dayWords(reply.created_ms, input.now_ms, input.day)}`, others());
    const suggested = work.suggests === null ? null : ready(work.suggests);
    const choose = suggested === null ? [] : [step(suggested)];
    const own = serving(routing, { work_id: row.work_id, chosen: null, at_key: row.at_key });
    if ("none" in own) {
      switch (own.none) {
        case "off": case "unknown": return made("off", null, choose);
        case "older": return made("off", "Older than this stream's range", choose);
        case "power": return made("waiting", `Waits ${powerWords(routing.routes[work.route!]!.runner!)}`, choose);
        case "needs": return made("needs", needsWords(work, routes), choose);
      }
    }
    if (row.waits !== null && work.kind === "audio") return made("waiting", WRITING, choose);
    return made("waiting", own.route.state === "ready" ? QUEUED : own.route.line, choose);
  };
}

export function chooseFor(tables: Pick<ReadTables, "asks">, routing: Routing, asked: { family: string; item: string; prompt: string; route: string }): { choice: ItemRoute } | { refused: string } {
  const row = tables.asks.get(asked.family, asked.item, asked.prompt);
  if (row === undefined) return { refused: "Nothing is asked of this item." };
  const route = routing.routes[asked.route];
  if (route === undefined || !route.offered) return { refused: "That model isn't connected." };
  const now = serving(routing, { work_id: row.work_id, chosen: route.id, at_key: row.at_key });
  if ("none" in now) {
    const work = routing.works[row.work_id ?? ""];
    const why = work === undefined ? null : unfit(route, workNeed(work));
    if (why === null) return { refused: "Nothing is asked of this item." };
    return { refused: `${unfitWords(route.name, why)}.` };
  }
  return { choice: { family: asked.family, item: asked.item, prompt: asked.prompt, route: route.id, model: route.model } };
}

function askOf(tables: Pick<ReadTables, "asks">, family: string, item: string): AskRow | undefined {
  return tables.asks.ofItem(family, item)[0];
}
