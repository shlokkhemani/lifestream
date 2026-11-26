// @ts-check
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createViewer } from '../server.mjs';
import { launchChrome } from './chrome.mjs';
import { stacked } from './png.mjs';
import { openDoor } from '../lib/door.mjs';
import { actHome } from '../test/stand-ins/act-home.mjs';
import { FULL_DAY, FULL_PERSON, FULL_PERSON_NAME, FULL_WORDS, ZONE, fullLife } from '../test/stand-ins/full-life.mjs';
import { placesHome } from '../test/stand-ins/places-home.mjs';
import { allScreens, screenPrelude } from '../test/stand-ins/all-screens.mjs';
import { hostScript, onboardingHome } from '../test/stand-ins/onboarding-home.mjs';
import { DEMO_NOW, DEMO_PICTURES, demoDoor, demoPeople, demoScreens, doorAnswers, phoneAnswers } from './demo.mjs';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const demo = process.argv.includes('--demo');
const all = process.argv.includes('--all') || demo;
const OUT = demo ? join(REPO, 'docs', 'images') : join(REPO, 'dashboard', '.build', all ? 'shots-all' : 'shots');
const mac = process.argv.includes('--mac');
const phone = demo && process.argv.includes('--phone');
const SIZES = mac ? [[1440, 900]] : [[2560, 1440], [1440, 900], [1024, 700]];
const THEMES = ['dark', 'light'];
const serve = process.argv.includes('--serve');
const kit = process.argv.includes('kit');
const settingsShots = process.argv.includes('settings');
const reading = process.argv.includes('reading');
const acting = process.argv.includes('act');
const named = process.argv.slice(2).filter(arg => !arg.startsWith('--') && !['kit', 'settings', 'reading', 'act'].includes(arg));
const DRAWN = `(() => {
  const main = document.querySelector('#main');
  const sight = frame => {
    let { top, bottom, left, right } = frame.getBoundingClientRect();
    [top, left, bottom, right] = [Math.max(top, 0), Math.max(left, 0), Math.min(bottom, innerHeight), Math.min(right, innerWidth)];
    for (let box = frame.parentElement; box && bottom > top && right > left; box = box.parentElement) {
      if (getComputedStyle(box).overflow === 'visible') continue;
      const clip = box.getBoundingClientRect();
      [top, left, bottom, right] = [Math.max(top, clip.top), Math.max(left, clip.left), Math.min(bottom, clip.bottom), Math.min(right, clip.right)];
    }
    return bottom > top && right > left;
  };
  const maps = [...document.querySelectorAll('[data-map]')].filter(sight);
  return Boolean(main && main.children.length && !main.querySelector('.ck-loading, :scope:not(.gallery) .ck-reading'))
    && maps.every(frame => frame.dataset.drawn !== undefined || frame.dataset.failed !== undefined);
})()`;
const HOST_READ = `Object.assign(window.lifestreamHost.state, { unit: 'macbook-pro-0001', agents: { agents: [], public: null } });`;
const FULL_HOST_READ = `Object.assign(window.lifestreamHost.state, { unit: 'macbook-pro-0001', agents: { agents: [{ id: 'agent-a', name: 'Claude' }], public: null } });`;
const HOLD = `document.getAnimations().forEach(animation => { animation.pause(); animation.currentTime = 10000; });
  try { document.styleSheets[0]?.insertRule('input, textarea { caret-animation: manual; }'); } catch {}`;

/** @typedef {{ route: (home: { day: string, conversation: string }) => string, holds: string[], framed: string, boxes: [string, string][], waits?: number }} Reading */
/** @type {[string, string][]} */
const SEARCH_FRAME = [['top', '.sx-top'], ['field', '.sx-field'], ['end', '.sx-field__end'], ['chips', '[data-search-chips]'],
  ['chip', '[data-search-chips] .ck-fchip'], ['list', '.sx-list']];
