// @ts-check
/** @import { ConnectorReport, Made, MemberState, Processing, Step, StreamsReport } from './types.js' */
/** @import { ModelConnection, ModelFile, ModelMenu, ModelRow, Models, ModelUse } from './pages.js' */
import FIXTURE_MADE from '../../homelink/Tests/Fixtures/made.json' with { type: 'json' };
import FIXTURE_MODELS from '../../homelink/Tests/Fixtures/models.json' with { type: 'json' };
import { REPORT } from './kit-gallery-report.js';

/** @param {string} value @param {string} words @param {string | null} [note] @returns {Step} */
const step = (value, words, note = null) => ({ value, words, note });

const HOME_MODELS = /** @type {{ connections: { name: string }[], models: Record<string, { id: string, name: string, line: string | null }> }} */
  (/** @type {unknown} */ (FIXTURE_MODELS));

/** @param {string} id @returns {Step} */
const stepOf = id => {
  const model = HOME_MODELS.models[id];
  return step(model.id, model.name, model.line);
};

const PRICED = stepOf('openrouter:vendor-a/vision-1');
const PLAN = stepOf('claude:plan-model-1');
const LOCAL = stepOf('runner:runner-macbook-pro-0001/qwen3.5-4b');
const PARAKEET = stepOf('runner:runner-macbook-pro-0001/parakeet-unified-en-0.6b');

const NEW = REPORT.day;
const MONTH = '2026-09-28';
const YEAR = '2025-10-28';

const ON_MAC = HOME_MODELS.connections[0].name;
const PLANNED = `${PLAN.words} · Anthropic`;
const QWEN = `${LOCAL.words} · ${ON_MAC}`;

/** @typedef {{ value: string, name: string, local: boolean }} Listed */

/** @param {Step} each @param {boolean} local @returns {Listed} */
const listed = (each, local) => ({ value: each.value, name: each.words, local });

/** @param {Listed} each @param {string | null} chosen @returns {ModelRow} */
const rowOf = (each, chosen) => ({ value: each.value, name: each.name, account: null, chosen: each.value === chosen });

/**
 * @param {ModelUse['use']} use
 * @param {string | null} work
 * @param {string | null} chosen
 * @param {Listed[]} models
 * @param {{ named?: string | null, off: string | null }} ends
 * @returns {ModelMenu}
 */
const menuOf = (use, work, chosen, models, { named, off }) => {
  const local = models.filter(each => each.local);
  return {
    default: named === undefined ? null : { value: 'default', name: `Default · ${named ?? 'None'}`, account: null, chosen: chosen === 'default' },
    rows: models.filter(each => !each.local).map(each => rowOf(each, chosen)),
    local: local.length ? { label: 'Local', rows: local.map(each => rowOf(each, chosen)) } : null,
    more: { words: 'More', use, work },
    off: off === null ? null : { value: off, name: 'Off', account: null, chosen: chosen === off },
  };
};

const LISTED = [listed(LOCAL, true), listed(PRICED, false)];

const RANGE_ROW = /** @type {const} */ ({ member: 'llm.range', shape: null, line: null, privacy: null });

/**
 * @param {string} work
 * @param {string} label
 * @param {string} about
 * @param {string} value
 * @param {string} words
 * @param {string} named
 * @param {MemberState['waiting']} [waiting]
 * @returns {MemberState}
 */
const workMember = (work, label, about, value, words, named, waiting = []) => ({ key: `llm.${work}`, kind: 'choice',
  label, about, value, words, from: value === 'default' ? 'declaration' : 'person', default: null,
  steps: null, menu: menuOf('text', `gallery/${work}`, value, LISTED, { named, off: 'off' }),
  panel: null, control: 'menu', where: null, ...waiting.length ? { waiting } : {} });

/**
 * @param {string | null} value
 * @param {string} words
 * @param {[string, string, string]} notes
 * @returns {MemberState}
 */
const rangeMember = (value, words, [month, year, all]) => ({ key: 'llm.range', kind: 'choice', label: 'Range', about: 'How far back a model reads this stream\'s items.',
  value, words, from: value === null ? 'unset' : 'person', default: null, panel: null, control: 'menu', where: null,
  steps: [step(NEW, 'New only', 'Nothing from before'), step(MONTH, 'Last 30 days', month), step(YEAR, 'Last year', year),
    step('all', 'All time', all)] });

const ABOUT = {
  libraryPhotos: 'A model writes a short description of each photo, so you can search your photos by what is in them.',
  mail: 'A model reads each email, and writes one line for each automated one: what it is and what it says.',
  aiChats: 'A model shortens very long messages in your AI chats to a line or two. Short ones are shown as written.',
};

