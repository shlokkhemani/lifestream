import type { Work } from "@lifestreamprotocol/connect";
import { addDays, civilDay, dayBounds, selects, type JsonObject, type ReadTables, type SourceRow } from "@lifestreamprotocol/core";
import type { Family } from "@lifestreamprotocol/families";
import { MODEL_USES, unfit, workNeed, type Rates } from "@lifestreamprotocol/model";
import { PRIVACY_MEMBER, type NamedLevel, type PrivacySettings } from "@lifestreamprotocol/privacy";
import { AUDIO_LINE, HIDING_META, sentLevel, type HidingWaits } from "./copies.js";
import { extractCursor } from "./derive.js";
import { inUseOf, MENU, menuOf, modelMenu } from "./models-read.js";
import { heldBy, NO_MODEL, opening, RANGE_MEMBER, readRouting, storedModels, WORK_MEMBER, workId, type Defaults, type ModelRoute, type Routing, type RoutingAt, type StoredRunner, type WorkNeeds, type WorkRouting } from "./models.js";
import { aboutLeft, amount, leftWords, NB, number } from "./stream-words.js";
import type { ModelMenu } from "./pages.js";
import type { History, PrivacyRow, Processing, ProcessingShape, Step } from "./streams-report.js";

const MONTH_DAYS = 30;
const YEAR_DAYS = 365;

const STEP_WORDS = {
  off: "Off",
  default: "Default",
  today: "New only",
  month: "Last 30 days",
  year: "Last year",
  all: "All time",
  nothing: "Nothing to read",
  counting: "Counting…",
} as const;
const COUNTING_WORDS = "Counting what's left";

export interface ProcessingInput extends RoutingAt {
  families: readonly Pick<Family, "name" | "works" | "inputs">[];
  histories: ReadonlyMap<string, Pick<History, "state" | "back_to_ms">>;
  typed?: string;
  privacy: PrivacySettings;
}

const LEVEL_WORDS: Record<NamedLevel, { step: string; words: string; note: string }> = {
  all: { step: "Hide all", words: "Personal details hidden", note: "Names, numbers and faces are replaced. The model still reads what was said." },
  names: { step: "Keep names", words: "Personal details hidden", note: "Numbers and faces are replaced; names are sent as they are. The model still reads what was said." },
  none: { step: "Don't hide", words: "Sent as it is", note: "Everything is sent as it is." },
};

export const NO_VOICE = "Choose a model for Voice notes";
export const VOICE_OFF = "Voice notes are turned off";

export interface ProcessingMember {
  label: string;
  about: string | null;
  words: string;
  steps: Step[] | null;
  menu?: ModelMenu;
  route?: string | null;
  line?: string | null;
}

export interface WorkState {
  connector: string;
  member: string;
  label: string;
  shape: ProcessingShape;
  line: string;
}

export interface StreamProcessing {
  set_up: boolean;
  part: Processing;
  members: ReadonlyMap<string, ProcessingMember>;
  typed: string | null;
}

export type ProcessingTables = Pick<ReadTables, "meta" | "sources" | "itemRoutes" | "asks" | "dirty" | "cursors" | "statements">;

interface Counted {
  id: string;
  name: string;
  work: Work;
  route: ModelRoute | null;
  left: ReadonlyMap<string, number>;
  power: number;
  from: ReadonlyMap<string | null, ReadonlyMap<string, number>>;
  growing: Growing;
}

interface Growing {
  through: number | null;
  arriving: number | null;
}

