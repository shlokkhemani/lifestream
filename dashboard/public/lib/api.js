// @ts-check
/**
 * @import { HomeClock, StreamsReport } from '../types.js'
 * @import { PlaysCount } from '../ui/search/query.js'
 * @import { Pages } from '../pages.js'
 * @import { SearchState } from '../ui/connectors/settings-search.js'
 * @import { AskEvent, ChatList, Conversation } from '../ui/ask/turns.js'
 */
import { actSaid, budget, checkAfter, requestState, SAVING, answerUnknown, UNSAVED } from './reach.js';

/**
 * @param {string} path
 * @param {unknown} [body]
 * @param {string} [method]
 * @param {AbortSignal} [signal]
 * @param {RequestCache} [cache]
 * @returns {Promise<unknown>}
 */
async function call(path, body, method = body ? 'POST' : 'GET', signal = undefined, cache = undefined) {
  const init = method === 'GET'
    ? { signal, ...(cache ? { cache } : {}) }
    : {
      signal,
      method,
      headers: { 'Content-Type': 'application/json', 'X-Viewer-Request': '1' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    };
  return valueOf(await fetch('api/' + path, init));
}

/**
 * @param {Response} response
 * @returns {Promise<unknown>}
 */
async function valueOf(response) {
  const value = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(value.error), { status: response.status, code: value.code ?? '',
      retryAfter: Number(response.headers.get('retry-after')) || 0, ...(typeof value.wait === 'string' ? { wait: value.wait } : {}),
      ...(Array.isArray(value.refused) ? { refused: value.refused } : {}), ...(Array.isArray(value.building) ? { building: value.building } : {}),
      ...(typeof value.again === 'boolean' ? { again: value.again } : {}), ...(typeof value.began === 'boolean' ? { began: value.began } : {}) });
  }
  return value;
}

/** @param {string | null | undefined} unit */
const connectorsPage = unit => unit ? `page/connectors?unit=${encodeURIComponent(unit)}` : 'page/connectors';

/** @param {string | null} [unit] */
export const fetchConnectors = (unit = null) => /** @type {Promise<StreamsReport>} */ (call(connectorsPage(unit)));

/**
 * @param {string | null | undefined} unit
 * @param {string} etag
 * @returns {Promise<{ report: StreamsReport, etag: string } | null>}
 */
export async function fetchStreams(unit, etag) {
  const response = await fetch(`api/${connectorsPage(unit)}`, etag ? { headers: { 'If-None-Match': etag } } : {});
  if (response.status === 304) return null;
  return { report: /** @type {StreamsReport} */ (await valueOf(response)), etag: response.headers.get('etag') ?? '' };
}

/** @returns {Promise<import('../types.js').StartCost>} */
export const fetchStartCost = () => /** @type {Promise<any>} */ (call('start/cost'));

/** @returns {Promise<import('../types.js').PrivacyRead>} */
export const fetchPrivacy = () => /** @type {Promise<any>} */ (call('privacy'));

/**
 * @param {{ from?: string, to?: string, receiver?: string, before?: number }} [range]
 * @returns {Promise<import('../types.js').OutboundList>}
 */
export const fetchOutbound = (range = {}) => /** @type {Promise<any>} */ (call('outbound?' + new URLSearchParams(
  Object.entries(range).filter(([, value]) => value !== undefined && value !== '').map(([name, value]) => [name, String(value)]))));

/**
 * @param {{ family: string, item: string }} item
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ rows: import('../types.js').OutboundRow[] }>}
 */
export const fetchItemOutbound = ({ family, item }, signal) => /** @type {Promise<any>} */ (call('outbound?'
  + new URLSearchParams({ family, item }), undefined, 'GET', signal));

/**
 * @param {number} seq
 * @returns {Promise<import('../types.js').OutboundOne>}
 */
export const fetchOutboundRow = seq => /** @type {Promise<any>} */ (call(`outbound/row?seq=${seq}`));

/** @returns {Promise<import('../types.js').AgentsList>} */
export const fetchAgents = () => /** @type {Promise<any>} */ (call('agents'));

/** @returns {Promise<{ requests: import('../types.js').SignIn[] }>} */
export const fetchWaiting = () => /** @type {Promise<any>} */ (call('agents/waiting'));

