import type { BlobReader, Copy as Stated, Head, PhotoFile, PhotoResource, PhotosAdapter, RecordRef, SourceRow, SourceSelector, Version, View } from "@lifestreamprotocol/core";
import { isObject, type Box } from "@lifestreamprotocol/core";
import type { Given } from "../family.js";

export const PHOTO_KIND = "img";
export const PHOTO_FILE_KIND = "img-file";
export const PHOTO_KINDS: readonly string[] = [PHOTO_KIND, PHOTO_FILE_KIND];
export const FACES_SOURCES: SourceSelector = { product: ["faces"] };
export const MODEL_IMAGE_KIND = "model-image";
export const CAMERAS_SOURCES: SourceSelector = { product: ["cameras"] };
export const CAMERA_PHOTO_KIND = "photo";
export const PHOTO_UNIT = "photo/";
const NAME_REACH_MS = 1_000;
const HELD_MS = 60_000;

export type Rung = 0 | 1 | 2 | 3;

export interface Route {
  id: string;
  rank: number;
  library: boolean;
  keyed: boolean;
  row: SourceRow;
  adapter: PhotosAdapter;
}

export type File = PhotoFile;

export type Resource = PhotoResource;

export interface Missing {
  type: string;
  name: string | null;
  size: number | null;
}

export interface Copy extends Stated {
  route: Route;
}

export interface Joined {
  placer: Copy;
  copies: { copy: Copy; rung: Rung }[];
  erased: boolean;
}

export class PhotoRoutes {
  readonly #given: ReadonlyMap<string, PhotosAdapter>;
  readonly #known = new WeakMap<View, Known>();
  readonly sources: SourceSelector;

  constructor(given: readonly Given<PhotosAdapter>[]) {
    this.#given = new Map(given.map((each) => [each.product, each.adapter]));
    this.sources = { product: given.map((each) => each.product) };
  }

  adapterOf(product: string): PhotosAdapter | undefined {
    return this.#given.get(product);
  }

  known(view: View): Known {
    let found = this.#known.get(view);
    if (found === undefined) this.#known.set(view, (found = { copies: new Map(), joined: new Map(), bridged: new Map(), minutes: new Map() }));
    return found;
  }
}

export function photoId(copy: Pick<Copy, "route" | "id">): string {
  return `${copy.route.id}/${copy.id}`;
}

export function copyIdOf(view: View, routes: PhotoRoutes, record: Pick<RecordRef, "source" | "key">): string | null {
  const route = routesOf(view, routes).get(record.source);
  return route === undefined ? null : photoId({ route, id: idOf(route, record.key) });
}

function idOf(route: Route, key: string): string {
  return route.library ? key.split(":")[0]! : key;
}

interface Known {
  routes?: Map<string, Route>;
  copies: Map<string, Copy | null>;
  joined: Map<string, Joined>;
  bridged: Map<string, Copy[]>;
  minutes: Map<string, Map<number, Head[]>>;
}

export function routesOf(view: View, routes: PhotoRoutes): Map<string, Route> {
  const of = routes.known(view);
  return of.routes ??= new Map(view.sources(routes.sources).flatMap((row) => {
    const route = routeOf(routes, row);
    return route === null ? [] : [[row.id, route] as const];
  }));
}

function routeOf(routes: PhotoRoutes, row: SourceRow): Route | null {
  const adapter = routes.adapterOf(row.product)!;
  let rank: number;
  try {
    rank = adapter.rank(row);
  } catch {
    return null;
  }
  return { id: row.id, rank, library: adapter.library === true, keyed: adapter.keyed === true, row, adapter };
}

export function copyOf(view: View, routes: PhotoRoutes, record: Pick<RecordRef, "source" | "key">): Copy | null {
  const route = routesOf(view, routes).get(record.source);
  if (route === undefined) return null;
  const id = idOf(route, record.key);
  const name = `${route.id}\0${id}`;
  const copies = routes.known(view).copies;
  if (!copies.has(name)) {
    const stated = route.adapter.copy(view, route.row, id);
    copies.set(name, stated === null ? null : { route, ...stated });
  }
  return copies.get(name)!;
}

export function lacks(joined: Joined, files: BlobReader): { copy: Copy; missing: Resource[] }[] {
  const holds = (resource: Resource) => resource.files.some((sha256) => files.has(`sha256:${sha256}`));
  const exact = joined.copies.filter(({ copy, rung }) => rung <= 2 && copy.route.library).map(({ copy }) => copy);
  if (exact.length === 0) return joined.copies.map(({ copy }) => ({ copy, missing: copy.resources.filter((resource) => !holds(resource)) }));
  const heldEdits = new Set(exact.flatMap((copy) => copy.resources.filter(holds).map((resource) => oneFile(copy, resource))));
  const named = joined.copies.filter(({ copy, rung }) => rung === 3 && copy.route.keyed).flatMap(({ copy }) => copy.resources.filter(holds));
  const sameFile = (resource: Resource) => resource.size !== null && resource.name !== null
    && named.some((other) => other.name === resource.name && other.size === resource.size);
  return exact.map((copy) => ({ copy, missing: copy.resources.filter((resource) => !heldEdits.has(oneFile(copy, resource)) && !sameFile(resource)) }));
}

