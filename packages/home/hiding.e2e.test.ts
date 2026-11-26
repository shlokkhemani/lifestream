import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { openHomeFolder, sha256, wantedOf, type DetailType, type JsonObject, type Level, type LevelName } from "@lifestreamprotocol/core";
import { openLedger, type Ledger, type TablePart } from "@lifestreamprotocol/model";
import { openMarks, passagesOf, type Detector, type DetectorModel, type DetectorState, type Draft, type NameTable, type Pictures, type PrivacySettings } from "@lifestreamprotocol/privacy";
import { DetectorError, driveHalf } from "./detector.js";
import { QUIET, serveDoor } from "./door.js";
import { ERASING, openHiding, PICTURE_UNMADE, type Bound, type Hiding, type HidingInputs } from "./hiding.js";
import { machine } from "./machine.js";
import { peopleFileOf } from "./people.js";
import { PEOPLE, writePrepared } from "./prepared.js";
import { authenticate, mintPrincipal, readPrincipals, turnPasses, writePrincipals, type HiddenReader } from "./principals.js";
import { checkoutProgram } from "./programs.js";
import { Refusal, RETRY_SOON_S } from "./refusal.js";
import { SearchIndex, searchFileOf, type RecordEntry } from "./search-index.js";
import { openWriter, type Writer } from "./writers.js";
import { editSettings } from "./test/folder.js";
import { fullAccess } from "./access.js";
import { agentAt, levelled } from "./test/agent-levels.js";
import { until } from "./test/harness-root.js";
import { cleanup, holdModels, LUNA_ROUTE, makeHome, makeHomeDb, NOW_MS, REPO } from "./test/support.js";

const roots: string[] = [];
afterAll(() => cleanup(roots));

const MODEL: DetectorModel = { id: "fake-filter", file: "sha256:00", decode: "1" };
const OWNER = { who: "p-owner", shown: "Owner Example" };
const NAMES: NameTable = {
  version: "people-1", owner: OWNER,
  people: [
    { who: "p-owner", is: "human", shown: "Owner Example", names: ["Owner Example", "Owner"], accounts: [] },
    { who: "p-ada", is: "human", shown: "Ada Example", names: ["Ada Example", "Ada", "Example"], accounts: ["person-a@example.com", "+15550000001"] },
  ],
};
const PRIVACY: PrivacySettings = { level: "all", chat: "all", links: "tokens", always: [], never: [] };
const CHAT: HiddenReader = { pass: "p-chat0001", agent: null };
const TURN: HiddenReader = { pass: "p-turn0001", agent: null, turn: { table: "chat:c1", level: "all" } as never };
const RECORD = "record.WyJyZWNvcmQiLCJ3aGF0c2FwcDoxNTU1MDAwMDAwOTppcGhvbmUtYWEwMSIsIm1lc3NhZ2UiLCJhMSJd";
const agent = (level: Level): HiddenReader => agentAt(level);
const BLOB = `sha256:${"a".repeat(64)}`;
const UNREADABLE = `sha256:${"b".repeat(64)}`;
const BROKEN = `sha256:${"c".repeat(64)}`;
const UNBUILT = `sha256:${"d".repeat(64)}`;
const FACES = `sha256:${"e".repeat(64)}`;
const made: Draft[] = [];
const CLOSING = `sha256:${"f".repeat(64)}`;
const BARE = `sha256:${"1".repeat(64)}`;

function scripted(words: Readonly<Record<string, DetailType>>) {
  let state: DetectorState = { state: "ready", model: MODEL };
  let gate: Promise<void> | null = null;
  let throwing: Error | null = null;
  const calls: string[][] = [];
  const detector: Detector & { calls: string[][]; set(next: DetectorState): void; hold(): () => void; throws(error: Error): void } = {
    calls,
    set: (next) => { state = next; },
    hold() {
      let open!: () => void;
      gate = new Promise((resolve) => { open = resolve; });
      return () => { gate = null; open(); };
    },
    throws: (error) => { throwing = error; },
    state: () => state,
    async find(passages) {
      calls.push([...passages]);
      if (gate !== null) await gate;
      if (throwing !== null) {
        const error = throwing;
        throwing = null;
        throw error;
      }
      return {
        model: MODEL,
        marks: passages.map((passage) => Object.entries(words).flatMap(([word, type]) =>
          [...passage.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, "gu"))].map((match) => ({ start: match.index, end: match.index + word.length, type })))),
      };
    },
  };
  return detector;
}

const pictures: Pictures = {
  async read(blob) {
    if (blob === UNREADABLE) return { cannot: "This picture cannot be read" };
    if (blob === BROKEN) throw new Error("a bug in the picture engine's adapter");
    if (blob === FACES) return { lines: [], faces: [{ box: { x: 10, y: 10, width: 40, height: 40 }, who: "p-ada" }, { box: { x: 100, y: 10, width: 40, height: 40 } }] };
    if (blob === CLOSING) throw new Refusal(503, "NOT_NOW", "Lifestream is restarting: ask again in a moment", RETRY_SOON_S);
    if (blob === BARE) return { lines: [], faces: [] };
    return { lines: [{ words: [{ text: "Ada", box: { x: 1, y: 1, width: 10, height: 4 } }, { text: "Example", box: { x: 12, y: 1, width: 20, height: 4 } }] }], faces: [] };
  },
  async make(recipe) {
    if (recipe.blob === UNBUILT) throw new Error("the face engine is not built: faces/.build/release/face-engine cannot run");
    made.push(recipe);
    return { jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), recipe: { ...recipe, covered: recipe.covered.map((face) => ({ ...face, colour: face.colour ?? "#808080" })), engine: "fake-1" } };
  },
};

async function settled<T>(promise: Promise<T>): Promise<T | { status: number; code: string; words: string; retryAfter?: number | undefined; extra: JsonObject }> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof Refusal) return { status: error.status, code: error.code, words: error.words, retryAfter: error.retryAfter, extra: error.extra };
    throw error;
  }
}

function driven(waited = false): Bound & { pass(): void; waits: number } {
  let passed = false;
  const told = new Set<() => void>();
  const bound = {
    waits: 0,
    passed: () => passed,
    pass() {
      passed = true;
      for (const then of [...told]) then();
      told.clear();
    },
    on(then: () => void) {
      bound.waits++;
      if (passed) then();
      else told.add(then);
      if (waited) bound.pass();
      return () => { told.delete(then); };
    },
  };
  return bound;
}

function inProcess(over: { settings?: () => PrivacySettings; names?: () => NameTable | undefined | Promise<NameTable | undefined>; detector?: ReturnType<typeof scripted>; wrap?: (writer: Writer) => HidingInputs["writer"]; bound?: () => Bound; route?: HidingInputs["route"]; describe?: HidingInputs["describe"]; voice?: HidingInputs["voice"] } = {}) {
  const home = makeHome({}, roots);
  mkdirSync(join(home.root, "replies"), { recursive: true });
  openLedger(openHomeFolder(home.root), { mode: "migrate" }).close();
  const logs: JsonObject[] = [];
  const writer = openWriter(openHomeFolder(home.root), join(home.root, "machine"), QUIET, (line) => logs.push(line));
  onTestFinished(() => writer.close());
  const marks = openMarks(openHomeFolder(dirname(join(home.root, "machine", "marks.db"))), join(home.root, "machine", "marks.db"));
  onTestFinished(() => marks.close());
  const detector = over.detector ?? scripted({ Rose: "person" });
  const hiding: Hiding = openHiding({
    settings: over.settings ?? (() => PRIVACY),
    names: async (known) => {
      const table = await (over.names ?? (() => NAMES))();
      return table !== undefined && table.version === known ? "same" : table;
    },
    detector, chosen: () => "runner:runner-macbook-pro-0001/privacy-filter", hidingFile: () => "privacy-filter", pictures, marks, writer: levelled(openHomeFolder(home.root), over.wrap?.(writer) ?? writer, NOW_MS), progress: () => null, existing: async () => [],
    day: () => ({ zone: "UTC", day_start_hour: 4 }), clock: () => NOW_MS, log: (line) => logs.push(line), leavesOf: async (model) => LEAVES[model],
    ...(over.bound === undefined ? {} : { bound: over.bound }),
    ...(over.route === undefined ? {} : { route: over.route }),
    ...(over.describe === undefined ? {} : { describe: over.describe }),
    ...(over.voice === undefined ? {} : { voice: over.voice }),
  });
  const ledger = () => openLedger(openHomeFolder(home.root), { mode: "write" });
  return { home, writer, hiding, detector, marks, logs, ledger };
}

const LOCAL = "runner:runner-macbook-pro-0001/qwen3.5-9b";
const FOUND = "runner:runner-macbook-pro-0001/Qwen 3.5 9B Instruct";
const LEAVES: Readonly<Record<string, string | null>> = { "codex:gpt-6-luna": "OpenAI", [LOCAL]: null, [FOUND]: null };
const chatCall = (texts: unknown[], more: JsonObject = {}): JsonObject => ({ table: "chat:c1", to: "codex:gpt-6-luna", what: "read", tool: "day", epoch: 0, texts: texts as JsonObject[], ...more });
const SPAN = { from: "2026-09-08", to: "2026-09-08" };
const linesOf = (refs: readonly string[]): HidingInputs["route"] => async () => ({ status: 200, epoch: 0, value: { what: "lines", span: SPAN, lines: refs.map((ref) => ({ text: "a line", ref })) } });
const readSpan = (hiding: Hiding) => hiding.read(TURN, "/v1/read", { args: SPAN, to: "codex:gpt-6-luna", shown: [] });

