import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { emptyTable, openHomeFolder, restoreDetails, sha256, wants, type Box, type Entry, type Level, type Piece, type PlaceholderTable, type Wanted } from "@lifestreamprotocol/core";
import { drew, openHider, openMarks, type Findings, type HideAnswer, type HiddenText, type NameTable, type Picture, type Pictures, type PrivacySettings, type Draft, type Text } from "./index.js";
import { fakeDetector, MODEL, type FakeDetector } from "./test/fake-detector.js";

const dir = mkdtempSync(join(tmpdir(), "lifestream-privacy-hider-"));
const artifact: Record<string, unknown> = {};
afterAll(() => {
  writeFileSync(join(tmpdir(), "privacy-hider.json"), `${JSON.stringify(artifact, null, 2)}\n`);
  rmSync(dir, { recursive: true, force: true });
});

const OWNER_ENTRY: Entry = { placeholder: "[[Person 0]]", type: "person", detail: "Owen Example", who: "p-owner", shown: "Owen Example" };
const PEOPLE: NameTable = {
  version: "people-1",
  owner: { who: "p-owner", shown: "Owen Example" },
  people: [
    { who: "p-owner", is: "human", shown: "Owen Example", names: ["Owen Example", "Owen"], accounts: ["owen@example.com", "+15550000100"] },
    { who: "p-ada", is: "human", shown: "Ada Example", names: ["Ada Example", "Ada"], accounts: ["person-a@example.com", "+15550000001", "adaex"] },
    { who: "p-rose", is: "human", shown: "Rose Example", names: ["Rose Example", "Rose"], accounts: ["+447700900123"] },
    { who: "p-art", is: "human", shown: "Art Example", names: ["Art Example", "Art"], accounts: ["will"] },
    { who: "b-bank", is: "business", shown: "Example Bank", names: ["Example Bank", "Exabank"], accounts: ["+15550000999"] },
  ],
};

const SETTINGS: PrivacySettings = { level: "all", chat: "all", links: "tokens", always: ["Project Falcon"], never: ["Lifestream"] };

function scriptedPictures(findings: Record<string, Findings>): Pictures & { reads: string[]; made: Draft[] } {
  const reads: string[] = [];
  const made: Draft[] = [];
  return {
    reads,
    made,
    async read(blob) {
      reads.push(blob);
      return findings[blob] ?? { cannot: "This picture cannot be read." };
    },
    async make(recipe) {
      made.push(recipe);
      return { jpeg: new TextEncoder().encode(JSON.stringify(recipe)), recipe: { ...recipe, covered: recipe.covered.map((face) => ({ ...face, colour: face.colour ?? "#808080" })), engine: "fake-engine-1" } };
    },
  };
}

let stores = 0;
function hider(options: { detector?: FakeDetector; off?: true; settings?: Partial<PrivacySettings>; people?: NameTable; pictures?: Pictures; store?: ReturnType<typeof openMarks> } = {}) {
  const detector = options.detector ?? fakeDetector({});
  if (options.off === true) detector.set({ state: "off" });
  const store = options.store ?? marksIn(dir, (stores += 1));
  const pictures = options.pictures ?? scriptedPictures({});
  return { detector, store, hider: openHider({ people: () => options.people ?? PEOPLE, settings: () => ({ ...SETTINGS, ...options.settings }), detector, pictures, marks: store }) };
}

function texts(answer: HideAnswer, name?: string): HiddenText[] {
  if (!("texts" in answer)) throw new Error(`expected hidden texts, got ${JSON.stringify(answer)}`);
  if (name !== undefined) artifact[name] = answer.texts.map((text) => (typeof text === "string" || "cannot" in text ? text : text.recipe));
  return answer.texts;
}

const free = (text: string, extra: object = {}): Text => [{ text, free: true, ...extra }];
const table = (): PlaceholderTable => emptyTable("ask:test");

