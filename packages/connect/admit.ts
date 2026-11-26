import { RESERVED_NETWORKS, TYPES, duration, type Adapters } from "@lifestreamprotocol/core";
import { IMPORTS } from "./imports/index.js";
import { isPattern } from "./shared/patterns.js";
import {
  backfillFaults, chromeFaults, PHONE_SCREENS, routeId, signinFaults, type Client, type Connector, type MacGrant, type MacStore, type PhoneGrant, type Road,
} from "./declaration.js";
import { CONTRACTS } from "./sdk.js";
import type { Labeler } from "./labeler.js";
import { type Acquirer, type Reader, type SignedIn } from "./seams.js";
import type { Dependencies } from "./shared/dependencies.js";
import { RECIPE_PARAMETER, type Recipe } from "./shared/recipe.js";

export type Fault = [member: string, reason: string];

export interface Entry {
  readonly contract: number;
  readonly connectors: readonly Connector[];
  readonly readers: readonly Reader[];
  readonly acquirers?: Readonly<Record<string, (settings: never, dependencies?: Dependencies) => Acquirer>>;
  readonly signins?: Readonly<Record<string, SignedIn>>;
  readonly adapters?: Readonly<Record<string, Adapters>>;
  readonly recipes?: Readonly<Record<string, Recipe>>;
  readonly clients?: readonly Client[];
  readonly labelers?: Readonly<Record<string, (settings: never) => Labeler>>;
}

export type Whose = "release" | "home";

export interface Admitted {
  readonly connectors: Map<string, string>;
  readonly products: Map<string, string>;
  readonly readers: Map<string, string>;
  readonly acquirers: Map<string, string>;
  readonly feeders: Map<string, string>;
  readonly sources: Map<string, string>;
  readonly secrets: Map<string, string>;
  readonly clients: Map<string, string>;
  readonly adapters: Map<string, string>;
}

export function admittedNone(): Admitted {
  return { connectors: new Map(), products: new Map(), readers: new Map(), acquirers: new Map(), feeders: new Map(), sources: new Map(), secrets: new Map(), clients: new Map(), adapters: new Map() };
}

export interface Where {
  readonly folder: string;
  readonly whose: Whose;
  readonly admitted: Admitted;
  readonly icons?: ReadonlySet<string> | ReadonlyMap<string, string | undefined>;
  readonly lifestream?: readonly string[];
}

const ICON_CANDIDATES = 3;
const ICON_NEAR = 0.2;

