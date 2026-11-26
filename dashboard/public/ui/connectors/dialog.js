// @ts-check
/** @import { ConnectorReport, Copy, DeviceRow, Figure, Health, History, MemberState, Road, State, StreamsReport } from '../../types.js' */
/** @import { SignalKind } from '../kit/signal.js' */
/** @import { HostAct, HostState } from '../../lib/host.js' */
/** @import { Act, Do } from './words.js' */
import { findFor, menuLines } from '../../lib/model-menu.js';
import { count, counted } from '../../lib/words.js';
import { STATE_LOOKS } from '../kit/connector-row.js';
import {
  actOf, actsOf, fieldHint, formDo, formOf, pausedOf, pausing, routeAct, routesOf, settableHere, signInOf, typed, wholeLine,
} from './page.js';
import { IMPORT, importDetail } from './imports.js';
import { SETTINGS_PROVIDERS, SETTINGS_PRIVACY } from './settings.js';
import { settingKey } from './view.js';
import { DETAIL, disconnectWords, turn } from './words.js';

/** @typedef {{ ask: string, question: string, detail: string, yes: Act, no: Act }} Confirm */

/** @typedef {{ label: string, lines: string[], panel: Panel | null, acts: Act[], flow?: import('../flows/model.js').Flow | null, id?: string, list?: string[], text?: string, chips?: { label: string, lit: boolean, do: Do }[], button?: Act, confirm?: Confirm, card?: boolean, aside?: import('../../types.js').Bolded, figure?: import('../../types.js').ReadsFigure, control?: import('../agents/detail.js').Control, hides?: import('../agents/detail.js').Hides, kinds?: { label: string, value: string, choices: { value: string, label: string, count: string }[] }, amount?: { n: string, words: string, parts: { id: string, name: string, n: number }[] }, refused?: string, said?: import('../../types.js').Bolded, ask?: { today: import('../../types.js').Bolded, says: { title: string, reason: string } | null, screen: string }, pick?: { label: string, line: string, choices: { n: number, do: Do }[] }, steps?: import('../agents/guides.js').StepShown[] }} DetailPart */

/** @typedef {{ icon: string } | { app: { name: string, src: string } } | { status: 'running' | 'paused' | 'done' | 'waiting' | 'disk' } | { look: State }} Lead */

/**
 * @typedef {object} Menu
 * @property {string} id
 * @property {string} busy
 * @property {string} label
 * @property {string} words
 * @property {{ words: string, note: string, chosen: boolean, default: boolean, do: Do | null, parted?: boolean, head?: string, tag?: string, more?: boolean }[]} choices
 * @property {string} find
 * @property {{ label: string, value: string, connector: string, member: string, asks: boolean, said: { note: string, act: Act | null } | null } | null} date
 */

/** @typedef {{ menu: Menu, acts?: Act[] } | { toggle: { on: boolean, label: string, do: Do }, words?: string, acts?: Act[] } | { segmented: { label: string, choices: { value: string, words: string, chosen: boolean, do: Do }[] } } | { field: { key: string, label: string, kind: 'email' | 'text' | 'date' | 'secret', value: string, placeholder: string, max?: number }, acts?: Act[] } | { stepper: { label: string, text: string, less: Do | null, more: Do | null } } | { acts: Act[], words?: string, done?: boolean } | { words: string, done?: boolean } | { time: string } | { copy: { value: string, label: string, copied?: boolean, do?: Do } }} End */

/**
 * @typedef {object} PanelRow
 * @property {string} label
 * @property {Lead | null} lead
 * @property {string} line
 * @property {boolean} [working]
 * @property {string} does
 * @property {string[]} waiting
 * @property {string} only
 * @property {Lead | null} mark
 * @property {Do | null} act
 * @property {boolean} dim
 * @property {End | null} end
 * @property {{ do: Do, value: string, time?: string } | null} go
 * @property {boolean} [inset]
 * @property {Menu} [menu]
 * @property {string} [tail]
 * @property {'warning' | 'caution'} [tone]
 * @property {Do} [open]
 * @property {Confirm | null} confirm
 * @property {import('../kit/signal.js').SignalKind | null} [signal]
 * @property {boolean} [pulse]
 * @property {string} [tag]
 * @property {{ label: string, share: number, words: string } | null} [progress]
 */

/** @typedef {{ placeholder: string, typed: string, finds: { name: string, lead: Lead, do: Do }[], lit: number, enter: Do | null, end: End | null }} Adding */

/** @typedef {{ placeholder: string, typed: string }} Finding */

/** @typedef {{ label: string, about: string, lede: string, find: Finding | null, rows: PanelRow[], add: Adding | null, note: string, group?: boolean }} Panel */

/** @typedef {{ kind: SignalKind | null, title: string, lines: string[], acts: Act[] }} Callout */

/** @typedef {{ id: string, name: string, line: string, mark: 'done' | 'here' | 'idle', act: Act | null }} Requirement */

/** @typedef {{ today: number | null, noun: [string, string] | null, last: string, week: number[] | null, end: string }} WeekFigure */

/** @typedef {{ label: string, done: string, share: number | null, line: string }} Progress */

/** @typedef {{ key: string, label: string, kind: 'text' | 'email' | 'date' | 'secret', value: string, placeholder: string, why: string, note: string }} SignInField */

/** @typedef {{ steps: { title: string, line: string, open: Act | null }[], last: string, fields: SignInField[], rows: PanelRow[] }} SignIn */

/** @typedef {{ id: string, icon: string, name: string, line: string | null, said?: import('../../types.js').Bolded, state: State | null, callout: Callout | null, held?: Callout[], connect?: { ways: { label: string, rows: Requirement[] }[], notes: string[] } | null, figure: WeekFigure | null, parts: DetailPart[], panels: Panel[], back: { label: string, above?: boolean } | null, foot: { start: Act | null, end: Act[], note?: string, said?: import('../../types.js').Bolded, waits?: import('../../types.js').Bolded, mark?: 'done' | 'waiting' | '', busy?: boolean } | null, confirm: Confirm | null, reading: boolean, ticking: boolean, import?: import('./imports.js').ImportBody, nav?: Nav | null, note?: string, at?: string, reads?: string, where?: string, progress?: Progress | null, signin?: SignIn | null, page?: boolean, storage?: { answer: import('./settings-storage.js').Storage, more: boolean } | null, readFailed?: (import('./settings.js').ReadFailed & { lacking: boolean }) | null }} Detail */

