import {
  daysOf, digest, isObject,
  type Ask, type BlobReader, type DaySettings, type Drawn, type ExtractRow, type Json, type PhotosAdapter, type Prompt, type RecordRef, type Reply, type View,
} from "@lifestreamprotocol/core";
import { accountsOf, linesOnly, type Change, type DayLine, type Extracted, type Family, type Given, type NameSpan, type Plan, type Touched } from "../family.js";
import { labelerRecordsOf } from "../shared/labelers.js";
import { statedPrompt } from "../shared/prompts.js";
import {
  cameraOf, CAMERA_PHOTO_KIND, CAMERAS_SOURCES, compare, copiesNear, copyIdOf, copyOf, FACES_SOURCES, headsIn, held, joinedOf, keyedInstant, lacks, MODEL_IMAGE_KIND, missingOf, modelImageOf, namingCopies,
  PHOTO_KINDS, photoId, photoRecords, PhotoRoutes,
  type Copy, type File, type Joined, type Missing, type ModelFace, type Rung,
} from "./read.js";
import { putBack, type CaptionFaces } from "./faces.js";
import { WANTED_UNIT, wantedOf, type WantedContent } from "./wanted.js";

export const PHOTO_CAPTION = "photo-caption";
export const PHOTO_CAPTION_PROMPT: Prompt = {
  ...statedPrompt(new URL("./prompts/", import.meta.url), PHOTO_CAPTION),
  converters: { 9: (answer) => ({ caption: answer, faces: [] }) },
};

export interface CaptionContent {
  text: string;
  names: NameSpan[];
}
const WORK = "photos";
export const BURST_GAP_MS = 60_000;

export type PhotoKind = "photograph" | "screenshot" | "image" | "video" | null;
export type BurstPosition = "only" | "first" | "last" | "member";

export type HitKind = Exclude<PhotoKind, null> | "document";

export const DOCUMENT_WORDS: readonly string[] = [
  "page", "pages", "document", "documents", "paper", "papers", "receipt", "receipts", "invoice", "bill", "menu", "form", "letter",
  "handwritten", "handwriting", "printed", "printout", "notebook", "whiteboard", "slide", "slides", "ticket", "label", "certificate",
  "screen", "screens", "monitor", "display",
];
const DOCUMENT = new RegExp(`\\b(?:${DOCUMENT_WORDS.join("|")})\\b`, "iu");

export function hitKind(kind: PhotoKind, caption: string | null): HitKind {
  if (kind !== null && kind !== "photograph") return kind;
  return caption !== null && DOCUMENT.test(caption) ? "document" : "photograph";
}

export interface BurstPhoto {
  photo: string;
  accounts: string[];
  item: string;
  sha256: string | null;
  at_ms: number;
  media_type: string | null;
  kind: PhotoKind;
  motion: File | null;
  duration_ms: number | null;
  held: boolean;
  position: BurstPosition | null;
  faces: ModelFace[] | null;
}

export interface BurstContent {
  photos: BurstPhoto[];
}

export interface PhotoContent {
  at_ms: number | null;
  video: boolean;
  item: string;
  image: File | null;
  missing: Missing[];
  held: boolean;
  records: { source: string; key: string; rung: Rung }[];
}

export interface PhotosOptions {
  faces: boolean;
}

const PHOTO = "photo/";
export const PHOTOS_FAMILY = "photos";
const PHOTOS_CODE = "13";
export const BURST_UNIT = "burst/";

export function photoRoutesIn(families: readonly Family[]): PhotoRoutes {
  return new PhotoRoutes((families.find((family) => family.name === PHOTOS_FAMILY)?.adapters ?? []) as readonly Given<PhotosAdapter>[]);
}

const READERS: Readonly<Record<string, (value: Json) => string | null>> = { [PHOTO_CAPTION]: (value) => captionRefusal((value as unknown as CaptionFaces).caption) };

export function photosFamily(options: PhotosOptions): (given: readonly Given<PhotosAdapter>[]) => Family {
  return (given) => photosOver(options, new PhotoRoutes(given), given);
}

