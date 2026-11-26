// @ts-check
/** @import { ConnectorRowOptions } from './ui/kit/connector-row.js' */
/** @import { HostState } from './lib/host.js' */
/** @import { Filter } from './ui/connectors/page.js' */
import './kit-gallery-clock.js';
import { esc } from './lib/html.js';
import { DOOR_WORDS } from './lib/reach.js';
import { applyGeometry } from './ui/geometry.js';
import {
  DIDNT_PLAY, askAnswer, askHome, askLevel, askPick, askQuestion, askStarters, askSteps, askThread, askThreadReading, askTurn, composerAttach, avatar, bar, button, thoughtFor,
  connectorLine, connectorLineReading, connectorLines, chatList, chatListReading, chatRow, composer, connectorRow, connectorRowReading,
  inPlaceLine, figureStrip, figureStripReading, filterMenu, iconButton, iconSquare, inspectorReading, installAsk, installCardGrid,
  installFilterMenus, lines, monogram, pageHead, searchField, sectionLabel, sectionLabelReading, setIcons,
  shape, tabs, thread, threadReading, views, weekFigure, groupRow, groupRowReading, rowGroup, tilesRow,
  signal, signalShape, toggle, watchPictures, plain, status, qrCode,
  icon, action, connected, offer, offers, listRow, listRowReading, listRows, noneLine, menuButton, settingRow, settingsSection, settingTile, addRow, tip, callout, dialog, appIcon,
  choiceRows, accountMenu, statusStrip, homeStrip, attachmentChip, attachmentChips, toast,
  spotlight,
  dropZone, made, DESCRIBE, TRANSCRIBE, areaChart, diskBar, installAreaCharts, installLights, installWeekFigure, usageRow,
} from './ui/kit/index.js';
import { NOT_NOW as TOUR_NOT_NOW, WORDS as TOUR_WORDS } from './ui/tour.js';
import { removePage } from './ui/places/cameras.js';
import { PAGE, PLACES } from './ui/connectors/words.js';
import { pageOf } from './ui/connectors/page.js';
import { detailOf, OPENED } from './ui/connectors/dialog.js';
import { AT_REST, bodyMarkup, menusMarkup, sideMarkup } from './ui/connectors/view.js';
import { detailMarkup } from './ui/connectors/detail.js';
import { ENTRIES as SETTINGS_ENTRIES, NO_PRIVACY, SETTINGS_DEFAULTS, SETTINGS_PRIVACY, SETTINGS_PROVIDERS, settingsDetail } from './ui/connectors/settings.js';
import { SUBSCRIPTIONS } from './ui/connectors/settings-models.js';
import { flowOf, sessionOf } from './ui/flows/model.js';
import { BATTERY_SPENT, DESCRIBED, LLM_REPORT, MODELS, MODELS_BARE, ON_BATTERY, SHAPED, SUBSCRIBED, TRANSCRIBED } from './kit-gallery-llm.js';
import { PROOF_REPORT } from './kit-gallery-proof.js';
import { OUTBOUND_DAYS_READ, OUTBOUND_PAGE, PRIVACY, privacyLines, SENT, SENT_ERASED, SENT_MODEL, WAITING_REPORT } from './kit-gallery-privacy.js';
import { AT, HOST_STATE, REPORT } from './kit-gallery-report.js';
import { accessGallery, SIGNIN } from './kit-gallery-access.js';
import { noticeCard, signInCard } from './ui/agents/cards.js';
import { ASKED } from './ui/agents/words.js';
import { BACKUP_SCENES, BROUGHT, DONE, holding, IMPORTS_STATE, importsReport, SCENES, TAKEOUT } from './kit-gallery-imports.js';
import { sceneUrl } from './kit-gallery-scenes.js';
import { flows, PAIR_QR } from './kit-gallery-flows.js';
import { setupGallery } from './kit-gallery-setup.js';
import { searchChips } from './ui/search/filter-pills.js';
import { hitListReading, kindsList } from './ui/search/hit-list.js';
import { replyMarkdown } from './ui/markdown.js';
import { liveMoveAndScale, people } from './kit-gallery-people.js';
import { places as placePages } from './kit-gallery-places.js';
import { days } from './kit-gallery-days.js';
import { DRIVE_AWAY, reach, STATES as REACH_STATES } from './kit-gallery-reach.js';
import { video } from './kit-gallery-video.js';
import { daysSide, drawDaysSide } from './kit-gallery-days-side.js';
import { sizeRuns } from './ui/days/fold.js';
import { installSettings, settings, SETTINGS_ANSWERS, STORAGE_COUNTING, STORAGE_MAP, STORAGE_NEW, STORAGE_YEAR } from './kit-gallery-settings.js';
import { phraseOf } from './lib/words.js';

const ACTION_VERBS = ['Allow', 'Settings', 'Sign in', 'Open', 'Open page', 'Sign out', 'Save', 'Connect', 'Create', 'Retry',
  'New key', 'Set up', 'Try again', 'Continue', 'Close', 'Cancel it', 'Done', 'Pair it', 'Choose', 'Change', 'Edit',
  'Save as file', 'I’ve saved it'];
/** @param {{ id: string, mac?: boolean, update?: boolean, open?: boolean, you?: boolean, feedback?: boolean }} row */
const ACCOUNT = ({ id, mac = false, update = false, open = false, you = true, feedback = false }) => '<div class="gallery__account">'
  + accountMenu({ id, open, you: you ? { id: 'person-sam', name: 'Sam de Rivera', photo: '' } : null, shortcut: mac ? '⌘,' : '',
    update: update ? { line: 'Lifestream 2026.10.28 is ready', act: { id: 'do', label: 'Restart to Update' } } : null,
    feedback: feedback ? 'Send feedback…' : null })
  + '</div>';
const NAV_ROWS = [['chat', 'Chat', false, 0], ['days', 'Timeline', true, 0], ['people', 'People', false, 0],
  ['streams', 'Connectors', false, 2]].map(([name, words, on, needs]) => `<button type="button" class="ck-navrow${on ? ' is-on' : ''}">${icon(String(name))}`
    + `<span class="ck-navrow__words">${esc(String(words))}</span>`
    + (needs ? `<span class="ck-count ck-count--need">${esc(String(needs))}</span>` : '') + '</button>').join('');
const ACTION_RESULTS = ['Allowed', 'Signed in', 'Saved', 'Kept', 'Added', 'Connected', 'Paired'];
/** @param {string} className */
const FIT = className => `<div class="${className}">` + [
  ...ACTION_VERBS.map(verb => action(verb, { attrs: { 'data-fit': verb, style: 'max-width: var(--size-action-mac)' } })),
  ...ACTION_RESULTS.map(words => connected(words, { attrs: { 'data-fit': words, style: 'max-width: var(--size-action-mac)' } })),
].join(' ') + '</div>';
setIcons(await (await fetch('/icons.json')).json());

const TODAY = '2026-10-15';
const WEEK = [980, 1102, 864, 0, 1310, 1188, 1204];
const HISTORY_WEEKS = [140, 182, 96, 0, 210, 168, 152, 120, 174, 260, 148, 136, 0, 92, 188, 176, 140, 158];
const HISTORY_YEARS = /** @type {[string, number][]} */ ([['2020', 3104], ['2021', 7420], ['2022', 5210], ['2023', 1630], ['2024', 0], ['2025', 610], ['2026', 108]]);
/** @param {string} id */
const open = id => ({ 'data-open': id });
const ONLINE = [{ icon: 'online', word: 'Online' }];

/** @type {Partial<Record<import('./types.js').State, ConnectorRowOptions>>} */
const ROWS = Object.fromEntries(REPORT.connectors.filter(each => each.health.state !== 'setup').reverse()
  .map(each => [each.health.state, { name: each.name, icon: each.icon, places: each.roads.includes('poll') ? ONLINE : [],
    state: each.health.state, area: each.type?.name, line: each.line, lead: each.lead ?? undefined,
    attrs: open(each.id) }]));
const STATES = /** @type {import('./types.js').State[]} */ (['ok', 'syncing', 'quiet', 'waiting', 'paused', 'off',
  'needs-you', 'broken']);
const SETUP = /** @type {import('./types.js').ConnectorReport} */ (REPORT.connectors.find(each => !each.set_up));

const NEEDS = /** @type {import('./ui/kit/status-strip.js').Strip[]} */ ([
  { weight: 'advice', title: 'Type your WHOOP password', actions: [{ label: 'Set', attrs: {} }], close: { label: 'Dismiss', attrs: {} } },
  { weight: 'stopped', title: 'Couldn’t sync GitHub', line: 'GitHub refused the token', meta: 'tries again at 14:30',
    actions: [{ label: 'Try now', attrs: {} }] },
  { weight: 'advice', title: 'Another Claude account', line: 'person-b@example.com in Chrome',
    actions: [{ label: 'Not this one', attrs: {} }, { label: 'Read it too', attrs: {} }], close: { label: 'Dismiss', attrs: {} } },
  { weight: 'stopped', title: 'Couldn’t bring in YouTube', line: 'From your Google Takeout', actions: [{ label: 'Skip it', attrs: {} }] },
]);
const TRY = REPORT.connectors.find(each => each.health.state === 'broken')?.health.acts[0]?.label ?? '';

const WHY = { label: 'Why isn’t it yours?', choices: [
  { value: 'stopped', title: 'I stopped using it' },
  { value: 'never', title: 'It was never mine' },
] };

/** @type {import('./ui/places/cameras.js').Removal} */
const REMOVAL = { camera: 'synthetic-make/own-camera', why: 'stopped', when: 'last', stopped: '', first: '2019-05-01',
  last: '2026-09-27' };

/** @type {import('./lib/where.js').Camera} */
const GALLERY_CAMERA = { camera: 'synthetic-make/own-camera', name: 'Synthetic Make Own Camera', make: 'Synthetic Make', model: 'Own Camera', photos: 1204,
  first_ms: Date.UTC(2019, 4, 1, 12), last_ms: Date.UTC(2026, 8, 27, 12), sample: null, phones: [], word: null, mine: true,
  why: 'count', rule: 'count' };

/**
 * @param {string} label
 * @param {string} html
 * @param {string} [className]
 */
const specimen = (label, html, className = '') => `<div class="gallery__specimen${className ? ` ${className}` : ''}">`
  + `<p class="gallery__label mac-mono-label">${esc(label)}</p>${html}</div>`;

/**
 * @param {string} label
 * @param {string} html
 */
const reading = (label, html) => specimen(label, html, 'ck-reading');

const asked = new URLSearchParams(location.hash.slice(1)).getAll('group');
/** @param {...string} prefixes */
const wants = (...prefixes) => !asked.length || asked.some(words => prefixes.some(prefix => prefix.startsWith(words) || words.startsWith(prefix)));

/**
 * @param {string} name
 * @param {string | (() => string)} body
 */
const group = (name, body) => wants(name) ? `<section class="gallery__group">${sectionLabel(name)}${typeof body === 'function' ? body() : body}</section>` : '';

/**
 * @param {HostState | null} state
 * @param {Filter} filter
 * @param {{ read?: boolean, failed?: string, from?: import('./types.js').StreamsReport, adding?: boolean, alerts?: { open: boolean, copied: string } }} [more]
 */
function page(state, filter, { read = true, failed = '', from = REPORT, adding = false, alerts = { open: false, copied: '' } } = {}) {
  const report = read ? from : null;
  const shown = pageOf(report, state, filter, { unanswered: failed !== '', adding });
  const head = '<header class="ck-page__bar">' + pageHead({ title: PAGE.title, tools: [
    `<div class="cn-menus">${menusMarkup(shown, filter)}</div>`,
    searchField({ placeholder: PAGE.search, shortcut: state ? '⌘F' : '/', outlined: true, value: filter.query, waiting: !read }),
  ] }) + '</header>';
  return `<div class="gallery__page ck-page${!read && !failed ? ' ck-reading' : ''}">${head}<div class="ck-page__scroll">`
    + `<div class="ck-page__body"><div class="ck-page__main"><div class="cn-body">${bodyMarkup(shown, AT_REST, '', failed, { alerts })}</div></div>`
    + `<aside class="ck-page__side ck-page__side--top cn-side">${sideMarkup(shown)}</aside></div></div></div>`;
}

/**
 * @param {string} label
 * @param {string} shot
 * @param {string} html
 * @param {number} [height]
 */
const connectorsWindow = (label, shot, html, height = 900) => specimen(label,
  `<div class="gallery__window gallery__connectors" data-shot="${esc(shot)}" data-geo="width:1226px;height:${height}px">${html}</div>`);

/**
 * @param {string} id
 * @param {'stopped' | 'advice'} weight
 * @param {string} words
 * @param {string} line
 * @param {import('./types.js').Act[]} [acts]
 * @param {Partial<Omit<import('./types.js').Need, 'streams'>>} [more]
 * @returns {import('./types.js').Need}
 */
const alertNeed = (id, weight, words, line, acts = [], more = {}) => ({ id, state: weight === 'stopped' ? 'broken' : 'needs-you', reason: null,
  words, line, since_ms: AT - 3_600_000, next_ms: null, acts, detail: null, connector: null, streams: null, copy: null, unit: null, at: null, weight,
  banner: false, dismissed: false, kind: 'notice', about: null, ...more });
const ALERTS = [
  alertNeed('room:macbook-air-bb17', 'stopped', 'MacBook Air’s disk is full', 'It stopped recording · free space on it', [],
    { unit: 'macbook-air-bb17' }),
  alertNeed('disk', 'advice', 'Lifestream’s disk fills in about 4 days', '18 GB left on Drive A', [{ do: 'storage', label: 'Free up space' }]),
  alertNeed('vault:unsaved', 'advice', 'Recovery key not saved', 'Without it, a lost Mac loses your passwords', [{ do: 'vault', label: 'Save key' }]),
  alertNeed('rest:macbook-pro-0001', 'advice', 'This Mac’s disk isn’t encrypted', 'Turn on FileVault',
    [{ do: 'open', label: 'Open Settings', url: 'x-apple.systempreferences:com.apple.preference.security' }]),
  alertNeed('loose:home', 'advice', 'Other accounts can open Lifestream’s folder', 'Run the fix in Terminal',
    [{ do: 'copy', label: 'Copy fix', text: 'chmod 700 "/Volumes/Drive A/lifestream"' }]),
];
const ALERT_STATE = { ...HOST_STATE, needs: [] };
/** @param {import('./types.js').Need[]} needs */
const alerting = needs => ({ ...REPORT, needs });
const DISK_FULL = { tone: /** @type {const} */ ('warning'), title: 'Lifestream’s disk is full', line: 'Nothing new is saved', meta: 'since 12:55',
  act: { label: 'Free up space', attrs: {} } };
