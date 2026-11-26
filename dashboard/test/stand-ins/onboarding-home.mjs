// @ts-check
import { createServer } from 'node:http';
import { MODELS_BARE, PARTS, RANGE_STEP } from '../../public/kit-gallery-llm.js';
import { PRIVACY } from '../../public/kit-gallery-privacy.js';
import { subscriptionOf } from '../../public/lib/host.js';

const IMPORTED = /** @type {Record<string, string>} */ ({ gmail: 'google-takeout', 'apple-contacts': 'google-takeout',
  chatgpt: 'chatgpt', claude: 'claude' });

export const UNIT = 'macbook-pro-0001';
const MAC_NAME = 'MacBook Pro';

export const YOU = { name: 'Person', full_name: 'Person A Example' };

const ADDING = { blank: '___',
  prompt: 'Lifestream runs on this Mac. Run ~/.local/bin/lifestream help connectors and follow it to add a connector for ___; type each lifestream command it names as ~/.local/bin/lifestream.' };

const NINE = new Date().setHours(9, 0, 0, 0);

/** @param {number} ms */
const clock = ms => new Date(ms).toTimeString().slice(0, 5);

/**
 * @param {string} id
 * @param {string} name
 * @param {{ on?: boolean, count?: number, left?: number | null, today?: number }} [facts]
 */
const source = (id, name, { on = true, count = 0, left = null, today = 0 } = {}) => ({ id, name, on, count, left, today });
/** @typedef {ReturnType<typeof source>} Source */

/**
 * @param {number} count
 * @param {[string, string] | null} noun
 */
const heldOf = (count, noun) => `${count.toLocaleString('en-US')} ${noun?.[count === 1 ? 0 : 1] ?? 'read'}`;

/**
 * @param {import('../../public/types.d.ts').State} state
 * @param {string} words
 * @param {{ reason?: string | null, acts?: any[] }} [more]
 */
const health = (state, words, { reason = null, acts = [] } = {}) => ({ state, reason, words, since_ms: null, next_ms: null,
  acts, detail: null });

const requirement = (/** @type {string} */ kind, /** @type {boolean} */ met, /** @type {string} */ words, /** @type {any} */ act = null) =>
  ({ kind, met, words, act: met ? null : act });

const GRANT_NAMES = /** @type {Record<string, string>} */ ({ fullDiskAccess: 'Full Disk Access', screenRecording: 'Screen Recording',
  accessibility: 'Accessibility', microphone: 'the Microphone', systemAudio: 'System Audio', photos: 'Photos',
  location: 'Location', motion: 'Motion', health: 'Health', contacts: 'Contacts', notifications: 'Notifications',
  'screen-time': 'Screen Time' });

const TYPES = /** @type {Record<string, { key: string, name: string, icon: string }>} */ ({
  messages: { key: 'messages', name: 'Messages', icon: 'message' }, calls: { key: 'calls', name: 'Calls', icon: 'call' },
  notes: { key: 'notes', name: 'Notes', icon: 'note' }, voice: { key: 'voice', name: 'Voice', icon: 'voice-note' },
  calendar: { key: 'calendar', name: 'Calendar', icon: 'calendar-event' }, tasks: { key: 'tasks', name: 'Tasks', icon: 'done' },
  web: { key: 'web', name: 'Browsing', icon: 'web' }, ai: { key: 'ai', name: 'AI chats', icon: 'ai' }, mail: { key: 'mail', name: 'Mail', icon: 'mail' },
  'device-activity': { key: 'device-activity', name: 'Screen', icon: 'work-mac' },
  listening: { key: 'listening', name: 'Listening', icon: 'listening' }, photos: { key: 'photos', name: 'Photos', icon: 'photos' },
  health: { key: 'health', name: 'Health', icon: 'health' }, places: { key: 'places', name: 'Places', icon: 'places' },
  files: { key: 'files', name: 'Files', icon: 'share' }, people: { key: 'people', name: 'People', icon: 'people' },
});

const MAC = [
  ['imessage', 'iMessage', 'messages', 'Messages', ['fullDiskAccess']],
  ['whatsapp', 'WhatsApp', 'messages', 'WhatsApp', ['fullDiskAccess']],
  ['apple-calls', 'Calls', 'calls', null, ['fullDiskAccess']],
  ['apple-notes', 'Notes', 'notes', 'Notes', ['fullDiskAccess']],
  ['aqua-voice', 'Aqua Voice', 'voice', 'Aqua Voice', []],
  ['apple-calendar', 'Apple Calendar', 'calendar', 'Calendar', ['fullDiskAccess']],
  ['apple-reminders', 'Reminders', 'tasks', 'Reminders', ['fullDiskAccess']],
  ['safari', 'Safari', 'web', 'Safari', ['fullDiskAccess']],
  ['chrome', 'Chrome', 'web', 'Google Chrome', []],
  ['claude-code', 'Claude Code', 'ai', null, []],
  ['codex', 'Codex', 'ai', null, []],
  ['screen-time', 'App timeline', 'device-activity', null, ['fullDiskAccess']],
  ['now-playing', 'Now playing', 'listening', null, ['fullDiskAccess']],
  ['apple-photos', 'Photos', 'photos', 'Photos', ['photos']],
];
const SENSE_ICONS = /** @type {Record<string, string>} */ ({ input: 'input', audio: 'audio' });
const MAC_ALWAYS = ['screen-time', 'now-playing', 'apple-photos', 'screen', 'input', 'audio'];
const MAC_FOUND = ['imessage', 'whatsapp', 'apple-calls', 'apple-notes', 'apple-calendar', 'safari', 'chrome', 'claude-code',
  'codex', ...MAC_ALWAYS];

const SENSORS = [
  ['screen', 'Screen', 'What’s on your screen, as video and text, so you can find anything you saw.', ['screenRecording']],
  ['input', 'Keyboard and mouse', 'Your keys, clicks and scrolls, and which app they went to. Password fields are never '
    + 'recorded.', ['accessibility']],
  ['audio', 'Audio', 'Both sides of calls, voice notes and dictation, only while an app uses the mic.', ['microphone', 'systemAudio']],
];

/** @typedef {Record<string, Source[]>} Held */

/** @param {Record<string, any>} row */
const connector = row => ({ shown: 'stream', type: null, product: row.id, roads: [], records: `Everything ${row.name} holds.`,
  before: [], members: [], routes: [], on: true, mac: null, phone: null, site: null, sensor: false, ...row });

/** @param {Record<string, any>} member */
const member = member => ({ about: null, value: null, words: '', from: 'declaration', default: null, steps: null,
  panel: 'settings', where: null, ...member,
  control: member.steps ? 'menu' : member.kind === 'number' ? 'stepper' : member.kind });

