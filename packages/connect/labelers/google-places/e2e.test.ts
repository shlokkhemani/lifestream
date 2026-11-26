import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SecretError, type Delivery, type JsonObject } from "@lifestreamprotocol/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { googlePlaceNames } from "../../places/reader.js";
import { LabelerUnavailable, type LabelOutput } from "../../labeler.js";
import { Refused } from "../../shared/index.js";
import { artifact, collect, deliver, fetchedBytes, memorySecrets, openTestHome, type TestHome } from "../../test/drive.js";
import { ANSWERS_FILE, answerKey, googlePlacesConnector } from "./reader.js";
import { googlePlacesLabeler, PER_DAY, PER_RUN, type Lookup, type Owed } from "./labeler.js";

const UNIT = "macbook-pro-0001";
const SOURCE = `google-places:${UNIT}:nearby`;
const ACCOUNT = "person-a@example.com";
const LOOKUP = `google-maps:${ACCOUNT}:lookup`;
const KEY = "synthetic-google-key-0001";
const NOW = Date.parse("2026-10-20T12:00:00Z");
const DAY = 86_400_000;
const CAFE = { latitude: 48.85661, longitude: 2.35222 };
const ROAD = { latitude: 48.72333, longitude: 2.37944 };

interface Asked {
  method: string;
  path: string;
  fields: string | undefined;
  key: string | undefined;
  body?: JsonObject;
}

const place = (id: string, name: string, at: { latitude: number; longitude: number }, types: string[]) =>
  ({ id, displayName: { text: name, languageCode: "en" }, location: { ...at }, types, primaryType: types[0] });

class FakeGoogle {
  readonly asked: Asked[] = [];
  refusingFrom = Infinity;
  refusing = 403;
  #server!: Server;
  url = "";

  async start(): Promise<void> {
    this.#server = createServer((request, response) => {
      let text = "";
      request.on("data", (chunk: Buffer) => (text += chunk.toString()));
      request.on("end", () => {
        const body = text === "" ? undefined : JSON.parse(text) as JsonObject;
        this.asked.push({ method: request.method!, path: request.url!, fields: request.headers["x-goog-fieldmask"] as string | undefined, key: request.headers["x-goog-api-key"] as string | undefined, ...(body === undefined ? {} : { body }) });
        const send = (status: number, value: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(value));
        };
        if (this.asked.length > this.refusingFrom) {
          return this.refusing === 403 ? send(403, { error: { code: 403, message: `API key not valid: ${request.headers["x-goog-api-key"]}`, status: "PERMISSION_DENIED" } })
            : send(this.refusing, { error: { code: this.refusing, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } });
        }
        if (request.url!.startsWith("/v1/places/")) {
          const id = decodeURIComponent(request.url!.slice("/v1/places/".length));
          return id === "ChIJknown01" ? send(200, { id, displayName: { text: "Synthetic Viewpoint", languageCode: "en" }, location: { latitude: 48.8, longitude: 2.3 } })
            : send(404, { error: { code: 404, message: "Not found", status: "NOT_FOUND" } });
        }
        const centre = (body!.locationRestriction as { circle: { center: { latitude: number } } }).circle.center;
        const near = Math.abs(centre.latitude - ROAD.latitude) < 0.001;
        if (Array.isArray(body!.includedPrimaryTypes)) {
          return send(200, (body!.includedPrimaryTypes as string[]).includes("airport") ? { places: [place("ChIJairport1", "Northfield International Airport", { latitude: 48.7262, longitude: 2.3652 }, ["international_airport", "airport"])] } : {});
        }
        if (Array.isArray(body!.includedTypes)) return send(200, near ? {} : { places: [place("ChIJmall0001", "Grand Arcade", { latitude: 48.8575, longitude: 2.3535 }, ["shopping_mall"])] });
        send(200, near
          ? { places: [place("ChIJterm0002", "Terminal 2 Departures", { latitude: 48.7234, longitude: 2.3797 }, ["establishment"])] }
          : { places: [place("ChIJcafe0001", "Harbour Cafe", { latitude: 48.8567, longitude: 2.3523 }, ["cafe"])] });
      });
    });
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  since(from: number): string[] {
    return this.asked.slice(from).map((asked) => {
      if (asked.path.startsWith("/v1/places/")) return `name ${decodeURIComponent(asked.path.slice("/v1/places/".length))}`;
      const body = asked.body!;
      const { center, radius } = (body.locationRestriction as { circle: { center: { latitude: number; longitude: number }; radius: number } }).circle;
      const what = Array.isArray(body.includedPrimaryTypes) ? (body.includedPrimaryTypes as string[]).includes("airport") ? "airport" : "beach" : Array.isArray(body.includedTypes) ? "venues" : "nearby";
      return `${what} ${center.latitude},${center.longitude} ${radius}`;
    });
  }
}

