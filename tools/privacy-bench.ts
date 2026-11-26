import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  baseOf, DETAIL_TYPES, emptyTable, fold, hidesAny, isDetailType, isPlainWord, openHomeFolder, placeholderSpans,
  type DetailType, type Entry, type Level, type PlaceholderTable,
} from "@lifestreamprotocol/core";
import { routeId, RUNNER_TRANSPORT } from "@lifestreamprotocol/model";
import { openHider, openMarks, type Detector, type NameTable, type Pictures, type PrivacySettings } from "@lifestreamprotocol/privacy";
import { driveHalf, hidingFile, openDetector } from "../packages/home/detector.js";
import { peopleFileOf, readNameTable } from "../packages/home/people.js";
import { compileNames } from "../packages/privacy/names.js";

export interface TruthItem {
  source: string;
  kind: string;
  key: string;
  details: { type: DetailType; text: string; occurrences?: number[] }[];
}

export interface Detail {
  type: DetailType;
  text: number;
  start: number;
  end: number;
}

export interface Item {
  product: string;
  texts: string[];
  details: Detail[];
}

export interface WordList {
  name: string;
  plain: (word: string) => boolean;
}

export interface BenchInput {
  items: readonly Item[];
  names: NameTable;
  detector: { detector: Detector } | { why: string };
  lists: readonly WordList[];
  scratch: string;
}

export interface Tally {
  found: number;
  of: number;
}

export interface Measured {
  choice: string;
  items: number;
  fallbacks: { item: number; why: string }[];
  characters: number;
  cannot: number;
  found: Tally;
  types: Record<string, Tally>;
  sources: Record<string, Tally>;
  wrong: number;
  wrongTypes: Record<string, number>;
  seconds: number;
}

export interface Listed {
  list: string;
  names: number;
  kept: string[];
  ordinary: number;
  words: string[];
}

export interface Report {
  choices: (Measured | { choice: string; why: string })[];
  lists: Listed[];
}

export const CHOICES: readonly { choice: string; level: Level; names: "home" | "empty"; detector: boolean }[] = [
  { choice: "Don't hide", level: "none", names: "home", detector: false },
  { choice: "Hide what the home knows", level: "all", names: "empty", detector: false },
  { choice: "Hide with a hiding model", level: "all", names: "home", detector: true },
];

const NOBODY: NameTable = { version: "bench-nobody", owner: null, people: [] };
const NO_PICTURES: Pictures = {
  read: () => Promise.reject(new Error("the bench hides no picture")),
  make: () => Promise.reject(new Error("the bench hides no picture")),
};
export const NOT_USED = "the hiding model did not answer, so the texts were hidden as with no model chosen";

const OFF: Detector = {
  state: () => ({ state: "off" }),
  find: () => Promise.reject(new Error("No model is chosen for Hiding details")),
};
const WORD = /[\p{L}\p{M}\p{N}]+/gu;
const LETTERS = /^[\p{L}\p{M}]+$/u;
const SHOWN = 12;


export async function bench(input: BenchInput): Promise<Report> {
  const choices: Report["choices"] = [];
  for (const choice of CHOICES) choices.push(await measure(choice, input));
  return { choices, lists: input.lists.map((list) => listed(list, input)) };
}

