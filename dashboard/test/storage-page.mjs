import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sizeWords } from '../public/lib/words.js';
import { pageHarness } from './stand-ins/page-harness.mjs';

/** @typedef {Record<string, { source: string, text: number, files: number }>} Recount */

const seen = { shots: /** @type {string[]} */ ([]), waiting: '', read: /** @type {unknown} */ (null) };
const page = pageHarness({ file: 'storage-page', seen, size: { width: 1280, height: 900 }, args: ['storage'],
  front: async home => ({ url: home.url, close: async () => undefined }) });
/** @type {Awaited<ReturnType<typeof page.open>>} */
let opened;

before(async () => {
  opened = await page.open();
});
after(() => page.close());

const storageRead = () => opened.chrome.evaluate(`(window.ownFetch ?? fetch)('api/page/storage').then(answer => answer.json())`);
const COUNTED = `(() => {
  const reads = window.storageReads = { asked: 0, answered: 0 };
  const own = window.ownFetch = window.fetch;
  window.fetch = (...args) => {
    if (!String(args[0]).startsWith('api/page/storage')) return own(...args);
    reads.asked += 1;
    return own(...args).finally(() => { reads.answered += 1; });
  };
  return true;
})()`;
const settled = () => opened.chrome.evaluate('window.storageReads.answered === window.storageReads.asked && window.storageReads.asked');
/** @param {string} id */
const rowSize = id => page.words(`.ck-urow[data-part="${id}"] .ck-urow__size`);

describe('storage-page', () => {
  before(async () => {
    opened = await page.journey('storage-page');
  });

  test('J1–J6: counting drawn, the count ends, each stream its recount, a row opens its stream, an import read on the feed', async () => {
    const { chrome } = opened;
    const recount = /** @type {Recount} */ (/** @type {{ storage?: Recount }} */ (opened.home).storage);
    assert.deepEqual(Object.keys(recount ?? {}).sort(), ['gmail', 'google-photos', 'whatsapp']);
    await chrome.load('#dialog=settings%2Fstorage', '');
    await chrome.until(`document.querySelector('.cn-storage__figure')?.textContent.startsWith('Counting…')
      && document.querySelector('.ck-disk__key')?.textContent.includes('Not yet counted')`, 'the counting page drawn');
    const counting = await storageRead();
    assert.equal(counting.counted, false, 'the home counts');
    assert.equal(await page.count('.cn-storage .ck-area'), 0, 'no chart while counting');
    await page.shot('counting', `document.querySelector('.cn-storage__figure')?.textContent.startsWith('Counting…')`);

    const bar = await chrome.evaluate(`(() => { const box = document.querySelector('.ck-disk__bar').getBoundingClientRect();
      return [box.left + 1, box.top + box.height / 2]; })()`);
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bar[0], y: bar[1] });
    await chrome.until(`document.querySelector('.cn-storage.is-dimmed .ck-disk__part.is-lit')
      && document.querySelector('.cn-storage .ck-disk__name.is-lit')`, 'the first part lit in the bar and the key');

    await page.command('count');
    await chrome.until(`document.querySelector('.cn-storage__figure') && !document.querySelector('.cn-storage__figure').textContent.startsWith('Counting…')
      && document.querySelector('.cn-storage .ck-area')`, 'the counted page drawn, read again while it counted');
    assert.ok(await chrome.evaluate(`Boolean(document.querySelector('.cn-storage.is-dimmed .ck-disk__part.is-lit'))`),
      'a part still lit under the still pointer, the page drawn anew');
    await chrome.hover('');
    await chrome.until(`!document.querySelector('.cn-storage.is-dimmed')`, 'the pointer gone, nothing lit');
    const read = await storageRead();
    seen.read = read;
    assert.equal(read.counted, true);
    for (const [connector, truth] of Object.entries(recount)) {
      const use = read.uses.find((/** @type {{ id: string }} */ each) => each.id === connector);
      const words = sizeWords(truth.text + truth.files).replace(/\s/gu, ' ');
      assert.equal(use?.size.replace(/\s/gu, ' '), words, `${connector}: its text and files`);
      assert.equal((await rowSize(connector)).replace(/\s/gu, ' '), words, `${connector}'s row`);
    }
    await page.shot('counted', `document.querySelector('.cn-storage .ck-area') && !document.querySelector('.ck-disk__key')?.textContent.includes('Not yet counted')`);

    await chrome.evaluate(COUNTED);
    const before = await chrome.evaluate('history.length');
    await page.click('.ck-urow[data-part="whatsapp"] .ck-urow__hit');
    await chrome.until(`location.hash.includes('dialog=whatsapp') && document.querySelector('.ck-dialog:not(.cn-set)')`, 'WhatsApp\'s dialog open');
    assert.equal(await chrome.evaluate('history.length'), before + 1, 'a new history entry');
    await chrome.evaluate('history.back()');
    await chrome.until(`decodeURIComponent(location.hash).includes('dialog=settings/storage') && document.querySelector('.cn-storage .ck-area')
      && window.storageReads.asked > 0 && window.storageReads.answered === window.storageReads.asked`,
    'Back returns to Storage, read once as it comes');

    const asked = await settled();
    assert.ok(asked, 'Storage read as it came back');
    const whatsapp = (/** @type {{ uses: { id: string, share: number, size: string }[] }} */ answer) => answer.uses
      .find(each => each.id === 'whatsapp') ?? { share: 0, size: '' };
    const held = whatsapp(read);
    await page.command('message', { key: '15550000001@s.whatsapp.net:S1', at: Date.now(), text: `synthetic ${'words '.repeat(8000)}` });
    await chrome.until(`window.storageReads.asked > ${asked}`, 'Storage read on the feed\'s word that the home stored a message');
    const now = await storageRead();
    const onDisk = (/** @type {{ bar: { parts: { id: string, share: number }[] } }} */ answer) => answer.bar.parts.find(each => each.id === 'whatsapp')?.share ?? 0;
    assert.ok(onDisk(now) > onDisk(read), 'the message counted into WhatsApp');
    const words = whatsapp(now).size.replace(/\s/gu, ' ');
    await chrome.until(`document.querySelector('.ck-urow[data-part="whatsapp"] .ck-urow__size')?.textContent.replace(/\\s/gu, ' ') === ${JSON.stringify(words)}`,
      'WhatsApp\'s row at what it holds now');
  });
});
