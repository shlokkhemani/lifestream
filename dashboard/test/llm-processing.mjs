import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BATTERY_SPENT, DESCRIBED, LLM_REPORT, MODELS, MODELS_BARE, ON_BATTERY, RANGE_STEP, SHAPED, SUBSCRIBED, TRANSCRIBED } from '../public/kit-gallery-llm.js';
import { HOST_STATE, REPORT } from '../public/kit-gallery-report.js';
import { AI_PAGE, detailOf, MODEL_PAGE, modelFinding, OPENED } from '../public/ui/connectors/dialog.js';
import { detailMarkup } from '../public/ui/connectors/detail.js';
import { LACKS } from '../public/ui/connectors/changes.js';
import { isSettings, NOTES, savedAct, SETTINGS_DEFAULTS, SETTINGS_PRIVACY, SETTINGS_PROVIDERS, settingsDetail, shownPage, TYPED } from '../public/ui/connectors/settings.js';
import { SUBSCRIPTIONS } from '../public/ui/connectors/settings-models.js';
import { AT_REST } from '../public/ui/connectors/view.js';
import { actKey, keyOf, landedOf, pendingOf, settled, thingKey } from '../public/ui/connectors/pending.js';
import { ELSEWHERE, flowOf, MODEL_ITEMS, modelOf, sessionOf } from '../public/ui/flows/model.js';
import { flowPageRows } from '../public/ui/flows/view.js';
import { esc } from '../public/lib/html.js';
import { DESCRIBE, made, TRANSCRIBE } from '../public/ui/kit/made.js';

/** @typedef {import('../public/ui/connectors/dialog.js').Detail} Detail */
/** @typedef {import('../public/ui/connectors/dialog.js').Panel} Panel */
/** @typedef {import('../public/types.js').ConnectorReport} ConnectorReport */

/** @param {string} id */
const connectorOf = id => /** @type {ConnectorReport} */ (LLM_REPORT.connectors.find(each => each.id === id));
/**
 * @param {string} id
 * @param {any} state
 */
const dialog = (id, state) => /** @type {Detail} */ (detailOf(LLM_REPORT, state, id, OPENED));
/** @param {Detail} detail @param {string} label */
const panel = (detail, label) => detail.panels.find(each => each.label === label);
/**
 * @param {string} id
 * @param {string} key
 * @param {any} state
 */
const pageOf = (id, key, state) => /** @type {Detail} */ (detailOf(LLM_REPORT, state, id, { ...OPENED, pages: [`${AI_PAGE}${key}`] }));
/** @param {any} end */
const menuOf = end => end?.menu ?? null;
/**
 * @param {string} id
 * @param {any} state
 */
const aiOf = (id, state) => /** @type {Panel} */ (panel(dialog(id, state), 'AI'));
/** @param {string} id */
const worksOf = id => (connectorOf(id).processing?.rows ?? []).filter(row => row.shape !== null);
/** @param {string} markup */
const actsIn = markup => [...markup.matchAll(/(?:data-cn-do|data-value)="([^"]*)"/gu)]
  .map(match => { try { return JSON.parse(match[1].replaceAll('&quot;', '"').replaceAll('&#39;', '\'').replaceAll('&amp;', '&')); } catch { return null; } })
  .filter(each => each && typeof each === 'object');
/** @param {any} act */
const aiAct = act => act.host?.member?.startsWith('llm.') || (act.open && !String(act.open).startsWith('import:'));
/** @param {any} state */
const plansOf = state => flowOf('model', { state, report: null }, { ...sessionOf(state !== null, 'dialog'), models: [...SUBSCRIPTIONS] },
  Date.UTC(2026, 9, 28, 12));
/** @type {import('../public/lib/reach.js').Drawn} */
const READ_FAILED = { kind: 'lack', words: null, retry: true };
/** @param {Partial<Parameters<typeof settingsDetail>[0]>} read */
const settings = read => settingsDetail({ report: REPORT, models: MODELS, failed: null, state: HOST_STATE, id: SETTINGS_PROVIDERS, opened: OPENED,
  subscriptions: plansOf(read.state === undefined ? HOST_STATE : read.state), ...read });
/** @param {Detail} detail */
const partLabels = detail => detail.parts.map(each => each.label);
/** @param {Detail} detail @param {string} label */
const part = (detail, label) => detail.parts.find(each => each.label === label);
/** @param {Detail} detail @param {string} partLabel @param {string} rowLabel */
const rowIn = (detail, partLabel, rowLabel) => part(detail, partLabel)?.panel?.rows.find(each => each.label === rowLabel);
/** @param {any} row */
const endActs = row => (row?.end?.acts ?? []).map((/** @type {any} */ act) => [act.label, act.do]);
/** @typedef {Extract<import('../public/pages.js').ModelConnection, { kind: 'runner' }>} Runner */
const RUNNERS = /** @type {Runner[]} */ (MODELS.connections.filter(each => each.kind === 'runner'));
const [MAC_AT, MINI_AT, IMAC_AT] = RUNNERS.map(each => each.place);
/** @param {Partial<Runner>} said @returns {import('../public/lib/model-menu.js').Models} */
const withRunner = said => ({ ...MODELS, connections: MODELS.connections.map(each => each === RUNNERS[0] ? { ...each, ...said } : each) });
/** @param {Detail} detail @param {string} label */
const rowsOf = (detail, label) => part(detail, label)?.panel?.rows ?? [];
const BARRED = /\b(?:work|route|kind|floor|family|grant)s?\b/iu;
const RUN_LINE = 'Local work waits until you turn this on.';

test('L1: AI its own section after Settings and before History, a row per work, each work\'s sentence on its own page; none for a connector without one', () => {
  for (const id of SHAPED) {
    const labels = dialog(id, HOST_STATE).panels.map(each => each.label);
    const at = labels.indexOf('AI');
    assert.ok(at >= 0, `${id}: drawn`);
    const settings = labels.indexOf('Settings');
    if (settings >= 0) assert.equal(settings, at - 1, `${id}: right after Settings`);
    const history = labels.indexOf('History');
    if (history >= 0) assert.equal(history, at + 1, `${id}: History right after`);
    assert.equal(labels.some(label => ['LLM processing', 'Data backfill', 'Backfill', 'Groups'].includes(label)), false, `${id}: ${labels}`);
    assert.equal(aiOf(id, HOST_STATE).about, '', `${id}: no sentence of the section's own`);
  }
  for (const report of [LLM_REPORT, REPORT]) {
    const detail = /** @type {Detail} */ (detailOf(report, HOST_STATE, 'github', OPENED));
    assert.equal(panel(detail, 'AI'), undefined);
  }
  for (const id of ['whatsapp', 'chatgpt', 'apple-photos']) {
    const labels = dialog(id, HOST_STATE).panels.map(each => each.label);
    assert.equal(labels.indexOf('History'), labels.indexOf('AI') + 1, `${id}: History drawn after`);
    assert.equal(panel(dialog(id, HOST_STATE), 'History')?.about, connectorOf(id).backfill_about ?? '');
  }
  const whatsapp = detailMarkup(dialog('whatsapp', HOST_STATE), AT_REST);
  assert.ok(whatsapp.includes('ck-ssection__heading">AI<'));
  for (const row of worksOf('whatsapp')) {
    const about = memberOf('whatsapp', row.member).about ?? '';
    assert.ok(about && detailMarkup(pageOf('whatsapp', row.member, HOST_STATE), AT_REST).includes(esc(about)),
      `${row.member}: its page says the home's sentence`);
  }
});

