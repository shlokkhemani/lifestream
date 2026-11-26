import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as tlsRequest } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { emptyTable, openHomeFolder } from "@lifestreamprotocol/core";
import type { RunnerEnded, RunnerFile, RunnerListing, RunnerPlaced } from "@lifestreamprotocol/model";
import { openHider, openMarks } from "@lifestreamprotocol/privacy";
import { DetectorError, driveHalf, hidingFile, openDetector, type DetectorCode, type DriveHalf } from "./detector.js";
import { checkoutProgram } from "./programs.js";
import { Refusal } from "./refusal.js";
import { editSettings } from "./test/folder.js";
import { until } from "./test/harness-root.js";
import { doorHere } from "./test/harness-door.js";
import { cleanup, makeHome, REPO } from "./test/support.js";

const RUNNER = "runner-macbook-pro-0001";
const DETECTOR = "privacy-filter";
const CHOSEN = `runner:${RUNNER}/${DETECTOR}`;
const MODEL = "qwen3.5-4b";
const KEY = { file: "sha256:0f0f", decode: "1" };

const detectorFile = (state: RunnerFile["state"], over: Partial<RunnerFile> = {}): RunnerFile => ({
  id: DETECTOR, name: "Privacy Filter", input: ["text"], output: "marks", tools: false, context_tokens: 8_000, thinking: [], bytes: 900_000_000, languages: [], memory_gb: 8, state,
  fetched_bytes: state === "ready" ? 900_000_000 : 0, failure: null, detector: KEY, ...over,
});
const listing = (files: RunnerFile[], over: Partial<RunnerListing> = {}): RunnerListing => ({
  unit: RUNNER, name: "Synthetic Mac", version: "2", boot: "boot-a", slots: 1, power: "mains", idle_s: null, thermal: null, memory_gb: 16, running: [], files, present: true, ...over,
});

function played(answer: (placed: RunnerPlaced, signal: AbortSignal, handed: () => void) => Promise<RunnerEnded>) {
  const state = { runners: [] as RunnerListing[], placed: [] as RunnerPlaced[], lists: 0 };
  const drive: DriveHalf = {
    place(placed, signal, handed) {
      state.placed.push(placed);
      return answer(placed, signal, handed);
    },
    async list() {
      state.lists++;
      return state.runners;
    },
  };
  return { state, drive };
}

const ok = (text: string): RunnerEnded => ({ ok: { text, model: DETECTOR } });
const rejection = (code: DetectorCode, words: string) => expect.objectContaining({ name: "DetectorError", code, message: expect.stringContaining(words) });
const turn = () => new Promise((resolve) => setImmediate(resolve));

