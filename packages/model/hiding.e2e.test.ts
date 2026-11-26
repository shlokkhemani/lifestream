import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { dayBounds, hideDetails, openHomeFolder, restoreDetails, Schema, wantedOf, type Entry, type Marked, type PlaceholderTable } from "@lifestreamprotocol/core";
import { ledgerSchema, openLedger, type Ledger, type NewRequest } from "./ledger.js";
import { LIST_ROWS, type NewOutbound } from "./outbound.js";

const DAY = { zone: "Asia/Kolkata", day_start_hour: 4 };
const OWNER = { who: "p-owner", shown: "Owner Example" };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function ledgerAt(): Ledger {
  const root = mkdtempSync(join(tmpdir(), "model-hiding-"));
  roots.push(root);
  return openLedger(openHomeFolder(root), { mode: "migrate" });
}

function read(at_ms: number, more: Partial<NewOutbound> = {}): NewOutbound {
  return {
    at_ms, receiver: "Vault App", route: null, by: "pass-agent-1", what: "read", tool: "day", level: "names", counts: { email: 2, phone: 1 },
    chars: 900, pictures: 0, key: null, attempt: null, refs: [{ day: "2026-11-10" }], ...more,
  };
}

function person(text: string, who?: string): Marked {
  return { text, marks: [{ start: 0, end: text.length, type: "person", ...(who === undefined ? {} : { who }) }] };
}