export function iconWords(icon: string, icons: NonNullable<Where["icons"]>): string {
  const named = (key: string) => (icons instanceof Map ? (icons as ReadonlyMap<string, string | undefined>).get(key) : undefined);
  const want = icon.toLowerCase();
  const distance = (word: string) => {
    if (word === "") return 1;
    if ((word.length >= 3 && want.includes(word)) || (want.length >= 3 && word.includes(want))) return 0;
    return editDistance(want, word) / Math.max(want.length, word.length);
  };
  const closest = [...icons.keys()].map((key) => {
    const phosphor = named(key);
    const words = [key, ...key.split("-"), ...(phosphor === undefined ? [] : [phosphor, ...phosphor.split("-")])];
    return { key, phosphor, score: Math.min(...words.map(distance)) };
  }).sort((a, b) => a.score - b.score || a.key.localeCompare(b.key));
  const best = closest[0]?.score ?? 0;
  const near = closest.filter((each) => each.score <= best + ICON_NEAR).slice(0, ICON_CANDIDATES);
  const said = near.map(({ key, phosphor }) => `\`${key}\`${phosphor === undefined || phosphor === key ? "" : ` (${phosphor})`}`);
  return `${icon} is none of the release's icons${said.length === 0 ? "" : `: did you mean ${said.join(", ")}?`}`;
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

const FAMILIES: Readonly<Record<keyof Adapters, true>> = {
  messages: true, mail: true, ai: true, calls: true, callaudio: true, calendar: true, notes: true, listening: true, health: true, money: true, photos: true, physical: true,
  web: true, voice: true, phone: true, screen: true, labels: true, line: true,
};

export const ADAPTER_FAMILIES = Object.keys(FAMILIES) as readonly (keyof Adapters)[];

type RequiredCalls<A> = { [K in keyof A]-?: {} extends Pick<A, K> ? never : A[K] extends (...args: never[]) => unknown ? K : never }[keyof A];
type CallsOf = { readonly [F in keyof Adapters]-?: readonly RequiredCalls<NonNullable<Adapters[F]>>[] };

const CALLS = {
  messages: ["message", "group", "members"], mail: ["mail"], ai: [], calls: ["call"], callaudio: ["part"], calendar: ["words"], notes: ["note"], listening: ["play"],
  health: ["item"], money: [], photos: ["rank", "copy", "files", "image", "placedBy", "position"], physical: [], web: ["item"], voice: [], phone: ["focus"],
  screen: [], labels: [], line: ["line"],
} as const satisfies CallsOf;
type Unlisted = { [F in keyof Adapters]-?: Exclude<RequiredCalls<NonNullable<Adapters[F]>>, (typeof CALLS)[F][number]> }[keyof Adapters];
const complete: [Unlisted] extends [never] ? true : Unlisted = true;
void complete;

const SERVED = Math.max(...CONTRACTS);

const RETIRED: Readonly<Record<number, string>> = {
  1: "Contract 2 narrowed the SDK to what a home connector can use and "
    + "removed the phone's, the labeler's and the owner statements' helpers, the handle spellings (canonicalEmail, canonicalPhone, handleOf and the rest), versionId, "
    + "Projection, View, SourceRow and Version: a reader's view is ReaderView, an adapter's records AdapterSource and AdapterVersion, a photos adapter's view PhotoView, and NeedsYou's options are its own fields",
  2: "Contract 3 put one start before every connector's history: a backfill declares no reach, and an acquirer reads lent.start_ms and lent.from_ms where it read lent.floor(source)",
};

function retired(contract: number): string {
  const changes = Object.entries(RETIRED).filter(([since]) => Number(since) >= contract).map(([, change]) => change);
  return `${contract} is no longer served: declare \`export const contract = ${SERVED};\`. ${changes.join(". ")}; once the folder declares ${SERVED}, the typecheck names the rest`;
}

export function admit(module: unknown, where: Where): { entry: Entry } | { faults: Fault[] } {
  if (typeof module !== "object" || module === null) return { faults: [["module", "exports nothing a folder's entry module exports"]] };
  const exported = module as Record<string, unknown>;
  if (typeof exported.contract === "number" && Object.hasOwn(RETIRED, exported.contract)) return { faults: [["contract", retired(exported.contract)]] };
  if (!CONTRACTS.includes(exported.contract as number)) {
    return { faults: [["contract", `${JSON.stringify(exported.contract ?? null)} is no contract this home serves (it serves ${CONTRACTS.join(", ")})`]] };
  }
  const faults: Fault[] = [];
  const list = (name: string) => {
    const value = exported[name];
    if (value !== undefined && !Array.isArray(value)) faults.push([name, "is not a list"]);
    return Array.isArray(value) ? (value as unknown[]) : [];
  };
  const record = (name: string) => {
    const value = exported[name];
    if (value !== undefined && !plain(value)) faults.push([name, "is not an object by name"]);
    return plain(value) ? value : {};
  };
  if (!Array.isArray(exported.connectors) || exported.connectors.length === 0) faults.push(["connectors", "declares no connector"]);
  if (!Array.isArray(exported.readers)) faults.push(["readers", "is not a list"]);
  const connectors = list("connectors");
  const readers = list("readers");
  const acquirers = record("acquirers");
  const signins = record("signins");
  const adapters = record("adapters");
  const recipes = record("recipes");
  const labelers = record("labelers");
  const clients = list("clients");
  for (const [name, factory] of Object.entries({ ...acquirers, ...labelers })) if (typeof factory !== "function") faults.push([`${name in acquirers ? "acquirers" : "labelers"}.${name}`, "is not a function"]);
  for (const [name, check] of Object.entries(signins)) if (typeof check !== "function") faults.push([`signins.${name}`, "is not a function"]);
  for (const [name, recipe] of Object.entries(recipes)) {
    if (!plain(recipe)) faults.push([`recipes.${name}`, "is not a recipe"]);
    else for (const [member, reason] of recipeFaults(recipe)) faults.push([`recipes.${name}.${member}`, reason]);
  }
  faults.push(...actsFaults(recipes, connectors));

  const taken = admittedNone();
  const take = (kind: keyof Admitted, name: string, member: string, words: string) => {
    const holder = where.admitted[kind].get(name);
    if (holder !== undefined) faults.push([member, `${name} is ${words} the folder ${holder} holds already`]);
    else if (taken[kind].has(name)) faults.push([member, `${name} is ${words} this folder names twice`]);
    taken[kind].set(name, where.folder);
  };

  const readerNames = new Set<string>();
  for (const [index, reader] of readers.entries()) {
    const at = `readers[${index}]`;
    if (!plain(reader) || typeof reader.name !== "string" || reader.name === "") {
      faults.push([at, "is no reader: a name, its kinds and read"]);
      continue;
    }
    if (typeof reader.read !== "function") faults.push([`${at}.read`, "is not a function"]);
    if (!plain(reader.kinds)) faults.push([`${at}.kinds`, "is not an object of guards by kind"]);
    take("readers", reader.name, `${at}.name`, "a reader");
    readerNames.add(reader.name);
  }

  const clientIds = new Set(where.admitted.clients.keys());
  for (const [index, client] of clients.entries()) {
    const at = `clients[${index}]`;
    const shape = clientFaults(client).map(([member, reason]): Fault => [`${at}${member === "" ? "" : `.${member}`}`, reason]);
    faults.push(...shape);
    if (shape.length === 0) {
      take("clients", (client as Client).id, `${at}.id`, "a client");
      clientIds.add((client as Client).id);
    }
  }

  const routeIds = new Set<string>();
  for (const [index, connector] of connectors.entries()) {
    const at = `connectors[${index}]`;
    const shape = shapeFaults(connector);
    if (shape.length > 0) {
      faults.push(...shape.map(([member, reason]): Fault => [`${at}${member === "" ? "" : `.${member}`}`, reason]));
      continue;
    }
    const declared = connector as Connector;
    const checks = new Set(Object.keys(signins));
    for (const [member, reason] of connectorFaults(declared, { checks, clients: clientIds, ...(where.lifestream === undefined ? {} : { lifestream: where.lifestream }) })) faults.push([`${at}.${member}`, reason]);
    for (const route of declared.signin ?? []) routeIds.add(routeId(route));

    take("connectors", declared.id, `${at}.id`, "a connector");
    for (const product of [declared.product, ...Object.keys(declared.products ?? {})]) take("products", product, `${at}.product`, "a product");
    for (const pattern of new Set(declared.sources.map((source) => source.id))) take("sources", pattern, `${at}.sources`, "a source pattern");
    for (const [i, source] of declared.sources.entries()) {
      for (const feeder of source.feeders ?? []) take("feeders", feeder, `${at}.sources[${i}].feeders`, "a feeder");
      if (!readerNames.has(source.read)) faults.push([`${at}.sources[${i}].read`, `${source.read} is no reader the module exports`]);
    }
    for (const [name, field] of Object.entries(declared.fields ?? {})) if (field.kind === "secret") take("secrets", field.secret, `${at}.fields.${name}.secret`, "a secret");
    for (const name of declared.acquirers ?? []) {
      take("acquirers", name, `${at}.acquirers`, "an acquirer");
      if (!Object.hasOwn(acquirers, name)) faults.push([`${at}.acquirers`, `${name} is no acquirer the module exports`]);
    }
    if (declared.label !== undefined && !Object.hasOwn(labelers, declared.label.labeler)) faults.push([`${at}.label.labeler`, `${declared.label.labeler} is no labeler the module exports`]);
    const recipe = declared.chrome?.signin?.recipe;
    if (recipe !== undefined && !Object.hasOwn(recipes, recipe)) faults.push([`${at}.chrome.signin.recipe`, `${recipe} is no recipe the module exports`]);
    if (where.whose === "home") faults.push(...homeFaults(declared, where).map(([member, reason]): Fault => [`${at}.${member}`, reason]));
  }
  for (const [index, connector] of connectors.entries()) {
    if (shapeFaults(connector).length > 0) continue;
    const declared = connector as Connector;
    const own = new Set([declared.product, ...Object.keys(declared.products ?? {})]);
    for (const product of declared.writes ?? []) {
      if (own.has(product)) faults.push([`connectors[${index}].writes`, `${product} is its own product: it writes only another connector's`]);
    }
  }
  for (const name of Object.keys(signins)) if (!routeIds.has(name)) faults.push([`signins.${name}`, "names no route of the folder's connectors"]);
  if (where.whose === "home" && exported.labelers !== undefined) faults.push(["labelers", "a labeler is the release's alone: a home connector cannot be one"]);

  const byId = new Map((connectors.filter(plain) as unknown as Connector[]).map((connector) => [connector.id, connector]));
  for (const [id, given] of Object.entries(adapters)) {
    const connector = byId.get(id);
    if (connector === undefined) {
      faults.push([`adapters.${id}`, "names no connector of the folder"]);
      continue;
    }
    if (!plain(given)) {
      faults.push([`adapters.${id}`, "is not an object by family"]);
      continue;
    }
    const lineKinds = new Set(plain(given.line) && Array.isArray(given.line.kinds) ? (given.line.kinds as unknown[]) : []);
    for (const [family, adapter] of Object.entries(given)) {
      const at = `adapters.${id}.${family}`;
      if (!(ADAPTER_FAMILIES as readonly string[]).includes(family)) {
        faults.push([at, "is no family the release holds: a folder brings no new family"]);
        continue;
      }
      if (!plain(adapter) || typeof adapter.version !== "string" || adapter.version === "" || !strings(adapter.kinds) || adapter.kinds.length === 0) {
        faults.push([at, "is no adapter: a version and the kinds it reads"]);
        continue;
      }
      const missing = CALLS[family as keyof Adapters].filter((call) => typeof adapter[call] !== "function");
      for (const call of missing) faults.push([`${at}.${call}`, `is no call: the ${family === "line" ? "plain" : family} family calls it`]);
      if (missing.length > 0) continue;
      take("adapters", `${family} for ${connector.product}`, at, "an adapter");
      if (family !== "line") for (const kind of adapter.kinds as string[]) if (lineKinds.has(kind)) faults.push([`adapters.${id}.line.kinds`, `${kind} is read by its ${family} adapter: a plain line reads no kind a family reads`]);
    }
  }

  if (faults.length > 0) return { faults };
  for (const kind of Object.keys(taken) as (keyof Admitted)[]) for (const [name, folder] of taken[kind]) where.admitted[kind].set(name, folder);
  return { entry: exported as unknown as Entry };
}

export interface Context {
  checks: ReadonlySet<string>;
  clients?: ReadonlySet<string>;
  landed?: ReadonlySet<string>;
  paged?: boolean;
  lifestream?: readonly string[];
}

export function connectorFaults(connector: unknown, context: Context): Fault[] {
  const shape = shapeFaults(connector);
  if (shape.length > 0) return shape;
  const declared = connector as Connector;
  return [
    ...signinFaults(declared, context.checks, context.clients),
    ...chromeFaults(declared),
    ...backfillFaults(declared, context.paged ?? false, context.landed),
    ...(declared.mac?.store === undefined ? [] : storeFaults(declared.mac.store, context.lifestream)),
  ];
}

export function clientFaults(client: unknown): Fault[] {
  if (!plain(client)) return [["", "is no client"]];
  const faults: Fault[] = [];
  members(client, ["id", "name", "authorize", "token", "params", "before"], "", faults);
  if (typeof client.id !== "string" || !ID.test(client.id)) faults.push(["id", "is no id: lower case, digits and dashes"]);
  if (!text(client.name)) faults.push(["name", "is no name"]);
  for (const member of ["authorize", "token"]) if (!https(client[member])) faults.push([member, `${String(client[member])} is not an https address`]);
  if (client.params !== undefined && (!plain(client.params) || !Object.values(client.params).every((value) => typeof value === "string"))) faults.push(["params", "is not words by name"]);
  if (!strings(client.before) || client.before.length === 0) faults.push(["before", "says no step to make the client"]);
  return faults;
}

export function shapeFaults(connector: unknown): Fault[] {
  if (!plain(connector)) return [["", "is no declaration"]];
  const c = connector;
  const faults: Fault[] = [];
  const fault = (member: string, reason: string) => faults.push([member, reason]);
  members(c, CONNECTOR_MEMBERS, "", faults);

  if (typeof c.id !== "string" || !ID.test(c.id)) fault("id", "is no id: lower case, digits and dashes");
  if (typeof c.product !== "string" || !ID.test(c.product)) fault("product", "is no product: lower case, digits and dashes");
  else if (RESERVED_NETWORKS.includes(c.product)) fault("product", `${c.product} is a word a handle's id begins with: no product takes it`);
  for (const member of ["name", "vendor", "row", "cloud", "gives", "icon"]) optional(c, member, text, "is no words", faults);
  if (!text(c.records)) fault("records", "says nothing of what it records");
  if (c.products !== undefined) {
    if (!plain(c.products)) fault("products", "is not products by id");
    else for (const [product, named] of Object.entries(c.products)) {
      if (!ID.test(product) || RESERVED_NETWORKS.includes(product)) fault(`products.${product}`, "is no product, or one a handle's id begins with");
      if (!plain(named) || !text(named.name) || !text(named.vendor) || Object.keys(named).length !== 2) fault(`products.${product}`, "is not exactly a name and a vendor");
    }
  }
  if (c.writes !== undefined && (!strings(c.writes) || c.writes.some((product) => !ID.test(product)))) fault("writes", "is not a list of products");
  if (c.type !== undefined && !(typeof c.type === "string" && Object.hasOwn(TYPES, c.type))) fault("type", `${String(c.type)} is none of the release's types`);
  for (const member of ["hidden", "mirror", "starter"]) optional(c, member, (value) => value === true, "is true or absent", faults);
  optional(c, "joins", (value) => plain(value) && text(value.name) && text(value.gives) && (value.icon === undefined || text(value.icon))
    && Object.keys(value).every((key) => ["name", "gives", "icon"].includes(key)), "is not a row's name and gives, and maybe its icon", faults);
  optional(c, "mentions", (value) => value === false, "is false or absent", faults);
  optional(c, "counted_by", (value) => value === "web", "is web or absent", faults);
  optional(c, "noun", pair, "is not one and many", faults);
  optional(c, "counts", strings, "is not a list of kinds", faults);
  optional(c, "expect", isDuration, "is no duration (30s, 10m, 1h, 2d)", faults);
  optional(c, "before", strings, "is not a list of sentences", faults);
  optional(c, "acquirers", strings, "is not a list of acquirer names", faults);

  if (!Array.isArray(c.sources) || c.sources.length === 0) fault("sources", "declares no source");
  else c.sources.forEach((source, index) => sourceFaults(source, `sources[${index}]`, faults));
  if (c.refresh !== undefined) boundedFaults(c.refresh, "refresh", faults, ["label"]);
  if (c.backfill !== undefined) backfillShape(c.backfill, faults);
  if (c.processing !== undefined) {
    if (!plain(c.processing)) fault("processing", "is not works by id");
    else for (const [id, work] of Object.entries(c.processing)) workFaults(work, `processing.${id}`, faults);
  }
  if (c.fields !== undefined) {
    if (!plain(c.fields)) fault("fields", "is not fields by name");
    else for (const [name, field] of Object.entries(c.fields)) fieldFaults(field, `fields.${name}`, faults);
  }
  if (c.export !== undefined) {
    exportFaults(c.export, faults);
    const fed = Array.isArray(c.sources) && c.sources.some((source) => plain(source) && (source.arrives === "upload" || (Array.isArray(source.arrives) && source.arrives.includes("upload"))));
    if (!fed) fault("export", "feeds no source: declare one on the upload road");
  }
  if (c.label !== undefined) {
    if (!plain(c.label) || !text(c.label.labeler)) fault("label", "names no labeler");
    else {
      members(c.label, ["labeler", "install"], "label", faults);
      optional(c.label, "install", text, "is no words", faults, "label");
    }
  }
  if (c.mac !== undefined) macFaults(c.mac, faults);
  if (c.phone !== undefined) {
    if (!plain(c.phone)) fault("phone", "is not a phone block");
    else {
      members(c.phone, ["grants", "misses", "why", "domain", "library", "restore"], "phone", faults);
      const grants = c.phone.grants;
      if (!Array.isArray(grants) || !grants.every((grant) => (PHONE_GRANTS as readonly unknown[]).includes(grant))) fault("phone.grants", `is not a list of ${PHONE_GRANTS.join(", ")}`);
      for (const member of ["misses", "why", "domain"]) optional(c.phone, member, text, "is no words", faults, "phone");
      if (Array.isArray(grants) && !grants.some((grant) => (PHONE_SCREENS as readonly unknown[]).includes(grant))) {
        for (const member of ["misses", "why"]) {
          if (c.phone[member] !== undefined) fault(`phone.${member}`, `is shown only on the first-run screen of a grant that has one (${PHONE_SCREENS.join(", ")}), and none of its grants does`);
        }
      }
      optional(c.phone, "library", (value) => value === true, "is true or absent", faults, "phone");
      const restores = (value: unknown) => value === "contacts" || (plain(value) && Object.keys(value).length === 1 && strings(value.kinds) && value.kinds.length > 0);
      optional(c.phone, "restore", restores, "is not the kinds a new install takes back, or contacts", faults, "phone");
    }
  }
  if (c.chrome !== undefined) chromeShape(c.chrome, faults);
  if (c.signin !== undefined) {
    if (!Array.isArray(c.signin)) fault("signin", "is not a list of routes");
    else c.signin.forEach((route, index) => routeShape(route, `signin[${index}]`, faults));
  }
  if (c.open !== undefined) openFaults(c.open, faults);
  return faults;
}

function wordsIn(value: unknown, at: string): [member: string, words: string][] {
  if (typeof value === "string") return [[at, value]];
  if (Array.isArray(value)) return value.flatMap((one: unknown, index) => wordsIn(one, `${at}[${index}]`));
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([key, one]) => wordsIn(one, `${at}.${key}`));
  return [];
}