export function readProcessing(tables: ProcessingTables, rates: Rates | null, input: ProcessingInput): Map<string, StreamProcessing> {
  const declaring = input.connectors.filter((connector) => Object.keys(connector.processing ?? {}).length > 0);
  const read = new Map<string, StreamProcessing>();
  if (declaring.length === 0) return read;
  const routing = readRouting(tables, input);
  const today = civilDay(input.now_ms, input.day);
  const days: (string | null)[] = [today, addDays(today, -MONTH_DAYS), addDays(today, -YEAR_DAYS), null, ...input.typed === undefined ? [] : [input.typed]];
  const startOf = (day: string | null) => (day === null ? null : dayBounds(day, input.day).start_ms);
  const routes = Object.values(routing.routes);
  const held = heldBy(input.connectors, tables.sources.list());
  const growingOf = growing(tables, input, held);
  const settings = { privacy: input.privacy, connectors: input.blocks };
  const waits = JSON.parse(tables.meta.get(HIDING_META) ?? "{}") as HidingWaits;
  const inUse = inUseOf({ defaults: input.defaults, blocks: input.blocks });
  const { runners } = storedModels(tables.meta);
  const counted = new Map(declaring.map((connector) => [connector.id, Object.entries(connector.processing!).map(([name, work]): Counted => {
    const id = workId(connector.id, name);
    const at = routing.works[id]!;
    const starts = [at.start_ms, Math.max(at.start_ms ?? Number.MIN_SAFE_INTEGER, at.power_ms ?? Number.MIN_SAFE_INTEGER), ...days.map(startOf)];
    const kept = tables.asks.left(id, starts.map((start) => start ?? Number.MIN_SAFE_INTEGER));
    const rows = kept ?? [];
    const count = (index: number) => new Map(rows.filter((row) => row.from[index]! > 0).map((row) => [row.prompt, row.from[index]!]));
    const left = count(1);
    const growing = growingOf(connector.id, name);
    return {
      id, name, work, route: at.value === "off" || at.route === null ? null : routing.routes[at.route] ?? null,
      left, power: sum(count(0)) - sum(left), from: new Map(days.map((day, index) => [day, count(index + 2)])),
      growing: kept === null ? { ...growing, through: Number.MAX_SAFE_INTEGER } : growing,
    };
  })]));
  const onRoute = new Map<string, number>();
  for (const works of counted.values()) for (const { route, left } of works) if (route !== null) onRoute.set(route.id, (onRoute.get(route.id) ?? 0) + sum(left));
  for (const connector of declaring) {
    const works = counted.get(connector.id)!;
    const start_ms = routing.works[works[0]!.id]!.start_ms;
    const note = (day: string | null) => noteOf(works, day, startOf(day), rates);
    const sent = (id: string) => sentLevel(settings, input.connectors, id);
    const members = new Map<string, ProcessingMember>(works.flatMap(({ id, name, work, route }): [string, ProcessingMember][] => [
      [`${WORK_MEMBER}${name}`, {
        label: work.label, about: work.about, ...memberWords({ ...work, id }, routing.works[id]!, route, routes, input.defaults, runners, inUse),
      }],
      [`${PRIVACY_MEMBER}${name}`, { label: `${work.label}: personal details`, about: null, ...levelWords(sent(id), input.privacy.level) }],
    ]));
    members.set(RANGE_MEMBER, {
      label: "Read back to", about: null,
      words: start_ms === null ? STEP_WORDS.all : dateWords(civilDay(start_ms, input.day)),
      steps: [
        { day: today, words: STEP_WORDS.today }, { day: addDays(today, -MONTH_DAYS), words: STEP_WORDS.month }, { day: addDays(today, -YEAR_DAYS), words: STEP_WORDS.year },
        { day: null, words: STEP_WORDS.all },
      ].map(({ day, words }) => ({ value: day ?? "all", words, note: note(day) })),
    });
    read.set(connector.id, {
      set_up: held.has(connector.id),
      part: {
        rows: [
          ...works.map((each) => {
            const { hiding, ...state } = stateOf(each, routing, routes, tables, rates, onRoute, sent(each.id), waits);
            return {
              member: `${WORK_MEMBER}${each.name}`, ...state,
              privacy: each.route?.leaves == null ? null : { ...privacyRow(each, input.blocks[connector.id], sent(each.id), input.privacy.level), waiting: hiding },
            };
          }),
          { member: RANGE_MEMBER, shape: null, line: null, privacy: null },
        ],
      },
      members,
      typed: input.typed === undefined ? null : note(input.typed),
    });
  }
  return read;
}

export function worksOn(processing: ReadonlyMap<string, StreamProcessing>): WorkState[] {
  return [...processing].flatMap(([connector, stream]) => !stream.set_up ? [] : stream.part.rows.flatMap(({ member, shape, line }) =>
    shape === null || shape === "off" || line === null ? [] : [{ connector, member, label: stream.members.get(member)!.label, shape, line }]));
}

