import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { BlobReader, HomeFolder, Json, Piece, Prompt } from "@lifestreamprotocol/core";
import { keyedFolder, testMachine } from "@lifestreamprotocol/core/test/keyed";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { canonical, civilDay, dayBounds, digest, hideDetails, Keys, openHomeFolder, piecesText, tryLock, trySharedLock, wantedOf } from "@lifestreamprotocol/core";
import { openAsker, type Asker, type AskerOptions, type Candidate, type RoutedAsk, type Sending } from "./asker.js";
import { LEDGER_DAMAGED_EXIT, readRouteId, REST_MS, routeId, runCall, type CallOptions, type CallRoute, type Converter } from "./call.js";
import { inputHash, promptHash, requestKey, retryIdentity } from "./digest.js";
import { callCopiesOf, callLock, callsLock, holdCalls, ledgerSchema, LONGEST_REST_MS, openLedger, type AttemptRef, type Ledger, type Rest } from "./ledger.js";
import { isHanded, isPlaced, isStated, runnerInfo, type RunnerEnded, type RunnerListing, type RunnerPlaced } from "./runner-wire.js";
import { readModelSettings, type ModelSettings, type TransportSettings } from "./settings.js";
import { NO_SPEECH, SendFailed, type Abilities, type ListedModel, type SendAttachment, type SendRequest, type Transport } from "./transport.js";
import { addressTransport } from "./transports/address.js";
import { CLAUDE_CHAT_MODEL, CLAUDE_ITEM_MODEL } from "./transports/claude.js";
import { CODEX_CHAT_MODEL, codexTransport } from "./transports/codex.js";
import { fakeTransport, type FakeOptions } from "./transports/fake.js";
import { priced, transportSecret, transportsOf, type Found } from "./transports/index.js";
import { openRouterTransport } from "./transports/openrouter.js";
import { CALL_PASS, listRunners, runnerTransport, warmRunner } from "./transports/runner.js";

const ARTIFACTS = join(tmpdir(), "lifestream-model-e2e");
const CALL_MAIN = fileURLToPath(new URL("./call-main.ts", import.meta.url));
const CALL_BUNDLE = process.env.LIFESTREAM_TEST_DIST === undefined ? undefined : join(process.env.LIFESTREAM_TEST_DIST, "packages~model~call-main.mjs");
const CALL_CMD = CALL_BUNDLE !== undefined && existsSync(CALL_BUNDLE) ? [CALL_BUNDLE] : ["--import", "tsx", CALL_MAIN];
const homeAt = (machine: string) => ["--machine", machine, "--home", "home-test"];
const handed = (root: string, secrets: Record<string, string> = {}) => `${JSON.stringify(secrets)}\n${JSON.stringify(openHomeFolder(root).handOver())}`;
const T0 = Date.UTC(2026, 9, 3, 6, 0, 0);
const DAY = { zone: "Asia/Kolkata", day_start_hour: 4 };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY_MS = 24 * HOUR;

const TODAYS_SHAPE = `
  CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO meta (key, value) VALUES ('steps', '1');
  CREATE TABLE replies(
    key TEXT PRIMARY KEY, model TEXT, prompt_hash TEXT, input_hash TEXT, effort TEXT,
    sampling TEXT, output_schema TEXT, text TEXT NOT NULL, reply_model TEXT,
    invocation TEXT, runtime TEXT, input_tokens INTEGER, output_tokens INTEGER,
    cost_usd REAL, validation TEXT CHECK(validation IN ('accepted','refused')),
    validated_at TEXT, created TEXT NOT NULL, source TEXT, feeder TEXT, unit TEXT
  );
  CREATE TABLE prompts(hash TEXT PRIMARY KEY, version TEXT NOT NULL, text TEXT NOT NULL);
  CREATE TABLE requests(
    key TEXT PRIMARY KEY, family TEXT, feeder TEXT, unit TEXT NOT NULL, revision TEXT,
    model TEXT NOT NULL, effort TEXT NOT NULL, sampling TEXT, transport TEXT NOT NULL,
    prompt_hash TEXT NOT NULL REFERENCES prompts(hash), input_hash TEXT NOT NULL,
    body TEXT NOT NULL, attachments TEXT NOT NULL, requested TEXT NOT NULL,
    open INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX requests_unit ON requests(unit);
  CREATE INDEX requests_open ON requests(requested) WHERE open = 1;
  CREATE TABLE attempts(
    id INTEGER PRIMARY KEY, key TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('sending','replied','failed','unknown','settled')),
    started TEXT NOT NULL, finished TEXT, error TEXT,
    input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL,
    validation TEXT CHECK(validation IN ('accepted','refused')), settled TEXT
  );
  CREATE INDEX attempts_key ON attempts(key, id);
  CREATE INDEX attempts_started ON attempts(started);
  CREATE INDEX attempts_finished ON attempts(finished);
  CREATE TABLE unit_failures(
    id INTEGER PRIMARY KEY, revision TEXT NOT NULL, family TEXT, unit TEXT NOT NULL,
    at TEXT NOT NULL, reason TEXT NOT NULL
  );
  CREATE INDEX unit_failures_revision ON unit_failures(revision);
  CREATE INDEX replies_lookup ON replies(prompt_hash, input_hash);
  CREATE INDEX replies_carried ON replies(invocation);
  CREATE INDEX requests_revision ON requests(revision);
  CREATE TABLE outcomes(seq INTEGER PRIMARY KEY AUTOINCREMENT, attempt INTEGER NOT NULL, key TEXT NOT NULL, state TEXT NOT NULL);
  CREATE TABLE paid(attempt INTEGER PRIMARY KEY, grant_id INTEGER NOT NULL, started TEXT NOT NULL);
  CREATE INDEX paid_grant ON paid(grant_id, started);
  CREATE TABLE request_schemas(key TEXT PRIMARY KEY, schema TEXT NOT NULL);
`;
const TO_VERSION_3 = `
  CREATE INDEX requests_hashes ON requests(prompt_hash, input_hash);
  ALTER TABLE attempts ADD COLUMN transport TEXT;
  UPDATE attempts SET transport = (SELECT transport FROM requests WHERE requests.key = attempts.key) WHERE transport IS NULL;
  ALTER TABLE requests ADD COLUMN prompt TEXT;
  ALTER TABLE requests ADD COLUMN prompt_version INTEGER;
  ALTER TABLE replies ADD COLUMN prompt TEXT;
  ALTER TABLE replies ADD COLUMN prompt_version INTEGER;
  CREATE INDEX replies_versions ON replies(prompt, input_hash, prompt_version);
  CREATE INDEX requests_versions ON requests(prompt, input_hash, prompt_version);
  CREATE TABLE prompt_types(name TEXT NOT NULL, version INTEGER NOT NULL, type TEXT NOT NULL, first_ms INTEGER NOT NULL, PRIMARY KEY(name, version, type));
  UPDATE meta SET value = '3' WHERE key = 'steps';
  INSERT INTO meta (key, value) VALUES ('writer', '{"release":"a839c1e83","steps":3}');
`;

const PROMPT = "Caption this synthetic image in one sentence.";
const BODY = "Caption this synthetic image in one sentence.\n\nphoto person-a@example.com café \u{1F600}";
const INPUT = BODY.slice(PROMPT.length);
const said = (text: string): Piece[] => [{ text }];
const GOLDEN = {
  prompt_hash: "sha256:bf2bd4ac9ae92c50a742a4fb06e2f974adffce44dfbc8f9f531b1670f1705819",
  input_hash: "sha256:1c42c2e1ec8e87762fb3b6f9c14018090178b5ebe832d478bc9af4597692cfda",
  key_codex: "sha256:3a54fc4a510f3268f866870693f63477c08c87368038c7ff0f026895914e02aa",
  key_sampled: "sha256:f827ff3bc3fbc5ace7c751ce3a4458e10f65dfa035ddb8f9a83121c62bc771b9",
  key_integer_temperature: "sha256:0ee5532e2bdcd84c8cc1f66f4703472de363fa18560a17f26750cf4fc1c81eba",
  voice_identity: "sha256:d336e427b0a5fbb73d7c0f9c99186dbbb0ba6f26c1a06074bc6bcd3f74bad30a",
  retry_identity: "sha256:39c647c129897c8ac6d1025c3a868a6a4ade85f0c791ef37b85116f820649296",
  long_text: "sha256:a56af2e9bfeba185d9f1ae0b88280e46325c593088cd0c3b1a308dc0df0e3677",
  mixed: "sha256:1e0e8627a3253800db68efdb35ae9c0dee8367de1a16fb34c321c59dbaaf4478",
};

const BEFORE = {
  prompt_hash: GOLDEN.prompt_hash,
  input_hash: "sha256:a9431203a69dc104f9c609cef84c584788f5226bf7d8172c92d4b48b9d34c353",
  key_codex: "sha256:822000a7c2bf42779b0c640174c7400d979dbd9a2f86e430dea76a287a6996c4",
};

const STREAM = { work: "photos", source: "synthetic:account-a:copy" };
const LUNA = { model: "gpt-5.6-luna", effort: "low", ...STREAM };
const NEW = { model: "synthetic/new-model", effort: "high", ...STREAM };
const AUDIO = { model: "synthetic/audio", effort: "low", ...STREAM };
const MODEL_A = { model: "synthetic/model-a", effort: "none", sampling: { temperature: 0.2, seed: 7 }, ...STREAM };
const ROUTED = { model: "synthetic/routed", effort: "none", sampling: { temperature: 0 }, ...STREAM };

