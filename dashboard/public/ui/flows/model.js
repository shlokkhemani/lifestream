// @ts-check
/** @import { HostAct, HostState } from '../../lib/host.js' */
/** @import { ConnectorReport, StreamsReport } from '../../types.js' */
import { subscriptionOf } from '../../lib/host.js';
import { clock } from '../../lib/words.js';
import { chromeBrings, extensionOn, formDo, formOf, routeAct, routesOf, signInOf } from '../connectors/page.js';

/** @typedef {{ state: HostState | null, report: StreamsReport | null, models?: import('../../lib/model-menu.js').Models | null, privacy?: import('../../types.js').PrivacyRead | null, screen?: import('../connectors/settings-search.js').ScreenState | null }} Seen */

/** @typedef {'vault' | 'model' | 'phone' | 'browser'} FlowId */

/**
 * @typedef {object} FlowSession
 * @property {boolean} hosted
 * @property {'step' | 'dialog'} frame
 * @property {Set<string>} busy
 * @property {{ key: string, words: string } | null} failure
 * @property {string} chosen
 * @property {Set<string>} closed
 * @property {string} code
 * @property {ModelItem[]} models
 * @property {{ attempt: string, until: number }} signing
 * @property {Set<string> | null} another
 * @property {'' | 'app' | 'pair'} part
 * @property {Set<string>} connected
 * @property {Set<string> | null} before
 * @property {{ at: number, since: number | null, browser: string } | null} knock
 * @property {string} then
 * @property {Set<string>} opened
 */

export const KNOCK_MS = 30_000;
export const ELSEWHERE = 'In the Lifestream app on your Mac.';
const CHECKING = 'Checking';
const SIGN_IN_THERE = 'Sign in there, then come back.';

/**
 * @param {boolean} hosted
 * @param {'step' | 'dialog'} frame
 * @returns {FlowSession}
 */
export const sessionOf = (hosted, frame) => ({ hosted, frame, busy: new Set(), failure: null, chosen: '',
  closed: new Set(), code: '', models: [...MODEL_ITEMS], signing: { attempt: '', until: 0 }, another: null, part: '', connected: new Set(), before: null,
  knock: null, then: '', opened: new Set() });


/** @param {Seen} seen */
export const accountsIn = seen => (seen.report?.connectors ?? []).filter(connector => connector.shown === 'stream'
  && (signInOf(connector, seen.state) !== null || formDo(connector, seen.state) !== null));
/** @param {Seen} seen */
export const accountSet = seen => accountsIn(seen).some(connector => connector.set_up);
export { extensionOn };

const ON_THE_PHONE = 'Allow on your iPhone';

/** @typedef {{ id: string, icon: string, name: string, about: string, mark: 'done' | 'working' | 'wanted', word: string, line: string }} MarkedStream */

/** @param {Seen} seen */
export function phoneOf(seen) {
  const phones = (seen.report?.devices ?? []).filter(device => device.kind === 'phone' && !device.retired);
  const needs = seen.report?.needs ?? [];
  const ways = (seen.report?.connectors ?? []).filter(connector => connector.phone_screen !== null)
    .sort((one, other) => /** @type {number} */ (one.phone_screen) - /** @type {number} */ (other.phone_screen))
    .flatMap(connector => connector.ways.filter(way => way.road === 'phone').map(way => ({ connector, way })));
  return { paired: phones.some(phone => phone.pass !== null), phones: phones.map(phone => ({ ...phone, streams: ways.map(({ connector, way }) => {
    const need = needs.find(each => each.connector === connector.id && each.unit === phone.unit);
    const unmet = way.requirements.find(requirement => !requirement.met);
    const mine = !unmet ? '' : unmet.act?.do !== 'grant' ? unmet.words : unmet.act.unit === phone.unit ? ON_THE_PHONE : '';
    const said = need ? need.reason === 'grant' ? ON_THE_PHONE : need.words : way.ready ? '' : mine;
    return /** @type {MarkedStream} */ ({ id: connector.id, icon: connector.icon, name: connector.name,
      about: connector.gives, mark: need || !way.ready ? 'wanted' : 'done', word: '', line: said });
  }) })) };
}

