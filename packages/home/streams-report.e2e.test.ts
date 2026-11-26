import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { HIDING_META } from "./copies.js";
import { afterAll, describe, expect, it } from "vitest";
import { admit, admittedNone, imports, vendorOf, declarations, Refused, type Connector, type HeldSite, type KindExport } from "@lifestreamprotocol/connect";
import { openLedger, type Abilities, type RunnerFile, type RunnerListing, type UseId } from "@lifestreamprotocol/model";
import { openHome, openHomeFolder, readTables, type DaySettings, type Guard, type Json, type JsonObject, type ReaderOutput } from "@lifestreamprotocol/core";
import { CAPTION_PROMPT, MESSAGES_FAMILY, TRANSCRIPT_PROMPT } from "@lifestreamprotocol/families";
import { readPrivacySettings } from "@lifestreamprotocol/privacy";
import { DAYS, FILES, HELD, IMPORT_OF, LISTING, type HeldImport, type KeptListing, type Tally } from "./imports.js";
import { installCommand } from "./command.js";
import { DISMISSED, readConnectors, refusedWords, type ConnectorsInput } from "./connectors.js";
import { chooseFor, openMade } from "./made.js";
import { restRefusal } from "./jobs.js";
import { ADDRESS_WINDOW, MENU } from "./models-read.js";
import { MODELS_META, readRouting, type ModelRoute } from "./models.js";
import { peopleFileOf } from "./people.js";
import { PEOPLE, writePrepared } from "./prepared.js";
import { homeRegistryModule } from "./programs.js";
import { mintPrincipal, revokePrincipal } from "./principals.js";
import { readProcessing } from "./processing.js";
import { families } from "./registry-home.js";
import { RELEASE_CLIENTS } from "./test/fed.js";
import { effective, planned, reset } from "./settings.js";
import type { MacImport, Stated, Statement } from "./stated.js";
import { dayWords, when } from "./stream-words.js";
import type { ConnectorReport, Need, Raised, StreamsReport } from "./streams-report.js";
import { photosComing, photosStart, readHistories, renderStatus, withLedger } from "./status.js";
import { PAGES } from "./pages.js";
import { streamsAnswer } from "./page-streams.js";
import { makeRoot, readHome, REPO, removeRoot } from "./test/harness-root.js";
import { doorHere } from "./test/harness-door.js";
import { statusOf } from "./test/harness-status.js";
import { deliveryLeft, heartbeatFacts, quietRun, statement, value } from "./test/through.js";
import { applyThrough, type Value } from "./through.js";
import { readOpsSettings } from "./verbs/context.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY_MS = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 28, 9, 30);
const DAY: DaySettings = { zone: "UTC", day_start_hour: 4 };
const FIXTURES = join(REPO, "homelink", "Tests", "Fixtures");
const FIXTURE = join(FIXTURES, "report.json");
const PHONE_FIXTURE = join(FIXTURES, "pages", "canned", "connectors.report.json");
const WRITE_FIXTURES = process.env.LIFESTREAM_FIXTURES === "write";

const ROUTE = { output: "text", tools: false, context_tokens: null, thinking: [], suggested: [], offered: true, runner: null, request: { effort: "low", sampling: null, timeout_ms: 120_000 } } as const;
const VISION: ModelRoute = {
  ...ROUTE, id: "openrouter:vendor-a/vision-1", transport: "openrouter", model: "vendor-a/vision-1", name: "Vision One", input: ["text", "image"], chat: "door",
  leaves: "OpenRouter", where: "Sent to OpenRouter", cost: "priced", state: "ready", line: null,
};
const PLAN_LINE = "Your Claude plan is used up · resets 14:00";
const PLAN: ModelRoute = {
  ...ROUTE, id: "claude:plan-model-1", transport: "claude", model: "plan-model-1", name: "Plan Model One", input: ["text", "image", "audio"], chat: "program",
  leaves: "Anthropic", where: "Sent to Anthropic", cost: "plan", state: "waiting", line: PLAN_LINE,
};
const RUNNER_UNIT = "runner-macbook-pro-0001";
const SEES: Abilities = { input: ["text", "image"], output: "text", tools: false, context_tokens: 4_000, thinking: [] };
const HEARS: Abilities = { input: ["audio"], output: "text", tools: false, context_tokens: null, thinking: [] };
const runnerFile = (id: string, name: string, abilities: Abilities, bytes: number, languages: string[], memory_gb: number, state: RunnerFile["state"], fetched_bytes = 0): RunnerFile =>
  ({ id, name, ...abilities, bytes, languages, memory_gb, state, fetched_bytes, failure: null });
const NEMOTRON_LANGUAGES = ["en", "es", "fr", "it", "pt", "nl", "de", "tr", "ru", "ar", "hi", "ja", "ko", "vi", "uk", "pl", "sv", "cs", "nb", "da", "bg", "fi", "hr", "sk", "zh", "hu", "ro", "et"];
const RUNNER: RunnerListing = {
  unit: RUNNER_UNIT, name: "MacBook Pro", version: "1", boot: "boot-1", slots: 1, power: "mains", idle_s: null, thermal: null, memory_gb: 16, running: [], present: true,
  files: [
    runnerFile("qwen3.5-4b", "Qwen 3.5", SEES, 3_973_305_013, [], 16, "ready"),
    runnerFile("parakeet-unified-en-0.6b", "Parakeet", HEARS, 731_357_568, ["en"], 8, "fetching", 300_000_000),
    runnerFile("nemotron-3.5-asr-0.6b", "Nemotron Speech", HEARS, 751_094_240, NEMOTRON_LANGUAGES, 8, "absent"),
  ],
};
const ON_RUNNER = {
  transport: "runner", suggested: [], offered: true, runner: { unit: RUNNER_UNIT, name: "MacBook Pro", battery: false }, leaves: null, where: "Stays on MacBook Pro", cost: "free",
  request: { effort: "none", sampling: null, timeout_ms: 300_000 },
} as const;
const onRunner = (file: RunnerFile) => ({ ...ON_RUNNER, id: `runner:${RUNNER_UNIT}/${file.id}`, model: file.id, name: file.name, chat: "door" as const,
  input: file.input, output: file.output, tools: file.tools, context_tokens: file.context_tokens, thinking: file.thinking });
const QWEN: ModelRoute = { ...onRunner(RUNNER.files[0]!), suggested: ["pictures"], state: "ready", line: null };
const PARAKEET: ModelRoute = { ...onRunner(RUNNER.files[1]!), state: "unavailable", line: "Downloading, 0.3 of 0.7 GB" };
const NEMOTRON: ModelRoute = { ...onRunner(RUNNER.files[2]!), state: "unavailable", line: "Not downloaded" };
const ROUTES = [VISION, PLAN, QWEN, PARAKEET, NEMOTRON];
const DEFAULTS = { "model.defaults.pictures": VISION.id, "model.defaults.audio": null, "model.defaults.text": null };
const chatFile = (n: number): string => `sha256:${String(n).padStart(64, "a")}`;

const MAC_A = "macbook-pro-0001";
const MAC_B = "macbook-air-bb07";
const PHONE = "iphone-17-pro-aa01";
const OLD_PHONE = "iphone-12-cc03";
const BROWSER = "chrome-dd04";


const chrome = (origin: string) => ({ origin, probe: null });
const release = (id: string): Connector => declarations().find((each) => each.id === id)!;
const signedAs = (id: string): Pick<Connector, "acquirers" | "fields" | "signin"> => {
  const { acquirers, fields, signin } = declarations().find((each) => each.id === id)!;
  return { acquirers: acquirers!, fields: fields!, signin: signin! };
};
const fromTakeout = (id: string): KindExport => release(id).export as KindExport;
const releaseWords = (id: string): Pick<Connector, "records" | "gives"> => {
  const { records, gives } = release(id);
  return { records, ...(gives === undefined ? {} : { gives }) };
};
const SYNTHETIC = [
  {
    id: "whatsapp", product: "whatsapp", name: "WhatsApp", vendor: "meta", type: "messages", noun: ["message", "messages"], ...releaseWords("whatsapp"),
    sources: [{ id: "whatsapp:<account>:<unit>", read: "whatsapp-mac", arrives: "mac" }, { id: "whatsapp:<account>:export", read: "whatsapp-export", arrives: "upload" }],
    fields: {
      groups_archived: { kind: "choice", home: true, label: "Archived groups are quiet", options: { on: "Yes", off: "No" }, default: "on",
        about: release("whatsapp").fields!.groups_archived!.about! },
      groups_quiet_after: { kind: "choice", home: true, label: "Quiet after", default: "90d", options: { "30d": "30 days", "90d": "90 days", never: "Never" },
        about: release("whatsapp").fields!.groups_quiet_after!.about! },
    },
    mac: { app: "WhatsApp", grants: ["fullDiskAccess"] },
    before: ["Install WhatsApp for Mac and link it to your phone."],
    processing: release("whatsapp").processing!,
  },
  {
    id: "gmail", product: "gmail", name: "Gmail", vendor: "google", type: "mail", noun: ["email", "emails"], ...releaseWords("gmail"),
    sources: [{ id: "gmail:<account>:cloud", read: "gmail-imap", arrives: "poll" }, { id: "gmail:<account>:export", read: "gmail-takeout", arrives: "upload" }],
    refresh: { default: "5m", min: "1m" }, ...signedAs("gmail"),
    export: fromTakeout("gmail"),
  },
  {
    id: "chatgpt", product: "chatgpt", name: "ChatGPT", vendor: "openai", type: "ai", noun: ["conversation", "conversations"], ...releaseWords("chatgpt"),
    sources: [{ id: "chatgpt:<account>:browser", read: "chatgpt-browser", arrives: "chrome" }],
    acquirers: ["chatgpt-browser"], refresh: { default: "1h", min: "15m" }, chrome: chrome("https://chatgpt.example.com"),
    backfill: { pace: { default: "1m" } },
  },
  {
    id: "claude", product: "claude", name: "Claude", vendor: "anthropic", type: "ai", noun: ["conversation", "conversations"], ...releaseWords("claude"),
    sources: [{ id: "claude:<account>:browser", read: "claude-browser", arrives: "chrome" }],
    acquirers: ["claude-browser"], refresh: { default: "1h", min: "15m" }, chrome: chrome("https://claude.example.com"),
  },
  {
    id: "google-takeout", product: "google-takeout", name: "Google activity", vendor: "google", type: "web", icon: "search", noun: ["item", "items"], records: "Your Takeout.",
    sources: [{ id: "google-takeout:<account>:export", read: "takeout", arrives: "upload" }],
  },
  {
    id: "google", product: "google-search", name: "Google Search", vendor: "google", type: "web", ...releaseWords("google"),
    products: { youtube: { name: "YouTube", vendor: "google" } },
    sources: [{ id: "google-search:<account>:export", read: "google-my-activity", arrives: "upload" }],
    export: fromTakeout("google"),
  },
  {
    id: "screen", product: "screen", name: "Screen", vendor: "lifestream", type: "device-activity", noun: ["frame", "frames"], ...releaseWords("screen"),
    sources: [{ id: "screen:local:<unit>", read: "screen-recorder", arrives: "mac" }], mac: { grants: ["screenRecording"], sensor: true },
    processing: release("screen").processing!,
    fields: {
      apps: { kind: "list", label: "Apps and sites", default: [], items: "modes" },
      idle_pause: { kind: "duration", label: "Idle timeout", default: "5m", min: "1m" },
    },
  },
  {
    id: "apple-photos", product: "apple-photos", name: "Photos", vendor: "apple", type: "photos", noun: ["photo", "photos"], counts: ["photo"], mirror: true, ...releaseWords("apple-photos"),
    sources: [{ id: "apple-photos:<account>:<unit>", read: "photos-mac", arrives: "mac" }, { id: "apple-photos:<account>:<unit>", read: "photos-ios", arrives: "phone" }],
    mac: { grants: ["photos"] }, phone: { grants: ["photos"] }, backfill: { about: release("apple-photos").backfill!.about! },
    refresh: { default: "5m", min: "1m", max: "5m" },
  },
  {
    id: "faces", product: "faces", name: "Faces", vendor: "lifestream", noun: ["photo", "photos"], ...releaseWords("faces"),
    sources: [{ id: "faces:local:labels", read: "face-engine", arrives: "label" }], label: { labeler: "face-engine", install: "Get the face models" },
    fields: { battery_backlog: { kind: "number", label: "Photos scanned on battery", default: 500, min: 0, max: 5_000,
      about: "With more photos than this waiting, faces are scanned only while the Mac is plugged in." } },
  },
  {
    id: "spotify", product: "spotify", name: "Spotify", vendor: "spotify", type: "listening", noun: ["play", "plays"], ...releaseWords("spotify"),
    sources: [{ id: "spotify:<account>:export", read: "spotify-export", arrives: "upload" }],
    export: { recognise: ["**/Streaming_History_*.json"], guide: [{ words: "Ask Spotify for your data, then download it.", open: { label: "Open Spotify", url: "https://spotify.example.com/privacy" } }] },
  },
  {
    id: "granola", product: "granola", name: "Granola", vendor: "granola", type: "notes", noun: ["meeting", "meetings"], ...releaseWords("granola"),
    sources: [{ id: "granola:<account>:cloud", read: "granola-api", arrives: "poll" }], refresh: { default: "1h" }, ...signedAs("granola"),
  },
  {
    id: "whoop", product: "whoop", name: "WHOOP", vendor: "whoop", type: "health", noun: ["reading", "readings"], ...releaseWords("whoop"),
    sources: [{ id: "whoop:<account>:cloud", read: "whoop-capture", arrives: "chrome", feeders: ["whoop"] }],
    acquirers: ["whoop"], refresh: { default: "1h" }, chrome: chrome("https://app.whoop.example"), fields: declarations().find((each) => each.id === "whoop")!.fields!,
  },
  {
    id: "github", product: "github", name: "GitHub", vendor: "microsoft", type: "code", noun: ["contribution", "contributions"], ...releaseWords("github"),
    sources: [{ id: "github:<account>:cloud", read: "github-api", arrives: "poll" }], acquirers: ["github-api"], refresh: { default: "5m", min: "1m" },
    fields: { login: { kind: "text", label: "GitHub login" }, token: { kind: "secret", label: "Access token", secret: "github" },
      clones: { kind: "path", label: "Clones folder", folder: true, default: "/Users/person-a/Code", about: "The folder your clones are in, on this Mac." } },
    signin: [{ acquirer: "github-api", label: "Token", way: "key", fields: ["token"] }],
  },
] as const satisfies readonly Connector[];
const PHONE_STREAMS = ["location", "motion", "apple-health", "apple-contacts", "screen-time", "checkin", "notes"];
const FROM_TAKEOUT = declarations().filter((each) => imports.importOf(each)?.kind === "google-takeout" && ![...SYNTHETIC.map((one) => one.id as string), ...PHONE_STREAMS].includes(each.id));
const DECLARED: readonly Connector[] = [...SYNTHETIC, ...PHONE_STREAMS.map((id) => declarations().find((each) => each.id === id)!), ...FROM_TAKEOUT];
const KINDS = ["message", "msg", "email", "conversation", "frame", "fix", "photo", "img-file", "reading", "contribution", "item", "motion", "sample", "contact", "usage", "report", "note", "event"];
const object: Guard = (content) => (typeof content === "object" && content !== null ? [] : ["not an object"]);
const GUARDS: Record<string, Guard> = Object.fromEntries(KINDS.map((kind) => [kind, object]));


const item = (kind: string, key: string, at_ms: number): ReaderOutput => ({ kind, key, content: { text: `synthetic ${key}` }, time: { start_ms: at_ms, precision: "ms" } });

const lostBlob = (at: number): string => `sha256:${String(at + 100).padStart(64, "0")}`;

