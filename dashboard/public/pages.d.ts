export interface AccountStep {
  start_ms: number;
  end_ms: number;
  present: string | null;
  task: string | null;
  where: string | null;
  doing: string | null;
  actions: MomentAction[];
}

export interface AccountTask {
  task: string;
  seconds: number;
}

export type Act =
  | {
    do: "try";
    label: string;
    need: string;
  }
  | {
    do: "skip";
    label: string;
    need: string;
  }
  | {
    do: "let-go";
    label: string;
    need: string;
  }
  | {
    do: "import";
    label: string;
    kind: string;
  }
  | {
    do: "read";
    label: string;
    need: string;
    of: string;
  }
  | {
    do: "ignore";
    label: string;
    need: string;
    of: string;
  }
  | {
    do: "turn";
    label: string;
    ids: string[];
  }
  | {
    do: "signin";
    label: string;
    of: string;
  }
  | {
    do: "refresh";
    label: string;
    of: string;
  }
  | {
    do: "resume";
    label: string;
    of: string;
  }
  | {
    do: "set";
    label: string;
    member: string;
  }
  | {
    do: "grant";
    label: string;
    unit: string;
    grant: string;
  }
  | {
    do: "open";
    label: string;
    url: string;
  }
  | {
    do: "copy";
    label: string;
    text: string;
  }
  | {
    do: "browser";
    label: string;
    of: string;
  }
  | {
    do: "pair";
    label: string;
  }
  | {
    do: "extension";
    label: string;
  }
  | {
    do: "upload";
    label: string;
  }
  | {
    do: "install";
    label: string;
  }
  | {
    do: "storage";
    label: string;
  }
  | {
    do: "vault";
    label: string;
  }
  | {
    do: "verify";
    label: string;
  }
  | {
    do: "report";
    label: string;
    of: string;
  };

export type AskAnswer = "once" | "always" | "no";

export type AskState = "open" | "allowed" | "declined" | "replaced" | "dropped" | "lapsed";

export interface CallFigure {
  length_ms: number | null;
  words: string | null;
  label: string;
}

export interface CallWeek {
  current: boolean;
  calls: WeekCall[];
}

export interface ChatRow {
  chat: string;
  title: string;
  photo: string | null;
  when: When | null;
  line: string | null;
  find: string[];
}

export interface Circle {
  latitude: number;
  longitude: number;
  radius_m: number;
}

export interface ContactRun {
  glyph: "message" | "call" | "call-missed";
  value: string;
  quiet: boolean;
}

export interface Count {
  n: number;
  partial: boolean;
}

export interface DayBlock {
  key: string;
  kind: "hour" | "run";
  start_ms: number;
  title: string | null;
  line: string | null;
  count: DayCount | null;
  folded: boolean;
  rows: DayRow[];
  divider: string | null;
}

export interface DayChapter {
  key: string;
  kind: "stay" | "move" | "none" | "day" | "gap";
  episode: string | null;
  head: {
    title: string;
    line: string | null;
    place: string | null;
    stated_by: string | null;
    since_ms: number | null;
    icon: string;
    quiet: boolean;
    words: DayRun[];
    length: string | null;
  } | null;
  start_ms: number;
  end_ms: number | null;
  folded: boolean;
  names: DayName[];
  photos: {
    hash: string;
    at_ms: number | null;
    alt: string;
    video: boolean;
    duration_ms: number | null;
  }[];
  blocks: DayBlock[];
  divider: string | null;
}

export type DayCount =
  | {
    kind: "words";
    text: string;
  }
  | {
    kind: "sent";
    count: number;
  }
  | {
    kind: "received";
    count: number;
  };

export type DayKind = "stay" | "move" | "sleep" | "workout" | "sitting" | "phone" | "browsing" | "conversation" | "ai" | "call" | "mail_sent" | "mail_received" | "event" | "note" | "voice_note" | "dictation" | "search" | "photos" | "listening" | "check_in" | "payment" | "other" | "gap";

export interface DayMessage {
  key: string;
  who: string;
  name: string;
  text: string;
  at_ms: number;
  mine: boolean;
  forwarded: boolean;
  edited: boolean;
  gone: boolean;
  event: string | null;
  voice: {
    audio: string | null;
    seconds: number | null;
    length: string | null;
    transcript: string;
  } | null;
  pictures: {
    hash: string;
    alt: string;
  }[];
  video: string | null;
  sticker: string | null;
  missing: ("photo" | "video")[];
  attachments: {
    icon: "person" | "file";
    name: string;
    line: string;
  }[];
  link: {
    title: string;
    href: string;
  } | null;
  location: {
    name: string;
    latitude: number;
    longitude: number;
  } | null;
  quote: {
    mine: boolean;
    name: string;
    text: string;
  } | null;
  reactions: {
    face: string;
    mine: boolean;
    name: string;
  }[];
}

