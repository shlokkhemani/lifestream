// @ts-check
/** @import { Host, HostAct, HostReply } from '../../lib/host.js' */
/** @import { ReportReader } from '../../lib/report.js' */
/** @import { PrivacyRead } from '../../types.js' */
/** @import { Models } from '../../pages.js' */
/** @import { ScreenState } from './settings-search.js' */
/** @import { Pending, Reads } from './pending.js' */
/** @import { Drawn } from '../../lib/reach.js' */
import { fetchPage, fetchPrivacy, fetchSearchState } from '../../lib/api.js';
import { pageMoved, readMoves } from '../../lib/pages.js';
import { pageReach } from '../../lib/reach.js';
import { onHomeChange } from '../live.js';
import { actKey, landedOf, movesMeaning, movesPrivacy, OFF, pendingOf, settled } from './pending.js';

/** @typedef {{ on: boolean, privacy: boolean, screen: boolean, draw: () => void }} Watcher */


export const LACKS = {
  models: 'Your AI models couldn’t be read.',
  privacy: 'Your privacy settings couldn’t be read.',
  screen: 'Search by meaning couldn’t be read.',
};

export const NOT_HERE = {
  models: 'Your AI models aren’t on this Mac yet.',
  privacy: 'Your privacy settings aren’t on this Mac yet.',
  screen: 'Search by meaning isn’t on this Mac yet.',
};

export const SCREEN_EVERY = 10_000;

/**
 * @param {ScreenState} state
 * @param {boolean} off
 */
export const workShown = (state, off) => off ? state.vectors_bytes === 0 : state.embedded > 0 || state.waits !== null;

/** @typedef {{ reply: HostReply } | { refused: Error } | null} Sent */

/**
 * @param {Host | null} host
 * @param {ReportReader} reports
 */
