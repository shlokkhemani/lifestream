// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  askAnswer, askFound, askLevel, askPick, askQuestion, askStarters, askSteps, askTurn, composer, composerAttach, closed, findRow, icon, setIcons, thoughtFor,
} from '../public/ui/kit/index.js';
import { Marked } from 'marked';

setIcons(JSON.parse(readFileSync(new URL('../../design/icons.json', import.meta.url), 'utf8')));

/** @param {string} markup */
const buttons = markup => [...markup.matchAll(/<button([^>]*)>/gu)].map(([, attrs]) => ({
  class: /class="([^"]*)"/u.exec(attrs)?.[1] ?? '', label: /aria-label="([^"]*)"/u.exec(attrs)?.[1] ?? '',
  disabled: /\sdisabled(?=[\s>=]|$)/u.test(attrs),
}));

test('P1: the composer draws the tools passed, the send circle last, dim until there are words, Stop while an answer runs', () => {
  const bare = buttons(composer());
  assert.deepEqual(bare.map(each => each.label), ['Send']);
  assert.equal(bare[0].disabled, true);
  assert.equal(buttons(composer({ value: 'Where?' }))[0].disabled, false);
  assert.deepEqual(buttons(composer({ state: 'running' })).map(each => each.label), ['Stop']);
  const full = composer({ attach: composerAttach(), pick: askPick(PICK), mic: { 'data-mic': '' } });
  assert.deepEqual(buttons(full).map(each => each.label), ['Add a photo or file', 'Model and thinking: Opus, Medium', 'Record a voice note', 'Send']);
  assert.ok(full.indexOf('<textarea') < full.indexOf('ck-composer__tools'));
  const recording = composer({ attach: composerAttach(), pick: askPick(PICK), recording: { seconds: 67, levels: [0.2, 1, 0.5, 0.1, 0.6], stop: {} } });
  assert.match(recording, /class="ck-composer is-recording"/u);
  assert.doesNotMatch(recording, /<textarea/u);
  assert.match(recording, /ck-composer__blank/u);
  assert.deepEqual(buttons(recording).map(each => [each.label, each.disabled]), [['Stop recording', false], ['Send', false]]);
  assert.match(recording, />1:07</u);
  assert.deepEqual([...recording.matchAll(/<i[^>]*data-level="(\d+)"/gu)].map(match => match[1]), ['2', '10', '5', '1', '6']);
  assert.doesNotMatch(recording, /style=/u);
});

const PICK = {
  model: 'Opus', level: 'Medium', thinking: 'medium',
  levels: [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }],
  menu: { default: null, rows: [{ value: 'claude/opus', name: 'Opus', account: 'Claude', chosen: true }, { value: 'openrouter/opus', name: 'Opus', account: 'OpenRouter', chosen: false }],
    local: { label: 'Local', rows: [{ value: 'runner/qwen', name: 'Qwen 3.5', account: null, chosen: false }] }, more: { words: 'More', use: /** @type {const} */ ('chat'), work: null }, off: null },
  chosen: 'claude/opus',
};
const FIND = { placeholder: 'Search', none: '', found: [{ label: 'OpenRouter', rows: [{ value: 'openrouter:vendor-b/model-1', name: 'Model One', account: null, chosen: false }] }] };

/** @param {string} markup */
const rows = markup => [...markup.matchAll(/<(div|span)([^>]*class="(ck-flist__item|ck-flist__head)[^"]*"[^>]*)>(.*?)(?=<(?:div|span)[^>]*class="ck-flist__(?:item|head)|<hr|<\/div><\/div>$)/gu)]
  .map(([, , attrs, kind, inner]) => ({
    kind: kind === 'ck-flist__head' ? 'head' : 'item', value: /data-value="([^"]*)"/u.exec(attrs)?.[1] ?? '',
    words: (/<span class="ck-flist__label">([^<]*)</u.exec(inner)?.[1] ?? inner.replace(/<[^>]*>/gu, '')).trim(),
    page: /data-ck-page-of="([^"]*)"/u.exec(attrs)?.[1], shown: !/\shidden/u.test(attrs),
    checked: /aria-checked="true"/u.test(attrs), note: /class="ck-flist__note[^"]*">([^<]*)</u.exec(inner)?.[1] ?? '',
    tag: /class="ck-flist__tag[^"]*">([^<]*)</u.exec(inner)?.[1] ?? '',
    off: /aria-disabled="true"/u.test(attrs),
  }));

