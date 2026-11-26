// @ts-check

import { addressOf, answerReplyOf, askOf, draftOf, guidesOf, madeKeyOf, NOT_SURE, signInOf, signInReadOf } from './agents.js';

/** @typedef {'engaged' | 'idle' | 'caution' | 'warning'} HostSignal */
/** @typedef {import('./reach.js').Reach} Reach */

/** @typedef {{ id: string, title: string, why: string, granted: boolean, optional: boolean, asking: boolean, denied: boolean }} HostGrant */

/**
 * @typedef {{ id: string, label: string, tone: 'caution' | 'warning' }} HostNeedAct
 * @typedef {{ id: string, line: string, detail: string | null, acts: HostNeedAct[], home: boolean }} HostNeed
 */

/**
 * @typedef {object} HostState
 * @property {{ left: number, centre: number } | null} inset
 * @property {{ signal: HostSignal, words: string } | null} recorder
 * @property {Reach | null} reach
 * @property {string | null} sending
 * @property {HostGrant[]} grants
 * @property {HostNeed[]} needs
 * @property {HostNeed | null} update
 * @property {string | null} folder
 * @property {string | null} unit
 * @property {HostSignIn[]} signins
 * @property {HostBrowser[] | null} browsers
 * @property {HostPairing | null} pairing
 * @property {{ link: string, qr: string | null } | null} phone_app
 * @property {HostAskLogin} ask_login
 * @property {HostConnectRequest[] | null} connect_requests
 * @property {import('../types.js').SignIn[]} agent_requests
 * @property {import('../types.js').AgentAsk[]} agent_asks
 * @property {{ moving: boolean, error: string | null } | null} placement
 * @property {HostMachine | null} machine
 * @property {string | null} account_name
 * @property {HostSetup | null} setup
 * @property {HostVault | null} vault
 * @property {HostApps | null} apps
 * @property {HostGeneral | null} general
 * @property {HostBackups | null} [backups]
 */

/** @typedef {{ state: 'listed' | 'none' | 'no-access', rows: HostBackup[] }} HostBackups */

/**
 * @typedef {{ store: string, why: 'unreadable' | 'too-large' | 'lost' }} HostBackupLeft
 * @typedef {{ id: string, name: string, made_ms: number, encrypted: boolean, finished: boolean, read: 'unread' | 'opening' | 'reading' | 'sending' | 'in' | 'stopped', in_ms: number | null, doing: string | null, done: number, of: number, why: 'remade' | 'room' | 'home' | null, need_bytes: number | null, left: HostBackupLeft[] }} HostBackup
 */

/** @typedef {{ login: boolean, auto_update: boolean, version: string, update: string | null, by_hand: string | null, command?: HostCommand | null }} HostGeneral */

/** @typedef {{ state: 'installed' | 'absent' | 'blocked', words: string, prompt: string }} HostCommand */

/** @typedef {{ offered: { id: string, name: string, icon: string, suggested: boolean }[], private_windows: boolean }} HostApps */

/** @typedef {{ name: string, total_bytes: number, used_bytes: number, free_bytes: number }} HostDisk */

/** @typedef {{ name: string, folder: string, free_bytes: number | null, days_of_room: number | null, home: 'new' | 'plain' | 'encrypted' | null, disk: HostDisk | null }} HostMachine */

/** @typedef {{ state: 'none' | 'unsaved' | 'saved' | 'locked' | 'lost', saved_ms: number | null, keyed?: true }} HostVault */

/** @typedef {{ number: number, made_ms: number, used: 'copied' | 'saved' | null, said: string | null }} HostSetupKey */

/** @typedef {{ state: 'idle' | 'working' | 'key' | 'login-items' | 'done' | 'failed', error: string | null, waiting: string | null, key: HostSetupKey | null }} HostSetup */

/** @typedef {{ id: string, name: string, profiles: { id: string, name: string }[] }} HostBrowser */

/** @typedef {{ link: string | null, code: string | null, qr: string | null, why: string | null, match: string, expires_ms: number }} HostPairing */

/** @typedef {{ state: 'absent' | 'fetching' | 'signed_out' | 'signing_in' | 'signed_in' | 'failed', bytes: number | null, total: number | null, attempt: string | null, url: string | null, code: string | null, account: string | null, plan: string | null, why: string | null }} HostSubscription */

/** @typedef {{ chatgpt: HostSubscription, claude: HostSubscription }} HostAskLogin */

/** @typedef {{ id: string, browser: string }} HostConnectRequest */


