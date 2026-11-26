// @ts-check
/** @import { DeviceRow, OutboundList, OutboundOne, PrivacyRead, StreamsReport } from '../../types.js' */
/** @import { ModelUse, Pages } from '../../pages.js' */
/** @import { Models } from '../../lib/model-menu.js' */
/** @import { Picked } from './settings-search.js' */
/** @import { SettingsEntry } from '../../settings-index.js' */
/** @import { Storage } from './settings-storage.js' */
/** @import { Flow } from '../flows/model.js' */
/** @import { HostAct, HostState } from '../../lib/host.js' */
/** @import { Detail, DetailPart, Opened } from './dialog.js' */
/** @import { Do } from './words.js' */
/** @import { Reach } from './settings-pages.js' */
/** @import { ScreenState } from './settings-search.js' */
import { rowOf } from './dialog.js';
import { lacks } from '../../lib/reach.js';
import { LACKS, NOT_HERE } from './changes.js';
import { today } from '../../lib/home-clock.js';
import { addressAct, addressPage, defaultsParts, keyAct, MODEL_FIELDS, morePage, providersParts, useOf } from './settings-models.js';
import { listPage, outboundPage, privacyParts, sentPage } from './settings-privacy.js';
import { meaningParts } from './settings-search.js';
import { storageTerms, WORDS as STORAGE_WORDS } from './settings-storage.js';
import { answerParts, WORDS as ANSWER_WORDS } from './settings-answer.js';
import { SETTINGS_INDEX } from '../../settings-index.js';
import {
  appearanceParts, chromeParts, homeParts, macsOf, part, phoneParts,
  recoveryRows, storageParts, thisMacParts, updatesParts,
} from './settings-pages.js';

export const SETTINGS = 'settings';

export const SETTINGS_DEFAULTS = `${SETTINGS}/defaults`;

export const SETTINGS_PROVIDERS = `${SETTINGS}/providers`;

export const SETTINGS_HOME = `${SETTINGS}/home`;
export const SETTINGS_MAC = `${SETTINGS}/mac`;
export const SETTINGS_IPHONE = `${SETTINGS}/iphone`;
export const SETTINGS_CHROME = `${SETTINGS}/chrome`;

export const SETTINGS_PRIVACY = `${SETTINGS}/privacy`;

export const SETTINGS_MEANING = `${SETTINGS}/meaning`;

/** @param {string} id */
export const isSettings = id => id === SETTINGS || id.startsWith(`${SETTINGS}/`);

export const ENTRIES = SETTINGS_INDEX.mac.flatMap(group => group.entries);

/** @param {string} id */
const entryOf = id => ENTRIES.find(each => each.id === id) ?? null;

export const ANSWERED = ENTRIES.filter(each => each.answer === 'settingsPage').map(each => each.id);

/**
 * @param {string} id
 * @returns {{ page: string, row: string } | null}
 */
export function settingsAt(id) {
  if (!isSettings(id)) return null;
  const [, page = 'home', ...row] = id.split('/');
  return entryOf(page) ? { page, row: row.join('/') } : null;
}

/**
 * @param {string} id
 * @returns {string[]}
 */
export function pagesAt(id) {
  const at = settingsAt(id);
  return at?.page === 'privacy' && /^sent:[1-9]\d*$/u.test(at.row) ? [at.row] : [];
}

/** @param {string} id */
export const shownPage = id => settingsAt(id)?.page ?? '';

export const TYPED = { ...MODEL_FIELDS, name: 'mac.name' };

const NAME_CHARS = 64;

export const SETTINGS_FIND = 'settings.find';

export const OUTBOUND_LACKS = { unread: 'What left Lifestream couldn’t be read.', notHere: 'What left Lifestream isn’t on this Mac yet.' };

/** @typedef {{ drawn: import('../../lib/reach.js').Drawn, notHere: string, unread: string, reread: 'models' | 'privacy' | 'screen' | 'outbound' | 'storage' | 'settings' }} ReadFailed */

/**
 * @param {import('../../lib/reach.js').Drawn | null} drawn
 * @param {ReadFailed['reread']} reread
 * @param {{ notHere: string, unread: string }} words
 * @returns {ReadFailed | null}
 */
const failedRead = (drawn, reread, words) => drawn ? { drawn, reread, ...words } : null;

/** @param {import('../../lib/reach.js').Drawn | null} drawn */
const ownFailure = drawn => drawn?.kind === 'lack';

export const NOTES = {
  browser: 'Change these in the Lifestream app on your Mac.',
  elsewhere: 'Change these on the Mac that holds Lifestream.',
};

/**
 * @param {Opened} opened
 * @param {string} key
 */
const typed = (opened, key) => opened.fields?.[key];

/**
 * @param {Opened} opened
 * @param {StreamsReport | null} report
 */
