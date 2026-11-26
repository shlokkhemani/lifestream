import { accountOf, civilDay, isSqliteError, type DaySettings, type ExtractRow, type HomeFolder, type OpenView, type RecordRef, type SourceRow, type Version } from "@lifestreamprotocol/core";
import { roadsOf, type cameras, type Connector } from "@lifestreamprotocol/connect";
import {
  areaOf, asksCaption, BURST_GAP_MS, BURST_UNIT, burstOf, burstUnitOf, cameraFiles, cameraOf, captionContentOf, copyOf, joinedOf, LABELS_FAMILY, labelsFrom, MESSAGES_FAMILY, PHOTO_CAPTION,
  PHOTO_KINDS, PHOTOS_FAMILY, PhotoRoutes, nameId, readCamera, recordFocus, resolveChat, resolvedChat, shownCopy, unavailable, unitFocus, type BurstPhoto, type Networks, type Unshown,
} from "@lifestreamprotocol/families";
import { catalogOf, declaredOf } from "./catalog.js";
import { cameraNamed, shownName } from "./devices.js";
import { damaged, PEOPLE, PLACES, readPrepared, type PreparedRead } from "./prepared.js";
import { openMade, type MadeInput } from "./made.js";
import { notNow, RETRY_SOON_S } from "./refusal.js";
import type { Stated } from "./stated.js";
import type { Made } from "./streams-report.js";


interface PlaceHead {
  name: string;
  latitude: number;
  longitude: number;
  radius_m: number;
  area: Area;
}

interface Area {
  city: string | null;
  region: string | null;
  country: string | null;
}

export interface Photo {
  hash: string;
  kind: Exclude<BurstPhoto["kind"], null>;
  play: { hash: string; media_type: string; live: boolean } | null;
  at_ms: number | null;
  unit: string | null;
  day: string | null;
  focus: string | null;
  caption: string | null;
  described: Made;
  people: { id: string; name: string; me: boolean; box: number[] | null; photo: unknown }[];
  size: { width: number; height: number } | null;
  place: ({ slug: string } & PlaceHead) | null;
  area: Area | null;
  camera: { id: string; name: string; mine: boolean } | null;
  from: string | null;
  chat: {
    network: string; chat: string; title: string; group: boolean; sender: { id: string; name: string } | null; mine: boolean;
    at_ms: number; day: string; record: RecordRef; focus: string;
  } | null;
}

export function focusOf(photo: Pick<Photo, "unit" | "chat">): string | null {
  return photo.unit !== null ? unitFocus(photo.unit) : photo.chat === null ? null : photo.chat.focus;
}

export function withoutChat(photo: Photo): Photo {
  const unchatted = { ...photo, chat: null };
  return { ...unchatted, day: photo.at_ms === null ? null : photo.day, focus: focusOf(unchatted) };
}

export type PreparedFile = <T>(read: (file: PreparedRead) => T) => T | undefined;

export interface PhotoInput {
  day: DaySettings;
  unit: string | null;
  now_ms: number;
  people: PreparedFile;
  places: PreparedFile;
  made: MadeInput;
  networks: Networks;
  photos: PhotoRoutes;
}

export function photoFrom(route: { library: boolean; row: SourceRow }, connectors: readonly Connector[]): string {
  const connector = route.library ? catalogOf(connectors).of(route.row) : undefined;
  const device = connector === undefined ? undefined : roadsOf(declaredOf(connector, route.row)).find((road) => DEVICES.includes(road));
  return device ?? route.row.product;
}

const DEVICES: readonly string[] = ["phone", "mac"];

export interface HeldPhoto {
  photo: Photo;
  accounts: readonly string[];
}

export function photoOfRecord<T>(view: OpenView, version: string, photo: (hex: string) => T | undefined): T | undefined {
  for (const blob of view.blobsOf(version)) {
    const held = photo(blob.replace(/^sha256:/u, ""));
    if (held !== undefined) return held;
  }
  return undefined;
}

export function unheldWords(view: OpenView, stated: Stated, unshown: Unshown): string {
  const what = unshown.video ? "video" : "picture";
  const wanted = unshown.wanted;
  if (wanted === null || wanted.routes.length === 0) return `no ${what} held`;
  if (unavailable(wanted)) {
    const { name } = holderOf(view, stated, wanted.routes[0]!.source);
    return `no ${what}: ${name === null ? "its library" : `the library on ${name}`} cannot send it`;
  }
  const open = wanted.routes.filter((route) => !route.refused).map((route) => holderOf(view, stated, route.source));
  const sending = open.find((holder) => holder.waits === null);
  if (sending !== undefined) return `no ${what} yet: on its way${sending.name === null ? "" : ` from ${sending.name}`}`;
  const { name, waits } = open[0]!;
  return `no ${what} yet: ${name ?? "its device"} ${waits}`;
}