/** @type {Record<string, Reading>} */
const READING = {
  connectors: {
    route: () => '#view=connectors',
    holds: ['*/api/page/connectors*'],
    framed: '.ck-page.ck-reading',
    boxes: [
      ['bar', '.ck-page__bar'], ['search', '.ck-page__bar .ck-search'], ['pill', '.ck-page__bar .ck-fmenu'], ['add', '.ck-page__bar .ck-btn'],
      ['alerts', '.cn-alerts'], ['side label', '.ck-page__side .ck-section'],
      ['side row', '.ck-side__row'], ['side name', '.ck-side__name'], ['list', '.cn-list'],
    ],
  },
  people: {
    route: () => '#view=people',
    holds: ['*/api/life/people'],
    framed: '.pp.ck-reading',
    boxes: [
      ['bar', '.ck-page__bar'], ['search', '.ck-page__bar .ck-search'], ['views', '.ck-views'], ['view', '.ck-views__opt'],
      ['list group', '.pp-main .pp-group'],
    ],
  },
  person: {
    route: () => `#view=people&focus=${encodeURIComponent('jid:15550000001@s.whatsapp.net')}`,
    holds: ['*/api/page/person?*'],
    framed: '.pp.ck-reading .pp-figure',
    boxes: [
      ['bar', '.ck-page__bar'], ['back', '.ck-page__back'], ['head', '.pp-head'], ['face', '.pp-head .ck-mono'],
      ['title', '.pp-head__title'], ['line', '.pp-head__line'], ['figure', '.pp-figure'], ['weeks', '.pp-figure .ck-week__days'],
      ['ends', '.pp-figure .ck-week__ends'], ['talk label', '.pp-talk > .ck-section'], ['talk line', '.pp-talk__when'],
      ['side label', '.pp-side .ck-section'], ['list talk', '.pp-talk .ck-thread'],
    ],
  },
  places: {
    route: () => '#view=places',
    holds: ['*/api/life/places'],
    framed: '.pl.ck-reading',
    boxes: [
      ['map', '.pl-stage__map'], ['card', '.pl-card'], ['search', '.pl-card .ck-search'], ['views', '.pl-card .ck-views'],
      ['view', '.pl-card .ck-views__opt'], ['foot', '.pl-card__foot'], ['list group', '.pl-card .pl-group'],
    ],
  },
  place: {
    route: () => '#view=places&focus=fixture-climbing-hall',
    holds: ['*/api/life/places?slug=*'],
    framed: '.pl.ck-reading .pl-page',
    boxes: [
      ['map', '.pl-stage__map'], ['card', '.pl-card'], ['back', '.pl-card__back'], ['edit', '.pl-card__nav .ck-btn'],
      ['title', '.pl-card__title'], ['line', '.pl-card__line'], ['rhythm', '.pl-rhythm'],
      ['photos label', '.pl-page > .pl-part:first-of-type .ck-section'], ['photos', '.pl-page .ck-photos'],
      ['photo', '.pl-page .ck-photo'],
    ],
  },
  trips: {
    route: () => '#view=places&seg=trips',
    holds: ['*/api/life/where?*', '*/api/life/atlas'],
    framed: '.pl.ck-reading .pp-stats',
    boxes: [
      ['bar', '.ck-page__bar'], ['search', '.ck-page__bar .ck-search'], ['year', '.ck-page__bar .ck-step'], ['views', '.ck-views'],
      ['view', '.ck-views__opt'], ['map', '.pp-map'], ['figures', '.pp-stats'], ['figure', '.pp-stat'],
      ['list trips', '.pp-main .pp-group'],
    ],
  },
  days: {
    route: home => `#view=days&on=${home.day}`,
    holds: ['*/api/page/day?*'],
    framed: '.dy.ck-reading',
    boxes: [
      ['bar', '.dy-bar'], ['title', '.dy-title'], ['tools', '.dy-bar .ck-page__tools'], ['list', '.dy-list'], ['side', '.dy-side'],
    ],
  },
  'days-moment': {
    route: home => `#view=days&on=${home.day}&focus=${home.conversation}`,
    holds: ['*/api/page/moment?*'],
    framed: '.dy-panel.ck-reading',
    waits: 2,
    boxes: [
      ['panel', '.dy-panel'], ['tile', '.ck-inspector__tile'],
      ['title', '.ck-inspector__title'], ['meta', '.ck-inspector__meta'], ['close', '.ck-inspector__close'],
    ],
  },
  'days-thread': {
    route: home => `#view=days&on=${home.day}&focus=${home.conversation}`,
    holds: ['*/api/life/extract?*'],
    framed: '.dy-v__thread.ck-reading',
    waits: 0,
    boxes: [
      ['head', '.ck-inspector__head'], ['title', '.ck-inspector__title'], ['body', '.ck-inspector__body'],
      ['list thread', '.dy-v__thread'],
    ],
  },
  search: {
    route: () => '#view=search&q=synthetic',
    holds: ['*/api/search*'],
    framed: '.sx.ck-reading',
    boxes: SEARCH_FRAME,
  },
  'search-hits': {
    route: () => '#view=search&q=subject',
    holds: ['*/api/search*'],
    framed: '.sx.ck-reading',
    boxes: [
      ...SEARCH_FRAME, ['label', '.sx-list .sx-kind:first-child .sx-kind__head, .sx-list .sx-kind:first-child > .ck-section'],
      ['row', '.sx-list .sx-kind:first-child .ck-trow:first-child'],
      ['row top', '.sx-list .sx-kind:first-child .ck-trow:first-child .ck-trow__top'],
      ['row line', '.sx-list .sx-kind:first-child .ck-trow:first-child .ck-trow__line'],
    ],
  },
  'search-none': {
    route: () => '#view=search&q=zzqqxx',
    holds: ['*/api/search*'],
    framed: '.sx.ck-reading',
    boxes: SEARCH_FRAME,
  },
};

const WATCH_WAIT = `window.waitShownAt = 0; (function watch() {
  for (const line of document.querySelectorAll('.ck-sk-wait')) {
    if (!window.waitShownAt && Number(getComputedStyle(line).opacity) > 0) window.waitShownAt = performance.now();
  }
  if (!window.waitShownAt) requestAnimationFrame(watch);
})()`;
const WAITS = `(() => ({
  patience: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--duration-patience')),
  lines: [...document.querySelectorAll('.ck-sk-wait')].map(line => {
    const root = line.closest('.ck-root');
    const shapes = [...(root?.querySelectorAll('.ck-sk') ?? [])].filter(shape => shape.closest('.ck-root') === root
      && shape.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING);
    const lowest = Math.max(...shapes.map(shape => shape.getBoundingClientRect().bottom));
    return { opacity: Number(getComputedStyle(line).opacity), afterRows: line.getBoundingClientRect().top >= lowest - 0.5 };
  }),
}))()`;

/** @param {Reading} section */
const boxesOf = section => `(() => {
  const boxes = {};
  for (const [name, selector] of ${JSON.stringify(section.boxes)}) {
    document.querySelectorAll(selector).forEach((element, at) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      boxes[name + ' ' + at] = [x, y, width, height].map(Math.round);
    });
  }
  return boxes;
})()`;

if (kit) {
  await shootKit();
  process.exit(0);
}
if (settingsShots) {
  await shootSettings();
  process.exit(0);
}

const child = spawn(process.execPath, ['--import', 'tsx', '--import', './testing/process.mjs', join('packages', 'home', 'test', 'dashboard-home.ts')], {
  cwd: REPO, stdio: ['pipe', 'pipe', 'inherit'],
});
/** @type {{ url: string, tokens: { reader: string }, day: string }} */
const home = await new Promise((done, fail) => {
  child.once('exit', code => fail(new Error(`the synthetic home exited with ${code}`)));
  createInterface({ input: /** @type {import('node:stream').Readable} */ (child.stdout) }).on('line', text => {
    const line = JSON.parse(text);
    if (line.ready) done(line);
  });
});
const dir = await mkdtemp(join(tmpdir(), 'dashboard-shots-'));
const front = acting ? await actHome({ door: { url: home.url, token: home.tokens.reader }, importing: await audioSource(home) })
  : await placesHome({ door: { url: home.url }, now: demo ? DEMO_NOW : Date.now() });