describe("placeholder tables", () => {
  it("a grant's table of 100,000 entries is read in part, by its call's marks, placeholders and words, and hiding on the part answers as on the whole", () => {
    const ledger = ledgerAt();
    try {
      const entries: Entry[] = [];
      for (let n = 1; n <= 100_000; n++) entries.push({ placeholder: `[[Person ${n}]]`, type: "person", detail: `Person${n} Example`, who: `p-${n}` });
      const whole: PlaceholderTable = { scope: "grant:agent-1", entries, next: { person: 100_001 } };
      const empty = ledger.placeholders.part("grant:agent-1", wantedOf([]));
      expect(empty).toEqual({ table: { scope: "grant:agent-1", entries: [], next: {} }, epoch: 0, version: 0 });
      expect(ledger.placeholders.save(empty, whole)).toEqual({ saved: true, seq: null });

      const texts: Marked[] = [
        person("Ada", "p-77"),
        person("Person12 Example"),
        { text: "write to person-a@example.com", marks: [{ start: 9, end: 29, type: "email" }] },
        { text: "as [[Person 5]] said", marks: [] },
        { text: "lunch with Person31 Example", marks: [] },
      ];
      const part = ledger.placeholders.part("grant:agent-1", wantedOf(texts));
      expect(part.table.entries.map((entry) => entry.placeholder).sort()).toEqual(["[[Person 12]]", "[[Person 31]]", "[[Person 5]]", "[[Person 77]]"]);
      expect(part.table.next).toEqual({ person: 100_001 });
      const onPart = hideDetails(texts, "all", part.table, OWNER);
      const onWhole = hideDetails(texts, "all", whole, OWNER);
      expect(onPart.texts).toEqual(onWhole.texts);
      expect(onPart.counts).toEqual(onWhole.counts);
      expect(onPart.table.next).toEqual(onWhole.table.next);
      const fresh = (table: PlaceholderTable, given: PlaceholderTable) => {
        const held = new Set(given.entries.map((entry) => entry.placeholder));
        return table.entries.filter((entry) => !held.has(entry.placeholder));
      };
      expect(fresh(onPart.table, part.table)).toEqual(fresh(onWhole.table, whole));

      expect(ledger.placeholders.save(part, onPart.table)).toMatchObject({ saved: true });
      const again = ledger.placeholders.part("grant:agent-1", wantedOf([texts[2]!]));
      expect(again.table.entries.map((entry) => [entry.placeholder, entry.detail])).toEqual([
        ["[[Person 0]]", "Owner Example"], ["[[Email 1]]", "person-a@example.com"], ["[[Word 1]]", "[[Person 5]]"],
      ]);
      expect(again.version).toBe(2);
    } finally {
      ledger.close();
    }
  });

  it("a call that wants more keys, words and people than one lookup binds finds every entry they name, each once, in the order written, and no other", () => {
    const ledger = ledgerAt();
    try {
      const entries: Entry[] = [];
      for (let n = 1; n <= 1000; n++) {
        entries.push({ placeholder: `[[Email ${n}]]`, type: "email", detail: `person-${n}@example.com` });
        entries.push({ placeholder: `[[Person ${n}]]`, type: "person", detail: `Zorvathy${n} Ex`, who: `p-${n}` });
        entries.push({ placeholder: `[[Number ${n}]]`, type: "number", detail: `QX-${n}-unseen` });
      }
      const seeded = ledger.placeholders.part("grant:agent-1", wantedOf([]));
      expect(ledger.placeholders.save(seeded, { scope: "grant:agent-1", entries, next: { email: 1001, person: 1001, number: 1001 } })).toMatchObject({ saved: true });
      const texts: Marked[] = [];
      for (let n = 1; n <= 1000; n++) {
        const email = `person-${n}@example.com`;
        texts.push({ text: `write to ${email}`, marks: [{ start: 9, end: 9 + email.length, type: "email" }] });
        texts.push(n % 2 === 0 ? person("Ada", `p-${n}`) : { text: `lunch with Zorvathy${n}`, marks: [] });
      }
      const wanted = wantedOf(texts);
      expect(wanted.keys.size).toBeGreaterThan(1000);
      expect(wanted.who.size).toBe(500);
      const part = ledger.placeholders.part("grant:agent-1", wanted);
      expect(part.table.entries).toEqual(entries.filter((entry) => entry.type !== "number"));
    } finally {
      ledger.close();
    }
  });

  it("an entry is keyed by its value's fold, not its type: a value held as an account is read for an address mark, a number for a phone mark of its digits, a person apart", () => {
    const ledger = ledgerAt();
    try {
      const entries: Entry[] = [
        { placeholder: "[[Account 1]]", type: "account", detail: "Hope Street Example" },
        { placeholder: "[[Number 1]]", type: "number.bank", detail: "15550000142" },
        { placeholder: "[[Person 1]]", type: "person", detail: "Zorvathy Lane" },
      ];
      const seeded = ledger.placeholders.part("chat:keys", wantedOf([]));
      expect(ledger.placeholders.save(seeded, { scope: "chat:keys", entries, next: { account: 2, number: 2, person: 2 } })).toMatchObject({ saved: true });
      const texts: Marked[] = [
        { text: "hope street example", marks: [{ start: 0, end: 19, type: "address" }] },
        { text: "+1 555 000 0142", marks: [{ start: 0, end: 15, type: "phone" }] },
        { text: "zorvathy lane", marks: [{ start: 0, end: 13, type: "account" }] },
      ];
      const wanted = { ...wantedOf(texts), words: new Set<string>() };
      const part = ledger.placeholders.part("chat:keys", wanted);
      expect(part.table.entries.map((entry) => entry.placeholder)).toEqual(["[[Account 1]]", "[[Number 1]]"]);
      expect(hideDetails(texts, "all", part.table, null).texts).toEqual(["[[Account 1]]", "[[Number 1]]", "[[Account 2]]"]);
    } finally {
      ledger.close();
    }
  });

  it("a name a scope hid in one call is hidden in the next with no mark for it: the part is sought by its value word too, and answers as the whole", () => {
    const ledger = ledgerAt();
    try {
      const others: Entry[] = [];
      for (let n = 1; n <= 10_000; n++) others.push({ placeholder: `[[Person ${n}]]`, type: "person", detail: `Person${n} Example`, who: `p-${n}` });
      const seeded = ledger.placeholders.part("grant:agent-1", wantedOf([]));
      expect(ledger.placeholders.save(seeded, { scope: "grant:agent-1", entries: others, next: { person: 10_001 } })).toMatchObject({ saved: true });

      const first: Marked[] = [{ text: "lunch with Zorvath Quillby", marks: [{ start: 11, end: 26, type: "person" }] }];
      const one = ledger.placeholders.part("grant:agent-1", wantedOf(first));
      const hid = hideDetails(first, "all", one.table, OWNER);
      expect(hid.texts[0]).toBe("lunch with [[Person 10001]]");
      expect(ledger.placeholders.save(one, hid.table)).toMatchObject({ saved: true });

      const second: Marked[] = [{ text: "Zorvath Quillby called back about the lease", marks: [] }];
      const wanted = wantedOf(second);
      expect(wanted.who.size + wanted.keys.size).toBe(0);
      const two = ledger.placeholders.part("grant:agent-1", wanted);
      expect(two.table.entries.map((entry) => entry.placeholder)).toEqual(["[[Person 0]]", "[[Person 10001]]"]);
      const whole: PlaceholderTable = { scope: "grant:agent-1", entries: [...others, ...hid.table.entries], next: hid.table.next };
      const onPart = hideDetails(second, "all", two.table, OWNER);
      const onWhole = hideDetails(second, "all", whole, OWNER);
      expect(onPart.texts).toEqual(onWhole.texts);
      expect(onPart.texts[0]).toBe("[[Person 10001]] called back about the lease");
      expect(onPart.counts).toEqual(onWhole.counts);
    } finally {
      ledger.close();
    }
  });

  it("of two saves over parts read at one version, the second writes nothing and answers stale; a call that adds nothing moves no version", () => {
    const ledger = ledgerAt();
    try {
      const ada = [person("Ada Example", "p-1")];
      const rose = [person("Rose Example", "p-2")];
      const first = ledger.placeholders.part("chat:c1", wantedOf(ada));
      const second = ledger.placeholders.part("chat:c1", wantedOf(rose));
      expect(ledger.placeholders.save(first, hideDetails(ada, "all", first.table, null).table)).toMatchObject({ saved: true });
      expect(ledger.placeholders.save(second, hideDetails(rose, "all", second.table, null).table, read(1))).toEqual({ stale: true });
      expect(ledger.outbound.list({ from: "2026-01-01", to: "2026-12-31", day: DAY }).rows).toEqual([]);
      const retried = ledger.placeholders.part("chat:c1", wantedOf(rose));
      const hidden = hideDetails(rose, "all", retried.table, null);
      expect(hidden.texts).toEqual(["[[Person 2]]"]);
      expect(ledger.placeholders.save(retried, hidden.table)).toMatchObject({ saved: true });

      const one = ledger.placeholders.part("chat:c1", wantedOf(ada));
      const two = ledger.placeholders.part("chat:c1", wantedOf(ada));
      expect(ledger.placeholders.save(one, hideDetails(ada, "all", one.table, null).table)).toMatchObject({ saved: true });
      expect(ledger.placeholders.save(two, hideDetails(ada, "all", two.table, null).table)).toMatchObject({ saved: true });
      const restoring = ledger.placeholders.part("chat:c1", wantedOf([{ text: "[[Person 9]] came", marks: [] }]));
      const restored = restoreDetails("[[Person 9]] came", restoring.table);
      expect(restored.unknown).toEqual(["[[Person 9]]"]);
      ledger.placeholders.save(restoring, restored.table);
      const next = ledger.placeholders.part("chat:c1", wantedOf([person("Ravi Example", "p-3")]));
      expect(hideDetails([person("Ravi Example", "p-3")], "all", next.table, null).texts).toEqual(["[[Person 10]]"]);
    } finally {
      ledger.close();
    }
  });

  it("a save writes its call's outbound row in its own transaction, and a grant's table dropped with its grant is gone", () => {
    const ledger = ledgerAt();
    try {
      const texts = [person("Ada Example", "p-1")];
      const part = ledger.placeholders.part("grant:agent-1", wantedOf(texts));
      const saved = ledger.placeholders.save(part, hideDetails(texts, "names", part.table, null).table, read(Date.UTC(2026, 10, 10, 6)));
      expect(saved).toEqual({ saved: true, seq: 1 });
      expect(ledger.outbound.row(1, DAY)).toMatchObject({ seq: 1, what: "read", receiver: "Vault App", refs: [{ day: "2026-11-10" }] });
      ledger.placeholders.drop("grant:agent-1");
      expect(ledger.placeholders.part("grant:agent-1", wantedOf(texts))).toEqual({ table: { scope: "grant:agent-1", entries: [], next: {} }, epoch: 0, version: -1 });
    } finally {
      ledger.close();
    }
  });

  it("a grant revoked while its agent's call is in flight never brings its table back: a save over a part read before the drop, or after it, writes nothing and answers dropped", () => {
    const ledger = ledgerAt();
    try {
      const ada = [person("Ada Example", "p-1")];
      const rose = [person("Rose Example", "p-2")];
      const first = ledger.placeholders.part("grant:agent-1", wantedOf(ada));
      expect(ledger.placeholders.save(first, hideDetails(ada, "all", first.table, null).table)).toMatchObject({ saved: true });
      const inFlight = ledger.placeholders.part("grant:agent-1", wantedOf(rose));
      const fresh = ledger.placeholders.part("grant:agent-2", wantedOf(rose));
      ledger.placeholders.drop("grant:agent-1");
      ledger.placeholders.drop("grant:agent-2");
      expect(ledger.placeholders.save(inFlight, hideDetails(rose, "all", inFlight.table, null).table, read(Date.UTC(2026, 10, 10, 6)))).toEqual({ dropped: true });
      expect(ledger.placeholders.save(fresh, hideDetails(rose, "all", fresh.table, null).table)).toEqual({ dropped: true });
      const after = ledger.placeholders.part("grant:agent-1", wantedOf(rose));
      expect(ledger.placeholders.save(after, hideDetails(rose, "all", after.table, null).table)).toEqual({ dropped: true });
      const db = new Database(ledger.path, { readonly: true });
      try {
        expect(db.prepare("SELECT count(*) FROM placeholder_entries WHERE scope IN ('grant:agent-1', 'grant:agent-2')").pluck().get()).toBe(0);
        expect(db.prepare("SELECT count(*) FROM outbound").pluck().get()).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      ledger.close();
    }
  });

  it("an erasure's mark refuses every save while it stands, and its second move one over a part read under its first", () => {
    const ledger = ledgerAt();
    try {
      const ada = [person("Ada Example", "p-1")];
      expect(ledger.placeholders.epoch()).toEqual({ epoch: 0, erasing: false });
      ledger.placeholders.beginErasure();
      expect(ledger.placeholders.epoch()).toEqual({ epoch: 1, erasing: true });
      const between = ledger.placeholders.part("chat:c1", wantedOf(ada));
      expect(between.epoch).toBe(1);
      expect(ledger.placeholders.save(between, hideDetails(ada, "all", between.table, null).table)).toEqual({ erased: true });
      ledger.forget([]);
      const other = openLedger(openHomeFolder(dirname(dirname(ledger.path))), { mode: "write" });
      try {
        expect(other.placeholders.epoch()).toEqual({ epoch: 1, erasing: true });
      } finally {
        other.close();
      }
      ledger.placeholders.endErasure();
      expect(ledger.placeholders.epoch()).toEqual({ epoch: 2, erasing: false });
      expect(ledger.placeholders.save(between, hideDetails(ada, "all", between.table, null).table)).toEqual({ erased: true });
      const after = ledger.placeholders.part("chat:c1", wantedOf(ada));
      expect(ledger.placeholders.save(after, hideDetails(ada, "all", after.table, null).table)).toMatchObject({ saved: true });
    } finally {
      ledger.close();
    }
  });
});

describe("the outbound log", () => {
  it("lists a range of days newest first, pages past its bound, and totals by receiver and day with an ask's attempts one item", () => {
    const ledger = ledgerAt();
    try {
      const nov10 = dayBounds("2026-11-10", DAY).start_ms;
      const nov11 = dayBounds("2026-11-11", DAY).start_ms;
      const ask = (at_ms: number, key: string, attempt: number): NewOutbound => ({
        at_ms, receiver: "OpenAI", route: "codex", by: null, what: "ask", tool: null, level: "all", counts: { person: 2, "number.bank": 1 }, chars: 400, pictures: 1, key, attempt,
      });
      ledger.outbound.write(ask(nov10 + 1_000, "sha256:aa", 1));
      ledger.outbound.write(ask(nov10 + 2_000, "sha256:aa", 2));
      ledger.outbound.write(ask(nov10 + 3_000, "sha256:bb", 3));
      ledger.outbound.write(read(nov11 + 1_000, { refs: [{ source: "gmail:person-a@example.com", kind: "message", key: "m-1" }, { day: "2026-11-11" }] }));
      ledger.outbound.write({ ...read(nov11 + 2_000), receiver: "Google", by: "places-search", what: "lookup", tool: "autocomplete", level: "none", counts: { place: 1 }, chars: 4, refs: [] });
      ledger.outbound.write(ask(nov10 - 1, "sha256:cc", 4));

      const listed = ledger.outbound.list({ from: "2026-11-10", to: "2026-11-11", day: DAY });
      expect(listed.rows.map((row) => [row.seq, row.day, row.what, row.refs])).toEqual([[5, "2026-11-11", "lookup", 0], [4, "2026-11-11", "read", 2], [3, "2026-11-10", "ask", 0], [2, "2026-11-10", "ask", 0], [1, "2026-11-10", "ask", 0]]);
      expect(listed.more).toBe(false);
      expect(listed.totals).toEqual([
        { receiver: "Google", day: "2026-11-11", items: 1, hidden: 0, counts: {}, rows: { lookup: 1 } },
        { receiver: "Vault App", day: "2026-11-11", items: 1, hidden: 3, counts: { email: 2, phone: 1 }, rows: { read: 1 } },
        { receiver: "OpenAI", day: "2026-11-10", items: 2, hidden: 9, counts: { person: 6, "number.bank": 3 }, rows: { ask: 3 } },
      ]);
      expect(ledger.outbound.list({ from: "2026-11-10", to: "2026-11-11", receiver: "OpenAI", day: DAY }).rows.map((row) => row.seq)).toEqual([3, 2, 1]);
      expect(ledger.outbound.row(4, DAY)!.refs).toEqual([{ source: "gmail:person-a@example.com", kind: "message", key: "m-1" }, { day: "2026-11-11" }]);
      expect(ledger.outbound.row(4, DAY)!.level).toBe("names");
      expect(ledger.outbound.row(99, DAY)).toBeUndefined();
      expect(ledger.outbound.row(1, DAY)!.sent).toBeNull();

      for (let n = 0; n < LIST_ROWS; n++) ledger.outbound.write(read(nov11 + 10_000 + n, { refs: [] }));
      const first = ledger.outbound.list({ from: "2026-11-11", to: "2026-11-11", day: DAY });
      expect(first.rows).toHaveLength(LIST_ROWS);
      expect(first.more).toBe(true);
      const rest = ledger.outbound.list({ from: "2026-11-11", to: "2026-11-11", before: first.rows.at(-1)!.seq, day: DAY });
      expect(rest.rows.map((row) => row.seq)).toEqual([5, 4]);
      expect(rest.more).toBe(false);
    } finally {
      ledger.close();
    }
  });

  it("tells a Chat voice note's rows apart, each handover a row and its request one item; another family's ask, a read and an erased request's row never", () => {
    const ledger = ledgerAt();
    try {
      const nov16 = dayBounds("2026-11-16", DAY).start_ms;
      const asked = (key: string, family: string, prompt: string) => ledger.request({
        key, family, unit: `voice:${key.slice(7)}`, revision: key, model: "elevenlabs/scribe-v2", effort: "none",
        prompt: { name: prompt, version: 1, text: "Write out this voice note.", type: "text" }, input_hash: `sha256:input-${key.slice(7)}`, body: "Write out this voice note.\n", attachments: [],
      }, nov16);
      asked("sha256:note-1", "ai", "ask-voice");
      asked("sha256:memo-1", "voice", "voice-transcript");
      asked("sha256:other-1", "ai", "ask-image");
      const handover = (at_ms: number, key: string, attempt: number): NewOutbound => ({
        at_ms, receiver: "OpenRouter", route: "openrouter:elevenlabs/scribe-v2", by: null, what: "ask", tool: null, level: "none", counts: {}, chars: 0, pictures: 0, key, attempt,
      });
      ledger.outbound.write(handover(nov16 + 1_000, "sha256:note-1", 1));
      ledger.outbound.write(handover(nov16 + 2_000, "sha256:note-1", 2));
      ledger.outbound.write(handover(nov16 + 3_000, "sha256:memo-1", 3));
      ledger.outbound.write(handover(nov16 + 4_000, "sha256:other-1", 4));
      ledger.outbound.write(read(nov16 + 5_000));
      const listed = ledger.outbound.list({ from: "2026-11-16", to: "2026-11-16", day: DAY });
      expect(listed.rows.map((row) => [row.seq, row.about ?? null])).toEqual([[5, null], [4, null], [3, null], [2, "chat-voice"], [1, "chat-voice"]]);
      expect(listed.rows.filter((row) => row.about === undefined).every((row) => !("about" in row))).toBe(true);
      expect(listed.totals.find((total) => total.receiver === "OpenRouter")).toMatchObject({ items: 3, rows: { ask: 4 } });
      expect(ledger.outbound.row(1, DAY)).toMatchObject({ about: "chat-voice", sent: { body: "Write out this voice note.\n", pictures: [] } });
      expect("about" in ledger.outbound.row(3, DAY)!).toBe(false);
      expect(ledger.outbound.asked({ family: "ai", item: "voice:note-1" }, DAY).map((row) => [row.seq, row.about])).toEqual([[2, "chat-voice"], [1, "chat-voice"]]);
      ledger.forget(["voice:note-1"]);
      expect(ledger.outbound.list({ from: "2026-11-16", to: "2026-11-16", day: DAY }).rows.map((row) => [row.seq, row.key, row.about ?? null]).slice(-2)).toEqual([[2, null, null], [1, null, null]]);
    } finally {
      ledger.close();
    }
  });

  it("an agent's own list of types is kept as its level, and a what no row has is refused before anything is written", () => {
    const ledger = ledgerAt();
    try {
      const seq = ledger.outbound.write(read(1, { level: ["number.bank", "secret"] }));
      expect(ledger.outbound.row(seq, DAY)!.level).toEqual(["number.bank", "secret"]);
      expect(() => ledger.outbound.write(read(2, { what: "sent" as never }))).toThrow(/no outbound row's what/u);
      expect(ledger.outbound.list({ from: "1970-01-01", to: "1970-01-02", day: { zone: "UTC", day_start_hour: 0 } }).rows).toHaveLength(1);
    } finally {
      ledger.close();
    }
  });
});

describe("erasure", () => {
  it("empties every reader's table and keeps its counters, takes an erased item's ask table and request key and its records' refs, and keeps every outbound row", () => {
    const ledger = ledgerAt();
    try {
      const request: NewRequest = {
        key: "sha256:req-1", family: "messages", unit: "item-1", revision: "sha256:req-1", model: "fake-model", effort: "low",
        prompt: { name: "photo-caption", version: 1, text: "Describe.", type: "text" }, input_hash: "sha256:input-1", body: "Describe.\n", attachments: [],
      };
      ledger.request(request, 1_000);
      ledger.outbound.write({ ...read(2_000), what: "ask", receiver: "OpenAI", route: "codex", by: null, tool: null, level: "none", key: "sha256:req-1", attempt: 1, refs: [] });
      expect(ledger.outbound.row(1, DAY)!.sent).toEqual({ body: "Describe.\n", pictures: [] });
      ledger.outbound.write(read(3_000, { refs: [{ source: "whatsapp:+15550000001", kind: "message", key: "m-9" }, { source: "whatsapp:+15550000001", kind: "message", key: "m-10" }, { day: "2026-11-10" }] }));
      const save = (scope: string, texts: Marked[]) => {
        const part = ledger.placeholders.part(scope, wantedOf(texts));
        ledger.placeholders.save(part, hideDetails(texts, "all", part.table, null).table);
      };
      save("ask:sha256:req-1", [person("Ada Example", "p-1")]);
      save("chat:c1", [person("Ada Example", "p-1"), person("Rose Example", "p-2")]);
      save("grant:agent-1", [person("Rose Example", "p-2")]);
      save("ask:sha256:other", [person("Ada Example", "p-1")]);

      const sent = ledger.outbound.sentOf({ records: [{ source: "whatsapp:+15550000001", kind: "message", key: "m-9" }], items: ["item-1"], days: [] }, { zone: "UTC", day_start_hour: 0 });
      expect(sent).toEqual([{ receiver: "OpenAI", days: ["1970-01-01"], what: ["ask"] }, { receiver: "Vault App", days: ["1970-01-01"], what: ["read"] }]);
      expect(ledger.outbound.sentOf({ records: [], items: [], days: ["2026-11-10"] }, DAY).map((to) => to.receiver)).toEqual(["Vault App"]);

      ledger.placeholders.beginErasure();
      ledger.forget(["item-1"], [{ source: "whatsapp:+15550000001", kind: "message", key: "m-9" }]);

      const ada = [person("Ada Example", "p-1")];
      expect(ledger.placeholders.part("ask:sha256:req-1", wantedOf(ada))).toMatchObject({ table: { entries: [], next: {} }, version: 0 });
      expect(ledger.placeholders.part("ask:sha256:other", wantedOf(ada)).table.entries).toHaveLength(1);
      const chat = ledger.placeholders.part("chat:c1", wantedOf(ada));
      expect(chat).toMatchObject({ table: { entries: [], next: { person: 3 } }, epoch: 1 });
      expect(hideDetails(ada, "all", chat.table, null).texts).toEqual(["[[Person 3]]"]);
      expect(ledger.placeholders.part("grant:agent-1", wantedOf(ada))).toMatchObject({ table: { entries: [], next: { person: 2 } }, epoch: 1 });

      expect(ledger.outbound.row(1, DAY)).toMatchObject({ what: "ask", receiver: "OpenAI", key: null, attempt: 1, counts: { email: 2, phone: 1 }, sent: null });
      expect(ledger.outbound.row(2, DAY)!.refs).toEqual([{ source: "whatsapp:+15550000001", kind: "message", key: "m-10" }, { day: "2026-11-10" }]);
      expect(ledger.outbound.sentOf({ records: [{ source: "whatsapp:+15550000001", kind: "message", key: "m-9" }], items: ["item-1"], days: [] }, DAY)).toEqual([]);
    } finally {
      ledger.close();
    }
  });

  it("a save over a part read before an erasure writes nothing and answers erased, in a scope with no row yet and in one with rows", () => {
    const ledger = ledgerAt();
    try {
      const ada = [person("Ada Example", "p-1")];
      const rose = [person("Rose Example", "p-2")];
      const kept = ledger.placeholders.part("grant:agent-1", wantedOf(rose));
      expect(ledger.placeholders.save(kept, hideDetails(rose, "all", kept.table, null).table)).toMatchObject({ saved: true });

      const scopes = ["chat:c-new", "ask:sha256:in-flight", "grant:agent-1"];
      const before = scopes.map((scope) => ledger.placeholders.part(scope, wantedOf([...ada, ...rose])));
      expect(before.map((part) => [part.epoch, part.version])).toEqual([[0, 0], [0, 0], [0, 1]]);
      ledger.placeholders.beginErasure();
      ledger.forget([]);
      ledger.placeholders.endErasure();

      for (const part of before) {
        const hidden = hideDetails([...ada, ...rose], "all", part.table, null);
        expect(ledger.placeholders.save(part, hidden.table, read(1))).toEqual({ erased: true });
      }
      for (const scope of scopes) {
        const after = ledger.placeholders.part(scope, wantedOf([...ada, ...rose]));
        expect(after.table.entries).toEqual([]);
        expect(after.epoch).toBe(2);
      }
      expect(ledger.placeholders.part("chat:c-new", wantedOf(ada))).toMatchObject({ table: { next: {} }, version: 0 });
      expect(ledger.placeholders.part("grant:agent-1", wantedOf(ada))).toMatchObject({ table: { next: { person: 2 } }, version: 1 });
      expect(ledger.outbound.list({ from: "1970-01-01", to: "1970-01-02", day: { zone: "UTC", day_start_hour: 0 } }).rows).toEqual([]);

      const fresh = ledger.placeholders.part("chat:c-new", wantedOf(ada));
      expect(ledger.placeholders.save(fresh, hideDetails(ada, "all", fresh.table, null).table)).toMatchObject({ saved: true });
      ledger.placeholders.beginErasure();
      ledger.placeholders.endErasure();
      expect(ledger.placeholders.part("chat:c-new", wantedOf(ada)).epoch).toBe(4);
    } finally {
      ledger.close();
    }
  });
});

describe("the ledger's migration 6", () => {
  it("adds hiding's tables to a ledger at version 5, and a read-only open of it before the migration refuses it", () => {
    const root = mkdtempSync(join(tmpdir(), "model-hiding-"));
    roots.push(root);
    const path = join(root, "replies", "replies.db");
    mkdirSync(dirname(path), { recursive: true });
    const at5 = new Schema({ name: ledgerSchema.name, file: ledgerSchema.file, base: ledgerSchema.base, baseline: ledgerSchema.baseline, migrations: ledgerSchema.migrations.slice(0, 5 - ledgerSchema.base), small: [...ledgerSchema.small], foreignKeys: true });
    const db = new Database(path);
    at5.open(db, "migrate");
    db.close();
    expect(() => openLedger(openHomeFolder(dirname(dirname(path))), { mode: "read" })).toThrow(`the ledger is at version 5; this release reads ${ledgerSchema.latest}: the home has not started this release yet`);
    const ledger = openLedger(openHomeFolder(dirname(dirname(path))), { mode: "migrate" });
    try {
      expect(ledger.outbound.write(read(1))).toBe(1);
    } finally {
      ledger.close();
    }
  });
});
