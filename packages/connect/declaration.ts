import { duration, TYPES, type Json, type Type } from "@lifestreamprotocol/core";

/** How a source's data reaches the home. */
export type Road =
  /** The home's own acquirer fetches it from the provider. */
  | "poll"
  /** An acquirer reads it in the person's own Chrome, through the extension. */
  | "chrome"
  /** The Mac app reads it on the Mac and sends it. */
  | "mac"
  /** The iPhone app reads it on the phone and sends it. */
  | "phone"
  /** The person hands the home a file of it. */
  | "upload"
  /** The person's own word, said through the home and its apps. */
  | "owner"
  /** A labeler on the home writes it from what the home already holds. */
  | "label";

/** A length of time written as a whole number and one unit, `s`, `m`, `h` or `d`, as in `30s` or `2d`. */
export type Duration = string;

/** A length of time a person may change, with the bounds they may change it within. */
export interface Bounded {
  /** The length it has until a person changes it. */
  default: Duration;
  /** The shortest a person may set it to. */
  min?: Duration;
  /** The longest a person may set it to. */
  max?: Duration;
}

/** A choice's option, as its words alone or as its words and the note shown under them. */
export type Option = string | readonly [string, string];

/** One setting of a connector, as the person sees and sets it. */
export type Field = {
  /** The setting's name on its row. */
  label: string;
  /** One line under the label saying what the setting does. */
  about?: string;
  /** The home applies this setting itself and hands it to no device, so the dialog draws it in its groups panel, a change to it runs People again, and its connector's report carries People's quiet count. */
  home?: true;
} & (
  | {
    /** A secret the person types, such as a key or a password. */
    kind: "secret";
    /** The name the home keeps the secret's value under. */
    secret: string;
  }
  | {
    /** One of a fixed set of options. */
    kind: "choice";
    /** The options, each by the value the setting takes. */
    options: Readonly<Record<string, Option>>;
    /** The option it holds until a person picks another. */
    default: string;
  }
  | {
    /** A number. */
    kind: "number";
    /** The number it holds until a person changes it. */
    default: number;
    /** The least a person may set it to. */
    min?: number;
    /** The most a person may set it to. */
    max?: number;
  }
  | {
    /** A switch that is on or off. */
    kind: "toggle";
    /** Whether it is on until a person changes it. */
    default: boolean;
  }
  | {
    /** A length of time. */
    kind: "duration";
    /** The length it holds until a person changes it. */
    default?: Duration;
    /** The shortest a person may set it to. */
    min?: Duration;
    /** The longest a person may set it to. */
    max?: Duration;
  }
  | {
    /** A path on the machine that reads it. */
    kind: "path";
    /** The path it holds until a person changes it. */
    default?: Json;
    /** The person picks a folder rather than a file. */
    folder?: true;
  }
  | {
    /** A list of values. */
    kind: "list";
    /** The list it holds until a person changes it. */
    default?: Json;
    /** Each value is a recording mode, `{ app, mode }` or `{ site, mode }`, its mode `activity` or `exclude`. */
    items?: "modes";
    /** What an empty list reads as. */
    empty?: string;
  }
  | {
    /** An email address or a line of text. */
    kind: "email" | "text";
    /** The value it holds until a person changes it. */
    default?: Json;
    /** Its value is the connector's account, which a sign-in writes. */
    account?: true;
    /** What the field shows while it is empty. */
    placeholder?: string;
  }
  | {
    /** A civil day, written as `2019-03-01`. */
    kind: "date";
    /** The day it holds until a person changes it. */
    default?: string;
    /** The earliest day a person may pick. */
    min?: string;
    /** The latest day a person may pick. */
    max?: string;
  }
  | {
    /** A time zone, which runs at the home's day zone while it has no value. */
    kind: "zone";
    /** The zone it holds until a person changes it. */
    default?: Json;
  });

/** A permission the Mac app asks macOS for, as the app's permissions command spells it. */
export type MacGrant =
  /** Recording the screen. */
  | "screenRecording"
  /** Reading what is on screen and the input, through Accessibility. */
  | "accessibility"
  /** Recording the microphone. */
  | "microphone"
  /** Recording the sound the Mac plays. */
  | "systemAudio"
  /** Seeing the Bluetooth devices nearby. */
  | "bluetooth"
  /** Reading the files macOS keeps behind Full Disk Access. */
  | "fullDiskAccess"
  /** Reading the Photos library. */
  | "photos";

