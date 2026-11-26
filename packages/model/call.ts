import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { baseOf, makeUnder, restoreDetails, tryLock, trySharedLock, wantedOf, wordMarks, type BlobReader, type HomeFolder, type Json, type Work, type Mark, type PlaceholderTable, type Spelled } from "@lifestreamprotocol/core";
import { parse } from "./answer-types.js";
import { callLock, callsLock, ledgerFileOf, openLedger, type AttemptRef, type Landing, type Ledger, type RequestRow, type Rest } from "./ledger.js";
import type { SentCopy } from "./sent.js";
import type { TransportSettings } from "./settings.js";
import { bounded, errorText, mediaTypeOf, SendFailed, type SendAttachment, type Sent, type Transport } from "./transport.js";
import { transportsOf, type Found } from "./transports/index.js";
import { RUNNER_TRANSPORT } from "./transports/runner.js";


export type CallOutcome = "replied" | "failed" | "busy" | "unavailable" | "forgotten";
export const CALL_EXIT: Record<CallOutcome, number> = { replied: 0, failed: 1, busy: 75, unavailable: 69, forgotten: 0 };
export const LEDGER_DAMAGED_EXIT = 65;

export const REST_MS = 5 * 60_000;

function providers(error: SendFailed): boolean {
  return error.status === null || [401, 402, 403, 404, 408, 429].includes(error.status) || error.status >= 500;
}

function stated(until: number | undefined, now: number): number | null {
  return until !== undefined && Number.isFinite(until) && until > now ? until : null;
}

function restEnds(until: number | undefined, now: number): number {
  return stated(until, now) ?? now + REST_MS;
}

function restFor(error: SendFailed, now: number, alone: () => boolean): Rest | null {
  if (error.limit !== undefined) {
    return { until_ms: restEnds(error.limit.resets_ms, now), resets_ms: stated(error.limit.resets_ms, now), cause: "limit", reason: error.message };
  }
  if (error.until_ms !== undefined) return { until_ms: restEnds(error.until_ms, now), resets_ms: null, cause: "unavailable", reason: error.message };
  return providers(error) && !alone() ? { until_ms: now + REST_MS, resets_ms: null, cause: "provider", reason: error.message } : null;
}

export function routeId(route: { transport: string; model: string; runner?: string | undefined }): string {
  return `${route.transport}:${route.runner === undefined ? "" : `${route.runner}/`}${route.model}`;
}

export function readRouteId(id: string): { transport: string; runner?: string; model: string } | null {
  const at = id.indexOf(":");
  if (at < 1 || at === id.length - 1) return null;
  const transport = id.slice(0, at);
  const rest = id.slice(at + 1);
  if (transport !== RUNNER_TRANSPORT) return { transport, model: rest };
  const slash = rest.indexOf("/");
  return slash < 1 || slash === rest.length - 1 ? null : { transport, runner: rest.slice(0, slash), model: rest.slice(slash + 1) };
}

export function restsOf(route: { transport: string; model: string; runner?: string | undefined }): { transport: string; runner: string | null; route: string } {
  return { transport: route.transport, runner: route.runner === undefined ? null : `${route.transport}:${route.runner}`, route: routeId(route) };
}

function transportNamed(name: string, transports: TransportSettings | undefined, found: Found | undefined): Transport {
  const transport = transportsOf(transports, found).find((each) => each.name === name);
  if (transport === undefined) throw new TypeError(`no transport is named ${name}`);
  return transport;
}

export interface CallResult {
  key: string;
  outcome: CallOutcome;
  sent: boolean;
  reason?: string;
}

export interface CallRoute {
  transport: string;
  runner?: string;
  timeout_ms: number;
  line?: "chat";
}

export interface CallOptions {
  folder: HomeFolder;
  key: string;
  route: CallRoute;
  transports?: TransportSettings;
  found?: Found;
  blobs?: Pick<BlobReader, "has" | "bytes">;
  transport?: (name: string) => Transport;
  clock?: () => number;
  failpoint?: (at: "sending" | "copied" | "sent") => void;
  convert?: Converter;
  sentCopy?: number;
  copies: string;
}

