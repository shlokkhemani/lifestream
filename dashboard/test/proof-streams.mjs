import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_STATE } from '../public/kit-gallery-report.js';
import { detailOf, OPENED } from '../public/ui/connectors/dialog.js';
import { detailMarkup } from '../public/ui/connectors/detail.js';
import { formOf } from '../public/ui/connectors/page.js';
import { AT_REST } from '../public/ui/connectors/view.js';

/** @typedef {import('../public/types.js').StreamsReport} StreamsReport */
/** @typedef {import('../public/types.js').MemberState} MemberState */
/** @typedef {import('../public/ui/connectors/dialog.js').Detail} Detail */
/** @typedef {import('../public/ui/connectors/dialog.js').PanelRow} PanelRow */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../../homelink/Tests/Fixtures/proof-report.json');
/** @type {StreamsReport} */
const REPORT = JSON.parse(await readFile(FIXTURE, 'utf8'));
const MAC = { ...HOST_STATE, signins: /** @type {const} */ (['key', 'device', 'client']), needs: [],
  vault: { state: /** @type {const} */ ('saved'), saved_ms: null } };
const CONTROLS = ['menu', 'zone', 'toggle', 'stepper', 'path', 'list', 'text', 'email', 'date', 'secret'];

/**
 * @param {any} state
 * @param {string} id
 * @param {Partial<import('../public/ui/connectors/dialog.js').Opened>} [opened]
 */
const open = (state, id, opened = {}, report = REPORT) => /** @type {Detail} */ (detailOf(report, state, id, { ...OPENED, ...opened }));
/** @type {StreamsReport} */
const UNROUTED = { ...REPORT, connectors: REPORT.connectors.map(each => each.id !== 'example-oauth' ? each : { ...each, routes: [],
  ways: each.ways.map(way => ({ ...way, requirements: [{ kind: /** @type {const} */ ('form'), met: false, words: `Set up ${each.name}`,
    line: null, act: { do: /** @type {const} */ ('set'), label: 'Set up', member: 'account' } }] })) }) };
const openOf = (/** @type {StreamsReport} */ report) => (/** @type {any} */ state, /** @type {string} */ id, opened = {}) => open(state, id, opened, report);
/**
 * @param {Detail} detail
 * @returns {PanelRow[]}
 */
const rowsOf = detail => detail.panels.flatMap(panel => panel.rows);
/**
 * @param {unknown} value
 * @returns {any[]}
 */
const doesIn = value => !value || typeof value !== 'object' ? []
  : [...'do' in value ? [/** @type {any} */ (value).do] : [], ...Object.values(value).flatMap(doesIn)];
/** @param {import('../public/types.js').ConnectorReport} connector */
const drawnOf = connector => connector.members.filter(member => member.panel !== null && member.panel !== 'export' && member.control !== null
  && !connector.routes.some(route => route.sets.includes(member.key)));

test('P1, P2: every member of every proof stream drawn by its control, with the Mac\'s host', () => {
  const seen = new Set();
  for (const report of [REPORT, UNROUTED]) for (const connector of report.connectors) {
    const open = openOf(report);
    const detail = open(MAC, connector.id);
    assert.ok(detail, connector.id);
    assert.ok(detailMarkup(detail, AT_REST).includes(connector.name), `${connector.id}: drawn`);
    for (const member of drawnOf(connector)) {
      seen.add(member.control);
      const where = `${connector.id}.${member.key} (${member.control})`;
      const typedHere = member.kind !== 'start' && ['text', 'email', 'date', 'secret'].includes(/** @type {string} */ (member.control));
      const row = rowsOf(detail).find(each => each.label === member.label);
      if (!connector.set_up && !typedHere) {
        assert.deepEqual([detail.panels, Boolean(detail.connect)], [[], true], `${where}: its steps first, no section before it is set up`);
        continue;
      }
      assert.equal(Boolean(row), !typedHere, `${where}: ${typedHere ? 'no row' : 'a row'}`);
      if (typedHere) {
        assert.ok(formOf(connector).includes(member), `${where}: the form's`);
        assert.ok(doesIn(detail).some(each => each.page === 'form'), `${where}: its page reached from the dialog`);
        const page = open(MAC, connector.id, { pages: ['form'] });
        const field = page.signin?.fields.find(each => each.key === `${connector.id}.${member.key}`);
        assert.deepEqual([field?.label, field?.kind], [member.label, member.control], `${where}: its field on the sign-in sheet`);
        const markup = detailMarkup(page, AT_REST);
        const type = { text: 'text', email: 'email', date: 'date', secret: 'password' }[/** @type {'text'} */ (member.control)];
        assert.match(markup, new RegExp(`<input[^>]*type="${type}"[^>]*data-cn-field="${connector.id}\\.${member.key}"`, 'u'), where);
        continue;
      }
      const end = /** @type {any} */ (/** @type {PanelRow} */ (row).end);
      if (member.control === 'menu') {
        const menu = member.menu;
        assert.equal(end.menu.choices.length, menu ? [menu.default, ...menu.rows, ...menu.local?.rows ?? [], menu.more, menu.off].filter(Boolean).length : member.steps?.length ?? 0, where);
        if (menu) assert.deepEqual(end.menu.choices.find((/** @type {any} */ choice) => choice.more)?.do, { page: `model:${member.key}` }, `${where}: More opens the find`);
      }
      if (member.kind === 'start') {
        assert.deepEqual([end.menu.choices.map((/** @type {any} */ choice) => choice.words), end.menu.date?.connector, end.menu.date?.member],
          [['All time'], connector.id, member.key], `${where}: All time, or a day`);
      }
      if (member.control === 'zone') assert.equal(end.menu.find, 'Find a time zone', where);
      if (member.control === 'toggle') assert.deepEqual(end.toggle.do.host, { act: 'setting', connector: connector.id, member: member.key, value: member.value !== true });
      if (member.control === 'stepper') assert.equal(end.stepper.text, member.words, where);
      if (member.control === 'list') assert.deepEqual(row?.go?.do, { page: `list:${member.key}` }, where);
      if (member.control === 'path') {
        assert.equal(member.where?.unit, MAC.unit, `${where}: the fixture's path is this Mac's`);
        assert.deepEqual(end.acts.map((/** @type {any} */ act) => act.do.host), [{ act: 'choose-file', connector: connector.id, member: member.key }]);
        const elsewhere = rowsOf(open({ ...MAC, unit: 'macbook-air-bb17' }, connector.id)).find(each => each.label === member.label);
        assert.deepEqual([elsewhere?.line, elsewhere?.end], [`Choose it on ${member.where?.name}`, { words: member.words }]);
      }
    }
  }
  const oauth = REPORT.connectors.find(each => each.id === 'example-oauth');
  assert.deepEqual(oauth && formOf(oauth), []);
  assert.deepEqual(CONTROLS.filter(control => !seen.has(control)), [], 'every control drawn');
  assert.deepEqual(CONTROLS.filter(control => !REPORT.connectors.some(each => each.members.some(member => member.control === control))), [],
    'the fixture carries every control');
});