describe("the detector's client", () => {
  it("answers its state at once from the runners' listing: off while Hiding details has no model, looking, the runner unheard or away, no detector there, not downloaded, downloading, failed, ready", async () => {
    let setting: string | null = null;
    const { state, drive } = played(async () => ok(""));
    const detector = openDetector({ chosen: () => setting, line: "send", drive, fresh_ms: 0 });
    expect(detector.state()).toEqual({ state: "off" });
    expect(state.lists).toBe(0);
    setting = CHOSEN;
    expect(detector.state()).toEqual({ state: "absent", why: "Looking for the machine that runs the hiding model" });
    const settled = () => new Promise((resolve) => setImmediate(resolve));
    const seen = async (runners: RunnerListing[]) => {
      state.runners = runners;
      await settled();
      detector.state();
      await settled();
      return detector.state();
    };
    expect(await seen([])).toEqual({ state: "absent", why: "The machine chosen to run the hiding model has not been heard from" });
    expect(await seen([listing([detectorFile("ready")], { present: false })])).toEqual({ state: "absent", why: "Synthetic Mac's runner is not running" });
    expect(await seen([listing([])])).toEqual({ state: "absent", why: "Synthetic Mac cannot run the hiding model" });
    expect(await seen([listing([detectorFile("absent")])])).toEqual({ state: "absent", why: "Hiding model on Synthetic Mac: Not downloaded" });
    expect(await seen([listing([detectorFile("fetching", { fetched_bytes: 340_000_000 })])])).toEqual({ state: "downloading", bytes: 340_000_000, total: 900_000_000 });
    expect(await seen([listing([detectorFile("failed", { failure: "hash" })])])).toEqual({ state: "absent", why: "Hiding model on Synthetic Mac: The download was damaged" });
    expect(await seen([listing([detectorFile("ready")]), listing([detectorFile("absent")], { unit: "runner-mac-mini-bb01" })]))
      .toEqual({ state: "ready", model: { id: DETECTOR, ...KEY } });
    setting = `runner:${RUNNER}/other-filter`;
    expect(await seen([listing([detectorFile("ready")])])).toEqual({ state: "absent", why: "Synthetic Mac cannot run the hiding model" });
    setting = "openrouter:example/marks-1";
    expect(await seen([listing([detectorFile("ready")])])).toEqual({ state: "absent", why: "openrouter:example/marks-1 is no runner's model: Hiding details runs on a runner" });
    setting = null;
    expect(detector.state()).toEqual({ state: "off" });
  });

  it("names the hiding model's file id from the runners' tables: the chosen model's first, any runner's while none is chosen, downloaded or not, null when none lists one", () => {
    const { detector: _, ...plain } = detectorFile("ready");
    const model: RunnerFile = { ...plain, id: MODEL, name: "Qwen 3.5", input: ["text", "image"], output: "text", context_tokens: 4_000 };
    const other = listing([model, detectorFile("absent", { id: "other-filter" })], { unit: "runner-mac-mini-bb01" });
    expect(hidingFile([], CHOSEN)).toBeNull();
    expect(hidingFile([listing([model])], CHOSEN)).toBeNull();
    expect(hidingFile([other, listing([model, detectorFile("absent")])], CHOSEN)).toBe(DETECTOR);
    expect(hidingFile([other, listing([model, detectorFile("fetching")])], null)).toBe("other-filter");
    expect(hidingFile([listing([model, detectorFile("absent")], { present: false })], null)).toBe(DETECTOR);
  });

  it("places one find of at most 32 passages on the runner the setting names, in its line, and answers its marks under the key of the file that found them, null for a passage not read", async () => {
    const answered = { ...KEY, file: "sha256:1e1e", marks: [[{ start: 9, end: 20, type: "person" }], [], null] };
    const { state, drive } = played(async () => ok(JSON.stringify(answered)));
    state.runners = [listing([detectorFile("ready")])];
    const detector = openDetector({ chosen: () => CHOSEN, line: "mark", drive });
    const passages = ["Write to Ada Example today.", "Nothing here.", "A passage the runner cannot spell."];
    expect(await detector.find(passages)).toEqual({ model: { id: DETECTOR, file: "sha256:1e1e", decode: "1" }, marks: [[{ start: 9, end: 20, type: "person" }], [], null] });
    expect(state.placed).toEqual([{ runner: RUNNER, model: DETECTOR, input: JSON.stringify(passages), attachments: [], line: "mark" }]);
    await expect(detector.find(Array.from({ length: 33 }, () => "A passage."))).rejects.toSatisfy((error) => error instanceof RangeError && !(error instanceof DetectorError));
    expect(state.placed).toHaveLength(1);
  });

  it("always settles: rejects with its code when off or not ready, when the call ends without an answer, when the answer is no find's for its passages, and when it outlives its time, its call cancelled", async () => {
    let answer: (placed: RunnerPlaced, signal: AbortSignal, handed: () => void) => Promise<RunnerEnded> = async () => ({ error: { code: "NO_RUNNER", runner: RUNNER } });
    let setting: string | null = null;
    const { state, drive } = played((placed, signal, handed) => answer(placed, signal, handed));
    state.runners = [listing([detectorFile("absent")])];
    const detector = openDetector({ chosen: () => setting, line: "send", drive, timeout_ms: 50 });
    await expect(detector.find(["One."])).rejects.toEqual(rejection("OFF", "No model is chosen for Hiding details"));
    setting = CHOSEN;
    await expect(detector.find(["One."])).rejects.toEqual(rejection("NOT_READY", "Hiding model on Synthetic Mac: Not downloaded"));
    state.runners = [];
    await expect(detector.find(["One."])).rejects.toEqual(rejection("NO_RUNNER", "has not been heard from"));
    state.runners = [listing([detectorFile("ready")])];
    await expect(detector.find(["One."])).rejects.toEqual(rejection("NO_RUNNER", "the hiding model's find ended NO_RUNNER"));
    answer = async () => ({ error: { code: "INTERRUPTED", reason: "restarted", runner: RUNNER } });
    await expect(detector.find(["One."])).rejects.toEqual(rejection("INTERRUPTED", "ended INTERRUPTED (restarted)"));
    answer = async () => Promise.reject(new Error("the door answered 503"));
    await expect(detector.find(["One."])).rejects.toEqual(rejection("NO_DOOR", "the door answered 503"));
    answer = async () => ok(JSON.stringify({ ...KEY, marks: [[], []] }));
    await expect(detector.find(["One."])).rejects.toEqual(rejection("BAD_ANSWER", "answered what no find answers"));
    answer = async () => ok(JSON.stringify({ ...KEY, marks: [[{ start: 0, end: 9, type: "person" }]] }));
    await expect(detector.find(["One."])).rejects.toEqual(rejection("BAD_ANSWER", "answered what no find answers"));
    let cancelled = false;
    answer = (_placed, signal, handed) => new Promise((resolve) => {
      handed();
      signal.addEventListener("abort", () => {
        cancelled = true;
        resolve({ error: { code: "INTERRUPTED", reason: "driver_gone", runner: RUNNER } });
      }, { once: true });
    });
    await expect(detector.find(["One."])).rejects.toEqual(rejection("TIMEOUT", "did not answer within"));
    expect(cancelled).toBe(true);
  });

  it("starts a find's time when the door hands it on: one waiting in the line past its time still answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => void vi.useRealTimers());
    const finds: { handed: () => void; answer: (end: RunnerEnded) => void; signal: AbortSignal }[] = [];
    const { state, drive } = played((_placed, signal, handed) => new Promise((answer) => {
      finds.push({ handed, answer, signal });
      signal.addEventListener("abort", () => answer({ error: { code: "INTERRUPTED", reason: "driver_gone", runner: RUNNER } }), { once: true });
    }));
    state.runners = [listing([detectorFile("ready")])];
    const detector = openDetector({ chosen: () => CHOSEN, line: "mark", drive, timeout_ms: 1_000 });
    let settled = false;
    const waiting = detector.find(["Write to Ada Example today."]).finally(() => { settled = true; });
    await turn();
    expect(finds).toHaveLength(1);
    vi.advanceTimersByTime(5_000);
    await turn();
    expect(settled).toBe(false);
    expect(finds[0]!.signal.aborted).toBe(false);
    finds[0]!.handed();
    finds[0]!.answer(ok(JSON.stringify({ ...KEY, marks: [[{ start: 9, end: 20, type: "person" }]] })));
    expect((await waiting).marks).toEqual([[{ start: 9, end: 20, type: "person" }]]);
    const timed = detector.find(["One."]);
    await turn();
    finds[1]!.handed();
    vi.advanceTimersByTime(999);
    expect(finds[1]!.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(timed).rejects.toEqual(rejection("TIMEOUT", "did not answer within 1 s"));
    expect(finds[1]!.signal.aborted).toBe(true);
  });

  it("gives a find's wait in the line its own limit: one never handed on rejects TIMEOUT at it, its call cancelled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => void vi.useRealTimers());
    let signal: AbortSignal | undefined;
    const { state, drive } = played((_placed, stop) => new Promise((answer) => {
      signal = stop;
      stop.addEventListener("abort", () => answer({ error: { code: "INTERRUPTED", reason: "driver_gone", runner: RUNNER } }), { once: true });
    }));
    state.runners = [listing([detectorFile("ready")])];
    const detector = openDetector({ chosen: () => CHOSEN, line: "mark", drive, timeout_ms: 1_000, wait_ms: 60_000 });
    const stuck = detector.find(["One."]);
    await turn();
    vi.advanceTimersByTime(59_999);
    expect(signal!.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(stuck).rejects.toEqual(rejection("TIMEOUT", "line did not move within 1 min"));
    expect(signal!.aborted).toBe(true);
  });

  it("keeps the door's refusal as REFUSED, from the door in this process and over HTTP", async () => {
    let answer: () => Promise<RunnerEnded> = async () => Promise.reject(new Refusal(400, "BAD_CALL", "a find goes to a detector's file"));
    const { state, drive } = played(() => answer());
    state.runners = [listing([detectorFile("ready")])];
    const detector = openDetector({ chosen: () => CHOSEN, line: "send", drive });
    await expect(detector.find(["One."])).rejects.toEqual(rejection("REFUSED", "400 BAD_CALL, a find goes to a detector's file"));
    const http = driveHalf("http://127.0.0.1:1", { call: () => "pass", drive: () => "pass" }, async () => new Response('{"error":"BAD_CALL"}', { status: 400 }));
    answer = () => http.place({ runner: RUNNER, model: DETECTOR, input: "[]", attachments: [], line: "send" }, new AbortController().signal, () => undefined);
    await expect(detector.find(["One."])).rejects.toEqual(rejection("REFUSED", "400 {\"error\":\"BAD_CALL\"}"));
  });
});

