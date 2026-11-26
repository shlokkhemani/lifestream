// @ts-check
/** @import { SettingsEnd, SettingsPage, SettingsPart, SettingsRow } from '../../pages.js' */
/** @import { DetailPart, End, PanelRow } from './dialog.js' */
/** @import { HostAct } from '../../lib/host.js' */
/** @import { SignalKind } from '../kit/signal.js' */
import { phraseOf } from '../../lib/words.js';
import { STATE_LOOKS } from '../kit/connector-row.js';
import { rowOf } from './dialog.js';
import { homeSettingKey } from './pending.js';
import { part } from './settings-pages.js';

export const WORDS = {
  unread: 'Your settings couldn’t be read.',
  notHere: 'Your settings aren’t on this Mac yet.',
};

const MOBILE_DATA = /^devices\.[^.]+\.mobile_data$/u;

/**
 * @param {string} key
 * @returns {key is `devices.${string}.mobile_data`}
 */
const mobileDataKey = key => MOBILE_DATA.test(key);

/**
 * @param {Extract<SettingsEnd, { kind: 'choice' | 'pick' }>} end
 * @returns {HostAct[] | null}
 */
function actsOf(end) {
  if (end.kind === 'choice' && end.key === 'model.cap') {
    const { key } = end;
    return end.choices.map(each => ({ act: 'home-setting', key, value: each.value }));
  }
  if (end.kind === 'pick' && mobileDataKey(end.key)) {
    const { key } = end;
    return end.choices.map(each => ({ act: 'home-setting', key, value: each.value }));
  }
  return null;
}

/**
 * @param {Extract<SettingsEnd, { kind: 'choice' | 'pick' }>} end
 * @param {boolean} home
 * @param {string} label
 * @param {string} id
 * @returns {End}
 */
function menuOf(end, home, label, id) {
  const words = end.choices.find(each => each.chosen)?.words ?? '';
  const acts = home ? actsOf(end) : null;
  if (acts === null) return { words };
  return { menu: { id: `settings.${id}`, busy: homeSettingKey(end.key), label, words, find: '', date: null,
    choices: end.choices.map((each, at) => ({ words: each.words, note: '', chosen: each.chosen, default: each.default,
      do: { host: acts[at] } })) } };
}

/**
 * @param {SettingsRow} row
 * @param {boolean} home
 * @returns {PanelRow}
 */
function rowOfAnswer({ id, label, line, end }, home) {
  const said = { line: line ?? '' };
  if (end?.kind === 'value') {
    /** @type {SignalKind | null} */
    const signal = end.signal ? STATE_LOOKS[end.signal] ?? null : null;
    return rowOf(label, { ...said, signal, end: { words: phraseOf(end.value) } });
  }
  if (end?.kind === 'choice' || end?.kind === 'pick') return rowOf(label, { ...said, end: menuOf(end, home, label, id) });
  return rowOf(label, said);
}

/**
 * @param {SettingsPart} each
 * @param {boolean} home
 * @returns {DetailPart}
 */
const partOf = ({ label, line, rows }, home) => part({ label: label ?? '', line: line ?? '', rows: rows.map(row => rowOfAnswer(row, home)) });

/**
 * @param {SettingsPage} answer
 * @param {boolean} home
 * @returns {DetailPart[]}
 */
export const answerParts = (answer, home) => answer.parts.map(each => partOf(each, home));