test('P3: in a browser, every value in words and where it is changed said; no host act, no sign-in', () => {
  for (const connector of REPORT.connectors) {
    const detail = open(null, connector.id);
    assert.ok(!doesIn(detail).some(each => 'host' in each || 'page' in each && each.page === 'form'), `${connector.id}: no host act`);
    for (const member of drawnOf(connector).filter(each => connector.set_up && each.control !== 'list' && !formOf(connector).includes(each))) {
      const row = rowsOf(detail).find(each => each.label === member.label);
      assert.ok(row, `${connector.id}.${member.key}`);
      assert.ok(row.end === null || (Object.keys(row.end).length === 1 && 'words' in row.end), `${connector.id}.${member.key}: words alone`);
    }
    const note = detail.foot?.note ?? '';
    assert.ok(note.endsWith('on your Mac or iPhone.'), `${connector.id}: ${note}`);
  }
  assert.equal(open(null, 'example-oauth').foot?.note, 'Sign in to Example OAuth on your Mac or iPhone.');
  assert.equal(open(null, 'example-oauth', { pages: ['form'] }).name, 'Example OAuth', 'no Set up page in a browser');
});

test('P4: Check now under Check every, its blocked reasons in the home\'s words, pressed by the host or the server', () => {
  const offered = REPORT.connectors.filter(each => each.refresh_now !== null);
  assert.deepEqual([...new Set(offered.map(each => each.refresh_now?.blocked?.reason ?? 'free'))].sort(),
    ['chrome', 'device', 'disk', 'free', 'held', 'offline', 'paused', 'running', 'vault'], 'every blocked reason, and one free');
  for (const connector of REPORT.connectors) {
    const now = connector.refresh_now;
    for (const state of [MAC, null]) {
      const rate = connector.members.find(member => member.key === 'refresh' && member.panel !== null)?.label ?? null;
      const settings = open(state, connector.id).panels.find(panel => panel.label === 'Settings');
      const rows = settings?.rows ?? [];
      const at = now ? rows.findIndex(row => row.label === now.act.label) : -1;
      if (!now) {
        assert.equal(at, -1, `${connector.id}: none offered`);
        continue;
      }
      assert.equal(at, rows.findIndex(row => row.label === rate) + 1, `${connector.id}: under ${rate}`);
      const row = rows[at];
      if (now.blocked) {
        assert.deepEqual([row.line, row.end], [now.blocked.words, null], `${connector.id}: its words, no button`);
        assert.equal(row.signal, now.blocked.reason === 'running' ? 'engaged' : 'idle');
      } else {
        const press = /** @type {any} */ (row.end).acts[0].do;
        assert.deepEqual(press, state ? { host: { act: 'refresh', connector: connector.id } } : { refresh: connector.id });
      }
      assert.deepEqual(row.waiting, now.asked.length ? [`Asked ${now.asked.map(each => each.name).join(' and ')}`] : []);
    }
  }
  const sync = /** @type {NonNullable<import('../public/types.js').ConnectorReport['refresh_now']>} */ (REPORT.connectors
    .find(each => each.id === 'example-sync')?.refresh_now);
  assert.match(detailMarkup(open(MAC, 'example-sync'), AT_REST), new RegExp(`ck-srow__label">${sync.act.label}<[^]*${sync.blocked?.words}`, 'u'));
});

test('P5: the client way: Connect the host\'s ClientSheet of the route\'s id, where the host draws it', () => {
  const ask = (/** @type {any} */ state) => open(state, 'example-oauth').connect?.ways[0].rows.find(row => row.act)?.act ?? null;
  assert.deepEqual(ask(MAC)?.do, { host: { act: 'sheet', connector: 'example-oauth', route: 'example-oauth' } });
  assert.equal(ask({ ...MAC, signins: ['key', 'device'] }), null, 'a host that draws no ClientSheet offers none');
  assert.equal(ask(null), null);
});