describe("hide", () => {
  it("hides a mail as the spec's example: what the writer stated, what the name table knows, what the rules find", async () => {
    const { hider: h } = hider();
    const mail: Text = [
      { text: "From: " }, { text: "Ada Example", is: "person", who: "p-ada", shown: "Ada Example" }, { text: " <" }, { text: "ada@example.com", is: "email" }, { text: ">\n" },
      { text: "Call me on +15550000142. — Ada", free: true },
    ];
    const answer = await h.hide([mail], "all", table());
    expect(texts(answer, "mail")).toEqual(["From: [[Person 1]] <[[Email 1]]>\nCall me on [[Phone 1]]. — [[Person 1]]"]);
    expect("table" in answer && restoreDetails("[[Person 1]] wrote from [[Email 1]]", answer.table).text).toBe("Ada Example wrote from ada@example.com");
  });

  it("marks a single name that is a plain word only inside a fuller name, or where its writer stated it", async () => {
    const { hider: h } = hider();
    const answer = await h.hide([
      free("Rose Example called; a rose for the art team; Art Example too; Exabank wrote; Owen says hi"),
      free("Rose: dinner at 8?", { known: [{ start: 0, end: 4, type: "person", who: "p-rose" }] }),
    ], "all", table());
    expect(texts(answer, "plain words")).toEqual([
      "[[Person 1]] called; a rose for the art team; [[Person 2]] too; Exabank wrote; [[Person 0]] says hi",
      "[[Person 1]]: dinner at 8?",
    ]);
  });

  it("gives a first name two people share a placeholder of its own", async () => {
    const people: NameTable = { version: "people-shared", owner: null, people: [
      { who: "p-1", is: "human", shown: "Ada Example", names: ["Ada Example", "Ada"], accounts: [] },
      { who: "p-2", is: "human", shown: "Ada Stranger", names: ["Ada Stranger", "Ada"], accounts: [] },
    ] };
    const answer = await hider({ people }).hider.hide([free("Ada Example met Ada Stranger. Ada left.")], "all", table());
    expect(texts(answer)).toEqual(["[[Person 1]] met [[Person 2]]. [[Person 3]] left."]);
    expect("table" in answer && answer.table.entries.map((entry) => entry.who ?? null)).toEqual(["p-1", "p-2", null]);
  });

  it("hides the owner's first name, which a friend shares, as the owner", async () => {
    const people: NameTable = { version: "people-owner-shared", owner: { who: "p-owner", shown: "Owen Example" }, people: [
      { who: "p-friend", is: "human", shown: "Owen Stranger", names: ["Owen Stranger", "Owen"], accounts: [] },
      { who: "p-owner", is: "human", shown: "Owen Example", names: ["Owen Example", "Owen"], accounts: [] },
    ] };
    const answer = await hider({ people }).hider.hide([free("Hi Owen, Owen Stranger is here.")], "all", table());
    expect(texts(answer)).toEqual(["Hi [[Person 0]], [[Person 1]] is here."]);
    expect("table" in answer && answer.table.entries.map((entry) => entry.who ?? null)).toEqual(["p-owner", "p-friend"]);
  });

  it("makes two marks that overlap in part one, hidden whole under a level that hides either type", async () => {
    const detector = fakeDetector({ "Example Road 12": "address" });
    const { hider: h } = hider({ detector });
    const text = free("Ada Example Road 12 is the place");
    expect(texts(await h.hide([text], "names", table()))).toEqual(["[[Address 1]] is the place"]);
    const all = await h.hide([text], "all", table());
    expect(texts(all)).toEqual(["[[Person 1]] is the place"]);
    expect("table" in all && all.table.entries).toEqual([OWNER_ENTRY, { placeholder: "[[Person 1]]", type: "person", detail: "Ada Example Road 12" }]);
    expect(texts(await h.hide([text], ["address"], table()))).toEqual(["[[Address 1]] is the place"]);
  });

  it("hides an address and a profile link that hold a known given name as an email and a link, never as her", async () => {
    const { hider: h } = hider();
    const text = free("Write to ada.example@example.com or see https://social.example.com/ada and https://social.example.com/in/ada-example-3a9f2b");
    for (const level of ["names", "all"] as Level[]) {
      const answer = await h.hide([text], level, table());
      expect(texts(answer, `profile under ${String(level)}`)).toEqual(["Write to [[Email 1]] or see https://social.example.com/[[Link 1]] and https://social.example.com/in/[[Link 2]]"]);
      expect("table" in answer && answer.table.entries.some((entry) => entry.who === "p-ada")).toBe(false);
    }
  });

  it("hides whole a phone a free piece's cut crosses", async () => {
    const { hider: h } = hider();
    const cut: Text = [{ text: "Call +1 555 0", free: true, whole: "Call +1 555 000 0001 now, or later" }, { text: " [cut]" }];
    expect(texts(await h.hide([cut], "all", table()))).toEqual(["Call [[Phone 1]] [cut]"]);
  });

  it("hides a long text whole, a value marked anywhere in it hidden wherever it stands; a piece cut from inside its whole is refused", async () => {
    const { hider: h } = hider();
    const whole = "Password: zorbix. Echo zorbix";
    expect(texts(await h.hide([free(whole)], "all", table()), "a value marked before its echo")).toEqual(["Password: [[Secret 1]]. Echo [[Secret 1]]"]);
    const later = { text: "Echo zorbix", free: true, whole } as const;
    await expect(h.hide([[later]], "all", table())).rejects.toThrow(/begins with its text/u);
    await expect(h.hide([[{ ...later, from: whole.indexOf("Echo") } as unknown as Piece]], "all", table())).rejects.toThrow(/begins with its text/u);
  });

  it("never reads a value or a placeholder of the table across free pieces joined from two wholes: a cut from inside is refused, a join is read as it reads", async () => {
    const { hider: h } = hider();
    const seeded = await h.hide([free("Password: zorbix"), free("Call +1 555 000 0001")], "all", table());
    expect(texts(seeded)).toEqual(["Password: [[Secret 1]]", "Call [[Phone 1]]"]);
    if (!("table" in seeded)) throw new Error("no table");
    const piece = (text: string, whole: string, from?: number) => ({ text, free: true, whole, ...(from === undefined ? {} : { from }) }) as unknown as Piece;
    await expect(h.hide([free("Password: zorbix"), [piece("zor", "zor tail"), piece("bix", "head bix", 5)]], "all", table())).rejects.toThrow(/begins with its text/u);
    await expect(h.hide([[piece("[[Pho", "[[Pho tail"), piece("ne 1]]", "head ne 1]]", 5)]], "all", seeded.table)).rejects.toThrow(/begins with its text/u);
    const joined = await h.hide([free("Password: zorbix"), [piece("zor", "zor tail"), { text: "bix", free: true }]], "all", table());
    expect(texts(joined, "a value across a join")).toEqual(["Password: [[Secret 1]]", "[[Secret 1]]"]);
    const shaped = await h.hide([[piece("[[Pho", "[[Pho tail"), { text: "ne 1]]", free: true }]], "all", seeded.table);
    const [out] = texts(shaped, "a placeholder across a join");
    if (!("table" in shaped) || typeof out !== "string") throw new Error("not hidden");
    expect(restoreDetails(out, shaped.table).text).toBe("[[Phone 1]]");
  });

  it("hides whole a phone cut at its space where a passage ends, reading the passage after the cut too", async () => {
    const { hider: h, detector } = hider();
    const before = "a ".repeat(497);
    const whole = `${before}+1 555 000 0142 and then some more words after it`;
    const cut: Text = [{ text: whole.slice(0, 1_000), free: true, whole }, { text: " [cut]" }];
    expect(texts(await h.hide([cut], "all", table()), "cut at a passage's edge")).toEqual([`${before}[[Phone 1]] [cut]`]);
    expect(detector.calls).toEqual([[`${before}+1 555`, "000 0142 and then some more words after it"]]);
  });

  it("hides whole an address a free piece's cut crosses in a paragraph with no space", async () => {
    const { hider: h } = hider();
    const whole = `${"~".repeat(990)}person-a@example.com${"~".repeat(500)}`;
    const answer = await h.hide([[{ text: whole.slice(0, 1_000), free: true, whole }]], "all", table());
    expect(texts(answer)).toEqual([`${"~".repeat(990)}[[Email 1]]`]);
    expect("table" in answer && answer.table.entries[1]).toMatchObject({ placeholder: "[[Email 1]]", who: "p-ada" });
  });

  it("hides a WhatsApp id and a chat's key that are phones under a list that hides phones, as the person whose phone it is", async () => {
    const { hider: h } = hider();
    const answer = await h.hide([
      [{ text: "15550000001@s.whatsapp.net", is: "phone" }],
      free("Ada: my other one is 15550000001@s.whatsapp.net"),
    ], ["phone"], table());
    expect(texts(answer)).toEqual(["[[Phone 1]]", "Ada: my other one is [[Phone 1]]"]);
    expect("table" in answer && answer.table.entries).toMatchObject([OWNER_ENTRY, { placeholder: "[[Phone 1]]", who: "p-ada" }]);
  });

  it("hides a contact's phone in any spelling no rule knows, as theirs, and keeps a bracket it does not open", async () => {
    const { hider: h } = hider();
    const answer = await h.hide([free("Ring 5550000001 or 07700 900123 (or 555 000 0001), not 5550000002")], "all", table());
    expect(texts(answer, "contact phones")).toEqual(["Ring [[Phone 1]] or [[Phone 2]] (or [[Phone 1]]), not 5550000002"]);
    expect("table" in answer && answer.table.entries.slice(1)).toMatchObject([{ placeholder: "[[Phone 1]]", who: "p-ada" }, { placeholder: "[[Phone 2]]", who: "p-rose" }]);
  });

  it("leaves a one-word account that is a plain word, and a business stated or known as a person", async () => {
    const { hider: h } = hider();
    const answer = await h.hide([
      free("I will call adaex"),
      free("Exabank: your statement", { known: [{ start: 0, end: 7, type: "person", who: "b-bank" }] }),
      [{ text: "Example Bank", is: "person", who: "b-bank" }, { text: " wrote to " }, { text: "Ada", is: "person", who: "p-ada" }],
    ], "all", table());
    expect(texts(answer)).toEqual(["I will call [[Account 1]]", "Exabank: your statement", "Example Bank wrote to [[Person 1]]"]);
  });

  it("hides under a list of subtypes what it names and every number nobody typed, and leaves an order number a rule typed", async () => {
    const { hider: h } = hider({ detector: fakeDetector({ "7741": "number" }) });
    const answer = await h.hide([free("IBAN GB82 WEST 1234 5698 7654 32, ref 7741, order #99812")], ["number.bank"], table());
    expect(texts(answer)).toEqual(["IBAN [[Number 1]], ref [[Number 2]], order #99812"]);
  });

  it("applies the person's lists last: a never word left, an always word hidden under every level but none", async () => {
    const { hider: h } = hider({ detector: fakeDetector({ Lifestream: "person" }) });
    const text = free("Lifestream runs Project Falcon for Ada");
    expect(texts(await h.hide([text], "all", table()))).toEqual(["Lifestream runs [[Word 1]] for [[Person 1]]"]);
    const listed = await h.hide([text], ["phone"], table());
    expect(texts(listed)).toEqual(["Lifestream runs [[Word 1]] for Ada"]);
    expect("counts" in listed && listed.counts).toEqual({ word: 1 });
    expect(texts(await h.hide([text], "names", table()))).toEqual(["Lifestream runs [[Word 1]] for Ada"]);
    expect(texts(await h.hide([text], "none", table()))).toEqual(["Lifestream runs Project Falcon for Ada"]);
  });

  it("passes a quote as written, and makes every ref a handle under none without marking or waiting", async () => {
    const detector = fakeDetector({ Ada: "person" });
    detector.set({ state: "absent", why: "The hiding model is not on this Mac." });
    const { hider: h } = hider({ detector });
    const answer = await h.hide([
      [{ text: "You wrote: " }, { text: "[[Person 9]] went", quote: true }, { text: "\nsee " }, { text: "whatsapp:a:b/1", is: "ref" }, { text: " — Ada", free: true }],
    ], "none", table());
    expect(texts(answer)).toEqual(["You wrote: [[Person 9]] went\nsee r1 — Ada"]);
    expect(detector.calls).toEqual([]);
    const quoted = await hider().hider.hide([[{ text: "[[Person 9]] and Person 1", quote: true }, { text: " Ada", free: true }]], "all", table());
    expect(texts(quoted)).toEqual(["[[Person 9]] and Person 1 [[Person 10]]"]);
  });

  it("answers each text's spans over the text as given, its segments joined: stated, free and own pieces around a quote, and none for a picture; a picture says whether anything was drawn on it", async () => {
    const bare = `sha256:${"1".repeat(64)}`;
    const faced = `sha256:${"2".repeat(64)}`;
    const pictures = scriptedPictures({ [bare]: { lines: [], faces: [] }, [faced]: { lines: [], faces: [{ box: { x: 1, y: 1, width: 20, height: 20 } }] } });
    const { hider: h } = hider({ pictures, detector: fakeDetector({ Rose: "person" }) });
    const pieces: Text = [
      { text: "From: " }, { text: "Ada Example", is: "person", who: "p-ada", shown: "Ada Example" }, { text: "\n" },
      { text: "[[Person 9]] said", quote: true },
      { text: " call +15550000142, Rose.", free: true }, { text: " Thanks, " }, { text: "person-a@example.com", is: "email" },
    ];
    const given = (pieces as readonly { text: string }[]).map((piece) => piece.text).join("");
    const answer = await h.hide([pieces, { picture: bare }, { picture: faced }], "all", table());
    if (!("spans" in answer)) throw new Error(`expected hidden texts, got ${JSON.stringify(answer)}`);
    let out = "";
    let from = 0;
    for (const span of answer.spans[0]!) {
      out += given.slice(from, span.start) + span.placeholder;
      from = span.end;
    }
    expect(out + given.slice(from)).toBe(answer.texts[0]);
    expect(answer.spans[0]!.map((span) => [given.slice(span.start, span.end), span.placeholder])).toEqual([
      ["Ada Example", "[[Person 10]]"], ["+15550000142", "[[Phone 1]]"], ["Rose", "[[Person 11]]"], ["person-a@example.com", "[[Email 1]]"],
    ]);
    expect(answer.spans.slice(1)).toEqual([[], []]);
    expect(answer.texts.slice(1).map((picture) => drew(picture as Picture))).toEqual([false, true]);
  });
});

