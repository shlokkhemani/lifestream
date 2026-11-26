// @ts-check

const NB = ' ';
const DAY_MS = 86_400_000;
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
import { dayAt } from './home-clock.js';

/** @type {Record<'day' | 'clock' | 'seconds', [string, Intl.DateTimeFormatOptions]>} */
const SHOWS = {
  day: ['en-CA', {}],
  clock: ['en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }],
  seconds: ['en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }],
};
/** @type {Map<string, Intl.DateTimeFormat>} */
const formatters = new Map();

/**
 * @param {keyof typeof SHOWS} kind
 * @param {number} ms
 * @param {string} zone
 */
function shown(kind, ms, zone) {
  const key = `${kind} ${zone}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    const [locale, options] = SHOWS[kind];
    formatter = new Intl.DateTimeFormat(locale, { ...options, timeZone: zone });
    formatters.set(key, formatter);
  }
  return formatter.format(ms);
}

/** @param {number} ms */
export const calendarDate = ms => shown('day', ms, dayAt(ms).zone);

/** @param {number} value */
export const count = value => value.toLocaleString('en-US');

/**
 * @param {number} n
 * @param {string} one
 * @param {string} [many]
 */
export const counted = (n, one, many = `${one}s`) => `${count(n)}${NB}${n === 1 ? one : many}`;

/** @param {number} ms */
export const clock = ms => shown('clock', ms, dayAt(ms).zone);

/** @param {number} ms */
export const clockSeconds = ms => shown('seconds', ms, dayAt(ms).zone);

const WHOLE_HOURS = 100;

/** @param {number} ms */
export function duration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  if (minutes >= WHOLE_HOURS * 60) return `${Math.round(minutes / 60).toLocaleString('en-US')}h`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/**
 * @param {number} start
 * @param {number | null} end
 */
export function range(start, end) {
  const from = clock(start);
  if (end === null || end === start) return from;
  return `${from}–${clock(end)}`;
}

/** @param {string} day */
const noon = day => new Date(`${day}T12:00:00Z`);

/**
 * @param {string} day
 * @param {string} [year]
 */
export function longDay(day, year = day.slice(0, 4)) {
  const words = noon(day)
    .toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
    .replace(',', '');
  return day.startsWith(year) ? words : `${words} ${day.slice(0, 4)}`;
}

/**
 * @param {string} day
 * @param {string} [year]
 */
export function shortDay(day, year = day.slice(0, 4)) {
  const words = noon(day)
    .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    .replace(',', '')
    .replace('Sept', 'Sep');
  return day.startsWith(year) ? words : `${words} ${day.slice(0, 4)}`;
}

/** @param {string} month */
export const monthName = month => noon(`${month}-01`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric',
  timeZone: 'UTC' });

/** @param {string} month */
export const monthOnly = month => noon(`${month}-01`).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });

/**
 * @param {string} day
 * @param {number} by
 */
export function shiftDay(day, by) {
  const date = noon(day);
  date.setUTCDate(date.getUTCDate() + by);
  return date.toISOString().slice(0, 10);
}

/**
 * @param {string} month
 * @param {number} by
 */
export function shiftMonth(month, by) {
  const date = noon(`${month}-01`);
  date.setUTCMonth(date.getUTCMonth() + by);
  return date.toISOString().slice(0, 7);
}

/**
 * @param {string} day
 * @param {string} today
 */
export function relativeDay(day, today) {
  if (day === today) return 'Today';
  if (day === shiftDay(today, -1)) return 'Yesterday';
  return '';
}

/** @param {string} month */
export const monthShort = month => MONTHS_SHORT[Number(month.slice(5, 7)) - 1] ?? '';

/** @param {string} day */
export const dayMonth = day => `${monthShort(day)} ${day.slice(0, 4)}`;

/** @param {number} ms */
export const monthYear = ms => dayMonth(dayAt(ms).day);

/** @param {[number, number] | null} years */
export const yearsOf = years => !years ? '' : years[0] === years[1] ? String(years[0]) : `${years[0]}–${years[1]}`;

/** @param {string} month */
export const monthEnd = month => shiftDay(`${shiftMonth(month, 1)}-01`, -1);

/**
 * @param {string} day
 * @param {{ weekday?: boolean, year?: number }} [options]
 */
export function dayDate(day, { weekday = true, year } = {}) {
  const [y, m, d] = day.split('-').map(Number);
  const at = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
  const named = [weekday ? WEEKDAYS_SHORT[at.getUTCDay()] : '', String(d), MONTHS_SHORT[(m ?? 1) - 1]];
  return [...named, y === year ? '' : String(y)].filter(Boolean).join(' ');
}

/**
 * @param {number} ms
 * @param {{ weekday?: boolean, year?: number }} [options]
 */
export const dateWords = (ms, options) => dayDate(dayAt(ms).day, options);

/**
 * @param {string[]} names
 * @param {number} [most]
 */
export const listWords = (names, most = Infinity) => names.length > most
  ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
  : names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

const LEVEL_WORDS = /** @type {Record<string, string>} */ ({
  off: 'No thinking', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max',
});

/** @param {string} level */
export const levelWords = level => LEVEL_WORDS[level] ?? level;

/** @param {string} words */
export const capital = words => words.replace(/^./u, letter => letter.toUpperCase());

/** @param {string} words */
export const inSentence = words => /^\p{Lu}\p{Ll}/u.test(words) ? words[0].toLowerCase() + words.slice(1) : words;

/** @param {number} bytes */
export function freeWords(bytes) {
  if (bytes >= 1e12) return `${Math.round(bytes / 1e11) / 10} TB free`;
  if (bytes >= 1e9) return `${Math.round(bytes / 1e9)} GB free`;
  return `${Math.max(0, Math.round(bytes / 1e6))} MB free`;
}

/** @param {number} bytes */
export function sizeWords(bytes) {
  if (bytes <= 0) return `0${NB}KB`;
  const said = (/** @type {number} */ value, /** @type {number} */ places) => Math.round(value * 10 ** places) / 10 ** places;
  const kb = Math.max(1, said(bytes / 1e3, 0));
  if (kb < 1000) return `${kb}${NB}KB`;
  const mb = said(bytes / 1e6, 0);
  if (mb < 1000) return `${mb}${NB}MB`;
  const gb = said(bytes / 1e9, bytes < 9.95e9 ? 1 : 0);
  if (gb < 1000) return `${gb}${NB}GB`;
  return `${said(bytes / 1e12, 2)}${NB}TB`;
}

/**
 * @param {string} day
 * @param {{ year?: boolean, long?: boolean }} [options]
 */
export const dateOf = (day, { year = false, long = false } = {}) => noon(day).toLocaleDateString('en-GB', { day: 'numeric',
  month: long ? 'long' : 'short', ...year ? { year: 'numeric' } : {}, timeZone: 'UTC' }).replace('Sept', 'Sep');

const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * @param {string} day
 * @param {string} today
 */
const daysBack = (day, today) => Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / DAY_MS);

/**
 * @param {string} day
 * @param {string} today
 * @param {{ clock?: string, grouped?: boolean }} [options]
 */
export function rowDay(day, today, { clock: at = '', grouped = false } = {}) {
  const back = daysBack(day, today);
  if (back === 0) return at || 'Today';
  if (back === 1) return grouped && at ? at : 'Yesterday';
  if (back > 1 && back < 7) return WEEKDAYS_LONG[noon(day).getUTCDay()];
  return dateOf(day, { year: day.slice(0, 4) !== today.slice(0, 4) });
}

/**
 * @param {number} ms
 * @param {number} now
 * @param {boolean} [grouped]
 */
export const rowWhen = (ms, now, grouped = false) => rowDay(dayAt(ms).day, dayAt(now).day, { clock: clock(ms), grouped });

/**
 * @param {string} day
 * @param {string} today
 */
export function groupWhen(day, today) {
  const back = daysBack(day, today);
  if (back < 0) return 'Coming up';
  if (back === 0) return 'Today';
  if (back === 1) return 'Yesterday';
  if (back <= 7) return 'Previous 7 days';
  if (back <= 30) return 'Previous 30 days';
  return day.slice(0, 4) === today.slice(0, 4) ? monthOnly(day.slice(0, 7)) : day.slice(0, 4);
}

/**
 * @param {string} key
 * @param {string} today
 * @returns {string | null}
 */
export function sectionWhen(key, today) {
  const month = /^month:(\d{4}-(?:0[1-9]|1[0-2]))$/u.exec(key)?.[1];
  if (month !== undefined) {
    if (month === today.slice(0, 7)) return 'This month';
    return month.slice(0, 4) === today.slice(0, 4) ? monthOnly(month) : monthName(month);
  }
  return /^year:(\d{4})$/u.exec(key)?.[1] ?? null;
}

/**
 * @param {string} day
 * @param {string} today
 */
export function dateTitle(day, today) {
  const back = daysBack(day, today);
  if (back === 0) return 'Today';
  if (back === 1) return 'Yesterday';
  return longDay(day, today.slice(0, 4));
}

/**
 * @param {string} day
 * @param {string} today
 */
export function nearDay(day, today) {
  const back = daysBack(day, today);
  if (back === 0) return 'Today';
  if (back === 1) return 'Yesterday';
  if (back > 1 && back <= 30) return `${counted(back, 'day')} ago`;
  if (back < 0 && back >= -30) return `in ${counted(-back, 'day')}`;
  return rowDay(day, today);
}

/**
 * @param {string} day
 * @param {string} today
 * @param {string} at
 */
export const stampWhen = (day, today, at) => `${rowDay(day, today)} ${at}`;

/**
 * @param {string} day
 * @param {string} today
 * @param {string} [at]
 */
export function lineDay(day, today, at = '') {
  const back = daysBack(day, today);
  if (back === 0) return at || 'today';
  if (back === 1) return at ? `yesterday ${at}` : 'yesterday';
  if (back === -1) return at ? `tomorrow ${at}` : 'tomorrow';
  if (Math.abs(back) < 7) return WEEKDAYS_LONG[noon(day).getUTCDay()];
  return dateOf(day, { year: day.slice(0, 4) !== today.slice(0, 4) });
}

/** @param {string} month */
export const lineMonth = month => dayMonth(`${month}-01`);

/**
 * @param {string} day
 * @param {string} today
 * @param {string} at
 */
export const lineClock = (day, today, at) => (day === today ? at : `${dateOf(day, { year: day.slice(0, 4) !== today.slice(0, 4) })} ${at}`);

/**
 * @param {import('../pages.js').When} time
 * @param {number} now
 * @returns {string}
 */
export function lineWhen(time, now) {
  const today = dayAt(now).day;
  if (time.kind === 'day') return lineDay(time.day, today);
  if (time.kind === 'month') return lineMonth(time.month);
  const day = dayAt(time.at_ms).day;
  return time.kind === 'at' ? lineDay(day, today, clock(time.at_ms)) : lineClock(day, today, clock(time.at_ms));
}

/**
 * @param {import('../pages.js').PhrasePart[] | null} phrase
 * @param {number} [now]
 */
export const phraseWords = (phrase, now = Date.now()) => (phrase ?? []).map(part => (part.kind === 'words' ? part.words : lineWhen(part.time, now))).join(' ');

/** @param {string} text */
const folded = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/** @param {string} text */
const piecesOf = text => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** @type {WeakMap<readonly string[], { entries: string[], words: string[] }>} */
const foldedFinds = new WeakMap();

/** @param {readonly string[]} find */
function foldedFind(find) {
  let held = foldedFinds.get(find);
  if (!held) {
    const entries = find.map(folded);
    held = { entries, words: entries.flatMap(piecesOf) };
    foldedFinds.set(find, held);
  }
  return held;
}

/**
 * @param {readonly string[]} find
 * @param {string} typed
 */
export function found(find, typed) {
  const { entries, words } = foldedFind(find);
  /** @param {string} piece */
  const shows = piece => (/^\d+$/u.test(piece) ? entries.some(each => each.includes(piece)) : words.some(each => each.startsWith(piece)));
  return folded(typed).split(/\s+/u).filter(Boolean).every(word => {
    const pieces = piecesOf(word);
    return pieces.length > 0 && pieces.every(shows);
  });
}

/**
 * @param {import('../pages.js').When} when
 * @param {string} today
 * @param {{ grouped?: boolean }} [options]
 */
export function whenWords(when, today, { grouped = false } = {}) {
  if (when.kind === 'day') return rowDay(when.day, today);
  if (when.kind === 'month') return sectionWhen(`month:${when.month}`, today) ?? '';
  return rowDay(dayAt(when.at_ms).day, today, { clock: clock(when.at_ms), grouped });
}

/** @param {import('../pages.js').When} when */
export const sinceWords = when => when.kind === 'day' ? dayMonth(when.day) : when.kind === 'month' ? dayMonth(when.month) : monthYear(when.at_ms);

/** @param {number} ms */
const clockWords = ms => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: dayAt(ms).zone }).format(ms);

/**
 * @param {import('../pages.js').When} when
 * @param {number} now
 */
const settingWhen = (when, now) => when.kind === 'clock' ? clockWords(when.at_ms) : lineWhen(when, now);

/**
 * @param {import('../pages.js').PhrasePart[] | null} phrase
 * @param {(when: import('../pages.js').When) => string} [worded]
 */
export const phraseOf = (phrase, worded = when => settingWhen(when, Date.now())) => (phrase ?? [])
  .map(each => each.kind === 'words' ? each.words : worded(each.time)).join('');