/** A store of an app on the Mac that the Mac app reads and ships for a connector. */
export interface MacStore {
  /** The name the Mac app seals its deliveries and names its runs under. */
  feeder: string;
  /** The name its runs and logs carry. */
  name: string;
  /** The path whose presence says the store is on this Mac, a folder when it ends in `/` and a regular file otherwise, or a list of paths any one of which does. */
  held: string | readonly string[];
  /** How the Mac app reads which account the store holds. */
  account:
    /** The store holds no account, and its copy is `local`. */
    | "local"
    /** The store's account is the Mac's Apple ID, or `local` when the Mac is signed out. */
    | "apple-id"
    | ({
      /** The plist file the account is read from. */
      plist: string;
      /** The plist key whose value is the account. */
      key: string;
    } & ValueRule)
    | ({
      /** The JSON file the account is read from. */
      json: string;
      /** The dotted path of the value that is the account. */
      at: string;
    } & ValueRule)
    | {
      /** The JSON file whose keys are the accounts. */
      json_keys: string;
      /** The dotted path of the object whose keys are the accounts. */
      at: string;
      /** The tests the file passes before its keys are read. */
      where?: readonly Test[];
    }
    | {
      /** The folder whose subfolders are the accounts. */
      folders: string;
      /** The pattern a subfolder's name matches to be an account. */
      match: string;
      /** The file inside a subfolder whose presence makes it an account. */
      holding: string;
      /** The account is the subfolder's name in lower case, with hyphens for spaces. */
      spell: "lower-hyphen";
    };
  /** The account is taken as read, rather than spelled as an email address or a phone number. */
  spelled?: false;
  /** The bundle id of an app the Mac app opens hidden before it reads the store. */
  wake?: string;
  /** How the Mac app reads the store into deliveries. */
  engine:
    | {
      /** It reads SQLite databases and ships what changed. */
      kind: "sqlite";
      /** The databases it reads. */
      stores: readonly SqliteStore[];
    }
    | {
      /** It ships whole files, again whenever one changes. */
      kind: "file";
      /** The files it ships. */
      files: readonly {
        /** The file's path. */
        path: string;
        /** The file's name in the delivery. */
        member: string;
      }[];
      /** Where one of the files names further files to ship beside it. */
      names?: {
        /** The member whose JSON names the files. */
        from: string;
        /** The dotted path of the names, where `[]` steps into each item of a list and `<account>` is the account. */
        at: string;
        /** The tests the JSON passes before its names are read. */
        where?: readonly Test[];
        /** The folder the names are found under. */
        root: string;
        /** The member that lists the named files in the delivery. */
        index: string;
      };
    }
    | {
      /** It ships session logs as they grow. */
      kind: "logs";
      /** The folders the logs sit under. */
      roots: readonly {
        /** The folder's path. */
        path: string;
        /** How many folder levels below it the walk for logs begins. */
        depth?: number;
        /** It holds its logs in year, month and day folders, found again by the date in a log's name. */
        days?: true;
      }[];
      /** The pattern a log's path under its root matches. */
      match: string;
      /** The pattern of a file beside a log that ships whole with its session. */
      beside?: string;
      /** How to tell a session a program started from one the person started. */
      start?: {
        /** The line that decides, the first one or the first whose JSON holds text at the dotted path `stating`. */
        line: "first" | {
          /** The dotted path whose text marks the line that decides. */
          stating: string;
        };
        /** The tests the deciding line passes to be read as a session the person may have started. */
        session?: readonly Test[];
        /** The tests any one of which marks the session as a program's. */
        program: readonly Test[];
      };
    }
    | {
      /** It reads a Biome stream of macOS. */
      kind: "biome";
      /** The Biome stream's name. */
      stream: string;
    };
}

/** How a plist or JSON value is read as an account. */
export interface ValueRule {
  /** A text the value holds when it names an account. */
  holds?: string;
  /** The ending cut from the value, leaving the account before it. */
  before?: string;
  /** The value is an account only when it is all digits. */
  digits?: true;
}

/** One test on a JSON value at a dotted path. */
export interface Test {
  /** The dotted path of the value tested. */
  at: string;
  /** The value equals this. */
  equals?: string | number;
  /** The value is text that starts with this. */
  prefix?: string;
  /** The value is an object. */
  object?: true;
}