export interface DayMoment {
  key: string;
  row: string;
  kind: DayKind;
  icon: string;
  title: string;
  name: string;
  near: string | null;
  start_ms: number | null;
  end_ms: number | null;
  untimed: string | null;
  length_ms: number | null;
  products: string[];
  people: MomentPerson[];
  place: MomentPlace | null;
  out: MomentOpen | null;
  record: MomentRecord | null;
  letter: number | null;
  marks: string[];
  pictures: MomentPicture[];
  source: MomentSource;
  view: MomentView;
}

export interface DayName {
  text: string;
  first_row: string;
  at_ms: number | null;
}

export interface DayRow {
  key: string;
  kind: DayKind;
  at_ms: number | null;
  end_ms: number | null;
  icon: string;
  name: string;
  note: string;
  words: DayRun[];
  count: DayCount | null;
  quiet: boolean;
  focus: string | null;
  divider: string | null;
}

export type DayRun =
  | {
    type: "text";
    text: string;
    tone: RunTone;
    title: boolean;
  }
  | {
    type: "quote";
    text: string;
  }
  | {
    type: "list";
    items: string[];
  }
  | {
    type: "span";
    text: string;
    tone: RunTone;
    start_ms: number;
    end_ms: number;
  }
  | {
    type: "titles";
    items: string[];
  }
  | {
    type: "tiles";
    photos: Tile[];
    more: number;
  };

export interface DaySide {
  figures: SideFigure[];
  located: boolean;
  places: SidePlace[];
  people: SidePerson[];
  groups: SideGroup[];
  unreturned: SideCall[];
}

export type DayState = "ready" | "rendering" | "empty";

export interface Details {
  work: string | null;
  birthday: {
    month: number;
    day: number;
    year: number | null;
  } | null;
  profiles: Profile[];
  cleared: ("work" | "birthday" | "profiles")[];
}

export type Entity = "person" | "ai" | "business" | "bot";

export interface EventWhere {
  text: string;
  href: string;
}

export interface FeedbackAttachment {
  kind: FeedbackKind;
  title: string;
  text: string;
  counts: unknown;
}

export interface FeedbackDraft {
  attachments: FeedbackAttachment[];
  email: string | null;
}

export type FeedbackKind = "answer" | "connector" | "app" | "screenshot";

