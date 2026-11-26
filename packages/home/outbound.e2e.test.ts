import { mkdirSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { civilDay, dayBounds, DETAIL_WORDS, hideDetails, openHomeFolder, tryLock, wantedOf, type Marked } from "@lifestreamprotocol/core";
import { callsLock, openLedger, type NewOutbound } from "@lifestreamprotocol/model";
import { QUIET, serveDoor } from "./door.js";
import { mintPrincipal } from "./principals.js";
import { Refusal, UNWRITABLE } from "./refusal.js";
import { openWriter } from "./writers.js";
import { cleanup, makeHome, makeHomeDb, NOW_MS } from "./test/support.js";

const roots: string[] = [];
afterAll(() => cleanup(roots));
const DAY = { zone: "UTC", day_start_hour: 4 };

function row(at_ms: number, more: Partial<NewOutbound> = {}): NewOutbound {
  return {
    at_ms, receiver: "OpenAI", route: "codex", by: null, what: "ask", tool: null, level: "all", counts: { person: 2 }, chars: 300, pictures: 0,
    key: "sha256:req-1", attempt: 1, ...more,
  };
}

function rows(root: string): number {
  const db = new Database(join(root, "replies", "replies.db"), { readonly: true });
  try {
    return db.prepare("SELECT count(*) FROM outbound").pluck().get() as number;
  } finally {
    db.close();
  }
}

async function settled<T>(promise: Promise<T>): Promise<T | { status: number; code: string; words: string }> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof Refusal) return { status: error.status, code: error.code, words: error.words };
    throw error;
  }
}

describe("the door's writer", () => {
  it("O1-O4: commits each write before it answers, holds still while the calls' lock is held, answers the one 503 for a ledger it cannot open and writes once it can, and keeps a part's shape", async () => {
    const home = makeHome({}, roots);
    const ledger = join(home.root, "replies", "replies.db");
    const logs: string[] = [];
    const writer = openWriter(openHomeFolder(home.root), join(home.root, "machine"), QUIET, (line) => logs.push(JSON.stringify(line)));
    onTestFinished(() => writer.close());

    renameSync(ledger, `${ledger}.aside`);
    mkdirSync(ledger);
    expect(await settled(writer.outbound(row(NOW_MS)))).toEqual({ status: 503, code: "NOT_NOW", words: UNWRITABLE });
    expect(await settled(writer.list({ from: "2026-09-08", to: "2026-09-08", day: DAY }))).toMatchObject({ status: 503 });
    expect(logs.some((line) => line.includes('"writer":"failed"'))).toBe(true);
    rmdirSync(ledger);
    renameSync(`${ledger}.aside`, ledger);

    expect(await writer.outbound(row(NOW_MS))).toBe(1);
    expect(rows(home.root)).toBe(1);

    const move = tryLock(callsLock(ledger))!;
    try {
      expect(await settled(writer.outbound(row(NOW_MS + 1)))).toEqual({ status: 503, code: "NOT_NOW", words: QUIET });
      expect(rows(home.root)).toBe(1);
      expect((await writer.list({ from: "2026-09-08", to: "2026-09-08", day: DAY })).rows).toHaveLength(1);
    } finally {
      move.release();
    }

    const texts: Marked[] = [{ text: "Ada Example", marks: [{ start: 0, end: 11, type: "person", who: "p-1" }] }];
    const part = await writer.part("chat:c1", wantedOf(texts));
    expect(part).toEqual({ table: { scope: "chat:c1", entries: [], next: {} }, epoch: 0, version: 0 });
    const hidden = hideDetails(texts, "all", part.table, null);
    expect(await writer.save(part, hidden.table, row(NOW_MS + 2, { what: "text", key: null, attempt: null, by: "p-reader" }))).toEqual({ saved: true, seq: 2 });
    expect(await writer.save(part, hidden.table)).toEqual({ stale: true });
    expect((await writer.part("chat:c1", wantedOf(texts))).table.entries).toEqual([{ placeholder: "[[Person 1]]", type: "person", detail: "Ada Example", who: "p-1" }]);
    const before = await writer.part("chat:c2", wantedOf(texts));
    const erasing = openLedger(openHomeFolder(dirname(dirname(ledger))), { mode: "write" });
    try {
      erasing.placeholders.beginErasure();
      erasing.forget([]);
      expect(await writer.epoch()).toEqual({ epoch: 1, erasing: true });
      const during = await writer.part("chat:c2", wantedOf(texts));
      expect(await writer.save(during, hideDetails(texts, "all", during.table, null).table)).toEqual({ erased: true });
      erasing.placeholders.endErasure();
    } finally {
      erasing.close();
    }
    expect(await writer.save(before, hideDetails(texts, "all", before.table, null).table)).toEqual({ erased: true });
    expect(await writer.epoch()).toEqual({ epoch: 2, erasing: false });
    expect((await writer.part("chat:c2", wantedOf(texts))).epoch).toBe(2);
    expect(await settled(writer.list({ from: "2026-09-09", to: "2026-09-08", day: DAY }))).toMatchObject({ status: 422, code: "BAD_REQUEST" });
  });
});