const google = new FakeGoogle();
const record: Record<string, string[]> = {};

beforeAll(() => google.start());
afterAll(() => google.stop());

async function bench(owed: Owed, options: { now?: number; key?: string | null; locked?: boolean; lookup?: boolean; unwritten?: boolean; spent?: number } = {}) {
  const home = openTestHome("google-places-");
  const owing = { now: owed };
  const stated: { sent: Lookup; sent_before: number }[] = [];
  const clock = { now: options.now ?? NOW };
  const looked: number[] = Array.from({ length: options.spent ?? 0 }, () => clock.now);
  const lookup = (sent: Lookup) => {
    if (options.unwritten === true) throw new Error("the ledger cannot be written");
    stated.push({ sent, sent_before: google.asked.length });
    looked.push(clock.now);
  };
  const made = () => googlePlacesLabeler({ unit: UNIT, key: "google-places", owed: () => owing.now, hints: (names) => names.some((name) => /terminal|airport/iu.test(name)) ? ["airport"] : [], lookup, looked: (since_ms) => looked.filter((at) => at >= since_ms).length, endpoint: google.url, now: () => clock.now });
  let labeler = made();
  if (options.lookup !== false) {
    await home.land(googlePlaceNames, deliver(home, LOOKUP, { "statements.ndjson": Buffer.from(`${JSON.stringify({ kind: "place", key: "google:ChIJother9", content: { type: "google.place", id: "ChIJother9", name: "Another Place", centre: { latitude: 1, longitude: 1 } } })}\n`) }, {}, NOW - DAY));
  }
  const secrets = options.locked === true
    ? { get: () => { throw new SecretError("Passwords are locked on this Mac", "locked"); }, rotate: () => undefined }
    : memorySecrets(options.key === null ? {} : { "google-places": options.key ?? KEY });
  return {
    home,
    stated,
    seal(value: string) {
      secrets.rotate?.("google-places", value);
    },
    at(now: number) {
      clock.now = now;
    },
    restart() {
      labeler = made();
    },
    owe(next: Owed) {
      owing.now = next;
    },
    async run(): Promise<{ output: LabelOutput | null; asked: string[] }> {
      const from = google.asked.length;
      const view = home.db.view();
      let pending: Promise<LabelOutput | null>;
      try {
        pending = labeler.label(view, home.blobs, { seq: 0, reread: 0 }, undefined, secrets);
      } finally {
        view.close();
      }
      const output = await pending;
      if (output !== null) await landed(home, output);
      return { output, asked: google.since(from) };
    },
  };
}

let sealed = 0;
async function landed(home: TestHome, output: LabelOutput): Promise<void> {
  const files = Object.fromEntries(output.files.map((file) => [file.path, fetchedBytes(file)]));
  const stated = (output.facts.sources as { id: string; connector: string }[]).map((source) => source.id);
  const at = NOW + ++sealed;
  await home.land(googlePlacesConnector, deliver(home, SOURCE, files, output.facts, at));
  if (stated.includes(LOOKUP)) await home.land(googlePlaceNames, deliver(home, LOOKUP, files, { ...output.facts }, at));
}

function answers(home: TestHome): Record<string, { at: number | null; names: string[] }> {
  return Object.fromEntries(home.heads(SOURCE, ["answer"]).map((head) => [head.key, {
    at: head.start_ms, names: ((head.content as { places?: { displayName: { text: string } }[] }).places ?? []).map((each) => each.displayName.text),
  }]));
}

