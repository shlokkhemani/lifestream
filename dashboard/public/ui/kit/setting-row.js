// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { boldRuns } from './bold-line.js';
import { icon } from './icon.js';
import { signalShape } from './signal.js';
import { tip } from './tip.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */
/** @typedef {import('./signal.js').SignalKind} SignalKind */
/** @typedef {import('./bold-line.js').Bolded} Bolded */

/**
 * @typedef {object} SettingRow
 * @property {string} label
 * @property {string} [lead]
 * @property {string} [tag]
 * @property {string} [about]
 * @property {string} [line]
 * @property {boolean} [working]
 * @property {string} [tail]
 * @property {'warning' | 'caution' | ''} [tone]
 * @property {string} [does]
 * @property {string} [mark]
 * @property {SignalKind | null} [signal]
 * @property {boolean} [pulse]
 * @property {Attributes | null} [act]
 * @property {string[]} [waiting]
 * @property {string} [only]
 * @property {string} [holds]
 * @property {string} [end]
 * @property {boolean} [dim]
 * @property {{ value: string, attrs: Attributes, time?: string } | null} [go]
 * @property {Attributes | null} [open]
 * @property {boolean} [asking]
 * @property {RowHold | null} [hold]
 * @property {Attributes} [attrs]
 */

/**
 * @param {SettingRow} row
 * @param {{ menu?: boolean }} [options]
 */
export function settingRowParts({ label, lead = '', tag = '', about = '', line = '', working = false, tail = '', tone = '', does = '', mark = '', signal = null,
  pulse = false, act = null, waiting = [], only = '', holds = '', dim = false, go = null, open = null, asking = false, hold = null,
  attrs = {} }, { menu = false } = {}) {
  const faces = hold?.faces ?? [];
  const holding = Boolean(holds) || faces.some(face => face.holds);
  const { class: own, ...rest } = attrs;
  const classes = [...new Set(['ck-srow', line || does || faces.length ? '' : 'ck-srow--short',
    lead ? 'ck-srow--lead' : '', holding ? 'ck-srow--holds' : '', dim ? 'is-dim' : '', go || menu ? 'ck-srow--go' : '',
    menu ? 'ck-srow--menu' : '', tone ? `ck-srow--${tone}` : '',
    asking ? 'is-asking' : '', ...String(own ?? '').split(/\s+/u)].filter(Boolean))].join(' ');
  const leading = lead ? `<span class="ck-srow__lead" aria-hidden="true">${lead}</span>` : '';
  const shapeOf = (/** @type {SignalKind | null | undefined} */ kind, beats = false) => kind ? signalShape(kind, { pulse: beats })
    : mark ? `<span class="ck-srow__mark" aria-hidden="true">${mark}</span>` : '';
  const said = !line ? '' : act ? `<button${attributes({ type: 'button', class: 'ck-srow__line ck-srow__act', ...act })}>${shapeOf(signal, pulse)}${esc(line)}</button>`
    : tail ? `<span class="ck-srow__line">${shapeOf(signal, pulse)}<span class="ck-srow__said">${esc(line)}</span><span class="ck-srow__tail"> · ${esc(tail)}</span></span>`
    : `<span class="ck-srow__line">${shapeOf(signal, pulse)}${working ? `<span class="ck-shimmer">${esc(line)}</span>` : esc(line)}</span>`;
  const quiet = (waiting.length > 0 ? waiting : only ? [only] : [])
    .map(each => `<span class="ck-srow__wait">${esc(each)}</span>`).join('');
  const heldOf = (/** @type {string} */ markup) => markup ? `<span class="ck-srow__holds">${markup}</span>` : '';
  const shown = (does ? `<span class="ck-srow__line">${esc(does)}</span>` : '') + said + quiet + heldOf(holds);
  const under = faces.length === 0 ? shown : `<span class="ck-srow__faces"><span class="ck-srow__face">${shown}</span>`
    + faces.map(face => '<span class="ck-srow__face ck-held" aria-hidden="true" inert>'
      + `<span class="ck-srow__line">${shapeOf(face.signal)}${esc(face.line)}</span>${heldOf(face.holds ?? '')}</span>`).join('')
    + '</span>';
  const main = '<span class="ck-srow__main">'
    + `<span class="ck-srow__top">${open ? `<button${attributes({ type: 'button', class: 'ck-srow__label ck-srow__open', ...open })}>`
      + `${esc(label)}${icon('forward', { size: 'xs' })}</button>` : `<span class="ck-srow__label">${esc(label)}</span>`}`
    + `${tag ? `<span class="ck-srow__tag">${esc(tag)}</span>` : ''}${about ? tip({ label, text: about }) : ''}</span>`
    + under + '</span>';
  return { item: attributes({ class: classes, ...rest }), leading, main };
}