/**
 * @param {string} name
 * @param {string} kind
 * @param {string} label
 * @param {string} key
 * @param {string} secret
 */
const account = (name, kind, label, key, secret) => [member({ key: 'account', kind, label, words: 'Not set yet',
  from: 'unset', panel: 'account' }), member({ key, kind: 'secret', label: secret, value: name, default: name, panel: 'account' })];

/** @param {unknown[]} value */
const apps = value => member({ key: 'apps', kind: 'list', label: 'Apps and sites', value, default: [], from: 'person',
  words: `${value.length} never`, items: 'modes', add: 'Add an app or site', waiting: [] });
const APPS = apps([{ app: 'com.example.passwords', mode: 'exclude' }, { app: 'com.example.vault', mode: 'exclude' },
  { app: 'com.example.not-here', mode: 'exclude' }]);

const PHONE_GRANTS = /** @type {Record<string, string[]>} */ ({ 'apple-photos': ['photos'], 'screen-time': ['screen-time'] });

const SCREENS = ['location', 'motion', 'health', 'photos', 'contacts', 'screen-time'];
/** @param {string[] | null} grants */
const screenOf = grants => {
  const at = (grants ?? []).map(grant => SCREENS.indexOf(grant)).filter(each => each >= 0);
  return at.length ? Math.min(...at) : null;
};

const GIVES = /** @type {Record<string, string>} */ ({
  imessage: 'Every message, both sides, from Messages on this Mac.',
  'apple-calls': 'Your calls: who, when and for how long.',
  whatsapp: 'Every message and call, both sides, from WhatsApp on this Mac.',
  'apple-notes': 'Every note you keep in Notes, with its attachments.',
  'apple-calendar': 'Every event in your calendars, from every account you added to Calendar.',
  safari: 'The pages you visit in Safari, and the tabs open on your other devices.',
  chrome: 'The pages you visit, what you search and what you download in Chrome.',
  'screen-time': 'Which app you were in, and when, on this Mac and your iPhone.',
  'apple-photos': 'Every photo and video in Photos on this Mac.',
});

const TAKES = /** @type {Record<string, string>} */ ({ 'llm.photos': 'pictures', 'llm.voice': 'audio' });

/** @type {Record<string, { members: any[], processing: any }>} */
const PROCESSING = Object.fromEntries(Object.entries(PARTS).map(([id, part]) => {
  const range = part.processing.rows.find(row => row.shape === null)?.member;
  return [id, {
    members: part.members.map(member => member.key === range
      ? { ...member, steps: member.steps?.map(step => ({ ...step, note: step.note?.replace(/ · about \$\d+$/u, '') ?? null })) }
      : { ...member, value: 'default', words: 'Default', from: 'declaration', waiting: undefined }),
    processing: { ...part.processing, rows: part.processing.rows.map(row => row.shape === null ? row : { ...row, shape: 'needs',
      line: `Needs a model that takes ${TAKES[row.member] === 'pictures' ? 'pictures' : TAKES[row.member] === 'audio' ? 'audio' : 'long text'}` }) },
  }];
}));

const DECLARED = [
  ...MAC.map(([id, name, type, app, grants]) => connector({ id, name, type: TYPES[/** @type {string} */ (type)],
    roads: PHONE_GRANTS[/** @type {string} */ (id)] ? ['mac', 'phone'] : ['mac'],
    records: GIVES[/** @type {string} */ (id)] ?? `Every item from ${name}.`, mac: { app, grants },
    phone: PHONE_GRANTS[/** @type {string} */ (id)] ?? null })),
  ...SENSORS.map(([id, name, records, grants]) => connector({ id, name, type: TYPES['device-activity'], roads: ['mac'],
    records, members: id === 'screen' ? [APPS] : [], mac: { app: null, grants }, sensor: true,
    ...(SENSE_ICONS[/** @type {string} */ (id)] ? { icon: SENSE_ICONS[/** @type {string} */ (id)] } : {}) })),
  connector({ id: 'upload', name: 'Files you hand in', type: TYPES.files, roads: ['upload'], shown: 'home' }),
  connector({ id: 'checkin', name: 'Check-ins', type: TYPES.notes, roads: ['phone'], shown: 'device', phone: ['notifications'] }),
  connector({ id: 'location', name: 'Location', type: TYPES.places, roads: ['phone'], shown: 'device', phone: ['location'] }),
  connector({ id: 'motion', name: 'Motion', type: TYPES.places, icon: 'walk', roads: ['phone'], shown: 'device', phone: ['motion'] }),
  connector({ id: 'apple-health', name: 'Health', type: TYPES.health, roads: ['phone', 'upload'], phone: ['health'] }),
  connector({ id: 'apple-contacts', name: 'Contacts', type: TYPES.people, roads: ['phone', 'upload'], phone: ['contacts'] }),
  connector({ id: 'chatgpt', name: 'ChatGPT', type: TYPES.ai, roads: ['chrome', 'upload'], records: 'Your ChatGPT conversations.',
    site: 'https://chatgpt.com' }),
  connector({ id: 'claude', name: 'Claude', type: TYPES.ai, roads: ['chrome', 'upload'], records: 'Your Claude conversations.',
    site: 'https://claude.ai' }),
  connector({ id: 'gmail', name: 'Gmail', type: TYPES.mail, roads: ['poll', 'upload'], records: 'Every email, sent and received.',
    members: account('gmail.password', 'email', 'Gmail address', 'password', 'App password'),
    routes: [{ id: 'gmail-imap', acquirer: 'gmail-imap', way: 'key', label: 'Use an app password', fields: ['account', 'password'],
      sets: ['account', 'password'] }] }),
  connector({ id: 'granola', name: 'Granola', type: TYPES.notes, roads: ['poll'], records: 'Every meeting and its notes.',
    members: account('granola.signin', 'email', 'Granola email', 'signin', 'Granola sign-in'),
    routes: [{ id: 'granola-mcp', acquirer: 'granola-mcp', way: 'device', label: 'Sign in with Granola', fields: [], sets: ['account', 'signin'],
      about: 'Any plan. A free plan keeps 30 days and no transcripts.' },
    { id: 'granola-api', acquirer: 'granola-api', way: 'key', label: 'Use an API key', fields: ['account', 'key'], sets: ['account', 'key'],
      about: 'On a Business plan, every meeting and its transcript.' }] }),
  connector({ id: 'whoop', name: 'WHOOP', type: TYPES.health, roads: ['chrome'], records: 'Sleep, recovery and strain.',
    members: [member({ key: 'email', kind: 'email', label: 'WHOOP email', words: 'Not set yet', from: 'unset', panel: 'account' }),
      member({ key: 'password', kind: 'secret', label: 'WHOOP password', value: 'lifestream-whoop-password',
        default: 'lifestream-whoop-password', panel: 'account' })] }),
  connector({ id: 'faces', name: 'Faces', roads: ['label'], shown: 'home' }),
];