const door = openDoor({ url: front?.url ?? home.url, token: () => home.tokens.reader });
const viewer = await createViewer({ door });
await new Promise(done => viewer.listen(0, '127.0.0.1', () => done(undefined)));
const url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (viewer.address()).port}`;
const fuller = front && !acting ? await fullLife({ door: { url: front.url }, ...demo ? { people: demoPeople } : {} }) : null;
const shown = fuller && demo ? await demoDoor({ door: fuller }) : null;
const fullDoor = fuller ? openDoor({ url: (shown ?? fuller).url, token: () => home.tokens.reader }) : null;
const fullViewer = fullDoor ? await createViewer({ door: fullDoor }) : null;
if (fullViewer) await new Promise(done => fullViewer.listen(0, '127.0.0.1', () => done(undefined)));
const fullUrl = fullViewer ? `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (fullViewer.address()).port}` : '';

async function stop() {
  await new Promise(done => viewer.close(() => done(undefined)));
  if (fullViewer) await new Promise(done => fullViewer.close(() => done(undefined)));
  await shown?.close();
  await fuller?.close();
  await front?.close();
  child.stdin?.write(`${JSON.stringify({ cmd: 'stop' })}\n`);
  await new Promise(done => child.once('exit', done));
  await rm(dir, { recursive: true, force: true });
}

/** @param {string} path */
const read = async path => (await fetch(`${url}${path}`)).json();

/** @param {import('../public/pages.js').Day} page */
const talkOf = page => {
  const rows = [...page.all_day, ...page.chapters.flatMap(chapter => chapter.blocks.flatMap(block => block.rows)), ...page.also?.rows ?? [], ...page.plans];
  return rows.find(row => row.kind === 'conversation') ?? rows[0];
};

if (all) {
  const onboarding = await onboardingHome({ door: { url: home.url, token: home.tokens.reader }, day: home.day });
  const onboardingDoor = openDoor({ url: onboarding.url, token: () => home.tokens.reader });
  const onboardingViewer = await createViewer({ door: onboardingDoor });
  const listen = (/** @type {import('node:http').Server} */ server) => new Promise(done => server.listen(0, '127.0.0.1', () =>
    done(`http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`)));
  const bases = { home: url, full: fullUrl, onboarding: await listen(onboardingViewer) };
  const day = await (await fetch(`${/** @type {{ url: string }} */ (shown ?? fuller).url}/v1/days/${FULL_DAY}`)).json();
  const every = await allScreens({ bases, home, front, onboarding, FULL_DAY, FULL_PERSON, day });
  const screens = demo ? demoScreens(every) : every;
  await mkdir(OUT, { recursive: true });
  if (!demo) await writeFile(join(OUT, 'screens.json'), `${JSON.stringify(screens.map(({ section, name, title, width, optional, note }) => ({ section, name, title, width, optional, note })), null, 2)}\n`);
  const wanted = screens.filter(screen => !named.length || named.includes(screen.name) || named.includes(screen.section));
  if (phone && fuller) {
    const chat = screens.find(screen => screen.name === 'chat');
    await shootPhone(fuller, home.tokens.reader, chat ? phoneAnswers(doorAnswers(chat)) : new Map());
    await new Promise(done => onboardingViewer.close(() => done(undefined)));
    await onboarding.close();
    await stop();
    process.exit(0);
  }
  const chrome = await openChrome(join(dir, 'chrome'));
  /** @type {Record<string, unknown>} */
  const ran = {};
  for (const screen of wanted) {
    screen.arm?.();
    const hostSource = screen.host === null ? '' : `${hostScript(screen.host)}`;
    const before = `${screenPrelude(screen)}\n${hostSource}`;
    const taken = await chrome.take(`${bases[screen.base ?? 'full']}/${screen.hash}`, { ...screen, before,
      file: (/** @type {string} */ theme, /** @type {boolean} */ whole) => join(OUT, demo ? `${screen.name}-${theme}.png`
        : whole ? `${screen.name}-whole-${theme}.png` : `${screen.name}-${screen.width ?? 1440}x900-${theme}.png`) })
      .catch((/** @type {Error} */ error) => ({ failed: error.message }));
    ran[screen.name] = taken;
    console.log(`${screen.name}: ${JSON.stringify(taken)}`);
    screen.disarm?.();
  }
  await chrome.close();
  if (!demo) await writeFile(join(OUT, `run-${wanted[0]?.name ?? 'none'}.json`), `${JSON.stringify(ran, null, 2)}\n`);
  await new Promise(done => onboardingViewer.close(() => done(undefined)));
  await onboarding.close();
  await stop();
  process.exit(0);
}

if (serve) {
  console.log(`The dashboard over the synthetic home: ${url}/#view=days&on=${home.day}`);
  console.log(`Over one full day: ${fullUrl}/#view=days&on=${FULL_DAY}`);
  process.on('SIGINT', () => void stop().then(() => process.exit(0)));
} else if (acting && front) {
  await mkdir(OUT, { recursive: true });
  /** @type {Record<string, unknown>} */
  const told = {};
  /** @type {string[]} */
  const unmet = [];
  try {
    const chrome = await openChrome(join(dir, 'chrome'));
    try {
      for (const hosted of [false, true]) {
        const run = hosted ? 'chrome-hosted' : 'chrome';
        front.reset();
        told[run] = await pressed(chrome.page(hosted, name => join(OUT, `act-${run}-${name}.png`)), front, url, run, hosted,
          unmet);
      }
    } finally {
      await chrome.close();
    }
    if (process.argv.includes('--webkit')) {
      front.reset();
      const webkit = await openWebKit(dir);
      try {
        told.webkit = await pressed(webkit, front, url, 'webkit', true, unmet);
      } finally {
        await webkit.close();
      }
    }
  } finally {
    await writeFile(join(OUT, 'act-states.json'), `${JSON.stringify({ unmet, runs: told }, null, 2)}\n`);
    await stop();
  }
  console.log(join(OUT, 'act-states.json'));
  console.log(unmet.length ? `unmet:\n${unmet.join('\n')}` : 'every check met');
  if (unmet.length) process.exitCode = 1;
} else if (reading) {
  const conversation = talkOf(await read(`/api/page/day?day=${home.day}`))?.key ?? '';
  await mkdir(OUT, { recursive: true });
  const chrome = await openChrome(join(dir, 'chrome'));
  let failed = false;
  for (const [name, section] of Object.entries(READING).filter(([name]) => !named.length || named.includes(name))) {
    const address = `${url}/${section.route({ day: home.day, conversation })}`;
    /** @type {Record<string, unknown>} */
    const told = {};
    for (const theme of THEMES) {
      const shot = (/** @type {string} */ state) => join(OUT, `${name}-${state}-1440x900-${theme}.png`);
      const taken = await chrome.held(address, section, { width: 1440, height: 900, theme,
        reading: shot('reading'), read: shot('read') }).catch((/** @type {Error} */ error) => error);
      if (taken instanceof Error) {
        failed = true;
        told[theme] = { unmet: taken.message };
        console.log(`${name}, ${theme}: ${taken.message}`);
        continue;
      }
      const { before, after, wait } = taken;
      const both = Object.keys(before).filter(part => part in after && !part.startsWith('list'));
      const changed = both.filter(part => JSON.stringify(before[part]) !== JSON.stringify(after[part]));
      const arrived = Object.keys(after).filter(part => !(part in before));
      const waits = section.waits ?? 1;
      const unmet = [
        wait.held.lines.length !== waits && `${wait.held.lines.length} lines said the wait, not ${waits}`,
        waits && wait.shownAt < wait.held.patience && `the wait showed at ${Math.round(wait.shownAt)} ms`,
        wait.held.lines.some(line => line.opacity !== 1) && 'a line said the wait only in part',
        wait.held.lines.some(line => !line.afterRows) && 'a line said the wait above a skeleton row',
        wait.landed !== 0 && `${wait.landed} lines stayed once the read landed`,
      ].filter(Boolean);
      failed ||= changed.length > 0 || unmet.length > 0;
      told[theme] = { reading: before, read: after, moved: changed, arrived,
        waiting: { shownAtMs: Math.round(wait.shownAt), patienceMs: wait.held.patience, held: wait.held.lines,
          landed: wait.landed, unmet } };
      console.log(`${shot('reading')}\n${shot('read')}\n${changed.length ? `moved: ${changed.join(', ')}` : 'nothing moved'}`
        + `${arrived.length ? `; arrived with the read: ${arrived.join(', ')}` : ''}`
        + `; ${unmet.length ? unmet.join(', ') : waits ? `the wait said from ${Math.round(wait.shownAt)} ms` : 'no wait said'}`);
    }
    const fast = await chrome.quick(address, section, { width: 1440, height: 900, theme: 'dark', after: 250 })
      .catch((/** @type {Error} */ error) => error);
    failed ||= fast instanceof Error || fast.bar !== 0 || fast.wait !== 0;
    told.answeredIn250ms = fast instanceof Error ? { unmet: fast.message }
      : { mostABarShowed: fast.bar, mostTheWaitShowed: fast.wait };
    const showed = fast instanceof Error ? fast.message
      : `the most a bar showed was ${fast.bar}, the wait's line ${fast.wait}`;
    console.log(`${name}, a read answered in 250 ms: ${showed}`);
    await writeFile(join(OUT, `${name}-reading.json`), `${JSON.stringify(told, null, 2)}\n`);
  }
  await chrome.close();
  await stop();
  if (failed) process.exitCode = 1;
} else {
  const open = talkOf(await read(`/api/page/day?day=${home.day}`));
  const people = await read('/api/life/people');
  const person = people.people?.[0]?.id;
  const report = await read('/api/page/connectors');
  const FULL_EPISODE = talkOf(await (await fetch(`${fullUrl}/api/page/day?day=${FULL_DAY}`)).json())?.key ?? '';
  const connected = report.connectors.filter(connector => connector.set_up && connector.type !== null && !connector.roads.every(road => road === 'phone'));
  const detail = (connected.find(connector => connector.figure && connector.copies.length)
    ?? connected[0] ?? report.connectors[0])?.id;
  /** @type {[string, string, string?, { arm?: () => void, hosted?: boolean, once?: boolean, full?: boolean }?][]} */
  const routes = [
    ['ask', '#view=ask'],
    ['days', `#view=days&on=${home.day}`],
    ['days-episode', `#view=days&on=${home.day}${open ? `&focus=${open.key}` : ''}`],
    ['people', '#view=people'],
    ...(person ? /** @type {[string, string][]} */ ([['person', `#view=people&focus=${encodeURIComponent(person)}`]]) : []),
    ['faces', '#view=people&focus=faces'],
    ['places', '#view=places'],
    ['cities', '#view=places&seg=cities'],
    ['city', `#view=places&seg=cities&focus=${encodeURIComponent('city:Lisbon')}`],
    ['trips', '#view=places&seg=trips'],
    ['place-regular', '#view=places&focus=fixture-climbing-hall'],
    ['place-once', '#view=places&focus=fixture-noodle-bar'],
    ['place-home', '#view=places&focus=fixture-hill-studio'],
    ['naming', '#view=places&focus=name'],
    ['naming-typed', '#view=places&focus=name', `(() => {
      const field = document.querySelector('.pl-name input');
      field.value = 'Lantern';
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`],
    ['naming-home', '#view=places&focus=name', `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight',
      bubbles: true }))`],
    ['naming-refused', '#view=places&focus=name', `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter',
      bubbles: true }))`, { arm: () => {
        if (front && 'refuse' in front) front.refuse('Lifestream is starting up. Try again in a moment.');
      } }],
    ['naming-mac', '#view=places&focus=name', undefined, { hosted: true }],
    ['naming-finish', '#view=places&focus=name', `(() => {
      for (const key of ['Enter', 'Escape']) document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    })()`, { once: true }],
    ['naming-spot', `#view=places&focus=${encodeURIComponent('spot:41.1495,-8.6108')}`],
    ['hidden', '#view=places&focus=hidden'],
    ['search', '#view=search&q=synthetic'],
    ['connectors', '#view=connectors'],
    ...(detail ? /** @type {[string, string][]} */ ([['connectors-detail',
      `#view=connectors&dialog=${encodeURIComponent(detail)}`]]) : []),
    ['days-full', `#view=days&on=${FULL_DAY}`, undefined, { full: true }],
    ['days-episode-full', `#view=days&on=${FULL_DAY}&focus=${FULL_EPISODE}`, undefined, { full: true }],
    ['people-full', '#view=people', undefined, { full: true }],
    ['person-full', `#view=people&focus=${encodeURIComponent(FULL_PERSON)}`, undefined, { full: true }],
    ['search-full', `#view=search&q=${FULL_WORDS}`, undefined, { full: true }],
    ['search-person-full', `#view=search&q=${encodeURIComponent(FULL_PERSON_NAME)}`, undefined, { full: true }],
    ['ask-full', '#view=ask', undefined, { full: true }],
    ['connectors-full', '#view=connectors', undefined, { full: true }],
  ];
  await mkdir(OUT, { recursive: true });
  const chrome = await openChrome(join(dir, 'chrome'));
  for (const [name, hash, then, { arm, hosted, once, full } = {}] of routes.filter(([name]) => !named.length || named.includes(name))) {
    for (const [width, height] of SIZES) {
      for (const theme of THEMES) {
        const file = join(OUT, `${name}-${width}x${height}-${theme}.png`);
        arm?.();
        const drawn = await chrome.shoot(`${full ? fullUrl : url}/${hash}`, { width, height, theme, file, then, full,
          hosted: hosted || (mac && !process.argv.includes('--browser')), scale: mac ? 2 : 1,
          stay: once && theme !== THEMES[0] });
        console.log(drawn ? file : `${file} (still reading when shot)`);
      }
    }
  }
  await chrome.close();
  await stop();
}

