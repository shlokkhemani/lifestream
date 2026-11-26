import { digest, NEWEST, type Ask, type AskRow, type EnrichmentRow, type ExtractRow, type ItemRoute } from "@lifestreamprotocol/core";
import type { Family } from "@lifestreamprotocol/families";
import type { Asker, By, CallRoute, Candidate, Sending as Request } from "@lifestreamprotocol/model";
import type { NamedLevel } from "@lifestreamprotocol/privacy";
import { catalogOf } from "./catalog.js";
import { sentLevel } from "./copies.js";
import { failpoint } from "./failpoint.js";
import { errorText, homeFault, LANE, RECENT_MS, type HelperEnv, type Kind, type Task } from "./jobs.js";
import { routed, sendingBy, workId, type Routing } from "./models.js";


const ROUNDS = 32;
const RUN_UNITS = 1_000;
const CHUNK_UNITS = 50;

type Named = { item: string; prompt: string };

type Planned = { unit: string; marks: number; read: Pick<ExtractRow, "reading" | "code"> | null } & (
  | { rows: EnrichmentRow[]; asks: AskRow[]; gone: Named[]; dropped: Named[] }
  | { error: string }
);

interface PlanData {
  family: string;
  units: { unit: string; marks: number }[];
}

interface PlanResult {
  units: number;
}

interface PlanState {
  planned: number;
  set_aside: number;
  rows: number;
}

async function* planHelper(env: HelperEnv, task: Task<PlanData>): AsyncGenerator<Planned[], PlanResult, undefined> {
  const { family: name, units } = task.data;
  const family = env.registry.families.find((each) => each.name === name);
  if (family?.plan === undefined) throw new Error(`family ${name} does not plan`);
  let threw: string | undefined;
  let failed = 0;
  for (let at = 0; at < units.length; at += CHUNK_UNITS) {
    yield units.slice(at, at + CHUNK_UNITS).flatMap(({ unit, marks }): Planned[] => {
      const planned = planOne(env, family, unit, marks);
      if (planned === null) return [];
      if ("error" in planned) {
        failed++;
        threw ??= `${unit}: ${planned.error}`;
      }
      return [planned];
    });
  }
  if (units.length > 1 && failed === units.length) throw new Error(`every unit of the run threw, the first ${threw}`);
  return { units: units.length };
}

function planOne(env: HelperEnv, family: Family, unit: string, marks: number): Planned | null {
  const view = env.db.view();
  let read: Planned["read"] | undefined;
  try {
    if (view.tables.dirty.marks(family.name, unit) !== marks) return null;
    const extract = view.extract(family.name, unit);
    read = extract === undefined ? null : { reading: extract.reading, code: extract.code };
    if (extract === undefined) return { unit, marks, read, rows: [], asks: [], gone: [], dropped: [] };
    const built = current(family, extract);
    const { rows, asks, inputs, refused } = built ? planUnit(family, extract, env.asker(), lookOf(env, view)) : { rows: [], asks: [], inputs: new Map<string, string>(), refused: new Set<string>() };
    const key = ({ item, prompt }: Named) => `${item}\0${prompt}`;
    const written = new Set(rows.map(key));
    const stated = new Set(asks.map(key));
    const stays = (row: EnrichmentRow) => row.state === "done" && row.input_hash === inputs.get(row.item) && (row.reply_key === null ? refused.size === 0 : !refused.has(row.reply_key));
    const gone = (built ? family.items?.(extract) ?? [] : []).filter((each) => {
      const row = written.has(key(each)) ? undefined : view.enrichment(family.name, each.item, each.prompt);
      return row !== undefined && !stays(row);
    });
    const dropped = view.tables.asks.ofUnit(family.name, unit).filter((each) => !stated.has(key(each)));
    return { unit, marks, read, rows, asks, gone: [...new Map(gone.map((each) => [key(each), { item: each.item, prompt: each.prompt }])).values()], dropped: dropped.map(({ item, prompt }) => ({ item, prompt })) };
  } catch (error) {
    if (homeFault(error) || read === undefined) throw error;
    return { unit, marks, read, error: errorText(error) };
  } finally {
    view.close();
  }
}

