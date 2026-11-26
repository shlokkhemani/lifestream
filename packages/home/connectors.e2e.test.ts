import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  admittedNone, backfillFaults, chromeFaults, chromeSites, declarations, FOLDERS, faces, imports, formOf, productsOf, providers, recipes, roadsOf, runningOf, setsOf, signinFaults, siteOrigins, vendorOf, verdictOf, withRoadDefaults, NEED_REASONS, WAIT_REASONS,
  type Acquirer, type Connector, type Entry, type Field, type Lent, type Provider,
} from "@lifestreamprotocol/connect";
import {
  addDays, canonical, civilDay, dayBounds, duration, openHome, openHomeFolder, selects, sourceName, TALLY_MARK, TYPES,
  type AttemptRow, type Guard, type JobRow, type Json, type JsonObject, type SourceParts, type SourceRow, type SourceSelector,
} from "@lifestreamprotocol/core";
import type { Family } from "@lifestreamprotocol/families";
import { accountsOf, catalogOf, switchOf } from "./catalog.js";
import { openContext, runCli } from "./cli.js";
import { VERBS } from "./verbs/index.js";
import { pollKind, queuedFor, unparkPoll, type Call } from "./import.js";
import type { HelperEnv, Main } from "./jobs.js";
import { blocksOf, checkFolder, conformance, importConformance, LABEL, pagedAcquirers, SENTENCE, type World } from "./conformance.js";
import { deviceSettings, readConnectors, shownNeeds, type ConnectorsInput } from "./connectors.js";
import { needOf } from "./page-streams.js";
import type { ConnectorReport, StreamsReport } from "./streams-report.js";
import { nameKey } from "./devices.js";
import { holdsWords, NB, reasonWords, startWords, when } from "./stream-words.js";
import { serveDoor } from "./door.js";
import { startHome, type Home } from "./home.js";
import { mintPrincipal } from "./principals.js";
import { homeRegistryModule } from "./programs.js";
import { MODELS_META, type StoredModels } from "./models.js";
import { homeOf, loadRegistry, type Loaded, type Registry } from "./registry.js";
import { connectorsWith, families as releaseFamilies } from "./registry-home.js";
import { blockOf, connectorSettings, effective, effectiveOf, type Member } from "./settings.js";
import { answerForm } from "./verbs/args.js";
import { type Grants, type Recorder, type Stated, type Statement } from "./stated.js";
import { askHome } from "./socket.js";
import { type Need, needs, photosComing, photosStart, type Raised } from "./status.js";
import { editSettings, testSocket } from "./test/folder.js";
import { artifact, FAKES, LOOK_MS, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { statusOf } from "./test/harness-status.js";
import { fixtureDay, written } from "./fixture-day.js";
import { fixtureProofs, fixtureRead, timeFaults } from "./fixture-proof.js";
import type { Machine } from "./machine.js";
import { conformanceOf, folderVerb } from "./verbs/connectors-folder.js";
import { DEVICE, REPO } from "./test/support.js";
import { delivered } from "./test/through.js";
import { releaseFolder } from "./test/fed.js";
import { releaseAcquirers } from "./test/release-walk.js";

const MAC = "macbook-pro-0001";
const PHONE = "iphone-17-pro-aa01";
const GMAIL = "gmail:person-a@example.com:cloud";
const SCREEN = `screen:local:${MAC}`;
const WHATSAPP = `whatsapp:+15550000001:${MAC}`;
const BACKUP = "whatsapp:+15550000001:macbook-air-bb07";
const TAKEOUT = "youtube:person-a@example.com:export";
const LOCATION = `location:local:${PHONE}`;
const DAY_90 = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
const START_90 = Date.parse(`${DAY_90}T00:00:00Z`);

const whatsapp = {
  id: "whatsapp", product: "whatsapp", name: "WhatsApp", vendor: "meta", type: "messages", icon: "message", noun: ["message", "messages"], counts: ["msg"],
  records: "Messages, media, chats and groups, contact names and calls.",
  sources: [
    { id: "whatsapp:<account>:<unit>", read: "whatsapp-db", arrives: "mac" },
    { id: "whatsapp:<account>:<unit>", read: "whatsapp-db", arrives: "upload", lacks: "the call log" },
  ],
  refresh: { default: "5m", min: "1m" },
  fields: {
    groups_talk: { kind: "choice", home: true, label: "Who you talk to includes", default: "joined",
      options: { joined: "Groups, on days you write there", all: "Every group", none: "No groups" } },
  },
  backfill: { about: "Collects the chats that were there before you connected WhatsApp." },
  processing: {
    photos: { label: "Photo descriptions", kind: "pictures", noun: ["photo", "photos"], about: "A model describes the photos in your chats." },
    voice: { label: "Voice note transcripts", kind: "audio", noun: ["voice note", "voice notes"], about: "A model transcribes your voice notes." },
  },
  mac: { app: "WhatsApp", grants: ["fullDiskAccess"] },
  before: ["Install WhatsApp for Mac and link it to your phone."],
} satisfies Connector;

const gmail = {
  id: "gmail", product: "gmail", name: "Gmail", vendor: "google", type: "mail", noun: ["email", "emails"],
  records: "Every message in All Mail with its labels.",
  sources: [{ id: "gmail:<account>:cloud", read: "gmail", arrives: ["poll", "upload"], feeders: ["gmail-imap", "gmail-takeout"] }],
  acquirers: ["gmail-imap"],
  refresh: { default: "5m", min: "1m" },
  backfill: { pace: { default: "1m", min: "30s", max: "1h" }, about: "Collects the emails already in your mailbox." },
  processing: { mail: { label: "Email summaries", kind: "text", noun: ["email", "emails"], about: "A model writes one line for each automated email." } },
  fields: {
    account: { kind: "email", label: "Gmail address", account: true },
    password: { kind: "secret", label: "App password", secret: "gmail.password" },
    folders: { kind: "list", label: "Folders", default: [], empty: "All Mail" },
  },
  signin: [{
    acquirer: "gmail-imap", way: "key", fields: ["account", "password"], label: "Use an app password",
    steps: [{ title: "Make an app password", words: "At myaccount.google.com/apppasswords. Name it Lifestream." }],
  }],
  export: { recognise: ["Takeout/Mail/**/*.mbox"], product: { id: "mail", name: "Mail" } },
} satisfies Connector;

const claude = {
  id: "claude", product: "claude", name: "Claude", vendor: "anthropic", type: "ai", noun: ["message", "messages"], counts: ["msg"],
  records: "Your conversations and their files, as claude.ai shows them.",
  sources: [
    { id: "claude:<account>:browser", read: "claude-browser", arrives: "chrome" },
    { id: "claude:<account>:cloud", read: "claude-export", arrives: "upload" },
  ],
  acquirers: ["claude-browser"],
  refresh: { default: "30m", min: "5m" },
  backfill: { pace: { default: "2m", min: "30s", max: "1h" }, unit: ["conversation", "conversations"], about: "Collects your older conversations." },
  export: { recognise: ["**/users.json", "**/conversations.json"], guide: [{ words: "Ask Claude for your data, then download it.", open: { label: "Open Claude", url: "https://claude.example.com/settings" } }] },
  chrome: { origin: "https://claude.ai", probe: { url: "/api/account", has: "uuid", who: { id: "uuid", email: "email_address" } } },
} satisfies Connector;

const chatgpt = {
  id: "chatgpt", product: "chatgpt", name: "ChatGPT", vendor: "openai", type: "ai", noun: ["message", "messages"], counts: ["msg"],
  records: "Your conversations and their files, as chatgpt.com shows them.",
  sources: [{ id: "chatgpt:<account>:browser", read: "chatgpt-browser", arrives: "chrome" }, { id: "chatgpt:<account>:cloud", read: "chatgpt-export", arrives: "upload" }],
  acquirers: ["chatgpt-browser"],
  refresh: { default: "30m", min: "5m" },
  backfill: { pace: { default: "2m", min: "30s", max: "1h" }, unit: ["conversation", "conversations"], about: "Collects your older conversations." },
  chrome: { origin: "https://chatgpt.com", probe: { url: "/api/auth/session", has: "accessToken", who: { url: "/backend-api/me", id: "id", email: "email", bearer: true } } },
} satisfies Connector;

const google = {
  id: "google", product: "google-takeout", name: "Google activity", vendor: "google", type: "web",
  gives: "What you searched, watched and looked up across Google.",
  records: "Your My Activity, product by product, from your Takeouts.",
  products: { "google-maps": { name: "Google Maps", vendor: "google" }, youtube: { name: "YouTube", vendor: "google" } },
  sources: [{ id: "<product>:<account>:export", read: "google-my-activity", arrives: "upload" }],
  export: { recognise: ["Takeout/My Activity/Search/**"], product: { id: "my-activity", name: "My Activity", noun: ["entry", "entries"] } },
} satisfies Connector;

const screen = {
  id: "screen", product: "screen", name: "Screen", vendor: "lifestream", type: "device-activity", icon: "screen", noun: ["frame", "frames"],
  gives: "What you saw, as text.",
  records: "What’s on your screen, as video and text, so you can find anything you saw.",
  sources: [{ id: "screen:local:<unit>", read: "screen-recorder", arrives: "mac" }],
  refresh: { default: "2s", min: "1s", max: "5m", label: "Capture interval" },
  fields: {
    apps: { kind: "list", label: "Apps and sites", default: [], items: "modes" },
    idle_pause: { kind: "duration", label: "Idle timeout", default: "5m", min: "1m" },
    ocr: { kind: "choice", label: "OCR", options: { always: ["Every frame", "Reads every frame in full"], exact: "Skip unchanged frames" }, default: "exact" },
  },
  mac: { grants: ["screenRecording"], sensor: true, recorder: true },
} satisfies Connector;

const location = {
  id: "location", product: "location", name: "Location", vendor: "lifestream", type: "places", noun: ["point", "points"],
  records: "Where the phone was, and how sure iOS is of each place.",
  sources: [{ id: "location:local:<unit>", read: "location-ios-bundle", arrives: "phone" }],
  fields: { precision: { kind: "choice", label: "Precision", options: { precise: "Precise", battery: "Battery saving" }, default: "precise", about: "Battery saving records where you stay." } },
  phone: { grants: ["location"] },
} satisfies Connector;

const faceIndex = {
  id: "faces", product: "faces", name: "Faces", vendor: "lifestream",
  records: "Faces in your photos and chat images, and the groups you name.",
  sources: [{ id: "faces:local:<unit>", read: faces.facesConnector.name, arrives: "label" }],
  label: { labeler: faces.facesConnector.name, install: "Get the face models" },
  fields: { battery_backlog: { kind: "number", label: "Photos scanned on battery", default: 500, min: 0 } },
} satisfies Connector;

const spotify = {
  id: "spotify", product: "spotify", name: "Spotify", vendor: "spotify", type: "listening", noun: ["play", "plays"],
  records: "Every play of your streaming history, as Spotify exports it.",
  sources: [{ id: "spotify:<account>:export", read: "spotify-export", arrives: "upload" }],
  export: { recognise: ["**/Streaming_History_*.json"], guide: [{ words: "Ask Spotify for your extended streaming history, then download it.", open: { label: "Open Spotify", url: "https://spotify.example.com/privacy" } }] },
} satisfies Connector;

const DECLARED: readonly Connector[] = [whatsapp, gmail, claude, chatgpt, google, screen, location, faceIndex, spotify];
const ASKING: readonly Pick<Family, "name" | "works">[] = [
  { name: "messages", works: { photos: { product: ["whatsapp"] }, voice: { product: ["whatsapp"] } } },
  { name: "mail", works: { mail: { product: ["gmail"] } } },
];
const PAGING = ["gmail-imap", "claude-browser", "chatgpt-browser"];

const word = (said: Pick<Statement, "grants" | "settings">): Statement => ({ pass: "synthetic-pass", sending: {}, room: null, network: null, recorder: null, stores: null, heard_ms: 0, waiting_since_ms: null, found: null, imports: null, ...said });
const grantsOnly = (by: Readonly<Record<string, Grants>>): Stated => Object.fromEntries(Object.entries(by).map(([unit, grants]) => [unit, word({ grants, settings: null })]));

const row = (key: string, at: number) => ({ kind: "note", key, content: { text: `synthetic ${key}`, at }, at });


async function declaredFiles(root: string): Promise<Map<string, string>> {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "test" && entry.name !== "node_modules") walk(join(dir, entry.name));
      else if (entry.name === "connector.ts") files.push(join(dir, entry.name));
    }
  };
  walk(join(root, "packages", "connect"));
  const declared = new Map<string, string>();
  for (const file of files) {
    for (const value of Object.values(await import(pathToFileURL(file).href) as Record<string, unknown>)) {
      if (value !== null && typeof value === "object" && typeof (value as Connector).id === "string") declared.set((value as Connector).id, file);
    }
  }
  return declared;
}

async function declaredPages(root = REPO): Promise<Map<string, string>> {
  return new Map([...await declaredFiles(root)].map(([id, file]) => {
    let dir = dirname(file);
    while (!existsSync(join(dir, `${basename(dir)}.md`)) && dirname(dir) !== join(root, "packages")) dir = dirname(dir);
    return [id, relative(root, join(dir, `${basename(dir)}.md`))];
  }));
}

function listedPages(root = REPO, page = join("packages", "connect", "SKILL.md")): Set<string> {
  const text = readFileSync(join(root, page), "utf8");
  return new Set([...text.matchAll(/\]\(([^)#:]+\.md)(?:#[^)]*)?\)/gu)].map((match) => relative(root, join(root, dirname(page), match[1]!))));
}

function unworded(): string[] {
  const words = { name: "Example", noun: null, now: Date.UTC(2026, 8, 1), day: { zone: "UTC", day_start_hour: 4 }, facts: {} };
  return [...WAIT_REASONS, ...NEED_REASONS].filter((reason) => reasonWords("needs-you", reason, words) === words.name);
}

const ICONS = new Set(Object.keys((JSON.parse(readFileSync(join(REPO, "design", "icons.json"), "utf8")) as { icons: Record<string, unknown> }).icons));

const HERE = { root: REPO, sourceName, recipes: recipes() } satisfies Partial<World>;


function reportOf(root: string, { connectors = DECLARED, ...more }: Partial<Omit<ConnectorsInput, "registry">> & { connectors?: readonly Connector[] } = {}): StreamsReport {
  const settings = effective(root).settings;
  const running = more.settings ?? { ...settings, connectors: {} };
  const now_ms = more.now_ms ?? Date.now();
  return readHome(root, (db) => readConnectors(db, {
    folder: openHomeFolder(root), now_ms, settings: running, registry: { connectors, families: releaseFamilies(settings, root) },
    machine: process.env.LIFESTREAM_MACHINE_DIR!, sites: null, present: [], needs: [], free_bytes: Number.MAX_SAFE_INTEGER,
    photos: photosComing(db, photosStart(running, connectors, now_ms)), ...more,
  }));
}


type Fixture = import("../connect/test/drive.js").Fixture;

async function folderFixtures(root: string): Promise<{ fixtures: Record<string, Fixture>; twice: string[] }> {
  const connect = join(root, "packages", "connect");
  const folders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === "test") continue;
      if (dir === connect && ["shared", "templates", "imports"].includes(entry.name)) continue;
      walk(join(dir, entry.name));
    }
    if (existsSync(join(dir, "connector.ts")) && existsSync(join(dir, "test", "fixture.ts"))) folders.push(dir);
  };
  walk(connect);
  const fixtures: Record<string, Fixture> = {};
  const twice: string[] = [];
  for (const folder of folders.sort()) {
    const module = (await import(pathToFileURL(join(folder, "test", "fixture.ts")).href)) as { fixtures?: Readonly<Record<string, Fixture>> };
    for (const [read, fixture] of Object.entries(module.fixtures ?? {})) {
      if (Object.hasOwn(fixtures, read)) twice.push(`fixtures.${read}: two folders give it, the second ${relative(connect, folder)}`);
      fixtures[read] = fixture;
    }
  }
  return { fixtures, twice };
}

const KINDS = readdirSync(new URL("../connect/templates/", import.meta.url), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

async function templateModules(): Promise<Provider[]> {
  const modules: Provider[] = [];
  for (const kind of KINDS) modules.push((await import(new URL(`../connect/templates/${kind}/index.ts`, import.meta.url).href)) as Provider);
  return modules;
}

function linkTree(from: string, to: string, copyFiles: boolean): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.isSymbolicLink()) continue;
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) linkTree(src, dst, false);
    else if (copyFiles) cpSync(src, dst);
    else symlinkSync(src, dst);
  }
}

function repositoryCopy(at: string): string {
  linkTree(join(REPO, "packages", "connect"), join(at, "packages", "connect"), true);
  for (const each of ["tools/connectors.ts", "tools/phone-words.ts", "ios-app/LifestreamCapture/Connectors/Declared.swift"]) {
    cpSync(join(REPO, each), join(at, each), { recursive: true });
  }
  for (const each of ["core", "families", "model", "home"]) symlinkSync(join(REPO, "packages", each), join(at, "packages", each));
  const scoped = join(at, "node_modules", "@lifestreamprotocol");
  mkdirSync(scoped, { recursive: true });
  for (const name of readdirSync(join(REPO, "node_modules"))) if (name !== "@lifestreamprotocol") symlinkSync(join(REPO, "node_modules", name), join(at, "node_modules", name));
  for (const name of ["connect", "core", "families", "model", "home"]) symlinkSync(join(at, "packages", name), join(scoped, name));
  return at;
}

const fetched = (acquirer: string, outcome: string, reason: string | null, facts: JsonObject, since_ms: number, now: number, fails = 1): AttemptRow =>
  ({ target: `fetch:${acquirer}`, source: "", outcome, reason, facts, detail: "ACQUIRER WORDS", since_ms, at_ms: now - 60_000, contact_ms: null, fails });
const homeNeed = (id: string, state: Need["state"], reason: string): Raised => ({ id, state, reason: reason as Need["reason"], words: `synthetic ${id}`, since_ms: null, next_ms: null, acts: [], connector: null, copy: null, unit: null, at: null, detail: null });

function releaseWalkAll(): Promise<Record<string, { faults: string[]; lines: string[] }>> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.LIFESTREAM_TEST_DIST;
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(REPO, "packages", "home", "test", "release-walk.ts"), "--all"], { cwd: REPO, env });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
    child.on("close", (code) => (code === 0 ? done(JSON.parse(out) as Record<string, { faults: string[]; lines: string[] }>) : fail(new Error(`the walk ended ${String(code)}: ${err.trim().split("\n").at(-1) ?? ""}`))));
  });
}

describe("every release acquirer, walked as `lifestream connectors test` walks a home folder's", () => {
  let walks: Promise<Record<string, { faults: string[]; lines: string[] }>> | undefined;
  it.each(releaseAcquirers().map((each) => [each.name, each] as const))("%s walks clean", async (name) => {
    const { faults } = (await (walks ??= releaseWalkAll()))[name]!;
    expect(faults, `${name} walks clean`).toEqual([]);
  });
});

