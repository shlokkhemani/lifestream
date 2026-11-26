// @ts-check
/** @import { HomeChange } from '../ui/live.js' */
/** @import { Pages } from '../pages.js' */
import { changedPast } from '../ui/live.js';

/** @typedef {keyof Pages} PageName */
/** @typedef {'people' | 'places' | 'streams' | 'days' | 'clock' | 'today' | 'storage'} Move */

/** @type {Record<Move, (change: HomeChange, position: string | null | undefined) => boolean>} */
const MOVED = {
  people: (change, position) => (change.people && changedPast(change.peopleChanged, position))
    || [...change.imports].some(source => source.startsWith('people:')),
  places: change => change.places || [...change.imports].some(source => source.startsWith('places:')),
  streams: change => change.streams,
  days: change => change.days.size > 0,
  clock: change => change.clockMoved,
  today: change => change.clockMoved,
  storage: change => change.storage,
};

/** @type {Partial<Record<string, readonly Move[]>> | null} */
let moves = null;
/** @type {Promise<void> | null} */
let reading = null;

export function readMoves() {
  reading ??= fetch('pages.json').then(answer => answer.json()).then((/** @type {{ pages: Record<string, { moves: Move[] }> }} */ read) => {
    moves = Object.fromEntries(Object.entries(read.pages).map(([name, page]) => [name, page.moves]));
  }, () => {
    reading = null;
  });
  return reading;
}

/**
 * @param {PageName} name
 * @param {HomeChange} change
 * @param {string | null | undefined} position
 */
export function pageMoved(name, change, position) {
  if (change.reset) return true;
  const named = moves?.[name];
  if (!named) return change.records || change.clockMoved;
  return named.some(move => MOVED[move](change, position));
}