/** @typedef {{ label: string, query: string, groups: { label: string, items: { id: string, label: string, icon: string, on: boolean, dot: boolean, do: Do }[] }[] }} Nav */

/** @typedef {{ pages: string[], typed: string, lit: number, kept: ReadonlySet<string>, fields?: Readonly<Record<string, string>>, refused?: string, dated?: Dated | null, found?: import('../../lib/model-menu.js').Found | null }} Opened */

/** @type {Opened} */
export const OPENED = { pages: [], typed: '', lit: 0, kept: new Set(), fields: {}, refused: '' };

/**
 * @param {Partial<Panel>} panel
 * @returns {Panel}
 */
export const panelOf = panel => ({ label: '', about: '', lede: '', find: null, rows: [], add: null, note: '', ...panel });

/**
 * @param {string} label
 * @param {Partial<PanelRow>} [row]
 * @returns {PanelRow}
 */
export const rowOf = (label, row = {}) => ({ label, lead: null, line: '', does: '', waiting: [], only: '', mark: null,
  act: null, dim: false, end: null, go: null, confirm: null, ...row });

/**
 * @param {Figure | null} figure
 * @param {[string, string] | null} noun
 * @param {string} day
 * @returns {WeekFigure | null}
 */
const figureOf = (figure, noun, day) => figure && { today: figure.today, noun, end: day, last: '',
  week: figure.week?.length ? figure.week : null };

/**
 * @param {{ state: State, words: string, line?: string | null, acts: import('../../types.js').Act[] }} said
 * @param {ConnectorReport | null} connector
 * @param {HostState | null} state
 * @returns {Callout}
 */
const saidCallout = (said, connector, state) => ({ kind: STATE_LOOKS[said.state], title: said.words, lines: said.line ? [said.line] : [],
  acts: actsOf(said.acts, connector, state) });

/**
 * @param {Health} health
 * @param {ConnectorReport | null} connector
 * @param {HostState | null} state
 * @returns {Callout | null}
 */
const healthCallout = (health, connector, state) => health.state === 'ok' || health.state === 'syncing' || health.state === 'setup'
  || !health.words ? null : saidCallout(health, connector, state);

/**
 * @param {ConnectorReport} connector
 * @param {HostState | null} state
 * @returns {Act | null}
 */
const sheetOf = (connector, state) => {
  const doing = signInOf(connector, state);
  return doing && { label: connector.account ? 'Change' : 'Connect', do: doing };
};


/**
 * @param {ConnectorReport} connector
 * @param {string} member
 * @param {unknown} value
 * @returns {Do}
 */
const setTo = (connector, member, value) => ({ host: { act: 'setting', connector: connector.id, member, value } });

/** @type {[string, string][] | null} */
let zones = null;

function zonesOf() {
  if (zones) return zones;
  const now = new Date();
  zones = ['UTC', ...Intl.supportedValuesOf('timeZone').filter(zone => zone !== 'UTC')].map(zone => {
    const offset = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(now)
      .find(part => part.type === 'timeZoneName')?.value ?? '';
    const city = zone.split('/').at(-1)?.replaceAll('_', ' ') ?? zone;
    return [zone, offset && offset !== city ? `${city} · ${offset}` : city];
  });
  return zones;
}

/**
 * @param {ConnectorReport} connector
 * @param {MemberState} member
 * @param {import('../../types.js').Step[]} steps
 * @param {{ find?: string, date?: Menu['date'] }} [more]
 * @returns {End}
 */
const menuOf = (connector, member, steps, { find = '', date = null } = {}) => {
  /** @type {Menu['choices']} */
  const choices = steps.map(step => ({ words: step.words, note: step.note ?? '', chosen: step.value === String(member.value ?? ''),
    default: step.value === String(member.default ?? ''), do: setTo(connector, member.key, step.value) }));
  return { menu: { id: `${connector.id}.${member.key}`, busy: settingKey(connector.id, member.key), label: member.label, words: member.words, find, date, choices } };
};

/**
 * @param {import('../../pages.js').ModelMenu} menu
 * @param {(value: string) => Do | null} pick
 * @param {Do} more
 * @returns {Menu['choices']}
 */
export const modelChoices = (menu, pick, more) => menuLines(menu).map(line => 'more' in line
  ? { words: line.more, note: '', chosen: false, default: false, do: more, more: true }
  : { words: line.row.name, note: '', tag: line.row.account ?? '', head: line.head, chosen: line.row.chosen, default: false, do: pick(line.row.value), parted: line.parted });

/**
 * @param {Found | null} found
 * @param {string} typed
 * @param {(value: string) => Do | null} pick
 * @returns {Panel[]}
 */
export function foundPanels(found, typed, pick) {
  const answer = found?.answer ?? null;
  /** @param {import('../../pages.js').ModelRow} row */
  const rowFor = row => rowOf(row.name, { ...row.account ? { tag: row.account } : {}, act: pick(row.value), end: row.chosen ? { words: '', done: true } : null });
  return [panelOf({ find: { placeholder: answer?.placeholder ?? '', typed }, note: answer?.none ?? found?.failed ?? '' }),
    ...(answer?.groups ?? []).map(group => panelOf({ label: group.label, group: true, rows: group.rows.map(rowFor) }))];
}

/** @typedef {import('../../lib/model-menu.js').Found} Found */

export const MODEL_PAGE = 'model:';

/**
 * @param {StreamsReport | null} report
 * @param {string} id
 * @param {Opened} opened
 * @returns {import('../../lib/model-menu.js').FindFor | null}
 */