function current(family: Family, extract: ExtractRow): boolean {
  return extract.code === family.code;
}

export function askKey(known: { prompt: string | null; version: number | null; input_hash: string }): string {
  return `${known.prompt}\0${known.version}\0${known.input_hash}`;
}

interface Look {
  workOf(ask: Ask): string | null;
  choice(ask: Ask): ItemRoute | undefined;
  stored(ask: Ask): AskRow | undefined;
}

function lookOf(env: HelperEnv, view: ReturnType<HelperEnv["db"]["view"]>): Look {
  const catalog = catalogOf(env.registry.connectors);
  const connectors = new Map<string, ReturnType<typeof catalog.of>>();
  const connectorOf = (source: string) => {
    if (!connectors.has(source)) connectors.set(source, catalog.of(view.tables.sources.get(source) ?? { id: source }));
    return connectors.get(source);
  };
  return {
    workOf(ask) {
      const connector = connectorOf(ask.source);
      return connector?.processing?.[ask.work] === undefined ? null : workId(connector.id, ask.work);
    },
    choice: (ask) => view.tables.itemRoutes.get(ask.family, ask.item, ask.prompt),
    stored: (ask) => view.tables.asks.get(ask.family, ask.item, ask.prompt),
  };
}

export interface SentAsk {
  item: string;
  prompt: string;
  known: string;
  key: string;
  route: string;
  call: CallRoute;
  work_id: string | null;
  at_key: number;
  copy: { id: number; receiver: string; level: NamedLevel } | null;
}

interface Hand {
  request: Request;
  revision: string;
  attachments: NonNullable<Ask["attachments"]>;
  leaves: string | null;
}

type Found = Named & ({ retry_ms: number } | { given_up: string } | { unhideable: string; ask: SentAsk; leaves: string; level: NamedLevel });

interface Standing {
  ask: Ask;
  shown: Candidate | null;
  owed: boolean;
  waits: string | null;
}

