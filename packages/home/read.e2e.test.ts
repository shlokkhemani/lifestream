import { existsSync, readFileSync, renameSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveDoor, type Door } from "./door.js";
import { startHome, type Home } from "./home.js";
import { preparedDirOf, preparedFileOf } from "./prepared.js";
import { mintPrincipal } from "./principals.js";
import { PICTURE_WORDS } from "./read.js";
import { ANSWER_CHARS } from "./call.js";
import { lineRef, makeRef, readRef } from "./refs.js";
import { answerOf, citation, type ReadAnswer, type RoutePath } from "./search-contract.js";
import { searchFileOf } from "./search-index.js";
import { artifact, FAKE_ROUTE, hex, LOOK_MS, makeRoot, readHome, removeRoot, settled, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { openHomeFolder } from "@lifestreamprotocol/core";


const REGISTRY = fileURLToPath(new URL("./test/read-registry.ts", import.meta.url));
const READER = "synthetic-token-read-route".padEnd(43, "r");
const WHATSAPP = "whatsapp:local:iphone-aa01";
const NOTES = "apple-notes:local:device-a";
const BROWSER = "claude:org-0001:browser";
const CALLS = "apple-calls:local:iphone-aa01";
const ADA = "15550000142@s.whatsapp.net";
const RAJ = "15550000143@s.whatsapp.net";
const OLD = "15550000144@s.whatsapp.net";
const CHAT = `whatsapp:${ADA}`;
const CONVERSATION = "00000000-0000-4000-8000-0000000000c1";
const AI_CHAT = `claude:org-0001:cloud/${CONVERSATION}`;
const APPLE_EPOCH_S = 978_307_200;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T = Math.floor(Date.now() / DAY) * DAY - 10 * DAY + 9 * HOUR;
const T_OLD = T - 3 * 365 * DAY;
const PHOTO = Buffer.from("synthetic chat photo bytes");
const AUDIO = (name: string) => readFileSync(new URL(`../core/test/audio/${name}`, import.meta.url));
const LONG = Array.from({ length: 6_000 }, (_, index) => `synthetic answer word ${index}.`).join(" ");
const answers: Record<string, unknown> = {};

function wa(stanza: string, chat: string, when: number, words: string | null, photo?: string) {
  const date = when / 1000 - APPLE_EPOCH_S;
  const message = {
    ZSTANZAID: stanza, ZTEXT: words, ZFROMJID: chat, ZTOJID: null, ZPUSHNAME: null, ZMESSAGEDATE: date, ZSENTDATE: date,
    ZMESSAGETYPE: photo === undefined ? 0 : 1, ZGROUPEVENTTYPE: null, ZFLAGS: 0, ZMESSAGESTATUS: 1, ZMESSAGEERRORSTATUS: 0, ZISFROMME: 0, ZSTARRED: 0,
  };
  return {
    kind: "msg", key: `${chat}:${stanza}`, at: when,
    content: {
      type: "whatsapp.msg", message, session_jid: chat, parent_stanza_id: null, media_item: null, group_member_jid: null,
      blobs: photo === undefined ? [] : [{ hash: `sha256:${photo}`, bytes: PHOTO.length, role: "ZWAMEDIAITEM.ZMEDIALOCALPATH" }],
    },
    ...(photo === undefined ? {} : { blobs: [`sha256:${photo}`] }),
  };
}

function voiceNote(stanza: string, chat: string, when: number, audio: Buffer, mine = false) {
  const row = wa(stanza, chat, when, null, hex(audio));
  return {
    ...row,
    content: {
      ...row.content, message: { ...row.content.message, ZMESSAGETYPE: 3, ZISFROMME: mine ? 1 : 0 }, media_item: { ZMOVIEDURATION: 23 },
      blobs: [{ hash: `sha256:${hex(audio)}`, bytes: audio.length, role: "ZWAMEDIAITEM.ZMEDIALOCALPATH" }],
    },
  };
}

function turn(n: number, sender: "human" | "assistant", text: string, start: number) {
  const uuid = (at: number) => `00000000-0000-4000-8000-${String(at).padStart(12, "0")}`;
  return {
    kind: "msg", key: `${CONVERSATION}:${uuid(n)}`, at: start,
    content: {
      type: "claude.msg", conversation_uuid: CONVERSATION,
      message: {
        uuid: uuid(n), text, content: [{ type: "text", text }], sender, created_at: new Date(start).toISOString(), updated_at: new Date(start).toISOString(),
        attachments: [], files: [], parent_message_uuid: n === 1 ? null : uuid(n - 1),
      },
    },
  };
}

function caughtUp(root: string): boolean {
  let index: { seq: number; days: number };
  try {
    const db = new Database(searchFileOf(root, process.env.LIFESTREAM_MACHINE_DIR!), { readonly: true, fileMustExist: true, timeout: 5_000 });
    try {
      index = {
        seq: (JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'position'").pluck().get() as string) as { seq: number }).seq,
        days: db.prepare("SELECT count(*) FROM days").pluck().get() as number,
      };
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
  return readHome(root, (db) => index.seq === (db.prepare("SELECT coalesce(max(seq), 0) FROM statements").pluck().get() as number)
    && (db.prepare("SELECT count(*) FROM jobs WHERE state <> 'done'").pluck().get() as number) === 0
    && (db.prepare("SELECT count(*) FROM dirty_days").pluck().get() as number) === 0
    && (db.prepare("SELECT count(*) FROM days").pluck().get() as number) === index.days);
}

function indexLines(root: string): { day: string; same: string; m: number; unit: string; item: string | null; rev: string }[] {
  const db = new Database(searchFileOf(root, process.env.LIFESTREAM_MACHINE_DIR!), { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`SELECT a.day, a.same, (SELECT count(*) FROM atoms b WHERE b.day = a.day AND b.same = a.same AND b.n < a.n) AS m, a.unit, a.item, d.inputs AS rev
      FROM atoms a JOIN days d ON d.day = a.day ORDER BY a.day, a.n`).all() as { day: string; same: string; m: number; unit: string; item: string | null; rev: string }[];
  } finally {
    db.close();
  }
}

describe("read: refs and chats", () => {
  let root: string;
  let home: Home;
  let door: Door;
  let shipped = 0;
  let asks: Server;
  const turnPasses: string[] = [];
  const leaving = new AbortController();
  const photo = hex(PHOTO);
  const message = (stanza: string, chat = ADA) => makeRef("record", { source: WHATSAPP, kind: "msg", key: `${chat}:${stanza}` });
  const chatRef = (key: string) => makeRef("chat", { key });

  const send = async (planned: Parameters<typeof ship>[1]) => {
    await ship(root, planned);
    shipped++;
    await until("the home settled", () => settled(root, shipped));
  };
  const read = async (name: string, query: Record<string, string | string[]>): Promise<{ status: number; body: any }> => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) for (const each of typeof value === "string" ? [value] : value) params.append(key, each);
    const response = await fetch(`http://127.0.0.1:${door.port}/v1/read?${params}`, { headers: { authorization: `Bearer ${READER}` } });
    const body = await response.json() as Record<string, unknown>;
    answers[name] = { query, status: response.status, body };
    answerOf("/v1/read", response.status, body);
    return { status: response.status, body };
  };
  const opened = async (name: string, query: Record<string, string | string[]>): Promise<any> => {
    const { status, body } = await read(name, query);
    expect(status, JSON.stringify(body)).toBe(200);
    return body as ReadAnswer;
  };
  const asked = async (route: "/v1/count" | "/v1/search", name: string, query: Record<string, string | string[]>): Promise<{ status: number; body: any }> => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) for (const each of typeof value === "string" ? [value] : value) params.append(key, each);
    const response = await fetch(`http://127.0.0.1:${door.port}${route}?${params}`, { headers: { authorization: `Bearer ${READER}` } });
    const body = await response.json() as Record<string, unknown>;
    answers[name] = { route, query, status: response.status, body };
    answerOf(route, response.status, body);
    return { status: response.status, body };
  };
  const described = async (name: string, refs: string[]): Promise<any[]> => {
    const response = await fetch(`http://127.0.0.1:${door.port}/v1/describe?${new URLSearchParams(refs.map((ref): [string, string] => ["ref", ref]))}`, { headers: { authorization: `Bearer ${READER}` } });
    const body = await response.json() as { described: unknown[] };
    answers[name] = { refs, status: response.status, body };
    expect(response.status, JSON.stringify([body, failed])).toBe(200);
    answerOf("/v1/describe", response.status, body);
    return body.described;
  };
  const failed: unknown[] = [];
  let kept: any[] = [];
  const pages = async (name: string, first: any): Promise<any[]> => {
    const all = [first];
    for (let at = 1; all.at(-1).next !== null && all.at(-1).next !== undefined; at++) all.push(await opened(`${name}-${at}`, { cursor: all.at(-1).next }));
    return all;
  };

  beforeAll(async () => {
    root = makeRoot("lifestream-read-", { sources: { [WHATSAPP]: "fake-rows", [NOTES]: "fake-rows", [BROWSER]: "fake-rows", [CALLS]: "fake-rows" } });
    mintPrincipal(openHomeFolder(root), { unit: "read-route-aa01", scopes: ["read"], token: READER, now_ms: 0 });
    home = await startHome(root, { stopGraceMs: 50, registry: REGISTRY, log: () => undefined, tickMs: TICK_MS, lookMs: LOOK_MS });
    await send({ source: NOTES, fetched_ms: Date.now(), rows: [{ kind: "note", key: "n1", at: T, content: { text: "synthetic note, first words", at: T } }] });
    await send({ source: NOTES, fetched_ms: Date.now() + 1, rows: [{ kind: "note", key: "n1", at: T, content: { text: "synthetic note, second words", at: T } }] });
    await send({
      source: WHATSAPP, fetched_ms: Date.now() + 2, carried: { [photo]: PHOTO },
      rows: [
        wa("m1", ADA, T, "dinner at the lighthouse tonight"), wa("m2", ADA, T + 5 * 60_000, null, photo), wa("m3", ADA, T + DAY + HOUR, "see you there"),
        wa("r1", RAJ, T + HOUR, "chai with the cousins"), wa("o1", OLD, T_OLD, "an old synthetic line about the ferry"),
      ],
    });
    await send({
      source: BROWSER, fetched_ms: Date.now() + 3,
      rows: [turn(1, "human", "Which synthetic step comes first?", T + 2 * DAY), turn(2, "assistant", LONG, T + 2 * DAY + 60_000), turn(3, "human", "Thank you, synthetic.", T + 2 * DAY + 120_000)],
    });
    asks = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        turnPasses.push(request.headers.authorization!.slice("Bearer ".length));
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.write(`${JSON.stringify({ type: "chat", chat: "1790000000000-abcdef", n: 2 })}\n`);
      });
    });
    await new Promise<void>((done) => asks.listen(0, "127.0.0.1", done));
    door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, {
      log: (line) => void failed.push(...String(line).includes('"status":500') ? [line] : []), registry: REGISTRY, ask: `http://127.0.0.1:${(asks.address() as AddressInfo).port}`, lookMs: LOOK_MS, readWaitMs: 100,
    });
    await until("the index caught up with the home", () => caughtUp(root));
  });

  afterAll(async () => {
    if (root !== undefined) artifact(root, "read-refs-chats", answers);
    leaving.abort();
    asks?.closeAllConnections();
    await new Promise<void>((done) => asks === undefined ? done() : asks.close(() => done()));
    await door?.close();
    await home?.stop().catch(() => undefined);
    if (root !== undefined) removeRoot(root);
  });

  it("a chat reads the same by a message's ref, by its span and alone; its photo a line of its own whose ref opens the photo", async () => {
    const alone = await opened("chat-alone", { chat: chatRef(CHAT) });
    expect(alone).toMatchObject({ what: "chat", chat: chatRef(CHAT), next: null });
    expect(alone.lines.map((line: any) => line.ref)).toEqual([message("m1"), message("m2"), makeRef("picture", { image: `sha256:${photo}` }), message("m3")]);
    expect(alone.lines[0]).toMatchObject({ text: "dinner at the lighthouse tonight", day: alone.span.from });
    expect(alone.lines[2]).toMatchObject({ picture: true, text: PICTURE_WORDS, at: alone.lines[1].at, from: alone.lines[1].from });
    expect(alone.lines.some((line: any) => line.text.includes("chai"))).toBe(false);
    const span = await opened("chat-span", { chat: chatRef(CHAT), from: alone.span.from, to: alone.span.to });
    const byRef = await opened("chat-by-ref", { ref: message("m3") });
    expect(byRef).toMatchObject({ what: "chat", around: message("m3") });
    expect([span.lines, byRef.lines]).toEqual([alone.lines, alone.lines]);
    const pictured = await opened("picture", { ref: alone.lines[2].ref });
    expect(pictured).toMatchObject({ what: "photo", ref: alone.lines[2].ref, image: `sha256:${photo}`, day: alone.lines[1].day });
  });

  it("a turn longer than a page goes on by cursor, given back whole, the turns beside it once; a cursor with other arguments is refused", async () => {
    const first = await opened("turn-span", { chat: chatRef(AI_CHAT) , from: new Date(T + 2 * DAY).toISOString().slice(0, 10) });
    const all = await pages("turn-span", first);
    const lines = all.flatMap((page) => page.lines);
    const byRef = new Map<string, string[]>();
    for (const line of lines) byRef.set(line.ref, [...byRef.get(line.ref) ?? [], line.text]);
    const texts = [...byRef.values()];
    expect(texts.map((parts) => parts.length > 1)).toEqual([false, true, false]);
    expect(texts.map((parts) => parts.join(""))).toEqual(["Which synthetic step comes first?", LONG, "Thank you, synthetic."]);
    expect(all.every((page) => JSON.stringify(page).length <= ANSWER_CHARS.person)).toBe(true);
    expect(lines.map((line) => line.from)).toEqual(["You", ...Array(texts[1]!.length).fill(lines[1].from), "You"]);
    expect((await read("cursor-own", { cursor: first.next, chat: chatRef(AI_CHAT), from: new Date(T + 2 * DAY).toISOString().slice(0, 10) })).status).toBe(200);
    expect((await read("cursor-other", { cursor: first.next, chat: chatRef(CHAT) })).body).toMatchObject({ code: "BAD_PARAMETER" });
    expect((await read("cursor-forged", { cursor: "read.e30" })).body).toMatchObject({ code: "BAD_PARAMETER" });
    const around = await pages("turn-ref", await opened("turn-ref", { ref: lines[1].ref }));
    expect(around[0]).toMatchObject({ what: "chat", around: lines[1].ref });
    expect(around.flatMap((page) => page.lines).filter((line) => line.ref === lines[1].ref).map((line) => line.text).join("")).toBe(LONG);
  });

  it("a Chat turn hidden at `none` reads the five as the person's own read does, each page at a model's size", async () => {
    const asking = await fetch(`http://127.0.0.1:${door.port}/v1/ask`, {
      method: "POST", signal: leaving.signal, headers: { authorization: `Bearer ${READER}`, "content-type": "application/json" },
      body: JSON.stringify({ question: "Synthetic?", chat: "1790000000000-abcdef", level: "none" }),
    });
    expect(asking.status).toBe(200);
    const turn = turnPasses.at(-1)!;
    const as = async (token: string, route: RoutePath, args: Record<string, string | readonly string[]>): Promise<{ status: number; body: any }> => {
      const response = token === turn
        ? await fetch(`http://127.0.0.1:${door.port}${route}`, {
          method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ args, to: FAKE_ROUTE, shown: [] }),
        })
        : await fetch(`http://127.0.0.1:${door.port}${route}?${new URLSearchParams(Object.entries(args).flatMap(([name, value]) => [value].flat().map((each): [string, string] => [name, each])))}`, { headers: { authorization: `Bearer ${token}` } });
      const body = await response.json() as Record<string, unknown>;
      answerOf(route, response.status, body);
      return { status: response.status, body };
    };
    const walk = async (token: string): Promise<any[]> => {
      const found = await as(token, "/v1/search", { lists: ["record"], query: "synthetic step" });
      const chat = (found.body.record.hits as { chat?: string }[]).find((hit) => hit.chat !== undefined)!.chat!;
      if (token === READER) expect(chat).toBe(chatRef(AI_CHAT));
      const first = await as(token, "/v1/read", { chat, from: new Date(T + 2 * DAY).toISOString().slice(0, 10) });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const all = [first.body];
      while (all.at(-1).next !== null && all.at(-1).next !== undefined) {
        const page = await as(token, "/v1/read", { cursor: all.at(-1).next });
        expect(page.status, JSON.stringify(page.body)).toBe(200);
        all.push(page.body);
      }
      return all;
    };
    const [model, person] = [await walk(turn), await walk(READER)];
    expect(model.every((page) => JSON.stringify(page).length <= ANSWER_CHARS.model)).toBe(true);
    expect(model.length).toBeGreaterThan(person.length);
    const whole = (all: any[]) => {
      const byRef = new Map<string, string>();
      for (const line of all.flatMap((page) => page.lines)) byRef.set(line.ref, `${byRef.get(line.ref) ?? ""}${line.text}`);
      return [...byRef.values()];
    };
    expect(whole(model)).toEqual(whole(person));
    expect(whole(model)).toContain(LONG);
    const handled = (value: unknown): unknown =>
      typeof value === "string" ? (/^r[1-9]\d*$/u.test(value) ? "<ref>" : value) : Array.isArray(value) ? value.map(handled)
        : typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value).map(([name, each]) => [name, handled(each)])) : value;
    const reffed = (value: unknown): unknown =>
      typeof value === "string" ? (/^[a-z]+\.[A-Za-z0-9_-]{8,}$/u.test(value) ? "<ref>" : value) : Array.isArray(value) ? value.map(reffed)
        : typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value).map(([name, each]) => [name, reffed(each)])) : value;
    for (const [route, args] of [
      ["/v1/count", { of: "messages", by: ["chat"] }], ["/v1/people/search", { name: "15550000142" }], ["/v1/search", { lists: ["record"], query: "lighthouse" }],
    ] as const) {
      const [read, own] = [await as(turn, route, args), await as(READER, route, args)];
      expect(read.status, `${route} ${JSON.stringify(read.body)}`).toBe(200);
      expect(handled(read.body), route).toEqual(reffed(own.body));
    }
  });

  it("a row opens as its facts, run again: one group's alone, its words' alone, and both counts once the record moved", async () => {
    const row = (ask: Record<string, unknown>, kept: Record<string, unknown>, n: number) => makeRef("row", { ask: ask as never, kept, scope: { g: [CHAT], p: null }, n });
    const byChat = row({ of: "messages", by: ["chat"] }, {}, 3);
    const before = await opened("row-before", { ref: byChat });
    expect(before).toMatchObject({ what: "row", ref: byChat, n: 3, next: null });
    expect("now" in before).toBe(false);
    expect(before.rows.map((each: any[]) => each.at(-1)).sort()).toEqual([message("m1"), message("m2"), message("m3")].sort());
    const words = row({ of: "messages", words: "lighthouse", by: ["chat"] }, {}, 1);
    expect((await opened("row-words", { ref: words })).rows.map((each: any[]) => each.at(-1))).toEqual([message("m1")]);
    expect(await opened("row-fact", { ref: before.rows[0].at(-1) })).toMatchObject({ what: "chat" });
    await send({ source: WHATSAPP, fetched_ms: Date.now() + 4, rows: [wa("m4", ADA, T + DAY + 2 * HOUR, "one more synthetic line")] });
    await until("the index caught up with the new message", () => caughtUp(root));
    const after = await opened("row-after", { ref: byChat });
    expect(after).toMatchObject({ what: "row", n: 3, now: 4 });
    expect(after.rows.map((each: any[]) => each.at(-1))).toContain(message("m4"));
    expect(await described("row-described", [byChat, words])).toEqual([
      { ref: byChat, kind: "row", asked: after.asked, n: 3, opens: { page: "read" } },
      { ref: words, kind: "row", asked: (await opened("row-words-asked", { ref: words })).asked, n: 1, opens: { page: "read" } },
    ]);
  });

  it("a day line is found again by its identity (its `same` and ordinal), under every render of its day; a line that left its day is LINE_MOVED alone, `gone` among refs", async () => {
    const lines = indexLines(root);
    const count = (line: { day: string; unit: string; item: string | null }) => lines.filter((each) => each.day === line.day && each.unit === line.unit && each.item === line.item).length;
    const one = lines.find((line) => count(line) === 1)!;
    const two = lines.find((line) => count(line) > 1)!;
    expect([one, two].every((line) => line !== undefined)).toBe(true);
    const ref = lineRef(one, one.m);
    const found = await opened("line", { ref });
    expect(found).toMatchObject({ what: "line", ref, day: one.day, rev: one.rev });
    expect(found.lines.filter((line: any) => line.ref === ref)).toHaveLength(1);
    expect(found.lines.length).toBeLessThanOrEqual(11 + 11);
    const left = [lineRef({ ...two, same: "0000000000000000" }, 0), lineRef({ ...one, same: "0000000000000000", unit: "no-such-unit" }, 0)];
    for (const [at, gone] of left.entries()) expect(await read(`line-left-${at}`, { ref: gone })).toMatchObject({ status: 409, body: { code: "LINE_MOVED" } });
    const among = await opened("line-among", { ref: [left[0]!, ref] });
    expect(among.opened.map((each: any) => each.what)).toEqual(["gone", "line"]);
    expect(among.opened[0]).toMatchObject({ what: "gone", ref: left[0], why: expect.stringContaining("no longer in its day") });
  });

  it("a record opens whole, its versions with history; one no longer held is gone; several open together, a seventh picture opens as its facts alone", async () => {
    const note = makeRef("record", { source: NOTES, kind: "note", key: "n1" });
    const whole = await opened("record", { ref: note, history: "1" });
    expect(whole).toMatchObject({ what: "record", ref: note, family: "notes" });
    expect(whole.text).toContain("second words");
    expect(whole.history.map((each: any) => each.text)).toEqual([expect.stringContaining("first words"), expect.stringContaining("second words")]);
    const nothing = makeRef("record", { source: NOTES, kind: "note", key: "never-held" });
    expect(await opened("record-gone", { ref: nothing })).toMatchObject({ what: "gone", ref: nothing });
    const both = await opened("refs", { ref: [note, message("r1", RAJ)] });
    expect(both.what).toBe("refs");
    expect(both.opened.map((each: any) => each.what)).toEqual(["record", "chat"]);
    expect(both.opened[1].lines.map((line: any) => line.ref)).toEqual([message("r1", RAJ)]);
    const picture = makeRef("picture", { image: `sha256:${photo}` });
    expect((await read("pictures-six", { ref: Array(6).fill(picture) })).status).toBe(200);
    const seven = await opened("pictures-seven", { ref: Array(7).fill(picture) });
    expect(seven.opened.map((each: any) => each.image !== undefined)).toEqual([true, true, true, true, true, true, false]);
    expect(seven.opened[6]).toMatchObject({ what: "photo", ref: picture, facts: expect.arrayContaining([expect.stringContaining("not shown")]) });
  });

  it("a chat's ref opens as People answers it with its latest, or as its latest; a person or a place held by no one is gone", async () => {
    const alone = await opened("chat-alone-again", { chat: chatRef(CHAT) });
    const chat = await opened("chat-ref", { ref: chatRef(CHAT) });
    expect(chat.what === "people" ? chat.latest.lines : chat.lines).toEqual(alone.lines);
    for (const [name, ref] of [["person-gone", makeRef("person", { handle: "person:no-one" })], ["place-gone", makeRef("place", { id: "no-such-place" })]] as const) {
      expect(await opened(name, { ref })).toMatchObject({ what: "gone", ref });
    }
  });

  it("a person's ref opens as search_people answers that person, member for member", async () => {
    const response = await fetch(`http://127.0.0.1:${door.port}/v1/people/search?name=15550000142`, { headers: { authorization: `Bearer ${READER}` } });
    const found = await response.json() as any;
    answers["person-search"] = { status: response.status, body: found };
    answerOf("/v1/people/search", response.status, found);
    expect(response.status, JSON.stringify(found)).toBe(200);
    const match = found.matches.find((each: any) => each.ref.startsWith("person."));
    expect(match, JSON.stringify(found)).toBeDefined();
    const person = await opened("person", { ref: match.ref });
    expect(person).toMatchObject({ what: "people" });
    expect(person.match).toEqual(match);
  });

  it("a chat three years old reads alone with People's file away: its days are the index's, never a guessed year", async () => {
    const machine = process.env.LIFESTREAM_MACHINE_DIR!;
    const people = preparedFileOf(preparedDirOf(root, machine, "people"), "people");
    expect(existsSync(people)).toBe(true);
    renameSync(people, `${people}.away`);
    try {
      const alone = await opened("chat-old", { chat: chatRef(`whatsapp:${OLD}`) });
      expect(alone.lines.map((line: any) => line.ref)).toEqual([message("o1", OLD)]);
      expect(alone.lines[0]).toMatchObject({ text: "an old synthetic line about the ferry", day: new Date(T_OLD).toISOString().slice(0, 10) });
      const around = await opened("message-old", { ref: message("o1", OLD) });
      expect(around).toMatchObject({ what: "chat", around: message("o1", OLD) });
      expect(around.lines.map((line: any) => line.ref)).toContain(message("o1", OLD));
    } finally {
      renameSync(`${people}.away`, people);
    }
  });

  it("a count answers the contract; a row's ref opens in read as the facts a count of that group lists, its grouped total as the total", async () => {
    const byChat = await asked("/v1/count", "count-by-chat", { of: "messages", by: "chat" });
    expect(byChat.status, JSON.stringify(byChat.body)).toBe(200);
    expect(byChat.body.columns).toEqual(["chat", "n", "ref"]);
    const n = byChat.body.columns.indexOf("n");
    const rows = await Promise.all(byChat.body.rows.map(async (row: any[], at: number) => ({ row, opened: await opened(`count-row-${at}`, { ref: row.at(-1) }) })));
    for (const { row, opened: one } of rows) {
      expect(one).toMatchObject({ what: "row", ref: row.at(-1), n: row[n] });
      expect("now" in one).toBe(false);
      expect(one.rows).toHaveLength(row[n]);
    }
    const ada = rows.find(({ opened: one }) => one.rows.some((each: any[]) => each.at(-1) === message("m1")))!;
    const items = await asked("/v1/count", "count-chat-items", { of: "messages", by: "item", chat: chatRef(CHAT) });
    expect(ada.opened.rows.map((each: any[]) => each.at(-1)).sort()).toEqual(items.body.rows.map((each: any[]) => each.at(-1)).sort());
    const total = await opened("count-total", { ref: byChat.body.total.ref });
    expect(total).toMatchObject({ what: "row", n: byChat.body.total.n });
    expect(total.rows).toHaveLength(byChat.body.total.n);
  });

  it("one message is stated at one time by search, count and read: the one time rule", async () => {
    const found = await asked("/v1/search", "time-search", { lists: "record", query: "lighthouse" });
    const hit = found.body.record.hits.find((each: any) => each.ref === message("m1"));
    expect(hit, JSON.stringify(found.body)).toBeDefined();
    const items = await asked("/v1/count", "time-count", { of: "messages", by: "item", words: "lighthouse" });
    const item = items.body.rows.find((row: any[]) => row.at(-1) === message("m1"));
    const chat = await opened("time-read", { ref: message("m1") });
    const line = chat.lines.find((each: any) => each.ref === message("m1"));
    expect([item[items.body.columns.indexOf("time")], line.at]).toEqual([hit.at, hit.at]);
    expect(hit.at).toMatch(/T\d{2}:\d{2}(?::\d{2})?[+-]\d{2}:\d{2}$/u);
  });

  it("describes every kind of ref by a point read: its words, its day and time by the one rule, where a surface opens it; one no longer held gone", async () => {
    const found = await asked("/v1/search", "describe-search", { lists: "record", query: "lighthouse" });
    const hit = found.body.record.hits.find((each: any) => each.ref === message("m1"));
    const note = makeRef("record", { source: NOTES, kind: "note", key: "n1" });
    const picture = makeRef("picture", { image: `sha256:${photo}` });
    const turnRef = (await opened("describe-turns", { chat: chatRef(AI_CHAT) })).lines[0].ref;
    const lines = indexLines(root);
    const one = lines.find((line) => lines.filter((each) => each.day === line.day && each.same === line.same).length === 1 && line.unit.startsWith("calls/") === false)!;
    const line = lineRef(one, one.m);
    const people = await fetch(`http://127.0.0.1:${door.port}/v1/people/search?name=15550000142`, { headers: { authorization: `Bearer ${READER}` } });
    const person = ((await people.json()) as any).matches.find((each: any) => each.ref.startsWith("person."));
    const never = makeRef("record", { source: NOTES, kind: "note", key: "never-held" });
    const nowhere = makeRef("place", { id: "no-such-place" });
    const all = await described("describe-all", [message("m1"), note, turnRef, picture, line, person.ref, chatRef(CHAT), nowhere, never]);
    const [m1, n1, turned, pictured, lined, personed, chatted, place, gone] = all;
    expect(m1).toEqual({
      ref: message("m1"), kind: "message", day: hit.day, at: hit.at, title: expect.any(String), chat: hit.chat, chat_title: hit.chat_title,
      opens: { page: "days", day: hit.day, focus: `rec:${WHATSAPP} msg ${ADA}:m1` },
    });
    expect(n1).toMatchObject({ ref: note, kind: "record", title: expect.any(String), opens: { page: "days", focus: `rec:${NOTES} note n1` } });
    expect(turned).toMatchObject({ ref: turnRef, kind: "turn", chat: chatRef(AI_CHAT), opens: { page: "days" } });
    const printed = (day: string, source: string, kind: string, key: string): boolean => {
      const db = new Database(searchFileOf(root, process.env.LIFESTREAM_MACHINE_DIR!), { readonly: true, fileMustExist: true });
      try {
        return db.prepare("SELECT 1 FROM atoms WHERE day = ? AND source = ? AND kind = ? AND key = ?").get(day, source, kind, key) !== undefined;
      } finally {
        db.close();
      }
    };
    expect("focus" in m1.opens).toBe(printed(m1.day, WHATSAPP, "msg", `${ADA}:m1`));
    expect("focus" in n1.opens).toBe(printed(n1.day, NOTES, "note", "n1"));
    expect(pictured).toMatchObject({ ref: picture, kind: "photo", image: `sha256:${photo}`, opens: { page: "days" } });
    expect(lined).toMatchObject({ ref: line, kind: "line", day: one.day, opens: { page: "days", day: one.day, focus: expect.stringMatching(/^(?:rec:|u:)/u) } });
    const handle = (readRef(person.ref, "ref", ["person"]).parts as { handle: string }).handle;
    expect(personed).toEqual({ ref: person.ref, kind: "person", name: person.name, opens: { page: "people", id: handle } });
    const opensPeople = await fetch(`http://127.0.0.1:${door.port}/v1/people?id=${encodeURIComponent(handle)}`, { headers: { authorization: `Bearer ${READER}` } });
    expect(opensPeople.status).toBe(200);
    expect(chatted).toMatchObject({ ref: chatRef(CHAT), kind: "chat", name: expect.any(String) });
    expect([place, gone]).toEqual([{ ref: nowhere, kind: "gone", why: expect.any(String) }, { ref: never, kind: "gone", why: expect.stringContaining("no longer held") }]);
    expect(await described("describe-forged", ["record.e30", note])).toEqual([{ ref: "record.e30", kind: "gone", why: expect.stringContaining("not a ref") }, n1]);
    const large = Array.from({ length: 20 }, (_, n) => makeRef("record", { source: NOTES, kind: "note", key: `${String(n).padStart(2, "0")}${"k".repeat(500)}` }));
    for (const route of ["/v1/read", "/v1/describe"]) {
      const response = await fetch(`http://127.0.0.1:${door.port}${route}?${new URLSearchParams(large.map((ref): [string, string] => ["ref", ref]))}`, { headers: { authorization: `Bearer ${READER}` } });
      const body = await response.json() as { code: string; message: string };
      answers[`large refs ${route}`] = { status: response.status, body };
      expect([response.status, body.code, body.message], route).toEqual([422, "BAD_PARAMETER", expect.stringContaining("fewer at once")]);
    }
    kept = all;
  });

  it("a person no one is: PERSON_UNKNOWN from search and count alike, naming search_people", async () => {
    for (const [route, query] of [["/v1/search", { lists: "record", query: "lighthouse", person: "Nobody Example" }], ["/v1/count", { of: "messages", person: "Nobody Example" }]] as const) {
      const { status, body } = await asked(route, `nobody ${route}`, query);
      expect([status, body.code], route).toEqual([404, "PERSON_UNKNOWN"]);
      expect(body.message).toContain("search_people");
    }
  });

  it("describes a voice note the home holds with its `voice`, a message's and its line's alike, read again by the note's own record; a lost blob none, an erased note gone", async () => {
    const vox = "15550000145@s.whatsapp.net";
    const [heard, lost, own] = [AUDIO("whatsapp.ogg"), Buffer.concat([AUDIO("whatsapp.ogg"), Buffer.from("synthetic second note")]), AUDIO("iphone.m4a")];
    await send({
      source: WHATSAPP, fetched_ms: Date.now() + 10, carried: { [hex(heard)]: heard, [hex(lost)]: lost, [hex(own)]: own },
      rows: [voiceNote("v1", vox, T + 3 * HOUR, heard), voiceNote("v2", vox, T + 3 * HOUR + 60_000, lost), voiceNote("v3", vox, T + 3 * HOUR + 120_000, own, true)],
    });
    await until("the index caught up with the voice notes", () => caughtUp(root));
    openHomeFolder(root).blobs(join(root, "blobs")).remove(`sha256:${hex(lost)}`);
    const [v1, v2, v3] = [message("v1", vox), message("v2", vox), message("v3", vox)] as const;
    const atom = (() => {
      const db = new Database(searchFileOf(root, process.env.LIFESTREAM_MACHINE_DIR!), { readonly: true, fileMustExist: true });
      try {
        return db.prepare(`SELECT a.day, a.same, (SELECT count(*) FROM atoms b WHERE b.day = a.day AND b.same = a.same AND b.n < a.n) AS m, a.unit, a.item
          FROM atoms a WHERE a.source = ? AND a.kind = ? AND a.key = ? ORDER BY a.day, a.n LIMIT 1`).get(WHATSAPP, "msg", `${vox}:v1`) as { day: string; same: string; m: number; unit: string; item: string | null };
      } finally {
        db.close();
      }
    })();
    const line = lineRef(atom, atom.m);
    const spoken = (await opened("voice-chat", { ref: v1 })).lines.find((each: any) => each.ref === v1);
    expect(spoken.from).toEqual(expect.any(String));
    const [m1, lined, missing, mine] = await described("voice-describe", [v1, line, v2, v3]);
    const voice = { audio: `sha256:${hex(heard)}`, record: v1, seconds: 23, from: spoken.from };
    expect(m1).toMatchObject({ ref: v1, kind: "message", voice });
    expect(m1.voice).toEqual(voice);
    expect(lined).toMatchObject({ ref: line, kind: "line", day: atom.day, voice });
    expect(missing).toMatchObject({ ref: v2, kind: "message" });
    expect(missing.voice).toBeUndefined();
    const served = async (blob: string) => {
      const response = await fetch(`http://127.0.0.1:${door.port}/v1/blobs/${blob}`, { headers: { authorization: `Bearer ${READER}` } });
      await response.arrayBuffer();
      return response.status;
    };
    expect([await served(m1.voice.audio), await served(mine.voice.audio), await served(`sha256:${hex(lost)}`)]).toEqual([200, 200, 404]);
    expect(mine.voice).toEqual({ audio: `sha256:${hex(own)}`, record: v3, seconds: 23, mine: true });
    const [left, still] = await described("voice-line-left", [lineRef({ ...atom, same: "0000000000000000" }, 0), m1.voice.record]);
    expect(left).toMatchObject({ kind: "gone", why: expect.stringContaining("no longer in its day") });
    expect(still).toEqual(m1);
    await send({ source: WHATSAPP, fetched_ms: Date.now() + 20, rows: [{ kind: "msg", key: `${vox}:v1`, content: null, gone: true }] });
    await until("the index caught up with the erasure", () => caughtUp(root));
    expect(await described("voice-erased", [m1.voice.record])).toEqual([{ ref: v1, kind: "gone", why: expect.stringContaining("no longer held") }]);
  });

  it("a call-only caller with a caller-ID name is found in People with their phone number, and reading the call through a model turn still returns the phone number", async () => {
    const phone = "+15550000199";
    const handle = { ZTYPE: 2, ZNORMALIZEDVALUE: phone, ZVALUE: phone };
    await send({
      source: CALLS, fetched_ms: Date.now() + 25,
      rows: [{
        kind: "call", key: "call-only-1", at: T + 4 * HOUR,
        content: {
          type: "apple.call", initiator: handle, handles: [handle], emergency_media: [],
          call: { ZUNIQUE_ID: "call-only-1", ZDATE: (T + 4 * HOUR) / 1000 - APPLE_EPOCH_S, ZDURATION: 300, ZORIGINATED: 0, ZANSWERED: 1, ZSERVICE_PROVIDER: "com.apple.Telephony", ZCALL_CATEGORY: 1, ZNAME: "Nikhil Caller" },
        },
      }],
    });
    await until("the index caught up with the call", () => caughtUp(root));
    const asking = await fetch(`http://127.0.0.1:${door.port}/v1/ask`, {
      method: "POST", signal: leaving.signal, headers: { authorization: `Bearer ${READER}`, "content-type": "application/json" },
      body: JSON.stringify({ question: "Synthetic call?", chat: "1790000000000-call", level: "none" }),
    });
    expect(asking.status).toBe(200);
    const turn = turnPasses.at(-1)!;
    const asTurn = async (route: RoutePath, args: Record<string, string | readonly string[]>) => {
      const response = await fetch(`http://127.0.0.1:${door.port}${route}`, {
        method: "POST", headers: { authorization: `Bearer ${turn}`, "content-type": "application/json" }, body: JSON.stringify({ args, to: FAKE_ROUTE, shown: [] }),
      });
      const body = await response.json() as any;
      answerOf(route, response.status, body);
      expect(response.status, JSON.stringify(body)).toBe(200);
      return body;
    };
    const people = await asTurn("/v1/people/search", { name: "Nikhil" });
    expect(people.matches).toHaveLength(1);
    expect(people.matches[0]).toMatchObject({ handles: [phone], reach: { calls: [1, expect.any(String), expect.any(String)] } });
    const found = await asTurn("/v1/search", { lists: ["record"], query: "Nikhil" });
    const hit = found.record.hits.find((each: any) => each.family === "calls");
    expect(hit, JSON.stringify(found)).toBeDefined();
    const record = await asTurn("/v1/read", { ref: hit.ref });
    expect(record).toMatchObject({ what: "record", family: "calls", from: "Nikhil Caller", text: `Phone call with ${phone}, they called, 5 min` });
  });

  it("answers each contract route NOT_NOW while the index's writer holds it, as the contract holds; what describe gave is drawn whole without the home", async () => {
    const lines = indexLines(root);
    const line = lineRef(lines[0]!, lines[0]!.m);
    await home.stop();
    expect(kept.length).toBeGreaterThan(0);
    for (const each of kept) {
      expect(citation.parse(each)).toEqual(each);
      if (each.kind !== "gone") expect(each.opens).toBeDefined();
    }
    const held = new Database(searchFileOf(root, process.env.LIFESTREAM_MACHINE_DIR!), { fileMustExist: true, timeout: 0 });
    try {
      held.pragma("locking_mode = EXCLUSIVE");
      expect(held.pragma("journal_mode = MEMORY", { simple: true })).toBe("memory");
      held.exec("UPDATE meta SET value = value WHERE key = 'position'");
      const asked = async (path: string) => {
        const response = await fetch(`http://127.0.0.1:${door.port}${path}`, { headers: { authorization: `Bearer ${READER}` } });
        const body = await response.json() as { code?: string };
        answers[`busy ${path}`] = { status: response.status, body };
        return { status: response.status, body };
      };
      const day = new Date(T).toISOString().slice(0, 10);
      const routes = [
        ["/v1/search", "/v1/search?lists=record&query=lighthouse"], ["/v1/count", "/v1/count?of=messages"],
        ["/v1/people/search", "/v1/people/search?name=15550000142"], ["/v1/read", `/v1/read?from=${day}`], ["/v1/describe", `/v1/describe?ref=${encodeURIComponent(line)}`],
        ["/v1/describe", `/v1/describe?ref=${encodeURIComponent(makeRef("record", { source: NOTES, kind: "note", key: "n1" }))}`],
      ] as const;
      const results = await Promise.all(routes.map(async ([route, path]) => ({ route, path, ...await asked(path) })));
      for (const { route, path, status, body } of results) {
        expect([status, body.code], path).toEqual([503, "NOT_NOW"]);
        expect(answerOf(route, status, body), path).toMatchObject({ code: "NOT_NOW" });
      }
    } finally {
      held.close();
    }
  });
});