export function modelFinding(report, id, opened) {
  const page = opened.pages.at(-1) ?? '';
  if (!page.startsWith(MODEL_PAGE)) return null;
  const member = report?.connectors.find(each => each.id === id)?.members.find(each => each.key === page.slice(MODEL_PAGE.length));
  return member?.menu ? findFor(member.menu.more) : null;
}

/**
 * @param {ConnectorReport} connector
 * @param {string} key
 * @param {HostState | null} state
 * @param {Opened} opened
 * @returns {{ title: string, panel: Panel, panels?: Panel[] } | null}
 */
function modelPage(connector, key, state, opened) {
  const member = connector.members.find(each => each.key === key);
  const more = member?.menu?.more;
  if (!member || !more) return null;
  const [panel, ...panels] = foundPanels(opened.found ?? null, opened.typed, value => state ? setTo(connector, member.key, value) : null);
  return { title: more.words, panel, panels };
}

/**
 * @param {ConnectorReport} connector
 * @param {MemberState} member
 * @param {HostState | null} state
 * @param {{ line?: string, mark?: Lead | null, act?: Do | null, date?: Menu['date'] }} [beside]
 * @returns {PanelRow}
 */
function memberRow(connector, member, state, { date, ...said } = {}) {
  const does = member.about ?? '';
  const row = { waiting: (member.waiting ?? []).map(each => each.line), only: member.only ?? '',
    ...said.line ? { does, ...said } : { ...said, line: does } };
  const { control } = member;
  if (control === 'list') {
    return rowOf(member.label, { ...row, go: { do: { page: `list:${member.key}` }, value: member.words } });
  }
  if (!state || control === null) return rowOf(member.label, { ...row, end: { words: member.words } });
  /** @param {End} end */
  const ending = end => rowOf(member.label, { ...row, end });
  if (control === 'menu' && member.kind === 'choice' && member.steps?.length === 2
    && member.steps.every(step => step.value === 'on' || step.value === 'off') && member.steps[0].value !== member.steps[1].value) {
    const on = member.value === 'on';
    return ending({ toggle: { on, label: member.label, do: setTo(connector, member.key, on ? 'off' : 'on') } });
  }
  if (member.kind === 'start') {
    const value = String(member.value ?? '');
    return ending(menuOf(connector, member, [{ value: 'all', words: 'All time', note: null }], { date: { label: 'A date',
      value: /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : '', connector: connector.id, member: member.key, asks: false, said: null } }));
  }
  if (control === 'menu' && member.menu) {
    const { menu } = member;
    return ending({ menu: { id: `${connector.id}.${member.key}`, busy: settingKey(connector.id, member.key), label: member.label, words: member.words, find: '', date: null,
      choices: modelChoices(menu, value => setTo(connector, member.key, value), { page: `${MODEL_PAGE}${member.key}` }) } });
  }
  if (control === 'menu') return ending(menuOf(connector, member, member.steps ?? [], date !== undefined ? { date } : {}));
  if (control === 'zone') {
    const value = String(member.value ?? '');
    const known = zonesOf();
    const steps = [...known, ...value && !known.some(([zone]) => zone === value) ? [[value, value]] : []]
      .map(([zone, words]) => ({ value: zone, words, note: null }));
    return ending(menuOf(connector, member, steps, { find: 'Find a time zone' }));
  }
  if (control === 'toggle') {
    const on = member.value === true;
    return ending({ toggle: { on, label: member.label, do: setTo(connector, member.key, !on) } });
  }
  if (control === 'stepper') {
    const at = Number(member.value ?? 0);
    return ending({ stepper: { label: member.label, text: member.words,
      less: at - 1 >= (member.min ?? -Infinity) ? setTo(connector, member.key, at - 1) : null,
      more: at + 1 <= (member.max ?? Infinity) ? setTo(connector, member.key, at + 1) : null } });
  }
  if (control === 'path') {
    if (member.where && !settableHere(member, state)) {
      return rowOf(member.label, { ...row, line: `Choose it on ${member.where.name}`, end: { words: member.words } });
    }
    return ending({ words: member.words, acts: [{ label: 'Choose', variant: 'secondary',
      do: { host: { act: 'choose-file', connector: connector.id, member: member.key } } }] });
  }
  return ending({ words: member.words });
}

/**
 * @param {ConnectorReport} connector
 * @param {import('../../types.js').Panel} panel
 * @param {HostState | null} state
 */
const membersOn = (connector, panel, state) => connector.members.filter(member => member.panel === panel)
  .map(member => memberRow(connector, member, state));

const KEEP = 'Add new items';
const KEEP_LINE = 'What’s already in stays.';

/**
 * @param {ConnectorReport} connector
 * @param {HostState | null} state
 * @returns {Panel | null}
 */
function settingsOf(connector, state) {
  const own = connector.shown === 'home' ? [rowOf(KEEP, { line: KEEP_LINE, end: state
    ? { toggle: { on: connector.on, label: KEEP, do: turn('', [connector.id], !connector.on).do } }
    : { words: connector.on ? 'On' : 'Off' } })] : [];
  const members = connector.members.filter(member => member.panel === 'settings');
  const rows = members.map(member => memberRow(connector, member, state));
  const now = refreshRow(connector, state);
  if (now) rows.splice(members.findIndex(member => member.key === 'refresh') + 1, 0, now);
  return rows.length || own.length ? panelOf({ label: 'Settings', rows: [...own, ...rows] }) : null;
}

/**
 * @param {ConnectorReport} connector
 * @param {HostState | null} state
 * @returns {PanelRow | null}
 */
function refreshRow(connector, state) {
  const now = connector.refresh_now;
  if (!now) return null;
  const { blocked, asked } = now;
  const press = state ? actOf(now.act, connector, state) : { label: now.act.label, do: { refresh: connector.id } };
  const waiting = asked.length ? [`Asked ${asked.map(each => each.name).join(' and ')}`] : [];
  return rowOf(now.act.label, { line: blocked?.words ?? connector.figure?.words ?? '', waiting,
    signal: blocked ? blocked.reason === 'running' ? 'engaged' : 'idle' : null, pulse: blocked?.reason === 'running',
    end: blocked || !press ? null : { acts: [{ ...press, label: 'Refresh', variant: 'secondary' }] } });
}