/**
 * @typedef {object} Facts
 * @property {Held} [held]
 * @property {string[]} [skipped]
 * @property {string | null} [at]
 * @property {Record<string, any>} [rows]
 * @property {any[]} [phones]
 * @property {boolean} [extension]
 * @property {string[]} [denied]
 * @property {string[] | null} [found]
 * @property {string | null} [knock]
 */

/** @param {Facts & { stated?: Record<string, Record<string, string>>, off?: string[], you?: boolean }} facts */
function report({ held = {}, skipped = [], at = null, rows = {}, phones = [], extension = false, denied = [], stated = {},
  off = [], found = MAC_FOUND, knock = null, you = true }) {
  const paired = phones.map(phone => ({ ...phone, grants: stated[phone.unit] ?? phone.grants,
    live: phone.passes.find((/** @type {{ state: string }} */ pass) => pass.state === 'live') ?? null }));
  const live = paired.filter(phone => !phone.retired && phone.live);
  /** @type {any[]} */
  const needs = [];
  const connectors = DECLARED.map(declared => {
    const row = { ...declared, ...rows[declared.id] };
    /** @type {Source[]} */
    const sources = row.sources ?? held[row.id] ?? [];
    const set_up = row.set_up ?? sources.length > 0;
    const on = row.on && !off.includes(row.id);
    const noun = NOUNS[row.id] ?? null;
    const copies = sources.map(each => {
      const count = each.count > 0 || each.left !== null ? each.count : null;
      const kept = on && each.on && !off.includes(each.id);
      const line = !kept ? 'Off' : count ? `${heldOf(count, noun)} · last 09:00` : 'Nothing yet';
      const unit = each.id.split(':').at(-1) ?? '';
      return { id: each.id, name: each.name, road: row.roads[0], unit: /^(macbook|iphone)-/.test(unit) ? unit : null, on: kept,
        retired: false, health: health(!kept ? 'off' : (each.left ?? 0) > 0 ? 'syncing' : count === 0 ? 'quiet' : 'ok', line),
        held: count, newest_ms: count ? NINE : null, oldest_ms: null, line };
    });
    const ways = row.roads.map((/** @type {string} */ road) => {
      const requirements = requirementsOf(row, road, { set_up, live, extension, copies, found });
      return { road, ready: requirements.every(each => each.met), requirements };
    });
    const opens = row.site && row.signed_in === false ? [{ do: 'open', label: 'Open', url: row.site }] : [];
    const first = ways.flatMap((/** @type {any} */ way) => way.requirements).find((/** @type {any} */ each) => !each.met);
    const today = sources.reduce((sum, each) => sum + each.today, 0);
    const left = sources.reduce((sum, each) => sum + (each.left ?? 0), 0);
    const arriving = set_up && on && left > 0 ? ARRIVING[row.id] ?? leftWords(left, noun) : null;
    const said = row.health ?? (!on ? health('off', 'Off')
      : !set_up ? health('setup', first?.words ?? 'Not set up yet', { reason: first?.kind ?? null,
        acts: first?.act ? [first.act] : [] })
      : row.site && row.signed_in === false ? health('needs-you', `Sign in to ${row.name} in Arc`, { reason: 'signed-out',
        acts: opens })
      : row.reading || arriving ? health('syncing', 'Reading…')
      : copies.length && copies.every(each => each.health.state === 'quiet') ? health('quiet', 'Nothing yet')
      : health('ok', 'Running'));
    if (said.state === 'needs-you' || said.state === 'broken') {
      needs.push({ ...said, id: `signin:${row.id}`, connector: row.id, copy: null, unit: null, at: null });
    }
    if (set_up && on) {
      for (const phone of row.phone ? live : []) {
        const grant = row.phone.find((/** @type {string} */ each) => ['off', 'limited'].includes(phone.grants?.[each] ?? ''));
        if (grant) grantNeed(needs, row, grant, phone.unit, phone.name, phone.grants[grant] === 'limited');
      }
      const grant = row.mac?.grants.find((/** @type {string} */ each) => denied.includes(each));
      if (grant) grantNeed(needs, row, grant, UNIT, MAC_NAME, false);
    }
    return {
      id: row.id, type: row.type, icon: row.icon ?? row.type?.icon ?? 'recording', name: row.name, product: row.product, noun,
      roads: row.roads, shown: row.shown, records: row.records, gives: row.records, before: row.before, health: said,
      line: row.line ?? (!on ? 'Off' : !set_up ? said.words : arriving?.line
        ?? (today ? `${today} ${noun?.[today === 1 ? 0 : 1] ?? 'items'} today` : 'Nothing yet')),
      lead: arriving?.lead ?? null,
      figure: set_up && copies.length ? { today, week: [0, 0, 0, 0, 0, 0, today], checked_ms: NINE, words: 'Checked 09:00' } : null,
      history: arriving ? { state: 'syncing', back_to_ms: Date.UTC(2019, 2, 1), left, unit: noun, eta_ms: null,
        words: arriving.line, arriving: arriving.arriving, start: { day: null, own: false } } : null,
      copies, account: null, export: null, ways, set_up, pauses: row.pauses ?? [], on, sensor: row.sensor,
      recorder: row.id === 'screen', mac_grants: row.mac?.grants ?? [], mac_copy: row.mac ? `${row.product}:<account>:${UNIT}` : null,
      phone_screen: screenOf(row.phone), members: [...row.members, ...PROCESSING[row.id]?.members ?? []],
      routes: row.routes, route: null, processing: PROCESSING[row.id]?.processing ?? null, backfill_about: null,
      origin: row.site ?? null,
      browser: row.site && extension ? { unit: 'station-0001', name: 'Arc' } : null, signed_in: row.signed_in ?? null,
      allowed: row.site && extension ? row.allowed ?? true : null,
      checking: row.site ? row.checking ?? false : null, chrome_account: null,
      chosen: row.site && extension ? row.chosen ?? set_up : null, choosing: null, quiet: null,
    };
  });
  if (knock) needs.push({ id: `connect:${knock}`, state: 'needs-you', reason: null, words: `${knock} has been asking to connect`,
    since_ms: null, next_ms: null, acts: [{ do: 'browser', label: 'Connect', of: knock }], detail: null, connector: null, copy: null,
    unit: null, at: null });
  const streamsOf = (/** @type {string} */ unit) => connectors.filter(each => each.shown === 'stream'
    && each.copies.some((/** @type {{ unit: string | null }} */ copy) => copy.unit === unit))
    .map(each => ({ id: each.id, line: [each.lead, each.line].filter(Boolean).join(' · ') || each.health.words }));
  return {
    at_ms: Date.now(), needs, disk: { free_bytes: 412e9, max_bundle_bytes: 64 * 1024 ** 3 },
    paused: [], home: { name: 'Lifestream', health: health('ok', 'Nothing in yet') },
    devices: [
      { unit: UNIT, kind: 'mac', name: MAC_NAME, health: health('ok', 'Checked 09:00'), contact_ms: NINE,
        grants: null, found, pass: 'pass-mac', replaced: [], retired: false, streams: streamsOf(UNIT) },
      ...paired.map(phone => {
        const line = phone.live?.last_ms ? `Checked ${clock(phone.live.last_ms)}` : 'Nothing yet';
        return { unit: phone.unit, kind: 'phone', name: phone.name, health: health('ok', line),
          contact_ms: phone.live?.last_ms ?? null, grants: phone.grants, found: null, pass: phone.live?.id ?? null,
          replaced: phone.passes.filter((/** @type {{ state: string }} */ pass) => pass.state === 'replaced')
            .map((/** @type {{ id: string }} */ pass) => pass.id), retired: phone.retired, streams: streamsOf(phone.unit) };
      }),
    ],
    extension: { name: extension ? 'Arc' : 'Chrome', placed: true, present: extension, browsers: extension ? ['Arc'] : [],
      health: extension ? health('ok', 'Running in Arc')
        : health('setup', 'Not in Chrome yet', { reason: 'install', acts: [{ do: 'extension', label: 'Add to Chrome' }] }) },
    connectors, setup: { skipped, at, you }, off, imports: [], adding: ADDING,
  };
}