/** @typedef {'key' | 'device' | 'client'} HostSignIn */

/**
 * @typedef {{ 'privacy.level'?: 'all' | 'none' | null, 'privacy.chat'?: string | null, 'privacy.links'?: string | null, 'privacy.always'?: string[] | null, 'privacy.never'?: string[] | null }} PrivacyWrite
 * @typedef {{ 'search.meaning.power': 'plugged-idle' | null }} MeaningWrite
 * @typedef {import('../pages.js').ModelUseId} ModelUse
 * @typedef {{ act: 'models', do: 'default', use: ModelUse, model: string, thinking?: string }} ModelDefault
 * @typedef {{ act: 'allow', grants: string[] } | { act: 'turn', sources: string[], on: boolean } | { act: 'pause', connector: string, scope?: 'history' } | { act: 'resume', connector: string, scope?: 'history' } | { act: 'pause', target: 'home' } | { act: 'resume', target: string } | { act: 'home-setting', key: 'model.cap', value: number } | { act: 'home-setting', key: `devices.${string}.mobile_data`, value: string } | { act: 'home-setting', key: 'history.start', value: string } | { act: 'home-setting', settings: PrivacyWrite } | { act: 'home-setting', settings: MeaningWrite } | { act: 'agent-access', id: string, access: import('../types.js').DraftAccess, expect: number } | { act: 'device-name', unit: string, name: string } | { act: 'appearance', theme: 'system' | 'light' | 'dark' } | { act: 'setting', connector: string, member: string, value: unknown, was?: unknown } | { act: 'seal', connector: string, member: string, value: string } | { act: 'seal', secret: 'openrouter', value: string | null } | ModelDefault | { act: 'models', do: 'file', runner: string, id: string, to: 'fetch' | 'remove' } | { act: 'models', do: 'runner', runner: string, to: 'pause' | 'resume' } | { act: 'models', do: 'battery', runner: string, to: 'save' | 'spend' } | { act: 'models', do: 'address', url: string, input?: ['text'] | ['text', 'image'], key?: string } | { act: 'models', do: 'address', none: true } | { act: 'process', family: string, item: string, prompt: string, route: string } | { act: 'general-login', on: boolean } | { act: 'general-auto-update', on: boolean } | { act: 'general-check' } | { act: 'general-command', do: 'install' | 'remove' } | { act: 'uninstall' } | { act: 'upload', connector: string } | { act: 'choose-file', connector: string, member: string } | { act: 'choose-app' } | { act: 'faces', do: 'on' | 'off' } | { act: 'home', do: string } | { act: 'end-install', pass: string } | { act: 'retire-phone', unit: string } | { act: 'need', need: string, button: string } | { act: 'sheet', connector: string, route: string } | { act: 'refresh', connector: string } | { act: 'open', what: 'home-log' | 'storage' | 'home-folder' | 'login-items' } | { act: 'open', what: 'browser-store', browser: string } | { act: 'open', what: 'app', app: 'Tailscale' | 'Messages' } | { act: 'open', what: 'site', url: string, browser?: string } | { act: 'window', do: 'drag' | 'zoom' } | { act: 'skip', step: string } | { act: 'at', step: string } | { act: 'pairing', do: 'open' | 'close' } | { act: 'ask-login', do: 'start' | 'cancel' | 'sign_out', of: 'chatgpt' | 'claude' } | { act: 'ask-login', do: 'code', of: 'claude', attempt: string, code: string } | { act: 'connect-wait', do: 'open' | 'close' } | { act: 'connect-answer', id: string, allow: boolean } | ({ act: 'agent-answer' } & import('../types.js').AnswerRequest) | { act: 'agent-guides' } | { act: 'agent-address', on?: boolean, reader?: string } | ({ act: 'agent-key' } & import('../types.js').KeyRequest) | { act: 'agent-signin', id: string } | { act: 'agent-disconnect', id: string } | { act: 'agent-unlist', id: string } | { act: 'move-app' } | { act: 'setup-key', do: 'show' | 'copy' | 'save' | 'saved' | 'back' } | { act: 'choose-folder', start?: 'volumes' } | { act: 'choose-folder', default: true } | { act: 'setup' } | { act: 'vault', do: 'open' | 'unlock' } | { act: 'import', do: 'choose', kind: string } | { act: 'import', do: 'dropped', kind: string } | { act: 'import', do: 'again' | 'forget', kind: string, file: string } | { act: 'import', do: 'backup-read', id: string } | { act: 'import', do: 'backup-settings' } | { act: 'screenshot-take' }} HostAct
 */

