import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Connector } from "@lifestreamprotocol/connect";
import { declarations } from "@lifestreamprotocol/connect";
import { DAYS_MARK, openHome, openHomeFolder, type BlobStore, type DaySettings, type ExtractRow, type HomeDb, type OpenView, type ReaderOutput, type SourceRow } from "@lifestreamprotocol/core";
import { BURST_UNIT, messagesFamily, networksIn, photoRoutesIn, photosFamily, renderDay, type BurstContent } from "@lifestreamprotocol/families";
import { HomeFile } from "./home-file.js";
import { kindsAnswer, type KindsHit } from "./kinds-contract.js";
import { photoFrom, preparedFile, readPhoto, unheldWords, type Photo, type PhotoInput } from "./photo.js";
import { openReads, type Reply } from "./reads.js";
import { readRef } from "./refs.js";
import type { Registry } from "./registry.js";
import { connectors } from "./registry-home.js";
import { SearchIndex, searchFileOf, type RecordEntry } from "./search-index.js";
import { effective, type Settings } from "./settings.js";
import type { Network, Stated, Statement } from "./stated.js";
import { RELEASE_FED } from "./test/fed.js";
import { makeRoot, removeRoot, REPO } from "./test/harness-root.js";

const ALBUM = {
  id: "example-album", product: "example-album", name: "Example Album", vendor: "example", type: "photos", records: "Synthetic photos.",
  sources: [{ id: "example-album:<account>:export", read: "example-album-export", arrives: "upload" }],
} as unknown as Connector;
const CONNECTORS: readonly Connector[] = [...declarations(), ALBUM];

function row(id: string, connector: string): SourceRow {
  const [product, account, copy] = id.split(":") as [string, string, string];
  return { id, product, account, copy, vendor: "example", connector, options: {}, read_through_ms: null, added_ms: 0 };
}

const route = (rank: number, library: boolean, source: SourceRow) => ({ rank, library, row: source });

describe("where a photo came from", () => {
  it("F1 F3: a paired device's library is that device; any other route its product", () => {
    expect(photoFrom(route(0, true, row("apple-photos:person-a@example.com:iphone-aa01", "photos-ios-bundle")), CONNECTORS)).toBe("phone");
    expect(photoFrom(route(1, true, row("apple-photos:person-a@example.com:macbook-pro-0001", "photos-mac-bundle")), CONNECTORS)).toBe("mac");
    expect(photoFrom(route(2, false, row("google-photos:person-a@example.com:export", "google-photos-takeout")), CONNECTORS)).toBe("google-photos");
    expect(photoFrom(route(3, false, row("camera:local:iphone-aa01", "camera-ios-bundle")), CONNECTORS)).toBe("camera");
  });

  it("F2: a home connector's photos are its own product's at any rank", () => {
    for (const rank of [2, 4]) expect(photoFrom(route(rank, false, row("example-album:person-a@example.com:export", "example-album-export")), CONNECTORS)).toBe("example-album");
  });
});

describe("why a photo shows no picture", () => {
  const PHONE = "apple-photos:person-a@example.com:iphone-aa01";
  const MAC = "apple-photos:person-a@example.com:macbook-pro-0001";
  const CLOUD = "google-photos:person-a@example.com:export";
  const sources = new Map([PHONE, MAC, CLOUD].map((id) => [id, row(id, "photos-ios-bundle")]));
  const view = {
    source: (id: string) => sources.get(id),
    tables: {
      meta: { get: (key: string) => (key === "name:iphone-aa01" ? "Example Phone" : undefined) },
      devices: { get: (unit: string) => (unit === "iphone-aa01" ? { model: "iPhone" } : unit === "macbook-pro-0001" ? { model: "MacBook Pro" } : undefined) },
    },
  } as unknown as OpenView;
  const said = (room: "ok" | "full", allows: Network): Statement => ({ room: { value: room, since_ms: 0 }, network: { value: { allows, loopback: false }, since_ms: 0 } }) as unknown as Statement;
  const wanted = (...routes: [string, boolean][]) => ({
    video: false, wanted: { at_ms: 0, missing: [], routes: routes.map(([source, refused]) => ({ source, asset: "asset-0001", files: ["photo"], refused })) },
  });

  it("U2: a device that can send it is named as where it comes from, before one that waits", () => {
    const stated: Stated = { "iphone-aa01": said("ok", "low-data"), "macbook-pro-0001": said("ok", "all") };
    expect(unheldWords(view, stated, wanted([PHONE, false], [MAC, false]))).toBe("no picture yet: on its way from MacBook Pro");
    expect(unheldWords(view, {}, wanted([PHONE, false]))).toBe("no picture yet: on its way from Example Phone");
  });

  it("U3: a library that refused it on every route says it cannot send it; a refused route never waits for it", () => {
    expect(unheldWords(view, {}, wanted([PHONE, true]))).toBe("no picture: the library on Example Phone cannot send it");
    expect(unheldWords(view, { "iphone-aa01": said("ok", "now") }, wanted([PHONE, true], [MAC, false]))).toBe("no picture yet: on its way from MacBook Pro");
  });

  it("U4: a copy that is no device names none; a photo no library wants says only that none is held", () => {
    expect(unheldWords(view, {}, wanted([CLOUD, false]))).toBe("no picture yet: on its way");
    expect(unheldWords(view, {}, { video: true, wanted: null })).toBe("no video held");
  });
});

