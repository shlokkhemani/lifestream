// @ts-check
import { fetchPage } from './api.js';
import { wordsOr } from './reach.js';

export const FIND_FAILED = 'Couldn’t look for models';

/** @typedef {import('../pages.js').ModelRow} ModelRow */
/** @typedef {Omit<import('../pages.js').ModelDefaults, 'position' | 'today'> & import('../pages.js').ModelProviders} Models */
/** @typedef {{ rows: ModelRow[], local: import('../pages.js').ModelGroup | null, default?: ModelRow | null, more?: import('../pages.js').ModelMore | null, off?: ModelRow | null }} MenuParts */
/** @typedef {{ row: ModelRow, head: string, parted: boolean } | { more: string, parted: boolean }} MenuLine */
/** @typedef {{ use: import('../pages.js').ModelUseId } | { work: string }} FindFor */
/** @typedef {{ key: string, answer: import('../pages.js').ModelsFind | null, failed: string }} Found */

/**
 * @param {MenuParts} menu
 * @returns {MenuLine[]}
 */
export function menuLines(menu) {
  const local = menu.local;
  const models = [...menu.default ? [{ row: menu.default, head: '' }] : [], ...menu.rows.map(row => ({ row, head: '' })),
    ...(local?.rows ?? []).map((row, at) => ({ row, head: at === 0 && local ? local.label : '' }))];
  /** @type {MenuLine[]} */
  const ends = [...menu.more ? [{ more: menu.more.words, parted: false }] : [], ...menu.off ? [{ row: menu.off, head: '', parted: false }] : []];
  return [...models.map((line, at) => ({ ...line, parted: at === models.length - 1 && ends.length > 0 })), ...ends];
}

/**
 * @param {import('../pages.js').ModelMore} more
 * @returns {FindFor}
 */
export const findFor = more => more.work === null ? { use: more.use } : { work: more.work };

/** @param {FindFor} asked */
const forKey = asked => 'work' in asked ? `work:${asked.work}` : `use:${asked.use}`;

/**
 * @param {FindFor} asked
 * @param {string} typed
 */
export const foundKey = (asked, typed) => `${forKey(asked)}\n${typed.trim()}`;

/** @param {() => void} draw */
export function modelFinder(draw) {
  /** @type {Found | null} */
  let found = null;
  let asking = '';
  return {
    /**
     * @param {FindFor} asked
     * @param {string} typed
     * @returns {Found | null}
     */
    find(asked, typed) {
      const key = foundKey(asked, typed);
      if (found?.key !== key && asking !== key) {
        asking = key;
        const params = { ...'work' in asked ? { work: asked.work } : { use: asked.use }, q: typed.trim() };
        fetchPage('modelsFind', params).then(answer => ({ key, answer, failed: '' }), error => ({ key, answer: null, failed: wordsOr(error, FIND_FAILED) }))
          .then(each => {
            if (asking !== key) return;
            found = each;
            draw();
          });
      }
      return found !== null && found.key.startsWith(`${forKey(asked)}\n`) ? found : null;
    },
  };
}