async function measure(choice: (typeof CHOICES)[number], input: BenchInput): Promise<Report["choices"][number]> {
  const chosen = choice.detector ? input.detector : { detector: OFF };
  if ("why" in chosen) return { choice: choice.choice, why: chosen.why };
  const settings: PrivacySettings = {
    level: hidesAny(choice.level) ? "all" : "none", chat: hidesAny(choice.level) ? "all" : "none", links: "tokens", always: [], never: [],
  };
  const folder = mkdtempSync(join(input.scratch, "marks-"));
  const marks = openMarks(openHomeFolder(folder), join(folder, "marks.db"));
  const names = choice.names === "home" ? input.names : NOBODY;
  const hider = openHider({ people: () => names, settings: () => settings, detector: chosen.detector, pictures: NO_PICTURES, marks });
  const measured: Measured = { choice: choice.choice, items: 0, fallbacks: [], characters: 0, cannot: 0, found: { found: 0, of: 0 }, types: {}, sources: {}, wrong: 0, wrongTypes: {}, seconds: 0 };
  try {
    for (const [index, item] of input.items.entries()) {
      const started = performance.now();
      const answer = await hider.hide(item.texts.map((text) => [{ text, free: true as const }]), choice.level, emptyTable(`bench:${index}`));
      const seconds = (performance.now() - started) / 1000;
      if (!("texts" in answer)) return { choice: choice.choice, why: answer.wait };
      if (choice.detector && answer.detector === null) {
        measured.fallbacks.push({ item: index + 1, why: answer.fallback ?? "no model was used" });
        continue;
      }
      measured.items += 1;
      measured.seconds += seconds;
      item.texts.forEach((text, at) => {
        measured.characters += text.length;
        const hidden = answer.texts[at]!;
        if (typeof hidden !== "string") {
          measured.cannot += 1;
          return;
        }
        const spans = hiddenSpans(text, hidden, answer.table);
        const covered = union(spans);
        const details = item.details.filter((detail) => detail.text === at);
        for (const detail of details) {
          const found = covered.some((span) => span.start <= detail.start && detail.end <= span.end) ? 1 : 0;
          for (const tally of [measured.found, (measured.types[detail.type] ??= { found: 0, of: 0 }), (measured.sources[item.product] ??= { found: 0, of: 0 })]) {
            tally.found += found;
            tally.of += 1;
          }
        }
        for (const span of spans) {
          if (details.some((detail) => detail.start < span.end && span.start < detail.end)) continue;
          measured.wrong += 1;
          measured.wrongTypes[span.type] = (measured.wrongTypes[span.type] ?? 0) + 1;
        }
      });
    }
    return measured.items === 0 && measured.fallbacks.length > 0 ? { choice: choice.choice, why: NOT_USED } : measured;
  } catch (error) {
    return { choice: choice.choice, why: error instanceof Error ? error.message : String(error) };
  } finally {
    marks.close();
    rmSync(folder, { recursive: true, force: true });
  }
}

function listed(list: WordList, input: BenchInput): Listed {
  const single = new Set(input.names.people.filter((person) => person.is === "human").flatMap((person) => person.names)
    .map((name) => name.normalize("NFC").toLowerCase().match(WORD) ?? []).filter((words) => words.length === 1).map((words) => words[0]!));
  const kept = [...single].filter((name) => list.plain(name)).sort();
  const matcher = compileNames(input.names, list.plain);
  const words = new Map<string, number>();
  for (const item of input.items) {
    item.texts.forEach((text, at) => {
      for (const mark of matcher.marks(text)) {
        const written = text.slice(mark.start, mark.end);
        if (mark.shown !== undefined || (mark.type !== "person" && mark.type !== "account") || !LETTERS.test(written)) continue;
        if (item.details.some((detail) => detail.text === at && detail.start < mark.end && mark.start < detail.end)) continue;
        const word = written.toLowerCase();
        words.set(word, (words.get(word) ?? 0) + 1);
      }
    });
  }
  return {
    list: list.name, names: single.size, kept,
    ordinary: [...words.values()].reduce((sum, count) => sum + count, 0),
    words: [...words].sort(([left, a], [right, b]) => b - a || (left < right ? -1 : 1)).map(([word]) => word),
  };
}


export interface Span {
  start: number;
  end: number;
  type: DetailType;
}

export function hiddenSpans(original: string, hidden: string, table: PlaceholderTable): Span[] {
  if (hidden === original) return [];
  const held = new Map(table.entries.map((entry) => [entry.placeholder, entry]));
  const holes = placeholderSpans(hidden).filter((span) => held.has(hidden.slice(span.start, span.end)));
  const literals: string[] = [];
  let from = 0;
  for (const hole of holes) {
    literals.push(hidden.slice(from, hole.start));
    from = hole.end;
  }
  literals.push(hidden.slice(from));
  const entries = holes.map((hole) => held.get(hidden.slice(hole.start, hole.end))!);
  const longest = Math.max(0, ...entries.flatMap((entry) => [entry.detail.length, entry.shown?.length ?? 0]));
  const spans = align(original, literals, entries, 2 * longest + 64) ?? align(original, literals, entries, original.length);
  if (spans === null) throw new Error("a hidden text is not its original with spans replaced by placeholders");
  return spans;
}

interface Step extends Span {
  back: Step | null;
}

