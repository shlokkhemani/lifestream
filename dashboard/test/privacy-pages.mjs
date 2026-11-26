import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOST_STATE, REPORT } from '../public/kit-gallery-report.js';
import READER from '../../homelink/Tests/Fixtures/agents/door/reader-agent.json' with { type: 'json' };
import { agentDetail, NO_AGENT_READS, whenWords } from '../public/ui/agents/detail.js';
import { MODELS } from '../public/kit-gallery-llm.js';
import { OUTBOUND_DAYS_READ, OUTBOUND_PAGE, PRIVACY, SENT, SENT_ERASED, SENT_MODEL, WAITING_REPORT } from '../public/kit-gallery-privacy.js';
import { detailOf, OPENED } from '../public/ui/connectors/dialog.js';
import { detailMarkup } from '../public/ui/connectors/detail.js';
import { NO_PRIVACY, pagesAt, SETTINGS_MODELS, SETTINGS_PRIVACY, settingsAt, settingsDetail } from '../public/ui/connectors/settings.js';
import { SETTINGS_INDEX } from '../public/settings-index.js';
import { CHOICE_BUSY, CHOICES, CHOSEN_BY_DEFAULT, choiceAct, choiceOf, outboundAt, outboundPageOf } from '../public/ui/connectors/settings-privacy.js';
import { keyOf, movesPrivacy, pendingOf } from '../public/ui/connectors/pending.js';
import { LACKS } from '../public/ui/connectors/changes.js';
import { hiddenWords, sentFact, sentHref } from '../public/lib/sent.js';
import { installClock, today as todayNow } from '../public/lib/home-clock.js';
import { clockFor } from './stand-ins/clock.mjs';
import { AT_REST } from '../public/ui/connectors/view.js';
import { NO_CHANGES, partsOf, SCRAMBLE_BUSY, scrambleAct } from '../public/ui/onboarding/view.js';
import { sessionOf } from '../public/ui/flows/model.js';
import { privacyRoutes } from '../lib/routes/privacy.mjs';

/** @typedef {import('../public/ui/connectors/dialog.js').Detail} Detail */
/** @typedef {import('../public/lib/host.js').HostState} HostState */

const RUNNER = `runner-${HOST_STATE.unit}`;
const FILE = /** @type {string} */ (PRIVACY.fresh.detector.file);
const HIDING = `runner:${RUNNER}/${FILE}`;
/** @param {import('../public/types.js').PrivacyRead} read @returns {import('../public/types.js').PrivacyRead} */
const picked = read => ({ ...read, detector: { ...read.detector, model: read.detector.state === 'off' ? null : read.detector.model ?? HIDING } });
const TYPES = PRIVACY.fresh.types;
const READS = { ...NO_PRIVACY, read: PRIVACY.fresh, days: OUTBOUND_DAYS_READ, page: OUTBOUND_PAGE, row: SENT };

/**
 * @param {string} id
 * @param {{ state?: HostState | null, privacy?: typeof NO_PRIVACY, opened?: Partial<typeof OPENED>, models?: import('../public/pages.js').Models | null }} [read]
 */
const at = (id, { state = HOST_STATE, privacy = READS, opened = {}, models = MODELS } = {}) => /** @type {Detail} */ (settingsDetail({
  report: REPORT, models, failed: '', state, id, opened: { ...OPENED, ...opened }, subscriptions: null, privacy }));
/** @param {Detail} detail */
const rowsOf = detail => detail.parts.flatMap(part => part.panel?.rows ?? []);
/**
 * @param {Detail} detail
 * @param {string} label
 */
const rowOf = (detail, label) => rowsOf(detail).find(row => row.label === label);
/**
 * @param {Detail} detail
 * @returns {any[]}
 */
