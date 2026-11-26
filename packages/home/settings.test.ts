import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connector } from "@lifestreamprotocol/connect";
import { USE_IDS } from "@lifestreamprotocol/model";
import { describe, expect, it, onTestFinished } from "vitest";
import { blockOf, checkMember, chosenFor, connectorSettings, deviceSets, effectiveOf, mobileDataOf, planned, plannedBlock, settingsPath, unitOfSetting } from "./settings.js";

const NOTES = {
  id: "notes-start", product: "apple-notes", name: "Notes", vendor: "apple", type: "notes", records: "Synthetic notes.", noun: ["note", "notes"],
  sources: [{ id: "apple-notes:local:start", read: "fake-rows", arrives: "poll" }],
  refresh: { default: "1h", min: "1m", max: "1d" },
  backfill: { pace: { default: "2m", min: "1m", max: "1h" }, about: "Collects the notes already kept." },
} satisfies Connector;
const LIVE = {
  id: "notes-live", product: "apple-notes", name: "Notes", vendor: "apple", type: "notes", records: "Synthetic notes.", noun: ["note", "notes"],
  sources: [{ id: "apple-notes:local:live", read: "fake-rows", arrives: "poll" }],
  refresh: { default: "1h", min: "1m", max: "1d" },
} satisfies Connector;
const HELD = { "day.zone": "UTC", unit: "macbook-pro-0001" };

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "lifestream-settings-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

describe("a device's mobile data", () => {
  it("runs at now for a device the settings hold none for, at its own choice where they do, is set by a device for its own unit alone, and refuses any other word by name", () => {
    const held = effectiveOf({ ...HELD, "devices.iphone-aa01.mobile_data": "small" }, "settings.json").settings;
    expect([mobileDataOf(held, "iphone-aa01"), mobileDataOf(held, "macbook-pro-0001")]).toEqual(["small", "now"]);
    expect([deviceSets("devices.iphone-aa01.mobile_data"), unitOfSetting("devices.iphone-aa01.mobile_data"), unitOfSetting("model.cap")]).toEqual([true, "iphone-aa01", null]);
    for (const value of ["metered", "all", 1]) {
      expect(() => effectiveOf({ ...HELD, "devices.iphone-aa01.mobile_data": value }, "settings.json")).toThrow("settings.json: devices.iphone-aa01.mobile_data is now, everything, small");
    }
  });
});

describe("the home's start", () => {
  it("runs at all where the settings hold none, at a day or all where they do, and refuses anything else by name", () => {
    expect(effectiveOf(HELD, "settings.json").settings.history).toEqual({ start: "all" });
    expect(effectiveOf({ ...HELD, "history.start": "2026-05-19" }, "settings.json").settings.history).toEqual({ start: "2026-05-19" });
    expect(effectiveOf({ ...HELD, "history.start": "2999-01-01" }, "settings.json").settings.history).toEqual({ start: "2999-01-01" });
    for (const value of ["90d", "none", "2026-02-30", 6]) {
      expect(() => effectiveOf({ ...HELD, "history.start": value }, "settings.json")).toThrow("settings.json: history.start is all or a day (2026-05-19)");
    }
  });

  it("is refused at set when it is a day after today, before anything is written", () => {
    const root = folder();
    planned(root, { ...HELD, "history.start": "2026-05-19" }).write();
    const before = readFileSync(settingsPath(root), "utf8");
    expect(() => planned(root, { "history.start": "2999-01-01" })).toThrow(/^history\.start is after today \(\d{4}-\d{2}-\d{2}\): a start is a day already begun$/u);
    expect(() => planned(root, { "history.start": "lately" })).toThrow("history.start is all or a day (2026-05-19)");
    expect(readFileSync(settingsPath(root), "utf8")).toBe(before);
  });
});

