import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Piece } from "@lifestreamprotocol/core";
import { FIND_PASSAGES, openLedger, type Ledger } from "@lifestreamprotocol/model";
import { openHider, passagesOf, readPrivacySettings, type Detector, type NameTable, type PrivacySettings } from "@lifestreamprotocol/privacy";
import { works } from "@lifestreamprotocol/connect/sdk";
import { openCopies, type CopyAsked } from "./copies.js";
import { DetectorError } from "./detector.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

const NAMES: NameTable = {
  version: "people-1", owner: null,
  people: [{ who: "p-ada", is: "human", shown: "Ada Example", names: ["Ada Example"], accounts: ["person-a@example.com", "+15550000001"] }],
};
const MODEL = { id: "privacy-filter", file: "sha256:detector", decode: "1" };
const PART = (() => {
  let part = "";
  for (let minute = 0; part.length < works.SCREEN.text_chars!; minute++) {
    part += `--- 10:${String(minute % 60).padStart(2, "0")}:00 · Mail · “Inbox”\nAda Example wrote from person-a@example.com about invoice ${minute}; call +15550000001 before noon.\n\n`;
  }
  return part.slice(0, works.SCREEN.text_chars!);
})();
const PIECES: Piece[] = [{ text: "Say what the part of the sitting shows.\n\n" }, { text: PART, free: true }];
const asked = (more: Partial<CopyAsked> = {}): CopyAsked => ({
  op: "copy", key: "sha256:part-1", revision: "sha256:part-1", pieces: PIECES, attachments: [], receiver: "Example Cloud", route: "fake:fake-model", level: "all", epoch: 0, ...more,
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function copiesOver(chosen: boolean, find: Detector["find"]) {
  const root = mkdtempSync(join(tmpdir(), "home-screen-copy-"));
  roots.push(root);
  const ledger: Ledger = openLedger(openHomeFolder(root), { mode: "migrate" });
  const settings: PrivacySettings = readPrivacySettings({});
  const hider = openHider({
    people: () => NAMES, settings: () => settings,
    pictures: { read: () => Promise.reject(new Error("no pictures here")), make: () => Promise.reject(new Error("no pictures here")) },
    detector: { find, state: () => (chosen ? { state: "ready", model: MODEL } : { state: "off" }) },
    marks: { id: "", epoch: "", read: () => new Map(), write: () => false, dropOthers: async () => 0, forget: () => 0, close: () => undefined },
  });
  const copies = openCopies({ ledger, hider: () => hider, clock: () => 1_000 });
  return { ledger, copies };
}

describe("a screen part of 500,000 characters", () => {
  it("with no hiding model, is hidden by the rules and the names alone: no find is placed, nothing waits, and no detail is left plain", async () => {
    let finds = 0;
    const { ledger, copies } = copiesOver(false, () => {
      finds++;
      return Promise.reject(new Error("the detector is off"));
    });
    try {
      expect(PART.length).toBe(500_000);
      const made = await copies.make(asked());
      expect(made).toEqual({ copy: expect.any(Number) });
      expect(finds).toBe(0);
      const copy = ledger.sent.get((made as { copy: number }).copy)!;
      expect(copy).toMatchObject({ level: "all", detector: null });
      for (const detail of ["Ada", "person-a@example.com", "15550000001"]) expect(copy.body).not.toContain(detail);
      expect(copy.body).toContain("[[Person 1]] wrote from [[Email 1]] about invoice 0; call [[Phone 1]] before noon.");
    } finally {
      ledger.close();
    }
  });

  it("with the hiding model chosen, goes to it a bounded find at a time, and a find that never answers hides the copy by the rules and the names alone, naming no model, its passages placed again by the next", async () => {
    const handed: number[] = [];
    const answer: Detector["find"] = (passages) => {
      handed.push(passages.length);
      return Promise.resolve({ model: MODEL, marks: passages.map(() => []) });
    };
    const distinct = new Set(passagesOf(PART).map((passage) => PART.slice(passage.start, passage.end))).size;
    let tried = 0;
    const { ledger, copies } = copiesOver(true, (passages) =>
      (++tried === 3 ? Promise.reject(new DetectorError("TIMEOUT", "the hiding model did not answer within 300 s")) : answer(passages)));
    try {
      const fallen = await copies.make(asked());
      expect(fallen).toEqual({ copy: expect.any(Number) });
      const plain = ledger.sent.get((fallen as { copy: number }).copy)!;
      expect(plain).toMatchObject({ level: "all", detector: null });
      for (const detail of ["Ada", "person-a@example.com", "15550000001"]) expect(plain.body).not.toContain(detail);
      handed.length = 0;
      const made = await copies.make(asked());
      expect(made).toEqual({ copy: expect.any(Number) });
      expect(handed.every((count) => count <= FIND_PASSAGES)).toBe(true);
      expect(handed.reduce((sum, count) => sum + count, 0)).toBe(distinct);
      expect(handed.length).toBe(Math.ceil(distinct / FIND_PASSAGES));
      expect(ledger.sent.get((made as { copy: number }).copy)).toMatchObject({ level: "all", detector: MODEL.id });
    } finally {
      ledger.close();
    }
  });
});