const SUMMARY = { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false };
const text = (body: string, version = 1): Prompt => ({ version, type: "text", keeps: [], text: body });
const PROMPTS: Readonly<Record<string, Prompt>> = {
  caption: text(PROMPT), tag: text("Tag this synthetic mail."), transcript: text("Transcribe this synthetic audio."),
  summary: { version: 1, type: SUMMARY, keeps: [], text: "Summarise this synthetic note." },
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the model package: each way it could fail, written before the code", () => {
  it("a ledger of today's shape loses a row at its open, an old reply is taken as an answer with no move, or a fingerprint or key drifts or takes in the prompt's text", async () => {
    const root = scratch();
    const path = join(root, "replies", "replies.db");
    todaysLedger(path, (db) => {
      db.prepare("INSERT INTO prompts VALUES (?, ?, ?)").run(BEFORE.prompt_hash, "photos/caption-v0", PROMPT);
      oldRequest(db, { key: BEFORE.key_codex, family: "photos", unit: "photo:synthetic-1", model: "gpt-5.6-luna", effort: "low", input_hash: BEFORE.input_hash, body: BODY, transport: "codex" });
      oldReply(db, { key: BEFORE.key_codex, model: "gpt-5.6-luna", effort: "low", input_hash: BEFORE.input_hash, text: "A synthetic caption.", validation: "accepted" });
      db.prepare("INSERT INTO meta(key, value) VALUES ('rest:codex', ?)").run(JSON.stringify({ until_ms: T0 + 30 * MINUTE, reason: "synthetic: an outage", key: BEFORE.key_codex, at_ms: T0 }));
    });
    const before = schemaOf(path) as { type: string; name: string; sql: string }[];
    const held = rows(path);
    expect(() => openLedger(openHomeFolder(dirname(dirname(path))), { mode: "read" })).toThrow(`the ledger is at version 3; this release reads ${ledgerSchema.latest}: the home has not started this release yet`);
    expect(() => openLedger(openHomeFolder(dirname(dirname(path))), { mode: "write" })).toThrow(/at version 3/u);
    expect(schemaOf(path)).toEqual(before);
    const home = openHome(root);
    const ask: RoutedAsk = { family: "photos", item: "photo:synthetic-1", prompt: "caption", input: said(INPUT), ...LUNA };

    expect(home.asker.key(ask)).toBe(GOLDEN.key_codex);
    expect(home.asker.key({ ...ask, input: said(piecesText(ask.input).normalize("NFC")) })).not.toBe(GOLDEN.key_codex);
    expect(home.asker.known(ask)).toEqual({ prompt: "caption", version: 1, input_hash: GOLDEN.input_hash });
    expect(home.asker.key({ family: "mail", item: "mail:synthetic-1", prompt: "caption", input: ask.input, ...MODEL_A })).toBe(GOLDEN.key_sampled);
    expect(home.asker.answer(ask)).toBeNull();
    expect(home.asker.state(ask)).toEqual({ pending: "unasked" });
    expect(home.ledger.next(BEFORE.key_codex, home.now())).toEqual({ answered: BEFORE.key_codex });

    expect(promptHash(PROMPT)).toBe(GOLDEN.prompt_hash);
    expect(inputHash(INPUT)).toBe(GOLDEN.input_hash);
    expect(requestKey({ model: "synthetic/model-a", prompt: "caption", version: 1, input_hash: GOLDEN.input_hash, effort: "none", sampling: { temperature: 0 } })).toBe(GOLDEN.key_integer_temperature);
    expect(inputHash("", { audio: `sha256:${"ab".repeat(32)}`, format: "m4a" })).toBe(GOLDEN.voice_identity);
    expect(retryIdentity(GOLDEN.input_hash, "an answer")).toBe(GOLDEN.retry_identity);
    expect(digest("x".repeat(70_000))).toBe(GOLDEN.long_text);
    expect(digest({ n: 2 ** 40, m: -300, f: -1.5, z: null, t: true, a: [1, "b"] })).toBe(GOLDEN.mixed);
    expect(home.sends).toEqual([]);
    expect(home.ledger.resting(home.now())).toEqual(new Map());
    home.close();
    const after = schemaOf(path) as typeof before;
    const hiding = /^(placeholder_|outbound|sent_copies|attempt_copies|reply_marks|sqlite_autoindex_placeholder_|sqlite_autoindex_reply_marks_|access|calls|call_withheld|call_came|call_code|call_opened|call_items|unlisted|reader_reads|reader_kinds|sqlite_autoindex_access|sqlite_autoindex_call|sqlite_autoindex_unlisted|sqlite_autoindex_reader_)/u;
    expect(before.filter((object) => !after.some((now) => now.name === object.name)).map((object) => object.name)).toEqual(["paid", "paid_grant"]);
    expect(after.filter((object) => !before.some((then) => then.name === object.name)).map((object) => object.name).filter((name) => !hiding.test(name))).toEqual(["prices", "sqlite_autoindex_prices_1"]);
    expect(after.filter((object) => !["prices", "sqlite_autoindex_prices_1"].includes(object.name) && !hiding.test(object.name))).toEqual(before.filter((object) => !["paid", "paid_grant"].includes(object.name)));
    expect(new Database(path, { readonly: true }).pragma("user_version", { simple: true })).toBe(ledgerSchema.latest);
    const now = rows(path);
    expect(now.meta.filter((row) => ["steps", "writer"].includes(String(row.key)))).toEqual([]);
    expect(now.attempts.map((row) => row.transport)).toEqual(["codex"]);
    expect(now.requests).toEqual(held.requests);
    expect(now.replies).toEqual(held.replies);
    expect(new Database(path, { readonly: true }).prepare("SELECT prompt, prompt_version FROM replies").all()).toEqual([{ prompt: null, prompt_version: null }]);
    artifact("todays-shape", path);
  });

  it("a carried reply is not found, its refusal is not the root its retries count against, or its retries are never given up", async () => {
    const root = scratch();
    const path = join(root, "replies", "replies.db");
    const mail = (item: string): RoutedAsk => ({ family: "mail", item, prompt: "tag", input: said(`\n\nsynthetic ${item}`), ...LUNA });
    const asks = { mail: mail("mail:one"), typed: mail("mail:typed") };
    const origin = (name: keyof typeof asks) => `sha256:${(name === "mail" ? "1" : "2").repeat(64)}`;
    todaysLedger(path, (db) => {
      for (const name of ["mail", "typed"] as const) {
        oldReply(db, { key: origin(name), model: "gpt-5.6-luna", effort: "low", input_hash: digest(name), text: `the ${name} answer`, validation: "accepted" });
      }
    });
    const home = openHome(root);
    for (const name of ["mail", "typed"] as const) carry(path, origin(name), { key: home.asker.key(asks[name]), ...home.asker.known(asks[name]), unit: asks[name].item });
    const before = rows(path);
    const carried = (ask: RoutedAsk, text: string) =>
      ({ reply: { key: home.asker.key(ask), model: "gpt-5.6-luna", text, value: text, version: 1, at_ms: Date.parse("2026-09-20T10:00:05.000Z") } });
    const retry = (ask: RoutedAsk) => {
      const sent = home.asker.request(ask);
      if (!("send" in sent)) throw new Error(`no request: ${JSON.stringify(sent)}`);
      return home.ledger.row(sent.send)!;
    };

    expect(home.asker.state(asks.mail)).toEqual(carried(asks.mail, "the mail answer"));
    expect(rows(path).requests).toEqual(before.requests);
    expect(home.sends).toEqual([]);

    home.prompts.tag = { ...home.prompts.tag!, type: SUMMARY };
    expect(home.asker.state(asks.typed)).toEqual({ pending: "unasked" });
    expect(home.asker.refused()).toEqual([home.asker.key(asks.typed)]);
    const typed = retry(asks.typed);
    expect([typed.revision, typed.key === home.asker.key(asks.typed)]).toEqual([home.asker.key(asks.typed), false]);
    expect(typed.body).toContain("Your previous answer to this request was refused. Your previous answer:\n\nthe typed answer");
    expect(typed.body).toContain("Why it was refused:\nthe answer holds no JSON object");
    home.prompts.tag = { ...home.prompts.tag, type: "text" };

    home.asker.refuse(asks.mail, carried(asks.mail, "the mail answer"), "a synthetic reason");
    const again = retry(asks.mail);
    expect([again.revision, again.key === home.asker.key(asks.mail)]).toEqual([home.asker.key(asks.mail), false]);
    expect(again.body).toContain("Why it was refused:\na synthetic reason");
    expect(home.sends).toEqual([]);
    const answered = (ask: RoutedAsk) => {
      const now = home.asker.state(ask);
      if (!("reply" in now)) throw new Error(`no answer: ${JSON.stringify(now)}`);
      return now;
    };
    await home.call(again.key);
    home.asker.refuse(asks.mail, answered(asks.mail), "the first retry's reason");
    expect(home.ledger.tries(home.asker.key(asks.mail))).toBe(2);
    const second = retry(asks.mail);
    expect([second.revision, second.key === again.key]).toEqual([home.asker.key(asks.mail), false]);
    expect(second.body).toContain("Why it was refused:\nthe first retry's reason");
    await home.call(second.key);
    home.asker.refuse(asks.mail, answered(asks.mail), "the second retry's reason");
    expect(home.asker.state(asks.mail)).toEqual({ givenUp: true, tries: 3 });
    expect(home.asker.request(asks.mail)).toEqual({ givenUp: true, tries: 3 });
    expect(home.sends).toHaveLength(2);
    home.close();
    artifact("carried", path);
  });

  it("an answer another model gave is asked again under the ask's model, or a refused one stands for it", async () => {
    const root = scratch();
    let answer = 0;
    const home = openHome(root, { fake: { reply: (request) => `caption ${++answer} by ${request.model}` } });
    const stated = (n: number) => ({ family: "photos", item: `photo:synthetic-${n}`, prompt: "caption", input: said(`\n\nphoto synthetic-${n}`), ...STREAM });
    const ask = (n: number): RoutedAsk => ({ ...stated(n), ...NEW });
    const OLD_MODEL = { model: "synthetic/old-model", effort: "medium" };
    await home.drain([1, 3, 4].map((n) => ({ ...stated(n), ...OLD_MODEL })));
    await home.drain([{ ...stated(2), model: "synthetic/other-model", effort: "medium" }]);
    home.asker.accept((home.asker.answer(stated(1)) as Candidate).reply);
    home.asker.accept((home.asker.answer(stated(2)) as Candidate).reply);
    home.asker.refuse(stated(3), home.asker.answer(stated(3)) as Candidate, "a synthetic refusal");
    expect(home.sends).toHaveLength(4);

    expect(home.asker.state(ask(1))).toEqual({ reply: { key: home.asker.key({ ...stated(1), ...OLD_MODEL }), model: "synthetic/old-model", text: "caption 1 by synthetic/old-model", value: "caption 1 by synthetic/old-model", version: 1, at_ms: T0 } });
    expect("reply" in home.asker.request(ask(1))).toBe(true);
    expect(home.asker.state(ask(2))).toMatchObject({ reply: { model: "synthetic/other-model" } });
    expect(home.asker.state(ask(4))).toMatchObject({ reply: { model: "synthetic/old-model" } });
    expect(home.asker.state(ask(3))).toEqual({ pending: "unasked" });
    await home.drain([ask(1), ask(2), ask(3), ask(4)]);
    expect(home.sends.slice(4).map((send) => send.input)).toEqual([`${PROMPT}${piecesText(stated(3).input)}`]);
    expect(home.asker.state(ask(3))).toMatchObject({ reply: { model: "synthetic/new-model" } });
    home.close();
    artifact("any-model", home.path);
  });

  it("an ask chosen for one model is answered by another's reply, or its own model's answer is missed, a retry's included", async () => {
    const home = openHome(scratch());
    const stated = { family: "photos", item: "photo:synthetic-c1", prompt: "caption", input: said("\n\nphoto synthetic-c1"), ...STREAM };
    const luna: RoutedAsk = { ...stated, ...LUNA };
    const moved: RoutedAsk = { ...stated, ...NEW };
    await home.drain([luna]);
    const first = home.asker.answer(stated) as Candidate;
    expect(first.reply.model).toBe("gpt-5.6-luna");
    expect(home.asker.answer(stated, { model: NEW.model })).toBeNull();
    expect(home.asker.state(moved, { model: NEW.model })).toEqual({ pending: "unasked" });
    expect("reply" in home.asker.request(moved)).toBe(true);
    expect(home.asker.request(moved, { model: NEW.model })).toMatchObject({ send: home.asker.key(moved) });
    expect(await home.call(home.asker.key(moved))).toMatchObject({ outcome: "replied", sent: true });
    expect(home.sends).toHaveLength(2);
    expect(home.asker.answer(stated, { model: NEW.model })).toMatchObject({ reply: { key: home.asker.key(moved), model: NEW.model } });
    expect(home.asker.answer(stated, { model: LUNA.model })).toEqual(first);
    home.asker.refuse(stated, home.asker.answer(stated, { model: NEW.model }) as Candidate, "a synthetic refusal");
    const retry = (home.asker.request(moved, { model: NEW.model }) as { send: string }).send;
    expect(retry).not.toBe(home.asker.key(moved));
    expect(await home.call(retry)).toMatchObject({ outcome: "replied", sent: true });
    expect(home.asker.answer(stated, { model: NEW.model })).toMatchObject({ reply: { key: retry, model: NEW.model } });
    expect(home.asker.answer(stated, { model: LUNA.model })).toEqual(first);
    home.close();
    artifact("answer-by-model", home.path);
  });

  it("a refused reply is replayed as an answer", async () => {
    const ask: RoutedAsk = { family: "photos", item: "photo:synthetic-9", prompt: "caption", input: said("\n\nphoto synthetic-9"), ...LUNA };
    let answer = 0;
    const home = openHome(scratch(), { fake: { reply: () => `synthetic caption ${++answer}` } });
    const key = home.asker.key(ask);
    expect(home.asker.state(ask)).toEqual({ pending: "unasked" });
    expect(home.ledger.next(key, home.now())).toEqual({ send: null });
    await home.drain([ask]);
    const states: unknown[] = [];
    for (let refusal = 1; refusal <= 3; refusal++) {
      const now = home.asker.state(ask);
      if (!("reply" in now)) throw new Error(`expected a reply before refusal ${refusal}, found ${JSON.stringify(now)}`);
      expect(now.reply.text).toBe(`synthetic caption ${refusal}`);
      home.asker.refuse(ask, now, `names a person who has no box (${refusal})`);
      home.asker.refuse(ask, now, "again");
      expect(home.ledger.tries(key)).toBe(refusal);
      expect(home.ledger.chain(key).map((row) => home.ledger.tries(row.key))).toEqual(home.ledger.chain(key).map((row) => (row.key === key ? refusal : 0)));
      states.push(home.asker.state(ask));
      expect(rows(home.path).requests).toHaveLength(refusal);
      await home.drain([ask]);
    }
    expect(states).toEqual([{ pending: "unasked" }, { pending: "unasked" }, { givenUp: true, tries: 3 }]);
    expect(home.sends).toHaveLength(3);
    expect(home.sends[1]!.input).toContain("synthetic caption 1");
    expect(home.sends[1]!.input).toContain("names a person who has no box (1)");
    expect(home.sends[2]!.input).toContain("synthetic caption 2");
    expect(home.asker.request(ask)).toEqual({ givenUp: true, tries: 3 });
    expect(home.ledger.next(key, home.now())).toEqual({ givenUp: 3 });
    home.close();
    artifact("refused-reply", home.path);
  });

  it("a request an older home wrote, whose revision names no request, fails three sends and is left queued, or charges another root", async () => {
    const root = scratch();
    const path = join(root, "replies", "replies.db");
    const item = (n: number) => `photo:synthetic-g${n}`;
    const body = (n: number) => `${PROMPT}\n\nphoto synthetic-g${n}`;
    const key = (n: number) => digest({ model: "gpt-5.6-luna", prompt: BEFORE.prompt_hash, input: digest(body(n)), effort: "low", sampling: null, schema: null });
    todaysLedger(path, (db) => {
      db.prepare("INSERT INTO prompts VALUES (?, ?, ?)").run(GOLDEN.prompt_hash, "photos/caption-v0", PROMPT);
      for (const n of [1, 2]) oldRequest(db, { key: key(n), family: "photos", unit: item(n), model: "gpt-5.6-luna", effort: "low", input_hash: digest(body(n)), body: body(n), transport: "codex" });
    });
    const home = openHome(root, { fake: { fail: "synthetic HTTP 400" } });
    expect(home.ledger.row(key(1))!.revision).toBe(`sha256:${"e".repeat(64)}`);
    for (let send = 1; send <= 3; send++) {
      expect(await home.call(key(1))).toMatchObject({ outcome: "failed", sent: true });
      expect(home.ledger.tries(key(1))).toBe(send);
      home.advance(30 * MINUTE);
    }
    expect(home.ledger.next(key(1), home.now())).toEqual({ givenUp: 3 });
    expect(await home.call(key(1))).toMatchObject({ outcome: "busy", sent: false });
    expect(home.ledger.tries(`sha256:${"e".repeat(64)}`)).toBe(0);
    expect(await home.call(key(2))).toMatchObject({ outcome: "failed", sent: true });
    expect(home.sends).toHaveLength(4);
    home.close();
    artifact("dangling-revision", path);
  });

  it("a call is sent again while its process lives, a call that died or ran out of time is not a try, or such tries never give the item up", async () => {
    const root = scratch();
    const home = openHome(root);
    const image = home.blobs.put(Buffer.from("synthetic jpeg bytes"));
    const ask: RoutedAsk = {
      family: "photos", item: "photo:synthetic-2", prompt: "caption", input: said(`\n\nphoto synthetic-2`), ...LUNA,
      attachments: [{ blob: image, media_type: "image/jpeg" }], identity: image.slice("sha256:".length),
    };
    const key = home.asker.key(ask);
    expect(home.ledger.next(key, home.now())).toEqual({ send: null });
    expect(rows(home.path).requests).toEqual([]);
    expect(home.asker.request(ask)).toMatchObject({ send: key });
    expect(home.ledger.next(key, home.now())).toEqual({ send: key });
    const killed = (at: "sending" | "sent") => (point: string) => { if (point === at) throw new Error(`killed at ${at}`); };

    await expect(home.call(key, { failpoint: killed("sending") })).rejects.toThrow("killed at sending");
    expect(home.sends).toHaveLength(0);
    expect(home.asker.state(ask)).toEqual({ waits: key });
    home.advance(DAY_MS);
    expect(home.ledger.next(key, home.now())).toEqual({ wait: { ready: false, why: "in-flight" } });
    expect(await home.call(key)).toMatchObject({ outcome: "busy", sent: false });

    expect(home.ledger.reap(home.now())).toBe(1);
    expect(home.ledger.reap(home.now())).toBe(0);
    expect(home.ledger.next(key, home.now())).toMatchObject({ wait: { ready: false, why: "failed" } });
    home.advance(30 * MINUTE);
    expect(home.ledger.next(key, home.now())).toEqual({ send: key });
    await expect(home.call(key, { failpoint: killed("sent") })).rejects.toThrow("killed at sent");
    expect(home.sends).toHaveLength(1);
    expect(home.sends[0]!.attachments).toEqual([{ media_type: "image/jpeg", bytes: "synthetic jpeg bytes" }]);
    expect(home.ledger.tries(key)).toBe(1);

    expect(home.ledger.reap(home.now())).toBe(1);
    home.advance(30 * MINUTE);
    expect(home.ledger.next(key, home.now())).toEqual({ send: key });
    expect(await home.call(key)).toMatchObject({ outcome: "replied", sent: true });
    expect(home.sends).toHaveLength(2);
    expect(home.asker.state(ask)).toMatchObject({ reply: { key } });
    expect(rows(home.path).attempts.map((row) => row.state)).toEqual(["failed", "failed", "replied"]);
    expect(rows(home.path).unit_failures.map((row) => row.reason)).toEqual(["the call process died with no outcome", "the call process died with no outcome"]);
    expect(await home.call(key)).toMatchObject({ outcome: "replied", sent: false });
    expect(home.sends).toHaveLength(2);

    const other: RoutedAsk = { family: "photos", item: "photo:synthetic-2b", prompt: "caption", input: said(`${piecesText(ask.input)} again`), ...LUNA };
    home.asker.request(other);
    const otherKey = home.asker.key(other);
    expect(await home.call(otherKey, { route: home.route(otherKey, { timeout_ms: 20 }), transport: () => home.transport({ delay_ms: 5_000 }) })).toMatchObject({ outcome: "failed", sent: true, reason: "no reply within 20 ms" });
    expect(home.asker.state(other)).toEqual({ failed: "no reply within 20 ms", retry_ms: expect.any(Number) });
    expect(home.ledger.tries(otherKey)).toBe(1);
    home.advance(30 * MINUTE);
    expect(home.ledger.next(otherKey, home.now())).toEqual({ send: otherKey });
    expect(await home.call(otherKey)).toMatchObject({ outcome: "replied", sent: true });
    expect(home.sends).toHaveLength(4);

    const doomed: RoutedAsk = { family: "photos", item: "photo:synthetic-2c", prompt: "caption", input: said(`${piecesText(ask.input)} doomed`), ...LUNA };
    home.asker.request(doomed);
    const doomedKey = home.asker.key(doomed);
    for (let call = 0; call < 3; call++) {
      expect(home.ledger.next(doomedKey, home.now())).toEqual({ send: doomedKey });
      await expect(home.call(doomedKey, { failpoint: killed("sent") })).rejects.toThrow("killed at sent");
      expect(home.ledger.reap(home.now())).toBe(1);
      home.advance(30 * MINUTE);
    }
    expect(home.sends).toHaveLength(7);
    expect(await home.call(doomedKey)).toMatchObject({ outcome: "busy", sent: false });
    expect(home.sends).toHaveLength(7);
    expect(home.asker.state(doomed)).toEqual({ givenUp: true, tries: 3 });
    expect(home.ledger.next(doomedKey, home.now())).toEqual({ givenUp: 3 });
    home.close();
    artifact("sent-twice", join(root, "replies", "replies.db"));
  });

  it("a failed send a person waits on (Chat's line) waits out the half hour, or is tried more than three times; any other ask's send skips it", async () => {
    const root = scratch();
    const home = openHome(root);
    const failing = { transport: () => home.transport({ fail: "synthetic HTTP 500" }) };
    const chat: RoutedAsk = { family: "ai", item: "voice:synthetic-1", prompt: "caption", input: said("\n\na synthetic voice note"), ...LUNA, line: "chat" };
    const key = home.asker.key(chat);
    const { line: _line, ...unlined } = chat;
    expect(home.asker.key(unlined)).toBe(key);
    expect(home.asker.request(chat)).toMatchObject({ send: key });
    const inLine = { ...failing, route: { ...home.route(key), line: "chat" as const } };
    for (let tried = 1; tried <= 3; tried++) {
      expect(await home.call(key, inLine)).toMatchObject({ outcome: "failed", sent: true });
      expect(home.ledger.tries(key)).toBe(tried);
      expect(home.ledger.next(key, home.now(), "chat")).toEqual(tried < 3 ? { send: key } : { givenUp: 3 });
      expect(home.ledger.next(key, home.now())).toEqual(tried < 3 ? { wait: { ready: false, why: "failed", retry_ms: expect.any(Number), error: "synthetic HTTP 500" } } : { givenUp: 3 });
      expect(home.asker.state(chat)).toEqual(tried < 3 ? { pending: "queued" } : { givenUp: true, tries: 3 });
    }
    expect(await home.call(key, inLine)).toMatchObject({ outcome: "busy", sent: false });
    expect(rows(home.path).attempts.map((row) => row.state)).toEqual(["failed", "failed", "failed"]);

    const other: RoutedAsk = { family: "photos", item: "photo:synthetic-line", prompt: "caption", input: said("\n\nphoto synthetic-line"), ...LUNA };
    const otherKey = home.asker.key(other);
    home.asker.request(other);
    expect(await home.call(otherKey, failing)).toMatchObject({ outcome: "failed", sent: true });
    expect(home.asker.state(other)).toEqual({ failed: "synthetic HTTP 500", retry_ms: expect.any(Number) });
    expect(await home.call(otherKey)).toMatchObject({ outcome: "busy", sent: false });
    home.advance(30 * MINUTE);
    expect(await home.call(otherKey)).toMatchObject({ outcome: "replied", sent: true });
    home.close();
  });

  it("a ledger an older release wrote holds attempts in unknown or settled that wait for a person, charge a try, or are rewritten", async () => {
    const root = scratch();
    const path = join(root, "replies", "replies.db");
    const input = (name: string) => `${PROMPT}\n\nphoto synthetic-${name}`;
    const key = (name: string) => digest({ model: "gpt-5.6-luna", prompt: BEFORE.prompt_hash, input: digest(input(name)), effort: "low", sampling: null, schema: null });
    const old = {
      unknown: [["unknown", "2026-10-01T10:00:00.000Z", "2026-10-01T10:02:00.000Z"], ["unknown", "2026-10-01T11:00:01.000Z", "2026-10-01T11:02:01.000Z"]],
      settled: [["settled", "2026-10-01T10:00:00.000Z", "2026-10-01T10:02:00.000Z"], ["settled", "2026-10-01T11:00:01.000Z", "2026-10-01T12:00:00.000Z"]],
      dead: [["failed", "2026-09-30T10:00:00.000Z", "2026-09-30T10:00:05.000Z"], ["sending", "2026-10-01T10:00:00.000Z", null], ["sending", "2026-10-01T11:00:01.000Z", null]],
    } as const;
    todaysLedger(path, (db) => {
      db.prepare("INSERT INTO prompts VALUES (?, ?, ?)").run(GOLDEN.prompt_hash, "caption", PROMPT);
      for (const [name, attempts] of Object.entries(old)) {
        db.prepare(`INSERT INTO requests VALUES (?, 'photos', NULL, ?, ?, 'gpt-5.6-luna', 'low', NULL, 'fake', ?, ?, ?, '[]', '2026-10-01T09:59:59.000Z', 0)`)
          .run(key(name), `photo:synthetic-${name}`, key(name), BEFORE.prompt_hash, digest(input(name)), input(name));
        for (const [state, started, finished] of attempts) {
          const { lastInsertRowid } = db.prepare("INSERT INTO attempts(key, state, started, finished, error, settled) VALUES (?, ?, ?, ?, ?, ?)")
            .run(key(name), state, started, finished, state === "failed" ? "synthetic HTTP 400" : null, state === "settled" ? "a person: checked the provider" : null);
          if (finished !== null) db.prepare("INSERT INTO outcomes(attempt, key, state) VALUES (?, ?, ?)").run(lastInsertRowid, key(name), state);
        }
        if (name === "dead") db.prepare("INSERT INTO unit_failures(revision, family, unit, at, reason) VALUES (?, 'photos', ?, '2026-09-30T10:00:05.000Z', 'synthetic HTTP 400')").run(key(name), `photo:synthetic-${name}`);
      }
    });
    const home = openHome(root);

    for (const name of ["unknown", "settled"]) {
      expect(home.ledger.next(key(name), home.now())).toEqual({ send: key(name) });
      expect(home.ledger.tries(key(name))).toBe(0);
      expect(await home.call(key(name))).toMatchObject({ outcome: "replied", sent: true });
      expect(home.ledger.tries(key(name))).toBe(0);
    }
    expect(home.ledger.next(key("dead"), home.now())).toEqual({ wait: { ready: false, why: "in-flight" } });
    expect(home.ledger.reap(home.now())).toBe(2);
    expect(home.ledger.next(key("dead"), home.now())).toEqual({ givenUp: 3 });
    expect(await home.call(key("dead"))).toMatchObject({ outcome: "busy", sent: false });
    expect(home.sends.map((send) => send.input)).toEqual([input("unknown"), input("settled")]);
    const attempts = rows(path).attempts;
    expect(attempts.map((row) => [row.key, row.state, row.settled])).toEqual([
      [key("unknown"), "unknown", null], [key("unknown"), "unknown", null],
      [key("settled"), "settled", "a person: checked the provider"], [key("settled"), "settled", "a person: checked the provider"],
      [key("dead"), "failed", null], [key("dead"), "failed", null], [key("dead"), "failed", null],
      [key("unknown"), "replied", null], [key("settled"), "replied", null],
    ]);
    expect(attempts.filter((row) => row.key === key("dead")).map((row) => row.error)).toEqual(["synthetic HTTP 400", "the call process died with no outcome", "the call process died with no outcome"]);
    home.close();
    artifact("older-attempt-states", path);
  });

  it("a call process killed by SIGKILL between the send and the land waits an hour, or another call of its key sends while it is in flight", async () => {
    const root = scratch();
    const home = openHome(root, { fake: { reply: "a synthetic reply" } });
    const ask: RoutedAsk = { family: "photos", item: "photo:synthetic-3", prompt: "caption", input: said(`\n\nphoto synthetic-3`), ...LUNA };
    const key = home.asker.key(ask);
    home.asker.request(ask);
    expect(home.path).toBe(join(root, "replies", "replies.db"));
    const child = (failpoint?: string) => spawnSync(process.execPath, [...CALL_CMD, "--root", root, "--route", JSON.stringify(home.route(key)), "--transports", JSON.stringify(home.settings.transports), ...homeAt(join(root, "machine")), "--key", key], {
      encoding: "utf8", input: handed(root), env: { ...process.env, ...(failpoint === undefined ? {} : { LIFESTREAM_CALL_FAILPOINT: failpoint }) },
    });

    const killed = child("sent");
    expect(killed.signal).toBe("SIGKILL");
    expect(rows(home.path).attempts.map((row) => row.state)).toEqual(["sending"]);
    expect(rows(home.path).replies).toEqual([]);
    const second = child();
    expect(second.status).toBe(75);
    expect(JSON.parse(second.stdout)).toMatchObject({ at: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/u), outcome: "busy", sent: false });
    expect(home.ledger.reap(Date.now())).toBe(1);
    expect(rows(home.path).outcomes.map((row) => row.state)).toEqual(["failed"]);
    const later = await runCall({ folder: openHomeFolder(dirname(dirname(home.path))), key, route: home.route(key), transports: home.settings.transports, copies: join(root, "calls"), clock: () => Date.now() + 30 * MINUTE });
    expect(later).toMatchObject({ outcome: "replied", sent: true });
    expect(rows(home.path).attempts.map((row) => row.state)).toEqual(["failed", "replied"]);
    expect(home.ledger.tries(key)).toBe(1);
    expect(rows(home.path).attempts.map((row) => row.transport)).toEqual(["fake", "fake"]);
    home.close();
    artifact("sigkill-call", home.path);
  });

  it("a call process that meets the ledger damaged dies with no word, or exits as a failed call the home would retry", () => {
    const root = scratch();
    const home = openHome(root, { fake: { reply: "a synthetic reply" } });
    const ask: RoutedAsk = { family: "photos", item: "photo:synthetic-damaged", prompt: "caption", input: said("\n\nphoto synthetic-damaged"), ...LUNA };
    const key = home.asker.key(ask);
    home.asker.request(ask);
    const route = home.route(key);
    home.close();
    const bytes = readFileSync(home.path);
    bytes.fill(0x2a, 0, 4096);
    writeFileSync(home.path, bytes);
    const call = spawnSync(process.execPath, [...CALL_CMD, "--root", root, "--route", JSON.stringify(route), ...homeAt(join(root, "machine")), "--key", key], { encoding: "utf8", input: handed(root) });
    expect({ status: call.status, stdout: call.stdout }).toEqual({ status: LEDGER_DAMAGED_EXIT, stdout: "" });
    expect(JSON.parse(call.stderr)).toMatchObject({ at: expect.any(String), key, exit: LEDGER_DAMAGED_EXIT, error: expect.stringMatching(/^the ledger is damaged: /u) });
  });

  it("a call process reads a secret from the folder, its command line or its environment, or one its transport does not name", () => {
    const root = scratch();
    const home = openHome(root);
    const ask: RoutedAsk = { family: "mail", item: "mail:synthetic-key", prompt: "tag", input: said(" mail synthetic-key"), ...ROUTED };
    const key = home.asker.key(ask);
    home.asker.request(ask);
    mkdirSync(join(root, "config", "secrets"), { recursive: true });
    writeFileSync(join(root, "config", "secrets", "openrouter"), "fake-folder-key\n", { mode: 0o600 });
    const call = (secrets: Record<string, string>) => spawnSync(process.execPath, [...CALL_CMD, "--root", root, "--route", JSON.stringify(home.route(key)), "--transports", JSON.stringify(home.settings.transports), ...homeAt(join(root, "machine")), "--key", key, "--sent-copy", String(home.copy(key, "OpenRouter"))], {
      encoding: "utf8", input: handed(root, secrets), env: { ...process.env, LIFESTREAM_SECRET_OPENROUTER: "fake-env-key" },
    });
    const none = call({});
    const other = call({ "another-secret": "fake-handed-key" });
    expect([none.status, other.status]).toEqual([69, 69]);
    expect(JSON.parse(none.stdout)).toMatchObject({ outcome: "unavailable", sent: false });
    expect(JSON.parse(other.stdout)).toMatchObject({ outcome: "unavailable", sent: false });
    expect(`${none.stdout}${other.stdout}`).toContain("openrouter has no API key");
    expect(home.sends).toEqual([]);
    home.close();
  });

  it("a call process is handed a transports block the settings would refuse, and sends with it", () => {
    const root = scratch();
    const address = { url: "http://127.0.0.1:9/v1", input: ["text"] };
    const call = (transports: unknown) => spawnSync(process.execPath, [...CALL_CMD, "--root", root, "--route", JSON.stringify({ transport: "address", timeout_ms: 1_000 }),
      "--transports", JSON.stringify(transports), ...homeAt(join(root, "machine")), "--key", `sha256:${"a".repeat(64)}`], { encoding: "utf8", input: handed(root) });
    const misspelt = call({ address: { ...address, secrt: "address" } });
    const query = call({ address: { ...address, url: "http://127.0.0.1:9/v1?key=synthetic-key" } });
    expect([misspelt.status, query.status]).toEqual([64, 64]);
    expect(misspelt.stderr).toContain("--transports: model.transports.address.secrt: address takes no such member");
    expect(query.stderr).toContain("--transports: model.transports.address.url holds no user name, password or query: a key goes in its secret");
    expect([misspelt.stdout, query.stdout]).toEqual(["", ""]);
    expect(existsSync(join(root, "replies"))).toBe(false);
  });

  it("a ledger attachment copy lost or torn by a crash uses up its item's tries, never sent", async () => {
    const root = scratch();
    const home = openHome(root);
    const copyOf = (blob: string) => join(root, "replies", "blobs", blob.slice(7, 9), blob.slice(9, 11), blob.slice(7));
    const asks = ["lost", "torn"].map((name): RoutedAsk => {
      const image = home.blobs.put(Buffer.from(`synthetic jpeg bytes, ${name}`));
      return {
        family: "photos", item: `photo:synthetic-${name}`, prompt: "caption", input: said(`\n\nphoto ${name}`), ...LUNA,
        attachments: [{ blob: image, media_type: "image/jpeg" }], identity: image.slice("sha256:".length),
      };
    });
    for (const ask of asks) home.asker.request(ask);
    for (const ask of asks) rmSync(copyOf(ask.attachments![0]!.blob));
    writeFileSync(copyOf(asks[1]!.attachments![0]!.blob), "synthetic jpeg");
    for (const ask of asks) expect(await home.call(home.asker.key(ask))).toMatchObject({ outcome: "replied", sent: true });
    expect(home.sends.map((send) => send.attachments)).toEqual([
      [{ media_type: "image/jpeg", bytes: "synthetic jpeg bytes, lost" }],
      [{ media_type: "image/jpeg", bytes: "synthetic jpeg bytes, torn" }],
    ]);
    expect(rows(home.path).unit_failures).toEqual([]);
    home.close();
    artifact("attachment-repaired", home.path);
  });

  it("a drawn attachment is read from the blobs or drawn before its request is written, a drawing that fails writes a request, or a later request sends an earlier drawing", async () => {
    const root = scratch();
    let failing = true;
    const drawn: { photo: string; faces: unknown }[] = [];
    const home = openHome(root, {
      draw: (photo, faces) => {
        drawn.push({ photo, faces });
        if (failing) throw new Error("face-engine draw failed: exit 1: a synthetic failure");
        return Buffer.from(`synthetic drawing ${drawn.length} of ${photo}: ${JSON.stringify(faces)}`);
      },
    });
    const photo = home.blobs.put(Buffer.from("synthetic photo bytes"));
    const faces = [{ placeholder: "[[Person 1]]", box: { x: 1, y: 1, width: 3, height: 3 } }, { placeholder: "[[Person 2]]", box: { x: 8, y: 1, width: 3, height: 3 } }];
    const ask: RoutedAsk = {
      family: "photos", item: "photo:synthetic-drawn", prompt: "caption", input: said(""), ...LUNA,
      attachments: [{ blob: photo, media_type: "image/jpeg", drawn: faces }], identity: { photo: photo.slice(7) },
    };
    const table = (revision: string) => home.ledger.placeholders.part(`ask:${revision}`, { who: new Set(), keys: new Set(), placeholders: new Set(["[[Person 1]]", "[[Person 2]]", "[[Person 3]]"]), words: new Set() }).table;
    const copy = (sha256: string) => readFileSync(join(root, "replies", "blobs", sha256.slice(0, 2), sha256.slice(2, 4), sha256), "utf8");
    const attached = () => (rows(home.path).requests as { attachments: string }[]).map((row) => (JSON.parse(row.attachments) as { sha256: string; extension: string }[]));

    expect(() => home.asker.request(ask)).toThrow("face-engine draw failed: exit 1: a synthetic failure");
    expect(rows(home.path).requests).toEqual([]);
    expect(home.asker.state(ask)).toEqual({ pending: "unasked" });
    expect(table(home.asker.key(ask)).entries).toEqual([]);
    failing = false;
    const { send } = home.asker.request(ask) as { send: string };
    expect(table(send)).toEqual({ scope: `ask:${send}`, next: { person: 3 }, entries: faces.map(({ placeholder, box }) => ({ placeholder, type: "person", detail: "", face: box })) });
    expect(drawn).toEqual([{ photo, faces }, { photo, faces }]);
    const [first] = attached()[0]!;
    expect(first).toEqual({ kind: "image", sha256: createHash("sha256").update(`synthetic drawing 2 of ${photo}: ${JSON.stringify(faces)}`).digest("hex"), extension: ".jpg" });
    expect(copy(first!.sha256)).toBe(`synthetic drawing 2 of ${photo}: ${JSON.stringify(faces)}`);
    expect(home.blobs.has(`sha256:${first!.sha256}`)).toBe(false);
    expect(home.asker.request(ask)).toMatchObject({ send });
    expect(drawn.length).toBe(2);
    expect(await home.call(send)).toMatchObject({ outcome: "replied", sent: true });
    expect(home.sends.map((each) => each.attachments)).toEqual([[{ media_type: "image/jpeg", bytes: copy(first!.sha256) }]]);
    expect((home.asker.state(ask) as Candidate).reply.faces).toEqual(faces);
    home.asker.refuse(ask, home.asker.state(ask) as Candidate, "a synthetic refusal");
    const retry = home.asker.request(ask) as { send: string };
    expect(retry.send).not.toBe(send);
    expect(drawn.length).toBe(3);
    expect(attached()[1]).toEqual([{ kind: "image", sha256: createHash("sha256").update(`synthetic drawing 3 of ${photo}: ${JSON.stringify(faces)}`).digest("hex"), extension: ".jpg" }]);
    const bare = openAsker({ ledger: home.ledger, prompt: (name) => PROMPTS[name]!, blobs: home.blobs });
    expect(() => bare.request({ ...ask, item: "photo:synthetic-bare", identity: "b".repeat(64) })).toThrow(`no draw is given: ${photo} cannot be sent drawn`);
    home.close();
    artifact("drawn-attachment", home.path);
  });

  it("a revision's faces have one source, its table: a rescan between its first request and a retry moves a face's placeholder, the retry or its hand-out draws today's faces, a reply naming a face the picture never showed (the owner's [[Person 0]] too) is taken, or a request stands without its faces", async () => {
    const root = scratch();
    const drawn: unknown[] = [];
    let answer = "";
    const home = openHome(root, { fake: { reply: () => answer }, draw: (photo, faces) => {
      drawn.push(faces);
      return Buffer.from(`synthetic drawing of ${photo}: ${JSON.stringify(faces)}`);
    } });
    const photo = home.blobs.put(Buffer.from("synthetic photo bytes"));
    const A = { x: 10, y: 10, width: 20, height: 20 };
    const B = { x: 60, y: 10, width: 20, height: 20 };
    const C = { x: 30, y: 50, width: 20, height: 20 };
    const askOf = (boxes: { x: number; y: number; width: number; height: number }[], item = "photo:synthetic-rescan"): RoutedAsk => ({
      family: "photos", item, prompt: "caption", input: said(""), ...LUNA, identity: { photo: `${photo.slice(7)}-${item}` },
      attachments: [{ blob: photo, media_type: "image/jpeg", drawn: boxes.map((box, at) => ({ placeholder: `[[Person ${at + 1}]]`, box })) }],
    });
    const first = [{ placeholder: "[[Person 1]]", box: A }, { placeholder: "[[Person 2]]", box: B }];

    const sent = home.asker.request(askOf([A, B])) as Sending;
    expect(sent.faces).toEqual(first);
    expect(home.ledger.placeholders.faces(`ask:${sent.send}`)).toEqual(first);
    answer = "[[Person 1]] stands beside [[Person 2]].";
    expect(await home.call(sent.send)).toMatchObject({ outcome: "replied", sent: true });
    home.asker.refuse(askOf([A, B]), home.asker.state(askOf([A, B])) as Candidate, "a synthetic refusal");

    const rescanned = askOf([C, A, B]);
    const retry = home.asker.request(rescanned) as Sending;
    expect(retry.send).not.toBe(sent.send);
    expect(retry.faces).toEqual(first);
    expect((home.asker.request(rescanned) as Sending).faces).toEqual(first);
    expect(drawn).toEqual([first, first]);
    expect(home.ledger.placeholders.faces(`ask:${sent.send}`)).toEqual(first);
    answer = "[[Person 3]] waves.";
    expect(await home.call(retry.send)).toMatchObject({ outcome: "replied" });
    expect(home.asker.state(rescanned)).toEqual({ pending: "unasked" });
    const last = home.asker.request(rescanned) as Sending;
    expect(last.faces).toEqual(first);
    answer = "[[Person 1]] waves.";
    expect(await home.call(last.send)).toMatchObject({ outcome: "replied" });
    const reply = (home.asker.state(rescanned) as Candidate).reply;
    expect([reply.text, reply.faces]).toEqual(["[[Person 1]] waves.", first]);
    const ownerAsk = askOf([A, B], "photo:synthetic-owner");
    const owned = home.asker.request(ownerAsk) as Sending;
    const read = home.ledger.placeholders.part(`ask:${owned.send}`, wantedOf([{ text: "[[Person 0]]", marks: [] }]));
    const seeded = hideDetails([{ text: "", marks: [] }], "all", read.table, { who: "person:owner", shown: "Owner Example" }).table;
    expect(seeded.entries.map((entry) => entry.placeholder)).toContain("[[Person 0]]");
    expect(home.ledger.placeholders.save(read, seeded)).toMatchObject({ saved: true });
    answer = "[[Person 0]] waves beside [[Person 1]].";
    expect(await home.call(owned.send)).toMatchObject({ outcome: "replied" });
    expect(home.asker.state(ownerAsk)).toEqual({ pending: "unasked" });
    expect(home.ledger.lastFailure(owned.send)).toBe("Your answer wrote [[Person 0]], which the picture does not show.");

    const db = new Database(home.path);
    db.exec("CREATE TRIGGER refuse_request BEFORE INSERT ON requests BEGIN SELECT RAISE(ABORT, 'synthetic disk error'); END");
    const other = askOf([A], "photo:synthetic-unwritten");
    expect(() => home.asker.request(other)).toThrow("synthetic disk error");
    expect(home.ledger.placeholders.faces(`ask:${home.asker.key(other)}`)).toEqual([]);
    db.close();
    home.close();
    artifact("faces-one-source", home.path);
  });

  it("a reply is landed without its attempt's state", async () => {
    const root = scratch();
    const home = openHome(root);
    const ask: RoutedAsk = { family: "photos", item: "photo:synthetic-4", prompt: "caption", input: said(`\n\nphoto synthetic-4`), ...LUNA };
    const key = home.asker.key(ask);
    home.asker.request(ask);
    const db = new Database(home.path);
    db.exec(`CREATE TRIGGER refuse_replied BEFORE UPDATE OF state ON attempts WHEN NEW.state = 'replied'
      BEGIN SELECT RAISE(ABORT, 'synthetic disk error'); END`);
    await expect(home.call(key)).rejects.toThrow("synthetic disk error");
    expect(rows(home.path).replies).toEqual([]);
    expect(rows(home.path).attempts.map((row) => row.state)).toEqual(["sending"]);
    expect(home.ledger.reap(home.now())).toBe(1);
    db.exec(`DROP TRIGGER refuse_replied; CREATE TRIGGER refuse_reply BEFORE INSERT ON replies
      BEGIN SELECT RAISE(ABORT, 'synthetic disk error'); END`);
    home.advance(30 * MINUTE);
    await expect(home.call(key)).rejects.toThrow("synthetic disk error");
    expect(rows(home.path).replies).toEqual([]);
    expect(rows(home.path).attempts.map((row) => row.state)).toEqual(["failed", "sending"]);
    db.exec("DROP TRIGGER refuse_reply");
    db.close();
    expect(home.asker.state(ask)).toEqual({ waits: key });
    home.close();
    artifact("land-atomic", home.path);
  });

  it("an attempt does not name the transport it ran on", async () => {
    const root = scratch();
    const home = openHome(root, { fake: { cost_usd: 0.4 } });
    const today = dayBounds(civilDay(home.now(), DAY), DAY).start_ms;
    expect(today).toBe(Date.UTC(2026, 9, 2, 22, 30));
    const voice = (n: number): RoutedAsk => ({ family: "voice", item: `voice:synthetic-${n}`, prompt: "transcript", input: said(`voice synthetic-${n}`), ...AUDIO });
    const send = async (ask: RoutedAsk, transport: string) => {
      const request = home.asker.request(ask);
      if (!("send" in request)) throw new Error(`expected a send, found ${JSON.stringify(request)}`);
      return home.call(request.send, { route: home.route(request.send, { transport }) });
    };
    await send(voice(1), "fake");
    await send(voice(2), "fake");
    await send(voice(3), "fake-b");
    expect(rows(home.path).attempts.map((row) => row.transport)).toEqual(["fake", "fake", "fake-b"]);
    expect(home.ledger.spend(today, []).get("voice")).toMatchObject({ calls: 3, usd: expect.closeTo(1.2, 9), replied: 3 });
    const ask = voice(5);
    const key = home.asker.key(ask);
    home.asker.request(ask);
    const begun = home.ledger.beginAttempt(key, home.now(), "fake-b");
    if (!("attempt" in begun)) throw new Error("expected an attempt");
    expect(home.ledger.inFlight()).toEqual([{ family: "voice", revision: key, transport: "fake-b", ...home.asker.known(ask) }]);
    expect(home.ledger.end(begun.attempt, "fake-b", { until_ms: home.now() + REST_MS, resets_ms: null, cause: "provider", reason: "synthetic: an outage" }, home.now())).toBe(true);
    expect(home.ledger.inFlight()).toEqual([]);
    expect(rows(home.path).attempts.at(-1)).toMatchObject({ state: "unknown", transport: "fake-b", error: "synthetic: an outage" });
    home.close();
    artifact("attempt-transport", home.path);
  });

  it("an answer type is left out of a request or held in its key, never reaches the transport, or is sent for a text answer", async () => {
    const root = scratch();
    const home = openHome(root, { fake: { reply: (request) => (request.schema === undefined ? "a synthetic answer" : '{"summary":"a synthetic answer"}') } });
    const plain: RoutedAsk = { family: "photos", item: "photo:synthetic-21", prompt: "caption", input: said("\n\nphoto synthetic-21"), ...LUNA };
    const shaped: RoutedAsk = { family: "notes", item: "note:synthetic-22", prompt: "summary", input: said("\n\nnote synthetic-22"), ...LUNA };
    for (const ask of [plain, shaped]) {
      expect(home.asker.key(ask)).toBe(requestKey({ model: ask.model, prompt: ask.prompt, version: 1, input_hash: inputHash(piecesText(ask.input)), effort: "low" }));
    }
    await home.drain([plain, shaped]);
    expect(home.ledger.schema(home.asker.key(shaped))).toBe(canonical(SUMMARY));
    expect(home.ledger.schema(home.asker.key(plain))).toBeNull();
    expect(home.sends.map((sent) => sent.schema === undefined ? null : JSON.parse(sent.schema))).toEqual([null, SUMMARY]);
    expect(home.asker.state(shaped)).toMatchObject({ reply: { text: '{"summary":"a synthetic answer"}', value: { summary: "a synthetic answer" }, version: 1 } });
    const answered = home.asker.state(shaped);
    if (!("reply" in answered)) throw new Error("expected a reply");
    home.asker.refuse(shaped, answered, "a synthetic refusal");
    await home.drain([shaped]);
    expect(home.sends.at(-1)!.schema).toBe(canonical(SUMMARY));
    expect(home.ledger.promptTypes()).toEqual([{ name: "caption", version: 1, type: "text", first_ms: T0 }, { name: "summary", version: 1, type: SUMMARY, first_ms: T0 }]);
    const schemas = () => {
      const db = new Database(home.path, { readonly: true });
      try { return db.prepare("SELECT key FROM request_schemas ORDER BY key").pluck().all(); } finally { db.close(); }
    };
    expect(schemas()).toEqual([home.asker.key(shaped), home.ledger.chain(home.asker.key(shaped)).at(-1)!.key].sort());
    home.ledger.forget([shaped.item]);
    expect(schemas()).toEqual([]);
    home.close();
    artifact("schema", home.path);
  });

  it("a transport that cannot run is charged to an item", async () => {
    const root = scratch();
    const home = openHome(root);
    const ask: RoutedAsk = { family: "photos", item: "photo:synthetic-5", prompt: "caption", input: said(`\n\nphoto synthetic-5`), ...LUNA };
    const key = home.asker.key(ask);
    home.asker.request(ask);

    const outage = home.transport({ unavailable: "synthetic outage" });
    expect(await home.call(key, { transport: () => outage })).toMatchObject({ outcome: "unavailable", sent: false });
    expect(rows(home.path).attempts).toEqual([]);
    expect(home.ledger.tries(key)).toBe(0);
    expect(home.asker.state(ask)).toEqual({ pending: "queued" });
    expect([...home.ledger.resting(home.now()).keys()]).toEqual(["fake"]);

    home.advance(5 * MINUTE);
    const refusing: Transport = { ...fakeTransport(), send: async () => { throw new SendFailed("fake", "synthetic HTTP 402", 402); } };
    expect(await home.call(key, { transport: () => refusing })).toMatchObject({ outcome: "unavailable", sent: false });
    expect(rows(home.path).attempts.map((row) => [row.state, row.error, row.transport])).toEqual([["unknown", "synthetic HTTP 402", "fake"]]);
    expect(home.ledger.tries(key)).toBe(0);
    expect(home.asker.state(ask)).toEqual({ pending: "queued" });
    expect([...home.ledger.resting(home.now()).keys()]).toEqual(["fake"]);

    home.advance(5 * MINUTE);
    expect(await home.call(key)).toMatchObject({ outcome: "replied", sent: true });
    expect(home.asker.state(ask)).toMatchObject({ reply: { key } });
    home.close();
    artifact("transport-unavailable", home.path);
  });

  it("an ask's request leaves out its prompt's text", async () => {
    const root = scratch();
    const home = openHome(root);
    const ask: RoutedAsk = { family: "photos", item: "photo:synthetic-6", prompt: "caption", input: said("\n\nphoto synthetic-6"), ...LUNA };
    await home.drain([ask]);
    expect(home.sends.map((send) => send.input)).toEqual([`${PROMPT}\n\nphoto synthetic-6`]);
    expect(home.ledger.row(home.asker.key(ask))!.body).toBe(`${PROMPT}\n\nphoto synthetic-6`);
    expect(home.asker.key({ ...ask, input: said(INPUT) })).toBe(GOLDEN.key_codex);
    expect(home.ledger.row(home.asker.key(ask))!.prompt_hash).toBe(GOLDEN.prompt_hash);
    expect(new Database(home.path, { readonly: true }).prepare("SELECT text FROM prompts WHERE hash = ?").pluck().get(GOLDEN.prompt_hash)).toBe(PROMPT);
    home.close();
    artifact("prompt-in-body", home.path);
  });

  it("a transport sends a request twice within one attempt, or loses the charge of an empty reply or of an answer lost after HTTP 200", async () => {
    const root = scratch();
    const home = openHome(root);
    const ask = (n: number): RoutedAsk => ({ family: "mail", item: `mail:synthetic-r${n}`, prompt: "tag", input: said(` mail synthetic-r${n}`), ...ROUTED });
    const posts: string[] = [];
    const replies: (() => Response)[] = [
      () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) }); },
      () => Response.json({ choices: [{ message: { content: "" } }], usage: { cost: 0.03, prompt_tokens: 10, completion_tokens: 0 } }),
      () => new Response("busy", { status: 503 }),
      () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) }); },
      () => new Response(new ReadableStream({ start: (stream) => stream.error(new Error("socket hang up")) }), { status: 200 }),
    ];
    const routed = openRouterTransport({
      held: () => true, key: () => "synthetic-key",
      fetch: (async (_url: string, init: RequestInit) => { posts.push(String(init.body)); return replies[posts.length - 1]!(); }) as typeof fetch,
    });
    const results = [];
    for (let n = 1; n <= 5; n++) {
      home.asker.request(ask(n));
      results.push(await home.call(home.asker.key(ask(n)), { transport: () => routed }));
    }
    expect(posts).toHaveLength(5);
    expect(results.map((result) => result.outcome)).toEqual(["unavailable", "failed", "unavailable", "unavailable", "failed"]);
    expect(results[0]).toMatchObject({ sent: false, reason: "openrouter: the connection failed: socket hang up" });
    expect(results[3]).toMatchObject({ sent: false, reason: "openrouter: the connection failed: getaddrinfo ENOTFOUND" });
    expect(results[4]).toMatchObject({ sent: true, reason: "openrouter: the answer was lost while it was read: socket hang up" });
    const attempts = rows(home.path).attempts;
    expect(attempts.map((row) => [row.state, row.cost_usd])).toEqual([["unknown", null], ["failed", 0.03], ["unknown", null], ["unknown", null], ["failed", null]]);
    expect(rows(home.path).outcomes.map((row) => row.state)).toEqual(["unknown", "failed", "unknown", "unknown", "failed"]);
    expect(rows(home.path).unit_failures.map((row) => row.reason)).toEqual(["the model answered with no text", "openrouter: the answer was lost while it was read: socket hang up"]);
    expect(home.ledger.spend(0, ["openrouter"]).get("mail")).toMatchObject({ usd: 0.03, calls: 5, unpriced: 4 });
    expect(home.ledger.resting(home.now()).get("openrouter")).toMatchObject({ reason: "openrouter: the connection failed: getaddrinfo ENOTFOUND" });
    home.close();
    artifact("one-send-per-attempt", home.path);
  });

  it("a provider outage or a network loss uses up good items' tries", async () => {
    const root = scratch();
    const home = openHome(root, { via: { "gpt-5.6-luna": "codex" } });
    const outage: (() => Response)[] = [
      () => new Response("rate limited", { status: 429 }),
      () => new Response("overloaded", { status: 503 }),
      () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) }); },
      () => new Response("timed out", { status: 408 }),
      () => new Response("bad gateway", { status: 502 }),
      () => new Response("no credit", { status: 402 }),
    ];
    let posts = 0;
    const routed = openRouterTransport({
      held: () => true, key: () => "synthetic-key",
      fetch: (async () => outage[posts++]?.() ?? Response.json({ choices: [{ message: { content: "a synthetic tag" } }], usage: { cost: 0.01 } })) as typeof fetch,
    });
    const binary = join(root, "codex");
    const runs = join(root, "codex-runs");
    writeFileSync(binary, [
      "#!/bin/sh",
      'case "$1" in --version) echo "codex-cli 0.200.0"; exit 0;; login) exit 0;; esac',
      `n=$(cat ${runs} 2>/dev/null || echo 0); echo $((n + 1)) > ${runs}`,
      'case "$n" in',
      '  0) echo "ERROR: exceeded retry limit, last status: 429 Too Many Requests" >&2; exit 1;;',
      '  1) echo "ERROR: stream disconnected before completion: error sending request for url (https://codex.example/responses)" >&2; exit 1;;',
      '  2) echo "ERROR: unexpected status 500 Internal Server Error: synthetic" >&2; exit 1;;',
      "esac",
      "cat > /dev/null; echo a synthetic caption",
      "",
    ].join("\n"), { mode: 0o755 });
    const transports = (name: string) => name === "codex" ? codexTransport({ codex: { binary, home: join(root, "codex-home") } }) : routed;
    const asks: RoutedAsk[] = [1, 2, 3].flatMap((n): RoutedAsk[] => [
      { family: "photos", item: `photo:synthetic-o${n}`, prompt: "caption", input: said(`\n\nphoto synthetic-o${n}`), ...LUNA },
      { family: "mail", item: `mail:synthetic-o${n}`, prompt: "tag", input: said(` mail synthetic-o${n}`), ...ROUTED },
    ]);
    const outcomes: string[] = [];
    for (let round = 0; round < 40 && !asks.every((ask) => "reply" in home.asker.state(ask)); round++) {
      for (const key of home.sendable(asks)) outcomes.push((await home.call(key, { transport: transports })).outcome);
      home.advance(REST_MS);
    }
    expect(asks.map((ask) => Object.keys(home.asker.state(ask))[0])).toEqual(asks.map(() => "reply"));
    expect(asks.map((ask) => home.ledger.tries(home.asker.key(ask)))).toEqual(asks.map(() => 0));
    const states = rows(home.path).attempts.map((row) => row.state);
    expect(states.filter((state) => state === "replied")).toHaveLength(asks.length);
    expect(states.filter((state) => state === "unknown")).toHaveLength(outage.length + 3);
    expect(outcomes.filter((outcome) => outcome === "unavailable")).toHaveLength(outage.length + 3);
    expect(posts).toBe(outage.length + 3);
    home.close();
    artifact("provider-outage", home.path);
  });

  it("one request the provider always fails rests its transport forever and is never given up", async () => {
    const root = scratch();
    const home = openHome(root);
    const routed = openRouterTransport({
      held: () => true, key: () => "synthetic-key",
      fetch: (async (_url: string, init: RequestInit) => String(init.body).includes("poison")
        ? new Response("provider returned error", { status: 502 })
        : Response.json({ choices: [{ message: { content: "a synthetic tag" } }], usage: { cost: 0.01 } })) as typeof fetch,
    });
    const mail = (name: string): RoutedAsk => ({ family: "mail", item: `mail:synthetic-${name}`, prompt: "tag", input: said(` mail synthetic-${name}`), ...ROUTED });
    const poison = mail("poison");
    const good: RoutedAsk[] = [];
    let rounds = 0;
    for (; rounds < 40 && !("givenUp" in home.asker.state(poison)); rounds++) {
      good.push(mail(`g${rounds}`));
      for (const key of home.sendable([...good].reverse().concat(poison))) await home.call(key, { transport: () => routed });
      expect(good.map((ask) => "reply" in home.asker.state(ask))).toEqual(good.map(() => true));
      home.advance(REST_MS);
    }
    expect(home.asker.state(poison)).toMatchObject({ givenUp: true, tries: 3 });
    expect(rounds).toBeLessThan(20);
    expect(home.sendable([poison, ...good])).toEqual([]);
    home.close();
    artifact("poison-request", home.path);
  });

  it("a priced reply with no cost is counted as costing nothing", async () => {
    const root = scratch();
    const home = openHome(root);
    const mail = (n: number): RoutedAsk => ({ family: "mail", item: `mail:synthetic-u${n}`, prompt: "tag", input: said(` mail synthetic-u${n}`), ...ROUTED });
    const routed = openRouterTransport({
      held: () => true, key: () => "synthetic-key",
      fetch: (async () => Response.json({ choices: [{ message: { content: "a synthetic tag" } }] })) as typeof fetch,
    });
    for (const key of home.sendable([mail(3)])) await home.call(key, { transport: () => routed });
    expect(home.asker.state(mail(3))).toMatchObject({ reply: { text: "a synthetic tag" } });
    const today = dayBounds(civilDay(home.now(), DAY), DAY).start_ms;
    expect(home.ledger.spend(today, ["openrouter"]).get("mail")).toMatchObject({ usd: 0, calls: 1, unpriced: 1 });
    home.advance(Date.UTC(2026, 9, 3, 22, 30) - home.now());
    expect(home.ledger.spend(dayBounds(civilDay(home.now(), DAY), DAY).start_ms, ["openrouter"]).get("mail")).toBeUndefined();
    home.close();
    artifact("unpriced-reply", home.path);
  });

  it("an attempt in flight when its item is forgotten lands on another request", async () => {
    const root = scratch();
    const home = openHome(root);
    const first: RoutedAsk = { family: "photos", item: "photo:synthetic-f1", prompt: "caption", input: said("\n\nphoto synthetic-f1"), ...LUNA };
    const second: RoutedAsk = { family: "photos", item: "photo:synthetic-f2", prompt: "caption", input: said("\n\nphoto synthetic-f2"), ...LUNA };
    home.asker.request(first);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = home.transport({ reply: async () => { await gate; return "the forgotten item's reply"; } });
    const inFlight = home.call(home.asker.key(first), { transport: () => slow });
    await until("the attempt in flight", () => rows(home.path).attempts.length === 1);
    home.ledger.forget([first.item]);
    home.asker.request(second);
    const secondKey = home.asker.key(second);
    const begun = home.ledger.beginAttempt(secondKey, home.now(), "fake");
    expect(begun).toHaveProperty("attempt");
    release();
    expect(await inFlight).toMatchObject({ sent: true });
    expect(rows(home.path).replies).toEqual([]);
    expect(rows(home.path).attempts.map((row) => [row.key, row.state])).toEqual([[secondKey, "sending"]]);
    expect(home.asker.state(first)).toEqual({ pending: "unasked" });
    home.ledger.close();
    artifact("forget-in-flight", home.path);
  });

  it("an erasure of a carried photo forgets every reply that shares the item of the reply it was carried from, or keeps that reply when the photo's own request shares the carried key", () => {
    const root = scratch();
    const path = join(root, "replies", "replies.db");
    const old = (n: number) => ({ key: `sha256:${String(n).repeat(64)}`, input_hash: digest({ image: n }) });
    const drawing = (n: number) => createHash("sha256").update(`old drawing ${n}`).digest("hex");
    const copy = (n: number) => join(root, "replies", "blobs", drawing(n).slice(0, 2), drawing(n).slice(2, 4), drawing(n));
    todaysLedger(path, (db) => {
      db.prepare("INSERT INTO prompts VALUES (?, ?, ?)").run(GOLDEN.prompt_hash, "caption", PROMPT);
      for (const n of [1, 2, 3]) {
        mkdirSync(join(copy(n), ".."), { recursive: true });
        writeFileSync(copy(n), `old drawing ${n}`);
        db.prepare(`INSERT INTO requests VALUES (?, 'photos', NULL, 'migrated', ?, 'gpt-5.6-luna', 'low', NULL, 'fake', ?, ?, ?, ?, '2026-09-20T10:00:00.000Z', 0)`)
          .run(old(n).key, old(n).key, GOLDEN.prompt_hash, old(n).input_hash, PROMPT, JSON.stringify([{ kind: "image", sha256: drawing(n), extension: ".jpg" }]));
        db.prepare(`INSERT INTO attempts(key, state, started, finished, validation) VALUES (?, 'replied', '2026-09-20T10:00:01.000Z', '2026-09-20T10:00:05.000Z', 'accepted')`).run(old(n).key);
        db.prepare(`INSERT INTO replies VALUES (?, 'gpt-5.6-luna', ?, ?, 'low', NULL, NULL, ?, 'gpt-5.6-luna', 'codex exec', 'codex CLI', NULL, NULL, NULL,
            'accepted', '2026-09-20T10:00:06.000Z', '2026-09-20T10:00:05.000Z', NULL, NULL, 'migrated')`).run(old(n).key, GOLDEN.prompt_hash, old(n).input_hash, `old caption ${n}`);
      }
    });
    const home = openHome(root);
    const ask = (hex: string): RoutedAsk => ({ family: "photos", item: `photo:${hex}`, prompt: "caption", input: said(""), identity: { photo: hex }, ...LUNA });
    const photo = ask("c".repeat(64));
    const asked = ask("d".repeat(64));
    const now = (item: RoutedAsk) => ({ ...home.asker.known(item), type: "text" as const, key: home.asker.key(item), unit: item.item });
    const sent = home.asker.request(asked) as { send: string };
    expect(sent.send).toBe(now(asked).key);
    home.ledger.fail((home.ledger.beginAttempt(sent.send, home.now(), "fake") as { attempt: AttemptRef }).attempt, "synthetic HTTP 500", home.now());
    carry(path, old(1).key, now(photo));
    carry(path, old(3).key, now(asked));

    expect(home.ledger.forget([photo.item])).toEqual({ requests: 1, replies: 2, attempts: 1, attachments: 1 });
    expect(rows(path).replies.map((row) => row.key)).toEqual([old(2).key, old(3).key, now(asked).key].sort());
    expect([existsSync(copy(1)), existsSync(copy(2)), existsSync(copy(3))]).toEqual([false, true, true]);
    expect(home.asker.state(photo)).toEqual({ pending: "unasked" });
    artifact("carried-erasure", path);

    expect(home.ledger.forget([asked.item])).toEqual({ requests: 2, replies: 2, attempts: 2, attachments: 1 });
    expect(rows(path).replies.map((row) => row.key)).toEqual([old(2).key]);
    expect(rows(path).requests.map((row) => row.key)).toEqual([old(2).key]);
    expect(rows(path).attempts.map((row) => row.key)).toEqual([old(2).key]);
    expect([existsSync(copy(1)), existsSync(copy(2)), existsSync(copy(3))]).toEqual([false, true, false]);
    expect(home.asker.state(asked)).toEqual({ pending: "unasked" });
    home.close();
    artifact("carried-erasure-own-request", path);
  });

  it("two items sharing one request diverge after a refusal, and a deadline is a failed try like any other", async () => {
    const root = scratch();
    let answer = 0;
    const home = openHome(root, { fake: { reply: () => `synthetic caption ${++answer}` } });
    const a: RoutedAsk = { family: "photos", item: "photo:synthetic-s1", prompt: "caption", input: said("\n\nphoto synthetic-s"), identity: "ab".repeat(32), ...LUNA };
    const b: RoutedAsk = { ...a, item: "photo:synthetic-s2" };
    expect(home.asker.key(a)).toBe(home.asker.key(b));
    await home.drain([a, b]);
    const first = home.asker.state(a);
    if (!("reply" in first)) throw new Error("expected a reply");
    home.asker.refuse(a, first, "names a person who has no box");
    await home.drain([a, b]);
    expect(home.sends).toHaveLength(2);
    expect(home.asker.state(b)).toEqual(home.asker.state(a));
    expect(home.asker.request(b)).toMatchObject({ reply: { text: "synthetic caption 2" } });
    expect(home.ledger.next(home.asker.key(b), home.now())).toMatchObject({ answered: expect.any(String) });
    expect(home.sends).toHaveLength(2);

    const c: RoutedAsk = { family: "photos", item: "photo:synthetic-u1", prompt: "caption", input: said("\n\nphoto synthetic-u1"), ...LUNA };
    const key = home.asker.key(c);
    home.asker.request(c);
    const hurried = { route: home.route(key, { timeout_ms: 20 }), transport: () => home.transport({ delay_ms: 5_000 }) };
    expect(await home.call(key, hurried)).toMatchObject({ outcome: "failed" });
    home.advance(30 * MINUTE);
    expect(await home.call(key, { transport: () => home.transport({ fail: "synthetic HTTP 500" }) })).toMatchObject({ outcome: "failed" });
    home.advance(30 * MINUTE);
    expect(await home.call(key, hurried)).toMatchObject({ outcome: "failed" });
    expect(home.asker.state(c)).toEqual({ givenUp: true, tries: 3 });
    expect(home.ledger.next(key, home.now())).toEqual({ givenUp: 3 });
    home.advance(30 * 24 * HOUR);
    expect(await home.call(key)).toMatchObject({ outcome: "busy", sent: false });
    expect(home.sends).toHaveLength(5);
    home.close();
    artifact("one-request-state", home.path);
  });

  it("a codex deadline leaves the call's descendants running", async () => {
    const root = scratch();
    const pidFile = join(root, "descendant.pid");
    const ranOut = join(root, "descendant.ran-out");
    const binary = join(root, "codex");
    writeFileSync(binary, [
      "#!/bin/sh",
      'case "$1" in --version) echo "codex-cli 0.200.0"; exit 0;; login) exit 0;; esac',
      `sh -c 'trap "" TERM; echo $$ > ${pidFile}; sleep 30; touch ${ranOut}' &`,
      "exec sleep 30",
      "",
    ].join("\n"), { mode: 0o755 });
    const home = openHome(root);
    const ask: RoutedAsk = { family: "photos", item: "photo:synthetic-c1", prompt: "caption", input: said("\n\nphoto synthetic-c1"), ...LUNA };
    home.asker.request(ask);
    const key = home.asker.key(ask);
    expect(await home.call(key, { route: home.route(key, { transport: "codex", timeout_ms: 300 }), transport: () => codexTransport({ codex: { binary, home: join(root, "codex-home") } }) })).toMatchObject({ outcome: "failed" });
    const descendant = Number(readFileSync(pidFile, "utf8"));
    await until("the call's descendant killed", () => !alive(descendant));
    expect(existsSync(ranOut)).toBe(false);
    home.close();
    artifact("codex-deadline", home.path);
  });

  it("codex is not held to a request's schema, or is handed one for a request that states none", async () => {
    const root = scratch();
    const binary = join(root, "codex");
    const seen = join(root, "seen");
    writeFileSync(binary, [
      "#!/bin/sh",
      'case "$1" in --version) echo "codex-cli 0.200.0"; exit 0;; login) exit 0;; esac',
      `echo "$@" >> ${seen}.args`,
      `while [ $# -gt 0 ]; do if [ "$1" = "--output-schema" ]; then cat "$2" >> ${seen}.schema; echo >> ${seen}.schema; fi; shift; done`,
      "cat > /dev/null",
      "echo '{\"summary\":\"a synthetic answer\"}'",
      "",
    ].join("\n"), { mode: 0o755 });
    const home = openHome(root);
    const plain: RoutedAsk = { family: "photos", item: "photo:synthetic-c2", prompt: "caption", input: said("\n\nphoto synthetic-c2"), ...LUNA };
    const shaped: RoutedAsk = { ...plain, item: "note:synthetic-c3", prompt: "summary", input: said("\n\nnote synthetic-c3") };
    for (const ask of [plain, shaped]) {
      const key = home.asker.key(ask);
      home.asker.request(ask);
      expect(await home.call(key, { route: home.route(key, { transport: "codex" }), transport: () => codexTransport({ codex: { binary, home: join(root, "codex-home") } }) })).toMatchObject({ outcome: "replied" });
    }
    const args = readFileSync(`${seen}.args`, "utf8").trim().split("\n");
    expect(args.map((line) => line.includes("--output-schema"))).toEqual([false, true]);
    expect(readFileSync(`${seen}.schema`, "utf8").trim()).toBe(canonical(SUMMARY));
    home.close();
    artifact("codex-schema", home.path);
  });

  it("an answer a retry won after a refusal is lost when the ask is asked with no route, or routed to another model", async () => {
    let answer = 0;
    const home = openHome(scratch(), { fake: { reply: () => `synthetic caption ${++answer}` } });
    const stated = { family: "photos", item: "photo:synthetic-a1", prompt: "caption", input: said("\n\nphoto synthetic-a1"), ...STREAM };
    const luna: RoutedAsk = { ...stated, ...LUNA };
    await home.drain([luna]);
    home.asker.refuse(stated, home.asker.answer(stated) as Candidate, "names a person who has no box");
    await home.drain([luna]);
    const retry = home.ledger.chain(home.asker.key(luna)).at(-1)!.key;
    expect(retry).not.toBe(home.asker.key(luna));
    const won = { reply: { key: retry, model: "gpt-5.6-luna", text: "synthetic caption 2", value: "synthetic caption 2", version: 1, at_ms: home.now() } };
    expect(home.asker.answer(stated)).toEqual(won);
    const moved: RoutedAsk = { ...stated, ...NEW };
    expect(home.asker.state(moved)).toEqual(won);
    expect(home.asker.request(moved)).toEqual(won);
    await home.drain([moved]);
    expect(home.sends).toHaveLength(2);
    expect(rows(home.path).requests).toHaveLength(2);
    home.asker.refuse(stated, won, "a synthetic refusal of the retry's reply");
    expect([home.ledger.tries(home.asker.key(luna)), home.ledger.tries(retry)]).toEqual([2, 0]);
    home.close();
    artifact("answer-any-route", home.path);
  });

  it("a refused reply is an answer under another route, a refusal with no route is charged to another revision, or three refusals give up another revision too", async () => {
    let answer = 0;
    const home = openHome(scratch(), { fake: { reply: (request) => `synthetic caption ${++answer} by ${request.model}` } });
    const stated = { family: "photos", item: "photo:synthetic-r1", prompt: "caption", input: said("\n\nphoto synthetic-r1"), ...STREAM };
    const luna: RoutedAsk = { ...stated, ...LUNA };
    const moved: RoutedAsk = { ...stated, ...NEW };
    const [lunaKey, newKey] = [home.asker.key(luna), home.asker.key(moved)];
    await home.drain([luna]);
    for (let refusal = 1; refusal <= 3; refusal++) {
      const candidate = home.asker.answer(stated) as Candidate;
      home.asker.refuse(stated, candidate, `a synthetic refusal (${refusal})`);
      expect(home.ledger.tries(lunaKey)).toBe(refusal);
      await home.drain([luna]);
    }
    expect(home.asker.state(luna)).toEqual({ givenUp: true, tries: 3 });
    expect(home.sends).toHaveLength(3);
    expect(home.asker.answer(stated)).toBeNull();
    expect(home.asker.state(moved)).toEqual({ pending: "unasked" });
    await home.drain([moved]);
    expect(home.sends.at(-1)!.input).toBe(`${PROMPT}${piecesText(stated.input)}`);
    const other = home.asker.answer(stated) as Candidate;
    expect(other).toEqual({ reply: { key: newKey, model: "synthetic/new-model", text: "synthetic caption 4 by synthetic/new-model", value: "synthetic caption 4 by synthetic/new-model", version: 1, at_ms: home.now() } });
    home.asker.refuse(stated, other, "a synthetic refusal of the other model's");
    expect([home.ledger.tries(lunaKey), home.ledger.tries(newKey)]).toEqual([3, 1]);
    expect(home.asker.state(moved)).toEqual({ pending: "unasked" });
    expect(home.asker.state(luna)).toEqual({ givenUp: true, tries: 3 });
    home.close();
    artifact("refused-any-route", home.path);
  });

  it("one model offered by two transports is sent through the transport its request names, or an attempt does not say which, even across the attempts of one request", async () => {
    const home = openHome(scratch(), { fake: { reply: "a synthetic caption" } });
    const built: string[] = [];
    let failing = false;
    const named = (name: string): Transport => { built.push(name); return { ...home.transport(failing ? { fail: "synthetic HTTP 400" } : {}), name }; };
    const ask = (n: number): RoutedAsk => ({ family: "photos", item: `photo:synthetic-t${n}`, prompt: "caption", input: said(`\n\nphoto synthetic-t${n}`), ...LUNA });
    const [first, second, third] = [1, 2, 3].map((n) => (home.asker.request(ask(n)) as { send: string }).send) as [string, string, string];
    const db = new Database(home.path);
    db.prepare("UPDATE requests SET transport = 'codex'").run();
    db.close();
    expect(await home.call(first, { route: home.route(first, { transport: "fake-b" }), transport: named })).toMatchObject({ outcome: "replied", sent: true });
    expect(await home.call(second, { route: home.route(second, { transport: "fake" }), transport: named })).toMatchObject({ outcome: "replied", sent: true });
    expect(built).toEqual(["fake-b", "fake"]);
    expect(rows(home.path).attempts.map((row) => [row.key, row.transport])).toEqual([[first, "fake-b"], [second, "fake"]]);
    expect(new Database(home.path, { readonly: true }).prepare("SELECT runtime FROM replies ORDER BY rowid").pluck().all()).toEqual(["fake-b", "fake"]);
    failing = true;
    expect(await home.call(third, { route: home.route(third, { transport: "fake" }), transport: named })).toMatchObject({ outcome: "failed", sent: true });
    failing = false;
    home.advance(30 * MINUTE);
    expect(await home.call(third, { route: home.route(third, { transport: "fake-b" }), transport: named })).toMatchObject({ outcome: "replied", sent: true });
    expect(rows(home.path).attempts.filter((row) => row.key === third).map((row) => [row.state, row.transport])).toEqual([["failed", "fake"], ["replied", "fake-b"]]);
    expect(home.ledger.row(third)).toMatchObject({ model: "gpt-5.6-luna", effort: "low", sampling: null });
    expect(home.sends).toHaveLength(4);
    home.close();
    artifact("two-transports", home.path);
  });

  it("two asks that share a request are two calls, a call in flight is missed under another model's key or by its retry's hashes, or a reply not yet judged is no answer", async () => {
    const home = openHome(scratch(), { fake: { reply: "a synthetic caption" } });
    const a: RoutedAsk = { family: "photos", item: "photo:synthetic-s1", prompt: "caption", input: said("\n\nphoto synthetic-s"), identity: "cd".repeat(32), ...LUNA };
    const b: RoutedAsk = { ...a, item: "photo:synthetic-s2" };
    const elsewhere: RoutedAsk = { ...b, ...NEW };
    const key = (home.asker.request(a) as { send: string }).send;
    expect(home.asker.request(b)).toMatchObject({ send: key });
    const begun = home.ledger.beginAttempt(key, home.now(), "fake") as { attempt: AttemptRef };
    for (const ask of [a, b, elsewhere]) expect(home.asker.request(ask)).toEqual({ waits: key });
    expect(home.asker.answer(b)).toEqual({ waits: key });
    expect(home.ledger.inFlight()).toEqual([{ family: "photos", revision: key, transport: "fake", ...home.asker.known(a) }]);
    expect(rows(home.path).requests).toHaveLength(1);
    home.ledger.land(begun.attempt, { text: "a synthetic caption", model: "gpt-5.6-luna", transport: "fake" }, home.now());
    expect(home.ledger.outcomesAfter(0, 10)).toEqual([{ seq: 1, attempt: begun.attempt.id, key, state: "replied", family: "photos", item: a.item, revision: key, ...home.asker.known(a) }]);
    expect(rows(home.path).replies.map((row) => row.validation)).toEqual([null]);
    const candidate = { reply: { key, model: "gpt-5.6-luna", text: "a synthetic caption", value: "a synthetic caption", version: 1, at_ms: home.now() } };
    for (const ask of [a, b, elsewhere]) expect(home.asker.state(ask)).toEqual(candidate);
    home.asker.refuse(a, candidate, "a synthetic refusal");
    const retry = (home.asker.request(a) as { send: string }).send;
    expect(retry).not.toBe(key);
    home.ledger.beginAttempt(retry, home.now(), "fake");
    for (const ask of [a, b, elsewhere]) expect(home.asker.state(ask)).toEqual({ waits: key });
    expect(home.ledger.inFlight()).toEqual([{ family: "photos", revision: key, transport: "fake", ...home.asker.known(a) }]);
    expect(home.sends).toEqual([]);
    home.ledger.close();
    artifact("shared-in-flight", home.path);
  });

  it("a limit's rest is said as its reset, a limit met again with no time unsays the reset, a limit with no time is given one, a route away or a transport's own time is said as a reset, what failed rests and nothing wider, or a reset outlives a reply or its own time", async () => {
    let failure: SendFailed | null = null;
    const home = openHome(scratch(), { fake: { reply: () => { if (failure !== null) throw failure; return "a synthetic caption"; } } });
    const ask = (n: number): RoutedAsk => ({ family: "photos", item: `photo:synthetic-l${n}`, prompt: "caption", input: said(`\n\nphoto synthetic-l${n}`), ...LUNA });
    const key = (home.asker.request(ask(1)) as { send: string }).send;
    const rest = () => home.ledger.resting(home.now()).get("fake");
    const resets = T0 + 3 * 24 * HOUR;
    const limit = (message: string, resets_ms?: number) => new SendFailed("fake", message, 429, { limit: resets_ms === undefined ? {} : { resets_ms } });
    failure = limit("synthetic: the plan's limit is met", resets);
    expect(await home.call(key)).toMatchObject({ outcome: "unavailable", sent: false });
    expect(rest()).toEqual({ until_ms: T0 + HOUR, resets_ms: resets, cause: "limit", reason: "synthetic: the plan's limit is met" });
    home.advance(HOUR);
    expect(rest()).toBeUndefined();
    expect(await home.call(key)).toMatchObject({ outcome: "unavailable" });
    expect(rest()).toEqual({ until_ms: T0 + 2 * HOUR, resets_ms: resets, cause: "limit", reason: "synthetic: the plan's limit is met" });
    home.advance(HOUR);
    failure = limit("synthetic: limited, no time");
    expect(await home.call(key)).toMatchObject({ outcome: "unavailable" });
    expect(rest()).toEqual({ until_ms: home.now() + REST_MS, resets_ms: resets, cause: "limit", reason: "synthetic: limited, no time" });
    home.advance(REST_MS);
    failure = new SendFailed("fake", "synthetic: answered 429, no limit marked", 429);
    expect(await home.call(key)).toMatchObject({ outcome: "unavailable" });
    expect(rest()).toEqual({ until_ms: home.now() + REST_MS, resets_ms: resets, cause: "provider", reason: "synthetic: answered 429, no limit marked" });
    home.advance(resets - home.now());
    failure = limit("synthetic: limited, no time");
    expect(await home.call(key)).toMatchObject({ outcome: "unavailable" });
    expect(rest()).toEqual({ until_ms: home.now() + REST_MS, resets_ms: null, cause: "limit", reason: "synthetic: limited, no time" });
    home.advance(REST_MS);
    failure = limit("synthetic: limited for twenty minutes", home.now() + 20 * MINUTE);
    expect(await home.call(key)).toMatchObject({ outcome: "unavailable" });
    expect(rest()).toEqual({ until_ms: home.now() + 20 * MINUTE, resets_ms: home.now() + 20 * MINUTE, cause: "limit", reason: "synthetic: limited for twenty minutes" });
    home.advance(20 * MINUTE);
    failure = null;
    expect(await home.call(key, { transport: () => home.transport({ unavailable: "synthetic: the runner is away", until_ms: home.now() + 15_000 }) })).toMatchObject({ outcome: "unavailable" });
    expect(rest()).toEqual({ until_ms: home.now() + 15_000, resets_ms: null, cause: "unavailable", reason: "synthetic: the runner is away" });
    home.advance(15_000);
    failure = new SendFailed("fake", "synthetic: the runner went away", null, { until_ms: home.now() + 15_000 });
    expect(await home.call(key)).toMatchObject({ outcome: "unavailable", sent: false });
    expect(rest()).toEqual({ until_ms: home.now() + 15_000, resets_ms: null, cause: "unavailable", reason: "synthetic: the runner went away" });
    expect(home.ledger.tries(key)).toBe(0);
    expect(new Set(rows(home.path).attempts.map((row) => row.state))).toEqual(new Set(["unknown"]));
    home.advance(15_000);
    const route = `fake:${LUNA.model}`;
    failure = new SendFailed("fake", "synthetic: the file is not ready", null, { until_ms: home.now() + 15_000, scope: "route" });
    expect(await home.call(key)).toMatchObject({ outcome: "unavailable", sent: false });
    expect([...home.ledger.resting(home.now()).keys()]).toEqual([route]);
    expect(home.ledger.resting(home.now()).get(route)).toEqual({ until_ms: home.now() + 15_000, resets_ms: null, cause: "unavailable", reason: "synthetic: the file is not ready" });
    home.advance(15_000);
    failure = new SendFailed("fake", "synthetic: the runner could not run the file", null, { scope: "route" });
    expect(await home.call(key)).toMatchObject({ outcome: "unavailable" });
    expect([...home.ledger.resting(home.now()).keys()]).toEqual([route]);
    expect(home.ledger.resting(home.now()).get(route)).toEqual({ until_ms: home.now() + REST_MS, resets_ms: null, cause: "provider", reason: "synthetic: the runner could not run the file" });
    expect(home.ledger.tries(key)).toBe(0);
    home.advance(REST_MS);

    home.advance(15_000);
    failure = limit("synthetic: the plan's limit is met", home.now() + 3 * 24 * HOUR);
    expect(await home.call(key)).toMatchObject({ outcome: "unavailable" });
    home.advance(HOUR);
    failure = null;
    expect(await home.call(key)).toMatchObject({ outcome: "replied" });
    home.advance(MINUTE);
    failure = new SendFailed("fake", "synthetic: no connection", null);
    const other = (home.asker.request(ask(2)) as { send: string }).send;
    expect(await home.call(other)).toMatchObject({ outcome: "unavailable" });
    expect(rest()).toEqual({ until_ms: home.now() + REST_MS, resets_ms: null, cause: "provider", reason: "synthetic: no connection" });

    home.advance(REST_MS);
    const third = (home.asker.request(ask(3)) as { send: string }).send;
    expect(await home.call(third)).toMatchObject({ outcome: "unavailable" });
    const network = home.now() + REST_MS;
    failure = limit("synthetic: limited for a minute", home.now() + MINUTE);
    const fourth = (home.asker.request(ask(4)) as { send: string }).send;
    expect(await home.call(fourth)).toMatchObject({ outcome: "unavailable" });
    expect(rest()).toEqual({ until_ms: network, resets_ms: home.now() + MINUTE, cause: "provider", reason: "synthetic: no connection" });
    home.advance(2 * MINUTE);
    expect(rest()).toEqual({ until_ms: network, resets_ms: null, cause: "provider", reason: "synthetic: no connection" });

    home.advance(REST_MS);
    failure = null;
    const running = (home.asker.request(ask(5)) as { send: string }).send;
    const begun = home.ledger.beginAttempt(running, home.now(), "fake") as { attempt: AttemptRef };
    failure = limit("synthetic: the plan's limit is met", home.now() + 3 * 24 * HOUR);
    expect(await home.call((home.asker.request(ask(6)) as { send: string }).send)).toMatchObject({ outcome: "unavailable" });
    home.advance(MINUTE);
    expect(home.ledger.land(begun.attempt, { text: "a synthetic caption", model: "gpt-5.6-luna", transport: "fake" }, home.now())).toBe(true);
    const lifted = { until_ms: home.now() - MINUTE + HOUR, resets_ms: null, cause: "limit", reason: "synthetic: the plan's limit is met" };
    expect(rest()).toEqual(lifted);
    home.ledger.forget([ask(5).item]);
    expect(rest()).toEqual(lifted);
    home.advance(HOUR);
    failure = null;
    expect(await home.call((home.asker.request(ask(7)) as { send: string }).send)).toMatchObject({ outcome: "replied" });
    failure = limit("synthetic: the plan's limit is met again", home.now() + 2 * 24 * HOUR);
    expect(await home.call((home.asker.request(ask(8)) as { send: string }).send)).toMatchObject({ outcome: "unavailable" });
    expect(rest()).toEqual({ until_ms: home.now() + HOUR, resets_ms: home.now() + 2 * 24 * HOUR, cause: "limit", reason: "synthetic: the plan's limit is met again" });

    home.ledger.rest("fake", { until_ms: home.now() + 10 * HOUR, resets_ms: home.now() + 10 * HOUR, cause: "limit", reason: "synthetic: asked ten hours" }, home.now());
    expect(rest()).toEqual({ until_ms: home.now() + LONGEST_REST_MS, resets_ms: home.now() + 10 * HOUR, cause: "limit", reason: "synthetic: asked ten hours" });
    home.close();
    artifact("limit-reset", home.path);
  });

  it("a limit a route saw, then a stall to the deadline, charges the item a try", async () => {
    const home = openHome(scratch(), {
      fake: {
        reply: (request) => new Promise<string>((_, reject) => {
          request.signal.addEventListener("abort", () => reject(new SendFailed("fake", "synthetic: the limit was met, then the run stalled", 429, { limit: { resets_ms: T0 + 20 * MINUTE } })), { once: true });
        }),
      },
    });
    const ask = (n: number): RoutedAsk => ({ family: "photos", item: `photo:synthetic-d${n}`, prompt: "caption", input: said(`\n\nphoto synthetic-d${n}`), ...LUNA });
    const [limited, stalled] = [1, 2].map((n) => (home.asker.request(ask(n)) as { send: string }).send) as [string, string];
    expect(await home.call(limited, { route: home.route(limited, { timeout_ms: 50 }) }))
      .toEqual({ key: limited, outcome: "unavailable", sent: false, reason: "synthetic: the limit was met, then the run stalled" });
    expect(home.ledger.tries(limited)).toBe(0);
    expect(home.ledger.resting(home.now()).get("fake")).toMatchObject({ until_ms: T0 + 20 * MINUTE, resets_ms: T0 + 20 * MINUTE, cause: "limit" });
    expect(await home.call(stalled, { route: home.route(stalled, { timeout_ms: 50 }), transport: () => home.transport({ delay_ms: 5_000 }) }))
      .toMatchObject({ outcome: "failed", sent: true, reason: "no reply within 50 ms" });
    expect(home.ledger.tries(stalled)).toBe(1);
    home.close();
    artifact("limit-then-stall", home.path);
  });

  it("a custom address on this machine is said to leave it, one on another machine is not, or it is sent audio", async () => {
    const leaves = (url: string) => named("address", { address: { url, input: ["text", "image"] } }).leaves;
    expect(["http://127.0.0.1:11434/v1", "http://localhost:8080/v1", "http://[::1]:1234/v1", "https://models.example.com/v1", "http://192.168.1.4:11434/v1"].map(leaves))
      .toEqual([null, null, null, "models.example.com", "192.168.1.4"]);
    const posts: { url: string; headers: unknown; body: unknown }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      posts.push({ url, headers: init.headers, body: JSON.parse(String(init.body)) });
      return Response.json({ choices: [{ message: { content: "a synthetic caption" } }], usage: { prompt_tokens: 9, completion_tokens: 3 } });
    }) as typeof fetch;
    const address = (secret?: string) => () => addressTransport({
      url: "http://127.0.0.1:11434/v1/", input: ["text", "image"], ...(secret === undefined ? {} : { secret }), held: () => true,
      key: () => (secret === undefined ? undefined : "synthetic-address-key"), fetch: fetcher,
    });
    const home = openHome(scratch(), { via: { "synthetic-local": "address" } });
    const local = { model: "synthetic-local", effort: "none", sampling: { temperature: 0 }, ...STREAM };
    const image = home.blobs.put(Buffer.from("synthetic jpeg bytes"));
    const audio = home.blobs.put(Buffer.from("synthetic m4a bytes"));
    const photo: RoutedAsk = { family: "photos", item: "photo:synthetic-x1", prompt: "caption", input: said("\n\nphoto x1"), identity: image.slice(7), attachments: [{ blob: image, media_type: "image/jpeg" }], ...local };
    const note: RoutedAsk = { family: "voice", item: "voice:synthetic-x2", prompt: "transcript", input: said(""), identity: audio.slice(7), attachments: [{ blob: audio, media_type: "audio/mp4" }], ...local };
    const [photoKey, noteKey] = [photo, note].map((ask) => (home.asker.request(ask) as { send: string }).send) as [string, string];
    expect(await home.call(photoKey, { transport: address("address") })).toMatchObject({ outcome: "replied", sent: true });
    expect(posts).toEqual([{
      url: "http://127.0.0.1:11434/v1/chat/completions",
      headers: { Authorization: "Bearer synthetic-address-key", "content-type": "application/json" },
      body: { model: "synthetic-local", temperature: 0, messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from("synthetic jpeg bytes").toString("base64")}` } },
        { type: "text", text: `${PROMPT}\n\nphoto x1` },
      ] }] },
    }]);
    expect(await home.call(noteKey, { transport: address() })).toMatchObject({ outcome: "failed", sent: true, reason: "the address takes images only, not audio/mp4" });
    expect(posts).toHaveLength(1);
    expect(await addressTransport({ url: "http://127.0.0.1:11434/v1", secret: "address", held: () => false, key: () => undefined }).available())
      .toEqual({ ok: false, reason: "no_key", detail: "the address's key address is not set" });
    expect(await address()().available()).toEqual({ ok: true });
    home.close();
    artifact("address", home.path);
  });

  it("two calls of one ask, requested under two models before either began, both send; a choice of another model for an answered ask is sent", async () => {
    let release = (): void => undefined;
    const gate = new Promise<string>((resolve) => { release = () => resolve("a synthetic caption"); });
    let began = false;
    let running: Promise<unknown> = Promise.resolve();
    onTestFinished(async () => {
      release();
      await Promise.allSettled([running]);
    });
    const home = openHome(scratch(), { fake: { reply: () => gate } });
    const stated = { family: "photos", item: "photo:synthetic-p1", prompt: "caption", input: said("\n\nphoto synthetic-p1"), ...STREAM };
    const [first, second] = [{ ...stated, ...LUNA }, { ...stated, ...NEW }].map((ask) => (home.asker.request(ask) as { send: string }).send) as [string, string];
    expect(first).not.toBe(second);
    running = home.call(first, { failpoint: (at) => { if (at === "sending") began = true; } });
    await until("the first call's attempt committed", () => began);
    const answering = () => home.transport({ reply: "a second caption" });
    expect(await home.call(second, { transport: answering })).toEqual({ key: second, outcome: "busy", sent: false, reason: `request ${second} asks what the call of ${first} in flight asks` });
    release();
    expect(await running).toMatchObject({ outcome: "replied", sent: true });
    expect(home.sends).toHaveLength(1);
    expect(home.asker.answer(stated)).toMatchObject({ reply: { key: first, text: "a synthetic caption" } });
    expect(await home.call(second, { transport: answering })).toMatchObject({ key: second, outcome: "replied", sent: true });
    expect(rows(home.path).attempts.map((row) => [row.key, row.state])).toEqual([[first, "replied"], [second, "replied"]]);
    home.close();
    artifact("one-call-per-ask", home.path);
  });

  it("an address that answers 404 gives up its items, one that redirects sends the request elsewhere, or its configured secret is not the key it sends", async () => {
    const reached: string[] = [];
    const elsewhere = createServer((request, response) => { reached.push(`${request.method} ${request.url}`); response.end("{}"); });
    const authorizations: (string | null)[] = [];
    const server = createServer((request: IncomingMessage, response) => {
      request.resume();
      if (request.url?.startsWith("/answers/") === true) {
        authorizations.push(request.headers.authorization ?? null);
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: "a synthetic caption" } }] }));
      } else if (request.url?.startsWith("/redirects/") === true) {
        response.writeHead(307, { location: `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}/v1/chat/completions` }).end();
      } else {
        response.writeHead(404).end("model not found");
      }
    });
    onTestFinished(async () => {
      for (const each of [server, elsewhere]) {
        each.closeAllConnections();
        await new Promise((resolve) => each.close(resolve));
      }
    });
    for (const each of [elsewhere, server]) {
      each.listen(0, "127.0.0.1");
      await once(each, "listening");
    }
    const base = (path: string) => `http://127.0.0.1:${(server.address() as AddressInfo).port}/${path}/v1`;
    const found: Found = {
      held: (name) => name === "synthetic-address-key",
      secret: (name) => (name === "synthetic-address-key" ? "synthetic-address-key-value" : undefined),
    };
    const home = openHome(scratch(), { via: { "synthetic-local": "address" } });
    const ask = (n: number): RoutedAsk => ({ family: "mail", item: `mail:synthetic-x${n}`, prompt: "tag", input: said(` mail synthetic-x${n}`), model: "synthetic-local", effort: "none", sampling: { temperature: 0 }, work: "mail", source: "synthetic:account-a:mail" });
    const keys = [1, 2, 3, 4].map((n) => (home.asker.request(ask(n)) as { send: string }).send) as [string, string, string, string];
    const block = (path: string, secret?: string): TransportSettings => ({ address: { url: base(path), ...(secret === undefined ? {} : { secret }) } });
    const call = (key: string, transports: TransportSettings) => home.call(key, { transports, found, transport: (name) => named(name, transports, found) });
    expect(transportSecret("address", block("answers", "synthetic-address-key"))).toBe("synthetic-address-key");
    expect(await call(keys[0], block("answers", "synthetic-address-key"))).toMatchObject({ outcome: "replied" });
    expect(await call(keys[1], block("answers"))).toMatchObject({ outcome: "replied" });
    expect(authorizations).toEqual(["Bearer synthetic-address-key-value", null]);
    expect(await call(keys[2], block("missing"))).toMatchObject({ outcome: "unavailable", sent: false, reason: "address answered HTTP 404" });
    expect(home.ledger.tries(keys[2])).toBe(0);
    expect(home.ledger.resting(home.now()).get("address")).toMatchObject({ cause: "provider", resets_ms: null });
    expect(await call(keys[3], block("redirects"))).toMatchObject({ outcome: "unavailable", sent: false });
    expect(reached).toEqual([]);
    expect(home.ledger.tries(keys[3])).toBe(0);
    home.close();
    artifact("address-http", home.path);
  });
});

