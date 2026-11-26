import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewer } from '../server.mjs';
import { openChrome } from '../tools/chrome.mjs';
import { addRow } from '../public/ui/kit/add-row.js';
import { settingRow, settingsSection, settingTile, settingValue } from '../public/ui/kit/setting-row.js';
import { progressLine, segmented } from '../public/ui/kit/controls.js';
import { menuButton } from '../public/ui/kit/menu-button.js';

const OUT = fileURLToPath(new URL('../.build/e2e/settings-kit/', import.meta.url));
/** @type {Record<string, unknown>} */
const seen = {};
let dir = '';
/** @type {import('node:http').Server | undefined} */
let viewer;
/** @type {Awaited<ReturnType<typeof openChrome>> | undefined} */
let chrome;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dashboard-settings-kit-'));
  const served = await createViewer();
  viewer = served;
  await new Promise(done => served.listen(0, '127.0.0.1', () => done(undefined)));
  const origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (served.address()).port}`;
  chrome = await openChrome({ profile: join(dir, 'chrome'), origin });
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
});

after(async () => {
  await writeFile(join(OUT, 'settings-kit.json'), `${JSON.stringify(seen, null, 2)}\n`).catch(() => undefined);
  await chrome?.close();
  if (viewer) {
    const served = viewer;
    served.closeAllConnections();
    await new Promise(done => served.close(() => done(undefined)));
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('S1: a row is drawn in the one look; the add row is a row of it', () => {
  assert.equal(settingRow({ label: 'Refresh rate', line: 'Every 30 minutes', end: '<b>end</b>' }),
    '<li class="ck-srow"><span class="ck-srow__main"><span class="ck-srow__top"><span class="ck-srow__label">'
    + 'Refresh rate</span></span><span class="ck-srow__line">Every 30 minutes</span></span>'
    + '<span class="ck-srow__end"><b>end</b></span></li>');
  assert.match(addRow({ placeholder: 'Name a new agent' }), /^<li class="ck-srow ck-srow--lead ck-srow--add">/u);
});

test('S2: a row holds every part, a row that opens something is one button', () => {
  const row = settingRow({ label: 'Hiding model', tag: 'English first', line: 'Finds names · 0.9 GB',
    signal: 'engaged', holds: '<i>held</i>', end: settingValue('Downloaded', { done: true }), lead: settingTile('hidden'),
    attrs: { 'data-row': 'x' } });
  assert.match(row, /^<li class="ck-srow ck-srow--lead ck-srow--holds" data-row="x">/u);
  assert.match(row, /<span class="ck-srow__tile"><svg/u);
  assert.match(row, /<span class="ck-srow__label">Hiding model<\/span><span class="ck-srow__tag">English first<\/span>/u);
  assert.match(row, /<span class="ck-srow__line"><svg class="ck-signal__shape"[^]*class="ck-fill-engaged"[^]*<\/svg>Finds names · 0.9 GB<\/span>/u);
  assert.match(row, /<span class="ck-srow__holds"><i>held<\/i><\/span>/u);
  assert.match(row, /<span class="ck-srow__end"><span class="ck-svalue"><svg[^]*Downloaded<\/span><\/span><\/li>$/u);
  assert.match(settingValue('Couldn’t sync', { signal: 'caution' }), /^<span class="ck-svalue"><svg class="ck-signal__shape"[^]*ck-fill-caution[^]*<\/svg>Couldn’t sync<\/span>$/u);
  assert.match(settingRow({ label: 'Theme' }), /^<li class="ck-srow ck-srow--short">/u);
  const needs = settingRow({ label: 'Screen', line: 'Needs a model', mark: '<i>m</i>', act: { 'data-do': 'models' } });
  assert.match(needs, /<button type="button" class="ck-srow__line ck-srow__act" data-do="models"><span class="ck-srow__mark" aria-hidden="true"><i>m<\/i><\/span>Needs a model<\/button>/u);
  assert.match(settingRow({ asking: true, label: 'Remove it?', line: 'Its history stays.', attrs: { class: 'cn-row-ask', role: 'group' } }),
    /^<li class="ck-srow is-asking cn-row-ask" role="group">/u);
  const go = settingRow({ label: 'Screen', line: 'Apps and sites', go: { value: '', attrs: { 'data-open': 'screen' } } });
  assert.match(go, /^<li class="ck-srow ck-srow--go"><button type="button" class="ck-srow__hit" data-open="screen">/u);
  assert.match(go, /<span class="ck-srow__chev" aria-hidden="true">[^]*<\/span><\/button><\/li>$/u);
  assert.doesNotMatch(go, /ck-srow__value|aria-label/u);
  assert.match(settingRow({ label: 'Range', go: { value: 'All', attrs: {} } }),
    /aria-label="Range: All"[^]*<span class="ck-srow__value">All<\/span>/u);
  const section = settingsSection({ heading: 'Permissions', about: 'What macOS asks.', line: 'Each it asks once.',
    act: '<b>Allow all</b>', rows: ['<li>a</li>'], note: 'Change them in System Settings.' });
  assert.match(section, /^<section class="ck-ssection"><div class="ck-ssection__head"><div class="ck-ssection__words"><span class="ck-ssection__titled"><h3 class="ck-ssection__heading">Permissions<\/h3>[^]*What macOS asks\.[^]*<\/span><p class="ck-ssection__line">Each it asks once\.<\/p><\/div><span class="ck-ssection__act"><b>Allow all<\/b><\/span><\/div><ul class="ck-ssection__rows"><li>a<\/li><\/ul><p class="ck-ssection__note">Change them in System Settings\.<\/p><\/section>$/u);
  assert.equal(settingsSection({ heading: 'Removed', rows: [] }), '');
  assert.equal(settingsSection({ rows: ['<li>a</li>'] }), '<section class="ck-ssection ck-ssection--bare"><ul class="ck-ssection__rows"><li>a</li></ul></section>');
  const held = settingRow({ label: 'Recovery key', line: 'No vault yet', end: '<b>Create</b>',
    hold: { faces: [{ line: 'Saved', signal: 'engaged' }, { line: 'Save this key.', holds: '<code>K</code>' }], end: true } });
  assert.match(held, /^<li class="ck-srow ck-srow--holds">/u);
  assert.match(held, /<span class="ck-srow__faces"><span class="ck-srow__face"><span class="ck-srow__line">No vault yet<\/span><\/span><span class="ck-srow__face ck-held" aria-hidden="true" inert><span class="ck-srow__line"><svg[^]*<\/svg>Saved<\/span><\/span><span class="ck-srow__face ck-held" aria-hidden="true" inert><span class="ck-srow__line">Save this key\.<\/span><span class="ck-srow__holds"><code>K<\/code><\/span><\/span><\/span>/u);
  assert.match(held, /<span class="ck-srow__end ck-srow__end--slot"><b>Create<\/b><\/span><\/li>$/u);
  assert.match(settingRow({ label: 'Recovery key', line: 'Saved', hold: { end: true } }),
    /<span class="ck-srow__end ck-srow__end--slot"><\/span><\/li>$/u);
  assert.match(settingRow({ label: 'Gmail', line: 'Reading now', signal: 'engaged', pulse: true }), /<span class="ck-srow__line"><span class="ck-signal__beat">/u);
  assert.equal(settingsSection({ heading: 'Pair', body: '<ol><li>Scan</li></ol>', attrs: { class: 'mine', id: 'p' } }),
    '<section class="ck-ssection mine" id="p"><div class="ck-ssection__head"><div class="ck-ssection__words"><span class="ck-ssection__titled">'
    + '<h3 class="ck-ssection__heading">Pair</h3></span></div></div><div class="ck-ssection__body"><ol><li>Scan</li></ol></div></section>');
  const menu = menuButton({ id: 'audio', label: 'Audio', words: 'Parakeet', note: 'this Mac',
    choices: [{ value: 'p', words: 'Parakeet', chosen: true, default: false }] });
  assert.match(menu, /aria-label="Audio: Parakeet \(this Mac\)"[^]*<span class="ck-menubtn__words">Parakeet<\/span><span class="ck-menubtn__note">this Mac<\/span>/u);
});

test('S3: one value of a segmented control pressed; a progress line within its ends', () => {
  const seg = segmented({ label: 'Theme', choices: [{ value: 'system', words: 'System', chosen: false },
    { value: 'dark', words: 'Dark', chosen: true }] });
  assert.match(seg, /^<div class="ck-seg" role="group" aria-label="Theme">/u);
  assert.deepEqual([...seg.matchAll(/aria-pressed="(\w+)" data-value="(\w+)"/gu)].map(match => [match[2], match[1]]),
    [['system', 'false'], ['dark', 'true']]);
  for (const [share, now] of [[-1, 0], [0.414, 41], [2, 100]]) {
    const line = progressLine({ label: 'Checked', share });
    assert.match(line, new RegExp(`aria-valuenow="${now}"[^]*data-geo="width:${now}%"`, 'u'));
  }
  assert.match(progressLine({ label: 'Downloading', share: 0.4, words: '0.3 of 0.8 GB' }),
    /aria-valuetext="0.3 of 0.8 GB"[^]*<\/span><span class="ck-progress__words">0.3 of 0.8 GB<\/span><\/span>$/u);
});

const SETTLE = `document.getAnimations().forEach(animation => { animation.pause(); animation.currentTime = 10000; });
  new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))`;

const BREAKS = `(() => {
  const out = [];
  const name = el => (el.closest('[data-set-page]')?.dataset.setPage ?? '?') + ': '
    + (el.closest('.ck-srow')?.querySelector('.ck-srow__label')?.textContent ?? el.textContent).slice(0, 40);
  const scene = document.querySelector('[data-set-scene]');
  for (const row of scene.querySelectorAll('.ck-srow')) {
    const box = row.getBoundingClientRect();
    const end = row.querySelector(':scope > .ck-srow__end');
    if (end) {
      const at = end.getBoundingClientRect();
      if (at.right > box.right + 0.5) out.push('end pushed off · ' + name(row));
      if (end.scrollWidth > end.clientWidth + 0.5) out.push('end squeezed · ' + name(row));
    }
  }
  for (const main of scene.querySelectorAll('.ck-srow:not(.ck-srow--add) > .ck-srow__main')) {
    if (main.getBoundingClientRect().width < 139.5) out.push('words under 140 · ' + name(main));
  }
  for (const control of scene.querySelectorAll('.ck-srow__end > :is(.ck-btn, .ck-fmenu > .ck-menubtn), .ck-ssection__act > .ck-btn')) {
    const tall = control.getBoundingClientRect().height;
    if (tall > 32.5) out.push('wrapped ' + Math.round(tall) + ' · ' + name(control));
  }
  for (const page of scene.querySelectorAll('[data-set-page]')) {
    if (page.scrollWidth > page.clientWidth + 0.5) out.push('page overflows · ' + page.dataset.setPage);
    for (const words of page.querySelectorAll('.ck-srow__label, .ck-srow__line, .ck-ssection__heading, .ck-ssection__line')) {
      if (words.getBoundingClientRect().right > page.getBoundingClientRect().right + 0.5) out.push('words out · ' + name(words));
    }
  }
  return out;
})()`;

test('S4–S9: the gallery\'s Settings, demo and worst case, at the dialog\'s width and at 200 % zoom, dark and light', async () => {
  const browser = /** @type {NonNullable<typeof chrome>} */ (chrome);
  const settle = () => browser.evaluate(SETTLE);
  await browser.size(1440, 900, 1);
  await browser.theme('dark');
  await browser.load('kit-gallery.html#group=Settings', '');
  await browser.until(`document.querySelectorAll('[data-gallery-settings] .ck-ssection').length > 20`);
  await browser.until(`Boolean(document.querySelector('[data-shot^="settings-"][data-shot$="-mac"] .cn-set__item'))`);
  const nav = await browser.evaluate(`[...new Set([...document.querySelector('[data-shot^="settings-"][data-shot$="-mac"]').querySelectorAll('.cn-set__item')]
    .map(item => { const box = item.getBoundingClientRect();
      return [Math.round(box.height), Math.round(item.querySelector('.ck-navrow__words').getBoundingClientRect().left - box.left)].join(' '); }))]`);
  seen.nav = nav;
  assert.deepEqual(nav, ['30 34'], 'Settings\' list of pages: one height, words at one x, the sidebar\'s');
  await browser.evaluate(`for (const group of document.querySelectorAll('.gallery__group:not([data-gallery-settings])')) group.remove()`);
  /** @param {'demo' | 'worst'} values */
  const choose = async values => {
    await browser.evaluate(`document.querySelector('[data-set-values] [data-value="${values}"]').click()`);
    await browser.until(`document.querySelector('[data-set-scene]').dataset.setScene === '${values}'`);
  };
  /** @param {string} name */
  const shoot = async name => {
    const box = await browser.evaluate(`(() => { const box = document.querySelector('[data-gallery-settings]').getBoundingClientRect();
      return { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height }; })()`);
    await settle();
    const picture = await browser.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: true,
      clip: { ...box, scale: 1 } });
    await writeFile(join(OUT, `${name}.png`), Buffer.from(picture.data, 'base64'));
  };
  for (const values of /** @type {const} */ (['demo', 'worst'])) {
    await choose(values);
    await browser.size(1440, 900, 1);
    const wide = await browser.evaluate(BREAKS);
    await browser.size(720, 450, 2);
    const zoomed = await browser.evaluate(BREAKS);
    seen[values] = { wide, zoomed, rows: await browser.evaluate(`document.querySelectorAll('[data-set-scene] .ck-srow').length`) };
    assert.deepEqual(wide, [], `${values} at the dialog's width`);
    assert.deepEqual(zoomed, [], `${values} at 200 % zoom`);
    await browser.size(1440, 900, 1);
    for (const theme of /** @type {const} */ (['dark', 'light'])) {
      await browser.theme(theme);
      await shoot(`settings-${values}-${theme}`);
    }
    await browser.theme('dark');
  }
  assert.equal(await browser.evaluate(`document.querySelectorAll('[data-set-scene] .gallery__set-pages [data-set-page="iphone"] .ck-srow').length`), 15);
  assert.ok(await browser.evaluate(`[...document.querySelectorAll('[data-set-page="agents"] .ck-srow__label')].some(each => /[\\u3040-\\u30ff]/u.test(each.textContent))`));
  assert.equal(await browser.evaluate(`document.querySelector('[data-set-page="agents-none"] .ck-ssection:nth-of-type(2) .ck-ssection__line').textContent`),
    'No agent reaches Lifestream yet.');
  const part = (/** @type {string} */ name, /** @type {string} */ inner = '') =>
    `document.querySelector('[data-set-page="parts"] [data-set-part="${name}"]${inner ? ` ${inner}` : ''}')`;
  assert.deepEqual(await browser.evaluate(`(() => { const shown = ${part('menu-open', '.ck-fmenu__said .ck-btn')};
    return [Math.round(shown.getBoundingClientRect().height), getComputedStyle(shown).borderRadius]; })()`), [24, '8px']);
  assert.notEqual(await browser.evaluate(`getComputedStyle(${part('asking')}).backgroundColor`), 'rgba(0, 0, 0, 0)');
  assert.ok(await browser.evaluate(`${part('asking')}.matches('.ck-srow.is-asking.gallery__asked')`));
  assert.equal(await browser.evaluate(`getComputedStyle(${part('line-only')}).marginTop`), '20px');
  assert.ok(await browser.evaluate(`(() => { const row = document.querySelector('[data-set-page="narrow"] [data-set-part="field-end"]');
    const words = row.querySelector('.ck-srow__main').getBoundingClientRect(); const end = row.querySelector('.ck-srow__end').getBoundingClientRect();
    return end.top >= words.bottom && Math.abs(end.right - row.getBoundingClientRect().right) < 0.5; })()`));
  assert.deepEqual(await browser.evaluate(`(() => { const note = document.querySelector('[data-set-scene] .gallery__set-pages [data-set-page="defaults"] .ck-menubtn__note');
    return [note.scrollWidth > note.clientWidth, Math.round(note.closest('.ck-menubtn').getBoundingClientRect().height)]; })()`), [true, 32]);
  assert.deepEqual(await browser.evaluate(`[...new Set([...document.querySelectorAll('[data-set-page="held"] [data-vault-face]')]
    .map(row => Math.round(row.getBoundingClientRect().height)))].length`), 1, 'the vault row one height in every face');
  assert.ok(await browser.evaluate(`[...document.querySelectorAll('[data-set-page="held"] [data-vault-face] .ck-srow__end--slot')]
    .every(slot => slot.getBoundingClientRect().width >= 112)`));
  assert.deepEqual(await browser.evaluate(`['[data-vault-face="none"] .ck-srow__end .ck-btn', '[data-vault-face="shown"] > .ck-srow__main [data-set-part="nested-acts"] .ck-btn']
    .map(at => { const button = document.querySelector('[data-set-page="held"] ' + at); return [getComputedStyle(button).borderRadius, Math.round(button.getBoundingClientRect().height)]; })`),
  [['999px', 32], ['999px', 32]]);
  assert.ok(await browser.evaluate(`(() => { const row = document.querySelector('[data-set-page="held"] [data-vault-face="shown"]');
    return Math.abs(row.querySelector('.ck-srow__lead').getBoundingClientRect().top - row.getBoundingClientRect().top - 8) < 0.5; })()`));
  assert.deepEqual(await browser.evaluate(`(() => { const part = document.querySelector('[data-set-page="held"] [data-set-part="body"]');
    return [part.classList.contains('gallery__bodied'), part.querySelectorAll(':scope > .ck-ssection__body > .ck-callout').length,
      part.querySelectorAll(':scope > .ck-ssection__body > ol').length, part.querySelectorAll('ul.ck-ssection__rows').length]; })()`), [true, 1, 1, 0]);
  assert.deepEqual(await browser.evaluate(`(() => { const parts = [...document.querySelectorAll('[data-set-page="parts"] > .ck-ssection')]
    .map(each => each.getBoundingClientRect()); return parts.slice(1).map((box, at) => Math.round(box.top - parts[at].bottom)); })()`), [20, 36]);
  const rowsOfOneLine = await browser.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-set-scene] .ck-srow:not(.ck-srow--go):not(.ck-srow--add):not(.is-asking)')]
      .filter(row => { const lines = row.querySelectorAll('.ck-srow__line, .ck-srow__wait'); const end = row.querySelector(':scope > .ck-srow__end');
        return lines.length === 1 && Math.round(lines[0].getBoundingClientRect().height) === 16 && !row.querySelector(':scope > .ck-srow__lead')
          && !row.querySelector('.ck-srow__holds, .ck-srow__faces, .ck-srow__tag') && (!end || end.getBoundingClientRect().height <= 32)
          && (!end || end.getBoundingClientRect().top < row.querySelector(':scope > .ck-srow__main').getBoundingClientRect().bottom); });
    const label = getComputedStyle(rows[0].querySelector('.ck-srow__label')); const line = getComputedStyle(rows[0].querySelector('.ck-srow__line, .ck-srow__wait'));
    return [rows.length > 3, [label.fontSize, label.fontWeight, line.fontSize], [...new Set(rows.map(row => Math.round(row.getBoundingClientRect().height)))]]; })()`);
  seen.rowsOfOneLine = rowsOfOneLine;
  assert.deepEqual(rowsOfOneLine, [true, ['13px', '500', '12px'], [52]]);
  assert.equal(await browser.evaluate(`Math.round(document.querySelector('[data-set-scene] .ck-progress__fill').getBoundingClientRect().width)`), 82);
  assert.deepEqual(await browser.evaluate(`(() => { const knob = document.querySelector('[data-set-scene] .ck-srow .ck-toggle__knob');
    return [getComputedStyle(knob).transitionDuration]; })()`), ['0s']);
  await browser.size(720, 450, 2);
  await browser.theme('dark');
  await browser.evaluate(`document.querySelector('.gallery__set-zoomed').scrollIntoView()`);
  const zoomedBox = await browser.evaluate(`(() => { const box = document.querySelector('.gallery__set-zoomed').getBoundingClientRect();
    return { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height }; })()`);
  for (const theme of /** @type {const} */ (['dark', 'light'])) {
    await browser.theme(theme);
    await settle();
    const picture = await browser.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: true, clip: { ...zoomedBox, scale: 1 } });
    await writeFile(join(OUT, `settings-zoomed-${theme}.png`), Buffer.from(picture.data, 'base64'));
  }
  assert.deepEqual(browser.thrown.splice(0), []);
});


const CARD_SCENE = `(async () => {
  const kit = await import('/ui/kit/index.js');
  for (const group of document.querySelectorAll('.gallery__group')) group.remove();
  const go = (label, value) => kit.settingRow({ label, line: 'Opens its page', go: { value, attrs: {} }, attrs: { 'data-card-go': label } });
  const plain = label => kit.settingRow({ label, end: kit.settingValue('Every 5 minutes'), attrs: { 'data-card-plain': label } });
  const many = Array.from({ length: 12 }, (_, at) => plain('Value ' + (at + 1)));
  const last = kit.settingRow({ label: 'How far back', end: kit.menuButton({ id: 'card-last', label: 'How far back', words: 'Past 30 days',
    choices: ['Past day', 'Past week', 'Past 30 days', 'Past year', 'Everything'].map((words, at) => ({ value: String(at), words,
      note: 'Reads ' + words.toLowerCase(), chosen: at === 2, default: false })) }), attrs: { 'data-card-last': '' } });
  const lines = kit.connectorLines([{ name: 'Agents', count: 1, rows: kit.connectorLine({ name: 'Orbit', icon: 'ai-apps',
    line: '3 reads today', place: 'Mac', set_up: true, end: { last: '11:10' }, opens: { 'data-card-cline': '' } }) }], 'Agents');
  const body = lines + '<div data-card-chips></div>' + kit.settingsSection({ heading: 'Access',
    aside: [{ text: '128', bold: true }, { text: ' reads' }],
    rows: [go('Hides', 'Names'), plain('Check every'), go('History', ''), ...many, last], attrs: { class: 'ck-ssection--card' } });
  const stage = document.createElement('div');
  stage.innerHTML = kit.dialog({ title: 'Orbit', line: 'Connected', icon: 'ai-apps', body, close: {}, page: true });
  document.body.append(stage);
  kit.installFilterMenus(stage, () => undefined);
  const chips = stage.querySelector('[data-card-chips]');
  const draw = value => { chips.innerHTML = kit.filterChips({ label: 'Kinds', value, clears: true,
    choices: [{ value: 'messages', label: 'Messages', count: '12' }, { value: 'mail', label: 'Mail', count: '3' }] }); };
  draw('');
  chips.addEventListener('click', event => { const chip = event.target.closest('.ck-fchip'); if (chip) draw(kit.chipPick(chip)); });
  return document.querySelectorAll('.ck-dialog--page .ck-srow').length;
})()`;

const BOX = `(selector => { const box = document.querySelector(selector).getBoundingClientRect();
  return { top: box.top, right: box.right, bottom: box.bottom, left: box.left, height: box.height }; })`;

test('S10: a card\'s row hovers in its own box, 4 inside the card; end columns line up; one hover colour; '
  + 'a menu stays in its dialog; a chip clicked twice clears', async () => {
  const browser = /** @type {NonNullable<typeof chrome>} */ (chrome);
  await browser.size(1440, 900, 1);
  await browser.theme('dark');
  await browser.load('kit-gallery.html#group=__none__', '');
  await browser.until(`document.querySelector('#main')?.dataset.galleryReady === '1'`);
  assert.equal(await browser.evaluate(CARD_SCENE), 16);
  await browser.evaluate(SETTLE);
  const dialog = await browser.evaluate(`${BOX}('.ck-dialog--page')`);
  assert.deepEqual([Math.round(dialog.right - dialog.left), Math.round(dialog.height)], [600, 640], 'the page frame is 600 × 640');
  assert.equal(await browser.evaluate(`document.querySelector('.ck-ssection__aside').textContent`), '128 reads');

  assert.equal(await browser.evaluate(`matchMedia('(hover: hover) and (pointer: fine)').matches`), true, 'the Mac’s pointer, which hovers');
  const card = await browser.evaluate(`${BOX}('.ck-ssection--card > .ck-ssection__rows')`);
  await browser.hover('[data-card-go="Hides"] .ck-srow__hit');
  await browser.until(`document.querySelector('[data-card-go="Hides"] .ck-srow__hit').matches(':hover')`, 'the pointer over the Hides row');
  const hit = await browser.evaluate(`${BOX}('[data-card-go="Hides"] .ck-srow__hit')`);
  seen.hover = { card, hit };
  assert.deepEqual([hit.left - card.left, card.right - hit.right, hit.top - card.top].map(Math.round), [4, 4, 4],
    'the hovered row\'s fill sits 4 inside the card');
  assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('[data-card-plain="Check every"]'), '::before').visibility`),
    'hidden', 'the separator under a hovered row is hidden');
  const fill = `(() => { const probe = document.createElement('span'); document.body.append(probe); probe.style.background = 'var(--hover)';
    const colour = getComputedStyle(probe).backgroundColor; probe.remove(); return colour; })()`;
  const hover = await browser.evaluate(fill);
  const rowFill = await browser.evaluate(`getComputedStyle(document.querySelector('[data-card-go="Hides"] .ck-srow__hit')).backgroundColor`);
  await browser.hover('[data-card-cline]');
  await browser.until(`document.querySelector('[data-card-cline]').matches(':hover')`, 'the pointer over the list line');
  const lineFill = await browser.evaluate(`getComputedStyle(document.querySelector('.ck-cline')).backgroundColor`);
  seen.fills = { hover, rowFill, lineFill };
  assert.deepEqual([rowFill, lineFill], [hover, hover], 'a card row and a list line hover in the one --hover');

  const ends = await browser.evaluate(`[...document.querySelectorAll('[data-card-plain] > .ck-srow__end, [data-card-go] .ck-srow__value')]
    .map(end => Math.round(end.getBoundingClientRect().right))`);
  seen.ends = ends;
  assert.equal(new Set(ends).size, 1, `every end column's right edge is one: ${ends.join(', ')}`);

  await browser.evaluate(`(() => { const body = document.querySelector('.ck-dialog--page .ck-dialog__body'); body.scrollTop = body.scrollHeight; })()`);
  await browser.evaluate(`new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))`);
  await browser.evaluate(`document.querySelector('[data-card-last] .ck-fmenu__btn').click()`);
  await browser.until(`!document.querySelector('[data-card-last] .ck-fmenu__panel').hidden`, 'the last row\'s menu open');
  const panel = await browser.evaluate(`${BOX}('[data-card-last] .ck-fmenu__panel')`);
  seen.menu = { dialog, panel };
  assert.ok(panel.top >= dialog.top && panel.bottom <= dialog.bottom && panel.left >= dialog.left && panel.right <= dialog.right,
    `the menu inside its dialog: ${JSON.stringify(panel)} in ${JSON.stringify(dialog)}`);
  assert.equal(await browser.evaluate(`document.querySelectorAll('[data-card-last] .ck-flist__note').length`), 5, 'each choice says its line');

  for (let at = 0; at < 2; at += 1) await browser.evaluate(`document.querySelector('[data-card-chips] [data-value="mail"]').click()`);
  assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('[data-card-chips] .ck-fchip')]
    .map(chip => [chip.classList.contains('is-chosen'), chip.getAttribute('aria-pressed')])`),
  [[false, 'false'], [false, 'false']], 'a chip clicked twice leaves no chip picked');
  await browser.evaluate(`document.querySelector('[data-card-chips] [data-value="mail"]').click()`);
  assert.equal(await browser.evaluate(`document.querySelector('[data-card-chips] .is-chosen')?.dataset.value`), 'mail');
  assert.deepEqual(browser.thrown.splice(0), []);
});
