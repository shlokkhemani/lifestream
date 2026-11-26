// @ts-check
/** @import { PhrasePart, SettingsEnd, SettingsPage, SettingsPart, SettingsRow, When } from '../../pages.js' */
/** @import { DetailPart, End, PanelRow } from './dialog.js' */
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


const HOST_KEYS = /** @type {const} */ (['model.cap']);

/**
 * @param {string} key
 * @returns {key is typeof HOST_KEYS[number]}
 */
const hostSets = key => HOST_KEYS.some(each => each === key);

/**
 * @param {typeof HOST_KEYS[number]} key
 * @param {Extract<SettingsEnd, { kind: 'choice' }>['choices']} choices
 * @param {string} label
 * @param {string} id
 * @returns {End}
 */
const menuOf = (key, choices, label, id) => ({ menu: { id: `settings.${id}`, busy: homeSettingKey(key), label,
  words: choices.find(each => each.chosen)?.words ?? '', find: '', date: null,
  choices: choices.map(each => ({ words: each.words, note: '', chosen: each.chosen, default: each.default,
    do: { host: { act: 'home-setting', key, value: each.value } } })) } });

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
  if (end?.kind === 'choice') {
    const { key, choices } = end;
    return rowOf(label, { ...said, end: home && hostSets(key) ? menuOf(key, choices, label, id)
      : { words: choices.find(each => each.chosen)?.words ?? '' } });
  }
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