const actsOf = detail => [...detailMarkup(detail, AT_REST).matchAll(/data-cn-do="([^"]*)"/gu)]
  .map(match => JSON.parse(match[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&#39;', '\'')));
/** @param {Detail} detail */
const hostActs = detail => actsOf(detail).flatMap(each => 'host' in each ? [each.host] : []);
/** @param {unknown} words */
installClock(clockFor('UTC', 4));
const plain = words => String(words).replace(/\s/gu, ' ');
/** @param {any} row */
const menuOf = row => row?.end?.menu;

test('V1: Privacy beside AI models, its route at its top; two choices, the second the default, each the level it writes', () => {
  const models = SETTINGS_INDEX.mac.find(group => group.entries.some(page => page.id === 'models'));
  assert.deepEqual(models?.entries.map(page => page.id).slice(0, 2), ['models', 'privacy']);
  assert.equal(SETTINGS_PRIVACY, 'settings/privacy');
  assert.deepEqual(settingsAt(SETTINGS_PRIVACY), { page: 'privacy', row: '' });
  assert.deepEqual(CHOICES.map(choice => choice.id), ['none', 'known'], 'the hiding model is AI models\' Hiding details');
  assert.equal(CHOSEN_BY_DEFAULT, 'known');
  assert.equal(choiceOf(PRIVACY.fresh), 'known', 'a new home hides what it knows');
  assert.equal(choiceOf(picked(PRIVACY.downloading)), 'known');
  assert.equal(choiceOf(PRIVACY.none), 'none');
  const menu = menuOf(rowOf(at(SETTINGS_PRIVACY), 'Hide personal details'));
  assert.deepEqual(menu.choices.map((/** @type {any} */ choice) => [choice.words, choice.chosen, choice.default]),
    [['Don’t hide', false, false], ['Hide what Lifestream knows', true, true]]);
  assert.deepEqual(menu.choices.map((/** @type {any} */ choice) => choice.do), CHOICES.map(choice => ({ host: choiceAct(choice.id) })));
  assert.deepEqual(choiceAct('known'), { act: 'home-setting', settings: { 'privacy.level': 'all' } });
  assert.deepEqual(choiceAct('none'), { act: 'home-setting', settings: { 'privacy.level': 'none' } });
  assert.equal(menu.busy, CHOICE_BUSY);
  const ends = rowsOf(at(SETTINGS_PRIVACY, { privacy: { ...READS, read: PRIVACY.marking } })).map(row => /** @type {any} */ (row.end));
  const writes = ends.flatMap(end => [...end?.menu?.choices ?? [], ...end?.acts ?? []]).flatMap(each => each.do?.host ? [each.do.host] : [])
    .filter(act => act.act === 'home-setting');
  assert.ok(writes.length >= 8, 'the choices, Chat’s levels and Links’ ways');
  assert.ok(writes.every(act => 'settings' in act && !('key' in act)), 'privacy writes in one body');
  assert.ok(writes.every(act => !('privacy.detector' in act.settings)), 'no detector key: it is model.defaults.hiding');
  assert.equal(new Set(CHOICES.map(choice => keyOf(choiceAct(choice.id)))).size, 1, 'every choice waits on one change');
  assert.equal(movesPrivacy(choiceAct('known'), FILE), true, 'hiding’s state read after it');
  assert.deepEqual(menu.choices.map((/** @type {any} */ choice) => choice.note), CHOICES.map(choice => choice.line));
});

test('V2: the hiding model’s row: the pick AI models names, its download as the privacy read says, Change opening AI models', () => {
  const row = (/** @type {import('../public/types.js').PrivacyRead} */ read, models = /** @type {any} */ (null)) => /** @type {any} */ (rowOf(
    at(SETTINGS_PRIVACY, { privacy: { ...READS, read }, models }), 'Hiding model'));
  const hiding = /** @type {import('../public/pages.js').ModelUse} */ (MODELS.uses.find(use => use.use === 'hiding'));
  const named = row(PRIVACY.fresh, MODELS);
  assert.deepEqual([named.end.words, named.end.acts.map((/** @type {any} */ act) => [act.label, act.do])],
    [hiding.words, [['Choose', { open: SETTINGS_MODELS }]]], 'the home\'s words of the pick, made on AI models');
  const fresh = row(PRIVACY.fresh);
  assert.equal(fresh.end.words, 'Off');
  assert.equal(fresh.progress, null);
  const downloading = row(picked(PRIVACY.downloading));
  assert.deepEqual([downloading.end.words, downloading.end.done], ['Downloading', false]);
  assert.deepEqual(downloading.end.acts.map((/** @type {any} */ act) => [act.label, act.do]), [['Change', { open: SETTINGS_MODELS }]]);
  assert.equal(downloading.progress.words, '340 of 900 MB');
  const marking = row(PRIVACY.marking);
  assert.deepEqual([marking.end.words, marking.end.done], ['Downloaded', true]);
  assert.equal(marking.progress.words, 'Marked 41% of your record');
  const absent = row(picked(PRIVACY.absent));
  assert.equal(absent.signal, 'caution');
  assert.match(absent.line, /download stopped/u);
  assert.equal(row(PRIVACY.none).end.words, 'Downloaded', 'there with nothing hidden');
  assert.deepEqual(hostActs(at(SETTINGS_PRIVACY, { privacy: { ...READS, read: picked(PRIVACY.absent) } }))
    .filter(act => act.act === 'models'), [], 'no file act: a picked hiding model downloads by itself');
  const pick = /** @type {const} */ ({ act: 'models', do: 'default', use: 'hiding', model: HIDING });
  assert.equal(movesPrivacy(pick, FILE), true, 'AI models\' pick reads hiding\'s state again');
  assert.equal(movesPrivacy({ ...pick, use: 'search' }, FILE), false);
  const fetch = /** @type {const} */ ({ act: 'models', do: 'file', runner: RUNNER, id: FILE, to: 'fetch' });
  assert.equal(movesPrivacy(fetch, FILE), true);
  assert.equal(movesPrivacy({ ...fetch, id: 'another-file' }, FILE), false);
  assert.equal(pendingOf(fetch, { report: null, models: MODELS, hiding: FILE }), null);
  assert.equal(/** @type {any} */ (pendingOf(fetch, { report: null, models: MODELS, hiding: null }))?.source, 'models', 'unknown, it is any file');
});

test('V3: in a browser and away from the home, words alone; reading, then why a read failed', () => {
  const ELSEWHERE = { ...HOST_STATE, folder: null };
  for (const state of [null, ELSEWHERE]) {
    const detail = at(SETTINGS_PRIVACY, { state });
    assert.deepEqual(hostActs(detail), [], `${state ? 'away' : 'browser'}: no act on the home`);
    assert.equal(rowOf(detail, 'Hide personal details')?.end && 'words' in /** @type {any} */ (rowOf(detail, 'Hide personal details')?.end), true);
  }
  assert.equal(at(SETTINGS_PRIVACY, { privacy: NO_PRIVACY }).reading, true);
  const failed = at(SETTINGS_PRIVACY, { privacy: { ...NO_PRIVACY, drawn: { kind: 'lack', words: null, retry: true } } });
  assert.equal(failed.reading, false);
  assert.ok(detailMarkup(failed, AT_REST).includes(LACKS.privacy));
  assert.ok(actsOf(failed).some(act => act.reread === 'privacy'), 'Try again reads hiding\'s state again');
  assert.ok(at(SETTINGS_PRIVACY).parts.some(part => part.label === 'What hiding can’t do' && (part.list?.length ?? 0) > 0));
});

test('V4: a list’s page sends the whole list, none as null, a word listed once', () => {
  const privacy = { ...READS, read: PRIVACY.marking };
  const page = at(SETTINGS_PRIVACY, { privacy, opened: { pages: ['list:privacy.always'] } });
  const words = PRIVACY.marking.always;
  assert.deepEqual(rowsOf(page).map(row => row.label), words);
  assert.deepEqual(/** @type {any} */ (rowsOf(page)[0].end).acts[0].do,
    { host: { act: 'home-setting', settings: { 'privacy.always': words.slice(1) } } });
  const typed = at(SETTINGS_PRIVACY, { privacy, opened: { pages: ['list:privacy.always'], typed: 'another-word' } });
  assert.deepEqual(typed.parts[0].panel?.add?.enter, { host: { act: 'home-setting', settings: { 'privacy.always': [...words, 'another-word'] } } });
  const again = at(SETTINGS_PRIVACY, { privacy, opened: { pages: ['list:privacy.always'], typed: words[0].toUpperCase() } });
  assert.equal(again.parts[0].panel?.add?.enter, null);
  const one = at(SETTINGS_PRIVACY, { privacy: { ...privacy, read: { ...PRIVACY.marking, always: ['only-word'] } },
    opened: { pages: ['list:privacy.always'] } });
  assert.deepEqual(/** @type {any} */ (rowsOf(one)[0].end).acts[0].do, { host: { act: 'home-setting', settings: { 'privacy.always': null } } });
});

test('V5: what left Lifestream, a day’s rows, what one ask sent', () => {
  const detail = at(SETTINGS_PRIVACY, { privacy: { ...READS, read: { ...PRIVACY.downloading,
    today: PRIVACY.downloading.today.map(total => ({ ...total, day: todayNow() })) } } });
  const today = detail.parts.find(part => part.label === 'What left Lifestream today');
  assert.ok(today && (today.panel?.rows.length ?? 0) > 0, 'a row per receiver today');
  for (const row of today?.panel?.rows ?? []) assert.match(String(/** @type {any} */ (row.end).acts[0].do.page), /^outbound:\d{4}-\d{2}-\d{2}:/u);
  const earlier = /** @type {any} */ (detail.parts.find(part => part.label === 'Earlier'));
  const pages = earlier.panel.rows.map((/** @type {any} */ row) => row.end.acts[0].do.page);
  assert.deepEqual(pages, [...pages].sort().reverse(), 'newest first');

  const day = at(SETTINGS_PRIVACY, { opened: { pages: [`outbound:${OUTBOUND_PAGE.rows[0].day}:OpenAI`] } });
  assert.equal(day.name, 'OpenAI');
  for (const receiver of ['[2001:db8::5]', 'Claude: work', '']) {
    assert.deepEqual(outboundAt(outboundPageOf('2026-11-12', receiver)), { day: '2026-11-12', receiver });
  }
  assert.equal(at(SETTINGS_PRIVACY, { opened: { pages: [outboundPageOf(OUTBOUND_PAGE.rows[0].day, '[2001:db8::5]')] } }).name, '[2001:db8::5]');
  const rows = rowsOf(day);
  assert.equal(rows.length, OUTBOUND_PAGE.rows.length);
  assert.match(plain(rows[0].line), /3 names hidden · 2 faces covered · 2 order numbers hidden/u);
  assert.deepEqual(rows[0].go?.do, { page: `sent:${SENT.seq}` }, 'an ask opens what was sent');
  assert.equal(rows[2].go, null, 'a link opens nothing');
  assert.match(String(rows[2].line), /Sent as it was/u);

  const sent = at(SETTINGS_PRIVACY, { opened: { pages: [`outbound:${SENT.day}:OpenAI`, `sent:${SENT.seq}`] } });
  const body = sent.parts.find(part => part.label === 'What was sent');
  assert.match(String(body?.text), /\[\[Person 1\]\]/u);
  assert.match(detailMarkup(sent, AT_REST), /<pre class="cn-set__text/u);
  const sentRows = (/** @type {import('../public/types.js').OutboundOne} */ row) => rowsOf(at(SETTINGS_PRIVACY, { privacy: { ...READS, row },
    opened: { pages: [`outbound:${SENT.day}:OpenAI`, `sent:${SENT.seq}`] } }));
  const hiddenBy = (/** @type {import('../public/types.js').OutboundOne} */ row) => /** @type {any} */ (sentRows(row)
    .find(each => each.label === 'Hidden by'))?.end.words ?? null;
  assert.equal(hiddenBy(SENT), 'What Lifestream knows');
  assert.equal(hiddenBy(SENT_MODEL), 'The hiding model');
  assert.equal(hiddenBy({ ...SENT, counts: {} }), null, 'nothing hidden, nothing to say of how');
  assert.equal(hiddenBy({ ...SENT, level: 'none', counts: {} }), null, 'sent as it was');
  const when = (/** @type {import('../public/types.js').OutboundOne} */ row) => /** @type {any} */ (sentRows(row)
    .find(each => each.label === 'When'))?.end.words;
  assert.equal(when({ ...SENT, at_ms: Date.UTC(Number(todayNow().slice(0, 4)), 9, 15, 1, 30) }), '15 Oct, 01:30');
  const erased = at(SETTINGS_PRIVACY, { privacy: { ...READS, row: SENT_ERASED },
    opened: { pages: [`outbound:${SENT.day}:OpenAI`, `sent:${SENT.seq}`] } });
  assert.match(detailMarkup(erased, AT_REST), /no longer kept: an erasure took its request/u);
});

test('V6: one level, the access’s: an agent’s dialog offers no level of its own, nothing sends `agent-level`', () => {
  const read = /** @type {import('../public/types.js').AgentRead} */ (READER.answer);
  const reads = { ...NO_AGENT_READS, one: read, editor: { view: read.view, busy: false, note: '', held: false } };
  for (const pages of [[], ['access'], ['hides']]) {
    const detail = agentDetail(`agent:${read.id}`, reads, { state: HOST_STATE, opened: { ...OPENED, pages }, home: true, now: Date.now(),
      when: whenWords(todayNow()) });
    assert.equal(hostActs(detail).some(act => /** @type {string} */ (act.act) === 'agent-level'), false, pages.join('/'));
    assert.equal(rowsOf(detail).some(row => /hides$/u.test(row.label)), false, 'no “What <name> hides”');
  }
});

test('V7: a connector’s privacy line on its work’s page, and its model waiting on hiding opening Settings › Privacy', () => {
  const tab = (/** @type {import('../public/types.js').StreamsReport} */ report) => /** @type {Detail[]} */ ((report.connectors
    .find(each => each.id === 'whatsapp')?.processing?.rows ?? []).filter(row => row.shape !== null)
    .map(row => detailOf(report, HOST_STATE, 'whatsapp', { ...OPENED, pages: [`ai:${row.member}`] })));
  const rows = (/** @type {Detail[]} */ pages) => pages.flatMap(detail => detail.panels.flatMap(panel => panel.rows));
  const work = REPORT.connectors.find(each => each.id === 'whatsapp')?.processing?.rows.find(row => row.privacy) ?? null;
  assert.ok(work?.privacy, 'the fixture’s photos go to a cloud model');
  const line = rows(tab(REPORT)).find(row => row.line === work.privacy.note);
  assert.ok(line, 'its privacy line drawn');
  const opens = (/** @type {Detail[]} */ pages) => rows(pages).filter(row => /** @type {any} */ (row.act)?.open === SETTINGS_PRIVACY);
  const waiting = /** @type {NonNullable<typeof WAITING_REPORT.connectors[number]['processing']>} */ (WAITING_REPORT.connectors
    .find(each => each.id === 'whatsapp')?.processing).rows.find(row => row.privacy?.waiting);
  assert.ok(waiting, 'the fixture’s photos wait on hiding');
  assert.deepEqual(opens(tab(WAITING_REPORT)).map(row => row.line), [waiting.line]);
  assert.deepEqual(opens(tab(REPORT)), [], 'the home says nothing waits on hiding');
  const other = { ...WAITING_REPORT, connectors: WAITING_REPORT.connectors.map(connector => !connector.processing ? connector
    : { ...connector, processing: { rows: connector.processing.rows.map(row => row.privacy ? { ...row, privacy: { ...row.privacy, waiting: false } } : row) } }) };
  assert.deepEqual(opens(tab(other)), []);
});

test('V8: the setup’s ai screen: one switch writes the same privacy setting as Settings, waiting on its read', () => {
  assert.deepEqual(scrambleAct(true), { act: 'home-setting', settings: { 'privacy.level': 'all' } });
  assert.deepEqual(scrambleAct(false), { act: 'home-setting', settings: { 'privacy.level': 'none' } });
  const body = (/** @type {any} */ read, /** @type {string[]} */ busy = []) => partsOf('ai', /** @type {any} */ ({ state: HOST_STATE,
    report: REPORT, privacy: read }), /** @type {any} */ ({ ...sessionOf(true, 'dialog'), picked: new Map(), dialog: null, how: false,
    changes: { ...NO_CHANGES, busy: new Set(busy), privacy: { read, drawn: null, failed: '' } }, nameTyped: null, span: null,
    cost: { read: null, failed: '' }, saved: false, recovery: null,
    drafted: null, redrafted: false, failure: null }), null).body ?? '';
  const scramble = (/** @type {string} */ markup) => /<button([^>]*data-ob="scramble"[^>]*)>/u.exec(markup)?.[1] ?? '';
  assert.match(scramble(body(PRIVACY.fresh)), /aria-checked="true"/u, 'on while privacy hides');
  assert.doesNotMatch(scramble(body(PRIVACY.fresh)), /disabled/u);
  assert.match(scramble(body({ ...PRIVACY.fresh, level: 'none' })), /aria-checked="false"/u);
  assert.match(scramble(body(null)), /disabled/u, 'held until the read');
  assert.match(scramble(body(PRIVACY.fresh, [SCRAMBLE_BUSY])), /disabled/u, 'held while a change goes');
  assert.match(body(PRIVACY.fresh), /Catches <b>74%<\/b> of personal details/u);
});

test('V9: one item’s facts; the routes pass only well-formed parameters', async () => {
  assert.equal(plain(hiddenWords(OUTBOUND_PAGE.rows[0].counts, TYPES)), '3 names hidden · 2 faces covered · 2 order numbers hidden');
  assert.equal(plain(sentFact(OUTBOUND_PAGE.rows[0], TYPES, 2026)),
    'Sent to OpenAI, 12 Nov · 3 names hidden · 2 faces covered · 2 order numbers hidden');
  assert.equal(plain(sentFact(OUTBOUND_PAGE.rows[2], TYPES, 2026)), 'Sent to OpenAI, 12 Nov · sent as it was');
  assert.equal(plain(sentFact({ ...OUTBOUND_PAGE.rows[0], counts: {}, level: 'all' }, TYPES, 2026)), 'Sent to OpenAI, 12 Nov · nothing to hide');
  assert.equal(plain(hiddenWords({ person: 1, 'number.bank': 1, face: 1 }, TYPES)), '1 name hidden · 1 bank number hidden · 1 face covered');
  assert.equal(plain(hiddenWords({ 'number.bank': 2 }, TYPES)), '2 bank numbers hidden');
  const href = sentHref(412);
  const dialog = new URLSearchParams(href.slice(1)).get('dialog') ?? '';
  assert.deepEqual(settingsAt(dialog), { page: 'privacy', row: 'sent:412' });
  assert.deepEqual(pagesAt(dialog), ['sent:412']);
  assert.deepEqual(pagesAt(SETTINGS_PRIVACY), [], 'Privacy alone opens no page inside it');
  assert.equal(at(dialog, { opened: { pages: pagesAt(dialog) } }).name, 'What was sent');
  /** @type {[string, Record<string, string> | undefined][]} */
  const asked = [];
  const door = /** @type {any} */ ({ json: async (/** @type {string} */ path, /** @type {any} */ params) => { asked.push([path, params]); return {}; } });
  const routes = privacyRoutes(door);
  const route = (/** @type {string} */ path) => /** @type {NonNullable<typeof routes[number]>} */ (routes.find(each => each.path === path));
  const call = async (/** @type {string} */ path, /** @type {string} */ query) => /** @type {any} */ (await route(path)
    .handle(/** @type {any} */ ({ url: new URL(`http://127.0.0.1${path}${query}`) })));
  assert.equal((await call('/api/outbound', '?from=yesterday')).status, 400);
  assert.equal((await call('/api/outbound', '?before=0')).status, 400);
  assert.equal((await call('/api/outbound/row', '?seq=../x')).status, 400);
  assert.equal((await call('/api/outbound', '?family=photos')).status, 400, 'an item is its family and item together');
  assert.deepEqual(asked, [], 'nothing malformed reaches the door');
  await call('/api/outbound', '?from=2026-11-01&to=2026-11-12&receiver=OpenAI&before=40');
  await call('/api/outbound/row', '?seq=412');
  await call('/api/outbound', '?family=photos&item=sha256:example');
  await call('/api/privacy', '');
  assert.deepEqual(asked, [['/v1/outbound', { from: '2026-11-01', to: '2026-11-12', receiver: 'OpenAI', before: '40' }],
    ['/v1/outbound/412', undefined], ['/v1/outbound', { family: 'photos', item: 'sha256:example' }], ['/v1/privacy', undefined]]);
  await assert.rejects(async () => privacyRoutes(null)[0].handle(/** @type {any} */ ({ url: new URL('http://127.0.0.1/api/privacy') })),
    (/** @type {any} */ error) => error.status === 503);
});

test('V10: hiding\'s read that met the door gone reads on, asks the Mac one probe and is read again once the home answers; one the home failed at or refused says its own words', async t => {
  class Feed {
    static CLOSED = 2;
    readyState = 1;
    addEventListener() {}
    close() {}
  }
  const at = /** @type {any} */ (globalThis);
  const before = { EventSource: at.EventSource, MutationObserver: at.MutationObserver, document: at.document, window: at.window,
    fetch: at.fetch };
  Object.assign(at, { EventSource: Feed, MutationObserver: class { observe() {} disconnect() {} },
    document: { visibilityState: 'visible', hidden: false, addEventListener() {} }, window: { addEventListener() {} } });
  t.after(() => Object.assign(at, before));
  const answers = ['gone', 'read', 'failed', 'refused'];
  const REFUSED = 'Lifestream refused a parameter (BAD_PARAM).';
  at.fetch = async (/** @type {string} */ path) => {
    assert.equal(path, 'api/privacy');
    const answer = answers.shift();
    if (answer === 'gone') return new Response(JSON.stringify({ error: 'Can\'t reach Lifestream.', code: 'GONE' }), { status: 503 });
    if (answer === 'failed') return new Response(JSON.stringify({ error: 'disk I/O error' }), { status: 500 });
    if (answer === 'refused') return new Response(JSON.stringify({ error: REFUSED }), { status: 400 });
    return new Response(JSON.stringify(PRIVACY.fresh), { status: 200 });
  };
  /** @type {unknown[]} */
  const probes = [];
  /** @type {(reply: unknown) => void} */
  let answer = () => undefined;
  const host = /** @type {any} */ ({
    state: HOST_STATE,
    /** @param {(state: object) => void} listener */
    follow: listener => {
      listener({ ...HOST_STATE, reach: { state: 'answering', revision: 2, tone: null, title: null, line: null, meta: null, acts: [] } });
      return () => undefined;
    },
    /** @param {unknown} message */
    act: message => {
      probes.push(message);
      return new Promise(done => {
        answer = done;
      });
    },
  });
  const reports = /** @type {any} */ ({ follow: () => () => undefined, failure: () => '', seen: { state: HOST_STATE, report: REPORT } });
  const { pageChanges } = await import('../public/ui/connectors/changes.js');
  const changes = pageChanges(host, reports);
  const frame = changes.watch(() => undefined);
  const settle = async () => {
    for (const _ of [1, 2, 3]) await new Promise(done => setImmediate(done));
  };
  const shownAgain = async () => {
    frame.shown(false);
    frame.shown(false, { privacy: true });
    await settle();
  };

  frame.shown(false, { privacy: true });
  await settle();
  assert.deepEqual([changes.privacy.failed, changes.privacy.read], ['', null]);
  assert.deepEqual(probes, [{ act: 'home', do: 'probe' }]);
  answer({ state: 'answering', revision: 2 });
  await settle();
  assert.deepEqual([changes.privacy.failed, changes.privacy.read], ['', PRIVACY.fresh]);
  await shownAgain();
  assert.deepEqual([changes.privacy.failed, changes.privacy.read], [LACKS.privacy, PRIVACY.fresh]);
  await shownAgain();
  assert.equal(changes.privacy.failed, REFUSED);
  assert.equal(probes.length, 1, 'a read\'s own failure asks the Mac nothing');
  assert.deepEqual(answers, []);
  frame.stop();
});

test('V11: Chat’s row cautions while its voice notes leave as they are and its level hides; a voice note’s row is named so', () => {
  /** @param {{ leaves: string | null } | undefined} voice @param {string} [chat] */
  const chatRow = (voice, chat = PRIVACY.fresh.chat) => rowOf(at(SETTINGS_PRIVACY, { privacy: { ...READS,
    read: { ...PRIVACY.fresh, chat, ...voice ? { voice } : {} } } }), 'Chat');
  const caution = chatRow({ leaves: 'Synthetic Cloud' });
  assert.deepEqual(caution?.mark, { status: 'disk' });
  assert.equal(caution?.line, 'Voice notes go to Synthetic Cloud as they are: sound can’t be hidden.');
  for (const quiet of [chatRow({ leaves: null }), chatRow(undefined), chatRow({ leaves: 'Synthetic Cloud' }, 'none')]) {
    assert.equal(quiet?.mark, null);
    assert.equal(quiet?.line, 'What Chat hides when it asks a cloud model.');
  }
  const page = { ...OUTBOUND_PAGE, rows: [{ ...OUTBOUND_PAGE.rows[0], about: /** @type {const} */ ('chat-voice'), level: 'none' }] };
  const day = at(SETTINGS_PRIVACY, { privacy: { ...READS, page }, opened: { pages: [`outbound:${page.rows[0].day}:`] } });
  assert.match(String(rowsOf(day)[0].label), /· A voice note in Chat$/u);
});
