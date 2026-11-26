// @ts-check
/** @import { DetailKind, NamedLevel, OutboundList, OutboundOne, OutboundTotal, PrivacyRead } from '../../types.js' */
/** @import { HostAct, PrivacyWrite } from '../../lib/host.js' */
/** @import { DetailPart, End, Opened, PanelRow } from './dialog.js' */
/** @import { Act, Do } from './words.js' */
/** @import { Picked } from './settings-search.js' */
import { hiderWords, hidWords } from '../../lib/sent.js';
import { today } from '../../lib/home-clock.js';
import { calendarDate, clock, count, counted, dayDate, relativeDay } from '../../lib/words.js';
import { rowOf } from './dialog.js';
import { homeSettingKey, keyOf } from './pending.js';
import { part } from './settings-pages.js';

/** @typedef {'none' | 'known'} Choice */

/** @type {{ id: Choice, title: string, line: string }[]} */
export const CHOICES = [
  { id: 'none', title: 'Don’t hide', line: 'What a model reads is sent as it is.' },
  { id: 'known', title: 'Hide what Lifestream knows',
    line: 'Numbers, addresses, links, passwords and the names in People are replaced before anything leaves. A hiding model, chosen in AI models, also finds names Lifestream has never seen.' },
];

export const CHOSEN_BY_DEFAULT = /** @type {Choice} */ ('known');

export const EXAMPLE = {
  before: 'Ada Example asked you to call +1 555 000 0142 about order 4410 0193.',
  after: '[[Person 1]] asked you to call [[Phone 1]] about order [[Number 1]].',
};

export const LIMITS = [
  'Hiding removes who and which number, never what was said.',
  'It finds most details, not all.',
  'Unknown names in languages other than English are often missed.',
  'Text a picture’s reader cannot read stays in the picture.',
  'Made stricter in the middle of a chat, a name the model already wrote can stay readable in that chat.',
  'What left Lifestream lists what Lifestream sent itself. The maps and the place names on your devices ask outside services themselves, and are not in it.',
];

const LEVELS = /** @type {const} */ ([
  ['all', 'Hide all', 'Names, numbers and faces are replaced. The model still reads what was said.'],
  ['names', 'Keep names', 'Numbers and faces are replaced; names are sent as they are. The model still reads what was said.'],
  ['none', 'Don’t hide', 'Everything is sent as it is.'],
]);

const LINKS = /** @type {const} */ ([
  ['tokens', 'Hide sign-in parts and codes', 'A link keeps its site and its path.'],
  ['path', 'Hide everything after the site', 'A link keeps its site alone.'],
  ['none', 'Don’t hide', 'A link leaves as it is.'],
]);

const WHAT = { ask: 'A model’s question', read: 'A read', text: 'Chat’s words', link: 'A link opened', lookup: 'A lookup' };
const VOICE_NOTE = 'A voice note in Chat';

export const OUTBOUND_DAYS = 14;

/** @param {HostAct} act @returns {Do} */
const asking = act => ({ host: act });

/** @param {string} words */
const switchWords = words => words.charAt(0).toUpperCase() + words.slice(1);

/**
 * @param {Pick<PrivacyRead, 'level' | 'detector'>} privacy
 * @returns {Choice}
 */
export const choiceOf = privacy => privacy.level === 'none' ? 'none' : 'known';

/**
 * @param {Choice} choice
 * @returns {HostAct}
 */
export const choiceAct = choice => ({ act: 'home-setting', settings: { 'privacy.level': choice === 'none' ? 'none' : 'all' } });

export const CHOICE_BUSY = /** @type {string} */ (keyOf(choiceAct('known')));

/** @param {number} bytes */
const megabytes = bytes => count(Math.round(bytes / 1_000_000));

const MODEL_LINE = 'Finds names Lifestream has never seen, English first.';

/**
 * @param {PrivacyRead} privacy
 * @returns {{ label: string, share: number, words: string } | null}
 */
