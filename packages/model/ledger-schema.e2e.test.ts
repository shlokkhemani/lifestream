import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { normalised, openHomeFolder, Schema, type HomeFolder, type JsonObject, type Migration } from "@lifestreamprotocol/core";
import { keyedFolder } from "@lifestreamprotocol/core/test/keyed";
import { afterAll, describe, expect, it } from "vitest";
import { LEDGER_MIGRATED, LEDGER_STORE, ledgerSchema, openLedger } from "./ledger.js";

const FIXTURE = JSON.parse(readFileSync(new URL("./test/ledger-v3.json", import.meta.url), "utf8")) as {
  meta: { key: string; value: string }[];
  objects: { type: string; name: string; sql: string }[];
};
const LATEST = ledgerSchema.latest;

const dir = mkdtempSync(join(tmpdir(), "model-ledger-schema-"));
const found: Record<string, unknown> = {};
afterAll(() => {
  writeFileSync(join(tmpdir(), "model-ledger-schema.json"), `${JSON.stringify(found, null, 2)}\n`);
  rmSync(dir, { recursive: true, force: true });
});

let files = 0;
function fresh(): string {
  const folder = join(dir, `home-${files++}`, "replies");
  mkdirSync(folder, { recursive: true });
  return join(folder, "replies.db");
}
function raw<T>(path: string, work: (db: Database.Database) => T): T {
  const db = new Database(path);
  try {
    return work(db);
  } finally {
    db.close();
  }
}

function withRequest(): string {
  const path = fresh();
  openLedger(openHomeFolder(dirname(dirname(path))), { mode: "migrate" }).close();
  raw(path, (db) => {
    db.prepare("INSERT INTO prompts (hash, version, text) VALUES ('sha256:prompt-a', 'photos/caption-v1', 'Caption this synthetic photo.')").run();
    db.prepare(`INSERT INTO requests (key, unit, model, effort, transport, prompt_hash, input_hash, body, attachments, requested)
      VALUES ('request-a', 'photo:synthetic-1', 'synthetic/model-a', 'none', 'fake', 'sha256:prompt-a', 'sha256:input-a', 'body', '[]', '2026-10-03T06:00:00.000Z')`).run();
  });
  return path;
}

function upTo(version: number): Schema {
  return new Schema({
    name: ledgerSchema.name, file: ledgerSchema.file, base: ledgerSchema.base, baseline: ledgerSchema.baseline,
    migrations: ledgerSchema.migrations.slice(0, version - ledgerSchema.base), small: [...ledgerSchema.small], foreignKeys: true,
  });
}

function withMore(...more: Migration[]): Schema {
  return new Schema({
    name: ledgerSchema.name, file: ledgerSchema.file, base: ledgerSchema.base, baseline: ledgerSchema.baseline,
    migrations: [...ledgerSchema.migrations, ...more], small: [...ledgerSchema.small], foreignKeys: true,
  });
}

function everything(path: string): JsonObject {
  return raw(path, (db) => {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all() as string[];
    return {
      version: db.pragma("user_version", { simple: true }) as number,
      schema: db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all() as JsonObject[],
      rows: Object.fromEntries(tables.map((table) => {
        const keyed = db.prepare("SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = ?").pluck().get(table) === 1;
        return [table, db.prepare(`SELECT * FROM "${table}"${keyed ? "" : " ORDER BY rowid"}`).all() as JsonObject[]];
      })),
    } as JsonObject;
  });
}