function holderOf(view: OpenView, stated: Stated, source: string): { name: string | null; waits: string | null } {
  const unit = view.source(source)?.copy;
  if (unit === undefined) return { name: null, waits: null };
  const said = stated[unit];
  return {
    name: view.tables.devices.get(unit) === undefined ? null : shownName(view.tables, unit),
    waits: said?.room?.value === "full" ? "is out of space" : NETWORK_WAITS[said?.network?.value ?? "all"] ?? null,
  };
}

const NETWORK_WAITS: Record<string, string> = {
  now: "is on mobile data, so its older photos wait for Wi-Fi",
  small: "is on mobile data and sends only small files, so it waits for Wi-Fi",
  "low-data": "is on Low Data Mode, so it waits for Wi-Fi",
};

export type PhotoNaming = Pick<PhotoInput, "day" | "networks" | "photos">;

export function photoNamed(view: OpenView, hex: string, naming: PhotoNaming) {
  const versions = view.naming(`sha256:${hex}`);
  const burst = burstNaming(view, naming.photos, hex, versions);
  const chat = chatNaming(view, hex, versions, naming.day, naming.networks);
  return burst === null && chat === null ? undefined : { burst, chat };
}

export function readPhoto(view: OpenView, hex: string, input: PhotoInput): HeldPhoto | undefined {
  const { day } = input;
  const named = photoNamed(view, hex, input);
  if (named === undefined) return undefined;
  const { burst, chat } = named;
  const people = peopleOn(hex, input.people);
  const made = openMade(view, input.made);
  if (burst === null) {
    const video = chat!.media_type?.toLowerCase().startsWith("video/") === true;
    const photo: Photo = {
      hash: `sha256:${hex}`, kind: video ? "video" : "image", play: video ? { hash: `sha256:${hex}`, media_type: chat!.media_type!, live: false } : null,
      at_ms: chat!.chat.at_ms, unit: null, day: chat!.chat.day, focus: chat!.chat.focus, caption: null,
      described: made({ family: MESSAGES_FAMILY, item: `sha256:${hex}` }), ...people,
      place: null, area: null, camera: null, from: null, chat: chat!.chat,
    };
    return { photo, accounts: [accountOf(chat!.chat.record.source)] };
  }
  const { unit, photo, joined } = burst;
  const camera = cameraOf(view, cameraFiles(joined, { sha256: hex, media_type: photo.media_type! }));
  const place = placeIn(hex, input.places);
  const gps = camera?.gps ?? null;
  const shown: Photo = {
    hash: `sha256:${hex}`, kind: photo.kind!, play: playOf(photo), at_ms: photo.at_ms, unit,
    day: photo.at_ms === null ? chat?.chat.day ?? null : civilDay(photo.at_ms, day), focus: focusOf({ unit, chat: chat?.chat ?? null }), caption: captionOf(view, photo),
    described: made({ family: PHOTOS_FAMILY, item: photo.item }), ...people,
    place, area: gps === null ? null : areaAt(gps),
    camera: camera === null ? null : photoCamera(view, input.unit, camera.camera, input.now_ms, day),
    from: photoFrom(joined.placer.route, input.made.connectors), chat: chat?.chat ?? null,
  };
  return { photo: shown, accounts: photo.accounts };
}

function playOf(photo: BurstPhoto): Photo["play"] {
  if (photo.kind === "video") return { hash: `sha256:${photo.sha256!}`, media_type: photo.media_type!, live: false };
  return photo.motion === null ? null : { hash: `sha256:${photo.motion.sha256}`, media_type: photo.motion.media_type, live: true };
}

function photoCamera(view: OpenView, unit: string | null, camera: string, at_ms: number, day: DaySettings): NonNullable<Photo["camera"]> {
  const read = readCamera(view, unit, camera);
  const { name, mine } = cameraNamed(view, camera, read?.label, read?.counted as unknown as cameras.Camera | undefined, at_ms, day);
  return { id: camera, name, mine };
}

function burstNaming(view: OpenView, routes: PhotoRoutes, hex: string, versions: readonly Version[]) {
  const sources = view.sources(routes.sources);
  const read = new Set<string>();
  for (const version of versions) {
    if (!PHOTO_KINDS.includes(version.kind)) continue;
    for (const source of sources) {
      if (view.head({ source: source.id, kind: version.kind, key: version.key })?.version !== version.id) continue;
      const copy = copyOf(view, routes, { source: source.id, key: version.key });
      if (copy === null) continue;
      const joined = joinedOf(view, routes, copy);
      const unit = burstUnitOf(view, routes, joined);
      if (unit === null || read.has(unit)) continue;
      read.add(unit);
      const shown = showing(view, unit, hex);
      if (shown !== null) return { ...shown, joined };
    }
  }
  return null;
}