describe("paying once: every call ends, and its end is heard", () => {
  const long = (cause: string) => `${"synthetic request words\n".repeat(4_300)}${cause}`;
  const mail = (name: string): RoutedAsk => ({ family: "mail", item: `mail:synthetic-${name}`, prompt: "tag", input: said(` mail synthetic-${name}`), ...MODEL_A });
  const requested = (home: Home, ask: RoutedAsk): string => {
    const request = home.asker.request(ask);
    if (!("send" in request) || request.send === null) throw new Error(`expected a send, found ${JSON.stringify(request)}`);
    return request.send;
  };
  const begin = (home: Home, key: string, transport = "fake"): AttemptRef => {
    const begun = home.ledger.beginAttempt(key, home.now(), transport);
    if (!("attempt" in begun)) throw new Error(`not begun: ${JSON.stringify(begun)}`);
    return begun.attempt;
  };
  const limited = (home: Home, reason = "synthetic: limited, no time"): Rest => ({ until_ms: home.now() + REST_MS, resets_ms: null, cause: "limit", reason });

  it("1, 2: a provider's failure leaves no row, or its end charges a try; a rest that fails to be written leaves the attempt ended, or deletes it", async () => {
    const root = scratch();
    const home = openHome(root);
    const ask = mail("p1");
    const key = requested(home, ask);
    const outage = home.transport({ fail: "unused" });
    const busy: Transport = { ...outage, send: async () => { throw new SendFailed("fake", "synthetic: the provider is busy", 503); } };
    expect(await home.call(key, { transport: () => busy })).toMatchObject({ outcome: "unavailable", sent: false });
    expect(rows(home.path).attempts.map((row) => [row.state, row.error, row.transport, row.finished !== null])).toEqual([["unknown", "synthetic: the provider is busy", "fake", true]]);
    expect(rows(home.path).outcomes.map((row) => row.state)).toEqual(["unknown"]);
    expect(home.ledger.resting(home.now()).get("fake")).toMatchObject({ cause: "provider", reason: "synthetic: the provider is busy" });
    expect(rows(home.path).unit_failures).toEqual([]);
    expect(home.asker.state(ask)).toEqual({ pending: "queued" });
    expect(home.ledger.next(key, home.now())).toEqual({ send: key });
    expect(home.ledger.outcomesAfter(0, 10).map((outcome) => [outcome.state, outcome.item])).toEqual([["unknown", ask.item]]);
    expect(home.ledger.answered("mail", ask.item, key)).toBe(true);

    const other = mail("p2");
    const otherKey = requested(home, other);
    home.advance(REST_MS);
    const db = new Database(home.path);
    db.exec(`CREATE TRIGGER refuse_rest BEFORE INSERT ON meta WHEN NEW.key LIKE 'rest:%'
      BEGIN SELECT RAISE(ABORT, 'synthetic disk error'); END`);
    await expect(home.call(otherKey, { transport: () => busy })).rejects.toThrow("synthetic disk error");
    db.exec("DROP TRIGGER refuse_rest");
    db.close();
    expect(rows(home.path).attempts.filter((row) => row.key === otherKey).map((row) => [row.state, row.error, row.finished])).toEqual([["sending", null, null]]);
    expect(rows(home.path).outcomes.map((row) => row.state)).toEqual(["unknown"]);
    expect(home.ledger.resting(home.now()).get("fake")).toBeUndefined();
    expect(home.ledger.reap(home.now())).toBe(1);
    expect(rows(home.path).attempts.filter((row) => row.key === otherKey).map((row) => row.state)).toEqual(["failed"]);
    expect(home.ledger.tries(otherKey)).toBe(1);
    home.close();
    artifact("provider-unknown", home.path);
  });

  it("3: a late fail after the attempt ended writes a second try, a late land on an ended-unknown attempt stands, or one on a failed attempt is lost", () => {
    const home = openHome(scratch());
    const key = requested(home, mail("l1"));
    const first = begin(home, key);
    expect(home.ledger.end(first, "fake", { until_ms: home.now() + REST_MS, resets_ms: null, cause: "provider", reason: "synthetic" }, home.now())).toBe(true);
    expect(home.ledger.end(first, "fake", { until_ms: home.now() + REST_MS, resets_ms: null, cause: "provider", reason: "synthetic" }, home.now())).toBe(false);
    expect(home.ledger.fail(first, "synthetic: late", home.now())).toBe(false);
    expect(home.ledger.land(first, { text: "late", model: MODEL_A.model, transport: "fake" }, home.now())).toBe(false);
    expect(home.ledger.tries(key)).toBe(0);
    const second = begin(home, key);
    expect(home.ledger.fail(second, "synthetic: judged dead", home.now())).toBe(true);
    expect(home.ledger.fail(second, "synthetic: judged dead again", home.now())).toBe(false);
    expect(home.ledger.tries(key)).toBe(1);
    expect(home.ledger.land(second, { text: "a synthetic tag, late", model: MODEL_A.model, transport: "fake" }, home.now())).toBe(true);
    expect(home.ledger.standing(key)?.text).toBe("a synthetic tag, late");
    expect(home.ledger.land(second, { text: "again", model: MODEL_A.model, transport: "fake" }, home.now())).toBe(false);
    expect(rows(home.path).outcomes.map((row) => row.state)).toEqual(["unknown", "failed", "replied"]);
    expect(home.ledger.tries(key)).toBe(1);
    home.close();
  });

  it("5: a live call is judged dead however long its clock moves, or a second call of its key sends", async () => {
    const root = scratch();
    const home = openHome(root);
    const key = requested(home, mail("d1"));
    let answer!: (text: string) => void;
    let sending!: () => void;
    const sent = new Promise<void>((resolve) => { sending = resolve; });
    const slow = home.transport({ reply: () => { sending(); return new Promise<string>((resolve) => { answer = resolve; }); } });
    const running = home.call(key, { transport: () => slow });
    await sent;
    home.advance(DAY_MS);
    expect(home.ledger.reap(home.now())).toBe(0);
    expect(await home.call(key)).toMatchObject({ outcome: "busy", sent: false, reason: "another call of this request runs" });
    expect(home.ledger.reapQuiet(home.now())).toBeNull();
    answer("a synthetic tag");
    expect(await running).toMatchObject({ outcome: "replied", sent: true });
    expect(home.ledger.reap(home.now())).toBe(0);
    expect(rows(home.path).outcomes.map((row) => row.state)).toEqual(["replied"]);
    expect(home.ledger.tries(key)).toBe(0);
    home.close();
  });

  it("6, 7: a call's lock file stays after its end; a held lock is never reaped, while the call lands too, and is once let go; no quiet sweep while a call holds calls.lock", async () => {
    const root = scratch();
    const home = openHome(root);
    const key = requested(home, mail("r1"));
    let reapedWhileLanding = -1;
    expect(await home.call(key, { failpoint: (at) => { if (at === "sent") reapedWhileLanding = home.ledger.reap(home.now()); } })).toMatchObject({ outcome: "replied" });
    expect(reapedWhileLanding).toBe(0);
    expect(home.ledger.reap(home.now())).toBe(0);
    expect(rows(home.path).outcomes.map((row) => row.state)).toEqual(["replied"]);
    const file = callLock(openHomeFolder(dirname(dirname(home.path))), key);
    expect(existsSync(file)).toBe(true);
    const other = requested(home, mail("r2"));
    const late = tryLock(callLock(openHomeFolder(dirname(dirname(home.path))), other))!;
    begin(home, other);
    expect(home.ledger.reap(home.now())).toBe(0);
    const shared = trySharedLock(callsLock(home.path))!;
    expect(home.ledger.reapQuiet(home.now())).toBeNull();
    expect(existsSync(file)).toBe(true);
    shared.release();
    late.release();
    expect(home.ledger.reap(home.now())).toBe(1);
    expect(existsSync(callLock(openHomeFolder(dirname(dirname(home.path))), other))).toBe(true);
    home.close();
  });

  it("7: a reap that selected an attempt which then ended before the reap's write writes nothing over its end (the `stillSending` re-check)", () => {
    const home = openHome(scratch());
    const [first, second] = ["e1", "e2"].map((name) => requested(home, mail(name))) as [string, string];
    const [a, b] = [begin(home, first), begin(home, second)];
    const db = new Database(home.path);
    db.exec(`CREATE TRIGGER lands_second AFTER UPDATE OF state ON attempts WHEN NEW.id = ${a.id} AND NEW.state = 'failed'
      BEGIN UPDATE attempts SET state = 'replied', finished = NEW.finished WHERE id = ${b.id}; END`);
    expect(home.ledger.reap(home.now())).toBe(1);
    db.exec("DROP TRIGGER lands_second");
    db.close();
    expect(rows(home.path).attempts.map((row) => [row.key, row.state, row.error])).toEqual([[first, "failed", "the call process died with no outcome"], [second, "replied", null]]);
    expect([home.ledger.tries(first), home.ledger.tries(second)]).toEqual([1, 0]);
    expect(rows(home.path).outcomes.map((row) => row.state)).toEqual(["failed"]);
    home.close();
  });

  it("8: a start with no call running leaves a call sending or its lock files, or one with a call running ends one; the tick leaves a call with no lock file in flight; a sending attempt whose request is gone stops the start", async () => {
    const root = scratch();
    const home = openHome(root);
    const keys = ["s1", "s2"].map((name) => requested(home, mail(name)));
    for (const key of keys) begin(home, key);
    expect(await home.call(requested(home, mail("s3")))).toMatchObject({ outcome: "replied" });
    const calls = join(root, "replies", "calls");
    expect(existsSync(calls)).toBe(true);
    const shared = trySharedLock(callsLock(home.path))!;
    expect(home.ledger.reapQuiet(home.now())).toBeNull();
    expect(home.ledger.inFlight()).toHaveLength(2);
    expect(existsSync(calls)).toBe(true);
    shared.release();
    expect(home.ledger.reapQuiet(home.now())).toBe(2);
    expect(home.ledger.inFlight()).toEqual([]);
    expect(keys.map((key) => home.ledger.tries(key))).toEqual([1, 1]);
    expect(rows(home.path).outcomes.map((row) => row.state)).toEqual(["replied", "failed", "failed"]);
    expect(existsSync(calls)).toBe(false);
    expect(home.ledger.reapQuiet(home.now())).toBe(0);
    const orphan = requested(home, mail("s4"));
    begin(home, orphan);
    expect(home.ledger.reap(home.now())).toBe(1);
    expect(home.ledger.tries(orphan)).toBe(1);
    expect(existsSync(callLock(openHomeFolder(dirname(dirname(home.path))), orphan))).toBe(false);
    expect(home.ledger.reap(home.now())).toBe(0);
    const lost = requested(home, mail("s5"));
    begin(home, lost);
    const db = new Database(home.path);
    db.prepare("DELETE FROM requests WHERE key = ?").run(lost);
    db.close();
    const failures = rows(home.path).unit_failures.length;
    expect(home.ledger.reapQuiet(home.now())).toBe(1);
    expect(home.ledger.inFlight()).toEqual([]);
    expect(rows(home.path).attempts.filter((row) => row.key === lost).map((row) => row.state)).toEqual(["failed"]);
    expect(rows(home.path).unit_failures).toHaveLength(failures);
    expect(home.ledger.outcomesAfter(0, 100).map((outcome) => outcome.key)).not.toContain(lost);
    home.close();
  });

  it("10: a hung conversion holds the request for ever or sends after its budget; a reply prepared after the timer fired lands, or one past its last check is lost", async () => {
    const root = scratch();
    const home = openHome(root);
    const photo = (name: string): RoutedAsk => {
      const heic = home.blobs.put(Buffer.from(`synthetic heic bytes ${name}`));
      return { family: "photos", item: `photo:synthetic-${name}`, prompt: "caption", input: said(`\n\nphoto ${name}`), ...LUNA, attachments: [{ blob: heic, media_type: "image/heic" }], identity: heic.slice(7) };
    };
    const hung: Converter = (_input, _output, _type, signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("synthetic: the converter was killed")), { once: true });
    });
    const key = requested(home, photo("hung"));
    expect(await home.call(key, { convert: hung, route: home.route(key, { timeout_ms: 20 }) })).toMatchObject({ outcome: "failed", reason: "no reply within 20 ms" });
    expect(home.sends).toEqual([]);
    expect(rows(home.path).attempts.map((row) => [row.state, row.error])).toEqual([["failed", "no reply within 20 ms"]]);
    const deaf: Converter = (_input, _output, _type, signal) => new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }); });
    const second = requested(home, photo("deaf"));
    let sends = 0;
    const counting: Transport = { ...home.transport(), send: async () => { sends++; return { text: "a synthetic caption", model: LUNA.model }; } };
    expect(await home.call(second, { convert: deaf, transport: () => counting, route: home.route(second, { timeout_ms: 20 }) })).toMatchObject({ outcome: "failed", reason: "no reply within 20 ms" });
    expect(sends).toBe(0);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => { vi.useRealTimers(); });
    let signal: AbortSignal | undefined;
    const answering = (fire: boolean): Transport => ({ ...home.transport(), send: async (request) => {
      signal = request.signal;
      if (fire) vi.advanceTimersByTime(home.route(key).timeout_ms);
      return { text: "a synthetic tag", model: MODEL_A.model };
    } });
    const late = requested(home, mail("late"));
    expect(await home.call(late, { transport: () => answering(true) })).toMatchObject({ outcome: "failed", sent: true, reason: "no reply within 120000 ms" });
    expect(signal?.aborted).toBe(true);
    expect(home.ledger.standing(late)).toBeUndefined();
    expect(rows(home.path).attempts.filter((row) => row.key === late).map((row) => row.state)).toEqual(["failed"]);
    const landing = requested(home, mail("landing"));
    let firedBeforeLand = false;
    const fire = (at: string) => {
      if (at !== "sent") return;
      vi.advanceTimersByTime(home.route(landing).timeout_ms);
      firedBeforeLand = signal?.aborted === true;
    };
    expect(await home.call(landing, { transport: () => answering(false), failpoint: fire })).toMatchObject({ outcome: "replied", sent: true });
    expect(firedBeforeLand).toBe(true);
    expect(home.ledger.standing(landing)?.text).toBe("a synthetic tag");
    home.close();
  });

  it("5: a call's finally throws before it closes the ledger, or lets go of its locks with the ledger open", async () => {
    const root = scratch();
    const home = openHome(root);
    const key = requested(home, mail("drop"));
    const copy = home.copy(key, "OpenRouter");
    const route = home.route(key);
    const db = new Database(home.path);
    db.exec(`CREATE TRIGGER refuse_drop BEFORE DELETE ON sent_copies BEGIN SELECT RAISE(ABORT, 'synthetic disk error'); END`);
    db.close();
    home.close();
    expect(existsSync(`${home.path}-wal`)).toBe(false);
    await expect(runCall({ folder: openHomeFolder(dirname(dirname(home.path))), key, route, transports: home.settings.transports, copies: join(dirname(home.path), "calls"), sentCopy: copy })).rejects.toThrow("synthetic disk error");
    expect(existsSync(`${home.path}-wal`)).toBe(false);
    const own = tryLock(callLock(openHomeFolder(dirname(dirname(home.path))), key));
    const calls = tryLock(callsLock(home.path));
    expect([own !== null, calls !== null]).toEqual([true, true]);
    own?.release();
    calls?.release();
    const after = new Database(home.path);
    after.exec("DROP TRIGGER refuse_drop");
    expect(after.prepare("SELECT state FROM attempts WHERE key = ?").pluck().all(key)).toEqual(["replied"]);
    after.close();
  });

  it("11: a long reason reaches a file whole, or a line a call prints states no time", async () => {
    const root = scratch();
    const home = openHome(root);
    const bounded = (text: unknown) => {
      expect(typeof text).toBe("string");
      expect([...String(text)].length).toBeLessThanOrEqual(300);
      expect(String(text)).not.toContain("\n");
    };
    const provider = requested(home, mail("w1"));
    const outage: Transport = { ...home.transport(), send: async () => { throw new SendFailed("fake", long("the provider's cause"), 503); } };
    const ended = await home.call(provider, { transport: () => outage });
    bounded(ended.reason);
    const unknown = rows(home.path).attempts.at(-1)!;
    bounded(unknown.error);
    expect(String(unknown.error)).toMatch(/^….*request words the provider's cause$/u);
    const rest = home.ledger.resting(home.now()).get("fake")!;
    bounded(rest.reason);
    expect(rest.reason.endsWith("the provider's cause")).toBe(true);
    home.advance(REST_MS);
    const own = requested(home, mail("w2"));
    const child = (key: string, transports: TransportSettings) => spawnSync(process.execPath, [...CALL_CMD, "--root", root, "--route", JSON.stringify(home.route(key)),
      "--transports", JSON.stringify(transports), ...homeAt(join(root, "machine")), "--key", key], { encoding: "utf8", input: handed(root) });
    const failed = child(own, { fake: { fail: long("the request's cause") } });
    expect(failed.status).toBe(1);
    const line = JSON.parse(failed.stdout) as Record<string, unknown>;
    expect(line).toMatchObject({ at: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/u), outcome: "failed" });
    bounded(line.reason);
    expect(String(line.reason).endsWith("the request's cause")).toBe(true);
    bounded(rows(home.path).attempts.at(-1)!.error);
    bounded(rows(home.path).unit_failures.at(-1)!.reason);
    const thrown = requested(home, mail("w3"));
    const db = new Database(home.path);
    db.exec(`CREATE TRIGGER refuse_replied BEFORE UPDATE OF state ON attempts WHEN NEW.state = 'replied'
      BEGIN SELECT RAISE(ABORT, '${long("the disk cause")}'); END`);
    const threw = child(thrown, { fake: {} });
    db.exec("DROP TRIGGER refuse_replied");
    db.close();
    expect({ status: threw.status, stdout: threw.stdout }).toEqual({ status: 1, stdout: "" });
    const error = JSON.parse(threw.stderr) as Record<string, unknown>;
    expect(error).toMatchObject({ at: expect.any(String), key: thrown, exit: 1 });
    bounded(error.error);
    expect(String(error.error).endsWith("the disk cause")).toBe(true);
    const refused = spawnSync(process.execPath, [...CALL_CMD, "--root", root, "--key", "no key"], { encoding: "utf8", input: "" });
    expect(refused.status).toBe(64);
    expect(JSON.parse(refused.stderr)).toMatchObject({ at: expect.any(String), exit: 64, error: expect.stringMatching(/usage: call-main\.ts/u) });
    home.close();
  });

  it("12: a limit with no time rests five minutes for ever, two calls in one rest double it, a reply between rests is ignored, or the hour's cap or a stated reset is lost", () => {
    const home = openHome(scratch());
    const key = requested(home, mail("n1"));
    const until = () => home.ledger.resting(home.now()).get("fake")?.until_ms;
    const meet = (rest = limited(home)) => expect(home.ledger.end(begin(home, key), "fake", rest, home.now())).toBe(true);
    meet();
    const first = home.now() + REST_MS;
    home.advance(MINUTE);
    meet(limited(home, "synthetic: the second"));
    expect(until()).toBe(first);
    expect(home.ledger.resting(home.now()).get("fake")?.reason).toBe("synthetic: limited, no time");
    home.advance(first - home.now());
    for (const minutes of [10, 20, 40, 60, 60]) {
      meet();
      expect(until()).toBe(home.now() + minutes * MINUTE);
      home.advance(minutes * MINUTE);
    }
    const answered = requested(home, mail("n2"));
    expect(home.ledger.land(begin(home, answered), { text: "a synthetic tag", model: MODEL_A.model, transport: "fake" }, home.now())).toBe(true);
    meet();
    expect(until()).toBe(home.now() + REST_MS);
    home.advance(REST_MS);
    meet({ ...limited(home, "synthetic: limited for twenty minutes"), until_ms: home.now() + 20 * MINUTE, resets_ms: home.now() + 20 * MINUTE });
    expect(until()).toBe(home.now() + 20 * MINUTE);
    home.advance(20 * MINUTE);
    meet();
    expect(until()).toBe(home.now() + REST_MS);
    expect(home.ledger.tries(key)).toBe(0);
    home.close();
  });

  it("12: a no-reset limit doubles from the last write of its rest, missing a reply that landed inside it", () => {
    const home = openHome(scratch());
    const key = requested(home, mail("t1"));
    const until = () => home.ledger.resting(home.now()).get("fake")?.until_ms;
    const from = home.now();
    expect(home.ledger.end(begin(home, key), "fake", { ...limited(home), until_ms: from + 20 * MINUTE }, home.now())).toBe(true);
    expect(until()).toBe(from + 20 * MINUTE);
    home.advance(MINUTE);
    const answered = requested(home, mail("t2"));
    expect(home.ledger.land(begin(home, answered), { text: "a synthetic tag", model: MODEL_A.model, transport: "fake" }, home.now())).toBe(true);
    home.advance(MINUTE);
    expect(home.ledger.end(begin(home, key), "fake", { until_ms: home.now() + REST_MS, resets_ms: null, cause: "provider", reason: "synthetic: the provider is busy" }, home.now())).toBe(true);
    expect(until()).toBe(from + 20 * MINUTE);
    home.advance(from + 20 * MINUTE - home.now());
    expect(home.ledger.end(begin(home, key), "fake", limited(home), home.now())).toBe(true);
    expect(until()).toBe(home.now() + REST_MS);
    home.close();
  });

  it("11: a refusal's long reason, or a rest's kept from a release that bounded none, reaches a file or status whole", () => {
    const home = openHome(scratch());
    const ask = mail("b1");
    const key = requested(home, ask);
    const oneLine = (text: string, tail: string) => {
      expect([...text].length).toBeLessThanOrEqual(300);
      expect(text).not.toContain("\n");
      expect(text.endsWith(tail)).toBe(true);
    };
    expect(home.ledger.land(begin(home, key), { text: "a synthetic tag", model: MODEL_A.model, transport: "fake" }, home.now())).toBe(true);
    expect(home.ledger.refuse(key, { family: "mail", unit: ask.item }, long("the refusal's cause"), home.now())).toBe(true);
    oneLine(String(rows(home.path).unit_failures.at(-1)!.reason), "the refusal's cause");
    const db = new Database(home.path);
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('rest:fake', ?)")
      .run(JSON.stringify({ until_ms: home.now() + 50 * MINUTE, resets_ms: null, cause: "provider", reason: long("the old cause") }));
    home.ledger.rest("fake", { until_ms: home.now() + REST_MS, resets_ms: null, cause: "provider", reason: "synthetic: the new cause" }, home.now());
    const stored = JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'rest:fake'").pluck().get() as string) as Rest;
    db.close();
    expect(stored.until_ms).toBe(home.now() + 50 * MINUTE);
    oneLine(stored.reason, "the old cause");
    oneLine(home.ledger.resting(home.now()).get("fake")!.reason, "the old cause");
    home.close();
  });
});