export function planUnit(family: Family, extract: ExtractRow, asker: Asker, look: Look, send?: { picked: ReadonlyMap<string, string>; routing: Routing }):
  { rows: EnrichmentRow[]; asks: AskRow[]; sent: SentAsk[]; hands: Map<string, Hand>; found: Found[]; inputs: Map<string, string>; refused: Set<string> } {
  const standing = new Map<string, Standing>();
  const rows = new Map<string, EnrichmentRow>();
  const sent: SentAsk[] = [];
  const hands = new Map<string, Hand>();
  asker.refused();
  const found: Found[] = [];
  const by = (ask: Ask): By | undefined => {
    const choice = look.choice(ask);
    return choice === undefined ? undefined : { model: choice.model };
  };
  const stand = (ask: Ask): Standing => {
    const chosen = by(ask);
    const own = asker.answer(ask, chosen);
    if (own !== null && "reply" in own) return { ask, shown: own, owed: false, waits: null };
    const any = chosen === undefined ? null : asker.answer(ask);
    return { ask, shown: any !== null && "reply" in any ? any : null, owed: true, waits: own === null ? null : own.waits };
  };
  const prompts = new Map((family.items?.(extract) ?? []).map(({ item, prompt }) => [item, prompt]));
  let refused = new Set<string>();
  const refusedKeys = new Set<string>();
  let last = new Set<string>();
  let given_up = new Set<string>();
  const givenUp = ({ ask, shown, waits }: Standing): boolean => {
    if (shown !== null || waits !== null) return false;
    const known = asker.known(ask);
    const stored = look.stored(ask);
    return stored?.state === "given-up" && stored.version === known.version && stored.input_hash === known.input_hash;
  };
  for (let round = 0; round < ROUNDS; round++) {
    const answers = new Map([...standing].flatMap(([item, each]) => each.shown === null ? [] : [[item, each.shown.reply] as const]));
    const plan = family.plan!(extract, answers, given_up);
    last = new Set([...plan.asks.map((ask) => ask.item), ...(plan.answers ?? []).map((answer) => answer.item)]);
    let more = false;
    refused = new Set();
    for (const { item, reason } of plan.refusals ?? []) {
      const each = standing.get(item);
      if (each?.shown === null || each === undefined) throw new Error(`family ${family.name} refused ${item}, which it was not answered`);
      refused.add(item);
      refusedKeys.add(each.shown.reply.key);
      asker.refuse(each.ask, each.shown, reason);
      const after = stand(each.ask);
      standing.set(item, after);
      if (after.shown !== null) more = true;
    }
    for (const { item, content } of plan.answers ?? []) {
      const each = standing.get(item);
      put(rows, {
        family: family.name, item, prompt: prompts.get(item) ?? each?.ask.prompt ?? "",
        input_hash: each === undefined ? digest(extract.reading) : asker.known(each.ask).input_hash,
        reply_key: each?.shown?.reply.key ?? null, reused_from: each?.shown?.reply.reused_from ?? null, content, state: "done",
      });
    }
    for (const ask of plan.asks) {
      if (standing.get(ask.item)?.shown != null) continue;
      const each = stand(ask);
      standing.set(ask.item, each);
      if (each.shown !== null) more = true;
    }
    const now = new Set([...standing].filter(([, each]) => givenUp(each)).map(([item]) => item));
    if (now.size > given_up.size) more = true;
    given_up = now;
    if (!more) break;
  }
  for (const [item, { shown }] of standing) if (shown !== null && !refused.has(item)) asker.accept(shown.reply);
  for (const key of asker.refused()) refusedKeys.add(key);
  const started = [...standing.values()].some((each) => each.shown !== null);
  const at_key = extract.end_ms ?? NEWEST;
  const asks: AskRow[] = [];
  const inputs = new Map([...prompts.keys()].map((item) => [item, digest(extract.reading)]));
  for (const { ask, owed, waits } of standing.values()) {
    const known = asker.known(ask);
    inputs.set(ask.item, known.input_hash);
    if (owed && !last.has(ask.item)) continue;
    const row: AskRow = {
      family: family.name, item: ask.item, prompt: ask.prompt, version: known.version, input_hash: known.input_hash, unit: extract.unit,
      work_id: look.workOf(ask), at_key, started, waits: null, retry_ms: null, given_up: null, unhideable: null, state: "done",
    };
    if (!owed) {
      asks.push(row);
      continue;
    }
    const stored = look.stored(ask);
    const same = stored !== undefined && stored.version === known.version && stored.input_hash === known.input_hash;
    if (same && stored.state === "given-up" && waits === null) {
      asks.push({ ...row, state: "given-up", given_up: stored.given_up });
      if (!rows.has(`${ask.item}\0${ask.prompt}`)) put(rows, { family: family.name, item: ask.item, prompt: ask.prompt, input_hash: known.input_hash, reply_key: null, reused_from: null, content: null, state: "given-up" });
      continue;
    }
    const retry_ms = same ? stored.retry_ms : null;
    asks.push({ ...row, waits, retry_ms, unhideable: same ? stored.unhideable : null, state: "pending" });
    const picked = send?.picked.get(ask.item);
    if (send === undefined || picked === undefined || waits !== null) continue;
    const choice = look.choice(ask);
    const route = sendingBy(send.routing, { work_id: row.work_id, chosen: choice?.route ?? null, at_key }, picked);
    if (route === null) continue;
    const way = routed(ask, route);
    const request = asker.request(way.ask, by(ask));
    if ("send" in request) {
      sent.push({ item: ask.item, prompt: ask.prompt, known: askKey(known), key: request.send, route: picked, call: way.call, work_id: row.work_id, at_key, copy: null });
      const attachments = (ask.attachments ?? []).map((file) => (file.drawn === undefined ? file : { ...file, drawn: [...request.faces ?? []] }));
      hands.set(request.send, { request, revision: asker.key(way.ask), attachments, leaves: route.leaves });
    } else if ("failed" in request) found.push({ item: ask.item, prompt: ask.prompt, retry_ms: request.retry_ms });
    else if ("givenUp" in request) found.push({ item: ask.item, prompt: ask.prompt, given_up: picked });
  }
  if (sent.length > 0) failpoint("plan.requested");
  return { rows: [...rows.values()], asks, sent, hands, found, inputs, refused: refusedKeys };
}

