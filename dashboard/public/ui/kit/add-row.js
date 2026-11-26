// @ts-check
import { attributes } from '../../lib/html.js';
import { floatList } from './float-list.js';
import { icon } from './icon.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

/**
 * @param {object} row
 * @param {string} row.placeholder
 * @param {string} [row.value]
 * @param {{ name: string, lead?: string, attrs?: Attributes }[]} [row.finds]
 * @param {number | null} [row.lit]
 * @param {Attributes} [row.input]
 * @param {string} [row.end]
 */
export function addRow({ placeholder, value = '', finds = [], lit = null, input = {}, end = '' }) {
  const listing = finds.length > 0;
  return '<li class="ck-srow ck-srow--lead ck-srow--add">'
    + `<span class="ck-srow__lead" aria-hidden="true">${icon('add', { size: 'sm' })}</span>`
    + `<input${attributes({ class: 'ck-srow__field mac-body', type: 'text', placeholder, value, 'aria-label': placeholder,
      role: 'combobox', 'aria-expanded': String(listing), 'aria-autocomplete': 'list', autocomplete: 'off',
      spellcheck: 'false', autocapitalize: 'off', ...input })}>`
    + (end ? `<span class="ck-srow__end">${end}</span>` : '')
    + (listing ? floatList({ label: placeholder, className: 'ck-srow__finds', lit,
      items: finds.map(find => ({ name: find.name, lead: find.lead, attrs: find.attrs })) })
      : '')
    + '</li>';
}

/**
 * @param {object} row
 * @param {string} row.placeholder
 * @param {string} [row.value]
 * @param {Attributes} [row.input]
 */
export const findRow = ({ placeholder, value = '', input = {} }) => '<li class="ck-srow ck-srow--lead ck-srow--add">'
  + `<span class="ck-srow__lead" aria-hidden="true">${icon('search', { size: 'sm' })}</span>`
  + `<input${attributes({ class: 'ck-srow__field mac-body', type: 'search', placeholder, value, 'aria-label': placeholder, autocomplete: 'off',
    spellcheck: 'false', autocapitalize: 'off', ...input })}>`
  + '</li>';