describe("an erasure: no call lives, no call's copy is left, the ledger's forget", () => {
  const mail = (name: string): RoutedAsk => ({ family: "mail", item: `mail:synthetic-${name}`, prompt: "tag", input: said(` mail synthetic-${name}`), ...MODEL_A });
  const requested = (home: Home, ask: RoutedAsk): string => {
    const request = home.asker.request(ask);
    if (!("send" in request) || request.send === null) throw new Error(`expected a send, found ${JSON.stringify(request)}`);
    return request.send;
  };

  it("a keyed home's killed call leaves its copies only in its own work, which the reap empties and no other job's, named by no hash, and a later call of the key sends", async () => {
    const root = scratch();
    const machineDir = testMachine();
    const folder = keyedFolder(root, machineDir);
    const ledger = openLedger(folder, { mode: "migrate" });
    const blobs = memoryBlobs();
    const asker = openAsker({ ledger, prompt: (name) => PROMPTS[name]!, blobs, clock: () => T0 });
    const image = blobs.put(Buffer.from("synthetic jpeg bytes"));
    const ask: RoutedAsk = {
      family: "photos", item: "photo:synthetic-scratch", prompt: "caption", input: said("\n\nphoto synthetic-scratch"), ...LUNA,
      attachments: [{ blob: image, media_type: "image/jpeg" }], identity: image.slice("sha256:".length),
    };
    const key = (asker.request(ask) as { send: string }).send;
    const work = join(machineDir, "scratch");
    const jobs = () => ["home", "call"].flatMap((program) => (existsSync(join(work, program)) ? readdirSync(join(work, program)).map((name) => join(program, name)) : []));
    const killed = spawnSync(process.execPath, [...CALL_CMD, "--root", root, "--route", JSON.stringify({ transport: "fake", timeout_ms: 30_000 }),
      "--transports", JSON.stringify({ fake: { cost_usd: 0 } }), ...homeAt(machineDir), "--key", key], {
      encoding: "utf8", input: `{}\n${JSON.stringify(folder.handOver(["store:ledger", "files", "names"], "call"))}`, env: { ...process.env, LIFESTREAM_CALL_FAILPOINT: "copied" },
    });
    expect(killed.signal).toBe("SIGKILL");
    expect(jobs()).toEqual([expect.stringMatching(/^call\/call-/u)]);
    expect(readdirSync(join(work, jobs()[0]!))).toEqual(["attachment-0.jpg"]);
    expect(readdirSync(join(root, "replies", "calls")).some((name) => name.includes(key.slice("sha256:".length)))).toBe(false);
    const read = folder.work("read");
    writeFileSync(join(read.path, "copy.jpg"), "synthetic copy of a read");
    expect(ledger.reapQuiet(T0)).toBe(1);
    expect(existsSync(join(root, "replies", "calls"))).toBe(false);
    expect(jobs()).toEqual([join("home", basename(read.path))]);
    read.empty();
    expect(existsSync(join(machineDir, "calls"))).toBe(false);
    let copied: string[] = [];
    expect(await runCall({
      folder, key, route: { transport: "fake", timeout_ms: 30_000 }, copies: join(machineDir, "calls", "home-test"), clock: () => T0 + 30 * MINUTE, blobs, transport: () => fakeTransport({ reply: "a synthetic caption" }),
      failpoint: (at) => { if (at === "copied") copied = jobs().flatMap((job) => readdirSync(join(work, job))); },
    })).toMatchObject({ outcome: "replied", sent: true });
    expect(copied).toEqual(["attachment-0.jpg"]);
    expect(jobs()).toEqual([]);
    ledger.close();
  });

  it("a plain home's killed call leaves its copies at <machine>/calls/<home id>/<request key>/, which the reap empties, and a later call of the key sends", async () => {
    const root = scratch();
    const machineDir = scratch();
    const folder = openHomeFolder(root);
    const ledger = openLedger(folder, { mode: "migrate" });
    const blobs = memoryBlobs();
    const asker = openAsker({ ledger, prompt: (name) => PROMPTS[name]!, blobs, clock: () => T0 });
    const image = blobs.put(Buffer.from("synthetic jpeg bytes"));
    const ask: RoutedAsk = {
      family: "photos", item: "photo:synthetic-plain-copies", prompt: "caption", input: said("\n\nphoto synthetic-plain-copies"), ...LUNA,
      attachments: [{ blob: image, media_type: "image/jpeg" }], identity: image.slice("sha256:".length),
    };
    const key = (asker.request(ask) as { send: string }).send;
    const copies = callCopiesOf(machineDir, "home-test");
    const own = join(copies, key.slice("sha256:".length));
    const killed = spawnSync(process.execPath, [...CALL_CMD, "--root", root, "--route", JSON.stringify({ transport: "fake", timeout_ms: 30_000 }),
      "--transports", JSON.stringify({ fake: { cost_usd: 0 } }), ...homeAt(machineDir), "--key", key], {
      encoding: "utf8", input: handed(root), env: { ...process.env, LIFESTREAM_CALL_FAILPOINT: "copied" },
    });
    expect(killed.signal).toBe("SIGKILL");
    expect(readdirSync(own)).toEqual(["attachment-0.jpg"]);
    expect(readFileSync(join(own, "attachment-0.jpg"), "utf8")).toBe("synthetic jpeg bytes");
    expect(readdirSync(join(root, "replies", "calls")).filter((name) => name.endsWith(".lock"))).toEqual([`${key.slice("sha256:".length)}.lock`]);
    expect(ledger.reapQuiet(T0, copies)).toBe(1);
    expect(existsSync(copies)).toBe(false);
    let copied: string[] = [];
    expect(await runCall({
      folder, key, route: { transport: "fake", timeout_ms: 30_000 }, copies, clock: () => T0 + 30 * MINUTE, blobs, transport: () => fakeTransport({ reply: "a synthetic caption" }),
      failpoint: (at) => { if (at === "copied") copied = readdirSync(own); },
    })).toMatchObject({ outcome: "replied", sent: true });
    expect(copied).toEqual(["attachment-0.jpg"]);
    expect(readdirSync(copies)).toEqual([]);
    ledger.close();
  });

  it("the erasure's wait for calls.lock goes on without it, says nothing or says it twice, outlives its limit or its signal, or a call sends while it holds the lock", async () => {
    const root = scratch();
    const home = openHome(root);
    const key = requested(home, mail("barrier"));
    const call = trySharedLock(callsLock(home.path))!;
    const said: string[] = [];
    await expect(holdCalls(home.path, { limit_ms: 50, waiting: () => said.push("waiting for model calls to end") })).rejects.toThrow("a model call did not end");
    expect(said).toEqual(["waiting for model calls to end"]);
    const stop = new AbortController();
    await expect(holdCalls(home.path, { signal: stop.signal, waiting: () => stop.abort(new Error("synthetic stop")) })).rejects.toThrow("synthetic stop");
    said.length = 0;
    const holding = holdCalls(home.path, { waiting: () => said.push("waiting for model calls to end") });
    expect(said).toEqual(["waiting for model calls to end"]);
    call.release();
    const barrier = await holding;
    expect(said).toEqual(["waiting for model calls to end"]);
    expect(await home.call(key)).toMatchObject({ outcome: "busy", sent: false });
    expect(home.sends).toEqual([]);
    expect(rows(home.path).attempts).toEqual([]);
    barrier.release();
    expect(await home.call(key)).toMatchObject({ outcome: "replied", sent: true });
    home.close();
  });

  it("a forget leaves a removed request's outcome, or takes another request's; its log stays when nothing reads it, or is emptied under a reader", async () => {
    const root = scratch();
    const home = openHome(root);
    const keys = ["f1", "f2", "f3"].map((name) => requested(home, mail(name)));
    for (const key of keys) expect(await home.call(key)).toMatchObject({ outcome: "replied" });
    expect(rows(home.path).outcomes.map((row) => row.key)).toEqual(keys);
    expect(home.ledger.forget(["mail:synthetic-f1", "mail:synthetic-f2"])).toMatchObject({ requests: 2, replies: 2, attempts: 2 });
    expect(rows(home.path).outcomes.map((row) => row.key)).toEqual([keys[2]]);
    const reader = new Database(home.path, { readonly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM requests").get();
    expect(home.ledger.truncateLog(0)).toBe(false);
    reader.exec("COMMIT");
    reader.close();
    expect(home.ledger.truncateLog(1_000)).toBe(true);
    expect(readFileSync(`${home.path}-wal`).length).toBe(0);
    home.close();
  });
});

describe("prompt versions", () => {
  const photo = (n: number): RoutedAsk => ({ family: "photos", item: `photo:synthetic-v${n}`, prompt: "caption", input: said(""), identity: { photo: String(n).repeat(64) }, ...LUNA });
  const mail = (n: number): RoutedAsk => ({ family: "mail", item: `mail:synthetic-v${n}`, prompt: "tag", input: said(`\n\nsynthetic mail v${n}`), ...LUNA });
  const note = (n: number): RoutedAsk => ({ family: "notes", item: `note:synthetic-v${n}`, prompt: "summary", input: said(`\n\nsynthetic note v${n}`), ...LUNA });
  const edited = (prompt: Prompt): Prompt => ({ ...prompt, text: `${prompt.text} Said in better words.` });
  const WIDER = { ...SUMMARY, properties: { ...SUMMARY.properties, mood: { type: ["string", "null"] } }, required: [...SUMMARY.required, "mood"] };

  it("an edit to a prompt's text asks again an ask with an identity or one with none", async () => {
    const home = openHome(scratch(), { fake: { reply: (request) => `an answer to ${request.input.length} characters` } });
    await home.drain([photo(1), mail(1)]);
    const before = { photo: home.asker.state(photo(1)), mail: home.asker.state(mail(1)), requests: rows(home.path).requests };
    home.prompts.caption = edited(home.prompts.caption!);
    home.prompts.tag = edited(home.prompts.tag!);
    expect(home.asker.known(mail(1))).toEqual({ prompt: "tag", version: 1, input_hash: inputHash(piecesText(mail(1).input)) });
    expect(home.asker.state(photo(1))).toEqual(before.photo);
    expect(home.asker.state(mail(1))).toEqual(before.mail);
    await home.drain([photo(1), mail(1)]);
    expect(rows(home.path).requests).toEqual(before.requests);
    expect(home.sends).toHaveLength(2);
    await home.drain([mail(2)]);
    expect(home.sends.at(-1)!.input).toBe(`${home.prompts.tag!.text}${piecesText(mail(2).input)}`);
    expect([home.ledger.row(home.asker.key(mail(1)))!.prompt_hash, home.ledger.row(home.asker.key(mail(2)))!.prompt_hash])
      .toEqual([promptHash(PROMPTS.tag!.text), promptHash(home.prompts.tag!.text)]);
    home.close();
    artifact("text-edit", home.path);
  });

  it("a retry after a text edit opens a new chain, under a key the edit moved", async () => {
    let answer = 0;
    const home = openHome(scratch(), { fake: { reply: () => `synthetic tag ${++answer}` } });
    const ask = mail(3);
    await home.drain([ask]);
    const refused = home.asker.state(ask) as Candidate;
    home.asker.refuse(ask, refused, "a synthetic refusal");
    const retry = requestKey({ model: ask.model, prompt: "tag", version: 1, input_hash: retryIdentity(home.asker.known(ask).input_hash, refused.reply.text), effort: ask.effort });
    home.prompts.tag = edited(home.prompts.tag!);
    expect(home.asker.request(ask)).toMatchObject({ send: retry });
    expect(home.ledger.chain(home.asker.key(ask)).map((row) => row.key)).toEqual([home.asker.key(ask), retry]);
    expect(await home.call(retry)).toMatchObject({ outcome: "replied", sent: true });
    expect(home.asker.state(ask)).toMatchObject({ reply: { key: retry, text: "synthetic tag 2" } });
    home.close();
    artifact("retry-after-edit", home.path);
  });

  it("a text edit or a nullable member added reopens a given-up item, or a written request is sent with the new text or never", async () => {
    const home = openHome(scratch(), { fake: { fail: "synthetic HTTP 400" } });
    const [lost, shapeLost] = [mail(4), note(4)];
    for (let send = 0; send < 3; send++) {
      await home.drain([lost, shapeLost]);
      home.advance(30 * MINUTE);
    }
    expect([home.asker.state(lost), home.asker.state(shapeLost)]).toEqual([{ givenUp: true, tries: 3 }, { givenUp: true, tries: 3 }]);
    const [waiting, shapeWaiting] = [mail(5), note(5)];
    const written = [waiting, shapeWaiting].map((ask) => (home.asker.request(ask) as { send: string }).send);
    const bodies = written.map((key) => home.ledger.row(key)!.body);
    home.prompts.tag = edited(home.prompts.tag!);
    home.prompts.summary = { ...edited(home.prompts.summary!), type: WIDER };
    expect([home.asker.state(lost), home.asker.state(shapeLost)]).toEqual([{ givenUp: true, tries: 3 }, { givenUp: true, tries: 3 }]);
    expect([waiting, shapeWaiting].map((ask) => (home.asker.request(ask) as { send: string }).send)).toEqual(written);
    const sent = home.sends.length;
    const reply = (text: string) => home.transport({ reply: text });
    expect(await home.call(written[0]!, { transport: () => reply("a synthetic tag") })).toMatchObject({ outcome: "replied", sent: true });
    expect(await home.call(written[1]!, { transport: () => reply('{"summary":"a synthetic summary"}') })).toMatchObject({ outcome: "replied", sent: true });
    expect(home.sends.slice(sent).map((each) => each.input)).toEqual(bodies);
    expect(bodies.map((body) => body.startsWith(PROMPTS.tag!.text) || body.startsWith(PROMPTS.summary!.text))).toEqual([true, true]);
    expect(home.sends.at(-1)!.schema).toBe(canonical(SUMMARY));
    expect(home.asker.state(shapeWaiting)).toMatchObject({ reply: { value: { summary: "a synthetic summary", mood: null } } });
    home.close();
    artifact("edit-keeps-requests", home.path);
  });

  it("a bump that keeps an older version loses its answers, reads them without the converter, writes a request, or asks a new item under the old version", async () => {
    let answer = 0;
    const home = openHome(scratch(), { fake: { reply: (request) => (request.schema === undefined ? `caption ${++answer}` : `{"summary":"summary ${++answer}"}`) } });
    await home.drain([photo(6)]);
    const v1 = home.asker.state(photo(6)) as Candidate;
    const requests = rows(home.path).requests;
    home.prompts.caption = {
      version: 2, type: SUMMARY, keeps: [{ version: 1, type: "text" }], text: "Summarise this synthetic photo.",
      converters: { 1: (caption) => ({ summary: `${String(caption)}, converted` }) },
    };
    expect(home.asker.state(photo(6))).toEqual({ reply: { ...v1.reply, value: { summary: "caption 1, converted" }, version: 1 } });
    expect(home.asker.request(photo(6))).toEqual(home.asker.state(photo(6)));
    expect(rows(home.path).requests).toEqual(requests);
    await home.drain([photo(7)]);
    expect(home.ledger.row(home.asker.key(photo(7)))).toMatchObject({ body: `Summarise this synthetic photo.${piecesText(photo(7).input)}` });
    expect(home.asker.state(photo(7))).toMatchObject({ reply: { value: { summary: "summary 2" }, version: 2 } });
    expect(home.ledger.promptTypes().map(({ name, version, type }) => [name, version, type])).toEqual([["caption", 1, "text"], ["caption", 2, SUMMARY]]);

    home.prompts.caption = PROMPTS.caption!;
    home.advance(HOUR);
    await home.drain([{ ...photo(7), ...NEW }]);
    expect(home.asker.answer(photo(7), { model: NEW.model })).toMatchObject({ reply: { model: NEW.model, version: 1, at_ms: T0 + HOUR } });
    home.prompts.caption = { version: 2, type: SUMMARY, keeps: [{ version: 1, type: "text" }], text: "Summarise this synthetic photo.", converters: { 1: (caption) => ({ summary: String(caption) }) } };
    expect(home.asker.answer(photo(7))).toMatchObject({ reply: { version: 2, at_ms: T0 } });
    home.prompts.caption = { version: 3, type: SUMMARY, keeps: [], text: "Summarise this synthetic photo." };
    expect(home.asker.state(photo(6))).toEqual({ pending: "unasked" });
    home.close();
    artifact("bump-keeps", home.path);
  });

  it("a nullable member added breaks an old answer, or moves its key", async () => {
    const home = openHome(scratch(), { fake: { reply: '{"summary":"a synthetic summary"}' } });
    await home.drain([note(9)]);
    const key = home.asker.key(note(9));
    home.prompts.summary = { ...home.prompts.summary!, type: WIDER };
    expect(home.asker.key(note(9))).toBe(key);
    expect(home.asker.state(note(9))).toMatchObject({ reply: { key, value: { summary: "a synthetic summary", mood: null }, version: 1 } });
    await home.drain([note(9)]);
    expect(home.sends).toHaveLength(1);
    home.close();
  });

  it("a converter's bad output is taken as an answer, or refused in the ledger", async () => {
    const home = openHome(scratch(), { fake: { reply: (request) => (request.schema === undefined ? "a synthetic caption" : '{"summary":"asked again"}') } });
    await home.drain([photo(11)]);
    const v1 = home.asker.state(photo(11)) as Candidate;
    home.asker.accept(v1.reply);
    home.prompts.caption = { version: 2, type: SUMMARY, keeps: [{ version: 1, type: "text" }], text: "Summarise this synthetic photo.", converters: { 1: (caption) => ({ text: caption }) } };
    expect(home.asker.state(photo(11))).toEqual({ pending: "unasked" });
    expect(home.ledger.reply(v1.reply.key)).toMatchObject({ validation: "accepted" });
    expect(home.ledger.tries(v1.reply.key)).toBe(0);
    await home.drain([photo(11)]);
    expect(home.asker.state(photo(11))).toMatchObject({ reply: { value: { summary: "asked again" }, version: 2 } });
    home.prompts.caption = { ...home.prompts.caption, converters: { 1: (caption) => ({ summary: String(caption) }) } };
    expect(home.ledger.found("caption", home.asker.known(photo(11)).input_hash, [1])).toMatchObject([{ key: v1.reply.key, validation: "accepted" }]);
    home.close();
    artifact("converter-bad", home.path);
  });

  it("a wrong-shaped new reply reaches the family, is refused more than once, or its retry does not say why; an extra member is refused", async () => {
    const replies = ['{"summary": 3}', '{"summary":"a synthetic summary","confidence":0.9}'];
    const home = openHome(scratch(), { fake: { reply: () => replies.shift()! } });
    const ask = note(12);
    expect(await home.call((home.asker.request(ask) as { send: string }).send)).toMatchObject({ outcome: "replied", sent: true });
    expect(home.asker.answer(ask)).toBeNull();
    expect(home.asker.answer(ask)).toBeNull();
    expect(home.ledger.tries(home.asker.key(ask))).toBe(1);
    expect(home.asker.state(ask)).toEqual({ pending: "unasked" });
    await home.drain([ask]);
    expect(home.sends[1]!.input).toContain('"summary" must be a string');
    expect(home.sends[1]!.input).toContain('{"summary": 3}');
    expect(home.asker.state(ask)).toMatchObject({ reply: { text: '{"summary":"a synthetic summary","confidence":0.9}', value: { summary: "a synthetic summary" } } });
    expect(home.ledger.tries(home.asker.key(ask))).toBe(1);
    home.close();
    artifact("wrong-shape", home.path);
  });
});

describe("an ask's pieces", () => {
  const whole: RoutedAsk = { family: "photos", item: "photo:synthetic-p1", prompt: "caption", input: said(INPUT), ...LUNA };
  const cut: RoutedAsk = {
    ...whole,
    input: [
      { text: INPUT.slice(0, INPUT.indexOf("person-a")) },
      { text: "person-a@example.com", is: "email" },
      { text: INPUT.slice(INPUT.indexOf("person-a") + "person-a@example.com".length), free: true, known: [{ start: 1, end: 5, type: "word" }] },
    ],
  };

  it("an ask cut into other pieces, or marked otherwise, asks again or is another key", async () => {
    expect(piecesText(cut.input)).toBe(INPUT);
    const home = openHome(scratch(), { fake: { reply: "a synthetic caption" } });
    expect(home.asker.known(cut)).toEqual({ prompt: "caption", version: 1, input_hash: GOLDEN.input_hash });
    expect(home.asker.key(cut)).toBe(GOLDEN.key_codex);
    await home.drain([whole]);
    const requests = rows(home.path).requests;
    expect(home.asker.state(cut)).toMatchObject({ reply: { text: "a synthetic caption" } });
    expect(home.asker.request(cut)).toMatchObject({ reply: { text: "a synthetic caption" } });
    await home.drain([cut]);
    expect([rows(home.path).requests, home.sends.length]).toEqual([requests, 1]);
    home.close();
    artifact("pieces-one-key", home.path);
  });

  it("a request's pieces fail to join to its body, a retry's answer or reason leaves as the asker's own words, or a queued request answers other pieces", async () => {
    const home = openHome(scratch(), { fake: { reply: "a synthetic caption naming person-b@example.com" } });
    const first = home.asker.request(cut) as Sending;
    expect(first.pieces).toEqual([{ text: PROMPT }, ...cut.input]);
    expect(first.quoted).toBeUndefined();
    expect(piecesText(first.pieces)).toBe(home.ledger.row(first.send)!.body);
    expect(home.asker.request(cut)).toEqual(first);
    expect(await home.call(first.send)).toMatchObject({ outcome: "replied", sent: true });
    home.asker.refuse(cut, home.asker.state(cut) as Candidate, "the caption names person-b@example.com, who is not in the photo");
    const retry = home.asker.request(cut) as Sending;
    const original = [{ text: PROMPT }, ...cut.input];
    expect(retry.pieces.slice(0, original.length)).toEqual(original);
    expect(retry.quoted).toEqual({ key: first.send, at: original.length + 1 });
    expect(retry.pieces[original.length + 1]).toEqual({ text: "a synthetic caption naming person-b@example.com", free: true });
    expect(retry.pieces[original.length + 3]).toEqual({ text: "the caption names person-b@example.com, who is not in the photo", free: true });
    expect(retry.pieces.filter((piece) => !("free" in piece) && !("is" in piece)).map((piece) => piece.text).join("")).not.toContain("person-b");
    expect(piecesText(retry.pieces)).toBe(home.ledger.row(retry.send)!.body);
    expect(retry.send).toBe(requestKey({ model: cut.model, prompt: "caption", version: 1, input_hash: retryIdentity(GOLDEN.input_hash, "a synthetic caption naming person-b@example.com"), effort: cut.effort }));
    const same = home.asker.request(whole) as Sending;
    expect([same.send, piecesText(same.pieces), same.quoted]).toEqual([retry.send, piecesText(retry.pieces), { key: first.send, at: 3 }]);
    home.close();
    artifact("pieces-retry", home.path);
  });

  it("a queued request whose ask's words moved under its identity is stated as other words than it was written with", () => {
    const home = openHome(scratch(), { fake: { reply: "a synthetic caption" } });
    const before: RoutedAsk = { ...whole, item: "photo:synthetic-p2", identity: "ef".repeat(32) };
    const written = home.asker.request(before) as Sending;
    const after = home.asker.request({ ...before, input: said("\n\nphoto synthetic-p2, read again") }) as Sending;
    expect(after.send).toBe(written.send);
    expect(after.pieces).toEqual([{ text: PROMPT }, { text: INPUT, free: true }]);
    expect(piecesText(after.pieces)).toBe(home.ledger.row(written.send)!.body);
    home.close();
  });
});

describe("the claude transport", () => {
  const CLAUDE = { via: { [CLAUDE_ITEM_MODEL]: "claude" } };
  const photo = (home: Home, name: string, extra: Partial<RoutedAsk> = {}): RoutedAsk => {
    const image = home.blobs.put(Buffer.from(`synthetic png bytes, ${name}`));
    return {
      family: "photos", item: `photo:synthetic-${name}`, prompt: "caption", input: said(`\n\nphoto ${name}`), model: CLAUDE_ITEM_MODEL, effort: "low", ...STREAM,
      attachments: [{ blob: image, media_type: "image/png" }], identity: image.slice("sha256:".length), ...extra,
    };
  };

  it("its child's arguments or environment drift from the rules, an image is sent otherwise than as a base64 block, or a schema's answer is prose", async () => {
    const root = scratch();
    const claude = fakeClaude(root, [
      { result: "a synthetic caption", usage: { input_tokens: 2, cache_creation_input_tokens: 500, cache_read_input_tokens: 30, output_tokens: 7 } },
      { result: "{\"summary\":\"the result's text, not the answer\"}", structured_output: { summary: "a synthetic answer" } },
      { result: "a synthetic answer, as prose" },
    ]);
    const home = openHome(root, CLAUDE);
    const asks = [photo(home, "c1"), photo(home, "c2", { prompt: "summary" }), photo(home, "c3", { prompt: "summary" })];
    const keys: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "synthetic-key", ANTHROPIC_AUTH_TOKEN: "synthetic-token", ANTHROPIC_BASE_URL: "http://127.0.0.1:9", CLAUDE_CODE_OAUTH_TOKEN: "synthetic-oauth" };
    const saved = Object.fromEntries([...Object.keys(keys), "USER"].map((name) => [name, process.env[name]]));
    Object.assign(process.env, keys);
    delete process.env.USER;
    const outcomes = [];
    try {
      for (const ask of asks) {
        home.asker.request(ask);
        outcomes.push(await home.call(home.asker.key(ask), { transport: (name) => named(name, home.settings.transports, { programs: { claude: claude.at } }) }));
      }
    } finally {
      for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["replied", "replied", "failed"]);
    const runs = claude.runs();
    expect(runs).toHaveLength(3);
    const flags = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence",
      "--permission-mode", "dontAsk", "--system-prompt", "", "--model", CLAUDE_ITEM_MODEL, "--effort", "low",
    ];
    expect(runs[0]!.args).toEqual(flags);
    expect(runs[1]!.args).toEqual([...flags, "--json-schema", canonical(SUMMARY)]);
    const env = {
      CLAUDE_CONFIG_DIR: claude.at.home, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      USER: userInfo().username, ANTHROPIC_API_KEY: null, ANTHROPIC_AUTH_TOKEN: null, ANTHROPIC_BASE_URL: null, CLAUDE_CODE_OAUTH_TOKEN: null,
    };
    for (const run of runs) {
      expect(run.env).toEqual(env);
      expect(run.cwd).toBe(realpathSync(claude.at.home));
    }
    const probes = claude.probes();
    expect(probes.map((probe) => probe.args)).toEqual([["auth", "status"], ["auth", "status"], ["auth", "status"]]);
    for (const probe of probes) expect(probe.env).toEqual(env);
    expect(runs[0]!.stdin).toEqual([{
      type: "user",
      message: { role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("synthetic png bytes, c1").toString("base64") } },
        { type: "text", text: `${PROMPT}\n\nphoto c1` },
      ] },
    }]);
    expect(home.asker.state(asks[0]!)).toMatchObject({ reply: { text: "a synthetic caption" } });
    const db = new Database(home.path, { readonly: true });
    try {
      expect(db.prepare("SELECT reply_model, input_tokens, output_tokens FROM replies WHERE key = ?").get(home.asker.key(asks[0]!)))
        .toEqual({ reply_model: "claude-haiku-5-5-20990101", input_tokens: 532, output_tokens: 7 });
    } finally { db.close(); }
    expect(home.asker.state(asks[1]!)).toMatchObject({ reply: { text: canonical({ summary: "a synthetic answer" }) } });
    expect(outcomes[2]).toMatchObject({ sent: true, reason: "claude answered no structured_output for the schema stated" });
    expect(home.ledger.tries(home.asker.key(asks[2]!))).toBe(1);
    home.close();
    artifact("claude-children", home.path);
  });

  it("a plan's limit uses up items' tries, rests more than an hour, or rests until a window not met resets", async () => {
    const root = scratch();
    const home = openHome(root, CLAUDE);
    const start = home.now();
    const rejected = (resets?: number) => ({ status: "rejected", rateLimitType: "five_hour", ...(resets === undefined ? {} : { resetsAt: resets / 1000 }) });
    const limit = (resets?: number) => ({ limit: rejected(resets), is_error: true, api_error_status: 429, result: "synthetic: the plan's limit is met" });
    const claude = fakeClaude(root, [
      limit(start + 6 * HOUR),
      { result: "a synthetic caption for another" },
      limit(start + 90 * MINUTE),
      { result: "a synthetic caption for another still" },
      { is_error: true, api_error_status: 429, result: "synthetic: limited, an allowed window stated" },
      { limit: null, is_error: true, api_error_status: 429, result: "synthetic: limited, no event" },
      { result: "a synthetic caption for a third" },
      { limit: rejected(start + 2 * HOUR), is_error: true, api_error_status: null, result: "synthetic: the limit by its event alone" },
      { limit: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1e308 }, is_error: true, api_error_status: 429, result: "synthetic: limited, no finite time" },
      limit(start - HOUR),
      { limit: rejected(start + 150 * MINUTE), dies: true },
      { is_error: true, api_error_status: null, terminal_reason: "api_error", result: "Not logged in · Please run /login" },
      { is_error: true, api_error_status: null, terminal_reason: "max_turns", result: "synthetic: the request's own failure" },
    ]);
    const via = { transport: (name: string) => named(name, home.settings.transports, { programs: { claude: claude.at } }) };
    const limited = photo(home, "l1");
    const key = home.asker.key(limited);
    const others = ["l2", "l3", "l4"].map((name) => photo(home, name));
    const call = async (ask: RoutedAsk) => {
      home.asker.request(ask);
      return (await home.call(home.asker.key(ask), via)).outcome;
    };
    const rests = () => home.ledger.resting(home.now()).get("claude")?.until_ms;
    expect(await call(limited)).toBe("unavailable");
    expect(rests()).toBe(start + HOUR);
    expect(home.ledger.resting(home.now()).get("claude")?.resets_ms).toBe(start + 6 * HOUR);
    home.ledger.rest("claude", { until_ms: home.now() + REST_MS, resets_ms: null, cause: "provider", reason: "synthetic: another call's outage" }, home.now());
    expect(rests()).toBe(start + HOUR);
    expect(home.ledger.resting(home.now()).get("claude")?.resets_ms).toBe(start + 6 * HOUR);
    home.advance(HOUR);
    expect(await call(others[0]!)).toBe("replied");
    expect(await call(limited)).toBe("unavailable");
    expect(rests()).toBe(start + 90 * MINUTE);
    home.advance(30 * MINUTE);
    expect(await call(others[1]!)).toBe("replied");
    expect(await call(limited)).toBe("unavailable");
    expect(rests()).toBe(home.now() + REST_MS);
    home.advance(REST_MS);
    expect(await call(limited)).toBe("unavailable");
    expect(rests()).toBe(home.now() + REST_MS);
    home.advance(REST_MS);
    expect(await call(others[2]!)).toBe("replied");
    expect(await call(limited)).toBe("unavailable");
    expect(rests()).toBe(start + 2 * HOUR);
    home.advance(start + 2 * HOUR - home.now());
    expect(await call(limited)).toBe("unavailable");
    expect(rests()).toBe(home.now() + REST_MS);
    home.advance(REST_MS);
    expect(await call(limited)).toBe("unavailable");
    expect(rests()).toBe(home.now() + 2 * REST_MS);
    home.advance(REST_MS);
    expect(await call(limited)).toBe("unavailable");
    expect(rests()).toBe(start + 150 * MINUTE);
    expect(home.ledger.tries(key)).toBe(0);
    home.advance(start + 150 * MINUTE - home.now());
    const signedOut = photo(home, "l5");
    expect(await call(signedOut)).toBe("unavailable");
    expect(home.ledger.tries(home.asker.key(signedOut))).toBe(0);
    home.advance(REST_MS);
    const own = photo(home, "l6");
    expect(await call(own)).toBe("failed");
    expect(home.ledger.tries(home.asker.key(own))).toBe(1);
    home.close();
    artifact("claude-limit", home.path);
  });

  it("a limit stated, then another window allowed, and the run dying, or the run stalling to its deadline, uses up an item's try", async () => {
    const root = scratch();
    const home = openHome(root, CLAUDE);
    const start = home.now();
    const allowed = { status: "allowed", rateLimitType: "seven_day", resetsAt: (start + 3 * 24 * HOUR) / 1000 };
    const claude = fakeClaude(root, [
      { limit: { status: "rejected", rateLimitType: "five_hour", resetsAt: (start + 30 * MINUTE) / 1000 }, then: allowed, dies: true },
      { limit: { status: "rejected", rateLimitType: "five_hour", resetsAt: (start + 75 * MINUTE) / 1000 }, stalls: true },
    ]);
    const item = photo(home, "h1");
    const key = home.asker.key(item);
    home.asker.request(item);
    const via = { route: home.route(key, { timeout_ms: 1_000 }), transport: (name: string) => named(name, home.settings.transports, { programs: { claude: claude.at } }) };
    const rests = () => home.ledger.resting(home.now()).get("claude")?.until_ms;
    expect(await home.call(key, via)).toMatchObject({ outcome: "unavailable", sent: false });
    expect(rests()).toBe(start + 30 * MINUTE);
    home.advance(30 * MINUTE);
    expect(await home.call(key, via)).toMatchObject({ outcome: "unavailable", sent: false, reason: expect.stringMatching(/^claude -p ended after it stated the plan's limit met: no reply within 1000 ms/u) });
    expect(rests()).toBe(start + 75 * MINUTE);
    expect(home.ledger.tries(key)).toBe(0);
    const stalled = claude.runs()[1]!.pid;
    await until("the stalled run's process ended", () => !alive(stalled));
    home.close();
    artifact("claude-limit-kept", home.path);
  });

  it("a HEIC or an audio attachment reaches Claude, or a program not on the machine charges an item", async () => {
    const root = scratch();
    const claude = fakeClaude(root, [{ result: "a synthetic caption of a converted photo" }]);
    const home = openHome(root, CLAUDE);
    const via = { transport: (name: string) => named(name, home.settings.transports, { programs: { claude: claude.at } }), convert: async (_input: string, output: string) => { writeFileSync(output, "synthetic jpeg converted"); } };
    const heic = home.blobs.put(Buffer.from("synthetic heic bytes"));
    const audio = home.blobs.put(Buffer.from("synthetic m4a bytes"));
    const asks: RoutedAsk[] = [
      { family: "photos", item: "photo:synthetic-h1", prompt: "caption", input: said("\n\nphoto h1"), model: CLAUDE_ITEM_MODEL, effort: "low", attachments: [{ blob: heic, media_type: "image/heic" }], identity: heic.slice(7), ...STREAM },
      { family: "voice", item: "voice:synthetic-a1", prompt: "transcript", input: said(""), model: CLAUDE_ITEM_MODEL, effort: "low", attachments: [{ blob: audio, media_type: "audio/mp4" }], identity: audio.slice(7), ...STREAM },
    ];
    const outcomes = [];
    for (const ask of asks) {
      home.asker.request(ask);
      outcomes.push(await home.call(home.asker.key(ask), via));
    }
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["replied", "failed"]);
    expect(outcomes[1]).toMatchObject({ reason: "claude takes JPEG, PNG, GIF and WebP images only, not audio/mp4" });
    const runs = claude.runs();
    expect(runs).toHaveLength(1);
    expect((runs[0]!.stdin[0] as { message: { content: { source?: { media_type: string; data: string } }[] } }).message.content[0]!.source)
      .toEqual({ type: "base64", media_type: "image/jpeg", data: Buffer.from("synthetic jpeg converted").toString("base64") });

    const missing = photo(home, "m1");
    home.asker.request(missing);
    const rested = await home.call(home.asker.key(missing), { transport: (name) => named(name, home.settings.transports, {}) });
    expect(rested).toMatchObject({ outcome: "unavailable", sent: false, reason: expect.stringMatching(/^Claude Code is not on this Mac yet: it is downloaded once Claude is chosen/u) });
    expect(home.ledger.tries(home.asker.key(missing))).toBe(0);
    expect([...home.ledger.resting(home.now()).keys()]).toEqual(["claude"]);
    expect(await named("codex", {}, {}).available()).toEqual({ ok: false, reason: "no_program", detail: expect.stringMatching(/^Codex is not on this Mac yet: it is downloaded once ChatGPT is chosen/u) });
    home.close();
    artifact("claude-attachments", home.path);
  });

  it("a transport's seam leaves who provides it, what it costs, who receives the data, its defaults or what it offers unsaid", async () => {
    const seams = Object.fromEntries(await Promise.all(["codex", "claude", "openrouter", "address", "fake"].map(async (name) => {
      const transport = named(name, { address: { url: "http://127.0.0.1:11434/v1", input: ["text", "image"] }, fake: {} });
      return [name, { provider: transport.provider, cost: transport.cost, leaves: transport.leaves, chat: transport.chat, defaults: transport.defaults, models: await transport.models() }] as const;
    })));
    const THINKING = ["low", "medium", "high"];
    const listed = (model: string, name: string, abilities: Partial<Abilities>, extra: Partial<ListedModel> = {}): ListedModel =>
      ({ model, name, input: ["text"], output: "text", tools: true, timed: false, context_tokens: null, thinking: THINKING, ...abilities, ready: true, ...extra });
    expect(seams).toEqual({
      codex: {
        provider: "ChatGPT", cost: "plan", leaves: "OpenAI", chat: "program",
        defaults: { effort: "low", timeout_ms: 120_000, concurrency: 2 },
        models: [
          listed("gpt-6-luna", "GPT-6 Luna", { input: ["text", "image"], context_tokens: 1_050_000 }, { suggested: ["pictures", "text"] }),
          listed(CODEX_CHAT_MODEL, "GPT-6.2 Sol", { input: ["text", "image"], context_tokens: 1_050_000 }, { suggested: ["chat"] }),
        ],
      },
      claude: {
        provider: "Claude", cost: "plan", leaves: "Anthropic", chat: "program",
        defaults: { effort: "low", timeout_ms: 120_000, concurrency: 2 },
        models: [
          listed(CLAUDE_ITEM_MODEL, "Claude Haiku 5.5", { input: ["text", "image"], context_tokens: 200_000 }, { suggested: ["pictures", "text"] }),
          listed(CLAUDE_CHAT_MODEL, "Claude Opus 5.5", { input: ["text", "image"], context_tokens: 200_000 }, { suggested: ["chat"] }),
        ],
      },
      openrouter: {
        provider: "OpenRouter", cost: "priced", leaves: "OpenRouter", chat: "door",
        defaults: { effort: "low", sampling: { temperature: 0 }, timeout_ms: 120_000, concurrency: 4 },
        models: [
          listed("elevenlabs/scribe-v2", "Scribe v2", { input: ["audio"], tools: false, thinking: [] }, { suggested: ["audio"], request: { effort: "none" } }),
          listed("google/gemini-3.8-flash", "Gemini 3.8 Flash", { input: ["text", "image", "audio"], timed: true }, { suggested: ["pictures", "text"] }),
          listed("openai/gpt-6-luna", "GPT-6 Luna", { input: ["text", "image"] }, { suggested: ["pictures", "text", "chat"] }),
        ],
      },
      address: {
        provider: "the custom address", cost: "free", leaves: null, chat: "door",
        defaults: { effort: "none", sampling: { temperature: 0 }, timeout_ms: 120_000, concurrency: 1 },
        models: [],
      },
      fake: {
        provider: "the test model", cost: "free", leaves: null, chat: null,
        defaults: { effort: "low", timeout_ms: 120_000, concurrency: 8 }, models: [],
      },
    });
    const photos = { family: "photos", item: "photo:synthetic-defaults", prompt: "caption", input: said(INPUT), ...STREAM };
    const home = openHome(scratch());
    const { effort, sampling } = named("codex", {}).defaults;
    expect(home.asker.key({ ...photos, model: "gpt-5.6-luna", effort, ...(sampling === undefined ? {} : { sampling }) })).toBe(GOLDEN.key_codex);
    home.close();
    const voice = listed("synthetic/model", "A synthetic model", { input: ["audio"], tools: false, thinking: [] });
    const fake = fakeTransport({ models: [voice], unavailable: "synthetic: away", until_ms: T0 + 15_000 });
    expect(await fake.models()).toEqual([voice]);
    expect(await fake.available()).toEqual({ ok: false, reason: "away", detail: "synthetic: away", until_ms: T0 + 15_000 });
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(join(ARTIFACTS, "transport-seams.json"), `${JSON.stringify(seams, null, 2)}\n`);
  });
});


