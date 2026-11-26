import { createServer, request as send, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, onTestFinished } from "vitest";
import { FIND_HANDED, type FindLine, type RunnerEnded as Ended, type RunnerFile as File, type RunnerHanded as Handed, type RunnerPlaced as Placed, type RunnerStated as Stated } from "@lifestreamprotocol/model";
import { Refusal } from "./refusal.js";
import { openRunners, wantedOn, type Runners, type RunnersOptions } from "./runners.js";
import { until } from "./test/harness-root.js";

const RUNNER = "runner-macbook-pro-0001";
const OTHER = "runner-mac-mini-bb01";
const MODEL = "qwen3.5-4b";
const EMBEDDER = "embeddinggemma-2-q8-512";
const JPEG = { media_type: "image/jpeg", base64: Buffer.from("synthetic jpeg").toString("base64") };

const file = (id: string, state: File["state"]): File => ({
  id, name: id, input: ["text", "image"], output: "text", tools: false, context_tokens: 4_000, thinking: [], bytes: 1_000, languages: [], memory_gb: 16, state, fetched_bytes: state === "ready" ? 1_000 : 0, failure: null,
});
const runner = (over: Partial<Stated> = {}): Stated => ({
  name: "Synthetic Mac", version: "1", boot: "boot-a", slots: 1, power: "mains", idle_s: 300, thermal: "nominal", memory_gb: 32, running: [], files: [file(MODEL, "ready")], ...over,
});

interface Door {
  readonly url: string;
  readonly wanted: Map<string, string[]>;
  restart(): void;
  close(): void;
  readonly begun: () => number;
  readonly refused: string[];
  readonly runners: () => Runners;
}

