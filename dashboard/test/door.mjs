import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { bundledProgram } from '../../testing/program.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createViewer } from '../server.mjs';
import { until } from './until.mjs';
import { TOKEN_FILE, doorSettings, openDoor, seqOf } from '../lib/door.mjs';
import { lifeReader, mediaType } from '../lib/life.mjs';
import { COOKIE, guardRequest, principalGate } from '../lib/principals.mjs';
import { installClock, lookup } from '../public/lib/home-clock.js';
import { clockFor } from './stand-ins/clock.mjs';
import { messagesOf } from '../public/ui/days/messages.js';
import { distanceMeters } from '../public/lib/circle.js';
import { cameraAction, nightOf, whyWords } from '../public/lib/where.js';
import { homeChange } from '../public/ui/live.js';
import { detailMarkup } from '../public/ui/connectors/detail.js';
import { needsOf, rowLine, wholeLine } from '../public/ui/connectors/page.js';
import { standsInImport, wholePage as pageOf } from './stand-ins/whole-page.mjs';
import { esc } from '../public/lib/html.js';
import { detailOf } from '../public/ui/connectors/dialog.js';
import { AT_REST } from '../public/ui/connectors/view.js';
import { SETTINGS_CHROME, SETTINGS_HOME, SETTINGS_IPHONE, SETTINGS_MAC } from '../public/ui/connectors/settings.js';
import { answerPicture, doorBytes, PICTURE_ROUTE, RECIPE } from './stand-ins/pictures.mjs';
import { STATE_ON } from './fixtures/screen.mjs';
import { momentAt, openingOf } from '../public/lib/opening.js';
import { shiftDay } from '../public/lib/words.js';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PLACES = 'places:local:macbook-pro-0001';
const DEVICES = 'devices:local:macbook-pro-0001';
const OWN_CAMERA = 'synthetic-make/own-camera';
const NONE = { query: '', place: '' };
/** @param {any} page */
const rowsOf = page => page.sections.filter((/** @type {any} */ section) => section.key !== 'needs')
  .flatMap((/** @type {any} */ section) => section.faces);
const summary = {};
installClock(clockFor('UTC', 4));
let child;
let home;
let dashboard;
let door;
let url;
let dir;
/** @type {((line: object) => void)[]} */
const waiting = [];

async function command(cmd, more = {}) {
  const answer = new Promise(done => waiting.push(done));
  child.stdin.write(`${JSON.stringify({ cmd, ...more })}\n`);
  const line = await answer;
  assert.equal(line.ok, true, line.error);
  return line.value;
}

async function read(path, expected = 200) {
  const response = await fetch(`${url}${path}`);
  const body = await response.json();
  assert.equal(response.status, expected, JSON.stringify(body));
  return body;
}

const dayPage = day => read(`/api/page/day?${new URLSearchParams({ day })}`);

/** @param {any} page @returns {any[]} */
const dayRows = page => [...page.all_day, ...page.chapters.flatMap((/** @type {any} */ chapter) => chapter.blocks
  .flatMap((/** @type {any} */ block) => block.rows)), ...page.also?.rows ?? [], ...page.plans];

const photosMoment = async () => (await Promise.all(dayRows(await dayPage(home.day))
  .filter(row => row.kind === 'photos').map(row => momentOf(home.day, row.key))))[0];

async function momentOf(day, focus) {
  const answer = await read(`/api/page/moment?${new URLSearchParams({ day, focus })}`);
  assert.equal(answer.state, 'found', `${day} ${focus}`);
  return answer.moment;
}

async function fromDoor(path) {
  const response = await fetch(`${home.url}${path}`, { headers: { authorization: `Bearer ${home.tokens.reader}` } });
  assert.equal(response.status, 200);
  return response.json();
}

function listen() {
  const controller = new AbortController();
  const heard = [];
  const done = (async () => {
    const response = await fetch(`${url}/api/feed`, { signal: controller.signal });
    let text = '';
    for await (const chunk of response.body) {
      text += Buffer.from(chunk).toString('utf8');
      for (let end = text.indexOf('\n\n'); end >= 0; end = text.indexOf('\n\n')) {
        const block = text.slice(0, end);
        text = text.slice(end + 2);
        const event = /^event: (.+)$/mu.exec(block)?.[1] ?? 'message';
        const data = /^data: (.+)$/mu.exec(block)?.[1];
        if (data) heard.push({ event, data: JSON.parse(data) });
      }
    }
  })().catch(() => undefined);
  return { heard, stop: async () => { controller.abort(); await done; } };
}