function recipeFaults(recipe: Record<string, unknown>): Fault[] {
  const faults: Fault[] = [];
  const params = strings(recipe.params) ? recipe.params : [];
  const secrets = strings(recipe.secrets) ? recipe.secrets : [];
  const origins = strings(recipe.origins) ? recipe.origins : [];
  const steps = Array.isArray(recipe.steps) ? (recipe.steps as unknown[]) : [];
  const named = [...wordsIn(recipe.secrets, "secrets"), ...steps.flatMap((step, index) => wordsIn(step, `steps[${index}]`))];
  for (const [member, words] of named) {
    for (const name of new Set([...words.matchAll(RECIPE_PARAMETER)].map((match) => match[1] as string))) {
      if (!params.includes(name)) faults.push([member, `\${${name}} is no parameter the recipe declares: a step or a secret names only one of its params`]);
    }
  }
  for (const [index, step] of steps.entries()) {
    if (!plain(step)) continue;
    if (step.do === "fill" && typeof step.secret === "string" && !secrets.includes(step.secret)) {
      faults.push([`steps[${index}].secret`, `${step.secret} is no secret the recipe names: a step fills only one of its secrets`]);
    }
    if (step.do !== "open" || typeof step.url !== "string" || step.url.search(RECIPE_PARAMETER) !== -1) continue;
    const origin = URL.canParse(step.url) ? new URL(step.url).origin : undefined;
    if (origin === undefined) faults.push([`steps[${index}].url`, `${step.url} is no address: a step opens only an address on one of its origins`]);
    else if (!origins.includes(origin)) faults.push([`steps[${index}].url`, `${origin} is none of the recipe's origins: a step opens only an address on one of its origins`]);
  }
  return faults;
}

