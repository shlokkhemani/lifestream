// @ts-check
/** @import { Door, FeedMessage } from './door.mjs' */
import { readBehind } from './behind.mjs';
import { NO_TOKEN, seqOf } from './door.mjs';
import { statusError } from './errors.mjs';
import { PAGES } from './pages.mjs';


const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const PICTURE_SIZES = ['tile', 'screen', 'full'];
const RECIPE = /^\d{1,9}$/u;
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);
const AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ']);
const QUICKTIME_ATOMS = new Set(['wide', 'mdat', 'moov']);
const ITEMS_PER_READ = 256;
export const QUERY_BYTES = 8 * 1024;
const PLACES_ROUTE = '/v1/places';
const PEOPLE_ROUTE = '/v1/people';
const PERSONS_KEPT = 256;
const PAGES_KEPT = 256;
export const MAC_DEVICE = 'mac/1';
const SETTINGS_PAGES = new Set(['settings', 'settingsPage', 'storage']);
const OWNER_CONNECTORS = { places: 'places-home', devices: 'devices-home', people: 'people-home' };
const STAY_PARAMETERS = ['latitude', 'longitude', 'from_ms', 'to_ms'];
const WHERE_PARAMETERS = ['at', 'from', 'to', 'grain'];
const YEARS_KEPT = 16;
const WHERE_DAYS_KEPT = 16;
/** @typedef {{ after: string, at: string, limit: string }} PhotoPage */
/** @param {PhotoPage} page */
const said = page => Object.fromEntries(Object.entries(page).filter(([, value]) => value));

const BLOB = /^sha256:[0-9a-f]{64}$/u;
const ONE_RANGE = /^bytes=(?:\d+-\d*|-\d+)$/u;
const SNIFF_BYTES = 64;
const TYPES_KEPT = 4096;

/**
 * @typedef {{ position: string, people: any[], chats: any[], organise: { queue: string[], organised: number, often: number, businesses: { id: string, reasons: Record<string, number> }[] }, others: number }} PeopleAnswer
 * @typedef {{ id: string, zone: string, start_hour: number, runs: { day: string, start_ms: number, days: number, zone: string }[] }} HomeClock
 * @typedef {{ settled?: boolean, signal?: AbortSignal }} Asked
 */


/**
 * @param {Door | null} door
 * @param {{ now?: () => number }} [options]
 */
