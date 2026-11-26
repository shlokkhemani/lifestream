// @ts-check
/** @import { DeviceRow, StreamsReport, State } from '../../types.js' */
/** @import { Storage } from './settings-storage.js' */
/** @import { HostAct, HostCommand, HostState } from '../../lib/host.js' */
/** @import { DetailPart, End, Opened, Panel, PanelRow } from './dialog.js' */
/** @import { Act, Do } from './words.js' */
/** @import { SignalKind } from '../kit/signal.js' */
import { today } from '../../lib/home-clock.js';
import { reachWord } from '../../lib/reach.js';
import { dateWords } from '../../lib/words.js';
import { STATE_LOOKS } from '../kit/connector-row.js';
import { panelOf, rowOf } from './dialog.js';
import { actsOf } from './page.js';
import { allow, needAct } from './words.js';

/** @typedef {{ report: StreamsReport | null, state: HostState | null, answering: boolean, home: boolean, opened: Opened, theme: 'system' | 'light' | 'dark' }} Reach */

/**
 * @param {{ label?: string, line?: string, rows: PanelRow[], add?: Panel['add'], acts?: Act[], note?: string, id?: string }} part
 * @returns {DetailPart}
 */
export const part = ({ label = '', line = '', rows, add = null, acts = [], note = '', id }) => ({ label, lines: line ? [line] : [],
  panel: panelOf({ rows, add, note }), acts, ...id ? { id } : {} });

/**
 * @param {Panel} panel
 * @returns {DetailPart}
 */
export const panelPart = panel => ({ label: panel.label, lines: [], panel, acts: [] });

/**
 * @param {HostAct} act
 * @returns {Do}
 */
const asking = act => ({ host: act });

/**
 * @param {boolean} on
 * @param {string} label
 * @param {HostAct | null} act
 * @returns {End}
 */
const switchOf = (on, label, act) => act ? { toggle: { on, label, do: asking(act) } } : { words: on ? 'On' : 'Off' };

/**
 * @param {State} state
 * @returns {SignalKind | null}
 */
const signalOf = state => STATE_LOOKS[state] ?? null;

/**
 * @param {StreamsReport} report
 * @param {DeviceRow} device
 * @returns {PanelRow[]}
 */
export const deviceStreams = (report, device) => device.streams.flatMap(stream => {
  const connector = report.connectors.find(each => each.id === stream.id);
  return connector ? [rowOf(connector.name, { line: stream.line, go: { do: { open: connector.id, push: true }, value: '' } })] : [];
});


export const STATUS_UNREAD = 'Lifestream’s status couldn’t be read.';

/**
 * @param {Reach} reach
 * @returns {PanelRow}
 */
function statusRow({ report, state, answering }) {
  const word = reachWord(state?.reach);
  if (word) return rowOf('Status', { line: word.word, signal: word.signal });
  if (!answering || !report) return rowOf('Status', { line: STATUS_UNREAD, signal: 'warning' });
  const { health } = report.home;
  const words = health.state !== 'ok' ? health.words
    : health.words.startsWith('Checked ') ? `Running · checked ${health.words.slice('Checked '.length)}`
      : ['Running', health.words].filter(Boolean).join(' · ');
  const acts = actsOf(health.acts, null, state);
  return rowOf('Status', { line: words, signal: signalOf(health.state), end: acts.length ? { acts } : null });
}

/**
 * @param {Reach} reach
 * @returns {DetailPart[]}
 */