async function door(options: Partial<Pick<RunnersOptions, "poll_ms" | "presence_ms" | "silent_ms" | "reserved_ms">> = {}): Promise<Door> {
  const wanted = new Map<string, string[]>();
  const open = (): Runners => openRunners({ wanted: ({ unit }) => wanted.get(unit) ?? [], ...options });
  let runners = open();
  let begun = 0;
  const refused: string[] = [];
  const server: Server = createServer((request, response) => {
    begun++;
    const unit = request.headers["test-runner"];
    void runners.serve(typeof unit === "string" ? { peer: unit } : { drive: true }, request, response).catch((error: unknown) => {
      if (error instanceof Refusal) refused.push(`${error.status} ${error.code}`);
      if (response.headersSent) return void response.end();
      const refusal = error instanceof Refusal ? error : new Refusal(500, "FAILED", String(error));
      response.writeHead(refusal.status, { "content-type": "application/json" }).end(JSON.stringify({ code: refusal.code, message: refusal.words }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => {
    runners.close();
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    wanted,
    refused,
    begun: () => begun,
    runners: () => runners,
    restart() {
      runners.close();
      runners = open();
    },
    close() {
      runners.close();
    },
  };
}

async function exchange(at: Door, unit: string, stated: Stated, results: unknown[] = []): Promise<{ status: number; body: Handed & { code?: string } }> {
  const response = await fetch(`${at.url}/v1/runners/exchange`, { method: "POST", headers: { "test-runner": unit }, body: JSON.stringify({ runner: stated, results }) });
  return { status: response.status, body: await response.json() as Handed & { code?: string } };
}

function place(at: Door, { model = MODEL, abort, unit = RUNNER }: { model?: string; abort?: AbortSignal; unit?: string } = {}): Promise<Ended> {
  return fetch(`${at.url}/v1/runners/calls`, { method: "POST", body: JSON.stringify({ runner: unit, model, input: "Describe this photo.", attachments: [JPEG] }), ...(abort === undefined ? {} : { signal: abort }) })
    .then(async (response) => JSON.parse(await response.text()) as Ended);
}

async function listed(at: Door): Promise<(Stated & { unit: string; present: boolean })[]> {
  return ((await (await fetch(`${at.url}/v1/runners`)).json()) as { runners: (Stated & { unit: string; present: boolean })[] }).runners;
}

describe("the door's runners", () => {

  it("places a call on the runner that holds its model ready, hands it at the runner's exchange, takes its result once, and hands again a call the runner never read", async () => {
    const at = await door();
    await exchange(at, RUNNER, runner());
    const held = exchange(at, RUNNER, runner());
    const answered = place(at);
    const { body: handed } = await held;
    expect(handed.calls.map(({ id: _id, ...call }) => call)).toEqual([{ model: MODEL, input: "Describe this photo.", attachments: [JPEG] }]);
    const id = handed.calls[0]!.id;
    expect((await exchange(at, RUNNER, runner())).body.calls.map((call) => call.id)).toEqual([id]);
    const ok = { id, ok: { text: "A synthetic photo.", model: MODEL, input_tokens: 2_100, output_tokens: 12 } };
    void exchange(at, RUNNER, runner(), [{ id, ok: { ...ok.ok, said: "a sentence" } }]);
    expect(await answered).toEqual({ ok: ok.ok });
    const again = exchange(at, RUNNER, runner(), [ok]);
    void place(at).catch(() => undefined);
    const next = (await again).body.calls;
    expect(next).toHaveLength(1);
    expect(next[0]!.id).not.toBe(id);
  });

  it("answers NO_RUNNER, NOT_READY and BUSY at once, never waiting for a runner", async () => {
    const at = await door();
    expect(await place(at)).toMatchObject({ error: { code: "NO_RUNNER" } });
    await exchange(at, RUNNER, runner({ files: [file(MODEL, "fetching")] }));
    expect(await place(at)).toMatchObject({ error: { code: "NOT_READY" } });
    const held = exchange(at, RUNNER, runner());
    await until("the runner states its model ready", async () => (await listed(at))[0]?.files[0]?.state === "ready");
    void place(at).catch(() => undefined);
    expect((await held).body.calls).toHaveLength(1);
    expect(await place(at)).toMatchObject({ error: { code: "BUSY" } });
  });

  it("refuses a result for a call handed to another runner, and names a runner by its pass, never by what it states", async () => {
    const at = await door();
    await exchange(at, OTHER, runner({ boot: "boot-other", files: [file(MODEL, "absent")] }));
    await exchange(at, RUNNER, { ...runner(), unit: OTHER } as Stated);
    expect((await listed(at)).map((each) => [each.unit, each.boot, each.files[0]!.state]).sort()).toEqual([[OTHER, "boot-other", "absent"], [RUNNER, "boot-a", "ready"]].sort());
    const held = exchange(at, RUNNER, runner());
    const answered = place(at);
    const id = (await held).body.calls[0]!.id;
    await exchange(at, OTHER, runner({ boot: "boot-other", running: ["r-000000000000"], files: [file(MODEL, "absent")] }), [{ id, ok: { text: "Not mine to answer.", model: MODEL } }]);
    await exchange(at, RUNNER, runner({ running: [id] }), [{ id, ok: { text: "A synthetic photo.", model: MODEL } }]);
    expect(await answered).toEqual({ ok: { text: "A synthetic photo.", model: MODEL } });
    expect((await listed(at)).map((each) => each.unit).sort()).toEqual([OTHER, RUNNER].sort());
  });

  it("ends a call the door forgot as the route's interruption: the runner is told to stop it, and its late result lands nowhere", async () => {
    const at = await door();
    await exchange(at, RUNNER, runner());
    const held = exchange(at, RUNNER, runner());
    const answered = place(at);
    const id = (await held).body.calls[0]!.id;
    at.restart();
    expect(await answered).toMatchObject({ error: { code: "INTERRUPTED" } });
    const after = await exchange(at, RUNNER, runner({ running: [id] }), [{ id, ok: { text: "Too late.", model: MODEL } }]);
    expect(after).toMatchObject({ status: 200, body: { calls: [], cancel: [id] } });
  });

  it("tells the runner once, at once, to stop a call whose driver went away, counts it against its slots until the runner says it settled, and drops its late result", async () => {
    const at = await door({ poll_ms: 60_000 });
    await exchange(at, RUNNER, runner());
    const held = exchange(at, RUNNER, runner());
    const gone = new AbortController();
    const answered = place(at, { abort: gone.signal }).catch(() => null);
    const id = (await held).body.calls[0]!.id;
    const running = exchange(at, RUNNER, runner({ running: [id] }));
    await until("the runner says it runs the call", async () => (await listed(at))[0]!.running.includes(id));
    gone.abort();
    expect((await running).body).toMatchObject({ calls: [], cancel: [id] });
    expect(await answered).toBe(null);
    let again: Handed | null = null;
    void exchange(at, RUNNER, runner({ running: [id], power: "battery" }), [{ id, ok: { text: "Too late.", model: MODEL } }]).then((done) => { again = done.body; });
    await until("the exchange is held", async () => (await listed(at))[0]?.power === "battery");
    expect(again).toBe(null);
    expect(await place(at)).toEqual({ error: { code: "BUSY", model: MODEL } });
    at.wanted.set(RUNNER, [MODEL]);
    await until("the held exchange is answered", () => again !== null);
    expect(again).toEqual({ calls: [], cancel: [id], files: [MODEL] });
    const next = exchange(at, RUNNER, runner());
    await until("the runner says the call has settled", async () => (await listed(at))[0]!.running.length === 0);
    void place(at).catch(() => undefined);
    expect((await next).body.calls).toHaveLength(1);
  });

  it("refuses a result outside the wire, and forwards only the wire's members", async () => {
    const at = await door();
    await exchange(at, RUNNER, runner());
    const held = exchange(at, RUNNER, runner());
    const answered = place(at);
    const id = (await held).body.calls[0]!.id;
    for (const error of [
      { code: "FAILED", reason: "the model took too long" }, { code: "FAILED", reason: "deadline" }, { code: "FAILED", reason: "cut", seconds: 500 },
      { code: "FAILED", reason: "failed", runner: OTHER }, { code: "NOT_READY", reason: "failed" },
    ]) {
      expect(await exchange(at, RUNNER, runner({ running: [id] }), [{ id, error }])).toMatchObject({ status: 400, body: { code: "BAD_CALL" } });
    }
    expect(await exchange(at, RUNNER, runner({ running: [id] }), [{ id, ok: { text: "Two endings.", model: MODEL }, error: { code: "FAILED", reason: "failed" } }])).toMatchObject({ status: 400 });
    void exchange(at, RUNNER, runner(), [{ id, error: { code: "FAILED", reason: "too_long", model: MODEL, seconds: 1_800, said: "a sentence" } }]).catch(() => undefined);
    expect(await answered).toEqual({ error: { code: "FAILED", reason: "too_long", model: MODEL, seconds: 1_800 } });
  });

  it("places a call on the runner it names, and on no other", async () => {
    const at = await door();
    await exchange(at, OTHER, runner({ boot: "boot-other" }));
    await exchange(at, RUNNER, runner({ files: [file(MODEL, "absent")] }));
    expect(await place(at)).toEqual({ error: { code: "NOT_READY", model: MODEL } });
    expect(await place(at, { unit: "runner-gone-cc03" })).toEqual({ error: { code: "NO_RUNNER", runner: "runner-gone-cc03" } });
  });

  it("ends the calls of a runner gone NO_RUNNER", async () => {
    const at = await door({ presence_ms: 1_000 });
    await exchange(at, RUNNER, runner());
    const held = exchange(at, RUNNER, runner());
    const answered = place(at);
    expect((await held).body.calls).toHaveLength(1);
    expect(await answered).toMatchObject({ error: { code: "NO_RUNNER" } });
    expect((await listed(at))[0]).toMatchObject({ unit: RUNNER, present: false });
  });

  it("refuses an exchange from a start the runner replaced", async () => {
    const at = await door();
    await exchange(at, RUNNER, runner({ boot: "boot-a" }));
    void exchange(at, RUNNER, runner({ boot: "boot-b" })).catch(() => undefined);
    await until("the runner's later start is heard", async () => (await listed(at))[0]?.boot === "boot-b");
    expect(await exchange(at, RUNNER, runner({ boot: "boot-a" }))).toMatchObject({ status: 409, body: { code: "SUPERSEDED" } });
  });

  it("answers a held exchange its wanted files as soon as they change", async () => {
    const at = await door({ poll_ms: 60_000 });
    at.wanted.set(RUNNER, [MODEL]);
    expect((await exchange(at, RUNNER, runner())).body.files).toEqual([MODEL]);
    let answered: Handed | null = null;
    void exchange(at, RUNNER, runner({ power: "battery" })).then((done) => { answered = done.body; });
    await until("the exchange is held", async () => (await listed(at))[0]?.power === "battery");
    expect(answered).toBe(null);
    at.wanted.set(RUNNER, [MODEL, "parakeet-unified-en-0.6b"]);
    await until("the held exchange is answered its new files", () => answered !== null);
    expect(answered!.files).toEqual([MODEL, "parakeet-unified-en-0.6b"]);
  });

  it("refuses a call over 32 MiB BODY_TOO_LARGE to a driver still sending it, and takes one of 20 MiB", async () => {
    const at = await door();
    const taken = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const placing = send(`${at.url}/v1/runners/calls`, { method: "POST" }, (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
        response.on("end", () => resolve({ status: response.statusCode!, body }));
      });
      placing.on("error", reject);
      placing.end(JSON.stringify({ runner: RUNNER, model: MODEL, input: "x".repeat(20 * 1024 * 1024) }));
    });
    expect(taken.status).not.toBe(413);
    const refused = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const placing = send(`${at.url}/v1/runners/calls`, { method: "POST" }, (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
        response.on("end", () => resolve({ status: response.statusCode!, body }));
      });
      placing.on("error", reject);
      const piece = Buffer.alloc(1024 * 1024, "x");
      placing.write(`{"runner":"${RUNNER}","model":"${MODEL}","input":"`);
      for (let sent = 0; sent <= 33; sent++) placing.write(piece);
    });
    expect(refused.status).toBe(413);
    expect(JSON.parse(refused.body)).toMatchObject({ code: "BODY_TOO_LARGE" });
  });

  it("lets go of a call whose body went silent within its bound, holding nothing: the call after it is handed", async () => {
    const at = await door({ silent_ms: 300 });
    await exchange(at, RUNNER, runner());
    const ended = await new Promise<string>((resolve) => {
      const placing = send(`${at.url}/v1/runners/calls`, { method: "POST" }, (response) => {
        response.resume();
        response.on("end", () => resolve(`answered ${response.statusCode}`));
        response.on("error", () => resolve("cut"));
      });
      placing.on("error", () => resolve("cut"));
      placing.write(`{"runner":"${RUNNER}","model":"${MODEL}","in`);
    });
    expect(ended).toBe("cut");
    await until("the silent body's refusal is logged", () => at.refused.includes("503 NOT_NOW"));
    const held = exchange(at, RUNNER, runner());
    const answered = place(at);
    expect((await held).body.calls).toHaveLength(1);
    void answered.catch(() => undefined);
  });

  it("answers a call whose body arrives as the door closes INTERRUPTED at once, and takes no exchange after", async () => {
    const at = await door();
    await exchange(at, RUNNER, runner());
    const before = at.begun();
    const answered = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const placing = send(`${at.url}/v1/runners/calls`, { method: "POST" }, (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
        response.on("end", () => resolve({ status: response.statusCode!, body: body.trim() }));
      });
      placing.on("error", reject);
      const whole = JSON.stringify({ runner: RUNNER, model: MODEL, input: "Describe this photo.", attachments: [JPEG] });
      placing.write(whole.slice(0, 10));
      void until("the door serves the call", () => at.begun() > before).then(() => {
        at.close();
        placing.end(whole.slice(10));
      }, reject);
    });
    expect(await answered).toEqual({ status: 200, body: JSON.stringify({ error: { code: "INTERRUPTED", reason: "closed" } }) });
    expect(await exchange(at, RUNNER, runner())).toMatchObject({ status: 503, body: { code: "NOT_NOW" } });
  });

  it("retires the calls of a start its runner replaced: their drivers are told INTERRUPTED, the new start is never handed them, the old one is refused", async () => {
    const at = await door({ poll_ms: 1_000 });
    await exchange(at, RUNNER, runner({ boot: "boot-a" }));
    const held = exchange(at, RUNNER, runner({ boot: "boot-a" }));
    const answered = place(at);
    const id = (await held).body.calls[0]!.id;
    const running = exchange(at, RUNNER, runner({ boot: "boot-a", running: [id] }));
    await until("start A says it runs the call", async () => (await listed(at))[0]!.running.includes(id));
    const fresh = exchange(at, RUNNER, runner({ boot: "boot-b", files: [file(MODEL, "absent")] }));
    expect(await answered).toEqual({ error: { code: "INTERRUPTED", reason: "restarted", runner: RUNNER } });
    expect((await running).body.calls).toEqual([]);
    expect((await fresh).body.calls).toEqual([]);
    expect(await exchange(at, RUNNER, runner({ boot: "boot-a", running: [id] }))).toMatchObject({ status: 409, body: { code: "SUPERSEDED" } });
  });
});

