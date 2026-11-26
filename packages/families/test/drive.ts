import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest, isObject, openHome, openHomeFolder, piecesText, selects, sourceName, type Ask, type BlobReader, type BlobStore, type DaySettings, type EnrichmentRow, type ExtractRow, type Guard, type HomeDb, type Json, type JsonObject, type Landed, type OpenView, type Prompt, type ReaderOutput, type Reply, type Version, type View } from "@lifestreamprotocol/core";
import { aiFamily } from "../ai/family.js";
import { calendarFamily } from "../calendar/family.js";
import { callsFamily } from "../calls/family.js";
import { renderDay, type DayReader, type DeviceNames, type RenderedDay, tableUnits } from "../days.js";
import type { Change, Family, RecordText } from "../family.js";
import { healthFamily } from "../health/family.js";
import { labelsFamily } from "../labels/family.js";
import { listeningFamily } from "../listening/family.js";
import { mailFamily } from "../mail/family.js";
import { messagesFamily } from "../messages/family.js";
import { moneyFamily } from "../money/family.js";
import { notesFamily } from "../notes/family.js";
import { phoneFamily } from "../phone/family.js";
import { physicalFamily } from "../physical/family.js";
import { photosFamily } from "../photos/family.js";
import { plainFamily } from "../plain/family.js";
import { screenFamily } from "../screen/family.js";
import type { DayLabels } from "../shared/labels.js";
import { textFamilyOf } from "../texts.js";
import { conforming } from "./units.js";
import { voiceFamily } from "../voice/family.js";
import { webFamily } from "../web/family.js";
import { FED, PROOF_BANK } from "./fed.js";

export const SYNTHETIC_VENDOR = "synthetic";

let emptyFamilyDb: string | undefined;
function emptyFamilyDbPath(): string {
  if (emptyFamilyDb !== undefined && existsSync(emptyFamilyDb)) return emptyFamilyDb;
  const dir = mkdtempSync(join(tmpdir(), "family-template-"));
  openHome(openHomeFolder(dir), "migrate").close();
  emptyFamilyDb = join(dir, "home.db");
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return emptyFamilyDb;
}
const accept: Guard = () => [];
const DEFAULT_SETTINGS: DaySettings = { zone: "UTC", day_start_hour: 4 };

export interface Pass {
  touched: string[];
  written: string[];
  deleted: string[];
}

export interface Delivered extends Pass {
  landed: Landed;
  days: string[];
}

export class TestHome {
  readonly dir: string;
  readonly db: HomeDb;
  readonly blobs: BlobStore;
  readonly families: readonly Family[];
  readonly settings: DaySettings;
  #deliveries = 0;

  constructor(prefix: string, options: { families?: readonly Family[]; settings?: DaySettings; templateDb?: string } = {}) {
    this.dir = mkdtempSync(join(tmpdir(), prefix));
    copyFileSync(options.templateDb ?? emptyFamilyDbPath(), join(this.dir, "home.db"), constants.COPYFILE_FICLONE);
    this.db = openHome(openHomeFolder(this.dir), "write");
    this.blobs = openHomeFolder(this.dir).blobs(join(this.dir, "blobs"));
    this.families = options.families ?? [];
    this.settings = options.settings ?? DEFAULT_SETTINGS;
  }

  addSource(id: string, connector = "synthetic"): void {
    this.db.commit((tx) => tx.tables.sources.add({ id, vendor: SYNTHETIC_VENDOR, connector, added_ms: 0 }));
  }

  land(source: string, stated_ms: number, rows: readonly ReaderOutput[]): Landed {
    return this.db.commit((tx) => {
      if (tx.tables.sources.get(source) === undefined) tx.tables.sources.add({ id: source, vendor: SYNTHETIC_VENDOR, connector: "synthetic", added_ms: stated_ms });
      const run = tx.tables.runs.start({ kind: "import", subject: source, started_ms: stated_ms });
      const guards = Object.fromEntries(rows.map((row) => [row.kind, accept]));
      const landed = tx.records.land(run, { id: `${source}@${stated_ms}/${++this.#deliveries}`, source, stated_ms }, rows, guards, { has: () => true });
      tx.tables.runs.end(run, { ended_ms: stated_ms, outcome: "ok" });
      tx.tables.sources.advance(source, stated_ms);
      return landed;
    });
  }