function stateOf(counted: Counted, routing: Routing, routes: readonly ModelRoute[], tables: ProcessingTables, rates: Rates | null, onRoute: ReadonlyMap<string, number>,
  level: NamedLevel, hidingWaits: HidingWaits): { shape: ProcessingShape; line: string | null; hiding: boolean } {
  if (routing.works[counted.id]!.value === "off") return { shape: "off", line: null, hiding: false };
  const given = tables.asks.givenUp(counted.id).length;
  const { route, left, power, work } = counted;
  const unhidden = tables.asks.unhideables(counted.id);
  const audio = unhidden.some((each) => each.why === AUDIO_LINE);
  const unread = unhidden.reduce((total, each) => total + (each.why === AUDIO_LINE ? 0 : each.count), 0);
  const tail = [
    ...given === 0 ? [] : [`${number(given)}${NB}could not be processed`],
    ...audio ? [AUDIO_LINE.slice(0, AUDIO_LINE.indexOf("."))] : [],
    ...unread === 0 ? [] : [`${amount(unread, work.noun)} could not be read`],
  ];
  const lined = (shape: ProcessingShape, line: string, hiding = false) => ({ shape, line: [line, ...tail].join(" · "), hiding });
  if (route === null) return lined("needs", needsWords(work, routes));
  if (route.state !== "ready") return lined("waiting", route.line);
  const hiding = route.leaves === null || level === "none" ? undefined : hidingWaits[level];
  if (hiding !== undefined) return lined("waiting", hiding, true);
  const count = sum(left);
  const waits = power === 0 || route.runner === null ? null : `${amount(power, work.noun)} waiting ${powerWords(route.runner)}`;
  if (counts(counted.growing, routing.works[counted.id]!.start_ms)) {
    return lined("running", [COUNTING_WORDS, ...count === 0 ? [] : [`${amount(count, work.noun)} so far`], ...waits === null ? [] : [waits]].join(" · "));
  }
  if (count === 0) return waits === null ? lined("done", "Up to date") : lined("waiting", opening(waits));
  const pace = rates?.pace(route.transport, route.model) ?? null;
  const cost = route.cost === "priced" ? costOf(left, route, rates) : null;
  return lined("running", [
    leftWords(count, work.noun), ...pace === null ? [] : [aboutLeft(onRoute.get(route.id)! / pace)], ...cost === null ? [] : [dollars(cost)], ...waits === null ? [] : [waits],
  ].join(" · "));
}

function levelWords(level: NamedLevel, home: PrivacySettings["level"]): { words: string; steps: Step[] } {
  return {
    words: LEVEL_WORDS[level].words,
    steps: [
      { value: "default", words: STEP_WORDS.default, note: LEVEL_WORDS[home].step },
      ...(["all", "names", "none"] as const).map((each) => ({ value: each, words: LEVEL_WORDS[each].step, note: LEVEL_WORDS[each].note })),
    ],
  };
}

function privacyRow(counted: Counted, block: JsonObject | undefined, level: NamedLevel, home: PrivacySettings["level"]): Omit<PrivacyRow, "waiting"> {
  const member = `${PRIVACY_MEMBER}${counted.name}`;
  const value = block?.[member];
  return { member, value: typeof value === "string" ? value : "default", ...levelWords(level, home), note: LEVEL_WORDS[level].note };
}

export function powerWords(runner: { name: string }): string {
  return `until ${runner.name} is plugged in`;
}

function noteOf(works: readonly Counted[], day: string | null, start_ms: number | null, rates: Rates | null): string {
  const parts: string[] = [];
  let usd: number | null = null;
  let unknown = false;
  let open = false;
  for (const each of works) {
    const { work, route, from } = each;
    const rows = from.get(day);
    if (route === null || rows === undefined) continue;
    const grows = counts(each.growing, start_ms);
    open ||= grows;
    if (sum(rows) === 0) continue;
    parts.push(grows ? `${amount(sum(rows), work.noun)} so far` : amount(sum(rows), work.noun));
    if (route.cost !== "priced") continue;
    const cost = costOf(rows, route, rates);
    if (cost === null) unknown = true;
    else usd = (usd ?? 0) + cost;
  }
  if (parts.length === 0) return open ? STEP_WORDS.counting : STEP_WORDS.nothing;
  return [...parts, ...usd === null || unknown || open ? [] : [dollars(usd)]].join(" · ");
}

function counts({ through, arriving }: Growing, start_ms: number | null): boolean {
  const start = start_ms ?? Number.MIN_SAFE_INTEGER;
  return (through !== null && through >= start) || (arriving !== null && start < arriving);
}

