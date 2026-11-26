import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { canonical, openHome, openHomeFolder, type Json } from "@lifestreamprotocol/core";
import { serveDoor, type Door } from "./door.js";
import { extractCursor, fingerprintKey } from "./derive.js";
import { startHome, type Home } from "./home.js";
import { readSealed } from "./inbox.js";
import { mintPrincipal } from "./principals.js";
import { askHome } from "./socket.js";
import { editSettings, testSocket } from "./test/folder.js";
import { FAKE_ROUTE, makeRoot, readHome, removeRoot, REPO, until, TICK_MS } from "./test/harness-root.js";
import { ship, shipFiles } from "./test/harness-deliveries.js";


const UNIT = "macbook-pro-0001";
const ZONE = "Asia/Kolkata";
const PEOPLE = `people:local:${UNIT}`;
const BOOK = `apple-contacts:local:${UNIT}`;
const OWN_WHATSAPP = "whatsapp:15550000001:iphone-aa01";
const OWN_IMESSAGE = `imessage:+15550000002:${UNIT}`;
const OWN_MAIL = "gmail:sam@example.com:cloud";
const REGISTRY = join(REPO, "packages", "home", "test", "people-registry.ts");
const READER = "synthetic-you-reader".padEnd(43, "r");
const DASHBOARD = "synthetic-you-dashboard".padEnd(43, "d");
const DASHBOARD_UNIT = `dashboard-${UNIT}`;
const APPLE_EPOCH_S = 978_307_200;
const GROUP = "120363000000000071@g.us";
const T = Date.parse("2026-10-01T05:00:00Z");
const DAY = "2026-10-01";
const MINUTE = 60_000;
const OUT = join(REPO, "packages", "home", ".build", "e2e");

type Body = Record<string, any>;


function groupLine(stanza: string, member: string, when: number) {
  const date = when / 1000 - APPLE_EPOCH_S;
  const message = {
    ZSTANZAID: stanza, ZTEXT: `synthetic line ${stanza}`, ZFROMJID: GROUP, ZTOJID: null, ZPUSHNAME: null, ZMESSAGEDATE: date, ZSENTDATE: date,
    ZMESSAGETYPE: 0, ZGROUPEVENTTYPE: null, ZFLAGS: 0, ZMESSAGESTATUS: 1, ZMESSAGEERRORSTATUS: 0, ZISFROMME: 0, ZSTARRED: 0,
  };
  return {
    kind: "msg", key: `${GROUP}:${stanza}`, at: when,
    content: { type: "whatsapp.msg", message, session_jid: GROUP, parent_stanza_id: null, media_item: null, group_member_jid: `${member}@s.whatsapp.net`, blobs: [] },
  };
}
const groupShell = { kind: "chat", key: GROUP, content: { type: "whatsapp.chat", group_info: null,
  chat: { ZCONTACTJID: GROUP, ZCONTACTIDENTIFIER: null, ZPARTNERNAME: "Synthetic Group", ZSESSIONTYPE: 1 } } };
