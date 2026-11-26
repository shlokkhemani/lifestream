import type { Json, OpenView } from "@lifestreamprotocol/core";
import type { PhotoContent } from "./family.js";
import { compare, copyIdOf, copyOf, joinedOf, PHOTO_UNIT, photoId, routesOf, type Missing, type PhotoRoutes } from "./read.js";

export const WANTED_UNIT = "wanted/";
export const WANTED_PAGE = 1_000;

export interface WantedContent {
  at_ms: number | null;
  missing: Missing[];
  routes: { source: string; asset: string; files: string[]; refused: boolean }[];
}

export interface Served {
  contents(prefix: string): Iterable<Json>;
}

export interface Left {
  wanted: number;
  unavailable: number;
  bytes: number;
}

export interface WantedAnswer {
  photos: { asset: string; files: string[] }[];
  settled: string[];
  left: Left;
}

export interface Coming extends Left {
  unsized: number;
  libraries: Record<string, number>;
}

export type Order = (source: string) => number | null;

export function wanted(view: OpenView, photos: PhotoRoutes, source: string, asking: ReadonlySet<string>, start_ms: number | null, owed: ReadonlySet<string> = new Set()): WantedAnswer {
  const routes = routesOf(view, photos);
  const order: Order = (id) => (routes.get(id)?.rank === 0 ? 1 : asking.has(id) ? 0 : null);
  const units = [...wantedUnits(servedOf(view))].filter(fromStart(start_ms));
  const { unsized: _unsized, libraries: _libraries, ...left } = coming(units, start_ms);
  const asked = askedOf(units, order, source, owed);
  const named = new Set(asked.map((photo) => photo.asset));
  const settled = [...owed].filter((asset) => !named.has(asset) && known(view, photos, source, asset)).sort(compare);
  return { photos: asked, settled, left };
}

function known(view: OpenView, photos: PhotoRoutes, source: string, asset: string): boolean {
  const copy = copyOf(view, photos, { source, key: asset });
  if (copy === null) return false;
  const joined = joinedOf(view, photos, copy);
  if (joined.erased) return true;
  const placed = view.extract("photos", `${PHOTO_UNIT}${photoId(joined.placer)}`)?.content as unknown as PhotoContent | undefined;
  return placed?.records.some((record) => copyIdOf(view, photos, record) === photoId(copy)) === true;
}

export function askedOf(units: Iterable<WantedContent>, order: Order, source: string, owed: ReadonlySet<string>): WantedAnswer["photos"] {
  const asked: { at_ms: number | null; asset: string; files: string[] }[] = [];
  for (const photo of units) {
    const first = photo.routes.filter((route) => !route.refused).filter((route) => order(route.source) !== null)
      .sort((one, other) => order(one.source)! - order(other.source)! || compare(one.source, other.source) || compare(one.asset, other.asset))[0];
    if (first?.source === source) asked.push({ at_ms: photo.at_ms, asset: first.asset, files: first.files });
  }
  const isOwed = (photo: { asset: string }) => (owed.has(photo.asset) ? 0 : 1);
  asked.sort((one, other) => isOwed(one) - isOwed(other) || (other.at_ms ?? Number.MIN_SAFE_INTEGER) - (one.at_ms ?? Number.MIN_SAFE_INTEGER) || compare(one.asset, other.asset));
  return asked.slice(0, WANTED_PAGE).map(({ asset, files }) => ({ asset, files }));
}

export function coming(units: Iterable<WantedContent>, start_ms: number | null): Coming {
  const counted: Coming = { wanted: 0, unavailable: 0, bytes: 0, unsized: 0, libraries: {} };
  const kept = fromStart(start_ms);
  for (const photo of units) {
    if (!kept(photo)) continue;
    if (unavailable(photo)) {
      counted.unavailable++;
      continue;
    }
    counted.wanted++;
    for (const source of new Set(photo.routes.map((route) => route.source))) counted.libraries[source] = (counted.libraries[source] ?? 0) + 1;
    for (const file of photo.missing) {
      if (file.size === null) counted.unsized++;
      else counted.bytes += file.size;
    }
  }
  return counted;
}

const fromStart = (start_ms: number | null) => (photo: WantedContent): boolean => start_ms === null || photo.at_ms === null || photo.at_ms >= start_ms;

export const unavailable = (photo: WantedContent): boolean => photo.routes.every((route) => route.refused);

export function wantedOf(view: Pick<OpenView, "extract">, id: string): WantedContent | null {
  return (view.extract("photos", `${WANTED_UNIT}${id}`)?.content as unknown as WantedContent | undefined) ?? null;
}

export function* wantedUnits(served: Served): Iterable<WantedContent> {
  for (const content of served.contents(WANTED_UNIT)) yield content as unknown as WantedContent;
}

function servedOf(view: OpenView): Served {
  return {
    contents: function* (prefix) {
      for (const stored of view.extractsUnder("photos", prefix)) yield stored.content;
    },
  };
}