/**
 * @param {string} id
 * @param {string} key
 */
const memberOf = (id, key) => /** @type {import('../public/types.js').MemberState} */ (connectorOf(id).members.find(each => each.key === key));

test('L2, L3: a row per work pushing its page, Range last; on the page its model drawn as every member is, the line and mark the work\'s, the needs line opening Providers', () => {
  const MARKS = { off: null, needs: { look: 'needs-you' }, waiting: { status: 'waiting' }, running: { status: 'running' },
    done: { status: 'done' } };
  const seen = new Set();
  for (const id of SHAPED) {
    const processing = /** @type {import('../public/types.js').Processing} */ (connectorOf(id).processing);
    const section = aiOf(id, HOST_STATE);
    assert.deepEqual(section.rows.map(row => row.label), processing.rows.map(row => memberOf(id, row.member).label),
      `${id}: a row per member the part names, in its order`);
    assert.equal(processing.rows.at(-1)?.shape, null, `${id}: the range's row last`);
    assert.equal(section.rows.at(-1)?.label, memberOf(id, 'llm.range').label, `${id}: the range's row last`);
    processing.rows.forEach((row, at) => {
      if (row.shape === null) return;
      seen.add(row.shape);
      const member = memberOf(id, row.member);
      const listed = section.rows[at];
      assert.deepEqual([listed.lead, listed.line, listed.go, listed.end], [{ icon: 'ai' }, row.line ?? member.words,
        { do: { page: `${AI_PAGE}${row.member}` }, value: '' }, null], `${id} ${row.member}: a row that pushes`);
      const inside = pageOf(id, row.member, HOST_STATE);
      assert.deepEqual([inside.name, inside.back], [member.label, { label: `Back to ${connectorOf(id).name}` }]);
      const each = inside.panels[0].rows[0];
      assert.equal(each.label, 'Model');
      assert.deepEqual([each.does ?? '', each.line], row.line ? [member.about ?? '', row.line] : ['', member.about ?? '']);
      assert.deepEqual(each.mark, MARKS[row.shape], `${id} ${row.member}: its shape's mark`);
      assert.deepEqual(each.act, row.shape === 'needs' ? { open: SETTINGS_PROVIDERS } : row.privacy?.waiting ? { open: SETTINGS_PRIVACY } : null);
      assert.deepEqual(each.waiting, (member.waiting ?? []).map(wait => wait.line));
      const menu = menuOf(each.end);
      assert.equal(menu.words, member.words);
      const models = member.menu ? [member.menu.default, ...member.menu.rows, ...member.menu.local?.rows ?? []] : [];
      assert.deepEqual(menu.choices.map((/** @type {any} */ choice) => [choice.words, choice.note, choice.chosen, choice.default]),
        [...models.map(each => [each?.name, '', each?.chosen, false]), ...member.menu ? [[member.menu.more.words, '', false, false]] : [],
          ...member.menu?.off ? [[member.menu.off.name, '', member.menu.off.chosen, false]] : []],
        `${id} ${row.member}: the home's menu, Default first, each model its name, More, then Off`);
      assert.equal(inside.panels[0].rows.length, row.privacy ? 2 : 1, `${id} ${row.member}: its hiding under its model`);
      assert.equal(dialog(id, HOST_STATE).panels.flatMap(panel => panel.rows).filter(drawn => drawn.label === member.label).length, 1,
        member.label);
    });
  }
  assert.deepEqual([...seen].sort(), ['done', 'needs', 'off', 'running', 'waiting'], 'every shape drawn');
  const gone = { ...LLM_REPORT, connectors: LLM_REPORT.connectors.map(each => each.id !== 'gmail' ? each
    : { ...each, members: each.members.filter(member => member.key !== 'llm.mail') }) };
  assert.deepEqual(/** @type {Panel} */ (panel(/** @type {Detail} */ (detailOf(gone, HOST_STATE, 'gmail', OPENED)), 'AI')).rows
    .map(row => row.label), [memberOf('gmail', 'llm.range').label]);
  assert.deepEqual([SETTINGS_DEFAULTS, SETTINGS_PROVIDERS], ['settings/defaults', 'settings/providers']);
  assert.ok(isSettings(SETTINGS_DEFAULTS) && isSettings(SETTINGS_PROVIDERS));
});

test('L4b: More opens a page of its own: the home\'s search field first, then the rows it found under the home\'s headers, each set as a step is, the chosen one marked; in a browser no act', () => {
  const id = SHAPED[0];
  const row = worksOf(id)[0];
  const member = memberOf(id, row.member);
  assert.ok(member.menu, `${id} ${row.member}: its work member carries the home's menu`);
  const pages = [`${AI_PAGE}${row.member}`, `${MODEL_PAGE}${row.member}`];
  assert.deepEqual(modelFinding(LLM_REPORT, id, { ...OPENED, pages }), member.menu.more.work === null ? { use: member.menu.more.use } : { work: member.menu.more.work });
  assert.equal(modelFinding(LLM_REPORT, id, { ...OPENED, pages: pages.slice(0, 1) }), null, 'only on its own page');
  const one = { value: 'openrouter:vendor-b/model-1', name: 'Model One', account: null, chosen: false };
  const found = { key: '', failed: '', answer: { position: '1:1', today: '2026-06-01', placeholder: 'Search', none: null,
    groups: [{ label: 'OpenRouter', rows: [one, { ...one, value: String(member.value), name: 'Held', chosen: true }] },
      { label: 'Local', rows: [{ ...one, value: 'runner:mac/two', name: 'Two' }] }] } };
  const page = /** @type {Detail} */ (detailOf(LLM_REPORT, HOST_STATE, id, { ...OPENED, pages, typed: 'model', found }));
  assert.equal(page.name, member.menu.more.words);
  /** @param {string} value */
  const sets = value => ({ host: { act: 'setting', connector: id, member: row.member, value } });
  assert.deepEqual(page.panels.map(panelShown => [panelShown.label, panelShown.rows.map(each => [each.label, each.line, each.act, each.end])]), [
    ['', []],
    ['OpenRouter', [['Model One', '', sets(one.value), null], ['Held', '', sets(String(member.value)), { words: '', done: true }]]],
    ['Local', [['Two', '', sets('runner:mac/two'), null]]]]);
  assert.deepEqual([page.panels[0].find, page.panels[0].add, page.panels[0].note], [{ placeholder: 'Search', typed: 'model' }, null, '']);
  const none = /** @type {Detail} */ (detailOf(LLM_REPORT, HOST_STATE, id, { ...OPENED, pages, typed: 'zzz',
    found: { ...found, answer: { ...found.answer, groups: [], none: 'No matches' } } }));
  assert.deepEqual([none.panels.length, none.panels[0].note, none.panels[0].find?.typed], [1, 'No matches', 'zzz']);
  const browser = /** @type {Detail} */ (detailOf(LLM_REPORT, null, id, { ...OPENED, pages, typed: 'model', found }));
  assert.ok(browser.panels.flatMap(each => each.rows).every(each => each.act === null), 'no act in a browser');
});