export function lifeReader(door, { now = Date.now } = {}) {
  /**
   * @template {{ position: string }} T
   * @typedef {{ etag: string | undefined, answer: T | null, stale: boolean, reading: Promise<T> | null }} Kept
   */
  /** @returns {Kept<any>} */
  const keptNone = () => ({ etag: undefined, answer: null, stale: true, reading: null });
  /** @type {Kept<PeopleAnswer>} */
  const people = keptNone();
  /** @type {Map<string, Kept<{ position: string, person: any }>>} */
  const persons = new Map();
  /** @type {Map<string, { etag: string | undefined, answer: { position: string } }>} */
  const pages = new Map();
  /** @type {Kept<PlacesAnswer>} */
  const homePlaces = keptNone();
  /** @type {Map<string, { etag: string, answer: any }>} */
  const years = new Map();
  /** @type {Map<string, { etag: string, answer: any, labels?: Record<string, Placed>, placesAt?: number }>} */
  const dayWheres = new Map();
  let placesMoved = 0;
  /** @type {{ etag: string | undefined, answer: ProductsAnswer | null }} */
  const productsKept = { etag: undefined, answer: null };

  /**
   * @template {{ etag: string, answer: any }} E
   * @param {Map<string, E>} kept
   * @param {number} most
   * @param {string} key
   * @param {string} path
   * @param {Record<string, string>} params
   * @returns {Promise<{ entry: E, fresh: boolean }>}
   */
  async function etagged(kept, most, key, path, params) {
    const before = kept.get(key);
    const read = await reach().text(path, before?.etag, params);
    const fresh = !(read.status === 304 && before);
    const entry = /** @type {E} */ (fresh ? { etag: read.etag ?? '', answer: JSON.parse(read.text) } : before);
    kept.delete(key);
    if (read.etag) kept.set(key, entry);
    if (kept.size > most) kept.delete(/** @type {string} */ (kept.keys().next().value));
    return { entry, fresh };
  }
  let opens = 0;
  const faced = readBehind(() => currentPeople(), { open: () => opens > 0, now });
  const clock = readBehind(() => /** @type {Promise<HomeClock>} */ (reach().json('/v1/clock')), { open: () => opens > 0, now, eager: true });

  /** @param {FeedMessage} message */
  const heard = message => {
    if (message.kind !== 'event') clock.moved();
    const stale = () => {
      placesStale();
      peopleMoved();
    };
    if (message.kind === 'reset') {
      placesMoved++;
      for (const kept of [people, homePlaces, ...persons.values()]) Object.assign(kept, { answer: null, etag: undefined });
      pages.clear();
      return stale();
    }
    if (message.kind === 'open') {
      if (opens++ > 0 && door?.position() === null) stale();
      faced.opened();
      return;
    }
    const { kind, key } = message.data;
    if (kind === 'people') peopleMoved();
    if (kind === 'places') {
      placesStale();
      placesMoved++;
    }
    if (kind === 'import') {
      const lane = String(key ?? '').split('/')[0];
      if (lane.startsWith('people:')) peopleMoved();
      if (lane.startsWith('places:') || lane.startsWith('devices:')) placesStale();
    }
  };
  door?.follow(heard);

  function placesStale() {
    homePlaces.stale = true;
  }

  function peopleMoved() {
    people.stale = true;
    for (const kept of persons.values()) kept.stale = true;
    faced.moved();
  }

  /** @param {'people' | 'places' | 'devices'} of */
  function acted(of) {
    if (of === 'people') peopleMoved();
    else placesStale();
  }

  /**
   * @template {{ position: string }} T
   * @param {Kept<T>} kept
   * @param {T} answer
   * @param {string | null} etag
   */
  function keep(kept, answer, etag) {
    if (kept.answer && seqOf(answer.position) < seqOf(kept.answer.position)) return;
    kept.answer = answer;
    kept.etag = etag ?? undefined;
  }

  /**
   * @template {{ position: string }} T
   * @param {Kept<T>} kept
   * @param {string} path
   * @param {Record<string, string>} [params]
   * @param {Asked} [asked]
   * @returns {Promise<T>}
   */
  async function keptRead(kept, path, params, { settled = false, signal } = {}) {
    if (settled) {
      const read = await reach().text(path, undefined, { ...params, settled: '1' }, signal);
      keep(kept, /** @type {T} */ (JSON.parse(read.text)), read.etag);
      return /** @type {T} */ (kept.answer);
    }
    if (kept.reading && !kept.stale) return kept.reading;
    if (kept.answer && !kept.stale && opens > 0) return kept.answer;
    if (kept.reading) {
      await kept.reading.catch(() => undefined);
      return keptRead(kept, path, params);
    }
    const reading = (async () => {
      kept.stale = false;
      try {
        const read = await reach().text(path, kept.etag, params);
        if (read.status === 200 || !kept.answer) keep(kept, /** @type {T} */ (JSON.parse(read.text)), read.etag);
        else if (read.position && seqOf(read.position) > seqOf(kept.answer.position)) kept.answer = { ...kept.answer, position: read.position };
        return /** @type {T} */ (kept.answer);
      } catch (error) {
        kept.stale = true;
        throw error;
      }
    })().finally(() => {
      kept.reading = null;
    });
    kept.reading = reading;
    return reading;
  }

  const reach = () => door ?? (() => { throw statusError(NO_TOKEN, 503); })();

  /**
   * @param {{ from?: string, to?: string, limit?: string }} [asked]
   * @returns {Promise<{ day: string, total: number, families: Record<string, number> }[]>}
   */
  async function daysHeld({ from, to, limit } = {}) {
    if ((from || to) && (!DAY.test(from ?? '') || !DAY.test(to ?? ''))) throw statusError('A range of days is from and to, each YYYY-MM-DD.', 400);
    if (limit && !/^(?:[1-9]\d{0,2}|10[01]\d|102[0-4])$/u.test(limit)) throw statusError('A limit of days is 1 to 1024.', 400);
    const range = from && to ? { from, to } : {};
    const items = limit ? (await reach().json('/v1/days', { ...range, limit })).days : (await reach().all('/v1/days', range, 'days')).items;
    return items.map((/** @type {any} */ entry) => ({ day: entry.day, total: entry.counts.total, families: entry.counts.per_family }))
      .sort((/** @type {{ day: string }} */ left, /** @type {{ day: string }} */ right) => right.day.localeCompare(left.day));
  }

  /** @returns {Promise<ProductsAnswer>} */
  async function currentProducts() {
    const read = await reach().text('/v1/products', productsKept.etag);
    if (read.status === 304 && productsKept.answer) return productsKept.answer;
    const answer = /** @type {ProductsAnswer} */ (JSON.parse(read.text));
    Object.assign(productsKept, { etag: read.etag ?? undefined, answer });
    return answer;
  }

  /**
   * @param {Asked} [asked]
   * @returns {Promise<PeopleAnswer>}
   */
  const currentPeople = asked => keptRead(people, PEOPLE_ROUTE, undefined, asked);

  /**
   * @param {string} id
   * @param {Asked} [asked]
   * @returns {Promise<{ position: string, person: any }>}
   */
  async function onePerson(id, asked) {
    if (!id) throw statusError('A person is named by their id.', 400);
    const kept = persons.get(id) ?? keptNone();
    persons.delete(id);
    persons.set(id, kept);
    if (persons.size > PERSONS_KEPT) persons.delete(/** @type {string} */ (persons.keys().next().value));
    return keptRead(kept, PEOPLE_ROUTE, { id }, asked);
  }

  /**
   * @param {string} name
   * @param {Record<string, string>} params
   * @param {Asked} [asked]
   * @returns {Promise<{ position: string }>}
   */
  async function page(name, params, { settled = false, signal } = {}) {
    const entry = PAGES[name];
    if (!entry) throw statusError('No such page.', 404);
    const key = `${name}?${new URLSearchParams(params)}`;
    const before = pages.get(key);
    const read = await reach().text(entry.route, before?.etag, { ...params, ...settled ? { settled: '1' } : {} }, signal,
      entry.device && (params.unit || SETTINGS_PAGES.has(name)) ? MAC_DEVICE : undefined);
    /** @type {{ etag: string | undefined, answer: { position: string } }} */
    let landed;
    const confirmed = read.status === 304 && before !== undefined;
    if (confirmed) {
      const moved = read.position && seqOf(read.position) > seqOf(before.answer.position);
      landed = moved ? { ...before, answer: { ...before.answer, position: /** @type {string} */ (read.position) } } : before;
    } else {
      landed = { etag: read.etag ?? undefined, answer: /** @type {{ position: string }} */ (JSON.parse(read.text)) };
    }
    const current = pages.get(key);
    const behind = current !== undefined && (confirmed && current !== before
      ? seqOf(landed.answer.position) <= seqOf(current.answer.position)
      : seqOf(landed.answer.position) < seqOf(current.answer.position));
    const kept = behind ? /** @type {typeof landed} */ (current) : landed;
    pages.delete(key);
    pages.set(key, kept);
    if (pages.size > PAGES_KEPT) pages.delete(/** @type {string} */ (pages.keys().next().value));
    return kept.answer;
  }

  /** @returns {any} */
  function peopleNow() {
    const value = faced.get();
    return value === null ? null : { ...value, building: faced.building };
  }

  /**
   * @param {string} id
   * @param {PhotoPage} page
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ position: string, photos: any[], total: number, next?: string }>}
   */
  async function personPhotos(id, page, signal) {
    if (!id) throw statusError('A person is named by their id.', 400);
    return reach().json('/v1/people/photos', { id, ...said(page) }, signal);
  }

  /** @type {Resolve} */
  async function resolve({ ids = [], chats = [], points = [] }) {
    /** @type {Resolved} */
    const resolved = { names: new Map(), chats: new Map(), places: new Map() };
    const queries = boundedQueries({ id: ids, chat: chats, point: points });
    const reads = await Promise.all(queries.map(asked => reach().json('/v1/labels', asked)));
    for (const [at, read] of reads.entries()) {
      const asked = queries[at];
      for (const [each, name, by, person] of read.names) resolved.names.set(each, { name, by, person });
      for (const [key, title, group, open] of read.chats) resolved.chats.set(key, { title, group: group === true, open: open ?? null });
      read.places.forEach((/** @type {[number, number, string | null, string | null]} */ [, , slug, name], /** @type {number} */ index) =>
        resolved.places.set(asked.point[index], { slug, name }));
    }
    return resolved;
  }

  /**
   * @param {keyof typeof OWNER_CONNECTORS} product
   * @returns {Promise<string | null>}
   */
  async function ownerSource(product) {
    const { items } = await reach().all('/v1/sources', { product }, 'sources');
    return items.find(source => source.connector === OWNER_CONNECTORS[product])?.id ?? null;
  }

  /**
   * @param {Asked} [asked]
   * @returns {Promise<PlacesAnswer>}
   */
  const currentPlaces = asked => keptRead(homePlaces, PLACES_ROUTE, undefined, asked);

  /**
   * @param {string} unit
   * @returns {Promise<{ place?: PlaceRef | null, from?: PlaceRef | null, to?: PlaceRef | null }>}
   */
  async function placed(unit) {
    if (!unit) throw statusError('A stay or a move is named by its unit.', 400);
    const { content } = await extract({ family: 'physical', unit });
    /** @param {(Point | null | undefined)[]} points @returns {Promise<(PlaceRef | null)[]>} */
    const at = async points => {
      const { places: found } = await resolve({ points: points.flatMap(point => point ? [pointQuery(point)] : []) });
      return points.map(point => point ? { ...found.get(pointQuery(point)) ?? { slug: null, name: null },
        latitude: point.latitude, longitude: point.longitude } : null);
    };
    if (content?.kind === 'stay') return { place: (await at([content.centre]))[0] };
    if (content?.kind === 'trip') {
      const [from, to] = await at([content.from, content.to]);
      return { from, to };
    }
    return {};
  }

  /**
   * @param {string} slug
   * @param {Asked} [asked]
   */
  async function onePlace(slug, { settled = false, signal } = {}) {
    if (!slug) throw statusError('A place is named by its id.', 400);
    return reach().json(PLACES_ROUTE, { slug, ...settled ? { settled: '1' } : {} }, signal);
  }

  /**
   * @param {string} slug
   * @param {PhotoPage} page
   * @param {AbortSignal} [signal]
   */
  async function placePhotos(slug, page, signal) {
    if (!slug) throw statusError('A place is named by its id.', 400);
    return reach().json('/v1/places/photos', { slug, ...said(page) }, signal);
  }

  /** @param {Record<string, string> & { q?: string }} asked */
  async function suggest(asked) {
    const words = asked.q === undefined ? {} : { q: asked.q };
    if (asked.spot) {
      return reach().json('/v1/places/suggest', { spot: asked.spot, ...words }).catch(error => {
        if (/** @type {{ code?: string }} */ (error).code === 'SPOT_UNKNOWN') placesStale();
        throw error;
      });
    }
    const params = Object.fromEntries(STAY_PARAMETERS.map(name => [name, asked[name] ?? '']));
    if (Object.values(params).some(value => value === '' || !Number.isFinite(Number(value)))) {
      throw statusError('A spot is named by its key, a stay by its latitude, longitude, from_ms and to_ms.', 400);
    }
    return reach().json('/v1/places/suggest', { ...params, ...words });
  }

  /** @param {Record<string, string>} asked */
  async function whereWas(asked) {
    const params = Object.fromEntries(WHERE_PARAMETERS.flatMap(name => asked[name] ? [[name, asked[name]]] : []));
    if (params.grain === 'year') return (await etagged(years, YEARS_KEPT, new URLSearchParams(params).toString(), '/v1/where', params)).entry.answer;
    if (!params.grain && !params.at && DAY.test(params.from ?? '') && params.from === params.to) return whereDay(params.from);
    return reach().json('/v1/where', params);
  }

  /** @param {string} day */
  async function whereDay(day) {
    const at = placesMoved;
    const { entry, fresh } = await etagged(dayWheres, WHERE_DAYS_KEPT, day, '/v1/where', { from: day, to: day });
    if (fresh || entry.placesAt !== at || !entry.labels) {
      const points = [...new Set((entry.answer.pieces ?? []).flatMap((/** @type {any} */ piece) =>
        piece.kind === 'stay' && piece.point ? [pointQuery(piece.point)] : []))];
      const { places: found } = points.length ? await resolve({ points }) : { places: new Map() };
      entry.labels = Object.fromEntries(points.map(point => [point, found.get(point) ?? { slug: null, name: null }]));
      entry.placesAt = at;
    }
    return { ...entry.answer, labels: entry.labels };
  }

  async function devices() {
    const [answer, source] = await Promise.all([reach().json('/v1/devices'), ownerSource('devices')]);
    return { position: answer.position, cameras: answer.cameras, source };
  }

  /** @type {Map<string, string | null>} */
  const mediaTypes = new Map();

  /**
   * @param {string} hash
   * @param {AbortSignal} [signal]
   */
  async function sniffed(hash, signal) {
    let type = mediaTypes.get(hash);
    if (type === undefined) {
      const head = await reach().stream(`/v1/blobs/${hash}`, { range: `bytes=0-${SNIFF_BYTES - 1}` }, signal);
      type = mediaType(new Uint8Array(await new Response(head.body).arrayBuffer()));
      if (mediaTypes.size >= TYPES_KEPT) mediaTypes.delete(/** @type {string} */ (mediaTypes.keys().next().value));
      mediaTypes.set(hash, type);
    }
    return type;
  }

  /**
   * @param {string} hash
   * @param {string} range
   * @param {AbortSignal} [signal]
   */
  async function media(hash, range, signal) {
    if (!BLOB.test(hash)) throw statusError('A blob is named sha256:<64 hex>.', 400);
    const type = await sniffed(hash, signal);
    if (type === null || type.startsWith('image/')) throw statusError('That blob is no sound or film a browser plays.', 404);
    const answer = await reach().stream(`/v1/blobs/${hash}`, ONE_RANGE.test(range) ? { range } : {}, signal);
    return { type, ...answer };
  }

  /**
   * @param {string} hash
   * @param {AbortSignal} [signal]
   */
  async function download(hash, signal) {
    if (!BLOB.test(hash)) throw statusError('A blob is named sha256:<64 hex>.', 400);
    return reach().stream(`/v1/blobs/${hash}`, {}, signal);
  }

  /**
   * @param {string} hash
   * @param {string} size
   * @param {string} recipe
   * @param {string} etag
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ status: number, type: string, etag: string | null, cache: string | null, body: ReadableStream<Uint8Array> | null }>}
   */
  async function picture(hash, size, recipe, etag, signal) {
    if (!BLOB.test(hash)) throw statusError('A picture is named sha256:<64 hex>.', 400);
    if (!PICTURE_SIZES.includes(size)) throw statusError('A picture is asked at tile, screen or full.', 400);
    if (recipe && !RECIPE.test(recipe)) throw statusError('A recipe is a whole number.', 400);
    /** @type {Record<string, string>} */
    const validator = etag ? { 'if-none-match': etag } : {};
    const answer = await reach().stream(`/v1/pictures/${hash}?${new URLSearchParams({ size, ...recipe ? { recipe } : {} })}`,
      validator, signal);
    return { status: answer.status, type: answer.headers.get('content-type') ?? 'application/octet-stream',
      etag: answer.headers.get('etag'), cache: answer.headers.get('cache-control'), body: answer.body };
  }

  const pictures = () => reach().json('/v1/pictures');

  /**
   * @param {string} hash
   * @param {AbortSignal} [signal]
   */
  async function photo(hash, signal) {
    if (!BLOB.test(hash)) throw statusError('A photo is named sha256:<64 hex>.', 400);
    return reach().json(`/v1/photos/${hash}`, undefined, signal);
  }

  /** @param {{ source: string, kind: string, key: string }} ref */
  async function record(ref) {
    if (!ref.source || !ref.kind || !ref.key) throw statusError('A record is named by its source, kind and key.', 400);
    return reach().json('/v1/record', { ...ref, history: '1', text: '1' });
  }

  /** @param {string} ref */
  async function read(ref) {
    if (!ref) throw statusError('A read is named by its ref.', 400);
    return reach().json('/v1/read', { ref });
  }

  /** @param {string[]} refs */
  async function describe(refs) {
    if (refs.length === 0) throw statusError('A describe is named by its refs.', 400);
    return reach().json('/v1/describe', { ref: refs });
  }

  /** @param {{ family: string, unit: string }} ref */
  async function extract(ref) {
    if (!ref.family || !ref.unit) throw statusError('An extract is named by its family and unit.', 400);
    const read = await reach().json('/v1/extracts', ref);
    return { position: read.position, ...read.extracts[0] };
  }

  /**
   * @param {string} chat
   * @param {string} day
   */
  async function conversation(chat, day) {
    if (!chat || !DAY.test(day)) throw statusError('A conversation is named by its chat and its day.', 400);
    return reach().json('/v1/conversation', { chat, day });
  }

  return {
    days: daysHeld,
    products: currentProducts,
    clock: () => clock.fresh(),
    clockNow: () => clock.get(),
    record,
    read,
    describe,
    extract,
    conversation,
    people: currentPeople,
    person: onePerson,
    page,
    personPhotos,
    /** @returns {any} */
    peopleNow,
    ownerSource,
    acted,
    places: currentPlaces,
    placed,
    onePlace,
    placePhotos,
    suggest,
    photo,
    where: whereWas,
    devices,
    media,
    download,
    picture,
    pictures,
  };
}

