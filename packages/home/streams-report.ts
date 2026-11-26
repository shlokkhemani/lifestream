import type { ExportRow, ImportReport } from "./imports-report.js";
import type { Choosing, Field, GuideStep, Road, SignIn, SiteAccount } from "@lifestreamprotocol/connect";
import type { Json, Type } from "@lifestreamprotocol/core";
import type { Health, Requirement } from "./health.js";
import type { Pause } from "./jobs.js";
import type { Grants } from "./stated.js";
import type { ModelMenu, When } from "./pages.js";
import type { RefreshBlocked } from "./wire.js";

export interface StreamsReport {
  at_ms: number;
  day: string;
  products: string;
  needs: Need[];
  disk: { free_bytes: number; max_bundle_bytes: number };
  paused: PauseState[];
  home: HomeRow;
  devices: DeviceRow[];
  extension: ExtensionRow;
  connectors: ConnectorReport[];
  setup: { skipped: string[]; at: string | null; you: boolean } | null;
  off: string[];
  imports: ImportReport[];
  adding: { prompt: string; blank: string };
}

export type Act =
  | { do: "try" | "skip" | "let-go"; label: string; need: string }
  | { do: "import"; label: string; kind: string }
  | { do: "read" | "ignore"; label: string; need: string; of: string }
  | { do: "turn"; label: string; ids: string[] }
  | { do: "signin"; label: string; of: string }
  | { do: "refresh"; label: "Check now"; of: string }
  | { do: "set"; label: string; member: string }
  | { do: "grant"; label: string; unit: string; grant: string }
  | { do: "open"; label: string; url: string }
  | { do: "copy"; label: string; text: string }
  | { do: "browser"; label: string; of: string }
  | { do: "report"; label: string; of: string }
  | { do: "pair" | "extension" | "upload" | "install" | "storage" | "vault" | "verify"; label: string };

export type Raised = Health<Act> & {
  id: string;
  state: "needs-you" | "broken";
  connector: string | null;
  streams?: string[];
  copy: string | null;
  unit: string | null;
  at: { site: string; open: string | null; errand: string | null } | null;
};

export type Weight = "stopped" | "advice";

export type NeedKind = "password" | "connect" | "notice";

export type Need = Raised & { weight: Weight; banner: boolean; dismissed: boolean; kind: NeedKind; about: string | null };

export interface DeviceRow {
  unit: string;
  kind: "mac" | "phone";
  name: string;
  health: Health<Act>;
  contact_ms: number | null;
  grants: Grants | null;
  found: string[] | null;
  pass: string | null;
  replaced: string[];
  retired: boolean;
  streams: DeviceStream[];
}

export interface DeviceStream {
  id: string;
  line: string;
}

export interface StreamPause {
  scope: "all" | "history";
  by: string;
  reason: string;
  at_ms: number;
}

export interface Figure {
  today: number | null;
  week: number[] | null;
  checked_ms: number | null;
  words: string;
  last_ms: number | null;
  last: string | null;
}

export interface History {
  state: "syncing" | "done";
  back_to_ms: number | null;
  left: number | null;
  unit: [string, string] | null;
  eta_ms: number | null;
  done: number | null;
  total: number | null;
  progress: string | null;
  words: string;
  arriving: string;
  start: { day: string | null; own: boolean } | null;
}

export interface Copy {
  id: string;
  name: string;
  road: Road;
  unit: string | null;
  on: boolean;
  retired: boolean;
  health: Health<Act>;
  held: number | null;
  newest_ms: number | null;
  oldest_ms: number | null;
  line: string;
  store: StoreState | null;
}

export type StoreState = "asked" | "allowed" | "refused" | "unsafe";

export interface RefreshNow {
  act: { do: "refresh"; label: "Check now"; of: string };
  blocked: RefreshBlocked | null;
  asked: { unit: string; name: string }[];
}

export interface Way {
  road: Road;
  ready: boolean;
  requirements: { kind: Requirement; met: boolean; words: string; line: string | null; act: Act | null }[];
}


export interface LineParts {
  words: string;
  time: When | null;
  more: string[];
}

