import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyTable, hidesAny, openHomeFolder, type DetailType, type Level, type PlaceholderTable } from "@lifestreamprotocol/core";
import { openHider, openMarks, type Detector, type Hider, type NameTable, type PrivacySettings } from "@lifestreamprotocol/privacy";
import { leavesOf, recordHit, ROUTES, searchRefusal, type Shape, type TOOL_ROUTES } from "../search-contract.js";
import { kept, wayIn, wayOut, type Asked, type Hide } from "../way-out.js";

type ToolRoute = (typeof TOOL_ROUTES)[number];

export const PEOPLE: NameTable = {
  version: "people-1",
  owner: { who: "person:owner", shown: "Owner Example" },
  people: [
    { who: "person:owner", is: "human", shown: "Owner Example", names: ["Owner Example"], accounts: ["owner@example.com"] },
    { who: "person:a1", is: "human", shown: "Person A", names: ["Person A", "Per"], accounts: ["+15550000001", "person-a@example.com"] },
    { who: "person:a2", is: "human", shown: "Person A", names: ["Person A"], accounts: ["+15550000002"] },
    { who: "person:b", is: "human", shown: "Person B", names: ["Person B"], accounts: ["+15550000003"] },
  ],
};

const PRIVACY: PrivacySettings = { level: "all", chat: "all", links: "tokens", always: [], never: [] };

export const WORDS: Readonly<Record<string, DetailType>> = { "Example Street": "address", "Example Cafe": "place", "4111 1111 1111 1111": "number" };

const MODEL = { id: "fake-filter", file: "sha256:00", decode: "1" };

export function detector(words: Readonly<Record<string, DetailType>> = WORDS): Detector {
  return {
    state: () => ({ state: "ready", model: MODEL }),
    async find(passages) {
      return {
        model: MODEL,
        marks: passages.map((passage) => Object.entries(words).flatMap(([word, type]) =>
          [...passage.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, "giu"))].map((match) => ({ start: match.index, end: match.index + word.length, type })))),
      };
    },
  };
}

export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

let stores = 0;
const dir = mkdtempSync(join(tmpdir(), "lifestream-way-out-"));

export function hider(): Hider {
  return openHider({
    people: () => PEOPLE, settings: () => PRIVACY, detector: detector(),
    pictures: {
      read: async () => ({ lines: [], faces: [] }),
      make: async (draft) => ({ jpeg: JPEG, recipe: { blob: draft.blob, filled: [], covered: [], written: [], engine: "fake" } }),
    },
    marks: marksIn(dir, (stores += 1)),
  });
}

export interface Hiding {
  hide: Hide;
  look: Hide;
  table(): PlaceholderTable;
}

export function hiding(level: Level, scope = "chat:c-0001", from: Hider = hider()): Hiding {
  let table = emptyTable(scope);
  return {
    hide: async (texts) => {
      const hidden = await from.hide(texts, level, table);
      if ("texts" in hidden) table = hidden.table;
      return hidden;
    },
    look: (texts) => from.hide(texts, level, table),
    table: () => table,
  };
}

const FIXTURES = new URL("./contract/", import.meta.url);
export const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8"));

export interface Pair {
  plain: string;
  route: ToolRoute | "refusal";
  level: Level;
  args?: Readonly<Record<string, unknown>>;
  shown?: readonly string[];
  seed?: true;
}

export const PAIRS: Readonly<Record<string, Pair>> = {
  "search-hidden": { plain: "search", route: "/v1/search", level: "all", args: { query: "example +15550000001", lists: ["record", "screen", "goto"] } },
  "search-placeholder-hidden": { plain: "search-placeholder", route: "/v1/search", level: "all", args: { query: "[[Person 1]]" }, seed: true },
  "count-hidden": { plain: "count", route: "/v1/count", level: "all", args: { of: "payments", measure: "amount", op: "sum", by: ["item"], match: { payee: "acme" }, from: "2026-03-01", to: "2026-03-31" } },
  "count-person-hidden": { plain: "count-person", route: "/v1/count", level: "all", args: { of: "calls", by: ["month"], person: ["[[Person 1]]"] }, seed: true },
  "people-hidden": { plain: "people", route: "/v1/people/search", level: "all", args: { name: "Person A" }, shown: ["Person A"] },
  "read-chat-hidden": { plain: "read-chat", route: "/v1/read", level: "all" },
  "read-photo-hidden": { plain: "read-photo", route: "/v1/read", level: "all" },
  "read-row-hidden": { plain: "read-row", route: "/v1/read", level: "all" },
  "refusals-hidden": { plain: "refusals", route: "refusal", level: "all" },
};

export const asked = (level: Level, route = "/v1/search"): Asked<unknown> => ({ params: {}, route, level, hides: hidesAny(level), written: {}, placed: [], not_searched: [], terms: {}, seen: [] });

export async function seeded(level: Level): Promise<Hiding> {
  const world = hiding(level);
  await world.hide([[{ text: "Person A", is: "person", who: "person:a1" }]]);
  return world;
}

export async function hiddenOf(name: string): Promise<unknown> {
  const pair = PAIRS[name]!;
  const world = pair.seed === true ? await seeded(pair.level) : hiding(pair.level);
  const plain = fixture(pair.plain);
  const shape = pair.route === "refusal" ? searchRefusal : ROUTES[pair.route].answer;
  let at = asked(pair.level, pair.route);
  if (pair.args !== undefined && pair.route !== "refusal") {
    const read = await wayIn(pair.route, ROUTES[pair.route].params as Shape<unknown>, pair.args, world.table(), pair.level, new Set(pair.shown ?? []), PEOPLE, world.look);
    if (!("params" in read)) throw new Error(`${name}: ${JSON.stringify(read)}`);
    at = read;
  }
  const out = async (value: unknown) => {
    const answer = structuredClone(value) as Record<string, unknown>;
    const record = answer.record as { hits?: Record<string, unknown>[] } | undefined;
    if (shape === ROUTES["/v1/search"].answer && record?.hits !== undefined) {
      const hits = await kept(at, record.hits, world.hide, leavesOf(recordHit));
      if (!Array.isArray(hits)) throw new Error(`${name}: ${JSON.stringify(hits)}`);
      record.hits = hits;
    }
    const hidden = await wayOut(shape as Shape<unknown>, answer, at, world.hide);
    if (!("answer" in hidden)) throw new Error(`${name}: ${JSON.stringify(hidden)}`);
    return hidden.answer;
  };
  if (pair.route === "refusal") {
    const all: unknown[] = [];
    for (const each of plain as { status: number; body: unknown }[]) all.push({ ...each, body: await out(each.body) });
    return all;
  }
  return out(plain);
}

function marksIn(dir: string, store: number): ReturnType<typeof openMarks> {
  const folder = join(dir, `marks-${store}`);
  return openMarks(openHomeFolder(folder), join(folder, "marks.db"));
}