/**
 * @param {ConnectorReport} connector
 * @param {HostState | null} state
 * @returns {Panel | null}
 */
function groupsOf(connector, state) {
  const rows = membersOn(connector, 'groups', state);
  if (!rows.length) return null;
  const { quiet } = connector;
  const line = quiet === null ? [] : [rowOf('Quiet groups',
    { go: { do: { to: { view: 'people', patch: { seg: 'groups' } } }, value: count(quiet) } })];
  return panelOf({ label: 'Groups', rows: [...rows, ...line] });
}



/** @type {Record<Road, string>} */
const ROAD_ICONS = { mac: 'work-mac', phone: 'phone-screen', chrome: 'web', poll: 'online', upload: 'file', owner: 'home',
  label: 'home' };

const COPIES_SHOWN = 5;

/**
 * @param {Copy} copy
 * @param {boolean} switched
 * @param {string} [streamIcon]
 * @param {{ name: string, act: Act | null } | null} [named]
 * @returns {PanelRow}
 */
const copyRow = (copy, switched, streamIcon = '', named = null) => rowOf(named?.name ?? copy.name, {
  lead: { icon: copy.road === 'upload' && streamIcon ? streamIcon : ROAD_ICONS[copy.road] },
  signal: STATE_LOOKS[copy.health.state] ?? null, line: copy.line, dim: !copy.on,
  end: switched ? { toggle: { on: copy.on, label: named?.name ?? copy.name, do: turn('', [copy.id], !copy.on).do },
    ...named?.act ? { acts: [named.act] } : {} } : named?.act ? { acts: [named.act] } : null });

/**
 * @param {ConnectorReport} connector
 * @param {HostState | null} state
 * @returns {Act | null}
 */
function accountAct(connector, state) {
  const sheet = sheetOf(connector, state);
  if (sheet) return { ...sheet, variant: 'secondary' };
  const form = formDo(connector, state);
  return form && { label: 'Change', variant: 'secondary', do: form };
}

/**
 * @param {ConnectorReport} connector
 * @param {HostState | null} state
 * @returns {PanelRow[]}
 */
function sourceRows(connector, state) {
  const { account } = connector;
  const joined = account?.copy ? connector.copies.find(copy => copy.id === account.copy) ?? null : null;
  const change = account ? accountAct(connector, state) : null;
  const switched = state !== null && connector.copies.length > 1;
  /** @type {PanelRow[]} */
  const rows = [];
  if (account && !joined) {
    rows.push(rowOf(account.name, { lead: { icon: 'online' }, line: account.line, end: change ? { acts: [change] } : null }));
  }
  const asked = connector.ways.some(way => way.requirements.some(each => each.kind === 'form' && !each.met));
  const form = !account && !asked && formOf(connector).length > 0 ? formDo(connector, state) : null;
  if (form) {
    rows.push(rowOf(`${connector.name} account`, { lead: { icon: 'online' }, line: 'Not set yet',
      end: { acts: [{ label: 'Set up', variant: 'secondary', do: form }] } }));
  }
  const copies = joined ? [joined, ...connector.copies.filter(copy => copy !== joined)] : connector.copies;
  rows.push(...copies.map(copy => copyRow(copy, switched, connector.icon,
    copy === joined && account ? { name: account.name, act: change } : null)));
  return rows;
}

/**
 * @param {ConnectorReport} connector
 * @param {HostState | null} state
 * @returns {Panel | null}
 */
function comesFrom(connector, state) {
  const every = sourceRows(connector, state);
  const shown = every.length > COPIES_SHOWN + 1 ? every.slice(0, COPIES_SHOWN) : every;
  /** @type {PanelRow[]} */
  const rows = [...shown];
  if (every.length > shown.length) rows.push(rowOf('Show all', { go: { do: { page: 'copies' }, value: '' } }));
  for (const member of connector.members.filter(each => each.panel === 'comes-from')) {
    const here = state !== null && settableHere(member, state);
    rows.push(rowOf(member.label, { lead: { icon: 'work-mac' }, line: here || !member.where ? member.words : `Choose it on ${member.where.name}`,
      end: here ? { acts: [{ label: 'Choose', variant: 'primary', do: { host: { act: 'choose-file', connector: connector.id, member: member.key } } }] } : null }));
  }
  const fed = connector.export;
  if (!rows.length && !fed) return null;
  const drawn = state ? rows : rows.map(row => ({ ...row,
    end: row.end && 'words' in row.end && row.end.words ? /** @type {End} */ ({ words: row.end.words }) : null }));
  if (fed) {
    drawn.push(rowOf(fed.name, { lead: { icon: fed.icon }, line: fed.line,
      end: { acts: [{ label: 'Show', variant: 'plain', do: { open: `${IMPORT}${fed.import}` } }] } }));
  }
  return panelOf({ label: 'Comes from', rows: drawn });
}


/** @type {Record<History['state'], 'running' | 'done'>} */
const HISTORY_LEADS = { syncing: 'running', done: 'done' };

/**
 * @param {ConnectorReport} connector
 * @param {StreamsReport} report
 * @param {HostState | null} state
 * @returns {Panel | null}
 */
