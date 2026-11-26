import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  ArtifactError, embedAnswerOf, Refused, RUNNER_WIRE_VERSION, type Build, type RunnerAnswer as Answer, type RunnerCall as Call, type RunnerExchange as Exchange, type RunnerHanded as Handed, type RunnerResult as Result,
} from "@lifestreamprotocol/model";
import { canonicalWav, decodeAudio, MOST_SECONDS } from "./audio.js";
import { detectorLibrary, withFallback, type Classifier } from "./detector.js";
import { detectorRow, FILES, OLLAMA, ollamaRow, speechRow, type OllamaRow, type Row } from "./files.js";
import { HELD, HELD_SAID, leashCommand } from "./leash.js";
import { Failed, NotReady, type Library } from "./library.js";
import { ollamaLibrary, type OllamaManifest } from "./ollama.js";
import { openOllama, type OllamaChild, type OllamaOptions } from "./ollama-child.js";
import { idleOf, powerOf, serve, thermalOf, type RunnerOptions } from "./serve.js";
import { speechLibrary, type Transcriber } from "./speech.js";
import { syntheticTokenizer, tokenizerOf } from "./test/synthetic-tokenizer.js";

const WAIT_MS = 30_000;
const PICTURES = "qwen3.5-4b";
const SPEECH = "parakeet-unified-en-0.6b";
const LANGUAGES = "nemotron-3.5-asr-0.6b";
const DETECTOR = "privacy-filter";
const JPEG = { media_type: "image/jpeg", base64: Buffer.from("synthetic jpeg").toString("base64") };