test('L4: a step on a work\'s page sends its setting, the range its own with its date row; in a browser words alone', () => {
  for (const id of SHAPED) {
    for (const row of worksOf(id)) {
      const model = pageOf(id, row.member, HOST_STATE).panels[0].rows[0];
      const worked = memberOf(id, row.member);
      const menu = worked.menu;
      /** @param {string} value */
      const sets = value => ({ host: { act: 'setting', connector: id, member: row.member, value } });
      assert.deepEqual(menuOf(model.end).choices.map((/** @type {any} */ choice) => choice.do), menu
        ? [...[menu.default, ...menu.rows, ...menu.local?.rows ?? []].flatMap(each => each ? [sets(each.value)] : []), { page: `model:${row.member}` }, ...menu.off ? [sets(menu.off.value)] : []]
        : (worked.steps ?? []).map(step => sets(step.value)));
      assert.equal(menuOf(model.end).date, null, row.member);
      const browser = pageOf(id, row.member, null).panels[0].rows[0];
      assert.deepEqual([browser.end, browser.act], [{ words: memberOf(id, row.member).words }, null], `${id} ${row.member}: words in a browser`);
      const markup = detailMarkup(pageOf(id, row.member, null), AT_REST);
      assert.equal(actsIn(markup).some(aiAct), false, `${id} ${row.member}: no act in a browser`);
    }
    const range = /** @type {import('../public/types.js').Processing} */ (connectorOf(id).processing).rows.at(-1);
    const member = memberOf(id, /** @type {string} */ (range?.member));
    const menu = menuOf(aiOf(id, HOST_STATE).rows.at(-1)?.end);
    assert.deepEqual(menu.choices.map((/** @type {any} */ choice) => choice.do),
      (member.steps ?? []).map(step => ({ host: { act: 'setting', connector: id, member: member.key, value: step.value } })));
    const held = String(member.value);
    assert.deepEqual(menu.date, { label: 'A date', connector: id, member: member.key, asks: true, said: null,
      value: /^\d{4}-\d{2}-\d{2}$/u.test(held) && !(member.steps ?? []).some(step => step.value === held) ? held : '' });
    assert.deepEqual(aiOf(id, null).rows.at(-1)?.end, { words: member.words }, `${id}: Range words in a browser`);
    const markup = detailMarkup(dialog(id, null), AT_REST);
    assert.equal(actsIn(markup).some(aiAct), false, `${id}: no act in a browser`);
  }
  assert.equal(menuOf(aiOf('apple-photos', HOST_STATE).rows.at(-1)?.end).date.value, '2026-01-01');
  assert.equal(menuOf(aiOf('whatsapp', HOST_STATE).rows.at(-1)?.end).date.value, '');
});

test('L5: a change settles once a report read after it holds the value the home said landed', () => {
  const reads = /** @param {import('../public/types.js').StreamsReport} report */ report => ({ report, models: null, hiding: null });
  const act = /** @type {const} */ ({ act: 'setting', connector: 'whatsapp', member: 'llm.photos', value: 'off' });
  const sent = /** @type {import('../public/ui/connectors/pending.js').Pending} */ (pendingOf(act, reads(LLM_REPORT)));
  assert.equal(landedOf(sent, {}), sent, 'no landed: a report read after the save settles it');
  const change = landedOf(sent, { landed: { connector: 'whatsapp', member: 'llm.photos', value: 'off' } });
  assert.equal(settled(change, reads(LLM_REPORT)), false);
  /** @param {string} key @param {string} value */
  const moved = (key, value) => ({ ...LLM_REPORT, connectors: LLM_REPORT.connectors.map(each => each.id !== 'whatsapp' ? each
    : { ...each, members: each.members.map(member => member.key === key ? { ...member, value } : member) }) });
  assert.equal(settled(change, reads(moved('llm.photos', 'default'))), false, 'a read that does not hold it yet');
  assert.equal(settled(change, reads(moved('llm.photos', 'off'))), true);
  assert.equal(settled(sent, reads(LLM_REPORT)), false);
  assert.equal(settled(sent, reads(moved('llm.photos', 'default'))), true);
});

test('L6: Settings opens at the page its id names, Providers marked in its list; Providers in its order, Default models its uses, reading, failed', () => {
  assert.equal(shownPage('settings'), 'home', 'Settings alone is Home');
  assert.deepEqual([shownPage(SETTINGS_DEFAULTS), shownPage(SETTINGS_PROVIDERS)], ['defaults', 'providers']);
  assert.equal(shownPage('settings/general'), '', 'General is gone, with no redirect');
  for (const id of ['settings', SETTINGS_DEFAULTS, SETTINGS_PROVIDERS]) assert.ok(isSettings(id));
  assert.equal(isSettings('screen'), false);

  const models = settings({});
  assert.equal(models.name, 'Providers');
  const items = models.nav?.groups.flatMap(group => group.items) ?? [];
  assert.deepEqual(items.filter(each => each.on).map(each => [each.label, each.do]), [['Providers', { open: SETTINGS_PROVIDERS }]]);
  assert.deepEqual(partLabels(models), ['Accounts', ...RUNNERS.map(each => each.place), 'Other server'],
    'the accounts, then each Mac\'s local models, then the other server');
  const defaults = settings({ id: SETTINGS_DEFAULTS });
  assert.deepEqual([defaults.name, partLabels(defaults), rowsOf(defaults, '').map(row => row.label)], ['Default models', [''],
    ['Chat', 'Thinking', 'Photos', 'Voice notes', 'Text', 'Search by meaning', 'Hiding details']], 'one part, no heading, Thinking under Chat');
  assert.equal(models.foot, null);
  assert.equal(settings({ id: 'settings/general' }), null);

  const reading = settings({ models: null });
  assert.equal(reading.reading, true);
  assert.deepEqual(partLabels(reading), [''], 'the host\'s, drawn while the models read is not');
  const failed = settings({ models: null, failed: READ_FAILED });
  assert.equal(failed.reading, false);
  assert.equal(failed.readFailed?.drawn, READ_FAILED);
  const stale = settings({ failed: READ_FAILED });
  assert.ok(detailMarkup(stale, AT_REST).includes(LACKS.models));
  assert.deepEqual(partLabels(stale), partLabels(models), 'what was shown stays');
  assert.deepEqual(actsIn(detailMarkup(stale, AT_REST)).filter(act => 'host' in act || 'save' in act || 'page' in act), [],
    'no control acts on what may have changed');
  const browser = settings({ state: null, subscriptions: null });
  assert.deepEqual(rowsOf(browser, 'Accounts').map(row => [row.label, /** @type {any} */ (row.end).words]),
    [['Claude', 'Signed in'], ['ChatGPT', 'Not signed in'], ['OpenRouter', 'Connected']], 'with no flow the plans are the home\'s rows');
});