export function missingOf(joined: Joined, files: BlobReader): Missing[] {
  const fewest = lacks(joined, files).reduce<{ copy: Copy; missing: Resource[] } | null>((least, each) => (least === null || each.missing.length < least.missing.length ? each : least), null);
  if (fewest === null) return [];
  const sizes = new Map<string, number>();
  for (const { copy, rung } of joined.copies) {
    if (rung > 2 || !copy.route.library) continue;
    for (const resource of copy.resources) if (resource.size !== null) sizes.set(oneFile(copy, resource), resource.size);
  }
  return fewest.missing.map((resource) => ({ type: resource.type, name: resource.name, size: resource.size ?? sizes.get(oneFile(fewest.copy, resource)) ?? null }));
}

function oneFile(copy: Copy, resource: Resource): string {
  return JSON.stringify([copy.modified_ms, resource.type, resource.name]);
}

export function held(joined: Joined, files: BlobReader): boolean {
  return missingOf(joined, files).length === 0;
}

export function joinedOf(view: View, routes: PhotoRoutes, start: Copy): Joined {
  const of = routes.known(view).joined;
  const found = of.get(nameOf(start));
  if (found !== undefined) return found;
  const copies = new Map<string, Copy>([[nameOf(start), start]]);
  const edges: [string, string, Rung][] = [];
  for (const queue = [start]; queue.length > 0;) {
    const copy = queue.shift()!;
    for (const [other, rung] of neighbours(view, routes, copy)) {
      const name = nameOf(other);
      edges.push([nameOf(copy), name, rung]);
      if (!copies.has(name)) {
        copies.set(name, other);
        queue.push(other);
      }
    }
  }
  const all = [...copies.values()];
  const dated = all.filter((copy) => copy.at_ms !== null);
  const placer = (dated.length > 0 ? dated : all).sort(placing)[0]!;
  const rungs = rungsFrom(placer, all, edges);
  const joined: Joined = {
    placer,
    copies: all.map((copy) => ({ copy, rung: rungs.get(nameOf(copy))! })).sort((left, right) => left.rung - right.rung || placing(left.copy, right.copy)),
    erased: all.some((copy) => copy.erased),
  };
  for (const copy of all) of.set(nameOf(copy), joined);
  return joined;
}

function neighbours(view: View, routes: PhotoRoutes, copy: Copy): [Copy, Rung][] {
  const out = exactNeighbours(view, routes, copy);
  if (copy.route.keyed) for (const apple of bridged(view, routes, copy)) out.push([apple, 3]);
  else if (copy.route.library) {
    for (const other of nearCopies(view, routes, copy)) if (other.route.keyed && bridged(view, routes, other).some((apple) => nameOf(apple) === nameOf(copy))) out.push([other, 3]);
  }
  return out;
}

function exactNeighbours(view: View, routes: PhotoRoutes, copy: Copy): [Copy, Rung][] {
  const out: [Copy, Rung][] = [];
  const self = nameOf(copy);
  for (const sha256 of copy.files) {
    for (const other of namingCopies(view, routes, sha256)) if (nameOf(other) !== self) out.push([other, 1]);
  }
  if (!copy.route.library || copy.cloud === null) return out;
  for (const other of nearCopies(view, routes, copy)) if (nameOf(other) !== self && other.route.library && other.cloud === copy.cloud) out.push([other, 2]);
  return out;
}

function bridged(view: View, routes: PhotoRoutes, keyed: Copy): Copy[] {
  const of = routes.known(view).bridged;
  const found = of.get(nameOf(keyed));
  if (found !== undefined) return found;
  const met = nearCopies(view, routes, keyed).filter((other) => namesMeet(keyed, other));
  let one = true;
  if (met.length > 1) {
    const reached = new Set([nameOf(met[0]!)]);
    for (const queue = [met[0]!]; queue.length > 0;) {
      for (const [other] of exactNeighbours(view, routes, queue.shift()!)) {
        if (!reached.has(nameOf(other))) {
          reached.add(nameOf(other));
          queue.push(other);
        }
      }
    }
    one = met.every((copy) => reached.has(nameOf(copy)));
  }
  of.set(nameOf(keyed), one ? met : []);
  return of.get(nameOf(keyed))!;
}

