// @ts-check
import { esc } from './lib/html.js';
import { applyGeometry } from './ui/geometry.js';
import { storageMarkup } from './ui/connectors/settings-storage.js';
import { sizeWords } from './lib/words.js';
import { REPORT } from './kit-gallery-report.js';
import {
  addRow, button, icon, menuButton, progressLine, sectionLabel, segmented, settingRow, settingsSection, settingTile,
  settingValue, textField, toggle, appIcon, callout, action,
} from './ui/kit/index.js';

/** @typedef {import('./ui/kit/signal.js').SignalKind} SignalKind */

/** @typedef {{ runner: string, note: string, home: { words: string, tone: SignalKind }, paused: { title: string, line: string }[], phones: { name: string, line: string, tone: SignalKind, streams: number, pair?: boolean }[], removed: string[], agents: { name: string, line: string, hides: string }[], reads: { name: string, line: string, tone: SignalKind }[], qwen: string, words: number, sent: { name: string, items: number, hidden: number }[], jobs: number, streams: number, }} Shown */

/**
 * @param {number} n
 * @param {string} one
 * @param {string} [many]
 */
const count = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** @type {Shown} */
const DEMO = {
  runner: 'this Mac',
  note: 'this Mac',
  home: { words: 'Running · checked 19:29', tone: 'engaged' },
  paused: [{ title: 'WhatsApp history', line: 'Paused by you on 8 Nov' }],
  phones: [{ name: 'iPhone 17 Pro', line: 'Synced 19:17', tone: 'engaged', streams: 9 }],
  removed: ['iPhone 13'],
  agents: [{ name: 'claude.ai', line: 'Connected 28 Oct', hides: 'Keeps names' },
    { name: 'Coding agent', line: 'Pass · from the internet · added 2 Nov', hides: 'Hides all' }],
  reads: [{ name: 'ChatGPT', line: 'Synced 19:02', tone: 'engaged' }, { name: 'Claude', line: 'Couldn’t sync', tone: 'caution' },
    { name: 'X', line: 'Off', tone: 'idle' }],
  qwen: 'Describes photos and sums up text · 4.2 GB',
  words: 3,
  sent: [{ name: 'Anthropic', items: 412, hidden: 3912 }, { name: 'OpenAI', items: 1, hidden: 14 }],
  jobs: 8,
  streams: 3,
};

const LONGEST = 'Couldn’t sync: Google asked you to sign in again before Lifestream can read your mail, and nothing new '
  + 'arrives until you do.';

/** @type {Shown} */
const WORST = {
  runner: 'MacBook Pro of Person A’s Synthetic Home',
  note: 'MacBook Pro of Person A’s Synthetic Home',
  home: { words: LONGEST, tone: 'warning' },
  paused: [{ title: 'Every model call', line: 'Paused by you on 8 Nov' }],
  phones: Array.from({ length: 12 }, (_, at) => ({
    name: at === 0 ? 'iPhone 17 Pro Max of Person A’s Synthetic' : `iPhone ${at + 4}`,
    line: at === 1 ? 'Pair this iPhone again to keep it sending' : at === 2 ? LONGEST : `Synced 19:${String(at + 10).padStart(2, '0')}`,
    tone: /** @type {SignalKind} */ (at === 1 ? 'caution' : at === 2 ? 'warning' : 'engaged'),
    streams: at === 0 ? 1 : at + 2,
    pair: at === 1,
  })),
  removed: ['iPhone 13', 'iPhone SE of Person A’s Synthetic Household'],
  agents: [{ name: 'コーディング用エージェント（仕事用のマシン）', line: 'Pass · from the internet · added 2 Nov', hides: 'Hides all' }],
  reads: [{ name: 'Claude', line: LONGEST, tone: 'warning' }],
  qwen: 'Describes photos, sums up text, reads the words in screenshots and names what is in a picture, in any of 28 '
    + 'languages, Hindi and Japanese among them · 4.2 GB',
  words: 1,
  sent: [{ name: 'Anthropic', items: 1, hidden: 1 }],
  jobs: 1,
  streams: 1,
};

/**
 * @param {string} label
 * @param {'plain' | 'danger' | ''} [kind]
 */
const act = (label, kind = '') => button(label, kind === 'plain' ? { variant: 'plain' }
  : kind === 'danger' ? { tone: 'warning' } : {});
/**
 * @param {string} id
 * @param {string} label
 * @param {string} words
 * @param {string} [note]
 */
const menu = (id, label, words, note = '') => menuButton({ id: `gallery-set-${id}`, label, words, note,
  choices: [{ value: words, words, chosen: true, default: false }] });
/**
 * @param {boolean} on
 * @param {string} label
 */