function homeFaults(connector: Connector, where: Where): Fault[] {
  const faults: Fault[] = [];
  let onMac = false;
  connector.sources.forEach((source, index) => {
    const roads = typeof source.arrives === "string" ? [source.arrives] : source.arrives;
    for (const road of roads) if (RELEASE_ROADS.includes(road)) faults.push([`sources[${index}].arrives`, `the ${road} road needs code the release compiles: a home connector cannot take it`]);
    if (roads.includes("mac")) onMac = true;
  });
  if (connector.label !== undefined) faults.push(["label", "a labeler is the release's alone: a home connector cannot be one"]);
  for (const [id, work] of Object.entries(connector.processing ?? {})) {
    if (work.as_is === true) faults.push([`processing.${id}.as_is`, "sending a work's input as it is, whatever the privacy level, is the release's alone"]);
  }
  if (onMac && connector.mac?.store === undefined) faults.push(["mac.store", "is none: a home connector's source on the mac road ships only through a store it declares"]);
  if (connector.mac?.library === true) faults.push(["mac.library", "a Mac photos library is the Mac app's own: a home connector cannot be one"]);
  if (connector.mac?.sensor === true) faults.push(["mac.sensor", "a Mac sensor is the Mac app's own: a home connector cannot be one"]);
  if (connector.mac?.recorder === true) faults.push(["mac.recorder", "the Mac's recorder is the Mac app's own: a home connector cannot be one"]);
  if (connector.icon !== undefined && where.icons !== undefined && !where.icons.has(connector.icon)) faults.push(["icon", iconWords(connector.icon, where.icons)]);
  const roots = IMPORTS.flatMap((kind) => (kind.root === undefined ? [] : [kind.root]));
  if (connector.export !== undefined && "product" in connector.export) {
    for (const pattern of connector.export.recognise) {
      if (!roots.some((root) => pattern.startsWith(root))) faults.push(["export.recognise", `${pattern} lies under no import kind of the release's`]);
    }
  }
  return faults;
}


const CONNECTOR_MEMBERS = [
  "id", "product", "name", "vendor", "row", "cloud", "products", "writes", "open", "mentions", "type", "hidden", "starter", "joins", "icon", "noun", "counts", "counted_by", "mirror",
  "expect", "records", "gives", "before", "sources", "acquirers", "refresh", "backfill", "processing", "fields", "export", "label", "mac", "phone", "chrome", "signin",
];
const ID = /^[a-z0-9][a-z0-9-]*$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const ROADS: readonly Road[] = ["poll", "chrome", "mac", "phone", "upload", "owner", "label"];
const RELEASE_ROADS: readonly Road[] = ["phone", "owner", "label"];
const MAC_GRANTS: readonly MacGrant[] = ["screenRecording", "accessibility", "microphone", "systemAudio", "bluetooth", "fullDiskAccess", "photos"];
const PHONE_GRANTS: readonly PhoneGrant[] = ["location", "motion", "health", "photos", "contacts", "notifications", "screen-time"];
const FIELD_KINDS = ["secret", "choice", "number", "toggle", "duration", "path", "list", "email", "text", "date", "zone"];
const FIELD_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  secret: ["secret"], choice: ["options", "default"], number: ["default", "min", "max"], toggle: ["default"], duration: ["default", "min", "max"],
  path: ["default", "folder"], list: ["default", "items", "empty"], email: ["default", "account", "placeholder"], text: ["default", "account", "placeholder"],
  date: ["default", "min", "max"], zone: ["default"],
};
const WAYS: Readonly<Record<string, readonly string[]>> = {
  key: ["fields", "check"], device: ["field", "issuer", "scope", "resource"], client: ["field", "client", "scope", "check"],
};
const APP_SCHEMES = ["imessage:", "sms:"];

function actsFaults(recipes: Readonly<Record<string, unknown>>, connectors: readonly unknown[]): Fault[] {
  const signingIn = new Set(connectors.flatMap((connector) => {
    const signin = plain(connector) && plain(connector.chrome) ? connector.chrome.signin : undefined;
    return plain(signin) && typeof signin.recipe === "string" ? [signin.recipe] : [];
  }));
  return Object.entries(recipes).flatMap(([name, recipe]) => (signingIn.has(name) || !plain(recipe) || !Array.isArray(recipe.steps) ? [] : recipe.steps.flatMap((step, index): Fault[] =>
    plain(step) && step.acts !== undefined ? [[`recipes.${name}.steps[${index}].acts`, "marks a sign-in's submit, which only a recipe a connector of the folder names as its chrome.signin.recipe has"]] : [])));
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((each) => typeof each === "string");
}

function pair(value: unknown): boolean {
  return strings(value) && value.length === 2;
}

function isDuration(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    duration(value);
    return true;
  } catch {
    return false;
  }
}