test('L7: OpenRouter typed and added, Connected and Remove; the other server is its URL, on its page, set and removed', () => {
  const bare = settings({ models: MODELS_BARE });
  const openrouter = rowsOf(bare, 'Accounts').find(row => row.label === 'OpenRouter');
  assert.equal(openrouter?.line, 'Hundreds of models with one key.');
  const end = /** @type {any} */ (openrouter?.end);
  assert.deepEqual([end.field.key, end.field.kind, end.field.value], [TYPED.key, 'secret', '']);
  assert.deepEqual(end.acts.map((/** @type {any} */ act) => [act.label, act.disabled, act.do]), [['Add key', true, { save: 'openrouter' }]]);
  const typed = { ...OPENED, fields: { [TYPED.key]: ' sk-or-example ' } };
  const filled = rowsOf(settings({ models: MODELS_BARE, opened: typed }), 'Accounts').find(row => row.label === 'OpenRouter');
  assert.equal(/** @type {any} */ (filled?.end).acts[0].disabled, false);
  assert.deepEqual(savedAct('openrouter', typed), { act: 'seal', secret: 'openrouter', value: 'sk-or-example' });
  assert.equal(savedAct('openrouter', OPENED), null);

  const custom = rowsOf(bare, 'Other server')[0];
  assert.deepEqual([custom?.label, custom?.line, endActs(custom)],
    ['Any OpenAI-compatible server, like vLLM or another Mac.', '', [['Add server', { page: 'address' }]]]);
  const page = settings({ models: MODELS_BARE, opened: { ...OPENED, pages: ['address'] } });
  assert.deepEqual([page.name, page.back], ['Providers', { label: 'Providers' }]);
  assert.deepEqual(part(page, 'Other server')?.acts.map(act => [act.label, act.disabled, act.do]), [['Save', true, { save: 'address' }]]);
  assert.deepEqual(part(page, 'Other server')?.panel?.rows.map(row => row.label), ['Server URL'], 'no model and no Takes: the server lists its own');
  const address = { ...OPENED, pages: ['address'], fields: { [TYPED.url]: ' http://127.0.0.1:11434/v1 ' } };
  assert.deepEqual(savedAct('address', address), { act: 'models', do: 'address', url: 'http://127.0.0.1:11434/v1' });
  assert.equal(savedAct('address', { ...address, fields: { [TYPED.url]: ' ' } }), null);

  const full = settings({});
  const connected = rowsOf(full, 'Accounts').find(row => row.label === 'OpenRouter');
  assert.deepEqual([connected?.line, /** @type {any} */ (connected?.end).words, endActs(connected)],
    ['Hundreds of models with one key.', 'Connected', [['Remove', { host: { act: 'seal', secret: 'openrouter', value: null } }]]]);
  const set = rowsOf(full, 'Other server')[0];
  assert.deepEqual([set?.label, endActs(set)], ['http://127.0.0.1:11434/v1', [['Remove', { host: { act: 'models', do: 'address', none: true } }]]]);
  const said = settings({ models: { ...MODELS, connections: MODELS.connections.map(each => each.kind === 'address'
    ? { ...each, line: 'Said by the home' } : each) } });
  assert.equal(rowsOf(said, 'Other server')[0]?.only, 'Said by the home');
});

test('L8: each model file\'s line and acts the home\'s; a runner away says why', () => {
  const full = settings({});
  /** @param {import('../public/ui/connectors/dialog.js').DetailPart | undefined} at */
  const files = at => (at?.panel?.rows ?? []).filter(row => row.label !== 'Run local models' && row.label !== 'Save battery');
  /** @param {Runner} runner */
  const drawn = runner => runner.files.map(each => [each.name, each.line, each.working, !each.fits,
    each.acts.map(act => [act.words, { host: { act: 'models', do: 'file', runner: runner.id.slice('runner:'.length), id: each.id, to: act.act === 'fetch' ? 'fetch' : 'remove' } }])]);
  const [mac, mini, imac] = RUNNERS;
  assert.deepEqual(mac.files.map(each => each.state), ['ready', 'fetching', 'absent', 'absent', 'ready'], 'the fixture holds three states');
  assert.deepEqual(files(part(full, MAC_AT)).map(row => [row.label, row.line, row.working, row.dim, endActs(row)]), drawn(mac));
  assert.deepEqual(files(part(full, MINI_AT)).map(row => [row.label, row.line, row.working, row.dim, endActs(row)]), drawn(mini));
  assert.deepEqual(endActs(files(part(full, MAC_AT)).find(row => row.label === 'Qwen 3.5 35B-A3B')), [],
    'a file too large for its Mac: no act, greyed');
  assert.deepEqual(part(full, IMAC_AT)?.panel?.rows.map(row => [row.label, endActs(row)]), [[imac.none, []]]);
  const away = settings({ models: withRunner({ line: 'Said by the home' }) });
  assert.deepEqual(part(away, MAC_AT)?.lines, ['Said by the home'], 'the home empties an away runner\'s acts; the part says why');
  const found = settings({ models: withRunner({ found: [{ name: 'llama4:8b', size: '4.9 GB', from: 'From Ollama' }] }) });
  assert.deepEqual(rowsOf(found, 'From Ollama').map(row => [row.label, /** @type {any} */ (row.end).words, endActs(row)]),
    [['llama4:8b', '4.9 GB', []]], 'a found model, with no button');
});