const ANYWHERE = new Set(['try', 'skip', 'let-go', 'import', 'copy', 'read', 'ignore']);

/**
 * @param {ReturnType<typeof report>} said
 * @param {boolean} mac
 */
function pageOf(said, mac) {
  const needs = /** @type {any[]} */ (said.needs);
  /** @param {any} each */
  const tap = each => {
    if (mac && each.set_up && each.pauses.some((/** @type {{ scope: string }} */ pause) => pause.scope === 'all')) {
      return { do: 'resume', label: each.sensor ? 'Resume reading' : 'Resume', of: each.id };
    }
    const acts = each.health.acts.filter((/** @type {{ do: string }} */ act) => mac || ANYWHERE.has(act.do));
    return each.set_up && acts.length === 1 ? acts[0] : null;
  };
  return {
    ...said,
    connectors: said.connectors.map(each => ({ ...each, callout: needs.filter(need => (need.streams ?? (need.connector === null ? [] : [need.connector]))
      .includes(each.id) && !(need.words === each.health.words && JSON.stringify(need.acts) === JSON.stringify(each.health.acts))) })),
    rows: said.connectors.filter(each => each.shown === 'stream').map(each => ({
      ids: [each.id], joined: false, name: each.name, icon: each.icon, health: { ...each.health, line: null },
      line: each.set_up ? [each.lead, each.line].filter(Boolean).join(' · ') : each.gives, time: null, more: [], last: null,
      act: tap(each), find: [...new Set([each.name, each.type?.name ?? '', each.gives].filter(Boolean))],
    })),
    badge: { needs: needs.filter(need => !need.banner).length, asks: 0 },
  };
}

/**
 * @param {Record<string, any>} row
 * @param {string} road
 * @param {{ set_up: boolean, live: any[], extension: boolean, copies: { road: string, held: number | null }[], found: string[] | null }} facts
 */
function requirementsOf(row, road, { set_up, live, extension, copies, found }) {
  switch (road) {
    case 'mac': return [
      found === null ? requirement('app', false, `Not looked for on ${MAC_NAME} yet`)
        : found.includes(row.id) ? requirement('app', true, row.mac.app ? `${row.mac.app} is on ${MAC_NAME}` : `Found on ${MAC_NAME}`)
          : requirement('app', false, row.mac.app ? `Install ${row.mac.app} on ${MAC_NAME}` : `No ${row.name} on ${MAC_NAME}`),
      ...row.mac.grants.map((/** @type {string} */ grant) => requirement('grant', false, `Allow ${GRANT_NAMES[grant]} on ${MAC_NAME}`,
        { do: 'grant', label: 'Allow', unit: UNIT, grant })),
    ];
    case 'phone': return [
      requirement('pair', live.length > 0, live.length ? `${live[0].name} is paired` : 'Pair your iPhone', { do: 'pair', label: 'Pair' }),
      ...row.phone.map((/** @type {string} */ grant) => {
        const deciding = live.filter(phone => phone.grants?.[grant] != null);
        const allowed = deciding.filter(phone => ['on', 'limited'].includes(phone.grants[grant]));
        const lacking = deciding.find(phone => !allowed.includes(phone));
        const met = allowed.length > 0 || (!lacking && copies.some(copy => copy.road === 'phone' && copy.held));
        const on = (allowed[0] ?? lacking) ? ` on ${(allowed[0] ?? lacking).name}` : '';
        return requirement('grant', met, met ? `${GRANT_NAMES[grant]} is allowed${on}` : `Allow ${GRANT_NAMES[grant]}${on}`,
          lacking ? { do: 'grant', label: 'Allow', unit: lacking.unit, grant } : null);
      }),
    ];
    case 'chrome': return [requirement('choose', set_up, set_up ? `${row.name} is on in Chrome`
      : extension ? `Turn on ${row.name} in Chrome` : 'Add the Lifestream extension to Chrome',
    extension ? { do: 'turn', label: 'Turn on', ids: [row.id] } : { do: 'extension', label: 'Add…' })];
    case 'poll': return [requirement('sign-in', set_up, set_up ? 'Signed in' : `Sign in to ${row.name}`,
      { do: 'signin', label: 'Connect', of: row.routes[0].id })];
    case 'upload': return [requirement('export', false, `Hand in your ${row.name} export`, IMPORTED[row.id]
      ? { do: 'import', label: 'Show', kind: IMPORTED[row.id] } : { do: 'upload', label: 'Upload' })];
    case 'label': return [requirement('install', set_up, set_up ? 'Installed' : `Install ${row.name}`,
      { do: 'install', label: 'Install' })];
    default: return [];
  }
}

/**
 * @param {any[]} needs
 * @param {Record<string, any>} row
 * @param {string} grant
 * @param {string} unit
 * @param {string} name
 * @param {boolean} limited
 */
const grantNeed = (needs, row, grant, unit, name, limited) => {
  const id = `grant:${grant}:${unit}`;
  const held = needs.find(need => need.id === id);
  if (held) {
    held.streams.push(row.id);
    held.connector = null;
    return;
  }
  needs.push({ id, connector: row.id, streams: [row.id], copy: null, unit,
    state: 'needs-you', reason: 'grant', since_ms: null, next_ms: null, detail: null, at: null,
    words: limited ? `${GRANT_NAMES[grant]} has limited access` : `${GRANT_NAMES[grant]} needs access`, line: name,
    acts: [{ do: 'grant', label: 'Allow', unit, grant }] });
};