function https(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isDay(value: unknown): boolean {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

function joined(at: string, member: string): string {
  return at === "" ? member : `${at}.${member}`;
}

function members(value: Record<string, unknown>, known: readonly string[], at: string, faults: Fault[]): void {
  for (const member of Object.keys(value)) if (!known.includes(member) && value[member] !== undefined) faults.push([joined(at, member), `is no member of a declaration in contract ${SERVED}`]);
}

function optional(value: Record<string, unknown>, member: string, valid: (each: unknown) => boolean, reason: string, faults: Fault[], at = ""): void {
  if (value[member] !== undefined && !valid(value[member])) faults.push([joined(at, member), reason]);
}

function sourceFaults(source: unknown, at: string, faults: Fault[]): void {
  if (!plain(source)) {
    faults.push([at, "is no source"]);
    return;
  }
  members(source, ["id", "read", "arrives", "feeders", "lacks"], at, faults);
  if (typeof source.id !== "string" || source.id.split(":").length !== 3 || source.id.split(":").some((part) => part === "") || /[/\\\0\s]/u.test(source.id)) {
    faults.push([`${at}.id`, "is no source pattern: <product>:<account>:<copy>, no slash, backslash, space or NUL"]);
  }
  if (!text(source.read)) faults.push([`${at}.read`, "names no reader"]);
  const roads = typeof source.arrives === "string" ? [source.arrives] : source.arrives;
  if (!Array.isArray(roads) || roads.length === 0 || !roads.every((road) => (ROADS as readonly unknown[]).includes(road))) faults.push([`${at}.arrives`, `is not one or more of ${ROADS.join(", ")}`]);
  optional(source, "feeders", strings, "is not a list of feeder names", faults, at);
  optional(source, "lacks", text, "is no words", faults, at);
}

function boundedFaults(value: unknown, at: string, faults: Fault[], more: readonly string[] = []): void {
  if (!plain(value)) {
    faults.push([at, "is not a default and its bounds"]);
    return;
  }
  members(value, ["default", "min", "max", ...more], at, faults);
  if (!isDuration(value.default)) faults.push([`${at}.default`, "is no duration (30s, 10m, 1h, 2d)"]);
  for (const member of ["min", "max"]) optional(value, member, isDuration, "is no duration (30s, 10m, 1h, 2d)", faults, at);
  if (more.includes("label")) optional(value, "label", text, "is no words", faults, at);
}

function backfillShape(value: unknown, faults: Fault[]): void {
  if (!plain(value)) {
    faults.push(["backfill", "is not a backfill"]);
    return;
  }
  members(value, ["pace", "unit", "about"], "backfill", faults);
  if (value.pace !== undefined) boundedFaults(value.pace, "backfill.pace", faults);
  optional(value, "unit", pair, "is not one and many", faults, "backfill");
  optional(value, "about", text, "is no words", faults, "backfill");
}

function workFaults(work: unknown, at: string, faults: Fault[]): void {
  if (!plain(work)) {
    faults.push([at, "is no work"]);
    return;
  }
  members(work, ["label", "about", "kind", "noun", "text_chars", "as_is", "timed"], at, faults);
  if (!text(work.label)) faults.push([`${at}.label`, "is no words"]);
  if (!text(work.about)) faults.push([`${at}.about`, "is no words"]);
  if (!["pictures", "audio", "text"].includes(work.kind as string)) faults.push([`${at}.kind`, "is not pictures, audio or text"]);
  if (!pair(work.noun)) faults.push([`${at}.noun`, "is not one and many"]);
  optional(work, "text_chars", (value) => Number.isSafeInteger(value) && (value as number) > 0, "is no count of characters", faults, at);
  optional(work, "as_is", (value) => value === true, "is not true", faults, at);
  optional(work, "timed", (value) => value === true, "is not true", faults, at);
  if (work.timed === true && work.kind !== "audio") faults.push([`${at}.timed`, "is on a work that hands no audio"]);
}

function fieldFaults(field: unknown, at: string, faults: Fault[]): void {
  if (!plain(field)) {
    faults.push([at, "is no field"]);
    return;
  }
  if (!FIELD_KINDS.includes(field.kind as string)) {
    faults.push([`${at}.kind`, `${String(field.kind)} is none of the release's field kinds (${FIELD_KINDS.join(", ")})`]);
    return;
  }
  const kind = field.kind as string;
  members(field, ["kind", "label", "about", "home", ...FIELD_MEMBERS[kind]!], at, faults);
  if (!text(field.label)) faults.push([`${at}.label`, "is no words"]);
  optional(field, "about", text, "is no words", faults, at);
  optional(field, "home", (value) => value === true, "is true or absent", faults, at);
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value);
  switch (kind) {
    case "secret":
      if (!text(field.secret)) faults.push([`${at}.secret`, "names no secret"]);
      break;
    case "choice":
      if (!plain(field.options) || !Object.values(field.options).every((option) => typeof option === "string" || pair(option))) faults.push([`${at}.options`, "is not options by id, each words or words and a note"]);
      else if (typeof field.default !== "string" || !Object.hasOwn(field.options, field.default)) faults.push([`${at}.default`, "is none of its options"]);
      break;
    case "number":
      if (!number(field.default)) faults.push([`${at}.default`, "is no number"]);
      for (const member of ["min", "max"]) optional(field, member, number, "is no number", faults, at);
      boundsFaults(field, number, at, faults);
      break;
    case "toggle":
      if (typeof field.default !== "boolean") faults.push([`${at}.default`, "is not true or false"]);
      break;
    case "duration":
      for (const member of ["default", "min", "max"]) optional(field, member, isDuration, "is no duration (30s, 10m, 1h, 2d)", faults, at);
      break;
    case "path":
      optional(field, "folder", (value) => value === true, "is true or absent", faults, at);
      break;
    case "list":
      optional(field, "items", (value) => value === "modes", "is modes or absent", faults, at);
      optional(field, "empty", text, "is no words", faults, at);
      break;
    case "email":
    case "text":
      optional(field, "account", (value) => value === true, "is true or absent", faults, at);
      optional(field, "placeholder", text, "is no words", faults, at);
      break;
    case "date":
      for (const member of ["default", "min", "max"]) optional(field, member, isDay, "is no date (2019-03-01)", faults, at);
      boundsFaults(field, isDay, at, faults);
      break;
    default:
      break;
  }
}

function boundsFaults(field: Record<string, unknown>, valid: (value: unknown) => boolean, at: string, faults: Fault[]): void {
  const [value, min, max] = [field.default, field.min, field.max].map((each) => (valid(each) ? (each as number | string) : undefined));
  if (min !== undefined && max !== undefined && min > max) {
    faults.push([`${at}.min`, `${min} is above its max ${max}: a min is at most its max`]);
    return;
  }
  if (value === undefined) return;
  if (min !== undefined && value < min) faults.push([`${at}.default`, `${value} is below its min ${min}: a default lies within its min and max`]);
  if (max !== undefined && value > max) faults.push([`${at}.default`, `${value} is above its max ${max}: a default lies within its min and max`]);
}

function exportFaults(value: unknown, faults: Fault[]): void {
  if (!plain(value)) {
    faults.push(["export", "is not an export"]);
    return;
  }
  if (!Array.isArray(value.recognise) || value.recognise.length === 0 || !value.recognise.every(isPattern)) {
    faults.push(["export.recognise", "is not a list of member patterns"]);
  }
  if (value.product !== undefined) {
    members(value, ["recognise", "product", "kind"], "export", faults);
    optional(value, "kind", (each) => IMPORTS.some((kind) => kind.root === undefined && kind.kind === each), "is no import kind of the release's whose rows are its readers' own", faults, "export");
    const product = value.product;
    if (!plain(product) || typeof product.id !== "string" || !ID.test(product.id) || !text(product.name)
      || (product.noun !== undefined && !(strings(product.noun) && product.noun.length === 2))
      || Object.keys(product).some((key) => key !== "id" && key !== "name" && key !== "noun")) {
      faults.push(["export.product", "is not exactly an import product's id and name, and its noun"]);
    }
    return;
  }
  members(value, ["recognise", "guide", "name", "takes", "wait", "file", "leaves"], "export", faults);
  if (!Array.isArray(value.guide) || value.guide.length === 0) faults.push(["export.guide", "is not the window's steps"]);
  else value.guide.forEach((step, index) => guideFaults(step, `export.guide[${index}]`, faults));
  optional(value, "name", text, "is no words", faults, "export");
  for (const member of ["takes", "wait", "file"]) optional(value, member, text, "is no words", faults, "export");
  optional(value, "leaves", (each) => Array.isArray(each) && each.length > 0 && each.every(isPattern), "is not a list of member patterns", faults, "export");
}

function guideFaults(step: unknown, at: string, faults: Fault[]): void {
  if (!plain(step) || !text(step.words)) {
    faults.push([at, "is not a step's words"]);
    return;
  }
  members(step, ["title", "words", "open"], at, faults);
  optional(step, "title", text, "is no words", faults, at);
  if (step.open !== undefined && (!plain(step.open) || !text(step.open.label) || !https(step.open.url) || Object.keys(step.open).some((key) => key !== "label" && key !== "url"))) {
    faults.push([`${at}.open`, "is not a button's label and https page"]);
  }
}

function macFaults(value: unknown, faults: Fault[]): void {
  if (!plain(value)) {
    faults.push(["mac", "is not a Mac block"]);
    return;
  }
  members(value, ["app", "grants", "sensor", "recorder", "store", "library"], "mac", faults);
  optional(value, "app", text, "is no words", faults, "mac");
  if (!Array.isArray(value.grants) || !value.grants.every((grant) => (MAC_GRANTS as readonly unknown[]).includes(grant))) faults.push(["mac.grants", `is not a list of ${MAC_GRANTS.join(", ")}`]);
  for (const member of ["sensor", "recorder", "library"]) optional(value, member, (each) => each === true, "is true or absent", faults, "mac");
  if (value.store !== undefined) storeShape(value.store, "mac.store", faults);
}

function chromeShape(value: unknown, faults: Fault[]): void {
  if (!plain(value)) {
    faults.push(["chrome", "is not a Chrome site"]);
    return;
  }
  members(value, ["origin", "signin", "probe"], "chrome", faults);
  if (!https(value.origin) || new URL(value.origin as string).origin !== value.origin) faults.push(["chrome.origin", `${String(value.origin)} is not an https origin`]);
  if (value.signin !== undefined) {
    if (!plain(value.signin) || typeof value.signin.origin !== "string") faults.push(["chrome.signin", "names no origin"]);
    else {
      members(value.signin, ["origin", "recipe"], "chrome.signin", faults);
      optional(value.signin, "recipe", text, "names no recipe", faults, "chrome.signin");
    }
  }
  if (value.probe !== null && !plain(value.probe)) faults.push(["chrome.probe", "is no probe, nor null"]);
  else if (plain(value.probe)) members(value.probe, ["url", "has", "cookie", "who"], "chrome.probe", faults);
}

function routeShape(route: unknown, at: string, faults: Fault[]): void {
  if (!plain(route)) {
    faults.push([at, "is no route"]);
    return;
  }
  const way = route.way as string;
  if (!Object.hasOwn(WAYS, way)) {
    faults.push([`${at}.way`, `${String(way)} is not key, device or client`]);
    return;
  }
  members(route, ["id", "way", "acquirer", "label", "about", "steps", "note", "refused", ...WAYS[way]!], at, faults);
  optional(route, "id", (value) => typeof value === "string" && ID.test(value), "is no id: lower case, digits and dashes", faults, at);
  if (!text(route.acquirer)) faults.push([`${at}.acquirer`, "names no acquirer"]);
  if (!text(route.label)) faults.push([`${at}.label`, "is no words"]);
  optional(route, "about", text, "is no words", faults, at);
  optional(route, "note", text, "is no words", faults, at);
  optional(route, "refused", text, "is no words", faults, at);
  if (route.steps !== undefined) {
    if (!Array.isArray(route.steps)) faults.push([`${at}.steps`, "is not the window's steps"]);
    else route.steps.forEach((step, index) => guideFaults(step, `${at}.steps[${index}]`, faults));
  }
  const check = (value: unknown) => plain(value) && typeof value.url === "string" && (value.account === undefined || typeof value.account === "string")
    && (value.forbidden === undefined || text(value.forbidden)) && Object.keys(value).every((member) => member === "url" || member === "account" || member === "forbidden");
  if (way === "key") {
    if (!strings(route.fields) || route.fields.length === 0) faults.push([`${at}.fields`, "types no field"]);
    optional(route, "check", check, "is not a url, the account's path and a 403's words", faults, at);
    return;
  }
  if (!text(route.field)) faults.push([`${at}.field`, "names no field"]);
  if (typeof route.scope !== "string") faults.push([`${at}.scope`, "is no scope"]);
  if (way === "device") {
    if (typeof route.issuer !== "string") faults.push([`${at}.issuer`, "is no address"]);
    optional(route, "resource", (value) => typeof value === "string", "is no address", faults, at);
  } else {
    if (!text(route.client)) faults.push([`${at}.client`, "names no client"]);
    optional(route, "check", check, "is not a url, the account's path and a 403's words", faults, at);
  }
}

function openFaults(value: unknown, faults: Fault[]): void {
  if (!plain(value)) {
    faults.push(["open", "is not a record's or a chat's page"]);
    return;
  }
  members(value, ["record", "chat"], "open", faults);
  if (value.record !== undefined) {
    if (!plain(value.record) || !strings(value.record.kinds) || value.record.kinds.length === 0) faults.push(["open.record", "names no kinds"]);
    else {
      members(value.record, ["kinds", "url"], "open.record", faults);
      const fault = templateFault(value.record.url, ["account", "key", "content"]);
      if (fault !== null) faults.push(["open.record.url", fault]);
    }
  }
  if (value.chat !== undefined) {
    if (!plain(value.chat)) faults.push(["open.chat", "is no chat's page"]);
    else {
      members(value.chat, ["url"], "open.chat", faults);
      const fault = templateFault(value.chat.url, ["account", "chat"]);
      if (fault !== null) faults.push(["open.chat.url", fault]);
    }
  }
}

export function templateFault(template: unknown, names: readonly string[]): string | null {
  if (typeof template !== "string" || template === "") return "is no address";
  const named = (name: string) => names.some((each) => (each === "content" ? /^content(?:\.(?!\d+(?:\.|$))[^.]+)+$/u.test(name) : each === name));
  let bad: string | null = null;
  const filled = template.replace(/\{([^}]*)\}/gu, (_, inner: string) => {
    const [name, ...filters] = inner.split("|");
    const filter = filters.join("|");
    if (!named(name!)) bad ??= `{${inner}}: a template holds ${names.map((each) => (each === "content" ? "{content.<path>}" : `{${each}}`)).join(" or ")}`;
    else if (filters.length > 1 || (filters.length === 1 && !/^(?:hex|(?:before|after):.)$/u.test(filter))) bad ??= `{${inner}}: one filter at most, hex, before:<c> or after:<c>`;
    return "x";
  });
  if (bad !== null) return bad;
  if (/[{}]/u.test(filled)) return "has a brace no part closes";
  return wholeAddress(template) ? null : addressFault(filled);
}

