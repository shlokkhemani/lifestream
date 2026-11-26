import { canonical, textHead, type Json, type JsonObject, type Secrets } from "@lifestreamprotocol/connect/sdk";
import { LabelerUnavailable, type Labeler, type LabelOutput } from "../../labeler.js";
import { SecretError, type OpenView } from "@lifestreamprotocol/core";
import { STATEMENTS_FILE } from "../../shared/statements.js";
import { ANSWER_KIND, ANSWERS_FILE, answerKey, answerLine, googlePlacesConnector, readAnswerKey, type Request } from "./reader.js";

export const GOOGLE = "https://places.googleapis.com";
export const ANSWER_REACH_M = 40;
export const PER_RUN = 60;
export const PER_DAY = 500;
const DAY_MS = 86_400_000;
export const PLACES_EVENT = "places";
const REQUEST_MS = 30_000;

const ASKS: Readonly<Record<Request, { radius_m: number; body: JsonObject }>> = {
  nearby: { radius_m: 150, body: { maxResultCount: 20, rankPreference: "DISTANCE" } },
  venues: {
    radius_m: 300,
    body: {
      includedTypes: ["shopping_mall", "hospital", "university", "stadium", "train_station", "subway_station", "park", "beach", "hindu_temple", "church", "mosque",
        "synagogue", "hotel", "resort_hotel"],
      maxResultCount: 10, rankPreference: "POPULARITY",
    },
  },
  airport: { radius_m: 5_000, body: { includedPrimaryTypes: ["airport", "international_airport"], maxResultCount: 1, rankPreference: "POPULARITY" } },
  beach: { radius_m: 1_500, body: { includedPrimaryTypes: ["beach"], maxResultCount: 1, rankPreference: "POPULARITY" } },
};
const NEARBY_FIELDS = "places.id,places.displayName,places.location,places.types,places.primaryType";
const NAME_FIELDS = "id,displayName,location";

export interface Point {
  latitude: number;
  longitude: number;
}

export const RECEIVER = "Google";

export interface Lookup {
  receiver: typeof RECEIVER;
  request: "searchNearby" | "place" | "autocomplete";
  points: number;
  chars: number;
}

export interface Owed {
  spots: Point[];
  ids: { id: string; account: string }[];
}

export interface GooglePlacesSettings {
  unit: string;
  key: string;
  owed(): Owed;
  hints(names: readonly string[]): ("airport" | "beach")[];
  lookup(sent: Lookup): void;
  looked(since_ms: number): number;
  endpoint?: string;
  now?: () => number;
}

interface Stored {
  request: Request;
  latitude: number;
  longitude: number;
  at_ms: number;
  places: JsonObject[] | string;
}

interface Plan {
  spot: Point;
  lacks: Request[];
  names: string[];
}

class KeyRefused extends Error {}