/**
 * @param {{ url: string }} life
 * @param {string} token
 * @param {Map<string, unknown>} answers
 */
async function shootPhone(life, token, answers) {
  const door = await demoDoor({ door: life, token, answers });
  const pictures = DEMO_PICTURES.filter(picture => !named.length || named.includes(picture.name));
  const shoot = spawn(join(REPO, 'ios-app', 'shoot.sh'), [...pictures.map(picture => picture.phone), '--',
    '--ui-test-door', door.url, '--ui-test-now', String(DEMO_NOW), '--ui-test-scroll', '0'], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, SIMCTL_CHILD_TZ: ZONE } });
  /** @type {string[]} */
  const shots = [];
  createInterface({ input: /** @type {import('node:stream').Readable} */ (shoot.stdout) }).on('line', line => {
    if (line.endsWith('.png')) shots.push(line);
    else console.log(line);
  });
  const code = await new Promise(done => shoot.once('exit', done));
  await door.close();
  if (code !== 0) throw new Error(`ios-app/shoot.sh exited with ${code}`);
  await mkdir(OUT, { recursive: true });
  for (const [at, picture] of pictures.entries()) {
    const file = join(OUT, `phone-${picture.name}-dark.png`);
    await copyFile(shots[at], file);
    console.log(file);
  }
}

