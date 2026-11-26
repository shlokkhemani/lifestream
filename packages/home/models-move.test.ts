import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { metaAsItLies, openHome, openHomeFolder, SETTINGS_MOVE, type HomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import { keyedFolder } from "@lifestreamprotocol/core/test/keyed";
import { openLedger, requestKey } from "@lifestreamprotocol/model";
import { movedSettings, settingsMove } from "./models-move.js";
import { unfilled, type StoredModels } from "./models.js";
import { personal, replaced, sealStrays } from "./settings.js";
import { writeFolder } from "./test/folder.js";
import { GONE_ID, GONE_NAME, homeRow, metaOf, OLD_SCRIBE, PARAKEET, RUNNER, SCRIBE, todaysModels, todaysStores, TODAYS_SETTINGS, voiceLeft, VOICE_WORK } from "./test/todays-shape.js";

const temps: string[] = [];

afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const made = realpathSync(mkdtempSync(join(tmpdir(), "lifestream-models-move-")));
  temps.push(made);
  return made;
}

const OLD_KEYS = ["search.meaning", "search.meaning.model", "privacy.detector", "model.transports.openrouter-voice.concurrency"];

function folderOf(form: "plain" | "keyed"): HomeFolder {
  const root = temp();
  writeFolder(root, TODAYS_SETTINGS);
  const folder = form === "plain" ? openHomeFolder(root) : keyedFolder(root);
  if (form === "keyed") expect(sealStrays(folder).length).toBeGreaterThan(0);
  todaysStores(folder);
  return folder;
}

function moveOnce(folder: HomeFolder): void {
  const move = settingsMove(folder);
  const db = openHome(folder, "migrate");
  try {
    if (move !== null) replaced(folder, move);
    db.commit((tx) => { tx.tables.meta.delete(SETTINGS_MOVE.key); });
  } finally {
    db.close();
  }
  openLedger(folder, { mode: "migrate" }).close();
}

describe("the move of today's settings, home.db and ledger", () => {
  for (const form of ["plain", "keyed"] as const) {
    it(`leaves no old id or key in a ${form} home's three stores, and a second run changes nothing`, () => {
      const folder = folderOf(form);
      expect(voiceLeft(folder).length).toBeGreaterThan(0);
      moveOnce(folder);
      const held = personal(folder);
      expect(JSON.stringify(held)).not.toContain("openrouter-voice");
      for (const key of OLD_KEYS) expect(held).not.toHaveProperty([key]);
      expect(held).toMatchObject({
        "model.defaults.audio": SCRIBE, "model.defaults.search": `runner:${RUNNER}/embeddinggemma-2-q8-512`, "model.defaults.hiding": `runner:${RUNNER}/privacy-filter`,
        "model.transports.address": { url: "http://127.0.0.1:1234/v1", model: "local-model", secret: "address-key", input: ["text", "image"] },
        "connectors.whatsapp": { "llm.voice": SCRIBE, "llm.range": "all" }, "connectors.ask": { "llm.chats": "default", "llm.voice": PARAKEET },
      });
      expect(held["model.transports.address"]).not.toHaveProperty("kinds");
      expect(voiceLeft(folder)).toEqual([]);
      expect(metaAsItLies(folder, [SETTINGS_MOVE.key])?.values.size).toBe(0);
      const stores = ["llm:models", "llm:hiding"].map((key) => metaOf(folder, key));
      expect(settingsMove(folder)).toBeNull();
      moveOnce(folder);
      expect(personal(folder)).toEqual(held);
      expect(["llm:models", "llm:hiding"].map((key) => metaOf(folder, key))).toEqual(stores);
    });
  }

  it("a start stopped after home.db's step moves the settings again from the file still in today's shape, and the same", () => {
    const folder = folderOf("plain");
    const before = personal(folder);
    openHome(folder, "migrate").close();
    const again = settingsMove(folder);
    expect(again).not.toBeNull();
    expect(again).toEqual(movedSettings(before, JSON.stringify(todaysModels())));
  });

  it("rewrites each stored route in place: the one id, abilities for kinds, its last name kept", () => {
    const folder = folderOf("plain");
    moveOnce(folder);
    const stored = JSON.parse(metaOf(folder, "llm:models")!) as StoredModels;
    expect(stored.routes.map((route) => [route.id, route.transport, route.name, route.input, route.context_tokens])).toEqual([
      [SCRIBE, "openrouter", "Scribe v2", ["audio"], null],
      [GONE_ID, "openrouter", GONE_NAME, ["text", "image"], 100_000],
    ]);
    expect(stored.routes.every((route) => !("kinds" in route) && !("text_chars" in route) && Array.isArray(route.suggested))).toBe(true);
    expect([stored.connections, "openrouter" in stored, stored.runners.every((runner) => runner.below === null)]).toEqual([{}, false, true]);
    expect(JSON.parse(metaOf(folder, "llm:hiding")!)).toEqual({ [VOICE_WORK]: [SCRIBE, "openrouter.ai", "none"] });
    expect(homeRow(folder, "SELECT route FROM item_routes")).toEqual({ route: SCRIBE });
    expect(homeRow(folder, "SELECT given_up, state FROM asks")).toEqual({ given_up: SCRIBE, state: "given-up" });
  });

  it("asks Scribe by the same request key before and after", () => {
    const folder = folderOf("plain");
    const [then] = (todaysModels().routes as JsonObject[]);
    moveOnce(folder);
    const now = (JSON.parse(metaOf(folder, "llm:models")!) as StoredModels).routes.find((route) => route.id === SCRIBE)!;
    const keyOf = (route: { model: string; request: { effort: string; sampling: null } | null }) => requestKey({
      model: route.model, prompt: "voice", version: 1, input_hash: "sha256:input", effort: route.request!.effort, sampling: route.request!.sampling,
    });
    expect(keyOf(now as never)).toBe(keyOf(then as never));
  });
});