export function wholeAddress(template: string): boolean {
  return /^\{content\.[^{}]+\}$/u.test(template);
}

export function addressFault(address: string): string | null {
  try {
    const url = new URL(address);
    if (url.username !== "" || url.password !== "") return "names a user or a password before its host";
    return url.protocol === "https:" || APP_SCHEMES.includes(url.protocol) ? null : `${url.protocol} is not https, nor ${APP_SCHEMES.join(" or ")}`;
  } catch {
    return "is no address";
  }
}


export const NEVER_READ = {
  folders: [
    "~/.ssh", "~/.gnupg", "~/.aws", "~/.azure", "~/.kube", "~/.docker", "~/.config", "~/.netrc", "~/.npmrc",
    "~/Library/Keychains", "~/Library/Cookies", "~/Library/HTTPStorages", "~/Library/Accounts", "~/Library/Application Support/com.apple.TCC",
    "~/Library/Application Support/Lifestream",
  ],
  names: ["Cookies", "Login Data", "Web Data", "key4.db", "logins.json"],
  endings: [".keychain-db"],
  managers: ["1password", "bitwarden", "lastpass", "dashlane", "keepassxc", "enpass", "nordpass", "proton pass", "roboform"],
} as const;

const STORE_MEMBERS = ["feeder", "name", "held", "account", "spelled", "wake", "engine"];
const IDENTITIES = ["file", "core-data", "calendar"];
const ROLES = ["changes", "follows", "whole"];
const TABLE_MEMBERS = ["name", "key", "role", "keep", "touched_by", "chosen", "when_declared", "files"];
const STORE_NAME = /^[a-z0-9][a-z0-9_-]*$/u;
const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u;
const STREAM = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const MEMBER = /^(?!\.\.?$)[^/\\\0]+$/u;

function accountRule(account: MacStore["account"]): string {
  if (typeof account === "string") return account;
  return ["folders", "json_keys", "plist", "json"].find((member) => member in account)!;
}

