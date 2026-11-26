import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOST_STATE, REPORT } from '../public/kit-gallery-report.js';
import { areaChart, COLUMNS, columnsOf } from '../public/ui/kit/area-chart.js';
import { homeChange } from '../public/ui/live.js';
import { STORAGE_COUNTING, STORAGE_MAP, STORAGE_NEW, STORAGE_YEAR } from '../public/kit-gallery-settings.js';
import { dateOf, sizeWords } from '../public/lib/words.js';
import { OPENED } from '../public/ui/connectors/dialog.js';
import { detailMarkup } from '../public/ui/connectors/detail.js';
import { settingsDetail } from '../public/ui/connectors/settings.js';
import { STATES as REACH_STATES } from '../public/kit-gallery-reach.js';
import { COALESCE_MS, COUNTING_MS, storageMarkup, storageReads, WORDS } from '../public/ui/connectors/settings-storage.js';
import { AT_REST } from '../public/ui/connectors/view.js';
import { DOOR_WORDS, pageReach } from '../public/lib/reach.js';
import { esc } from '../public/lib/html.js';

/** @typedef {import('../public/ui/connectors/settings-storage.js').Storage} Storage */

/** @type {import('../public/lib/reach.js').Drawn} */
const READ_FAILED = { kind: 'lack', words: null, retry: true };

/** @param {string} words */
const plain = words => words.replace(/\s/gu, ' ');
/** @param {string} markup */
const textOf = markup => plain(markup.replace(/<[^>]*>/gu, '').replaceAll('&amp;', '&'));
/** @param {string} markup */
const usesOf = markup => [...markup.matchAll(/class="ck-urow[^"]*" data-part="([^"]*)"/gu)].map(each => each[1]);

test('M1, M2: counted, drawn as the home says it: the figure, the disk, the bar and its key, the sentence, the chart, the uses', () => {
  const markup = storageMarkup(STORAGE_YEAR, false);
  const text = textOf(markup);
  for (const words of [STORAGE_YEAR.figure, STORAGE_YEAR.after, STORAGE_YEAR.disk, STORAGE_YEAR.growth, STORAGE_YEAR.used]) {
    assert.ok(text.includes(plain(words)), words);
  }
  for (const part of STORAGE_YEAR.bar.key) assert.ok(text.includes(plain(part.name)), part.name);
  assert.ok(markup.includes('ck-disk') && markup.includes('ck-area'), 'the bar and the chart');
  const day = STORAGE_YEAR.sentence.find(part => part.kind === 'time');
  assert.ok(day?.kind === 'time' && day.time.kind === 'day');
  assert.ok(text.includes(`At this rate it is full around ${plain(dateOf(day.time.day, { year: true, long: true }))}.`),
    'the sentence in its words, its day said in full');
  assert.ok(!markup.includes('<b>'), 'the rate no longer bold');
});

test('M1: counting, the time left in the key, no chart; before the first figure, no uses', () => {
  const counting = storageMarkup(STORAGE_COUNTING, false);
  assert.ok(textOf(counting).includes(plain(STORAGE_COUNTING.bar.left)));
  assert.ok(!counting.includes('ck-area'), 'no chart while counting');
  assert.ok(usesOf(counting).length > 0);
  const map = storageMarkup(STORAGE_MAP, false);
  assert.ok(!map.includes(plain(STORAGE_MAP.used)) && !map.includes('ck-area'), 'no rows, no chart');
  assert.ok(textOf(map).startsWith(plain(STORAGE_MAP.figure)));
});

test('M4: a use\'s line in its words, a day as the home\'s When worded here', () => {
  const young = textOf(storageMarkup(STORAGE_NEW, false));
  assert.ok(/\+[\d.]+ GB since \d{1,2} [A-Z][a-z]{2}/u.test(young), young);
  assert.ok(!storageMarkup(STORAGE_NEW, false).includes('cn-storage__more'), 'no Show more without a folded use');
});

test('M5: a use opens what the home says it opens, and nothing when it says none', () => {
  const markup = storageMarkup(STORAGE_YEAR, false);
  const opens = STORAGE_YEAR.uses[0].opens;
  assert.ok(opens);
  assert.ok(markup.includes(`data-cn-do="${JSON.stringify({ open: opens, push: true }).replaceAll('"', '&quot;')}"`),
    'a use opens its dialog as a new history entry');
  assert.equal(STORAGE_YEAR.uses.at(-1)?.opens, null);
  assert.ok(!markup.includes('&quot;open&quot;:null'));
});

test('M6: the folded uses behind the home\'s Show more, then Show fewer; one toggle; each lights as its part', () => {
  const folded = storageMarkup(STORAGE_YEAR, false);
  const shown = STORAGE_YEAR.uses.filter(use => !use.folded);
  assert.deepEqual(usesOf(folded), shown.map(use => use.part));
  assert.ok(STORAGE_YEAR.more && textOf(folded).includes(plain(STORAGE_YEAR.more)));
  const open = storageMarkup(STORAGE_YEAR, true);
  assert.deepEqual(usesOf(open), STORAGE_YEAR.uses.map(use => use.part));
  assert.ok(open.includes(STORAGE_YEAR.fewer) && open.includes('aria-expanded="true"'));
  /** @param {string} drawn */
  const toggle = drawn => /<button[^>]*class="cn-storage__more"[^>]*data-cn-do="([^"]*)"/u.exec(drawn)?.[1];
  assert.ok(toggle(open));
  assert.equal(toggle(open), toggle(folded), 'one action whichever it says, so the focus finds it drawn again');
});