export function modelProgress({ detector, marking }) {
  if (detector.state === 'downloading' && detector.total) {
    return { label: 'Hiding model downloading', share: (detector.bytes ?? 0) / detector.total,
      words: `${megabytes(detector.bytes ?? 0)} of ${megabytes(detector.total)} MB` };
  }
  if (!detector.model || !marking) return null;
  return { label: 'Marked so far', share: marking.total ? marking.marked / marking.total : 1, words: marking.line };
}

/**
 * @param {PrivacyRead} privacy
 * @param {{ acts: boolean, model: Picked | null, choose: Do }} reach
 * @returns {PanelRow}
 */
export function modelRow(privacy, { acts, model, choose }) {
  const { detector } = privacy;
  const chosen = Boolean(detector.model);
  const absent = chosen && detector.state === 'absent';
  const words = model?.words ?? (!chosen ? 'Off' : detector.state === 'ready' ? 'Downloaded' : detector.state === 'downloading' ? 'Downloading' : '');
  return rowOf('Hiding model', { line: absent ? detector.line ?? privacy.line ?? MODEL_LINE : model?.line ?? MODEL_LINE,
    signal: absent ? 'caution' : null, progress: modelProgress(privacy),
    end: { words, done: chosen && detector.state === 'ready', acts: acts ? [{ label: chosen ? 'Change' : 'Choose', variant: 'secondary', do: choose }] : [] } });
}

/**
 * @param {'privacy.chat' | 'privacy.links'} key
 * @param {string} label
 * @param {readonly (readonly [string, string, string])[]} steps
 * @param {string} value
 * @param {string} byDefault
 * @param {boolean} acts
 * @returns {End}
 */
function settingMenu(key, label, steps, value, byDefault, acts) {
  const words = steps.find(([step]) => step === value)?.[1] ?? value;
  if (!acts) return { words };
  return { menu: { id: `settings.${key}`, busy: homeSettingKey(key), label, words, find: '', date: null,
    choices: steps.map(([step, said, note]) => ({ words: said, note, chosen: step === value, default: step === byDefault,
      do: asking({ act: 'home-setting', settings: /** @type {PrivacyWrite} */ ({ [key]: step === byDefault ? null : step }) }) })) } };
}

const LISTS = /** @type {const} */ ({
  'privacy.always': { title: 'Always hide', line: 'Words hidden wherever they appear, as listed words.' },
  'privacy.never': { title: 'Never hide', line: 'A detail whose whole text is one of these words leaves as it is.' },
});


/**
 * @param {PrivacyRead} privacy
 * @param {boolean} acts
 * @returns {End}
 */
function choiceMenu(privacy, acts) {
  const chosen = choiceOf(privacy);
  const words = CHOICES.find(choice => choice.id === chosen)?.title ?? '';
  if (!acts) return { words };
  return { menu: { id: 'settings.privacy-choice', busy: CHOICE_BUSY, label: 'Hide personal details', words,
    find: '', date: null, choices: CHOICES.map(choice => ({ words: choice.title, note: choice.line, chosen: choice.id === chosen,
      default: choice.id === CHOSEN_BY_DEFAULT, do: asking(choiceAct(choice.id)) })) } };
}

/**
 * @param {'privacy.always' | 'privacy.never'} key
 * @param {string[]} words
 */
const listRow = (key, words) => rowOf(LISTS[key].title, { line: words.length ? counted(words.length, 'word') : 'None',
  end: { acts: [{ label: 'Edit', variant: 'secondary', do: { page: `list:${key}` } }] } });

/**
 * @param {PrivacyRead} privacy
 * @param {boolean} acts
 */
function chatRow(privacy, acts) {
  const leaves = privacy.voice?.leaves ?? null;
  const caution = leaves !== null && (privacy.levels[privacy.chat] ?? []).length > 0;
  return rowOf('Chat', { line: caution ? voiceCaution(leaves) : 'What Chat hides when it asks a cloud model.',
    mark: caution ? { status: 'disk' } : null, end: settingMenu('privacy.chat', 'Chat', LEVELS, privacy.chat, privacy.level, acts) });
}