test('L8b: a runner\'s calls: Run local models, its switch first where the home gives one, off with the home\'s line; none given, none; in a browser its words', () => {
  const [mac] = RUNNERS;
  /**
   * @param {Detail} detail
   * @param {string} label
   */
  const run = (detail, label) => {
    const row = part(detail, label)?.panel?.rows[0];
    return row?.label === 'Run local models' ? [row.line, /** @type {any} */ (row.end)?.toggle ?? /** @type {any} */ (row.end)?.words] : null;
  };
  /** @param {'pause' | 'resume'} to */
  const act = to => ({ host: { act: 'models', do: 'runner', runner: 'runner-macbook-pro-0001', to } });
  const running = settings({});
  assert.equal(mac.paused, false, 'the fixture\'s runner runs unpaused');
  assert.deepEqual(run(running, MAC_AT), ['', { on: true, label: 'Run local models', do: act('pause') }]);
  const pausedRead = withRunner({ paused: true, run: { label: 'Run local models', on: false, line: 'Local work waits until you turn this on.' } });
  const paused = settings({ models: pausedRead });
  assert.deepEqual(run(paused, MAC_AT), ['Local work waits until you turn this on.', { on: false, label: 'Run local models', do: act('resume') }]);
  assert.ok((part(paused, MAC_AT)?.panel?.rows ?? []).filter(row => mac.files.some(file => file.name === row.label && file.acts.length))
    .every(row => endActs(row).length > 0), 'a paused runner\'s files still act');
  const unready = settings({ models: withRunner({ run: null }) });
  assert.equal(run(unready, MAC_AT), null);
  assert.equal(run(running, IMAC_AT), null);
  assert.deepEqual(run(running, MINI_AT)?.[1], { on: false, label: 'Run local models', do: { host: { act: 'models', do: 'runner',
    runner: 'runner-mac-mini-bb17', to: 'resume' } } });
  assert.deepEqual(run(settings({ state: null }), MAC_AT)?.[1], 'On');
  assert.deepEqual(run(settings({ failed: READ_FAILED }), MAC_AT)?.[1], 'On');
  assert.ok(actsIn(detailMarkup(running, AT_REST)).some(each => JSON.stringify(each) === JSON.stringify(act('pause'))));
  const pending = /** @type {any} */ (pendingOf(act('pause').host, { report: null, models: MODELS, hiding: null }));
  assert.equal(keyOf(act('pause').host), keyOf(act('resume').host));
  assert.equal(settled(pending, { report: null, models: MODELS, hiding: null }), false);
  assert.equal(settled(pending, { report: null, hiding: null, models: pausedRead }), true);
});

test('L8c: a runner\'s Save battery: after Run local models where its machine has a battery, the home\'s words of it; in a browser its words', () => {
  /**
   * @param {Detail} detail
   * @param {string} label
   */
  const save = (detail, label) => {
    const rows = part(detail, label)?.panel?.rows ?? [];
    const row = rows.find(each => each.label === 'Save battery');
    return row ? [rows.indexOf(row), row.line, /** @type {any} */ (row.end)?.toggle ?? /** @type {any} */ (row.end)?.words] : null;
  };
  /** @param {'save' | 'spend'} to */
  const act = to => ({ host: { act: 'models', do: 'battery', runner: 'runner-macbook-pro-0001', to } });
  const SAVING = 'On battery, only recent items run.';
  assert.deepEqual(save(settings({}), MAC_AT), [1, SAVING, { on: true, label: 'Save battery', do: act('spend') }]);
  assert.deepEqual(save(settings({ models: ON_BATTERY }), MAC_AT)?.[1], SAVING);
  assert.deepEqual(save(settings({ models: BATTERY_SPENT }), MAC_AT)?.[2], { on: false, label: 'Save battery', do: act('save') });
  assert.equal(save(settings({}), MINI_AT), null);
  assert.equal(save(settings({}), IMAC_AT), null);
  const unready = settings({ models: withRunner({ run: null }) });
  assert.deepEqual(save(unready, MAC_AT)?.slice(0, 2), [0, SAVING]);
  assert.deepEqual(save(settings({ state: null }), MAC_AT)?.[2], 'On');
  const pending = /** @type {any} */ (pendingOf(act('spend').host, { report: null, models: MODELS, hiding: null }));
  assert.equal(keyOf(act('spend').host), keyOf(act('save').host));
  assert.equal(settled(pending, { report: null, models: MODELS, hiding: null }), false);
  assert.equal(settled(pending, { report: null, models: BATTERY_SPENT, hiding: null }), true);
});

const defaults = (/** @type {Partial<Parameters<typeof settingsDetail>[0]>} */ read) => settings({ id: SETTINGS_DEFAULTS, ...read });