function backfillOf(connector, report, state) {
  const { history } = connector;
  const held = pausedOf(connector, 'history');
  const pause = held ? report.paused.find(each => each.target === `pause:${connector.id}:history`) ?? null : null;
  /** @type {'pause' | 'resume' | null} */
  const doing = !state ? null : held ? 'resume'
    : history?.state === 'syncing' && connector.pauses.length === 0 ? 'pause' : null;
  const end = doing && { acts: [{ label: doing === 'pause' ? 'Pause' : 'Resume', variant: /** @type {const} */ ('secondary'),
    do: { host: /** @type {HostAct} */ ({ act: doing, connector: connector.id, scope: 'history' }) } }] };
  const kept = connector.copies.reduce((sum, copy) => sum + (copy.held ?? 0), 0);
  const unit = history?.unit ?? connector.noun;
  const status = [held ? pause?.line ?? 'Paused' : history?.state === 'syncing' ? 'Reading' : 'Done',
    kept && unit ? counted(kept, unit[0], unit[1]) : ''].filter(Boolean).join(' · ');
  const lead = { lead: /** @type {Lead} */ ({ icon: 'time' }), end };
  const rows = [...history ? [rowOf(history.words, { ...lead,
    mark: held || history.state === 'syncing' ? { status: held ? 'paused' : HISTORY_LEADS[history.state] } : null,
    line: upper(status) })] : held ? [rowOf(upper(status), { ...lead, mark: { status: 'paused' } })] : [],
    ...membersOn(connector, 'backfill', state)];
  return rows.length ? panelOf({ label: DETAIL.history, about: connector.backfill_about ?? '', rows }) : null;
}



const PROCESSING_MARKS = /** @type {Record<NonNullable<import('../../types.js').ProcessingRow['shape']>, Lead | null>} */ ({
  off: null, needs: { look: 'needs-you' }, waiting: { status: 'waiting' }, running: { status: 'running' }, done: { status: 'done' } });

/** @typedef {{ connector: string, member: string, value: string, step: import('../../types.js').Step | null, failed: string }} Dated */

/**
 * @param {ConnectorReport} connector
 * @param {MemberState} member
 * @param {Dated | null | undefined} dated
 * @returns {NonNullable<Menu['date']>}
 */
function askedDate(connector, member, dated) {
  const mine = dated && dated.connector === connector.id && dated.member === member.key ? dated : null;
  const value = String(member.value ?? '');
  const held = /^\d{4}-\d{2}-\d{2}$/u.test(value) && !member.steps?.some(step => step.value === value) ? value : '';
  const said = !mine ? null : mine.failed ? { note: mine.failed, act: null } : !mine.step ? { note: 'Reading what it would read…', act: null }
    : { note: mine.step.note ?? '', act: { label: mine.step.words, variant: /** @type {const} */ ('primary'),
      do: setTo(connector, member.key, mine.value) } };
  return { label: 'A date', value: mine?.value ?? held, connector: connector.id, member: member.key, asks: true, said };
}

/**
 * @param {ConnectorReport} connector
 * @param {HostState | null} state
 * @param {Dated | null} dated
 * @returns {Panel | null}
 */
export function processingOf(connector, state, dated) {
  const { processing } = connector;
  if (!processing) return null;
  const rows = processing.rows.flatMap(row => {
    const member = connector.members.find(each => each.key === row.member);
    if (!member) return [];
    const act = row.shape === 'needs' && state ? { open: SETTINGS_PROVIDERS } : row.privacy?.waiting ? { open: SETTINGS_PRIVACY } : null;
    const work = memberRow(connector, member, state, row.shape === null ? { date: askedDate(connector, member, dated) }
      : { line: row.line ?? '', mark: PROCESSING_MARKS[row.shape], act });
    const level = row.privacy ? connector.members.find(each => each.key === row.privacy?.member) : null;
    return [work, ...row.privacy && level ? [memberRow(connector, level, state, { line: row.privacy.note })] : []];
  });
  return panelOf({ label: DETAIL.ai, rows });
}

export const AI_PAGE = 'ai:';
const AI_MODEL = 'Model';

/** @param {string} words */
const upper = words => words.charAt(0).toUpperCase() + words.slice(1);

/**
 * @param {ConnectorReport} connector
 * @param {HostState | null} state
 * @param {Dated | null} dated
 * @returns {Panel | null}
 */
function aiOf(connector, state, dated) {
  const { processing } = connector;
  if (!processing) return null;
  const rows = processing.rows.flatMap(row => {
    const member = connector.members.find(each => each.key === row.member);
    if (!member) return [];
    if (row.shape === null) return [memberRow(connector, member, state, { date: askedDate(connector, member, dated) })];
    return [rowOf(member.label, { lead: { icon: 'ai' }, line: row.line ?? member.words,
      go: { do: { page: `${AI_PAGE}${member.key}` }, value: '' } })];
  });
  return rows.length ? panelOf({ label: DETAIL.ai, rows }) : null;
}

/**
 * @param {ConnectorReport} connector
 * @param {string} key
 * @param {HostState | null} state
 * @returns {{ title: string, panel: Panel } | null}
 */
function aiPage(connector, key, state) {
  const row = connector.processing?.rows.find(each => each.member === key && each.shape !== null) ?? null;
  const member = connector.members.find(each => each.key === key);
  if (!row || !member) return null;
  const act = row.shape === 'needs' && state ? { open: SETTINGS_PROVIDERS } : row.privacy?.waiting ? { open: SETTINGS_PRIVACY } : null;
  const level = row.privacy ? connector.members.find(each => each.key === row.privacy?.member) : null;
  const hiding = row.privacy && level ? memberRow(connector, level, state, { line: row.privacy.note }) : null;
  return { title: member.label, panel: panelOf({ rows: [
    { ...memberRow(connector, member, state, { line: row.line ?? '', mark: row.shape ? PROCESSING_MARKS[row.shape] : null, act }),
      label: AI_MODEL },
    ...hiding ? [{ ...hiding, label: hiding.label.startsWith(`${member.label}: `) ? upper(hiding.label.slice(member.label.length + 2))
      : hiding.label }] : []] }) };
}


/**
 * @param {ConnectorReport} connector
 * @param {MemberState} member
 * @param {HostState | null} state
 * @param {Opened} opened
 * @returns {Panel}
 */