const sw = (on, label) => toggle({ on, label });
/**
 * @param {string} label
 * @param {string} line
 * @param {SignalKind | null} [dot]
 */
const goes = (label, line, dot = null) => settingRow({ label, line, signal: dot, go: { value: '', attrs: {} } });
/**
 * @param {string} label
 * @param {string} line
 * @param {string} [end]
 * @param {Partial<Parameters<typeof settingRow>[0]>} [more]
 */
const row = (label, line, end = '', more = {}) => settingRow({ label, line, end, ...more });

/** @type {{ group: string, pages: { id: string, label: string, icon: string, dot?: boolean, body: (shown: Shown) => string[] }[] }[]} */
const PAGES = [
  { group: 'Lifestream', pages: [
    { id: 'home', label: 'General', icon: 'home', body: shown => [
      settingsSection({ rows: [
        row('Status', shown.home.words, '', { signal: shown.home.tone }),
        row('Pause Lifestream', 'Holds imports, model calls and history until you resume. New data from your devices still arrives.',
          sw(false, 'Pause Lifestream')),
        row('Activity log', 'Everything Lifestream did, line by line.', act('Open log')),
      ] }),
      settingsSection({ heading: 'Paused right now', line: 'Each pause stays until you resume it.',
        rows: shown.paused.map(pause => row(pause.title, pause.line, act('Resume', 'plain'))) }),
    ] },
    { id: 'storage', label: 'Storage', icon: 'drive', body: () => [
      storageMarkup(STORAGE_YEAR, false),
      settingsSection({ heading: 'Location', rows: [
        row('Folder', '/Volumes/External/lifestream-home', act('Show in Finder')),
        row('Space kept free', 'Under this, Lifestream keeps taking what is new; history and imports wait.', settingValue('5 GB')),
      ] })] },
    { id: 'time', label: 'Day and time', icon: 'time', body: () => [settingsSection({ rows: [
      row('Time zone', 'Days, times and the Timeline follow this zone.', settingValue('Europe/Lisbon · GMT+0')),
      row('A day starts at', 'Anything before this counts as the night before, so a late night stays one day.',
        settingValue('4:00 AM')),
    ] })] },
    { id: 'recovery', label: 'Recovery key', icon: 'private', body: () => [settingsSection({ rows: [
      row('Recovery key', 'Unlocks your saved sign-ins and keys if you move Lifestream to another Mac, or lose this one.',
        settingValue('Saved', { done: true }) + act('Make a new key')),
    ] })] },
  ] },
  { group: 'Devices', pages: [
    { id: 'mac', label: 'This Mac', icon: 'work-mac', body: () => [
      settingsSection({ rows: [
        row('Name', 'How this Mac appears in Lifestream and on your other devices.', act('Rename…')),
        row('Open at login', 'So this Mac records and syncs after a restart.', sw(true, 'Open at login')),
      ] }),
      settingsSection({ heading: 'Records', line: 'Each opens its connector.', rows: [
        goes('Screen', 'Apps and sites, and what is never recorded'),
        goes('Audio', 'Microphone and system sound during calls'),
        goes('Machine', 'Sleep, wake, displays and Bluetooth devices'),
      ] }),
      settingsSection({ heading: 'Permissions', act: act('Allow all'), rows: [
        row('Screen Recording', 'What is on your screen, every two seconds. Nothing on this Mac is recorded without it.',
          settingValue('Allowed')),
        row('Accessibility', 'Which window and page is in front, its text, and your keys and clicks.', settingValue('Allowed')),
        row('Full Disk Access', 'Your messages, notes, calls and other apps’ history on this Mac.', act('Allow')),
        row('Bluetooth', 'When Bluetooth devices connect and disconnect.', settingValue('Optional') + act('Allow')),
      ] }),
      settingsSection({ heading: 'Uninstall', rows: [
        row('Uninstall Lifestream', 'Removes the app from this Mac. Lifestream is kept unless you choose to erase it.',
          act('Uninstall…', 'danger')),
      ] }),
    ] },
    { id: 'iphone', label: 'iPhone', icon: 'phone-screen', body: shown => [
      settingsSection({ rows: shown.phones.map(phone => row(phone.name, `${phone.line} · sends ${count(phone.streams, 'stream')}`,
        (phone.pair ? act('Pair') : '') + act('Remove', 'plain'), { signal: phone.tone, lead: settingTile('phone-screen') })) }),
      settingsSection({ heading: 'Add an iPhone', rows: [
        row('Pair an iPhone', 'Shows a code the iPhone app scans. It works only while it is shown.', act('Show code')),
      ] }),
      settingsSection({ heading: 'Removed', rows: shown.removed.map(name => row(name, 'Its history stays in Lifestream.', '',
        { lead: settingTile('phone-screen') })) }),
    ] },
    { id: 'chrome', label: 'Chrome extension', icon: 'web', body: shown => [
      settingsSection({ rows: [
        row('Chrome', 'Running', '', { signal: 'engaged', lead: settingTile('web') }),
        row('Connect another browser', 'Another Chrome profile, or Chrome on another Mac.', act('Connect')),
      ] }),
      settingsSection({ heading: 'Reads in Chrome', line: 'Sites the extension reads in your own signed-in Chrome. Each opens its connector.',
        rows: shown.reads.map(each => goes(each.name, each.line, each.tone)) }),
    ] },
    { id: 'agents', label: 'Agents', icon: 'coding-agent', body: shown => [
      settingsSection({ rows: [
        row('Server URL', 'https://macbook-pro-0001.example.ts.net/mcp', act('Copy')),
      ] }),
      settingsSection({ heading: 'Connected', line: shown.agents.length === 0 ? 'No agent reaches Lifestream yet.' : '', rows: [
        ...shown.agents.map((agent, at) => row(agent.name, agent.line, menu(`agent-${at}`, 'What it hides', agent.hides)
          + act('Remove', 'plain'))),
        addRow({ placeholder: 'Name a new agent' }),
      ] }),
    ] },
  ] },
  { group: 'Models', pages: [
    { id: 'models', label: 'AI models', icon: 'ai', body: shown => [
      settingsSection({ heading: 'Subscriptions', rows: [
        row('ChatGPT', 'Use your ChatGPT plan.', settingValue('Not connected') + act('Connect')),
        row('Claude', 'Signed in · Max plan', settingValue('Connected') + act('Disconnect', 'plain')),
      ] }),
      settingsSection({ heading: 'API keys', rows: [
        row('OpenRouter', 'Pay per call with your own key.', settingValue('Not set') + act('Add key')),
        row('Custom server', 'Any server that speaks the OpenAI API, such as Ollama or LM Studio.', settingValue('Not set')
          + act('Add server')),
      ] }),
      settingsSection({ heading: `On ${shown.runner}`, rows: [
        row('Run models', 'Turn off to hold their work until you turn it back on.', sw(true, 'Run models')),
        row('Save battery', 'Runs only today\'s and yesterday\'s items on battery; the rest wait until it\'s plugged in.', sw(true, 'Save battery')),
        row('Qwen 3.5', shown.qwen, settingValue('Not downloaded') + act('Download')),
        row('Parakeet', 'Transcribes English speech · 0.7 GB', settingValue('Downloaded', { done: true }) + act('Remove', 'plain')),
        row('Nemotron Speech', 'Transcribes 28 languages, Hindi among them · 0.8 GB', settingValue('Downloading')
          + act('Cancel', 'plain'), { holds: progressLine({ label: 'Nemotron Speech downloading', share: 0.41, words: '0.3 of 0.8 GB' }) }),
      ] }),
      settingsSection({ heading: 'Defaults', line: 'What a connector uses unless you pick another in its LLM processing.', rows: [
        row('Pictures', '', menu('pictures', 'Pictures', 'Claude')),
        row('Audio', '', menu('audio', 'Audio', 'Parakeet', shown.note)),
        row('Text', '', menu('text', 'Text', 'Claude')),
      ] }),
    ] },
    { id: 'privacy', label: 'Privacy', icon: 'hidden', body: shown => [
      settingsSection({ rows: [
        row('Hide personal details', 'Before anything goes to a cloud model, names and numbers become placeholders like '
          + '[[Person 3]]. The model still reads what was said.', menu('hide', 'Hide personal details', 'With a hiding model')),
        row('Hiding model', 'Finds names Lifestream has never seen · 1.6 GB', settingValue('Downloaded', { done: true }),
          { tag: 'English first', holds: progressLine({ label: 'Checked so far', share: 0.41, words: 'Checked 41% of your record' }) }),
        row('Always hide', count(shown.words, 'word'), act('Edit')),
      ] }),
      settingsSection({ heading: 'What left Lifestream today', rows: shown.sent.map(each => row(each.name,
        `${count(each.items, 'item')} · ${count(each.hidden, 'detail')} hidden`, act('View', 'plain'))) }),
    ] },
  ] },
  { group: 'App', pages: [
    { id: 'appearance', label: 'Appearance', icon: 'settings', body: () => [settingsSection({ rows: [
      row('Theme', '', segmented({ label: 'Theme', choices: [{ value: 'system', words: 'System', chosen: false },
        { value: 'light', words: 'Light', chosen: false }, { value: 'dark', words: 'Dark', chosen: true }] })),
    ] })] },
    { id: 'updates', label: 'Updates', icon: 'update', dot: true, body: () => [settingsSection({ rows: [
      row('Version', 'Version 0.9.1 is ready.', settingValue('0.9.0') + act('Restart to Update')),
      row('Install updates automatically', 'Lifestream restarts into an update while your screen is locked.',
        sw(true, 'Install updates automatically')),
    ] })] },
    { id: 'advanced', label: 'Advanced', icon: 'filter', body: shown => [
      settingsSection({ rows: [
        row('Model calls at once', 'The most model calls Lifestream makes at the same time.', menu('calls', 'Model calls at once', '8')),
        row('Background work', 'How many jobs Lifestream runs at once.', settingValue(`Automatic · ${shown.jobs}`)),
        row('Largest upload', 'A device’s single upload above this is refused.', settingValue('64 GB')),
      ] }),
      settingsSection({ heading: 'Network', rows: [
        row('Port', 'Where apps and agents on this Mac and on Tailscale reach Lifestream.', settingValue('4680')),
        row('Local network port', 'Where your iPhone reaches Lifestream on the same Wi-Fi.', settingValue('4682')),
      ] }),
    ] },
  ] },
];