test('L9: Default models: six rows in the home\'s order, each one picker of the home\'s menu: each model its name, local ones under Local, then More, Off last but for Chat; the one held checked', () => {
  const full = defaults({});
  assert.deepEqual(rowsOf(full, '').map(row => row.label),
    ['Chat', 'Thinking', 'Photos', 'Voice notes', 'Text', 'Search by meaning', 'Hiding details'], 'Chat\'s level under its row');
  assert.deepEqual(part(full, '')?.lines, [], 'no line under the page\'s title');
  const levelless = defaults({ models: { ...MODELS, uses: MODELS.uses.map(use => use.use === 'chat' ? { ...use, thinking: null } : use) } });
  assert.deepEqual(rowsOf(levelless, '').map(row => row.label),
    ['Chat', 'Photos', 'Voice notes', 'Text', 'Search by meaning', 'Hiding details'], 'a Chat model with no levels: no Thinking row');
  for (const use of MODELS.uses) {
    const menu = menuOf(rowIn(full, '', use.label)?.end);
    assert.deepEqual([menu.words, menu.find], [use.words, '']);
    assert.equal(menu.choices.at(-1).words, use.use === 'chat' ? 'More' : 'Off', `${use.use}: Off last, never for Chat`);
  }
  const photos = menuOf(rowIn(full, '', 'Photos')?.end);
  /** @param {string} model */
  const picks = model => ({ host: { act: 'models', do: 'default', use: 'pictures', model } });
  const pictures = /** @type {import('../public/pages.js').ModelUse} */ (MODELS.uses.find(use => use.use === 'pictures'));
  const [plan, vision] = pictures.menu.rows;
  const qwen = pictures.menu.local?.rows[0];
  assert.deepEqual(photos.choices.map((/** @type {any} */ each) => [each.words, each.note, each.tag ?? '', each.head ?? '', each.chosen, Boolean(each.parted), Boolean(each.more), each.do]), [
    ['Plan Model One', '', '', '', false, false, false, picks(plan.value)], ['Vision One', '', '', '', true, false, false, picks(vision.value)],
    ['Qwen 3.5 4B', '', '', 'Local', false, true, false, picks(qwen?.value ?? '')], ['More', '', '', '', false, false, true, { page: 'more:pictures' }],
    ['Off', '', '', '', false, false, false, picks('none')]]);
  assert.equal(rowIn(defaults({ state: null }), '', 'Voice notes')?.end?.words, 'Off', 'without acts it reads the home\'s words');

  const found = { key: '', failed: '', answer: { position: '1:1', today: '2026-06-01', placeholder: 'Search', none: null,
    groups: [{ label: 'OpenRouter', rows: [{ value: 'openrouter:vendor-b/model-1', name: 'Model One', account: null, chosen: false }] },
      { label: 'Local', rows: [{ value: 'runner:mac/model-2', name: 'Model Two', account: 'MacBook Pro', chosen: true }] }] } };
  const more = defaults({ opened: { ...OPENED, pages: ['more:pictures'], typed: 'model', found } });
  assert.deepEqual([more.name, more.back], ['More', { label: 'Default models' }]);
  assert.deepEqual(more.parts.map(each => [each.label, each.panel?.find?.placeholder ?? null, each.panel?.rows.map(row => [row.label, row.tag ?? '', row.act, row.end])]), [
    ['', 'Search', []],
    ['OpenRouter', null, [['Model One', '', picks('openrouter:vendor-b/model-1'), null]]],
    ['Local', null, [['Model Two', 'MacBook Pro', picks('runner:mac/model-2'), { words: '', done: true }]]]], 'the field first, the found under their headers');
  const none = defaults({ opened: { ...OPENED, pages: ['more:pictures'], typed: 'zzz', found: { ...found, answer: { ...found.answer, groups: [], none: 'No matches' } } } });
  assert.equal(none.parts[0].panel?.note, 'No matches');

  const chat = /** @type {import('../public/pages.js').ModelUse} */ (MODELS.uses.find(use => use.use === 'chat'));
  const high = defaults({ models: { ...MODELS, uses: MODELS.uses.map(use => use.use !== 'chat' || !use.thinking ? use : { ...use, thinking: {
    label: 'Thinking', value: 'high', words: 'High', levels: use.thinking.levels.map(level => ({ ...level, chosen: level.value === 'high' })) } }) } });
  const levels = menuOf(rowIn(high, '', 'Thinking')?.end);
  assert.equal(levels.words, 'High', 'the home\'s words for the chosen level');
  assert.deepEqual(levels.choices.map((/** @type {any} */ each) => [each.words, each.chosen, each.default, each.do]), [
    ['Low', false, false, { host: { act: 'models', do: 'default', use: 'chat', model: chat.value, thinking: 'low' } }],
    ['Medium', false, true, { host: { act: 'models', do: 'default', use: 'chat', model: chat.value, thinking: 'medium' } }],
    ['High', true, false, { host: { act: 'models', do: 'default', use: 'chat', model: chat.value, thinking: 'high' } }]]);
  assert.equal(rowIn(defaults({ state: null }), '', 'Thinking')?.end?.words, 'Medium', 'without acts it reads the home\'s words');
  assert.equal(keyOf(levels.choices[0].do.host), keyOf({ act: 'models', do: 'default', use: 'chat', model: 'none' }), 'waits as Chat\'s pick does');

  const off = /** @type {any} */ (pendingOf({ act: 'models', do: 'default', use: 'pictures', model: 'none' }, { report: null, models: MODELS, hiding: null }));
  assert.equal(settled(off, { report: null, models: MODELS, hiding: null }), false);
  const cleared = { ...MODELS, uses: MODELS.uses.map(use => use.use === 'pictures' ? { ...use, value: null } : use) };
  assert.equal(settled(off, { report: null, models: cleared, hiding: null }), true, 'Off lands when the home reads Off');
});

test('L10: General is gone: This Mac\'s Open at login, Updates and Uninstall, each toggle sending the value it would take', () => {
  const mac = settings({ id: 'settings/mac' });
  const login = rowIn(mac, 'MacBook Pro', 'Open at login') ?? rowIn(mac, '', 'Open at login');
  assert.equal(login?.line, 'So this Mac records and syncs after a restart.');
  assert.deepEqual(/** @type {any} */ (login?.end).toggle.do, { host: { act: 'general-login', on: false } });
  assert.deepEqual(endActs(rowIn(mac, 'Uninstall', 'Uninstall Lifestream')), [['Uninstall…', { host: { act: 'uninstall' } }]]);
  assert.equal(rowIn(mac, 'Uninstall', 'Uninstall Lifestream')?.line,
    'Removes the app from this Mac. Lifestream is kept unless you choose to erase it.');
  const updates = settings({ id: 'settings/updates' });
  const version = rowIn(updates, '', 'Version');
  assert.deepEqual([/** @type {any} */ (version?.end).words, version?.line, endActs(version)],
    ['2026.11.10', '', [['Check for Updates…', { host: { act: 'general-check' } }]]]);
  const auto = rowIn(updates, '', 'Install updates automatically');
  assert.equal(auto?.line, 'Lifestream restarts into an update while your screen is locked.');
  assert.deepEqual(/** @type {any} */ (auto?.end).toggle.do, { host: { act: 'general-auto-update', on: false } });
  const general = { login: false, auto_update: false, version: '2026.11.10', update: 'Lifestream 2026.11.12 is ready', by_hand: null };
  assert.equal(rowIn(settings({ id: 'settings/updates', state: { ...HOST_STATE, general } }), '', 'Version')?.line,
    'Lifestream 2026.11.12 is ready');
  const off = settings({ id: 'settings/mac', state: { ...HOST_STATE, general } });
  assert.deepEqual(/** @type {any} */ ((rowIn(off, 'MacBook Pro', 'Open at login') ?? rowIn(off, '', 'Open at login'))?.end).toggle.do,
    { host: { act: 'general-login', on: true } });
  assert.equal(settings({ id: 'settings/updates', state: null }), null);
});