const SENT_AS: Record<string, { media_type: string; extension: string }> = {
  "image/heic": { media_type: "image/jpeg", extension: ".jpg" },
  "audio/x-caf": { media_type: "audio/mp4", extension: ".m4a" },
};

export type Converter = (input: string, output: string, media_type: string, signal: AbortSignal) => Promise<void>;

const convert: Converter = async (input, output, media_type, signal) => {
  const run = promisify(execFile);
  if (media_type === "image/jpeg") await run("sips", ["-s", "format", "jpeg", input, "--out", output], { signal });
  else if (media_type === "audio/mp4") await run("afconvert", ["-f", "m4af", "-d", "aac", input, output], { signal });
  else throw new Error(`no converter writes ${media_type}`);
};

async function sendable(file: SendAttachment, converter: Converter, signal: AbortSignal): Promise<SendAttachment> {
  const target = SENT_AS[file.media_type];
  if (target === undefined) return file;
  const output = `${file.path}${target.extension}`;
  await converter(file.path, output, target.media_type, signal);
  return { path: output, media_type: target.media_type };
}

export async function runCall(options: CallOptions): Promise<CallResult> {
  const { key } = options;
  const clock = options.clock ?? Date.now;
  const file = ledgerFileOf(options.folder.root);
  const held = trySharedLock(callsLock(file));
  if (held === null) return { key, outcome: "busy", sent: false, reason: "a move, a verify or a retire holds the ledger" };
  try {
    const path = callLock(options.folder, key);
    makeUnder(dirname(file), dirname(path));
    const own = tryLock(path);
    if (own === null) return { key, outcome: "busy", sent: false, reason: "another call of this request runs" };
    try {
      return await call(options, key, clock);
    } finally {
      own.release();
    }
  } finally {
    held.release();
  }
}

async function call(options: CallOptions, key: string, clock: () => number): Promise<CallResult> {
  const ledger = openLedger(options.folder, { mode: "write" });
  const handed = options.sentCopy;
  let taken = false;
  try {
    const { route } = options;
    const row = ledger.row(key);
    if (row === undefined) return { key, outcome: "busy", sent: false, reason: `no request under ${key}` };
    const transport = (options.transport ?? ((name: string) => transportNamed(name, options.transports, options.found)))(route.transport);
    const { leaves } = transport;
    const copy = leaves === null || handed === undefined ? undefined : ledger.sent.get(handed);
    if (leaves !== null && (copy === undefined || copy.receiver !== leaves || copy.key !== key)) {
      return { key, outcome: "busy", sent: false, reason: `nothing is sent to ${leaves}: no copy of the request was made for it` };
    }
    const available = await transport.available();
    if (!available.ok) {
      const now = clock();
      ledger.rest(route.transport, { until_ms: restEnds(available.until_ms, now), resets_ms: null, cause: "unavailable", reason: available.detail }, now);
      return { key, outcome: "unavailable", sent: false, reason: bounded(available.detail) };
    }
    const now = clock();
    const begun = ledger.beginAttempt(key, now, route.transport, copy === undefined || leaves === null ? undefined : {
      copy: copy.id,
      outbound: {
        at_ms: now, receiver: leaves, route: routeId({ transport: route.transport, model: row.model, runner: route.runner }), by: null, what: "ask", tool: null,
        level: copy.level, counts: copy.counts, detector: copy.detector, chars: (copy.body ?? row.body).length,
        pictures: copy.body === null ? row.attachments.filter((file) => file.kind === "image").length : copy.pictures.length,
      },
    }, route.line);
    if ("standing" in begun) return { key, outcome: "replied", sent: false };
    if ("refused" in begun) return { key, outcome: "busy", sent: false, reason: begun.detail };
    taken = copy !== undefined;
    const { attempt, request } = begun;
    const budget = budgetOf(route.timeout_ms);
    try {
      return await attempted(ledger, options, attempt, request, transport, copy, budget, clock);
    } finally {
      budget.stop();
    }
  } finally {
    try {
      if (handed !== undefined && !taken) ledger.sent.drop(handed);
    } finally {
      ledger.close();
    }
  }
}