function photosOver(options: PhotosOptions, routes: PhotoRoutes, given: readonly Given<PhotosAdapter>[]): Family {
  const undrawn: ModelFace[] | null = options.faces ? null : [];
  return {
    name: PHOTOS_FAMILY,
    type: "photos",
    code: PHOTOS_CODE,
    adapters: given,
    inputs: [
      ...given.map((each) => ({ sources: { product: [each.product] }, kinds: [...each.adapter.kinds], role: "evidence" as const })),
      { sources: FACES_SOURCES, kinds: [MODEL_IMAGE_KIND], role: "labels" },
      { sources: CAMERAS_SOURCES, kinds: [CAMERA_PHOTO_KIND], role: "labels" },
    ],
    prompts: { [PHOTO_CAPTION]: PHOTO_CAPTION_PROMPT },
    readers: READERS,
    works: { [WORK]: routes.sources },

    touched(changes: readonly Change[], view: View): Touched[] {
      const units = new Set<string>();
      const places: number[] = [];
      const instants = new Map<string, { source: string; at_ms: number }>();
      const touch = (joined: Joined) => {
        for (const { copy } of joined.copies) {
          units.add(photoUnit(photoId(copy)));
          for (const record of copy.records) units.add(photoUnit(copyIdOf(view, routes, record)!));
        }
        const at = placeOf(joined);
        if (at !== null) places.push(at);
      };
      for (const change of changes) {
        if (change.record.kind === MODEL_IMAGE_KIND || change.record.kind === CAMERA_PHOTO_KIND) {
          for (const copy of namingCopies(view, routes, change.record.key)) {
            const at = placeOf(joinedOf(view, routes, copy));
            if (at !== null) places.push(at);
          }
          continue;
        }
        const copy = copyOf(view, routes, change.record);
        if (copy !== null) touch(joinedOf(view, routes, copy));
        const own = copyIdOf(view, routes, change.record);
        if (own !== null) units.add(photoUnit(own));
        for (const version of [change.before, change.after]) {
          if (version === undefined) continue;
          for (const near of copiesNear(view, routes, change.record, version)) touch(joinedOf(view, routes, near));
          const instant = keyedInstant(view, routes, change.record, version);
          if (instant !== null) instants.set(`${instant.source}\0${instant.at_ms}`, instant);
        }
      }
      for (const { source, at_ms } of instants.values()) {
        for (const head of headsIn(view, routes, source, at_ms, at_ms)) {
          const copy = copyOf(view, routes, head);
          if (copy !== null) touch(joinedOf(view, routes, copy));
          units.add(photoUnit(copyIdOf(view, routes, head)!));
        }
      }
      for (const unit of units) {
        const stored = view.extract("photos", unit);
        const content = stored === undefined ? undefined : stored.content as unknown as PhotoContent;
        if (content !== undefined && content.at_ms !== null) places.push(content.at_ms);
      }
      for (const [lo, hi] of joinedPlaces(places, 2 * BURST_GAP_MS)) {
        for (const unit of burstsAround(view, routes, lo - BURST_GAP_MS, hi + BURST_GAP_MS)) units.add(unit);
      }
      for (const unit of [...units]) if (unit.startsWith(PHOTO)) units.add(`${WANTED_UNIT}${unit.slice(PHOTO.length)}`);
      return [...units].sort(compare).map((unit) => ({ unit }));
    },

    extract(unit: string, view: View, files: BlobReader): Extracted | null {
      if (unit.startsWith(PHOTO)) {
        const content = photoContent(view, routes, files, unit.slice(PHOTO.length));
        if (content === null) return null;
        return { content: content as unknown as Json, start_ms: content.at_ms, end_ms: content.at_ms, reading: digest(content as unknown as Json) };
      }
      if (unit.startsWith(WANTED_UNIT)) {
        const content = wantedContent(view, routes, files, unit.slice(WANTED_UNIT.length));
        return content === null ? null : { content: content as unknown as Json, start_ms: null, end_ms: null, reading: digest(content as unknown as Json) };
      }
      const named = parseBurst(unit);
      if (named === null) return null;
      const first = photosAt(view, routes, named, named)[0];
      const burst = first === undefined ? null : burstAt(view, routes, first.at_ms, first.id);
      if (burst === null || burst[0]!.at_ms !== named) return null;
      const photos = burst.map(({ joined, at_ms, id }): BurstPhoto => {
        const { image: shown, motion } = shownOf(joined, files);
        const video = joined.placer.video;
        const kind: PhotoKind = video ? "video" : shown === null ? null
          : cameraOf(view, cameraFiles(joined, shown)) !== null ? "photograph" : shown.media_type.toLowerCase() === "image/png" ? "screenshot" : "image";
        return {
          photo: id, accounts: accountsOf(joined.copies.flatMap(({ copy }) => copy.records.map((record) => record.source))), item: itemOf(joined, shown), sha256: shown?.sha256 ?? null, at_ms, media_type: shown?.media_type ?? null, kind, motion,
          duration_ms: video ? joined.copies.find(({ copy, rung }) => rung <= 2 && copy.duration_ms !== null)?.copy.duration_ms ?? null : null,
          held: held(joined, files), position: null, faces: shown === null || video ? null : modelImageOf(view, shown.sha256),
        };
      });
      placeRuns(photos);
      const content: BurstContent = { photos };
      return { content: content as unknown as Json, start_ms: photos[0]!.at_ms, end_ms: photos.at(-1)!.at_ms, reading: digest(content as unknown as Json) };
    },

    days(extract: ExtractRow, settings: DaySettings): string[] {
      if (!extract.unit.startsWith(BURST_UNIT)) return [];
      const days = new Set<string>();
      for (const photo of burstOf(extract).photos) for (const day of daysOf({ start_ms: photo.at_ms, precision: "ms" }, settings)) days.add(day);
      return [...days].sort();
    },

    items(extract: ExtractRow) {
      if (!extract.unit.startsWith(BURST_UNIT)) return [];
      return burstOf(extract).photos.filter(asksCaption).map((photo) => ({ item: photo.item, prompt: PHOTO_CAPTION }));
    },

    plan(extract: ExtractRow, answered: ReadonlyMap<string, Reply>): Plan {
      const plan: Required<Plan> = { asks: [], answers: [], refusals: [] };
      if (!extract.unit.startsWith(BURST_UNIT)) return plan;
      for (const photo of burstOf(extract).photos.filter(asksCaption)) {
        const reply = answered.get(photo.item);
        if (reply === undefined) {
          const faces = photo.faces ?? undrawn;
          if (faces !== null) plan.asks.push(captionAsk(photo.item, { sha256: photo.sha256!, drawn: drawnOf(faces), source: photo.photo.slice(0, photo.photo.indexOf("/")) }));
          continue;
        }
        const answer = reply.value as unknown as CaptionFaces;
        const asked = reply.faces ?? [];
        const refused = READERS[PHOTO_CAPTION]!(reply.value);
        if (refused !== null) {
          plan.refusals.push({ item: photo.item, reason: refused });
          continue;
        }
        const named = (photo.faces ?? []).flatMap((face) => (face.person === null ? [] : [{ box: face.box, who: face.person.who, shown: face.person.shown }]));
        const content: CaptionContent = putBack({ ...answer, caption: answer.caption.trim() }, asked, named);
        plan.answers.push({ item: photo.item, content: content as unknown as Json });
      }
      return plan;
    },

    day: linesOnly((input): DayLine[] => {
      return input.extracts.filter((extract) => extract.unit.startsWith(BURST_UNIT)).flatMap((extract) => {
        const { photos } = burstOf(extract);
        return photos.map((photo): DayLine => {
          const enrichment = asksCaption(photo) ? input.enrichments.get(photo.item) : undefined;
          const caption = enrichment?.state === "done" ? captionContentOf(enrichment.content) : null;
          const head = `${WORDS[photo.kind ?? "photograph"]}: `;
          const length = photo.duration_ms === null ? null : lengthWords(photo.duration_ms);
          return {
            family: "photos", unit: extract.unit, units: [extract.unit], accounts: photo.accounts, start_ms: photo.at_ms, end_ms: null,
            text: caption !== null ? `${head}${caption.text}` : length !== null ? `${head}${length}` : WORDS[photo.kind ?? "photograph"],
            ...(photo.kind === "video" ? { video: { duration_ms: photo.duration_ms } } : {}),
            ...(photo.kind !== "video" && photo.motion !== null ? { live: true as const } : {}),
            ...(caption === null || caption.names.length === 0 ? {} : { names: caption.names.map((name) => ({ ...name, start: name.start + head.length, end: name.end + head.length })) }),
            item: photo.item,
            ...(photo.sha256 === null ? {} : { pictures: 1 }),
            ...(photos.length > 1 ? { block: { key: extract.unit, title: "Photos" } } : {}),
          };
        });
      });
    }),

    replicas(thing: string, view: View) {
      const copies = copiesOfItem(view, routes, thing);
      const joined = new Set(copies.map((copy) => joinedOf(view, routes, copy)));
      const records = new Map<string, RecordRef>();
      const files = new Set<string>();
      for (const photo of joined) {
        for (const { copy } of photo.copies) {
          for (const record of copy.records) records.set(`${record.source}\0${record.key}`, record);
          for (const sha256 of copy.files) files.add(sha256);
        }
      }
      for (const sha256 of files) for (const record of photoRecords(view, routes, sha256)) records.set(`${record.source}\0${record.key}`, record);
      const taken = [...records.values()];
      if (taken.length === 0) return { records: [], items: [] };
      const labelers = [...files].flatMap((sha256) => labelerRecordsOf(view, sha256, taken));
      return { records: [...taken, ...labelers], items: [...new Set([thing, ...[...files].map((sha256) => `photo:${sha256}`)])].sort(compare) };
    },
  };
}