const ALL = PAGES.flatMap(group => group.pages);

/**
 * @param {typeof ALL[number]} page
 * @param {Shown} shown
 * @param {string} [id]
 */
const pageOf = (page, shown, id = page.id) => `<div class="gallery__set-page" data-set-page="${esc(id)}">`
  + `<h2 class="gallery__set-title">${esc(page.label)}</h2>${page.body(shown).join('')}</div>`;

/**
 * @param {string} id
 * @param {Shown} shown
 * @param {string} [className]
 */
const frame = (id, shown, className = '') => {
  const page = /** @type {typeof ALL[number]} */ (ALL.find(each => each.id === id));
  return `<div class="gallery__set${className ? ` ${className}` : ''}" data-set-frame="${esc(id)}">`
    + '<div class="gallery__set-bar"><span class="gallery__set-name">Settings</span>'
    + button('', { variant: 'plain', icon: 'close', attrs: { 'aria-label': 'Close' } }) + '</div>'
    + '<div class="gallery__set-body"><nav class="gallery__set-nav" aria-label="Settings">'
    + PAGES.map(group => `<div class="gallery__set-group"><p class="gallery__set-glabel">${esc(group.group)}</p>`
      + group.pages.map(each => `<span class="gallery__set-item${each.id === id ? ' is-shown' : ''}">`
        + `${icon(each.icon, { size: 'sm' })}<span>${esc(each.label)}</span>${each.dot ? '<span class="gallery__set-dot"></span>' : ''}</span>`).join('')
      + '</div>').join('')
    + `</nav><div class="gallery__set-main">${pageOf(page, shown)}</div></div></div>`;
};

