import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { esc } from '../public/lib/html.js';
import { counted } from '../public/lib/words.js';
import { HOST_STATE, REPORT } from '../public/kit-gallery-report.js';
import { endOf, needsOf, ownNeeds } from '../public/ui/connectors/page.js';
import { wholePage as pageOf } from './stand-ins/whole-page.mjs';
import { detailOf, OPENED } from '../public/ui/connectors/dialog.js';
import { AT_REST, bodyMarkup, sideMarkup } from '../public/ui/connectors/view.js';
import { detailMarkup } from '../public/ui/connectors/detail.js';
import { SETTINGS_CHROME, SETTINGS_HOME, SETTINGS_IPHONE, SETTINGS_MAC } from '../public/ui/connectors/settings.js';
import { STATE_LOOKS, stateShape } from '../public/ui/kit/connector-row.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '../../homelink/Tests/Fixtures');
const TYPES = join(here, '../public/types.d.ts');

/** @type {import('../public/ui/connectors/page.js').Filter} */
const CONNECTED = { query: '', place: '' };

/**
 * @param {string} name
 * @param {unknown[]} values
 */
function decode(name, values) {
  const program = ts.createProgram([TYPES], { strict: true, noEmit: true, skipLibCheck: true });
  const checker = program.getTypeChecker();
  const file = /** @type {ts.SourceFile} */ (program.getSourceFile(TYPES));
  const declared = file.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === name);
  assert.ok(declared, `public/types.d.ts declares ${name}`);
  const root = checker.getTypeAtLocation(/** @type {ts.InterfaceDeclaration} */ (declared).name);
  /** @type {string[]} */
  const wrong = [];
  const named = new Set();
  const carried = new Set();

  /** @param {ts.Symbol} member */
  const typeOf = member => checker.getTypeOfSymbol(member);
  /** @param {ts.Type} type */
  const literal = type => type.isStringLiteral() || type.isNumberLiteral() ? type.value
    : type.flags & ts.TypeFlags.BooleanLiteral ? checker.typeToString(type) === 'true' : undefined;
  /** @param {ts.Type} type */
  const parts = type => type.isUnion() ? type.types : [type];

  /**
   * @param {unknown} value
   * @param {ts.Type} type
   */
  const fits = (value, type) => {
    const before = wrong.length;
    walk(value, type, '', false);
    const ok = wrong.length === before;
    wrong.length = before;
    return ok;
  };

  /**
   * @param {unknown} value
   * @param {ts.Type} type
   * @param {string} path
   * @param {boolean} [counting]
   */
  function walk(value, type, path, counting = true) {
    if (type.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) return;
    const options = parts(type);
    if (value === null) {
      if (!options.some(each => each.flags & ts.TypeFlags.Null)) wrong.push(`${path}: null where the types say ${checker.typeToString(type)}`);
      return;
    }
    const kept = options.filter(each => !(each.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
    if (kept.length > 1) {
      const matching = kept.filter(each => fits(value, each));
      if (!matching.length) {
        wrong.push(`${path}: ${JSON.stringify(value).slice(0, 80)} is none of ${checker.typeToString(type)}`);
        return;
      }
      walk(value, matching[0], path, counting);
      return;
    }
    const one = kept[0];
    if (!one) {
      wrong.push(`${path}: a value where the types say ${checker.typeToString(type)}`);
      return;
    }
    const exact = literal(one);
    if (exact !== undefined) {
      if (value !== exact) wrong.push(`${path}: ${JSON.stringify(value)} is not ${JSON.stringify(exact)}`);
      return;
    }
    if (one.flags & ts.TypeFlags.String) {
      if (typeof value !== 'string') wrong.push(`${path}: ${JSON.stringify(value)} is no string`);
      return;
    }
    if (one.flags & ts.TypeFlags.Number) {
      if (typeof value !== 'number') wrong.push(`${path}: ${JSON.stringify(value)} is no number`);
      return;
    }
    if (one.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) {
      if (typeof value !== 'boolean') wrong.push(`${path}: ${JSON.stringify(value)} is no boolean`);
      return;
    }
    if (checker.isTupleType(one)) {
      const elements = checker.getTypeArguments(/** @type {ts.TypeReference} */ (one));
      if (!Array.isArray(value) || value.length !== elements.length) {
        wrong.push(`${path}: ${JSON.stringify(value)} is not ${checker.typeToString(one)}`);
        return;
      }
      value.forEach((each, at) => walk(each, elements[at], `${path}[${at}]`, counting));
      return;
    }
    if (checker.isArrayType(one)) {
      if (!Array.isArray(value)) {
        wrong.push(`${path}: ${JSON.stringify(value).slice(0, 80)} is no list`);
        return;
      }
      const element = checker.getTypeArguments(/** @type {ts.TypeReference} */ (one))[0];
      for (const each of value) walk(each, element, `${path}[]`, counting);
      return;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      wrong.push(`${path}: ${JSON.stringify(value).slice(0, 80)} is not ${checker.typeToString(one)}`);
      return;
    }
    const record = checker.getIndexInfosOfType(one)[0];
    const members = checker.getPropertiesOfType(one);
    if (record && !members.length) {
      for (const each of Object.values(value)) walk(each, record.type, `${path}{}`, counting);
      return;
    }
    const held = /** @type {Record<string, unknown>} */ (value);
    for (const key of Object.keys(held)) {
      const member = one.getProperty(key);
      if (!member) {
        wrong.push(`${path}.${key}: carried, and the types name no such member`);
        continue;
      }
      if (counting) carried.add(`${path}.${key}`);
      walk(held[key], typeOf(member), `${path}.${key}`, counting);
    }
    for (const member of members) {
      if (counting) named.add(`${path}.${member.name}`);
      const optional = (member.flags & ts.SymbolFlags.Optional) !== 0;
      if (!optional && !(member.name in held)) wrong.push(`${path}.${member.name}: named by the types, missing here`);
    }
  }

  for (const value of values) walk(value, root, name);
  return { wrong, never: [...named].filter(path => !carried.has(path)).sort() };
}

/** @param {string} name */
const fixture = async name => JSON.parse(await readFile(join(FIXTURES, name), 'utf8'));

test('R1: the types name every member the report carries, and the report carries every member they name', async () => {
  const { position: _position, today: _today, ...page } = await fixture('pages/connectors.full.json');
  const { wrong, never } = decode('StreamsReport', [await fixture('report.json'), await fixture('proof-report.json'), page]);
  assert.deepEqual(wrong, [], 'every value the fixture carries is of the kind the types say');
  assert.deepEqual(never, [], 'every member the types name is carried somewhere in the fixture');
});

test('R1: an item\'s Made, as the home writes it, is read whole by the types', async () => {
  const made = decode('Made', Object.values(await fixture('made.json')));
  assert.deepEqual(made.wrong, [], 'every item\'s Made is of the kind the types say');
  assert.deepEqual(made.never, [], 'every member of Made is carried');
});

/**
 * @param {unknown} value
 * @param {Set<string>} into
 */
function stringsOf(value, into = new Set()) {
  if (typeof value === 'string') into.add(value);
  else if (Array.isArray(value)) for (const each of value) stringsOf(each, into);
  else if (value && typeof value === 'object') for (const each of Object.values(value)) stringsOf(each, into);
  return into;
}

const OWN = new Set([
  'Resume', 'Pause', 'Turn off', 'Try now', 'Reading', 'Done', 'Paused',
]);

/** @param {import('../public/types.js').ConnectorReport} connector */
const keptWords = connector => {
  const kept = connector.copies.reduce((sum, copy) => sum + (copy.held ?? 0), 0);
  const unit = connector.history?.unit ?? connector.noun;
  return kept && unit ? counted(kept, unit[0], unit[1]) : '';
};

test('R2–R6: every state, need and device of the fixture drawn, in the report\'s words', async () => {
  const home = stringsOf(REPORT);
  const host = stringsOf(HOST_STATE);
  /** @type {{ where: string, words: string, from: string }[]} */
  const drawn = [];
  /** @param {string} where @param {string | null | undefined} words */
  const said = (where, words) => {
    if (!words) return;
    const from = home.has(words) ? 'report' : host.has(words) ? 'host' : OWN.has(words) ? 'page' : '';
    drawn.push({ where, words, from });
  };

  for (const state of [HOST_STATE, null]) {
    const who = state ? 'mac' : 'browser';
    const connected = pageOf(REPORT, state, CONNECTED);
    const rows = connected.sections.flatMap(section => section.faces);

    const streams = REPORT.connectors.filter(each => each.shown === 'stream');
    for (const connector of streams) {
      const in_ = rows.filter(row => row.id === connector.id);
      assert.equal(in_.length, 1, `${who}: ${connector.id} one row`);
      assert.equal(in_[0].state, connector.health.state, `${who}: ${connector.id} drawn in its own state`);
    }
    for (const row of rows) {
      said(`${who} row ${row.id} name`, row.name);
      const served = REPORT.rows.find(each => each.ids.includes(row.id));
      for (const part of served ? [...served.line.split(' · '), ...served.more] : [row.line]) said(`${who} row ${row.id} line`, part);
    }

    const needs = needsOf(REPORT, state);
    const stated = new Set(REPORT.needs.map(need => need.id));
    const theirs = needs.filter(face => stated.has(face.id));
    assert.deepEqual(theirs.map(face => face.id), REPORT.needs.map(need => need.id), `${who}: a row per need, in the home's order`);
    for (const [at, need] of REPORT.needs.entries()) {
      const offered = need.acts.filter(act => act.do === 'try' || act.do === 'skip' || act.do === 'read'
        || act.do === 'ignore' || state !== null);
      if (theirs[at].act) assert.ok([...need.acts, ...state?.needs.find(each => each.id === need.id)?.acts ?? []]
        .some(act => act.label === theirs[at].act?.label), `${who}: ${need.id} offers what the home or host offers`);
      if (offered[0] && offered[0].do !== 'grant' && state) assert.equal(theirs[at].act?.label, offered[0].label, `${who}: ${need.id} its first act`);
      assert.equal(theirs[at].weight, need.weight, `${who}: ${need.id} its weight, the home's`);
    }
    const own = (state?.needs ?? []).filter(need => !need.home && !REPORT.needs.some(each => each.id === need.id));
    assert.equal(needs.length, REPORT.needs.length + own.length, `${who}: the report's and the host's own`);
    assert.deepEqual(needs.filter(face => !stated.has(face.id)).map(face => face.line), own.map(need => need.detail ?? ''),
      `${who}: the host's own with their detail`);
    assert.deepEqual(needs.slice(0, own.length).map(face => face.id), own.map(need => need.id), `${who}: the host's own first`);
    const unfolded = bodyMarkup(connected, AT_REST, '', '', { alerts: { open: true, copied: '' } });
    for (const need of own) if (need.detail) assert.ok(unfolded.includes(esc(need.detail)), `${who}: ${need.id} its detail drawn, the fold open`);
    for (const face of needs) {
      said(`${who} need`, face.title);
      said(`${who} need line`, face.line);
      if (face.act) said(`${who} need act`, face.act.label);
    }
    assert.equal(REPORT.badge.needs + ownNeeds(REPORT, state).length, needs.length, `${who}: the count is the home's badge and the host's own`);
    assert.equal(connected.alerts.length, needs.length, `${who}: one fold of strips, one count`);

    for (const device of REPORT.devices) {
      const page = device.kind === 'mac' && device.unit === state?.unit ? SETTINGS_MAC
        : `${device.kind === 'mac' ? SETTINGS_MAC : SETTINGS_IPHONE}/${device.unit}`;
      const row = connected.side.find(each => each.id === page && each.name === device.name);
      assert.ok(row, `${who}: ${device.unit} a side row`);
      assert.equal(row.line, device.health.words, `${who}: ${device.unit} its words`);
      assert.equal(row.state, device.health.state, `${who}: ${device.unit} its state`);
    }
    assert.equal(connected.side.find(each => each.id === SETTINGS_HOME)?.line, REPORT.home.health.words);
    assert.equal(connected.side.find(each => each.id === SETTINGS_CHROME)?.line, REPORT.extension.health.words);
    for (const row of connected.side) {
      said(`${who} side ${row.id} name`, row.name);
      said(`${who} side ${row.id} line`, row.line);
    }

    const body = bodyMarkup(connected, AT_REST, '') + sideMarkup(connected);
    for (const row of rows) {
      const end = endOf(row);
      if ('word' in end) assert.ok(body.includes(stateShape(row.state) + `<span>${end.word}</span>`), `${who}: ${row.id} drawn in its look`);
    }

    for (const id of REPORT.connectors.filter(each => each.shown !== null).map(each => each.id)) {
      const detail = detailOf(REPORT, state, id, OPENED);
      assert.ok(detail, `${who}: ${id} opens`);
      assert.doesNotThrow(() => detailMarkup(detail, AT_REST), `${who}: ${id} draws`);
      said(`${who} dialog ${id} name`, detail.name);
      if (detail.callout) {
        said(`${who} dialog ${id} callout`, detail.callout.title);
        for (const act of detail.callout.acts) said(`${who} dialog ${id} callout act`, act.label);
      }
      for (const way of detail.connect?.ways ?? []) for (const row of way.rows) said(`${who} dialog ${id} to connect`, row.name);
      const connector = /** @type {import('../public/types.js').ConnectorReport} */ (REPORT.connectors.find(each => each.id === id));
      for (const panel of detail.panels) for (const row of panel.rows) {
        if (panel.label === 'Comes from') said(`${who} dialog ${id} ${panel.label}`, row.line);
        if (panel.label !== 'History') continue;
        const [status, ...rest] = row.line.split(' · ');
        const count = rest.join(' · ');
        if (count === keptWords(connector)) said(`${who} dialog ${id} History`, status);
        else said(`${who} dialog ${id} History`, row.line);
      }
    }
  }

  assert.deepEqual(Object.keys(STATE_LOOKS).sort(),
    ['broken', 'needs-you', 'off', 'ok', 'paused', 'quiet', 'setup', 'syncing', 'waiting']);

  const made = drawn.filter(each => each.from === '');
  const dir = join(tmpdir(), 'lifestream-e2e');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'dashboard-report.json'), JSON.stringify({ drawn, made }, null, 2));
  assert.deepEqual(made, [], 'every word drawn is the report\'s, the host\'s, or one the page names as its own');
});