describe("the google-places labeler", () => {
  it("G1, G4, G5: it asks Google only about what the home owes a name, its hints after, and lands each answer as Google gave it", async () => {
    const b = await bench({ spots: [CAFE, ROAD], ids: [] });
    const { output, asked } = await b.run();
    record.owed = asked;
    expect(asked).toEqual([
      "nearby 48.85661,2.35222 150", "venues 48.85661,2.35222 300",
      "nearby 48.72333,2.37944 150", "venues 48.72333,2.37944 300", "airport 48.72333,2.37944 5000",
    ]);
    expect(output!.facts).toMatchObject({ answers: 5, owed: 0 });
    const held = answers(b.home);
    expect(held).toEqual({
      [answerKey("nearby", CAFE.latitude, CAFE.longitude, 150)]: { at: NOW, names: ["Harbour Cafe"] },
      [answerKey("venues", CAFE.latitude, CAFE.longitude, 300)]: { at: NOW, names: ["Grand Arcade"] },
      "nearby:48.72333,2.37944:150": { at: NOW, names: ["Terminal 2 Departures"] },
      "venues:48.72333,2.37944:300": { at: NOW, names: [] },
      "airport:48.72333,2.37944:5000": { at: NOW, names: ["Northfield International Airport"] },
    });
    expect(b.home.heads(SOURCE, ["answer"]).find((head) => head.key.startsWith("airport"))!.content).toEqual({
      type: "google-places.answer", places: [place("ChIJairport1", "Northfield International Airport", { latitude: 48.7262, longitude: 2.3652 }, ["international_airport", "airport"])],
    });
    const masks = new Set(google.asked.slice(-5).map((each) => each.fields));
    expect([...masks]).toEqual(["places.id,places.displayName,places.location,places.types,places.primaryType"]);
    expect(google.asked.slice(-5).every((each) => each.key === KEY)).toBe(true);
    expect(asked.filter((each) => each.includes("48.85661") && /airport|beach/u.test(each))).toEqual([]);
  });

  it("G2: a request answered near the same centre is never asked again, however old the answer", async () => {
    const b = await bench({ spots: [CAFE], ids: [] });
    expect((await b.run()).asked).toHaveLength(2);
    const moved = { latitude: CAFE.latitude + 0.0001, longitude: CAFE.longitude + 0.0001 };
    const held = Buffer.from(b.home.heads(SOURCE, ["answer"]).map((head) => `${JSON.stringify({ at_ms: head.start_ms, content: head.content, key: head.key, kind: "answer" })}\n`).join(""));
    for (const now of [NOW, NOW + 400 * DAY]) {
      const again = await bench({ spots: [moved], ids: [] }, { now });
      await again.home.land(googlePlacesConnector, deliver(again.home, SOURCE, { [ANSWERS_FILE]: held }, {}, NOW));
      expect(await again.run(), String(now)).toEqual({ output: null, asked: [] });
    }
  });

  it("G2: the same labeler asks nothing again as its answers age, though Google would answer the same", async () => {
    const b = await bench({ spots: [CAFE], ids: [] });
    expect((await b.run()).asked).toEqual(["nearby 48.85661,2.35222 150", "venues 48.85661,2.35222 300"]);
    for (const days of [0, 31, 90]) {
      b.at(NOW + days * DAY);
      expect(await b.run(), `${days} days`).toEqual({ output: null, asked: [] });
    }
  });

  it("G7: a home asks Google at most PER_DAY times in any 24 hours, and the rest a day later", async () => {
    const b = await bench({ spots: [CAFE, ROAD], ids: [{ id: "google:ChIJknown01", account: ACCOUNT }] }, { spent: PER_DAY - 3 });
    const capped = await b.run();
    expect(capped.asked).toEqual(["nearby 48.85661,2.35222 150", "venues 48.85661,2.35222 300", "nearby 48.72333,2.37944 150"]);
    expect(capped.output!.facts).toMatchObject({ answers: 3, owed: 1 });
    b.at(NOW + DAY);
    expect(await b.run()).toEqual({ output: null, asked: [] });
    b.at(NOW + DAY + 1);
    const next = await b.run();
    expect(next.asked).toEqual(["venues 48.72333,2.37944 300", "airport 48.72333,2.37944 5000"]);
  });

  it("G3: with no key, an empty key or the vault locked it asks nothing and delivers nothing", async () => {
    for (const options of [{ key: null }, { key: "  " }, { locked: true }] as const) {
      const { output, asked } = await (await bench({ spots: [CAFE, ROAD], ids: [{ id: "google:ChIJknown01", account: ACCOUNT }] }, options)).run();
      expect({ output, asked }, JSON.stringify(options)).toEqual({ output: null, asked: [] });
    }
  });

  it("G1, G6: a run asks at most PER_RUN, and one Google refuses keeps what it answered, rests the labeler and never shows the key", async () => {
    const many = Array.from({ length: PER_RUN }, (_, index) => ({ latitude: 10 + index / 100, longitude: 20 }));
    const b = await bench({ spots: many, ids: [] });
    const first = await b.run();
    expect(first.asked).toHaveLength(PER_RUN);
    expect(first.output!.facts).toMatchObject({ answers: PER_RUN, owed: PER_RUN / 2 });
    const next = await b.run();
    expect(next.asked).toHaveLength(PER_RUN);
    expect((await b.run()).asked).toEqual([]);

    const c = await bench({ spots: [CAFE, ROAD], ids: [] });
    google.refusingFrom = google.asked.length + 2;
    google.refusing = 429;
    const from = google.asked.length;
    const refused = await c.run().then(() => null, (error: unknown) => error);
    google.refusingFrom = Infinity;
    expect(google.since(from)).toEqual(["nearby 48.85661,2.35222 150", "venues 48.85661,2.35222 300", "nearby 48.72333,2.37944 150"]);
    expect(refused).toBeInstanceOf(LabelerUnavailable);
    const unavailable = refused as LabelerUnavailable;
    expect(unavailable.reason).toBe("unreadable");
    expect(unavailable.message).toContain("429");
    expect(unavailable.output!.facts).toMatchObject({ answers: 2, owed: 1 });
    await landed(c.home, unavailable.output!);
    expect(Object.keys(answers(c.home)).sort()).toEqual(["nearby:48.85661,2.35222:150", "venues:48.85661,2.35222:300"]);
    expect((await c.run()).asked).toEqual(["nearby 48.72333,2.37944 150", "venues 48.72333,2.37944 300", "airport 48.72333,2.37944 5000"]);

    const d = await bench({ spots: [CAFE], ids: [] }, { key: "synthetic-google-key-typo" });
    google.refusingFrom = google.asked.length;
    google.refusing = 403;
    const keyed = await d.run().then(() => null, (error: unknown) => error);
    google.refusingFrom = Infinity;
    expect(keyed).toBeInstanceOf(LabelerUnavailable);
    expect((keyed as LabelerUnavailable).reason).toBe("refused");
    expect((keyed as LabelerUnavailable).message).toContain("403");
    expect((keyed as LabelerUnavailable).message).not.toContain("synthetic-google-key-typo");
    d.seal(KEY);
    expect((await d.run()).asked).toEqual(["nearby 48.85661,2.35222 150", "venues 48.85661,2.35222 300"]);
  });

  it("G7: a Timeline place's name lands in its account's lookup; an ID Google does not know is asked once; an account with no lookup yet is asked, its lookup stated", async () => {
    const b = await bench({ spots: [], ids: [{ id: "google:ChIJknown01", account: ACCOUNT }, { id: "google:ChIJgone0001", account: ACCOUNT }, { id: "google:ChIJelse0001", account: "person-b@example.com" }] });
    const { output, asked } = await b.run();
    record.names = asked;
    expect(asked).toEqual(["name ChIJknown01", "name ChIJgone0001"]);
    expect(output!.facts).toMatchObject({ statements: 1, device: UNIT });
    const names = b.home.heads(LOOKUP, ["place"]).filter((head) => head.key !== "google:ChIJother9");
    expect(names.map((head) => [head.key, head.content])).toEqual([["google:ChIJknown01", { type: "google.place", id: "ChIJknown01", name: "Synthetic Viewpoint", centre: { latitude: 48.8, longitude: 2.3 } }]]);
    expect(google.asked.at(-1)!.fields).toBe("id,displayName,location");
    b.owe({ spots: [], ids: [{ id: "google:ChIJgone0001", account: ACCOUNT }, { id: "google:ChIJelse0001", account: "person-b@example.com" }] });
    expect(await b.run()).toEqual({ output: null, asked: ["name ChIJelse0001"] });
    expect(await b.run()).toEqual({ output: null, asked: [] });
    const fresh = await (await bench({ spots: [], ids: [{ id: "google:ChIJknown01", account: ACCOUNT }] }, { lookup: false })).run();
    expect(fresh.asked).toEqual(["name ChIJknown01"]);
    expect(fresh.output!.facts.sources).toEqual([{ id: SOURCE, connector: "google-places" }, { id: LOOKUP, connector: "google-place-names" }]);
  });

  it("G10: each request is written down before it leaves, and none leaves when the home cannot write it down", async () => {
    const b = await bench({ spots: [CAFE], ids: [{ id: "google:ChIJknown01", account: ACCOUNT }] });
    const from = google.asked.length;
    const answered = await b.run();
    const named = await b.run();
    expect([...answered.asked, ...named.asked]).toEqual(["nearby 48.85661,2.35222 150", "venues 48.85661,2.35222 300", "name ChIJknown01"]);
    expect(b.stated).toEqual([
      { sent: { receiver: "Google", request: "searchNearby", points: 1, chars: 0 }, sent_before: from },
      { sent: { receiver: "Google", request: "searchNearby", points: 1, chars: 0 }, sent_before: from + 1 },
      { sent: { receiver: "Google", request: "place", points: 0, chars: "ChIJknown01".length }, sent_before: from + 2 },
    ]);

    const c = await bench({ spots: [CAFE], ids: [] }, { unwritten: true });
    const unwritten = await c.run().then(() => null, (error: unknown) => error);
    expect(unwritten).toBeInstanceOf(LabelerUnavailable);
    expect(google.asked.length).toBe(from + 3);
  });

  it("G9: a name the lookup holds is never asked again while the home still owes it, by the same helper or a new one; held IDs count toward no bound", async () => {
    const owed = { spots: [], ids: [{ id: "google:ChIJknown01", account: ACCOUNT }, { id: "google:ChIJgone0001", account: ACCOUNT }] };
    const b = await bench(owed);
    expect((await b.run()).asked).toEqual(["name ChIJknown01", "name ChIJgone0001"]);
    expect(await b.run()).toEqual({ output: null, asked: [] });
    b.restart();
    expect(await b.run()).toEqual({ output: null, asked: ["name ChIJgone0001"] });
    expect(await b.run()).toEqual({ output: null, asked: [] });
    const many = { spots: [], ids: [owed.ids[0]!, ...Array.from({ length: PER_RUN + 2 }, (_, index) => ({ id: `google:ChIJmany${String(index).padStart(4, "0")}`, account: ACCOUNT }))] };
    b.owe(many);
    const bound = await b.run();
    expect([bound.asked.length, bound.asked.includes("name ChIJknown01"), bound.asked[0]]).toEqual([PER_RUN, false, "name ChIJmany0000"]);
    record.held = [...(await b.run()).asked];
  });

  it("G8: the connector lands part of a delivery with a bad line, or refuses the labeler's statements of Google's names", async () => {
    const home = openTestHome("google-places-");
    const good = JSON.stringify({ at_ms: NOW, content: { type: "google-places.answer", places: [] }, key: "nearby:48.85661,2.35222:150", kind: "answer" });
    const bad: [string, unknown][] = [
      ["a key of no request", { at_ms: NOW, content: { type: "google-places.answer" }, key: "around:48.85661,2.35222:150", kind: "answer" }],
      ["a centre not to five decimals", { at_ms: NOW, content: { type: "google-places.answer" }, key: "nearby:48.8566,2.35222:150", kind: "answer" }],
      ["no asking time", { content: { type: "google-places.answer" }, key: "nearby:48.85661,2.35222:150", kind: "answer" }],
      ["another type", { at_ms: NOW, content: { type: "google.place" }, key: "nearby:48.85661,2.35222:150", kind: "answer" }],
      ["places that are no list", { at_ms: NOW, content: { type: "google-places.answer", places: {} }, key: "nearby:48.85661,2.35222:150", kind: "answer" }],
      ["not JSON", "{not json"],
    ];
    const refusals: Record<string, string> = {};
    for (const [name, line] of bad) {
      const delivery = deliver(home, SOURCE, { [ANSWERS_FILE]: Buffer.from(`${good}\n${typeof line === "string" ? line : JSON.stringify(line)}\n`) }, {}, NOW);
      const error = await collect(googlePlacesConnector.read(delivery, home.blobs)).then(() => null, (thrown: Error) => thrown);
      expect(error, name).toBeInstanceOf(Refused);
      refusals[name] = error!.message;
    }
    expect(Object.values(refusals).every((message) => message.includes(`${ANSWERS_FILE} line 2`))).toBe(true);
    const names: Delivery = deliver(home, SOURCE, { "statements.ndjson": Buffer.from("{}\n") }, {}, NOW);
    expect(await collect(googlePlacesConnector.read(names, home.blobs))).toEqual([]);
    artifact(home.dir, "refusals.json", refusals);
    artifact(home.dir, "requests.json", record);
  });
});
