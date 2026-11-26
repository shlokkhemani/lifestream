import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { esc } from '../public/lib/html.js';
import { AT, HOST_STATE, REPORT } from '../public/kit-gallery-report.js';
import { actOf, appAdded, endOf as rowEnd, needsOf, ownNeeds, rowLine, wholeLine } from '../public/ui/connectors/page.js';
import { importsLastInEachView, standsInImport, wholePage as pageOf } from './stand-ins/whole-page.mjs';
import { pageOf as viewOf } from '../public/ui/connectors/page.js';
import { connectorLine } from '../public/ui/kit/connector-row.js';
import { pendingOf, settled } from '../public/ui/connectors/pending.js';
import { detailOf, formActs, formAnswered, OPENED } from '../public/ui/connectors/dialog.js';
import { AT_REST, bodyMarkup, busyKey, busyWith, sideMarkup } from '../public/ui/connectors/view.js';
import { detailMarkup } from '../public/ui/connectors/detail.js';
import { isSettings, SETTINGS_CHROME, SETTINGS_HOME, SETTINGS_IPHONE, SETTINGS_MAC, settingsDetail }
  from '../public/ui/connectors/settings.js';
import { lifeReader } from '../lib/life.mjs';
import { macSources, photoStreams } from '../public/ui/onboarding/model.js';
import { footRoute } from '../public/ui/sections.js';
import { openDoor } from '../lib/door.mjs';
import { createViewer } from '../server.mjs';
import { actHome } from './stand-ins/act-home.mjs';

/** @typedef {import('../public/types.js').StreamsReport} StreamsReport */
/** @typedef {import('../public/types.js').ConnectorReport} ConnectorReport */
/** @type {import('../public/ui/connectors/page.js').Filter} */
const NONE = { query: '', place: /** @type {''} */ ('') };

/** @param {ReturnType<typeof pageOf>} page */
const listRows = page => page.sections.flatMap(section => section.faces);
/** @param {ReturnType<typeof pageOf>} page */
const ids = page => listRows(page).map(face => face.id);
/** @param {ReturnType<typeof pageOf>} page @param {string} id */
const faceOf = (page, id) => listRows(page).find(face => face.id === id);
/** @param {string} id */
const connectorIn = id => /** @type {ConnectorReport} */ (REPORT.connectors.find(each => each.id === id));
/**
 * @param {string} id
 * @param {(connector: ConnectorReport) => ConnectorReport} change
 * @returns {StreamsReport}
 */
const changing = (id, change) => ({ ...REPORT, connectors: REPORT.connectors.map(each => each.id === id ? change(each) : each) });

/**
 * @param {StreamsReport | null} report
 * @param {any} state
 * @param {string} id
 * @param {Partial<import('../public/ui/connectors/dialog.js').Opened>} [opened]
 * @returns {any}
 */
const open = (report, state, id, opened = {}) => isSettings(id)
  ? settingsDetail({ report, models: null, failed: '', state, id, opened: { ...OPENED, ...opened }, subscriptions: null })
  : detailOf(report, state, id, { ...OPENED, ...opened });
/**
 * @param {import('../public/types.js').DeviceRow} device
 * @param {import('../public/lib/host.js').HostState | null} [state]
 */
const deviceAt = (device, state = null) => device.kind === 'mac' && device.unit === state?.unit ? SETTINGS_MAC
  : `${device.kind === 'mac' ? SETTINGS_MAC : SETTINGS_IPHONE}/${device.unit}`;
/**
 * @param {any} detail
 * @param {string} label
 */
const panelOf = (detail, label) => detail.panels.find((/** @type {any} */ panel) => panel.label === label);
/** @param {any} row */
const endOf = row => row.go ? `> ${row.go.value}` : !row.end ? '' : 'menu' in row.end ? `menu ${row.end.menu.words}`
  : 'toggle' in row.end ? `switch ${row.end.toggle.on ? 'on' : 'off'}` : 'stepper' in row.end ? `stepper ${row.end.stepper.text}`
    : [row.end.words ?? '', ...(row.end.acts ?? []).map((/** @type {any} */ act) => act.label)].filter(Boolean).join(' ');
/**
 * @param {any} detail
 * @param {string} label
 */
const rowsOf = (detail, label) => panelOf(detail, label)?.rows.map((/** @type {any} */ row) => [row.label, row.line, endOf(row)]);

/**
 * @param {any} detail
 * @returns {any[]}
 */
function actsOf(detail) {
  const rows = [...detail.panels.flatMap((/** @type {any} */ panel) => panel.rows),
    ...detail.parts.flatMap((/** @type {any} */ part) => part.panel?.rows ?? [])];
  return [...detail.callout?.acts ?? [],
    ...detail.parts.flatMap((/** @type {any} */ part) => part.acts),
    ...rows.flatMap((/** @type {any} */ row) => {
      const end = row.end;
      const asked = [row.confirm?.yes, row.confirm?.no];
      if (row.go) return [{ label: row.label, do: row.go.do }, ...asked];
      if (!end) return asked;
      if ('menu' in end) return end.menu.choices.filter((/** @type {any} */ choice) => choice.do !== null)
        .map((/** @type {any} */ choice) => ({ label: choice.words, do: choice.do }));
      if ('toggle' in end) return [{ label: end.toggle.label, do: end.toggle.do }];
      if ('stepper' in end) return [end.stepper.less, end.stepper.more].filter(Boolean).map(doing => ({ label: '', do: doing }));
      return [...end.acts ?? [], ...asked];
    }),
    ...detail.panels.flatMap((/** @type {any} */ panel) => panel.add ? [...panel.add.finds.map((/** @type {any} */ find) =>
      ({ label: find.name, do: find.do })), ...panel.add.enter ? [{ label: '', do: panel.add.enter }] : [],
      ...panel.add.end && 'acts' in panel.add.end ? panel.add.end.acts : []] : []),
    ...(detail.connect?.ways ?? []).flatMap((/** @type {any} */ way) => way.rows.map((/** @type {any} */ row) => row.act)),
    detail.foot?.start, ...detail.foot?.end ?? [], detail.confirm?.yes, detail.confirm?.no,
  ].filter(act => act !== null && act !== undefined);
}

/**
 * @param {any} state
 * @param {ConnectorReport} connector
 */
const dialogOf = (state, connector) => open(REPORT, state, connector.id);

const DRAWN = REPORT.connectors.filter(each => each.shown !== null);

const IDS = [...DRAWN.map(each => each.id), SETTINGS_HOME, SETTINGS_CHROME,
  ...new Set(REPORT.devices.map(deviceAt))];

/**
 * @param {any} state
 * @param {string} [typed]
 */
function everyDialog(state, typed = '') {
  return IDS.flatMap(id => {
    const connector = REPORT.connectors.find(each => each.id === id);
    const pages = [[], ...(connector?.members ?? []).filter(member => member.kind === 'list').map(member => [`list:${member.key}`]),
      ['copies'], ['signin']];
    return pages.map(each => open(REPORT, state, id, { pages: each, typed })).filter(detail => detail !== null);
  });
}

/** @param {any} state */
function everyAct(state) {
  const page = pageOf(REPORT, state, NONE);
  return [
    ...page.sections.flatMap(section => section.faces.map(face => face.act)),
    ...page.alerts.flatMap(alert => [alert.act, alert.dismiss]),
    ...everyDialog(state, 'ke').flatMap(actsOf),
  ].filter(act => act !== null && act !== undefined);
}

test('N1, N5: one row per stream in its kind\'s section, set up first, as the home says it; the side column as sent', () => {
  for (const state of [null, HOST_STATE]) {
    const streams = REPORT.connectors.filter(each => each.shown === 'stream' && !standsInImport(REPORT, each));
    const page = pageOf(REPORT, state, NONE);
    assert.deepEqual(ids(page).filter(id => !id.startsWith('import:')).sort(), streams.map(each => each.id).sort());
    assert.deepEqual(ids(page).filter(id => id.startsWith('import:')), REPORT.imports.map(kind => `import:${kind.kind}`));
    assert.ok(importsLastInEachView(REPORT, state, NONE), 'Imports last');
    for (const connector of streams) {
      const face = faceOf(page, connector.id);
      const served = /** @type {import('../public/pages.js').StreamRow} */ (REPORT.rows.find(row => row.ids.includes(connector.id)));
      assert.deepEqual([face?.name, face?.state, face?.line], [served.name, connector.health.state, rowLine(served, Date.now())], connector.id);
    }
    for (const section of page.sections) {
      assert.ok(section.faces.every(face => face.type === section.key), section.key);
      const first = section.faces.findIndex(face => !face.set_up);
      assert.ok(first < 0 || section.faces.slice(first).every(face => !face.set_up), `${section.key}: set up before the rest`);
    }
    assert.deepEqual(page.side.map(row => row.id), [SETTINGS_HOME,
      ...REPORT.devices.map(device => deviceAt(device, state)), SETTINGS_CHROME]);
    assert.deepEqual(page.side[0].line, REPORT.home.health.words);
    const phone = /** @type {import('../public/types.js').DeviceRow} */ (REPORT.devices.find(device => device.kind === 'phone'));
    const removed = { ...REPORT, devices: [...REPORT.devices, { ...phone, unit: 'iphone-cc01', retired: true }] };
    const side = pageOf(removed, state, NONE);
    assert.deepEqual(side.side.slice(-2).map(row => [row.id, row.group]),
      [[SETTINGS_CHROME, 'devices'], [`${SETTINGS_IPHONE}/iphone-cc01`, 'removed']]);
    assert.match(sideMarkup(side), /aria-expanded="false"[^>]*>.*1 removed<\/span><\/button><\/div>/u);
    assert.match(sideMarkup(side, true), /aria-expanded="true".*data-cn-open="settings\/iphone\/iphone-cc01"/u);
    assert.equal(page.count, ids(page).length);
  }
  const body = bodyMarkup(pageOf(REPORT, null, NONE), AT_REST, '');
  for (const connector of REPORT.connectors.filter(each => each.shown === 'stream' && !each.set_up && !standsInImport(REPORT, each))) {
    assert.match(body, new RegExp(`data-cn-open="[^"]+"><span class="ck-cline__name mac-headline" aria-hidden="true">${esc(connector.name)}</span></button>`
      + `<span class="ck-cline__line" aria-hidden="true">${esc(connector.gives.replace(/\.$/u, ''))} · [A-Za-z]+</span>`, 'u'), connector.id);
  }
  const ends = listRows(pageOf(REPORT, HOST_STATE, NONE)).map(face => [face.id, rowEnd(face)]);
  for (const [id, end] of ends) {
    const face = /** @type {any} */ (faceOf(pageOf(REPORT, HOST_STATE, NONE), String(id)));
    if (!face.set_up) assert.ok('connect' in end || 'act' in end, `${id}: Connect`);
    else if (['ok', 'syncing', 'quiet'].includes(face.state) && !face.act) assert.ok('last' in end, `${id}: its last time`);
  }
  assert.ok(ends.some(([, end]) => 'last' in end && end.last !== ''), 'a row its newest item\'s time');
});