/**
 * @param {Seen} seen
 * @param {{ another: Set<string> | null }} session
 */
const codesShown = (seen, { another }) => !phoneOf(seen).paired || another !== null;

/** @param {Seen} seen */
function pairingOf(seen) {
  const pairing = seen.state?.pairing ?? null;
  if (!pairing) return null;
  const code = pairing.code ?? '';
  return { qr: pairing.qr, why: pairing.why, typed: code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code,
    match: pairing.match };
}

/** @param {Seen} seen */
const phoneAppOf = seen => phoneOf(seen).paired ? null : seen.state?.phone_app?.qr ?? null;

/** @typedef {'before' | 'checking' | 'out' | 'withheld' | 'unsure' | 'in' | 'connected'} SiteState */

/**
 * @param {Seen} seen
 * @param {ReadonlySet<string>} [connected]
 */
export function browserSites(seen, connected = new Set()) {
  const on = extensionOn(seen.report);
  return (seen.report?.connectors ?? []).filter(connector => connector.roads.includes('chrome') && !formOf(connector).length).map(connector => {
    const chosen = connector.chosen === true || connected.has(connector.id);
    /** @type {SiteState} */
    const state = !on ? 'before' : connector.signed_in === null && connector.checking === true ? 'checking'
      : connector.signed_in === false ? 'out' : chosen ? 'connected' : connector.signed_in === true ? 'in'
        : connector.allowed === false ? 'withheld' : 'unsure';
    const browser = connector.browser?.name ?? '';
    const station = seen.state?.browsers?.find(each => each.name === browser) ?? null;
    const turn = connector.ways.find(way => way.road === 'chrome')?.requirements.find(each => each.act?.do === 'turn')?.act;
    const well = connector.chosen !== true || connector.health.state === 'ok' || connector.health.state === 'syncing';
    const copies = connector.copies.filter(copy => copy.on && copy.road === 'chrome' && (copy.held ?? 0) > 0);
    const counted = state === 'connected' && well && copies.length > 0;
    const arriving = `Reading your ${connector.noun?.[1] ?? 'items'}`;
    const signed = connector.chrome_account;
    const account = signed == null ? '' : 'email' in signed ? signed.email : signed.name;
    return { id: connector.id, name: connector.name, icon: connector.icon, words: connector.gives, state, account,
      line: state !== 'connected' || !well ? connector.line : counted ? copies.map(copy => copy.line).join(' · ') : arriving,
      measured: counted, href: connector.origin ?? '', browser, station, chosen,
      connect: turn?.do === 'turn' ? /** @type {HostAct} */ ({ act: 'turn', sources: turn.ids, on: true }) : null };
  });
}

/**
 * @param {Seen} seen
 * @param {{ chosen: string, closed: Set<string>, connected?: ReadonlySet<string> }} session
 */
export function browserOf(seen, { chosen, closed, connected: pressed }) {
  const browsers = seen.state?.browsers ?? [];
  const connected = extensionOn(seen.report);
  const present = seen.report?.extension.browsers ?? [];
  const browser = connected ? browsers.find(each => present.includes(each.name)) ?? null
    : browsers.find(each => each.id === chosen) ?? browsers[0] ?? null;
  const requests = seen.state?.connect_requests ?? [];
  /** @type {'none' | 'add' | 'connected'} */
  const stage = connected ? 'connected' : !browser ? 'none' : 'add';
  return { stage, connected, browsers, browser, name: browser?.name ?? present[0] ?? 'Chrome',
    request: requests.find(each => !closed.has(each.browser)) ?? null,
    waiting: requests.find(each => closed.has(each.browser)) ?? null, sites: browserSites(seen, pressed) };
}

/** @param {Seen} seen */
export function vaultOf(seen) {
  const vault = seen.state?.vault ?? { state: /** @type {const} */ ('none'), saved_ms: null };
  return { ...vault, ready: vault.state === 'saved' };
}