function align(original: string, literals: readonly string[], entries: readonly Entry[], reach: number): Span[] | null {
  const head = literals[0]!;
  const tail = literals.at(-1)!;
  if (entries.length === 0 || !original.startsWith(head) || !original.endsWith(tail) || original.length < head.length + tail.length) return null;
  let layer = new Map<number, { score: number; path: Step | null }>([[head.length, { score: 0, path: null }]]);
  entries.forEach((entry, index) => {
    const literal = literals[index + 1]!;
    const last = index === entries.length - 1;
    const next = new Map<number, { score: number; path: Step | null }>();
    for (const start of [...layer.keys()].sort((left, right) => left - right)) {
      const state = layer.get(start)!;
      for (const end of ends(original, literal, start, last, reach)) {
        const score = state.score + fit(original.slice(start, end), entry);
        const at = end + literal.length;
        const held = next.get(at);
        if (held === undefined || score > held.score) next.set(at, { score, path: { start, end, type: entry.type, back: state.path } });
      }
    }
    layer = next;
  });
  const final = layer.get(original.length);
  if (final === undefined) return null;
  const spans: Span[] = [];
  for (let step = final.path; step !== null; step = step.back) spans.unshift({ start: step.start, end: step.end, type: step.type });
  return spans;
}

function* ends(original: string, literal: string, start: number, last: boolean, reach: number): Generator<number> {
  const limit = Math.min(original.length - literal.length, start + reach);
  if (last) {
    if (limit === original.length - literal.length && limit > start) yield limit;
    return;
  }
  if (literal === "") {
    for (let end = start + 1; end <= limit; end += 1) yield end;
    return;
  }
  for (let end = original.indexOf(literal, start + 1); end !== -1 && end <= limit; end = original.indexOf(literal, end + 1)) yield end;
}

function fit(written: string, entry: Entry): number {
  const folded = fold(entry.type, written);
  if (folded === fold(entry.type, entry.detail) || (entry.shown !== undefined && folded === fold(entry.type, entry.shown))) return 2;
  if (baseOf(entry.type) !== "person") return 0;
  const known = new Set(`${entry.detail} ${entry.shown ?? ""}`.toLowerCase().match(WORD) ?? []);
  const words = written.toLowerCase().match(WORD) ?? [];
  return words.length > 0 && words.every((word) => known.has(word)) ? 1 : 0;
}