const DETECTOR = "privacy-filter";
const KEY = { file: "sha256:0f0f", decode: "1" };
const detector = (state: File["state"]): File => ({ ...file(DETECTOR, state), input: ["text"], output: "marks", tools: false, context_tokens: 8_000, thinking: [], detector: KEY });
const both = (over: Partial<Stated> = {}, state: File["state"] = "ready"): Stated => runner({ files: [file(MODEL, "ready"), detector(state)], ...over });
const find = (name: string, line: FindLine, over: Partial<Placed> = {}): Placed => ({ runner: RUNNER, model: DETECTOR, input: JSON.stringify([name]), attachments: [], line, ...over });
const found = (id: string) => ({ id, ok: { text: JSON.stringify({ ...KEY, marks: [[]] }), model: DETECTOR } });
const named = (input: string): string => (JSON.parse(input) as string[])[0]!;

describe("the files wanted on a runner", () => {
  const off = { meaning: "off", model: EMBEDDER };
  it("wants the hiding model's file exactly while privacy.detector names the runner, beside the person's files, never asked for apart", () => {
    const stated = { unit: RUNNER, files: both().files };
    const runners = { [RUNNER]: { files: [MODEL] } };
    expect(wantedOn({ runners, privacy: { detector: RUNNER }, search: off }, stated)).toEqual([MODEL, DETECTOR]);
    expect(wantedOn({ runners, privacy: { detector: "off" }, search: off }, stated)).toEqual([MODEL]);
    expect(wantedOn({ runners, privacy: { detector: "runner-mac-mini-bb01" }, search: off }, stated)).toEqual([MODEL]);
    expect(wantedOn({ runners: {}, privacy: { detector: RUNNER }, search: off }, stated)).toEqual([DETECTOR]);
    expect(wantedOn({ runners: { [RUNNER]: { files: [DETECTOR] } }, privacy: { detector: RUNNER }, search: off }, stated)).toEqual([DETECTOR]);
    expect(wantedOn({ runners, privacy: { detector: RUNNER }, search: off }, { unit: RUNNER, files: [file(MODEL, "ready")] })).toEqual([MODEL]);
  });

  it("wants meaning's file exactly while search.meaning names the runner, and only one its table lists", () => {
    const stated = { unit: RUNNER, files: [file(MODEL, "ready"), file(EMBEDDER, "absent")] };
    const runners = { [RUNNER]: { files: [MODEL] } };
    const none = { detector: "off" };
    expect(wantedOn({ runners, privacy: none, search: { meaning: RUNNER, model: EMBEDDER } }, stated)).toEqual([MODEL, EMBEDDER]);
    expect(wantedOn({ runners, privacy: none, search: off }, stated)).toEqual([MODEL]);
    expect(wantedOn({ runners, privacy: none, search: { meaning: "runner-mac-mini-bb01", model: EMBEDDER } }, stated)).toEqual([MODEL]);
    expect(wantedOn({ runners, privacy: none, search: { meaning: RUNNER, model: "no-such-file" } }, stated)).toEqual([MODEL]);
  });
});

