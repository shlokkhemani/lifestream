import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, onTestFinished } from "vitest";
import { openHome, openHomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import { DEVICES } from "./devices.js";
import type { Door } from "./door.js";
import type { MacCommand, MacPeerListing } from "./mac-peers.js";
import { mintPrincipal, revokePrincipal } from "./principals.js";
import { ask as askHome } from "./socket.js";
import { openDoor } from "./test/harness-door.js";
import { startHere } from "./test/harness-home.js";
import { artifact, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { testSocket } from "./test/folder.js";
import { acquisitionBundle, DEVICE } from "./test/support.js";

const MAC_UNIT = "macbook-pro-0001";
const MACHINE = `machine:local:${MAC_UNIT}`;
const MAC = "synthetic-token-mac".padEnd(43, "m");
const MAC_AGAIN = "synthetic-token-mac-again".padEnd(43, "m");
const READER = "synthetic-token-reader".padEnd(43, "r");
const DRIVE = "synthetic-token-drive".padEnd(43, "d");

type Barrier = { ask_barrier: string; barrier_ms: number };

async function askStandIn(): Promise<{ url: string; asked: () => number }> {
  let asked = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      asked++;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ answered: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked: () => asked };
}

function machineBundle(seal: number, at_ms: number) {
  const line = `{"at":"${new Date(at_ms).toISOString()}","event":"sleep","detail":{"seal":${seal}}}\n`;
  return acquisitionBundle({ source: MACHINE, fetched_ms: at_ms, files: [[`${new Date(at_ms).toISOString()}.jsonl`, Buffer.from(line)]], custody: { [MACHINE]: { seal } } });
}

async function ship(url: string, token: string, seal: number): Promise<void> {
  const bundle = machineBundle(seal, Date.now() - 60_000);
  const shipped = await fetch(`${url}${bundle.path}`, { method: "PUT", headers: { authorization: `Bearer ${token}`, ...DEVICE.mac }, body: bundle.bytes });
  expect(shipped.status).toBe(201);
}

describe("the Ask turn's flush barrier", () => {
  it("waits for nothing with no Mac, flushes a present Mac, waits until its sealed bundle is readable past a future dirty day, gives up at its budget, skips a Mac that let it, and rests for its cooldown", async () => {
    const root = makeRoot("lifestream-ask-barrier-", { sources: {} });
    onTestFinished(() => removeRoot(root));
    const passes = openHomeFolder(root);
    mintPrincipal(passes, { unit: "reader", scopes: ["read"], sources: [], token: READER, now_ms: 0 });
    mintPrincipal(passes, { unit: "test-drive", scopes: ["drive"], sources: [], token: DRIVE, now_ms: 0 });
    mintPrincipal(passes, { unit: MAC_UNIT, kind: "mac", scopes: [...DEVICES.mac.scopes], sources: [MACHINE], token: MAC, now_ms: 0 });
    const ahead = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const marked = openHome(passes, "write");
    marked.commit((tx) => tx.tables.dirty.days([ahead]));
    marked.close();
    await startHere(root, { tickMs: TICK_MS, slot: null, log: () => undefined });
    const ask = await askStandIn();
    const report: Record<string, unknown> = {};

    let opened = await openDoor(root, { ask: ask.url, askBarrierMs: { lan: 30_000, wan: 30_000 }, askBarrierCooldownMs: 0 });
    let url = opened.url;
    let door: Door = opened.door;
    const barriers = (): Barrier[] => opened.logs.map((line) => JSON.parse(line) as Partial<Barrier>).filter((line): line is Barrier => typeof line.ask_barrier === "string");
    const askTurn = async (): Promise<Barrier> => {
      const before = barriers().length;
      const answered = await fetch(`${url}/v1/ask`, { method: "POST", headers: { authorization: `Bearer ${READER}`, "content-type": "application/json" }, body: "{}" });
      expect(answered.status).toBe(200);
      expect(await answered.json()).toEqual({ answered: true });
      await until("the ask's line is logged", () => barriers().length > before);
      return barriers().at(-1)!;
    };
    const macExchange = async (body: Record<string, unknown> = {}): Promise<{ hand: number; calls: MacCommand[] }> => {
      const answered = await fetch(`${url}/v1/mac/exchange`, {
        method: "POST", headers: { authorization: `Bearer ${MAC}`, ...DEVICE.mac, "content-type": "application/json" }, body: JSON.stringify({ boot: "boot-a", sources: [MACHINE], ...body }),
      });
      expect(answered.status).toBe(200);
      return JSON.parse((await answered.text()).trim()) as { hand: number; calls: MacCommand[] };
    };
    const listing = async (): Promise<MacPeerListing[]> => {
      const answered = await fetch(`${url}/v1/mac`, { headers: { authorization: `Bearer ${DRIVE}` } });
      expect(answered.status).toBe(200);
      return ((await answered.json()) as { macs: MacPeerListing[] }).macs;
    };
    const macWaits = () => until("the Mac waits on its exchange", async () => (await listing()).some((mac) => mac.waiting));

    const offline = await askTurn();
    expect(offline).toMatchObject({ ask_barrier: "skipped_offline", barrier_ms: 0 });
    report.offline = offline;

    let polling = macExchange();
    await macWaits();
    const clean = askTurn();
    const flushed = await polling;
    expect(flushed.calls).toEqual([expect.objectContaining({ kind: "flush", budget_ms: 30_000 })]);
    polling = macExchange({ results: [{ id: flushed.calls[0]!.id, ok: true }] });
    expect((await clean).ask_barrier).toBe("clean");
    report.clean = barriers().at(-1);

    await macWaits();
    const settling = askTurn();
    const sealing = await polling;
    expect(sealing.calls.map((call) => call.kind)).toEqual(["flush"]);
    await ship(url, MAC, 1);
    polling = macExchange({ results: [{ id: sealing.calls[0]!.id, ok: true, seals: { [MACHINE]: 1 } }] });
    const settled = await settling;
    expect(settled.ask_barrier).toBe("settled");
    const after = readHome(root, (db) => ({
      deliveries: db.prepare("SELECT state FROM deliveries WHERE source = ?").pluck().all(MACHINE),
      busy: db.prepare("SELECT kind || ':' || key FROM jobs WHERE state = 'running' AND kind IN ('import', 'extract', 'index', 'render') ORDER BY 1").pluck().all(),
      ahead: db.prepare("SELECT day FROM dirty_days WHERE day = ?").pluck().all(ahead),
    }));
    expect(after).toEqual({ deliveries: ["imported"], busy: [], ahead: [ahead] });
    report.settled = { barrier: settled, home: after };

    await door.close();
    expect((await polling).calls).toEqual([]);
    opened = await openDoor(root, { ask: ask.url, askBarrierMs: { lan: 50, wan: 50 }, askBarrierCooldownMs: 600_000 });
    url = opened.url;
    door = opened.door;
    polling = macExchange();
    await macWaits();
    const late = askTurn();
    const unanswered = await polling;
    expect(unanswered.calls.map((call) => call.kind)).toEqual(["flush"]);
    expect((await late).ask_barrier).toBe("timeout");
    report.timeout = barriers().at(-1);
    expect((await listing()).map((mac) => [mac.unit, mac.present])).toEqual([[MAC_UNIT, false]]);
    const unresponsive = await askTurn();
    expect(unresponsive).toMatchObject({ ask_barrier: "skipped_offline", barrier_ms: 0 });
    report.unresponsive = unresponsive;

    polling = macExchange({ results: [{ id: unanswered.calls[0]!.id, ok: true }] });
    await macWaits();
    const rested = await askTurn();
    expect(rested).toMatchObject({ ask_barrier: "clean", barrier_ms: 0 });
    report.cooldown = rested;

    expect(await macExchange({ sleep: true })).toEqual({ hand: 0, calls: [] });
    expect((await polling).calls).toEqual([]);
    expect((await listing()).map((mac) => [mac.unit, mac.present])).toEqual([[MAC_UNIT, false]]);
    const asleep = await askTurn();
    expect(asleep).toMatchObject({ ask_barrier: "skipped_offline", barrier_ms: 0 });
    report.asleep = asleep;
    expect(ask.asked()).toBe(7);
    artifact(root, "ask-barrier", report);
  });

  it("waits for the new pass's seal after the Mac pairs again, never the revoked pass's delivery of the same seal", async () => {
    const root = makeRoot("lifestream-ask-repair-", { sources: {} });
    onTestFinished(() => removeRoot(root));
    const passes = openHomeFolder(root);
    const { principal: first } = mintPrincipal(passes, { unit: MAC_UNIT, kind: "mac", scopes: [...DEVICES.mac.scopes], sources: [MACHINE], token: MAC, now_ms: 0 });
    await startHere(root, { tickMs: TICK_MS, slot: null, log: () => undefined });
    const states = (pass: string): string[] => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE pass = ? AND source = ? ORDER BY seal").pluck().all(pass, MACHINE) as string[]);
    const readable = async (asked: JsonObject): Promise<{ state: string }> => await askHome(testSocket(root), { verb: "wait_readable", seals: { [MACHINE]: 1 }, ...asked }) as { state: string };

    const paired = await openDoor(root);
    await ship(paired.url, MAC, 1);
    await until("the first pass's seal 1 is imported", () => states(first.id).join() === "imported");
    await paired.door.close();

    revokePrincipal(passes, first.id, 1_000);
    const { principal: second } = mintPrincipal(passes, { unit: MAC_UNIT, kind: "mac", scopes: [...DEVICES.mac.scopes], sources: [MACHINE], token: MAC_AGAIN, now_ms: 2_000 });
    const unshipped = {
      named: (await readable({ passes: { [MACHINE]: second.id }, budget_ms: 200 })).state,
      unnamed: (await readable({ budget_ms: 200 })).state,
    };
    expect(unshipped).toEqual({ named: "timeout", unnamed: "timeout" });

    const again = await openDoor(root);
    await ship(again.url, MAC_AGAIN, 1);
    const settled = (await readable({ passes: { [MACHINE]: second.id }, budget_ms: 20_000 })).state;
    expect(settled).toBe("settled");
    const delivered = { first: states(first.id), second: states(second.id) };
    expect(delivered).toEqual({ first: ["imported"], second: ["imported"] });
    artifact(root, "ask-barrier-repair", { unshipped, settled, delivered });
  });
});