async function shootKit() {
  const scratch = await mkdtemp(join(tmpdir(), 'dashboard-kit-shots-'));
  const gallery = await createViewer();
  await new Promise(done => gallery.listen(0, '127.0.0.1', () => done(undefined)));
  const address = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (gallery.address()).port}`;
  await mkdir(OUT, { recursive: true });
  const chrome = await openChrome(join(scratch, 'chrome'));
  for (const width of [1440, 390]) {
    for (const theme of THEMES) {
      const file = join(OUT, `kit-${width}-${theme}.png`);
      const drawn = await chrome.shoot(`${address}/kit-gallery.html`, { width, height: 900, theme, file, whole: true });
      console.log(drawn ? file : `${file} (still drawing when shot)`);
    }
  }
  await chrome.close();
  await new Promise(done => gallery.close(() => done(undefined)));
  await rm(scratch, { recursive: true, force: true });
}

async function shootSettings() {
  const scratch = await mkdtemp(join(tmpdir(), 'dashboard-settings-shots-'));
  const gallery = await createViewer();
  await new Promise(done => gallery.listen(0, '127.0.0.1', () => done(undefined)));
  const address = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (gallery.address()).port}`;
  await mkdir(OUT, { recursive: true });
  const chrome = await openChrome(join(scratch, 'chrome'));
  for (const theme of THEMES) {
    for (const file of await chrome.windows(`${address}/kit-gallery.html`, { theme, dir: OUT, only: named })) console.log(file);
  }
  await chrome.close();
  await new Promise(done => gallery.close(() => done(undefined)));
  await rm(scratch, { recursive: true, force: true });
}