test('L11: in a browser no act on any Settings page, its note saying where they are made', () => {
  for (const models of [MODELS, MODELS_BARE]) {
    const detail = settings({ models, state: null });
    const markup = detailMarkup(detail, AT_REST);
    assert.equal(detail.note, NOTES.browser, 'where it is done');
    assert.equal(markup.replace(/<[^>]*>/gu, ' ').split(esc(NOTES.browser)).length - 1, 1, 'said once, at the page\'s top');
    assert.deepEqual(actsIn(markup).filter(act => 'host' in act || 'save' in act || 'page' in act), []);
    const plans = [...markup.matchAll(/<button[^>]*data-flow="[^"]*"[^>]*>/gu)].map(match => match[0]);
    assert.equal(plans.length, 2);
    for (const each of plans) assert.ok(each.includes('disabled') && each.includes(`title="${esc(ELSEWHERE)}"`), each);
  }
});

test('L12: made: the home\'s line (who wrote it and when, once answered; why, until then), its act with a host, an ask and steps', () => {
  /** @param {any} what @param {boolean} acts */
  const draw = (what, acts, verbs = DESCRIBE) => made({ made: what, verbs, acts, id: 'x', attrs: { 'data-t': '' } });
  const again = draw(DESCRIBED.again, true);
  assert.ok(again.includes(`<p class="ck-made__line mac-subhead">${esc(/** @type {string} */ (DESCRIBED.again.line))}</p>`),
    'the home\'s line of who wrote it');
  assert.equal(draw({ ...DESCRIBED.again, line: null }, true).includes('ck-made__line'), false, 'no line: none made here');
  assert.ok(again.includes('Describe again'));
  assert.deepEqual([...again.matchAll(/data-value="([^"]*)"/gu)].map(match => match[1]), DESCRIBED.again.choose.map(step => step.value));
  assert.equal(draw({ ...DESCRIBED.done, choose: [] }, true).includes('<button'), false);
  for (const what of [DESCRIBED.off, DESCRIBED.older, DESCRIBED.queued, DESCRIBED.failed]) {
    const now = draw(what, true);
    const [step] = what.choose;
    assert.ok(/>Describe now</u.test(now), what.state);
    assert.ok(now.includes(`<p class="ck-made__to mac-subhead">${esc(`${step.words} · ${step.note}`)}</p>`), 'its model and where it goes');
    assert.deepEqual([...now.matchAll(/data-value="([^"]*)"/gu)].map(match => match[1]), [step.value]);
    if (what.line) assert.ok(now.includes(esc(what.line)), `${what.state}: the home's line`);
  }
  for (const what of [DESCRIBED.needs, DESCRIBED.resting]) {
    const markup = draw(what, true);
    assert.ok(markup.includes(esc(/** @type {string} */ (what.line))));
    assert.equal(markup.includes('<button'), false);
  }
  assert.equal(draw(DESCRIBED.again, false).includes('<button'), false);
  assert.equal(draw(DESCRIBED.none, true), '', 'nothing asked of it: nothing drawn');
  assert.equal(draw(null, true), '');
  assert.ok(draw(TRANSCRIBED.again, true, TRANSCRIBE).includes('Transcribe again'));
  assert.ok(/>Transcribe now</u.test(draw(TRANSCRIBED.queued, true, TRANSCRIBE)));
});

test('L17: OpenRouter is connected when the models read says so, and only then', () => {
  const state = { ...HOST_STATE, ask_login: SUBSCRIBED.none };
  /** @param {boolean} held */
  const model = held => modelOf({ report: null, state, models: { ...MODELS_BARE, connections: MODELS_BARE.connections.map(each =>
    each.kind === 'key' ? { ...each, held } : each) } });
  assert.deepEqual([model(false).openrouter, model(false).connected], [false, false]);
  assert.deepEqual([model(true).openrouter, model(true).connected], [true, true]);
  assert.equal(modelOf({ report: null, state, models: null }).connected, false);
  assert.equal(modelOf({ report: null, state }).connected, false);
  const signedIn = modelOf({ report: null, state: { ...HOST_STATE, ask_login: SUBSCRIBED.mixed }, models: MODELS_BARE });
  assert.deepEqual([signedIn.openrouter, signedIn.connected], [false, true]);
});

test('L13: no barred word anywhere this lane draws', () => {
  /** @param {string} markup */
  const shown = markup => markup.replace(/<[^>]*>/gu, ' ').replaceAll('&amp;', '&').replaceAll('&#39;', '’');
  /** @param {Panel} each */
  const menus = each => each.rows.flatMap(row => {
    const menu = menuOf(row.end);
    return menu ? [menu.label, menu.words, ...menu.choices.flatMap((/** @type {any} */ choice) => [choice.words, choice.note])] : [];
  });
  const pages = [
    ...SHAPED.flatMap(id => [dialog(id, HOST_STATE), dialog(id, null)].map(detail => /** @type {Detail} */ ({ ...detail, reads: '',
      panels: detail.panels.filter(each => each.label === 'AI') }))),
    ...SHAPED.flatMap(id => worksOf(id).flatMap(row => [pageOf(id, row.member, HOST_STATE), pageOf(id, row.member, null)])),
    settings({}), settings({ models: MODELS_BARE }), settings({ state: null }), settings({ id: SETTINGS_DEFAULTS }),
    settings({ failed: READ_FAILED }), settings({ models: MODELS_BARE, opened: { ...OPENED, pages: ['address'] } }),
  ];
  for (const detail of pages) {
    const markup = detailMarkup(detail.panels.length || detail.parts.length ? detail : { ...detail, nav: null }, AT_REST);
    const words = [shown(markup), ...detail.panels.flatMap(menus), ...detail.parts.flatMap(each => each.panel ? menus(each.panel) : [])];
    for (const each of words) assert.doesNotMatch(each.replaceAll(RUN_LINE, ''), BARRED, `${detail.id}: "${each.slice(0, 120)}"`);
  }
  for (const what of [...Object.values(DESCRIBED), ...Object.values(TRANSCRIBED)]) {
    const markup = made({ made: what, verbs: DESCRIBE, acts: true, id: 'x' });
    assert.doesNotMatch(shown(markup), BARRED);
  }
});

test('L14: a change waits by what it changes until the read authoritative for it says it', () => {
  /** @param {Partial<import('../public/ui/connectors/pending.js').Reads>} more */
  const reads = more => ({ report: LLM_REPORT, models: MODELS, hiding: null, ...more });
  const MAC = 'runner-macbook-pro-0001';
  const ABSENT = /** @type {import('../public/pages.js').ModelFile} */ (RUNNERS[0].files.find(file => file.state === 'absent'));
  const text = /** @type {const} */ ({ act: 'models', do: 'default', use: 'text' });
  assert.equal(keyOf({ ...text, model: 'openrouter:vendor-a/vision-1' }), keyOf({ ...text, model: 'none' }));
  assert.equal(keyOf({ ...text, model: 'runner:qwen3.5' }), thingKey({ kind: 'default', of: 'text' }), 'the key its menu waits on');
  const fileKey = keyOf({ act: 'models', do: 'file', runner: MAC, id: ABSENT.id, to: 'fetch' });
  assert.equal(fileKey, keyOf({ act: 'models', do: 'file', runner: MAC, id: ABSENT.id, to: 'remove' }));
  assert.equal(keyOf({ act: 'seal', secret: 'openrouter', value: 'x' }), keyOf({ act: 'seal', secret: 'openrouter', value: null }));
  assert.equal(keyOf({ act: 'general-check' }), null);
  const slashed = /** @type {any} */ (pendingOf({ act: 'models', do: 'file', runner: MAC, id: 'vendor/model', to: 'fetch' },
    reads({})));
  assert.deepEqual(slashed.thing, { kind: 'file', runner: MAC, id: 'vendor/model' });
  assert.equal(actKey({ act: 'choose-app' }, { connector: 'screen', member: 'apps' }), 'setting:screen.apps');
  assert.equal(actKey({ act: 'general-check' }), JSON.stringify({ act: 'general-check' }));

  const fetch = /** @type {import('../public/ui/connectors/pending.js').Pending} */ (pendingOf({ act: 'models', do: 'file',
    runner: MAC, id: ABSENT.id, to: 'fetch' }, reads({})));
  assert.equal(settled(fetch, reads({})), false, 'the host answered, the read still says absent');
  /** @param {string} state */
  const nemotron = state => withRunner({ files: RUNNERS[0].files.map(file => file.id === ABSENT.id ? { ...file, state: /** @type {any} */ (state) } : file) });
  assert.equal(settled(fetch, reads({ models: nemotron('fetching') })), true);
  assert.equal(settled(fetch, reads({ models: nemotron('ready') })), true);
  assert.equal(settled(fetch, reads({ models: null })), false, 'a failed read lands nothing');

  const chosen = /** @type {any} */ (pendingOf({ ...text, model: 'runner:qwen3.5' }, reads({})));
  /** @param {string | null} value */
  const textAt = value => ({ ...MODELS, uses: MODELS.uses.map(use => use.use === 'text' ? { ...use, value } : use) });
  assert.equal(settled(chosen, reads({})), false, 'the host answered, the read still says what it was');
  assert.equal(settled(chosen, reads({ models: textAt('runner:qwen3.5') })), true);
  assert.equal(settled(chosen, reads({ models: textAt('openrouter:vendor-a/vision-1') })), true, 'changed elsewhere');

  assert.equal(pendingOf({ act: 'general-login', on: false }, reads({})), null);
  assert.equal(keyOf({ act: 'general-auto-update', on: true }), null);

  const key = /** @type {any} */ (pendingOf({ act: 'seal', secret: 'openrouter', value: null }, reads({})));
  assert.equal(settled(key, reads({})), false);
  assert.equal(settled(key, reads({ models: MODELS_BARE })), true);

  const address = /** @type {any} */ (pendingOf({ act: 'models', do: 'address', url: 'http://127.0.0.1:11434/v1' }, reads({ models: MODELS_BARE })));
  assert.equal(settled(address, reads({ models: MODELS_BARE })), false);
  assert.equal(settled(address, reads({ models: MODELS })), true);
  assert.equal(settled(fetch, reads({ models: withRunner({ line: 'Said by the home' }) })), true, 'a runner gone away lands it');

  const uses = defaults({ models: { ...textAt(null), uses: textAt(null).uses.map(use => use.use === 'text' ? { ...use, words: 'Off' } : use) } });
  const busy = { ...AT_REST, busy: new Set([/** @type {string} */ (keyOf({ ...text, model: 'runner:qwen3.5' }))]) };
  assert.ok(/<button[^>]*aria-busy="true"[^>]*aria-label="Text: Off"/u.test(detailMarkup(uses, busy)), 'the Text menu waits');
  const stream = /** @type {Detail} */ (detailOf(LLM_REPORT, HOST_STATE, 'whatsapp', OPENED));
  const member = { ...AT_REST, busy: new Set(['setting:whatsapp.llm.range']) };
  assert.ok(detailMarkup(stream, member).match(/<button[^>]*aria-busy="true"[^>]*aria-label="([^"]*)"/u)?.[1]
    === esc(`${memberOf('whatsapp', 'llm.range').label}: ${memberOf('whatsapp', 'llm.range').words}`));
});

test('L15: Range\'s date says what it would read before it is sent, one act sending it', () => {
  /** @param {Partial<import('../public/ui/connectors/dialog.js').Dated>} dated */
  const range = dated => menuOf(/** @type {Panel} */ (panel(/** @type {Detail} */ (detailOf(LLM_REPORT, HOST_STATE, 'whatsapp',
    { ...OPENED, dated: { connector: 'whatsapp', member: 'llm.range', value: RANGE_STEP.value, step: null, failed: '', ...dated } })),
  'AI')).rows.at(-1)?.end).date;
  assert.deepEqual(range({}), { label: 'A date', value: RANGE_STEP.value, connector: 'whatsapp', member: 'llm.range', asks: true,
    said: { note: 'Reading what it would read…', act: null } }, 'asked: nothing to send yet');
  assert.deepEqual(range({ step: RANGE_STEP }).said, { note: RANGE_STEP.note, act: { label: 'Back to 3 Mar 2024', variant: 'primary',
    do: { host: { act: 'setting', connector: 'whatsapp', member: 'llm.range', value: RANGE_STEP.value } } } });
  assert.deepEqual(range({ failed: 'Can’t reach Lifestream.' }).said, { note: 'Can’t reach Lifestream.', act: null });
  assert.equal(range({ connector: 'gmail' }).said, null);
});

test('L16: Settings\' Accounts are the model flow\'s two items, ChatGPT and Claude, as the flow draws them', () => {
  assert.deepEqual([...MODEL_ITEMS], ['chatgpt', 'claude'], 'no OpenRouter item: its key is Settings\' Keys');
  assert.deepEqual([...SUBSCRIPTIONS], ['chatgpt', 'claude']);
  /** @param {any} login */
  const drawn = login => {
    const state = { ...HOST_STATE, ask_login: login };
    const detail = settings({ state, subscriptions: plansOf(state) });
    const plans = /** @type {any} */ (part(detail, 'Accounts'));
    assert.deepEqual(plans.flow, plansOf(state));
    assert.ok(flowPageRows(plans.flow).every(row => detailMarkup(detail, AT_REST).includes(row)), 'its items as its rows');
    return plans.flow.lists[0].items.map((/** @type {any} */ item) => [item.name, item.line, item.act?.label ?? '']);
  };
  assert.deepEqual(drawn(SUBSCRIBED.none), [['ChatGPT', 'Use your ChatGPT plan.', 'Connect'], ['Claude', 'Use your Claude plan.', 'Connect']]);
  assert.deepEqual(drawn(SUBSCRIBED.mixed), [['ChatGPT', 'Getting Codex to sign in, 120 of 347 MB.', ''],
    ['Claude', 'person-a@example.com · Max plan', 'Sign out']]);
  assert.deepEqual(drawn(SUBSCRIBED.signing).map(([name, line, act]) => [name, line, act]), [
    ['ChatGPT', 'Enter this code on OpenAI’s page.', 'Open sign-in page'],
    ['Claude', 'Approve on Anthropic’s page. If it shows a code, paste it here.', 'Open sign-in page']]);
  assert.deepEqual(drawn(SUBSCRIBED.failed), [['ChatGPT', 'Sign in with your ChatGPT plan.', 'Sign in'], ['Claude', '', 'Try again']]);
  assert.equal(/** @type {any} */ (part(settings({ subscriptions: null }), 'Accounts'))?.flow, undefined, 'no flow: the home\'s plan rows');
});
