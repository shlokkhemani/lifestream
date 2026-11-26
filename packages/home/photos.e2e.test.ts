import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openHomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import { serveDoor, type Door } from "./door.js";
import { startHome, type Home } from "./home.js";
import { mintPrincipal } from "./principals.js";
import { askHome } from "./socket.js";
import { freeSpace, makeRoot, readHome, removeRoot, REPO, until, TICK_MS } from "./test/harness-root.js";
import { shipFiles } from "./test/harness-deliveries.js";
import { freePort } from "./test/harness-door.js";
import { editSettings, testSocket } from "./test/folder.js";
import { acquisitionBundle, DEVICE, phoneBundle } from "./test/support.js";

const REGISTRY = new URL("./test/photos-registry.ts", import.meta.url);
const OUT = join(REPO, "packages", "home", ".build", "e2e", "photos");
const ACCOUNT = "person-a@example.com";
const HOME_UNIT = "macbook-pro-0001";
const MAC_UNIT = "macbook-pro-0001";
const MAC = `apple-photos:${ACCOUNT}:${MAC_UNIT}`;
const GOOGLE = `google-photos:${ACCOUNT}:export`;
const READER = "synthetic-token-photos-reader".padEnd(43, "x");
const HOUR = 3_600_000;
const BARE = 1_100;
const PARIS = { latitude: 48.853, longitude: 2.3499 };
const LYON = { latitude: 45.764, longitude: 4.8357 };

const hexOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();
const at = (clock: string) => Date.parse(`2026-09-20T${clock}Z`);
const file = (name: string) => Buffer.from(`synthetic bytes of ${name}, ${"x".repeat(48)}`);
const googleFile = (name: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), file(name)]);

type Resource = JsonObject;
function resource(type: "photo" | "video" | "fullSizePhoto" | "pairedVideo", name: string, bytes: Buffer | null, reason?: string): Resource {
  const raw = { photo: 1, video: 2, fullSizePhoto: 5, pairedVideo: 9 }[type];
  const uti = type === "video" || type === "pairedVideo" ? "com.apple.quicktime-movie" : "public.heic";
  return {
    type, type_raw: raw, uti, original_filename: name,
    ...(bytes === null
      ? { blob: null, not_local: true, ...(reason === undefined ? {} : { not_local_reason: reason }) }
      : { blob: { hash: `sha256:${hexOf(bytes)}`, bytes: bytes.length, type: bytes[0] === 0xff ? "image/jpeg" : "image/heic", role: type } }),
  };
}

function jpeg(make: string, model: string, body: string): Buffer {
  const tiff = Buffer.alloc(96);
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(2, 8);
  for (const [index, [tag, value, at]] of ([[0x010f, `${make}\0`, 40], [0x0110, `${model}\0`, 64]] as const).entries()) {
    tiff.writeUInt16LE(tag, 10 + index * 12);
    tiff.writeUInt16LE(2, 12 + index * 12);
    tiff.writeUInt32LE(value.length, 14 + index * 12);
    tiff.writeUInt32LE(at, 18 + index * 12);
    tiff.write(value, at, "ascii");
  }
  const segment = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, (segment.length + 2) >> 8, (segment.length + 2) & 0xff]), segment, Buffer.from([0xff, 0xda]), Buffer.from(body), Buffer.from([0xff, 0xd9])]);
}

interface Snap { lid: string; cloud: string | null; taken: number | null; name: string; mod?: string; location?: JsonObject; bytes?: Buffer; media?: "image" | "video" }
const asset = (snap: Snap): JsonObject => ({
  local_identifier: snap.lid, cloud_identifier: snap.cloud, modification_date: snap.mod ?? null,
  creation_date: snap.taken === null ? null : iso(snap.taken), media_type: snap.media ?? "image", media_subtypes: 0, pixel_width: 4032, pixel_height: 3024,
  location: snap.location ?? null, favorite: false, hidden: false,
  resources: [resource(snap.media === "video" ? "video" : "photo", snap.name, snap.bytes ?? null)],
});
const snapshotKey = (snap: Pick<Snap, "lid" | "mod">) => `photos:${snap.lid}:${snap.mod ?? "null"}`;
const availability = (snap: Snap, resources: Resource[]): JsonObject => ({
  local_identifier: snap.lid, modification_date: snap.mod ?? null, snapshot_replay_key: snapshotKey(snap), resources,
});
function takeout(photos: { name: string; taken_s: number; bytes: Buffer }[]): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  for (const photo of photos) {
    const media = `Takeout/Google Photos/Photos from 2026/${photo.name}`;
    files[media] = photo.bytes;
    files[`${media}.supplemental-metadata.json`] = Buffer.from(JSON.stringify({ title: photo.name, photoTakenTime: { timestamp: String(photo.taken_s), formatted: "synthetic" } }));
  }
  return files;
}

interface Stored {
  unit: string; device: string; at_ms: number | null; video: boolean; item: string; image: { sha256: string } | null; held: boolean;
  records: { source: string; key: string; rung: number }[];
  routes: { source: string; asset: string; refused: boolean }[];
}
interface Files { photos: { asset: string; files: string[] }[]; settled: string[]; left: { wanted: number; unavailable: number; bytes: number }; paused?: true }
interface Answer { photos: string[]; left: Files["left"] }