/**
 * @param {string} id
 * @returns {Promise<import('../types.js').AgentRead>}
 */
export const fetchAgent = id => /** @type {Promise<any>} */ (call('agents/one?' + new URLSearchParams({ id })));

/**
 * @param {string} id
 * @param {string} [before]
 * @param {string} [kind]
 * @returns {Promise<import('../types.js').HistoryPage>}
 */
export const fetchAgentHistory = (id, before, kind) => /** @type {Promise<any>} */ (call('agents/history?'
  + new URLSearchParams({ id, ...before ? { before } : {}, ...kind ? { kind } : {} })));

/**
 * @param {string} id
 * @param {string} read
 * @returns {Promise<import('../types.js').ReadPage>}
 */
export const fetchRead = (id, read) => /** @type {Promise<any>} */ (call('agents/read?' + new URLSearchParams({ id, read })));

/**
 * @param {string} id
 * @param {string} read
 * @param {string} [before]
 * @returns {Promise<import('../types.js').ThingsPage>}
 */
export const fetchThings = (id, read, before) => /** @type {Promise<any>} */ (call('agents/things?'
  + new URLSearchParams({ id, read, ...before ? { before } : {} })));

/**
 * @param {string} id
 * @returns {Promise<import('../types.js').AgentAsk>}
 */
export const fetchAsk = id => /** @type {Promise<any>} */ (call('agents/ask?' + new URLSearchParams({ id })));

/**
 * @param {string} id
 * @returns {Promise<import('../types.js').SignInRead>}
 */
export const fetchSignIn = id => /** @type {Promise<any>} */ (call('agents/signin?' + new URLSearchParams({ id })));

/**
 * @param {import('../types.js').EditRequest} asked
 * @returns {Promise<import('../types.js').AccessDraft>}
 */
export const editAccess = asked => /** @type {Promise<any>} */ (call('agents/edit', asked));

/**
 * @param {import('../types.js').AnswerRequest} answer
 * @returns {Promise<import('../types.js').AnswerReply>}
 */
export const answerAgent = answer => /** @type {Promise<any>} */ (call('agents/answer', answer));

/**
 * @param {string} id
 * @param {{ access: import('../types.js').DraftAccess, expect: number }} saved
 * @returns {Promise<import('../types.js').AccessDraft>}
 */
export const saveAccess = (id, saved) => /** @type {Promise<any>} */ (call('agents/access', { id, ...saved }));

/**
 * @param {string} connector
 * @param {string} value
 * @returns {Promise<import('../types.js').Step>}
 */
export const fetchRangeStep = (connector, value) => /** @type {Promise<any>} */ (call('processing/range?'
  + new URLSearchParams({ connector, value })));

/** @param {import('../ui/connectors/words.js').HomeAct} act */
export const actOnNeed = act => call('act', act);

/**
 * @param {string} connector
 * @returns {Promise<{ state: 'queued' | 'asked' | 'blocked', blocked?: { reason: string, words: string, until_ms: number | null } }>}
 */
export const refreshNow = connector => /** @type {Promise<any>} */ (call('refresh', { connector }));

/** @returns {Promise<SearchState>} */
export const fetchSearchState = () => /** @type {Promise<SearchState>} */ (call('search/state'));

/**
 * @param {URLSearchParams} params
 * @returns {Promise<PlaysCount>}
 */
export const fetchPlays = params => /** @type {Promise<PlaysCount>} */ (call(`count?${params}`));

/**
 * @param {{ model?: string, thinking?: string }} pick
 * @param {AbortSignal} [signal]
 * @returns {Promise<AskReady>}
 */
export const fetchAskReady = (pick, signal) => {
  const query = new URLSearchParams(pick).toString();
  return /** @type {Promise<AskReady>} */ (call(query ? `ask?${query}` : 'ask', undefined, 'GET', signal));
};

/** @typedef {{ id: string, name: string, thinking: string[], default: string, state: string, photos_off: string | null, hides: boolean }} AskModel */

/** @typedef {{ models: AskModel[], menu?: import('../pages.js').ModelMenu, default: { model: string | null, thinking: string, shown: string | null, choose: string | null }, said?: string, act?: string, gone?: true, starters: { kind: string, question: string }[], unsaved_in_ms?: number, voice: AskVoiceReady, limits: AskLimits }} AskReady */

