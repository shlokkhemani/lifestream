import { describe, expect, it } from "vitest";
import { DETAIL_TYPES, hides } from "@lifestreamprotocol/core";
import { PRIVACY_SETTINGS, privacySetting, PrivacySettingError, readPrivacySettings, shownLevel, workLevel } from "./index.js";

const NOW = 1_800_000_000_000;

describe("the privacy settings", () => {
  it("hold one row for each setting of the spec, each with a rule", () => {
    expect(PRIVACY_SETTINGS.map((row) => `${row.where} ${row.key}`)).toEqual([
      "home privacy.level", "home privacy.chat", "home privacy.links", "home privacy.always", "home privacy.never",
      "connector privacy.*",
    ]);
    expect(privacySetting("connector", "privacy.photos")?.key).toBe("privacy.*");
    expect(privacySetting("home", "privacy.photos")).toBeUndefined();
    expect(privacySetting("connector", "privacy.")).toBeUndefined();
  });

  it("run at the spec's defaults, Chat and every work following the onboarding's level", () => {
    const settings = readPrivacySettings({});
    expect(settings).toEqual({ level: "all", chat: "all", links: "tokens", always: [], never: [] });
    const off = readPrivacySettings({ "privacy.level": "none", "privacy.links": "none", "privacy.always": ["Project Falcon"], "day.zone": "UTC" });
    expect(off).toMatchObject({ level: "none", chat: "none", links: "none", always: ["Project Falcon"] });
    expect(readPrivacySettings({ "privacy.chat": "names" }).chat).toBe("names");
    expect(workLevel(off, "photos", undefined)).toBe("none");
    expect(workLevel(off, "photos", "default")).toBe("none");
    expect(workLevel(off, "photos", "names")).toBe("names");
  });

  it("resolve an agent's level from its hide and the shown entries not ended at the read, an ended one changing nothing: a kind shown is not hidden, a level shown hides only what both hide", () => {
    const hidden = (level: ReturnType<typeof shownLevel>) => DETAIL_TYPES.filter((type) => hides(level, type));
    expect(shownLevel("names", [], NOW)).toBe("names");
    expect(shownLevel("names", [{ detail: "[[Phone 1]]", until_ms: null }], NOW)).toBe("names");
    expect(hidden(shownLevel("all", [{ type: "phone", until_ms: NOW + 1 }], NOW))).toEqual(hidden("all").filter((type) => type !== "phone"));
    expect(hidden(shownLevel("all", [{ type: "number", until_ms: NOW + 1 }], NOW))).toEqual(hidden("all").filter((type) => !type.startsWith("number")));
    const card = shownLevel("all", [{ type: "number.card", until_ms: NOW + 1 }], NOW);
    expect(hides(card, "number.card")).toBe(false);
    expect(hides(card, "number.bank")).toBe(true);
    expect(hides(card, "number")).toBe(true);
    expect(hidden(shownLevel("all", [{ level: "names", until_ms: NOW + 1 }], NOW))).toEqual(hidden("names"));
    expect(hidden(shownLevel(["phone", "person"], [{ level: "names", until_ms: NOW + 1 }], NOW))).toEqual(["phone"]);
    expect(shownLevel(["phone"], [{ type: "phone", until_ms: NOW + 1 }], NOW)).toBe("none");
    expect(shownLevel("names", [{ level: "none", until_ms: NOW + 1 }], NOW)).toBe("none");
    expect(shownLevel("all", [{ type: "phone", until_ms: NOW }, { level: "none", until_ms: NOW - 1 }], NOW)).toBe("all");
  });

  it("refuse a bad value by its key's name", () => {
    const refused = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        expect(error).toBeInstanceOf(PrivacySettingError);
        return (error as Error).message;
      }
      throw new Error("expected a refusal");
    };
    expect(refused(() => readPrivacySettings({ "privacy.level": "names" }))).toBe("privacy.level is all or none");
    expect(refused(() => readPrivacySettings({ "privacy.links": "all" }))).toBe("privacy.links is tokens, path or none");
    expect(refused(() => readPrivacySettings({ "privacy.never": ["Lifestream", "lifestream"] }))).toBe("privacy.never is a list of distinct words, none empty");
    expect(refused(() => readPrivacySettings({ "privacy.always": [""] }))).toBe("privacy.always is a list of distinct words, none empty");
    expect(refused(() => workLevel(readPrivacySettings({}), "photos", "some"))).toBe("privacy.photos is all, names, none or default (privacy.level)");
    expect(privacySetting("home", "privacy.chat")!.rule("names")).toBeNull();
  });
});