/** @type {Record<string, { lead: string, line: string, arriving: string }>} */
const ARRIVING = {
  imessage: { lead: 'Back to Mar 2019', line: '12,000 messages left \u00b7 about\u00a020\u00a0min',
    arriving: 'Back to Mar 2019 \u00b7 12,000 messages left' },
  safari: { lead: 'Back to Mar 2019', line: '9,000 pages left', arriving: '9,000 pages left' },
  'apple-photos': { lead: 'Back to Jun 2016', line: '18,300 photos left \u00b7 about\u00a02\u00a0h', arriving: '18,300 photos left' },
  gmail: { lead: 'Back to Jan 2014', line: '9,800 emails left \u00b7 about\u00a01\u00a0h', arriving: '9,800 emails left' },
};

/**
 * @param {number} left
 * @param {[string, string] | null} noun
 */
const leftWords = (left, noun) => {
  const words = `${left.toLocaleString('en-US')} ${noun?.[left === 1 ? 0 : 1] ?? 'items'} left`;
  return { lead: '', line: words, arriving: words };
};

const NOUNS = /** @type {Record<string, [string, string]>} */ ({
  imessage: ['message', 'messages'], whatsapp: ['message', 'messages'], 'apple-calls': ['call', 'calls'],
  'apple-notes': ['note', 'notes'], 'apple-calendar': ['event', 'events'], 'apple-reminders': ['reminder', 'reminders'],
  safari: ['page', 'pages'], chrome: ['page', 'pages'], 'claude-code': ['message', 'messages'], codex: ['message', 'messages'],
  'apple-photos': ['photo', 'photos'], chatgpt: ['message', 'messages'], claude: ['message', 'messages'], gmail: ['email', 'emails'],
});


const FOUND = {
  imessage: [source(`imessage:person-a@example.com:${UNIT}`, 'iMessage')],
  whatsapp: [source(`whatsapp:+15550000001:${UNIT}`, 'WhatsApp')],
  'apple-calls': [source(`apple-calls:person-a@example.com:${UNIT}`, 'Calls')],
  'apple-notes': [source(`apple-notes:person-a@example.com:${UNIT}`, 'Notes')],
  'apple-calendar': [source(`apple-calendar:person-a@example.com:${UNIT}`, 'Apple Calendar')],
  safari: [source(`safari:person-a@example.com:${UNIT}`, 'Safari')],
  chrome: [source(`chrome:default:${UNIT}`, 'Default', { count: 12_400, left: 0 }),
    source(`chrome:profile-2:${UNIT}`, 'Profile 2', { count: 3_150, left: 0 })],
  'claude-code': [source(`claude-code:local:${UNIT}`, 'Claude Code', { count: 214, left: 0 })],
  codex: [source(`codex:local:${UNIT}`, 'Codex', { count: 0, left: 0 })],
  'screen-time': [source(`screen-time:person-a@example.com:${UNIT}`, 'App timeline')],
};

const COUNTING = {
  ...FOUND,
  imessage: [source(`imessage:person-a@example.com:${UNIT}`, 'iMessage',
    { count: 48_210, left: 12_000 })],
  whatsapp: [source(`whatsapp:+15550000001:${UNIT}`, 'WhatsApp', { count: 0 })],
  'apple-calls': [source(`apple-calls:person-a@example.com:${UNIT}`, 'Calls',
    { count: 1_920, left: 0 })],
  'apple-notes': [source(`apple-notes:person-a@example.com:${UNIT}`, 'Notes', { count: 0, left: 0 })],
  'apple-calendar': [source(`apple-calendar:person-a@example.com:${UNIT}`, 'Apple Calendar',
    { count: 3_480, left: 0 })],
  safari: [source(`safari:person-a@example.com:${UNIT}`, 'Safari', { count: 8_700, left: 9_000 })],
  'screen-time': [source(`screen-time:person-a@example.com:${UNIT}`, 'App timeline',
    { count: 2_140, left: 0 })],
};

const SENSING = {
  screen: [source(`screen:local:${UNIT}`, 'Screen', { count: 12, left: 0 })],
  input: [source(`input:local:${UNIT}`, 'Input', { count: 340, left: 0 })],
  audio: [source(`audio:local:${UNIT}`, 'Audio', { count: 0, left: 0 })],
};

const PHOTOS = [source(`apple-photos:person-a@example.com:${UNIT}`, 'Photos', { count: 22_700, left: 0 })];

const PHONE = { location: { set_up: true, sources: [source('location:local:iphone-aa01', 'iPhone 16 Pro', { count: 118, left: 0 })] } };
const FIRST_RUN = { location: 'asking', motion: 'not-asked', health: 'not-asked', photos: 'not-asked',
  contacts: 'not-asked', notifications: 'not-asked' };
const PHONES = [{ unit: 'iphone-aa01', model: 'iPhone 16 Pro', name: 'Person A’s iPhone', grants: FIRST_RUN,
  retired: false, passes: [{ id: 'pass-1', last_ms: Date.now(), state: 'live' }] }];
const SECOND = { unit: 'iphone-aa02', model: 'iPhone 13 mini', name: 'Work iPhone', retired: false,
  grants: { location: 'on', motion: 'on', health: 'asked', photos: 'on', contacts: 'on', notifications: 'not-asked' },
  passes: [{ id: 'pass-2', last_ms: Date.now(), state: 'live' }] };