function renamed(opened, report) {
  const inside = opened.pages.at(-1) ?? '';
  return inside.startsWith('rename:') ? macsOf(report).find(mac => mac.unit === inside.slice('rename:'.length)) ?? null : null;
}

/**
 * @param {Opened} opened
 * @param {DeviceRow} mac
 */
const nameTyped = (opened, mac) => typed(opened, TYPED.name) ?? mac.name;

/**
 * @param {'openrouter' | 'address' | 'name'} form
 * @param {Opened} opened
 * @param {StreamsReport | null} [report]
 * @returns {HostAct | null}
 */
export function savedAct(form, opened, report = null) {
  if (form === 'openrouter') return keyAct(opened);
  if (form === 'address') return addressAct(opened);
  const mac = renamed(opened, report);
  const name = mac ? nameTyped(opened, mac).trim() : '';
  return mac && name && name !== mac.name ? { act: 'device-name', unit: mac.unit, name } : null;
}

/**
 * @param {Opened} opened
 * @param {DeviceRow} mac
 * @param {StreamsReport | null} report
 * @param {boolean} own
 * @returns {DetailPart}
 */
const renamePage = (opened, mac, report, own) => part({ rows: [rowOf('Name', {
  line: `How ${own ? 'this Mac' : 'it'} appears in Lifestream and on your other devices.`,
  end: { field: { key: TYPED.name, label: 'Name', kind: 'text', value: nameTyped(opened, mac), placeholder: mac.name, max: NAME_CHARS },
    acts: [{ label: 'Save', variant: 'primary', disabled: savedAct('name', opened, report) === null, do: { save: 'name' } }] } })] });

/**
 * @param {string} inside
 * @param {Reach} reach
 * @param {PrivacyReads} privacy
 * @returns {{ title: string, parts: DetailPart[], reading: boolean, failed?: ReadFailed | null } | null}
 */
function privacyInside(inside, reach, privacy) {
  if (inside === 'list:privacy.always' || inside === 'list:privacy.never') {
    return privacy.read ? { title: '', parts: [listPage(inside.slice('list:'.length) === 'privacy.always' ? 'privacy.always' : 'privacy.never',
      privacy.read, reach.opened, reach.home)], reading: false } : { title: '', parts: [], reading: true };
  }
  const types = privacy.read?.types ?? [];
  const known = privacy.read !== null;
  const failed = known ? failedRead(privacy.outbound, 'outbound', OUTBOUND_LACKS)
    : failedRead(privacy.drawn, 'privacy', { notHere: NOT_HERE.privacy, unread: LACKS.privacy });
  const own = ownFailure(failed?.drawn ?? null);
  if (inside.startsWith('outbound:')) return { ...outboundPage(inside, known ? privacy.page : null, own, types), failed };
  if (inside.startsWith('sent:')) return { title: 'What was sent', ...sentPage(known ? privacy.row : null, own, types), failed };
  return null;
}

/**
 * @param {Pages['settings'] | null} live
 * @param {string} id
 */
const valueOf = (live, id) => live?.values.find(each => each.id === id) ?? null;

/**
 * @param {string} page
 * @param {Pages['settings'] | null} live
 * @param {HostState | null} state
 */
function dotted(page, live, state) {
  if (page === 'updates') return Boolean(state?.update || state?.general?.update);
  if (page === 'mac') return Boolean(state?.grants.some(grant => !grant.granted && !grant.optional));
  return Boolean(valueOf(live, page)?.signal);
}

/**
 * @param {SettingsEntry} entry
 * @param {Pages['settings'] | null} live
 */
const nameOf = (entry, live) => valueOf(live, entry.id)?.label ?? entry.label;

/** @typedef {{ read: PrivacyRead | null, drawn: import('../../lib/reach.js').Drawn | null, days: OutboundList | null, page: OutboundList | null, row: OutboundOne | null, outbound: import('../../lib/reach.js').Drawn | null }} PrivacyReads */

/** @typedef {{ read: ScreenState | null, drawn: import('../../lib/reach.js').Drawn | null }} ScreenReads */

/** @type {ScreenReads} */
export const NO_SCREEN = { read: null, drawn: null };

/** @type {PrivacyReads} */
export const NO_PRIVACY = { read: null, drawn: null, days: null, page: null, row: null, outbound: null };

/** @typedef {{ read: Storage | null, drawn: import('../../lib/reach.js').Drawn | null, more?: boolean }} StorageReads */

/** @type {StorageReads} */
export const NO_STORAGE = { read: null, drawn: null };

/** @typedef {{ read: Pages['settingsPage'] | null, drawn: import('../../lib/reach.js').Drawn | null }} PageRead */

/** @typedef {{ live: Pages['settings'] | null, pages: Readonly<Record<string, PageRead | undefined>> }} SettingsReads */