describe("GET /v1/outbound", () => {
  it("O3, O5, O6, O7, P1: answers the person's own passes the rows and totals of a range of days, where one record went and where one item was sent, one row with its refs, and refuses an agent's pass and a pass that does not read; GET /v1/privacy carries its words", async () => {
    const home = makeHome({ reader: { scopes: ["read"] }, mac: { kind: "mac", scopes: ["deliver"], sources: ["machine:local:mac"] } }, roots);
    const agent = mintPrincipal(openHomeFolder(home.root), {
      unit: "agent", kind: "agent", scopes: ["read"], now_ms: NOW_MS, token: "synthetic-token-agent".padEnd(43, "x").slice(0, 43),
      granted: { agent: { name: "Vault App", via: "pass", from: null, checked: false, client_id: null, resource: null } },
    });
    const today = civilDay(Date.now(), DAY);
    const at = dayBounds(today, DAY).start_ms;
    const ledger = openLedger(openHomeFolder(home.root), { mode: "write" });
    try {
      const db = new Database(join(home.root, "replies", "replies.db"));
      db.prepare("INSERT INTO prompts(hash, version, text) VALUES ('sha256:prompt', '1', 'Describe the photo.')").run();
      const request = db.prepare(`INSERT INTO requests(key, family, unit, model, effort, transport, prompt_hash, input_hash, body, attachments, requested)
        VALUES (?, ?, ?, 'fake-model', 'low', 'codex', 'sha256:prompt', ?, 'a body', '[]', '2026-09-08T04:00:00.000Z')`);
      request.run("sha256:req-1", "photos", "photo:aa", "sha256:input-1");
      request.run("sha256:req-old", "photos", "photo:bb", "sha256:input-2");
      request.run("sha256:req-mail", "mail", "photo:aa", "sha256:input-3");
      db.close();
      ledger.outbound.write(row(at + 1_000));
      ledger.outbound.write(row(at + 2_000, { attempt: 2 }));
      ledger.outbound.write(row(at + 3_000, {
        receiver: "Vault App", by: agent.principal.id, what: "read", tool: "day", level: "names", counts: { email: 1 }, key: null, attempt: null,
        refs: [{ day: "2026-09-08" }, { source: "gmail:person-a@example.com", kind: "message", key: "m-1" }],
      }));
      ledger.outbound.write(row(dayBounds("2026-09-08", DAY).start_ms, { key: "sha256:req-old" }));
      ledger.outbound.write(row(dayBounds("2026-09-08", DAY).start_ms + 1_000, {
        receiver: "Vault App", by: agent.principal.id, what: "read", tool: "record", level: "names", counts: {}, key: null, attempt: null,
        refs: [{ source: "gmail:person-a@example.com", kind: "message", key: "m-1" }, { source: "gmail:person-a@example.com", kind: "message", key: "m-2" }],
      }));
    } finally {
      ledger.close();
    }
    makeHomeDb(join(home.root, "home.db")).close();
    const logs: string[] = [];
    const door = await serveDoor(home.root, { port: 0, max_bundle_bytes: 1 << 20 }, { log: (line) => logs.push(line), floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" } });
    let open = true;
    onTestFinished(() => (open ? door.close() : undefined));
    const get = async (path: string, who: "reader" | "mac" | "agent" = "reader") => {
      const token = who === "agent" ? agent.token : home.tokens[who];
      const response = await fetch(`http://127.0.0.1:${door.port}${path}`, { headers: { authorization: `Bearer ${token}`, ...(who === "mac" ? { "lifestream-device": "mac/1.0.0" } : {}) } });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };

    const listed = await get("/v1/outbound");
    expect(listed.status).toBe(200);
    expect(listed.body.rows.map((each: { seq: number; refs: number }) => [each.seq, each.refs])).toEqual([[3, 2], [2, 0], [1, 0]]);
    expect(listed.body.totals).toEqual([
      { receiver: "OpenAI", day: today, items: 1, hidden: 4, counts: { person: 4 }, rows: { ask: 2 } },
      { receiver: "Vault App", day: today, items: 1, hidden: 1, counts: { email: 1 }, rows: { read: 1 } },
    ]);
    expect(listed.body.more).toBe(false);
    expect((await get(`/v1/outbound?from=2026-09-08&to=${today}&receiver=OpenAI`)).body.rows.map((each: { seq: number }) => each.seq)).toEqual([4, 2, 1]);
    expect((await get("/v1/outbound?from=2026-09-08")).body.rows.map((each: { seq: number }) => each.seq)).toEqual([5, 4]);
    expect((await get("/v1/outbound?before=3")).body.rows.map((each: { seq: number }) => each.seq)).toEqual([2, 1]);
    expect((await get("/v1/outbound/3")).body).toMatchObject({ seq: 3, receiver: "Vault App", what: "read", tool: "day", refs: [{ day: "2026-09-08" }, { source: "gmail:person-a@example.com", kind: "message", key: "m-1" }], sent: null });
    expect(await get("/v1/outbound/99")).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
    const m1 = "/v1/outbound?source=gmail:person-a@example.com&kind=message&key=m-1";
    const carried = await get(m1);
    expect(carried.status).toBe(200);
    expect(Object.keys(carried.body)).toEqual(["rows"]);
    expect(carried.body.rows.map((each: { seq: number; day: string; refs: number }) => [each.seq, each.day, each.refs])).toEqual([[5, "2026-09-08", 2], [3, today, 2]]);
    expect(carried.body.rows[1]).toEqual(listed.body.rows[0]);
    expect((await get("/v1/outbound?source=gmail:person-a@example.com&kind=message&key=m-2")).body.rows.map((each: { seq: number }) => each.seq)).toEqual([5]);
    expect((await get("/v1/outbound?source=gmail:person-a@example.com&kind=message&key=m-9")).body).toEqual({ rows: [] });
    expect(await get("/v1/outbound?source=gmail:person-a@example.com&kind=message")).toMatchObject({ status: 422, body: { code: "BAD_REQUEST" } });
    expect(await get(`${m1}&from=2026-09-08`)).toMatchObject({ status: 422, body: { code: "BAD_REQUEST" } });
    expect((await get(m1, "agent")).status).toBe(403);
    const aa = await get("/v1/outbound?family=photos&item=photo:aa");
    expect(aa.status).toBe(200);
    expect(aa.body.rows.map((each: { seq: number; what: string; attempt: number }) => [each.seq, each.what, each.attempt])).toEqual([[2, "ask", 2], [1, "ask", 1]]);
    expect(aa.body.rows[1]).toEqual(listed.body.rows[2]);
    expect((await get("/v1/outbound?family=photos&item=photo:bb")).body.rows.map((each: { seq: number }) => each.seq)).toEqual([4]);
    expect((await get("/v1/outbound?family=mail&item=photo:aa")).body).toEqual({ rows: [] });
    expect(await get("/v1/outbound?family=photos")).toMatchObject({ status: 422, body: { code: "BAD_REQUEST" } });
    expect(await get("/v1/outbound?family=photos&item=photo:aa&source=gmail:person-a@example.com&kind=message&key=m-1")).toMatchObject({ status: 422, body: { code: "BAD_REQUEST" } });
    expect(await get("/v1/outbound?family=photos&item=photo:aa&before=3")).toMatchObject({ status: 422, body: { code: "BAD_REQUEST" } });
    expect((await get("/v1/outbound?family=photos&item=photo:aa", "agent")).status).toBe(403);
    const privacy = await get("/v1/privacy");
    expect(privacy.status).toBe(200);
    expect(privacy.body.types).toEqual(DETAIL_WORDS);
    expect(privacy.body.detector).toEqual({ model: null, runner: "off", state: "off", line: null, file: null });
    expect((await get("/v1/outbound?from=2026-9-8")).status).toBe(422);
    expect((await get("/v1/outbound?before=x")).status).toBe(422);
    expect((await get("/v1/outbound?before=1234567890123456")).status).toBe(422);
    expect((await get("/v1/outbound", "agent")).status).toBe(403);
    expect((await get("/v1/outbound/1", "agent")).status).toBe(403);
    expect((await get("/v1/outbound", "mac")).body).toMatchObject({ code: "PRINCIPAL_SCOPE" });

    rmSync(join(home.root, "replies", "replies.db"));
    rmSync(join(home.root, "replies", "replies.db-wal"), { force: true });
    rmSync(join(home.root, "replies", "replies.db-shm"), { force: true });
    mkdirSync(join(home.root, "replies", "replies.db"));
    open = false;
    await door.close();
    const again = await serveDoor(home.root, { port: 0, max_bundle_bytes: 1 << 20 }, { log: (line) => logs.push(line), floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" } });
    onTestFinished(() => again.close());
    const broken = await fetch(`http://127.0.0.1:${again.port}/v1/outbound`, { headers: { authorization: `Bearer ${home.tokens.reader}` } });
    expect([broken.status, ((await broken.json()) as { message: string }).message]).toEqual([503, UNWRITABLE]);
  });
});