/** @param {import('../public/ui/connectors/dialog.js').Detail} detail */
const resumes = detail => [...detail.foot?.end ?? [], ...detail.panels.flatMap(panel => panel.rows.flatMap(row => row.end?.acts ?? []))]
  .filter(act => act.label === 'Resume').map(act => /** @type {{ host: { act: string, scope?: string } }} */ (act.do).host);

test('R7: two pauses standing at once are two Resumes, the history\'s drawn from the pauses alone', () => {
  const syncing = REPORT.connectors.find(each => each.shown === 'stream' && each.set_up && each.copies.length > 0
    && each.history?.state === 'syncing' && each.pauses.length === 0);
  assert.ok(syncing, 'the fixture holds a stream set up whose past still arrives');
  /** @param {import('../public/types.js').ConnectorReport} connector */
  const opened = connector => {
    const paused = connector.pauses.map(pause => ({ target: `pause:${connector.id}${pause.scope === 'history' ? ':history' : ''}`,
      by: pause.by, reason: pause.reason, at_ms: pause.at_ms, holds: null, title: `Paused: ${connector.name}`, line: pause.reason }));
    const report = { ...REPORT, paused: [...REPORT.paused, ...paused],
      connectors: REPORT.connectors.map(each => each.id === connector.id ? connector : each) };
    const detail = detailOf(report, HOST_STATE, connector.id, OPENED);
    assert.ok(detail);
    assert.doesNotThrow(() => detailMarkup(detail, AT_REST));
    return resumes(detail);
  };
  const by = /** @type {const} */ ('you');
  const all = { scope: /** @type {const} */ ('all'), by, reason: 'held by the person', at_ms: REPORT.at_ms };
  const history = { ...all, scope: /** @type {const} */ ('history') };
  assert.deepEqual(opened({ ...syncing, pauses: [all, history] }),
    [{ act: 'resume', connector: syncing.id }, { act: 'resume', connector: syncing.id, scope: 'history' }], 'both Resumes');
  assert.deepEqual(opened({ ...syncing, pauses: [history] }),
    [{ act: 'resume', connector: syncing.id, scope: 'history' }], 'the history\'s alone');
  assert.deepEqual(opened({ ...syncing, pauses: [history], history: null }),
    [{ act: 'resume', connector: syncing.id, scope: 'history' }], 'a history pause with no history still resumes');
  assert.deepEqual(opened({ ...syncing, pauses: [history], history: { ...syncing.history, state: 'done', left: 0 } }),
    [{ act: 'resume', connector: syncing.id, scope: 'history' }], 'a history pause on a done history still resumes');
  assert.deepEqual(opened({ ...syncing, pauses: [all] }), [{ act: 'resume', connector: syncing.id }], 'the whole\'s alone');
});

