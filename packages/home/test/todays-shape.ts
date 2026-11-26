import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { HOME_STORE, homeSchema, Schema, SETTINGS_MOVE, type HomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import { LEDGER_STORE, ledgerFileOf, ledgerSchema } from "@lifestreamprotocol/model";

export const RUNNER = "runner-macbook-pro-0001";
export const OLD_SCRIBE = "openrouter-voice:elevenlabs/scribe-v2";
export const SCRIBE = "openrouter:elevenlabs/scribe-v2";
export const PARAKEET = `runner:${RUNNER}/parakeet-unified-en-0.6b`;
export const GONE_ID = "openrouter:example/gone-model";
export const GONE_NAME = "Gone Model";
export const VOICE_WORK = "ask/voice";
const LEDGER_BEFORE = 16;

export const TODAYS_SETTINGS: JsonObject = {
  "model.defaults.audio": OLD_SCRIBE,
  "model.defaults.text": GONE_ID,
  "connectors.ask": { "llm.chats": "default" },
  "connectors.whatsapp": { "llm.voice": OLD_SCRIBE, "llm.range": "all" },
  "search.meaning": RUNNER,
  "search.meaning.model": "embeddinggemma-2-q8-512",
  "privacy.detector": RUNNER,
  "model.transports.openrouter-voice.concurrency": 2,
  "model.transports.address": { url: "http://127.0.0.1:1234/v1", model: "local-model", kinds: ["text", "pictures"], secret: "address-key" },
};

export interface TodaysModels {
  parakeet: boolean;
}

export function todaysModels(shape: TodaysModels = { parakeet: true }): JsonObject {
  return {
    routes: [
      oldRoute(OLD_SCRIBE, "openrouter-voice", "elevenlabs/scribe-v2", "Scribe v2", ["audio"], null),
      oldRoute(GONE_ID, "openrouter", "example/gone-model", GONE_NAME, ["text", "pictures"], 400_000),
    ],
    runners: [{
      unit: RUNNER, name: "Synthetic Mac", present: true, power: null, memory_gb: 16, below: null,
      files: shape.parakeet ? [{ id: "parakeet-unified-en-0.6b", state: "ready" }] : [],
    }],
    openrouter: { connected: true },
  };
}

function oldRoute(id: string, transport: string, model: string, name: string, kinds: string[], text_chars: number | null): JsonObject {
  return {
    id, transport, model, name, kinds, text_chars, offered: true, runner: null, leaves: "openrouter.ai", where: null, cost: null,
    request: { effort: "none", sampling: null, timeout_ms: 120_000 }, state: "ready", line: null,
  };
}

export function todaysStores(folder: HomeFolder, models: JsonObject = todaysModels()): void {
  const home = folder.store(HOME_STORE, join(folder.root, "home.db"));
  try {
    upTo(homeSchema, SETTINGS_MOVE.version - 1).open(home, "migrate");
    home.prepare("INSERT INTO item_routes (family, item, prompt, route, model) VALUES ('ai', 'note-a', 'voice', ?, 'elevenlabs/scribe-v2')").run(OLD_SCRIBE);
    home.prepare(`INSERT INTO asks (family, item, prompt, prompt_hash, input_hash, unit, work_id, at_key, started, given_up, state, prompt_version)
      VALUES ('ai', 'note-b', 'voice', 'sha256:prompt', 'sha256:input', 'unit-a', ?, 1, 0, ?, 'given-up', 1)`).run(VOICE_WORK, OLD_SCRIBE);
    const meta = home.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    meta.run("llm:models", JSON.stringify(models));
    meta.run("llm:hiding", JSON.stringify({ [VOICE_WORK]: [OLD_SCRIBE, "openrouter.ai", "none"] }));
  } finally {
    home.close();
  }
  mkdirSync(join(folder.root, "replies"), { recursive: true });
  const ledger = folder.store(LEDGER_STORE, ledgerFileOf(folder.root));
  try {
    upTo(ledgerSchema, LEDGER_BEFORE).open(ledger, "migrate");
    ledger.prepare("INSERT INTO prompts (hash, version, text) VALUES ('sha256:prompt', '1', 'synthetic prompt')").run();
    ledger.prepare(`INSERT INTO requests (key, unit, model, effort, transport, prompt_hash, input_hash, body, attachments, requested)
      VALUES ('key-a', 'unit-a', 'elevenlabs/scribe-v2', 'none', 'openrouter-voice', 'sha256:prompt', 'sha256:input', '{}', '[]', '2026-09-01T00:00:00.000Z')`).run();
    ledger.prepare("INSERT INTO attempts (id, key, state, started, transport) VALUES (1, 'key-a', 'failed', '2026-09-01T00:00:00.000Z', 'openrouter-voice')").run();
    ledger.prepare(`INSERT INTO outbound (at_ms, receiver, route, what, level, counts, chars, pictures, key, attempt)
      VALUES (1, 'openrouter.ai', ?, 'ask', 'none', '{}', 0, 0, 'key-a', 1)`).run(OLD_SCRIBE);
    ledger.prepare("INSERT INTO sent_copies (key, receiver, route, level, pictures, counts, at_ms) VALUES ('key-a', 'openrouter.ai', ?, 'none', '[]', '{}', 1)").run(OLD_SCRIBE);
    ledger.prepare("INSERT INTO meta (key, value) VALUES ('rest:openrouter-voice', '{\"cause\":\"provider\"}')").run();
  } finally {
    ledger.close();
  }
}

export function voiceLeft(folder: HomeFolder): string[] {
  return [
    ...cellsWith(folder.store(HOME_STORE, join(folder.root, "home.db"), { mode: "read", mustExist: true }), "home.db"),
    ...cellsWith(folder.store(LEDGER_STORE, ledgerFileOf(folder.root), { mode: "read", mustExist: true }), "the ledger"),
  ];
}

export function metaOf(folder: HomeFolder, key: string): string | undefined {
  const db = folder.store(HOME_STORE, join(folder.root, "home.db"), { mode: "read", mustExist: true });
  try {
    return db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(key) as string | undefined;
  } finally {
    db.close();
  }
}

export function homeRow<Row>(folder: HomeFolder, sql: string): Row | undefined {
  const db = folder.store(HOME_STORE, join(folder.root, "home.db"), { mode: "read", mustExist: true });
  try {
    return db.prepare(sql).get() as Row | undefined;
  } finally {
    db.close();
  }
}

function cellsWith(db: Database.Database, store: string): string[] {
  try {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all() as string[];
    return tables.flatMap((table) => (db.prepare(`SELECT * FROM "${table}"`).raw().all() as unknown[][])
      .filter((row) => JSON.stringify(row).includes("openrouter-voice")).map((row) => `${store} ${table}: ${JSON.stringify(row)}`));
  } finally {
    db.close();
  }
}

function upTo(schema: Schema, version: number): Schema {
  return new Schema({
    name: schema.name, file: schema.file, base: schema.base, baseline: schema.baseline, migrations: schema.migrations.slice(0, version - schema.base),
    small: [...schema.small], indexed: [...schema.indexed], foreignKeys: schema.foreignKeys,
  });
}