/** @typedef {{ latitude: number, longitude: number, id?: string }} Point */

/** @param {Point} point */
const pointQuery = point => `${point.latitude},${point.longitude}${point.id ? `,${point.id}` : ''}`;

/**
 * @typedef {{ name: string, by: string, person: string | null }} Named
 * @typedef {{ slug: string | null, name: string | null }} Placed
 * @typedef {{ label: string, href: string }} Open
 * @typedef {{ names: Map<string, Named>, chats: Map<string, { title: string, group: boolean, open: Open | null }>, places: Map<string, Placed> }} Resolved
 * @typedef {(asked: { ids?: string[], chats?: string[], points?: string[] }) => Promise<Resolved>} Resolve
 * @typedef {{ slug: string | null, name: string | null, latitude: number, longitude: number }} PlaceRef
 */

/** @typedef {{ digest: string, products: Record<string, { name: string, row: string, vendor: string, icon: string, type: string | null, connector: string }> }} ProductsAnswer */

/** @typedef {{ position: string, places: any[], spots: any[], hidden: any[], here: any, day: string, day_until_ms: number, counting?: true }} PlacesAnswer */

/**
 * @param {Uint8Array} bytes
 * @returns {string | null}
 */
export function mediaType(bytes) {
  const text = (/** @type {number} */ from, /** @type {number} */ to) => Buffer.from(bytes.subarray(from, to)).toString('latin1');
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (text(0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (text(0, 6) === 'GIF87a' || text(0, 6) === 'GIF89a') return 'image/gif';
  if (text(0, 4) === 'RIFF') return text(8, 12) === 'WEBP' ? 'image/webp' : text(8, 12) === 'WAVE' ? 'audio/wav' : null;
  if (text(4, 8) === 'ftyp') {
    const brand = text(8, 12);
    if (HEIF_BRANDS.has(brand)) return 'image/heic';
    if (AVIF_BRANDS.has(brand)) return 'image/avif';
    if (AUDIO_BRANDS.has(brand)) return 'audio/mp4';
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  if (QUICKTIME_ATOMS.has(text(4, 8))) return 'video/quicktime';
  if (text(0, 4) === 'OggS') return 'audio/ogg';
  if (text(0, 4) === 'caff') return 'audio/x-caf';
  if (text(0, 4) === '\x1aE\xdf\xa3') return 'video/webm';
  if (text(0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return null;
}

/**
 * @param {Record<string, string[]>} asked
 * @returns {Record<string, string[]>[]}
 */
export function boundedQueries(asked) {
  /** @type {Record<string, string[]>[]} */
  const queries = [];
  const empty = () => Object.fromEntries(Object.keys(asked).map(name => [name, /** @type {string[]} */ ([])]));
  let current = empty();
  let bytes = 0;
  for (const [name, values] of Object.entries(asked)) {
    for (const value of new Set(values)) {
      const size = new URLSearchParams({ [name]: value }).toString().length + 1;
      if (current[name].length === ITEMS_PER_READ || (bytes > 0 && bytes + size > QUERY_BYTES)) {
        queries.push(current);
        current = empty();
        bytes = 0;
      }
      current[name].push(value);
      bytes += size;
    }
  }
  if (bytes > 0) queries.push(current);
  return queries;
}

/** @typedef {ReturnType<typeof lifeReader>} LifeReader */