describe("a sealed person", () => {
  const SEALED = { sealed: { people: new Set(["p-ada"]), handles: [] }, shown: [] };
  const words = "Ada Example met Rose Example; Ada called from +15550000001 and wrote from person-a@example.com about Project Falcon";
  const met = free(words);

  it("hides every mark that names a sealed person under every level, none too, and leaves the rest as the level does", async () => {
    const { hider: h, detector } = hider();
    expect(texts(await h.hide([met, [{ text: "Ada", is: "person", who: "p-ada" }, { text: " and " }, { text: "Rose", is: "person", who: "p-rose" }]], "none", table(), undefined, undefined, SEALED)))
      .toEqual(["[[Person 1]] met Rose Example; [[Person 1]] called from [[Phone 1]] and wrote from [[Email 1]] about Project Falcon", "[[Person 1]] and Rose"]);
    expect(detector.calls).toEqual([]);
    expect(texts(await h.hide([met], "names", table(), undefined, undefined, SEALED)))
      .toEqual(["[[Person 1]] met Rose Example; [[Person 1]] called from [[Phone 1]] and wrote from [[Email 1]] about [[Word 1]]"]);
    expect(texts(await h.hide([met], ["word"], table(), undefined, undefined, SEALED)))
      .toEqual(["[[Person 1]] met Rose Example; [[Person 1]] called from [[Phone 1]] and wrote from [[Email 1]] about [[Word 1]]"]);
    expect(texts(await h.hide([met], "all", table(), undefined, undefined, SEALED))).toEqual(texts(await h.hide([met], "all", table())));
  });

  it("keeps the sealed person's entry by who, so the next call of the table gives the same placeholder, and a name the table holds of someone else stays plain", async () => {
    const { hider: h } = hider();
    const before = await h.hide([free("Rose Example and Ada Example")], "all", table());
    if (!("table" in before)) throw new Error("hidden");
    const after = await h.hide([free("Rose wrote to Ada; Rose Example and Ada Example")], "none", before.table, undefined, undefined, SEALED);
    expect(texts(after)).toEqual(["Rose wrote to [[Person 2]]; Rose Example and [[Person 2]]"]);
    expect("table" in after && after.table.entries.find((entry) => entry.placeholder === "[[Person 2]]")).toMatchObject({ detail: "Ada Example", who: "p-ada" });
  });

  it("wins over the never list and a detail shown, by the person each mark names, never by its words: the same words of anyone else stay plain", async () => {
    const { hider: h } = hider({ settings: { never: ["Lifestream", "Ada", "Ada Example", "+15550000001"] } });
    const shown = { sealed: { people: new Set(["p-ada"]), handles: [] }, shown: ["Ada", "+447700900123"] };
    expect(texts(await h.hide([free("Ada Example on +15550000001, Ada called, Rose Example on +447700900123")], "all", table(), undefined, undefined, shown)))
      .toEqual(["[[Person 1]] on [[Phone 1]], [[Person 1]] called, [[Person 2]] on +447700900123"]);
    const ada = { sealed: { people: new Set(["p-rose"]), handles: [] }, shown: ["Ada"] };
    expect(texts(await h.hide([free("Ada called")], "all", table(), undefined, undefined, ada))).toEqual(["Ada called"]);
  });

  it("hides a sealed person's handle stated as an id, a phone, an address or an account, at none, and a handle the list holds that People no longer gives anyone", async () => {
    const { hider: h } = hider();
    const ids: Text[] = ["+15550000001", "person-a@example.com", "adaex", "+447700900123", "old-ada@example.com"].map((text) => [{ text, is: text.startsWith("+") ? "phone" : text.includes("@") ? "email" : "account" }]);
    const sealed = { sealed: { people: new Set(["p-ada"]), handles: ["old-ada@example.com"] }, shown: [] };
    expect(texts(await h.hide(ids, "none", table(), undefined, undefined, sealed))).toEqual(["[[Phone 1]]", "[[Email 1]]", "[[Account 1]]", "+447700900123", "[[Email 2]]"]);
    expect(texts(await h.hide([free("mail old-ada@example.com or ring Rose")], "none", table(), undefined, undefined, sealed))).toEqual(["mail [[Email 1]] or ring Rose"]);
  });

  it("hides a sealed person's payment address at none, and leaves anyone else's", async () => {
    const people: NameTable = { version: "people-pay", owner: null, people: [
      { who: "p-ada", is: "human", shown: "Ada Example", names: ["Ada Example"], accounts: ["ada@okaxis"] },
      { who: "p-rose", is: "human", shown: "Rose Example", names: ["Rose Example"], accounts: ["rose@okaxis"] },
    ] };
    const { hider: h } = hider({ people });
    const sealed = { sealed: { people: new Set(["p-ada"]), handles: [] }, shown: [] };
    const [said] = texts(await h.hide([free("Paid ada@okaxis, then rose@okaxis")], "none", table(), undefined, undefined, sealed));
    expect(said).not.toContain("ada@okaxis");
    expect(said).toMatch(/^Paid \[\[[^\]]+\]\], then rose@okaxis$/u);
  });

  it("hides a name two people share when one of them is sealed: it may be the sealed one", async () => {
    const people: NameTable = { version: "people-sam", owner: null, people: [
      { who: "p-sam", is: "human", shown: "Sam Example", names: ["Sam Example", "Sam"], accounts: [] },
      { who: "p-sam2", is: "human", shown: "Sam Other", names: ["Sam Other", "Sam"], accounts: [] },
    ] };
    const { hider: h } = hider({ people });
    const sam = { sealed: { people: new Set(["p-sam"]), handles: [] }, shown: [] };
    expect(texts(await h.hide([free("Sam called, then Sam Other wrote")], "none", table(), undefined, undefined, sam))).toEqual(["[[Person 1]] called, then Sam Other wrote"]);
  });

  it("under only, hides every name, number and address of anyone not listed, found by People, the rules or the hiding model, at none too; the listed and the owner stay as the level leaves them", async () => {
    const detector = fakeDetector({ "Zed Nobody": "person" });
    const { hider: h } = hider({ detector });
    const only = { sealed: { except: new Set(["p-rose"]) }, shown: [] };
    expect(texts(await h.hide([free("Rose Example, Owen, Ada Example and Zed Nobody; ring +15550000001 or +15550000777, mail stranger@example.com")], "none", table(), undefined, undefined, only)))
      .toEqual(["Rose Example, Owen, [[Person 1]] and [[Person 2]]; ring [[Phone 1]] or [[Phone 2]], mail [[Email 1]]"]);
    expect(detector.calls.length).toBe(1);
  });

  it("reads People's names only for a sealed list: under none with none sealed it reads nothing and waits on nothing, with one it waits for the names", async () => {
    const own = openHider({ people: () => undefined, settings: () => SETTINGS, detector: fakeDetector({}), pictures: scriptedPictures({}), marks: openMarks(openHomeFolder(dirname(join(dir, "sealed-no-names", "marks.db"))), join(dir, "sealed-no-names", "marks.db")) });
    expect(texts(await own.hide([met], "none", table()))).toEqual([words]);
    expect(texts(await own.hide([met], "none", table(), undefined, undefined, { sealed: { people: new Set(), handles: [] }, shown: [] }))).toEqual([words]);
    expect(await own.hide([met], "none", table(), undefined, undefined, SEALED)).toEqual({ wait: "Waiting for People to list the names of your people" });
  });
});