function namesMeet(left: Copy, right: Copy): boolean {
  const [apple, file] = left.route.library ? [left, right] : [right, left];
  if (!apple.route.library || !file.route.keyed || apple.at_ms === null || file.at_ms === null) return false;
  return Math.abs(apple.at_ms - file.at_ms) <= NAME_REACH_MS && apple.names.some((name) => file.names.includes(name));
}

export function namingCopies(view: View, routes: PhotoRoutes, sha256: string): Copy[] {
  const all = [...routesOf(view, routes).values()];
  const found = new Map<string, Copy>();
  for (const route of all) {
    if (!route.keyed) continue;
    const copy = copyOf(view, routes, { source: route.id, key: sha256 });
    if (copy !== null) found.set(nameOf(copy), copy);
  }
  for (const version of view.naming(`sha256:${sha256}`)) {
    if (!PHOTO_KINDS.includes(version.kind)) continue;
    for (const route of all) {
      if (route.keyed || view.head({ source: route.id, kind: version.kind, key: version.key })?.version !== version.id) continue;
      const copy = copyOf(view, routes, { source: route.id, key: version.key });
      if (copy !== null) found.set(nameOf(copy), copy);
    }
  }
  return [...found.values()];
}

const bytesOnly = (route: Route): boolean => !route.library && !route.keyed;

function nearCopies(view: View, routes: PhotoRoutes, copy: Pick<Copy, "at_ms" | "route">): Copy[] {
  if (copy.at_ms === null || bytesOnly(copy.route)) return [];
  const found = new Map<string, Copy>();
  for (const route of routesOf(view, routes).values()) {
    if (bytesOnly(route) || (!copy.route.library && !route.library)) continue;
    for (const head of headsIn(view, routes, route.id, copy.at_ms - NAME_REACH_MS, copy.at_ms + NAME_REACH_MS)) {
      const other = copyOf(view, routes, head);
      if (other !== null && other.at_ms !== null && Math.abs(other.at_ms - copy.at_ms) <= NAME_REACH_MS) found.set(nameOf(other), other);
    }
  }
  return [...found.values()];
}

export function headsIn(view: View, routes: PhotoRoutes, source: string, lo: number, hi: number): Head[] {
  const known = routes.known(view).minutes;
  let held = known.get(source);
  if (held === undefined) known.set(source, (held = new Map()));
  const first = Math.floor(lo / HELD_MS);
  const last = Math.floor(hi / HELD_MS);
  for (let minute = first; minute <= last; minute++) {
    if (held.has(minute)) continue;
    let through = minute;
    while (through < last && !held.has(through + 1)) through++;
    for (let each = minute; each <= through; each++) held.set(each, []);
    const [from, to] = [minute * HELD_MS, (through + 1) * HELD_MS];
    for (const head of view.heads(source, PHOTO_KIND, { start_ms: from, end_ms: to })) {
      if (head.start_ms !== null && head.start_ms >= from && head.start_ms < to) held.get(Math.floor(head.start_ms / HELD_MS))!.push(head);
    }
    minute = through;
  }
  const heads: Head[] = [];
  for (let minute = first; minute <= last; minute++) {
    for (const head of held.get(minute)!) if (head.start_ms! >= lo && head.start_ms! <= hi) heads.push(head);
  }
  return heads;
}

export function copiesNear(view: View, routes: PhotoRoutes, record: RecordRef, version: Version): Copy[] {
  const route = routesOf(view, routes).get(record.source);
  if (route === undefined) return [];
  const found = new Map<string, Copy>();
  for (const sha256 of new Set(route.adapter.files(version, record.key))) for (const copy of namingCopies(view, routes, sha256)) found.set(nameOf(copy), copy);
  const at_ms = route.adapter.placedBy(version, record.key) === null ? version.time?.start_ms ?? null : null;
  for (const copy of nearCopies(view, routes, { at_ms, route })) found.set(nameOf(copy), copy);
  return [...found.values()];
}

export function keyedInstant(view: View, routes: PhotoRoutes, record: RecordRef, version: Version): { source: string; at_ms: number } | null {
  const route = routesOf(view, routes).get(record.source);
  const at_ms = version.time?.start_ms ?? null;
  return route === undefined || !route.keyed || at_ms === null ? null : { source: route.id, at_ms };
}