/**
 * @param {string} label
 * @param {string} shot
 * @param {string} strip
 * @param {string} [body]
 */
const bannerWindow = (label, shot, strip, body = page(HOST_STATE, filter({}))) => specimen(label,
  `<div class="gallery__window gallery__connectors gallery__bannered" data-shot="${esc(shot)}" data-geo="width:1226px;height:520px">`
  + `<div class="home-strip">${strip}</div>${body}</div>`);

/** @type {import('./types.js').StreamsReport} */
/** @type {Record<string, string>} */
const WHERE = { granola: 'Granola’s servers, from your Mac, every 5 minutes. Nothing leaves your Mac but the request.',
  whatsapp: 'What WhatsApp keeps on your Mac. Nothing leaves it.' };

/** @type {Record<string, string>} */
const STEP_LINES = { 'granola:sign-in': 'Opens Granola in your browser.' };

/** @type {import('./types.js').StreamsReport} */
const NEW_HOME = { ...REPORT, needs: [], paused: [],
  home: { ...REPORT.home, health: { ...REPORT.home.health, state: 'ok', words: 'Nothing yet' } },
  devices: REPORT.devices.filter(device => device.unit === HOST_STATE.unit),
  imports: REPORT.imports.map(kind => ({ ...kind, held: [], coming: [], health: { ...kind.health, state: 'setup', acts: [] } })),
  connectors: REPORT.connectors.map(connector => ({ ...connector, set_up: false, pauses: [], where: WHERE[connector.id] ?? null,
    ways: connector.ways.map(way => ({ ...way, requirements: way.requirements.map(each => ({ ...each,
      line: each.met ? null : STEP_LINES[`${connector.id}:${each.kind}`] ?? null })) })),
    health: { ...connector.health, state: 'setup', acts: [] }, copies: connector.copies.map(copy => ({ ...copy, newest_ms: null })) })) };

/**
 * @param {HostState | null} state
 * @param {{ id: string }[]} opened
 */
const dialogs = (state, opened) => '<div class="gallery__dialogs">' + opened.map(({ id }) => {
  const detail = detailOf(REPORT, state, id, OPENED);
  return detail ? `<div class="gallery__dialog">${detailMarkup(detail, AT_REST)}</div>` : '';
}).join('') + '</div>';

/** @type {import('./types.js').StreamsReport} */
const READING_HISTORY = { ...REPORT, connectors: REPORT.connectors.map(connector => connector.id !== 'whatsapp' ? connector : { ...connector,
  line: 'Reading your history · 3%', figure: connector.figure && { ...connector.figure, last: '09:41' },
  copies: connector.copies.map((copy, at) => ({ ...copy, held: at === 0 ? 12_400 : 0 })),
  history: { state: 'syncing', back_to_ms: null, left: 399_600, unit: ['message', 'messages'], eta_ms: AT + 25 * 60_000,
    done: 12_400, total: 412_000, progress: '12,400 of about 412,000',
    words: 'Newest first: today is in already · about 25 min left', arriving: 'Reading your history', start: { day: null, own: false } } }) };

/**
 * @param {HostState | null} state
 * @param {{ ids?: string[], report?: import('./types.js').StreamsReport }} [which]
 */
function everyDialog(state, { ids, report = REPORT } = {}) {
  return '<div class="gallery__dialogs">' + report.connectors.filter(each => !ids || ids.includes(each.id)).flatMap((connector, at) => {
    const detail = detailOf(report, state, connector.id, OPENED);
    if (!detail) return [];
    const figure = detail.figure && at === 0 ? { ...detail.figure, lit: 1 } : detail.figure;
    return [`<div class="gallery__dialog" data-dialog="${esc(connector.id)}">${detailMarkup({ ...detail, figure }, AT_REST)}</div>`];
  }).join('') + '</div>';
}

/**
 * @param {string} label
 * @param {string} shot
 * @param {import('./ui/connectors/dialog.js').Detail | null} detail
 * @param {string} [asking]
 * @param {number} [height]
 */
const dialogWindow = (label, shot, detail, asking = '', height = 760) => specimen(label, `<div class="gallery__window gallery__dialogwin" data-shot="${esc(shot)}" `
  + `data-geo="width:760px;height:${height}px">${detail ? detailMarkup(detail, { ...AT_REST, asking }) : ''}</div>`);

/**
 * @param {HostState | null} state
 * @param {{ id: string, pages?: string[], typed?: string, asking?: string }[]} opened
 * @param {import('./types.js').StreamsReport} [report]
 */
const streamDialogs = (state, opened, report = REPORT) => '<div class="gallery__dialogs">'
  + opened.map(({ id, pages = [], typed = '', asking = '' }) => {
    const detail = detailOf(report, state, id, { pages, typed, lit: 0, kept: new Set() });
    return detail ? `<div class="gallery__dialog">${detailMarkup(detail, { ...AT_REST, asking })}</div>` : '';
  }).join('') + '</div>';

/** @param {string[]} rows */
const section = rows => settingsSection({ rows });

/**
 * @param {string[]} words
 * @param {number} chosen
 * @param {number} fallback
 * @param {string[]} [notes]
 */
const choices = (words, chosen, fallback, notes = []) => words.map((said, at) => ({ value: String(at), words: said,
  note: notes[at] ?? '', chosen: at === chosen, default: at === fallback }));
const EVERY = choices(['Every 5 minutes', 'Every 15 minutes', 'Every 30 minutes', 'Every hour', 'Every 6 hours', 'Daily'], 2, 2);
const OCR = choices(['Changed frames only', 'Every frame'], 0, 0, ['Skips a frame identical to the last', 'Uses more power']);

const MORNING_MS = Date.parse(`${TODAY}T07:40:00Z`);
const NO_FOCUS = { focus: null };
/** @type {import('./pages.js').Search} */
const KINDS = {
  position: '1:0', today: TODAY, held: { first: '2024-03-01', last: TODAY }, total: { n: 64, partial: true }, reading: null,
  nothing: null,
  top: [{ kind: 'person', ref: 'person:synthetic:a', name: 'Person A', line: '1,204\u00a0messages', picture: null,
    opens: { page: 'people', id: 'phone:+15550000001', person: 'person:person-a', group: null } },
  { kind: 'hit', ref: 'record:synthetic:mail:1', family: 'mail', title: 'Synthetic subject one',
    line: 'Person C · «Synthetic» subject one, sent this morning', when: { kind: 'at', at_ms: MORNING_MS + 92 * 60_000 }, picture: null,
    opens: { page: 'days', day: TODAY, ...NO_FOCUS } }],
  kinds: [
    { family: 'listening', title: 'Listening', count: { n: 41, partial: false }, upcoming: null, see: true, unread: null, rows: [
      { kind: 'track', ref: 'row:synthetic:1', title: 'Synthetic Song', artist: 'Artist P', line: '31\u00a0plays · Artist P' },
      { kind: 'track', ref: 'row:synthetic:2', title: 'Synthetic Song (Live)', artist: 'Artist P', line: '10\u00a0plays · Artist P' }] },
    { family: 'messages', title: 'Messages', count: { n: 18, partial: true }, upcoming: null, see: true, unread: null, rows: [
      { kind: 'hit', ref: 'record:synthetic:message:3', family: 'messages', title: 'Person B', line: 'You: see you at «Synthetic» Home',
        when: { kind: 'at', at_ms: MORNING_MS + 22 * 60_000 }, picture: null, opens: { page: 'days', day: TODAY, ...NO_FOCUS } }] },
    { family: 'screen', title: 'Mac', count: { n: 5, partial: false }, upcoming: null, see: true, unread: null, rows: [
      { kind: 'sitting', key: 'u:screen:local:macbook-pro-0001/1793595600000', title: 'Planned the week',
        line: '1\u00a0window · Example Notes · «Synthetic» plan', said: null, when: { kind: 'at', at_ms: MORNING_MS },
        windows: [{ ref: 'window:synthetic:1', app: 'Example Notes', title: 'Week plan', line: 'Example Notes · «Synthetic» plan',
          when: null, opens: null }], windows_line: '1\u00a0window',
        opens: { page: 'days', day: TODAY, focus: 'u:screen:local:macbook-pro-0001/1793595600000' } }] },
    { family: 'mail', title: 'Mail', count: { n: 1, partial: false }, upcoming: null, see: false, unread: null, rows: [] },
  ],
};
const CHIPS_WAITING = searchChips({ answer: null, family: '', time: '', held: null, today: TODAY });

/** @param {number[]} counts */
const places = counts => PLACES.map((place, at) => ({ value: place.key, label: place.word, icon: place.icon,
  count: counts[at] }));
const MESSAGES = /** @type {[string, string]} */ (['message', 'messages']);

/** @param {Partial<Filter>} more */
const filter = more => ({ query: '', place: /** @type {''} */ (''), ...more });

/** @type {Map<number, string>} */
const scenes = new Map();
/** @param {number} seed */
const sceneOf = seed => scenes.get(seed) ?? /** @type {string} */ (scenes.set(seed, sceneUrl(seed)).get(seed));
/** @param {string} markup */
const drawn = markup => markup.replace(/\/api\/life\/picture\?hash=(?:sha256%3A)?(face|photo|scene)-(\d+)&amp;size=\w+/gu,
  (_, kind, n) => kind === 'face' ? `/kit-gallery.faces.svg#svgView(viewBox(${Number(n) * 160},0,160,160))`
    : kind === 'photo' ? `/kit-gallery.photos.svg#svgView(viewBox(${(Number(n) % 7) * 400},0,400,300))` : sceneOf(Number(n)))
  .replace(/\/api\/life\/picture\?hash=lost&amp;size=\w+/gu, '/no-such-photo.png');

/** @type {Record<string, import('./ui/kit/ask.js').AskRef>} */
const REFS = {
  r1: { day: '2026-10-16', title: 'Chat with Person A' },
  r2: { day: '2026-10-16', title: 'Synthetic Cafe' },
  r3: { day: '2026-10-12', title: 'Mail: Synthetic booking confirmed' },
  r4: { day: '2026-10-16', title: 'Photo at Synthetic Cafe', image: 'photo-1' },
  ...Object.fromEntries([5, 6, 7, 8, 9, 10, 11].map((n, at) => [`r${n}`, { day: '2026-10-03', title: `Photo ${at + 1} of the walk`,
    image: `photo-${n}` }])),
  r12: { day: '2026-10-03', title: 'Photo at Synthetic Lake', image: 'photo-12' },
  r13: { day: '2026-10-03', title: 'Photo on the ridge', image: 'photo-13' },
  r14: { day: '2026-10-03', title: 'Photo at the hut', image: 'photo-14' },
  r15: { day: '2026-10-03', title: 'Photo not in the home', image: 'lost' },
  r16: { day: '2026-10-16', title: 'Person A', block: 'whatsapp:15550000001' },
  r17: { day: '2026-10-16', title: 'Person A', block: 'whatsapp:15550000001' },
  r18: { day: '2026-11-04', title: 'Person A', voice: { record: 'record.1', audio: `sha256:${'1'.repeat(64)}`, seconds: 23,
    caption: 'Person A · Wed 4 Nov, 21:40', mine: false, failed: DIDNT_PLAY } },
  r19: { day: '2026-11-04', title: 'Person A', voice: { record: 'record.2', audio: `sha256:${'2'.repeat(64)}`, seconds: null,
    caption: 'You · Wed 4 Nov, 21:42', mine: true, failed: DIDNT_PLAY } },
  r20: { day: '2026-11-04', title: 'Person A', voice: { record: 'record.3', audio: `sha256:${'3'.repeat(64)}`, seconds: 23,
    caption: 'Person A · Wed 4 Nov, 21:40', mine: false, failed: DIDNT_PLAY } },
  r21: { day: '2026-11-04', title: 'Person A', voice: { record: 'record.4', audio: '', seconds: null, caption: '', mine: false, failed: DIDNT_PLAY,
    erased: true } },
};
/** @param {string} handle */
const cite = handle => ({ 'data-ask-cite': handle });
const DRAW = { markdown: replyMarkdown, cite, year: '2026' };

const ANSWER = 'You had dinner at Synthetic Cafe with Person A on **Friday 16 October**, from about 19:40 to 22:10 [r1][r2]. '
  + 'The table was booked on Monday [r3].\n\nWhat came up:\n\n- The trip in November, which Person A is planning [r1]\n'
  + '- A photo of the two of you at the table [r4]\n\nThe booking’s page is [on the cafe’s site](https://example.com/booking).';
const TABLE = 'Your three longest nights this week:\n\n| Night | Asleep | In bed |\n|---|---|---|\n| Mon 12 Oct | 8 h 10 m | 8 h 52 m |\n'
  + '| Thu 15 Oct | 7 h 48 m | 8 h 20 m |\n| Sat 17 Oct | 7 h 31 m | 8 h 05 m |\n\nEach is from the health stream [r1].';
const STEPS = [
  { words: 'Searched messages for “dinner”' },
  { words: 'Read the chat with Person A, 16 Oct' },
  { words: 'Checked where you were, Fri 16 Oct 19:00–23:00' },
  { words: 'Searched mail for “booking”' },
  { words: 'Looked at 1 photo', ms: 4_020 },
];
const FAILED_STEPS = [{ words: 'Searched messages for “ridge”' }, { words: 'Couldn’t open example.com', failed: true },
  { words: 'Read Sat 3 Oct' }];

const LIST = chatList([
  { label: 'Today', rows: [chatRow({ title: 'Dinner with Person A on Friday' }),
    chatRow({ title: 'Who did I see most this month', running: true })] },
  { label: 'Yesterday', rows: [chatRow({ title: 'Sleep this week' }), chatRow({ title: 'When the booking was made' })] },
  { label: 'Previous 7 days', rows: [chatRow({ title: 'Walks along the synthetic ridge' }),
    chatRow({ title: 'What Person B said about the move, and everything that followed from it' })] },
  { label: 'September', rows: [chatRow({ title: 'The visa guide' })] },
]);

const MANY_SOURCES = 'For your May trip you paid **₹1,18,496** across four reservations [r1, r2, r3, r12]. '
  + 'The first was on Monday [r2, r3].\n\nThe photos are from the ridge [r13] [r14].';