describe("photos from a phone, a Mac and a Takeout", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) removeRoot(root);
  });

  it("joins each photo by its rungs, and asks each library for what it alone should send", async () => {
    const root = makeRoot("lifestream-photos-", {
      sources: { [GOOGLE]: "google-photos-takeout" },
      settings: { unit: HOME_UNIT, "day.zone": "Europe/Paris" },
    });
    roots.push(root);
    mkdirSync(OUT, { recursive: true });
    mintPrincipal(openHomeFolder(root), { unit: "reader-0001", scopes: ["read"], token: READER, now_ms: Date.now() });
    const port = await freePort();
    editSettings(root, { "door.port": port });
    const home: Home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: REGISTRY, log: () => undefined });
    let skew = 0;
    const serve = () => serveDoor(root, { port, max_bundle_bytes: 1 << 30 },
      { registry: REGISTRY, log: () => undefined, clock: () => Date.now() + skew, floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" } });
    let door: Door = await serve();
    const url = () => `http://127.0.0.1:${door.port}`;
    try {
      const sock = testSocket(root);
      const post = async (body: JsonObject, headers: Record<string, string>) =>
        (await fetch(`${url()}/v1/pair`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<JsonObject>;

      const phonePass = randomBytes(32).toString("base64url");
      const paired = await post({ code: ((await askHome(sock, "pair", [])) as { code: string }).code, pass: phonePass, kind: "phone", model: "iPhone 17 Pro", account: ACCOUNT, new: true }, DEVICE.phone);
      const PHONE = `apple-photos:${ACCOUNT}:${paired.unit as string}`;
      const macPass = randomBytes(32).toString("base64url");
      const macPaired = await post({ code: ((await askHome(sock, "pair", [])) as { code: string }).code, pass: macPass, kind: "mac", model: "MacBook Pro", serial4: "0001", offers: [MAC] }, DEVICE.mac);
      expect(macPaired.unit).toBe(MAC_UNIT);
      expect(readHome(root, (db) => db.prepare("SELECT id, connector FROM sources WHERE id IN (?, ?) ORDER BY connector").all(PHONE, MAC)))
        .toEqual([{ id: PHONE, connector: "photos-ios-bundle" }, { id: MAC, connector: "photos-mac-bundle" }]);
      const NAMES: Record<string, string> = { [PHONE]: "phone", [MAC]: "mac", [GOOGLE]: "takeout" };

      let phoneSeal = 0, phoneLine = 0;
      const macSeals: Record<string, number> = {};
      const shipped: Record<string, number> = { [PHONE]: 0, [MAC]: 0, [GOOGLE]: 0 };
      const T0 = Date.now() - 2 * HOUR;
      type Entry = { kind: "asset" | "resource_availability" | "gone"; payload: JsonObject };
      const phoneShip = async (entries: Entry[], carried: Buffer[] = [], lost?: number, observed_ms = Date.parse("2026-10-01T09:00:00Z")) => {
        const lines = entries.map(({ kind, payload }) => {
          const sequence = ++phoneLine;
          return { domain: "photos", kind, sequence, captured: { wall_rfc3339: iso(observed_ms + sequence * 1000) }, payload };
        });
        const seal = ++phoneSeal;
        const observed = lines.map((line) => line.captured.wall_rfc3339);
        const bundle = phoneBundle({
          entries: { "photos.jsonl": lines }, blobs: carried, second: seal, range: { start: observed[0]!, end: observed.at(-1)! },
          custody: { [PHONE]: { seal, ...(lost === undefined ? {} : { lost: [{ items: lost, what: "photo copies this phone cleared once the home had imported them" }] }) } },
        });
        const response = await fetch(`${url()}/v1/bundles/${bundle.id}`, { method: "PUT", headers: { authorization: `Bearer ${phonePass}`, ...DEVICE.phone, "lifestream-kind": "new" }, body: bundle.bytes });
        expect(response.status, await response.text()).toBe(201);
        shipped[PHONE]!++;
      };
      const phoneAvailability = (snap: Snap, resources: Resource[]) => ({ kind: "resource_availability" as const, payload: availability(snap, resources) });
      const macShip = async (lines: Entry[], carried: Buffer[] = [], mac = { pass: macPass, source: MAC }) => {
        const seal = macSeals[mac.source] = (macSeals[mac.source] ?? 0) + 1;
        const text = lines.map((line, n) => `${JSON.stringify({ kind: line.kind, observed_at: iso(Date.parse("2026-10-01T10:00:00Z") + seal * 60_000 + n), payload: line.payload })}\n`).join("");
        const bundle = acquisitionBundle({ source: mac.source, feeder: "photos-mac-bundle", fetched_ms: T0 + seal * 1000, files: [["photos.jsonl", Buffer.from(text)]], blobs: carried, custody: { [mac.source]: { seal } } });
        const response = await fetch(`${url()}${bundle.path}`, { method: "PUT", headers: { authorization: `Bearer ${mac.pass}`, ...DEVICE.mac }, body: bundle.bytes });
        expect(response.status, await response.text()).toBe(201);
        shipped[mac.source] = (shipped[mac.source] ?? 0) + 1;
        return Buffer.byteLength(text);
      };
      const takeoutShip = async (photos: Parameters<typeof takeout>[0], beside: Record<string, Buffer> = {}) => {
        await shipFiles(root, GOOGLE, Date.now(), { ...takeout(photos), ...beside }, { exported_at: "2026-10-01T00:00:00Z" });
        shipped[GOOGLE]!++;
      };

      const count = (sql: string, ...values: unknown[]) => readHome(root, (db) => db.prepare(sql).pluck().get(...values) as number);
      const settle = (what: string) => until(what, () =>
        Object.entries(shipped).every(([source, n]) => count("SELECT count(*) FROM deliveries WHERE source = ? AND state = 'imported'", source) === n) &&
        count("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')") === 0);

      const ask = async (pass: string, headers: Record<string, string>, source: string): Promise<{ status: number; body: Answer }> => {
        const response = await fetch(`${url()}/v1/photos/wanted?source=${encodeURIComponent(source)}&files=1`, { headers: { authorization: `Bearer ${pass}`, ...headers } });
        const body = await response.json() as Files;
        return { status: response.status, body: { photos: (body.photos ?? []).map((photo) => photo.asset), left: body.left } };
      };
      const lists = async () => {
        const phone = await ask(phonePass, DEVICE.phone, PHONE), mac = await ask(macPass, DEVICE.mac, MAC);
        expect([phone.status, mac.status]).toEqual([200, 200]);
        return { phone: phone.body, mac: mac.body };
      };
      const stored = (): Stored[] => readHome(root, (db) => {
        const routes = new Map((db.prepare("SELECT unit, content FROM extracts WHERE family = 'photos' AND unit LIKE 'wanted/%'").all() as { unit: string; content: string }[])
          .map(({ unit, content }) => [unit.slice("wanted/".length), (JSON.parse(content) as Pick<Stored, "routes">).routes] as const));
        return (db.prepare("SELECT unit, content FROM extracts WHERE family = 'photos' AND unit LIKE 'photo/%' ORDER BY unit").all() as { unit: string; content: string }[])
          .map(({ unit, content }) => ({ unit, ...JSON.parse(content) as Omit<Stored, "unit" | "routes">, routes: routes.get(unit.slice("photo/".length)) ?? [] }));
      });
      const wantedFiles = async (pass: string, headers: Record<string, string>, source: string, owed: string[] = []): Promise<Files> =>
        (await fetch(`${url()}/v1/photos/wanted?source=${encodeURIComponent(source)}&files=1${owed.map((id) => `&owed=${encodeURIComponent(id)}`).join("")}`, { headers: { authorization: `Bearer ${pass}`, ...headers } })).json() as Promise<Files>;
      const exchange = async (pass: string, headers: Record<string, string>) =>
        ((await fetch(`${url()}/v1/exchange`, { method: "POST", headers: { authorization: `Bearer ${pass}`, ...headers, "content-type": "application/json" }, body: "{}" })).json()) as Promise<{ sources: Record<string, { history?: boolean }> }>;
      const caughtUp = () => Number(readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = 'disk:catch-up'").pluck().get() as string | undefined) ?? 0);
      const isBare = (photo: Stored) => photo.records.every((record) => record.key.startsWith("BARE-"));
      const shape = (photo: Stored, answer: { phone: Answer; mac: Answer }) => ({
        records: photo.records.map((record) => [NAMES[record.source], record.key, record.rung]),
        held: photo.held, item: photo.item,
        asked: photo.routes.flatMap((route) => (route.source === PHONE ? answer.phone : answer.mac).photos.includes(route.asset) ? [NAMES[route.source]] : []),
      });
      const photoWith = (photos: Stored[], source: string, prefix: string) => photos.find((photo) => photo.records.some((record) => record.source === source && record.key.startsWith(prefix)));
      const report = async (name: string, extra: JsonObject = {}) => {
        const answer = await lists();
        const photos = stored();
        const bare = photos.filter(isBare);
        writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify({
          case: name, ...extra,
          answers: { phone: { left: answer.phone.left, photos: answer.phone.photos.length, first: answer.phone.photos.slice(0, 20) }, mac: { left: answer.mac.left, photos: answer.mac.photos.length, first: answer.mac.photos.slice(0, 20) } },
          photos: photos.filter((photo) => !isBare(photo)).map((photo) => ({ unit: photo.unit, at: photo.at_ms === null ? null : iso(photo.at_ms), image: photo.image?.sha256 ?? null, ...shape(photo, answer) })),
          bare_mac_snapshots: { photos: bare.length, held: bare.filter((photo) => photo.held).length, asked_of_mac: bare.filter((photo) => shape(photo, answer).asked.includes("mac")).length },
        }, null, 2)}\n`);
        return { answer, photos, of: (source: string, prefix: string) => { const photo = photoWith(photos, source, prefix); return photo === undefined ? undefined : shape(photo, answer); } };
      };

      const P1 = { taken: at("10:00:00"), cloud: "CLOUD-0001", name: "IMG_0001.HEIC" };
      const phone1: Snap = { lid: "PHONE-1/L0/001", ...P1 }, mac1: Snap = { lid: "MAC-1/L0/001", ...P1 };
      await phoneShip([{ kind: "asset", payload: asset(phone1) }]);
      await macShip([{ kind: "asset", payload: asset(mac1) }]);
      await settle("both libraries' snapshots");
      let seen = await report("two-routes");
      expect(seen.of(PHONE, "PHONE-1/")).toEqual({
        records: [["phone", "PHONE-1/L0/001:null", 0], ["mac", "MAC-1/L0/001:null", 2]], held: false, item: "photo:apple:CLOUD-0001", asked: ["mac"],
      });
      expect(seen.photos.filter((photo) => photo.records.some((record) => record.key.includes("-1/L0/")))).toHaveLength(1);

      const original1 = file("photo one's original");
      await macShip([{ kind: "resource_availability", payload: availability(mac1, [resource("photo", P1.name, original1)]) }], [original1]);
      await phoneShip([phoneAvailability(phone1, [resource("photo", P1.name, original1)])], [original1]);
      await settle("one file from both libraries");
      seen = await report("one-file");
      const one = seen.of(PHONE, "PHONE-1/")!;
      expect(one).toMatchObject({ held: true, item: `photo:${hexOf(original1)}`, asked: [] });
      expect(one.records.map(([library, , rung]) => [library, rung])).toEqual([["phone", 0], ["phone", 0], ["mac", 1], ["mac", 1]]);
      const named = (hex: string) => {
        const found: string[] = [];
        const walk = (directory: string): void => {
          for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (entry.isDirectory()) walk(join(directory, entry.name));
            else if (entry.name === hex) found.push(entry.name);
          }
        };
        walk(join(root, "blobs"));
        return found.length;
      };
      expect(named(hexOf(original1))).toBe(1);

      const phone2: Snap = { lid: "PHONE-2/L0/001", cloud: "CLOUD-0002", taken: at("10:10:00.400"), name: "IMG_0002.HEIC" };
      const phone4: Snap = { lid: "PHONE-4/L0/001", cloud: "CLOUD-0004", taken: at("10:20:00"), name: "IMG_0004.HEIC" };
      const phone5: Snap = { lid: "PHONE-5/L0/001", cloud: "CLOUD-0005", taken: at("10:30:00"), name: "IMG_0005.HEIC" };
      const mac6: Snap = { lid: "MAC-6/L0/001", cloud: "CLOUD-0006", taken: at("10:30:00"), name: "IMG_0005.HEIC" };
      const google2 = googleFile("Google's smaller copy of photo two"), google3 = googleFile("a file Google holds of photo three"), google4 = googleFile("Google's copy of photo four");
      await phoneShip([{ kind: "asset", payload: asset(phone2) }, { kind: "asset", payload: asset(phone4) }, { kind: "asset", payload: asset(phone5) }]);
      await macShip([{ kind: "asset", payload: asset(mac6) }]);
      await takeoutShip([
        { name: "IMG_0002.HEIC", taken_s: at("10:10:00") / 1000, bytes: google2 },
        { name: "IMG_0003.JPG", taken_s: at("10:10:00") / 1000, bytes: google3 },
        { name: "IMG_0004.HEIC", taken_s: at("10:20:03") / 1000, bytes: google4 },
      ]);
      await settle("the Takeout and the snapshots near it");
      seen = await report("takeout");
      expect({
        joined: seen.of(PHONE, "PHONE-2/"), other_name: seen.of(GOOGLE, hexOf(google3)), three_seconds: [seen.of(PHONE, "PHONE-4/"), seen.of(GOOGLE, hexOf(google4))],
        other_clouds: [seen.of(PHONE, "PHONE-5/"), seen.of(MAC, "MAC-6/")],
      }).toEqual({
        joined: { records: [["phone", "PHONE-2/L0/001:null", 0], ["takeout", hexOf(google2), 3]], held: false, item: `photo:${hexOf(google2)}`, asked: ["phone"] },
        other_name: { records: [["takeout", hexOf(google3), 0]], held: true, item: `photo:${hexOf(google3)}`, asked: [] },
        three_seconds: [
          { records: [["phone", "PHONE-4/L0/001:null", 0]], held: false, item: "photo:apple:CLOUD-0004", asked: ["phone"] },
          { records: [["takeout", hexOf(google4), 0]], held: true, item: `photo:${hexOf(google4)}`, asked: [] },
        ],
        other_clouds: [
          { records: [["phone", "PHONE-5/L0/001:null", 0]], held: false, item: "photo:apple:CLOUD-0005", asked: ["phone"] },
          { records: [["mac", "MAC-6/L0/001:null", 0]], held: false, item: "photo:apple:CLOUD-0006", asked: ["mac"] },
        ],
      });
      const original2 = file("photo two's original");
      await phoneShip([phoneAvailability(phone2, [resource("photo", phone2.name, original2)])], [original2]);
      await settle("photo two's original");
      seen = await report("takeout-original");
      expect(seen.of(PHONE, "PHONE-2/")).toMatchObject({ held: true, item: `photo:${hexOf(original2)}`, asked: [] });

      const sizedResource = (type: "photo" | "video" | "pairedVideo", name: string, size: number) => ({ ...resource(type, name, null), size });
      const video26 = Buffer.alloc(4 << 20, "synthetic bytes of photo twenty-six's video ");
      const P26 = { cloud: "CLOUD-0026", taken: at("12:12:00"), name: "IMG_0026.MOV", media: "video" as const };
      const phone26: Snap = { lid: "PHONE-26/L0/001", ...P26 }, mac26: Snap = { lid: "MAC-26/L0/001", ...P26 };
      await macShip([{ kind: "asset", payload: { ...asset(mac26), resources: [sizedResource("video", P26.name, video26.length)] } }]);
      const google19 = googleFile("Google's copy of photo nineteen, byte for byte"), google20 = googleFile("Google's re-compressed copy of photo twenty"), google21 = googleFile("Google's copy of photo twenty-one's still");
      const VIDEO21 = 2_345_678;
      const phone19: Snap = { lid: "PHONE-19/L0/001", cloud: "CLOUD-0019", taken: at("12:00:00.300"), name: "IMG_0019.HEIC" };
      const phone20: Snap = { lid: "PHONE-20/L0/001", cloud: "CLOUD-0020", taken: at("12:05:00.300"), name: "IMG_0020.HEIC" };
      const phone21: Snap = { lid: "PHONE-21/L0/001", cloud: "CLOUD-0021", taken: at("12:10:00.300"), name: "IMG_0021.HEIC" };
      const google31 = googleFile("Google's copy of photo thirty-one's still");
      const movie31 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypqt  \0\0\0\0qt  qt  ", "latin1"), file("Google's copy of photo thirty-one's movie")]);
      const phone31: Snap = { lid: "PHONE-31/L0/001", cloud: "CLOUD-0031", taken: at("12:14:00.300"), name: "IMG_0031.HEIC" };
      await phoneShip([
        { kind: "asset", payload: { ...asset(phone19), resources: [sizedResource("photo", phone19.name, google19.length)] } },
        { kind: "asset", payload: { ...asset(phone20), resources: [sizedResource("photo", phone20.name, google20.length + 1)] } },
        { kind: "asset", payload: { ...asset(phone21), resources: [sizedResource("photo", phone21.name, google21.length), sizedResource("pairedVideo", "IMG_0021.MOV", VIDEO21)] } },
        { kind: "asset", payload: { ...asset(phone31), resources: [sizedResource("photo", phone31.name, google31.length), sizedResource("pairedVideo", "IMG_0031.MOV", movie31.length)] } },
        { kind: "asset", payload: asset(phone26) },
      ]);
      await takeoutShip([
        { name: phone19.name, taken_s: at("12:00:00") / 1000, bytes: google19 },
        { name: phone20.name, taken_s: at("12:05:00") / 1000, bytes: google20 },
        { name: phone21.name, taken_s: at("12:10:00") / 1000, bytes: google21 },
        { name: phone31.name, taken_s: at("12:14:00") / 1000, bytes: google31 },
      ], { "Takeout/Google Photos/Photos from 2026/IMG_0031.MOV": movie31 });
      await settle("the sized snapshots and their Takeout files");
      seen = await report("sized");
      const sizedAnswer = await wantedFiles(phonePass, DEVICE.phone, PHONE);
      const sized = {
        same_size: seen.of(PHONE, "PHONE-19/"), other_size: seen.of(PHONE, "PHONE-20/"), live: seen.of(PHONE, "PHONE-21/"), live_whole: seen.of(PHONE, "PHONE-31/"),
        asked: sizedAnswer.photos.filter((photo) => /^PHONE-(19|20|21|31)\//u.test(photo.asset)), left: sizedAnswer.left,
      };
      writeFileSync(join(OUT, "sized-answer.json"), `${JSON.stringify(sized, null, 2)}\n`);
      expect(sized).toEqual({
        same_size: { records: [["phone", "PHONE-19/L0/001:null", 0], ["takeout", hexOf(google19), 3]], held: true, item: `photo:${hexOf(google19)}`, asked: [] },
        other_size: { records: [["phone", "PHONE-20/L0/001:null", 0], ["takeout", hexOf(google20), 3]], held: false, item: `photo:${hexOf(google20)}`, asked: ["phone"] },
        live: { records: [["phone", "PHONE-21/L0/001:null", 0], ["takeout", hexOf(google21), 3]], held: false, item: `photo:${hexOf(google21)}`, asked: ["phone"] },
        live_whole: { records: [["phone", "PHONE-31/L0/001:null", 0], ["takeout", hexOf(google31), 3], ["takeout", hexOf(movie31), 3]], held: true, item: `photo:${hexOf(google31)}`, asked: [] },
        asked: [{ asset: "PHONE-21/L0/001", files: ["pairedVideo"] }, { asset: "PHONE-20/L0/001", files: ["photo"] }],
        left: { wanted: sizedAnswer.left.wanted, unavailable: sizedAnswer.left.unavailable, bytes: google20.length + 1 + VIDEO21 + video26.length },
      });

      await macShip([{ kind: "resource_availability", payload: availability(mac26, [resource("video", P26.name, video26)]) }], [video26]);
      await settle("photo twenty-six's video from the Mac");
      const hex26 = hexOf(video26);
      const inboxName = join(root, "inbox", MAC, "blobs", hex26), storeName = join(root, "blobs", hex26.slice(0, 2), hex26.slice(2, 4), hex26);
      const names = () => ({ inbox: existsSync(inboxName) ? statSync(inboxName).nlink : null, store: statSync(storeName).nlink, one_file: existsSync(inboxName) && statSync(inboxName).ino === statSync(storeName).ino });
      const once: Record<string, unknown> = { bytes: video26.length, imported: names() };
      await askHome(sock, "sweep");
      await until("the sweep removed the inbox's name", () => !existsSync(inboxName));
      once.swept = names();
      once.held = (await report("written-once")).of(PHONE, "PHONE-26/")?.held ?? null;
      writeFileSync(join(OUT, "written-once.json"), `${JSON.stringify(once, null, 2)}\n`);
      expect(once).toMatchObject({ imported: { inbox: 2, store: 2, one_file: true }, swept: { inbox: null, store: 1, one_file: false }, held: true });

      const askHeld = async (pass: string, headers: Record<string, string>, blobs: unknown) =>
        fetch(`${url()}/v1/blobs/held`, { method: "POST", headers: { authorization: `Bearer ${pass}`, ...headers, "content-type": "application/json" }, body: JSON.stringify({ blobs }) });
      const neverSent = `sha256:${hexOf(file("a file no device ever sent"))}`;
      const heldAnswers = {
        phone: await (await askHeld(phonePass, DEVICE.phone, [`sha256:${hexOf(google19)}`, neverSent, `sha256:${hexOf(original2)}`])).json(),
        mac: await (await askHeld(macPass, DEVICE.mac, [neverSent])).json(),
        reader: (await fetch(`${url()}/v1/blobs/held`, { method: "POST", headers: { authorization: `Bearer ${READER}`, "content-type": "application/json" }, body: JSON.stringify({ blobs: [neverSent] }) })).status,
        too_many: (await askHeld(phonePass, DEVICE.phone, Array.from({ length: 5_001 }, () => neverSent))).status,
        not_a_blob: (await askHeld(phonePass, DEVICE.phone, ["sha256:abc"])).status,
      };
      writeFileSync(join(OUT, "held.json"), `${JSON.stringify(heldAnswers, null, 2)}\n`);
      expect(heldAnswers).toEqual({
        phone: { held: [`sha256:${hexOf(google19)}`, `sha256:${hexOf(original2)}`], staged: [], partly: {} }, mac: { held: [], staged: [], partly: {} }, reader: 403, too_many: 422, not_a_blob: 422,
      });

      const original20 = file("photo twenty's original, as Apple keeps it"), original22 = file("photo twenty-two, new on the phone"), original23 = file("photo twenty-three, sent by the Mac");
      const phone22: Snap = { lid: "PHONE-22/L0/001", cloud: "CLOUD-0022", taken: at("12:15:00"), name: "IMG_0022.HEIC", bytes: original22 };
      const mac23: Snap = { lid: "MAC-23/L0/001", cloud: "CLOUD-0023", taken: at("12:20:00"), name: "IMG_0023.HEIC" };
      await macShip([{ kind: "asset", payload: asset(mac23) }]);
      await settle("photo twenty-three's snapshot");
      let counted = caughtUp();
      const caught: Record<string, number> = {};
      await phoneShip([{ kind: "asset", payload: asset(phone22) }], [original22], undefined, Date.now());
      await settle("a photo new on the phone");
      caught.new_on_the_phone = caughtUp() - counted;
      counted = caughtUp();
      await phoneShip([phoneAvailability(phone20, [resource("photo", phone20.name, original20)])], [original20], undefined, Date.now());
      await settle("photo twenty's file");
      caught.fetched_by_the_phone = caughtUp() - counted;
      counted = caughtUp();
      await phoneShip([phoneAvailability(phone20, [resource("photo", phone20.name, original20)])], [], undefined, Date.now());
      await settle("photo twenty's file named again");
      caught.named_again = caughtUp() - counted;
      counted = caughtUp();
      for (const [n, first] of [[27, "file"], [28, "snapshot"]] as const) {
        const bytes = file(`photo ${n}, new on the phone, its ${first} first`);
        const snap: Snap = { lid: `PHONE-${n}/L0/001`, cloud: `CLOUD-00${n}`, taken: at(`12:3${n - 27}:30`), name: `IMG_00${n}.HEIC` };
        const entries: Entry[] = [{ kind: "asset", payload: asset(snap) }, phoneAvailability(snap, [resource("photo", snap.name, bytes)])];
        await phoneShip(first === "file" ? entries.reverse() : entries, [bytes], undefined, Date.now());
        await settle(`photo ${n}, its ${first} first`);
        caught[`new_${first}_first`] = caughtUp() - counted;
        counted = caughtUp();
      }
      const page = await macShip([{ kind: "resource_availability", payload: availability(mac23, [resource("photo", mac23.name, original23)]) }], [original23]);
      await settle("photo twenty-three's file");
      caught.sent_by_the_mac = caughtUp() - counted;
      counted = caughtUp();
      const original25 = file("photo twenty-five, in a phone bundle of the past");
      await phoneShip([{ kind: "asset", payload: asset({ lid: "PHONE-25/L0/001", cloud: "CLOUD-0025", taken: at("12:30:00"), name: "IMG_0025.HEIC", bytes: original25 }) }], [original25]);
      await settle("a phone bundle of the past");
      caught.phone_history = caughtUp() - counted;
      writeFileSync(join(OUT, "catch-up.json"), `${JSON.stringify(caught, null, 2)}\n`);
      expect(caught).toEqual({
        new_on_the_phone: 0, fetched_by_the_phone: original20.length, named_again: 0, new_file_first: 0, new_snapshot_first: 0,
        sent_by_the_mac: original23.length + page, phone_history: expect.any(Number),
      });
      expect(caught.phone_history).toBeGreaterThan(original25.length);

      const pausing = async () => {
        const phoneSources = (await exchange(phonePass, DEVICE.phone)).sources;
        const other = Object.entries(phoneSources).find(([id]) => !id.startsWith("apple-photos:"));
        return {
          history: { phone: phoneSources[PHONE]?.history, mac: (await exchange(macPass, DEVICE.mac)).sources[MAC]?.history, other: other === undefined ? null : [other[0].split(":")[0], other[1].history] },
          files: await wantedFiles(phonePass, DEVICE.phone, PHONE),
        };
      };
      const owes = (await wantedFiles(phonePass, DEVICE.phone, PHONE)).photos[0]!.asset;
      await askHome(sock, "connectors", ["backfill", "apple-photos", "pause", "--reason", "a test holds the library's history"]);
      const paused = await pausing();
      const original24 = file("photo twenty-four, new on the phone while Photos' past is paused");
      await phoneShip([{ kind: "asset", payload: asset({ lid: "PHONE-24/L0/001", cloud: "CLOUD-0024", taken: at("12:25:00"), name: "IMG_0024.HEIC", bytes: original24 }) }], [original24]);
      await settle("a photo new on the phone while paused");
      const landed = (await report("one-pause")).of(PHONE, "PHONE-24/");
      const owing = await wantedFiles(phonePass, DEVICE.phone, PHONE, [owes, "PHONE-24/L0/001", "PHONE-99/L0/001"]);
      expect([owing.photos.map((photo) => photo.asset), owing.settled, owing.paused]).toEqual([[owes], ["PHONE-24/L0/001"], true]);
      await askHome(sock, "connectors", ["backfill", "apple-photos", "resume"]);
      const resumed = await pausing();
      const pause = { paused: { ...paused, files: { photos: paused.files.photos, paused: paused.files.paused ?? null } }, landed, resumed: { ...resumed, files: { photos: resumed.files.photos.length, paused: resumed.files.paused ?? null } } };
      writeFileSync(join(OUT, "one-pause.json"), `${JSON.stringify(pause, null, 2)}\n`);
      expect(pause).toMatchObject({
        landed: { held: true, item: `photo:${hexOf(original24)}`, asked: [] },
        resumed: { history: { phone: true, mac: true }, files: { paused: null } },
      });
      expect([pause.paused.files, pause.paused.history.phone, pause.paused.history.mac, pause.paused.history.other?.[1]])
        .toEqual([{ photos: [], paused: true }, false, false, true]);
      expect([resumed.files.photos.length > 0, paused.files.left.wanted]).toEqual([true, resumed.files.left.wanted]);

      const P7 = { taken: at("10:40:00"), cloud: "CLOUD-0007", name: "IMG_0007.HEIC" };
      const original7 = file("photo seven's original");
      const phone7: Snap = { lid: "PHONE-7/L0/001", ...P7, bytes: original7 }, mac7: Snap = { lid: "MAC-7/L0/001", ...P7 };
      await phoneShip([{ kind: "asset", payload: asset(phone7) }], [original7]);
      await macShip([{ kind: "asset", payload: asset(mac7) }]);
      await settle("photo seven");
      const before = (await report("erase-before")).of(PHONE, "PHONE-7/");
      expect(before).toMatchObject({ held: true, records: [["phone", "PHONE-7/L0/001:null", 0], ["mac", "MAC-7/L0/001:null", 2]] });
      const erased = await askHome(sock, "erase", ["photos", `photo:${hexOf(original7)}`, "--apply"]);
      await settle("the erasure");
      const edited7: Snap = { lid: phone7.lid, ...P7, mod: "2026-10-02T08:00:00Z" };
      await phoneShip([{ kind: "asset", payload: { ...asset(edited7), resources: [resource("photo", P7.name, null), resource("fullSizePhoto", "FullSizeRender.heic", null)] } }]);
      await macShip([{ kind: "asset", payload: asset(mac7) }, { kind: "asset", payload: asset({ ...mac7, mod: "2026-10-02T08:00:00Z" }) }]);
      await settle("the edit after the erasure");
      seen = await report("erase", { erased: erased as JsonObject });
      expect({ phone: seen.of(PHONE, "PHONE-7/"), mac: seen.of(MAC, "MAC-7/"), asked: [...seen.answer.phone.photos, ...seen.answer.mac.photos].filter((id) => id.includes("-7/")) })
        .toEqual({ phone: undefined, mac: undefined, asked: [] });
      expect(readHome(root, (db) => db.prepare("SELECT source, key FROM heads WHERE key LIKE '%-7/L0/001:%' ORDER BY key").all())).toEqual([
        { source: MAC, key: "MAC-7/L0/001:20261002T080000Z" }, { source: PHONE, key: "PHONE-7/L0/001:20261002T080000Z" },
      ]);

      const bareStart = Date.parse("2025-01-01T00:00:00Z");
      await macShip(Array.from({ length: BARE }, (_, n) => ({
        kind: "asset" as const, payload: asset({ lid: `BARE-${n}/L0/001`, cloud: null, taken: bareStart + n * HOUR, name: `IMG_B${n}.HEIC`, location: LYON }),
      })));
      const phone12: Snap = { lid: "PHONE-12/L0/001", cloud: "CLOUD-0012", taken: Date.parse("2026-09-21T10:00:00Z"), name: "IMG_0012.HEIC", location: PARIS };
      await phoneShip([{ kind: "asset", payload: asset(phone12) }]);
      await settle("the bare snapshots");
      seen = await report("bare-mac");
      const reader = async (path: string) => (await (await fetch(`${url()}${path}`, { headers: { authorization: `Bearer ${READER}` } })).json()) as JsonObject;
      const cameras = ((await reader("/v1/devices")).cameras as { camera: string; photos: number }[]);
      const seenUnits = readHome(root, (db) => (db.prepare("SELECT content FROM extracts WHERE family = 'physical' AND unit LIKE 'seen/%'").pluck().all() as string[])
        .map((content) => JSON.parse(content) as { source: string; photos: { camera: string | null }[] }));
      const where = async (day: string) => ((await reader(`/v1/where?from=${day}&to=${day}`)).pieces as { how: string | null; names: { point: { area: { city: string | null } } | null } }[])
        .filter((piece) => piece.how === "seen").map((piece) => piece.names.point?.area.city ?? null);
      const witnessed = {
        cameras: cameras.map(({ camera, photos }) => ({ camera, photos })),
        mac_cameras: [...new Set(seenUnits.filter((unit) => unit.source === MAC).flatMap((unit) => unit.photos.map((photo) => photo.camera)))],
        mac_photos_located: seenUnits.filter((unit) => unit.source === MAC).reduce((sum, unit) => sum + unit.photos.length, 0),
        phone_cameras: [...new Set(seenUnits.filter((unit) => unit.source === PHONE).flatMap((unit) => unit.photos.map((photo) => photo.camera)))],
        seen_on_a_bare_day: await where("2025-01-02"), seen_on_the_phone_day: await where("2026-09-21"),
      };
      writeFileSync(join(OUT, "bare-mac-witness.json"), `${JSON.stringify(witnessed, null, 2)}\n`);
      const phoneCount = seen.photos.filter((photo) => photo.records.some((record) => record.source === PHONE)).length;
      expect(witnessed.cameras.every(({ camera, photos }) => camera === `phone/${paired.unit as string}` && photos <= phoneCount)).toBe(true);
      expect(witnessed).toMatchObject({ mac_cameras: [null], mac_photos_located: BARE, phone_cameras: [`phone/${paired.unit as string}`], seen_on_a_bare_day: [], seen_on_the_phone_day: ["Paris"] });
      const timeOf = new Map(seen.photos.flatMap((photo) => photo.routes.filter((route) => route.source === MAC).map((route) => [route.asset, photo.at_ms!] as const)));
      const times = seen.answer.mac.photos.map((id) => timeOf.get(id)!);
      expect([seen.answer.mac.photos.length, times.every((time, n) => n === 0 || time <= times[n - 1]!), seen.answer.mac.photos.slice(0, 2)])
        .toEqual([1_000, true, ["MAC-6/L0/001", "BARE-1099/L0/001"]]);
      expect(seen.answer.mac.left.wanted).toBe(seen.photos.filter((photo) => photo.routes.some((route) => !route.refused)).length);

      const P13 = { taken: Date.parse("2026-09-22T10:00:00Z"), cloud: "CLOUD-0013", name: "IMG_0013.JPG", location: PARIS };
      const mac13: Snap = { lid: "MAC-13/L0/001", ...P13 };
      await phoneShip([{ kind: "asset", payload: asset({ lid: "PHONE-13/L0/001", ...P13 }) }]);
      await macShip([{ kind: "asset", payload: asset(mac13) }]);
      await settle("photo thirteen's snapshots");
      const cameraOf13 = () => readHome(root, (db) => (JSON.parse((db.prepare("SELECT content FROM extracts WHERE family = 'physical' AND unit = ?").pluck().get(`seen/${PHONE}/2026-09-22`) as string | undefined) ?? '{"photos":[]}') as { photos: { camera: string | null }[] }).photos.map((photo) => photo.camera));
      const witness: Record<string, unknown> = { before: { cameras: cameraOf13(), seen: await where("2026-09-22") } };
      const stranger = jpeg("Stranger Make", "Stranger Camera", "photo thirteen");
      await macShip([{ kind: "resource_availability", payload: availability(mac13, [resource("photo", P13.name, stranger)]) }], [stranger]);
      await settle("photo thirteen's file from the Mac");
      await until("the stranger's camera names the phone's photo", () => cameraOf13()[0] === "stranger-make/stranger-camera");
      witness.after = { cameras: cameraOf13(), seen: await where("2026-09-22") };
      writeFileSync(join(OUT, "owner-witness.json"), `${JSON.stringify(witness, null, 2)}\n`);
      expect(witness).toEqual({
        before: { cameras: [`phone/${paired.unit as string}`], seen: ["Paris"] },
        after: { cameras: ["stranger-make/stranger-camera"], seen: [] },
      });

      const P8 = { taken: at("10:50:00"), cloud: "CLOUD-0008", name: "IMG_0008.HEIC" };
      const phone8: Snap = { lid: "PHONE-8/L0/001", ...P8 }, mac8: Snap = { lid: "MAC-8/L0/001", ...P8 };
      await phoneShip([{ kind: "asset", payload: asset(phone8) }]);
      await macShip([{ kind: "asset", payload: asset(mac8) }]);
      await settle("photo eight");
      const refusals: Record<string, unknown> = { stated: (await report("refusal-stated")).of(PHONE, "PHONE-8/") };
      expect(refusals.stated).toMatchObject({ asked: ["mac"] });
      await macShip([{ kind: "resource_availability", payload: availability(mac8, [resource("photo", P8.name, null, "not_found")]) }]);
      await settle("the Mac's refusal");
      seen = await report("refusal-mac");
      refusals.mac_refused = seen.of(PHONE, "PHONE-8/");
      expect(refusals.mac_refused).toMatchObject({ asked: ["phone"] });
      const unavailable = { phone: seen.answer.phone.left.unavailable, mac: seen.answer.mac.left.unavailable };
      await phoneShip([phoneAvailability(phone8, [resource("photo", P8.name, null, "download_failed")])]);
      await settle("the phone's refusal");
      seen = await report("refusal-both");
      expect([seen.of(PHONE, "PHONE-8/")!.asked, seen.answer.phone.left.unavailable - unavailable.phone, seen.answer.mac.left.unavailable - unavailable.mac]).toEqual([[], 1, 1]);
      await phoneShip([{ kind: "asset", payload: asset({ ...phone8, mod: "2026-10-03T08:00:00Z" }) }]);
      await settle("photo eight stated anew");
      seen = await report("refusal-restated");
      expect([seen.of(PHONE, "PHONE-8/")!.asked, seen.answer.phone.left.unavailable - unavailable.phone]).toEqual([["phone"], 0]);

      const original9 = file("photo nine's original");
      const phone9: Snap = { lid: "PHONE-9/L0/001", cloud: "CLOUD-0009", taken: at("11:00:00"), name: "IMG_0009.HEIC", bytes: original9 };
      await phoneShip([{ kind: "asset", payload: asset(phone9) }], [], 1);
      await settle("the resent snapshot");
      seen = await report("restored-lacking");
      expect(seen.of(PHONE, "PHONE-9/")).toMatchObject({ held: false, asked: ["phone"] });
      await phoneShip([phoneAvailability(phone9, [resource("photo", phone9.name, original9)])], [original9]);
      await settle("the file sent again");
      seen = await report("restored-sent");
      expect(seen.of(PHONE, "PHONE-9/")).toMatchObject({ held: true, asked: [] });

      const records = () => readHome(root, (db) => db.prepare("SELECT key, version FROM heads WHERE source = ? ORDER BY key").all(PHONE));
      const versions = records();
      await phoneShip([phone1, phone2, phone4, phone5, phone9, phone12].map((snap) => ({ kind: "asset" as const, payload: asset(snap) }))
        .concat([{ kind: "asset", payload: { ...asset(edited7), resources: [resource("photo", P7.name, null), resource("fullSizePhoto", "FullSizeRender.heic", null)] } }, { kind: "asset", payload: asset({ ...phone8, mod: "2026-10-03T08:00:00Z" }) }]),
      [original9]);
      await settle("the whole read");
      seen = await report("pruned", { heads_before: versions.length, heads_after: records().length });
      expect(records()).toEqual(versions);

      const original14 = file("photo fourteen's original"), video14 = file("photo fourteen's video");
      const phone14: Snap = { lid: "PHONE-14/L0/001", cloud: "CLOUD-0014", taken: at("11:30:00"), name: "IMG_0014.HEIC" };
      await phoneShip([{ kind: "asset", payload: { ...asset(phone14), resources: [resource("photo", phone14.name, original14), resource("pairedVideo", "IMG_0014.MOV", null)] } }], [original14]);
      await settle("a Live Photo without its video");
      seen = await report("live-photo-part");
      expect(seen.of(PHONE, "PHONE-14/")).toMatchObject({ held: false, item: `photo:${hexOf(original14)}`, asked: ["phone"] });
      await phoneShip([phoneAvailability(phone14, [resource("photo", phone14.name, original14), resource("pairedVideo", "IMG_0014.MOV", video14)])], [original14, video14]);
      await settle("the Live Photo whole");
      seen = await report("live-photo-whole");
      expect(seen.of(PHONE, "PHONE-14/")).toMatchObject({ held: true, asked: [] });

      const original18 = file("photo eighteen's original");
      const phone18: Snap = { lid: "PHONE-18/L0/001", cloud: "CLOUD-0018", taken: at("11:40:00"), name: "IMG_0018.HEIC" };
      const stated18: Entry[] = [
        { kind: "asset", payload: asset(phone18) }, phoneAvailability(phone18, [resource("photo", phone18.name, original18)]),
        { kind: "asset", payload: asset({ ...phone18, mod: "2026-10-04T08:00:00Z" }) },
      ];
      await phoneShip(stated18, [original18]);
      await settle("photo eighteen and its edit");
      const shownOn20 = async () => ((await reader("/v1/days/2026-09-20?file=json")).atoms as { family: string; item?: string }[]).filter((atom) => atom.family === "photos").map((atom) => atom.item);
      const inBursts = () => readHome(root, (db) => (db.prepare("SELECT content FROM extracts WHERE family = 'photos' AND unit LIKE 'burst/%'").pluck().all() as string[])
        .flatMap((content) => (JSON.parse(content) as { photos: { photo: string }[] }).photos.map((photo) => photo.photo)).filter((photo) => photo.includes("PHONE-18/")));
      const gone: Record<string, unknown> = { before: { photo: (await report("gone-before")).of(PHONE, "PHONE-18/"), bursts: inBursts(), day: (await shownOn20()).includes(`photo:${hexOf(original18)}`) } };
      expect(gone.before).toMatchObject({ photo: { held: false, asked: ["phone"] }, bursts: [`${PHONE}/PHONE-18/L0/001`], day: true });
      await phoneShip(stated18.map((entry) => ({ kind: "gone" as const, payload: { of: entry.kind, payload: entry.payload } })));
      await settle("photo eighteen gone");
      seen = await report("gone-after");
      gone.after = {
        photo: seen.of(PHONE, "PHONE-18/") ?? null, bursts: inBursts(), day: (await shownOn20()).includes(`photo:${hexOf(original18)}`),
        asked: [...seen.answer.phone.photos, ...seen.answer.mac.photos].filter((id) => id.startsWith("PHONE-18/")), file: named(hexOf(original18)),
      };
      writeFileSync(join(OUT, "gone.json"), `${JSON.stringify(gone, null, 2)}\n`);
      expect(gone.after).toEqual({ photo: null, bursts: [], day: false, asked: [], file: 1 });

      const phone15: Snap = { lid: "PHONE-15/L0/001", cloud: "CLOUD-0015", taken: at("11:50:00.200"), name: "IMG_0015.HEIC" };
      const mac16: Snap = { lid: "MAC-16/L0/001", cloud: "CLOUD-0016", taken: at("11:50:00.600"), name: "IMG_0015.HEIC" };
      const google15 = googleFile("a Google file named like two photos");
      await phoneShip([{ kind: "asset", payload: asset(phone15) }]);
      await macShip([{ kind: "asset", payload: asset(mac16) }]);
      await takeoutShip([{ name: "IMG_0015.HEIC", taken_s: at("11:50:00") / 1000, bytes: google15 }]);
      await settle("a file that meets two photos");
      seen = await report("a-t-b");
      expect({ a: seen.of(PHONE, "PHONE-15/"), b: seen.of(MAC, "MAC-16/"), t: seen.of(GOOGLE, hexOf(google15)) }).toEqual({
        a: { records: [["phone", "PHONE-15/L0/001:null", 0]], held: false, item: "photo:apple:CLOUD-0015", asked: ["phone"] },
        b: { records: [["mac", "MAC-16/L0/001:null", 0]], held: false, item: "photo:apple:CLOUD-0016", asked: ["mac"] },
        t: { records: [["takeout", hexOf(google15), 0]], held: true, item: `photo:${hexOf(google15)}`, asked: [] },
      });

      const otherPass = randomBytes(32).toString("base64url");
      const OTHER = `apple-photos:${ACCOUNT}:macbook-pro-ff99`;
      const other = await post({ code: ((await askHome(sock, "pair", [])) as { code: string }).code, pass: otherPass, kind: "mac", model: "MacBook Pro", serial4: "ff99", offers: [OTHER] }, DEVICE.mac);
      expect(other.unit).toBe("macbook-pro-ff99");
      const P10 = { taken: at("11:10:00"), cloud: "CLOUD-0010", name: "IMG_0010.HEIC" };
      const P17 = { taken: at("11:15:00"), cloud: "CLOUD-0017", name: "IMG_0017.HEIC" };
      await phoneShip([{ kind: "asset", payload: asset({ lid: "PHONE-10/L0/001", ...P10 }) }]);
      await macShip([{ kind: "asset", payload: asset({ lid: "MAC-10/L0/001", ...P10 }) }, { kind: "asset", payload: asset({ lid: "MAC-17/L0/001", ...P17 }) }]);
      await macShip([{ kind: "asset", payload: asset({ lid: "OTHER-17/L0/001", ...P17 }) }], [], { pass: otherPass, source: OTHER });
      await settle("photos ten and seventeen");
      const otherAsks = async () => (await ask(otherPass, DEVICE.mac, OTHER)).body.photos.filter((id) => id === "OTHER-17/L0/001");
      seen = await report("quiet-asking");
      const quiet: Record<string, unknown> = { asking: { ten: seen.of(PHONE, "PHONE-10/"), seventeen: seen.answer.mac.photos.includes("MAC-17/L0/001"), other: await otherAsks() } };
      expect(quiet.asking).toMatchObject({ ten: { asked: ["mac"] }, seventeen: true, other: [] });
      skew = HOUR + 60_000;
      const phoneAsked = async () => (await ask(phonePass, DEVICE.phone, PHONE)).body.photos.filter((id) => id === "PHONE-10/L0/001");
      quiet.an_hour_on = { other: await otherAsks(), phone: await phoneAsked() };
      const macPage = (page: number) => macShip([{ kind: "asset", payload: asset({ lid: `MAC-PAGE-${page}/L0/001`, cloud: null, taken: at(`09:0${page}:00`), name: `IMG_090${page}.HEIC` }) }]);
      quiet.paging = [];
      for (const page of [1, 2, 3]) {
        skew += 50 * 60_000;
        await macPage(page);
        expect((await ask(macPass, DEVICE.mac, MAC)).status).toBe(200);
        (quiet.paging as unknown[]).push({ minutes_on: Math.round(skew / 60_000), phone: await phoneAsked() });
      }
      const asked = skew;
      quiet.stopped_asking = [];
      for (const [page, since] of [[4, 50], [5, 70]] as const) {
        skew = asked + since * 60_000;
        await macPage(page);
        (quiet.stopped_asking as unknown[]).push({ minutes_since_its_ask: since, phone: await phoneAsked() });
      }
      expect([quiet.paging, quiet.stopped_asking]).toEqual([
        [{ minutes_on: 111, phone: [] }, { minutes_on: 161, phone: [] }, { minutes_on: 211, phone: [] }],
        [{ minutes_since_its_ask: 50, phone: [] }, { minutes_since_its_ask: 70, phone: ["PHONE-10/L0/001"] }],
      ]);
      expect((await ask(macPass, DEVICE.mac, MAC)).status).toBe(200);
      seen = await report("quiet-mac-back");
      quiet.mac_back = { ten: seen.of(PHONE, "PHONE-10/"), other: await otherAsks() };
      expect(quiet).toMatchObject({ an_hour_on: { other: ["OTHER-17/L0/001"], phone: ["PHONE-10/L0/001"] }, mac_back: { ten: { asked: ["mac"] }, other: [] } });
      writeFileSync(join(OUT, "quiet.json"), `${JSON.stringify(quiet, null, 2)}\n`);

      await door.close();
      const free = freeSpace(4e9);
      door = await serve();
      const phone11: Snap = { lid: "PHONE-11/L0/001", cloud: "CLOUD-0011", taken: at("11:20:00"), name: "IMG_0011.HEIC" };
      await phoneShip([{ kind: "asset", payload: asset(phone11) }], [], undefined, Date.now() - 3_600_000);
      await until("a photo landed while the disk is short, and its photo read", () => count("SELECT count(*) FROM deliveries WHERE source = ? AND state = 'imported'", PHONE) === shipped[PHONE] && photoWith(stored(), PHONE, "PHONE-11/") !== undefined);
      seen = await report("disk-short");
      expect([seen.answer.phone.photos, seen.answer.mac.photos, seen.answer.phone.left.wanted > 0, seen.of(PHONE, "PHONE-11/")?.records])
        .toEqual([[], [], true, [["phone", "PHONE-11/L0/001:null", 0]]]);
      await door.close();
      free.set(1e12);
      door = await serve();
      const again = (await ask(phonePass, DEVICE.phone, PHONE)).body;
      expect([again.photos.includes("PHONE-10/L0/001"), again.photos.includes("PHONE-11/L0/001")]).toEqual([false, true]);
      const refused = {
        reader: (await fetch(`${url()}/v1/photos/wanted?source=${encodeURIComponent(MAC)}`, { headers: { authorization: `Bearer ${READER}` } })).status,
        mac_for_phone: (await ask(macPass, DEVICE.mac, PHONE)).status,
        none: (await fetch(`${url()}/v1/photos/wanted`, { headers: { authorization: `Bearer ${macPass}`, ...DEVICE.mac } })).status,
      };
      writeFileSync(join(OUT, "named.json"), `${JSON.stringify(refused, null, 2)}\n`);
      expect(refused).toEqual({ reader: 403, mac_for_phone: 403, none: 422 });
    } finally {
      await door.close();
      await home.stop();
    }
  });
});