test('P2: the pick chip says the model and its level; its menu is Thinking, then Model › as a page of its own, Reset while not the default; each model is its name, its account only beside a name held twice, local ones under Local', () => {
  const markup = askPick({ ...PICK, reset: true });
  assert.match(markup, /<span class="ck-pick__words">Opus · Medium<\/span>/u);
  const all = rows(markup);
  const first = all.filter(row => row.shown);
  assert.deepEqual(first.map(row => [row.kind, row.words, row.value, row.checked]), [
    ['head', 'Thinking', '', false], ['item', 'Low', 'thinking:low', false], ['item', 'Medium', 'thinking:medium', true],
    ['item', 'High', 'thinking:high', false], ['item', 'Model', 'models', false], ['item', 'Reset to default', 'reset', false],
  ]);
  assert.match(markup, /<div [^>]*class="ck-flist__item mac-body ck-fmenu__item ck-flist__more"[^>]*data-ck-page="models"|<div [^>]*data-ck-page="models"[^>]*class="ck-flist__item mac-body ck-fmenu__item ck-flist__more"/u);
  const models = all.filter(row => row.page === 'models');
  assert.ok(models.every(row => !row.shown), 'a model shown on the first page');
  assert.deepEqual(models.map(row => [row.kind, row.words, row.value, row.checked, row.note, row.tag]), [
    ['item', 'Opus', 'model:claude/opus', true, '', 'Claude'], ['item', 'Opus', 'model:openrouter/opus', false, '', 'OpenRouter'],
    ['head', 'Local', '', false, '', ''], ['item', 'Qwen 3.5', 'model:runner/qwen', false, '', ''],
  ]);
  assert.doesNotMatch(askPick(PICK), /Reset to default/u);
  const one = rows(askPick({ ...PICK, page: 'models', active: 7 }));
  assert.deepEqual(one.filter(row => row.shown).map(row => row.words), ['Opus', 'Opus', 'Local', 'Qwen 3.5']);
});

test('P2b: More ends Model ›, a page of its own: a field in the home\'s words, then the models the home found, each picked as a menu row is; none found, the home\'s line', () => {
  const markup = askPick({ ...PICK, find: FIND });
  const all = rows(markup);
  const last = all.filter(row => row.page === 'models').at(-1);
  assert.deepEqual([last?.words, last?.value], ['More', 'other']);
  assert.match(markup, /data-value="other"[^>]*data-ck-page="other"|data-ck-page="other"[^>]*data-value="other"/u);
  assert.match(markup, /<label class="ck-find ck-pick__find"><span class="ck-find__glass"[^>]*>[^]*?<input[^>]*class="ck-find__field mac-body"[^>]*placeholder="Search"/u,
    'Settings\' More\'s search field: the magnifier, then the field');
  assert.match(findRow({ placeholder: 'Search' }), /<label class="ck-find"><span class="ck-find__glass"/u, 'one component');
  assert.deepEqual(all.filter(row => row.page === 'other').map(row => [row.words, row.value, row.shown]), [['OpenRouter', '', false], ['Model One', 'model:openrouter:vendor-b/model-1', false]]);
  const opened = rows(askPick({ ...PICK, find: FIND, page: 'other', active: 0 }));
  assert.deepEqual(opened.filter(row => row.page === 'other').map(row => row.shown), [true, true]);
  assert.doesNotMatch(askPick(PICK), /data-value="other"/u);
  assert.match(askFound([], '', 'No matches'), /<p[^>]*data-ck-page-of="other"[^>]*>No matches<\/p>/u);
});

