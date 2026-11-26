// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { spinner } from './button.js';
import { floatList } from './float-list.js';
import { icon } from './icon.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

/** @typedef {{ value: string, words: string, note?: string, working?: boolean, tag?: string, head?: string, more?: boolean, chosen: boolean, default: boolean, disabled?: boolean, parted?: boolean }} MenuChoice */

/**
 * @param {object} menu
 * @param {string} menu.id
 * @param {string} menu.label
 * @param {string} menu.words
 * @param {MenuChoice[]} menu.choices
 * @param {Attributes} [menu.attrs]
 * @param {boolean} [menu.busy]
 * @param {string} [menu.find]
 * @param {{ label: string, value: string, attrs: Attributes, said?: string } | null} [menu.date]
 * @param {number} [menu.active]
 * @param {string} [menu.note]
 * @param {{ markup: string, className: string } | null} [menu.face]
 */
export function menuButton({ id, label, words, choices, attrs = {}, busy = false, find = '', date = null, active,
  note = '', face = null }) {
  const key = `ck-mb-${id.replace(/[^\w-]+/gu, '-')}`;
  const open = active !== undefined;
  const findField = find ? `<input${attributes({ class: 'ck-fmenu__find mac-body', type: 'search', placeholder: find,
    'aria-label': find, autocomplete: 'off', spellcheck: 'false' })}>` : '';
  const dateRow = date ? `<label class="ck-fmenu__date mac-body"><span>${esc(date.label)}</span>`
    + `<input${attributes({ class: 'ck-fmenu__date-field mac-body', type: 'date', value: date.value,
      'aria-label': date.label, ...date.attrs })}></label>`
    + `<div${attributes({ class: 'ck-fmenu__said', 'data-said-of': key })}>${date.said ?? ''}</div>` : '';
  const { class: own = '', ...rest } = attrs;
  /** @type {import('./float-list.js').FloatItem[]} */
  const items = choices.flatMap((choice, index) => [
    ...choice.head ? [{ head: choice.head }] : [],
    {
      name: choice.words, note: choice.note, working: choice.working, tag: choice.tag || (choice.default ? 'Default' : ''), chosen: choice.chosen, disabled: choice.disabled, parted: choice.parted,
      attrs: { id: `${key}-${index}`, 'data-value': choice.value, class: `ck-fmenu__item${choice.more ? ' ck-flist__more' : ''}` },
    },
  ]);
  const look = face ? face.className : 'ck-menubtn mac-body';
  const shown = face ? face.markup + (busy ? spinner() : '')
    : `<span class="ck-menubtn__words">${esc(words)}</span>`
      + (note ? `<span class="ck-menubtn__note">${esc(note)}</span>` : '')
      + (busy ? spinner() : icon('expand', { size: 'xs', className: 'ck-fmenu__caret' }));
  return `<div${attributes({ class: ['ck-fmenu ck-fmenu--float', String(own)].filter(Boolean).join(' '), ...rest })}>`
    + `<button${attributes({
      type: 'button', class: `ck-fmenu__btn ${look}${busy ? ' is-busy' : ''}`, 'aria-busy': busy ? 'true' : null,
      'aria-disabled': busy ? 'true' : null, 'aria-haspopup': 'menu', 'aria-expanded': String(open),
      'aria-controls': `${key}-menu`, 'aria-label': `${label}: ${words}${note ? ` (${note})` : ''}`,
      'aria-activedescendant': open ? `${key}-${active}` : null,
    })}>${shown}</button>`
    + floatList({
      label, role: 'menu', className: 'ck-fmenu__panel', before: findField, after: dateRow,
      lit: open ? items.findIndex(item => 'attrs' in item && item.attrs?.id === `${key}-${active}`) : null,
      attrs: { id: `${key}-menu`, hidden: !open }, items,
    }) + '</div>';
}
