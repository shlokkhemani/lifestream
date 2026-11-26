import type { Road } from "@lifestreamprotocol/connect";
import { refreshQuiet, STATES, WINDOWS, type Outcome, type Reason, type State } from "./health.js";

export interface Ran {
  outcome: Outcome;
  reason: Reason | null;
  since_ms: number | null;
  fails: number;
  next_ms: number | null;
  facts: Readonly<Record<string, unknown>>;
  act: string | null;
  id: string;
  detail: string | null;
}

export interface CopyFacts {
  road: Road;
  on: boolean;
  outcomes: readonly Ran[];
  contact_ms: number | null;
  device: { trouble: Folded | null } | null;
  newest_ms: number | null;
  refresh_ms: number | null;
  expect_ms: number | null;
  owed: boolean;
  disk: boolean;
  pastWaits: boolean;
}

export interface Folded {
  state: State;
  reason: Reason | null;
  since_ms: number | null;
  next_ms: number | null;
  facts: Readonly<Record<string, unknown>>;
  id: string | null;
  act: string | null;
  detail: string | null;
}

const rank = (state: State): number => STATES.indexOf(state);
const plain = (state: State, reason: Reason | null = null, since_ms: number | null = null, facts: Folded["facts"] = {}): Folded =>
  ({ state, reason, since_ms, next_ms: null, facts, id: null, act: null, detail: null });

export function ranState(ran: Ran, road: Road, now: number): Folded | null {
  const window = WINDOWS[road];
  const at = { since_ms: ran.since_ms, next_ms: ran.next_ms, facts: ran.facts, id: ran.id, act: ran.act, detail: ran.detail };
  switch (ran.outcome) {
    case "ok": return null;
    case "need": return { state: "needs-you", reason: ran.reason, ...at };
    case "wait": return { state: "waiting", reason: ran.reason, ...at, id: null };
    case "fail":
      return ran.fails === Infinity || (ran.fails >= window.fails && ran.since_ms !== null && now - ran.since_ms >= window.fail_ms) ? { state: "broken", reason: ran.reason ?? "failing", ...at }
        : { state: "waiting", reason: "retrying", ...at, id: null };
  }
}

export function worst(healths: readonly Folded[]): Folded | null {
  return healths.reduce<Folded | null>((best, each) => (best === null || rank(each.state) < rank(best.state) ? each : best), null);
}

export function foldCopy(copy: CopyFacts, now: number): { health: Folded; troubles: Folded[] } {
  if (!copy.on) return { health: plain("off"), troubles: [] };
  const ran = copy.outcomes.flatMap((each) => ranState(each, copy.road, now) ?? []);
  const troubles = ran.filter((each) => each.state === "needs-you" || each.state === "broken");
  const window = WINDOWS[copy.road].quiet_ms;
  const quiet_ms = window === "refresh" ? copy.refresh_ms === null ? null : refreshQuiet(copy.refresh_ms) : window;
  const device = copy.device?.trouble ?? null;
  const silent = copy.device !== null ? device?.state === "quiet" : quiet_ms !== null && copy.contact_ms !== null && now - copy.contact_ms > quiet_ms;
  const stale = !silent && copy.contact_ms !== null && copy.expect_ms !== null && copy.newest_ms !== null && now - copy.newest_ms > copy.expect_ms;
  const health = worst([
    ...ran,
    ...device === null ? [] : [{ ...device, id: null, act: null }],
    ...copy.device === null && silent ? [plain("quiet", "device", copy.contact_ms, { since_ms: copy.contact_ms })] : [],
    ...stale ? [plain("quiet", "nothing-new", copy.newest_ms, { since_ms: copy.newest_ms })] : [],
    ...copy.disk ? [plain("waiting", "disk")] : [],
    ...copy.pastWaits ? [plain("waiting", "metered")] : [],
    ...copy.owed ? [plain("syncing")] : [],
  ]) ?? plain("ok");
  return { health, troubles };
}

export interface ConnectorFacts {
  on: boolean;
  unmet: Folded | null;
  paused_ms: number | null;
  copies: readonly Folded[];
}

export function foldConnector(connector: ConnectorFacts): Folded {
  if (!connector.on) return plain("off");
  if (connector.unmet?.state === "setup") return connector.unmet;
  if (connector.paused_ms !== null) return plain("paused", null, connector.paused_ms);
  return worst([...connector.copies, ...connector.unmet === null ? [] : [connector.unmet]]) ?? plain("ok");
}

