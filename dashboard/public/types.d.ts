
export type Road = 'poll' | 'chrome' | 'mac' | 'phone' | 'upload' | 'owner' | 'label';

export type Allowed = 'on' | 'limited' | 'off' | 'not-now' | 'not-asked' | 'asked' | 'asking';

export type State = 'off' | 'setup' | 'paused' | 'needs-you' | 'broken' | 'waiting' | 'quiet' | 'syncing' | 'ok';

export type Reason = 'form' | 'sign-in' | 'choose' | 'app' | 'grant' | 'pair' | 'export' | 'install'
  | 'signed-out' | 'other-account' | 'confirm' | 'password' | 'extension'
  | 'offline' | 'metered' | 'chrome' | 'provider-limit' | 'provider-making' | 'disk' | 'power' | 'vault' | 'retrying'
  | 'failing' | 'import' | 'provider-changed' | 'missing-file'
  | 'nothing-new' | 'device';

export type Requirement = 'form' | 'sign-in' | 'choose' | 'app' | 'grant' | 'pair' | 'export' | 'install';

export type Act =
  | { do: 'try' | 'skip' | 'let-go'; label: string; need: string }
  | { do: 'import'; label: string; kind: string }
  | { do: 'read' | 'ignore'; label: string; need: string; of: string }
  | { do: 'turn'; label: string; ids: string[] }
  | { do: 'signin'; label: string; of: string }
  | { do: 'refresh'; label: 'Check now'; of: string }
  | { do: 'set'; label: string; member: string }
  | { do: 'grant'; label: string; unit: string; grant: string }
  | { do: 'open'; label: string; url: string }
  | { do: 'browser'; label: string; of: string }
  | { do: 'copy'; label: string; text: string }
  | { do: 'report'; label: string; of: string }
  | { do: 'pair' | 'extension' | 'upload' | 'install' | 'storage' | 'vault'; label: string };

export interface Health {
  state: State;
  reason: Reason | null;
  words: string;
  line?: string;
  since_ms: number | null;
  next_ms: number | null;
  acts: Act[];
  detail: string | null;
}

export type SideHealth = Omit<Health, 'line'>;

export interface HomeClock {
  id: string;
  zone: string;
  start_hour: number;
  runs: { day: string; start_ms: number; days: number; zone: string }[];
}

export interface HomeSettings {
  zone: string;
  day_start_hour: number;
  helpers: number | 'auto';
  helpers_resolved: number;
  model_cap: number;
  model_cap_default: number;
  port: number;
  lan_port: number;
}

export interface StreamsReport {
  at_ms: number;
  day: string;
  needs: Need[];
  disk: { free_bytes: number; max_bundle_bytes: number };
  paused: PauseState[];
  home: { name: string; health: SideHealth; settings: HomeSettings };
  devices: DeviceRow[];
  extension: ExtensionRow;
  connectors: ConnectorReport[];
  setup: { skipped: string[]; at: string | null; you: boolean } | null;
  off: string[];
  imports: ImportReport[];
  adding: { prompt: string; blank: string };
  products: string | null;
  rows: import('./pages.js').StreamRow[];
  badge: { needs: number; asks: number };
}

export interface Need extends Omit<Health, 'line'> {
  id: string;
  line: string | null;
  state: 'needs-you' | 'broken';
  connector: string | null;
  streams: string[] | null;
  copy: string | null;
  unit: string | null;
  at: { site: string; open: string | null; errand: string | null } | null;
  weight: 'stopped' | 'advice';
  banner: boolean;
  dismissed: boolean;
  kind: 'password' | 'connect' | 'notice';
  about: string | null;
}