/** @param {string} profile */
async function openChrome(profile) {
  const chrome = await launchChrome({ profile, args: ['--disable-gpu', '--enable-unsafe-swiftshader',
    ...all && !process.argv.includes('--tiles') ? ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] : []] });
  const { send } = chrome;
  /** @param {number} ms */
  const pause = ms => new Promise(done => setTimeout(done, ms));
  /** @type {string[]} */
  const held = [];
  chrome.on('Fetch.requestPaused', params => held.push(params.requestId));
  /** @param {string} expression */
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true }))
    .result?.value;
  /**
   * @param {() => Promise<boolean>} holds
   * @param {string} what
   */
  const waitFor = async (holds, what) => {
    for (let tries = 0; tries < 100; tries += 1) {
      if (await holds()) return;
      await pause(100);
    }
    throw new Error(`ten seconds and still not: ${what}`);
  };
  /**
   * @param {string} expression
   * @param {string} what
   */
  const until = (expression, what) => waitFor(async () => await evaluate(expression) === true, what);
  /**
   * @param {string} address
   * @param {Reading} section
   * @param {{ width: number, height: number, theme: string }} shot
   */
  const openHeld = async (address, section, { width, height, theme }) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    await send('Page.navigate', { url: 'about:blank' });
    held.length = 0;
    await send('Fetch.enable', { patterns: section.holds.map(urlPattern => ({ urlPattern, requestStage: 'Request' })) });
    await send('Page.navigate', { url: address });
    await waitFor(async () => held.length > 0, `a read of ${section.holds.join(' or ')} asked, to hold`);
  };
  const release = async () => {
    for (const requestId of held.splice(0)) await send('Fetch.continueRequest', { requestId });
    await send('Fetch.disable');
  };
  let stated = '';
  /** @param {string} file */
  const capture = async file => {
    await evaluate(HOLD);
    await pause(100);
    const picture = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(file, Buffer.from(picture.data, 'base64'));
  };
  return {
    /**
     * @param {string} address
     * @param {Reading} section
     * @param {{ width: number, height: number, theme: string, reading: string, read: string }} shot
     * @returns {Promise<{ before: Record<string, number[]>, after: Record<string, number[]>, wait: { shownAt: number, held: { patience: number, lines: { opacity: number, afterRows: boolean }[] }, landed: number } }>}
     */
    async held(address, section, shot) {
      await openHeld(address, section, shot);
      /** @type {Record<string, number[]>} */
      let before;
      let shownAt = 0;
      let waits;
      try {
        await until(`Boolean(document.querySelector(${JSON.stringify(section.framed)}))`,
          `${section.framed} drawn while its read is held`);
        await evaluate(WATCH_WAIT);
        if (section.waits !== 0) await until('window.waitShownAt > 0', '"Waiting for Lifestream." shown while the read is held');
        await pause(1000);
        shownAt = await evaluate('window.waitShownAt');
        before = await evaluate(boxesOf(section));
        if (!Object.keys(before).length) throw new Error('none of the frame\'s boxes drawn while its read is held');
        await capture(shot.reading);
        waits = await evaluate(WAITS);
      } finally {
        await release();
      }
      await until(DRAWN, 'the section drawn with no read under way');
      await pause(500);
      const after = await evaluate(boxesOf(section));
      const landed = await evaluate('document.querySelectorAll(".ck-sk-wait").length');
      await capture(shot.read);
      return { before, after, wait: { shownAt, held: waits, landed } };
    },
    /**
     * @param {string} address
     * @param {Reading} section
     * @param {{ width: number, height: number, theme: string, after: number }} shot
     */
    async quick(address, section, shot) {
      await openHeld(address, section, shot);
      await evaluate(`window.mostABarShowed = 0; window.mostTheWaitShowed = 0; (function watch() {
        for (const bar of document.querySelectorAll('.ck-sk')) {
          window.mostABarShowed = Math.max(window.mostABarShowed, Number(getComputedStyle(bar).opacity));
        }
        for (const line of document.querySelectorAll('.ck-sk-wait')) {
          window.mostTheWaitShowed = Math.max(window.mostTheWaitShowed, Number(getComputedStyle(line).opacity));
        }
        if (!document.querySelector('.ck-reading') && document.querySelector('.ck-arrive')) return;
        requestAnimationFrame(watch);
      })()`);
      await pause(shot.after);
      await release();
      await until(DRAWN, 'the section drawn with no read under way');
      return /** @type {{ bar: number, wait: number }} */ (await evaluate('({ bar: window.mostABarShowed, wait: window.mostTheWaitShowed })'));
    },
    /**
     * @param {string} address
     * @param {{ theme: string, dir: string, only?: string[] }} shot
     * @returns {Promise<string[]>}
     */
    async windows(address, { theme, dir, only = [] }) {
      await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      await send('Page.navigate', { url: 'about:blank' });
      await send('Page.navigate', { url: address });
      await until(`document.querySelectorAll('[data-shot]').length > 0`, 'the gallery\'s windows drawn');
      await pause(500);
      await evaluate(HOLD);
      /** @type {string[]} */
      const names = (/** @type {string[]} */ (await evaluate(`[...new Set([...document.querySelectorAll('[data-shot]')].map(each => each.dataset.shot))]`)))
        .filter(name => only.length === 0 || only.some(prefix => name.startsWith(prefix)));
      if (names.length === 0) throw new Error(`no gallery window's data-shot starts with ${only.join(' or ')}`);
      /** @type {string[]} */
      const files = [];
      for (const name of names) {
        const box = await evaluate(`(() => { const each = document.querySelector('[data-shot="${name}"]'); each.scrollIntoView();
          const box = each.getBoundingClientRect(); return { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height }; })()`);
        await pause(100);
        const picture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...box, scale: 1 } });
        const file = join(dir, `${name}-${theme}.png`);
        await writeFile(file, Buffer.from(picture.data, 'base64'));
        files.push(file);
        const whole = await evaluate(`(() => { const each = document.querySelector('[data-shot="${name}"]');
          const main = each.querySelector('.cn-set__main'), dialog = each.querySelector('.ck-dialog');
          const more = main ? main.scrollHeight - main.clientHeight : 0;
          if (more <= 0 || !dialog) return null;
          const before = [each.style.height, dialog.style.height];
          each.style.height = (each.offsetHeight + more) + 'px'; dialog.style.height = (dialog.offsetHeight + more) + 'px';
          each.dataset.before = JSON.stringify(before);
          const box = each.getBoundingClientRect(); return { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height }; })()`);
        if (!whole) continue;
        await pause(100);
        const tall = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...whole, scale: 1 } });
        const wholeFile = join(dir, `${name}-whole-${theme}.png`);
        await writeFile(wholeFile, Buffer.from(tall.data, 'base64'));
        files.push(wholeFile);
        await evaluate(`(() => { const each = document.querySelector('[data-shot="${name}"]'); const [a, b] = JSON.parse(each.dataset.before);
          each.style.height = a; each.querySelector('.ck-dialog').style.height = b; delete each.dataset.before; })()`);
      }
      return files;
    },
    /**
     * @param {string} address
     * @param {{ width: number, height: number, theme: string, file: string, whole?: boolean, then?: string, hosted?: boolean, full?: boolean, scale?: number, stay?: boolean }} shot
     */
    async shoot(address, { width, height, theme, file, whole = false, then, hosted = false, full = false, scale = 1, stay = false }) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      if (stay) {
        await pause(2000);
        await evaluate(HOLD);
        await pause(100);
        await writeFile(file, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
        return evaluate(DRAWN);
      }
      await send('Page.navigate', { url: 'about:blank' });
      if (stated) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stated });
      stated = '';
      if (hosted) {
        const source = `${await readFile(join(REPO, 'dashboard', 'tools', 'speed-probe.js'), 'utf8')}\n${full ? FULL_HOST_READ : HOST_READ}`;
        await send('Page.enable');
        stated = (await send('Page.addScriptToEvaluateOnNewDocument', { source })).identifier;
      }
      await send('Page.navigate', { url: address });
      let drawn = false;
      for (let tries = 0; tries < 100 && !drawn; tries += 1) {
        await pause(100);
        drawn = await evaluate(DRAWN) === true;
      }
      await pause(500);
      if (then) {
        await evaluate(then);
        await pause(1500);
      }
      await evaluate(HOLD);
      await pause(100);
      const capture = async () => Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
      if (!whole) {
        await writeFile(file, await capture());
        return drawn;
      }
      /** @type {{ png: Buffer, skip: number }[]} */
      const windows = [];
      for (let top = 0; top < await evaluate('document.documentElement.scrollHeight'); top += height) {
        const at = await evaluate(`(scrollTo(0, ${top}), Math.round(scrollY))`);
        let settled = false;
        for (let tries = 0; tries < 100 && !settled; tries += 1) {
          await pause(100);
          settled = await evaluate(DRAWN) === true;
        }
        drawn &&= settled;
        await evaluate(HOLD);
        await pause(100);
        windows.push({ png: await capture(), skip: (top - at) * scale });
      }
      await writeFile(file, stacked(windows));
      return drawn;
    },
    /**
     * @param {string} address
     * @param {{ before: string, run?: string, raw?: boolean, width?: number, height?: number, whole?: boolean, settle?: number, file: (theme: string, whole: boolean) => string }} screen
     */
    async take(address, { before, run, raw = false, width = 1440, height = 900, whole = true, settle = 700, file }) {
      const size = (/** @type {number} */ tall) => send('Emulation.setDeviceMetricsOverride', { width, height: tall, deviceScaleFactor: 2, mobile: false });
      const themed = (/** @type {string} */ theme) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      /** @param {string} theme @param {boolean} long */
      const snap = async (theme, long) => {
        await themed(theme);
        await pause(settle);
        await evaluate(HOLD);
        await pause(120);
        await writeFile(file(theme, long), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      };
      await size(height);
      await themed('dark');
      await send('Page.navigate', { url: 'about:blank' });
      if (stated) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stated });
      await send('Page.enable');
      stated = (await send('Page.addScriptToEvaluateOnNewDocument', { source: before })).identifier;
      await send('Page.navigate', { url: address });
      let drawn = false;
      for (let tries = 0; tries < 100 && !drawn; tries += 1) {
        await pause(100);
        drawn = await evaluate(raw ? 'Boolean(document.querySelector("#main")?.children.length || document.querySelector("#content")?.children.length)' : DRAWN) === true;
      }
      await pause(600);
      if (run) {
        const done = await send('Runtime.evaluate', { expression: `(async () => {${run}\n})()`, awaitPromise: true, returnByValue: true });
        if (done.exceptionDetails) throw new Error(done.exceptionDetails.exception?.description?.split('\n')[0] ?? done.exceptionDetails.text);
        await pause(500);
      }
      await snap('dark', false);
      await snap('light', false);
      const met = { drawn, title: await evaluate('document.title'), spinner: await evaluate(`Boolean(document.querySelector('#main .ck-loading, #main .ck-reading'))`), tall: 0 };
      if (!whole) return met;
      const extra = await evaluate(`Math.max(0, ...[...document.querySelectorAll('body *')].filter(each => {
        const style = getComputedStyle(each);
        return /auto|scroll/.test(style.overflowY) && each.clientHeight > 80 && each.getClientRects().length && !each.closest('[hidden]');
      }).map(each => each.scrollHeight - each.clientHeight))`);
      if (extra < 24) return met;
      met.tall = Math.min(height + extra, 7900);
      await size(met.tall);
      await pause(1200);
      await snap('dark', true);
      await snap('light', true);
      await size(height);
      return met;
    },
    /**
     * @param {boolean} hosted
     * @param {(name: string) => string} file
     */
    page(hosted, file) {
      return {
        /** @param {string} address */
        async open(address) {
          await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
          await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
          await send('Page.navigate', { url: 'about:blank' });
          if (stated) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stated });
          stated = '';
          if (hosted) {
            const source = await readFile(join(REPO, 'dashboard', 'tools', 'speed-probe.js'), 'utf8');
            await send('Page.enable');
            stated = (await send('Page.addScriptToEvaluateOnNewDocument', { source })).identifier;
          }
          await send('Page.navigate', { url: address });
          await until(DRAWN, 'the page drawn');
        },
        /** @param {string} expression */
        run: (/** @type {string} */ expression) => evaluate(expression),
        /** @param {string} name */
        shot: (/** @type {string} */ name) => capture(file(name)),
      };
    },
    close: chrome.close,
  };
}