function storeShape(store: unknown, at: string, faults: Fault[]): void {
  if (!plain(store)) {
    faults.push([at, "is not a Mac store"]);
    return;
  }
  const fault = (member: string, reason: string) => faults.push([joined(at, member), reason]);
  members(store, STORE_MEMBERS, at, faults);
  if (typeof store.feeder !== "string" || !ID.test(store.feeder)) fault("feeder", "is no feeder: lower case, digits and dashes");
  if (typeof store.name !== "string" || !STORE_NAME.test(store.name)) fault("name", "is no name: lower case, digits, dashes and underscores");
  if (!text(store.held) && !(strings(store.held) && store.held.length > 0 && store.held.every(text))) fault("held", "is no path, nor a list of paths");
  optional(store, "spelled", (value) => value === false, "is false or absent", faults, at);
  optional(store, "wake", (value) => typeof value === "string" && BUNDLE_ID.test(value), "is no bundle id", faults, at);
  if (store.wake !== undefined && plain(store.engine) && store.engine.kind !== "sqlite") fault("wake", `the Mac wakes an app only for a sqlite store, and this store's engine is ${String(store.engine.kind)}`);
  accountShape(store.account, joined(at, "account"), faults);
  engineShape(store.engine, joined(at, "engine"), faults);
}

function accountShape(account: unknown, at: string, faults: Fault[]): void {
  if (account === "local" || account === "apple-id") return;
  const rules = plain(account) ? ["folders", "json_keys", "plist", "json"].filter((member) => account[member] !== undefined) : [];
  if (!plain(account) || rules.length !== 1) {
    faults.push([at, "is not local, apple-id, nor exactly one of a plist's key, a json value, a json object's keys or a folder's profiles"]);
    return;
  }
  const rule = rules[0]!;
  const words = (member: string) => {
    if (!text(account[member])) faults.push([joined(at, member), "is no words"]);
  };
  words(rule);
  if (rule === "folders") {
    members(account, ["folders", "match", "holding", "spell"], at, faults);
    words("match");
    if (typeof account.holding !== "string" || !MEMBER.test(account.holding)) faults.push([joined(at, "holding"), "is no file's name"]);
    if (account.spell !== "lower-hyphen") faults.push([joined(at, "spell"), "is not lower-hyphen"]);
    return;
  }
  if (rule === "json_keys") {
    members(account, ["json_keys", "at", "where"], at, faults);
    words("at");
    testsShape(account.where, joined(at, "where"), faults);
    return;
  }
  members(account, [rule, rule === "plist" ? "key" : "at", "holds", "before", "digits"], at, faults);
  words(rule === "plist" ? "key" : "at");
  for (const member of ["holds", "before"]) optional(account, member, text, "is no words", faults, at);
  optional(account, "digits", (value) => value === true, "is true or absent", faults, at);
}

function testsShape(tests: unknown, at: string, faults: Fault[], required = false): void {
  if (tests === undefined && !required) return;
  if (!Array.isArray(tests) || tests.length === 0) {
    faults.push([at, "is not a list of tests"]);
    return;
  }
  tests.forEach((test, index) => {
    const here = `${at}[${index}]`;
    if (!plain(test) || !text(test.at)) {
      faults.push([here, "is no test: a value's path and one test"]);
      return;
    }
    members(test, ["at", "equals", "prefix", "object"], here, faults);
    const given = ["equals", "prefix", "object"].filter((member) => test[member] !== undefined);
    if (given.length !== 1) faults.push([here, "holds not exactly one of equals, prefix, object"]);
    optional(test, "equals", (value) => typeof value === "string" || typeof value === "number", "is no words nor number", faults, here);
    optional(test, "prefix", text, "is no words", faults, here);
    optional(test, "object", (value) => value === true, "is true or absent", faults, here);
  });
}

function memberShape(value: Record<string, unknown>, member: string, at: string, faults: Fault[]): void {
  if (typeof value[member] !== "string" || !MEMBER.test(value[member])) faults.push([joined(at, member), "is no member's name: one file's name"]);
}

function chosenSql(value: unknown): boolean {
  return text(value) || (Array.isArray(value) && value.length > 0 && value.every((each) => plain(each) && text(each.sql) && (each.when === undefined || text(each.when)) && Object.keys(each).every((member) => member === "sql" || member === "when")));
}

function engineShape(engine: unknown, at: string, faults: Fault[]): void {
  if (!plain(engine) || !["sqlite", "file", "logs", "biome"].includes(engine.kind as string)) {
    faults.push([joined(at, "kind"), "is not sqlite, file, logs or biome"]);
    return;
  }
  const fault = (member: string, reason: string): void => {
    faults.push([joined(at, member), reason]);
  };
  if (engine.kind === "biome") {
    members(engine, ["kind", "stream"], at, faults);
    if (typeof engine.stream !== "string" || !STREAM.test(engine.stream)) fault("stream", "is no Biome stream's name");
    return;
  }
  if (engine.kind === "logs") {
    members(engine, ["kind", "roots", "match", "beside", "start"], at, faults);
    if (!Array.isArray(engine.roots) || engine.roots.length === 0) fault("roots", "names no root");
    else engine.roots.forEach((root, index) => {
      const here = joined(at, `roots[${index}]`);
      if (!plain(root) || !text(root.path)) { faults.push([here, "is no root: a path"]); return; }
      members(root, ["path", "depth", "days"], here, faults);
      optional(root, "depth", (value) => Number.isInteger(value) && (value as number) >= 0, "is no depth: a whole number", faults, here);
      optional(root, "days", (value) => value === true, "is true or absent", faults, here);
    });
    if (!text(engine.match)) fault("match", "is no pattern");
    optional(engine, "beside", text, "is no pattern", faults, at);
    if (engine.start !== undefined) {
      const start = engine.start;
      const here = joined(at, "start");
      if (!plain(start)) return fault("start", "is no session's start");
      members(start, ["line", "session", "program"], here, faults);
      if (start.line !== "first" && !(plain(start.line) && text(start.line.stating) && Object.keys(start.line).length === 1)) faults.push([joined(here, "line"), "is not first, nor the line stating a value"]);
      testsShape(start.session, joined(here, "session"), faults);
      testsShape(start.program, joined(here, "program"), faults, true);
    }
    return;
  }
  if (engine.kind === "file") {
    members(engine, ["kind", "files", "names"], at, faults);
    const files = Array.isArray(engine.files) ? engine.files : [];
    if (files.length === 0) fault("files", "names no file");
    files.forEach((file, index) => {
      const here = joined(at, `files[${index}]`);
      if (!plain(file) || !text(file.path)) { faults.push([here, "is no file: a path and a member"]); return; }
      members(file, ["path", "member"], here, faults);
      memberShape(file, "member", here, faults);
    });
    if (engine.names !== undefined) {
      const names = engine.names;
      const here = joined(at, "names");
      if (!plain(names)) return fault("names", "is not the files a file names");
      members(names, ["from", "at", "where", "root", "index"], here, faults);
      if (!files.some((file) => plain(file) && file.member === names.from)) faults.push([joined(here, "from"), `${String(names.from)} is none of its files' members`]);
      for (const member of ["at", "root"]) if (!text(names[member])) faults.push([joined(here, member), "is no words"]);
      memberShape(names, "index", here, faults);
      testsShape(names.where, joined(here, "where"), faults);
    }
    return;
  }
  members(engine, ["kind", "stores"], at, faults);
  if (!Array.isArray(engine.stores) || engine.stores.length === 0) return fault("stores", "names no SQLite store");
  engine.stores.forEach((store, index) => sqliteShape(store, joined(at, `stores[${index}]`), faults));
}