export function homeParts(reach) {
  const { report, state, home } = reach;
  const paused = report?.paused.some(pause => pause.target === 'home') === true;
  const rows = [statusRow(reach)];
  if (state?.sending) rows.push(rowOf('This Mac', { line: state.sending, signal: 'caution' }));
  if (report) {
    rows.push(rowOf('Pause Lifestream', { line: 'Stops everything Lifestream does until you resume. New data from your devices is kept and waits.',
      end: switchOf(paused, 'Pause Lifestream', home ? paused ? { act: 'resume', target: 'home' } : { act: 'pause', target: 'home' } : null) }));
  }
  if (state?.folder) {
    rows.push(rowOf('Activity log', { line: 'Everything Lifestream did, line by line.',
      end: { acts: [{ label: 'Open log', variant: 'secondary', do: asking({ act: 'open', what: 'home-log' }) }] } }));
  }
  const others = report?.paused.filter(pause => pause.target !== 'home') ?? [];
  return [part({ rows }), ...others.length ? [part({ label: 'Paused right now', line: 'Each pause stays until you resume it.',
    rows: others.map(pause => rowOf(pause.title, { line: pause.line, end: home ? { acts: [{ label: 'Resume', variant: 'plain',
      do: asking({ act: 'resume', target: pause.target }) }] } : null })) })] : []];
}

/**
 * @param {Reach} reach
 * @param {Storage['keep'] | null} keep
 * @returns {DetailPart[]}
 */
export function storageParts({ state }, keep) {
  /** @type {PanelRow[]} */
  const rows = [];
  if (state?.folder) {
    rows.push(rowOf('Folder', { line: state.folder, end: { acts: [{ label: 'Show in Finder', variant: 'secondary',
      do: asking({ act: 'open', what: 'home-folder' }) }] } }));
  }
  if (keep !== null) rows.push(rowOf(keep.label, { line: keep.line, end: { words: keep.size } }));
  return [part({ label: 'Location', rows })];
}

/**
 * @param {HostState} state
 * @returns {PanelRow[]}
 */
export function recoveryRows(state) {
  const vault = state.vault;
  /** @param {string} words @param {string} label @param {'open' | 'unlock'} does @param {boolean} [done] */
  const key = (words, label, does, done = false) => [rowOf('Recovery key', {
    line: vault?.keyed ? 'Opens everything Lifestream keeps if you move Lifestream to another Mac, or lose this one.'
      : 'Unlocks your saved sign-ins and keys if you move Lifestream to another Mac, or lose this one.',
    end: { words, done, acts: [{ label, variant: 'secondary', do: asking({ act: 'vault', do: does }) }] } })];
  switch (vault?.state) {
    case 'none': return key('No vault yet', 'Create…', 'open');
    case 'unsaved': return key('Not saved', 'Show a new key…', 'open');
    case 'saved': return key(vault.saved_ms === null ? 'Saved' : `Saved on ${dateWords(vault.saved_ms, { weekday: false })}`,
      'Make a new key…', 'open', true);
    case 'locked': return key('Locked on this Mac', 'Allow', 'unlock');
    case 'lost': return key('Locked on this Mac', 'Unlock…', 'unlock');
    default: return [];
  }
}


/**
 * @param {StreamsReport | null} report
 * @returns {DeviceRow[]}
 */
export const macsOf = report => (report?.devices ?? []).filter(device => device.kind === 'mac' && !device.retired);

/**
 * @param {HostCommand} command
 * @returns {PanelRow[]}
 */
export function commandRows(command) {
  /** @type {Act[]} */
  const acts = command.state === 'installed' ? [{ label: 'Remove', variant: 'secondary', do: asking({ act: 'general-command', do: 'remove' }) }]
    : command.state === 'absent' ? [{ label: 'Install', variant: 'secondary', do: asking({ act: 'general-command', do: 'install' }) }] : [];
  return [
    rowOf('Command line', { line: command.words, end: acts.length ? { acts } : null }),
    rowOf('Agent prompt', { line: command.prompt, end: { copy: { value: command.prompt, label: 'agent prompt' } } }),
  ];
}

/**
 * @param {Reach} reach
 * @returns {DetailPart[]}
 */