/** @param {{ url: string, tokens: { reader: string } }} home */
async function audioSource(home) {
  const report = await (await fetch(`${home.url}/v1/connectors`, { headers: { authorization: `Bearer ${home.tokens.reader}` } })).json();
  return report.connectors.find((/** @type {any} */ row) => row.id === 'audio')?.copies?.[0]?.id ?? 'audio:unit';
}

/**
 * @param {{ open: (address: string) => Promise<void>, run: (expression: string) => Promise<any>, shot: (name: string) => Promise<void> }} page
 * @param {Awaited<ReturnType<typeof actHome>>} front
 * @param {string} url
 * @param {string} name
 * @param {boolean} hosted
 * @param {string[]} unmet
 */
async function pressed(page, front, url, name, hosted, unmet) {
  const ACT_STATE = `(() => {
    document.querySelector('.cn-alerts .ck-strip__more[aria-expanded="false"]')?.click();
    const row = id => {
      const open = document.querySelector('.cn-list .ck-clines__section [data-cn-open="' + id + '"]');
      if (!open) return null;
      const act = open.closest('.ck-cline')?.querySelector('.ck-cline__act');
      return { words: open.getAttribute('aria-label'),
        act: act ? { label: act.textContent.trim(), busy: act.disabled, loader: Boolean(act.querySelector('.ck-spinner')) } : null };
    };
    const dialog = document.querySelector('.ck-dialog');
    const said = dialog?.querySelector('.ck-callout');
    return {
      reading: Boolean(document.querySelector('.ck-page.ck-reading')),
      hosted: Boolean(window.lifestreamHost),
      rows: { gmail: row('gmail'), chatgpt: row('chatgpt'), audio: row('audio') },
      banners: [...document.querySelectorAll('.cn-alerts .ck-strip__title')].map(each => each.textContent),
      said: document.querySelector('.ck-page [data-part="said"]')?.textContent.trim() ?? '',
      dialog: dialog ? { title: dialog.querySelector('.ck-dialog__title')?.textContent,
        said: said?.querySelector('.ck-callout__title')?.textContent ?? '',
        acts: [...(said?.querySelectorAll('.ck-callout__acts button') ?? [])].map(each => ({ label: each.textContent.trim(),
          busy: each.disabled })) } : null,
    };
  })()`;
  /** @type {Record<string, unknown>} */
  const steps = {};
  /** @param {number} ms */
  const pause = ms => new Promise(done => setTimeout(done, ms));
  /**
   * @param {string} step
   * @param {string} what
   * @param {(state: any) => boolean} holds
   */
  const step = async (step, what, holds) => {
    let state;
    for (let tries = 0; tries < 100; tries += 1) {
      state = await page.run(ACT_STATE);
      if (holds(state)) break;
      await pause(100);
    }
    const met = holds(state);
    steps[step] = { what, met, state };
    if (!met) unmet.push(`${name} ${step}: ${what}`);
    await page.shot(step);
    return state;
  };
  /** @param {string} selector */
  const click = selector => page.run(`(() => { const found = document.querySelector(${JSON.stringify(selector)});
    if (found) found.click(); return Boolean(found); })()`);
  const tryNow = '"Try now"';
  await page.open(`${url}/#view=connectors`);
  const GMAIL = 'Couldn’t sync Gmail';
  const CHATGPT = 'Couldn’t sync ChatGPT';
  const AUDIO = 'Couldn’t bring in new items from Audio';
  /** @param {string | undefined} words */
  const stateless = words => !/Stopped|Broken|Needs you/u.test(words ?? '');
  await step('1-needs', `${hosted ? 'with' : 'without'} a host: Gmail, ChatGPT and Audio each a banner in its words; their rows the same words, no state word, Try now and Skip it on them`,
    state => !state.reading && state.hosted === hosted && [GMAIL, CHATGPT, AUDIO].every(words => state.banners.includes(words))
      && state.rows.gmail?.words.includes(GMAIL) && stateless(state.rows.gmail.words) && state.rows.gmail.act?.label === 'Try now'
      && state.rows.chatgpt?.words.includes(CHATGPT) && stateless(state.rows.chatgpt.words) && state.rows.chatgpt.act?.label === 'Try now'
      && state.rows.audio?.words.includes(AUDIO) && stateless(state.rows.audio.words) && state.rows.audio.act?.label === 'Skip it');
  await click('[data-cn-open="gmail"]');
  await step('2-dialog', `Gmail's dialog: its callout the need's words, and ${tryNow}`, state =>
    state.dialog?.title === 'Gmail' && state.dialog.said === GMAIL
    && state.dialog.acts.length === 1 && state.dialog.acts[0].label === 'Try now' && !state.dialog.acts[0].busy);
  await click('.ck-dialog [data-cn-do*="poll:gmail-imap"]');
  await step('3-reading', 'pressed: being read, Reading… on the row, no need and no act there or in the dialog', state =>
    /Gmail.*Reading…/u.test(state.rows.gmail?.words) && state.rows.gmail.act === null && !state.banners.includes(GMAIL)
    && state.dialog?.title === 'Gmail' && state.dialog.said === '' && state.dialog.acts.length === 0);
  front.end('poll:gmail-imap', null);
  await step('4-synced', 'the need gone: the row back to its line, no act, no banner, the dialog with no callout', state =>
    state.rows.gmail !== null && !state.rows.gmail.words.includes(GMAIL) && !/Reading…/u.test(state.rows.gmail.words)
    && state.rows.gmail.act === null && !state.banners.includes(GMAIL) && state.dialog?.title === 'Gmail' && state.dialog.said === '');
  await click('[data-cn-close]');
  await click('.ck-cline__act[data-cn-do*="poll:chatgpt-browser"]');
  await step('5-row-reading', 'ChatGPT pressed on its row: Reading… there, no act', state =>
    /ChatGPT.*Reading…/u.test(state.rows.chatgpt?.words) && state.rows.chatgpt.act === null && state.dialog === null);
  front.end('poll:chatgpt-browser', 'Lifestream tries again in 30 min.');
  await step('6-row-again', `failed again: the need's words with ${tryNow} on its row once more, its banner back`, state =>
    state.rows.chatgpt?.words.includes(CHATGPT) && stateless(state.rows.chatgpt.words) && state.rows.chatgpt.act?.label === 'Try now'
    && !state.rows.chatgpt.act.busy && state.banners.includes(CHATGPT));
  await click('[data-cn-open="chatgpt"]');
  await step('7-again-dialog', `its dialog's callout the need's words, and ${tryNow}`, state => state.dialog?.title === 'ChatGPT'
    && state.dialog.said === CHATGPT && state.dialog.acts[0]?.label === 'Try now');
  await click('[data-cn-close]');
  await click('.ck-cline__act[data-cn-do*="job:import:"]');
  for (let tries = 0; tries < 100 && !front.presses.some(each => each.do === 'skip'); tries += 1) await pause(100);
  await step('8-refused', 'Skip it refused by the home: the row as the home says it again, Skip it ready, no error shown',
    state => state.rows.audio?.words.includes(AUDIO) && state.rows.audio.act?.label === 'Skip it'
      && !state.rows.audio.act.busy && state.said === '');
  return { steps, presses: front.presses.slice() };
}