describe("the detector's journey", () => {
  const roots: string[] = [];
  afterAll(() => cleanup(roots));

  it("finds through the door's line on the fake runner and back: a send run's find and a hide call's, each detail's offsets in its passage, a passage it cannot read failing only its text, and a find that outlives its time frees the slot to one that waited past its own", async () => {
    const home = makeHome({
      runner: { scopes: ["run"], kind: "runner", unit: RUNNER },
      drive: { scopes: ["drive"], unit: "home" },
      call: { scopes: ["call"], unit: "home" },
      find: { scopes: ["find"], unit: "privacy-bench" },
    }, roots);
    editSettings(home.root, { [`model.runners.${RUNNER}.files`]: [MODEL], "model.defaults.hiding": CHOSEN });
    const door = await doorHere(home.root);
    onTestFinished(async () => { await door.stop(); });
    const dir = mkdtempSync(join(tmpdir(), "detector-journey-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "door-token"), `${home.tokens.runner}\n`, { mode: 0o600 });
    writeFileSync(join(dir, "script.json"), JSON.stringify({ words: { "Ada Example": "person", "person-a@example.com": "email", "+15550000001": "phone" }, hold: "never answered", unread: "Unspellable" }));
    const said: string[] = [];
    const program = spawn(process.execPath, [...checkoutProgram(join(REPO, "packages", "runner", "test", "fake-runner.ts")), "--door", door.url, "--pass", join(dir, "door-token"), "--script", join(dir, "script.json")], { cwd: REPO, stdio: ["ignore", "ignore", "pipe"] });
    program.stderr!.on("data", (chunk: Buffer) => said.push(chunk.toString("utf8")));
    const exited = new Promise<void>((resolve) => program.once("exit", () => resolve()));
    onTestFinished(async () => {
      program.kill("SIGTERM");
      await exited;
    });

    const drive = driveHalf(door.url, { call: () => home.tokens.call, drive: () => home.tokens.drive });
    const sending = openDetector({ chosen: () => CHOSEN, line: "send", drive, fresh_ms: 0 });
    await until("the detector is ready on the runner", () => sending.state().state === "ready")
      .catch((error: Error) => { throw new Error(`${error.message}; the state is ${JSON.stringify(sending.state())}; the runner said ${said.join("")}`); });
    const ready = sending.state();
    const passage = "Write to Ada Example at person-a@example.com or +15550000001 today.";
    const answer = await sending.find([passage, "Nothing personal here."]);
    expect(answer.model).toEqual((ready as { model: unknown }).model);
    expect(answer.marks).toEqual([[
      { start: passage.indexOf("Ada Example"), end: passage.indexOf("Ada Example") + "Ada Example".length, type: "person" },
      { start: passage.indexOf("person-a@"), end: passage.indexOf(" or "), type: "email" },
      { start: passage.indexOf("+1555"), end: passage.indexOf(" today"), type: "phone" },
    ], []]);

    expect((await sending.find(["Unspellable line.", "Call +15550000001."])).marks).toEqual([null, [{ start: 5, end: 17, type: "phone" }]]);
    const hider = openHider({
      people: () => ({ version: "people-1", owner: null, people: [] }),
      settings: () => ({ level: "all", chat: "all", links: "tokens", always: [], never: [] }),
      detector: sending, pictures: { read: () => Promise.reject(new Error("no picture here")), make: () => Promise.reject(new Error("no picture here")) },
      marks: openMarks(openHomeFolder(dirname(join(dir, "marks.db"))), join(dir, "marks.db")),
    });
    const hidden = await hider.hide([[{ text: "Ada Example wrote.\n\nUnspellable line.", free: true }], [{ text: "Ada Example wrote.", free: true }]], "all", emptyTable("ask:test"));
    expect("texts" in hidden && hidden.texts).toEqual([{ cannot: "This text cannot be hidden: the hiding model cannot read a passage of it." }, "[[Person 1]] wrote."]);

    const impatient = openDetector({ chosen: () => CHOSEN, line: "mark", drive, timeout_ms: 3_000 });
    const held = impatient.find(["This is never answered."]);
    await until("the runner runs the find it never answers", async () => (await drive.list()).some((runner) => runner.running.length === 1));
    const hiding = openDetector({ chosen: () => CHOSEN, line: "hide", drive, timeout_ms: 2_000 });
    const waited = hiding.find(["Call +15550000001."]);
    await expect(held).rejects.toEqual(expect.objectContaining({ code: "TIMEOUT" }));
    expect((await waited).marks).toEqual([[{ start: 5, end: 17, type: "phone" }]]);

    const benching = openDetector({ chosen: () => CHOSEN, line: "mark", drive: driveHalf(door.url, { call: () => home.tokens.find, drive: () => home.tokens.find }) });
    expect((await benching.find(["Call +15550000001."])).marks).toEqual([[{ start: 5, end: 17, type: "phone" }]]);
    await until("the runner states the model's file", async () => (await drive.list()).some((runner) => runner.files.some((file) => file.id === MODEL)));
    const pass = { authorization: `Bearer ${home.tokens.find}`, "content-type": "application/json" };
    const tried = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${door.url}${path}`, { method, headers: pass, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const answer = (await response.json().catch(() => ({}))) as { code?: unknown; error?: { code?: unknown } };
      return { status: response.status, code: answer.code ?? answer.error?.code };
    };
    const fromWifi = () => new Promise<{ status: number; code: unknown }>((resolve, reject) => {
      const asked = tlsRequest({ host: "127.0.0.1", port: door.lan!, method: "GET", path: "/v1/runners", headers: pass, rejectUnauthorized: false, agent: false }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode!, code: (JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { code?: unknown }).code }));
      });
      asked.on("error", reject);
      asked.end();
    });
    const refused = { status: 403, code: "PRINCIPAL_SCOPE" };
    const refusals = {
      "a model's call on a model's file": await tried("POST", "/v1/runners/calls", { runner: RUNNER, model: MODEL, input: "Describe this.", attachments: [] }),
      "a model's call on the detector's file": await tried("POST", "/v1/runners/calls", { runner: RUNNER, model: DETECTOR, input: "Describe this.", attachments: [] }),
      "a find in a hide call's line": await tried("POST", "/v1/runners/calls", { runner: RUNNER, model: DETECTOR, input: JSON.stringify(["One."]), attachments: [], line: "hide" }),
      "a find in a send run's line": await tried("POST", "/v1/runners/calls", { runner: RUNNER, model: DETECTOR, input: JSON.stringify(["One."]), attachments: [], line: "send" }),
      "the home's status": await tried("GET", "/v1/status"),
      "a record": await tried("GET", "/v1/record?source=notes:local:device-a&kind=note&key=a"),
      "a hide": await tried("POST", "/v1/hide-details", { texts: [] }),
      "the stations": await tried("GET", "/v1/stations"),
      "an errand": await tried("POST", "/v1/errands", {}),
      "who it is": await tried("GET", "/v1/me"),
      "the runners from the Wi-Fi": await fromWifi(),
    };
    expect(refusals).toEqual(Object.fromEntries(Object.keys(refusals).map((name) => [name, refused])));
    expect({
      "a find on a model's file": await tried("POST", "/v1/runners/calls", { runner: RUNNER, model: MODEL, input: JSON.stringify(["One."]), attachments: [], line: "mark" }),
      "a find on a runner never heard": await tried("POST", "/v1/runners/calls", { runner: "runner-mac-mini-bb01", model: DETECTOR, input: JSON.stringify(["One."]), attachments: [], line: "mark" }),
    }).toEqual({
      "a find on a model's file": { status: 400, code: "BAD_CALL" },
      "a find on a runner never heard": { status: 200, code: "NO_RUNNER" },
    });

    editSettings(home.root, { "model.defaults.hiding": null });
    const files = async () => Object.fromEntries((await drive.list()).find((runner) => runner.unit === RUNNER)!.files.filter((file) => file.id === DETECTOR || file.id === MODEL).map((file) => [file.id, file.state]));
    await until("the runner removes the hiding model's file", async () => (await files())[DETECTOR] === "absent");
    expect(await files()).toEqual({ [DETECTOR]: "absent", [MODEL]: "ready" });
  });
});
