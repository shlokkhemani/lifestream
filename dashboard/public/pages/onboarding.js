// @ts-check
/** @import { Mounted, PageContext } from '../ui/route.js' */
/** @import { Host, HostAct } from '../lib/host.js' */
/** @import { ReportReader } from '../lib/report.js' */
/** @import { Screen } from '../ui/onboarding/model.js' */
/** @import { Session } from '../ui/onboarding/view.js' */
/** @import { PageChanges } from '../ui/connectors/changes.js' */
/** @import { ModelKind } from '../types.js' */
import { fetchStartCost, ownerAct } from '../lib/api.js';
import { refusalOf } from '../lib/host.js';
import { actSaid, actWords, answerUnknown, requestState, wordsOr } from '../lib/reach.js';
import { homeThere } from '../lib/report.js';
import { applyGeometry } from '../ui/geometry.js';
import {
  arrivals, arrive, dialogHold, installAppIcons, installFilterMenus, setupBand, setupFoot, setupFrame,
} from '../ui/kit/index.js';
import { siteOf } from '../ui/connectors/dialog.js';
import { busyKey } from '../ui/connectors/view.js';
import { ELSEWHERE, sessionOf } from '../ui/flows/model.js';
import { actRunner, flowFrame, installFlow, put } from '../ui/flows/frame.js';
import {
  backOf, BEFORE, done, DOTS, FACES, heldSpan, keepSpan, keptOf, landing, leftAs, macOf, macSources, nameHolds, nameText, nextOf, passed, recordOf,
  resume, SCREENS, sensesOf, stepOf,
} from '../ui/onboarding/model.js';
import { MEDIA_MORE, mediaListed, mediaPick, partsOf, rangeOf, scrambleAct, siteAdded, typedName } from '../ui/onboarding/view.js';
import { SETTINGS_DEFAULTS } from '../ui/connectors/settings.js';

/** @param {string} value @returns {value is Screen} */
const isScreen = value => /** @type {string[]} */ (SCREENS).includes(value);

const COST_READ_MS = 2000;

const SETTLED_READS = 2;

let mounted = new AbortController();

/**
 * @param {HTMLElement} container
 * @param {PageContext} context
 * @param {Host | null} host
 * @param {ReportReader} reports
 * @param {PageChanges} changes
 * @returns {Mounted}
 */