function put(rows: Map<string, EnrichmentRow>, row: EnrichmentRow): void {
  rows.set(`${row.item}\0${row.prompt}`, row);
}

export const planKind: Kind<PlanData, Planned[], PlanResult, PlanState> = {
  dies: true,
  helper: planHelper,
  begin(main, tx, job) {
    const family = job.key;
    if (main.families.get(family)?.plan === undefined) throw new Error(`family ${family} does not plan`);
    const { lane } = job;
    const units = tx.tables.dirty.next(family, RUN_UNITS, lane === LANE.live ? { woken: true } : lane === LANE.planning ? { since_ms: main.now() - RECENT_MS } : undefined);
    if (units.length === 0) return null;
    return { data: { family, units }, state: { planned: 0, set_aside: 0, rows: 0 } };
  },
  chunk(main, running, received) {
    const family = running.job.key;
    return [{
      work(tx) {
        for (const planned of received) {
          const { unit, marks, read } = planned;
          if ("error" in planned) {
            if (tx.tables.dirty.setAside(family, unit, marks, planned.error, read)) running.state.set_aside++;
            continue;
          }
          if (!tx.tables.dirty.planned(family, unit, marks, read)) continue;
          running.state.planned++;
          let wrote = 0;
          for (const row of planned.rows) if (tx.derived.enrichments.put(row)) wrote++;
          for (const { item, prompt } of planned.gone) wrote += tx.derived.enrichments.delete(family, item, prompt);
          for (const row of planned.asks) tx.tables.asks.put(row);
          for (const { item, prompt } of planned.dropped) tx.tables.asks.delete(family, item, prompt);
          running.state.rows += wrote;
          if (wrote > 0) tx.tables.events.append({ at_ms: main.now(), kind: "enrichment", key: family, detail: { unit, rows: wrote } });
        }
      },
    }];
  },
  done(main, tx, running, result) {
    const now = main.now();
    const run = tx.tables.runs.start({ kind: "plan", subject: running.job.key, started_ms: running.job.started_ms ?? now });
    tx.tables.runs.end(run, { ended_ms: now, outcome: "ok", counts: { units: result.units, ...running.state } });
  },
};


interface SendData {
  family: string;
  units: { unit: string; items: [item: string, route: string][] }[];
  routing: Routing;
}

type Sending = { unit: string } & ({ picked: number; sent: SentAsk[]; found: Found[] } | { error: string });

async function* sendHelper(env: HelperEnv, task: Task<SendData>): AsyncGenerator<Sending[], void, undefined> {
  const family = env.registry.families.find((each) => each.name === task.data.family);
  if (family?.plan === undefined) throw new Error(`family ${task.data.family} does not plan`);
  const asker = env.asker();
  const units: Sending[] = [];
  for (const { unit, items } of task.data.units) {
    try {
      let planned: ReturnType<typeof planUnit>;
      const epoch = env.epoch();
      const view = env.db.view();
      try {
        const extract = view.extract(family.name, unit);
        if (extract === undefined || !current(family, extract)) {
          units.push({ unit, picked: items.length, sent: [], found: [] });
          continue;
        }
        planned = planUnit(family, extract, asker, lookOf(env, view), { picked: new Map(items), routing: task.data.routing });
      } finally {
        view.close();
      }
      units.push({ unit, picked: items.length, ...await copied(env, planned, epoch) });
    } catch (error) {
      if (homeFault(error)) throw error;
      units.push({ unit, error: errorText(error) });
    }
  }
  yield units;
}