/** @typedef {{ photos: number, photo_bytes: number, voice_ms: number }} AskLimits */

/** @typedef {{ ready: boolean, words: string, line: string | null, caution: string | null, value: string, choices: { value: string, words: string, sent: boolean }[] }} AskVoiceReady */

/** @typedef {{ file: string, kind: 'photo', width?: number, height?: number, read?: false }} StagedPhoto */

/**
 * @param {string} path
 * @param {{ method: string, body?: Blob | Uint8Array, type?: string, signal?: AbortSignal }} init
 */
async function fileCall(path, { method, body, type = 'application/octet-stream', signal }) {
  const response = await fetch('api/' + path, { method, signal, ...(body ? { body: /** @type {BodyInit} */ (body) } : {}),
    headers: { 'X-Viewer-Request': '1', ...(body ? { 'Content-Type': type } : {}) } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value.error || 'Lifestream could not take it.'), { status: response.status, code: value.code ?? '' });
  return value;
}

/**
 * @param {File} file
 * @param {AbortSignal} [signal]
 */
export const uploadPhoto = (file, signal) => /** @type {Promise<StagedPhoto>} */ (fileCall('ask/files',
  { method: 'POST', body: file, type: file.type || 'application/octet-stream', signal }));

/** @typedef {{ kind: 'menu' } | { kind: 'chat', chat: string, n: number } | { kind: 'connector', connector: string }} FeedbackAbout */
/** @typedef {{ id: string, text: string, email: string | null, keep: import('../pages.js').FeedbackKind[] }} FeedbackSent */

/**
 * @param {string} id
 * @param {FeedbackAbout} about
 */
export const fetchFeedbackDraft = (id, about) => /** @type {Promise<import('../pages.js').FeedbackDraft>} */ (
  call('feedback/draft', { id, about }));

/**
 * @param {string} id
 * @param {Uint8Array} jpeg
 */
export const sendFeedbackShot = (id, jpeg) => /** @type {Promise<{ width: number, height: number }>} */ (
  fileCall(`feedback/screenshot?${new URLSearchParams({ id })}`, { method: 'POST', body: jpeg, type: 'image/jpeg' }));

/** @param {FeedbackSent} report */
export const sendFeedback = report => /** @type {Promise<{ id: string }>} */ (call('feedback/send', report));

/** @param {string} note */
export const openNote = note => fileCall(`ask/notes?${new URLSearchParams({ note })}`, { method: 'POST' });

/**
 * @param {string} note
 * @param {number} k
 * @param {Uint8Array} bytes
 */
export const sendSecond = (note, k, bytes) => fileCall(`ask/notes?${new URLSearchParams({ note, k: String(k) })}`,
  { method: 'PUT', body: bytes });

/** @param {string} note */
export const cancelNote = note => fileCall(`ask/notes?${new URLSearchParams({ note })}`, { method: 'DELETE' });

/** @typedef {{ submission?: string, question?: string, chat?: string, model?: string, thinking?: string, level?: string, photos?: string[], voice?: { note: string, seconds: number } | { audio: string } }} AskBody */

/**
 * @param {string} chat
 * @param {AbortSignal} [signal]
 * @returns {Promise<ChatPrivacy>}
 */
export const fetchChatPrivacy = (chat, signal) => /** @type {Promise<ChatPrivacy>} */ (call(`ask/privacy?${new URLSearchParams({ chat })}`,
  undefined, 'GET', signal));

/** @typedef {{ chat: string, level: 'all' | 'names' | 'none', epoch: number }} ChatPrivacy */

/**
 * @param {string} [after]
 * @param {AbortSignal} [signal]
 */
export const fetchChats = (after, signal) => /** @type {Promise<ChatList>} */ (call('ask/chats'
  + (after ? `?${new URLSearchParams({ after })}` : ''), undefined, 'GET', signal, 'no-store'));

/**
 * @param {string} chat
 * @param {AbortSignal} [signal]
 */
export const fetchChat = (chat, signal) => /** @type {Promise<Conversation>} */ (call(`ask/chat?${new URLSearchParams({ chat })}`,
  undefined, 'GET', signal));

