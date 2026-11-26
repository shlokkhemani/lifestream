import { describe, expect, it } from "vitest";
import { admit, admittedNone, clientFaults, connectorFaults, iconWords, shapeFaults, storeFaults, templateFault, type Fault } from "./admit.js";
import { checkAddress, CREDENTIAL, type Connector, type MacStore } from "./declaration.js";
import { providers } from "./index.js";
import * as macAppTemplate from "./templates/mac-app/index.js";

const reader = (name: string) => ({ name, kinds: { line: () => [] }, read: async function* () {} });
const acquirer = () => ({ name: "example-log-poll", source: "example-log:local:<home>", fetch: async () => ({ files: [] }) });

function declared(): Connector {
  return {
    id: "example-log", product: "example-log", name: "Example log", vendor: "example", type: "notes", records: "Lines an example service logs.",
    noun: ["line", "lines"], sources: [{ id: "example-log:local:<home>", read: "example-log-lines", arrives: "poll" }], acquirers: ["example-log-poll"],
    refresh: { default: "1h", min: "10m", max: "1d" },
    fields: {
      since: { kind: "date", label: "Since", default: "2019-03-01", min: "2000-01-01" },
      account: { kind: "email", label: "Account", account: true, placeholder: "person-a@example.com" },
      key: { kind: "secret", label: "Key", secret: "example-log.key" },
    },
    signin: [{ id: "example-log-key", acquirer: "example-log-poll", way: "key", fields: ["account", "key"], label: "Use a key", check: { url: "https://api.example.com/me", account: "email" } }],
    open: { record: { kinds: ["line"], url: "https://example.com/{account}/line/{key|before::}" } },
  };
}

function folder(over: Record<string, unknown> = {}) {
  return {
    contract: 3,
    connectors: [declared()] as unknown[],
    readers: [reader("example-log-lines")],
    acquirers: { "example-log-poll": acquirer },
    adapters: { "example-log": { line: { version: "1", kinds: ["line"], line: () => null } } },
    ...over,
  };
}

function changed(change: Record<string, unknown>) {
  return folder({ connectors: [{ ...declared(), ...change }] });
}

function exported(declaredExport: Record<string, unknown>) {
  const connector = { ...declared(), sources: [{ id: "example-log:<account>:export", read: "example-log-lines", arrives: "upload" }], export: declaredExport };
  for (const member of ["acquirers", "signin", "fields", "refresh", "open"] as const) delete (connector as Record<string, unknown>)[member];
  return folder({ connectors: [connector], acquirers: {} });
}

function faultsOf(module: unknown, whose: "release" | "home" = "home", admitted = admittedNone()): Fault[] {
  const result = admit(module, { folder: "example-log", whose, admitted, icons: new Set(["money", "note"]) });
  return "faults" in result ? result.faults : [];
}

