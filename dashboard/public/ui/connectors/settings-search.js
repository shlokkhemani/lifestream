// @ts-check
/** @import { HostAct, MeaningWrite } from '../../lib/host.js' */
/** @import { DetailPart, End, PanelRow } from './dialog.js' */
/** @import { Do } from './words.js' */
import { freeWords } from '../../lib/words.js';
import { rowOf } from './dialog.js';
import { homeSettingKey } from './pending.js';
import { part } from './settings-pages.js';

/** @typedef {{ as_of: string | null, building: { done: number, of: number } | null }} IndexState */

/** @typedef {{ record: IndexState, screen: IndexState & ScreenState }} SearchState */

/** @typedef {{ words: string, line: string | null, chosen: boolean }} Picked */

/** @typedef {{ power: 'plugged-idle', words_indexed_through: string | null, bytes: number, vectors_bytes: number, queued: number, waits: string | null, waits_line: string | null, embedded: number, named: number, skipped: number }} ScreenState */

export const MEANING_POWER = { key: /** @type {const} */ ('search.meaning.power'), id: /** @type {const} */ ('plugged-idle'),
  words: 'Only when plugged in and idle' };

export const MEANING_LINE = 'Finds moments on your screen by what they were about, not only by their words. Word search works either way.';

/** @param {HostAct} act @returns {Do} */
const asking = act => ({ host: act });

/** @param {number} bytes */
const sizeWords = bytes => freeWords(bytes).replace(/ free$/u, '');

export const MEANING_BUSY = homeSettingKey(MEANING_POWER.key);

/**
 * @param {boolean} acts
 * @returns {End}
 */
function powerChoice(acts) {
  const { words } = MEANING_POWER;
  if (!acts) return { words };
  /** @type {MeaningWrite} */
  const settings = { [MEANING_POWER.key]: MEANING_POWER.id };
  return { menu: { id: `settings.${MEANING_POWER.key}`, busy: MEANING_BUSY, label: 'When it runs', words, find: '', date: null,
    choices: [{ words, note: '', chosen: true, default: true, do: asking({ act: 'home-setting', settings }) }] } };
}

/** @param {ScreenState} state */
const screenTexts = state => state.embedded + state.queued + state.skipped;

/** @param {ScreenState} state */
export const meaningShare = state => {
  const texts = screenTexts(state);
  return texts > 0 ? Math.floor(Math.min(1, state.embedded / texts) * 100) : 0;
};

/**
 * @param {ScreenState} state
 * @returns {PanelRow}
 */
function reachedRow(state) {
  const texts = screenTexts(state);
  const caught = texts > 0 && state.queued === 0;
  const all = caught && state.skipped === 0;
  const skipped = state.skipped > 0 ? ` ${state.skipped.toLocaleString('en-US')} could not be read.` : '';
  const line = (state.waits_line ? `${state.waits_line.replace(/\.$/u, '')}.`
    : caught ? 'Caught up with your screen.'
      : texts ? 'It reads when this Mac is plugged in and idle.' : 'It starts once this Mac has recorded your screen.') + skipped;
  const share = meaningShare(state);
  return rowOf('Searchable', { line, end: all ? { words: 'All of your screen', done: true } : null,
    progress: all || !texts ? null
      : { label: 'Searchable so far', share: share / 100, words: `${share}% of your screen, newest first` } });
}

/**
 * @param {{ state: ScreenState | null, failed: boolean, acts: boolean, model: Picked | null, choose: Do }} read
 * @returns {{ parts: DetailPart[], reading: boolean }}
 */
export function meaningParts({ state, failed, acts, model, choose }) {
  if (!state) return { parts: [], reading: !failed };
  const on = model?.chosen === true;
  const settings = part({ rows: [
    rowOf('Model', { tag: 'Runs on a Mac only', line: model?.line ?? MEANING_LINE,
      end: { words: model?.words ?? 'Off', acts: acts ? [{ label: on ? 'Change' : 'Choose', variant: 'secondary', do: choose }] : [] } }),
    rowOf('When it runs', { line: 'So it never slows you down or spends your battery.', end: powerChoice(acts) }),
  ] });
  if (!on) return { parts: [settings], reading: false };
  /** @type {PanelRow[]} */
  const rows = [
    reachedRow(state),
    rowOf('On disk', { line: 'What meaning search keeps beside your screen’s words.', end: { words: sizeWords(state.vectors_bytes) } }),
  ];
  return { parts: [settings, part({ label: 'Progress', rows })], reading: false };
}