describe("the ledger's version", () => {
  it("the baseline is not the ledger the scheme of numbered steps left at 3", () => {
    const fixture = Object.fromEntries(FIXTURE.objects.map((object) => [`${object.type} ${object.name}`, normalised(object.sql)]));
    expect(Object.fromEntries(ledgerSchema.expected(ledgerSchema.base))).toEqual(fixture);
    expect(FIXTURE.meta.map((row) => row.key)).toEqual(["steps", "writer"]);
  });

  it("a migration that rebuilds a table a foreign key names cannot run", () => {
    const path = withRequest();
    const rebuild = withMore((db) => db.exec(`CREATE TABLE prompts_new(hash TEXT PRIMARY KEY, version TEXT NOT NULL, text TEXT NOT NULL);
      INSERT INTO prompts_new SELECT * FROM prompts;
      DROP TABLE prompts;
      ALTER TABLE prompts_new RENAME TO prompts`));
    const log: JsonObject[] = [];
    const db = new Database(path);
    try {
      expect(rebuild.open(db, "migrate", (line) => log.push(line))).toMatchObject({ from: LATEST, to: LATEST + 1 });
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      db.close();
    }
    expect(log.map((line) => line.home)).toEqual(["migrating", "migrated"]);
    expect(raw(path, (file) => file.prepare("SELECT key, prompt_hash FROM requests").all())).toEqual([{ key: "request-a", prompt_hash: "sha256:prompt-a" }]);
    found.rebuilt = log;
  });

  it("a migration that leaves a row naming a gone parent commits", () => {
    const path = withRequest();
    const before = everything(path);
    const orphaning = withMore((db) => db.exec("DELETE FROM prompts"));
    const log: JsonObject[] = [];
    const db = new Database(path);
    try {
      expect(() => orphaning.open(db, "migrate", (line) => log.push(line))).toThrow(`the ledger migrated to version ${LATEST + 1} has a row of requests whose prompts is gone`);
    } finally {
      db.close();
    }
    expect(everything(path)).toEqual(before);
    expect(log.map((line) => line.home)).toEqual(["migrating", "migration_failed"]);
    found.orphan = log;
  });

  it("a call that opened before the home migrated the ledger writes into it after", () => {
    const path = fresh();
    openLedger(openHomeFolder(dirname(dirname(path))), { mode: "migrate" }).close();
    const call = openLedger(openHomeFolder(dirname(dirname(path))), { mode: "write" });
    raw(path, (db) => db.pragma(`user_version = ${LATEST + 1}`));
    const before = everything(path);
    let thrown: unknown;
    try {
      call.rest("fake", { until_ms: 1, resets_ms: null, cause: "limit", reason: "a synthetic limit" }, 0);
    } catch (error) {
      thrown = error;
    } finally {
      call.close();
    }
    expect(thrown).toMatchObject({ code: LEDGER_MIGRATED, message: `the ledger is at version ${LATEST + 1} since this connection opened it at ${LATEST}: a newer release's home migrated it` });
    expect(everything(path)).toEqual(before);
    for (const mode of ["migrate", "write", "read"] as const) {
      expect(() => openLedger(openHomeFolder(dirname(dirname(path))), { mode }), mode).toThrow(`the ledger is at version ${LATEST + 1}; this release reads ${LATEST}: a newer release wrote it`);
    }
  });

  it("migration 7 changes a row of a ledger at 6, or leaves a table of the access log missing or not empty", () => {
    const path = fresh();
    raw(path, (db) => upTo(6).open(db, "migrate"));
    raw(path, (db) => db.exec(`INSERT INTO prompts (hash, version, text) VALUES ('sha256:prompt-a', 'v1', 'Caption this synthetic photo.');
      INSERT INTO outbound (at_ms, receiver, route, by, what, tool, level, counts, chars, pictures, detector, key, attempt)
        VALUES (1, 'Agent App', NULL, 'p-1a2b3c4d', 'read', 'read', 'names', '{}', 10, 0, NULL, NULL, NULL);
      INSERT INTO outbound_refs (outbound, source, kind, key, day) VALUES (1, NULL, NULL, NULL, '2026-11-13')`));
    const before = everything(path);
    raw(path, (db) => upTo(7).open(db, "migrate"));
    const after = everything(path);
    expect(after.version).toBe(7);
    const tables = ["access", "access_changes", "access_requests", "access_moved", "calls", "call_withheld", "outbound_calls"];
    const rows = after.rows as Record<string, JsonObject[]>;
    for (const table of tables) expect(rows[table], table).toEqual([]);
    expect(Object.fromEntries(Object.entries(rows).filter(([table]) => !tables.includes(table) && table !== "sqlite_sequence"))).toEqual(before.rows);
    found.access = (after.schema as JsonObject[]).filter((object) => tables.some((table) => String(object.name).startsWith(table)));
  });

  it("migration 8 changes a row of a ledger at 7, or leaves placeholder_levels missing or not empty; a start moves a level kept", () => {
    const path = fresh();
    raw(path, (db) => upTo(7).open(db, "migrate"));
    raw(path, (db) => db.exec(`INSERT INTO placeholder_tables (scope, next, version) VALUES ('chat:c1', '{"person":2}', 1);
      INSERT INTO placeholder_entries (scope, placeholder, type, detail, key) VALUES ('chat:c1', '[[Person 1]]', 'person', 'p-ada', 'person:p-ada')`));
    const before = everything(path);
    openLedger(openHomeFolder(dirname(dirname(path))), { mode: "migrate" }).close();
    const after = everything(path);
    expect(after.version).toBe(LATEST);
    const rows = after.rows as Record<string, JsonObject[]>;
    expect(rows.placeholder_levels).toEqual([]);
    expect(Object.fromEntries(Object.entries(rows).filter(([table]) => !["placeholder_levels", "unlisted", "reader_reads", "reader_kinds", "call_came", "call_code", "call_opened", "call_items"].includes(table)))).toEqual(before.rows);
    found.levels = (after.schema as JsonObject[]).filter((object) => String(object.name).startsWith("placeholder_levels"));

    const ledger = openLedger(openHomeFolder(dirname(dirname(path))), { mode: "write" });
    try {
      const { placeholders } = ledger;
      expect(placeholders.keptLevel("chat:c1")).toBeNull();
      expect(placeholders.keepLevel("chat:c1", "all", true)).toBe("all");
      expect(placeholders.keepLevel("chat:c1", "none", true)).toBe("all");
      expect(placeholders.keepLevel("chat:c2", "names", true)).toBe("names");
      expect(placeholders.keepLevel("chat:c1", "none", false)).toBe("none");
      expect([placeholders.keptLevel("chat:c1"), placeholders.keptLevel("chat:c2")]).toEqual(["none", "names"]);
      expect(() => placeholders.keepLevel("chat:c1", "some" as never, false)).toThrow(RangeError);
      placeholders.beginErasure();
      ledger.forget([]);
      placeholders.endErasure();
      expect(placeholders.keptLevel("chat:c1")).toBe("none");
      expect(raw(path, (db) => db.prepare("SELECT count(*) AS n FROM placeholder_entries").get())).toEqual({ n: 0 });
    } finally {
      ledger.close();
    }
  });

  it("migration 9 marks each request Chat or the person proposed as Chat's, changes no other row, and lets one of each maker stand open per reader", () => {
    const path = fresh();
    raw(path, (db) => upTo(8).open(db, "migrate"));
    raw(path, (db) => db.exec(`INSERT INTO access_requests (id, reader, at_ms, want, want_key, reason, for_ms, state, answered_ms, device, told_ms) VALUES
        ('rq-a', 'p-1a2b3c4d', 1, '{"read":"everything","window":null}', 'k-a', 'Why.', 3600000, 'declined', 2, NULL, NULL),
        ('rq-b', 'p-1a2b3c4d', 3, '{"access":{}}', 'k-b', '', NULL, 'open', NULL, NULL, NULL),
        ('rq-c', 'ask', 4, NULL, NULL, '', NULL, 'replaced', 5, NULL, NULL);
      INSERT INTO access_changes (at_ms, reader, version, what, by, device, request, lines, about) VALUES
        (1, 'p-1a2b3c4d', 0, 'requested', 'agent', NULL, 'rq-a', NULL, NULL),
        (3, 'p-1a2b3c4d', 0, 'requested', 'chat', NULL, 'rq-b', NULL, NULL),
        (4, 'ask', 0, 'requested', 'person', 'pass-phone-7', 'rq-c', NULL, NULL)`));
    const before = everything(path);
    raw(path, (db) => upTo(9).open(db, "migrate"));
    const after = everything(path);
    expect(after.version).toBe(9);
    const rows = after.rows as Record<string, JsonObject[]>;
    const was = before.rows as Record<string, JsonObject[]>;
    expect(rows.access_requests!.map((each) => [each.id, each.by])).toEqual([["rq-a", "agent"], ["rq-b", "chat"], ["rq-c", "chat"]]);
    expect(rows.access_requests!.map(({ by: _by, ...each }) => each)).toEqual(was.access_requests);
    expect(Object.fromEntries(Object.entries(rows).filter(([table]) => table !== "access_requests"))).toEqual(Object.fromEntries(Object.entries(was).filter(([table]) => table !== "access_requests")));
    raw(path, (db) => {
      db.exec(`INSERT INTO access_requests (id, reader, by, at_ms, want, want_key, reason, for_ms, state) VALUES ('rq-d', 'p-1a2b3c4d', 'agent', 6, '{}', 'k-d', 'Why.', NULL, 'open')`);
      expect(() => db.exec(`INSERT INTO access_requests (id, reader, by, at_ms, want, want_key, reason, for_ms, state) VALUES ('rq-e', 'p-1a2b3c4d', 'chat', 7, '{}', 'k-e', '', NULL, 'open')`)).toThrow(/UNIQUE/u);
      expect(() => db.exec(`INSERT INTO access_requests (id, reader, by, at_ms, want, want_key, reason, for_ms, state) VALUES ('rq-f', 'p-1a2b3c4d', 'person', 7, '{}', 'k-f', '', NULL, 'open')`)).toThrow(/CHECK/u);
    });
    found.makers = (after.schema as JsonObject[]).filter((object) => String(object.name).startsWith("access_requests"));
  });

  it("migration 10 writes no row of calls, makes call_came and unlisted empty and counts each reader's reads: answered, never access or feedback; migration 11 indexes the reads alone", () => {
    const path = fresh();
    raw(path, (db) => upTo(9).open(db, "migrate"));
    raw(path, (db) => db.exec(`INSERT INTO calls (id, at_ms, reader, session, access_version, tool, sent, read, result, words, ms, epoch) VALUES
        ('call-a', 1, 'p-1a2b3c4d', 1, 1, 'search', '{"query":"dinner"}', 'null', 'answered', NULL, 5, 0),
        ('call-b', 2, 'p-1a2b3c4d', 1, 1, 'search', '{"query":"lunch"}', 'null', 'answered', NULL, 5, 0),
        ('call-c', 3, 'p-1a2b3c4d', 1, 1, 'read', '{}', 'null', 'refused', 'Outside your access.', 5, 0),
        ('call-d', 4, 'p-1a2b3c4d', 1, 1, 'access', '{}', 'null', 'answered', NULL, 5, 0),
        ('call-e', 5, 'p-0000eeee', 1, 1, 'feedback', '{}', 'null', 'answered', NULL, 5, 0);
      INSERT INTO outbound (at_ms, receiver, route, by, what, tool, level, counts, chars, pictures, detector, key, attempt)
        VALUES (1, 'Agent App', NULL, 'p-1a2b3c4d', 'read', 'search', 'names', '{}', 10, 0, NULL, NULL, NULL);
      INSERT INTO outbound_refs (outbound, source, kind, key, day) VALUES (1, 'gmail:person-a@example.com:cloud', 'message', 'm-1', NULL), (1, NULL, NULL, NULL, '2026-11-13');
      INSERT INTO outbound_calls (outbound, call) VALUES (1, 1)`));
    const before = everything(path);
    raw(path, (db) => upTo(10).open(db, "migrate"));
    const after = everything(path);
    expect(after.version).toBe(10);
    const rows = after.rows as Record<string, JsonObject[]>;
    const was = before.rows as Record<string, JsonObject[]>;
    expect(rows.call_came).toEqual([]);
    expect(rows.unlisted).toEqual([]);
    expect(rows.reader_reads).toEqual([{ reader: "p-1a2b3c4d", n: 2, first_ms: 1, last_ms: 2 }]);
    expect(Object.fromEntries(Object.entries(rows).filter(([table]) => !["call_came", "unlisted", "reader_reads"].includes(table)))).toEqual(was);
    raw(path, (db) => upTo(11).open(db, "migrate"));
    const indexed = everything(path);
    expect(indexed.version).toBe(11);
    expect(indexed.rows).toEqual(after.rows);
    expect((indexed.schema as JsonObject[]).filter((object) => !(after.schema as JsonObject[]).some((then) => then.name === object.name)).map((object) => object.name)).toEqual(["calls_read"]);
  });

  it("migration 13 counts each kind each reader's reads brought back, from what came back kept, never a call that is no read; it writes no other row", () => {
    const path = fresh();
    raw(path, (db) => upTo(12).open(db, "migrate"));
    raw(path, (db) => db.exec(`INSERT INTO calls (id, at_ms, reader, session, access_version, tool, sent, read, result, words, ms, epoch) VALUES
        ('call-a', 1, 'p-1a2b3c4d', 1, 1, 'search', '{}', 'null', 'answered', NULL, 5, 0),
        ('call-b', 2, 'p-1a2b3c4d', 1, 1, 'read', '{}', 'null', 'answered', NULL, 5, 0),
        ('call-c', 3, 'p-1a2b3c4d', 1, 1, 'read', '{}', 'null', 'refused', NULL, 5, 0),
        ('call-d', 4, 'p-0000eeee', 1, 1, 'search', '{}', 'null', 'answered', NULL, 5, 0),
        ('call-e', 5, 'p-0000eeee', 1, 1, 'feedback', '{}', 'null', 'answered', NULL, 5, 0);
      INSERT INTO call_came (call, came) VALUES (1, '{"mail":2,"messages":1}'), (2, '{"mail":1}'), (3, '{"health":1}'), (4, '{}'), (5, '{"notes":1}')`));
    const before = everything(path);
    raw(path, (db) => upTo(13).open(db, "migrate"));
    const after = everything(path);
    expect(after.version).toBe(13);
    const rows = after.rows as Record<string, JsonObject[]>;
    expect(rows.reader_kinds).toEqual([{ reader: "p-1a2b3c4d", kind: "mail", n: 2 }, { reader: "p-1a2b3c4d", kind: "messages", n: 1 }]);
    expect(Object.fromEntries(Object.entries(rows).filter(([table]) => table !== "reader_kinds"))).toEqual(before.rows);
  });

  it("migration 15 writes no row and makes call_items empty, and a call deleted takes its items", () => {
    const path = fresh();
    raw(path, (db) => upTo(14).open(db, "migrate"));
    raw(path, (db) => db.exec(`INSERT INTO calls (id, at_ms, reader, session, access_version, tool, sent, read, result, words, ms, epoch) VALUES
        ('call-a', 1, 'p-1a2b3c4d', 1, 1, 'search', '{}', 'null', 'answered', NULL, 5, 0),
        ('call-b', 2, 'p-1a2b3c4d', 1, 1, 'read', '{}', 'null', 'answered', NULL, 5, 0);
      INSERT INTO call_came (call, came) VALUES (1, '{"mail":2}'), (2, '{"messages":1}')`));
    const before = everything(path);
    raw(path, (db) => upTo(15).open(db, "migrate"));
    const after = everything(path);
    expect(after.version).toBe(15);
    const rows = after.rows as Record<string, JsonObject[]>;
    expect(rows.call_items).toEqual([]);
    expect(Object.fromEntries(Object.entries(rows).filter(([table]) => table !== "call_items"))).toEqual(before.rows);
    raw(path, (db) => db.exec(`INSERT INTO call_items (call, at, kind, ref, source, rkind, key, day) VALUES
        (1, 0, 'mail', 'record.a', 'gmail:person-a@example.com:cloud', 'message', 'm-1', NULL), (1, 1, 'mail', 'line.a', NULL, NULL, NULL, '2026-11-13'),
        (2, 0, 'messages', 'line.b', NULL, NULL, NULL, '2026-11-13');
      DELETE FROM calls WHERE id = 'call-a'`));
    expect((everything(path).rows as Record<string, JsonObject[]>).call_items).toEqual([{ call: 2, at: 0, kind: "messages", ref: "line.b", source: null, rkind: null, key: null, day: "2026-11-13" }]);
  });

  it("migration 16 keeps every outbound row of every what, their sequence and their refs, writes no row, and takes feedback after; a what outside the list is still refused", () => {
    const path = fresh();
    raw(path, (db) => upTo(15).open(db, "migrate"));
    const what = ["ask", "read", "text", "link", "lookup"];
    raw(path, (db) => {
      expect(() => db.exec(`INSERT INTO outbound (at_ms, receiver, route, by, what, tool, level, counts, chars, pictures, detector, key, attempt)
        VALUES (1, 'lifestream', NULL, 'macbook-pro-0001', 'feedback', NULL, 'all', '{}', 1, 0, NULL, NULL, NULL)`)).toThrow("CHECK constraint failed");
      const insert = db.prepare(`INSERT INTO outbound (at_ms, receiver, route, by, what, tool, level, counts, chars, pictures, detector, key, attempt)
        VALUES (?, 'Synthetic Receiver', NULL, 'p-1a2b3c4d', ?, NULL, 'names', '{"person":1}', 10, 0, NULL, ?, NULL)`);
      what.forEach((each, n) => insert.run(n + 1, each, `key-${each}`));
      db.exec("DELETE FROM outbound WHERE what = 'lookup'; INSERT INTO outbound_refs (outbound, source, kind, key, day) VALUES (1, 'ask', 'msg', 'c1:0002', NULL), (2, NULL, NULL, NULL, '2026-11-23')");
    });
    const before = everything(path);
    const pages = raw(path, (db) => db.pragma("page_count", { simple: true }) as number);
    raw(path, (db) => upTo(16).open(db, "migrate"));
    const after = everything(path);
    expect(after.version).toBe(16);
    expect(after.rows).toEqual(before.rows);
    expect(raw(path, (db) => db.pragma("page_count", { simple: true }) as number)).toBe(pages);
    const stored = (after.schema as { name: string; sql: string | null }[]).find((object) => object.name === "outbound")!.sql;
    expect(stored).toContain("CHECK(what IN ('ask','read','text','link','lookup','feedback'))");
    const ledger = openLedger(openHomeFolder(dirname(dirname(path))), { mode: "migrate" });
    try {
      const row = { at_ms: 9, receiver: "lifestream", route: null, by: "macbook-pro-0001", what: "feedback" as const, tool: null, level: "all" as const, counts: { phone: 1 }, chars: 12, pictures: 1, key: "feedback:synthetic", attempt: null };
      const seq = ledger.outbound.once(row);
      expect(seq).toBe(6);
      expect(ledger.outbound.once({ ...row, chars: 99 }), "a second write of one report's row writes nothing").toBe(seq);
    } finally {
      ledger.close();
    }
    raw(path, (db) => {
      expect(db.prepare("SELECT what, chars FROM outbound WHERE key = 'feedback:synthetic'").all()).toEqual([{ what: "feedback", chars: 12 }]);
      expect(() => db.exec(`INSERT INTO outbound (at_ms, receiver, route, by, what, tool, level, counts, chars, pictures, detector, key, attempt)
        VALUES (1, 'lifestream', NULL, 'macbook-pro-0001', 'synthetic', NULL, 'all', '{}', 1, 0, NULL, NULL, NULL)`)).toThrow("CHECK constraint failed");
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    });
  });

  it.each(["plain", "keyed"] as const)("a %s ledger at 15 that openLedger migrates takes a feedback row on that same handle, once", (form) => {
    const path = fresh();
    const root = dirname(dirname(path));
    const folder: HomeFolder = form === "keyed" ? keyedFolder(root) : openHomeFolder(root);
    const db = folder.store(LEDGER_STORE, path);
    try {
      upTo(15).open(db, "migrate");
      db.exec(`INSERT INTO outbound (at_ms, receiver, route, by, what, tool, level, counts, chars, pictures, detector, key, attempt)
        VALUES (1, 'Synthetic Receiver', NULL, 'p-1a2b3c4d', 'ask', NULL, 'names', '{}', 10, 0, NULL, 'key-ask', NULL)`);
    } finally {
      db.close();
    }
    const ledger = openLedger(folder, { mode: "migrate" });
    try {
      const row = { at_ms: 9, receiver: "lifestream", route: null, by: "macbook-pro-0001", what: "feedback" as const, tool: null, level: "all" as const, counts: { phone: 1 }, chars: 12, pictures: 1, key: "feedback:synthetic", attempt: null };
      const seq = ledger.outbound.once(row);
      expect(seq).toBe(2);
      expect(ledger.outbound.once({ ...row, chars: 99 })).toBe(seq);
    } finally {
      ledger.close();
    }
    const again = folder.store(LEDGER_STORE, path, { mustExist: true });
    try {
      expect(again.pragma("user_version", { simple: true })).toBe(LATEST);
      expect(again.prepare("SELECT what, chars FROM outbound ORDER BY seq").all()).toEqual([{ what: "ask", chars: 10 }, { what: "feedback", chars: 12 }]);
      expect(again.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      again.close();
    }
  });
});