describe("a detail inside another", () => {
  it("hides a secret a link holds under a list that hides secrets and leaves links", async () => {
    const { hider: h } = hider();
    const text = free("Reset at https://example.com/reset?token=8f3k2q9xw7v1&u=1 today");
    const level: Level = ["number.bank", "number.card", "number.government", "secret", "place"];
    expect(texts(await h.hide([text], level, table()), "secret in a link")).toEqual(["Reset at https://example.com/reset?[[Secret 1]] today"]);
    expect(texts(await h.hide([text], "all", table()))).toEqual(["Reset at https://example.com/reset?[[Link 1]] today"]);
  });

  it("hides a phone a WhatsApp link holds under a list that hides phones, whole where it is the segment and with the part around it where it is inside one", async () => {
    const { hider: h } = hider();
    const answer = await h.hide([free("Message me: https://wa.me/15550000001 or https://api.whatsapp.com/send?phone=15550000001")], ["phone"], table());
    expect(texts(answer, "phone in a link")).toEqual(["Message me: https://wa.me/[[Phone 1]] or https://api.whatsapp.com/send?[[Phone 1]]"]);
    expect("table" in answer && answer.table.entries.slice(1)).toEqual([{ placeholder: "[[Phone 1]]", type: "phone", detail: "15550000001", who: "p-ada" }]);
  });

  it("hides an address that holds a name under a list that hides people and leaves addresses", async () => {
    const { hider: h } = hider();
    const answer = await h.hide([free("Write to ada.example@example.com")], ["person"], table());
    expect(texts(answer)).toEqual(["Write to [[Person 1]]"]);
    expect("table" in answer && answer.table.entries[1]).toEqual({ placeholder: "[[Person 1]]", type: "person", detail: "ada.example@example.com" });
  });

  it("hides an always word a link holds under a level that leaves links", async () => {
    const { hider: h } = hider({ settings: { always: ["falcon"] } });
    expect(texts(await h.hide([free("See https://notes.example.com/falcon-plans now")], ["phone"], table()))).toEqual(["See https://notes.example.com/[[Word 1]] now"]);
  });
});

describe("the table", () => {
  it("holds the owner as [[Person 0]] though the call never names them, so a model's [[Person 0]] is put back", async () => {
    const answer = await hider().hider.hide([free("Ada called.")], "all", table());
    expect("table" in answer && answer.table.entries[0]).toEqual(OWNER_ENTRY);
    expect("table" in answer && restoreDetails("[[Person 0]] called [[Person 1]] back", answer.table).text).toBe("Owen Example called Ada back");
  });

  it("gives a stranger who shares the owner's first name a placeholder of their own, put back as written", async () => {
    const answer = await hider().hider.hide([free("Owen Lovelace wrote the first program; Owen Example read it.")], "all", table());
    expect(texts(answer)).toEqual(["[[Person 1]] wrote the first program; [[Person 0]] read it."]);
    expect("table" in answer && restoreDetails("[[Person 1]] and [[Person 0]]", answer.table).text).toBe("Owen Lovelace and Owen Example");
  });

  it("leaves an assistant the line states as a bot plain, though a contact bears its name", async () => {
    const people: NameTable = { ...PEOPLE, version: "people-bot", people: [...PEOPLE.people, { who: "p-zorbot", is: "human", shown: "Zorbot Exampleton", names: ["Zorbot Exampleton", "Zorbot"], accounts: [] }, { who: "assistant:zorbot", is: "bot", shown: "Zorbot", names: ["Zorbot"], accounts: [] }] };
    const line = "Zorbot: a synthetic reply to Zorbot Exampleton";
    const answer = await hider({ people }).hider.hide([free(line, { known: [{ start: 0, end: 6, type: "person", who: "assistant:zorbot" }] })], "all", table());
    expect(texts(answer)).toEqual(["Zorbot: a synthetic reply to [[Person 1]]"]);
    expect(texts(await hider({ people }).hider.hide([free("Zorbot came")], "all", table()))).toEqual(["[[Person 1]] came"]);
  });

  it("asks for the part of the table the call can use once its marks are made, and answers as given the whole", async () => {
    const { hider: h } = hider();
    const whole: PlaceholderTable = {
      scope: "grant:g-1",
      entries: [OWNER_ENTRY, ...Array.from({ length: 500 }, (_, index): Entry => ({ placeholder: `[[Person ${index + 1}]]`, type: "person", detail: `Name${index} Example`, who: `p-${index}` })), { placeholder: "[[Person 501]]", type: "person", detail: "Ada Example", who: "p-ada", shown: "Ada Example" }],
      next: { person: 502 },
    };
    const text = free("Ada wrote to Name7 Example and Person 12");
    const asked: Wanted[] = [];
    const part = await h.hide([text], "all", (wanted) => {
      asked.push(wanted);
      return { ...whole, entries: whole.entries.filter((entry) => wants(wanted, entry)) };
    });
    expect(asked).toHaveLength(1);
    expect([...asked[0]!.who]).toEqual(["p-ada"]);
    const named = Array.from({ length: 100 }, (_, index) => `[[Person ${index + 1}]]`);
    expect("table" in part && part.table.entries.map((entry) => entry.placeholder)).toEqual(["[[Person 0]]", ...named, "[[Person 501]]", "[[Word 1]]"]);
    const all = await h.hide([text], "all", whole);
    expect(texts(part)).toEqual(texts(all));
    expect(texts(all)).toEqual(["[[Person 501]] wrote to [[Person 8]] and [[Word 1]]"]);
    const later = await h.hide([text], "all", async (wanted) => {
      asked.push(wanted);
      return { ...whole, entries: whole.entries.filter((entry) => wants(wanted, entry)) };
    });
    expect(asked).toHaveLength(2);
    expect(later).toEqual(part);
  });

  it("waits under a level that hides while People has no name table ready, never making one up, and carries on under none with no owner", async () => {
    const detector = fakeDetector({ Quorvel: "person" });
    const pictures = scriptedPictures({});
    const off = fakeDetector({});
    off.set({ state: "off" });
    const own = (chosen: FakeDetector = detector) => openHider({ people: () => undefined, settings: () => SETTINGS, detector: chosen, pictures, marks: openMarks(openHomeFolder(dirname(join(dir, "no-names", "marks.db"))), join(dir, "no-names", "marks.db")) });
    const waiting = { wait: "Waiting for People to list the names of your people" };
    for (const h of [own(), own(off)]) {
      expect(h.ready("all")).toEqual(waiting);
      expect(h.ready(["phone"])).toEqual(waiting);
      expect(await h.hide([free("Quorvel called +15550000142")], "all", table())).toEqual(waiting);
      expect(await h.hide([free("Quorvel called +15550000142")], ["phone"], table())).toEqual(waiting);
      expect(h.ready("none")).toBe(true);
      const none = await h.hide([[{ text: "see " }, { text: "whatsapp:a:b/1", is: "ref" }, { text: " — Quorvel", free: true }]], "none", table());
      expect(texts(none)).toEqual(["see r1 — Quorvel"]);
      expect("table" in none && none.table.entries.some((entry) => entry.placeholder === "[[Person 0]]")).toBe(false);
    }
    expect(detector.calls).toEqual([]);
    const marks = openMarks(openHomeFolder(dirname(join(dir, "no-names", "marks.db"))), join(dir, "no-names", "marks.db"));
    expect(await own().mark(["Quorvel called."], marks.epoch)).toEqual({ passages: 1, found: 1 });
    marks.close();
  });

  it("compiles the name table once per version", async () => {
    let people: NameTable = PEOPLE;
    const { hider: h } = hider();
    const own = openHider({ people: () => people, settings: () => SETTINGS, detector: fakeDetector({}), pictures: scriptedPictures({}), marks: openMarks(openHomeFolder(dirname(join(dir, "versions", "marks.db"))), join(dir, "versions", "marks.db")) });
    const text = free("Zandrel Example wrote");
    expect(texts(await own.hide([text], "all", table()))).toEqual(["Zandrel Example wrote"]);
    people = { ...PEOPLE, version: "people-2", people: [...PEOPLE.people, { who: "p-zandrel", is: "human", shown: "Zandrel Example", names: ["Zandrel Example"], accounts: [] }] };
    expect(texts(await own.hide([text], "all", table()))).toEqual(["[[Person 1]] wrote"]);
    people = { ...PEOPLE, version: "people-2" };
    expect(texts(await own.hide([text], "all", table()))).toEqual(["[[Person 1]] wrote"]);
    expect(texts(await h.hide([text], "all", table()))).toEqual(["Zandrel Example wrote"]);
  });
});