const joining = changing('notes', notes => ({ ...notes, joins: { name: 'Lifestream notes', icon: 'compose', gives: 'What you write.', apps: [] } }));

test('N1d: Connected holds what is set up, Not connected the rest with the imports and Not here?, each pill its own count', () => {
  for (const state of [null, HOST_STATE]) {
    const connected = viewOf(REPORT, state, { ...NONE, shown: 'connected' });
    const not = viewOf(REPORT, state, { ...NONE, shown: 'not' });
    assert.ok(listRows(connected).length > 0 && listRows(connected).every(face => face.set_up), 'connected');
    assert.ok(listRows(not).length > 0 && listRows(not).every(face => !face.set_up), 'not connected');
    assert.deepEqual([connected.shownCounts, not.shownCounts], [{ connected: connected.count, not: not.count },
      { connected: connected.count, not: not.count }]);
    assert.equal(connected.entry, null, 'Not here? under Not connected alone');
    assert.ok(not.entry !== null);
    const body = bodyMarkup(not, AT_REST, '');
    assert.match(body, /data-cn-seg="connected"[^>]*>Connected<span[^>]*>\d+<\/span><\/button>/u);
    assert.match(body, /aria-selected="true"[^>]*data-cn-seg="not"|data-cn-seg="not"[^>]*aria-selected="true"/u);
    assert.equal(viewOf(REPORT, state, NONE).shown, 'connected', 'Connected when anything is set up');
  }
  const fresh = { ...REPORT, imports: REPORT.imports.map(kind => ({ ...kind, held: [], coming: [] })),
    connectors: REPORT.connectors.map(each => ({ ...each, set_up: false })) };
  assert.equal(viewOf(fresh, null, NONE).shown, 'not', 'Not connected on a home with nothing set up');
  assert.equal(bodyMarkup(viewOf(fresh, null, { ...NONE, shown: 'connected' }), AT_REST, '').includes('Nothing connected yet.'), true);
});

test('N1e: a row says where it is read after its line, its own stop dropped; the end its one column', () => {
  const line = connectorLine({ name: 'Calendar', icon: 'calendar-event', line: 'Every event, with its place and people.', place: 'Mac',
    set_up: false, end: { connect: 'Connect' }, opens: { 'data-cn-open': 'apple-calendar' } });
  assert.match(line, /<span class="ck-cline__line" aria-hidden="true">Every event, with its place and people · Mac<\/span>/u);
  assert.doesNotMatch(line, /ck-cline__place/u);
  const bare = connectorLine({ name: 'Not here?', icon: 'coding-agent', line: 'Your coding agent can build it.', place: '',
    set_up: false, end: { last: '' }, opens: null });
  assert.match(bare, /Your coding agent can build it\.<\/span>/u, 'no place, the line as sent');
});

test('N1f: a stream an import of it alone reads, not set up, is that import\'s row; one an import of many reads keeps its kind', () => {
  const alone = REPORT.imports.find(kind => kind.products.length === 0);
  const many = REPORT.imports.find(kind => kind.products.length > 0);
  assert.ok(alone && many, 'the fixture holds both');
  const make = (/** @type {string} */ id, /** @type {string} */ kind) => ({ ...connectorIn('gmail'), id, name: id, roads: /** @type {any} */ (['upload']),
    set_up: false, export: { import: kind, name: kind, icon: 'archive', opens: false, line: '' } });
  const report = { ...REPORT, connectors: [...REPORT.connectors, make('only-file', alone.kind), make('one-of-many', many.kind)],
    rows: [...REPORT.rows, ...['only-file', 'one-of-many'].map(id => ({ ...REPORT.rows[0], ids: [id], name: id }))] };
  const not = ids(viewOf(report, null, { ...NONE, shown: 'not' }));
  assert.deepEqual([not.includes('only-file'), not.includes('one-of-many')], [false, true]);
  assert.ok(ids(pageOf(report, null, NONE)).includes(`import:${alone.kind}`));
});

test('N1b: the home\'s joined row is one row, named by the join, found by each member\'s name', () => {
  const camera = { ...connectorIn('notes'), id: 'camera', name: 'Camera', set_up: false,
    joins: { name: 'Lifestream notes', icon: 'compose', gives: 'What you write.', apps: [] } };
  const rows = joining.rows.map(row => row.ids.includes('notes') ? { ...row, ids: [...row.ids, camera.id], joined: true,
    name: 'Lifestream notes', icon: 'compose', find: [...row.find, camera.name] } : row);
  const report = { ...joining, connectors: [...joining.connectors, camera], rows };
  const page = pageOf(report, null, NONE);
  const joined = listRows(page).filter(face => face.name === 'Lifestream notes');
  assert.deepEqual(joined.map(face => [face.id, face.icon, face.set_up]), [['notes', 'compose', true]]);
  assert.ok(!ids(page).includes('camera'));
  assert.ok(ids(pageOf(report, null, { ...NONE, query: 'camera' })).includes('notes'));
});

test('N1c: a new home starts with the rows the home marks, before every kind', () => {
  const fresh = { ...REPORT, needs: [], imports: [], connectors: REPORT.connectors.map(each => ({ ...each, set_up: false,
    starter: ['apple-photos', 'location'].includes(each.id) })) };
  const page = pageOf(fresh, null, NONE);
  assert.deepEqual([page.sections[0]?.name, page.sections[0]?.faces.map(face => face.id)], ['Start with these', ['apple-photos', 'location']]);
  assert.equal(ids(page).filter(id => id === 'location').length, 1);
  const later = { ...fresh, connectors: fresh.connectors.map(each => each.id === 'motion' ? { ...each, set_up: true } : each) };
  assert.ok(!pageOf(later, null, NONE).sections.some(section => section.name === 'Start with these'), 'once one is set up');
});

test('N2: a search or Where that keeps the wrong rows, counts that lie', () => {
  const page = pageOf(REPORT, null, NONE);
  for (const connector of REPORT.connectors.filter(each => each.shown === 'stream')) {
    const word = /** @type {string} */ (connector.gives.split(/\s+/u).at(-1)).replace(/\W+$/u, '');
    assert.ok(ids(pageOf(REPORT, null, { ...NONE, query: word.toUpperCase() })).includes(connector.id), `${connector.id} by "${word}"`);
  }
  const mail = pageOf(REPORT, null, { ...NONE, query: 'MAIL' });
  assert.ok(ids(mail).includes('gmail'));
  assert.ok(ids(mail).filter(id => !id.startsWith('import:')).every(id => {
    const connector = connectorIn(id);
    return [connector.name, connector.type?.name ?? '', connector.gives, connector.lead ?? '', connector.line].join(' ')
      .toLowerCase().includes('mail');
  }));
  for (const [key, count] of Object.entries(page.placeCounts)) {
    const kept = pageOf(REPORT, null, { ...NONE, place: /** @type {any} */ (key) });
    assert.equal(ids(kept).length, count, key);
    assert.ok(listRows(kept).every(face => face.places.some(place => place.key === key)), key);
  }
  assert.ok(page.placeCounts.file >= REPORT.imports.length);
  assert.equal(pageOf(REPORT, null, { ...NONE, query: 'nothing-is-called-this' }).empty, 'No connectors match.');
});

test('N7: a dialog of one shape, every copy in its own health and line, the history under History', () => {
  for (const state of [null, HOST_STATE]) {
    for (const connector of DRAWN) {
      const detail = dialogOf(state, connector);
      assert.ok(detail, connector.id);
      if (!/ · Last added /u.test(detail.line)) {
        assert.equal(detail.line, connector.set_up ? [wholeLine(connector), connector.figure?.last ?? ''].filter(Boolean).join(' · ')
          : connector.gives, `${connector.id}: its state, then when it last brought something; what it gives before it is set up`);
      }
      const quiet = ['ok', 'syncing', 'setup'].includes(connector.health.state);
      assert.equal(detail.callout?.title ?? null, quiet || !connector.health.words ? null : connector.health.words, connector.id);
      const comes = rowsOf(detail, 'Comes from') ?? [];
      for (const copy of connector.copies) {
        const name = connector.account?.copy === copy.id ? connector.account.name : copy.name;
        const row = comes.find((/** @type {any} */ each) => each[0] === name
          && (each[1] === copy.line || (each[1] === '' && detail.line === copy.line.replace(/\s*·\s*last\s+/iu, ' · Last added '))));
        assert.ok(row, `${connector.id}: ${copy.id}`);
        assert.equal(row[2].startsWith('switch'), state !== null && connector.copies.length > 1, `${connector.id}: ${copy.id}`);
      }
      if (connector.history && connector.set_up) assert.deepEqual(rowsOf(detail, 'History')?.[0].slice(0, 1), [connector.history.words], connector.id);
      assert.doesNotThrow(() => detailMarkup(detail, AT_REST));
    }
  }
  const claude = open(REPORT, HOST_STATE, 'claude');
  assert.deepEqual(panelOf(claude, 'Comes from').rows.slice(0, connectorIn('claude').copies.length)
    .map((/** @type {any} */ row) => [row.lead, row.signal !== null]),
    connectorIn('claude').copies.map(copy => [{ icon: 'web' }, copy.health.state !== 'ok']));
  const many = changing('claude', each => ({ ...each, copies: Array.from({ length: 7 }, (_, at) => ({ ...each.copies[1],
    id: `claude:person-${at}@example.com:browser`, name: `person-${at}@example.com` })) }));
  const seven = open(many, HOST_STATE, 'claude');
  assert.deepEqual(rowsOf(seven, 'Comes from').slice(5, 6), [['Show all', '', '> ']]);
  const page = open(many, HOST_STATE, 'claude', { pages: ['copies'] });
  assert.equal(page.panels[0].rows.length, 7);
  assert.ok(page.panels[0].rows.every((/** @type {any} */ row) => endOf(row).startsWith('switch')));
  for (const device of REPORT.devices.filter(each => !each.retired)) {
    const detail = open(REPORT, HOST_STATE, deviceAt(device));
    const part = detail.parts.find((/** @type {any} */ each) => each.label === device.name)
      ?? detail.parts.find((/** @type {any} */ each) => each.label === 'Records');
    assert.ok(part, device.unit);
    for (const connector of REPORT.connectors.filter(each => each.shown === 'stream'
      && each.copies.some(copy => copy.unit === device.unit))) {
      assert.ok(detail.parts.some((/** @type {any} */ each) => each.panel?.rows.some((/** @type {any} */ row) =>
        row.label === connector.name && row.go?.do.open === connector.id && row.go.do.push)), `${device.unit}: ${connector.id}`);
    }
  }
});