describe("admission", () => {
  it("admits a folder of the contract's shape, and its names join the admitted", () => {
    const admitted = admittedNone();
    const result = admit(folder(), { folder: "example-log", whose: "home", admitted });
    expect("entry" in result).toBe(true);
    expect([...admitted.connectors.keys(), ...admitted.products.keys(), ...admitted.readers.keys(), ...admitted.acquirers.keys(), ...admitted.secrets.keys(), ...admitted.adapters.keys()])
      .toEqual(["example-log", "example-log", "example-log-lines", "example-log-poll", "example-log.key", "line for example-log"]);
  });

  it("refuses a contract the home does not serve, and a module that is none", () => {
    expect(faultsOf({ ...folder(), contract: 4 })).toEqual([["contract", "4 is no contract this home serves (it serves 3)"]]);
    expect(faultsOf({ ...folder(), contract: undefined })).toEqual([["contract", "null is no contract this home serves (it serves 3)"]]);
    expect(faultsOf(null)).toEqual([["module", "exports nothing a folder's entry module exports"]]);
  });

  it("refuses a contract 1 folder by what contracts 2 and 3 changed, and asks it to declare 3", () => {
    expect(faultsOf({ ...folder(), contract: 1 })).toEqual([["contract",
      "1 is no longer served: declare `export const contract = 3;`. Contract 2 narrowed the SDK to what a home connector can use and "
      + "removed the phone's, the labeler's and the owner statements' helpers, the handle spellings (canonicalEmail, canonicalPhone, handleOf and the rest), versionId, "
      + "Projection, View, SourceRow and Version: a reader's view is ReaderView, an adapter's records AdapterSource and AdapterVersion, a photos adapter's view PhotoView, and NeedsYou's options are its own fields. "
      + "Contract 3 put one start before every connector's history: a backfill declares no reach, and an acquirer reads lent.start_ms and lent.from_ms where it read lent.floor(source); "
      + "once the folder declares 3, the typecheck names the rest"]]);
    expect("entry" in admit(folder(), { folder: "example-log", whose: "home", admitted: admittedNone() })).toBe(true);
  });

  it("refuses a contract 2 folder by what contract 3 changed, and asks it to declare 3", () => {
    expect(faultsOf({ ...folder(), contract: 2 })).toEqual([["contract",
      "2 is no longer served: declare `export const contract = 3;`. "
      + "Contract 3 put one start before every connector's history: a backfill declares no reach, and an acquirer reads lent.start_ms and lent.from_ms where it read lent.floor(source); "
      + "once the folder declares 3, the typecheck names the rest"]]);
  });

  it("refuses each wrong member of a declaration by name", () => {
    expect(faultsOf(changed({
      id: "Example Log", type: "diary", hidden: false, noun: ["line"], expect: "soon", records: "", sources: [{ id: "example-log:local", read: "", arrives: "carrier" }],
      refresh: { default: "often" }, colour: "blue",
    }))).toEqual([
      ["connectors[0].colour", "is no member of a declaration in contract 3"],
      ["connectors[0].id", "is no id: lower case, digits and dashes"],
      ["connectors[0].records", "says nothing of what it records"],
      ["connectors[0].type", "diary is none of the release's types"],
      ["connectors[0].hidden", "is true or absent"],
      ["connectors[0].noun", "is not one and many"],
      ["connectors[0].expect", "is no duration (30s, 10m, 1h, 2d)"],
      ["connectors[0].sources[0].id", "is no source pattern: <product>:<account>:<copy>, no slash, backslash, space or NUL"],
      ["connectors[0].sources[0].read", "names no reader"],
      ["connectors[0].sources[0].arrives", "is not one or more of poll, chrome, mac, phone, upload, owner, label"],
      ["connectors[0].refresh.default", "is no duration (30s, 10m, 1h, 2d)"],
      ["adapters.example-log", "names no connector of the folder"],
    ]);
  });

  it("takes a timed audio work, and refuses timed on a work that hands no audio and a timed that is not true", () => {
    const work = { label: "Call transcripts", about: "A model writes out what was said on each call, both sides.", kind: "audio", noun: ["part of a call", "parts of calls"], timed: true };
    const shaped = (each: Record<string, unknown>) => shapeFaults({ ...declared(), processing: { transcripts: each } });
    expect(shaped(work)).toEqual([]);
    expect(shaped({ ...work, kind: "text" })).toEqual([["processing.transcripts.timed", "is on a work that hands no audio"]]);
    expect(shaped({ ...work, timed: false })).toEqual([["processing.transcripts.timed", "is not true"]]);
    expect(shaped({ ...work, timed: "yes" })).toEqual([["processing.transcripts.timed", "is not true"]]);
  });

  it("refuses a field of no kind the release holds, and a date, an email or a choice of the wrong shape", () => {
    expect(faultsOf(changed({
      fields: {
        since: { kind: "date", label: "Since", default: "2019-02-30", max: "tomorrow" },
        account: { kind: "email", label: "Account", account: true, placeholder: 4 },
        key: { kind: "secret", label: "Key", secret: "example-log.key" },
        mode: { kind: "choice", label: "Mode", options: { a: "A" }, default: "b" },
        colour: { kind: "colour", label: "Colour" },
      },
    }))).toEqual([
      ["connectors[0].fields.since.default", "is no date (2019-03-01)"],
      ["connectors[0].fields.since.max", "is no date (2019-03-01)"],
      ["connectors[0].fields.account.placeholder", "is no words"],
      ["connectors[0].fields.mode.default", "is none of its options"],
      ["connectors[0].fields.colour.kind", "colour is none of the release's field kinds (secret, choice, number, toggle, duration, path, list, email, text, date, zone)"],
    ]);
  });

  it("refuses a number's or a date's default outside its min and max, and a min above its max", () => {
    const fields = (more: Record<string, unknown>) => faultsOf(changed({ fields: { ...declared().fields, ...more } }));
    expect(fields({
      since: { kind: "date", label: "Since", default: "1999-12-31", min: "2000-01-01" },
      count: { kind: "number", label: "Count", default: 0, min: 1, max: 10 },
      most: { kind: "number", label: "Most", default: 11, max: 10 },
      span: { kind: "number", label: "Span", default: 5, min: 10, max: 1 },
      until: { kind: "date", label: "Until", default: "2030-01-01", min: "2030-01-02", max: "2020-01-01" },
    })).toEqual([
      ["connectors[0].fields.since.default", "1999-12-31 is below its min 2000-01-01: a default lies within its min and max"],
      ["connectors[0].fields.count.default", "0 is below its min 1: a default lies within its min and max"],
      ["connectors[0].fields.most.default", "11 is above its max 10: a default lies within its min and max"],
      ["connectors[0].fields.span.min", "10 is above its max 1: a min is at most its max"],
      ["connectors[0].fields.until.min", "2030-01-02 is above its max 2020-01-01: a min is at most its max"],
    ]);
    expect(fields({
      count: { kind: "number", label: "Count", default: 1, min: 1, max: 10 },
      until: { kind: "date", label: "Until", default: "2020-01-01", min: "2020-01-01", max: "2020-01-01" },
    })).toEqual([]);
  });

  it("admits a backfill of only its about, and refuses one that declares how far back it reads, which the home's start decides", () => {
    expect(faultsOf(changed({ backfill: { about: "Collects the notes already kept." } }))).toEqual([]);
    expect(faultsOf(changed({ backfill: { reach: { default: "all", choosable: true } } }))).toEqual([["connectors[0].backfill.reach", "is no member of a declaration in contract 3"]]);
  });

  it("refuses a product a handle could read two ways", () => {
    for (const product of ["phone", "email", "jid", "person", "contact", "group", "google", "face"]) {
      expect(faultsOf(changed({ product }))).toContainEqual(["connectors[0].product", `${product} is a word a handle's id begins with: no product takes it`]);
    }
    expect(faultsOf(changed({ products: { group: { name: "Groups", vendor: "example" } } }))).toContainEqual(["connectors[0].products.group", "is no product, or one a handle's id begins with"]);
  });

  it("refuses an Open in template of an unknown part, a second filter, or an address no client opens, and takes a part the content states", () => {
    expect(templateFault("https://mail.example.com/?authuser={account}#all/{key|hex}", ["account", "key"])).toBeNull();
    expect(templateFault("https://wa.example/{chat|before:@}", ["account", "chat"])).toBeNull();
    expect(templateFault("imessage:{chat}", ["account", "chat"])).toBeNull();
    expect(templateFault("https://example.com/{content.repo.name}/{content.number}", ["account", "key", "content"])).toBeNull();
    expect(templateFault("{content.html_url}", ["account", "key", "content"])).toBeNull();
    expect(templateFault("https://example.com/{content}", ["account", "key", "content"])).toBe("{content}: a template holds {account} or {key} or {content.<path>}");
    expect(templateFault("https://example.com/{content..url}", ["account", "key", "content"])).toBe("{content..url}: a template holds {account} or {key} or {content.<path>}");
    expect(templateFault("{content.url}", ["account", "chat"])).toBe("{content.url}: a template holds {account} or {chat}");
    expect(templateFault("{key}", ["account", "key", "content"])).toBe("is no address");
    expect(templateFault("https://example.com/{content.items.0.url}", ["account", "key", "content"])).toBe("{content.items.0.url}: a template holds {account} or {key} or {content.<path>}");
    expect(templateFault("https://person-a@example.com/{key}", ["account", "key", "content"])).toBe("names a user or a password before its host");
    expect(templateFault("https://example.com/{chat}", ["account", "key"])).toBe("{chat}: a template holds {account} or {key}");
    expect(templateFault("https://example.com/{key|hex|before::}", ["account", "key"])).toBe("{key|hex|before::}: one filter at most, hex, before:<c> or after:<c>");
    expect(templateFault("https://example.com/{key|upper}", ["account", "key"])).toBe("{key|upper}: one filter at most, hex, before:<c> or after:<c>");
    expect(templateFault("http://example.com/{key}", ["account", "key"])).toBe("http: is not https, nor imessage: or sms:");
    expect(templateFault("javascript:alert({key})", ["account", "key"])).toBe("javascript: is not https, nor imessage: or sms:");
    expect(faultsOf(changed({ open: { record: { kinds: ["line"], url: "ftp://example.com/{key}" }, chat: { url: "sms:{key}" } } }))).toEqual([
      ["connectors[0].open.record.url", "ftp: is not https, nor imessage: or sms:"],
      ["connectors[0].open.chat.url", "{key}: a template holds {account} or {chat}"],
    ]);
  });

  it("refuses a name the module does not export, and a check in code for no route", () => {
    expect(faultsOf(folder({ readers: [reader("other-lines")], acquirers: {}, signins: { "example-log-key": async () => ({ account: "a" }), "nobody": async () => ({ account: "a" }) } }))).toEqual([
      ["connectors[0].signin[0].check", "example-log-key's check is declared and in code: one check a route"],
      ["connectors[0].sources[0].read", "example-log-lines is no reader the module exports"],
      ["connectors[0].acquirers", "example-log-poll is no acquirer the module exports"],
      ["signins.nobody", "names no route of the folder's connectors"],
    ]);
    expect(faultsOf(changed({ chrome: { origin: "https://example.com", signin: { origin: "https://id.example.com", recipe: "example-sign-in" }, probe: null }, signin: undefined, fields: undefined }))).toEqual([
      ["connectors[0].chrome.signin.recipe", "example-sign-in is no recipe the module exports"],
    ]);
  });

  it("refuses a step that acts in a recipe no connector of the folder signs in with", () => {
    const recipe = (name: string) => ({ name, version: 1, site: "Example", origins: ["https://example.com"], steps: [{ id: "open", do: "open", url: "https://example.com/" }, { id: "submit", do: "click", target: { role: "button", name: "Go" }, acts: true }] });
    const chrome = { chrome: { origin: "https://example.com", signin: { origin: "https://id.example.com", recipe: "example-sign-in" }, probe: null }, signin: undefined, fields: undefined };
    const recipes = { "example-sign-in": recipe("example-sign-in"), "example-export": recipe("example-export") };
    expect(faultsOf({ ...changed(chrome), recipes })).toEqual([
      ["recipes.example-export.steps[1].acts", "marks a sign-in's submit, which only a recipe a connector of the folder names as its chrome.signin.recipe has"],
    ]);
    expect(faultsOf({ ...folder(), recipes: { "example-export": recipe("example-export") } })).toEqual([
      ["recipes.example-export.steps[1].acts", "marks a sign-in's submit, which only a recipe a connector of the folder names as its chrome.signin.recipe has"],
    ]);
    expect(faultsOf({ ...changed(chrome), recipes: { "example-sign-in": recipe("example-sign-in") } })).toEqual([]);
  });

  it("refuses a recipe's parameter it does not declare, a secret it does not name and an origin it does not list, and admits each it does", () => {
    const recipe = (params: string[], secrets: string[], steps: Record<string, unknown>[]) => ({
      name: "example-sign-in", version: 1, site: "Example", origins: ["https://id.example.com"], params, secrets, steps,
    });
    const target = { role: "textbox", name: "Email" };
    const wrong = recipe(["email"], ["${password}", "example.key"], [
      { id: "email", do: "fill", target: [target, { label: "${mail}" }], text: "${email}" },
      { id: "password", do: "fill", target, secret: "${password}" },
      { id: "key", do: "fill", target, secret: "example.other" },
      { id: "home", do: "open", url: "https://example.com/start" },
      { id: "broken", do: "open", url: "id.example.com/start" },
      { id: "account", do: "open", url: "https://${host}/start" },
    ]);
    expect(faultsOf(folder({ recipes: { "example-sign-in": wrong } }))).toEqual([
      ["recipes.example-sign-in.secrets[0]", "${password} is no parameter the recipe declares: a step or a secret names only one of its params"],
      ["recipes.example-sign-in.steps[0].target[1].label", "${mail} is no parameter the recipe declares: a step or a secret names only one of its params"],
      ["recipes.example-sign-in.steps[1].secret", "${password} is no parameter the recipe declares: a step or a secret names only one of its params"],
      ["recipes.example-sign-in.steps[5].url", "${host} is no parameter the recipe declares: a step or a secret names only one of its params"],
      ["recipes.example-sign-in.steps[2].secret", "example.other is no secret the recipe names: a step fills only one of its secrets"],
      ["recipes.example-sign-in.steps[3].url", "https://example.com is none of the recipe's origins: a step opens only an address on one of its origins"],
      ["recipes.example-sign-in.steps[4].url", "id.example.com/start is no address: a step opens only an address on one of its origins"],
    ]);
    const right = recipe(["email", "password", "host"], ["${password}", "example.key"], [
      { id: "email", do: "fill", target: [target, { label: "${email}" }], text: "${email}" },
      { id: "password", do: "fill", target, secret: "${password}" },
      { id: "key", do: "fill", target, secret: "example.key" },
      { id: "home", do: "open", url: "https://id.example.com/start?as=${email}" },
      { id: "account", do: "open", url: "https://${host}/start" },
    ]);
    expect(faultsOf(folder({ recipes: { "example-sign-in": right } }))).toEqual([]);
  });

  it("refuses a name another folder holds already, and one a folder names twice", () => {
    const admitted = admittedNone();
    expect("entry" in admit(folder(), { folder: "first", whose: "release", admitted })).toBe(true);
    expect(faultsOf(folder(), "home", admitted)).toEqual([
      ["readers[0].name", "example-log-lines is a reader the folder first holds already"],
      ["connectors[0].id", "example-log is a connector the folder first holds already"],
      ["connectors[0].product", "example-log is a product the folder first holds already"],
      ["connectors[0].sources", "example-log:local:<home> is a source pattern the folder first holds already"],
      ["connectors[0].fields.key.secret", "example-log.key is a secret the folder first holds already"],
      ["connectors[0].acquirers", "example-log-poll is an acquirer the folder first holds already"],
      ["adapters.example-log.line", "line for example-log is an adapter the folder first holds already"],
    ]);
    expect(faultsOf(folder({ readers: [reader("example-log-lines"), reader("example-log-lines")] }))).toEqual([
      ["readers[1].name", "example-log-lines is a reader this folder names twice"],
    ]);
  });

  it("refuses an adapter of a family the release lacks, of no connector, of no shape, and a line that reads a family's kind", () => {
    const note = () => null;
    expect(faultsOf(folder({
      adapters: {
        "example-log": { diary: { version: "1", kinds: ["line"] }, notes: { version: "1", kinds: ["line"], note }, line: { version: "1", kinds: ["line"], line: note }, mail: { kinds: [] } },
        "example-other": { line: { version: "1", kinds: ["line"] } },
      },
    }))).toEqual([
      ["adapters.example-log.diary", "is no family the release holds: a folder brings no new family"],
      ["adapters.example-log.line.kinds", "line is read by its notes adapter: a plain line reads no kind a family reads"],
      ["adapters.example-log.mail", "is no adapter: a version and the kinds it reads"],
      ["adapters.example-other", "names no connector of the folder"],
    ]);
  });

  it("refuses an adapter missing a call its family's contract requires, by the call's name, whatever it declares besides", () => {
    const call = () => null;
    expect(faultsOf(folder({
      adapters: {
        "example-log": {
          messages: { version: "1", kinds: ["msg"], group: call, members: call, images: call },
          photos: { version: "1", kinds: ["img"], rank: 0, copy: call, files: call, image: call, placedBy: call },
          money: { version: "1", kinds: ["txn"] },
          calendar: { version: "1", kinds: ["event"], authority: "own", keys: "name", units: "account", event: call },
        },
      },
    }))).toEqual([
      ["adapters.example-log.messages.message", "is no call: the messages family calls it"],
      ["adapters.example-log.photos.rank", "is no call: the photos family calls it"],
      ["adapters.example-log.photos.position", "is no call: the photos family calls it"],
      ["adapters.example-log.calendar.words", "is no call: the calendar family calls it"],
    ]);
  });

  it("holds route ids: two routes on one acquirer each declare one, no two share one, a client route names a client", () => {
    const fields = { account: { kind: "email", label: "Account", account: true }, key: { kind: "secret", label: "Key", secret: "example-log.key" }, token: { kind: "secret", label: "Sign-in", secret: "example-log.token" } };
    const client = { acquirer: "example-log-poll", way: "client", field: "token", client: "example", scope: "read", label: "Sign in with Example", check: { url: "https://api.example.com/me" } };
    const key = { acquirer: "example-log-poll", way: "key", fields: ["account", "key"], label: "Use a key", check: { url: "https://api.example.com/me" } };
    const clients = [{ id: "example", name: "Example", authorize: "https://example.com/authorize", token: "https://example.com/token", before: ["Make a client at Example."] }];
    expect(faultsOf(changed({ fields, signin: [{ ...key, id: "example-key" }, { ...client, id: "example-oauth" }] }), "home")).toEqual([
      ["connectors[0].signin[1].client", "example is no client the release or the folder declares"],
    ]);
    const both = { ...changed({ fields, signin: [{ ...key, id: "example-key" }, { ...client, id: "example-oauth" }] }), clients };
    expect(faultsOf(both)).toEqual([]);
    expect(faultsOf({ ...changed({ fields, signin: [key, { ...client, id: "example-oauth" }] }), clients })).toEqual([
      ["connectors[0].signin[1].acquirer", "example-log-poll is another route's too"],
    ]);
    expect(faultsOf({ ...changed({ fields, signin: [{ ...key, id: "same" }, { ...client, id: "same" }] }), clients })).toEqual([
      ["connectors[0].signin[1].id", "same is another route's id too"],
    ]);
    expect(faultsOf({ ...changed({ fields, signin: [{ ...client, field: "account", scope: " ", check: { url: "http://example.com/me" } }] }), clients })).toEqual([
      ["connectors[0].signin[0].field", "account is none of example-log's secret fields"],
      ["connectors[0].signin[0].scope", "no scope is asked"],
      ["connectors[0].signin[0].check.url", "http://example.com/me is not an https address, nor http on loopback"],
    ]);
  });

  it("takes {credential} as the whole url alone, a link that is its own credential, and refuses it in any part of an address", () => {
    const route = (url: string) => changed({ signin: [{ id: "example-log-key", acquirer: "example-log-poll", way: "key", fields: ["account", "key"], label: "Use a key", check: { url } }] });
    expect(faultsOf(route(CREDENTIAL))).toEqual([]);
    const placed = [`https://api.example.com/v1/me?key=${CREDENTIAL}`, `https://api.example.com/feeds/${CREDENTIAL}/me`, `https://api.example.com/me#${CREDENTIAL}`, `https://${CREDENTIAL}.example.com/me`, `https://${CREDENTIAL}@api.example.com/me`];
    expect(placed.map((url) => faultsOf(route(url)))).toEqual(placed.map(() => [
      ["connectors[0].signin[0].check.url", `${CREDENTIAL} stands only as the whole url (a link that is its own credential): leave it out to send the credential as Authorization: Bearer, or check in code (the module's signins)`],
    ]));
    expect(faultsOf(route("https://person-a:secret-a@api.example.com/me"))).toEqual([
      ["connectors[0].signin[0].check.url", "holds a name or password: the credential goes as Authorization: Bearer, or check in code (the module's signins)"],
    ]);
    expect([
      checkAddress({ url: "https://api.example.com/me" }, "k-1"),
      checkAddress({ url: "https://person-a:secret-a@api.example.com/me" }, "k-1"),
      checkAddress({ url: CREDENTIAL }, "https://calendar.example.com/feeds/secret-a/calendar.ics"),
      checkAddress({ url: CREDENTIAL }, "webcal://calendar.example.com/feeds/secret-a/calendar.ics"),
      checkAddress({ url: CREDENTIAL }, "http://calendar.example.com/feeds/secret-a/calendar.ics"),
      checkAddress({ url: CREDENTIAL }, "https://person-a:secret-a@calendar.example.com/feeds/calendar.ics"),
      checkAddress({ url: CREDENTIAL }, "https://secret-a@calendar.example.com/feeds/calendar.ics"),
    ]).toEqual([
      { url: "https://api.example.com/me", bearer: true },
      { refused: "userinfo" },
      { url: "https://calendar.example.com/feeds/secret-a/calendar.ics", bearer: false },
      { refused: "address" },
      { refused: "address" },
      { refused: "userinfo" },
      { refused: "userinfo" },
    ]);
  });

  it("refuses a client of the wrong shape, and one another folder declares", () => {
    expect(clientFaults({ id: "Example", name: "", authorize: "http://example.com/a", token: "https://example.com/t", before: [], scope: "x" })).toEqual([
      ["scope", "is no member of a declaration in contract 3"],
      ["id", "is no id: lower case, digits and dashes"],
      ["name", "is no name"],
      ["authorize", "http://example.com/a is not an https address"],
      ["before", "says no step to make the client"],
    ]);
    const clients = [{ id: "example", name: "Example", authorize: "https://example.com/authorize", token: "https://example.com/token", before: ["Make a client at Example."] }];
    const admitted = admittedNone();
    admitted.clients.set("example", "first");
    expect(faultsOf(folder({ clients }), "home", admitted)).toEqual([["clients[0].id", "example is a client the folder first holds already"]]);
  });

  it("names no candidate for an icon not the release's, by key and Phosphor name", () => {
    expect(iconWords("runing", new Map([["run", "person-simple-run"], ["money", "money"], ["note", "note-blank"], ["days", "calendar-blank"]])))
      .toBe("runing is none of the release's icons: did you mean `run` (person-simple-run)?");
    expect(iconWords("calendar", new Map([["run", "person-simple-run"], ["days", "calendar-blank"]]))).toBe("calendar is none of the release's icons: did you mean `days` (calendar-blank)?");
    expect(iconWords("runing", new Set(["money", "run"]))).toBe("runing is none of the release's icons: did you mean `run`?");
    expect(iconWords("sparkles", new Set(["money", "note"]))).toBe("sparkles is none of the release's icons: did you mean `money`, `note`?");
  });

  it("refuses from a home connector what needs code the release compiles", () => {
    const home = changed({
      sources: [
        { id: "example-log:local:<unit>", read: "example-log-lines", arrives: ["poll", "phone"] }, { id: "example-log:local:owner", read: "example-log-lines", arrives: "owner" },
        { id: "example-log:<account>:export", read: "example-log-lines", arrives: "upload" },
      ],
      label: { labeler: "example-labeler" }, mac: { grants: [], sensor: true, recorder: true }, icon: "sparkles",
      export: { recognise: ["Elsewhere/**/*.json"], product: { id: "example", name: "Example" } },
    });
    const module = { ...home, labelers: { "example-labeler": () => ({}) } };
    expect(faultsOf(module, "home")).toEqual([
      ["connectors[0].sources[0].arrives", "the phone road needs code the release compiles: a home connector cannot take it"],
      ["connectors[0].sources[1].arrives", "the owner road needs code the release compiles: a home connector cannot take it"],
      ["connectors[0].label", "a labeler is the release's alone: a home connector cannot be one"],
      ["connectors[0].mac.sensor", "a Mac sensor is the Mac app's own: a home connector cannot be one"],
      ["connectors[0].mac.recorder", "the Mac's recorder is the Mac app's own: a home connector cannot be one"],
      ["connectors[0].icon", "sparkles is none of the release's icons: did you mean `money`, `note`?"],
      ["connectors[0].export.recognise", "Elsewhere/**/*.json lies under no import kind of the release's"],
      ["labelers", "a labeler is the release's alone: a home connector cannot be one"],
    ]);
    expect(faultsOf(module, "release")).toEqual([]);
    expect(faultsOf(exported({ recognise: ["Takeout/Example/*.json"], product: { id: "example", name: "Example" } }), "home")).toEqual([]);
  });

  it("refuses an export that is neither a connector's own nor a product of a kind, or feeds no source", () => {
    const own = { recognise: ["**/lines*.json"], guide: [{ words: "Download it.", open: { label: "Open Example", url: "https://example.com/download" } }] };
    expect(faultsOf(exported(own), "home")).toEqual([]);
    expect(faultsOf(exported({ ...own, name: "Example log export", takes: "A download you ask Example for", leaves: ["**/*.pdf"] }), "home")).toEqual([]);
    expect(faultsOf(exported({ recognise: ["**/lines*.json"] }), "home")).toEqual([["connectors[0].export.guide", "is not the window's steps"]]);
    expect(faultsOf(exported({ ...own, url: "https://example.com", member: "export_file" }), "home")).toEqual([
      ["connectors[0].export.url", "is no member of a declaration in contract 3"], ["connectors[0].export.member", "is no member of a declaration in contract 3"],
    ]);
    expect(faultsOf(exported({ ...own, recognise: ["../a.json"], guide: [{ words: "Go.", open: { label: "Go", url: "http://example.com" } }] }), "home")).toEqual([
      ["connectors[0].export.recognise", "is not a list of member patterns"], ["connectors[0].export.guide[0].open", "is not a button's label and https page"],
    ]);
    expect(faultsOf(changed({ export: own }), "home")).toEqual([["connectors[0].export", "feeds no source: declare one on the upload road"]]);
  });

  it("refuses from a home connector a source on the Mac's road with no store of its own to ship it, and a Mac photos library", () => {
    const mac = changed({ sources: [{ id: "example-log:<account>:<unit>", read: "example-log-lines", arrives: "mac" }], mac: { grants: ["fullDiskAccess"], library: true } });
    expect(faultsOf(mac, "home")).toEqual([
      ["connectors[0].mac.store", "is none: a home connector's source on the mac road ships only through a store it declares"],
      ["connectors[0].mac.library", "a Mac photos library is the Mac app's own: a home connector cannot be one"],
    ]);
    const release = faultsOf(mac, "release").map(([member]) => member);
    expect(release).not.toContain("connectors[0].mac.store");
    expect(release).not.toContain("connectors[0].mac.library");
  });

  it("admits the mac-app template as a home folder: its source ships through the store it declares", () => {
    const result = admit({ ...macAppTemplate }, { folder: "example-mac-app", whose: "home", admitted: admittedNone() });
    expect("faults" in result ? result.faults : []).toEqual([]);
    expect(macAppTemplate.connectors[0]!.mac?.store?.engine.kind).toBe("sqlite");
  });

  it("runs the sign-in's, the Chrome site's and the backfill's rules on a declaration of the right shape", () => {
    const connector = declared();
    expect(connectorFaults({ ...connector, chrome: { origin: "https://example.com", signin: { origin: "https://example.com" }, probe: null }, backfill: { pace: { default: "1m", min: "1s" } } }, { checks: new Set() })).toEqual([
      ["chrome.signin.origin", "https://example.com is the site's own origin"],
      ["backfill.pace.min", "1s: a page at most every 30s"],
    ]);
    expect(connectorFaults({ ...connector, colour: "blue" }, { checks: new Set() })).toEqual(shapeFaults({ ...connector, colour: "blue" }));
  });

  it("admits a product written another connector declares, whichever folder is admitted first; refuses its own, and one of no shape", () => {
    const admitted = admittedNone();
    const browser = { ...declared(), id: "example-browser", product: "example-browser", sources: [{ id: "example-browser:<account>:<unit>", read: "example-browser-history", arrives: "mac" }], acquirers: undefined, signin: undefined, fields: undefined, open: undefined };
    const browserFolder = folder({ connectors: [browser], readers: [reader("example-browser-history")], acquirers: {}, adapters: {} });
    expect(admit(browserFolder, { folder: "browser", whose: "release", admitted })).toHaveProperty("entry");
    expect(faultsOf(changed({ writes: ["example-browser"] }), "home", admitted)).toEqual([]);
    const sibling = { ...browser, id: "example-sibling", product: "example-sibling", sources: [{ id: "example-sibling:<account>:<unit>", read: "example-log-lines", arrives: "poll" }] };
    expect(faultsOf(folder({ connectors: [{ ...declared(), writes: ["example-sibling"] }, sibling] }))).toEqual([]);
    expect(faultsOf(changed({ writes: ["example-browser"] }))).toEqual([]);
    expect(faultsOf(changed({ writes: ["example-log"] }))).toEqual([["connectors[0].writes", "example-log is its own product: it writes only another connector's"]]);
    expect(faultsOf(changed({ writes: "example-browser" }))).toEqual([["connectors[0].writes", "is not a list of products"]]);
    expect(faultsOf(changed({ writes: ["Example Browser"] }))).toEqual([["connectors[0].writes", "is not a list of products"]]);
  });

  it("refuses a phone's restore and a library of the wrong shape, by name", () => {
    const phone = (more: Record<string, unknown>) => faultsOf(changed({ phone: { grants: [], ...more } }), "release");
    expect(phone({ restore: { kinds: ["line"] }, library: true })).toEqual([]);
    expect(phone({ restore: "contacts" })).toEqual([]);
    for (const restore of [{ kinds: [] }, { kinds: "line" }, { kinds: ["line"], whole: true }, "cards"]) {
      expect(phone({ restore })).toEqual([["connectors[0].phone.restore", "is not the kinds a new install takes back, or contacts"]]);
    }
    expect(phone({ library: false })).toEqual([["connectors[0].phone.library", "is true or absent"]]);
    expect(faultsOf(changed({ mac: { grants: [], library: "yes" } }), "release")).toEqual([["connectors[0].mac.library", "is true or absent"]]);
  });

  it("refuses a phone's why and misses where none of its grants has a first-run screen", () => {
    const phone = (grants: string[], more: Record<string, unknown>) => faultsOf(changed({ phone: { grants, ...more } }), "release");
    const words = { why: "To keep where you were.", misses: "where you were" };
    const shown = "is shown only on the first-run screen of a grant that has one (location, motion, health, photos, contacts, screen-time), and none of its grants does";
    expect(phone(["location", "notifications"], words)).toEqual([]);
    expect(phone(["notifications"], { domain: "example.com" })).toEqual([]);
    expect(phone(["notifications"], words)).toEqual([["connectors[0].phone.misses", shown], ["connectors[0].phone.why", shown]]);
    expect(phone([], { why: words.why })).toEqual([["connectors[0].phone.why", shown]]);
  });

  it("finds every declaration of the release's modules of the contract's shape", () => {
    const admitted = admittedNone();
    const faults = providers().flatMap((provider) => {
      const result = admit({ contract: 3, ...provider }, { folder: provider.connectors[0]!.id, whose: "release", admitted });
      return "faults" in result ? result.faults : [];
    });
    expect(faults).toEqual([]);
  });
});