describe("the detector", () => {
  it("never waits on a detector chosen that is not ready: it hides as with none, by the rules and the names, answers no model, and uses the model once it is ready", async () => {
    const detector = fakeDetector({ Quorvel: "person" });
    detector.set({ state: "downloading", bytes: 340_000_000, total: 900_000_000 });
    const { hider: h, store } = hider({ detector });
    const text = free("Quorvel and Ada: call +15550000142");
    const off = hider({ off: true }).hider;
    const plain = await off.hide([text], "all", table());
    expect(texts(plain)).toEqual(["Quorvel and [[Person 1]]: call [[Phone 1]]"]);
    expect(plain).toMatchObject({ detector: null });
    for (const state of [{ state: "downloading", bytes: 340_000_000, total: 900_000_000 }, { state: "absent", why: "The hiding model failed its check." }] as const) {
      detector.set(state);
      expect(h.ready("all")).toBe(true);
      expect(h.ready(["phone"])).toBe(true);
      expect(await h.hide([text], "all", table())).toEqual({ ...plain, fallback: state.state === "absent" ? state.why : "Downloading the hiding model: 340 of 900 MB" });
    }
    expect(h.ready("none")).toBe(true);
    expect(await h.hide([text], "none", table())).toMatchObject({ texts: ["Quorvel and Ada: call +15550000142"], detector: null });
    expect(detector.calls).toEqual([]);
    expect(store.read([sha256("Quorvel and Ada: call +15550000142")], MODEL).size).toBe(0);
    detector.set({ state: "ready", model: MODEL });
    const modelled = await h.hide([text], "all", table());
    expect(texts(modelled)).toEqual(["[[Person 1]] and [[Person 2]]: call [[Phone 1]]"]);
    expect(modelled).toMatchObject({ detector: MODEL.id });
  });

  it("finds each passage once, keeps its marks, and reads them after: a line added finds only its own paragraph", async () => {
    const detector = fakeDetector({ Quorvel: "person" });
    const { hider: h, store } = hider({ detector });
    const first = await h.hide([free("Quorvel wrote.\n\nShe will call.")], "all", table());
    expect(texts(first)).toEqual(["[[Person 1]] wrote.\n\nShe will call."]);
    expect(texts(await h.hide([free("Quorvel wrote.\n\nShe will call.")], "all", table()))).toEqual(["[[Person 1]] wrote.\n\nShe will call."]);
    await h.hide([free("Quorvel wrote.\n\nShe will call.\n\nQuorvel again.")], "all", table());
    expect(detector.calls).toEqual([["Quorvel wrote.", "She will call."], ["Quorvel again."]]);
    const other = hider({ detector: fakeDetector({}), store }).hider;
    expect(texts(await other.hide([free("Quorvel again.")], "all", table()))).toEqual(["[[Person 1]] again."]);
  });

  it("hides the model's marks that have the shape of their type, and keeps every mark it found: a word with no vowel, a date's piece and a lone word left; a plain-word name, a user name it typed a person, a phone it gave in pieces hidden", async () => {
    const detector = fakeDetector({ PNR: "person", "02": "number", Keypad: "address", Grace: "person", zorvan_example12: "person", "555-010": "phone", "0123": "phone" });
    const { hider: h, store } = hider({ detector });
    const text = "PNR on file\nDue 25-02-2026. Keypad\nGrace came by: user zorvan_example12, call 555-010-0123";
    expect(texts(await h.hide([free(text)], "all", table()))).toEqual(["PNR on file\nDue 25-02-2026. Keypad\n[[Person 1]] came by: user [[Account 1]], call [[Phone 1]]"]);
    expect([...store.read([sha256(text)], MODEL).values()][0]!.marks).toHaveLength(7);
  });

  it("answers wait past its bound, keeps what lands meanwhile, and finds it again for no call", async () => {
    const detector = fakeDetector({ Quorvel: "person" });
    const { hider: h } = hider({ detector });
    const release = detector.hold();
    const text = free("Quorvel wrote.\n\nShe called.");
    expect(await h.hide([text], "all", table(), 1)).toEqual({ wait: "Marking your record: 0 of 2 passages" });
    const second = h.hide([text], "all", table());
    release();
    expect(texts(await second)).toEqual(["[[Person 1]] wrote.\n\nShe called."]);
    expect(texts(await h.hide([text], "all", table(), 1))).toEqual(["[[Person 1]] wrote.\n\nShe called."]);
    expect(detector.calls).toHaveLength(1);
  });

  it("places at most 32 passages in one find", async () => {
    const detector = fakeDetector({});
    const { hider: h } = hider({ detector });
    const paragraphs = Array.from({ length: 40 }, (_, index) => `Paragraph ${index} of the screen.`).join("\n\n");
    texts(await h.hide([free(paragraphs)], "all", table()));
    expect(detector.calls.map((call) => call.length)).toEqual([32, 8]);
  });

  it("reads a new model's passages under the old marks until the marking job finds them again", async () => {
    const detector = fakeDetector({ Quorvel: "person" });
    const { hider: h, store } = hider({ detector });
    const text = "Quorvel wrote.";
    texts(await h.hide([free(text)], "all", table()));
    const next = { ...MODEL, decode: "2" };
    detector.set({ state: "ready", model: next });
    expect(texts(await h.hide([free(text)], "all", table()))).toEqual(["[[Person 1]] wrote."]);
    expect(detector.calls).toHaveLength(1);
    expect(await h.mark([text, "Another line."], store.epoch)).toEqual({ passages: 2, found: 2 });
    expect(await h.mark([text], store.epoch)).toEqual({ passages: 1, found: 0 });
    expect(await store.dropOthers(next)).toBe(1);
  });

  it("places a send run's passages at once while the marking job's later batches wait their turn", async () => {
    const detector = fakeDetector({ Quorvel: "person" });
    const { hider: h, store } = hider({ detector });
    const paragraphs = Array.from({ length: 40 }, (_, index) => (index === 36 ? "Quorvel called." : `Paragraph ${index} of the record.`));
    const release = detector.hold();
    let done = false;
    const job = h.mark([paragraphs.join("\n\n")], store.epoch).then((answer) => {
      done = true;
      return answer;
    });
    expect(texts(await h.hide([free("Quorvel called.")], "all", table()))).toEqual(["[[Person 1]] called."]);
    expect(done).toBe(false);
    expect(detector.calls.map((call) => call.length)).toEqual([32, 1]);
    release();
    expect(await job).toEqual({ passages: 40, found: 39 });
    expect(detector.calls.map((call) => call.length)).toEqual([32, 1, 7]);
  });

  it("frees the passages of a find whose runner was lost: the call that placed it hides without the model, a call waiting on it places them again itself", async () => {
    const detector = fakeDetector({ Quorvel: "person" });
    const { hider: h, store } = hider({ detector });
    const lose = detector.hold();
    const text = free("Quorvel wrote.");
    const first = h.hide([text], "all", table());
    const second = h.hide([text], "all", table());
    lose(new Error("the runner was lost"));
    expect(await first).toMatchObject({ texts: ["Quorvel wrote."], detector: null });
    expect(texts(await second)).toEqual(["[[Person 1]] wrote."]);
    expect(texts(await h.hide([text], "all", table()))).toEqual(["[[Person 1]] wrote."]);
    expect(detector.calls).toEqual([["Quorvel wrote."], ["Quorvel wrote."]]);
    const again = detector.hold();
    const sent = h.hide([free("Quorvel called.")], "all", table());
    const job = h.mark(["Quorvel called."], store.epoch);
    again(new Error("the runner was lost"));
    expect(await sent).toMatchObject({ texts: ["Quorvel called."], detector: null });
    expect(await job).toEqual({ passages: 1, found: 1 });
  });

  it("places a hide's finds for a hide and the marking job's for the marking job, so each waits in its own line", async () => {
    const detector = fakeDetector({ Quorvel: "person" });
    const { hider: h, store } = hider({ detector });
    texts(await h.hide([free("Quorvel wrote.")], "all", table()));
    expect(await h.mark(["Quorvel called."], store.epoch)).toEqual({ passages: 1, found: 1 });
    expect(detector.by).toEqual(["hide", "mark"]);
  });

  it("keeps nothing a find in flight found of a passage an erasure forgot meanwhile, and the marking job answers again, never done", async () => {
    const detector = fakeDetector({ Quorvel: "person" });
    const { hider: h, store } = hider({ detector });
    const passage = "Quorvel wrote this, then it was erased.";
    const release = detector.hold();
    const job = h.mark([passage], store.epoch);
    const read = h.hide([free("Quorvel called.")], "all", table());
    store.forget([sha256(passage)]);
    release();
    expect(await job).toEqual({ again: "An erasure forgot passages while they were marked: read the texts again" });
    expect(texts(await read)).toEqual(["[[Person 1]] called."]);
    expect(store.read([sha256(passage), sha256("Quorvel called.")], MODEL).size).toBe(0);
    expect(detector.calls).toEqual([[passage], ["Quorvel called."]]);
    expect(await h.mark(["Quorvel called."], store.epoch)).toEqual({ passages: 1, found: 1 });
    expect(store.read([sha256("Quorvel called.")], MODEL).size).toBe(1);
    const before = store.epoch;
    store.forget([sha256("Quorvel called again.")]);
    expect(await h.mark(["Quorvel called again."], before)).toEqual({ again: "An erasure forgot passages while they were marked: read the texts again" });
    expect(store.read([sha256("Quorvel called again.")], MODEL).size).toBe(0);
  });

  it("keeps nothing a hide finds under an epoch its caller read before an erasure began, though it still hides the call", async () => {
    const { hider: h, store } = hider({ detector: fakeDetector({ Quorvel: "person" }) });
    const before = store.epoch;
    store.forget([sha256("Quorvel phoned.")]);
    expect(texts(await h.hide([free("Quorvel phoned.")], "all", table(), undefined, before))).toEqual(["[[Person 1]] phoned."]);
    expect(store.read([sha256("Quorvel phoned.")], MODEL).size).toBe(0);
    expect(texts(await h.hide([free("Quorvel phoned.")], "all", table()))).toEqual(["[[Person 1]] phoned."]);
    expect(store.read([sha256("Quorvel phoned.")], MODEL).size).toBe(1);
  });

  it("answers again, never wait, when the model moves under every round, and wait while no model is ready", async () => {
    const detector = fakeDetector({ Quorvel: "person" });
    const listed = { ...MODEL, decode: "listed" };
    const moving = { ...detector, state: () => ({ state: "ready" as const, model: listed }) };
    const { hider: h, store } = hider({ detector: moving as FakeDetector });
    expect(await h.mark(["Quorvel wrote."], store.epoch)).toEqual({ again: "The hiding model changed while it marked: 0 of 1 passages" });
    expect(detector.calls).toHaveLength(3);
    detector.set({ state: "downloading", bytes: 340_000_000, total: 900_000_000 });
    const { hider: waiting, store: waitingStore } = hider({ detector });
    expect(await waiting.mark(["Quorvel wrote."], waitingStore.epoch)).toEqual({ wait: "Downloading the hiding model: 340 of 900 MB" });
  });

  it("counts a passage marked only under the model ready when the marking job answers, and places the rest again", async () => {
    const detector = fakeDetector({ Quorvel: "person" });
    const { hider: h, store } = hider({ detector });
    const release = detector.hold();
    const read = h.hide([free("Quorvel wrote.")], "all", table());
    const next = { ...MODEL, decode: "2" };
    detector.set({ state: "ready", model: next });
    const job = h.mark(["Quorvel wrote."], store.epoch);
    release();
    texts(await read);
    expect(await job).toEqual({ passages: 1, found: 1 });
    expect(detector.calls).toEqual([["Quorvel wrote."], ["Quorvel wrote."]]);
    expect(store.read([sha256("Quorvel wrote.")], next).get(sha256("Quorvel wrote."))?.current).toBe(true);
  });

  it("answers the marking job wait with the detector off", async () => {
    const { hider: h, detector, store } = hider({ off: true });
    expect(await h.mark(["Quorvel wrote."], store.epoch)).toEqual({ wait: "No model is chosen for Hiding details" });
    expect(detector.calls).toEqual([]);
  });

  it("drops a mark the detector cannot have found and keeps the rest, so the marking job never asks for the passage again", async () => {
    const detector = fakeDetector({ Quorvel: "person", Bertrand: "person" });
    const { hider: h, store } = hider({ detector });
    const passage = "Quorvel met Bertrand.";
    detector.spoil([{ start: 0, end: 999, type: "person" }, { start: 5, end: 2, type: "person" }, { start: 0.5, end: 3, type: "person" }, { start: 0, end: 3, type: "face" }, { start: 0, end: 3, type: "nonsense" }, { start: "0", end: 3, type: "person" }, null]);
    expect(await h.mark([passage], store.epoch)).toEqual({ passages: 1, found: 1 });
    expect(store.read([sha256(passage)], MODEL).get(sha256(passage))).toEqual({ marks: [{ start: 0, end: 7, type: "person" }, { start: 12, end: 20, type: "person" }], current: true });
    expect(await h.mark([passage], store.epoch)).toEqual({ passages: 1, found: 0 });
    expect(texts(await h.hide([free(passage)], "all", table()))).toEqual(["[[Person 1]] met [[Person 2]]."]);
    expect(detector.calls).toEqual([[passage]]);
  });

  it("fails only the texts that hold a passage the detector cannot read, hides the rest, and keeps no marks for that passage", async () => {
    const detector = fakeDetector({ Quorvel: "person", Bertrand: "person" });
    detector.unread("Garbled");
    const { hider: h, store } = hider({ detector });
    const answer = await h.hide([free("Bertrand wrote.\n\nGarbled line."), free("Quorvel called."), [{ text: "Ada Example", is: "person", who: "p-ada", shown: "Ada Example" }]], "all", table());
    expect(texts(answer, "a passage the detector cannot read")).toEqual([
      { cannot: "This text cannot be hidden: the hiding model cannot read a passage of it." }, "[[Person 1]] called.", "[[Person 2]]",
    ]);
    expect("table" in answer && answer.table.entries.map((entry) => entry.detail)).toEqual(["Owen Example", "Quorvel", "Ada Example"]);
    const kept = store.read([sha256("Bertrand wrote."), sha256("Garbled line."), sha256("Quorvel called.")], MODEL);
    expect(new Set(kept.keys())).toEqual(new Set([sha256("Bertrand wrote."), sha256("Quorvel called.")]));
    expect(await h.mark(["Garbled line.\n\nAnother line."], store.epoch)).toEqual({ passages: 2, found: 2 });
    expect(detector.calls).toEqual([["Bertrand wrote.", "Garbled line.", "Quorvel called."], ["Garbled line.", "Another line."]]);
    expect(store.read([sha256("Garbled line.")], MODEL).size).toBe(0);
  });

  it("hides as with no model when a find throws, keeping nothing, and finds again at the next call", async () => {
    const detector = fakeDetector({ Quorvel: "person" });
    const { hider: h } = hider({ detector });
    detector.fail();
    expect(await h.hide([free("Quorvel wrote to Ada.")], "all", table())).toMatchObject({ texts: ["Quorvel wrote to [[Person 1]]."], detector: null });
    expect(await h.hide([free("Quorvel wrote to Ada.")], "all", table())).toMatchObject({ texts: ["[[Person 1]] wrote to [[Person 2]]."], detector: MODEL.id });
  });
});