/**
 * @typedef {{ id: string, connector: string, do: import('../connectors/words.js').Do, label: string, name: string, icon: string, gives: string, set: boolean, line: string, also: AccountWay | null, wait: string }} OtherAccount
 * @typedef {{ id: string, do: import('../connectors/words.js').Do, label: string, gives: string }} AccountWay
 */

/**
 * @param {Seen} seen
 * @param {{ connected: Set<string> }} session
 * @returns {OtherAccount[]}
 */
export const accountsOf = (seen, { connected }) => accountsIn(seen).flatMap(/** @returns {OtherAccount[]} */ connector => {
  const set = connector.set_up || connected.has(connector.id);
  const vault = set || vaultOf(seen).ready ? '' : 'After your vault';
  const one = { connector: connector.id, name: connector.name, icon: connector.icon, set, line: connector.line,
    also: /** @type {AccountWay | null} */ (null), wait: vault };
  const doing = signInOf(connector, seen.state);
  if (doing && !('page' in doing)) return [{ ...one, id: connector.id, do: doing, label: 'Connect', gives: connector.gives }];
  if (!doing) return [{ ...one, id: connector.id, do: { page: 'form' }, label: 'Set up', gives: connector.gives,
    wait: vault || (set || extensionOn(seen.report) ? '' : 'After the extension') }];
  const routes = routesOf(connector, seen.state);
  const [first, other] = routes.map(route => ({ id: `${connector.id}:${route.id}`, do: routeAct(connector, route),
    label: route.label, gives: route.about ?? connector.gives }));
  if (set) {
    const running = routes.find(route => route.id === connector.route) ?? routes[0];
    return [{ ...one, id: connector.id, do: routeAct(connector, running), label: 'Connect', gives: first?.gives ?? connector.gives }];
  }
  return first ? [{ ...one, ...first, label: 'Connect', also: other ?? null }] : [];
});


/** @typedef {'idle' | 'busy' | 'working' | 'done'} ActState */

/**
 * @param {string} key
 * @param {{ busy: ReadonlySet<string> }} session
 * @param {{ done?: boolean, working?: boolean, busy?: boolean }} faces
 * @returns {ActState}
 */
export const actState = (key, session, { done = false, working = false, busy }) => done ? 'done' : working ? 'working'
  : busy ?? session.busy.has(key) ? 'busy' : 'idle';

/**
 * @typedef {object} FlowAct
 * @property {string} label
 * @property {string} key
 * @property {'primary' | 'secondary' | 'plain' | 'link'} variant
 * @property {'' | 'warning'} tone
 * @property {ActState} state
 * @property {string} result
 * @property {string} waiting
 * @property {boolean} disabled
 * @property {string} title
 * @property {string} why
 * @property {Record<string, string | null>} data
 * @property {string} href
 */

/** @typedef {(string | { code: string })[]} Spoken */

/** @typedef {{ plain: string } | { failed: string } | { copy: { value: string, label: string, key: string } } | { field: { kind: 'code', name: string, label: string, placeholder: string, value: string, form: string, disabled: boolean, invalid: boolean, title: string } } | { scan: { qr: string | null, label: string, words: Spoken, turn: FlowAct | null } } | { menu: { id: string, label: string, words: string, choices: { value: string, words: string, chosen: boolean }[] } }} Piece */

/** @typedef {{ id: string, icon: string, name: string, about: string, mark: 'done' | 'working' | 'wanted', word: string, line: string }} FlowTile */

/** @typedef {{ number: number | null, open: boolean, key: string }} FlowPart */

/** @typedef {{ id: string, icon: string, name: string, line: string | null, after: string, measured: boolean, why: string, body: Piece[], act: FlowAct | null, cancel: FlowAct | null, tiles: FlowTile[] | null, beside: Piece | null, part: FlowPart | null, hold: { faces: { line: string, after: string }[], end: boolean } | null }} FlowItem */

/** @typedef {{ icon: string, words: string, link: { label: string, href: string } | null }} FlowNote */

/** @typedef {{ icon: string, title: string, line: string }} FlowReason */

