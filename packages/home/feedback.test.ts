import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { openHomeFolder, type HomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import { openHider, type HideAnswer, type Hider, type NameTable, type PrivacySettings } from "@lifestreamprotocol/privacy";
import {
  ATTACHMENT_BYTES, BODY_BYTES, DRAFT_BOUND_MS, DRAFT_MS, DRAFTS, EMAIL_MAX, EXPIRE_MS, FIRST_WAIT_MS, multipart, openFeedback, REPORT_FILE, reportsOnDisk, saidRefusal, SHOT_BYTES as SHOT_MOST, SHOT_FILE, TEXT_MAX,
  type About, type ChatTurn, type Feedback, type FeedbackInputs, type FeedbackOutbound, type Report,
} from "./feedback.js";
import type { AppFacts, ConnectorFacts } from "./feedback-text.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 10, 23, 9);
const ID = "3f2b8c1e-5d4a-4b6c-9e7f-0a1b2c3d4e5f";
const OTHER = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";
const MAC = "macbook-pro-0001";
const CHAT: About = { kind: "chat", chat: "1792396847000-3fa9c2", n: 2 };
const ANSWER_REF = { source: "ask", kind: "msg", key: "1792396847000-3fa9c2:0002" };
const QUESTION_REF = { source: "ask", kind: "msg", key: "1792396847000-3fa9c2:0001" };
const SHOT_HASH = `sha256:${"ab".repeat(32)}`;
const SHOT_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

const PEOPLE: NameTable = {
  version: "feedback-1",
  owner: { who: "p-owner", shown: "Owen Example" },
  people: [
    { who: "p-owner", is: "human", shown: "Owen Example", names: ["Owen Example"], accounts: [] },
    { who: "p-zorbot", is: "human", shown: "Zorbot Exampleton", names: ["Zorbot Exampleton"], accounts: [] },
    { who: "p-quorvel", is: "human", shown: "Quorvel Exampleton", names: ["Quorvel Exampleton"], accounts: [] },
  ],
};

const NONE: PrivacySettings = { level: "none", chat: "none", links: "tokens", always: [], never: [] };

function realHider(settings: Partial<PrivacySettings> = {}): Hider {
  return openHider({
    people: () => PEOPLE,
    settings: () => ({ ...NONE, ...settings }),
    detector: { find: () => Promise.reject(new Error("no detector here")), state: () => ({ state: "absent", why: "off" }) },
    pictures: { read: async () => ({ cannot: "no picture here" }), make: async () => ({ cannot: "no picture here" }) },
    marks: { id: "", epoch: "", read: () => new Map(), write: () => false, dropOthers: async () => 0, forget: () => 0, close: () => undefined },
  });
}

const APP: AppFacts = { device: "mac", release: { generation: "20261123.1", commit: "abc1234" }, encrypted: false, mac: { build: "7602", macos: "26.1", model: "Mac15,3" }, phone: null };

function turn(text = "Zorbot Exampleton called from +15550000001."): ChatTurn {
  return {
    refs: [ANSWER_REF, QUESTION_REF],
    question: { text: "Who called me?", spoken: null },
    answer: { text, steps: [{ name: "find", words: "Found", ms: 5, line: "find {who: person-a@example.com}" }], model: "gpt-6-luna", thinking: "low", ms: 2_000, end: "done" },
  };
}

const CONNECTOR: ConnectorFacts = {
  id: "gmail", name: "Gmail", contract: "2", state: "broken", reason: "failing", since_ms: T0, next_ms: null,
  words: "Gmail stopped reading", line: null, detail: null, more: null, failed: [{ at_ms: T0, error: "refused for person-a@example.com" }],
};

type Answer = "never" | "drop" | { status: number; headers?: Record<string, string>; body?: string };

interface Got {
  type: string;
  length: string | undefined;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface Worker {
  url: string;
  got: Got[];
  answers: Answer[];
  close(): Promise<void>;
}

const workers: Worker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
});