describe("pictures", () => {
  const box = (x: number): Box => ({ x, y: 0, width: 10, height: 10 });
  const findings: Findings = {
    lines: [
      { words: ["Call", "+1", "555", "000", "0001"].map((text, index) => ({ text, box: box(index * 10) })) },
      { words: ["Ada", "says", "hi"].map((text, index) => ({ text, box: box(100 + index * 10) })) },
    ],
    faces: [{ box: box(500) }],
  };
  const asked: Text = { picture: "sha256:aa", faces: [{ box: box(600), placeholder: "[[Person 1]]" }] };

  it("fills each word that holds a hidden detail and, under a level that hides faces, covers every face, the asked ones with their placeholders, and under one that leaves them frames the asked ones", async () => {
    const pictures = scriptedPictures({ "sha256:aa": findings });
    const { hider: h } = hider({ pictures });
    const all = await h.hide([asked], "all", table());
    const [picture] = texts(all, "picture under all") as Picture[];
    expect(picture!.recipe).toEqual({
      blob: "sha256:aa", engine: "fake-engine-1",
      filled: [box(10), box(20), box(30), box(40), box(100)],
      covered: [{ box: box(600), placeholder: "[[Person 1]]", colour: "#808080" }, { box: box(500), colour: "#808080" }],
      written: [],
    });
    expect(pictures.made[0]!.covered.every((face) => face.colour === undefined)).toBe(true);
    expect("table" in all && all.table.entries).toEqual([OWNER_ENTRY]);
    const names = texts(await h.hide([asked], "names", table())) as Picture[];
    expect(names[0]!.recipe).toMatchObject({ filled: [box(10), box(20), box(30), box(40)], covered: [], written: [{ box: box(600), placeholder: "[[Person 1]]" }] });
  });

  it("covers an asked face by its own box, a face found over it being that face, and a face both finders found but nobody asked once, holding both boxes", async () => {
    const both: Findings = { lines: [], faces: [{ box: { x: 598, y: 2, width: 10, height: 10 } }, { box: box(500) }, { box: { x: 503, y: 1, width: 10, height: 10 } }] };
    const pictures = scriptedPictures({ "sha256:ee": both });
    const { hider: h } = hider({ pictures, off: true });
    const [picture] = texts(await h.hide([{ picture: "sha256:ee", faces: [{ box: box(600), placeholder: "[[Person 1]]" }] }], "all", table())) as Picture[];
    expect(picture!.recipe.covered.map(({ colour: _colour, ...face }) => face)).toEqual([
      { box: box(600), placeholder: "[[Person 1]]" },
      { box: { x: 500, y: 0, width: 13, height: 11 } },
    ]);
  });

  it("makes a picture anew under none, reading nothing, and answers cannot for a picture it cannot read, alone", async () => {
    const pictures = scriptedPictures({ "sha256:aa": findings });
    const { hider: h } = hider({ pictures });
    const none = texts(await h.hide([asked], "none", table())) as Picture[];
    expect(none[0]!.recipe).toMatchObject({ filled: [], covered: [], written: [{ placeholder: "[[Person 1]]" }] });
    expect(pictures.reads).toEqual([]);
    expect(texts(await h.hide([[{ text: "a plain line", free: true }], { picture: "sha256:bb" }], "all", table()))).toEqual(["a plain line", { cannot: "This picture cannot be read." }]);
  });

  it("covers a word the call or the table hides as another type: a tax number the text holds as a password", async () => {
    const pan: Findings = { lines: [{ words: [{ text: "ABCPE1234F", box: box(0) }] }], faces: [] };
    const pictures = scriptedPictures({ "sha256:cc": pan });
    const { hider: h } = hider({ pictures, off: true });
    expect((texts(await h.hide([{ picture: "sha256:cc" }], ["secret"], table()))[0] as Picture).recipe.filled).toEqual([]);
    const said = texts(await h.hide([free("password: ABCPE1234F"), { picture: "sha256:cc" }], ["secret"], table()), "picture holding a value its text hides as another type");
    expect(said[0]).toBe("password: [[Secret 1]]");
    expect((said[1] as Picture).recipe.filled).toEqual([box(0)]);
    const held: PlaceholderTable = { scope: "ask:test", entries: [{ placeholder: "[[Secret 4]]", type: "secret", detail: "ABCPE1234F" }], next: { secret: 5 } };
    expect((texts(await h.hide([{ picture: "sha256:cc" }], ["secret"], held))[0] as Picture).recipe.filled).toEqual([box(0)]);
  });

  it("covers a value the scope hid in an earlier call where the picture's words hold it with no mark, and leaves a never-listed one plain", async () => {
    const screen: Findings = {
      lines: [
        { words: ["Lunch", "with", "Quorvel", "Exampleton"].map((text, index) => ({ text, box: box(index * 10) })) },
        { words: ["Lifestream", "notes"].map((text, index) => ({ text, box: box(100 + index * 10) })) },
      ],
      faces: [],
    };
    const { hider: first } = hider({ detector: fakeDetector({ "Quorvel Exampleton": "person" }) });
    const one = await first.hide([free("Met Quorvel Exampleton at noon")], "all", table());
    expect(texts(one)).toEqual(["Met [[Person 1]] at noon"]);
    if (!("table" in one)) throw new Error("expected a table");
    const held: PlaceholderTable = { ...one.table, entries: [...one.table.entries, { placeholder: "[[Word 1]]", type: "word", detail: "Lifestream" }], next: { ...one.table.next, word: 2 } };
    const pictures = scriptedPictures({ "sha256:ff": screen });
    const { hider: second } = hider({ pictures, off: true });
    const [picture] = texts(await second.hide([{ picture: "sha256:ff" }], "all", held), "picture holding a value an earlier call hid") as Picture[];
    expect(picture!.recipe.filled).toEqual([box(20), box(30)]);
  });

  it("covers both parts of an id number the picture reader gave as two lines, and joins no lines of a text", async () => {
    const card: Findings = {
      lines: [
        { words: [{ text: "2345", box: box(0) }, { text: "6789", box: box(10) }] },
        { words: [{ text: "0124", box: box(20) }] },
        { words: [{ text: "Example", box: box(30) }] },
      ],
      faces: [],
    };
    const pictures = scriptedPictures({ "sha256:dd": card });
    const { hider: h } = hider({ pictures, off: true });
    const [picture, text] = texts(await h.hide([{ picture: "sha256:dd" }, free("Seats 2345 6789\n0124 left")], "all", table()), "id number over two picture lines");
    expect((picture as Picture).recipe.filled).toEqual([box(0), box(10), box(20)]);
    expect(text).toBe("Seats 2345 6789\n0124 left");
  });

  it("answers cannot for a picture whose words hold a passage the detector cannot read, and makes the call's other texts", async () => {
    const detector = fakeDetector({});
    detector.unread("Ada says");
    const pictures = scriptedPictures({ "sha256:aa": findings });
    const { hider: h } = hider({ detector, pictures });
    expect(texts(await h.hide([asked, free("Call +15550000142")], "all", table()))).toEqual([
      { cannot: "This picture cannot be hidden: the hiding model cannot read its words." }, "Call [[Phone 1]]",
    ]);
    expect(pictures.made).toEqual([]);
  });
});