describe("model settings", () => {
  it("a transports block the home cannot run passes the settings check", () => {
    const block = (transports?: unknown) => ({ cap: 4, ...(transports === undefined ? {} : { transports }) });
    const address = { url: "http://127.0.0.1:11434/v1", input: ["text", "image"] };
    const refused = {
      nowhere: () => readModelSettings(block({ nowhere: {} })),
      concurrency: () => readModelSettings(block({ codex: { concurrency: 0 } })),
      secret: () => readModelSettings(block({ address: { ...address, secret: "" } })),
      keyed: () => readModelSettings(block({ openrouter: { secret: "openrouter" } })),
      url: () => readModelSettings(block({ address: { ...address, url: "ftp://127.0.0.1/v1" } })),
      model: () => readModelSettings(block({ address: { ...address, model: " " } })),
      input: () => readModelSettings(block({ address: { ...address, input: ["text", "video"] } })),
      audio: () => readModelSettings(block({ address: { ...address, input: ["text", "audio"] } })),
      textless: () => readModelSettings(block({ address: { ...address, input: ["image"] } })),
      misspelt: () => readModelSettings(block({ address: { ...address, secrt: "address" } })),
      member: () => readModelSettings(block({ codex: { concurrency: 1, secret: "codex" } })),
      user: () => readModelSettings(block({ address: { ...address, url: "https://person@models.example.com/v1" } })),
      password: () => readModelSettings(block({ address: { ...address, url: "https://:synthetic-password@models.example.com/v1" } })),
      query: () => readModelSettings(block({ address: { ...address, url: "https://models.example.com/v1?key=synthetic-key" } })),
      cap: () => readModelSettings({ ...block(), cap: 0 }),
    };
    expect(refused.nowhere).toThrow("model.transports.nowhere: no transport is named nowhere");
    expect(refused.concurrency).toThrow("model.transports.codex.concurrency is a positive whole number");
    expect(refused.secret).toThrow("model.transports.address.secret names a secret");
    expect(refused.keyed).toThrow("model.transports.openrouter.secret: openrouter takes no such member");
    expect(refused.url).toThrow("model.transports.address.url is an http or https address");
    expect(refused.model).toThrow("model.transports.address.model names a model the address serves");
    expect(refused.input).toThrow("model.transports.address.input is text, or text and image");
    expect(refused.audio).toThrow("model.transports.address.input is text, or text and image");
    expect(refused.textless).toThrow("model.transports.address.input is text, or text and image");
    expect(refused.misspelt).toThrow("model.transports.address.secrt: address takes no such member");
    expect(refused.member).toThrow("model.transports.codex.secret: codex takes no such member");
    expect(refused.user).toThrow("model.transports.address.url holds no user name, password or query: a key goes in its secret");
    expect(refused.password).toThrow("model.transports.address.url holds no user name, password or query: a key goes in its secret");
    expect(refused.query).toThrow("model.transports.address.url holds no user name, password or query: a key goes in its secret");
    expect(refused.cap).toThrow("model.cap is a positive number");
    for (const ok of [block(), block({ codex: { concurrency: 1 }, claude: {}, openrouter: {}, address: { url: address.url, secret: "address", concurrency: 2, model: "synthetic-local" }, fake: { reply: "a synthetic reply", cost_usd: 0 } })]) {
      expect(() => readModelSettings(ok)).not.toThrow();
    }
    const messages = Object.fromEntries(Object.entries(refused).map(([name, read]) => {
      try { read(); return [name, null]; } catch (error) { return [name, (error as Error).message]; }
    }));
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(join(ARTIFACTS, "transport-settings.json"), `${JSON.stringify(messages, null, 2)}\n`);
  });

  it("the OpenRouter key's value is read when its transport is only asked whether it runs", async () => {
    const asked: string[] = [];
    const found = (held: boolean): Found => ({
      held: (name) => { asked.push(`held ${name}`); return held; },
      secret: (name) => { asked.push(`secret ${name}`); return held ? "synthetic-openrouter-key" : undefined; },
    });
    expect(await named("openrouter", {}, found(false)).available()).toEqual({ ok: false, reason: "no_key", detail: "openrouter has no API key" });
    expect(await named("openrouter", {}, found(true)).available()).toEqual({ ok: true });
    expect(asked).toEqual(["held openrouter", "held openrouter"]);
    expect(transportSecret("openrouter", {})).toBe("openrouter");
  });
});