describe("the door's hiding, in this process", () => {
  it("D13: restores a model's words with each cited handle's descriptor beside its ref, those a describe left unopened asked again; a store not ready answers the words without them", async () => {
    const asked: string[][] = [];
    let refuse = false;
    let short = true;
    const describe: HidingInputs["describe"] = async (refs) => {
      asked.push([...refs]);
      if (refuse) throw new Refusal(503, "NOT_NOW", "Lifestream's index is being written: ask again in a moment", RETRY_SOON_S);
      const described = refs.map((ref) => ({ ref, kind: "person" as const, name: `Name of ${ref}`, opens: { page: "people" as const, id: ref } }));
      if (!short || refs.length === 1) return { described };
      short = false;
      return { described: described.slice(0, 1), unopened: refs.slice(1) };
    };
    const first = "person.WyJwZXJzb24iLCJwaG9uZTorMTU1NTAwMDAwMDEiXQ", second = "person.WyJwZXJzb24iLCJwaG9uZTorMTU1NTAwMDAwMDIiXQ";
    const { hiding } = inProcess({ describe, route: linesOf([first, second]) });
    await readSpan(hiding);
    const restored = await hiding.restore(CHAT, { table: "chat:c1", text: "Both [r2, r1], and [r1] again." });
    expect(restored.refs).toEqual([{ handle: "r2", ref: second }, { handle: "r1", ref: first }]);
    expect(restored.citations).toEqual({
      r2: { ref: second, kind: "person", name: `Name of ${second}`, opens: { page: "people", id: second } },
      r1: { ref: first, kind: "person", name: `Name of ${first}`, opens: { page: "people", id: first } },
    });
    expect(asked).toEqual([[second, first], [first]]);
    refuse = true;
    const plain = await hiding.restore(CHAT, { table: "chat:c1", text: "Again [r1]." });
    expect(plain).toMatchObject({ text: "Again [r1].", refs: [{ handle: "r1", ref: first }] });
    expect(plain).not.toHaveProperty("citations");
  });

  it("D1, D2, D11: hides a Chat call's texts under privacy.chat and writes its read row first, a piece of no declared kind free; restores the model's words and its tool's parameters, guessing nothing", async () => {
    const day = (line: number) => JSON.stringify({ day: "2026-11-10", line });
    const note = JSON.stringify({ source: "notes:local:poll", kind: "note", key: "n1" });
    const { hiding, writer } = inProcess({ route: linesOf([day(3), day(4), note]) });
    const answer = await hiding.hide(CHAT, chatCall([
      [{ text: "10:00 " }, { text: "Ada Example", is: "person", who: "p-ada" }, { text: ": dinner with Rose? Call +15550000001 or write to person-a@example.com.", free: true }],
    ]));
    expect(answer).toEqual({
      level: "all", epoch: 0,
      texts: ["10:00 [[Person 1]]: dinner with [[Person 2]]? Call [[Phone 1]] or write to [[Email 1]]."],
      spans: [[
        { start: 6, end: 17, placeholder: "[[Person 1]]" }, { start: 31, end: 35, placeholder: "[[Person 2]]" },
        { start: 42, end: 54, placeholder: "[[Phone 1]]" }, { start: 67, end: 87, placeholder: "[[Email 1]]" },
      ]],
    });
    const today = "2026-09-08";
    const { rows } = await writer.list({ from: today, to: today, day: { zone: "UTC", day_start_hour: 4 } });
    expect(rows).toMatchObject([{ receiver: "OpenAI", route: "codex:gpt-6-luna", by: "p-chat0001", what: "read", tool: "day", level: "all", counts: { person: 2, phone: 1, email: 1 }, pictures: 0 }]);
    expect((await hiding.hide(CHAT, chatCall([[{ text: "Rose wrote from person-a@example.com." }]]))).texts).toEqual(["[[Person 2]] wrote from [[Email 1]]."]);
    expect((await readSpan(hiding)).value).toMatchObject({ lines: [{ ref: "r1" }, { ref: "r2" }, { ref: "r3" }] });

    const restored = await hiding.restore(CHAT, { table: "chat:c1", text: "Ask [[person 1]] about [r1]; [[Person 9]] and Person 2 too." });
    expect(restored).toEqual({
      level: "all", epoch: 0, text: "Ask Ada Example about [r1]; [[Person 9]] and Rose too.",
      marks: [{ start: 4, end: 15, type: "person", who: "p-ada", placeholder: "[[person 1]]" }, { start: 45, end: 49, type: "person", placeholder: "Person 2" }],
      unknown: ["[[Person 9]]"], refs: [{ handle: "r1", ref: day(3) }],
    });
    const listed = await hiding.restore(CHAT, { table: "chat:c1", text: "Both [r2, r3], and [r3,r99] again." });
    expect([listed.text, listed.refs]).toEqual(["Both [r2, r3], and [r3,r99] again.", [{ handle: "r2", ref: day(4) }, { handle: "r3", ref: note }]]);
    expect((await writer.part("chat:c1", wantedOf([]))).table.next.person).toBe(10);

    const params = await hiding.restore(CHAT, { table: "chat:c1", params: [{ value: "[[Person 1]]" }, { value: "r3" }, { value: "dinner with [[Person 2]] and [[Person 9]]" }] }) as { params: { value: string; unknown: string[] }[] };
    expect(params.params.map(({ value, unknown }) => [value, unknown])).toEqual([["Ada Example", []], ["r3", []], ["dinner with Rose and [[Person 9]]", ["[[Person 9]]"]]]);
    expect(await settled(hiding.restore(CHAT, { table: "chat:c1", params: [{ value: "Rose", type: "person" }] }))).toMatchObject({ status: 422, code: "BAD_REQUEST" });
  });

  it("a turn on a model whose row leaves nothing runs at none and writes no outbound row, a runner's id and a found key with a space alike; an id no row holds is refused; a cloud row's receiver is its leaves", async () => {
    const day = (line: number) => JSON.stringify({ day: "2026-11-10", line });
    const { hiding, writer } = inProcess({ route: linesOf([day(3)]) });
    const today = "2026-09-08";
    const rows = async () => (await writer.list({ from: today, to: today, day: { zone: "UTC", day_start_hour: 4 } })).rows;
    for (const to of [LOCAL, FOUND]) {
      expect(await hiding.hide(CHAT, chatCall([[{ text: "Ada Example", is: "person", who: "p-ada" }, { text: " came by.", free: true }]], { to }))).toMatchObject({ level: "none", texts: ["Ada Example came by."] });
      expect(await hiding.hide(TURN, chatCall([[{ text: "Ada Example", is: "person", who: "p-ada" }]], { to }))).toMatchObject({ level: "none", texts: ["Ada Example"] });
      expect(await hiding.read(TURN, "/v1/read", { args: SPAN, to, shown: [] })).toMatchObject({ status: 200 });
    }
    expect(await rows()).toEqual([]);
    expect(await settled(hiding.hide(CHAT, chatCall([[{ text: "x" }]], { to: "runner:runner-macbook-pro-0001/gone" })))).toMatchObject({ status: 422, code: "BAD_REQUEST" });
    expect(await settled(hiding.read(TURN, "/v1/read", { args: SPAN, to: "codex:gpt-0", shown: [] }))).toMatchObject({ status: 422, code: "BAD_REQUEST" });
    expect(await rows()).toEqual([]);
    expect(await hiding.hide(CHAT, chatCall([[{ text: "Ada Example", is: "person", who: "p-ada" }]]))).toMatchObject({ level: "all", texts: ["[[Person 1]]"] });
    expect(await rows()).toMatchObject([{ receiver: "OpenAI", route: "codex:gpt-6-luna", level: "all" }]);
  });

  it("D13: a long record's text is hidden whole, as one piece, in each call: a detail every page reaches is one placeholder, put back whole; a piece cut from inside its text is refused", async () => {
    const { hiding } = inProcess();
    const whole = `${"a word ".repeat(300)}Rose said call +15550000001 later. ${"more words ".repeat(300)}`;
    const expected = `${"a word ".repeat(300)}[[Person 1]] said call [[Phone 1]] later. ${"more words ".repeat(300)}`;
    const first = await hiding.hide(CHAT, chatCall([[{ text: whole, free: true }]]));
    expect(first.texts).toEqual([expected]);
    const again = await hiding.hide(CHAT, chatCall([[{ text: whole, free: true }]]));
    expect(again.texts).toEqual([expected]);
    expect(await hiding.restore(CHAT, { table: "chat:c1", text: "[[Phone 1]]" })).toMatchObject({ text: "+15550000001", unknown: [] });
    const start = whole.indexOf("+15550000001") + 4;
    for (const piece of [{ text: whole.slice(start, start + 60), free: true, whole }, { text: whole.slice(start, start + 60), free: true, whole, from: start }]) {
      await expect(hiding.hide(CHAT, chatCall([[piece]]))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });

  it("D3: a call whose texts were read before an erasure, or while it ran, and one whose part an erasure emptied before its save, write nothing and answer ERASED with the epoch now; while one runs a call waits before any find, and one at an old epoch finds and keeps nothing", async () => {
    let erase: (() => void) | null = null;
    const { hiding, ledger, writer, detector, marks } = inProcess({
      wrap: (real) => ({ ...real, part: async (scope, wanted) => {
        const part = await real.part(scope, wanted);
        erase?.();
        erase = null;
        return part;
      } }),
    });
    const ada = [[{ text: "Ada Example", is: "person", who: "p-ada" }]];
    const withLedger = (work: (open: Ledger) => void) => {
      const open = ledger();
      try {
        work(open);
      } finally {
        open.close();
      }
    };
    erase = () => withLedger((open) => {
      open.placeholders.beginErasure();
      open.forget([]);
    });
    expect(await settled(hiding.hide(CHAT, chatCall(ada)))).toMatchObject({ status: 409, code: "ERASED", extra: { epoch: 1 } });

    const rose = "Rose wrote again.";
    const digests = passagesOf(rose).map((passage) => sha256(rose.slice(passage.start, passage.end)));
    expect(await settled(hiding.hide(CHAT, chatCall([[{ text: rose, free: true }]], { epoch: 1 })))).toMatchObject({ status: 503, code: "HIDE_NOT_READY", words: ERASING, retryAfter: RETRY_SOON_S });
    expect(await hiding.state()).toMatchObject({ epoch: 1, ready: false, line: ERASING });
    expect(await settled(hiding.restore(CHAT, { table: "chat:c1", text: "[[Person 1]] wrote." }))).toMatchObject({ status: 503, code: "HIDE_NOT_READY", words: ERASING, retryAfter: RETRY_SOON_S });
    expect(await settled(hiding.hide(CHAT, chatCall([[{ text: rose, free: true }]], { epoch: 0 })))).toMatchObject({ status: 409, code: "ERASED", extra: { epoch: 1 } });
    expect(detector.calls).toEqual([]);
    expect(marks.read(digests, MODEL).size).toBe(0);

    withLedger((open) => open.placeholders.endErasure());
    expect(await hiding.state()).toMatchObject({ epoch: 2, ready: true, line: null });
    expect(await settled(hiding.hide(CHAT, chatCall([[{ text: rose, free: true }]], { epoch: 1 })))).toMatchObject({ status: 409, code: "ERASED", extra: { epoch: 2 } });
    expect(detector.calls).toEqual([]);
    expect(await settled(hiding.hide(CHAT, chatCall(ada, { epoch: 0 })))).toMatchObject({ status: 409, code: "ERASED", extra: { epoch: 2 } });
    expect(await hiding.hide(CHAT, chatCall(ada, { epoch: 2 }))).toMatchObject({ epoch: 2, texts: ["[[Person 1]]"] });
    expect((await writer.list({ from: "2026-09-08", to: "2026-09-08", day: { zone: "UTC", day_start_hour: 4 } })).rows).toHaveLength(1);
    erase = () => withLedger((open) => {
      open.placeholders.beginErasure();
      open.forget([]);
      open.placeholders.endErasure();
    });
    expect(await hiding.restore(CHAT, { table: "chat:c1", text: "[[Person 1]] wrote." })).toMatchObject({ epoch: 4, text: "[[Person 1]] wrote.", unknown: ["[[Person 1]]"] });
    erase = () => withLedger((open) => open.placeholders.beginErasure());
    expect(await settled(hiding.restore(CHAT, { table: "chat:c1", text: "[[Person 1]] wrote." }))).toMatchObject({ status: 503, code: "HIDE_NOT_READY", words: ERASING });
  });

  it("D3: a search whose passages an erasure forgets between the route's read and the hide finds them and keeps no mark of them", async () => {
    const rose = "Rose wrote about the lighthouse.";
    const digests = passagesOf(rose).map((passage) => sha256(rose.slice(passage.start, passage.end)));
    let forget = (): void => undefined;
    const { hiding, detector, marks } = inProcess({
      route: async () => {
        forget();
        return {
          status: 200, epoch: 0, value: { record: { total: 1, capped: false, hits: [{
            ref: RECORD, family: "notes", day: "2026-09-08", title: "A note", snippet: rose, passages: [{ text: rose, names: [] }],
          }] } },
        };
      },
    });
    forget = () => { marks.forget(digests); };
    const searched = () => hiding.read(TURN, "/v1/search", { args: { query: "lighthouse", lists: ["record"] }, to: "codex:gpt-6-luna", shown: [] }) as unknown as Promise<{ value: { record: { hits: { snippet: string }[] } } }>;
    const answer = await searched();
    expect(answer.value.record.hits.map((hit) => [hit.snippet.includes("Rose"), hit.snippet.includes("[[Person 1]]")])).toEqual([[false, true]]);
    expect(detector.calls.length).toBeGreaterThan(0);
    expect(marks.read(digests, MODEL).size).toBe(0);
    forget = () => undefined;
    await searched();
    expect(marks.read(digests, MODEL).size).toBe(digests.length);
  });

  it("D4, D5: an agent's grant revoked while its call is in flight never brings its table back; a write of a table by another writer between a call's part and its save is never written over: the call fails, logged for the operator with its scope", async () => {
    let outside: string | null = null;
    let drop: string | null = null;
    const { hiding, writer, ledger, logs } = inProcess({
      wrap: (real) => ({ ...real, part: async (scope, wanted) => {
        const part = await real.part(scope, wanted);
        const open = ledger();
        try {
          if (scope === "chat:c2" && outside !== null) {
            const now = open.placeholders.part(scope, wantedOf([]));
            const n = now.table.next.person ?? 1;
            open.placeholders.save(now, { ...now.table, entries: [...now.table.entries, { placeholder: `[[Person ${n}]]`, type: "person", detail: outside }], next: { ...now.table.next, person: n + 1 } });
            outside = null;
          }
          if (drop === scope) open.placeholders.drop(scope);
        } finally {
          open.close();
        }
        return part;
      } }),
    });
    const ada = [[{ text: "Ada Example", is: "person", who: "p-ada" }]];
    const failed = { status: 500, code: "HIDE_FAILED", words: "Lifestream could not hide this answer" };
    outside = "Rose";
    expect(await settled(hiding.hide(CHAT, chatCall(ada, { table: "chat:c2" })))).toMatchObject(failed);
    const held = (await writer.part("chat:c2", wantedOf([{ text: "[[Person 0]] [[Person 1]] [[Person 2]]", marks: [] }]))).table.entries.map((entry) => [entry.placeholder, entry.detail]);
    expect(held).toEqual([["[[Person 1]]", "Rose"]]);
    expect((await writer.list({ from: "2026-09-08", to: "2026-09-08", day: { zone: "UTC", day_start_hour: 4 } })).rows).toEqual([]);
    outside = "Lena";
    expect(await settled(hiding.restore(CHAT, { table: "chat:c2", text: "[[Person 1]] wrote." }))).toMatchObject(failed);
    expect(logs.filter((line) => line.hiding === "failed").map((line) => line.cause)).toEqual([
      "Error: chat:c2: the table was written since the call read its part, under its turn", "Error: chat:c2: the table was written since the call read its part, under its turn",
    ]);
    expect((await hiding.hide(CHAT, chatCall(ada, { table: "chat:c2" }))).texts).toEqual(["[[Person 3]]"]);

    const grant = agent("all").agent!.table;
    drop = grant;
    expect(await settled(hiding.hide(agent("all"), chatCall(ada, { table: grant })))).toMatchObject({ status: 410, code: "TABLE_DROPPED" });
    drop = null;
    expect(await settled(hiding.hide(agent("all"), chatCall(ada, { table: grant })))).toMatchObject({ status: 410, code: "TABLE_DROPPED" });
    const part: TablePart = await writer.part(grant, wantedOf([{ text: "Ada Example", marks: [{ start: 0, end: 11, type: "person", who: "p-ada" }] }]));
    expect(part.table.entries).toEqual([]);
  });

  it("D12: a conversation's twelve calls made at once, hides and restores, take turns at its table: each answers, none races another's save, and each detail has one placeholder", async () => {
    const scope = "chat:c3";
    let open = 0;
    let most = 0;
    let stale = 0;
    const { hiding, writer } = inProcess({
      wrap: (real) => ({
        ...real,
        part: async (at, wanted) => {
          const part = await real.part(at, wanted);
          if (at === scope) most = Math.max(most, ++open);
          return part;
        },
        save: async (read, answered, row) => {
          const saved = await real.save(read, answered, row);
          if (read.table.scope === scope) {
            open--;
            if ("stale" in saved) stale++;
          }
          return saved;
        },
      }),
    });
    const email = (n: number) => `person-${String.fromCharCode(97 + n)}@example.com`;
    const calls = Array.from({ length: 12 }, (_, n) => (n % 4 === 3
      ? hiding.restore(CHAT, { table: scope, text: "[[Email 1]] wrote." })
      : hiding.hide(CHAT, chatCall([[{ text: `Ada wrote from ${email(n)}`, free: true }]], { table: scope }))));
    const answers = await Promise.all(calls.map((call) => settled(call)));
    expect(answers.filter((answer) => "status" in answer)).toEqual([]);
    expect([most, stale]).toEqual([1, 0]);
    const table = (await writer.part(scope, wantedOf([{ text: "[[Email 1]]", marks: [] }, ...answers.map((_, n) => ({ text: email(n), marks: [{ start: 0, end: email(n).length, type: "email" as const }] }))]))).table;
    const detailOf = new Map(table.entries.map((entry) => [entry.placeholder, entry.detail]));
    const given = answers.flatMap((answer, n) => {
      if (!("texts" in answer)) return [];
      const placeholder = /\[\[Email \d+\]\]/u.exec((answer.texts as string[])[0]!)![0];
      expect(detailOf.get(placeholder)).toBe(email(n));
      return [placeholder];
    });
    expect(new Set(given).size).toBe(9);
    expect(new Set(table.entries.filter((entry) => entry.type === "email").map((entry) => entry.detail)).size).toBe(9);
    for (const answer of answers) {
      if ("text" in answer && (answer.unknown as string[]).length === 0) expect(answer.text).toBe(`${detailOf.get("[[Email 1]]")} wrote.`);
    }
  });

  it("D12: one table's turn holds no other table's call", async () => {
    let gate: Promise<void> | null = null;
    let parts = 0;
    const { hiding, writer } = inProcess({
      wrap: (real) => ({ ...real, part: async (scope, wanted) => {
        const part = await real.part(scope, wanted);
        if (scope === "chat:a") {
          parts++;
          if (gate !== null) await gate;
        }
        return part;
      } }),
    });
    let open!: () => void;
    gate = new Promise((resolve) => { open = resolve; });
    const first = hiding.hide(CHAT, chatCall([[{ text: "Ada Example", is: "person", who: "p-ada" }]], { table: "chat:a" }));
    await until("the first call of chat:a holds its turn", () => parts === 1);
    gate = null;
    const second = hiding.hide(CHAT, chatCall([[{ text: "Rose came", free: true }]], { table: "chat:a" }));
    await writer.epoch();
    expect(await hiding.hide(CHAT, chatCall([[{ text: "Ada Example", is: "person", who: "p-ada" }]], { table: "chat:b" }))).toMatchObject({ texts: ["[[Person 1]]"] });
    expect(parts).toBe(1);
    open();
    expect((await first).texts).toEqual(["[[Person 1]]"]);
    expect((await second).texts).toEqual(["[[Person 2]] came"]);
    expect(parts).toBe(2);
  });

  it("D12: a hide or a restore that waits on its table's turn past its bound answers HIDE_NOT_READY, and the turn goes on to the next", async () => {
    let gate: Promise<void> | null = null;
    let parts = 0;
    let waiting = false;
    const bounds: ReturnType<typeof driven>[] = [];
    const { hiding } = inProcess({
      bound: () => {
        const bound = driven(waiting);
        bounds.push(bound);
        return bound;
      },
      wrap: (real) => ({ ...real, part: async (scope, wanted) => {
        const part = await real.part(scope, wanted);
        if (scope === "chat:d") {
          parts++;
          if (gate !== null) await gate;
        }
        return part;
      } }),
    });
    let open!: () => void;
    gate = new Promise((resolve) => { open = resolve; });
    const ada = [[{ text: "Ada Example", is: "person", who: "p-ada" }]];
    const first = hiding.hide(CHAT, chatCall(ada, { table: "chat:d" }));
    await until("the first call of chat:d holds its turn", () => parts === 1);
    waiting = true;
    const busy = { status: 503, code: "HIDE_NOT_READY", words: "Lifestream is hiding other answers: ask again in a moment", retryAfter: RETRY_SOON_S };
    expect(await settled(hiding.hide(CHAT, chatCall([[{ text: "Rose came", free: true }]], { table: "chat:d" })))).toMatchObject(busy);
    expect(await settled(hiding.restore(CHAT, { table: "chat:d", text: "[[Person 1]] wrote." }))).toMatchObject(busy);
    expect(bounds.slice(1).map((bound) => [bound.waits, bound.passed()])).toEqual([[1, true], [1, true]]);
    waiting = false;
    gate = null;
    open();
    expect((await first).texts).toEqual(["[[Person 1]]"]);
    expect(await hiding.restore(CHAT, { table: "chat:d", text: "[[Person 1]] wrote." })).toMatchObject({ text: "Ada Example wrote.", unknown: [] });
    expect((await hiding.hide(CHAT, chatCall([[{ text: "Rose came", free: true }]], { table: "chat:d" }))).texts).toEqual(["[[Person 2]] came"]);
  });

  it("D12: a call waiting for its table's turn holds no place among the calls that work: one table's search holds its turn, three more calls of it wait, and another table's call is served meanwhile", async () => {
    let gate: Promise<void> | null = null;
    let searched = 0;
    const { hiding, writer } = inProcess({
      route: async () => {
        searched++;
        if (gate !== null) await gate;
        return { status: 200, epoch: 0, value: { record: { total: 0, capped: false, hits: [] } } };
      },
    });
    let open!: () => void;
    gate = new Promise((resolve) => { open = resolve; });
    const search = hiding.read({ ...TURN, turn: { table: "chat:s", level: "all" } as never }, "/v1/search", { args: { query: "lighthouse", lists: ["record"] }, to: "codex:gpt-6-luna", shown: [] });
    await until("the search of chat:s holds its turn, reading its route", () => searched === 1);
    gate = null;
    const words = ["Rose came", "Rose left", "Rose wrote"];
    const waiting = words.map((text) => hiding.hide(CHAT, chatCall([[{ text, free: true }]], { table: "chat:s" })));
    await writer.epoch();
    expect(await hiding.hide(CHAT, chatCall([[{ text: "Ada Example", is: "person", who: "p-ada" }]], { table: "chat:b" }))).toMatchObject({ texts: ["[[Person 1]]"] });
    open();
    expect(await search).toMatchObject({ status: 200, value: { record: { hits: [] } } });
    expect((await Promise.all(waiting)).map((answer) => answer.texts)).toEqual([["[[Person 1]] came"], ["[[Person 1]] left"], ["[[Person 1]] wrote"]]);
  });

  it("D12: one bound per call, from its arrival: a restore whose wait for People's names and wait for its turn together pass it answers HIDE_NOT_READY, never late; a turn free only past the deadline is refused alike", async () => {
    let now = NOW_MS;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    onTestFinished(() => clock.mockRestore());
    let names: Promise<void> | null = null;
    let gate: Promise<void> | null = null;
    let parts = 0;
    const { hiding, writer } = inProcess({
      names: async () => {
        if (names !== null) await names;
        return NAMES;
      },
      wrap: (real) => ({ ...real, part: async (scope, wanted) => {
        const part = await real.part(scope, wanted);
        if (scope === "chat:t") {
          parts++;
          if (gate !== null) await gate;
        }
        return part;
      } }),
    });
    const busy = { status: 503, code: "HIDE_NOT_READY", words: "Lifestream is hiding other answers: ask again in a moment", retryAfter: RETRY_SOON_S };
    let openTurn!: () => void;
    gate = new Promise((resolve) => { openTurn = resolve; });
    const holder = hiding.restore(CHAT, { table: "chat:t", text: "[[Person 1]] wrote." });
    await until("a restore of chat:t holds its turn", () => parts === 1);
    gate = null;
    let openNames!: () => void;
    names = new Promise((resolve) => { openNames = resolve; });
    const late = settled(hiding.restore(CHAT, { table: "chat:t", text: "[[Person 1]] wrote." }));
    now += 20_000;
    names = null;
    openNames();
    await writer.epoch();
    now += 20_000;
    openTurn();
    expect(await holder).toMatchObject({ unknown: ["[[Person 1]]"] });
    expect(await late).toMatchObject(busy);
    names = new Promise((resolve) => { openNames = resolve; });
    const idle = settled(hiding.restore(CHAT, { table: "chat:t", text: "[[Person 1]] wrote." }));
    now += 31_000;
    names = null;
    openNames();
    expect(await idle).toMatchObject(busy);
    expect(await hiding.restore(CHAT, { table: "chat:t", text: "[[Person 1]] wrote." })).toMatchObject({ text: "[[Person 1]] wrote.", unknown: ["[[Person 1]]"] });
  });

  it("L1fix2: a turn pass is taken until it is forgotten and never after; the request it was made for is said once", () => {
    const home = makeHome({ reader: { scopes: ["read"] } }, roots);
    const principals = openHomeFolder(home.root);
    const person = readPrincipals(principals).principals.find((row) => row.unit === "reader")!;
    const turns = turnPasses();
    const status = (token: string, now_ms: number): number | object => {
      try {
        return authenticate(principals, `Bearer ${token}`, "loopback", { now_ms, public: false, turns }).turn ?? 200;
      } catch (error) {
        return (error as Refusal).status;
      }
    };
    const made = turns.open(person, { chat: "1790000000000-abcdef", level: "names" }, "POST /ask");
    const other = turns.open(person, null, "GET /ask/chats");
    const picked = turns.open(person, { chat: "1790000000000-abcdef", level: "none", pick: "none" }, "POST /ask");
    expect(status(made.token, NOW_MS)).toEqual({ id: made.turn, chat: "1790000000000-abcdef", level: "names", pick: null });
    expect(status(other.token, NOW_MS)).toEqual({ id: other.turn, chat: null, level: null, pick: null });
    expect(status(picked.token, NOW_MS)).toEqual({ id: picked.turn, chat: "1790000000000-abcdef", level: "none", pick: "none" });
    expect(status(made.token.replace(made.turn, other.turn), NOW_MS)).toBe(401);
    expect(status(`${made.token.slice(0, -4)}AAAA`, NOW_MS)).toBe(401);
    expect(turns.relayed(made.turn)).toBe("POST /ask");
    expect(turns.relayed(made.turn)).toBeNull();
    expect(status(made.token, NOW_MS + 86_400_000)).toEqual({ id: made.turn, chat: "1790000000000-abcdef", level: "names", pick: null });
    turns.forget(made.turn);
    expect(status(made.token, NOW_MS)).toBe(401);
    expect(status(other.token, NOW_MS)).toEqual({ id: other.turn, chat: null, level: null, pick: null });
    turns.forget(other.turn);
    expect(status(other.token, NOW_MS)).toBe(401);
    const third = turns.open(person, null, "GET /ask");
    expect(() => authenticate(principals, `Bearer ${third.token}`, "loopback", { now_ms: NOW_MS, public: false })).toThrow(Refusal);
  });

  it("L2fix2: a hide under a turn pass reads the level pinned on the pass, whatever the conversation's row says; another pass reads the row", async () => {
    const { hiding } = inProcess();
    const ada = chatCall([[{ text: "Ada Example", is: "person", who: "p-ada" }]], { table: "chat:t" });
    expect(await hiding.keep("chat:t", "all")).toBe("all");
    const pinned = (level: LevelName): HiddenReader => ({ pass: "p-chat0001", agent: null, turn: { table: "chat:t", level } });
    expect(await hiding.hide(pinned("none"), ada)).toMatchObject({ level: "none", texts: ["Ada Example"] });
    expect(await hiding.hide(pinned("names"), ada)).toMatchObject({ level: "names", texts: ["Ada Example"] });
    expect(await hiding.hide(CHAT, ada)).toMatchObject({ level: "all", texts: ["[[Person 1]]"] });
    expect(await hiding.keep("chat:t", "none", "none")).toBe("none");
    expect(await hiding.hide(pinned("all"), ada)).toMatchObject({ level: "all", texts: ["[[Person 1]]"] });
    expect(await hiding.chat("t", "all")).toMatchObject({ level: "all" });
    expect(await hiding.chat("t")).toMatchObject({ level: "none" });
    expect(await settled(hiding.hide(pinned("all"), chatCall([[{ text: "x", free: true }]], { table: "chat:u" })))).toMatchObject({ status: 403, code: "NOT_YOUR_TABLE" });
    expect(await hiding.keep("chat:t", "names")).toBe("none");
  });

  it("D6: waits, never answers plain, where hiding needs what is not there; never waits on a model it does not use", async () => {
    let settings = PRIVACY;
    let names: NameTable | undefined;
    const detector = scripted({ Rose: "person" });
    const bounds: ReturnType<typeof driven>[] = [];
    const { hiding, logs, writer } = inProcess({ settings: () => settings, names: () => names, detector, bound: () => {
      const bound = driven();
      bounds.push(bound);
      return bound;
    } });
    const rose = [[{ text: "Rose came by.", free: true }]];
    const known = [[{ text: "Rose and Ada wrote from person-a@example.com", free: true }]];
    const named = async () => (await writer.list({ from: "2026-09-08", to: "2026-09-08", day: { zone: "UTC", day_start_hour: 4 } })).rows[0]!.detector;
    expect(await settled(hiding.hide(CHAT, chatCall(rose)))).toMatchObject({ status: 503, code: "HIDE_NOT_READY", words: "Waiting for People to list the names of your people" });
    names = NAMES;
    detector.set({ state: "downloading", bytes: 340_000_000, total: 900_000_000 });
    expect(await hiding.hide(CHAT, chatCall(known))).toMatchObject({ level: "all", texts: ["Rose and [[Person 1]] wrote from [[Email 1]]"] });
    expect(await named()).toBeNull();
    settings = { ...PRIVACY, chat: "none" };
    expect(await hiding.hide(CHAT, chatCall(rose, { table: "chat:c-none" }))).toMatchObject({ level: "none", texts: ["Rose came by."] });
    settings = PRIVACY;
    detector.set({ state: "off" });
    expect(await hiding.hide(CHAT, chatCall([[{ text: "Ada wrote from person-a@example.com", free: true }]]))).toMatchObject({ level: "all", texts: ["[[Person 1]] wrote from [[Email 1]]"] });
    expect(detector.calls).toEqual([]);

    settings = PRIVACY;
    detector.set({ state: "ready", model: MODEL });
    const release = detector.hold();
    const held = settled(hiding.hide(CHAT, chatCall(rose)));
    await until("the call's find is held on the detector", () => detector.calls.length === 1);
    bounds.at(-1)!.pass();
    expect(await held).toMatchObject({ status: 503, code: "HIDE_NOT_READY", words: "Marking your record: 0 of 1 passages" });
    release();
    await until("the held find's marks are kept", async () => "texts" in (await settled(hiding.hide(CHAT, chatCall(rose))) as object));
    expect(await hiding.hide(CHAT, chatCall(rose))).toMatchObject({ texts: ["[[Person 2]] came by."] });
    expect(await named()).toBe(MODEL.id);
    expect(detector.calls).toHaveLength(1);

    const fresh = (text: string) => [[{ text, free: true }]];
    for (const error of [new DetectorError("NO_RUNNER", "the hiding model's find ended NO_RUNNER"), new Error("a bug in the runner's answer")]) {
      detector.throws(error);
      expect(await hiding.hide(CHAT, chatCall(fresh("Rose left Ada.")))).toMatchObject({ texts: ["Rose left [[Person 1]]."] });
      expect(await named()).toBeNull();
    }
    for (const texts of [[[{ text: "x", quote: true }]], [{ picture: BLOB }], [[{ text: "x", is: "nickname" }]], [[{ text: "+15550000001", is: "id" }]], [[{ text: RECORD, is: "ref" }]]]) {
      expect(await settled(hiding.hide(CHAT, chatCall(texts)))).toMatchObject({ status: 422, code: "BAD_REQUEST" });
    }
  });

  it("D6: a photo a read opens has its picture made anew, counted on its row; one the engine cannot read says why; one whose read or make throws says it cannot be shown, alone, the cause logged, never served plain; one the door's close cuts is the call's one 503", async () => {
    let image = BLOB;
    const { hiding, writer, logs } = inProcess({ route: async () => ({ status: 200, epoch: 0, value: { what: "photo", ref: RECORD, image, title: "Rose at the lighthouse" } }) });
    const opened = async (blob: string, args: JsonObject = { ref: "r1" }) => {
      image = blob;
      return (await hiding.read(TURN, "/v1/read", { args, to: "codex:gpt-6-luna", shown: [] }) as unknown as { value: { image: string; title: string } }).value;
    };
    expect(await opened(BLOB, SPAN)).toEqual({ what: "photo", ref: "r1", image: `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64")}`, title: "[[Person 1]] at the lighthouse" });
    expect((await opened(UNREADABLE)).image).toBe("This picture cannot be read");
    for (const [blob, how, cause] of [[BROKEN, "read", "a bug in the picture engine's adapter"], [UNBUILT, "make", "the face engine is not built"]] as const) {
      expect(await opened(blob), how).toMatchObject({ image: PICTURE_UNMADE, title: "[[Person 1]] at the lighthouse" });
      expect(logs.some((line) => line.hiding === "picture_unmade" && line.how === how && String(line.cause).includes(cause)), how).toBe(true);
    }
    image = CLOSING;
    expect(await settled(hiding.read(TURN, "/v1/read", { args: { ref: "r1" }, to: "codex:gpt-6-luna", shown: [] }))).toMatchObject({ status: 503, code: "NOT_NOW" });
    expect(logs.some((line) => line.hiding === "failed")).toBe(false);
    const { rows } = await writer.list({ from: "2026-09-08", to: "2026-09-08", day: { zone: "UTC", day_start_hour: 4 } });
    expect(rows.map((row) => row.pictures)).toEqual([0, 0, 0, 1]);
  });
});

describe("a sealed person", () => {
  const sealedAgent = (level: Level): HiddenReader => ({ ...agent(level), sealed: { people: new Set(["p-ada"]), handles: [] } });
  const corpus = ["Ada Example called about dinner from +15550000001", "Rose Example wrote about dinner"];
  const route: HidingInputs["route"] = async (path) => {
    if (path === "/v1/read") return { status: 200, epoch: 0, value: { what: "lines", span: SPAN, lines: corpus.map((text) => ({ text, ref: RECORD })) } };
    return { status: 404, epoch: 0, value: { code: "NO_ROUTE", message: "not in this test" } };
  };

  it("under none, the sealed name and number are placeholders in a read, and the same read with no sealed list is main's", async () => {
    const { hiding } = inProcess({ route });
    expect(await hiding.read(sealedAgent("none"), "/v1/read", { args: SPAN })).toMatchObject({ status: 200, value: { lines: [{ text: "[[Person 1]] called about dinner from [[Phone 1]]" }, { text: "Rose Example wrote about dinner" }] } });
    expect(await hiding.read(agent("none"), "/v1/read", { args: SPAN })).toMatchObject({ value: { lines: [{ text: corpus[0] }, { text: corpus[1] }] } });
  });

  it("with no sealed list, a read under none takes no slot and reads no name table, as on main; with one it takes both", async () => {
    let names = 0;
    let waiting = false;
    const detector = scripted({ Rose: "person" });
    const { hiding } = inProcess({ route, detector, names: () => {
      names++;
      return NAMES;
    }, bound: () => driven(waiting) });
    const release = detector.hold();
    const holding = [1, 2, 3, 4].map((n) => hiding.hide(CHAT, chatCall([[{ text: `Rose came by at ${n}.`, free: true }]], { table: `chat:h${n}` })));
    await until("four hides hold every slot, each waiting on its find", () => detector.calls.length === 4);
    const before = names;
    expect(await hiding.read(agent("none"), "/v1/read", { args: SPAN })).toMatchObject({ status: 200, value: { lines: [{ text: corpus[0] }, {}] } });
    expect(names).toBe(before);
    expect(await hiding.read({ ...agent("none"), sealed: { people: new Set(), handles: [] } }, "/v1/read", { args: SPAN })).toMatchObject({ status: 200, value: { lines: [{ text: corpus[0] }, {}] } });
    expect(names).toBe(before);
    waiting = true;
    expect(await settled(hiding.read(sealedAgent("none"), "/v1/read", { args: SPAN }))).toMatchObject({ status: 503, code: "HIDE_NOT_READY", words: "Lifestream is hiding other answers: ask again in a moment" });
    expect(names).toBeGreaterThan(before);
    waiting = false;
    release();
    expect((await Promise.all(holding)).map((answer) => answer.texts)).toEqual([1, 2, 3, 4].map((n) => [`[[Person 1]] came by at ${n}.`]));
  });
});

describe("a Chat question's photos and voice notes", () => {
  it("D13: tags the faces the labeler names on a Chat question's photo with the conversation's placeholders, saved with its table, so the answer is restored to the name; a stranger is covered unnamed; an agent's picture states no tags; GET /v1/privacy says who voice notes leave for", async () => {
    let voice: string | null = null;
    const { hiding, writer } = inProcess({ voice: () => voice });
    made.length = 0;
    const answer = await hiding.hide(CHAT, chatCall([[{ text: "Who is next to me here?", free: true }], { picture: FACES, tags: true }], { what: "text" }));
    expect(answer.texts).toEqual(["Who is next to me here?", { jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"), drew: true }]);
    expect(made.map((recipe) => [recipe.covered, recipe.written])).toEqual([[
      [{ box: { x: 10, y: 10, width: 40, height: 40 }, placeholder: "[[Person 1]]" }, { box: { x: 100, y: 10, width: 40, height: 40 } }], [],
    ]]);
    const today = "2026-09-08";
    expect((await writer.list({ from: today, to: today, day: { zone: "UTC", day_start_hour: 4 } })).rows).toMatchObject([{ what: "text", pictures: 1 }]);
    const restored = await hiding.restore(CHAT, { table: "chat:c1", text: "That is [[Person 1]]." });
    expect(restored).toMatchObject({ text: "That is Ada Example.", unknown: [] });
    expect(await settled(hiding.hide(agent("all"), { what: "read", tool: "photos", epoch: 0, texts: [{ picture: FACES, tags: true }] }))).toMatchObject({ status: 422, code: "BAD_REQUEST" });
    for (const tags of [false, "yes"]) expect(await settled(hiding.hide(CHAT, chatCall([{ picture: FACES, tags }])))).toMatchObject({ status: 422, code: "BAD_REQUEST" });
    expect(await hiding.state()).toMatchObject({ voice: { leaves: null } });
    voice = "OpenRouter";
    expect(await hiding.state()).toMatchObject({ voice: { leaves: "OpenRouter" } });
  });
});

describe("a Chat question's photo, as the model got it (docs/operating/door.md)", () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
  const asked = (hiding: Hiding, picture: JsonObject) => hiding.hide(CHAT, chatCall([[{ text: "Who is here?", free: true }], picture], { what: "text" }));

  it("says whether anything was drawn on the picture: a face covered, drew; nothing to cover, not; spans none for a picture", async () => {
    const { hiding } = inProcess();
    const covered = await asked(hiding, { picture: FACES, tags: true });
    expect(covered.texts).toEqual(["Who is here?", { jpeg: JPEG, drew: true }]);
    expect(covered.spans).toEqual([[], []]);
    expect((await asked(hiding, { picture: BARE, tags: true })).texts).toEqual(["Who is here?", { jpeg: JPEG, drew: false }]);
  });

  it("says drew with hiding off when a named face is tagged on the picture", async () => {
    const { hiding } = inProcess({ settings: () => ({ ...PRIVACY, chat: "none" }) });
    expect((await asked(hiding, { picture: FACES, tags: true })).texts).toEqual(["Who is here?", { jpeg: JPEG, drew: true }]);
    expect(made.at(-1)?.written).toEqual([{ box: { x: 10, y: 10, width: 40, height: 40 }, placeholder: "[[Person 1]]" }]);
  });

  it("refuses a picture asked with any key beside picture and tags, as main does", async () => {
    const { hiding } = inProcess();
    for (const extra of [{ keep: true }, { keep: false }, { file: BARE }]) expect(await settled(asked(hiding, { picture: FACES, tags: true, ...extra }))).toMatchObject({ status: 422, code: "BAD_REQUEST" });
  });
});

describe("a Chat photo's marks warmed at its upload (docs/operating/door.md)", () => {
  it("D14: marks a photo's read lines after its upload, so the hide at Send finds them kept and places no find; with no hiding model, a picture the engine cannot read or a fault, nothing and no throw", async () => {
    const detector = scripted({ Ada: "person" });
    const { hiding, logs } = inProcess({ detector });
    await hiding.warm(BLOB);
    expect(detector.calls).toEqual([["Ada Example"]]);
    const answer = await hiding.hide(CHAT, chatCall([{ picture: BLOB, tags: true }], { what: "text" }));
    expect(answer.texts).toHaveLength(1);
    expect(detector.calls).toHaveLength(1);
    await hiding.warm(BLOB);
    expect(detector.calls).toHaveLength(1);
    await hiding.warm(UNREADABLE);
    await hiding.warm(BROKEN);
    await hiding.warm(FACES);
    expect(detector.calls).toHaveLength(1);
    expect(logs).toContainEqual(expect.objectContaining({ hiding: "a photo's marks were not warmed" }));

    const off = scripted({ Ada: "person" });
    off.set({ state: "off" });
    const { hiding: unchosen } = inProcess({ detector: off });
    await unchosen.warm(BLOB);
    expect(off.calls).toEqual([]);
  });
});

describe("the door's hiding, through the real door on the fake runner", () => {
  it("D1, D3, D6-D10: hides for Chat and restores for Chat and an agent through the door, refuses a pass each way, reads each level at each call, refuses texts read before an erasure, and never holds a read", async () => {
    const RUNNER = "runner-macbook-pro-0001";
    const home = makeHome({
      reader: { scopes: ["read"] }, mcp: { scopes: ["admit"], unit: "mcp" }, phone: { scopes: ["read"], kind: "phone", unit: "iphone-0001" },
      ask: { scopes: ["deliver"], sources: ["ask:local:home"], unit: "ask" },
      runner: { scopes: ["run"], kind: "runner", unit: RUNNER }, drive: { scopes: ["drive"], unit: "home" }, call: { scopes: ["call"], unit: "home" },
    }, roots);
    const principals = openHomeFolder(home.root);
    const agentPass = "synthetic-token-agent".padEnd(43, "x").slice(0, 43);
    const minted = mintPrincipal(principals, {
      unit: "agent", kind: "agent", scopes: ["read"], now_ms: NOW_MS, token: agentPass,
      granted: { agent: { name: "Vault App", via: "pass", from: null, checked: false, client_id: null, resource: null } },
    });
    editSettings(home.root, { [`model.runners.${RUNNER}.files`]: ["privacy-filter"], "model.defaults.hiding": `runner:${RUNNER}/privacy-filter` });
    const db = makeHomeDb(join(home.root, "home.db"));
    holdModels(db, Object.entries(LEAVES).map(([id, leaves]) => ({ ...LUNA_ROUTE, id, leaves })));
    db.close();
    mkdirSync(join(home.root, "replies"), { recursive: true });
    openLedger(openHomeFolder(home.root), { mode: "migrate" }).close();
    const dir = mkdtempSync(join(tmpdir(), "hiding-journey-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const at = machine({ env: { LIFESTREAM_MACHINE_DIR: dir } });
    writePrepared(openHomeFolder(home.root), peopleFileOf(home.root, at.dir), PEOPLE, { rows: new Map([["names", new Map([["table", { owner: NAMES.owner, people: NAMES.people } as unknown as JsonObject]])]]), position: "p1" });
    const index = SearchIndex.write(openHomeFolder(home.root), searchFileOf(home.root, at.dir), () => true, 0, { zone: "UTC", day_start_hour: 4 });
    try {
      const note = (key: string, words: string): RecordEntry => ({
        record: { source: "notes:local:poll", kind: "note", key }, family: "notes", version: `v-${key}`, start_ms: NOW_MS, end_ms: null, title: "", text: words, who: [], link: null,
      });
      index.records([note("n1", "Rose came by."), note("n2", "Ada wrote.")], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
      index.finish();
    } finally {
      index.close();
    }
    const forwarded: { url: string; authorization: string | undefined; body: string }[] = [];
    const refused: string[] = [];
    const turnsHeld: (() => void)[] = [];
    const running = new Set<string>();
    const answers = new Map<string, { cut: () => void; answered: () => () => void }>();
    const keeps: number[] = [];
    const followers: (() => void)[] = [];
    const splits: (() => void)[] = [];
    const askStub = createHttpServer((request, response) => {
      let said = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { said += chunk; });
      request.on("end", () => {
        const line = (event: JsonObject) => `${JSON.stringify(event)}\n`;
        if (request.method === "POST" && request.url === "/ask") {
          const asked = JSON.parse(said) as { question: string; chat?: string };
          if (asked.chat !== undefined && running.has(asked.chat)) {
            refused.push(said);
            response.writeHead(409, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "This conversation is still answering its last question: stop it, or wait for its answer." }));
            return;
          }
          forwarded.push({ url: request.url, authorization: request.headers.authorization, body: said });
          if (asked.question === "Fails?") {
            response.writeHead(200, { "content-type": "application/x-ndjson" });
            return void response.end(line({ type: "error", error: "login", message: "Synthetic: signed out." }));
          }
          const chat = asked.chat ?? "new";
          if (asked.chat !== undefined) running.add(chat);
          const begin = () => {
            if (asked.question === "Split?") {
              const first = line({ type: "chat", chat, n: 2 });
              response.write(first.slice(0, 9));
              splits.push(() => response.end(`${first.slice(9)}${line({ type: "done" })}`));
              return;
            }
            response.write(line({ type: "chat", chat, n: 2 }));
            const free = () => { if (answers.get(chat)?.cut === cut) running.delete(chat); };
            const cut = () => response.destroy();
            turnsHeld.push(() => {
              free();
              response.end(line({ type: "done" }));
            });
            answers.set(chat, {
              cut,
              answered: () => {
                free();
                response.write(line({ type: "done" }));
                return () => response.end(line({ type: "title", title: "Synthetic" }));
              },
            });
          };
          const named = request.headers["lifestream-device"];
          void fetch(`${url}/v1/privacy/keep`, {
            method: "POST", headers: { authorization: request.headers.authorization!, ...(typeof named === "string" ? { "lifestream-device": named } : {}) },
          }).then(async (kept) => {
            await kept.arrayBuffer();
            keeps.push(kept.status);
            response.writeHead(200, { "content-type": "application/x-ndjson" });
            if (kept.status !== 200) {
              running.delete(chat);
              return void response.end(line({ type: "error", error: "door", message: "Lifestream couldn't keep this conversation's privacy level: ask again." }));
            }
            begin();
          });
          return;
        }
        forwarded.push({ url: request.url ?? "", authorization: request.headers.authorization, body: said });
        if (request.url === "/ask/chats/held/events") {
          response.writeHead(200, { "content-type": "application/x-ndjson" });
          followers.push(() => response.end());
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ chats: [], next: null }));
      });
    });
    await new Promise<void>((done) => askStub.listen(0, "127.0.0.1", done));
    onTestFinished(() => new Promise<void>((done) => { askStub.closeAllConnections(); askStub.close(() => done()); }));
    const doorLog: string[] = [];
    const failing = new Map<string, number>();
    const writes = (writer: Writer): Writer => ({
      ...writer,
      level: (async (scope: string, start: LevelName | null, pick?: LevelName) => {
        const left = failing.get(scope) ?? 0;
        if (start !== null && left > 0) {
          failing.set(scope, left - 1);
          throw new Refusal(503, "NOT_NOW", "Synthetic: the ledger is busy");
        }
        return start === null ? await writer.level(scope, null) : await writer.level(scope, start, pick);
      }) as Writer["level"],
    });
    const door = await serveDoor(home.root, { port: 0, max_bundle_bytes: 1 << 20 }, {
      log: (line) => { doorLog.push(line); }, machine: at, hiding: { pictures, boundMs: 3_000, writes }, ask: `http://127.0.0.1:${(askStub.address() as AddressInfo).port}`,
    });
    onTestFinished(() => door.close());
    const url = `http://127.0.0.1:${door.port}`;
    const ask = async (method: string, path: string, token: string, body?: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(`${url}${path}`, {
        method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const reader = home.tokens.reader!;
    const server = { "lifestream-server": home.tokens.mcp! };
    const text = (words: string) => [[{ text: words, free: true }]];

    const before = await ask("GET", "/v1/privacy", reader);
    expect(before).toMatchObject({ status: 200, body: { epoch: 0, ready: true, detector: { runner: RUNNER, state: "absent" }, marking: { marked: 0, total: 2, line: "Marked 0% of your record" }, chat: "all", links: "tokens" } });
    expect(before.body.levels).toMatchObject({ all: expect.arrayContaining(["person", "phone", "face"]), names: expect.not.arrayContaining(["person"]), none: [] });
    expect(await ask("POST", "/v1/hide-details", reader, chatCall(text("Rose came by.")))).toMatchObject({ status: 200, body: { level: "all", texts: ["Rose came by."] } });
    editSettings(home.root, { "privacy.chat": "none" });
    expect(await ask("POST", "/v1/hide-details", reader, chatCall(text("Rose came by."), { table: "chat:c2" }))).toMatchObject({ status: 200, body: { level: "none", texts: ["Rose came by."] } });
    editSettings(home.root, { "privacy.chat": null, "model.defaults.hiding": null });
    expect(await ask("POST", "/v1/hide-details", reader, chatCall(text("Ada wrote.")))).toMatchObject({ status: 200, body: { level: "all", texts: ["[[Person 1]] wrote."] } });
    expect(await ask("POST", "/v1/hide-details", reader, chatCall(text("Ada wrote."), { to: FOUND }))).toMatchObject({ status: 200, body: { level: "none", texts: ["Ada wrote."] } });
    expect(await ask("POST", "/v1/hide-details", reader, chatCall(text("Ada wrote."), { to: "codex:gpt-0" }))).toMatchObject({ status: 422, body: { code: "BAD_REQUEST" } });
    editSettings(home.root, { "model.defaults.hiding": `runner:${RUNNER}/privacy-filter` });

    writeFileSync(join(dir, "door-token"), `${home.tokens.runner}\n`, { mode: 0o600 });
    writeFileSync(join(dir, "script.json"), JSON.stringify({ words: { Rose: "person" }, hold: "never answered" }));
    const program = spawn(process.execPath, [...checkoutProgram(join(REPO, "packages", "runner", "test", "fake-runner.ts")), "--door", url, "--pass", join(dir, "door-token"), "--script", join(dir, "script.json")], { cwd: REPO, stdio: ["ignore", "ignore", "pipe"] });
    const exited = new Promise<void>((resolve) => program.once("exit", () => resolve()));
    onTestFinished(async () => {
      program.kill("SIGTERM");
      await exited;
    });
    await until("the hiding model is ready on the fake runner", async () => (await ask("GET", "/v1/privacy", reader)).body.detector.state === "ready");
    expect((await ask("GET", "/v1/privacy", reader)).body.detector).toMatchObject({ model: `runner:${RUNNER}/privacy-filter`, file: "privacy-filter", state: "ready" });

    const hidden = await ask("POST", "/v1/hide-details", reader, chatCall([
      [{ text: "Ada Example", is: "person", who: "p-ada" }, { text: ": Rose came by, write to person-a@example.com.", free: true }],
    ]));
    expect(hidden).toMatchObject({ status: 200, body: { level: "all", epoch: 0, texts: ["[[Person 1]]: [[Person 2]] came by, write to [[Email 1]]."] } });
    const back = await ask("POST", "/v1/restore-details", reader, { table: "chat:c1", text: "[[Person 2]] and [[Person 1]] met." });
    expect(back).toMatchObject({ status: 200, body: { text: "Rose and Ada met.", unknown: [] } });

    for (const [method, path, body] of [["POST", "/v1/count", { args: {} }], ["POST", "/v1/restore-details", { text: "x" }]] as const) {
      expect(await ask(method, path, agentPass, body), `${path} alone`).toMatchObject({ status: 403, body: { code: "THROUGH_SERVER" } });
      expect(await ask(method, path, agentPass, body, { "lifestream-server": reader }), `${path} beside a reader's pass`).toMatchObject({ status: 403, body: { code: "THROUGH_SERVER" } });
    }
    expect(await ask("GET", "/v1/status", agentPass, undefined, server)).toMatchObject({ status: 403, body: { code: "PRINCIPAL_SCOPE" } });
    expect((await ask("GET", "/v1/me", agentPass, undefined, server)).status).toBe(200);
    for (const beside of [undefined, { "lifestream-server": reader }, server]) {
      expect(await ask("POST", "/v1/hide-details", agentPass, chatCall(text("x")), beside)).toMatchObject({ status: 403, body: { code: "PRINCIPAL_SCOPE" } });
    }
    const restored = await ask("POST", "/v1/restore-details", agentPass, { table: "chat:c1", params: [{ value: "Rose" }, { value: "[[Email 1]]" }] }, server);
    expect(restored.body).toMatchObject({ level: "names" });
    expect(restored.body.params.map((param: { value: string }) => param.value)).toEqual(["Rose", "[[Email 1]]"]);
    expect(await ask("POST", "/v1/outbound", agentPass, { link: "https://example.com/a" }, server)).toMatchObject({ status: 403 });
    expect(await ask("GET", "/v1/privacy", agentPass, undefined, server)).toMatchObject({ status: 403, body: { code: "PRINCIPAL_SCOPE" } });
    for (const table of [`grant:${minted.principal.id}`, "ask:sha256:req-1"]) {
      expect(await ask("POST", "/v1/hide-details", reader, chatCall(text("x"), { table })), table).toMatchObject({ status: 403, body: { code: "NOT_YOUR_TABLE" } });
    }

    const granting = openLedger(openHomeFolder(home.root), { mode: "write" });
    granting.access.change(minted.principal.id, { from: 0, what: "granted", lines: fullAccess("all") as never, covers: [] }, { at_ms: NOW_MS, by: "person", device: null });
    granting.close();
    expect((await ask("POST", "/v1/restore-details", agentPass, { table: "chat:c1", params: [{ value: "x" }] }, server)).body).toMatchObject({ level: "all" });

    const ada = chatCall([[{ text: "Ada Example", is: "person", who: "p-ada" }]]);
    editSettings(home.root, { "privacy.chat": "names" });
    expect(await ask("POST", "/v1/hide-details", reader, { ...ada, table: "chat:c3" })).toMatchObject({ status: 200, body: { level: "names", texts: ["Ada Example"] } });
    expect(await ask("POST", "/v1/hide-details", reader, ada)).toMatchObject({ status: 200, body: { level: "all", texts: ["[[Person 1]]"] } });
    editSettings(home.root, { "privacy.chat": null });
    expect(await ask("GET", "/v1/privacy/chat/c3", reader)).toEqual({ status: 200, body: { chat: "c3", level: "names", epoch: 0 } });
    expect(await ask("GET", "/v1/privacy/chat/c1", reader)).toEqual({ status: 200, body: { chat: "c1", level: "all", epoch: 0 } });
    expect(await ask("GET", "/v1/privacy/chat/c-unread", reader)).toEqual({ status: 200, body: { chat: "c-unread", level: "all", epoch: 0 } });
    editSettings(home.root, { "privacy.chat": "none" });
    expect((await ask("GET", "/v1/privacy/chat/c-unread", reader)).body.level).toBe("none");
    editSettings(home.root, { "privacy.chat": null });
    expect(await ask("PUT", "/v1/privacy/chat/c1", reader, { level: "none" })).toMatchObject({ status: 404 });
    expect((await ask("GET", "/v1/privacy/chat/c1", reader)).body.level).toBe("all");

    const question = async (said: Record<string, unknown>, options: { token?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) => {
      const response = await fetch(`${url}/v1/ask`, {
        method: "POST", headers: { authorization: `Bearer ${options.token ?? reader}`, "content-type": "application/json", ...options.headers },
        body: JSON.stringify({ question: "Synthetic?", ...said }), ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      expect(response.status).toBe(200);
      const body = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const line = async (): Promise<string> => {
        while (!text.includes("\n")) {
          const read = await body.read();
          if (read.done) break;
          text += decoder.decode(read.value, { stream: true });
        }
        const end = text.indexOf("\n");
        const said = end === -1 ? text : text.slice(0, end);
        text = end === -1 ? "" : text.slice(end + 1);
        return said;
      };
      const first = await line();
      const rest = async (): Promise<string> => {
        for (let read = await body.read(); !read.done; read = await body.read()) text += decoder.decode(read.value, { stream: true });
        return text;
      };
      return { first, line, rest };
    };
    const passOf = (at: number) => forwarded[at]!.authorization!.slice("Bearer ".length);
    const phone = { "lifestream-device": "phone/9.9.9" };
    await question({ chat: "c1", level: "none" });
    expect(JSON.parse(forwarded[0]!.body)).toEqual({ question: "Synthetic?", chat: "c1" });
    expect(await ask("POST", "/v1/hide-details", reader, ada)).toMatchObject({ status: 200, body: { level: "none", texts: ["Ada Example"] } });
    await question({ chat: "c3", level: "all" }, { token: home.tokens.phone!, headers: phone });
    expect(await ask("POST", "/v1/hide-details", reader, { ...ada, table: "chat:c3" })).toMatchObject({ status: 200, body: { level: "all", texts: ["[[Person 1]]"] } });
    expect(await ask("POST", "/v1/hide-details", reader, ada)).toMatchObject({ status: 200, body: { level: "none" } });
    const overlapping = await ask("POST", "/v1/ask", reader, { question: "Synthetic?", chat: "c3", level: "none" });
    expect(overlapping).toMatchObject({ status: 409, body: { error: expect.stringContaining("still answering") } });
    expect(refused).toEqual([JSON.stringify({ question: "Synthetic?", chat: "c3" })]);
    expect((await ask("GET", "/v1/privacy/chat/c3", reader)).body.level).toBe("all");
    expect(await ask("POST", "/v1/hide-details", passOf(1), { ...ada, table: "chat:c3" }, phone)).toMatchObject({ status: 200, body: { level: "all", texts: ["[[Person 1]]"] } });
    expect(await ask("POST", "/v1/ask", reader, { question: "Synthetic?", chat: "c1" })).toMatchObject({ status: 409 });
    turnsHeld.shift()!();
    await question({ chat: "c1" });
    expect((await ask("GET", "/v1/privacy/chat/c1", reader)).body.level).toBe("none");
    for (let at = 0; at < 2; at += 1) turnsHeld.shift()!();
    for (const [who, token, headers] of [
      ["an agent's", agentPass, {}], ["an agent's beside the server's", agentPass, server], ["the MCP server's own", home.tokens.mcp!, {}],
      ["the person's beside the server's", reader, server], ["Ask's own", home.tokens.ask!, {}], ["a runner's", home.tokens.runner!, {}],
    ] as const) {
      expect(await ask("POST", "/v1/ask", token, { question: "Synthetic?", chat: "c1", level: "all" }, headers), who).toMatchObject({ status: 403 });
    }
    expect(await ask("GET", "/v1/privacy/chat/c1", agentPass, undefined, server)).toMatchObject({ status: 403 });
    for (const level of ["some", ["person"], null]) {
      expect(await ask("POST", "/v1/ask", reader, { question: "Synthetic?", chat: "c1", level }), JSON.stringify(level)).toMatchObject({ status: 422 });
    }
    expect(await ask("POST", "/v1/ask", reader, { question: "Synthetic?", chat: "a.b" })).toMatchObject({ status: 422 });
    expect(forwarded.length).toBe(3);
    expect((await ask("GET", "/v1/privacy/chat/c1", reader)).body.level).toBe("none");

    const leaving = new AbortController();
    await question({ level: "names" }, { signal: leaving.signal });
    expect(JSON.parse(forwarded[3]!.body)).toEqual({ question: "Synthetic?" });
    const turnPass = passOf(3);
    const id = readPrincipals(principals).principals.find((row) => row.unit === "reader")?.id;
    const me = await ask("GET", "/v1/me", turnPass);
    const own = (me.body.turn as { chat: string }).chat;
    expect(own).toMatch(/^\d{13}-[0-9a-f]{6}$/u);
    expect(me).toEqual({ status: 200, body: { id, kind: null, resource: null, turn: { chat: own, relayed: "POST /ask" } } });
    expect(await ask("GET", "/v1/me", turnPass)).toEqual({ status: 200, body: { id, kind: null, resource: null, turn: { chat: own, relayed: null } } });
    expect((await ask("GET", "/v1/me", reader)).body).toEqual({ id, kind: null, resource: null });
    expect(await ask("GET", `/v1/privacy/chat/${own}`, turnPass)).toMatchObject({ status: 200, body: { chat: own, level: "names" } });
    expect(await ask("POST", "/v1/hide-details", turnPass, { ...ada, table: `chat:${own}` })).toMatchObject({ status: 200, body: { level: "names", texts: ["Ada Example"] } });
    editSettings(home.root, { "privacy.chat": "none" });
    await question({});
    const plain = await ask("GET", "/v1/me", passOf(4));
    const fresh = (plain.body.turn as { chat: string }).chat;
    expect(fresh).not.toBe(own);
    editSettings(home.root, { "privacy.chat": null });
    expect((await ask("GET", `/v1/privacy/chat/${fresh}`, reader)).body.level).toBe("none");
    turnsHeld.pop()!();

    const reads = async (token: string) => (await ask("GET", "/v1/privacy", token)).status;
    expect(await ask("GET", "/v1/ask/chats", home.tokens.phone!, undefined, phone)).toMatchObject({ status: 200 });
    expect(forwarded.map((each) => each.url)).toEqual(["/ask", "/ask", "/ask", "/ask", "/ask", "/ask/chats"]);
    for (const each of forwarded) expect([`Bearer ${reader}`, `Bearer ${home.tokens.phone}`]).not.toContain(each.authorization);
    const listPass = passOf(5);
    expect(new Set(forwarded.map((each) => each.authorization)).size).toBe(6);
    expect(await reads(listPass)).toBe(401);
    for (const at of [0, 1, 2, 4]) await until(`the ended turn ${at}'s pass is forgotten`, async () => await reads(passOf(at)) === 401);
    for (const [who, token, headers, status] of [
      ["the turn's alone", turnPass, {}, 403], ["the turn's beside the server's", turnPass, server, 403], ["the list's", listPass, {}, 401],
      ["an ended turn's", passOf(1), phone, 401],
    ] as const) {
      for (const chat of [own, "c1"]) {
        expect((await ask("POST", "/v1/ask", token, { question: "Synthetic?", chat, level: "all" }, headers)).status, `${who}, ${chat}`).toBe(status);
      }
    }
    expect(await ask("POST", "/v1/ask", turnPass, { question: "Synthetic?" })).toMatchObject({ status: 403 });
    expect((await ask("GET", "/v1/privacy/chat/c1", reader)).body.level).toBe("none");
    expect((await ask("GET", `/v1/privacy/chat/${own}`, reader)).body.level).toBe("names");
    expect(await reads(turnPass)).toBe(200);
    expect(await ask("POST", "/v1/restore-details", turnPass, { table: `chat:${own}`, text: "[[Person 1]]" })).toMatchObject({ status: 200 });
    expect(await ask("POST", "/v1/hide-details", turnPass, ada)).toMatchObject({ status: 403, body: { code: "NOT_YOUR_TABLE" } });
    expect(await ask("POST", "/v1/restore-details", turnPass, { table: "chat:c1", text: "[[Person 1]]" })).toMatchObject({ status: 403, body: { code: "NOT_YOUR_TABLE" } });
    expect(await ask("GET", "/v1/privacy/chat/c1", turnPass)).toMatchObject({ status: 403 });
    expect(await ask("GET", "/v1/ask/chats", turnPass)).toMatchObject({ status: 403 });
    expect(await ask("GET", "/v1/outbound", turnPass)).toMatchObject({ status: 403 });
    expect(await reads(`${turnPass.slice(0, -4)}AAAA`)).toBe(401);
    expect(await reads(turnPass.replace(/^turn\.[0-9a-f]{16}/u, "turn.0123456789abcdef"))).toBe(401);
    expect(forwarded.length).toBe(6);
    const asked = () => doorLog.filter((line) => line.includes('"method":"POST","path":"/v1/ask"') && line.includes('"status":200')).length;
    await until("the four ended questions are logged", () => asked() === 4);
    leaving.abort();
    await until("the door saw the device leave", () => asked() === 5);
    expect(await reads(turnPass)).toBe(200);
    turnsHeld.shift()!();
    await until("the ended turn's pass is forgotten", async () => await reads(turnPass) === 401);
    const next = await question({ chat: own });
    const nextPass = passOf(6);
    expect(nextPass).not.toBe(turnPass);
    expect(await reads(nextPass)).toBe(200);
    expect(await reads(turnPass)).toBe(401);
    expect((await ask("GET", "/v1/me", turnPass)).status).toBe(401);
    turnsHeld.shift()!();
    expect(await next.rest()).toContain('"done"');
    await until("the second turn's pass is forgotten", async () => await reads(nextPass) === 401);

    expect(await ask("POST", "/v1/outbound", reader, { to: "codex:gpt-6-luna", link: "https://Example.com/reset/8f3k2q9xw7v1?u=4417" })).toMatchObject({ status: 200, body: { receiver: "example.com" } });
    const { rows } = (await ask("GET", "/v1/outbound", reader)).body as { rows: { receiver: string; by: string; what: string; detector: string | null }[] };
    expect(rows.map(({ receiver, what }) => `${receiver} ${what}`).sort()).toEqual([...Array<string>(11).fill("OpenAI read"), "example.com link"]);
    expect(rows.at(-1)).toMatchObject({ receiver: "OpenAI", detector: null });
    expect(rows.some((row) => row.receiver === "OpenAI" && typeof row.detector === "string")).toBe(true);

    const c5 = await question({ chat: "c5", level: "all" });
    expect(JSON.parse(c5.first)).toMatchObject({ type: "chat", chat: "c5" });
    expect((await ask("GET", "/v1/privacy/chat/c5", reader)).body.level).toBe("all");
    const c5Pass = passOf(forwarded.length - 1);
    answers.get("c5")!.cut();
    await until("c5's cut relay's pass is forgotten", async () => await reads(c5Pass) === 401);
    expect(await ask("POST", "/v1/ask", reader, { question: "Synthetic?", chat: "c5", level: "none" })).toMatchObject({ status: 409, body: { error: expect.stringContaining("still answering") } });
    expect((await ask("GET", "/v1/privacy/chat/c5", reader)).body.level).toBe("all");
    const c6 = await question({ chat: "c6", level: "all" });
    const titled = answers.get("c6")!.answered();
    expect(JSON.parse(await c6.line())).toEqual({ type: "done" });
    const c6Next = await question({ chat: "c6", level: "names" });
    expect(JSON.parse(c6Next.first)).toMatchObject({ type: "chat", chat: "c6" });
    expect((await ask("GET", "/v1/privacy/chat/c6", reader)).body.level).toBe("names");
    titled();
    expect(await c6.rest()).toContain('"title"');
    answers.get("c6")!.answered()();
    expect(await c6Next.rest()).toContain('"title"');
    const failed = await question({ question: "Fails?", chat: "c6", level: "none" });
    expect(JSON.parse(failed.first)).toMatchObject({ type: "error" });
    expect((await ask("GET", "/v1/privacy/chat/c6", reader)).body.level).toBe("names");
    const c7 = await question({ chat: "c7", level: "none" });
    expect(JSON.parse(c7.first)).toMatchObject({ type: "chat", chat: "c7" });
    expect((await ask("GET", "/v1/privacy/chat/c7", reader)).body.level).toBe("none");
    const c7Pass = passOf(forwarded.length - 1);
    expect(new Set(keeps)).toEqual(new Set([200]));
    for (let again = 0; again < 2; again += 1) {
      expect(await ask("POST", "/v1/privacy/keep", c7Pass), `keep ${again}`).toEqual({ status: 200, body: { chat: "c7", level: "none" } });
    }
    for (const [who, token, headers] of [
      ["the reader's", reader, {}], ["a phone's", home.tokens.phone!, phone], ["an agent's beside the server's", agentPass, server], ["Ask's own", home.tokens.ask!, {}],
    ] as const) {
      expect(await ask("POST", "/v1/privacy/keep", token, undefined, headers), who).toMatchObject({ status: 403 });
    }
    const following = fetch(`${url}/v1/ask/chats/held/events`, { headers: { authorization: `Bearer ${reader}` } });
    await until("the follow is held open at Ask", () => followers.length === 1);
    expect(await ask("POST", "/v1/privacy/keep", passOf(forwarded.length - 1))).toMatchObject({ status: 403, body: { code: "PRINCIPAL_SCOPE" } });
    followers.shift()!();
    expect(await (await following).text()).toBe("");
    expect((await ask("GET", "/v1/privacy/chat/c7", reader)).body.level).toBe("none");
    answers.get("c7")!.answered()();
    expect(await c7.rest()).toContain('"title"');
    failing.set("chat:c8", 1);
    const c8 = await question({ chat: "c8", level: "none" });
    expect(JSON.parse(c8.first)).toEqual({ type: "error", error: "door", message: expect.stringContaining("privacy level") });
    expect(await c8.rest()).toBe("");
    expect(keeps.at(-1)).toBe(503);
    expect((await ask("GET", "/v1/privacy/chat/c8", reader)).body.level).toBe("all");
    const c8Again = await question({ chat: "c8", level: "none" });
    expect(JSON.parse(c8Again.first)).toMatchObject({ type: "chat", chat: "c8" });
    expect([keeps.at(-1), (await ask("GET", "/v1/privacy/chat/c8", reader)).body.level]).toEqual([200, "none"]);
    answers.get("c8")!.answered()();
    expect(await c8Again.rest()).toContain('"title"');
    const piped = await fetch(`${url}/v1/ask`, {
      method: "POST", headers: { authorization: `Bearer ${reader}`, "content-type": "application/json" }, body: JSON.stringify({ question: "Split?", chat: "c9" }),
    });
    const bytes = piped.body!.getReader();
    const decoder = new TextDecoder();
    let came = "";
    while (came.length < 9) {
      const read = await bytes.read();
      if (read.done) break;
      came += decoder.decode(read.value, { stream: true });
    }
    expect(came).toBe('{"type":"');
    splits.shift()!();
    for (let read = await bytes.read(); !read.done; read = await bytes.read()) came += decoder.decode(read.value, { stream: true });
    expect(came).toBe(`${JSON.stringify({ type: "chat", chat: "c9", n: 2 })}\n${JSON.stringify({ type: "done" })}\n`);

    const epoch = (await ask("GET", "/v1/privacy", reader)).body.epoch as number;
    const ledger = openLedger(openHomeFolder(home.root), { mode: "write" });
    try {
      ledger.placeholders.beginErasure();
      expect(await ask("GET", "/v1/privacy", reader)).toMatchObject({ status: 200, body: { epoch: epoch + 1, ready: false, line: ERASING } });
      expect(await ask("POST", "/v1/hide-details", reader, chatCall(text("Rose again."), { epoch: epoch + 1 }))).toMatchObject({ status: 503, body: { code: "HIDE_NOT_READY", message: ERASING } });
      expect(await ask("POST", "/v1/restore-details", reader, { table: "chat:c1", text: "[[Person 1]] again." })).toMatchObject({ status: 503, body: { code: "HIDE_NOT_READY", message: ERASING } });
      ledger.forget([]);
      ledger.placeholders.endErasure();
    } finally {
      ledger.close();
    }
    expect(await ask("POST", "/v1/hide-details", reader, chatCall(text("Rose again."), { epoch }))).toMatchObject({ status: 409, body: { code: "ERASED", epoch: epoch + 2 } });
    expect(await ask("POST", "/v1/hide-details", reader, chatCall(text("Rose again."), { epoch: epoch + 2 }))).toMatchObject({ status: 200, body: { epoch: epoch + 2 } });

    const waiting = [1, 2].map((n) => ask("POST", "/v1/hide-details", reader, chatCall(text(`Call ${n} is never answered.`), { epoch: epoch + 2, table: `chat:c9${n}` })));
    const drive = driveHalf(url, { call: () => home.tokens.call, drive: () => home.tokens.drive });
    await until("the runner runs a find it never answers", async () => (await drive.list()).some((runner) => runner.running.length > 0));
    expect((await ask("GET", "/v1/status", reader)).status).toBe(200);
    for (const each of await Promise.all(waiting)) expect(each).toMatchObject({ status: 503, body: { code: "HIDE_NOT_READY", message: expect.stringMatching(/^Marking your record: 0 of \d passages$/u) } });
  });
});