/** @param {string} id */
const homePart = id => {
  const connector = /** @type {ConnectorReport} */ (REPORT.connectors.find(each => each.id === id));
  const processing = /** @type {Processing} */ (connector.processing);
  return { members: connector.members.filter(member => member.key.startsWith('llm.')),
    processing: { rows: [...processing.rows.filter(row => row.shape !== null), RANGE_ROW] } };
};

/** @type {Record<string, { members: MemberState[], processing: Processing }>} */
export const PARTS = {
  whatsapp: homePart('whatsapp'),
  gmail: { members: [
    workMember('mail', 'Email summaries', ABOUT.mail, 'default', QWEN, LOCAL.words),
    rangeMember(NEW, 'New only', ['1,830 emails', '21,406 emails', '64,212 emails'])],
  processing: { rows: [{ member: 'llm.mail', shape: 'done', line: 'Up to date · 5 could not be processed', privacy: null }, RANGE_ROW] } },
  chatgpt: { members: [
    workMember('chats', 'Chat summaries', ABOUT.aiChats, 'off', 'Off', LOCAL.words),
    rangeMember('all', 'All time', ['412 messages', '3,980 messages', '9,115 messages'])],
  processing: { rows: [{ member: 'llm.chats', shape: 'off', line: null, privacy: null }, RANGE_ROW] } },
  claude: { members: [
    workMember('chats', 'Chat summaries', ABOUT.aiChats, PLAN.value, PLANNED, LOCAL.words,
      [{ name: ON_MAC, kind: 'mac', line: `Waiting for ${ON_MAC} to take the change` }]),
    rangeMember(YEAR, 'Last year', ['208 messages', '2,214 messages', '2,960 messages'])],
  processing: { rows: [{ member: 'llm.chats', shape: 'waiting', line: /** @type {string} */ (PLAN.note), privacy: null }, RANGE_ROW] } },
  'apple-photos': { members: [
    workMember('photos', 'Photo descriptions', ABOUT.libraryPhotos, LOCAL.value, QWEN, PRICED.words),
    rangeMember('2026-01-01', '1 Jan 2026', ['640 photos', '7,310 photos', '31,577 photos'])],
  processing: { rows: [{ member: 'llm.photos', shape: 'done', line: 'Up to date', privacy: null }, RANGE_ROW] } },
  screen: homePart('screen'),
};

const BACKFILL_ABOUT = /** @type {Record<string, string>} */ ({
  whatsapp: 'Your chats from before Lifestream, read from your phone’s own backup.',
  'apple-photos': 'Every photo already in your library, read once, oldest last.',
});

/** @type {StreamsReport} */
export const LLM_REPORT = { ...REPORT, connectors: REPORT.connectors.map(/** @returns {ConnectorReport} */ each => ({ ...each,
  members: [...each.members.filter(member => !member.key.startsWith('llm.')), ...PARTS[each.id]?.members ?? []],
  processing: PARTS[each.id]?.processing ?? null, backfill_about: BACKFILL_ABOUT[each.id] ?? null })) };

export const SHAPED = ['whatsapp', 'gmail', 'chatgpt', 'claude', 'apple-photos', 'screen'];

export const LONGEST = 'whatsapp';

const MAC = 'runner-macbook-pro-0001';

export const SAVE_BATTERY = 'Runs only today\'s and yesterday\'s items on battery; the rest wait until it\'s plugged in.';

/**
 * @param {string} id
 * @param {string} name
 * @param {string} about
 * @param {string} size
 * @param {Partial<ModelFile>} [said]
 * @returns {ModelFile}
 */
const fileOf = (id, name, about, size, said = {}) => ({ id, name, about, size, state: 'absent', line: null, suggested: false, fits: true,
  acts: ['fetch'], ...said });

const FILES = {
  qwen: fileOf('qwen3.5-4b', 'Qwen 3.5 4B', 'Describes photos and sums up text · suggested for this Mac\'s 24 GB', '4.0 GB',
    { state: 'ready', suggested: true, acts: ['remove'] }),
  parakeet: fileOf('parakeet-unified-en-0.6b', 'Parakeet', 'Transcribes voice notes in English', '0.7 GB',
    { state: 'fetching', line: 'Downloading, 0.3 of 0.7 GB', suggested: true, acts: ['cancel'] }),
  nemotron: fileOf('nemotron-3.5-asr-0.6b', 'Nemotron Speech', 'Transcribes voice notes in English and Hindi', '0.7 GB'),
  large: fileOf('qwen3.5-35b-a3b', 'Qwen 3.5 35B-A3B', 'Describes photos and sums up text · Needs a Mac with 48 GB', '21 GB',
    { fits: false, acts: [] }),
  meaning: fileOf('embeddinggemma-2-q8-512', 'EmbeddingGemma 2', 'Search by meaning', '0.3 GB', { state: 'ready', acts: ['remove'] }),
};