/**
 * @typedef {object} Host
 * @property {HostState} state
 * @property {(listener: (state: HostState) => void) => () => void} follow
 * @property {(message: HostAct, label?: string) => Promise<HostReply>} act
 */

/** @typedef {{ notice?: string, added?: true, state?: string, revision?: number, answer?: import('../types.js').AnswerReply | import('../types.js').AccessDraft | import('../types.js').AgentGuides | import('../types.js').AgentAddress | import('../types.js').MadeKey | import('../types.js').SignInRead, key?: string, landed?: { connector: string, member: string, value: unknown }, jpeg?: Uint8Array }} HostReply */

export class Refusal extends Error {
  /** @param {string} words @param {import('./reach.js').Said} said @param {string} [code] */
  constructor(words, said, code = '') {
    super(words);
    this.said = said;
    this.code = code;
  }
}

const DOOR_ACTS = /** @type {Record<string, (value: unknown) => HostReply['answer'] | null>} */ ({
  'agent-answer': answerReplyOf, 'agent-access': draftOf, 'agent-guides': guidesOf, 'agent-address': addressOf, 'agent-key': madeKeyOf,
  'agent-signin': signInReadOf });

const DOOR_SAIDS = /** @type {Record<string, import('./reach.js').Said>} */ ({ NO_HOME: 'not-sent', OUTCOME_UNKNOWN: 'unknown' });

/**
 * @param {unknown} error
 * @returns {{ said: import('./reach.js').Said, words: string }}
 */
export const refusalOf = error => ({ said: error instanceof Refusal ? error.said : 'refused',
  words: error instanceof Error ? error.message : String(error) });

export const STATE_EVENT = 'lifestream:state';

const VERSION = 6;

/**
 * @typedef {{ lifestreamHost?: unknown, webkit?: unknown,
 *   addEventListener(type: string, listener: () => void): void,
 *   removeEventListener(type: string, listener: () => void): void }} HostWindow
 */

/** @typedef {{ webkit?: { messageHandlers?: Record<string, { postMessage(message: unknown): unknown }> } }} HostBridge */

/**
 * @param {HostWindow} win
 * @returns {Host | null}
 */
export function readHost(win) {
  if (presence(win) === null) return null;
  return {
    get state() {
      return stateOf(presence(win)?.state);
    },
    follow(listener) {
      const hear = () => listener(stateOf(presence(win)?.state));
      win.addEventListener(STATE_EVENT, hear);
      hear();
      return () => win.removeEventListener(STATE_EVENT, hear);
    },
    act: (message, label) => act(win, message, label),
  };
}

/**
 * @param {HostWindow} win
 * @returns {Record<string, unknown> | null}
 */
function presence(win) {
  let host;
  try {
    host = win.lifestreamHost;
  } catch {
    return null;
  }
  if (!host || typeof host !== 'object') return null;
  const candidate = /** @type {Record<string, unknown>} */ (host);
  return candidate.kind === 'mac' && candidate.version === VERSION ? candidate : null;
}

/**
 * @param {HostWindow} win
 * @param {HostAct} message
 * @param {string} [label]
 * @returns {Promise<HostReply>}
 */
async function act(win, message, label = '') {
  const handler = /** @type {HostBridge} */ (win).webkit?.messageHandlers?.lifestream;
  if (!handler) throw new Refusal('The Lifestream app did not answer.', 'refused');
  let value;
  try {
    value = await handler.postMessage({ type: 'act', ...message, ...(label ? { label } : {}) });
  } catch (error) {
    throw new Refusal(error instanceof Error ? error.message : String(error), 'refused');
  }
  const answer = record(value);
  const door = DOOR_ACTS[message.act];
  if (door) return doorReply(answer, door);
  if (typeof answer?.refused === 'string') {
    throw new Refusal(answer.refused, SAIDS.includes(answer.said) ? answer.said : 'refused');
  }
  const notice = answer?.notice;
  /** @type {HostReply} */
  const reply = typeof notice === 'string' && notice ? { notice } : {};
  if (answer?.added === true) reply.added = true;
  if (typeof answer?.key === 'string' && answer.key.trim()) reply.key = answer.key.trim();
  const landed = record(answer?.landed);
  if (landed && text(landed.connector) && text(landed.member) && 'value' in landed) {
    reply.landed = { connector: landed.connector, member: landed.member, value: landed.value };
  }
  if (typeof answer?.state === 'string' && Number.isSafeInteger(answer.revision)) {
    reply.state = answer.state;
    reply.revision = answer.revision;
  }
  const jpeg = typeof answer?.jpeg === 'string' ? bytesOf(answer.jpeg) : null;
  if (jpeg) reply.jpeg = jpeg;
  return reply;
}

