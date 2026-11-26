import { describe, expect, it } from "vitest";
import type { WorkKind } from "@lifestreamprotocol/model";
import { modelsRead } from "./models-read.js";
import type { Defaults, ModelRoute } from "./models.js";
import { memberWords } from "./processing.js";

const ROUTE: ModelRoute = {
  id: "fake/fake-model", transport: "fake", model: "fake-model", name: "Fake model", input: ["text", "image", "audio"], output: "text", tools: false, context_tokens: null, thinking: [], chat: null, offered: true, runner: null,
  leaves: "Fake", where: "Sent to Fake", cost: "free", request: { effort: "low", sampling: null, timeout_ms: 120_000 }, state: "ready", line: null,
};
const MODEL = { value: ROUTE.id, words: "Fake model", note: "Sent to Fake" };
const OFF = { value: "none", words: "Off", note: null };

const read = (defaults: Defaults) => modelsRead({ routes: [ROUTE], runners: [], openrouter: { connected: false } }, { cap: 4 }, defaults,
  { pauses: [], runners: {}, now_ms: 0, day: { zone: "UTC", day_start_hour: 4 } }).defaults;

describe("the models read's defaults", () => {
  it("an unpicked pictures or audio reads Off, with Off first among its steps; a picked one reads its model, Off still first; text has no Off", () => {
    const unpicked = read({ pictures: null, audio: null, text: null });
    for (const kind of ["pictures", "audio"] as WorkKind[]) expect(unpicked[kind]).toEqual({ value: "none", words: "Off", steps: [OFF, MODEL] });
    expect(unpicked.text).toEqual({ value: null, words: "No model yet", steps: [MODEL] });
    const picked = read({ pictures: ROUTE.id, audio: ROUTE.id, text: ROUTE.id });
    for (const kind of ["pictures", "audio"] as WorkKind[]) expect(picked[kind]).toEqual({ value: ROUTE.id, words: "Fake model · Fake", steps: [OFF, MODEL] });
    expect(picked.text).toEqual({ value: ROUTE.id, words: "Fake model · Fake", steps: [MODEL] });
  });

  it("a connector's AI menu under an Off default says Default · Off for pictures and audio, and No model yet for text, which has no Off", () => {
    const unpicked: Defaults = { pictures: null, audio: null, text: null };
    const member = (kind: WorkKind, prefers?: string) => memberWords({ kind, prefers }, { value: "default" }, null, [ROUTE], unpicked, "mac-0001");
    for (const kind of ["pictures", "audio"] as WorkKind[]) {
      const said = member(kind);
      expect(said.words).toBe("Off");
      expect(said.steps.slice(0, 2)).toEqual([{ value: "off", words: "Off", note: null }, { value: "default", words: "Default", note: "Off" }]);
    }
    const text = member("text");
    expect([text.words, text.steps[1]!.note]).toEqual(["No model yet", "No model yet"]);
    const voice = member("audio", "parakeet-unified-en-0.6b");
    expect([voice.words, voice.steps[1]!.note]).toEqual(["No model yet", "No model yet"]);
    const picked = memberWords({ kind: "pictures" }, { value: "default" }, null, [ROUTE], { ...unpicked, pictures: ROUTE.id }, "mac-0001");
    expect(picked.steps[1]!.note).toBe("Fake model");
  });
});