/** @typedef {{ qr: string | null, label: string, steps: { words: string, state: 'now' | 'ahead' }[], typed: Spoken, failed: string, get: FlowAct | null }} FlowGuide */

/** @typedef {{ label: string, items: FlowItem[] }} FlowList */

/**
 * @typedef {object} Flow
 * @property {FlowId} id
 * @property {string} icon
 * @property {string} title
 * @property {string} line
 * @property {FlowList[]} lists
 * @property {string} say
 * @property {FlowAct | null} aside
 * @property {FlowNote | null} note
 * @property {FlowReason[]} reasons
 * @property {FlowGuide | null} guide
 * @property {string} fine
 * @property {{ state: 'done' | 'working' | 'wanted', words: string } | null} head
 * @property {FlowAct | null} primary
 * @property {{ icon: string, title: string, line: string, no: FlowAct, yes: FlowAct } | null} question
 * @property {boolean} holds
 * @property {boolean} reading
 * @property {string} said
 * @property {'' | 'pairing' | 'connect-wait' | 'sign-in'} hold
 * @property {number | null} wake
 */

/**
 * @param {string} key
 * @param {FlowSession} session
 * @param {string} [failed]
 */
export const refused = (key, session, failed = '') => session.failure?.key === key ? session.failure.words : failed;

/**
 * @param {string} label
 * @param {string} key
 * @param {FlowSession} session
 * @param {{ variant?: FlowAct['variant'], tone?: FlowAct['tone'], host?: boolean, data?: FlowAct['data'], busy?: boolean, working?: boolean, disabled?: boolean, failed?: string, result?: string, done?: boolean, beside?: boolean, href?: string, waiting?: string }} [options]
 * @returns {FlowAct}
 */
function flowAct(label, key, session, { variant = 'secondary', tone = '', host = false, data = {}, busy, working = false,
  disabled = false, failed = '', result = '', done = false, beside = false, href = '', waiting = '' } = {}) {
  const away = host && !session.hosted;
  return { label, key, variant, tone, result, waiting, data, href, title: away ? ELSEWHERE : '',
    state: actState(key, session, { done, working, busy }), disabled: away || disabled, why: beside ? refused(key, session, failed) : '' };
}

/**
 * @param {string} words
 * @returns {FlowAct}
 */
const doneFace = words => ({ label: '', key: '', variant: 'secondary', tone: '', state: 'done', result: words, waiting: '',
  disabled: false, title: '', why: '', data: {}, href: '' });

/** @param {Partial<FlowItem> & Pick<FlowItem, 'id' | 'icon' | 'name' | 'line'>} item @returns {FlowItem} */
const itemOf = item => ({ after: '', measured: false, why: '', body: [], act: null, cancel: null, tiles: null, beside: null,
  part: null, hold: null, ...item });

/**
 * @param {Partial<Flow> & Pick<Flow, 'id' | 'icon' | 'title' | 'line'>} flow
 * @returns {Flow}
 */
const shapeOf = flow => ({ lists: [], say: '', aside: null, note: null, reasons: [], guide: null, fine: '', head: null,
  primary: null, question: null,
  holds: false, reading: false, said: '', hold: '', wake: null, ...flow });

const VAULT_STEP = { name: 'Your vault', line: 'All passwords and secrets go here.' };

/**
 * @param {Seen} seen
 * @param {FlowSession} session
 * @returns {Flow}
 */
function vaultFlow(seen, session) {
  const vault = vaultOf(seen);
  const locked = vault.state === 'locked' || vault.state === 'lost';
  const then = session.then ? seen.report?.connectors.find(each => each.id === session.then) ?? null : null;
  const key = itemOf({ id: 'vault', icon: 'private', ...VAULT_STEP, why: refused(locked ? 'vault-unlock' : 'vault-open', session),
    act: vault.ready ? doneFace('Kept') : flowAct(locked ? 'Unlock' : 'Create', locked ? 'vault-unlock' : 'vault-open', session,
      { variant: session.frame === 'step' ? 'primary' : 'secondary', host: true }) });
  return shapeOf({
    id: 'vault', icon: 'private',
    title: locked ? 'Unlock your vault' : 'Create your vault',
    line: then ? `What you enter for ${then.name} is kept here, encrypted, on this Mac.`
      : 'Where what you enter for your accounts is kept, encrypted, on this Mac.',
    lists: [{ label: 'Your vault', items: [key] }], holds: vault.ready,
    said: vault.ready ? 'Your vault is ready' : '',
  });
}

