import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { accountOf, openHomeFolder, type Box, type Drawn, type ExtractRow, type Json } from "@lifestreamprotocol/core";
import { photosFamily, type BurstContent } from "@lifestreamprotocol/families";
import { fakeTransport, openAsker, openLedger, runCall } from "@lifestreamprotocol/model";
import { planUnit } from "./asks.js";
import type { ModelRoute, Routing } from "./models.js";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const SOURCE = "fake-photos:a:b";
const WORK = "fake-photos/photos";
const NOON = Date.UTC(2026, 8, 5, 12);
const ROUTE: ModelRoute = {
  id: "fake/fake-model", transport: "fake", model: "fake-model", name: "Fake model", input: ["text", "image"], output: "text", tools: false, timed: false, context_tokens: null, thinking: [], chat: null, suggested: [], offered: true, runner: null, leaves: null,
  where: "Stays on this computer", cost: "free", request: { effort: "low", sampling: null, timeout_ms: 120_000 }, state: "ready", line: null,
};
const ROUTING: Routing = {
  routes: { [ROUTE.id]: ROUTE },
  works: { [WORK]: { kind: "pictures", text_chars: null, value: ROUTE.id, route: ROUTE.id, suggests: ROUTE.id, start_ms: null, power_ms: null } },
};
const LOOK = { workOf: () => WORK, choice: () => undefined, stored: () => undefined, givenUp: () => undefined };

const A: Box = { x: 60, y: 10, width: 20, height: 20 };
const C: Box = { x: 10, y: 50, width: 20, height: 20 };
const ADA = { who: "person:ada-example", shown: "Ada Example" };

describe("a photo's faces through a plan", () => {
  it("saves the first request's face entries, draws a retry after a rescan from them, and puts the answer back with the person's name", async () => {
    const root = mkdtempSync(join(tmpdir(), "lifestream-asks-faces-"));
    roots.push(root);
    const blobs = openHomeFolder(root).blobs(join(root, "blobs"));
    const photo = blobs.put(Buffer.from("synthetic photo bytes"));
    const hex = photo.slice("sha256:".length);
    const item = `photo:${hex}`;
    const path = join(root, "replies", "replies.db");
    const ledger = openLedger(openHomeFolder(dirname(dirname(path))), { mode: "migrate" });
    const drawn: Drawn[][] = [];
    const family = photosFamily({ faces: true })([]);
    const asker = openAsker({
      ledger, prompt: (name) => family.prompts![name]!, blobs: openHomeFolder(root).blobs(join(root, "blobs"), { reading: true }),
      draw: (blob, faces) => {
        drawn.push(faces);
        return Buffer.from(`synthetic drawing of ${blob}: ${JSON.stringify(faces)}`);
      },
    });
    const burst = (faces: { box: Box; person: typeof ADA | null }[]): ExtractRow => {
      const content: BurstContent = { photos: [{ photo: `${SOURCE}/p1`, accounts: [accountOf(SOURCE)], item, sha256: hex, at_ms: NOON, media_type: "image/jpeg", kind: "photograph", motion: null, duration_ms: null, held: true, position: "only", faces }] };
      return { family: "photos", unit: `burst/${SOURCE}/p1`, reading: JSON.stringify(faces), code: family.code!, content: content as unknown as Json, start_ms: NOON, end_ms: NOON, days: ["2026-09-05"], seq: 1 };
    };
    const send = { picked: new Map([[item, ROUTE.id]]), routing: ROUTING };
    const answer = async (key: string, reply: string) =>
      expect(await runCall({ folder: openHomeFolder(dirname(dirname(path))), key, route: { transport: "fake", timeout_ms: 30_000 }, copies: join(root, "calls"), transport: () => fakeTransport({ reply }) })).toMatchObject({ outcome: "replied" });
    try {
      const first = planUnit(family, burst([{ box: A, person: null }]), asker, LOOK, send);
      expect(first.sent).toHaveLength(1);
      const asked = first.hands.get(first.sent[0]!.key)!;
      const entries = [{ placeholder: "[[Person 1]]", box: A }];
      expect(asked.attachments).toEqual([{ blob: photo, media_type: "image/jpeg", drawn: entries }]);
      expect(ledger.placeholders.faces(`ask:${asked.revision}`)).toEqual(entries);
      await answer(first.sent[0]!.key, JSON.stringify({ caption: "I cannot see the image.", faces: [] }));

      const rescanned = burst([{ box: C, person: null }, { box: A, person: null }]);
      expect(planUnit(family, rescanned, asker, LOOK, send).refused.size).toBe(1);
      const retry = planUnit(family, rescanned, asker, LOOK, send);
      expect(retry.sent).toHaveLength(1);
      expect(retry.sent[0]!.key).not.toBe(first.sent[0]!.key);
      const again = retry.hands.get(retry.sent[0]!.key)!;
      expect([again.revision, again.attachments]).toEqual([asked.revision, [{ blob: photo, media_type: "image/jpeg", drawn: entries }]]);
      expect(drawn).toEqual([entries, entries]);
      await answer(retry.sent[0]!.key, JSON.stringify({ caption: "[[Person 1]] holds a cake.", faces: [{ placeholder: "[[Person 1]]", who: "a man" }] }));

      const named = planUnit(family, burst([{ box: C, person: null }, { box: A, person: ADA }]), asker, LOOK);
      expect(named.sent).toEqual([]);
      expect(named.rows.map((row) => [row.item, row.state, row.content])).toEqual([[item, "done", { text: "Ada Example holds a cake.", names: [{ start: 0, end: 11, who: ADA.who }] }]]);
    } finally {
      ledger.close();
    }
  });
});