function union(spans: readonly Span[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const span of [...spans].sort((left, right) => left.start - right.start)) {
    const last = out.at(-1);
    if (last !== undefined && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else out.push({ start: span.start, end: span.end });
  }
  return out;
}


export function readTruths(path: string): TruthItem[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { items?: unknown };
  if (!Array.isArray(parsed.items) || parsed.items.length === 0) throw new Error(`${path} holds no items: {"items": [{source, kind, key, details: [{type, text, occurrences?}]}]}`);
  return parsed.items.map((item: Partial<TruthItem>, index: number) => {
    const named = [item.source, item.kind, item.key].every((value) => typeof value === "string" && value !== "");
    if (!named || !Array.isArray(item.details)) throw new Error(`${path} item ${index + 1} must state source, kind, key and details`);
    item.details.forEach((detail, at) => {
      const occurrences = detail.occurrences === undefined
        || (Array.isArray(detail.occurrences) && detail.occurrences.length > 0 && detail.occurrences.every((each) => Number.isInteger(each) && each >= 0));
      if (!isDetailType(detail.type) || ["ref", "face"].includes(detail.type) || typeof detail.text !== "string" || detail.text === "" || !occurrences) {
        throw new Error(`${path} item ${index + 1} detail ${at + 1} must state a type of detail (${DETAIL_TYPES.filter((type) => type !== "ref" && type !== "face").join(", ")}), its text, and the occurrences it is, if not every one`);
      }
    });
    return item as TruthItem;
  });
}

export function itemOf(truth: TruthItem, words: { title?: string; text: string } | null, number: number): Item {
  if (words === null) throw new Error(`item ${number}: the home gives no words for ${truth.source} ${truth.kind}`);
  const texts = [words.title ?? "", words.text].filter((text) => text !== "");
  const details = truth.details.flatMap((detail, at) => {
    const places: Detail[] = [];
    texts.forEach((text, index) => {
      for (let start = text.indexOf(detail.text); start !== -1; start = text.indexOf(detail.text, start + detail.text.length)) {
        places.push({ type: detail.type, text: index, start, end: start + detail.text.length });
      }
    });
    if (places.length === 0) throw new Error(`item ${number} detail ${at + 1} is not in its record's words: the record moved since it was labelled`);
    const beyond = detail.occurrences?.find((each) => each >= places.length);
    if (beyond !== undefined) throw new Error(`item ${number} detail ${at + 1} names occurrence ${beyond}, and its record's words hold it ${places.length} times`);
    return detail.occurrences === undefined ? places : detail.occurrences.map((each) => places[each]!);
  });
  return { product: truth.source.split(":")[0]!, texts, details };
}


const share = (tally: Tally | undefined): string => (tally === undefined || tally.of === 0 ? "-" : `${tally.found} of ${tally.of} (${(Math.round((tally.found / tally.of) * 1000) / 10).toFixed(1)}%)`);
const whole = (value: number): string => Math.round(value).toLocaleString("en-US");

export function render(report: Report): string {
  const measured = report.choices.filter((row): row is Measured => "items" in row);
  const width = Math.max(28, ...report.choices.map((row) => row.choice.length + 4));
  const column = Math.max(24, ...report.choices.map((row) => row.choice.length + 2));
  const lines: string[] = [""];
  const row = (label: string, cells: readonly string[]) => lines.push(`${label.padEnd(width)}${cells.map((cell) => cell.padEnd(column)).join("").trimEnd()}`);
  row("", ["Details found", "Wrong hides", "Per 10,000 characters", "Characters a second", "Cannot read"]);
  for (const choice of report.choices) {
    if (!("items" in choice)) {
      lines.push(`${choice.choice.padEnd(width)}not measured: ${choice.why}`);
      continue;
    }
    row(choice.choice, [
      share(choice.found), String(choice.wrong), choice.characters === 0 ? "-" : ((choice.wrong / choice.characters) * 10_000).toFixed(1),
      choice.seconds === 0 ? "-" : whole(choice.characters / choice.seconds), String(choice.cannot),
    ]);
  }
  const first = measured[0];
  if (first !== undefined) lines.push("", `Items ${first.items}, characters ${whole(first.characters)}, details ${first.found.of}.`);
  for (const choice of measured) {
    if (choice.fallbacks.length === 0) continue;
    const byWhy = new Map<string, number[]>();
    for (const { item, why } of choice.fallbacks) byWhy.set(why, [...(byWhy.get(why) ?? []), item]);
    const fell = [...byWhy].map(([why, numbers]) => `${numbers.map((number) => `item ${number}`).join(", ")}: ${why}`).join("; ");
    lines.push(`${choice.choice}: the hiding model answered ${choice.items} of ${choice.items + choice.fallbacks.length} items; fell back on ${fell}`);
  }
  const table = (title: string, keys: readonly string[], cell: (choice: Measured, key: string) => string) => {
    if (keys.length === 0 || measured.length === 0) return;
    lines.push("", title);
    row("", measured.map((choice) => choice.choice));
    for (const key of keys) row(`  ${key}`, measured.map((choice) => cell(choice, key)));
  };
  const ordered = (keys: Iterable<string>) => [...new Set(keys)].sort((left, right) => DETAIL_TYPES.indexOf(left as DetailType) - DETAIL_TYPES.indexOf(right as DetailType) || (left < right ? -1 : 1));
  table("Found by type", ordered(measured.flatMap((choice) => Object.keys(choice.types))), (choice, key) => share(choice.types[key]));
  table("Found by source", [...new Set(measured.flatMap((choice) => Object.keys(choice.sources)))].sort(), (choice, key) => share(choice.sources[key]));
  table("Wrong hides by type", ordered(measured.flatMap((choice) => Object.keys(choice.wrongTypes))), (choice, key) => String(choice.wrongTypes[key] ?? 0));
  if (report.lists.length > 0) {
    lines.push("", "Word lists: of the people's one-word names, those kept from matching alone; the ordinary words marked in the items");
    const some = (words: readonly string[]) => (words.length === 0 ? "" : ` (${words.slice(0, SHOWN).join(", ")}${words.length > SHOWN ? ", …" : ""})`);
    for (const list of report.lists) {
      lines.push(`  ${list.list}: kept ${list.kept.length} of ${list.names}${some(list.kept)}; ordinary words marked ${list.ordinary}${some(list.words)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}


const machineDir = () => process.env.LIFESTREAM_MACHINE_DIR ?? join(homedir(), "Library/Application Support/Lifestream");
const doorAt = () => process.env.LIFESTREAM_DOOR ?? "http://127.0.0.1:4680";

async function door(route: string): Promise<Record<string, unknown>> {
  const token = process.env.LIFESTREAM_DOOR_TOKEN ?? readFileSync(join(machineDir(), "reader-token"), "utf8").trim();
  const response = await fetch(`${doorAt()}${route}`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`${route.split("?")[0]}: ${response.status} ${await response.text()}`);
  return (await response.json()) as Record<string, unknown>;
}

function outside(path: string, what: string): string {
  const checkout = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const target = resolve(path);
  let parent: string;
  try {
    parent = realpathSync(dirname(target));
  } catch {
    throw new Error(`${dirname(target)} does not exist`);
  }
  if (parent === checkout || parent.startsWith(`${checkout}${sep}`)) throw new Error(`${what} names the person's details: keep it outside ${checkout}`);
  return target;
}

async function detectorOf(runner: string | undefined): Promise<BenchInput["detector"]> {
  if (runner === undefined) return { why: "no runner named (--detector runner-<unit>)" };
  if (!/^runner-[a-z0-9][a-z0-9-]*$/u.test(runner)) throw new Error(`--detector is a runner, runner-<unit>, not ${JSON.stringify(runner)}`);
  const find = process.env.LIFESTREAM_FIND_TOKEN;
  if (find === undefined) return { why: "no find pass handed (LIFESTREAM_FIND_TOKEN, from lifestream principals mint --unit <name> --scope find)" };
  const drive = driveHalf(doorAt(), { call: () => find, drive: () => find });
  try {
    const file = hidingFile((await drive.list()).filter((each) => each.unit === runner), null);
    if (file === null) return { why: `${runner} has no hiding model` };
    const chosen = routeId({ transport: RUNNER_TRANSPORT, runner, model: file });
    const detector = openDetector({ chosen: () => chosen, line: "mark", drive });
    await detector.find([]);
    return { detector };
  } catch (error) {
    return { why: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { truths: { type: "string" }, home: { type: "string" }, detector: { type: "string" }, list: { type: "string", multiple: true } } });
  if (values.truths === undefined || values.home === undefined) {
    throw new Error("usage: npx tsx tools/privacy-bench.ts --truths <truths.json> --home <root> [--detector runner-<unit>] [--list <name>=<file>]…, the truths outside the checkout");
  }
  const truths = readTruths(outside(values.truths, "the truths file"));
  const lists: WordList[] = [{ name: "bundled", plain: isPlainWord }, ...(values.list ?? []).map((each): WordList => {
    const at = each.indexOf("=");
    if (at <= 0) throw new Error(`--list is <name>=<file>, not ${JSON.stringify(each)}`);
    const words = new Set(readFileSync(each.slice(at + 1), "utf8").split("\n").map((line) => line.trim().normalize("NFC").toLowerCase()).filter((line) => line !== ""));
    return { name: each.slice(0, at), plain: (word) => words.has(word.normalize("NFC").toLowerCase()) };
  })];
  const items: Item[] = [];
  for (const [index, truth] of truths.entries()) {
    const read = await door(`/v1/record?source=${encodeURIComponent(truth.source)}&kind=${encodeURIComponent(truth.kind)}&key=${encodeURIComponent(truth.key)}&text=1`);
    items.push(itemOf(truth, read.text as { title?: string; text: string } | null, index + 1));
  }
  const home = resolve(values.home);
  const names = readNameTable(openHomeFolder(home, { machine: machineDir(), program: "home" }), peopleFileOf(home, machineDir()));
  if (names === undefined) throw new Error("People has not prepared the name table on this machine yet: run the bench once its first run is done");
  const detector = await detectorOf(values.detector);
  const scratch = mkdtempSync(join(tmpdir(), "privacy-bench-"));
  try {
    process.stdout.write(render(await bench({ items, names, detector, lists, scratch })));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