test('R8: the home\'s own needs are placed by their acts, the vault\'s drawn once', () => {
  /** @param {string} id @param {string} words @param {any[]} acts @returns {any} */
  const need = (id, words, acts) => ({ id, state: 'needs-you', reason: null, words, since_ms: null, next_ms: null, acts,
    detail: null, connector: null, copy: null, unit: null, at: null, weight: 'advice', banner: false, dismissed: false });
  const disk = need('photos:room', 'Photos need 79 GB more', [{ do: 'storage', label: 'Manage storage' }]);
  const bare = need('disk', "Lifestream's disk fills up in about 9 days", []);
  const knock = need('connect:arc', 'Arc has been asking to connect since 14:02', [{ do: 'browser', label: 'Connect', of: 'arc' }]);
  const locked = need('vault:locked', 'Passwords are locked on this Mac', [{ do: 'vault', label: 'Unlock' }]);
  const none = need('vault:none', 'No vault yet: make your recovery key in the Lifestream app', [{ do: 'vault', label: 'Make your recovery key' }]);
  const allow = { id: 'vault:locked', line: 'Allow Lifestream to open your passwords', detail: null,
    acts: [{ id: 'do', label: 'Allow', tone: /** @type {const} */ ('caution') }], home: false };
  const state = { ...HOST_STATE, needs: [allow], vault: { state: /** @type {const} */ ('locked'), saved_ms: null } };
  const banners = needsOf({ ...REPORT, needs: [disk, bare, knock, locked] }, state);
  assert.deepEqual(banners.map(banner => [banner.title, banner.act && [banner.act.label, banner.act.do]]), [
    [disk.words, ['Manage storage', { host: { act: 'open', what: 'storage' } }]],
    [bare.words, null],
    [knock.words, ['Connect', { flow: 'browser' }]],
    [locked.words, ['Allow', { host: { act: 'need', need: 'vault:locked', button: 'do' } }]],
  ], 'one row each, by its act, the Mac\'s own vault need in the report\'s place');
  const fresh = { ...HOST_STATE, needs: [], vault: { state: /** @type {const} */ ('none'), saved_ms: null } };
  assert.deepEqual(needsOf({ ...REPORT, needs: [none] }, fresh).map(banner => banner.act?.do),
    [{ host: { act: 'vault', do: 'open' } }], 'no vault yet: the app\'s Recovery key window');
  assert.deepEqual(needsOf({ ...REPORT, needs: [disk, knock, none] }, null).map(banner => banner.act), [null, null, null],
    'a browser takes no host\'s flow');
});
