import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { askLogin, hostScript, hostState, SENSES, subscription } from './stand-ins/onboarding-home.mjs';
import { onboardingPage, SAID, UNHELD, VAULT_ROW } from './stand-ins/onboarding-page.mjs';

const HELD_CLOCK = `(() => { const now = Date.now, later = window.setTimeout; let held = now(); const set = [];
Date.now = () => held;
window.setTimeout = (run, ms = 0, ...args) => -set.push([held + ms, () => run(...args)]);
window.clockMoved = by => { held += by; window.setTimeout = later;
  for (const [at, run] of set) later(run, Math.max(0, at - held)); }; })()`;

const page = onboardingPage({ file: 'flows-after' });
/** @type {Awaited<ReturnType<typeof page.open>>['front']} */
let front;
/** @type {Awaited<ReturnType<typeof page.open>>['chrome']} */
let chrome;

before(() => page.open());

afterEach(() => {
  front?.reset();
  assert.deepEqual(chrome?.thrown.splice(0), []);
});

after(() => page.close());

describe('flows: the flows after the first run, at the Mac window’s size', () => {

  before(async () => {
    ({ front, chrome } = await page.journey('flows', { size: { width: 1200, height: 860, scale: 1 } }));
    await chrome.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  });

  const { seen, shot, click } = page;

  const MAC = hostState({ granted: ['fullDiskAccess', ...SENSES, 'photos'], more: { setup: null } });
  /** @param {string} state */
  const vault = state => ({ state, saved_ms: state === 'saved' ? Date.UTC(2026, 10, 17, 15) : null });

  /** @param {string} hash @param {unknown} state */
  const load = (hash, state) => chrome.load(hash, hostScript(state));
  /** @param {unknown} state */
  const setState = state => chrome.evaluate(`window.setHostState(${JSON.stringify(state)})`);
  /** @returns {Promise<any[]>} */
  async function acts() {
    const posted = await chrome.evaluate('window.hostActs.splice(0)');
    seen.acts.push(...posted);
    return posted.map((/** @type {any} */ { type: _, ...act }) => act);
  }
  /**
   * @param {string} selector
   * @returns {Promise<string[]>}
   */
  const text = selector => chrome.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})]
  .filter(each => !each.closest('.ck-held')).map(${SAID})`);
  const DIALOG = `document.querySelector('.ck-dialog')`;
  /** @param {string} words */
  const says = words => `(${DIALOG} ? ${UNHELD}(${DIALOG}).includes(${JSON.stringify(words)}) : false)`;
  const TITLE = `${DIALOG}?.querySelector('.ck-dialog__title, .cn-set__title')?.textContent`;
  /** @param {string} title */
  const titled = title => `${TITLE} === ${JSON.stringify(title)}`;
  /** @param {string} page */
  const onPage = page => `(Boolean(document.querySelector('.cn-set [data-cn-set-page="${page}"].is-on')) && !document.querySelector('.cn-set__main--flow'))`;
  /** @param {string} label */
  const press = label => chrome.evaluate(`(() => {
  const found = [...document.querySelectorAll('.ck-dialog button')].filter(each => each.textContent.trim() === ${JSON.stringify(label)});
  if (found.length !== 1) throw new Error(${JSON.stringify(label)} + ' names ' + found.length);
  found[0].click(); })()`);
  const connectRows = () => chrome.evaluate(`[...document.querySelectorAll('.ck-dialog .ck-numbered__step')].map(row => [
  row.className.match(/is-(done|here|idle)/)[1], row.querySelector('.ck-numbered__title').firstChild.textContent,
  row.querySelector('.ck-numbered__line')?.textContent ?? '', row.querySelector('.ck-numbered__body')?.textContent.trim() ?? ''])`);
  const WHOLE = `(() => { const body = document.querySelector('.ck-dialog__body'), box = document.querySelector('.ck-dialog')
  .getBoundingClientRect(); return body.scrollHeight <= body.clientHeight + 1 && box.top >= 0 && box.bottom <= innerHeight; })()`;
  /** @param {string} what */
  const whole = async what => assert.ok(await chrome.evaluate(WHOLE), `${what}: the dialog scrolls in the Mac window`);
  test('the vault, from Gmail’s To connect, on to its sheet by itself', async () => {
    front.scene('counting');
    const none = { ...MAC, vault: vault('none') };
    await load('#view=connectors&dialog=gmail', none);
    await shot('gmail-to-connect', `${titled('Gmail')} && document.querySelector('.ck-dialog .ck-numbered')`);
    assert.deepEqual(await connectRows(), [['here', 'Sign in to Gmail', '', 'Connect'],
      ['here', 'Hand in your Gmail export', '', 'Show']]);
    const signIn = '.ck-dialog .ck-numbered__step.is-here [data-cn-do*="vault"]';
    await whole('Gmail’s To connect');
    await click(signIn);
    await chrome.until(`${titled('Create your vault')} && location.hash.includes('dialog=gmail') && location.hash.includes('flow=vault')`);
    await chrome.until('window.hostActs.length === 1');
    assert.deepEqual(await acts(), [{ act: 'vault', do: 'open' }], 'the vault flow did not open the app\'s window at once');
    assert.deepEqual(await text('.ck-dialog__line'), ['What you enter for Gmail is kept here, encrypted, on this Mac.']);
    assert.equal(await chrome.evaluate(`document.querySelector('.ck-dialog [data-flow="back"]').getAttribute('aria-label')`),
      'Back to Gmail');
    const vaultRow = await chrome.evaluate(VAULT_ROW);
    await whole('the vault, its window asked for');
    assert.deepEqual(await text('.ck-dialog [data-item="vault"] .ck-btn'), ['Create']);
    assert.equal(await chrome.evaluate(`document.querySelector('.ck-dialog .ck-copy, .ck-dialog [data-flow^="vault-"]:not([data-flow="vault-open"])')`),
      null, 'a key, or an act on one, in the page');
    await setState({ ...none, vault: vault('unsaved') });
    await chrome.until(`${says('Create')} && !document.querySelector('.ck-dialog__foot [data-flow="done"]')`);
    const refusal = 'Lifestream couldn’t open the window. Try again.';
    await chrome.evaluate(`window.hostAnswers.vault = { refused: ${JSON.stringify(refusal)} }`);
    await click('[data-flow="vault-open"]');
    await chrome.until(`window.hostActs.length === 1 && document.querySelector('.ck-dialog [data-item="vault"] .ck-srow__line')
      ?.textContent.includes(${JSON.stringify(refusal)})`);
    assert.deepEqual(await acts(), [{ act: 'vault', do: 'open' }]);
    await shot('vault-open-refused', says(refusal));
    await chrome.evaluate('delete window.hostAnswers.vault');
    await chrome.evaluate(HELD_CLOCK);
    await setState({ ...none, vault: vault('saved') });
    await chrome.until(`document.querySelector('.ck-dialog [data-item="vault"] .ck-done') && document.querySelector('.ck-dialog__foot [data-flow="done"]')`);
    assert.deepEqual(await text('.ck-dialog [data-item="vault"] .ck-done'), ['Kept']);
    assert.equal(await chrome.evaluate(VAULT_ROW), vaultRow, 'the vault’s row, kept, moved');
    assert.equal(await chrome.evaluate(`document.querySelector('[data-part="flow-said"]').textContent`), 'Your vault is ready');
    assert.deepEqual(await acts(), [], 'went on before its patience');
    await chrome.evaluate('window.clockMoved(3000)');
    await chrome.until(`${titled('Gmail')} && !location.hash.includes('flow=') && window.hostActs.length === 1`);
    assert.deepEqual(await acts(), [{ act: 'sheet', connector: 'gmail', route: 'gmail-imap' }]);
    await shot('gmail-after-vault', `document.querySelector('.ck-dialog .ck-numbered__step.is-here')`);
    assert.deepEqual((await connectRows()).map(row => row.slice(0, 2)), [['here', 'Sign in to Gmail'],
      ['here', 'Hand in your Gmail export']]);
    await setState(none);
    await chrome.until(`document.querySelector('${signIn}')`);
    await chrome.evaluate(HELD_CLOCK);
    await click(signIn);
    await chrome.until(`${titled('Create your vault')} && window.hostActs.length === 1`);
    assert.deepEqual(await acts(), [{ act: 'vault', do: 'open' }]);
    await setState({ ...none, vault: vault('saved') });
    await chrome.until(`document.querySelector('.ck-dialog__foot [data-flow="done"]')`);
    await click('.ck-dialog__foot [data-flow="done"]');
    await chrome.until(`${titled('Gmail')} && !location.hash.includes('flow=') && window.hostActs.length === 1`);
    assert.deepEqual(await acts(), [{ act: 'sheet', connector: 'gmail', route: 'gmail-imap' }]);
  });

  test('Settings\' Recovery key: each state\'s button the app\'s window or its unlock; a model in Settings', async () => {
    front.scene('counting');
    const home = { ...MAC, vault: vault('saved') };
    await load('#view=connectors&dialog=settings/home', home);
    await shot('your-home', `${titled('General')} && ${says('Pause Lifestream')}`);
    assert.equal(await chrome.evaluate(says('Pair a device')), false);
    assert.equal(await chrome.evaluate(`[...${DIALOG}.querySelectorAll('.ck-srow__label')].some(each => each.textContent.trim() === 'Model')`),
      false, 'a Model row on Home');
    const MODELS = '#view=connectors&dialog=settings/providers';
    await chrome.evaluate(`location.hash = '${MODELS}'`);
    await chrome.until(`document.querySelector('.ck-dialog [data-flow="connect:chatgpt"]')`);
    await chrome.evaluate(`window.hostHolds['ask-login'] = true`);
    await click('[data-flow="connect:chatgpt"]');
    await chrome.until('window.hostActs.length === 1');
    assert.deepEqual(await acts(), [{ act: 'ask-login', do: 'start', of: 'chatgpt' }]);
    await chrome.evaluate(`window.hostHolds['ask-login'] = false`);
    await chrome.press('Escape');
    await chrome.until(`!location.hash.includes('dialog=') && window.hostActs.length === 1`);
    assert.deepEqual(await acts(), [{ act: 'ask-login', do: 'cancel', of: 'chatgpt' }]);
    await chrome.evaluate(`location.hash = '${MODELS}'`);
    await chrome.until(`document.querySelector('.ck-dialog [data-flow="connect:chatgpt"]') && !document.querySelector('[data-flow="connect:chatgpt"]').matches('.is-busy')`);
    await chrome.evaluate('window.hostRelease()');
    await chrome.until(`!document.querySelector('[data-flow="connect:chatgpt"]').matches('.is-busy')`);
    assert.deepEqual(await acts(), [], 'the sign-in cancelled twice, or the late start asked again');
    await click('[data-flow="connect:chatgpt"]');
    await chrome.until('window.hostActs.length === 1');
    assert.deepEqual(await acts(), [{ act: 'ask-login', do: 'start', of: 'chatgpt' }]);
    const code = { ...home, ask_login: askLogin({ chatgpt: subscription('signing_in', { attempt: 'login-1', code: 'QX4F-7KD2',
      url: 'https://auth.example.com/device' }) }) };
    await setState(code);
    await shot('model-code', `${says('QX4F-7KD2')} && document.querySelector('[data-flow="open-page:chatgpt"]')`);
    await chrome.press('Escape');
    await chrome.until(`!location.hash.includes('dialog=') && window.hostActs.length === 1`);
    assert.deepEqual(await acts(), [{ act: 'ask-login', do: 'cancel', of: 'chatgpt' }]);
    await setState(home);
    await load('#view=connectors&dialog=settings/recovery', home);
    for (const [state, words, label, does] of [['saved', 'Saved on 17 Nov 2026', 'Make a new key…', 'open'],
      ['unsaved', 'Not saved', 'Show a new key…', 'open'], ['none', 'No vault yet', 'Create…', 'open'],
      ['locked', 'Locked on this Mac', 'Allow', 'unlock'], ['lost', 'Locked on this Mac', 'Unlock…', 'unlock']]) {
      await setState({ ...home, vault: vault(state) });
      await chrome.until(`${titled('Recovery key')} && ${says(words)} && ${says(label)}`);
      await press(label);
      await chrome.until('window.hostActs.length === 1');
      assert.deepEqual(await acts(), [{ act: 'vault', do: does, label }], state);
      assert.ok(await chrome.evaluate(`${titled('Recovery key')} && !location.hash.includes('flow=')`), `${state}: a flow opened in the page`);
      assert.equal(await chrome.evaluate(says('Start a new vault')), false, `${state}: a new vault on the page`);
    }
  });

  test('the iPhone, from Settings\' iPhones: a phone paired while it shows', async () => {
    front.scene('counting');
    await load('#view=connectors&dialog=apple-photos', MAC);
    const allowPhotos = '.ck-dialog .ck-numbered__step.is-here [data-cn-do*="allow"]';
    await chrome.until(`${titled('Photos')} && document.querySelector('${allowPhotos}')`);
    await chrome.evaluate(`window.hostReplies.allow = 'System Settings didn’t open.'`);
    await click(allowPhotos);
    await chrome.until(`document.querySelector('.ck-numbered__step.is-here .ck-numbered__why')?.textContent === 'System Settings didn’t open.'`);
    assert.deepEqual(await acts(), [{ act: 'allow', grants: ['photos'], label: 'Allow' }]);
    assert.equal(await chrome.evaluate(`document.querySelector('[data-part="said"]').textContent`), '');
    const phones = encodeURIComponent('settings/iphone');
    await load(`#view=connectors&dialog=${phones}`, MAC);
    await chrome.until(`${onPage('iphone')} && ${says('Pair an iPhone')}`);
    await chrome.evaluate(`window.hostReplies.pairing = 'Lifestream couldn’t take this.'`);
    await press('Show code');
    await chrome.until(`${titled('Connect your iPhone')} && window.hostActs.length === 1`);
    assert.deepEqual(await acts(), [{ act: 'pairing', do: 'open' }]);
    await chrome.evaluate('delete window.hostReplies.pairing');
    const reads = `performance.getEntriesByType('resource').filter(each => each.name.includes('/api/page/connectors')).length`;
    const read = await chrome.evaluate(reads);
    await chrome.evaluate(`window.dispatchEvent(new Event('focus'))`);
    await chrome.until(`${reads} > ${read}`);
    const pairing = { link: 'lifestream://pair?code=ABCD2345', code: 'ABCD2345', qr: null, why: null, match: '4F7K',
      expires_ms: Date.now() + 600_000 };
    await setState({ ...MAC, pairing });
    await chrome.until(`${says('Or type ABCD 2345 on your iPhone. It asks you to check that this Mac shows 4F7K.')}
    && ${says('Your iPhone needs to be on the same Wi‑Fi as this Mac, or have Tailscale on both.')} && ${says('Get Tailscale')}`);
    assert.equal(await chrome.evaluate(says('Lifestream couldn’t take this.')), false, 'a refused open said on the page');
    assert.deepEqual(await acts(), [], 'a refused open asked again');
    await whole('the pairing code');
    front.scene('phone');
    await shot('phone-paired', `${says('Person A’s iPhone')} && document.querySelector('.ck-dialog__foot [data-flow="done"]')`);
    assert.equal(await chrome.evaluate(`document.querySelector('[data-part="flow-said"]').textContent`), 'Paired');
    assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('.ck-dialog [data-item="iphone-aa01"] :is(.ck-srow__label, .ck-srow__end)')]
    .map(each => each.textContent.trim())`), ['Person A’s iPhone', 'Paired']);
    assert.ok(await chrome.evaluate(`document.querySelectorAll('.ck-dialog .ck-tiles .ck-grow--tile .ck-tip__mark').length > 0`),
      'the phone’s connectors not its tiles');
    const tipped = `document.querySelector('.ck-dialog .ck-tiles .ck-tip')`;
    await chrome.hover('.ck-dialog .ck-tiles .ck-tip__mark');
    await shot('phone-about', `getComputedStyle(${tipped}.lastElementChild).visibility === 'visible'`);
    assert.ok(await chrome.evaluate(`(() => { const bubble = ${tipped}.lastElementChild.getBoundingClientRect();
    let clip = ${tipped}.parentElement; while (clip && getComputedStyle(clip).overflowY === 'visible') clip = clip.parentElement;
    const box = clip ? clip.getBoundingClientRect() : { top: 0, bottom: innerHeight };
    return bubble.top >= box.top && bubble.bottom <= box.bottom; })()`), 'the scroll cut a tile’s sentence');
    await chrome.hover('');
    assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('.ck-dialog__foot [data-flow]')].map(each => each.dataset.flow)`),
      ['pair-another', 'done']);
    await chrome.until('window.hostActs.length === 1');
    assert.deepEqual(await acts(), [{ act: 'pairing', do: 'close' }]);
    await click('[data-flow="pair-another"]');
    await chrome.until(`${says('Scan the code')} && ${says('Person A’s iPhone')} && window.hostActs.length === 1`);
    assert.deepEqual(await acts(), [{ act: 'pairing', do: 'open' }]);
    assert.equal(await chrome.evaluate(`document.querySelectorAll('.ck-dialog [data-item="iphone-aa01"] .ck-tiles').length`), 0,
      'a paired iPhone’s tiles over the pairing steps');
    await whole('pair another');
    front.scene('phones');
    await chrome.until(`!${says('Scan the code')} && window.hostActs.length === 1`);
    assert.deepEqual(await acts(), [{ act: 'pairing', do: 'close' }]);
    await chrome.evaluate('history.back()');
    await chrome.until(`${onPage('iphone')} && !location.hash.includes('flow=') && location.hash.includes(\`dialog=${phones}\`)`);
    await press('Show code');
    await chrome.until(`${titled('Connect your iPhone')} && ${says('Scan the code')} && window.hostActs.length === 1`);
    assert.equal(await chrome.evaluate(says('Paired')), false, 'a phone paired before counted as this flow’s');
    assert.deepEqual(await acts(), [{ act: 'pairing', do: 'open' }]);
    front.scene('phones-again');
    await chrome.until(`${says('Paired')} && !${says('Scan the code')} && window.hostActs.length === 1`);
    assert.deepEqual(await acts(), [{ act: 'pairing', do: 'close' }]);
    await click('.ck-dialog [data-flow="back"]');
    await chrome.until(onPage('iphone'));
  });

  test('the browser, from Settings\' Chrome extension and from a knock', async () => {
    front.scene('counting');
    await load('#view=connectors&dialog=settings/chrome', MAC);
    await chrome.until(`${titled('Chrome extension')} && ${says('Add to Chrome')}`);
    await press('Add to Chrome');
    await chrome.until(`${titled('Add Lifestream to Chrome')} && location.hash.includes('flow=browser')`);
    await chrome.until('window.hostActs.length === 1');
    assert.deepEqual(await acts(), [{ act: 'connect-wait', do: 'open' }]);
    await whole('the browser flow');
    await click('[data-flow-menu="browser"] .ck-fmenu__btn');
    await chrome.until(`document.querySelector('[data-flow-menu="browser"] .ck-fmenu__btn[aria-expanded="true"]')`);
    await click('[data-flow-menu="browser"] .ck-fmenu__item[data-value="arc"]');
    await chrome.until(titled('Add Lifestream to Arc'));
    await click('[data-flow="add-browser"]');
    await chrome.until('window.hostActs.length === 1');
    assert.deepEqual(await acts(), [{ act: 'open', what: 'browser-store', browser: 'arc' }]);
    await setState({ ...MAC, connect_requests: [{ id: 'req-1', browser: 'Arc' }] });
    await shot('browser-asking', `${says('Arc wants to connect')} && document.querySelectorAll('.ck-scrim').length === 1`);
    assert.deepEqual(await text('.ck-dialog__foot .ck-btn'), ['Not now', 'Allow']);
    await chrome.press('Escape');
    await chrome.until(`!${says('Arc wants to connect')} && ${says('Allow Arc')}`);
    for (const away of ['.ck-dialog__foot [data-flow="close"]', '.ck-dialog__head [data-flow="close"]']) {
      await click('[data-flow="connect-open"]');
      await chrome.until(says('Arc wants to connect'));
      await click(away);
      await chrome.until(`!${says('Arc wants to connect')} && ${says('Allow Arc')} && ${titled('Add Lifestream to Arc')}`);
    }
    assert.deepEqual(await acts(), []);
    await click('[data-flow="connect-open"]');
    await chrome.until(says('Arc wants to connect'));
    await click('[data-flow="connect-yes"]');
    await chrome.until('window.hostActs.length === 1');
    assert.deepEqual(await acts(), [{ act: 'connect-answer', id: 'req-1', allow: true }]);
    await setState(MAC);
    front.scene('connected');
    await chrome.until(`${says('Connected to Arc')} && document.querySelector('.ck-dialog__foot [data-flow="done"]')`);
    await click('[data-flow="open-site:chatgpt"]');
    await chrome.until(`window.hostActs.length === 1 && ${says('Sign in there, then come back.')}`);
    assert.deepEqual((await acts()).map(act => [act.act, act.what]), [['open', 'site']]);
    await click('.ck-dialog__foot [data-flow="done"]');
    await chrome.until(`${titled('Chrome extension')} && ${says('Arc')} && !location.hash.includes('flow=') && window.hostActs.length === 1`);
    assert.deepEqual(await acts(), [{ act: 'connect-wait', do: 'close' }]);
    front.scene('knocking');
    const knocked = { ...MAC, needs: [{ id: 'connect:Arc', line: 'Arc has been asking to connect', detail: null,
      acts: [{ id: 'do', label: 'Connect', tone: 'caution' }], home: true }] };
    await load('#view=connectors&dialog=settings/chrome&flow=browser', knocked);
    await shot('browser-knock', `${titled('Add Lifestream to Arc')} && ${says('Waiting for Arc to ask again.')}`);
  });

  test('a flow over another page: a route, and a Finish row', async () => {
    front.scene('skipped');
    await load('#view=days&flow=phone', MAC);
    await shot('over-days', `document.querySelector('#flow-layer .ck-dialog') && ${titled('Connect your iPhone')}`);
    await chrome.until(`(() => { const column = document.querySelector('.column'), box = column.getBoundingClientRect();
      const inset = parseFloat(getComputedStyle(column).marginTop) + parseFloat(getComputedStyle(column).marginBottom);
      return Math.abs(box.height + inset - innerHeight) < 1 && Math.abs(document.querySelector('.main').getBoundingClientRect().bottom
        - box.bottom) < 1; })()`);
    assert.ok(await chrome.evaluate(`document.querySelector('.column')?.inert === true`), 'the page under it pressable');
    await chrome.press('Escape');
    await chrome.until(`!document.querySelector('#flow-layer .ck-dialog') && !location.hash.includes('flow=')
    && location.hash.includes('view=days') && window.hostActs.length === 2`);
    assert.equal(await chrome.evaluate(`document.querySelector('.column')?.inert`), false);
    assert.deepEqual(await acts(), [{ act: 'pairing', do: 'open' }, { act: 'pairing', do: 'close' }]);
    await setState({ ...MAC, phone_app: null });
    await chrome.evaluate(`location.hash = '#view=days&flow=phone'`);
    await chrome.until(`${titled('Connect your iPhone')}
    && document.activeElement === document.querySelector('#flow-layer .ck-dialog') && window.hostActs.length === 1`);
    assert.deepEqual(await acts(), [{ act: 'pairing', do: 'open' }]);
    await chrome.evaluate(`window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))`);
    await chrome.until('window.hostActs.length === 1');
    assert.deepEqual(await acts(), [{ act: 'pairing', do: 'open' }]);
    await chrome.press('Escape');
    await chrome.until(`!document.querySelector('#flow-layer .ck-dialog') && window.hostActs.length === 1`);
    assert.deepEqual(await acts(), [{ act: 'pairing', do: 'close' }]);
    await chrome.evaluate(`location.hash = '#view=ask'`);
    await chrome.until(`location.hash.includes('view=ask') && document.querySelector('[data-finish]')`);
    await chrome.evaluate(`document.querySelector('#sidebar-finish [data-finish-flow="browser"]').focus()`);
    await click('#sidebar-finish [data-finish-flow="browser"]');
    await chrome.until(`document.querySelector('#flow-layer .ck-dialog') && location.hash.includes('flow=browser')`);
    await chrome.until('window.hostActs.length === 1');
    assert.deepEqual(await acts(), [{ act: 'connect-wait', do: 'open' }]);
    await click('#flow-layer [data-flow="close"]');
    await chrome.until(`!document.querySelector('#flow-layer .ck-dialog') && window.hostActs.length === 1`);
    assert.deepEqual(await acts(), [{ act: 'connect-wait', do: 'close' }]);
    assert.ok(await chrome.evaluate(`document.activeElement?.matches('#sidebar-finish [data-finish-flow="browser"]')`),
      'the focus given to the page under the flow');
  });
});