export const SIGNING_MS = 60_000;
const MODEL_NOTE = 'What you ask, and what it needs from your life, goes to the model you choose.';

const PLANS = {
  chatgpt: { name: 'ChatGPT', mark: 'chatgpt', program: 'Codex', absent: 'Use your ChatGPT plan.',
    signedOut: 'Sign in with your ChatGPT plan.',
    signing: 'Enter this code on OpenAI’s page.' },
  claude: { name: 'Claude', mark: 'claude', program: 'Claude Code', absent: 'Use your Claude plan.',
    signedOut: 'Sign in with your Claude plan.',
    signing: 'Approve on Anthropic’s page. If it shows a code, paste it here.' },
};
/** @typedef {keyof typeof PLANS} PlanId */

export const PLAN_IDS = /** @type {PlanId[]} */ (Object.keys(PLANS));

/** @typedef {PlanId} ModelItem */
/** @type {ModelItem[]} */
export const MODEL_ITEMS = PLAN_IDS;

const NONE = subscriptionOf(null);

/** @param {Seen} seen */
export function modelOf(seen) {
  const login = seen.state?.ask_login;
  const chatgpt = login?.chatgpt ?? NONE;
  const claude = login?.claude ?? NONE;
  const openrouter = seen.models?.connections.some(each => each.kind === 'key' && each.held) === true;
  return { chatgpt, claude, openrouter,
    connected: chatgpt.state === 'signed_in' || claude.state === 'signed_in' || openrouter };
}

/** @param {number} bytes */
const megabytes = bytes => String(Math.round(bytes / 1_000_000));

/**
 * @param {PlanId} of
 * @param {ReturnType<typeof modelOf>} model
 * @param {FlowSession} session
 * @param {number} now
 */
const openedUntil = (of, model, session, now) => model[of].state === 'signing_in'
  && session.signing.attempt === `${of}:${model[of].attempt ?? ''}` && now < session.signing.until ? session.signing.until : null;

/**
 * @param {PlanId} of
 * @param {ReturnType<typeof modelOf>} model
 * @param {FlowSession} session
 * @param {number} now
 * @returns {FlowItem}
 */
function planItem(of, model, session, now) {
  const words = PLANS[of];
  const plan = model[of];
  const signing = plan.state === 'signing_in';
  const step = session.frame === 'step' && !model.connected;
  const line = plan.state === 'absent' ? words.absent
    : plan.state === 'fetching' ? plan.bytes !== null && plan.total !== null
      ? `Getting ${words.program} to sign in, ${megabytes(plan.bytes)} of ${megabytes(plan.total)} MB.` : `Getting ${words.program} to sign in.`
      : plan.state === 'signed_out' ? words.signedOut : signing ? words.signing
        : plan.state === 'signed_in' ? [plan.account, of === 'claude' && plan.plan ? `${plan.plan[0]?.toUpperCase()}${plan.plan.slice(1)} plan` : '']
          .filter(Boolean).join(' · ') || `Signed in with your ${words.name} plan.` : '';
  /** @type {FlowAct | null} */
  const act = plan.state === 'fetching' ? null
    : signing ? flowAct('Open sign-in page', `open-page:${of}`, session, { host: true, variant: step ? 'primary' : 'secondary',
      working: openedUntil(of, model, session, now) !== null, waiting: 'Signing in', disabled: plan.url === null,
      data: { 'data-url': plan.url } })
      : plan.state === 'signed_in' ? flowAct('Sign out', `sign-out:${of}`, session, { host: true, variant: 'plain' })
        : flowAct(plan.state === 'absent' ? 'Connect' : plan.state === 'failed' ? 'Try again' : 'Sign in', `connect:${of}`, session,
          { host: true, variant: step ? 'primary' : 'secondary' });
  const cancel = signing || plan.state === 'fetching' ? flowAct('Cancel', `cancel-login:${of}`, session, { variant: 'plain', host: true })
    : null;
  const code = of === 'chatgpt' ? 'copy-code' : 'send-code';
  /** @type {Piece[]} */
  const body = of === 'chatgpt'
    ? signing && plan.code ? [{ copy: { value: plan.code, label: 'Your code', key: code } }]
      : []
    : signing ? [{ field: { kind: 'code', name: 'claude-code', label: 'Code from Anthropic',
      placeholder: 'Paste the code, then press Return', value: session.code, form: 'flow-code', disabled: !session.hosted,
      invalid: session.failure?.key === code, title: session.hosted ? '' : ELSEWHERE } }] : [];
  const faces = session.frame === 'step' ? [words.absent, words.signedOut, words.signing].filter(each => each !== line) : [];
  return itemOf({ id: of, name: words.name, icon: words.mark, line,
    why: (signing ? refused(code, session) : '') || refused(`connect:${of}`, session) || refused(`open-page:${of}`, session)
      || refused(`sign-out:${of}`, session, plan.why ?? ''),
    body, hold: faces.length ? { faces: faces.map(each => ({ line: each, after: '' })), end: false } : null, act, cancel });
}