/** @param {string} provider */
export const voiceCaution = provider => `Voice notes go to ${provider} as they are: sound can’t be hidden.`;

/**
 * @param {PrivacyRead} privacy
 * @param {{ acts: boolean, model: Picked | null, choose: Do }} reach
 * @returns {DetailPart[]}
 */
function hideParts(privacy, reach) {
  const { acts } = reach;
  return [
    part({ rows: [
      rowOf('Hide personal details', { line: 'Before anything goes to a cloud model, names and numbers become placeholders like '
        + '[[Person 3]]. The model still reads what was said.', end: choiceMenu(privacy, acts) }),
      modelRow(privacy, reach),
      chatRow(privacy, acts),
      rowOf('Links', { end: settingMenu('privacy.links', 'Links', LINKS, privacy.links, 'tokens', acts) }),
      listRow('privacy.always', privacy.always),
      listRow('privacy.never', privacy.never),
    ] }),
    { label: 'What hiding can’t do', lines: [], panel: null, acts: [], list: LIMITS },
  ];
}

/**
 * @param {'privacy.always' | 'privacy.never'} key
 * @param {PrivacyRead} privacy
 * @param {Opened} opened
 * @param {boolean} acts
 * @returns {DetailPart}
 */
export function listPage(key, privacy, opened, acts) {
  const words = key === 'privacy.always' ? privacy.always : privacy.never;
  const set = (/** @type {string[]} */ next) => asking({ act: 'home-setting', settings: /** @type {PrivacyWrite} */ ({ [key]: next.length ? next : null }) });
  const typed = opened.typed.trim();
  const taken = words.some(word => word.toLowerCase() === typed.toLowerCase());
  return part({ label: LISTS[key].title, line: LISTS[key].line,
    rows: words.map(word => rowOf(word, { end: acts ? { acts: [{ label: 'Remove', variant: 'plain', do: set(words.filter(each => each !== word)) }] } : null })),
    add: acts ? { placeholder: 'Add a word', typed: opened.typed, finds: [], lit: 0,
      enter: typed && !taken && !/\n/u.test(typed) ? set([...words, typed]) : null, end: null } : null,
    note: words.length || acts ? '' : 'No words.' });
}

/** @param {OutboundTotal[]} totals */
const dayLine = totals => [totals.map(total => `${total.receiver} ${counted(total.items, 'item')}`).join(', '),
  `${count(totals.reduce((sum, total) => sum + total.hidden, 0))} details hidden`].join(' · ');

const OUTSIDE = 'The maps and the place names on your devices ask outside services themselves, and are not listed here.';

/**
 * @param {string} day
 * @param {string} [receiver]
 */
export const outboundPageOf = (day, receiver = '') => `outbound:${day}:${receiver}`;

/** @param {string} page */
export function outboundAt(page) {
  const rest = page.slice('outbound:'.length);
  const at = rest.indexOf(':');
  return at < 0 ? { day: rest, receiver: '' } : { day: rest.slice(0, at), receiver: rest.slice(at + 1) };
}

/**
 * @param {string} page
 * @returns {End}
 */
const view = page => ({ acts: [{ label: 'View', variant: 'plain', do: { page } }] });

/**
 * @param {PrivacyRead} privacy
 * @param {OutboundList | null} days
 * @param {string} today
 * @returns {DetailPart[]}
 */