test('P8: the level chip is the pick chip\'s shape, its glyph and its words; its menu Sensitive information over the three levels, the kept one checked; dimmed while an answer runs', () => {
  const markup = askLevel({ level: 'names' });
  const chip = buttons(markup)[0];
  assert.equal(chip.class, buttons(askPick(PICK))[0].class);
  assert.deepEqual([chip.label, chip.disabled], ['Sensitive information: Keep names', false]);
  assert.match(markup, /^<div [^>]*class="ck-fmenu ck-fmenu--start ck-level ck-fmenu--float"/u);
  assert.match(markup, /<span class="ck-pick__words">Keep names<\/span>/u);
  assert.match(markup, /class="ck-flist ck-fmenu__panel" role="menu"/u);
  for (const [level, glyph] of /** @type {const} */ ([['all', 'hidden'], ['names', 'person'], ['none', 'visible']])) {
    const face = /<button[^>]*>(.*?)<\/button>/u.exec(askLevel({ level }))?.[1] ?? '';
    assert.ok(face.startsWith(icon(glyph, { size: 'sm' })), `${level}: not drawn with ${glyph}`);
  }
  assert.deepEqual(rows(markup).map(row => [row.kind, row.words, row.value, row.checked]), [
    ['head', 'Sensitive information', '', false], ['item', 'Hide all', 'all', false], ['item', 'Keep names', 'names', true],
    ['item', 'Don’t hide', 'none', false],
  ]);
  const items = [...markup.matchAll(/<div [^>]*class="ck-flist__item[^"]*"[^>]*>(.*?)<\/div>/gu)].map(match => match[1]);
  assert.deepEqual(items.map(item => [(item.match(/<svg/gu) ?? []).length, item.endsWith('</svg></span>')]), [[0, false], [1, true], [0, false]]);
  assert.equal(buttons(askLevel({ level: 'all', waiting: true }))[0].disabled, true);
});

test('P3: the + menu is Photos…, Files… ⌘O and Paste ⌘V, each picking its own word', () => {
  const markup = composerAttach();
  assert.deepEqual(rows(markup).map(row => [row.value, row.words]), [['photos', 'Photos…'], ['files', 'Files…'], ['paste', 'Paste']]);
  assert.deepEqual([...markup.matchAll(/ck-flist__tag[^>]*>([^<]*)</gu)].map(match => match[1]), ['⌘O', '⌘V']);
  assert.match(markup, /aria-label="Add a photo or file"/u);
});

test('P4: a picture picked waits with its ×; one asked stands over its bubble; a voice note is its player, then its words', () => {
  const picture = { src: 'data:image/png;base64,AA==', alt: 'Hills at sunset' };
  const picked = composer({ value: 'Where did I take this?', pictures: [picture], remove: at => ({ 'data-unpick': String(at) }) });
  assert.match(picked, /<img src="data:image\/png;base64,AA==" alt="Hills at sunset">/u);
  assert.match(picked, /aria-label="Remove Hills at sunset" data-unpick="0"/u);
  assert.ok(picked.indexOf('ck-composer__pictures') < picked.indexOf('<textarea'));
  const asked = askQuestion('Where did I take this?', { picture });
  assert.ok(asked.indexOf('ck-ask-q__picture') < asked.indexOf('ck-ask-q__words'));
  const writing = askQuestion('', { voice: { seconds: 7, levels: [0.4, 0.8], words: null } });
  assert.match(writing, /<span class="sr-only">Play the voice note, 0:07<\/span>/u);
  assert.match(writing, />0:07</u);
  assert.match(writing, /Writing it out…/u);
  assert.doesNotMatch(writing, /ck-ask-q__words/u);
  const said = askQuestion('', { voice: { seconds: 7, levels: [0.4, 0.8], words: 'How long was I at the gym?' } });
  assert.match(said, /<p class="ck-ask-voice__words">How long was I at the gym\?<\/p>/u);
  assert.doesNotMatch(said, /Writing it out/u);
});

test('P5: the work line shimmers while it works and opens nothing; done it says how long it thought, and opened each step in the home’s words, a failure as the home says what it couldn’t do, no time, no model', () => {
  const steps = [{ words: 'Searched messages for “dinner”' }, { words: 'Couldn’t open example.com', failed: true }, { words: 'Read Fri 16 Oct' }];
  const working = askSteps({ said: 'Searching messages for “dinner”', working: true, steps: steps.slice(0, 1), attrs: { 'data-ask-steps': '0' } });
  assert.match(working, /^<div class="ck-steps is-running" role="status"><button type="button" class="ck-steps__line mac-subhead" disabled data-ask-steps="0">/u);
  assert.match(working, /<span class="ck-steps__roll" data-ck-roll><span class="ck-steps__words ck-shimmer">Searching messages for “dinner”<\/span><\/span><\/button><\/div>$/u);
  assert.doesNotMatch(working, /ck-steps__caret|ck-steps__open|…|ck-ask-mark/u);
  const shut = askSteps({ said: thoughtFor(9_000), steps });
  assert.match(shut, /<button type="button" class="ck-steps__line mac-subhead" aria-expanded="false">/u);
  assert.match(shut, /<span class="ck-steps__words">Thought for 9s<\/span><\/span><svg[^>]*ck-steps__caret/u);
  assert.match(shut, /<div class="ck-steps__open" aria-hidden="true" inert><div><ol class="ck-steps__list">/u, 'the steps are drawn shut, to open in place');
  const open = askSteps({ said: thoughtFor(9_000), steps, open: true });
  assert.match(open, /^<div class="ck-steps is-open">/u);
  assert.match(open, /<div class="ck-steps__open"><div>/u);
  assert.deepEqual(open.split('<li ').slice(1).map(item => [item.includes('is-failed'), /<span>([^<]*)<\/span><\/li>/u.exec(item)?.[1]]),
    [[false, 'Searched messages for “dinner”'], [true, 'Couldn’t open example.com'], [false, 'Read Fri 16 Oct']]);
  assert.doesNotMatch(open, /\d\.\ds|Opus|ck-steps__ms|ck-steps__by/u);
  const answering = askSteps({ said: thoughtFor(9_000), live: true, steps });
  assert.match(answering, /class="ck-steps__line mac-subhead" disabled>.*ck-steps__caret/u, 'while the answer still comes the line keeps its chevron but opens nothing');
  assert.doesNotMatch(answering, /ck-steps__open|ck-shimmer/u);
  const alone = askSteps({ said: thoughtFor(800), steps: [] });
  assert.match(alone, /class="ck-steps__line mac-subhead" disabled>/u, 'a turn with no steps still says how long it thought, and opens nothing');
  assert.match(alone, />Thought for 0\.8s</u);
  assert.equal(askSteps({ said: '', steps }), '');
});

test('P5: the answer while it paces: each word its own, as every answer draws them, a bold drawn bold from its first word, a citation whole, the copy row held in its place', () => {
  const marked = new Marked({ gfm: true, breaks: true });
  const draw = { markdown: (/** @type {string} */ text) => /** @type {string} */ (marked.parse(text)), year: '2026' };
  const paced = askAnswer({ text: closed('Dinner is on **Saturday'), refs: null, paced: true }, draw);
  assert.match(paced, /^<div class="ck-answer is-pacing">/u);
  assert.match(paced, /<p><span class="ck-answer__w">Dinner<\/span> <span class="ck-answer__w">is<\/span> <span class="ck-answer__w">on<\/span> <strong><span class="ck-answer__w">Saturday<\/span><\/strong><\/p>/u);
  assert.match(paced, /<div class="ck-copy ck-answer__foot is-held" aria-hidden="true" inert><button class="ck-copy__btn ck-answer__copy" type="button" aria-label="Copy answer" title="Copy">/u);
  const cited = askAnswer({ text: 'At 20:00 [r1].', refs: null, paced: true }, draw);
  assert.match(cited, /<span class="ck-answer__w">20:00<\/span> <span class="ck-answer__glued"><span class="ck-cite mac-footnote" aria-hidden="true">1<\/span><span class="ck-answer__w">\.<\/span><\/span>/u);
  const listed = askAnswer({ text: closed('Two:\n- one'), refs: null, paced: true }, draw);
  assert.match(listed, /<ul>\s*<li><span class="ck-answer__w">one<\/span><\/li>/u, 'a list item is a list from its first word');
  const kept = askAnswer({ text: 'Dinner is on **Saturday**.', refs: {} }, draw);
  assert.match(kept, /^<div class="ck-answer"><div class="ck-answer__words mac-reading"><p><span class="ck-answer__w">Dinner<\/span>/u,
    'a kept answer draws its words as the paced one did, so a line never breaks differently once the answer ends');
  assert.doesNotMatch(kept, /is-pacing|is-held/u);
  assert.match(kept, /<div class="ck-copy ck-answer__foot"><button[^>]*data-ck-answer-copy="Dinner is on \*\*Saturday\*\*\."/u);
});

test('P6, P7: each starter its kind’s icon and its question; a kind not known no icon; the time only over a turn given one', () => {
  const markup = askStarters([{ kind: 'places', question: 'Where have I been today?' }, { kind: 'nothing', question: 'A question' }],
    at => ({ 'data-ask-starter': String(at) }));
  const each = [...markup.matchAll(/<button([^>]*)>(.*?)<\/button>/gu)];
  assert.deepEqual(each.map(([, attrs]) => /data-ask-starter="(\d)"/u.exec(attrs)?.[1]), ['0', '1']);
  assert.deepEqual(each.map(([, , inner]) => /<span class="ck-ask-starter__words">([^<]*)</u.exec(inner)?.[1]), ['Where have I been today?', 'A question']);
  assert.deepEqual(each.map(([, , inner]) => /<svg/u.test(inner)), [true, false]);
  assert.equal(askStarters([]), '');
  assert.doesNotMatch(askTurn({ question: '<div></div>' }), /ck-ask-stamp/u);
  assert.match(askTurn({ question: '<div></div>', stamp: 'Today 08:29' }), /^<section class="ck-ask-turn"><p class="ck-ask-stamp mac-mono-time">Today 08:29<\/p>/u);
});

test('P9: what the model saw through markdown: each span marked in the raw text becomes a detail where it shows, a link target draws nothing, an autolink one detail, Copy holds no marker, the capsule reads as written and its pictures fold', () => {
  const marked = new Marked({ gfm: true, breaks: true, renderer: { link({ href, tokens }) {
    const words = this.parser.parseInline(tokens);
    return /^https?:\/\//u.test(href) ? `<a href="${href}">${words}</a>` : words;
  } } });
  const draw = { markdown: (/** @type {string} */ text) => /** @type {string} */ (marked.parse(text)), year: '2026' };
  const refs = { r1: { day: '2026-10-16', title: 'Photo at Synthetic Cafe', image: 'photo-1' } };
  const text = 'Maya Iyer said so [r1].\n\n'
    + 'It was **Maya** with [Dev](https://example.com/dev); write to [her](mailto:maya@example.com).\n\n'
    + 'Named `Maya` in code:\n\n```\nhello Maya\n```\n\n- Maya\n- Dev\n\n'
    + '| Who | When |\n|---|---|\n| Maya | Mon |\n\n\n\nMaya came, from Dev Kumar <dev.kumar@example.com>.\n\nSources: [r1]';
  /** @type {[string, string][]} */
  const found = [['Maya Iyer', '[[Person 1]]'], ['Maya', '[[person 1]]'], ['Dev', '[[Person 2]]'], ['maya@example.com', '[[Email 1]]'],
    ['Maya', '[[Person 1]]'], ['Maya', '[[Person 1]]'], ['Maya', '[[Person 1]]'], ['Dev', '[[Person 2]]'], ['Maya', '[[Person 1]]'],
    ['Maya', '[[Person 1]]'], ['Dev Kumar', '[[Person 2]]'], ['dev.kumar', '[[Email 2]]']];
  let from = 0;
  const seen = found.map(([words, placeholder]) => {
    const start = text.indexOf(words, from);
    from = start + words.length;
    return { start, end: from, placeholder };
  });
  const plain = askAnswer({ text, refs }, draw);
  const shown = askAnswer({ text, refs, seen }, draw);
  const turned = askAnswer({ text, refs, seen, model: true }, draw);
  /** @param {string} html */
  const words = html => html.replace(/<div class="ck-copy[\s\S]*$/u, '').replace(/<span class="ck-seen__said[\s\S]*?(?=<span class="ck-seen__run")/gu, '')
    .replace(/<[^>]*>/gu, '');
  /** @param {string} html */
  const eyeless = html => html.replace(/<button type="button" class="ck-seen-eye[\s\S]*?<\/button>/u, '');
  assert.equal(words(shown), words(plain), 'the person\'s view reads as the answer does with no record');
  assert.match(shown, /<button[^>]*class="ck-seen-eye"[^>]*aria-label="What the model saw" aria-pressed="false" title="Show what the model saw"/u);
  assert.doesNotMatch(plain, /ck-seen/u);
  const said = [...shown.matchAll(/class="ck-seen ck-seen--(\w+)[^"]*" data-said="([^"]*)"/gu)].map(([, kind, each]) => `${kind} ${each}`);
  assert.deepEqual(said, ['held [[Person 1]]', 'cite [r1]', 'held [[person 1]]', 'held [[Person 2]]', 'held [[Person 1]]', 'held [[Person 1]]',
    'held [[Person 1]]', 'held [[Person 2]]', 'held [[Person 1]]', 'held [[Person 1]]', 'held [[Person 2]]', 'held &lt;[[Email 2]]@example.com&gt;'],
  'every span but the link target\'s, in order, the placeholder as written, the autolink one detail');
  const detail = '<span class="ck-seen ck-seen--held" data-said="[^"]*"><span class="ck-seen__words">(?:<span class="ck-answer__w">)?';
  assert.match(shown, new RegExp(`<code>${detail}Maya`, 'u'), 'a code span');
  assert.match(shown, new RegExp(`<pre><code><span class="ck-answer__w">hello</span> ${detail}Maya`, 'u'), 'a fenced block');
  assert.match(shown, new RegExp(`<li>${detail}Maya`, 'u'), 'a list item');
  assert.match(shown, new RegExp(`<td>${detail}Maya`, 'u'), 'a table cell');
  assert.match(shown, new RegExp(`<strong>${detail}Maya`, 'u'), 'bold');
  assert.match(shown, new RegExp(`<a href="https://example\\.com/dev">${detail}Dev`, 'u'), 'link text');
  assert.match(shown, new RegExp(`<p>${detail}Maya</span></span>`, 'u'), 'after a double blank line');
  assert.match(shown, new RegExp(`${detail}dev\\.kumar@example\\.com`, 'u'), 'the autolink drawn as the address');
  assert.match(words(shown), /write to her\./u, 'a link target is not shown in either view');
  assert.doesNotMatch(shown, /[]|%EE%84%8/u);
  const copy = /data-ck-answer-copy="([^"]*)"/u.exec(shown)?.[1] ?? '';
  assert.match(copy, /^Maya Iyer said so\./u);
  assert.doesNotMatch(copy, /[]/u);
  assert.match(shown, /<div class="ck-seen-fold"><div class="ck-seen-fold__in"><div class="ck-pics is-one">/u);
  assert.match(turned, /aria-pressed="true"/u);
  assert.equal(eyeless(turned), eyeless(shown), 'the model view is the turn\'s: the answer draws the same, but for its eye');
  assert.match(shown, /<span class="ck-seen ck-seen--cite" data-said="\[r1\]"><span class="ck-seen__words"><(?:button|span)[^>]*class="ck-cite[^"]*"[^<]*<\/(?:button|span)><\/span><span class="ck-seen__said"><\/span>/u,
    'a citation keeps the app\'s citation mark in the model view, the model\'s handle only in what it said');
  assert.match(askTurn({ question: '', answer: turned, model: true }), /^<section class="ck-ask-turn is-model">/u);
  const flanked = 'Call a**+1 555 0100** now.';
  const start = flanked.indexOf('+1');
  const beside = askAnswer({ text: flanked, refs: {}, seen: [{ start, end: start + 11, placeholder: '[[Phone 1]]' }] }, draw);
  assert.equal(beside, askAnswer({ text: flanked, refs: {} }, draw), 'a marker that would change the formatting draws no eye and the answer as written');
  assert.match(askAnswer({ text: 'I can’t call for you.', refs: {}, seen: [] }, draw), /ck-seen-eye/u, 'a record with no answer spans still has its eye');
  assert.match(askAnswer({ text: '[r1]', refs, seen: [] }, draw), /<div class="ck-copy ck-answer__foot"><button type="button" class="ck-seen-eye"/u,
    'an answer with nothing to copy still has its eye');
});