const imessage = (guid: string, phone: string, when: number) => ({
  kind: "msg", key: guid, at: when,
  content: { type: "imessage.msg", sender: { kind: "phone", canonical: phone }, recipients: [], flags: { is_from_me: 0 }, text: `synthetic imessage ${guid}` },
});
const card = (...lines: string[]) => {
  const text = `BEGIN:VCARD\r\nVERSION:3.0\r\n${lines.map((line) => `${line}\r\n`).join("")}END:VCARD\r\n`;
  return { kind: "contact", key: createHash("sha256").update(text).digest("hex"), content: { type: "contacts.card", card: text } };
};
function mailRow(key: string, when: number, from: string, to: string) {
  const bytes = Buffer.from([`From: ${from}`, `To: ${to}`, `Subject: synthetic ${key}`, `Date: ${new Date(when).toUTCString()}`, `Message-ID: <${key}@example.com>`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", "A synthetic body.", ""].join("\r\n"));
  const hex = createHash("sha256").update(bytes).digest("hex");
  return {
    row: { kind: "mailmsg", key, at: when, blobs: [`sha256:${hex}`], content: { content: { gm_msgid: key, folder: "INBOX", labels: [] }, blobs: [{ hash: `sha256:${hex}`, role: "original", media_type: "message/rfc822" }] } },
    carried: { [hex]: bytes },
  };
}
function priorShape(slug: string, anchor: [string, string] | null, more: Record<string, unknown> = {}) {
  return { kind: "person", key: slug, content: {
    type: "people.person", slug, name: null, full_name: null, show: "name", entity: "person", relationship: null, hidden: false, me: false,
    anchor: anchor === null ? null : { kind: anchor[0], value: anchor[1] }, handles: [], excluded: [], dismissed: [], merged_into: null, ...more,
  } };
}
function older(slug: string, name: string, handles: [string, string][], merged_into: string | null = null) {
  const since = "2025-03-01T10:00:00Z";
  const all = [...handles, ["name", name] as [string, string]].sort(([leftKind, left], [rightKind, right]) => leftKind.localeCompare(rightKind) || left.localeCompare(right));
  return { kind: "person", key: slug, content: { type: "people.person", slug, name, handles: all.map(([kind, value]) => ({ kind, value, by: "subject", since })), excluded: [], merged_into } };
}
const statements = (lines: object[]) => ({ "statements.ndjson": Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join("")) });


async function openYouHome(prefix: string, roots: string[], options: { peopleHeld?: boolean } = {}) {
  const root = makeRoot(prefix, { sources: { [BOOK]: "people-rows", [PEOPLE]: "people-home" }, settings: { unit: UNIT, "day.zone": ZONE }, fake: { leaves: "the test cloud" } });
  roots.push(root);
  if (options.peopleHeld === true) {
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => tx.tables.controls.set({ target: "kind:people", reason: "the journey holds People's first run", at_ms: 1, by: "terminal" }));
    db.close();
  }
  const principals = openHomeFolder(root);
  mintPrincipal(principals, { unit: "reader-0001", scopes: ["read"], token: READER, now_ms: 0 });
  mintPrincipal(principals, { unit: DASHBOARD_UNIT, scopes: ["read", "deliver"], sources: [PEOPLE], token: DASHBOARD, now_ms: 0 });
  const door: Door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: REGISTRY });
  editSettings(root, { "door.port": door.port });
  const url = `http://127.0.0.1:${door.port}`;
  const sock = testSocket(root);
  let home: Home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: REGISTRY, log: () => undefined });
  let shipped = 0;
  const count = (sql: string, ...params: unknown[]) => readHome(root, (db) => db.prepare(sql).pluck().get(...params) as number);
  const imported = (id: string) => count("SELECT count(*) FROM deliveries WHERE id = ? AND state = 'imported'", id) === 1;
  const calm = () => count("SELECT count(*) FROM deliveries WHERE state IN ('sealed', 'importing')") === 0
    && count("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')") === 0 && count("SELECT count(*) FROM dirty_days") === 0;
  const call = async (method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: Body }> => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text === "" ? {} : JSON.parse(text) as Body };
  };
  const at = {
    root, sock, calm, count,
    get: (path: string) => call("GET", path, READER),
    ok: async (action: Body) => {
      const answer = await call("POST", "/v1/owner/act", DASHBOARD, { of: "people", ...action });
      expect(answer, `${action.kind} ${action.request}`).toMatchObject({ status: 200, body: { position: expect.stringMatching(/^\d+:\d+$/u) } });
      return answer.body as { act: string | null; id: string | null; position: string };
    },
    hide: (body: Body) => call("POST", "/v1/hide-details", READER, body),
    send: async (source: string, rows: object[], carried?: Record<string, Buffer>) => {
      const made = readHome(root, (db) => db.prepare("SELECT count(*) FROM sources WHERE id = ?").pluck().get(source)) === 0;
      const id = await ship(root, { source, fetched_ms: T + shipped * MINUTE, rows: rows as never, ...(carried === undefined ? {} : { carried }),
        ...(made ? { facts: { sources: [{ id: source, connector: "people-rows" }] } } : {}) });
      shipped++;
      await until(`${id} imported and the home calm`, () => imported(id) && calm());
    },
    say: async (lines: object[]) => {
      const id = await shipFiles(root, PEOPLE, T + shipped * MINUTE, statements(lines));
      shipped++;
      await until(`${id} imported and the home calm`, () => imported(id) && calm());
    },
    list: async () => {
      await until("the home calm", calm);
      return (await at.get("/v1/people")).body;
    },
    person: async (id: string) => {
      const answer = await at.get(`/v1/people?id=${encodeURIComponent(id)}`);
      expect(answer.status, id).toBe(200);
      return answer.body.person as Body;
    },
    stated: async (slug: string) => {
      const answer = await at.get(`/v1/record?${new URLSearchParams({ source: PEOPLE, kind: "person", key: slug })}`);
      return answer.status === 200 ? answer.body.version?.content ?? null : null;
    },
    setupYou: async () => ((await askHome(sock, "connectors", ["--unit", UNIT])) as { setup: { you: boolean } | null }).setup?.you,
    deliveries: () => readHome(root, (db) => db.prepare("SELECT id FROM deliveries WHERE source = ? ORDER BY sealed_ms, id").pluck().all(PEOPLE) as string[]),
    heads: () => readHome(root, (db) => db.prepare("SELECT key, version FROM heads WHERE source = ? AND kind = 'person' ORDER BY key").all(PEOPLE) as { key: string; version: string }[]),
    line: (text: string) => {
      const path = join(root, "days", `${DAY}.day.txt`);
      return existsSync(path) ? readFileSync(path, "utf8").split("\n").find((each) => each.includes(text))?.replace(/^\s*\d\d:\d\d\s+/u, "") ?? "" : "";
    },
    day: () => readFileSync(join(root, "days", `${DAY}.day.txt`), "utf8"),
    restart: async () => {
      await home.stop();
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: REGISTRY, log: () => undefined });
    },
    stop: async () => home.stop(),
    close: async () => {
      await door.close();
      await home.stop().catch(() => undefined);
    },
  };
  return at;
}