describe("the connectors", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) removeRoot(root);
  });

  it("lets a declaration break a rule unnamed, or the release's declarations break one", async () => {
    const world: World = {
      ...HERE, readers: new Set([...DECLARED.flatMap((each) => each.sources.map((source) => source.read)), "notes-mac"]),
      acquirers: new Set(DECLARED.flatMap((each) => each.acquirers ?? [])), icons: ICONS,
      pages: new Map([...DECLARED.map((each) => [each.id, "packages/connect/messages/whatsapp/whatsapp.md"] as const), ["notes", "packages/connect/notes/apple/apple.md"]]),
      listed: listedPages(), paged: new Set(PAGING), signins: new Set(["gmail-imap"]), families: ASKING,
    };
    expect(conformance(DECLARED, world)).toEqual(["<notes-mac>.read: declared by no connector"]);
    const notes = {
      id: "notes", product: "apple-notes", name: "Notes", vendor: "apple", type: "notes", records: "Every note's text, folder and attachments.",
      sources: [{ id: "apple-notes:<account>:<unit>", read: "notes-mac", arrives: "mac" }], mac: { app: "Notes", grants: ["fullDiskAccess"] },
    } satisfies Connector;
    const broken: Connector[] = [
      { ...notes, noun: ["note", "notes"], product: "notes-app", type: "stuff" as NonNullable<Connector["type"]>, icon: "sparkles", gives: "Your notes, on this Mac." },
      { ...notes, id: "notes-two", gives: "Every note you keep in Notes.", sources: [{ id: "apple-notes:<account>", read: "notes-mac", arrives: "poll", feeders: ["gmail-imap"] }], acquirers: ["notes-poll"] },
      {
        ...notes, id: "notes-three", noun: ["note", "notes"], records: "every note. And its folder. And its tags, its attachments, its links and every word written in each of them, as the app keeps them on disk", before: ["One.", "Two.", "Three."], backfill: { pace: { default: "10q" } },
        mac: { grants: [], sensor: true }, refresh: { default: "10s", min: "1m" }, export: { recognise: ["**/notes.json"], guide: [{ words: "Export your notes." }] },
      },
      {
        ...notes, id: "notes-four", noun: ["Note", "Notes"], records: "Every note's text, folder, attachments and tags, as Notes keeps them.",
        gives: "Every note's text, folder, attachments and tags, as Notes keeps them.", refresh: { default: "5m", label: "Capture interval." },
        fields: { file: { kind: "path", label: "Notes file.", about: "where the notes are" }, mode: { kind: "choice", label: "Mode", options: { a: ["Fast", "not a label."] }, default: "a" } },
        sources: [{ id: "apple-notes:<account>:<unit>", read: "notes-other", arrives: "mac" }], export: { recognise: ["Keep/**"], product: { id: "keep", name: "Keep" } },
      },
    ];
    const failures = conformance([gmail, ...broken], { ...world, readers: new Set([...world.readers, "notes-other", "gmail"]) });
    artifact(makeRootOnce(roots), "connectors-conformance", failures);
    expect(failures).toEqual([
      "notes.type: stuff is not in core's TYPES",
      "notes.icon: sparkles is not in design/icons.json",
      "notes.sources[0].id: apple-notes is neither its product nor one its products declare",
      'notes.gives: "Your notes, on this Mac." names a road, which the page says',
      "notes-two.sources[0].id: apple-notes:<account> does not parse as a source name: \"apple-notes:person-a@example.com\": a source is <product>:<account>:<copy>, the product one the home knows",
      "notes-two.sources[0].feeders: gmail-imap maps to gmail and to notes-mac",
      "notes-two.acquirers: no provider's module exports the acquirer notes-poll",
      "notes-two.gives: says Notes, which its name says",
      "notes-two.gives: names its type, Notes",
      "notes-two.page: no connector.ts declares it",
      "notes-three.sources: apple-notes:<account>:<unit> is notes's too",
      "notes-three.refresh: its default 10s is outside its bounds",
      "notes-three.backfill.pace: a duration that does not read (30s, 10m, 1h, 2d)",
      "notes-three.backfill: a sensor records from now on and has no backfill",
      "notes-three.backfill.pace.min: none: a page at most every 30s",
      'notes-three.records: "every note. And its folder. And its tags, its attachments, its links and every word written in each of them, as the app keeps them on disk" is no sentence: sentence case, its full stop, no "we"',
      "notes-three.records: more than two sentences",
      "notes-three.records: 138 characters, 10 over the 128 of two lines under its name in the stream's dialog",
      "notes-three.before: more than two sentences",
      "notes-three.export: only a connector a person hands an export of (a road upload) has an export",
      "notes-three.backfill.about: none: say what its backfill collects",
      "notes-three.page: no connector.ts declares it",
      "notes-four.sources: apple-notes:<account>:<unit> is notes-three's too",
      "notes-four.records: 69 characters, 5 over the 64 of one line under its name in the stream's dialog",
      "notes-four.gives: says Notes, which its name says",
      "notes-four.gives: says its records again: no gives",
      "notes-four.gives: names its type, Notes",
      "notes-four.noun: \"Note, Notes\" is not in lower case",
      "notes-four.refresh.label: \"Capture interval.\" is no label: sentence case, no full stop",
      "notes-four.fields.file.label: \"Notes file.\" is no label: sentence case, no full stop",
      "notes-four.fields.file.about: \"where the notes are\" is no sentence: sentence case, its full stop, no \"we\"",
      "notes-four.fields.mode.options.a: \"not a label.\" is no label: sentence case, no full stop",
      "notes-four.export: only a connector a person hands an export of (a road upload) has an export",
      "notes-four.export.recognise: its members lie under no one import kind's root",
      "notes-four.page: no connector.ts declares it",
      "<whatsapp-db>.read: declared by no connector",
      "<claude-browser>.read: declared by no connector",
      "<claude-export>.read: declared by no connector",
      "<chatgpt-browser>.read: declared by no connector",
      "<chatgpt-export>.read: declared by no connector",
      "<google-my-activity>.read: declared by no connector",
      "<screen-recorder>.read: declared by no connector",
      "<location-ios-bundle>.read: declared by no connector",
      `<${faces.facesConnector.name}>.read: declared by no connector`,
      "<spotify-export>.read: declared by no connector",
      "<notes-mac>.read: declared by notes and notes-two and notes-three",
    ]);

    const polled = { ...notes, noun: ["note", "notes"], refresh: { default: "1h" }, sources: [{ id: "apple-notes:<account>:cloud", read: "notes-mac", arrives: "poll" }] } satisfies Connector;
    const paging: Connector[] = [
      { ...polled, id: "notes-a", acquirers: ["notes-page"], backfill: {} },
      { ...polled, id: "notes-b", sources: notes.sources, acquirers: ["notes-page"], counts: ["tag"], backfill: { pace: { default: "1m", min: "10s" } } },
    ];
    const kinds = new Set(["note", "folder"]);
    const ruled = conformance(paging, {
      ...world, acquirers: new Set([...world.acquirers, "notes-page", "notes-poll"]), paged: new Set(["notes-page"]),
      landed: new Map([["notes-a", kinds], ["notes-b", kinds]]),
    }).filter((line) => /^notes-[ab]\.(?:backfill\.pace|counts|acquirers)/u.test(line));
    expect(ruled).toEqual([
      "notes-a.counts: its readers land folder, note: say which its noun counts",
      "notes-b.acquirers: a page on a device's road: a device pages its own history",
      "notes-b.backfill.pace.min: 10s: a page at most every 30s",
      "notes-b.counts: tag: no fixture of its readers lands it",
    ]);

    const summaries = { label: "Note summaries", kind: "text", noun: ["note", "notes"], about: "A model sums up each long note." } as const;
    const working: Connector[] = [
      { ...notes, id: "notes-w", processing: { summaries: { label: "note summaries.", kind: "text", noun: ["Note", ""], about: "a model sums up each note", text_chars: 0 } } },
      { ...notes, id: "notes-x", processing: { summaries, photos: summaries, voice: summaries }, backfill: { about: "collects your notes" } },
      { ...notes, id: "notes-y", sources: [{ id: "notes:local:<unit>", read: "notes-mac", arrives: "mac" }], processing: { summaries } },
    ];
    const asking = [{ name: "notes", works: { summaries: { product: ["apple-notes"] }, photos: { product: ["apple-notes"] } } }];
    expect(conformance(working, { ...world, families: asking }).filter((line) => /^notes-[wxy]\.(?:processing|backfill)/u.test(line))).toEqual([
      'notes-w.processing.summaries.label: "note summaries." is no label: sentence case, no full stop',
      'notes-w.processing.summaries.about: "a model sums up each note" is no sentence: sentence case, its full stop, no "we"',
      'notes-w.processing.summaries.noun: "Note, " is not one and many in lower case',
      "notes-w.processing.summaries.text_chars: 0 is no count of characters",
      "notes-w.processing.photos: the notes family asks it of its sources: declare it",
      "notes-x.processing.voice: no family asks it of its sources",
      'notes-x.backfill.about: "collects your notes" is no sentence: sentence case, its full stop, no "we"',
      "notes-y.processing.summaries: no family asks it of its sources",
    ]);
    const { processing: _, ...bare } = working[2]!;
    const copied = [{ name: "phone", works: { summaries: { product: ["notes"], copy: ["iphone-17-pro-aa01"] } } }];
    expect(conformance([working[2]!, { ...bare, id: "notes-z" }], { ...world, families: copied }).filter((line) => /^notes-[yz]\.processing/u.test(line))).toEqual([
      "notes-z.processing.summaries: the phone family asks it of its sources: declare it",
    ]);

    const routed: Connector[] = [{
      ...polled, id: "notes-d", acquirers: ["notes-page", "notes-poll"], backfill: { pace: { default: "1m", min: "30s" } },
      fields: { account: { kind: "email", label: "Notes email" }, mode: { kind: "choice", label: "Mode", options: { a: "A" }, default: "a" }, key: { kind: "secret", label: "Key", secret: "notes" } },
      signin: [
        { acquirer: "notes-poll", way: "key", fields: ["account", "mode", "missing"], label: "Use a key.", about: "a key", check: { url: "http://check.example.com/me" } },
        { acquirer: "notes-poll", way: "device", field: "account", label: "Sign in", issuer: "http://auth.example.com", scope: " " },
        { acquirer: "notes-other", way: "device", field: "key", label: "Sign in", issuer: "https://auth.example.com", scope: "read" },
        { acquirer: "notes-page", way: "device", field: "mode", label: "Sign in", issuer: "https://auth.example.com", scope: "read" },
      ],
    }];
    const signing = conformance(routed, { ...world, acquirers: new Set([...world.acquirers, "notes-page", "notes-poll"]), paged: new Set(["notes-page"]), signins: new Set(["notes-poll"]) })
      .filter((line) => /^notes-d\.(?:signin|fields)/u.test(line));
    expect(signing).toEqual([
      "notes-d.signin: 0 fields marked account: a sign-in writes its account into exactly one",
      "notes-d.signin[0].check: notes-poll's check is declared and in code: one check a route",
      "notes-d.signin[0].fields: missing is none of notes-d's fields",
      "notes-d.signin[0].fields: 0 secret fields: a key route takes one",
      "notes-d.signin[0].fields: mode is a choice field: a key route types identity fields and its secret",
      "notes-d.signin[0].check.url: http://check.example.com/me is not an https address, nor http on loopback",
      "notes-d.signin[1].acquirer: notes-poll is another route's too",
      "notes-d.signin[1].field: account is none of notes-d's secret fields",
      "notes-d.signin[1].issuer: http://auth.example.com is not an https address",
      "notes-d.signin[1].scope: no scope is asked",
      "notes-d.signin[2].acquirer: notes-other is none of notes-d's acquirers",
      "notes-d.signin[2]: no check: declare one, or export notes-other's in the module's signins",
      "notes-d.signin[3]: no check: declare one, or export notes-page's in the module's signins",
      "notes-d.signin[3].field: mode is none of notes-d's secret fields",
      "notes-d.signin[0].sets: missing is none of notes-d's fields",
      'notes-d.signin[0].label: "Use a key." is no label: sentence case, no full stop',
      'notes-d.signin[0].about: "a key" is no sentence: sentence case, its full stop, no "we"',
    ]);
    const loopback = { ...routed[0]!, id: "notes-e", fields: { ...routed[0]!.fields, account: { kind: "email", label: "Notes email", account: true }, zone: { kind: "zone", label: "Time zone" } },
      signin: [{ acquirer: "notes-page", way: "key", fields: ["account", "key"], label: "Use a key", check: { url: "http://127.0.0.1:4317/me", account: "login" } }] } satisfies Connector;
    expect([signinFaults(loopback, new Set()), formOf(loopback), setsOf(loopback.signin[0]!, loopback)]).toEqual([[], [], ["account", "key"]]);

    const site = (id: string, chrome: unknown): Connector => ({ ...notes, id, chrome } as Connector);
    const sites = [
      site("site-a", { origin: "https://site.example", probe: { url: "/api/me", has: "id", cookie: "session", who: { url: "https://api.site.example/me", id: "id", email: "email" } } }),
      site("site-b", { origin: "https://site.example", probe: { who: { id: "id", email: "email" } } }),
      site("site-c", { origin: "https://site.example", probe: { cookie: "session", who: { id: "id", email: "email" } } }),
      site("site-d", { origin: "https://site.example", probe: { cookie: "session", who: { url: "http://api.site.example/me", id: "id", email: "email" } } }),
      site("site-e", { origin: "https://site.example", signin: { origin: "https://id.site.example/sign-in" }, probe: null }),
      site("site-f", { origin: "https://site.example", signin: { origin: "https://site.example" }, probe: null }),
      site("site-g", { origin: "https://site.example", signin: { origin: "https://id.site.example", recipe: "site-sign-in" }, probe: { cookie: "session", who: { url: "https://api.site.example/me", id: "user.id", email: "account.email" } } }),
    ];
    expect(sites.flatMap((each) => chromeFaults(each).map(([member, what]) => `${each.id}.${member}: ${what}`))).toEqual([
      "site-a.chrome.probe: a url and has, and a cookie: a probe is one or the other",
      "site-b.chrome.probe: no url and has, nor a cookie",
      "site-c.chrome.probe.who.url: a cookie probe reads whose it is at an absolute https address",
      "site-d.chrome.probe.who.url: a cookie probe reads whose it is at an absolute https address",
      "site-e.chrome.signin.origin: https://id.site.example/sign-in is not an https origin",
      "site-f.chrome.signin.origin: https://site.example is the site's own origin",
    ]);
    const signsIn = (id: string, recipe: string, origin: string): Connector => site(id, { origin: "https://app.whoop.com", signin: { origin, recipe }, probe: null });
    const recipeFaults = conformance([signsIn("site-h", "site-sign-in", "https://id.whoop.com"), signsIn("site-i", "whoop-sign-in", "https://id.site.example"), signsIn("site-j", "whoop-sign-in", "https://id.whoop.com")], world);
    expect(recipeFaults.filter((each) => each.includes("chrome.signin.recipe"))).toEqual([
      "site-h.chrome.signin.recipe: site-sign-in names no recipe",
      "site-i.chrome.signin.recipe: whoop-sign-in reaches none of https://id.site.example",
    ]);
  });

  it("lets the release's declarations break a rule, or connect throw a wait of no reason the home knows", async () => {
    const { settings } = effectiveOf({ "day.zone": "UTC", unit: "macbook-pro-0001" }, "the conformance test");
    const registry = await loadRegistry(homeRegistryModule().href, settings, homeOf(openHomeFolder(makeRootOnce(roots))));
    const pages = await declaredPages();
    const release: World = {
      ...HERE, readers: new Set(registry.readers.map((each) => each.name)), acquirers: new Set(providers().flatMap((provider) => Object.keys(provider.acquirers ?? {}))), icons: ICONS,
      pages: new Map(registry.connectors.map((each) => [each.id, pages.get(each.id) ?? null])), listed: listedPages(), paged: pagedAcquirers(registry.connectors, makeRootOnce(roots)),
      signins: new Set(providers().flatMap((provider) => Object.keys(provider.signins ?? {}))), families: registry.families,
    };
    expect(conformance(registry.connectors, release)).toEqual([]);
    const pinned = JSON.parse(readFileSync(join(REPO, "packages", "connect", "test", "products.json"), "utf8")) as Record<string, { name: string; vendor: string }>;
    const declaredProducts = productsOf(registry.connectors).products;
    expect(Object.fromEntries(Object.entries(declaredProducts).map(([product, each]) => [product, { name: each.name, vendor: each.vendor }]))).toEqual(pinned);
    expect(Object.keys(releaseFolder("google/my-activity").FOLDERS).filter((product) => declaredProducts[product] === undefined)).toEqual([]);
    const recordsOf = new Map(registry.connectors.map((connector) => [connector.id, connector.records]));
    expect(Object.entries(declaredProducts).filter(([, each]) => !each.records || each.records !== recordsOf.get(each.connector)).map(([product]) => product)).toEqual([]);
    expect(unworded()).toEqual([]);
  });

  it("lets a release folder, taken as `lifestream connectors test` takes one, after the names admitted before it, fail admission, a rule, a fixture or its acquirers' build", async () => {
    const { settings } = effectiveOf({ "day.zone": "UTC", unit: "macbook-pro-0001" }, "the conformance test");
    const registry = await loadRegistry(homeRegistryModule().href, settings, homeOf(openHomeFolder(makeRootOnce(roots))));
    const pages = await declaredPages();
    const listed = listedPages();
    const connect = join(REPO, "packages", "connect");
    const { fixtures } = await folderFixtures(REPO);
    const failures: string[] = [];
    const admitted = admittedNone();
    for (const { folder, module } of FOLDERS) {
      const dir = join(connect, folder);
      failures.push(...checkFolder({
        dir, folder, whose: "release", module, fixture: { fixtures }, admitted, work: makeRootOnce(roots),
        world: { ...HERE, icons: ICONS, families: registry.families }, listed: { root: REPO, pages: listed }, pageOf: (connector) => pages.get(connector.id) ?? null,
      }).map((failure) => `${folder}: ${failure}`));
    }
    expect(failures).toEqual([]);
  });

  it("lets an import kind's declaration break a rule unnamed, or a stream a kind several connectors read feeds go underived", () => {
    const kinds = imports.importKinds(declarations(), providers().flatMap((provider) => provider.readers));
    const takeout = kinds.find((kind) => kind.id === "google-takeout")!;
    const spotifyKind = kinds.find((kind) => kind.id === "spotify")!;
    const broken: imports.ImportKind[] = [
      { ...takeout, icon: "takeout-logo", takes: "A download you make at Google.", ask: "whose Google account is this",
        guide: [...takeout.guide, { words: "lifestream finds it", open: { label: "Open.", url: "http://example.com/" } }],
        products: [{ ...takeout.products[0]!, id: "My Activity", noun: ["Search", "searches"] }, takeout.products[1]!, takeout.products[1]!] },
      { ...spotifyKind, guide: [] },
      spotifyKind,
    ];
    expect(importConformance(broken, { icons: new Set(["archive", "listening"]) })).toEqual([
      "google-takeout.icon: takeout-logo is not in design/icons.json",
      'google-takeout.takes: "A download you make at Google." is no label: capital first, no full stop',
      'google-takeout.ask: "whose Google account is this" is no sentence: sentence case, its full stop, no "we"',
      `google-takeout.guide.${takeout.guide.length + 1}: "lifestream finds it" is no sentence: sentence case, its full stop, no "we"`,
      `google-takeout.guide.${takeout.guide.length + 1}.open.label: "Open." is no label: capital first, no full stop`,
      `google-takeout.guide.${takeout.guide.length + 1}.open.url: http://example.com/ is not https`,
      "google-takeout.guide: more than one step has a button",
      "google-takeout.products.My Activity: an id is lowercase, words joined by hyphens",
      "google-takeout.products.My Activity.noun: a noun is lower case",
      `google-takeout.products.${takeout.products[1]!.id}: two products share the id`,
      "spotify.guide: no step",
      "spotify.kind: two declarations share it",
    ]);
    expect(importConformance(kinds, { icons: ICONS })).toEqual([]);
    expect(kinds.map((kind) => kind.id)).toEqual(["google-takeout", "iphone-backup", "chatgpt", "claude", "google-timeline", "spotify"]);
    expect(declarations().filter((connector) => imports.importOf(connector) !== null).map((connector) => [connector.id, imports.importOf(connector)!.kind]).sort()).toEqual([
      ["apple-calls", "iphone-backup"], ["apple-contacts", "google-takeout"], ["gmail", "google-takeout"], ["google", "google-takeout"], ["google-calendar", "google-takeout"],
      ["google-photos", "google-takeout"], ["imessage", "iphone-backup"], ["whatsapp", "iphone-backup"],
    ]);
  });

  it("lets a reader's fixture be missing or land less than it states, or one spoiled file of it fail its import, cost more than the file, refuse the rest, go unnamed (ruined), time an item by its arrival, or read other rows when read again with its own records landed", async () => {
    const root = makeRootOnce(roots);
    const { settings } = effectiveOf({ "day.zone": "UTC", unit: MAC }, "the conformance test");
    const registry = await loadRegistry(homeRegistryModule().href, settings, homeOf(openHomeFolder(root)));
    const { fixtures, twice } = await folderFixtures(REPO);
    const reads = new Set(registry.connectors.flatMap((connector) => connector.sources.map((source) => source.read)));
    const unread = Object.keys(fixtures).filter((read) => !reads.has(read)).map((read) => `fixtures.${read}: no connector declares the reader`);
    const { faults, lines } = await fixtureProofs({ work: root, registry, settings, connectors: registry.connectors, fixtures });
    artifact(root, "connectors-ruined", lines);
    expect([...twice, ...unread, ...faults]).toEqual([]);
  });

  it("lets a release adapter state, over its folder's fixtures, a value its family relies on otherwise (packages/families/<family>/faults.ts)", async () => {
    const work = makeRootOnce(roots);
    const { settings } = effectiveOf({ "day.zone": "UTC", unit: MAC }, "the conformance test");
    const { fixtures } = await folderFixtures(REPO);
    const stated = new Set<string>();
    for (const { folder, module } of FOLDERS) {
      const entry = module as unknown as Entry;
      if (Object.keys(entry.adapters ?? {}).length === 0) continue;
      for (const reader of entry.readers.filter((each) => Object.hasOwn(fixtures, each.name))) {
        const day = await fixtureDay({ work, settings, fixtures: { [reader.name]: fixtures[reader.name]! }, folder: { ...entry, connectors: entry.connectors.map(withRoadDefaults) } });
        for (const fault of day.stated) stated.add(`${folder}: ${fault}`);
      }
    }
    expect([...stated]).toEqual([]);
  });

  it("lets a template break a rule the release keeps (packages/connect/templates)", async () => {
    const root = makeRootOnce(roots);
    const templates = await templateModules();
    const connectors = templates.flatMap((module) => module.connectors);
    const { settings } = effectiveOf({ "day.zone": "UTC", unit: MAC }, "the conformance test");
    const registry = await loadRegistry(homeRegistryModule().href, settings, homeOf(openHomeFolder(root)));
    const world: World = {
      ...HERE, readers: new Set(templates.flatMap((module) => module.readers.map((reader) => reader.name))),
      acquirers: new Set(templates.flatMap((module) => Object.keys(module.acquirers ?? {}))), icons: ICONS,
      pages: new Map(await declaredPages().then((pages) => connectors.map((each) => [each.id, pages.get(each.id) ?? null] as const))),
      listed: listedPages(), paged: pagedAcquirers(connectors, root, templates),
      signins: new Set(templates.flatMap((module) => Object.keys(module.signins ?? {}))), families: registry.families,
    };
    expect(conformance(connectors, world)).toEqual([]);
    const fixtures: Record<string, Fixture> = {};
    for (const kind of KINDS) {
      Object.assign(fixtures, ((await import(new URL(`../connect/templates/${kind}/test/fixture.ts`, import.meta.url).href)) as { fixtures: Readonly<Record<string, Fixture>> }).fixtures);
    }
    const withTemplates = { ...registry, connectors: [...registry.connectors, ...connectors], readers: [...registry.readers, ...templates.flatMap((module) => module.readers)] };
    const { faults, lines } = await fixtureProofs({ work: root, registry: withTemplates, settings, connectors, fixtures });
    artifact(root, "connectors-templates", lines);
    expect(faults).toEqual([]);
  });

  it("lets `lifestream connectors new` write a release connector, of any kind, that breaks a rule or goes unread once tools/connectors.ts ran", async () => {
    const root = makeRootOnce(roots);
    const copy = repositoryCopy(join(root, "repository"));
    const made = KINDS.map((kind) => ({ kind, id: `acme-${kind}` }));
    for (const { kind, id } of made) {
      const type = kind === "label" ? "labelers" : /type: "([\w-]+)"/u.exec(readFileSync(join(REPO, "packages", "connect", "templates", kind, "connector.ts"), "utf8"))![1]!;
      const out: string[] = [];
      const status = await runCli(["connectors", "new", kind, id, "--into", join(copy, "packages", "connect", type, id), "--root", root], { write: (text) => out.push(text) });
      expect({ kind, status }, out.join("")).toEqual({ kind, status: 0 });
    }
    const generated = spawnSync(process.execPath, ["--import", "tsx", join(copy, "tools", "connectors.ts")], { cwd: copy, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
    expect(generated.status, generated.stderr).toBe(0);
    const core = (await import(pathToFileURL(join(copy, "packages", "core", "index.ts")).href)) as typeof import("@lifestreamprotocol/core");
    const connect = (await import(pathToFileURL(join(copy, "packages", "connect", "index.ts")).href)) as typeof import("@lifestreamprotocol/connect");
    const provided = connect.providers();
    const connectors = connect.declarations();
    const pages = await declaredPages(copy);
    const home = (await import(pathToFileURL(join(copy, "packages", "home", "registry-home.ts")).href)) as typeof import("./registry-home.js");
    const families = home.families(effectiveOf({ "day.zone": "UTC", unit: MAC }, "the conformance test").settings, root);
    const world: World = {
      root: copy, sourceName: core.sourceName, recipes: connect.recipes(),
      readers: new Set(provided.flatMap((provider) => provider.readers.map((reader) => reader.name))),
      acquirers: new Set(provided.flatMap((provider) => Object.keys(provider.acquirers ?? {}))), icons: ICONS,
      pages: new Map(connectors.map((each) => [each.id, pages.get(each.id) ?? null])), listed: listedPages(copy), paged: pagedAcquirers(connectors, root, provided),
      signins: new Set(provided.flatMap((provider) => Object.keys(provider.signins ?? {}))),
      families,
    };
    expect(made.filter(({ id }) => !connectors.some((each) => each.id === id))).toEqual([]);
    expect(conformance(connectors, world)).toEqual([]);
    const { fixtures } = await folderFixtures(copy);
    const found: string[] = [];
    for (const { kind, id } of made) {
      const connector = connectors.find((each) => each.id === id)!;
      const reader = provided.flatMap((provider) => provider.readers).find((each) => each.name === connector.sources[0]!.read)!;
      const folder = mkdtempSync(join(root, `${id}-`));
      const stated = fixtures[reader.name]!(folder);
      const reading = fixtureRead(reader, stated, folder, written(folder), root, Date.now());
      if (typeof reading === "string") throw new Error(`${id}: ${reading}`);
      const { rows, stated_ms } = await reading.rows(null);
      const kinds = new Set(rows.filter((row) => Object.hasOwn(reader.kinds, row.kind)).map((row) => row.kind));
      if (kinds.size === 0) found.push(`${id}: its fixture reads no row`);
      found.push(...timeFaults(connector, rows, stated_ms, kinds).map((what) => `${id}: ${what}`));
      if (kind === "phone") {
        const shipped = Object.keys(stated.files).flatMap((path) => /^bundle\/([^/]+)\.jsonl$/u.exec(path)?.[1] ?? []);
        const domain = connect.iosDomainOf(stated.source);
        if (domain === null || !shipped.includes(domain)) found.push(`${id}: its bundle ships ${shipped.join(", ")}, its copy routed from ${domain ?? "no domain"}`);
      }
    }
    expect(found).toEqual([]);
    expect(readFileSync(join(copy, "ios-app", "LifestreamCapture", "Connectors", "Declared.swift"), "utf8")).toContain('"acme-phone"');
  });

  it("lets `lifestream connectors new` write a home folder, of any kind a home takes, that fails `lifestream connectors test` or reaches no day, search or link; or a template run as it ships fail it", async () => {
    const root = makeRootOnce(roots);
    const at = { dir: makeRootOnce(roots) } as Machine;
    const out: string[] = [];
    const ran: Record<string, { faults: string[]; lines: string[] }> = {};
    for (const kind of KINDS.filter((each) => !["phone", "label"].includes(each))) {
      const { folder } = await folderVerb({ root, cwd: root, out: (line) => out.push(line), machine: at }, ["new", kind, `acme-${kind}`]) as { folder: string };
      expect(existsSync(join(folder, "e2e.test.ts"))).toBe(false);
      ran[kind] = await conformanceOf(folder);
    }
    ran["export (as it ships)"] = await conformanceOf(join(REPO, "packages", "connect", "templates", "export"));
    artifact(root, "connectors-new-home", ran);
    const day = /^\d{4}-\d\d-\d\d /u;
    expect(Object.entries(ran).map(([kind, run]) => [kind, run.faults, run.lines.some((line) => day.test(line)), run.lines.some((line) => /^search .*: (?!\(no words\))/u.test(line))]))
      .toEqual(Object.keys(ran).map((kind) => [kind, [], true, true]));
  });

  it("says a reader's or an acquirer's words to the person, or words a need otherwise than from its reason, its connector's name and its facts", () => {
    const root = makeRootOnce(roots);
    const now = Date.now();
    const at = now - 3 * 86_400_000;
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => {
      tx.tables.attempts.put(fetched("claude-browser", "need", "other-account", { email: "person-b@example.com" }, at, now));
      tx.tables.attempts.put(fetched("chatgpt-browser", "need", "confirm", {}, at, now));
      tx.tables.attempts.put(fetched("gmail-imap", "need", "password", { secret: "gmail.password", company: "Google" }, at, now));
    });
    db.close();
    const settings = effective(root).settings;
    const found = readHome(root, (read) => needs(read, { folder: openHomeFolder(root), now_ms: now, settings, connectors: DECLARED, families: releaseFamilies(settings, root), ledger: null }));
    artifact(root, "connectors-needs", found);
    const of = (id: string) => found.find((each) => each.id === id);
    expect(of("fetch:claude-browser")).toMatchObject({ state: "needs-you", reason: "other-account", words: "Another Claude account", line: "person-b@example.com in Chrome", connector: "claude" });
    expect(of("fetch:chatgpt-browser")).toMatchObject({ state: "needs-you", reason: "confirm", words: "Confirm it's you", line: "ChatGPT", connector: "chatgpt" });
    expect(of("password:gmail.password")).toMatchObject({ state: "needs-you", reason: "password", words: "Type your Google password", connector: "gmail" });
    expect(found.filter((each) => each.words.includes("ACQUIRER WORDS"))).toEqual([]);
  });

  it("names a Chrome account by anything but its email once one is known, says signed in on a copy, words a signed-out stream otherwise than its one need, or a wait on Chrome otherwise than by the account Chrome holds", () => {
    const root = makeRootOnce(roots);
    const A = "11111111-1111-4111-8111-00000000000a";
    const now = Date.now();
    const at = now - 60_000;
    const write = (change: (tx: Parameters<Parameters<ReturnType<typeof openHome>["commit"]>[0]>[0]) => void) => {
      const db = openHome(openHomeFolder(root), "migrate");
      try {
        db.commit(change);
      } finally {
        db.close();
      }
    };
    write((tx) => {
      tx.tables.sources.add({ id: `claude:${A}:browser`, vendor: vendorOf(declarations(), `claude:${A}:browser`), connector: "claude-browser", options: { lane: "claude-browser", email: "person-a@example.com" }, added_ms: 0 });
      tx.tables.deliveries.add({ id: `claude-browser/1`, source: `claude:${A}:browser`, sealed_ms: at, stated_ms: at, facts: {} });
      tx.tables.devices.add({ unit: "chrome-0001", model: "Chrome", added_ms: 0 });
      tx.tables.attempts.put({ ...fetched("claude-browser", "need", "signed-out", {}, at, now), source: `claude:${A}:browser`, detail: "SIGNED OUT" });
    });
    const settings = { ...effective(root).settings, sites: { chosen: ["claude"] } };
    const sites = (signed_in: boolean, account: { email: string; verdict: "read" | "not-read" | "offered" } | null) => DECLARED.flatMap((each) => each.chrome === undefined ? [] : [{
      origin: each.chrome.origin, signed_in, chosen: each.id === "claude", checking: false, choosing: null,
      stations: [{ unit: "chrome-0001", chosen: each.id === "claude", signed_in, account }],
    }]);
    const claudeOf = (more: Partial<ConnectorsInput>) => {
      const report = reportOf(root, { settings, present: ["chrome-0001"], ...more });
      return { claude: report.connectors.find((each) => each.id === "claude")!, needs: report.needs };
    };
    const out = claudeOf({ sites: sites(false, null) });
    expect(out.claude.copies.map((each) => each.name)).toEqual(["person-a@example.com"]);
    expect(out.claude.copies.every((each) => !/signed/iu.test(each.line))).toBe(true);
    expect([out.claude.health.state, out.claude.health.reason, out.claude.health.words, out.claude.chrome_account]).toEqual(["needs-you", "signed-out", "Sign in to Claude in Chrome", null]);
    expect(out.needs.filter((need) => need.connector === "claude").map((need) => [need.id, need.words, need.copy])).toEqual([[`fetch:claude-browser:claude:${A}:browser`, "Sign in to Claude in Chrome", `claude:${A}:browser`]]);
    const everyOne = reportOf(root, { settings, present: ["chrome-0001"], sites: sites(false, null) }).connectors;
    expect(everyOne.map((each) => [each.id, each.origin])).toEqual(everyOne.map((each) => [each.id, DECLARED.find((declared) => declared.id === each.id)?.chrome?.origin ?? null]));
    expect(everyOne.filter((each) => each.origin !== null && each.chosen === false && !each.health.acts.some((act) => act.do === "open")).length).toBeGreaterThan(0);
    expect(claudeOf({ sites: sites(true, { email: "person-a@example.com", verdict: "read" }) }).claude.chrome_account).toEqual({ email: "person-a@example.com", verdict: "read" });
    write((tx) => tx.tables.attempts.put({ ...fetched("claude-browser", "wait", "chrome", { account: "person-b@example.com" }, at, now), source: `claude:${A}:browser` }));
    const waiting = claudeOf({ sites: sites(true, null) });
    expect([waiting.claude.health.state, waiting.claude.health.words, waiting.needs.filter((need) => need.connector === "claude")]).toEqual([
      "waiting", "Waiting for Chrome signed in as person-b@example.com", []]);
    artifact(root, "connectors-accounts", { out: out.claude.copies });
  });

  it("finds a site lane's cloud copies by anything but its connector's feeders, reads one turned off, or names one otherwise than by its email", () => {
    const root = makeRootOnce(roots);
    const site = {
      id: "whoop", product: "whoop", name: "WHOOP", vendor: "whoop", type: "health", noun: ["reading", "readings"], records: "Your cycles, sleeps, stress and heart rate, as WHOOP reads them.",
      sources: [{ id: "whoop:<account>:cloud", read: "whoop-capture", arrives: "chrome", feeders: ["whoop"] }], acquirers: ["whoop"],
      refresh: { default: "1h", min: "1m" }, chrome: { origin: "https://app.whoop.example", probe: null },
    } satisfies Connector;
    const connectors = [...DECLARED, site];
    const now = Date.now();
    const db = openHome(openHomeFolder(root), "migrate");
    let sources: SourceRow[];
    try {
      sources = db.commit((tx) => {
        tx.tables.sources.add({ id: "whoop:10000001:cloud", vendor: vendorOf(declarations(), "whoop:10000001:cloud"), connector: "whoop-capture", options: { email: "person-a@example.com" }, added_ms: 0 });
        tx.tables.sources.add({ id: "whoop:10000002:cloud", vendor: vendorOf(declarations(), "whoop:10000002:cloud"), connector: "whoop-capture", options: { email: "person-b@example.com" }, added_ms: 1 });
        tx.tables.attempts.put(fetched("whoop", "need", "other-account", { offered: { id: "10000003", email: "person-c@example.com" } }, now - 60_000, now));
        return tx.tables.sources.list();
      });
    } finally {
      db.close();
    }
    const lane = { name: "whoop", source: "whoop" };
    expect(accountsOf(connectors, sources, ["whoop"], switchOf(connectors, []), () => [])).toEqual({ "10000001": true, "10000002": true });
    const one = accountsOf(connectors, sources, ["whoop"], switchOf(connectors, ["whoop:10000002:cloud"]), () => []);
    expect([one, verdictOf(one, "10000001"), verdictOf(one, "10000002"), verdictOf(one, "10000003")]).toEqual([{ "10000001": true, "10000002": false }, "read", "not-read", "offered"]);
    expect([switchOf(connectors, ["whoop:10000002:cloud"]).poll(lane, sources, () => []), switchOf(connectors, ["whoop:10000001:cloud", "whoop:10000002:cloud"]).poll(lane, sources, () => [])]).toEqual([false, true]);
    const report = reportOf(root, { connectors });
    const whoop = report.connectors.find((each) => each.id === "whoop")!;
    expect(whoop.copies.map((copy) => [copy.id, copy.name])).toEqual([["whoop:10000001:cloud", "person-a@example.com"], ["whoop:10000002:cloud", "person-b@example.com"]]);
    expect(report.needs.find((need) => need.connector === "whoop")?.acts.map((act) => [act.do, "of" in act ? act.of : null])).toEqual([["read", "whoop:10000003:cloud"], ["ignore", "whoop:10000003:cloud"]]);
    artifact(root, "connectors-site-lanes", { accounts: one, copies: whoop.copies.map((copy) => [copy.id, copy.name]) });
  });

  it("holds a source by anything but its reader or its lane, miscounts a copy, its week or today, or says set up, a way, a health or a line its road and facts do not", () => {
    const root = makeRootOnce(roots);
    const days = effective(root).settings.day;
    const now = Date.now();
    const week = { starts: Array.from({ length: 7 }, (_, index) => dayBounds(addDays(civilDay(now, days), index - 6), days).start_ms) };
    const at = now - 60_000;
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => {
      for (const [id, connector, options] of [
        [WHATSAPP, "whatsapp-db"], [BACKUP, "whatsapp-db", { lane: "upload:local:macbook-air-bb07" }], [GMAIL, "gmail-imap"], ["claude:user-synthetic0001:browser", "claude-browser"],
        ["claude:user-synthetic0001:cloud", "claude-export"], [TAKEOUT, "google-my-activity", { lane: "upload:local:macbook-pro-0001" }], [SCREEN, "screen-recorder"], [LOCATION, "location-ios-bundle"],
        ["apple-notes:person-a@example.com:macbook-pro-0001", "notes-mac"],
      ] as const) tx.tables.sources.add({ id, vendor: vendorOf(declarations(), id), connector, ...(options === undefined ? {} : { options }), added_ms: 0 });
      delivered(tx, { id: `${WHATSAPP}/1`, source: WHATSAPP, sealed_ms: at, stated_ms: at, facts: { left: 120, start_ms: null } });
      tx.tables.deliveries.add({ id: `${BACKUP}/1`, source: BACKUP, sealed_ms: at, stated_ms: at, facts: { read_through: "2026-10-01T00:00:00Z" } });
      tx.tables.deliveries.add({ id: `${GMAIL}/1`, source: GMAIL, sealed_ms: at, stated_ms: at, facts: { read_through: "2026-10-01T00:00:00Z" } });
      tx.tables.deliveries.add({ id: `${TAKEOUT}/1`, source: TAKEOUT, sealed_ms: at - 2_000, stated_ms: at - 2_000, facts: {} });
      tx.tables.polls.put({ acquirer: "gmail-imap", next_ms: now + 300_000, paged_ms: null, page_next_ms: null, held_ms: null, pages: true });
      tx.tables.attempts.put({ ...fetched("gmail-imap", "fail", null, {}, now - 3_600_000, now, 4), source: GMAIL, contact_ms: at });
      tx.tables.attempts.put(fetched("claude-browser", "need", "signed-out", {}, at, now));
      tx.tables.devices.add({ unit: MAC, model: "MacBook Pro", added_ms: 0 });
      tx.tables.devices.add({ unit: "macbook-air-bb07", model: "MacBook Air", added_ms: 0 });
      tx.tables.devices.add({ unit: "chrome-0001", model: "Chrome", added_ms: 0 });
      tx.tables.devices.add({ unit: "arc-0001", model: "Arc", added_ms: 0 });
      tx.tally.prune(days, now);
      tx.tally.complete();
    });
    const object: Guard = (content) => (typeof content === "object" && content !== null ? [] : ["not an object"]);
    for (const [source, kind, rows] of [
      [GMAIL, "mailmsg", [[week.starts[0]!, 5], [week.starts[0]! - 1, 1], [week.starts[4]! + 3_600_000, 4], [week.starts[6]! - 1, 2]]],
      [SCREEN, "frame", [[week.starts[4]! + 60_000, 7]]],
      [WHATSAPP, "msg", [[at, 3], [at - 400 * 86_400_000, 1]]],
      [WHATSAPP, "chat", [[at, 1]]],
    ] as const) {
      db.commit((tx) => {
        const run = tx.tables.runs.start({ kind: "import", subject: `${source} ${kind}`, started_ms: 0 });
        tx.records.land(run, { id: `${source}/${kind}`, source, stated_ms: at }, rows.flatMap(([start_ms, count]) => Array.from({ length: count }, (_, index) => ({
          kind, key: `${kind}-${start_ms}-${index}`, content: { text: "synthetic" }, time: { start_ms, precision: "ms" as const },
        }))), { [kind]: object }, { has: () => true });
      });
    }
    db.close();
    const settings = effective(root).settings;
    const chosen = (...ids: string[]) => ({ ...settings, sites: { chosen: ids } });
    const stations = (...ids: string[]) => DECLARED.flatMap((each) => each.chrome === undefined ? [] : [{
      origin: each.chrome.origin, signed_in: each.id === "claude" ? false : null, chosen: ids.includes(each.id), checking: false, choosing: null,
      stations: [{ unit: "chrome-0001", chosen: ids.includes(each.id), signed_in: each.id === "claude" ? false : null, account: null }],
    }]);
    const disk = homeNeed("disk", "broken", "storage");
    const report = reportOf(root, {
      needs: [disk], sites: stations("claude", "chatgpt"), present: ["chrome-0001"],
      settings: { ...chosen("claude", "chatgpt"), connectors: { gmail: { account: "person-a@example.com", route: "gmail-imap", refresh: "30s" }, whatsapp: { start: DAY_90 }, screen: { ocr: "always" } } },
    });
    artifact(root, "connectors", report);
    const of = (id: string) => report.connectors.find((each) => each.id === id)!;
    const member = (id: string, key: string) => of(id).members.find((each) => each.key === key);

    expect(report.connectors.map((each) => each.id)).toEqual(["whatsapp", "gmail", "chatgpt", "claude", "google", "screen", "location", "faces", "spotify"]);
    expect(report.connectors.flatMap((each) => each.copies.map((copy) => copy.id)).sort()).toEqual([
      WHATSAPP, BACKUP, GMAIL, "claude:user-synthetic0001:browser", "claude:user-synthetic0001:cloud", TAKEOUT, SCREEN, LOCATION].sort());
    expect(of("google").copies.map((copy) => [copy.id, copy.name, copy.road])).toEqual([[TAKEOUT, "YouTube", "upload"]]);
    const copy = (id: string) => report.connectors.flatMap((each) => each.copies).find((each) => each.id === id)!;
    expect([BACKUP, WHATSAPP].map((id) => [copy(id).name, copy(id).road, copy(id).unit, copy(id).held, copy(id).newest_ms, copy(id).oldest_ms])).toEqual([
      ["MacBook Air", "upload", null, 0, null, null], ["MacBook Pro", "mac", MAC, 4, at, at - 400 * 86_400_000]]);
    expect(copy(WHATSAPP).line).toBe(`4${NB}messages · last ${when(at, now, days)}`);
    expect(of("whatsapp").export).toBeNull();

    expect(of("whatsapp")).toMatchObject({
      type: { key: "messages", name: "Messages and calls", icon: "message" }, icon: "message", name: "WhatsApp", product: "whatsapp", noun: ["message", "messages"], roads: ["mac", "upload"],
      records: whatsapp.records, gives: whatsapp.records, before: whatsapp.before,
    });
    expect(of("gmail")).toMatchObject({ type: { key: "mail", name: "Mail and calendar", icon: TYPES.mail.icon }, icon: TYPES.mail.icon, noun: ["email", "emails"], roads: ["poll", "upload"] });
    const kinds = imports.importKinds(DECLARED, []);
    const kindOf = (id: string) => kinds.find((kind) => kind.id === id)!;
    expect(of("google")).toMatchObject({ name: "Google activity", noun: null, gives: google.gives, type: { key: "web" },
      export: { import: "google-takeout", name: "Google Takeout", line: kindOf("google-takeout").takes } });
    expect(of("faces")).toMatchObject({ type: null, roads: ["label"] });
    expect([of("claude").export, of("spotify").export]).toEqual([
      { import: "claude", name: "Claude export", icon: kindOf("claude").icon, opens: false, line: "Claude sends a download you ask for" },
      { import: "spotify", name: "Spotify", icon: kindOf("spotify").icon, opens: false, line: "Spotify sends a download you ask for" }]);

    expect(Object.fromEntries(report.connectors.map((each) => [each.id, each.health.state]))).toEqual({
      whatsapp: "syncing", gmail: "broken", chatgpt: "ok", claude: "needs-you", google: "ok", screen: "ok", location: "setup", faces: "setup", spotify: "setup",
    });
    expect(of("gmail").health).toMatchObject({ reason: "failing", words: "Couldn’t read Gmail", acts: [{ do: "try", label: "Try now", need: "poll:gmail-imap" }] });
    expect(of("google").health).toMatchObject({ reason: null, acts: [] });
    const reportable = reportOf(root, {
      needs: [disk], sites: stations("claude", "chatgpt"), present: ["chrome-0001"], feedback: true,
      settings: { ...chosen("claude", "chatgpt"), connectors: { gmail: { account: "person-a@example.com", route: "gmail-imap", refresh: "30s" }, whatsapp: { start: DAY_90 }, screen: { ocr: "always" } } },
    });
    const reported = (each: { acts: readonly { do: string }[] }) => each.acts.filter((act) => act.do === "report");
    expect(reportable.connectors.find((each) => each.id === "gmail")!.health.acts, "a broken card, while feedback is open, offers Report a problem after its own acts")
      .toEqual([{ do: "try", label: "Try now", need: "poll:gmail-imap" }, { do: "report", label: "Report a problem", of: "gmail" }]);
    expect(Object.fromEntries(reportable.connectors.map((each) => [each.id, reported(each.health).length])), "no card that is not broken offers it")
      .toEqual({ whatsapp: 0, gmail: 1, chatgpt: 0, claude: 0, google: 0, screen: 0, location: 0, faces: 0, spotify: 0 });
    expect(reportable.connectors.flatMap((each) => each.copies.flatMap((each) => reported(each.health))), "no copy's line offers it").toEqual([]);
    expect(reportable.needs.flatMap(reported), "no Need offers it, the broken Gmail's included").toEqual([]);
    expect(reportable.needs.map((need) => need.id)).toEqual(report.needs.map((need) => need.id));
    expect(report.needs.map((need) => [need.id, need.state, need.connector, need.copy])).toEqual([
      ["disk", "broken", null, null], [`fetch:gmail-imap:${GMAIL}`, "broken", "gmail", GMAIL], ["fetch:claude-browser", "needs-you", "claude", null]]);
    expect(Object.fromEntries(report.connectors.map((each) => [each.id, [each.lead, each.line]]))).toMatchObject({
      whatsapp: ["Catching up", expect.stringMatching(/^back to /u)], gmail: [null, "Couldn’t read Gmail"], claude: [null, "Sign in to Claude in Chrome"],
    });
    const caughtUp = openHome(openHomeFolder(root), "migrate");
    caughtUp.commit((tx) => delivered(tx, { id: `${WHATSAPP}/2`, source: WHATSAPP, sealed_ms: at + 1, stated_ms: at + 1, facts: { left: 0, start_ms: null } }));
    caughtUp.close();
    expect(reportOf(root, { settings: { ...settings, connectors: {} } }).connectors.find((each) => each.id === "whatsapp")!.line).toBe(`3${NB}messages today`);
    for (const connector of report.connectors.filter((each) => each.figure !== null)) {
      expect(connector.figure!.week, connector.id).toHaveLength(7);
      expect(connector.figure!.today, connector.id).toBe(connector.figure!.week!.at(-1));
    }
    expect([of("gmail").figure!.week, of("screen").figure!.week, of("whatsapp").figure!.week]).toEqual([[5, 0, 0, 0, 4, 2, 0], [0, 0, 0, 0, 7, 0, 0], [0, 0, 0, 0, 0, 0, 3]]);
    expect([of("claude").figure?.today, of("location").figure]).toEqual([0, null]);
    const unmark = new Database(join(root, "home.db"));
    unmark.prepare("DELETE FROM meta WHERE key = ?").run(TALLY_MARK);
    unmark.close();
    const counting = reportOf(root).connectors.find((each) => each.id === "whatsapp")!;
    expect([counting.figure?.today, counting.figure?.week]).toEqual([null, null]);
    const marked = openHome(openHomeFolder(root), "migrate");
    marked.commit((tx) => tx.tally.complete());
    marked.close();

    expect(of("gmail").members.map((each) => [each.key, each.kind, each.label, each.value, each.words, each.from, each.panel])).toEqual([
      ["refresh", "duration", "Check every", "1m", "Every minute", "person", "settings"],
      ["account", "email", "Gmail address", "person-a@example.com", "person-a@example.com", "person", "account"],
      ["password", "secret", "App password", "gmail.password", "", "declaration", "account"],
      ["folders", "list", "Folders", [], "All Mail", "declaration", "settings"],
      ["start", "start", "Starts from", null, "All time", "unset", "backfill"],
      ["pace", "duration", "Catch up every", "1m", "Every minute", "declaration", "backfill"],
      ["llm.mail", "choice", "Email summaries", "default", "fake-model", "declaration", null],
      ["llm.range", "choice", "Read back to", null, "1 Jan 1970", "unset", null],
      ["privacy.mail", "choice", "Email summaries: personal details", "default", "Personal details hidden", "declaration", null],
    ]);
    expect(member("gmail", "refresh")!.steps!.map((step) => step.value)).toEqual(["1m", "2m", "5m", "10m", "15m", "30m", "1h", "6h", "12h", "1d"]);
    expect([member("gmail", "password"), member("gmail", "folders")]).toMatchObject([{ secret: "gmail.password", steps: null }, { add: "Add a folder", steps: null }]);
    expect([member("gmail", "refresh")!.about, member("gmail", "start")!.about, member("gmail", "pace")!.about, member("gmail", "folders")!.about])
      .toEqual([null, null, null, null]);
    expect(member("screen", "refresh")).toMatchObject({ label: "Capture interval", about: null });
    expect([holdsWords(["INBOX"], false), holdsWords(["a", "b", "c"], false), holdsWords([], false, "All Mail"), holdsWords(Array.from({ length: 1200 }, String), false)])
      .toEqual(["1", "3", "All Mail", "1,200"]);
    expect([member("screen", "ocr")!.steps, member("screen", "apps")]).toMatchObject([
      [{ value: "always", words: "Every frame", note: "Reads every frame in full" }, { value: "exact", words: "Skip unchanged frames", note: null }], { items: "modes", add: "Add to Apps and sites" }]);
    expect(member("location", "precision")).toMatchObject({ about: location.fields.precision.about, words: "Precise" });
    expect(member("faces", "battery_backlog")).toMatchObject({ kind: "number", words: "500", min: 0, panel: "settings" });
    expect([of("gmail").account?.name, of("gmail").account?.copy, of("claude").account]).toEqual(["person-a@example.com", GMAIL, null]);
    for (const connector of report.connectors.filter((each) => each.set_up && each.members.some((member) => member.panel === "account"))) {
      expect(connector.account, connector.id).not.toBeNull();
    }
    expect(of("gmail").account?.line).toMatch(new RegExp(`^Account · \\d+${NB}emails?$`, "u"));
    const other = reportOf(root, { settings: { ...settings, connectors: { gmail: { account: "person-b@example.com", route: "gmail-imap" } } } });
    expect(other.connectors.find((each) => each.id === "gmail")!.account).toEqual({ name: "person-b@example.com", line: "Account", copy: null });
    const typed = reportOf(root, { settings: { ...settings, connectors: { gmail: { account: "person-c@example.com" } } } }).connectors.find((each) => each.id === "gmail")!;
    expect([typed.account?.name]).toEqual(["person-c@example.com"]);
    expect(member("gmail", "password")!.held).toBe(false);
    mkdirSync(join(root, "config", "secrets"), { recursive: true });
    writeFileSync(join(root, "config", "secrets", "gmail.password"), "synthetic-pass", { mode: 0o600 });
    const kept = reportOf(root, { settings: { ...settings, connectors: { gmail: { account: "person-a@example.com", route: "gmail-imap" } } } });
    expect(kept.connectors.find((each) => each.id === "gmail")!.members.find((each) => each.key === "password")!.held).toBe(true);
    rmSync(join(root, "config", "secrets", "gmail.password"));

    const way = (id: string, road: string) => of(id).ways.find((each) => each.road === road)!;
    expect(way("gmail", "poll").ready).toBe(true);
    expect(way("claude", "chrome").requirements.map((each) => [each.kind, each.met])).toEqual(expect.arrayContaining([["choose", true]]));
    expect(way("location", "phone").ready).toBe(false);
    expect(Object.fromEntries(report.connectors.map((each) => [each.id, each.set_up]))).toEqual({
      whatsapp: true, gmail: true, chatgpt: true, claude: true, google: true, screen: true, location: false, faces: false, spotify: false,
    });
    expect([of("claude").browser, of("claude").signed_in, of("gmail").browser, of("gmail").signed_in]).toEqual([{ unit: "chrome-0001", name: "Chrome" }, false, null, null]);
    expect(["claude", "chatgpt", "google", "gmail"].map((id) => of(id).chosen)).toEqual([true, true, null, null]);
    const none = reportOf(root, { sites: stations(), present: ["chrome-0001"] });
    expect(["claude", "chatgpt"].map((id) => none.connectors.find((each) => each.id === id)!.chosen)).toEqual([false, false]);

    const write = openHome(openHomeFolder(root), "migrate");
    write.commit((tx) => {
      tx.tables.controls.set({ target: "pause:chatgpt", reason: "a test", at_ms: 1, by: "you" });
      tx.tables.controls.set({ target: "pause:chatgpt:history", reason: "a test", at_ms: 2, by: "terminal" });
      tx.tables.controls.set({ target: "pause:whatsapp:history", reason: "a test", at_ms: 1, by: "terminal" });
    });
    const paused = reportOf(root, { sites: stations("chatgpt"), settings: chosen("chatgpt") });
    const pausedOf = (id: string) => paused.connectors.find((each) => each.id === id)!;
    expect([pausedOf("chatgpt").health.state, pausedOf("chatgpt").pauses]).toEqual(["paused", [{ scope: "all", by: "you", reason: "a test", at_ms: 1 }, { scope: "history", by: "terminal", reason: "a test", at_ms: 2 }]]);
    expect([pausedOf("whatsapp").health.state, pausedOf("whatsapp").pauses]).toEqual(["ok", [{ scope: "history", by: "terminal", reason: "a test", at_ms: 1 }]]);
    expect(paused.paused.map((pause) => [pause.target, pause.by, pause.title])).toEqual([
      ["pause:chatgpt", "you", "Paused: ChatGPT"], ["pause:chatgpt:history", "terminal", "Paused: ChatGPT’s history"], ["pause:whatsapp:history", "terminal", "Paused: WhatsApp’s history"]]);
    write.commit((tx) => {
      tx.tables.controls.clear("pause:chatgpt");
      tx.tables.controls.clear("pause:chatgpt:history");
      tx.tables.controls.clear("pause:whatsapp:history");
      tx.tables.controls.set({ target: "home", reason: "away for the weekend", at_ms: 1, by: "you" });
    });
    expect((({ name, health }) => ({ name, health }))(reportOf(root).home)).toEqual({ name: "Lifestream", health: { state: "paused", reason: null, words: "Away for the weekend", since_ms: 1, next_ms: null, acts: [], detail: null } });
    write.commit((tx) => tx.tables.controls.clear("home"));
    write.commit((tx) => {
      const runners = [{ unit: "runner-macbook-pro-0001", name: "MacBook Pro", present: false, power: null, memory_gb: 16, files: [], below: null }];
      tx.tables.meta.set(MODELS_META, JSON.stringify({ routes: [], runners, openrouter: { connected: false } } satisfies StoredModels));
      tx.tables.controls.set({ target: "runner:runner-macbook-pro-0001", reason: "", at_ms: 1, by: "you" });
      tx.tables.controls.set({ target: "runner:runner-mac-mini-bb17", reason: "the mini is busy", at_ms: 1, by: "terminal" });
    });
    expect(reportOf(root).paused.map((pause) => [pause.target, pause.title])).toEqual([
      ["runner:runner-mac-mini-bb17", "Paused: model calls on runner-mac-mini-bb17"], ["runner:runner-macbook-pro-0001", "Paused: model calls on MacBook Pro"]]);
    write.commit((tx) => {
      tx.tables.controls.clear("runner:runner-macbook-pro-0001");
      tx.tables.controls.clear("runner:runner-mac-mini-bb17");
      tx.tables.meta.delete(MODELS_META);
    });
    write.close();

    const off = reportOf(root, { settings: { ...settings, sources: { off: ["whatsapp", MAC] }, connectors: {} } });
    expect(off.connectors.flatMap((each) => each.copies.filter((one) => !one.on).map((one) => one.id)).sort()).toEqual([BACKUP, SCREEN, WHATSAPP].sort());
    expect(off.connectors.filter((each) => !each.on).map((each) => each.id)).toEqual(["whatsapp", "screen"]);
    expect(off.off).toEqual(["whatsapp", MAC]);
    expect(off.connectors.find((each) => each.id === "whatsapp")!.health).toMatchObject({ state: "off", acts: [{ do: "turn", label: "Connect", ids: ["whatsapp", BACKUP, WHATSAPP] }] });

    expect(report.devices.map((device) => [device.unit, device.kind, device.name])).toEqual([["macbook-air-bb07", "mac", "MacBook Air"], [MAC, "mac", "MacBook Pro"]]);
    expect(report.devices.map((device) => device.found)).toEqual([null, null]);
    const stated = reportOf(root, { stated: { [MAC]: { ...word({ grants: null, settings: null }), found: ["imessage", "screen"] } } });
    expect(stated.devices.map((device) => [device.unit, device.found])).toEqual([["macbook-air-bb07", null], [MAC, ["imessage", "screen"]]]);
    expect(report.extension.present).toBe(true);
    expect(reportOf(root, { present: ["chrome-0001", "arc-0001"] }).extension).toMatchObject({ name: "Chrome extension", health: { words: "Running in Arc and Chrome" } });
    mintPrincipal(openHomeFolder(root), { unit: PHONE, kind: "phone", scopes: ["deliver", "read"], sources: [LOCATION], now_ms: 0 });
    const paired = openHome(openHomeFolder(root), "migrate");
    paired.commit((tx) => tx.tables.devices.add({ unit: PHONE, model: "iPhone 17 Pro", added_ms: 0 }));
    paired.close();
    const phoned = reportOf(root);
    expect(phoned.devices.find((device) => device.unit === PHONE)).toMatchObject({ kind: "phone", name: "iPhone 17 Pro", retired: false, health: { state: "ok" } });
    artifact(root, "connectors-phoned", phoned);
  });

  it("says a history otherwise than its speaking copies, mixes a count into what is left, estimates from what it should not, says done before the last page lands, a photo library's otherwise than the home's wanted list, or says what is arriving with an estimate in it, or nothing while it syncs", () => {
    const root = makeRootOnce(roots);
    const settings = { ...effective(root).settings, sites: { chosen: ["chatgpt"] } };
    const days = settings.day;
    const now = Date.now();
    const MINUTE = 60_000;
    const CHAT = "chatgpt:person-a@example.com:browser";
    const OTHER = "chatgpt:person-b@example.com:browser";
    const EXPORT = "chatgpt:person-a@example.com:cloud";
    const OLDEST = Date.UTC(2022, 11, 11, 12);
    const object: Guard = (content) => (typeof content === "object" && content !== null ? [] : ["not an object"]);
    const write = (change: (tx: Parameters<Parameters<ReturnType<typeof openHome>["commit"]>[0]>[0]) => void) => {
      const db = openHome(openHomeFolder(root), "migrate");
      try {
        db.commit(change);
      } finally {
        db.close();
      }
    };
    const page = (source: string, n: number, left: number, at_ms: number, start_ms: number | null = null) => write((tx) => {
      tx.tables.deliveries.add({ id: `${source}/page-${n}`, source, sealed_ms: at_ms, stated_ms: at_ms, facts: { history: true, left, start_ms } });
      tx.tables.backfills.paged({ source, acquirer: "chatgpt-browser", left, unit: ["conversation", "conversations"], start_ms, at_ms, delivery: `${source}/page-${n}` });
    });
    write((tx) => {
      for (const [id, connector] of [[CHAT, "chatgpt-browser"], [OTHER, "chatgpt-browser"], [EXPORT, "chatgpt-export"], [WHATSAPP, "whatsapp-db"]] as const) tx.tables.sources.add({ id, vendor: vendorOf(declarations(), id), connector, added_ms: 0 });
      tx.tables.devices.add({ unit: MAC, model: "MacBook Pro", added_ms: 0 });
      tx.tables.polls.put({ acquirer: "chatgpt-browser", next_ms: now + 10 * MINUTE, paged_ms: now - MINUTE, page_next_ms: null, held_ms: null, pages: true });
      tx.tally.prune(days, now);
      tx.tally.complete();
      for (const [source, start_ms] of [[CHAT, OLDEST], [CHAT, now - 86_400_000], [WHATSAPP, Date.UTC(2019, 2, 1, 12)]] as const) {
        const run = tx.tables.runs.start({ kind: "import", subject: `${source} heads`, started_ms: 0 });
        tx.records.land(run, { id: `${source}/heads-${start_ms}`, source, stated_ms: now }, [{ kind: "msg", key: `msg-${start_ms}`, content: { text: "synthetic" }, time: { start_ms, precision: "ms" } }], { msg: object }, { has: () => true });
      }
    });
    page(CHAT, 1, 1_799, now - 11 * MINUTE);
    page(CHAT, 2, 1_750, now - MINUTE);
    const sites = DECLARED.flatMap((each) => each.chrome === undefined ? [] : [{
      origin: each.chrome.origin, signed_in: null, chosen: each.id === "chatgpt", checking: false, choosing: null,
      stations: [{ unit: "chrome-0001", chosen: each.id === "chatgpt", signed_in: null, account: null }],
    }]);
    const chatgpt = (more: Partial<ConnectorsInput> = {}) => reportOf(root, { sites, settings, now_ms: now, stated: {}, ...more }).connectors.find((each) => each.id === "chatgpt")!;
    const history = (more: Partial<ConnectorsInput> = {}) => chatgpt(more).history;
    const said: Record<string, unknown> = {};
    const back = "Back to Dec 2022";
    const left = `1,750${NB}conversations left`;
    const about = `about${NB}6${NB}h`;

    said.running = chatgpt();
    expect(history()).toMatchObject({ state: "syncing", back_to_ms: OLDEST, left: 1_750, unit: ["conversation", "conversations"], words: `${back} · ${left} · ${about}`, arriving: `${back} · ${left}` });
    expect(history()!.eta_ms).toBeGreaterThan(now);
    expect(history({ now_ms: now + 10 * MINUTE })).toMatchObject({ left: 1_750, eta_ms: null, words: `${back} · ${left}`, arriving: `${back} · ${left}` });

    page(CHAT, 3, 0, now);
    expect(history()).toMatchObject({ state: "syncing", left: 0, arriving: `${back} · 0${NB}conversations left` });
    write((tx) => tx.tables.deliveries.move(`${CHAT}/page-3`, CHAT, { move: "pass" }));
    said.done = history();
    expect(history()).toEqual({ state: "done", back_to_ms: OLDEST, left: null, unit: null, eta_ms: null, done: null, total: null, progress: null, words: back, arriving: back, start: { day: null, own: false } });
    expect(history({ settings: { ...settings, connectors: { chatgpt: { start: DAY_90 } } } })).toMatchObject({ state: "syncing", left: null, arriving: back, start: { day: DAY_90, own: true } });
    page(OTHER, 1, 5, now);
    expect(history()).toMatchObject({ state: "syncing", left: 5, eta_ms: null, words: `${back} · 5${NB}conversations left`, arriving: `${back} · 5${NB}conversations left` });

    write((tx) => delivered(tx, { id: `${WHATSAPP}/1`, source: WHATSAPP, sealed_ms: now - 2 * MINUTE, stated_ms: now - 2 * MINUTE, facts: { left: 3_000, start_ms: null } }));
    const whatsapp = () => reportOf(root, { settings, now_ms: now }).connectors.find((each) => each.id === "whatsapp")!.history;
    expect(whatsapp()).toMatchObject({ state: "syncing", back_to_ms: Date.UTC(2019, 2, 1, 12), left: null, arriving: "Back to Mar 2019" });
    write((tx) => delivered(tx, { id: `${WHATSAPP}/2`, source: WHATSAPP, sealed_ms: now - MINUTE, stated_ms: now - MINUTE, facts: { left: 0, start_ms: null } }));
    said.device = whatsapp();
    expect(whatsapp()).toMatchObject({ state: "done", left: null });

    const LIBRARY = `apple-photos:person-a@example.com:${MAC}`;
    write((tx) => {
      tx.tables.sources.add({ id: LIBRARY, vendor: vendorOf(declarations(), LIBRARY), connector: "photos-mac-bundle", added_ms: 0 });
      tx.tables.deliveries.add({ id: `${LIBRARY}/1`, source: LIBRARY, sealed_ms: now - MINUTE, stated_ms: now - MINUTE, facts: { entries: 1 } });
      const run = tx.tables.runs.start({ kind: "import", subject: `${LIBRARY} one`, started_ms: 0 });
      tx.records.land(run, { id: `${LIBRARY}/1`, source: LIBRARY, stated_ms: now }, [{ kind: "img", key: "img-1", content: { name: "IMG_0001.HEIC" }, time: { start_ms: Date.UTC(2017, 2, 1, 12), precision: "ms" } }], { img: object }, { has: () => true });
      tx.tables.runs.end(run, { ended_ms: now - MINUTE, outcome: "ok", counts: { new: 1 } });
    });
    const raw = new Database(join(root, "home.db"));
    const insert = raw.prepare("INSERT INTO extracts (family, unit, reading, code, content, start_ms, end_ms, days, items, seq) VALUES ('photos', ?, '', '', ?, NULL, NULL, '[]', '[]', ?)");
    for (let n = 0; n < 3; n++) {
      const content = { at_ms: Date.UTC(2017, 2, 1 + n, 12), missing: [{ type: "photo", name: null, size: 1_000 }], routes: [{ source: LIBRARY, asset: `asset-${n}`, files: ["photo"], refused: false }] };
      insert.run(`wanted/${LIBRARY}/asset-${n}`, JSON.stringify(content), n + 1);
    }
    raw.prepare("INSERT INTO wanted_blobs (blob, source, kind, key) VALUES (?, ?, 'img-file', ?)").run(`sha256:${"9".repeat(64)}`, LIBRARY, "file-9");
    raw.close();
    const library = declarations().find((each) => each.id === "apple-photos")!;
    const photos = (start = "all") => reportOf(root, { settings: { ...settings, history: { start } }, now_ms: now, connectors: [...DECLARED, library] }).connectors.find((each) => each.id === "apple-photos")!.history;
    said.photos = photos();
    expect(photos()).toMatchObject({ state: "syncing", back_to_ms: Date.UTC(2017, 2, 1, 12), left: 3, unit: ["file", "files"], arriving: `Back to Mar 2017 · 3${NB}files left` });
    expect(photos("2017-03-02")).toMatchObject({ state: "syncing", left: 2, arriving: `Back to Mar 2017 · 2${NB}files left` });
    said.photosUnderStart = photos("2017-03-04");
    expect(photos("2017-03-04")).toBeNull();
    const dropped = new Database(join(root, "home.db"));
    dropped.prepare("DELETE FROM extracts WHERE family = 'photos' AND unit LIKE ?").run(`wanted/${LIBRARY}/%`);
    dropped.close();
    expect(photos()).toBeNull();
    artifact(root, "connectors-history", said);
  });

  it("says a page a metered network holds otherwise than Waiting for Wi-Fi, a history a low disk holds otherwise than Waiting for space, or the Screen row Recording for a recorder that is not", () => {
    const root = makeRootOnce(roots);
    const settings = { ...effective(root).settings, sites: { chosen: ["chatgpt"] } };
    const now = Date.now();
    const CHAT = "chatgpt:person-a@example.com:browser";
    const object: Guard = (content) => (typeof content === "object" && content !== null ? [] : ["not an object"]);
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => {
      for (const [id, connector] of [[CHAT, "chatgpt-browser"], [SCREEN, "screen-recorder"], [WHATSAPP, "whatsapp-db"]] as const) tx.tables.sources.add({ id, vendor: vendorOf(declarations(), id), connector, added_ms: 0 });
      tx.tables.devices.add({ unit: MAC, model: "MacBook Pro", added_ms: 0 });
      tx.tables.polls.put({ acquirer: "chatgpt-browser", next_ms: now + 600_000, paged_ms: now - 60_000, page_next_ms: null, held_ms: null, pages: true });
      tx.tables.deliveries.add({ id: `${CHAT}/page-1`, source: CHAT, sealed_ms: now - 60_000, stated_ms: now - 60_000, facts: { history: true, left: 40, start_ms: null } });
      tx.tables.backfills.paged({ source: CHAT, acquirer: "chatgpt-browser", left: 40, unit: ["conversation", "conversations"], start_ms: null, at_ms: now - 60_000, delivery: `${CHAT}/page-1` });
      delivered(tx, { id: `${WHATSAPP}/1`, source: WHATSAPP, sealed_ms: now - 60_000, stated_ms: now - 60_000, facts: { left: 300, start_ms: null } });
      tx.tally.prune(settings.day, now);
      tx.tally.complete();
      const run = tx.tables.runs.start({ kind: "import", subject: `${SCREEN} frames`, started_ms: 0 });
      tx.records.land(run, { id: `${SCREEN}/frames`, source: SCREEN, stated_ms: now }, [0, 1, 2].map((n) => ({
        kind: "frame", key: `frame-${n}`, content: { text: "synthetic" }, time: { start_ms: now - 1_000 - n, precision: "ms" as const },
      })), { frame: object }, { has: () => true });
    });
    db.close();
    const sites = DECLARED.flatMap((each) => each.chrome === undefined ? [] : [{
      origin: each.chrome.origin, signed_in: null, chosen: each.id === "chatgpt", checking: false, choosing: null,
      stations: [{ unit: "chrome-0001", chosen: each.id === "chatgpt", signed_in: null, account: null }],
    }]);
    const mac = ({ recorder, ...more }: Partial<Omit<Statement, "recorder">> & { recorder?: Recorder | null }): Stated => ({
      [MAC]: { ...word({ grants: { screenRecording: "on" }, settings: null }), heard_ms: now, ...more, ...(recorder === undefined ? {} : { recorder: recorder === null ? null : { value: recorder, since_ms: now } }) },
    });
    const report = (stated: Stated) => reportOf(root, { sites, settings, now_ms: now, stated });
    const row = (got: StreamsReport, id: string) => got.connectors.find((each) => each.id === id)!;
    const frames = `3${NB}frames today`;

    const held = report(mac({ network: { value: "metered", since_ms: now - 60_000 }, recorder: { state: "interrupted", cause: "disk" } }));
    expect([row(held, "chatgpt").health.state, row(held, "chatgpt").health.reason, row(held, "chatgpt").health.words]).toEqual(["waiting", "metered", "Waiting for Wi-Fi"]);
    expect(row(held, "chatgpt").copies.map((copy) => copy.health.words)).toEqual(["Waiting for Wi-Fi"]);
    expect(row(held, "whatsapp").health.reason).not.toBe("metered");
    expect(row(held, "screen").line).toBe(`Not recording · ${frames}`);
    const causes = (["permission", "browser", "capture", "away", "private"] as const).map((cause) => row(report(mac({ recorder: { state: "interrupted", cause } })), "screen").line);
    expect(causes).toEqual([
      `Screen Recording needs access · ${frames}`, `Not recording · browser not answering · ${frames}`,
      `Not recording · screen unavailable · ${frames}`, `Not recording · Mac idle · ${frames}`,
      `Not recording · private window or app · ${frames}`,
    ]);
    const states = (["starting", "paused"] as const).map((state) => row(report(mac({ recorder: { state } })), "screen").line);
    expect(states).toEqual([`Starting recording · ${frames}`, `Recording paused · ${frames}`]);
    const silent = row(report(mac({ recorder: null })), "screen").line;
    expect(silent).toBe(frames);
    const heard = row(report(mac({ recorder: { state: "recording" }, heard_ms: now - 2 * 60_000 })), "screen").line;
    const asleep = row(report(mac({ recorder: { state: "recording" }, heard_ms: now - 4 * 60_000 })), "screen").line;
    expect([heard, asleep]).toEqual([frames, frames]);
    mintPrincipal(openHomeFolder(root), { unit: MAC, kind: "mac", scopes: ["deliver"], sources: [SCREEN], now_ms: 0 });
    const revoked = report(mac({ grants: { screenRecording: "off" }, recorder: { state: "interrupted", cause: "permission" } }));
    const need = revoked.needs.find((each) => each.id === `grant:screenRecording:${MAC}`);
    expect([row(revoked, "screen").health.state, row(revoked, "screen").line, need?.words, need?.acts.map((act) => act.label)])
      .toEqual(["needs-you", "Allow Screen Recording", "Allow Screen Recording", ["Allow"]]);
    const off = row(reportOf(root, { sites, settings: { ...settings, sources: { off: ["screen"] } }, now_ms: now, stated: mac({ recorder: { state: "paused" } }) }), "screen").line;
    expect(off).toBe("Disconnected");

    const free = report(mac({ network: { value: "free", since_ms: now }, recorder: { state: "recording" } }));
    expect(row(free, "chatgpt").health.reason).not.toBe("metered");
    expect(row(free, "screen").line).toBe(frames);

    const low = reportOf(root, { sites, settings, now_ms: now, stated: mac({ recorder: { state: "recording" } }), free_bytes: 4e9 });
    const waits = ["chatgpt", "whatsapp"].map((id) => [row(low, id).health.state, row(low, id).health.reason, row(low, id).health.words, row(low, id).line, row(low, id).history?.eta_ms ?? null]);
    expect(waits).toEqual(["chatgpt", "whatsapp"].map(() => ["waiting", "disk", "Waiting for disk space on your Mac", "Waiting for disk space on your Mac", null]));
    expect(row(low, "screen").line).toBe(frames);
    const AIR = "macbook-air-bb07";
    const second = openHome(openHomeFolder(root), "migrate");
    second.commit((tx) => {
      tx.tables.sources.add({ id: `screen:local:${AIR}`, vendor: vendorOf(declarations(), `screen:local:${AIR}`), connector: "screen-recorder", added_ms: 0 });
      tx.tables.devices.add({ unit: AIR, model: "MacBook Air", added_ms: 0 });
    });
    second.close();
    const air = (recorder: Recorder, heard_ms: number): Stated => ({ [AIR]: { ...word({ grants: { screenRecording: "on" }, settings: null }), recorder: { value: recorder, since_ms: heard_ms }, heard_ms } });
    const twoMacs = [
      { ...mac({ recorder: { state: "recording" }, heard_ms: now - 30_000 }), ...air({ state: "paused" }, now - 10_000) },
      { ...mac({ recorder: { state: "interrupted", cause: "disk" }, heard_ms: now - 10_000 }), ...air({ state: "recording" }, now - 30_000) },
      { ...mac({ recorder: { state: "recording" }, heard_ms: now - 30_000 }), ...air({ state: "paused" }, now - 4 * 60_000) },
    ].map((stated) => row(report(stated), "screen").line);
    expect(twoMacs).toEqual([`Recording paused · ${frames}`, `Not recording · ${frames}`, frames]);
    artifact(root, "connectors-limits", {
      held: [row(held, "chatgpt").health, row(held, "screen").line], free: [row(free, "chatgpt").health, row(free, "screen").line], low: waits,
      screen: { causes, states, silent, heard, asleep, revoked: row(revoked, "screen").line, twoMacs, off },
    });
  });

  it("carries each Mac copy's store state and asks the person to allow a store, and each site's origins", () => {
    const root = makeRootOnce(roots);
    const settings = effective(root).settings;
    const stored = { ...whatsapp, mac: { ...whatsapp.mac, store: declarations().find((each) => each.id === "whatsapp")!.mac!.store! } } satisfies Connector;
    const registry: { connectors: readonly Connector[] } = { connectors: [stored, ...DECLARED.filter((each) => each.id !== "whatsapp")] };
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => {
      for (const [id, connector] of [[WHATSAPP, "whatsapp-db"], [SCREEN, "screen-recorder"]] as const) tx.tables.sources.add({ id, vendor: vendorOf(declarations(), id), connector, added_ms: 0 });
      tx.tables.devices.add({ unit: MAC, model: "MacBook Pro", added_ms: 0 });
    });
    db.close();
    mintPrincipal(openHomeFolder(root), { unit: MAC, kind: "mac", scopes: ["deliver"], sources: [WHATSAPP, SCREEN], now_ms: 0 });
    const stated = (states: Record<string, "asked" | "allowed" | "refused" | "unsafe">, found: string[] | null): Stated => ({
      [MAC]: { ...word({ grants: { fullDiskAccess: "on" }, settings: null }), heard_ms: Date.now(), stores: { digest: null, states }, found },
    });
    const report = (states: Record<string, "asked" | "allowed" | "refused" | "unsafe">, off: string[] = [], found: string[] | null = null) =>
      reportOf(root, { connectors: registry.connectors, settings: { ...settings, sources: { off } }, stated: stated(states, found) });
    const storeOf = (got: StreamsReport, id: string) => got.connectors.find((each) => each.id === id)!.copies.map((copy) => [copy.id, copy.store]);

    const asked = report({ whatsapp: "asked", screen: "asked" });
    expect([storeOf(asked, "whatsapp"), storeOf(asked, "screen")]).toEqual([[[WHATSAPP, "asked"]], [[SCREEN, null]]]);
    expect(asked.needs.filter((need) => need.id.startsWith("grant:store:")).map((need) => [need.id, need.words, need.unit, need.acts])).toEqual([
      [`grant:store:whatsapp:${MAC}`, "Allow WhatsApp on MacBook Pro", MAC, [{ do: "grant", label: "Allow", unit: MAC, grant: "store:whatsapp" }]],
    ]);
    const allowed = report({ whatsapp: "allowed" });
    expect([storeOf(allowed, "whatsapp"), allowed.needs.filter((need) => need.id.startsWith("grant:store:"))]).toEqual([[[WHATSAPP, "allowed"]], []]);
    expect(report({ whatsapp: "asked" }, [MAC]).needs.filter((need) => need.id.startsWith("grant:store:"))).toEqual([]);
    const whatsappNeeds = (got: StreamsReport) => got.needs.filter((need) => need.connector === "whatsapp").map((need) => [need.words, need.acts]);
    expect(whatsappNeeds(report({ whatsapp: "asked" }, [], ["screen"]))).toEqual([["Allow WhatsApp on MacBook Pro", [{ do: "grant", label: "Allow", unit: MAC, grant: "store:whatsapp" }]]]);
    expect(whatsappNeeds(report({ whatsapp: "unsafe" }, [], ["screen"]))).toEqual([["MacBook Pro can’t read WhatsApp", []]]);
    expect(whatsappNeeds(report({ whatsapp: "allowed" }, [], ["whatsapp", "screen"]))).toEqual([]);

    expect(asked.connectors.map((each) => [each.id, each.origins])).toEqual(asked.connectors.map((each) => {
      const site = chromeSites(registry.connectors).find((one) => one.origin === registry.connectors.find((declared) => declared.id === each.id)!.chrome?.origin);
      return [each.id, site === undefined ? null : siteOrigins(site)];
    }));
    expect(asked.connectors.find((each) => each.id === "chatgpt")!.origins).toEqual(["https://chatgpt.com"]);
  });

  it("says a store's stream on its own row: not looked for until the Mac holds the store, then its Allow, never Install", () => {
    const root = makeRootOnce(roots);
    const settings = effective(root).settings;
    const stored = { ...whatsapp, mac: { ...whatsapp.mac, store: declarations().find((each) => each.id === "whatsapp")!.mac!.store! } } satisfies Connector;
    const registry: { connectors: readonly Connector[] } = { connectors: [stored, ...DECLARED.filter((each) => each.id !== "whatsapp")] };
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => {
      tx.tables.sources.add({ id: SCREEN, vendor: vendorOf(declarations(), SCREEN), connector: "screen-recorder", added_ms: 0 });
      tx.tables.devices.add({ unit: MAC, model: "MacBook Pro", added_ms: 0 });
    });
    db.close();
    const said = (states: Record<string, "asked" | "allowed" | "refused" | "unsafe">, found: string[] | null): Stated => ({
      [MAC]: { ...word({ grants: { fullDiskAccess: "on" }, settings: null }), heard_ms: Date.now(), stores: { digest: null, states }, found },
    });
    const row = (stated: Stated | undefined) => {
      const got = reportOf(root, { connectors: registry.connectors, settings, ...stated === undefined ? {} : { stated } });
      const connector = got.connectors.find((each) => each.id === "whatsapp")!;
      return {
        row: [connector.set_up, connector.health.state, connector.health.words, connector.health.acts],
        way: connector.ways.find((way) => way.road === "mac")!.requirements[0],
        needs: got.needs.filter((need) => need.connector === "whatsapp" || need.streams?.includes("whatsapp")).map((need) => [need.id, need.words]),
      };
    };
    expect(row(undefined).row).toEqual([false, "setup", "Install WhatsApp on your Mac", []]);
    mintPrincipal(openHomeFolder(root), { unit: MAC, kind: "mac", scopes: ["deliver"], sources: [SCREEN], now_ms: 0 });
    for (const stated of [undefined, {}, said({}, ["screen"])]) {
      expect(row(stated).row).toEqual([false, "setup", "Checking MacBook Pro…", []]);
    }
    const allow = { do: "grant", label: "Allow", unit: MAC, grant: "store:whatsapp" };
    for (const state of ["asked", "refused"] as const) {
      const asked = row(said({ whatsapp: state }, ["whatsapp", "screen"]));
      expect(asked.row).toEqual([false, "setup", "Allow WhatsApp on MacBook Pro", [allow]]);
      expect(asked.way).toEqual({ kind: "grant", met: false, words: "Allow WhatsApp on MacBook Pro", line: "macOS asks before Lifestream reads another app’s data.", act: allow });
      expect(asked.needs).toEqual([[`grant:store:whatsapp:${MAC}`, "Allow WhatsApp on MacBook Pro"]]);
    }
    const unsafe = row(said({ whatsapp: "unsafe" }, ["whatsapp", "screen"]));
    expect([unsafe.row, unsafe.way?.act]).toEqual([[false, "setup", "MacBook Pro can’t read WhatsApp", []], null]);
    expect(row(said({ whatsapp: "allowed" }, ["screen"])).row).toEqual([false, "setup", "Install WhatsApp on MacBook Pro", []]);
    expect(row(said({ whatsapp: "allowed" }, ["whatsapp", "screen"])).way).toEqual({ kind: "app", met: true, words: "WhatsApp is on MacBook Pro", line: null, act: null });
    const db2 = openHome(openHomeFolder(root), "migrate");
    db2.commit((tx) => tx.tables.sources.add({ id: WHATSAPP, vendor: vendorOf(declarations(), WHATSAPP), connector: "whatsapp-db", added_ms: 0 }));
    db2.close();
    for (const state of ["asked", "refused"] as const) {
      expect(row(said({ whatsapp: state }, ["whatsapp", "screen"])).way, state).toEqual({ kind: "grant", met: false, words: "Allow WhatsApp on MacBook Pro", line: "macOS asks before Lifestream reads another app’s data.", act: allow });
    }
    expect(row(said({ whatsapp: "unsafe" }, ["whatsapp", "screen"])).way).toEqual({ kind: "grant", met: false, words: "MacBook Pro can’t read WhatsApp", line: null, act: null });
    expect(row(said({}, ["screen"])).way).toMatchObject({ kind: "app", met: true });
  });

  it("names a source by its id, by a part its connector's sources share, by its device (a poll on its own Mac's too), or two sources alike", () => {
    const OLD = "iphone-x-0001";
    const declared: Connector[] = [
      { id: "imessage", product: "imessage", name: "iMessage", vendor: "apple", type: "messages", records: "Every message, chat and attachment.", sources: [{ id: "imessage:<account>:<unit>", read: "imessage-db", arrives: "mac" }], mac: { app: "Messages", grants: ["fullDiskAccess"] } },
      { id: "location", product: "location", name: "Location", vendor: "lifestream", type: "places", records: "Where the phone was.", sources: [{ id: "location:local:<unit>", read: "location-ios-bundle", arrives: "phone" }], phone: { grants: ["location"] } },
      { id: "health", product: "apple-health", name: "Health", vendor: "apple", type: "health", records: "Every sample Health holds.", sources: [{ id: "apple-health:<account>:cloud", read: "health-ios-bundle", arrives: "phone" }], phone: { grants: ["health"] } },
      chatgpt, google,
      declarations().find((each) => each.id === "chrome")!,
      gmail,
      { id: "screen", product: "screen", name: "Screen", vendor: "lifestream", type: "device-activity", records: "What was on the screen.", sources: [{ id: "screen:local:<unit>", read: "screen-capture", arrives: "mac" }], mac: { grants: ["screenRecording"], sensor: true } },
      { id: "voice-notes", product: "voice-notes", name: "Voice notes", vendor: "lifestream", type: "voice", records: "Every voice note.", sources: [{ id: "voice-notes:local:<unit>", read: "voice-notes-ios-bundle", arrives: "phone" }], phone: { grants: [] } },
      { id: "example", product: "example", name: "Example", vendor: "example", type: "notes", records: "Every note handed in.", sources: [{ id: "example:local:<unit>", read: "example-drop", arrives: "upload" }] },
      (({ hidden: _hidden, ...offered }) => offered)(declarations().find((each) => each.id === "coast")!),
    ];
    const sources: [string, string, JsonObject?][] = [
      [`screen:local:${MAC}`, "screen-capture"], [`voice-notes:local:${PHONE}`, "voice-notes-ios-bundle"], [`example:local:${MAC}`, "example-drop"],
      [`imessage:person-a@example.com:${OLD}`, "imessage-db"], [`imessage:person-a@example.com:${MAC}`, "imessage-db"],
      [LOCATION, "location-ios-bundle"], ["location:local:iphone-17-pro-bb02", "location-ios-bundle"], ["apple-health:person-a@example.com:cloud", "health-ios-bundle", { lane: `phone:${PHONE}` }],
      ["chatgpt:user-synthetic0001:browser", "chatgpt-browser", { email: "person-a@example.com" }], ["chatgpt:user-synthetic0001:cloud", "chatgpt-export"],
      [TAKEOUT, "google-my-activity", { lane: "upload:local:macbook-pro-0001" }], ["google-maps:person-a@example.com:export", "google-my-activity", { lane: "upload:local:macbook-pro-0001" }],
      [`chrome:default:${MAC}`, "chrome-history"], [`chrome:profile-2:${MAC}`, "chrome-history"], [GMAIL, "gmail"], [`coast:local:${MAC}`, "coast"],
    ];
    const root = makeRootOnce(roots);
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => {
      for (const [id, connector, options] of sources) tx.tables.sources.add({ id, vendor: vendorOf([...declarations(), ...declared], id), connector, ...(options === undefined ? {} : { options }), added_ms: 0 });
      for (const [unit, model] of [[MAC, "MacBook Pro"], [OLD, "iPhone X"], [PHONE, "iPhone 17 Pro"], ["iphone-17-pro-bb02", "iPhone 17 Pro"]] as const) {
        tx.tables.devices.add({ unit, model, added_ms: 0 });
      }
      tx.tables.devices.retire(OLD, 1);
    });
    db.close();
    const report = reportOf(root, { connectors: declared });
    artifact(root, "connectors-names", report);
    const names = (id: string) => report.connectors.find((connector) => connector.id === id)!.copies.map((copy) => [copy.id, copy.name]);
    expect(names("imessage")).toEqual([[`imessage:person-a@example.com:${OLD}`, "Previous iPhone X"], [`imessage:person-a@example.com:${MAC}`, "MacBook Pro"]]);
    expect(names("location")).toEqual([[LOCATION, "iPhone 17 Pro"], ["location:local:iphone-17-pro-bb02", "iPhone 17 Pro 2"]]);
    expect(names("health")).toEqual([["apple-health:person-a@example.com:cloud", "Health"]]);
    expect(names("chatgpt")).toEqual([["chatgpt:user-synthetic0001:browser", "person-a@example.com"], ["chatgpt:user-synthetic0001:cloud", "Export"]]);
    expect(names("google")).toEqual([["google-maps:person-a@example.com:export", "Google Maps"], [TAKEOUT, "YouTube"]]);
    expect(names("chrome")).toEqual([[`chrome:default:${MAC}`, "Default"], [`chrome:profile-2:${MAC}`, "Profile 2"]]);
    expect(names("gmail")).toEqual([[GMAIL, "Gmail"]]);
    expect(names("screen")).toEqual([[`screen:local:${MAC}`, "MacBook Pro"]]);
    expect(names("voice-notes")).toEqual([[`voice-notes:local:${PHONE}`, "iPhone 17 Pro"]]);
    expect(names("example")).toEqual([[`example:local:${MAC}`, "Example"]]);
    expect(names("coast")).toEqual([[`coast:local:${MAC}`, "MacBook Pro"]]);
    expect(report.connectors.find((each) => each.id === "imessage")!.copies.map((copy) => copy.retired)).toEqual([true, false]);
    const phoneOff = reportOf(root, { connectors: declared, settings: { ...effective(root).settings, sources: { off: [PHONE] }, connectors: {} } });
    expect(phoneOff.connectors.flatMap((each) => each.copies.filter((copy) => !copy.on).map((copy) => copy.id)).sort()).toEqual([LOCATION, `voice-notes:local:${PHONE}`].sort());
    const CLOUD = "apple-health:person-a@example.com:cloud";
    for (const unit of [PHONE, "iphone-17-pro-bb02"]) {
      mintPrincipal(openHomeFolder(root), { unit, kind: "phone", scopes: ["deliver", "read"], sources: [CLOUD, `location:local:${unit}`], now_ms: 0 });
    }
    const phoned = reportOf(root, { stated: grantsOnly({ [PHONE]: { health: "asked", location: "off" }, "iphone-17-pro-bb02": { location: "on" } }), connectors: declared });
    expect(phoned.devices.filter((device) => device.kind === "phone" && !device.retired).map((device) => [device.unit, device.grants])).toEqual([
      [PHONE, { health: "asked", location: "off" }], ["iphone-17-pro-bb02", { location: "on" }]]);
    expect(phoned.needs.map((need) => [need.id, need.words, need.connector, need.copy, need.unit])).toEqual([
      [`grant:location:${PHONE}`, "Allow Location", "location", null, PHONE]]);
    artifact(root, "connectors-allowed", phoned);
    const unshown: Connector = { id: "owner-poll", product: "owner-poll", name: "Owner poll", vendor: "owner", records: "What a poll the owner set brings.", acquirers: ["owner-poll"],
      sources: [{ id: "owner-poll:local:<home>", read: "owner-poll", arrives: "poll" }] };
    const failing = openHome(openHomeFolder(root), "migrate");
    failing.commit((tx) => tx.tables.attempts.put(fetched("owner-poll", "fail", null, {}, Date.now() - 3_600_000, Date.now(), 4)));
    failing.close();
    const unshownReport = reportOf(root, { connectors: [...declared, unshown] });
    expect([unshownReport.connectors.find((each) => each.id === "owner-poll")!.shown, unshownReport.needs.map((need) => [need.id, need.connector])])
      .toEqual([null, [["fetch:owner-poll", "owner-poll"]]]);
    for (const connector of report.connectors) {
      const named = connector.copies.map((copy) => copy.name);
      expect(named.every((name) => typeof name === "string" && name !== "" && !name.includes(":")), connector.id).toBe(true);
      expect(new Set(named).size, connector.id).toBe(named.length);
    }
  });

  it("marks a member the home applies, says a device's member stated or waiting otherwise than the devices that deliver it state it, draws the start with no device's echo and knows what is left under another start", () => {
    const root = makeRootOnce(roots);
    const AIR = "macbook-air-bb07";
    const db = openHome(openHomeFolder(root), "migrate");
    const at = Date.now() - 60_000;
    db.commit((tx) => {
      for (const [id, connector] of [[WHATSAPP, "whatsapp-db"], [SCREEN, "screen-recorder"], [LOCATION, "location-ios-bundle"]] as const) tx.tables.sources.add({ id, vendor: vendorOf(declarations(), id), connector, added_ms: 0 });
      delivered(tx, { id: `${WHATSAPP}/1`, source: WHATSAPP, sealed_ms: at, stated_ms: at, facts: { left: 0, start_ms: null } });
      for (const [unit, model] of [[MAC, "MacBook Pro"], [AIR, "MacBook Air"], [PHONE, "iPhone 17 Pro"]] as const) tx.tables.devices.add({ unit, model, added_ms: 0 });
      tx.tables.meta.set(nameKey(PHONE), "Work iPhone");
    });
    db.close();
    const principals = openHomeFolder(root);
    mintPrincipal(principals, { unit: MAC, kind: "mac", scopes: ["deliver"], sources: [SCREEN, WHATSAPP], now_ms: 0 });
    mintPrincipal(principals, { unit: PHONE, kind: "phone", scopes: ["deliver", "read"], sources: [LOCATION], now_ms: 0 });
    mintPrincipal(principals, { unit: AIR, kind: "mac", scopes: ["deliver"], sources: [`whatsapp:+15550000002:${AIR}`], now_ms: 0 });
    const settings = { ...effective(root).settings, connectors: { screen: { ocr: "always" }, location: { precision: "battery" }, whatsapp: { start: DAY_90 } } };
    const said = (stated: Stated | null, off: string[] = []) => {
      const read = reportOf(root, { stated, settings: { ...settings, sources: { off } } });
      return (id: string) => read.connectors.find((each) => each.id === id)!;
    };

    const marks = (row: ConnectorReport, key: string) => {
      const member = row.members.find((each) => each.key === key)!;
      return [member.panel !== null, member.waiting?.map((each) => each.name)];
    };
    const none = said(null);
    expect([marks(none("screen"), "refresh"), marks(none("screen"), "ocr"), marks(none("location"), "precision")]).toEqual([[false, []], [false, []], [false, []]]);
    expect(none("gmail").members.filter((each) => Object.hasOwn(each, "waiting"))).toEqual([]);
    expect(none("whatsapp").history).toMatchObject({ state: "syncing", left: null });
    expect(marks(none("whatsapp"), "start")).toEqual([true, undefined]);

    const stated: Stated = {
      [MAC]: word({ grants: null, settings: { screen: { refresh: "2s", ocr: "exact", idle_pause: "5m", apps: [] }, whatsapp: { refresh: "5m", start_ms: START_90 } } }),
      [PHONE]: word({ grants: { location: "on" }, settings: { location: { precision: "precise" } } }),
      [AIR]: word({ grants: null, settings: { screen: { ocr: "exact" }, whatsapp: { start_ms: START_90 } } }),
    };
    const of = said(stated);
    expect(["refresh", "apps", "idle_pause", "ocr"].map((key) => marks(of("screen"), key))).toEqual([[true, []], [true, []], [true, []], [true, ["MacBook Pro"]]]);
    expect(of("location").members.find((each) => each.key === "precision")!.waiting).toEqual([
      { name: "Work iPhone", kind: "phone", line: "Waiting for Work iPhone · Open Lifestream on it to sync." }]);
    expect(of("screen").members.find((each) => each.key === "ocr")!.waiting).toEqual([
      { name: "MacBook Pro", kind: "mac", line: "Waiting for MacBook Pro · It takes it when Lifestream runs there." }]);
    expect(marks(of("whatsapp"), "start")).toEqual([true, undefined]);
    const write = openHome(openHomeFolder(root), "migrate");
    write.commit((tx) => delivered(tx, { id: `${WHATSAPP}/2`, source: WHATSAPP, sealed_ms: at + 1, stated_ms: at + 1, facts: { left: 0, start_ms: START_90 } }));
    write.close();
    expect(said(stated)("whatsapp").history).toMatchObject({ state: "done", words: startWords(DAY_90) });
    const behind = said({ ...stated, [MAC]: word({ grants: null, settings: { whatsapp: { refresh: "5m", start_ms: null } } }) })("whatsapp");
    expect([marks(behind, "start"), behind.history!.state]).toEqual([[true, undefined], "done"]);
    const off = said(stated, [MAC]);
    expect([marks(off("screen"), "ocr"), marks(off("screen"), "refresh")]).toEqual([[true, ["MacBook Pro"]], [true, []]]);
    artifact(root, "connectors-applied", { none: none("screen"), stated: of("screen"), location: of("location"), behind });
  });

  it("names the devices that follow a member a device applies while another device delivering it does not, whoever asks, never a retired one", () => {
    const root = makeRootOnce(roots);
    const [AIR, OLD, SPARE] = ["macbook-air-bb07", "mac-mini-cc09", "iphone-17-pro-dd11"];
    const both = {
      id: "screen-time", product: "screen-time", name: "Screen Time", vendor: "apple", type: "device-activity", noun: ["app switch", "app switches"],
      records: "Each app coming to the front and leaving it.",
      sources: [{ id: "screen-time:<account>:<unit>", read: "biome-app-in-focus", arrives: "mac" }, { id: "screen-time:local:<unit>", read: "usage-ios-bundle", arrives: "phone" }],
      refresh: { default: "5m", min: "1m", max: "5m" }, backfill: {},
      mac: { grants: ["fullDiskAccess"] }, phone: { grants: ["screen-time"] },
    } satisfies Connector;
    const ofMac = (unit: string) => `screen-time:person-a@example.com:${unit}`;
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => {
      for (const [id, reader] of [[ofMac(MAC), "biome-app-in-focus"], [ofMac(AIR), "biome-app-in-focus"], [ofMac(OLD), "biome-app-in-focus"],
        [`screen-time:local:${PHONE}`, "usage-ios-bundle"], [SCREEN, "screen-recorder"], [`screen:local:${AIR}`, "screen-recorder"]] as const) {
        tx.tables.sources.add({ id, vendor: vendorOf(declarations(), id), connector: reader, added_ms: 0 });
      }
      for (const [unit, model] of [[MAC, "MacBook Pro"], [AIR, "MacBook Air"], [OLD, "Mac mini"], [PHONE, "iPhone 17 Pro"]] as const) tx.tables.devices.add({ unit, model, added_ms: 0 });
      tx.tables.devices.retire(OLD, 1);
    });
    db.close();
    const principals = openHomeFolder(root);
    mintPrincipal(principals, { unit: MAC, kind: "mac", scopes: ["deliver"], sources: [ofMac(MAC), SCREEN], now_ms: 0 });
    mintPrincipal(principals, { unit: PHONE, kind: "phone", scopes: ["deliver", "read"], sources: [`screen-time:local:${PHONE}`], now_ms: 0 });
    mintPrincipal(principals, { unit: OLD, kind: "mac", scopes: ["deliver"], sources: [ofMac(OLD)], now_ms: 0 });
    const connectors = [...DECLARED, both];
    const report = (stated: Stated | null, unit?: string) => reportOf(root, { stated, connectors, ...unit === undefined ? {} : { unit } });
    const lines = (read: StreamsReport, id: string, keys: string[]) => keys.map((key) => {
      const member = read.connectors.find((each) => each.id === id)!.members.find((each) => each.key === key)!;
      return [member.panel !== null, member.only];
    });
    const runs = { refresh: "5m", start_ms: null };
    const phoneStates = word({ grants: null, settings: { "screen-time": runs } });

    expect(lines(report(null), "screen-time", ["refresh", "start"])).toEqual([[false, null], [true, undefined]]);
    const macOnly: Stated = { [MAC]: word({ grants: null, settings: { "screen-time": runs, screen: { refresh: "2s", ocr: "exact", idle_pause: "5m", apps: [] } } }),
      [PHONE]: word({ grants: { "screen-time": "on" }, settings: {} }) };
    expect(lines(report(macOnly), "screen-time", ["refresh", "start"])).toEqual([[true, "On MacBook Pro"], [true, undefined]]);
    const behind: Stated = { ...macOnly, [MAC]: word({ grants: null, settings: { "screen-time": { ...runs, refresh: "1m" } } }) };
    const asked = [undefined, MAC, PHONE].map((unit) => report(behind, unit).connectors.find((each) => each.id === "screen-time")!.members.find((each) => each.key === "refresh")!);
    expect(asked.map((member) => [member.only, member.waiting!.map((each) => each.name)])).toEqual([["On MacBook Pro", ["MacBook Pro"]], ["On MacBook Pro", []], ["On MacBook Pro", ["MacBook Pro"]]]);
    expect(lines(report(macOnly), "screen", ["refresh", "ocr"])).toEqual([[true, null], [true, null]]);
    expect(lines(report({ ...macOnly, [PHONE]: phoneStates }), "screen-time", ["refresh", "start"])).toEqual([[true, null], [true, undefined]]);
    const read = report(macOnly);
    expect([read.connectors.find((each) => each.id === "gmail")!.members.find((each) => each.key === "refresh")!, read.connectors.find((each) => each.id === "whatsapp")!
      .members.find((each) => each.key === "groups_talk")!].map((member) => Object.hasOwn(member, "only"))).toEqual([false, false]);
    expect(lines(report({ ...macOnly, [OLD]: word({ grants: null, settings: { "screen-time": runs } }) }), "screen-time", ["refresh"])).toEqual([[true, "On MacBook Pro"]]);
    expect(lines(report({ ...macOnly, [PHONE]: phoneStates }), "screen-time", ["start"])).toEqual([[true, undefined]]);
    const named = openHome(openHomeFolder(root), "migrate");
    named.commit((tx) => tx.tables.meta.set(nameKey(MAC), "Studio Mac"));
    named.close();
    expect(lines(report(macOnly), "screen-time", ["refresh"])).toEqual([[true, "On Studio Mac"]]);
    mintPrincipal(principals, { unit: AIR, kind: "mac", scopes: ["deliver"], sources: [ofMac(AIR), `screen:local:${AIR}`], now_ms: 0 });
    const twoMacs: Stated = { ...macOnly, [AIR]: word({ grants: null, settings: { "screen-time": runs, screen: { refresh: "2s" } } }) };
    const two = report(twoMacs);
    expect(lines(two, "screen-time", ["refresh", "start"])).toEqual([[true, "On MacBook Air and Studio Mac"], [true, undefined]]);
    expect(lines(two, "screen", ["refresh"])).toEqual([[true, null]]);
    mintPrincipal(principals, { unit: SPARE, kind: "phone", scopes: ["deliver", "read"], sources: [`screen-time:local:${SPARE}`], now_ms: 0 });
    expect(lines(report({ ...twoMacs, [PHONE]: phoneStates }), "screen-time", ["refresh"])).toEqual([[true, null]]);
    const phoneOff = reportOf(root, { stated: twoMacs, connectors, settings: { ...effective(root).settings, sources: { off: [`screen-time:local:${PHONE}`] }, connectors: {} } });
    expect(lines(phoneOff, "screen-time", ["refresh"])).toEqual([[true, null]]);
    artifact(root, "connectors-only", { macOnly: report(macOnly).connectors.find((each) => each.id === "screen-time")!.members, two: two.connectors.find((each) => each.id === "screen-time")!.members });
  });

  it("says the last item of one ahead of now, a key route's need as a sign-in's, or a wait on the home's own door restarting on a stream's row", () => {
    const CALENDAR = "apple-notes:local:calendar";
    const KEYED = "apple-notes:local:keyed";
    const SIGNED = "apple-notes:local:signed";
    const declared: Connector[] = [
      { id: "fake-calendar", product: "apple-notes", name: "Calendar", vendor: "apple", type: "plans", noun: ["event", "events"], records: "Synthetic events.",
        sources: [{ id: CALENDAR, read: "fake-calendar-rows", arrives: "poll" }], acquirers: ["fake-calendar"], refresh: { default: "1h" } },
      { id: "fake-key", product: "apple-notes", name: "Keyed", vendor: "apple", type: "notes", records: "Synthetic notes behind a key.",
        sources: [{ id: KEYED, read: "fake-keyed-rows", arrives: "poll" }], acquirers: ["fake-key"], refresh: { default: "1h" },
        fields: { account: { kind: "email", label: "Email", account: true }, token: { kind: "secret", label: "Token", secret: "fake-key" } },
        signin: [{ acquirer: "fake-key", way: "key", fields: ["account", "token"], label: "Use a token" }] },
      { id: "fake-signed", product: "apple-notes", name: "Signed", vendor: "apple", type: "notes", records: "Synthetic notes behind a sign-in.",
        sources: [{ id: SIGNED, read: "fake-signed-rows", arrives: "poll" }], acquirers: ["fake-signed"], refresh: { default: "1h" },
        fields: { account: { kind: "email", label: "Email", account: true }, signin: { kind: "secret", label: "Sign-in", secret: "fake-signed" } },
        signin: [{ acquirer: "fake-signed", way: "device", field: "signin", label: "Sign in with Signed", issuer: "https://auth.example.com", scope: "notes.read" }] },
      { id: "fake-folder", product: "apple-notes", name: "Foldered", vendor: "apple", type: "notes", records: "Synthetic notes in a folder.",
        sources: [{ id: "apple-notes:local:folder", read: "fake-folder-rows", arrives: "poll" }], acquirers: ["fake-folder"], refresh: { default: "1h" },
        fields: { folder: { kind: "path", label: "Vault folder", folder: true } } },
    ];
    const root = makeRootOnce(roots);
    const day = effective(root).settings.day;
    const now = Date.now();
    const yesterday = now - 86_400_000;
    const db = openHome(openHomeFolder(root), "migrate");
    const object: Guard = (content) => (typeof content === "object" && content !== null ? [] : ["not an object"]);
    db.commit((tx) => {
      tx.tables.sources.add({ id: CALENDAR, vendor: "apple", connector: "fake-calendar-rows", added_ms: 0 });
      const run = tx.tables.runs.start({ kind: "import", subject: CALENDAR, started_ms: 0 });
      tx.records.land(run, { id: `${CALENDAR}/1`, source: CALENDAR, stated_ms: now }, [yesterday, now + 30 * 86_400_000].map((start_ms, index) => ({
        kind: "event", key: `event-${index}`, content: { text: "synthetic" }, time: { start_ms, precision: "ms" as const },
      })), { event: object }, { has: () => true });
      tx.tables.polls.put({ acquirer: "fake-calendar", next_ms: now + 300_000, paged_ms: null, page_next_ms: null, held_ms: null, pages: false });
    });
    const calendar = (attempt?: AttemptRow) => {
      if (attempt !== undefined) db.commit((tx) => tx.tables.attempts.put(attempt));
      return reportOf(root, { connectors: declared, now_ms: now }).connectors.find((each) => each.id === "fake-calendar")!;
    };
    try {
      const said = calendar();
      expect([said.copies[0]!.newest_ms, said.line]).toEqual([yesterday, `Last event ${when(yesterday, now, day)}`]);
      const way = (id: string) => reportOf(root, { connectors: declared, now_ms: now }).connectors.find((each) => each.id === id)!.ways[0]!.requirements;
      expect(way("fake-key")).toEqual([expect.objectContaining({ kind: "sign-in", met: false, words: "Connect Keyed", act: { do: "signin", label: "Set up", of: "fake-key" } })]);
      expect(way("fake-signed")).toEqual([expect.objectContaining({ kind: "sign-in", met: false, words: "Sign in to Signed", act: { do: "signin", label: "Sign in", of: "fake-signed" } })]);
      expect(reasonWords("needs-you", "sign-in", { name: "Keyed", noun: null, now, day, facts: { way: "key" } })).toBe("Connect Keyed");
      expect(way("fake-folder")).toEqual([expect.objectContaining({ kind: "form", met: false, words: "Choose Vault folder", act: { do: "set", label: "Choose", member: "folder" } })]);
      expect(reportOf(root, { connectors: declared, now_ms: now }).connectors.find((each) => each.id === "fake-folder")!.health.words).toBe("Choose Vault folder");
      expect(reasonWords("setup", "form", { name: "Keyed", noun: null, now, day, facts: {} })).toBe("Set up Keyed");
      const wait = (reason: string): AttemptRow => ({ ...fetched("fake-calendar", "wait", reason, {}, now - 1_000, now), source: CALENDAR });
      const restarting = calendar(wait("door"));
      expect([restarting.health.state, restarting.copies[0]!.health.state, restarting.line]).toEqual([said.health.state, said.copies[0]!.health.state, said.line]);
      expect(calendar(wait("offline")).copies[0]!.health.words).toBe("Waiting for internet");
    } finally {
      db.close();
    }
  });

  it("the door answers other connectors than the socket, answers a pass that does not read, or refuses a phone's", async () => {
    const root = makeRoot("lifestream-connectors-door-", { sources: { [GMAIL]: "fake-rows", [SCREEN]: "screen-recorder" } });
    roots.push(root);
    const principals = openHomeFolder(root);
    const token = () => randomBytes(32).toString("base64url");
    const passes = { reader: token(), phone: token(), mac: token() };
    mintPrincipal(principals, { unit: "reader-0001", scopes: ["read"], token: passes.reader, now_ms: 0 });
    mintPrincipal(principals, { unit: PHONE, kind: "phone", scopes: ["deliver", "read"], sources: [LOCATION], token: passes.phone, now_ms: 0 });
    mintPrincipal(principals, { unit: MAC, kind: "mac", scopes: ["deliver"], sources: [SCREEN], token: passes.mac, now_ms: 0 });
    const door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { lookMs: LOOK_MS, log: () => undefined, registry: FAKES });
    const port = door.port;
    editSettings(root, { "door.port": port });
    const home: Home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    try {
      const at = Date.now() - 60_000;
      await ship(root, { source: GMAIL, fetched_ms: at, rows: [row("m1", at)] });
      await until("the mail imported", () => readHome(root, (read) => read.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get()) === 1);
      await until("the tally rebuilt", () => String(readHome(root, (read) => read.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(TALLY_MARK)) ?? "").includes("complete"));
      await until("the home's models stored", () => readHome(root, (read) => read.prepare("SELECT 1 FROM meta WHERE key = ?").get(MODELS_META)) !== undefined);
      const get = async (pass: string, headers: Record<string, string> = {}) => {
        const response = await fetch(`http://127.0.0.1:${port}/v1/connectors`, { headers: { authorization: `Bearer ${pass}`, ...headers } });
        return { status: response.status, body: await response.json() as Record<string, unknown> };
      };
      const socket = await askHome(testSocket(root), "connectors") as StreamsReport;
      const typed = async (...args: string[]) => {
        const out: string[] = [];
        expect(await runCli(["connectors", ...args, "--root", root], { write: (text) => out.push(text) })).toBe(0);
        return out.join("").trimEnd().split("\n");
      };
      const [bare, json] = [await typed(), await typed("--json")];
      expect([bare.filter((line) => line.startsWith("{")), json.length]).toEqual([[], 1]);
      expect(bare.slice(0, socket.connectors.length).map((line, at) => line.startsWith(`${socket.connectors[at]!.name}: `))).toEqual(socket.connectors.map(() => true));
      expect((JSON.parse(json[0]!) as StreamsReport).connectors.map((connector) => connector.id)).toEqual(socket.connectors.map((connector) => connector.id));
      const [reader, phone, mac] = [await get(passes.reader), await get(passes.phone, DEVICE.phone), await get(passes.mac, DEVICE.mac)];
      expect([reader.status, phone.status, [mac.status, mac.body.code]]).toEqual([200, 200, [403, "PRINCIPAL_SCOPE"]]);
      const byId = (list: unknown) => [...list as ConnectorReport[]].sort((x, y) => x.id.localeCompare(y.id));
      const rows = ({ at_ms: _at, position: _position, disk, connectors, ...rest }: Record<string, unknown>) =>
        ({ ...rest, connectors: byId(connectors), disk: { ...disk as object, free_bytes: typeof (disk as { free_bytes: unknown }).free_bytes } });
      expect(reader.body.position).toEqual(expect.stringMatching(/^\d+:\d+$/u));
      expect(rows(reader.body)).toEqual(rows(socket as unknown as Record<string, unknown>));
      expect(rows(phone.body)).toEqual(rows(reader.body));
      const served = reader.body as unknown as StreamsReport;
      expect(served.connectors.map((each) => each.id).sort()).toEqual(FAKES_CONNECTORS(await loadRegistry(FAKES, effective(root).settings, homeOf(openHomeFolder(root)))).sort());
      const status = await (await fetch(`http://127.0.0.1:${port}/v1/status`, { headers: { authorization: `Bearer ${passes.reader}` } })).json() as Record<string, any>;
      expect([served.day, served.needs, typeof served.disk.free_bytes]).toEqual([status.day, shownNeeds(status.needs as Need[]).map(needOf), "number"]);
      const products = await (await fetch(`http://127.0.0.1:${port}/v1/products`, { headers: { authorization: `Bearer ${passes.reader}` } })).json() as unknown;
      const declared = productsOf((await loadRegistry(FAKES, effective(root).settings, homeOf(openHomeFolder(root)))).connectors);
      expect([products, served.products]).toEqual([JSON.parse(JSON.stringify(declared)), declared.digest]);
      artifact(root, "connectors-door", { connectors: reader.body, status: { day: status.day, needs: status.needs, disk: status.disk } });
    } finally {
      await home.stop();
      await door.close();
    }
  });

  it("restarts the home for a switch, polls or imports a source turned off, or never imports what waited once it is on again", async () => {
    const POLL = "apple-notes:local:poll";
    const TWO = "apple-notes:local:poll-two";
    const root = makeRoot("lifestream-connectors-acts-", { sources: { [SCREEN]: "screen-recorder", [POLL]: "fake-rows", [TWO]: "fake-rows" }, clocks: true });
    roots.push(root);
    const tries = { one: join(root, "attempts-one"), two: join(root, "attempts-two") };
    editSettings(root, { "connectors.fake-poll": { attempts: tries.one, refresh: "1s" }, "connectors.fake-poll-two": { attempts: tries.two, refresh: "1s" } });
    const fetches = (file: string) => (existsSync(file) ? readFileSync(file).length : 0);
    const delivered = (id: string) => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) as string | undefined;
    const ended = (kind: string, key: string, since: number) => readHome(root, (db) => db.prepare("SELECT 1 FROM jobs WHERE kind = ? AND key = ? AND state = 'done' AND ended_ms >= ?").get(kind, key, since)) !== undefined;
    mintPrincipal(openHomeFolder(root), { unit: MAC, scopes: ["deliver"], sources: [SCREEN], kind: "mac", now_ms: 0 });
    const sock = testSocket(root);
    const home: Home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    let stopped: string | null = null;
    void home.stopped.then((why) => { stopped = why; });
    try {
      await until("the poll's first delivery imported", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE source = ? AND state = 'imported'").pluck().get(POLL)) as number >= 1);
      expect(await askHome(sock, "connectors", ["off", POLL])).not.toHaveProperty("restarting");
      expect(effective(root).settings.sources.off).toEqual([POLL]);
      const at = Date.now();
      const before = { one: fetches(tries.one), two: fetches(tries.two) };
      const kept = await ship(root, { source: POLL, fetched_ms: at - 1_000, rows: [row("kept", at - 1_000)] });
      await askHome(sock, "run", ["poll", "fake-poll"]);
      await until("the other poll fetched twice, and the off source's import and poll ran", () =>
        fetches(tries.two) >= before.two + 2 && delivered(kept) !== undefined && ended("import", POLL, at) && ended("poll", "fake-poll", at));
      expect({ fetched: fetches(tries.one) - before.one, kept: delivered(kept) }).toEqual({ fetched: 0, kept: "sealed" });
      expect(await askHome(sock, "connectors", ["on", POLL])).not.toHaveProperty("restarting");
      expect(effective(root).settings.sources.off).toEqual([]);
      await until("the kept delivery imported", () => delivered(kept) === "imported");
      await until("the poll fetched again", () => fetches(tries.one) > before.one);

      expect(stopped).toBeNull();
    } finally {
      await home.stop();
    }
  });

  it("stops a running home's clock or imports on a hand edit that breaks settings.json, or applies the edit before the next start (23)", async () => {
    const POLL = "apple-notes:local:poll";
    const root = makeRoot("lifestream-connectors-broken-", { sources: { [POLL]: "fake-rows" }, clocks: true });
    roots.push(root);
    const home: Home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: FAKES, log: () => undefined });
    try {
      const imported = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE source = ? AND state = 'imported'").pluck().get(POLL)) as number;
      const zone = home.settings.day.zone;
      writeFileSync(join(root, "config", "settings.json"), "{ a hand edit, cut short");
      const ticks = home.stats().ticks.count;
      const at = Date.now() - 1_000;
      await ship(root, { source: POLL, fetched_ms: at, rows: [row("after-the-edit", at)] });
      await until("the delivery imported after the edit", () => imported() === 1);
      await until("the clock ticked on", () => home.stats().ticks.count > ticks + 1);
      const registry = await loadRegistry(FAKES, home.settings, homeOf(openHomeFolder(root)));
      expect(statusOf(root, { now_ms: Date.now(), settings: home.settings, connectors: registry.connectors, families: registry.families }).notices.map((notice) => notice.id)).toContain("settings");
      expect(home.settings.day.zone).toBe(zone);
    } finally {
      await home.stop();
    }
  });
});