/**
 * @param {Seen} seen
 * @param {FlowSession} session
 * @param {number} now
 * @returns {Flow}
 */
function modelFlow(seen, session, now) {
  const model = modelOf(seen);
  const shown = MODEL_ITEMS.filter(each => session.models.includes(each));
  const said = shown.filter(each => model[each].state === 'signed_in').map(each => `Signed in to ${PLANS[each].name}`)[0] ?? '';
  return shapeOf({
    id: 'model', icon: 'ai', title: 'Connect your AI', line: '',
    lists: [{ label: 'Models', items: shown.map(each => planItem(each, model, session, now)) }],
    holds: shown.some(each => model[each].state === 'signed_in'),
    note: { icon: 'private', words: MODEL_NOTE, link: null }, said,
    hold: 'sign-in', wake: shown.map(of => openedUntil(of, model, session, now)).find(until => until !== null) ?? null,
  });
}

const PHONE_LINE = 'Your phone sees the part of life that happens away from this desk.';
const PHONE_REASONS = [
  { icon: 'place', title: 'Your location', line: 'Lifestream records where you go through the day, efficiently.' },
  { icon: 'health', title: 'Health and movement', line: 'Sleep, steps and workouts.' },
  { icon: 'chat', title: 'Ask and access', line: 'Ask and access it from your phone.' },
];
export const GET_APP = 'Get the app';
const PHONE_STEPS = ['Scan the code', 'Pair with this Mac', 'Choose what to send', 'Allow what you want'];
const PHONE_NOTE = { icon: 'online', words: 'Your iPhone needs to be on the same Wi‑Fi as this Mac, or have Tailscale on both.',
  link: { label: 'Get Tailscale', href: 'https://tailscale.com/download' } };

/**
 * @param {Seen} seen
 * @param {FlowSession} session
 * @returns {Flow}
 */
