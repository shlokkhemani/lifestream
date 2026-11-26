// @ts-check
import { HOST_STATE, REPORT } from '../../public/kit-gallery-report.js';
import { PAIR_QR } from '../../public/kit-gallery-flows.js';
import { MODELS_BARE } from '../../public/kit-gallery-llm.js';
import { STATES } from '../../public/kit-gallery-reach.js';
import { askLogin, subscription } from './onboarding-home.mjs';
import LIST from '../../../homelink/Tests/Fixtures/agents/door/list.json' with { type: 'json' };
import GUIDES from '../../../homelink/Tests/Fixtures/pages/agentGuides.mac.json' with { type: 'json' };
import ADDRESS_ON from '../../../homelink/Tests/Fixtures/agents/guide-door/address-on.json' with { type: 'json' };
import ADDRESS_FIX from '../../../homelink/Tests/Fixtures/agents/guide-door/address-fix-turn-on.json' with { type: 'json' };
import KEYS_INSTINCT from '../../../homelink/Tests/Fixtures/agents/guide-door/keys-instinct.json' with { type: 'json' };

const LATER = Date.now() + 3_600_000;

export function streamsScreens() {
  const host = (/** @type {any} */ more = {}) => ({ ...HOST_STATE, needs: [], setup: { state: 'done' }, ...more });
  const report = (/** @type {any} */ value) => [{ url: 'api/page/connectors', json: value }];
  const base = report(REPORT);
  const S = (/** @type {string} */ name, /** @type {string} */ title, /** @type {string} */ hash, more = {}) => ({ section: 'Connectors', name, title, hash, base: /** @type {const} */ ('home'), host: host(), stub: base, ...more });
  const dialog = (/** @type {string} */ id) => `#view=connectors&dialog=${encodeURIComponent(id)}`;
  const flow = (/** @type {string} */ id) => `#view=connectors&flow=${id}`;
  const FL = (/** @type {string} */ name, /** @type {string} */ title, /** @type {string} */ id, /** @type {any} */ state, more = {}) => ({ section: 'Flows', name, title, hash: flow(id), base: /** @type {const} */ ('home'), host: host(state), stub: base, ...more });
  const vault = (/** @type {string} */ state) => ({ vault: { state, saved_ms: null } });
  const login = (/** @type {any} */ more) => ({ ask_login: askLogin(more) });
  const SUB = (/** @type {string} */ name, /** @type {string} */ title, /** @type {any} */ state) => S(name, title, dialog('settings/models'),
    { host: host(state), stub: [...base, { url: 'api/page/models', json: MODELS_BARE }] });
  const FILE = (/** @type {string} */ name, /** @type {string} */ title, /** @type {any} */ models) => S(name, title, dialog('settings/models'),
    { host: host(login({})), stub: [...base, { url: 'api/page/models', json: models }], run: `await S.until('.ck-dialog'); await S.sleep(500);` });
  const qwen = (/** @type {'absent' | 'fetching' | 'ready' | 'failed'} */ state, /** @type {string | null} */ line) => ({ ...MODELS_BARE,
    connections: MODELS_BARE.connections.map(each => each.kind !== 'runner' ? each
      : { ...each, files: each.files.map((file, at) => at !== 0 ? file : { ...file, state, line,
        acts: /** @type {('fetch' | 'remove' | 'cancel')[]} */ ([state === 'ready' ? 'remove' : state === 'fetching' ? 'cancel' : 'fetch']) }) }) });
  const CODE = subscription('signing_in', { attempt: 'login-1', code: 'QX4F-7KD2', url: 'https://auth.example.com/device' });
  const ANTHROPIC = subscription('signing_in', { attempt: '0f3a9c2e7b1d4a60', url: 'https://claude.example.com/oauth/authorize' });
  const PAIRING = { pairing: { link: 'lifestream://pair?code=ABCD2345', code: 'ABCD2345', qr: PAIR_QR, why: null, match: '4F7K', expires_ms: LATER }, phone_app: { link: 'https://testflight.example.com/join/AAAA0000', qr: PAIR_QR } };
  const NOPHONE = { ...REPORT, devices: REPORT.devices.filter((/** @type {any} */ each) => each.kind !== 'phone') };
  const extension = (/** @type {boolean} */ present, /** @type {any} */ patch = {}) => ({ ...REPORT, connectors: REPORT.connectors.map((/** @type {any} */ each) => each.roads?.includes('chrome') ? { ...each, ...patch } : each),
    extension: { ...REPORT.extension, present, browsers: present ? REPORT.extension.browsers : [] } });
  const WAITING = extension(false, { chosen: false, signed_in: null, checking: false, browser: null });
  const LOOKED = (/** @type {any} */ patch) => extension(true, { chosen: false, checking: false, ...patch });
  const CHROME = { id: 'chrome', name: 'Chrome', profiles: [{ id: 'Default', name: 'Person A' }] };
  const ARC = { id: 'arc', name: 'Arc', profiles: [{ id: 'Default', name: 'Person A' }] };
  const browsers = { browsers: [ARC, CHROME] };
  const units = REPORT.devices.map((/** @type {any} */ each) => each);
  const pageOf = (/** @type {number} */ at) => `await S.until('.ck-dialog'); await S.sleep(500); const pages = [...document.querySelectorAll('.ck-dialog [data-cn-do*=page]')]; if (!pages[${at}]) throw new Error('skip: no such page'); pages[${at}].click(); await S.sleep(800);`;
  const menuOf = `await S.until('.ck-dialog'); await S.sleep(500); const menu = document.querySelector('.ck-dialog .ck-fmenu__btn, .ck-dialog .ck-menubtn, .ck-dialog [aria-haspopup="menu"]'); if (!menu) throw new Error('skip: no menu'); menu.click(); await S.sleep(500);`;
  const empty = { ...REPORT, connectors: REPORT.connectors.map((/** @type {any} */ each) => ({ ...each, set_up: false, copies: [], on: false, health: { ...each.health, state: 'setup', acts: [], words: 'Not set up' } })), needs: [], devices: REPORT.devices.filter((/** @type {any} */ each) => each.kind === 'mac').slice(0, 1), imports: REPORT.imports.map((/** @type {any} */ each) => ({ ...each, held: [], coming: [] })) };
  const readers = LIST.answer.readers;
  const chats = readers.filter(each => each.kind === 'chat');
  const AG = (/** @type {string} */ name, /** @type {string} */ title, /** @type {string} */ at, { shown = readers, address = /** @type {unknown} */ (ADDRESS_ON.answer), run = '' } = {}) => ({ section: 'Agents', name, title,
    hash: at ? `#view=agents&dialog=${encodeURIComponent(at)}` : '#view=agents', base: /** @type {const} */ ('home'), host: host(),
    stub: [{ url: 'api/agents(\\?|$)', json: { readers: shown } }, { url: 'api/agents/guides', json: GUIDES }, { url: 'api/agents/address', json: address },
      { url: 'api/agents/waiting', json: { requests: [] } }, { url: 'api/agents/keys', method: 'POST', json: KEYS_INSTINCT.answer }], ...run ? { run } : {} });
  const guideDo = (/** @type {object} */ does, more = '') => JSON.stringify(`.ck-dialog [data-cn-do='${JSON.stringify({ guide: does })}']${more}`);
  const keyMade = `await S.until('.ck-dialog'); await S.click(${guideDo({ linked: true })}); await S.click(${guideDo({ make: true }, ':not(:disabled)')}); await S.until(() => document.querySelector('.ck-dialog')?.textContent.includes(${JSON.stringify(KEYS_INSTINCT.answer.rows[1].text)})); await S.sleep(400);`;
  const own = REPORT.connectors.filter((/** @type {any} */ each) => each.shown !== null);
  const held = own.map((/** @type {any} */ each) => S(`dialog-${each.id}`, `Connector page: ${each.name} (${each.health?.state ?? 'no state'})`, dialog(each.id), { run: `await S.until('.ck-dialog'); await S.sleep(500);` }));
  const pages = own.flatMap((/** @type {any} */ each) => [0, 1, 2].map(at => S(`dialog-${each.id}-page${at + 1}`, `Connector page: ${each.name}, inner page ${at + 1}`, dialog(each.id), { run: pageOf(at), optional: true })));
  const menus = own.map((/** @type {any} */ each) => S(`dialog-${each.id}-menu`, `Connector page: ${each.name}, a setting’s menu open`, dialog(each.id), { run: menuOf, optional: true }));
  const ends = own.map((/** @type {any} */ each) => S(`dialog-${each.id}-end`, `Connector page: ${each.name}, scrolled to its end`, dialog(each.id), { run: `await S.until('.ck-dialog__body'); await S.sleep(500); await S.scroll('.ck-dialog__body', 100000);`, optional: true }));
  const HELD = { ...REPORT, connectors: REPORT.connectors.map((/** @type {any} */ each) => each.id !== 'whatsapp' ? each
    : { ...each, pauses: [{ scope: 'history', by: 'person', reason: 'paused by hand', at_ms: REPORT.at_ms - 86_400_000 }] }),
  paused: [...REPORT.paused, { target: 'pause:whatsapp:history', by: 'person', reason: 'paused by hand', at_ms: REPORT.at_ms - 86_400_000,
    holds: null, title: 'Paused: WhatsApp’s history', line: 'paused by hand · since yesterday' }] };
  const heldHistory = `await S.until('.ck-dialog .ck-ssection__heading'); await S.sleep(400); [...document.querySelectorAll('.ck-dialog .ck-ssection__heading')].find(each => each.textContent === 'History')?.scrollIntoView({ block: 'start' }); await S.sleep(500);`;
  const window = (/** @type {string} */ name, /** @type {string} */ title, /** @type {string} */ hash, /** @type {any} */ state, more = {}) => ({ section: 'Window', name, title, hash, host: host(state), ...more });
  const warning = { reach: STATES['unreachable, Lifestream not running'] };
  const starting = { reach: STATES.starting };
  const caution = { reach: STATES['update, this Mac\'s'] };
  const update = { update: { id: 'update:ready', line: 'Lifestream 2026.11.06 is ready', detail: null, acts: [{ id: 'install', label: 'Restart to Update', tone: 'caution' }], home: false } };
  const heldHome = { reach: STATES.held };
  const down = [{ url: 'api/', status: 503, json: { error: 'Can\'t reach Lifestream.', code: 'GONE' } }];
  const card = { agent_requests: [{ id: 'request-a', name: 'Claude', checked: false, host: 'claude.ai', choices: [17, 42, 86], until_ms: Date.now() + 300_000 }] };
  return [
    S('streams', 'Connectors, every state of a connector, alerts at the top', '#view=connectors'),
    S('streams-scrolled', 'Connectors, scrolled under its head', '#view=connectors', { run: `await S.scroll('.ck-page__scroll', 400);` }),
    S('streams-imports', 'Connectors, at Imports', '#view=connectors&seg=imports'),
    S('streams-place-menu', 'Connectors, the Where filter open', '#view=connectors', { run: `await S.click('[data-cn-menu="place"] .ck-fmenu__btn'); await S.sleep(300);` }),
    S('streams-search', 'Connectors, searched', '#view=connectors', { run: `await S.type('[data-cn-q]', 'mail');` }),
    S('streams-search-none', 'Connectors, a search finding nothing', '#view=connectors', { run: `await S.type('[data-cn-q]', 'zzqq');` }),
    S('streams-removed', 'Connectors, removed devices opened', '#view=connectors', { stub: report({ ...REPORT, devices: [...REPORT.devices, { ...REPORT.devices.find((/** @type {any} */ each) => each.kind === 'phone'), unit: 'iphone-8-dd04', name: 'iPhone 8', retired: true }] }), run: `await S.click('[data-cn-do*="removed"]'); await S.sleep(400);` }),
    S('streams-empty', 'Connectors, nothing set up yet', '#view=connectors', { stub: report(empty) }),
    S('streams-reading', 'Connectors, loading', '#view=connectors', { stub: [{ url: 'api/page/connectors', hold: true }], raw: true, run: `await S.sleep(2600);`, whole: false }),
    S('streams-failed', 'Connectors, could not be read', '#view=connectors', { stub: [{ url: 'api/page/connectors', status: 503, json: { error: 'Lifestream is starting: it answers in a moment.' } }] }),
    ...['home', 'storage', 'time', 'recovery', 'mac', 'iphone', 'chrome', 'models', 'appearance', 'updates', 'advanced']
      .map(page => S(`settings-${page}`, `Settings: ${page}`, dialog(`settings/${page}`))),
    S('settings-mac-rename', 'Settings: Macs, Rename… open', dialog('settings/mac'), { run: `await S.until('.cn-set'); await S.sleep(400); const rename = [...document.querySelectorAll('.cn-set button')].find(each => each.textContent.trim() === 'Rename…'); if (!rename) throw new Error('skip: no Rename…'); rename.click(); await S.sleep(500);`, optional: true }),
    S('settings-search', 'Settings, searched', dialog('settings'), { run: `await S.until('.cn-set input'); await S.type('.cn-set input', 'port');` }),
    AG('agents-none', 'Agents, none connected: the page is the setup', '', { shown: chats }),
    AG('agents', 'Agents, agents connected', ''),
    AG('agents-guides', 'Agents, Connect an agent: the guides', 'agents:connect'),
    AG('agents-guide-claude-tailscale', 'Agents, Claude’s guide, Tailscale’s step to put the address on the internet', 'agents:connect/guide:claude', { address: ADDRESS_FIX.answer }),
    AG('agents-guide-claude', 'Agents, Claude’s guide, its address ready', 'agents:connect/guide:claude'),
    AG('agents-guide-instinct-made', 'Agents, Instinct’s guide, its key made', 'agents:connect/guide:instinct', { shown: chats, run: keyMade }),
    S('settings-chrome-missing', 'Settings: Chrome extension, not added yet', dialog('settings/chrome'), { stub: report(WAITING) }),
    ...units.filter((/** @type {any} */ each) => each.kind === 'phone').map((/** @type {any} */ each) => S(`settings-iphone-${each.unit}`, `Settings: iPhones at ${each.name}${each.retired ? ', removed' : ''}`, dialog(`settings/iphone/${each.unit}`))),
    ...REPORT.imports.map((/** @type {any} */ each) => S(`dialog-import-${each.kind}`, `Import window: ${each.name}`, dialog(`import:${each.kind}`))),
    ...held, ...pages, ...menus, ...ends,
    S('dialog-whatsapp-backfill-paused', 'Connector page: WhatsApp, its history paused by hand', dialog('whatsapp'), { stub: report(HELD), run: heldHistory }),
    S('settings-recovery-none', 'Settings: Recovery key, no vault yet', dialog('settings/recovery'), { host: host(vault('none')) }),
    S('settings-recovery-locked', 'Settings: Recovery key, the vault locked on this Mac', dialog('settings/recovery'), { host: host(vault('locked')) }),
    S('dialog-confirm-off', 'Connector page, Disconnect asks first', dialog('whatsapp'), { run: `await S.until('.ck-dialog'); await S.sleep(400); const off = [...document.querySelectorAll('.ck-dialog [data-cn-do]')].find(each => /asking|confirm|"ask"/.test(each.dataset.cnDo)); if (!off) throw new Error('skip: no confirm'); off.click(); await S.sleep(600);`, optional: true }),
    S('settings-confirm-remove-phone', 'Settings: iPhones, removing a phone asks first', dialog(`settings/iphone/${units.find((/** @type {any} */ each) => each.kind === 'phone' && !each.retired)?.unit}`), { run: `await S.until('.cn-set'); await S.sleep(400); const off = [...document.querySelectorAll('.ck-dialog [data-cn-do]')].find(each => /asking|confirm|"ask"/.test(each.dataset.cnDo)); if (!off) throw new Error('skip: no confirm'); off.click(); await S.sleep(600);`, optional: true }),
    S('dialog-import-none', 'Import window, nothing coming or held', dialog(`import:${REPORT.imports[0].kind}`), { stub: report(empty) }),
    FL('flow-vault-make', 'Vault flow, Your vault', 'vault', vault('none')),
    FL('flow-vault-kept', 'Vault flow, kept', 'vault', vault('saved')),
    FL('flow-vault-unsaved', 'Vault flow, made and never kept', 'vault', vault('unsaved')),
    FL('flow-vault-locked', 'Vault flow, locked on this Mac', 'vault', vault('locked')),
    SUB('settings-subscriptions-none', 'Settings, AI models: Subscriptions, none yet', login({})),
    SUB('settings-subscriptions-fetching', 'Settings, AI models: Claude Code downloading', login({ claude: subscription('fetching', { bytes: 120_000_000, total: 324_000_000 }) })),
    SUB('settings-subscriptions-code', 'Settings, AI models: the sign-in code', login({ chatgpt: CODE })),
    SUB('settings-subscriptions-claude', 'Settings, AI models: Claude signing in, a code field', login({ claude: ANTHROPIC })),
    SUB('settings-subscriptions-expired', 'Settings, AI models: the code ran out', login({ chatgpt: subscription('failed', { why: 'This code ran out.' }) })),
    SUB('settings-subscriptions-signed-in', 'Settings, AI models: signed in to both plans', login({ chatgpt: subscription('signed_in', { account: 'person-a@example.com', plan: 'plus' }),
      claude: subscription('signed_in', { account: 'person-a@example.com', plan: 'max' }) })),
    FILE('settings-models-absent', 'Settings, AI models: a model file to download', MODELS_BARE),
    FILE('settings-models-downloading', 'Settings, AI models: a model file downloading', qwen('fetching', 'Downloading, 0.9 of 4 GB')),
    FILE('settings-models-ready', 'Settings, AI models: a model file downloaded', qwen('ready', null)),
    FL('flow-phone-first', 'iPhone flow, no phone yet: the pairing code, Get the app above it', 'phone', PAIRING, { stub: report(NOPHONE) }),
    FL('flow-phone-app', 'iPhone flow, Get the app pressed: the app’s code', 'phone', PAIRING, { stub: report(NOPHONE), run: `await S.sleep(500); await S.press('Get the app'); await S.sleep(600);` }),
    FL('flow-phone-no-wifi', 'iPhone flow, this Mac can’t listen', 'phone', { ...PAIRING, pairing: { ...PAIRING.pairing, link: null, code: null, qr: null, why: 'Lifestream can’t open its Wi-Fi connection.' } }, { stub: report(NOPHONE) }),
    FL('flow-phone-paired', 'iPhone flow, from a Mac with a phone paired', 'phone', PAIRING),
    FL('flow-browser-none', 'Browser flow, no Chrome-family browser', 'browser', { browsers: [] }, { stub: report(WAITING) }),
    FL('flow-browser-one', 'Browser flow, one browser', 'browser', { browsers: [CHROME] }, { stub: report(WAITING) }),
    FL('flow-browser-two', 'Browser flow, two browsers', 'browser', browsers, { stub: report(WAITING) }),
    FL('flow-browser-asks', 'Browser flow, Arc asks to connect', 'browser', { ...browsers, connect_requests: [{ id: 'request-1', browser: 'Arc' }] }, { stub: report(WAITING) }),
    FL('flow-browser-looking', 'Browser flow, sites being looked at', 'browser', browsers, { stub: report(LOOKED({ signed_in: null, checking: true })) }),
    FL('flow-browser-signed-in', 'Browser flow, sites signed in', 'browser', browsers, { stub: report(LOOKED({ signed_in: true })) }),
    FL('flow-browser-signed-out', 'Browser flow, sites not signed in', 'browser', browsers, { stub: report(LOOKED({ signed_in: false })) }),
    FL('flow-browser-done', 'Browser flow, sites connected', 'browser', browsers),
    FL('flow-browser-reading', 'Browser flow, before the report is read', 'browser', browsers, { stub: [{ url: 'api/page/connectors', hold: true }], raw: true, run: `await S.sleep(1800);`, whole: false }),
    FL('flow-over-days', 'A flow over another page (Days)', 'phone', PAIRING, { hash: `#view=days&on=2026-10-17&flow=phone`, base: 'full', stub: [] }),
    window('window-home-warning', 'Status strip: can’t reach Lifestream', '#view=people', warning),
    window('window-home-starting', 'Status strip: Lifestream is starting', '#view=ask', starting),
    window('window-home-details', 'Status strip: Details open, the checklist of the path', '#view=ask', warning,
      { stub: down, run: `await S.click('[data-home-details]'); await S.sleep(400);` }),
    window('window-home-held', 'Status strip: a held home, its act', '#view=ask', heldHome, { stub: down }),
    window('window-home-caution', 'Status strip: an update', '#view=days&on=2026-10-17', caution),
    window('window-unreachable-chat', 'Home unreachable: Chat', '#view=ask', warning, { stub: down }),
    window('window-unreachable-days', 'Home unreachable: Days', '#view=days&on=2026-10-17', warning, { stub: down }),
    window('window-unreachable-people', 'Home unreachable: People', '#view=people', warning, { stub: down }),
    window('window-unreachable-places', 'Home unreachable: Places', '#view=places', warning, { stub: down }),
    window('window-unreachable-streams', 'Home unreachable: Connectors', '#view=connectors', warning, { stub: down }),
    window('window-unreachable-search', 'Home unreachable: Search', '#view=search&q=river', warning, { stub: down }),
    window('window-recorder-idle', 'Recorder line: paused', '#view=ask', { recorder: { signal: 'idle', words: 'Paused' } }),
    window('window-recorder-caution', 'Recorder line: a caution', '#view=ask', { recorder: { signal: 'caution', words: 'Not recording: Screen Recording is off' } }),
    window('window-recorder-warning', 'Recorder line: a warning', '#view=ask', { recorder: { signal: 'warning', words: "Not recording · screen unavailable" } }),
    window('window-update-mark', 'An update waiting: the dot on the person’s row', '#view=ask', update),
    window('window-update-open', 'The person’s menu open: Settings and the update', '#view=ask', update, { run: `await S.click('#sidebar-you .ck-account__btn'); await S.sleep(400);` }),
    window('window-finish-open', 'Finish setting up, its list opened', '#view=ask', { grants: [] }, { stub: report(REPORT), run: `await S.click('[data-finish]'); await S.sleep(300);`, base: 'home' }),
    window('window-agent-card', 'An agent’s sign-in card over the page', '#view=ask', card),
    window('window-agent-card-unchecked', 'An agent’s sign-in card, a name not checked', '#view=people', { agent_requests: [{ id: 'request-b', name: 'Some App', checked: false, host: null, choices: [23, 51, 94], until_ms: Date.now() + 300_000 }] }),
    window('window-agent-card-checked', 'An agent’s sign-in card, a name checked', '#view=days&on=2026-10-17', { agent_requests: [{ id: 'request-c', name: 'Claude', checked: true, host: 'claude.ai', choices: [23, 51, 94], until_ms: Date.now() + 300_000 }] }),
    window('window-lantern', 'Sidebar with Connectors’ count', '#view=people', {}, { stub: report(REPORT) }),
  ];
}