/** @param {string} scratch */
async function openWebKit(scratch) {
  const binary = join(scratch, 'page-speed');
  await new Promise((done, fail) => spawn('swiftc', ['-O', join(REPO, 'macos-app', 'benchmarks', 'PageSpeed.swift'), '-o', binary],
    { stdio: 'inherit' }).once('exit', code => code === 0 ? done(undefined) : fail(new Error(`swiftc exited with ${code}`))));
  const driver = spawn(binary, [join(REPO, 'dashboard', 'tools', 'speed-probe.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
  /** @type {((line: any) => void)[]} */
  const waiting = [];
  createInterface({ input: /** @type {import('node:stream').Readable} */ (driver.stdout) })
    .on('line', text => waiting.shift()?.(JSON.parse(text)));
  /** @param {object} command @returns {Promise<any>} */
  const ask = command => new Promise(done => {
    waiting.push(done);
    driver.stdin?.write(`${JSON.stringify(command)}\n`);
  });
  return {
    /** @param {string} address */
    open: async address => void await ask({ cmd: 'open', url: address, fresh: true }),
    /** @param {string} expression */
    async run(expression) {
      const answer = await ask({ cmd: 'run', js: expression });
      if ('error' in answer) throw new Error(answer.error);
      return JSON.parse(answer.json);
    },
    shot: async () => undefined,
    async close() {
      const exited = new Promise(done => driver.once('exit', done));
      driver.stdin?.write(`${JSON.stringify({ cmd: 'quit' })}\n`);
      await exited;
    },
  };
}