/**
 * @param {string} unit
 * @param {string} name
 * @param {Partial<Extract<ModelConnection, { kind: 'runner' }>>} said
 * @returns {ModelConnection}
 */
const runnerOf = (unit, name, said) => ({ kind: 'runner', id: `runner:${unit}`, unit, place: unit === MAC ? 'On this Mac' : `On ${name}`, name,
  line: null, files: [], found: [], battery: null, paused: false, ...said });

/** @typedef {Listed & { line: string | null }} Choice */

/**
 * @param {string} value
 * @param {string} name
 * @param {string | null} [line]
 * @returns {Choice}
 */
const choiceOf = (value, name, line = null) => ({ value, name, local: value.startsWith('runner:'), line });

const CHOICES = {
  qwen: choiceOf(`runner:${MAC}/qwen3.5-4b`, 'Qwen 3.5 4B'),
  parakeet: choiceOf(`runner:${MAC}/parakeet-unified-en-0.6b`, 'Parakeet', 'Downloading, 0.3 of 0.7 GB'),
  nemotron: choiceOf(`runner:${MAC}/nemotron-3.5-asr-0.6b`, 'Nemotron Speech'),
  meaning: choiceOf(`runner:${MAC}/embeddinggemma-2-q8-512`, 'EmbeddingGemma 2'),
  hiding: choiceOf(`runner:${MAC}/privacy-filter`, 'Privacy Filter'),
  plan: choiceOf('claude:plan-model-1', 'Plan Model One'),
  planChat: choiceOf('claude:plan-chat-1', 'Plan Chat One'),
  vision: choiceOf('openrouter:vendor-a/vision-1', 'Vision One'),
  chat: choiceOf('openrouter:vendor-b/chat-1', 'Chat One'),
};

/**
 * @param {ModelUse['use']} use
 * @param {string} label
 * @param {Choice[]} choices
 * @param {string | null} value
 * @param {Partial<ModelUse>} [said]
 * @returns {ModelUse}
 */
const useOf = (use, label, choices, value, said = {}) => {
  const chosen = choices.find(choice => choice.value === value);
  const off = use === 'chat' ? null : 'none';
  return { use, label, line: chosen?.line ?? null, words: chosen?.name ?? (use === 'chat' ? 'Choose a model' : 'Off'), value, thinking: null,
    menu: menuOf(use, null, value ?? off, choices, { off }), places: [], ...said };
};

/** @type {Models} */
export const MODELS = {
  position: '1:0',
  today: NEW,
  uses: [
    useOf('pictures', 'Photos', [CHOICES.qwen, CHOICES.plan, CHOICES.vision], CHOICES.vision.value, {
      places: [{ place: 'Claude', value: CHOICES.plan.value, line: null, ready: true, leaves: true },
        { place: 'On this Mac', value: CHOICES.qwen.value, line: null, ready: true, leaves: false }] }),
    useOf('audio', 'Voice notes', [CHOICES.parakeet, CHOICES.nemotron, CHOICES.plan], null, {
      places: [{ place: 'Claude', value: CHOICES.plan.value, line: null, ready: true, leaves: true },
        { place: 'On this Mac', value: CHOICES.parakeet.value, line: CHOICES.parakeet.line, ready: false, leaves: false }] }),
    useOf('text', 'Text', [CHOICES.qwen, CHOICES.plan, CHOICES.vision], CHOICES.qwen.value),
    useOf('chat', 'Chat', [CHOICES.planChat, CHOICES.chat], CHOICES.planChat.value, {
      thinking: { value: 'medium', words: 'Medium', levels: [
        { value: 'low', name: 'Low', chosen: false, suggested: false },
        { value: 'medium', name: 'Medium', chosen: true, suggested: true },
        { value: 'high', name: 'High', chosen: false, suggested: false },
      ] } }),
    useOf('search', 'Search by meaning', [CHOICES.meaning], CHOICES.meaning.value),
    useOf('hiding', 'Hiding details', [CHOICES.hiding], null),
  ],
  connections: [
    runnerOf(MAC, ON_MAC, { files: [FILES.qwen, FILES.parakeet, FILES.nemotron, FILES.large, FILES.meaning],
      battery: { on: true, line: SAVE_BATTERY } }),
    runnerOf('runner-mac-mini-bb17', 'Mac mini', { paused: true, line: 'Paused by you · since 14:02', files: [
      { ...FILES.qwen, state: 'failed', line: 'The download stopped: this Mac has 2 GB free.', acts: ['fetch'] },
    ] }),
    runnerOf('runner-imac-cc31', 'iMac', { line: 'iMac\'s runner is not running' }),
    { kind: 'plan', id: 'claude', name: 'Claude', line: null, signed: true },
    { kind: 'plan', id: 'codex', name: 'ChatGPT', line: null, signed: false },
    { kind: 'key', id: 'openrouter', name: 'OpenRouter', line: null, held: true },
    { kind: 'address', id: 'address', url: 'http://127.0.0.1:11434/v1', line: null },
  ],
};