describe("Chat's voice notes keep their model across the move", () => {
  const stored = JSON.stringify(todaysModels());
  const voiceOf = (held: JsonObject, from: string | null = stored) => (movedSettings(held, from)["connectors.ask"] as JsonObject | undefined)?.["llm.voice"];

  it("a runner's Parakeet ready and the Voice notes default Scribe, or none, is written as the Chat stream's own", () => {
    expect(voiceOf({ "model.defaults.audio": OLD_SCRIBE })).toBe(PARAKEET);
    expect(voiceOf({ "model.defaults.audio": null })).toBe(PARAKEET);
    expect(voiceOf({})).toBe(PARAKEET);
    expect(voiceOf({ "connectors.ask": { "llm.voice": "default" } })).toBe(PARAKEET);
  });

  it("no Parakeet ready, Scribe offered: Scribe, by its one id", () => {
    expect(voiceOf({ "model.defaults.audio": null }, JSON.stringify(todaysModels({ parakeet: false })))).toBe(SCRIBE);
  });

  it("writes nothing when the default is what Chat ran, the stream chose its own, nothing is stored, or nothing answers", () => {
    expect(movedSettings({ "model.defaults.audio": PARAKEET }, stored)).toEqual({ "model.defaults.audio": PARAKEET });
    expect(voiceOf({ "connectors.ask": { "llm.voice": "off" } })).toBe("off");
    expect(voiceOf({ "connectors.ask": { "llm.voice": OLD_SCRIBE } })).toBe(SCRIBE);
    expect(movedSettings({}, null)).toEqual({});
    expect(movedSettings({}, JSON.stringify({ routes: [], runners: [] }))).toEqual({});
  });
});

describe("the settings move, row by row", () => {
  it("search.meaning off and privacy.detector off move to Off, and nothing set stays unset", () => {
    expect(movedSettings({ "search.meaning": "off", "search.meaning.model": "embeddinggemma-2-q8-512", "privacy.detector": "off" }, null))
      .toEqual({ "model.defaults.search": null, "model.defaults.hiding": null });
    expect(movedSettings({ "search.meaning": RUNNER }, null)).toEqual({ "model.defaults.search": `runner:${RUNNER}/embeddinggemma-2-q8-512` });
  });

  it("a stored Chat Off is unset, since Chat has no Off, and the fill takes it again; another use's Off stays", () => {
    expect(movedSettings({ "model.defaults.chat": null, "model.defaults.pictures": null, "model.thinking.chat": "high" }, null))
      .toEqual({ "model.defaults.pictures": null, "model.thinking.chat": "high" });
    expect(movedSettings({ "model.defaults.chat": "claude:claude-opus-5-5" }, null)).toEqual({ "model.defaults.chat": "claude:claude-opus-5-5" });
    expect(unfilled({ "model.defaults.chat": null, "model.defaults.text": null, "model.defaults.pictures": "claude:claude-haiku-5-5" })).toEqual(["audio", "chat", "search", "hiding"]);
    expect(unfilled({ "model.defaults.chat": "claude:claude-opus-5-5" })).not.toContain("chat");
  });

  it("an address with text only takes text and keeps its typed model; a moved address and any openrouter-voice block are left or dropped", () => {
    expect(movedSettings({ "model.transports.address": { url: "http://127.0.0.1:1/v1", model: "m", kinds: ["text"] } }, null))
      .toEqual({ "model.transports.address": { url: "http://127.0.0.1:1/v1", model: "m", input: ["text"] } });
    const moved = { "model.transports.address": { url: "http://127.0.0.1:1/v1", input: ["text", "image"] }, "model.transports.address.concurrency": 2 };
    expect(movedSettings({ ...moved, "model.transports.openrouter-voice": { concurrency: 2 } }, null)).toEqual(moved);
  });
});