/** @type {SettingsReads} */
export const NO_SETTINGS = { live: null, pages: {} };

const settingsFailed = () => ({ notHere: ANSWER_WORDS.notHere, unread: ANSWER_WORDS.unread });

/**
 * @param {Reach} reach
 * @param {StorageReads} storage
 * @returns {{ parts: DetailPart[], reading: boolean, storage: Detail['storage'], failed: ReadFailed | null }}
 */
function storagePage(reach, { read, drawn, more = false }) {
  return { parts: storageParts(reach, read?.keep ?? null), reading: !read && !ownFailure(drawn),
    storage: read ? { answer: read, more } : null,
    failed: failedRead(drawn, 'storage', { notHere: STORAGE_WORDS.notHere, unread: STORAGE_WORDS.failed }) };
}

/**
 * @param {PageRead | undefined} held
 * @param {boolean} home
 * @returns {{ parts: DetailPart[], reading: boolean, failed: ReadFailed | null }}
 */
const answeredPage = (held, home) => ({ parts: held?.read ? answerParts(held.read, home) : [],
  reading: !held?.read && !ownFailure(held?.drawn ?? null), failed: failedRead(held?.drawn ?? null, 'settings', settingsFailed()) });

/**
 * @param {Models | null} models
 * @param {ModelUse['use']} use
 * @returns {Picked | null}
 */
const pickedOf = (models, use) => {
  const picked = models && useOf(models, use);
  return picked ? { words: picked.words, line: picked.line, chosen: picked.value !== null } : null;
};

/** @type {Do} */
const CHOOSE = { open: SETTINGS_DEFAULTS };

/**
 * @param {string} page
 * @param {Reach} reach
 * @param {{ models: Models | null, failed: import('../../lib/reach.js').Drawn | null, subscriptions: Flow | null,
 *   privacy: PrivacyReads, screen: ScreenReads, storage: StorageReads, answers: SettingsReads }} read
 * @returns {{ parts: DetailPart[], reading: boolean, storage?: Detail['storage'], failed?: ReadFailed | null }}
 */
function partsOf(page, reach, { models, failed, subscriptions, privacy, screen, storage, answers }) {
  const { report, state, home, answering } = reach;
  const awaiting = { parts: [], reading: true };
  const answer = entryOf(page)?.answer;
  if (answer === 'settingsPage') return answeredPage(answers.pages[page], home);
  const modelsFailed = failedRead(failed, 'models', { notHere: NOT_HERE.models, unread: LACKS.models });
  if (answer === 'modelDefaults') return { ...defaultsParts({ models, failed: ownFailure(failed), acts: home }), failed: modelsFailed };
  if (answer === 'modelProviders') {
    return { ...providersParts({ models, failed: ownFailure(failed), subscriptions, acts: home, opened: reach.opened }), failed: modelsFailed };
  }
  switch (page) {
    case 'home': return report || !answering ? { parts: homeParts(reach), reading: false } : awaiting;
    case 'storage': return storagePage(reach, storage);
    case 'recovery': return { parts: state ? [part({ rows: recoveryRows(state) })] : [], reading: state?.vault === null };
    case 'mac': return report || state ? { parts: thisMacParts(reach), reading: !report } : awaiting;
    case 'iphone': return report ? { parts: phoneParts(reach), reading: false } : awaiting;
    case 'chrome': return report ? { parts: chromeParts(reach), reading: false } : awaiting;
    case 'appearance': return { parts: appearanceParts(reach), reading: false };
    case 'updates': return { parts: state ? updatesParts(state) : [], reading: false };
    case 'privacy': return { ...privacyParts({ privacy: privacy.read, failed: ownFailure(privacy.drawn), days: privacy.days,
      acts: home, model: pickedOf(models, 'hiding'), choose: CHOOSE, today: today() }),
    failed: failedRead(privacy.drawn, 'privacy', { notHere: NOT_HERE.privacy, unread: LACKS.privacy }) };
    case 'meaning': return { ...meaningParts({ state: screen.read, failed: ownFailure(screen.drawn), acts: home,
      model: pickedOf(models, 'search'), choose: CHOOSE }),
    failed: failedRead(screen.drawn, 'screen', { notHere: NOT_HERE.screen, unread: LACKS.screen }) };
    default: return { parts: [], reading: false };
  }
}

const ON_HOME = new Set(['home', 'iphone', 'chrome', 'defaults', 'providers', 'privacy', 'meaning', 'advanced']);

/**
 * @param {string} name
 * @param {DetailPart[]} parts
 */
const termsOf = (name, parts) => [name, ...parts.flatMap(each => [each.label, ...each.panel?.rows.map(row => row.label) ?? []])];

