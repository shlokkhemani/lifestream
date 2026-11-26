// @ts-check
/** @import { Pages, PhrasePart } from '../../pages.js' */
import { esc } from '../../lib/html.js';
import { pageReach } from '../../lib/reach.js';
import { dateOf, phraseOf } from '../../lib/words.js';
import { areaChart, barWidths, boldLine, diskBar, glide, settingsSection, usageRow } from '../kit/index.js';

export const COALESCE_MS = 5_000;
export const COUNTING_MS = 3_000;

export const WORDS = {
  failed: 'Your storage couldn’t be read.',
  notHere: 'Your storage isn’t on this Mac yet.',
};

/** @typedef {Pages['storage']} Storage */

/**
 * @param {PhrasePart[] | null} phrase
 * @param {{ year?: boolean, long?: boolean }} dated
 */
const said = (phrase, dated) => phraseOf(phrase, when => when.kind === 'day' ? dateOf(when.day, dated) : phraseOf([{ kind: 'time', time: when }]));

/** @param {Storage} storage */
export const storageTerms = storage => [storage.growth, storage.used, ...storage.uses.map(use => use.name)];

export const MORE = /** @type {const} */ ({ rest: 'toggle' });

/**
 * @param {Storage} storage
 * @param {boolean} more
 */
export function storageMarkup(storage, more) {
  const figure = `<div class="cn-storage__head"><p class="cn-storage__figure">${esc(storage.figure)}`
    + (storage.after ? `<span class="cn-storage__after">${esc(storage.after)}</span>` : '') + '</p>'
    + `<p class="cn-storage__disk">${esc(storage.disk)}</p></div>`;
  const bar = diskBar({ label: storage.bar.label, parts: storage.bar.parts, key: storage.bar.key, time: storage.bar.left });
  const sentence = boldLine([{ text: said(storage.sentence, { year: true, long: true }) }]);
  const chart = storage.chart ? areaChart({ label: said(storage.chart.label, { year: true }), first: storage.chart.first,
    parts: storage.chart.parts, rate: storage.chart.rate, room: storage.chart.room }) : '';
  const rows = storage.uses.filter(use => more || !use.folded).map(use => usageRow({ part: use.part, name: use.name, tone: use.tone,
    line: said(use.line, {}), share: use.share, size: use.size,
    go: use.opens ? { 'data-cn-do': JSON.stringify({ open: use.opens, push: true }) } : null }));
  const toggle = storage.more ? `<button type="button" class="cn-storage__more" aria-expanded="${more}"`
    + ` data-cn-do="${esc(JSON.stringify(MORE))}">${esc(more ? storage.fewer : storage.more)}</button>` : '';
  return '<div class="cn-storage" data-lights>'
    + settingsSection({ body: figure + bar })
    + settingsSection({ heading: storage.growth, body: sentence + chart })
    + (storage.uses.length ? settingsSection({ heading: storage.used, rows, body: toggle }) : '')
    + '</div>';
}

/** @param {ParentNode} root */
export const storageBefore = root => ({ widths: barWidths(root), bar: root.querySelector('.cn-storage .ck-disk') !== null,
  chart: root.querySelector('.cn-storage .ck-area') !== null });

/**
 * @param {ParentNode} root
 * @param {ReturnType<typeof storageBefore>} before
 */
export function storageAfter(root, before) {
  glide(root, before.widths);
  const chart = root.querySelector('.cn-storage .ck-area');
  if (chart && before.bar && !before.chart) chart.classList.add('is-arriving');
}

/** @param {{ fetch: () => Promise<Storage>, draw: () => void, now?: () => number, later?: (run: () => void, ms: number) => unknown, cancel?: (timer: unknown) => void, seen?: () => boolean, reach?: ReturnType<typeof pageReach> }} parts */
export function storageReads({ fetch, draw, now = Date.now, later = (run, ms) => setTimeout(run, ms),
  cancel = timer => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (timer)), seen = () => true,
  reach = pageReach(null) }) {
  /** @type {Storage | null} */
  let read = null;
  /** @type {import('../../lib/reach.js').Drawn | null} */
  let drawn = null;
  let on = false;
  let flying = false;
  let again = false;
  /** @type {import('../../lib/reach.js').Retry | null} */
  let retry = null;
  let last = -Infinity;
  let notBefore = -Infinity;
  /** @type {unknown} */
  let timer = null;
  let due = Infinity;

  const stop = () => {
    if (timer !== null) cancel(timer);
    timer = null;
    due = Infinity;
  };
  /** @param {number} when */
  const at = when => {
    const allowed = Math.max(when, notBefore);
    if (!on || due <= allowed) return;
    stop();
    due = allowed;
    timer = later(() => void go(), Math.max(0, allowed - now()));
  };
  async function go() {
    stop();
    if (!on) return;
    if (now() < notBefore) {
      at(notBefore);
      return;
    }
    if (flying || !seen()) {
      again = true;
      return;
    }
    flying = true;
    last = now();
    const begun = reach.begin(retry);
    retry = null;
    try {
      read = await fetch();
      drawn = null;
    } catch (error) {
      drawn = reach.failed(error, begun, readAgain);
    }
    flying = false;
    if (!on) return;
    draw();
    if (drawn?.kind === 'wait') at(notBefore = now() + Math.max(0, drawn.until - Date.now()));
    if (again) at(last + COALESCE_MS);
    again = false;
    if (read && !read.counted) at(now() + COUNTING_MS);
  }

  /** @param {import('../../lib/reach.js').Retry | null} [given] */
  const readAgain = (given = null) => {
    if (!on) return;
    if (given) retry = given;
    if (flying) again = true;
    else void go();
  };

  return {
    get read() {
      return read;
    },
    get failed() {
      return drawn?.kind === 'lack' ? drawn.words ?? WORDS.failed : '';
    },
    get drawn() {
      return drawn;
    },
    /** @param {boolean} shown */
    shown(shown) {
      if (shown === on) return;
      on = shown;
      again = false;
      retry = null;
      stop();
      if (on) void go();
    },
    moved() {
      if (!on) return;
      if (flying) again = true;
      else at(Math.max(now(), last + COALESCE_MS));
    },
    again() {
      readAgain();
    },
    seen() {
      if (!on || flying || !(again || (drawn?.kind === 'lack' && timer === null))) return;
      again = false;
      void go();
    },
  };
}