/** One SQLite database of a `sqlite` store. */
export interface SqliteStore {
  /** The database's path, or the folder of the databases `match` finds. */
  path: string;
  /** The pattern the names of the databases in the folder at `path` match. */
  match?: string;
  /** The database's name in the delivery, where `<name>` stands for the name `match` found. */
  member: string;
  /** How the database is known as the same one across reads: by the file itself, by its Core Data id or by its Calendar id. */
  identity: "file" | "core-data" | "calendar";
  /** A missing database is passed over rather than failing the read. */
  optional?: true;
  /** The folder the files its rows name are found under. */
  file_root?: string;
  /** The files its rows name, shipped beside the database. */
  attachments?: {
    /** The member that lists the attached files in the delivery. */
    member: string;
    /** The SQL whose first column names the files, or alternatives each applied when its `when` holds. */
    select: string | readonly {
      /** The SQL whose first column names the files. */
      sql: string;
      /** The table, or `table.column`, the database holds for this SQL to apply. */
      when?: string;
    }[];
  };
  /** The tables it reads. */
  tables: readonly {
    /** The table's name. */
    name: string;
    /** The integer column that identifies a row, by which its changes are found. */
    key?: string;
    /** How the table's rows are chosen to ship. */
    role:
      /** Its rows that changed since the last read ship. */
      | "changes"
      /** Its rows ship only as its `keep` chooses them. */
      | "follows"
      /** The whole table ships every time. */
      | "whole"
      | {
        /** Its rows are the items, the recent ones shipped at once and the older ones paged in as history. */
        main: {
          /** The SQL of a row's time, in seconds since 1970. */
          time: string;
          /** What its rows are called when some left the app before the Mac carried them. */
          rows: string;
        };
      };
    /** The SQL condition of further rows that ship, or alternatives of which the first whose `when` holds applies. */
    keep?: string | readonly {
      /** The SQL condition of the further rows. */
      sql: string;
      /** The table, or `table.column`, the database holds for this condition to apply. */
      when?: string;
    }[];
    /** Another table and the SQL of this table's rows that count as changed when that table changed, and the table, or `table.column`, the database holds for it to apply. */
    touched_by?: readonly (readonly [string, string] | readonly [string, string, string])[];
    /** The SQL condition a changed row meets to ship. */
    chosen?: string;
    /** The table is read only where the database holds it. */
    when_declared?: true;
    /** The SQL of each file a row names, whose change counts as the row's. */
    files?: readonly string[];
  }[];
}

/** A permission the iPhone app asks iOS for. */
export type PhoneGrant =
  /** Where the phone is. */
  | "location"
  /** How the phone moves, and its steps. */
  | "motion"
  /** The person's Health data. */
  | "health"
  /** The photo library. */
  | "photos"
  /** The address book. */
  | "contacts"
  /** Showing notifications, the one grant with no first-run screen. */
  | "notifications"
  /** Screen Time's record of the apps used. */
  | "screen-time";

export const PHONE_SCREENS: readonly PhoneGrant[] = ["location", "motion", "health", "photos", "contacts", "screen-time"];

/** Why an acquirer stops until the person acts, as `NeedsYou` says it. */
export const NEED_REASONS = [
  /** The person is signed out at the provider. */
  "signed-out",
  /** The provider is signed in to another account than the connector's. */
  "other-account",
  /** The provider asks the person to confirm it is them. */
  "confirm",
  /** The provider asks for the person's password. */
  "password",
  /** The browser extension is not allowed on the site. */
  "extension",
  /** The provider changed what it answers, so the connector reads it no longer. */
  "provider-changed",
] as const;
/** One of `NEED_REASONS`. */
export type NeedReason = (typeof NEED_REASONS)[number];

/** What an acquirer waits on that ends without the person, as `NotYet` says it. */
export const WAIT_REASONS = [
  /** The network is down. */
  "offline",
  /** Chrome is closed or busy, or has no station. */
  "chrome",
  /** The provider limits how often it is asked. */
  "provider-limit",
  /** The provider is still making an export. */
  "provider-making",
  /** The home's disk has too little room. */
  "disk",
  /** The machine is off mains power. */
  "power",
  /** The vault of secrets is locked. */
  "vault",
  /** A failure the home tries again by itself. */
  "retrying",
  /** The home's network is metered. */
  "metered",
  /** The home's door is not answering for a moment. */
  "door",
] as const;
/** One of `WAIT_REASONS`. */
export type WaitReason = (typeof WAIT_REASONS)[number];

/** One copy of a connector's data: which source it is, which reader reads it and how it arrives. */
export interface DeclaredSource {
  /** The source's id pattern, where `<account>`, `<unit>` and `<home>` are filled in when it arrives. */
  id: string;
  /** The name of the reader that reads it. */
  read: string;
  /** The road it arrives on, or the roads that feed it. */
  arrives: Road | readonly Road[];
  /** The feeder names its deliveries' manifests carry, where they differ from the reader's name. */
  feeders?: readonly string[];
  /** What this copy lacks of what the connector records, said after "without" on its row. */
  lacks?: string;
}

/** The one row several connectors share on the Connectors page, each a member of it. */
export interface Joined {
  /** The shared row's name. */
  name: string;
  /** What the shared row brings in, one sentence. */
  gives: string;
  /** The design system's icon the shared row is drawn with. */
  icon?: string;
}