async function attempted(ledger: Ledger, options: CallOptions, attempt: AttemptRef, request: RequestRow, transport: Transport,
  copy: SentCopy | undefined, budget: Budget, clock: () => number): Promise<CallResult> {
  const { key, route } = options;
  options.failpoint?.("sending");
  let sent: Sent;
  const work = workOf(options);
  try {
    const attachments: SendAttachment[] = await Promise.all(sentFiles(ledger, request, copy, options.blobs).map(async (file) => {
      budget.signal.throwIfAborted();
      const path = join(work.path, file.name);
      writeFileSync(path, file.bytes(), { flag: "wx", mode: 0o600 });
      return sendable({ path, media_type: mediaTypeOf(file.kind, file.extension) }, options.convert ?? convert, budget.signal);
    }));
    const schema = ledger.schema(key);
    const schemaPath = join(work.path, "schema.json");
    if (schema !== null) writeFileSync(schemaPath, schema);
    options.failpoint?.("copied");
    if (budget.signal.aborted) throw new Error(budget.reason);
    sent = await transport.send({
      model: request.model, effort: request.effort, ...(request.sampling === null ? {} : { sampling: request.sampling }),
      input: copy?.body ?? request.body, ...(schema === null ? {} : { schema: schemaPath }), ...(route.runner === undefined ? {} : { runner: route.runner }),
      ...(route.line === undefined ? {} : { line: route.line }), signal: budget.signal,
    }, attachments);
  } catch (error) {
    const now = clock();
    if (error instanceof SendFailed && error.yielded === true) {
      return ledger.yielded(attempt, error.message, now) ? { key, outcome: "unavailable", sent: false, reason: bounded(error.message) } : forgotten(key);
    }
    const rests = restsOf({ transport: route.transport, model: request.model, runner: route.runner });
    const scope = error instanceof SendFailed ? error.scope : undefined;
    const on = scope === "route" ? rests.route : scope === "runner" ? rests.runner ?? rests.transport : rests.transport;
    const rest = error instanceof SendFailed ? restFor(error, now, () => ledger.alone(on, key)) : null;
    if (rest !== null) {
      const ended = ledger.end(attempt, on, rest, now);
      return ended ? { key, outcome: "unavailable", sent: false, reason: bounded(rest.reason) } : forgotten(key);
    }
    const reason = budget.signal.aborted && !(error instanceof SendFailed) ? budget.reason : errorText(error);
    return ledger.fail(attempt, reason, now) ? { key, outcome: "failed", sent: true, reason: bounded(reason) } : forgotten(key);
  } finally {
    work.empty();
  }
  const empty = sent.text.trim() === "";
  const drew = drewFaces(ledger, request);
  const hidden = (copy !== undefined && copy.body !== null) || drew;
  const landing: Landing | undefined = empty ? undefined
    : { ...sent, transport: route.transport, ...(hidden ? restored(ledger, request, sent.text, ledger.schema(key) !== null, drew) : {}) };
  if (budget.signal.aborted) return ledger.fail(attempt, budget.reason, clock(), sent) ? { key, outcome: "failed", sent: true, reason: budget.reason } : forgotten(key);
  options.failpoint?.("sent");
  const kept = landing === undefined ? ledger.fail(attempt, "the model answered with no text", clock(), sent) : ledger.land(attempt, landing, clock());
  if (!kept) return forgotten(key);
  return empty ? { key, outcome: "failed", sent: true, reason: "the model answered with no text" } : { key, outcome: "replied", sent: true };
}

function workOf(options: CallOptions): Work {
  return options.folder.work("call", { own: join(options.copies, options.key.slice("sha256:".length)) });
}

function forgotten(key: string): CallResult {
  return { key, outcome: "forgotten", sent: true, reason: "the request's item was forgotten, or an erasure ran, while the call ran" };
}