test('M7: the page: reading until its read, a failed read or a home not answering said over what it last held, Location', () => {
  /**
   * @param {import('../public/ui/connectors/settings.js').StorageReads} storage
   * @param {{ state?: import('../public/lib/host.js').HostState | null, unread?: boolean }} [reach]
   */
  const page = (storage, { state = HOST_STATE, unread = false } = {}) => /** @type {import('../public/ui/connectors/dialog.js').Detail} */ (
    settingsDetail({ report: REPORT, models: null, failed: null, state, id: 'settings/storage', opened: OPENED, subscriptions: null, storage,
      unread }));
  const reading = page({ read: null, drawn: null });
  assert.equal(reading.reading, true);
  assert.equal(reading.storage, null);
  const failed = page({ read: null, drawn: READ_FAILED });
  assert.equal(failed.reading, false);
  assert.ok(detailMarkup(failed, AT_REST).includes(WORDS.failed));
  const kept = page({ read: STORAGE_YEAR, drawn: READ_FAILED });
  assert.ok(detailMarkup(kept, AT_REST).includes(WORDS.failed));
  assert.equal(kept.storage?.answer, STORAGE_YEAR);
  const away = page({ read: STORAGE_YEAR, drawn: null }, { unread: true });
  assert.equal(away.readFailed, null, 'a home known not to answer, though Storage\'s last read answered');
  assert.equal(away.storage?.answer, STORAGE_YEAR, 'what it last held kept under it');
  const stopped = page({ read: STORAGE_YEAR, drawn: null }, { state: { ...HOST_STATE, reach: REACH_STATES.unreachable } });
  assert.equal(stopped.readFailed, null, 'the Mac saying its home does not answer');
  assert.equal(stopped.storage?.answer, STORAGE_YEAR);
  const read = page({ read: STORAGE_YEAR, drawn: null });
  assert.equal(read.readFailed, null);
  const rows = read.parts.flatMap(part => part.panel?.rows ?? []);
  assert.deepEqual(read.parts.map(part => part.label), ['Location']);
  assert.deepEqual(rows.map(row => row.label), ['Folder', STORAGE_YEAR.keep.label]);
  assert.equal(rows[1].end && 'words' in rows[1].end ? rows[1].end.words : '', STORAGE_YEAR.keep.size);
  assert.deepEqual(page({ read: STORAGE_YEAR, drawn: null }, { state: null }).parts.flatMap(part => part.panel?.rows ?? []).map(row => row.label),
    [STORAGE_YEAR.keep.label], 'in a browser, no folder');
  const markup = detailMarkup(read, AT_REST);
  assert.ok(markup.includes('data-lights') && markup.includes('ck-disk') && markup.includes('ck-area'));
  assert.ok(markup.indexOf('ck-disk') < markup.indexOf('Location'), 'what the disk holds over Location');
  const found = settingsDetail({ report: REPORT, models: null, failed: null, state: HOST_STATE, id: 'settings/home', opened: OPENED,
    subscriptions: null, query: 'what uses', storage: { read: STORAGE_YEAR, drawn: null } });
  assert.deepEqual(found?.nav?.groups.flatMap(group => group.items.map(item => item.id)), ['storage'], 'search finds what Storage draws');
  assert.ok(page({ read: STORAGE_YEAR, drawn: null, more: true }).storage?.more, 'Storage\'s own state shows the rest');
});

