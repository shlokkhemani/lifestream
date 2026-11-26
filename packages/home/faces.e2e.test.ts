import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openHome, openHomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import { machine } from "./machine.js";
import { peopleFileOf } from "./people.js";
import { PEOPLE as PEOPLE_JOB, writePrepared } from "./prepared.js";
import { mintPrincipal } from "./principals.js";
import { askHome } from "./socket.js";
import { artifact, FAKE_OFFER, readHome, readLedger, removeRoot, settled, until } from "./test/harness-root.js";
import { ship, shipFiles } from "./test/harness-deliveries.js";
import { doorHere } from "./test/harness-door.js";
import { startHere } from "./test/harness-home.js";
import { homeRegistryModule } from "./programs.js";
import { eventually, faceKey, FACES, facesRoot, GOOGLE, head, heads, LEFT, naming, PEOPLE, personOf, REGISTRY, removeEngine, sha256, shipPhotos, UNIT, WHATSAPP } from "./test/faces.js";
import { testSocket } from "./test/folder.js";

const JPEG_START = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

describe("faces on a running home", () => {
  const roots: string[] = [];
  const homeOn = (root: string, log: (line: string) => void = () => undefined) => startHere(root, { registry: REGISTRY, log });

  afterAll(() => {
    for (const root of roots) removeRoot(root);
    removeEngine();
  });

  it("H1 H2: a group the door names never names its faces, or an erased photo stays in its cluster", async () => {
    const { root, photos } = facesRoot("lifestream-faces-door-", { p1: 1, p2: 1, p3: 1, q1: 2, q2: 2, q3: 2, q4: 2 }, { camera: true });
    roots.push(root);
    const token = "synthetic-token-dashboard".padEnd(43, "x");
    mintPrincipal(openHomeFolder(root), { unit: "dashboard", scopes: ["read", "deliver"], sources: [PEOPLE], token, now_ms: Date.now() });
    await homeOn(root);
    const door = await doorHere(root, { registry: homeRegistryModule() });

    await shipPhotos(root, Object.values(photos), Date.now() - 60_000);
    await until("two clusters of the shipped photos", () => heads(root, "cluster") === 2 && heads(root, "model-image") === 7);
    expect(personOf(root, photos.p1!.hex)).toBe("");

    const group = readHome(root, (db) => db.prepare("SELECT h.key, v.text FROM heads h JOIN versions v ON v.id = h.version WHERE h.source = ? AND h.kind = 'cluster' AND h.version <> 'gone'").all(FACES) as { key: string; text: string }[])
      .find(({ text }) => (JSON.parse(text) as { content: { faces: { face: string }[] } }).content.faces.some(({ face }) => face === faceKey(photos.p1!.hex)))!;
    const action = { of: "people", request: "faces-h1-name", kind: "name", cluster: group.key, target: { kind: "new", name: "Person A" } };
    const response = await fetch(`${door.url}/v1/owner/act`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(action) });
    expect({ status: response.status, answer: await response.json() }).toMatchObject({ status: 200, answer: { id: "person:person-a" } });
    await until("the faces of p1, p2 and p3 named", () => [photos.p1!, photos.p2!, photos.p3!].every(({ hex }) => personOf(root, hex) === "person-a"));
    await until("the name drawn", () => (head(root, "model-image", photos.p2!.hex)?.names as ({ shown: string } | null)[] | undefined)?.[0]?.shown === "Person A");
    expect(heads(root, "cluster")).toBe(1);
    const statement = readHome(root, (db) => db.prepare("SELECT kind, key FROM heads WHERE source = ? AND kind = 'face' ORDER BY key").all(PEOPLE));
    expect(statement).toEqual([photos.p1!, photos.p2!, photos.p3!].map(({ hex }) => ({ kind: "face", key: faceKey(hex) })).sort((a, b) => a.key < b.key ? -1 : 1));

    const cluster = () => readHome(root, (db) => db.prepare("SELECT v.text FROM heads h JOIN versions v ON v.id = h.version WHERE h.source = ? AND h.kind = 'cluster' AND h.version <> 'gone'").pluck().all(FACES) as string[])
      .map((text) => (JSON.parse(text) as { content: { size: number } }).content);
    expect(cluster()).toMatchObject([{ size: 4 }]);
    const erased = await askHome(testSocket(root), "erase", ["photos", `photo:${photos.q1!.hex}`, "--apply"]) as { records: number };
    expect(erased.records).toBe(5);
    await until("the cluster restated without q1", () => cluster().length === 1 && cluster()[0]!.size === 3);
    expect(head(root, "scan", photos.q1!.hex)).toBeUndefined();
    expect(head(root, "image", photos.q1!.hex)).toBeUndefined();
    artifact(root, "faces-door", { statement, cluster: cluster(), erased });
  });

  it("H5: a sender or a sidecar's name never reaches the cluster through the door, or the labels cannot name the sender", async () => {
    const { root, photos } = facesRoot("lifestream-faces-evidence-", { e1: 5, e2: 5, e3: 5, e4: 5, e5: 5 }, { camera: true });
    roots.push(root);
    const token = "synthetic-token-dashboard-both".padEnd(43, "y");
    mintPrincipal(openHomeFolder(root), { unit: "dashboard-macbook-pro-0001", scopes: ["read", "deliver"], sources: [PEOPLE], token, now_ms: Date.now() });
    await homeOn(root);
    const door = await doorHere(root, { registry: homeRegistryModule() });
    const read = async (path: string) => {
      const response = await fetch(`${door.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      return response.json() as Promise<Record<string, unknown>>;
    };

    const at = Date.now() - 120_000;
    await ship(root, {
      source: GOOGLE, fetched_ms: at,
      rows: [{ kind: "img", key: photos.e3!.hex, at: at - 60_000, blobs: [`sha256:${photos.e3!.hex}`],
        content: { type: "photos.asset", title: "IMG_0003.JPG", people: [{ name: "Person B" }],
          blobs: [{ hash: `sha256:${photos.e3!.hex}`, bytes: 24, media_type: "image/jpeg", role: "original" }] } },
      ...[photos.e4!, photos.e5!].map(({ hex }, index) => ({ kind: "img", key: hex, at: at - 50_000 + index, blobs: [`sha256:${hex}`],
        content: { type: "photos.asset", blobs: [{ hash: `sha256:${hex}`, bytes: 24, media_type: "image/jpeg", role: "original" }] } }))],
      carried: { [photos.e3!.hex]: photos.e3!.bytes, [photos.e4!.hex]: photos.e4!.bytes, [photos.e5!.hex]: photos.e5!.bytes },
    });
    await ship(root, {
      source: WHATSAPP, fetched_ms: at + 1,
      rows: [photos.e1!, photos.e2!].map(({ hex }, index) => ({
        kind: "msg", key: `15550000002@s.whatsapp.net:3EB0E${index}`, at: at - 30_000 + index, blobs: [`sha256:${hex}`],
        content: { type: "whatsapp.msg", session_jid: "15550000002@s.whatsapp.net", message: { ZMESSAGETYPE: 1, ZISFROMME: 0, ZFROMJID: null, ZTEXT: null },
          blobs: [{ hash: `sha256:${hex}`, bytes: 24, role: "ZWAMEDIAITEM.ZMEDIALOCALPATH" }] },
      })),
      carried: { [photos.e1!.hex]: photos.e1!.bytes, [photos.e2!.hex]: photos.e2!.bytes },
    });
    const evidence = { labels: [{ faces: 1, name: "Person B" }], senders: [{ faces: 2, kind: "jid", value: "15550000002@s.whatsapp.net" }] };
    const clusters = async () => (await read(`/v1/records?${new URLSearchParams({ source: FACES, kind: "cluster" })}`)).records as { content: Record<string, unknown> }[];
    await eventually("the cluster's evidence served by the door", async () => JSON.stringify((await clusters())[0]?.content.evidence) === JSON.stringify(evidence));

    const lines = [{ kind: "person", key: "person-b", content: { type: "people.person", slug: "person-b", name: "Person B", excluded: [], merged_into: null,
      handles: [{ kind: "name", value: "Person B", by: "subject", since: "2026-10-01T00:00:00.000Z" }, { kind: "phone", value: "+15550000002", by: "subject", since: "2026-10-01T00:00:00.000Z" }] } }];
    await shipFiles(root, PEOPLE, Date.now(), { "statements.ndjson": Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join("")) });
    const sender = evidence.senders[0]!.value;
    const named = await eventually("the sender named by the registry", async () => {
      const labels = await read(`/v1/labels?${new URLSearchParams({ id: sender })}`);
      const [entry] = labels.names as [string, string, string, string | null][];
      return entry?.[3] === "person-b" ? entry : undefined;
    });
    expect(named).toEqual([sender, "Person B", "registry", "person-b"]);
    artifact(root, "faces-evidence", { cluster: (await clusters())[0]?.content, named });
  });

  it("H6: a caption is not shown its photo drawn when its request is written, a drawing lands in blobs/, or one that fails is never drawn again", async () => {
    const { root, photos } = facesRoot("lifestream-faces-draw-", { d1: 1, d2: 1 }, {
      camera: true,
    });
    roots.push(root);
    const config = join(root, "engine", "engine.json");
    const engine = (change: JsonObject) => writeFileSync(config, JSON.stringify({ ...(JSON.parse(readFileSync(config, "utf8")) as JsonObject), ...change }));
    const draws = () => readFileSync(join(root, "engine", "calls.log"), "utf8").split("\n").filter((line) => line.startsWith("draw "));
    const requests = () => readLedger(root, (db) => db.prepare("SELECT unit, attachments FROM requests ORDER BY unit").all() as { unit: string; attachments: string }[]) ?? [];
    const failed = () => readHome(root, (db) => db.prepare("SELECT unit, error FROM dirty_units WHERE family = 'photos' AND error IS NOT NULL ORDER BY unit").all()) as { unit: string; error: string }[];
    engine({ fail: { draw: 1 } });
    await homeOn(root);
    await shipPhotos(root, Object.values(photos), Date.now() - 600_000);

    await until("the send set aside", () => failed().length > 0);
    expect(failed()[0]!.error).toMatch(/face-engine draw failed: exit 1: face-engine: a fake failure/u);
    expect(requests()).toEqual([]);
    const tried = draws().length;
    expect(tried).toBeGreaterThan(0);

    engine({ fail: {} });
    await askHome(testSocket(root), "run", ["plan", "photos"]);
    await until("both captions requested", () => requests().length === 2);
    expect(draws().length).toBe(tried + 2);
    const items = Object.values(photos).map(({ hex }) => `photo:${hex}`).sort();
    expect(requests().map((row) => row.unit)).toEqual(items);
    const blobs = openHomeFolder(root).blobs(join(root, "blobs"));
    const sent = requests().map((row) => {
      const [file] = JSON.parse(row.attachments) as { kind: string; sha256: string; extension: string }[];
      const hex = row.unit.slice("photo:".length);
      const bytes = readFileSync(join(root, "replies", "blobs", file!.sha256.slice(0, 2), file!.sha256.slice(2, 4), file!.sha256), "utf8");
      expect(bytes).toBe(`drawn ${hex} [{"name":"P1","box":[100,100,300,300]}]`);
      expect(file).toEqual({ kind: "image", sha256: sha256(bytes), extension: ".jpg" });
      expect(blobs.has(`sha256:${file!.sha256}`)).toBe(false);
      return { item: row.unit, attachment: file, bytes };
    });
    expect(draws().slice(-2).map((line) => (JSON.parse(line.slice("draw ".length)) as { images: { path: string }[] }).images[0]!.path).sort())
      .toEqual(Object.values(photos).map(({ hex }) => join(root, "blobs", hex.slice(0, 2), hex.slice(2, 4), hex)).sort());
    expect(readdirSync(join(root, "tools", "faces-work")).filter((name) => name.startsWith("draw-"))).toEqual([]);
    artifact(root, "faces-draw", { tried, sent });
  });

  it("H12: a face's journey, labeler to day, leaves its face, tag or drawing on a route that leaves, loses its placeholder, asks again when named, or takes a face not drawn", async () => {
    const RECEIVER = "Example Cloud";
    const { root, photos } = facesRoot("lifestream-faces-journey-", { j1: 1, j2: 2 }, { camera: true });
    roots.push(root);
    const log = join(root, "received.jsonl");
    const said = (placeholder: string) => JSON.stringify({ caption: `${placeholder} holds a cake.`, faces: [{ placeholder, who: "a man" }] });
    const sock = testSocket(root);
    const transport = (more: JsonObject) => askHome(sock, "settings", ["set", "model.transports.fake", JSON.stringify({ delay_ms: 100, models: [FAKE_OFFER], log, ...more })]);
    const received = (): { input: string; attachments: { media_type: string; bytes: string }[] }[] =>
      (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { input: string; attachments: { media_type: string; bytes: string }[] }) : []);
    const caption = (hex: string) => {
      const content = readHome(root, (db) => db.prepare("SELECT content FROM enrichments WHERE family = 'photos' AND item = ? AND state = 'done'").pluck().get(`photo:${hex}`) as string | undefined);
      return content === undefined ? undefined : JSON.parse(content) as { text: string; names: { start: number; end: number; who: string }[] };
    };
    const days = () => (existsSync(join(root, "days")) ? readdirSync(join(root, "days")).filter((name) => name.endsWith(".day.txt")).map((name) => readFileSync(join(root, "days", name), "utf8")).join("\n") : "");
    const requests = () => readLedger(root, (db) => db.prepare("SELECT unit FROM requests ORDER BY unit").pluck().all() as string[]) ?? [];
    const { j1, j2 } = photos as { j1: { hex: string; bytes: Buffer }; j2: { hex: string; bytes: Buffer } };
    await homeOn(root);
    await transport({ leaves: RECEIVER, reply: said("[[Person 1]]") });
    writePrepared(openHomeFolder(root), peopleFileOf(root, machine().dir), PEOPLE_JOB, { rows: new Map([["names", new Map([["table", { owner: null, people: [] }]])]]), position: "names-1" });

    await shipPhotos(root, [j1], Date.now() - 600_000);
    await until("j1's caption", () => caption(j1.hex) !== undefined);
    expect(head(root, "model-image", j1.hex)).toEqual({ faces: [{ box: LEFT }], names: [null] });
    expect(requests()).toEqual([`photo:${j1.hex}`]);
    const [sent] = received();
    expect(received()).toHaveLength(1);
    const drawn = Buffer.from(sent!.attachments[0]!.bytes, "base64");
    expect(drawn.subarray(0, JPEG_START.length)).toEqual(JPEG_START);
    const picture = drawn.subarray(JPEG_START.length).toString();
    expect(picture.startsWith(`made ${j1.hex} `)).toBe(true);
    expect((JSON.parse(picture.slice(`made ${j1.hex} `.length)) as { covered: { box: number[]; tag?: string }[]; written: unknown[] })).toMatchObject({ covered: [{ box: LEFT, tag: "P1" }], written: [] });
    expect(JSON.stringify(received())).not.toContain("drawn ");
    expect(readLedger(root, (db) => db.prepare("SELECT receiver, level FROM outbound").all())).toEqual([{ receiver: RECEIVER, level: "all" }]);
    expect(readLedger(root, (db) => db.prepare("SELECT text FROM replies WHERE unit = ? AND validation = 'accepted'").pluck().get(`photo:${j1.hex}`))).toContain("[[Person 1]] holds a cake.");
    expect(caption(j1.hex)).toEqual({ text: "A man holds a cake.", names: [] });
    await until("the day's caption", () => days().includes("A man holds a cake."));
    expect(days()).not.toContain("[[Person");

    await shipFiles(root, PEOPLE, Date.now() - 30_000, naming(j1.hex), { device: UNIT });
    await until("the name in the caption", () => caption(j1.hex)?.text === "Person A holds a cake.");
    expect(head(root, "model-image", j1.hex)).toEqual({ faces: [{ box: LEFT }], names: [{ who: "person:person-a", shown: "Person A" }] });
    expect(caption(j1.hex)!.names).toEqual([{ start: 0, end: 8, who: "person:person-a" }]);
    await until("the day's named caption", () => days().includes("Person A holds a cake."));
    expect([requests().length, received().length]).toEqual([1, 1]);

    await transport({ reply: said("[[Person 2]]") });
    await shipPhotos(root, [j2], Date.now() - 20_000);
    await until("j2's reply refused", () => (readLedger(root, (db) => db.prepare("SELECT count(*) FROM replies WHERE unit = ? AND validation = 'refused'").pluck().get(`photo:${j2.hex}`) as number) ?? 0) >= 1);
    expect(caption(j2.hex)).toBeUndefined();
    const local = received().slice(1);
    expect(local.length).toBeGreaterThan(0);
    expect(Buffer.from(local[0]!.attachments[0]!.bytes, "base64").toString()).toBe(`drawn ${j2.hex} ${JSON.stringify([{ name: "P1", box: LEFT }])}`);
    expect(readLedger(root, (db) => db.prepare("SELECT count(*) FROM outbound").pluck().get())).toBe(1);
    artifact(root, "faces-journey", { received: received().map((each) => ({ input: each.input.slice(-200), attachments: each.attachments.map((file) => Buffer.from(file.bytes, "base64").toString()) })), caption: caption(j1.hex) });
  });

  it("H4: a chat delta of text-only messages starts label faces, or one with a photo does not", async () => {
    const { root, photos } = facesRoot("lifestream-faces-linked-", { c1: 1 });
    roots.push(root);
    await homeOn(root);
    const runs = () => readFileSync(join(root, "engine", "calls.log"), "utf8").split("\n").filter((line) => line.startsWith("scan ") && line.includes('"photos":[]')).length;
    const message = (n: number, photo?: { hex: string }) => ({
      kind: "msg", key: `15550000002@s.whatsapp.net:3EB0${n}`, at: Date.now() - 60_000 + n,
      content: {
        type: "whatsapp.msg", message: { ZMESSAGETYPE: photo === undefined ? 0 : 1, ZTEXT: photo === undefined ? `synthetic words ${n}` : null },
        blobs: photo === undefined ? [] : [{ hash: `sha256:${photo.hex}`, bytes: 24, role: "ZWAMEDIAITEM.ZMEDIALOCALPATH" }],
      },
      ...(photo === undefined ? {} : { blobs: [`sha256:${photo.hex}`] }),
    });
    await until("the run at start", () => existsSync(join(root, "engine", "calls.log")) && settled(root, 0));
    const atStart = runs();

    await ship(root, { source: WHATSAPP, fetched_ms: Date.now(), rows: [1, 2, 3].map((n) => message(n)) });
    await until("the text delta imported", () => settled(root, 1));
    expect(runs()).toBe(atStart);
    expect(heads(root, "scan")).toBe(0);

    await ship(root, { source: WHATSAPP, fetched_ms: Date.now() + 1, rows: [message(4, photos.c1!)], carried: { [photos.c1!.hex]: photos.c1!.bytes } });
    await until("the chat photo scanned", () => head(root, "scan", photos.c1!.hex) !== undefined);
    expect(runs()).toBeGreaterThan(atStart);
    artifact(root, "faces-linked", { atStart, after: runs() });
  });

  it("H3: a labeler run stopped at its bound waits for new input, or the next run does the last one's work again", async () => {
    const count = 2_001;
    const { root, photos } = facesRoot("lifestream-faces-bound-", Object.fromEntries(Array.from({ length: count }, (_, index) => [`b${index}`, 0])));
    roots.push(root);
    const blobs = openHomeFolder(root).blobs(join(root, "blobs"));
    const db = openHome(openHomeFolder(root), "migrate");
    const at = Date.now() - 3_600_000;
    db.commit((tx) => tx.records.land(tx.tables.runs.start({ kind: "import", subject: GOOGLE, started_ms: at }), { id: "photos", source: GOOGLE, stated_ms: at },
      Object.values(photos).map(({ hex, bytes }) => ({
        kind: "img", key: hex, time: { start_ms: at, precision: "ms" as const }, blobs: [blobs.put(bytes)],
        content: { type: "photos.asset", blobs: [{ hash: `sha256:${hex}`, bytes: 24, media_type: "image/jpeg", role: "original" }] },
      })), { img: () => [] }, { has: () => true }));
    db.close();
    await homeOn(root);
    await until("every photo scanned", () => heads(root, "scan") === count);
    const runs = readHome(root, (raw) => raw.prepare("SELECT facts FROM deliveries WHERE source = ? ORDER BY sealed_ms, id").pluck().all(FACES) as string[])
      .map((facts) => JSON.parse(facts) as { scanned: number; owed: number });
    expect(runs.map(({ scanned, owed }) => ({ scanned, owed }))).toEqual([{ scanned: 2_000, owed: 1 }, { scanned: 1, owed: 0 }]);
    artifact(root, "faces-bound", { runs });
  });
});