async function copied(env: HelperEnv, planned: Pick<ReturnType<typeof planUnit>, "sent" | "hands" | "found">, epoch: number): Promise<{ sent: SentAsk[]; found: Found[] }> {
  const sent: SentAsk[] = [];
  const found = [...planned.found];
  for (const ask of planned.sent) {
    const hand = planned.hands.get(ask.key)!;
    if (hand.leaves === null) {
      sent.push(ask);
      continue;
    }
    const level = sentLevel(env.settings, env.registry.connectors, ask.work_id);
    const answer = await env.copy({
      op: "copy", key: ask.key, revision: hand.revision, pieces: hand.request.pieces, ...(hand.request.quoted === undefined ? {} : { quoted: hand.request.quoted }),
      attachments: hand.attachments, receiver: hand.leaves, route: ask.route, level, epoch,
    });
    if ("error" in answer) throw new Error(answer.error);
    if ("copy" in answer) sent.push({ ...ask, copy: { id: answer.copy, receiver: hand.leaves, level } });
    else if ("cannot" in answer) found.push({ item: ask.item, prompt: ask.prompt, unhideable: answer.cannot, ask, leaves: hand.leaves, level });
  }
  return { sent, found };
}

export function stands(route: { leaves: string | null } | null, made: { leaves: string | null; level: NamedLevel | null }, level: NamedLevel): boolean {
  if (route === null || route.leaves !== made.leaves) return false;
  return route.leaves === null || made.level === level;
}

export const sendKind: Kind<SendData, Sending[], void, undefined> = {
  dies: true,
  helper: sendHelper,
  begin(main, tx, job) {
    const picks = main.calls.take(job.key);
    if (picks.length === 0) return null;
    const units = new Map<string, [string, string][]>();
    for (const pick of picks) units.set(pick.unit, [...units.get(pick.unit) ?? [], [pick.item, pick.route]]);
    return { data: { family: job.key, units: [...units].map(([unit, items]) => ({ unit, items })), routing: main.routing(tx) }, state: undefined };
  },
  chunk(main, running, found) {
    const family = running.job.key;
    const kept = new Map<string, SentAsk[]>();
    const dropped: number[] = [];
    return [{
      work(tx) {
        const routing = main.routing(tx);
        const routeOf = (ask: SentAsk) => sendingBy(routing, { work_id: ask.work_id, chosen: tx.tables.itemRoutes.get(family, ask.item, ask.prompt)?.route ?? null, at_key: ask.at_key }, ask.route);
        for (const unit of found) {
          if ("error" in unit) {
            tx.tables.dirty.sendFailed(family, unit.unit, unit.error);
            continue;
          }
          for (const each of unit.found) {
            if ("retry_ms" in each) tx.tables.asks.backoff(family, each.item, each.prompt, each.retry_ms);
            else if ("given_up" in each) tx.tables.asks.giveUp(family, each.item, each.prompt, each.given_up);
            else if (stands(routeOf(each.ask), each, main.copies.level(each.ask.work_id))) tx.tables.asks.unhideable(family, each.item, each.prompt, each.unhideable);
          }
          kept.set(unit.unit, unit.sent.filter((ask) => {
            const handed = stands(routeOf(ask), { leaves: ask.copy?.receiver ?? null, level: ask.copy?.level ?? null }, main.copies.level(ask.work_id));
            if (!handed && ask.copy !== null) dropped.push(ask.copy.id);
            return handed;
          }));
          if (kept.get(unit.unit)!.length < unit.picked) tx.tables.dirty.wake(family, unit.unit);
        }
      },
      after() {
        for (const id of dropped) main.copies.drop(id);
        for (const [unit, sent] of kept) main.calls.sent(family, unit, sent);
      },
    }];
  },
  done(main, _tx, running) {
    main.calls.release(running.job.key);
  },
  failed(main, _tx, job) {
    main.calls.release(job.key);
  },
  stopped(main, _tx, running) {
    main.calls.release(running.job.key);
  },
};
