// @ts-check
/**
 * @typedef {{ records: boolean, days: ReadonlySet<string>, imports: ReadonlySet<string>, deliveries: ReadonlySet<string>, extracts: ReadonlySet<string>, streams: boolean, people: boolean, peopleAt: string | null, peopleChanged: string | null, places: boolean, models: boolean, storage: boolean, reset: boolean, clock: boolean, clockMoved: boolean }} HomeChange
 * @typedef {{ event: string, data: { kind?: string, key?: string, position?: string, changed?: string } }} FeedMessage
 */

/** @param {string | null | undefined} position */
const seqOf = position => {
  const seq = Number.parseInt(String(position ?? '').split(':')[0] ?? '', 10);
  return Number.isSafeInteger(seq) ? seq : -1;
};

/**
 * @param {string | null | undefined} position
 * @param {string} wanted
 */
export const atOrPast = (position, wanted) => seqOf(position) >= seqOf(wanted);

/**
 * @param {string | null} changed
 * @param {string | null | undefined} position
 */
export const changedPast = (changed, position) => changed === null || position == null || !atOrPast(position, changed);

/**
 * @param {string | null} one
 * @param {string | null | undefined} other
 * @returns {string | null}
 */
export const newer = (one, other) => (other == null || (one !== null && seqOf(one) >= seqOf(other)) ? one : other);

const QUIET_MS = 400;
const LONGEST_MS = 2_000;
const AGAIN_MS = 3_000;

/**
 * @param {FeedMessage[]} messages
 * @returns {HomeChange}
 */
export function homeChange(messages) {
  /** @type {Set<string>} */
  const days = new Set();
  /** @type {Set<string>} */
  const imports = new Set();
  /** @type {Set<string>} */
  const deliveries = new Set();
  /** @type {Set<string>} */
  const extracts = new Set();
  let reset = false;
  let streams = false;
  let people = false;
  /** @type {string | null} */
  let peopleAt = null;
  /** @type {string | null} */
  let peopleChanged = null;
  let unsaid = false;
  let places = false;
  let models = false;
  let storage = false;
  for (const message of messages) {
    const kind = message.data.kind ?? '';
    if (message.event !== 'reset' && (kind === 'import' || kind === 'erase' || kind === 'stored')) storage = true;
    if (kind.startsWith('device-') || kind.startsWith('source-') || kind === 'pass-revoked' || kind === 'settings') streams = true;
    if (message.event === 'reset' || message.event === 'reopen') reset = true;
    else if (message.data.kind === 'people') {
      people = true;
      peopleAt = newer(peopleAt, message.data.position);
      if (message.data.changed === undefined) unsaid = true;
      else peopleChanged = newer(peopleChanged, message.data.changed);
    }
    else if (message.data.kind === 'places') places = true;
    else if (message.data.kind === 'models') models = true;
    else if (message.data.kind === 'day' && message.data.key) days.add(message.data.key);
    else if (message.data.kind === 'import' && message.data.key) {
      imports.add(message.data.key.split('/')[0]);
      deliveries.add(message.data.key);
    }
    else if (message.data.kind === 'extract' && message.data.key) extracts.add(message.data.key);
  }
  return { records: messages.length > 0, days, imports, deliveries, extracts, streams, people, peopleAt,
    peopleChanged: unsaid ? null : peopleChanged, places, models, storage, reset, clock: false, clockMoved: false };
}

/** @type {Set<(change: HomeChange) => void>} */
const listeners = new Set();
/** @type {EventSource | null} */
let source = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let timer;
/** @type {FeedMessage[]} */
let burst = [];
let began = 0;
let tried = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let again;

/** @param {HomeChange} change */
const tell = change => {
  for (const listener of listeners) listener(change);
};

function tellBurst() {
  timer = undefined;
  const change = homeChange(burst);
  burst = [];
  tell(change);
}

/** @param {boolean} moved */
export const clockChanged = moved => tell({ ...homeChange([]), clock: true, clockMoved: moved });

/** @param {FeedMessage} message */
function hear(message) {
  if (!burst.length) began = Date.now();
  burst.push(message);
  clearTimeout(timer);
  timer = setTimeout(tellBurst, Math.max(0, Math.min(QUIET_MS, began + LONGEST_MS - Date.now())));
}

function open() {
  const opened = new EventSource('api/feed');
  opened.addEventListener('open', () => {
    if (tried) hear({ event: 'reopen', data: {} });
    tried = true;
  });
  opened.addEventListener('error', () => {
    tried = true;
    if (opened.readyState !== EventSource.CLOSED || source !== opened) return;
    clearTimeout(again);
    again = setTimeout(() => {
      if (source === opened) source = open();
    }, AGAIN_MS);
  });
  opened.addEventListener('message', event => hear({ event: 'message', data: JSON.parse(/** @type {MessageEvent<string>} */ (event).data) }));
  opened.addEventListener('reset', event => hear({ event: 'reset', data: JSON.parse(/** @type {MessageEvent<string>} */ (event).data) }));
  return opened;
}

/**
 * @param {HomeChange} one
 * @param {HomeChange} other
 * @returns {HomeChange}
 */
const joined = (one, other) => ({
  records: one.records || other.records, days: new Set([...one.days, ...other.days]),
  imports: new Set([...one.imports, ...other.imports]), deliveries: new Set([...one.deliveries, ...other.deliveries]),
  extracts: new Set([...one.extracts, ...other.extracts]),
  streams: one.streams || other.streams, people: one.people || other.people, peopleAt: newer(one.peopleAt, other.peopleAt),
  peopleChanged: !one.people ? other.peopleChanged : !other.people ? one.peopleChanged
    : one.peopleChanged === null || other.peopleChanged === null ? null : newer(one.peopleChanged, other.peopleChanged),
  places: one.places || other.places,
  models: one.models || other.models,
  storage: one.storage || other.storage,
  reset: one.reset || other.reset,
  clock: one.clock || other.clock,
  clockMoved: one.clockMoved || other.clockMoved,
});

/**
 * @template T
 * @param {HTMLElement | undefined} seen
 * @param {(value: T) => void} listener
 * @param {(one: T, other: T) => T} join
 * @returns {{ hear: (value: T) => void, stop: () => void }}
 */
export function whileShown(seen, listener, join) {
  let has = false;
  /** @type {T} */
  let held;
  const tell = () => {
    if (!has || seen?.hidden) return;
    has = false;
    listener(held);
  };
  const shown = new MutationObserver(() => {
    if (has && !seen?.hidden) requestAnimationFrame(() => setTimeout(tell));
  });
  if (seen) shown.observe(seen, { attributes: true, attributeFilter: ['hidden'] });
  return {
    hear: value => {
      if (!seen?.hidden) return listener(value);
      held = has ? join(held, value) : value;
      has = true;
    },
    stop: () => shown.disconnect(),
  };
}

/**
 * @param {(change: HomeChange) => void} listener
 * @param {HTMLElement} [seen]
 * @returns {() => void}
 */
export function onHomeChange(listener, seen) {
  const { hear: hearing, stop } = whileShown(seen, listener, joined);
  listeners.add(hearing);
  source ??= open();
  return () => {
    stop();
    listeners.delete(hearing);
    if (listeners.size > 0) return;
    source?.close();
    source = null;
    tried = false;
    clearTimeout(timer);
    clearTimeout(again);
    burst = [];
  };
}