/** One thing a person sets up to bring a kind of data home, declared as data beside its code. */
export interface Connector {
  /** The connector's one id, which its settings, its row and its report go by. */
  id: string;
  /** The first part of its sources' ids. */
  product: string;
  /** Its name on every screen. */
  name: string;
  /** The company that makes the product. */
  vendor: string;
  /** The name a day's row of its records takes, where it differs from `name`. */
  row?: string;
  /** What its `cloud` copy is called, shown as "Online" when absent. */
  cloud?: string;
  /** Every other product its readers state, by id, with its name and vendor. */
  products?: Readonly<Record<string, {
    /** The product's name. */
    name: string;
    /** The company that makes the product. */
    vendor: string;
  }>>;
  /** Products of other connectors that its readers state records of too. */
  writes?: readonly string[];
  /** Its records' pages at the provider, which a client opens as "Open in" its name. */
  open?: {
    /** The page of one record. */
    record?: {
      /** The record kinds the page opens for. */
      kinds: readonly string[];
      /** The page's address template, filled from `{account}`, `{key}` and `{content.<path>}`, the text or number the record's content states at that dotted path. */
      url: string;
    };
    /** The page of a one-to-one chat. */
    chat?: {
      /** The page's address template, filled from `{chat}`. */
      url: string;
    };
  };
  /** Its words are the system's, not the person's, so the mentions read leaves them out. */
  mentions?: false;
  /** What its data is, which groups it on every page. */
  type?: Type;
  /** It is not offered yet, so the report and its pages leave it out. */
  hidden?: true;
  /** One of the few connectors a new home's page offers first. */
  starter?: true;
  /** The shared row it is drawn in with the other connectors that join it. */
  joins?: Joined;
  /** The design system's icon it is drawn with, its type's when absent. */
  icon?: string;
  /** What one and many of its records are called. */
  noun?: readonly [string, string];
  /** The record kinds its noun counts, every kind when absent. */
  counts?: readonly string[];
  /** The family whose extracts give its counts, rather than its records. */
  counted_by?: "web";
  /** Its copies of one account hold the same items, so its count takes the largest copy rather than adding them. */
  mirror?: true;
  /** How often items come at the least while its device or provider answers, after which its copy reads as quiet. */
  expect?: Duration;

  /** One line of what it records, in the product's own words. */
  records: string;
  /** The line under its name where the name does not say what it is, `records` when absent. */
  gives?: string;
  /** What the person does at the provider before setting it up, one sentence a step. */
  before?: readonly string[];
  /** Its copies. */
  sources: readonly DeclaredSource[];
  /** The names of the acquirers that fetch for it. */
  acquirers?: readonly string[];

  /** The least time between two reads of what is new, the road's when absent. */
  refresh?: Bounded & {
    /** The name of its row where "Refresh rate" is the wrong word. */
    label?: string;
  };
  /** That it reads the history from before it was set up, back to the home's start or its own. */
  backfill?: {
    /** The time between two pages of history. */
    pace?: Bounded;
    /** What one and many of the history left to read are called, its noun when absent. */
    unit?: readonly [string, string];
    /** One sentence of what reading its history collects. */
    about?: string;
  };
  /** What a model does to its items, by work id. */
  processing?: Readonly<Record<string, Work>>;
  /** Its settings, by name. */
  fields?: Readonly<Record<string, Field>>;
  /** The export a person hands the home of it. */
  export?: OwnExport | KindExport;
  /** The labeler that writes its one copy. */
  label?: {
    /** The labeler's name. */
    labeler: string;
    /** What to install before its first run, as the button's words, absent when it needs nothing. */
    install?: string;
  };

  /** What the Mac app reads for it. */
  mac?: {
    /** The app on the Mac whose presence says the data is there. */
    app?: string;
    /** The permissions the Mac app needs for it. */
    grants: readonly MacGrant[];
    /** The Mac app records it itself. */
    sensor?: true;
    /** The Mac's screen recorder records it. */
    recorder?: true;
    /** The store on the Mac the Mac app reads for it. */
    store?: MacStore;
    /** Its Mac copy is a photo library whose files the Mac sends as the home asks. */
    library?: true;
  };
  /** What the iPhone app reads for it. */
  phone?: {
    /** The permissions the iPhone app needs for it. */
    grants: readonly PhoneGrant[];
    /** What the days miss while its permission is off. */
    misses?: string;
    /** What its first-run screen says before it asks. */
    why?: string;
    /** The name of the file its copy ships in, the product's when absent. */
    domain?: string;
    /** Its phone copy is a photo library whose files the phone sends as the home asks. */
    library?: true;
    /** What a new install of the phone takes back of its copy, the records of some kinds or the ids of the contacts. */
    restore?: {
      /** The record kinds taken back whole. */
      kinds: readonly string[];
    } | "contacts";
  };
  /** A site it reads in the person's Chrome. */
  chrome?: {
    /** The site's origin. */
    origin: string;
    /** Where a signed-out person is sent to sign in. */
    signin?: SiteSignIn;
    /** The read that says whether the person is signed in and as whom, or null where the lane's recipe says it. */
    probe: Probe | null;
  };
  /** Its ways of signing in. */
  signin?: readonly SignIn[];
}