describe("a Chat question's photo: its known faces tagged", () => {
  const box = (x: number): Box => ({ x, y: 0, width: 10, height: 10 });
  const photo: Findings = {
    lines: [],
    faces: [{ box: box(100), who: "p-ada" }, { box: box(300) }, { box: box(500), who: "p-owner" }, { box: box(700), who: "p-gone" }],
  };
  const tagged: Text = { picture: "sha256:a1", tags: true };
  const drawn = (picture: HiddenText) => {
    const { recipe } = picture as Picture;
    return { covered: recipe.covered.map(({ colour: _colour, ...face }) => face), written: recipe.written };
  };

  it("covers every face under all, a known one tagged with the conversation's placeholder for its person, a stranger with nothing, and the answer restores the name; no picture carries a name", async () => {
    const pictures = scriptedPictures({ "sha256:a1": photo });
    const { hider: h } = hider({ pictures, off: true });
    const answer = await h.hide([free("Is Ada in this one?"), tagged], "all", table());
    const [question, picture] = texts(answer, "tagged photo under all");
    expect(question).toBe("Is [[Person 1]] in this one?");
    expect(drawn(picture!)).toEqual({
      covered: [{ box: box(100), placeholder: "[[Person 1]]" }, { box: box(500), placeholder: "[[Person 0]]" }, { box: box(300) }, { box: box(700) }],
      written: [],
    });
    expect(JSON.stringify(pictures.made)).not.toMatch(/Ada|Owen/u);
    if (!("table" in answer)) throw new Error("expected a table");
    expect(answer.table.entries).toEqual([OWNER_ENTRY, { placeholder: "[[Person 1]]", type: "person", detail: "Ada", who: "p-ada", shown: "Ada Example" }]);
    expect(restoreDetails("[[Person 1]] stands beside [[Person 0]].", answer.table).text).toBe("Ada Example stands beside Owen Example.");
  });

  it("gives a face alone in its call an entry of its own, numbered past a bare spelling the call's text leaves standing, and the same placeholder in the conversation's next call", async () => {
    const pictures = scriptedPictures({ "sha256:a1": photo });
    const { hider: h } = hider({ pictures, off: true });
    const first = await h.hide([free("Who is Person 1 here?"), tagged], "all", table());
    expect(texts(first)[0]).toBe("Who is Person 1 here?");
    expect(drawn(texts(first)[1]!).covered[0]).toEqual({ box: box(100), placeholder: "[[Person 2]]" });
    if (!("table" in first)) throw new Error("expected a table");
    expect(first.table.entries.at(-1)).toEqual({ placeholder: "[[Person 2]]", type: "person", detail: "Ada Example", who: "p-ada", shown: "Ada Example" });
    expect(restoreDetails("[[Person 2]] waves.", first.table).text).toBe("Ada Example waves.");
    expect(texts(await h.hide([free("Ada Example again?")], "all", first.table))).toEqual(["[[Person 2]] again?"]);
  });

  it("tags the known faces under a level that leaves faces, framed, and under none, reading the picture for its faces alone; writes nothing on a picture that states no tags", async () => {
    const pictures = scriptedPictures({ "sha256:a1": photo });
    const { hider: h } = hider({ pictures, off: true });
    const names = await h.hide([free("Is Ada in this one?"), tagged], "names", table());
    expect(texts(names)[0]).toBe("Is Ada in this one?");
    expect(drawn(texts(names)[1]!)).toEqual({ covered: [], written: [{ box: box(100), placeholder: "[[Person 1]]" }, { box: box(500), placeholder: "[[Person 0]]" }] });
    if (!("table" in names)) throw new Error("expected a table");
    expect(restoreDetails("[[Person 1]]", names.table).text).toBe("Ada Example");
    const none = await h.hide([tagged], "none", table());
    expect(drawn(texts(none)[0]!)).toEqual({ covered: [], written: [{ box: box(100), placeholder: "[[Person 1]]" }, { box: box(500), placeholder: "[[Person 0]]" }] });
    const look = await h.hide([{ picture: "sha256:a1" }], "all", table());
    expect(drawn(texts(look)[0]!)).toEqual({ covered: [{ box: box(100) }, { box: box(300) }, { box: box(500) }, { box: box(700) }], written: [] });
    expect("table" in look && look.table.entries).toEqual([OWNER_ENTRY]);
  });

  it("tags a face two finders hold once, by the finder that names it: Vision's box and the scan's unnamed one under the match's", async () => {
    const two: Findings = { lines: [], faces: [{ box: { x: 101, y: 1, width: 10, height: 10 } }, { box: box(100) }, { box: { x: 99, y: 0, width: 11, height: 11 }, who: "p-ada" }] };
    const pictures = scriptedPictures({ "sha256:b2": two });
    const { hider: h } = hider({ pictures, off: true });
    const [picture] = texts(await h.hide([{ picture: "sha256:b2", tags: true }], "all", table()));
    expect(drawn(picture!)).toEqual({ covered: [{ box: { x: 99, y: 0, width: 11, height: 11 }, placeholder: "[[Person 1]]" }], written: [] });
  });
});