describe("You, the whole", () => {
  const roots: string[] = [];
  const report: Record<string, unknown> = {};
  afterAll(() => {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "you.json"), `${JSON.stringify(report, null, 2)}\n`);
    for (const root of roots) removeRoot(root);
  });

  it("F1-F4: a fresh home at Set up: the `you` act and its retry before People ever ran, the own accounts landing late into one You, the second number's line \"the user\", Ask's line [[Person 0]]", async () => {
    const at = await openYouHome("lifestream-you-fresh-", roots, { peopleHeld: true });
    try {
      expect([(await at.get("/v1/people")).status, (await at.get("/v1/people")).body.code]).toEqual([503, "NOT_NOW"]);
      expect(await at.setupYou()).toBe(false);
      const named = { kind: "you", request: randomUUID(), name: "Sam", full_name: "Sam Example" };
      const first = await at.ok(named);
      expect(first.id).toBe("person:sam");
      const retry = await at.ok(named);
      expect([retry.act, retry.id]).toEqual([first.act, first.id]);
      expect(at.deliveries()).toEqual([first.act]);
      expect(readSealed(openHomeFolder(at.root), join(at.root, "inbox", first.act!))!.facts).toMatchObject({ action: "you", request: named.request, id: "person:sam", device: DASHBOARD_UNIT });
      expect(await at.stated("sam")).toMatchObject({ name: "Sam", full_name: "Sam Example", me: true, anchor: null, handles: [], merged_into: null });
      expect(await at.setupYou()).toBe(true);
      await askHome(at.sock, "resume", ["kind:people"]);
      const named_alone = (await at.list()).you as Body;
      expect(named_alone).toMatchObject({ id: "person:sam", me: true, handles: [] });
      report.fresh_you = { first, retry, you: named_alone };

      await at.send(BOOK, [card("FN:Person A", "TEL;TYPE=CELL:+15550000021", "EMAIL:person-a@example.com")]);
      await at.send(OWN_WHATSAPP, [groupShell, groupLine("G1", "15550000021", T)]);
      await at.send(OWN_IMESSAGE, [imessage("GUID-A1", "+15550000021", T + MINUTE)]);
      const sent = mailRow("m1", T + 2 * MINUTE, "Sam Example <sam@example.com>", "Person A <person-a@example.com>");
      await at.send(OWN_MAIL, [sent.row], sent.carried);
      await at.send(OWN_WHATSAPP, [groupLine("G2", "15550000002", T + 3 * MINUTE)]);
      const list = await at.list();
      const you = list.you as Body;
      expect(you.id).toBe("person:sam");
      expect((you.handles as Body[]).map((each) => [each.id, each.from, each.own])).toEqual([
        ["phone:+15550000001", "Your WhatsApp", true], ["phone:+15550000002", "Your iMessage", true], ["email:sam@example.com", "Your Gmail", true],
      ]);
      expect((list.people as Body[]).map((each) => each.id)).not.toContain("person:sam");
      expect((list.people as Body[]).filter((each) => each.me === true)).toEqual([]);
      const me = await at.person("me");
      expect([me.id, me.name, me.full_name]).toEqual(["person:sam", "Sam", "Sam Example"]);
      expect(await at.setupYou()).toBe(true);

      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, "you-fresh.day.txt"), at.day());
      const friend = at.line("synthetic line G1");
      const second = at.line("synthetic line G2");
      expect(friend).toContain("Person A");
      expect(second).toContain("the user");
      for (const leak of ["Sam", "15550000002"]) expect(second).not.toContain(leak);

      editSettings(at.root, { "privacy.chat": "all", "model.defaults.hiding": null });
      const epoch = (await at.get("/v1/privacy")).body.epoch as number;
      const names = [me.call_name ?? me.name, me.full_name, ...(me.also_called as Body[]).map((each) => each.name)].filter((each): each is string => typeof each === "string");
      const hidden = await at.hide({
        table: "chat:you-journey", to: FAKE_ROUTE, what: "text", epoch,
        texts: names.map((text) => [{ text, is: "person", who: me.id }]),
      });
      expect(hidden).toMatchObject({ status: 200, body: { level: "all" } });
      const back = hidden.body.texts as string[];
      expect(back).toEqual(names.map(() => "[[Person 0]]"));
      const line = `The person is called ${[...new Set(back)].join(", ")}.`;
      expect(line).toBe("The person is called [[Person 0]].");
      report.fresh_ask = { names, sent: hidden.body, line };
      report.fresh = { you, me: { id: me.id, handles: me.handles, also_called: me.also_called, names_seen: me.names_seen }, lines: { friend, second } };
    } finally {
      await at.close();
    }
  });

  it("E1-E4: a home of the measured shapes: You served whole from a mark on a merged record; the labels rebuilt at code 9 with no record restated; a split of the marked member and its Undo; the onboarding's restart holds no name step", async () => {
    const at = await openYouHome("lifestream-you-existing-", roots);
    try {
      await at.send(BOOK, [card("FN:Person A", "TEL;TYPE=CELL:+15550000021", "EMAIL:person-a@example.com"), card("FN:Person Old", "TEL;TYPE=CELL:+15550000031")]);
      await at.send(OWN_WHATSAPP, [groupShell, groupLine("E1", "15550000021", T)]);
      await at.send(OWN_IMESSAGE, [imessage("GUID-E1", "+15550000021", T + MINUTE)]);
      const work = mailRow("m2", T + 2 * MINUTE, "Sam Example <sam-work@example.com>", "Person A <person-a@example.com>");
      await at.send(OWN_MAIL, [work.row], work.carried);
      await at.say([
        priorShape("sam", ["email", "sam@example.com"], { name: "Sam", full_name: "Sam Example" }),
        priorShape("sam-phone", ["phone", "+15550000009"], { me: true, merged_into: "sam" }),
        older("sam-work", "Sam Work", [["email", "sam-work@example.com"]], "sam"),
        priorShape("person-a", ["phone", "+15550000021"], { relationship: "friend" }),
        older("person-old", "Person Old", [["phone", "+15550000031"]]),
      ]);
      await at.list();

      const delivered = at.deliveries();
      const heads = at.heads();
      await at.stop();
      const db = new Database(join(at.root, "home.db"));
      try {
        db.transaction(() => {
          const rows = db.prepare("SELECT unit, content FROM extracts WHERE family = 'labels'").all() as { unit: string; content: unknown }[];
          const put = db.prepare("UPDATE extracts SET code = '8', content = ? WHERE family = 'labels' AND unit = ?");
          for (const { unit, content } of rows) {
            if (typeof content !== "string") continue;
            const value = JSON.parse(content) as Body;
            if (value.person !== undefined) delete value.person.me;
            put.run(canonical(value as Json), unit);
          }
          db.prepare("UPDATE extracts SET code = '8' WHERE family = 'labels'").run();
          db.prepare("UPDATE cursors SET fingerprint = 'a release before' WHERE name = ?").run(extractCursor("labels"));
          const kept = JSON.parse(db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(fingerprintKey("labels")) as string) as Body;
          db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify({ ...kept, parts: { ...kept.parts, code: "8" } }), fingerprintKey("labels"));
        })();
      } finally {
        db.close();
      }
      const labelsBefore = readHome(at.root, (read) => read.prepare("SELECT unit, code, content FROM extracts WHERE family = 'labels' AND unit IN ('phone:+15550000001', 'email:sam-work@example.com') ORDER BY unit").all());
      const youHandles = ["email:sam-work@example.com", "email:sam@example.com", "phone:+15550000001", "phone:+15550000002", "phone:+15550000009"];
      await at.restart();
      await until("the labels walked at code 9", () => at.calm() && at.count("SELECT count(*) FROM extracts WHERE family = 'labels' AND code <> '9'") === 0);
      const fingerprint = JSON.parse(readHome(at.root, (read) => read.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(fingerprintKey("labels")) as string)) as Body;
      expect(fingerprint.reason).toEqual(["code"]);
      const labelsAfter = readHome(at.root, (read) => read.prepare("SELECT unit, code, content FROM extracts WHERE family = 'labels' ORDER BY unit").all() as { unit: string; code: string; content: string }[]);
      const mine = labelsAfter.filter((row) => youHandles.includes(row.unit));
      expect(mine.map((row) => [row.unit, (JSON.parse(row.content) as Body).person?.me])).toEqual(youHandles.map((unit) => [unit, true]));
      const friendUnit = labelsAfter.find((row) => row.unit === "phone:+15550000021")!;
      expect((JSON.parse(friendUnit.content) as Body).person).toMatchObject({ me: false, id: "person:person-a" });
      expect(at.deliveries()).toEqual(delivered);
      expect(at.heads()).toEqual(heads);
      const mail = at.line("synthetic m2");
      expect(mail).toContain("the user");
      expect(mail).not.toContain("Sam");
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, "you-existing.day.txt"), at.day());
      report.existing_labels = { before: labelsBefore, after: mine, reason: fingerprint.reason, mail };

      const list = await at.list();
      const you = list.you as Body;
      expect([you.id, you.me, you.name, you.full_name]).toEqual(["person:sam", true, "Sam", "Sam Example"]);
      expect((you.handles as Body[]).filter((each) => each.own === true).map((each) => [each.id, each.from])).toEqual([
        ["phone:+15550000001", "Your WhatsApp"], ["phone:+15550000002", "Your iMessage"], ["email:sam@example.com", "Your Gmail"],
      ]);
      expect((you.handles as Body[]).map((each) => each.id).sort()).toEqual(youHandles);
      expect((list.people as Body[]).map((each) => each.id)).not.toContain("person:sam");
      const whole = await at.person("me");
      expect(whole.id).toBe("person:sam");
      expect((whole.joined as Body[]).map((each) => [each.id, each.handles])).toEqual([
        ["person:sam-phone", ["phone:+15550000009"]], ["person:sam-work", ["email:sam-work@example.com"]],
      ]);
      expect((await at.person("phone:+15550000031")).id).toBe("person:person-old");
      report.existing_you = { you, joined: whole.joined };

      const stood = async () => Object.fromEntries(await Promise.all(["sam", "sam-phone", "sam-work"].map(async (slug) => [slug, await at.stated(slug)])));
      const was = await stood();
      const split = await at.ok({ kind: "confirm", request: randomUUID(), id: "person:sam", split: ["person:sam-phone"] });
      expect(split.id).toBe("person:sam");
      expect(await at.stated("sam")).toMatchObject({ me: true, merged_into: null });
      expect(await at.stated("sam-phone")).toMatchObject({ me: false, merged_into: null });
      const apart = await at.list();
      expect((apart.you as Body).id).toBe("person:sam");
      expect(((apart.you as Body).handles as Body[]).map((each) => each.id)).not.toContain("phone:+15550000009");
      const leaver = await at.person("phone:+15550000009");
      expect([leaver.id, leaver.me]).toEqual(["person:sam-phone", false]);
      expect(((await at.person("me")).joined as Body[]).map((each) => each.id)).toEqual(["person:sam-work"]);
      const undone = await at.ok({ kind: "undo", request: randomUUID(), act: split.act });
      expect(await stood()).toEqual(was);
      await until("People past the undo", () => at.calm());
      const again = await at.person("me");
      expect([again.id, (again.joined as Body[]).map((each) => each.id)]).toEqual(["person:sam", ["person:sam-work", "person:sam-phone"]]);
      expect((await at.person("phone:+15550000009")).id).toBe("person:sam");
      report.existing_split = { split, undone, apart: apart.you };

      expect(await at.setupYou()).toBe(true);
    } finally {
      await at.close();
    }
  });

  it("G: the contract fixture's copy the MCP's fake door serves is the home's, byte for byte", () => {
    const home = readFileSync(join(REPO, "packages", "home", "test", "people-you.json"));
    const copy = readFileSync(join(REPO, "mcp", "test", "fake", "people-you.json"));
    expect(copy.equals(home)).toBe(true);
  });
});