export interface DeviceRow {
  unit: string;
  kind: 'mac' | 'phone';
  name: string;
  health: SideHealth;
  contact_ms: number | null;
  grants: Record<string, Allowed> | null;
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

export interface ExtensionRow {
  name: string;
  health: SideHealth;
  placed: boolean;
  present: boolean;
  browsers: string[];
}

export interface PauseState {
  target: string;
  by: string;
  reason: string;
  at_ms: number;
  holds: string[] | null;
  title: string;
  line: string;
}

export interface StreamPause {
  scope: 'all' | 'history';
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
  state: 'syncing' | 'done';
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
  health: Health;
  held: number | null;
  newest_ms: number | null;
  oldest_ms: number | null;
  line: string;
  store: StoreState | null;
}

export type StoreState = 'asked' | 'allowed' | 'refused' | 'unsafe';

export interface RefreshNow {
  act: { do: 'refresh'; label: 'Check now'; of: string };
  blocked: { reason: 'running' | 'held' | 'paused' | 'offline' | 'chrome' | 'disk' | 'vault' | 'device'; words: string; until_ms: number | null } | null;
  asked: { unit: string; name: string }[];
}

export interface Way {
  road: Road;
  ready: boolean;
  requirements: { kind: Requirement; met: boolean; words: string; line: string | null; act: Act | null }[];
}

export interface ConnectorReport {
  id: string;
  type: { key: string; name: string; icon: string } | null;
  icon: string;
  name: string;
  product: string;
  noun: [string, string] | null;
  roads: Road[];
  shown: 'stream' | 'home' | null;
  records: string;
  gives: string;
  where: string | null;
  before: string[];
  health: Health;
  line: string;
  lead: string | null;
  line_parts: { words: string; time: import('./pages.js').When | null; more: string[] };
  figure: Figure | null;
  history: History | null;
  copies: Copy[];
  account: { name: string; line: string; copy: string | null } | null;
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
  routes: Route[];
  route: string | null;
  refresh_now: RefreshNow | null;
  origin: string | null;
  origins: string[] | null;
  browser: { unit: string; name: string } | null;
  signed_in: boolean | null;
  allowed: boolean | null;
  checking: boolean | null;
  chrome_account: ({ email: string } | { name: string }) & { verdict: 'read' | 'not-read' | 'offered' } | null;
  chosen: boolean | null;
  checking: boolean | null;
  choosing: 'allowing' | null;
  quiet: number | null;
  processing: Processing | null;
  backfill_about: string | null;
  joins?: Joins | null;
  callout: Need[];
  starter: boolean;
}

export interface Joins {
  name: string;
  icon: string;
  gives: string;
  apps: string[];
}

export interface Step {
  value: string;
  words: string;
  note: string | null;
}

export interface Processing {
  rows: ProcessingRow[];
}

export interface ProcessingRow {
  member: string;
  shape: 'off' | 'needs' | 'waiting' | 'running' | 'done' | null;
  line: string | null;
  privacy: ProcessingPrivacy | null;
}

export interface ProcessingPrivacy {
  member: string;
  value: string;
  words: string;
  steps: Omit<Step, 'offered'>[];
  note: string;
  waiting: boolean;
}

export type ModelKind = 'pictures' | 'audio' | 'text';

export type NamedLevel = 'all' | 'names' | 'none';

export type LinksSetting = 'tokens' | 'path' | 'none';

export interface DetailKind {
  type: string;
  one: string;
  many: string;
  subtypes: { type: string; one: string; many: string }[];
}

export type DetailCounts = Record<string, number>;

export interface OutboundTotal {
  receiver: string;
  day: string;
  items: number;
  hidden: number;
  counts: DetailCounts;
  rows: Partial<Record<OutboundWhat, number>>;
}

export type OutboundWhat = 'ask' | 'read' | 'text' | 'link' | 'lookup';

export interface OutboundRow {
  seq: number;
  at_ms: number;
  day: string;
  receiver: string;
  route: string | null;
  by: string | null;
  what: OutboundWhat;
  tool: string | null;
  level: NamedLevel | string[];
  counts: DetailCounts;
  chars: number;
  pictures: number;
  detector: string | null;
  key: string | null;
  attempt: number | null;
  refs: number;
  about?: 'chat-voice';
}

export interface OutboundList {
  rows: OutboundRow[];
  more: boolean;
  totals: OutboundTotal[];
}

export type OutboundRef = { source: string; kind: string; key: string } | { day: string };

export interface OutboundOne extends Omit<OutboundRow, 'refs'> {
  refs: OutboundRef[];
  sent: { body: string; pictures: unknown[] } | null;
}

export interface PrivacyRead {
  epoch: number;
  ready: boolean;
  line: string | null;
  detector: {
    model: string | null;
    file: string | null;
    state: 'off' | 'ready' | 'downloading' | 'absent';
    line: string | null;
    bytes?: number;
    total?: number;
  };
  marking: { marked: number; total: number; line: string } | null;
  level: 'all' | 'none';
  chat: NamedLevel;
  levels: Record<NamedLevel, string[]>;
  types: DetailKind[];
  links: LinksSetting;
  always: string[];
  never: string[];
  today: OutboundTotal[];
  voice?: { leaves: string | null };
}

export interface StartStop {
  day: string | null;
  months: number | null;
  bytes: number;
  more: boolean;
  streams: Record<string, number>;
}

export interface StartCost {
  start: string | null;
  first: string | null;
  disk: { free_bytes: number; keep_bytes: number };
  held_bytes: number;
  settled: boolean;
  stops: StartStop[];
}

export interface Made {
  by: string | null;
  at_ms: number | null;
  state: 'done' | 'off' | 'needs' | 'waiting' | 'failed';
  line: string | null;
  ask: { family: string; item: string; prompt: string } | null;
  choose: Step[];
}

export interface GuideStep { title?: string; words: string; open?: { label: string; url: string } }

export interface Route {
  id: string;
  acquirer: string;
  way: 'key' | 'device' | 'client';
  label: string;
  about?: string;
  steps: GuideStep[];
  note: string | null;
  fields: string[];
  sets: string[];
  client: { id: string; name: string; held: boolean; before: string[] } | null;
}

export type Control = 'menu' | 'zone' | 'toggle' | 'stepper' | 'path' | 'list' | 'text' | 'email' | 'date' | 'secret';

export type Panel = 'settings' | 'groups' | 'backfill' | 'account' | 'export' | 'comes-from';

export interface MemberState {
  key: string;
  kind: 'duration' | 'start' | 'choice' | 'number' | 'toggle' | 'list' | 'path' | 'zone' | 'secret' | 'email' | 'text' | 'date';
  label: string;
  about: string | null;
  value: unknown;
  words: string;
  from: 'person' | 'declaration' | 'unset';
  default: unknown;
  min?: number;
  max?: number;
  steps: Step[] | null;
  menu?: import('./pages.js').ModelMenu;
  route?: string | null;
  line?: string | null;
  panel: Panel | null;
  control: Control | null;
  where: { unit: string; name: string } | null;
  secret?: string;
  held?: boolean;
  folder?: true;
  items?: 'modes';
  add?: string;
  placeholder?: string;
  waiting?: { name: string; kind: 'mac' | 'phone'; line: string }[];
  only?: string | null;
}

export interface ExportRow { import: string; name: string; icon: string; opens: boolean; line: string }

export interface ImportReport {
  kind: string;
  name: string;
  icon: string;
  takes: string;
  wait: string | null;
  file: string;
  reads: string | null;
  products: { id: string; name: string }[];
  guide: GuideStep[];
  recognise: string[];
  leaves: string[];
  root?: string;
  lists?: 'backups';
  which?: ImportWhich[];
  drop: { words: string; line: string; choose: string; away: string };
  titles: { reads: string; guide: string; held: string };
  health: Health;
  line: string;
  coming: ImportFileReport[];
  held: ImportHeld[];
}

export interface ImportFileReport {
  id: string;
  name: string;
  bytes: number;
  state: 'checking' | 'refused' | 'waiting' | 'sending' | 'already' | 'sent' | 'missing' | 'held' | 'read' | 'kept';
  words: string;
  line: string;
  acts: Act[];
}

export interface ImportWhich {
  need: string;
  words: string;
  line: string;
  imports: string[];
  choices: { unit: string; words: string; line: string }[];
  choose: string;
}

export interface ImportAsk {
  words: string;
  choices: string[];
  other: boolean;
  choose: string;
  another: string;
}

export interface ImportHeld {
  id: string;
  account: string | null;
  made_at: string;
  name: string;
  health: Health;
  line: string;
  ask: ImportAsk | null;
  files: ImportFileReport[];
  products: { id: string; name: string; state: 'asked' | 'waiting' | 'reading' | 'read' | 'partly' | 'skipped' | 'not-read';
    count: number; line: string }[];
  span: { from: string; to: string } | null;
  open_day: string | null;
  open: string | null;
  downloaded: string | null;
  notice: { title: string; body: string } | null;
}


export type AccessLevel = NamedLevel | string[];

export type AccessReach =
  | { all: true; but: string[] }
  | { type: string; but: string[] }
  | { account: string; but: string[] }
  | { conversation: string; account: string };

export type AccessWindow = null | { since_ms: number } | { past_ms: number };

export interface Access {
  allow: { reach: AccessReach; window: AccessWindow; until_ms: number | null }[];
  items: { source: string; kind: string; key: string }[];
  not: { id: string; handles: string[] }[];
  only: { id: string; handles: string[] }[];
  window: AccessWindow;
  hide: AccessLevel;
  shown: ({ detail: string; until_ms: number | null } | { type: string; until_ms: number } | { level: AccessLevel; until_ms: number })[];
}

export type DraftEnd = { until_ms: number | null } | { lasts_ms: number };

export interface DraftAccess extends Omit<Access, 'allow' | 'shown'> {
  allow: ({ reach: AccessReach; window: AccessWindow } & DraftEnd)[];
  shown: (({ detail: string } & DraftEnd) | ({ type: string } & ({ until_ms: number } | { lasts_ms: number }))
    | ({ level: AccessLevel } & ({ until_ms: number } | { lasts_ms: number })))[];
}

export type Version = number;
export type Switch = 'on' | 'off' | 'some';
export type AskAnswer = 'once' | 'always' | 'no';
export type AskState = 'open' | 'allowed' | 'declined' | 'replaced' | 'dropped' | 'lapsed';
export type HideChoice = 'names' | 'all' | 'none' | 'custom';

export interface SignIn {
  id: string;
  name: string;
  checked: boolean;
  host: string | null;
  choices: number[];
  at_ms: number;
  until_ms: number;
  head: string;
  over_line: Phrase;
  sentence: string;
  access: Access;
  view: AccessView;
  pick: string;
  pick_line: string;
  over: string;
  app: string | null;
  notice: string;
}

export type Phrase = import('./pages.js').PhrasePart[];

export interface AgentAsk {
  id: string;
  reader: string;
  name: string;
  by: 'agent' | 'chat';
  head: string;
  line: string;
  asked_line: Phrase;
  under_line: Phrase;
  says_title: string;
  wants: string;
  today: Bolded;
  under: string | null;
  reason: string | null;
  screen: string | null;
  adds: string[];
  keeps: string | null;
  choices: { answer: AskAnswer; words: string }[];
  editable: boolean;
  default: AskAnswer;
  version: Version;
  proposed: DraftAccess;
  at_ms: number;
  until_ms: number;
  state: AskState;
  outcome: Phrase | null;
}

export type EditTarget = { reader: string } | { request: string } | { key: KeyApp };

export type KeyApp = 'grok-bot' | 'instinct' | 'another';

export type Edit =
  | { window: AccessWindow }
  | { type: string; on: boolean } | { type: string; window: AccessWindow }
  | { account: string; on: boolean } | { account: string; window: AccessWindow }
  | { mode: ReadsMode }
  | { hide: HideChoice }
  | { detail: string; hidden: boolean };

export interface Limit {
  value: { window: AccessWindow } | { mixed: true };
  words: string;
}

export interface AccessViewAccount {
  account: string;
  name: string;
  line: string | null;
  state: Switch;
  limit: Limit | null;
}

export interface AccessViewCategory {
  type: string;
  name: string;
  icon: string;
  line: string | null;
  state: Switch;
  limit: Limit | null;
  accounts: AccessViewAccount[];
  reads: KindReads | null;
  differs: string | null;
}

export interface KindReads {
  n: number;
  words: string;
}

export interface DetailState {
  type: string;
  name: string;
  state: 'hidden' | 'shown' | 'fixed';
}

export type ReadsMode = 'but' | 'only';

export interface AccessView {
  sentence: Bolded;
  summary: string;
  reads: string;
  mode: ReadsMode;
  modes: { mode: ReadsMode; words: string }[];
  mode_line: string;
  window: Limit;
  categories: AccessViewCategory[];
  times: { choice: 'all' | 'since' | 'past'; window: AccessWindow; words: string }[];
  hide: { choice: HideChoice; words: string; choices: HideOption[];
    types: (DetailState & { subtypes: DetailState[] })[] } | null;
  widens: boolean;
  widening: Bolded | null;
  screen: string | null;
}

export interface HideOption {
  level: HideChoice;
  words: string;
  line: string | null;
  selected: boolean;
}

export interface Narrowed {
  words: Bolded;
  undo: { access: Access; expect: Version };
}

export interface AccessDraft {
  access: DraftAccess;
  expect: Version | null;
  view: AccessView;
  narrowed: Narrowed | null;
  saved: { access: Access; view: AccessView } | null;
}

export interface EditRequest {
  target: EditTarget;
  access: DraftAccess;
  expect: Version | null;
  edit: Edit | null;
}

export interface AgentReads {
  last_ms: number | null;
  last: string | null;
  line: string;
  short: string;
  today: number;
  total: number;
  since: string | null;
  days: { day: string; words: string; n: number }[];
}

export type AgentState = 'connected' | 'disconnected';

export interface Ended {
  icon: string;
  name: string;
  line: string;
}

export interface Disconnecting {
  head: string;
  line: string;
  stops: Ended[];
  stays: Ended[];
  confirm: string;
}

export interface ReadsFigure {
  today: number;
  words: string;
  days: { day: string; words: string; n: number }[];
  said: Bolded;
}

export interface Unlisting {
  ask: string;
  line: string;
}

export interface AgentRow {
  id: string;
  name: string;
  kind: 'chat' | 'agent';
  state: AgentState;
  summary: string;
  place: string;
  reads: AgentReads;
  has_ask: boolean;
  mark: string;
}

export interface AgentsList {
  readers: AgentRow[];
}

export type Guide = import('./pages.js').Guide;
export type GuideStep = import('./pages.js').GuideStep;
export type GuideValue = import('./pages.js').GuideValue;
export type GuideLink = import('./pages.js').GuideLink;
export type GuideAddress = import('./pages.js').GuideAddress;
export type AgentGuides = import('./pages.js').AgentGuides;

export type AddressFix = { label: string; to: 'web' | 'tailscale' | 'turn-on'; url: string | null };

export type AgentAddress =
  | { state: 'on'; url: string; line: string }
  | { state: 'off'; url: string | null }
  | { state: 'fix'; url: null; words: string; act: AddressFix | null };

export interface Connected {
  reader: string;
  line: string;
}

export interface MadeKey {
  reader: string;
  name: string;
  rows: { label: string; text: string }[];
  connected: Connected;
}

export interface KeyRequest {
  app: KeyApp;
  name?: string;
  access: DraftAccess;
}

export interface AgentRead {
  id: string;
  name: string;
  kind: 'chat' | 'agent';
  state: AgentState;
  how: string;
  place: string;
  disconnected: string | null;
  figure: ReadsFigure;
  mark: string;
  disconnect: Disconnecting | null;
  unlist: Unlisting | null;
  reads: AgentReads;
  access: Access;
  version: Version;
  view: AccessView;
  ask: AgentAsk | null;
  recent: { lines: HistoryRead[]; all: string | null };
}

export interface CameKind {
  kind: string;
  name: string;
  icon: string;
  n: number;
  words: string;
}

export interface HistoryRead {
  kind: 'call';
  id: string;
  at_ms: number;
  icon: string;
  tone: 'plain' | 'refused';
  words: string;
  line: string | null;
  kept: string | null;
  opens: boolean;
  more: number;
  took_ms: number | null;
  told: string | null;
}

export interface HistoryChange {
  kind: 'change';
  at_ms: number;
  icon: string;
  words: string;
  line: string | null;
  ask: string | null;
  tone: 'plain' | 'waiting';
}

export interface HistoryFold {
  kind: 'fold';
  at_ms: number;
  n: number;
  icon: string;
  words: string;
  line: string;
  lines: HistoryRead[];
  continues: boolean;
}

export type HistoryLine = HistoryRead | HistoryChange | HistoryFold;

export interface HistorySession {
  key: string;
  from_ms: number;
  to_ms: number;
  day: { day: string; words: string; reads: string | null };
  calls: number;
  reads: string | null;
  lines: HistoryLine[];
}

export interface Chip {
  kind: string;
  name: string;
  icon: string;
  n: number;
}

export interface HistoryPage {
  figure: ReadsFigure | null;
  chips: Chip[];
  kind: string | null;
  empty: { title: string; line: string } | null;
  sessions: HistorySession[];
  next: { before: string; words: string } | null;
}

export type Bolded = { text: string; bold?: true }[];

export interface KeptRow {
  type: string;
  name: string;
  value: string;
}

export interface ReadPage {
  id: string;
  reader: string;
  name: string;
  title: string;
  line: string;
  figure: { n: number; words: string } | null;
  kinds: CameKind[];
  kept: { about: string; rows: KeptRow[]; held: string | null } | null;
  why: Bolded | null;
  refused: string | null;
  show: { words: string; n: number } | null;
}

export interface Thing {
  ref: string;
  title: string;
  line: string | null;
  when: string | null;
  day: string | null;
  at_ms: number | null;
  opens: { page: 'days'; day: string; focus?: string } | { page: 'people' | 'places'; id: string } | { page: 'read' };
}

export interface ThingsPage {
  title: string;
  gone: string | null;
  groups: { kind: string; name: string; icon: string; n: number; things: Thing[] }[];
  next: string | null;
}

export type AnswerRequest =
  | { id: string; answer: number; access?: Access }
  | { id: string; answer: 'deny' }
  | { id: string; answer: 'once' | 'always'; expect: Version; access?: DraftAccess }
  | { id: string; answer: 'no' };

export interface SignInRead {
  id: string;
  state: 'waiting' | 'approved' | 'wrong' | 'denied' | 'gone';
  outcome: Phrase | null;
  reader: string | null;
  connected: Connected | null;
}

export interface AnswerReply {
  state: 'approved' | 'wrong' | 'denied' | AskState;
  version: Version | null;
  outcome: Phrase | null;
  reader: string | null;
  connected: Connected | null;
}

export type AccessChange =
  | ({ id: string; kind: 'narrowed'; reader: string } & Narrowed)
  | { id: string; kind: 'unchanged'; reader: string; words: string }
  | { id: string; kind: 'asked'; snapshot: AgentAsk };

export interface AccessEvent {
  type: 'access';
  change: AccessChange;
}