test('M6: a size never says 1000 of a unit, and Settings says sizes one way', () => {
  assert.equal(plain(sizeWords(999.7e9)), '1 TB');
  assert.equal(plain(sizeWords(999.6e6)), '1 GB');
  assert.equal(plain(sizeWords(999_600)), '1 MB');
  assert.equal(plain(sizeWords(999.4e9)), '999 GB');
  assert.equal(plain(sizeWords(9.96e9)), '10 GB');
  assert.equal(plain(sizeWords(2.08e9)), '2.1 GB');
  assert.equal(plain(sizeWords(1.25e12)), '1.25 TB');
});

/**
 * @param {Storage} [answer]
 * @param {ReturnType<typeof pageReach>} [reach]
 */
function clocked(answer = STORAGE_YEAR, reach = pageReach(null)) {
  let now = 0;
  let hidden = false;
  /** @type {{ at: number, run: () => void }[]} */
  let timers = [];
  /** @type {{ done: (read: Storage) => void, fail: (error: Error) => void }[]} */
  const flying = [];
  let asked = 0;
  let drawn = 0;
  const reads = storageReads({
    fetch: () => {
      asked += 1;
      return new Promise((done, fail) => flying.push({ done, fail }));
    },
    draw: () => {
      drawn += 1;
    },
    now: () => now,
    later: (run, ms) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return timer;
    },
    cancel: timer => {
      timers = timers.filter(each => each !== timer);
    },
    seen: () => !hidden,
    reach,
  });
  return {
    reads,
    get asked() {
      return asked;
    },
    get drawn() {
      return drawn;
    },
    /** @param {number} ms */
    async pass(ms) {
      now += ms;
      for (const timer of timers.filter(each => each.at <= now)) {
        timers = timers.filter(each => each !== timer);
        timer.run();
      }
      await Promise.resolve();
    },
    /** @param {Storage} [read] */
    async answer(read = answer) {
      flying.shift()?.done(read);
      await new Promise(done => setImmediate(done));
    },
    /** @param {Error} [error] */
    async fail(error = new TypeError('Failed to fetch')) {
      flying.shift()?.fail(error);
      await new Promise(done => setImmediate(done));
    },
    /** @param {boolean} on */
    hide(on) {
      hidden = on;
    },
    get timers() {
      return timers.length;
    },
  };
}

test('M8: read as the page shows, never two at once, a feed\'s change at most once in 5 s', async () => {
  const clock = clocked();
  clock.reads.moved();
  assert.equal(clock.asked, 0, 'nothing read while the page is not shown');
  clock.reads.shown(true);
  assert.equal(clock.asked, 1);
  clock.reads.shown(true);
  clock.reads.moved();
  assert.equal(clock.asked, 1, 'a change while a read flies waits for it');
  await clock.answer();
  assert.equal(clock.drawn, 1);
  assert.equal(clock.reads.read, STORAGE_YEAR);
  assert.equal(clock.timers, 1, 'the change heard while it flew, read once more');
  await clock.pass(COALESCE_MS - 1);
  assert.equal(clock.asked, 1);
  await clock.pass(1);
  assert.equal(clock.asked, 2);
  await clock.answer();
  assert.equal(clock.timers, 0, 'counted: no timer');
  clock.reads.moved();
  clock.reads.moved();
  clock.reads.moved();
  assert.equal(clock.timers, 1);
  await clock.pass(COALESCE_MS);
  assert.equal(clock.asked, 3, 'three changes, one read');
  await clock.answer();
  await clock.pass(10 * COALESCE_MS);
  clock.reads.moved();
  assert.equal(clock.timers, 1);
  await clock.pass(0);
  assert.equal(clock.asked, 4, 'a change long after the last read is read at once');
  await clock.answer();
});