  read<T>(work: (view: OpenView) => T): T {
    const view = this.db.view();
    try {
      return work(view);
    } finally {
      view.close();
    }
  }

  extractPass(family: Family, settings: DaySettings = this.settings): Pass {
    const { touched, written, deleted } = this.#pass(family, settings);
    return { touched, written, deleted };
  }

  deliver(source: string, stated_ms: number, rows: readonly ReaderOutput[]): Delivered {
    const landed = this.land(source, stated_ms, rows);
    const out: Delivered = { landed, touched: [], written: [], deleted: [], days: [] };
    const days = new Set<string>();
    for (const family of this.families) {
      const pass = this.#pass(family, this.settings);
      for (const list of ["touched", "written", "deleted"] as const) out[list].push(...pass[list].map((unit) => `${family.name} ${unit}`));
      pass.days.forEach((day) => days.add(day));
    }
    out.days = [...days].sort();
    return out;
  }

  #pass(family: Family, settings: DaySettings): Pass & { days: string[] } {
    const computed = this.read((view) => {
      const cursor = view.tables.cursors.get(`extract:${family.name}`)?.seq ?? 0;
      const read = view.sources().filter((row) => family.inputs.some((input) => selects(input.sources, row)));
      const sources = read.map((row) => row.id);
      const kinds = [...new Set(family.inputs.flatMap((input) => input.kinds))];
      const units = new Set<string>();
      const changes: Change[] = [];
      const allowed = new Set<string>();
      for (const row of read) {
        for (const input of family.inputs) {
          if (selects(input.sources, row)) {
            for (const kind of input.kinds) allowed.add(`${row.id}\0${kind}`);
          }
        }
      }
      const version = (id: string | undefined): Version | undefined => id === undefined || id === "gone" ? undefined : view.version(id);
      const prevVersions = cursor === 0 ? new Map<string, string>() : undefined;
      for (const statement of view.statements(cursor, { sources, kinds })) {
        if (!allowed.has(`${statement.source}\0${statement.kind}`)) continue;
        let prevVersion: string | undefined;
        if (prevVersions !== undefined) {
          const refKey = `${statement.source}\0${statement.kind}\0${statement.key}`;
          prevVersion = prevVersions.get(refKey);
          prevVersions.set(refKey, statement.version);
        } else {
          prevVersion = view.history(statement).filter((row) => row.seq < statement.seq).at(-1)?.version;
        }
        const before = version(prevVersion);
        const after = version(statement.version);
        changes.push({ record: { source: statement.source, kind: statement.kind, key: statement.key }, ...(before ? { before } : {}), ...(after ? { after } : {}) });
      }
      for (const touched of changes.length === 0 ? [] : family.touched(changes, view)) {
        units.add(touched.unit);
        if (touched.previous !== undefined) units.add(touched.previous);
      }
      const rows = [...units].sort().map((unit): [string, ExtractRow | null] => {
        const built = family.extract(unit, view, this.blobs);
        if (built === null) return [unit, null];
        const row: ExtractRow = { family: family.name, unit, code: family.code, seq: view.through, days: [], ...built };
        row.days = family.days(row, settings);
        return [unit, row];
      });
      return { rows, through: view.through };
    });
    return this.db.commit((tx) => {
      const pass = { touched: computed.rows.map(([unit]) => unit), written: [] as string[], deleted: [] as string[], days: new Set<string>() };
      for (const [unit, row] of computed.rows) {
        const stored = tx.derived.extracts.get(family.name, unit);
        if (row === null) {
          const gone = tx.derived.extracts.delete(family.name, unit);
          if (gone === undefined) continue;
          pass.deleted.push(unit);
          gone.forEach((day) => pass.days.add(day));
        } else if (tx.derived.extracts.put(row)) {
          pass.written.push(unit);
          [...(stored?.days ?? []), ...row.days].forEach((day) => pass.days.add(day));
        }
      }
      tx.tables.cursors.move(`extract:${family.name}`, { seq: computed.through, at_ms: 0 });
      return { ...pass, days: [...pass.days].sort() };
    });
  }

  extracts(family: string): ExtractRow[] {
    return this.read((view) => [...view.extracts(family)].sort((left, right) => compare(left.unit, right.unit)));
  }

  enrichments(family: string): EnrichmentRow[] {
    return this.db.commit((tx) => tx.derived.enrichments.list(family));
  }

  putEnrichment(row: EnrichmentRow): boolean {
    return this.db.commit((tx) => tx.derived.enrichments.put(row));
  }

  render(day: string, labels: DayLabels, wrap: (reader: DayReader) => DayReader = (reader) => reader, families = this.families, settings = this.settings, devices?: DeviceNames): RenderedDay {
    return this.read((view) => conforming(renderDay(day, families, wrap(dayReader(view)), settings, tableUnits(labels), devices)));
  }

  renderDays(days: readonly string[], labels: (view: OpenView) => DayLabels, families = this.families, settings = this.settings): Map<string, RenderedDay> {
    return this.read((view) => new Map(days.map((day) => [day, conforming(renderDay(day, families, dayReader(view), settings, tableUnits(labels(view))))])));
  }

  texts(family: Family): { record: string; text: RecordText | null }[] {
    return this.read((view) => recordTexts(view, family, this.blobs));
  }

  artifact(name: string, value: unknown): string {
    const path = join(this.dir, name.endsWith(".json") ? name : `${name}.json`);
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    return path;
  }

  close(): void {
    this.db.close();
    if (process.env.LIFESTREAM_KEEP_ARTIFACTS === "1") console.log(`family test artifacts kept: ${this.dir}`);
    else rmSync(this.dir, { recursive: true, force: true });
  }
}

