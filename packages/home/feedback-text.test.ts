import { describe, expect, it } from "vitest";
import { emptyTable, piecesText } from "@lifestreamprotocol/core";
import { openHider, type NameTable, type PrivacySettings } from "@lifestreamprotocol/privacy";
import { answerText, appText, connectorText, FAILED_RUNS, titleOf, type AskAnswer, type ConnectorFacts } from "./feedback-text.js";

const PEOPLE: NameTable = {
  version: "feedback-text-1",
  owner: { who: "p-owner", shown: "Owen Example" },
  people: [
    { who: "p-owner", is: "human", shown: "Owen Example", names: ["Owen Example"], accounts: [] },
    { who: "p-zorbot", is: "human", shown: "Zorbot Exampleton", names: ["Zorbot Exampleton"], accounts: [] },
  ],
};

const NONE: PrivacySettings = { level: "none", chat: "none", links: "tokens", always: [], never: [] };

function hider(settings: PrivacySettings = NONE) {
  return openHider({
    people: () => PEOPLE,
    settings: () => settings,
    detector: { find: () => Promise.reject(new Error("no detector here")), state: () => ({ state: "absent", why: "off" }) },
    pictures: { read: async () => ({ cannot: "no picture here" }), make: async () => ({ cannot: "no picture here" }) },
    marks: { id: "", epoch: "", read: () => new Map(), write: () => false, dropOthers: async () => 0, forget: () => 0, close: () => undefined },
  });
}

const ANSWER: AskAnswer = {
  text: "About 7 h a night [r1].",
  steps: [{ name: "count", words: "Counted days", ms: 40, line: "count {of: days, measure: sleep, op: avg, by: month} → r1" }],
  model: "gpt-6-luna",
  thinking: "medium",
  ms: 14_000,
  end: "done",
};

const CONNECTOR: ConnectorFacts = {
  id: "gmail", name: "Gmail", contract: "2", state: "broken", reason: "failing", since_ms: Date.UTC(2026, 10, 20), next_ms: null,
  words: "Gmail stopped reading", line: null, detail: "The last read failed", more: null,
  failed: Array.from({ length: 7 }, (_, n) => ({ at_ms: Date.UTC(2026, 10, 20, n), error: `read ${n} failed` })),
};

describe("the feedback attachments' texts", () => {
  it("writes an answer as its question, answer, steps and model, as the person reads it", () => {
    expect(piecesText(answerText({ text: "How did I sleep last month?", spoken: null }, ANSWER))).toBe([
      "Question: How did I sleep last month?",
      "Answer: About 7 h a night [r1].",
      "Steps:",
      "  count {of: days, measure: sleep, op: avg, by: month} → r1 (40 ms)",
      "Model: gpt-6-luna, thinking medium, 14 s, done",
      "",
    ].join("\n"));
  });

  it("reads a voice question's written words, a step's words where it has no line, and a failed answer's kind and error", () => {
    const failed: AskAnswer = { text: "", steps: [{ name: "find", words: "Looked for trips", ms: 12, error: "the door answered 503" }], model: "gpt-6-luna", ms: 900, end: "failed", failed: "door", error: "the home stopped answering" };
    const text = piecesText(answerText({ text: "", spoken: "Where did I go in May?" }, failed));
    expect(text).toContain("Question: Where did I go in May?\n");
    expect(text).toContain("  Looked for trips (12 ms) error: the door answered 503\n");
    expect(text).toContain("Model: gpt-6-luna, 900 ms, failed\n");
    expect(text).toContain("Failed: door: the home stopped answering\n");
  });

  it("writes a connector by its product, its state and its last five failed runs, newest first", () => {
    const text = piecesText(connectorText(CONNECTOR));
    expect(text).toContain("Connector: Gmail (gmail)\nContract: 2\n");
    expect(text).toContain("State: broken, failing, since 2026-11-20T00:00:00.000Z, next none\n");
    expect(text).toContain("Card: Gmail stopped reading\nDetail: The last read failed\n");
    const runs = text.split("Failed runs:\n")[1]!.trim().split("\n").map((line) => line.trim());
    expect(runs).toHaveLength(FAILED_RUNS);
    expect(runs[0]).toBe("2026-11-20T06:00:00.000Z: read 6 failed");
    expect(runs.at(-1)).toBe("2026-11-20T02:00:00.000Z: read 2 failed");
  });

  it("writes the app details of a Mac and of a phone", () => {
    expect(piecesText(appText({ device: "mac", release: { generation: "20261123.1", commit: "abc1234" }, encrypted: true, mac: { build: "7602", macos: "26.1", model: "Mac15,3" }, phone: null })))
      .toBe("Home: 20261123.1 (abc1234), encrypted\nMac app: 7602, macOS 26.1, Mac15,3\n");
    expect(piecesText(appText({ device: "phone", release: { generation: "20261123.1", commit: "abc1234" }, encrypted: false, mac: null, phone: { version: "0.4.0", ios: "26.1" } })))
      .toBe("Home: 20261123.1 (abc1234)\niPhone app: 0.4.0, iOS 26.1\n");
  });

  it("names each kind's chip", () => {
    expect([titleOf("answer"), titleOf("connector", "Gmail"), titleOf("app")]).toEqual(["This answer", "Gmail's status", "App details"]);
  });

  it("hides a phone, an email and a People name in an answer, a step and a run error at all, with Privacy and Chat at Don't hide", async () => {
    const answer: AskAnswer = { ...ANSWER, text: "Zorbot Exampleton called from +15550000001.", steps: [{ name: "find", words: "Found", ms: 5, line: "find {who: person-a@example.com}" }] };
    const connector: ConnectorFacts = { ...CONNECTOR, failed: [{ at_ms: 0, error: "refused for person-a@example.com at +15550000001" }] };
    const hidden = await hider().hide([answerText(null, answer), connectorText(connector)], "all", emptyTable("feedback:test"));
    if (!("texts" in hidden)) throw new Error(`expected texts, got ${hidden.wait}`);
    const texts = hidden.texts.join("\n");
    for (const detail of ["Zorbot Exampleton", "+15550000001", "person-a@example.com"]) expect(texts).not.toContain(detail);
    expect(hidden.texts[0]).toMatch(/Answer: \[\[Person 1\]\] called from \[\[Phone 1\]\]\./u);
    expect(hidden.texts[0]).toMatch(/find \{who: \[\[Email 1\]\]\}/u);
    expect(hidden.texts[1]).toMatch(/refused for \[\[Email 1\]\] at \[\[Phone 1\]\]/u);
  });
});