test('M8: 3 s after each answer while counting, none once counted; none while hidden, none once the page goes', async () => {
  const clock = clocked(STORAGE_COUNTING);
  clock.reads.shown(true);
  await clock.answer();
  await clock.pass(COUNTING_MS - 1);
  assert.equal(clock.asked, 1);
  await clock.pass(1);
  assert.equal(clock.asked, 2);
  await clock.answer();
  await clock.pass(COUNTING_MS);
  assert.equal(clock.asked, 3);
  await clock.answer(STORAGE_YEAR);
  assert.equal(clock.timers, 0, 'the count ended: no timer');
  clock.reads.moved();
  await clock.pass(COALESCE_MS);
  await clock.answer(STORAGE_COUNTING);
  clock.hide(true);
  await clock.pass(COUNTING_MS);
  assert.equal(clock.asked, 4, 'no read while the window is hidden');
  clock.hide(false);
  clock.reads.seen();
  assert.equal(clock.asked, 5, 'seen again: read at once');
  await clock.answer(STORAGE_COUNTING);
  clock.reads.shown(false);
  assert.equal(clock.timers, 0, 'the page gone: its timer with it');
  await clock.pass(10 * COUNTING_MS);
  assert.equal(clock.asked, 5);
  clock.reads.shown(true);
  assert.equal(clock.asked, 6, 'shown again: read at once');
  await clock.answer(STORAGE_YEAR);
});

test('M8: a failed read keeps what was last read; while counting the 3 s go on; a failed first read waits for the feed or the window', async () => {
  const clock = clocked(STORAGE_COUNTING);
  clock.reads.shown(true);
  await clock.answer();
  await clock.pass(COUNTING_MS);
  assert.equal(clock.asked, 2);
  await clock.fail();
  assert.equal(clock.reads.read, STORAGE_COUNTING, 'what was last read kept');
  assert.equal(clock.reads.failed, WORDS.failed);
  assert.equal(clock.timers, 1, 'the last answer said counting: the 3 s go on');
  await clock.pass(COUNTING_MS);
  assert.equal(clock.asked, 3);
  clock.reads.seen();
  assert.equal(clock.asked, 3, 'a read due: the window seen asks nothing more');
  await clock.answer(STORAGE_YEAR);
  assert.equal(clock.reads.failed, '');
  assert.equal(clock.timers, 0);

  const first = clocked();
  first.reads.shown(true);
  await first.fail();
  assert.equal(first.reads.read, null);
  assert.equal(first.reads.failed, WORDS.failed);
  assert.equal(first.timers, 0, 'no timer of its own');
  await first.pass(10 * COUNTING_MS);
  assert.equal(first.asked, 1);
  first.reads.seen();
  assert.equal(first.asked, 2, 'the window seen again: read');
  await first.fail();
  first.reads.moved();
  await first.pass(COALESCE_MS);
  assert.equal(first.asked, 3, 'the feed: read');
  await first.answer();
  assert.equal(first.reads.read, STORAGE_YEAR);
  first.reads.seen();
  assert.equal(first.asked, 3, 'answered: the window seen asks nothing');
});