export function thisMacParts({ report, state, home }) {
  const macs = macsOf(report);
  const own = macs.find(device => device.unit === state?.unit) ?? null;
  /** @param {DeviceRow} mac */
  const named = mac => rowOf('Name', { line: `How ${mac === own || macs.length === 1 ? 'this Mac' : 'it'} appears in Lifestream and on your other devices.`,
    end: { words: mac.name, acts: home ? [{ label: 'Rename…', variant: 'secondary', do: { page: `rename:${mac.unit}` } }] : [] } });
  const login = state?.general ? [rowOf('Open at login', { line: 'So this Mac records and syncs after a restart.',
    end: switchOf(state.general.login, 'Open at login', { act: 'general-login', on: !state.general.login }) }),
  ...state.general.command ? commandRows(state.general.command) : []] : [];
  const several = macs.length > 1 || (state !== null && !own && macs.length > 0);
  /**
   * @param {DeviceRow} mac
   * @returns {DetailPart[]}
   */
  const macParts = mac => {
    const streams = report ? deviceStreams(report, mac) : [];
    const ill = mac.health.state === 'ok' || mac.health.state === 'syncing' ? '' : mac.health.words;
    const line = streams.some(row => row.line === ill) ? '' : ill;
    const rows = [named(mac), ...mac === own ? login : []];
    return several ? [part({ label: mac.name, line, id: mac.unit, rows: [...rows, ...streams] })]
      : [part({ line, id: mac.unit, rows }), part({ label: 'Records', line: 'Each opens its connector.', rows: streams })];
  };
  const first = own ?? (several ? null : macs[0] ?? null);
  /** @type {DetailPart[]} */
  const parts = first ? macParts(first) : login.length ? [part({ label: several ? 'This Mac' : '', rows: login })] : [];
  if (state) {
    const missing = state.grants.filter(grant => !grant.granted && !grant.optional);
    parts.push(part({ label: 'Permissions', acts: missing.length > 1 ? [{ ...allow(missing, 'Allow all'), variant: 'secondary' }] : [],
      rows: state.grants.map(grant => rowOf(grant.title, { line: grant.why,
        end: grant.granted ? { words: 'Allowed' } : { words: grant.optional ? 'Optional' : '', acts: [{ ...allow([grant], 'Allow'), variant: 'secondary' }] } })) }));
    parts.push(part({ label: 'Uninstall', rows: [rowOf('Uninstall Lifestream', {
      line: 'Removes the app from this Mac. Lifestream is kept unless you choose to erase it.',
      end: { acts: [{ label: 'Uninstall…', variant: 'secondary', tone: 'warning', do: asking({ act: 'uninstall' }) }] } })] }));
  }
  return [...parts, ...macs.filter(mac => mac !== first).flatMap(macParts)];
}

/** @param {StreamsReport | null} report */
export const phonesOf = report => (report?.devices ?? []).filter(device => device.kind === 'phone');

/**
 * @param {DeviceRow} device
 * @param {StreamsReport} report
 * @param {Reach} reach
 * @returns {DetailPart}
 */
export function deviceDetail(device, report, { state, home }) {
  const acts = home ? actsOf(device.health.acts, null, state) : [];
  const ask = `retire:${device.unit}`;
  const remove = home ? [rowOf('This iPhone', { line: 'It stops recording once it has synced what it holds.',
    end: { acts: [{ label: 'Remove', variant: 'plain', do: { ask } }] },
    confirm: { ask, question: `Remove ${device.name}?`,
      detail: 'It stops recording once it has synced what it holds. Its history stays in Lifestream.',
      yes: { label: 'Remove phone', tone: 'warning', variant: 'primary', do: asking({ act: 'retire-phone', unit: device.unit }) },
      no: { label: 'Not now', variant: 'plain', do: { ask: '' } } } })] : [];
  return part({ label: device.name, id: device.unit, rows: [
    rowOf('Status', { line: device.health.words, signal: signalOf(device.health.state),
      end: acts.length ? { acts: acts.map(act => ({ variant: 'secondary', ...act })) } : null }),
    ...deviceStreams(report, device), ...remove] });
}