/** @param {SettingRow} row */
export function settingRow(row) {
  const { label, end = '', go = null, hold = null } = row;
  const { item, leading, main } = settingRowParts(row);
  if (go) {
    return `<li${item}><button${attributes({ type: 'button', class: 'ck-srow__hit',
      'aria-label': go.value ? `${label}: ${go.value}` : null, ...go.attrs })}>${leading}${main}`
      + (go.value ? `<span class="ck-srow__value">${esc(go.value)}</span>` : '')
      + (go.time ? settingTime(go.time) : '')
      + `<span class="ck-srow__chev" aria-hidden="true">${icon('forward', { size: 'xs' })}</span></button></li>`;
  }
  const ends = hold?.end || end ? `<span class="ck-srow__end${hold?.end ? ' ck-srow__end--slot' : ''}">${end}</span>` : '';
  return `<li${item}>${leading}${main}${ends}</li>`;
}

/** @param {string} meaning */
export const settingTile = meaning => `<span class="ck-srow__tile">${icon(meaning, { size: 'sm' })}</span>`;

/** @typedef {{ faces?: { line: string, signal?: SignalKind | null, holds?: string }[], end?: boolean }} RowHold */

/** @param {string} words */
export const settingTime = words => `<span class="ck-stime">${esc(words)}</span>`;

/**
 * @param {string} words
 * @param {{ done?: boolean, signal?: SignalKind | null }} [options]
 */
export const settingValue = (words, { done = false, signal = null } = {}) => '<span class="ck-svalue">'
  + `${done ? icon('done', { size: 'xs' }) : signal ? signalShape(signal) : ''}${esc(words)}</span>`;

/**
 * @param {object} section
 * @param {string} [section.heading]
 * @param {string} [section.about]
 * @param {string} [section.line]
 * @param {string} [section.act]
 * @param {Bolded} [section.aside]
 * @param {string[]} [section.rows]
 * @param {string} [section.body]
 * @param {string} [section.note]
 * @param {Attributes} [section.attrs]
 */
export function settingsSection({ heading = '', about = '', line = '', act = '', aside = [], rows = [], body = '', note = '', attrs = {} }) {
  if (rows.length === 0 && !body) return '';
  const titled = heading ? `<span class="ck-ssection__titled"><h3 class="ck-ssection__heading">${esc(heading)}</h3>`
    + `${about ? tip({ label: heading, text: about }) : ''}</span>` : '';
  const head = heading || line || act || aside.length > 0 ? `<div class="ck-ssection__head"><div class="ck-ssection__words">${titled}`
    + (line ? `<p class="ck-ssection__line">${esc(line)}</p>` : '') + '</div>'
    + (aside.length > 0 ? `<p class="ck-ssection__aside">${boldRuns(aside)}</p>` : '')
    + (act ? `<span class="ck-ssection__act">${act}</span>` : '') + '</div>' : '';
  const { class: own, ...rest } = attrs;
  return `<section${attributes({ class: ['ck-ssection', heading ? '' : 'ck-ssection--bare', String(own ?? '')].filter(Boolean).join(' '), ...rest })}>`
    + head + (rows.length > 0 ? `<ul class="ck-ssection__rows">${rows.join('')}</ul>` : '')
    + (body ? `<div class="ck-ssection__body">${body}</div>` : '')
    + (note ? `<p class="ck-ssection__note">${esc(note)}</p>` : '') + '</section>';
}