function showing(view: OpenView, unit: string, hex: string): { unit: string; photo: BurstPhoto } | null {
  for (const row of storedNear(view, unit)) {
    const photo = row.unit.startsWith(BURST_UNIT) ? burstOf(row).photos.find((each) => each.sha256 === hex) : undefined;
    if (photo !== undefined) return { unit: row.unit, photo };
  }
  return null;
}

function* storedNear(view: OpenView, unit: string): Iterable<ExtractRow> {
  const named = view.extract(PHOTOS_FAMILY, unit);
  if (named !== undefined) yield named;
  const at_ms = Number(unit.slice(BURST_UNIT.length));
  yield* view.extracts(PHOTOS_FAMILY, { start_ms: at_ms - BURST_GAP_MS, end_ms: at_ms + BURST_GAP_MS + 1 });
}

function captionOf(view: OpenView, photo: BurstPhoto): string | null {
  if (!asksCaption(photo)) return null;
  const reply = view.enrichment(PHOTOS_FAMILY, photo.item, PHOTO_CAPTION);
  return reply?.state === "done" ? captionContentOf(reply.content)?.text ?? null : null;
}

function chatNaming(view: OpenView, hex: string, versions: readonly Version[], day: DaySettings, networks: Networks): { chat: NonNullable<Photo["chat"]>; media_type: string | null } | null {
  const sources = view.sources({ product: [...networks.products] });
  const read = new Set<string>();
  let earliest: ReturnType<typeof shownCopy> = null;
  for (const version of versions) {
    if (version.kind !== "msg") continue;
    for (const source of sources) {
      if (view.head({ source: source.id, kind: "msg", key: version.key })?.version !== version.id) continue;
      const network = source.product;
      if (read.has(`${network}\0${version.key}`)) continue;
      read.add(`${network}\0${version.key}`);
      const shown = shownCopy(view, networks, network, version.key);
      if (shown !== null && (earliest === null || shown.fact.at < earliest.fact.at || (shown.fact.at === earliest.fact.at && shown.fact.key < earliest.fact.key))) earliest = shown;
    }
  }
  if (earliest === null) return null;
  const { network, fact } = earliest;
  const labels = labelsFrom((unit) => view.extract(LABELS_FAMILY, unit), day);
  const chat = resolveChat(networks, network, earliest.chat, labels);
  const [, title, group] = resolvedChat(`${network}:${chat}`, labels, networks)!;
  const mine = fact.from.kind === "me";
  return {
    chat: {
      network, chat, title, group, sender: mine ? null : { id: fact.from.id, name: nameId(fact.from.id, labels, fact.from.kind, network).name }, mine,
      at_ms: fact.at, day: civilDay(fact.at, day), record: { source: fact.source, kind: "msg", key: fact.key }, focus: recordFocus({ source: fact.source, kind: "msg", key: fact.key }),
    },
    media_type: fact.parts?.find((part) => part.blob === `sha256:${hex}`)?.media_type ?? null,
  };
}

function peopleOn(hex: string, file: PreparedFile): Pick<Photo, "people" | "size"> {
  return file((read) => {
    const row = read.value<{ size: Photo["size"]; people: { id: string; box: number[] | null }[] }>("image", hex);
    const people = (row?.people ?? []).flatMap(({ id, box }) => {
      const named = read.value<{ name: string; me: boolean; photo: unknown }>("named", id);
      return named === undefined ? [] : [{ id, name: named.name, me: named.me, box, photo: named.photo }];
    });
    return { people, size: people.length === 0 ? null : row!.size };
  }) ?? { people: [], size: null };
}

function placeIn(hex: string, file: PreparedFile): Photo["place"] {
  return file((read) => {
    const slug = read.db.prepare("SELECT slug FROM photo WHERE image = ? LIMIT 1").pluck().get(hex) as string | undefined;
    const head = slug === undefined ? undefined : read.value<PlaceHead>("head", slug);
    if (slug === undefined || head === undefined) return null;
    const { name, latitude, longitude, radius_m, area } = head;
    return { slug, name, latitude, longitude, radius_m, area: { city: area.city, region: area.region, country: area.country } };
  }) ?? null;
}

function areaAt(point: { latitude: number; longitude: number }): Area {
  const { city, region, country } = areaOf(point);
  return { city, region, country };
}

export function preparedFile(folder: HomeFolder, file: string, which: "people" | "places"): PreparedFile {
  return (read) => preparedRow(folder, file, which === "people" ? PEOPLE.format : PLACES.format, read);
}

function preparedRow<T>(folder: HomeFolder, file: string, format: string, read: (file: PreparedRead) => T): T | undefined {
  try {
    return readPrepared(folder, file, format, read)?.value;
  } catch (error) {
    if (isSqliteError(error) && error.code === "SQLITE_BUSY") notNow("busy", "This photo's people and place are being prepared.", RETRY_SOON_S);
    if (damaged(error)) return undefined;
    throw error;
  }
}