/** @param {string} chat */
export const stopAsk = chat => /** @type {Promise<{ stopped: boolean }>} */ (call('ask/stop', { chat }));

/**
 * @param {{ ask: AskBody } | { follow: string }} what
 * @param {(event: AskEvent) => void} onEvent
 * @param {AbortSignal} signal
 */
export async function askEvents(what, onEvent, signal) {
  const response = 'ask' in what
    ? await fetch('api/ask', {
      method: 'POST', body: JSON.stringify(what.ask), signal,
      headers: { 'Content-Type': 'application/json', 'X-Viewer-Request': '1' },
    })
    : await fetch(`/api/ask/events?${new URLSearchParams({ chat: what.follow })}`, { signal });
  if (response.status === 204) return false;
  if (!response.ok || !response.body) {
    const value = await response.json().catch(() => ({}));
    throw Object.assign(new Error(value.error || 'Chat could not be asked.'), { status: response.status, code: value.code ?? '',
      ...(value.missing && typeof value.missing === 'object' ? { missing: value.missing } : {}) });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return true;
    buffer += decoder.decode(value, { stream: true });
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim()) onEvent(JSON.parse(line));
    }
  }
}

/**
 * @param {{ from?: string, to?: string, limit?: number }} [asked]
 * @returns {Promise<{ day: string, total: number, families: Record<string, number> }[]>}
 */
export const fetchLifeDays = (asked = {}) => {
  const query = new URLSearchParams(Object.entries(asked).flatMap(([name, value]) => value === undefined ? [] : [[name, String(value)]]));
  return /** @type {Promise<any>} */ (call(`life/days${query.size ? `?${query}` : ''}`));
};

/** @returns {Promise<HomeClock>} */
export const fetchClock = () => /** @type {Promise<any>} */ (call('clock'));

/** @returns {Promise<{ digest: string, products: import('./kinds.js').Products }>} */
export const fetchLifeProducts = () => /** @type {Promise<any>} */ (call('life/products'));

/**
 * @param {{ source: string, kind: string, key: string }} ref
 * @returns {Promise<{ source: string, kind: string, key: string, head: { version: string, stated_ms: number, since_ms: number }, version: { id: string, content: unknown, start_ms: number | null, end_ms: number | null } | null, blobs: string[], history: { seq: number, version: string, stated_ms: number }[], text: { title?: string, text: string, who?: string[], link?: string } | null, open: { label: string, href: string } | null }>}
 */
export const fetchLifeRecord = ref => /** @type {Promise<any>} */ (call('life/record?' + new URLSearchParams(ref)));

export const fetchLifeRead = (/** @type {string} */ ref) => /** @type {Promise<any>} */ (call('life/read?' + new URLSearchParams({ ref })));

export const fetchLifeDescribe = (/** @type {string[]} */ refs) => /** @type {Promise<{ described: any[], unopened?: string[] }>} */ (call('life/describe?' + new URLSearchParams(refs.map(ref => ['ref', ref]))));

/**
 * @param {{ family: string, unit: string }} ref
 * @returns {Promise<{ family: string, unit: string, reading: string, content: unknown, start_ms: number | null, end_ms: number | null, days: string[], items: string[] }>}
 */
export const fetchLifeExtract = ref => /** @type {Promise<any>} */ (call('life/extract?' + new URLSearchParams(ref)));

/** @typedef {{ chat: string, day: string, title: string, messages: { source: string, key: string, at: number, parts?: { what: string, blob?: string, seconds?: number, transcribed?: import('../types.js').Made | null }[] }[] }} ChatDay */

/**
 * @param {string} chat
 * @param {string} day
 * @returns {Promise<ChatDay>}
 */
export const fetchLifeConversation = (chat, day) => /** @type {Promise<any>} */ (call('life/conversation?'
  + new URLSearchParams({ chat, day })));

/**
 * @param {string} hash
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ position: string, photo: import('../ui/kit/photo-viewer.js').PhotoFacts }>}
 */
export const fetchPhoto = (hash, signal) => /** @type {Promise<any>} */ (call('life/photos?' + new URLSearchParams({ hash }),
  undefined, 'GET', signal));