function sqliteShape(store: unknown, at: string, faults: Fault[]): void {
  if (!plain(store)) {
    faults.push([at, "is no SQLite store"]);
    return;
  }
  members(store, ["path", "match", "member", "identity", "optional", "file_root", "attachments", "tables"], at, faults);
  if (!text(store.path)) faults.push([joined(at, "path"), "is no path"]);
  optional(store, "match", text, "is no pattern", faults, at);
  memberShape(store, "member", at, faults);
  if ((store.match !== undefined) !== (store.member === "<name>")) faults.push([joined(at, "member"), "is <name> exactly where a pattern finds the file"]);
  if (!IDENTITIES.includes(store.identity as string)) faults.push([joined(at, "identity"), `is not ${IDENTITIES.join(", ")}`]);
  optional(store, "optional", (value) => value === true, "is true or absent", faults, at);
  optional(store, "file_root", text, "is no path", faults, at);
  if (store.attachments !== undefined) {
    const here = joined(at, "attachments");
    if (!plain(store.attachments)) faults.push([here, "is not a member and the SQL that names its files"]);
    else {
      members(store.attachments, ["member", "select"], here, faults);
      memberShape(store.attachments, "member", here, faults);
      if (!chosenSql(store.attachments.select)) faults.push([joined(here, "select"), "is no SQL, nor a list of SQL each with its when"]);
      if (store.file_root === undefined) faults.push([here, "names files under no file_root"]);
    }
  }
  if (!Array.isArray(store.tables) || store.tables.length === 0) {
    faults.push([joined(at, "tables"), "names no table"]);
    return;
  }
  store.tables.forEach((table, index) => {
    const here = joined(at, `tables[${index}]`);
    if (!plain(table) || !text(table.name)) { faults.push([here, "is no table: a name and a role"]); return; }
    members(table, TABLE_MEMBERS, here, faults);
    const role = table.role;
    const main = plain(role) && Object.keys(role).length === 1 && plain(role.main) && text(role.main.time) && text(role.main.rows) && Object.keys(role.main).length === 2;
    if (!ROLES.includes(role as string) && !main) faults.push([joined(here, "role"), "is not changes, follows, whole, nor the main table's time and rows"]);
    for (const member of ["key", "chosen"]) optional(table, member, text, "is no words", faults, here);
    optional(table, "keep", chosenSql, "is no SQL, nor a list of SQL each with its when", faults, here);
    optional(table, "touched_by", (value) => Array.isArray(value) && value.every((each) => strings(each) && (each.length === 2 || each.length === 3) && each.every(text)), "is not a list of a table, its SQL and maybe its when", faults, here);
    optional(table, "when_declared", (value) => value === true, "is true or absent", faults, here);
    optional(table, "files", (value) => strings(value) && value.every(text), "is not a list of columns", faults, here);
  });
}

export function storeFaults(store: MacStore, lifestream: readonly string[] = []): Fault[] {
  const faults: Fault[] = [];
  const rule = accountRule(store.account);
  const fills = rule === "folders" || rule === "json_keys";
  const denied = [...NEVER_READ.folders, ...lifestream].map((folder) => ({ folder, parts: partsOf(folder) }));
  const path = (value: string, at: string, account: boolean, descends = false) => {
    const unfilled = !account ? "the account rule reads it, so it cannot hold <account>" : fills ? null : `its account rule (${rule}) fills no <account>`;
    const fault = pathFault(value, unfilled, denied, descends);
    if (fault !== null) faults.push([at, fault]);
  };
  const pattern = (value: string | undefined, at: string, names: boolean) => {
    if (value === undefined) return;
    const fault = patternFault(value, names);
    if (fault !== null) faults.push([at, fault]);
  };

  (typeof store.held === "string" ? [store.held] : store.held).forEach((held, index) => path(held, typeof store.held === "string" ? "held" : `held[${index}]`, true));
  if (typeof store.account === "object") {
    const account = store.account as Record<string, string>;
    path(account[rule]!, `account.${rule}`, false);
    if (rule === "folders") {
      path(`${account.folders!.replace(/\/$/u, "")}/<account>/${account.holding!}`, "account.holding", true);
      pattern(account.match, "account.match", false);
    }
  }
  const engine = store.engine;
  if (engine.kind === "sqlite") engine.stores.forEach((each, index) => {
    const at = `engine.stores[${index}]`;
    path(each.path, `${at}.path`, true);
    pattern(each.match, `${at}.match`, true);
    if (each.file_root !== undefined) path(each.file_root, `${at}.file_root`, true, true);
  });
  if (engine.kind === "file") {
    engine.files.forEach((file, index) => path(file.path, `engine.files[${index}].path`, true));
    if (engine.names !== undefined) path(engine.names.root, "engine.names.root", true, true);
  }
  if (engine.kind === "logs") {
    engine.roots.forEach((root, index) => path(root.path, `engine.roots[${index}].path`, true, true));
    pattern(engine.match, "engine.match", true);
    pattern(engine.beside, "engine.beside", true);
  }
  return faults.map(([member, reason]): Fault => [`mac.store.${member}`, reason]);
}

function partsOf(path: string): string[] {
  return path.slice(2).toLowerCase().split(/[/\\]/u).filter((part) => part !== "" && part !== ".");
}

function pathFault(path: string, unfilled: string | null, denied: readonly { folder: string; parts: string[] }[], descends: boolean): string | null {
  if (!path.startsWith("~/")) return `${path} is not spelled from ~/`;
  if (path.includes("\0")) return "holds a NUL";
  const rest = path.slice(2);
  if (/^[/\\]/u.test(rest) || /^[A-Za-z]:[/\\]/u.test(rest)) return `${path} holds an absolute part`;
  const stated = rest.split(/[/\\]/u);
  if (stated.includes("..")) return `${path} holds a .. part`;
  const parts = partsOf(path);
  if (parts.length === 0) return "names the home folder itself";
  for (const part of stated) {
    const placeholder = /<[^>]*>/u.exec(part)?.[0];
    if (placeholder === undefined) continue;
    if (part !== "<account>") return `${path}: ${placeholder} is no whole part <account>`;
    if (unfilled !== null) return `${path}: ${unfilled}`;
  }
  const same = (part: string, other: string) => part === other || part === "<account>";
  for (const { folder, parts: never } of denied) {
    if (parts.length >= never.length && never.every((part, index) => same(parts[index]!, part))) return `${path} lies under ${folder}, which is never read`;
    if (descends && parts.length < never.length && parts.every((part, index) => same(part, never[index]!))) return `${path} is read beneath and holds ${folder}, which is never read`;
  }
  const manager = parts.find((part) => NEVER_READ.managers.some((word) => part.includes(word)));
  if (manager !== undefined) return `${path}: ${manager} is a password manager's, which is never read`;
  const last = parts[parts.length - 1]!;
  if (NEVER_READ.names.some((name) => name.toLowerCase() === last) || NEVER_READ.endings.some((ending) => last.endsWith(ending))) return `${path} names a file never read`;
  return null;
}

function patternFault(pattern: string, names: boolean): string | null {
  if (!/^[\x20-\x7e]+$/u.test(pattern)) return "is not ASCII: a pattern the Mac and the home read alike is";
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] !== "\\") continue;
    if (pattern[index + 1] === "p" || pattern[index + 1] === "P") return "names a Unicode class (\\p{…}), which the Mac and the home read apart";
    index += 1;
  }
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern);
  } catch (error) {
    return `does not compile: ${(error as Error).message}`;
  }
  if (!names) return null;
  const never = [...NEVER_READ.names, ...NEVER_READ.endings.map((ending) => `login${ending}`)];
  const found = never.find((name) => compiled.test(name) || compiled.test(name.toLowerCase()));
  return found === undefined ? null : `matches ${found}, a file never read`;
}