test('N8: an act in a browser, a host act of no shape the host takes, the report other than the home\'s', async () => {
  assert.deepEqual(everyAct(null).filter(act => 'host' in act.do || 'flow' in act.do), []);
  const browser = bodyMarkup(pageOf(REPORT, null, NONE), AT_REST, '') + sideMarkup(pageOf(REPORT, null, NONE))
    + everyDialog(null).map(detail => detailMarkup(detail, AT_REST)).join('');
  assert.doesNotMatch(browser, /&quot;host&quot;|data-cn-input|data-cn-add|could not update/u);
  const connectors = REPORT.connectors.map(each => each.id);
  /** @param {string} id */
  const connector = id => REPORT.connectors.find(each => each.id === id);
  const strings = (/** @type {unknown} */ list) => Array.isArray(list) && list.every(each => typeof each === 'string');
  for (const act of everyAct(HOST_STATE)) {
    if (!('host' in act.do)) continue;
    const message = act.do.host;
    const member = connector(message.connector)?.members.find(each => each.key === message.member);
    const shapes = {
      allow: () => strings(message.grants),
      turn: () => strings(message.sources) && typeof message.on === 'boolean',
      pause: () => message.target === 'home'
        || connectors.includes(message.connector) && (message.scope === undefined || message.scope === 'history'),
      resume: () => REPORT.paused.some(pause => pause.target === message.target)
        || connectors.includes(message.connector) && (message.scope === undefined || message.scope === 'history'),
      'general-login': () => typeof message.on === 'boolean',
      uninstall: () => Object.keys(message).length === 1,
      home: () => HOST_STATE.home?.acts.some(each => each.do === message.do),
      setting: () => member !== undefined,
      upload: () => connectors.includes(message.connector),
      'choose-file': () => member?.control === 'path',
      'choose-app': () => Object.keys(message).length === 1,
      'retire-phone': () => REPORT.devices.some(device => device.unit === message.unit && device.kind === 'phone'),
      need: () => HOST_STATE.needs.some(need => need.id === message.need && need.acts.some(each => each.id === message.button)),
      sheet: () => Object.keys(message).length === 3 && connector(message.connector)?.routes.some(route => route.id === message.route),
      refresh: () => connector(message.connector)?.refresh_now !== null,
      faces: () => message.do === 'on',
      'agent-disconnect': () => typeof message.id === 'string',
      'agent-access': () => typeof message.id === 'string' && typeof message.access === 'object' && Number.isInteger(message.expect),
      'agent-answer': () => typeof message.id === 'string' && ['once', 'always', 'no'].includes(message.answer),
      open: () => ['browser-store', 'home-log', 'storage'].includes(message.what) || (message.what === 'site'
        && typeof message.url === 'string' && message.url.startsWith('https://')),
    };
    assert.ok(/** @type {Record<string, () => boolean>} */ (shapes)[message.act]?.(), JSON.stringify(message));
  }
  /** @type {unknown[]} */
  const asked = [];
  const served = { ...REPORT, position: '1:0' };
  const door = /** @type {any} */ ({ follow: () => () => undefined, position: () => '1:0', json: () => new Promise(() => undefined),
    text: async (/** @type {string} */ path, /** @type {string | undefined} */ etag, /** @type {unknown} */ params,
      /** @type {unknown} */ _signal, /** @type {string | undefined} */ device) => {
      asked.push([path, etag ?? '', params, device]);
      return etag === 'W/"kept"' ? { status: 304, etag, position: null, text: '' }
        : { status: 200, etag: 'W/"kept"', position: null, text: JSON.stringify(served) };
    } });
  const life = lifeReader(door);
  assert.deepEqual(await life.page('connectors', { unit: 'macbook-pro-0001' }), served);
  assert.deepEqual(await life.page('connectors', { unit: 'macbook-pro-0001' }), served);
  await life.page('connectors', {});
  assert.deepEqual(asked, [['/v1/connectors', '', { unit: 'macbook-pro-0001' }, 'mac/1'],
    ['/v1/connectors', 'W/"kept"', { unit: 'macbook-pro-0001' }, 'mac/1'], ['/v1/connectors', '', {}, undefined]],
  'the Mac\'s window asks as a Mac and sends its ETag; a browser asks as no device');
  asked.splice(0);
  await life.page('settingsPage', { id: 'advanced' });
  await life.page('storage', {});
  assert.deepEqual(asked.map(each => /** @type {unknown[]} */ (each).at(-1)), ['mac/1', 'mac/1'], 'Settings\' pages are the Mac\'s, always');
  for (const file of ['../public/ui/connectors/words.js', '../public/ui/connectors/page.js', '../public/ui/connectors/dialog.js',
    '../public/ui/connectors/view.js', '../public/ui/connectors/detail.js', '../public/ui/flows/model.js',
    '../public/ui/flows/view.js', '../public/ui/flows/frame.js', '../public/pages/connectors.js',
    '../public/ui/kit/connector-row.js']) {
    const code = (await readFile(new URL(file, import.meta.url), 'utf8')).split('\n')
      .filter(line => !/^\s*(?:\/\/|\/?\*)/u.test(line)).join('\n');
    assert.doesNotMatch(code.replaceAll('https://github.com/deepinsight/insightface', ''),
      /\b(?:gmail|whatsapp|whoop|imessage|granola|github)\b|['"`]site:/iu, file);
    assert.doesNotMatch(code, /'(?:Needs you|Stopped|Flowing|Not allowed|Not on this Mac)'/u, file);
  }
});

test('N9: the frame before the report, and a home that cannot answer', () => {
  const own = HOST_STATE.needs.filter(need => !need.home);
  const theirs = HOST_STATE.needs.filter(need => need.home);
  assert.deepEqual(needsOf(null, HOST_STATE, false, new Set()).map(alert => alert.title), own.map(need => need.line));
  const read = needsOf(REPORT, HOST_STATE, false, new Set()).map(alert => alert.id);
  assert.deepEqual(own.map(need => [need.id, need.acts[0]?.tone]), [['update', 'warning']]);
  assert.deepEqual(read, ['update', ...REPORT.needs.filter(need => !need.banner).map(need => need.id)],
    'the Mac\'s own first, then the home\'s in the home\'s order');
  assert.deepEqual(needsOf(null, HOST_STATE, true, new Set()).map(alert => alert.title), HOST_STATE.needs.map(need => need.line));
  assert.ok(theirs.length > 0);
  const down = pageOf(null, null, NONE);
  assert.deepEqual(down.side.map(row => [row.id, row.line]), [[SETTINGS_HOME, null], [SETTINGS_CHROME, null]]);
  assert.deepEqual(pageOf(null, HOST_STATE, NONE).side.map(row => row.id), [SETTINGS_HOME, SETTINGS_CHROME]);
  assert.deepEqual([down.read, down.sections, down.entry], [false, [], null]);
  assert.deepEqual([open(null, HOST_STATE, SETTINGS_CHROME).name, open(null, HOST_STATE, SETTINGS_CHROME).reading], ['Chrome extension', true]);
  assert.equal(open(null, HOST_STATE, 'gmail'), null);
});

test('N10: the foot: Disconnect on the left, Pause or Resume on the right; a pause of the history under History', () => {
  /** @param {any} detail */
  const foot = detail => detail?.foot ? [detail.foot.start?.do ?? null, ...detail.foot.end.map((/** @type {any} */ act) => act.do)] : null;
  assert.deepEqual(foot(open(REPORT, HOST_STATE, 'gmail')), [{ ask: 'off:gmail' }, { host: { act: 'pause', connector: 'gmail' } }]);
  const gmail = open(REPORT, HOST_STATE, 'gmail');
  assert.deepEqual([gmail.confirm.question, gmail.confirm.yes.label, gmail.confirm.yes.do], ['Disconnect Gmail?', 'Disconnect',
    { host: { act: 'turn', sources: ['gmail'], on: false } }]);
  assert.match(gmail.confirm.detail, /^Lifestream will stop getting new emails\. Emails already in Lifestream won’t be deleted\.$/u);
  assert.match(detailMarkup(gmail, { ...AT_REST, asking: 'off:gmail' }), /cn-alert[^]*Disconnect Gmail\?[^]*Cancel[^]*Disconnect/u);
  const paused = REPORT.connectors.find(each => each.pauses[0]?.scope === 'all');
  assert.ok(paused);
  const resume = { host: { act: 'resume', connector: paused.id } };
  assert.deepEqual(foot(open(REPORT, HOST_STATE, paused.id))?.at(-1), resume);
  assert.deepEqual(faceOf(pageOf(REPORT, HOST_STATE, NONE), paused.id)?.act?.do, resume);
  assert.equal(faceOf(pageOf(REPORT, null, NONE), paused.id)?.act ?? null, null);
  const arriving = open(REPORT, HOST_STATE, 'chatgpt');
  assert.equal(connectorIn('chatgpt').history?.state, 'syncing');
  assert.deepEqual(panelOf(arriving, 'History').rows[0].end.acts.map((/** @type {any} */ act) => [act.label, act.do]),
    [['Pause', { host: { act: 'pause', connector: 'chatgpt', scope: 'history' } }]]);
  assert.equal(panelOf(open(REPORT, HOST_STATE, paused.id), 'History')?.rows[0]?.end ?? null, null);
  const history = changing('chatgpt', each => ({ ...each, pauses: [{ scope: 'history', by: 'you', reason: 'held by the person', at_ms: REPORT.at_ms }] }));
  const chatgpt = open(history, HOST_STATE, 'chatgpt');
  assert.deepEqual(foot(chatgpt)?.at(-1), { host: { act: 'pause', connector: 'chatgpt' } });
  assert.deepEqual(panelOf(chatgpt, 'History').rows[0].end.acts[0].do,
    { host: { act: 'resume', connector: 'chatgpt', scope: 'history' } });
  assert.deepEqual(panelOf(chatgpt, 'History').rows[0].mark, { status: 'paused' });
  assert.equal(panelOf(open(history, null, 'chatgpt'), 'History').rows[0].end, null);
  for (const connector of REPORT.connectors.filter(each => !each.set_up)) {
    assert.equal(foot(open(REPORT, HOST_STATE, connector.id)), null, connector.id);
  }
  for (const detail of everyDialog(null)) assert.equal(detail.foot?.end?.some((/** @type {any} */ act) => 'host' in act.do) ?? false, false);
});

test('N11: the act a need offers on its row and in its dialog, the home\'s', () => {
  const broken = REPORT.connectors.find(each => each.health.state === 'broken' && each.health.acts.length === 1);
  assert.ok(broken);
  const [act] = broken.health.acts;
  assert.equal(act.do, 'try');
  const doing = { home: { need: act.do === 'try' ? act.need : '', do: 'try' } };
  for (const state of [null, HOST_STATE]) {
    assert.deepEqual(faceOf(pageOf(REPORT, state, NONE), broken.id)?.act, { label: act.label, do: doing });
    const detail = open(REPORT, state, broken.id);
    assert.deepEqual([detail.callout.kind, detail.callout.title, detail.callout.acts, detail.ticking],
      ['warning', broken.health.words, [{ label: act.label, do: doing }], broken.health.next_ms !== null]);
  }
  const claude = open(REPORT, HOST_STATE, 'claude');
  assert.deepEqual(claude.callout.acts.map((/** @type {any} */ each) => [each.label, each.variant]),
    connectorIn('claude').health.acts.map((each, at) => [each.label, at === 0 ? 'primary' : 'secondary']));
  assert.equal(faceOf(pageOf(REPORT, HOST_STATE, NONE), 'claude')?.act, null);
  const body = bodyMarkup(pageOf(REPORT, null, NONE), AT_REST, '');
  const row = new RegExp(`<div class="ck-cline">(?:(?!<div class="ck-cline).)*?data-cn-open="${broken.id}"(?:(?!<div class="ck-cline).)*?`
    + '<span class="ck-cline__end">(<button[^]*?</button>)</span></div>', 'su').exec(body);
  assert.ok(row, 'the broken row with its act');
  assert.match(row[1], /ck-cline__act[^]*&quot;do&quot;:&quot;try&quot;/u);
  const pressed = { ...AT_REST, busy: new Set([JSON.stringify(doing)]) };
  assert.match(bodyMarkup(pageOf(REPORT, null, NONE), pressed, ''), /ck-cline__act[^"]*" type="button" disabled aria-busy="true"/u);
});

test('N12: the server\'s press other than the door\'s act', async () => {
  const home = await actHome({ door: null, importing: 'audio:unit' });
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-act-'));
  const door = openDoor({ url: home.url, token: () => 'stub-token' });
  const viewer = await createViewer({ door });
  const doorless = await createViewer();
  await new Promise(done => viewer.listen(0, '127.0.0.1', () => done(undefined)));
  await new Promise(done => doorless.listen(0, '127.0.0.1', () => done(undefined)));
  /**
   * @param {import('node:http').Server} server
   * @param {unknown} body
   * @param {Record<string, string>} [headers]
   */
  const press = async (server, body, headers = { 'Content-Type': 'application/json', 'X-Viewer-Request': '1' }) => {
    const response = await fetch(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}/api/act`,
      { method: 'POST', headers, body: JSON.stringify(body) });
    return [response.status, await response.json()];
  };
  try {
    assert.deepEqual(await press(viewer, { need: 'poll:gmail-imap', do: 'try' }), [200, { acted: 'queued' }]);
    assert.deepEqual(home.presses, [{ need: 'poll:gmail-imap', do: 'try', token: 'Bearer stub-token', answered: 200 }]);
    assert.notEqual((await press(viewer, { need: 'poll:gmail-imap', do: 'try' }))[0], 200);
    assert.equal(home.presses.at(-1)?.answered, 409);
    const [status, refused] = await press(viewer, { need: 'job:import:audio:unit', do: 'skip' });
    assert.equal(home.presses.at(-1)?.answered, 409);
    assert.notEqual(status, 200);
    assert.doesNotMatch(JSON.stringify(refused), /NOT_OFFERED|offers no/u);
    home.presses.length = 0;
    assert.equal((await press(viewer, { need: 'poll:gmail-imap', do: 'try' }, { 'Content-Type': 'application/json' }))[0], 403);
    assert.equal((await press(viewer, { need: 'poll:gmail-imap', do: 'run' }))[0], 400);
    for (const doing of ['read', 'ignore']) {
      home.presses.length = 0;
      await press(viewer, { need: 'offer:claude', do: doing, of: 'claude:person-b@example.com:browser' });
      assert.deepEqual(home.presses.map(each => [each.need, each.do, each.of]), [['offer:claude', doing, 'claude:person-b@example.com:browser']]);
    }
    home.presses.length = 0;
    await press(viewer, { need: 'import:a000000000000002:file:b9ab517384dca75a', do: 'let-go' });
    await press(viewer, { need: 'import:a000000000000003:whose', do: 'choose', account: ' person-a@example.com ' });
    assert.deepEqual(home.presses.map(({ need, do: doing, account }) => [need, doing, account]), [
      ['import:a000000000000002:file:b9ab517384dca75a', 'let-go', undefined],
      ['import:a000000000000003:whose', 'choose', 'person-a@example.com']]);
    home.presses.length = 0;
    for (const odd of [{ do: 'choose' }, { do: 'choose', account: ' ' }, { do: 'choose', account: 'person-a', of: 'x' },
      { do: 'choose', account: 'person-a', product: 'whatsapp' }, { do: 'choose', account: 'person-a', product: '' },
      { do: 'skip', account: 'person-a' }]) {
      assert.equal((await press(viewer, { need: 'import:a000000000000003:whose', ...odd }))[0], 400, JSON.stringify(odd));
    }
    assert.deepEqual(home.presses, []);
    home.presses.length = 0;
    await press(viewer, { need: 'fetch:gmail-imap:gmail:person-a@example.com:cloud', do: 'dismiss' });
    assert.deepEqual(home.presses.map(each => [each.need, each.do]), [['fetch:gmail-imap:gmail:person-a@example.com:cloud', 'dismiss']]);
    home.presses.length = 0;
    assert.equal((await press(viewer, { need: 'offer:claude', do: 'read', of: 7 }))[0], 400);
    assert.equal((await press(viewer, { need: '', do: 'try' }))[0], 400);
    assert.deepEqual(home.presses, []);
    assert.deepEqual(await press(doorless, { need: 'poll:gmail-imap', do: 'try' }),
      [503, { error: 'The dashboard has no read token for Lifestream. README says where it goes.' }]);
  } finally {
    door.close();
    await new Promise(done => viewer.close(() => done(undefined)));
    await new Promise(done => doorless.close(() => done(undefined)));
    await home.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('N28: a stream\'s form typed in its Set up page, its secret sealed by the home; none in a browser', () => {
  const vault = (/** @type {string} */ state) => ({ ...HOST_STATE, needs: [], vault: { state, saved_ms: null } });
  const kept = vault('saved');
  const fresh = changing('whoop', whoop => ({ ...whoop, set_up: false, account: null, copies: [],
    health: { ...whoop.health, state: 'setup', reason: 'form', acts: [], words: 'Set up WHOOP' },
    members: whoop.members.map(member => member.key === 'email' ? { ...member, value: null, words: '', from: 'unset' } : member),
    ways: [{ road: 'chrome', ready: false, requirements: [
      { kind: 'form', met: false, words: 'Set up WHOOP', act: { do: 'set', label: 'Set up', member: 'email' } },
      { kind: 'choose', met: false, words: 'Turn on WHOOP', act: { do: 'turn', label: 'Turn on', ids: ['whoop'] } }] }] }));
  /** @param {any} state */
  const here = state => open(fresh, state, 'whoop').connect.ways[0].rows.find((/** @type {any} */ row) => row.act)?.act;
  assert.deepEqual(here(kept), { label: 'Set up', do: { page: 'form' } });
  assert.deepEqual(here(vault('none')).do, { flow: 'vault', then: 'whoop', make: true }, 'the vault made first, then the page');
  assert.deepEqual(here(vault('unsaved')).do, { flow: 'vault', then: 'whoop', make: true }, 'a key never saved: the window first');
  for (const state of ['locked', 'lost']) assert.deepEqual(here(vault(state)).do, { host: { act: 'vault', do: 'unlock' } }, state);
  assert.equal(here(null), undefined, 'in a browser no act');
  assert.equal(open(fresh, null, 'whoop', { pages: ['form'] }).name, 'WHOOP', 'in a browser no page');
  const page = open(fresh, kept, 'whoop', { pages: ['form'] });
  assert.deepEqual([page.name, page.line, page.callout], ['Connect WHOOP', connectorIn('whoop').gives, null]);
  assert.deepEqual(page.signin.fields.map((/** @type {any} */ { why, ...field }) => field), [
    { key: 'whoop.email', label: 'WHOOP email', kind: 'email', value: '', placeholder: 'name@example.com', note: '' },
    { key: 'whoop.password', label: 'WHOOP password', kind: 'secret', value: '', placeholder: '', note: 'Kept encrypted on your Mac.' }]);
  const hinted = { ...fresh, connectors: fresh.connectors.map(each => each.id !== 'whoop' ? each : { ...each,
    members: each.members.map(member => member.key === 'email' ? { ...member, placeholder: 'The email you sign in to WHOOP with' } : member) }) };
  assert.equal(open(hinted, kept, 'whoop', { pages: ['form'] }).signin.fields[0].placeholder, 'The email you sign in to WHOOP with');
  assert.deepEqual(page.foot.end.map((/** @type {any} */ act) => [act.label, act.disabled, act.do]), [['Connect WHOOP', true, { form: 'whoop' }]]);
  const half = open(fresh, kept, 'whoop', { pages: ['form'], fields: { 'whoop.email': 'person-a@example.com' } });
  assert.equal(half.foot.end[0].disabled, true);
  const typed = open(fresh, kept, 'whoop', { pages: ['form'], fields: { 'whoop.email': 'person-a@example.com', 'whoop.password': 'synthetic-pass' } });
  assert.equal(typed.foot.end[0].disabled, false);
  const pressed = { ...OPENED, pages: ['form'], fields: { 'whoop.email': ' person-a@example.com ', 'whoop.password': ' synthetic-pass' } };
  assert.deepEqual(formActs(/** @type {any} */ (fresh.connectors.find(each => each.id === 'whoop')), pressed), [
    { act: 'setting', connector: 'whoop', member: 'email', value: 'person-a@example.com' },
    { act: 'seal', connector: 'whoop', member: 'password', value: ' synthetic-pass' },
    { act: 'turn', sources: ['whoop'], on: true }]);
  const now = { ...OPENED, pages: ['form'], fields: { 'whoop.email': 'person-b@example.com' } };
  assert.deepEqual(formAnswered(now, { pressed: 2, now: 2, refused: null }), { opened: { ...now, fields: {} }, back: true });
  assert.deepEqual(formAnswered(now, { pressed: 2, now: 2, refused: 'The vault refused it' }), { opened: { ...now, refused: 'The vault refused it' }, back: false });
  for (const refused of [null, 'The vault refused it']) assert.deepEqual(formAnswered(now, { pressed: 1, now: 2, refused }), { opened: now, back: false });
  const markup = detailMarkup(typed, AT_REST);
  assert.match(markup, /<input[^>]*type="email"[^>]*data-cn-field="whoop\.email"/u);
  assert.match(markup, /<input[^>]*type="password"[^>]*data-cn-field="whoop\.password"/u);
  const refused = open(fresh, kept, 'whoop', { pages: ['form'], refused: 'The vault refused it' });
  assert.deepEqual([refused.callout, refused.signin.fields.map((/** @type {any} */ field) => field.why)], [null, ['', 'The vault refused it']],
    'the refusal under the field it blames');
  assert.match(detailMarkup(refused, AT_REST), /data-cn-field="whoop\.password"[^]*The vault refused it/u);
  const rows = (/** @type {any} */ state) => open(REPORT, state, 'whoop').panels.flatMap((/** @type {any} */ panel) => panel.rows);
  assert.deepEqual(rows(kept).find((/** @type {any} */ row) => row.label === 'person-a@example.com').end,
    { acts: [{ label: 'Change', variant: 'secondary', do: { page: 'form' } }] });
  assert.deepEqual(rows(kept).filter((/** @type {any} */ row) => row.go?.do.page === 'form' || row.label.startsWith('WHOOP ')), []);
  assert.equal(rows(null).find((/** @type {any} */ row) => row.label === 'person-a@example.com').end, null);
  assert.deepEqual(open(REPORT, kept, 'whoop', { pages: ['form'] }).signin.fields.map((/** @type {any} */ field) => field.value),
    ['person-a@example.com', '']);
  const holding = changing('whoop', each => ({ ...each, members: each.members.map(member => member.control === 'secret' ? { ...member, held: true } : member) }));
  const account = open(holding, kept, 'whoop', { pages: ['form'] });
  assert.deepEqual([account.name, account.foot.end.map((/** @type {any} */ act) => [act.label, act.disabled])], ['Account', [['Save', false]]]);
  const whoop = connectorIn('whoop');
  assert.deepEqual(actOf({ do: 'set', label: 'Set', member: 'password' }, whoop, kept), { label: 'Set', do: { page: 'form' } });
});

test('N26: Needs you counts the home\'s badge and the Mac\'s own; each home need\'s Dismiss the home\'s', () => {
  assert.ok(REPORT.needs.every(need => !need.dismissed), 'the home leaves a dismissed need out');
  for (const state of [null, HOST_STATE]) {
    const alerts = needsOf(REPORT, state);
    assert.equal(alerts.length, REPORT.badge.needs + ownNeeds(REPORT, state).length);
    const home = alerts.filter(alert => alert.dismiss !== null && REPORT.needs.some(need => need.id === alert.id));
    assert.deepEqual(home.map(alert => alert.dismiss?.do), REPORT.needs.filter(need => need.weight === 'advice')
      .map(need => ({ home: { need: need.id, do: 'dismiss' } })), 'a × on advice alone');
  }
});

test('N27: the needs a fold of strips above the list, in the home\'s order, each its words and the act the home offers first', () => {
  for (const state of [null, HOST_STATE]) {
    const page = pageOf(REPORT, state, NONE);
    assert.deepEqual(page.alerts, needsOf(REPORT, state));
    const homes = new Set(REPORT.needs.map(need => need.id));
    assert.deepEqual(page.alerts.filter(alert => homes.has(alert.id)).map(alert => alert.id),
      REPORT.needs.filter(need => !need.banner).map(need => need.id), 'the home\'s order');
    for (const need of REPORT.needs) {
      const alert = page.alerts.find(each => each.id === need.id);
      assert.deepEqual([alert?.title, alert?.line], [need.words, need.line ?? ''], need.id);
    }
    const body = bodyMarkup(page, AT_REST, '');
    assert.equal((body.match(/class="ck-stack[ "]/gu) ?? []).length, 1, 'one stack');
    assert.equal((body.match(/class="ck-stack__sliver"/gu) ?? []).length, 2, 'two slivers under the folded first');
    assert.ok(body.indexOf('ck-stack') < body.indexOf('ck-cline__open'), 'the strips first');
    assert.ok(body.includes(`· ${page.alerts.length - 1} more`), 'folded into the first');
    for (const id of ['facebook', 'instagram', 'x', 'coast']) {
      assert.ok(!REPORT.connectors.some(each => each.id === id) && !body.includes(`data-cn-open="${id}"`), id);
    }
  }
  const claude = needsOf(REPORT, null).find(alert => alert.id === REPORT.needs.find(need => need.connector === 'claude')?.id);
  assert.equal(claude?.act?.label, REPORT.needs.find(need => need.connector === 'claude')?.acts[0]?.label);
});

test('N13, N19: a setting by its member\'s kind, a list its page, once set up; none in a browser', () => {
  for (const connector of DRAWN.filter(each => each.set_up)) {
    for (const state of [null, HOST_STATE]) {
      const detail = dialogOf(state, connector);
      const drawn = [...panelOf(detail, 'Settings')?.rows ?? [], ...panelOf(detail, 'History')?.rows ?? [],
        ...panelOf(detail, 'Groups')?.rows ?? []];
      for (const member of connector.members.filter(each => ['settings', 'backfill', 'groups'].includes(each.panel ?? ''))) {
        const row = drawn.find((/** @type {any} */ each) => each.label === member.label);
        assert.ok(row, `${connector.id}.${member.key}`);
        const end = endOf(row);
        const kind = member.kind === 'list' ? `> ${member.words}` : !state ? member.words
          : member.kind === 'choice' && member.steps?.length === 2 && member.steps.every(step => ['on', 'off'].includes(step.value))
            ? `switch ${member.value === 'on' ? 'on' : 'off'}`
          : member.steps || member.kind === 'start' ? `menu ${member.words}` : member.kind === 'zone' ? `menu ${member.words}`
            : member.kind === 'number' ? `stepper ${member.words}` : member.kind === 'toggle' ? `switch ${member.value ? 'on' : 'off'}`
              : member.kind === 'path' ? `${member.words} Choose` : member.words;
        assert.equal(end, kind, `${connector.id}.${member.key}`);
      }
    }
  }
  const calendar = connectorIn('google-calendar');
  const list = calendar.members.find(member => member.kind === 'list');
  assert.ok(list);
  const page = open(REPORT, HOST_STATE, 'google-calendar', { pages: [`list:${list.key}`], typed: ' Work ' });
  assert.deepEqual([page.name, page.line, page.back], [list.label, calendar.name, { label: `Back to ${calendar.name}` }]);
  assert.deepEqual(page.panels[0].add.enter, { host: { act: 'setting', connector: 'google-calendar', member: list.key,
    value: [...(Array.isArray(list.value) ? list.value : []), 'Work'] } });
  assert.equal(open(REPORT, null, 'google-calendar', { pages: [`list:${list.key}`] }).panels[0].add, null);
});

test('N30: which devices a setting is for, the home\'s line, under its label on Settings and History; the waiting line instead while one waits', () => {
  /**
   * @param {string} markup
   * @param {string} label
   */
  const under = (markup, label) => {
    const row = markup.split('<li').find(each => each.includes(`ck-srow__label">${label}<`)) ?? '';
    return [...row.matchAll(/ck-srow__wait">([^<]*)</gu)].map(match => match[1]);
  };
  const photos = connectorIn('apple-photos');
  const refresh = photos.members.find(member => member.key === 'refresh');
  assert.ok(refresh?.only, 'the fixture carries a member only some devices follow');
  for (const state of [null, HOST_STATE]) {
    assert.deepEqual(under(detailMarkup(open(REPORT, state, 'apple-photos'), AT_REST), refresh.label), [refresh.only]);
  }
  const waiting = [{ name: 'MacBook Air', kind: /** @type {const} */ ('mac'), line: 'Waiting for MacBook Air · It takes it when Lifestream runs there.' }];
  /** @param {{ only: string | null, waiting?: typeof waiting }} marks */
  const drawn = marks => detailMarkup(open(changing('screen-time',
    connector => ({ ...connector, members: connector.members.map(member =>
      ({ ...member, panel: member.key === 'start' ? 'backfill' : 'settings', ...marks })) })), HOST_STATE, 'screen-time'), AT_REST);
  const labelOf = (/** @type {string} */ key) => /** @type {string} */ (connectorIn('screen-time').members.find(member => member.key === key)?.label);
  const lines = (/** @type {string} */ markup) => [under(markup, labelOf('refresh')), under(markup, labelOf('start'))];
  assert.deepEqual(lines(drawn({ only: 'On MacBook Pro' })), [['On MacBook Pro'], ['On MacBook Pro']]);
  assert.deepEqual(lines(drawn({ only: 'On MacBook Pro', waiting })), [[waiting[0].line], [waiting[0].line]]);
  assert.deepEqual(lines(drawn({ only: null })), [[], []]);
});

test('N29: Other app… on Apps and sites with a host alone; This Mac\'s permissions the grants the host sends', () => {
  const screen = REPORT.connectors.find(each => each.members.some(member => member.items === 'modes'));
  const apps = screen?.members.find(member => member.items === 'modes');
  assert.ok(screen && apps);
  const pages = [`list:${apps.key}`];
  const holds = { connector: screen.id, member: apps.key };
  const chooser = { host: { act: 'choose-app' }, holds };
  for (const typed of ['', 'ke']) {
    assert.deepEqual(open(REPORT, HOST_STATE, screen.id, { pages, typed }).panels[0].add.end,
      { acts: [{ label: 'Other app…', variant: 'secondary', do: chooser }] });
  }
  const browser = open(REPORT, null, screen.id, { pages });
  assert.equal(browser.panels[0].add, null);
  assert.doesNotMatch(detailMarkup(browser, AT_REST), /Other app|choose-app/u);
  const drawn = open(REPORT, HOST_STATE, screen.id, { pages });
  const markup = detailMarkup(drawn, AT_REST);
  assert.match(markup, /ck-srow--add[^]*ck-srow__end[^]*Other app…/u);
  assert.ok(markup.includes(`data-cn-do="${esc(JSON.stringify(chooser))}"`));
  const A = { app: 'com.example.notes', mode: 'activity' };
  const X = { app: 'com.example.chosen', mode: 'activity' };
  /** @param {unknown[]} value */
  const holding = value => changing(screen.id, each => ({ ...each,
    members: each.members.map(member => member.key === apps.key ? { ...member, value } : member) }));
  const choosing = { ...AT_REST, busy: new Set([busyKey(chooser)]) };
  const edits = actsOf(open(holding([A]), HOST_STATE, screen.id, { pages, typed: 'ke' }));
  assert.ok(edits.some(act => act.do.host?.act === 'setting') && edits.some(act => act.do.host?.act === 'choose-app'));
  assert.ok(edits.every(act => busyWith(act, choosing)), 'every edit of the list waits while an app is chosen');
  const setting = edits.find(act => act.do.host?.act === 'setting');
  assert.equal(busyKey(setting.do), busyKey(chooser));
  assert.match(detailMarkup(open(holding([A]), HOST_STATE, screen.id, { pages }), choosing),
    /aria-busy="true"[^>]*>[^]*Other app…/u);
  const before = holding([A]);
  const change = /** @type {import('../public/ui/connectors/pending.js').Pending} */ (pendingOf({ act: 'choose-app' },
    { report: before, models: null, hiding: null }, holds));
  assert.equal(appAdded({ notice: 'Example Chosen added.', added: true }), true);
  assert.equal(settled(change, { report: before, models: null, hiding: null }), false);
  assert.equal(settled(change, { report: holding([A, X]), models: null, hiding: null }), true, 'a report read after the choice');
  assert.equal(appAdded({ notice: 'Example Notes is already listed.' }), false);
  assert.equal(appAdded({ notice: 'Example Chosen added.' }), false, 'the words alone are never read');
  assert.equal(appAdded({}), false);
  /** @param {any} state */
  const thisMac = state => open(REPORT, state, SETTINGS_MAC);
  /** @param {any} detail */
  const permissions = detail => detail.parts.find((/** @type {any} */ part) => part.label === 'Permissions')
    .panel.rows.map((/** @type {any} */ row) => row.label);
  /** @param {any} detail */
  const allowAll = detail => detail.parts.flatMap((/** @type {any} */ part) => part.acts)
    .find((/** @type {any} */ act) => act.label === 'Allow all')?.do.host.grants ?? null;
  const sent = thisMac(HOST_STATE);
  assert.deepEqual(permissions(sent), HOST_STATE.grants.map(grant => grant.title));
  assert.deepEqual(allowAll(sent), HOST_STATE.grants.filter(grant => !grant.granted && !grant.optional).map(grant => grant.id));
  const one = { ...HOST_STATE, grants: HOST_STATE.grants.map(grant => ({ ...grant, granted: grant.id !== 'fullDiskAccess' })) };
  assert.deepEqual([permissions(thisMac(one)), allowAll(thisMac(one))], [HOST_STATE.grants.map(grant => grant.title), null]);
});

test('N21, N25: To connect as the home sends each way; a sign-in by its route; N22 no way back into the onboarding', () => {
  const vault = (/** @type {string} */ state) => ({ ...HOST_STATE, needs: [], vault: { state, saved_ms: null } });
  for (const connector of REPORT.connectors.filter(each => !each.set_up)) {
    for (const state of [null, vault('saved')]) {
      const detail = open(REPORT, state, connector.id);
      assert.deepEqual(detail.connect.ways.map((/** @type {any} */ way) => way.rows.map((/** @type {any} */ row) => [row.name, row.mark])),
        connector.ways.map(way => {
          const first = way.requirements.findIndex(requirement => !requirement.met);
          return way.requirements.map((requirement, at) => [requirement.words, requirement.met ? 'done' : at === first ? 'here' : 'idle']);
        }));
      assert.deepEqual(detail.connect.ways.map((/** @type {any} */ way) => way.label),
        connector.ways.map((_, at) => at === 0 ? 'To connect' : 'Or'));
      const acts = detail.connect.ways.flatMap((/** @type {any} */ way) => way.rows.filter((/** @type {any} */ row) => row.act));
      assert.ok(acts.every((/** @type {any} */ row) => row.mark === 'here'));
      if (!state) assert.ok(acts.every((/** @type {any} */ row) => 'open' in row.act.do), connector.id);
    }
  }
  const granola = connectorIn('granola');
  const signin = granola.ways.flatMap(way => way.requirements).find(requirement => requirement.act?.do === 'signin');
  assert.ok(signin?.act?.do === 'signin');
  const route = granola.routes.find(each => each.id === /** @type {any} */ (signin.act).of);
  assert.ok(route);
  /** @param {any} state */
  const here = state => open(REPORT, state, 'granola').connect.ways[0].rows.find((/** @type {any} */ row) => row.act)?.act;
  assert.deepEqual(here(vault('saved')).do, { host: { act: 'sheet', connector: 'granola', route: route.id } });
  assert.deepEqual(here(vault('none')).do, { flow: 'vault', then: 'granola', make: true });
  for (const state of ['locked', 'lost']) assert.deepEqual(here(vault(state)).do, { host: { act: 'vault', do: 'unlock' } }, state);
  const signedOut = changing('gmail', gmail => ({ ...gmail, health: { ...gmail.health, state: 'needs-you', reason: 'signed-out',
    words: 'Sign in to Gmail again', acts: [{ do: 'signin', label: 'Sign in', of: 'gmail-imap' }] } }));
  const sheet = { host: { act: 'sheet', connector: 'gmail', route: 'gmail-imap' } };
  assert.deepEqual(open(signedOut, vault('saved'), 'gmail').callout.acts.map((/** @type {any} */ act) => act.do), [sheet]);
  const choice = open(REPORT, vault('saved'), 'granola', { pages: ['signin'] });
  assert.deepEqual(choice.panels[0].rows.map((/** @type {any} */ row) => [row.label, row.line]),
    granola.routes.map(each => [each.label, each.about ?? '']));
  assert.equal(open(REPORT, { ...vault('saved'), signins: ['key'] }, 'granola', { pages: ['signin'] }).name, granola.name);
  for (const state of [null, HOST_STATE]) {
    const needs = needsOf(REPORT, state);
    for (const need of REPORT.needs.filter(each => each.acts.length && each.acts.every(act => act.do === 'grant'))) {
      assert.equal(needs.find(alert => alert.id === need.id)?.act, null, need.id);
    }
  }
  const mine = { do: /** @type {const} */ ('grant'), label: 'Allow', unit: HOST_STATE.unit ?? '', grant: 'photos' };
  assert.deepEqual(actOf(mine, null, HOST_STATE), { label: 'Allow', do: { host: { act: 'allow', grants: ['photos'] } } });
  assert.equal(actOf(mine, null, null), null);
  assert.ok(!everyAct(HOST_STATE).some(act => JSON.stringify(act.do).includes('onboarding')));
  assert.equal('elsewhere' in /** @type {object} */ (open(REPORT, null, 'granola')), false);
});

test('N31: the setup\'s photo streams and Mac sources, a profile\'s switch, the sidebar\'s routes are the report\'s; no client page names a connector', async () => {
  const library = { ...connectorIn('apple-photos'), id: 'library-a', product: 'library-a' };
  assert.deepEqual(library.mac_grants, ['photos'], 'the fixture\'s photos stream asks the photos grant');
  const renamed = { ...REPORT, connectors: REPORT.connectors.map(each => each.id === 'apple-photos' ? library : each),
    setup: { skipped: [], at: null, you: true } };
  assert.deepEqual(photoStreams({ state: HOST_STATE, report: renamed }).map(each => each.id), ['library-a']);
  assert.equal(macSources({ state: HOST_STATE, report: renamed }, new Map()).some(source => source.id === 'library-a'), false);
  assert.equal(footRoute(REPORT), null, 'the canned homes\' Screen is no recorder');
  assert.equal(footRoute({ ...REPORT, connectors: REPORT.connectors.map(each => each.id === 'screen' ? { ...each, id: 'recorder-a', recorder: true } : each) }),
    '#dialog=recorder-a');
  assert.equal(footRoute(null), null);
  const base = connectorIn('screen-time');
  const copyOf = (/** @type {string} */ id, /** @type {string} */ unit) => ({ ...base.copies[0] ?? {}, id, unit, on: true, held: 40, line: '40 pages' });
  const browser = { ...base, id: 'browser-a', product: 'browser-a', sensor: false, mac_grants: [], shown: 'stream', roads: ['mac'],
    mac_copy: 'browser-a:<account>:macbook-pro-0001',
    copies: [copyOf('browser-a:profile-1:macbook-pro-0001', 'macbook-pro-0001'), copyOf('browser-a:profile-1:macbook-air-bb07', 'macbook-air-bb07')] };
  const state = { ...HOST_STATE, browsers: [{ id: 'browser-a', name: 'Browser A', profiles: [{ id: 'profile-1', name: 'One' }, { id: 'profile-2', name: 'Two' }] }] };
  assert.equal(macSources({ state, report: { ...REPORT, connectors: [...REPORT.connectors, /** @type {any} */ (browser)] } }, new Map())
    .some(source => source.id === 'browser-a'), false, 'a browser the Mac reads is its own, never a source on the mac screen');
  const store = (/** @type {string} */ state) => ({ ...base, id: 'store-a', product: 'store-a', sensor: false, mac_grants: [], shown: 'stream', roads: ['mac'],
    mac_copy: null, figure: { today: 0, week: [0, 0, 0, 0, 0, 0, 0], checked_ms: AT, words: 'Checked', last_ms: null, last: null },
    copies: [{ ...copyOf('store-a:person-a:macbook-pro-0001', 'macbook-pro-0001'), held: 0, line: 'Nothing yet',
      health: { ...base.health, state, reason: state === 'broken' ? 'import' : null } }] });
  const shown = (/** @type {string} */ state) => macSources({ state: HOST_STATE,
    report: { ...REPORT, connectors: [...REPORT.connectors, /** @type {any} */ (store(state))] } }, new Map()).some(source => source.id === 'store-a');
  assert.equal(shown('ok'), false, 'a store read and found empty is no source on the mac screen');
  assert.equal(shown('broken'), true, 'a store whose every delivery the home refused is no store read empty');
  for (const file of ['../public/ui/onboarding/model.js', '../public/ui/onboarding/view.js', '../public/ui/sections.js',
    '../public/ui/places/section.js', '../public/ui/places/naming.js']) {
    const code = (await readFile(new URL(file, import.meta.url), 'utf8')).split('\n')
      .filter(line => !/^\s*(?:\/\/|\/?\*)/u.test(line)).join('\n');
    assert.doesNotMatch(code, /apple-photos|dialog=screen|\.google\b|google ===|\}:\$\{[^}]*unit\}/u, file);
  }
});

test('Lifestream holds no Model row: a model is Settings\'', () => {
  /** @param {Partial<typeof HOST_STATE.ask_login>} login */
  const labels = login => JSON.parse(JSON.stringify(open(REPORT, { ...HOST_STATE, ask_login: { ...HOST_STATE.ask_login, ...login } }, SETTINGS_HOME)))
    .parts.flatMap((/** @type {any} */ part) => part.panel?.rows ?? []).map((/** @type {any} */ row) => row.label);
  const signed = { ...HOST_STATE.ask_login.claude, state: 'signed_in', account: 'person-a@example.com' };
  for (const login of [{}, { claude: signed }]) {
    assert.equal(labels(login).includes('Model'), false);
  }
  assert.equal(JSON.stringify(open(REPORT, HOST_STATE, SETTINGS_HOME)).includes('"flow":"model"'), false);
});

test('A flow whose host names fewer items: leaving cancels the subscriptions it shows under way, never one it does not show', async () => {
  const kept = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, { window: { addEventListener: () => undefined, setTimeout, clearTimeout }, document: { hasFocus: () => false } });
  try {
    const { flowFrame } = await import('../public/ui/flows/frame.js');
    const { sessionOf } = await import('../public/ui/flows/model.js');
    const signing = { ...HOST_STATE.ask_login.claude, state: 'signing_in', attempt: 'an-attempt' };
    const seen = { state: { ...HOST_STATE, ask_login: { chatgpt: signing, claude: signing } }, report: REPORT };
    /** @type {unknown[]} */
    const quiet = [];
    /** @param {import('../public/ui/flows/model.js').ModelItem[]} models */
    const left = models => {
      quiet.length = 0;
      const frame = flowFrame({ session: sessionOf(true, 'dialog'), reports: /** @type {any} */ ({ seen }), draw: () => undefined,
        shown: () => true, root: () => null, runner: /** @type {any} */ ({ quiet: (/** @type {unknown} */ act) => void quiet.push(act), act: async () => null }) });
      frame.open('model', { models });
      frame.tick();
      frame.close();
      return [...quiet];
    };
    assert.deepEqual(left([]), []);
    assert.deepEqual(left(['claude']), [{ act: 'ask-login', do: 'cancel', of: 'claude' }]);
    assert.deepEqual(left(['chatgpt', 'claude']), [{ act: 'ask-login', do: 'cancel', of: 'claude' }, { act: 'ask-login', do: 'cancel', of: 'chatgpt' }]);
  } finally {
    for (const [name, value] of Object.entries(kept)) {
      if (value === undefined) delete (/** @type {Record<string, unknown>} */ (globalThis))[name];
      else Object.assign(globalThis, { [name]: value });
    }
  }
});

test('The browser step names the account a site is signed in as before anything of it is read: its email, or the name a site that shows none greets the person by', async () => {
  const { browserSites, flowOf, sessionOf } = await import('../public/ui/flows/model.js');
  const signedIn = (/** @type {Record<string, unknown>} */ accounts) => ({ ...REPORT, connectors: REPORT.connectors.map(each => each.id in accounts
    ? { ...each, chosen: false, signed_in: true, checking: false, chrome_account: /** @type {any} */ (accounts[each.id]) } : each) });
  const report = signedIn({ chatgpt: { email: 'person-a@example.com', verdict: 'read' }, claude: { name: 'Person A', verdict: 'read' } });
  const seen = /** @type {any} */ ({ state: HOST_STATE, report });
  const sites = browserSites(seen).filter(site => site.id === 'chatgpt' || site.id === 'claude');
  assert.deepEqual(sites.map(site => [site.id, site.state, site.account]), [['chatgpt', 'in', 'person-a@example.com'], ['claude', 'in', 'Person A']]);
  const lines = (/** @type {any} */ given) => flowOf('browser', given, sessionOf(true, 'dialog'), AT).lists
    .find(list => list.label === 'Its sites')?.items.filter(item => item.id === 'chatgpt' || item.id === 'claude').map(item => item.line);
  assert.deepEqual(lines(seen), ['Signed in to ChatGPT as person-a@example.com in Chrome', 'Signed in to Claude as Person A in Chrome']);
  assert.deepEqual(lines({ state: HOST_STATE, report: signedIn({ chatgpt: null, claude: null }) }), ['Signed in to ChatGPT in Chrome', 'Signed in to Claude in Chrome']);
});

test('The browser step with no Chrome-family browser lists every site Chrome brings, a site with its own sign-in form too, and the Devices row names the same sites', async () => {
  const { flowOf, sessionOf } = await import('../public/ui/flows/model.js');
  const chatgpt = /** @type {any} */ (REPORT.connectors.find(each => each.id === 'chatgpt'));
  const whoop = { ...chatgpt, id: 'whoop', name: 'WHOOP', gives: 'Your sleep, recovery and strain.', routes: [],
    members: [{ key: 'password', panel: 'account', control: { kind: 'secret' } }] };
  const report = { ...REPORT, extension: { ...REPORT.extension, present: false, browsers: [] },
    connectors: [...REPORT.connectors.filter(each => each.id !== 'whoop'), whoop].map(each => ({ ...each, chosen: false })) };
  const seen = /** @type {any} */ ({ state: { ...HOST_STATE, browsers: [] }, report });
  const flow = flowOf('browser', seen, sessionOf(true, 'dialog'), AT);
  const ids = flow.lists.find(list => list.label === 'Its sites')?.items.map(item => item.id) ?? [];
  assert.deepEqual(['chatgpt', 'claude', 'whoop'].filter(id => ids.includes(id)), ['chatgpt', 'claude', 'whoop']);
  assert.deepEqual(ids, report.connectors.filter(each => each.roads.includes('chrome')).map(each => each.id), 'only what Chrome brings');
  const named = flow.lists.find(list => list.label === 'Its sites')?.items.map(item => item.name) ?? [];
  const row = viewOf(report, seen.state, NONE).side.find(each => each.id === SETTINGS_CHROME);
  assert.equal(row?.line, `Your ${named.length > 3 ? `${named.slice(0, 2).join(', ')} and ${named.length - 2} more`
    : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`} history`);
  assert.ok(row?.line?.includes('WHOOP'), row?.line ?? '');
});

test('The browser step says a site the browser does not let the extension on yet is not allowed, never that its sign-in could not be told, and its Connect is where the browser asks', async () => {
  const { browserSites, flowOf, sessionOf } = await import('../public/ui/flows/model.js');
  const state = { ...HOST_STATE, browsers: [{ id: 'chrome', name: 'Chrome', profiles: [] }] };
  const allowing = (/** @type {boolean | null} */ allowed) => /** @type {any} */ ({ state, report: { ...REPORT, connectors: REPORT.connectors
    .map(each => each.id === 'chatgpt' ? { ...each, chosen: false, signed_in: null, checking: false, allowed,
      browser: { unit: 'chrome-00000001', name: 'Chrome' }, origin: 'https://chatgpt.com',
      ways: [{ road: 'chrome', ready: false, requirements: [{ kind: 'choose', met: false, act: { do: 'turn', ids: ['chatgpt'] }, words: 'Turn on ChatGPT in Chrome' }] }] } : each) } });
  const row = (/** @type {any} */ seen) => {
    const item = flowOf('browser', seen, sessionOf(true, 'dialog'), AT).lists.find(list => list.label === 'Its sites')?.items.find(each => each.id === 'chatgpt');
    return { state: browserSites(seen).find(site => site.id === 'chatgpt')?.state, line: item?.line, act: item?.act?.label, disabled: item?.act?.disabled === true };
  };
  assert.deepEqual(row(allowing(false)), { state: 'withheld', line: 'Lifestream isn’t allowed on ChatGPT in Chrome yet', act: 'Connect', disabled: false });
  for (const allowed of [true, null]) {
    assert.deepEqual(row(allowing(allowed)), { state: 'unsure', line: 'Couldn’t tell if you’re signed in to ChatGPT in Chrome', act: 'Sign in', disabled: false });
  }
});

test('N32: the list\'s last row gives a coding agent the home\'s line with the search in it', () => {
  const { prompt, blank } = REPORT.adding;
  assert.ok(prompt.includes(blank), 'the fixture\'s prompt has its blank');
  const page = pageOf(REPORT, HOST_STATE, NONE);
  assert.deepEqual(page.entry, { prompt, open: false }, 'with no search the blank is left for the person, and the line waits to be pressed');
  const markup = bodyMarkup(page, AT_REST, '');
  const entryAt = markup.indexOf('data-cn-area="adding"');
  assert.ok(entryAt > 0, 'no entry row');
  const areas = [...markup.matchAll(/data-cn-area="([^"]+)"/gu)].map(match => match[1]);
  assert.equal(areas.at(-1), 'adding', `the entry row is not last: ${areas.join(', ')}`);
  assert.match(markup.slice(entryAt), /Not here\?/u);
  assert.match(markup.slice(entryAt), /Your coding agent can build it on your Mac\./u);
  assert.doesNotMatch(markup, /data-cn-copy/u, 'the line shown before it was pressed');
  assert.equal(pageOf(null, HOST_STATE, NONE).entry, null, 'an entry row before the report is read');
  const press = /** @type {RegExpMatchArray} */ (markup.slice(entryAt).match(/data-cn-do="([^"]*)"/u));
  assert.deepEqual(JSON.parse(press[1].replaceAll('&quot;', '"')), { fold: 'adding' });
  assert.match(markup.slice(entryAt), /aria-expanded="false"/u);

  const searched = pageOf(REPORT, HOST_STATE, { ...NONE, query: '  Obsidian ' }, { adding: true });
  assert.equal(searched.empty, 'No connectors match.');
  assert.deepEqual(searched.entry, { prompt: prompt.replaceAll(blank, 'Obsidian'), open: true });
  assert.ok(!searched.entry?.prompt.includes(blank), 'the blank left in a searched line');
  assert.ok(searched.entry?.prompt.includes('add a connector for Obsidian;'), searched.entry?.prompt);
  const shown = bodyMarkup(searched, AT_REST, '');
  assert.ok(shown.indexOf('No connectors match.') < shown.indexOf('data-cn-area="adding"'), 'the entry row before what the search says');
  assert.ok(shown.includes(`data-cn-copy="${esc(searched.entry?.prompt ?? '')}"`), 'the copy is not the line shown');
  assert.ok(shown.includes(`>${esc(searched.entry?.prompt ?? '')}</span>`), 'the line not shown');
  assert.match(shown, /aria-expanded="true"/u);
  const empty = pageOf(REPORT, HOST_STATE, { ...NONE, query: 'Obsidian' });
  assert.deepEqual(empty.entry, { prompt: prompt.replaceAll(blank, 'Obsidian'), open: false });
  assert.match(bodyMarkup(empty, AT_REST, ''), /data-cn-area="adding"/u);
  const found = REPORT.connectors.find(each => each.shown === 'stream' && !each.set_up);
  assert.ok(found, 'the fixture has a stream to add');
  const finds = pageOf(REPORT, HOST_STATE, { ...NONE, query: found.name }, { adding: true });
  assert.ok(finds.count > 0);
  assert.equal(finds.entry?.prompt, prompt.replaceAll(blank, found.name));
  assert.deepEqual(pageOf(REPORT, null, { ...NONE, query: 'Obsidian' }, { adding: true }).entry, searched.entry);
  const dollars = 'a$&b $\' $` $$';
  const typed = pageOf(REPORT, HOST_STATE, { ...NONE, query: dollars }, { adding: true }).entry?.prompt ?? '';
  assert.equal(typed, prompt.split(blank).join(dollars));
  assert.ok(typed.includes(`add a connector for ${dollars};`), typed);
});

test('N33: a flow\'s act that did not land is said as the kit\'s in-place line says it, never sent until the home answers again', async () => {
  const kept = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, { window: { addEventListener: () => undefined, setTimeout, clearTimeout }, document: { hasFocus: () => false } });
  try {
    const { actRunner } = await import('../public/ui/flows/frame.js');
    const { Refusal } = await import('../public/lib/host.js');
    const { NOT_SENT, UNKNOWN } = await import('../public/lib/reach.js');
    /** @type {((state: any) => void)[]} */
    const following = [];
    /** @type {Error[]} */
    const meets = [];
    const host = /** @type {any} */ ({
      state: { reach: { state: 'unreachable', revision: 3 } },
      act: async () => { throw meets.shift(); },
      follow: (/** @type {(state: any) => void} */ then) => {
        following.push(then);
        return () => undefined;
      },
    });
    const session = { busy: new Set(), failure: /** @type {{ key: string, words: string } | null} */ (null) };
    const runner = actRunner(host, session, { draw: () => undefined, reports: /** @type {any} */ ({}), name: 'test' });
    meets.push(new Refusal('The app\'s own words.', 'not-sent'));
    assert.equal(await runner.act({ act: 'sheet', id: 'a' }, 'sheet:a'), null);
    assert.deepEqual(session.failure, { key: 'sheet:a', words: NOT_SENT });
    for (const then of following) then({ reach: { state: 'answering', revision: 3 } });
    assert.deepEqual(session.failure, { key: 'sheet:a', words: NOT_SENT }, 'gone before the home answered again');
    for (const then of following) then({ reach: { state: 'answering', revision: 4 } });
    assert.equal(session.failure, null, 'kept past the recovery');
    meets.push(new Refusal('', 'unknown'), new Refusal('Lifestream is busy.', 'refused'), new Refusal('', 'refused'));
    await runner.act({ act: 'sheet', id: 'a' }, 'sheet:a');
    assert.deepEqual(session.failure, { key: 'sheet:a', words: UNKNOWN });
    await runner.act({ act: 'sheet', id: 'a' }, 'sheet:a');
    assert.deepEqual(session.failure, { key: 'sheet:a', words: 'Lifestream is busy.' });
    await runner.act({ act: 'sheet', id: 'a' }, 'sheet:a');
    assert.deepEqual(session.failure, { key: 'sheet:a', words: 'Lifestream didn\'t take this.' });
  } finally {
    Object.assign(globalThis, kept);
  }
});

test('the vault step unlocks a locked or lost vault and opens the window for none or unsaved', async () => {
  const { flowOf, sessionOf } = await import('../public/ui/flows/model.js');
  const actOf = (/** @type {string} */ state) => flowOf('vault', /** @type {any} */ ({ state: { ...HOST_STATE, vault: { state, saved_ms: null } }, report: null }), sessionOf(true, 'step'), AT)
    .lists.flatMap((/** @type {any} */ list) => list.items).find((/** @type {any} */ item) => item.id === 'vault')?.act;
  for (const state of ['locked', 'lost']) assert.deepEqual([actOf(state)?.label, actOf(state)?.key], ['Unlock', 'vault-unlock'], state);
  for (const state of ['none', 'unsaved']) assert.deepEqual([actOf(state)?.label, actOf(state)?.key], ['Create', 'vault-open'], state);
});

test('Devices: an iPhone and Chrome not yet added wait in the side column as rows that open their flows, on the Mac only', () => {
  const bare = { ...REPORT, devices: REPORT.devices.filter(device => device.kind !== 'phone'),
    extension: { ...REPORT.extension, present: false }, connectors: REPORT.connectors.map(each => ({ ...each, chosen: false })) };
  const page = pageOf(bare, HOST_STATE, NONE);
  assert.deepEqual(page.side.filter(row => row.wanted).map(row => [row.name, row.wanted?.flow, row.wanted?.label]),
    [['iPhone', 'phone', 'Connect'], ['Chrome', 'browser', 'Add']]);
  const markup = sideMarkup(page);
  assert.match(markup, /aria-label="Devices" data-tour="devices"/u);
  assert.match(markup, /class="cn-device cn-device--wanted"[^>]*data-cn-flow="phone"/u);
  assert.match(markup, /class="cn-device cn-device--wanted"[^>]*data-cn-flow="browser"/u);
  assert.deepEqual(pageOf(bare, null, NONE).side.filter(row => row.wanted), [], 'a browser with no Mac offers neither');
  assert.deepEqual(pageOf(REPORT, HOST_STATE, NONE).side.filter(row => row.wanted), [], 'paired and added: no placeholder');
});

test('The iPhone dialog: three reasons, the pairing code beside four steps with Get the app above it, the reach in one sentence; Get the app turns it to the app’s code and I have the app back', async () => {
  const { flowOf, GET_APP, sessionOf } = await import('../public/ui/flows/model.js');
  const state = { ...HOST_STATE, phone_app: { link: 'https://testflight.apple.com/join/example', qr: 'data:image/png;base64,AA' },
    pairing: { link: 'lifestream://pair/example', code: 'ABCD2345', qr: 'data:image/png;base64,BB', why: null, match: null,
      expires_ms: AT + 60_000 } };
  const seen = /** @type {any} */ ({ state, report: { ...REPORT, devices: REPORT.devices.filter(device => device.kind !== 'phone') } });
  const session = sessionOf(true, 'dialog');
  const pairing = flowOf('phone', seen, session, AT);
  assert.deepEqual(pairing.reasons.map(reason => reason.title), ['Your location', 'Health and movement', 'Ask and access']);
  assert.deepEqual(pairing.guide?.steps.map(step => [step.words, step.state]), [['Scan the code', 'now'], ['Pair with this Mac', 'ahead'],
    ['Choose what to send', 'ahead'], ['Allow what you want', 'ahead']], 'nothing ticked before the phone does it');
  assert.equal(pairing.guide?.qr, state.pairing.qr);
  assert.deepEqual([pairing.guide?.get?.label, pairing.guide?.get?.key, pairing.guide?.get?.variant], [GET_APP, 'phone-app', 'link']);
  assert.equal(GET_APP, 'Get the app');
  assert.equal(pairing.primary, null, 'Get the app is the one way to the app’s code');
  assert.equal(pairing.note?.words, 'Your iPhone needs to be on the same Wi‑Fi as this Mac, or have Tailscale on both.');
  const app = flowOf('phone', seen, { ...session, part: 'app' }, AT);
  assert.deepEqual(app.guide?.steps.map(step => [step.words, step.state]), [[GET_APP, 'now'], ['Scan the code', 'ahead'],
    ['Pair with this Mac', 'ahead'], ['Choose what to send', 'ahead'], ['Allow what you want', 'ahead']]);
  assert.equal(app.guide?.qr, state.phone_app.qr);
  assert.equal(app.guide?.get, null);
  assert.equal(app.primary?.label, 'I have the app');
  const bare = flowOf('phone', /** @type {any} */ ({ ...seen, state: { ...state, phone_app: null } }), session, AT);
  assert.deepEqual([bare.guide?.qr, bare.guide?.get, bare.primary], [state.pairing.qr, null, null], 'no app link: the code alone');
});