function thingsPage(connector, member, state, opened) {
  const values = Array.isArray(member.value) ? member.value.map(String) : [];
  const key = `${connector.id}.${member.key}:`;
  const off = [...opened.kept].filter(each => each.startsWith(key)).map(each => each.slice(key.length))
    .filter(each => !values.includes(each));
  const rows = [...values, ...off].map(value => {
    const on = values.includes(value);
    return rowOf(value, { dim: !on, end: state ? { toggle: { on, label: value,
      do: setTo(connector, member.key, on ? values.filter(each => each !== value) : [...values, value]) } } : null });
  });
  const typed = opened.typed.trim();
  return panelOf({ lede: member.about ?? '', rows,
    add: state ? { placeholder: member.add ?? '', typed: opened.typed, finds: [], lit: 0,
      enter: typed && !values.includes(typed) ? setTo(connector, member.key, [...values, typed]) : null, end: null } : null });
}

const MODES = /** @type {const} */ ([['record', 'Record'], ['activity', 'Activity only'], ['exclude', 'Never']]);

/**
 * @param {string} typed
 * @returns {{ site: string } | { error: string }}
 */
export function siteOf(typed) {
  const raw = typed.trim().toLowerCase();
  let host = '';
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//u.test(raw) ? raw : `https://${raw}`).hostname;
  } catch { host = ''; }
  host = host.replace(/\.$/u, '').replace(/^www\./u, '');
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  const valid = host.length <= 253 && new RegExp(`^(?:${label}\\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$`, 'u').test(host);
  return valid ? { site: host } : { error: 'Type a site, like mybank.com.' };
}

export const APP_FINDS = 6;

/** @typedef {{ app?: string, site?: string, mode: 'activity' | 'exclude' }} ModeItem */

/**
 * @param {ModeItem[]} items
 * @param {{ app: string } | { site: string }} which
 * @param {'record' | 'activity' | 'exclude'} mode
 * @returns {ModeItem[]}
 */
export function withMode(items, which, mode) {
  const same = (/** @type {ModeItem} */ item) => 'app' in which ? item.app === which.app : item.site === which.site;
  const next = mode === 'record' ? null : { ...which, mode };
  const at = items.findIndex(same);
  if (at < 0) return next ? [...items, next] : items;
  return next ? items.map((item, index) => index === at ? next : item) : items.filter((_, index) => index !== at);
}

/**
 * @param {ConnectorReport} connector
 * @param {MemberState} member
 * @param {HostState | null} state
 * @param {Opened} opened
 * @returns {Panel}
 */
export function appsPage(connector, member, state, opened) {
  const items = /** @type {ModeItem[]} */ ((Array.isArray(member.value) ? member.value : [])
    .filter(item => item && typeof item === 'object' && (typeof item.app === 'string' || typeof item.site === 'string')
      && (item.mode === 'activity' || item.mode === 'exclude')));
  const offered = state?.apps?.offered ?? [];
  /** @param {string} id */
  const app = id => offered.find(each => each.id === id) ?? null;
  const named = items.filter(item => item.app && app(item.app))
    .map(item => ({ which: { app: /** @type {string} */ (item.app) }, mode: item.mode }));
  const rest = offered.filter(each => each.suggested && !items.some(item => item.app === each.id))
    .map(each => ({ which: { app: each.id }, mode: /** @type {'record'} */ ('record') }));
  const sites = items.filter(item => item.site).map(item => ({ which: { site: /** @type {string} */ (item.site) }, mode: item.mode }));
  const key = `${connector.id}.${member.key}:`;
  const back = [...opened.kept].filter(each => each.startsWith(key)).map(each => each.slice(key.length));
  const keptApps = back.filter(each => each.startsWith('app:')).map(each => each.slice(4))
    .filter(id => app(id) && !items.some(item => item.app === id) && !rest.some(each => each.which.app === id))
    .map(id => ({ which: { app: id }, mode: /** @type {'record'} */ ('record') }));
  const keptSites = back.filter(each => each.startsWith('rule:')).map(each => each.slice(5))
    .filter(site => !items.some(item => item.site === site))
    .map(site => ({ which: { site }, mode: /** @type {'record'} */ ('record') }));
  /** @param {ModeItem[]} list */
  const set = list => setTo(connector, member.key, list);
  const rows = [...named, ...keptApps, ...rest, ...sites, ...keptSites].map(({ which, mode }) => {
    const known = 'app' in which ? app(which.app) : null;
    const label = known ? known.name : /** @type {{ site: string }} */ (which).site;
    const words = MODES.find(([each]) => each === mode)?.[1] ?? 'Record';
    return rowOf(label, { lead: known ? { app: { name: known.name, src: known.icon } } : { icon: 'web' },
      end: !state ? { words } : { menu: { id: `${connector.id}.${member.key}.${'app' in which ? which.app : which.site}`,
        busy: settingKey(connector.id, member.key), label,
        words, find: '', date: null, choices: MODES.map(([each, said]) => ({ words: said, note: '', chosen: each === mode,
          default: each === 'record', do: set(withMode(items, which, each)) })) } } });
  });
  const typed = opened.typed.trim().toLowerCase();
  /** @type {Adding['finds']} */
  const finds = [];
  if (typed) {
    for (const each of offered) {
      if (finds.length >= APP_FINDS) break;
      const kept = items.find(item => item.app === each.id);
      if (kept?.mode !== 'exclude' && each.name.toLowerCase().includes(typed)) {
        finds.push({ name: each.name, lead: { app: { name: each.name, src: each.icon } },
          do: set(withMode(items, { app: each.id }, 'exclude')) });
      }
    }
    const site = siteOf(typed);
    if ('site' in site && !items.some(item => item.site === site.site && item.mode === 'exclude')) {
      finds.push({ name: site.site, lead: { icon: 'web' }, do: set(withMode(items, { site: site.site }, 'exclude')) });
    }
  }
  const privately = state?.apps?.private_windows === true;
  return panelOf({ rows,
    note: `Never: nothing is kept. Activity only: the app and the time, never the screen. ${privately
      ? 'Private windows and password fields are' : 'Password fields are'} never recorded.`,
    add: state ? { placeholder: member.add ?? '', typed: opened.typed, finds,
      lit: Math.min(Math.max(0, opened.lit), Math.max(0, finds.length - 1)), enter: null,
      end: { acts: [{ label: 'Other app…', variant: 'secondary', do: { host: { act: 'choose-app' },
        holds: { connector: connector.id, member: member.key } } }] } } : null });
}