test('M8: hidden, the 3 s come due, an import, then seen: one read, then the rules', async () => {
  const clock = clocked(STORAGE_COUNTING);
  clock.reads.shown(true);
  await clock.answer();
  clock.hide(true);
  await clock.pass(COUNTING_MS);
  assert.equal(clock.asked, 1, 'hidden: no read');
  assert.equal(clock.timers, 0);
  await clock.pass(1_000);
  clock.reads.moved();
  assert.equal(clock.timers, 1, 'the import\'s read due 5 s after the last');
  await clock.pass(500);
  clock.hide(false);
  clock.reads.seen();
  assert.equal(clock.asked, 2, 'seen: read at once');
  assert.equal(clock.timers, 0, 'the import\'s read due no more');
  await clock.pass(COALESCE_MS);
  assert.equal(clock.asked, 2, 'no second read');
  await clock.answer();
  assert.equal(clock.timers, 1);
  await clock.pass(COUNTING_MS - 1);
  assert.equal(clock.asked, 2);
  await clock.pass(1);
  assert.equal(clock.asked, 3, 'then 3 s after the answer, as counting reads');
  await clock.answer(STORAGE_YEAR);
  assert.equal(clock.timers, 0);
});

test('M7: a read that fails says the page\'s words, never the browser\'s', async () => {
  let answered = 0;
  const reads = storageReads({ fetch: () => Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0')),
    draw: () => {
      answered += 1;
    }, later: () => null, cancel: () => undefined });
  reads.shown(true);
  await new Promise(done => setImmediate(done));
  assert.equal(answered, 1);
  assert.equal(reads.failed, WORDS.failed);
  const drawn = settingsDetail({ report: REPORT, models: null, failed: '', state: HOST_STATE, id: 'settings/storage', opened: OPENED,
    subscriptions: null, storage: { read: reads.read, drawn: reads.drawn } });
  assert.ok(drawn && detailMarkup(drawn, AT_REST).includes(WORDS.failed));
});

test('M9: the feed says the home\'s stores moved for an import, an erase and the count\'s stored, and nothing else', () => {
  /** @param {string} kind @param {string} [event] */
  const heard = (kind, event = 'message') => homeChange([{ event, data: { seq: 1, kind, key: kind === 'import' ? 'whatsapp/d1' : '' } }]);
  for (const kind of ['import', 'erase', 'stored']) assert.equal(heard(kind).storage, true, kind);
  for (const kind of ['day', 'extract', 'people', 'places', 'models', 'device-paired', 'settings']) assert.equal(heard(kind).storage, false, kind);
  assert.equal(heard('', 'reset').reset, true, 'a reset reads everything again, Storage too');
});

/** @param {string} markup */
function linesOf(markup) {
  const ahead = /class="ck-area__ahead" d="M([\d.]+),([\d.]+)L([\d.]+),([\d.]+)"/u.exec(markup);
  const room = /class="ck-area__room" x1="0" x2="[\d.]+" y1="([\d.]+)"/u.exec(markup);
  return { ahead: ahead ? { from: [Number(ahead[1]), Number(ahead[2])], to: [Number(ahead[3]), Number(ahead[4])] } : null,
    room: room ? Number(room[1]) : null };
}

test('M10: the dashed line a quarter ahead, stopping at the room it reaches; the room drawn only then', () => {
  /** @param {number} days @param {number} bytes */
  const parts = (days, bytes) => [{ id: 'a', name: 'A', tone: /** @type {const} */ ('s1'), bytes: Array.from({ length: days }, (_, at) => bytes * (at + 1) / days) }];
  const right = 624 - 44;
  const far = linesOf(areaChart({ label: '', first: '2026-01-01', parts: parts(101, 100e9), rate: 1e9, room: { bytes: 200e9, name: 'T9 full' } }));
  assert.ok(far.ahead, 'a rate: the dashed line');
  assert.equal(far.ahead.to[0], right, 'out to the quarter\'s end');
  assert.equal(far.room, null, 'a room past the quarter: not drawn');
  const near = linesOf(areaChart({ label: '', first: '2026-01-01', parts: parts(101, 100e9), rate: 1e9, room: { bytes: 110e9, name: 'T9 full' } }));
  assert.ok(near.ahead && near.room !== null, 'the room within the quarter: drawn');
  assert.equal(near.ahead.to[1], near.room, 'the dashed line stops at the room');
  assert.ok(Math.abs(near.ahead.to[0] - right * 110 / 125) < 0.2, 'on the day the rate reaches it: 10 days on of 125');
  const none = linesOf(areaChart({ label: '', first: '2026-01-01', parts: parts(101, 100e9), rate: null, room: { bytes: 101e9, name: 'T9 full' } }));
  assert.deepEqual(none, { ahead: null, room: null }, 'no rate: neither line');
  const young = linesOf(areaChart({ label: '', first: '2026-01-01', parts: parts(2, 100e9), rate: 9e9, room: { bytes: 105e9, name: 'T9 full' } }));
  assert.ok(young.ahead && young.room !== null, 'a home two days old near full: its line and its room');
  assert.equal(young.ahead.to[1], young.room);
});