before(async () => {
  child = spawn(process.execPath, bundledProgram(join('packages', 'home', 'test', 'dashboard-home.ts')), {
    cwd: REPO, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout });
  home = await new Promise((done, fail) => {
    child.once('exit', code => fail(new Error(`the synthetic home exited with ${code}`)));
    lines.on('line', text => {
      const line = JSON.parse(text);
      if (line.ready) done(line);
      else waiting.shift()?.(line);
    });
  });
  dir = await mkdtemp(join(tmpdir(), 'dashboard-door-'));
  await mkdir(join(dir, 'state'));
  door = openDoor(doorSettings(join(dir, 'state'), { LIFESTREAM_DOOR: home.url }));
  dashboard = await createViewer({ door });
  await new Promise(done => dashboard.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${dashboard.address().port}`;
});

const givePass = token => writeFile(join(dir, 'state', TOKEN_FILE), `${token}\n`, { mode: 0o600 });

after(async () => {
  await new Promise(done => dashboard?.close(done));
  if (child) await command('stop').catch(() => undefined);
  if (dir) await rm(dir, { recursive: true, force: true });
  const out = join(tmpdir(), 'lifestream-e2e');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'dashboard-door.json'), `${JSON.stringify(summary, null, 2)}\n`);
});

test('a dashboard started before the home wrote its pass, that reads it only at its start: the sections and Connectors say there is no token, then read on the pass once it is written, the feed too', async () => {
  const feed = listen();
  for (const path of ['/api/life/days', '/api/page/connectors']) {
    const answer = await read(path, 503);
    assert.match(answer.error, /no read token for Lifestream/u);
  }
  await givePass(home.tokens.reader);
  assert.ok((await read('/api/life/days')).length > 0);
  await door.opened();
  await until('the page told to read again as the door\'s feed first opens', () => feed.heard.some(each => each.event === 'reset'));
  await feed.stop();
  summary.pass_written_late = { before: 503, after: 200, feed: 'open', page: 'reset' };
});

test('a day list or a day other than the home\'s: the days the door serves, its day page as the door answers it, each of its rows a moment the panel opens', async () => {
  const days = await read('/api/life/days');
  const served = (await fromDoor('/v1/days')).days;
  assert.deepEqual(days, served.map(entry => ({ day: entry.day, total: entry.counts.total, families: entry.counts.per_family })).reverse());
  const page = await dayPage(home.day);
  assert.deepEqual(page, await fromDoor(`/v1/page/day?${new URLSearchParams({ day: home.day })}`));
  const plain = text => text.replace(/\u00a0/gu, ' ');
  const rows = dayRows(page);
  const moments = await Promise.all(rows.map(row => momentOf(home.day, row.key)));
  const at = name => moments.findIndex(moment => moment.name === name);
  const moment = name => /** @type {any} */ (moments[at(name)]);
  const row = name => /** @type {any} */ (rows[at(name)]);
  assert.equal(moment('Person A').source.atoms, 2);
  assert.deepEqual([moment('Person A').view.view, moment('Person A').view.group], ['thread', false]);
  const thread = await read(`/api/page/thread?${new URLSearchParams({ chat: moment('Person A').view.chat, day: home.day })}`);
  assert.deepEqual(messagesOf(thread).map(message => ({ speaker: message.speaker, words: message.words, mine: message.mine })), [
    { speaker: 'Person A', words: 'synthetic hello one', mine: false },
    { speaker: 'the user', words: 'synthetic reply two', mine: true }]);
  assert.equal(moment('Group Alpha').view.group, true);
  assert.deepEqual([moment('Group Alpha').source.atoms, row('Group Alpha').words, row('Group Alpha').count],
    [3, [{ type: 'quote', text: 'synthetic group line three' }], { kind: 'sent', count: 1 }]);
  assert.deepEqual(page.chapters.flatMap(chapter => chapter.kind === 'stay' || chapter.kind === 'move'
    ? [[chapter.kind, chapter.head.title, plain(chapter.head.length ?? '')]] : []), [
    ['stay', 'Synthetic Home', '3h'], ['move', 'Drive 1.4 km', '9m'],
    ['stay', 'Synthetic Office', '2h 51m'], ['move', 'Drive 1.4 km', '9m'], ['stay', 'Synthetic Home', '1h 48m']]);
  assert.equal(moment('Synthetic subject one').kind, 'mail_sent');
  assert.deepEqual(row('Synthetic subject one').words[0], { type: 'text', text: 'Sent', tone: 'secondary', title: false });
  const received = moments.findIndex(each => each.kind === 'mail_received');
  assert.deepEqual([plain(rows[received].name), rows[received].words], ['1 mail', [{ type: 'list', items: ['Person C'] }]]);
  assert.match(moments[received].view.letters[0].subject, /Synthetic subject two/u);
  const said = (each, n) => ({ kind: each.kind, name: each.name, words: rows[n].words, count: rows[n].count, atoms: each.source.atoms });
  summary.day = { days, rows: moments.map(said) };
});

test('a record pop-up that opens another record or none: an atom\'s record and its extract unit, as the door holds them', async () => {
  const page = await dayPage(home.day);
  const talk = (await Promise.all(dayRows(page).map(row => momentOf(home.day, row.key)))).find(each => each.name === 'Person A');
  const atom = { record: talk.source.records[0], ...talk.source.units[0] };
  const query = new URLSearchParams({ source: atom.record.source, kind: atom.record.kind, key: atom.record.key });
  const record = await read(`/api/life/record?${query}`);
  const held = await fromDoor(`/v1/record?${query}&history=1&text=1`);
  assert.deepEqual({ ...record, position: undefined }, { ...held, position: undefined });
  assert.equal(record.version.content.message.ZTEXT, 'synthetic hello one');
  assert.match(record.text.text, /synthetic hello one/u);
  assert.equal(record.history.length, 1);
  const extract = await read(`/api/life/extract?${new URLSearchParams({ family: atom.family, unit: atom.unit })}`);
  assert.deepEqual(extract.content.messages.map(message => message.key), [atom.record.key, `${atom.record.key.slice(0, -1)}2`]);
  await read('/api/life/record?source=x&kind=msg', 400);
  await read(`/api/life/record?${new URLSearchParams({ source: atom.record.source, kind: atom.record.kind, key: 'nobody' })}`, 404);
  await read('/api/life/extract?family=messages&unit=nobody', 404);
  summary.record = { record: query.toString(), unit: atom.unit, history: record.history.length };
});

test('a photo episode that shows another picture, or one the page must not draw: the image the family chose, byte for byte', async () => {
  const photos = await photosMoment();
  const burst = await fromDoor(`/v1/extracts?${new URLSearchParams({ family: 'photos', unit: photos.source.units[0].unit })}`);
  assert.deepEqual(photos.pictures.map(picture => picture.hash), burst.extracts[0].content.photos.map(photo => `sha256:${photo.sha256}`));
  const [jpeg] = photos.pictures.map(picture => picture.hash);
  await read(`/api/life/picture?${new URLSearchParams({ hash: jpeg, size: 'original' })}`, 400);
  await read(`/api/life/picture?${new URLSearchParams({ hash: '..%2Fsecret', size: 'full' })}`, 400);
  await read(`/api/life/picture?${new URLSearchParams({ hash: jpeg })}`, 400);
  await read(`/api/life/picture?${new URLSearchParams({ hash: jpeg, size: 'huge' })}`, 400);
  await read(`/api/life/picture?${new URLSearchParams({ hash: jpeg, size: 'tile', recipe: 'x' })}`, 400);
  await read(`/api/life/media?hash=${encodeURIComponent(jpeg)}`, 404);
  assert.deepEqual(await read('/api/life/pictures'), await fromDoor('/v1/pictures'));
  for (const gone of [`/api/life/photo?${new URLSearchParams({ unit: 'any', item: `photo:${jpeg.slice('sha256:'.length)}` })}`,
    `/api/life/people/card?hash=${encodeURIComponent(jpeg)}`]) {
    assert.equal((await fetch(`${url}${gone}`)).status, 404, gone);
  }
  summary.photo = { items: photos.pictures.map(picture => picture.hash), bytes: Buffer.from(home.jpeg, 'base64').length };
});

test('people and places invented, merged or misnamed: People the door\'s own, places the door\'s, a stay placed by its point', async () => {
  const people = await read('/api/life/people');
  const unplaced = (/** @type {any} */ { position: _, ...answer }) => answer;
  assert.deepEqual(unplaced(people), unplaced(await fromDoor('/v1/people')));
  const person = name => people.people.find(each => each.name === name);
  assert.deepEqual([person('Person A').by, person('Person A').received, person('Person A').sent], ['contact', 1, 1]);
  assert.deepEqual([person('Person B').by, person('Person B').id, person('Person B').person], ['registry', 'person:person-b', 'person-b']);
  assert.deepEqual(people.people.map(each => each.id).sort(), ['person:person-b', 'phone:+15550000001']);
  assert.equal(people.you?.id, 'phone:+15550000009');
  assert.deepEqual([people.organise.queue, people.others], [['phone:+15550000001'], 1]);
  const group = people.chats.find(chat => chat.group);
  assert.deepEqual([group.label, group.total, group.mine], ['Group Alpha', 3, 1]);
  const places = await read('/api/life/places');
  await heldAgainstDoor(places);
  assert.deepEqual((await read('/api/page/places')).cities, (await fromDoor('/v1/page/places')).cities, 'the page relayed as the door answers it');
  await read('/api/page/nowhere', 404);
  const clock = await read('/api/clock');
  assert.deepEqual(clock, await fromDoor('/v1/clock'));
  const newest = await fromDoor(`/v1/days/${home.day}`);
  assert.deepEqual(lookup(clock, newest.window.start_ms), { day: home.day, zone: newest.zone, ...newest.window });
  assert.deepEqual(places.places.map(({ slug, name, radius_m, ids, stays, days }) => [slug, name, radius_m, ids, stays, days]),
    [['home', 'Synthetic Home', 120, [], 2, 1], ['office', 'Synthetic Office', 120, [], 1, 1]]);
  const { labels } = await fromDoor('/v1/labels');
  assert.deepEqual(labels.places.map(({ slug, ids }) => [slug, ids]), [['home', []], ['office', []]]);
  assert.deepEqual(labels.google, [{ id: 'google:synthetic-place-c', name: 'Synthetic Cafe', latitude: 1, longitude: 1 }]);
  const stays = await placedStays();
  assert.deepEqual(stays.map(stay => stay.place.name), ['Synthetic Home', 'Synthetic Office', 'Synthetic Home']);
  const located = await fromDoor(`/v1/labels?${stays.map(stay => `point=${stay.place.latitude},${stay.place.longitude}`).join('&')}`);
  assert.deepEqual(stays.map(stay => [stay.place.slug, stay.place.name]),
    stays.map(stay => located.places.find(([lat, lon]) => lat === stay.place.latitude && lon === stay.place.longitude).slice(2, 4)));
  assert.deepEqual((await placedTrips()).map(trip => [trip.from.name, trip.to.name]), [
    ['Synthetic Home', 'Synthetic Office'], ['Synthetic Office', 'Synthetic Home']]);
  summary.people = people.people.map(each => ({ id: each.id, name: each.name, by: each.by, received: each.received }));
  summary.places = places.places.map(place => ({ name: place.name, stays: place.stays }));
});

test('E1 E2: People read again on anything but the people event or an import of the owner\'s people, a 304 at another position, or an ask joined across the event', async () => {
  const real = openDoor({ url: home.url, token: () => home.tokens.reader });
  const asks = [];
  /** @type {((message: any) => void)[]} */
  const listeners = [];
  /** @type {Promise<void> | null} */
  let gate = null;
  const counted = {
    ...real,
    follow: listener => {
      listeners.push(listener);
      return () => undefined;
    },
    text: async (path, etag, params) => {
      const answer = await real.text(path, etag, params);
      if (path === '/v1/people') asks.push([params?.id ?? '', etag ? 'etag' : '', answer.status]);
      if (gate) await gate;
      return answer;
    },
  };
  let seq = 0;
  const hear = message => listeners.forEach(listener => listener(message));
  const event = (kind, key, detail = {}) => hear({ kind: 'event', id: String(++seq), data: { seq, at_ms: 0, kind, key, detail } });
  const life = lifeReader(counted);
  try {
    const first = await life.people();
    assert.equal(await life.people(), first);
    assert.deepEqual(asks, [['', '', 200], ['', 'etag', 304]]);
    hear({ kind: 'open' });
    asks.length = 0;
    await life.people();
    for (const [kind, key] of [['extract', 'messages'], ['extract', 'labels'], ['extract', 'mail'], ['import', 'people:local:macbook-pro-0001/x'],
      ['import', 'apple-contacts:local:iphone-aa01/x'], ['import', 'faces:local:macbook-pro-0001/x'], ['erase', ''], ['undo', ''], ['repair', '']]) {
      event(kind, key);
      await life.people();
    }
    assert.deepEqual(asks, [['', 'etag', 304]], 'only an import of the owner\'s people lane reads again: the read joins its heads');
    asks.length = 0;
    const alone = await life.person('person:person-b');
    assert.equal(await life.person('person:person-b'), alone);
    event('extract', 'messages');
    assert.equal(await life.person('person:person-b'), alone);
    assert.deepEqual(asks, [['person:person-b', '', 200]]);
    asks.length = 0;
    event('people', 'people');
    const list = await life.people();
    const one = await life.person('person:person-b');
    assert.deepEqual(asks, [['', 'etag', 304], ['person:person-b', 'etag', 304]]);
    const door = await fromDoor('/v1/people');
    assert.deepEqual([list.position, one.position], [door.position, door.position]);
    assert.deepEqual({ ...list, position: first.position }, first);
    asks.length = 0;
    let release = () => undefined;
    gate = new Promise(done => { release = () => done(undefined); });
    event('people', 'people');
    const before_ = life.person('person:person-b');
    await until('the first ask answered', async () => asks.length === 1);
    event('people', 'people');
    const after_ = life.person('person:person-b');
    release();
    gate = null;
    await Promise.all([before_, after_]);
    assert.deepEqual(asks, [['person:person-b', 'etag', 304], ['person:person-b', 'etag', 304]]);
    await life.person('person:person-b');
    assert.equal(asks.length, 2);
    const kept = (await life.people()).position;
    await life.person('person:person-b');
    asks.length = 0;
    const told = `${seqOf(kept) + 5}:0`;
    event('people', 'people', { position: told, changed: kept });
    const shown = [(await life.people()).position, (await life.person('person:person-b')).position];
    assert.deepEqual(asks, [['', 'etag', 304], ['person:person-b', 'etag', 304]], 'a people event reads again, by its ETag');
    assert.deepEqual(shown, [kept, kept], 'one clock: the list and the person answer the People file\'s position, never the event\'s');
    assert.equal((await fromDoor('/v1/people?id=person%3Aperson-b')).position, kept);
    summary.peopleKept = { asks: [...asks], position: door.position, told };
  } finally {
    real.close();
  }
});

test('E4a: a read after a save waits for the refresh it began, never the answer kept before it; a settled read is kept, and an older one landing after it never replaces it', async () => {
  /** @type {((message: any) => void)[]} */
  const listeners = [];
  /** @type {{ params: any, signal: AbortSignal | undefined, answer: (position: string) => void }[]} */
  const reads = [];
  const door = {
    follow: (/** @type {(message: any) => void} */ listener) => {
      listeners.push(listener);
      return () => undefined;
    },
    position: () => '1:0',
    json: () => new Promise(() => undefined),
    text: (/** @type {string} */ path, /** @type {string | undefined} */ etag, /** @type {any} */ params, /** @type {AbortSignal | undefined} */ signal) =>
      new Promise(resolve => reads.push({ params, signal, answer: position => resolve({ status: 200, etag: `"${position}"`, position,
        text: JSON.stringify({ position, people: [], chats: [] }) }) })),
  };
  const life = lifeReader(/** @type {any} */ (door));
  listeners.forEach(listener => listener({ kind: 'open' }));
  const kept = life.people();
  reads[0].answer('1:0');
  assert.equal((await kept).position, '1:0');
  life.acted('people');
  const refreshing = life.people();
  const after = life.people();
  assert.equal(reads.length, 2, 'the read after the save joins the refresh under way');
  reads[1].answer('2:0');
  assert.deepEqual([(await refreshing).position, (await after).position], ['2:0', '2:0'], 'the answer kept before the save is never served after it');
  const leaving = new AbortController();
  const settled = life.people({ settled: true, signal: leaving.signal });
  assert.deepEqual([reads[2].params, reads[2].signal], [{ settled: '1' }, leaving.signal], 'a settled read goes to the door with its reader\'s signal');
  life.acted('people');
  const plain = life.people();
  reads[2].answer('4:0');
  assert.equal((await settled).position, '4:0');
  reads[3].answer('3:0');
  assert.equal((await plain).position, '4:0', 'an older answer landing after a settled one never replaces it');
  assert.equal((await life.people()).position, '4:0');
  assert.equal(reads.length, 4);
});

test('a page relayed by two reads at once: the one landing last never puts an older answer over the newer one, nor a late 304 its older body', async () => {
  /** @type {{ etag: string | undefined, answer: (reply: any) => void }[]} */
  const reads = [];
  const door = {
    follow: () => () => undefined,
    position: () => '1:0',
    json: () => new Promise(() => undefined),
    text: (/** @type {string} */ _path, /** @type {string | undefined} */ etag) => new Promise(resolve => reads.push({ etag, answer: resolve })),
  };
  const answered = (/** @type {string} */ position) => ({ status: 200, etag: `"${position}"`, position, text: JSON.stringify({ position, at: position }) });
  const same = (/** @type {string} */ position) => ({ status: 304, etag: undefined, position, text: '' });
  const life = lifeReader(/** @type {any} */ (door));
  const first = life.page('people', {});
  reads[0].answer(answered('10:0'));
  assert.equal((await first).position, '10:0');

  const plain = life.page('people', {});
  const settled = life.page('people', {}, { settled: true });
  assert.deepEqual(reads.slice(1).map(read => read.etag), ['"10:0"', '"10:0"'], 'both reads go out on the answer kept before them');
  reads[2].answer(answered('12:0'));
  reads[1].answer(answered('11:0'));
  assert.deepEqual([(await settled).at, (await plain).at], ['12:0', '12:0'], 'the read landing last at 11 keeps the answer at 12 that landed first');
  const next = life.page('people', {});
  assert.equal(reads[3].etag, '"12:0"', 'the next read asks on the newer answer');
  reads[3].answer(same('12:0'));
  assert.equal((await next).at, '12:0');

  const late = life.page('people', {});
  const newer = life.page('people', {});
  reads[5].answer(answered('13:0'));
  reads[4].answer(same('12:0'));
  assert.deepEqual([(await newer).at, (await late).at], ['13:0', '13:0'], 'a 304 landing after a newer answer never restores the body it confirmed');
  const after = life.page('people', {});
  assert.equal(reads[6].etag, '"13:0"');
  reads[6].answer(same('13:0'));
  assert.equal((await after).at, '13:0');
});

test('E5: Places and the people the faces deck reads ask no day list', async () => {
  const real = openDoor({ url: home.url, token: () => home.tokens.reader });
  /** @type {string[]} */
  const asked = [];
  /** @type {((message: any) => void)[]} */
  const listeners = [];
  const counted = {
    ...real,
    follow: listener => {
      listeners.push(listener);
      return () => undefined;
    },
    json: (path, params) => (asked.push(path), real.json(path, params)),
    all: (path, params, member) => (asked.push(path), real.all(path, params, member)),
    each: (path, params, member, visit) => (asked.push(path), real.each(path, params, member, visit)),
    text: (path, etag, params) => (asked.push(path), real.text(path, etag, params)),
  };
  const hear = message => listeners.forEach(listener => listener(message));
  const life = lifeReader(counted);
  try {
    hear({ kind: 'open' });
    await life.places();
    const people = await fromDoor('/v1/people');
    assert.equal(life.peopleNow(), null);
    await until('the people the deck reads', () => life.peopleNow()?.building === false);
    hear({ kind: 'event', id: '1', data: { seq: 1, at_ms: 0, kind: 'people', key: 'people',
      detail: { position: people.position, changed: people.position } } });
    life.peopleNow();
    await until('the people the deck reads, read again', () => life.peopleNow()?.building === false);
    assert.ok(!asked.includes('/v1/days') && asked.every(path => !path.startsWith('/v1/days/')), JSON.stringify(asked));
    summary.noDayList = { asked };
  } finally {
    real.close();
  }
});

test('K1: the dashboard outlives a door restarted with other day settings: the clock read again, a 05:00 message filed under the day before', async () => {
  let clock = clockFor('UTC', 4, { first: '2026-10-01', last: '2026-10-31', id: 'starts-at-4' });
  /** @type {string[]} */
  const reads = [];
  const standIn = createServer((req, res) => {
    const path = new URL(String(req.url), 'http://door').pathname;
    if (path === '/v1/feed') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return void res.write(':\n\n');
    }
    if (path !== '/v1/clock') return void res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
    reads.push(clock.id);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(clock));
  });
  await new Promise(done => standIn.listen(0, '127.0.0.1', () => done(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (standIn.address()).port;
  const client = openDoor({ url: `http://127.0.0.1:${port}`, token: () => 'reader' });
  const viewer = await createViewer({ door: client });
  await new Promise(done => viewer.listen(0, '127.0.0.1', () => done(undefined)));
  const clockAt = async () => (await fetch(`http://127.0.0.1:${viewer.address().port}/api/clock`)).json();
  const early = Date.UTC(2026, 9, 14, 5);
  try {
    const first = await clockAt();
    assert.deepEqual([first.id, lookup(first, early).day], ['starts-at-4', '2026-10-14']);
    clock = clockFor('UTC', 6, { first: '2026-10-01', last: '2026-10-31', id: 'starts-at-6' });
    await new Promise(done => {
      standIn.close(() => done(undefined));
      standIn.closeAllConnections();
    });
    await new Promise(done => standIn.listen(port, '127.0.0.1', () => done(undefined)));
    await until('the clock read again when the feed opened', () => reads.includes('starts-at-6'));
    const again = await clockAt();
    assert.deepEqual([again.id, lookup(again, early).day], ['starts-at-6', '2026-10-13']);
    summary.clockRestart = { reads };
  } finally {
    client.close();
    await new Promise(done => viewer.close(() => done(undefined)));
    standIn.closeAllConnections();
    standIn.close();
  }
});

test('K2: a clock read begun before a reset answers after it: an ask made before the reset is answered by the read since', async () => {
  /** @type {((message: any) => void)[]} */
  const listeners = [];
  /** @type {{ answer: (id: string) => void }[]} */
  const asked = [];
  const door = /** @type {any} */ ({
    follow: (/** @type {(message: any) => void} */ listener) => {
      listeners.push(listener);
      return () => undefined;
    },
    position: () => null,
    json: (/** @type {string} */ path) => {
      if (path !== '/v1/clock') return Promise.reject(new Error('Only the clock is served here.'));
      return new Promise(done => asked.push({ answer: id => done(clockFor('UTC', id === 'after' ? 6 : 4,
        { first: '2026-10-01', last: '2026-10-31', id })) }));
    },
  });
  const life = lifeReader(door);
  const hear = (/** @type {any} */ message) => listeners.forEach(listener => listener(message));
  hear({ kind: 'open', again: false });
  await until('the clock read as the feed opened', () => asked.length === 1);
  const before = life.clock();
  hear({ kind: 'reset', id: '9', data: { seq: 9, at_ms: 0 } });
  asked[0].answer('before');
  await until('one read more, for the ask and the reset said while the first ran', () => asked.length === 2);
  asked[1].answer('after');
  assert.equal((await before).id, 'after', 'the ask made before the reset is answered by the read since');
  assert.equal(life.clockNow()?.id, 'after');
  assert.equal(asked.length, 2, 'the ask and the reset read once more between them');
});

test('E3: an answer carries image bytes, or a card photo\'s hash serves other bytes', async () => {
  const people = await read('/api/life/people');
  const a = people.people.find(each => each.name === 'Person A');
  const jpeg = Buffer.from(home.jpeg, 'base64');
  const hash = `sha256:${createHash('sha256').update(jpeg).digest('hex')}`;
  assert.deepEqual(a.photo, { card: hash });
  assert.equal(JSON.stringify(people).includes('data:'), false);
  summary.card = { hash };
});

test('F2: tile, screen and full other than the door\'s /v1/pictures answer: its type, ETag and cache by recipe, a 304, a card photo, its refusals', async () => {
  const jpeg = Buffer.from(home.jpeg, 'base64');
  const hex = createHash('sha256').update(jpeg).digest('hex');
  const svg = (await photosMoment()).pictures[1].hash;
  /** @type {string[]} */
  const asked = [];
  const stand = createServer(async (request, response) => {
    const address = new URL(request.url ?? '', 'http://door');
    const authorization = String(request.headers.authorization ?? '');
    const asking = PICTURE_ROUTE.exec(address.pathname);
    if (asking) {
      asked.push(request.url ?? '');
      await answerPicture(asking[1], address, request, response, () => doorBytes(home.url, asking[1], authorization));
      return;
    }
    const passed = await fetch(`${home.url}${request.url}`, { headers: { authorization,
      ...(request.headers['last-event-id'] ? { 'last-event-id': String(request.headers['last-event-id']) } : {}) } }).catch(() => null);
    if (!passed?.body) return response.writeHead(passed?.status ?? 502).end();
    response.writeHead(passed.status, Object.fromEntries([...passed.headers]
      .filter(([name]) => !['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(name))));
    const stream = Readable.fromWeb(passed.body);
    response.on('close', () => stream.destroy());
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  });
  await new Promise(done => stand.listen(0, '127.0.0.1', done));
  const standDoor = openDoor({ url: `http://127.0.0.1:${stand.address().port}`, token: () => home.tokens.reader });
  const viewer = await createViewer({ door: standDoor });
  await new Promise(done => viewer.listen(0, '127.0.0.1', done));
  const at = `http://127.0.0.1:${viewer.address().port}`;
  const picture = (hash, size, headers = {}, recipe = String(RECIPE)) => fetch(`${at}/api/life/picture?${new URLSearchParams({
    hash, size, ...recipe ? { recipe } : {} })}`, { headers });
  try {
    for (const size of ['tile', 'screen', 'full']) {
      const answer = await picture(`sha256:${hex}`, size);
      assert.equal(answer.status, 200);
      assert.deepEqual([answer.headers.get('content-type'), answer.headers.get('etag'), answer.headers.get('cache-control')],
        ['image/jpeg', `"${hex}-${size}-${RECIPE}"`, 'private, max-age=86400']);
      assert.deepEqual(Buffer.from(await answer.arrayBuffer()), jpeg);
      const kept = await picture(`sha256:${hex}`, size, { 'if-none-match': `"${hex}-${size}-${RECIPE}"` });
      assert.equal(kept.status, 304);
      assert.equal(kept.headers.get('etag'), `"${hex}-${size}-${RECIPE}"`);
    }
    for (const recipe of ['1', '']) {
      const other = await picture(`sha256:${hex}`, 'tile', {}, recipe);
      assert.deepEqual([other.status, other.headers.get('cache-control')], [200, 'no-store']);
      await other.body?.cancel();
    }
    const people = await read('/api/life/people');
    const card = people.people.find(each => each.name === 'Person A').photo.card;
    assert.equal((await picture(card, 'tile')).status, 200);
    assert.equal((await picture(`sha256:${'0'.repeat(64)}`, 'tile')).status, 404);
    assert.equal((await picture(svg, 'tile')).status, 404);
    assert.equal((await picture(`sha256:${hex}`, 'thumb')).status, 400);
    const named = size => `/v1/pictures/sha256:h?size=${size}&recipe=${RECIPE}`;
    assert.deepEqual(asked.map(each => each.replace(/[0-9a-f]{64}/u, 'h')), [named('tile'), named('tile'), named('screen'),
      named('screen'), named('full'), named('full'), '/v1/pictures/sha256:h?size=tile&recipe=1', '/v1/pictures/sha256:h?size=tile',
      named('tile'), named('tile'), named('tile')]);
    summary.pictures = { asked: asked.length, bytes: jpeg.length };
  } finally {
    standDoor.close();
    await new Promise(done => viewer.close(done));
    stand.closeAllConnections();
    await new Promise(done => stand.close(done));
  }
});

test('F4: the films the sniff knows, as the home\'s does: a QuickTime movie with no ftyp, WhatsApp\'s mp4v, MP4, any ISO brand but a still\'s or a sound\'s', () => {
  const head = (/** @type {string} */ name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)).subarray(0, 16));
  assert.equal(mediaType(head('motion.mov')), 'video/quicktime');
  assert.equal(mediaType(head('video.mp4')), 'video/mp4');
  for (const atom of ['wide', 'mdat', 'moov']) {
    assert.equal(mediaType(new Uint8Array(Buffer.from(`\0\0\0\x08${atom}\0\0\0\0\0\0\0\0`, 'latin1'))), 'video/quicktime', atom);
  }
  assert.equal(mediaType(new Uint8Array(Buffer.from('\0\0\0\x18ftypmp4v\0\0\0\0', 'latin1'))), 'video/mp4');
  assert.equal(mediaType(new Uint8Array(Buffer.from('\0\0\0\x18ftypM4A \0\0\0\0', 'latin1'))), 'audio/mp4');
  const iso = (/** @type {string} */ brand) => mediaType(new Uint8Array(Buffer.from(`\0\0\0\x18ftyp${brand}\0\0\0\0`, 'latin1')));
  assert.deepEqual(['XAVC', 'heim', 'avis', 'M4P '].map(iso), ['video/mp4', 'image/heic', 'image/avif', 'audio/mp4']);
});

/** @param {any} report */
const streamsOf = report => report.connectors.filter(each => each.shown === 'stream');
/** @param {any} report */
const kindsOf = report => report.imports.map(each => `import:${each.kind}`);

test('C1: a streams report other than the home\'s report, a stream in no view or two', async () => {
  const { at_ms: _read, position: _relayed, ...report } = await read('/api/page/connectors');
  const { position: _position, at_ms: _at, ...connectors } = await fromDoor('/v1/connectors');
  connectors.disk = report.disk;
  assert.deepEqual(report, connectors);
  assert.ok(streamsOf(report).length > 0, 'the synthetic home declares streams');
  const whole = { ...report, at_ms: _read };
  const page = pageOf(whole, null, NONE);
  const faces = rowsOf(page).map((/** @type {any} */ face) => face.id).sort();
  const streams = streamsOf(report).filter(each => !standsInImport(report, each));
  const joined = streams.filter(each => each.joins && streams.find(other => other.joins?.name === each.joins.name) !== each);
  assert.deepEqual(faces.filter((/** @type {string} */ id) => !joined.some(each => each.id === id)).length,
    streams.length - joined.length + kindsOf(report).length);
  assert.ok(kindsOf(report).every(id => faces.includes(id)));
  assert.ok(kindsOf(report).length > 0, 'the home declares the import kinds it ships');
  for (const section of page.sections.filter((/** @type {any} */ each) => each.key !== 'needs')) {
    assert.ok(section.faces.every((/** @type {any} */ face) => face.type === section.key));
  }
  const homes = report.connectors.filter(each => each.shown === 'home').map(each => each.id);
  assert.ok(homes.includes('faces'), 'the synthetic home declares the face index');
  assert.deepEqual(page.side.map(row => row.id), [SETTINGS_HOME,
    ...report.devices.map(device => device.kind === 'mac' ? SETTINGS_MAC : `${SETTINGS_IPHONE}/${device.unit}`), SETTINGS_CHROME]);
  assert.deepEqual(needsOf(whole, null).map(face => face.id), report.needs.map(need => need.id));
  summary.connectors = { rows: faces, sections: page.sections.map(section => [section.key, section.faces.length]),
    side: page.side.map(row => row.id), needs: report.needs.map(need => need.words), paused: report.paused };
});

test('C2, C3: a state other than the home says, a dialog without what it records', async () => {
  const report = await fromDoor('/v1/connectors');
  for (const face of rowsOf(pageOf(report, null, NONE))) {
    if (face.id.startsWith('import:')) {
      const kind = report.imports.find(each => `import:${each.kind}` === face.id);
      assert.equal(face.state, kind.health.state, face.id);
      if (face.set_up) assert.equal(face.line, kind.line, face.id);
      continue;
    }
    const connector = report.connectors.find(each => each.id === face.id);
    const served = report.rows.find(each => each.ids.includes(face.id));
    assert.deepEqual([face.state, face.line], [served.health.state, rowLine(served, Date.now())], `${face.id}: the home's row as served`);
    if (served.ids.length === 1) assert.equal(served.health.state, connector.health.state, face.id);
    const detail = detailOf(report, null, face.id);
    if (!/ · Last added /u.test(detail.line)) {
      assert.equal(detail.line, connector.set_up ? [wholeLine(connector), connector.figure?.last ?? ''].filter(Boolean).join(' · ')
        : connector.gives, face.id);
    }
    const quiet = ['ok', 'syncing', 'setup'].includes(connector.health.state);
    const toConnect = detail.connect?.ways.some(way => way.rows.some(row => row.name === connector.health.words)) ?? false;
    assert.equal(detail.callout?.title ?? null, quiet || toConnect ? null : connector.health.words, face.id);
    const week = connector.figure?.week ?? [];
    const empty = connector.figure?.today === 0 && week.every(/** @param {number} count */ count => count === 0);
    const drawn = detailMarkup(detail, AT_REST);
    assert.equal(/ck-week__days/u.test(drawn), week.length > 0 && !empty, face.id);
    const dated = /class="ck-dialog__line[^>]*>[^<]*\blast\b/iu.test(drawn);
    assert.equal(/class="ck-none__text mac-subhead">No /u.test(drawn), week.length > 0 && empty && !dated, face.id);
    if (week.length > 0 && empty && dated) assert.ok(drawn.includes(`<p class="ck-dialog__line mac-subhead">${esc(detail.line)}</p>`), face.id);
    if (!connector.set_up) {
      assert.deepEqual(detail.panels, [], `${face.id} not set up: its steps alone`);
      continue;
    }
    const settings = detail.panels.find(panel => panel.label === 'Settings');
    for (const member of connector.members.filter(each => each.panel === 'settings')) {
      const row = settings?.rows.find(each => each.label === member.label);
      assert.equal(row?.go?.value ?? row?.end?.words, member.words, `${face.id} ${member.key}`);
    }
  }
  summary.states = Object.fromEntries(streamsOf(report).map(each => [each.id, [each.health.state, each.line]]));
});

test('C4: search that misses a stream by its type or a word of what it gives, keeps one that matches neither, or Where that keeps another place', async () => {
  const report = await read('/api/page/connectors');
  /** @param {object} filter */
  const ids = filter => rowsOf(pageOf(report, null, { ...NONE, ...filter })).map((/** @type {any} */ face) => face.id);
  const streams = streamsOf(report).filter(each => !each.joins && !standsInImport(report, each));
  for (const type of [...new Map(streams.map(each => [each.type.key, each.type])).values()]) {
    const found = ids({ query: type.name.toUpperCase() });
    for (const row of streams.filter(each => each.type.key === type.key)) assert.ok(found.includes(row.id), `${type.name}: ${row.id}`);
  }
  for (const place of ['mac', 'iphone', 'chrome', 'online', 'file']) {
    assert.ok(rowsOf(pageOf(report, null, { ...NONE, place })).every((/** @type {any} */ face) =>
      face.places.some((/** @type {any} */ each) => each.key === place)), place);
  }
  const worded = streams.find(each => /\b[a-z]{6,}\b/u.test(each.gives));
  const word = /\b[a-z]{6,}\b/u.exec(worded.gives)[0];
  assert.ok(ids({ query: word }).includes(worded.id), word);
  assert.equal(pageOf(report, null, { ...NONE, query: 'sleeep' }).empty, 'No connectors match.');
});

/** @param {string} name */
const contract = name => JSON.parse(readFileSync(new URL(`../../packages/home/test/contract/${name}.json`, import.meta.url), 'utf8'));

const STAND_IN_TAG = '"stand-in-answer"';

/** @param {Record<string, any>} answers */
async function searchDoor(answers) {
  /** @type {URL[]} */
  const asked = [];
  /** @type {(string | null)[]} */
  const validators = [];
  const stub = createServer((request, response) => {
    const at = new URL(request.url, 'http://door');
    const answer = answers[at.pathname];
    if (answer === undefined) {
      response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' });
      return response.end(JSON.stringify({ code: 'NOT_NOW', message: 'Lifestream is starting: it answers in a moment.' }));
    }
    asked.push(at);
    validators.push(request.headers['if-none-match'] ?? null);
    const refusal = typeof answer.status === 'number' ? answer : null;
    if (!refusal && request.headers['if-none-match'] === STAND_IN_TAG) return response.writeHead(304, { etag: STAND_IN_TAG }).end();
    response.writeHead(refusal?.status ?? 200, { 'content-type': 'application/json', ...(refusal ? {} : { etag: STAND_IN_TAG }),
      ...(refusal?.retry_after ? { 'retry-after': String(refusal.retry_after) } : {}) });
    response.end(JSON.stringify(refusal ? refusal.body : answer));
  });
  await new Promise(done => stub.listen(0, '127.0.0.1', done));
  const stubDoor = openDoor({ url: `http://127.0.0.1:${stub.address().port}`, token: () => 'stub-token' });
  const viewer = await createViewer({ door: stubDoor });
  await new Promise(done => viewer.listen(0, '127.0.0.1', done));
  return {
    asked,
    validators,
    at: `http://127.0.0.1:${viewer.address().port}`,
    close: async () => {
      stubDoor.close();
      await new Promise(done => viewer.close(done));
      stub.closeAllConnections();
      await new Promise(done => stub.close(done));
    },
  };
}

test('the connectors page relayed through the one page route: the door asked on the relay\'s kept ETag, and the page\'s own ETag answers 304 for the same body', async () => {
  const report = { position: '1:0', needs: [] };
  const door = await searchDoor({ '/v1/connectors': report });
  try {
    const first = await fetch(`${door.at}/api/page/connectors?unit=macbook-pro-0001`);
    assert.deepEqual(await first.json(), report);
    const etag = first.headers.get('etag');
    assert.ok(etag, 'the relayed page carries its validator');
    const again = await fetch(`${door.at}/api/page/connectors?unit=macbook-pro-0001`, { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304, 'the same answer asked on its ETag');
    assert.equal(again.headers.get('etag'), etag);
    const fresh = await fetch(`${door.at}/api/page/connectors?unit=macbook-pro-0001`, { headers: { 'If-None-Match': 'W/"another"' } });
    assert.deepEqual([fresh.status, await fresh.json()], [200, report], 'another validator gets the body');
    assert.deepEqual(door.validators, [null, STAND_IN_TAG, STAND_IN_TAG], 'the door asked on the ETag the relay kept');
  } finally {
    await door.close();
  }
});

test('S1: Find\'s one request reaches /v1/search as the page wrote it, each list its repeats; the door\'s answer and ETag come back as they were, and its 304 for the page\'s validator', async () => {
  const door = await searchDoor({ '/v1/search': contract('search') });
  try {
    const find = new URLSearchParams([['query', 'example'], ['lists', 'record'], ['lists', 'screen'], ['lists', 'goto'],
      ['families', 'mail'], ['from', '2026-11-01'], ['to', '2026-11-30']]);
    find.append('person', 'email:person-a@example.com');
    find.append('person', 'phone:+15550000001');
    const response = await fetch(`${door.at}/api/search?${find}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('etag'), STAND_IN_TAG);
    assert.deepEqual(await response.json(), contract('search'));
    assert.deepEqual([...door.asked[0].searchParams], [...find]);
    const again = await fetch(`${door.at}/api/search?${find}`, { headers: { 'if-none-match': STAND_IN_TAG } });
    assert.equal(again.status, 304);
    assert.equal(await again.text(), '');
    assert.deepEqual(door.validators, [null, STAND_IN_TAG]);
  } finally {
    await door.close();
  }
});

test('S4: a search page reaches its /v1/page route as the page wrote it, a kind\'s later page by its cursor alone; the door\'s answer kept and given again on its 304', async () => {
  const search = JSON.parse(readFileSync(new URL('../../homelink/Tests/Fixtures/pages/search.full.json', import.meta.url), 'utf8'));
  const door = await searchDoor({ '/v1/page/search': search, '/v1/page/search/kind': { position: search.position, rows: [] } });
  try {
    const first = new URLSearchParams([['query', 'example'], ['typing', '1'], ['from', '2026-11-01'], ['to', '2026-11-30']]);
    const response = await fetch(`${door.at}/api/page/search?${first}`);
    assert.deepEqual(await response.json(), search);
    const again = await fetch(`${door.at}/api/page/search?${first}`);
    assert.deepEqual(await again.json(), search, 'the answer kept and given again on the door\'s 304');
    const page = new URLSearchParams([['cursor', 'see.example']]);
    await fetch(`${door.at}/api/page/searchKind?${page}`);
    assert.deepEqual(door.asked.map(at => [at.pathname, [...at.searchParams]]),
      [['/v1/page/search', [...first]], ['/v1/page/search', [...first]], ['/v1/page/search/kind', [...page]]]);
    assert.deepEqual(door.validators, [null, STAND_IN_TAG, null]);
  } finally {
    await door.close();
  }
});

test('S2: a home whose index is not whole says so with its code, what is building and when to ask again; NOT_NOW stays its own, its paths cut', async () => {
  const building = contract('refusals').find(each => each.body.code === 'INDEX_BUILDING');
  const notNow = "Lifestream's folder is not there: Lifestream waits for /Volumes/Synthetic/Lifestream. If its drive shows under another name, eject it and plug it in again.";
  const shown = "Lifestream's folder is not there: Lifestream waits for … If its drive shows under another name, eject it and plug it in again.";
  for (const [answer, status, body, retry] of [
    [building, 503, { error: 'Search is getting ready.', code: 'INDEX_BUILDING', building: ['words'] }, String(building.retry_after)],
    [{ status: 503, body: { code: 'NOT_NOW', message: notNow } }, 503, { error: shown, code: 'NOT_NOW' }, null],
  ]) {
    const door = await searchDoor({ '/v1/search': answer });
    try {
      const response = await fetch(`${door.at}/api/search?q=example`);
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), body);
      assert.equal(response.headers.get('retry-after'), retry);
    } finally {
      await door.close();
    }
  }
});

test('S3: search\'s state and a person\'s count answer as the door does, asked with the page\'s parameters alone', async () => {
  const state = { record: { as_of: '2026-11-14T22:10+00:00', building: null },
    screen: { as_of: '2026-11-14T22:05+00:00', building: null, ...STATE_ON } };
  const door = await searchDoor({ '/v1/search/state': state, '/v1/count': contract('count') });
  try {
    assert.deepEqual(await (await fetch(`${door.at}/api/search/state`)).json(), state);
    const calls = new URLSearchParams({ of: 'calls', person: 'whatsapp:15550000001', from: '2026-10-16', to: '2026-11-14' });
    assert.deepEqual(await (await fetch(`${door.at}/api/count?${calls}`)).json(), contract('count'));
    assert.deepEqual(door.asked.map(at => [at.pathname, [...at.searchParams]]), [['/v1/search/state', []], ['/v1/count', [...calls]]]);
  } finally {
    await door.close();
  }
});

/**
 * @param {string} query
 * @param {number} limit
 */
const finding = (query, limit) => new URLSearchParams([['query', query], ['lists', 'record'], ['lists', 'screen'], ['lists', 'goto'],
  ['typing', '1'], ['order', 'newest'], ['limit', String(limit)]]);

test('J1: Find on the real door: one request answered as the door answers it and 304 for its ETag, newest first; a hit opens on a line of its day, Go to\'s person on their page, calls asked only of a home whose catalog counts them and a refusal told in the door\'s words, a person counted by a handle of theirs, a list goes on by its next', async () => {
  const authorization = `Bearer ${home.tokens.reader}`;
  /** @param {string} words */
  const find = async words => {
    const params = finding(words, 40);
    return until(`Find answered for "${words}" as the door answers it, its index whole and still`, async () => {
      const response = await fetch(`${url}/api/search?${params}`);
      const body = await response.json();
      if (response.status !== 200 || body.record?.pending?.length) return false;
      const etag = /** @type {string} */ (response.headers.get('etag'));
      const door = await fetch(`${home.url}/v1/search?${params}`, { headers: { authorization, 'if-none-match': etag } });
      return door.status === 304 && { params, etag, body };
    });
  };
  const said = await find('synthetic');
  assert.ok(said.body.record.hits.length > 0, JSON.stringify(said.body.record));
  assert.ok('goto' in said.body && 'screen' in said.body);
  const again = await fetch(`${url}/api/search?${said.params}`, { headers: { 'if-none-match': said.etag } });
  assert.equal(again.status, 304);
  const times = said.body.record.hits.flatMap((/** @type {any} */ hit) => hit.at ? [Date.parse(hit.at)] : []);
  assert.deepEqual(times, [...times].sort((one, other) => other - one));
  const [hit] = said.body.record.hits;
  const { described } = await read(`/api/life/describe?ref=${encodeURIComponent(hit.ref)}`);
  const opening = /** @type {{ on: string, focus: string }} */ (momentAt(described.find((/** @type {any} */ each) => each.ref === hit.ref)?.opens));
  assert.ok(opening.focus, JSON.stringify(described[0]));
  await momentOf(opening.on, opening.focus);
  const one = await read(`/api/search?${finding('synthetic', 1)}`);
  assert.ok(one.record.next, JSON.stringify(one.record));
  const more = await read(`/api/search?${new URLSearchParams({ cursor: one.record.next })}`);
  assert.equal(more.record.hits.length, 1);
  assert.notEqual(more.record.hits[0].ref, one.record.hits[0].ref);
  const named = await find('Person A');
  const [person] = named.body.goto.people;
  assert.equal(person?.name, 'Person A', JSON.stringify(named.body.goto));
  const goes = openingOf((await read(`/api/life/describe?ref=${encodeURIComponent(person.ref)}`)).described[0]);
  const personA = (await fromDoor('/v1/people')).people.find((/** @type {any} */ each) => each.name === 'Person A');
  assert.ok(goes && 'go' in goes && goes.go === 'people', JSON.stringify(goes));
  assert.ok([personA.id, ...personA.handles.map((/** @type {any} */ each) => each.id)].includes(goes.patch.focus), goes.patch.focus);
  const messages = new URLSearchParams({ of: 'messages', person: personA.handles[0].id, from: shiftDay(home.day, -29), to: home.day });
  const door = await fetch(`${home.url}/v1/count?${messages}`, { headers: { authorization } });
  const doorSaid = await door.json();
  assert.equal(door.status, 200, `${messages} ${JSON.stringify(doorSaid)}`);
  const counted = await read(`/api/count?${messages}`);
  assert.deepEqual(counted, doorSaid);
  assert.ok((counted.total?.n ?? counted.population.facts) >= 2, JSON.stringify(counted));
  summary.find = { hits: said.body.record.hits.length, opened: opening, goto: goes, messages: counted.total ?? counted.population };
});

test('a page answer: each People page relayed as the door answers it, the same answer once the door says 304, a page the contract lacks never asked', async () => {
  const people = await read('/api/page/people');
  assert.deepEqual(people, await fromDoor('/v1/page/people'));
  const row = people.sections.flatMap((/** @type {any} */ section) => section.rows).find((/** @type {any} */ each) => each.name === 'Person A');
  assert.ok(row, JSON.stringify(people.sections));
  const person = await read(`/api/page/person?${new URLSearchParams({ id: row.id })}`);
  assert.deepEqual(person, await fromDoor(`/v1/page/person?${new URLSearchParams({ id: row.id })}`));
  assert.equal(person.head.name, 'Person A');
  assert.deepEqual(await read('/api/page/people'), people, 'the answer kept and drawn again on the door\'s 304');
  assert.equal((await fetch(`${url}/api/page/nothing`)).status, 404);
  summary.pages = { people: people.sections.length, person: person.head.name };
});

test('a settings write moves the pages that move with streams, and the count\'s end moves Storage', () => {
  /** @param {string} kind */
  const heard = kind => homeChange([{ event: 'message', data: { kind, key: kind === 'settings' ? 'model.cap' : '' } }]);
  assert.deepEqual([heard('settings').streams, heard('settings').storage], [true, false]);
  assert.deepEqual([heard('stored').streams, heard('stored').storage], [false, true]);
});

test('a day the feed says changed, shown stale: a new message reaches the feed, the day, the page\'s change and People', async () => {
  const feed = listen();
  const late = Date.parse(`${home.day}T18:00:00Z`);
  try {
    await command('message', { key: '15550000001@s.whatsapp.net:A3', at: late, text: 'synthetic late message' });
    await until('the late message\'s day on the feed', async () => feed.heard.some(each => each.event === 'message' && each.data.kind === 'day' && each.data.key === home.day));
  } finally {
    await feed.stop();
  }
  const change = homeChange(feed.heard);
  assert.equal(change.records, true);
  const today = (await fromDoor('/v1/status')).day;
  assert.deepEqual([...change.days].filter(each => each !== today), [home.day]);
  const page = await dayPage(home.day);
  assert.deepEqual(page, await fromDoor(`/v1/page/day?${new URLSearchParams({ day: home.day })}`));
  const talk = (await Promise.all(dayRows(page).map(row => momentOf(home.day, row.key)))).find(each => each.name === 'Person A');
  const thread = await read(`/api/page/thread?${new URLSearchParams({ chat: talk.view.chat, day: home.day })}`);
  assert.equal(messagesOf(thread).find(message => message.at === late)?.words, 'synthetic late message');
  const person = await until('Person A\'s second message in People', async () => (await read('/api/life/people')).people
    .find(each => each.name === 'Person A' && each.received === 2));
  assert.equal(person.last_ms, late);
  summary.feed = { heard: feed.heard.map(each => [each.event, each.data.kind, each.data.key]), received: person.received };
});

test('a label change People never shows: a card naming an unknown sender reaches People once the labels family stores it', async () => {
  const sender = '15550000003@s.whatsapp.net';
  const before_ = await read('/api/life/people');
  assert.equal(before_.people.some(each => each.id === 'phone:+15550000003'), false);
  assert.deepEqual((await read(`/api/page/person?id=${encodeURIComponent(`jid:${sender}`)}`)).head.name, '+15550000003');
  const feed = listen();
  try {
    await command('contact', { key: 'c3', name: 'Person C', phone: '+15550000003' });
    await until('the labels on the feed', async () => feed.heard.some(each => each.event === 'message' && each.data.kind === 'extract' && each.data.key === 'labels'));
  } finally {
    await feed.stop();
  }
  const people = await until('Person C in People', async () => {
    const answer = await read('/api/life/people');
    return answer.people.some(each => each.name === 'Person C') ? answer : undefined;
  });
  const named = people.people.find(each => each.name === 'Person C');
  assert.deepEqual([named.id, named.by, named.handles.map((/** @type {any} */ { id, kind, network }) => ({ id, kind, network }))],
    ['phone:+15550000003', 'contact', [{ id: 'phone:+15550000003', kind: 'phone', network: null }]]);
  assert.deepEqual((await fromDoor(`/v1/labels?id=${encodeURIComponent(sender)}`)).names, [[sender, 'Person C', 'contact', null]]);
  summary.renamed = { before: '+15550000003', after: named.name, by: named.by };
});

test('a visitor with a bad token reads the home: the gate asks the door, and only a read principal passes', async () => {
  const lines = [];
  const gate = principalGate({ allows: door.allows, log: line => lines.push(line) });
  const away = (headers = {}, { path = '/api/life/days', method = 'GET', body = null } = {}) =>
    Object.assign(body === null ? Readable.from([]) : Readable.from([body]), { url: path, method, headers, socket: { localAddress: '100.64.0.1' } });
  const answered = async request => {
    const written = { status: 0, headers: {}, body: '' };
    const response = {
      setHeader: (name, value) => { written.headers[name] = value; },
      writeHead: (status, more = {}) => { written.status = status; Object.assign(written.headers, more); },
      end: (body = '') => { written.body = body; },
    };
    return (await gate(request, response)) ? written : null;
  };
  const bearer = token => ({ authorization: `Bearer ${token}` });
  assert.equal(await guardRequest({ socket: { localAddress: '127.0.0.1' }, headers: {} }, { allows: door.allows }), null);
  assert.equal(await answered(away(bearer(home.tokens.reader))), null);
  assert.equal(await answered(away({ cookie: `${COOKIE}=${home.tokens.reader}` })), null);
  assert.equal((await answered(away())).status, 401);
  assert.equal((await answered(away(bearer(home.tokens.device)))).status, 401);
  assert.equal((await answered(away(bearer('x'.repeat(43))))).status, 401);
  assert.equal((await answered(away({ accept: 'text/html' }, { path: '/' }))).headers.Location, '/login');
  const login = token => away({ 'content-type': 'application/x-www-form-urlencoded' }, { path: '/login', method: 'POST', body: `token=${token}` });
  const opened = await answered(login(home.tokens.reader));
  assert.equal(opened.status, 303);
  assert.match(opened.headers['Set-Cookie'], new RegExp(`^${COOKIE}=${home.tokens.reader}; HttpOnly`));
  assert.equal((await answered(login(home.tokens.device))).status, 401);
  for (const line of lines) assert.equal(line.includes(home.tokens.device) || line.includes(home.tokens.reader), false, line);
  assert.equal(lines.length, 5);
  const nowhere = openDoor({ url: 'http://127.0.0.1:9', token: () => home.tokens.reader });
  assert.equal((await guardRequest(away(bearer(home.tokens.reader)), { allows: nowhere.allows })).status, 503);
  nowhere.close();
  summary.gate = lines;
});

test('a dashboard that holds the home open: no file, socket or connection of the home in the dashboard\'s process', async () => {
  await read('/api/life/places');
  const open = execFileSync('lsof', ['-n', '-P', '-p', String(process.pid)], { encoding: 'utf8' }).split('\n');
  const doorPort = new URL(home.url).port;
  const viewerPort = new URL(url).port;
  assert.deepEqual(open.filter(line => line.includes(home.root)), []);
  assert.deepEqual(open.filter(line => /home\.(db|sock)|replies\.db/u.test(line)), []);
  const connections = open.flatMap(line => {
    const match = /TCP \S+?:(\d+)->\S+?:(\d+)/u.exec(line);
    return match ? [{ local: match[1], remote: match[2] }] : [];
  });
  assert.ok(connections.some(each => each.remote === doorPort));
  assert.deepEqual(connections.filter(each => each.local !== viewerPort && each.remote !== viewerPort && each.remote !== doorPort), []);
  summary.handles = { lines: open.length, connections };
});

test('W1, W2: where the person was shown other than the door says, a guess shown as known or a night no side reaches given a city', async () => {
  const asked = { from: home.day, to: home.day };
  const pieces = (await read(`/api/life/where?${new URLSearchParams(asked)}`)).pieces;
  assert.deepEqual(pieces, (await fromDoor(`/v1/where?${new URLSearchParams(asked)}`)).pieces);
  /** @param {any} piece */
  const named = piece => piece.names.point?.words ?? piece.names.point?.area.city ?? null;
  assert.deepEqual(pieces.filter(piece => piece.how === 'observed' && piece.kind === 'stay').map(named), ['Synthetic Home', 'Synthetic Office', 'Synthetic Home']);
  const range = (await read(`/api/life/where?${new URLSearchParams({ from: '2026-09-26', to: '2026-09-27' })}`)).pieces;
  assert.deepEqual(range.filter(piece => piece.how === 'seen').map(named), ['an unnamed place in Lisbon', 'an unnamed place in Lisbon']);
  assert.deepEqual(range.filter(piece => piece.how === 'bridged').map(piece => [piece.level, named(piece)]), [['city', 'Lisbon']]);
  const month = await read(`/api/life/where?${new URLSearchParams({ from: '2026-09-01', to: '2026-09-30', grain: 'day' })}`);
  assert.deepEqual(month.summaries, (await fromDoor('/v1/where?from=2026-09-01&to=2026-09-30&grain=day')).summaries);
  const nights = Object.fromEntries(month.summaries.map(summary => [summary.period, nightOf(summary)]));
  assert.deepEqual([nights['2026-09-25'], nights['2026-09-26'], nights['2026-09-27']],
    [{ name: 'Lisbon', guessed: true }, { name: 'Lisbon', guessed: false }, null]);
  const year = await read(`/api/life/where?${new URLSearchParams({ from: '2026-01-01', to: '2026-12-31', grain: 'month' })}`);
  const months = Array.from({ length: 12 }, (_, index) => `2026-${String(index + 1).padStart(2, '0')}`).filter(month => Date.parse(`${month}-01T00:00:00Z`) < year.to_ms);
  assert.deepEqual(year.summaries.map(summary => summary.period), months);
  summary.where = { day: pieces.map(piece => [piece.kind, piece.how, named(piece)]), nights };
});

async function act(action, expected = 200, headers = { 'x-viewer-request': '1' }, request = randomUUID()) {
  const response = await fetch(`${url}/api/owner/act`, {
    method: 'POST', body: JSON.stringify({ ...action, request }), headers: { 'content-type': 'application/json', ...headers },
  });
  const body = await response.json();
  assert.equal(response.status, expected, JSON.stringify(body));
  return body;
}

const word = (change, expected = 200, headers = undefined) => act({ of: 'devices', ...cameraAction(OWN_CAMERA, change) }, expected, headers);

const wordOn = async () => (await read('/api/life/devices')).cameras.find(camera => camera.camera === OWN_CAMERA).word;

const cameraWhen = (what, ready) => until(what, async () => {
  const camera = (await fromDoor('/v1/devices')).cameras.find(each => each.camera === OWN_CAMERA);
  return ready(camera) ? camera : undefined;
});

const seenOn26 = async () => (await read('/api/life/where?from=2026-09-26&to=2026-09-26')).pieces.some(piece => piece.how === 'seen');

test('D1, D2, D3: the cameras other than the door\'s, a sample that is no picture, a word that lands nowhere or is not taken back', async () => {
  const devices = await read('/api/life/devices');
  assert.deepEqual(devices.cameras, (await fromDoor('/v1/devices')).cameras);
  assert.equal(devices.source, DEVICES);
  assert.deepEqual(devices.cameras.map(camera => [camera.camera, camera.mine, whyWords(camera)]), [
    [OWN_CAMERA, true, '50 photos or more'], ['synthetic-make/stranger-camera', false, 'Fewer than 50 photos']]);
  const own = devices.cameras[0];
  await read(`/api/life/media?hash=${encodeURIComponent(own.sample)}`, 404);
  const svg = (await photosMoment()).pictures[1].hash;
  await read(`/api/life/media?hash=${encodeURIComponent(svg)}`, 404);
  await read(`/api/life/media?hash=sha256:${'0'.repeat(64)}`, 404);
  await read('/api/life/media?hash=..%2Fsecret', 400);
  assert.equal(await seenOn26(), true);
  await word({ mine: false }, 403, {});
  const refused = await word({ mine: false, from: '2026-13-01' }, 422);
  assert.equal(refused.code, 'STATEMENTS_BAD');
  const said = await word({ mine: false });
  assert.deepEqual([said.act, said.id], [null, `camera:${OWN_CAMERA}`]);
  assert.deepEqual(await wordOn(), { mine: false }, 'the word read on the next read');
  const marked = await cameraWhen('the camera not mine by the owner\'s word', camera => camera.why === 'owner');
  assert.deepEqual([marked.mine, marked.word], [false, { mine: false }]);
  await until('the 26th no longer placed by the camera\'s photos', async () => !(await seenOn26()));
  await word('count');
  assert.equal(await wordOn(), null, 'the word taken back on the next read');
  const counted = await cameraWhen('the camera mine by the count again', camera => camera.why === 'count');
  assert.deepEqual([counted.mine, counted.word], [true, null]);
  await until('the 26th placed by the camera\'s photos again', seenOn26);
  const history = await fromDoor(`/v1/record?${new URLSearchParams({ source: DEVICES, kind: 'camera', key: OWN_CAMERA, history: '1' })}`);
  assert.equal(history.history.length, 2);
  summary.devices = { cameras: devices.cameras.map(camera => [camera.camera, camera.why]), marked: marked.why, counted: counted.why };
});

async function edit(action, expected = 200) {
  const body = await act({ of: 'places', ...action }, expected);
  if (expected === 200) (summary.edits ??= []).push({ action, answer: body });
  return body;
}

async function editPlace(slug, fields, expected = 200) {
  const served = (await fromDoor('/v1/places')).places.find(each => each.slug === slug);
  const was = Object.fromEntries(Object.keys(fields).map(field => [field, served?.[field] ?? null]));
  return edit({ kind: 'edit', slug, ...fields, was }, expected);
}

const placesWhen = (what, ready) => until(what, async () => {
  const answer = await read('/api/life/places');
  return ready(answer) ? answer : undefined;
});

const physicalOf = async kind => (await fromDoor('/v1/extracts?family=physical&from_ms=0&to_ms=9999999999999&shown=1'))
  .extracts.filter(row => row.content.kind === kind).sort((a, b) => a.content.start_ms - b.content.start_ms);

const placedStays = async () => Promise.all((await physicalOf('stay')).map(row => read(`/api/life/placed?unit=${encodeURIComponent(row.unit)}`)));

const placedTrips = async () => Promise.all((await physicalOf('trip')).map(row => read(`/api/life/placed?unit=${encodeURIComponent(row.unit)}`)));

const placeRecord = slug => fromDoor(`/v1/record?${new URLSearchParams({ source: PLACES, kind: 'place', key: slug, history: '1' })}`);

async function heldAgainstDoor(places) {
  const served = await fromDoor('/v1/places');
  assert.deepEqual([places.places, places.spots], [served.places, served.spots]);
}

const office = { latitude: 0, longitude: 0.0135 };
let named;

test('P1: a removed place still listed, or still holding its stays: the office stated gone, its stays a spot worth naming', async () => {
  const feed = listen();
  try {
    assert.deepEqual((await edit({ kind: 'remove', slug: 'office' })).id, 'place:office');
    assert.equal((await read('/api/life/places')).places.some(place => place.slug === 'office'), false, 'gone on the next read');
    const places = await placesWhen('the office gone from the places', answer => !answer.places.some(place => place.slug === 'office')
      && answer.spots.some(spot => spot.worth));
    await heldAgainstDoor(places);
    assert.equal((await placeRecord('office')).version, null);
    const spot = places.spots.find(each => each.worth);
    assert.ok(spot && distanceMeters(spot, office) < 20, JSON.stringify(places.spots));
    assert.equal(spot.stays, 1);
    assert.ok((await placedStays()).every(stay => stay.place.slug !== 'office'));
    await until('the places event on the feed', async () => feed.heard.some(each => each.data.kind === 'places') || undefined);
    assert.equal(homeChange(feed.heard).places, true);
  } finally {
    await feed.stop();
  }
});

test('P2, P6: a spot named that lands nowhere, under another name or not on the next read: the next read answers the new place', async () => {
  const before = await read('/api/life/places');
  const spot = before.spots.find(each => each.worth);
  const latitude = Math.round((spot.latitude + 0.0002) * 1e6) / 1e6;
  const { longitude } = spot;
  const answer = await edit({ kind: 'create', name: '  Synthetic Office Two ', latitude, longitude, radius_m: 120, ids: [] });
  assert.match(answer.id, /^place:synthetic-office-two-[0-9a-f]{6}$/u);
  named = answer.id.slice('place:'.length);
  const next = await read('/api/life/places');
  assert.deepEqual([next.places.find(each => each.slug === named)?.name, next.spots.some(each => each.worth)],
    ['Synthetic Office Two', false], 'the place, and its spot gone, on the next read');
  assert.equal((await read(`/api/life/places?slug=${named}`)).place.name, 'Synthetic Office Two');
  const places = await placesWhen('a stay at the named place', found => found.places.some(each => each.slug === named
    && each.stays === 1 && !each.counting));
  await heldAgainstDoor(places);
  const place = places.places.find(each => each.slug === named);
  assert.deepEqual([place.name, place.latitude, place.longitude, place.radius_m, place.ids, place.stays],
    ['Synthetic Office Two', latitude, longitude, 120, [], 1]);
  assert.equal(places.spots.some(each => each.worth), false);
  const { place: whole } = await read(`/api/life/places?slug=${named}`);
  assert.equal(whole.visits.length, 1);
  const [visit] = whole.visits;
  assert.equal((await read(`/api/life/placed?unit=${encodeURIComponent(visit.unit)}`)).place.slug, named);
  assert.ok((await momentOf(visit.day, `u:${visit.unit}`)).source.units.some(unit => unit.unit === visit.unit));
  assert.deepEqual((await placeRecord(named)).version.content,
    { type: 'places.place', name: 'Synthetic Office Two', centre: { latitude, longitude }, radius_m: 120, ids: [] });
});

test('P3: two places that carry one provider id, shown without the clash or on one only: the clash shows on both', async () => {
  const ids = ['google:synthetic-place-c'];
  for (const slug of ['home', named]) assert.equal((await editPlace(slug, { ids })).id, `place:${slug}`);
  const places = await placesWhen('every place of one id, counted', found => !found.counting
    && found.places.every(place => place.ids.length === 1 && !place.counting));
  await heldAgainstDoor(places);
  const clashes = await Promise.all(['home', named].map(async slug => [slug, (await read(`/api/page/place?slug=${slug}`)).clashes]));
  assert.deepEqual(clashes, [
    ['home', [{ id: 'google:synthetic-place-c', names: ['Synthetic Office Two'] }]],
    [named, [{ id: 'google:synthetic-place-c', names: ['Synthetic Home'] }]],
  ]);
  const real = openDoor({ url: home.url, token: () => home.tokens.reader });
  try {
    const visit = { family: 'physical', unit: 'stay/timeline',
      content: { kind: 'stay', start_ms: 0, end_ms: 1, level: 'stated', centre: { latitude: 0.5, longitude: 0.5, id: 'google:synthetic-place-c' } } };
    const life = lifeReader({ ...real, json: async (path, params) => path === '/v1/extracts' ? { position: '0', extracts: [visit] }
      : real.json(path, params) });
    const { place } = await until('the visit placed by its id', async () => {
      const found = await life.placed('stay/timeline');
      return found.place?.slug ? found : undefined;
    });
    assert.deepEqual([place.slug, place.name], ['home', 'Synthetic Home']);
  } finally {
    real.close();
  }
});

test('P4: a rename, a move or a new radius that mints a new id or drops the provider ids: the place keeps both', async () => {
  const place = (await read('/api/life/places')).places.find(each => each.slug === named);
  const moved = { latitude: place.latitude, longitude: Math.round((place.longitude + 0.0002) * 1e6) / 1e6 };
  const answer = await editPlace(named, { name: 'Synthetic Office Renamed', ...moved, radius_m: 150 });
  assert.equal(answer.id, `place:${named}`);
  assert.equal((await read('/api/life/places')).places.find(each => each.slug === named).name, 'Synthetic Office Renamed',
    'renamed on the next read');
  const places = await placesWhen('the office renamed and counted', found => found.places.some(each => each.name === 'Synthetic Office Renamed'
    && !each.counting));
  await heldAgainstDoor(places);
  assert.deepEqual(places.places.map(each => each.slug).sort(), ['home', named].sort());
  const renamed = places.places.find(each => each.slug === named);
  assert.deepEqual((await placedTrips()).map(trip => [trip.from.slug, trip.to.slug]), [['home', named], [named, 'home']]);
  assert.deepEqual([renamed.latitude, renamed.longitude, renamed.radius_m, renamed.ids],
    [moved.latitude, moved.longitude, 150, ['google:synthetic-place-c']]);
  assert.equal((await placeRecord(named)).history.length, 3);
  summary.places_edited = places.places.map(({ slug, name, latitude, longitude, radius_m, ids }) =>
    ({ slug, name, latitude, longitude, radius_m, ids }));
});

test('P5: a refusal swallowed, shown as saved or landed anyway, or an edit the page did not send: the home\'s reason, nothing landed', async () => {
  const statements = (await placeRecord(named)).history.length;
  const refused = await editPlace(named, { radius_m: 5 }, 422);
  assert.equal(refused.code, 'STATEMENTS_BAD');
  assert.match(refused.error, /radius_m must be 20 to 2000/u);
  const bare = await fetch(`${url}/api/owner/act`, {
    method: 'POST', body: JSON.stringify({ of: 'places', kind: 'remove', slug: named, request: randomUUID() }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(bare.status, 403);
  assert.equal((await placeRecord(named)).history.length, statements);
  assert.equal((await fromDoor('/v1/places')).places.find(each => each.slug === named).radius_m, 150);
  summary.refused = refused.error;
});

test('P7: a rename, then a radius before the home counted either: each states only its own field, both stand on the next read', async () => {
  await editPlace(named, { name: 'Synthetic Office Three' });
  await editPlace(named, { radius_m: 200 });
  const place = (await read('/api/life/places')).places.find(each => each.slug === named);
  assert.deepEqual([place.name, place.radius_m], ['Synthetic Office Three', 200]);
  const { place: one } = await read(`/api/life/places?slug=${named}`);
  assert.deepEqual([one.name, one.radius_m], ['Synthetic Office Three', 200]);
});

test('P10: an edit from a read another edit has passed undoes it, or a field it did not send is refused for it: CHANGED states nothing', async () => {
  const statements = (await placeRecord(named)).history.length;
  const stale = await edit({ kind: 'edit', slug: named, name: 'Synthetic Office Stale', was: { name: 'Synthetic Office Two' } }, 409);
  assert.equal(stale.code, 'CHANGED');
  assert.equal((await placeRecord(named)).history.length, statements, 'nothing stated');
  assert.equal((await read('/api/life/places')).places.find(each => each.slug === named).name, 'Synthetic Office Three');
  await edit({ kind: 'edit', slug: named, radius_m: 210, was: { radius_m: 200 } });
  const content = (await placeRecord(named)).version.content;
  assert.deepEqual([content.name, content.radius_m], ['Synthetic Office Three', 210], 'a field not sent stands');
  await editPlace(named, { radius_m: 200 });
});

test('P8: an action sent again after a lost answer is a second place, the earlier of two edits standing, or a late edit reviving a removed place', async () => {
  const request = randomUUID();
  const change = { of: 'places', kind: 'create', name: 'Synthetic Kiosk', latitude: 0.004, longitude: 0.004, radius_m: 60, ids: [] };
  const first = await act(change, 200, undefined, request);
  assert.deepEqual(await act(change, 200, undefined, request), first, 'the kept answer');
  const slug = first.id.slice('place:'.length);
  assert.equal((await placeRecord(slug)).history.length, 1);
  assert.equal((await read('/api/life/places')).places.filter(each => each.name === 'Synthetic Kiosk').length, 1);
  await editPlace(slug, { radius_m: 90 });
  await editPlace(slug, { radius_m: 70 });
  assert.equal((await placeRecord(slug)).version.content.radius_m, 70, 'the later edit stands');
  await edit({ kind: 'remove', slug });
  const late = await edit({ kind: 'edit', slug, radius_m: 110, was: { radius_m: 70 } }, 404);
  assert.equal(late.code, 'PLACE_UNKNOWN');
  const record = await placeRecord(slug);
  assert.equal(record.version, null);
  summary.retried = { slug, statements: record.history.length };
});

test('P9: the list read again on anything but the places event, a 304 not the answer kept, or a failed read pinned', async () => {
  await command('settle');
  await placesWhen('the acts before counted, so the answer stands still', found => !found.counting
    && found.places.every(place => !place.counting));
  const real = openDoor({ url: home.url, token: () => home.tokens.reader });
  /** @type {(message: import('../lib/door.mjs').FeedMessage) => void} */
  let hear = () => undefined;
  const asks = [];
  let arrived = 0;
  let failing = false;
  /** @type {Promise<void> | null} */
  let gate = null;
  const door = {
    ...real,
    follow: listener => {
      hear = listener;
      return () => undefined;
    },
    text: async (path, etag, params) => {
      if (path !== '/v1/places' || params) return real.text(path, etag, params);
      arrived++;
      if (gate) await gate;
      if (failing) {
        asks.push('failed');
        throw new Error('Can\'t reach Lifestream.');
      }
      const read = await real.text(path, etag, params);
      asks.push(read.status);
      return read;
    },
  };
  let seq = 0;
  const event = (kind, key) => hear({ kind: 'event', id: String(++seq), data: { seq, at_ms: 0, kind, key, detail: null } });
  try {
    const life = lifeReader(door);
    hear({ kind: 'open' });
    const first = await life.places();
    await life.places();
    assert.deepEqual(asks, [200], 'unmoved: the answer kept');
    event('extract', 'labels');
    event('extract', 'physical');
    event('import', 'people:local:macbook-pro-0001/x');
    event('day', home.day);
    assert.equal(await life.places(), first);
    assert.deepEqual(asks, [200], 'only the places event or an import of the owner\'s places moves the list');
    event('import', `${PLACES}/x`);
    assert.equal(await life.places(), first);
    assert.deepEqual(asks, [200, 304], 'an edit from another device read on its import');
    event('places', 'places');
    assert.equal(await life.places(), first);
    assert.deepEqual(asks, [200, 304, 304]);
    event('places', 'places');
    failing = true;
    await assert.rejects(life.places());
    failing = false;
    await life.places();
    assert.deepEqual(asks, [200, 304, 304, 'failed', 304], 'the read after the failure asks again');
    /** @type {() => void} */
    let open = () => undefined;
    gate = new Promise(done => { open = done; });
    event('places', 'places');
    const reads = [life.places(), life.places()];
    event('places', 'places');
    reads.push(life.places());
    await until('the first read at the door', () => arrived === 6);
    assert.equal(arrived, 6, 'one read at a time');
    gate = null;
    open();
    await Promise.all(reads);
    assert.equal(asks.length, 7, 'the move heard during the read is read after it');
    await life.places();
    assert.equal(asks.length, 7, 'unmoved since: the answer kept');
  } finally {
    real.close();
  }
});

test('M1 M2 M3: a message drawn without what it carries, a reply without what it answers, a file served other than it is', async () => {
  const shipped = await command('media', { at: Date.parse(`${home.day}T08:10:00Z`) });
  const moments = await Promise.all(dayRows(await dayPage(home.day)).map(row => momentOf(home.day, row.key)));
  const talk = moments.find(each => each.kind === 'conversation' && each.source.records.some(record => record.key.endsWith(':M1')));
  assert.ok(talk, 'the photo and the voice note sit in the conversation with Person A');
  const chat = String(talk.view.chat);
  const messages = messagesOf(await read(`/api/page/thread?${new URLSearchParams({ chat, day: home.day })}`));
  const media = hash => `/api/life/media?hash=${encodeURIComponent(hash)}`;
  assert.deepEqual(messages.map(message => [message.speaker, message.mine, message.words]), [
    ['Person A', false, 'synthetic hello one'], ['the user', true, 'synthetic reply two'], ['Person A', false, ''], ['the user', true, ''],
    ['Person A', false, 'synthetic late message']]);
  const [, , photo, voice] = messages;
  assert.deepEqual(photo.pictures, [{ hash: shipped.photo, alt: shipped.caption }]);
  assert.equal(photo.missing, undefined);
  assert.deepEqual(voice.voice, { audio: shipped.voice, seconds: 14, words: shipped.transcript });
  assert.deepEqual(voice.quote, { speaker: 'Person A', words: 'synthetic hello one' });
  await read(media(photo.pictures[0].hash), 404);
  const ogg = Buffer.from(shipped.ogg, 'base64');
  const sound = await fetch(`${url}${media(voice.voice.audio)}`, { headers: { range: 'bytes=4-' } });
  assert.deepEqual([sound.status, sound.headers.get('content-type'), sound.headers.get('content-range')],
    [206, 'audio/ogg', `bytes 4-${ogg.length - 1}/${ogg.length}`]);
  assert.deepEqual(Buffer.from(await sound.arrayBuffer()), ogg.subarray(4));
  summary.thread = messages.map(message => ({ speaker: message.speaker, mine: message.mine, words: message.words,
    pictures: message.pictures?.length ?? 0, voice: message.voice ?? null, quote: message.quote ?? null }));
});