test('P10: a voice note cited is its own bar under its paragraph, after the paragraph’s pictures, in cited order, past two with no cap, each with its number; never merged', () => {
  const marked = new Marked({ gfm: true, breaks: true });
  const draw = { markdown: (/** @type {string} */ text) => /** @type {string} */ (marked.parse(text)), year: '2026', owner: 'answer:c1',
    cite: (/** @type {string} */ handle, /** @type {number} */ n) => ({ 'data-cite': `${handle} ${n}` }) };
  /** @param {string} audio @param {string} caption */
  const said = (audio, caption) => ({ day: '2026-11-04', title: 'Person A',
    voice: { record: `record.${audio.slice(7)}`, audio, seconds: 23, caption, mine: false, failed: 'This voice note didn’t play.' } });
  const refs = { r1: said('sha256:1', 'Person A · Wed 4 Nov, 21:40'), r2: said('sha256:2', 'Person A · Wed 4 Nov, 21:41'),
    r3: said('sha256:3', 'Person A · Wed 4 Nov, 21:42'), r4: { day: '2026-11-04', title: 'Photo', image: 'photo-1' } };
  const answer = askAnswer({ text: 'Said three times [r2, r1, r3], with a photo [r4].\n\nThe end.', refs }, draw);
  assert.deepEqual([...answer.matchAll(/data-voice="([^"]*)"/gu)].map(([, audio]) => audio), ['sha256:2', 'sha256:1', 'sha256:3']);
  assert.deepEqual([...answer.matchAll(/class="ck-voice-cite__caption mac-subhead" data-cite="(r\d) (\d)"/gu)].map(([, handle, n]) => `${handle} ${n}`),
    ['r2 1', 'r1 2', 'r3 3']);
  assert.ok(answer.indexOf('ck-pics') < answer.indexOf('ck-voice-cite'), 'the bars before the paragraph’s pictures');
  assert.ok(answer.lastIndexOf('ck-voice-cite') < answer.indexOf('The end.'), 'a bar under the next paragraph');
  assert.match(answer, /data-voice-owner="answer:c1"/u);
  const gone = askAnswer({ text: 'Said [r1].', refs: { r1: { day: '2026-11-04', title: 'Person A',
    voice: { record: 'record.1', audio: '', seconds: null, caption: '', mine: false, failed: '', erased: true } } } }, draw);
  assert.match(gone, /<p class="ck-voice-cite__gone mac-subhead">This voice note was erased\.<\/p>/u);
  assert.doesNotMatch(gone, /data-voice=/u);
  const unanswered = askAnswer({ text: 'Said [r1].', refs: { r1: { ...refs.r1, voice: { ...refs.r1.voice, failed: 'The home didn’t answer.' } } } }, draw);
  assert.match(unanswered, /The home didn’t answer\.<\/span><button type="button" class="ck-in-place__act mac-headline" data-voice-play>Try again<\/button>/u);
  const twice = askAnswer({ text: 'Said it [r1, r5].\n\nAnd again [r5].', refs: { ...refs, r5: { ...refs.r1, title: 'Person A, the line' } } }, draw);
  assert.deepEqual([...twice.matchAll(/data-voice="([^"]*)"/gu)].map(([, audio]) => audio), ['sha256:1'], 'one note cited twice drew two bars');
  assert.deepEqual([...twice.matchAll(/class="ck-cite mac-footnote[^"]*"[^>]*>(\d)</gu)].map(([, n]) => n), ['1', '2', '2'],
    'a second citation of the note lost its own number');
  const question = askQuestion('', { voice: { seconds: 7, levels: [0.4], words: '', sound: 'own:s1', owner: 'answer:c1', src: 'blob:local-note' } });
  assert.match(question, /class="ck-ask-voice" data-voice="own:s1" data-voice-owner="answer:c1" data-voice-seconds="7" data-voice-src="blob:local-note"/u);
  assert.match(question, /data-voice-play><span class="ck-voice-face" data-voice-face="play">/u);
  assert.match(question, /data-voice-time><span>0:07<\/span>/u);
  assert.match(question, /This voice note didn’t play\./u);
  assert.doesNotMatch(askQuestion('', { voice: { seconds: 7, levels: [0.4], words: null } }), /\sdata-voice=|didn’t play/u,
    'a note not yet sent drawn as a bar that plays');
});