describe("the model chosen for each use", () => {
  it("is one default per use, each a model id or Off, read by chosenFor alone, with the thinking level Chat's default runs at", () => {
    const none = effectiveOf(HELD, "settings.json").settings;
    expect(Object.fromEntries(USE_IDS.map((use) => [use, chosenFor(none, use)]))).toEqual({ pictures: null, audio: null, text: null, chat: null, search: null, hiding: null });
    expect(none.thinking).toEqual({ chat: null });
    const ids = {
      pictures: "claude:claude-haiku-5-5", audio: "openrouter:elevenlabs/scribe-v2", text: "runner:runner-macbook-pro-0001/qwen3.5-4b",
      chat: "claude:claude-opus-5-5", search: "runner:runner-macbook-pro-0001/embeddinggemma-2-q8-512", hiding: "runner:runner-macbook-pro-0001/privacy-filter",
    };
    const held = effectiveOf({ ...HELD, ...Object.fromEntries(USE_IDS.map((use) => [`model.defaults.${use}`, ids[use]])), "model.thinking.chat": "medium" }, "settings.json").settings;
    expect(Object.fromEntries(USE_IDS.map((use) => [use, chosenFor(held, use)]))).toEqual(ids);
    expect(held.thinking).toEqual({ chat: "medium" });
    const works = { defaults: { pictures: null, audio: ids.audio, text: null } };
    expect(chosenFor(works, "audio")).toBe(ids.audio);
  });

  it("refuses a default that is no model id, a use there is none of, a thinking level that is no word, and the old cloud voice block", () => {
    expect(() => effectiveOf({ ...HELD, "model.defaults.chat": "Opus" }, "settings.json")).toThrow("model.defaults.chat is a model id (<connection>:<model>) or null");
    expect(() => planned(folder(), { "model.defaults.sound": "fake:fake-model" })).toThrow("model.defaults.sound");
    expect(() => effectiveOf({ ...HELD, "model.thinking.chat": "Very High" }, "settings.json")).toThrow("model.thinking.chat is a thinking level or null");
    expect(() => effectiveOf({ ...HELD, "model.transports.openrouter-voice.concurrency": 2 }, "settings.json")).toThrow("no transport is named openrouter-voice");
  });
});

describe("a stream's own start", () => {
  it("is a member, Starts from, of a connector that reads history alone, unset until written", () => {
    expect(connectorSettings(NOTES, undefined).members.find((each) => each.member === "start")).toEqual({ member: "start", kind: "start", label: "Starts from", value: null, from: "unset" });
    expect(connectorSettings(NOTES, { start: "2019-01-01" }).members.find((each) => each.member === "start")).toMatchObject({ value: "2019-01-01", from: "person" });
    expect(connectorSettings(LIVE, undefined).members.some((each) => each.member === "start")).toBe(false);
    expect(() => checkMember(LIVE, "start", "2019-01-01", [])).toThrow("connectors.notes-live.start is not a member of notes-live: it holds refresh");
  });

  it("refuses reach, a word it no longer knows, by name, and keeps a written one aside with a notice", () => {
    expect(() => checkMember(NOTES, "reach", "90d", [])).toThrow("connectors.notes-start.reach is not a member of notes-start: it holds refresh, start, pace");
    expect(connectorSettings(NOTES, { reach: "90d" }).notices).toEqual([{
      key: "connectors.notes-start.reach",
      what: "settings.json holds connectors.notes-start.reach, which notes-start does not declare: it is kept and ignored (lifestream connectors reset notes-start reach removes it)",
    }]);
  });

  it("is checked as the home's is: a word or a day after today refused at set, one read from the file kept aside with a notice", () => {
    expect(() => checkMember(NOTES, "start", "90d", [])).toThrow("connectors.notes-start.start is all or a day (2026-05-19)");
    expect(() => checkMember(NOTES, "start", "2999-01-01", [])).toThrow(/^connectors\.notes-start\.start is after today/u);
    expect(() => checkMember(NOTES, "start", "all", [])).not.toThrow();
    expect(connectorSettings(NOTES, { start: "2999-01-01" }).notices).toEqual([]);
    expect(connectorSettings(NOTES, { start: "none" }).notices.map((each) => each.key)).toEqual(["connectors.notes-start.start"]);
  });

  it("written equal to the home's start is stored as nothing, so the stream follows the home again", () => {
    const root = folder();
    planned(root, { ...HELD, "history.start": "2026-05-19" }).write();
    plannedBlock(root, NOTES, { start: "2019-01-01", refresh: "2h" }, ["start", "refresh"]).write();
    expect(blockOf(root, NOTES.id)).toEqual({ start: "2019-01-01", refresh: "2h" });
    plannedBlock(root, NOTES, { start: "2026-05-19", refresh: "2h" }, ["start"]).write();
    expect(blockOf(root, NOTES.id)).toEqual({ refresh: "2h" });
    plannedBlock(root, NOTES, { start: "all" }, ["start"], {}, [], { "history.start": "all" }).write();
    expect(blockOf(root, NOTES.id)).toEqual({});
  });
});