describe("the runner transport", () => {
  it("reads a model's id back to its transport, its runner and its model, the one way an id is read, and no other string as one", () => {
    const routes = [
      { transport: "openrouter", model: "google/gemini-3.8-flash" },
      { transport: "address", model: "qwen3.5:9b" },
      { transport: "runner", runner: RUNNER_UNIT, model: "qwen3.5-4b" },
      { transport: "runner", runner: RUNNER_UNIT, model: "ollama/qwen3.5:9b" },
    ];
    expect(routes.map((route) => readRouteId(routeId(route)))).toEqual(routes);
    expect(["default", "off", "", ":model", "codex:", "runner:qwen3.5-4b", `runner:${RUNNER_UNIT}/`, "runner:/qwen3.5-4b"].map(readRouteId)).toEqual(Array(8).fill(null));
  });

  it("takes a file's languages as primary language codes, or none, and keeps them; a subtag, a sentence, a word that is no code or no member at all is refused", () => {
    const stated = (languages: unknown) => {
      const { present: _present, unit: _unit, ...rest } = runner(true, [{ ...file("speech", "absent"), input: ["audio"], context_tokens: null, languages: languages as string[] }]);
      return rest;
    };
    for (const languages of [[], ["en"], ["en", "hi", "pt", "zh", "fil"]]) {
      expect(isStated(stated(languages)), JSON.stringify(languages)).toBe(true);
      expect(runnerInfo(RUNNER_UNIT, stated(languages)).files[0]!.languages).toEqual(languages);
    }
    for (const languages of [undefined, null, "en", ["English"], ["Hindi and about thirty more"], [""], [7], ["en_US"], ["pt-BR"], ["zh-Hans"], ["en-US"], ["EN"], Array.from({ length: 201 }, () => "en")]) {
      expect(isStated(stated(languages)), JSON.stringify(languages)).toBe(false);
    }
  });

  it("takes a file's timed as stated and lists it so, and a file an older runner states with no timed as untimed, still listed; a timed that is no boolean is refused", async () => {
    const stated = (timed: unknown) => {
      const { present: _present, unit: _unit, ...rest } = runner(true, [{ ...file("speech", "ready"), input: ["audio"], context_tokens: null, timed: timed as boolean }]);
      return rest;
    };
    const { timed: _timed, ...older } = stated(true).files[0]!;
    const before = { ...stated(true), files: [older] };
    expect([isStated(stated(true)), isStated(stated(false)), isStated(before)]).toEqual([true, true, true]);
    expect([runnerInfo(RUNNER_UNIT, stated(true)), runnerInfo(RUNNER_UNIT, stated(false)), runnerInfo(RUNNER_UNIT, before)].map((info) => info.files.map((each) => [each.id, each.timed])))
      .toEqual([[["speech", true]], [["speech", false]], [["speech", false]]]);
    for (const timed of [null, "yes", 1]) expect(isStated(stated(timed)), JSON.stringify(timed)).toBe(false);
    const listing = [{ ...runnerInfo(RUNNER_UNIT, stated(true)), present: true }, { ...runnerInfo("runner-mac-mini-0002", before), present: true }];
    const offered = await runnerTransport({ door: undefined, pass: () => CALL, runners: listing, clock: () => RUNNER_NOW }).models();
    expect(offered.map((model) => [model.runner?.unit, model.model, model.timed])).toEqual([[RUNNER_UNIT, "speech", true], ["runner-mac-mini-0002", "speech", false]]);
  });

  it("offers each runner's files from the listing it is handed, ready only when its runner is present and holds them; runs wherever it knows the door; the home's listing ends within its bound", async () => {
    const door = await fakeDoor();
    const listed = [runner(true, [file("qwen3.5-4b", "ready"), file("downloading", "fetching", { fetched_bytes: 1_200_000_000 }), file("absent", "absent")], 2)];
    const transport = runnerTransport({ door: door.url, pass: () => CALL, runners: listed, clock: () => RUNNER_NOW });
    expect([transport.name, transport.provider, transport.cost, transport.leaves, transport.chat]).toEqual(["runner", "the runner", "free", null, "door"]);
    expect(transport.reach?.("qwen3.5-4b", RUNNER_UNIT)).toEqual({ runner: RUNNER_UNIT, file: "qwen3.5-4b" });
    expect(await transport.available()).toEqual({ ok: true });
    const machine = { unit: RUNNER_UNIT, name: "MacBook Pro", battery: false };
    expect((await transport.models()).map((model) => [model.model, model.runner, model.ready])).toEqual([
      ["qwen3.5-4b", machine, true], ["downloading", machine, false], ["absent", machine, false],
    ]);
    expect(transport.defaults).toEqual({ effort: "none", timeout_ms: 300_000, concurrency: 2 });

    const away = runnerTransport({ door: door.url, pass: () => CALL, runners: [runner(false, [file("qwen3.5-4b", "ready")])], clock: () => RUNNER_NOW });
    expect((await away.models()).map((model) => model.ready)).toEqual([false]);
    expect(away.defaults.concurrency).toBe(0);
    const battery = runnerTransport({ door: door.url, pass: () => CALL, runners: [{ ...runner(true, [file("qwen3.5-4b", "ready")]), power: "battery" }], clock: () => RUNNER_NOW });
    expect((await battery.models())[0]!.runner).toEqual({ ...machine, battery: true });

    expect([CALL_PASS, transportSecret("runner", {})]).toEqual(["call", "call"]);
    const called = named("runner", {}, { door: door.url, secret: (name) => (name === CALL_PASS ? CALL : undefined) });
    expect(await called.available()).toEqual({ ok: true });
    expect(await ended(called.send(request(new AbortController().signal), []))).toEqual({ answered: { text: "a synthetic caption", model: "qwen3.5-4b", input_tokens: 9 } });
    expect(await runnerTransport({ door: undefined, pass: () => CALL, clock: () => RUNNER_NOW }).available()).toMatchObject({ ok: false, reason: "away", until_ms: RUNNER_NOW + 15_000 });

    door.state.listed = listed;
    expect(await listRunners(door.url, DRIVE)).toEqual({ runners: listed, below: [] });
    await expect(listRunners(door.url, CALL)).rejects.toThrow("the door answered 401");
    const silent = createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => new Promise<void>((resolve) => {
      silent.close(() => resolve());
      silent.closeAllConnections();
    }));
    await expect(listRunners(`http://127.0.0.1:${(silent.address() as AddressInfo).port}`, DRIVE, fetch, 100)).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("places a call on the runner its route names, by the file's id alone; rests what failed and nothing wider, or ends the request", async () => {
    const door = await fakeDoor();
    const transport = runnerTransport({ door: door.url, pass: () => CALL, clock: () => RUNNER_NOW });
    const dir = mkdtempSync(join(tmpdir(), "lifestream-runner-transport-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const photo = join(dir, "photo.jpg");
    writeFileSync(photo, "synthetic jpeg");
    const schema = join(dir, "schema.json");
    writeFileSync(schema, JSON.stringify({ type: "string" }));
    const send = (extra: Partial<SendRequest> = {}) => transport.send(request(new AbortController().signal, extra), [{ path: photo, media_type: "image/jpeg" }]);

    const answered = await ended(send({ schema }));
    expect(answered).toEqual({ answered: { text: "a synthetic caption", model: "qwen3.5-4b", input_tokens: 9 } });
    expect(door.state.placed[0]).toEqual({
      runner: RUNNER_UNIT, model: "qwen3.5-4b", input: "Describe this photo.", schema: { type: "string" },
      attachments: [{ media_type: "image/jpeg", base64: Buffer.from("synthetic jpeg").toString("base64") }],
    });
    const ends: Record<string, unknown> = { answered };
    for (const [name, end] of [
      ["no runner", { status: 200, body: { error: { code: "NO_RUNNER", runner: RUNNER_UNIT } } }],
      ["not ready", { status: 200, body: { error: { code: "NOT_READY", model: "qwen3.5-4b" } } }],
      ["interrupted", { status: 200, body: { error: { code: "INTERRUPTED", reason: "restarted", runner: RUNNER_UNIT } } }],
      ["busy", { status: 200, body: { error: { code: "BUSY", model: "qwen3.5-4b" } } }],
      ["the runner failed", { status: 200, body: { error: { code: "FAILED", reason: "failed" } } }],
      ["too long", { status: 200, body: { error: { code: "FAILED", reason: "too_long", seconds: 600 } } }],
      ["too large", { status: 413, body: { code: "BODY_TOO_LARGE", message: "a call is at most 32 MiB" } }],
      ["the door starting", { status: 503, body: { code: "STARTING", message: "the home is starting" } }],
      ["the door lost", "cut"],
    ] as const) {
      door.state.end = end;
      ends[name] = await ended(send());
    }
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(join(ARTIFACTS, "runner.json"), `${JSON.stringify({ placed: door.state.placed, ends }, null, 2)}\n`);
    expect(ends).toEqual({
      answered,
      "no runner": { rests: "runner", for_ms: 15_000 }, "not ready": { rests: "route", for_ms: 15_000 },
      interrupted: { rests: "runner", for_ms: 15_000 }, busy: { rests: "runner", for_ms: 30_000 },
      "the runner failed": { rests: "route" },
      "too long": { request: "the runner's call ended FAILED (too_long), 600 s at most" }, "too large": { request: "the call is larger than the door takes" },
      "the door starting": { rests: "transport", for_ms: 15_000 }, "the door lost": { rests: "transport", for_ms: 15_000 },
    });
  });

  it("answers a call that carries audio with no words in its transcript the voice prompt's no speech, and leaves any other call's empty answer empty", async () => {
    const door = await fakeDoor();
    const transport = runnerTransport({ door: door.url, pass: () => CALL, clock: () => RUNNER_NOW });
    const dir = mkdtempSync(join(tmpdir(), "lifestream-runner-silent-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const note = join(dir, "note.wav");
    writeFileSync(note, "synthetic wav");
    const photo = join(dir, "photo.jpg");
    writeFileSync(photo, "synthetic jpeg");
    const send = (text: string, file: SendAttachment) => {
      door.state.end = { status: 200, body: { ok: { text, model: "parakeet-unified-en-0.6b" } } };
      return ended(transport.send(request(new AbortController().signal, { model: "parakeet-unified-en-0.6b", input: "" }), [file]));
    };
    const audio = { path: note, media_type: "audio/wav" };
    expect(NO_SPEECH).toBe("[no speech]");
    expect(await send("", audio)).toEqual({ answered: { text: NO_SPEECH, model: "parakeet-unified-en-0.6b" } });
    expect(await send(" \n", audio)).toEqual({ answered: { text: NO_SPEECH, model: "parakeet-unified-en-0.6b" } });
    expect(await send("Synthetic words", audio)).toEqual({ answered: { text: "Synthetic words", model: "parakeet-unified-en-0.6b" } });
    expect(await send("", { path: photo, media_type: "image/jpeg" })).toEqual({ answered: { text: "", model: "parakeet-unified-en-0.6b" } });
  });

  it("ends a call on its signal, closing its request to the door: the call's clock is the one clock", async () => {
    const door = await fakeDoor();
    door.state.end = "hold";
    const transport = runnerTransport({ door: door.url, pass: () => CALL, clock: () => RUNNER_NOW });
    const clock = new AbortController();
    const sending = transport.send(request(clock.signal), []).then(() => "answered", (error: unknown) => error);
    await until("the call placed and held", () => door.state.placed.length === 1);
    const reason = new Error("no reply within 300000 ms");
    clock.abort(reason);
    expect(await sending).toBe(reason);
    await until("the door sees the call's request close", () => door.state.closed === 1);
  });

  it("places a call a person waits on in Chat's line, and a warm call with no input; the wire takes Chat's line on a model's call, and a warm call only so", async () => {
    const door = await fakeDoor();
    const transport = runnerTransport({ door: door.url, pass: () => CALL, clock: () => RUNNER_NOW });
    await transport.send(request(new AbortController().signal, { line: "chat" }), []);
    await transport.send(request(new AbortController().signal), []);
    expect(door.state.placed.map((placed) => placed.line)).toEqual(["chat", undefined]);
    expect("line" in door.state.placed[1]!).toBe(false);

    door.state.end = { status: 200, body: { ok: { text: "", model: "parakeet-unified-en-0.6b" } } };
    expect(await warmRunner(door.url, CALL, RUNNER_UNIT, "parakeet-unified-en-0.6b", new AbortController().signal)).toEqual({ ok: { text: "", model: "parakeet-unified-en-0.6b" } });
    expect(door.state.placed[2]).toEqual({ runner: RUNNER_UNIT, model: "parakeet-unified-en-0.6b", input: "", attachments: [], line: "chat", warm: true });
    expect(isPlaced(door.state.placed[2])).toBe(true);
    door.state.end = { status: 200, body: { error: { code: "NOT_READY", model: "parakeet-unified-en-0.6b" } } };
    expect(await warmRunner(door.url, CALL, RUNNER_UNIT, "parakeet-unified-en-0.6b", new AbortController().signal)).toEqual({ error: { code: "NOT_READY", model: "parakeet-unified-en-0.6b" } });
    door.state.end = { status: 503, body: { code: "STARTING", message: "the home is starting" } };
    await expect(warmRunner(door.url, CALL, RUNNER_UNIT, "parakeet-unified-en-0.6b", new AbortController().signal)).rejects.toThrow("the door answered 503");

    const placed = { runner: RUNNER_UNIT, model: "parakeet-unified-en-0.6b", input: "", attachments: [] };
    const note = { media_type: "audio/wav", base64: "UklGRg==" };
    expect(isPlaced({ ...placed, line: "chat", attachments: [note] })).toBe(true);
    expect(isPlaced({ ...placed, line: "chat", warm: true })).toBe(true);
    for (const refused of [
      { ...placed, warm: true }, { ...placed, line: "hide", warm: true }, { ...placed, line: "chat", warm: true, input: "Transcribe." },
      { ...placed, line: "chat", warm: true, attachments: [note] }, { ...placed, line: "chat", warm: true, schema: { type: "string" } }, { ...placed, line: "chat", warm: false },
      { ...placed, line: "talk" },
    ]) expect(isPlaced(refused), JSON.stringify(refused)).toBe(false);
    expect(isHanded({ calls: [{ id: "r-1", ...placed, warm: true }], cancel: [], files: [] })).toBe(true);
    expect(isHanded({ calls: [{ id: "r-1", ...placed, warm: "yes" }], cancel: [], files: [] })).toBe(false);
  });

  it("a background call a Chat call pre-empted yields: its attempt ends with no try charged, nothing rests, and it is sent again", async () => {
    const door = await fakeDoor();
    const home = openHome(scratch());
    const ask: RoutedAsk = { family: "photos", item: "photo:synthetic-p1", prompt: "caption", input: said("\n\nphoto synthetic-p1"), ...LUNA };
    const key = (home.asker.request(ask) as { send: string }).send;
    const runner = () => runnerTransport({ door: door.url, pass: () => CALL, clock: home.now });
    const route = home.route(key, { transport: "runner", runner: RUNNER_UNIT });

    door.state.end = { status: 200, body: { error: { code: "INTERRUPTED", reason: "preempted", runner: RUNNER_UNIT } } };
    const yielded = await runner().send(request(new AbortController().signal), []).then(() => null, (error: unknown) => error);
    expect(yielded).toBeInstanceOf(SendFailed);
    expect(yielded).toMatchObject({ yielded: true, message: "the runner's call ended INTERRUPTED (preempted)" });
    expect([(yielded as SendFailed).until_ms, (yielded as SendFailed).scope, (yielded as SendFailed).limit]).toEqual([undefined, undefined, undefined]);

    expect(await home.call(key, { route, transport: runner })).toMatchObject({ outcome: "unavailable", sent: false, reason: "the runner's call ended INTERRUPTED (preempted)" });
    expect(home.ledger.tries(key)).toBe(0);
    expect([...home.ledger.resting(home.now()).keys()]).toEqual([]);
    expect(rows(home.path).attempts.map((row) => row.state)).toEqual(["unknown"]);
    door.state.end = { status: 200, body: { ok: { text: "a synthetic caption", model: "gpt-5.6-luna" } } };
    expect(await home.call(key, { route, transport: runner })).toMatchObject({ outcome: "replied", sent: true });
    expect(rows(home.path).attempts.map((row) => row.state)).toEqual(["unknown", "replied"]);
    expect(home.ledger.tries(key)).toBe(0);
    door.state.end = { status: 200, body: { error: { code: "INTERRUPTED", reason: "driver_gone", runner: RUNNER_UNIT } } };
    expect(await ended(runnerTransport({ door: door.url, pass: () => CALL, clock: () => RUNNER_NOW }).send(request(new AbortController().signal), []))).toEqual({ rests: "runner", for_ms: 15_000 });
    home.close();
  });

  it("a call process takes Chat's line in its route and places its call there; a route stating another line is refused", async () => {
    const door = await fakeDoor();
    door.state.end = { status: 200, body: { ok: { text: "a synthetic caption", model: "gpt-5.6-luna" } } };
    const root = scratch();
    const home = openHome(root);
    const ask: RoutedAsk = { family: "photos", item: "photo:synthetic-c1", prompt: "caption", input: said("\n\nphoto synthetic-c1"), ...LUNA };
    const key = (home.asker.request(ask) as { send: string }).send;
    home.close();
    const run = async (route: unknown) => {
      const child = spawn(process.execPath, [...CALL_CMD, "--root", root, "--route", JSON.stringify(route), "--door", door.url, ...homeAt(join(root, "machine")), "--key", key]);
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stdin.end(handed(root, { [CALL_PASS]: CALL }));
      const [status] = await once(child, "close") as [number];
      return { status, stdout };
    };
    const refused = await run({ transport: "runner", runner: RUNNER_UNIT, timeout_ms: 60_000, line: "hide" });
    expect([refused.status, refused.stdout]).toEqual([64, ""]);
    const placed = await run({ transport: "runner", runner: RUNNER_UNIT, timeout_ms: 60_000, line: "chat" });
    expect(placed.status).toBe(0);
    expect(JSON.parse(placed.stdout)).toMatchObject({ outcome: "replied", sent: true });
    expect(door.state.placed.map((each) => each.line)).toEqual(["chat"]);
  });

  it("a call process on an encrypted home opens its ledger with the three keys on its standard input, and the maker's program it starts sees none of them", async () => {
    const root = scratch();
    const machineDir = testMachine();
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "vault.json"), JSON.stringify({ version: 2, counter: 1, key_id: "0a0b0c0d", slots: [], keys: [{ kind: "data", id: 1, made_ms: 0, wrapped: "c3ludGhldGlj" }] }));
    const keys = Keys.derive(randomBytes(32));
    const folder = openHomeFolder(root, { machine: machineDir, program: "home", keys });
    mkdirSync(join(root, "replies"));
    const ledger = openLedger(folder, { mode: "migrate" });
    const asker = openAsker({ ledger, prompt: (name) => PROMPTS[name]!, blobs: memoryBlobs(), clock: () => T0 });
    const ask: RoutedAsk = { family: "notes", item: "note:synthetic-k1", prompt: "caption", input: said("\n\nnote synthetic-k1"), model: CLAUDE_ITEM_MODEL, effort: "low", ...STREAM };
    const key = (asker.request(ask) as { send: string }).send;
    const copy = ledger.sent.make({ key, receiver: "Anthropic", route: "test", level: "none", body: null, pictures: [], counts: {}, detector: null }, T0, ledger.placeholders.epoch().epoch);
    ledger.close();
    if (!("id" in copy)) throw new Error("no sent copy was made");
    const claude = fakeClaude(root, [{ result: "a synthetic caption, kept keyed" }]);
    const child = spawn(process.execPath, [
      ...CALL_CMD, "--root", root, "--route", JSON.stringify({ transport: "claude", timeout_ms: 60_000 }),
      "--programs", JSON.stringify({ claude: claude.at }), ...homeAt(machineDir), "--key", key, "--sent-copy", String(copy.id),
    ]);
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stdin.end(`{}\n${JSON.stringify(folder.handOver(["store:ledger", "files", "names"], "call"))}`);
    const [status] = await once(child, "close") as [number];
    expect([status, JSON.parse(stdout)], stdout).toMatchObject([0, { outcome: "replied", sent: true }]);
    const data = Buffer.from((keys.hand() as { data: string }).data, "hex");
    const derived = Object.values((keys.only(["store:home", "store:ledger", "files", "names", "ask-pending"]).hand() as { keys: Record<string, string> }).keys).map((hex) => Buffer.from(hex, "hex"));
    const secrets = [data, ...derived].flatMap((each) => [each.toString("hex"), each.toString("base64")]);
    expect(claude.runs()).toHaveLength(1);
    const seen = JSON.stringify([...claude.runs(), ...claude.probes()]);
    for (const secret of secrets) expect(seen.includes(secret)).toBe(false);
    const read = openLedger(openHomeFolder(root, { machine: machineDir, program: "home", keys }), { mode: "read" });
    try {
      expect(read.row(key)).toMatchObject({ key });
    } finally {
      read.close();
    }
  });
});

describe("a call's photos and audio, kept through the home folder", () => {
  const CANARY = "synthetic-canary-ledger";
  const RECEIVER = "Example AI";
  const filesUnder = (top: string): string[] => readdirSync(top, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));

  const asked = async (folder: HomeFolder, tops: readonly string[], copies: string) => {
    const ledger = openLedger(folder, { mode: "migrate" });
    const blobs = memoryBlobs();
    const asker = openAsker({ ledger, prompt: (name) => PROMPTS[name]!, blobs, clock: () => T0 });
    const picture = blobs.put(Buffer.from(`${CANARY} picture`));
    const voice = blobs.put(Buffer.from(`${CANARY} voice`));
    const asks: RoutedAsk[] = [
      { family: "photos", item: "photo:synthetic-canary", prompt: "caption", input: said("\n\nphoto synthetic"), ...LUNA, attachments: [{ blob: picture, media_type: "image/jpeg" }], identity: picture.slice(7) },
      { family: "voice", item: "voice:synthetic-canary", prompt: "transcript", input: said("\n\nvoice synthetic"), ...AUDIO, attachments: [{ blob: voice, media_type: "audio/mp4" }], identity: voice.slice(7) },
    ];
    const [photo, note] = asks.map((ask) => (asker.request(ask) as { send: string }).send) as [string, string];
    const copy = ledger.sent.make({
      key: photo, receiver: RECEIVER, route: "test", level: "all", body: "Caption this synthetic image.", pictures: [{ jpeg: Buffer.from(`${CANARY} drawn picture`), recipe: {} }],
      counts: {}, detector: null,
    }, T0, ledger.placeholders.epoch().epoch);
    if (!("id" in copy)) throw new Error("no sent copy was made");
    const log = join(scratch(), "received.jsonl");
    const seen: string[][] = [];
    const holding: string[][] = [];
    const walk = (): string[] => {
      const files = tops.flatMap(filesUnder);
      holding.push(files.filter((file) => readFileSync(file).includes(CANARY)));
      return files;
    };
    const call = (key: string, transport: Transport, sentCopy?: number) => runCall({
      folder, key, route: { transport: "fake", timeout_ms: 30_000 }, copies, clock: () => T0, transport: () => transport, ...(sentCopy === undefined ? {} : { sentCopy }),
      failpoint: (at) => { if (at === "copied") seen.push(walk()); },
    });
    expect(await call(photo, fakeTransport({ leaves: RECEIVER, log, reply: "a synthetic caption" }), copy.id)).toMatchObject({ outcome: "replied", sent: true });
    expect(await call(note, fakeTransport({ log, reply: "a synthetic transcript" }))).toMatchObject({ outcome: "replied", sent: true });
    const received = readFileSync(log, "utf8").trim().split("\n").map((line) => (JSON.parse(line) as { attachments: { bytes: string }[] }).attachments.map((file) => Buffer.from(file.bytes, "base64").toString("utf8")));
    const kept = [picture, voice].map((blob) => ledger.attachment(blob.slice(7)).toString("utf8"));
    const after = walk();
    const modes = after.filter((file) => file.includes(`${sep}replies${sep}blobs${sep}`)).map((file) => statSync(file).mode & 0o777);
    const forgotten = ledger.forget(asks.map((ask) => ask.item));
    const left = walk();
    ledger.close();
    return { hashes: [picture, voice, photo, note].map((hash) => hash.slice(7)), copy: copy.id, received, kept, seen, after, modes, forgotten, left, holding };
  };

  it("a keyed home seals them in replies/blobs/k1 and its hidden copy's picture beside its name; no file outside scratch holds a plain byte of them or is named by a hash the asks hold", async () => {
    const root = scratch();
    const machineDir = testMachine();
    const run = await asked(keyedFolder(root, machineDir), [root, machineDir], callCopiesOf(machineDir, "home-test"));
    const work = `${join(machineDir, "scratch")}${sep}`;
    const under = (files: string[], folder: string) => files.filter((file) => file.startsWith(`${folder}${sep}`));
    expect(run.received).toEqual([[`${CANARY} drawn picture`], [`${CANARY} voice`]]);
    expect(run.kept).toEqual([`${CANARY} picture`, `${CANARY} voice`]);
    for (const files of [...run.seen, run.after, run.left]) expect(files.filter((file) => run.hashes.some((hash) => file.includes(hash)))).toEqual([]);
    expect(run.holding.map((files) => files.filter((file) => !file.startsWith(work)))).toEqual(run.holding.map(() => []));
    expect(run.seen.map((files) => files.filter((file) => file.startsWith(work)).length)).toEqual([1, 1]);
    expect(under(run.seen[0]!, join(root, "replies", "sent", String(run.copy))).map((file) => file.slice(file.lastIndexOf(sep) + 1))).toEqual(["0.jpg.k1"]);
    expect(under(run.seen[0]!, join(root, "replies", "calls")).filter((file) => file.endsWith(".lock"))).toHaveLength(1);
    expect(under(run.after, join(root, "replies", "blobs", "k1"))).toHaveLength(2);
    expect(run.after.filter((file) => file.startsWith(work))).toEqual([]);
    expect(run.forgotten.attachments).toBe(2);
    expect(under(run.left, join(root, "replies", "blobs"))).toEqual([]);
    expect(existsSync(join(machineDir, "calls"))).toBe(false);
  });

  it("a plain home keeps them where it always has: replies/blobs/<aa>/<bb>/<sha256> as given, replies/sent/<id>/0.jpg, replies/calls/<request key>.lock, a call's copies in <machine>/calls/<home id>/<request key>/", async () => {
    const root = scratch();
    const machineDir = scratch();
    const copies = callCopiesOf(machineDir, "home-test");
    const run = await asked(openHomeFolder(root), [root, machineDir], copies);
    const [picture, voice, photo, note] = run.hashes as [string, string, string, string];
    const blob = (hex: string) => join(root, "replies", "blobs", hex.slice(0, 2), hex.slice(2, 4), hex);
    expect(run.received).toEqual([[`${CANARY} drawn picture`], [`${CANARY} voice`]]);
    expect(run.after.filter((file) => file.includes(`${sep}blobs${sep}`)).sort()).toEqual([blob(picture), blob(voice)].sort());
    expect(run.modes).toEqual([0o400, 0o400]);
    expect(run.kept).toEqual([`${CANARY} picture`, `${CANARY} voice`]);
    expect(run.seen[0]).toEqual(expect.arrayContaining([join(root, "replies", "sent", String(run.copy), "0.jpg"), join(root, "replies", "calls", `${photo}.lock`)]));
    expect(run.seen[1]).toEqual(expect.arrayContaining([join(root, "replies", "calls", `${note}.lock`)]));
    expect(run.seen.map((files) => files.filter((file) => file.startsWith(`${machineDir}${sep}`)).map((file) => relative(copies, file).replace(/\.[a-z0-9]+$/u, "")))).toEqual([[join(photo, "picture-0")], [join(note, "attachment-0")]]);
    expect(run.after.filter((file) => file.startsWith(`${machineDir}${sep}`))).toEqual([]);
    expect(run.forgotten.attachments).toBe(2);
    expect(run.left.filter((file) => file.includes(`${sep}blobs${sep}`))).toEqual([]);
  });

  it("a call process handed no folder line refuses, opens no ledger and sends nothing", () => {
    const root = scratch();
    const call = (input: string) => spawnSync(process.execPath, [...CALL_CMD, "--root", root, "--route", JSON.stringify({ transport: "fake", timeout_ms: 30_000 }),
      "--transports", JSON.stringify({ fake: {} }), ...homeAt(join(root, "machine")), "--key", `sha256:${"a".repeat(64)}`], { encoding: "utf8", input });
    const refused = ["", "{}", "{}\n", "{}\n  \n"].map(call);
    expect(refused.map((each) => [each.status, each.stdout])).toEqual(Array.from({ length: 4 }, () => [64, ""]));
    for (const each of refused) expect(JSON.parse(each.stderr)).toMatchObject({ exit: 64, error: expect.stringContaining("no folder line") });
    expect(existsSync(join(root, "replies"))).toBe(false);
  });
});

describe("Scribe v2 on the OpenRouter transport", () => {
  const played = (answer: () => Response = () => Response.json({ text: "a synthetic note's words", usage: { cost: 0.0015, seconds: 25, input_tokens: 12, output_tokens: 6 } })) => {
    const posts: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      posts.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return answer();
    }) as typeof fetch;
    return { posts, fetcher };
  };

  it("posts a note as it is to OpenRouter's transcriptions, Scribe v2, with no language: its words and what they cost; the key is OpenRouter's one key", async () => {
    const { posts, fetcher } = played();
    const transport = openRouterTransport({ held: () => true, key: () => "synthetic-key", fetch: fetcher });
    expect([transport.name, transport.provider, transport.cost, transport.leaves]).toEqual(["openrouter", "OpenRouter", "priced", "OpenRouter"]);
    expect((await transport.models())[0]).toEqual({
      model: "elevenlabs/scribe-v2", name: "Scribe v2", input: ["audio"], output: "text", tools: false, timed: false, context_tokens: null, thinking: [], ready: true, suggested: ["audio"],
      request: { effort: "none" },
    });
    expect(transportSecret("openrouter", {})).toBe("openrouter");
    expect(transportsOf({}).map((each) => each.name)).toEqual(["runner", "claude", "codex", "openrouter"]);
    expect(priced({})).toEqual(["openrouter"]);
    expect(() => readModelSettings({ cap: 8, transports: { "openrouter-voice": { concurrency: 2 } } })).toThrow("model.transports.openrouter-voice: no transport is named openrouter-voice");
    const built = named("openrouter", {}, { held: (name) => name === "openrouter", secret: (name) => (name === "openrouter" ? "synthetic-key" : undefined) });
    expect(await built.available()).toEqual({ ok: true });

    const home = openHome(scratch(), { via: { "elevenlabs/scribe-v2": "openrouter" } });
    const wav = Buffer.from("RIFF synthetic wav bytes");
    const audio = home.blobs.put(wav);
    const note: RoutedAsk = {
      family: "ai", item: `voice:${audio.slice(7)}`, prompt: "transcript", input: said(""), identity: audio.slice(7), attachments: [{ blob: audio, media_type: "audio/wav" }],
      model: "elevenlabs/scribe-v2", effort: "none", work: "voice", source: "ask:synthetic-account",
    };
    const key = (home.asker.request(note) as { send: string }).send;
    expect(await home.call(key, { transport: () => transport })).toMatchObject({ outcome: "replied", sent: true });
    expect(posts).toEqual([{
      url: "https://openrouter.ai/api/v1/audio/transcriptions",
      headers: { Authorization: "Bearer synthetic-key", "content-type": "application/json" },
      body: { model: "elevenlabs/scribe-v2", input_audio: { data: wav.toString("base64"), format: "wav" } },
    }]);
    expect(home.asker.state(note)).toMatchObject({ reply: { text: "a synthetic note's words" } });
    expect(rows(home.path).attempts.map((row) => [row.state, row.cost_usd, row.input_tokens, row.output_tokens])).toEqual([["replied", 0.0015, 12, 6]]);
    home.close();
  });

  it("answers a note with no speech the voice prompt's word: one send, one replied attempt, its cost kept, never a failed try sent again", async () => {
    const { posts, fetcher } = played(() => Response.json({ text: " ", usage: { cost: 0.0004 } }));
    const transport = openRouterTransport({ held: () => true, key: () => "synthetic-key", fetch: fetcher });
    const home = openHome(scratch(), { via: { "elevenlabs/scribe-v2": "openrouter" } });
    const audio = home.blobs.put(Buffer.from("RIFF synthetic silent wav"));
    const note: RoutedAsk = {
      family: "ai", item: `voice:${audio.slice(7)}`, prompt: "transcript", input: said(""), identity: audio.slice(7), attachments: [{ blob: audio, media_type: "audio/wav" }],
      model: "elevenlabs/scribe-v2", effort: "none", work: "voice", source: "ask:synthetic-account",
    };
    const key = (home.asker.request(note) as { send: string }).send;
    expect(await home.call(key, { transport: () => transport })).toMatchObject({ outcome: "replied", sent: true });
    expect(home.asker.state(note)).toMatchObject({ reply: { text: NO_SPEECH } });
    expect([posts.length, rows(home.path).attempts.map((row) => [row.state, row.cost_usd])]).toEqual([1, [["replied", 0.0004]]]);
    home.close();
  });

  it("sends nothing for a request with no note, or with a picture; a limit or an outage is OpenRouter's, a body lost after its answer a try", async () => {
    const signal = new AbortController().signal;
    const dir = mkdtempSync(join(tmpdir(), "lifestream-voice-transport-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const wav = join(dir, "note.wav");
    writeFileSync(wav, "synthetic wav");
    const jpeg = join(dir, "photo.jpg");
    writeFileSync(jpeg, "synthetic jpeg");
    const send = (answer: () => Response, attachments: SendAttachment[] = [{ path: wav, media_type: "audio/wav" }]) => {
      const { posts, fetcher } = played(answer);
      const sending = openRouterTransport({ held: () => true, key: () => "synthetic-key", fetch: fetcher })
        .send({ model: "elevenlabs/scribe-v2", effort: "none", input: "", signal }, attachments);
      return sending.then((sent) => ({ sent, posts: posts.length }), (error: unknown) => ({
        error: error instanceof SendFailed ? { status: error.status, limit: error.limit ?? null } : (error as Error).message, posts: posts.length,
      }));
    };
    const words = () => Response.json({ text: "words" });
    expect(await send(words, [])).toEqual({ error: "openrouter writes out one audio file with elevenlabs/scribe-v2, not 0 audio files", posts: 0 });
    expect(await send(words, [{ path: wav, media_type: "audio/wav" }, { path: jpeg, media_type: "image/jpeg" }])).toEqual({ error: "openrouter writes out one audio file with elevenlabs/scribe-v2, not image/jpeg", posts: 0 });
    expect(await send(words, [{ path: wav, media_type: "audio/wav" }, { path: wav, media_type: "audio/wav" }])).toEqual({ error: "openrouter writes out one audio file with elevenlabs/scribe-v2, not 2 audio files", posts: 0 });
    expect(await send(words)).toEqual({ sent: { text: "words", model: "elevenlabs/scribe-v2" }, posts: 1 });
    expect(await send(() => new Response("slow down", { status: 429 }))).toEqual({ error: { status: 429, limit: {} }, posts: 1 });
    expect(await send(() => new Response("overloaded", { status: 503 }))).toEqual({ error: { status: 503, limit: null }, posts: 1 });
    expect(await send(() => new Response("not json", { status: 200 }))).toEqual({ error: "openrouter reply is not JSON", posts: 1 });
    expect(await send(() => Response.json({ usage: { cost: 0.001 } }))).toEqual({ error: "openrouter reply states no text", posts: 1 });
    expect(await send(() => new Response(new ReadableStream({ start: (stream) => stream.error(new Error("socket hang up")) }), { status: 200 })))
      .toEqual({ error: "openrouter: the answer was lost while it was read: socket hang up", posts: 1 });
    const none = await openRouterTransport({ held: () => false, key: () => undefined }).send({ model: "elevenlabs/scribe-v2", effort: "none", input: "", signal }, [{ path: wav, media_type: "audio/wav" }]).catch((error: unknown) => error);
    expect(none).toMatchObject({ name: "SendFailed", status: null, message: "openrouter has no API key" });
  });
});

interface ClaudeRun {
  result?: string;
  structured_output?: unknown;
  is_error?: boolean;
  api_error_status?: number | null;
  terminal_reason?: string;
  usage?: Record<string, number>;
  limit?: Record<string, unknown> | null;
  then?: Record<string, unknown>;
  dies?: boolean;
  stalls?: boolean;
}

function fakeClaude(root: string, runs: ClaudeRun[]): {
  at: { binary: string; home: string };
  runs(): { args: string[]; env: Record<string, string | null>; whole: Record<string, string>; cwd: string; stdin: unknown[]; pid: number }[];
  probes(): { args: string[]; env: Record<string, string | null>; whole: Record<string, string> }[];
} {
  const folder = join(root, "fake-claude");
  mkdirSync(folder, { recursive: true });
  const script = join(folder, "claude");
  const seen = join(folder, "seen.jsonl");
  const probes = join(folder, "probes.jsonl");
  const count = join(folder, "count");
  writeFileSync(join(folder, "runs.json"), JSON.stringify(runs));
  writeFileSync(script, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const env = Object.fromEntries(["CLAUDE_CONFIG_DIR", "USER", "DISABLE_AUTOUPDATER", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "ENABLE_CLAUDEAI_MCP_SERVERS",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"].map((name) => [name, process.env[name] ?? null]));
if (args[0] === "--version") { process.stdout.write("2.1.321 (Claude Code)\\n"); process.exit(0); }
if (args[0] === "auth") {
  fs.appendFileSync(${JSON.stringify(probes)}, JSON.stringify({ args, env, whole: process.env }) + "\\n");
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));
  process.exit(0);
}
const n = fs.existsSync(${JSON.stringify(count)}) ? Number(fs.readFileSync(${JSON.stringify(count)}, "utf8")) : 0;
fs.writeFileSync(${JSON.stringify(count)}, String(n + 1));
const run = JSON.parse(fs.readFileSync(${JSON.stringify(join(folder, "runs.json"))}, "utf8"))[n] ?? { result: "no run scripted" };
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const stdin = input.split("\\n").filter((line) => line !== "").map((line) => JSON.parse(line));
  fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ args, env, whole: process.env, cwd: process.cwd(), stdin, pid: process.pid }) + "\\n");
  const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  line({ type: "system", subtype: "init", model: "claude-haiku-5-5-20990101", tools: [], apiKeySource: "none" });
  if (run.limit !== null) line({ type: "rate_limit_event", rate_limit_info: run.limit ?? { status: "allowed", resetsAt: ${(T0 + 3 * 24 * HOUR) / 1000}, rateLimitType: "seven_day" } });
  if (run.then !== undefined) line({ type: "rate_limit_event", rate_limit_info: run.then });
  if (run.dies === true) { process.stderr.write("synthetic: killed\\n"); process.exit(137); }
  if (run.stalls === true) return void setInterval(() => undefined, 1 << 30);
  const error = run.is_error === true;
  line({
    type: "result", subtype: "success", is_error: error, api_error_status: run.api_error_status ?? null, terminal_reason: run.terminal_reason ?? (error ? "api_error" : "completed"),
    result: run.result ?? "", ...(run.structured_output === undefined ? {} : { structured_output: run.structured_output }),
    usage: run.usage ?? { input_tokens: 3, output_tokens: 5 }, modelUsage: error ? {} : { "claude-haiku-5-5-20990101": { outputTokens: 5 } }, total_cost_usd: 0.0001,
  });
  process.exit(error ? 1 : 0);
});
`, { mode: 0o755 });
  return {
    at: { binary: script, home: join(root, "claude-home") },
    runs: () => existsSync(seen) ? readFileSync(seen, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [],
    probes: () => existsSync(probes) ? readFileSync(probes, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [],
  };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

interface Home {
  path: string;
  ledger: Ledger;
  asker: Asker;
  prompts: Record<string, Prompt>;
  settings: ModelSettings & { transports: TransportSettings };
  blobs: BlobReader & { put(bytes: Buffer): string };
  sends: { input: string; attachments: { media_type: string; bytes: string }[]; schema?: string }[];
  now(): number;
  advance(ms: number): void;
  transport(options?: FakeOptions): Transport;
  route(key: string, more?: Partial<CallRoute>): CallRoute;
  call(key: string, options?: Partial<CallOptions>): ReturnType<typeof runCall>;
  copy(key: string, receiver: string): number;
  sendable(asks: readonly RoutedAsk[]): string[];
  drain(asks: readonly RoutedAsk[]): Promise<void>;
  close(): void;
}

function openHome(root: string, options: { fake?: FakeOptions; via?: Record<string, string>; draw?: AskerOptions["draw"] } = {}): Home {
  const path = join(root, "replies", "replies.db");
  let now = T0;
  const via: Record<string, string> = { "synthetic/routed": "openrouter", ...options.via };
  const settings: Home["settings"] = {
    cap: 64,
    transports: { fake: { cost_usd: 0 } },
  };
  const ledger = openLedger(openHomeFolder(dirname(dirname(path))), { mode: "migrate" });
  const blobs = memoryBlobs();
  const prompts: Record<string, Prompt> = { ...PROMPTS };
  const asker = openAsker({
    ledger, prompt: (name) => prompts[name]!, blobs, clock: () => now,
    ...(options.draw === undefined ? {} : { draw: options.draw }),
  });
  const sends: Home["sends"] = [];
  const transport = (fake: FakeOptions = options.fake ?? {}): Transport => {
    const inner = fakeTransport(fake);
    return {
      ...inner,
      send: async (request: SendRequest, attachments: SendAttachment[]) => {
        if (fake.unavailable === undefined) {
          sends.push({
            input: request.input, attachments: attachments.map((file) => ({ media_type: file.media_type, bytes: readFileSync(file.path, "utf8") })),
            ...(request.schema === undefined ? {} : { schema: readFileSync(request.schema, "utf8") }),
          });
        }
        return inner.send(request, attachments);
      },
    };
  };
  const route = (key: string, more: Partial<CallRoute> = {}): CallRoute => ({ transport: via[ledger.row(key)!.model] ?? "fake", timeout_ms: 120_000, ...more });
  const copy = (key: string, receiver: string): number => {
    const made = ledger.sent.make({ key, receiver, route: "test", level: "none", body: null, pictures: [], counts: {}, detector: null }, now, ledger.placeholders.epoch().epoch);
    if (!("id" in made)) throw new Error(`no copy of ${key}`);
    return made.id;
  };
  const call = (key: string, overrides: Partial<CallOptions> = {}) => {
    const options: CallOptions = { folder: openHomeFolder(dirname(dirname(path))), key, route: route(key), transports: settings.transports, copies: join(dirname(path), "calls"), clock: () => now, transport: () => transport(), blobs, ...overrides };
    const built = options.transport!(options.route.transport);
    const leaves = options.sentCopy === undefined ? built.leaves : null;
    return runCall({ ...options, transport: () => built, ...(leaves === null ? {} : { sentCopy: copy(key, leaves) }) });
  };
  const sendable = (asks: readonly RoutedAsk[]) => {
    const resting = ledger.resting(now);
    const keys: string[] = [];
    for (const ask of asks) {
      if (resting.has(via[ask.model] ?? "fake")) continue;
      const request = asker.request(ask);
      if ("send" in request && !keys.includes(request.send)) keys.push(request.send);
    }
    return keys;
  };
  return {
    path, ledger, asker, prompts, settings, blobs, sends, transport, route, call, copy, sendable,
    now: () => now,
    advance: (ms) => { now += ms; },
    async drain(asks) {
      for (let round = 0; round < 50; round++) {
        const keys = sendable(asks);
        if (keys.length === 0) return;
        for (const key of keys) await call(key);
      }
      throw new Error("asks stayed sendable after 50 rounds");
    },
    close: () => {
      expect(repliesWithoutAttempts(path)).toEqual([]);
      ledger.close();
    },
  };
}

function memoryBlobs(): BlobReader & { put(bytes: Buffer): string } {
  const held = new Map<string, Buffer>();
  const get = (hash: string) => {
    const bytes = held.get(hash);
    if (bytes === undefined) throw new Error(`no blob ${hash}`);
    return bytes;
  };
  return {
    put(bytes) {
      const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      held.set(hash, bytes);
      return hash;
    },
    has: (hash) => held.has(hash),
    bytes: get,
    text: (hash) => get(hash).toString("utf8"),
    prefix: (hash, bytes) => get(hash).subarray(0, bytes),
    materialise() { throw new Error("not used by the model package"); },
  };
}

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "model-e2e-"));
  roots.push(root);
  return root;
}

function carry(path: string, from: string, to: { key: string; prompt: string; version: number; input_hash: string; unit: string }): void {
  const db = new Database(path);
  try {
    db.prepare(`INSERT INTO replies(key, model, prompt, prompt_version, prompt_hash, input_hash, effort, sampling, output_schema, text,
        reply_model, invocation, runtime, input_tokens, output_tokens, cost_usd, validation, validated_at, created, source, feeder, unit)
      SELECT ?, model, ?, ?, prompt_hash, ?, effort, sampling, output_schema, text, reply_model, 'carry ' || key, runtime, NULL, NULL, NULL,
        validation, validated_at, created, NULL, NULL, ? FROM replies WHERE key = ?`).run(to.key, to.prompt, to.version, to.input_hash, to.unit, from);
  } finally {
    db.close();
  }
}

function todaysLedger(path: string, fill: (db: Database.Database) => void): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(TODAYS_SHAPE);
  fill(db);
  db.exec(TO_VERSION_3);
  db.close();
}

function oldRequest(db: Database.Database, row: { key: string; family: string; unit: string; model: string; effort: string; input_hash: string; body: string; transport: string }): void {
  db.prepare(`INSERT INTO requests VALUES (?, ?, 'synthesis:photos', ?, ?, ?, ?, NULL, ?, ?, ?, ?, '[]', '2026-09-20T10:00:00.000Z', 0)`)
    .run(row.key, row.family, row.unit, `sha256:${"e".repeat(64)}`, row.model, row.effort, row.transport, GOLDEN.prompt_hash, row.input_hash, row.body);
}

function oldReply(db: Database.Database, row: { key: string; model: string; effort: string; input_hash: string; text: string; validation: "accepted" | "refused" | null }): void {
  db.prepare(`INSERT INTO attempts(key, state, started, finished, validation) VALUES (?, 'replied', '2026-09-20T10:00:01.000Z', '2026-09-20T10:00:05.000Z', ?)`)
    .run(row.key, row.validation);
  db.prepare(`INSERT INTO replies VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, 'codex exec', 'codex CLI', NULL, NULL, NULL, ?, ?,
      '2026-09-20T10:00:05.000Z', 'interp:photos', 'synthesis:photos', 'photo:synthetic')`)
    .run(row.key, row.model, GOLDEN.prompt_hash, row.input_hash, row.effort, row.text, row.model, row.validation,
      row.validation === null ? null : "2026-09-20T10:00:06.000Z");
}

function schemaOf(path: string): unknown[] {
  const db = new Database(path, { readonly: true });
  try { return db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(); } finally { db.close(); }
}

function rows(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    const all = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
    return {
      meta: all("SELECT * FROM meta ORDER BY key"),
      prompts: all("SELECT hash, version FROM prompts ORDER BY hash"),
      requests: all("SELECT key, family, unit, revision, model, effort, sampling, transport, input_hash, attachments, requested, open, length(body) AS body_chars FROM requests ORDER BY rowid"),
      attempts: all("SELECT * FROM attempts ORDER BY id"),
      replies: all("SELECT key, model, input_hash, text, validation, validated_at, cost_usd, created FROM replies ORDER BY created, key"),
      unit_failures: all("SELECT * FROM unit_failures ORDER BY id"),
      outcomes: all("SELECT * FROM outcomes ORDER BY seq"),
    };
  } finally { db.close(); }
}

function repliesWithoutAttempts(path: string): unknown[] {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare(`SELECT key FROM replies WHERE key NOT IN (SELECT key FROM attempts WHERE state = 'replied')
      AND (invocation IS NULL OR invocation NOT LIKE 'carry %' OR substr(invocation, 7) NOT IN (SELECT key FROM attempts WHERE state = 'replied'))`).all();
  } finally { db.close(); }
}

function artifact(name: string, path: string): void {
  mkdirSync(ARTIFACTS, { recursive: true });
  const file = join(ARTIFACTS, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(rows(path), null, 2)}\n`);
  expect(existsSync(file)).toBe(true);
}

