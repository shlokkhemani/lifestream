// @ts-check
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, request as forward } from 'node:http';
import { askReady } from './stand-ins/ask-ready.mjs';
import { pageHarness } from './stand-ins/page-harness.mjs';

const JOURNEY = /** @type {{ lines: any[], conversation: { chat: string, title: string, messages: any[] } }} */ (
  JSON.parse(readFileSync(new URL('../../homelink/Tests/Fixtures/ask-voice-cite.json', import.meta.url), 'utf8')));
const CHAT = JOURNEY.conversation.chat;
const ANSWER = JOURNEY.conversation.messages.find(message => message.role === 'assistant');
const CITED = [...String(ANSWER.text).matchAll(/\[(r\d+)\]/gu)].map(([, handle]) => ANSWER.refs[handle]);

process.env.LIFESTREAM_MCP = 'http://127.0.0.1:9';
process.env.LIFESTREAM_MCP_MEDIA = '1';
process.env.LIFESTREAM_MCP_VOICE = '1';

const seen = { shots: /** @type {string[]} */ ([]), waiting: '', drew: /** @type {Record<string, unknown>} */ ({}),
  played: /** @type {string[]} */ ([]) };

/** @param {{ url: string }} home */
async function journeyFront(home) {
  const door = new URL(home.url);
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '', door).pathname;
    /** @param {unknown} body */
    const send = body => void response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (path === '/v1/ask') {
      return send({ ...askReady([{ id: 'faux-1', name: 'Faux', thinking: ['high'], default: 'high', group: 'OpenRouter', input: ['text'] }]),
        voice: { ready: false, words: 'Parakeet · this Mac', line: null, caution: null, value: 'default', choices: [] } });
    }
    if (path === '/v1/ask/chats') return send({ chats: [{ chat: CHAT, title: JOURNEY.conversation.title, first_ms: 1, last_ms: 2, messages: 2 }] });
    if (path === `/v1/ask/chats/${CHAT}`) return send(JOURNEY.conversation);
    if (path.startsWith('/v1/ask')) return void response.writeHead(204).end();
    const passed = forward(new URL(request.url ?? '', door), { method: request.method, headers: { ...request.headers, host: door.host } }, answer => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    });
    passed.on('error', () => response.destroy());
    request.pipe(passed);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  return {
    url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`,
    async close() {
      server.closeAllConnections();
      await new Promise(done => server.close(() => done(undefined)));
    },
  };
}

const page = pageHarness({ file: 'voice-door', seen, script: '../../../mcp/test/home.ts', size: { width: 1200, height: 800 }, zone: 'America/New_York',
  front: journeyFront });
/** @type {Awaited<ReturnType<typeof page.journey>> | undefined} */
let opened;
const chrome = () => /** @type {NonNullable<typeof opened>} */ (opened).chrome;

/** @param {string} selector */
const press = async selector => {
  const [x, y] = await chrome().evaluate(`(() => { const found = document.querySelectorAll(${JSON.stringify(selector)});
    if (found.length !== 1) throw new Error(${JSON.stringify(selector)} + ' names ' + found.length);
    const box = found[0].getBoundingClientRect(); return [box.left + box.width / 2, box.top + box.height / 2]; })()`);
  await chrome().send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await chrome().send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await chrome().send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
};

before(async () => {
  const { chrome: browser } = await page.open();
  browser.on('Network.responseReceived', ({ response }) => {
    const url = new URL(response.url);
    if (url.pathname === '/api/life/media') seen.played.push(`${response.status} ${url.searchParams.get('hash')}`);
  });
});

after(() => page.close());

describe('voice-door', () => {
  before(async () => {
    opened = await page.journey('voice-door');
    await chrome().send('Network.enable');
  });

  test('V1: the journey\'s kept answer over the home that holds its notes draws two bars, each with its length and caption; a tap loads each from the home and plays it, and the media route answers its bytes', async () => {
    assert.equal(CITED.length, 2, ANSWER.text);
    const [heard, own] = CITED.map(cited => cited.voice);
    await chrome().load(`#view=ask&chat=${CHAT}`);
    await chrome().until(`document.querySelectorAll('.ck-answer .ck-voice-cite[data-voice]').length === 2`);
    const bars = await chrome().evaluate(`[...document.querySelectorAll('.ck-answer .ck-voice-cite')].map(each => ({
      sound: each.dataset.voice, time: each.querySelector('[data-voice-time]').textContent,
      caption: each.querySelector('.ck-voice-cite__caption').textContent.replace(/\\s+/gu, ' ').trim() }))`);
    seen.drew.bars = bars;
    assert.deepEqual(bars.map((/** @type {any} */ bar) => [bar.sound, bar.time]), [[heard.audio, '0:03'], [own.audio, '0:03']]);
    assert.ok(bars[0].caption.startsWith(`${heard.from} · `) && bars[0].caption.endsWith(', 19:00'), bars[0].caption);
    assert.ok(bars[1].caption.startsWith('You · ') && bars[1].caption.endsWith(', 19:20'), bars[1].caption);
    await page.shot('bars', `document.querySelectorAll('.ck-answer .ck-voice-cite').length === 2`);

    for (const sound of [heard.audio, own.audio]) {
      const bar = `.ck-answer [data-voice="${sound}"]`;
      await press(`${bar} .ck-audio__play`);
      await chrome().until(`['playing', 'failed'].includes(document.querySelector('${bar}').dataset.voiceState)`);
      assert.equal(await chrome().evaluate(`document.querySelector('${bar}').dataset.voiceState`), 'playing', `${sound} loaded from the home and played`);
      const served = await chrome().evaluate(`fetch('/api/life/media?hash=' + encodeURIComponent('${sound}')).then(answer => answer.arrayBuffer())
        .then(bytes => crypto.subtle.digest('SHA-256', bytes)).then(digest => 'sha256:' + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''))`);
      assert.equal(served, sound, 'the media route answers the note\'s bytes as the home keeps them');
    }
    assert.ok([heard.audio, own.audio].every(sound => seen.played.some(each => /^20[06] /u.test(each) && each.endsWith(sound))), JSON.stringify(seen.played));
    await page.shot('playing', `document.querySelector('.ck-answer [data-voice="${own.audio}"]').dataset.voiceState === 'playing'`);
  });
});