/**
 * @param {StreamsReport} report
 * @returns {Panel | null}
 */
/**
 * @param {ConnectorReport} connector
 * @param {HostState | null} state
 * @returns {{ title: string, panel: Panel } | null}
 */
function signInPage(connector, state) {
  const routes = routesOf(connector, state);
  if (routes.length < 2) return null;
  return { title: 'Sign in', panel: panelOf({ rows: routes.map(route => rowOf(route.label, { line: route.about ?? '',
    end: { acts: [{ label: route.id === connector.route ? 'Change' : 'Connect', variant: 'secondary',
      do: routeAct(connector, route) }] } })) }) };
}

/**
 * @param {ConnectorReport} connector
 * @param {import('../../types.js').MemberState} member
 * @param {Opened} opened
 */
export const typedValue = (connector, member, opened) => opened.fields?.[`${connector.id}.${member.key}`]
  ?? (member.control !== 'secret' && typeof member.value === 'string' ? member.value : '');

/**
 * @param {ConnectorReport} connector
 * @param {Opened} opened
 * @returns {import('../../lib/host.js').HostAct[]}
 */
export function formActs(connector, opened) {
  /** @type {import('../../lib/host.js').HostAct[]} */
  const acts = formOf(connector).filter(typed).flatMap(member => {
    const value = typedValue(connector, member, opened);
    /** @type {import('../../lib/host.js').HostAct[]} */
    const sent = member.control !== 'secret' ? [{ act: 'setting', connector: connector.id, member: member.key, value: value.trim() }]
      : member.held === true && value === '' ? [] : [{ act: 'seal', connector: connector.id, member: member.key, value }];
    return sent;
  });
  return connector.account ? acts : [...acts, { act: 'turn', sources: [connector.id], on: true }];
}

/**
 * @param {Opened} opened
 * @param {{ pressed: number, now: number, refused: string | null }} answer
 * @returns {{ opened: Opened, back: boolean }}
 */
export function formAnswered(opened, { pressed, now, refused }) {
  if (pressed !== now) return { opened, back: false };
  if (refused !== null) return { opened: { ...opened, refused }, back: false };
  return { opened: { ...opened, fields: {} }, back: opened.pages.at(-1) === 'form' };
}

/**
 * @param {ConnectorReport} connector
 * @param {HostState | null} state
 * @param {Opened} opened
 * @returns {{ title: string, line: string, panel: Panel, foot: NonNullable<Detail['foot']>, callout: Callout | null, signin: SignIn } | null}
 */
export function formPage(connector, state, opened) {
  const members = formOf(connector);
  if (!state || !members.length) return null;
  const fields = members.filter(typed);
  const kept = (/** @type {MemberState} */ member) => member.control === 'secret' && member.held === true;
  const filled = fields.every(member => kept(member) || typedValue(connector, member, opened).trim() !== '');
  const blamed = fields.findLast(member => member.control === 'secret') ?? fields.at(-1);
  const secret = fields.some(member => member.control === 'secret');
  const words = connector.account ? { title: 'Account', button: 'Save' }
    : { title: `Connect ${connector.name}`, button: `Connect ${connector.name}` };
  const rows = members.filter(member => !typed(member)).map(member => memberRow(connector, member, state));
  return { title: words.title, line: connector.gives, panel: panelOf({ rows }),
    signin: { steps: connector.before.map(line => ({ title: line, line: '', open: null })),
      last: secret ? 'Paste it here' : 'Type it here', rows,
      fields: fields.map(member => ({ key: `${connector.id}.${member.key}`, label: member.label,
        kind: /** @type {SignInField['kind']} */ (member.control), value: typedValue(connector, member, opened),
        placeholder: kept(member) ? 'Kept. Type a new one to change it.' : fieldHint(connector, member),
        why: member === blamed ? opened.refused ?? '' : '', note: member.control === 'secret' ? DETAIL.signInNote : '' })) },
    foot: { start: null, end: [{ label: words.button, variant: 'primary', disabled: !filled, do: { form: connector.id } }] },
    callout: null };
}

/**
 * @param {ConnectorReport} connector
 * @param {string} page
 * @param {HostState | null} state
 * @param {Opened} opened
 * @returns {{ title: string, line?: string, panel: Panel, panels?: Panel[], foot?: NonNullable<Detail['foot']>, callout?: Callout | null, signin?: SignIn } | null}
 */
function pageOfStream(connector, page, state, opened) {
  if (page === 'signin') return signInPage(connector, state);
  if (page === 'form') return formPage(connector, state, opened);
  if (page.startsWith(AI_PAGE)) return aiPage(connector, page.slice(AI_PAGE.length), state);
  if (page.startsWith(MODEL_PAGE)) return modelPage(connector, page.slice(MODEL_PAGE.length), state, opened);
  const every = page === 'copies' ? sourceRows(connector, state) : [];
  if (every.length > COPIES_SHOWN + 1) return { title: 'Comes from', panel: panelOf({ rows: every }) };
  const member = page.startsWith('list:')
    ? connector.members.find(each => each.key === page.slice('list:'.length) && each.kind === 'list') : undefined;
  if (!member) return null;
  return { title: member.label, panel: member.items === 'modes' ? appsPage(connector, member, state, opened)
    : thingsPage(connector, member, state, opened) };
}


/**
 * @param {ConnectorReport} connector
 * @param {HostState | null} state
 * @returns {NonNullable<Detail['connect']>}
 */
function connectOf(connector, state) {
  const ways = connector.ways.map((way, at) => {
    const first = way.requirements.findIndex(requirement => !requirement.met);
    return { label: at === 0 ? 'To connect' : 'Or', rows: way.requirements.map((requirement, index) => ({
      id: `${way.road}:${requirement.kind}:${index}`, name: requirement.words, line: requirement.line ?? '',
      mark: /** @type {Requirement['mark']} */ (requirement.met ? 'done' : index === first ? 'here' : 'idle'),
      act: index === first && requirement.act ? actsOf([requirement.act], connector, state)[0] ?? null : null })) };
  });
  const { before } = connector;
  return { ways, notes: before.length > 1 ? before.map((line, at) => `${at + 1}. ${line}`) : before };
}