const macs = Object.fromEntries(providers().flatMap((provider) => provider.connectors).filter((connector) => connector.mac?.store !== undefined)
  .map((connector) => [connector.id, connector.mac!]));

function store(change: Partial<MacStore> = {}): MacStore {
  return { ...structuredClone(macs.imessage!.store!), ...change };
}

describe("a Mac store", () => {
  it("passes each the release declares, of every engine", () => {
    expect(new Set(Object.values(macs).map((mac) => mac.store!.engine.kind))).toEqual(new Set(["sqlite", "file", "logs", "biome"]));
    for (const [name, mac] of Object.entries(macs)) expect([name, connectorFaults({ ...declared(), mac }, { checks: new Set() })]).toEqual([name, []]);
  });

  it("is refused at admission, by its member, where it reads the home's own folder", () => {
    const admitted = admittedNone();
    const imessage = providers().find((provider) => provider.connectors.some((connector) => connector.id === "imessage"))!;
    const result = admit({ contract: 3, ...imessage }, { folder: "imessage", whose: "release", admitted, lifestream: ["~/Library/Messages"] });
    expect("faults" in result ? result.faults : []).toEqual([
      ["connectors[0].mac.store.held", "~/Library/Messages/chat.db lies under ~/Library/Messages, which is never read"],
      ["connectors[0].mac.store.engine.stores[0].path", "~/Library/Messages/chat.db lies under ~/Library/Messages, which is never read"],
      ["connectors[0].mac.store.engine.stores[0].file_root", "~/Library/Messages lies under ~/Library/Messages, which is never read"],
    ]);
  });

  it("refuses a path not spelled from ~/, holding .., a NUL or an absolute part", () => {
    expect(storeFaults(store({ held: ["/Users/person-a/Library/Messages/chat.db", "~/Library/../.ssh/id_ed25519", "~/Library/Messages/chat\0.db", "~//etc/hosts", "~/C:/hosts", "~/"] }))).toEqual([
      ["mac.store.held[0]", "/Users/person-a/Library/Messages/chat.db is not spelled from ~/"],
      ["mac.store.held[1]", "~/Library/../.ssh/id_ed25519 holds a .. part"],
      ["mac.store.held[2]", "holds a NUL"],
      ["mac.store.held[3]", "~//etc/hosts holds an absolute part"],
      ["mac.store.held[4]", "~/C:/hosts holds an absolute part"],
      ["mac.store.held[5]", "names the home folder itself"],
    ]);
  });

  it("refuses <account> where its account rule fills none, and any other placeholder", () => {
    expect(storeFaults(store({ held: ["~/Library/Messages/<account>/chat.db", "~/Library/Messages/<name>.db"] }))).toEqual([
      ["mac.store.held[0]", "~/Library/Messages/<account>/chat.db: its account rule (apple-id) fills no <account>"],
      ["mac.store.held[1]", "~/Library/Messages/<name>.db: <name> is no whole part <account>"],
    ]);
    expect(storeFaults({ ...macs.chrome!.store!, account: { folders: "~/Documents/<account>", match: "^Default$", holding: "History", spell: "lower-hyphen" } })).toEqual([
      ["mac.store.account.folders", "~/Documents/<account>: the account rule reads it, so it cannot hold <account>"],
    ]);
    expect(storeFaults({ ...macs["aqua-voice"]!.store!, held: "~/Library/Application Support/Aqua Voice/<account>/" })).toEqual([]);
  });

  it("refuses what is never read, whoever declares it, without case, and Lifestream's own folders", () => {
    expect(storeFaults(store({
      held: [
        "~/.ssh/id_ed25519", "~/library/keychains/login.keychain-db", "~/Library/Application Support/Google/Chrome/Default/Cookies",
        "~/Library/Group Containers/2BUA8C4S2C.com.1password/data.sqlite", "~/Library/Application Support/Lifestream/pass", "~/lifestream-home/home.db",
        "~/Documents/old.keychain-db",
      ],
    }), ["~/lifestream-home"])).toEqual([
      ["mac.store.held[0]", "~/.ssh/id_ed25519 lies under ~/.ssh, which is never read"],
      ["mac.store.held[1]", "~/library/keychains/login.keychain-db lies under ~/Library/Keychains, which is never read"],
      ["mac.store.held[2]", "~/Library/Application Support/Google/Chrome/Default/Cookies names a file never read"],
      ["mac.store.held[3]", "~/Library/Group Containers/2BUA8C4S2C.com.1password/data.sqlite: 2bua8c4s2c.com.1password is a password manager's, which is never read"],
      ["mac.store.held[4]", "~/Library/Application Support/Lifestream/pass lies under ~/Library/Application Support/Lifestream, which is never read"],
      ["mac.store.held[5]", "~/lifestream-home/home.db lies under ~/lifestream-home, which is never read"],
      ["mac.store.held[6]", "~/Documents/old.keychain-db names a file never read"],
    ]);
  });

  it("refuses a folder read beneath that holds one never read, and an <account> that could name one", () => {
    const logs = macs.codex!.store!;
    expect(storeFaults({ ...logs, engine: { ...(logs.engine as Extract<MacStore["engine"], { kind: "logs" }>), roots: [{ path: "~/Library", depth: 3 }] } })).toEqual([
      ["mac.store.engine.roots[0].path", "~/Library is read beneath and holds ~/Library/Keychains, which is never read"],
    ]);
    const sqlite = store().engine as Extract<MacStore["engine"], { kind: "sqlite" }>;
    expect(storeFaults(store({ engine: { kind: "sqlite", stores: [{ ...sqlite.stores[0]!, file_root: "~/Library" }] } }))).toEqual([
      ["mac.store.engine.stores[0].file_root", "~/Library is read beneath and holds ~/Library/Keychains, which is never read"],
    ]);
    expect(storeFaults({ ...macs.chrome!.store!, held: "~/<account>/id_ed25519", account: { folders: "~/", match: "^\\.ssh$", holding: "id_ed25519", spell: "lower-hyphen" } })).toEqual([
      ["mac.store.held", "~/<account>/id_ed25519 lies under ~/.ssh, which is never read"],
      ["mac.store.account.folders", "names the home folder itself"],
      ["mac.store.account.holding", "~/<account>/id_ed25519 lies under ~/.ssh, which is never read"],
    ]);
  });

  it("refuses a pattern not ASCII, of a Unicode class, that does not compile, or that finds a file never read", () => {
    const reminders = macs["apple-reminders"]!.store!;
    const sqlite = reminders.engine as Extract<MacStore["engine"], { kind: "sqlite" }>;
    const matching = (...match: string[]) => ({ ...reminders, engine: { kind: "sqlite" as const, stores: match.map((each) => ({ ...sqlite.stores[0]!, match: each })) } });
    expect(storeFaults(matching("^Data-…\\.sqlite$", "^Data-\\p{L}+\\.sqlite$", "^Data-(\\.sqlite$", "^(Cookies|Data-[0-9]+\\.sqlite)$", "^Data-\\\\p\\.sqlite$"))).toEqual([
      ["mac.store.engine.stores[0].match", "is not ASCII: a pattern the Mac and the home read alike is"],
      ["mac.store.engine.stores[1].match", "names a Unicode class (\\p{…}), which the Mac and the home read apart"],
      ["mac.store.engine.stores[2].match", expect.stringMatching(/^does not compile: /u)],
      ["mac.store.engine.stores[3].match", "matches Cookies, a file never read"],
    ]);
  });

  it("refuses a wake on a store whose engine is not sqlite: the Mac wakes an app for a sqlite store alone", () => {
    expect(shapeFaults({ ...declared(), mac: { grants: [], store: { ...macs.codex!.store!, wake: "com.example.app" } } })).toEqual([
      ["mac.store.wake", "the Mac wakes an app only for a sqlite store, and this store's engine is logs"],
    ]);
    expect(shapeFaults({ ...declared(), mac: { grants: [], store: store({ wake: "com.example.app" }) } })).toEqual([]);
  });

  it("refuses each wrong member of a store's shape by name", () => {
    const sqlite = store().engine as Extract<MacStore["engine"], { kind: "sqlite" }>;
    const wrong = {
      ...store(), feeder: "iMessage Mac", colour: "blue", wake: "notes", spelled: true,
      account: { plist: "~/a.plist", key: "Own", json: "~/a.json", at: "me" },
      engine: { kind: "sqlite", stores: [{ ...sqlite.stores[0]!, member: "db/messages.db", identity: "wal", tables: [
        { name: "message", role: "main" },
        { name: "chat", role: "follows", touched_by: [["message", "SELECT 1 AS k", "message.id"], ["message"]] },
        { name: "handle", role: "follows", touched_by: [["message", "SELECT 1 AS k", "message.id", "message.date"]] },
      ] }, { ...sqlite.stores[0]!, member: "<name>", attachments: undefined, tables: [] }] },
    };
    expect(shapeFaults({ ...declared(), mac: { grants: [], store: wrong } })).toEqual([
      ["mac.store.colour", "is no member of a declaration in contract 3"],
      ["mac.store.feeder", "is no feeder: lower case, digits and dashes"],
      ["mac.store.spelled", "is false or absent"],
      ["mac.store.wake", "is no bundle id"],
      ["mac.store.account", "is not local, apple-id, nor exactly one of a plist's key, a json value, a json object's keys or a folder's profiles"],
      ["mac.store.engine.stores[0].member", "is no member's name: one file's name"],
      ["mac.store.engine.stores[0].identity", "is not file, core-data, calendar"],
      ["mac.store.engine.stores[0].tables[0].role", "is not changes, follows, whole, nor the main table's time and rows"],
      ["mac.store.engine.stores[0].tables[1].touched_by", "is not a list of a table, its SQL and maybe its when"],
      ["mac.store.engine.stores[0].tables[2].touched_by", "is not a list of a table, its SQL and maybe its when"],
      ["mac.store.engine.stores[1].member", "is <name> exactly where a pattern finds the file"],
      ["mac.store.engine.stores[1].tables", "names no table"],
    ]);
    const tests = { ...macs["aqua-voice"]!.store!, engine: { kind: "biome", stream: "../App.InFocus" }, account: { json_keys: "~/a.json", at: "users", where: [{ at: "version", equals: 1, prefix: "1" }, { at: "kind" }] } };
    expect(shapeFaults({ ...declared(), mac: { grants: [], store: tests } })).toEqual([
      ["mac.store.account.where[0]", "holds not exactly one of equals, prefix, object"],
      ["mac.store.account.where[1]", "holds not exactly one of equals, prefix, object"],
      ["mac.store.engine.stream", "is no Biome stream's name"],
    ]);
  });
});