/**
 * @param {{ report: StreamsReport | null, models: Models | null, failed?: import('../../lib/reach.js').Drawn | null, state: HostState | null, id: string, opened: Opened, subscriptions: Flow | null, theme?: 'system' | 'light' | 'dark', query?: string, unread?: boolean, privacy?: PrivacyReads, screen?: ScreenReads, storage?: StorageReads, answers?: SettingsReads }} read
 * @returns {Detail | null}
 */
export function settingsDetail({ report, models, failed = null, state, id, opened, subscriptions, theme = 'system', query = '',
  unread = false, privacy = NO_PRIVACY, screen = NO_SCREEN, storage = NO_STORAGE, answers = NO_SETTINGS }) {
  const at = settingsAt(id);
  const page = at && entryOf(at.page);
  if (!at || !page || (page.host && !state)) return null;
  const answering = !unread && !lacks(state?.reach);
  const holds = state !== null && state.folder !== null;
  /** @type {Reach} */
  const reach = { report, state, opened, theme, answering, home: state !== null && report !== null && answering && holds };
  const read = { models, failed, subscriptions, privacy, screen, storage, answers };
  const { live } = answers;
  const words = query.trim().toLocaleLowerCase();
  const finds = (/** @type {SettingsEntry} */ each) => !words || [...termsOf(nameOf(each, live), partsOf(each.id, reach, read).parts),
    ...each.answer === 'storage' && storage.read ? storageTerms(storage.read) : []].some(term => term.toLocaleLowerCase().includes(words));
  const nav = { label: 'Settings', query, groups: SETTINGS_INDEX.mac.map(group => ({ label: group.label, items: group.entries
    .filter(each => !each.host || state)
    .filter(finds)
    .map(each => ({ id: each.id, label: nameOf(each, live), icon: each.icon, on: each.id === page.id,
      dot: dotted(each.id, live, state), do: /** @type {Do} */ ({ open: `${SETTINGS}/${each.id}` }) })) }))
    .filter(group => group.items.length) };
  const note = !ON_HOME.has(page.id) ? '' : !state ? NOTES.browser : !answering ? '' : !holds ? NOTES.elsewhere : '';
  const name = nameOf(page, live);
  /** @type {Detail} */
  const base = { id, icon: page.icon, name, line: '', state: null, callout: null, figure: null, parts: [], panels: [], back: null,
    foot: null, confirm: null, reading: false, ticking: false, nav, note, at: at.row };
  const inside = opened.pages.at(-1);
  const server = page.id === 'providers' && inside === 'address' && reach.home ? addressPage(models, opened) : null;
  if (server) return { ...base, back: { label: name }, parts: [server] };
  const more = page.id === 'defaults' ? morePage(models, opened, reach.home) : null;
  if (more) return { ...base, back: { label: name }, name: more.title, parts: more.parts };
  const mac = page.id === 'mac' && reach.home ? renamed(opened, report) : null;
  if (mac) return { ...base, back: { label: name }, parts: [renamePage(opened, mac, report, mac.unit === state?.unit)] };
  const inPrivacy = page.id === 'privacy' && inside ? privacyInside(inside, reach, privacy) : null;
  if (inPrivacy) {
    return { ...base, back: { label: name }, name: inPrivacy.title || name, parts: inPrivacy.parts, reading: inPrivacy.reading,
      readFailed: failedOf(inPrivacy.failed ?? null, inPrivacy.reading, state) };
  }
  const { failed: own = null, ...drawn } = partsOf(page.id, reach, read);
  return { ...base, ...drawn, reading: drawn.reading && answering, readFailed: failedOf(own, drawn.reading, state, page.id) };
}

/**
 * @param {ReadFailed | null} failed
 * @param {boolean} reading
 * @param {HostState | null} state
 * @param {string} [page]
 * @returns {(ReadFailed & { lacking: boolean }) | null}
 */
function failedOf(failed, reading, state, page = '') {
  const lacking = lacks(state?.reach);
  if (failed) return { ...failed, lacking };
  const own = READS[page] ?? (entryOf(page)?.answer === 'settingsPage' ? { reread: /** @type {const} */ ('settings'), ...settingsFailed() } : undefined);
  return own && reading && lacking ? { drawn: { kind: 'reach' }, ...own, lacking } : null;
}

/** @type {Record<string, Omit<ReadFailed, 'drawn'>>} */
const READS = {
  defaults: { reread: 'models', notHere: NOT_HERE.models, unread: LACKS.models },
  providers: { reread: 'models', notHere: NOT_HERE.models, unread: LACKS.models },
  privacy: { reread: 'privacy', notHere: NOT_HERE.privacy, unread: LACKS.privacy },
  meaning: { reread: 'screen', notHere: NOT_HERE.screen, unread: LACKS.screen },
  storage: { reread: 'storage', notHere: STORAGE_WORDS.notHere, unread: STORAGE_WORDS.failed },
};