/**
 * @param {ConnectorReport} connector
 * @returns {Progress | null}
 */
function progressOf(connector) {
  const { history } = connector;
  if (history?.state !== 'syncing') return null;
  return { label: DETAIL.reading, done: history.progress ?? '',
    share: history.done === null || !history.total ? null : history.done / history.total,
    line: `${history.words}. ${upper(DETAIL.closeable)}` };
}

/**
 * @param {ConnectorReport} connector
 * @param {StreamsReport} report
 * @param {HostState | null} state
 * @param {Opened} opened
 * @returns {Detail}
 */
function streamDetail(connector, report, state, opened) {
  const comes = comesFrom(connector, state);
  const settings = settingsOf(connector, state);
  const groups = groupsOf(connector, state);
  const ai = aiOf(connector, state, opened.dated ?? null);
  const backfill = backfillOf(connector, report, state);
  const ask = `off:${connector.id}`;
  const running = state !== null && connector.set_up && connector.copies.length > 0;
  const own = connector.shown === 'home';
  const off = running && !own && connector.copies.some(copy => copy.on);
  const connect = connector.set_up ? null : connectOf(connector, state);
  const standing = healthCallout(connector.health, connector, state);
  const callout = standing && connect?.ways.some(way => way.rows.some(row => row.name === standing.title)) ? null : standing;
  const held = connector.callout.map(need => saidCallout(need, connector, state));
  const progress = connector.set_up ? progressOf(connector) : null;
  const counted = progress ? null : figureOf(connector.figure, connector.noun, report.day);
  const last = connector.figure?.last ?? '';
  const said = connector.set_up ? [wholeLine(connector), last].filter(Boolean).join(' · ') : connector.gives;
  const merged = settings || groups ? panelOf({ label: DETAIL.settings, rows: [...settings?.rows ?? [], ...groups?.rows ?? []] }) : null;
  const head = headOf(connector.name, said, true, counted, [comes, merged, ai, backfill]);
  const words = disconnectWords(connector.name, connector.noun);
  return {
    id: connector.id, icon: connector.icon, name: connector.name, line: head.line,
    state: connector.health.state, callout, held, connect, figure: head.figure, parts: [], progress,
    panels: connect ? [] : head.panels.filter(panel => panel !== null),
    reads: connector.set_up || connector.records !== connector.gives ? connector.records : '',
    where: connect ? connector.where ?? '' : '',
    page: true,
    back: null,
    foot: running ? { start: off ? { label: DETAIL.disconnect, tone: 'warning', variant: 'plain', do: { ask } } : null,
      end: [pausing(connector)] } : state ? null : elsewhere(connector),
    confirm: off ? { ask, ...words,
      yes: { ...turn(DETAIL.disconnect, [connector.id], false), tone: 'warning', variant: 'primary' },
      no: { label: DETAIL.cancel, variant: 'secondary', do: { ask: '' } } } : null,
    reading: false, ticking: connector.health.next_ms !== null,
  };
}

const PHOTOS_LINE = /^\d[\d,]*\s+photos?\s*·\s*last\s+/iu;

/**
 * @param {string} name
 * @param {string} line
 * @param {boolean} status
 * @param {WeekFigure | null} figure
 * @param {(Panel | null)[]} panels
 * @returns {{ line: string, figure: WeekFigure | null, panels: (Panel | null)[] }}
 */
function headOf(name, line, status, figure, panels) {
  const latest = panels.flatMap(panel => panel?.rows ?? []).find(row => !row.signal && PHOTOS_LINE.test(row.line)) ?? null;
  const said = latest ? latest.line.replace(/\s*·\s*last\s+/iu, ' · Last added ') : line;
  const bare = latest && latest.label === name && !latest.end ? latest : null;
  const empty = figure?.today === 0 && Boolean(figure.week?.every(count => count === 0));
  const dated = empty && (latest !== null || (status && /\blast\b/iu.test(line)));
  return {
    line: dated && figure?.last ? `${said} · ${figure.last}` : said,
    figure: dated ? null : figure,
    panels: !latest ? panels : panels.map(panel => panel && { ...panel,
      rows: panel.rows.filter(row => row !== bare || panel.rows.length === 1).map(row => row === latest ? { ...row, line: '' } : row) }),
  };
}

/**
 * @param {ConnectorReport} connector
 * @returns {Detail['foot']}
 */
function elsewhere(connector) {
  const unsigned = connector.routes.length > 0 && connector.route === null;
  const settable = connector.members.some(member => member.panel !== null && member.control !== null) || connector.copies.length > 0;
  if (!unsigned && !settable) return null;
  return { start: null, end: [], note: unsigned ? `Sign in to ${connector.name} on your Mac or iPhone.`
    : `Change ${connector.name} in Lifestream on your Mac or iPhone.` };
}

/**
 * @param {StreamsReport | null} report
 * @param {HostState | null} state
 * @param {string} id
 * @param {Opened} [opened]
 * @returns {Detail | null}
 */
export function detailOf(report, state, id, opened = OPENED) {
  if (id.startsWith(IMPORT)) return report ? importDetail(report, state, id, opened) : null;
  const owner = report?.connectors.find(each => each.id === id && each.shown !== null) ?? null;
  if (!report || !owner) return null;
  let detail = streamDetail(owner, report, state, opened);
  for (const page of opened.pages) {
    const back = { label: `Back to ${detail.name}` };
    const inside = pageOfStream(owner, page, state, opened);
    if (!inside) break;
    detail = { id, icon: owner.icon, name: inside.title, line: inside.line ?? owner.name, state: null, callout: inside.callout ?? null,
      figure: null, signin: inside.signin ?? null,
      parts: [], panels: [inside.panel, ...inside.panels ?? []], page: detail.page, back, foot: inside.foot ?? null, confirm: null,
      reading: false, ticking: detail.ticking };
  }
  return detail;
}