export function registryFamilies(): Family[] {
  const BOOKS = { books: FED.labels };
  return [
    messagesFamily(BOOKS)(FED.messages), mailFamily(BOOKS)(FED.mail), aiFamily(FED.ai), screenFamily({ zone: "UTC" })(FED.screen), photosFamily({ faces: false })(FED.photos),
    voiceFamily(FED.voice), calendarFamily(BOOKS)(FED.calendar), notesFamily(FED.notes), moneyFamily(PROOF_BANK), callsFamily({ ...BOOKS, messages: FED.messages })(FED.calls), healthFamily(FED.health),
    listeningFamily(FED.listening), webFamily({ screen: FED.screen })(FED.web), phoneFamily({})(FED.phone), physicalFamily({ photos: FED.photos })(FED.physical),
    labelsFamily({ home: null, messages: FED.messages, mail: FED.mail })(FED.labels), plainFamily([]),
  ];
}

export function recordTexts(view: View, family: Family, files: BlobReader): { record: string; text: RecordText | null }[] {
  const order = registryFamilies().map((each) => (each.name === family.name ? family : each));
  const out: { record: string; text: RecordText | null }[] = [];
  for (const source of view.sources()) {
    const kinds = new Set(family.inputs.filter((input) => selects(input.sources, source)).flatMap((input) => input.kinds));
    for (const kind of kinds) {
      if (textFamilyOf(order, source, kind)?.name !== family.name) continue;
      for (const { head, version } of view.records(source.id, kind)) {
        out.push({ record: `${source.id} ${kind} ${head.key}`, text: family.text!.of({ source: source.id, kind, key: head.key }, version, files, view) });
      }
    }
  }
  return out.sort((left, right) => compare(left.record, right.record));
}

export function dayReader(view: OpenView, reads?: { family: string; unit: string; day: string }[]): DayReader {
  return {
    extractsOn: (family, day) => {
      const rows = view.extractsOn(family, day);
      if (reads !== undefined) for (const row of rows) reads.push({ family, unit: row.unit, day });
      return rows;
    },
    enrichment: (family, item, prompt) => view.enrichment(family, item, prompt),
    sources: (selector) => view.sources(selector),
    since: (source, kinds) => view.since(source, kinds),
  };
}


export interface Route {
  model: string;
  effort: string;
  sampling: { temperature: number; seed?: number } | null;
}

export const ROUTE: Route = { model: "google/gemini-3.8-flash", effort: "none", sampling: { temperature: 0 } };
export const TAG_ROUTE: Route = { model: "gpt-6-luna", effort: "high", sampling: null };

export function ledgerKey(request: { model: string; prompt: string; version: number; input_hash: string; route: Route }): string {
  const { sampling } = request.route;
  return digest({
    model: request.model, prompt: request.prompt, version: request.version, input: request.input_hash, effort: request.route.effort,
    sampling: sampling === null ? null : { temperature: sampling.temperature, ...(sampling.seed === undefined ? {} : { seed: sampling.seed }) },
  });
}