const WAIT_MS = 30_000;

function named(name: string, transports?: TransportSettings, found: Found = {}): Transport {
  const transport = transportsOf(transports, found).find((each) => each.name === name);
  if (transport === undefined) throw new TypeError(`no transport is named ${name}`);
  return transport;
}

const DRIVE = "synthetic-drive-pass";
const CALL = "synthetic-call-pass";
const RUNNER_UNIT = "runner-macbook-pro-0001";
const RUNNER_NOW = Date.UTC(2026, 10, 11, 12, 0);
type Held = RunnerListing["files"][number];
const file = (id: string, state: Held["state"], extra: Partial<Held> = {}): Held => ({
  id, name: `Model ${id}`, input: ["text", "image"], output: "text", tools: false, timed: false, context_tokens: 4_000, thinking: [], bytes: 4_000_000_000, languages: [], memory_gb: 16, state, fetched_bytes: 0, failure: null, ...extra,
});
const runner = (present: boolean, files: Held[], slots = 1): RunnerListing => ({
  unit: RUNNER_UNIT, name: "MacBook Pro", version: "1", boot: "boot-a", slots, power: "mains", idle_s: null, thermal: null, memory_gb: 16, running: [], files, present,
});

async function fakeDoor() {
  const state: { listed: RunnerListing[]; end: { status: number; body: RunnerEnded | { code: string; message: string } } | "hold" | "cut"; placed: RunnerPlaced[]; closed: number } = {
    listed: [], end: { status: 200, body: { ok: { text: "a synthetic caption", model: "qwen3.5-4b", input_tokens: 9 } } }, placed: [], closed: 0,
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.headers.authorization !== `Bearer ${request.method === "GET" ? DRIVE : CALL}`) return void response.writeHead(401).end(JSON.stringify({ code: "PRINCIPAL_UNKNOWN", message: "no such pass" }));
    if (request.method === "GET" && request.url === "/v1/runners") return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ runners: state.listed, below: [] }));
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      state.placed.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as RunnerPlaced);
      const { end } = state;
      if (end === "cut") return void request.socket.destroy();
      if (end !== "hold" && end.status !== 200) return void response.writeHead(end.status, { "content-type": "application/json" }).end(JSON.stringify(end.body));
      response.writeHead(200, { "content-type": "application/json" });
      response.write("\n");
      if (end === "hold") return void response.once("close", () => { state.closed++; });
      response.end(JSON.stringify(end.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state };
}

const request = (signal: AbortSignal, extra: Partial<SendRequest> = {}): SendRequest =>
  ({ model: "qwen3.5-4b", effort: "none", input: "Describe this photo.", runner: RUNNER_UNIT, signal, ...extra });

async function ended(send: Promise<unknown>): Promise<unknown> {
  try {
    return { answered: await send };
  } catch (error) {
    if (!(error instanceof SendFailed)) return { request: (error as Error).message };
    return { rests: error.scope ?? "transport", ...(error.until_ms === undefined ? {} : { for_ms: error.until_ms - RUNNER_NOW }) };
  }
}

async function until(what: string, ready: () => boolean): Promise<void> {
  const end = Date.now() + WAIT_MS;
  while (!ready()) {
    if (Date.now() > end) throw new Error(`never came in ${WAIT_MS / 1_000} s: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
