import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, onTestFinished } from "vitest";
import { MAC_EXCHANGE, MAC_PEERS, openMacPeers, type MacCommand, type MacPeers } from "./mac-peers.js";
import { Refusal } from "./refusal.js";
import { until } from "./test/harness-root.js";

const MAC_A = "macbook-pro-0001";
const MAC_B = "macbook-pro-0002";
const passOf = (unit: string): string => `pass-${unit}`;

interface Answer {
  readonly status: number;
  readonly body: { hand?: number; calls?: MacCommand[]; code?: string; macs?: { unit: string; present: boolean; waiting: boolean; sources: string[] }[] };
}

async function served(macs: MacPeers): Promise<{ exchange(unit: string, body: unknown, signal?: AbortSignal): Promise<Answer>; listing(): Promise<Answer> }> {
  const server: Server = createServer((request, response) => {
    const unit = request.headers["x-unit"];
    const caller = typeof unit === "string" ? { peer: unit, pass: passOf(unit) } : { drive: true as const };
    macs.serve(caller, request, response).catch((error: unknown) => {
      if (!(error instanceof Refusal)) throw error;
      response.writeHead(error.status, { "content-type": "application/json" }).end(JSON.stringify({ code: error.code }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => {
    macs.close();
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const read = async (answered: Response): Promise<Answer> => ({ status: answered.status, body: JSON.parse((await answered.text()).trim()) as Answer["body"] });
  return {
    exchange: async (unit, body, signal) => read(await fetch(`${url}${MAC_EXCHANGE}`, { method: "POST", headers: { "x-unit": unit, "content-type": "application/json" }, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) })),
    listing: async () => read(await fetch(`${url}${MAC_PEERS}`)),
  };
}

const stated = (boot = "boot-a", extra: object = {}) => ({ boot, sources: ["whatsapp", "imessage"], ...extra });

async function waitingNow(macs: MacPeers, unit: string): Promise<void> {
  await until(`${unit} waits on its exchange`, () => macs.listing().some((mac) => mac.unit === unit && mac.waiting));
}

describe("the mac exchange", () => {
  it("answers only the two routes it serves", () => {
    const macs = openMacPeers();
    onTestFinished(() => macs.close());
    expect(macs.half("POST", MAC_EXCHANGE)).toBe("peer");
    expect(macs.half("GET", MAC_PEERS)).toBe("drive");
    expect(macs.half("GET", MAC_EXCHANGE)).toBeNull();
    expect(macs.half("POST", MAC_PEERS)).toBeNull();
  });

  it("refuses an exchange with no boot, no sources, or a result whose seals are no positive whole numbers", async () => {
    const macs = openMacPeers();
    const door = await served(macs);
    for (const body of [
      { sources: [] }, { boot: "", sources: [] }, { boot: "boot-a" }, { boot: "boot-a", sources: "whatsapp" }, { boot: "boot-a", sources: [], running: [1] },
      { boot: "boot-a", sources: [], results: [{ id: "m-1", ok: true, seals: { whatsapp: 0 } }] },
      { boot: "boot-a", sources: [], results: [{ id: "m-1", ok: true, seals: { whatsapp: 1.5 } }] },
      { boot: "boot-a", sources: [], results: [{ id: "m-1", ok: false }] },
      { boot: "boot-a", sources: [], sleep: "yes" },
    ]) {
      const answered = await door.exchange(MAC_A, body);
      expect([answered.status, answered.body.code], JSON.stringify(body)).toEqual([400, "BAD_CALL"]);
    }
    expect(macs.present()).toBe(false);
  });

  it("hands a settings call to the waiting exchange at once, queues one more while the first is handed however often it is asked, and to no mac that asked it", async () => {
    const macs = openMacPeers();
    const door = await served(macs);
    const a = door.exchange(MAC_A, stated());
    const b = door.exchange(MAC_B, stated());
    await waitingNow(macs, MAC_A);
    await waitingNow(macs, MAC_B);
    expect(macs.notifySettings(MAC_B)).toBe(1);
    const handed = await a;
    expect(handed.status).toBe(200);
    expect(handed.body.calls?.map((call) => call.kind)).toEqual(["settings"]);
    expect(macs.notifySettings(MAC_B)).toBe(1);
    expect(macs.notifySettings(MAC_B)).toBe(1);
    const next = await door.exchange(MAC_A, stated("boot-a", { running: [handedFirst(handed)] }));
    expect(next.body.calls).toEqual([expect.objectContaining({ kind: "settings" })]);
    expect(handedFirst(next)).not.toBe(handedFirst(handed));
    const again = door.exchange(MAC_A, stated("boot-a", { results: [handed, next].map((answer) => ({ id: handedFirst(answer), ok: true })) }));
    await waitingNow(macs, MAC_A);
    expect(macs.listing().map((mac) => mac.unit)).toEqual([MAC_A, MAC_B]);
    macs.close();
    expect((await again).body.calls).toEqual([]);
    expect((await b).body.calls).toEqual([]);
  });

  it("hands a refresh once per connector while it waits to be handed, again once the first is handed, and leaves out the mac that asked", async () => {
    const macs = openMacPeers();
    const door = await served(macs);
    await door.exchange(MAC_B, stated("boot-b", { sleep: true }));
    expect(macs.notifyRefresh("whatsapp")).toBe(0);
    const waiting = door.exchange(MAC_A, stated());
    await waitingNow(macs, MAC_A);
    expect(macs.notifyRefresh("whatsapp", MAC_A)).toBe(0);
    expect(macs.notifyRefresh("whatsapp")).toBe(1);
    const first = await waiting;
    const refreshes = (answer: Answer) => answer.body.calls?.map((call) => [call.kind, call.kind === "refresh" ? call.connector : null]);
    expect(refreshes(first)).toEqual([["refresh", "whatsapp"]]);
    expect(macs.notifyRefresh("whatsapp")).toBe(1);
    expect(macs.notifyRefresh("whatsapp")).toBe(1);
    expect(macs.notifyRefresh("imessage")).toBe(1);
    const second = await door.exchange(MAC_A, stated("boot-a", { running: [handedFirst(first)] }));
    expect(refreshes(second)).toEqual([["refresh", "whatsapp"], ["refresh", "imessage"]]);
    const ids = [first, second].flatMap((answer) => answer.body.calls!.map((call) => call.id));
    const settled = await door.exchange(MAC_A, stated("boot-a", { results: ids.map((id) => ({ id, ok: true })), sleep: true }));
    expect(settled.body).toEqual({ hand: 0, calls: [] });
  });

  it("marks a sleeping mac absent at once: its pending calls end, a flush skips it, and its next exchange wakes it", async () => {
    const macs = openMacPeers();
    const door = await served(macs);
    const waiting = door.exchange(MAC_A, stated());
    await waitingNow(macs, MAC_A);
    expect(macs.present()).toBe(true);
    const flushing = macs.flush({ budget_ms: 30_000 });
    const handed = await waiting;
    expect(handed.body.calls).toEqual([expect.objectContaining({ kind: "flush", budget_ms: 30_000 })]);
    expect(handed.body.calls![0]).not.toHaveProperty("sources");
    const slept = await door.exchange(MAC_A, stated("boot-a", { sleep: true, running: [handed.body.calls![0]!.id] }));
    expect(slept.body).toEqual({ hand: 0, calls: [] });
    expect(await flushing).toMatchObject({ state: "clean", seals: {} });
    expect(macs.present()).toBe(false);
    expect(macs.listing()).toEqual([expect.objectContaining({ unit: MAC_A, present: false, waiting: false })]);
    expect(await macs.flush({ budget_ms: 30_000 })).toEqual({ state: "skipped_offline", seals: {}, passes: {}, elapsed_ms: 0 });
    const woke = door.exchange(MAC_A, stated());
    await waitingNow(macs, MAC_A);
    expect(macs.present()).toBe(true);
    macs.close();
    expect((await woke).body.calls).toEqual([]);
  });

  it("merges the seals of every mac's flush, keeping each source's highest and the pass that sealed it", async () => {
    const macs = openMacPeers();
    const door = await served(macs);
    const a = door.exchange(MAC_A, stated());
    const b = door.exchange(MAC_B, stated("boot-b"));
    await waitingNow(macs, MAC_A);
    await waitingNow(macs, MAC_B);
    const flushing = macs.flush({ sources: ["whatsapp"], budget_ms: 30_000 });
    const [handedA, handedB] = await Promise.all([a, b]);
    expect(handedA.body.calls).toEqual([expect.objectContaining({ kind: "flush", sources: ["whatsapp"] })]);
    await door.exchange(MAC_A, stated("boot-a", { results: [{ id: handedA.body.calls![0]!.id, ok: true, seals: { whatsapp: 4, imessage: 9 } }], sleep: true }));
    await door.exchange(MAC_B, stated("boot-b", { results: [{ id: handedB.body.calls![0]!.id, ok: true, seals: { whatsapp: 7 } }], sleep: true }));
    expect(await flushing).toEqual({ state: "flushed", seals: { whatsapp: 7, imessage: 9 }, passes: { whatsapp: passOf(MAC_B), imessage: passOf(MAC_A) }, elapsed_ms: expect.any(Number) });
  });

  it("counts a mac's failed flush as settled, and a flush whose budget ends first as timed out with nothing left pending", async () => {
    const macs = openMacPeers();
    const door = await served(macs);
    const waiting = door.exchange(MAC_A, stated());
    await waitingNow(macs, MAC_A);
    const failing = macs.flush({ budget_ms: 30_000 });
    const handed = await waiting;
    const answered = door.exchange(MAC_A, stated("boot-a", { results: [{ id: handedFirst(handed), ok: false, error: { code: "FAILED", message: "a synthetic failure" } }] }));
    expect(await failing).toMatchObject({ state: "clean", seals: {} });
    await waitingNow(macs, MAC_A);
    const late = await macs.flush({ budget_ms: 1 });
    expect(late.state).toBe("timeout");
    const handedLate = await answered;
    expect(handedLate.body.calls).toEqual([expect.objectContaining({ kind: "flush" })]);
    const after = door.exchange(MAC_A, stated("boot-a", { results: [{ id: handedFirst(handedLate), ok: true, seals: { whatsapp: 3 } }] }));
    await waitingNow(macs, MAC_A);
    macs.close();
    expect((await after).body.calls).toEqual([]);
  });

  it("marks a mac that let a flush run past its budget absent until its next exchange", async () => {
    const macs = openMacPeers();
    const door = await served(macs);
    const waiting = door.exchange(MAC_A, stated());
    await waitingNow(macs, MAC_A);
    const late = await macs.flush({ budget_ms: 1 });
    expect(late).toMatchObject({ state: "timeout", seals: {} });
    const handed = await waiting;
    expect(handed.body.calls).toEqual([expect.objectContaining({ kind: "flush" })]);
    expect(macs.present()).toBe(false);
    expect(macs.listing()).toEqual([expect.objectContaining({ unit: MAC_A, present: false, waiting: false })]);
    expect(await macs.flush({ budget_ms: 30_000 })).toEqual({ state: "skipped_offline", seals: {}, passes: {}, elapsed_ms: 0 });
    expect(macs.notifySettings()).toBe(0);
    const back = door.exchange(MAC_A, stated("boot-a", { results: [{ id: handedFirst(handed), ok: true, seals: { whatsapp: 2 } }] }));
    await waitingNow(macs, MAC_A);
    expect(macs.present()).toBe(true);
    expect(macs.notifySettings()).toBe(1);
    expect((await back).body.calls?.map((call) => call.kind)).toEqual(["settings"]);
  });

  it("ends a flush at once when its signal aborts", async () => {
    const macs = openMacPeers();
    const door = await served(macs);
    const waiting = door.exchange(MAC_A, stated());
    await waitingNow(macs, MAC_A);
    const stop = new AbortController();
    const flushing = macs.flush({ budget_ms: 30_000, signal: stop.signal });
    await waiting;
    stop.abort();
    expect((await flushing).state).toBe("timeout");
  });

  it("stops counting an exchange as waiting the moment its connection closes", async () => {
    const macs = openMacPeers();
    const door = await served(macs);
    const cut = new AbortController();
    const waiting = door.exchange(MAC_A, stated(), cut.signal).catch((error: unknown) => error);
    await waitingNow(macs, MAC_A);
    cut.abort();
    await waiting;
    await until("the cut exchange no longer waits", () => !macs.listing()[0]!.waiting);
    expect(macs.notifySettings()).toBe(1);
    const next = await door.exchange(MAC_A, stated());
    expect(next.body.calls?.map((call) => call.kind)).toEqual(["settings"]);
  });

  it("lists the macs it heard, sorted by unit, on its drive route", async () => {
    const macs = openMacPeers();
    const door = await served(macs);
    await door.exchange(MAC_B, stated("boot-b", { sleep: true }));
    await door.exchange(MAC_A, stated("boot-a", { sleep: true }));
    const listed = await door.listing();
    expect(listed.status).toBe(200);
    expect(listed.body.macs?.map((mac) => [mac.unit, mac.present, mac.waiting, mac.sources])).toEqual([
      [MAC_A, false, false, ["imessage", "whatsapp"]], [MAC_B, false, false, ["imessage", "whatsapp"]],
    ]);
  });
});

function handedFirst(answer: Answer): string {
  return answer.body.calls![0]!.id;
}