function outboundParts(privacy, days, today) {
  const year = Number(today.slice(0, 4));
  const todays = privacy.today.filter(total => total.day === today);
  const before = new Map();
  for (const total of days?.totals ?? []) {
    if (total.day === today) continue;
    before.set(total.day, [...before.get(total.day) ?? [], total]);
  }
  const named = (/** @type {string} */ day) => relativeDay(day, today) || dayDate(day, { year });
  return [
    part({ label: 'What left Lifestream today', line: todays.length ? '' : 'Nothing left Lifestream today.',
      rows: todays.map(total => rowOf(total.receiver, { line: `${counted(total.items, 'item')} · ${count(total.hidden)} details hidden`,
        end: view(outboundPageOf(today, total.receiver)) })),
      note: todays.length ? OUTSIDE : '' }),
    part({ label: 'Earlier', line: days === null ? 'Reading…' : before.size ? '' : `Nothing left Lifestream in the ${OUTBOUND_DAYS - 1} days before today.`,
      rows: [...before].sort(([a], [b]) => b.localeCompare(a)).map(([day, totals]) => rowOf(named(day), { line: dayLine(totals),
        end: view(outboundPageOf(day)) })) }),
  ];
}

/**
 * @param {string} page
 * @param {OutboundList | null} list
 * @param {boolean} failed
 * @param {DetailKind[]} types
 * @returns {{ title: string, parts: DetailPart[], reading: boolean }}
 */
export function outboundPage(page, list, failed, types) {
  const { day, receiver } = outboundAt(page);
  const title = receiver || dayDate(day, { year: Number(today().slice(0, 4)) });
  if (!list) return { title, parts: [], reading: !failed };
  const rows = list.rows.map(row => {
    const read = row.about === 'chat-voice' ? VOICE_NOTE : row.what === 'read' && row.tool ? `${WHAT.read}: ${row.tool}` : WHAT[row.what];
    const line = [receiver ? '' : row.receiver, hidWords(row, types),
      row.chars ? `${counted(row.chars, 'character')}` : '', row.pictures ? counted(row.pictures, 'picture') : ''].filter(Boolean).join(' · ');
    return rowOf(`${clock(row.at_ms)} · ${read}`, { line,
      go: row.what === 'ask' ? { do: { page: `sent:${row.seq}` }, value: '' } : null });
  });
  return { title, reading: false, parts: [part({ line: list.rows.length ? '' : 'Nothing left Lifestream that day.', rows,
    note: list.more ? `The newest ${count(list.rows.length)} are shown.` : '' })] };
}

/**
 * @param {OutboundOne | null} row
 * @param {boolean} failed
 * @param {DetailKind[]} types
 * @returns {{ parts: DetailPart[], reading: boolean }}
 */
export function sentPage(row, failed, types) {
  if (!row) return { parts: [], reading: !failed };
  const year = Number(today().slice(0, 4));
  const hider = hiderWords(row);
  const facts = part({ rows: [
    rowOf('To', { end: { words: row.receiver } }),
    rowOf('When', { end: { words: `${dayDate(calendarDate(row.at_ms), { weekday: false, year })}, ${clock(row.at_ms)}` } }),
    rowOf('Hidden', { line: hidWords(row, types) }),
    ...hider ? [rowOf('Hidden by', { end: { words: hider } })] : [],
    ...row.pictures ? [rowOf('Pictures', { line: `${counted(row.pictures, 'picture')} went with it, made as the level says.` })] : [],
  ] });
  const body = row.sent ? readable(row.sent.body) : '';
  return { reading: false, parts: [facts, row.sent ? { label: 'What was sent', panel: null, acts: [], lines: [], text: body }
    : { label: 'What was sent', panel: null, acts: [], lines: ['What was sent is no longer kept: an erasure took its request.'] }] };
}

/** @param {string} body */
function readable(body) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/**
 * @param {{ privacy: PrivacyRead | null, failed: boolean, days: OutboundList | null, acts: boolean,
 *   model: Picked | null, choose: Do, today: string }} read
 * @returns {{ parts: DetailPart[], reading: boolean }}
 */
export function privacyParts({ privacy, failed, days, acts, model, choose, today }) {
  if (!privacy) return { parts: [], reading: !failed };
  return { parts: [...hideParts(privacy, { acts, model, choose }), ...outboundParts(privacy, days, today)], reading: false };
}


