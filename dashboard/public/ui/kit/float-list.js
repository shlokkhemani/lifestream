// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { icon } from './icon.js';
import { leadOf } from './name-row.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

/** @typedef {{ name: string, icon?: string, lead?: string, count?: number, least?: boolean, note?: string, tag?: string, key?: string, chosen?: boolean, disabled?: boolean, parted?: boolean, attrs?: Attributes } | { name: string, line: string, lead: import('./name-row.js').Lead, attrs?: Attributes } | { head: string, attrs?: Attributes }} FloatItem */

/**
 * @param {object} list
 * @param {string} list.label
 * @param {FloatItem[]} list.items
 * @param {number | null} list.lit
 * @param {string} [list.none]
 * @param {'listbox' | 'menu'} [list.role]
 * @param {string} [list.className]
 * @param {Attributes} [list.attrs]
 * @param {string} [list.before]
 * @param {string} [list.after]
 * @param {boolean} [list.inline]
 */
export function floatList({ label, items, lit, none = '', role = 'listbox', className = '', attrs = {}, before = '',
  after = '', inline = false }) {
  const tag = inline ? 'span' : 'div';
  const rows = floatRows({ items, lit, role, inline });
  return `<${tag}${attributes({ class: `ck-flist${className ? ` ${className}` : ''}`, role, 'aria-label': label, ...attrs })}>`
    + before + (rows || `<p class="ck-flist__none mac-subhead">${esc(none)}</p>`) + after + `</${tag}>`;
}

/**
 * @param {object} list
 * @param {FloatItem[]} list.items
 * @param {number | null} list.lit
 * @param {'listbox' | 'menu'} [list.role]
 * @param {boolean} [list.inline]
 */
export function floatRows({ items, lit, role = 'listbox', inline = false }) {
  const tag = inline ? 'span' : 'div';
  return items.map((item, at) => {
    const on = at === lit;
    if ('head' in item) return `<${tag}${attributes({ class: 'ck-flist__head mac-subhead', role: 'presentation', ...item.attrs })}>${esc(item.head)}</${tag}>`;
    if ('line' in item) {
      return `<div${attributes({ class: `ck-flist__item ck-flist__item--find${on ? ' is-lit' : ''}`, role: 'option',
        'aria-selected': String(on), ...item.attrs })}><span class="ck-namerow__lead" aria-hidden="true">${leadOf(item.lead)}</span>`
        + `<span class="ck-namerow__main"><span class="ck-namerow__name mac-headline">${esc(item.name)}</span>`
        + `<span class="ck-namerow__line mac-subhead">${esc(item.line)}</span></span>`
        + (on ? '<span class="ck-namerow__key mac-subhead" aria-hidden="true">⏎</span>' : '') + '</div>';
    }
    const chosen = Boolean(item.chosen);
    const { class: own = null, ...attrs } = item.attrs ?? {};
    const row = `<${tag}${attributes({
      class: `ck-flist__item mac-body${own ? ` ${own}` : ''}${on && !item.disabled ? ' is-lit' : ''}`,
      role: role === 'menu' ? 'menuitemradio' : 'option',
      [role === 'menu' ? 'aria-checked' : 'aria-selected']: String(chosen),
      'aria-disabled': item.disabled ? 'true' : null, ...attrs,
    })}>${item.lead ?? (item.icon ? icon(item.icon) : '')}`
      + (item.note ? `<span class="ck-flist__words"><span class="ck-flist__label">${esc(item.name)}</span>`
        + `<span class="ck-flist__note mac-subhead">${esc(item.note.replaceAll(' · ', '\u00a0· '))}</span></span>`
        : `<span class="ck-flist__label">${esc(item.name)}</span>`)
      + (item.tag ? `<span class="ck-flist__tag mac-subhead">${esc(item.tag)}</span>` : '')
      + (item.key ? `<kbd class="ck-flist__tag ck-flist__key mac-body">${esc(item.key)}</kbd>` : '')
      + (item.count === undefined ? '' : `<span class="ck-flist__count mac-mono-data">${item.least ? 'at least ' : ''}`
        + `${item.count.toLocaleString('en-US')}</span>`)
      + `<span class="ck-flist__check" aria-hidden="true">${chosen ? icon('done', { size: 'sm' }) : ''}</span></${tag}>`;
    const page = item.attrs?.['data-ck-page-of'];
    return item.parted ? `${row}<hr${attributes({ class: 'ck-flist__rule', 'data-ck-page-of': page ?? null, hidden: page === undefined ? null : item.attrs?.hidden })}>` : row;
  }).join('');
}