const SCENES = {
  empty: () => ({ found: SENSORS.map(([id]) => id) }),
  found: () => ({ held: FOUND }),
  counting: () => ({ held: { ...COUNTING, ...SENSING } }),
  knocking: () => ({ held: { ...COUNTING, ...SENSING }, knock: 'Arc' }),
  phone: () => ({ held: { ...COUNTING, ...SENSING }, rows: PHONE, phones: PHONES }),
  phones: () => ({ held: { ...COUNTING, ...SENSING }, rows: PHONE, phones: [...PHONES, SECOND] }),
  'phones-again': () => ({ held: { ...COUNTING, ...SENSING }, rows: PHONE, phones: [{ ...PHONES[0],
    passes: [{ id: 'pass-1', last_ms: Date.now(), state: 'replaced' }, { id: 'pass-3', last_ms: Date.now(), state: 'live' }] },
  SECOND] }),
  'phones-by-model': () => ({ held: { ...COUNTING, ...SENSING }, rows: PHONE, phones: [
    { unit: 'iphone-aa01', model: 'iPhone 16 Pro', name: 'iPhone 16 Pro', retired: false, grants: null,
      passes: [{ id: 'pass-a', last_ms: Date.now() - 12 * 60_000, state: 'live' }] },
    { unit: 'iphone-aa02', model: 'iPhone 15', name: 'iPhone 15', retired: false, grants: null,
      passes: [{ id: 'pass-b', last_ms: null, state: 'live' }] },
  ] }),
  'claude-signed-in': () => ({ held: { ...COUNTING, ...SENSING }, rows: {
    claude: { set_up: false, signed_in: true, sources: [] } } }),
  checking: () => ({ held: { ...COUNTING, ...SENSING }, extension: true, rows: {
    claude: { set_up: false, signed_in: null, checking: true, sources: [] },
    chatgpt: { set_up: false, signed_in: null, checking: true, sources: [] } } }),
  rechecking: () => ({ held: { ...COUNTING, ...SENSING }, extension: true, rows: {
    claude: { set_up: false, signed_in: true, checking: true, sources: [] },
    chatgpt: { set_up: false, signed_in: null, checking: true, sources: [] } } }),
  checked: () => ({ held: { ...COUNTING, ...SENSING }, extension: true, rows: {
    claude: { set_up: true, signed_in: true, sources: [] },
    chatgpt: { set_up: false, signed_in: null, sources: [] } } }),
  'claude-connected': () => ({ held: { ...COUNTING, ...SENSING }, extension: true, rows: {
    claude: { set_up: true, signed_in: true, sources: [] },
    chatgpt: { set_up: false, signed_in: false, sources: [] } } }),
  'claude-paused': () => ({ held: { ...COUNTING, ...SENSING }, extension: true, rows: {
    claude: { set_up: true, signed_in: true, health: health('paused', 'Paused'), line: 'Paused until you resume it',
      sources: [] },
    chatgpt: { set_up: false, signed_in: false, sources: [] } } }),
  connected: () => ({ held: { ...COUNTING, ...SENSING }, extension: true, rows: {
    claude: { set_up: false, signed_in: true, sources: [] },
    chatgpt: { set_up: false, signed_in: false, sources: [] } } }),
  reading: () => ({ held: { ...COUNTING, ...SENSING }, extension: true, rows: {
    claude: { set_up: true, signed_in: true, sources: [] },
    chatgpt: { set_up: true, signed_in: true, reading: true, line: 'Reading… 12 messages today',
      sources: [source('chatgpt:user-synthetic0001:browser', 'Chrome', { count: 12, today: 12 })] } } }),
  'signed-in': () => ({ held: { ...COUNTING, ...SENSING }, extension: true, rows: {
    claude: { set_up: true, signed_in: true, sources: [] },
    chatgpt: { set_up: false, signed_in: true, sources: [] } } }),
  accounts: () => ({ held: { ...COUNTING, ...SENSING }, extension: true, rows: {
    gmail: { set_up: true, sources: [source('gmail:person-a@example.com:cloud', 'Gmail',
      { count: 2_100, left: 0, today: 140 })] } } }),
  photos: () => ({ held: { ...COUNTING, ...SENSING, 'apple-photos': PHOTOS } }),
  'photos-denied': () => ({ held: { ...COUNTING, ...SENSING, 'apple-photos': PHOTOS }, denied: ['photos'] }),
  'photos-empty': () => ({ held: { ...COUNTING, ...SENSING,
    'apple-photos': [source(`apple-photos:person-a@example.com:${UNIT}`, 'Photos', { left: 0 })] } }),
  'photos-faces-on': () => ({ held: { ...COUNTING, ...SENSING, 'apple-photos': PHOTOS }, rows: {
    faces: { set_up: true, health: health('syncing', 'Finding faces'), line: '4,210 of 22,700 photos',
      sources: [source(`faces:local:${UNIT}`, 'Faces', { count: 4_210 })] } } }),
  skipped: () => ({ held: { ...COUNTING, ...SENSING }, skipped: ['iphone', 'browser'] }),
  resumed: () => ({ held: { ...COUNTING, ...SENSING }, skipped: ['iphone'], at: 'browser' }),
  settled: () => ({ held: { ...settledOf(COUNTING), ...SENSING } }),
  'paused-whole': () => ({ held: { ...COUNTING, ...SENSING }, rows: { safari: { pauses: [WHOLE] } } }),
  'paused-all': () => ({ held: { ...COUNTING, ...SENSING }, rows: { safari: { pauses: [WHOLE] }, imessage: { pauses: [WHOLE] } } }),
  many: () => ({ held: { ...manyOf(COUNTING), ...SENSING, 'apple-photos': [source(`apple-photos:person-a@example.com:${UNIT}`,
    'Photos', { count: 4_400, left: 18_300 })] }, rows: {
    gmail: { set_up: true, sources: [source('gmail:person-a@example.com:cloud', 'Gmail', { count: 2_100, left: 9_800, today: 140 })] },
    'apple-reminders': { set_up: true, pauses: [{ scope: 'history', by: 'person', reason: '', at_ms: NINE }],
      sources: [source(`apple-reminders:person-a@example.com:${UNIT}`, 'Reminders', { count: 12, left: 200 })] } } }),
};

const WHOLE = { scope: 'all', by: 'person', reason: '', at_ms: NINE };

/**
 * @param {Held} held
 * @returns {Held}
 */
const settledOf = held => Object.fromEntries(Object.entries(held).map(([id, sources]) => [id,
  sources.map(each => ({ ...each, left: each.left === null ? null : 0 }))]));

/**
 * @param {Held} held
 * @returns {Held}
 */
const manyOf = held => Object.fromEntries(Object.entries(held).map(([id, sources]) => [id,
  sources.map(each => ({ ...each, count: each.count || 1_000, left: each.left || 2_500 }))]));

/** @typedef {keyof typeof SCENES} Scene */

const KEEPALIVE_MS = 15_000;

