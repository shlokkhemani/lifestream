import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { serveDoor, type Door } from "./door.js";
import { startHome, type Home } from "./home.js";
import { DEVICES } from "./devices.js";
import { AGENT_UNIT, DRIVE_UNIT, mintPrincipal, passOf, readPrincipals, revokePrincipal } from "./principals.js";
import { readRef } from "./refs.js";
import { change } from "./settings.js";
import { artifact, makeRoot, readHome, removeRoot, searchIndexed, until, TICK_MS } from "./test/harness-root.js";
import { editSettings } from "./test/folder.js";
import { acquisitionBundle } from "./test/support.js";
import { openHomeFolder, type JsonObject } from "@lifestreamprotocol/core";

const REGISTRY = new URL("./test/ask-registry.ts", import.meta.url);
const HOME_UNIT = "macbook-pro-0001";
const ASK = `ask:local:${HOME_UNIT}`;
const PLACES = `places:local:${HOME_UNIT}`;
const READER = "synthetic-token-reader".padEnd(43, "r");
const OTHERS = {
  mac: "synthetic-token-mac".padEnd(43, "m"), phone: "synthetic-token-phone".padEnd(43, "p"), agent: "synthetic-token-agent".padEnd(43, "a"),
  drive: "synthetic-token-drive".padEnd(43, "d"), "another of unit ask": "synthetic-token-ask".padEnd(43, "k"),
};
const FLOORS = { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" };
const DAY = "2026-10-01";
const T0 = Date.parse(`${DAY}T14:00:00Z`);
const CHAT = `${T0}-3fa9c2`;

const chat = (title: string, at_ms: number) => ({ kind: "chat", key: CHAT, content: { type: "ask.chat", title, at_ms } });
const key = (n: number) => `${CHAT}:${String(n).padStart(4, "0")}`;
const question = (n: number, at_ms: number, text: string) => ({ kind: "msg", key: key(n), content: { type: "ask.msg", chat: CHAT, n, at_ms, role: "user", text } });
const answer = (n: number, at_ms: number, text: string) => ({
  kind: "msg", key: key(n),
  content: {
    type: "ask.msg", chat: CHAT, n, at_ms, role: "assistant", text,
    refs: { r1: { ref: "line.WyJsaW5lIiwiMjAyNi0wOS0yNyIsIndhbGsvdzIiLG51bGwsInJldjEiXQ", kind: "line", day: "2026-09-27", title: "A walk", opens: { page: "days", day: "2026-09-27", focus: "u:walk/w2" } } }, steps: [{ name: "search", words: "Searched for “lighthouse”", ms: 80 }],
    model: "gpt-6-luna", ms: 12_000, end: "done",
  },
});

function turn(source: string, made_ms: number, lines: unknown[]): { path: string; name: string; bytes: Buffer } {
  const text = Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  const bundle = acquisitionBundle({
    source, feeder: "owner-statements", fetched_ms: made_ms, files: [["statements.ndjson", text]],
    manifest: (manifest) => ({ ...manifest, facts: { statements: lines.length, blobs_carried: 0 } }),
  });
  return { path: bundle.path, name: bundle.path.split("/").at(-1)!, bytes: bundle.bytes };
}

describe("Ask's conversations through the door", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) removeRoot(root);
  });

  it("1-9: a turn the Ask server sends is lost, untimed, missed by Find, sealed though refused, or sent with a pass that does more, or a new one each start", async () => {
    const root = makeRoot("lifestream-ask-", { sources: {} });
    roots.push(root);
    editSettings(root, { unit: null });
    const principals = openHomeFolder(root);
    mintPrincipal(principals, { unit: "reader", scopes: ["read"], sources: [], token: READER, now_ms: 0 });
    const logged: string[] = [];
    let home: Home | undefined;
    let door: Door | undefined;
    try {
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: REGISTRY, log: (line) => logged.push(line) });
      door = await serveDoor(root, { port: 0, lan_port: 0, max_bundle_bytes: 1 << 30 }, { log: (line) => logged.push(line), registry: REGISTRY, floors: FLOORS });
      let url = `http://127.0.0.1:${door.port}`;
      const report: Record<string, unknown> = {};

      expect((JSON.parse(readFileSync(join(root, "config", "settings.json"), "utf8")) as { unit?: string }).unit).toBe(HOME_UNIT);
      const file = join(process.env.LIFESTREAM_MACHINE_DIR!, "ask", "door-token");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const token = readFileSync(file, "utf8").trim();
      const pass = passOf(principals, token)!;
      expect({ unit: pass.unit, scopes: pass.scopes, sources: pass.sources, kind: pass.kind, revoked: pass.revoked_at }).toEqual({ unit: "ask", scopes: ["deliver"], sources: [ASK], kind: null, revoked: null });
      expect(readHome(root, (db) => db.prepare("SELECT connector FROM sources WHERE id = ?").pluck().get(ASK))).toBe("ask-home");

      const asker = { authorization: `Bearer ${token}` };
      const send = async (headers: Record<string, string>, sent: ReturnType<typeof turn>) => {
        const response = await fetch(`${url}${sent.path}`, { method: "PUT", headers, body: sent.bytes });
        return { status: response.status, body: await response.json() as Record<string, unknown> };
      };
      const get = async (path: string, headers: Record<string, string> = { authorization: `Bearer ${READER}` }) => {
        const response = await fetch(`${url}${path}`, { headers });
        return { status: response.status, body: await response.json() as Record<string, any> };
      };
      const found = async (words: string) => {
        const answered = await get(`/v1/search?lists=record&query=${encodeURIComponent(words)}`);
        expect(answered.status, JSON.stringify(answered.body)).toBe(200);
        report[`search ${words}`] = answered.body;
        return (answered.body.record.hits as { ref: string }[]).map((hit) => {
          const ref = readRef(hit.ref, "ref", ["record", "line"]);
          return ref.kind === "record" ? `${ref.parts.kind} ${ref.parts.key}` : `line ${ref.parts.day}`;
        });
      };
      const heads = () => Object.fromEntries((readHome(root, (db) => db.prepare("SELECT h.key, h.start_ms, h.stated_ms, v.text FROM heads h JOIN versions v ON v.id = h.version WHERE h.source = ? ORDER BY h.key").all(ASK)) as
        { key: string; start_ms: number; stated_ms: number; text: string }[]).map((row) => [row.key, { start_ms: row.start_ms, stated_ms: row.stated_ms, title: (JSON.parse(row.text) as { content: { title?: string } }).content.title }]));
      const statements = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM statements WHERE source = ?").pluck().get(ASK) as number);

      const first = turn(ASK, T0 + 20_000, [chat("Where did I see", T0 + 15_000), question(1, T0, "Where did I see the synthetic lighthouse?"), answer(2, T0 + 15_000, "At the harbour on Sunday [r1].")]);
      expect((await send(asker, first)).status).toBe(201);
      await until("the turn imported, printed and indexed", () => existsSync(join(root, "days", `${DAY}.day.txt`)) && searchIndexed(root) && heads()[CHAT] !== undefined);
      expect(heads()).toEqual({
        [CHAT]: { start_ms: T0 + 15_000, stated_ms: T0 + 20_000, title: "Where did I see" },
        [key(1)]: { start_ms: T0, stated_ms: T0 + 20_000 },
        [key(2)]: { start_ms: T0 + 15_000, stated_ms: T0 + 20_000 },
      });
      expect(readHome(root, (db) => db.prepare("SELECT DISTINCT device FROM statements WHERE source = ?").pluck().all(ASK))).toEqual(["ask"]);

      const day = readFileSync(join(root, "days", `${DAY}.day.txt`), "utf8");
      expect(day).toContain("Ask · Where did I see");
      expect(day).toContain("the user: Where did I see the synthetic lighthouse?");
      expect(day).toContain("Ask: At the harbour on Sunday.");
      expect(day).not.toContain("[r1]");
      report.day = day;

      expect(await found("lighthouse")).toEqual([`msg ${key(1)}`]);
      expect(await found("harbour")).toEqual([`msg ${key(2)}`]);

      const second = turn(ASK, T0 + 90_000, [chat("Synthetic outing", T0 + 85_000), question(3, T0 + 60_000, "And the synthetic pier?"), answer(4, T0 + 85_000, "Not that week [r1].")]);
      expect((await send(asker, second)).status).toBe(201);
      await until("the second turn imported and indexed", () => heads()[key(4)] !== undefined && searchIndexed(root));
      expect(heads()[CHAT]).toEqual({ start_ms: T0 + 85_000, stated_ms: T0 + 90_000, title: "Synthetic outing" });
      expect((await found("outing")).sort()).toEqual([`chat ${CHAT}`, `msg ${key(1)}`, `msg ${key(2)}`, `msg ${key(3)}`, `msg ${key(4)}`]);
      expect(await found("week")).toEqual([`msg ${key(4)}`]);

      const landed = statements();
      const bad: Record<string, unknown> = {
        "a wrong key": { ...question(5, T0 + 120_000, "Synthetic?"), key: `${CHAT}:5` },
        "an unknown member": { ...question(5, T0 + 120_000, "Synthetic?"), content: { ...question(5, T0 + 120_000, "Synthetic?").content, mood: "curious" } },
        "an n its key disagrees with": { ...question(5, T0 + 120_000, "Synthetic?"), key: key(6) },
      };
      const refusals: Record<string, unknown> = {};
      for (const [name, line] of Object.entries(bad)) {
        const sent = turn(ASK, T0 + 120_000, [chat("Synthetic outing", T0 + 120_000), line]);
        const refused = await send(asker, sent);
        expect([refused.status, refused.body.code], name).toEqual([422, "STATEMENTS_BAD"]);
        expect(refused.body.message, name).toMatch(/statements\.ndjson line 2/u);
        expect(existsSync(join(root, "inbox", ASK, sent.name)), name).toBe(false);
        refusals[name] = refused.body;
      }
      expect(statements()).toBe(landed);
      report.refusals = refusals;

      const reads = { days: (await get("/v1/days", asker)).status, records: (await get(`/v1/records?source=${encodeURIComponent(ASK)}`, asker)).status, search: (await get("/v1/search?lists=record&query=lighthouse", asker)).status };
      expect(reads).toEqual({ days: 403, records: 403, search: 403 });
      const elsewhere = await send(asker, turn(PLACES, T0 + 120_000, [{ kind: "place", key: "pier-3f9a2c", content: { type: "places.place", name: "Synthetic Pier", centre: { latitude: 0, longitude: 0 }, radius_m: 100, ids: [] } }]));
      expect([elsewhere.status, elsewhere.body.code]).toEqual([403, "PRINCIPAL_SCOPE"]);

      const others = [
        mintPrincipal(principals, { unit: HOME_UNIT, kind: "mac", scopes: [...DEVICES.mac.scopes], sources: [`screen:local:${HOME_UNIT}`], token: OTHERS.mac, now_ms: 0 }),
        mintPrincipal(principals, { unit: "iphone-aa01", kind: "phone", scopes: [...DEVICES.phone.scopes], sources: ["location:local:iphone-aa01"], token: OTHERS.phone, now_ms: 0 }),
        mintPrincipal(principals, { unit: AGENT_UNIT, kind: "agent", scopes: ["read"], sources: [], token: OTHERS.agent, now_ms: 0,
          granted: { agent: { name: "Synthetic Agent", via: "pass", from: null, checked: false, client_id: null, resource: null } } }),
        mintPrincipal(principals, { unit: DRIVE_UNIT, scopes: ["drive"], sources: [], token: OTHERS.drive, now_ms: 0 }),
        mintPrincipal(principals, { unit: "ask", scopes: ["deliver"], sources: [ASK], token: OTHERS["another of unit ask"], now_ms: 0 }),
      ].map((minted) => minted.principal.id);
      const another = others.at(-1)!;
      for (const id of others.filter((id) => id !== another)) revokePrincipal(principals, id, T0);

      await door.close();
      door = undefined;
      await home.stop();
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: REGISTRY, log: () => undefined });
      expect(readFileSync(file, "utf8").trim()).toBe(token);
      expect(readPrincipals(principals).principals.filter((row) => row.unit === "ask" && row.id !== another).map((row) => row.id)).toEqual([pass.id]);

      await home.stop();
      home = undefined;
      const moved = "mac-mini-bb03";
      change(root, "unit", moved);
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: REGISTRY, log: () => undefined });
      door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: REGISTRY });
      url = `http://127.0.0.1:${door.port}`;
      const renewed = readFileSync(file, "utf8").trim();
      expect(renewed).not.toBe(token);
      const rows = readPrincipals(principals).principals.filter((row) => row.unit === "ask" && row.id !== another);
      expect(rows.map((row) => [row.id === pass.id, row.sources, row.revoked_at === null])).toEqual([[true, [ASK], false], [false, [`ask:local:${moved}`], true]]);
      expect(readHome(root, (db) => db.prepare("SELECT count(*) FROM events WHERE kind = 'pass-revoked' AND key = ?").pluck().get(pass.id))).toBe(1);
      const later = turn(`ask:local:${moved}`, T0 + 180_000, [chat("Synthetic outing", T0 + 180_000), question(5, T0 + 170_000, "Synthetic again?")]);
      expect((await send(asker, later)).status).toBe(401);
      expect((await send({ authorization: `Bearer ${renewed}` }, later)).status).toBe(201);
      artifact(root, "ask", report);
    } finally {
      await door?.close();
      await home?.stop();
    }
  });
});