function canned(prefix: string, settings: JsonObject = {}, now = NOW) {
  const root = makeRoot(prefix, { sources: {}, settings: { "day.zone": DAY.zone, "day.day_start_hour": DAY.day_start_hour, ...settings } });
  const home = openHome(openHomeFolder(root), "migrate");
  home.commit((tx) => {
    tx.tally.prune(DAY, now);
    tx.tally.complete();
  });
  const raw = new Database(join(root, "home.db"));
  const principals = openHomeFolder(root);
  let seed = 1;
  let delivered = 0;
  const passes = new Map<string, string>();
  const self = {
    root,
    source(id: string, read: string, options: JsonObject = {}) {
      home.commit((tx) => tx.tables.sources.add({ id, vendor: vendorOf(declarations(), id), connector: read, options, added_ms: now - 30 * DAY_MS }));
      return self;
    },
    land(source: string, rows: ReaderOutput[]) {
      const stated_ms = now - 10 * DAY_MS + delivered++;
      const run = home.commit((tx) => tx.tables.runs.start({ kind: "import", subject: `${source} landed`, started_ms: stated_ms }));
      home.commit((tx) => tx.records.land(run, { id: `${source}/landed-${delivered}`, source, stated_ms }, rows, GUARDS, { has: () => true }));
      return self;
    },
    delivery(source: string, sealed_ms: number, facts: JsonObject = {}, more: { state?: string; failures?: number; run?: number; lost?: Json; pass?: string; seal?: number; id?: string; refused?: number } = {}) {
      raw.prepare("INSERT INTO deliveries (id, source, sealed_ms, stated_ms, facts, state, run, failures, lost, pass, seal, refused) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        more.id ?? `${source}/d-${delivered++}`, source, sealed_ms, sealed_ms, JSON.stringify(facts), more.state ?? "imported", more.run ?? null, more.failures ?? 0,
        more.lost === undefined ? null : JSON.stringify(more.lost), more.pass ?? null, more.seal ?? null, more.refused ?? 0);
      home.commit((tx) => deliveryLeft(tx, source, facts, sealed_ms));
      return self;
    },
    stated(source: string, stated: Value, heard_ms: number) {
      home.commit((tx) => applyThrough(tx, source, statement(stated, {}, heard_ms), now));
      return self;
    },
    parked(acquirer: string) {
      raw.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(`poll-parked:${acquirer}`, JSON.stringify({ paged_ms: null }));
      return self;
    },
    attempt(target: string, source: string, outcome: string, reason: string | null, at: { since_ms: number; fails?: number; contact_ms?: number | null; facts?: JsonObject }) {
      raw.prepare("INSERT INTO attempts (target, source, outcome, reason, facts, detail, since_ms, at_ms, contact_ms, fails) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)").run(
        target, source, outcome, reason, JSON.stringify(at.facts ?? {}), at.since_ms, now, at.contact_ms === undefined ? at.since_ms : at.contact_ms, at.fails ?? (outcome === "fail" ? 1 : 0));
      return self;
    },
    poll(acquirer: string, more: { next_ms?: number; held_ms?: number | null; pages?: boolean; hand?: boolean } = {}) {
      raw.prepare("INSERT INTO polls (acquirer, next_ms, held_ms, pages, hand) VALUES (?, ?, ?, ?, ?)").run(
        acquirer, more.next_ms ?? now + 5 * MINUTE, more.held_ms ?? null, more.pages === true ? 1 : 0, more.hand === true ? 1 : 0);
      return self;
    },
    backfill(source: string, acquirer: string, left: number | null, start_ms: number | null = null, recent: { at_ms: number; left: number }[] = []) {
      raw.prepare("INSERT INTO backfills (source, acquirer, left, unit, start_ms, recent, last) VALUES (?, ?, ?, NULL, ?, ?, NULL)").run(source, acquirer, left, start_ms, JSON.stringify(recent));
      return self;
    },
    pause(target: string, reason: string, by: string, at_ms: number) {
      raw.prepare("INSERT INTO controls (target, reason, at_ms, by) VALUES (?, ?, ?, ?)").run(target, reason, at_ms, by);
      return self;
    },
    wanted(source: string, files: number, kind = "img-file") {
      const insert = raw.prepare("INSERT INTO wanted_blobs (blob, source, kind, key) VALUES (?, ?, ?, ?)");
      for (let at = 0; at < files; at++) insert.run(`sha256:${String(at).padStart(64, "0")}`, source, kind, `file-${at}`);
      return self;
    },
    lost(source: string, files: number, sealed_ms: number, first = 0) {
      const run = home.commit((tx) => tx.tables.runs.start({ kind: "import", subject: `${source} restored`, started_ms: sealed_ms }));
      for (let at = first; at < first + files; at++) {
        const [blob, key, version] = [lostBlob(at), `lost-${at}`, `sha256:${String(at + 50_000).padStart(64, "0")}`];
        raw.prepare("INSERT INTO statements (source, kind, key, version, stated_ms, run, origin, late) VALUES (?, 'item', ?, ?, ?, ?, 'source', 0)").run(source, key, version, sealed_ms, run);
        raw.prepare("INSERT INTO version_blobs (version, blob) VALUES (?, ?)").run(version, blob);
        raw.prepare("INSERT INTO wanted_blobs (blob, source, kind, key) VALUES (?, ?, 'item', ?)").run(blob, source, key);
      }
      const id = `${source}/lost-${delivered++}`;
      self.delivery(source, sealed_ms, {}, { id, state: "importing", run, lost: [{ items: files, what: "files cleared" }] });
      home.commit((tx) => tx.tables.deliveries.move(id, source, { move: "land", run, refused: 0, error: null, code: "sha256:code-1" }));
      return self;
    },
    arrived(blobs: readonly string[]) {
      home.commit((tx) => tx.records.blobsArrived(blobs, {}));
      return self;
    },
    dismiss(need: string, stamp: string) {
      raw.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(`${DISMISSED}${need}`, stamp);
      return self;
    },
    imports(held: Record<string, HeldImport>) {
      raw.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(HELD, JSON.stringify(held));
      return self;
    },
    meta(key: string, value: string) {
      raw.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(key, value);
      return self;
    },
    tallied(delivery: string, source: string, tally: Tally) {
      raw.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(`${DAYS}${delivery}|${source}`, JSON.stringify(tally));
      return self;
    },
    ran(subject: string, counts: JsonObject): number {
      return home.commit((tx) => {
        const run = tx.tables.runs.start({ kind: "import", subject, started_ms: now - 4 * DAY_MS });
        tx.tables.runs.end(run, { ended_ms: now - 4 * DAY_MS, outcome: "ok", counts: counts as never });
        return run;
      });
    },
    listed(delivery: string, listing: KeptListing) {
      raw.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(`${LISTING}${delivery}`, JSON.stringify(listing));
      return self;
    },
    device(unit: string, model: string) {
      raw.prepare("INSERT INTO devices (unit, model, added_ms) VALUES (?, ?, ?)").run(unit, model, now - 60 * DAY_MS);
      return self;
    },
    pass(unit: string, kind: "mac" | "phone" | "extension", sources: readonly string[] = [], minted_ms = now - 30 * DAY_MS) {
      const minted = mintPrincipal(principals, { unit, kind, scopes: kind === "extension" ? ["station"] : ["deliver"], sources, now_ms: minted_ms },
        (bytes) => Buffer.alloc(bytes, seed++));
      passes.set(unit, minted.principal.id);
      return self;
    },
    revoke(unit: string) {
      revokePrincipal(principals, passes.get(unit)!, now - 9 * DAY_MS);
      return self;
    },
    passOf: (unit: string): string => passes.get(unit)!,
    machine: join(root, "machine"),
    quiet(counts: Record<string, number>) {
      writePrepared(openHomeFolder(root), peopleFileOf(root, self.machine), PEOPLE, { rows: new Map([["answer", new Map([["quiet", counts]])]]), position: "1" });
      return self;
    },
    models(routes: readonly ModelRoute[], runners: readonly RunnerListing[] = []) {
      raw.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(MODELS_META, JSON.stringify({ routes, runners: runners.map((runner) => ({ ...runner, below: null })), connections: {} }));
      return self;
    },
    asks(work_id: string, prompt: string, rows: { item: string; at_ms: number; state?: "pending" | "given-up" | "done"; content?: Json; reply_key?: string }[]) {
      home.commit((tx) => {
        for (const row of rows) {
          const state = row.state ?? "pending";
          const input_hash = `sha256:${row.item.slice(-64)}`;
          tx.tables.asks.put({
            family: MESSAGES_FAMILY, item: row.item, prompt, version: 1, input_hash, unit: `whatsapp-unit-${row.at_ms}`, work_id,
            at_key: row.at_ms, started: false, waits: null, retry_ms: null, given_up: state === "given-up" ? VISION.id : null, unhideable: null, state,
          });
          if (state === "pending") continue;
          tx.derived.enrichments.put({
            family: MESSAGES_FAMILY, item: row.item, prompt, input_hash, reply_key: row.reply_key ?? null, reused_from: null,
            content: state === "done" ? row.content ?? null : null, state,
          });
        }
      });
      return self;
    },
    replied(route: ModelRoute, prompt: string, count: number, usd: number) {
      const ledger = openLedger(openHomeFolder(root), { mode: "migrate" });
      const at = now - 5 * MINUTE;
      try {
        for (let n = 0; n < count; n++) {
          const key = `${route.id}/${prompt}/reply-${n}`;
          ledger.request({
            key, family: MESSAGES_FAMILY, unit: `synthetic-item-${n}`, revision: key, model: route.model, effort: "low", prompt: { name: prompt, version: 1, text: `synthetic prompt ${prompt}`, type: "text" },
            input_hash: `sha256:input-${n}`, body: "{}", attachments: [],
          }, at);
          const begun = ledger.beginAttempt(key, at, route.transport);
          if (!("attempt" in begun)) throw new Error(`the ledger began no attempt of ${key}`);
          ledger.land(begun.attempt, { text: "synthetic reply", model: route.model, transport: route.transport, cost: usd }, at);
        }
      } finally {
        ledger.close();
      }
      return self;
    },
    done() {
      raw.close();
      home.close();
      return self;
    },
  };
  return self;
}