export function mountOnboarding(container, context, host, reports, changes) {
  context.title('Set up Lifestream');
  /** @type {import('../ui/flows/model.js').Seen} */
  const seen = {
    get report() { return reports.seen.report; },
    get state() { return reports.seen.state; },
    get models() { return changes.models.read; },
    get privacy() { return changes.privacy.read; },
    get screen() { return changes.screen.read; },
  };
  container.innerHTML = '<div class="ob"></div>';
  const root = /** @type {HTMLElement} */ (container.querySelector('.ob'));
  installAppIcons(root);
  /** @type {Session} */
  const session = { ...sessionOf(host !== null, 'dialog'), picked: new Map(), dialog: null, how: false, changes,
    nameTyped: null, span: null, cost: { read: null, failed: '', settled: false }, saved: false, recovery: null, drafted: null,
    redrafted: false };
  /** @type {{ names: string, request: string } | null} */
  let unanswered = null;
  /** @type {Screen | ''} */
  let screen = '';
  const watching = changes.watch(() => draw());
  const seenHere = () => !container.hidden && root.isConnected;
  const watch = () => watching.shown((screen === 'ai' || screen === 'media') && seenHere(),
    { privacy: screen === 'ai' && seenHere(), screen: screen === 'record' && seenHere() });
  /** @type {Record<string, string>} */
  let drawn = {};
  root.innerHTML = setupFrame({ band: '', head: '', body: '', foot: '' }) + '<div data-slot="dialog"></div>';
  const frameOf = /** @type {HTMLElement} */ (root.querySelector('.ck-onb'));
  /** @type {Record<string, HTMLElement | null>} */
  const slots = { band: root.querySelector('.ck-onb__band'), head: root.querySelector('.ck-onb__head'),
    body: root.querySelector('.ck-onb__body'), foot: root.querySelector('.ck-onb__foot'),
    dialog: root.querySelector('[data-slot="dialog"]') };
  const held = dialogHold(() => slots.dialog, () => [frameOf]);

  /**
   * @param {string} name
   * @param {string} markup
   */
  function fill(name, markup) {
    const into = slots[name];
    if (!into || drawn[name] === markup) return;
    const before = name in drawn ? arrivals(into) : new Map();
    drawn[name] = markup;
    put(into, markup, { keep: '.ck-dialog' });
    arrive(into, before);
    applyGeometry(into);
  }

  function draw() {
    if (!screen) return;
    const flow = flowShown.tick();
    const parts = partsOf(screen, seen, session, screen === 'ai' ? flow : null);
    frameOf.className = ['ck-onb', parts.look ? `ck-onb--${parts.look}` : '']
      .filter(Boolean).join(' ');
    const { back = '', note = '', end = '' } = parts.foot;
    fill('band', setupBand({ brand: parts.brand !== false, at: stepOf(screen).dot, of: DOTS }));
    fill('head', parts.head);
    fill('body', parts.body ?? '');
    fill('foot', setupFoot({ back, note, end }));
    fill('dialog', parts.dialog ?? '');
    held();
    watch();
  }

  /**
   * @param {Screen} asked
   * @param {{ back?: boolean }} [options]
   */
  function open(asked, { back = false } = {}) {
    const landed = landing(asked, seen);
    const next = !back && seen.report && passed(landed, seen) ? nextOf(landed, seen) : landed;
    if (!next) return finish();
    if (next !== asked) context.set({ seg: next });
    if (next === screen) return;
    screen = next;
    session.dialog = null;
    session.how = false;
    session.failure = null;
    flowShown.close();
    if (next === 'ai') flowShown.open('model');
    root.dataset.screen = next;
    restoreSpan();
    drawn = {};
    const column = root.querySelector('.ck-onb__col');
    column?.classList.remove('is-entering');
    draw();
    root.querySelector('.ck-onb__stage')?.scrollTo(0, 0);
    if (next === 'range') void readCost();
    if (next === 'key') void showKey();
    if (next === 'name') {
      const field = /** @type {HTMLInputElement | null} */ (root.querySelector('[data-ob="name"]'));
      field?.focus();
      field?.select();
    }
  }

  let costTimer = 0;
  let settledReads = 0;
  async function readCost() {
    window.clearTimeout(costTimer);
    costTimer = 0;
    if (screen !== 'range' || !seenHere()) return;
    const found = seen.report?.setup?.skipped.includes(leftAs('mac')) === true;
    try {
      const cost = await fetchStartCost();
      settledReads = found && cost.settled ? settledReads + 1 : 0;
      session.cost = { read: cost, failed: '', settled: settledReads >= SETTLED_READS };
    } catch (error) {
      session.cost = { ...session.cost, failed: wordsOr(error, 'Couldn’t estimate the sizes.') };
    }
    if (screen === 'range' && !session.cost.settled) costTimer = window.setTimeout(() => void readCost(), COST_READ_MS);
    draw();
  }

  async function sendName() {
    const typed = typedName(seen, session);
    const busy = session.busy;
    if (screen !== 'name' || busy.has('name') || !nameHolds(typed)) return;
    const full = nameText(typed);
    const action = { of: /** @type {const} */ ('people'), kind: 'you', name: full.split(' ')[0] ?? full, full_name: full };
    const said = JSON.stringify(action);
    const request = unanswered?.names === said ? unanswered.request : crypto.randomUUID();
    unanswered = { names: said, request };
    busy.add('name');
    session.failure = null;
    draw();
    let taken = false;
    try {
      await ownerAct(action, request);
      unanswered = null;
      session.nameTyped = null;
      taken = true;
      await reports.read();
    } catch (error) {
      if (!answerUnknown(error)) unanswered = null;
      session.failure = { key: 'name', words: actWords(actSaid(requestState(error))) };
    } finally {
      busy.delete('name');
      draw();
    }
    if (taken && screen === 'name') onward();
  }

  let sent = -1;

  /** @param {Screen} at */
  function mark(at) {
    if (BEFORE.includes(at) || !homeThere(seen.state)) return;
    const index = SCREENS.indexOf(at);
    if (index <= Math.max(sent, SCREENS.indexOf(/** @type {Screen} */ (seen.report?.setup?.at ?? '')))) return;
    sent = index;
    void quiet({ act: 'at', step: at });
  }

  function first() {
    const at = resume(seen);
    if (!at) return finish();
    context.set({ seg: at });
    open(at);
  }

  /**
   * @param {Screen} next
   * @param {{ back?: boolean }} [options]
   */
  function go(next, options) {
    context.set({ seg: next }, true);
    open(next, options);
  }

  function onward() {
    const next = nextOf(/** @type {Screen} */ (screen), seen);
    if (!next) return finish();
    mark(next);
    go(next);
  }

  function finish() {
    keepSpan(localStorage, seen, null);
    context.go('ask', { tour: '1' });
  }

  const runner = actRunner(host, session, { draw: () => draw(), reports, name: 'onboarding' });
  const { act, quiet } = runner;
  const flowShown = flowFrame({ session, reports, runner, draw: () => draw(), seen: () => seen, shown: seenHere, root: () => root });

  async function leave() {
    const from = screen;
    if (!from || session.busy.has('leave')) return;
    const faces = from === 'mac' && facesOwed();
    session.busy.add('leave');
    try {
      const step = leftAs(from);
      const owed = from === 'mac' || !done(from, seen);
      if (host && !BEFORE.includes(from) && owed && !seen.report?.setup?.skipped.includes(step)) {
        if (!(await act({ act: 'skip', step }, 'leave'))) return;
        await reports.read();
      }
    } finally {
      session.busy.delete('leave');
      draw();
    }
    if (faces) void quiet({ act: 'faces', do: 'on' });
    if (screen === from) onward();
  }

  function facesOwed() {
    const mac = macOf(seen, session);
    return mac.photos.granted && mac.faces !== null && !mac.faces.set_up && mac.faces.on;
  }

  /** @type {Map<string, Promise<boolean>>} */
  const picking = new Map();

  /**
   * @param {string} id
   * @param {boolean} on
   * @param {string} key
   */
  async function pick(id, on, key) {
    const turn = (/** @type {boolean} */ to) => turnOf(id, to);
    if (!turn(on)) return false;
    session.picked.set(id, on);
    const going = picking.get(id);
    if (going) {
      draw();
      return going;
    }
    const run = (async () => {
      let given = !on;
      let taken = true;
      while (taken && session.picked.get(id) !== given) {
        given = session.picked.get(id) === true;
        const message = turn(given);
        const busy = session.busy;
        taken = Boolean(message && (await act(message, key) || busy !== session.busy));
      }
      picking.delete(id);
      if (!taken) session.picked.delete(id);
      else await reports.read();
      draw();
      return taken;
    })();
    picking.set(id, run);
    return run;
  }

  /**
   * @param {string} id
   * @param {boolean} on
   * @returns {HostAct | null}
   */
  function turnOf(id, on) {
    const sources = macSources(seen, new Map()).find(source => source.id === id)?.sources
      ?? (sensesOf(seen).some(sense => sense.id === id) ? [id] : []);
    return sources.length ? { act: 'turn', sources, on } : null;
  }

  /**
   * @param {HostAct} message
   * @param {string} key
   */
  async function send(message, key) {
    if (!host) {
      session.failure = { key, words: ELSEWHERE };
      return draw();
    }
    session.failure = null;
    const reply = await changes.send(message);
    if (reply && 'refused' in reply) session.failure = { key, words: actWords(refusalOf(reply.refused)) };
    draw();
  }

  /**
   * @param {ModelKind} kind
   * @param {string} model
   */
  async function choose(kind, model) {
    if (!changes.models.read || !mediaListed(mediaPick(changes.models.read, kind), model)) return;
    if (model === MEDIA_MORE) return context.dialog(SETTINGS_DEFAULTS);
    await send({ act: 'models', do: 'default', use: kind, model }, 'media');
  }

  /** @param {number} at */
  function span(at) {
    const range = rangeOf(seen, session);
    const stop = range.stops[at];
    if (!stop || at === range.at) return;
    session.span = { months: stop.months };
    keepSpan(localStorage, seen, session.span);
    draw();
    /** @type {HTMLElement | null} */ (root.querySelector(`.ob-range__stop[data-at="${at}"]`))?.focus();
  }

  async function keepRange() {
    const stop = rangeOf(seen, session).stop;
    if (!stop) return;
    const taken = await act({ act: 'home-setting', key: 'history.start', value: stop.day ?? 'all' }, 'range');
    if (taken && screen === 'range') onward();
  }

  root.addEventListener('click', event => {
    const target = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('[data-ob], [data-scrim]'));
    if (!target || event.detail > 1 && target.dataset.ob !== 'pick') return;
    if (target.matches('[data-scrim]')) {
      if (event.target === target) close();
      return;
    }
    const key = target.dataset.ob ?? '';
    const cut = key.indexOf(':');
    void press(cut < 0 ? key : key.slice(0, cut), cut < 0 ? '' : key.slice(cut + 1), target);
  });
  root.addEventListener('click', event => {
    const target = /** @type {Element} */ (event.target).closest('[data-cn-do]');
    if (!(target instanceof HTMLElement) || !target.dataset.cnDo || target.matches(':disabled')) return;
    void runDo(/** @type {import('../ui/connectors/words.js').Do} */ (JSON.parse(target.dataset.cnDo)));
  });
  installFlow(root, () => flowShown);

  root.addEventListener('pointerdown', event => {
    const track = /** @type {Element} */ (event.target).closest('[data-ob-track]');
    if (!(track instanceof HTMLElement)) return;
    track.setPointerCapture(event.pointerId);
    spanAt(track, event.clientX);
  });
  root.addEventListener('pointermove', event => {
    const track = /** @type {Element} */ (event.target).closest('[data-ob-track]');
    if (track instanceof HTMLElement && track.hasPointerCapture(event.pointerId)) spanAt(track, event.clientX);
  });

  /**
   * @param {HTMLElement} track
   * @param {number} x
   */
  function spanAt(track, x) {
    const stops = rangeOf(seen, session).stops.length;
    if (!stops) return;
    const box = track.getBoundingClientRect();
    span(Math.max(0, Math.min(stops - 1, Math.floor((x - box.left) / (box.width / stops)))));
  }

  root.addEventListener('input', event => {
    const field = /** @type {HTMLInputElement} */ (event.target);
    if (field.dataset.ob === 'name') {
      session.nameTyped = field.value;
      draw();
      return;
    }
    const opened = session.dialog;
    if (!opened) return;
    if (field.hasAttribute('data-cn-add')) {
      opened.app = field.value;
      opened.lit = 0;
      draw();
    } else if (field.hasAttribute('data-ob-site')) {
      opened.site = field.value;
      if (opened.error) {
        opened.error = '';
        draw();
      }
    }
  });
  root.addEventListener('keydown', event => {
    const field = event.target;
    if (field instanceof HTMLElement && field.matches('.ob-range__stop')) {
      const by = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (by) {
        event.preventDefault();
        span(rangeOf(seen, session).at + by);
      }
      return;
    }
    if (field instanceof HTMLInputElement && field.dataset.ob === 'name' && event.key === 'Enter') {
      event.preventDefault();
      void sendName();
      return;
    }
    const opened = session.dialog;
    if (!(field instanceof HTMLInputElement) || !opened) return;
    if (field.hasAttribute('data-ob-site') && event.key === 'Enter') {
      event.preventDefault();
      void addSite(field.value);
      return;
    }
    if (!field.hasAttribute('data-cn-add')) return;
    const finds = root.querySelectorAll('.ck-srow__finds .ck-flist__item').length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      opened.lit = Math.max(0, Math.min(finds - 1, opened.lit + (event.key === 'ArrowDown' ? 1 : -1)));
      draw();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      /** @type {HTMLElement | null} */ (root.querySelector('.ck-srow__finds .is-lit'))?.click();
    } else if (event.key === 'Escape' && field.value) {
      event.preventDefault();
      opened.app = '';
      opened.lit = 0;
      draw();
    }
  });
  installFilterMenus(root, (menu, value) => {
    const kind = menu.closest('[data-ob-menu]')?.getAttribute('data-ob-menu');
    if (kind === 'pictures' || kind === 'audio') void choose(kind, value);
  });
  mounted.abort();
  mounted = new AbortController();
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || !root.isConnected || container.hidden) return;
    if (slots.dialog?.childElementCount) close();
  }, { signal: mounted.signal });

  function close() {
    session.dialog = null;
    session.how = false;
    draw();
  }

  /** @param {string} typed */
  async function addSite(typed) {
    const opened = session.dialog;
    if (!opened || !typed.trim()) return;
    const site = siteOf(typed);
    if ('error' in site) {
      opened.error = site.error;
      return draw();
    }
    const doing = siteAdded(seen, site.site);
    opened.site = '';
    opened.error = '';
    if (doing) await runDo(doing);
    else draw();
    /** @type {HTMLElement | null} */ (root.querySelector('[data-ob-site]'))?.focus();
  }

  /** @param {import('../ui/connectors/words.js').Do} doing */
  async function runDo(doing) {
    if ('open' in doing) return context.dialog(doing.open);
    const under = busyKey(doing);
    if (!('host' in doing) || changes.busy.has(under)) return;
    if (!host) {
      session.failure = { key: under, words: ELSEWHERE };
      return draw();
    }
    const adding = document.activeElement?.closest('.ck-srow--add') ?? null;
    if (session.dialog && adding) {
      session.dialog.app = '';
      session.dialog.lit = 0;
    }
    session.failure = null;
    const reply = await changes.send(doing.host, { holds: doing.holds ?? null });
    if (reply && 'refused' in reply) {
      session.failure = { key: under, words: actWords(refusalOf(reply.refused)) };
      draw();
    }
    if (adding) /** @type {HTMLElement | null} */ (root.querySelector('[data-cn-add]'))?.focus();
  }

  /**
   * @param {string} what
   * @param {string} arg
   * @param {HTMLElement} target
   */
  async function press(what, arg, target) {
    const id = target.dataset.id ?? '';
    switch (what) {
      case 'onward': return go('where');
      case 'back': {
        const to = backOf(/** @type {Screen} */ (screen), seen);
        return to ? go(to, { back: true }) : undefined;
      }
      case 'finish': return finish();
      case 'leave': return leave();
      case 'name': return sendName();
      case 'setup': return void await act({ act: 'setup' }, 'setup');
      case 'move-app': return void await act({ act: 'move-app' }, 'move-app');
      case 'login-items': return void await act({ act: 'open', what: 'login-items' }, 'login-items');
      case 'choose-folder': return void await act({ act: 'choose-folder' }, 'choose-folder');
      case 'key-copy': return void await act({ act: 'setup-key', do: 'copy' }, 'key-copy');
      case 'key-save': return void await act({ act: 'setup-key', do: 'save' }, 'key-save');
      case 'key-back': return void await act({ act: 'setup-key', do: 'back' }, 'key-back');
      case 'login-back': return go('where', { back: true });
      case 'key-done': return void await act({ act: 'setup-key', do: 'saved' }, 'key-done');
      case 'saved':
        if (seen.state?.setup?.key?.used == null) return;
        session.saved = !session.saved;
        return draw();
      case 'allow-full': return void await act({ act: 'allow', grants: ['fullDiskAccess'] }, 'allow-full');
      case 'allow-photos': return void await act({ act: 'allow', grants: ['photos'] }, 'allow-photos');
      case 'pick': return void await pick(id, target.getAttribute('aria-checked') !== 'true', `pick:${id}`);
      case 'span': return span(Number(target.dataset.at));
      case 'range': return keepRange();
      case 'allow-row': {
        const row = recordOf(seen, session).rows.find(each => each.id === arg);
        if (!row) return;
        if (!row.on && !(await pick(row.id, true, `allow-row:${arg}`))) return;
        if (row.needs.length) await act({ act: 'allow', grants: row.needs }, `allow-row:${arg}`);
        return;
      }
      case 'never':
        session.dialog = { app: '', lit: 0, site: '', error: '' };
        return draw();
      case 'scramble': {
        const privacy = changes.privacy.read;
        return privacy ? send(scrambleAct(privacy.level === 'none'), 'scramble') : undefined;
      }
      case 'how':
        session.how = true;
        return draw();
      case 'close': return close();
    }
  }

  function restoreSpan() {
    if (screen === 'range') session.span = heldSpan(session.span, localStorage, seen);
  }

  function heard() {
    const report = seen.report;
    if (report && !reports.failure()) settlePicked();
    if (!screen) return report ? first() : undefined;
    restoreSpan();
    const setup = seen.state?.setup?.state ?? 'idle';
    drafted(seen.state?.setup?.key?.made_ms ?? null);
    if (setup !== 'key' && !(setup === 'working' && screen === 'key')) {
      session.recovery = null;
      session.saved = false;
    }
    if ((screen === 'key' || screen === 'login') && setup === 'idle') return go('where', { back: true });
    const due = landing(screen, seen);
    if (due !== screen) return go(due);
    if (screen === 'where' && homeThere(seen.state)
      || screen === 'key' && setup !== 'key' && setup !== 'working'
      || screen === 'login' && homeThere(seen.state)) {
      const at = resume(seen);
      if (at && at !== screen && (homeThere(seen.state) ? report !== null : true)) return go(at);
    }
    if (screen === 'key') void showKey();
    if (screen === 'place' && !seen.state?.placement) return go('welcome');
    draw();
  }

  /** @param {number | null} made */
  function drafted(made) {
    if (made === null || made === session.drafted) return;
    session.redrafted = session.drafted !== null;
    session.drafted = made;
    session.saved = false;
    session.recovery = null;
    if (session.failure?.key.startsWith('key-')) session.failure = null;
  }

  let asking = false;
  async function showKey() {
    if (asking || session.recovery || seen.state?.setup?.state !== 'key') return;
    asking = true;
    const reply = await act({ act: 'setup-key', do: 'show' }, 'key-show');
    asking = false;
    if (reply?.key && seen.state?.setup?.state === 'key') session.recovery = reply.key;
    draw();
  }

  function settlePicked() {
    for (const [id, on] of session.picked) {
      if (id !== FACES && !picking.has(id) && keptOf(seen, id) === on) session.picked.delete(id);
    }
  }

  reports.follow(heard, container);
  host?.follow(() => heard());
  mounted.signal.addEventListener('abort', () => {
    watching.stop();
    window.clearTimeout(costTimer);
  });
  new MutationObserver(() => {
    if (screen) flowShown.tick();
    watch();
    if (screen === 'range' && seenHere() && !costTimer && !session.cost.settled) void readCost();
  }).observe(container, { attributes: true, attributeFilter: ['hidden'] });

  const named = context.route.seg;
  if (isScreen(named)) open(named);
  if (!homeThere(seen.state)) {
    if (!screen) first();
  } else if (seen.report) heard();
  void reports.read();

  return {
    update(route) {
      if (isScreen(route.seg)) open(route.seg);
      else if (!route.seg) first();
    },
    flow() {
      return false;
    },
  };
}