/**
 * @param {Shown} shown
 * @param {string} where
 */
const parts = (shown, where) => [
  settingsSection({ heading: 'Appearance', rows: [row('Theme', '', segmented({ label: 'Theme', choices: [
    { value: 'system', words: 'System', chosen: true }, { value: 'light', words: 'Light', chosen: false },
    { value: 'dark', words: 'Dark', chosen: false }] }))] }),
  settingsSection({ line: 'Each opens its connector.', attrs: { 'data-set-part': 'line-only' }, rows: [
    row('Name', 'How this Mac appears in Lifestream and on your other devices.',
      textField({ label: 'Name', value: shown.runner }) + act('Save'), { attrs: { 'data-set-part': 'field-end' } }),
    row('Custom server', 'Any server that speaks the OpenAI API, such as Ollama or LM Studio.', act('Save'),
      { holds: textField({ label: 'Address', placeholder: 'http://127.0.0.1:11434/v1' }), attrs: { 'data-set-part': 'field-under' } }),
    settingRow({ asking: true, label: `Remove ${shown.phones[0].name}?`,
      line: 'It stops recording once it has synced what it holds. Its history stays in Lifestream.',
      end: act('Not now', 'plain') + act('Remove phone', 'danger'),
      attrs: { class: 'gallery__asked', role: 'group', 'data-set-part': 'asking' } }),
    row('Notes', 'Every note, with its folder.', sw(true, 'Notes'), { lead: appIcon('Notes'), attrs: { 'data-set-part': 'app-lead' } }),
    addRow({ placeholder: 'Add an app or site' }),
  ] }),
  settingsSection({ heading: 'Groups', about: 'Groups you are in on WhatsApp, as your phone last sent them.',
    note: 'A group you leave stays in Lifestream.', rows: [
      row('Range', 'How far back its history is read.', menuButton({ id: `gallery-set-range-${where}`, label: 'Range', words: 'A date…',
        active: 0, choices: [{ value: 'all', words: 'All of it', chosen: false, default: true }],
        date: { label: 'A date…', value: '2024-03-03', attrs: {}, said: button('Back to 3 Mar 2024', { size: 'sm' }) } }),
      { attrs: { 'data-set-part': 'menu-open' } }),
    ] }),
];