describe("a connector's polls at the CLI: set, reread and show", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) removeRoot(root);
  });

  const POLLED = "apple-notes:local:reread";
  const ACCOUNTED = "apple-notes:local:accounted";
  const REQUESTED = "apple-notes:local:requested";
  const polled = {
    id: "fake-reread", product: "apple-notes", name: "Notes", vendor: "apple", type: "notes", noun: ["note", "notes"], records: "Synthetic notes a poll reads, and their history.",
    sources: [{ id: POLLED, read: "fake-rows", arrives: "poll" }], acquirers: ["fake-reread"], refresh: { default: "1h" },
    backfill: { pace: { default: "2m", min: "1m", max: "1h" } },
  } satisfies Connector;
  const accounted = {
    id: "fake-account", product: "apple-notes", name: "Notes", vendor: "apple", type: "notes", noun: ["note", "notes"], records: "Synthetic notes of an account the person types.",
    sources: [{ id: ACCOUNTED, read: "fake-rows", arrives: "poll" }], acquirers: ["fake-account"], refresh: { default: "1h" },
    fields: { account: { kind: "email", label: "Account" }, file: { kind: "path", label: "Notes file" } },
  } satisfies Connector;
  const requested = {
    id: "fake-request", product: "apple-notes", name: "Notes", vendor: "apple", type: "notes", noun: ["note", "notes"], records: "Synthetic notes the home asks an export of.",
    sources: [{ id: REQUESTED, read: "fake-rows", arrives: "upload", feeders: ["fake-request"] }], acquirers: ["fake-request"], refresh: { default: "1d" },
    fields: { account: { kind: "email", label: "Account" }, label: { kind: "text", label: "Label", default: "synthetic" } },
  } satisfies Connector;
  const keyed = {
    id: "fake-keyed", product: "apple-notes", name: "Notes", vendor: "apple", type: "notes", noun: ["note", "notes"], records: "Synthetic notes behind a key.",
    sources: [{ id: "apple-notes:local:keyed", read: "fake-keyed-rows", arrives: "poll" }], acquirers: ["fake-keyed"], refresh: { default: "1h" },
    fields: { token: { kind: "secret", label: "Token", secret: "fake-keyed" } },
    signin: [{ acquirer: "fake-keyed", way: "key", fields: ["token"], label: "Use a token" }],
  } satisfies Connector;

  const note = (key: string) => ({ path: `${key}.ndjson`, bytes: Buffer.from(`${JSON.stringify({ kind: "note", key, content: { text: `synthetic ${key}` }, at: Date.UTC(2026, 8, 1) })}\n`) });
  type Script = (state: JsonObject | null, lent: Lent) => { files: { path: string; bytes: Buffer }[]; state: JsonObject; left?: number };
  const FETCH: Script = (state, lent) => {
    const n = Number(state?.n ?? 0) + 1;
    lent.memory.put("seen", `note-${n}`, true);
    return { files: [note(`note-${n}`)], state: { ...state, n } };
  };
  const PAGE: Script = (state) => ({ files: [note("old-1"), note("old-2")], state: { ...state, history: "walked" }, left: 0 });

  function world(prefix: string) {
    const root = makeRoot(prefix, { sources: { [POLLED]: "fake-rows", [ACCOUNTED]: "fake-rows", [REQUESTED]: "fake-rows" } });
    roots.push(root);
    const script: { fetch: Script; page: Script } = { fetch: FETCH, page: PAGE };
    const calls: { call: Call; handed: JsonObject | null; listed: string[] }[] = [];
    const scripted = (call: Call) => async (state: JsonObject | null, _secrets: unknown, lent: Lent) => {
      calls.push({ call, handed: state, listed: lent.memory.list("seen").map(([key]) => key) });
      const { files, state: next, left } = script[call](state, lent);
      return { files, facts: {}, state: next, ...(call === "page" ? { left: left ?? null } : {}) };
    };
    let fetched = 0;
    const acquirers: Acquirer[] = [
      { name: "fake-reread", source: POLLED, secrets: [], fetch: scripted("fetch"), page: scripted("page") } as unknown as Acquirer,
      { name: "fake-account", source: ACCOUNTED, secrets: [], fetch: async () => ({ files: [note(`accounted-${++fetched}`)], facts: {}, state: { fetched } }) },
      { name: "fake-request", source: REQUESTED, secrets: [], fetch: async () => ({ files: [], facts: {}, state: {} }) },
    ];
    const registry = { connectors: connectorsWith([polled, accounted, requested, keyed]), readers: [{ name: "fake-rows" }, { name: "fake-keyed-rows" }], families: [], acquirers, labelers: [], code: "code-test" } as unknown as Loaded;
    const db = openHome(openHomeFolder(root), "migrate");
    const main = () => ({ folder: openHomeFolder(root), settings: effective(root).settings, now: Date.now, room: "ok", stated: {}, ending: 0, registry, log: () => undefined, polled: () => undefined }) as unknown as Main;
    const begin = (name: string, queue: Call[] = []) => {
      const acquirer = acquirers.find((each) => each.name === name)!;
      const job = { id: 1, kind: "poll", key: name, connector: name, lane: 1 } as JobRow;
      const at = main();
      const begun = db.commit((tx) => {
        const queued = tx.tables.jobs.get("poll", name);
        if (queued?.state === "queued") tx.tables.jobs.delete(queued.id);
        unparkPoll(tx, acquirer);
        if (queue.length > 0) queuedFor(tx, name, queue);
        return pollKind.begin!(at, tx, job);
      });
      if (begun === null) return null;
      return {
        cursor: begun.data.cursor,
        async end(): Promise<string> {
          const env = { folder: openHomeFolder(root), registry, db, secrets: () => ({ get: () => undefined, rotate: () => undefined }), stations: { door: "http://127.0.0.1:9", pass: "none" }, signal: new AbortController().signal } as unknown as HelperEnv;
          const task = { job: 1, kind: "poll", key: name, lane: 1, now_ms: Date.now(), data: begun.data };
          try {
            const result = (await pollKind.helper(env, task).next()).value as Parameters<typeof pollKind.done>[3];
            db.commit((tx) => pollKind.done(at, tx, { job, state: begun.state }, result));
            return result.end.outcome;
          } catch (error) {
            db.commit((tx) => pollKind.failed!(at, tx, job, begun.state, (error as Error).message));
            return "fail";
          }
        },
      };
    };
    const drain = async (name: string): Promise<void> => {
      for (let run = begin(name); run !== null; run = begin(name)) await run.end();
    };
    const cli = async (verb: string, ...args: string[]) => {
      const lines: string[] = [];
      const ctx = openContext(openHomeFolder(root), () => undefined, { registry }, "write", (line) => lines.push(line));
      try {
        return { lines, answer: await VERBS[verb]!(ctx, args) as Record<string, unknown> };
      } finally {
        ctx.close();
      }
    };
    const printed = async (...args: string[]) => {
      const out: string[] = [];
      expect(await runCli([...args, "--root", root], { write: (text) => out.push(text), registry })).toBe(0);
      return out.join("").trimEnd().split("\n");
    };
    const kept = (name: string) => db.commit((tx) => ({
      cursor: tx.tables.polls.cursor(name)?.state ?? null,
      memory: tx.tables.polls.rememberedAfter(name, "seen", null, 100).map(([key]) => key),
      clocks: tx.tables.polls.get(name) ?? null,
      queued: tx.tables.jobs.get("poll", name)?.state === "queued" ? JSON.parse(tx.tables.meta.get(`poll-queued:${name}`) ?? "[]") as string[] : null,
    }));
    const deliveries = (source: string) => readHome(root, (read) => read.prepare("SELECT count(*) FROM deliveries WHERE source = ?").pluck().get(source)) as number;
    return { root, db, script, calls, begin, drain, cli, printed, kept, deliveries, close: () => db.close() };
  }

  it("polls a setup still half made, reads a change of two members as two, or holds back a poll the home builds on one", async () => {
    const half = world("lifestream-connectors-half-");
    try {
      const file = join(half.root, "exports", "notes.json");
      const named = await half.cli("connectors", "set", "fake-account", "file", file);
      expect([(named.answer.changed as Member[]).map((each) => each.member), named.lines.at(-1)]).toEqual([["file"], "no poll of fake-account runs until account is set"]);
      expect((await half.cli("connectors", "set", "fake-request", "label", "other")).lines.at(-1)).toBe("fake-request: its fetch runs with this change as the home starts: no home runs now");
      const refused = async (...args: string[]) => await half.cli("connectors", ...args).then(() => null, (error: Error) => error.message);
      expect(await refused("set", "fake-account", "account", "person-b@example.com", "file", "x.json", "--was", "\"person-a@example.com\"")).toMatch(/^--was is the value one member was: set that member alone\n/u);
      expect(await refused("set", "fake-account", "account", "person-b@example.com", "account", "person-c@example.com")).toBe("account is named twice: name each member once");
      expect(await refused("set", "fake-account", "account", "person-b@example.com", "file")).toMatch(/^usage: lifestream connectors /u);
      expect(blockOf(half.root, "fake-account")).toEqual({ file });
      const both = await half.cli("connectors", "set", "fake-account", "file", join(half.root, "exports", "other.json"), "account", "person-a@example.com");
      expect([(both.answer.changed as Member[]).map((each) => each.member), both.lines.at(-1)])
        .toEqual([["file", "account"], "fake-account: its fetch runs with this change as the home starts: no home runs now"]);
      await half.cli("connectors", "reset", "fake-account", "account", "file");
      expect(blockOf(half.root, "fake-account")).toEqual({});
    } finally {
      half.close();
    }
  });

  it("prints a verb's lines and its JSON together, refuses --json after a verb's words, or reads it past a --", async () => {
    const home = world("lifestream-connectors-form-");
    try {
      for (const args of [["connectors", "show", "fake-reread"], ["connectors", "set", "fake-request", "label", "other"], ["connectors", "refresh", "fake-request"]]) {
        const lines = await home.printed(...args);
        const json = await home.printed(...args, "--json");
        expect([lines.some((line) => line.startsWith("{")), json.length, typeof JSON.parse(json[0]!)], args.join(" ")).toEqual([false, 1, "object"]);
      }
      expect(answerForm(["--json", "show", "x"])).toEqual({ json: true, args: ["show", "x"] });
      expect(answerForm(["--was=1", "--", "set", "x", "label", "--json"])).toEqual({ json: false, args: ["--was=1", "--", "set", "x", "label", "--json"] });
      expect(answerForm(["--json", "--", "set", "x", "--json"])).toEqual({ json: true, args: ["--", "set", "x", "--json"] });
      expect((await home.printed("connectors", "pause", "fake-reread", "--reason", "synthetic")).map((line) => typeof JSON.parse(line))).toEqual(["object"]);
      const out: string[] = [];
      await runCli(["help", "connectors"], { write: (text) => out.push(text) });
      expect(out.join("")).toContain("with --json, its answer alone, as one line of JSON, for a program: never both");
    } finally {
      home.close();
    }
  });

  it("keeps a poll's cursor or memory through reread, or starts its next poll anywhere but from nothing", async () => {
    const home = world("lifestream-connectors-reread-");
    try {
      await home.begin("fake-reread", ["fetch"])!.end();
      await home.begin("fake-reread", ["fetch"])!.end();
      expect(home.kept("fake-reread")).toMatchObject({ cursor: canonical({ n: 2 }), memory: ["note-1", "note-2"] });
      const before = Date.now();
      const { lines, answer } = await home.cli("connectors", "reread", "fake-reread");
      expect([lines, answer]).toEqual([["fake-reread reads its source again from the start; its records stay, and an unchanged item lands no new version"], { reread: ["fake-reread"] }]);
      const after = home.kept("fake-reread");
      expect(after).toMatchObject({ cursor: null, memory: [], queued: ["fetch", "page"], clocks: { paged_ms: null, page_next_ms: null, held_ms: null, pages: true } });
      expect(after.clocks!.next_ms).toBeGreaterThanOrEqual(before);
      await home.drain("fake-reread");
      expect(home.calls.filter((call) => call.call === "fetch").at(-1)).toEqual({ call: "fetch", handed: null, listed: [] });
      expect(home.kept("fake-reread")).toMatchObject({ cursor: canonical({ n: 1 }), memory: ["note-1"] });
    } finally {
      home.close();
    }
  });

  it("leaves a history walked to its end walked after reread, or reads none of its old items again", async () => {
    const home = world("lifestream-connectors-history-");
    const left = () => readHome(home.root, (read) => read.prepare("SELECT left FROM backfills WHERE source = ?").pluck().get(POLLED)) as number | null | undefined;
    try {
      await home.begin("fake-reread", ["fetch"])!.end();
      await home.begin("fake-reread", ["page"])!.end();
      expect([left(), home.begin("fake-reread", ["page"])]).toEqual([0, null]);
      const pages = home.calls.filter((call) => call.call === "page").length;
      await home.cli("connectors", "reread", "fake-reread");
      expect(left()).toBeNull();
      await home.drain("fake-reread");
      await home.begin("fake-reread", ["page"])!.end();
      const paged = home.calls.filter((call) => call.call === "page");
      expect([paged.length, paged.at(-1)!.handed?.history === undefined, left()]).toEqual([pages + 1, true, 0]);
      const sealed = readHome(home.root, (read) => read.prepare("SELECT facts FROM deliveries WHERE source = ? ORDER BY sealed_ms").pluck().all(POLLED)) as string[];
      expect([sealed.length, sealed.filter((facts) => (JSON.parse(facts) as JsonObject).history === true).length]).toEqual([4, 2]);
    } finally {
      home.close();
    }
  });

  it("lets a poll under way when reread commits write its cursor, its memory or its clocks, or the next poll start from its cursor", async () => {
    const home = world("lifestream-connectors-inflight-");
    try {
      await home.begin("fake-reread", ["fetch"])!.end();
      const running = home.begin("fake-reread", ["fetch"])!;
      expect(running.cursor).toBe(canonical({ n: 1 }));
      await home.cli("connectors", "reread", "fake-reread");
      const reread = home.kept("fake-reread");
      expect(await running.end()).toBe("ok");
      expect(home.kept("fake-reread")).toEqual(reread);
      expect(reread).toMatchObject({ cursor: null, memory: [] });
      await home.drain("fake-reread");
      expect(home.calls.filter((call) => call.call === "fetch").at(-1)).toEqual({ call: "fetch", handed: null, listed: [] });
    } finally {
      home.close();
    }
  });

  it("lets reread lift a provider's back-off, turn a stream on or resume it", async () => {
    const home = world("lifestream-connectors-held-");
    try {
      await home.begin("fake-reread", ["fetch"])!.end();
      const until_ms = Date.now() + 3_600_000;
      home.db.commit((tx) => tx.tables.polls.put({ ...tx.tables.polls.get("fake-reread")!, held_ms: until_ms }));
      await home.cli("connectors", "pause", "fake-reread", "--reason", "a synthetic pause");
      await home.cli("connectors", "off", POLLED);
      await home.cli("connectors", "reread", "fake-reread");
      expect(home.kept("fake-reread")).toMatchObject({ cursor: null, clocks: { held_ms: until_ms } });
      expect(effective(home.root).settings.sources.off).toEqual([POLLED]);
      expect(readHome(home.root, (read) => read.prepare("SELECT target FROM controls").pluck().all())).toEqual(["pause:fake-reread"]);
      expect(home.begin("fake-reread")).toBeNull();
    } finally {
      home.close();
    }
  });

  it("shows a poll's last call without the words of its failure, when it ran or runs next, when it last read, or a source's newest delivery", async () => {
    const home = world("lifestream-connectors-show-");
    try {
      await home.begin("fake-reread", ["fetch"])!.end();
      home.script.fetch = () => {
        throw new Error("synthetic outage: the provider answered 503");
      };
      await home.begin("fake-reread", ["fetch"])!.end();
      await home.begin("fake-reread", ["fetch"])!.end();
      const { lines, answer } = await home.cli("connectors", "show", "fake-reread");
      const now = Date.now();
      const day = effective(home.root).settings.day;
      const ran = readHome(home.root, (read) => read.prepare("SELECT at_ms FROM attempts WHERE target = 'fetch:fake-reread' AND source = ?").pluck().get(POLLED)) as number;
      const row = home.kept("fake-reread").clocks!;
      const sealed = readHome(home.root, (read) => read.prepare("SELECT sealed_ms FROM deliveries WHERE source = ?").pluck().get(POLLED)) as number;
      const read = JSON.parse(readHome(home.root, (db) => db.prepare("SELECT value FROM meta WHERE key = 'poll-read:fake-reread'").pluck().get()) as string) as { call: string; at_ms: number };
      expect([read.call, read.at_ms >= sealed && read.at_ms <= ran]).toEqual(["fetch", true]);
      expect(lines.slice(-4)).toEqual([
        `poll fake-reread: ${row.next_ms <= now ? "its fetch is due now" : `its fetch runs next ${when(row.next_ms, now, day)}`}`,
        `  last read ${when(read.at_ms, now, day)} (a fetch)`,
        `  ${POLLED} fetch ${when(ran, now, day)}: failed, 2 in a row: Couldn’t read Notes (synthetic outage: the provider answered 503)`,
        `${POLLED} newest delivery ${when(sealed, now, day)}, sealed`,
      ]);
      expect(answer.polls).toEqual([{ acquirer: "fake-reread", next_ms: row.next_ms, held_ms: null, now: null, read, calls: [
        { call: "fetch", source: POLLED, at_ms: ran, outcome: "fail", reason: "failing", words: "Couldn’t read Notes", detail: "synthetic outage: the provider answered 503", fails: 2 },
      ] }]);
      artifact(home.root, "connectors-show", { lines, answer });
    } finally {
      home.close();
    }
  });

  it("answers Refresh now of a stream the home fetches none of without saying why", async () => {
    const home = world("lifestream-connectors-unfetched-");
    try {
      expect(await home.cli("connectors", "refresh", "fake-keyed")).toEqual({ lines: ["fake-keyed: set it up first"], answer: { state: "none" } });
    } finally {
      home.close();
    }
  });

  it("prints bare connectors' report as a JSON line without --json, or anything but the report alone with it, with no home running", async () => {
    const home = world("lifestream-connectors-json-");
    try {
      const bare = await home.printed("connectors");
      const json = await home.printed("connectors", "--json");
      const report = JSON.parse(json[0]!) as StreamsReport;
      expect([bare.filter((line) => line.startsWith("{")), json.length, typeof report.adding.prompt]).toEqual([[], 1, "string"]);
      expect(bare.slice(0, report.connectors.length).map((line, at) => line.startsWith(`${report.connectors[at]!.name}: `))).toEqual(report.connectors.map(() => true));
    } finally {
      home.close();
    }
  });

  it("lets reread on a running home land a new version of an unchanged item, or keep the poll's cursor", async () => {
    const root = makeRoot("lifestream-connectors-reread-live-", { sources: {} });
    roots.push(root);
    const log = join(root, "example-log.ndjson");
    writeFileSync(log, `${JSON.stringify({ id: "l-1", at: "2026-09-28T10:00:00.000Z", text: "the first line" })}\n${JSON.stringify({ id: "l-2", at: "2026-09-28T10:10:00.000Z", text: "the second line" })}\n`);
    cpSync(join(import.meta.dirname, "test", "proof", "example-log"), join(root, "connectors", "example-log"), { recursive: true });
    editSettings(root, { "connectors.example-log": { file: log } });
    const home: Home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: homeRegistryModule(), log: () => undefined });
    const sock = testSocket(root);
    const imported = () => readHome(root, (db) => db.prepare("SELECT d.id, r.counts FROM deliveries d JOIN runs r ON r.id = d.run WHERE d.source LIKE 'example-log:%' AND d.state = 'imported' ORDER BY d.sealed_ms").all()) as { id: string; counts: string }[];
    const versions = () => readHome(root, (db) => db.prepare("SELECT count(DISTINCT version) FROM statements WHERE source LIKE 'example-log:%'").pluck().get()) as number;
    try {
      await askHome(sock, "run", ["poll", "example-log"]);
      await until("the log's first fetch imported", () => imported().length === 1);
      expect([versions(), JSON.parse(readHome(root, (db) => db.prepare("SELECT state FROM poll_cursors WHERE acquirer = 'example-log'").pluck().get()) as string)]).toEqual([2, { read: 2 }]);
      expect(await askHome(sock, "connectors", ["reread", "example-log"])).toEqual({ reread: ["example-log"] });
      await until("the reread's fetch imported", () => imported().length === 2);
      const counts = JSON.parse(imported()[1]!.counts) as Record<string, number>;
      expect([versions(), counts.new, counts.changed]).toEqual([2, 0, 0]);
      artifact(root, "connectors-reread-live", { imported: imported() });
    } finally {
      await home.stop();
    }
  });
});