export interface Frame {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface Guide {
  app: "claude" | "chatgpt" | "muse" | "grok-bot" | "instinct" | "another";
  name: string;
  mark: string;
  line: string | null;
  how: "sign-in" | "key";
  connected: string | null;
  head: string;
  need: string;
  hosts: string[];
  address: GuideAddress | null;
  steps: GuideStep[];
  done: {
    title: string;
    ask: {
      title: string;
      line: string;
      question: string;
    } | null;
    open: GuideLink | null;
  };
}

export interface GuideAddress {
  title: string;
  line: string;
  ready: string;
  on: string;
}

export type GuideLink =
  | {
    to: "web";
    label: string;
    url: string;
  }
  | {
    to: "messages";
    label: string;
  };

export type GuideStep =
  | {
    kind: "add";
    title: string;
    where: string;
    path: string[];
    values: GuideValue[];
    then: string | null;
    open: GuideLink | null;
  }
  | {
    kind: "message";
    title: string;
    line: string;
    value: GuideValue;
    open: GuideLink | null;
    next: string | null;
  }
  | {
    kind: "yes";
    title: string;
    line: string;
    wait: string;
    hint: string;
    sees: string;
    other: string;
    wrong: string;
    finishing: string;
    unfinished: string;
    out: string;
    denied: string;
    reads: string;
  }
  | {
    kind: "name";
    title: string;
    placeholder: string;
  }
  | {
    kind: "sees";
    title: string;
    make: string;
    sees: string;
    access: unknown;
    view: unknown;
  }
  | {
    kind: "give";
    title: string;
    where: string | null;
    path: string[];
    then: string | null;
    warn: string | null;
    once: string;
    unknown: string;
  }
  | {
    kind: "elsewhere";
    title: string;
    line: string;
  };

export interface GuideValue {
  label: string;
  text: string;
  address: boolean;
}

export type HandleKind = "phone" | "email" | "jid" | "network";

export interface Health {
  state: State;
  reason: HealthReason | null;
  words: string;
  since_ms: number | null;
  next_ms: number | null;
  acts: Act[];
  detail: string | null;
  line: string | null;
}

export type HealthReason = "form" | "sign-in" | "choose" | "app" | "grant" | "pair" | "export" | "install" | "signed-out" | "other-account" | "confirm" | "password" | "extension" | "provider-changed" | "offline" | "chrome" | "provider-limit" | "provider-making" | "disk" | "power" | "vault" | "retrying" | "metered" | "door" | "failing" | "import" | "missing-file" | "nothing-new" | "device";

export interface HiddenRow {
  key: string;
  latitude: number;
  longitude: number;
  hidden: When;
  line: string | null;
}

export type History =
  | {
    kind: "weeks";
    weeks: Week[];
    marked: number | null;
  }
  | {
    kind: "years";
    years: HistoryYear[];
    total: number;
    marked: number | null;
  }
  | {
    kind: "facts";
    total: number;
    first: string | null;
  };

export interface HistoryYear {
  year: string;
  count: number;
  day: string | null;
}

export interface HomeAsk {
  line: string;
  since: When;
}

export interface KindSection {
  family: SearchFamily;
  title: string;
  count: Count | null;
  upcoming: Count | null;
  see: boolean;
  unread: string | null;
  rows: SearchRow[];
}

export interface Letter {
  at_ms: number | null;
  from: string;
  to: string;
  subject: string;
  words: string;
  attached: string[];
  address: string | null;
  person: string | null;
  person_id: string | null;
  record: MomentRecord | null;
}

export interface Made {
  by: string | null;
  at_ms: number | null;
  state: MadeState;
  line: string | null;
  ask: MadeAsk | null;
  choose: MadeStep[];
}

export interface MadeAsk {
  family: string;
  item: string;
  prompt: string;
}

export type MadeState = "done" | "off" | "needs" | "waiting" | "failed";

export interface MadeStep {
  value: string;
  words: string;
  note: string | null;
}

export interface Mail {
  family: "mail" | "calendar";
  title: string | null;
  from: string | null;
  day: string | null;
}

export type ModelConnection =
  | {
    kind: "plan";
    id: string;
    name: string;
    line: string | null;
    signed: boolean;
    words: string;
  }
  | {
    kind: "key";
    id: string;
    name: string;
    line: string | null;
    held: boolean;
    words: string | null;
    key: ModelKeyField;
  }
  | {
    kind: "runner";
    id: string;
    unit: string;
    place: string;
    name: string;
    line: string | null;
    none: string | null;
    run: ModelSwitch | null;
    battery: ModelSwitch | null;
    files: ModelFile[];
    found: ModelFound[];
    paused: boolean;
  }
  | {
    kind: "address";
    id: string;
    label: string;
    url: string | null;
    line: string | null;
    words: ModelServerWords;
  };

export interface ModelFile {
  id: string;
  name: string;
  line: string;
  working: boolean;
  state: ModelFileState;
  fits: boolean;
  words: string | null;
  acts: ModelFileAct[];
}

export interface ModelFileAct {
  act: ModelFileDo;
  words: string;
}

export type ModelFileDo = "fetch" | "remove" | "cancel";

export type ModelFileState = "absent" | "fetching" | "ready" | "failed";

export interface ModelFound {
  name: string;
  size: string;
  from: string;
}

export interface ModelGroup {
  label: string;
  rows: ModelRow[];
}

export interface ModelKeyField {
  label: string;
  placeholder: string;
  add: string;
  remove: string;
}

export interface ModelLevel {
  value: string;
  name: string;
  chosen: boolean;
  suggested: boolean;
}

export interface ModelMenu {
  default: ModelRow | null;
  rows: ModelRow[];
  local: ModelGroup | null;
  more: ModelMore;
  off: ModelRow | null;
}

export interface ModelMore {
  words: string;
  use: ModelUseId;
  work: string | null;
}

export interface ModelPlace {
  place: string;
  value: string | null;
  line: string | null;
  working: boolean;
  ready: boolean;
  leaves: boolean;
}

export interface ModelRow {
  value: string;
  name: string;
  account: string | null;
  chosen: boolean;
}

export interface ModelServerWords {
  about: string;
  add: string;
  remove: string;
  field: string;
  placeholder: string;
  save: string;
}

export interface ModelSwitch {
  label: string;
  on: boolean;
  line: string | null;
}

export interface ModelThinking {
  label: string;
  value: string;
  words: string;
  levels: ModelLevel[];
}

export interface ModelUse {
  use: ModelUseId;
  label: string;
  line: string | null;
  words: string;
  value: string | null;
  thinking: ModelThinking | null;
  menu: ModelMenu;
  places: ModelPlace[];
}

export type ModelUseId = "pictures" | "audio" | "text" | "chat" | "search" | "hiding";

export interface MomentAction {
  at_ms: number;
  what: string;
}

export interface MomentApp {
  name: string;
  minutes: number | null;
}

export interface MomentFact {
  label: string;
  value: string;
}

export interface MomentOpen {
  label: string;
  href: string;
}

export interface MomentPerson {
  name: string;
  person: string | null;
  chat: string | null;
  call: MomentRecord | null;
}

export interface MomentPicture {
  hash: string;
  alt: string;
  words: string;
  video: boolean;
  duration_ms: number | null;
  live: boolean;
}

export interface MomentPlace {
  name: string;
  unit: string;
  slug: string | null;
}

export interface MomentRecord {
  source: string;
  kind: string;
  key: string;
}

export interface MomentSite {
  title: string;
  line: string | null;
  at_ms: number | null;
  icon: string;
  href: string | null;
}

export interface MomentSource {
  records: MomentSourceRecord[];
  more: number;
  units: MomentUnit[];
  atoms: number;
  start_ms: number | null;
  end_ms: number | null;
}

export interface MomentSourceRecord {
  source: string;
  kind: string;
  key: string;
  at_ms: number | null;
}

export type MomentState = "found" | "gone" | "rendering" | "empty";

export interface MomentTimed {
  start_ms: number | null;
  end_ms: number | null;
  text: string;
}

export interface MomentTurn {
  at_ms: number | null;
  mine: boolean;
  words: string;
  full: boolean;
  files: string[];
  tools: string[];
  marked: boolean;
}

export interface MomentUnit {
  family: string;
  unit: string;
}

export type MomentView =
  | {
    view: "thread";
    chat: string | null;
    group: boolean;
  }
  | {
    view: "quiet";
    chat: string;
  }
  | {
    view: "ai";
    work: string[];
    turns: MomentTurn[];
  }
  | {
    view: "call";
    figure: CallFigure | null;
    group: string;
    name: string;
    others: OtherCall[];
    week: CallWeek | null;
  }
  | {
    view: "mail";
    list: boolean;
    letters: Letter[];
  }
  | {
    view: "stay";
    today_ms: number;
    unit: string;
    note: string | null;
    inside: MomentTimed[];
  }
  | {
    view: "move";
    km: string | null;
    length_ms: number | null;
    from: string;
    to: string;
    mode: string | null;
    legs: MomentTimed[];
    note: string | null;
  }
  | {
    view: "body";
    label: string;
    length_ms: number | null;
    bed_ms: number | null;
    wake_ms: number | null;
    facts: MomentFact[][];
    vitals: string[];
  }
  | {
    view: "sitting";
    account: ScreenAccount | null;
    apps: MomentApp[];
    sites: MomentSite[];
    lines: MomentTimed[];
  }
  | {
    view: "apps";
    total_ms: number | null;
    apps: MomentApp[];
    sites: MomentSite[];
  }
  | {
    view: "event";
    plan: boolean;
    where: EventWhere | null;
    with: string | null;
    words: string;
  }
  | {
    view: "note";
    words: string | null;
  }
  | {
    view: "voice";
    timed: boolean;
    notes: VoiceNote[];
  }
  | {
    view: "photos";
    lines: PhotoLine[];
  }
  | {
    view: "listening";
    tracks: string[];
  }
  | {
    view: "check_in";
    head: string | null;
    median: string | null;
    lapses: string | null;
    facts: MomentFact[];
    note: string | null;
  }
  | {
    view: "payment";
    amount: string | null;
    direction: "in" | "out";
    facts: MomentFact[];
  }
  | {
    view: "lines";
    lines: MomentTimed[];
  };

export interface Month {
  days: MonthDay[];
  count: number;
  calls: {
    count: number;
    words: string;
  } | null;
  line: string;
  before: {
    day: string;
    joiner: string;
  } | null;
}

export interface MonthDay {
  day: string;
  count: number;
}

export interface NamedCircle {
  slug: string;
  latitude: number;
  longitude: number;
  radius_m: number;
}

export interface Need {
  id: string;
  state: State;
  reason: HealthReason | null;
  words: string;
  since_ms: number | null;
  next_ms: number | null;
  acts: Act[];
  detail: string | null;
  line: string | null;
  connector: string | null;
  streams: string[] | null;
  copy: string | null;
  unit: string | null;
  at: {
    site: string;
    open: string | null;
    errand: string | null;
  } | null;
  weight: "stopped" | "advice";
  banner: boolean;
  dismissed: boolean;
  kind: "password" | "connect" | "notice";
  about: string | null;
}

export type Opens =
  | {
    page: "days";
    day: string;
    focus: string | null;
  }
  | {
    page: "month";
    month: string;
    day: string | null;
  }
  | {
    page: "people";
    id: string;
    person: string | null;
    group: string | null;
  }
  | {
    page: "places";
    id: string;
  }
  | {
    page: "read";
  };

export interface OtherCall {
  at_ms: number;
  way: string;
  length_ms: number | null;
}

export interface PersonRecord {
  type: RecordType;
  slug: string;
  name: string | null;
  full_name: string | null;
  show: "name" | "full_name";
  entity: Entity | null;
  relationship: string | null;
  hidden: boolean;
  me: boolean;
  anchor: RecordHandle | null;
  handles: RecordHandle[];
  excluded: RecordHandle[];
  dismissed: string[];
  also_called: string[];
  merged_into: string | null;
}

export interface PhotoLine {
  start_ms: number | null;
  end_ms: number | null;
  text: string;
  video: boolean;
}

export type PhrasePart =
  | {
    kind: "words";
    words: string;
  }
  | {
    kind: "time";
    time: When;
  };

export interface PlaceLink {
  slug: string;
  name: string;
}

export interface PlacePerson {
  id: string;
  name: string;
  photo: string | null;
  line: string | null;
}

export interface PlaceRow {
  slug: string;
  name: string;
  line: string | null;
  when: When | null;
  spent: {
    day: string;
    hours: number;
  } | null;
  find: string[];
  latitude: number;
  longitude: number;
  radius_m: number;
  also: Circle[];
  hours: number;
}

export interface PlaceVisit {
  key: string;
  unit: string;
  day: string;
  start_ms: number;
  end_ms: number;
  focus: string;
  people: string[];
}

export interface Point {
  latitude: number;
  longitude: number;
}

export interface Profile {
  network: string;
  value: string;
}

export type Reading =
  | {
    state: "building";
    line: string;
    percent: number | null;
  }
  | {
    state: "behind";
    line: string;
    newest: When;
  };

export interface RecordHandle {
  kind: HandleKind;
  value: string;
}

export type RecordType = "people.person";

export interface Row {
  id: string;
  name: string;
  named: boolean;
  face: boolean;
  photo: string | null;
  when: When | null;
  line: string | null;
  find: string[];
}

export type RunTone = "secondary" | "tertiary";

export interface ScreenAccount {
  narrative: string;
  tasks: AccountTask[];
  people: string[];
  projects: string[];
  steps: AccountStep[];
  loose: MomentAction[];
  actions: number;
}

export type SearchFamily = "messages" | "mail" | "calls" | "calendar" | "notes" | "ai" | "web" | "screen" | "photos" | "health" | "money" | "physical" | "listening" | "voice" | "phone";

export type SearchRow =
  | {
    kind: "hit";
    ref: string;
    family: SearchFamily;
    title: string;
    line: string | null;
    when: When | null;
    picture: string | null;
    opens: Opens | null;
  }
  | {
    kind: "person";
    ref: string;
    name: string;
    line: string | null;
    picture: string | null;
    opens: Opens | null;
  }
  | {
    kind: "place";
    ref: string;
    name: string;
    line: string;
    opens: Opens | null;
  }
  | {
    kind: "date";
    when: When;
    opens: Opens;
  }
  | {
    kind: "track";
    ref: string;
    title: string;
    artist: string | null;
    line: string;
  }
  | {
    kind: "sitting";
    key: string;
    title: string;
    line: string | null;
    said: string | null;
    when: When;
    windows: SearchWindow[];
    windows_line: string | null;
    opens: Opens;
  };

export interface SearchWindow {
  ref: string;
  app: string;
  title: string;
  line: string | null;
  when: When | null;
  opens: Opens | null;
}

export interface SettingsDevice {
  id: string;
  name: string;
  icon: string;
  line: string;
  signal: State | null;
  removed: boolean;
}

export type SettingsEnd =
  | {
    kind: "value";
    value: PhrasePart[];
    signal: State | null;
  }
  | {
    kind: "choice";
    key: string;
    choices: {
      words: string;
      value: number;
      chosen: boolean;
      default: boolean;
    }[];
  }
  | {
    kind: "pick";
    key: string;
    choices: SettingsPick[];
  };

export interface SettingsPart {
  label: string | null;
  line: string | null;
  rows: SettingsRow[];
}

export interface SettingsPick {
  words: string;
  value: string;
  chosen: boolean;
  default: boolean;
}

export interface SettingsRow {
  id: string;
  label: string;
  line: string | null;
  end: SettingsEnd | null;
}

export interface SettingsValue {
  id: string;
  label: string | null;
  value: PhrasePart[] | null;
  signal: State | null;
}

export interface SideCall {
  key: string;
  at_ms: number;
  person: string | null;
  name: string;
}

export interface SideFigure {
  key: "asleep" | "steps" | "recovery" | "sent" | "received";
  value: string;
  words: string;
}

export interface SideGroup {
  chat: string;
  title: string;
  runs: ContactRun[];
  spoken: string;
  quiet: boolean;
  rows: string[];
}

export interface SidePerson {
  key: string;
  person: string | null;
  name: string;
  photo: string | null;
  runs: ContactRun[];
  spoken: string;
  rows: string[];
}

export interface SidePlace {
  key: string;
  slug: string | null;
  name: string;
  line: string | null;
  home: boolean;
  quiet: boolean;
  ms: number;
  length: string;
  spoken: string;
  point: SidePoint;
  radius_m: number | null;
  rows: string[];
}

export interface SidePoint {
  latitude: number;
  longitude: number;
  id: string | null;
}

export interface SpotRow {
  key: string;
  latitude: number;
  longitude: number;
  line: string;
  find: string[];
  when: When | null;
  photos: string[];
  photos_total: number;
  ask: HomeAsk | null;
  city: string | null;
}

export type State = "off" | "setup" | "paused" | "needs-you" | "broken" | "waiting" | "quiet" | "syncing" | "ok";

export interface StayPoint {
  latitude: number;
  longitude: number;
  count: number;
}

export interface StorageBar {
  label: string;
  parts: StoragePart[];
  key: StorageKey[];
  left: string;
}

export interface StorageChart {
  label: PhrasePart[];
  first: string;
  parts: StorageSeries[];
  rate: number | null;
  room: {
    bytes: number;
    name: string;
  } | null;
}

export interface StorageKey {
  id: string;
  name: string;
  tone: StorageTone;
}

export interface StoragePart {
  id: string;
  name: string;
  tone: StorageTone;
  share: number;
  size: string;
}

export interface StorageSeries {
  id: string;
  name: string;
  tone: StorageTone;
  bytes: number[];
}

export type StorageTone = "s1" | "s2" | "s3" | "s4" | "s5" | "other" | "own" | "uncounted" | "disk" | "free";

export interface StorageUse {
  id: string;
  part: string;
  name: string;
  tone: StorageTone;
  size: string;
  share: number;
  line: PhrasePart[] | null;
  opens: string | null;
  folded: boolean;
}

export interface StreamRow {
  ids: string[];
  joined: boolean;
  name: string;
  icon: string;
  health: Health;
  line: string;
  time: When | null;
  more: string[];
  last: When | null;
  act: Act | null;
  find: string[];
}

export interface Suggestion {
  id: string;
  kind: "handle" | "full_name" | "same" | "entity" | "work" | "birthday" | "profile";
  value: string;
  reasons: {
    reason: string;
    count: number;
  }[];
  ticked: boolean;
  other: {
    id: string;
    name: string;
    photo: string | null;
    named: boolean;
    face: boolean;
  } | null;
}

export interface Talk {
  day: string;
  chat: string;
  title: string;
  group: boolean;
  network: string;
  lines: TalkLine[];
  folded: {
    line: string;
    lines: TalkLine[];
  }[];
  focus: string;
}

export interface TalkLine {
  who: string;
  name: string;
  text: string;
  forwarded: boolean;
  at_ms: number;
  mine: boolean;
  n: number;
}

export interface Tile {
  item: string;
  hash: string;
  at_ms: number | null;
  video: boolean;
  duration_ms: number | null;
  live: boolean;
}

export interface TripDay {
  day: string;
  line: string;
}

export interface VoiceNote {
  at_ms: number | null;
  words: string;
  seconds: number | null;
  record: MomentRecord | null;
  made: Made | null;
}

export interface WaitingAsk {
  id: string;
  reader: string;
  name: string;
  by: "agent" | "chat";
  head: string;
  line: string;
  asked_line: PhrasePart[];
  under_line: PhrasePart[];
  says_title: string;
  wants: string;
  today: unknown;
  under: string | null;
  reason: string | null;
  screen: string | null;
  adds: string[];
  keeps: string | null;
  choices: {
    answer: AskAnswer;
    words: string;
  }[];
  editable: boolean;
  default: AskAnswer;
  version: number;
  proposed: unknown;
  at_ms: number;
  until_ms: number;
  state: AskState;
  outcome: PhrasePart[] | null;
}

export interface WaitingSignIn {
  id: string;
  name: string;
  checked: boolean;
  host: string | null;
  choices: number[];
  at_ms: number;
  until_ms: number;
  head: string;
  over_line: PhrasePart[];
  sentence: string;
  access: unknown;
  view: unknown;
  pick: string;
  pick_line: string;
  over: string;
  app: string | null;
  notice: string;
}

export interface Week {
  start: string;
  count: number;
  day: string | null;
}

export interface WeekCall {
  day: string;
  at_ms: number;
  title: string;
  icon: string;
  length_ms: number | null;
  focus: string;
}

export type When =
  | {
    kind: "day";
    day: string;
  }
  | {
    kind: "month";
    month: string;
  }
  | {
    kind: "at";
    at_ms: number;
  }
  | {
    kind: "clock";
    at_ms: number;
  };

export interface WrittenDay {
  day: string;
  counts: {
    total: number;
    families: {
      family: string;
      count: number;
    }[];
  };
}

export interface YearSpan {
  first: number;
  last: number;
}

export interface People {
  position: string;
  today: string;
  you: Row | null;
  counts: {
    people: number;
    groups: number;
  };
  most: {
    id: string;
    line: string;
  }[];
  sections: {
    key: string;
    title: string | null;
    rows: Row[];
  }[];
  ai: Row[];
  new: {
    id: string;
    line: string;
  }[];
  businesses: {
    line: string;
    offered: {
      id: string;
      name: string;
      named: boolean;
      photo: string | null;
      why: string | null;
      handles: {
        id: string;
        words: string;
      }[];
    }[];
  } | null;
  organise: {
    count: number;
    line: string | null;
    queue: string[];
    organised: number;
    often: number;
  };
  groups: {
    yours: ChatRow[];
    quiet: ChatRow[];
    quiet_line: string | null;
  };
  counting: boolean;
}

export interface Person {
  position: string;
  today: string;
  became: string | null;
  me: boolean;
  head: {
    name: string;
    named: boolean;
    full_name: string | null;
    photo: string | null;
    chips: ({
      kind: "birthday";
      month: number;
      day: number;
    } | {
      kind: "profile";
      network: string;
      words: string;
      href: string | null;
    })[];
    since: When | null;
    relationship: string | null;
    work: string | null;
    entity: Entity;
    entity_by: "you" | "home" | null;
  };
  handles: {
    id: string;
    kind: HandleKind;
    network: string | null;
    words: string;
    from: string | null;
    own: boolean;
  }[];
  month: Month;
  history: History;
  talk: Talk | null;
  where: {
    chat: string | null;
    title: string;
    group: boolean;
    network: string;
    when: When | null;
    count: number;
    line: string;
    quiet: boolean;
  }[];
  suggestions_line: string | null;
  edit: {
    call: string | null;
    full_name: string | null;
    name_from: string | null;
    record_id: string | null;
    face: boolean;
    reach: string | null;
    last: When | null;
    much: string;
    mails: {
      from: number;
      to: number;
      newest: Mail[] | null;
    };
    record: PersonRecord | null;
    details: Details | null;
    suggestions: Suggestion[];
    also_called: {
      name: string;
      from: string;
    }[];
    names_seen: string[];
    joined: {
      id: string;
      name: string;
      photo: string | null;
      handles: string[];
      with: string[];
    }[];
  };
  counting: boolean;
}

export interface Group {
  position: string;
  today: string;
  head: {
    title: string;
    photo: string | null;
    line: string;
    since: When | null;
    word: "rule" | "always" | "never";
    quiet: boolean;
    why: {
      words: string;
      since: When | null;
    } | null;
  };
  total: number;
  writers: {
    id: string;
    name: string;
    named: boolean;
    photo: string | null;
    share: string;
  }[];
  yours: string | null;
  talk: Talk | null;
  counting: boolean;
}

export interface PeopleFind {
  position: string;
  today: string;
  rows: Row[];
  profiles: Profile[];
}

export interface Connectors {
  position: string;
  today: string;
  rows: StreamRow[];
  needs: Need[];
  badge: {
    needs: number;
    asks: number;
  };
  at_ms: unknown;
  day: unknown;
  products: unknown;
  disk: unknown;
  paused: unknown;
  home: unknown;
  devices: unknown;
  extension: unknown;
  connectors: unknown;
  setup: unknown;
  off: unknown;
  imports: unknown;
  adding: unknown;
}

export interface AgentsWaiting {
  position: string;
  today: string;
  requests: WaitingSignIn[];
  asks: WaitingAsk[];
}

export interface AgentGuides {
  position: string;
  today: string;
  title: string;
  apps: Guide[];
}

export interface Search {
  position: string;
  today: string;
  top: SearchRow[];
  kinds: KindSection[];
  total: Count;
  held: {
    first: string;
    last: string;
  } | null;
  reading: Reading | null;
  nothing: string | null;
}

export interface SearchKind {
  position: string;
  today: string;
  family: SearchFamily;
  title: string;
  upcoming: boolean;
  rows: SearchRow[];
  next: string | null;
  unread: string | null;
  reading: Reading | null;
  nothing: string | null;
}

export interface Places {
  position: string;
  today: string;
  here: string | null;
  frame: Frame | null;
  cities: {
    key: string;
    title: string;
    here: boolean;
    when: When | null;
    since: When | null;
    point: Point;
    places: PlaceRow[];
    once: PlaceRow[];
  }[];
  to_name: SpotRow[];
  hidden: HiddenRow[];
  counting: boolean;
}

export interface Place {
  position: string;
  today: string;
  head: {
    name: string;
    line: string | null;
    since: When | null;
  };
  here: boolean;
  rhythm: string | null;
  stays: number;
  visits: {
    count: number;
    rows: PlaceVisit[];
  };
  people: PlacePerson[];
  photos: {
    first: string[];
    total: number;
    line: string | null;
  };
  part_of: PlaceLink | null;
  inside: PlaceLink[];
  ask_home: HomeAsk | null;
  clashes: {
    id: string;
    names: string[];
  }[];
  counting: boolean;
}

export interface PlaceEdit {
  position: string;
  today: string;
  slug: string;
  circle: Circle;
  others: NamedCircle[];
  points: StayPoint[];
  held: number;
  read: boolean;
  line: string | null;
  counting: boolean;
}

export interface Year {
  position: string;
  today: string;
  year: number;
  span: YearSpan;
  trips: {
    title: string;
    nights: string;
    range: {
      first: string;
      last: string;
    };
    route: string[];
    guessed: boolean;
    days: TripDay[];
  }[];
  figures: {
    count: number;
    words: string;
  }[];
  cities: {
    name: string;
    nights: number;
    point: Point | null;
    country: string | null;
    base: boolean;
  }[];
  base: {
    name: string;
    nights: number;
  } | null;
}

export interface Days {
  position: string;
  today: string;
  opening: string;
  days: WrittenDay[];
  next: string | null;
}

export interface Day {
  position: string;
  today: string;
  day: string;
  state: DayState;
  line: string | null;
  now_ms: number | null;
  updated_ms: number | null;
  all_day: DayRow[];
  chapters: DayChapter[];
  also: {
    folded: boolean;
    names: DayName[];
    rows: DayRow[];
  } | null;
  plans: DayRow[];
  until_ms: number | null;
  now_divider: string | null;
  end_ms: number | null;
  before_home: string | null;
  side: DaySide;
}

export interface Moment {
  position: string;
  today: string;
  day: string;
  state: MomentState;
  moment: DayMoment | null;
}

export interface Thread {
  position: string;
  today: string;
  chat: string;
  day: string;
  title: string | null;
  messages: DayMessage[];
}

export interface Feedback {
  position: string;
  today: string;
  open: boolean;
  title: string;
  about: {
    chat: string;
    connector: string;
  };
  field: {
    placeholder: string;
    max: number;
  };
  email: {
    label: string;
    placeholder: string;
  };
  kinds: {
    kind: FeedbackKind;
    title: string;
    add: string | null;
  }[];
  see: string;
  send: string;
  clear: string;
  sent: {
    title: string;
    line: string | null;
  };
  again: string;
  privacy: string;
}

export interface Settings {
  position: string;
  today: string;
  you: Row | null;
  values: SettingsValue[];
  devices: SettingsDevice[];
  removed: string;
}

export interface SettingsPage {
  position: string;
  today: string;
  id: string;
  title: string;
  line: string | null;
  parts: SettingsPart[];
}

export interface Storage {
  position: string;
  today: string;
  title: string;
  counted: boolean;
  figure: string;
  after: string;
  disk: string;
  growth: string;
  sentence: PhrasePart[];
  bar: StorageBar;
  chart: StorageChart | null;
  used: string;
  uses: StorageUse[];
  more: string | null;
  fewer: string;
  keep: {
    label: string;
    line: string;
    size: string;
  };
}

export interface ModelDefaults {
  position: string;
  today: string;
  uses: ModelUse[];
}

export interface ModelProviders {
  position: string;
  today: string;
  accounts: string;
  connections: ModelConnection[];
}

export interface ModelsFind {
  position: string;
  today: string;
  placeholder: string;
  groups: ModelGroup[];
  none: string | null;
}

export interface Pages {
  people: People;
  person: Person;
  group: Group;
  peopleFind: PeopleFind;
  connectors: Connectors;
  agentsWaiting: AgentsWaiting;
  agentGuides: AgentGuides;
  search: Search;
  searchKind: SearchKind;
  places: Places;
  place: Place;
  placeEdit: PlaceEdit;
  year: Year;
  days: Days;
  day: Day;
  moment: Moment;
  thread: Thread;
  feedback: Feedback;
  settings: Settings;
  settingsPage: SettingsPage;
  storage: Storage;
  modelDefaults: ModelDefaults;
  modelProviders: ModelProviders;
  modelsFind: ModelsFind;
}