function emptyMachine(root: string): string {
  const dir = join(root, "report-machine");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function reportOf(root: string, more: Partial<Omit<ConnectorsInput, "registry">> & { chosen?: readonly string[]; connectors?: readonly Connector[] } = {}, now = NOW): StreamsReport {
  const db = new Database(join(root, "home.db"), { readonly: true, fileMustExist: true });
  const { chosen = [], connectors = DECLARED, ...door } = more;
  try {
    return withLedger(openHomeFolder(root), (ledger) => readConnectors(db, {
      folder: openHomeFolder(root), now_ms: now, settings: { ...effective(root).settings, sites: { chosen: [...chosen] } } as ConnectorsInput["settings"], registry: { connectors, families: familiesOf(root), clients: RELEASE_CLIENTS }, machine: emptyMachine(root),
      sites: null, present: [], needs: [], free_bytes: 400_000_000_000, ledger, photos: photosComing(db, photosStart(effective(root).settings, connectors, now)), ...door,
    }));
  } finally {
    db.close();
  }
}

const familiesOf = (root: string) => families(effective(root).settings, root);

function typedNote(root: string, day: string, blocks: Readonly<Record<string, JsonObject>> = {}): string | null {
  const db = new Database(join(root, "home.db"), { readonly: true });
  try {
    const [settings, families] = [readOpsSettings(root), familiesOf(root)];
    return withLedger(openHomeFolder(root), (ledger) => db.transaction(() => readProcessing(readTables(db), ledger!.rates(NOW), {
      connectors: DECLARED, families, blocks, defaults: { pictures: VISION.id, audio: null, text: null }, runners: {}, day: DAY, now_ms: NOW, typed: day,
      histories: readHistories(db, { folder: openHomeFolder(root), now_ms: NOW, settings, connectors: DECLARED, families, ledger: null }), privacy: settings.privacy,
    }).get("whatsapp")!.typed)());
  } finally {
    db.close();
  }
}

const connectorOf = (report: StreamsReport, id: string): ConnectorReport => report.connectors.find((each) => each.id === id)!;
const healthOf = ({ state, reason }: { state: string; reason: string | null }) => [state, reason];
const needIds = (needs: readonly Need[]) => needs.map((need) => need.id);
const nb = (words: string): string => words.replace(/(\d) (?=\p{L})/gu, "$1\u00a0");
const said = (pass: string, grants: Statement["grants"], heard_ms: number, found: string[] | null = null, held: MacImport[] | null = null): Statement =>
  ({ pass, grants, found, imports: held, settings: null, sending: {}, room: null, network: null, recorder: null, stores: null, heard_ms, waiting_since_ms: null });
const macFile = (id: string, name: string, bytes: number, state: MacImport["files"][number]["state"], why: MacImport["files"][number]["why"] = null, more: { sha256?: string; seal?: number; pass?: string; sent_bytes?: number } = {}) =>
  ({ id, name, bytes, state, why, sha256: more.sha256 ?? null, seal: more.seal ?? null, pass: more.pass ?? null, sent_bytes: more.sent_bytes ?? null });
const TAKEOUT_MAC: MacImport = {
  kind: "google-takeout", files: [
    macFile("file-01", "takeout-20261004T080000Z-1-001.zip", 2_000_000_000, "waiting", "battery"),
    macFile("file-02", "takeout-20261004T080000Z-2-001.zip", 1_000_000_000, "sending", null, { sent_bytes: 250_000_000 }),
    macFile("file-03", "takeout-20261004T080000Z-3-001.zip", 1_000_000, "sent"),
    macFile("file-04", "notes.zip", 8_192, "refused", "not-this-kind"),
    macFile("file-05", "takeout-20261003T080000Z-1-001.zip", 3_000_000_000, "missing"),
  ],
};
const site = (origin: string): Pick<HeldSite, "origin" | "checking" | "choosing" | "stations"> =>
  ({ origin, checking: false, choosing: null, stations: [{ unit: BROWSER, signed_in: true, account: null }] });


describe("the streams report", () => {
  const roots: string[] = [];
  const summary: Record<string, unknown> = {};
  afterAll(() => {
    mkdirSync(join(REPO, "packages", "home", ".build", "e2e"), { recursive: true });
    writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "streams-report.json"), `${JSON.stringify(summary, null, 2)}\n`);
    for (const root of roots) removeRoot(root);
  });
  const home = (prefix: string, settings: JsonObject = {}, now = NOW) => {
    const made = canned(prefix, settings, now);
    roots.push(made.root);
    return made;
  };

  it("every state, every reason family, needs and devices: the fixture the clients decode is this report", () => {
    const at = home("lifestream-report-every-", {
      "connectors.gmail": { account: "person-a@example.com", route: "gmail-imap" },
      "connectors.github": { login: "person-a", route: "github-api" },
      "connectors.whoop": { email: "person-a@example.com" },
      "sources.off": ["spotify", "spotify:person-a:export"], "helpers": 4, ...DEFAULTS,
    });
    for (const key of ["door.port", "door.lan_port", "model.cap"]) reset(at.root, key);
    const WHATSAPP = `whatsapp:+15550000001:${MAC_B}`;
    const GMAIL = "gmail:person-a@example.com:cloud";
    const CHATGPT = "chatgpt:person-a@example.com:browser";
    const CLAUDE_A = "claude:person-a@example.com:browser";
    const CLAUDE_C = "claude:person-c@example.com:browser";
    const TAKEOUT = "google-takeout:person-a@example.com:export";
    const SCREEN = `screen:local:${MAC_A}`;
    const LOCATION = `location:local:${PHONE}`;
    const PHOTOS_MAC = `apple-photos:person-a@example.com:${MAC_B}`;
    const PHOTOS_PHONE = `apple-photos:person-a@example.com:${PHONE}`;
    const FACES = "faces:local:labels";
    const WHOOP = "whoop:10000001:cloud";
    const GITHUB = "github:person-a:cloud";
    const PHONE_COPIES = [
      [`motion:local:${PHONE}`, "motion-ios-bundle", "motion"], ["apple-health:person-a@example.com:cloud", "health-ios-bundle", "sample"],
      [`apple-contacts:person-a@example.com:${PHONE}`, "contacts-ios-bundle", "contact"], [`screen-time:local:${PHONE}`, "usage-ios-bundle", "usage"],
      [`checkin:local:${PHONE}`, "checkin-ios-bundle", "report"], [`notes:local:${PHONE}`, "notes-ios-bundle", "note"],
    ] as const;
    at.device(MAC_A, "MacBook Pro").device(MAC_B, "MacBook Air").device(PHONE, "iPhone 17 Pro").device(OLD_PHONE, "iPhone 12").device(BROWSER, "Chrome")
      .pass(MAC_A, "mac", [SCREEN]).pass(MAC_B, "mac", [WHATSAPP, PHOTOS_MAC]).pass(PHONE, "phone", [LOCATION, PHOTOS_PHONE, ...PHONE_COPIES.map(([copy]) => copy)])
      .pass(OLD_PHONE, "phone", [`location:local:${OLD_PHONE}`]).revoke(OLD_PHONE)
      .pass(BROWSER, "extension");
    const replacedMac = at.passOf(MAC_A);
    at.pass(MAC_A, "mac", [SCREEN], NOW - 2 * DAY_MS);
    at.source(WHATSAPP, "whatsapp-mac").land(WHATSAPP, [item("message", "w1", NOW - 30 * MINUTE), item("message", "w2", NOW - 2 * HOUR), item("message", "w3", NOW - 5 * HOUR)]);
    at.delivery(WHATSAPP, NOW - 2 * MINUTE, { left: 0 }).quiet({ whatsapp: 4 });
    at.models(ROUTES, [RUNNER]).replied(VISION, CAPTION_PROMPT, 20, 0.6)
      .asks("whatsapp/photos", CAPTION_PROMPT, [
        { item: chatFile(1), at_ms: NOW - HOUR }, { item: chatFile(2), at_ms: NOW - 40 * DAY_MS }, { item: chatFile(3), at_ms: NOW - 400 * DAY_MS },
        { item: chatFile(4), at_ms: NOW - 2 * HOUR, state: "given-up" },
      ])
      .asks("whatsapp/voice", TRANSCRIPT_PROMPT, [{ item: chatFile(5), at_ms: NOW - 3 * HOUR }]);
    at.source(GMAIL, "gmail-imap").land(GMAIL, [item("email", "g1", NOW - DAY_MS), item("email", "g2", NOW - DAY_MS - HOUR)]);
    at.poll("gmail-imap", { held_ms: NOW + 20 * HOUR }).attempt("fetch:gmail-imap", GMAIL, "wait", "provider-limit", { since_ms: NOW - 30 * MINUTE });
    at.source(CHATGPT, "chatgpt-browser").land(CHATGPT, [item("conversation", "c1", NOW - 2 * DAY_MS)]);
    at.poll("chatgpt-browser", { pages: true }).backfill(CHATGPT, "chatgpt-browser", 1_750, null, [{ at_ms: NOW - 2 * MINUTE, left: 1_764 }, { at_ms: NOW - MINUTE, left: 1_757 }, { at_ms: NOW, left: 1_750 }]).attempt("fetch:chatgpt-browser", CHATGPT, "ok", null, { since_ms: NOW - MINUTE });
    at.source(CLAUDE_A, "claude-browser", { lane: "claude-browser" }).source(CLAUDE_C, "claude-browser", { lane: "claude-browser" })
      .land(CLAUDE_C, [item("conversation", "k1", NOW - 3 * HOUR)]).poll("claude-browser")
      .attempt("fetch:claude-browser", CLAUDE_A, "need", "other-account", { since_ms: NOW - 2 * HOUR, facts: { account: { id: "person-b@example.com", email: "person-b@example.com" } } })
      .attempt("fetch:claude-browser", CLAUDE_C, "ok", null, { since_ms: NOW - 2 * HOUR });
    at.source(TAKEOUT, "takeout").land(TAKEOUT, [item("item", "t1", NOW - 400 * DAY_MS)]).lost(TAKEOUT, 3, NOW - 2 * DAY_MS)
      .pause("pause:google-takeout", "the Takeout is read again after the deploy", "terminal", NOW - 2 * DAY_MS);
    at.source(SCREEN, "screen-recorder").land(SCREEN, [item("frame", "f1", NOW - 3 * HOUR)]).delivery(SCREEN, NOW - 3 * HOUR, {}, { pass: at.passOf(MAC_A), seal: 1 });
    for (const [copy, read, kind] of PHONE_COPIES) at.source(copy, read).land(copy, [item(kind, `${kind}-1`, NOW - 2 * HOUR)]).delivery(copy, NOW - 5 * MINUTE, { left: 0, start_ms: null });
    at.source(LOCATION, "location-ios-bundle").land(LOCATION, [item("fix", "p1", NOW - 14 * DAY_MS)]).delivery(LOCATION, NOW - MINUTE, { left: 0 });
    for (const [copy, read] of [[PHOTOS_MAC, "photos-mac"], [PHOTOS_PHONE, "photos-ios"]] as const) {
      at.source(copy, read).land(copy, Array.from({ length: 5 }, (_, index) => item("photo", `ph${index}`, NOW - (index + 1) * HOUR))).delivery(copy, NOW - 3 * MINUTE, { left: 0, start_ms: null });
    }
    at.source(FACES, "face-engine").delivery(FACES, NOW - HOUR, { owed: 120 }).attempt("label:face-engine", "", "wait", "power", { since_ms: NOW - 10 * MINUTE, contact_ms: null });
    const SPOTIFY = "spotify:person-a:export";
    const [IN_SPOTIFY, SPOTIFY_DELIVERY, SPOTIFY_FILE] = ["a000000000000011", "upload/spotify-0001", "my_spotify_data.zip"];
    at.source(SPOTIFY, "spotify-export").delivery(SPOTIFY, NOW - 5 * DAY_MS, { import: { kind: "spotify" } }, { id: SPOTIFY_DELIVERY })
      .listed(SPOTIFY_DELIVERY, { kind: "spotify", hash: "synthetic", files: [{ path: SPOTIFY_FILE, bytes: 4_096 }],
        products: [{ id: "spotify", name: "Spotify", reads: true, files: [SPOTIFY_FILE], unclaimed: 0, activity: null }],
        routes: [{ of: "spotify", members: "**/Streaming_History_*.json", product: "spotify", copy: "export", connector: "spotify", files: [SPOTIFY_FILE] }] })
      .tallied(SPOTIFY_DELIVERY, SPOTIFY, { days: { "2026-09-01": 3 }, kinds: { play: 3 } })
      .meta(`consumed:${SPOTIFY_DELIVERY}|${SPOTIFY}`, JSON.stringify([SPOTIFY_FILE]))
      .meta(`import:${IN_SPOTIFY}:span`, JSON.stringify({ from: "2014-03-02", to: "2026-09-01" }))
      .meta(`import:${IN_SPOTIFY}:open_day`, "2026-09-01");
    const [ASKED_SPOTIFY, ASKED_DELIVERY] = ["a000000000000012", "upload/spotify-0002"];
    at.listed(ASKED_DELIVERY, { kind: "spotify", hash: "synthetic", files: [{ path: SPOTIFY_FILE, bytes: 2_048 }],
      products: [{ id: "spotify", name: "Spotify", reads: true, files: [SPOTIFY_FILE], unclaimed: 0, activity: null }],
      routes: [{ of: "spotify", members: "**/Streaming_History_*.json", product: "spotify", copy: "export", connector: "spotify", files: [SPOTIFY_FILE] }] });
    const [ASKED_PHONE, BACKUP_DELIVERY, CALLS_FILE] = ["a000000000000013", "upload/iphone-backup-0001", "apple-calls/callhistory.sqlite"];
    const BACKUP_PHONE = { device: "0000000000000000000000000000000000000001", accounts: ["person-a@example.com"], model: "iPhone18,1", model_name: "iPhone 17 Pro", serial4: null };
    at.listed(BACKUP_DELIVERY, { kind: "iphone-backup", hash: "synthetic", files: [{ path: CALLS_FILE, bytes: 8_192 }],
      products: [{ id: "apple-calls", name: "Calls", reads: true, files: [CALLS_FILE], unclaimed: 0, activity: null }],
      routes: [{ of: "apple-calls", members: "**/apple-calls/callhistory.sqlite", product: "apple-calls", copy: "<unit>", connector: "apple-calls", files: [CALLS_FILE] }] });
    at.source(WHOOP, "whoop-capture", { email: "person-a@example.com" }).land(WHOOP, [item("reading", "r1", NOW - 6 * DAY_MS)]).poll("whoop")
      .attempt("fetch:whoop", WHOOP, "need", "password", { since_ms: NOW - 3 * HOUR, facts: { site: "id.whoop.example", secret: "lifestream-whoop-password", company: "WHOOP", use: "sign-in" } });
    at.source(GITHUB, "github-api").land(GITHUB, [item("contribution", "gh1", NOW - 3 * DAY_MS)]).poll("github-api")
      .attempt("fetch:github-api", GITHUB, "fail", "failing", { since_ms: NOW - 2 * HOUR, fails: 5 });
    const YOUTUBE = "youtube:person-a@example.com:export";
    const [STOPPED, REFUSING] = ["a000000000000001", "a000000000000002"];
    const [ZIP1, ZIP2, ZIP3] = ["takeout-20261027T080000Z-1-001.zip", "takeout-20261020T080000Z-1-001.zip", "takeout-20261020T080000Z-2-001.zip"];
    const youtube = (files: string[]) => ({ of: "my-activity", members: "Takeout/My Activity/YouTube/**", folder: "My Activity", product: "youtube", copy: "export", connector: "youtube-takeout", files });
    const activity = (files: string[]) => ({ id: "my-activity", name: "My Activity", reads: true, files, unclaimed: 0, activity: "json" as const });
    at.source(YOUTUBE, "youtube-takeout").delivery(YOUTUBE, NOW - DAY_MS, { import: { kind: "google-takeout" } }, { state: "failed", failures: 2, id: "upload/takeout-0001" })
      .imports({
        [STOPPED]: { kind: "google-takeout", account: "person-a@example.com", stamp: "20261027T080000Z", time_ms: Date.parse("2026-10-27T08:00:00Z"), at_ms: NOW - DAY_MS, deliveries: ["upload/takeout-0001"] },
        [REFUSING]: { kind: "google-takeout", account: "person-a@example.com", stamp: "20261020T080000Z", time_ms: Date.parse("2026-10-20T08:00:00Z"), at_ms: NOW - 2 * DAY_MS, deliveries: ["upload/takeout-0002"] },
        [IN_SPOTIFY]: { kind: "spotify", account: "person-a", stamp: null, time_ms: Date.parse("2026-09-02T08:00:00Z"), at_ms: NOW - 5 * DAY_MS, deliveries: [SPOTIFY_DELIVERY] },
        [ASKED_SPOTIFY]: { kind: "spotify", account: null, stamp: null, time_ms: null, at_ms: NOW - 3 * HOUR, deliveries: [ASKED_DELIVERY] },
        [ASKED_PHONE]: { kind: "iphone-backup", account: "person-a@example.com", stamp: null, time_ms: Date.parse("2026-10-28T08:00:00Z"), at_ms: NOW - 4 * HOUR,
          device: BACKUP_PHONE, unit: null, deliveries: [BACKUP_DELIVERY] },
      })
      .listed("upload/takeout-0001", { kind: "google-takeout", hash: "synthetic", files: [{ path: ZIP1, bytes: 4_096 }], products: [activity([ZIP1])], routes: [youtube([ZIP1])] })
      .listed("upload/takeout-0002", { kind: "google-takeout", hash: "synthetic", files: [{ path: ZIP2, bytes: 2_048, refused: "not a zip archive" }, { path: ZIP3, bytes: 4_096 }], products: [activity([ZIP3])], routes: [youtube([ZIP3])] })
      .delivery(YOUTUBE, NOW - 2 * DAY_MS, { import: { kind: "google-takeout" } }, { id: "upload/takeout-0002", refused: 1 });
    at.done();
    const stated: Stated = {
      [MAC_B]: { ...said(at.passOf(MAC_B), { fullDiskAccess: "on", photos: "on" }, NOW - 2 * MINUTE, ["apple-photos", "screen", "whatsapp"], [TAKEOUT_MAC]),
        settings: { "apple-photos": { refresh: "5m", start_ms: null } } },
      [PHONE]: said(at.passOf(PHONE), { location: "on", photos: "off", motion: "on", health: "on", contacts: "on", "screen-time": "on", notifications: "on" }, NOW - 5 * MINUTE),
    } as Stated;
    const disk: Raised = { id: "disk", state: "needs-you", reason: null, words: "Lifestream's disk fills in about 21 days", since_ms: null, next_ms: null, acts: [{ do: "storage", label: "Free up space" }], detail: null, connector: null, copy: null, unit: null, at: null };
    const person = join(at.root, "person");
    installCommand({ machine: { dir: at.machine, user: person }, shell: "/bin/zsh", env: () => `PATH=${join(person, ".local", "bin")}:/usr/bin\n` });
    const report = reportOf(at.root, {
      stated, present: [BROWSER], needs: [disk], chosen: ["chatgpt", "claude", "whoop"], machine: at.machine, connectors: [...DECLARED, release("apple-calls")],
      sites: [{ ...site("https://chatgpt.example.com"), stations: [{ unit: BROWSER, signed_in: true, account: { email: "person-a@example.com", verdict: "read" } }] },
        site("https://claude.example.com"), { ...site("https://app.whoop.example"), stations: [{ unit: BROWSER, signed_in: false, account: null }] }],
    });
    const states = Object.fromEntries(report.connectors.map((each) => [each.id, healthOf(each.health)]));
    summary.every = { states, lines: Object.fromEntries(report.connectors.map((each) => [each.id, each.line])), needs: needIds(report.needs), devices: report.devices.map((each) => [each.unit, each.health.words]) };
    expect(states).toEqual({
      whatsapp: ["ok", null], gmail: ["waiting", "provider-limit"], chatgpt: ["syncing", null], claude: ["needs-you", "other-account"],
      google: ["setup", "export"], "google-takeout": ["paused", null], screen: ["quiet", "device"], location: ["quiet", "nothing-new"], "apple-photos": ["ok", null],
      faces: ["waiting", "power"], spotify: ["off", null], granola: ["setup", "sign-in"], whoop: ["needs-you", "password"], github: ["broken", "failing"],
      motion: ["ok", null], "apple-health": ["ok", null], "apple-contacts": ["ok", null], "screen-time": ["ok", null], checkin: ["ok", null], notes: ["ok", null],
      "google-calendar": ["setup", "sign-in"], "google-photos": ["setup", "export"], "apple-calls": ["setup", "app"],
    });
    expect(connectorOf(report, "whatsapp").quiet).toBe(4);
    expect(connectorOf(report, "whoop").copies.map((copy) => [copy.id, copy.name])).toEqual([[WHOOP, "person-a@example.com"]]);
    expect(connectorOf(report, "github").members.filter((each) => each.folder === true).map((each) => [each.key, each.words, each.where !== null]))
      .toEqual([["clones", "Code", true]]);
    const precision = connectorOf(report, "location").members.find((each) => each.key === "precision");
    expect(JSON.stringify(precision)).toContain('"battery"');
    expect(connectorOf(report, "apple-photos").members.map((each) => [each.key, each.panel, each.only])).toEqual([["refresh", "settings", "On MacBook Air"], ["start", "backfill", undefined]]);
    expect(report.connectors.filter((each) => each.phone_screen !== null).sort((one, other) => one.phone_screen! - other.phone_screen!)
      .map((each) => [each.id, each.phone_screen])).toEqual([["location", 0], ["motion", 1], ["apple-health", 2], ["apple-photos", 3], ["apple-contacts", 4], ["screen-time", 5]]);
    expect([connectorOf(report, "checkin").phone_screen, connectorOf(report, "notes").phone_screen, connectorOf(report, "whatsapp").phone_screen]).toEqual([null, null, null]);
    expect(connectorOf(report, "apple-photos").ways.find((way) => way.road === "phone")).toMatchObject({ ready: false, requirements: [{ kind: "pair", met: true }, { kind: "grant", met: false, words: "Allow Photos on iPhone 17 Pro" }] });
    expect(Object.fromEntries(report.connectors.map((each) => [each.id, each.line]))).toMatchObject({
      whatsapp: nb("3 messages today"), gmail: "Gmail allows more tomorrow", chatgpt: "back to Oct 2026",
      claude: "Another Claude account", screen: `Nothing from MacBook Pro since ${when(NOW - 3 * HOUR, NOW, DAY)}`,
      location: `Nothing new since ${when(NOW - 14 * DAY_MS, NOW, DAY)}`, "apple-photos": nb("5 photos today"), faces: "Waiting for power", spotify: "Disconnected",
      granola: "Sign in to Granola", whoop: "Type your WHOOP password", github: "Couldn’t read GitHub",
    });
    expect(connectorOf(report, "google-takeout").line).toMatch(/^Paused since .* · Couldn't read 3\u00a0files$/u);
    expect(connectorOf(report, "chatgpt").history).toMatchObject({ state: "syncing", left: 1_750, eta_ms: NOW + 15_000_000, arriving: nb("Back to Oct 2026 · 1,750 conversations left") });
    expect(connectorOf(report, "faces").health.acts).toEqual([{ do: "try", label: "Scan now", need: "label:face-engine" }]);
    expect(connectorOf(report, "faces").ways).toEqual([{ road: "label", ready: true, requirements: [{ kind: "install", met: true, words: "Installed", line: null, act: null }] }]);
    expect(needIds(report.needs)).toEqual([
      "fetch:claude-browser:claude:person-a@example.com:browser", "lost:google-takeout:person-a@example.com:export", "grant:photos:iphone-17-pro-aa01",
      "fetch:github-api:github:person-a:cloud",
      "password:lifestream-whoop-password", "pair:iphone-12-cc03",
      "job:import:youtube:person-a@example.com:export", `import:${REFUSING}:refused`, `import:${ASKED_SPOTIFY}:whose`, `import:${ASKED_PHONE}:which`, "disk",
    ].sort((a, b) => order(report, a) - order(report, b)));
    const backup = report.imports.find((each) => each.kind === "iphone-backup")!;
    expect([backup.lists, backup.which!.map((each) => [each.need, each.imports, each.choices.map((choice) => choice.unit)])])
      .toEqual(["backups", [[`import:${ASKED_PHONE}:which`, [ASKED_PHONE], [PHONE, OLD_PHONE, "new"]]]]);
    expect(report.needs.filter((need) => need.connector === "google-takeout" && need.copy !== "google-takeout:person-a@example.com:export")).toEqual([
      { id: "job:import:youtube:person-a@example.com:export", state: "broken", reason: "import", words: "Couldn’t import YouTube", line: "From your Google Takeout",
        since_ms: NOW - DAY_MS, next_ms: null, acts: [{ do: "skip", label: "Skip it", need: "job:import:youtube:person-a@example.com:export" }], detail: null,
        connector: "google-takeout", copy: "youtube:person-a@example.com:export", unit: null, at: null, weight: "stopped", banner: false, dismissed: false, kind: "notice", about: null },
      { id: `import:${REFUSING}:refused`, state: "needs-you", reason: "import", words: nb("Couldn't read 1 file"), line: "From your Google Takeout",
        since_ms: null, next_ms: null, acts: [{ do: "skip", label: "Skip it", need: `import:${REFUSING}:refused` }], detail: null, connector: "google-takeout", copy: null, unit: null, at: null, weight: "advice", banner: false, dismissed: false, kind: "notice", about: null },
    ]);
    const takeout = report.imports.find((each) => each.kind === "google-takeout")!;
    const letGo = (file: string) => [{ do: "let-go", label: "Remove file", need: `import:${REFUSING}:file:${file}` }];
    const [refusedFile, refusingFile] = takeout.held[1]!.files.map((file) => file.id);
    expect(takeout).toMatchObject({
      takes: "Google takes minutes, or hours with photos", reads: null, root: "Takeout/",
      products: [{ id: "mail", name: "Gmail" }, { id: "my-activity", name: "Google Search" }, { id: "contacts", name: "Contacts" }, { id: "calendar", name: "Google Calendar" }, { id: "google-photos", name: "Google Photos" }],
      coming: [
        { id: "file-01", state: "waiting", words: "Waiting", line: "plug in your Mac" },
        { id: "file-02", state: "sending", words: "Sending", line: `250\u00a0MB of 1.0\u00a0GB` },
        { id: "file-03", state: "sent", words: "Imported" },
        { id: "file-04", state: "refused", words: "This isn’t a Google Takeout", line: "Choose the zip Google emailed you" },
        { id: "file-05", state: "missing", words: "Can't find it", line: "Choose it again" },
      ],
      held: [{ id: STOPPED, health: { state: "broken", reason: "import", words: "Couldn’t import YouTube" } }, {
        id: REFUSING, name: "20 Oct 2026 · person-a@example.com", made_at: "2026-10-20T08:00:00.000Z", files: [
          { name: ZIP2, state: "kept", words: "Kept", line: "couldn’t read it", acts: letGo(refusedFile!) },
          { name: ZIP3, state: "kept", words: "Kept", line: nb("1 file couldn't be read"), acts: letGo(refusingFile!) },
        ],
      }],
    });
    expect([takeout.titles, takeout.drop]).toEqual([{ reads: "What it brings", guide: "How to get it", held: "Your imports" },
      { words: "Drop the zip here", line: "Lifestream reads a copy; your file stays where it is.", choose: "Choose file…", away: "On your Mac" }]);
    expect(report.imports.find((each) => each.kind === "spotify")!.held).toEqual([
      expect.objectContaining({ id: ASKED_SPOTIFY, line: "Whose Spotify is this?",
        ask: { words: "Whose Spotify is this?", choices: ["person-a"], other: true, choose: "Choose", another: "Another…" }, span: null, open_day: null, open: null, downloaded: null }),
      expect.objectContaining({ id: IN_SPOTIFY, line: nb("Imported · 2014–2026 · 3 plays"),
        span: { from: "2014-03-02", to: "2026-09-01" }, open_day: "2026-09-01", open: "Open a day", downloaded: "You can delete the file you downloaded.", ask: null }),
    ]);
    expect([takeout.health.state, takeout.health.words, takeout.line]).toEqual(["needs-you", nb("Couldn't read 1 file"), "Sending · 1 of 3\u00a0files"]);
    expect(connectorOf(report, "google").export).toEqual({ import: "google-takeout", name: "Google Takeout", icon: "archive", opens: true, line: "Importing" });
    expect([connectorOf(report, "google").set_up, connectorOf(report, "google").line, connectorOf(report, "google").lead]).toEqual([false, "Import a Google Takeout", null]);
    expect(report.devices.map((each) => [each.unit, healthOf(each.health)])).toEqual([
      [MAC_B, ["ok", null]], [MAC_A, ["quiet", "device"]], [OLD_PHONE, ["needs-you", "pair"]], [PHONE, ["ok", null]],
    ]);
    expect(report.devices.map((each) => [each.unit, each.replaced])).toEqual([[MAC_B, []], [MAC_A, [replacedMac]], [OLD_PHONE, []], [PHONE, []]]);
    expect(report.devices.find((each) => each.unit === MAC_A)!.pass).toBe(at.passOf(MAC_A));
    expect(connectorOf(report, "whatsapp").processing).toEqual({
      rows: [
        {
          member: "llm.photos", shape: "running", line: `${nb("2 photos left")} · about\u00a05\u00a0min · about\u00a0$1 · 1\u00a0could not be processed`,
          privacy: {
            member: "privacy.photos", value: "default", words: "Personal details hidden", waiting: false,
            note: "Names, numbers and faces are replaced. The model still reads what was said.",
            steps: [
              { value: "default", words: "Default", note: "Hide all" },
              { value: "all", words: "Hide all", note: "Names, numbers and faces are replaced. The model still reads what was said." },
              { value: "names", words: "Keep names", note: "Numbers and faces are replaced; names are sent as they are. The model still reads what was said." },
              { value: "none", words: "Don't hide", note: "Everything is sent as it is." },
            ],
          },
        },
        { member: "llm.voice", shape: "needs", line: "Connect a model that takes audio", privacy: null },
        { member: "llm.range", shape: null, line: null, privacy: null },
      ],
    });
    expect(connectorOf(report, "whatsapp").members.filter((member) => member.key.startsWith("llm.")).map((member) => [member.key, member.default, member.about]))
      .toEqual([["llm.photos", null, release("whatsapp").processing!.photos!.about], ["llm.voice", null, release("whatsapp").processing!.voice!.about], ["llm.range", null, null]]);
    expect([connectorOf(report, "apple-photos").backfill_about, connectorOf(report, "whatsapp").backfill_about]).toEqual([release("apple-photos").backfill!.about, null]);
    expect(connectorOf(report, "gmail").processing).toBeNull();
    const screenMenu = connectorOf(report, "screen").members.find((member) => member.key === "llm.screen")!.menu!;
    expect([screenMenu.rows, screenMenu.local]).toEqual([[{ value: VISION.id, name: "Vision One", account: null, chosen: false }], null]);
    expect(connectorOf(report, "screen").processing).toEqual({ rows: [{ member: "llm.screen", shape: "needs", line: "Connect a model that takes text", privacy: null }, { member: "llm.range", shape: null, line: null, privacy: null }] });
    const fixture = `${JSON.stringify(streamsAnswer(report, 0, { device: "mac", unit: null }), null, 2)}\n`;
    if (WRITE_FIXTURES) writeFileSync(FIXTURE, fixture);
    expect(readFileSync(FIXTURE, "utf8"), "homelink/Tests/Fixtures/report.json is this report as the page a Mac reads: LIFESTREAM_FIXTURES=write writes it").toBe(fixture);
    const phoned = `${JSON.stringify(PAGES.connectors.shape.parse({ position: `1:${report.at_ms}`, today: report.day, ...streamsAnswer(report, 0, { device: "phone", unit: PHONE }) }), null, 2)}\n`;
    if (WRITE_FIXTURES) writeFileSync(PHONE_FIXTURE, phoned);
    expect(readFileSync(PHONE_FIXTURE, "utf8"), "homelink/Tests/Fixtures/pages/canned/connectors.report.json is this report as the page this phone reads, the canned home's: LIFESTREAM_FIXTURES=write writes it").toBe(phoned);

    const hidingLine = "Waiting for People to list the names of your people";
    const raw = new Database(join(at.root, "home.db"));
    raw.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(HIDING_META, JSON.stringify({ all: hidingLine, names: hidingLine }));
    raw.close();
    const waiting = connectorOf(reportOf(at.root, { stated, present: [BROWSER], needs: [disk], chosen: ["chatgpt", "claude", "whoop"], machine: at.machine }), "whatsapp").processing!.rows;
    expect(waiting.map((row) => [row.member, row.shape, row.line?.split(" · ")[0] ?? null, row.privacy?.waiting ?? null])).toEqual([
      ["llm.photos", "waiting", hidingLine, true], ["llm.voice", "needs", "Connect a model that takes audio", null], ["llm.range", null, null, null],
    ]);
  });

  it("29. Lifestream's settings are those the serving process (the home or the door) read at its start: a value written since shows once it applies, the model cap at once", () => {
    const at = home("lifestream-report-settings-", { "helpers": 3, "model.cap": 4 });
    for (const key of ["door.port", "door.lan_port"]) reset(at.root, key);
    const started = effective(at.root).settings;
    expect(reportOf(at.root, { settings: started }).home.settings).toEqual({
      zone: DAY.zone, day_start_hour: 4, helpers: 3, helpers_resolved: 3, model_cap: 4, model_cap_default: 8, port: 4680, lan_port: 4682,
    });
    planned(at.root, { "day.day_start_hour": 6, "helpers": "auto", "door.port": 4700, "door.lan_port": 4702, "model.cap": 16 }).write();
    const running = { ...started, model: effective(at.root).settings.model };
    const after = reportOf(at.root, { settings: running }).home.settings;
    expect(after).toEqual({
      zone: DAY.zone, day_start_hour: 4, helpers: 3, helpers_resolved: 3, model_cap: 16, model_cap_default: 8, port: 4680, lan_port: 4682,
    });
    expect(reportOf(at.root, { settings: effective(at.root).settings }).home.settings).toMatchObject({
      day_start_hour: 6, helpers: "auto", port: 4700, lan_port: 4702,
    });
    summary.settings = { started: reportOf(at.root, { settings: started }).home.settings, after };
  });

  it("1. today counts what happened, not what arrived: a library's files landed today are no photos today, and its files left say so", () => {
    const at = home("lifestream-report-today-");
    const copy = `apple-photos:person-a@example.com:${MAC_B}`;
    at.device(MAC_B, "MacBook Air").pass(MAC_B, "mac", [copy]).source(copy, "photos-mac");
    at.land(copy, [...Array.from({ length: 300 }, (_, index) => item("img-file", `file-${index}`, NOW - 10 * MINUTE)), item("photo", "old", NOW - 40 * DAY_MS)]);
    at.wanted(copy, 300).delivery(copy, NOW - MINUTE).done();
    const photos = connectorOf(reportOf(at.root, { stated: { [MAC_B]: said(at.passOf(MAC_B), { photos: "on" }, NOW - MINUTE) } as Stated }), "apple-photos");
    summary.today = { figure: photos.figure, line: photos.line, history: photos.history };
    expect(photos.figure?.today).toBe(0);
    expect(photos.copies[0]!.held).toBe(1);
    expect(healthOf(photos.health)).toEqual(["syncing", null]);
    expect([photos.lead, photos.line]).toEqual(["Catching up", "back to Sep 2026"]);
    expect(photos.history).toMatchObject({ state: "syncing", left: 300, unit: ["file", "files"], arriving: nb("Back to Sep 2026 · 300 files left") });
    const past = home("lifestream-report-capped-");
    past.device(MAC_B, "MacBook Air").pass(MAC_B, "mac", [copy]).source(copy, "photos-mac");
    past.land(copy, [item("photo", "old", NOW - 40 * DAY_MS)]).wanted(copy, 1_500).delivery(copy, NOW - MINUTE).done();
    const capped = connectorOf(reportOf(past.root, { stated: { [MAC_B]: said(past.passOf(MAC_B), { photos: "on" }, NOW - MINUTE) } as Stated }), "apple-photos");
    summary.capped = { line: capped.line, history: capped.history };
    expect(capped.line).toBe("back to Sep 2026");
    expect(capped.history).toMatchObject({ state: "syncing", left: 1_001, unit: ["file", "files"], arriving: nb("Back to Sep 2026 · over 1,000 files left") });
  });

  it("an export handed in that its reader refused says why in the reader's words, under the need; a fetched copy's stay the operator's", () => {
    const at = home("lifestream-report-handed-refused-", { "connectors.spotify": { account: "person-b" } });
    const handed = "spotify:person-b:export";
    const run = at.ran(`${handed} spotify-export/1`, { refused: 2, refusals: [
      { kind: "play", key: "p1", violations: ["the guard of 'play' threw: TypeError: synthetic"] },
      { kind: "delivery", key: "spotify-export/1", violations: ["after 0 rows: Refused: profile.csv names username person-a, not this stream's person-b"] }] });
    at.source(handed, "spotify-export").delivery(handed, NOW - HOUR, {}, { id: "spotify-export/1", refused: 2, run });
    const spotify = connectorOf(reportOf(at.root), "spotify");
    const need = reportOf(at.root).needs.find((each) => each.id === `unread:${handed}`)!;
    summary.handedRefused = { health: spotify.health, need };
    expect([spotify.health.words, spotify.health.line]).toEqual(["Couldn’t read what Spotify sent", "profile.csv names username person-a, not this stream's person-b"]);
    expect([need.words, need.line, need.acts]).toEqual([spotify.health.words, spotify.health.line, [{ do: "skip", label: "Skip it", need: `unread:${handed}` }]]);
    const rest = (error: Error) => [{ kind: "delivery", key: "d", violations: [restRefusal(1_234, error)] }];
    expect(refusedWords(rest(new Refused("profile.csv names no account")))).toBe("profile.csv names no account");
    expect(refusedWords(rest(new TypeError("synthetic")))).toBeNull();
    expect(refusedWords([{ kind: "file", key: "a.csv", violations: ["a.csv names no date"] }])).toBe("a.csv names no date");
  });

  it("a refusal's words are sought for a hand-in alone, in its newest standing delivery: a fetched copy's backlog is never read for them, nor raised", () => {
    const at = home("lifestream-report-refused-seek-", { "connectors.github": { login: "person-a", route: "github-api" }, "connectors.spotify": { account: "person-b" } });
    const [fetched, handed] = ["github:person-a:cloud", "spotify:person-b:export"];
    const refusing = (words: string) => at.ran(`${words} run`, { refused: 1, refusals: [{ kind: "delivery", key: words, violations: [restRefusal(0, new Refused(words))] }] });
    at.source(fetched, "github-api").source(handed, "spotify-export");
    for (let index = 0; index < 5; index++) at.delivery(fetched, NOW - (index + 2) * HOUR, {}, { refused: 1, run: refusing(`fetched-refusal-${index}`) });
    at.delivery(handed, NOW - 3 * HOUR, {}, { refused: 1, run: refusing("handed-older-refusal") });
    at.delivery(handed, NOW - 2 * HOUR, {}, { refused: 1, run: refusing("handed-newest-refusal") });
    const parse = JSON.parse;
    const parsed: string[] = [];
    JSON.parse = ((text: string, ...rest: never[]) => {
      if (typeof text === "string" && text.includes("-refusal")) parsed.push(text);
      return parse(text, ...rest);
    }) as typeof JSON.parse;
    let report: StreamsReport;
    try {
      report = reportOf(at.root);
    } finally {
      JSON.parse = parse;
    }
    const [github, spotify] = [connectorOf(report, "github"), connectorOf(report, "spotify")];
    expect(parsed.filter((text) => text.includes("fetched-refusal")), "a fetched copy's runs read for words").toEqual([]);
    expect(parsed.filter((text) => text.includes("handed-older-refusal")), "an older hand-in read").toEqual([]);
    expect(github.health.reason, "a fetched copy's unread rows are a need the person cannot act on").not.toBe("import");
    expect(report.needs.map((need) => need.id)).not.toContain(`unread:${fetched}`);
    expect([spotify.health.reason, spotify.health.line]).toEqual(["import", "handed-newest-refusal"]);
  });

  it("a Mac copy whose newest delivery its reader refused whole reads as Nothing yet, its history as done, or offers Skip it; rows refused, or a later delivery read, raise it", () => {
    const copy = `whatsapp:+15550000001:${MAC_B}`;
    const words = "the store ZSYNTHETIC lacks columns this connector reads: ZSYNTHETICCOLUMN";
    const sent = (prefix: string, deliveries: { id: string; refusals: JsonObject[] }[]) => {
      const at = home(prefix);
      at.device(MAC_B, "MacBook Air").pass(MAC_B, "mac", [copy]).source(copy, "whatsapp-mac");
      deliveries.forEach(({ id, refusals }, index) => {
        const run = at.ran(`${copy} ${id}`, { refused: refusals.length, refusals });
        at.delivery(copy, NOW - (deliveries.length - index + 1) * MINUTE, { left: 0, start_ms: null }, { id: `${copy}/${id}`, refused: refusals.length, run });
      });
      at.done();
      const report = reportOf(at.root, { stated: { [MAC_B]: said(at.passOf(MAC_B), { fullDiskAccess: "on" }, NOW - MINUTE, ["whatsapp"]) } as Stated });
      return { report, whatsapp: connectorOf(report, "whatsapp") };
    };
    const whole = { kind: "delivery", key: "d", violations: [restRefusal(0, new Refused(words))] };
    const row = { kind: "message", key: "m1", violations: ["the guard of 'message' threw: TypeError: synthetic"] };
    const refused = sent("lifestream-report-sent-refused-", [{ id: "d-1", refusals: [whole] }]);
    summary.sentRefused = { health: refused.whatsapp.health, line: refused.whatsapp.line, copy: refused.whatsapp.copies[0], history: refused.whatsapp.history };
    expect([refused.whatsapp.health.words, refused.whatsapp.health.line]).toEqual(["Couldn’t read what WhatsApp sent", words]);
    expect(refused.whatsapp.line).toBe("Couldn’t read what WhatsApp sent");
    expect(refused.whatsapp.copies[0]!.line).toBe("Couldn’t read what WhatsApp sent");
    expect(refused.whatsapp.history).toBeNull();
    const need = refused.report.needs.find((each) => each.id === `unread:${copy}`)!;
    expect([need.words, need.line]).toEqual(["Couldn’t read what WhatsApp sent", words]);
    expect(need.acts.map((act) => act.do)).not.toContain("skip");
    for (const [prefix, deliveries] of [
      ["lifestream-report-sent-rows-", [{ id: "d-1", refusals: [row] }]],
      ["lifestream-report-sent-later-", [{ id: "d-1", refusals: [whole] }, { id: "d-2", refusals: [] }]],
    ] as const) {
      const { report, whatsapp } = sent(prefix, deliveries.map((each) => ({ id: each.id, refusals: [...each.refusals] })));
      expect(whatsapp.health.reason, prefix).not.toBe("import");
      expect(report.needs.map((each) => each.id), prefix).not.toContain(`unread:${copy}`);
      expect(whatsapp.copies[0]!.line, prefix).toBe("Nothing yet");
      expect(whatsapp.history, prefix).toMatchObject({ state: "done" });
    }
  });

  it("2. a count is what the home holds: a record later gone is not counted", () => {
    const at = home("lifestream-report-held-", { "connectors.github": { login: "person-a", route: "github-api" } });
    const copy = "github:person-a:cloud";
    at.source(copy, "github-api").land(copy, Array.from({ length: 5 }, (_, index) => item("contribution", `c${index}`, NOW - (index + 2) * DAY_MS)));
    at.land(copy, [{ kind: "contribution", key: "c0", content: null, gone: true }, { kind: "contribution", key: "c1", content: null, gone: true }]);
    at.poll("github-api").attempt("fetch:github-api", copy, "ok", null, { since_ms: NOW - MINUTE }).done();
    const github = connectorOf(reportOf(at.root), "github");
    summary.held = { copy: github.copies[0], line: github.line };
    expect(github.copies[0]!.held).toBe(3);
    expect(github.copies[0]!.line).toBe(`${nb("3 contributions")} · last ${when(NOW - 4 * DAY_MS, NOW, DAY)}`);
  });

  it("3. a delivery of nothing new does not freshen Last: a copy whose newest item is 14 days old is quiet nothing-new, and no need", () => {
    const at = home("lifestream-report-nothing-new-");
    const copy = `location:local:${PHONE}`;
    at.device(PHONE, "iPhone 17 Pro").pass(PHONE, "phone", [copy]).source(copy, "location-ios-bundle").land(copy, [item("fix", "p1", NOW - 14 * DAY_MS)]);
    at.delivery(copy, NOW - MINUTE, { left: 0 }).done();
    const report = reportOf(at.root, { stated: { [PHONE]: said(at.passOf(PHONE), { location: "on" }, NOW - MINUTE) } as Stated });
    const location = connectorOf(report, "location");
    summary.nothing_new = { health: location.health, copy: location.copies[0], figure: location.figure };
    expect(healthOf(location.health)).toEqual(["quiet", "nothing-new"]);
    expect(location.copies[0]!.line).toBe(`${nb("1 point")} · last ${when(NOW - 14 * DAY_MS, NOW, DAY)}`);
    expect(location.figure?.words).toBe(`Checked ${when(NOW - MINUTE, NOW, DAY)}`);
    expect(report.needs).toEqual([]);
  });

  it("4. one day on one row: at 00:49 with the day starting at 04:00, an item at 22:40 the evening before is today's", () => {
    const now = Date.UTC(2026, 9, 28, 0, 49);
    const at = home("lifestream-report-day-", {}, now);
    const copy = `whatsapp:+15550000001:${MAC_B}`;
    const evening = Date.UTC(2026, 9, 27, 22, 40);
    at.device(MAC_B, "MacBook Air").pass(MAC_B, "mac", [copy]).source(copy, "whatsapp-mac").land(copy, [item("message", "late", evening)]);
    at.delivery(copy, now - MINUTE, { left: 0 }).done();
    const whatsapp = connectorOf(reportOf(at.root, { stated: { [MAC_B]: said(at.passOf(MAC_B), { fullDiskAccess: "on" }, now - MINUTE, ["whatsapp"]) } as Stated }, now), "whatsapp");
    summary.day = { figure: whatsapp.figure, line: whatsapp.line, copy: whatsapp.copies[0]!.line };
    expect(whatsapp.figure?.today).toBe(1);
    expect(whatsapp.line).toBe(nb("1 message today"));
    expect(whatsapp.copies[0]!.line).toBe(nb("1 message · last 22:40"));
  });

  it("4a. the clock alone on now's own date: at 03:47 with the day starting at 04:00, 04:17 is \"04:17\", never \"tomorrow 04:17\"", () => {
    const now = Date.UTC(2026, 9, 28, 3, 47);
    expect([when(Date.UTC(2026, 9, 28, 4, 17), now, DAY), when(Date.UTC(2026, 9, 27, 22, 40), now, DAY)]).toEqual(["04:17", "22:40"]);
    expect([when(Date.UTC(2026, 9, 29, 2, 0), now, DAY), when(Date.UTC(2026, 9, 26, 22, 40), now, DAY)]).toEqual(["tomorrow 02:00", "yesterday 22:40"]);
  });

  it("4b. a date is its own day: an all-day event on 28 Sep, read in a zone behind UTC, is last 28 Sep, never the 27th", () => {
    const at = home("lifestream-report-dated-", { "day.zone": "America/Los_Angeles" });
    const copy = "google-calendar:person-a@example.com:cloud";
    const dated: ReaderOutput = { kind: "event", key: "e1", content: { text: "synthetic e1" }, time: { start_ms: Date.UTC(2026, 8, 28), precision: "day" } };
    at.source(copy, "gcal-api").land(copy, [dated]).done();
    const calendar = connectorOf(reportOf(at.root), "google-calendar");
    summary.dated = { copy: calendar.copies[0]!.line, line: calendar.line };
    expect(calendar.copies[0]!.line).toBe(`${nb("1 event")} · last 28 Sep`);
  });

  it("6. a silent Mac is quiet, once: its row and its copies quiet device, and no need", () => {
    const at = home("lifestream-report-silent-");
    const copy = `screen:local:${MAC_A}`;
    at.device(MAC_A, "MacBook Pro").pass(MAC_A, "mac", [copy]).source(copy, "screen-recorder").land(copy, [item("frame", "f1", NOW - 3 * HOUR)]);
    at.delivery(copy, NOW - 2 * HOUR - MINUTE).done();
    const report = reportOf(at.root);
    const screen = connectorOf(report, "screen");
    summary.silent = { device: report.devices[0], copy: screen.copies[0]!.health, needs: report.needs };
    expect(healthOf(report.devices[0]!.health)).toEqual(["quiet", "device"]);
    expect(healthOf(screen.copies[0]!.health)).toEqual(["quiet", "device"]);
    expect(healthOf(screen.health)).toEqual(["quiet", "device"]);
    expect(report.needs).toEqual([]);
  });

  it("6b. a device copy's contact is the newer of its newest delivery and the last stated read-through the home took; what is left is the newest statement of it", () => {
    const screen = `screen:local:${MAC_A}`;
    const photos = `apple-photos:person-a@example.com:${MAC_A}`;
    const at = home("lifestream-report-stated-");
    at.device(MAC_A, "MacBook Pro").pass(MAC_A, "mac", [screen, photos]).source(screen, "screen-recorder").source(photos, "photos-mac")
      .land(screen, [item("frame", "f1", NOW - 3 * HOUR)]).land(photos, [item("photo", "p1", NOW - 900 * DAY_MS)]);
    at.delivery(screen, NOW - 2 * HOUR - MINUTE).delivery(photos, NOW - 2 * HOUR - MINUTE, { left: 0, start_ms: null });
    at.stated(screen, value(NOW - 2 * MINUTE, NOW - MINUTE), NOW - MINUTE).stated(photos, value(NOW - 2 * MINUTE, NOW - MINUTE, { left: 4_000, start_ms: null }), NOW - MINUTE);
    at.stated(photos, value(NOW - 3 * HOUR, NOW - 3 * HOUR, { left: 9_000, start_ms: null }), NOW - 3 * HOUR).done();
    const report = reportOf(at.root);
    const [mac, recorder, library] = [report.devices[0]!, connectorOf(report, "screen"), connectorOf(report, "apple-photos")];
    summary.stated = { device: mac, screen: recorder.copies[0]!.health, photos: library.history };
    expect([healthOf(mac.health), mac.contact_ms]).toEqual([["ok", null], NOW - MINUTE]);
    expect(healthOf(recorder.copies[0]!.health)).toEqual(["ok", null]);
    expect(library.history).toMatchObject({ state: "syncing", arriving: "Back to May 2024" });
  });

  it("6c. a source that never sends again reads the same once the quiet rows' job has cleared its heartbeats out: contact, what is left, read-through", async () => {
    const screen = `screen:local:${MAC_A}`;
    const photos = `apple-photos:person-a@example.com:${MAC_A}`;
    const at = home("lifestream-report-cleared-", { "sources.off": [photos] });
    at.device(MAC_A, "MacBook Pro").pass(MAC_A, "mac", [screen, photos]).source(screen, "screen-recorder").source(photos, "photos-mac")
      .land(screen, [item("frame", "f1", NOW - 3 * HOUR)]).land(photos, [item("photo", "p1", NOW - 900 * DAY_MS)]);
    const pass = at.passOf(MAC_A);
    const beat = (sealed_ms: number, left?: { left: number; start_ms: number | null }) => heartbeatFacts(sealed_ms, sealed_ms - MINUTE, left);
    at.delivery(photos, NOW - 5 * HOUR, {}, { pass, seal: 1 }).delivery(photos, NOW - 4 * HOUR, beat(NOW - 4 * HOUR), { pass })
      .delivery(photos, NOW - 3 * HOUR, beat(NOW - 3 * HOUR, { left: 4_000, start_ms: null }), { pass })
      .delivery(screen, NOW - 2 * HOUR, beat(NOW - 2 * HOUR), { pass }).delivery(screen, NOW - HOUR, beat(NOW - HOUR), { pass }).done();
    const before = reportOf(at.root);
    const db = openHome(openHomeFolder(at.root), "migrate");
    try {
      const lines: Json[] = [];
      expect(await quietRun({ root: at.root, db, now: NOW, commit: (work) => db.commit(work) }, lines, { off: [photos] })).toBe(true);
      expect(lines).toMatchObject([{ quiet: { rows: 4, kept: 0 } }]);
      expect(db.commit((tx) => tx.tables.deliveries.list().map((row) => row.source))).toEqual([photos]);
    } finally {
      db.close();
    }
    const after = reportOf(at.root);
    summary.cleared = { before: connectorOf(before, "apple-photos").copies, after: connectorOf(after, "apple-photos").copies };
    expect(after).toEqual(before);
  });

  it("7. signed out after its route ran here is a need, said again; held but never run here, or never held, it is to set up; held only through another way, the sign-in is no need", () => {
    const COPY = "gmail:person-a@example.com:cloud";
    const EXPORT = "gmail:person-a@example.com:export";
    const worked = home("lifestream-report-signout-");
    worked.source(COPY, "gmail-imap").land(COPY, [item("email", "m1", NOW - 6 * DAY_MS)]).parked("gmail-imap").done();
    const again = reportOf(worked.root);
    const elsewhere = home("lifestream-report-elsewhere-");
    elsewhere.source(COPY, "gmail-imap").land(COPY, [item("email", "m1", NOW - 6 * DAY_MS)]).done();
    const greenfield = reportOf(elsewhere.root);
    const never = home("lifestream-report-never-");
    never.source(COPY, "gmail-imap").done();
    const fresh = reportOf(never.root);
    const exported = home("lifestream-report-exported-");
    exported.source(EXPORT, "gmail-takeout").land(EXPORT, [item("email", "e1", NOW - 60 * DAY_MS)])
      .delivery(EXPORT, NOW - 50 * DAY_MS).done();
    const other = reportOf(exported.root);
    const gmail = (report: StreamsReport) => connectorOf(report, "gmail");
    summary.signout = { again: gmail(again).health, greenfield: gmail(greenfield).health, fresh: gmail(fresh).health, other: [gmail(other).health, gmail(other).ways] };
    expect([healthOf(gmail(again).health), gmail(again).health.words, needIds(again.needs)]).toEqual([["needs-you", "sign-in"], "Connect Gmail again", ["setup:gmail:sign-in"]]);
    expect(gmail(again).health.acts).toEqual([{ do: "signin", label: "Set up", of: "gmail-imap" }]);
    expect([healthOf(gmail(greenfield).health), gmail(greenfield).health.words, greenfield.needs]).toEqual([["setup", "sign-in"], "Connect Gmail", []]);
    expect([healthOf(gmail(fresh).health), gmail(fresh).health.words, fresh.needs]).toEqual([["setup", "sign-in"], "Connect Gmail", []]);
    expect([gmail(other).set_up, other.needs, gmail(other).ways[0]!.requirements[0]!.words]).toEqual([true, [], "Connect Gmail"]);
  });

  it("8. Chrome closed is a wait: a chosen site with no station present is waiting chrome, still set up", () => {
    const at = home("lifestream-report-chrome-");
    const copy = "chatgpt:person-a@example.com:browser";
    at.source(copy, "chatgpt-browser").land(copy, [item("conversation", "c1", NOW - DAY_MS)]).poll("chatgpt-browser")
      .attempt("fetch:chatgpt-browser", copy, "wait", "chrome", { since_ms: NOW - 20 * MINUTE, contact_ms: NOW - 3 * HOUR, facts: { why: "closed" } }).done();
    const chatgpt = connectorOf(reportOf(at.root, { sites: [], present: [], chosen: ["chatgpt"] }), "chatgpt");
    summary.chrome = { health: chatgpt.health, set_up: chatgpt.set_up, ways: chatgpt.ways };
    expect([healthOf(chatgpt.health), chatgpt.health.words, chatgpt.set_up]).toEqual([["waiting", "chrome"], "Chrome is closed", true]);
  });

  it("10a. a sensor's pause says what stopped: the home's reading, its device recording on", () => {
    const at = home("lifestream-report-sensor-");
    const copy = `screen:local:${MAC_A}`;
    at.device(MAC_A, "MacBook Pro").pass(MAC_A, "mac", [copy]).source(copy, "screen-recorder").land(copy, [item("frame", "f1", NOW - 3 * HOUR)])
      .pause("pause:screen", "", "you", NOW - HOUR).done();
    expect(connectorOf(reportOf(at.root), "screen").line).toMatch(/^Reading paused since /u);
  });

  it("10b. a stream paused whole offers Resume as the row's act: one only the Mac runs to the Mac alone, a provider's to the Mac and the phone", () => {
    const at = home("lifestream-report-resume-");
    const copy = `screen:local:${MAC_A}`;
    at.device(MAC_A, "MacBook Pro").pass(MAC_A, "mac", [copy]).source(copy, "screen-recorder").land(copy, [item("frame", "f1", NOW - 3 * HOUR)])
      .pause("pause:screen", "", "you", NOW - HOUR).done();
    const report = reportOf(at.root);
    const act = (device: "mac" | "phone" | null) => streamsAnswer(report, 0, { device, unit: device === "mac" ? MAC_A : null }).rows.find((row) => row.ids.includes("screen"))!.act;
    expect(act("mac")).toEqual({ do: "resume", label: "Resume reading", of: "screen" });
    expect([act("phone")?.do, act(null)?.do]).not.toContain("resume");
    const history = home("lifestream-report-resume-history-");
    history.device(MAC_A, "MacBook Pro").pass(MAC_A, "mac", [copy]).source(copy, "screen-recorder").land(copy, [item("frame", "f1", NOW - 3 * HOUR)])
      .pause("pause:screen:history", "", "you", NOW - HOUR).done();
    const past = streamsAnswer(reportOf(history.root), 0, { device: "mac", unit: MAC_A }).rows.find((row) => row.ids.includes("screen"))!;
    expect(past.act?.do).not.toBe("resume");
    const provider = home("lifestream-report-resume-provider-", { "connectors.github": { login: "person-a", route: "github-api" } });
    const fetched = "github:person-a:cloud";
    provider.source(fetched, "github-api").land(fetched, [item("contribution", "c1", NOW - DAY_MS)])
      .poll("github-api").attempt("fetch:github-api", fetched, "ok", null, { since_ms: NOW - 2 * HOUR }).pause("pause:github", "", "you", NOW - HOUR).done();
    const polled = reportOf(provider.root);
    const resume = (device: "mac" | "phone" | null) => streamsAnswer(polled, 0, { device, unit: device === "mac" ? MAC_A : device === "phone" ? PHONE : null }).rows.find((row) => row.ids.includes("github"))!.act;
    expect([resume("mac"), resume("phone")]).toEqual([{ do: "resume", label: "Resume", of: "github" }, { do: "resume", label: "Resume", of: "github" }]);
    expect(resume(null)?.do).not.toBe("resume");
  });

  it("10. no need is hidden: files gone under a paused connector are broken missing-file, and a need", () => {
    const at = home("lifestream-report-hidden-");
    const copy = "google-takeout:person-a@example.com:export";
    at.source(copy, "takeout").land(copy, [item("item", "t1", NOW - 400 * DAY_MS)]).lost(copy, 31, NOW - DAY_MS)
      .pause("pause:google-takeout", "a test", "you", NOW - HOUR).done();
    const report = reportOf(at.root);
    const takeout = connectorOf(report, "google-takeout");
    summary.hidden = { health: takeout.health, copy: takeout.copies[0]!.health, needs: report.needs };
    expect(healthOf(takeout.health)).toEqual(["paused", null]);
    expect(takeout.pauses).toEqual([{ scope: "all", by: "you", reason: "a test", at_ms: NOW - HOUR }]);
    expect(healthOf(takeout.copies[0]!.health)).toEqual(["broken", "missing-file"]);
    expect(report.needs.map((need) => [need.id, need.state, need.reason, need.words, need.connector, need.copy])).toEqual([
      [`lost:${copy}`, "broken", "missing-file", nb("Couldn't read 31 files"), "google-takeout", copy],
    ]);
    const past = home("lifestream-report-hidden-capped-");
    past.source(copy, "takeout").land(copy, [item("item", "t1", NOW - 400 * DAY_MS)]).lost(copy, 1_200, NOW - DAY_MS).done();
    const capped = reportOf(past.root).needs.map((need) => [need.id, need.words, need.since_ms]);
    summary.hidden_capped = capped;
    expect(capped).toEqual([[`lost:${copy}`, nb("Couldn't read over 1,000 files"), NOW - DAY_MS]]);
    const two = home("lifestream-report-hidden-two-");
    two.source(copy, "takeout").land(copy, [item("item", "t1", NOW - 400 * DAY_MS)]).lost(copy, 2, NOW - 3 * DAY_MS, 0);
    const first = reportOf(two.root).needs.map((need) => [need.id, need.words, need.since_ms]);
    two.dismiss(`lost:${copy}`, String(NOW - 3 * DAY_MS)).lost(copy, 3, NOW - DAY_MS, 10);
    const both = reportOf(two.root).needs.map((need) => [need.id, need.words, need.since_ms, need.dismissed]);
    two.arrived([lostBlob(0), lostBlob(1)]).done();
    const after = reportOf(two.root).needs.map((need) => [need.id, need.words, need.since_ms, need.dismissed]);
    summary.hidden_two = { first, both, after };
    expect(first).toEqual([[`lost:${copy}`, nb("Couldn't read 2 files"), NOW - 3 * DAY_MS]]);
    expect(both).toEqual([]);
    expect(after).toEqual([[`lost:${copy}`, nb("Couldn't read 3 files"), NOW - DAY_MS, false]]);
    const held = home("lifestream-report-hidden-held-");
    held.source(copy, "takeout").land(copy, [item("item", "t1", NOW - 400 * DAY_MS)]).pause("pause:google-takeout", "a test", "you", NOW - HOUR);
    for (let n = 0; n < 1_200; n++) held.delivery(copy, NOW - MINUTE, {}, { state: "sealed" });
    held.done();
    const heldLine = connectorOf(reportOf(held.root), "google-takeout").line;
    summary.hidden_held = heldLine;
    expect(heldLine).toContain(nb("over 1,000 waiting"));
  });

  it("11. mirror copies are not summed: two libraries of one account, 5 photos taken today in both, say 5 photos today", () => {
    const at = home("lifestream-report-mirror-");
    const copies = [`apple-photos:person-a@example.com:${MAC_B}`, `apple-photos:person-a@example.com:${PHONE}`];
    at.device(MAC_B, "MacBook Air").device(PHONE, "iPhone 17 Pro").pass(MAC_B, "mac", [copies[0]!]).pass(PHONE, "phone", [copies[1]!]);
    at.source(copies[0]!, "photos-mac").source(copies[1]!, "photos-ios");
    for (const copy of copies) at.land(copy, Array.from({ length: 5 }, (_, index) => item("photo", `p${index}`, NOW - (index + 1) * HOUR))).delivery(copy, NOW - MINUTE, { left: 0, start_ms: null });
    at.done();
    const photos = connectorOf(reportOf(at.root, { stated: {
      [MAC_B]: said(at.passOf(MAC_B), { photos: "on" }, NOW - MINUTE), [PHONE]: said(at.passOf(PHONE), { photos: "on" }, NOW - MINUTE),
    } as Stated }), "apple-photos");
    summary.mirror = { figure: photos.figure, line: photos.line };
    expect([photos.figure?.today, photos.line]).toEqual([5, nb("5 photos today")]);
  });

  it("12. a device's history ends at its traversal: left 0 under the running start is done, a delivery stating none after it changes nothing, and no device number is said; what is arriving says how far back, or before any item what it reads", () => {
    const at = home("lifestream-report-traversal-");
    const [mac, phone] = [`apple-photos:person-a@example.com:${MAC_B}`, `apple-photos:person-a@example.com:${PHONE}`];
    at.device(MAC_B, "MacBook Air").device(PHONE, "iPhone 17 Pro").pass(MAC_B, "mac", [mac]).pass(PHONE, "phone", [phone]).source(mac, "photos-mac").source(phone, "photos-ios");
    at.land(mac, [item("photo", "m1", NOW - 900 * DAY_MS)]).delivery(mac, NOW - MINUTE, { left: 0, start_ms: null });
    at.land(phone, [item("photo", "q1", NOW - 30 * DAY_MS)]).delivery(phone, NOW - MINUTE, { left: 4_000 }).done();
    const reading = connectorOf(reportOf(at.root), "apple-photos");
    const ended = home("lifestream-report-ended-");
    ended.device(MAC_B, "MacBook Air").pass(MAC_B, "mac", [mac]).source(mac, "photos-mac").land(mac, [item("photo", "m1", NOW - 900 * DAY_MS)])
      .delivery(mac, NOW - 2 * MINUTE, { left: 0, start_ms: null }).delivery(mac, NOW - MINUTE).done();
    const done = connectorOf(reportOf(ended.root), "apple-photos");
    const unnamed = home("lifestream-report-unnamed-");
    unnamed.device(MAC_B, "MacBook Air").pass(MAC_B, "mac", [mac]).source(mac, "photos-mac").land(mac, [item("photo", "m1", NOW - 900 * DAY_MS)])
      .delivery(mac, NOW - MINUTE, { left: 0 }).done();
    const owed = connectorOf(reportOf(unnamed.root), "apple-photos");
    const first = home("lifestream-report-first-");
    first.device(MAC_B, "MacBook Air").pass(MAC_B, "mac", [mac]).source(mac, "photos-mac").delivery(mac, NOW - MINUTE, { left: 4_000, start_ms: null }).done();
    const none = connectorOf(reportOf(first.root), "apple-photos");
    summary.traversal = { reading: [reading.history, reading.line], done: [done.history, done.line], unnamed: owed.history, first: none.history };
    expect(reading.history).toMatchObject({ state: "syncing", left: null, unit: null, eta_ms: null, arriving: "Back to May 2024" });
    expect([reading.lead, reading.line]).toEqual(["Catching up", "back to May 2024"]);
    expect(done.history).toMatchObject({ state: "done", left: null, back_to_ms: NOW - 900 * DAY_MS });
    expect(owed.history).toMatchObject({ state: "syncing", left: null, arriving: "Back to May 2024" });
    expect(none.history).toMatchObject({ state: "syncing", back_to_ms: null, left: null, words: "reading older photos", arriving: "reading older photos" });
  });

  it("5. a failing fetch is waiting until its window passes, then broken; a failing page is seen the same way", () => {
    const failing = (prefix: string, target: string, fails: number, since_ms: number) => {
      const at = home(prefix, { "connectors.github": { login: "person-a", route: "github-api" } });
      const copy = "github:person-a:cloud";
      at.source(copy, "github-api").land(copy, [item("contribution", "c1", NOW - 3 * DAY_MS)]).poll("github-api")
        .attempt(target, copy, "fail", "failing", { since_ms, fails }).done();
      return reportOf(at.root);
    };
    const early = failing("lifestream-report-early-", "fetch:github-api", 2, NOW - 5 * MINUTE);
    const late = failing("lifestream-report-late-", "fetch:github-api", 3, NOW - 20 * MINUTE);
    const page = failing("lifestream-report-page-", "page:github-api", 3, NOW - 20 * MINUTE);
    summary.failing = { early: connectorOf(early, "github").health, late: connectorOf(late, "github").health, page: connectorOf(page, "github").health };
    expect([healthOf(connectorOf(early, "github").health), early.needs]).toEqual([["waiting", "retrying"], []]);
    expect([healthOf(connectorOf(late, "github").health), needIds(late.needs)]).toEqual([["broken", "failing"], ["fetch:github-api:github:person-a:cloud"]]);
    expect([healthOf(connectorOf(page, "github").health), needIds(page.needs)]).toEqual([["broken", "failing"], ["page:github-api:github:person-a:cloud"]]);
    expect(connectorOf(page, "github").health.acts).toEqual([{ do: "try", label: "Try now", need: "poll:github-api" }]);
  });

  it("13. one account's failure stays its own: a lane failing for one account and reading another raises that copy's need alone", () => {
    const at = home("lifestream-report-accounts-");
    const [a, b] = ["claude:person-a@example.com:browser", "claude:person-c@example.com:browser"];
    at.source(a, "claude-browser", { lane: "claude-browser" }).source(b, "claude-browser", { lane: "claude-browser" }).land(b, [item("conversation", "k1", NOW - HOUR)])
      .poll("claude-browser").attempt("fetch:claude-browser", a, "need", "signed-out", { since_ms: NOW - HOUR, facts: { site: "claude.example.com" } })
      .attempt("fetch:claude-browser", b, "ok", null, { since_ms: NOW - MINUTE }).done();
    const report = reportOf(at.root, { chosen: ["claude"] });
    const claude = connectorOf(report, "claude");
    summary.accounts = { copies: claude.copies.map((copy) => [copy.id, copy.health]), needs: report.needs };
    expect(claude.copies.map((copy) => [copy.id, healthOf(copy.health)])).toEqual([[a, ["needs-you", "signed-out"]], [b, ["ok", null]]]);
    expect(report.needs.map((need) => [need.id, need.copy, need.at])).toEqual([[`fetch:claude-browser:${a}`, a, { site: "claude.example.com", open: null, errand: null }]]);
  });

  it("16. a declined grant is a need, not a row: one need naming the phone; the phone turned off for it, none", () => {
    const build = (prefix: string, settings: JsonObject = {}) => {
      const at = home(prefix, settings);
      const copy = `apple-photos:person-a@example.com:${MAC_B}`;
      at.device(MAC_B, "MacBook Air").device(PHONE, "iPhone 17 Pro").pass(MAC_B, "mac", [copy]).pass(PHONE, "phone", [`location:local:${PHONE}`]).source(copy, "photos-mac");
      at.land(copy, [item("photo", "p1", NOW - HOUR)]).delivery(copy, NOW - MINUTE, { left: 0, start_ms: null }).done();
      return reportOf(at.root, { stated: {
        [MAC_B]: said(at.passOf(MAC_B), { photos: "on" }, NOW - MINUTE), [PHONE]: said(at.passOf(PHONE), { photos: "off" }, NOW - MINUTE),
      } as Stated });
    };
    const declined = build("lifestream-report-declined-");
    const photos = connectorOf(declined, "apple-photos");
    const off = build("lifestream-report-declined-off-", { "sources.off": [`apple-photos:person-a@example.com:${PHONE}`] });
    summary.declined = { needs: declined.needs, health: photos.health, copies: photos.copies.length, off: off.needs };
    expect(healthOf(photos.health)).toEqual(["ok", null]);
    expect(photos.copies.map((copy) => copy.id)).toEqual([`apple-photos:person-a@example.com:${MAC_B}`]);
    expect(declined.needs.map((need) => [need.id, need.state, need.reason, need.words, need.connector, need.copy, need.unit, need.acts])).toEqual([
      [`grant:photos:${PHONE}`, "needs-you", "grant", "Allow Photos", "apple-photos", null, PHONE, [{ do: "grant", label: "Allow", unit: PHONE, grant: "photos" }]],
    ]);
    expect(off.needs).toEqual([]);
  });

  it("16b. a grant off on a Mac that several streams wait on is one need of that Mac, naming each stream; a grant one stream waits on, its own", () => {
    const at = home("lifestream-report-shared-grant-");
    at.device(MAC_A, "MacBook Pro").pass(MAC_A, "mac", [`upload:local:${MAC_A}`]).device(MAC_B, "MacBook Air").pass(MAC_B, "mac", [`upload:local:${MAC_B}`]).done();
    const found = ["imessage", "apple-notes", "apple-calendar", "input"];
    const connectors = [...DECLARED.filter((each) => !found.includes(each.id)), ...found.map((id) => declarations().find((each) => each.id === id)!)];
    const report = reportOf(at.root, { connectors, stated: {
      [MAC_A]: said(at.passOf(MAC_A), { fullDiskAccess: "on", accessibility: "on" }, NOW - MINUTE, found),
      [MAC_B]: said(at.passOf(MAC_B), { fullDiskAccess: "off", accessibility: "off" }, NOW - MINUTE, found),
    } });
    const grants = report.needs.filter((need) => need.reason === "grant");
    summary.sharedGrant = grants;
    const pageOrder = report.connectors.map((each) => each.id).filter((id) => ["imessage", "apple-notes", "apple-calendar"].includes(id));
    expect(grants.map((need) => [need.id, need.words, need.line, need.connector, need.streams, need.unit, need.acts]).sort()).toEqual([
      [`grant:accessibility:${MAC_B}`, "Allow Accessibility", "MacBook Air", "input", ["input"], MAC_B,
        [{ do: "grant", label: "Allow", unit: MAC_B, grant: "accessibility" }]],
      [`grant:fullDiskAccess:${MAC_B}`, "Allow Full Disk Access", "MacBook Air", null, pageOrder, MAC_B,
        [{ do: "grant", label: "Allow", unit: MAC_B, grant: "fullDiskAccess" }]],
    ]);
    expect(pageOrder).toHaveLength(3);

    const alone = home("lifestream-report-shared-grant-again-");
    const notes = `apple-notes:local:${MAC_B}`;
    const calendar = `apple-calendar:local:${MAC_B}`;
    alone.device(MAC_B, "MacBook Air").pass(MAC_B, "mac", [notes, calendar]).source(notes, "notes-mac").source(calendar, "calendar-mac");
    alone.land(notes, [item("note", "n1", NOW - HOUR)]).land(calendar, [item("event", "e1", NOW - HOUR)]).done();
    const again = reportOf(alone.root, { connectors, stated: {
      [MAC_B]: said(alone.passOf(MAC_B), { fullDiskAccess: "off" }, NOW - MINUTE, ["apple-notes", "apple-calendar"]),
    } });
    summary.sharedGrantAgain = again.needs;
    const both = again.connectors.map((each) => each.id).filter((id) => id === "apple-notes" || id === "apple-calendar");
    expect([connectorOf(again, "apple-notes").set_up, connectorOf(again, "apple-calendar").set_up]).toEqual([false, false]);
    expect(again.needs.filter((need) => need.reason === "grant").map((need) => [need.id, need.state, need.words, need.connector, need.streams, need.unit, need.acts])).toEqual([
      [`grant:fullDiskAccess:${MAC_B}`, "needs-you", "Allow Full Disk Access", null, both, MAC_B, [{ do: "grant", label: "Allow", unit: MAC_B, grant: "fullDiskAccess" }]],
    ]);
  });

  it("17. a Mac connector that declares no app counts as found on a Mac that does not find its source, or one that does is not; a source is worded as what it is", () => {
    const at = home("lifestream-report-found-");
    at.device(MAC_B, "MacBook Air").pass(MAC_B, "mac", [`upload:local:${MAC_B}`]).done();
    const way = (id: string, found: string[] | null) => connectorOf(reportOf(at.root, { stated: { [MAC_B]: said(at.passOf(MAC_B), { screenRecording: "on", fullDiskAccess: "on" }, NOW - MINUTE, found) } }), id)
      .ways.find((each) => each.road === "mac");
    summary.found = { none: way("screen", []), screen: way("screen", ["screen"]), unsaid: way("screen", null), whatsapp: way("whatsapp", []) };
    expect(way("screen", [])).toEqual({ road: "mac", ready: false, requirements: [{ kind: "app", met: false, words: "Screen isn’t on MacBook Air", line: null, act: null },
      { kind: "grant", met: true, words: "Allowed on MacBook Air", line: null, act: null }] });
    expect(way("screen", ["screen"])).toMatchObject({ ready: true, requirements: [{ kind: "app", met: true, words: "Found on MacBook Air" }, { kind: "grant", met: true }] });
    expect(way("whatsapp", [])?.requirements[0]).toEqual({ kind: "app", met: false, words: "Install WhatsApp on MacBook Air", line: "Lifestream finds it on its own once it’s installed.", act: null });
    expect(way("screen", null)?.requirements[0]).toEqual({ kind: "app", met: false, words: "Checking MacBook Air…", line: null, act: null });
  });

  it("18. a file a Mac holds is worded by the home: one joined to an import (its seal under its pass) is the import's, one in already said so, the rest the kind's (another pass's same seal among them); the question names the stamp; an asked import's file can be let go", () => {
    const at = home("lifestream-report-mac-imports-");
    const LANE = `upload:local:${MAC_B}`;
    const [ASKED, BEFORE] = ["a000000000000003", "a000000000000004"];
    const DIGEST = "ab".repeat(32);
    at.device(MAC_B, "MacBook Air").pass(MAC_B, "mac", [LANE])
      .delivery(LANE, NOW - HOUR, { import: { kind: "google-takeout" } }, { id: "upload/takeout-0007", seal: 7, pass: at.passOf(MAC_B) })
      .meta(`${IMPORT_OF}upload/takeout-0007`, ASKED)
      .imports({
        [ASKED]: { kind: "google-takeout", account: null, stamp: "20261004T080000Z", time_ms: Date.parse("2026-10-04T08:00:00Z"), at_ms: NOW - HOUR, deliveries: ["upload/takeout-0007"] },
        [BEFORE]: { kind: "google-takeout", account: "person-a@example.com", stamp: "20260904T080000Z", time_ms: Date.parse("2026-09-04T08:00:00Z"), at_ms: NOW - 40 * DAY_MS, deliveries: [] },
      })
      .meta(FILES, JSON.stringify({ [`google-takeout/${DIGEST}`]: { import: BEFORE, delivery: "upload/takeout-0001", at_ms: NOW - 3 * DAY_MS } }))
      .listed("upload/takeout-0007", { kind: "google-takeout", hash: "synthetic", files: [{ path: "takeout-20261004T080000Z-3-001.zip", bytes: 1_000_000 }], products: [], routes: [] })
      .done();
    const facts: MacImport = { kind: "google-takeout", files: [
      ...TAKEOUT_MAC.files.slice(0, 2), { ...TAKEOUT_MAC.files[2]!, seal: 7, pass: at.passOf(MAC_B) }, macFile("file-06", "takeout-20260904T080000Z-1-001.zip", 4_096, "waiting", "turn", { sha256: DIGEST }),
      macFile("file-07", "takeout-20261004T080000Z-4-001.zip", 2_048, "sent", null, { seal: 7, pass: "pass-before" }),
    ] };
    const report = reportOf(at.root, { stated: { [MAC_B]: said(at.passOf(MAC_B), null, NOW - MINUTE, [], [facts]) } });
    const takeout = report.imports.find((each) => each.kind === "google-takeout")!;
    summary.macImports = { takeout, needs: report.needs };
    expect(takeout.coming.map((file) => [file.id, file.state, file.words, file.line])).toEqual([
      ["file-01", "waiting", "Waiting", "plug in your Mac"], ["file-02", "sending", "Sending", "250\u00a0MB of 1.0\u00a0GB"],
      ["file-06", "already", "Already imported", dayWords(NOW - 3 * DAY_MS, NOW, DAY)], ["file-07", "sent", "Imported", "2\u00a0KB"],
    ]);
    expect(takeout.line).toBe("Sending · 2 of 4\u00a0files");
    const asked = takeout.held.find((each) => each.id === ASKED)!;
    expect([asked.account, asked.ask, asked.products, asked.files.map((file) => [file.state, file.words, file.acts.map((act) => act.do)])]).toEqual([
      null, { words: "Whose Google account is this Takeout from 4 Oct?", choices: ["person-a@example.com"], other: true, choose: "Choose", another: "Another…" }, [], [["held", "Imported", ["let-go"]]]]);
    expect(report.needs.filter((need) => need.connector === "google-takeout").map((need) => [need.id, need.state, need.reason, need.words, need.acts])).toEqual([
      [`import:${ASKED}:whose`, "needs-you", "choose", "Whose Google account is this Takeout from 4 Oct?", [{ do: "import", label: "Choose", kind: "google-takeout" }]],
    ]);
  });

  it("19. an export's Comes from row says its newest import, brought in on the day the home took it (never the day it was made), and a labeler that held is installed after a deploy; one that says it is not, is not", () => {
    const at = home("lifestream-report-handed-");
    const SPOTIFY = "spotify:person-a:export";
    const FACES = "faces:local:labels";
    const [IN, DELIVERY, FILE] = ["a000000000000005", "upload/spotify-0001", "my_spotify_data.zip"];
    const [OLDER, OLDER_DELIVERY] = ["a000000000000004", "upload/spotify-0000"];
    const listing = { kind: "spotify", hash: "synthetic", files: [{ path: FILE, bytes: 4_096 }],
      products: [{ id: "spotify", name: "Spotify", reads: true, files: [FILE], unclaimed: 0, activity: null }],
      routes: [{ of: "spotify", members: "**/Streaming_History_*.json", product: "spotify", copy: "export", connector: "spotify-export", files: [FILE] }] };
    at.source(SPOTIFY, "spotify-export").land(SPOTIFY, [item("play", "s1", NOW - 40 * DAY_MS)])
      .delivery(SPOTIFY, NOW - 9 * DAY_MS, { import: { kind: "spotify" } }, { id: OLDER_DELIVERY })
      .delivery(SPOTIFY, NOW - 2 * DAY_MS, { import: { kind: "spotify" } }, { id: DELIVERY })
      .imports({
        [IN]: { kind: "spotify", account: "person-a", stamp: null, time_ms: NOW - 40 * DAY_MS, at_ms: NOW - 2 * DAY_MS, deliveries: [DELIVERY] },
        [OLDER]: { kind: "spotify", account: "person-a", stamp: null, time_ms: NOW - 60 * DAY_MS, at_ms: NOW - 9 * DAY_MS, deliveries: [OLDER_DELIVERY] },
      })
      .listed(DELIVERY, listing).listed(OLDER_DELIVERY, listing)
      .tallied(DELIVERY, SPOTIFY, { days: { "2026-09-01": 3 }, kinds: { play: 3 } })
      .tallied(OLDER_DELIVERY, SPOTIFY, { days: { "2026-08-01": 7 }, kinds: { play: 7 } })
      .meta(`consumed:${DELIVERY}|${SPOTIFY}`, JSON.stringify([FILE])).meta(`consumed:${OLDER_DELIVERY}|${SPOTIFY}`, JSON.stringify([FILE]))
      .source(FACES, "face-engine").land(FACES, [item("photo", "f1", NOW - 3 * DAY_MS)]).done();
    const settled = reportOf(at.root);
    const removed = home("lifestream-report-models-gone-");
    removed.source(FACES, "face-engine").land(FACES, [item("photo", "f1", NOW - 3 * DAY_MS)])
      .attempt("label:face-engine", "", "need", "install", { since_ms: NOW - HOUR, contact_ms: null }).done();
    const gone = reportOf(removed.root);
    const spotify = connectorOf(settled, "spotify");
    const faces = (report: StreamsReport) => connectorOf(report, "faces");
    const kind = settled.imports.find((each) => each.kind === "spotify")!;
    summary.handed = { spotify: [spotify.health, spotify.ways, spotify.export], kind, faces: [faces(settled).ways, faces(gone).health], needs: [settled.needs, gone.needs] };
    const brought = `Imported ${dayWords(NOW - 2 * DAY_MS, NOW, DAY)}`;
    expect([spotify.set_up, spotify.ways[0]?.ready, spotify.export]).toEqual([true, true, { import: "spotify", name: "Spotify", icon: kind.icon, opens: false, line: brought }]);
    expect([kind.line, kind.reads, kind.held.map((each) => [each.id, each.line, each.files, each.products.map((product) => [product.id, product.state, product.line])])]).toEqual([
      brought, release("spotify").records, [[IN, nb("Imported · 3 plays"), [], [["spotify", "read", nb("Spotify · 3 plays")]]], [OLDER, nb("Imported · 7 plays"), [], [["spotify", "read", nb("Spotify · 7 plays")]]]]]);
    expect(faces(settled).ways).toEqual([{ road: "label", ready: true, requirements: [{ kind: "install", met: true, words: "Installed", line: null, act: null }] }]);
    expect(settled.needs).toEqual([]);
    expect([healthOf(faces(gone).health), faces(gone).health.words, needIds(gone.needs)]).toEqual([["needs-you", "install"], "Get the face models again", ["setup:faces:install"]]);
  });

  it("20. refused input asks once, Skip it, until the person gives it up: a fetched copy's own delivery no need; a Takeout's refusals by the member each is in, its line, products and need one count, its last read's", () => {
    const GMAIL = "gmail:person-a@example.com:cloud";
    const [MAIL, ACTIVITY] = ["gmail:person-a@example.com:export", "google-takeout:person-a@example.com:export"];
    const [TAKEN, DELIVERY] = ["a000000000000006", "upload/takeout-0005"];
    const ZIP = "takeout-20261012T080000Z-1-001.zip";
    const [SEARCH, YOUTUBE] = [`${ZIP}/Takeout/My Activity/Search/MyActivity.json`, `${ZIP}/Takeout/My Activity/YouTube/MyActivity.json`];
    const MBOX = `${ZIP}/Takeout/Mail/All mail Including Spam and Trash.mbox`;
    const build = (prefix: string, state: string) => {
      const at = home(prefix, { "connectors.gmail": { account: "person-a@example.com", route: "gmail-imap" } });
      at.source(GMAIL, "gmail-imap").land(GMAIL, [item("email", "g1", NOW - HOUR)]).poll("gmail-imap")
        .delivery(GMAIL, NOW - 2 * DAY_MS, {}, { refused: 2, state }).delivery(GMAIL, NOW - HOUR);
      const first = at.ran(`${ACTIVITY} ${DELIVERY}`, { refused: 2, refusals: [{ kind: "file", key: `${SEARCH}[0]`, violations: ["synthetic"] }, { kind: "file", key: YOUTUBE, violations: ["synthetic"] }] });
      const mailRun = at.ran(`${MAIL} ${DELIVERY}`, { refused: 12, refusals: Array.from({ length: 10 }, (_, index) => ({ kind: "file", key: `${MBOX}:message ${index + 1} at byte ${index * 100}`, violations: ["synthetic"] })) });
      for (const [copy, read, run, refused] of [[MAIL, "gmail-takeout", mailRun, 12], [ACTIVITY, "takeout", first, 1]] as const) {
        at.source(copy, read).delivery(copy, NOW - 3 * DAY_MS, { import: { kind: "google-takeout" } }, { id: DELIVERY, refused, state, run });
      }
      at.tallied(DELIVERY, MAIL, { days: {}, kinds: {}, refused: { count: 12, members: { [MBOX]: 12 } } })
        .tallied(DELIVERY, ACTIVITY, { days: {}, kinds: {}, refused: { count: 1, members: { "Takeout/My Activity/YouTube": 1 } } })
        .imports({ [TAKEN]: { kind: "google-takeout", account: "person-a@example.com", stamp: "20261012T080000Z", time_ms: Date.parse("2026-10-12T08:00:00Z"), at_ms: NOW - 3 * DAY_MS, deliveries: [DELIVERY] } })
        .listed(DELIVERY, {
          kind: "google-takeout", hash: "synthetic", files: [{ path: ZIP, bytes: 4_096 }],
          products: [{ id: "mail", name: "Mail", reads: true, files: [ZIP], unclaimed: 0, activity: null }, { id: "my-activity", name: "My Activity", reads: true, files: [ZIP], unclaimed: 0, activity: "json" }],
          routes: [
            { of: "mail", members: "Takeout/Mail/**/*.mbox", folder: "Mail", product: "gmail", copy: "export", connector: "gmail-takeout", files: [ZIP] },
            { of: "my-activity", members: "Takeout/My Activity/**", folder: "My Activity", product: "google-takeout", copy: "export", connector: "takeout", files: [ZIP] },
          ],
        }).done();
      return reportOf(at.root);
    };
    const refused = build("lifestream-report-refused-", "imported");
    const given = build("lifestream-report-given-up-", "dead");
    const takeoutOf = (report: StreamsReport) => report.imports.find((each) => each.kind === "google-takeout")!.held[0]!;
    summary.refused = { needs: refused.needs, given: given.needs, held: takeoutOf(refused), gave: takeoutOf(given) };
    expect(refused.needs.map((need) => [need.id, need.state, need.reason, need.words, need.copy, need.acts]), "a fetched copy's refused rows are no need: only a hand-in's are").toEqual([
      [`import:${TAKEN}:refused`, "needs-you", "import", nb("Couldn't read 2 files"), null, [{ do: "skip", label: "Skip it", need: `import:${TAKEN}:refused` }]],
    ]);
    const held = takeoutOf(refused);
    expect([held.line, held.products.map((product) => [product.id, product.state, product.line]), held.files.map((file) => [file.name, file.state, file.line, file.acts.map((act) => act.do)])]).toEqual([
      nb("Imported · 2 files couldn’t be read"), [["mail", "partly", nb("Gmail · 1 file couldn’t be read")], ["my-activity", "partly", nb("Google Search · 1 file couldn’t be read")]],
      [[ZIP, "kept", nb("2 files couldn't be read"), ["let-go"]]],
    ]);
    expect(given.needs).toEqual([]);
    const gave = takeoutOf(given);
    expect([gave.health.state, gave.line, gave.products.map((product) => [product.id, product.state, product.line])]).toEqual([
      "ok", "Imported", [["mail", "skipped", nb("Gmail · 1 file skipped")], ["my-activity", "skipped", nb("Google Search · 1 file skipped")]]]);
  });

  it("21. a form never filled here is to set up though a copy held; emptied after its acquirer ran here, it is a need, said again", () => {
    const GITHUB = "github:person-a:cloud";
    const build = (prefix: string, ran: boolean) => {
      const at = home(prefix);
      at.source(GITHUB, "github-api").land(GITHUB, [item("contribution", "gh1", NOW - 90 * DAY_MS)]);
      if (ran) at.poll("github-api");
      return reportOf(at.done().root);
    };
    const never = build("lifestream-report-form-never-", false);
    const emptied = build("lifestream-report-form-emptied-", true);
    const github = (report: StreamsReport) => connectorOf(report, "github");
    summary.form = { never: [github(never).health, never.needs], emptied: [github(emptied).health, emptied.needs] };
    expect([healthOf(github(never).health), github(never).health.words, never.needs]).toEqual([["setup", "form"], "Set up GitHub", []]);
    expect([healthOf(github(emptied).health), github(emptied).health.words, needIds(emptied.needs)]).toEqual([["needs-you", "form"], "Set up GitHub again", ["setup:github:form"]]);
  });

  it("26. a site set up by a form asks it first, Set up its email, then Turn on; once filled, Turn on alone; chosen, ready", () => {
    const build = (prefix: string, settings: JsonObject, chosen: string[]) => {
      const at = home(prefix, settings);
      at.device(BROWSER, "Chrome").pass(BROWSER, "extension").done();
      return connectorOf(reportOf(at.root, { present: [BROWSER], chosen }), "whoop").ways;
    };
    const never = build("lifestream-report-site-form-never-", {}, []);
    const typed = build("lifestream-report-site-form-typed-", { "connectors.whoop": { email: "person-a@example.com" } }, []);
    const chosen = build("lifestream-report-site-form-chosen-", { "connectors.whoop": { email: "person-a@example.com" } }, ["whoop"]);
    summary.siteForm = { never, typed, chosen };
    const shown = (ways: typeof never) => ways.map((way) => [way.road, way.ready, way.requirements.map((each) => [each.kind, each.met, each.act])]);
    expect(shown(never)).toEqual([["chrome", false, [["form", false, { do: "set", label: "Set up", member: "email" }], ["choose", false, { do: "turn", label: "Connect", ids: ["whoop"] }]]]]);
    expect(shown(typed)).toEqual([["chrome", false, [["choose", false, { do: "turn", label: "Connect", ids: ["whoop"] }]]]]);
    expect(shown(chosen)).toEqual([["chrome", true, [["choose", true, null]]]]);
  });

  it("22. a grant the phone cannot say is met by the copy its pass delivers: Health asked is allowed; stated off, it is a need", () => {
    const HEALTH = "apple-health:person-a@example.com:cloud";
    const build = (prefix: string, health: "asked" | "off") => {
      const at = home(prefix);
      at.device(PHONE, "iPhone 17 Pro").pass(PHONE, "phone", [HEALTH]).source(HEALTH, "health-ios-bundle").land(HEALTH, [item("sample", "h1", NOW - HOUR)]).done();
      return reportOf(at.root, { stated: { [PHONE]: said(at.passOf(PHONE), { health }, NOW - MINUTE) } as Stated });
    };
    const asked = build("lifestream-report-health-asked-", "asked");
    const off = build("lifestream-report-health-off-", "off");
    const health = (report: StreamsReport) => connectorOf(report, "apple-health");
    summary.health = { asked: [health(asked).health, health(asked).ways, asked.needs], off: [health(off).health, off.needs] };
    expect([health(asked).set_up, healthOf(health(asked).health), asked.needs]).toEqual([true, ["ok", null], []]);
    expect(off.needs.map((need) => [need.id, need.state, need.words])).toEqual([[`grant:health:${PHONE}`, "needs-you", "Allow Health"]]);
  });

  it("28. LLM processing: a work's part in every shape, its range's steps what each would read and cost, its menu the routes that serve it and are suggested or in use, then More; an item's Made in every state (the item fixture)", () => {
    const WHATSAPP = `whatsapp:+15550000001:${MAC_B}`;
    const at = home("lifestream-report-processing-", DEFAULTS);
    const REPLY = `${VISION.id}/${CAPTION_PROMPT}/reply-0`;
    at.source(WHATSAPP, "whatsapp-mac").models(ROUTES, [RUNNER]).replied(VISION, CAPTION_PROMPT, 20, 0.6)
      .asks("whatsapp/photos", CAPTION_PROMPT, [
        { item: chatFile(1), at_ms: NOW - 6 * HOUR }, { item: chatFile(2), at_ms: NOW - 40 * DAY_MS }, { item: chatFile(3), at_ms: NOW - 400 * DAY_MS },
        { item: chatFile(4), at_ms: NOW - 2 * HOUR, state: "given-up" }, { item: chatFile(6), at_ms: NOW - DAY_MS, state: "done", content: "synthetic caption", reply_key: REPLY },
      ])
      .asks("whatsapp/voice", TRANSCRIPT_PROMPT, [{ item: chatFile(5), at_ms: NOW - 3 * HOUR }]).done();
    const whatsapp = () => connectorOf(reportOf(at.root), "whatsapp");
    const rows = () => whatsapp().processing!.rows.map((row) => [row.member, row.shape, row.line]);
    const set = (block: JsonObject) => planned(at.root, { "connectors.whatsapp": block }).write();
    const GIVEN_UP = "1\u00a0could not be processed";
    expect(rows()).toEqual([
      ["llm.photos", "running", `${nb("2 photos left")} · about\u00a05\u00a0min · about\u00a0$1 · ${GIVEN_UP}`],
      ["llm.voice", "needs", "Connect a model that takes audio"],
      ["llm.range", null, null],
    ]);
    const status = statusOf(at.root, { now_ms: NOW, settings: readOpsSettings(at.root), connectors: DECLARED, families: familiesOf(at.root) });
    expect(status.works.map((work) => [work.connector, work.member, work.shape, work.line])).toEqual(rows().slice(0, 2).map((row) => ["whatsapp", ...row]));
    expect(renderStatus(status, DAY)).toContain(`LLM processing\n  Photo descriptions (whatsapp): ${nb("2 photos left")} · about\u00a05\u00a0min`);
    const members = whatsapp().members;
    expect(members.find((member) => member.key === "llm.range")!.steps!.map((step) => [step.value, step.words, step.note])).toEqual([
      ["2026-10-28", "New only", "Nothing to read"], ["2026-09-28", "Last 30 days", `${nb("1 photo")} · about\u00a0$1`],
      ["2025-10-28", "Last year", `${nb("2 photos")} · about\u00a0$1`], ["all", "All time", `${nb("3 photos")} · about\u00a0$2`],
    ]);
    expect(members.find((member) => member.key === "llm.photos")).toMatchObject({
      words: "Default · Vision One", panel: null,
      steps: null, control: "menu",
      menu: {
        default: { value: "default", name: "Default · Vision One", account: null, chosen: true },
        rows: [{ value: VISION.id, name: "Vision One", account: null, chosen: false }],
        local: { label: MENU.local, rows: [{ value: QWEN.id, name: "Qwen 3.5", account: null, chosen: false }] },
        more: { words: MENU.more, use: "pictures", work: "whatsapp/photos" },
        off: { value: "off", name: MENU.off, account: null, chosen: false },
      },
    });
    expect(typedNote(at.root, "2026-09-01")).toBe(`${nb("2 photos")} · about\u00a0$1`);
    const made = (file: number) => {
      const read = openHome(openHomeFolder(at.root), "read");
      const view = read.view();
      try {
        const { connectors: blocks, defaults, runners } = effective(at.root).settings;
        return openMade(view, {
          connectors: DECLARED, blocks, defaults, runners, day: DAY, now_ms: NOW,
          reply: (key) => key === REPLY ? { model: VISION.model, created_ms: NOW - 5 * MINUTE } : undefined,
        })({ family: MESSAGES_FAMILY, item: chatFile(file) });
      } finally {
        view.close();
        read.close();
      }
    };
    const VISION_STEP = { value: VISION.id, words: "Vision One", note: "Sent to OpenRouter" };
    const QWEN_STEP = { value: QWEN.id, words: "Qwen 3.5", note: "Stays on MacBook Pro" };
    const ask = (file: number, prompt = CAPTION_PROMPT) => ({ family: MESSAGES_FAMILY, item: chatFile(file), prompt });
    const items = {
      done: made(6), queued: made(1), older: made(3), failed: made(4), needs: made(5), none: made(7),
    } as Record<string, unknown>;
    expect(items).toEqual({
      done: { by: "Vision One", at_ms: NOW - 5 * MINUTE, state: "done", line: "Vision One · 28 Oct", ask: ask(6), choose: [QWEN_STEP] },
      queued: { by: null, at_ms: null, state: "waiting", line: "In the queue", ask: ask(1), choose: [VISION_STEP] },
      older: { by: null, at_ms: null, state: "off", line: "Older than this stream's range", ask: ask(3), choose: [VISION_STEP] },
      failed: { by: null, at_ms: null, state: "failed", line: "Could not be processed", ask: ask(4), choose: [QWEN_STEP] },
      needs: { by: null, at_ms: null, state: "needs", line: "Connect a model that takes audio", ask: ask(5, TRANSCRIPT_PROMPT), choose: [] },
      none: { by: null, at_ms: null, state: "off", line: null, ask: null, choose: [] },
    });
    set({ "llm.photos": PLAN.id });
    expect(rows()[0]).toEqual(["llm.photos", "waiting", `Your Claude plan is used up · resets 14:00 · ${GIVEN_UP}`]);
    items.resting = made(1);
    expect(items.resting).toMatchObject({ state: "waiting", line: PLAN_LINE, choose: [] });
    set({ "llm.photos": "off", "llm.voice": "off" });
    expect(rows()).toEqual([["llm.photos", "off", null], ["llm.voice", "off", null], ["llm.range", null, null]]);
    items.off = made(1);
    expect(items.off).toMatchObject({ state: "off", line: null, choose: [VISION_STEP] });
    set({ "llm.range": "2026-10-28" });
    expect(rows()[0]).toEqual(["llm.photos", "done", `Up to date · ${GIVEN_UP}`]);
    const choose = (file: number, prompt: string, route: ModelRoute) => {
      const write = openHome(openHomeFolder(at.root), "migrate");
      try {
        return write.commit((tx) => {
          const { connectors: blocks, defaults } = effective(at.root).settings;
          const routing = readRouting(tx.tables, { connectors: DECLARED, blocks, defaults, runners: {}, day: DAY, now_ms: NOW });
          const found = chooseFor(tx.tables, routing, { family: MESSAGES_FAMILY, item: chatFile(file), prompt, route: route.id });
          if ("choice" in found) tx.tables.itemRoutes.set(found.choice);
          return "refused" in found ? found.refused : found.choice.route;
        });
      } finally {
        write.close();
      }
    };
    expect([choose(5, TRANSCRIPT_PROMPT, VISION), choose(6, CAPTION_PROMPT, PLAN)]).toEqual(["Vision One can't hear audio.", PLAN.id]);
    items.chosen = made(6);
    expect(items.chosen).toEqual({ by: "Vision One", at_ms: NOW - 5 * MINUTE, state: "waiting", line: PLAN_LINE, ask: ask(6), choose: [QWEN_STEP] });
    summary.processing = { rows: rows(), items };
    const fixture = `${JSON.stringify(items, null, 2)}\n`;
    if (WRITE_FIXTURES) writeFileSync(join(FIXTURES, "made.json"), fixture);
    expect(readFileSync(join(FIXTURES, "made.json"), "utf8"), "homelink/Tests/Fixtures/made.json is these items: LIFESTREAM_FIXTURES=write writes it").toBe(fixture);
  });
  it("29. LLM processing counts what is still to come: a step whose span a unit still to plan, a statement of the stream's own past its family's extract, or the stream's history still arriving reaches says so far, or Counting…, never Nothing to read; its work is never Up to date while it counts; a reply waiting for its re-plan, a unit set aside, another family's or another stream's, a start's extract with nothing to read, or a history done holds no count open", () => {
    const WHATSAPP = `whatsapp:+15550000001:${MAC_B}`;
    const IMESSAGE = `imessage:person-a@example.com:${MAC_B}`;
    const connectors = [...DECLARED, declarations().find((each) => each.id === "imessage")!];
    const at = home("lifestream-report-counting-", DEFAULTS);
    at.source(WHATSAPP, "whatsapp-mac").source(IMESSAGE, "imessage-db").models(ROUTES, [RUNNER]).replied(VISION, CAPTION_PROMPT, 20, 0.6)
      .asks("whatsapp/photos", CAPTION_PROMPT, [{ item: chatFile(2), at_ms: NOW - 40 * DAY_MS }, { item: chatFile(3), at_ms: NOW - 400 * DAY_MS }])
      .land(WHATSAPP, [item("msg", "w1", NOW - 100 * DAY_MS)]).land(IMESSAGE, [item("msg", "i1", NOW - 2 * HOUR)]).done();
    const set = (block: JsonObject) => planned(at.root, { "connectors.whatsapp": block }).write();
    set({ "llm.range": "all" });
    const write = (work: (db: Database.Database) => void) => {
      const db = new Database(join(at.root, "home.db"));
      try {
        work(db);
      } finally {
        db.close();
      }
    };
    const seqOf = (source: string) => readHome(at.root, (db) => db.prepare("SELECT max(seq) FROM statements WHERE source = ?").pluck().get(source) as number);
    const extracted = (seq: number | null) => write((db) => {
      db.prepare("DELETE FROM cursors WHERE name = 'extract:messages'").run();
      if (seq !== null) db.prepare("INSERT INTO cursors (name, seq, reread, at_ms) VALUES ('extract:messages', ?, 0, ?)").run(seq, NOW);
    });
    const still = (units: { family?: string; end_ms: number | null; woken?: boolean; error?: string }[]) => write((db) => {
      db.exec("DELETE FROM dirty_units");
      units.forEach((unit, n) => db.prepare("INSERT INTO dirty_units (family, unit, end_ms, woken, error) VALUES (?, ?, ?, ?, ?)")
        .run(unit.family ?? MESSAGES_FAMILY, `${WHATSAPP}/unit-${n}`, unit.end_ms, unit.woken === true ? 1 : 0, unit.error ?? null));
    });
    const sent = (left: number, sealed_ms: number) => {
      write((db) => db.prepare("INSERT INTO deliveries (id, source, sealed_ms, stated_ms, facts, state) VALUES (?, ?, ?, ?, ?, 'imported')")
        .run(`${WHATSAPP}/history-${sealed_ms}`, WHATSAPP, sealed_ms, sealed_ms, JSON.stringify({ left })));
      const home = openHome(openHomeFolder(at.root), "migrate");
      try {
        home.commit((tx) => deliveryLeft(tx, WHATSAPP, { left }, sealed_ms));
      } finally {
        home.close();
      }
    };
    const read = (id = "whatsapp") => {
      const part = connectorOf(reportOf(at.root, { connectors }), id);
      const [photos] = part.processing!.rows;
      return { line: [photos!.shape, photos!.line], notes: part.members.find((member) => member.key === "llm.range")!.steps!.map((step) => step.note) };
    };
    const WHOLE = {
      line: ["running", `${nb("2 photos left")} · about\u00a05\u00a0min · about\u00a0$1`],
      notes: ["Nothing to read", "Nothing to read", `${nb("1 photo")} · about\u00a0$1`, `${nb("2 photos")} · about\u00a0$1`],
    };
    const COUNTING = {
      line: ["running", `Counting what's left · ${nb("2 photos")} so far`],
      notes: ["Counting…", "Counting…", `${nb("1 photo")} so far`, `${nb("2 photos")} so far`],
    };
    extracted(null);
    expect(read()).toEqual(COUNTING);
    extracted(seqOf(WHATSAPP));
    expect([read(), read("imessage").notes]).toEqual([WHOLE, ["Counting…", "Counting…", "Counting…", "Counting…"]]);
    extracted(seqOf(IMESSAGE));
    expect([read(), read("imessage").notes]).toEqual([WHOLE, ["Nothing to read", "Nothing to read", "Nothing to read", "Nothing to read"]]);
    write((db) => {
      for (const family of familiesOf(at.root)) db.prepare("INSERT INTO jobs (kind, key, lane, state, not_before_ms, created_ms) VALUES ('extract', ?, 2, 'queued', ?, ?)").run(family.name, NOW, NOW);
    });
    expect(read()).toEqual(WHOLE);
    still([{ end_ms: null }]);
    expect(read()).toEqual(COUNTING);
    still([{ end_ms: NOW - 2 * HOUR, woken: true }]);
    expect(read()).toEqual(WHOLE);
    still([{ end_ms: NOW - 2 * HOUR, woken: true }, { end_ms: NOW - 20 * DAY_MS }, { end_ms: NOW - 500 * DAY_MS }]);
    expect(read()).toEqual({ line: COUNTING.line, notes: ["Nothing to read", "Counting…", `${nb("1 photo")} so far`, `${nb("2 photos")} so far`] });
    still([{ end_ms: NOW - 2 * HOUR, error: "synthetic plan error" }, { family: "mail", end_ms: NOW - 2 * HOUR }]);
    expect(read()).toEqual(WHOLE);
    still([]);
    sent(120, NOW - 10 * MINUTE);
    expect(read()).toEqual({ line: COUNTING.line, notes: ["Nothing to read", "Nothing to read", `${nb("1 photo")} so far`, `${nb("2 photos")} so far`] });
    expect([typedNote(at.root, "2026-01-01"), typedNote(at.root, "2026-08-01")]).toEqual([`${nb("1 photo")} so far`, `${nb("1 photo")} · about\u00a0$1`]);
    sent(0, NOW - MINUTE);
    expect(read()).toEqual(WHOLE);
    set({ "llm.range": "2026-10-28" });
    expect(read().line).toEqual(["done", "Up to date"]);
    still([{ end_ms: NOW - 2 * HOUR }]);
    expect(read().line).toEqual(["running", "Counting what's left"]);
    const status = statusOf(at.root, { now_ms: NOW, settings: readOpsSettings(at.root), connectors, families: familiesOf(at.root) });
    expect(status.works.filter((work) => work.connector === "whatsapp" && work.member === "llm.photos").map((work) => [work.shape, work.line])).toEqual([["running", "Counting what's left"]]);
    set({ "llm.range": "all" });
    still([{ end_ms: NOW - 20 * DAY_MS }]);
    expect([typedNote(at.root, "2026-10-20"), typedNote(at.root, "2026-09-01")]).toEqual(["Nothing to read", `${nb("1 photo")} so far`]);
    summary.counting = { whole: WHOLE, counting: COUNTING };
  });

  it("through the door: the report and status carry one list of needs; the models read (connections, uses and rows) and a range's typed day are the home's (the models fixture)", async () => {
    const at = home("lifestream-report-door-", {
      "connectors.github": { login: "person-a", route: "github-api" }, ...DEFAULTS,
      "model.transports.address": { url: "http://127.0.0.1:8080/v1", input: ["text", "image"] },
    }, Date.now());
    const copy = "github:person-a:cloud";
    const chats = `whatsapp:+15550000001:${MAC_B}`;
    const now = Date.now();
    at.source(copy, "github-api").land(copy, [item("contribution", "c1", now - 3 * DAY_MS)]).poll("github-api")
      .attempt("fetch:github-api", copy, "fail", "failing", { since_ms: now - HOUR, fails: 4 })
      .source(chats, "whatsapp-mac").models(ROUTES, [RUNNER])
      .asks("whatsapp/photos", CAPTION_PROMPT, [{ item: chatFile(1), at_ms: now - 2 * DAY_MS }, { item: chatFile(2), at_ms: now - 20 * DAY_MS }]).done();
    const reader = mintPrincipal(openHomeFolder(at.root), { unit: "reader-report", scopes: ["read"], now_ms: now });
    const door = await doorHere(at.root, { registry: homeRegistryModule() });
    try {
      const get = async (path: string) => (await (await fetch(`${door.url}${path}`, { headers: { authorization: `Bearer ${reader.token}` } })).json()) as JsonObject;
      const report = await get("/v1/connectors") as unknown as StreamsReport;
      const status = await get("/v1/status") as unknown as { needs: Need[] };
      summary.door = { report: needIds(report.needs), status: needIds(status.needs) };
      expect(needIds(report.needs)).toContain(`fetch:github-api:${copy}`);
      expect(needIds(status.needs)).toEqual(needIds(report.needs));
      expect(report.needs.find((need) => need.id === `fetch:github-api:${copy}`)).toMatchObject({
        state: "broken", reason: "failing", words: "Couldn’t read GitHub", connector: "github", copy, acts: [{ do: "try", label: "Try now", need: "poll:github-api" }],
      });
      const { position: _position, ...models } = await get("/v1/models");
      const row = (route: ModelRoute, connection: string, group: string) => ({
        id: route.id, connection, model: route.model, name: route.name, input: route.input, tools: route.tools, thinking: route.thinking, context_tokens: route.context_tokens,
        chat: route.chat, suggested: route.suggested, group, leaves: route.leaves, state: route.state, line: route.line,
      });
      const runner = `runner:${RUNNER_UNIT}`;
      const listedRow = (route: ModelRoute, value: string | null) => ({ value: route.id, name: route.name, account: null, chosen: route.id === value });
      const use = (of: UseId, fits: ModelRoute[], value: string | null = null, rows: ModelRoute[] = [], local: ModelRoute[] = []) => ({
        value, thinking: null, fits: fits.map((each) => each.id),
        menu: {
          default: null, rows: rows.map((each) => listedRow(each, value)), local: local.length === 0 ? null : { label: MENU.local, rows: local.map((each) => listedRow(each, value)) },
          more: { words: MENU.more, use: of, work: null }, off: of === "chat" ? null : { value: "none", name: MENU.off, account: null, chosen: value === null },
        },
      });
      expect(models).toEqual({
        connections: [
          { id: runner, kind: "runner", name: "MacBook Pro", line: null },
          { id: "openrouter", kind: "key", name: "OpenRouter", line: null },
          { id: "claude", kind: "plan", name: "Claude", line: PLAN_LINE },
          { id: "address", kind: "address", name: "Other server", line: ADDRESS_WINDOW },
        ],
        uses: {
          pictures: use("pictures", [QWEN, VISION, PLAN], VISION.id, [VISION], [QWEN]), audio: use("audio", [PLAN, PARAKEET, NEMOTRON]), text: use("text", [VISION, PLAN, QWEN], null, [VISION]),
          chat: use("chat", []), search: use("search", []), hiding: use("hiding", []),
        },
        models: {
          [VISION.id]: row(VISION, "openrouter", "OpenRouter"), [PLAN.id]: row(PLAN, "claude", "Claude"),
          [QWEN.id]: row(QWEN, runner, "MacBook Pro"), [PARAKEET.id]: row(PARAKEET, runner, "MacBook Pro"), [NEMOTRON.id]: row(NEMOTRON, runner, "MacBook Pro"),
        },
      });
      const typed = new Date(now - 10 * DAY_MS).toISOString().slice(0, 10);
      expect(await get(`/v1/processing/range?connector=whatsapp&value=${typed}`)).toMatchObject({ value: typed, note: nb("1 photo") });
      expect(await get("/v1/processing/range?connector=github&value=2026-01-01")).toMatchObject({ code: "NO_PROCESSING" });
      const fixture = `${JSON.stringify(models, null, 2)}\n`;
      if (WRITE_FIXTURES) writeFileSync(join(FIXTURES, "models.json"), fixture);
      expect(readFileSync(join(FIXTURES, "models.json"), "utf8"), "homelink/Tests/Fixtures/models.json is this read: LIFESTREAM_FIXTURES=write writes it").toBe(fixture);
    } finally {
      await door.stop();
    }
  });
  it("24. My Activity that came as HTML is read, its line saying JSON holds more; a file of it as JSON, its export's, says nothing", () => {
    const ACTIVITY = "google-takeout:person-a@example.com:export";
    const DELIVERY = "upload/takeout-0006";
    const [ZIP, ZIP2] = ["takeout-20261012T080000Z-1-001.zip", "takeout-20261012T080000Z-2-001.zip"];
    const build = (prefix: string, json: boolean) => {
      const at = home(prefix);
      at.source(ACTIVITY, "takeout").delivery(ACTIVITY, NOW - 3 * DAY_MS, { import: { kind: "google-takeout" } }, { id: DELIVERY, state: "imported" });
      at.tallied(DELIVERY, ACTIVITY, { days: { "2026-10-01": 3 }, kinds: { activity: 3 } })
        .imports({ a000000000000007: { kind: "google-takeout", account: "person-a@example.com", stamp: "20261012T080000Z", time_ms: Date.parse("2026-10-12T08:00:00Z"), at_ms: NOW - 3 * DAY_MS, deliveries: [DELIVERY] } })
        .listed(DELIVERY, {
          kind: "google-takeout", hash: "synthetic",
          files: [ZIP, ...json ? [ZIP2] : []].map((file) => ({ path: file, bytes: 4_096 })),
          products: [{ id: "my-activity", name: "My Activity", reads: true, files: [ZIP], unclaimed: 0, activity: "html" },
            ...json ? [{ id: "my-activity", name: "My Activity", reads: true, files: [ZIP2], unclaimed: 0, activity: "json" as const }] : []],
          routes: [{ of: "my-activity", members: "Takeout/My Activity/**", folder: "My Activity", product: "google-takeout", copy: "export", connector: "takeout", files: json ? [ZIP, ZIP2] : [ZIP] }],
        }).done();
      return reportOf(at.root).imports.find((each) => each.kind === "google-takeout")!.held[0]!.products.find((product) => product.id === "my-activity")!;
    };
    const [html, json] = [build("lifestream-report-html-", false), build("lifestream-report-json-", true)];
    summary.html = { html, json };
    expect([html.state, html.line.endsWith(" · Came as HTML. Choose JSON next time: it holds more.")]).toEqual(["read", true]);
    expect([json.state, json.line.includes("HTML")]).toEqual(["read", false]);
  });

  it("25. a connector not offered yet is in no list, nor its need, nor its pause; a stream an import alone brings stands in its own section; two types share one section", () => {
    const at = home("lifestream-report-offered-");
    const COAST = `coast:local:${MAC_A}`;
    at.device(MAC_A, "MacBook Pro").source(COAST, "coast")
      .delivery(COAST, NOW - DAY_MS, {}, { state: "failed", failures: 2 }).pause("pause:coast", "a test", "you", NOW - HOUR).done();
    const release = declarations();
    const offered = release.map((each) => {
      const { hidden: _, ...shown } = each;
      return shown;
    });
    const report = reportOf(at.root, { connectors: release });
    const control = reportOf(at.root, { connectors: offered });
    const streams = report.connectors.filter((each) => each.shown === "stream");
    const groups = [...new Set(streams.map((each) => each.type!.key))];
    const pausedOf = (of: StreamsReport) => of.paused.map((pause) => pause.target);
    summary.offered = {
      hidden: release.filter((each) => each.hidden === true).map((each) => each.id), groups, needs: needIds(report.needs), control: needIds(control.needs),
      paused: pausedOf(report), controlPaused: pausedOf(control),
    };
    expect(release.filter((each) => each.hidden === true).map((each) => each.id).sort()).toEqual(["coast", "energy", "facebook", "instagram", "x"]);
    expect(report.connectors.filter((each) => ["coast", "energy", "facebook", "instagram", "x"].includes(each.id))).toEqual([]);
    expect(control.connectors.map((each) => each.id)).toEqual(expect.arrayContaining(["coast", "energy", "facebook", "instagram", "x"]));
    expect(needIds(control.needs)).toContain(`job:import:${COAST}`);
    expect(report.needs.filter((need) => need.connector === "coast")).toEqual([]);
    expect([pausedOf(control), pausedOf(report)]).toEqual([["pause:coast"], []]);
    expect(connectorOf(report, "google").type).toEqual({ key: "web", name: "Browsing", icon: "web" });
    expect(connectorOf(report, "google-photos").type!.key).toBe("photos");
    expect(streams.map((each) => each.type!.key).filter((key, at, all) => at === 0 || all[at - 1] !== key)).toEqual(groups);
    expect([connectorOf(report, "gmail").type, connectorOf(report, "google-calendar").type]).toEqual([
      { key: "mail", name: "Mail and calendar", icon: "mail" }, { key: "mail", name: "Mail and calendar", icon: "mail" }]);
    expect(release.find((each) => each.id === "google-calendar")!.type).toBe("plans");
    expect([connectorOf(report, "chrome").type, connectorOf(report, "safari").type]).toEqual([
      { key: "web", name: "Browsing", icon: "web" }, { key: "web", name: "Browsing", icon: "web" }]);
  });

  it("25b. connectors that join one row stand side by side in one section, each naming the row and the apps found; a member joins its host's section", () => {
    const at = home("lifestream-report-joins-");
    at.device(MAC_B, "MacBook Air").pass(MAC_B, "mac", [`upload:local:${MAC_B}`]).done();
    const report = reportOf(at.root, { connectors: declarations(), stated: { [MAC_B]: said(at.passOf(MAC_B), {}, NOW - MINUTE, ["wispr-flow"]) } });
    const joins = (id: string) => connectorOf(report, id).joins;
    const dictation = { name: "Dictation", icon: "voice-note", gives: "What you dictate with Wispr Flow or Aqua Voice.", apps: ["Wispr Flow"] };
    summary.joins = { wispr: joins("wispr-flow"), camera: joins("camera") };
    expect([joins("wispr-flow"), joins("aqua-voice")]).toEqual([dictation, dictation]);
    expect([joins("claude-code"), joins("codex")]).toEqual([null, null]);
    expect([joins("notes")?.name, joins("camera")?.name, connectorOf(report, "camera").type, joins("gmail")]).toEqual(["Lifestream notes", "Lifestream notes", connectorOf(report, "notes").type, null]);
    const ids = report.connectors.map((each) => each.id);
    expect([["wispr-flow", "aqua-voice"], ["camera", "notes"]].map(([one, other]) => Math.abs(ids.indexOf(one!) - ids.indexOf(other!)))).toEqual([1, 1]);
  });

  it("30. a client names no connector and builds no source id: a field's placeholder, the Mac grants, the recorder and the copy a Mac would make are the report's", () => {
    const at = home("lifestream-report-clients-");
    at.device(MAC_A, "MacBook Pro").pass(MAC_A, "mac", [`screen:local:${MAC_A}`]).device(MAC_B, "MacBook Air").pass(MAC_B, "mac", [`screen:local:${MAC_B}`]).done();
    const whoop = release("whoop");
    const hinted = { ...whoop, fields: { ...whoop.fields, email: { kind: "email", label: "WHOOP email", placeholder: "The email you sign in to WHOOP with" } } } as Connector;
    const connectors = declarations().map((each) => (each.id === "whoop" ? hinted : each));
    const asked = reportOf(at.root, { connectors, unit: MAC_A });
    const member = (id: string, key: string) => connectorOf(asked, id).members.find((each) => each.key === key)!;
    expect(member("whoop", "email").placeholder).toBe("The email you sign in to WHOOP with");
    expect("placeholder" in member("gmail", "account")).toBe(false);
    expect(asked.connectors.filter((each) => each.mac_grants.includes("photos")).map((each) => each.id)).toEqual(["apple-photos"]);
    expect([connectorOf(asked, "screen").mac_grants, connectorOf(asked, "gmail").mac_grants]).toEqual([["screenRecording"], []]);
    expect(asked.connectors.filter((each) => each.recorder).map((each) => each.id)).toEqual(["screen"]);
    expect(connectorOf(asked, "chrome").mac_copy).toBe(`chrome:<account>:${MAC_A}`);
    expect(connectorOf(reportOf(at.root, { connectors, unit: MAC_B }), "chrome").mac_copy).toBe(`chrome:<account>:${MAC_B}`);
    expect(connectorOf(asked, "gmail").mac_copy).toBeNull();
    expect(connectorOf(reportOf(at.root, { connectors }), "chrome").mac_copy).toBeNull();
    summary.clients = { placeholder: member("whoop", "email").placeholder, chrome: connectorOf(asked, "chrome").mac_copy };
  });

  it("32. a name-only account is named by its name: its copy says it, and the chrome account the survey found names it as the survey did, by its email or its name", () => {
    const at = home("lifestream-report-named-");
    const [named, mailed] = ["claude:customer-0001:browser", "claude:person-a@example.com:browser"];
    at.source(named, "claude-browser", { lane: "claude-browser", name: "Person A" }).source(mailed, "claude-browser", { lane: "claude-browser", email: "person-a@example.com" })
      .land(named, [item("conversation", "n1", NOW - HOUR)]).land(mailed, [item("conversation", "m1", NOW - HOUR)]).poll("claude-browser").done();
    const signedInAs = (account: JsonObject) => reportOf(at.root, { present: [BROWSER], chosen: ["claude"],
      sites: [{ ...site("https://claude.example.com"), stations: [{ unit: BROWSER, signed_in: true, account: account as never }] }] });
    const byName = connectorOf(signedInAs({ name: "Person A", verdict: "read" }), "claude");
    const byEmail = connectorOf(signedInAs({ email: "person-a@example.com", verdict: "read" }), "claude");
    summary.named = { copies: byName.copies.map((copy) => [copy.id, copy.name]), account: [byName.chrome_account, byEmail.chrome_account] };
    expect(byName.copies.map((copy) => [copy.id, copy.name]).sort()).toEqual([[named, "Person A"], [mailed, "person-a@example.com"]].sort());
    expect([byName.signed_in, byName.chrome_account, byEmail.chrome_account]).toEqual([true, { name: "Person A", verdict: "read" }, { email: "person-a@example.com", verdict: "read" }]);
  });

  it("31. a home folder's stream of films watched declares Watching: admitted against the release's icons, it stands under Watching, drawn as a television", () => {
    const at = home("lifestream-report-watching-");
    at.done();
    const icons = new Set(Object.keys((JSON.parse(readFileSync(join(REPO, "design", "icons.json"), "utf8")) as { icons: Record<string, unknown> }).icons));
    const films = {
      id: "film-diary", product: "film-diary", name: "Film diary", vendor: "example", type: "watching", noun: ["film", "films"], records: "The films you logged.",
      sources: [{ id: "film-diary:<account>:export", read: "film-diary-export", arrives: "upload" }],
    };
    const admitted = admit({ contract: 3, connectors: [films], readers: [{ name: "film-diary-export", kinds: { film: () => [] }, read: async function* () {} }] },
      { folder: "film-diary", whose: "home", admitted: admittedNone(), icons });
    expect("faults" in admitted ? admitted.faults : []).toEqual([]);
    const declared = "entry" in admitted ? admitted.entry.connectors : [];
    const report = reportOf(at.root, { connectors: [...DECLARED, ...declared] });
    summary.watching = { type: connectorOf(report, "film-diary").type, icon: connectorOf(report, "film-diary").icon };
    expect(connectorOf(report, "film-diary")).toMatchObject({ type: { key: "listening", name: "Listening and watching", icon: "listening" }, icon: "watching" });
    expect(icons.has("watching")).toBe(true);
  });
});

function order(report: StreamsReport, id: string): number {
  const need = report.needs.find((each) => each.id === id);
  if (need === undefined) return Number.MAX_SAFE_INTEGER;
  return report.needs.indexOf(need);
}