/**
 * @param {Reach} reach
 * @returns {DetailPart[]}
 */
export function phoneParts(reach) {
  const { report, state, home } = reach;
  if (!report) return [];
  const phones = phonesOf(report);
  const paired = phones.filter(phone => !phone.retired);
  const removed = phones.filter(phone => phone.retired);
  const pair = [state && home ? rowOf('Pair an iPhone', { line: 'Shows a code the iPhone app scans. It works only while it is shown.',
    end: { acts: [{ label: 'Show code', variant: 'secondary', do: { flow: 'phone' } }] } })
    : rowOf('Pair an iPhone', { line: 'On the Mac that holds Lifestream, in the Lifestream app.' })];
  return [
    ...paired.map(phone => deviceDetail(phone, report, reach)),
    paired.length ? part({ label: 'Add an iPhone', rows: pair })
      : part({ line: 'No iPhone paired.', rows: pair }),
    part({ label: 'Removed', rows: removed.map(phone => rowOf(phone.name, { line: 'Its history stays in Lifestream.' })) }),
  ];
}

/**
 * @param {Reach} reach
 * @returns {DetailPart[]}
 */
export function chromeParts({ report, home }) {
  if (!report) return [];
  const { extension } = report;
  /** @type {PanelRow[]} */
  const rows = extension.browsers.map(name => rowOf(name, { line: extension.health.words,
    signal: signalOf(extension.health.state) }));
  if (home) {
    rows.push(extension.present
      ? rowOf('Connect another browser', { line: 'Another Chrome profile, or Chrome on another Mac.',
        end: { acts: [{ label: 'Connect', variant: 'secondary', do: { flow: 'browser' } }] } })
      : rowOf('Add to Chrome', { line: 'Reads the sites you choose in your own signed-in Chrome.',
        end: { acts: [{ label: 'Add to Chrome', variant: 'secondary', do: { flow: 'browser' } }] } }));
  } else if (!rows.length) rows.push(rowOf(extension.name, { line: extension.health.words, signal: signalOf(extension.health.state) }));
  const reads = report.connectors.filter(each => each.shown === 'stream' && each.roads.includes('chrome'))
    .map(connector => rowOf(connector.name, { line: connector.health.words, signal: signalOf(connector.health.state),
      go: { do: { open: connector.id, push: true }, value: '' } }));
  return [part({ rows }), part({ label: 'Reads in Chrome', line: 'Sites the extension reads in your own signed-in Chrome. Each opens its connector.',
    rows: reads })];
}



/**
 * @param {Reach} reach
 * @returns {DetailPart[]}
 */
export const appearanceParts = ({ theme }) => [part({ rows: [rowOf('Theme', { end: { segmented: { label: 'Theme',
  choices: /** @type {const} */ ([['system', 'System'], ['light', 'Light'], ['dark', 'Dark']])
    .map(([value, words]) => ({ value, words, chosen: value === theme, do: { theme: value } })) } } })] })];

/**
 * @param {HostState} state
 * @returns {DetailPart[]}
 */
export function updatesParts(state) {
  const { general, update } = state;
  if (!general) return [];
  if (general.by_hand) return [part({ rows: [rowOf('Version', { line: general.by_hand, end: { words: general.version } })] })];
  const waiting = update?.acts[0] ? update : null;
  /** @type {Act} */
  const act = waiting ? { ...needAct(waiting, waiting.acts[0]), tone: 'neutral', variant: 'secondary' }
    : { label: 'Check for Updates…', variant: 'secondary', do: asking({ act: 'general-check' }) };
  return [part({ rows: [
    rowOf('Version', { line: general.update ?? waiting?.line ?? '', end: { words: general.version, acts: [act] } }),
    rowOf('Install updates automatically', { line: 'Lifestream restarts into an update while your screen is locked.',
      end: switchOf(general.auto_update, 'Install updates automatically', { act: 'general-auto-update', on: !general.auto_update }) }),
  ] })];
}
