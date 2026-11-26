import { describe, expect, it } from "vitest";
import { askedOf, coming, WANTED_PAGE, type Order, type WantedContent } from "./wanted.js";

const PHONE = "apple-photos:person-a@example.com:iphone-0001";
const MAC = "apple-photos:person-a@example.com:macbook-pro-0001";
const START = Date.UTC(2026, 4, 19);
const DAY = 86_400_000;

function photo(at_ms: number | null, sources: readonly string[] = [PHONE], size: number | null = 1_000): WantedContent {
  return {
    at_ms,
    missing: [{ type: "photo", name: null, size }],
    routes: sources.map((source) => ({ source, asset: `asset-${at_ms ?? "undated"}`, files: ["photo"], refused: false })),
  };
}

describe("photo files under the start: each way it could fail", () => {
  it("a photo dated before the start is still wanted, an undated one is dropped, or one dated on the start's midnight is left out", () => {
    const units = [photo(START - DAY), photo(START - 1), photo(START), photo(START + DAY, [PHONE, MAC], null), photo(null)];
    expect(coming(units, START)).toEqual({ wanted: 3, unavailable: 0, bytes: 2_000, unsized: 1, libraries: { [PHONE]: 3, [MAC]: 1 } });
    expect(coming(units, null)).toEqual({ wanted: 5, unavailable: 0, bytes: 4_000, unsized: 1, libraries: { [PHONE]: 5, [MAC]: 1 } });
  });

  it("a start moved later still counts the files below it as coming, so a library never says done", () => {
    const units = [photo(START - 30 * DAY), photo(START - DAY)];
    expect(coming(units, START).libraries[PHONE]).toBeUndefined();
    expect(coming(units, START - 2 * DAY).libraries[PHONE]).toBe(1);
  });
});

describe("the wanted page a library is asked for: each way it could fail", () => {
  const routed = (asset: string, at_ms: number | null, sources: readonly string[], refused = false): WantedContent => ({
    at_ms,
    missing: [{ type: "photo", name: null, size: 1_000 }],
    routes: sources.map((source) => ({ source, asset, files: ["photo"], refused })),
  });
  const macFirst: Order = (source) => (source === MAC ? 0 : source === PHONE ? 1 : null);
  const assets = (page: { asset: string }[]) => page.map((photo) => photo.asset);

  it("a library's owed photos come first, ahead of a whole page of newer ones, an old one and an undated one among them", () => {
    const newer = Array.from({ length: WANTED_PAGE }, (_, index) => routed(`new-${String(index).padStart(4, "0")}`, START + index, [PHONE]));
    const units = [...newer, routed("owed-old", START - 400 * DAY, [PHONE]), routed("owed-undated", null, [PHONE])];
    const page = askedOf(units, macFirst, PHONE, new Set(["owed-undated", "owed-old", "not-wanted"]));
    expect(page).toHaveLength(WANTED_PAGE);
    expect(assets(page.slice(0, 3))).toEqual(["owed-old", "owed-undated", `new-${String(WANTED_PAGE - 1).padStart(4, "0")}`]);
    expect(assets(askedOf(units, macFirst, PHONE, new Set()))).not.toContain("owed-old");
  });

  it("an owed photo the home asks another library for, or that no route may send, is absent, so the library drops it", () => {
    const units = [routed("both", START, [PHONE, MAC]), routed("refused", START, [PHONE], true), routed("mine", START - DAY, [PHONE])];
    const owed = new Set(["both", "refused", "mine"]);
    expect(assets(askedOf(units, macFirst, PHONE, owed))).toEqual(["mine"]);
    expect(assets(askedOf(units, macFirst, MAC, owed))).toEqual(["both"]);
  });

  it("no owed photos is today's page: newest first, the undated last, ties by asset", () => {
    const units = [routed("undated", null, [PHONE]), routed("b", START, [PHONE]), routed("a", START, [PHONE]), routed("newest", START + DAY, [PHONE])];
    expect(assets(askedOf(units, macFirst, PHONE, new Set()))).toEqual(["newest", "a", "b", "undated"]);
  });
});