export function googlePlacesLabeler(settings: GooglePlacesSettings): Labeler {
  const source = `google-places:${settings.unit}:nearby`;
  const endpoint = settings.endpoint ?? GOOGLE;
  const now = settings.now ?? Date.now;
  const unknown = new Set<string>();
  return {
    name: "google-places",
    source,
    secrets: [settings.key],
    inputs: [],
    events: [PLACES_EVENT],

    async label(view, _blobs, _since, signal, secrets) {
      const key = keyOf(secrets, settings.key);
      if (key === undefined) return null;
      const owed = settings.owed();
      const at_ms = now();
      let room = PER_DAY - settings.looked(at_ms - DAY_MS);
      const stored = new Answers();
      for (const head of view.heads(source, ANSWER_KIND)) {
        const asked = readAnswerKey(head.key);
        if (asked !== undefined && head.start_ms !== null) stored.add({ ...asked, at_ms: head.start_ms, places: head.version });
      }
      const placesOf = (answer: Stored): JsonObject[] => {
        if (typeof answer.places === "string") {
          const content = view.version(answer.places).content as { places?: Json };
          answer.places = Array.isArray(content.places) ? content.places as JsonObject[] : [];
        }
        return answer.places;
      };
      const plans = owed.spots.map((spot): Plan => {
        const around = (["nearby", "venues"] as const).map((request) => stored.held(request, spot));
        const names = around.flatMap((answer) => answer === undefined ? [] : namesIn(placesOf(answer)));
        const lacks = (["nearby", "venues"] as const).filter((_, index) => around[index] === undefined);
        return { spot, lacks: lacks.length > 0 ? lacks : settings.hints(names).filter((hint) => stored.held(hint, spot) === undefined), names };
      });
      const lookup = idsToAsk(view, owed.ids, unknown);
      await Promise.resolve();

      const ask = async (path: string, init: { body?: JsonObject; fields: string }): Promise<{ status: number; answer: JsonObject }> => {
        signal?.throwIfAborted();
        room--;
        settings.lookup(init.body === undefined
          ? { receiver: RECEIVER, request: "place", points: 0, chars: decodeURIComponent(path.slice("/v1/places/".length)).length }
          : { receiver: RECEIVER, request: "searchNearby", points: 1, chars: 0 });
        const response = await fetch(`${endpoint}${path}`, {
          method: init.body === undefined ? "GET" : "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key, "x-goog-fieldmask": init.fields },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          signal: AbortSignal.any([...(signal === undefined ? [] : [signal]), AbortSignal.timeout(REQUEST_MS)]),
        });
        const text = await response.text();
        if (!response.ok && response.status !== 404) {
          const message = `Google answered ${path} with ${response.status}: ${textHead(text, 200).replaceAll(key, "<key>")}`;
          throw keyRefused(response.status, text) ? new KeyRefused(message) : new Error(message);
        }
        return { status: response.status, answer: response.ok ? JSON.parse(text) as JsonObject : {} };
      };

      const lines: string[] = [];
      let asked = 0;
      let left = 0;
      const answered = async (request: Request, point: Point): Promise<JsonObject[] | null> => {
        if (asked >= PER_RUN || room <= 0) return null;
        asked++;
        const [latitude, longitude] = [round5(point.latitude), round5(point.longitude)];
        const { radius_m, body } = ASKS[request];
        const { answer } = await ask("/v1/places:searchNearby", { body: { ...body, locationRestriction: { circle: { center: { latitude, longitude }, radius: radius_m } } }, fields: NEARBY_FIELDS });
        lines.push(answerLine(answerKey(request, latitude, longitude, radius_m), at_ms, answer));
        const places = Array.isArray(answer.places) ? answer.places as JsonObject[] : [];
        stored.add({ request, latitude, longitude, at_ms, places });
        return places;
      };
      const ended = (output: LabelOutput | null, error: unknown): never => {
        throw new LabelerUnavailable(error instanceof KeyRefused ? "refused" : "unreadable", `Google's Places API: ${(error as Error).message}`, output);
      };

      try {
        for (const plan of plans) {
          const around = plan.lacks.filter((request) => request === "nearby" || request === "venues");
          let names = plan.names;
          let complete = true;
          for (const request of around) {
            const held = stored.held(request, plan.spot);
            const places = held !== undefined ? (Array.isArray(held.places) ? held.places : []) : await answered(request, plan.spot);
            if (places === null) complete = false;
            else names = [...names, ...namesIn(places)];
          }
          for (const hint of around.length === 0 ? plan.lacks : complete ? settings.hints(names) : []) {
            if (stored.held(hint, plan.spot) === undefined && (await answered(hint, plan.spot)) === null) complete = false;
          }
          if (!complete) left++;
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError" && signal?.aborted === true) throw error;
        ended(lines.length === 0 ? null : answers(lines, source, left + 1), error);
      }
      if (lines.length > 0) return answers(lines, source, left);

      if (lookup === undefined) return null;
      const { account, ids: listed, left: listedLeft } = lookup;
      const ids = listed.slice(0, Math.max(0, room));
      const unasked = listedLeft + listed.length - ids.length;
      if (ids.length === 0) return null;
      const statements: string[] = [];
      try {
        for (const id of ids) {
          const { status, answer } = await ask(`/v1/places/${encodeURIComponent(id.slice("google:".length))}`, { fields: NAME_FIELDS });
          const name = nameOf(answer);
          const centre = pointOf(answer);
          if (status === 404 || name === undefined || centre === null || answer.id !== id.slice("google:".length)) {
            unknown.add(id);
            continue;
          }
          statements.push(canonical({ content: { centre: { ...centre }, id: answer.id as string, name, type: "google.place" }, key: id, kind: "place" } as unknown as Json));
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError" && signal?.aborted === true) throw error;
        ended(statements.length === 0 ? null : names(statements, source, settings.unit, account, ids.length - statements.length + unasked), error);
      }
      return statements.length === 0 ? null : names(statements, source, settings.unit, account, unasked);
    },
  };
}

function idsToAsk(view: OpenView, owed: Owed["ids"], unknown: ReadonlySet<string>): { account: string; ids: string[]; left: number } | undefined {
  let account: string | undefined;
  const ids: string[] = [];
  let left = 0;
  for (const each of owed) {
    if (unknown.has(each.id) || (account !== undefined && each.account !== account)) continue;
    if (ids.length === PER_RUN) {
      left++;
      continue;
    }
    const head = view.head({ source: lookupOf(each.account), kind: "place", key: each.id });
    if (head !== undefined && head.version !== "gone") continue;
    account = each.account;
    ids.push(each.id);
  }
  return account === undefined ? undefined : { account, ids, left };
}

class Answers {
  readonly #by = new Map<string, Stored[]>();

  add(answer: Stored): void {
    const at = `${answer.request} ${band(answer.latitude)}`;
    const list = this.#by.get(at);
    if (list === undefined) this.#by.set(at, [answer]);
    else list.push(answer);
  }

  held(request: Request, point: Point): Stored | undefined {
    let best: Stored | undefined;
    for (let step = -1; step <= 1; step++) {
      for (const answer of this.#by.get(`${request} ${band(point.latitude) + step}`) ?? []) {
        if (near(answer, point) && (best === undefined || answer.at_ms > best.at_ms)) best = answer;
      }
    }
    return best;
  }
}

function band(latitude: number): number {
  return Math.floor(latitude * 1_000);
}

export function keyRefused(status: number, text: string): boolean {
  return status === 401 || status === 403 || (status === 400 && /API[_ ]KEY/iu.test(text));
}

function namesIn(places: readonly JsonObject[]): string[] {
  return places.map(nameOf).filter((name): name is string => name !== undefined);
}

function keyOf(secrets: Secrets | undefined, name: string): string | undefined {
  try {
    const key = secrets?.get(name)?.trim();
    return key === undefined || key === "" ? undefined : key;
  } catch (error) {
    if (error instanceof SecretError) return undefined;
    throw error;
  }
}

function answers(lines: readonly string[], source: string, owed: number): LabelOutput {
  return {
    files: [{ path: ANSWERS_FILE, bytes: Buffer.from(lines.map((line) => `${line}\n`).join("")) }],
    facts: { answers: lines.length, owed, sources: [{ id: source, connector: googlePlacesConnector.name }] },
  };
}

function names(lines: readonly string[], source: string, unit: string, account: string, owed: number): LabelOutput {
  return {
    files: [{ path: STATEMENTS_FILE, bytes: Buffer.from(lines.map((line) => `${line}\n`).join("")) }],
    facts: {
      statements: lines.length, device: unit, owed,
      sources: [{ id: source, connector: googlePlacesConnector.name }, { id: lookupOf(account), connector: "google-place-names" }],
    },
  };
}

function lookupOf(account: string): string {
  return `google-maps:${account}:lookup`;
}

function nameOf(place: JsonObject): string | undefined {
  const display = place.displayName as { text?: unknown } | undefined;
  return typeof display?.text === "string" && display.text.trim() !== "" ? display.text.trim() : undefined;
}

function pointOf(place: JsonObject): Point | null {
  const location = place.location as { latitude?: unknown; longitude?: unknown } | undefined;
  return typeof location?.latitude === "number" && typeof location.longitude === "number" ? { latitude: location.latitude, longitude: location.longitude } : null;
}

function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

function near(left: Point, right: Point): boolean {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const a = Math.sin(radians(right.latitude - left.latitude) / 2) ** 2 +
    Math.cos(radians(left.latitude)) * Math.cos(radians(right.latitude)) * Math.sin(radians(right.longitude - left.longitude) / 2) ** 2;
  return 6_371_008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) <= ANSWER_REACH_M;
}