const PICTURE = { alt: 'Hills at sunset', src: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 180">'
  + '<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f0b27a"/><stop offset="1" stop-color="#c76b6b"/></linearGradient></defs>'
  + '<rect width="240" height="180" fill="url(#s)"/><circle cx="170" cy="92" r="20" fill="#fbe3b0"/>'
  + '<path d="M0 140 L60 90 L100 120 L150 70 L240 130 V180 H0Z" fill="#5a4560"/><path d="M0 160 L80 130 L150 150 L240 135 V180 H0Z" fill="#3e3048"/></svg>')}` };
const LEVELS = Array.from({ length: 44 }, (_, at) => 0.2 + 0.8 * Math.abs(Math.sin(at * 0.45 + 5)) * (0.45 + 0.55 * ((at * 37) % 11) / 10));
const COVERED = { ...PICTURE, src: PICTURE.src.replace(encodeURIComponent('</svg>'),
  encodeURIComponent('<circle cx="170" cy="92" r="24" fill="#8a6f86"/><rect x="24" y="22" width="92" height="18" rx="2" fill="#000"/></svg>')) };
/** @type {import('./ui/kit/seen.js').AskSeen} */
const SEEN = {
  asked: [{ start: 18, end: 22, placeholder: '[[Person 1]]' }, { start: 28, end: 28, added: '\n[Photo 1: taken 3 Nov 2026 14:02 at ' },
    { start: 28, end: 28, placeholder: '[[Place 1]]' }, { start: 28, end: 28, added: ']' }],
  answered: [{ start: 7, end: 16, placeholder: '[[Person 1]]' }, { start: 54, end: 63, placeholder: '[[Person 2]]' }],
};
const SEEN_ANSWER = 'That\'s Maya Iyer on the left, and the one behind is **Dev Kumar** [r4].';
/**
 * @param {boolean} model
 * @param {string} [cover]
 */
const seenTurn = (model, cover = COVERED.src) => askThread([askTurn({ model,
  question: askQuestion('Who\'s with me and Maya here?', { at: 'Tue 3 Nov · 14:05', seen: SEEN.asked, model,
    pictures: [{ ...PICTURE, seen: cover }] }),
  steps: askSteps({ said: thoughtFor(6_400), steps: STEPS.slice(4) }),
  answer: askAnswer({ text: SEEN_ANSWER, refs: REFS, seen: SEEN.answered, model }, DRAW) })]);
const SEEN_VOICE = askThread([askTurn({ model: true,
  question: askQuestion('', { seen: [{ start: 0, end: 0, added: '[A voice note, written out:]\n\n' },
    { start: 5, end: 9, placeholder: '[[Person 1]]' }], voice: { seconds: 4, levels: LEVELS.slice(0, 20), words: 'Call Maya tomorrow' } }),
  answer: askAnswer({ text: 'I can’t call for you.', refs: {}, seen: [], model: true }, DRAW) })]);
const SEEN_MAIL = askThread([askTurn({ model: true, question: askQuestion('Who wrote last?'),
  answer: askAnswer({ text: 'Maya Iyer <person-a@example.com> wrote last, about the trip [r4] and the tickets [r40].', refs: REFS,
    seen: [{ start: 0, end: 9, placeholder: '[[Person 1]]' }, { start: 11, end: 31, placeholder: '[[Email 1]]' }], model: true }, DRAW) })]);
const STARTERS = [{ kind: 'places', question: 'Where have I been today?' }, { kind: 'walking', question: 'How far did I walk today?' },
  { kind: 'photos', question: 'What did I photograph this week?' }];
const pickRow = (/** @type {string} */ value, /** @type {string} */ name, account = /** @type {string | null} */ (null)) => ({ value, name, account, chosen: value === 'claude/opus' });
const PICK_MENU = { default: null, rows: [pickRow('claude/opus', 'Opus 5.5'), pickRow('codex/sol', 'GPT-6.2 Sol'), pickRow('openrouter/gemini', 'Gemini 3.8 Flash')],
  local: { label: 'Local', rows: [pickRow('runner/qwen', 'Qwen 3.5 9B')] }, more: { words: 'More', use: /** @type {const} */ ('chat'), work: null }, off: null };
const LEVEL_CHOICES = ['low', 'medium', 'high', 'xhigh'].map(value => ({ value, label: { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high' }[value] ?? value }));
/** @type {import('./pages.js').ModelsFind} */
const FOUND_QWEN = { position: '1:0', today: '2026-10-28', placeholder: 'Search', none: null, groups: [
  { label: 'OpenRouter', rows: [pickRow('openrouter/qwen-max', 'Qwen4 Max'), pickRow('openrouter/qwen-vl', 'Qwen 3 VL')] },
  { label: 'Local', rows: [pickRow('runner/qwen', 'Qwen 3.5 9B')] }] };
const PICK_FIND = { placeholder: 'Search', found: /** @type {import('./pages.js').ModelGroup[]} */ ([]), none: '' };
const PICK_FOUND = { ...PICK_FIND, found: [{ label: 'Claude', rows: [pickRow('claude/opus', 'Opus 5.5')] },
  { label: 'OpenRouter', rows: [pickRow('openrouter/opus', 'Opus 5.5'), pickRow('openrouter/qwen-max', 'Qwen4 Max')] }, { label: 'Local', rows: [pickRow('runner/qwen-27b', 'Qwen 3.5 27B')] }] };
/** @param {{ active?: number, page?: 'models' | 'voice' | 'other', voice?: Parameters<typeof askPick>[0]['voice'], find?: Parameters<typeof askPick>[0]['find'] }} [open] */
const pick = (open = {}) => askPick({ model: 'Opus 5.5', level: 'Medium', levels: LEVEL_CHOICES, thinking: 'medium', menu: PICK_MENU,
  chosen: 'claude/opus', reset: true, find: PICK_FIND, ...open });

const THREAD = askThread([
  askTurn({ stamp: 'Sat 17 Oct 09:12', question: askQuestion('When did I last have dinner with Person A?', { at: 'Sat 17 Oct · 09:12', edit: {} }),
    steps: askSteps({ said: thoughtFor(9_200), steps: STEPS }),
    answer: askAnswer({ text: ANSWER, refs: REFS, open: 'r2' }, DRAW) }),
  askTurn({ stamp: 'Today 08:29', question: askQuestion('And my sleep after it?', { edit: {} }),
    steps: askSteps({ said: 'Reading Sat 17 Oct', working: true, steps: STEPS.slice(0, 1) }),
    answer: askAnswer({ text: 'On Friday night you slept', refs: null, paced: true }, DRAW) }),
]);

/** @param {string} body @param {{ bar?: string, tall?: boolean }} [frame] */
const askFrame = (body, { bar = '', tall = false } = {}) => `<div class="gallery__page gallery__ask${tall ? ' gallery__ask--tall' : ''}">`
  + `<header class="gallery__ask-bar">${bar}</header><div class="gallery__ask-main">${body}</div></div>`;
const THREAD_BAR = pageHead({ lead: '<h1 class="ak-bar__title">Dinner with Person A on Friday</h1>',
  tools: [iconButton('compose', 'New conversation', { attrs: { title: 'New conversation ⌘N' } })] });
const UNREACHABLE = inPlaceLine(DOOR_WORDS.ASK_DOWN, { retry: {}, shape: 'caution' });
const SIGN_IN = inPlaceLine('Chat needs your Claude sign-in on your Mac.', { retry: {}, label: 'Sign in with Claude…', shape: 'caution' });
/** @param {{ waiting?: boolean }} [level] */
const chips = ({ waiting = false } = {}) => pick() + askLevel({ level: 'all', waiting });
/** @param {Parameters<typeof composer>[0]} [given] */
const card = (given = {}) => composer({ pick: chips({ waiting: given.state === 'running' }), ...given });
/** @param {Parameters<typeof composer>[0]} [given] */
const full = (given = {}) => composer({ attach: composerAttach(), pick: chips(), mic: {}, ...given });
const RECORDING = { seconds: 7, levels: Array.from({ length: 120 }, (_, at) => LEVELS[at % LEVELS.length]), stop: {} };

const ask = () => !wants('Chat', 'Composer', 'Question', 'Starters', 'Steps line', 'Answer', 'Conversations', 'Thread') ? '' : [
  group('Chat · the page in the Mac window', specimen('Blank: the heading over the composer (the conversations are the clock’s drawer)',
    askFrame(askHome({ composer: card() })))
    + specimen('A home with no conversations yet: the home’s three starters under the composer',
      askFrame(askHome({ composer: card(), starters: askStarters(STARTERS) })))
    + specimen('A thread: a time over each new question, a cited answer with its picture and its source open, then a follow-up, running',
      askFrame(`<div class="gallery__ask-scroll">${THREAD}</div><div class="gallery__ask-foot">${card({ state: 'running' })}</div>`,
        { bar: THREAD_BAR, tall: true }))
    + specimen('Chat can’t be reached: the heading, one line, the composer quiet', askFrame(askHome({
      notice: UNREACHABLE, composer: card({ state: 'waiting' }) })))
    + specimen('No ChatGPT sign-in', askFrame(askHome({ notice: SIGN_IN, composer: card({ state: 'waiting' }) })))),
  group('Composer', '<div class="gallery__ask-col">' + [
    specimen('Empty: the circle dim, the pick chip and the level chip in its tools', card()),
    specimen('Words typed, and focused: Send', card({ value: 'Who did I see most this month?', attrs: { 'data-gallery-focus': '' } })),
    specimen('Grown with its words', card({ value: 'Read everything from the trip in September and tell me:\n'
      + '- where we stayed each night\n- who joined for which part\n- what it cost in all' })),
    specimen('An answer runs: Stop, the level chip dimmed', card({ value: '', state: 'running' })),
    specimen('Chat can’t be asked', card({ state: 'waiting' })),
    specimen('Every tool (built, passed by no page until the home takes them): +, the chip, the mic', full()),
    specimen('A picture picked, waiting with the words', full({ value: 'Where did I take this?', pictures: [PICTURE] })),
    specimen('Recording a voice note: Stop, the waveform as it comes, its time, Send', full({ recording: RECORDING })),
    specimen('Photos going to the home: one uploading, one the home can’t read with its line, a HEIC drawn as its tile',
      full({ value: 'Where was this?', pictures: [{ ...PICTURE, state: 'uploading' }, { src: '', alt: 'Broken', kind: 'JPEG', state: 'failed' },
        { src: '', alt: 'A HEIC', kind: 'HEIC' }], said: 'Lifestream can’t read this picture.' })),
    specimen('Recording, its × to cancel', full({ recording: { ...RECORDING, cancel: {} } })),
  ].join('') + '</div>'),
  group('Composer · menus', '<div class="gallery__ask-col gallery__ask-menus">' + [
    specimen('The pick chip’s menu: Thinking, then Model ›', `<div class="gallery__ask-menu">${pick({ active: 2 })}</div>`),
    specimen('Model ›: each model its name, local ones under Local, then More', `<div class="gallery__ask-menu">${pick({ active: 12, page: 'models' })}</div>`),
    specimen('More: what was typed finds any model that fits Chat, under where each comes from', `<div class="gallery__ask-menu">${pick({ active: 12, page: 'other', find: PICK_FOUND })}</div>`),
    specimen('The level chip’s menu: Sensitive information, the three levels, the one kept checked',
      `<div class="gallery__ask-menu">${askLevel({ level: 'names', active: 2 })}</div>`),
    specimen('The + menu', `<div class="gallery__ask-menu">${composerAttach({ active: 0 })}</div>`),
    specimen('The + menu greyed: the model sees no photos', `<div class="gallery__ask-menu">${composerAttach({ active: 0,
      off: 'Synthetic Blind can\'t see photos.' })}</div>`),
    specimen('The pick chip’s menu with Voice, its caution mark while notes leave as they are', `<div class="gallery__ask-menu">${pick({ active: 2,
      voice: { words: 'Cloud voice · Sent as it is', caution: 'Voice notes go to a cloud as they are: sound can’t be hidden.',
        choices: [{ value: 'parakeet', words: 'Parakeet · this Mac', chosen: false }, { value: 'cloud', words: 'Cloud voice · Sent as it is', chosen: true }] } })}</div>`),
  ].join('') + '</div>'),
  group('Question', '<div class="gallery__ask-col">' + [
    specimen('Short: the softer bubble', `<div class="ck-ask-turn">${askQuestion('Where was I on Friday night?')}</div>`),
    specimen('Long, wrapping at 78 % of the column', `<div class="ck-ask-turn">${askQuestion('What did Person B and I decide about '
      + 'the move, and was there anything left open at the end of it that I said I would come back to?')}</div>`),
    specimen('Under the pointer: Edit', `<div class="ck-ask-turn gallery__hover">${askQuestion('And my sleep after it?', { edit: {} })}</div>`),
    specimen('A picture asked with it', `<div class="ck-ask-turn">${askQuestion('Where did I take this?', { picture: PICTURE })}</div>`),
    specimen('Three photos asked with it', `<div class="ck-ask-turn">${askQuestion('Which of these was first?',
      { pictures: [PICTURE, PICTURE, { src: '', alt: 'A HEIC', kind: 'HEIC' }] })}</div>`),
    specimen('A voice note, its words not written out yet', `<div class="ck-ask-turn">${askQuestion('', { voice: { seconds: 7, levels: LEVELS, words: null } })}</div>`),
    specimen('A voice note and its words', `<div class="ck-ask-turn">${askQuestion('', { voice: { seconds: 7, levels: LEVELS,
      words: 'How long was I at the gym yesterday, and was that longer than usual?' } })}</div>`),
  ].join('') + '</div>'),
  group('Starters', '<div class="gallery__ask-col">' + specimen('Under a blank page’s composer: icon and question, one line each',
    askStarters([...STARTERS, { kind: 'mail', question: 'What came in my mail this week?' }, { kind: 'unknown', question: 'A kind with no icon' }])) + '</div>'),
  group('Steps line', '<div class="gallery__ask-col">' + [
    specimen('Thinking, before a step: the words shimmer', askSteps({ said: 'Thinking', working: true, steps: [] })),
    specimen('A step under way: its start’s words', askSteps({ said: 'Searching messages for “visa guide”', working: true,
      steps: [{ words: 'Searching messages for “visa guide”' }] })),
    specimen('Answered: how long it thought before the first word', askSteps({ said: thoughtFor(9_200), steps: STEPS })),
    specimen('Opened: each step in its words, a step that failed', askSteps({ said: thoughtFor(64_800), steps: FAILED_STEPS, open: true })),
    specimen('No steps', askSteps({ said: thoughtFor(800), steps: [] })),
  ].join('') + '</div>'),
  group('Answer', '<div class="gallery__ask-col">' + [
    specimen('Streaming: its capsules quiet, a citation still being written unprinted, its pictures waiting',
      askAnswer({ text: ANSWER.slice(0, ANSWER.indexOf('[r3]') + 2), refs: null }, DRAW)),
    specimen('Done: capsules in the order cited, a list, a link, its photo under the list', askAnswer({ text: ANSWER, refs: REFS }, DRAW)),
    specimen('Past two sources at one place: the first two, then how many more; two stand as two',
      askAnswer({ text: MANY_SOURCES, refs: REFS }, DRAW)),
    specimen('Under the pointer: Copy', `<div class="gallery__hover">${askAnswer({ text: 'You slept 7 h 48 m on Thursday [r1].', refs: REFS }, DRAW)}</div>`),
    specimen('A chat on a day is one source, however many of its messages are cited', askAnswer({ text: 'Person A said so twice [r16, r17], and again that evening [r17].', refs: REFS }, DRAW)),
    specimen('A handle in code or an address stays as written', askAnswer({ text: 'Cited as `[r1]` in code, and in an [address](https://example.com/a[r2]b) [r3].\n\n```\nsee [r1]\n```', refs: REFS }, DRAW)),
    specimen('A table', askAnswer({ text: TABLE, refs: REFS }, DRAW)),
    specimen('Three pictures in a row', askAnswer({ text: 'Three photos from the ridge on Saturday 3 October [r12][r13][r14].',
      refs: REFS }, DRAW)),
    specimen('Seven in a grid, the sixth saying how many more', askAnswer({ text: 'Your walk on 3 October, in photos '
      + '[r5][r6][r7][r8][r9][r10][r11].', refs: REFS }, DRAW)),
    specimen('One the home cannot draw', askAnswer({ text: 'The last photo of the day is not in Lifestream [r15].', refs: REFS }, DRAW)),
    specimen('Voice notes cited: each its own bar under its paragraph, after its photo, never merged; the caption opens the thread',
      askAnswer({ text: 'Person A sent it on the 4th [r18], with the photo [r4], and you answered two minutes later [r19].', refs: REFS }, DRAW)),
    specimen('A voice note that didn’t play, still held: Try again', askAnswer({ text: 'Person A said so [r20].', refs: REFS },
      { ...DRAW, owner: 'answer:gallery' }).replace('class="ck-voice ck-voice-cite"', 'class="ck-voice ck-voice-cite" data-voice-state="failed"')),
    specimen('A voice note erased since the answer', askAnswer({ text: 'Person A said so [r21].', refs: REFS }, DRAW)),
    specimen('Stopped', askAnswer({ text: 'You walked along the ridge on Saturday 3 October and again on', refs: {}, stopped: true }, DRAW)),
    specimen('Failed: what failed, Try again', askAnswer({ text: '', refs: {}, failed: { sentence: 'ChatGPT didn’t answer.', retry: {} } }, DRAW)),
  ].join('') + '</div>'),
  group('Answer · what the model saw', '<div class="gallery__ask-col">' + [
    specimen('The eye beside Copy: press it and each hidden detail decrypts into what the model read', seenTurn(false),
      'gallery__seen'),
    specimen('Pressed: the placeholders, the photo line, the covered photo, the citation as written and its picture folded',
      seenTurn(true)),
    specimen('A voice note, pressed: the line the model read before its words', SEEN_VOICE),
    specimen('Pressed: an address read as one detail, a citation that resolves to nothing as written', SEEN_MAIL),
    specimen('Pressed, the covered photo can’t be read: the opaque tile, never the photo', seenTurn(true, 'data:image/jpeg;base64,AAAA')),
  ].join('') + '</div>'),
  group('Conversations · the clock’s drawer on the Chat page', '<div class="gallery__rows">' + [
    specimen('Grouped by when: one still answering under its opening words, a long title', LIST),
    reading('Not read yet: a label and six rows', chatListReading()),
  ].join('') + '</div>'),
  group('Thread · while it reads', '<div class="gallery__ask-col">' + reading('Two turns’ shapes', askThreadReading()) + '</div>'),
].join('');

const onboarding = () => !wants('Action', 'Status', 'Offer', 'List rows', 'AppIcon', 'RowGroup') ? '' : [
  group('Action', '<div class="gallery__buttons">' + [
    specimen('Idle', action('Allow', { done: 'Allowed' })),
    specimen('Busy: the same capsule, its fill and width, a small spinner beside a short word', action('Allow',
      { state: 'busy', done: 'Allowed' })),
    specimen('Working: a state at work no press began: the busy face, not a button', action('Sign in', { state: 'working' })),
    specimen('Done: the same capsule pressed, a quieter fill, the check before its word; not a button', action('Allow',
      { state: 'done', done: 'Allowed' })),
    specimen('Refused outside a row (the foot): its verb again, why in one line beside it', action('Continue',
      { variant: 'primary', why: 'Lifestream didn’t answer. Try again.' })),
    specimen('Every word at its one width', FIT('gallery__fit')),
  ].join('') + '</div>'),
  group('Status', '<div class="gallery__stack">' + [
    specimen('A choice’s mark alone: kept, left out', status('done') + ' ' + status('wanted')),
    specimen('A refusal no control stands beside', status('failed', 'Lifestream can’t open its Wi-Fi connection.')),
    specimen('Plain: a line said once', plain('Nothing on this Mac to read yet. What you add from now on arrives here.')),
  ].join('') + '</div>'),
  group('Offer', '<div class="gallery__stack">' + [
    specimen('A stream to set up, and one set up: Connected, with what is still to come', offers([
      offer({ icon: 'phone-screen', name: 'iPhone', line: 'Where you go, from your phone’s location and photos.',
        end: button('Pair', { variant: 'primary' }) }),
      offer({ icon: 'phone-screen', name: 'iPhone 16 Pro', line: 'Places appear once your iPhone sends where you’ve been.',
        end: connected('Connected') })])),
  ].join('') + '</div>'),
  group('List rows', '<div class="gallery__stack">' + [
    specimen('ListRow: a title over its meta, here now, its meta still counted, a chevron; short rows with a count, a value; '
      + 'not read yet', listRows(
      listRow({ title: 'River Flat', meta: 'Here now · 2h 30m today', here: 'Here now', attrs: {} })
      + listRow({ title: 'Hill Studio', meta: 'Yesterday', attrs: {} })
      + listRow({ title: 'Corner Bakery', meta: null, attrs: {} })
      + listRow({ title: 'Lisbon', meta: '9 places · 3 Oct', chevron: true, attrs: {} })
      + listRow({ title: 'Visited once', count: 3, short: true, quiet: true, chevron: true, attrs: {} })
      + listRow({ title: 'Noodle Bar', value: '12 Sep', short: true, attrs: {} })
      + listRowReading(6, 3))),
    specimen('NoneLine: a list that holds none; with a second line', noneLine('No settings match.')
      + noneLine('Nothing recorded this day.', { detail: 'This Mac was off from 02:10.' })),
  ].join('') + '</div>'),
  group('AppIcon', specimen('Apps by their own icon, else the app glyph', rowGroup([
    groupRow({ name: 'Passwords', app: { src: '' }, end: toggle({ on: true, label: 'Passwords' }) }),
    groupRow({ name: 'Bank', app: { src: '' }, dim: true, end: toggle({ on: false, label: 'Bank' }) }),
  ], { label: 'Apps' }))),
  group('RowGroup', '<div class="gallery__rows">' + [
    specimen('Not read yet: the rows’ skeletons from the first frame', rowGroup([0, 1, 2, 3].map(groupRowReading),
      { attrs: { 'aria-busy': 'true' } })),
    specimen('Counted, reading, off', rowGroup([
      groupRow({ name: 'iMessage', icon: 'message', line: '48,210 messages' }),
      groupRow({ name: 'WhatsApp', icon: 'message', line: null, index: 1 }),
      groupRow({ name: 'Chrome', icon: 'web', line: '2 profiles · 15,550 pages' }),
      groupRow({ name: 'Safari', icon: 'web', line: 'Off', dim: true, signal: 'idle' }),
    ])),
    specimen('Six rows and more: two columns', rowGroup([
      ['iMessage', 'message'], ['WhatsApp', 'message'], ['Notes', 'note'], ['Safari', 'web'], ['Photos', 'photo'],
      ['Calendar', 'calendar-event']].map(([name, icon]) => groupRow({ name, icon, line: '1,204' })), { columns: 2 })),
    specimen('Words that wrap, a state', rowGroup([
      groupRow({ name: 'Screen', icon: 'screen', kind: 'words', line: 'What you look at, read into text so you can find it again.',
        end: signal('engaged', 'On') }),
    ])),
    specimen('Switches, under a label, rows without icons', rowGroup([
      groupRow({ name: 'Passwords', end: toggle({ on: true, label: 'Passwords' }) }),
      groupRow({ name: 'Bank', dim: true, end: toggle({ on: false, label: 'Bank' }) }),
    ], { label: 'Apps' })),
  ].join('') + '</div>'),
].join('');

/** @type {import('./lib/reach.js').Drawn} */
const READ_FAILED = { kind: 'lack', words: null, retry: true };

/** @param {{ label: string, shot: string, id: string, state?: HostState | null, report?: import('./types.js').StreamsReport | null, models?: import('./lib/model-menu.js').Models | null, failed?: import('./lib/reach.js').Drawn | null, unread?: boolean, opened?: Partial<import('./ui/connectors/dialog.js').Opened>, asking?: string, query?: string, size?: [number, number], privacy?: import('./ui/connectors/settings.js').PrivacyReads, storage?: import('./ui/connectors/settings.js').StorageReads, answers?: import('./ui/connectors/settings.js').SettingsReads }} shown */
const settingsWindow = ({ label, shot, id, state = HOST_STATE, report = REPORT, models = MODELS, failed = null, unread = false,
  opened = {}, asking = '', query = '', size = [1100, 860], privacy = SHOWN_PRIVACY,
  storage = { read: STORAGE_YEAR, drawn: null }, answers = SETTINGS_ANSWERS }) => {
  const detail = settingsDetail({ report, models, failed, state, id, opened: { ...OPENED, ...opened }, query, unread, privacy,
    storage, answers,
    subscriptions: flowOf('model', { state, report: null }, { ...sessionOf(state !== null, 'dialog'), models: [...SUBSCRIPTIONS] }, AT) });
  return specimen(label, `<div class="gallery__window" data-shot="${esc(shot)}" data-geo="width:${size[0]}px;height:${size[1]}px">`
    + `${detail ? detailMarkup(detail, { ...AT_REST, asking }) : ''}</div>`);
};

const ONE_MAC = { ...REPORT, devices: REPORT.devices.filter(device => device.unit === HOST_STATE.unit) };
const MANY_PHONES = { ...REPORT, devices: [...REPORT.devices.filter(device => device.kind === 'mac'),
  ...Array.from({ length: 14 }, (_, at) => ({ ...REPORT.devices[3], unit: `iphone-${at}-aa${String(at).padStart(2, '0')}`,
    name: at === 0 ? 'iPhone 17 Pro Max of Person A’s Synthetic' : `iPhone ${at + 4}`, retired: at >= 12 }))] };
const LONGEST = 'Couldn’t sync: Google asked you to sign in again before Lifestream can read your mail, and nothing new '
  + 'arrives until you do.';
const HOME_PAUSE = { ...REPORT.paused[0], target: 'home', by: 'you', reason: 'Paused by you', title: 'Paused: Lifestream',
  line: 'Paused by you · since 09:10' };
const PAUSED_HOME = { ...REPORT, home: { ...REPORT.home, health: { ...REPORT.home.health, state: /** @type {const} */ ('paused'),
  words: 'Paused by you' } }, paused: [...REPORT.paused, HOME_PAUSE] };
const WORST_REPORT = { ...MANY_PHONES, home: PAUSED_HOME.home,
  devices: MANY_PHONES.devices.map(device => device.unit === HOST_STATE.unit ? { ...device, name: 'MacBook Pro of Person A’s Synthetic Home' } : device),
  connectors: MANY_PHONES.connectors.map(connector => ({ ...connector, line: LONGEST })),
  paused: [...REPORT.paused.map(pause => ({ ...pause, line: `${LONGEST} · since Mon` })), HOME_PAUSE] };
/** @type {HostState} */
const WORST_STATE = { ...HOST_STATE, update: null,
  general: { login: false, auto_update: true, version: '2026.11.10', update: 'Lifestream 2026.11.12 is ready', by_hand: null } };

const ELSEWHERE_STATE = { ...HOST_STATE, folder: null };
const AWAY_STATE = { ...HOST_STATE, reach: REACH_STATES.held };

const settingsPages = () => [
  group('Settings · every page, in the Mac app (1100 × 860)', '<div class="gallery__windows">'
    + SETTINGS_ENTRIES.map(page => settingsWindow({ label: page.label, shot: `settings-${page.id}-mac`,
      id: `settings/${page.id}` })).join('') + '</div>'),
  group('Settings · in a browser (1440 × 900): the report’s pages alone, each value in words', '<div class="gallery__windows">'
    + SETTINGS_ENTRIES.filter(page => !page.host).map(page => settingsWindow({ label: page.label,
      shot: `settings-${page.id}-browser`, id: `settings/${page.id}`, state: null, size: [1440, 900] })).join('') + '</div>'),
  group('Settings · every page, worst case: a 40-character Mac, fourteen phones, the longest sentence, Japanese, paused',
    '<div class="gallery__windows">' + SETTINGS_ENTRIES.map(page => settingsWindow({ label: page.label,
      shot: `settings-${page.id}-worst`, id: `settings/${page.id}`, state: WORST_STATE, report: WORST_REPORT })).join('') + '</div>'),
  group('Settings · states and sizes', '<div class="gallery__windows">' + [
    settingsWindow({ label: 'Reading: Home before the report', shot: 'settings-home-reading', id: 'settings/home', report: null }),
    settingsWindow({ label: 'Reading: Advanced before its answer', shot: 'settings-advanced-reading', id: 'settings/advanced',
      answers: { ...SETTINGS_ANSWERS, pages: {} } }),
    settingsWindow({ label: 'Reading: Providers before its read', shot: 'settings-models-reading', id: SETTINGS_PROVIDERS, models: null }),
    settingsWindow({ label: 'The home does not answer: Home, from the host', shot: 'settings-home-away', id: 'settings/home',
      state: AWAY_STATE, report: null, unread: true }),
    settingsWindow({ label: 'The home does not answer: Advanced, what it last held', shot: 'settings-advanced-away', id: 'settings/advanced',
      state: AWAY_STATE }),
    settingsWindow({ label: 'A Mac that does not hold the home: Home', shot: 'settings-home-elsewhere', id: 'settings/home', state: ELSEWHERE_STATE }),
    settingsWindow({ label: 'A Mac that does not hold the home: This Mac', shot: 'settings-mac-elsewhere', id: 'settings/mac', state: ELSEWHERE_STATE }),
    settingsWindow({ label: 'One Mac: This Mac', shot: 'settings-mac-one', id: 'settings/mac', report: ONE_MAC }),
    settingsWindow({ label: 'No iPhone', shot: 'settings-iphone-none', id: 'settings/iphone', report: ONE_MAC }),
    settingsWindow({ label: 'Fourteen iPhones, two removed, one named at length', shot: 'settings-iphone-many', id: 'settings/iphone', report: MANY_PHONES }),
    settingsWindow({ label: 'A phone’s part, as its side row opens it', shot: 'settings-iphone-row', id: 'settings/iphone/iphone-12-cc03' }),
    settingsWindow({ label: 'Rename…, a page inside Macs: the Mac’s name as it is', shot: 'settings-mac-rename', id: 'settings/mac',
      opened: { pages: [`rename:${HOST_STATE.unit}`] } }),
    settingsWindow({ label: 'Rename… another Mac, a new name typed', shot: 'settings-mac-rename-other', id: 'settings/mac',
      opened: { pages: ['rename:macbook-air-bb07'], fields: { 'mac.name': 'Desk Mac' } } }),
    settingsWindow({ label: 'A phone’s Remove, asked in its row’s place', shot: 'settings-iphone-remove', id: 'settings/iphone',
      asking: 'retire:iphone-17-pro-aa01' }),
    settingsWindow({ label: 'Lifestream paused: its status in its words, Pause Lifestream on', shot: 'settings-home-paused', id: 'settings/home',
      report: PAUSED_HOME }),
    settingsWindow({ label: 'Other server, a page inside Providers', shot: 'settings-models-address', id: SETTINGS_PROVIDERS,
      models: MODELS_BARE, opened: { pages: ['address'] } }),
    settingsWindow({ label: 'Search: “port”', shot: 'settings-search', id: 'settings/advanced', query: 'port' }),
    settingsWindow({ label: 'Search that finds nothing', shot: 'settings-search-none', id: 'settings/home', query: 'zzz' }),
    settingsWindow({ label: 'An update ready, a grant missing: the dots', shot: 'settings-updates-ready', id: 'settings/updates',
      state: { ...HOST_STATE, general: { login: true, auto_update: true, version: '2026.11.10', update: 'Version 2026.11.12 is ready.', by_hand: null } } }),
    settingsWindow({ label: 'Recovery key: saved, its date; Make a new key… opens the app’s window', shot: 'settings-recovery-saved',
      id: 'settings/recovery', state: { ...HOST_STATE, vault: { state: 'saved', saved_ms: AT } } }),
    settingsWindow({ label: 'Recovery key: no key of this Mac opens the vault, Unlock…', shot: 'settings-recovery-lost', id: 'settings/recovery',
      state: { ...HOST_STATE, vault: { state: 'lost', saved_ms: AT } } }),
    settingsWindow({ label: 'A build that does not update itself', shot: 'settings-updates-by-hand', id: 'settings/updates',
      state: { ...HOST_STATE, general: { login: true, auto_update: false, version: '2026.11.10', update: null,
        by_hand: 'This build does not update itself. A new build is installed by hand.' } } }),
    settingsWindow({ label: 'The smallest window (900 × 600): This Mac', shot: 'settings-mac-small', id: 'settings/mac', size: [900, 600] }),
    settingsWindow({ label: 'The smallest window (900 × 600): Providers', shot: 'settings-models-small', id: SETTINGS_PROVIDERS, size: [900, 600] }),
  ].join('') + '</div>'),
].join('');

const storagePages = () => {
  const STORAGE = 'settings/storage';
  const year = STORAGE_YEAR;
  const counting = STORAGE_COUNTING;
  /** @param {import('./ui/connectors/settings-storage.js').Storage} answer */
  const barOf = answer => diskBar({ ...answer.bar, time: answer.bar.left });
  /** @param {import('./ui/connectors/settings-storage.js').Storage['uses'][number] | undefined} row */
  const usage = row => row ? `<ul class="ck-ssection__rows">${usageRow({ ...row, line: phraseOf(row.line), go: row.opens ? {} : null })}</ul>` : '';
  /** @param {import('./ui/connectors/settings-storage.js').Storage} answer @param {{ bytes: number, name: string }} [room] */
  const chartOf = (answer, room) => answer.chart ? areaChart({ ...answer.chart, label: phraseOf(answer.chart.label), ...room ? { room } : {} }) : '';
  const lit = (/** @type {string} */ markup) => `<div class="cn-storage" data-lights>${markup}</div>`;
  return group('Settings · Storage, every state', '<div class="gallery__windows">' + [
    settingsWindow({ label: 'A year in, on T9', shot: 'settings-storage-year', id: STORAGE }),
    settingsWindow({ label: 'A year in: Show 9 more streams pressed', shot: 'settings-storage-more', id: STORAGE,
      storage: { read: STORAGE_YEAR, drawn: null, more: true } }),
    settingsWindow({ label: 'A home three days old', shot: 'settings-storage-new', id: STORAGE, storage: { read: STORAGE_NEW, drawn: null } }),
    settingsWindow({ label: 'Counting: 212 GB so far', shot: 'settings-storage-counting', id: STORAGE, storage: { read: STORAGE_COUNTING, drawn: null } }),
    settingsWindow({ label: 'Counting, before the first figure', shot: 'settings-storage-first', id: STORAGE, storage: { read: STORAGE_MAP, drawn: null } }),
    settingsWindow({ label: 'Reading: before its read', shot: 'settings-storage-reading', id: STORAGE, storage: { read: null, drawn: null } }),
    settingsWindow({ label: 'Its read failed', shot: 'settings-storage-failed', id: STORAGE, storage: { read: null, drawn: READ_FAILED } }),
    settingsWindow({ label: 'Its read failed, what it last read under it', shot: 'settings-storage-failed-kept', id: STORAGE,
      storage: { read: STORAGE_YEAR, drawn: READ_FAILED } }),
    settingsWindow({ label: 'The home not answering: its last read kept, the banner saying why', shot: 'settings-storage-away', id: STORAGE,
      state: AWAY_STATE }),
    settingsWindow({ label: 'In a browser (1440 × 900)', shot: 'settings-storage-in-browser', id: STORAGE, state: null, size: [1440, 900] }),
    settingsWindow({ label: 'The smallest window (900 × 600)', shot: 'settings-storage-small', id: STORAGE, size: [900, 600] }),
  ].join('') + '</div>')
  + group('Storage · DiskBar, AreaChart, UsageRow', '<div class="gallery__rows">' + [
    specimen('DiskBar, counted: five streams by rank, Other streams, Index and AI, other files hatched, free', lit(barOf(year))),
    specimen('DiskBar, counting: what is counted, Not yet counted, the time left', lit(barOf(counting))),
    specimen('DiskBar, before the first figure', lit(barOf(STORAGE_MAP))),
    specimen('AreaChart: 150 days stacked, the rate a quarter ahead', lit(chartOf(year))),
    specimen('AreaChart: the disk in reach, its line where the rate meets it', lit(chartOf(year,
      { bytes: (STORAGE_YEAR.chart?.parts ?? []).reduce((sum, part) => sum + (part.bytes.at(-1) ?? 0), 60e9), name: 'T9 full' }))),
    specimen('AreaChart: a home three days old, no rate yet', lit(chartOf(STORAGE_NEW))),
    specimen('UsageRow: a stream, its week, opening its dialog', lit(usage(year.uses[0]))),
    specimen('UsageRow: Index and AI, which opens nothing', lit(usage(year.uses.at(-1)))),
    specimen('UsageRow: counting, no week', lit(usage(counting.uses[0]))),
  ].join('') + '</div>');
};

const SHOWN_PRIVACY = { ...NO_PRIVACY, read: PRIVACY.fresh, days: OUTBOUND_DAYS_READ, page: OUTBOUND_PAGE, row: SENT };

const privacyPages = () => {
  const reads = (/** @type {Partial<import('./ui/connectors/settings.js').PrivacyReads>} */ more) => ({ ...SHOWN_PRIVACY, ...more });
  return [
    group('Settings · Privacy', '<div class="gallery__windows">' + [
      settingsWindow({ label: 'A new home: what the home knows, nothing to wait on', shot: 'settings-privacy-fresh', id: SETTINGS_PRIVACY }),
      settingsWindow({ label: 'The hiding model chosen, downloading', shot: 'settings-privacy-downloading', id: SETTINGS_PRIVACY,
        privacy: reads({ read: PRIVACY.downloading }) }),
      settingsWindow({ label: 'The hiding model there, the record being marked; Chat hides all; three words always hidden',
        shot: 'settings-privacy-marking', id: SETTINGS_PRIVACY, privacy: reads({ read: PRIVACY.marking }) }),
      settingsWindow({ label: 'The hiding model chosen and not there: why', shot: 'settings-privacy-absent', id: SETTINGS_PRIVACY,
        privacy: reads({ read: PRIVACY.absent }) }),
      settingsWindow({ label: 'Don’t hide', shot: 'settings-privacy-none', id: SETTINGS_PRIVACY, privacy: reads({ read: PRIVACY.none }) }),
      settingsWindow({ label: 'Before hiding’s state is read', shot: 'settings-privacy-reading', id: SETTINGS_PRIVACY, privacy: NO_PRIVACY }),
      settingsWindow({ label: 'The read failed', shot: 'settings-privacy-failed', id: SETTINGS_PRIVACY,
        privacy: { ...NO_PRIVACY, drawn: READ_FAILED } }),
      settingsWindow({ label: 'In a browser: the words alone', shot: 'settings-privacy-browser', id: SETTINGS_PRIVACY, state: null,
        size: [1440, 900] }),
      settingsWindow({ label: 'Always hide, a page inside Privacy', shot: 'settings-privacy-always', id: SETTINGS_PRIVACY,
        privacy: reads({ read: PRIVACY.marking }), opened: { pages: ['list:privacy.always'] } }),
      settingsWindow({ label: 'A day’s rows to one receiver', shot: 'settings-privacy-day', id: SETTINGS_PRIVACY,
        opened: { pages: [`outbound:${OUTBOUND_PAGE.rows[0]?.day}:OpenAI`] } }),
      settingsWindow({ label: 'What one ask sent', shot: 'settings-privacy-sent', id: SETTINGS_PRIVACY,
        opened: { pages: [`outbound:${SENT.day}:OpenAI`, `sent:${SENT.seq}`] } }),
      settingsWindow({ label: 'What one ask sent, its request taken by an erasure', shot: 'settings-privacy-erased', id: SETTINGS_PRIVACY,
        opened: { pages: [`outbound:${SENT.day}:OpenAI`, `sent:${SENT.seq}`] }, privacy: reads({ row: SENT_ERASED }) }),
      settingsWindow({ label: 'What one ask sent, hidden with the hiding model', shot: 'settings-privacy-sent-model', id: SETTINGS_PRIVACY,
        opened: { pages: [`outbound:${SENT.day}:OpenAI`, `sent:${SENT.seq}`] }, privacy: reads({ row: SENT_MODEL }) }),
    ].join('') + '</div>'),
    group('Streams · the privacy line, and a row waiting on hiding',
      specimen('WhatsApp’s photos: what they hide, and waiting on hiding (the row opens Settings › Privacy)',
        '<div class="gallery__dialogs">' + [REPORT, WAITING_REPORT]
          .map(report => detailOf(report, HOST_STATE, 'whatsapp', OPENED))
          .map(detail => detail ? `<div class="gallery__dialog">${detailMarkup(detail, AT_REST)}</div>` : '').join('') + '</div>')),
    privacyLines(),
  ].join('');
};

const llm = () => [
  group('Streams · LLM processing, its own tab',
    specimen('Every shape: in progress and needing a model (WhatsApp, as the home writes it), done with some given up (Gmail), off (ChatGPT), waiting on a plan '
      + 'with a device’s line (Claude), done (Photos), needs a model (Screen), under AI',
    everyDialog(HOST_STATE, { ids: SHAPED, report: LLM_REPORT }))
    + specimen('In a browser: the words alone', streamDialogs(null, [{ id: 'whatsapp' }, { id: 'gmail' }],
      LLM_REPORT))),
  group('Settings · Default models and Providers', '<div class="gallery__windows">' + [
    settingsWindow({ label: 'Default models: each use and its model, Thinking under Chat', shot: 'settings-defaults-full', id: SETTINGS_DEFAULTS }),
    settingsWindow({ label: 'Default models › More: the field on top, what was typed found under where each model comes from', shot: 'settings-defaults-more',
      id: SETTINGS_DEFAULTS, opened: { pages: ['more:pictures'], typed: 'qwen', found: { key: 'use:pictures\nqwen', failed: '', answer: FOUND_QWEN } } }),
    settingsWindow({ label: 'Default models, nothing connected yet', shot: 'settings-defaults-bare', id: SETTINGS_DEFAULTS, models: MODELS_BARE }),
    settingsWindow({ label: 'Providers: the accounts, three Macs’ models, a file downloading, the other server', shot: 'settings-models-full', id: SETTINGS_PROVIDERS }),
    settingsWindow({ label: 'This Mac on battery: Save battery holds older work, the part says why', shot: 'settings-models-battery', id: SETTINGS_PROVIDERS, models: ON_BATTERY }),
    settingsWindow({ label: 'Save battery off: every item runs on battery', shot: 'settings-models-battery-off', id: SETTINGS_PROVIDERS, models: BATTERY_SPENT }),
    settingsWindow({ label: 'In a browser: Save battery in words', shot: 'settings-models-battery-browser', id: SETTINGS_PROVIDERS, models: ON_BATTERY, state: null }),
    settingsWindow({ label: 'Nothing connected yet', shot: 'settings-models-bare', id: SETTINGS_PROVIDERS, models: MODELS_BARE }),
    settingsWindow({ label: 'The read failed', shot: 'settings-models-failed', id: SETTINGS_PROVIDERS, models: null, failed: READ_FAILED }),
  ].join('') + '</div>'),
  group('Settings · Subscriptions, the model flow’s items', '<div class="gallery__windows">' + [
    settingsWindow({ label: 'Neither connected', shot: 'settings-subs-none', id: SETTINGS_PROVIDERS, state: { ...HOST_STATE, ask_login: SUBSCRIBED.none } }),
    settingsWindow({ label: 'ChatGPT downloading, Claude signed in', shot: 'settings-subs-mixed', id: SETTINGS_PROVIDERS,
      state: { ...HOST_STATE, ask_login: SUBSCRIBED.mixed } }),
    settingsWindow({ label: 'Both signing in: ChatGPT’s code, Claude’s approval', shot: 'settings-subs-signing', id: SETTINGS_PROVIDERS,
      state: { ...HOST_STATE, ask_login: SUBSCRIBED.signing } }),
    settingsWindow({ label: 'Signed out, and a sign-in that failed', shot: 'settings-subs-failed', id: SETTINGS_PROVIDERS,
      state: { ...HOST_STATE, ask_login: SUBSCRIBED.failed } }),
  ].join('') + '</div>'),
  group('Made · a voice note’s transcript', '<div class="gallery__rows">' + [
    specimen('Transcribed: the model and the day, Transcribe again ⌄', made({ made: TRANSCRIBED.again, verbs: TRANSCRIBE, acts: true, id: 'gallery-voice-done' })),
    specimen('In the queue: the home’s line and Transcribe now', made({ made: TRANSCRIBED.queued, verbs: TRANSCRIBE, acts: true, id: 'gallery-voice-waiting' })),
    specimen('Sent', made({ made: TRANSCRIBED.queued, verbs: TRANSCRIBE, acts: true, busy: true,
      id: 'gallery-voice-busy' })),
    specimen('Waiting on its model: the home’s line alone', made({ made: TRANSCRIBED.resting, verbs: TRANSCRIBE, acts: true, id: 'gallery-voice-resting' })),
    specimen('A photo’s, in a browser', made({ made: DESCRIBED.done, verbs: DESCRIBE, acts: false,
      id: 'gallery-photo-browser' })),
  ].join('') + '</div>'),
].join('');


/** @param {string} markup */
const shown = markup => {
  if (!asked.length) return markup;
  const whole = document.createElement('template');
  whole.innerHTML = markup;
  return [...whole.content.querySelectorAll('.gallery__group')].filter(section => {
    const name = section.querySelector('.ck-section__label')?.textContent ?? '';
    return asked.some(words => name.startsWith(words));
  }).map(section => section.outerHTML).join('');
};

const chosen = () => pageOf(REPORT, HOST_STATE, filter({ place: 'mac' }));
const main = /** @type {HTMLElement} */ (document.querySelector('#main'));
watchPictures(main);
main.innerHTML = shown(drawn([
  ask(),
  onboarding(),
  wants('Setup') ? setupGallery() : '',
  wants('Flows', 'To connect') ? flows() : '',
  wants('PersonFace', 'FaceCrop', 'FaceGrid', 'MoveAndScale', 'FieldRow', 'NameRow', 'FormCard', 'YouCard', 'FactChip', 'Calendar', 'FloatList', 'FaceTile', 'People', 'Meter') ? people() : '',
  wants('Places', 'PhotoGrid', 'PersonChip', 'FaceStack', 'QuestionCard', 'NameField', 'NameRow', 'CircleEditor', 'CircleRow') ? placePages() : '',
  ...(wants('Days') ? days() : []),
  wants('Days · the side column') ? daysSide() : '',
  wants('VideoMark', 'Video stage', 'Live Photo') ? video() : '',
  wants('StatusStrip', 'PageLack', 'Loading', 'In place') ? reach() : '',
  group('Connectors · the page in the Mac app’s window, with the host’s state', () => '<div class="gallery__windows">' + [
    connectorsWindow('Every kind: Needs you first, each kind’s set-up rows before the rest, Imports last', 'connectors-full',
      page(HOST_STATE, filter({}))),
    connectorsWindow('A new home: Start with these, then every kind, each row’s Connect', 'connectors-new',
      page(HOST_STATE, filter({}), { from: NEW_HOME })),
    connectorsWindow('The whole list, every section to its end', 'connectors-whole', page(HOST_STATE, filter({})), 3000),
    connectorsWindow('Mac chosen under Where', 'connectors-mac', page(HOST_STATE, filter({ place: 'mac' }))),
    connectorsWindow('A search that keeps nothing, the coding agent’s line opened', 'connectors-none',
      page(HOST_STATE, filter({ query: 'Obsidian' }), { adding: true })),
    connectorsWindow('In a browser: the home’s acts alone', 'connectors-browser', page(null, filter({}))),
    connectorsWindow('Before the report', 'connectors-reading', page(HOST_STATE, filter({}), { read: false })),
  ].join('') + '</div>'
    + group('Alerts · folded strips on Connectors, heaviest first; the banner on every page', '<div class="gallery__windows">' + [
      connectorsWindow('One advice strip: its act and ×', 'alerts-one', page(ALERT_STATE, filter({}), { from: alerting([ALERTS[1]]) })),
      connectorsWindow('Five, folded into the stopped one: · 4 more, two slivers, no ×', 'alerts-five',
        page(ALERT_STATE, filter({}), { from: alerting(ALERTS) })),
      connectorsWindow('Five, opened: each its own act and ×, Show less', 'alerts-open',
        page(ALERT_STATE, filter({}), { from: alerting(ALERTS), alerts: { open: true, copied: '' } }), 1100),
      connectorsWindow('Advice first when nothing stopped: its button and × on the folded strip', 'alerts-advice',
        page(ALERT_STATE, filter({}), { from: alerting(ALERTS.slice(1)) })),
      connectorsWindow('Copy fix pressed: Copied', 'alerts-copied',
        page(ALERT_STATE, filter({}), { from: alerting([ALERTS[4]]), alerts: { open: false, copied: 'loose:home' } })),
      bannerWindow('Banner: Lifestream’s disk full, on every page', 'banner-full', homeStrip(REACH_STATES.answering, { others: [DISK_FULL] })),
      bannerWindow('Banner: two at once, the worst with +1, opened', 'banner-two', homeStrip(REACH_STATES['update, this Mac\'s'],
        { others: [DISK_FULL], listing: true })),
      bannerWindow('Banner: Lifestream isn’t running, on its own Mac', 'banner-down', homeStrip(REACH_STATES['unreachable, Lifestream not running'])),
      bannerWindow('Banner: its drive away, the › opened to the checklist', 'banner-drive',
        homeStrip(DRIVE_AWAY, { open: true })),
      bannerWindow('Banner: fixed, for 3 s', 'banner-back', homeStrip(REACH_STATES.answering,
        { others: [{ tone: 'done', title: 'Lifestream is back', line: '64 GB free' }] })),
    ].join('') + '</div>')
    + specimen('Dialogs: every stream as one page (this week, Comes from, Settings, AI, History, what it reads), the week’s day '
      + 'lit on the first', everyDialog(HOST_STATE))
),
  group('Connectors · a connector’s page, one fixed frame', () => '<div class="gallery__windows">' + [
    dialogWindow('Set up: one page in its fixed order, Disconnect and Pause at the foot', 'cn-page-whatsapp',
      detailOf(REPORT, HOST_STATE, 'whatsapp', OPENED)),
    dialogWindow('The same page unrolled: every section in its order', 'cn-page-unrolled',
      { .../** @type {import('./ui/connectors/dialog.js').Detail} */ (detailOf(REPORT, HOST_STATE, 'whatsapp', OPENED)), page: false }, '', 1500),
    dialogWindow('An AI row’s › pushed its page into the same frame', 'cn-page-ai',
      detailOf(REPORT, HOST_STATE, 'whatsapp', { ...OPENED, pages: ['ai:llm.photos'] })),
    dialogWindow('Disconnect, asked over the page', 'cn-page-disconnect', detailOf(REPORT, HOST_STATE, 'whatsapp', OPENED), 'off:whatsapp'),
    dialogWindow('Set up, nothing yet: one progress line', 'cn-page-reading', detailOf(READING_HISTORY, HOST_STATE, 'whatsapp', OPENED)),
    dialogWindow('Not set up: the page is the setup', 'cn-page-setup', detailOf(NEW_HOME, HOST_STATE, 'granola', OPENED)),
    dialogWindow('Not set up, two ways', 'cn-page-setup-ways', detailOf(NEW_HOME, HOST_STATE, 'whatsapp', OPENED)),
    dialogWindow('The export page: numbered steps, the drop as the last', 'cn-page-export',
      detailOf(importsReport(), IMPORTS_STATE, 'import:spotify', OPENED)),
    dialogWindow('The sign-in sheet: steps and fields, the refusal under its field', 'cn-page-signin',
      detailOf(PROOF_REPORT, HOST_STATE, 'example-bank', { ...OPENED, pages: ['form'], refused: 'The bank refused this password. Make a new one and paste it here.' })),
  ].join('') + '</div>'),
  group('Streams · the dialog’s pages and its foot', () => specimen('Pages inside a dialog: Apps and sites typed into, Other app… at its add row’s end, a list'
    , streamDialogs(HOST_STATE, [{ id: 'screen', pages: ['list:apps'], typed: 'ke' }, { id: 'google-calendar', pages: ['list:calendars'] }]))
    + specimen('Turn off, asked in the foot', streamDialogs(HOST_STATE, [{ id: 'gmail', asking: 'off:gmail' }]))
    + specimen('In a browser: no ends, where it is done', streamDialogs(null, [{ id: 'screen' }, { id: 'claude' }]))),
  group('Streams · the proof connectors: every control, a form, the sign-in sheets asked, Refresh now', () =>
    specimen('Every control: a menu, a zone, a stepper, a switch, a list, a path on this Mac; Refresh now under Refresh rate',
      streamDialogs(HOST_STATE, [{ id: 'example-log' }], PROOF_REPORT))
    + specimen('The same on another Mac: the path says where it is chosen',
      streamDialogs({ ...HOST_STATE, unit: 'macbook-air-bb17' }, [{ id: 'example-log' }], PROOF_REPORT))
    + specimen('A form on an upload: its rows open Set up, where a day is a date and a name a field',
      streamDialogs(HOST_STATE, [{ id: 'example-bank' }, { id: 'example-bank', pages: ['form'] }], PROOF_REPORT))
    + specimen('Signed in with the person’s own client: Connect asks the Mac for its ClientSheet; in a browser, where',
      streamDialogs(HOST_STATE, [{ id: 'example-oauth' }], PROOF_REPORT) + streamDialogs(null, [{ id: 'example-oauth' }], PROOF_REPORT))
    + specimen('Refresh now blocked: each reason in the home’s words, no button; a Mac asked',
      streamDialogs(HOST_STATE, ['example-site', 'example-feed', 'example-api', 'example-files', 'example-notes', 'example-sync',
        'example-wait', 'example-mac'].map(id => ({ id })), PROOF_REPORT))
    + specimen('In a browser: every value in words, Refresh now pressed through the dashboard, where the rest is changed',
      streamDialogs(null, [{ id: 'example-log' }, { id: 'example-bank' }], PROOF_REPORT))),
  group('Streams · Imports: a person’s past, from the exports a company hands them', () =>
    specimen('Connected before anything is brought in: the banner, once', page(IMPORTS_STATE, filter({}), { from: importsReport() }))
    + specimen('The Takeout in, its row under Imports with its line', page(IMPORTS_STATE, filter({}),
      { from: importsReport({ takeout: holding(BROUGHT, DONE) }) }))
    + specimen('Each state of a kind’s window', '<div class="gallery__dialogs">' + SCENES.map(scene => {
      const detail = detailOf(scene.report, scene.state, `import:${scene.kind}`, OPENED);
      return detail ? `<div class="gallery__dialog" data-import-scene="${esc(scene.name)}">`
        + `<p class="gallery__label mac-mono-label">${esc(scene.name)}</p>${detailMarkup(detail, AT_REST)}</div>` : '';
    }).join('') + '</div>')
    + specimen('The iPhone backup’s window: the backups on this Mac in place of the drop zone', '<div class="gallery__dialogs">'
      + BACKUP_SCENES.map(scene => {
        const detail = detailOf(scene.report, scene.state, `import:${scene.kind}`, OPENED);
        return detail ? `<div class="gallery__dialog" data-backup-scene="${esc(scene.name)}">`
          + `<p class="gallery__label mac-mono-label">${esc(scene.name)}</p>${detailMarkup(detail, AT_REST)}</div>` : '';
      }).join('') + '</div>')
    + specimen('DropZone: at rest, lit by a file dragged over it, and in a browser', ['', ' is-over', null].map(lit => {
      const zone = dropZone({ words: TAKEOUT.drop.words, line: TAKEOUT.drop.line, elsewhere: lit === null ? 'On your Mac' : '',
        act: lit === null ? '' : button('Choose…', { variant: 'secondary' }) });
      return lit ? zone.replace('class="ck-drop"', `class="ck-drop${lit}"`) : zone;
    }).join(''))
    + specimen('A stream the Takeout feeds: its Comes from row, Show opening the Takeout’s window', streamDialogs(IMPORTS_STATE,
      [{ id: 'gmail' }], importsReport()))),
  group('Streams · in a browser: the home’s act on a need, every other act the Mac’s', () => specimen('Connected', page(null, filter({})))
    + specimen('Dialogs', dialogs(null, [{ id: 'whatsapp' }, { id: 'gmail' }, { id: 'github' }, { id: 'granola' }]))),
  group('Streams · while its first read is under way', () =>
    specimen('With the host’s state: its needs, Lifestream’s word and This Mac’s line at once',
      page(HOST_STATE, filter({}), { read: false }))
    + specimen('In a browser', page(null, filter({}), { read: false }))),
  group('Streams · the home does not answer, with the host’s state', () =>
    specimen('What the host’s state holds alone', page(HOST_STATE, filter({}),
      { read: false, failed: inPlaceLine('Can\'t reach Lifestream.', { retry: {} }) }))),
  group('Search · while it reads', () => '<div class="gallery__rows">'
    + reading('Its first read: All alone with Any time, a label and six rows not read yet',
      `<div class="sx-col">${CHIPS_WAITING}${hitListReading()}</div>`)
    + specimen('Read: top hits, then each kind with its count', '<div class="sx-col">'
      + searchChips({ answer: KINDS, family: '', time: '', held: KINDS.held, today: TODAY })
      + `${kindsList(KINDS, { today: TODAY }).markup}</div>`)
    + '</div>'),
  group('FilterMenu', () => '<div class="gallery__menus">' + [
    specimen('Closed', filterMenu({ name: PAGE.where, all: PAGE.everywhere, value: '', attrs: {},
      choices: places(PLACES.map(place => chosen().placeCounts[place.key])) })),
    specimen('Chosen, its own clear inside', filterMenu({ name: PAGE.where, all: PAGE.everywhere, value: 'mac',
      attrs: {}, choices: places(PLACES.map(() => 3)) })),
    specimen('Open, a choice of none greyed', filterMenu({ name: PAGE.where, all: PAGE.everywhere, value: '', attrs: {},
      active: 3, choices: places(PLACES.map((_, at) => at === 2 ? 0 : 3)) })),
    specimen('Open from its leading edge, Mac chosen', filterMenu({ name: PAGE.where, all: PAGE.everywhere,
      value: 'mac', attrs: {}, align: 'start', active: 0, choices: places(PLACES.map(() => 3)) })),
    specimen('Waiting: nothing to filter yet', filterMenu({ name: PAGE.where, all: PAGE.everywhere, value: '', attrs: {},
      waiting: true, choices: [] })),
    specimen('Waiting, its choice named: nothing to choose now', filterMenu({ name: PAGE.where, all: PAGE.everywhere,
      value: 'mac', attrs: {}, waiting: true, choices: places(PLACES.map(() => 3)) })),
  ].join('') + '</div>'),
  group('NavRow', () => '<div class="gallery__buttons">' + [
    specimen('The sidebar’s rows: the open one lit by its fill alone, its icon the outline; a need as its Count in caution',
      `<div class="gallery__account gallery__nav">${NAV_ROWS}</div>`),
  ].join('') + '</div>'),
  group('AccountMenu', () => '<div class="gallery__menus">' + [
    specimen('Your row at the sidebar’s foot; a home with no You yet', ACCOUNT({ id: 'g-account-none', you: false })),
    specimen('An update downloaded and waiting: the dot on your face', ACCOUNT({ id: 'g-account-update', mac: true, update: true })),
    specimen('Pressed in a browser: Settings alone', ACCOUNT({ id: 'g-account-web', open: true })),
    specimen('Pressed on the Mac, an update waiting: Settings ⌘, and Restart to Update', ACCOUNT({ id: 'g-account-mac', mac: true,
      update: true, open: true })),
    specimen('Pressed while feedback is open: Settings ⌘,, a rule, Send feedback…', ACCOUNT({ id: 'g-account-feedback', mac: true,
      open: true, feedback: true })),
  ].join('') + '</div>'),
  group('AttachmentChip', () => '<div class="gallery__rows">' + [
    specimen('Attached: its kind, its title, a remove; pressed, it is left out and offered again', attachmentChips([
      attachmentChip({ title: 'This answer', kept: true, glyph: 'chat' }),
      attachmentChip({ title: 'App details', kept: true, glyph: 'info' }),
      attachmentChip({ title: 'Example’s status', kept: false, glyph: 'streams' })])),
    specimen('A screenshot: the picture itself, opened full size from it, added only when pressed', attachmentChips([
      attachmentChip({ title: 'Screenshot', add: 'Add screenshot', kept: false, picture: { src: 'kit-gallery.photos.svg', attrs: {} } }),
      attachmentChip({ title: 'Screenshot', add: 'Add screenshot', kept: true, picture: { src: 'kit-gallery.photos.svg', attrs: {} } })])),
  ].join('') + '</div>'),
  group('Toast', () => '<div class="gallery__rows">' + [
    specimen('Sent: the home’s words, then gone', toast({ title: 'Sent. Thank you.', held: true })),
    specimen('With a line', toast({ title: 'Sent. Thank you.', line: 'We’ll reply to person-a@example.com.', held: true })),
  ].join('') + '</div>'),
  group('SettingRow', () => '<div class="gallery__rows gallery__rows--wide">' + [
    specimen('Its menu, its switch, a page it opens: each its line of what it does; a list its count', section([
      settingRow({ label: 'Refresh rate', line: 'How often Lifestream looks for what is new.',
        end: menuButton({ id: 'g-refresh', label: 'Refresh rate', words: 'Every 30 minutes', choices: EVERY }) }),
      settingRow({ label: 'Refresh now', line: 'Checked 14:17', end: '<button type="button" class="ck-btn ck-btn--secondary mac-headline">Refresh</button>' }),
      settingRow({ label: 'Ask through the day', line: 'Your iPhone asks how you are at two random times, from two hours after you wake to two hours before bedtime.',
        end: toggle({ on: true, label: 'Ask through the day' }) }),
      settingRow({ label: 'Calendars', go: { value: '3', attrs: {} } }),
    ])),
    specimen('A source: its road’s icon on its tile, always, and its line; one quiet, its shape before its line; one off, quiet', section([
      settingRow({ label: 'MacBook Pro', lead: settingTile('work-mac'), line: '1,204 dictations · last 14:05',
        end: toggle({ on: true, label: 'MacBook Pro' }) }),
      settingRow({ label: 'iPhone 17 Pro', lead: settingTile('phone-screen'), signal: 'idle', line: '2,277 app switches · last 14 Oct',
        end: toggle({ on: true, label: 'iPhone 17 Pro' }) }),
      settingRow({ label: 'Previous iPhone 17 Pro', lead: settingTile('phone-screen'), line: '131,579 points · last 16 Oct',
        dim: true, end: toggle({ on: false, label: 'Previous iPhone 17 Pro' }) }),
    ])),
    specimen('Backfill’s Status: the history’s line led by its mark, its act at its end', section([
      settingRow({ label: 'Status', mark: signalShape('idle'), line: 'Paused by hand · since 28 Oct',
        end: '<button type="button" class="ck-btn ck-btn--secondary mac-headline">Resume</button>' }),
    ])),
    specimen('What it does, over what it is now (LLM processing’s work)', section([
      settingRow({ label: 'Photo descriptions', does: 'A model describes your photos, so they read as text in your days and in search.',
        mark: signalShape('caution'), line: 'Add the key for OpenRouter',
        end: menuButton({ id: 'g-work', label: 'Photo descriptions', words: 'Gemini 3.8 Flash', choices: choices(['Gemini 3.8 Flash', 'Off'], 0, 1) }) }),
    ])),
    specimen('Its line of what it does, and a phone that has not taken the change yet', section([
      settingRow({ label: 'Precision', line: 'Battery saving records where you stay and each move of a few hundred metres, not every street.',
        waiting: ['Waiting for iPhone 17 Pro · Open Lifestream on it to sync.'],
        end: menuButton({ id: 'g-precision', label: 'Precision', words: 'Battery saving', choices: choices(['Precise', 'Battery saving'], 1, 0) }) }),
    ])),
    specimen('A setting only some of the stream’s devices follow: which, in the waiting line’s place', section([
      settingRow({ label: 'Refresh rate', only: 'On MacBook Pro',
        end: menuButton({ id: 'g-refresh-only', label: 'Refresh rate', words: 'Every 5 minutes', choices: EVERY }) }),
    ])),
    specimen('A menu busy: what the change did is being read', section([
      settingRow({ label: 'OCR', end: menuButton({ id: 'g-ocr-busy', label: 'OCR', words: 'Every frame', choices: OCR, busy: true }) }),
    ])),
    specimen('The add row, a full row of the panel, what it finds under it', section([
      settingRow({ label: 'Vault', lead: appIcon('Vault', ''), end: menuButton({ id: 'g-mode-vault', label: 'Vault', words: 'Never',
        choices: choices(['Record', 'Activity only', 'Never'], 2, 0) }) }),
      settingRow({ label: 'bank.example.com', lead: settingTile('web'), end: menuButton({ id: 'g-mode-bank',
        label: 'bank.example.com', words: 'Never', choices: choices(['Record', 'Activity only', 'Never'], 2, 0) }) }),
      addRow({ placeholder: 'Add an app or site', value: 'ke', lit: 0,
        finds: [{ name: 'Keys', lead: appIcon('Keys', '') }, { name: 'keynote.example.com', lead: icon('web', { size: 'sm' }) }] }),
    ])),
  ].join('') + '</div>'),
  group('MenuButton', () => '<div class="gallery__menus">' + [
    specimen('Closed', menuButton({ id: 'g-closed', label: 'Refresh rate', words: 'Every 30 minutes', choices: EVERY })),
    specimen('Open: the chosen checked, the default said', menuButton({ id: 'g-open', label: 'Refresh rate', words: 'Every 30 minutes',
      choices: EVERY, active: 3 })),
    specimen('Open: a note under an item', menuButton({ id: 'g-notes', label: 'OCR', words: 'Changed frames only', choices: OCR, active: 0 })),
    specimen('Open: a long one found by typing', menuButton({ id: 'g-zone', label: 'Time zone', words: 'Lisbon · GMT+1',
      find: 'Find a time zone', active: 1, choices: choices(['London · GMT+1', 'Lisbon · GMT+1', 'Madrid · GMT+2', 'New York · GMT−4'], 1, 1) })),
    specimen('Open: Range, a date last', menuButton({ id: 'g-range', label: 'Range', words: 'All time', active: 0,
      choices: choices(['All time', 'Last 5 years', 'Last year', 'Last 90 days', 'From now on'], 0, 0,
        ['', '', '', '', 'Nothing from before you connect']), date: { label: 'A date…', value: '', attrs: {} } })),
  ].join('') + '</div>'),
  group('Tip', () => '<div class="gallery__buttons">' + [
    specimen('After a label that needs explaining; hovered or focused, its sentence', `<span class="gallery__tip">${tip({ label: 'Precision',
      text: 'Battery saving records where you stay and each move of a few hundred metres, not every street.' })}</span>`),
  ].join('') + '</div>'),
  group('Callout', () => '<div class="gallery__rows">' + [
    specimen('A problem: its shape, the home’s words, its one act', callout({ kind: 'warning', title: 'Couldn’t sync ChatGPT',
      lines: ['Chrome didn’t answer. Lifestream tries again in 4 min.'], acts: button('Try now', { size: 'sm' }) })),
    specimen('An offer: the home’s choice, its first the primary', callout({ kind: 'caution',
      title: 'Another Claude account',
      lines: ['Lifestream reads person-a@example.com. Read person-b@example.com too, or switch Claude back to person-a@example.com in Chrome.'],
      acts: button('Read it too', { variant: 'primary', size: 'sm' }) + button('Not this one', { size: 'sm' }), choice: true })),
    specimen('What connecting takes, its steps numbered', callout({ kind: null, title: 'Takes Sign in, in Chrome',
      steps: ['Sign in to Claude in Chrome, in the profile the Lifestream extension is in.', 'Choose Claude in the extension’s popup.'] })),
    specimen('In a browser: where it is done', callout({ kind: 'idle', title: 'Turned off', note: 'In the Lifestream app on your Mac.' })),
  ].join('') + '</div>'),
  group('AgentCard', () => '<div class="gallery__dialogs">' + [
    specimen('A sign-in: what it will see, the number to pick, two more waiting', signInCard(SIGNIN, { view: SIGNIN.view,
      count: ASKED.asks(3), busy: null, refused: '' })),
    specimen('A pick in flight', signInCard(SIGNIN, { view: SIGNIN.view, count: '', busy: SIGNIN.choices[1] ?? 0, refused: '' })),
    specimen('A pick refused, the request still standing', signInCard(SIGNIN, { view: SIGNIN.view, count: '', busy: null,
      refused: 'Couldn’t reach Lifestream. Try again.' })),
    specimen('A number that was not the page’s', noticeCard('That wasn’t the number on the sign-in page, so Claude '
      + 'can’t read your Lifestream.')),
  ].join('') + '</div>'),
  group('DialogPage', () => '<div class="gallery__dialogs">' + [
    `<div class="gallery__dialog">${dialog({ icon: 'calendar-event', title: 'Calendars', line: 'Google Calendar', close: {},
      back: { label: 'Back to Google Calendar', attrs: {} }, body: section([settingRow({ label: 'Work', end: toggle({ on: true, label: 'Work' }) }),
        settingRow({ label: 'Holidays', dim: true, end: toggle({ on: false, label: 'Holidays' }) }),
        addRow({ placeholder: 'Add a calendar' })]), foot: '' })}</div>`,
  ].join('') + '</div>'),
  group('Spotlight', () => '<div class="gallery__spots">' + [
    specimen('One control lit by a quiet ring, its card below it: the walk’s first step',
      `<div class="gallery__spot" data-gallery-spot="lit"><div class="gallery__spot-page">`
        + `${composer({ attrs: { 'data-gallery-lit': '' } })}</div></div>`),
    specimen('A card with an act of its own: that is its primary, Next secondary beside it',
      `<div class="gallery__spot" data-gallery-spot="act"><div class="gallery__spot-page">`
        + `${composer({ value: 'What has my day looked like so far?', attrs: { 'data-gallery-lit': '' } })}</div></div>`),
    specimen('Nothing to light: no ring, the card at the bottom right, above what would sit under it',
      `<div class="gallery__spot" data-gallery-spot="docked"><div class="gallery__spot-page gallery__spot-page--foot">`
        + `${composer({ attrs: { 'data-gallery-lit': '' } })}</div></div>`),
  ].join('') + '</div>'),
  group('A camera removed: why, and when', () => '<div class="gallery__dialogs">' + [
    `<div class="gallery__dialog">${removePage(GALLERY_CAMERA, REMOVAL, '2026-10-26')}</div>`,
    `<div class="gallery__dialog">${removePage(GALLERY_CAMERA, { ...REMOVAL, when: 'day', stopped: '2026-03-03' }, '2026-10-26')}</div>`,
    `<div class="gallery__dialog">${removePage(GALLERY_CAMERA, { ...REMOVAL, why: 'never', when: '' }, '2026-10-26')}</div>`,
  ].join('') + '</div>'),
  group('ChoiceRows', () => '<div class="gallery__rows">' + [
    specimen('Nothing picked yet: Tab enters on the first', choiceRows(WHY)),
    specimen('One picked: its mark filled', choiceRows({ ...WHY, picked: 'stopped' })),
    specimen('The other picked', choiceRows({ ...WHY, picked: 'never' })),
    specimen('What a row carries at its end', choiceRows({ label: 'When did you stop?', picked: 'last', choices: [
      { value: 'last', title: 'After its last photo', end: '27 Sep 2026' }, { value: 'day', title: 'On another day' }] })),
  ].join('') + '</div>'),
  group('SearchField', () => '<div class="gallery__buttons">' + [
    specimen('Outlined, its key hint', searchField({ placeholder: 'Search connectors', shortcut: '/', outlined: true })),
    specimen('Outlined, waiting: nothing to search yet', searchField({ placeholder: 'Search connectors', shortcut: '/',
      outlined: true, waiting: true })),
    specimen('Waiting', searchField({ placeholder: 'Search', shortcut: '⌘K', waiting: true })),
  ].join('') + '</div>'),
  group('Button', () => '<div class="gallery__buttons">' + [
    specimen('Primary, its icon and its shortcut', button('Add connector', { variant: 'primary', icon: 'add', key: '⌘N' })),
    specimen('Secondary, its shortcut', button('Open day', { key: '⌘O' })),
    specimen('Plain, its shortcut', button('Copy', { variant: 'plain', key: '⌘C' })),
    specimen('Link: an act that reads as words, underlined, with no frame', button('Get the app', { variant: 'link' })),
    specimen('Busy, its shortcut: the same button, a spinner inside, a step lighter', button('Add connector',
      { variant: 'primary', icon: 'add', key: '⌘N', busy: true })),
    specimen('Busy, secondary', button('Allow', { busy: true })),
    specimen('Done: “✓ Saved” on the button that did it, its size kept, until it goes back', button('Save', { variant: 'primary', done: 'Saved' })),
    specimen('Done, secondary', button('Save', { done: 'Saved' })),
    specimen('Secondary, its icon and its shortcut', button('New conversation', { icon: 'add', key: '⌘N' })),
  ].join('') + '</div>'),
  group('Views', () => '<div class="gallery__buttons">' + specimen('Connected current', views({ label: 'Connectors',
    value: 'connected', options: [
      { id: 'connected', label: 'Connected', count: 9, attrs: {} },
      { id: 'more', label: 'Add more', count: 2, attrs: {} },
    ] }))
    + reading('Counts not read yet: bars, the current one unfilled', views({ label: 'Connectors', value: 'connected',
      options: [
        { id: 'connected', label: 'Connected', count: null, attrs: {} },
        { id: 'more', label: 'Add more', count: null, attrs: {} },
      ] })) + '</div>'),
  group('Tabs', () => '<div class="gallery__buttons">' + specimen('Overview shown, LLM processing needs you', tabs({ label: 'WhatsApp',
    id: 'gallery-tabs-a', value: 'overview', items: [
      { id: 'overview', label: 'Overview', attrs: {} },
      { id: 'settings', label: 'Settings', attrs: {} },
      { id: 'processing', label: 'LLM processing', dot: true, attrs: {} },
      { id: 'backfill', label: 'Backfill', attrs: {} },
    ] }))
    + specimen('Settings shown', tabs({ label: 'Gmail', id: 'gallery-tabs-b', value: 'settings', items: [
      { id: 'overview', label: 'Overview', attrs: {} },
      { id: 'settings', label: 'Settings', attrs: {} },
      { id: 'processing', label: 'LLM processing', attrs: {} },
    ] })) + '</div>'),
  group('ConnectorRow', () => '<div class="gallery__rows">' + [
    ...STATES.flatMap(state => ROWS[state] ? [specimen(state, connectorRow(ROWS[state]))] : []),
    specimen('broken · the home’s act at its end', ROWS.broken ? connectorRow({ ...ROWS.broken,
      act: { label: TRY, busy: false, attrs: {} } }) : ''),
    specimen('Selected · its dialog open', ROWS.ok ? connectorRow({ ...ROWS.ok, selected: true }) : ''),
    specimen('Hover', ROWS.ok ? connectorRow({ ...ROWS.ok, forced: 'hover' }) : ''),
    specimen('Keyboard focus', ROWS.waiting ? connectorRow({ ...ROWS.waiting, forced: 'focus' }) : ''),
    reading('Not read yet · first of its list', connectorRowReading(0)),
    reading('Not read yet · third of its list', connectorRowReading(2)),
    reading('Not read yet · led by a face, as People’s rows', connectorRowReading(1, 'face')),
    reading('Not read yet · bare, as Places’ and Trips’ rows', connectorRowReading(3, 'none')),
  ].join('') + '</div>'),
  group('ConnectorLine · the Connectors page’s row: icon, name and line, where, one end', () => '<div class="gallery__rows">'
    + specimen('Each end: the last time, a state word, the home’s act, Connect; hover, selected, focus; not read yet', connectorLines([
      { name: 'Kinds', count: 7, rows: [
        connectorLine({ name: 'iMessage', icon: 'message', line: '214 messages today', place: 'Mac', set_up: true, end: { last: '09:41' },
          opens: open('imessage') }),
        connectorLine({ name: 'Gmail', icon: 'mail', line: 'Gmail allows more at 05:30', place: 'Online', set_up: true,
          end: { state: 'waiting', word: 'Waiting' }, opens: open('gmail'), forced: 'hover' }),
        connectorLine({ name: 'GitHub', icon: 'github', line: 'Couldn’t read GitHub · tries again 10:00', place: 'Online', set_up: true,
          end: { act: { label: TRY, busy: false, attrs: {} } }, opens: open('github') }),
        connectorLine({ name: 'Location', icon: 'location', line: 'Allow Location on your iPhone', place: 'iPhone', set_up: true,
          end: { state: 'needs-you', word: 'Needs you' }, opens: open('location'), selected: true }),
        connectorLine({ name: 'WhatsApp', icon: 'message', line: 'Nothing new since Mon', place: 'Mac', set_up: true,
          end: { state: 'broken', word: 'Stopped' }, opens: open('whatsapp'), forced: 'focus' }),
        connectorLine({ name: SETUP.name, icon: SETUP.icon, line: SETUP.gives, place: 'Online', set_up: false,
          end: { connect: PAGE.connect }, opens: open(SETUP.id) }),
        connectorLineReading(2),
      ].join('') }], PAGE.title)) + '</div>'),
  group('StatusStrip · in a page: a stream that needs you, its act at its end; the colour the mark’s alone', () => '<div class="gallery__stack">' + [
    ...NEEDS.map(need => specimen(need.weight === 'stopped' ? 'Stopped: red mark, soft red ground, no ×' : 'Advice: yellow mark, page ground, ×', statusStrip(need))),
    specimen('Waiting: its ring turning, no act', statusStrip({ tone: 'waiting', title: 'Photos is waiting', line: 'Waiting for Wi‑Fi' })),
    specimen('Done', statusStrip({ tone: 'done', title: 'Lifestream is back', line: '64 GB free' })),
    specimen('No alert: the imports’ invitation, its icon in the mark’s place', statusStrip({ icon: 'archive',
      title: 'Bring in your past: your Google Takeout and your Spotify export', actions: [{ label: 'Show me', attrs: {} }],
      close: { label: 'Close', attrs: {} } })),
    specimen('Busy: the act pressed, its size kept', statusStrip({ ...NEEDS[1], actions: [{ label: 'Try now', busy: true, attrs: {} }] })),
    specimen('Its act not landed: said in place, in its line', statusStrip({ ...NEEDS[1],
      said: inPlaceLine('GitHub didn’t answer', { retry: {} }) })),
  ].join('') + '</div>'),
  group('Severity · the shape alone, at 14: stopped, needs you, waiting, done', () => '<div class="gallery__buttons">'
    + ['warning', 'caution', 'waiting', 'done'].map(kind => specimen(kind,
      signalShape(/** @type {import('./ui/kit/signal.js').SignalKind} */ (kind), { size: 14 })
      + signalShape(/** @type {import('./ui/kit/signal.js').SignalKind} */ (kind), { size: 18 }))).join('') + '</div>'),
  group('Skeleton', () => '<div class="gallery__rows">' + [
    reading('Bars, widths 1–8, in mac-headline', [1, 2, 3, 4, 5, 6, 7, 8].map(width =>
      `<p class="mac-headline">${bar(/** @type {import('./ui/kit/skeleton.js').BarWidth} */ (width))}</p>`).join('')),
    reading('A bar in mac-mono-data, its line kept: beside the read line', '<p class="gallery__pair">'
      + `<span class="mac-mono-data">${bar(6)}</span><span class="mac-mono-data">1,204 messages today</span></p>`),
    reading('An icon in its 36 slot', `<span class="gallery__slot">${iconSquare()}</span>`),
    reading('An avatar in its own circle, beside the one read', '<p class="gallery__pair">'
      + `<span class="gallery__slot gallery__slot--avatar">${avatar()}</span>${monogram('Person A')}</p>`),
    reading('A free shape: a bubble', shape({ className: 'gallery__bubble' })),
    reading('Lines of a body not read yet', lines(3)),
    reading('A section label not read yet', sectionLabelReading(6)),
  ].join('') + '</div>'),
  group('FigureStrip', () => '<div class="gallery__rows">' + [
    specimen('Read', figureStrip([{ value: '2', label: 'Places' }, { value: '3', label: 'People' },
      { value: '5 h 50 m', label: 'Asleep' }])),
    reading('Not read yet: three figures', figureStripReading(3)),
  ].join('') + '</div>'),
  group('Thread', () => '<div class="gallery__rows">' + [
    specimen('Read', thread([
      { n: 1, at: 0, clock: '08:00', speaker: 'Person A', mine: false, words: 'synthetic hello one' },
      { n: 2, at: 60_000, clock: '08:01', speaker: 'You', mine: true, words: 'synthetic reply two' },
      { n: 3, at: 90_000, clock: '08:01', speaker: 'Person A', mine: false, words: '',
        voice: { audio: `sha256:${'1'.repeat(64)}`, seconds: 23, words: 'synthetic voice note words' } },
      { n: 4, at: 120_000, clock: '08:02', speaker: 'You', mine: true, words: '', voice: { audio: null, seconds: 7, words: '' } },
    ])),
    reading('Not read yet: its bubbles, theirs and the person’s', threadReading()),
  ].join('') + '</div>'),
  wants('Streams · LLM', 'Settings · AI', 'Settings · Subscriptions', 'Made') ? llm() : '',
  wants('Settings · Privacy', 'Streams · the privacy') ? privacyPages() : '',
  wants('Agent access', 'Agents') ? accessGallery() : '',
  wants('Settings') ? settings() : '',
  wants('Settings') ? settingsPages() : '',
  wants('Settings · Storage', 'Storage') ? storagePages() : '',
  group('Inspector · while its moment is read', () => '<div class="gallery__rows">' + [
    reading('Opened from a row: its icon, title and meta line at once',
      `<div class="gallery__inspector">${inspectorReading({ head: { icon: 'message', title: 'Person A',
        meta: 'WhatsApp · 2 messages' }, tools: button('Open day', { variant: 'plain', size: 'sm', icon: 'days',
        className: 'is-end' }), close: {} })}</div>`),
    reading('Opened from a link that knew nothing of it: the tile empty, the head bars',
      `<div class="gallery__inspector">${inspectorReading({ close: {} })}</div>`),
  ].join('') + '</div>'),
  group('WeekFigure', () => '<div class="gallery__rows">' + [
    specimen('At rest, today', weekFigure({ today: 1204, noun: MESSAGES, last: 'Last sent 11:58', week: WEEK,
      end: TODAY })),
    specimen('Friday hovered', weekFigure({ today: 1204, noun: MESSAGES, last: 'Last sent 11:58', week: WEEK,
      end: TODAY, lit: 1 })),
    specimen('A week of none', weekFigure({ today: 0, noun: null, last: 'Nothing yet', week: [0, 0, 0, 0, 0, 0, 0],
      end: TODAY })),
    specimen('Still counted: the amount and its words skeletons, a low column a day, the line and the days words',
      weekFigure({ today: null, noun: MESSAGES, last: 'Last sent 11:58', week: null, end: TODAY })),
    specimen('A history in weeks: the busiest marked, the two ends named', weekFigure({ amount: '2,193',
      words: 'messages · 30 days', line: 'Since May 2020', label: 'Messages by week', marked: 9,
      bars: HISTORY_WEEKS.map((count, at) => ({ count, words: `messages · week ${at + 1}`, spoken: `Week ${at + 1}, ${count} messages` })),
      ends: ['6 Jul', 'This week'] })),
    specimen('A history in years, each named, the present under them', weekFigure({ amount: '18,082',
      words: 'messages since Jun 2020', label: 'Messages by year', marked: 1,
      bars: HISTORY_YEARS.map(([year, count]) => ({ count, words: `messages · ${year}`, spoken: `${year}, ${count} messages` })),
      labels: HISTORY_YEARS.map(([year]) => year), foot: '2 in the last 30 days · before that, 6 Aug' })),
    specimen('A history while it is read: the amount a skeleton, a low column a bar, its words standing',
      weekFigure({ amount: null, words: 'messages · 30 days', label: 'Messages by week',
        bars: HISTORY_WEEKS.map(() => ({ count: 0, words: '', spoken: '' })), ends: ['', 'This week'] })),
  ].join('') + '</div>'),
].join('')));
for (const picture of main.querySelectorAll('img[loading="lazy"]')) picture.setAttribute('loading', 'eager');
applyGeometry(main);
drawDaysSide(main);
sizeRuns(main);
liveMoveAndScale(main);
installCardGrid(main);
installFilterMenus(main, () => undefined);
installSettings(main);
installLights(main);
installAreaCharts(main);
installWeekFigure(main);
installAsk(main, { send: () => undefined, stop: () => undefined });
for (const frame of main.querySelectorAll('[data-gallery-spot]')) {
  const holder = /** @type {HTMLElement} */ (frame);
  const face = holder.dataset.gallerySpot;
  const composed = holder.querySelector('[data-gallery-lit]');
  const spot = spotlight(holder, { framed: true, lead: () => undefined, forward: () => undefined, back: () => undefined,
    leave: () => undefined,
    bounds: () => ({ top: 0, left: 0, right: holder.clientWidth, bottom: holder.clientHeight }) });
  if (face === 'lit') {
    spot.show(composed, { ...TOUR_WORDS.devices, lead: 'Next', aside: 'Skip tour' });
  } else if (face === 'act') {
    spot.show(composed, { ...TOUR_WORDS.ask, lead: 'Send', icon: 'send', pass: TOUR_NOT_NOW, aside: 'Skip tour' });
  } else {
    spot.show(null, { ...TOUR_WORDS.people, lead: 'Done' }, { clears: composed ? [composed] : [] });
  }
}
for (const thread of main.querySelectorAll('.gallery__ask-scroll')) {
  const end = new ResizeObserver(() => { thread.scrollTop = thread.scrollHeight; });
  end.observe(thread);
  end.observe(/** @type {Element} */ (thread.firstElementChild));
  for (const kind of ['wheel', 'pointerdown']) thread.addEventListener(kind, () => end.disconnect(), { once: true });
}
/** @type {HTMLElement | null} */ (main.querySelector('[data-gallery-focus] textarea'))?.focus({ preventScroll: true });
main.dataset.galleryReady = '1';