export function promptOf(family: Family, ask: Ask): Prompt {
  const prompt = family.prompts?.[ask.prompt];
  if (prompt === undefined) throw new Error(`${family.name} states no prompt ${ask.prompt}`);
  return prompt;
}

export function askText(family: Family, ask: Ask): string {
  return promptOf(family, ask).text + piecesText(ask.input);
}

export function inputHash(ask: Ask): string {
  if (ask.identity !== undefined) return digest(ask.identity);
  const input = piecesText(ask.input);
  if (ask.attachments === undefined || ask.attachments.length === 0) return digest(input);
  return digest({ input: digest(input), attachments: ask.attachments.map((file) => (file.drawn === undefined ? file.blob : { blob: file.blob, drawn: file.drawn })) });
}

export function worked(family: Family, ask: Ask): Ask {
  const sources = ask.work === undefined ? undefined : family.works?.[ask.work];
  if (sources === undefined || ask.source === undefined || !selects(sources, sourceName(ask.source))) {
    throw new Error(`${family.name} asks ${ask.item} under work ${ask.work ?? "none"} of ${ask.source ?? "no source"}, which it does not ask of`);
  }
  return ask;
}

export function askKey(family: Family, ask: Ask, route: Route): { input_hash: string; key: string } {
  const input_hash = inputHash(ask);
  return { input_hash, key: ledgerKey({ model: route.model, prompt: ask.prompt, version: promptOf(family, ask).version, input_hash, route }) };
}

export function readReply(prompt: Prompt, text: string): { value: Json } | { violations: string[] } {
  if (prompt.type === "text") return { value: text };
  const trimmed = text.trim();
  const body = /```(?:json)?\s*([\s\S]*?)```/u.exec(trimmed)?.[1] ?? trimmed;
  const start = body.indexOf("{");
  if (start < 0) return { violations: ["the answer holds no JSON object"] };
  let end = body.length;
  for (let index = start, depth = 0, quoted = false; index < body.length; index++) {
    const char = body[index];
    if (quoted) {
      if (char === "\\") index++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      end = index + 1;
      break;
    }
  }
  let parsed: Json;
  try {
    parsed = JSON.parse(body.slice(start, end)) as Json;
  } catch (error) {
    return { violations: [`the answer is not JSON: ${(error as Error).message}`] };
  }
  const value = fitTo(prompt.type, parsed);
  const violations: string[] = [];
  checkAgainst(prompt.type, value, "the answer", violations);
  return violations.length === 0 ? { value } : { violations };
}

function fitTo(node: JsonObject, value: Json): Json {
  if (isObject(value) && isObject(node.properties)) {
    const fitted: JsonObject = {};
    for (const [name, child] of Object.entries(node.properties) as [string, JsonObject][]) {
      if (Object.hasOwn(value, name)) fitted[name] = fitTo(child, value[name]!);
      else if (Array.isArray(child.type)) fitted[name] = null;
    }
    return fitted;
  }
  return Array.isArray(value) && isObject(node.items) ? value.map((item) => fitTo(node.items as JsonObject, item)) : value;
}

function checkAgainst(node: JsonObject, value: Json, at: string, found: string[]): void {
  const kind = Array.isArray(node.type) ? node.type[0] : node.type;
  if (value === null) {
    if (!Array.isArray(node.type)) found.push(`${at} must be ${kind}, not null`);
    return;
  }
  if (kind === "object") {
    if (!isObject(value)) return void found.push(`${at} must be an object`);
    for (const [name, child] of Object.entries(node.properties as JsonObject) as [string, JsonObject][]) {
      if (!Object.hasOwn(value, name)) found.push(`"${name}" is missing`);
      else checkAgainst(child, value[name]!, `"${name}"`, found);
    }
  } else if (kind === "array") {
    if (!Array.isArray(value)) return void found.push(`${at} must be an array`);
    value.forEach((item, index) => checkAgainst(node.items as JsonObject, item, `${at}[${index}]`, found));
  } else if (kind === "string") {
    if (typeof value !== "string") return void found.push(`${at} must be a string`);
    if (Array.isArray(node.enum) && !node.enum.includes(value)) found.push(`${at} must be one of ${node.enum.join(", ")}, not ${JSON.stringify(value)}`);
  } else if (kind === "integer" ? !Number.isInteger(value) : typeof value !== kind) found.push(`${at} must be ${kind}`);
}