/** One kind of thing a model does to a connector's items. */
export interface Work {
  /** Its row's name, saying what it makes. */
  label: string;
  /** What the model does and what the person gains, under its info mark. */
  about: string;
  /** What it hands a model. */
  kind: "pictures" | "audio" | "text";
  /** What one and many of its items are called. */
  noun: readonly [string, string];
  /** The most characters of text one of its asks holds. */
  text_chars?: number;
  /** Its input leaves the machine as it is, whatever the privacy level. */
  as_is?: true;
  /** Its model answers when each word was said, so a model that cannot time its words is not offered. */
  timed?: true;
}

/** One way of signing in to a connector, run by one of its acquirers. */
export type SignIn = {
  /** The route's id, the acquirer's name when absent. */
  id?: string;
  /** The acquirer the route runs. */
  acquirer: string;
  /** The route's name where the person picks a way to sign in. */
  label: string;
  /** One line under the label. */
  about?: string;
  /** What the person does at the provider first, at most two steps. */
  steps?: readonly GuideStep[];
  /** One line under the fields, saying what the sign-in can and cannot do. */
  note?: string;
  /** What the person reads under the field when the provider refuses the credential. */
  refused?: string;
} & (
  | {
    /** The person types a credential the provider issued. */
    way: "key";
    /** The fields the person types. */
    fields: readonly string[];
    /** The one request that checks the credential. */
    check?: Check;
  }
  | {
    /** OAuth's device grant. */
    way: "device";
    /** The secret field the credential is sealed under. */
    field: string;
    /** The authorization server's address. */
    issuer: string;
    /** The scope asked for. */
    scope: string;
    /** The resource asked for. */
    resource?: string;
  }
  | {
    /** OAuth's authorization code with PKCE, by a client the person made at the provider. */
    way: "client";
    /** The secret field the credential is sealed under. */
    field: string;
    /** The id of the client it signs in with. */
    client: string;
    /** The scope asked for. */
    scope: string;
    /** The one request that checks the credential. */
    check?: Check;
  });

export function routeId(route: SignIn): string {
  return route.id ?? route.acquirer;
}

/** An OAuth client a person makes at a provider that gives an open-source program none. */
export interface Client {
  /** The client's id, which routes name it by. */
  id: string;
  /** The provider's name. */
  name: string;
  /** The authorization endpoint. */
  authorize: string;
  /** The token endpoint. */
  token: string;
  /** Parameters sent with the authorization request. */
  params?: Readonly<Record<string, string>>;
  /** How to make the client at the provider, one sentence a step. */
  before: readonly string[];
}

/** A check of a credential that is one GET request, which the home makes. */
export type Check = {
  /** The address asked with the credential as `Authorization: Bearer`, or `{credential}` to ask the typed link itself. */
  url: string;
  /** The dotted path of the answer's JSON that names whose credential it is. */
  account?: string;
  /** What an HTTP 403 means at this provider, in the person's words. */
  forbidden?: string;
};

export const CREDENTIAL = "{credential}";

export function checkAddress(check: Check, credential: string): { url: string; bearer: boolean } | { refused: "address" | "userinfo" } {
  const whole = check.url === CREDENTIAL;
  const url = webAddress(whole ? credential : check.url, true);
  if (url === null) return { refused: "address" };
  if (url.username !== "" || url.password !== "") return { refused: "userinfo" };
  return whole ? { url: credential, bearer: false } : { url: check.url, bearer: true };
}

function webAddress(value: string, loopback: boolean): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (loopback && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) ? url : null;
  } catch {
    return null;
  }
}

export const ROUTE = "route";

type Block = Readonly<Record<string, Json>> | undefined;

export function routeOf(connector: Connector, block: Block): SignIn | null {
  const named = block?.[ROUTE];
  return (connector.signin ?? []).find((route) => routeId(route) === named) ?? null;
}

export function runningOf(connector: Connector, block: Block): readonly string[] {
  const acquirers = connector.acquirers ?? [];
  if (connector.signin === undefined) return acquirers;
  const named = new Set(connector.signin.map((route) => route.acquirer));
  const running = routeOf(connector, block)?.acquirer;
  return acquirers.filter((name) => !named.has(name) || name === running);
}