describe("what a photo plays", () => {
  const LIBRARY = "apple-photos:person-a@example.com:iphone-aa01";
  const WHATSAPP = "whatsapp:+15550000001:iphone-aa01";
  const PARTNER = "15550000002@s.whatsapp.net";
  const DAY: DaySettings = { zone: "UTC", day_start_hour: 4 };
  const T0 = Date.UTC(2026, 9, 14, 9, 0);
  const NOW = T0 + 86_400_000;
  const photos = photosFamily({ faces: false })(RELEASE_FED.photos);
  const messages = messagesFamily({ books: RELEASE_FED.labels })(RELEASE_FED.messages);
  const bytes = (what: string) => Buffer.from(`synthetic bytes of ${what}`);
  const [STILL, LIVE, MOTION, VIDEO, CHAT] = ["a still", "a live photo's still", "a live photo's motion", "a video", "a chat's video"].map(bytes) as [Buffer, Buffer, Buffer, Buffer, Buffer];
  let root: string;
  let db: HomeDb;
  let blobs: BlobStore;
  let input: PhotoInput;
  const answers: Record<string, unknown> = {};

  const snapshot = (local: string, at_ms: number, media_type: "image" | "video", resources: [string, string, Buffer, string][], duration: number | null = null): ReaderOutput => {
    const stated = resources.map(([type, name, file, type_]) => ({ type, original_filename: name, size: file.length, blob: { hash: blobs.put(file), bytes: file.length, type: type_, role: type } }));
    return {
      kind: "img", key: `${local}:null`, time: { start_ms: at_ms, precision: "ms" }, blobs: stated.map((each) => each.blob.hash),
      content: { type: "photos.apple.asset", content: { local_identifier: local, media_type, creation_date: new Date(at_ms).toISOString(), modification_date: null, duration, resources: stated } },
    };
  };
  const land = (source: string, rows: ReaderOutput[]) => db.commit((tx) => {
    const run = tx.tables.runs.start({ kind: "import", subject: source, started_ms: T0 });
    tx.records.land(run, { id: `${source}/1`, source, stated_ms: T0 }, rows, Object.fromEntries(rows.map((row) => [row.kind, () => []])), { has: () => true });
    tx.tables.runs.end(run, { ended_ms: T0, outcome: "ok" });
  });
  const burst = (at_ms: number) => {
    const view = db.view();
    let row: ExtractRow;
    try {
      const built = photos.extract(`${BURST_UNIT}${at_ms}`, view, blobs)!;
      row = { family: photos.name, unit: `${BURST_UNIT}${at_ms}`, code: photos.code, seq: view.through, days: [], ...built };
      row.days = photos.days(row, DAY);
    } finally {
      view.close();
    }
    db.commit((tx) => tx.derived.extracts.put(row));
  };
  const read = <T>(work: (view: OpenView) => T): T => {
    const view = db.view();
    try {
      return work(view);
    } finally {
      view.close();
    }
  };
  const facts = (file: Buffer) => read((view) => readPhoto(view, hexOf(file), input)?.photo);
  const hexOf = (file: Buffer) => createHash("sha256").update(file).digest("hex");
  const fixture = (name: string, value: unknown) => {
    const file = join(REPO, "homelink", "Tests", "Fixtures", `${name}.json`);
    const written = `${JSON.stringify(value, null, 2)}\n`;
    if (process.env.LIFESTREAM_FIXTURES === "write") writeFileSync(file, written);
    expect(existsSync(file) ? readFileSync(file, "utf8") : "", `homelink/Tests/Fixtures/${name}.json is this read: LIFESTREAM_FIXTURES=write writes it`).toBe(written);
  };

  beforeAll(() => {
    root = makeRoot("lifestream-photo-", { sources: {} });
    db = openHome(openHomeFolder(root), "migrate");
    blobs = openHomeFolder(root).blobs(join(root, "blobs"));
    db.commit((tx) => {
      tx.tables.sources.add({ id: LIBRARY, vendor: "apple", connector: "photos-ios-bundle", added_ms: 0 });
      tx.tables.sources.add({ id: WHATSAPP, vendor: "meta", connector: "whatsapp-ios", added_ms: 0 });
    });
    land(LIBRARY, [
      snapshot("STILL-1/L0/001", T0, "image", [["photo", "IMG_0001.JPG", STILL, "image/jpeg"]]),
      snapshot("LIVE-1/L0/001", T0 + 600_000, "image", [["photo", "IMG_0002.HEIC", LIVE, "image/heic"], ["pairedVideo", "IMG_0002.MOV", MOTION, "video/quicktime"]]),
      snapshot("VIDEO-1/L0/001", T0 + 1_200_000, "video", [["video", "IMG_0003.MOV", VIDEO, "video/quicktime"]], 42.4),
    ]);
    const chat = blobs.put(CHAT);
    land(WHATSAPP, [{
      kind: "msg", key: `${PARTNER}:STANZA-1`, time: { start_ms: T0 + 1_800_000, precision: "ms" }, blobs: [chat],
      content: { type: "whatsapp.msg", session_jid: PARTNER, message: { ZMESSAGETYPE: 2, ZISFROMME: 0, ZFROMJID: PARTNER, ZTEXT: null }, blobs: [{ hash: chat, bytes: CHAT.length, role: "ZWAMEDIAITEM.ZMEDIALOCALPATH" }] },
    }]);
    for (const at_ms of [T0, T0 + 600_000, T0 + 1_200_000]) burst(at_ms);
    const { connectors: blocks, defaults, runners } = effective(root).settings;
    input = {
      day: DAY, unit: null, now_ms: NOW, people: preparedFile(openHomeFolder(dirname(join(root, "no-people.db"))), join(root, "no-people.db"), "people"), places: preparedFile(openHomeFolder(dirname(join(root, "no-places.db"))), join(root, "no-places.db"), "places"),
      made: { connectors: connectors(), blocks, defaults, runners, day: DAY, now_ms: NOW, reply: () => undefined },
      networks: networksIn([messages]), photos: photoRoutesIn([photos]),
    };
  });

  afterAll(() => {
    db.close();
    removeRoot(root);
  });

  it("P1 P2: a video plays itself, a Live Photo its motion, a chat's video itself; a still plays nothing", () => {
    const play = (file: Buffer) => {
      const photo = facts(file)!;
      return { kind: photo.kind, play: photo.play };
    };
    expect({ video: play(VIDEO), live: play(LIVE), chat: play(CHAT), still: play(STILL) }).toEqual({
      video: { kind: "video", play: { hash: `sha256:${hexOf(VIDEO)}`, media_type: "video/quicktime", live: false } },
      live: { kind: "image", play: { hash: `sha256:${hexOf(MOTION)}`, media_type: "video/quicktime", live: true } },
      chat: { kind: "video", play: { hash: `sha256:${hexOf(CHAT)}`, media_type: "video/mp4", live: false } },
      still: { kind: "image", play: null },
    });
    const answer = (photo: Photo | undefined) => ({ photo, position: `1:${T0}` });
    Object.assign(answers, { video: answer(facts(VIDEO)), live: answer(facts(LIVE)), chat: answer(facts(CHAT)), still: answer(facts(STILL)) });
    fixture("photo-play", answers);
    const day = read((view) => JSON.parse(renderDay("2026-10-14", [photos], view, DAY, () => undefined).json) as { atoms: { text: string; end_ms: number | null; video?: unknown; live?: unknown }[] });
    expect(day.atoms.map(({ text, end_ms, video, live }) => ({ text, end_ms, video, live }))).toEqual([
      { text: "Image", end_ms: null, video: undefined, live: undefined }, { text: "Image", end_ms: null, video: undefined, live: true },
      { text: "Video: 42s", end_ms: null, video: { duration_ms: 42_400 }, live: undefined },
    ]);
    fixture("day-video", { ...day, renderer: "pinned", inputs: `sha256:${"0".repeat(64)}` });
  });

  it("P3: a burst's row an older code wrote (no `motion`, no `duration_ms`), or one under the name the older join gave it, answers what it holds", () => {
    const rows = read((view) => [...view.extractsUnder(photos.name, BURST_UNIT)]);
    const live = rows.find((row) => row.start_ms === T0 + 600_000)!;
    const renamed = `${BURST_UNIT}${T0 + 599_700}`;
    db.commit((tx) => {
      for (const row of rows) {
        const content = { photos: (row.content as unknown as BurstContent).photos.map(({ duration_ms: _length, motion: _motion, ...entry }) => entry) } as unknown as ExtractRow["content"];
        tx.derived.extracts.put(row === live ? { ...row, unit: renamed, start_ms: T0 + 599_700, code: "11", content } : { ...row, code: "11", content });
      }
      tx.derived.extracts.delete(photos.name, live.unit);
    });
    const answer = (file: Buffer) => {
      const photo = facts(file)!;
      return { kind: photo.kind, unit: photo.unit, play: photo.play };
    };
    expect({ video: answer(VIDEO), live: answer(LIVE), still: answer(STILL) }).toEqual({
      video: { kind: "video", unit: `${BURST_UNIT}${T0 + 1_200_000}`, play: { hash: `sha256:${hexOf(VIDEO)}`, media_type: "video/quicktime", live: false } },
      live: { kind: "image", unit: renamed, play: null },
      still: { kind: "image", unit: `${BURST_UNIT}${T0}`, play: null },
    });
    db.commit((tx) => tx.derived.extracts.delete(photos.name, renamed));
    for (const at_ms of [T0, T0 + 600_000, T0 + 1_200_000]) burst(at_ms);
    expect(answer(LIVE)).toEqual({ kind: "image", unit: `${BURST_UNIT}${T0 + 600_000}`, play: { hash: `sha256:${hexOf(MOTION)}`, media_type: "video/quicktime", live: true } });
  });

  it("P4: a photo's hit on the kinds route, asked through the door, states the image its record's photo opens as; a hit of another family states none", async () => {
    db.commit((tx) => tx.tables.meta.set(DAYS_MARK, "test"));
    const machine = join(root, "machine");
    const file = searchFileOf(root, machine);
    const entry = (record: RecordEntry["record"], family: string, at_ms: number, text: string): RecordEntry => ({ record, family, version: `v-${record.key}`, start_ms: at_ms, end_ms: null, title: "", text, who: [], link: null });
    const writer = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, DAY);
    writer.records([
      entry({ source: LIBRARY, kind: "img", key: "STILL-1/L0/001:null" }, photos.name, T0, "the harbor at dawn"),
      entry({ source: LIBRARY, kind: "img", key: "VIDEO-1/L0/001:null" }, photos.name, T0 + 1_200_000, "the harbor at noon"),
      entry({ source: "notes:local:macbook-pro-0001", kind: "note", key: "n1" }, "notes", T0, "harbor notes"),
    ], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
    writer.finish();
    writer.close();
    const reads = openReads({
      folder: openHomeFolder(root), home: new HomeFile(openHomeFolder(root)), blobs, settings: () => ({ day: DAY }) as Settings,
      registry: { connectors: [], readers: [], families: [photos, messages] } as unknown as Registry,
    });
    const url = "/v1/search/kinds?query=harbor";
    const reply = await (reads.reply("/v1/search/kinds")!({ url, now_ms: NOW, held: { machine } as never }) as Reply | Promise<Reply>);
    expect(reply.status ?? 200, String(reply.body)).toBe(200);
    const shown = kindsAnswer.parse(JSON.parse(String(reply.body)));
    const hits: KindsHit[] = [...shown.top.flatMap((row) => ("hit" in row ? [row.hit] : [])), ...shown.kinds.flatMap((each) => ("hits" in each ? each.hits : []))];
    const keyOf = (ref: string) => readRef(ref, "ref", ["record"]).parts.key;
    expect(hits.filter((hit) => hit.family === "photos").map((hit) => [keyOf(hit.ref), hit.image]).sort()).toEqual([
      ["STILL-1/L0/001:null", `sha256:${hexOf(STILL)}`], ["VIDEO-1/L0/001:null", `sha256:${hexOf(VIDEO)}`],
    ]);
    expect(hits.filter((hit) => hit.family !== "photos").map((hit) => [keyOf(hit.ref), hit.image])).toEqual([["n1", undefined]]);
  });
});