/** @param {string} base64 */
function bytesOf(base64) {
  try {
    const binary = atob(base64);
    return binary ? Uint8Array.from(binary, char => char.charCodeAt(0)) : null;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, any> | null} reply
 * @param {(value: unknown) => HostReply['answer'] | null} check
 * @returns {HostReply}
 */
function doorReply(reply, check) {
  const refused = record(reply?.refused);
  if (refused && text(refused.code) && text(refused.message)) {
    throw new Refusal(refused.message, DOOR_SAIDS[refused.code] ?? 'refused', refused.code);
  }
  const answer = check(reply?.answer);
  if (!answer) throw new Refusal(NOT_SURE, 'unknown', 'OUTCOME_UNKNOWN');
  return { answer };
}

/** @param {unknown} value */
const text = value => typeof value === 'string' ? value : '';
/** @param {unknown} value */
const list = value => Array.isArray(value) ? value : [];
/**
 * @param {unknown} value
 * @returns {Record<string, any> | null}
 */
const record = value => value && typeof value === 'object' ? /** @type {Record<string, any>} */ (value) : null;
/** @type {readonly string[]} */
const SIGNALS = ['engaged', 'idle', 'caution', 'warning'];
/** @type {readonly unknown[]} */
const SAIDS = ['not-sent', 'refused', 'saving', 'unknown'];
/** @type {readonly unknown[]} */
const REACH_STATES = ['answering', 'waiting', 'starting', 'unreachable', 'held', 'update', 'refused', 'unpaired'];
/** @type {readonly unknown[]} */
const LINK_STATES = ['passed', 'failed', 'unchecked'];

/**
 * @param {unknown} raw
 * @returns {{ do: string, label: string } | null}
 */
const actOf = raw => {
  const each = record(raw);
  return each && text(each.do) && text(each.label) ? { do: text(each.do), label: text(each.label) } : null;
};

/**
 * @param {Record<string, any> | null} raw
 * @returns {Reach | null}
 */
const reachOf = raw => {
  if (!raw || !REACH_STATES.includes(raw.state) || !Number.isSafeInteger(raw.revision)) return null;
  /** @param {unknown} value */
  const words = value => typeof value === 'string' && value !== '' ? value : null;
  const tone = ['warning', 'caution', 'waiting', 'done'].includes(raw.tone) ? raw.tone : null;
  const title = tone ? words(raw.title) : null;
  return { state: raw.state, revision: raw.revision,
    tone: title ? tone : null, title, line: title ? words(raw.line) : null, meta: title ? words(raw.meta) : null,
    acts: title ? list(raw.acts).map(actOf).filter(each => each !== null) : [],
    last: raw.state === 'unreachable' ? words(raw.last) : null,
    path: raw.state !== 'unreachable' ? [] : list(raw.path).map(record)
      .filter(each => each !== null && text(each.id) && text(each.name) && LINK_STATES.includes(each.state) && text(each.value))
      .map(each => ({ id: text(each?.id), name: text(each?.name), state: each?.state, value: text(each?.value),
        fix: text(each?.fix) || null, act: actOf(each?.act) })),
    checking: raw.checking === true };
};
/**
 * @param {unknown} value
 * @returns {HostSignal | null}
 */
const signalOf = value => typeof value === 'string' && SIGNALS.includes(value) ? /** @type {HostSignal} */ (value)
  : null;

/** @type {readonly string[]} */
const COMMANDS = ['installed', 'absent', 'blocked'];
/**
 * @param {Record<string, any> | null} raw
 * @returns {HostCommand | null}
 */
const commandOf = raw => raw && COMMANDS.includes(raw.state) && text(raw.words) && text(raw.prompt)
  ? { state: raw.state, words: text(raw.words), prompt: text(raw.prompt) } : null;

/** @type {readonly unknown[]} */
const BACKUP_LISTS = ['listed', 'none', 'no-access'];
/** @type {readonly unknown[]} */
const BACKUP_READS = ['unread', 'opening', 'reading', 'sending', 'in', 'stopped'];
/** @type {readonly unknown[]} */
const BACKUP_WHYS = ['remade', 'room', 'home'];
/** @type {readonly unknown[]} */
const BACKUP_LEFT = ['unreadable', 'too-large', 'lost'];

/**
 * @param {Record<string, any> | null} raw
 * @returns {HostBackups | null}
 */
function backupsOf(raw) {
  if (!raw || !BACKUP_LISTS.includes(raw.state)) return null;
  /** @param {unknown} value */
  const size = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  /** @param {unknown} value @returns {HostBackup['why']} */
  const why = value => BACKUP_WHYS.includes(value) ? /** @type {HostBackup['why']} */ (value) : null;
  /** @param {unknown} value @returns {HostBackupLeft[]} */
  const left = value => list(value).map(record).flatMap(each => each && text(each.store) && BACKUP_LEFT.includes(each.why)
    ? [{ store: text(each.store), why: each.why }] : []);
  return { state: raw.state, rows: raw.state !== 'listed' ? [] : list(raw.rows).map(record).filter(each => each !== null)
    .filter(each => text(each.id) && text(each.name)).map(each => ({
      id: text(each.id), name: text(each.name), made_ms: size(each.made_ms),
      encrypted: each.encrypted === true, finished: each.finished !== false,
      read: BACKUP_READS.includes(each.read) ? each.read : 'unread',
      in_ms: typeof each.in_ms === 'number' && Number.isFinite(each.in_ms) ? each.in_ms : null,
      doing: text(each.doing) || null, done: size(each.done), of: size(each.of), why: why(each.why),
      need_bytes: size(each.need_bytes) || null, left: left(each.left) })) };
}

/** @type {readonly string[]} */
const SETUPS = ['idle', 'working', 'key', 'login-items', 'done', 'failed'];
const HOMES = ['new', 'plain', 'encrypted'];
const KEY_USES = ['copied', 'saved'];
const VAULTS = ['none', 'unsaved', 'saved', 'locked', 'lost'];
/** @type {readonly string[]} */
const SUBSCRIPTION_STATES = ['absent', 'fetching', 'signed_out', 'signing_in', 'signed_in', 'failed'];

/**
 * @param {Record<string, any> | null} raw
 * @returns {HostSubscription}
 */
export function subscriptionOf(raw) {
  const said = raw ?? {};
  /** @param {unknown} value */
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  /** @param {unknown} value */
  const words = value => typeof value === 'string' && value !== '' ? value : null;
  return { state: SUBSCRIPTION_STATES.includes(said.state) ? said.state : 'absent', bytes: number(said.bytes), total: number(said.total),
    attempt: words(said.attempt), url: words(said.url), code: words(said.code), account: words(said.account),
    plan: words(said.plan), why: words(said.why) };
}
/** @type {readonly unknown[]} */
const SIGNINS = ['key', 'device', 'client'];

/** @param {unknown} value */
const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** @param {Record<string, any> | null} disk @returns {HostDisk | null} */
const diskOf = disk => {
  const total = count(disk?.total_bytes);
  const used = count(disk?.used_bytes);
  const free = count(disk?.free_bytes);
  return disk && text(disk.name) && total !== null && used !== null && free !== null
    ? { name: text(disk.name), total_bytes: total, used_bytes: used, free_bytes: free } : null;
};

/** @param {Record<string, any> | null} key @returns {HostSetupKey | null} */
const setupKeyOf = key => key && Number.isSafeInteger(key.number) && Number.isFinite(key.made_ms)
  ? { number: key.number, made_ms: key.made_ms, used: KEY_USES.includes(key.used) ? key.used : null,
    said: text(key.said) || null } : null;

/**
 * @param {unknown} raw
 * @returns {HostState}
 */
function stateOf(raw) {
  const state = record(raw) ?? {};
  const inset = record(state.inset);
  const recorder = record(state.recorder);
  const pairing = record(state.pairing);
  const app = record(state.phone_app);
  const login = record(state.ask_login) ?? {};
  const apps = record(state.apps);
  const vault = record(state.vault);
  const placement = record(state.placement);
  const machine = record(state.machine);
  const setup = record(state.setup);
  const general = record(state.general);
  /** @param {unknown} value */
  /** @param {Record<string, any>} need */
  const needOf = need => ({
    id: text(need.id), line: text(need.line), detail: text(need.detail) || null,
    acts: list(need.acts).map(record).filter(each => each !== null).map(each => ({
      id: text(each.id), label: text(each.label), tone: /** @type {HostNeedAct['tone']} */ (each.tone === 'warning'
        ? 'warning' : 'caution'),
    })),
    home: need.home === true,
  });
  const held = record(state.update);
  const update = held ? needOf(held) : null;
  return {
    inset: inset && Number.isFinite(inset.left) && Number.isFinite(inset.centre)
      ? { left: inset.left, centre: inset.centre } : null,
    recorder: recorder ? { signal: signalOf(recorder.signal) ?? 'idle', words: text(recorder.words) } : null,
    reach: reachOf(record(state.reach)),
    sending: text(state.sending) || null,
    grants: list(state.grants).map(record).filter(grant => grant !== null).map(grant => ({
      id: text(grant.id), title: text(grant.title), why: text(grant.why),
      granted: grant.granted === true, optional: grant.optional === true,
      asking: grant.asking === true, denied: grant.denied === true && grant.asking !== true && grant.granted !== true,
    })),
    needs: list(state.needs).map(record).filter(need => need !== null).map(needOf),
    update: update?.id && update.line && update.acts.length ? update : null,
    folder: text(state.folder) || null,
    unit: typeof state.unit === 'string' ? state.unit : null,
    signins: list(state.signins).filter(each => SIGNINS.includes(each)),
    browsers: !Array.isArray(state.browsers) ? null : state.browsers.map(record).filter(browser => browser !== null).filter(browser => text(browser.id)).map(browser => ({
      id: text(browser.id), name: text(browser.name),
      profiles: list(browser.profiles).map(record).filter(profile => profile !== null)
        .filter(profile => text(profile.id))
        .map(profile => ({ id: text(profile.id), name: text(profile.name) })),
    })),
    pairing: pairing && (text(pairing.link) || text(pairing.why)) && Number.isFinite(pairing.expires_ms)
      ? { link: text(pairing.link) || null, code: text(pairing.link) && text(pairing.code) || null,
        qr: text(pairing.link) && text(pairing.qr) || null, why: text(pairing.link) ? null : text(pairing.why),
        match: text(pairing.match), expires_ms: pairing.expires_ms }
      : null,
    phone_app: app && text(app.link) ? { link: text(app.link), qr: text(app.qr) || null } : null,
    ask_login: { chatgpt: subscriptionOf(record(login.chatgpt)), claude: subscriptionOf(record(login.claude)) },
    connect_requests: Array.isArray(state.connect_requests) ? state.connect_requests.map(record)
      .filter(each => each !== null).filter(each => text(each.id))
      .map(each => ({ id: text(each.id), browser: text(each.browser) })) : null,
    agent_requests: list(state.agent_requests).map(signInOf).filter(each => each !== null),
    agent_asks: list(state.agent_asks).map(askOf).filter(each => each !== null),
    placement: placement ? { moving: placement.moving === true, error: text(placement.error) || null } : null,
    machine: machine ? { name: text(machine.name), folder: text(machine.folder), free_bytes: count(machine.free_bytes),
      days_of_room: count(machine.days_of_room), home: HOMES.includes(machine.home) ? machine.home : null,
      disk: diskOf(record(machine.disk)) } : null,
    account_name: typeof state.account_name === 'string' ? state.account_name : null,
    setup: setup ? { state: SETUPS.includes(setup.state) ? setup.state : 'idle',
      error: setup.state === 'failed' ? text(setup.error) || null : null,
      waiting: setup.state === 'working' ? text(setup.waiting) || null : null,
      key: setup.state === 'key' ? setupKeyOf(record(setup.key)) : null } : null,
    vault: vault && VAULTS.includes(text(vault.state)) ? {
      state: /** @type {HostVault['state']} */ (text(vault.state)),
      saved_ms: typeof vault.saved_ms === 'number' && Number.isFinite(vault.saved_ms) && vault.saved_ms > 0 ? vault.saved_ms : null,
      ...(vault.keyed === true ? { keyed: /** @type {const} */ (true) } : {}),
    } : null,
    apps: apps ? {
      offered: list(apps.offered).map(record).filter(app => app !== null).filter(app => text(app.id) && text(app.name))
        .map(app => ({ id: text(app.id), name: text(app.name),
          icon: /^lifestream-app:\/\/icon\/[\w.-]+$/u.test(text(app.icon)) ? text(app.icon) : '',
          suggested: app.suggested === true })),
      private_windows: apps.private_windows === true,
    } : null,
    general: general ? { login: general.login === true, auto_update: general.auto_update === true,
      version: text(general.version), update: text(general.update) || null, by_hand: text(general.by_hand) || null,
      command: commandOf(record(general.command)) } : null,
    backups: backupsOf(record(state.backups)),
  };
}