/**
 * @param {{ on: boolean, line: string }} battery
 * @returns {Models}
 */
const withBattery = battery => ({ ...MODELS, connections: MODELS.connections.map((each, at) => at === 0 && each.kind === 'runner'
  ? { ...each, battery } : each) });
export const ON_BATTERY = withBattery({ on: true, line: 'On battery · older items wait until it\'s plugged in' });
export const BATTERY_SPENT = withBattery({ on: false, line: SAVE_BATTERY });

/** @type {Models} */
export const MODELS_BARE = {
  position: '1:0',
  today: NEW,
  uses: [
    useOf('pictures', 'Photos', [], null),
    useOf('audio', 'Voice notes', [], null),
    useOf('text', 'Text', [CHOICES.qwen], null),
    useOf('chat', 'Chat', [], null),
    useOf('search', 'Search by meaning', [], null),
    useOf('hiding', 'Hiding details', [], null),
  ],
  connections: [
    runnerOf(MAC, ON_MAC, { files: [{ ...FILES.qwen, state: 'absent', acts: ['fetch'] }, { ...FILES.parakeet, state: 'absent', line: null,
      acts: ['fetch'] }, { ...FILES.nemotron, suggested: true }], battery: { on: true, line: SAVE_BATTERY } }),
    { kind: 'plan', id: 'claude', name: 'Claude', line: null, signed: false },
    { kind: 'plan', id: 'codex', name: 'ChatGPT', line: null, signed: false },
    { kind: 'key', id: 'openrouter', name: 'OpenRouter', line: null, held: false },
    { kind: 'address', id: 'address', url: null, line: null },
  ],
};

const ASKED = { family: 'photos', item: 'sha256:viewer-0', prompt: 'describe-photo@3' };
const HEARD = { family: 'voice', item: 'whatsapp:synthetic/msg/v1', prompt: 'transcribe-voice@2' };

const MADE = /** @type {Record<string, Made>} */ ({ ...FIXTURE_MADE, done: { ...FIXTURE_MADE.done, line: 'Vision One · 9 Nov' } });

/**
 * @param {NonNullable<Made['ask']>} ask
 * @param {Step} other
 * @returns {Record<string, Made>}
 */
const madeOf = (ask, other) => ({
  ...Object.fromEntries(Object.entries(MADE).map(([state, made]) => [state, { ...made, ask: made.ask && ask }])),
  again: { ...MADE.done, ask, choose: [other] },
});

export const DESCRIBED = madeOf(ASKED, LOCAL);

export const TRANSCRIBED = madeOf(HEARD, { ...PARAKEET, note: LOCAL.note });

/** @type {Step} */
export const RANGE_STEP = { value: '2024-03-03', words: 'Back to 3 Mar 2024', note: '12,400 photos · about $34' };

export const LONGEST_VALUE = PLANNED;

/**
 * @param {import('./lib/host.js').HostSubscription['state']} state
 * @param {Partial<import('./lib/host.js').HostSubscription>} [said]
 * @returns {import('./lib/host.js').HostSubscription}
 */
const subscription = (state, said = {}) => ({ state, bytes: null, total: null, attempt: null, url: null, code: null,
  account: null, plan: null, why: null, ...said });

export const SUBSCRIBED = /** @type {Record<string, import('./lib/host.js').HostAskLogin>} */ ({
  none: { chatgpt: subscription('absent'), claude: subscription('absent') },
  mixed: { chatgpt: subscription('fetching', { bytes: 120_000_000, total: 347_000_000 }),
    claude: subscription('signed_in', { account: 'person-a@example.com', plan: 'max' }) },
  signing: { chatgpt: subscription('signing_in', { attempt: 'login-1', code: 'QX4F-7KD2', url: 'https://auth.example.com/device' }),
    claude: subscription('signing_in', { attempt: '0f3a9c2e7b1d4a60', url: 'https://claude.example.com/oauth/authorize' }) },
  failed: { chatgpt: subscription('signed_out'), claude: subscription('failed', { why: 'Claude sign-in didn’t finish.' }) },
});