export function accountField(connector: Connector): string | undefined {
  return Object.entries(connector.fields ?? {}).find(([, field]) => (field.kind === "email" || field.kind === "text") && field.account === true)?.[0];
}

/** A `device` route's authorization server, scope and resource, as the OAuth helpers take them. */
export function issuerOf(route: Extract<SignIn, { way: "device" }>): { issuer: string; scope: string; resource?: string } {
  return { issuer: route.issuer, scope: route.scope, ...(route.resource === undefined ? {} : { resource: route.resource }) };
}

/** The connector's route of this id and way, throwing where it declares none. */
export function routeNamed<W extends SignIn["way"]>(connector: Connector, id: string, way: W): Extract<SignIn, { way: W }> {
  const route = connector.signin?.find((each) => routeId(each) === id);
  if (route?.way !== way) throw new TypeError(`${connector.id} declares no ${way} route ${id}`);
  return route as Extract<SignIn, { way: W }>;
}

export function secretFieldOf(connector: Connector, route: SignIn): string {
  return route.way === "key" ? route.fields.find((field) => connector.fields?.[field]?.kind === "secret")! : route.field;
}

export function setsOf(route: SignIn, connector: Connector): string[] {
  const account = accountField(connector);
  const sets = route.way === "key" ? [...route.fields, ...(account === undefined ? [] : [account])] : [...(account === undefined ? [] : [account]), route.field];
  return [...new Set(sets)];
}

export function signinSets(connector: Connector): Set<string> {
  return new Set((connector.signin ?? []).flatMap((route) => setsOf(route, connector)));
}

export function signinFaults(connector: Connector, checks: ReadonlySet<string>, clients?: ReadonlySet<string>): [string, string][] {
  const faults: [string, string][] = [];
  const routes = connector.signin ?? [];
  const address = (value: string, loopback: boolean) => webAddress(value, loopback) !== null;
  if (connector.signin !== undefined && routes.length === 0) faults.push(["signin", "an empty list: leave it out, and every acquirer runs"]);
  const accounts = Object.entries(connector.fields ?? {}).filter(([, field]) => "account" in field && field.account === true);
  if (routes.length > 0 && accounts.length !== 1) faults.push(["signin", `${accounts.length} fields marked account: a sign-in writes its account into exactly one`]);
  if (routes.length === 0 && accounts.length > 0) faults.push([`fields.${accounts[0]![0]}.account`, "no route signs in to write it: leave it out"]);
  for (const [name, field] of accounts) if ("default" in field && field.default !== undefined) faults.push([`fields.${name}.default`, "an account has no default: the sign-in writes it"]);
  if (routes.length > 0 && Object.hasOwn(connector.fields ?? {}, ROUTE)) faults.push([`fields.${ROUTE}`, "the block's route member is the sign-in's: no field takes its name"]);
  for (const [index, route] of routes.entries()) {
    const at = `signin[${index}]`;
    const id = routeId(route);
    const earlier = routes.slice(0, index);
    if (!(connector.acquirers ?? []).includes(route.acquirer)) faults.push([`${at}.acquirer`, `${route.acquirer} is none of ${connector.id}'s acquirers`]);
    if (earlier.some((other) => other.acquirer === route.acquirer && (other.id === undefined || route.id === undefined))) faults.push([`${at}.acquirer`, `${route.acquirer} is another route's too`]);
    else if (earlier.some((other) => routeId(other) === id)) faults.push([`${at}.id`, `${id} is another route's id too`]);
    if ((route.steps?.length ?? 0) > 2) faults.push([`${at}.steps`, "more than two steps"]);
    const declared = route.way !== "device" && route.check !== undefined;
    if (declared && checks.has(id)) faults.push([`${at}.check`, `${id}'s check is declared and in code: one check a route`]);
    if (!declared && !checks.has(id)) faults.push([at, `no check: declare one, or export ${id}'s in the module's signins`]);
    const kind = (field: string) => connector.fields?.[field]?.kind;
    const checkUrl = (check: Check | undefined) => {
      if (check === undefined || check.url === CREDENTIAL) return;
      if (check.url.includes(CREDENTIAL)) faults.push([`${at}.check.url`, `${CREDENTIAL} stands only as the whole url (a link that is its own credential): leave it out to send the credential as Authorization: Bearer, or check in code (the module's signins)`]);
      else if (!address(check.url, true)) faults.push([`${at}.check.url`, `${check.url} is not an https address, nor http on loopback`]);
      else if ("refused" in checkAddress(check, "")) faults.push([`${at}.check.url`, "holds a name or password: the credential goes as Authorization: Bearer, or check in code (the module's signins)"]);
    };
    if (route.way === "key") {
      for (const field of route.fields) if (kind(field) === undefined) faults.push([`${at}.fields`, `${field} is none of ${connector.id}'s fields`]);
      const secrets = route.fields.filter((field) => kind(field) === "secret");
      if (secrets.length !== 1) faults.push([`${at}.fields`, `${secrets.length} secret fields: a key route takes one`]);
      for (const field of route.fields) {
        const each = kind(field);
        if (each !== undefined && each !== "secret" && each !== "email" && each !== "text") faults.push([`${at}.fields`, `${field} is a ${each} field: a key route types identity fields and its secret`]);
      }
      checkUrl(route.check);
      continue;
    }
    if (kind(route.field) !== "secret") faults.push([`${at}.field`, `${route.field} is none of ${connector.id}'s secret fields`]);
    if (route.way === "device") {
      if (!address(route.issuer, false)) faults.push([`${at}.issuer`, `${route.issuer} is not an https address`]);
      if (route.resource !== undefined && !address(route.resource, false)) faults.push([`${at}.resource`, `${route.resource} is not an https address`]);
    }
    if (route.scope.trim() === "") faults.push([`${at}.scope`, "no scope is asked"]);
    if (route.way === "client") {
      checkUrl(route.check);
      if (clients !== undefined && !clients.has(route.client)) faults.push([`${at}.client`, `${route.client} is no client the release or the folder declares`]);
    }
  }
  return faults;
}