export interface ConnectorReport {
  id: string;
  type: { key: Type; name: string; icon: string } | null;
  icon: string;
  name: string;
  product: string;
  noun: [string, string] | null;
  starter: boolean;
  roads: Road[];
  shown: Shown;
  records: string;
  gives: string;
  where: string | null;
  before: string[];

  health: Health<Act>;
  line: string;
  lead: string | null;
  line_parts: LineParts;
  figure: Figure | null;
  history: History | null;

  copies: Copy[];
  account: AccountRow | null;
  export: ExportRow | null;
  ways: Way[];
  set_up: boolean;
  pauses: StreamPause[];
  sensor: boolean;
  recorder: boolean;
  mac_grants: string[];
  mac_copy: string | null;
  phone_screen: number | null;
  on: boolean;

  members: MemberState[];
  processing: Processing | null;
  backfill_about: string | null;
  routes: RouteState[];
  route: string | null;
  refresh_now: RefreshNow | null;

  origin: string | null;
  origins: string[] | null;
  browser: { unit: string; name: string } | null;
  signed_in: boolean | null;
  allowed: boolean | null;
  chrome_account: SiteAccount | null;
  chosen: boolean | null;
  checking: boolean | null;
  choosing: Choosing;

  quiet: number | null;
  joins: Joins | null;
}

export interface Joins {
  name: string;
  icon: string;
  gives: string;
  apps: string[];
}

export type PauseState = Omit<Pause, "holds"> & { holds: string[] | null; title: string; line: string };

export interface HomeRow {
  name: string;
  health: Health<Act>;
  settings: HomeSettings;
}

export interface HomeSettings {
  zone: string;
  day_start_hour: number;
  helpers: number | "auto";
  helpers_resolved: number;
  model_cap: number;
  model_cap_default: number;
  port: number;
  lan_port: number;
}

export interface ExtensionRow {
  name: string;
  health: Health<Act>;
  placed: boolean;
  present: boolean;
  browsers: string[];
}

export type Shown = "stream" | "home" | null;

export interface RouteState {
  id: string;
  acquirer: string;
  way: SignIn["way"];
  label: string;
  about?: string;
  steps: GuideStep[];
  note: string | null;
  fields: string[];
  sets: string[];
  client: RouteClient | null;
}

export interface RouteClient {
  id: string;
  name: string;
  held: boolean;
  before: string[];
}

export interface AccountRow {
  name: string;
  line: string;
  copy: string | null;
}

export type Panel = "settings" | "groups" | "backfill" | "account" | "export" | "comes-from";

export const CONTROLS = ["menu", "zone", "toggle", "stepper", "path", "list", "text", "email", "date", "secret"] as const;
export type Control = (typeof CONTROLS)[number];

export interface MemberState {
  key: string;
  kind: "start" | Field["kind"];
  label: string;
  about: string | null;
  value: Json | null;
  words: string;
  from: "person" | "declaration" | "unset";
  default: Json | null;
  min?: number;
  max?: number;
  steps: Step[] | null;
  menu?: ModelMenu;
  route?: string | null;
  line?: string | null;
  panel: Panel | null;
  control: Control | null;
  where: { unit: string; name: string } | null;
  secret?: string;
  held?: boolean;
  folder?: true;
  items?: "modes";
  add?: string;
  placeholder?: string;
  waiting?: Waiting[];
  only?: string | null;
}

export type ProcessingShape = "off" | "needs" | "waiting" | "running" | "done";

export interface Processing {
  rows: { member: string; shape: ProcessingShape | null; line: string | null; privacy: PrivacyRow | null }[];
}

export interface PrivacyRow {
  member: string;
  value: string;
  words: string;
  steps: Step[];
  note: string;
  found?: string;
  waiting: boolean;
}

export interface Made {
  by: string | null;
  at_ms: number | null;
  state: "done" | "off" | "needs" | "waiting" | "failed";
  line: string | null;
  ask: { family: string; item: string; prompt: string } | null;
  choose: Step[];
}

export interface Step {
  value: string;
  words: string;
  note: string | null;
}

export interface Waiting {
  name: string;
  kind: "mac" | "phone";
  line: string;
}
