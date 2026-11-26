// @ts-check
/** @import { OutboundList, OutboundOne, OutboundRow, PrivacyRead, StreamsReport } from './types.js' */
import FIXTURE_PRIVACY from '../../homelink/Tests/Fixtures/privacy.json' with { type: 'json' };
import { esc } from './lib/html.js';
import { askQuestion, askTurn, askWaiting, sectionLabel } from './ui/kit/index.js';
import { sentFact } from './lib/sent.js';
import { REPORT } from './kit-gallery-report.js';

const HOME = /** @type {Record<'fresh' | 'downloading' | 'ready', PrivacyRead>} */ (/** @type {unknown} */ (FIXTURE_PRIVACY));

const NO_NAMES = 'Waiting for People to list the names of your people';

const RUNNER = 'runner-macbook-pro-0001';

const HIDING = `runner:${RUNNER}/privacy-filter`;

/** @type {Record<'fresh' | 'people' | 'downloading' | 'marking' | 'absent' | 'none', PrivacyRead>} */
export const PRIVACY = {
  fresh: HOME.fresh,
  people: { ...HOME.fresh, ready: false, line: NO_NAMES },
  downloading: HOME.downloading,
  marking: { ...HOME.ready, level: 'all', chat: 'all', links: 'tokens', always: ['synthetic-word', 'example-code', 'Project Synthetic'] },
  absent: { ...HOME.downloading,
    detector: { model: HIDING, file: HOME.downloading.detector.file, state: 'absent', line: 'Hiding model on MacBook Pro: the download stopped: this Mac has 2 GB free.' } },
  none: HOME.ready,
};

const TODAY = HOME.downloading.today[0]?.day ?? '2026-11-12';

/**
 * @param {Partial<OutboundRow>} row
 * @returns {OutboundRow}
 */
const rowOf = row => ({ seq: 1, at_ms: Date.parse(`${TODAY}T09:14:00Z`), day: TODAY, receiver: 'OpenAI', route: 'codex:gpt-5.5',
  by: null, what: 'ask', tool: null, level: 'all', counts: {}, chars: 0, pictures: 0, detector: null, key: null, attempt: null, refs: 0, ...row });

/** @type {OutboundList} */
export const OUTBOUND_DAYS_READ = {
  rows: [],
  more: false,
  totals: [
    ...HOME.downloading.today,
    { receiver: 'OpenAI', day: '2026-11-11', items: 388, hidden: 3104, counts: { person: 1800, phone: 704, face: 600 }, rows: { ask: 388 } },
    { receiver: 'Anthropic', day: '2026-11-11', items: 6, hidden: 41, counts: { person: 30, email: 11 }, rows: { read: 6 } },
    { receiver: 'OpenAI', day: '2026-11-09', items: 1, hidden: 14, counts: { person: 9, 'number.bank': 5 }, rows: { ask: 1 } },
  ],
};

/** @type {OutboundList} */
export const OUTBOUND_PAGE = {
  more: false,
  totals: HOME.downloading.today,
  rows: [
    rowOf({ seq: 412, at_ms: Date.parse(`${TODAY}T09:14:00Z`), counts: { person: 3, face: 2, 'number.order': 2 }, chars: 1840, pictures: 1,
      key: 'sha256:example-request', attempt: 1, refs: 1 }),
    rowOf({ seq: 411, at_ms: Date.parse(`${TODAY}T09:02:00Z`), what: 'read', tool: 'search', route: 'codex:gpt-5.5', by: 'p-00000001',
      counts: { person: 12, phone: 1 }, chars: 6200, refs: 8 }),
    rowOf({ seq: 410, at_ms: Date.parse(`${TODAY}T08:40:00Z`), what: 'link', route: null, level: 'none', chars: 48 }),
    rowOf({ seq: 409, at_ms: Date.parse(`${TODAY}T08:31:00Z`), what: 'text', counts: {}, chars: 220 }),
  ],
};

/** @type {OutboundOne} */
export const SENT = {
  ...rowOf({ seq: 412, at_ms: Date.parse(`${TODAY}T09:14:00Z`), counts: { person: 3, face: 2, 'number.order': 2 }, chars: 1840, pictures: 1,
    key: 'sha256:example-request', attempt: 1 }),
  refs: [{ source: 'apple-photos:synthetic', kind: 'photo', key: 'photo-0001' }],
  sent: { body: JSON.stringify({ model: 'gpt-5.5', input: [{ role: 'user', content: 'Describe this photo. [[Person 1]] and '
    + '[[Person 2]] stand at a counter; the receipt reads order [[Number 1]].' }] }), pictures: [{ recipe: 'faces covered' }] },
};

/** @type {OutboundOne} */
export const SENT_ERASED = { ...SENT, sent: null };

/** @type {OutboundOne} */
export const SENT_MODEL = { ...SENT, detector: RUNNER };

/** @type {StreamsReport} */
export const WAITING_REPORT = { ...REPORT, connectors: REPORT.connectors.map(connector => connector.id !== 'whatsapp' || !connector.processing
  ? connector : { ...connector, processing: { rows: connector.processing.rows.map(row => row.privacy
    ? { ...row, shape: /** @type {const} */ ('waiting'), line: NO_NAMES, privacy: { ...row.privacy, waiting: true } } : row) } }) };

/** @param {string} label @param {string} html */
const specimen = (label, html) => `<div class="gallery__specimen"><p class="gallery__label mac-mono-label">${esc(label)}</p>${html}</div>`;

export const privacyLines = () => `<section class="gallery__group">${sectionLabel('Chat and one item · hiding')}`
  + '<div class="gallery__rows">'
  + specimen('Chat waiting on hiding: the line opens Settings › Privacy', `<div class="gallery__ask">${askTurn({
    question: askQuestion('What did Person A say about the trip?', { at: '12 Nov · 09:14', edit: {} }),
    steps: askWaiting(NO_NAMES, { 'data-ask-action': 'hiding' }) })}</div>`)
  + specimen('One item’s facts: where it went and what was hidden', `<p class="mac-body">${esc(sentFact(OUTBOUND_PAGE.rows[0], PRIVACY.fresh.types, 2026))}</p>`)
  + specimen('One item’s facts: sent as it was', `<p class="mac-body">${esc(sentFact(OUTBOUND_PAGE.rows[2], PRIVACY.fresh.types, 2026))}</p>`)
  + '</div></section>';