const WORDS: Record<Exclude<PhotoKind, null>, string> = { photograph: "Photo", screenshot: "Screenshot", image: "Image", video: "Video" };

function lengthWords(ms: number): string {
  const seconds = ms > 0 ? Math.max(1, Math.round(ms / 1000)) : 0;
  const hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60), rest = seconds % 60;
  if (hours >= 100) return `${hours.toLocaleString("en-US")}h`;
  const parts = hours > 0 ? [[hours, "h"], [minutes, "m"]] : minutes > 0 ? [[minutes, "m"], [rest, "s"]] : [[rest, "s"]];
  const said = parts.filter(([value]) => value !== 0).map(([value, unit]) => `${value}${unit}`);
  return said.length === 0 ? "0s" : said.join(" ");
}

export interface TakenPhoto {
  image: string;
  at_ms: number;
}

export function photographsOf(extract: ExtractRow): TakenPhoto[] {
  if (!extract.unit.startsWith(BURST_UNIT)) return [];
  const taken = new Map<string, TakenPhoto>();
  for (const photo of burstOf(extract).photos) {
    if (photo.sha256 === null || photo.kind !== "photograph" || taken.has(photo.sha256)) continue;
    taken.set(photo.sha256, { image: photo.sha256, at_ms: photo.at_ms });
  }
  return [...taken.values()];
}