function phoneFlow(seen, session) {
  const step = session.frame === 'step';
  const phone = phoneOf(seen);
  const before = session.before;
  const paired = phone.phones.filter(each => each.pass !== null);
  const fresh = step ? paired : before === null ? [] : paired.filter(each => !before.has(/** @type {string} */ (each.pass)));
  const another = !step && session.another !== null;
  const cards = (step ? phone.paired : fresh.length > 0) ? fresh.map(each => itemOf({ id: each.unit, name: each.name,
    icon: 'phone-screen', line: each.health.words, act: doneFace('Paired'),
    tiles: another ? null : each.streams.map(stream => ({ ...stream, id: `${each.unit}:${stream.id}` })) })) : [];
  const codes = step ? codesShown(seen, session) : cards.length === 0 || session.another !== null;
  const pairing = pairingOf(seen);
  const app = phoneAppOf(seen);
  const open = app && session.part === 'app' ? 'app' : 'pair';
  /** @type {Spoken} */
  const typed = open === 'pair' && pairing?.typed ? ['Or type ', { code: pairing.typed }, ' on your iPhone.', ...pairing.match
    ? [' It asks you to check that this Mac shows ', { code: pairing.match }, '.'] : []] : [];
  /** @type {FlowGuide | null} */
  const guide = codes ? { qr: open === 'app' ? app : pairing?.why ? null : pairing?.qr ?? null,
    label: open === 'app' ? 'Get Lifestream for iPhone from TestFlight' : 'Pair your iPhone with this Mac',
    steps: (open === 'app' ? [GET_APP, ...PHONE_STEPS] : PHONE_STEPS).map((words, at) => ({ words, state: at === 0 ? 'now' : 'ahead' })),
    typed,
    failed: open === 'pair' ? pairing?.why ?? '' : '',
    get: app && open === 'pair' ? flowAct(GET_APP, 'phone-app', session, { variant: 'link' }) : null } : null;
  const holds = step ? phone.paired : cards.length > 0;
  return shapeOf({
    id: 'phone', icon: 'phone-screen', title: 'Connect your iPhone', line: PHONE_LINE,
    lists: cards.length ? [{ label: 'Paired iPhones', items: cards }] : [],
    reasons: codes && !cards.length ? PHONE_REASONS : [], guide,
    primary: codes && app && open === 'app' ? flowAct('I have the app', 'pair-code', session, { beside: true }) : null,
    aside: codes ? null : flowAct('Pair another iPhone', 'pair-another', session, { variant: 'plain', host: true,
      beside: true }),
    note: codes ? PHONE_NOTE : null, holds, said: holds ? 'Paired' : '',
    hold: codes && (!step || seen.report !== null) ? 'pairing' : '',
  });
}

const BROWSER_NOTE = { icon: 'private', words: 'It works in a small window of its own, only on the sites you connect. It never '
  + 'reads your other tabs.', link: null };

/**
 * @param {Seen} seen
 * @param {FlowSession} session
 * @param {number} now
 * @returns {Flow}
 */