export function replyOf(prompt: Prompt, key: string, model: string, text: string): Reply | undefined {
  const read = readReply(prompt, text);
  return "value" in read ? { key, model, text, value: read.value, version: prompt.version, at_ms: 1 } : undefined;
}

export class FakeLedger {
  readonly replies = new Map<string, Reply>();
  readonly gaveUp = new Set<string>();
  readonly sent: string[] = [];
  readonly asks: Ask[] = [];
  constructor(readonly route: Route) {}

  key(family: Family, ask: Ask): string {
    return askKey(family, ask, this.route).key;
  }

  settle(home: TestHome, family: Family, model: (ask: Ask) => string | null): { asked: Ask[]; refused: string[]; written: string[] } {
    const asked: Ask[] = [];
    const refused: string[] = [];
    const written: string[] = [];
    for (const extract of home.extracts(family.name)) {
      const answered = new Map<string, Reply>();
      const keys = new Map<string, { input_hash: string; key: string }>();
      const givenUp = new Set<string>();
      for (let round = 0; round < 8; round++) {
        const plan = family.plan!(extract, answered, givenUp);
        let gave = false;
        for (const ask of plan.asks.map((each) => worked(family, each))) {
          for (const file of ask.attachments ?? []) if (!home.blobs.has(file.blob)) throw new Error(`ask ${ask.item} attaches ${file.blob}, which the home does not hold`);
          const hashed = askKey(family, ask, this.route);
          keys.set(ask.item, hashed);
          if (this.gaveUp.has(hashed.key)) {
            if (!givenUp.has(ask.item)) gave = true;
            givenUp.add(ask.item);
            continue;
          }
          if (!this.replies.has(hashed.key)) {
            this.sent.push(hashed.key);
            this.asks.push(ask);
            asked.push(ask);
            const text = model(ask);
            if (text === null) {
              this.gaveUp.add(hashed.key);
              givenUp.add(ask.item);
              gave = true;
              continue;
            }
            const reply = replyOf(promptOf(family, ask), hashed.key, this.route.model, text);
            if (reply === undefined) {
              refused.push(ask.item);
              continue;
            }
            const drawn = ask.attachments?.find((file) => file.drawn !== undefined)?.drawn ?? [];
            this.replies.set(hashed.key, drawn.length === 0 ? reply : { ...reply, faces: drawn });
          }
          answered.set(ask.item, this.replies.get(hashed.key)!);
        }
        home.db.commit((tx) => {
          for (const { item, content } of plan.answers ?? []) {
            const hashed = keys.get(item) ?? askKey(family, askOf(family, extract, item), this.route);
            const row: EnrichmentRow = {
              family: family.name, item, prompt: enrichedUnder(family, extract, item), input_hash: hashed.input_hash, reply_key: hashed.key,
              reused_from: null, content, state: "done",
            };
            if (tx.derived.enrichments.put(row)) written.push(item);
          }
          for (const item of givenUp) {
            const hashed = keys.get(item)!;
            tx.derived.enrichments.put({
              family: family.name, item, prompt: enrichedUnder(family, extract, item), input_hash: hashed.input_hash, reply_key: null, reused_from: null, content: null, state: "given-up",
            });
          }
        });
        for (const { item } of plan.refusals ?? []) {
          refused.push(item);
          this.replies.delete((keys.get(item) ?? askKey(family, askOf(family, extract, item), this.route)).key);
          answered.delete(item);
        }
        if (!gave && plan.asks.every((ask) => givenUp.has(ask.item)) && (plan.refusals ?? []).length === 0) break;
      }
    }
    return { asked, refused, written };
  }
}

function askOf(family: Family, extract: ExtractRow, item: string): Ask {
  const ask = family.plan!(extract, new Map()).asks.find((candidate) => candidate.item === item);
  if (ask === undefined) throw new Error(`no ask for ${item}`);
  return ask;
}

function enrichedUnder(family: Family, extract: ExtractRow, item: string): string {
  return family.items?.(extract).find((entry) => entry.item === item)?.prompt ?? askOf(family, extract, item).prompt;
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function blobName(bytes: Buffer | string): string {
  return `sha256:${sha256(bytes)}`;
}

export function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function shuffled<T>(list: readonly T[], seed: number): T[] {
  const random = seeded(seed);
  const out = [...list];
  for (let index = out.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [out[index], out[other]] = [out[other]!, out[index]!];
  }
  return out;
}