const VAULT_FACES = /** @type {const} */ ([
  { name: 'none', line: 'No vault yet', end: () => act('Create vault') },
  { name: 'creating', line: 'Creating your vault…', end: () => action('Create vault', { state: 'busy', waiting: 'Creating' }) },
  { name: 'shown', line: 'Save this key somewhere safe. It is shown only once.', holds: '<code class="gallery__key">HC7M-2Q9X-PL4K-8VRT</code>'
    + `<span data-set-part="nested-acts">${act('Save as file')}</span>`, end: () => act('Copy') },
  { name: 'kept', line: 'Saved', signal: /** @type {SignalKind} */ ('engaged'), end: () => '' },
]);

/** @param {typeof VAULT_FACES[number]} face */
const vaultRow = face => settingRow({ label: 'Recovery key', lead: settingTile('private'), line: face.line,
  signal: 'signal' in face ? face.signal : null, holds: 'holds' in face ? face.holds : '', end: face.end(),
  hold: { faces: VAULT_FACES.filter(each => each !== face).map(each => ({ line: each.line,
    signal: 'signal' in each ? each.signal : null, holds: 'holds' in each ? each.holds : '' })), end: true },
  attrs: { 'data-vault-face': face.name } });

const held = () => settingsSection({ heading: 'A row in each of its faces', line: 'Each holds the others unseen: one height, the end’s slot kept.',
  rows: VAULT_FACES.map(vaultRow) })
  + settingsSection({ heading: 'Pair an iPhone', line: 'A part that holds no rows.', attrs: { 'data-set-part': 'body', class: 'gallery__bodied' },
    body: callout({ kind: null, title: 'On your iPhone', steps: ['Open Lifestream.', 'Tap Pair with a Mac.', 'Scan the code.'] })
      + '<ol class="gallery__steps"><li>The code works only while it is shown.</li><li>Pair again from here any time.</li></ol>' });

/** @param {Shown} shown */
const body = shown => '<div class="gallery__specimen"><p class="gallery__label mac-mono-label">The frame, on Home</p>'
  + `${frame('home', shown)}</div>`
  + '<div class="gallery__specimen"><p class="gallery__label mac-mono-label">Every page</p><div class="gallery__set-pages">'
  + ALL.map(page => pageOf(page, shown)).join('')
  + (shown === WORST ? pageOf(/** @type {typeof ALL[number]} */ (ALL.find(each => each.id === 'agents')),
    { ...WORST, agents: [] }, 'agents-none') : '')
  + '</div></div>'
  + '<div class="gallery__specimen"><p class="gallery__label mac-mono-label">Parts no page above shows (the first in a dialog body’s 16 gap); a row holding its faces and a part of no rows; and in the extension’s popup, 340 wide</p>'
  + '<div class="gallery__set-pages">'
  + `<div class="gallery__set-page gallery__set-parts" data-set-page="parts">${parts(shown, 'parts').join('')}</div>`
  + `<div class="gallery__set-page gallery__set-held" data-set-page="held">${held()}</div>`
  + '<div class="gallery__set-page gallery__set-narrow" data-set-page="narrow">'
  + `${(ALL.find(each => each.id === 'models')?.body(shown) ?? []).slice(2, 3).join('')}${parts(shown, 'narrow').join('')}</div></div></div>`
  + '<div class="gallery__specimen"><p class="gallery__label mac-mono-label">At 200 % zoom: a 1440 window is 720 wide</p>'
  + `<div class="gallery__set-zoomed">${frame('mac', shown, 'gallery__set--zoomed')}${frame('models', shown, 'gallery__set--zoomed')}`
  + `${frame('agents', shown, 'gallery__set--zoomed')}</div></div>`;

export const settings = () => '<section class="gallery__group" data-gallery-settings>'
  + `<div class="gallery__set-head">${sectionLabel('Settings')}`
  + segmented({ label: 'Values', choices: [{ value: 'demo', words: 'Demo', chosen: true },
    { value: 'worst', words: 'Worst case', chosen: false }], attrs: { 'data-set-values': '' } })
  + `</div><div class="gallery__set-scene" data-set-scene="demo">${body(DEMO)}</div></section>`;