function rungsFrom(placer: Copy, copies: readonly Copy[], edges: readonly [string, string, Rung][]): Map<string, Rung> {
  const parent = new Map(copies.map((copy) => [nameOf(copy), nameOf(copy)]));
  const find = (name: string): string => {
    let root = name;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(name, root);
    return root;
  };
  const rungs = new Map<string, Rung>([[nameOf(placer), 0]]);
  for (const level of [1, 2, 3] as const) {
    for (const [left, right, rung] of edges) if (rung === level) parent.set(find(left), find(right));
    for (const copy of copies) if (!rungs.has(nameOf(copy)) && find(nameOf(copy)) === find(nameOf(placer))) rungs.set(nameOf(copy), level);
  }
  return rungs;
}

export function placing(left: Copy, right: Copy): number {
  return left.route.rank - right.route.rank || compare(left.route.id, right.route.id) || compare(left.id, right.id);
}

function nameOf(copy: Copy): string {
  return `${copy.route.id}\0${copy.id}`;
}

export interface Camera {
  camera: string;
  gps: { latitude: number; longitude: number } | null;
}

export function cameraOf(view: View, files: Iterable<string>): Camera | null {
  const sources = labelersOf(view).cameras ??= view.sources(CAMERAS_SOURCES).map((row) => row.id).sort(compare);
  for (const sha256 of [...new Set(files)].sort(compare)) {
    for (const source of sources) {
      const head = view.head({ source, kind: CAMERA_PHOTO_KIND, key: sha256 });
      const content = head === undefined || head.version === "gone" ? undefined : view.version(head.version).content;
      if (!isObject(content) || content.type !== "cameras.photo" || typeof content.camera !== "string") continue;
      const gps = isObject(content.gps) && typeof content.gps.latitude === "number" && typeof content.gps.longitude === "number"
        ? { latitude: content.gps.latitude, longitude: content.gps.longitude } : null;
      return { camera: content.camera, gps };
    }
  }
  return null;
}

export interface ModelFace {
  box: Box;
  person: { who: string; shown: string } | null;
}

export function modelImageOf(view: View, sha256: string): ModelFace[] | null {
  const of = labelersOf(view);
  for (const source of of.faces ??= view.sources(FACES_SOURCES).map((row) => row.id).sort(compare)) {
    const head = view.head({ source, kind: MODEL_IMAGE_KIND, key: sha256 });
    if (head === undefined || head.version === "gone") continue;
    const content = view.version(head.version).content;
    if (!isObject(content) || !Array.isArray(content.faces) || !Array.isArray(content.names)) continue;
    const names = content.names as ({ who: string; shown: string } | null)[];
    return (content.faces as { box: [number, number, number, number] }[]).map(({ box: [x1, y1, x2, y2] }, index) => ({
      box: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
      person: names[index] === null || names[index] === undefined ? null : { who: names[index]!.who, shown: names[index]!.shown },
    }));
  }
  return null;
}

export function placeOf(view: View, routes: PhotoRoutes, record: RecordRef, version: Version): { at_ms: number; sha256: string | null } | null {
  const route = routesOf(view, routes).get(record.source);
  if (route === undefined || version.time === undefined) return null;
  const by = route.adapter.placedBy(version, record.key);
  if (by === null) return { at_ms: version.time.start_ms, sha256: route.library ? null : route.adapter.image(view, route.row, version, record.key) };
  const head = by.key === null ? undefined : view.head({ source: record.source, kind: PHOTO_KIND, key: by.key });
  return head === undefined || head.version === "gone" || head.start_ms === null ? null : { at_ms: head.start_ms, sha256: null };
}

export function snapshotOf(key: string): string | null {
  return /^(.+):sha256:[0-9a-f]{64}$/u.exec(key)?.[1] ?? null;
}

export function photoRecords(view: View, routes: PhotoRoutes, sha256: string): RecordRef[] {
  const records = new Map<string, RecordRef>();
  const add = (record: RecordRef) => records.set(`${record.source}\0${record.key}`, { source: record.source, kind: record.kind, key: record.key });
  for (const version of view.naming(`sha256:${sha256}`)) {
    if (!PHOTO_KINDS.includes(version.kind)) continue;
    for (const route of routesOf(view, routes).values()) {
      const record = { source: route.id, kind: version.kind, key: version.key };
      if (view.head(record) === undefined || !view.history(record).some((statement) => statement.version === version.id)) continue;
      add(record);
      if (route.library) for (const kind of PHOTO_KINDS) view.keyedUnder(route.id, kind, `${version.key.split(":")[0]}:`).forEach(add);
    }
  }
  return [...records.values()].sort((left, right) => compare(left.source, right.source) || compare(left.key, right.key));
}

const labelers = new WeakMap<View, { cameras?: string[]; faces?: string[] }>();

function labelersOf(view: View): { cameras?: string[]; faces?: string[] } {
  let found = labelers.get(view);
  if (found === undefined) labelers.set(view, (found = {}));
  return found;
}

export function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