/** The read in the person's Chrome that says whether they are signed in to a site, and as whom. */
export type Probe = (
  | {
    /** A same-origin address whose JSON answer holds a value at `has` when signed in. */
    url: string;
    /** The dotted path of the value the answer holds when signed in. */
    has: string;
  }
  | {
    /** The cookie that holds the site's session, sent as `Authorization: Bearer` to `who.url`. */
    cookie: string;
  }
) & {
  /** Where the answer names the account. */
  who?: {
    /** The address read for whose account it is, the probe's own answer when absent. */
    url?: string;
    /** The dotted path of the provider's id of the account. */
    id: string;
    /** The probe's value is sent to `url` as `Authorization: Bearer`. */
    bearer?: true;
  } & (
    | {
      /** The dotted path of the account's email address. */
      email: string;
    }
    | {
      /** The dotted path of the name the site greets the person by. */
      name: string;
    });
};

/** Where a person signed out of a Chrome site is sent to sign in. */
export interface SiteSignIn {
  /** The sign-in page's origin. */
  origin: string;
  /** The recipe that signs in there. */
  recipe?: string;
}

export function chromeFaults(connector: Connector): [string, string][] {
  const chrome = connector.chrome;
  if (chrome === undefined) return [];
  const faults: [string, string][] = [];
  const probe = chrome.probe as ({ url?: unknown; has?: unknown; cookie?: unknown; who?: { url?: string; email?: unknown; name?: unknown } }) | null;
  if (probe !== null) {
    const asked = probe.url !== undefined || probe.has !== undefined;
    if (asked && probe.cookie !== undefined) faults.push(["chrome.probe", "a url and has, and a cookie: a probe is one or the other"]);
    else if (!asked && probe.cookie === undefined) faults.push(["chrome.probe", "no url and has, nor a cookie"]);
    if (probe.cookie !== undefined && !httpsUrl(probe.who?.url)) faults.push(["chrome.probe.who.url", "a cookie probe reads whose it is at an absolute https address"]);
    if (probe.who !== undefined && (probe.who.email === undefined) === (probe.who.name === undefined)) {
      faults.push(["chrome.probe.who", "names the account's email or, where the site shows none, its name: one of the two"]);
    }
  }
  if (chrome.signin !== undefined) {
    const { origin } = chrome.signin;
    if (!httpsOrigin(origin)) faults.push(["chrome.signin.origin", `${origin} is not an https origin`]);
    else if (origin === chrome.origin) faults.push(["chrome.signin.origin", `${origin} is the site's own origin`]);
  }
  return faults;
}

function httpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function httpsOrigin(value: string): boolean {
  return httpsUrl(value) && new URL(value).origin === value;
}

/** One step of an export's guide. */
export interface GuideStep {
  /** The step's short title, above its words. */
  title?: string;
  /** The step, as the window says it. */
  words: string;
  /** The step's button, which opens the company's page. */
  open?: {
    /** The button's words. */
    label: string;
    /** The page it opens. */
    url: string;
  };
}

/** A connector's own export, an import kind of its own. */
export interface OwnExport {
  /** The member patterns by which a file is known to be this export. */
  recognise: readonly string[];
  /** The steps by which the person gets the export. */
  guide: readonly GuideStep[];
  /** The kind's name, "<name> export" when absent. */
  name?: string;
  /** What the person does to make it, "A download you ask <name> for" when absent. */
  takes?: string;
  /** How long the provider takes to send the export, said up front. */
  wait?: string;
  /** The word for what the person drops: zip, file or backup. */
  file?: string;
  /** Member patterns its reader passes over on purpose. */
  leaves?: readonly string[];
}