test('M10: a span past COLUMNS days drawn from every few days, the first and today among them', () => {
  assert.deepEqual(columnsOf(5), [0, 1, 2, 3, 4]);
  assert.equal(columnsOf(COLUMNS).length, COLUMNS);
  for (const count of [COLUMNS + 1, 1500, 3653]) {
    const columns = columnsOf(count);
    assert.ok(columns.length <= COLUMNS, `${count}: ${columns.length} columns`);
    assert.equal(columns[0], 0);
    assert.equal(columns.at(-1), count - 1, 'today drawn');
    const steps = new Set(columns.slice(1, -1).map((at, i) => at - columns[i]));
    assert.equal(steps.size, 1, 'every few days, evenly');
    assert.ok(columns.every((at, i) => i === 0 || at > columns[i - 1]));
  }
});

test('M11: a read that met the door gone reads on, asks the Mac one probe and is read again once the home answers; one the home failed at says the page\'s words; a wait of its own is read again at its time', async () => {
  /** @type {unknown[]} */
  const probes = [];
  /** @type {(reply: unknown) => void} */
  let reply = () => undefined;
  const reach = pageReach({
    follow: listener => {
      listener({ reach: { state: 'answering', revision: 4, tone: null, title: null, line: null, meta: null, acts: [] } });
      return () => undefined;
    },
    act: message => {
      probes.push(message);
      return new Promise(done => {
        reply = done;
      });
    },
  });
  const thrown = (/** @type {string} */ words, /** @type {number} */ status, code = '', retryAfter = 0) =>
    Object.assign(new Error(words), { status, code, retryAfter });
  const clock = clocked(STORAGE_YEAR, reach);
  clock.reads.shown(true);
  await clock.answer();
  clock.reads.moved();
  await clock.pass(COALESCE_MS);
  await clock.fail(thrown('Can\'t reach Lifestream.', 503, 'GONE'));
  assert.deepEqual([clock.reads.failed, clock.reads.drawn, clock.reads.read], ['', { kind: 'reach' }, STORAGE_YEAR]);
  assert.deepEqual(probes, [{ act: 'home', do: 'probe' }]);
  assert.equal(clock.asked, 2);
  reply({ state: 'answering', revision: 4 });
  await new Promise(done => setImmediate(done));
  assert.equal(clock.asked, 3);
  await clock.fail(thrown('database disk image is malformed', 500));
  assert.deepEqual([clock.reads.failed, clock.reads.drawn], [WORDS.failed, { kind: 'lack', words: null, retry: true }]);
  const drawn = settingsDetail({ report: REPORT, models: null, state: HOST_STATE, id: 'settings/storage', opened: OPENED,
    subscriptions: null, storage: { read: null, drawn: clock.reads.drawn } });
  assert.ok(drawn && detailMarkup(drawn, AT_REST).includes(WORDS.failed));
  assert.ok(!WORDS.failed.includes('reach'), 'never why the home did not answer');
  clock.reads.seen();
  assert.equal(clock.asked, 4);
  await clock.fail(thrown('no room', 503, 'DISK_LOW', 7));
  const waiting = clock.reads.drawn;
  assert.deepEqual([waiting?.kind, waiting?.kind === 'wait' && waiting.words], ['wait', DOOR_WORDS.DISK_LOW]);
  assert.equal(clock.reads.failed, '');
  await clock.pass(6_990);
  assert.equal(clock.asked, 4);
  await clock.pass(1_000);
  assert.equal(clock.asked, 5, 'read again at its Retry-After');
  await clock.answer();
  assert.equal(clock.reads.drawn, null);
  assert.equal(probes.length, 1, 'a read\'s own failure asks the Mac nothing');
});