function browserFlow(seen, session, now) {
  const browser = browserOf(seen, session);
  const name = browser.name;
  const base = { id: /** @type {const} */ ('browser'), icon: 'web', title: `Add Lifestream to ${name}`,
    line: `Some of your life lives on sites with no export. Lifestream reads them through your own signed-in ${name}, the way `
      + 'you would.', hold: /** @type {const} */ ('connect-wait'),
    holds: browser.connected, said: browser.connected ? `Connected to ${name}` : '' };
  if (browser.stage === 'none') {
    const brings = chromeBrings(seen.report)
      .map(connector => itemOf({ id: connector.id, name: connector.name, icon: connector.icon, line: connector.gives }));
    return shapeOf({ ...base, say: 'You need Chrome, or a browser like it.',
      lists: brings.length ? [{ label: 'Its sites', items: brings }] : [],
      primary: flowAct('Get Chrome', 'get-chrome', session, { variant: 'primary', href: 'https://www.google.com/chrome/' }) });
  }
  const chosen = browser.browser ?? browser.browsers[0];
  /** @type {Piece | null} */
  const choice = browser.browsers.length > 1 && !browser.connected ? { menu: { id: 'flow-browser', label: 'Browser',
    words: chosen.name, choices: browser.browsers.map(each => ({ value: each.id, words: each.name,
      chosen: each.id === chosen.id })) } } : null;
  const { request, waiting } = browser;
  const asking = request?.browser || name;
  const offered = waiting?.browser || name;
  const picking = choice ? itemOf({ id: 'extension', name: 'Your browser', icon: 'web', line: 'Lifestream adds itself to this one.',
    beside: choice }) : null;
  const adding = browser.connected ? null : waiting
    ? flowAct(`Allow ${offered}`, 'connect-open', session, { variant: 'primary', data: { 'data-browser': waiting.browser } })
    : flowAct(`Add to ${name}`, 'add-browser', session, { variant: 'primary', host: true, busy: false, beside: true });
  const sites = browser.sites.map(site => {
    const where = site.browser || name;
    const station = site.browser ? site.station : browser.browser;
    const out = site.state === 'out' || site.state === 'unsure';
    return itemOf({ id: site.id, name: site.name, icon: site.icon, measured: site.measured,
      line: site.state === 'connected' ? site.line : site.state === 'before' ? 'After the extension'
        : site.state === 'checking' ? site.words : site.state === 'in'
          ? `Signed in to ${site.name}${site.account ? ` as ${site.account}` : ''} in ${where}`
          : site.state === 'withheld' ? `Lifestream isn’t allowed on ${site.name} in ${where} yet`
          : !station ? `Open ${site.name} in ${where} to sign in`
            : session.opened.has(site.id) ? SIGN_IN_THERE : site.state === 'unsure'
              ? `Couldn’t tell if you’re signed in to ${site.name} in ${where}` : `Not signed in to ${site.name} in ${where}`,
      why: refused(out ? `open-site:${site.id}` : `connect-site:${site.id}`, session),
      act: out ? flowAct('Sign in', `open-site:${site.id}`, session, { host: true, disabled: !station || !site.href,
        data: { 'data-url': site.href, 'data-browser': station?.id ?? null } })
        : flowAct('Connect', `connect-site:${site.id}`, session, { host: true, result: 'Connected',
          done: site.state === 'connected', working: site.state === 'checking', waiting: CHECKING,
          disabled: (site.state !== 'in' && site.state !== 'withheld') || !site.connect }) });
  });
  const since = session.knock?.since ?? null;
  const id = { 'data-id': request?.id ?? null };
  const question = request ? { icon: 'web', title: `${asking} wants to connect`,
    line: (since !== null ? `It has been asking since ${clock(since)}. ` : '')
      + `Allow it, and ${asking} connects to Lifestream on this Mac. Nothing is read yet: each site starts once you `
      + 'press its Connect.',
    no: flowAct('Not now', 'close', session, { variant: 'plain', beside: true }),
    yes: flowAct('Allow', 'connect-yes', session, { variant: 'primary', host: true, data: id, beside: true }) } : null;
  const knocker = session.knock?.browser || name;
  const awaited = session.knock && !request && !waiting && now - session.knock.at < KNOCK_MS
    ? session.knock.at + KNOCK_MS : null;
  const head = browser.connected ? { state: /** @type {const} */ ('done'), words: `Connected to ${name}` }
    : session.knock && !request && !waiting ? awaited !== null
      ? { state: /** @type {const} */ ('working'), words: `Waiting for ${knocker} to ask again.` }
      : { state: /** @type {const} */ ('wanted'), words: `Open the Lifestream extension in ${knocker} to ask again.` }
      : null;
  const reading = seen.report === null;
  const unread = reading && session.frame === 'dialog' ? [0, 1].map(at => itemOf({ id: `reading:${at}`, icon: '',
    name: '', line: null })) : [];
  const listed = [...sites, ...unread];
  return shapeOf({ ...base,
    lists: [...picking ? [{ label: 'Your browser', items: [picking] }] : [],
      ...listed.length ? [{ label: 'Its sites', items: listed }] : []],
    primary: adding, note: BROWSER_NOTE,
    fine: browser.connected || waiting ? '' : `${name} asks to “read and change data on websites”: that’s how it opens these sites.`,
    reading, question, head: session.frame === 'dialog' ? head : null, wake: session.frame === 'dialog' ? awaited : null });
}

/**
 * @param {FlowId} id
 * @param {Seen} seen
 * @param {FlowSession} session
 * @param {number} [now]
 * @returns {Flow}
 */
export function flowOf(id, seen, session, now = Date.now()) {
  if (id === 'vault') return vaultFlow(seen, session);
  if (id === 'model') return modelFlow(seen, session, now);
  if (id === 'phone') return phoneFlow(seen, session);
  return browserFlow(seen, session, now);
}