describe("the door's line for a detector's slot", () => {
  it("never refuses a find BUSY: while a batch runs, finds wait in one line, a hide call's first, then a send run's, then the marking job's, each in the order placed; a caption takes the models' slot meanwhile", async () => {
    const at = await door({ poll_ms: 60_000 });
    await exchange(at, RUNNER, both());
    const ends = new Map<string, Ended>();
    const placed = (name: string, line: FindLine) => void at.runners().place(find(name, line), new AbortController().signal).then((end) => ends.set(name, end));
    const held = exchange(at, RUNNER, both());
    placed("mark 1", "mark");
    let batch = (await held).body.calls[0]!;
    expect(named(batch.input)).toBe("mark 1");
    for (const [name, line] of [["mark 2", "mark"], ["send 1", "send"], ["hide 1", "hide"], ["send 2", "send"]] as const) placed(name, line);
    const runs = exchange(at, RUNNER, both({ running: [batch.id] }));
    const caption = place(at);
    const captioned = (await runs).body.calls[0]!;
    expect(captioned.model).toBe(MODEL);
    expect(await place(at)).toMatchObject({ error: { code: "BUSY", model: MODEL } });
    expect(ends.size).toBe(0);
    const order: string[] = [];
    for (let turn = 0; turn < 4; turn++) {
      const answer = await exchange(at, RUNNER, both({ running: [captioned.id] }), [found(batch.id)]);
      expect(answer.body.calls).toHaveLength(1);
      expect(ends.get(named(batch.input))).toEqual({ ok: found(batch.id).ok });
      batch = answer.body.calls[0]!;
      order.push(named(batch.input));
    }
    expect(order).toEqual(["hide 1", "send 1", "send 2", "mark 2"]);
    void exchange(at, RUNNER, both(), [found(batch.id), { id: captioned.id, ok: { text: "A synthetic photo.", model: MODEL } }]).catch(() => undefined);
    expect(await caption).toEqual({ ok: { text: "A synthetic photo.", model: MODEL } });
    await until("the job's last batch is answered", () => ends.has("mark 2"));
    expect([...ends.values()].every((end) => "ok" in end)).toBe(true);
  });

  it("refuses a find of more than 32 passages, of none, or with an attachment", async () => {
    const at = await door();
    await exchange(at, RUNNER, both());
    const refused = async (placed: Placed) => {
      const response = await fetch(`${at.url}/v1/runners/calls`, { method: "POST", body: JSON.stringify(placed) });
      return { status: response.status, code: ((await response.json()) as { code: string }).code };
    };
    const passages = (count: number) => JSON.stringify(Array.from({ length: count }, (_, index) => `Passage ${index}.`));
    expect(await refused(find("", "send", { input: passages(33) }))).toEqual({ status: 400, code: "BAD_CALL" });
    expect(await refused(find("", "send", { input: passages(0) }))).toEqual({ status: 400, code: "BAD_CALL" });
    expect(await refused(find("one", "send", { attachments: [JPEG] }))).toEqual({ status: 400, code: "BAD_CALL" });
    expect(await refused(find("one", "soon" as FindLine))).toEqual({ status: 400, code: "BAD_CALL" });
    await expect(at.runners().place(find("", "hide", { input: passages(33) }), new AbortController().signal)).rejects.toBeInstanceOf(Refusal);
    const held = exchange(at, RUNNER, both());
    void at.runners().place(find("", "send", { input: passages(32) }), new AbortController().signal);
    expect(JSON.parse((await held).body.calls[0]!.input)).toHaveLength(32);
  });

  it("refuses a find on a model's file and a model's call on a detector's file, so no find waits in the models' slot's line", async () => {
    const at = await door();
    await exchange(at, RUNNER, both());
    const refused = async (placed: Placed) => {
      const response = await fetch(`${at.url}/v1/runners/calls`, { method: "POST", body: JSON.stringify(placed) });
      return { status: response.status, code: ((await response.json()) as { code: string }).code };
    };
    const onModel = find("one", "mark", { model: MODEL });
    const onDetector: Placed = { runner: RUNNER, model: DETECTOR, input: JSON.stringify(["one"]), attachments: [] };
    expect(await refused(onModel)).toEqual({ status: 400, code: "BAD_CALL" });
    expect(await refused(onDetector)).toEqual({ status: 400, code: "BAD_CALL" });
    await expect(at.runners().place(onModel, new AbortController().signal)).rejects.toMatchObject({ code: "BAD_CALL", words: "a find goes to a detector's file, and a detector's file takes only finds" });
    await expect(at.runners().place(onDetector, new AbortController().signal)).rejects.toBeInstanceOf(Refusal);
    expect(at.refused).toEqual(["400 BAD_CALL", "400 BAD_CALL"]);
  });

  it("tells a find's driver it is handed as it leaves the line, never while it waits, over the drive half too", async () => {
    const at = await door({ poll_ms: 60_000 });
    await exchange(at, RUNNER, both());
    const handed: string[] = [];
    const placed = (name: string) => at.runners().place(find(name, "mark"), new AbortController().signal, () => handed.push(name));
    const held = exchange(at, RUNNER, both());
    const first = placed("first");
    expect(handed).toEqual(["first"]);
    const batch = (await held).body.calls[0]!;
    const second = placed("second");
    expect(handed).toEqual(["first"]);
    const answer = await exchange(at, RUNNER, both(), [found(batch.id)]);
    expect(handed).toEqual(["first", "second"]);
    expect(await first).toEqual({ ok: found(batch.id).ok });
    const sent = fetch(`${at.url}/v1/runners/calls`, { method: "POST", body: JSON.stringify(find("third", "hide")) }).then((response) => response.text());
    const next = exchange(at, RUNNER, both(), [found(answer.body.calls[0]!.id)]);
    expect(await second).toEqual({ ok: found(answer.body.calls[0]!.id).ok });
    const third = (await next).body.calls[0]!;
    void exchange(at, RUNNER, both(), [found(third.id)]).catch(() => undefined);
    expect((await sent).split("\n").filter((line) => line !== "")).toEqual([FIND_HANDED.trim(), JSON.stringify({ ok: found(third.id).ok })]);
    const caption = fetch(`${at.url}/v1/runners/calls`, { method: "POST", body: JSON.stringify({ runner: RUNNER, model: MODEL, input: "Describe this photo.", attachments: [JPEG] }) }).then((response) => response.text());
    const captioned = (await exchange(at, RUNNER, both())).body.calls[0]!;
    void exchange(at, RUNNER, both(), [{ id: captioned.id, ok: { text: "A synthetic photo.", model: MODEL } }]).catch(() => undefined);
    expect((await caption).trim()).toBe(JSON.stringify({ ok: { text: "A synthetic photo.", model: MODEL } }));
  });

  it("ends a find waiting INTERRUPTED when its driver goes, never handing it; NOT_READY when its model is not ready at its turn; INTERRUPTED when the door closes", async () => {
    const at = await door({ poll_ms: 60_000 });
    await exchange(at, RUNNER, both());
    const signal = new AbortController().signal;
    const held = exchange(at, RUNNER, both());
    void at.runners().place(find("first", "mark"), signal);
    const first = (await held).body.calls[0]!;
    const gone = new AbortController();
    const going = at.runners().place(find("gone", "hide"), gone.signal);
    const next = at.runners().place(find("next", "send"), signal);
    gone.abort();
    expect(await going).toEqual({ error: { code: "INTERRUPTED", reason: "driver_gone", runner: RUNNER } });
    const answer = await exchange(at, RUNNER, both(), [found(first.id)]);
    expect(answer.body.calls.map((call) => named(call.input))).toEqual(["next"]);
    const late = at.runners().place(find("late", "mark"), signal);
    void exchange(at, RUNNER, both({}, "absent"), [found(answer.body.calls[0]!.id)]).catch(() => undefined);
    expect(await next).toMatchObject({ ok: { model: DETECTOR } });
    expect(await late).toEqual({ error: { code: "NOT_READY", model: DETECTOR } });
    const busy = exchange(at, RUNNER, both());
    await until("the runner states its detector ready again", async () => (await listed(at))[0]!.files[1]!.state === "ready");
    void at.runners().place(find("busy", "mark"), signal);
    await busy;
    const waiting = at.runners().place(find("waiting", "hide"), signal);
    at.close();
    expect(await waiting).toEqual({ error: { code: "INTERRUPTED", reason: "closed", runner: RUNNER } });
  });

  it("ends a find waiting NOT_READY when its runner states its file again as no detector's, never handing it on as a model's call", async () => {
    const at = await door({ poll_ms: 60_000 });
    await exchange(at, RUNNER, both());
    const signal = new AbortController().signal;
    const held = exchange(at, RUNNER, both());
    void at.runners().place(find("first", "mark"), signal);
    const first = (await held).body.calls[0]!;
    const waiting = at.runners().place(find("waiting", "hide"), signal);
    const answer = exchange(at, RUNNER, runner({ files: [file(MODEL, "ready"), file(DETECTOR, "ready")] }), [found(first.id)]);
    expect(await waiting).toEqual({ error: { code: "NOT_READY", model: DETECTOR } });
    at.close();
    expect((await answer).body.calls).toEqual([]);
  });

  it("ends a find waiting NO_RUNNER when its runner goes, and the find handed to it", async () => {
    const at = await door({ presence_ms: 1_500 });
    await exchange(at, RUNNER, both());
    const held = exchange(at, RUNNER, both());
    const running = at.runners().place(find("running", "mark"), new AbortController().signal);
    await held;
    let settled = false;
    const waiting = at.runners().place(find("waiting", "hide"), new AbortController().signal).finally(() => { settled = true; });
    expect((await listed(at))[0]!.present).toBe(true);
    expect(settled).toBe(false);
    expect(await waiting).toEqual({ error: { code: "NO_RUNNER", runner: RUNNER } });
    expect(await running).toEqual({ error: { code: "NO_RUNNER", runner: RUNNER } });
  });
});

