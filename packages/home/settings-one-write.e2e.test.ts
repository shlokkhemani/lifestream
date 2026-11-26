import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { changeAll, effective, personal, SettingsError } from "./settings.js";
import { writeFolder } from "./test/folder.js";
import type { VerbContext } from "./verbs/context.js";
import { settings } from "./verbs/settings.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const RUNNER = "runner-macbook-pro-0001";

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "lifestream-settings-one-write-"));
  roots.push(root);
  writeFolder(root);
  return root;
}

const privacyOf = (root: string) => Object.fromEntries(Object.entries(personal(root)).filter(([key]) => key.startsWith("privacy.")));

describe("several settings in one write", () => {
  it("W1, W2: writes every member together, null as the key's default, or none of them when one is refused", () => {
    const root = folder();
    const shown = changeAll(root, { "privacy.level": "all", "privacy.links": "path" });
    expect(shown.map(({ key, value }) => [key, value])).toEqual([["privacy.level", "all"], ["privacy.links", "path"]]);
    expect(effective(root).settings.privacy).toMatchObject({ level: "all", links: "path" });
    changeAll(root, { "privacy.level": "all", "privacy.links": null });
    expect(privacyOf(root)).toEqual({ "privacy.level": "all" });
    expect(effective(root).settings.privacy.links).toBe("tokens");
    const before = personal(root);
    expect(() => changeAll(root, { "privacy.level": "none", "privacy.links": 7 })).toThrow(SettingsError);
    expect(() => changeAll(root, { "privacy.level": "none", "privacy.nothing": null })).toThrow(/privacy.nothing is not a setting/u);
    expect(() => changeAll(root, {})).toThrow(SettingsError);
    expect(personal(root)).toEqual(before);
  });

  it("W3: the verb takes one JSON object of home settings, refuses another act's keys and a word, and tells the running home", async () => {
    const root = folder();
    let told = 0;
    const out: string[] = [];
    const ctx = { folder: openHomeFolder(root), settingsChanged: () => { told += 1; }, out: (line: string) => out.push(line) } as unknown as VerbContext;
    const answer = await settings(ctx, ["set", JSON.stringify({ "privacy.level": "none", "privacy.links": "path" })]) as { changed: { key: string }[] };
    expect(answer.changed.map((each) => each.key)).toEqual(["privacy.level", "privacy.links"]);
    expect(privacyOf(root)).toEqual({ "privacy.level": "none", "privacy.links": "path" });
    expect(told).toBe(1);
    expect(out).toHaveLength(2);
    const before = personal(root);
    await expect(settings(ctx, ["set", JSON.stringify({ "privacy.level": "all", "connectors.gmail": {} })])).rejects.toThrow(/lifestream connectors set/u);
    await expect(settings(ctx, ["set", JSON.stringify({ "privacy.level": "all", "model.defaults.text": null })])).rejects.toThrow(/lifestream models default/u);
    await expect(settings(ctx, ["set", "privacy.level"])).rejects.toThrow(/one JSON object/u);
    await expect(settings(ctx, ["set", JSON.stringify({ "privacy.level": "all", "privacy.links": 7 })])).rejects.toMatchObject({ status: 422, code: "SETTING_REFUSED", words: "privacy.links is tokens, path or none" });
    expect(personal(root)).toEqual(before);
    expect(told).toBe(1);
  });

  it("W4: search by meaning's one setting: plugged-in-and-idle by default, anything else refused; its model is a default, and the keys that named it are no settings", () => {
    const root = folder();
    expect(effective(root).settings.search).toEqual({ power: "plugged-idle" });
    const before = personal(root);
    for (const [key, value] of [["search.meaning", RUNNER], ["search.meaning.model", "another-model-1"], ["privacy.detector", RUNNER], ["search.meaning.power", "always"]] as const) {
      expect(() => changeAll(root, { [key]: value })).toThrow(SettingsError);
    }
    expect(personal(root)).toEqual(before);
    changeAll(root, { "search.meaning.power": null });
    expect(effective(root).settings.search).toEqual({ power: "plugged-idle" });
  });
});