/** A product of an import kind that several connectors read. */
export interface KindExport {
  /** The member patterns by which a file holds this product. */
  recognise: readonly string[];
  /** The product it is. */
  product: ImportProductOf;
  /** The id of the import kind, where its patterns are not under a kind's root. */
  kind?: string;
}

/** The product a connector reads from an import kind several connectors read. */
export interface ImportProductOf {
  /** The product's id. */
  id: string;
  /** The product's name, as the company names it. */
  name: string;
  /** What one and many of its records are called, where the connector has no noun. */
  noun?: readonly [string, string];
}

export function ownExport(connector: Pick<Connector, "export">): OwnExport | null {
  return connector.export !== undefined && "guide" in connector.export ? connector.export : null;
}

export function connectorName(connector: Pick<Connector, "name">): string {
  return connector.name;
}

export function connectorIcon(connector: Connector): string {
  return connector.icon ?? (connector.type === undefined ? undefined : TYPES[connector.type].icon) ?? "recording";
}

export function connectorGives(connector: Connector): string {
  return connector.gives ?? connector.records;
}

export function roadsOf(source: DeclaredSource): readonly Road[] {
  return typeof source.arrives === "string" ? [source.arrives] : source.arrives;
}

export function formOf(connector: Connector): string[] {
  const signed = signinSets(connector);
  return Object.entries(connector.fields ?? {})
    .filter(([name, field]) => field.kind !== "secret" && field.kind !== "zone" && field.default === undefined && !signed.has(name)).map(([name]) => name);
}

export function siteFormOf(connector: Connector): string[] {
  return formOf(connector).filter((name) => {
    const kind = connector.fields?.[name]?.kind;
    return kind === "email" || kind === "text";
  });
}

export function unitOf(connector: Connector): readonly [string, string] | undefined {
  return connector.backfill?.unit ?? connector.noun;
}

export const PACE_MIN: Duration = "30s";

/** The pace between two history pages of a connector the home polls, where it declares none. */
export const ROAD_PACE = { default: "1m", min: PACE_MIN, max: "1h" } as const satisfies Bounded;

/** How often the Mac reads a store it polls on a timer, where its connector declares no refresh. */
export const MAC_REFRESH = { default: "5m", min: "1m", max: "5m" } as const satisfies Bounded;

export function withRoadDefaults(connector: Connector): Connector {
  const reader = connector.type !== undefined && connector.mac !== undefined && connector.mac.sensor !== true;
  const polled = reader && connector.mac?.store?.engine.kind === "biome";
  const refresh = connector.refresh ?? (polled ? MAC_REFRESH : undefined);
  const declared = connector.backfill ?? (reader ? {} : undefined);
  const paged = (connector.acquirers ?? []).length > 0 && connector.sources.some((source) => roadsOf(source).some((road) => road === "poll" || road === "chrome"));
  const backfill = declared === undefined || declared.pace !== undefined || !paged ? declared : { ...declared, pace: ROAD_PACE };
  return { ...connector, ...(refresh === undefined ? {} : { refresh }), ...(backfill === undefined ? {} : { backfill }) };
}

export function backfillFaults(connector: Connector, paged: boolean, landed?: ReadonlySet<string>): [string, string][] {
  const faults: [string, string][] = [];
  const pace = connector.backfill?.pace;
  if (paged && !connector.sources.some((source) => roadsOf(source).some((road) => road === "poll" || road === "chrome"))) {
    faults.push(["acquirers", "a page on a device's road: a device pages its own history"]);
  }
  if (pace !== undefined) {
    const least = (() => {
      try {
        return pace.min === undefined ? undefined : duration(pace.min);
      } catch {
        return null;
      }
    })();
    if (least !== null && (least === undefined || least < duration(PACE_MIN))) faults.push(["backfill.pace.min", `${pace.min ?? "none"}: a page at most every ${PACE_MIN}`]);
  }
  const counts = connector.counts;
  if (counts !== undefined && connector.noun === undefined) faults.push(["counts", "counts the kinds its noun counts, and it has none"]);
  if (landed === undefined) return faults;
  for (const kind of counts ?? []) if (!landed.has(kind)) faults.push(["counts", `${kind}: no fixture of its readers lands it`]);
  if (counts === undefined && connector.noun !== undefined && landed.size > 1) faults.push(["counts", `its readers land ${[...landed].sort().join(", ")}: say which its noun counts`]);
  return faults;
}