describe("the ask's line for the models' slot", () => {
  const embedding = (over: Partial<Stated> = {}): Stated => runner({ files: [file(EMBEDDER, "ready")], ...over });
  const embed = (name: string, role: "document" | "query"): Placed => ({ runner: RUNNER, model: EMBEDDER, input: JSON.stringify({ role, texts: [name] }), attachments: [] });
  const text = (input: string): string => (JSON.parse(input) as { texts: string[] }).texts[0]!;
  const embedded = (id: string) => ({ id, ok: { text: "[[1]]", model: EMBEDDER } });

  it("never refuses the door's ask BUSY: it waits for the batch running, ahead of any batch after it, which is BUSY at once while an ask waits", async () => {
    const at = await door({ poll_ms: 60_000 });
    await exchange(at, RUNNER, embedding());
    const signal = new AbortController().signal;
    const held = exchange(at, RUNNER, embedding());
    const batch = at.runners().place(embed("batch 1", "document"), signal);
    const running = (await held).body.calls[0]!;
    expect(text(running.input)).toBe("batch 1");
    const ends = new Map<string, Ended>();
    for (const name of ["ask 1", "ask 2"]) void at.runners().place(embed(name, "query"), signal, undefined, true).then((end) => ends.set(name, end));
    expect(await at.runners().place(embed("batch 2", "document"), signal)).toEqual({ error: { code: "BUSY", model: EMBEDDER } });
    expect(await place(at, { model: EMBEDDER })).toMatchObject({ error: { code: "BUSY", model: EMBEDDER } });
    expect(ends.size).toBe(0);
    let answer = await exchange(at, RUNNER, embedding(), [embedded(running.id)]);
    expect(await batch).toMatchObject({ ok: { model: EMBEDDER } });
    expect(answer.body.calls.map((call) => text(call.input))).toEqual(["ask 1"]);
    const first = answer.body.calls[0]!;
    answer = await exchange(at, RUNNER, embedding(), [embedded(first.id)]);
    expect(answer.body.calls.map((call) => text(call.input))).toEqual(["ask 2"]);
    await until("the first ask answered", () => ends.has("ask 1"));
    expect(ends.get("ask 1")).toMatchObject({ ok: { model: EMBEDDER } });
    const last = exchange(at, RUNNER, embedding(), [embedded(answer.body.calls[0]!.id)]);
    await until("the second ask answered", () => ends.has("ask 2"));
    void at.runners().place(embed("batch 2", "document"), signal);
    expect((await last).body.calls.map((call) => text(call.input))).toEqual(["batch 2"]);
  });

  it("ends an ask waiting INTERRUPTED when its driver goes, never handing it, and NOT_READY when the model is not ready at its turn", async () => {
    const at = await door({ poll_ms: 60_000 });
    await exchange(at, RUNNER, embedding());
    const signal = new AbortController().signal;
    const held = exchange(at, RUNNER, embedding());
    void at.runners().place(embed("batch", "document"), signal);
    const running = (await held).body.calls[0]!;
    const gone = new AbortController();
    const going = at.runners().place(embed("gone", "query"), gone.signal, undefined, true);
    const late = at.runners().place(embed("late", "query"), signal, undefined, true);
    gone.abort();
    expect(await going).toEqual({ error: { code: "INTERRUPTED", reason: "driver_gone", runner: RUNNER } });
    void exchange(at, RUNNER, embedding({ files: [file(EMBEDDER, "absent")] }), [embedded(running.id)]).catch(() => undefined);
    expect(await late).toEqual({ error: { code: "NOT_READY", model: EMBEDDER } });
  });
});