export function captionAsk(item: string, { sha256, drawn, source }: { sha256: string; drawn: Drawn[]; source: string }): Ask {
  return {
    family: "photos", item, prompt: PHOTO_CAPTION, input: [],
    attachments: [{ blob: `sha256:${sha256}`, media_type: "image/jpeg", drawn }],
    identity: { photo: sha256 },
    work: WORK, source,
  };
}

function drawnOf(faces: readonly ModelFace[]): Drawn[] {
  return faces.map((face, index) => ({ placeholder: `[[Person ${index + 1}]]`, box: face.box }));
}

export function captionContentOf(content: Json | null): CaptionContent | null {
  return isObject(content) && typeof content.text === "string" && Array.isArray(content.names) ? content as unknown as CaptionContent : null;
}

function captionRefusal(text: string): string | null {
  const caption = text.trim();
  if (caption.length === 0) return "caption model returned an empty reply";
  if (/\b(?:cannot|can't|unable to)\s+(?:see|view|access)\b[^.\n]{0,80}\b(?:image|photo|attachment)\b/iu.test(caption) ||
      /\bplease\s+(?:upload|attach|provide)\b[^.\n]{0,80}\b(?:image|photo)\b/iu.test(caption)) {
    return "caption model could not see the image";
  }
  return null;
}

export function asksCaption(photo: BurstPhoto): boolean {
  return photo.held && photo.kind === "photograph" && photo.position !== null && photo.position !== "member";
}

function photoOf(view: View, routes: PhotoRoutes, id: string): Joined | null {
  const slash = id.indexOf("/");
  const copy = slash < 0 ? null : copyOf(view, routes, { source: id.slice(0, slash), key: id.slice(slash + 1) });
  if (copy === null) return null;
  const joined = joinedOf(view, routes, copy);
  return joined.erased || photoId(joined.placer) !== id ? null : joined;
}

function photoContent(view: View, routes: PhotoRoutes, files: BlobReader, id: string): PhotoContent | null {
  const joined = photoOf(view, routes, id);
  if (joined === null) return null;
  const shown = shownOf(joined, files).image;
  const missing = missingOf(joined, files);
  return {
    at_ms: joined.placer.at_ms, video: joined.placer.video, item: itemOf(joined, shown),
    image: shown === null ? null : { sha256: shown.sha256, media_type: shown.media_type },
    missing, held: missing.length === 0,
    records: joined.copies.flatMap(({ copy: each, rung }) => each.records.map((record) => ({ source: record.source, key: record.key, rung }))),
  };
}

function wantedContent(view: View, routes: PhotoRoutes, files: BlobReader, id: string): WantedContent | null {
  const joined = photoOf(view, routes, id);
  if (joined === null) return null;
  const missing = missingOf(joined, files);
  const libraries = lacks(joined, files).filter(({ copy }) => copy.route.library).map(({ copy, missing: lacking }) => ({
    source: copy.route.id, asset: copy.id, files: lacking.map((resource) => resource.type), refused: lacking.some((resource) => resource.refused),
  }));
  return missing.length === 0 || libraries.length === 0 ? null : { at_ms: joined.placer.at_ms, missing, routes: libraries };
}

function shownOf(joined: Joined, files: BlobReader): { image: File | null; motion: File | null } {
  const still = !joined.placer.video;
  return {
    image: pick(joined, files, (copy) => (still && copy.video ? null : copy)),
    motion: still ? pick(joined, files, (copy) => ({ renders: copy.motion.renders, originals: [...copy.motion.originals, ...(copy.video ? copy.originals : [])], modified_ms: copy.modified_ms })) : null,
  };
}

function pick(joined: Joined, files: BlobReader, part: (copy: Copy) => Pick<Copy, "renders" | "originals" | "modified_ms"> | null): File | null {
  const held = (file: File) => files.has(`sha256:${file.sha256}`);
  const parts = joined.copies.flatMap(({ copy }) => part(copy) ?? []);
  const renders = parts.flatMap((each) => each.renders.filter(held).map((file) => ({ each, file }))).sort((left, right) => right.each.modified_ms - left.each.modified_ms);
  return (renders[0] ?? parts.flatMap((each) => each.originals.filter(held).map((file) => ({ each, file })))[0])?.file ?? null;
}

export function cameraFiles(joined: Joined, shown: File): string[] {
  return [...joined.copies.flatMap(({ copy, rung }) => rung <= 2 ? copy.files : []), shown.sha256];
}

function itemOf(joined: Joined, shown: File | null): string {
  if (shown !== null) return `photo:${shown.sha256}`;
  const cloud = joined.copies.find(({ copy, rung }) => rung <= 2 && copy.cloud !== null)?.copy.cloud;
  return cloud === undefined || cloud === null ? `photo:${photoId(joined.placer)}` : `photo:apple:${cloud}`;
}

function copiesOfItem(view: View, routes: PhotoRoutes, thing: string): Copy[] {
  const hex = /^photo:([0-9a-f]{64})$/u.exec(thing)?.[1];
  if (hex !== undefined) return namingCopies(view, routes, hex);
  if (thing.startsWith("photo:apple:")) {
    for (const stored of view.extractsUnder("photos", PHOTO)) {
      const content = stored.content as unknown as PhotoContent;
      if (content.item !== thing) continue;
      return content.records.flatMap((record) => copyOf(view, routes, record) ?? []);
    }
    return [];
  }
  const id = /^photo:([^/]+)\/(.+)$/u.exec(thing);
  const copy = id === null ? null : copyOf(view, routes, { source: id[1]!, key: id[2]! });
  return copy === null ? [] : [copy];
}

function placeRuns(photos: BurstPhoto[]): void {
  const runs: BurstPhoto[][] = [];
  for (const photo of photos) {
    if (photo.kind !== "photograph") continue;
    const run = runs.at(-1);
    if (run === undefined || photo.at_ms - run.at(-1)!.at_ms > BURST_GAP_MS) runs.push([photo]);
    else run.push(photo);
  }
  for (const run of runs) {
    run.forEach((photo, index) => {
      photo.position = run.length === 1 ? "only" : index === 0 ? "first" : index === run.length - 1 ? "last" : "member";
    });
  }
}

interface Placed { id: string; at_ms: number; joined: Joined }

function placeOf(joined: Joined): number | null {
  return joined.erased ? null : joined.placer.at_ms;
}

function photosAt(view: View, routes: PhotoRoutes, lo: number, hi: number): Placed[] {
  const found = new Map<string, Placed>();
  for (const source of view.sources(routes.sources)) {
    for (const head of headsIn(view, routes, source.id, lo, hi)) {
      const copy = copyOf(view, routes, head);
      if (copy === null) continue;
      const joined = joinedOf(view, routes, copy);
      const at_ms = placeOf(joined);
      if (at_ms !== null && at_ms >= lo && at_ms <= hi) found.set(photoId(joined.placer), { id: photoId(joined.placer), at_ms, joined });
    }
  }
  return [...found.values()].sort(byTime);
}

const bursts = new WeakMap<View, Map<string, Placed[]>>();

function burstAt(view: View, routes: PhotoRoutes, at_ms: number, id: string): Placed[] | null {
  const found = bursts.get(view)?.get(member({ at_ms, id }));
  if (found !== undefined) return found;
  let lo = at_ms - BURST_GAP_MS;
  let hi = at_ms + BURST_GAP_MS;
  for (;;) {
    const photos = photosAt(view, routes, lo, hi);
    const index = photos.findIndex((photo) => photo.id === id && photo.at_ms === at_ms);
    if (index < 0) return null;
    let first = index;
    while (first > 0 && photos[first]!.at_ms - photos[first - 1]!.at_ms <= BURST_GAP_MS) first--;
    let last = index;
    while (last < photos.length - 1 && photos[last + 1]!.at_ms - photos[last]!.at_ms <= BURST_GAP_MS) last++;
    const wantLo = photos[first]!.at_ms - BURST_GAP_MS;
    const wantHi = photos[last]!.at_ms + BURST_GAP_MS;
    if (wantLo >= lo && wantHi <= hi) return remember(view, routes, photos.slice(first, last + 1));
    const width = hi - lo;
    if (wantLo < lo) lo = wantLo - width;
    if (wantHi > hi) hi = wantHi + width;
  }
}

export function burstUnitOf(view: View, routes: PhotoRoutes, joined: Joined): string | null {
  const at_ms = placeOf(joined);
  const burst = at_ms === null ? null : burstAt(view, routes, at_ms, photoId(joined.placer));
  return burst === null ? null : burstUnit(burst[0]!);
}

function member(photo: { at_ms: number; id: string }): string {
  return `${photo.at_ms}\0${photo.id}`;
}

function remember(view: View, routes: PhotoRoutes, burst: Placed[]): Placed[] {
  let known = bursts.get(view);
  if (known === undefined) bursts.set(view, (known = new Map()));
  for (const photo of burst) known.set(member(photo), burst);
  return burst;
}

function joinedPlaces(places: readonly number[], reach: number): [number, number][] {
  const out: [number, number][] = [];
  for (const at_ms of [...places].sort((left, right) => left - right)) {
    const last = out.at(-1);
    if (last !== undefined && at_ms - last[1] <= reach) last[1] = at_ms;
    else out.push([at_ms, at_ms]);
  }
  return out;
}

function burstsAround(view: View, routes: PhotoRoutes, lo: number, hi: number): string[] {
  const photos = photosAt(view, routes, lo, hi);
  let burst: Placed[] = [];
  for (const photo of [...photos, undefined]) {
    if (photo !== undefined && burst.length > 0 && photo.at_ms - burst.at(-1)!.at_ms <= BURST_GAP_MS) {
      burst.push(photo);
      continue;
    }
    if (burst.length > 0 && burst[0]!.at_ms - BURST_GAP_MS >= lo && burst.at(-1)!.at_ms + BURST_GAP_MS <= hi) remember(view, routes, burst);
    burst = photo === undefined ? [] : [photo];
  }
  const now = photos.map((photo) => burstAt(view, routes, photo.at_ms, photo.id)!);
  const units = new Set(now.map((each) => burstUnit(each[0]!)));
  const from = now.reduce((least, each) => Math.min(least, each[0]!.at_ms), lo);
  const to = now.reduce((most, each) => Math.max(most, each.at(-1)!.at_ms), hi);
  for (const stored of view.extracts("photos", { start_ms: from, end_ms: to + 1 })) {
    if (stored.unit.startsWith(BURST_UNIT) && stored.end_ms! >= lo && stored.start_ms! <= hi) units.add(stored.unit);
  }
  return [...units];
}

function photoUnit(id: string): string {
  return `${PHOTO}${id}`;
}

export interface Unshown {
  video: boolean;
  wanted: WantedContent | null;
}

export type UnshownOf = { record: Pick<RecordRef, "source" | "key"> } | { burst: string; item: string };

export function unshownReader(view: View, routes: PhotoRoutes): (of: UnshownOf) => Unshown | null {
  const bursts = new Map<string, BurstContent | null>();
  const burstNamed = (unit: string): BurstContent | null => {
    if (!bursts.has(unit)) {
      const stored = unit.startsWith(BURST_UNIT) ? view.extract(PHOTOS_FAMILY, unit) : undefined;
      bursts.set(unit, stored === undefined ? null : burstOf(stored));
    }
    return bursts.get(unit)!;
  };
  return (of) => {
    const photo = "record" in of ? recordPhoto(view, routes, of.record) : burstPhoto(burstNamed(of.burst), of.item);
    return photo === null ? null : { video: photo.video, wanted: wantedOf(view, photo.id) };
  };
}

function recordPhoto(view: View, routes: PhotoRoutes, record: Pick<RecordRef, "source" | "key">): { id: string; video: boolean } | null {
  const copy = copyOf(view, routes, record);
  if (copy === null) return null;
  const id = photoId(joinedOf(view, routes, copy).placer);
  const content = view.extract(PHOTOS_FAMILY, photoUnit(id))?.content as unknown as PhotoContent | undefined;
  return content === undefined || content.image !== null ? null : { id, video: content.video };
}

function burstPhoto(burst: BurstContent | null, item: string): { id: string; video: boolean } | null {
  const photo = burst?.photos.find((each) => each.item === item);
  return photo === undefined || photo.sha256 !== null ? null : { id: photo.photo, video: photo.kind === "video" };
}

function burstUnit(photo: Placed): string {
  return `${BURST_UNIT}${photo.at_ms}`;
}

function parseBurst(unit: string): number | null {
  const match = /^burst\/(-?\d+)$/u.exec(unit);
  const at_ms = match === null ? NaN : Number(match[1]);
  return Number.isSafeInteger(at_ms) ? at_ms : null;
}

export function burstOf(extract: ExtractRow): BurstContent {
  const content = extract.content;
  if (!isObject(content) || !Array.isArray(content.photos)) throw new TypeError(`photos extract ${extract.unit} is not a burst`);
  return { photos: (content.photos as unknown as BurstPhoto[]).map((photo) => ({ ...photo, motion: photo.motion ?? null, duration_ms: photo.duration_ms ?? null })) };
}

function byTime(left: Placed, right: Placed): number {
  return left.at_ms - right.at_ms || compare(left.id, right.id);
}