function sentFiles(ledger: Ledger, request: RequestRow, copy: SentCopy | undefined, blobs: CallOptions["blobs"]): { name: string; kind: "image" | "audio"; extension: string; bytes: () => Buffer }[] {
  if (copy === undefined || copy.body === null) {
    return request.attachments.map((file, n) => ({ name: `attachment-${n}${file.extension}`, kind: file.kind, extension: file.extension, bytes: () => attachment(ledger, file.sha256, blobs) }));
  }
  return ledger.sent.files(copy.id, copy.pictures.length).map((file, n) => ({
    name: `picture-${n}.jpg`, kind: "image" as const, extension: ".jpg",
    bytes: () => file.read() ?? (() => { throw new Error(`picture ${n} of sent copy ${copy.id} is missing`); })(),
  }));
}

function restored(ledger: Ledger, request: RequestRow, text: string, typed: boolean, drew: boolean): Pick<Landing, "text" | "marks" | "written" | "refused" | "table"> {
  const read = ledger.placeholders.part(`ask:${request.revision ?? request.key}`, wantedOf([{ text, marks: [] }]));
  let table: PlaceholderTable = drew ? { ...read.table, entries: read.table.entries.filter((entry) => baseOf(entry.type) !== "person" || entry.face !== undefined) } : read.table;
  const unknown: string[] = [];
  const put: Spelled[] = [];
  const back = (each: string): { text: string; marks: Mark[] } => {
    const answer = restoreDetails(each, table);
    table = answer.table;
    unknown.push(...answer.unknown);
    put.push(...answer.marks.map((mark) => ({ words: answer.text.slice(mark.start, mark.end), type: mark.type, ...(mark.who === undefined ? {} : { who: mark.who }), ...(mark.shown === undefined ? {} : { shown: mark.shown }) })));
    return { text: answer.text, marks: answer.marks.map(({ placeholder: _placeholder, ...mark }) => mark) };
  };
  const value = typed ? parse({ type: "object" }, text) : undefined;
  let out: string;
  let marks: Mark[];
  if (value !== undefined && "value" in value) {
    const walked = JSON.stringify(strings(value.value, (each) => back(each).text));
    out = put.length === 0 ? text : walked;
    marks = wordMarks(out, put);
  } else {
    const answer = back(text);
    out = answer.text;
    marks = answer.marks;
  }
  const moved = JSON.stringify(table.next) !== JSON.stringify(read.table.next);
  return {
    text: out, marks, written: text,
    ...(unknown.length === 0 ? {} : { refused: { unknown, reason: unknown.map((each) => `Your answer wrote ${each}, which the ${drew && each.startsWith("[[Person ") ? "picture does not show" : "text does not hold"}.`).join("\n") } }),
    ...(moved ? { table: { scope: read.table.scope, next: table.next } } : {}),
  };
}

function drewFaces(ledger: Ledger, request: RequestRow): boolean {
  return ledger.placeholders.faces(`ask:${request.revision ?? request.key}`).length > 0;
}

function strings(value: Json, each: (text: string) => string): Json {
  if (typeof value === "string") return each(value);
  if (Array.isArray(value)) return value.map((item) => strings(item, each));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, strings(item as Json, each)]));
  return value;
}

function attachment(ledger: Ledger, sha256: string, blobs: CallOptions["blobs"]): Buffer {
  try {
    return ledger.attachment(sha256);
  } catch (error) {
    if (blobs?.has(`sha256:${sha256}`) !== true) throw error;
    ledger.keep(blobs.bytes(`sha256:${sha256}`));
    return ledger.attachment(sha256);
  }
}

interface Budget {
  readonly signal: AbortSignal;
  readonly reason: string;
  stop(): void;
}

function budgetOf(ms: number): Budget {
  const controller = new AbortController();
  const reason = `no reply within ${ms} ms`;
  const timer = setTimeout(() => controller.abort(new Error(reason)), ms);
  return { signal: controller.signal, reason, stop: () => clearTimeout(timer) };
}