async function fakeWorker(): Promise<Worker> {
  const got: Got[] = [];
  const answers: Answer[] = [];
  const held: ServerResponse[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      got.push({ type: request.headers["content-type"] ?? "", length: request.headers["content-length"], headers: request.headers, body: Buffer.concat(chunks) });
      const fromAHome = request.headers["x-lifestream-report"] === "1" && request.headers.origin === undefined && request.headers["sec-fetch-site"] === undefined;
      if (!fromAHome) {
        response.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      const answer = answers.shift() ?? { status: 200, body: "{}" };
      if (answer === "never") held.push(response);
      else if (answer === "drop") request.socket.destroy();
      else response.writeHead(answer.status, answer.headers).end(answer.body ?? "{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const worker: Worker = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/reports`,
    got,
    answers,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  workers.push(worker);
  return worker;
}

async function partsOf(got: Got): Promise<Map<string, string | Buffer>> {
  const form = await new Response(new Uint8Array(got.body), { headers: { "content-type": got.type } }).formData();
  const parts = new Map<string, string | Buffer>();
  for (const [name, value] of form) parts.set(name, typeof value === "string" ? value : Buffer.from(await value.arrayBuffer()));
  return parts;
}

interface World {
  folder: HomeFolder;
  feedback: Feedback;
  rows: FeedbackOutbound[];
  clock: { now: number };
  erasure: { stands: boolean };
  dropped: string[];
  reopen(): Feedback;
  onDisk(id: string): Report | undefined;
}

function world(options: { hider?: Hider; url?: string | null; turn?: ChatTurn | null; staged?: Map<string, Buffer>; fetch?: typeof fetch } = {}): World {
  const root = mkdtempSync(join(tmpdir(), "lifestream-feedback-"));
  dirs.push(root);
  const folder = openHomeFolder(root);
  const rows: FeedbackOutbound[] = [];
  const clock = { now: T0 };
  const staged = options.staged ?? new Map([[SHOT_HASH, SHOT_BYTES]]);
  const current: ChatTurn | null = options.turn === undefined ? turn() : options.turn;
  const erasure = { stands: false };
  const dropped: string[] = [];
  const inputs: FeedbackInputs = {
    folder,
    hider: options.hider ?? realHider(),
    records: { turn: (chat, n) => (CHAT.kind === "chat" && chat === CHAT.chat && n === CHAT.n ? current : null) },
    health: { connector: (id) => (id === CONNECTOR.id ? CONNECTOR : null) },
    devices: { app: () => APP },
    ledger: {
      once: (row) => {
        if (!rows.some((each) => each.key === row.key)) rows.push(row);
      },
    },
    stage: {
      staged: (hash) => (staged.has(hash) ? { bytes: () => staged.get(hash)! } : undefined),
      drop: (hash) => {
        dropped.push(hash);
        staged.delete(hash);
      },
    },
    erasing: () => erasure.stands,
    url: options.url === undefined ? null : options.url,
    fetch: options.fetch ?? fetch,
    clock: () => clock.now,
    log: () => undefined,
  };
  return {
    folder,
    feedback: openFeedback(inputs),
    rows,
    clock,
    erasure,
    dropped,
    reopen: () => openFeedback(inputs),
    onDisk: (id) => {
      const bytes = folder.file(REPORT_FILE, join(root, "feedback", id, "report.json")).read();
      return bytes === undefined ? undefined : (JSON.parse(bytes.toString("utf8")) as Report);
    },
  };
}

async function drafted(feedback: Feedback, id: string, about: About) {
  const draft = await feedback.draft(id, about, MAC);
  if ("refused" in draft) throw new Error(`the draft was refused: ${draft.refused}`);
  return draft;
}

function scripted(answer: (texts: number) => HideAnswer): Hider & { bounds: unknown[]; calls: number } {
  const hider = {
    bounds: [] as unknown[],
    calls: 0,
    hide: async (texts: readonly unknown[], _level: unknown, _table: unknown, bound?: unknown) => {
      hider.calls += 1;
      hider.bounds.push(bound);
      return answer(texts.length);
    },
    mark: async () => ({ passages: 0, found: 0 }),
    ready: () => true as const,
  };
  return hider;
}

describe("a person's feedback in the home", () => {
  it("hides a phone, an email and a People name in every attachment at all, with Privacy and Chat at Don't hide", async () => {
    const { feedback } = world();
    const answer = await drafted(feedback, ID, CHAT);
    expect(answer.attachments.map((each) => each.kind)).toEqual(["answer", "app"]);
    const text = answer.attachments[0]!.text;
    for (const detail of ["Zorbot Exampleton", "+15550000001", "person-a@example.com"]) expect(text).not.toContain(detail);
    expect(text).toContain("Answer: [[Person 1]] called from [[Phone 1]].");
    expect(answer.attachments[0]!.counts).toEqual({ person: 1, phone: 1, email: 1 });
    const connector = await drafted(feedback, OTHER, { kind: "connector", connector: "gmail" });
    expect(connector.attachments.map((each) => [each.kind, each.title])).toEqual([["connector", "Gmail's status"], ["app", "App details"]]);
    expect(connector.attachments[0]!.text).toContain("refused for [[Email 1]]");
  });

  it("shapes the hide by the person's lists: a never word stays, an always word goes, a link at none keeps its address but never its secret", async () => {
    const link = "https://example.com/reset?token=Zq81kLm02PxT7vWy4RbN";
    const { feedback } = world({
      hider: realHider({ never: ["Zorbot Exampleton"], always: ["Quokkaville"], links: "none" }),
      turn: turn(`Zorbot Exampleton and Quorvel Exampleton went to Quokkaville; ${link}`),
    });
    const text = (await drafted(feedback, ID, CHAT)).attachments[0]!.text;
    expect(text).toContain("Zorbot Exampleton and [[Person 1]] went to [[");
    expect(text).not.toContain("Quokkaville");
    expect(text).not.toContain("Quorvel");
    expect(text).toContain("https://example.com/reset?token=[[Secret 1]]");
    expect(text).not.toContain("Zq81kLm02PxT7vWy4RbN");
  });

  it("offers no attachment while the hider waits, leaves out one it cannot read, and asks within the bound", async () => {
    const waiting = scripted(() => ({ wait: "Waiting for People to list the names of your people" }));
    expect((await drafted(world({ hider: waiting }).feedback, ID, CHAT)).attachments).toEqual([]);
    expect(waiting.bounds).toEqual([DRAFT_BOUND_MS]);
    const cannot = scripted(() => ({ texts: [{ cannot: "This text cannot be hidden" }, "Home: 20261123.1 (abc1234)\n"], spans: [[], []], table: { scope: "x", entries: [], next: {} }, counts: {}, detector: null }));
    const draft = await drafted(world({ hider: cannot }).feedback, ID, CHAT);
    expect(draft.attachments.map((each) => each.kind)).toEqual(["app"]);
  });

  it("answers the held draft for the same id, and offers no answer whose record is gone", async () => {
    const hider = scripted((n) => ({ texts: Array.from({ length: n }, () => "hidden"), spans: Array.from({ length: n }, () => []), table: { scope: "x", entries: [], next: {} }, counts: {}, detector: null }));
    const { feedback } = world({ hider });
    const first = await drafted(feedback, ID, CHAT);
    expect(await drafted(feedback, ID, CHAT)).toEqual(first);
    expect(hider.calls).toBe(1);
    expect((await drafted(world({ turn: null }).feedback, ID, CHAT)).attachments.map((each) => each.kind)).toEqual(["app"]);
    expect(await feedback.draft("not-a-uuid", CHAT, MAC)).toEqual({ refused: "the id is a UUID v4" });
  });

  it("sends the person's words and email as given, and each text part byte for byte as the draft showed it", async () => {
    const worker = await fakeWorker();
    const { feedback } = world({ url: worker.url });
    const draft = await drafted(feedback, ID, CHAT);
    const text = "  Zorbot Exampleton's answer was wrong — call +15550000001.\n\nÜnïcödé \u{1F600}  ";
    expect(feedback.send(ID, { text, email: "person-a@example.com", keep: ["answer", "app"] }, MAC)).toEqual({ id: ID });
    await feedback.idle();
    expect(worker.got).toHaveLength(1);
    expect(worker.got[0]!.length).toBe(String(worker.got[0]!.body.length));
    const parts = await partsOf(worker.got[0]!);
    expect(JSON.parse(parts.get("report") as string)).toEqual({ v: 1, id: ID, text, email: "person-a@example.com", about: "chat", device: "mac" });
    for (const attachment of draft.attachments) expect(parts.get(attachment.kind)).toBe(attachment.text);
    expect(feedback.report(ID)).toMatchObject({ state: "sent", sent_ms: T0, tries: 1 });
  });

  it("sends no removed attachment and no screenshot the person did not keep, and the kept one as staged", async () => {
    const worker = await fakeWorker();
    const { feedback } = world({ url: worker.url });
    await drafted(feedback, ID, CHAT);
    expect(feedback.screenshot(ID, { hash: SHOT_HASH, width: 1440, height: 900 })).toBe(true);
    feedback.send(ID, { text: "No answer, no picture", email: null, keep: ["app"] }, MAC);
    await drafted(feedback, OTHER, CHAT);
    feedback.screenshot(OTHER, { hash: SHOT_HASH, width: 1440, height: 900 });
    feedback.send(OTHER, { text: "With the picture", email: null, keep: ["app", "screenshot"] }, MAC);
    await feedback.idle();
    const [without, withShot] = await Promise.all(worker.got.map(partsOf));
    expect([...without!.keys()]).toEqual(["report", "app"]);
    expect([...withShot!.keys()]).toEqual(["report", "app", "screenshot"]);
    expect(withShot!.get("screenshot")).toEqual(SHOT_BYTES);
  });

  it("refuses a keep naming a kind the draft does not hold, and a screenshot the stage no longer has", async () => {
    const { feedback } = world({ staged: new Map() });
    await drafted(feedback, ID, { kind: "menu" });
    expect(feedback.send(ID, { text: "hi", email: null, keep: ["answer"] }, MAC)).toEqual({ refused: "the draft holds no answer" });
    feedback.screenshot(ID, { hash: SHOT_HASH, width: 10, height: 10 });
    expect(feedback.send(ID, { text: "hi", email: null, keep: ["screenshot"] }, MAC)).toEqual({ refused: "the screenshot is no longer held: add it again" });
    expect(feedback.send(ID, { text: " \n", email: null, keep: [] }, MAC)).toEqual({ refused: "the text is empty" });
  });

  it("answers Send once report.json is synced, while the Worker never answers, with the outbound row written", async () => {
    const worker = await fakeWorker();
    worker.answers.push("never");
    const { feedback, onDisk, rows } = world({ url: worker.url });
    await drafted(feedback, ID, CHAT);
    feedback.screenshot(ID, { hash: SHOT_HASH, width: 1440, height: 900 });
    expect(feedback.send(ID, { text: "It hangs", email: null, keep: ["answer", "app", "screenshot"] }, MAC)).toEqual({ id: ID });
    expect(onDisk(ID)).toMatchObject({ id: ID, state: "queued", tries: 0, text: "It hangs", refs: [ANSWER_REF, QUESTION_REF] });
    const kept = onDisk(ID)!;
    expect(rows).toEqual([{
      at_ms: T0, receiver: "lifestream", by: MAC, what: "feedback", level: "all", key: `feedback:${ID}`, pictures: 1, refs: [ANSWER_REF, QUESTION_REF], attempt: null, route: null, tool: null,
      counts: { person: 1, phone: 1, email: 1 }, chars: "It hangs".length + kept.attachments.reduce((sum, each) => sum + each.text.length, 0),
    }]);
    await worker.close();
    await feedback.idle();
  });

  it("answers 404 for a draft a restart forgot, and the same id with a report again writes nothing", async () => {
    const worker = await fakeWorker();
    const { feedback, reopen, onDisk, rows, folder } = world({ url: worker.url });
    await drafted(feedback, ID, CHAT);
    await drafted(feedback, OTHER, CHAT);
    feedback.send(ID, { text: "Kept", email: "person-a@example.com", keep: ["app"] }, MAC);
    await feedback.idle();
    const restarted = reopen();
    expect(restarted.send(OTHER, { text: "Lost", email: null, keep: ["app"] }, MAC)).toEqual({ gone: "no draft is held under this id: draft again" });
    const before = folder.file(REPORT_FILE, join(folder.root, "feedback", ID, "report.json")).read();
    expect(restarted.send(ID, { text: "Kept again", email: null, keep: [] }, MAC)).toEqual({ id: ID });
    await restarted.idle();
    expect(folder.file(REPORT_FILE, join(folder.root, "feedback", ID, "report.json")).read()).toEqual(before);
    expect(onDisk(ID)?.text).toBe("Kept");
    expect(rows).toHaveLength(1);
    expect(worker.got).toHaveLength(1);
    expect((await drafted(restarted, OTHER, { kind: "menu" })).email).toBe("person-a@example.com");
  });

  it("drops a draft an hour after its last use, and the oldest past the most it holds", async () => {
    const { feedback, clock } = world();
    await drafted(feedback, ID, { kind: "menu" });
    clock.now += DRAFT_MS;
    expect(feedback.send(ID, { text: "late", email: null, keep: [] }, MAC)).toMatchObject({ gone: expect.any(String) });
    const ids = Array.from({ length: DRAFTS + 1 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
    for (const id of ids) await drafted(feedback, id, { kind: "menu" });
    expect(feedback.send(ids[0]!, { text: "oldest", email: null, keep: [] }, MAC)).toMatchObject({ gone: expect.any(String) });
    expect(feedback.send(ids[1]!, { text: "kept", email: null, keep: [] }, MAC)).toEqual({ id: ids[1] });
  });

  it("waits 1 min after a dropped connection, 2 min after a 503, the Worker's 120 s after a 429, gives up on a 422, and expires at 30 days", async () => {
    const worker = await fakeWorker();
    worker.answers.push("drop", { status: 503 }, { status: 429, headers: { "retry-after": "120" } }, { status: 422, body: JSON.stringify({ error: "BAD_REPORT" }) });
    const { feedback, clock, onDisk } = world({ url: worker.url });
    await drafted(feedback, ID, { kind: "menu" });
    feedback.send(ID, { text: "Retry me", email: null, keep: ["app"] }, MAC);
    await feedback.idle();
    expect(onDisk(ID)).toMatchObject({ state: "queued", tries: 1, next_ms: T0 + FIRST_WAIT_MS });
    await feedback.due(T0 + FIRST_WAIT_MS - 1);
    expect(worker.got).toHaveLength(1);
    clock.now = T0 + FIRST_WAIT_MS;
    await feedback.due(clock.now);
    expect(onDisk(ID)).toMatchObject({ state: "queued", tries: 2, next_ms: clock.now + 2 * FIRST_WAIT_MS });
    clock.now += 2 * FIRST_WAIT_MS;
    await feedback.due(clock.now);
    expect(onDisk(ID)).toMatchObject({ state: "queued", tries: 3, next_ms: clock.now + 120_000 });
    clock.now += 120_000;
    await feedback.due(clock.now);
    expect(onDisk(ID)).toMatchObject({ state: "refused", tries: 4, next_ms: null, why: "BAD_REPORT" });
    await feedback.due(clock.now + EXPIRE_MS);
    expect(worker.got).toHaveLength(4);

    await drafted(feedback, OTHER, { kind: "menu" });
    worker.answers.push({ status: 503 });
    feedback.send(OTHER, { text: "Never taken", email: null, keep: [] }, MAC);
    await feedback.idle();
    await feedback.due(clock.now + EXPIRE_MS);
    expect(onDisk(OTHER)).toMatchObject({ state: "expired", next_ms: null, tries: 1 });
  });

  it("removes an erased answer and the screenshot from a queued report, which then goes without them, and from a held draft; a sent report loses them in the home and is marked", async () => {
    const worker = await fakeWorker();
    worker.answers.push("drop");
    const { feedback, folder, clock, onDisk, dropped } = world({ url: worker.url });
    await drafted(feedback, ID, CHAT);
    feedback.screenshot(ID, { hash: SHOT_HASH, width: 1440, height: 900 });
    feedback.send(ID, { text: "Queued", email: null, keep: ["answer", "app", "screenshot"] }, MAC);
    await feedback.idle();
    const sent = "9c8b7a6f-5e4d-4c3b-a2a1-0f9e8d7c6b5a";
    await drafted(feedback, sent, CHAT);
    feedback.send(sent, { text: "Sent", email: null, keep: ["answer", "app"] }, MAC);
    await feedback.idle();
    const held = "5e4d3c2b-1a0f-4e9d-8c7b-6a5f4e3d2c1b";
    await drafted(feedback, held, CHAT);
    feedback.screenshot(held, { hash: `sha256:${"cd".repeat(32)}`, width: 10, height: 10 });
    await feedback.forget([QUESTION_REF]);
    expect(onDisk(ID)).toMatchObject({ state: "queued", refs: [], screenshot: null, sent_before_erasure: false });
    expect(onDisk(ID)?.attachments.map((each) => each.kind)).toEqual(["app"]);
    expect(folder.file(SHOT_FILE, join(folder.root, "feedback", ID, "screenshot.jpg")).read()).toBeUndefined();
    expect(onDisk(sent)).toMatchObject({ state: "sent", refs: [], screenshot: null, sent_before_erasure: true });
    expect(onDisk(sent)!.attachments.map((each) => each.kind)).not.toContain("answer");
    expect(onDisk(sent)?.attachments.map((each) => each.kind)).toEqual(["app"]);
    expect(feedback.send(held, { text: "Held", email: null, keep: ["answer"] }, MAC)).toEqual({ refused: "the draft holds no answer" });
    expect(feedback.send(held, { text: "Held", email: null, keep: ["screenshot"] }, MAC)).toEqual({ refused: "the draft holds no screenshot" });
    expect(dropped).toEqual([`sha256:${"cd".repeat(32)}`, SHOT_HASH]);
    clock.now += FIRST_WAIT_MS;
    await feedback.due(clock.now);
    expect(onDisk(ID)?.state).toBe("sent");
    expect([...(await partsOf(worker.got.at(-1)!)).keys()]).toEqual(["report", "app"]);
  });

  it("forgets the answer of a draft still being made, while its hide is pending", async () => {
    let called = (): void => undefined;
    const asked = new Promise<void>((resolve) => { called = resolve; });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const real = realHider();
    const hider: Hider = {
      ...real,
      hide: async (...args: Parameters<Hider["hide"]>) => {
        called();
        await gate;
        return real.hide(...args);
      },
    };
    const { feedback } = world({ hider });
    const making = feedback.draft(ID, CHAT, MAC);
    await asked;
    expect(feedback.held(ID)).toBe(true);
    await feedback.forget([ANSWER_REF]);
    release();
    const draft = await making;
    if ("refused" in draft) throw new Error(draft.refused);
    expect(draft.attachments.map((each) => each.kind)).toEqual(["app"]);
    expect(feedback.send(ID, { text: "After", email: null, keep: ["answer"] }, MAC)).toEqual({ refused: "the draft holds no answer" });
  });

  it("waits for a try in flight before it forgets: a report the Worker took first stays sent, marked and without the answer in the home, one it did not take goes on without it", async () => {
    const answers: { status: number; release(): void; done: Promise<Response> }[] = [];
    const held: typeof fetch = () => {
      const each = answers.shift()!;
      return each.done;
    };
    const answerOf = (status: number) => {
      let release = (): void => undefined;
      const done = new Promise<Response>((resolve) => { release = () => resolve(new Response("{}", { status })); });
      return { status, release, done };
    };
    for (const [status, id] of [[201, ID], [503, OTHER]] as const) {
      const answer = answerOf(status);
      answers.push(answer);
      const { feedback, onDisk } = world({ url: "http://127.0.0.1:9/v1/reports", fetch: held });
      await drafted(feedback, id, CHAT);
      feedback.send(id, { text: "In flight", email: null, keep: ["answer", "app"] }, MAC);
      const forgetting = feedback.forget([ANSWER_REF]);
      expect(onDisk(id)?.attachments.map((each) => each.kind), `${status}: untouched while the try is out`).toEqual(["answer", "app"]);
      answer.release();
      await forgetting;
      if (status === 201) {
        expect(onDisk(id)).toMatchObject({ state: "sent", sent_before_erasure: true, refs: [] });
        expect(onDisk(id)!.attachments.map((each) => each.kind)).not.toContain("answer");
        expect(onDisk(id)?.attachments.map((each) => each.kind)).toEqual(["app"]);
      } else {
        expect(onDisk(id)).toMatchObject({ state: "queued", sent_before_erasure: false, refs: [], tries: 1 });
        expect(onDisk(id)?.attachments.map((each) => each.kind)).toEqual(["app"]);
      }
    }
  });

  it("starts no try while an erasure stands, from Send or the tick, and sends once it is done", async () => {
    const worker = await fakeWorker();
    const { feedback, erasure, onDisk } = world({ url: worker.url });
    erasure.stands = true;
    await drafted(feedback, ID, { kind: "menu" });
    expect(feedback.send(ID, { text: "During an erasure", email: null, keep: ["app"] }, MAC)).toEqual({ id: ID });
    await feedback.idle();
    await feedback.due(T0 + FIRST_WAIT_MS);
    await feedback.idle();
    expect(worker.got).toEqual([]);
    expect(onDisk(ID)).toMatchObject({ state: "queued", tries: 0 });
    erasure.stands = false;
    await feedback.due(T0 + FIRST_WAIT_MS);
    expect(onDisk(ID)).toMatchObject({ state: "sent", tries: 1 });
    expect(worker.got).toHaveLength(1);
  });

  it("rewrites the reports on disk with the home down, removing the answer and the screenshot, and says which report it could not read", async () => {
    const { feedback, folder, onDisk } = world();
    await drafted(feedback, ID, CHAT);
    feedback.screenshot(ID, { hash: SHOT_HASH, width: 1440, height: 900 });
    feedback.send(ID, { text: "On disk", email: null, keep: ["answer", "app", "screenshot"] }, MAC);
    folder.file(REPORT_FILE, join(folder.root, "feedback", OTHER, "report.json")).write(Buffer.from("not json"));
    const lines: JsonObject[] = [];
    const dropped: string[] = [];
    await reportsOnDisk(folder, { drop: (hash) => dropped.push(hash) }, (line) => lines.push(line)).forget([QUESTION_REF]);
    expect(onDisk(ID)).toMatchObject({ state: "queued", refs: [], screenshot: null });
    expect(onDisk(ID)?.attachments.map((each) => each.kind)).toEqual(["app"]);
    expect(folder.file(SHOT_FILE, join(folder.root, "feedback", ID, "screenshot.jpg")).read()).toBeUndefined();
    expect(dropped).toEqual([SHOT_HASH]);
    expect(lines).toEqual([expect.objectContaining({ feedback: "unread", id: OTHER })]);
  });

  it("says on every try that a home sends it, with no Origin, and takes the Worker's 403 to a sender without it as refused, never tried again", async () => {
    const worker = await fakeWorker();
    const { feedback } = world({ url: worker.url });
    await drafted(feedback, ID, { kind: "menu" });
    feedback.send(ID, { text: "From a home", email: null, keep: ["app"] }, MAC);
    await feedback.idle();
    expect(worker.got[0]!.headers).toMatchObject({ "x-lifestream-report": "1" });
    expect(worker.got[0]!.headers.origin).toBeUndefined();
    expect(worker.got[0]!.headers["sec-fetch-site"]).toBeUndefined();
    expect(feedback.report(ID)?.state).toBe("sent");

    const unmarked: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.delete("x-lifestream-report");
      return fetch(input, { ...init, headers });
    };
    const bare = world({ url: worker.url, fetch: unmarked });
    await drafted(bare.feedback, OTHER, { kind: "menu" });
    bare.feedback.send(OTHER, { text: "Unmarked", email: null, keep: [] }, MAC);
    await bare.feedback.idle();
    expect(bare.onDisk(OTHER)).toMatchObject({ state: "refused", why: "forbidden", next_ms: null, tries: 1 });
    await bare.feedback.due(T0 + EXPIRE_MS - 1);
    expect(worker.got).toHaveLength(2);
  });

  it("holds the Worker's limits: characters as the Worker counts them, an attachment's bytes, a screenshot's and a whole report's", () => {
    const limits = JSON.parse(readFileSync(new URL("../../worker/limits.json", import.meta.url), "utf8")) as Record<string, number>;
    expect({ text_chars: TEXT_MAX, email_chars: EMAIL_MAX, attachment_bytes: ATTACHMENT_BYTES, screenshot_bytes: SHOT_MOST, body_bytes: BODY_BYTES }).toEqual(limits);
    expect(saidRefusal({ text: "\u{1F600}".repeat(TEXT_MAX), email: null, keep: [] })).toBeNull();
    expect(saidRefusal({ text: "\u{1F600}".repeat(TEXT_MAX + 1), email: null, keep: [] })).toBe(`the text is at most ${TEXT_MAX} characters`);
    const email = `${"\u00e9".repeat(EMAIL_MAX - 12)}@example.com`;
    expect(saidRefusal({ text: "hi", email, keep: [] })).toBeNull();
    expect(saidRefusal({ text: "hi", email: `\u00e9${email}`, keep: [] })).not.toBeNull();
    const most: Report = {
      id: ID, at_ms: T0, by: MAC, device: "phone", about: CHAT, refs: [], text: "\u0001".repeat(TEXT_MAX), email,
      attachments: (["answer", "connector", "app"] as const).map((kind) => ({ kind, title: kind, text: "\u{1F600}".repeat(ATTACHMENT_BYTES / 4), counts: {} })),
      screenshot: { hash: SHOT_HASH, width: 2880, height: 1800 }, state: "queued", tries: 0, next_ms: T0, sent_ms: null, why: null, sent_before_erasure: false,
    };
    expect(multipart(most, Buffer.alloc(SHOT_MOST), `lifestream-${"f".repeat(24)}`).length).toBeLessThanOrEqual(BODY_BYTES);
  });

  it("cuts an attachment longer than the Worker takes to its bytes, never through a placeholder, counting only what is kept", async () => {
    const long = Array.from({ length: 4_000 }, (_, n) => `Zorbot Exampleton rang +1555000${String(n).padStart(4, "0")}.`).join(" ");
    const worker = await fakeWorker();
    const { feedback } = world({ url: worker.url, turn: turn(long) });
    const answer = (await drafted(feedback, ID, CHAT)).attachments.find((each) => each.kind === "answer")!;
    expect(Buffer.byteLength(answer.text)).toBeLessThanOrEqual(ATTACHMENT_BYTES);
    expect(Buffer.byteLength(answer.text)).toBeGreaterThan(ATTACHMENT_BYTES - 32);
    expect(answer.text.split("[[").length).toBe(answer.text.split("]]").length);
    expect(answer.text).not.toContain("Zorbot");
    const phones = new Set(answer.text.match(/\[\[Phone \d+\]\]/gu));
    expect(answer.counts).toMatchObject({ person: 1, phone: phones.size });
    feedback.send(ID, { text: "A long answer", email: null, keep: ["answer"] }, MAC);
    await feedback.idle();
    expect((await partsOf(worker.got[0]!)).get("answer")).toBe(answer.text);
    expect(feedback.report(ID)?.state).toBe("sent");
  });

  it("keeps a report's screenshot in the home beside it", async () => {
    const { feedback, folder } = world();
    await drafted(feedback, ID, { kind: "menu" });
    feedback.screenshot(ID, { hash: SHOT_HASH, width: 1440, height: 900 });
    feedback.send(ID, { text: "See the picture", email: null, keep: ["screenshot"] }, MAC);
    expect(folder.file(SHOT_FILE, join(folder.root, "feedback", ID, "screenshot.jpg")).read()).toEqual(SHOT_BYTES);
    expect(feedback.report(ID)?.screenshot).toEqual({ hash: SHOT_HASH, width: 1440, height: 900 });
    expect(feedback.open).toBe(false);
  });
});