/** @param {HTMLElement} root */
export function installSettings(root) {
  const scene = root.querySelector('[data-gallery-settings]');
  scene?.addEventListener('click', event => {
    const pressed = /** @type {Element} */ (event.target).closest('[data-set-values] [data-value]');
    const into = scene.querySelector('[data-set-scene]');
    if (!(pressed instanceof HTMLElement) || !(into instanceof HTMLElement)) return;
    const worst = pressed.dataset.value === 'worst';
    for (const each of scene.querySelectorAll('[data-set-values] [data-value]')) each.setAttribute('aria-pressed', String(each === pressed));
    into.dataset.setScene = worst ? 'worst' : 'demo';
    into.innerHTML = body(worst ? WORST : DEMO);
    applyGeometry(into);
  });
}


const GB = 1e9;
const STORAGE_TODAY = '2026-10-28';
/** @param {number} back */
const daysBack = back => new Date(Date.parse(`${STORAGE_TODAY}T12:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);

/** @typedef {{ id: string, start: number, history: number, day: number }} Grows */

/** @type {Grows[]} */
const YEAR_STREAMS = [
  { id: 'screen', start: 150, history: 0, day: 0.95 }, { id: 'apple-photos', start: 148, history: 72, day: 0.16 },
  { id: 'granola', start: 120, history: 0, day: 0.34 }, { id: 'claude', start: 150, history: 9, day: 0.19 },
  { id: 'whatsapp', start: 146, history: 18, day: 0.045 }, { id: 'gmail', start: 100, history: 7, day: 0.028 },
  { id: 'chatgpt', start: 60, history: 1.2, day: 0.1 }, { id: 'google', start: 150, history: 2, day: 0.026 },
  { id: 'spotify', start: 149, history: 3, day: 0.007 }, { id: 'google-photos', start: 90, history: 2.4, day: 0.01 },
  { id: 'github', start: 30, history: 1.9, day: 0.02 }, { id: 'notes', start: 149, history: 0.6, day: 0.002 },
  { id: 'google-calendar', start: 140, history: 0.2, day: 0.001 }, { id: 'apple-health', start: 80, history: 0.2, day: 0.001 },
];
/** @type {Grows} */
const YEAR_OWN = { id: 'own', start: 150, history: 1, day: 0.2 };
/** @type {Grows[]} */
const NEW_STREAMS = [
  { id: 'screen', start: 3, history: 0, day: 1.1 }, { id: 'apple-photos', start: 3, history: 4.2, day: 0.1 },
  { id: 'whatsapp', start: 2, history: 0.6, day: 0.01 }, { id: 'notes', start: 2, history: 0.05, day: 0.001 },
];
/** @type {Grows} */
const NEW_OWN = { id: 'own', start: 3, history: 0.1, day: 0.08 };

/**
 * @param {Grows} grows
 * @param {number} days
 */
function sizesOf(grows, days) {
  let held = 0;
  return Array.from({ length: days + 1 }, (_, at) => {
    const back = days - at;
    if (back === grows.start) held += grows.history;
    if (back <= grows.start) held += grows.day * (1 + 0.6 * Math.sin((back + grows.id.length) * 2.1));
    return Math.round(held * GB);
  });
}

/** @typedef {import('./pages.js').Pages['storage']} StorageAnswer */
/** @typedef {import('./pages.js').PhrasePart} PhrasePart */

const TONES = /** @type {const} */ (['s1', 's2', 's3', 's4', 's5']);
/** @param {string} text @returns {PhrasePart} */
const said = text => ({ kind: 'words', words: text });
/** @param {string} day @returns {PhrasePart} */
const onDay = day => ({ kind: 'time', time: { kind: 'day', day } });
/** @param {string} id */
const connectorName = id => REPORT.connectors.find(each => each.id === id)?.name ?? id;
/** @param {number[]} sizes */
const last = sizes => sizes.at(-1) ?? 0;

/**
 * @param {Grows[]} streams
 * @param {Grows} own
 * @param {number} days
 * @param {number} other
 * @param {number} readings
 * @param {{ counting?: 'map' | 'counting', counted?: number }} [options]
 * @returns {StorageAnswer}
 */
function storageAnswer(streams, own, days, other, readings, { counting, counted = 1 } = {}) {
  const grown = streams.map(grows => ({ id: grows.id, bytes: sizesOf(grows, days) })).sort((a, b) => last(b.bytes) - last(a.bytes));
  const grownOwn = sizesOf(own, days);
  const wholeBytes = grown.reduce((sum, stream) => sum + last(stream.bytes), last(grownOwn));
  const scale = counting ? counted / wholeBytes : 1;
  const sized = grown.map(stream => ({ id: stream.id, bytes: stream.bytes.map(bytes => Math.round(bytes * scale)) }));
  const ownSizes = grownOwn.map(bytes => Math.round(bytes * scale));
  const week = (/** @type {number[]} */ sizes) => last(sizes) - (sizes.at(-8) ?? 0);
  const homeBytes = sized.reduce((sum, stream) => sum + last(stream.bytes), last(ownSizes));
  const total = 1000 * GB;
  const free = total - wholeBytes - other * GB;
  const used = total - free;
  const share = (/** @type {number} */ bytes) => bytes / total * 100;
  const perDay = Math.round((streams.reduce((sum, grows) => sum + grows.day, 0) + own.day) * GB);
  const ranked = sized.slice(0, 5);
  const rest = sized.slice(5);
  const restBytes = rest.reduce((sum, stream) => sum + last(stream.bytes), 0);
  const first = daysBack(days);
  const freePart = { id: '', name: 'Free', tone: /** @type {const} */ ('free'), share: share(free), size: sizeWords(free) };
  const frame = { position: '1:0', today: STORAGE_TODAY, title: 'Storage', growth: 'Growth', used: 'What uses the space', fewer: 'Show fewer',
    disk: `${sizeWords(free)} free of ${sizeWords(total)} on T9`,
    keep: { label: 'Space kept free', line: 'Under this, Lifestream keeps taking what is new; history and imports wait.', size: sizeWords(5 * GB) } };
  const left = Math.floor((free - 5 * GB) / perDay);
  const sentence = readings < 7 ? [said(`Lifestream has been measuring for ${readings} days. How fast it grows shows here after a week.`)]
    : [said(`T9 fills by about ${sizeWords(perDay)} a day. At this rate it is full around `), onDay(daysBack(-left)), said('.')];
  if (counting === 'map') {
    return { ...frame, counted: false, figure: 'Counting…', after: '', sentence, chart: null, uses: [], more: null,
      bar: { label: `T9: used ${sizeWords(used)}, counting, ${sizeWords(free)} free`, left: '',
        parts: [{ id: '', name: 'Not yet counted', tone: 'uncounted', share: share(used), size: sizeWords(used) }, freePart],
        key: [{ id: '', name: 'Not yet counted', tone: 'uncounted' }] } };
  }
  const parts = [
    ...ranked.map((stream, at) => ({ id: stream.id, name: connectorName(stream.id), tone: TONES[at], share: share(last(stream.bytes)),
      size: sizeWords(last(stream.bytes)) })),
    ...rest.length ? [{ id: 'other', name: 'Other connectors', tone: /** @type {const} */ ('other'), share: share(restBytes),
      size: sizeWords(restBytes) }] : [],
    { id: 'own', name: 'Index and AI', tone: /** @type {const} */ ('own'), share: share(last(ownSizes)), size: sizeWords(last(ownSizes)) },
  ];
  const outside = used - homeBytes;
  const elsewhere = counting ? /** @type {const} */ ('uncounted') : /** @type {const} */ ('disk');
  const whole = Math.max(1, homeBytes);
  /** @param {number[]} sizes @returns {PhrasePart[] | null} */
  const weekOf = sizes => counting ? null : week(sizes) < 1e6 ? [said('Not growing')]
    : days < 7 ? [said(`+${sizeWords(week(sizes))} since `), onDay(first)] : [said(`+${sizeWords(week(sizes))} this week`)];
  /**
   * @param {{ id: string, bytes: number[] }} stream
   * @param {import('./pages.js').StorageTone} tone
   * @param {string} part
   * @param {boolean} folded
   */
  const use = (stream, tone, part, folded) => ({ id: stream.id, part, name: connectorName(stream.id), tone, size: sizeWords(last(stream.bytes)),
    share: last(stream.bytes) / whole * 100, line: weekOf(stream.bytes), opens: stream.id, folded });
  return {
    ...frame, counted: !counting, sentence,
    figure: counting ? 'Counting…' : sizeWords(homeBytes), after: counting ? `${sizeWords(homeBytes)} so far` : 'Lifestream',
    bar: {
      label: counting ? `T9: counted so far ${sizeWords(homeBytes)}, not yet counted ${sizeWords(outside)}, ${sizeWords(free)} free`
        : `T9: Lifestream ${sizeWords(homeBytes)}, other files ${sizeWords(outside)}, ${sizeWords(free)} free`,
      parts: [...parts, { id: '', name: counting ? 'Not yet counted' : 'Other files on T9', tone: elsewhere, share: share(outside),
        size: sizeWords(outside) }, freePart],
      key: [...parts.map(({ id, name, tone }) => ({ id, name, tone })), { id: '', name: counting ? 'Not yet counted' : 'Other files', tone: elsewhere }],
      left: counting ? 'About 4 minutes left' : '',
    },
    uses: [
      ...ranked.map((stream, at) => use(stream, TONES[at], stream.id, false)),
      ...rest.map(stream => use(stream, 'other', 'other', true)),
      { id: 'own', part: 'own', name: 'Index and AI', tone: 'own', size: sizeWords(last(ownSizes)), share: last(ownSizes) / whole * 100,
        line: [said('Search, summaries and model answers')], opens: null, folded: false },
    ],
    more: rest.length ? `Show ${rest.length} more connectors` : null,
    chart: counting ? null : {
      label: [said('Lifestream’s size since '), onDay(first)], first,
      parts: [
        ...ranked.map((stream, at) => ({ id: stream.id, name: connectorName(stream.id), tone: TONES[at], bytes: stream.bytes })),
        ...rest.length ? [{ id: 'other', name: 'Other connectors', tone: /** @type {const} */ ('other'),
          bytes: ownSizes.map((_, at) => rest.reduce((sum, stream) => sum + (stream.bytes[at] ?? 0), 0)) }] : [],
        { id: 'own', name: 'Index and AI', tone: /** @type {const} */ ('own'), bytes: ownSizes },
      ],
      rate: readings < 7 ? null : perDay,
      room: { bytes: homeBytes + free - 5 * GB, name: 'T9 full' },
    },
  };
}

export const STORAGE_YEAR = storageAnswer(YEAR_STREAMS, YEAR_OWN, 150, 214, 30);
export const STORAGE_NEW = storageAnswer(NEW_STREAMS, NEW_OWN, 3, 402, 3);
export const STORAGE_COUNTING = storageAnswer(YEAR_STREAMS, YEAR_OWN, 150, 214, 30, { counting: 'counting', counted: 212 * GB });
export const STORAGE_MAP = storageAnswer(YEAR_STREAMS, YEAR_OWN, 150, 214, 30, { counting: 'map' });

/** @typedef {import('./pages.js').Pages['settingsPage']} SettingsPage */

/** @param {string} words @param {string} line @param {string} id @param {string} label @returns {import('./pages.js').SettingsRow} */
const valueRow = (words, line, id, label) => ({ id, label, line, end: { kind: 'value', value: [said(words)], signal: null } });

/** @type {SettingsPage} */
const TIME_PAGE = { position: '1:0', today: STORAGE_TODAY, id: 'time', title: 'Day and time', line: null, parts: [{ label: null, line: null, rows: [
  valueRow('Asia/Kolkata · GMT+5:30', 'Days, times and the Timeline follow this zone.', 'zone', 'Time zone'),
  { id: 'day-start', label: 'A day starts at', line: 'Anything before this counts as the night before, so a late night stays one day.',
    end: { kind: 'value', value: [{ kind: 'time', time: { kind: 'clock', at_ms: Date.parse(`${STORAGE_TODAY}T04:00:00+05:30`) } }], signal: null } },
] }] };

/** @type {SettingsPage} */
const ADVANCED_PAGE = { position: '1:0', today: STORAGE_TODAY, id: 'advanced', title: 'Advanced', line: null, parts: [
  { label: null, line: null, rows: [
    { id: 'model-cap', label: 'Model calls at once', line: 'The most model calls Lifestream makes at the same time.',
      end: { kind: 'choice', key: 'model.cap', choices: [1, 2, 4, 8, 16, 32].map(value => ({ words: String(value), value, chosen: value === 8,
        default: value === 8 })) } },
    valueRow('Automatic · 6', 'How many jobs Lifestream runs side by side, each on a thread of its own.', 'helpers', 'Background work'),
    valueRow('69 GB', 'A device’s single upload above this is refused.', 'max-bundle', 'Largest upload'),
  ] },
  { label: 'Network', line: null, rows: [
    valueRow('4680', 'Where apps and agents on this Mac and on Tailscale reach Lifestream.', 'port', 'Port'),
    valueRow('4682', 'Where your iPhone reaches Lifestream on the same Wi-Fi.', 'lan-port', 'Local network port'),
  ] },
] };

/** @type {import('./ui/connectors/settings.js').SettingsReads} */
export const SETTINGS_ANSWERS = {
  live: { position: '1:0', today: STORAGE_TODAY, you: null, devices: [], removed: '0 removed',
    values: [{ id: 'mac', label: 'Macs', value: null, signal: null }, { id: 'iphone', label: null, value: null,
      signal: REPORT.devices.some(each => each.kind === 'phone' && !each.retired && each.health.state === 'needs-you') ? 'needs-you' : null }] },
  pages: { time: { read: TIME_PAGE, drawn: null }, advanced: { read: ADVANCED_PAGE, drawn: null } },
};