describe("a home folder's polls through its absence", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) removeRoot(root);
  });

  it("forgets a poll while its folder is away or refused, keeps a parked row in polls, polls again from nothing when it comes back, keeps a retired acquirer's or a dropped one's state, or writes a connectors/README.md naming a guide that is not there", async () => {
    const root = makeRoot("lifestream-connectors-away-", { sources: {} });
    roots.push(root);
    const log = join(root, "example-log.ndjson");
    writeFileSync(log, `${JSON.stringify({ id: "l-1", at: "2026-09-28T10:00:00.000Z", text: "the first line" })}\n${JSON.stringify({ id: "l-2", at: "2026-09-28T10:10:00.000Z", text: "the second line" })}\n`);
    const installed = join(root, "connectors", "example-log");
    const away = join(root, "example-log-away");
    cpSync(join(import.meta.dirname, "test", "proof", "example-log"), installed, { recursive: true });
    editSettings(root, { "connectors.example-log": { file: log } });
    const seeded = openHome(openHomeFolder(root), "migrate");
    seeded.commit((tx) => tx.tables.polls.leave("gone-lane", { source: "apple-notes:local:gone", state: canonical({ n: 1 }), start_ms: null, changes: { cleared: [], entries: [["seen", "item-1", "1"]] } }));
    seeded.close();
    const held = (acquirer: string) => readHome(root, (db) => ({
      cursor: (db.prepare("SELECT state FROM poll_cursors WHERE acquirer = ?").pluck().get(acquirer) as string | undefined) ?? null,
      memory: db.prepare("SELECT count(*) FROM poll_memory WHERE acquirer = ?").pluck().get(acquirer) as number,
      row: db.prepare("SELECT count(*) FROM polls WHERE acquirer = ?").pluck().get(acquirer) as number,
      parked: db.prepare("SELECT count(*) FROM meta WHERE key = ?").pluck().get(`poll-parked:${acquirer}`) as number,
      folder: (db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(`poll-folder:${acquirer}`) as string | undefined) ?? null,
    }));
    const deliveries = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE source LIKE 'example-log:%'").pluck().get()) as number;
    const fetchedAt = () => readHome(root, (db) => db.prepare("SELECT at_ms FROM attempts WHERE target = 'fetch:example-log'").pluck().get()) as number | undefined;
    const sock = testSocket(root);
    const started = async (): Promise<Home> => startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, registry: homeRegistryModule(), log: () => undefined });
    const polled = async (after: number) => {
      await askHome(sock, "run", ["poll", "example-log"]);
      await until("the log's fetch ended", () => (fetchedAt() ?? 0) > after);
    };

    let home = await started();
    try {
      await polled(0);
      await until("the log's first fetch imported", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE source LIKE 'example-log:%' AND state = 'imported'").pluck().get()) === 1);
      expect(held("example-log")).toEqual({ cursor: canonical({ read: 2 }), memory: 0, row: 1, parked: 0, folder: "example-log" });
      expect(held("gone-lane")).toEqual({ cursor: null, memory: 0, row: 0, parked: 0, folder: null });
      const readme = readFileSync(join(root, "connectors", "README.md"), "utf8");
      const guide = /the guide, (\S+)\.$/mu.exec(readme)?.[1];
      const command = /the command is (\S+)\.$/mu.exec(readme)?.[1];
      expect([guide?.endsWith(join("packages", "connect", "SKILL.md")), guide !== undefined && existsSync(guide), command !== undefined && existsSync(command)], readme).toEqual([true, true, true]);
      expect(readme).toContain("lifestream help connectors");
      expect(readme).not.toMatch(/`home /u);
    } finally {
      await home.stop();
    }
    const sealed = deliveries();
    const cursor = held("example-log").cursor;

    renameSync(installed, away);
    home = await started();
    try {
      expect(held("example-log")).toEqual({ cursor, memory: 0, row: 0, parked: 1, folder: "example-log" });
    } finally {
      await home.stop();
    }
    cpSync(away, installed, { recursive: true });
    writeFileSync(join(installed, "index.ts"), `throw new Error("a synthetic folder that does not load");\n`);
    home = await started();
    try {
      expect(readHome(root, (db) => db.prepare("SELECT count(*) FROM polls WHERE acquirer = 'example-log'").pluck().get())).toBe(0);
      expect(held("example-log")).toEqual({ cursor, memory: 0, row: 0, parked: 1, folder: "example-log" });
    } finally {
      await home.stop();
    }

    rmSync(installed, { recursive: true });
    cpSync(away, installed, { recursive: true });
    home = await started();
    try {
      expect(held("example-log")).toEqual({ cursor, memory: 0, row: 1, parked: 0, folder: "example-log" });
      await polled(fetchedAt() ?? 0);
      expect([deliveries(), held("example-log").cursor]).toEqual([sealed, cursor]);
    } finally {
      await home.stop();
    }

    for (const [file, from, to] of [["connector.ts", 'acquirers: ["example-log"]', 'acquirers: ["example-log-2"]'], ["index.ts", '{ "example-log": exampleLogAcquirer }', '{ "example-log-2": exampleLogAcquirer }'], ["acquirer.ts", 'name: "example-log",', 'name: "example-log-2",']] as const) {
      const text = readFileSync(join(installed, file), "utf8");
      expect(text, file).toContain(from);
      writeFileSync(join(installed, file), text.replace(from, to));
    }
    home = await started();
    try {
      expect(held("example-log")).toEqual({ cursor: null, memory: 0, row: 0, parked: 0, folder: null });
      expect(held("example-log-2")).toMatchObject({ row: 1, folder: "example-log" });
    } finally {
      await home.stop();
    }
  });
});

function makeRootOnce(roots: string[]): string {
  const root = makeRoot("lifestream-connectors-", { sources: {} });
  roots.push(root);
  return root;
}

const FAKES_CONNECTORS = (registry: Registry): string[] => registry.connectors.filter((each) => each.hidden !== true).map((each) => each.id);

describe("what a device is answered of the start", () => {
  it("every connector delivered to a device kind carries start_ms, its own start where it has one, the home's otherwise, and no member of the start beside it", () => {
    const connectors = declarations();
    const settings = { history: { start: "2026-05-19" }, connectors: { "apple-health": { start: "2019-01-01" }, "apple-photos": { start: "2026-05-19" } } };
    const now = Date.UTC(2026, 10, 19, 12);
    for (const [kind, unit] of [["mac", MAC], ["phone", PHONE]] as const) {
      const sources = connectors.flatMap((connector) => connector.sources.filter((source) => roadsOf(source).includes(kind))
        .map((source) => source.id.replace(/<[^>]+>/gu, (part) => (part === "<unit>" ? unit : "person-a@example.com"))));
      const delivered = new Set(sources.flatMap((source) => catalogOf(connectors).delivered(kind, source)?.id ?? []));
      const answered = deviceSettings(connectors, settings, kind, sources, now);
      expect([kind, Object.keys(answered).sort()]).toEqual([kind, [...delivered].sort()]);
      expect(delivered.size, kind).toBeGreaterThan(3);
      for (const [id, members] of Object.entries(answered)) {
        const start_ms = id === "apple-health" ? Date.UTC(2019, 0, 1) : Date.UTC(2026, 4, 19);
        expect([id, members.start_ms]).toEqual([id, start_ms]);
        expect([id, ["start", "reach", "floor_ms"].filter((member) => Object.hasOwn(members, member))]).toEqual([id, []]);
      }
    }
    expect(deviceSettings(connectors, { history: { start: "all" }, connectors: {} }, "phone", [`location:local:${PHONE}`], now)).toMatchObject({ location: { start_ms: null } });
  });
});