describe("the process's thread", () => {
  it("is handed back while a text is hidden: the loop serves another event between its pieces' marks, and between its marks and its hiding", async () => {
    const { hider: h } = hider({ off: true });
    const line = "Ada Example wrote to person-a@example.com about order #A100042, call +15550000142, see https://example.com/x/abcDEF123456\n";
    let answered = false;
    let served = 0;
    let servedAtTable: number | undefined;
    const hiding = h.hide([free(line.repeat(200)), free(line.repeat(20))], "all", () => {
      servedAtTable = served;
      return table();
    }).then((answer) => {
      answered = true;
      return answer;
    });
    await new Promise<void>((resolve) => {
      const event = () => {
        if (answered) return resolve();
        served += 1;
        setImmediate(event);
      };
      setImmediate(event);
    });
    expect(servedAtTable).toBeGreaterThanOrEqual(1);
    expect(served).toBeGreaterThan(servedAtTable!);
    expect(texts(await hiding)[1]).toContain("[[Person 1]] wrote to [[Email 1]] about order #[[Number 1]], call [[Phone 1]]");
  });
});

function marksIn(dir: string, store: number): ReturnType<typeof openMarks> {
  const folder = join(dir, `marks-${store}`);
  return openMarks(openHomeFolder(folder), join(folder, "marks.db"));
}