function growing(tables: ProcessingTables, input: Pick<ProcessingInput, "families" | "histories">, held: ReadonlyMap<string, readonly SourceRow[]>):
  (connector: string, work: string) => Growing {
  const extracting = new Map<string, boolean>();
  const planning = new Map<string, number | null>();
  const owes = (family: ProcessingInput["families"][number], source: SourceRow): boolean => {
    const key = `${family.name}\0${source.id}`;
    if (!extracting.has(key)) {
      const seq = tables.cursors.get(extractCursor(family.name))?.seq ?? 0;
      const kinds = new Set(family.inputs.filter((each) => selects(each.sources, source)).flatMap((each) => each.kinds));
      extracting.set(key, [...kinds].some((kind) => tables.statements.after(source.id, kind, seq)));
    }
    return extracting.get(key)!;
  };
  const planned = (family: string): number | null => {
    if (!planning.has(family)) planning.set(family, tables.dirty.newestOwed(family) ?? null);
    return planning.get(family)!;
  };
  return (connector, work) => {
    let through: number | null = null;
    for (const family of input.families) {
      const selector = family.works?.[work];
      const own = selector === undefined ? [] : (held.get(connector) ?? []).filter((source) => selects(selector, source));
      if (own.length === 0) continue;
      const end = own.some((source) => owes(family, source)) ? Number.MAX_SAFE_INTEGER : planned(family.name);
      if (end !== null) through = Math.max(through ?? end, end);
    }
    const history = input.histories.get(connector);
    return { through, arriving: history?.state === "syncing" ? history.back_to_ms ?? Number.MAX_SAFE_INTEGER : null };
  };
}

export function memberWords(work: WorkNeeds & { id: string }, at: Pick<WorkRouting, "value" | "as_is">, route: ModelRoute | null, routes: readonly ModelRoute[], defaults: Defaults,
  runners: readonly StoredRunner[], held: ReadonlySet<string>): { words: string; steps: null; menu: ModelMenu; route: string | null; line?: string | null } {
  const { value } = at;
  const named = routes.find((each) => each.id === defaults[work.kind]);
  const unset = defaults[work.kind] === null && MODEL_USES[work.kind].fill === null ? STEP_WORDS.off : NO_MODEL;
  const byId = new Map(routes.map((each) => [each.id, each]));
  const listed = menuOf(routes, work.kind, new Set([...held, value])).map((id) => byId.get(id)!).filter((each) => unfit(each, workNeed(work)) === null);
  const menu = modelMenu(listed, runners, {
    use: work.kind, work: work.id, chosen: value, off: "off",
    defaulted: { value: "default", name: named !== undefined && unfit(named, workNeed(work)) === null ? named.name : null },
  });
  if (value === "off") return { words: STEP_WORDS.off, steps: null, menu, route: null, ...asIsLine(at, null) };
  return { words: route === null ? value === "default" ? unset : NO_MODEL : value === "default" ? MENU.default(route.name) : route.name, steps: null, menu, route: route?.id ?? null, ...asIsLine(at, route) };
}

function asIsLine(at: Pick<WorkRouting, "value" | "as_is">, route: ModelRoute | null): { line?: string | null } {
  if (at.as_is !== true) return {};
  return { line: at.value === "off" ? VOICE_OFF : route === null ? NO_VOICE : null };
}

export function needsWords(work: WorkNeeds, routes: readonly ModelRoute[]): string {
  const ofKind = routes.filter((route) => unfit(route, MODEL_USES[work.kind].need) === null);
  if (ofKind.length > 0 && !ofKind.some((route) => unfit(route, workNeed(work)) === null)) return "Needs a model for long text";
  return `Connect a model that takes ${work.kind}`;
}

function costOf(rows: ReadonlyMap<string, number>, route: Pick<ModelRoute, "model">, rates: Rates | null): number | null {
  let usd = 0;
  for (const [prompt, count] of rows) {
    const price = rates?.price(prompt, route.model) ?? null;
    if (price === null) return null;
    usd += count * price;
  }
  return usd;
}

const sum = (rows: ReadonlyMap<string, number>): number => [...rows.values()].reduce((total, count) => total + count, 0);

function dateWords(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function dollars(usd: number): string {
  return usd < 0.5 ? `under${NB}$1` : `about${NB}$${number(Math.round(usd))}`;
}
