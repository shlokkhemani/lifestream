import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { emptyTable, openHomeFolder, type Entry, type PlaceholderTable } from "@lifestreamprotocol/core";
import { openHider, openMarks, type HideAnswer, type NameTable, type Pictures, type PrivacySettings, type Text } from "./index.js";
import { fakeDetector, type FakeDetector } from "./test/fake-detector.js";

const dir = mkdtempSync(join(tmpdir(), "lifestream-privacy-hider-words-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PEOPLE: NameTable = {
  version: "people-words-1",
  owner: { who: "p-owner", shown: "Owen Example" },
  people: [
    { who: "p-owner", is: "human", shown: "Owen Example", names: ["Owen Example", "Owen"], accounts: [] },
    { who: "p-zorbot", is: "human", shown: "Zorbot Exampleton", names: ["Zorbot Exampleton"], accounts: [] },
    { who: "assistant:zorbot", is: "bot", shown: "Zorbot", names: ["Zorbot"], accounts: [] },
    { who: "b-quill", is: "business", shown: "Quillbank", names: ["Quillbank"], accounts: [] },
  ],
};
const SETTINGS: PrivacySettings = { level: "all", chat: "all", links: "tokens", always: [], never: [] };
const NO_PICTURES: Pictures = { read: () => Promise.reject(new Error("no picture here")), make: () => Promise.reject(new Error("no picture here")) };

let stores = 0;
function hider(detector: FakeDetector = fakeDetector({}), settings: Partial<PrivacySettings> = {}, people: NameTable = PEOPLE) {
  return openHider({ people: () => people, settings: () => ({ ...SETTINGS, ...settings }), detector, pictures: NO_PICTURES, marks: marksIn(dir, (stores += 1)) });
}

function texts(answer: HideAnswer): unknown[] {
  if (!("texts" in answer)) throw new Error(`expected hidden texts, got ${JSON.stringify(answer)}`);
  return answer.texts;
}

const HELD: PlaceholderTable = {
  scope: "ask:held",
  entries: [
    { placeholder: "[[Person 1]]", type: "person", detail: "Zorbot", who: "p-zorbot" },
    { placeholder: "[[Person 2]]", type: "person", detail: "Quorvel Exampleton" },
    { placeholder: "[[Person 3]]", type: "person", detail: "Quillbank" },
  ],
  next: { person: 4 },
};

describe("the writer's own words", () => {
  it("leaves a family's own words as written: a face's placeholder it names, a value the scope hid; the record's words beside them hidden", async () => {
    const face: Entry = { placeholder: "[[Person 4]]", type: "person", detail: "", face: { x: 0, y: 0, width: 10, height: 10 } };
    const table: PlaceholderTable = { ...HELD, entries: [...HELD.entries, face], next: { person: 5 } };
    const own = "Caption the photo; [[Person 4]] is the face drawn, for Quorvel Exampleton's album.\n";
    const ask: Text = [{ text: own }, { text: "Quorvel Exampleton wrote [[Person 4]] on it", free: true }];
    expect(texts(await hider().hide([ask], "all", table))).toEqual([`${own}[[Person 2]] wrote [[Word 1]] on it`]);
  });
});

describe("a name the writer stated as no person's", () => {
  it("leaves a bot's name a line states plain, though the scope hid a contact of that name", async () => {
    const line = "Zorbot: a synthetic reply";
    const answer = await hider().hide([[{ text: line, free: true, known: [{ start: 0, end: 6, type: "person", who: "assistant:zorbot" }] }]], "all", HELD);
    expect(texts(answer)).toEqual([line]);
    const both = await hider().hide([
      [{ text: "Zorbot", is: "person", who: "p-zorbot" }, { text: " asked." }],
      [{ text: "Zorbot", is: "person", who: "assistant:zorbot" }, { text: ": ", }, { text: "an answer for Zorbot", free: true }],
    ], "all", emptyTable("ask:both"));
    expect(texts(both)).toEqual(["[[Person 1]] asked.", "Zorbot: an answer for [[Person 1]]"]);
    const bank = await hider().hide([[{ text: "Quillbank", is: "person", who: "b-quill" }, { text: " sent a statement" }]], "all", HELD);
    expect(texts(bank)).toEqual(["Quillbank sent a statement"]);
  });

  it("hides a person the name table holds inside a bot's name as anywhere, the bot's own words left; a contact called as the bot is still not", async () => {
    const people: NameTable = {
      version: "people-words-bots",
      owner: PEOPLE.owner,
      people: [
        ...PEOPLE.people.filter((person) => person.who !== "p-zorbot"),
        { who: "p-ada", is: "human", shown: "Ada Lovelace", names: ["Ada Lovelace", "Ada"], accounts: [] },
        { who: "b-photos", is: "bot", shown: "Ada Lovelace (via Example Photos)", names: ["Ada Lovelace (via Example Photos)", "Ada"], accounts: [] },
        { who: "p-zorbot", is: "human", shown: "Zorbot", names: ["Zorbot"], accounts: [] },
      ],
    };
    const sender = "Ada Lovelace (via Example Photos)";
    const snippet = `Mail from ${sender}: a shared album`;
    const call: Text[] = [
      [{ text: sender, is: "person", who: "b-photos" }],
      [{ text: snippet, free: true, known: [{ start: 10, end: 10 + sender.length, type: "person", who: "b-photos" }] }],
      [{ text: "Zorbot: a synthetic reply", free: true, known: [{ start: 0, end: 6, type: "person", who: "assistant:zorbot" }] }],
      [{ text: "Zorbot", is: "person", who: "assistant:zorbot" }, { text: ": an answer for Zorbot", free: true }],
    ];
    for (const level of ["all", ["person"]] as const) {
      expect(texts(await hider(fakeDetector({}), {}, people).hide(call, level, emptyTable(`ask:bot-${String(level)}`)))).toEqual([
        "[[Person 1]] (via Example Photos)",
        "Mail from [[Person 1]] (via Example Photos): a shared album",
        "Zorbot: a synthetic reply",
        "Zorbot: an answer for [[Person 2]]",
      ]);
    }
    expect(texts(await hider(fakeDetector({}), {}, people).hide(call, "names", emptyTable("ask:bot-names")))).toEqual([sender, snippet, "Zorbot: a synthetic reply", "Zorbot: an answer for Zorbot"]);
  });
});

describe("a bank's reference under details hidden", () => {
  it("hides the reference a day line's summary or a mail body gives after ref, UPI Ref No or Reference, and leaves the amount beside it as before", async () => {
    const line = "- 09:14 transaction, account debit: UPI debit of Rs.16.00 to merchant-a from a/c 4521 (Example Bank; ref 123456789012)";
    const body = "Bank alert: Rs.1.00 credited. UPI Ref No: 625800000012. Reference: 625800000013";
    const answer = await hider().hide([[{ text: line, free: true }], [{ text: body, free: true }]], "all", emptyTable("ask:ref"));
    expect(texts(answer)).toEqual([
      "- 09:14 transaction, account debit: UPI debit of Rs.16.00 to merchant-a from a/c [[Number 1]] (Example Bank; ref [[Number 2]])",
      "Bank alert: Rs.1.00 credited. UPI Ref No: [[Number 3]]. Reference: [[Number 4]]",
    ]);
  });
});

describe("a model not used", () => {
  it("says why a call used no model though one is chosen: the find's error, or the detector's line; nothing when none is chosen", async () => {
    const lost = fakeDetector({});
    lost.fail();
    const failed = await hider(lost).hide([[{ text: "Quorvel wrote.", free: true }]], "all", emptyTable("ask:f"));
    expect(failed).toMatchObject({ texts: ["Quorvel wrote."], detector: null, fallback: "the fake detector failed, as scripted" });
    const away = fakeDetector({});
    away.set({ state: "absent", why: "The hiding model's runner is not heard from." });
    expect(await hider(away).hide([[{ text: "Quorvel wrote.", free: true }]], "all", emptyTable("ask:a"))).toMatchObject({ detector: null, fallback: expect.stringContaining("runner") });
    const used = await hider(fakeDetector({ Quorvel: "person" })).hide([[{ text: "Quorvel wrote.", free: true }]], "all", emptyTable("ask:u"));
    expect(used).toMatchObject({ texts: ["[[Person 1]] wrote."], detector: "fake-filter" });
    expect(used).not.toHaveProperty("fallback");
    const off = fakeDetector({});
    off.set({ state: "off" });
    expect(await hider(off).hide([[{ text: "Quorvel wrote.", free: true }]], "all", emptyTable("ask:o"))).not.toHaveProperty("fallback");
  });
});

function marksIn(dir: string, store: number): ReturnType<typeof openMarks> {
  const folder = join(dir, `marks-${store}`);
  return openMarks(openHomeFolder(folder), join(folder, "marks.db"));
}