/** @typedef {'tile' | 'screen' | 'full'} PictureSize */

/** @type {string | null} */
let recipe = null;

/** @returns {Promise<void>} */
export const readRecipe = () => fetch('/api/life/pictures').then(answer => answer.ok ? answer.json() : null)
  .then(answer => {
    if (Number.isSafeInteger(answer?.recipe)) recipe = String(answer.recipe);
  }, () => undefined);
void readRecipe();

const SQUARES_KEPT = 8;
/** @type {Map<string, string>} */
const squares = new Map();

/**
 * @param {string} hash
 * @param {PictureSize} size
 */
export const pictureUrl = (hash, size) => squares.get(hash)
  ?? '/api/life/picture?' + new URLSearchParams({ hash, size, ...recipe ? { recipe } : {} });

/**
 * @param {string} hash
 * @param {Blob} square
 */
export function keepPicture(hash, square) {
  const url = squares.get(hash) ?? URL.createObjectURL(square);
  squares.delete(hash);
  squares.set(hash, url);
  for (const [oldest, gone] of squares) {
    if (squares.size <= SQUARES_KEPT) break;
    squares.delete(oldest);
    URL.revokeObjectURL(gone);
  }
}

/** @param {string} hash */
export function forgetPicture(hash) {
  const url = squares.get(hash);
  if (!url) return;
  squares.delete(hash);
  URL.revokeObjectURL(url);
}

/** @param {string} hash */
export const lifeMediaUrl = hash => '/api/life/media?hash=' + encodeURIComponent(hash);

/** @param {string} hash */
export const lifeDownloadUrl = hash => '/api/life/download?hash=' + encodeURIComponent(hash);

/** @typedef {{ settled?: true, signal?: AbortSignal }} Settled */

/**
 * @param {string} path
 * @param {Record<string, string>} params
 * @param {Settled} asked
 */
const settledCall = (path, params, { settled, signal }) => {
  const query = Object.entries({ ...params, ...settled ? { settled: '1' } : {} })
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&');
  return call(query ? `${path}?${query}` : path, undefined, 'GET', signal);
};

/**
 * @param {Settled} [asked]
 * @returns {Promise<import('./places.js').PlacesIndex>}
 */
export const fetchLifePlaces = (asked = {}) => /** @type {Promise<any>} */ (settledCall('life/places', {}, asked));

/**
 * @param {string} unit
 * @returns {Promise<import('../ui/days/viewers.js').Placed>}
 */
export const fetchLifePlaced = unit => /** @type {Promise<any>} */ (call('life/placed?' + new URLSearchParams({ unit })));

/**
 * @param {string} slug
 * @param {Settled} [asked]
 */
export const fetchLifePlace = (slug, asked = {}) => /** @type {Promise<{ position: string, place: import('./places.js').OnePlace }>} */ (
  settledCall('life/places', { slug }, asked));

/** @typedef {{ after?: string, at?: number, limit?: number }} PhotoPage */
/** @param {PhotoPage} page */
const photoPage = page => Object.entries(page).flatMap(([name, value]) => value === undefined || value === '' ? [] : [[name, String(value)]]);

/**
 * @param {string} slug
 * @param {PhotoPage} [page]
 */
export const fetchPlacePhotos = (slug, page = {}) => /** @type {Promise<import('./places.js').PlacePhotos>} */ (
  call('life/places/photos?' + new URLSearchParams([['slug', slug], ...photoPage(page)])));

/**
 * @param {({ spot: string } | { latitude: number, longitude: number, from_ms: number, to_ms: number }) & { q?: string }} asked
 * @returns {Promise<import('./places.js').Suggested>}
 */
export const fetchSuggestions = asked => /** @type {Promise<any>} */ (call('life/places/suggest?' + new URLSearchParams(
  Object.fromEntries(Object.entries(asked).map(([name, value]) => [name, String(value)])))));

/** @param {{ from: string, to: string, grain?: string }} asked */
export const fetchWhere = asked => /** @type {Promise<any>} */ (call(`life/where?${new URLSearchParams(asked)}`));

export const fetchDevices = () => /** @type {Promise<{ cameras: import('./where.js').Camera[], source: string | null }>} */ (call('life/devices'));