test('M12: a wait after a counting answer: no read of any trigger before its Retry-After, then one; a failure keeps the 3 s', async () => {
  const thrown = (/** @type {string} */ words, /** @type {number} */ status, code = '', retryAfter = 0) =>
    Object.assign(new Error(words), { status, code, retryAfter });
  const clock = clocked(STORAGE_COUNTING);
  clock.reads.shown(true);
  await clock.answer();
  await clock.pass(COUNTING_MS);
  assert.equal(clock.asked, 2);
  await clock.fail(thrown('no room', 503, 'DISK_LOW', 60));
  assert.equal(clock.reads.drawn?.kind, 'wait');
  await clock.pass(COUNTING_MS);
  clock.reads.moved();
  await clock.pass(COALESCE_MS);
  clock.reads.seen();
  await clock.pass(40_000);
  assert.equal(clock.asked, 2, 'nothing asked before the wait is out');
  await clock.pass(60_000 - COUNTING_MS - COALESCE_MS - 40_000 + 100);
  assert.equal(clock.asked, 3, 'one read at its time');
  await clock.fail(thrown('database disk image is malformed', 500));
  await clock.pass(COUNTING_MS);
  assert.equal(clock.asked, 4);
});

test('M13: Settings draws its read\'s failure whole: a browser\'s Try again, a hosted wait\'s words, a cold page\'s lack', async () => {
  /** @param {import('../public/lib/host.js').HostState | null} state @param {import('../public/ui/connectors/settings.js').StorageReads} storage */
  const markupOf = (state, storage) => {
    const detail = settingsDetail({ report: REPORT, models: null, state, id: 'settings/storage', opened: OPENED, subscriptions: null,
      storage });
    assert.ok(detail);
    return detailMarkup(detail, AT_REST);
  };
  const reread = /data-cn-do="\{&quot;reread&quot;:&quot;storage&quot;\}"/u;
  let asked = 0;
  const browser = storageReads({ fetch: () => {
    asked += 1;
    return Promise.reject(new TypeError('Failed to fetch'));
  }, draw: () => undefined, later: () => null, cancel: () => undefined });
  browser.shown(true);
  await new Promise(done => setImmediate(done));
  const lost = markupOf(null, { read: null, drawn: browser.drawn });
  assert.ok(lost.includes(WORDS.failed) && reread.test(lost), 'the lack with Try again');
  browser.again();
  await new Promise(done => setImmediate(done));
  assert.equal(asked, 2, 'Try again reads Storage again');
  const reach = pageReach({ follow: listener => {
    listener({ reach: REACH_STATES.answering });
    return () => undefined;
  }, act: () => new Promise(() => undefined) });
  const hosted = storageReads({ fetch: () => Promise.reject(Object.assign(new Error('no room'), { status: 503, code: 'DISK_LOW', retryAfter: 60 })),
    draw: () => undefined, later: () => null, cancel: () => undefined, reach });
  hosted.shown(true);
  await new Promise(done => setImmediate(done));
  assert.equal(hosted.drawn?.kind, 'wait');
  const waiting = markupOf(HOST_STATE, { read: null, drawn: hosted.drawn });
  assert.ok(waiting.includes(esc(DOOR_WORDS.DISK_LOW)), 'the wait\'s words');
  assert.ok(!waiting.includes('ck-lacks') && !reread.test(waiting), 'no lack shown, nothing to press');
  const away = { ...HOST_STATE, reach: REACH_STATES.unreachable };
  for (const drawn of [{ kind: /** @type {const} */ ('reach') }, null]) {
    const cold = markupOf(away, { read: null, drawn });
    assert.ok(cold.includes('ck-lacks') && cold.includes(WORDS.notHere), `the lack for reach (${drawn ? 'failed' : 'reading'})`);
  }
});