/** @param {{ door: { url: string, token: string }, day: string }} options */
export async function onboardingHome({ door, day }) {
  /** @type {Scene} */
  let scene = 'empty';
  /** @type {string[]} */
  let off = [];
  /** @type {unknown[] | null} */
  let modes = null;
  let up = true;
  /** @type {import('../../public/lib/model-menu.js').Models | null} */
  let models = MODELS_BARE;
  let modelsRead = 0;
  /** @type {import('../../public/types.js').PrivacyRead} */
  let privacy = PRIVACY.fresh;
  let placeless = false;
  /** @type {string[] | null | undefined} */
  let stated;
  /** @type {{ skipped?: string[], at?: string | null }} */
  let kept = {};
  /** @type {{ name: string, full_name: string | null } | null} */
  let you = YOU;
  /** @type {Record<string, unknown>[]} */
  const peopleActs = [];
  let refuseYou = '';
  let heldYou = false;
  let lostYou = 0;
  /** @type {Map<unknown, unknown>} */
  const landed = new Map();
  /** @type {Set<(value?: unknown) => void>} */
  const youHeld = new Set();
  let heldReports = false;
  /** @type {Set<(value?: unknown) => void>} */
  const held = new Set();
  /** @type {(string | null)[]} */
  const units = [];
  /** @type {Record<string, Record<string, string>>} */
  const grants = {};
  /** @type {Set<import('node:http').ServerResponse>} */
  const feeds = new Set();
  let seq = 0;
  /** @param {Record<string, unknown>} event */
  const tell = event => {
    seq += 1;
    const told = { seq, at_ms: Date.now(), ...event };
    for (const feed of feeds) feed.write(`id: scene-${seq}\ndata: ${JSON.stringify(told)}\n\n`);
  };
  /** @param {string} key */
  const changed = key => tell({ kind: 'import', key: `${key}/d${seq + 1}` });
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '', 'http://door').pathname;
    /** @param {number} status @param {unknown} body */
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (path === '/v1/feed') {
      feeds.add(response);
      const keepalive = setInterval(() => response.write(':\n\n'), KEEPALIVE_MS);
      response.on('close', () => {
        feeds.delete(response);
        clearInterval(keepalive);
      });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('retry: 1000\n\n');
      return;
    }
    if (path === '/v1/connectors') {
      const unit = new URL(request.url ?? '', 'http://door').searchParams.get('unit');
      units.push(unit);
      if (!up) return send(503, { error: 'Lifestream is starting.' });
      if (heldReports) await new Promise(answer => { held.add(answer); });
      const facts = { ...SCENES[scene](), ...kept };
      const said = pageOf(report({ ...facts, stated: grants, off, found: stated === undefined ? facts.found : stated, you: you !== null }), unit !== null);
      return send(200, { ...said, day, connectors: said.connectors.map(row => row.id === 'screen' && modes
        ? { ...row, members: row.members.map((/** @type {{ key: string }} */ each) => each.key === 'apps' ? apps(modes) : each) }
        : row) });
    }
    if (path === '/v1/places' && placeless) return send(200, { places: [], spots: [] });
    if (path === '/v1/page/places' && placeless) {
      const passed = await fetch(`${door.url}${request.url ?? ''}`, { headers: { authorization: `Bearer ${door.token}` } });
      if (!passed.ok) return send(passed.status, await passed.json());
      return send(200, { ...await passed.json(), here: null, frame: null, cities: [], to_name: [], hidden: [] });
    }
    if (path === '/v1/owner/act' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const action = JSON.parse(body);
      peopleActs.push(action);
      if (action.of !== 'people' || action.kind !== 'you') return send(400, { error: 'BAD_ACTION', message: 'Not an action of this home.' });
      const name = typeof action.name === 'string' ? action.name.replace(/\s+/gu, ' ').trim() : '';
      if (!name) return send(400, { error: 'BAD_ACTION', message: 'Say what Lifestream should call you.' });
      let answer = landed.get(action.request);
      if (answer === undefined) {
        if (refuseYou) {
          const words = refuseYou;
          refuseYou = '';
          return send(409, { error: 'REFUSED', message: words });
        }
        you = { name, full_name: typeof action.full_name === 'string' ? action.full_name : null };
        tell({ kind: 'people', key: 'people' });
        changed('you');
        answer = { act: `act-${peopleActs.length}`, id: 'person:you', position: `p${seq}` };
        landed.set(action.request, answer);
      }
      if (heldYou) await new Promise(answer => { youHeld.add(answer); });
      if (lostYou > 0) {
        lostYou -= 1;
        return send(503, { code: 'OUTCOME_UNKNOWN', message: 'Lifestream didn\'t answer.', again: true, began: false });
      }
      return send(200, answer);
    }
    if (path === '/v1/page/models/defaults' || path === '/v1/page/models/providers') {
      modelsRead += 1;
      return models ? send(200, models) : send(503, { error: 'NOT_NOW', message: 'Lifestream is busy.' });
    }
    if (path === '/v1/privacy') return send(200, privacy);
    if (path === '/v1/processing/range') return send(200, { ...RANGE_STEP, note: '12,400 photos' });
    try {
      const passed = await fetch(`${door.url}${request.url ?? ''}`, {
        method: request.method, headers: { authorization: `Bearer ${door.token}` },
      });
      response.writeHead(passed.status, { 'content-type': passed.headers.get('content-type') ?? 'application/json' });
      response.end(Buffer.from(await passed.arrayBuffer()));
    } catch {
      response.destroy();
    }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  return {
    url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`,
    units,
    peopleActs,
    /** @param {{ name: string, full_name: string | null } | null} next */
    you(next) {
      you = next;
      tell({ kind: 'people', key: 'people' });
    },
    get youNow() {
      return you;
    },
    /** @param {number} count */
    loseYou(count) {
      lostYou = count;
    },
    /** @param {string} words */
    refuseYou(words) {
      refuseYou = words;
    },
    /** @param {boolean} now */
    holdYou(now) {
      heldYou = now;
      if (now) return;
      for (const answer of youHeld) answer();
      youHeld.clear();
    },
    /** @param {boolean} now */
    holdReports(now) {
      heldReports = now;
      if (now) return;
      for (const answer of held) answer();
      held.clear();
    },
    /** @param {Scene} next */
    quietly(next) {
      scene = next;
    },
    /** @param {Scene} next */
    scene(next) {
      if (next === scene) return;
      scene = next;
      changed(`scene:${next}`);
    },
    /** @param {Scene} next */
    paired(next) {
      scene = next;
      tell({ kind: 'device-add', key: 'iphone-0042', detail: { model: 'iPhone 16 Pro' } });
      tell({ kind: 'source-add', key: 'location:iphone-0042', detail: { connector: 'location' } });
    },
    /**
     * @param {Scene} next
     * @param {Record<string, boolean | null>} detail
     */
    sites(next, detail) {
      scene = next;
      tell({ kind: 'sites', key: 'station-0001', detail: { signed_in: detail } });
    },
    /** @param {string} acquirer */
    poll(acquirer) {
      tell({ kind: 'poll', key: acquirer, detail: { error: false } });
    },
    /** @param {boolean} now */
    placeless(now) {
      if (now === placeless) return;
      placeless = now;
      tell({ kind: 'places', key: 'places', detail: { position: `places-${seq + 1}` } });
    },
    /**
     * @param {string} unit
     * @param {Record<string, string>} stated
     */
    stated(unit, stated) {
      grants[unit] = stated;
      tell({ kind: 'stated', key: unit });
    },
    /** @param {string[] | null | undefined} found */
    found(found) {
      stated = found;
      changed('found');
    },
    /** @param {{ skipped?: string[], at?: string | null }} setup */
    held(setup) {
      kept = setup;
    },
    /** @param {import('../../public/lib/model-menu.js').Models | null} next */
    modelsMoved(next) {
      models = next;
      tell({ kind: 'models', key: 'models' });
    },
    modelsRead: () => modelsRead,
    /** @param {import('../../public/types.js').PrivacyRead} next */
    privacyMoved(next) {
      privacy = next;
      tell({ kind: 'models', key: 'models' });
    },
    /** @param {boolean} now */
    answers(now) {
      up = now;
    },
    reset() {
      this.holdReports(false);
      this.holdYou(false);
      this.you(YOU);
      refuseYou = '';
      lostYou = 0;
      landed.clear();
      peopleActs.length = 0;
      scene = 'empty';
      off = [];
      modes = null;
      up = true;
      models = MODELS_BARE;
      modelsRead = 0;
      privacy = PRIVACY.fresh;
      placeless = false;
      stated = undefined;
      kept = {};
      units.length = 0;
      for (const unit of Object.keys(grants)) delete grants[unit];
    },
    /** @param {string[]} ids */
    turnOff(ids) {
      off = ids;
      changed('off');
    },
    /** @param {unknown[]} items */
    modes(items) {
      modes = items;
      changed('modes');
    },
    async close() {
      for (const feed of feeds) feed.end();
      server.closeAllConnections();
      await new Promise(done => server.close(() => done(undefined)));
    },
  };
}


/**
 * @param {string} id
 * @param {string} title
 * @param {boolean} granted
 * @param {boolean} asking
 * @param {boolean} denied
 */
const grant = (id, title, granted, asking, denied) => ({ id, title, why: '', granted,
  optional: id === 'bluetooth', asking, denied });
const GRANTS = [['fullDiskAccess', 'Full Disk Access'], ['screenRecording', 'Screen Recording'],
  ['accessibility', 'Accessibility'], ['microphone', 'Microphone'],
  ['systemAudio', 'System Audio Recording'], ['bluetooth', 'Bluetooth'], ['photos', 'Photos']];

/**
 * @param {'absent' | 'fetching' | 'signed_out' | 'signing_in' | 'signed_in' | 'failed'} state
 * @param {Record<string, unknown>} [said]
 */
export const subscription = (state, said = {}) => subscriptionOf({ state, ...said });

/** @param {{ chatgpt?: object, claude?: object }} [said] */
export const askLogin = (said = {}) => ({ chatgpt: subscription('absent'), claude: subscription('absent'), ...said });

export const CHATGPT_SIGNED_IN = askLogin({ chatgpt: subscription('signed_in', { account: 'person-a@example.com', plan: 'plus' }) });

export const CHATGPT_CODE = askLogin({ chatgpt: subscription('signing_in', { attempt: 'login-1', code: 'QX4F-7KD2',
  url: 'https://auth.example.com/device' }) });

/** @param {{ granted?: string[], asking?: string[], denied?: string[], more?: Record<string, unknown> }} [options] */
export function hostState({ granted = [], asking = [], denied = [], more = {} } = {}) {
  return {
    inset: { left: 78, centre: 26 }, recorder: { signal: 'engaged', words: 'Recording' },
    reach: { state: 'answering', revision: 1, tone: null, title: null, line: null, meta: null, acts: [] }, sending: null,
    grants: GRANTS.map(([id, title]) => grant(id, title, granted.includes(id), asking.includes(id), denied.includes(id))),
    needs: [],
    folder: '/Users/person-a/Lifestream', unit: UNIT,
    browsers: [{ id: 'chrome', name: 'Chrome', profiles: [{ id: 'default', name: 'Person A' },
      { id: 'profile-2', name: 'Work' }] }, { id: 'arc', name: 'Arc', profiles: [{ id: 'default', name: 'Person A' }] }],
    pairing: null,
    ask_login: askLogin(),
    connect_requests: null,
    placement: null,
    machine: { name: MAC_NAME, folder: '~/Lifestream', free_bytes: 412e9, days_of_room: 410, home: 'new',
      disk: { name: 'Macintosh HD', total_bytes: 994e9, used_bytes: 582e9, free_bytes: 412e9 } },
    account_name: 'Person A Example',
    setup: { state: 'idle' },
    signins: ['key', 'device'],
    apps: { offered: [{ id: 'com.example.passwords', name: 'Passwords', icon: 'lifestream-app://icon/com.example.passwords',
      suggested: true }, { id: 'com.example.vault', name: 'Vault', icon: '', suggested: true },
    { id: 'com.example.bank', name: 'Bank', icon: '', suggested: true },
    { id: 'com.example.notes', name: 'Notes', icon: '', suggested: false }],
    private_windows: true },
    ...more,
  };
}

export const PAIR_QR = 'data:image/png;base64,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';

export const PHONE_APP = 'https://testflight.apple.com/join/wA1AwVHv';
export const PHONE_APP_QR = 'data:image/png;base64,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';
export const NO_WIFI = 'Lifestream can’t open its Wi-Fi connection. Quit what uses port 4682, or restart Lifestream.';

export const SENSES = ['screenRecording', 'accessibility', 'microphone', 'systemAudio'];

/** @param {unknown} state */
export const hostScript = state => `(() => {
  window.hostActs = [];
  window.hostAts = [];
  window.hostThemes = [];
  window.hostReplies = {};
  window.hostHolds = {};
  window.hostAnswers = {};
  let whole = ${JSON.stringify(state)};
  let pairing = false;
  const stated = () => pairing ? whole : { ...whole, pairing: null, phone_app: null };
  window.lifestreamHost = { kind: 'mac', version: 6, state: stated() };
  const tell = () => {
    window.lifestreamHost.state = stated();
    window.dispatchEvent(new Event('lifestream:state'));
  };
  window.webkit = { messageHandlers: { lifestream: { postMessage: message => {
    (message.act === 'at' ? window.hostAts : message.act === 'appearance' ? window.hostThemes : window.hostActs).push(message);
    // The pairing held or let go, whatever the app answers: it states its codes, or drops them, in its next state.
    if (message.act === 'pairing') {
      pairing = message.do === 'open';
      setTimeout(tell);
    }
    const reply = window.hostReplies[message.act];
    if (reply) return Promise.reject(new Error(reply));
    // An act held is answered once the test lets it go (\`hostRelease\`), as the app answers once the home took it.
    const answer = window.hostAnswers[message.act]
      ?? (message.act === 'setting' ? { landed: { connector: message.connector, member: message.member, value: message.value } } : {});
    return window.hostHolds[message.act] ? new Promise(done => { window.hostRelease = () => done(answer); }) : Promise.resolve(answer);
  } } } };
  window.setHostState = state => {
    whole = state;
    tell();
  };
})();`;