/**
 * @template {keyof Pages} N
 * @param {N} name
 * @param {Record<string, string>} [params]
 * @param {Settled} [asked]
 * @returns {Promise<Pages[N]>}
 */
export const fetchPage = (name, params = {}, asked = {}) => /** @type {Promise<any>} */ (settledCall(`page/${name}`, params, asked));

/** @param {Settled} [asked] */
export const fetchPeople = (asked = {}) => /** @type {Promise<import('../ui/people/words.js').People>} */ (settledCall('life/people', {}, asked));

/**
 * @param {string} id
 * @param {PhotoPage} [page]
 */
export const fetchPersonPhotos = (id, page = {}) => /** @type {Promise<import('../ui/people/words.js').Photos>} */ (
  call('life/people/photos?' + new URLSearchParams([['id', id], ...photoPage(page)])));

export const fetchFaces = () => /** @type {Promise<import('./faces.js').Deck | import('./faces.js').Unread>} */ (call('faces'));

/** @param {string} id */
export const fetchFaceGroup = id => /** @type {Promise<import('./faces.js').Card>} */ (call('faces/group?id=' + encodeURIComponent(id)));

/** @param {string} id */
export const fetchFacesLikely = id => /** @type {Promise<{ groups: import('../ui/people/organise.js').Group[] }>} */ (
  call('faces/likely?id=' + encodeURIComponent(id)));

/** @typedef {{ act: string | null, id: string | null, position: string, payoff?: { slug: string, name: string, photos: number, days: number | null } | null }} OwnerAnswer */
/** @typedef {{ of: 'people' | 'places' | 'devices' } & Record<string, unknown>} OwnerAction */

/**
 * @param {OwnerAction} action
 * @param {string} request
 * @param {{ sends?: import('./reach.js').Budget, began?: boolean }} [heard]
 * @returns {Promise<OwnerAnswer>}
 */
export async function ownerAct(action, request, { sends = budget(), began = false } = {}) {
  const body = JSON.stringify({ ...action, request });
  for (let wait = sends.next(); wait !== null; wait = sends.next()) {
    try {
      return /** @type {OwnerAnswer} */ (await valueOf(await fetch('api/owner/act', { method: 'POST', body, signal: AbortSignal.timeout(wait),
        headers: { 'Content-Type': 'application/json', 'X-Viewer-Request': '1', 'Lifestream-Wait': String(wait) } })));
    } catch (error) {
      const { status, code } = /** @type {{ status?: number, code?: string }} */ (error);
      if (status !== undefined && code !== 'OUTCOME_UNKNOWN' && !(began && code === 'NOT_NOW')) throw error;
      began ||= /** @type {{ began?: unknown }} */ (error).began === true;
    }
  }
  throw Object.assign(new Error(began ? SAVING : UNSAVED), { code: 'OUTCOME_UNKNOWN', again: true, began });
}

/**
 * @param {OwnerAction} action
 * @param {{ request?: string, waiting?: (error: unknown) => void, left?: () => boolean, after?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<OwnerAnswer>}
 */
export async function actUntilAnswered(action, {
  request = crypto.randomUUID(), waiting = () => {}, left = () => false, after = ms => new Promise(done => setTimeout(done, ms)),
} = {}) {
  let began = false;
  for (let checks = 0; ; checks += 1) {
    try {
      return await ownerAct(action, request, { began });
    } catch (error) {
      if (!answerUnknown(error) || left()) throw error;
      began = /** @type {{ began?: unknown }} */ (error).began === true;
      waiting(error);
      await after(checkAfter(checks));
      if (left()) throw error;
    }
  }
}

/**
 * @param {unknown} error
 * @param {string} words
 * @param {string} [lead]
 * @returns {{ said: import('./reach.js').Said, words: string }}
 */
export const notSaved = (error, words, lead = 'Not saved') => {
  const said = actSaid(requestState(error));
  return said.said === 'refused' ? { said: 'refused', words: `${lead}: ${words}` } : said;
};

/** @returns {Promise<{ countries: { code: string, name: string, rings: number[][] }[] }>} */
export const fetchAtlas = () => /** @type {Promise<any>} */ (call('life/atlas'));