describe("Chat's line and a note's reservation", () => {
  const SPEECH = "parakeet-unified-en-0.6b";
  const NOTE_A = "a".repeat(32);
  const NOTE_B = "b".repeat(32);
  const speaking = (over: Partial<Stated> = {}): Stated => runner({ files: [file(MODEL, "ready"), { ...file(SPEECH, "ready"), input: ["audio"] }], ...over });
  const call = (name: string, chat: boolean, model = MODEL): Placed => ({ runner: RUNNER, model, input: name, attachments: [], ...(chat ? { line: "chat" as const } : {}) });
  const warm: Placed = { runner: RUNNER, model: SPEECH, input: "", attachments: [], line: "chat", warm: true };
  const answered = (id: string) => ({ id, ok: { text: "synthetic answer", model: MODEL } });

  it("never refuses a Chat call BUSY: it pre-empts the background call on its slot, waits for the runner to state it free, and Chat's calls go in the order they came", async () => {
    const at = await door({ poll_ms: 60_000 });
    await exchange(at, RUNNER, speaking());
    const signal = new AbortController().signal;
    const held = exchange(at, RUNNER, speaking());
    const background = place(at);
    const running = (await held).body.calls[0]!;
    const ends = new Map<string, Ended>();
    void at.runners().place(call("chat 1", true), signal).then((end) => ends.set("chat 1", end));
    expect(await background).toEqual({ error: { code: "INTERRUPTED", reason: "preempted", runner: RUNNER } });
    void at.runners().place(call("chat 2", true), signal).then((end) => ends.set("chat 2", end));
    expect(await at.runners().place(call("later", false), signal)).toEqual({ error: { code: "BUSY", model: MODEL } });
    let answer = await exchange(at, RUNNER, speaking({ running: [running.id] }));
    expect(answer.body).toMatchObject({ calls: [], cancel: [running.id] });
    answer = await exchange(at, RUNNER, speaking());
    expect(answer.body.calls.map((each) => each.input)).toEqual(["chat 1"]);
    answer = await exchange(at, RUNNER, speaking(), [answered(answer.body.calls[0]!.id)]);
    expect(answer.body.calls.map((each) => each.input)).toEqual(["chat 2"]);
    await until("the first Chat call answered", () => ends.has("chat 1"));
    expect(ends.get("chat 1")).toMatchObject({ ok: { model: MODEL } });
  });

  it("hands a warm call on with `warm`, only to a file that transcribes, never pre-empting, and writes no `handed` to a Chat call's driver", async () => {
    const at = await door({ poll_ms: 60_000 });
    await exchange(at, RUNNER, speaking());
    const signal = new AbortController().signal;
    await expect(at.runners().place({ ...warm, model: MODEL }, signal)).rejects.toMatchObject({ status: 400, code: "BAD_CALL" });
    const held = exchange(at, RUNNER, speaking());
    let settled = false;
    const background = place(at).finally(() => { settled = true; });
    const running = (await held).body.calls[0]!;
    const warming = at.runners().place(warm, signal);
    const next = exchange(at, RUNNER, speaking(), [answered(running.id)]);
    expect(await background).toMatchObject({ ok: { model: MODEL } });
    expect(settled).toBe(true);
    const handed = (await next).body.calls[0]!;
    expect(handed).toMatchObject({ model: SPEECH, input: "", warm: true });
    void exchange(at, RUNNER, speaking(), [{ id: handed.id, ok: { text: "", model: SPEECH } }]).catch(() => undefined);
    expect(await warming).toMatchObject({ ok: { text: "" } });
    const over = exchange(at, RUNNER, speaking());
    const body = fetch(`${at.url}/v1/runners/calls`, { method: "POST", body: JSON.stringify(call("chat", true)) }).then((response) => response.text());
    const chat = (await over).body.calls[0]!;
    void exchange(at, RUNNER, speaking(), [answered(chat.id)]).catch(() => undefined);
    expect((await body).trim().startsWith("{")).toBe(true);
  });

  it("keeps a reserved slot for the foreground: the screen job's embedding waits while any note's reservation stands, a meaning ask and a Chat call go in the order they came", async () => {
    const at = await door({ poll_ms: 60_000 });
    await exchange(at, RUNNER, speaking());
    const signal = new AbortController().signal;
    at.runners().reserve(NOTE_A, RUNNER);
    at.runners().reserve(NOTE_B, RUNNER);
    const ends = new Map<string, Ended>();
    const track = (name: string, ended: Promise<Ended>) => void ended.then((end) => ends.set(name, end));
    track("batch", at.runners().place(call("batch", false), signal));
    track("ask", at.runners().place(call("ask", false), signal, undefined, true));
    track("chat", at.runners().place(call("chat", true), signal));
    let answer = await exchange(at, RUNNER, speaking());
    expect(answer.body.calls.map((each) => each.input)).toEqual(["ask"]);
    answer = await exchange(at, RUNNER, speaking(), [answered(answer.body.calls[0]!.id)]);
    expect(answer.body.calls.map((each) => each.input)).toEqual(["chat"]);
    const chat = answer.body.calls[0]!;
    at.runners().release(NOTE_A);
    const waiting = exchange(at, RUNNER, speaking(), [answered(chat.id)]);
    await until("the Chat call answered", () => ends.has("chat"));
    expect(ends.has("batch")).toBe(false);
    at.runners().release(NOTE_B);
    expect((await waiting).body.calls.map((each) => each.input)).toEqual(["batch"]);
  });

  it("ends a reservation no open or second renewed in time, and hands the background call it held", async () => {
    const at = await door({ poll_ms: 60_000, reserved_ms: 1_500 });
    await exchange(at, RUNNER, speaking());
    at.runners().reserve(NOTE_A, RUNNER);
    const held = exchange(at, RUNNER, speaking());
    void at.runners().place(call("batch", false), new AbortController().signal);
    expect((await held).body.calls.map((each) => each.input)).toEqual(["batch"]);
  });
});