export function pageChanges(host, reports) {
  const busy = /** @type {Set<string>} */ (new Set());
  /** @type {Map<string, Pending>} */
  const pending = new Map();
  const models = { read: /** @type {Models | null} */ (null), drawn: /** @type {Drawn | null} */ (null), failed: '' };
  let asked = 0;
  let landed = 0;
  const privacy = { read: /** @type {PrivacyRead | null} */ (null), drawn: /** @type {Drawn | null} */ (null), failed: '' };
  let privacyAsked = 0;
  let privacyLanded = 0;
  const screen = { read: /** @type {ScreenState | null} */ (null), drawn: /** @type {Drawn | null} */ (null), failed: '' };
  let screenAsked = 0;
  let screenLanded = 0;
  let screenAwaits = /** @type {{ off: boolean } | null} */ (null);
  let screenTicker = /** @type {ReturnType<typeof setInterval> | null} */ (null);
  /** @type {Set<Watcher>} */
  const watchers = new Set();
  const reach = pageReach(host);
  /** @typedef {(retry?: import('../../lib/reach.js').Retry | null) => void} Again */
  /** @type {Again} */
  const modelsAgain = (retry = null) => {
    if (anyShown()) void readModels(retry);
  };
  /** @type {Again} */
  const privacyAgain = (retry = null) => {
    if (privacyShown()) void readPrivacy(retry);
  };
  /** @type {Again} */
  const screenAgain = (retry = null) => {
    if (screenShown()) void readScreen(retry);
  };
  /**
   * @param {unknown} error
   * @param {import('../../lib/reach.js').Begun} begun
   * @param {Again} again
   */
  const failedOf = (error, begun, again) => {
    const drawn = reach.failed(error, begun, again);
    if (drawn.kind === 'wait') setTimeout(() => again(), Math.max(0, drawn.until - Date.now()));
    return drawn;
  };
  /**
   * @template T
   * @param {{ read: T | null, drawn: Drawn | null, failed: string }} holder
   * @param {T | null} answer
   * @param {Drawn | null} drawn
   * @param {string} lack
   */
  const landIn = (holder, answer, drawn, lack) => {
    holder.drawn = drawn;
    holder.failed = drawn?.kind === 'lack' ? drawn.words ?? lack : '';
    if (answer) holder.read = answer;
  };

  /** @returns {Reads} */
  const reads = () => ({ report: reports.failure() ? null : reports.seen.report, models: models.failed ? null : models.read,
    hiding: privacy.read?.detector.file ?? null });

  function reconcile() {
    const now = reads();
    for (const [key, change] of pending) {
      if (!settled(change, now)) continue;
      pending.delete(key);
      busy.delete(key);
    }
  }

  function tell() {
    for (const watcher of watchers) watcher.draw();
  }

  const anyShown = () => [...watchers].some(watcher => watcher.on);
  const privacyShown = () => [...watchers].some(watcher => watcher.privacy);
  const screenShown = () => [...watchers].some(watcher => watcher.screen);

  /**
   * @param {import('../../lib/reach.js').Retry | null} [retry]
   * @returns {Promise<void>}
   */
  async function readScreen(retry = null) {
    const mine = ++screenAsked;
    const begun = reach.begin(retry);
    /** @type {ScreenState | null} */
    let answer = null;
    /** @type {Drawn | null} */
    let drawn = null;
    try {
      answer = (await fetchSearchState()).screen;
    } catch (error) {
      drawn = failedOf(error, begun, screenAgain);
    }
    if (mine < screenLanded) return;
    screenLanded = mine;
    landIn(screen, answer, drawn, LACKS.screen);
    if (answer && screenAwaits && workShown(answer, screenAwaits.off)) screenAwaits = null;
    screenTick();
    tell();
  }

  function screenTick() {
    const wanted = (screenShown() || screenAwaits !== null) && document.visibilityState === 'visible';
    if (wanted && !screenTicker) screenTicker = setInterval(() => void readScreen(), SCREEN_EVERY);
    if (!wanted && screenTicker) {
      clearInterval(screenTicker);
      screenTicker = null;
    }
  }

  /**
   * @param {import('../../lib/reach.js').Retry | null} [retry]
   * @returns {Promise<void>}
   */
  async function readPrivacy(retry = null) {
    const mine = ++privacyAsked;
    const begun = reach.begin(retry);
    /** @type {PrivacyRead | null} */
    let answer = null;
    /** @type {Drawn | null} */
    let drawn = null;
    try {
      answer = await fetchPrivacy();
    } catch (error) {
      drawn = failedOf(error, begun, privacyAgain);
    }
    if (mine < privacyLanded) return;
    privacyLanded = mine;
    landIn(privacy, answer, drawn, LACKS.privacy);
    tell();
  }

  /**
   * @param {import('../../lib/reach.js').Retry | null} [retry]
   * @returns {Promise<void>}
   */
  async function readModels(retry = null) {
    const mine = ++asked;
    const begun = reach.begin(retry);
    /** @type {Models | null} */
    let answer = null;
    /** @type {Drawn | null} */
    let drawn = null;
    try {
      answer = await fetchPage('models');
    } catch (error) {
      drawn = failedOf(error, begun, modelsAgain);
    }
    if (mine < landed) return;
    landed = mine;
    landIn(models, answer, drawn, LACKS.models);
    reconcile();
    tell();
  }

  /**
   * @param {HostAct} act
   * @param {{ holds?: { connector: string, member: string } | null, keeps?: (reply: HostReply) => boolean, label?: string }} [options]
   * @returns {Promise<Sent>}
   */
  async function send(act, { holds = null, keeps = () => true, label = '' } = {}) {
    const key = actKey(act, holds);
    if (!host || busy.has(key)) return null;
    const change = pendingOf(act, reads(), holds);
    if (act.act === 'models' && act.do === 'default' && act.use === 'search') screenAwaits = { off: act.model === OFF };
    busy.add(key);
    tell();
    /** @type {Sent} */
    let sent;
    try {
      const reply = await host.act(act, label);
      if (change && keeps(reply)) pending.set(key, landedOf(change, reply));
      sent = { reply };
    } catch (error) {
      sent = { refused: error instanceof Error ? error : new Error(String(error)) };
    }
    await Promise.all([reports.read(), change?.source === 'models' ? readModels() : null, movesPrivacy(act, reads().hiding) ? readPrivacy() : null,
      movesMeaning(act) ? readScreen() : null]);
    reconcile();
    if (!pending.has(key)) busy.delete(key);
    tell();
    return sent;
  }

  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} work
   * @returns {Promise<T | undefined>}
   */
  async function hold(key, work) {
    if (busy.has(key)) return undefined;
    busy.add(key);
    tell();
    try {
      return await work();
    } finally {
      busy.delete(key);
      tell();
    }
  }

  reports.follow(() => {
    reconcile();
    tell();
  });
  host?.follow(tell);
  onHomeChange(change => {
    void readMoves().then(() => {
      if ((change.models || pageMoved('models', change, models.read?.position)) && anyShown()) void readModels();
    });
    if ((change.models || change.reset) && privacyShown()) void readPrivacy();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && anyShown()) void readModels();
    if (document.visibilityState === 'visible' && privacyShown()) void readPrivacy();
    if (document.visibilityState === 'visible' && (screenShown() || screenAwaits)) void readScreen();
    screenTick();
  });
  window.addEventListener('focus', () => {
    if (anyShown()) void readModels();
    if (privacyShown()) void readPrivacy();
    if (screenShown()) void readScreen();
  });

  return {
    busy: /** @type {ReadonlySet<string>} */ (busy),
    models: /** @type {Readonly<typeof models>} */ (models),
    privacy: /** @type {Readonly<typeof privacy>} */ (privacy),
    screen: /** @type {Readonly<typeof screen>} */ (screen),
    send,
    hold,
    /** @param {'models' | 'privacy' | 'screen'} read */
    reread(read) {
      if (read === 'models') void readModels();
      else if (read === 'privacy') void readPrivacy();
      else void readScreen();
    },
    /** @param {() => void} draw */
    watch(draw) {
      /** @type {Watcher} */
      const watcher = { on: false, privacy: false, screen: false, draw };
      watchers.add(watcher);
      return {
        /** @param {boolean} on @param {{ privacy?: boolean, screen?: boolean }} [also] */
        shown(on, { privacy: hiding = false, screen: searching = false } = {}) {
          const came = on && !watcher.on;
          const cameHiding = hiding && !watcher.privacy;
          const cameSearching = searching && !watcher.screen;
          watcher.on = on;
          watcher.privacy = hiding;
          watcher.screen = searching;
          if (came) void readModels();
          if (cameHiding) void readPrivacy();
          if (cameSearching) void readScreen();
          screenTick();
        },
        stop() {
          watchers.delete(watcher);
          screenTick();
        },
      };
    },
  };
}

/** @typedef {ReturnType<typeof pageChanges>} PageChanges */