async function until(what: string, ready: () => boolean): Promise<void> {
  const end = Date.now() + WAIT_MS;
  while (!ready()) {
    if (Date.now() > end) throw new Error(`never came in ${WAIT_MS / 1_000} s: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "runner-e2e-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sha = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

async function listen(answer: (request: IncomingMessage, body: string, response: ServerResponse) => void | Promise<void>): Promise<string> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => void answer(request, body, response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function files(served: Map<string, Buffer>) {
  const asked: string[] = [];
  const url = await listen((request, _body, response) => {
    asked.push(request.url!);
    const bytes = served.get(request.url!);
    if (bytes === undefined) return void response.writeHead(404).end();
    response.writeHead(200, { "content-length": bytes.length }).end(bytes);
  });
  return { url, asked };
}

async function door() {
  const state = {
    seen: [] as Exchange[], answered: [] as Exchange[], headers: new Set<string>(), files: [] as string[], calls: [] as Call[], cancel: [] as string[],
    refusal: null as { status: number; code: string } | null,
    last: (): Exchange | undefined => state.seen.at(-1),
    results: (): Result[] => state.seen.flatMap((sent) => sent.results),
    file: (id: string) => state.last()?.runner.files.find((each) => each.id === id),
    running: (id: string): boolean => state.last()?.runner.running.includes(id) === true,
  };
  let told: string | null = null;
  const toldCancel = new Set<string>();
  const url = await listen(async (request, body, response) => {
    const sent = JSON.parse(body) as Exchange;
    state.seen.push(sent);
    state.headers.add(`${request.headers["lifestream-device"]} ${request.headers.authorization}`);
    if (state.refusal !== null) return void response.writeHead(state.refusal.status).end(JSON.stringify({ code: state.refusal.code }));
    state.answered.push(sent);
    const cancel = (): string[] => sent.runner.running.filter((id) => state.cancel.includes(id));
    if (state.calls.length === 0 && cancel().every((id) => toldCancel.has(id)) && JSON.stringify(state.files) === told) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 25);
        response.once("close", () => { clearTimeout(timer); resolve(); });
      });
    }
    if (response.destroyed) return;
    told = JSON.stringify(state.files);
    for (const id of cancel()) toldCancel.add(id);
    const handed: Handed = { calls: state.calls.splice(0), cancel: cancel(), files: state.files };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(handed));
  });
  return { url, state };
}

const PASS = "synthetic-runner-pass".padEnd(43, "x");

function runner(at: string, given: Omit<Record<Row["library"], Library>, "detector"> & { detector?: Library }, options: Pick<RunnerOptions, "rest_ms" | "drain_ms" | "name" | "power" | "idle" | "thermal"> = {}): { done: Promise<void>; stop: () => void } {
  const libraries = { detector: fake(), ...given };
  const dir = folder();
  writeFileSync(join(dir, "door-token"), `${PASS}\n`);
  const stop = new AbortController();
  const done = serve({
    door: at, pass: join(dir, "door-token"), rows: FILES, libraries, signal: stop.signal, log: () => undefined, retry_ms: 25,
    name: "synthetic-mac", power: async () => "mains", idle: async () => 600, thermal: async () => "nominal", ...options,
  });
  onTestFinished(async () => {
    stop.abort();
    await done;
  });
  return { done, stop: () => stop.abort() };
}

interface Fetching {
  resolve(): void;
  reject(error: Error): void;
  progress(fetched: number, bytes?: number): void;
}

function fake(answer: (call: Call, signal: AbortSignal) => Promise<Answer> = async (call) => ({ text: `seen: ${call.input}`, model: call.model })) {
  const asked = { fetched: [] as string[], removed: [] as string[], ran: [] as string[], stopped: [] as string[], closed: 0 };
  const fetches = new Map<string, Fetching>();
  let fetching: Fetching | null = null;
  const library: Library & { asked: typeof asked; fetching: () => Fetching | null; fetchOf: (id: string) => Fetching | undefined } = {
    asked,
    fetching: () => fetching,
    fetchOf: (id) => fetches.get(id),
    fetch: (row, progress, signal) => new Promise<void>((resolve, reject) => {
      asked.fetched.push(row.id);
      const ended = (): void => {
        if (fetching === made) fetching = null;
        if (fetches.get(row.id) === made) fetches.delete(row.id);
      };
      const made: Fetching = { resolve: () => { ended(); resolve(); }, reject: (error) => { ended(); reject(error); }, progress };
      fetching = made;
      fetches.set(row.id, made);
      signal.addEventListener("abort", () => made.reject(signal.reason as Error), { once: true });
    }),
    remove: async (row) => { asked.removed.push(row.id); },
    run: async (_row, call, signal) => {
      asked.ran.push(call.id);
      signal.addEventListener("abort", () => asked.stopped.push(call.id));
      return answer(call, signal);
    },
    close: async () => { asked.closed++; },
  };
  return library;
}

const call = (id: string, model = PICTURES): Call => ({ id, model, input: "Describe this photo.", attachments: [JPEG] });

async function ready(state: Awaited<ReturnType<typeof door>>["state"], library: ReturnType<typeof fake>, id: string): Promise<void> {
  await until(`${id} is fetched`, () => library.fetchOf(id) !== undefined);
  library.fetchOf(id)!.resolve();
  await until(`${id} is ready`, () => state.file(id)?.state === "ready");
}

describe("the runner", () => {
  it("states its power as pmset says it: mains or battery on a machine with a battery of its own, none on a desktop on mains or a UPS", () => {
    const laptop = (from: string) => `Now drawing from '${from}'\n -InternalBattery-0 (id=1234567)\t81%; charging; 0:42 remaining present: true\n`;
    expect([powerOf(laptop("AC Power")), powerOf(laptop("Battery Power"))]).toEqual(["mains", "battery"]);
    expect([powerOf("Now drawing from 'AC Power'\n"), powerOf("Now drawing from 'UPS Power'\n -UPS-1 (id=42)\t90%; discharging\n"), powerOf("")])
      .toEqual([null, null, null]);
  });

  it("states its idle seconds as ioreg says them and its thermal state as pmset says it: nominal with no warning, elevated with one, none when neither is said", () => {
    expect(idleOf('  |   "HIDIdleTime" = 3437246916\n')).toBe(3);
    expect(idleOf("")).toBeNull();
    expect(thermalOf("Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\nNote: No CPU power status has been recorded\n")).toBe("nominal");
    expect(thermalOf("Thermal warning level set to 0.\nPerformance warning level set to 0.\n")).toBe("nominal");
    expect(thermalOf("Note: No thermal warning level has been recorded\nPerformance warning level set to 2.\n")).toBe("elevated");
    expect(thermalOf("CPU_Scheduler_Limit \t= 100\nCPU_Available_CPUs \t= 8\nCPU_Speed_Limit \t= 70\n")).toBe("elevated");
    expect(thermalOf("CPU_Speed_Limit \t= 100\n")).toBe("nominal");
    expect(thermalOf("")).toBeNull();
  });

  it("states its machine's power, idle seconds and thermal state on each exchange, as its readers say them", async () => {
    const { url, state } = await door();
    let idle = 30;
    runner(url, { ollama: fake(), speech: fake() }, { power: async () => "mains", idle: async () => idle, thermal: async () => "nominal" });
    await until("the runner's first exchange", () => state.last() !== undefined);
    expect(state.last()!.runner).toMatchObject({ power: "mains", idle_s: 30, thermal: "nominal" });
    idle = 200;
    await until("an exchange states the new idle time", () => state.last()!.runner.idle_s === 200);
  });

  it("reads power and idle afresh right before an embedding of screen text, and on battery or in use ends it BUSY with the reason, never run; an ask's always runs", async () => {
    const { url, state } = await door();
    let power: "mains" | "battery" = "mains";
    let idle = 600;
    const ollama = fake(async (call) => ({ text: "embedded", model: call.model }));
    runner(url, { ollama, speech: fake() }, { power: async () => power, idle: async () => idle, thermal: async () => "nominal" });
    const EMBED = "embeddinggemma-2-q8-512";
    state.files = [EMBED];
    await ready(state, ollama, EMBED);
    const embedding = (id: string, role: "document" | "query"): Call => ({ id, model: EMBED, input: JSON.stringify({ role, texts: ["a screen's text"] }), attachments: [] });
    const resultOf = async (id: string) => {
      await until(`${id} is answered`, () => state.results().some((result) => result.id === id));
      return state.results().find((result) => result.id === id);
    };
    power = "battery";
    state.calls.push(embedding("r-0000000000e1", "document"));
    expect(await resultOf("r-0000000000e1")).toEqual({ id: "r-0000000000e1", error: { code: "BUSY", reason: "battery", model: EMBED } });
    power = "mains";
    idle = 30;
    state.calls.push(embedding("r-0000000000e2", "document"));
    expect(await resultOf("r-0000000000e2")).toEqual({ id: "r-0000000000e2", error: { code: "BUSY", reason: "in_use", model: EMBED } });
    idle = 600;
    state.calls.push(embedding("r-0000000000e3", "document"));
    expect(await resultOf("r-0000000000e3")).toMatchObject({ ok: { text: "embedded" } });
    power = "battery";
    idle = 0;
    state.calls.push(embedding("r-0000000000e4", "query"));
    expect(await resultOf("r-0000000000e4")).toMatchObject({ ok: { text: "embedded" } });
    expect(ollama.asked.ran).toEqual(["r-0000000000e3", "r-0000000000e4"]);
  });

  it("fetches only the files wanted, says how far each is in facts alone, its size the row's until its library says the fetch's own, removes one no longer wanted or whose fetch it stopped, and says why a fetch failed", async () => {
    const { url, state } = await door();
    const pictures = fake();
    const speech = fake();
    runner(url, { ollama: pictures, speech });
    await until("the runner's first exchange", () => state.last() !== undefined);
    expect([...state.headers]).toEqual([`runner/${RUNNER_WIRE_VERSION} Bearer ${PASS}`]);
    expect(state.last()!.runner).toMatchObject({ version: RUNNER_WIRE_VERSION, slots: 1, running: [] });
    expect(state.last()!.runner.files.map((each) => [each.id, each.state])).toEqual(FILES.map((row) => [row.id, "absent"]));
    expect(Object.keys(state.last()!.runner.files[0]!).sort()).toEqual(["bytes", "context_tokens", "failure", "fetched_bytes", "id", "input", "languages", "memory_gb", "name", "output", "state", "thinking", "tools"]);
    const languages = Object.fromEntries(state.last()!.runner.files.map((each) => [each.id, each.languages]));
    expect(languages).toEqual(Object.fromEntries(FILES.map((row) => [row.id, row.languages])));
    expect(languages[PICTURES]).toEqual([]);
    expect(languages[SPEECH]).toEqual(["en"]);
    expect(languages[LANGUAGES]).toEqual(expect.arrayContaining(["en", "hi"]));
    expect(languages[LANGUAGES]!.length).toBeGreaterThan(2);
    expect(pictures.asked.fetched).toEqual([]);
    state.files = [PICTURES, SPEECH];
    await until("both are fetched", () => pictures.fetching() !== null && speech.fetching() !== null);
    pictures.fetching()!.progress(1_234);
    await until("its progress is read", () => state.file(PICTURES)?.state === "fetching" && state.file(PICTURES)?.fetched_bytes === 1_234);
    expect(state.file(PICTURES)!.bytes).toBe(FILES.find((row) => row.id === PICTURES)!.bytes);
    pictures.fetching()!.progress(2_345, 9_876);
    await until("the fetch's own size is stated", () => state.file(PICTURES)?.fetched_bytes === 2_345 && state.file(PICTURES)?.bytes === 9_876);
    pictures.fetching()!.resolve();
    await until("the pictures model is ready", () => state.file(PICTURES)?.state === "ready");
    expect(state.file(PICTURES)).toMatchObject({ bytes: 9_876, fetched_bytes: 9_876, failure: null });
    speech.fetching()!.reject(new ArtifactError("hash", "the file's SHA-256 differs"));
    await until("the failed fetch says why", () => state.file(SPEECH)?.state === "failed");
    expect(state.file(SPEECH)!.failure).toBe("hash");
    state.files = [SPEECH];
    await until("the pictures model no longer wanted is removed", () => state.file(PICTURES)?.state === "absent" && pictures.asked.removed.length === 1);
    state.files = [];
    await until("the failed one is let go", () => state.file(SPEECH)?.state === "absent" && speech.asked.removed.length === 1);
    state.files = [SPEECH];
    await until("asked again, it is fetched again", () => speech.asked.fetched.length === 2 && speech.fetching() !== null);
    state.files = [];
    await until("the stopped fetch's row is removed, and stated absent", () => speech.asked.removed.length === 2 && state.file(SPEECH)?.state === "absent");
    expect([pictures.asked.fetched, speech.asked.fetched]).toEqual([[PICTURES], [SPEECH, SPEECH]]);
  });

  it("tries a fetch that failed again once its rest is over; one whose bytes were not the pin's, or whose build its check refused, never; and one any library threw failed", async () => {
    const { url, state } = await door();
    const speech = fake();
    const pictures = fake();
    state.files = [PICTURES, SPEECH, LANGUAGES];
    runner(url, { ollama: pictures, speech }, { rest_ms: 50 });
    await until("all three are fetched", () => pictures.fetchOf(PICTURES) !== undefined && speech.fetchOf(SPEECH) !== undefined && speech.fetchOf(LANGUAGES) !== undefined);
    speech.fetchOf(SPEECH)!.reject(new ArtifactError("hash", "the file's SHA-256 differs"));
    pictures.fetchOf(PICTURES)!.reject(new Refused("ollama 0.40.16 is refused: its signature is not its maker's"));
    speech.fetchOf(LANGUAGES)!.reject(new Error("something the library said"));
    await until("all three say why", () => state.file(LANGUAGES)?.failure === "failed" && state.file(SPEECH)?.failure === "hash" && state.file(PICTURES)?.failure === "untrusted");
    await until("the other is fetched again", () => speech.asked.fetched.filter((id) => id === LANGUAGES).length === 2);
    speech.fetchOf(LANGUAGES)!.reject(new ArtifactError("offline", "no route to the host"));
    await until("offline, it is fetched again too", () => speech.asked.fetched.filter((id) => id === LANGUAGES).length === 3);
    expect([speech.asked.fetched.filter((id) => id === SPEECH), pictures.asked.fetched]).toEqual([[SPEECH], [PICTURES]]);
    expect([state.file(SPEECH), state.file(PICTURES)]).toMatchObject([{ state: "failed", failure: "hash" }, { state: "failed", failure: "untrusted" }]);
  });

  it("runs a call on a ready file and sends its result until an exchange carrying it is answered; answers NOT_READY for a file not ready", async () => {
    const { url, state } = await door();
    let release = (): void => undefined;
    const pictures = fake((call) => new Promise((resolve) => { release = () => resolve({ text: `seen: ${call.input}`, model: call.model }); }));
    runner(url, { ollama: pictures, speech: fake() });
    state.files = [PICTURES];
    await ready(state, pictures, PICTURES);
    state.calls.push(call("r-000000000001"), call("r-000000000002", SPEECH));
    await until("the call runs", () => state.running("r-000000000001"));
    state.refusal = { status: 503, code: "NOT_NOW" };
    release();
    await until("an exchange carrying the result is refused", () => state.seen.some((sent) => sent.results.some((result) => result.id === "r-000000000001")));
    state.refusal = null;
    const answered = (): Result[] => state.answered.flatMap((sent) => sent.results);
    await until("both results are taken", () => answered().some((result) => result.id === "r-000000000001") && answered().some((result) => result.id === "r-000000000002"));
    expect(answered().find((result) => result.id === "r-000000000001")).toEqual({ id: "r-000000000001", ok: { text: "seen: Describe this photo.", model: PICTURES } });
    expect(answered().find((result) => result.id === "r-000000000002")).toEqual({ id: "r-000000000002", error: { code: "NOT_READY", model: SPEECH } });
    expect(pictures.asked.ran).toEqual(["r-000000000001"]);
    await until("an exchange carries neither result", () => state.last()!.results.length === 0);
  });

  it("runs a warm call on a speech row alone, and answers one on any other row FAILED, never handing it to that row's library", async () => {
    const { url, state } = await door();
    const speech = fake(async (call) => ({ text: call.warm === true ? "" : "a note", model: call.model }));
    const pictures = fake();
    runner(url, { ollama: pictures, speech });
    state.files = [PICTURES, SPEECH];
    await ready(state, pictures, PICTURES);
    await ready(state, speech, SPEECH);
    const warm = (id: string, model: string): Call => ({ id, model, input: "", attachments: [], warm: true });
    state.calls.push(warm("r-0000000000w1", SPEECH), warm("r-0000000000w2", PICTURES));
    await until("both warm calls answered", () => ["r-0000000000w1", "r-0000000000w2"].every((id) => state.results().some((result) => result.id === id)));
    expect(state.results().find((result) => result.id === "r-0000000000w1")).toEqual({ id: "r-0000000000w1", ok: { text: "", model: SPEECH } });
    expect(state.results().find((result) => result.id === "r-0000000000w2")).toEqual({ id: "r-0000000000w2", error: { code: "FAILED", reason: "failed", model: PICTURES } });
    expect(speech.asked.ran).toEqual(["r-0000000000w1"]);
    expect(pictures.asked.ran).toEqual([]);
  });

  it("stops a call the door cancels, says it runs it until its work has ended, and never sends its result", async () => {
    const { url, state } = await door();
    let settle = (): void => undefined;
    const pictures = fake((_call, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => { settle = () => reject(signal.reason); })));
    runner(url, { ollama: pictures, speech: fake() });
    state.files = [PICTURES];
    await ready(state, pictures, PICTURES);
    state.calls.push(call("r-00000000000a"));
    await until("the runner says it runs the call", () => state.running("r-00000000000a"));
    state.cancel.push("r-00000000000a");
    await until("the cancelled call is stopped", () => pictures.asked.stopped.includes("r-00000000000a"));
    const seen = state.seen.length;
    await until("two exchanges more", () => state.seen.length >= seen + 2);
    expect(state.running("r-00000000000a")).toBe(true);
    settle();
    await until("its work ended, it is no longer running", () => !state.running("r-00000000000a"));
    expect(state.results().map((result) => result.id)).not.toContain("r-00000000000a");
  });

  it("stops for good when a later start of it serves its pass: starts no work after, and returns once every call, fetch and removal has settled and each library is closed", async () => {
    const { url, state } = await door();
    const settle = new Map<string, () => void>();
    const pictures = fake((call, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => settle.set(call.id, () => reject(signal.reason)))));
    const speech = fake();
    const fetching = new Map<string, () => void>();
    speech.fetch = (row, _progress, signal) => new Promise((resolve, reject) => {
      speech.asked.fetched.push(row.id);
      fetching.set(row.id, resolve);
      signal.addEventListener("abort", () => settle.set(`fetch ${row.id}`, () => reject(signal.reason)), { once: true });
    });
    speech.remove = (row, signal) => new Promise((_, reject) => {
      speech.asked.removed.push(row.id);
      signal.addEventListener("abort", () => settle.set(`remove ${row.id}`, () => reject(signal.reason)), { once: true });
    });
    const { done } = runner(url, { ollama: pictures, speech });
    state.files = [PICTURES, SPEECH];
    await until("both are fetched", () => pictures.fetchOf(PICTURES) !== undefined && fetching.has(SPEECH));
    pictures.fetchOf(PICTURES)!.resolve();
    fetching.get(SPEECH)!();
    await until("both are ready", () => state.file(PICTURES)?.state === "ready" && state.file(SPEECH)?.state === "ready");
    state.files = [PICTURES, LANGUAGES];
    state.calls.push(call("r-0000000000a1"), call("r-0000000000a2"));
    await until("the removal and the fetch are held, and both calls run", () => speech.asked.removed.includes(SPEECH) && fetching.has(LANGUAGES)
      && ["r-0000000000a1", "r-0000000000a2"].every((id) => state.running(id)));
    expect(state.file(SPEECH)?.state).toBe("absent");
    state.cancel.push("r-0000000000a1");
    await until("the cancelled call is stopped", () => settle.has("r-0000000000a1"));
    let returned = false;
    void done.then(() => { returned = true; });
    state.refusal = { status: 409, code: "SUPERSEDED" };
    await until("the stop stops the other call, the fetch and the removal", () => ["r-0000000000a2", `fetch ${LANGUAGES}`, `remove ${SPEECH}`].every((each) => settle.has(each)));
    expect([pictures.asked.closed, speech.asked.closed]).toEqual([1, 1]);
    const turn = (): Promise<unknown> => new Promise((resolve) => setImmediate(resolve));
    for (const each of ["r-0000000000a2", "r-0000000000a1", `fetch ${LANGUAGES}`]) {
      settle.get(each)!();
      await turn();
      expect([each, returned]).toEqual([each, false]);
    }
    settle.get(`remove ${SPEECH}`)!();
    await done;
    expect(speech.asked.fetched).toEqual([SPEECH, LANGUAGES]);
    expect(speech.asked.removed).toEqual([SPEECH]);
    expect(state.seen.length - state.answered.length).toBe(1);
  });

  it("returns its drain's bound after its stop when a call ignores its signal, its libraries closed", async () => {
    const { url, state } = await door();
    const pictures = fake(() => new Promise(() => undefined));
    const drainMs = 60;
    const { done, stop } = runner(url, { ollama: pictures, speech: fake() }, { drain_ms: drainMs });
    state.files = [PICTURES];
    await ready(state, pictures, PICTURES);
    state.calls.push(call("r-0000000000b1"));
    await until("the call runs", () => state.running("r-0000000000b1"));
    let returned = false;
    void done.then(() => { returned = true; });
    stop();
    await until(`the runner returns, ${drainMs} ms after its stop`, () => returned);
    expect(pictures.asked.closed).toBe(1);
  });
});

describe("the runner's detector", () => {
  it("states its detector's key with its file, and answers a find on the detector's slot while a caption runs on the model's", async () => {
    const { url, state } = await door();
    let release = (): void => undefined;
    const pictures = fake((call) => new Promise((resolve) => { release = () => resolve({ text: `seen: ${call.input}`, model: call.model }); }));
    const detector = fake(async (call) => ({ text: `found in ${call.input}`, model: call.model }));
    runner(url, { ollama: pictures, speech: fake(), detector });
    state.files = [PICTURES, DETECTOR];
    await ready(state, pictures, PICTURES);
    await ready(state, detector, DETECTOR);
    const row = FILES.find((each) => each.id === DETECTOR)!;
    expect(state.file(DETECTOR)).toMatchObject({ input: ["text"], output: "marks", context_tokens: 8_000, bytes: row.bytes, detector: row.library === "detector" ? row.key : null });
    expect(state.file(PICTURES)!.detector).toBeUndefined();
    state.calls.push(call("r-0000000000c1"));
    await until("the caption runs", () => state.running("r-0000000000c1"));
    state.calls.push({ id: "r-0000000000f1", model: DETECTOR, input: JSON.stringify(["Write to Ada Example."]), attachments: [] });
    await until("the find is answered", () => state.results().some((result) => result.id === "r-0000000000f1"));
    expect(state.running("r-0000000000c1")).toBe(true);
    release();
    await until("the caption is answered", () => state.results().some((result) => result.id === "r-0000000000c1"));
  });
});

describe("the runner stopped before its start", () => {
  it("never exchanges: an abort that came first is honoured, never lost", async () => {
    const { url, state } = await door();
    const dir = folder();
    writeFileSync(join(dir, "door-token"), `${PASS}\n`);
    const stop = new AbortController();
    stop.abort();
    let returned = false;
    void serve({ door: url, pass: join(dir, "door-token"), rows: FILES, libraries: { ollama: fake(), speech: fake(), detector: fake() }, signal: stop.signal, log: () => undefined, retry_ms: 50 })
      .then(() => { returned = true; });
    await until("the runner returns", () => returned);
    expect(state.seen).toHaveLength(0);
  });
});

describe("the runner's files", () => {
  it("tries a removal that failed again only after its rest, while the loop goes on; a call whose file is not as pinned makes its row fetched again", async () => {
    const { url, state } = await door();
    const pictures = fake(async (call) => { throw new NotReady(`${call.model} is not on this runner as it is pinned`); });
    let removals = 0;
    pictures.remove = async () => {
      removals++;
      throw new Error("Operation not permitted");
    };
    runner(url, { ollama: pictures, speech: fake() });
    state.files = [PICTURES];
    await ready(state, pictures, PICTURES);
    state.calls.push(call("r-000000000001"));
    await until("the call is answered", () => state.results().some((result) => result.id === "r-000000000001"));
    expect(state.results().find((result) => result.id === "r-000000000001")).toMatchObject({ error: { code: "NOT_READY" } });
    await until("the file is fetched again", () => pictures.asked.fetched.length === 2 && pictures.fetching() !== null);
    pictures.fetching()!.resolve();
    await until("it is ready again", () => state.file(PICTURES)?.state === "ready");
    state.files = [];
    await until("the removal is tried", () => removals === 1);
    const seen = state.seen.length;
    await until("three exchanges more", () => state.seen.length >= seen + 3);
    expect(removals).toBe(1);
    expect(state.file(PICTURES)?.state).toBe("absent");
  });

  it("tries a removal that failed again once its rest is over, until one succeeds", async () => {
    const { url, state } = await door();
    const pictures = fake();
    let removals = 0;
    pictures.remove = async () => {
      if (++removals === 1) throw new Error("Operation not permitted");
    };
    runner(url, { ollama: pictures, speech: fake() }, { rest_ms: 50 });
    state.files = [PICTURES];
    await ready(state, pictures, PICTURES);
    state.files = [];
    await until("the removal is tried again, and succeeds", () => removals === 2);
    const seen = state.seen.length;
    await until("three exchanges more", () => state.seen.length >= seen + 3);
    expect(removals).toBe(2);
  });
});

async function ollama(models: string) {
  const state = { chats: [] as Record<string, unknown>[], cut: false, embeds: [] as Record<string, unknown>[], vectors: undefined as number[][] | undefined };
  const manifests = join(models, "manifests", "registry.ollama.ai", "library");
  const url = await listen((request, body, response) => {
    const path = new URL(request.url!, "http://ollama").pathname;
    if (path === "/api/tags") {
      const listed = (existsSync(manifests) ? readdirSync(manifests, { recursive: true, withFileTypes: true }) : []).filter((entry) => entry.isFile()).map((entry) => {
        const file = join(entry.parentPath, entry.name);
        return { name: relative(manifests, file).replace("/", ":"), digest: sha(readFileSync(file)) };
      });
      return void response.end(JSON.stringify({ models: listed }));
    }
    if (path === "/api/chat") {
      state.chats.push(JSON.parse(body) as Record<string, unknown>);
      return void response.end(JSON.stringify({ message: { content: "A synthetic photo." }, done_reason: state.cut ? "length" : "stop", prompt_eval_count: 2_100, eval_count: 12 }));
    }
    if (path === "/api/embed") {
      const asked = JSON.parse(body) as { input: string[] };
      state.embeds.push(asked);
      const vectors = state.vectors ?? asked.input.map((_, at) => Array.from({ length: 768 }, (_, dimension) => (dimension === 0 ? 3 * (at + 1) : dimension === 1 ? 4 * (at + 1) : dimension === 600 ? 1_000 : 0)));
      return void response.end(JSON.stringify({ model: "embedding:1b", embeddings: vectors, prompt_eval_count: 40 }));
    }
    response.writeHead(404).end();
  });
  return { url, state };
}

function child(dir: string, at: () => Promise<string>) {
  const asked = { builds: 0, removed: 0, heals: 0 };
  const made: OllamaChild & { asked: typeof asked } = {
    asked, models: join(dir, "models"), url: at,
    build: async (_signal, progress) => {
      asked.builds++;
      progress?.(OLLAMA.artifact.bytes / 2);
      return OLLAMA.artifact.bytes;
    },
    remove: async () => { asked.removed++; },
    heal: async () => { asked.heals++; },
    close: async () => undefined,
  };
  return made;
}

const MANIFEST_TYPE = "application/vnd.docker.distribution.manifest.v2+json";

async function registry() {
  const served = new Map<string, Buffer>();
  const asked: string[] = [];
  const accepts: string[] = [];
  const gates = new Map<string, Promise<void>>();
  const cut = new Set<string>();
  const url = await listen(async (request, _body, response) => {
    asked.push(request.url!);
    if (request.url!.includes("/manifests/")) accepts.push(String(request.headers.accept));
    await gates.get(request.url!);
    const bytes = served.get(request.url!);
    if (bytes === undefined) return void response.writeHead(404).end();
    response.writeHead(200, { "content-length": bytes.length });
    if (!cut.has(request.url!)) return void response.end(bytes);
    response.write(bytes.subarray(0, 1), () => response.destroy());
  });
  const blob = (text: string, type: string) => ({ mediaType: type, digest: `sha256:${sha(text)}`, size: Buffer.byteLength(text) });
  const blobUrl = (name: string, text: string): string => `/v2/library/${name}/blobs/sha256:${sha(text)}`;
  const publish = (name: string, layers: readonly string[], type = "application/vnd.ollama.image.model") => {
    const manifest: OllamaManifest = { schemaVersion: 2, config: blob(`config of ${name}: ${layers.join(", ")}`, "application/vnd.docker.container.image.v1+json"), layers: layers.map((text) => blob(text, type)) };
    const bytes = Buffer.from(JSON.stringify({ ...manifest, mediaType: MANIFEST_TYPE, runner: "llamacpp", format: "gguf" }));
    served.set(`/v2/library/${name}/manifests/1b`, bytes);
    for (const text of [`config of ${name}: ${layers.join(", ")}`, ...layers]) served.set(`/v2/library/${name}/blobs/sha256:${sha(text)}`, Buffer.from(text));
    const digests = [manifest.config, ...manifest.layers].map((layer) => layer.digest.replace(":", "-"));
    return { manifest, bytes, digests, size: [manifest.config, ...manifest.layers].reduce((sum, layer) => sum + layer.size, 0) };
  };
  const model = (name: string, layers: readonly string[], embed?: OllamaRow["embed"]) => {
    const published = publish(name, layers);
    const row = ollamaRow({
      id: `${name}-test`, name, input: embed === undefined ? ["text", "image"] : ["text"], output: embed === undefined ? "text" : "vectors", tools: false,
      context_tokens: embed === undefined ? 4_000 : 2_048, thinking: [], platforms: [], languages: [], memory_gb: 16,
      source: { model: `${name}:1b`, registry: `${url}/v2/library/${name}`, bytes: published.size, layers: ["application/vnd.docker.container.image.v1+json", "application/vnd.ollama.image.model"] },
      ...(embed === undefined ? {} : { embed }),
    });
    return { row, ...published };
  };
  return { url, served, asked, accepts, gates, cut, blobUrl, publish, model };
}

describe("the Ollama library", () => {
  const signal = new AbortController().signal;

  it("makes its build ready first, resolves its tag's manifest from the registry, fetches each layer as an artifact, its progress one rising sum from the build's first byte to the manifest's size, writes the manifest as served, runs it with the context its row needs, and asks the registry nothing for a model it holds", async () => {
    const dir = folder();
    const served = await registry();
    const { url, state } = await ollama(join(dir, "models"));
    const { row, bytes, digests, size } = served.model("synthetic", ["the first tensor's bytes", "the second tensor's bytes, longer"]);
    const playing = child(dir, async () => url);
    const library = ollamaLibrary(playing);
    const progress: number[] = [];
    const sizes = new Set<number>();
    await library.fetch(row, (fetched, total) => {
      progress.push(fetched);
      if (total !== undefined) sizes.add(total);
    }, signal);
    expect(playing.asked.builds).toBe(1);
    expect(progress.slice(0, 2)).toEqual([OLLAMA.artifact.bytes / 2, OLLAMA.artifact.bytes]);
    expect(progress.at(-1)).toBe(OLLAMA.artifact.bytes + size);
    expect([...sizes]).toEqual([OLLAMA.artifact.bytes + size]);
    expect(progress.every((each, at) => at === 0 || each >= progress[at - 1]!)).toBe(true);
    expect(served.asked[0]).toBe("/v2/library/synthetic/manifests/1b");
    expect(served.accepts).toEqual([MANIFEST_TYPE]);
    expect(readdirSync(join(dir, "models", "blobs")).sort()).toEqual([...digests].sort());
    expect(readFileSync(join(dir, "models", "manifests", "registry.ollama.ai", "library", "synthetic", "1b"))).toEqual(bytes);
    expect(await library.run(row, call("r-1", row.id), signal)).toEqual({ text: "A synthetic photo.", model: row.id, input_tokens: 2_100, output_tokens: 12 });
    expect(state.chats[0]).toMatchObject({
      model: "synthetic:1b", stream: false, think: false, keep_alive: "5m",
      messages: [{ role: "user", content: "Describe this photo.", images: [JPEG.base64] }],
      options: { temperature: 0, num_ctx: 8_192 },
    });
    const asked = served.asked.length;
    await library.fetch(row, () => undefined, signal);
    expect(served.asked.slice(asked)).toEqual([]);
    state.cut = true;
    await expect(library.run(row, call("r-2", row.id), signal)).rejects.toMatchObject({ name: "Failed", reason: "cut" });
  });

  it("keeps the build it holds when the tag is republished, and fetches the tag as the registry now serves it once a layer it held is gone, letting go of the layers only the old manifest named", async () => {
    const dir = folder();
    const served = await registry();
    const { url } = await ollama(join(dir, "models"));
    const first = served.model("synthetic", ["a tensor both builds share", "the first build's own tensor"]);
    const library = ollamaLibrary(child(dir, async () => url));
    await library.fetch(first.row, () => undefined, signal);
    const second = served.publish("synthetic", ["a tensor both builds share", "the second build's own tensor, longer than the first's"]);
    for (const digest of first.digests.filter((each) => !second.digests.includes(each))) served.served.delete(`/v2/library/synthetic/blobs/${digest.replace("-", ":")}`);
    const manifest = join(dir, "models", "manifests", "registry.ollama.ai", "library", "synthetic", "1b");
    const asked = served.asked.length;
    await library.fetch(first.row, () => undefined, signal);
    expect([served.asked.slice(asked), readFileSync(manifest)]).toEqual([[], first.bytes]);
    rmSync(join(dir, "models", "blobs", first.digests.at(-1)!));
    const sizes = new Set<number>();
    await library.fetch(first.row, (_fetched, total) => { if (total !== undefined) sizes.add(total); }, signal);
    expect([...sizes]).toEqual([OLLAMA.artifact.bytes + second.size]);
    expect(second.size).not.toBe(first.size);
    expect(readFileSync(manifest)).toEqual(second.bytes);
    expect(readdirSync(join(dir, "models", "blobs")).sort()).toEqual([...second.digests].sort());
    expect(await library.run(first.row, call("r-1", first.row.id), signal)).toMatchObject({ text: "A synthetic photo." });
  });

  it("is ready on a model it holds with the registry gone and no request made, and with none held fails as the registry did", async () => {
    const dir = folder();
    const served = await registry();
    const { url } = await ollama(join(dir, "models"));
    const { row, digests } = served.model("synthetic", ["the first tensor's bytes"]);
    const away = { ...row, source: { ...row.source, registry: "http://127.0.0.1:1/v2/library/synthetic" } };
    const library = ollamaLibrary(child(dir, async () => url));
    await expect(library.fetch(away, () => undefined, signal)).rejects.toMatchObject({ name: "ArtifactError", reason: "offline" });
    served.served.delete("/v2/library/synthetic/manifests/1b");
    await expect(library.fetch(row, () => undefined, signal)).rejects.toMatchObject({ name: "ArtifactError", reason: "refused", status: 404 });
    expect(existsSync(join(dir, "models", "manifests"))).toBe(false);
    served.publish("synthetic", ["the first tensor's bytes"]);
    await library.fetch(row, () => undefined, signal);
    served.served.clear();
    const asked = served.asked.length;
    const restarted = ollamaLibrary(child(dir, async () => url));
    await restarted.fetch(row, () => undefined, signal);
    await restarted.fetch(away, () => undefined, signal);
    expect(served.asked.slice(asked)).toEqual([]);
    expect(readdirSync(join(dir, "models", "blobs")).sort()).toEqual([...digests].sort());
    expect(await restarted.run(row, call("r-1", row.id), signal)).toMatchObject({ text: "A synthetic photo." });
    served.served.set("/v2/library/synthetic/manifests/1b", Buffer.from("not a manifest"));
    const other = ollamaLibrary(child(folder(), async () => url));
    await expect(other.fetch(row, () => undefined, signal)).rejects.toMatchObject({ name: "ArtifactError", reason: "refused" });
  });

  it("refuses a manifest with a layer type its row does not name before it fetches a blob, as a failure, keeping the build it holds", async () => {
    const dir = folder();
    const served = await registry();
    const { url } = await ollama(join(dir, "models"));
    const { row, digests } = served.model("synthetic", ["the first tensor's bytes"]);
    const library = ollamaLibrary(child(dir, async () => url));
    served.publish("synthetic", ["a tensor of a newer engine"], "application/vnd.ollama.image.tensor");
    const asked = served.asked.length;
    const failed = await library.fetch(row, () => undefined, signal).catch((error: unknown) => error);
    expect([failed instanceof Failed, (failed as Failed).reason, (failed as Error).message]).toEqual([true, "failed", expect.stringContaining("application/vnd.ollama.image.tensor")]);
    expect(served.asked.slice(asked)).toEqual(["/v2/library/synthetic/manifests/1b"]);
    expect(existsSync(join(dir, "models"))).toBe(false);
    served.publish("synthetic", ["the first tensor's bytes"]);
    await library.fetch(row, () => undefined, signal);
    served.publish("synthetic", ["a tensor of a newer engine"], "application/vnd.ollama.image.tensor");
    await library.fetch(row, () => undefined, signal);
    expect(readdirSync(join(dir, "models", "blobs")).sort()).toEqual([...digests].sort());
    expect(await library.run(row, call("r-1", row.id), signal)).toMatchObject({ text: "A synthetic photo." });
  });

  it("names a fetch's layers on disk before its first blob, so a fetch that ended after one blob, or a blob no manifest names, is left behind neither its next fetch nor its removal, after a restart too, and a folder among the blobs stops neither", async () => {
    const layers = ["the first tensor's bytes", "the second tensor's bytes, cut short"];
    const held = (dir: string): string[] => (existsSync(join(dir, "models", "blobs")) ? readdirSync(join(dir, "models", "blobs")).sort() : []);
    const partials = (dir: string): string[] => readdirSync(join(dir, "models")).filter((name) => name.endsWith(".manifest.partial"));
    for (const next of ["fetch", "remove"] as const) {
      const dir = folder();
      const served = await registry();
      const { url } = await ollama(join(dir, "models"));
      const { row, digests } = served.model("synthetic", layers);
      served.cut.add(served.blobUrl("synthetic", layers[1]!));
      await expect(ollamaLibrary(child(dir, async () => url)).fetch(row, () => undefined, signal)).rejects.toMatchObject({ name: "ArtifactError", reason: "offline" });
      expect(held(dir)).toEqual([...digests.slice(0, 2), `${digests[2]}.partial`].sort());
      expect(partials(dir)).toEqual([`${row.id}.manifest.partial`]);
      const stray = `sha256-${sha("a layer of a build no manifest names")}`;
      writeFileSync(join(dir, "models", "blobs", stray), "a layer of a build no manifest names");
      writeFileSync(join(dir, "models", "blobs", `${stray}.partial`), "a layer");
      const folderNamedLikeABlob = `sha256-${sha("a folder, not a blob")}`;
      mkdirSync(join(dir, "models", "blobs", folderNamedLikeABlob));
      const restarted = ollamaLibrary(child(dir, async () => url));
      if (next === "remove") {
        await restarted.remove(row, signal);
        expect([held(dir), partials(dir)]).toEqual([[folderNamedLikeABlob], []]);
        continue;
      }
      const republished = served.publish("synthetic", ["a republished tensor"]);
      await restarted.fetch(row, () => undefined, signal);
      expect([held(dir), partials(dir)]).toEqual([[...republished.digests, folderNamedLikeABlob].sort(), []]);
    }
  });

  it("keeps a layer a fetch in flight names when another model is removed meanwhile, and a removal started with a fetch leaves that fetch whole", async () => {
    const dir = folder();
    const served = await registry();
    const { url } = await ollama(join(dir, "models"));
    const shared = "a tensor two models share";
    const own = "the first model's own tensor";
    const one = served.model("one", [shared, own]);
    const two = served.model("two", [shared]);
    const library = ollamaLibrary(child(dir, async () => url));
    const held = (): string[] => readdirSync(join(dir, "models", "blobs")).filter((name) => !name.endsWith(".lock")).sort();
    await library.fetch(two.row, () => undefined, signal);
    let open = (): void => undefined;
    served.gates.set(served.blobUrl("one", own), new Promise((resolve) => { open = resolve; }));
    const fetching = library.fetch(one.row, () => undefined, signal);
    await until("the fetch asks for its gated blob", () => served.asked.includes(served.blobUrl("one", own)));
    await library.remove(two.row, signal);
    open();
    await fetching;
    expect(held()).toEqual([...one.digests].sort());
    expect(await library.run(one.row, call("r-1", one.row.id), signal)).toMatchObject({ text: "A synthetic photo." });
    await library.fetch(two.row, () => undefined, signal);
    await Promise.all([library.remove(two.row, signal), library.fetch(one.row, () => undefined, signal)]);
    await library.remove(one.row, signal);
    await Promise.all([library.remove(two.row, signal), library.fetch(one.row, () => undefined, signal)]);
    expect(held()).toEqual([...one.digests].sort());
    expect(await library.run(one.row, call("r-2", one.row.id), signal)).toMatchObject({ text: "A synthetic photo." });
  });

  it("writes no manifest while a layer's bytes are not its digest's, never runs a model listed under another digest, and leaves a child that does not start the call's failure, its row not ready only when its build is not", async () => {
    const dir = folder();
    const served = await registry();
    const { url, state } = await ollama(join(dir, "models"));
    const { row, manifest } = served.model("synthetic", ["the first tensor's bytes"]);
    const layer = `/v2/library/synthetic/blobs/${manifest.layers[0]!.digest}`;
    const good = served.served.get(layer)!;
    served.served.set(layer, Buffer.from("x".repeat(good.length)));
    const library = ollamaLibrary(child(dir, async () => url));
    await expect(library.fetch(row, () => undefined, signal)).rejects.toMatchObject({ name: "ArtifactError", reason: "hash" });
    expect(existsSync(join(dir, "models", "manifests"))).toBe(false);
    served.served.set(layer, good);
    await library.fetch(row, () => undefined, signal);
    writeFileSync(join(dir, "models", "manifests", "registry.ollama.ai", "library", "synthetic", "1b"), "{}");
    await expect(library.run(row, call("r-1", row.id), signal)).rejects.toBeInstanceOf(NotReady);
    expect(state.chats).toEqual([]);
    const stuck = ollamaLibrary(child(dir, async () => { throw new Error("Another Ollama holds the folder"); }));
    const failed = await stuck.run(row, call("r-2", row.id), signal).catch((error: unknown) => error);
    expect([failed instanceof NotReady, (failed as Error).message]).toEqual([false, "Another Ollama holds the folder"]);
    const unbuilt = ollamaLibrary(child(dir, async () => { throw new NotReady("Ollama 0.40.16 is not ready on this runner"); }));
    await expect(unbuilt.run(row, call("r-3", row.id), signal)).rejects.toBeInstanceOf(NotReady);
  });

  it("embeds on a row that embeds: each text after its role's prompt, cut by Ollama at the row's tokens, each vector cut to the row's dimensions and unit length; refuses any other call, and runs none on a model not fetched", async () => {
    const dir = folder();
    const served = await registry();
    const { url, state } = await ollama(join(dir, "models"));
    const embeds = { dimensions: 512, prompts: { query: "query: ", document: "text: " } };
    const { row } = served.model("embedding", ["an embedding model's tensor"], embeds);
    const library = ollamaLibrary(child(dir, async () => url));
    const embedding = (id: string, role: string, texts: string[]): Call => ({ id, model: row.id, input: JSON.stringify({ role, texts }), attachments: [] });
    await expect(library.run(row, embedding("e-0", "document", ["a screen's text"]), signal)).rejects.toBeInstanceOf(NotReady);
    expect(state.embeds).toEqual([]);
    await library.fetch(row, () => undefined, signal);
    const answer = await library.run(row, embedding("e-1", "document", ["a screen's text", "another"]), signal);
    expect([answer.model, answer.input_tokens, answer.output_tokens]).toEqual([row.id, 40, undefined]);
    expect(state.embeds[0]).toEqual({ model: "embedding:1b", keep_alive: "5m", truncate: true, input: ["text: a screen's text", "text: another"], options: { num_ctx: 2_048 } });
    const vectors = embedAnswerOf(answer.text, 2)!;
    expect(vectors.map((vector) => [vector.length, vector[0], vector[1], vector.slice(2).every((value) => value === 0)])).toEqual([
      [512, Math.fround(0.6), Math.fround(0.8), true], [512, Math.fround(0.6), Math.fround(0.8), true],
    ]);
    await library.run(row, embedding("e-2", "query", ["power bill"]), signal);
    expect(state.embeds[1]).toMatchObject({ input: ["query: power bill"] });
    for (const refused of [call("e-3", row.id), { ...embedding("e-4", "query", ["a"]), attachments: [JPEG] }]) {
      await expect(library.run(row, refused, signal)).rejects.toMatchObject({ name: "Failed", reason: "failed" });
    }
    state.vectors = [];
    await expect(library.run(row, embedding("e-5", "query", ["a"]), signal)).rejects.toMatchObject({ name: "Failed", reason: "failed" });
    expect([state.chats, state.embeds.length]).toEqual([[], 3]);
  });

  it("removes a model's manifest and every layer no other manifest names; with no model left, its child and its build go", async () => {
    const dir = folder();
    const served = await registry();
    const shared = "a tensor two models share";
    const one = served.model("one", [shared, "the first model's own tensor"]);
    const two = served.model("two", [shared]);
    const playing = child(dir, async () => "http://127.0.0.1:1");
    const library = ollamaLibrary(playing);
    await library.fetch(one.row, () => undefined, signal);
    await library.fetch(two.row, () => undefined, signal);
    const held = (): string[] => readdirSync(join(dir, "models", "blobs")).sort();
    const of = (text: string): string => `sha256-${sha(text)}`;
    await library.remove(one.row, signal);
    expect(held()).toEqual([of(`config of two: ${shared}`), of(shared)].sort());
    expect(playing.asked.removed).toBe(0);
    await library.remove(two.row, signal);
    expect(held()).toEqual([]);
    expect(playing.asked.removed).toBe(1);
  });
});

const ollamaProgram = (version: string): string => `#!${process.execPath}
const { appendFileSync, existsSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:http");
const { join } = require("node:path");
if (process.argv[2] === "--version") { console.log("ollama version is ${version}"); process.exit(0); }
appendFileSync(join(process.env.HOME, "started"), process.pid + "\\n");
if (existsSync(join(process.env.HOME, "crash"))) process.exit(1);
writeFileSync(join(process.env.HOME, "env.json"), JSON.stringify(process.env));
const [host, port] = process.env.OLLAMA_HOST.split(":");
const silent = existsSync(join(process.env.HOME, "silent"));
const server = createServer((request, response) => { if (!silent) response.end(JSON.stringify({ version: "${version}" })); }).listen(Number(port), host);
// Held: told to stop, it says so and exits only on the test's SIGUSR1.
process.on("SIGTERM", () => {
  if (!existsSync(join(process.env.HOME, "hold"))) process.exit(0);
  server.close();
  appendFileSync(join(process.env.HOME, "termed"), process.pid + "\\n");
  setInterval(() => {}, 1000);
});
process.on("SIGUSR1", () => process.exit(0));
`;

function starts(dir: string) {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const started = (): number[] => (existsSync(join(home, "started")) ? readFileSync(join(home, "started"), "utf8").trim().split("\n").map(Number) : []);
  return { home, started, env: () => JSON.parse(readFileSync(join(home, "env.json"), "utf8")) as Record<string, string> };
}

function fakeBuild(dir: string) {
  mkdirSync(join(dir, "build", OLLAMA.version), { recursive: true });
  writeFileSync(join(dir, "build", OLLAMA.version, OLLAMA.entry), ollamaProgram(OLLAMA.version));
  chmodSync(join(dir, "build", OLLAMA.version, OLLAMA.entry), 0o755);
  writeFileSync(join(dir, "build", "current"), `${OLLAMA.version}/${OLLAMA.entry}\n`);
  return starts(dir);
}

const signs = async (folder: string): Promise<string[]> => readdirSync(folder, { recursive: true, withFileTypes: true }).filter((each) => each.isFile()).map((each) => join(each.parentPath, each.name));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function opened(dir: string, options?: OllamaOptions): OllamaChild {
  const made = openOllama(dir, options);
  onTestFinished(() => made.close());
  return made;
}

describe("the runner's Ollama child", () => {
  it("starts one child per folder on a port and folders of its own; a second start on the folder waits for the first child's end; every close waits for its child to exit", async () => {
    const dir = folder();
    const { home, started, env } = fakeBuild(dir);
    const server = opened(dir);
    const url = await server.url();
    expect(await (await fetch(new URL("/api/version", url))).json()).toEqual({ version: OLLAMA.version });
    const given = env();
    expect(Object.keys(given).filter((key) => !key.startsWith("__")).sort())
      .toEqual(["HOME", "OLLAMA_HOST", "OLLAMA_MAX_LOADED_MODELS", "OLLAMA_MODELS", "OLLAMA_NOPRUNE", "OLLAMA_NUM_PARALLEL", "PATH", "TMPDIR"]);
    expect(given).toMatchObject({
      HOME: join(dir, "home"), OLLAMA_MODELS: join(dir, "models"), TMPDIR: join(dir, "tmp"), OLLAMA_HOST: `127.0.0.1:${new URL(url).port}`,
      OLLAMA_NUM_PARALLEL: "1", OLLAMA_MAX_LOADED_MODELS: "1", OLLAMA_NOPRUNE: "1",
    });
    expect(new URL(url).port).not.toBe("11434");
    expect(await server.url()).toBe(url);
    expect(started()).toHaveLength(1);
    const other = opened(dir);
    let otherUrl: string | null = null;
    const otherStart = other.url().then((at) => { otherUrl = at; });
    const [first] = started();
    writeFileSync(join(home, "hold"), "");
    const closed: string[] = [];
    const closes = [server.close().then(() => { closed.push("first"); }), server.close().then(() => { closed.push("second"); })];
    await until("the child is told to stop", () => existsSync(join(home, "termed")));
    await new Promise((resolve) => setImmediate(resolve));
    expect([closed, otherUrl, started()]).toEqual([[], null, [first]]);
    rmSync(join(home, "hold"));
    process.kill(first!, "SIGUSR1");
    await Promise.all(closes);
    expect(alive(first!)).toBe(false);
    await otherStart;
    expect(started()).toHaveLength(2);
    await other.close();

    rmSync(join(dir, "build", "current"));
    await expect(opened(dir).url()).rejects.toBeInstanceOf(NotReady);
    expect(started()).toHaveLength(2);
  });

  it("ends a start past its bound, a start whose one waiter is stopped, the child with it, and a start whose folder stays held", async () => {
    const dir = folder();
    const { home, started } = fakeBuild(dir);
    writeFileSync(join(home, "silent"), "");
    const bound = new AbortController();
    const timed = opened(dir, { bound: () => bound.signal, signed: signs });
    const timing = timed.url();
    await until("the child is started", () => started().length === 1);
    bound.abort(new Error("the start's bound passed"));
    await expect(timing).rejects.toThrow(/did not answer before its start's bound/u);
    expect(alive(started()[0]!)).toBe(false);
    await timed.close();

    const waited = opened(dir);
    const stop = new AbortController();
    const asked = waited.url(stop.signal);
    await until("the child is started", () => started().length === 2);
    stop.abort(new Error("the call was cancelled"));
    await expect(asked).rejects.toThrow("the call was cancelled");
    await until("the child is ended", () => !alive(started()[1]!));

    rmSync(join(home, "silent"));
    const holder = opened(dir);
    await holder.url();
    const held = new AbortController();
    const refused = opened(dir, { bound: () => held.signal }).url();
    const before = started().length;
    held.abort(new Error("the start's bound passed"));
    await expect(refused).rejects.toThrow(/Another Ollama holds/u);
    expect(started()).toHaveLength(before);
  });

  it("checks a build that does not start again: one its check still takes stays, and the start fails as it did; one it refuses is removed, and the start is not ready", async () => {
    const dir = folder();
    const { home, started } = fakeBuild(dir);
    writeFileSync(join(home, "crash"), "");
    const checked: string[] = [];
    const taking = opened(dir, { signed: async (at, team) => { checked.push(team); return signs(at); } });
    await expect(taking.url()).rejects.toThrow(/Ollama stopped as it started/u);
    expect([checked, readdirSync(join(dir, "build")).sort()]).toEqual([[OLLAMA.team], [OLLAMA.version, "current"]]);
    await taking.close();
    const refusing = opened(dir, { signed: async () => { throw new Refused("ollama's signature is not its maker's"); } });
    await expect(refusing.url()).rejects.toBeInstanceOf(NotReady);
    expect([readdirSync(join(dir, "build")), started()]).toEqual([[], [expect.any(Number), expect.any(Number)]]);
  });

  it("makes its build from its pinned artifact, unpacked, signed, run once and checked, once for two starts at once; refuses one that is not its version; and its removal ends the child and takes the build", async () => {
    const dir = folder();
    const stage = folder();
    const tgz = (version: string): Buffer => {
      writeFileSync(join(stage, "ollama"), ollamaProgram(version));
      chmodSync(join(stage, "ollama"), 0o755);
      const made = spawnSync("/usr/bin/tar", ["-czf", join(stage, `${version}.tgz`), "-C", stage, "ollama"]);
      expect(made.status).toBe(0);
      return readFileSync(join(stage, `${version}.tgz`));
    };
    const good = tgz(OLLAMA.version);
    const other = tgz("0.0.1");
    const served = await files(new Map([["/good.tgz", good], ["/other.tgz", other]]));
    const pin = (path: string, bytes: Buffer): Build => ({ ...OLLAMA, team: "SYNTHETIC1", artifact: { url: `${served.url}${path}`, bytes: bytes.length, sha256: sha(bytes) } });
    const built = (): string[] => (existsSync(join(dir, "build")) ? readdirSync(join(dir, "build")).sort() : []);

    await expect(opened(dir, { build: pin("/other.tgz", other), signed: signs }).build(new AbortController().signal)).rejects.toThrow(/is not ollama 0\.40\.16/u);
    expect(built()).toEqual([]);

    const { started } = starts(dir);
    const made = opened(dir, { build: pin("/good.tgz", good), signed: signs });
    await Promise.all([made.build(new AbortController().signal), opened(dir, { build: pin("/good.tgz", good), signed: signs }).build(new AbortController().signal)]);
    expect(built()).toEqual([OLLAMA.version, "current"]);
    expect(served.asked.filter((path) => path === "/good.tgz")).toEqual(["/good.tgz"]);
    await made.build(new AbortController().signal);
    expect(served.asked.filter((path) => path === "/good.tgz")).toEqual(["/good.tgz"]);
    await made.url();
    expect(started()).toHaveLength(1);
    await made.remove();
    expect(alive(started()[0]!)).toBe(false);
    expect(existsSync(join(dir, "build"))).toBe(false);
  });
});

function standIn(dir: string): string {
  const program = join(dir, "stand-in.cjs");
  writeFileSync(program, `
const socket = require("node:net").connect(Number(process.argv[2]), "127.0.0.1");
process.on("SIGTERM", () => { if (process.argv[3] === "ignore") socket.write("term"); else process.exit(0); });
`);
  return program;
}

async function children() {
  const made: { said: string; closed: boolean }[] = [];
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    const each = { said: "", closed: false };
    made.push(each);
    sockets.add(socket);
    socket.on("data", (chunk: Buffer) => { each.said += chunk.toString("utf8"); });
    socket.on("close", () => {
      each.closed = true;
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  }));
  return { made, port: (server.address() as AddressInfo).port };
}

function leashed(args: readonly string[]) {
  const [node, ...rest] = leashCommand();
  const leash = spawn(node!, [...rest, ...args], { stdio: ["pipe", "ignore", "pipe"] });
  leash.stdin!.on("error", () => undefined);
  let said = "";
  leash.stderr!.on("data", (chunk: Buffer) => { said += chunk.toString("utf8"); });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => leash.once("exit", (code, signal) => resolve({ code, signal })));
  onTestFinished(async () => {
    leash.stdin!.end();
    await exited;
  });
  return { leash, exited, said: () => said };
}

describe("the leash", () => {
  it("ends its child when its stdin ends, and refuses a second child on its lock, saying so and starting nothing", async () => {
    const dir = folder();
    const program = standIn(dir);
    const { made, port } = await children();
    const lock = join(dir, "child.lock");
    const first = leashed([lock, process.execPath, program, String(port)]);
    await until("the child runs", () => made.length === 1);
    const second = leashed([lock, process.execPath, program, String(port)]);
    expect(await second.exited).toEqual({ code: HELD, signal: null });
    expect(second.said()).toBe(`${HELD_SAID}\n`);
    first.leash.stdin!.end();
    await until("the child has ended", () => made[0]!.closed);
    expect(await first.exited).toEqual({ code: 0, signal: null });
    expect(made).toHaveLength(1);
  });

  it("ends its child when its parent is killed", async () => {
    const dir = folder();
    const program = standIn(dir);
    const { made, port } = await children();
    const [node, ...rest] = leashCommand();
    const parent = spawn(process.execPath, ["-e", `require("node:child_process").spawn(${JSON.stringify(node)}, ${JSON.stringify([...rest, join(dir, "child.lock"), process.execPath, program, String(port)])}, { stdio: ["pipe", "ignore", "ignore"] }); setInterval(() => {}, 1000);`], { stdio: "ignore" });
    const gone = new Promise((resolve) => parent.once("exit", resolve));
    onTestFinished(async () => {
      parent.kill("SIGKILL");
      await gone;
    });
    await until("the child runs", () => made.length === 1);
    parent.kill("SIGKILL");
    await until("the child has ended", () => made[0]!.closed);
  });

  it("kills a child that outlives SIGTERM once its exit time has passed", async () => {
    const dir = folder();
    const program = standIn(dir);
    const { made, port } = await children();
    const leash = leashed(["--exit-ms", "120", join(dir, "child.lock"), process.execPath, program, String(port), "ignore"]);
    await until("the child runs", () => made.length === 1);
    leash.leash.stdin!.end();
    await until("the child has ended", () => made[0]!.closed);
    expect(made[0]!.said).toBe("term");
    expect(await leash.exited).toEqual({ code: 128 + 9, signal: null });
  });
});

const TONE = { media_type: "audio/ogg", base64: readFileSync(new URL("./test/tone.ogg", import.meta.url)).toString("base64") };

function transcribers() {
  const state = {
    loaded: [] as string[], disposed: [] as string[], transcribing: [] as string[], faults: [] as string[], holding: new Set<string>(),
    swap: null as string | null,
    holdLoad: false,
    events: [] as string[],
  };
  const gates = new Map<string, () => void>();
  const release = (name: string): void => gates.get(name)?.();
  const load = async (path: string): Promise<Transcriber> => {
    if (state.swap !== null) {
      writeFileSync(`${path}.new`, state.swap);
      renameSync(`${path}.new`, path);
    }
    const name = readFileSync(path, "utf8");
    if (state.holdLoad) {
      state.events.push(`loading ${name}`);
      await new Promise<void>((resolve) => gates.set("load", resolve));
    }
    if (state.loaded.length > state.disposed.length) state.faults.push(`${name} loaded while another is`);
    state.loaded.push(name);
    return {
      async transcribe(samples) {
        state.transcribing.push(name);
        if (state.holding.has(name)) await new Promise<void>((resolve) => gates.set(name, resolve));
        state.transcribing.splice(state.transcribing.indexOf(name), 1);
        return { text: ` ${name} heard ${samples.length} samples ` };
      },
      dispose() {
        if (state.transcribing.includes(name)) state.faults.push(`${name} let go while in use`);
        state.disposed.push(name);
        state.events.push(`disposed ${name} ${existsSync(path) ? "with its file" : "without its file"}`);
      },
    };
  };
  return { state, load, release };
}

describe("the speech library", () => {
  const signal = new AbortController().signal;
  async function rows() {
    const bytes = { a: Buffer.from("model a"), b: Buffer.from("model b") };
    const served = await files(new Map([["/models/speech-a.gguf", bytes.a], ["/models/speech-b.gguf", bytes.b]]));
    const row = (id: string, of: Buffer) => speechRow({
      id, name: id, input: ["audio"], output: "text", tools: false, context_tokens: null, thinking: [], platforms: [], languages: ["en"], memory_gb: 8, source: { url: `${served.url}/models/${id}.gguf`, bytes: of.length, sha256: sha(of) },
    });
    return { a: row("speech-a", bytes.a), b: row("speech-b", bytes.b) };
  }

  it("transcribes a note on a model loaded from the file it checked, and never loads one changed after its check", async () => {
    const dir = folder();
    const { a, b } = await rows();
    const { state, load } = transcribers();
    const library = speechLibrary(dir, load);
    await library.fetch(a, () => undefined, signal);
    await library.fetch(b, () => undefined, signal);
    const answer = await library.run(a, { ...call("r-1", a.id), attachments: [TONE] }, signal);
    expect(answer.model).toBe(a.id);
    expect(Number(/^model a heard (\d+) samples$/u.exec(answer.text)?.[1])).toBeGreaterThanOrEqual(16_000);
    writeFileSync(join(dir, "speech-a.gguf"), "model x");
    await library.run(b, { ...call("r-2", b.id), attachments: [TONE] }, signal);
    await expect(library.run(a, { ...call("r-3", a.id), attachments: [TONE] }, signal)).rejects.toBeInstanceOf(NotReady);
    expect(state.loaded).toEqual(["model a", "model b"]);
    writeFileSync(join(dir, "speech-a.gguf"), "model a");
    state.swap = "model y";
    await expect(library.run(a, { ...call("r-4", a.id), attachments: [TONE] }, signal)).rejects.toBeInstanceOf(NotReady);
    expect(state.loaded).toEqual(["model a", "model b", "model y"]);
    expect(state.disposed.at(-1)).toBe("model y");
    expect(state.faults).toEqual([]);
  });

  it("answers a warm call once its model is loaded, an empty text with nothing transcribed; on the model loaded already, at once with no second load", async () => {
    const dir = folder();
    const { a } = await rows();
    const { state, load, release } = transcribers();
    const library = speechLibrary(dir, load);
    await library.fetch(a, () => undefined, signal);
    state.holdLoad = true;
    const warm = { id: "r-w1", model: a.id, input: "", attachments: [], warm: true as const };
    const warming = library.run(a, warm, signal);
    await until("the warm call's load begins", () => state.events.includes("loading model a"));
    release("load");
    expect(await warming).toEqual({ text: "", model: a.id });
    expect(state.loaded).toEqual(["model a"]);
    state.holdLoad = false;
    expect(await library.run(a, { ...warm, id: "r-w2" }, signal)).toEqual({ text: "", model: a.id });
    expect((await library.run(a, { ...call("r-w3", a.id), attachments: [TONE] }, signal)).text).toMatch(/^model a heard \d+ samples$/u);
    expect(state.loaded).toEqual(["model a"]);
    expect(state.faults).toEqual([]);
  });

  it("lets a model go only once its calls end and its load has settled: a call on another model, and a removal, wait for it", async () => {
    const dir = folder();
    const { a, b } = await rows();
    const { state, load, release } = transcribers();
    const library = speechLibrary(dir, load);
    await library.fetch(a, () => undefined, signal);
    await library.fetch(b, () => undefined, signal);
    state.holding.add("model a");
    const first = library.run(a, { ...call("r-1", a.id), attachments: [TONE] }, signal);
    await until("the first call transcribes", () => state.transcribing.includes("model a"));
    const second = library.run(b, { ...call("r-2", b.id), attachments: [TONE] }, signal);
    let removed = false;
    const removal = library.remove(a, signal).then(() => { removed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect([state.loaded, state.disposed, removed]).toEqual([["model a"], [], false]);
    release("model a");
    expect((await first).text).toMatch(/^model a heard/u);
    await removal;
    expect(existsSync(join(dir, "speech-a.gguf"))).toBe(false);
    expect((await second).text).toMatch(/^model b heard/u);
    expect(state.loaded).toEqual(["model a", "model b"]);
    expect(state.events).toEqual(["disposed model a with its file"]);
    expect(state.faults).toEqual([]);

    await library.fetch(a, () => undefined, signal);
    state.holdLoad = true;
    state.events.length = 0;
    const stop = new AbortController();
    const stopped = library.run(a, { ...call("r-3", a.id), attachments: [TONE] }, stop.signal);
    await until("model a's load has begun", () => state.events.includes("loading model a"));
    stop.abort(new Error("the call was cancelled"));
    await expect(stopped).rejects.toThrow("the call was cancelled");
    const later = library.remove(a, signal);
    release("load");
    await later;
    expect(state.events).toEqual(["disposed model b with its file", "loading model a", "disposed model a with its file"]);
    expect(existsSync(join(dir, "speech-a.gguf"))).toBe(false);
    expect(state.faults).toEqual([]);
  });

  it("closes only once a load its call stopped waiting for has settled and its model is disposed, and loads nothing after", async () => {
    const dir = folder();
    const { a } = await rows();
    const { state, load, release } = transcribers();
    const library = speechLibrary(dir, load);
    await library.fetch(a, () => undefined, signal);
    state.holdLoad = true;
    const stop = new AbortController();
    const stopped = library.run(a, { ...call("r-1", a.id), attachments: [TONE] }, stop.signal);
    await until("model a's load has begun", () => state.events.includes("loading model a"));
    stop.abort(new Error("the runner stopped"));
    await expect(stopped).rejects.toThrow("the runner stopped");
    let closed = false;
    const closing = library.close().then(() => { closed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    release("load");
    await closing;
    expect(state.events).toEqual(["loading model a", "disposed model a with its file"]);
    await expect(library.run(a, { ...call("r-2", a.id), attachments: [TONE] }, signal)).rejects.toThrow("the runner is stopping");
    expect(state.loaded).toEqual(["model a"]);
    expect(state.faults).toEqual([]);
  });
});

describe("the detector library", () => {
  const signal = new AbortController().signal;
  const LABELS = ["O", "S-private_person", "B-private_email", "E-private_email", "S-private_date"];
  const scoresOf = (labels: readonly number[]): Float32Array => {
    const scores = new Float32Array(labels.length * LABELS.length).fill(-20);
    labels.forEach((label, token) => (scores[token * LABELS.length + label] = 0));
    return scores;
  };
  async function served() {
    const { tokenizer, config } = syntheticTokenizer([" Ada"]);
    const bytes = {
      graph: Buffer.from("synthetic graph"), weights: Buffer.from("synthetic weights"), tokenizer: Buffer.from(JSON.stringify(tokenizer)),
      tokenizer_config: Buffer.from(JSON.stringify(config)), config: Buffer.from(JSON.stringify({ id2label: Object.fromEntries(LABELS.map((label, index) => [String(index), label])) })),
    };
    const names = { graph: "model_quantized.onnx", weights: "model_quantized.onnx_data", tokenizer: "tokenizer.json", tokenizer_config: "tokenizer_config.json", config: "config.json" };
    const server = await files(new Map(Object.entries(names).map(([key, name]) => [`/pf/${name}`, bytes[key as keyof typeof bytes]])));
    const artifact = (key: keyof typeof bytes) => ({ url: `${server.url}/pf/${names[key]}`, bytes: bytes[key].length, sha256: sha(bytes[key]) });
    const row = detectorRow({
      id: DETECTOR, name: "Privacy Filter", input: ["text"], output: "marks", tools: false, context_tokens: 8_000, thinking: [], platforms: [], languages: [], memory_gb: 8,
      source: { graph: artifact("graph"), weights: artifact("weights"), tokenizer: artifact("tokenizer"), tokenizer_config: artifact("tokenizer_config"), config: artifact("config") },
    });
    return { row, asked: server.asked, bytes };
  }
  function graphs() {
    const ada = tokenizerOf([" Ada"]).encode(" Ada", { add_special_tokens: false }).ids[0]!;
    const state = { loaded: [] as string[], disposed: 0, batches: [] as number[] };
    const load = async (path: string): Promise<Classifier> => {
      state.loaded.push(path);
      return {
        width: LABELS.length,
        classify: async (batch) => {
          state.batches.push(batch.length);
          return batch.map((ids) => scoresOf(ids.map((id) => (id === ada ? 1 : 0))));
        },
        dispose: () => { state.disposed++; },
      };
    };
    return { state, load };
  }
  const find = (id: string, input: string): Call => ({ id, model: DETECTOR, input, attachments: [] });

  it("fetches its files in order as one rising sum, answers a find under its key with each mark on its detail, and runs no call that is no find", async () => {
    const dir = folder();
    const { row, asked } = await served();
    const { state, load } = graphs();
    const library = detectorLibrary(dir, load);
    const said: number[] = [];
    await library.fetch(row, (bytes) => said.push(bytes), signal);
    expect(asked).toEqual(["/pf/config.json", "/pf/tokenizer_config.json", "/pf/tokenizer.json", "/pf/model_quantized.onnx", "/pf/model_quantized.onnx_data"]);
    expect(said.at(-1)).toBe(row.bytes);
    expect(said.every((bytes, index) => index === 0 || bytes >= said[index - 1]!)).toBe(true);
    expect(readdirSync(join(dir, DETECTOR)).sort()).toEqual(["config.json", "model_quantized.onnx", "model_quantized.onnx_data", "tokenizer.json", "tokenizer_config.json"]);

    const passages = ["Write to Ada now.", "नमस्ते Ada", "Nothing here."];
    const answer = await library.run(row, find("r-1", JSON.stringify(passages)), signal);
    expect(answer.model).toBe(DETECTOR);
    expect(JSON.parse(answer.text)).toEqual({ ...row.key, marks: [[{ start: 9, end: 12, type: "person" }], [{ start: 7, end: 10, type: "person" }], []] });
    expect(state.loaded).toEqual([join(dir, DETECTOR, "model_quantized.onnx")]);
    expect(state.batches).toEqual([3]);
    const many = Array.from({ length: 17 }, (_, index) => (index % 2 === 0 ? `${"Nothing ".repeat(index * 20 + 1)}Ada.` : "Nothing here."));
    const marked = JSON.parse((await library.run(row, find("r-many", JSON.stringify(many)), signal)).text).marks;
    expect(state.batches.length).toBeGreaterThan(2);
    expect(state.batches.slice(1).reduce((sum, rows) => sum + rows, 0)).toBe(many.length);
    expect(marked).toEqual(many.map((passage) => (passage.endsWith("Ada.") ? [{ start: passage.length - 4, end: passage.length - 1, type: "person" }] : [])));
    await library.fetch(row, () => undefined, signal);
    expect(asked).toHaveLength(5);
    for (const input of ["Write to Ada now.", "[]", JSON.stringify(Array.from({ length: 33 }, () => "A passage."))]) {
      await expect(library.run(row, find("r-2", input), signal)).rejects.toSatisfy((error) => error instanceof Failed && error.reason === "unreadable");
    }
    await library.close();
    expect(state.disposed).toBe(1);
  });

  it("answers null for a passage its tokens do not spell, and the call's other passages their marks", async () => {
    const dir = folder();
    const { row } = await served();
    const ada = tokenizerOf([" Ada"]).encode(" Ada", { add_special_tokens: false }).ids[0]!;
    const tilde = "~".charCodeAt(0);
    const load = async (): Promise<Classifier> => ({ width: LABELS.length, classify: async (batch) => batch.map((ids) => scoresOf((ids.includes(tilde) ? ids.slice(1) : ids).map((id) => (id === ada ? 1 : 0)))), dispose: () => undefined });
    const library = detectorLibrary(dir, load);
    await library.fetch(row, () => undefined, signal);
    const answer = await library.run(row, find("r-1", JSON.stringify(["Write to Ada now.", "A ~ that Ada spells nothing.", "Nothing here."])), signal);
    expect(JSON.parse(answer.text)).toEqual({ ...row.key, marks: [[{ start: 9, end: 12, type: "person" }], null, []] });
    await library.close();
  });

  it("never loads a graph that scores another count of labels than the model has, and lets it go", async () => {
    const dir = folder();
    const { row } = await served();
    let disposed = 0;
    const load = async (): Promise<Classifier> => ({ width: LABELS.length + 1, classify: async () => [], dispose: () => { disposed++; } });
    const library = detectorLibrary(dir, load);
    await library.fetch(row, () => undefined, signal);
    await expect(library.run(row, find("r-1", JSON.stringify(["Write to Ada now."])), signal)).rejects.toThrow(`the graph scores ${LABELS.length + 1} labels, and the model has ${LABELS.length}`);
    expect(disposed).toBe(1);
    await library.close();
  });

  it("never loads a file changed after its fetch, and removes every file, its model let go first", async () => {
    const dir = folder();
    const { row, bytes } = await served();
    const { state, load } = graphs();
    const library = detectorLibrary(dir, load);
    await library.fetch(row, () => undefined, signal);
    writeFileSync(join(dir, DETECTOR, "model_quantized.onnx_data"), "changed weights");
    await expect(library.run(row, find("r-1", JSON.stringify(["Ada"])), signal)).rejects.toBeInstanceOf(NotReady);
    expect(state.loaded).toEqual([]);
    writeFileSync(join(dir, DETECTOR, "model_quantized.onnx_data"), bytes.weights);
    await library.run(row, find("r-2", JSON.stringify(["Ada"])), signal);
    await library.remove(row, signal);
    expect(state.disposed).toBe(1);
    expect(readdirSync(join(dir, DETECTOR))).toEqual([]);
  });

  it("fails a find its GPU session fails, lets that session go once the last find on it ends, and loads the next on the CPU", async () => {
    const dir = folder();
    const { row } = await served();
    const sessions: { providers: string[]; disposed: boolean }[] = [];
    const said: string[] = [];
    let hold = (): void => undefined;
    const held = new Promise<void>((resolve) => { hold = resolve; });
    let runs = 0;
    const load = withFallback(["webgpu", "cpu"], async (_path, providers) => {
      const session = { providers: [...providers], disposed: false };
      sessions.push(session);
      return {
        width: LABELS.length,
        classify: async (batch) => {
          if (providers[0] === "webgpu") {
            if (++runs === 2) await held;
            throw new Error("the device was lost");
          }
          return batch.map((ids) => scoresOf(ids.map(() => 0)));
        },
        dispose: () => { session.disposed = true; },
      };
    }, (line) => said.push(line));
    const library = detectorLibrary(dir, load);
    await library.fetch(row, () => undefined, signal);
    const first = library.run(row, find("r-1", JSON.stringify(["Ada"])), signal);
    const second = library.run(row, find("r-2", JSON.stringify(["Ada"])), signal);
    await expect(first).rejects.toThrow(/webgpu session failed a run: the device was lost/u);
    expect(sessions).toEqual([{ providers: ["webgpu", "cpu"], disposed: false }]);
    hold();
    await expect(second).rejects.toThrow(/the device was lost/u);
    await until("the GPU session let go", () => sessions[0]!.disposed);
    expect(JSON.parse((await library.run(row, find("r-3", JSON.stringify(["Ada"])), signal)).text).marks).toEqual([[]]);
    expect(sessions.map((each) => each.providers)).toEqual([["webgpu", "cpu"], ["cpu"]]);
    expect(said).toEqual(["runner: the detector runs on the CPU until the runner restarts: ONNX Runtime's webgpu failed a run: the device was lost"]);
    await library.close();
  });
});

describe("the audio a speech model reads", () => {
  const peak = (samples: Float32Array): number => Math.max(...samples.subarray(200, samples.length - 200).map(Math.abs));
  const note = (name: string): Buffer => readFileSync(new URL(`./test/${name}`, import.meta.url));

  it("decodes an Ogg Opus note at 16 kHz, keeping a voice's level and letting nothing above 8 kHz fold back", async () => {
    const dir = folder();
    const voice = await decodeAudio("audio/ogg", note("tone.ogg"), dir, new AbortController().signal);
    expect(voice.length).toBeGreaterThanOrEqual(16_000);
    expect(voice.length).toBeLessThan(16_000 + 1_000);
    expect(peak(voice)).toBeGreaterThan(0.4);
    expect(peak(voice)).toBeLessThan(0.6);
    expect(peak(await decodeAudio("audio/ogg", note("high.ogg"), dir, new AbortController().signal))).toBeLessThan(0.001);
  });

  it("reads a Chat note's WAV as it is, on every platform: its samples whole; one cut, of half a sample or no format unreadable; one past the longest note too long", async () => {
    const dir = folder();
    const wav = (samples: number[], options: { rate?: number; channels?: number; bits?: number; cut?: number; size?: number } = {}): Buffer => {
      const { rate = 16_000, channels = 1, bits = 16 } = options;
      const data = Buffer.alloc(samples.length * 2);
      samples.forEach((sample, at) => data.writeInt16LE(sample, at * 2));
      const format = Buffer.alloc(24);
      format.write("fmt ", 0, "latin1");
      format.writeUInt32LE(16, 4);
      format.writeUInt16LE(1, 8);
      format.writeUInt16LE(channels, 10);
      format.writeUInt32LE(rate, 12);
      format.writeUInt32LE((rate * channels * bits) / 8, 16);
      format.writeUInt16LE((channels * bits) / 8, 20);
      format.writeUInt16LE(bits, 22);
      const head = Buffer.alloc(8);
      head.write("data", 0, "latin1");
      head.writeUInt32LE(options.size ?? data.length, 4);
      const body = Buffer.concat([Buffer.from("WAVE", "latin1"), format, head, data.subarray(0, data.length - (options.cut ?? 0))]);
      const riff = Buffer.alloc(8);
      riff.write("RIFF", 0, "latin1");
      riff.writeUInt32LE(body.length, 4);
      return Buffer.concat([riff, body]);
    };
    const read = await decodeAudio("audio/wav", wav([0, 16_384, -32_768, 32_767]), dir, new AbortController().signal);
    expect([...read]).toEqual([0, 0.5, -1, 32_767 / 32_768]);
    expect(readdirSync(dir)).toEqual([]);
    expect(canonicalWav(wav(new Array<number>(16_000).fill(0)))!.length).toBe(16_000);
    const refused = (bytes: Buffer): unknown => {
      try {
        return canonicalWav(bytes);
      } catch (error) {
        return error;
      }
    };
    for (const damaged of [wav([1, 2, 3], { cut: 2 }), wav([1, 2], { size: 3 }), Buffer.from("RIFF\u0004\u0000\u0000\u0000WAVE", "latin1"), Buffer.from("not a wav")]) {
      expect(refused(damaged)).toMatchObject({ name: "Failed", reason: "unreadable" });
    }
    expect(refused(wav([1], { size: (MOST_SECONDS * 16_000 + 1) * 2 }))).toMatchObject({ name: "Failed", reason: "too_long", seconds: MOST_SECONDS });
    for (const other of [wav([1, 2], { rate: 44_100 }), wav([1, 2], { channels: 2 }), wav([1, 2], { bits: 8 })]) expect(canonicalWav(other)).toBeNull();
    if (process.platform !== "darwin") await expect(decodeAudio("audio/wav", wav([1, 2], { rate: 44_100 }), dir, new AbortController().signal)).rejects.toMatchObject({ name: "Failed", reason: "unreadable" });
  });

  it("stops decoding a note when its call stops, and reads a note of another type off a Mac as unreadable", async () => {
    const dir = folder();
    const stop = new AbortController();
    const decoding = decodeAudio("audio/ogg", note("tone.ogg"), dir, stop.signal);
    stop.abort(new Error("the call was cancelled"));
    await expect(decoding).rejects.toThrow("the call was cancelled");
    if (process.platform !== "darwin") await expect(decodeAudio("audio/x-m4a", Buffer.from("m4a"), dir, new AbortController().signal)).rejects.toMatchObject({ name: "Failed", reason: "unreadable" });
  });
});
